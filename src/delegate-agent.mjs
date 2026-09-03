import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { AGENT_REGISTRY, getAgentProfile } from "./agent-registry.mjs";
import { loadAgentContract } from "./agent-contracts.mjs";
import {
  RETAINED_CUSTODY_STATES,
  delegateAgentOutputSchema,
  projectDelegateAgentError,
  projectDelegateAgentOutcomeForTransport
} from "./delegate-outcome.mjs";
import {
  describeRuntimeCapabilities,
  resolveCapabilityPolicy
} from "./capability-policy.mjs";
import { buildClaudeEnvironment } from "./claude-environment.mjs";
import {
  ClaudeTimeoutError,
  runClaudeAgent
} from "./claude-runner.mjs";
import {
  effectiveDelegateTimeoutFromEnvironment,
  MAX_SUPPORTED_DELEGATE_TIMEOUT_MS,
  REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS
} from "./timeout-policy.mjs";
import { createRequestDeadlineContext, RequestDeadlineError } from "./request-context.mjs";
import { composeAgentPrompt } from "./prompt-composer.mjs";
import { PROCESS_WRITE_CUSTODY } from "./write-custody.mjs";
import { isSupportedReasoningEffort } from "./reasoning-effort.mjs";
import { isFullyQualifiedRef } from "./git-ref-name.mjs";
import { COLLECTION_DEADLINE_MS, collectChangeSet } from "./changeset/collector.mjs";
import { NO_REVIEW_TARGET } from "./changeset/target.mjs";
import { COHERENCE, createCoherentAdmission } from "./review/coherent-admission.mjs";
import {
  RECEIPT_PUBLICATION_QUIESCENCE_TIMEOUT_MS,
  createReceiptPublicationFence
} from "./review/publication-fence.mjs";
import { ReviewReceiptStore } from "./review/receipt-store.mjs";
import { resolveReviewTargetSpec } from "./review/target-provenance.mjs";
import {
  createReviewBinder,
  profileParticipatesInReviewBinding
} from "./review/review-binding.mjs";
import { resolveCanonicalWorkspaceRoot } from "./workspace-root.mjs";
import {
  GitWorktreeManager,
  resolveRepositoryCoordinationIdentity
} from "./worktree-manager.mjs";

export const DELEGATE_AGENT_TYPES = Object.freeze(Object.keys(AGENT_REGISTRY));
export const MAX_DELEGATE_TASK_CHARS = 100_000;

const DEFAULT_MODEL = "opus";
const DEFAULT_CAPTURE_BYTES = 2 * 1024 * 1024;

export class DelegateAgentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DelegateAgentConfigurationError";
    this.code = "delegate_runtime_configuration_invalid";
  }
}

export class DelegateAgentInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "DelegateAgentInputError";
    this.code = "delegate_input_invalid";
  }
}

function optionalEnvironmentString(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  if (typeof raw !== "string") {
    throw new DelegateAgentConfigurationError(
      name + " must be a non-empty string when configured."
    );
  }

  return raw.trim() || fallback;
}

function positiveIntegerFromEnvironment(env, name, fallback, unit) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new DelegateAgentConfigurationError(
      name + " must be a positive integer number of " + unit + "."
    );
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DelegateAgentConfigurationError(
      name + " must be a positive integer number of " + unit + "."
    );
  }

  return value;
}

function requirePositiveProfileTimeout(profile) {
  if (
    !Number.isSafeInteger(profile.timeoutMs) ||
    profile.timeoutMs <= 0 ||
    profile.timeoutMs > MAX_SUPPORTED_DELEGATE_TIMEOUT_MS
  ) {
    throw new DelegateAgentConfigurationError(
      "Agent profile '" +
        profile.id +
        "' has an invalid timeoutMs; it must be a positive integer no greater than " +
        MAX_SUPPORTED_DELEGATE_TIMEOUT_MS +
        " milliseconds."
    );
  }

  return profile.timeoutMs;
}

/**
 * Resolves the executable backend state for one profile. modelStrategy is
 * intentionally not a historical model lookup: all current strategies use
 * the configured Claude backend until a later multi-provider routing phase.
 *
 * CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS is an explicit operator override. In its
 * absence, the selected profile's timeout remains authoritative.
 */
/**
 * Profiles that may declare a review target.
 *
 * general-purpose records where its work is aimed so a later review of its
 * retained worktree can inherit that target; the two reviewers use it to say
 * what they are reviewing against. No other profile has a use for one, and
 * accepting it silently would imply a behaviour that does not exist.
 */
const TARGET_REF_PROFILES = Object.freeze(["general-purpose", "code-review", "security-review"]);
const REVIEW_ID_PATTERN = /^rr1:[0-9a-f]{64}$/u;

// AFTER includes one full collection plus final custody verification and an
// atomic local receipt write. Its outer bound ensures evidence machinery can
// never retain the shared ownership slot forever.
export const REVIEW_BINDING_FINALIZATION_TIMEOUT_MS = COLLECTION_DEADLINE_MS + 10_000;

/**
 * Runs the AFTER binding under an outer bound, and fences its receipt
 * publication across that bound.
 *
 * The bound stops this coordinator from waiting; it does not stop the binder,
 * and treating it as though it did is exactly how a receipt ends up landing
 * after the custody that authorized it was released. So the timeout does two
 * further things. It cancels the fence, which permanently removes publication
 * authority from a binder that has not yet crossed its durable boundary. And
 * when the boundary has already been crossed - authority can no longer be
 * withdrawn - it waits for the write to quiesce before returning, because the
 * caller's next act is to release coherent-review custody.
 *
 * That quiescence wait is bounded too, and its expiry is not evidence of
 * anything. `publicationUnquiesced` says exactly that: we do not know whether a
 * receipt landed, so the caller must retain custody rather than release it.
 *
 * If the binding does settle while we wait, its result is returned rather than
 * discarded. The same principle cuts both ways: a timer's guess must not
 * override an observation, in either direction. `deadlineExceeded` records that
 * the bound was passed, so a late-but-real binding is reported as what it is
 * rather than as a timeout.
 */
async function finalizeReviewWithinDeadline(operation, {
  timeoutMs = REVIEW_BINDING_FINALIZATION_TIMEOUT_MS,
  quiescenceTimeoutMs = RECEIPT_PUBLICATION_QUIESCENCE_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  requestContext
} = {}) {
  const fence = createReceiptPublicationFence();
  const settled = Promise.resolve()
    .then(() => operation(fence.publication))
    .then((value) => ({ value }), (error) => ({ error }));

  const boundedTimeoutMs = requestContext
    ? Math.max(0, Math.min(timeoutMs, requestContext.remainingMs()))
    : timeoutMs;
  let timer;
  let removeRequestAbort;
  const requestAbort = requestContext
    ? new Promise((resolve) => {
        const onAbort = () => {
          fence.requestCancellation();
          resolve({ requestAborted: true });
        };
        if (requestContext.abortSignal?.aborted) onAbort();
        else {
          requestContext.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
          removeRequestAbort = () => requestContext.abortSignal?.removeEventListener?.("abort", onAbort);
        }
      })
    : undefined;
  const timeout = new Promise((resolve) => {
    timer = schedule(() => resolve({ timedOut: true }), boundedTimeoutMs);
  });
  let outcome;
  try {
    outcome = await Promise.race([
      settled.then((result) => ({ result })),
      timeout,
      ...(requestAbort ? [requestAbort] : [])
    ]);
  } finally {
    cancel(timer);
    removeRequestAbort?.();
  }

  const NOT_ATTEMPTED_PUBLICATION = Object.freeze({
    status: "not-attempted",
    authorityStarted: false,
    settled: false
  });
  const CANCELLED_PUBLICATION = Object.freeze({
    status: "cancelled-before-authority",
    authorityStarted: false,
    settled: false
  });
  const PENDING_PUBLICATION = Object.freeze({
    status: "authoritative-pending",
    authorityStarted: true,
    settled: false
  });
  const settledPublication = (settlement) => Object.freeze({
    ...settlement,
    status: "authoritative-settled",
    authorityStarted: true,
    settled: true
  });

  // A binder result and the publication state are reported together and are
  // never allowed to overwrite each other. In particular a returned binding is
  // preserved even when its publication did not quiesce, and a binder rejection
  // never downgrades an authority that was already crossed: authority, once
  // crossed, cannot be withdrawn by anything the binder subsequently does.
  const report = ({ result, publication, publicationUnquiesced, deadlineExceeded, lateSettlement }) =>
    Object.freeze({
      value: result?.value,
      ...(result?.error ? { operationError: result.error } : {}),
      publicationUnquiesced,
      deadlineExceeded,
      publication,
      ...(lateSettlement ? { lateSettlement } : {})
    });

  /**
   * Only ever entered with publication authority already started. It waits for
   * the fence - not for the binder's callback contract - because only the fence
   * observes the authoritative reviews/cs rename settling.
   */
  async function waitForPublicationQuiescence(observedResult, deadlineExceeded) {
    const boundedQuiescenceTimeoutMs = requestContext
      ? Math.max(0, Math.min(quiescenceTimeoutMs, requestContext.remainingMs()))
      : quiescenceTimeoutMs;
    if (boundedQuiescenceTimeoutMs <= 0) {
      return report({
        result: observedResult,
        publication: PENDING_PUBLICATION,
        publicationUnquiesced: true,
        deadlineExceeded,
        lateSettlement: fence.authoritativeSettlement()
      });
    }
    let quiescenceTimer;
    const quiescence = new Promise((resolve) => {
      quiescenceTimer = schedule(() => resolve({ timedOut: true }), boundedQuiescenceTimeoutMs);
    });
    try {
      const observed = observedResult
        ? { operation: observedResult }
        : await Promise.race([
            settled.then((result) => ({ operation: result })),
            fence.authoritativeSettlement().then((result) => ({ publication: result })),
            quiescence
          ]);
      if (observed.publication) {
        return report({
          publication: settledPublication(observed.publication),
          publicationUnquiesced: false,
          deadlineExceeded
        });
      }
      const result = observed.operation;
      if (result && fence.publicationSettled()) {
        return report({
          result,
          publication: settledPublication(await fence.authoritativeSettlement()),
          publicationUnquiesced: false,
          deadlineExceeded
        });
      }
      // Either nothing has been observed yet, or the binder returned or
      // rejected while an authoritative operation it issued is still live.
      // Neither proves quiescence, so keep waiting on the fence alone.
      const later = await Promise.race([
        fence.authoritativeSettlement().then((publication) => ({ publication })),
        quiescence
      ]);
      if (later.publication) {
        return report({
          result,
          publication: settledPublication(later.publication),
          publicationUnquiesced: false,
          deadlineExceeded
        });
      }
      return report({
        result,
        publication: PENDING_PUBLICATION,
        publicationUnquiesced: true,
        deadlineExceeded,
        lateSettlement: fence.authoritativeSettlement()
      });
    } finally {
      cancel(quiescenceTimer);
    }
  }

  if (outcome.result) {
    const result = outcome.result;
    if (fence.publicationStarted() && !fence.publicationSettled()) {
      return await waitForPublicationQuiescence(result, false);
    }
    if (fence.publicationSettled()) {
      return report({
        result,
        publication: settledPublication(await fence.authoritativeSettlement()),
        publicationUnquiesced: false,
        deadlineExceeded: false
      });
    }
    // Authority was never crossed, so no receipt exists or can appear. Only
    // here is it safe to let a binder rejection propagate as an ordinary
    // failure, because propagating it discards no publication state.
    if (result.error) throw result.error;
    return report({
      result,
      publication: NOT_ATTEMPTED_PUBLICATION,
      publicationUnquiesced: false,
      deadlineExceeded: false
    });
  }

  fence.requestCancellation();
  if (!fence.publicationStarted()) {
    // Authority is gone for good: the store's adjacent cancellation check can
    // never cross the reviews/cs rename boundary after this point.
    return report({
      publication: CANCELLED_PUBLICATION,
      publicationUnquiesced: false,
      deadlineExceeded: true
    });
  }

  return await waitForPublicationQuiescence(undefined, true);
}

function resolveReviewBindingSwitch(env) {
  const value = env?.CLAUDE_AGENTS_REVIEW_BINDING;
  if (value === undefined || value === null || value === "") return "on";
  if (value === "on" || value === "off") return value;
  throw new DelegateAgentConfigurationError(
    "CLAUDE_AGENTS_REVIEW_BINDING must be 'on' or 'off'."
  );
}

function validateDelegationTargetRef(profile, targetRef) {
  if (targetRef === undefined || targetRef === null) return undefined;
  if (!TARGET_REF_PROFILES.includes(profile.id)) {
    throw new DelegateAgentInputError(
      "target_ref is not accepted for agent '" + profile.id + "'."
    );
  }
  if (!isFullyQualifiedRef(targetRef)) {
    throw new DelegateAgentInputError(
      "target_ref must be a fully-qualified ref under refs/heads/ or refs/remotes/."
    );
  }
  return targetRef;
}

function validateReconcileReviewId(reviewId, reconcileOnly) {
  if (reviewId === undefined || reviewId === null) return undefined;
  if (!reconcileOnly) {
    throw new DelegateAgentInputError("review_id is only accepted with reconcile_only=true.");
  }
  if (typeof reviewId !== "string" || !REVIEW_ID_PATTERN.test(reviewId)) {
    throw new DelegateAgentInputError("review_id must be an rr1:<sha256> identifier.");
  }
  return reviewId;
}

/**
 * Why, if at all, this execution occupies the repository's one ownership slot.
 *
 * There is a single admission boundary, so both kinds are decided here rather
 * than being inferred from accessMode at a dozen call sites. A reviewer holds
 * the slot without write authority; a non-review read profile holds nothing.
 */
/**
 * Runs a constructor that may legitimately be unavailable, for example when a
 * custody manager exposes no durable state root. Phase 6 adds evidence and is
 * never allowed to subtract a review, so an unusable evidence pipeline degrades
 * to "no binding" rather than failing the delegation.
 */
function safely(build) {
  try {
    return build();
  } catch {
    return undefined;
  }
}

function buildDefaultReviewBinder({ dependencies, writeCustody, requestContext }) {
  const collectForReview = dependencies.collectChangeSet || ((request, options = {}) => collectChangeSet(
    request,
    {
      readOwnership: (canonicalRepositoryKey) =>
        writeCustody.getWriteAccess(canonicalRepositoryKey),
      ...options
    }
  ));
  return safely(() => createReviewBinder({
    collectChangeSet: collectForReview,
    coherentAdmission: dependencies.coherentAdmission || createCoherentAdmission({ writeCustody }),
    receiptStore: dependencies.receiptStore || new ReviewReceiptStore({
      stateRoot: writeCustody.stateRoot
    }),
    ...(requestContext?.now ? { now: requestContext.now } : {})
  }));
}

function resolveCustodyPlan(profile, runtime, { reconcileOnly = false } = {}) {
  if (reconcileOnly) return "none";
  if (runtime.accessMode === "write") return "write";
  if (runtime.reviewBinding === "on" && profileParticipatesInReviewBinding(profile)) {
    return "coherent-review";
  }
  return "none";
}

export function resolveAgentRuntime(profile, { env = process.env } = {}) {
  if (!profile || typeof profile !== "object") {
    throw new DelegateAgentConfigurationError("An agent profile is required.");
  }

  if (!isSupportedReasoningEffort(profile.reasoningEffort)) {
    throw new DelegateAgentConfigurationError(
      "Agent profile '" + profile.id + "' has unsupported reasoning effort '" +
        String(profile.reasoningEffort) +
        "'."
    );
  }

  if (!["configurable", "inherit", "complementary"].includes(profile.modelStrategy)) {
    throw new DelegateAgentConfigurationError(
      "Agent profile '" + profile.id + "' has unsupported model strategy."
    );
  }

  const profileTimeoutMs = requirePositiveProfileTimeout(profile);
  const capabilityPolicy = resolveCapabilityPolicy(profile);
  const modelOverride = env?.CLAUDE_AGENTS_MODEL;
  const model = optionalEnvironmentString(env, "CLAUDE_AGENTS_MODEL", DEFAULT_MODEL);
  const reviewBinding = resolveReviewBindingSwitch(env);
  const effectiveTimeout = effectiveDelegateTimeoutFromEnvironment(env, profileTimeoutMs);
  if (!effectiveTimeout.valid) {
    throw new DelegateAgentConfigurationError(
      "CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS must be a positive integer no greater than " +
        MAX_SUPPORTED_DELEGATE_TIMEOUT_MS +
        " milliseconds."
    );
  }
  const timeoutMs = effectiveTimeout.timeoutMs;
  const maxCaptureBytes = positiveIntegerFromEnvironment(
    env,
    "CLAUDE_AGENTS_MAX_CAPTURE_BYTES",
    DEFAULT_CAPTURE_BYTES,
    "bytes"
  );

  return Object.freeze({
    claudeBin: optionalEnvironmentString(env, "CLAUDE_AGENTS_CLAUDE_BIN", "claude"),
    model,
    // Where the model selector came from, so a receipt can record the request
    // without ever implying it observed which model actually served it.
    modelSource: typeof modelOverride !== "string" || modelOverride.trim().length === 0
      ? "default"
      : "operator-override",
    modelStrategy: profile.modelStrategy,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs,
    timeoutSource: effectiveTimeout.source,
    maxCaptureBytes,
    accessMode: capabilityPolicy.accessMode,
    permissionMode: capabilityPolicy.permissionMode,
    toolNames: capabilityPolicy.toolNames,
    disallowedTools: capabilityPolicy.disallowedTools,
    shellPolicy: capabilityPolicy.shellPolicy,
    nestedDelegation: capabilityPolicy.nestedDelegation,
    environmentPolicy: capabilityPolicy.environmentPolicy,
    settingsIsolation: capabilityPolicy.settingsIsolation,
    mcpIsolation: capabilityPolicy.mcpIsolation,
    enforcementBoundary: capabilityPolicy.enforcementBoundary,
    childEnvironment: buildClaudeEnvironment(env),
    capabilityDescription: describeRuntimeCapabilities(capabilityPolicy),
    reviewBinding,
    capabilityPolicy
  });
}

export async function resolveDelegationWorkingDirectory(
  requestedCwd,
  { baseCwd = process.cwd(), statFn = stat, requestContext } = {}
) {
  if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
    throw new DelegateAgentInputError("cwd must be a string when supplied.");
  }

  if (requestedCwd !== undefined && requestedCwd.trim().length === 0) {
    throw new DelegateAgentInputError("cwd must not be blank when supplied.");
  }

  const candidate = path.resolve(requestedCwd === undefined ? baseCwd : requestedCwd.trim());
  let details;
  try {
    requestContext?.assertActive?.("cwd-stat");
    details = await statFn(candidate);
  } catch (error) {
    if (error instanceof RequestDeadlineError ||
        error?.code === "claude_cancelled" ||
        error?.code === "delegate_request_deadline_exceeded") {
      throw error;
    }
    throw new DelegateAgentInputError("cwd does not exist: " + candidate);
  }

  if (!details.isDirectory()) {
    throw new DelegateAgentInputError("cwd is not a directory: " + candidate);
  }

  return candidate;
}

function validateDelegationTask(task) {
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new DelegateAgentInputError("task must be a non-empty string.");
  }

  if (task.length > MAX_DELEGATE_TASK_CHARS) {
    throw new DelegateAgentInputError(
      "task is too long (" +
        task.length +
        " chars). Keep delegate_agent assignments at or below " +
        MAX_DELEGATE_TASK_CHARS +
        " characters."
    );
  }
}

function outcomeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: error?.code || "claude_execution_failed",
    message
  };
}

function isRequestStop(error) {
  return error instanceof RequestDeadlineError ||
    error?.code === "claude_cancelled" ||
    error?.code === "delegate_request_deadline_exceeded";
}

function requireExecutionId(createExecutionId) {
  const executionId = createExecutionId();
  if (
    typeof executionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(executionId)
  ) {
    throw new DelegateAgentConfigurationError("Execution ID generation returned an invalid value.");
  }
  return executionId;
}

/**
 * Result fields keep their published Phase 5 names. canonicalRoot is the
 * repositoryRoot and worktreeRoot is the isolated workspaceRoot, so callers
 * that already parse this shape keep working. custodyState is the durable
 * state observed during synchronous finalization; it is intentionally not a
 * live object and an authorized late exact-close recovery may advance the
 * durable record after this outcome has returned.
 */
function baseOutcome({ profile, runtime, workspace, executionId, startedAt, now, custodyState }) {
  return {
    executionId,
    agentType: profile.id,
    effectiveCwd: workspace.effectiveCwd,
    canonicalRoot: workspace.repositoryRoot,
    canonicalRootSource: workspace.rootSource,
    accessMode: runtime.accessMode,
    custodyState,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    timeoutMs: runtime.timeoutMs,
    timeoutSource: runtime.timeoutSource,
    startedAt,
    durationMs: Math.max(0, now() - startedAt),
    runtimeCapabilities: runtime.capabilityDescription,
    ...(workspace.workspaceRoot ? { worktreeRoot: workspace.workspaceRoot } : {}),
    ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {})
  };
}

function failedStatus(error) {
  return (
    error instanceof ClaudeTimeoutError ||
    error instanceof RequestDeadlineError ||
    error?.code === "claude_timeout" ||
    error?.code === "claude_cancelled" ||
    error?.code === "delegate_request_deadline_exceeded" ||
    error?.timeoutOccurred === true
  )
    ? "timeout"
    : "failed";
}

function custodyRetentionError(
  existingError,
  { terminalProofAvailable = false, workspacePreparationAmbiguous = false } = {}
) {
  // A Git deadline never proves that Git did nothing. Say exactly that instead
  // of borrowing the Claude termination wording, which would be untrue here:
  // no Claude child was ever started.
  if (workspacePreparationAmbiguous) {
    return {
      code: "worktree_preparation_ambiguous",
      message:
        "Write custody retained because isolated worktree preparation timed out after Git started, " +
        "so its repository side effects are unproven." +
        (existingError?.message ? " Preparation failure: " + existingError.message : "")
    };
  }

  if (existingError?.code === "claude_termination_unproven") {
    return {
      code: existingError.code,
      message:
        typeof existingError.message === "string" && existingError.message.length > 0
          ? existingError.message
          : "Write custody retained because Claude child termination could not be proven."
    };
  }

  if (terminalProofAvailable) {
    return {
      code: "write_custody_release_failed",
      message:
        "Write custody retained because the terminal proof could not be applied to its owning reservation." +
        (existingError?.message ? " Release failure: " + existingError.message : "")
    };
  }

  return {
    code: "claude_termination_unproven",
    message:
      "Write custody retained because Claude child termination could not be proven." +
      (existingError?.message ? " Original failure: " + existingError.message : "")
  };
}

/**
 * The one place that decides which release the available terminal evidence
 * authorizes, returning the exact call to make or nothing at all.
 *
 * Both the synchronous custody finalization and the late publication-settlement
 * release ask this same question. Asking it in two places is how the late path
 * quietly becomes more permissive than the path it stands in for, which on a
 * custody boundary is the one drift that must not be possible.
 */
function authorizedCustodyRelease({
  writeCustody,
  executionId,
  canonicalRootKey,
  writerProcessStarted,
  processProvenNotStarted,
  workspacePreparationAmbiguous,
  terminalProof,
  unstartedReleaseAllowed
}) {
  if (
    !writerProcessStarted &&
    processProvenNotStarted &&
    !workspacePreparationAmbiguous &&
    unstartedReleaseAllowed
  ) {
    return () => writeCustody.releaseUnstartedWriteAccess({ executionId, canonicalRootKey });
  }
  // A proof without a processIdentity is supervised close evidence: this
  // coordinator spawned the exact child and saw it close before a durable
  // identity could be captured. Custody validates that claim.
  if (writerProcessStarted && terminalProof) {
    return terminalProof.supervisedByCoordinator === true
      ? () => writeCustody.releaseWriteAccessAfterSupervisedClose({
          executionId,
          canonicalRootKey,
          terminalProof
        })
      : () => writeCustody.releaseWriteAccessAfterTerminal({
          executionId,
          canonicalRootKey,
          terminalProof
        });
  }
  return undefined;
}

function buildTerminationDiagnostics({
  lifecycleEvidence,
  writerProcessStarted,
  writerProcessIdentity,
  terminalProof,
  processProvenNotStarted
}) {
  const forced = lifecycleEvidence?.terminationResult;
  // Three states, not two: proven quiescent, proven unquiescent, and no
  // destructive helper involved at all. Only the first two are reportable
  // booleans; the third stays absent rather than being reported as `false`.
  const helperQuiescenceProven = forced?.helperQuiescenceUnproven === true
    ? false
    : (forced?.taskkillHelperCloseProven === true ? true : undefined);
  return Object.freeze({
    processStarted: writerProcessStarted,
    processIdentity: writerProcessIdentity
      ? "recorded"
      : (processProvenNotStarted ? "not-started" : "unavailable"),
    terminalProof: terminalProof?.event === "close"
      ? "close"
      : (processProvenNotStarted ? "not-required" : "unavailable"),
    forcedTerminationStatus: typeof forced?.status === "string" ? forced.status : "not-attempted",
    ...(typeof forced?.method === "string" ? { method: forced.method } : {}),
    ...(typeof forced?.reason === "string" ? { reason: forced.reason } : {}),
    ...(typeof forced?.destructiveHelperAuthorized === "boolean"
      ? { destructiveHelperAuthorized: forced.destructiveHelperAuthorized }
      : {}),
    ...(typeof helperQuiescenceProven === "boolean" ? { helperQuiescenceProven } : {})
  });
}

function buildRecoveryDiagnostics({
  custodyState,
  custodyReason,
  lateTerminalRecoveryAllowed,
  lateReviewReleaseArmed
}) {
  if (lateReviewReleaseArmed) {
    return Object.freeze({
      automatic: true,
      manualInterventionRequired: false,
      mode: "same-coordinator-publication-settlement",
      reason: "review_receipt_publication_unquiesced"
    });
  }
  if (custodyState === "orphaned" && lateTerminalRecoveryAllowed) {
    return Object.freeze({
      automatic: true,
      manualInterventionRequired: false,
      mode: "same-coordinator-terminal-proof",
      ...(custodyReason ? { reason: custodyReason } : {})
    });
  }
  if (RETAINED_CUSTODY_STATES.includes(custodyState)) {
    return Object.freeze({
      automatic: false,
      manualInterventionRequired: true,
      mode: "manual-required",
      ...(custodyReason ? { reason: custodyReason } : {})
    });
  }
  return Object.freeze({
    automatic: false,
    manualInterventionRequired: false,
    mode: "not-needed"
  });
}

/**
 * Executes exactly one explicit profile delegation. Dependencies are injectable
 * so unit tests can verify composition and lifecycle behavior without a real
 * Claude process.
 */
export async function delegateAgent(input, dependencies = {}) {
  const agentType = input?.agentType;
  const task = input?.task;
  const cwd = input?.cwd;
  const requestedTargetRef = input?.targetRef;
  const requestedReviewId = input?.reviewId ?? input?.review_id;
  const abortSignal = input?.abortSignal ?? dependencies.abortSignal ?? dependencies.clientAbortSignal;
  const reconcileOnly = Boolean(
    input?.reconcileOnly === true ||
    input?.reconcile_only === true
  );
  const getProfile = dependencies.getProfile || getAgentProfile;
  const loadContract = dependencies.loadContract || loadAgentContract;
  const resolveCwd =
    dependencies.resolveWorkingDirectory || resolveDelegationWorkingDirectory;
  const resolveRuntime = dependencies.resolveRuntime || resolveAgentRuntime;
  const resolveWorkspace =
    dependencies.resolveWorkspaceRoot || resolveCanonicalWorkspaceRoot;
  const resolveRepositoryIdentity =
    dependencies.resolveRepositoryIdentity || resolveRepositoryCoordinationIdentity;
  const composePrompt = dependencies.composePrompt || composeAgentPrompt;
  const runAgent = dependencies.runAgent || runClaudeAgent;
  const writeCustody = dependencies.writeCustody || PROCESS_WRITE_CUSTODY;
  const worktreeManager = dependencies.worktreeManager;
  const createExecutionId = dependencies.createExecutionId || randomUUID;
  const env = dependencies.env || process.env;
  const suppliedRequestContext = dependencies.requestContext;
  const now = dependencies.now || suppliedRequestContext?.now || Date.now;

  validateDelegationTask(task);
  const executionId = requireExecutionId(createExecutionId);
  const profile = getProfile(agentType);

  if (reconcileOnly && profile.id !== "code-review" && profile.id !== "security-review") {
    throw new DelegateAgentInputError(
      "reconcile_only is only supported for review profiles (code-review, security-review)."
    );
  }

  const runtime = resolveRuntime(profile, { env });
  const requestStartedAt = now();
  const requestSettlementBudgetMs = dependencies.requestSettlementBudgetMs ??
    REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS;
  const requestContext = suppliedRequestContext || createRequestDeadlineContext({
    deadlineAt: dependencies.requestDeadlineAt ??
      requestStartedAt + runtime.timeoutMs + requestSettlementBudgetMs,
    abortSignal,
    now,
    schedule: dependencies.scheduleRequestDeadline || setTimeout,
    cancelSchedule: dependencies.cancelRequestDeadline || clearTimeout
  });

  try {
  requestContext.assertActive("delegation-entry");
  const targetRef = validateDelegationTargetRef(profile, requestedTargetRef);
  const reviewId = validateReconcileReviewId(requestedReviewId, reconcileOnly);
  const requestedCwd = await requestContext.observe("cwd-resolution", () => resolveCwd(cwd, {
    requestContext
  }));
  const resolvedWorkspace = await requestContext.observe("workspace-resolution", () => resolveWorkspace(requestedCwd, {
    accessMode: runtime.accessMode,
    requestContext
  }));
  const custodyPlan = resolveCustodyPlan(profile, runtime, { reconcileOnly });
  const reviewEnabled = profileParticipatesInReviewBinding(profile) &&
    (runtime.reviewBinding === "on" || reconcileOnly);

  // A coherent review must contend on exactly the key writers contend on. That
  // key is derived from Git's common directory, so a review running inside a
  // linked worktree would otherwise take a different ownership slot than the
  // writer it exists to exclude, and would exclude nobody. Resolution failure
  // is not fatal: the review proceeds advisory, with no coherent admission.
  const reviewBindingReasons = [];
  let workspace = resolvedWorkspace;
  let repositoryIdentityAvailable = true;
  if (custodyPlan !== "none" || reviewEnabled) {
    try {
      workspace = await requestContext.observe("repository-identity", () => resolveRepositoryIdentity(
        resolvedWorkspace,
        { requestContext }
      ));
    } catch (error) {
      if (isRequestStop(error)) throw error;
      if (custodyPlan === "write") throw error;
      repositoryIdentityAvailable = false;
      reviewBindingReasons.push({ code: "repository_identity_unavailable", detail: error?.code });
    }
  }

  const contract = await requestContext.observe("contract-loading", () => loadContract(profile.id));
  const startedAt = requestStartedAt;
  let executionWorkspace = workspace;
  let reservation;
  let custodyState = custodyPlan === "none" ? "not-applicable" : "not-acquired";
  let writerProcessStarted = false;
  let writerProcessIdentity;
  let terminalProof;
  let lifecycleEvidence;
  let lateTerminalRecoveryAllowed = false;
  const custodyReasons = [];
  let custodyReason;
  let processProvenNotStarted = false;
  // Where a worktree may have been left when preparation failed before the
  // delegation could adopt it. Nothing deletes it, so its location is the only
  // thing that makes the resulting retention actionable.
  let retainedWorktreeRoot;
  // Set when a Git process started during worktree preparation and its effect
  // on the repository could not be observed. Custody must then be retained.
  let workspacePreparationAmbiguous = false;
  let runnerInvoked = false;
  let outcome;
  // Everything the review path needs to hand from admission, through the
  // prompt, to the after-collection inside the release window.
  const reviewBinder = reviewEnabled
    ? (dependencies.reviewBinder || buildDefaultReviewBinder({ dependencies, writeCustody, requestContext }))
    : undefined;
  const coherentAdmission = custodyPlan === "coherent-review"
    ? (dependencies.coherentAdmission || safely(() => createCoherentAdmission({ writeCustody })))
    : undefined;
  if (reviewEnabled && (!reviewBinder || (custodyPlan === "coherent-review" && !coherentAdmission))) {
    reviewBindingReasons.push({ code: "review_binding_unavailable" });
  }
  let reviewCoherence = custodyPlan === "coherent-review"
    ? (repositoryIdentityAvailable ? COHERENCE.DENIED : COHERENCE.NOT_ATTEMPTED)
    : COHERENCE.NOT_ATTEMPTED;
  let reviewBeforeState;
  let reviewBinding;
  // Set only when a receipt write was already in flight when the AFTER deadline
  // expired and did not quiesce inside its own bound. It means "a receipt may
  // still land", which forbids releasing the custody that authorized it.
  let reviewPublicationUnquiesced = false;
  let reviewPublication = Object.freeze({
    status: "not-attempted",
    authorityStarted: false,
    settled: false
  });
  let lateReviewPublicationSettlement;
  let lateReviewReleaseArmed = false;
  // Assigned during custody finalization and reused by the late
  // publication-settlement release, so both consult one decision.
  let releaseAuthorizedBy;
  let resolveCustodyFinalization;
  const custodyFinalization = new Promise((resolve) => {
    resolveCustodyFinalization = resolve;
  });

  try {
    if (custodyPlan === "coherent-review" && !coherentAdmission) {
      reviewCoherence = COHERENCE.NOT_ATTEMPTED;
    } else if (
      custodyPlan === "coherent-review" &&
      repositoryIdentityAvailable &&
      workspace.rootSource === "git-boundary"
    ) {
      // The rename that admits this review is the same rename that would admit
      // a writer, so a granted admission excludes managed writers for as long
      // as it is held. A denied one is an ordinary outcome: the review still
      // runs, it simply cannot bind evidence to a state it did not control.
      let admission;
      try {
        requestContext.assertActive("coherent-admission");
        admission = await coherentAdmission.admit({
          executionId,
          agentType: profile.id,
          canonicalRoot: workspace.repositoryRoot,
          canonicalRootKey: workspace.canonicalRepositoryKey,
          ...(targetRef === undefined ? {} : { targetRef }),
          requestContext,
          mutationSignal: requestContext.abortSignal
        });
        requestContext.assertActive("coherent-admission");
      } catch (error) {
        if (requestContext.abortSignal?.aborted) requestContext.assertActive("coherent-admission");
        if (isRequestStop(error)) throw error;
        admission = {
          coherence: COHERENCE.DENIED,
          reasons: [{ code: "coherent_admission_failed", detail: error?.code || error?.name }]
        };
      }
      reviewCoherence = admission.coherence;
      if (admission.coherence === COHERENCE.HELD) {
        reservation = admission.record;
        custodyState = reservation.state.toLowerCase();
        processProvenNotStarted = true;
        try {
          requestContext.assertActive("coherent-admission-lifecycle");
          reservation = await writeCustody.markSpawning({
            executionId,
            canonicalRootKey: workspace.canonicalRepositoryKey,
            mutationSignal: requestContext.abortSignal
          });
          requestContext.assertActive("coherent-admission-lifecycle");
          custodyState = reservation.state.toLowerCase();
        } catch (error) {
          reviewCoherence = COHERENCE.LOST;
          reviewBindingReasons.push({
            code: "coherent_admission_lifecycle_failed",
            detail: error?.code || error?.name
          });
          // The child has not started. Give the ordinary safe-unstarted path a
          // chance to remove the slot before the advisory review runs. If the
          // state is ambiguous, keep the reservation and retry in finally.
          try {
            const released = await writeCustody.releaseUnstartedWriteAccess({
              executionId,
              canonicalRootKey: workspace.canonicalRepositoryKey
            });
            custodyState = released.state.toLowerCase();
            reservation = undefined;
          } catch (releaseError) {
            reviewBindingReasons.push({
              code: "coherent_admission_retained",
              detail: releaseError?.code || releaseError?.name
            });
          }
        }
      } else {
        reviewBindingReasons.push(...(admission.reasons ?? []));
      }
    } else if (custodyPlan === "coherent-review" && repositoryIdentityAvailable) {
      reviewBindingReasons.push({ code: "not_a_git_worktree", detail: workspace.rootSource });
    }

    if (reviewBinder) {
      let targetSpec = NO_REVIEW_TARGET;
      if (reconcileOnly && !repositoryIdentityAvailable && resolvedWorkspace.rootSource === "git-boundary") {
        reviewBeforeState = {
          status: "unavailable",
          coherence: COHERENCE.NOT_ATTEMPTED,
          reasons: [{ code: "repository_identity_unavailable" }],
          priorReviews: [],
          receiptHistory: {
            status: "indeterminate",
            receipts: [],
            diagnostics: [{ code: "review_history_completeness_unproven" }]
          }
        };
      }
      if (!reviewBeforeState) {
      targetSpec = await requestContext.observe("review-target-resolution", () => resolveReviewTargetSpec({
        requestedTargetRef: targetRef,
        effectiveCwd: workspace.effectiveCwd,
        repositoryStateDirectory: repositoryIdentityAvailable && workspace.rootSource === "git-boundary"
          ? safely(() => writeCustody.repositoryStateDirectory(workspace.canonicalRepositoryKey))
          : undefined,
        requestContext
      })).catch((error) => {
        if (isRequestStop(error)) throw error;
        return NO_REVIEW_TARGET;
      });

      try {
        reviewBeforeState = await requestContext.observe("before-history-discovery", () => reviewBinder.before({
          profile,
          runtime,
          contract,
          capabilityPolicy: runtime.capabilityPolicy,
          task,
          workspace,
          coherence: reviewCoherence,
          custodyExecutionId: executionId,
          targetSpec,
          requestContext
        }));
      } catch (error) {
        if (isRequestStop(error)) throw error;
        reviewBeforeState = {
          status: "unavailable",
          coherence: reviewCoherence,
          reasons: [{ code: "review_binding_internal_error", detail: error?.code || error?.name }],
          priorReviews: [],
          receiptHistory: {
            status: "indeterminate",
            receipts: [],
            diagnostics: [{ code: "review_history_unavailable" }]
          }
        };
      }
      }

      if (reconcileOnly) {
        const history = reviewBeforeState?.receiptHistory ?? {
          status: "indeterminate",
          receipts: reviewBeforeState?.priorReviews ?? [],
          diagnostics: [{ code: "review_history_unavailable" }]
        };
        const historyEntries = history.allReceipts ?? history.receipts ?? [];
        const freshEntries = historyEntries.filter((entry) => entry.verdict === "FRESH");
        const staleEntry = historyEntries.find((entry) => entry.verdict === "STALE");
        const indeterminateEntry = historyEntries.find((entry) => entry.verdict === "INDETERMINATE");
        let selectedEntry;
        let reconciliationState = "none";
        if (reviewId) {
          selectedEntry = historyEntries.find((entry) => entry.reviewId === reviewId);
          reconciliationState = selectedEntry ? "requested" : "requested-missing";
        } else if (freshEntries.length > 1) {
          reconciliationState = "ambiguous";
        } else if (history.status !== "complete") {
          reconciliationState = "completeness-unproven";
        } else if (freshEntries.length === 1) {
          selectedEntry = freshEntries[0];
          reconciliationState = "fresh";
        }
        const displayEntry = selectedEntry ?? staleEntry ?? indeterminateEntry ?? historyEntries[0];
        const freshEntry = displayEntry?.verdict === "FRESH" ? displayEntry : undefined;
        const currentChangeSetId = reviewBeforeState?.current?.changeSetId;

        // Semantic result artifact recovery and cryptographic verification
        let artifactOutcome = { status: "not_attempted" };
        if (selectedEntry?.receipt && reviewBinder?.loadResultArtifact) {
          try {
            artifactOutcome = await requestContext.observe("result-artifact-loading", () => reviewBinder.loadResultArtifact({
              canonicalRootKey: workspace.canonicalRepositoryKey,
              receipt: selectedEntry.receipt,
              requestContext
            }));
          } catch (artifactError) {
            if (isRequestStop(artifactError)) {
              throw artifactError;
            }
            artifactOutcome = {
              status: "unreadable",
              error: artifactError?.code || artifactError?.name || "artifact_read_failed"
            };
          }
        }

        const bindingStatus = reconciliationState === "ambiguous"
          ? "ambiguous"
          : ((!selectedEntry || selectedEntry.verdict === "INDETERMINATE") ? "unavailable" : "bound");
        const reviewReasons = [];

        if (reconciliationState === "ambiguous") {
          reviewReasons.push({ code: "review_reconcile_ambiguous" });
        } else if (reconciliationState === "completeness-unproven") {
          reviewReasons.push(...(displayEntry?.reasons ?? []));
          reviewReasons.push({ code: "review_history_completeness_unproven" });
        } else if (reconciliationState === "requested-missing") {
          reviewReasons.push({ code: "review_id_not_recovered" });
        } else if (!selectedEntry) {
          reviewReasons.push({ code: "no_fresh_receipt" });
        } else if (selectedEntry.verdict === "STALE") {
          reviewReasons.push(...(selectedEntry.reasons ?? [{ code: "review_receipt_stale" }]));
        } else if (selectedEntry.verdict === "INDETERMINATE") {
          reviewReasons.push(...(selectedEntry.reasons ?? [{ code: "review_history_indeterminate" }]));
        }

        if (selectedEntry && artifactOutcome.status !== "verified" && artifactOutcome.status !== "not_attempted") {
          reviewReasons.push({
            code: "review_result_artifact_" + artifactOutcome.status,
            ...(artifactOutcome.error ? { detail: String(artifactOutcome.error).slice(0, 64) } : {})
          });
        }

        reviewBinding = {
          status: bindingStatus,
          coherence: reviewCoherence,
          reasons: Object.freeze(reviewReasons),
          changeSetId: displayEntry?.receipt?.binding?.changeSetId ?? currentChangeSetId,
          beforeChangeSetId: currentChangeSetId,
          afterChangeSetId: currentChangeSetId,
          reviewId: selectedEntry?.reviewId ?? null,
          priorReviews: history.receipts ?? [],
          receiptHistory: history,
          publication: {
            status: "not-attempted",
            authorityStarted: false,
            settled: false
          }
        };

        let resultMessage;
        if (reconciliationState === "ambiguous") {
          resultMessage =
            `Multiple FRESH authoritative review receipts apply to current changeSet ${currentChangeSetId}; reconciliation is AMBIGUOUS.\n` +
            `Provide review_id to recover one exact receipt.\n` +
            `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
        } else if (reconciliationState === "completeness-unproven") {
          resultMessage = indeterminateEntry
            ? `Discovered prior review receipt ${indeterminateEntry.reviewId} has INDETERMINATE freshness for current repository state.\n` +
              `Reasons: ${(indeterminateEntry.reasons || []).map((reason) => reason.code).join(", ")}\n` +
              `Authoritative review-history completeness is unproven; no receipt was selected.\n` +
              `A fresh ${profile.id} delegation is required.\n` +
              `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`
            : `Authoritative review-history completeness is unproven for scope ${profile.id}; no receipt was selected.\n` +
              `Reason: review_history_completeness_unproven.\n` +
              `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
        } else if (reconciliationState === "requested-missing") {
          resultMessage =
            `Requested review receipt ${reviewId} was not recovered for this repository, profile, and target scope.\n` +
            `Reconciliation fails closed.\n` +
            `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
        } else if (freshEntry && selectedEntry) {
          if (artifactOutcome.status === "verified") {
            resultMessage =
              `Reconciled authoritative review receipt ${freshEntry.reviewId} (FRESH for changeSet ${currentChangeSetId}).\n` +
              `Agent: ${profile.id}\n` +
              `Target: ${targetSpec?.spec?.ref || "uncommitted HEAD"}\n` +
              `Freshness: FRESH (receipt ChangeSet matches current repository state)\n` +
              `Result Artifact: VERIFIED (SHA-256: ${freshEntry.receipt.result.sha256}, ${artifactOutcome.bytes} bytes)\n\n` +
              `[Recovered Specialist Review Findings]\n` +
              `${artifactOutcome.text}\n\n` +
              `Notice: A FRESH receipt proves the review was conducted on this exact ChangeSet; review findings above determine whether the verdict was clean or defects were identified.\n` +
              `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
          } else {
            resultMessage =
              `Discovered review receipt ${freshEntry.reviewId} is FRESH for current changeSet ${currentChangeSetId}, but semantic reviewer output is ${artifactOutcome.status} (${artifactOutcome.error || "unavailable"}).\n` +
              `Result artifact verification failed: cannot verify reviewer findings or determine if the review was clean.\n` +
              `A fresh ${profile.id} delegation is required.\n` +
              `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
          }
        } else if (staleEntry) {
          resultMessage =
            `Discovered prior review receipt ${staleEntry.reviewId} is STALE for current changeSet ${currentChangeSetId}.\n` +
            `Historical ChangeSet: ${staleEntry.receipt?.binding?.changeSetId || "unknown"}\n` +
            `Changed sections: ${(staleEntry.changedSections || []).join(", ") || "none"}\n` +
            `Reasons: ${(staleEntry.reasons || []).map((r) => r.code).join(", ")}\n` +
            `A fresh ${profile.id} delegation is required for the updated ChangeSet.\n` +
            `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
        } else if (indeterminateEntry) {
          resultMessage =
            `Discovered prior review receipt ${indeterminateEntry.reviewId} has INDETERMINATE freshness for current repository state.\n` +
            `Reasons: ${(indeterminateEntry.reasons || []).map((r) => r.code).join(", ")}\n` +
            `A fresh ${profile.id} delegation is required.\n` +
            `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
        } else {
          resultMessage =
            `No prior review receipts discovered for scope ${profile.id} in this repository.\n` +
            `Current ChangeSetId: ${currentChangeSetId || "unavailable"}\n` +
            `No Claude specialist was spawned; 0 Claude delegated-model quota consumed.`;
        }

        outcome = {
          ...baseOutcome({
            profile,
            runtime,
            workspace: executionWorkspace,
            executionId,
            startedAt,
            now,
            custodyState
          }),
          status: "completed",
          accessMode: "read",
          durationMs: Math.max(0, now() - startedAt),
          result: resultMessage,
          stderrSummary: ""
        };
      }
    }

    if (!reconcileOnly) {
      if (custodyPlan === "write") {
        requestContext.assertActive("write-admission");
        reservation = await writeCustody.reserveWriteAccess({
          executionId,
          agentType: profile.id,
          canonicalRoot: workspace.repositoryRoot,
          canonicalRootKey: workspace.canonicalRepositoryKey,
          ...(targetRef === undefined ? {} : { targetRef }),
          mutationSignal: requestContext.abortSignal
        });
        requestContext.assertActive("write-admission");
        custodyState = reservation.state.toLowerCase();
        processProvenNotStarted = true;

        if (profile.id === "general-purpose") {
          const isolatedWorktrees = worktreeManager || new GitWorktreeManager({ writeCustody });
          requestContext.assertActive("worktree-preparation");
          executionWorkspace = await isolatedWorktrees.prepare({
            executionId,
            canonicalRepositoryKey: workspace.canonicalRepositoryKey,
            repositoryRoot: workspace.repositoryRoot,
            effectiveCwd: workspace.effectiveCwd,
            requestContext
          });
          requestContext.assertActive("worktree-preparation");
        } else {
          requestContext.assertActive("write-mark-spawning");
          reservation = await writeCustody.markSpawning({
            executionId,
            canonicalRootKey: workspace.canonicalRepositoryKey,
            mutationSignal: requestContext.abortSignal
          });
          requestContext.assertActive("write-mark-spawning");
          custodyState = reservation.state.toLowerCase();
        }
      }

      // The root Claude actually operates in: the isolated worktree for
      // general-purpose, the coordinated repository root for everyone else.
      requestContext.assertActive("prompt-composition");
      const workspaceRoot = executionWorkspace.workspaceRoot || executionWorkspace.repositoryRoot;
      const prompt = composePrompt({
        profile,
        contract,
        task,
        effectiveCwd: executionWorkspace.effectiveCwd,
        workspaceRoot,
        repositoryRoot: executionWorkspace.repositoryRoot,
        executionId,
        runtime,
        reviewSubject: reviewBeforeState?.reviewSubject
      });
      const lifecycleCustody = reservation &&
        (custodyPlan === "write" || reviewCoherence === COHERENCE.HELD);
      if (lifecycleCustody) processProvenNotStarted = false;

      runnerInvoked = true;
      const runnerRuntime = {
        ...runtime,
        timeoutMs: requestContext.clipUsefulWorkTimeout(
          runtime.timeoutMs,
          requestSettlementBudgetMs
        )
      };
      const execution = await runAgent({
        profile,
        agentType: profile.id,
        prompt,
        cwd: executionWorkspace.effectiveCwd,
        // Process identity binds to the repository that granted custody, which
        // is the same root the prompt reports as the repository root.
        repositoryRoot: executionWorkspace.repositoryRoot,
        executionId,
        runtime: runnerRuntime,
        abortSignal: requestContext.abortSignal,
        now: requestContext.now,
        schedule: requestContext.schedule,
        cancelSchedule: requestContext.cancelSchedule,
        onChildStarted: lifecycleCustody
          ? async (processIdentity, { mutationSignal } = {}) => {
              writerProcessStarted = true;
              writerProcessIdentity = processIdentity;
              try {
                reservation = await writeCustody.activateWriteAccess({
                  executionId,
                  canonicalRootKey: workspace.canonicalRepositoryKey,
                  processIdentity,
                  mutationSignal
                });
                custodyState = reservation.state.toLowerCase();
              } catch (error) {
                if (custodyPlan === "write") throw error;
                reviewCoherence = COHERENCE.LOST;
                reviewBindingReasons.push({
                  code: "coherent_admission_lifecycle_failed",
                  detail: error?.code || error?.name
                });
              }
            }
          : undefined,
        onTerminationStarted: lifecycleCustody
          ? async (processIdentity, { mutationSignal } = {}) => {
              writerProcessStarted = true;
              writerProcessIdentity = processIdentity;
              try {
                reservation = await writeCustody.beginTermination({
                  executionId,
                  canonicalRootKey: workspace.canonicalRepositoryKey,
                  processIdentity,
                  mutationSignal
                });
                custodyState = reservation.state.toLowerCase();
              } catch (error) {
                if (custodyPlan === "write") throw error;
                reviewCoherence = COHERENCE.LOST;
                reviewBindingReasons.push({
                  code: "coherent_admission_lifecycle_failed",
                  detail: error?.code || error?.name
                });
              }
            }
          : undefined,
        onLateTerminalProof: lifecycleCustody
          ? async (lateTerminalProof) => {
              // runClaudeAgent invokes this only after a termination-unproven
              // outcome. Wait until this invocation has durably retained the
              // orphan first, then let the same coordinator's exact close proof
              // take the explicit ORPHANED -> RELEASED recovery path. The
              // already-constructed delegation outcome remains its synchronous
              // custodyState snapshot; the durable record is authoritative.
              await custodyFinalization;
              if (typeof writeCustody.releaseOrphanedWriteAccessAfterTerminal !== "function") return;
              await writeCustody.releaseOrphanedWriteAccessAfterTerminal({
                executionId,
                canonicalRootKey: workspace.canonicalRepositoryKey,
                terminalProof: lateTerminalProof
              });
            }
          : undefined
      });
      writerProcessStarted = writerProcessStarted || execution?.processStarted === true || Boolean(execution?.processIdentity);
      lifecycleEvidence = execution;
      writerProcessIdentity = writerProcessIdentity || execution?.processIdentity;
      terminalProof = execution?.terminalProof;

      outcome = {
        ...baseOutcome({
          profile,
          runtime,
          workspace: executionWorkspace,
          executionId,
          startedAt,
          now,
          custodyState
        }),
        status: "completed",
        durationMs:
          Number.isFinite(execution.durationMs) ? execution.durationMs : Math.max(0, now() - startedAt),
        result: execution.result,
        stderrSummary: execution.stderrSummary || "",
        ...(Number.isSafeInteger(execution.pid) ? { pid: execution.pid } : {})
      };
    }
  } catch (error) {
    lifecycleEvidence = error;
    lateTerminalRecoveryAllowed = error?.lateRecoveryAllowed === true;
    if (!executionWorkspace.workspaceRoot && typeof error?.worktreeRoot === "string") {
      retainedWorktreeRoot = error.worktreeRoot;
    }
    writerProcessStarted = writerProcessStarted || error?.processStarted === true || Boolean(error?.processIdentity);
    writerProcessIdentity = writerProcessIdentity || error?.processIdentity;
    terminalProof = error?.terminalProof;
    processProvenNotStarted = !runnerInvoked || error?.processStarted === false;
    workspacePreparationAmbiguous = error?.sideEffectsUnproven === true;
    outcome = {
      ...baseOutcome({
        profile,
        runtime,
        workspace: executionWorkspace,
        executionId,
        startedAt,
        now,
        custodyState
      }),
      status: failedStatus(error),
      durationMs:
        Number.isFinite(error?.durationMs) ? error.durationMs : Math.max(0, now() - startedAt),
      error: outcomeError(error),
      stderrSummary: error?.stderrSummary || "",
      ...(Number.isSafeInteger(error?.pid) ? { pid: error.pid } : {})
    };
  } finally {
    // The after-collection and the receipt must land INSIDE the interval the
    // admission guards, so they run before anything releases the slot. Both are
    // fully contained: a failure here reports an unbound review and must never
    // delay or prevent the release below.
    if (custodyPlan === "coherent-review" && reviewBinder && !reconcileOnly) {
      if (reviewBeforeState?.status === "unavailable") {
        reviewBinding = {
          status: "unavailable",
          coherence: reviewBeforeState.coherence ?? reviewCoherence,
          reasons: reviewBeforeState.reasons ?? [{ code: "review_binding_unavailable" }],
          priorReviews: reviewBeforeState.priorReviews ?? [],
          receiptHistory: reviewBeforeState.receiptHistory ?? {
            status: "indeterminate",
            receipts: reviewBeforeState.priorReviews ?? [],
            diagnostics: [{ code: "review_history_status_missing" }]
          },
          publication: reviewPublication
        };
      } else try {
        const stateForAfter = reviewBeforeState && reviewBeforeState.coherence !== reviewCoherence
          ? { ...reviewBeforeState, coherence: reviewCoherence }
          : reviewBeforeState;
        const finalized = await finalizeReviewWithinDeadline(
          (publication) => reviewBinder.after({
            beforeState: stateForAfter,
            workspace,
            outcome,
            executionId,
            startedAt,
            completedAt: now(),
            publication,
            requestContext
          }),
          {
            timeoutMs: dependencies.reviewBindingAfterTimeoutMs,
            quiescenceTimeoutMs: dependencies.reviewReceiptQuiescenceTimeoutMs,
            schedule: dependencies.scheduleReviewBindingTimeout || requestContext.schedule,
            cancel: dependencies.cancelReviewBindingTimeout || requestContext.cancelSchedule,
            requestContext
          }
        );
        reviewBinding = finalized.value;
        reviewPublicationUnquiesced = finalized.publicationUnquiesced === true;
        reviewPublication = finalized.publication;
        lateReviewPublicationSettlement = finalized.lateSettlement;
        if (!reviewBinding) {
          const history = reviewBeforeState?.receiptHistory ?? {
            status: "indeterminate",
            receipts: reviewBeforeState?.priorReviews ?? [],
            diagnostics: [{ code: "review_history_status_missing" }]
          };
          // The binder produced no reportable value. Why it did not is itself
          // evidence: a rejection observed after publication authority had
          // already been crossed is an internal binder failure, not a timeout,
          // and saying "timeout" there would misdescribe why custody is held.
          const absenceReason = finalized.operationError
            ? {
                code: "review_binding_internal_error",
                detail: finalized.operationError?.code || finalized.operationError?.name
              }
            : { code: "review_binding_timeout" };
          reviewBinding = reviewPublication.disposition === "published"
            ? {
                status: "bound",
                coherence: COHERENCE.HELD,
                reasons: [
                  { code: "review_binding_deadline_exceeded" },
                  ...(finalized.operationError ? [absenceReason] : [])
                ],
                changeSetId: reviewPublication.changeSetId,
                beforeChangeSetId: reviewPublication.changeSetId,
                afterChangeSetId: reviewPublication.changeSetId,
                reviewId: reviewPublication.reviewId,
                priorReviews: history.receipts,
                receiptHistory: history
              }
            : {
                status: "unavailable",
                coherence: reviewCoherence,
                reasons: [
                  absenceReason,
                  ...(reviewPublicationUnquiesced
                    ? [{ code: "review_receipt_publication_unquiesced" }]
                    : [])
                ],
                priorReviews: history.receipts,
                receiptHistory: history
              };
        } else if (finalized.operationError) {
          // A real binding value alongside a rejection can only come from a
          // binder that resolved and then failed after its authority crossed.
          reviewBindingReasons.push({
            code: "review_binding_internal_error",
            detail: finalized.operationError?.code || finalized.operationError?.name
          });
          if (finalized.deadlineExceeded) {
            reviewBindingReasons.push({ code: "review_binding_deadline_exceeded" });
          }
        } else if (finalized.deadlineExceeded) {
          // The binding outran its bound but was then observed to finish while
          // its publication was being waited on. Discarding a real result to
          // preserve the timer's guess would be the same error the fence exists
          // to prevent, so the expired bound is recorded beside the result.
          reviewBindingReasons.push({ code: "review_binding_deadline_exceeded" });
        }
        reviewBinding = { ...reviewBinding, publication: reviewPublication };
      } catch (error) {
        reviewBinding = {
          status: "unavailable",
          coherence: reviewCoherence,
          reasons: [{ code: "review_binding_internal_error", detail: error?.code }],
          priorReviews: [],
          receiptHistory: {
            status: "indeterminate",
            receipts: [],
            diagnostics: [{ code: "review_history_unavailable" }]
          },
          publication: reviewPublication
        };
      }
    }

    // Bound to the evidence this invocation actually gathered, so the
    // synchronous release below and the late publication-settlement release
    // further down cannot answer the same question differently.
    releaseAuthorizedBy = (unstartedReleaseAllowed) => authorizedCustodyRelease({
      writeCustody,
      executionId,
      canonicalRootKey: workspace.canonicalRepositoryKey,
      writerProcessStarted,
      processProvenNotStarted,
      workspacePreparationAmbiguous,
      terminalProof,
      unstartedReleaseAllowed
    });
    // A completed write execution must present terminal proof; only a failed
    // one, or a coherent review, may release on "never started".
    const synchronousRelease = releaseAuthorizedBy(
      outcome?.status !== "completed" || custodyPlan === "coherent-review"
    );

    try {
      if (reservation) {
        try {
          if (custodyPlan === "coherent-review" && reviewPublicationUnquiesced) {
            // A receipt write is still in flight and its quiescence was never
            // observed. Releasing the slot now could let a receipt become
            // durable after the custody it cites was gone, so the slot stays
            // retained and reconciles under the unchanged Phase 5 rules.
            custodyState = "retained";
            custodyReason = "review_receipt_publication_unquiesced";
            custodyReasons.push({ code: custodyReason });
            reviewBindingReasons.push({
              code: "coherent_admission_retained",
              detail: "review_receipt_publication_unquiesced"
            });
            lateReviewReleaseArmed = Boolean(lateReviewPublicationSettlement);
          } else if (synchronousRelease) {
            const released = await synchronousRelease();
            custodyState = released.state.toLowerCase();
            reservation = released;
          } else {
            const orphaned = await writeCustody.markOrphanedWriteAccess({
              executionId,
              canonicalRootKey: workspace.canonicalRepositoryKey,
              processIdentity: writerProcessIdentity,
              reason: workspacePreparationAmbiguous
                ? "worktree-preparation-ambiguous"
                : "terminal-proof-unavailable"
            });
            custodyState = orphaned.state.toLowerCase();
            reservation = orphaned;
            custodyReason = workspacePreparationAmbiguous
              ? "worktree-preparation-ambiguous"
              : "terminal-proof-unavailable";
            custodyReasons.push({ code: custodyReason });
            if (custodyPlan === "write") {
              outcome = {
                ...baseOutcome({
                  profile,
                  runtime,
                  workspace: executionWorkspace,
                  executionId,
                  startedAt,
                  now,
                  custodyState
                }),
                status: outcome?.status === "timeout" ? "timeout" : "failed",
                durationMs: outcome?.durationMs ?? Math.max(0, now() - startedAt),
                error: custodyRetentionError(outcome?.error, { workspacePreparationAmbiguous }),
                stderrSummary: outcome?.stderrSummary || "",
                ...(Number.isSafeInteger(outcome?.pid) ? { pid: outcome.pid } : {})
              };
            } else {
              reviewBindingReasons.push({ code: "coherent_admission_retained" });
            }
          }
          if (outcome) outcome.custodyState = custodyState;
        } catch (releaseError) {
          try {
            const orphaned = await writeCustody.markOrphanedWriteAccess({
              executionId,
              canonicalRootKey: workspace.canonicalRepositoryKey,
              processIdentity: writerProcessIdentity,
              reason: "custody-release-proof-failed"
            });
            custodyState = orphaned.state.toLowerCase();
            reservation = orphaned;
            custodyReason = "custody-release-proof-failed";
            custodyReasons.push({
              code: custodyReason,
              ...(typeof releaseError?.code === "string" ? { detail: releaseError.code } : {})
            });
          } catch {
            custodyState = "retention-failed";
            custodyReason = "custody-retention-failed";
            custodyReasons.push({ code: custodyReason });
          }
          if (custodyPlan === "write") {
            outcome = {
              ...baseOutcome({
                profile,
                runtime,
                workspace: executionWorkspace,
                executionId,
                startedAt,
                now,
                custodyState
              }),
              status: outcome?.status === "timeout" ? "timeout" : "failed",
              error: custodyRetentionError(releaseError, {
                terminalProofAvailable: Boolean(terminalProof),
                workspacePreparationAmbiguous
              }),
              stderrSummary: outcome?.stderrSummary || ""
            };
          } else {
            if (outcome) outcome.custodyState = custodyState;
            reviewBindingReasons.push({
              code: "coherent_admission_retained",
              detail: releaseError?.code
            });
          }
        }
      }
    } finally {
      resolveCustodyFinalization();
    }
  }

  if (lateReviewReleaseArmed) {
    // A bounded quiescence timeout is uncertainty, not permanent ownership.
    // Only this exact publication promise and this still-live coordinator may
    // attempt the guarded release, using the same terminal evidence the
    // synchronous path would have required. Ownership/revision checks inside
    // custody reject a moved or foreign record and leave it fail-closed.
    const lateRelease = lateReviewPublicationSettlement.then(async (publicationSettlement) => {
      await custodyFinalization;
      if (publicationSettlement?.status !== "settled" || !reservation) return;
      try {
        // Exactly the release the synchronous path would have performed: this
        // is a coherent review, so the unstarted case is permitted here for
        // the same reason it is there.
        const release = releaseAuthorizedBy?.(true);
        if (!release) {
          await dependencies.onLateReviewPublicationRelease?.({
            status: "retained",
            executionId,
            publication: publicationSettlement,
            errorCode: "terminal_proof_unavailable"
          });
          return;
        }
        await release();
        await dependencies.onLateReviewPublicationRelease?.({
          status: "released",
          executionId,
          publication: publicationSettlement
        });
      } catch (error) {
        try {
          await dependencies.onLateReviewPublicationRelease?.({
            status: "retained",
            executionId,
            publication: publicationSettlement,
            errorCode: error?.code || error?.name
          });
        } catch {
          // Diagnostics cannot grant release authority or destabilize the MCP.
        }
        }
      });
    // Nothing awaits this deliberately detached release, so it must never be
    // able to surface as an unhandled rejection in the MCP process.
    void lateRelease.catch(() => {});
  }

  if (outcome && requestContext.abortSignal?.aborted) {
    let requestStop;
    try {
      requestContext.assertActive("delegation-settlement");
    } catch (error) {
      if (isRequestStop(error)) requestStop = error;
    }
    if (requestStop) {
      outcome = {
        ...baseOutcome({
          profile,
          runtime,
          workspace: executionWorkspace,
          executionId,
          startedAt,
          now,
          custodyState
        }),
        status: failedStatus(requestStop),
        durationMs: Math.max(0, now() - startedAt),
        error: outcomeError(requestStop),
        stderrSummary: outcome.stderrSummary || "",
        ...(Number.isSafeInteger(outcome.pid) ? { pid: outcome.pid } : {})
      };
    }
  }

  if (outcome && reviewBinding) {
    outcome.reviewBinding = mergeReviewBindingReasons(reviewBinding, reviewBindingReasons);
  }

  if (outcome) {
    if (retainedWorktreeRoot) outcome.retainedWorktreeRoot = retainedWorktreeRoot;
    outcome.durableCustodyState = typeof reservation?.state === "string"
      ? reservation.state.toLowerCase()
      : custodyState;
    outcome.custodyReasons = Object.freeze(custodyReasons);
    outcome.terminationDiagnostics = buildTerminationDiagnostics({
      lifecycleEvidence,
      writerProcessStarted,
      writerProcessIdentity,
      terminalProof,
      processProvenNotStarted
    });
    outcome.recoveryDiagnostics = buildRecoveryDiagnostics({
      custodyState,
      custodyReason,
      lateTerminalRecoveryAllowed,
      lateReviewReleaseArmed
    });
  }

  return outcome;
  } finally {
    requestContext.dispose?.();
  }
}

/**
 * Folds reasons gathered before the binder existed (identity resolution, denied
 * admission) into its result, so a caller sees one ordered list rather than
 * having to know which stage produced which code.
 */
function mergeReviewBindingReasons(binding, earlierReasons) {
  const base = binding || {
    status: "unavailable",
    coherence: COHERENCE.NOT_ATTEMPTED,
    reasons: [],
    priorReviews: []
  };
  if (earlierReasons.length === 0) return Object.freeze({ ...base });
  return Object.freeze({
    ...base,
    reasons: Object.freeze([...earlierReasons, ...(base.reasons ?? [])])
  });
}

export function formatDelegateAgentOutcome(outcome) {
  const lines = [
    "Agent: " + outcome.agentType,
    "ExecutionId: " + outcome.executionId,
    "Status: " + outcome.status,
    "AccessMode: " + outcome.accessMode,
    "EffectiveCwd: " + outcome.effectiveCwd,
    "CanonicalRoot: " + outcome.canonicalRoot,
    "CanonicalRootSource: " + (outcome.canonicalRootSource || "unknown"),
    "CustodyState: " + outcome.custodyState,
    "DurableCustodyState: " + (outcome.durableCustodyState || outcome.custodyState),
    "Model: " + outcome.model,
    "ReasoningEffort: " + outcome.reasoningEffort,
    "TimeoutMs: " + outcome.timeoutMs,
    "TimeoutSource: " + outcome.timeoutSource,
    "DurationMs: " + outcome.durationMs,
    "RuntimeCapabilities: " + outcome.runtimeCapabilities
  ];

  if (Number.isSafeInteger(outcome.pid)) {
    lines.push("Pid: " + outcome.pid);
  }
  if (outcome.worktreeRoot) {
    lines.push("WorktreeRoot: " + outcome.worktreeRoot);
  }
  if (outcome.retainedWorktreeRoot) {
    lines.push("RetainedWorktreeRoot: " + outcome.retainedWorktreeRoot);
  }
  if (outcome.baseCommit) {
    lines.push("BaseCommit: " + outcome.baseCommit);
  }
  if (outcome.custodyReasons?.length) {
    lines.push(
      "CustodyReasons: " + outcome.custodyReasons.slice(0, 32).map((reason) => reason.code).join(", ")
    );
  }
  if (outcome.recoveryDiagnostics) {
    lines.push("RecoveryMode: " + outcome.recoveryDiagnostics.mode);
    lines.push(
      "ManualInterventionRequired: " +
        String(outcome.recoveryDiagnostics.manualInterventionRequired === true)
    );
  }
  if (outcome.terminationDiagnostics) {
    lines.push("ProcessStarted: " + String(outcome.terminationDiagnostics.processStarted));
    lines.push("ProcessIdentity: " + outcome.terminationDiagnostics.processIdentity);
    lines.push("TerminalProof: " + outcome.terminationDiagnostics.terminalProof);
    lines.push(
      "ForcedTerminationStatus: " + outcome.terminationDiagnostics.forcedTerminationStatus
    );
  }
  if (outcome.reviewBinding) {
    const binding = outcome.reviewBinding;
    lines.push("ReviewBinding: " + binding.status);
    lines.push("ReviewCoherence: " + binding.coherence);
    if (binding.changeSetId) lines.push("ChangeSetId: " + binding.changeSetId);
    if (binding.beforeChangeSetId) lines.push("BeforeChangeSetId: " + binding.beforeChangeSetId);
    if (binding.afterChangeSetId) lines.push("AfterChangeSetId: " + binding.afterChangeSetId);
    if (binding.reviewId) lines.push("ReviewId: " + binding.reviewId);
    const history = binding.receiptHistory;
    if (history) {
      lines.push("ReceiptHistoryStatus: " + history.status);
      const totalHistoryCount = Number.isSafeInteger(history.totalCount) &&
        history.totalCount >= history.receipts.length
        ? history.totalCount
        : history.receipts.length;
      lines.push("PriorReviews: " + totalHistoryCount);
      if (totalHistoryCount > history.receipts.length) {
        lines.push("PriorReviewsDisplayed: " + history.receipts.length);
      }
      for (const prior of history.receipts.slice(0, 16)) {
        const details = [
          prior.reviewId,
          prior.agentType,
          prior.verdict,
          prior.changeSetId,
          prior.changedSections?.length ? "changed=" + prior.changedSections.join("+") : "",
          prior.basisDifferences?.length ? "basis=" + prior.basisDifferences.join("+") : ""
        ].filter(Boolean);
        lines.push("PriorReview: " + details.join(" "));
      }
      if (history.diagnostics?.length) {
        lines.push(
          "ReceiptHistoryDiagnostics: " +
            history.diagnostics.slice(0, 16).map((reason) => reason.code).join(", ")
        );
      }
    } else if (binding.priorReviews?.length) {
      lines.push("ReceiptHistoryStatus: indeterminate");
      lines.push("PriorReviews: " + binding.priorReviews.length);
    }
    if (binding.publication) {
      lines.push("ReceiptPublication: " + binding.publication.status);
      if (binding.publication.disposition) {
        lines.push("ReceiptPublicationDisposition: " + binding.publication.disposition);
      }
    }
    if (binding.reasons?.length) {
      lines.push(
        "ReviewBindingReasons: " +
          binding.reasons.slice(0, 32).map((reason) => reason.code).join(", ")
      );
    }
  }

  if (outcome.status === "completed") {
    lines.push("", outcome.result);
  } else {
    lines.push("", "ErrorCode: " + outcome.error.code, "Error: " + outcome.error.message);
    if (outcome.stderrSummary) {
      lines.push("", "StderrSummary:", outcome.stderrSummary);
    }
  }

  return lines.join("\n");
}

export const delegateAgentInputSchema = z.object({
  agent_type: z
    .enum(DELEGATE_AGENT_TYPES)
    .describe("Registered specialist profile to run in a fresh Claude process."),
  task: z
    .string()
    .refine((value) => value.trim().length > 0, "task must not be blank.")
    .max(MAX_DELEGATE_TASK_CHARS)
    .describe(
      "Self-contained dynamic assignment from the Lead. Include task-specific scope, evidence, constraints, and desired output."
    ),
  cwd: z
    .string()
    .refine((value) => value.trim().length > 0, "cwd must not be blank when supplied.")
    .optional()
    .describe(
      "Repository/workspace directory Claude should inspect. Defaults to the MCP server process cwd."
    ),
  target_ref: z
    .string()
    .refine(isFullyQualifiedRef, "target_ref must be a fully-qualified refs/heads/ or refs/remotes/ ref.")
    .optional()
    .describe(
      "Fully-qualified ref this work or review is aimed at, for example refs/remotes/origin/main. " +
        "Accepted only for general-purpose, code-review and security-review. Never inferred: omit it " +
        "and the change set records that no target was declared."
    ),
  reconcile_only: z
    .boolean()
    .optional()
    .describe(
      "When true, inspects existing durable review receipts and returns dynamic freshness for the " +
        "repository state without running Claude Code or consuming model quota. Only valid for " +
      "review profiles (code-review, security-review)."
    ),
  review_id: z
    .string()
    .regex(REVIEW_ID_PATTERN, "review_id must be an rr1:<sha256> identifier.")
    .optional()
    .describe(
      "Optional exact historical review receipt to recover. Accepted only with reconcile_only=true; " +
      "without it, reconciliation refuses to choose among multiple FRESH receipts."
    )
});

function mcpText(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

export function registerDelegateAgentTool(server, { delegate = delegateAgent } = {}) {
  server.registerTool(
    "delegate_agent",
    {
      description:
        "Run one explicitly selected registered specialist in a fresh Claude Code process. The task is a dynamic assignment supplied by the Lead.",
      inputSchema: delegateAgentInputSchema,
      outputSchema: delegateAgentOutputSchema
    },
    async ({
      agent_type: agentType,
      task,
      cwd,
      target_ref: targetRef,
      reconcile_only: reconcileOnly,
      review_id: reviewId
      }, ctx) => {
      const clientAbortSignal = ctx?.signal ?? ctx?.mcpReq?.signal;
      try {
        const outcome = await delegate({
          agentType,
          task,
          cwd,
          targetRef,
          reconcileOnly,
          reviewId,
          abortSignal: clientAbortSignal
        }, { clientAbortSignal });
        return mcpText(
          formatDelegateAgentOutcome(outcome),
          projectDelegateAgentOutcomeForTransport(outcome),
          outcome.status !== "completed"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return mcpText(
          "delegate_agent failed:\n" + message,
          projectDelegateAgentError(error),
          true
        );
      }
    }
  );
}
