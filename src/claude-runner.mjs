import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ClaudeExitError,
  ClaudeOutputCaptureOverflowError,
  ClaudeRunnerError,
  ClaudeTimeoutError,
  attachLifecycle
} from "./claude-errors.mjs";
import { buildClaudeArgs, validateRuntimePolicy } from "./claude-invocation.mjs";
import {
  ClaudeRuntimeSettingsError,
  createRuntimeSettings
} from "./claude-runtime-settings.mjs";
import {
  PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  startDurableLifecycleMutation,
  terminateClaudeChild,
  terminateStartedChild
} from "./claude-termination.mjs";
import {
  PROCESS_IDENTITY_STATUS,
  inspectProcessIdentity,
  validateDurableProcessIdentity
} from "./process-identity.mjs";
import {
  MAX_SCHEDULABLE_DELAY_MS,
  isSchedulableTimeout,
  remainingMs,
  waitForPromiseUntil
} from "./process/deadlines.mjs";
import { observeChildTerminal, supervisedCloseProof } from "./process/terminal-observer.mjs";

/**
 * Orchestrates one fresh Claude print-mode execution end to end: isolated
 * runtime settings, spawn, durable identity binding, custody lifecycle
 * callbacks, bounded output capture, and settings housekeeping.
 *
 * Process primitives it deliberately does not own: terminal observation,
 * Windows termination mechanics and deadline races live in process/, and the
 * forced-termination proof policy lives in claude-termination.
 */

export {
  ClaudeExitError,
  ClaudeOutputCaptureOverflowError,
  ClaudeRunnerError,
  ClaudeTerminationUnprovenError,
  ClaudeTimeoutError
} from "./claude-errors.mjs";
export { PROCESS_TREE_TERMINATION_TIMEOUT_MS, terminateClaudeChild } from "./claude-termination.mjs";
export { getClaudeRunnerArgs } from "./claude-invocation.mjs";
export { observeChildTerminal as observeClaudeChildTerminal } from "./process/terminal-observer.mjs";

const STDERR_SUMMARY_BYTES = 16 * 1024;
// Settings removal is safe background housekeeping, but the caller waits only
// this bounded interval before reporting an explicit cleanup-timeout outcome.
export const RUNTIME_SETTINGS_HOUSEKEEPING_TIMEOUT_MS = 5_000;
export const MAX_CLAUDE_TIMEOUT_MS = MAX_SCHEDULABLE_DELAY_MS;

function reportLateRecoveryFailureToStderr(error) {
  // MCP uses stdout for protocol traffic. A late custody recovery happens
  // after its result was returned, so stderr is the narrow observable channel
  // that does not mutate that result or create an unhandled rejection.
  console.error(
    "[claude-agents-mcp] late ORPHANED custody recovery failed:",
    error instanceof Error ? (error.stack || error.message) : String(error)
  );
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

/**
 * Observes request cancellation without making a phase's useful-work deadline
 * depend on the cancellation listener. Callers dispose it as soon as their
 * phase settles, so a later root stop cannot affect a completed phase.
 */
function observeRequestAbort(abortSignal) {
  let abortListener;
  let settled = false;
  const promise = new Promise((resolve) => {
    if (!abortSignal) return;
    const reportAbort = () => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({ kind: "request-aborted" }));
    };
    abortListener = reportAbort;
    if (abortSignal.aborted) {
      reportAbort();
    } else {
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  });
  return Object.freeze({
    promise,
    dispose: () => abortSignal?.removeEventListener("abort", abortListener)
  });
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

async function cleanupSettings(
  settings,
  startedAt,
  now,
  pid,
  processStarted,
  {
    housekeepingDeadlineAt,
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  } = {}
) {
  const cleanup = Promise.resolve().then(() => settings.cleanup());
  const outcome = await waitForPromiseUntil(cleanup, {
    deadlineAt: housekeepingDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (outcome.timedOut) {
    // Removal is explicitly safe background housekeeping. It remains observed
    // so a later rejection cannot become unhandled, but it is no longer allowed
    // to keep the MCP call pending after the housekeeping deadline.
    void cleanup.catch(() => {});
    throw new ClaudeRunnerError(
      "Timed out while removing isolated Claude runtime settings.",
      {
        code: "claude_settings_cleanup_timeout",
        durationMs: Math.max(0, now() - startedAt),
        pid,
        processStarted
      }
    );
  }
  if (outcome.error) {
    const error = outcome.error;
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

async function cleanupThenThrow({
  settings,
  startedAt,
  now,
  pid,
  error,
  lifecycle,
  housekeepingDeadlineAt,
  schedule = setTimeout,
  cancelSchedule = clearTimeout
}) {
  try {
    await cleanupSettings(settings, startedAt, now, pid, error?.processStarted, {
      housekeepingDeadlineAt,
      schedule,
      cancelSchedule
    });
  } catch (cleanupError) {
    throw attachCleanupEvidence(cleanupError, error, lifecycle);
  }
  throw error;
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
  abortSignal,
  onChildStarted,
  onTerminationStarted,
  onLateTerminalProof,
  onLateRecoveryFailure = reportLateRecoveryFailureToStderr,
  spawnProcess = spawn,
  createSettings = createRuntimeSettings,
  terminateChild = terminateClaudeChild,
  inspectProcess = inspectProcessIdentity,
  terminationTimeoutMs = PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  housekeepingTimeoutMs = RUNTIME_SETTINGS_HOUSEKEEPING_TIMEOUT_MS,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout
}) {
  const invocationStartedAt = now();
  if (abortSignal?.aborted) {
    throw new ClaudeRunnerError("Client cancelled delegation before execution started.", {
      code: "claude_cancelled",
      processStarted: false,
      durationMs: 0
    });
  }
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
  if (onLateTerminalProof !== undefined && typeof onLateTerminalProof !== "function") {
    throw new ClaudeRunnerError("Claude onLateTerminalProof must be a function when supplied.", {
      code: "invalid_lifecycle_callback"
    });
  }
  if (onLateRecoveryFailure !== undefined && typeof onLateRecoveryFailure !== "function") {
    throw new ClaudeRunnerError("Claude onLateRecoveryFailure must be a function when supplied.", {
      code: "invalid_lifecycle_callback"
    });
  }
  if (!isSchedulableTimeout(runtime?.timeoutMs)) {
    throw new ClaudeRunnerError(
      "Claude timeoutMs must be a positive integer no greater than " +
        MAX_CLAUDE_TIMEOUT_MS +
        " milliseconds.",
      { code: "invalid_timeout" }
    );
  }
  if (!isSchedulableTimeout(terminationTimeoutMs)) {
    throw new ClaudeRunnerError("Claude termination timeout is invalid.", {
      code: "invalid_termination_timeout"
    });
  }
  if (!isSchedulableTimeout(housekeepingTimeoutMs)) {
    throw new ClaudeRunnerError("Claude housekeeping timeout is invalid.", {
      code: "invalid_housekeeping_timeout"
    });
  }
  validateRuntimePolicy(runtime);

  const startedAt = invocationStartedAt;
  const executionDeadlineAt = startedAt + runtime.timeoutMs;
  const durationMs = () => Math.max(0, now() - startedAt);
  const cancellationBeforeSpawn = () => new ClaudeRunnerError(
    "Client cancelled delegation before execution started.",
    {
      code: "claude_cancelled",
      processStarted: false,
      durationMs: durationMs()
    }
  );
  const profileTimeoutBeforeSpawn = () => new ClaudeTimeoutError(runtime.timeoutMs, {
    durationMs: durationMs(),
    processStarted: false
  });
  const cleanupAndThrow = async (details) =>
    await cleanupThenThrow({
      ...details,
      // Housekeeping starts only after the useful-work/termination outcome is
      // fixed. Its one absolute deadline is created here and then passed
      // unchanged into the cleanup layer.
      housekeepingDeadlineAt: now() + housekeepingTimeoutMs,
      schedule,
      cancelSchedule
    });

  const settingsPromise = Promise.resolve().then(() => {
    // An abort can arrive after the synchronous entry check but before this
    // first deferred operation starts. Do not create per-run files for an
    // already-stopped request.
    if (abortSignal?.aborted) throw cancellationBeforeSpawn();
    return createSettings({
      executionId,
      shellPolicy: runtime.shellPolicy
    });
  });
  const settingsOutcome = await waitForPromiseUntil(settingsPromise, {
    deadlineAt: executionDeadlineAt,
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
    throw abortSignal?.aborted ? cancellationBeforeSpawn() : profileTimeoutBeforeSpawn();
  }
  if (settingsOutcome.error) {
    if (abortSignal?.aborted || settingsOutcome.error?.code === "claude_cancelled") {
      throw cancellationBeforeSpawn();
    }
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
  if (abortSignal?.aborted) {
    await cleanupAndThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: cancellationBeforeSpawn(),
      lifecycle: { processStarted: false }
    });
  }
  if (remainingMs(executionDeadlineAt, now) <= 0) {
    await cleanupAndThrow({
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
    await cleanupAndThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: attachLifecycle(error, { processStarted: false }),
      lifecycle: { processStarted: false }
    });
  }
  if (remainingMs(executionDeadlineAt, now) <= 0) {
    await cleanupAndThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: profileTimeoutBeforeSpawn(),
      lifecycle: { processStarted: false }
    });
  }

  if (abortSignal?.aborted) {
    await cleanupAndThrow({
      settings,
      startedAt,
      now,
      pid: undefined,
      error: cancellationBeforeSpawn(),
      lifecycle: { processStarted: false }
    });
  }

  let child;
  try {
    // This is the final gate before the OS process-creation call. A request
    // can still abort inside that non-preemptible call; the post-spawn phase
    // observes it and terminates the exact returned child.
    if (abortSignal?.aborted) throw cancellationBeforeSpawn();
    child = spawnProcess(runtime.claudeBin, args, {
      cwd,
      env: runtime.childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    if (error?.code === "claude_cancelled") {
      await cleanupAndThrow({
        settings,
        startedAt,
        now,
        pid: undefined,
        lifecycle: { processStarted: false },
        error
      });
    }
    await cleanupAndThrow({
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

  const cancellationAfterSpawn = () => new ClaudeRunnerError("Client cancelled delegation.", {
    code: "claude_cancelled",
    durationMs: durationMs(),
    pid: child?.pid,
    processStarted: true
  });
  const processIdentityCandidate = createProcessIdentityCandidate({
    child,
    executionId,
    agentType,
    repositoryRoot,
    now
  });
  const terminalObserver = observeChildTerminal(child, processIdentityCandidate, { now });
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
  // A successful Claude result is valid only after the prompt write has begun.
  // Keep this explicit because a close can race durable activation after the
  // child has emitted startup output but before it received any assignment.
  let assignmentDeliveryState = "not-delivered";
  let lateRecoveryArmed = false;
  let lateRecoveryNotified = false;
  const notifyLateTerminalProof = (closeProof) => {
    if (lateRecoveryNotified || !lateRecoveryArmed || !onLateTerminalProof || !closeProof) return;
    const proof = processIdentity ? closeProof : supervisedCloseProof(closeProof);
    if (!proof) return;
    lateRecoveryNotified = true;
    // Controlled late orphan recovery owns only durable custody; it is not an
    // unbounded continuation of the completed Claude invocation.
    void Promise.resolve()
      .then(() => onLateTerminalProof(proof))
      .catch((error) => {
        // A diagnostic hook may itself be async. Observe both a throw and a
        // rejected diagnostic promise so late recovery failure cannot become
        // an unhandled rejection after the delegation result has returned.
        void Promise.resolve()
          .then(() => onLateRecoveryFailure?.(error, { processIdentity, terminalProof: proof }))
          .catch(() => {});
      });
  };
  terminalObserver.terminalPromise.then(notifyLateTerminalProof);
  const armLateRecovery = () => {
    lateRecoveryArmed = true;
    notifyLateTerminalProof(terminalObserver.getTerminalProof?.());
  };
  const stopAndBuildError = async (originalError) => {
    const stopped = await terminateStartedChild({
      child,
      processIdentity,
      terminalObserver,
      originalError,
      terminateChild,
      onTerminationStarted,
      executionDeadlineAt,
      terminationTimeoutMs,
      inspectProcess,
      abortSignal,
      now,
      schedule,
      cancelSchedule
    });
    if (
      stopped?.code === "claude_termination_unproven" &&
      stopped.lateRecoveryAllowed !== false
    ) armLateRecovery();
    return stopped;
  };

  const identityObservationController = new AbortController();
  const identityInspection = Promise.resolve()
    .then(() => inspectProcess(child?.pid, {
      deadlineAt: executionDeadlineAt,
      now,
      abortSignal: identityObservationController.signal
    }))
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
  const identityAbort = observeRequestAbort(abortSignal);
  const identityLifecycle = Promise.race([
    identityInspection,
    identityAbort.promise,
    terminalObserver.errorPromise.then((observation) => ({ kind: "error", observation })),
    terminalObserver.exitPromise.then((observation) => ({ kind: "exit", observation })),
    terminalObserver.terminalPromise.then((observation) => ({ kind: "close", observation }))
  ]);
  const identityOutcome = await waitForPromiseUntil(identityLifecycle, {
    deadlineAt: executionDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  identityAbort.dispose();
  // This query is only for initial durable binding. Once the exact child has
  // another lifecycle outcome, it cannot become useful and is cancelled; the
  // process-identity module still bounds its read-only close observation.
  identityObservationController.abort();

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
  const closeBeforeAssignmentError = (closeProof, outputDiagnostics = {}) => {
    if (closeProof?.code !== 0) {
      return new ClaudeExitError(closeProof.code, closeProof.signal, outputDiagnostics);
    }
    return new ClaudeRunnerError("Claude exited before accepting its prompt.", {
      code: "claude_exited_before_ready",
      ...outputDiagnostics
    });
  };

  if (identityOutcome.timedOut) {
    const error = await stopAndBuildError(new ClaudeTimeoutError(runtime.timeoutMs));
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (identityOutcome.value?.kind === "request-aborted") {
    const error = await stopAndBuildError(cancellationAfterSpawn());
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
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
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (identityOutcome.value?.kind === "error") {
    const error = spawnFailure(identityOutcome.value.observation.error);
    if (error.processStarted === false) {
      await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
    }
    const stopped = await stopAndBuildError(error);
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error: stopped, lifecycle });
  }
  if (identityOutcome.value?.kind === "exit" || identityOutcome.value?.kind === "close") {
    const closeProof = terminalObserver.getCloseProof?.();
    const error = await stopAndBuildError(
      closeProof ? closeBeforeAssignmentError(closeProof) : identityUnavailable()
    );
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }

  processIdentity = finalizeProcessIdentity(
    processIdentityCandidate,
    identityOutcome.value?.observation,
    terminalObserver
  );
  if (!processIdentity) {
    const closeProof = terminalObserver.getCloseProof?.();
    const error = await stopAndBuildError(
      closeProof ? closeBeforeAssignmentError(closeProof) : identityUnavailable()
    );
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  lifecycle.processIdentity = processIdentity;

  const activation = startDurableLifecycleMutation(onChildStarted, processIdentity, {
    executionDeadlineAt,
    abortSignal
  });
  const activationAbort = observeRequestAbort(abortSignal);
  const activationOutcome = await waitForPromiseUntil(
    Promise.race([
      activation.promise,
      activationAbort.promise,
      terminalObserver.errorPromise.then((observation) => Object.freeze({ kind: "child-error", observation })),
      terminalObserver.terminalPromise.then((terminalProof) => Object.freeze({ kind: "close", terminalProof }))
    ]),
    { deadlineAt: executionDeadlineAt, now, schedule, cancelSchedule }
  );
  activationAbort.dispose();
  if (activationOutcome.timedOut) {
    activation.requestCancellation();
    const error = await stopAndBuildError(new ClaudeTimeoutError(runtime.timeoutMs));
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (activationOutcome.error) {
    activation.requestCancellation();
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
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (
    activationOutcome.value?.kind === "request-aborted" ||
    activationOutcome.value?.kind === "cancelled"
  ) {
    activation.requestCancellation();
    const error = await stopAndBuildError(cancellationAfterSpawn());
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
  }
  if (activationOutcome.value?.kind === "child-error") {
    activation.requestCancellation();
    const error = spawnFailure(activationOutcome.value.observation.error);
    const stopped = error.processStarted === false ? error : await stopAndBuildError(error);
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error: stopped, lifecycle });
  }
  if (activationOutcome.value?.kind === "close") {
    activation.requestCancellation();
    // Preserve the close diagnostics below. The exact child is already
    // terminal, and activation has received cancellation. A custody mutation
    // still before rename cannot publish; an already-issued publication stays
    // serialized until the later terminal release observes it.
  }
  if (activationOutcome.value?.kind === "failed") {
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
    await cleanupAndThrow({ settings, startedAt, now, pid: child?.pid, error, lifecycle });
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
    await cleanupAndThrow({ settings, startedAt, now, pid: child.pid, error, lifecycle });
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
    await cleanupAndThrow({ settings, startedAt, now, pid: child.pid, error, lifecycle });
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

    let abortListener;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      if (abortListener && abortSignal) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      if (error && error.durationMs === undefined) {
        error.durationMs = durationMs();
      }
      if (error && error.pid === undefined) {
        error.pid = child.pid;
      }

      // Process outcome and close proof are now fixed. Cleanup is a distinct
      // housekeeping phase with its own absolute bound.
      const housekeepingDeadlineAt = now() + housekeepingTimeoutMs;
      void cleanupSettings(settings, startedAt, now, child.pid, true, {
        // A final result is delayed only by this explicit housekeeping budget;
        // a hung cleanup cannot hold the MCP Promise forever.
        housekeepingDeadlineAt,
        schedule,
        cancelSchedule
      }).then(
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
        try {
          const error = await stopAndBuildError(originalError);
          settle(error);
        } catch (error) {
          settle(error);
        }
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

      if (assignmentDeliveryState === "not-delivered") {
        // Startup diagnostics are not an answer to the assignment. A clean
        // close before the first prompt byte is attempted is terminal proof,
        // but never a successful specialist result.
        settle(attachLifecycle(closeBeforeAssignmentError({ code, signal }, outputDiagnostics), {
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
    }, remainingMs(executionDeadlineAt, now));

    if (abortSignal) {
      abortListener = () => {
        finishAfterForcedTermination(
          new ClaudeRunnerError("Client cancelled delegation.", {
            code: "claude_cancelled",
            ...diagnostics()
          })
        );
      };
      if (abortSignal.aborted) {
        abortListener();
      } else {
        abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

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
      // This direct check is the final execution-deadline gate. A timer queued
      // at zero delay cannot protect the byte write below once this turn runs.
      if (remainingMs(executionDeadlineAt, now) <= 0 || stoppingPromise) {
        if (!stoppingPromise) {
          finishAfterForcedTermination(new ClaudeTimeoutError(runtime.timeoutMs, diagnostics()));
        }
        return;
      }
      // A close can be delivered by an injected clock or another synchronous
      // observer during the final deadline check. Re-read exact close proof
      // immediately before the write so no assignment bytes follow it.
      const closeBeforeWrite = terminalObserver.getCloseProof?.();
      if (closeBeforeWrite) {
        cancelSchedule(timer);
        handleClose(closeBeforeWrite.code, closeBeforeWrite.signal);
        return;
      }
      // "delivery-started" is committed before calling write(): a synchronous
      // stream callback may close the child during that call. "committed"
      // means both write and end returned without throwing.
      assignmentDeliveryState = "delivery-started";
      try {
        child.stdin.write(prompt, "utf8");
        child.stdin.end();
        assignmentDeliveryState = "committed";
      } catch (error) {
        if (!pendingStdinError) {
          pendingStdinError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
  });
}
