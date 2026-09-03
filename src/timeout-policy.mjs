import { COLLECTION_DEADLINE_MS } from "./changeset/collector.mjs";
import { RECEIPT_PUBLICATION_QUIESCENCE_TIMEOUT_MS } from "./review/publication-fence.mjs";
import { PROCESS_TREE_TERMINATION_TIMEOUT_MS } from "./claude-termination.mjs";
import { RUNTIME_SETTINGS_HOUSEKEEPING_TIMEOUT_MS } from "./claude-runner.mjs";
import { GIT_COMMAND_TIMEOUT_MS } from "./git-command.mjs";
import {
  PROCESS_QUERY_TIMEOUT_MS,
  PROCESS_QUERY_TERMINATION_TIMEOUT_MS
} from "./process-identity.mjs";

/**
 * Timeout hierarchy invariant:
 *
 *   client tool-call deadline (Codex MCP tool timeout)
 *     >
 *   maximum bounded MCP call lifetime
 *     >
 *   Claude useful-work execution envelope (profile timeout / runtime.timeoutMs)
 *
 * Where:
 *   maximum bounded MCP call lifetime =
 *     max(profile timeout) + REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS
 *
 * Semantic definition:
 *   `runtime.timeoutMs` represents the total useful-work execution envelope
 *   allocated to runClaudeAgent (from entry through pre-spawn validation, prompt
 *   delivery, and child process execution until normal exit). It does NOT
 *   represent pure model inference alone, which an un-instrumented CLI child does
 *   not expose.
 *
 * And REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS is derived strictly from
 * the actual bounded synchronous lifecycle phases that can keep tools/call pending.
 */

export const RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC = 3600; // 60 minutes
export const RECOMMENDED_CODEX_TOOL_TIMEOUT_MS = RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC * 1000;

export const REVIEW_BINDING_FINALIZATION_BUDGET_MS = COLLECTION_DEADLINE_MS + 10_000; // 190_000 ms

/**
 * Every bounded phase that can contribute to the synchronous MCP tools/call
 * lifetime outside of Claude useful-work execution:
 */
export const SYNCHRONOUS_SETTLEMENT_BUDGET_COMPONENTS = Object.freeze({
  gitCommandTimeoutMs: GIT_COMMAND_TIMEOUT_MS,
  processQueryTimeoutMs: PROCESS_QUERY_TIMEOUT_MS,
  beforeCollectionDeadlineMs: COLLECTION_DEADLINE_MS,
  processTreeTerminationTimeoutMs: PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  processQueryTerminationTimeoutMs: PROCESS_QUERY_TERMINATION_TIMEOUT_MS,
  housekeepingTimeoutMs: RUNTIME_SETTINGS_HOUSEKEEPING_TIMEOUT_MS,
  afterReviewBindingFinalizationTimeoutMs: REVIEW_BINDING_FINALIZATION_BUDGET_MS,
  receiptPublicationQuiescenceTimeoutMs: RECEIPT_PUBLICATION_QUIESCENCE_TIMEOUT_MS
});

export const REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS = Object.freeze(
  Object.values(SYNCHRONOUS_SETTLEMENT_BUDGET_COMPONENTS).reduce(
    (accumulator, value) => accumulator + value,
    0
  )
);

export function deriveMaxProfileTimeout(registry) {
  const profiles = Object.values(registry);
  if (profiles.length === 0) return 0;
  return Math.max(...profiles.map((profile) => profile.timeoutMs));
}

export function calculateMaxMcpLifetime(
  maxProfileTimeoutMs,
  settlementBudgetMs = REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS
) {
  return maxProfileTimeoutMs + settlementBudgetMs;
}

export class TimeoutHierarchyViolationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TimeoutHierarchyViolationError";
    this.code = details.code || "timeout_hierarchy_violation";
    this.details = details;
  }
}

export function assertTimeoutHierarchy({
  outerTimeoutMs = RECOMMENDED_CODEX_TOOL_TIMEOUT_MS,
  maxProfileTimeoutMs,
  settlementBudgetMs = REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS
}) {
  if (!Number.isSafeInteger(outerTimeoutMs) || outerTimeoutMs <= 0) {
    throw new TimeoutHierarchyViolationError("Outer client timeout must be a positive integer.", {
      outerTimeoutMs
    });
  }
  if (!Number.isSafeInteger(maxProfileTimeoutMs) || maxProfileTimeoutMs <= 0) {
    throw new TimeoutHierarchyViolationError("Max profile timeout must be a positive integer.", {
      maxProfileTimeoutMs
    });
  }

  const maxMcpLifetimeMs = calculateMaxMcpLifetime(maxProfileTimeoutMs, settlementBudgetMs);

  if (maxProfileTimeoutMs >= outerTimeoutMs) {
    throw new TimeoutHierarchyViolationError(
      `Timeout hierarchy inverted: max profile timeout (${maxProfileTimeoutMs}ms) ` +
        `exceeds or equals outer client timeout (${outerTimeoutMs}ms).`,
      { code: "timeout_hierarchy_inverted", outerTimeoutMs, maxProfileTimeoutMs, maxMcpLifetimeMs }
    );
  }

  if (outerTimeoutMs < maxMcpLifetimeMs) {
    throw new TimeoutHierarchyViolationError(
      `Outer client timeout (${outerTimeoutMs}ms) does not provide sufficient settlement headroom ` +
        `for maximum bounded MCP lifetime (${maxMcpLifetimeMs}ms = ` +
        `${maxProfileTimeoutMs}ms useful work + ${settlementBudgetMs}ms settlement budget).`,
      { code: "insufficient_settlement_headroom", outerTimeoutMs, maxProfileTimeoutMs, settlementBudgetMs, maxMcpLifetimeMs }
    );
  }

  return Object.freeze({
    valid: true,
    outerTimeoutMs,
    maxProfileTimeoutMs,
    settlementBudgetMs,
    maxMcpLifetimeMs,
    headroomMs: outerTimeoutMs - maxMcpLifetimeMs
  });
}

export function checkTimeoutHierarchySafety({
  codexTimeoutSec,
  maxProfileTimeoutMs,
  settlementBudgetMs = REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS
}) {
  const maxProfileSec = Math.round(maxProfileTimeoutMs / 1000);
  const settlementBudgetSec = Math.round(settlementBudgetMs / 1000);
  const minSafeTimeoutSec = maxProfileSec + settlementBudgetSec;

  if (codexTimeoutSec === undefined || codexTimeoutSec === null) {
    return Object.freeze({
      safe: false,
      status: "unconfigured",
      configuredTimeoutSec: null,
      recommendedTimeoutSec: RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC,
      maxProfileTimeoutSec: maxProfileSec,
      settlementBudgetSec,
      minSafeTimeoutSec,
      message:
        `Codex MCP tool timeout is not configured (defaults to 300s). ` +
        `Minimum safe timeout is ${minSafeTimeoutSec}s; recommended is ${RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC}s.`
    });
  }

  const numericTimeoutSec = Number(codexTimeoutSec);
  if (!Number.isFinite(numericTimeoutSec) || numericTimeoutSec <= 0) {
    return Object.freeze({
      safe: false,
      status: "invalid",
      configuredTimeoutSec: codexTimeoutSec,
      recommendedTimeoutSec: RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC,
      maxProfileTimeoutSec: maxProfileSec,
      settlementBudgetSec,
      minSafeTimeoutSec,
      message: `Configured Codex MCP tool timeout (${codexTimeoutSec}) is invalid.`
    });
  }

  if (numericTimeoutSec < minSafeTimeoutSec) {
    return Object.freeze({
      safe: false,
      status: "unsafe",
      configuredTimeoutSec: numericTimeoutSec,
      recommendedTimeoutSec: RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC,
      maxProfileTimeoutSec: maxProfileSec,
      settlementBudgetSec,
      minSafeTimeoutSec,
      message:
        `Configured Codex tool timeout (${numericTimeoutSec}s) is dangerously below the ` +
        `minimum safe MCP lifetime budget (${minSafeTimeoutSec}s). ` +
        `Synchronous calls can be abandoned before MCP execution settles.`
    });
  }

  return Object.freeze({
    safe: true,
    status: "safe",
    configuredTimeoutSec: numericTimeoutSec,
    recommendedTimeoutSec: RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC,
    maxProfileTimeoutSec: maxProfileSec,
    settlementBudgetSec,
    minSafeTimeoutSec,
    headroomSec: numericTimeoutSec - minSafeTimeoutSec,
    message: `Codex MCP tool timeout (${numericTimeoutSec}s) satisfies timeout hierarchy safety.`
  });
}
