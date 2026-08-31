import { spawn } from "node:child_process";
import {
  PROCESS_IDENTITY_MATCH,
  PROCESS_IDENTITY_STATUS,
  compareProcessIdentity,
  inspectProcessIdentity,
  validateDurableProcessIdentity
} from "./process-identity.mjs";

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
 */

// Explicit close-proof grace after the command's absolute execution deadline.
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
    // True only when the exact child was observed to close after termination.
    this.terminationProven = options.terminationProven === true;
  }
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function remainingMs(deadlineAt, now) {
  return Math.max(0, deadlineAt - now());
}

/**
 * Observations themselves are fallible. This bounded race never turns a late
 * or failed identity query into a positive identity match.
 */
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

/**
 * Starts the initial identity observation without delaying command execution.
 * If the exact ChildProcess emits exit or close before the query completes, the
 * observation is discarded. A later fresh comparison is still required before
 * Windows taskkill.
 */
function captureDurableIdentity(child, { platform, inspectProcess, hasLifecycleEnded }) {
  let identity;
  if (platform !== "win32" || !validPid(child?.pid)) {
    return Object.freeze({ getIdentity: () => identity });
  }

  const pid = child.pid;
  void Promise.resolve()
    .then(() => inspectProcess(pid, { platform }))
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

  return Object.freeze({ getIdentity: () => identity });
}

function requestExactHandleTermination(child) {
  let killError;
  child?.stdin?.once?.("error", () => {});
  try {
    child?.stdin?.end?.();
  } catch {
    // The input stream may already be closed.
  }
  try {
    child?.stdin?.destroy?.();
  } catch {
    // The input stream may not be destroyable.
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

/**
 * Keeps the taskkill helper bounded independently of the supervised child.
 * Its result is diagnostic only: exact child `close` remains the sole terminal
 * proof for the command itself.
 */
function watchTerminator(terminator, { deadlineAt, now, schedule, cancelSchedule }) {
  if (!terminator || typeof terminator.once !== "function") {
    return Object.freeze({ cancel: () => {}, getResult: () => ({ status: "spawn-failed" }) });
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
    if (settled) return;
    try {
      terminator.kill?.();
    } catch {
      // The terminator may already have exited.
    }
    finish({ status });
  };

  terminator.once("error", (error) => finish({ status: "error", error }));
  terminator.once("close", (code, signal) => {
    finish({ status: code === 0 ? "completed" : "failed", code, signal });
  });
  const timeoutMs = remainingMs(deadlineAt, now);
  if (timeoutMs <= 0) {
    stop("timeout");
  } else {
    timer = schedule(() => stop("timeout"), timeoutMs);
  }

  return Object.freeze({
    cancel: () => stop("cancelled"),
    getResult: () => result
  });
}

async function compareBeforeTaskkill(
  identity,
  { inspectProcess, platform, deadlineAt, now, schedule, cancelSchedule }
) {
  const queryBudgetMs = remainingMs(deadlineAt, now);
  if (queryBudgetMs <= 0) {
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-timeout"
    });
  }

  const comparison = compareProcessIdentity(identity, {
    inspectProcess: (pid) => inspectProcess(pid, {
      platform,
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
    isSettled
  }
) {
  if (platform !== "win32" || !validPid(child?.pid)) {
    requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  const identity = identityState.getIdentity();
  if (!identity || hasLifecycleEnded() || isSettled()) {
    requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  const comparison = await compareBeforeTaskkill(identity, {
    inspectProcess,
    platform,
    deadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (
    isSettled() ||
    hasLifecycleEnded() ||
    comparison.status !== PROCESS_IDENTITY_MATCH.SAME_PROCESS
  ) {
    if (!isSettled()) requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  let terminator;
  try {
    // The fresh comparison above is deliberately the final asynchronous step
    // before this PID-based tree kill.
    terminator = spawnTerminator(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" }
    );
  } catch {
    requestExactHandleTermination(child);
    return Object.freeze({ cancel: () => {} });
  }

  const watcher = watchTerminator(terminator, {
    deadlineAt,
    now,
    schedule,
    cancelSchedule
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
    onSpawned
  } = {}
) {
  return new Promise((resolve, reject) => {
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
    let cancelTermination = () => {};
    let exitObserved = false;
    let closeObserved = false;

    const text = (chunks) => Buffer.concat(chunks).toString("utf8").trim();
    const hasLifecycleEnded = () => exitObserved || closeObserved;

    // Exactly one settlement. Both deadlines are always cancelled.
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cancelSchedule(executionTimer);
      cancelSchedule(terminalTimer);
      cancelTermination();
      if (error) reject(error);
      else resolve(value);
    };

    const failInterrupted = (terminationProven) => {
      settle(new SupervisedProcessError(
        interruption.message + " (" + describeCommand() + ")",
        {
          code: interruption.code,
          reason: interruption.reason,
          stdout: text(stdout),
          stderr: text(stderr),
          // Interrupting a command never proves it had no effect.
          sideEffectsUnproven: true,
          terminationProven
        }
      ));
    };

    // Ask the exact child to die, then wait a bounded time for its `close`.
    // The main deadline is absolute. An interruption before it may use only
    // its remaining time; an interruption at the deadline receives the small,
    // explicit termination safety grace.
    const interrupt = (code, reason, message) => {
      if (settled || interruption) return;
      const currentTime = now();
      const terminationDeadlineAt = currentTime < executionDeadlineAt
        ? Math.min(executionDeadlineAt, currentTime + terminationTimeoutMs)
        : currentTime + terminationTimeoutMs;
      interruption = { code, reason, message, terminationDeadlineAt };
      cancelSchedule(executionTimer);

      terminalTimer = schedule(
        () => failInterrupted(false),
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
        isSettled: () => settled
      }).then(
        (termination) => {
          if (settled) termination.cancel();
          else cancelTermination = termination.cancel;
        },
        () => {
          if (!settled) requestExactHandleTermination(child);
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
    });
    child.once?.("error", (error) => {
      if (interruption) {
        interruption.childError = error;
        return;
      }
      settle(new SupervisedProcessError("Failed to run " + describeCommand() + ".", {
        code: "supervised_process_spawn_failed",
        cause: error,
        stdout: text(stdout),
        stderr: text(stderr)
      }));
    });
    child.once?.("close", (exitCode, signal) => {
      closeObserved = true;
      if (interruption) {
        // The child closed after we asked it to die: termination is proven,
        // the failure is deterministic, side effects remain unproven.
        failInterrupted(true);
        return;
      }
      if (exitCode !== 0) {
        settle(new SupervisedProcessError(
          describeCommand() + " failed with exit code " + String(exitCode) +
            (text(stderr) ? ": " + text(stderr) : "."),
          {
            code: "supervised_process_failed",
            reason: "nonzero-exit",
            stdout: text(stdout),
            stderr: text(stderr),
            exitCode,
            signal
          }
        ));
        return;
      }
      settle(undefined, Object.freeze({ stdout: text(stdout), stderr: text(stderr), exitCode }));
    });
    child.stdout?.on?.("data", (chunk) => capture(stdout, chunk));
    child.stderr?.on?.("data", (chunk) => capture(stderr, chunk));
    child.stdout?.once?.("error", (error) => {
      interrupt("supervised_process_failed", "stdout-error", "stdout failed: " + error.message);
    });
    child.stderr?.once?.("error", (error) => {
      interrupt("supervised_process_failed", "stderr-error", "stderr failed: " + error.message);
    });

    const identityState = captureDurableIdentity(child, {
      platform,
      inspectProcess,
      hasLifecycleEnded
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
