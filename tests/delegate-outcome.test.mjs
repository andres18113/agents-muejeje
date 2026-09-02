import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  CUSTODY_RECOVERY_MODES,
  DELEGATE_OUTCOME_SCHEMA,
  MAX_PUBLIC_HISTORY_DIAGNOSTICS,
  MAX_PUBLIC_HISTORY_RECEIPTS,
  MAX_PUBLIC_OUTCOME_BYTES,
  MAX_PUBLIC_REASONS,
  RECEIPT_HISTORY_STATUSES,
  RECEIPT_PUBLICATION_DISPOSITIONS,
  RECEIPT_PUBLICATION_STATUSES,
  RETAINED_CUSTODY_STATES,
  delegateAgentOutputSchema,
  projectDelegateAgentError,
  projectDelegateAgentOutcome,
  projectDelegateAgentOutcomeForTransport
} from "../src/delegate-outcome.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

const CS_A = "cs1:" + "a".repeat(64);
const CS_B = "cs1:" + "b".repeat(64);
const RR_A = "rr1:" + "c".repeat(64);
const RR_B = "rr1:" + "d".repeat(64);

function fullOutcome(overrides = {}) {
  return {
    executionId: "execution-1",
    agentType: "code-review",
    status: "completed",
    startedAt: 100,
    durationMs: 25,
    pid: 4321,
    accessMode: "read",
    effectiveCwd: "C:\\repo\\worktree",
    canonicalRoot: "C:\\repo",
    canonicalRootSource: "git-boundary",
    worktreeRoot: "C:\\state\\worktrees\\execution-1",
    baseCommit: "1".repeat(40),
    custodyState: "retained",
    durableCustodyState: "active",
    custodyReasons: [{
      code: "review_receipt_publication_unquiesced",
      detail: "C:\\private\\must-not-leak"
    }],
    recoveryDiagnostics: {
      automatic: true,
      manualInterventionRequired: false,
      mode: "same-coordinator-publication-settlement",
      reason: "review_receipt_publication_unquiesced"
    },
    terminationDiagnostics: {
      processStarted: true,
      processIdentity: "recorded",
      terminalProof: "close",
      forcedTerminationStatus: "termination-unproven",
      method: "taskkill",
      reason: "termination-timeout",
      destructiveHelperAuthorized: true,
      helperQuiescenceProven: false
    },
    model: "opus",
    reasoningEffort: "max",
    result: "specialist text belongs only in the text fallback",
    reviewBinding: {
      status: "unbound",
      coherence: "held",
      beforeChangeSetId: CS_A,
      afterChangeSetId: CS_B,
      reasons: [{ code: "workspace_mutated_during_review", detail: "secret/path.txt" }],
      receiptHistory: {
        status: "partial",
        receipts: [{
          reviewId: RR_A,
          agentType: "code-review",
          changeSetId: CS_A,
          recordedAt: 90,
          verdict: "STALE",
          changedSections: ["worktree"],
          basisDifferences: ["contract_changed"],
          reasons: [{ code: "worktree_state_changed" }]
        }],
        diagnostics: [{ code: "review_pointer_unparsable" }]
      },
      publication: {
        status: "authoritative-pending",
        authorityStarted: true,
        settled: false
      }
    },
    ...overrides
  };
}

test("the versioned public outcome projects the complete bounded evidence contract", () => {
  const projected = projectDelegateAgentOutcome(fullOutcome());
  assert.equal(projected.schema, DELEGATE_OUTCOME_SCHEMA);
  assert.equal(delegateAgentOutputSchema.safeParse(projected).success, true);
  assert.equal(projected.execution.status, "completed");
  assert.equal(projected.workspace.worktree.retained, true);
  assert.equal(projected.custody.state, "retained");
  assert.equal(projected.custody.durableState, "active");
  assert.equal(projected.custody.recovery.mode, "same-coordinator-publication-settlement");
  assert.equal(projected.custody.termination.helperQuiescenceProven, false);
  assert.equal(projected.review.beforeChangeSetId, CS_A);
  assert.equal(projected.review.afterChangeSetId, CS_B);
  assert.equal(projected.review.receiptHistory.status, "partial");
  assert.equal(projected.review.receiptHistory.receipts[0].freshness.verdict, "STALE");
  assert.deepEqual(
    projected.review.receiptHistory.receipts[0].freshness.changedSections,
    ["worktree"]
  );
  assert.deepEqual(
    projected.review.receiptHistory.receipts[0].freshness.basisDifferences,
    ["contract_changed"]
  );
  assert.equal(projected.review.publication.status, "authoritative-pending");
  assert.equal(projected.custody.reasons[0].detail, undefined, "unsafe path detail is excluded");
  assert.equal(projected.review.reasons[0].detail, undefined, "review path detail is excluded");
  assert.equal(JSON.stringify(projected).includes("specialist text"), false);
});

test("public diagnostic arrays, strings and serialized output are deterministically bounded", () => {
  const repeatedReasons = Array.from({ length: 100 }, (_, index) => ({
    code: "reason_" + index,
    detail: "ignored path/" + index
  }));
  const repeatedReceipts = Array.from({ length: 40 }, (_, index) => ({
    reviewId: index % 2 === 0 ? RR_A : RR_B,
    agentType: "code-review",
    changeSetId: index % 2 === 0 ? CS_A : CS_B,
    recordedAt: index,
    verdict: "FRESH",
    changedSections: [],
    basisDifferences: [],
    reasons: repeatedReasons
  }));
  const projected = projectDelegateAgentOutcome(fullOutcome({
    status: "failed",
    error: { code: "claude_execution_failed", message: "x".repeat(10_000) },
    custodyReasons: repeatedReasons,
    reviewBinding: {
      ...fullOutcome().reviewBinding,
      reasons: repeatedReasons,
      receiptHistory: {
        status: "partial",
        receipts: repeatedReceipts,
        diagnostics: repeatedReasons
      }
    }
  }));

  assert.equal(projected.execution.error.message.length, 2_048);
  assert.equal(projected.custody.reasons.length, MAX_PUBLIC_REASONS);
  assert.equal(projected.review.reasons.length, MAX_PUBLIC_REASONS);
  assert.equal(projected.review.receiptHistory.receipts.length, MAX_PUBLIC_HISTORY_RECEIPTS);
  assert.equal(
    projected.review.receiptHistory.diagnostics.length,
    MAX_PUBLIC_HISTORY_DIAGNOSTICS
  );
  assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") <= MAX_PUBLIC_OUTCOME_BYTES);

  // A cap that says nothing turns a partial list into an apparently full one.
  // The last bounded slot is spent saying codes were dropped, and the history
  // count reports what discovery held rather than what survived the bound.
  assert.equal(
    projected.custody.reasons.at(-1).code,
    "public_reasons_truncated"
  );
  assert.equal(projected.review.reasons.at(-1).code, "public_reasons_truncated");
  assert.equal(projected.review.receiptHistory.count, repeatedReceipts.length);
  assert.ok(projected.review.receiptHistory.count > MAX_PUBLIC_HISTORY_RECEIPTS);

  // With room left in the diagnostics bound, the dropped receipts say so too.
  const marked = projectDelegateAgentOutcome(fullOutcome({
    reviewBinding: {
      ...fullOutcome().reviewBinding,
      receiptHistory: {
        status: "complete",
        receipts: repeatedReceipts.map((receipt) => ({ ...receipt, reasons: [] })),
        diagnostics: []
      }
    }
  }));
  assert.equal(marked.review.receiptHistory.count, repeatedReceipts.length);
  assert.equal(marked.review.receiptHistory.receipts.length, MAX_PUBLIC_HISTORY_RECEIPTS);
  assert.deepEqual(marked.review.receiptHistory.diagnostics, [
    { code: "public_receipt_history_truncated" }
  ]);

  // A receipt the public contract cannot represent is reported as excluded,
  // never silently dropped into an apparently complete history.
  const unprojectable = projectDelegateAgentOutcome(fullOutcome({
    reviewBinding: {
      ...fullOutcome().reviewBinding,
      receiptHistory: {
        status: "complete",
        receipts: [{ reviewId: "not-a-review-id", changeSetId: CS_A, verdict: "FRESH" }],
        diagnostics: []
      }
    }
  }));
  assert.equal(unprojectable.review.receiptHistory.count, 1);
  assert.deepEqual(unprojectable.review.receiptHistory.receipts, []);
  assert.deepEqual(unprojectable.review.receiptHistory.diagnostics, [
    { code: "public_receipt_history_unprojectable" }
  ]);
});

test("request rejection uses the same advertised versioned schema", () => {
  const error = Object.assign(new Error("bad request"), { code: "delegate_input_invalid" });
  const projected = projectDelegateAgentError(error);
  assert.equal(projected.status, "rejected");
  assert.equal(projected.error.code, "delegate_input_invalid");
  assert.equal(delegateAgentOutputSchema.safeParse(projected).success, true);
});

test("public receipt history distinguishes empty success from failed discovery", () => {
  const empty = projectDelegateAgentOutcome(fullOutcome({
    reviewBinding: {
      ...fullOutcome().reviewBinding,
      receiptHistory: { status: "complete", receipts: [], diagnostics: [] }
    }
  }));
  assert.deepEqual(empty.review.receiptHistory, {
    status: "complete",
    count: 0,
    receipts: [],
    diagnostics: []
  });

  const indeterminate = projectDelegateAgentOutcome(fullOutcome({
    reviewBinding: {
      ...fullOutcome().reviewBinding,
      receiptHistory: {
        status: "indeterminate",
        receipts: [],
        diagnostics: [{
          code: "review_history_discovery_failed",
          detail: "EACCES"
        }]
      }
    }
  }));
  assert.equal(indeterminate.review.receiptHistory.status, "indeterminate");
  assert.deepEqual(indeterminate.review.receiptHistory.diagnostics, [{
    code: "review_history_discovery_failed",
    detail: "EACCES"
  }]);
});

test("every member of a shared public domain survives projection unchanged", () => {
  // The producer and the validator must agree by construction. A second copy of
  // any of these domains is how a legitimate runtime state becomes
  // unrepresentable as public evidence, which is the reasoning-effort bug in a
  // different costume.
  for (const mode of CUSTODY_RECOVERY_MODES) {
    const projected = projectDelegateAgentOutcome(fullOutcome({
      recoveryDiagnostics: { automatic: false, manualInterventionRequired: false, mode }
    }));
    assert.equal(projected.custody.recovery.mode, mode);
  }
  for (const status of RECEIPT_PUBLICATION_STATUSES) {
    const projected = projectDelegateAgentOutcome(fullOutcome({
      reviewBinding: {
        ...fullOutcome().reviewBinding,
        publication: { status, authorityStarted: true, settled: false }
      }
    }));
    assert.equal(projected.review.publication.status, status);
  }
  for (const disposition of RECEIPT_PUBLICATION_DISPOSITIONS) {
    const projected = projectDelegateAgentOutcome(fullOutcome({
      reviewBinding: {
        ...fullOutcome().reviewBinding,
        publication: {
          status: "authoritative-settled",
          authorityStarted: true,
          settled: true,
          disposition
        }
      }
    }));
    assert.equal(projected.review.publication.disposition, disposition);
  }
  for (const status of RECEIPT_HISTORY_STATUSES) {
    const projected = projectDelegateAgentOutcome(fullOutcome({
      reviewBinding: {
        ...fullOutcome().reviewBinding,
        receiptHistory: { status, receipts: [], diagnostics: [] }
      }
    }));
    assert.equal(projected.review.receiptHistory.status, status);
  }
  for (const custodyState of RETAINED_CUSTODY_STATES) {
    const projected = projectDelegateAgentOutcome(fullOutcome({ custodyState }));
    assert.equal(projected.custody.retained, true);
  }
  assert.equal(projectDelegateAgentOutcome(fullOutcome({ custodyState: "released" })).custody.retained, false);
});

test("the delegation imports those domains instead of re-declaring them", async () => {
  const source = await readFile(path.join(projectRoot, "src", "delegate-agent.mjs"), "utf8");
  assert.match(source, /RETAINED_CUSTODY_STATES/u);
  for (const domain of [
    RETAINED_CUSTODY_STATES,
    CUSTODY_RECOVERY_MODES,
    RECEIPT_PUBLICATION_STATUSES,
    RECEIPT_PUBLICATION_DISPOSITIONS,
    RECEIPT_HISTORY_STATUSES
  ]) {
    const listing = domain.map((value) => JSON.stringify(value));
    // Both the single-line and the wrapped multi-line spellings of the same
    // literal array, so re-declaring a domain cannot hide behind formatting.
    for (const separator of [", ", ",\n"]) {
      assert.equal(
        source.includes(listing.join(separator)),
        false,
        "a second literal listing of " + listing[0] + " has reappeared in the producer"
      );
    }
  }
});

test("a projection defect degrades without losing the real execution status", () => {
  // Projecting is the last step before the response. A defect there must never
  // be able to report a real, completed delegation as a rejected request.
  const undelegatable = fullOutcome({ effectiveCwd: undefined, canonicalRoot: undefined });
  assert.throws(() => projectDelegateAgentOutcome(undelegatable));

  const transported = projectDelegateAgentOutcomeForTransport(undelegatable);
  assert.equal(delegateAgentOutputSchema.safeParse(transported).success, true);
  assert.equal(transported.status, "completed");
  assert.equal(transported.error.code, "delegate_outcome_projection_failed");
  assert.equal(transported.execution, undefined);
  assert.equal(
    Buffer.byteLength(JSON.stringify(transported), "utf8") <= MAX_PUBLIC_OUTCOME_BYTES,
    true
  );

  const healthy = projectDelegateAgentOutcomeForTransport(fullOutcome());
  assert.deepEqual(healthy, projectDelegateAgentOutcome(fullOutcome()));
});

test("a worktree left behind by failed preparation is reported as unadopted and retained", () => {
  const adopted = projectDelegateAgentOutcome(fullOutcome());
  assert.equal(adopted.workspace.worktree.retained, true);
  assert.equal(adopted.workspace.worktree.adopted, true);

  const abandoned = projectDelegateAgentOutcome(fullOutcome({
    status: "failed",
    custodyState: "orphaned",
    worktreeRoot: undefined,
    baseCommit: undefined,
    retainedWorktreeRoot: "C:\state\worktrees\execution-1",
    error: { code: "worktree_preparation_ambiguous", message: "git worktree add was not proven" },
    recoveryDiagnostics: {
      automatic: false,
      manualInterventionRequired: true,
      mode: "manual-required",
      reason: "worktree-preparation-ambiguous"
    }
  }));
  assert.equal(abandoned.workspace.worktree.root, "C:\state\worktrees\execution-1");
  assert.equal(abandoned.workspace.worktree.retained, true);
  assert.equal(abandoned.workspace.worktree.adopted, false);
  assert.equal(abandoned.workspace.worktree.baseCommit, undefined);
  assert.equal(abandoned.custody.orphaned, true);
  assert.equal(abandoned.custody.recovery.manualInterventionRequired, true);
  assert.equal(abandoned.custody.recovery.reason, "worktree-preparation-ambiguous");
});

test("no assignment, contract, environment or specialist body reaches public output", () => {
  // Every string-bearing field is loaded with a distinct marker. None of the
  // non-evidentiary ones may survive projection, in any nesting.
  const secrets = {
    result: "SPECIALIST-BODY-MARKER findings text",
    task: "ASSIGNMENT-MARKER do the thing",
    contract: "CONTRACT-MARKER role contract text",
    stderrSummary: "STDERR-MARKER child diagnostics",
    prompt: "PROMPT-MARKER composed prompt",
    env: { GITHUB_TOKEN: "ENVIRONMENT-MARKER-ghp" },
    runtimeCapabilities: "CAPABILITIES-MARKER",
    reviewSubject: "REVIEW-SUBJECT-MARKER"
  };
  const projected = projectDelegateAgentOutcome(fullOutcome({
    ...secrets,
    custodyReasons: [
      // Allowlisted code, but free-text detail: the shape guard drops it.
      { code: "custody-release-proof-failed", detail: "SECRET DETAIL MARKER C:/private/path" },
      // Real machine code on an allowlisted reason: this is the detail that is
      // meant to survive, because it is what makes the diagnostic actionable.
      { code: "custody-release-proof-failed", detail: "EPERM" }
    ],
    reviewBinding: {
      ...fullOutcome().reviewBinding,
      reviewSubject: secrets.reviewSubject,
      // Non-allowlisted code: its detail never survives, whatever its shape.
      reasons: [{ code: "workspace_mutated_during_review", detail: "SECRET-DETAIL-MARKER" }]
    }
  }));

  const serialized = JSON.stringify(projected);
  for (const marker of [
    "SPECIALIST-BODY-MARKER",
    "ASSIGNMENT-MARKER",
    "CONTRACT-MARKER",
    "STDERR-MARKER",
    "PROMPT-MARKER",
    "ENVIRONMENT-MARKER",
    "CAPABILITIES-MARKER",
    "REVIEW-SUBJECT-MARKER",
    "SECRET-DETAIL-MARKER"
  ]) {
    assert.equal(serialized.includes(marker), false, marker + " reached public output");
  }
  // The evidence that is supposed to survive still does.
  assert.equal(projected.review.beforeChangeSetId, CS_A);
  assert.equal(projected.custody.state, "retained");
  assert.deepEqual(projected.custody.reasons, [
    { code: "custody-release-proof-failed" },
    { code: "custody-release-proof-failed", detail: "EPERM" }
  ]);
  assert.equal(projected.review.reasons[0].detail, undefined);

  // The guarantee is exactly this and not more: a `detail` survives only for an
  // allowlisted reason code and only when it is itself machine-code shaped, so
  // free text, paths and environment values cannot ride out on one.
  const shaped = projectDelegateAgentOutcome(fullOutcome({
    custodyReasons: [
      { code: "review_binding_internal_error", detail: "C:/private/leak.txt" },
      { code: "review_binding_internal_error", detail: "secret path/with spaces" },
      { code: "review_binding_internal_error", detail: "ENOENT" }
    ]
  }));
  assert.deepEqual(shaped.custody.reasons, [
    { code: "review_binding_internal_error" },
    { code: "review_binding_internal_error" },
    { code: "review_binding_internal_error", detail: "ENOENT" }
  ]);
});
