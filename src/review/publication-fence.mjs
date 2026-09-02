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
  const guard = { publicationStarted: false };
  return Object.freeze({
    /** Handed to the binder; it is the only thing that may set the guard. */
    publication: Object.freeze({ signal: controller.signal, guard }),
    requestCancellation: () => controller.abort(),
    publicationStarted: () => guard.publicationStarted === true,
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
  if (publication?.guard) publication.guard.publicationStarted = true;
}
