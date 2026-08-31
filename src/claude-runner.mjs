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

function finalizeProcessIdentity(candidate, processObservation) {
  if (!candidate) return undefined;
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
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => {
    resolveTerminal = resolve;
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
      if (!exitObservation) exitObservation = observation;
      return;
    }
    if (closeProof) return;
    closeProof = observation;
    resolveTerminal(observation);
  };

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
    terminalPromise
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

/**
 * Waits for the terminator (taskkill) to settle within a bounded deadline.
 *
 * As with waitForTerminalProof, the deadline timer stays referenced: the
 * termination outcome feeds the proof-of-death decision, so the runtime must
 * remain alive until this bounded wait resolves.
 */
function waitForTerminator(
  terminator,
  {
    timeoutMs,
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  }
) {
  if (!terminator || typeof terminator.once !== "function") {
    return Promise.resolve({ status: "spawn-failed" });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      resolve(result);
    };
    timer = schedule(() => {
      try {
        terminator.kill?.();
      } catch {
        // The terminator may already have exited.
      }
      finish({ status: "timeout" });
    }, timeoutMs);
    terminator.once("error", (error) => finish({ status: "error", error }));
    terminator.once("close", (code, signal) => {
      finish({ status: code === 0 ? "completed" : "failed", code, signal });
    });
  });
}

function terminalResult(status, method, terminalProof, extras = {}) {
  return Object.freeze({ status, method, terminalProof, ...extras });
}

/**
 * Requests termination of exactly the supplied ChildProcess and waits for
 * bounded, identity-bound terminal evidence. Starting taskkill is never
 * considered proof that the Claude child died.
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
    inspectProcess = inspectProcessIdentity
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

  const validPid = Number.isSafeInteger(child?.pid) && child.pid > 0;
  if (platform === "win32" && validPid) {
    const identityMatch = processIdentity
      ? await compareProcessIdentity(processIdentity, { inspectProcess })
      : Object.freeze({
          status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
          reason: "process-identity-unavailable"
        });
    if (identityMatch.status !== PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
      const proof = await waitForTerminalProof(terminalObserver, {
        timeoutMs: terminationTimeoutMs,
        schedule,
        cancelSchedule
      });
      return proof
        ? terminalResult("already-terminal", "identity-check", proof, {
            identityStatus: identityMatch.status
          })
        : terminalResult("termination-unproven", "identity-check", undefined, {
            identityStatus: identityMatch.status,
            reason: identityMatch.reason || "process-identity-not-live"
          });
    }

    let terminator;
    try {
      terminator = spawnTerminator(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" }
      );
    } catch (error) {
      const proof = await waitForTerminalProof(terminalObserver, {
        timeoutMs: terminationTimeoutMs,
        schedule,
        cancelSchedule
      });
      return proof
        ? terminalResult("terminated", "taskkill", proof, { taskkillStatus: "spawn-threw" })
        : terminalResult("termination-failed", "taskkill", undefined, {
            taskkillStatus: "spawn-threw",
            error
          });
    }

    const taskkillResult = await waitForTerminator(terminator, {
      timeoutMs: terminationTimeoutMs,
      schedule,
      cancelSchedule
    });
    const proof = await waitForTerminalProof(terminalObserver, {
      timeoutMs: terminationTimeoutMs,
      schedule,
      cancelSchedule
    });
    if (proof) {
      return terminalResult(
        taskkillResult.status === "completed" ? "terminated" : "already-terminal",
        "taskkill",
        proof,
        { taskkillStatus: taskkillResult.status }
      );
    }
    return terminalResult(
      taskkillResult.status === "completed" ? "termination-unproven" : "termination-failed",
      "taskkill",
      undefined,
      { taskkillStatus: taskkillResult.status }
    );
  }

  let killFailed = false;
  try {
    child?.kill?.();
  } catch {
    killFailed = true;
  }
  const proof = await waitForTerminalProof(terminalObserver, {
    timeoutMs: terminationTimeoutMs,
    schedule,
    cancelSchedule
  });
  if (proof) return terminalResult("terminated", "child-kill", proof);
  return terminalResult(killFailed ? "termination-failed" : "termination-unproven", "child-kill");
}

function attachLifecycle(error, lifecycle) {
  if (!error || typeof error !== "object") return error;
  if (lifecycle.processIdentity) error.processIdentity = lifecycle.processIdentity;
  if (lifecycle.terminalProof) error.terminalProof = lifecycle.terminalProof;
  if (lifecycle.terminationResult) error.terminationResult = lifecycle.terminationResult;
  if (lifecycle.processStarted !== undefined) error.processStarted = lifecycle.processStarted;
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

async function cleanupThenThrow({ settings, startedAt, now, pid, error }) {
  try {
    await cleanupSettings(settings, startedAt, now, pid, error?.processStarted);
  } catch (cleanupError) {
    if (error?.code === "claude_termination_unproven") throw error;
    throw attachLifecycle(cleanupError, {
      processIdentity: error?.processIdentity,
      terminalProof: error?.terminalProof,
      terminationResult: error?.terminationResult,
      processStarted: error?.processStarted
    });
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
  now
}) {
  let transitionError;
  if (processIdentity && onTerminationStarted) {
    try {
      await onTerminationStarted(processIdentity);
    } catch (error) {
      transitionError = error;
    }
  }

  let terminationResult;
  try {
    terminationResult = await terminateChild(child, {
      processIdentity,
      terminalObserver,
      terminationTimeoutMs,
      inspectProcess
    });
  } catch (error) {
    terminationResult = terminalResult("termination-unproven", "none", undefined, { error });
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
  now = Date.now
}) {
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

  const startedAt = now();
  let settings;
  try {
    settings = await createSettings({
      executionId,
      shellPolicy: runtime.shellPolicy
    });
  } catch (error) {
    const settingsError = error instanceof ClaudeRuntimeSettingsError
      ? error
      : new ClaudeRuntimeSettingsError(String(error), { cause: error });
    throw new ClaudeRunnerError(settingsError.message, {
      code: settingsError.code || "claude_runtime_settings_failed",
      cause: settingsError,
      durationMs: Math.max(0, now() - startedAt),
      processStarted: false
    });
  }

  let args;
  try {
    args = buildClaudeArgs(runtime, settings.settingsPath);
  } catch (error) {
    try {
      await cleanupSettings(settings, startedAt, now, undefined, false);
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw attachLifecycle(error, { processStarted: false });
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
    await cleanupSettings(settings, startedAt, now, undefined, false);
    throw new ClaudeRunnerError(
      "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
        (error instanceof Error ? error.message : String(error)),
      {
        code: "claude_spawn_failed",
        cause: error,
        durationMs: now() - startedAt,
        processStarted: false
      }
    );
  }

  const processIdentityCandidate = createProcessIdentityCandidate({
    child,
    executionId,
    agentType,
    repositoryRoot,
    now
  });
  const terminalObserver = observeClaudeChildTerminal(child, processIdentityCandidate, { now });
  let processObservation;
  try {
    processObservation = await inspectProcess(child?.pid);
  } catch {
    processObservation = Object.freeze({
      status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
      reason: "inspection-threw"
    });
  }
  const processIdentity = finalizeProcessIdentity(processIdentityCandidate, processObservation);
  const stopAndBuildError = async (originalError) =>
    terminateStartedChild({
      child,
      processIdentity,
      terminalObserver,
      originalError,
      terminateChild,
      onTerminationStarted,
      terminationTimeoutMs,
      inspectProcess,
      now
    });

  if (!processIdentity) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude process did not provide a valid child PID.", {
        code: "claude_process_identity_unavailable",
        durationMs: Math.max(0, now() - startedAt),
        pid: child?.pid,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child?.pid, error });
  }

  try {
    await onChildStarted?.(processIdentity);
  } catch (callbackError) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude child-start lifecycle callback failed: " + callbackError.message, {
        code: "claude_lifecycle_callback_failed",
        cause: callbackError,
        durationMs: Math.max(0, now() - startedAt),
        pid: child.pid,
        processIdentity,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child.pid, error });
  }

  if (!child.stdin || !child.stdout || !child.stderr) {
    const error = await stopAndBuildError(
      new ClaudeRunnerError("Claude process did not expose the required stdio streams.", {
        code: "claude_stdio_unavailable",
        durationMs: Math.max(0, now() - startedAt),
        pid: child.pid,
        processIdentity,
        processStarted: true
      })
    );
    await cleanupThenThrow({ settings, startedAt, now, pid: child.pid, error });
  }

  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let stoppingPromise;
    let pendingStdinError;
    let timer;

    const durationMs = () => Math.max(0, now() - startedAt);
    const diagnostics = () => ({
      stdoutSummary: summarizeBuffer(Buffer.concat(stdoutChunks), "stdout"),
      stderrSummary: summarizeBuffer(Buffer.concat(stderrChunks), "stderr")
    });

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
          if (error?.code === "claude_termination_unproven") {
            reject(error);
            return;
          }
          reject(attachLifecycle(cleanupError, {
            processIdentity: error?.processIdentity || processIdentity,
            terminalProof: error?.terminalProof,
            terminationResult: error?.terminationResult,
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
    child.on("error", (error) => {
      finishAfterForcedTermination(
        new ClaudeRunnerError(
          "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
            error.message,
          { code: "claude_spawn_failed", cause: error, ...diagnostics() }
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

    timer = setTimeout(() => {
      finishAfterForcedTermination(new ClaudeTimeoutError(runtime.timeoutMs, diagnostics()));
    }, runtime.timeoutMs);

    const priorCloseProof = terminalObserver.getCloseProof?.();
    if (priorCloseProof) {
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
