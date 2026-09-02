import assert from "node:assert/strict";
import test from "node:test";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../src/changeset/descriptor.mjs";
import { reviewTargetSpec } from "../src/changeset/target.mjs";
import {
  COHERENT_ADMISSION_KIND,
  buildReviewReceipt
} from "../src/review/receipt-schema.mjs";
import {
  FRESHNESS_VERDICT,
  SECTION_REASON_CODES,
  evaluateFreshness
} from "../src/review/freshness.mjs";

const DIGEST = "a".repeat(64);
const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

function baseSections() {
  return Object.fromEntries(SECTION_NAMES.map((name, index) => [name, String(index).repeat(64).slice(0, 64)]));
}

function receiptWith({ sections = baseSections(), reviewer = {} } = {}) {
  const changeSetId = changeSetIdFromSectionDigests({ objectFormat: "sha1", sections });
  return buildReviewReceipt({
    binding: {
      changeSetId,
      objectFormat: "sha1",
      sections,
      target: { spec: TARGET, resolution: "resolved", commit: "1".repeat(40) },
      beforeSummary: {
        headCommit: "2".repeat(40),
        branch: "main",
        detached: false,
        mergeBase: null,
        counts: { index: 0, worktree: 0, unmerged: 0, untracked: 0, submodules: 0 }
      },
      afterSummary: {
        headCommit: "2".repeat(40),
        branch: "main",
        detached: false,
        mergeBase: null,
        counts: { index: 0, worktree: 0, unmerged: 0, untracked: 0, submodules: 0 }
      }
    },
    coherence: {
      admission: COHERENT_ADMISSION_KIND,
      custodyExecutionId: "exec-1",
      beforeAt: 1_000,
      afterAt: 2_000
    },
    reviewer: {
      agentType: "code-review",
      contractSha256: DIGEST,
      capabilityPolicySha256: DIGEST,
      modelSelector: "opus",
      modelSelectorSource: "default",
      modelStrategy: "configurable",
      reasoningEffort: "high",
      ...reviewer
    },
    assignment: { sha256: DIGEST, chars: 6 },
    execution: {
      executionId: "exec-1", status: "completed",
      startedAt: 1_000, completedAt: 2_000, durationMs: 1_000
    },
    result: { sha256: DIGEST, bytes: 10 },
    provenance: {
      repositoryId: DIGEST,
      producer: "claude-agents-mcp/0.2.0",
      collector: "change-set-collector/v1",
      recordedAt: 3_000
    }
  });
}

function currentWith(overrides = {}) {
  const sections = baseSections();
  return {
    status: "exact",
    changeSetId: changeSetIdFromSectionDigests({ objectFormat: "sha1", sections }),
    sections,
    ...overrides
  };
}

function withChangedSections(names) {
  const sections = baseSections();
  for (const name of names) sections[name] = "f".repeat(64);
  return currentWith({ sections, changeSetId: "cs1:" + "b".repeat(64) });
}

const now = () => 5_000;

test("an unchanged repository is FRESH", () => {
  const result = evaluateFreshness({ receipt: receiptWith(), current: currentWith(), now });
  assert.equal(result.verdict, FRESHNESS_VERDICT.FRESH);
  assert.deepEqual(result.changedSections, []);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.evaluatedAt, 5_000);
});

const SCENARIOS = [
  ["a tracked file edited in the worktree", ["worktree"], ["worktree_state_changed"]],
  ["a new untracked file", ["untracked"], ["untracked_state_changed"]],
  ["staging an already-modified file", ["index", "worktree"], ["index_state_changed", "worktree_state_changed"]],
  ["staging a previously untracked file", ["index", "untracked"], ["index_state_changed", "untracked_state_changed"]],
  ["a commit with unchanged worktree bytes", ["head", "index"], ["head_changed", "index_state_changed"]],
  ["a fetch that advances the target only", ["target"], ["target_changed"]],
  ["a conflict appearing", ["unmerged"], ["unmerged_state_changed"]],
  ["a submodule commit moving", ["submodules"], ["submodule_state_changed"]],
  ["a collection policy change", ["policy"], ["policy_changed"]]
];

for (const [name, changed, expectedReasons] of SCENARIOS) {
  test(name + " is STALE with exactly the right sections", () => {
    const result = evaluateFreshness({
      receipt: receiptWith(),
      current: withChangedSections(changed),
      now
    });
    assert.equal(result.verdict, FRESHNESS_VERDICT.STALE);
    assert.deepEqual(result.changedSections, [...changed].sort());
    assert.deepEqual(result.reasons.map((r) => r.code), [...expectedReasons].sort());
  });
}

test("a moved target alone is STALE with target_changed and nothing else", () => {
  // The same-content/different-target case: the worktree was never touched.
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: withChangedSections(["target"]),
    now
  });
  assert.deepEqual(result.changedSections, ["target"]);
  assert.deepEqual(result.reasons, [{ code: SECTION_REASON_CODES.target }]);
});

test("changedSections is always sorted", () => {
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: withChangedSections(["worktree", "head", "untracked"]),
    now
  });
  assert.deepEqual(result.changedSections, ["head", "untracked", "worktree"]);
});

test("differing ids with identical sections leave only the object format", () => {
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: currentWith({ changeSetId: "cs1:" + "e".repeat(64) }),
    now
  });
  assert.equal(result.verdict, FRESHNESS_VERDICT.STALE);
  assert.deepEqual(result.changedSections, []);
  assert.deepEqual(result.reasons, [{ code: "object_format_changed" }]);
});

test("an indeterminate current state is INDETERMINATE and carries its reasons", () => {
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: { status: "indeterminate", reasons: [{ code: "dirty_submodule" }] },
    now
  });
  assert.equal(result.verdict, FRESHNESS_VERDICT.INDETERMINATE);
  assert.equal(result.currentChangeSetId, null);
  assert.deepEqual(result.reasons.map((r) => r.code), ["dirty_submodule", "current_state_indeterminate"]);
});

test("a future change-set schema is INDETERMINATE, never FRESH or STALE", () => {
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: currentWith({ changeSetId: "cs2:" + DIGEST }),
    now
  });
  assert.equal(result.verdict, FRESHNESS_VERDICT.INDETERMINATE);
  assert.deepEqual(result.reasons, [{ code: "change_set_schema_mismatch" }]);
});

test("a corrupt receipt is INDETERMINATE and still reports the current identifier", () => {
  const tampered = { ...receiptWith(), reviewId: "rr1:" + "0".repeat(64) };
  const result = evaluateFreshness({ receipt: tampered, current: currentWith(), now });
  assert.equal(result.verdict, FRESHNESS_VERDICT.INDETERMINATE);
  assert.deepEqual(result.reasons, [{ code: "receipt_corrupt" }]);
  assert.equal(result.currentChangeSetId, currentWith().changeSetId);
});

test("basis differences are reported and never move the verdict", () => {
  const basis = {
    agentType: "security-review",
    contractSha256: "b".repeat(64),
    capabilityPolicySha256: "c".repeat(64),
    modelSelector: "sonnet",
    reasoningEffort: "low",
    assignmentSha256: "d".repeat(64)
  };

  const fresh = evaluateFreshness({ receipt: receiptWith(), current: currentWith(), basis, now });
  // Every part of the basis differs, and the subject is still the same subject.
  assert.equal(fresh.verdict, FRESHNESS_VERDICT.FRESH);
  assert.deepEqual(fresh.basisDifferences, [
    "agent_type_differs", "assignment_changed", "capability_policy_changed",
    "contract_changed", "model_changed", "reasoning_effort_changed"
  ]);

  const stale = evaluateFreshness({
    receipt: receiptWith(),
    current: withChangedSections(["worktree"]),
    basis,
    now
  });
  assert.equal(stale.verdict, FRESHNESS_VERDICT.STALE);
});

test("an identical basis produces no differences", () => {
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: currentWith(),
    basis: {
      agentType: "code-review",
      contractSha256: DIGEST,
      capabilityPolicySha256: DIGEST,
      modelSelector: "opus",
      reasoningEffort: "high",
      assignmentSha256: DIGEST
    },
    now
  });
  assert.deepEqual(result.basisDifferences, []);
});

test("basis differences are reported even when the verdict is indeterminate", () => {
  const result = evaluateFreshness({
    receipt: receiptWith(),
    current: { status: "indeterminate", reasons: [] },
    basis: { modelSelector: "sonnet" },
    now
  });
  assert.equal(result.verdict, FRESHNESS_VERDICT.INDETERMINATE);
  assert.deepEqual(result.basisDifferences, ["model_changed"]);
});

test("the verdict is never a boolean and always names the receipt it judged", () => {
  const result = evaluateFreshness({ receipt: receiptWith(), current: currentWith(), now });
  assert.equal(typeof result.verdict, "string");
  assert.match(result.reviewId, /^rr1:/u);
  assert.equal(result.receiptChangeSetId, receiptWith().binding.changeSetId);
});

test("two reviewers of the same change set are both FRESH", () => {
  const code = receiptWith();
  const security = receiptWith({ reviewer: { agentType: "security-review" } });
  for (const receipt of [code, security]) {
    assert.equal(
      evaluateFreshness({ receipt, current: currentWith(), now }).verdict,
      FRESHNESS_VERDICT.FRESH
    );
  }
});
