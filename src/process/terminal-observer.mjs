import { remainingMs } from "./deadlines.mjs";

/**
 * Terminal observation for exactly one supervised ChildProcess.
 *
 * Only `close` is terminal proof. Node distinguishes the two events: `exit`
 * means the direct child ended while its stdio may still be open, which happens
 * precisely when a descendant still holds the inherited pipes; `close` means the
 * child ended and its stdio streams closed. Returning write custody on `exit`
 * alone would hand the repository to a new writer while a descendant of the old
 * one can still be writing, so `exit` is retained as a diagnostic observation
 * and never resolves the terminal promise.
 *
 * Honest scope: `close` proves the lifecycle of the exact supervised child and
 * its stdio, not that every detached descendant is dead. A transitive guarantee
 * needs process-tree containment (Job Objects), which this phase deliberately
 * does not add.
 */

function childIsAlreadyTerminal(child) {
  return Boolean(
    child &&
    ((child.exitCode !== undefined && child.exitCode !== null) ||
      (child.signalCode !== undefined && child.signalCode !== null))
  );
}

export function observeChildTerminal(child, processIdentity, { now = Date.now } = {}) {
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
 * Waits for identity-bound terminal evidence, or for the bounded deadline.
 *
 * Resolves with the close proof, or with undefined when the deadline expired or
 * termination was cancelled. Undefined means "not proven", never "still alive".
 */
export function waitForTerminalProof(
  terminalObserver,
  { deadlineAt, now = Date.now, schedule = setTimeout, cancelSchedule = clearTimeout, terminationSignal }
) {
  const alreadyTerminal = terminalObserver?.getTerminalProof?.();
  if (alreadyTerminal) return Promise.resolve(alreadyTerminal);
  if (terminationSignal?.aborted) return Promise.resolve(undefined);
  const timeoutMs = remainingMs(deadlineAt, now);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let onAbort;
    const finish = (proof) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      if (onAbort) terminationSignal?.removeEventListener?.("abort", onAbort);
      resolve(proof);
    };
    onAbort = () => finish(undefined);
    terminationSignal?.addEventListener?.("abort", onAbort, { once: true });
    if (terminationSignal?.aborted) {
      finish(undefined);
      return;
    }
    timer = schedule(() => finish(undefined), timeoutMs);
    terminalObserver?.terminalPromise?.then((proof) => finish(proof));
  });
}

/**
 * Terminal evidence for a child this coordinator spawned and watched close, but
 * whose durable PID+StartTime identity could not be captured because it died
 * first. It carries no processIdentity, so it can never be mistaken for durable
 * cross-process proof; only the live coordinator that supervised the spawn may
 * act on it, and it does not survive a restart.
 */
export function supervisedCloseProof(closeProof) {
  if (!closeProof || closeProof.event !== "close") return undefined;
  return Object.freeze({
    event: "close",
    code: closeProof.code,
    signal: closeProof.signal,
    observedAt: closeProof.observedAt,
    supervisedByCoordinator: true
  });
}
