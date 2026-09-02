import { SECTION_NAMES } from "../changeset/descriptor.mjs";
import { validateReviewReceipt } from "./receipt-schema.mjs";

/**
 * Whether a receipt still describes the repository.
 *
 * This is a computation, never a stored field. A receipt says what was true
 * once; asking whether it is still true is a question about now, and answering
 * it by reading a boolean someone wrote earlier is how stale approvals happen.
 *
 * Three verdicts, and INDETERMINATE is a real answer rather than a failure
 * mode. It is never quietly resolved into FRESH or STALE, because "we could not
 * tell" and "we checked and it is fine" must never look alike to a Lead.
 *
 * Freshness deliberately ignores the contract, the model, the effort, the
 * capability policy, and the assignment. A receipt is a statement about a past
 * review of a *subject*; running a different contract over the same subject
 * produces a different review, not a stale one. Those differences are reported
 * separately as basisDifferences so the Lead can weigh them, and they can never
 * move the verdict.
 *
 * Carry-forward - deciding a stale review is acceptable anyway - is an
 * orchestration policy decision and is deliberately not here.
 */

export const FRESHNESS_SCHEMA = "claude-agents-mcp/freshness-evaluation/v1";

export const FRESHNESS_VERDICT = Object.freeze({
  FRESH: "FRESH",
  STALE: "STALE",
  INDETERMINATE: "INDETERMINATE"
});

export const SECTION_REASON_CODES = Object.freeze({
  head: "head_changed",
  index: "index_state_changed",
  policy: "policy_changed",
  submodules: "submodule_state_changed",
  target: "target_changed",
  unmerged: "unmerged_state_changed",
  untracked: "untracked_state_changed",
  worktree: "worktree_state_changed"
});

export const BASIS_REASON_CODES = Object.freeze({
  agentType: "agent_type_differs",
  contractSha256: "contract_changed",
  capabilityPolicySha256: "capability_policy_changed",
  modelSelector: "model_changed",
  reasoningEffort: "reasoning_effort_changed",
  assignmentSha256: "assignment_changed"
});

function evaluation({ verdict, receipt, current, changedSections, reasons, basisDifferences, evaluatedAt }) {
  return Object.freeze({
    schema: FRESHNESS_SCHEMA,
    verdict,
    reviewId: receipt?.reviewId ?? null,
    receiptChangeSetId: receipt?.binding?.changeSetId ?? null,
    currentChangeSetId: current?.status === "exact" ? current.changeSetId : null,
    changedSections: Object.freeze(changedSections),
    reasons: Object.freeze(reasons),
    basisDifferences: Object.freeze(basisDifferences),
    evaluatedAt
  });
}

function schemaPrefix(changeSetId) {
  return typeof changeSetId === "string" ? changeSetId.slice(0, changeSetId.indexOf(":")) : "";
}

/**
 * Informational only. Computed even for an INDETERMINATE verdict, because a
 * Lead deciding what to do next benefits from knowing the basis moved too.
 */
function computeBasisDifferences(receipt, basis) {
  if (!basis || !receipt) return [];
  const differences = [];
  const reviewer = receipt.reviewer;
  if (basis.agentType !== undefined && basis.agentType !== reviewer.agentType) {
    differences.push(BASIS_REASON_CODES.agentType);
  }
  if (basis.contractSha256 !== undefined && basis.contractSha256 !== reviewer.contractSha256) {
    differences.push(BASIS_REASON_CODES.contractSha256);
  }
  if (basis.capabilityPolicySha256 !== undefined &&
      basis.capabilityPolicySha256 !== reviewer.capabilityPolicySha256) {
    differences.push(BASIS_REASON_CODES.capabilityPolicySha256);
  }
  if (basis.modelSelector !== undefined && basis.modelSelector !== reviewer.modelSelector) {
    differences.push(BASIS_REASON_CODES.modelSelector);
  }
  if (basis.reasoningEffort !== undefined && basis.reasoningEffort !== reviewer.reasoningEffort) {
    differences.push(BASIS_REASON_CODES.reasoningEffort);
  }
  if (basis.assignmentSha256 !== undefined && basis.assignmentSha256 !== receipt.assignment.sha256) {
    differences.push(BASIS_REASON_CODES.assignmentSha256);
  }
  return differences.sort();
}

export function evaluateFreshness({ receipt, current, basis, now = Date.now } = {}) {
  const evaluatedAt = now();
  const validated = validateReviewReceipt(receipt);
  const basisDifferences = computeBasisDifferences(validated, basis);

  if (!validated) {
    return evaluation({
      verdict: FRESHNESS_VERDICT.INDETERMINATE,
      receipt: receipt && typeof receipt === "object" ? receipt : undefined,
      current,
      changedSections: [],
      reasons: [{ code: "receipt_corrupt" }],
      basisDifferences,
      evaluatedAt
    });
  }

  if (!current || current.status !== "exact") {
    return evaluation({
      verdict: FRESHNESS_VERDICT.INDETERMINATE,
      receipt: validated,
      current,
      changedSections: [],
      reasons: [...(current?.reasons ?? []), { code: "current_state_indeterminate" }],
      basisDifferences,
      evaluatedAt
    });
  }

  // A future collector emitting cs2: describes a subject this receipt never
  // made a claim about. That is not staleness and not freshness.
  if (schemaPrefix(validated.binding.changeSetId) !== schemaPrefix(current.changeSetId)) {
    return evaluation({
      verdict: FRESHNESS_VERDICT.INDETERMINATE,
      receipt: validated,
      current,
      changedSections: [],
      reasons: [{ code: "change_set_schema_mismatch" }],
      basisDifferences,
      evaluatedAt
    });
  }

  if (validated.binding.changeSetId === current.changeSetId) {
    return evaluation({
      verdict: FRESHNESS_VERDICT.FRESH,
      receipt: validated,
      current,
      changedSections: [],
      reasons: [],
      basisDifferences,
      evaluatedAt
    });
  }

  const changedSections = SECTION_NAMES
    .filter((name) => validated.binding.sections[name] !== current.sections[name])
    .sort();

  // The identifiers differ but every section digest matches, so the only
  // remaining hashed input is the object format.
  const reasons = changedSections.length === 0
    ? [{ code: "object_format_changed" }]
    : changedSections.map((name) => ({ code: SECTION_REASON_CODES[name] }));

  return evaluation({
    verdict: FRESHNESS_VERDICT.STALE,
    receipt: validated,
    current,
    changedSections,
    reasons,
    basisDifferences,
    evaluatedAt
  });
}
