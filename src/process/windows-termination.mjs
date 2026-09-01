import { PROCESS_IDENTITY_MATCH, compareProcessIdentity } from "../process-identity.mjs";
import { deadlineWithReserve, remainingMs, waitForPromiseUntil } from "./deadlines.mjs";

/**
 * Windows forced-termination primitives, shared by every supervised process.
 *
 * `taskkill /PID <pid> /T /F` is a PID-tree operation, so it is authorized by
 * exactly one thing: a fresh SAME_PROCESS PID+StartTime comparison taken
 * immediately before the helper is launched. Nothing here is ever matched by
 * image name, and nothing here treats a kill request as proof of death.
 *
 * Two independent proofs come out of a Windows termination and must never be
 * conflated:
 *   - the exact target ChildProcess `close` proves the supervised child ended;
 *   - the exact taskkill helper `close` proves the destructive helper quiesced.
 * A caller may hand ownership onward only when it holds both.
 *
 * This module deliberately does not import node:child_process. The decision to
 * spawn belongs to the calling supervisor, which injects its own spawn adapter;
 * what lives here is the identity gate and the bounded helper lifecycle.
 */

// Reserve of the fixed proof-of-death grace kept for the exact target handle
// when the identity gate or the helper itself does not resolve in time.
export const TASKKILL_CLOSE_RESERVE_MS = 1_000;

export function taskkillAuthorizationDeadlineAt(terminationDeadlineAt, now) {
  return deadlineWithReserve(terminationDeadlineAt, now, TASKKILL_CLOSE_RESERVE_MS);
}

/**
 * Requests termination of exactly this ChildProcess handle. Always safe: it
 * addresses a live handle this process owns rather than a PID. It is a request,
 * never proof; the caller still waits for `close`.
 */
export function requestExactHandleTermination(child) {
  let killError;
  // The caller may not have attached a stdin error listener yet, and ending or
  // destroying an already-broken pipe can emit asynchronously.
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

/**
 * The final identity gate before a PID-based tree kill.
 *
 * Every failure mode - expired budget, slow query, throwing query, malformed
 * observation - reports AMBIGUOUS, which denies taskkill. A late query result
 * can never authorize a destructive action, and the read-only query child is
 * asked to stop once its answer can no longer be used.
 */
export async function compareIdentityBeforeTaskkill(
  identity,
  { inspectProcess, platform, deadlineAt, now, schedule, cancelSchedule }
) {
  if (remainingMs(deadlineAt, now) <= 0) {
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-timeout"
    });
  }
  const queryAbortController = new AbortController();

  const comparison = compareProcessIdentity(identity, {
    inspectProcess: (pid) => inspectProcess(pid, {
      platform,
      deadlineAt,
      now,
      abortSignal: queryAbortController.signal
    })
  });
  const outcome = await waitForPromiseUntil(comparison, {
    deadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (outcome.timedOut) {
    // The query is read-only, but it should still stop its exact query child
    // once taskkill authorization no longer has time to use the answer.
    queryAbortController.abort();
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-timeout"
    });
  }
  if (outcome.error || !outcome.value) {
    queryAbortController.abort();
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: "identity-check-failed"
    });
  }
  return outcome.value;
}

const TASKKILL_TREE_ARGUMENTS = Object.freeze(["/T", "/F"]);

/**
 * Launches the destructive helper for one exact PID. The caller must have just
 * passed the identity gate; no asynchronous step may sit between the two.
 */
export function spawnTaskkillHelper(spawnTerminator, pid) {
  try {
    return Object.freeze({
      helper: spawnTerminator(
        "taskkill",
        ["/PID", String(pid), ...TASKKILL_TREE_ARGUMENTS],
        { shell: false, windowsHide: true, stdio: "ignore" }
      )
    });
  } catch (error) {
    return Object.freeze({ error });
  }
}

/**
 * Bounds the lifecycle of one taskkill helper and settles exactly once.
 *
 * Event-handling contract:
 *   - `close` is the only helper terminal proof (closeProven: true);
 *   - `exit` is diagnostic; a nonzero status may start the caller's exact-handle
 *     fallback while this watcher keeps waiting for the helper's own close;
 *   - `error` is diagnostic and first-wins;
 *   - the error listener stays attached for the helper's whole lifetime, so an
 *     error caused by our own kill() request - including one arriving after
 *     settlement - is absorbed instead of becoming an unhandled EventEmitter
 *     error;
 *   - once settled, no further event may run onFailure, onSettled, or another
 *     kill request. Late evidence cannot revive a decided lifecycle.
 *
 * A settled result with closeProven false means "helper quiescence unproven",
 * which callers must treat as fail-closed, never as helper success.
 */
export function superviseTaskkillHelper(
  helper,
  {
    stopDeadlineAt,
    closeDeadlineAt,
    now,
    schedule,
    cancelSchedule,
    onFailure,
    onSettled,
    terminationSignal
  }
) {
  const notify = (callback, value) => {
    try {
      callback?.(value);
    } catch {
      // Helper evidence is diagnostic; a caller's own failure must not
      // destabilize the termination lifecycle.
    }
  };

  if (!helper || typeof helper.on !== "function") {
    const result = Object.freeze({ status: "spawn-failed", closeProven: false });
    notify(onFailure, result);
    notify(onSettled, result);
    return Object.freeze({
      promise: Promise.resolve(result),
      getResult: () => result,
      cancel: () => result
    });
  }

  let settled = false;
  let result;
  let stopTimer;
  let closeTimer;
  let onAbort;
  let errorObservation;
  let exitObservation;
  let closeObserved = false;
  let failureReason;
  let stopRequested = false;
  let failureNotified = false;
  let resolveResult;
  const promise = new Promise((resolve) => {
    resolveResult = resolve;
  });

  const notifyFailure = (value) => {
    // A failure notification starts a destructive fallback in the caller. It is
    // a lifecycle side effect, so it is refused once this watcher has settled.
    if (failureNotified || settled) return;
    failureNotified = true;
    notify(onFailure, value);
  };
  const finish = (value) => {
    if (settled) return;
    settled = true;
    result = Object.freeze(value);
    cancelSchedule(stopTimer);
    cancelSchedule(closeTimer);
    if (onAbort) terminationSignal?.removeEventListener?.("abort", onAbort);
    resolveResult(result);
    notify(onSettled, result);
  };
  const requestStop = (reason, details = {}) => {
    if (settled) return;
    if (!failureReason) failureReason = reason;
    notifyFailure(Object.freeze({ status: reason, closeProven: false, ...details }));
    if (stopRequested) return;
    stopRequested = true;
    try {
      // Asking the helper to stop is a request. Its own close, if it arrives,
      // remains the only quiescence proof; a synchronous throw here and an
      // asynchronous error event are both recorded as diagnostics only.
      helper.kill?.();
    } catch (error) {
      if (!errorObservation) errorObservation = error;
    }
  };
  const stop = (reason) => {
    if (settled) return result;
    requestStop(reason);
    finish({
      status: failureReason || reason,
      closeProven: false,
      stopRequested,
      ...(errorObservation ? { error: errorObservation } : {}),
      ...(exitObservation ? { exitCode: exitObservation.code, exitSignal: exitObservation.signal } : {})
    });
    return result;
  };

  // Arm every helper listener before any timer or await. `on` rather than
  // `once` for error: kill() may itself make the helper emit, and a listener
  // must remain attached for the whole lifetime so that event is never
  // unhandled - including after this watcher has settled.
  helper.on("error", (error) => {
    if (!errorObservation) errorObservation = error;
    if (settled) return;
    requestStop("error", { error });
  });
  helper.on("exit", (code, signal) => {
    if (exitObservation || settled) return;
    exitObservation = { code, signal };
    // `exit` cannot prove the helper has quiesced because its stdio may still
    // be open, but a nonzero exit is enough to start the exact-target fallback
    // while we continue waiting for this helper's own `close`.
    if (code !== 0) requestStop("failed", { exitCode: code, exitSignal: signal });
  });
  helper.on("close", (code, signal) => {
    if (closeObserved || settled) return;
    closeObserved = true;
    const status = errorObservation
      ? "error"
      : failureReason || (code === 0 ? "completed" : "failed");
    const closeResult = {
      status,
      code,
      signal,
      closeProven: true,
      stopRequested,
      ...(errorObservation ? { error: errorObservation } : {}),
      ...(exitObservation ? { exitCode: exitObservation.code, exitSignal: exitObservation.signal } : {})
    };
    if (code !== 0) notifyFailure(Object.freeze(closeResult));
    finish(closeResult);
  });

  onAbort = () => stop("cancelled");
  terminationSignal?.addEventListener?.("abort", onAbort, { once: true });
  if (terminationSignal?.aborted) {
    stop("cancelled");
    return Object.freeze({ promise, getResult: () => result, cancel: () => stop("cancelled") });
  }
  const stopTimeoutMs = remainingMs(stopDeadlineAt, now);
  if (stopTimeoutMs <= 0) requestStop("timeout");
  else stopTimer = schedule(() => requestStop("timeout"), stopTimeoutMs);
  const closeTimeoutMs = remainingMs(closeDeadlineAt, now);
  if (closeTimeoutMs <= 0) stop("close-timeout");
  else closeTimer = schedule(() => stop("close-timeout"), closeTimeoutMs);

  return Object.freeze({
    promise,
    getResult: () => result,
    cancel: () => stop("cancelled")
  });
}
