import { spawn } from "node:child_process";

/**
 * One supervised external process.
 *
 * Orchestration-owned external commands (currently Git) share this primitive so
 * bounded execution, output limits, termination and proof-of-death are not
 * re-implemented per call site with scattered setTimeout/kill logic.
 *
 * Lifecycle:
 *
 *   spawn exact child
 *       |
 *   bounded execution
 *       |
 *       +-- close -> result
 *       |
 *       +-- timeout / overflow
 *                |
 *                v
 *          termination requested (exact handle / exact PID tree)
 *                |
 *                v
 *          bounded terminal wait
 *                |
 *                +-- close observed -> deterministic failure
 *                `-- no close       -> fail closed, side effects unproven
 *
 * The same conservative rules already used for the Claude child apply here:
 * only `close` is terminal proof, only the exact spawned process (or its PID
 * tree) is terminated, a process is never killed by name, every deadline timer
 * stays referenced, and the returned Promise always settles exactly once.
 */

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

/**
 * Terminates exactly the supplied child. On Windows a mutating command can
 * spawn helper processes (Git hooks, filters, pagers), so the PID tree of that
 * exact PID is targeted with taskkill. No process is ever matched by name.
 */
function requestTermination(child, { platform, spawnTerminator, terminationTimeoutMs, schedule, cancelSchedule }) {
  const pid = child?.pid;
  if (platform === "win32" && Number.isSafeInteger(pid) && pid > 0) {
    let terminator;
    try {
      terminator = spawnTerminator("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      // Fall back to the direct handle below.
      terminator = undefined;
    }
    if (terminator && typeof terminator.once === "function") {
      // The terminator itself is bounded so a wedged taskkill cannot hang us.
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        cancelSchedule(timer);
      };
      timer = schedule(() => {
        try {
          terminator.kill?.();
        } catch {
          // Already gone.
        }
        finish();
      }, terminationTimeoutMs);
      terminator.once("error", finish);
      terminator.once("close", finish);
      // Lets the caller drop this deadline once the run itself has settled, so
      // a finished command never holds the event loop open waiting on taskkill.
      return finish;
    }
  }

  try {
    child?.kill?.();
  } catch {
    // The child may already have exited.
  }
  return () => {};
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
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
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
    // Set when we asked the process to die; the run can then only fail.
    let interruption;
    let executionTimer;
    let terminalTimer;
    let cancelTermination = () => {};

    const text = (chunks) => Buffer.concat(chunks).toString("utf8").trim();

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
    // Only `close` proves the child and its stdio ended.
    const interrupt = (code, reason, message) => {
      if (settled || interruption) return;
      interruption = { code, reason, message };
      cancelSchedule(executionTimer);
      cancelTermination = requestTermination(child, {
        platform,
        spawnTerminator,
        terminationTimeoutMs,
        schedule,
        cancelSchedule
      });
      terminalTimer = schedule(() => failInterrupted(false), terminationTimeoutMs);
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

    child.stdout?.on?.("data", (chunk) => capture(stdout, chunk));
    child.stderr?.on?.("data", (chunk) => capture(stderr, chunk));

    child.once?.("error", (error) => {
      settle(new SupervisedProcessError("Failed to run " + describeCommand() + ".", {
        code: "supervised_process_spawn_failed",
        cause: error,
        stdout: text(stdout),
        stderr: text(stderr),
        sideEffectsUnproven: Boolean(interruption)
      }));
    });

    child.once?.("close", (exitCode, signal) => {
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

    // Handed the exact spawned child so a caller can capture its durable
    // identity. Invoked after the listeners and before the deadline, and never
    // awaited here: bounding the command must not wait on the caller.
    if (typeof onSpawned === "function") {
      try {
        onSpawned(child);
      } catch {
        // The caller owns reporting its own failure.
      }
    }

    // Deadline timers stay referenced: an orchestration command that is still
    // deciding a custody outcome must keep the runtime alive.
    executionTimer = schedule(() => {
      interrupt(
        "supervised_process_timeout",
        "timeout",
        "Did not finish within " + Math.round(timeoutMs / 1000) + " seconds"
      );
    }, timeoutMs);
  });
}
