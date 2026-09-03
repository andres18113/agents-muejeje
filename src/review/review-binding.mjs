import { AGENT_REGISTRY } from "../agent-registry.mjs";
import { COLLECTOR_VERSION } from "../changeset/collector.mjs";
import { NO_REVIEW_TARGET } from "../changeset/target.mjs";
import { repositoryIdForCanonicalRootKey } from "../write-custody.mjs";
import { COHERENCE } from "./coherent-admission.mjs";
import { assignmentBasis, resultBasis, reviewerBasis } from "./receipt-basis.mjs";
import { buildReviewReceipt, COHERENT_ADMISSION_KIND } from "./receipt-schema.mjs";
import { evaluateFreshness } from "./freshness.mjs";
import { formatReviewSubjectBlock } from "./review-subject.mjs";
import { RECEIPT_PRODUCER_VERSION } from "../version.mjs";

/**
 * The BEFORE / reviewer / AFTER lifecycle.
 *
 * The whole point of this module is a single question: may this review's output
 * be bound to an exact repository state? It answers it by collecting the
 * subject before the reviewer runs, collecting it again afterwards, confirming
 * the exclusive admission survived in between, and writing a receipt only if
 * all three agree.
 *
 * Neither method throws, ever. A review that produced useful findings must
 * still return them when the evidence machinery fails; the failure is reported
 * as a binding status, never as a failed delegation. That asymmetry is
 * deliberate - Phase 6 adds evidence, and it is not allowed to subtract
 * reviews.
 *
 * An unbound review persists nothing at all. The only durable object here is a
 * receipt whose subject is provable, and a review whose subject moved has no
 * provable subject; storing a record of that would create an object whose
 * entire content is a negative claim.
 */

export const REVIEW_BINDING_CAPABILITY = "inspect-change-set";
export const DEFAULT_RECEIPT_PRODUCER_VERSION = RECEIPT_PRODUCER_VERSION;

export function profileParticipatesInReviewBinding(profile) {
  return Boolean(profile?.declaredCapabilities?.includes(REVIEW_BINDING_CAPABILITY));
}

export function reviewBindingProfileIds() {
  return Object.values(AGENT_REGISTRY)
    .filter(profileParticipatesInReviewBinding)
    .map((profile) => profile.id);
}

function reasons(...codes) {
  return Object.freeze(codes.flat().filter(Boolean).map((code) =>
    typeof code === "string" ? Object.freeze({ code }) : Object.freeze(code)));
}

const MAX_HISTORY_DIAGNOSTICS = 16;

function requestStopped(error) {
  return error?.code === "claude_cancelled" ||
    error?.code === "delegate_request_deadline_exceeded";
}

function receiptHistory(status, receipts = [], diagnostics = [], metadata = {}) {
  const allReceipts = metadata.allReceipts ?? receipts;
  const totalCount = Number.isSafeInteger(metadata.totalCount) && metadata.totalCount >= 0
    ? metadata.totalCount
    : allReceipts.length;
  const outputTruncated = metadata.outputTruncated === true || allReceipts.length > 16;
  return Object.freeze({
    status,
    receipts: Object.freeze(receipts.slice(0, 16)),
    allReceipts: Object.freeze(allReceipts),
    totalCount,
    outputTruncated,
    authoritativeExhaustive: metadata.authoritativeExhaustive === true,
    diagnostics: Object.freeze(diagnostics.slice(0, MAX_HISTORY_DIAGNOSTICS))
  });
}

/**
 * The non-identity-bearing description of one observation. Counts come from the
 * descriptor rather than being recomputed, so a summary can never disagree with
 * the sections it describes.
 */
function receiptSummary(descriptor) {
  return {
    headCommit: descriptor.head.commit,
    branch: descriptor.summary.branch,
    detached: descriptor.summary.detached,
    mergeBase: descriptor.summary.mergeBase,
    counts: { ...descriptor.summary.counts }
  };
}

function unavailable(coherence, reasonList, extra = {}) {
  const history = extra.receiptHistory ?? receiptHistory(
    "indeterminate",
    [],
    [{ code: "review_history_unavailable" }]
  );
  return Object.freeze({
    status: "unavailable",
    coherence,
    reasons: Object.freeze(reasonList),
    priorReviews: history.receipts,
    receiptHistory: history,
    ...extra
  });
}

export function createReviewBinder({
  collectChangeSet,
  coherentAdmission,
  receiptStore,
  evaluateFreshnessFn = evaluateFreshness,
  now = Date.now,
  producerVersion = DEFAULT_RECEIPT_PRODUCER_VERSION
} = {}) {

  /**
   * Discovers prior receipts for this review scope and evaluates each against
   * the state just collected.
   *
   * Discovery is by scope rather than by current change set precisely so a
   * receipt taken against an older state is still found. Looking up by the
   * current change set can only ever surface receipts that are already fresh,
   * which makes STALE unreachable in practice.
   *
   * Every discovered receipt is fully validated by evaluateFreshness before its
   * verdict is used; the discovery index is a hint about where to look and is
   * never treated as evidence in its own right.
   */
  async function discoverPriorReviews({ canonicalRootKey, agentType, targetSpec, current, basis, requestContext }) {
    if (!receiptStore || typeof receiptStore.discoverForScope !== "function") {
      return receiptHistory("indeterminate", [], [{ code: "review_history_unavailable" }]);
    }
    let discovered;
    try {
      discovered = await receiptStore.discoverForScope({
        canonicalRootKey,
        agentType,
        targetSpec,
        requestContext
      });
    } catch (error) {
      if (requestStopped(error)) throw error;
      return receiptHistory("indeterminate", [], [{
        code: "review_history_discovery_failed",
        ...(typeof error?.code === "string" ? { detail: error.code } : {})
      }]);
    }
    const discoveredReceipts = Array.isArray(discovered.allReceipts)
      ? discovered.allReceipts
      : (Array.isArray(discovered.receipts) ? discovered.receipts : []);
    const priorReviews = discoveredReceipts.map((receipt) => {
      const verdict = evaluateFreshnessFn({ receipt, current, basis, now });
      return Object.freeze({
        reviewId: receipt.reviewId,
        agentType: receipt.reviewer.agentType,
        changeSetId: receipt.binding.changeSetId,
        recordedAt: receipt.provenance.recordedAt,
        verdict: verdict.verdict,
        changedSections: verdict.changedSections,
        basisDifferences: verdict.basisDifferences,
        reasons: Object.freeze(verdict.reasons.map((reason) => Object.freeze({ code: reason.code }))),
        receipt
      });
    });
    for (const skipped of discovered.skipped ?? []) {
      if (typeof skipped.reviewId !== "string" || typeof skipped.changeSetId !== "string") continue;
      priorReviews.push(Object.freeze({
        reviewId: skipped.reviewId,
        agentType,
        changeSetId: skipped.changeSetId,
        recordedAt: Number.isSafeInteger(skipped.recordedAt) ? skipped.recordedAt : null,
        verdict: "INDETERMINATE",
        changedSections: Object.freeze([]),
        basisDifferences: Object.freeze([]),
        reasons: Object.freeze([{ code: skipped.code }])
      }));
    }
    const diagnostics = (discovered.skipped ?? []).map((skipped) => ({ code: skipped.code }));
    if (discovered.truncated === true && !diagnostics.some((entry) => entry.code === "review_history_truncated")) {
      diagnostics.push({ code: "review_history_truncated" });
    }
    // A status this binder does not recognize is not evidence of completeness.
    // Collapsing an unknown or indeterminate discovery into "complete" is the
    // exact false-absence this three-valued status exists to prevent.
    let status;
    if (discovered.status === "complete" || discovered.status === "partial") {
      status = discovered.status;
    } else {
      status = "indeterminate";
      if (discovered.status !== "indeterminate") {
        diagnostics.push({ code: "review_history_status_unrecognized" });
      }
    }
    return receiptHistory(status, priorReviews, diagnostics, {
      allReceipts: priorReviews,
      totalCount: Number.isSafeInteger(discovered.totalCount)
        ? discovered.totalCount
        : priorReviews.length,
      outputTruncated: discovered.outputTruncated === true || discovered.truncated === true,
      authoritativeExhaustive: discovered.authoritativeExhaustive === true
    });
  }

  async function before({
    profile,
    runtime,
    contract,
    capabilityPolicy,
    task,
    workspace,
    coherence,
    custodyExecutionId,
    targetSpec = NO_REVIEW_TARGET,
    requestContext
  }) {
    try {
      if (!profileParticipatesInReviewBinding(profile)) {
        return unavailable(COHERENCE.NOT_ATTEMPTED, reasons("profile_not_review_bound"));
      }

      const reviewer = reviewerBasis({
        agentType: profile.id,
        contract,
        capabilityPolicy,
        runtime
      });
      const assignment = assignmentBasis(task);
      const basis = {
        agentType: profile.id,
        contractSha256: reviewer.contractSha256,
        capabilityPolicySha256: reviewer.capabilityPolicySha256,
        modelSelector: reviewer.modelSelector,
        reasoningEffort: reviewer.reasoningEffort,
        assignmentSha256: assignment.sha256
      };

      // Under held admission the collector must confirm the slot is still ours;
      // otherwise it can only observe, and any live foreign record makes the
      // reading indeterminate rather than exact.
      const custodyExpectation = coherence === COHERENCE.HELD
        ? { mode: "exclusive-held", executionId: custodyExecutionId }
        : { mode: "observational" };

      const current = await collectChangeSet({
        effectiveCwd: workspace.effectiveCwd,
        rootSource: workspace.rootSource,
        canonicalRepositoryKey: workspace.canonicalRepositoryKey,
        targetSpec,
        custodyExpectation
      }, {
        requestContext,
        abortSignal: requestContext?.abortSignal,
        deadlineAt: requestContext?.deadlineAt,
        now: requestContext?.now,
        schedule: requestContext?.schedule,
        cancelSchedule: requestContext?.cancelSchedule
      });
      const collectedAt = now();

      const discoveredHistory = await discoverPriorReviews({
        canonicalRootKey: workspace.canonicalRepositoryKey,
        agentType: profile.id,
        targetSpec,
        current,
        basis,
        requestContext
      });

      const reviewSubject = formatReviewSubjectBlock({
        status: current.status,
        coherence,
        changeSetId: current.changeSetId,
        descriptor: current.descriptor,
        reasons: current.reasons
      });

      return Object.freeze({
        status: current.status === "exact" ? "collected" : "indeterminate",
        coherence,
        custodyExecutionId,
        targetSpec,
        reviewer,
        assignment,
        basis,
        collectedAt,
        current,
        reviewSubject,
        priorReviews: discoveredHistory.receipts,
        receiptHistory: discoveredHistory,
        reasons: Object.freeze(current.status === "exact" ? [] : [...current.reasons])
      });
    } catch (error) {
      if (requestStopped(error)) throw error;
      return unavailable(coherence ?? COHERENCE.NOT_ATTEMPTED,
        reasons({ code: "review_binding_internal_error", detail: error?.code || error?.name }));
    }
  }

  async function after({
    beforeState,
    workspace,
    outcome,
    executionId,
    startedAt,
    completedAt,
    publication,
    requestContext
  }) {
    try {
      if (!beforeState || beforeState.status === "unavailable") {
        return unavailable(beforeState?.coherence ?? COHERENCE.NOT_ATTEMPTED,
          reasons(beforeState?.reasons ?? [], "review_binding_unavailable"));
      }

      const history = beforeState.receiptHistory ?? receiptHistory(
        "indeterminate",
        beforeState.priorReviews ?? [],
        [{ code: "review_history_status_missing" }]
      );
      const priorReviews = history.receipts;

      if (outcome?.status !== "completed") {
        return unavailable(beforeState.coherence,
          reasons("execution_not_completed"), { priorReviews, receiptHistory: history });
      }
      if (beforeState.coherence !== COHERENCE.HELD) {
        return unavailable(beforeState.coherence,
          reasons("coherent_admission_denied"), { priorReviews, receiptHistory: history });
      }
      if (beforeState.status !== "collected") {
        return unavailable(beforeState.coherence,
          reasons(beforeState.reasons, "before_collection_indeterminate"), {
            priorReviews,
            receiptHistory: history
          });
      }

      // The slot could have been reconciled away if this coordinator was ever
      // wrongly judged dead. If that happened the interval was not actually
      // held, and no receipt may claim it was.
      requestContext?.assertActive?.("before-after-admission-verification");
      const stillHeld = requestContext
        ? await requestContext.observe("before-after-admission-verification", () => coherentAdmission.verifyStillHeld({
            executionId: beforeState.custodyExecutionId,
            canonicalRootKey: workspace.canonicalRepositoryKey,
            requestContext
          }))
        : await coherentAdmission.verifyStillHeld({
          executionId: beforeState.custodyExecutionId,
          canonicalRootKey: workspace.canonicalRepositoryKey,
          requestContext
        });
      if (!stillHeld.held) {
        return Object.freeze({
          status: "unbound",
          coherence: COHERENCE.LOST,
          reasons: Object.freeze([...stillHeld.reasons]),
          beforeChangeSetId: beforeState.current.changeSetId,
          priorReviews,
          receiptHistory: history
        });
      }

      const afterState = await collectChangeSet({
        effectiveCwd: workspace.effectiveCwd,
        rootSource: workspace.rootSource,
        canonicalRepositoryKey: workspace.canonicalRepositoryKey,
        targetSpec: beforeState.targetSpec,
        custodyExpectation: { mode: "exclusive-held", executionId: beforeState.custodyExecutionId }
      }, {
        requestContext,
        abortSignal: requestContext?.abortSignal,
        deadlineAt: requestContext?.deadlineAt,
        now: requestContext?.now,
        schedule: requestContext?.schedule,
        cancelSchedule: requestContext?.cancelSchedule
      });
      const afterAt = now();

      if (afterState.status !== "exact") {
        return Object.freeze({
          status: "unbound",
          coherence: beforeState.coherence,
          reasons: Object.freeze([...afterState.reasons, { code: "after_collection_indeterminate" }]),
          beforeChangeSetId: beforeState.current.changeSetId,
          priorReviews,
          receiptHistory: history
        });
      }

      if (afterState.changeSetId !== beforeState.current.changeSetId) {
        return Object.freeze({
          status: "unbound",
          coherence: beforeState.coherence,
          reasons: Object.freeze([{ code: "workspace_mutated_during_review" }]),
          beforeChangeSetId: beforeState.current.changeSetId,
          afterChangeSetId: afterState.changeSetId,
          priorReviews,
          receiptHistory: history
        });
      }

      // Collection verifies ownership at its start. Verify once more after the
      // exact snapshot has been assembled so the receipt covers the complete
      // claimed interval through AFTER, not merely the instant before it.
      requestContext?.assertActive?.("after-admission-verification");
      const heldThroughAfter = requestContext
        ? await requestContext.observe("after-admission-verification", () => coherentAdmission.verifyStillHeld({
            executionId: beforeState.custodyExecutionId,
            canonicalRootKey: workspace.canonicalRepositoryKey,
            requestContext
          }))
        : await coherentAdmission.verifyStillHeld({
          executionId: beforeState.custodyExecutionId,
          canonicalRootKey: workspace.canonicalRepositoryKey,
          requestContext
        });
      if (!heldThroughAfter.held) {
        return Object.freeze({
          status: "unbound",
          coherence: COHERENCE.LOST,
          reasons: Object.freeze([...heldThroughAfter.reasons]),
          beforeChangeSetId: beforeState.current.changeSetId,
          afterChangeSetId: afterState.changeSetId,
          priorReviews,
          receiptHistory: history
        });
      }

      const descriptor = afterState.descriptor;
      const recordedAt = now();
      const receipt = buildReviewReceipt({
        binding: {
          changeSetId: afterState.changeSetId,
          objectFormat: descriptor.objectFormat,
          sections: { ...afterState.sections },
          target: {
            spec: { ...descriptor.target.spec },
            resolution: descriptor.target.resolution,
            commit: descriptor.target.commit
          },
          // Both observations, named for what they are. The reviewer was shown
          // the BEFORE summary and nothing else, so a single "summary" field
          // filled from AFTER would present metadata the reviewer never saw as
          // if it were the subject it worked from. The two are equal whenever
          // nothing moved, and when they differ that difference is a fact worth
          // keeping rather than one worth hiding. Neither is hashed into the
          // change-set identity: this changes what the receipt records, not
          // what the subject is.
          beforeSummary: receiptSummary(beforeState.current.descriptor),
          afterSummary: receiptSummary(descriptor)
        },
        coherence: {
          admission: COHERENT_ADMISSION_KIND,
          custodyExecutionId: beforeState.custodyExecutionId,
          beforeAt: beforeState.collectedAt,
          afterAt
        },
        reviewer: { ...beforeState.reviewer },
        assignment: { ...beforeState.assignment },
        execution: {
          executionId,
          status: "completed",
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt)
        },
        result: resultBasis(outcome.result),
        provenance: {
          repositoryId: repositoryIdForCanonicalRootKey(workspace.canonicalRepositoryKey),
          producer: producerVersion,
          collector: COLLECTOR_VERSION,
          recordedAt
        }
      });

      // Publication authority belongs to the durable reviews/cs rename inside
      // the store. Passing the fence through keeps the cancellation check and
      // authority marker adjacent to that rename instead of declaring the
      // boundary prematurely in the binder.
      try {
        await receiptStore.put({
          canonicalRootKey: workspace.canonicalRepositoryKey,
          receipt,
          resultText: typeof outcome?.result === "string" ? outcome.result : "",
          publication,
          awaitIndex: false,
          requestContext
        });
      } catch (error) {
        if (requestStopped(error)) throw error;
        return unavailable(beforeState.coherence,
          reasons(error?.code === "review_receipt_publication_cancelled"
            ? { code: "review_receipt_publication_cancelled" }
            : { code: "review_receipt_persist_failed", detail: error?.code || error?.name }),
          {
            beforeChangeSetId: beforeState.current.changeSetId,
            priorReviews,
            receiptHistory: history
          });
      }

      return Object.freeze({
        status: "bound",
        coherence: COHERENCE.HELD,
        reasons: Object.freeze([]),
        changeSetId: afterState.changeSetId,
        beforeChangeSetId: beforeState.current.changeSetId,
        afterChangeSetId: afterState.changeSetId,
        reviewId: receipt.reviewId,
        priorReviews,
        receiptHistory: history
      });
    } catch (error) {
      if (requestStopped(error)) throw error;
      return unavailable(beforeState?.coherence ?? COHERENCE.NOT_ATTEMPTED,
        reasons({ code: "review_binding_internal_error", detail: error?.code || error?.name }));
    }
  }

  async function loadResultArtifact({ canonicalRootKey, receipt, requestContext }) {
    if (!receiptStore || typeof receiptStore.loadResultArtifact !== "function") {
      return Object.freeze({ status: "unavailable", error: "receipt_store_unavailable" });
    }
    return await receiptStore.loadResultArtifact({ canonicalRootKey, receipt, requestContext });
  }

  return Object.freeze({ before, after, loadResultArtifact });
}
