/**
 * The publication boundary for durable review evidence.
 *
 * Phase 5 established the rule for durable custody writes and this applies the
 * same rule to the only other durable object Phase 6 creates: a ReviewReceipt.
 *
 * A deadline race observes an operation; it never stops it. So an AFTER binding
 * that outruns its bound is not finished, and abandoning it while its receipt
 * write is still in flight would let a receipt become durable *after* the
 * coherent-review custody that authorized it had already been released. The
 * receipt would then assert an interval that custody no longer covered.
 *
 * The fence gives the deadline something honest to do. Cancellation is checked
 * immediately before the store write is issued, with no await in between, which
 * splits every timeout into exactly two cases:
 *
 *   publication not yet started - cancellation permanently removes the
 *   authority to publish, so no receipt can ever appear and custody may be
 *   released at once;
 *
 *   publication already issued - authority can no longer be withdrawn, so the
 *   caller must wait for the write to quiesce before releasing custody.
 *
 * The bounded quiescence wait is itself only an observation. When it expires,
 * the honest conclusion is that we do not know whether a receipt landed, and
 * the caller must fail closed by retaining custody rather than releasing it on
 * the strength of a timer.
 */

export const RECEIPT_PUBLICATION_QUIESCENCE_TIMEOUT_MS = 30_000;

export function createReceiptPublicationFence() {
  const controller = new AbortController();
  const guard = { publicationStarted: false, publicationSettled: false };
  let resolveSettlement;
  const settlement = new Promise((resolve) => {
    resolveSettlement = resolve;
  });
  const publication = Object.freeze({
    signal: controller.signal,
    guard,
    settle: (result) => {
      if (!guard.publicationStarted || guard.publicationSettled) return false;
      guard.publicationSettled = true;
      resolveSettlement(Object.freeze({ ...result }));
      return true;
    }
  });
  return Object.freeze({
    /** Handed through the binder to the receipt store. */
    publication,
    requestCancellation: () => controller.abort(),
    publicationStarted: () => guard.publicationStarted === true,
    publicationSettled: () => guard.publicationSettled === true,
    authoritativeSettlement: () => settlement,
    cancellationRequested: () => controller.signal.aborted === true
  });
}

/**
 * True once this publication has permanently lost its authority. A binder that
 * sees this before crossing the boundary must not write, and must say so.
 */
export function receiptPublicationCancelled(publication) {
  return publication?.signal?.aborted === true;
}

/**
 * Marks the publication boundary as crossed. The caller must issue the durable
 * write immediately afterwards with no intervening await: that adjacency is
 * what makes "cancelled" and "started" mutually exclusive.
 */
export function beginReceiptPublication(publication) {
  if (!publication?.guard || receiptPublicationCancelled(publication)) return false;
  if (publication.guard.publicationStarted) {
    throw new Error("Receipt publication authority may be crossed only once.");
  }
  publication.guard.publicationStarted = true;
  return true;
}

/**
 * Records that the authoritative rename attempt has settled. It says nothing
 * about later scope-index housekeeping, which is deliberately outside the
 * evidence publication boundary.
 */
export function settleReceiptPublication(publication, result) {
  return publication?.settle?.(result) === true;
}
