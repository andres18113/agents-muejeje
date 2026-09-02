import { canonicalJson, sha256Hex } from "../canonical-json.mjs";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../changeset/descriptor.mjs";
import { validateReviewTargetContext } from "../changeset/target.mjs";
import { AGENT_REGISTRY } from "../agent-registry.mjs";

/**
 * What a review receipt legally is.
 *
 * A receipt is immutable historical evidence: execution E, running profile A
 * under contract digest C and capability policy digest P, having requested
 * model selector M at effort R, was given an assignment with digest T, held
 * coherent review custody as execution X across [beforeAt, afterAt], ran
 * against changeSetId S with target context G, completed at time t, and
 * returned output whose SHA-256 is H.
 *
 * It proves none of: review quality, the assignment's contents, which concrete
 * model actually served the request, or anything about ignored files. It is
 * unsigned, so it proves content integrity and not authorship.
 *
 * reviewId is the digest of the body with reviewId absent - never with a
 * placeholder - so a receipt verifies itself by recomputation. Validation uses
 * exact key sets at every level and refuses anything unexpected: the in-toto
 * rule "ignore unrecognized fields" is wrong here, because these identifiers
 * are content-addressed and an unrecognized field changes the digest.
 */

export const REVIEW_RECEIPT_SCHEMA = "claude-agents-mcp/review-receipt/v1";
export const REVIEW_ID_PREFIX = "rr1";
export const MAX_RECEIPT_BYTES = 64 * 1024;
export const COHERENT_ADMISSION_KIND = "coherent-review-custody";

export class ReviewReceiptError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ReviewReceiptError";
    this.code = options.code || "review_receipt_invalid";
  }
}

const HEX_64 = /^[0-9a-f]{64}$/u;
const CHANGE_SET_ID = /^cs1:[0-9a-f]{64}$/u;
const REVIEW_ID = /^rr1:[0-9a-f]{64}$/u;
const MODEL_SELECTOR_SOURCES = new Set(["default", "operator-override"]);
const MODEL_STRATEGIES = new Set(["configurable", "inherit", "complementary"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function reviewCapableAgentTypes() {
  return Object.values(AGENT_REGISTRY)
    .filter((profile) => profile.declaredCapabilities.includes("inspect-change-set"))
    .map((profile) => profile.id);
}

export function computeReviewId(bodyWithoutReviewId) {
  if (Object.hasOwn(bodyWithoutReviewId, "reviewId")) {
    throw new ReviewReceiptError("reviewId must be absent when computing a review id.", {
      code: "review_receipt_invalid"
    });
  }
  return REVIEW_ID_PREFIX + ":" + sha256Hex(Buffer.from(canonicalJson(bodyWithoutReviewId), "utf8"));
}

export function buildReviewReceipt({
  binding,
  coherence,
  reviewer,
  assignment,
  execution,
  result,
  provenance
}) {
  const body = {
    schema: REVIEW_RECEIPT_SCHEMA,
    binding,
    coherence,
    reviewer,
    assignment,
    execution,
    result,
    provenance
  };

  const reviewId = computeReviewId(body);
  const receipt = { ...body, reviewId };

  const serialized = canonicalJson(receipt);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) {
    throw new ReviewReceiptError("Review receipt exceeds the maximum size.", {
      code: "review_receipt_too_large"
    });
  }

  const validated = validateReviewReceipt(receipt);
  if (!validated) {
    throw new ReviewReceiptError("Refusing to build an invalid review receipt.", {
      code: "review_receipt_invalid"
    });
  }
  return validated;
}

/**
 * Returns the frozen receipt, or undefined. Never throws: an unreadable receipt
 * on disk is a fact to report, not an exception to propagate into a delegation.
 */
export function validateReviewReceipt(value) {
  try {
    if (!hasExactKeys(value, [
      "schema", "reviewId", "binding", "coherence",
      "reviewer", "assignment", "execution", "result", "provenance"
    ])) return undefined;
    if (value.schema !== REVIEW_RECEIPT_SCHEMA) return undefined;
    if (typeof value.reviewId !== "string" || !REVIEW_ID.test(value.reviewId)) return undefined;

    const { binding, coherence, reviewer, assignment, execution, result, provenance } = value;

    if (!hasExactKeys(binding, ["changeSetId", "objectFormat", "sections", "target", "summary"])) return undefined;
    if (!CHANGE_SET_ID.test(binding.changeSetId)) return undefined;
    if (binding.objectFormat !== "sha1" && binding.objectFormat !== "sha256") return undefined;
    if (!hasExactKeys(binding.sections, SECTION_NAMES)) return undefined;
    if (!SECTION_NAMES.every((name) => HEX_64.test(binding.sections[name]))) return undefined;
    if (binding.changeSetId !== changeSetIdFromSectionDigests({
      objectFormat: binding.objectFormat,
      sections: binding.sections
    })) return undefined;
    if (!validateReviewTargetContext(binding.target, { objectFormat: binding.objectFormat })) return undefined;
    if (!hasExactKeys(binding.summary, ["headCommit", "branch", "detached", "mergeBase", "counts"])) {
      return undefined;
    }
    const objectId = new RegExp("^[0-9a-f]{" + (binding.objectFormat === "sha1" ? 40 : 64) + "}$", "u");
    if (binding.summary.headCommit !== null && !objectId.test(binding.summary.headCommit)) return undefined;
    if (binding.summary.branch !== null && typeof binding.summary.branch !== "string") return undefined;
    if (typeof binding.summary.detached !== "boolean") return undefined;
    if (binding.summary.mergeBase !== null && !objectId.test(binding.summary.mergeBase)) return undefined;
    if (!hasExactKeys(binding.summary.counts, ["index", "worktree", "unmerged", "untracked", "submodules"])) {
      return undefined;
    }
    if (!Object.values(binding.summary.counts).every(safeCount)) return undefined;

    if (!hasExactKeys(coherence, ["admission", "custodyExecutionId", "beforeAt", "afterAt"])) return undefined;
    if (coherence.admission !== COHERENT_ADMISSION_KIND) return undefined;
    if (typeof coherence.custodyExecutionId !== "string" || coherence.custodyExecutionId.length === 0) {
      return undefined;
    }
    if (!safeCount(coherence.beforeAt) || !safeCount(coherence.afterAt)) return undefined;
    if (coherence.beforeAt > coherence.afterAt) return undefined;

    if (!hasExactKeys(reviewer, [
      "agentType", "contractSha256", "capabilityPolicySha256",
      "modelSelector", "modelSelectorSource", "modelStrategy", "reasoningEffort"
    ])) return undefined;
    if (!reviewCapableAgentTypes().includes(reviewer.agentType)) return undefined;
    if (!HEX_64.test(reviewer.contractSha256)) return undefined;
    if (!HEX_64.test(reviewer.capabilityPolicySha256)) return undefined;
    if (typeof reviewer.modelSelector !== "string" || reviewer.modelSelector.length === 0) return undefined;
    if (!MODEL_SELECTOR_SOURCES.has(reviewer.modelSelectorSource)) return undefined;
    if (!MODEL_STRATEGIES.has(reviewer.modelStrategy)) return undefined;
    if (!REASONING_EFFORTS.has(reviewer.reasoningEffort)) return undefined;

    if (!hasExactKeys(assignment, ["sha256", "chars"])) return undefined;
    if (!HEX_64.test(assignment.sha256)) return undefined;
    if (!safeCount(assignment.chars)) return undefined;

    if (!hasExactKeys(execution, ["executionId", "status", "startedAt", "completedAt", "durationMs"])) {
      return undefined;
    }
    if (typeof execution.executionId !== "string" || execution.executionId.length === 0) return undefined;
    if (execution.status !== "completed") return undefined;
    if (!safeCount(execution.startedAt) || !safeCount(execution.completedAt)) return undefined;
    if (!safeCount(execution.durationMs)) return undefined;
    if (execution.startedAt > execution.completedAt) return undefined;

    if (!hasExactKeys(result, ["sha256", "bytes"])) return undefined;
    if (!HEX_64.test(result.sha256)) return undefined;
    if (!safeCount(result.bytes)) return undefined;

    if (!hasExactKeys(provenance, ["repositoryId", "producer", "collector", "recordedAt"])) return undefined;
    if (!HEX_64.test(provenance.repositoryId)) return undefined;
    if (typeof provenance.producer !== "string" || provenance.producer.length === 0) return undefined;
    if (typeof provenance.collector !== "string" || provenance.collector.length === 0) return undefined;
    if (!safeCount(provenance.recordedAt)) return undefined;
    if (execution.completedAt > provenance.recordedAt) return undefined;

    const { reviewId, ...body } = value;
    if (computeReviewId(body) !== reviewId) return undefined;

    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_RECEIPT_BYTES) return undefined;

    return Object.freeze(value);
  } catch {
    return undefined;
  }
}
