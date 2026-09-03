import { spawn } from "node:child_process";
import {
  PROCESS_IDENTITY_MATCH,
  PROCESS_IDENTITY_STATUS,
  inspectProcessIdentity,
  validateDurableProcessIdentity
} from "./process-identity.mjs";
import { remainingMs } from "./process/deadlines.mjs";
import {
  compareIdentityBeforeTaskkill,
  requestExactHandleTermination,
  spawnTaskkillHelper,
  superviseTaskkillHelper,
  taskkillAuthorizationDeadlineAt
} from "./process/windows-termination.mjs";

/**
 * One supervised external process.
 *
 * Orchestration-owned external commands (currently Git) share this primitive so
 * bounded execution, output limits, termination and proof-of-death are not
 * re-implemented per call site with scattered setTimeout/kill logic.
 *
 * Only `close` is terminal proof. Windows tree termination has one additional
 * guard: the PID must still have the durable start-time identity captured for
 * this exact ChildProcess immediately before taskkill is started. A direct
 * ChildProcess handle remains safe when that durable identity is unavailable;
 * a PID-only taskkill never is.
 *
 * The Windows identity gate, the taskkill helper lifecycle and the exact-handle
 * request are not implemented here: they are the shared process/ primitives, so
 * Git and Claude terminate through one implementation with one set of proofs.
 */

// Fixed close-proof grace once forced termination begins. It is separate from
// the command's useful-execution deadline, including for early interruptions.
const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;

export class SupervisedProcessError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SupervisedProcessError";
    this.code = options.code || "supervised_process_failed";
    this.reason = options.reason;
    this.stdout = options.stdout || "";
    this.stderr = options.stderr || "";
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    // True whenever the command was interrupted rather than observed to
    // complete. Killing a process never proves what it had already written.
    this.sideEffectsUnproven = options.sideEffectsUnproven === true;
    // True only when the exact target closed and any launched taskkill helper
    // also closed. This is the safe proof used by Git custody cleanup.
    this.terminationProven = options.terminationProven === true;
    // Keep the two facts inspectable rather than conflating taskkill helper
    // quiescence with target process terminal proof.
    this.targetTerminationProven = options.targetTerminationProven === true;
    this.taskkillHelperQuiescenceProven = options.taskkillHelperQuiescenceProven;
    this.taskkillHelper = options.taskkillHelper;
  }
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

/**
 * Starts the initial identity observation without delaying command execution.
 * If the exact ChildProcess emits exit or close before the query completes, the
 * observation is discarded. A later fresh comparison is still required before
 * Windows taskkill.
 */
function captureDurableIdentity(child, {
  platform,
  inspectProcess,
  hasLifecycleEnded,
  executionDeadlineAt,
  now
}) {
  let identity;
  if (platform !== "win32" || !validPid(child?.pid)) {
    return Object.freeze({ getIdentity: () => identity, cancelObservation: () => {} });
  }

  const pid = child.pid;
  const observationController = new AbortController();
  void Promise.resolve()
    .then(() => inspectProcess(pid, {
      platform,
      deadlineAt: executionDeadlineAt,
      now,
      abortSignal: observationController.signal
    }))
    .then(
      (observation) => {
        if (hasLifecycleEnded() || observation?.status !== PROCESS_IDENTITY_STATUS.ALIVE) return;
        let durable;
        try {
          durable = validateDurableProcessIdentity(observation.identity);
        } catch {
          return;
        }
        if (durable.pid === pid) identity = durable;
      },
      () => {
        // Identity absence is fail-closed for taskkill, not a command failure.
      }
    );

  return Object.freeze({
    getIdentity: () => identity,
    // Identity observation is read-only. Cancelling it cannot change custody
    // or command outcome, and queryWindowsProcess still bounds the exact query
    // child it had already spawned.
    cancelObservation: () => observationController.abort()
  });
}

/**
 * Chooses a safe termination mechanism. Only a fresh SAME_PROCESS comparison
 * authorizes taskkill. Every other observation falls back to the exact live
 * ChildProcess handle and the caller's bounded close wait.
 */
async function requestTermination(
  child,
  {
    platform,
    spawnTerminator,
    inspectProcess,
    identityState,
    hasLifecycleEnded,
    deadlineAt,
    now,
    schedule,
    cancelSchedule,
    isSettled,
    terminationState,
    onHelperSettled,
    terminationSignal
  }
) {
  // The caller's terminal timer remains the authority for this request. Once
  // its grace expires, do not begin another destructive action merely because
  // an asynchronous identity observation completed late.
  // A fresh comparison below is the only identity observation that can still
  // authorize taskkill, so the initial capture query is no longer useful once
  // forced termination starts.
  identityState.cancelObservation();
  const canRequestExactHandle = () =>
    !terminationSignal?.aborted &&
    !isSettled() &&
    !hasLifecycleEnded() &&
    remainingMs(deadlineAt, now) > 0;
  if (!canRequestExactHandle()) {
    return Object.freeze({ cancel: () => {} });
  }
  if (platform !== "win32" || !validPid(child?.pid)) {
    requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  const identity = identityState.getIdentity();
  if (!identity) {
    if (canRequestExactHandle()) requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  // Reserve some of the fixed proof-of-death grace for the exact handle if a
  // fresh PID+StartTime comparison does not authorize taskkill in time.
  const authorizationDeadlineAt = taskkillAuthorizationDeadlineAt(deadlineAt, now);
  const comparison = await compareIdentityBeforeTaskkill(identity, {
    inspectProcess,
    platform,
    deadlineAt: authorizationDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (
    !canRequestExactHandle() ||
    comparison.status !== PROCESS_IDENTITY_MATCH.SAME_PROCESS
  ) {
    if (canRequestExactHandle()) requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }
  if (remainingMs(authorizationDeadlineAt, now) <= 0) {
    if (canRequestExactHandle()) requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  // A fake or unusual spawn adapter can synchronously deliver target events
  // while it creates taskkill. Treat that tiny interval as helper activity so
  // the target close handler cannot report safe handoff before we arm the
  // helper watcher.
  terminationState.taskkillLaunching = true;
  // The fresh comparison above is deliberately the final asynchronous step
  // before this PID-based tree kill.
  const launch = spawnTaskkillHelper(spawnTerminator, child.pid);
  if (launch.error) {
    terminationState.taskkillLaunching = false;
    if (canRequestExactHandle()) requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  terminationState.taskkillLaunching = false;
  terminationState.taskkillLaunched = true;
  terminationState.taskkillHelperCloseProven = false;

  const watcher = superviseTaskkillHelper(launch.helper, {
    stopDeadlineAt: authorizationDeadlineAt,
    closeDeadlineAt: deadlineAt,
    now,
    schedule,
    cancelSchedule,
    terminationSignal,
    onFailure: () => {
      // The helper's own subdeadline has just expired or failed. If the
      // command's final result has not been reported yet, the exact handle is
      // still the safe liveness fallback even if timer dispatch is a little
      // late; `settle()` cancels this watcher before any post-result callback.
      if (!terminationSignal?.aborted && !hasLifecycleEnded() && !isSettled()) {
        requestExactHandleTermination(child);
      }
    },
    onSettled: (helperResult) => {
      terminationState.taskkillHelper = helperResult;
      terminationState.taskkillHelperCloseProven = helperResult.closeProven === true;
      try {
        onHelperSettled?.(helperResult);
      } catch {
        // The main lifecycle remains authoritative.
      }
    }
  });
  return Object.freeze({ cancel: watcher.cancel });
}

/**
 * Runs one external command under a finite deadline and a finite output limit.
 *
 * Resolves with { stdout, stderr, exitCode } only when the exact child closed
 * with the expected status. Every other path rejects with a
 * SupervisedProcessError that states whether termination was proven and whether
 * side effects remain unproven.
 */
export function runSupervisedProcess(
  command,
  args,
  {
    cwd,
    env,
    maxOutputBytes,
    timeoutMs,
    terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
    platform = process.platform,
    spawnProcess = spawn,
    spawnTerminator = spawn,
    inspectProcess = inspectProcessIdentity,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
    now = Date.now,
    describeCommand = () => command + " " + args.join(" "),
    encoding = "utf8",
    onSpawned,
    abortSignal
  } = {}
) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new SupervisedProcessError("Supervised process was cancelled before spawn.", {
        code: "supervised_process_cancelled",
        reason: "cancelled"
      }));
      return;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      reject(new SupervisedProcessError("Supervised process timeout is invalid.", {
        code: "supervised_process_timeout_invalid"
      }));
      return;
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      reject(new SupervisedProcessError("Supervised process output limit is invalid.", {
        code: "supervised_process_output_limit_invalid"
      }));
      return;
    }
    if (!Number.isSafeInteger(terminationTimeoutMs) || terminationTimeoutMs <= 0) {
      reject(new SupervisedProcessError("Supervised process termination timeout is invalid.", {
        code: "supervised_process_timeout_invalid"
      }));
      return;
    }
    // Validated before the child exists, so an unsupported encoding can never
    // leave a started process behind.
    if (encoding !== "utf8" && encoding !== "buffer") {
      reject(new SupervisedProcessError("Supervised process output encoding is invalid.", {
        code: "supervised_process_encoding_invalid"
      }));
      return;
    }

    const startedAt = now();
    const executionDeadlineAt = startedAt + timeoutMs;
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new SupervisedProcessError("Failed to start " + describeCommand() + ".", {
        code: "supervised_process_spawn_failed",
        cause: error
      }));
      return;
    }

    const stdout = [];
    const stderr = [];
    let captured = 0;
    let settled = false;
    let interruption;
    let executionTimer;
    let terminalTimer;
    let abortListener;
    let cancelTermination = () => {};
    let terminationController;
    let exitObserved = false;
    let closeObserved = false;
    let identityState = Object.freeze({
      getIdentity: () => undefined,
      cancelObservation: () => {}
    });
    const terminationState = {
      taskkillLaunching: false,
      taskkillLaunched: false,
      taskkillHelperCloseProven: false,
      taskkillHelper: undefined
    };

    // Two distinct views of the same captured bytes. `output` is what callers
    // receive and must preserve exact bytes under "buffer"; `text` is only ever
    // interpolated into human-readable error messages and is always a string.
    const output = (chunks) =>
      encoding === "buffer" ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8").trim();
    const text = (chunks) => Buffer.concat(chunks).toString("utf8").trim();
    const hasLifecycleEnded = () => exitObserved || closeObserved;

    // Exactly one settlement. Both deadlines are always cancelled.
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cancelSchedule(executionTimer);
      cancelSchedule(terminalTimer);
      if (abortListener) abortSignal?.removeEventListener?.("abort", abortListener);
      terminationController?.abort();
      cancelTermination();
      identityState.cancelObservation();
      if (error) reject(error);
      else resolve(value);
    };

    const failInterrupted = () => {
      const targetTerminationProven = closeObserved;
      const taskkillHelperQuiescenceProven =
        (!terminationState.taskkillLaunching && !terminationState.taskkillLaunched) ||
        terminationState.taskkillHelperCloseProven === true;
      const terminationProven = targetTerminationProven && taskkillHelperQuiescenceProven;
      settle(new SupervisedProcessError(
        interruption.message + " (" + describeCommand() + ")",
        {
          code: interruption.code,
          reason: interruption.reason,
          stdout: output(stdout),
          stderr: output(stderr),
          // Interrupting a command never proves it had no effect.
          sideEffectsUnproven: true,
          terminationProven,
          targetTerminationProven,
          taskkillHelperQuiescenceProven,
          taskkillHelper: terminationState.taskkillHelper
        }
      ));
    };
    const finishInterruptedWhenQuiescent = () => {
      if (!interruption || !closeObserved || settled) return;
      if (
        (terminationState.taskkillLaunching || terminationState.taskkillLaunched) &&
        terminationState.taskkillHelperCloseProven !== true
      ) return;
      failInterrupted();
    };

    // The useful-work deadline is absolute. Once an interruption is observed,
    // forced termination starts with one fixed proof-of-death grace regardless
    // of whether the interruption happened just before or at that deadline.
    const interrupt = (code, reason, message) => {
      if (settled || interruption) return;
      const currentTime = now();
      const terminationDeadlineAt = currentTime + terminationTimeoutMs;
      terminationController = new AbortController();
      interruption = { code, reason, message, terminationDeadlineAt };
      cancelSchedule(executionTimer);

      terminalTimer = schedule(
        () => failInterrupted(),
        remainingMs(terminationDeadlineAt, now)
      );
      void requestTermination(child, {
        platform,
        spawnTerminator,
        inspectProcess,
        identityState,
        hasLifecycleEnded,
        deadlineAt: terminationDeadlineAt,
        now,
        schedule,
        cancelSchedule,
        isSettled: () => settled,
        terminationState,
        onHelperSettled: () => finishInterruptedWhenQuiescent(),
        terminationSignal: terminationController.signal
      }).then(
        (termination) => {
          if (settled) termination.cancel();
          else {
            cancelTermination = termination.cancel;
            finishInterruptedWhenQuiescent();
          }
        },
        () => {
          if (
            !terminationController?.signal.aborted &&
            !settled &&
            !hasLifecycleEnded() &&
            remainingMs(terminationDeadlineAt, now) > 0
          ) {
            requestExactHandleTermination(child);
          }
          finishInterruptedWhenQuiescent();
        }
      );
    };

    const capture = (chunks, chunk) => {
      if (settled || interruption) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      captured += buffer.length;
      if (captured > maxOutputBytes) {
        interrupt(
          "supervised_process_output_overflow",
          "output-overflow",
          "Output exceeded the capture limit of " + maxOutputBytes + " bytes"
        );
        return;
      }
      chunks.push(buffer);
    };

    // These lifecycle listeners are armed synchronously after spawn. `exit`
    // is diagnostic only; `close` is terminal proof.
    child.once?.("exit", () => {
      exitObserved = true;
      identityState.cancelObservation();
    });
    child.once?.("error", (error) => {
      if (interruption) {
        interruption.childError = error;
        return;
      }
      settle(new SupervisedProcessError("Failed to run " + describeCommand() + ".", {
        code: "supervised_process_spawn_failed",
        cause: error,
        stdout: output(stdout),
        stderr: output(stderr)
      }));
    });
    child.once?.("close", (exitCode, signal) => {
      closeObserved = true;
      identityState.cancelObservation();
      if (interruption) {
        // The child closed after we asked it to die: termination is proven,
        // the failure is deterministic, side effects remain unproven. A
        // launched taskkill helper still needs its own exact close proof.
        finishInterruptedWhenQuiescent();
        return;
      }
      if (exitCode !== 0) {
        settle(new SupervisedProcessError(
          describeCommand() + " failed with exit code " + String(exitCode) +
            (text(stderr) ? ": " + text(stderr) : "."),
          {
            code: "supervised_process_failed",
            reason: "nonzero-exit",
            stdout: output(stdout),
            stderr: output(stderr),
            exitCode,
            signal
          }
        ));
        return;
      }
      settle(undefined, Object.freeze({ stdout: output(stdout), stderr: output(stderr), exitCode }));
    });
    child.stdout?.on?.("data", (chunk) => capture(stdout, chunk));
    child.stderr?.on?.("data", (chunk) => capture(stderr, chunk));
    child.stdout?.once?.("error", (error) => {
      interrupt("supervised_process_failed", "stdout-error", "stdout failed: " + error.message);
    });
    child.stderr?.once?.("error", (error) => {
      interrupt("supervised_process_failed", "stderr-error", "stderr failed: " + error.message);
    });

    identityState = captureDurableIdentity(child, {
      platform,
      inspectProcess,
      hasLifecycleEnded,
      executionDeadlineAt,
      now
    });

    // Deadline timers stay referenced: an orchestration command that is still
    // deciding a custody outcome must keep the runtime alive.
    executionTimer = schedule(() => {
      interrupt(
        "supervised_process_timeout",
        "timeout",
        "Did not finish within " + Math.round(timeoutMs / 1000) + " seconds"
      );
    }, remainingMs(executionDeadlineAt, now));

    abortListener = () => {
      interrupt(
        "supervised_process_cancelled",
        "cancelled",
        "Supervised process was cancelled"
      );
    };
    if (abortSignal?.aborted) abortListener();
    else abortSignal?.addEventListener?.("abort", abortListener, { once: true });

    // Handed the exact spawned child so a caller can capture its durable
    // identity. Invoked after the listeners and deadline are armed, and never
    // awaited here: bounding the command must not wait on the caller.
    if (typeof onSpawned === "function") {
      try {
        onSpawned(child);
      } catch {
        // The caller owns reporting its own failure.
      }
    }
  });
}
