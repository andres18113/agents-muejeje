import { CUSTODY_KINDS, custodyKindOf } from "../write-custody.mjs";

/**
 * How a review takes, verifies, and reasons about exclusive admission.
 *
 * There is exactly one admission boundary per repository - the rename onto
 * ownership/ - and this module reuses it rather than adding a second lock. A
 * coherent review occupies the same slot a writer would, which is why the
 * rename that stops a second writer is the rename that stops a writer during a
 * review. Nothing is acquired in an order, so nothing here can deadlock.
 *
 * Release is deliberately not this module's job. A review is released through
 * the unchanged Phase 5 lifecycle in delegateAgent's finally block, so a
 * crashed review reconciles under exactly the rules a crashed writer does.
 *
 * admit() never throws. Denied admission is an ordinary outcome - the review
 * still runs, it simply produces advice with no durable claim about state.
 */

export const COHERENCE = Object.freeze({
  HELD: "held",
  DENIED: "denied",
  LOST: "lost",
  NOT_ATTEMPTED: "not-attempted"
});

const TERMINAL_STATES = new Set(["TERMINAL_PROVEN", "HANDOFF_READY", "RELEASED"]);

const ADMISSION_REASON_BY_CUSTODY_CODE = Object.freeze({
  write_custody_conflict: "coherent_admission_denied",
  write_custody_state_ambiguous: "coherent_admission_ambiguous",
  write_custody_execution_id_conflict: "coherent_admission_execution_conflict",
  write_custody_process_identity_ambiguous: "coherent_admission_identity_ambiguous",
  write_custody_state_root_invalid: "coherent_admission_state_root_invalid",
  write_custody_kind_invalid: "coherent_admission_failed"
});

export function createCoherentAdmission({ writeCustody } = {}) {
  if (!writeCustody || typeof writeCustody.reserveWriteAccess !== "function") {
    throw new Error("Coherent review admission requires a durable write-custody manager.");
  }

  return Object.freeze({
    async admit({ executionId, agentType, canonicalRoot, canonicalRootKey, targetRef }) {
      try {
        const record = await writeCustody.reserveWriteAccess({
          executionId,
          agentType,
          canonicalRoot,
          canonicalRootKey,
          custodyKind: CUSTODY_KINDS.COHERENT_REVIEW,
          ...(targetRef === undefined ? {} : { targetRef })
        });
        return Object.freeze({ coherence: COHERENCE.HELD, record });
      } catch (error) {
        const code = ADMISSION_REASON_BY_CUSTODY_CODE[error?.code] || "coherent_admission_failed";
        return Object.freeze({
          coherence: COHERENCE.DENIED,
          reasons: Object.freeze([{ code, detail: error?.code }])
        });
      }
    },

    /**
     * Confirms the slot is still ours before evidence is bound.
     *
     * This exists because a coordinator wrongly judged dead could have had its
     * record reconciled away mid-review. If that happened the interval was
     * never actually held, and a receipt claiming it was would be false.
     */
    async verifyStillHeld({ executionId, canonicalRootKey }) {
      let record;
      try {
        record = await writeCustody.getWriteAccess(canonicalRootKey);
      } catch (error) {
        return Object.freeze({
          held: false,
          reasons: Object.freeze([{ code: "coherent_admission_ambiguous", detail: error?.code }])
        });
      }
      if (!record) {
        return Object.freeze({
          held: false,
          reasons: Object.freeze([{ code: "coherent_admission_lost", detail: "ownership record is gone" }])
        });
      }
      if (record.executionId !== executionId) {
        return Object.freeze({
          held: false,
          reasons: Object.freeze([{
            code: "coherent_admission_lost",
            detail: "ownership belongs to " + record.executionId
          }])
        });
      }
      if (custodyKindOf(record) !== CUSTODY_KINDS.COHERENT_REVIEW) {
        return Object.freeze({
          held: false,
          reasons: Object.freeze([{ code: "coherent_admission_lost", detail: "ownership is not a coherent review" }])
        });
      }
      if (TERMINAL_STATES.has(record.state)) {
        return Object.freeze({
          held: false,
          reasons: Object.freeze([{ code: "coherent_admission_lost", detail: "ownership reached " + record.state }])
        });
      }
      return Object.freeze({ held: true });
    }
  });
}
