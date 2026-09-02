import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_REGISTRY, getAgentProfile } from "../src/agent-registry.mjs";
import { resolveCapabilityPolicy } from "../src/capability-policy.mjs";
import { SECTION_NAMES, buildChangeSetDescriptor, changeSetIdFor } from "../src/changeset/descriptor.mjs";
import { NO_REVIEW_TARGET, reviewTargetSpec } from "../src/changeset/target.mjs";
import { COHERENCE } from "../src/review/coherent-admission.mjs";
import { validateReviewReceipt } from "../src/review/receipt-schema.mjs";
import {
  createReviewBinder,
  profileParticipatesInReviewBinding,
  reviewBindingProfileIds
} from "../src/review/review-binding.mjs";

const WORKSPACE = Object.freeze({
  effectiveCwd: "C:\\repo",
  repositoryRoot: "C:\\repo",
  canonicalRepositoryKey: "c:\\repo",
  rootSource: "git-boundary"
});

const RUNTIME = Object.freeze({
  model: "opus",
  modelSource: "default",
  modelStrategy: "configurable",
  reasoningEffort: "high"
});

const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

function exactCollection(seed = 1) {
  const descriptor = buildChangeSetDescriptor({
    objectFormat: "sha1",
    head: { commit: seed.toString(16).padStart(40, "0"), unborn: false },
    target: { spec: TARGET, resolution: "resolved", commit: "2".repeat(40) },
    index: [], worktree: [], unmerged: [], untracked: [], submodules: [],
    summary: { branch: "main", detached: false, mergeBase: null }
  });
  const { sections, changeSetId } = changeSetIdFor(descriptor);
  return { status: "exact", descriptor, changeSetId, sections, summary: descriptor.summary };
}

function indeterminate(code = "dirty_submodule") {
  return { status: "indeterminate", reasons: [{ code }] };
}

function recordingStore() {
  const puts = [];
  return {
    puts,
    async put(entry) { puts.push(entry); return { stored: "created", path: "receipt.json" }; },
    async listForChangeSet() { return { receipts: [], skipped: [] }; },
    async discoverForScope() { return { receipts: [], skipped: [] }; }
  };
}

function binderWith({
  collections = [exactCollection(), exactCollection()],
  store = recordingStore(),
  held = true,
  stillHeld = { held: true }
} = {}) {
  const queue = [...collections];
  const observed = { collectCalls: [] };
  const binder = createReviewBinder({
    collectChangeSet: async (request) => {
      observed.collectCalls.push(request);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    coherentAdmission: {
      verifyStillHeld: typeof stillHeld === "function"
        ? stillHeld
        : async () => stillHeld
    },
    receiptStore: store,
    now: () => 1_000
  });
  return { binder, store, observed, coherence: held ? COHERENCE.HELD : COHERENCE.DENIED };
}

async function runBefore(context, extra = {}) {
  return context.binder.before({
    profile: getAgentProfile("code-review"),
    runtime: RUNTIME,
    contract: "contract text",
    capabilityPolicy: resolveCapabilityPolicy(getAgentProfile("code-review")),
    task: "review this",
    workspace: WORKSPACE,
    coherence: context.coherence,
    custodyExecutionId: "exec-1",
    targetSpec: TARGET,
    ...extra
  });
}

async function runAfter(context, beforeState, extra = {}) {
  return context.binder.after({
    beforeState,
    workspace: WORKSPACE,
    outcome: { status: "completed", result: "findings" },
    executionId: "exec-1",
    startedAt: 500,
    completedAt: 900,
    ...extra
  });
}

test("exactly the two reviewers participate, across the whole registry", () => {
  assert.deepEqual(reviewBindingProfileIds().sort(), ["code-review", "security-review"]);
  for (const profile of Object.values(AGENT_REGISTRY)) {
    const expected = ["code-review", "security-review"].includes(profile.id);
    assert.equal(profileParticipatesInReviewBinding(profile), expected, profile.id);
  }
});

test("a stable subject under held admission produces a bound receipt", async () => {
  const context = binderWith();
  const before = await runBefore(context);
  assert.equal(before.status, "collected");

  const after = await runAfter(context, before);
  assert.equal(after.status, "bound");
  assert.equal(after.coherence, COHERENCE.HELD);
  assert.match(after.reviewId, /^rr1:[0-9a-f]{64}$/u);
  assert.equal(after.beforeChangeSetId, after.afterChangeSetId);

  assert.equal(context.store.puts.length, 1);
  const stored = validateReviewReceipt(context.store.puts[0].receipt);
  assert.ok(stored, "the stored receipt must validate");
  assert.equal(stored.binding.changeSetId, before.current.changeSetId);
  assert.equal(stored.coherence.custodyExecutionId, "exec-1");
  assert.equal(stored.reviewer.agentType, "code-review");
  assert.equal(stored.execution.durationMs, 400);
});

test("both collections run under exclusive-held expectation when admission is held", async () => {
  const context = binderWith();
  const before = await runBefore(context);
  await runAfter(context, before);

  assert.equal(context.observed.collectCalls.length, 2);
  for (const call of context.observed.collectCalls) {
    assert.deepEqual(call.custodyExpectation, { mode: "exclusive-held", executionId: "exec-1" });
    assert.deepEqual(call.targetSpec, TARGET);
  }
});

test("a denied admission collects only observationally and never binds", async () => {
  const context = binderWith({ held: false });
  const before = await runBefore(context);
  assert.deepEqual(context.observed.collectCalls[0].custodyExpectation, { mode: "observational" });

  const after = await runAfter(context, before);
  assert.equal(after.status, "unavailable");
  assert.deepEqual(after.reasons.map((r) => r.code), ["coherent_admission_denied"]);
  assert.equal(context.store.puts.length, 0, "nothing may be persisted without exclusion");
});

test("a subject that moved during the review is unbound and persists nothing", async () => {
  const context = binderWith({ collections: [exactCollection(1), exactCollection(2)] });
  const before = await runBefore(context);
  const after = await runAfter(context, before);

  assert.equal(after.status, "unbound");
  assert.deepEqual(after.reasons.map((r) => r.code), ["workspace_mutated_during_review"]);
  assert.notEqual(after.beforeChangeSetId, after.afterChangeSetId);
  assert.equal(context.store.puts.length, 0);
});

test("an indeterminate after-collection is unbound and persists nothing", async () => {
  const context = binderWith({ collections: [exactCollection(), indeterminate("collector_unstable")] });
  const before = await runBefore(context);
  const after = await runAfter(context, before);

  assert.equal(after.status, "unbound");
  assert.deepEqual(after.reasons.map((r) => r.code), ["collector_unstable", "after_collection_indeterminate"]);
  assert.equal(context.store.puts.length, 0);
});

test("an indeterminate before-collection still lets the review run, and binds nothing", async () => {
  const context = binderWith({ collections: [indeterminate(), exactCollection()] });
  const before = await runBefore(context);

  assert.equal(before.status, "indeterminate");
  assert.match(before.reviewSubject, /identity for this repository is unavailable/u);

  const after = await runAfter(context, before);
  assert.equal(after.status, "unavailable");
  assert.ok(after.reasons.some((r) => r.code === "before_collection_indeterminate"));
  assert.equal(context.store.puts.length, 0);
});

test("losing the slot mid-review is unbound, with no receipt claiming the interval", async () => {
  const context = binderWith({
    stillHeld: { held: false, reasons: [{ code: "coherent_admission_lost", detail: "gone" }] }
  });
  const before = await runBefore(context);
  const after = await runAfter(context, before);

  assert.equal(after.status, "unbound");
  assert.equal(after.coherence, COHERENCE.LOST);
  assert.deepEqual(after.reasons.map((r) => r.code), ["coherent_admission_lost"]);
  assert.equal(context.store.puts.length, 0);
});

test("losing the slot after AFTER collection still prevents a receipt", async () => {
  let verification = 0;
  const context = binderWith({
    stillHeld: async () => {
      verification += 1;
      return verification === 1
        ? { held: true }
        : { held: false, reasons: [{ code: "coherent_admission_lost", detail: "released" }] };
    }
  });
  const before = await runBefore(context);
  const after = await runAfter(context, before);

  assert.equal(verification, 2);
  assert.equal(after.status, "unbound");
  assert.equal(after.coherence, COHERENCE.LOST);
  assert.deepEqual(after.reasons.map((reason) => reason.code), ["coherent_admission_lost"]);
  assert.equal(context.store.puts.length, 0);
});

test("a non-completed execution binds nothing", async () => {
  for (const status of ["timeout", "failed"]) {
    const context = binderWith();
    const before = await runBefore(context);
    const after = await runAfter(context, before, { outcome: { status } });
    assert.equal(after.status, "unavailable");
    assert.deepEqual(after.reasons.map((r) => r.code), ["execution_not_completed"]);
    assert.equal(context.store.puts.length, 0);
  }
});

test("a persistence failure degrades to unavailable and never fails the review", async () => {
  const failing = {
    ...recordingStore(),
    async put() { throw Object.assign(new Error("disk"), { code: "review_receipt_persist_failed" }); }
  };
  const context = binderWith({ store: failing });
  const before = await runBefore(context);
  const after = await runAfter(context, before);

  assert.equal(after.status, "unavailable");
  assert.deepEqual(after.reasons.map((r) => r.code), ["review_receipt_persist_failed"]);
});

test("native persistence error codes remain detail, not public binding vocabulary", async () => {
  const failing = {
    ...recordingStore(),
    async put() { throw Object.assign(new Error("denied"), { code: "EACCES" }); }
  };
  const context = binderWith({ store: failing });
  const before = await runBefore(context);
  const after = await runAfter(context, before);

  assert.deepEqual(after.reasons, [{ code: "review_receipt_persist_failed", detail: "EACCES" }]);
});

test("a non-participating profile is reported rather than silently bound", async () => {
  const context = binderWith();
  const before = await context.binder.before({
    profile: getAgentProfile("explore"),
    runtime: RUNTIME,
    contract: "c",
    capabilityPolicy: resolveCapabilityPolicy(getAgentProfile("explore")),
    task: "t",
    workspace: WORKSPACE,
    coherence: COHERENCE.NOT_ATTEMPTED,
    custodyExecutionId: "exec-1"
  });
  assert.equal(before.status, "unavailable");
  assert.deepEqual(before.reasons.map((r) => r.code), ["profile_not_review_bound"]);
});

test("neither method ever throws, whatever a dependency does", async () => {
  const exploding = createReviewBinder({
    collectChangeSet: async () => { throw new TypeError("boom"); },
    coherentAdmission: { verifyStillHeld: async () => { throw new TypeError("boom"); } },
    receiptStore: { async put() { throw new TypeError("boom"); }, async discoverForScope() { throw new TypeError("boom"); } },
    now: () => 1_000
  });

  const before = await exploding.before({
    profile: getAgentProfile("code-review"),
    runtime: RUNTIME,
    contract: "c",
    capabilityPolicy: resolveCapabilityPolicy(getAgentProfile("code-review")),
    task: "t",
    workspace: WORKSPACE,
    coherence: COHERENCE.HELD,
    custodyExecutionId: "exec-1"
  });
  assert.equal(before.status, "unavailable");
  assert.equal(before.reasons[0].code, "review_binding_internal_error");

  const after = await exploding.after({
    beforeState: before,
    workspace: WORKSPACE,
    outcome: { status: "completed", result: "x" },
    executionId: "exec-1",
    startedAt: 1,
    completedAt: 2
  });
  assert.equal(after.status, "unavailable");
});

// --- prior review discovery: the STALE path --------------------------------

// Mirrors the real store's discovery contract, including the completeness
// status it reports. A double that omits `status` is a different contract and
// is exercised separately below.
function storeWith(receipts, skipped = [], discovery = {}) {
  return {
    puts: [],
    async put(entry) { this.puts.push(entry); return { stored: "created", path: "x" }; },
    async listForChangeSet() { return { receipts: [], skipped: [] }; },
    async discoverForScope() {
      return {
        status: skipped.length > 0 ? "partial" : "complete",
        truncated: false,
        receipts,
        skipped,
        ...discovery
      };
    }
  };
}

test("a prior receipt for the current state is reported FRESH", async () => {
  const current = exactCollection(1);
  const context = binderWith({ collections: [current, current] });
  const bound = await runAfter(context, await runBefore(context));
  const receipt = context.store.puts[0].receipt;

  const second = binderWith({ collections: [current, current], store: storeWith([receipt]) });
  const before = await runBefore(second);

  assert.equal(before.priorReviews.length, 1);
  assert.equal(before.priorReviews[0].verdict, "FRESH");
  assert.equal(before.priorReviews[0].reviewId, bound.reviewId);
});

test("a prior receipt for an older state is discovered and reported STALE", async () => {
  // Bind against state A.
  const stateA = exactCollection(1);
  const first = binderWith({ collections: [stateA, stateA] });
  await runAfter(first, await runBefore(first));
  const receipt = first.store.puts[0].receipt;

  // The repository is now at state B. Discovery is by scope, so the receipt for
  // A is still found, and comparing it against B is what yields STALE.
  const stateB = exactCollection(2);
  const second = binderWith({ collections: [stateB, stateB], store: storeWith([receipt]) });
  const before = await runBefore(second);

  assert.equal(before.priorReviews.length, 1);
  assert.equal(before.priorReviews[0].verdict, "STALE");
  assert.equal(before.priorReviews[0].changeSetId, stateA.changeSetId);
  assert.deepEqual(before.priorReviews[0].changedSections, ["head"]);
});

test("a corrupt discovered receipt is reported INDETERMINATE without aborting", async () => {
  const context = binderWith();
  const bound = await runAfter(context, await runBefore(context));
  const tampered = { ...context.store.puts[0].receipt, reviewId: "rr1:" + "0".repeat(64) };

  const second = binderWith({ store: storeWith([tampered]) });
  const before = await runBefore(second);

  assert.equal(before.status, "collected", "a bad prior receipt must not stop the review");
  assert.equal(before.priorReviews[0].verdict, "INDETERMINATE");
  assert.ok(bound.reviewId);
});

test("a corrupt receipt filtered by the real store remains visible as INDETERMINATE", async () => {
  const second = binderWith({
    store: storeWith([], [{
      code: "review_receipt_corrupt",
      reviewId: "rr1:" + "1".repeat(64),
      changeSetId: "cs1:" + "2".repeat(64),
      recordedAt: 123
    }])
  });
  const before = await runBefore(second);

  assert.equal(before.status, "collected");
  assert.deepEqual(before.priorReviews, [{
    reviewId: "rr1:" + "1".repeat(64),
    agentType: "code-review",
    changeSetId: "cs1:" + "2".repeat(64),
    recordedAt: 123,
    verdict: "INDETERMINATE",
    changedSections: [],
    basisDifferences: [],
    reasons: [{ code: "review_receipt_corrupt" }]
  }]);
  assert.equal(before.receiptHistory.status, "partial");
  assert.deepEqual(before.receiptHistory.diagnostics, [{ code: "review_receipt_corrupt" }]);
});

test("a discovery that does not state its completeness is never read as complete", async () => {
  // Absence of a status is absence of evidence about completeness. Treating it
  // as "complete" would turn an unknown history into a proven empty one.
  const silent = binderWith({
    store: {
      puts: [],
      async put() { return { stored: "created", path: "x" }; },
      async discoverForScope() { return { receipts: [], skipped: [] }; }
    }
  });
  const before = await runBefore(silent);
  assert.equal(before.status, "collected");
  assert.equal(before.receiptHistory.status, "indeterminate");
  assert.deepEqual(before.receiptHistory.diagnostics, [
    { code: "review_history_status_unrecognized" }
  ]);

  const truncated = binderWith({
    store: storeWith([], [], { status: "partial", truncated: true })
  });
  const truncatedBefore = await runBefore(truncated);
  assert.equal(truncatedBefore.receiptHistory.status, "partial");
  assert.deepEqual(truncatedBefore.receiptHistory.diagnostics, [
    { code: "review_history_truncated" }
  ]);

  const empty = binderWith({ store: storeWith([]) });
  const emptyBefore = await runBefore(empty);
  assert.equal(emptyBefore.receiptHistory.status, "complete");
  assert.deepEqual(emptyBefore.receiptHistory.diagnostics, []);
  assert.deepEqual(emptyBefore.priorReviews, []);
});

test("a discovery failure is indeterminate rather than an ordinary empty history", async () => {
  const context = binderWith({
    store: {
      puts: [],
      async put() { return { stored: "created", path: "x" }; },
      async discoverForScope() { throw new Error("index unreadable"); }
    }
  });
  const before = await runBefore(context);
  assert.equal(before.status, "collected");
  assert.deepEqual(before.priorReviews, []);
  assert.equal(before.receiptHistory.status, "indeterminate");
  assert.deepEqual(before.receiptHistory.diagnostics, [
    { code: "review_history_discovery_failed" }
  ]);
});

test("prior reviews survive into the after result", async () => {
  const stateA = exactCollection(1);
  const first = binderWith({ collections: [stateA, stateA] });
  await runAfter(first, await runBefore(first));

  const second = binderWith({ store: storeWith([first.store.puts[0].receipt]) });
  const before = await runBefore(second);
  const after = await runAfter(second, before);
  assert.equal(after.priorReviews.length, 1);
});

test("the target spec travels unchanged from before into the receipt", async () => {
  const context = binderWith();
  const before = await runBefore(context);
  await runAfter(context, before);
  const stored = context.store.puts[0].receipt;
  assert.deepEqual({ ...stored.binding.target.spec }, { ...TARGET });
});

test("an absent target is recorded as absent, never invented", async () => {
  const noTarget = buildChangeSetDescriptor({
    objectFormat: "sha1",
    head: { commit: "1".repeat(40), unborn: false },
    target: { spec: NO_REVIEW_TARGET, resolution: "none", commit: null },
    index: [], worktree: [], unmerged: [], untracked: [], submodules: [],
    summary: { branch: "main", detached: false, mergeBase: null }
  });
  const identity = changeSetIdFor(noTarget);
  const collection = {
    status: "exact",
    descriptor: noTarget,
    changeSetId: identity.changeSetId,
    sections: identity.sections,
    summary: noTarget.summary
  };
  const context = binderWith({ collections: [collection, collection] });
  const before = await runBefore(context, { targetSpec: NO_REVIEW_TARGET });
  await runAfter(context, before);

  const stored = context.store.puts[0].receipt;
  assert.equal(stored.binding.target.spec.kind, "none");
  assert.equal(stored.binding.target.commit, null);
});

test("the receipt binds all eight section digests", async () => {
  const context = binderWith();
  const before = await runBefore(context);
  await runAfter(context, before);
  const stored = context.store.puts[0].receipt;
  assert.deepEqual(Object.keys(stored.binding.sections).sort(), [...SECTION_NAMES].sort());
});
