import { spawn } from "node:child_process";
import {
  ClaudeTerminationUnprovenError,
  attachLifecycle
} from "./claude-errors.mjs";
import { PROCESS_IDENTITY_MATCH, inspectProcessIdentity } from "./process-identity.mjs";
import {
  deadlineWithReserve,
  isSchedulableTimeout,
  remainingMs,
  waitForPromiseUntil
} from "./process/deadlines.mjs";
import {
  observeChildTerminal,
  supervisedCloseProof,
  waitForTerminalProof
} from "./process/terminal-observer.mjs";
import {
  compareIdentityBeforeTaskkill,
  requestExactHandleTermination,
  spawnTaskkillHelper,
  superviseTaskkillHelper,
  taskkillAuthorizationDeadlineAt
} from "./process/windows-termination.mjs";

/**
 * Forced termination of one Claude child, and the custody proof it produces.
 *
 * This module answers a single question: after we asked a Claude child to die,
 * what may we honestly claim? It owns the ordering that makes the answer safe -
 * durable TERMINATING first, then the destructive request, then bounded waits
 * for both the target close and any taskkill helper close - and it never
 * invents evidence when a deadline expires. The Windows mechanics themselves
 * are the shared process/ primitives, used identically by Git supervision.
 */

// Fixed proof-of-death grace. It begins when forced termination starts
// (including the required durable transition) and never extends the
// useful-execution deadline.
export const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;
const DURABLE_TRANSITION_CLOSE_RESERVE_MS = 1_000;

function durableTransitionDeadlineAt(terminationDeadlineAt, now) {
  return deadlineWithReserve(
    terminationDeadlineAt,
    now,
    DURABLE_TRANSITION_CLOSE_RESERVE_MS
  );
}

function terminalResult(status, method, terminalProof, extras = {}) {
  return Object.freeze({ status, method, terminalProof, ...extras });
}

/**
 * A deadline race observes a Promise; it does not stop the underlying work.
 * Durable lifecycle callbacks receive this AbortSignal as a cancellation
 * request. Custody can prevent a mutation that has not reached its rename
 * boundary from publishing; a rename already issued remains serialized until
 * it settles, so later custody mutations cannot overtake it.
 */
export function startDurableLifecycleMutation(callback, processIdentity, context = {}) {
  const controller = new AbortController();
  const externalAbortSignal = context.abortSignal;
  const cancelFromExternalSignal = () => controller.abort();
  if (externalAbortSignal?.aborted) {
    cancelFromExternalSignal();
  } else {
    externalAbortSignal?.addEventListener("abort", cancelFromExternalSignal, { once: true });
  }
  const cancelledBeforeCallback = Symbol("cancelled-before-lifecycle-callback");
  let callbackStarted = false;
  const promise = Promise.resolve()
    .then(() => {
      // This check closes the gap between scheduling the lifecycle callback
      // and its first microtask. A root-stopped request must not begin a new
      // durable transition after its caller has settled.
      if (controller.signal.aborted) return cancelledBeforeCallback;
      callbackStarted = true;
      return callback?.(processIdentity, {
        mutationSignal: controller.signal,
        executionDeadlineAt: context.executionDeadlineAt,
        terminationDeadlineAt: context.terminationDeadlineAt
      });
    })
    .then(
      (value) => value === cancelledBeforeCallback
        ? Object.freeze({ kind: "cancelled" })
        : Object.freeze({ kind: "completed", value }),
      (error) => Object.freeze({ kind: "failed", error })
    )
    .finally(() => externalAbortSignal?.removeEventListener("abort", cancelFromExternalSignal));
  return Object.freeze({
    promise,
    requestCancellation: () => {
      controller.abort();
      externalAbortSignal?.removeEventListener("abort", cancelFromExternalSignal);
    },
    hasStarted: () => callbackStarted
  });
}

async function terminateWithExactHandle(
  child,
  terminalObserver,
  { deadlineAt, now, schedule, cancelSchedule, extras = {}, terminationSignal }
) {
  const existingProof = terminalObserver?.getTerminalProof?.();
  if (existingProof) return terminalResult("already-terminal", "none", existingProof, extras);
  // Do not begin a new destructive request after the fixed termination grace
  // has ended. A request made earlier may still be awaiting close proof, but a
  // late caller must report that proof as unproven rather than revive work.
  if (terminationSignal?.aborted || remainingMs(deadlineAt, now) <= 0) {
    return terminalResult("termination-unproven", "child-kill", undefined, extras);
  }
  // An `exit` is not terminal proof, but it does establish that the direct
  // child handle is no longer live. Do not turn that diagnostic into another
  // kill request; continue the bounded wait for its eventual `close` instead.
  const request = terminalObserver?.getExitObservation?.()
    ? Object.freeze({ requested: false, alreadyExited: true })
    : requestExactHandleTermination(child);
  const proof = await waitForTerminalProof(terminalObserver, {
    deadlineAt,
    now,
    schedule,
    cancelSchedule,
    terminationSignal
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
 * bounded terminal evidence.
 *
 * Two independent gates guard the PID-based `taskkill` helper, and both must
 * pass. The durable gate is `destructiveHelperAuthorized`, decided by the
 * caller before any of this runs. The identity gate is a fresh SAME_PROCESS
 * comparison taken immediately before launch. If identity is absent, dead,
 * reused, or ambiguous - or if the durable gate is closed - the exact in-memory
 * handle is the only safe termination request.
 */
export async function terminateClaudeChild(
  child,
  {
    platform = process.platform,
    spawnTerminator = spawn,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
    terminationTimeoutMs = PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    terminationDeadlineAt: suppliedTerminationDeadlineAt,
    terminationSignal,
    // Internal lifecycle context lets an outer bounded observer distinguish a
    // taskkill helper that was launched from a direct-handle-only attempt.
    terminationContext,
    terminalObserver = observeChildTerminal(child, undefined),
    processIdentity,
    // The durable gate. False means a durable ownership record governs this
    // child but has not published TERMINATING, so no PID-based helper may be
    // created. It defaults to true because a caller with no durable ownership
    // record has nothing that could later be misreconciled; the one production
    // path that does own a record is terminateStartedChild, which decides this
    // from the record's own publication outcome.
    destructiveHelperAuthorized = true,
    inspectProcess = inspectProcessIdentity,
    now = Date.now
  } = {}
) {
  if (!isSchedulableTimeout(terminationTimeoutMs)) {
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
  if (terminationSignal?.aborted) {
    return terminalResult("termination-unproven", "none", undefined, {
      reason: "termination-cancelled"
    });
  }

  const terminationDeadlineAt = Number.isFinite(suppliedTerminationDeadlineAt)
    ? suppliedTerminationDeadlineAt
    : now() + terminationTimeoutMs;
  const validPid = Number.isSafeInteger(child?.pid) && child.pid > 0;
  if (platform !== "win32" || !validPid) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal
    });
  }

  if (!processIdentity) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal,
      extras: {
        identityStatus: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
        reason: "process-identity-unavailable"
      }
    });
  }

  // The durable gate, checked before the identity gate so a denied termination
  // spends none of its proof-of-death grace on a query it could not act on.
  //
  // A taskkill helper is a detached process whose lifecycle only this
  // coordinator's memory tracks; it has no durable identity. If one were
  // launched while the durable record still said ACTIVE and this coordinator
  // then died, a later coordinator would read ACTIVE with a dead Claude and
  // could legitimately release the repository while that helper was still
  // running. Requiring a published TERMINATING first is what makes the ACTIVE
  // reconciliation path safe. The exact in-memory handle stays available: it
  // addresses a handle this process owns and creates no such helper.
  if (!destructiveHelperAuthorized) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal,
      extras: {
        taskkillStatus: "unauthorized",
        reason: "durable-termination-not-published"
      }
    });
  }

  // Leave part of the proof-of-death grace for an exact-handle request if the
  // fresh PID check cannot authorize taskkill. This is only an authorization
  // subdeadline; all terminal evidence still uses terminationDeadlineAt.
  const authorizationDeadlineAt = taskkillAuthorizationDeadlineAt(terminationDeadlineAt, now);
  const identityMatch = await compareIdentityBeforeTaskkill(processIdentity, {
    inspectProcess,
    deadlineAt: authorizationDeadlineAt,
    now,
    schedule,
    cancelSchedule
  });
  if (terminationSignal?.aborted) {
    return terminalResult("termination-unproven", "none", undefined, {
      reason: "termination-cancelled",
      identityStatus: identityMatch.status
    });
  }
  if (identityMatch.status !== PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal,
      extras: {
        identityStatus: identityMatch.status,
        ...(identityMatch.reason ? { reason: identityMatch.reason } : {})
      }
    });
  }
  if (remainingMs(authorizationDeadlineAt, now) <= 0) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal,
      extras: {
        identityStatus: identityMatch.status,
        reason: "taskkill-authorization-window-expired"
      }
    });
  }

  // No await follows the comparison before taskkill: it is the final identity
  // check for this PID-based operation.
  const launch = spawnTaskkillHelper(spawnTerminator, child.pid);
  if (launch.error) {
    return await terminateWithExactHandle(child, terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal,
      extras: { taskkillStatus: "spawn-threw", error: launch.error }
    });
  }

  if (terminationContext) {
    terminationContext.taskkillLaunched = true;
    terminationContext.taskkillHelperCloseProven = false;
  }

  const taskkill = superviseTaskkillHelper(launch.helper, {
    stopDeadlineAt: authorizationDeadlineAt,
    closeDeadlineAt: terminationDeadlineAt,
    now,
    schedule,
    cancelSchedule,
    terminationSignal,
    onFailure: () => {
      if (!terminationSignal?.aborted && !terminalObserver.getTerminalProof?.()) {
        requestExactHandleTermination(child);
      }
    },
    onSettled: (helperResult) => {
      if (!terminationContext) return;
      terminationContext.taskkillHelper = helperResult;
      terminationContext.taskkillHelperCloseProven = helperResult.closeProven === true;
    }
  });
  const [proof, taskkillResult] = await Promise.all([
    waitForTerminalProof(terminalObserver, {
      deadlineAt: terminationDeadlineAt,
      now,
      schedule,
      cancelSchedule,
      terminationSignal
    }),
    taskkill.promise
  ]);
  const helperQuiescenceProven = taskkillResult?.closeProven === true;
  const helperEvidence = {
    taskkillStatus: taskkillResult?.status || "close-unproven",
    taskkillHelper: taskkillResult,
    taskkillHelperQuiescenceProven: helperQuiescenceProven
  };
  if (proof && helperQuiescenceProven) {
    return terminalResult(
      taskkillResult?.status === "completed" ? "terminated" : "already-terminal",
      "taskkill",
      proof,
      helperEvidence
    );
  }
  return terminalResult(
    "termination-unproven",
    "taskkill",
    undefined,
    {
      ...helperEvidence,
      helperQuiescenceUnproven: !helperQuiescenceProven,
      targetTerminalProofObserved: Boolean(proof)
    }
  );
}

/**
 * Stops a Claude child that has already started, and returns the error the
 * delegation should report - either the original failure enriched with terminal
 * proof, or a ClaudeTerminationUnprovenError that keeps custody retained.
 */
export async function terminateStartedChild({
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
}) {
  // Forced termination begins here, not after durable bookkeeping returns.
  // The transition and every subsequent kill/close wait share this one fixed
  // proof-of-death deadline, so slow bookkeeping cannot silently buy a second
  // full termination interval. A small explicit reserve leaves time to make
  // the exact ChildProcess request if the transition hangs.
  const terminationDeadlineAt = now() + terminationTimeoutMs;
  const transitionDeadlineAt = durableTransitionDeadlineAt(terminationDeadlineAt, now);
  let durableTransition = Object.freeze({ status: "not-required" });
  if (processIdentity && onTerminationStarted) {
    const mutation = startDurableLifecycleMutation(onTerminationStarted, processIdentity, {
      executionDeadlineAt,
      terminationDeadlineAt,
      abortSignal
    });
    const transitionOutcome = await waitForPromiseUntil(
      Promise.race([
        mutation.promise,
        terminalObserver.terminalPromise.then((terminalProof) => Object.freeze({ kind: "close", terminalProof })),
        terminalObserver.errorPromise.then((observation) => Object.freeze({ kind: "child-error", observation }))
      ]),
      { deadlineAt: transitionDeadlineAt, now, schedule, cancelSchedule }
    );
    if (transitionOutcome.timedOut) {
      mutation.requestCancellation();
      // A deadline can request cancellation after the custody mutation has
      // already issued its rename. Do not claim pre-publication authority was
      // invalidated unless the custody implementation can prove that fact.
      durableTransition = Object.freeze({ status: "timed-out", cancellationRequested: true });
    } else if (transitionOutcome.error) {
      mutation.requestCancellation();
      durableTransition = Object.freeze({ status: "failed", error: transitionOutcome.error });
    } else if (transitionOutcome.value?.kind === "completed") {
      durableTransition = Object.freeze({ status: "completed" });
    } else if (transitionOutcome.value?.kind === "failed") {
      durableTransition = Object.freeze({ status: "failed", error: transitionOutcome.value.error });
    } else if (transitionOutcome.value?.kind === "cancelled") {
      durableTransition = Object.freeze({ status: "cancelled", cancellationRequested: true });
    } else if (transitionOutcome.value?.kind === "close") {
      mutation.requestCancellation();
      durableTransition = Object.freeze({
        status: mutation.hasStarted() ? "terminal-close-won" : "not-started",
        transitionStarted: mutation.hasStarted(),
        cancellationRequested: true
      });
      const terminationResult = terminalResult("already-terminal", "none", transitionOutcome.value.terminalProof, {
        durableTransition
      });
      return attachLifecycle(originalError, {
        processIdentity,
        terminalProof: transitionOutcome.value.terminalProof,
        terminationResult,
        processStarted: true
      });
    } else {
      mutation.requestCancellation();
      durableTransition = Object.freeze({
        status: "child-error",
        error: transitionOutcome.value?.observation?.error
      });
    }
  }

  // The durable transition has completed, failed, or received a cancellation
  // request. A pre-publication custody mutation then cannot publish; an
  // already-issued rename remains serialized and must quiesce before any later
  // custody release or admission can proceed. The exact child may now receive
  // a termination request using the remaining time from the same deadline.
  //
  // Whether that request may escalate to a PID-based taskkill helper is decided
  // here, and only here. Exactly two outcomes authorize it:
  //
  //   "not-required"  no durable ownership record governs this child, so there
  //                   is no record a crash could strand in a releasable state;
  //   "completed"     the custody callback resolved, which for a durable writer
  //                   means TERMINATING is on disk (beginTermination either
  //                   published it or found the record already TERMINATING).
  //
  // Every other outcome - failed, timed out, cancelled before publication, or
  // raced by a child error - leaves publication unproven. Unproven is treated
  // exactly like failed: no detached helper may be created, because a crash
  // could then leave a durable ACTIVE record that reconciliation may release
  // while the helper is still running. This is the ordering that keeps the
  // ACTIVE + coordinator-dead + Claude-dead reconciliation path safe.
  const destructiveHelperAuthorized =
    durableTransition.status === "not-required" || durableTransition.status === "completed";
  const terminationController = new AbortController();
  const terminationContext = {
    taskkillLaunched: false,
    taskkillHelperCloseProven: false
  };
  const pendingTermination = Promise.resolve().then(() => terminateChild(child, {
    processIdentity,
    terminalObserver,
    terminationTimeoutMs,
    terminationDeadlineAt,
    terminationSignal: terminationController.signal,
    terminationContext,
    destructiveHelperAuthorized,
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
  const helperTimeoutEvidence = terminationContext.taskkillLaunched
    ? {
        taskkillLaunched: true,
        taskkillHelper: terminationContext.taskkillHelper,
        taskkillHelperQuiescenceProven:
          terminationContext.taskkillHelperCloseProven === true,
        helperQuiescenceUnproven: terminationContext.taskkillHelperCloseProven !== true
      }
    : {};
  if (terminationOutcome.timedOut) {
    // The default supervisor requests a stop of any still-live taskkill helper
    // before reporting this bounded unproven result; without helper `close`,
    // that request is not quiescence proof. Injected adapters also receive this
    // signal and must not begin a new destructive action after it.
    terminationController.abort();
    terminationResult = terminalResult("termination-unproven", "none", undefined, {
      reason: "termination-timeout",
      durableTransition,
      destructiveHelperAuthorized,
      ...helperTimeoutEvidence
    });
  } else if (terminationOutcome.error) {
    terminationController.abort();
    terminationResult = terminalResult("termination-unproven", "none", undefined, {
      error: terminationOutcome.error,
      durableTransition,
      destructiveHelperAuthorized,
      ...helperTimeoutEvidence
    });
  } else {
    terminationResult = Object.freeze({
      ...terminationOutcome.value,
      durableTransition,
      destructiveHelperAuthorized
    });
  }

  const helperQuiescenceUnproven =
    terminationResult?.helperQuiescenceUnproven === true ||
    (terminationContext.taskkillLaunched && terminationContext.taskkillHelperCloseProven !== true);
  // A target close does not authorize writer handoff while a launched taskkill
  // helper may still be running. Keep its proof separate and fail closed until
  // the helper's exact close has also been observed.
  const terminalProof = helperQuiescenceUnproven
    ? undefined
    : terminationResult?.terminalProof || terminalObserver.getTerminalProof?.();
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
    lateRecoveryAllowed: !helperQuiescenceUnproven,
    ...(durableTransition.error ? { cause: durableTransition.error } : {})
  });
}
