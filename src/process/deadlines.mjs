/**
 * Bounded-time primitives shared by every supervised process in this server.
 *
 * One rule holds everywhere these are used: a deadline observes work, it never
 * proves anything about it. A race that expires yields "unknown", which callers
 * must translate into a fail-closed outcome rather than into a terminal fact.
 *
 * All three helpers work on absolute deadlines rather than durations, because
 * a single lifecycle is bounded by one absolute instant even when it passes
 * through several bounded steps.
 */

/**
 * Node stores timer delays in a signed 32-bit integer; a larger delay silently
 * fires immediately. Any configured budget that becomes a setTimeout must be
 * validated against this bound rather than trusted.
 */
export const MAX_SCHEDULABLE_DELAY_MS = 2_147_483_647;

export function isSchedulableTimeout(timeoutMs) {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= MAX_SCHEDULABLE_DELAY_MS
  );
}

export function remainingMs(deadlineAt, now) {
  return Math.max(0, deadlineAt - now());
}

/**
 * Races one Promise against an absolute deadline.
 *
 * The timer is deliberately left referenced. These races decide custody and
 * proof-of-death outcomes, so the runtime must stay alive until the decision
 * resolves; an unref'd timer lets Node drain the event loop while a lifecycle
 * Promise is still unsettled.
 *
 * Resolves to exactly one of { timedOut: true }, { value }, or { error }. The
 * underlying work is never cancelled by this function: stopping it is the
 * caller's separate, explicit responsibility.
 */
export function waitForPromiseUntil(promise, { deadlineAt, now, schedule, cancelSchedule }) {
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
 * Carves a subdeadline out of an absolute deadline, keeping `reserveMs` for the
 * step that must still run afterwards.
 *
 * This never extends the outer deadline and never becomes a second budget: the
 * absolute deadline remains the one authority for every terminal-evidence wait.
 * At most half of the remaining time is reserved so a nearly expired budget
 * still leaves the earlier step a chance to run.
 */
export function deadlineWithReserve(deadlineAt, now, reserveMs) {
  const remaining = remainingMs(deadlineAt, now);
  const reserve = Math.max(1, Math.min(reserveMs, Math.ceil(remaining / 2)));
  return Math.max(now(), deadlineAt - reserve);
}
