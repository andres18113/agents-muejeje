import * as z from "zod/v4";
import { SECTION_NAMES } from "./changeset/descriptor.mjs";

export const DELEGATE_OUTCOME_SCHEMA = "claude-agents-mcp/delegate-outcome/v1";
export const MAX_PUBLIC_OUTCOME_BYTES = 128 * 1024;
export const MAX_PUBLIC_REASONS = 32;
export const MAX_PUBLIC_HISTORY_RECEIPTS = 16;
export const MAX_PUBLIC_HISTORY_DIAGNOSTICS = 16;

/**
 * The public outcome domains. They are exported so the delegation that produces
 * these values and the projection that validates them cannot drift apart; a
 * second private copy of any of them is exactly how a valid runtime state
 * becomes unrepresentable as public evidence.
 */
export const RECEIPT_HISTORY_STATUSES = Object.freeze([
  "complete",
  "partial",
  "indeterminate"
]);
export const RECEIPT_PUBLICATION_STATUSES = Object.freeze([
  "not-attempted",
  "cancelled-before-authority",
  "authoritative-pending",
  "authoritative-settled"
]);
export const RECEIPT_PUBLICATION_DISPOSITIONS = Object.freeze([
  "published",
  "conflict",
  "failed"
]);
export const CUSTODY_RECOVERY_MODES = Object.freeze([
  "not-needed",
  "same-coordinator-terminal-proof",
  "same-coordinator-publication-settlement",
  "manual-required",
  "unknown"
]);
export const RETAINED_CUSTODY_STATES = Object.freeze([
  "retained",
  "orphaned",
  "retention-failed"
]);

const CHANGE_SET_ID = /^cs1:[0-9a-f]{64}$/u;
const REVIEW_ID = /^rr1:[0-9a-f]{64}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const MAX_PATH_CHARS = 8_192;
const MAX_ERROR_MESSAGE_CHARS = 2_048;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const codeSchema = z.string().regex(SAFE_CODE);
const reasonSchema = z.object({
  code: codeSchema,
  detail: z.string().regex(SAFE_CODE).optional()
}).strict();

const freshnessSchema = z.object({
  verdict: z.enum(["FRESH", "STALE", "INDETERMINATE"]),
  changedSections: z.array(z.enum(SECTION_NAMES)).max(SECTION_NAMES.length),
  basisDifferences: z.array(codeSchema).max(16),
  reasons: z.array(reasonSchema).max(MAX_PUBLIC_REASONS)
}).strict();

const historyReceiptSchema = z.object({
  reviewId: z.string().regex(REVIEW_ID),
  agentType: z.string().regex(SAFE_CODE),
  changeSetId: z.string().regex(CHANGE_SET_ID),
  recordedAt: safeInteger.nullable(),
  freshness: freshnessSchema
}).strict();

const receiptHistorySchema = z.object({
  status: z.enum(RECEIPT_HISTORY_STATUSES),
  count: safeInteger,
  receipts: z.array(historyReceiptSchema).max(MAX_PUBLIC_HISTORY_RECEIPTS),
  diagnostics: z.array(reasonSchema).max(MAX_PUBLIC_HISTORY_DIAGNOSTICS)
}).strict();

const publicationSchema = z.object({
  status: z.enum(RECEIPT_PUBLICATION_STATUSES),
  authorityStarted: z.boolean(),
  settled: z.boolean(),
  disposition: z.enum(RECEIPT_PUBLICATION_DISPOSITIONS).optional(),
  reviewId: z.string().regex(REVIEW_ID).optional(),
  changeSetId: z.string().regex(CHANGE_SET_ID).optional(),
  errorCode: codeSchema.optional()
}).strict();

const reviewSchema = z.object({
  status: z.enum(["bound", "unbound", "unavailable"]),
  coherence: z.enum(["held", "denied", "lost", "not-attempted"]),
  changeSetId: z.string().regex(CHANGE_SET_ID).optional(),
  beforeChangeSetId: z.string().regex(CHANGE_SET_ID).optional(),
  afterChangeSetId: z.string().regex(CHANGE_SET_ID).optional(),
  reviewId: z.string().regex(REVIEW_ID).optional(),
  reasons: z.array(reasonSchema).max(MAX_PUBLIC_REASONS),
  receiptHistory: receiptHistorySchema,
  publication: publicationSchema
}).strict();

const terminationSchema = z.object({
  processStarted: z.boolean(),
  processIdentity: z.enum(["not-started", "recorded", "unavailable"]),
  terminalProof: z.enum(["not-required", "close", "unavailable"]),
  forcedTerminationStatus: codeSchema,
  method: codeSchema.optional(),
  reason: codeSchema.optional(),
  destructiveHelperAuthorized: z.boolean().optional(),
  helperQuiescenceProven: z.boolean().optional()
}).strict();

const recoverySchema = z.object({
  automatic: z.boolean(),
  manualInterventionRequired: z.boolean(),
  mode: z.enum(CUSTODY_RECOVERY_MODES),
  reason: codeSchema.optional()
}).strict();

const custodySchema = z.object({
  state: codeSchema,
  durableExecutionId: z.string().min(1).max(128),
  durableState: codeSchema,
  retained: z.boolean(),
  orphaned: z.boolean(),
  reasons: z.array(reasonSchema).max(MAX_PUBLIC_REASONS),
  recovery: recoverySchema,
  termination: terminationSchema
}).strict();

const executionSchema = z.object({
  id: z.string().min(1).max(128),
  agentType: z.string().regex(SAFE_CODE),
  status: z.enum(["completed", "failed", "timeout"]),
  startedAt: safeInteger.optional(),
  durationMs: safeInteger,
  pid: safeInteger.optional(),
  requestedModel: z.string().min(1).max(256),
  reasoningEffort: codeSchema,
  error: z.object({
    code: codeSchema,
    message: z.string().max(MAX_ERROR_MESSAGE_CHARS)
  }).strict().optional()
}).strict();

const workspaceSchema = z.object({
  effectiveCwd: z.string().min(1).max(MAX_PATH_CHARS),
  canonicalRoot: z.string().min(1).max(MAX_PATH_CHARS),
  canonicalRootSource: codeSchema.optional(),
  pathsTruncated: z.boolean(),
  worktree: z.object({
    root: z.string().min(1).max(MAX_PATH_CHARS),
    baseCommit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u).optional(),
    retained: z.literal(true),
    // True when preparation failed before the delegation could adopt the
    // worktree. The path is still reported because nothing removes it.
    adopted: z.boolean()
  }).strict().optional()
}).strict();

export const delegateAgentOutputSchema = z.object({
  schema: z.literal(DELEGATE_OUTCOME_SCHEMA),
  status: z.enum(["completed", "failed", "timeout", "rejected"]),
  execution: executionSchema.optional(),
  workspace: workspaceSchema.optional(),
  custody: custodySchema.optional(),
  review: reviewSchema.optional(),
  error: z.object({
    code: codeSchema,
    message: z.string().max(MAX_ERROR_MESSAGE_CHARS)
  }).strict().optional()
}).strict();

/**
 * Reason codes whose `detail` is itself a bounded machine code (an errno, a
 * durable-store failure code) rather than free text. Everything else keeps only
 * its code, so an operator-actionable diagnostic can never smuggle a path, an
 * assignment fragment, or an environment value into public output.
 */
const SAFE_DETAIL_CODES = new Set([
  "coherent_admission_failed",
  "coherent_admission_lifecycle_failed",
  "coherent_admission_retained",
  "custody-release-proof-failed",
  "repository_identity_unavailable",
  "review_binding_internal_error",
  "review_receipt_persist_failed",
  "review_history_discovery_failed"
]);

function bounded(value, maximum) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= maximum ? text : text.slice(0, maximum);
}

function safeCode(value, fallback = "diagnostic_unavailable") {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
}

function validId(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function projectReasons(values, maximum = MAX_PUBLIC_REASONS) {
  if (!Array.isArray(values)) return [];
  const projected = values.slice(0, maximum).map((reason) => {
    const code = safeCode(reason?.code);
    const detail = SAFE_DETAIL_CODES.has(code) &&
      typeof reason?.detail === "string" && SAFE_CODE.test(reason.detail)
      ? reason.detail
      : undefined;
    return { code, ...(detail ? { detail } : {}) };
  });
  // A silent cap is a false absence. Spend the last bounded slot saying that
  // codes were dropped, rather than letting a short list read as a full one.
  if (values.length > maximum) projected[maximum - 1] = { code: "public_reasons_truncated" };
  return projected;
}

function projectPublication(publication) {
  const status = RECEIPT_PUBLICATION_STATUSES.includes(publication?.status)
    ? publication.status
    : "not-attempted";
  const disposition = RECEIPT_PUBLICATION_DISPOSITIONS.includes(publication?.disposition)
    ? publication.disposition
    : undefined;
  return {
    status,
    authorityStarted: publication?.authorityStarted === true,
    settled: publication?.settled === true,
    ...(disposition ? { disposition } : {}),
    ...(validId(publication?.reviewId, REVIEW_ID) ? { reviewId: publication.reviewId } : {}),
    ...(validId(publication?.changeSetId, CHANGE_SET_ID)
      ? { changeSetId: publication.changeSetId }
      : {}),
    ...(typeof publication?.errorCode === "string"
      ? { errorCode: safeCode(publication.errorCode) }
      : {})
  };
}

function projectReceiptHistory(binding) {
  const source = binding?.receiptHistory;
  const sourceStatus = RECEIPT_HISTORY_STATUSES.includes(source?.status)
    ? source.status
    : "indeterminate";
  const sourceReceipts = Array.isArray(source?.receipts)
    ? source.receipts
    : (Array.isArray(binding?.priorReviews) ? binding.priorReviews : []);
  const receipts = sourceReceipts.slice(0, MAX_PUBLIC_HISTORY_RECEIPTS).flatMap((receipt) => {
    const reviewId = validId(receipt?.reviewId, REVIEW_ID);
    const changeSetId = validId(receipt?.changeSetId, CHANGE_SET_ID);
    if (!reviewId || !changeSetId) return [];
    const changedSections = Array.isArray(receipt.changedSections)
      ? receipt.changedSections.filter((name) => SECTION_NAMES.includes(name)).slice(0, SECTION_NAMES.length)
      : [];
    return [{
      reviewId,
      agentType: safeCode(receipt.agentType, "unknown-agent"),
      changeSetId,
      recordedAt: Number.isSafeInteger(receipt.recordedAt) && receipt.recordedAt >= 0
        ? receipt.recordedAt
        : null,
      freshness: {
        verdict: ["FRESH", "STALE", "INDETERMINATE"].includes(receipt.verdict)
          ? receipt.verdict
          : "INDETERMINATE",
        changedSections,
        basisDifferences: Array.isArray(receipt.basisDifferences)
          ? receipt.basisDifferences.slice(0, 16).map((code) => safeCode(code))
          : [],
        reasons: projectReasons(receipt.reasons)
      }
    }];
  });
  const diagnostics = projectReasons(source?.diagnostics, MAX_PUBLIC_HISTORY_DIAGNOSTICS);
  if (!source && diagnostics.length < MAX_PUBLIC_HISTORY_DIAGNOSTICS) {
    diagnostics.push({ code: "review_history_status_missing" });
  }
  // `count` is how many receipts the discovery actually held, not how many
  // survived the public bound, so a capped list can never read as the whole
  // history. Anything dropped here says so by code.
  if (receipts.length < sourceReceipts.length && diagnostics.length < MAX_PUBLIC_HISTORY_DIAGNOSTICS) {
    diagnostics.push({
      code: sourceReceipts.length > MAX_PUBLIC_HISTORY_RECEIPTS
        ? "public_receipt_history_truncated"
        : "public_receipt_history_unprojectable"
    });
  }
  return {
    status: sourceStatus,
    count: sourceReceipts.length,
    receipts,
    diagnostics
  };
}

function projectTermination(outcome) {
  const termination = outcome.terminationDiagnostics ?? {};
  return {
    processStarted: termination.processStarted === true,
    processIdentity: ["not-started", "recorded", "unavailable"].includes(termination.processIdentity)
      ? termination.processIdentity
      : "unavailable",
    terminalProof: ["not-required", "close", "unavailable"].includes(termination.terminalProof)
      ? termination.terminalProof
      : "unavailable",
    forcedTerminationStatus: safeCode(termination.forcedTerminationStatus, "not-attempted"),
    ...(termination.method ? { method: safeCode(termination.method) } : {}),
    ...(termination.reason ? { reason: safeCode(termination.reason) } : {}),
    ...(typeof termination.destructiveHelperAuthorized === "boolean"
      ? { destructiveHelperAuthorized: termination.destructiveHelperAuthorized }
      : {}),
    ...(typeof termination.helperQuiescenceProven === "boolean"
      ? { helperQuiescenceProven: termination.helperQuiescenceProven }
      : {})
  };
}

function projectRecovery(outcome) {
  const recovery = outcome.recoveryDiagnostics ?? {};
  const mode = CUSTODY_RECOVERY_MODES.includes(recovery.mode) ? recovery.mode : "unknown";
  return {
    automatic: recovery.automatic === true,
    manualInterventionRequired: recovery.manualInterventionRequired === true,
    mode,
    ...(recovery.reason ? { reason: safeCode(recovery.reason) } : {})
  };
}

export function projectDelegateAgentOutcome(outcome) {
  const worktreeRoot = typeof outcome.worktreeRoot === "string"
    ? outcome.worktreeRoot
    : (typeof outcome.retainedWorktreeRoot === "string"
        ? outcome.retainedWorktreeRoot
        : undefined);
  const pathValues = [outcome.effectiveCwd, outcome.canonicalRoot, worktreeRoot]
    .filter((value) => typeof value === "string");
  const publicOutcome = {
    schema: DELEGATE_OUTCOME_SCHEMA,
    status: outcome.status,
    execution: {
      id: bounded(outcome.executionId, 128),
      agentType: safeCode(outcome.agentType, "unknown-agent"),
      status: outcome.status,
      ...(Number.isSafeInteger(outcome.startedAt) && outcome.startedAt >= 0
        ? { startedAt: outcome.startedAt }
        : {}),
      durationMs: Number.isSafeInteger(outcome.durationMs) && outcome.durationMs >= 0
        ? outcome.durationMs
        : 0,
      ...(Number.isSafeInteger(outcome.pid) && outcome.pid >= 0 ? { pid: outcome.pid } : {}),
      requestedModel: bounded(outcome.model || "unknown", 256),
      reasoningEffort: safeCode(outcome.reasoningEffort, "unknown"),
      ...(outcome.error ? {
        error: {
          code: safeCode(outcome.error.code, "claude_execution_failed"),
          message: bounded(outcome.error.message, MAX_ERROR_MESSAGE_CHARS)
        }
      } : {})
    },
    workspace: {
      effectiveCwd: bounded(outcome.effectiveCwd, MAX_PATH_CHARS),
      canonicalRoot: bounded(outcome.canonicalRoot, MAX_PATH_CHARS),
      ...(outcome.canonicalRootSource
        ? { canonicalRootSource: safeCode(outcome.canonicalRootSource) }
        : {}),
      pathsTruncated: pathValues.some((value) => value.length > MAX_PATH_CHARS),
      ...(worktreeRoot ? {
        worktree: {
          root: bounded(worktreeRoot, MAX_PATH_CHARS),
          ...(typeof outcome.baseCommit === "string" ? { baseCommit: outcome.baseCommit } : {}),
          retained: true,
          adopted: typeof outcome.worktreeRoot === "string"
        }
      } : {})
    },
    custody: {
      state: safeCode(outcome.custodyState, "unknown"),
      durableExecutionId: bounded(outcome.executionId, 128),
      durableState: safeCode(outcome.durableCustodyState || outcome.custodyState, "unknown"),
      retained: RETAINED_CUSTODY_STATES.includes(outcome.custodyState),
      orphaned: outcome.custodyState === "orphaned",
      reasons: projectReasons(outcome.custodyReasons),
      recovery: projectRecovery(outcome),
      termination: projectTermination(outcome)
    },
    ...(outcome.reviewBinding ? {
      review: {
        status: ["bound", "unbound", "unavailable"].includes(outcome.reviewBinding.status)
          ? outcome.reviewBinding.status
          : "unavailable",
        coherence: ["held", "denied", "lost", "not-attempted"].includes(outcome.reviewBinding.coherence)
          ? outcome.reviewBinding.coherence
          : "not-attempted",
        ...(validId(outcome.reviewBinding.changeSetId, CHANGE_SET_ID)
          ? { changeSetId: outcome.reviewBinding.changeSetId }
          : {}),
        ...(validId(outcome.reviewBinding.beforeChangeSetId, CHANGE_SET_ID)
          ? { beforeChangeSetId: outcome.reviewBinding.beforeChangeSetId }
          : {}),
        ...(validId(outcome.reviewBinding.afterChangeSetId, CHANGE_SET_ID)
          ? { afterChangeSetId: outcome.reviewBinding.afterChangeSetId }
          : {}),
        ...(validId(outcome.reviewBinding.reviewId, REVIEW_ID)
          ? { reviewId: outcome.reviewBinding.reviewId }
          : {}),
        reasons: projectReasons(outcome.reviewBinding.reasons),
        receiptHistory: projectReceiptHistory(outcome.reviewBinding),
        publication: projectPublication(outcome.reviewBinding.publication)
      }
    } : {})
  };

  const validated = delegateAgentOutputSchema.parse(publicOutcome);
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_PUBLIC_OUTCOME_BYTES) {
    throw new Error("Public delegation outcome exceeded its deterministic size bound.");
  }
  return Object.freeze(validated);
}

/**
 * The transport projection. A defect in projecting a real delegation must not
 * be reported as a rejected request: the execution happened, and its status is
 * the one fact the Lead cannot be allowed to lose. So a projection failure
 * degrades to the same versioned envelope carrying the true status plus an
 * explicit projection diagnostic, and the human-readable text is unaffected.
 */
export function projectDelegateAgentOutcomeForTransport(outcome) {
  try {
    return projectDelegateAgentOutcome(outcome);
  } catch (error) {
    return Object.freeze(delegateAgentOutputSchema.parse({
      schema: DELEGATE_OUTCOME_SCHEMA,
      status: ["completed", "failed", "timeout"].includes(outcome?.status)
        ? outcome.status
        : "rejected",
      error: {
        code: "delegate_outcome_projection_failed",
        message: bounded(
          error instanceof Error ? error.message : String(error),
          MAX_ERROR_MESSAGE_CHARS
        )
      }
    }));
  }
}

export function projectDelegateAgentError(error) {
  return Object.freeze(delegateAgentOutputSchema.parse({
    schema: DELEGATE_OUTCOME_SCHEMA,
    status: "rejected",
    error: {
      code: safeCode(error?.code, "delegate_request_failed"),
      message: bounded(error instanceof Error ? error.message : String(error), MAX_ERROR_MESSAGE_CHARS)
    }
  }));
}
