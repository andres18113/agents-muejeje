import { WriteCustodyError } from "./record-schema.mjs";

/**
 * Bounded retry for the one syscall that publishes durable ownership.
 *
 * On Windows a rename onto a path another process momentarily holds open - a
 * scanner, an indexer, a backup agent - is rejected with EPERM, EACCES or
 * EBUSY. MoveFileExW is synchronous, so such a rejection is a *settled failed*
 * attempt: nothing was moved, nothing can land later, and the destination is
 * exactly as it was. Treating that as a terminal custody failure destroys
 * healthy delegations for a condition that clears in milliseconds.
 *
 * This module owns only the decision to try again. It classifies the host
 * failure domain, bounds the attempts, spaces them, and refuses to continue
 * once the mutation has lost its authority. It deliberately owns no knowledge
 * of what is being published: re-establishing the compare-and-set is the owning
 * store operation's job, and this helper simply calls that whole operation
 * again. That is the invariant a retry has to preserve - a second rename is a
 * newly authorized publication attempt, never a replay of the first.
 */

/**
 * The states one rename attempt passes through. They are named because the
 * difference between the last two is the whole point: an issued rename that was
 * rejected is settled, while an issued rename whose result was never observed
 * is not, and only the latter leaves durable state unknown.
 */
export const PUBLICATION_ATTEMPT = Object.freeze({
  NOT_ISSUED: "not-issued",
  ISSUED: "issued",
  SETTLED_FAILED: "settled-failed",
  SETTLED_PUBLISHED: "settled-published"
});

/**
 * The complete retryable domain. Every other code - ENOENT, ENOTDIR, ENOSPC,
 * EIO, EROFS, a genuine access denial that does not clear - stays immediately
 * fatal, because retrying those hides a real fault instead of absorbing a
 * transient one.
 */
export const WINDOWS_TRANSIENT_RENAME_CODES = Object.freeze(["EPERM", "EACCES", "EBUSY"]);

export const PUBLICATION_RETRY_MAX_ATTEMPTS = 4;
export const PUBLICATION_RETRY_BACKOFF_MS = Object.freeze([25, 75, 200]);

/**
 * Retries exist only for the Windows sharing-violation domain, so on every
 * other platform the policy is exactly one attempt and the code path below is
 * indistinguishable from having no retry at all.
 */
export function createPublicationRetryPolicy({
  platform = process.platform,
  maxAttempts = PUBLICATION_RETRY_MAX_ATTEMPTS,
  backoffMs = PUBLICATION_RETRY_BACKOFF_MS,
  schedule = setTimeout,
  cancelSchedule = clearTimeout
} = {}) {
  const windows = platform === "win32";
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const delays = Array.isArray(backoffMs) && backoffMs.length > 0 ? backoffMs : [0];
  return Object.freeze({
    maxAttempts: windows ? attempts : 1,
    /**
     * A rename rejection, and only a rename rejection. A staging open() or a
     * stat() that fails with the same errno is not a publication conflict and
     * must not be absorbed here.
     */
    isTransientPublicationFailure: (error) =>
      windows &&
      !(error instanceof WriteCustodyError) &&
      error?.syscall === "rename" &&
      WINDOWS_TRANSIENT_RENAME_CODES.includes(error?.code),
    backoffFor: (completedAttempts) => delays[Math.min(completedAttempts - 1, delays.length - 1)],
    schedule,
    cancelSchedule
  });
}

export const DEFAULT_PUBLICATION_RETRY_POLICY = createPublicationRetryPolicy();

/**
 * Waits out one backoff interval, but stops the moment the mutation loses its
 * authority. The root request delivers both client cancellation and deadline
 * expiry through this one signal, so waking early here is what guarantees the
 * caller reaches its refusal check instead of sleeping through it.
 */
function backoff(delayMs, { policy, mutationSignal }) {
  if (!(delayMs > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      policy.cancelSchedule(timer);
      mutationSignal?.removeEventListener?.("abort", finish);
      resolve();
    };
    const timer = policy.schedule(finish, delayMs);
    if (mutationSignal?.aborted) finish();
    else mutationSignal?.addEventListener?.("abort", finish, { once: true });
  });
}

/**
 * Runs one complete publication attempt - observation, authority revalidation
 * and rename - up to the policy's bound.
 *
 * `attempt` is the entire operation, not just its final syscall, which is what
 * makes every retry a fresh compare-and-set rather than a blind repeat. Any
 * error it raises that is not a transient host rename failure propagates
 * immediately and unchanged: a lost CAS, a foreign owner, a cancelled mutation
 * and an ambiguous state all still fail closed on their first occurrence.
 *
 * Authority is rechecked before the first attempt, after every backoff, and
 * again inside `attempt` itself before its rename. A cancellation or deadline
 * that lands during a backoff therefore issues no further rename.
 */
export async function withBoundedPublicationRetry(attempt, {
  policy = DEFAULT_PUBLICATION_RETRY_POLICY,
  mutationSignal,
  cancelled = () => false,
  cancelledError
} = {}) {
  const refuseIfCancelled = () => {
    if (cancelled(mutationSignal)) throw cancelledError();
  };
  let lastTransientError;
  for (let completed = 0; completed < policy.maxAttempts; completed += 1) {
    if (completed > 0) {
      await backoff(policy.backoffFor(completed), { policy, mutationSignal });
      refuseIfCancelled();
    }
    refuseIfCancelled();
    try {
      return await attempt({ attemptIndex: completed, isRetry: completed > 0 });
    } catch (error) {
      if (!policy.isTransientPublicationFailure(error)) throw error;
      lastTransientError = error;
    }
  }
  // Exhaustion is not "unknown". Every attempt was an issued rename that the
  // host rejected outright, so no publication is outstanding and the caller may
  // report a definite failure rather than an unresolved boundary.
  throw new WriteCustodyError(
    "Durable ownership publication kept failing on a transient host filesystem condition.",
    {
      code: "write_custody_publication_retry_exhausted",
      cause: lastTransientError
    }
  );
}
