import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ClaudeRuntimeSettingsError,
  createRuntimeSettings
} from "./claude-runtime-settings.mjs";
import {
  PROCESS_IDENTITY_MATCH,
  PROCESS_IDENTITY_STATUS,
  compareProcessIdentity,
  inspectProcessIdentity,
  validateDurableProcessIdentity
} from "./process-identity.mjs";

const STDERR_SUMMARY_BYTES = 16 * 1024;
// A bounded proof-of-death grace used only once the absolute profile deadline
// has elapsed (or for an earlier interruption's remaining profile budget).
export const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;
export const MAX_CLAUDE_TIMEOUT_MS = 2_147_483_647;

export class ClaudeRunnerError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ClaudeRunnerError";
    this.code = options.code || "claude_runner_failed";
    this.stderrSummary = options.stderrSummary || "";
    this.stdoutSummary = options.stdoutSummary || "";
    this.durationMs = options.durationMs;
    this.pid = options.pid;
    this.processIdentity = options.processIdentity;
    this.terminalProof = options.terminalProof;
    this.terminationResult = options.terminationResult;
    this.processStarted = options.processStarted;
    // Cleanup is housekeeping evidence, not a replacement for the process
    // outcome that caused it. Keeping both lets custody consume a close proof
    // even when removing temporary settings later fails.
    this.processOutcome = options.processOutcome;
    this.cleanupFailure = options.cleanupFailure;
  }
}

export class ClaudeTimeoutError extends ClaudeRunnerError {
  constructor(timeoutMs, options = {}) {
    super(
      "Claude timed out after " + Math.round(timeoutMs / 1000) + " seconds.",
      { ...options, code: "claude_timeout" }
    );
    this.name = "ClaudeTimeoutError";
  }
}

export class ClaudeOutputCaptureOverflowError extends ClaudeRunnerError {
  constructor(maxCaptureBytes, options = {}) {
    super(
      "Claude output exceeded the configured capture limit of " + maxCaptureBytes + " bytes.",
      { ...options, code: "claude_output_capture_overflow" }
    );
    this.name = "ClaudeOutputCaptureOverflowError";
  }
}

export class ClaudeExitError extends ClaudeRunnerError {
  constructor(exitCode, signal, options = {}) {
    const diagnostics = [
      "Claude exited with code " + String(exitCode) + (signal ? " signal=" + signal : "") + ".",
      options.stderrSummary ? "stderr:\n" + options.stderrSummary : "",
      options.stdoutSummary ? "stdout:\n" + options.stdoutSummary : ""
    ]
      .filter(Boolean)
      .join("\n");
    super(diagnostics, { ...options, code: "claude_non_zero_exit" });
    this.name = "ClaudeExitError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/**
 * The child may have received a forced-termination request, but no close/exit
 * event proved that this exact ChildProcess instance became terminal. Callers
 * must retain write custody when this error is associated with a writer.
 */
export class ClaudeTerminationUnprovenError extends ClaudeRunnerError {
  constructor(originalError, terminationResult, options = {}) {
    super(
      "Claude child termination could not be proven; write custody must remain retained.",
      {
        ...options,
        code: "claude_termination_unproven",
        cause: originalError,
        stderrSummary: originalError?.stderrSummary || "",
        stdoutSummary: originalError?.stdoutSummary || "",
        terminationResult,
        processStarted: true
      }
    );
    this.name = "ClaudeTerminationUnprovenError";
    this.originalErrorCode = originalError?.code || "claude_runner_failed";
    this.timeoutOccurred =
      originalError instanceof ClaudeTimeoutError || originalError?.code === "claude_timeout";
  }
}

function summarizeBuffer(buffer, streamName) {
  if (buffer.length <= STDERR_SUMMARY_BYTES) {
    return buffer.toString("utf8").trim();
  }

  return (
    buffer.subarray(0, STDERR_SUMMARY_BYTES).toString("utf8").trim() +
    "\n[" + streamName + " summary truncated]"
  );
}

function requireRuntimeSetting(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaudeRunnerError("Claude runtime " + name + " must be a non-empty string.", {
      code: "invalid_runtime_policy"
    });
  }
}

function validateRuntimePolicy(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new ClaudeRunnerError("Claude runtime policy is required.", {
      code: "invalid_runtime_policy"
    });
  }
  requireRuntimeSetting("claudeBin", runtime.claudeBin);
  requireRuntimeSetting("model", runtime.model);
  requireRuntimeSetting("reasoningEffort", runtime.reasoningEffort);
  requireRuntimeSetting("permissionMode", runtime.permissionMode);
  if (!Array.isArray(runtime.toolNames) || runtime.toolNames.length === 0) {
    throw new ClaudeRunnerError("Claude runtime must contain a non-empty tool list.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!Array.isArray(runtime.disallowedTools) || !runtime.disallowedTools.includes("mcp__*")) {
    throw new ClaudeRunnerError("Claude runtime must deny external MCP tools.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!["none", "git-readonly", "task", "worker"].includes(runtime.shellPolicy)) {
    throw new ClaudeRunnerError("Claude runtime shell policy is invalid.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!runtime.childEnvironment || typeof runtime.childEnvironment !== "object") {
    throw new ClaudeRunnerError("Claude runtime child environment is required.", {
      code: "invalid_runtime_policy"
    });
  }
}

function buildClaudeArgs(runtime, settingsPath) {
  requireRuntimeSetting("settings path", settingsPath);
  return [
    "-p",
    "--input-format",
    "text",
    "--model",
    runtime.model,
    "--effort",
    runtime.reasoningEffort,
    "--permission-mode",
    runtime.permissionMode,
    "--tools",
    runtime.toolNames.join(","),
    "--disallowed-tools",
    runtime.disallowedTools.join(","),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    settingsPath,
    "--restricted",
    "--no-session-persistence",
    "--no-chrome",
    "--output-format",
    "text"
  ];
}

export function getClaudeRunnerArgs(runtime, settingsPath = "<runtime-settings>") {
  return [...buildClaudeArgs(runtime, settingsPath)];
}

function runtimeTimeoutIsValid(timeoutMs) {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= MAX_CLAUDE_TIMEOUT_MS
  );
}

function childIsAlreadyTerminal(child) {
  return Boolean(
    child &&
    ((child.exitCode !== undefined && child.exitCode !== null) ||
      (child.signalCode !== undefined && child.signalCode !== null))
  );
}

/**
 * Binds one Claude child to the repository that granted its write custody.
 *
 * repositoryRoot is always the coordinated repository root, never the isolated
 * workspace root a general-purpose worker runs in. Durable ownership is held
 * per repository, so the identity must name the repository to match its
 * reservation.
 */
function createProcessIdentityCandidate({ child, executionId, agentType, repositoryRoot, now }) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return undefined;
  return {
    executionId,
    agentType,
    repositoryRoot,
    pid: child.pid,
    child,
    startedAt: now()
  };
}

function finalizeProcessIdentity(candidate, processObservation, terminalObserver) {
  if (!candidate) return undefined;
  // The independent PID query can race a very short-lived child. Once the
  // exact ChildProcess has reported exit or close, a later PID observation may
  // already describe a reused PID, so it must never become durable ownership.
  if (
    terminalObserver?.getExitObservation?.() ||
    terminalObserver?.getTerminalProof?.()
  ) return undefined;
  if (processObservation?.status !== PROCESS_IDENTITY_STATUS.ALIVE) return undefined;
  let durableIdentity;
  try {
    durableIdentity = validateDurableProcessIdentity(processObservation.identity);
  } catch {
    return undefined;
  }
  if (durableIdentity.pid !== candidate.pid) return undefined;
  candidate.startTime = durableIdentity.startTime;
  candidate.source = durableIdentity.source;
  return Object.freeze(candidate);
}

/**
 * Observes the exact ChildProcess instance created for one invocation.
 *
 * Only `close` is terminal proof for write custody. Node distinguishes the two
 * events: `exit` means the direct child ended while its stdio may still be
 * open, which happens precisely when a descendant still holds the inherited
 * pipes; `close` means the child ended and its stdio streams closed. Returning
 * write custody on `exit` alone would hand the repository to a new writer while
 * a descendant of the old one can still be writing, so `exit` is retained as a
 * diagnostic observation and never resolves the terminal promise.
 *
 * Honest scope: `close` proves the lifecycle of the exact supervised child and
 * its stdio, not that every detached descendant is dead. A transitive
 * guarantee needs process-tree containment (Job Objects), which Phase 5.1
 * deliberately does not add.
 */
export function observeClaudeChildTerminal(child, processIdentity, { now = Date.now } = {}) {
  let closeProof;
  let exitObservation;
  let errorObservation;
  let resolveTerminal;
  let resolveExit;
  let resolveError;
  const terminalPromise = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const errorPromise = new Promise((resolve) => {
    resolveError = resolve;
  });

  const observe = (event, code, signal) => {
    const observation = Object.freeze({
      processIdentity,
      event,
      code,
      signal,
      observedAt: now()
    });
    if (event === "exit") {
      // Diagnostic only. Never custody proof.
      if (!exitObservation) {
        exitObservation = observation;
        resolveExit(observation);
      }
      return;
    }
    if (closeProof) return;
    closeProof = observation;
    resolveTerminal(observation);
  };

  // This listener must be installed with exit/close immediately after spawn.
  // It converts an asynchronous ENOENT-style spawn failure into controlled
  // lifecycle evidence instead of an unhandled EventEmitter error.
  child?.once?.("error", (error) => {
    if (errorObservation) return;
    errorObservation = Object.freeze({
      processIdentity,
      event: "error",
      error,
      observedAt: now()
    });
    resolveError(errorObservation);
  });
  child?.once?.("close", (code, signal) => observe("close", code, signal));
  child?.once?.("exit", (code, signal) => observe("exit", code, signal));
  if (childIsAlreadyTerminal(child)) {
    observe("exit", child.exitCode, child.signalCode);
  }

  return Object.freeze({
    processIdentity,
    getTerminalProof: () => closeProof,
    getCloseProof: () => closeProof,
    getExitObservation: () => exitObservation,
    getErrorObservation: () => errorObservation,
    terminalPromise,
    exitPromise,
    errorPromise
  });
}

/**
 * Terminal evidence for a child this coordinator spawned and watched close,
 * but whose durable PID+StartTime identity could not be captured because it
 * died first. It carries no processIdentity, so it can never be mistaken for
 * durable cross-process proof; only the live coordinator that supervised the
 * spawn may act on it.
 */
function supervisedCloseProof(closeProof) {
  if (!closeProof || closeProof.event !== "close") return undefined;
  return Object.freeze({
    event: "close",
    code: closeProof.code,
    signal: closeProof.signal,
    observedAt: closeProof.observedAt,
    supervisedByCoordinator: true
  });
}

/**
 * Waits for identity-bound terminal evidence, or for the bounded deadline.
 *
 * The deadline timer is deliberately left referenced. This wait decides whether
 * write custody is released or retained as ORPHANED, so the runtime must stay
 * alive until the decision resolves. An unref'd timer here lets Node drain the
 * event loop while the custody decision is still pending, which leaves the
 * lifecycle Promise permanently unsettled.
 */
function remainingMs(deadlineAt, now) {
  return Math.max(0, deadlineAt - now());
}

function waitForTerminalProof(
  terminalObserver,
  {
    timeoutMs,
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  }
) {
  const alreadyTerminal = terminalObserver?.getTerminalProof?.();
  if (alreadyTerminal) return Promise.resolve(alreadyTerminal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (proof) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      resolve(proof);
    };
    timer = schedule(() => finish(undefined), timeoutMs);
    terminalObserver?.terminalPromise?.then((proof) => finish(proof));
  });
}

function waitForPromiseUntil(promise, { deadlineAt, now, schedule, cancelSchedule }) {
  const timeoutMs = remainingMs(deadlineAt, now);
  if (timeoutMs <= 0) return Promise.resolve(Object.freeze({ timedOut: true }));

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      resolve(Object.freeze(result));
    };
    timer = schedule(() => finish({ timedOut: true }), timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish({ value }),
      (error) => finish({ error })
    );
  });
}

function requestExactClaudeHandleTermination(child) {
  let killError;
  // terminateClaudeChild is also exported for direct use, where the caller
  // may not yet have attached a stdin error listener.
  child?.stdin?.once?.("error", () => {});
  try {
    child?.stdin?.end?.();
  } catch {
    // The stream may already be closed.
  }
  try {
    child?.stdin?.destroy?.();
  } catch {
    // The stream may not expose destroy().
  }
  try {
    if (typeof child?.kill !== "function") return Object.freeze({ requested: false });
    child.kill();
    return Object.freeze({ requested: true });
  } catch (error) {
    killError = error;
  }
  return Object.freeze({ requested: false, killError });
}

function createTerminatorWait(terminator, { deadlineAt, now, schedule, cancelSchedule }) {
  if (!terminator || typeof terminator.once !== "function") {
    const result = Object.freeze({ status: "spawn-failed" });
    return Object.freeze({ getResult: () => result, cancel: () => result });
  }

  let settled = false;
  let result;
  let timer;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    result = Object.freeze(value);
    cancelSchedule(timer);
  };
  const stop = (status) => {
    if (settled) return result;
    try {
      terminator.kill?.();
    } catch {
      // The helper may already have exited.
    }
    finish({ status });
    return result;
  };

  terminator.once("error", (error) => finish({ status: "error", error }));
  terminator.once("close", (code, signal) => {
    finish({ status: code === 0 ? "completed" : "failed", code, signal });
  });
  const timeoutMs = remainingMs(deadlineAt, now);
  if (timeoutMs <= 0) stop("timeout");
  else timer = schedule(() => stop("timeout"), timeoutMs);

  return Object.freeze({ getResult: () => result, cancel: () => stop("cancelled") });
}

function terminalResult(status, method, terminalProof, extras = {}) {
  return Object.freeze({ status, method, terminalProof, ...extras });
}

async function compareBeforeTaskkill(
  processIdentity,
  { inspectProcess, deadlineAt, now, schedule, cancelSchedule }
) {
  const queryBudgetMs = remainingMs(deadlineAt, now);
  if (queryBudgetMs <= 0) {
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-timeout"
    });
  }

  const comparison = compareProcessIdentity(processIdentity, {
    inspectProcess: (pid) => inspectProcess(pid, {
      timeoutMs: queryBudgetMs,
      terminationTimeoutMs: queryBudgetMs
    })
  });
  const outcome = await waitForPromiseUntil(comparison, {
    deadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (outcome.timedOut) {
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-timeout"
    });
  }
  if (outcome.error || !outcome.value) {
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-failed"
    });
  }
  return outcome.value;
}

async function terminateWithExactHandle(
  child,
  terminalObserver,
  { deadlineAt, now, schedule, cancelSchedule, extras = {} }
) {
  // An `exit` is not terminal proof, but it does establish that the direct
  // child handle is no longer live. Do not turn that diagnostic into another
  // kill request; continue the bounded wait for its eventual `close` instead.
  const request = terminalObserver?.getExitObservation?.()
    ? Object.freeze({ requested: false, alreadyExited: true })
    : requestExactClaudeHandleTermination(child);
  const proof = await waitForTerminalProof(terminalObserver, {
    timeoutMs: remainingMs(deadlineAt, now),
    schedule,
    cancelSchedule
  });
  if (proof) return terminalResult("terminated", "child-kill", proof, extras);
  return terminalResult(
    request.killError || (!request.requested && !request.alreadyExited)
      ? "termination-failed"
      : "termination-unproven",
    "child-kill",
    undefined,
    { ...extras, ...(request.killError ? { error: request.killError } : {}) }
  );
}

/**
 * Requests termination of exactly the supplied ChildProcess and waits for
 * bounded terminal evidence. `taskkill` is a PID-tree operation, so only a
 * fresh SAME_PROCESS comparison immediately before it may authorize it. If
 * identity is absent, dead, reused, or ambiguous, the exact in-memory handle
 * is the only safe termination request.
 */
export async function terminateClaudeChild(
  child,
  {
    platform = process.platform,
    spawnTerminator = spawn,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
    terminationTimeoutMs = PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    terminalObserver = observeClaudeChildTerminal(child, undefined),
    processIdentity,
    inspectProcess = inspectProcessIdentity,
    now = Date.now
  } = {}
) {
  if (!runtimeTimeoutIsValid(terminationTimeoutMs)) {
    return terminalResult("termination-failed", "none", undefined, {
      reason: "invalid-termination-timeout"
    });
  }

  if (
    processIdentity &&
    (processIdentity.child !== child ||
      processIdentity.pid !== child?.pid ||
      (terminalObserver?.processIdentity &&
        terminalObserver.processIdentity !== processIdentity))
  ) {
    return terminalResult("termination-failed", "none", undefined, {
      reason: "process-identity-mismatch"
    });
  }

  const existingProof = terminalObserver.getTerminalProof?.();
  if (existingProof) {
    return terminalResult("already-terminal", "none", existingProof);
  }

  const terminationDeadlineAt = now() + terminationTimeoutMs;
  const validPid = Number.isSafeInteger(child?.pid) && child.pid > 0;
  if (platform !== "win32" || !validPid) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule
    });
  }

  if (!processIdentity) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      extras: {
        identityStatus: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
        reason: "process-identity-unavailable"
      }
    });
  }

  const identityMatch = await compareBeforeTaskkill(processIdentity, {
    inspectProcess,
    deadlineAt: terminationDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (identityMatch.status !== PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      extras: {
        identityStatus: identityMatch.status,
        ...(identityMatch.reason ? { reason: identityMatch.reason } : {})
      }
    });
  }

  // No await follows the comparison before taskkill: it is the final identity
  // check for this PID-based operation.
  let terminator;
  try {
    terminator = spawnTerminator(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" }
    );
  } catch (error) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      extras: { taskkillStatus: "spawn-threw", error }
    });
  }

  const taskkill = createTerminatorWait(terminator, {
    deadlineAt: terminationDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  const proof = await waitForTerminalProof(terminalObserver, {
    timeoutMs: remainingMs(terminationDeadlineAt, now),
    schedule,
    cancelSchedule
  });
  const taskkillResult = taskkill.getResult() || taskkill.cancel();
  if (proof) {
    return terminalResult(
      taskkillResult?.status === "completed" ? "terminated" : "already-terminal",
      "taskkill",
      proof,
      { taskkillStatus: taskkillResult?.status || "cancelled" }
    );
  }
  return terminalResult(
    taskkillResult?.status === "completed" ? "termination-unproven" : "termination-failed",
    "taskkill",
    undefined,
    { taskkillStatus: taskkillResult?.status || "timeout" }
  );
}

function attachLifecycle(error, lifecycle) {
  if (!error || typeof error !== "object") return error;
  if (lifecycle.processIdentity) error.processIdentity = lifecycle.processIdentity;
  if (lifecycle.terminalProof) error.terminalProof = lifecycle.terminalProof;
  if (lifecycle.terminationResult) error.terminationResult = lifecycle.terminationResult;
  if (lifecycle.processStarted !== undefined) error.processStarted = lifecycle.processStarted;
  if (lifecycle.processOutcome !== undefined) error.processOutcome = lifecycle.processOutcome;
  if (lifecycle.cleanupFailure !== undefined) error.cleanupFailure = lifecycle.cleanupFailure;
  return error;
}

async function cleanupSettings(settings, startedAt, now, pid, processStarted) {
  try {
    await settings.cleanup();
  } catch (error) {
    throw new ClaudeRunnerError(
      "Failed to remove isolated Claude runtime settings. " +
        (error instanceof Error ? error.message : String(error)),
      {
        code: "claude_settings_cleanup_failed",
        cause: error,
        durationMs: Math.max(0, now() - startedAt),
        pid,
        processStarted
      }
    );
  }
}

function attachCleanupEvidence(cleanupError, originalError, lifecycle = {}) {
  const terminalProof =
    originalError?.terminalProof || lifecycle.terminalObserver?.getTerminalProof?.();
  const processOutcome = originalError || Object.freeze({ status: "completed" });
  return attachLifecycle(cleanupError, {
    processIdentity: originalError?.processIdentity || lifecycle.processIdentity,
    terminalProof,
    terminationResult: originalError?.terminationResult || lifecycle.terminationResult,
    processStarted:
      originalError?.processStarted !== undefined
        ? originalError.processStarted
        : lifecycle.processStarted,
    processOutcome,
    cleanupFailure: cleanupError.cause || cleanupError
  });
}

async function cleanupThenThrow({ settings, startedAt, now, pid, error, lifecycle }) {
  try {
    await cleanupSettings(settings, startedAt, now, pid, error?.processStarted);
  } catch (cleanupError) {
    throw attachCleanupEvidence(cleanupError, error, lifecycle);
  }
  throw error;
}

async function terminateStartedChild({
  child,
  processIdentity,
  terminalObserver,
  originalError,
  terminateChild,
  onTerminationStarted,
  terminationTimeoutMs,
  inspectProcess,
  now,
  schedule,
  cancelSchedule
}) {
  let transitionError;
  if (processIdentity && onTerminationStarted) {
    try {
      // Begin the durable transition before requesting termination, but never
      // await an arbitrary callback indefinitely while the child remains live.
      Promise.resolve(onTerminationStarted(processIdentity)).catch((error) => {
        transitionError = error;
      });
    } catch (error) {
      transitionError = error;
    }
  }

  const terminationDeadlineAt = now() + terminationTimeoutMs;
  const pendingTermination = Promise.resolve().then(() => terminateChild(child, {
    processIdentity,
    terminalObserver,
    terminationTimeoutMs,
    inspectProcess,
    now,
    schedule,
    cancelSchedule
  }));
  const terminationOutcome = await waitForPromiseUntil(pendingTermination, {
    deadlineAt: terminationDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  let terminationResult;
  if (terminationOutcome.timedOut) {
    terminationResult = terminalResult("termination-unproven", "none", undefined, {
      reason: "termination-timeout"
    });
  } else if (terminationOutcome.error) {
    terminationResult = terminalResult("termination-unproven", "none", undefined, {
      error: terminationOutcome.error
    });
  } else {
    terminationResult = terminationOutcome.value;
  }

  const terminalProof = terminationResult?.terminalProof || terminalObserver.getTerminalProof?.();
  if (processIdentity && terminalProof) {
    return attachLifecycle(originalError, {
      processIdentity,
      terminalProof,
      terminationResult,
      processStarted: true
    });
  }

  // The child died before its durable PID+StartTime identity could be captured,
  // yet this coordinator spawned the exact ChildProcess and watched it close.
  // That in-memory evidence is sufficient for this live coordinator to
  // terminalize its own execution instead of locking the repository forever.
  // It is deliberately not durable: after a restart the evidence is gone and
  // the record must stay fail-closed.
  const supervisedProof = !processIdentity ? supervisedCloseProof(terminalProof) : undefined;
  if (supervisedProof) {
    return attachLifecycle(originalError, {
      terminalProof: supervisedProof,
      terminationResult,
      processStarted: true
    });
  }

  return new ClaudeTerminationUnprovenError(originalError, terminationResult, {
    processIdentity,
    pid: child?.pid,
    durationMs: processIdentity ? Math.max(0, now() - processIdentity.startedAt) : undefined,
    ...(transitionError ? { cause: transitionError } : {})
  });
}

/**
 * Launches one fresh Claude print-mode process for one delegation.
 *
 * The composed prompt is deliberately sent over stdin. It is never placed in
 * argv, so large contracts and assignments do not encounter Windows command
 * length limits or become visible in command-line process inspection.
 */
export async function runClaudeAgent({
  prompt,
  cwd,
  repositoryRoot = cwd,
  executionId = randomUUID(),
  agentType = "unclassified",
  runtime,
  onChildStarted,
  onTerminationStarted,
  spawnProcess = spawn,
  createSettings = createRuntimeSettings,
  terminateChild = terminateClaudeChild,
  inspectProcess = inspectProcessIdentity,
  terminationTimeoutMs = PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout
}) {
  const invocationStartedAt = now();
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new ClaudeRunnerError("Claude prompt must be a non-empty string.", {
      code: "invalid_prompt"
    });
  }
  if (
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    typeof repositoryRoot !== "string" ||
    repositoryRoot.length === 0
  ) {
    throw new ClaudeRunnerError("Claude cwd and repository root must be non-empty strings.", {
      code: "invalid_workspace"
    });
  }
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new ClaudeRunnerError("Claude executionId must be a non-empty string.", {
      code: "invalid_execution_id"
    });
  }
  if (typeof agentType !== "string" || agentType.length === 0) {
    throw new ClaudeRunnerError("Claude agentType must be a non-empty string.", {
      code: "invalid_agent_type"
    });
  }
  if (onChildStarted !== undefined && typeof onChildStarted !== "function") {
    throw new ClaudeRunnerError("Claude onChildStarted must be a function when supplied.", {
      code: "invalid_lifecycle_callback"
    });
  }
  if (onTerminationStarted !== undefined && typeof onTerminationStarted !== "function") {
    throw new ClaudeRunnerError("Claude onTerminationStarted must be a function when supplied.", {
      code: "invalid_lifecycle_callback"
    });
  }
  if (!runtimeTimeoutIsValid(runtime?.timeoutMs)) {
    throw new ClaudeRunnerError(
      "Claude timeoutMs must be a positive integer no greater than " +
        MAX_CLAUDE_TIMEOUT_MS +
        " milliseconds.",
      { code: "invalid_timeout" }
    );
  }
  if (!runtimeTimeoutIsValid(terminationTimeoutMs)) {
    throw new ClaudeRunnerError("Claude termination timeout is invalid.", {
      code: "invalid_termination_timeout"
    });
  }
  validateRuntimePolicy(runtime);

  const startedAt = invocationStartedAt;
  const deadlineAt = startedAt + runtime.timeoutMs;
  const durationMs = () => Math.max(0, now() - startedAt);
  const profileTimeoutBeforeSpawn = () => new ClaudeTimeoutError(runtime.timeoutMs, {
    durationMs: durationMs(),
    processStarted: false
  });

  const settingsPromise = Promise.resolve().then(() => createSettings({
    executionId,
    shellPolicy: runtime.shellPolicy
  }));
  const settingsOutcome = await waitForPromiseUntil(settingsPromise, {
    deadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (settingsOutcome.timedOut) {
    // A late settings result must still clean itself up, but it can never make
    // the invocation wait beyond the one profile deadline.
    void settingsPromise.then(
      async (lateSettings) => {
        try {
          await lateSettings?.cleanup?.();
        } catch {
          // The timed-out invocation has already reported its bounded result.
        }
      },
      () => {}
    );
    throw profileTimeoutBeforeSpawn();
  }
  if (settingsOutcome.error) {
    const settingsError = settingsOutcome.error instanceof ClaudeRuntimeSettingsError
      ? settingsOutcome.error
      : new ClaudeRuntimeSettingsError(String(settingsOutcome.error), { cause: settingsOutcome.error });
    throw new ClaudeRunnerError(settingsError.message, {
      code: settingsError.code || "claude_runtime_settings_failed",
      cause: settingsError,
      durationMs: durationMs(),
      processStarted: false
    });
  }
  const settings = settingsOutcome.value;
  if (remainingMs(deadlineAt, now) <= 0) {
    await cleanupThenThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: profileTimeoutBeforeSpawn(),
      lifecycle: { processStarted: false }
    });
  }

  let args;
  try {
    args = buildClaudeArgs(runtime, settings.settingsPath);
  } catch (error) {
    await cleanupThenThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: attachLifecycle(error, { processStarted: false }),
      lifecycle: { processStarted: false }
    });
  }
  if (remainingMs(deadlineAt, now) <= 0) {
    await cleanupThenThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: profileTimeoutBeforeSpawn(),
      lifecycle: { processStarted: false }
    });
  }

  let child;
  try {
    child = spawnProcess(runtime.claudeBin, args, {
      cwd,
      env: runtime.childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    await cleanupThenThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      lifecycle: { processStarted: false },
      error: new ClaudeRunnerError(
      "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
        (error instanceof Error ? error.message : String(error)),
      {
        code: "claude_spawn_failed",
        cause: error,
        durationMs: durationMs(),
        processStarted: false
      }
      )
    });
  }

  const processIdentityCandidate = createProcessIdentityCandidate({
    child,
    executionId,
    agentType,
    repositoryRoot,
    now
  });
  const terminalObserver = observeClaudeChildTerminal(child, processIdentityCandidate, { now });
  // Stdio can also report an asynchronous failure while identity is being
  // established or while an identity-less child is being stopped. Record it
  // immediately so an input close/destroy cannot surface as an unhandled
  // EventEmitter error before normal capture listeners are installed.
  let preflightStdinError;
  let preflightStdoutError;
  let preflightStderrError;
  child.stdin?.once?.("error", (error) => {
    preflightStdinError = error;
  });
  child.stdout?.once?.("error", (error) => {
    preflightStdoutError = error;
  });
  child.stderr?.once?.("error", (error) => {
    preflightStderrError = error;
  });
  let processIdentity;
  const terminationTimeoutForCurrentPhase = () => {
    const remaining = remainingMs(deadlineAt, now);
    // Before the main deadline, termination consumes only its remaining
    // profile budget. At or after it, this is the explicit small safety grace
    // used solely to obtain close proof after a forced stop.
    return remaining > 0
      ? Math.max(1, Math.min(terminationTimeoutMs, remaining))
      : terminationTimeoutMs;
  };
  const stopAndBuildError = async (originalError) =>
    terminateStartedChild({
      child,
      processIdentity,
      terminalObserver,
      originalError,
      terminateChild,
      onTerminationStarted,
      terminationTimeoutMs: terminationTimeoutForCurrentPhase(),
      inspectProcess,
      now,
      schedule,
      cancelSchedule
    });

  const identityInspection = Promise.resolve()
    .then(() => inspectProcess(child?.pid))
    .then(
      (observation) => ({ kind: "identity", observation }),
      () => ({
        kind: "identity",
        observation: Object.freeze({
          status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
          reason: "inspection-threw"
        })
      })
    );
  const identityLifecycle = Promise.race([
    identityInspection,
    terminalObserver.errorPromise.then((observation) => ({ kind: "error", observation })),
    terminalObserver.exitPromise.then((observation) => ({ kind: "exit", observation })),
    terminalObserver.terminalPromise.then((observation) => ({ kind: "close", observation }))
  ]);
  const identityOutcome = await waitForPromiseUntil(identityLifecycle, {
    deadlineAt,
    now,
    schedule,
    cancelSchedule
  });

  const lifecycle = { processIdentity, terminalObserver, processStarted: true };
  const identityUnavailable = () => new ClaudeRunnerError(
    "Claude process did not provide a valid child PID.",
    {
      code: "claude_process_identity_unavailable",
      durationMs: durationMs(),
      pid: child?.pid,
      processStarted: true
    }
  );
  const spawnFailure = (error) => new ClaudeRunnerError(
    "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
      (error instanceof Error ? error.message : String(error)),
    {
      code: "claude_spawn_failed",
      cause: error,
      durationMs: durationMs(),
      pid: child?.pid,
      processStarted: Number.isSafeInteger(child?.pid) && child.pid > 0
    }
  );

  if (identityOutcome.timedOut) {
    const error = await stopAndBuildError(new ClaudeTimeoutError(runtime.timeoutMs));
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (identityOutcome.error) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude identity establishment failed: " + String(identityOutcome.error), {
        code: "claude_process_identity_unavailable",
        durationMs: durationMs(),
        pid: child?.pid,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (identityOutcome.value?.kind === "error") {
    const error = spawnFailure(identityOutcome.value.observation.error);
    if (error.processStarted === false) {
      await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
    }
    const stopped = await stopAndBuildError(error);
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error: stopped, lifecycle });
  }
  if (identityOutcome.value?.kind === "exit" || identityOutcome.value?.kind === "close") {
    const error = await stopAndBuildError(
      identityUnavailable()
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }

  processIdentity = finalizeProcessIdentity(
    processIdentityCandidate,
    identityOutcome.value?.observation,
    terminalObserver
  );
  if (!processIdentity) {
    const error = await stopAndBuildError(
      identityUnavailable()
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  lifecycle.processIdentity = processIdentity;

  const activation = Promise.resolve()
    .then(() => onChildStarted?.(processIdentity))
    .then(
      () => ({ kind: "activated" }),
      (error) => ({ kind: "activation-error", error })
    );
  const activationOutcome = await waitForPromiseUntil(
    Promise.race([
      activation,
      terminalObserver.errorPromise.then((observation) => ({ kind: "error", observation }))
    ]),
    { deadlineAt, now, schedule, cancelSchedule }
  );
  if (activationOutcome.timedOut) {
    const error = await stopAndBuildError(new ClaudeTimeoutError(runtime.timeoutMs));
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (activationOutcome.error) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude child-start lifecycle callback failed: " + String(activationOutcome.error), {
        code: "claude_lifecycle_callback_failed",
        cause: activationOutcome.error,
        durationMs: durationMs(),
        pid: child?.pid,
        processIdentity,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (activationOutcome.value?.kind === "error") {
    const error = spawnFailure(activationOutcome.value.observation.error);
    const stopped = error.processStarted === false ? error : await stopAndBuildError(error);
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error: stopped, lifecycle });
  }
  if (activationOutcome.value?.kind === "activation-error") {
    const callbackError = activationOutcome.value.error;
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude child-start lifecycle callback failed: " +
        (callbackError instanceof Error ? callbackError.message : String(callbackError)), {
        code: "claude_lifecycle_callback_failed",
        cause: callbackError,
        durationMs: durationMs(),
        pid: child?.pid,
        processIdentity,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }

  if (!child.stdin || !child.stdout || !child.stderr) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude process did not expose the required stdio streams.", {
        code: "claude_stdio_unavailable",
        durationMs: durationMs(),
        pid: child.pid,
        processIdentity,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child.pid, error, lifecycle });
  }

  if (terminalObserver.getExitObservation?.() && !terminalObserver.getTerminalProof?.()) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude exited before accepting its prompt.", {
        code: "claude_exited_before_ready",
        durationMs: durationMs(),
        pid: child.pid,
        processIdentity,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child.pid, error, lifecycle });
  }

  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let stoppingPromise;
    let pendingStdinError = preflightStdinError;
    let timer;

    const durationMs = () => Math.max(0, now() - startedAt);
    const diagnostics = () => ({
      stdoutSummary: summarizeBuffer(Buffer.concat(stdoutChunks), "stdout"),
      stderrSummary: summarizeBuffer(Buffer.concat(stderrChunks), "stderr")
    });

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      if (error && error.durationMs === undefined) {
        error.durationMs = durationMs();
      }
      if (error && error.pid === undefined) {
        error.pid = child.pid;
      }

      void cleanupSettings(settings, startedAt, now, child.pid, true).then(
        () => {
          if (error) reject(error);
          else resolve(value);
        },
        (cleanupError) => {
          reject(attachCleanupEvidence(cleanupError, error, {
            processIdentity,
            terminalObserver,
            processStarted: true
          }));
        }
      );
    };

    const finishAfterForcedTermination = (originalError) => {
      if (settled || stoppingPromise) return;
      stoppingPromise = (async () => {
        const error = await stopAndBuildError(originalError);
        settle(error);
      })();
    };

    const capture = (chunks, chunk) => {
      if (settled || stoppingPromise) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (capturedBytes + buffer.length > runtime.maxCaptureBytes) {
        finishAfterForcedTermination(
          new ClaudeOutputCaptureOverflowError(runtime.maxCaptureBytes, diagnostics())
        );
        return;
      }

      capturedBytes += buffer.length;
      chunks.push(buffer);
    };

    child.stdout.on("data", (chunk) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => capture(stderrChunks, chunk));
    child.stdout.on("error", (error) => {
      finishAfterForcedTermination(
        new ClaudeRunnerError("Claude stdout failed: " + error.message, {
          code: "claude_stdout_failed",
          cause: error,
          ...diagnostics()
        })
      );
    });
    child.stderr.on("error", (error) => {
      finishAfterForcedTermination(
        new ClaudeRunnerError("Claude stderr failed: " + error.message, {
          code: "claude_stderr_failed",
          cause: error,
          ...diagnostics()
        })
      );
    });
    child.stdin.on("error", (error) => {
      // A large stdin prompt can race an early child exit. Preserve the
      // child's eventual exit code and diagnostics when close arrives; the
      // already-armed timeout still bounds a child that never closes.
      if (!settled && !pendingStdinError) {
        pendingStdinError = error;
      }
    });
    terminalObserver.errorPromise.then((observation) => {
      finishAfterForcedTermination(
        new ClaudeRunnerError(
          "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
            (observation.error instanceof Error ? observation.error.message : String(observation.error)),
          { code: "claude_spawn_failed", cause: observation.error, ...diagnostics() }
        )
      );
    });
    const handleClose = (code, signal) => {
      if (settled || stoppingPromise) return;

      const outputDiagnostics = diagnostics();
      const terminalProof = terminalObserver.getTerminalProof?.();
      if (code !== 0) {
        settle(attachLifecycle(new ClaudeExitError(code, signal, outputDiagnostics), {
          processIdentity,
          terminalProof,
          processStarted: true
        }));
        return;
      }

      if (pendingStdinError) {
        settle(attachLifecycle(
          new ClaudeRunnerError("Claude stdin failed: " + pendingStdinError.message, {
            code: "claude_stdin_failed",
            cause: pendingStdinError,
            ...outputDiagnostics
          }),
          { processIdentity, terminalProof, processStarted: true }
        ));
        return;
      }

      const result = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (!result) {
        settle(attachLifecycle(
          new ClaudeRunnerError(
            "Claude returned no stdout." +
              (outputDiagnostics.stderrSummary
                ? " stderr: " + outputDiagnostics.stderrSummary
                : ""),
            { code: "claude_empty_output", ...outputDiagnostics }
          ),
          { processIdentity, terminalProof, processStarted: true }
        ));
        return;
      }

      settle(undefined, {
        result,
        stderrSummary: outputDiagnostics.stderrSummary,
        durationMs: durationMs(),
        pid: child.pid,
        processIdentity,
        terminalProof
      });
    };
    child.on("close", handleClose);

    timer = schedule(() => {
      finishAfterForcedTermination(new ClaudeTimeoutError(runtime.timeoutMs, diagnostics()));
    }, remainingMs(deadlineAt, now));

    if (preflightStdoutError) {
      finishAfterForcedTermination(
        new ClaudeRunnerError("Claude stdout failed: " + preflightStdoutError.message, {
          code: "claude_stdout_failed",
          cause: preflightStdoutError,
          ...diagnostics()
        })
      );
    } else if (preflightStderrError) {
      finishAfterForcedTermination(
        new ClaudeRunnerError("Claude stderr failed: " + preflightStderrError.message, {
          code: "claude_stderr_failed",
          cause: preflightStderrError,
          ...diagnostics()
        })
      );
    }

    const priorCloseProof = terminalObserver.getCloseProof?.();
    if (priorCloseProof) {
      // Readable streams can still flush their already-buffered diagnostics on
      // the next turn after ChildProcess close. Keep close as the proof while
      // allowing those bounded buffers to reach the diagnostic capture first.
      // The process is already terminal, so the profile deadline no longer
      // governs this one event-loop turn of diagnostic delivery.
      cancelSchedule(timer);
      setImmediate(() => handleClose(priorCloseProof.code, priorCloseProof.signal));
    } else {
      try {
        child.stdin.write(prompt, "utf8");
        child.stdin.end();
      } catch (error) {
        if (!pendingStdinError) {
          pendingStdinError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
  });
}
