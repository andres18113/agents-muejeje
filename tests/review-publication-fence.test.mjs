import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { getAgentProfile } from "../src/agent-registry.mjs";
import { resolveCapabilityPolicy } from "../src/capability-policy.mjs";
import { buildChangeSetDescriptor, changeSetIdFor } from "../src/changeset/descriptor.mjs";
import { reviewTargetSpec } from "../src/changeset/target.mjs";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { COHERENCE } from "../src/review/coherent-admission.mjs";
import {
  createReceiptPublicationFence,
  receiptPublicationCancelled
} from "../src/review/publication-fence.mjs";
import { createReviewBinder } from "../src/review/review-binding.mjs";
import { validateReviewReceipt } from "../src/review/receipt-schema.mjs";

/**
 * The Phase 6 publication invariant, stated as the two things it forbids:
 *
 *   a receipt was written  =>  the fence had not been cancelled before the
 *                              publication boundary;
 *   custody was released   =>  no receipt write was still in flight.
 *
 * A deadline is an observation, so the AFTER binding's outer bound cannot be
 * read as proof that the binder stopped. Both facts above are therefore decided
 * by the fence rather than by the timer: cancellation before the boundary
 * removes publication authority for good, and a boundary already crossed forces
 * the caller to wait for quiescence before it releases the slot.
 *
 * Every test here pauses the receipt write on one side of that boundary or the
 * other and checks the resulting order of real events.
 */

const WORKSPACE = Object.freeze({
  requestedCwd: "C:\\repo",
  effectiveCwd: "C:\\repo",
  workspaceRoot: "C:\\repo",
  repositoryRoot: "C:\\repo",
  repositoryIdentity: "C:\\repo\\.git",
  canonicalRepositoryKey: "c:\\repo\\.git",
  rootSource: "git-boundary",
  isolated: false
});

const RUNTIME = Object.freeze({
  model: "opus",
  modelSource: "default",
  modelStrategy: "configurable",
  reasoningEffort: "high"
});

const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

/**
 * A completed review with the same terminal evidence a real one produces, so
 * custody takes its ordinary release path and the ordering under test is the
 * real one rather than an orphaning fallback.
 */
function completedReviewRunner() {
  const child = new EventEmitter();
  child.pid = 42_000;
  const processIdentity = Object.freeze({
    executionId: "fence-execution",
    agentType: "code-review",
    repositoryRoot: WORKSPACE.repositoryRoot,
    pid: child.pid,
    startTime: "4200000",
    source: "publication-fence-test",
    child,
    startedAt: 1
  });
  return async (argumentsForRunner) => {
    await argumentsForRunner.onChildStarted?.(processIdentity);
    return {
      result: "review result",
      durationMs: 5,
      processStarted: true,
      processIdentity,
      terminalProof: Object.freeze({
        processIdentity,
        event: "close",
        code: 0,
        signal: null,
        observedAt: 2
      })
    };
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function exactCollection() {
  const descriptor = buildChangeSetDescriptor({
    objectFormat: "sha1",
    head: { commit: "1".repeat(40), unborn: false },
    target: { spec: TARGET, resolution: "resolved", commit: "2".repeat(40) },
    index: [], worktree: [], unmerged: [], untracked: [], submodules: [],
    summary: { branch: "main", detached: false, mergeBase: null }
  });
  const { sections, changeSetId } = changeSetIdFor(descriptor);
  return { status: "exact", descriptor, changeSetId, sections, summary: descriptor.summary };
}

/**
 * One shared event log across the binder, the receipt store and custody, so the
 * ordering assertions are about what actually happened rather than about what
 * each component believed.
 */
function reviewWorld({ beforeReceiptPublication, afterReceiptPublicationIssued } = {}) {
  const events = [];
  const receipts = [];
  const receiptStore = {
    async put(entry) {
      events.push("receipt-durable");
      receipts.push(entry.receipt);
      return { stored: "created", path: "receipt.json" };
    },
    async listForChangeSet() { return { receipts: [], skipped: [] }; },
    async discoverForScope() { return { receipts: [], skipped: [] }; }
  };
  const binder = createReviewBinder({
    collectChangeSet: async () => exactCollection(),
    coherentAdmission: { verifyStillHeld: async () => ({ held: true }) },
    receiptStore,
    now: () => 1_000,
    beforeReceiptPublication,
    afterReceiptPublicationIssued
  });
  return { events, receipts, receiptStore, binder };
}

async function runBinding(world, publication) {
  const before = await world.binder.before({
    profile: getAgentProfile("code-review"),
    runtime: RUNTIME,
    contract: "contract text",
    capabilityPolicy: resolveCapabilityPolicy(getAgentProfile("code-review")),
    task: "review this",
    workspace: WORKSPACE,
    coherence: COHERENCE.HELD,
    custodyExecutionId: "exec-1",
    targetSpec: TARGET
  });
  return world.binder.after({
    beforeState: before,
    workspace: WORKSPACE,
    outcome: { status: "completed", result: "findings" },
    executionId: "exec-1",
    startedAt: 500,
    completedAt: 900,
    publication
  });
}

test("the fence starts open and reports its two states honestly", () => {
  const fence = createReceiptPublicationFence();
  assert.equal(fence.cancellationRequested(), false);
  assert.equal(fence.publicationStarted(), false);
  assert.equal(receiptPublicationCancelled(fence.publication), false);
  fence.requestCancellation();
  assert.equal(fence.cancellationRequested(), true);
  assert.equal(receiptPublicationCancelled(fence.publication), true);
  assert.equal(fence.publicationStarted(), false, "cancelling never starts a publication");
});

test("cancellation before the boundary permanently removes the authority to publish", async () => {
  const reachedGate = deferred();
  const released = deferred();
  const world = reviewWorld({
    beforeReceiptPublication: async () => {
      world.events.push("at-publication-gate");
      reachedGate.resolve();
      await released.promise;
    }
  });
  const fence = createReceiptPublicationFence();
  const binding = runBinding(world, fence.publication);

  await reachedGate.promise;
  assert.equal(fence.publicationStarted(), false, "the boundary has not been crossed yet");
  fence.requestCancellation();
  released.resolve();

  const result = await binding;
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.reasons.map((reason) => reason.code), ["review_receipt_publication_cancelled"]);
  assert.deepEqual(world.receipts, [], "a cancelled publication writes nothing, ever");
  assert.equal(world.events.includes("receipt-durable"), false);
  assert.equal(fence.publicationStarted(), false);
});

test("a publication already issued cannot have its authority withdrawn", async () => {
  const issued = deferred();
  const released = deferred();
  const world = reviewWorld({
    afterReceiptPublicationIssued: async () => {
      issued.resolve();
      await released.promise;
    }
  });
  const fence = createReceiptPublicationFence();
  const binding = runBinding(world, fence.publication);

  await issued.promise;
  assert.equal(fence.publicationStarted(), true, "the boundary is crossed before the store is asked");
  // Too late. The write is in flight and cancelling cannot unmake it.
  fence.requestCancellation();
  released.resolve();

  const result = await binding;
  assert.equal(result.status, "bound");
  assert.equal(world.receipts.length, 1);
  assert.ok(validateReviewReceipt(world.receipts[0]));
});

/**
 * The same two cases, driven end to end through delegateAgent so that the
 * ordering claim is about real custody release rather than about the binder in
 * isolation.
 */
function delegationWorld({ afterHook, quiescenceTimeoutMs, afterTimeoutMs = 10 } = {}) {
  const events = [];
  const receipts = [];
  const writeCustody = {
    stateRoot: "C:\\durable-state",
    repositoryStateDirectory: () => "C:\\durable-state\\repository",
    async markSpawning() { return { state: "SPAWNING" }; },
    async activateWriteAccess() { return { state: "ACTIVE" }; },
    async releaseUnstartedWriteAccess() {
      events.push("custody-released");
      return { state: "RELEASED" };
    },
    async releaseWriteAccessAfterTerminal() {
      events.push("custody-released");
      return { state: "RELEASED" };
    },
    async markOrphanedWriteAccess() {
      events.push("custody-orphaned");
      return { state: "ORPHANED" };
    }
  };
  const reviewBinder = {
    async before() {
      return {
        status: "collected",
        coherence: COHERENCE.HELD,
        reviewSubject: "REVIEW SUBJECT\n==============\n\nfixture",
        priorReviews: []
      };
    },
    async after({ publication }) {
      return afterHook({ publication, events, receipts });
    }
  };
  return {
    events,
    receipts,
    dependencies: {
      env: {},
      createExecutionId: () => "fence-execution",
      resolveWorkingDirectory: async () => WORKSPACE.effectiveCwd,
      resolveWorkspaceRoot: async () => WORKSPACE,
      resolveRepositoryIdentity: async () => WORKSPACE,
      loadContract: async () => "contract bytes\n",
      writeCustody,
      coherentAdmission: {
        async admit() { return { coherence: COHERENCE.HELD, record: { state: "RESERVED" } }; }
      },
      reviewBinder,
      runAgent: completedReviewRunner(),
      reviewBindingAfterTimeoutMs: afterTimeoutMs,
      ...(quiescenceTimeoutMs === undefined ? {} : { reviewReceiptQuiescenceTimeoutMs: quiescenceTimeoutMs })
    }
  };
}

test("custody release never overtakes a receipt write that was already issued", async () => {
  const world = delegationWorld({
    afterHook: async ({ publication, events, receipts }) => {
      // Cross the boundary immediately, then stay in flight well past the
      // AFTER deadline. The delegation must wait rather than release.
      publication.guard.publicationStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      events.push("receipt-durable");
      receipts.push("rr1");
      return { status: "bound", coherence: COHERENCE.HELD, reasons: [], priorReviews: [] };
    },
    afterTimeoutMs: 10,
    quiescenceTimeoutMs: 5_000
  });

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );

  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    world.events,
    ["receipt-durable", "custody-released"],
    "the receipt must become durable before custody is released"
  );
  // The binding outran its bound but was then observed to finish, with custody
  // still held. Its real result is reported, and the expired bound beside it.
  assert.equal(outcome.reviewBinding.status, "bound");
  assert.ok(outcome.reviewBinding.reasons.some((reason) =>
    reason.code === "review_binding_deadline_exceeded"));
  assert.equal(
    outcome.reviewBinding.reasons.some((reason) => reason.code === "review_receipt_publication_unquiesced"),
    false,
    "the write did quiesce, so nothing is left uncertain"
  );
});

test("a late binding result is never discarded in favour of the timer's guess", async () => {
  const world = delegationWorld({
    afterHook: async ({ publication }) => {
      publication.guard.publicationStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        status: "bound",
        coherence: COHERENCE.HELD,
        reasons: [],
        changeSetId: "cs1:" + "a".repeat(64),
        reviewId: "rr1:" + "b".repeat(64),
        priorReviews: []
      };
    },
    afterTimeoutMs: 10,
    quiescenceTimeoutMs: 5_000
  });

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );

  assert.equal(outcome.reviewBinding.status, "bound");
  assert.equal(outcome.reviewBinding.reviewId, "rr1:" + "b".repeat(64));
  assert.deepEqual(
    outcome.reviewBinding.reasons.map((reason) => reason.code),
    ["review_binding_deadline_exceeded"],
    "the expired bound is recorded, not used to erase the result"
  );
  assert.deepEqual(world.events, ["custody-released"]);
});

test("a publication that never quiesces retains custody instead of releasing it", async () => {
  const world = delegationWorld({
    afterHook: ({ publication, events, receipts }) => {
      publication.guard.publicationStarted = true;
      // Never settles: the deadline observed uncertainty and proved nothing.
      return new Promise(() => {
        events.push("publication-in-flight");
        receipts.push("pending");
      });
    },
    afterTimeoutMs: 10,
    quiescenceTimeoutMs: 20
  });

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );

  assert.equal(outcome.status, "completed", "evidence machinery never fails a completed review");
  assert.equal(
    world.events.includes("custody-released"),
    false,
    "an unquiesced receipt write must not be overtaken by a custody release"
  );
  assert.equal(world.events.includes("custody-orphaned"), false);
  assert.equal(outcome.custodyState, "retained");
  const codes = outcome.reviewBinding.reasons.map((reason) => reason.code);
  assert.ok(codes.includes("review_binding_timeout"));
  assert.ok(codes.includes("review_receipt_publication_unquiesced"));
  assert.ok(codes.includes("coherent_admission_retained"));
});

test("a binding that never reaches its boundary releases custody at once", async () => {
  const world = delegationWorld({
    // Hangs before the publication boundary, so cancellation removes authority
    // for good and there is nothing whose quiescence could matter.
    afterHook: () => new Promise(() => {}),
    afterTimeoutMs: 10,
    quiescenceTimeoutMs: 5_000
  });

  const started = Date.now();
  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );

  assert.ok(Date.now() - started < 4_000, "an unstarted publication is never waited on");
  assert.deepEqual(world.events, ["custody-released"]);
  assert.equal(
    outcome.reviewBinding.reasons.some((reason) => reason.code === "review_receipt_publication_unquiesced"),
    false
  );
});

test("a real binder cancelled at its gate leaves no receipt and still releases custody", async () => {
  const events = [];
  const receipts = [];
  const receiptStore = {
    async put(entry) {
      events.push("receipt-durable");
      receipts.push(entry.receipt);
      return { stored: "created", path: "receipt.json" };
    },
    async listForChangeSet() { return { receipts: [], skipped: [] }; },
    async discoverForScope() { return { receipts: [], skipped: [] }; }
  };
  const binder = createReviewBinder({
    collectChangeSet: async () => exactCollection(),
    coherentAdmission: { verifyStillHeld: async () => ({ held: true }) },
    receiptStore,
    // The delegation stamps the execution with a real clock, and a receipt is
    // only valid when it was recorded no earlier than the execution completed.
    now: Date.now,
    beforeReceiptPublication: async () => {
      events.push("at-publication-gate");
      // Parked well past the AFTER deadline, so cancellation lands strictly
      // before the boundary.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  const writeCustody = {
    stateRoot: "C:\\durable-state",
    repositoryStateDirectory: () => "C:\\durable-state\\repository",
    async markSpawning() { return { state: "SPAWNING" }; },
    async activateWriteAccess() { return { state: "ACTIVE" }; },
    async releaseUnstartedWriteAccess() {
      events.push("custody-released");
      return { state: "RELEASED" };
    },
    async releaseWriteAccessAfterTerminal() {
      events.push("custody-released");
      return { state: "RELEASED" };
    },
    async markOrphanedWriteAccess() {
      events.push("custody-orphaned");
      return { state: "ORPHANED" };
    }
  };

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    {
      env: {},
      createExecutionId: () => "fence-execution",
      resolveWorkingDirectory: async () => WORKSPACE.effectiveCwd,
      resolveWorkspaceRoot: async () => WORKSPACE,
      resolveRepositoryIdentity: async () => WORKSPACE,
      loadContract: async () => "contract bytes\n",
      writeCustody,
      coherentAdmission: {
        async admit() { return { coherence: COHERENCE.HELD, record: { state: "RESERVED" } }; }
      },
      reviewBinder: binder,
      runAgent: completedReviewRunner(),
      reviewBindingAfterTimeoutMs: 20
    }
  );

  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    events,
    ["at-publication-gate", "custody-released"],
    "the binder really did reach its publication gate before custody was released"
  );

  // Give the parked binder every chance to publish late. It must not.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(receipts, [], "no receipt may appear after custody was released");
  assert.deepEqual(events, ["at-publication-gate", "custody-released"]);
  assert.ok(outcome.reviewBinding.reasons.some((reason) => reason.code === "review_binding_timeout"));
});
