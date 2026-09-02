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
  beginReceiptPublication,
  createReceiptPublicationFence,
  receiptPublicationCancelled,
  settleReceiptPublication
} from "../src/review/publication-fence.mjs";
import { projectDelegateAgentOutcome } from "../src/delegate-outcome.mjs";
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
      await beforeReceiptPublication?.({ receipt: entry.receipt });
      if (!beginReceiptPublication(entry.publication)) {
        throw Object.assign(new Error("publication cancelled"), {
          code: "review_receipt_publication_cancelled"
        });
      }
      const authoritative = Promise.resolve().then(() => {
        events.push("receipt-durable");
        receipts.push(entry.receipt);
        settleReceiptPublication(entry.publication, {
          status: "settled",
          disposition: "published",
          reviewId: entry.receipt.reviewId,
          changeSetId: entry.receipt.binding.changeSetId
        });
      });
      await afterReceiptPublicationIssued?.({ receipt: entry.receipt, authoritative });
      await authoritative;
      return { stored: "created", path: "receipt.json" };
    },
    async listForChangeSet() { return { receipts: [], skipped: [] }; },
    async discoverForScope() { return { receipts: [], skipped: [] }; }
  };
  const binder = createReviewBinder({
    collectChangeSet: async () => exactCollection(),
    coherentAdmission: { verifyStillHeld: async () => ({ held: true }) },
    receiptStore,
    now: () => 1_000
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
function delegationWorld({ afterHook, quiescenceTimeoutMs, afterTimeoutMs = 10, runAgent } = {}) {
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
      runAgent: runAgent || completedReviewRunner(),
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
      beginReceiptPublication(publication);
      await new Promise((resolve) => setTimeout(resolve, 120));
      events.push("receipt-durable");
      receipts.push("rr1");
      settleReceiptPublication(publication, {
        status: "settled",
        disposition: "published",
        reviewId: "rr1:" + "b".repeat(64),
        changeSetId: "cs1:" + "a".repeat(64)
      });
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
      beginReceiptPublication(publication);
      await new Promise((resolve) => setTimeout(resolve, 60));
      settleReceiptPublication(publication, {
        status: "settled",
        disposition: "published",
        reviewId: "rr1:" + "b".repeat(64),
        changeSetId: "cs1:" + "a".repeat(64)
      });
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
      beginReceiptPublication(publication);
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

test("a publication settling after the quiescence timeout takes the guarded late-release path", async () => {
  const maySettle = deferred();
  const lateReleaseObserved = deferred();
  const world = delegationWorld({
    afterHook: async ({ publication, events, receipts }) => {
      beginReceiptPublication(publication);
      events.push("publication-in-flight");
      await maySettle.promise;
      receipts.push("durable");
      events.push("receipt-durable");
      settleReceiptPublication(publication, {
        status: "settled",
        disposition: "published",
        reviewId: "rr1:" + "b".repeat(64),
        changeSetId: "cs1:" + "a".repeat(64)
      });
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
    quiescenceTimeoutMs: 20
  });
  world.dependencies.onLateReviewPublicationRelease = (diagnostic) => {
    if (diagnostic.status === "released") lateReleaseObserved.resolve();
  };

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );
  assert.equal(outcome.custodyState, "retained");
  assert.equal(
    outcome.recoveryDiagnostics.mode,
    "same-coordinator-publication-settlement"
  );
  assert.deepEqual(world.events, ["publication-in-flight"]);

  maySettle.resolve();
  await lateReleaseObserved.promise;
  assert.deepEqual(
    world.events,
    ["publication-in-flight", "receipt-durable", "custody-released"],
    "the same publication must settle before the same coordinator releases custody"
  );
});

test("settled authoritative publication is enough to release even if later housekeeping stalls", async () => {
  const world = delegationWorld({
    afterHook: async ({ publication, events, receipts }) => {
      beginReceiptPublication(publication);
      receipts.push("durable");
      events.push("receipt-durable");
      settleReceiptPublication(publication, {
        status: "settled",
        disposition: "published",
        reviewId: "rr1:" + "b".repeat(64),
        changeSetId: "cs1:" + "a".repeat(64)
      });
      await new Promise(() => {});
    },
    afterTimeoutMs: 10,
    quiescenceTimeoutMs: 20
  });

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );
  assert.equal(outcome.custodyState, "released");
  assert.equal(outcome.reviewBinding.status, "bound");
  assert.equal(outcome.reviewBinding.publication.status, "authoritative-settled");
  assert.deepEqual(world.events, ["receipt-durable", "custody-released"]);
});

test("a binder that fails after crossing the boundary still cannot release custody", async () => {
  // A rejection is not a withdrawal of authority. The receipt write this binder
  // issued is still live when the binder itself fails, so custody must be held
  // exactly as it would be for a binder that simply never returned.
  const maySettle = deferred();
  const lateReleaseObserved = deferred();
  const world = delegationWorld({
    afterHook: async ({ publication, events, receipts }) => {
      beginReceiptPublication(publication);
      events.push("publication-in-flight");
      void maySettle.promise.then(() => {
        receipts.push("durable");
        events.push("receipt-durable");
        settleReceiptPublication(publication, {
          status: "settled",
          disposition: "published",
          reviewId: "rr1:" + "b".repeat(64),
          changeSetId: "cs1:" + "a".repeat(64)
        });
      });
      throw Object.assign(new Error("binder failed after publishing"), {
        code: "binder_failed_late"
      });
    },
    afterTimeoutMs: 200,
    quiescenceTimeoutMs: 20
  });
  world.dependencies.onLateReviewPublicationRelease = (diagnostic) => {
    if (diagnostic.status === "released") lateReleaseObserved.resolve();
  };

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );
  assert.equal(outcome.status, "completed", "a binder failure never changes the execution");
  assert.equal(outcome.custodyState, "retained");
  assert.deepEqual(
    world.events,
    ["publication-in-flight"],
    "custody must not be released while an authorized receipt write is still live"
  );
  const codes = outcome.reviewBinding.reasons.map((reason) => reason.code);
  assert.ok(codes.includes("review_binding_internal_error"));
  assert.ok(codes.includes("review_receipt_publication_unquiesced"));
  assert.equal(
    codes.includes("review_binding_timeout"),
    false,
    "a rejection observed inside the bound is not a timeout"
  );
  assert.equal(outcome.reviewBinding.publication.status, "authoritative-pending");
  assert.equal(
    outcome.recoveryDiagnostics.mode,
    "same-coordinator-publication-settlement"
  );

  maySettle.resolve();
  await lateReleaseObserved.promise;
  assert.deepEqual(
    world.events,
    ["publication-in-flight", "receipt-durable", "custody-released"]
  );
});

test("a returned binding survives a publication that never quiesces", async () => {
  // The binder produced real evidence and the deadline proved nothing about the
  // write. Retaining custody is right; discarding the identities the binder
  // already established is not.
  const world = delegationWorld({
    afterHook: ({ publication, events }) => {
      beginReceiptPublication(publication);
      events.push("publication-in-flight");
      return {
        status: "bound",
        coherence: COHERENCE.HELD,
        reasons: [],
        changeSetId: "cs1:" + "a".repeat(64),
        beforeChangeSetId: "cs1:" + "a".repeat(64),
        afterChangeSetId: "cs1:" + "a".repeat(64),
        reviewId: "rr1:" + "b".repeat(64),
        priorReviews: [],
        receiptHistory: { status: "complete", receipts: [], diagnostics: [] }
      };
    },
    afterTimeoutMs: 200,
    quiescenceTimeoutMs: 20
  });

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );
  assert.equal(outcome.custodyState, "retained");
  assert.equal(outcome.reviewBinding.status, "bound");
  assert.equal(outcome.reviewBinding.beforeChangeSetId, "cs1:" + "a".repeat(64));
  assert.equal(outcome.reviewBinding.afterChangeSetId, "cs1:" + "a".repeat(64));
  assert.equal(outcome.reviewBinding.reviewId, "rr1:" + "b".repeat(64));
  assert.equal(outcome.reviewBinding.publication.status, "authoritative-pending");
  assert.equal(outcome.reviewBinding.publication.settled, false);
  assert.deepEqual(world.events, ["publication-in-flight"]);

  const projected = projectDelegateAgentOutcome(outcome);
  assert.equal(projected.review.status, "bound");
  assert.equal(projected.review.beforeChangeSetId, "cs1:" + "a".repeat(64));
  assert.equal(projected.review.afterChangeSetId, "cs1:" + "a".repeat(64));
  assert.equal(projected.review.publication.settled, false);
  assert.equal(projected.custody.retained, true);
  assert.equal(
    projected.custody.recovery.mode,
    "same-coordinator-publication-settlement"
  );
});

test("the late release is never more permissive than the synchronous one", async () => {
  // Same retained-unquiesced situation, but this run has no terminal proof.
  // The synchronous path would have orphaned rather than released here, so the
  // late path must refuse too: a bounded wait cannot buy release authority
  // that the evidence never granted.
  const maySettle = deferred();
  const lateOutcome = deferred();
  const startedWithoutProof = async (argumentsForRunner) => {
    await argumentsForRunner.onChildStarted?.(Object.freeze({
      executionId: "fence-execution",
      agentType: "code-review",
      repositoryRoot: WORKSPACE.repositoryRoot,
      pid: 42_001,
      startTime: "4200001",
      source: "publication-fence-test",
      startedAt: 1
    }));
    return { result: "review result", durationMs: 5, processStarted: true };
  };
  const world = delegationWorld({
    runAgent: startedWithoutProof,
    afterHook: async ({ publication, events }) => {
      beginReceiptPublication(publication);
      events.push("publication-in-flight");
      await maySettle.promise;
      settleReceiptPublication(publication, {
        status: "settled",
        disposition: "published",
        reviewId: "rr1:" + "b".repeat(64),
        changeSetId: "cs1:" + "a".repeat(64)
      });
      return { status: "bound", coherence: COHERENCE.HELD, reasons: [], priorReviews: [] };
    },
    afterTimeoutMs: 10,
    quiescenceTimeoutMs: 20
  });
  world.dependencies.onLateReviewPublicationRelease = (diagnostic) => {
    lateOutcome.resolve(diagnostic);
  };

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    world.dependencies
  );
  assert.equal(outcome.custodyState, "retained");

  maySettle.resolve();
  const diagnostic = await lateOutcome.promise;
  assert.equal(diagnostic.status, "retained");
  assert.equal(diagnostic.errorCode, "terminal_proof_unavailable");
  assert.equal(
    world.events.includes("custody-released"),
    false,
    "no release may happen without the terminal evidence the synchronous path requires"
  );
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
      events.push("at-publication-gate");
      // Parked well past the AFTER deadline, so cancellation lands strictly
      // before the store's authoritative rename boundary.
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!beginReceiptPublication(entry.publication)) {
        throw Object.assign(new Error("publication cancelled"), {
          code: "review_receipt_publication_cancelled"
        });
      }
      events.push("receipt-durable");
      receipts.push(entry.receipt);
      settleReceiptPublication(entry.publication, {
        status: "settled",
        disposition: "published",
        reviewId: entry.receipt.reviewId,
        changeSetId: entry.receipt.binding.changeSetId
      });
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
    now: Date.now
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

/**
 * Falsification attempts against the late-release path itself.
 *
 * The integration tests prove the real durable record refuses an unauthorized
 * late release. These prove the things above that record: that the settlement
 * it keys on can fire only once, and that a failure anywhere in the detached
 * callback stays inside it.
 */
test("an authoritative settlement can fire only once, so the late release runs once", async () => {
  const fence = createReceiptPublicationFence();
  assert.equal(beginReceiptPublication(fence.publication), true);
  assert.throws(
    () => beginReceiptPublication(fence.publication),
    /may be crossed only once/u,
    "authority cannot be crossed twice"
  );

  const settlement = {
    status: "settled",
    disposition: "published",
    reviewId: "rr1:" + "b".repeat(64),
    changeSetId: "cs1:" + "a".repeat(64)
  };
  assert.equal(settleReceiptPublication(fence.publication, settlement), true);
  assert.equal(
    settleReceiptPublication(fence.publication, { ...settlement, disposition: "failed" }),
    false,
    "a second settlement is refused, so no second release can be triggered"
  );

  const observed = await fence.authoritativeSettlement();
  assert.equal(observed.disposition, "published", "the first settlement is the one that stands");
  assert.equal(
    await fence.authoritativeSettlement(),
    observed,
    "every observer sees the same single settlement"
  );
});

test("a failing late-release callback cannot reject into the process", async () => {
  const seen = [];
  const record = (reason) => seen.push(reason);
  process.on("unhandledRejection", record);
  try {
    const maySettle = deferred();
    const attempted = deferred();
    const world = delegationWorld({
      afterHook: async ({ publication, events }) => {
        beginReceiptPublication(publication);
        events.push("publication-in-flight");
        await maySettle.promise;
        settleReceiptPublication(publication, {
          status: "settled",
          disposition: "published",
          reviewId: "rr1:" + "b".repeat(64),
          changeSetId: "cs1:" + "a".repeat(64)
        });
        return { status: "bound", coherence: COHERENCE.HELD, reasons: [], priorReviews: [] };
      },
      afterTimeoutMs: 10,
      quiescenceTimeoutMs: 20
    });
    // Both the release and its diagnostic fail. Neither may escape.
    world.dependencies.writeCustody.releaseWriteAccessAfterTerminal = async () => {
      throw Object.assign(new Error("durable release failed"), { code: "write_custody_conflict" });
    };
    world.dependencies.onLateReviewPublicationRelease = () => {
      attempted.resolve();
      throw new Error("diagnostic sink exploded");
    };

    const outcome = await delegateAgent(
      { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
      world.dependencies
    );
    assert.equal(outcome.custodyState, "retained");

    maySettle.resolve();
    await attempted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, [], "a detached late release must never reject into the process");
    assert.equal(
      world.events.includes("custody-released"),
      false,
      "a failed release never reports itself as a release"
    );
  } finally {
    process.off("unhandledRejection", record);
  }
});
