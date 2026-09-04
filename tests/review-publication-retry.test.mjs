import assert from "node:assert/strict";
import { mkdtemp, readFile, rename as realRename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Hex } from "../src/canonical-json.mjs";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../src/changeset/descriptor.mjs";
import { reviewTargetSpec } from "../src/changeset/target.mjs";
import { COHERENT_ADMISSION_KIND, buildReviewReceipt } from "../src/review/receipt-schema.mjs";
import { ReviewReceiptStore } from "../src/review/receipt-store.mjs";
import { createReceiptPublicationFence } from "../src/review/publication-fence.mjs";
import { createRequestDeadlineContext } from "../src/request-context.mjs";
import { createPublicationRetryPolicy, repositoryIdForCanonicalRootKey } from "../src/write-custody.mjs";

/**
 * Review evidence is published by the same kind of rename durable custody uses,
 * and a Windows host rejects it the same way. Losing a completed review to a
 * scanner holding the destination open for a moment is pure waste - but a
 * retry that assumes anything about that destination would be far worse, since
 * these two trees are append-only evidence.
 *
 * So the destination is always read before deciding. Exactly the expected
 * content means the publication already happened; nothing there means nothing
 * landed and another attempt is allowed; anything else is a real collision and
 * fails closed. An errno on its own never decides.
 */

const ROOT = "C:\\repo";
const ROOT_KEY = "c:\\repo";
const DIGEST = "a".repeat(64);
const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });
const RESULT_TEXT = "review findings for the publication retry suite\n";

async function withState(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-review-retry-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function receiptFor({ changeSetSeed = 1, resultText = RESULT_TEXT } = {}) {
  const sections = Object.fromEntries(SECTION_NAMES.map((name, index) =>
    [name, (changeSetSeed + index).toString(16).padStart(64, "0")]));
  const changeSetId = changeSetIdFromSectionDigests({ objectFormat: "sha1", sections });
  const summary = {
    headCommit: "2".repeat(40),
    branch: "main",
    detached: false,
    mergeBase: null,
    counts: { index: 0, worktree: 0, unmerged: 0, untracked: 0, submodules: 0 }
  };
  return buildReviewReceipt({
    binding: {
      changeSetId,
      objectFormat: "sha1",
      sections,
      target: { spec: TARGET, resolution: "resolved", commit: "1".repeat(40) },
      beforeSummary: summary,
      afterSummary: summary
    },
    coherence: {
      admission: COHERENT_ADMISSION_KIND,
      custodyExecutionId: "exec-" + changeSetSeed,
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
      reasoningEffort: "high"
    },
    assignment: { sha256: DIGEST, chars: 6 },
    execution: {
      executionId: "exec-" + changeSetSeed,
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 1_000
    },
    result: {
      sha256: sha256Hex(Buffer.from(resultText, "utf8")),
      bytes: Buffer.byteLength(resultText, "utf8")
    },
    provenance: {
      repositoryId: repositoryIdForCanonicalRootKey(ROOT_KEY),
      producer: "claude-agents-mcp/0.2.1",
      collector: "change-set-collector/v1",
      recordedAt: 3_000
    }
  });
}

/** A scheduler that fires only when the test says so, so a backoff can be held open. */
function heldScheduler() {
  const pending = new Map();
  let nextId = 1;
  return {
    schedule(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelSchedule(id) {
      pending.delete(id);
    }
  };
}

function testPolicy(overrides = {}) {
  return createPublicationRetryPolicy({ platform: "win32", backoffMs: [0], ...overrides });
}

/** Rejects the way Windows does - same errno, same syscall - for matching destinations. */
function transientRename({ failures = Infinity, code = "EPERM", match = () => true, onFailure } = {}) {
  const state = { matched: 0 };
  const seam = async (from, to) => {
    if (!match(String(to))) return await realRename(from, to);
    state.matched += 1;
    if (state.matched > failures) return await realRename(from, to);
    if (onFailure) await onFailure(state.matched, { from, to });
    const error = new Error(code + ": operation not permitted, rename");
    error.code = code;
    error.syscall = "rename";
    error.errno = -4048;
    error.path = String(from);
    error.dest = String(to);
    throw error;
  };
  seam.state = state;
  return seam;
}

const isArtifact = (to) => to.includes(path.sep + "artifacts" + path.sep);
const isReceipt = (to) => !isArtifact(to) && to.includes(path.sep + "cs" + path.sep);

function store(stateRoot, options = {}) {
  return new ReviewReceiptStore({ stateRoot, ...options });
}

const publish = async (receiptStore, receipt, extra = {}) => await receiptStore.put({
  canonicalRootKey: ROOT_KEY,
  receipt,
  resultText: RESULT_TEXT,
  publication: createReceiptPublicationFence().publication,
  awaitIndex: true,
  ...extra
});

test("a transiently rejected receipt publication retries and publishes exactly once", async () => {
  await withState(async (stateRoot) => {
    const renameFn = transientRename({ failures: 2, match: isReceipt });
    const receipt = receiptFor();
    const result = await publish(store(stateRoot, { renameFn, retryPolicy: testPolicy() }), receipt);
    assert.equal(result.stored, "created");
    assert.equal(renameFn.state.matched, 3);

    const persisted = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(persisted.reviewId, receipt.reviewId);
    // Discovery still sees exactly one receipt for this change set.
    const history = await store(stateRoot).listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: receipt.binding.changeSetId
    });
    assert.equal(history.receipts.length, 1);
  });
});

test("a transiently rejected result artifact retries and publishes exactly once", async () => {
  await withState(async (stateRoot) => {
    const renameFn = transientRename({ failures: 2, match: isArtifact });
    const result = await publish(store(stateRoot, { renameFn, retryPolicy: testPolicy() }), receiptFor());
    assert.equal(result.stored, "created");
    assert.equal(renameFn.state.matched, 3);

    const loaded = await store(stateRoot).loadResultArtifact({
      canonicalRootKey: ROOT_KEY,
      receipt: receiptFor()
    });
    assert.equal(loaded.status, "verified");
    assert.equal(loaded.text, RESULT_TEXT);
  });
});

test("a persistently rejected publication exhausts its bound and fails closed", async () => {
  await withState(async (stateRoot) => {
    const renameFn = transientRename({ match: isReceipt });
    const policy = testPolicy();
    const fence = createReceiptPublicationFence();
    await assert.rejects(
      store(stateRoot, { renameFn, retryPolicy: policy }).put({
        canonicalRootKey: ROOT_KEY,
        receipt: receiptFor(),
        resultText: RESULT_TEXT,
        publication: fence.publication,
        awaitIndex: true
      }),
      (error) => {
        assert.equal(error.code, "write_custody_publication_retry_exhausted");
        return true;
      }
    );
    assert.equal(renameFn.state.matched, policy.maxAttempts);
    // The fence is settled, not left ambiguous: every attempt was rejected
    // outright, so no receipt is outstanding.
    const settlement = await fence.authoritativeSettlement();
    assert.equal(settlement.disposition, "failed");
    // And nothing was published.
    const history = await store(stateRoot).listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: receiptFor().binding.changeSetId
    });
    assert.equal(history.receipts.length, 0);
  });

  await withState(async (stateRoot) => {
    const renameFn = transientRename({ match: isArtifact });
    await assert.rejects(
      publish(store(stateRoot, { renameFn, retryPolicy: testPolicy() }), receiptFor()),
      (error) => error.code === "write_custody_publication_retry_exhausted"
    );
  });
});

test("an identical target already in place is idempotent rather than a failure", async () => {
  // The receipt and the artifact are both content-addressed, so a destination
  // holding exactly the expected bytes means the publication already happened.
  await withState(async (stateRoot) => {
    const first = await publish(store(stateRoot), receiptFor());
    assert.equal(first.stored, "created");

    // Now every rename is rejected, and the only thing that can rescue the
    // publication is reading the destination and finding it already correct.
    const renameFn = transientRename({ match: () => true });
    const again = await publish(store(stateRoot, { renameFn, retryPolicy: testPolicy() }), receiptFor());
    assert.equal(again.stored, "identical");
    assert.equal(again.path, first.path);
  });
});

test("a destination holding different content is a hard collision and fails closed", async () => {
  // The receipt tree is append-only evidence. If the exact destination is
  // occupied by something that is not this receipt, no errno and no number of
  // attempts may turn that into a publication.
  await withState(async (stateRoot) => {
    const receipt = receiptFor();
    const published = await publish(store(stateRoot), receipt);
    await writeFile(published.path, JSON.stringify({ reviewId: receipt.reviewId, tampered: true }), "utf8");

    const renameFn = transientRename({ match: isReceipt });
    await assert.rejects(
      publish(store(stateRoot, { renameFn, retryPolicy: testPolicy() }), receipt),
      (error) => {
        assert.equal(error.code, "review_receipt_prefix_collision");
        return true;
      }
    );
    // A collision is decided on the first look, never retried into submission.
    assert.equal(renameFn.state.matched, 1);
    const stillThere = JSON.parse(await readFile(published.path, "utf8"));
    assert.equal(stillThere.tampered, true);
  });

  // The artifact tree behaves the same way: the digest path is occupied by
  // bytes that are not the ones this receipt declares.
  await withState(async (stateRoot) => {
    const receipt = receiptFor();
    await publish(store(stateRoot), receipt);
    const artifactPath = store(stateRoot).artifactPath(ROOT_KEY, receipt.result.sha256);
    await writeFile(artifactPath, RESULT_TEXT + "tampered", "utf8");

    await assert.rejects(
      publish(store(stateRoot, { renameFn: transientRename({ match: isArtifact }), retryPolicy: testPolicy() }), receipt),
      (error) => {
        assert.ok(
          ["review_result_artifact_conflict", "review_result_artifact_mismatch"].includes(error.code),
          error.code
        );
        return true;
      }
    );
  });
});

test("cancellation during a backoff starts no later rename", async () => {
  await withState(async (stateRoot) => {
    const scheduler = heldScheduler();
    const abortController = new AbortController();
    let rejected;
    const rejectedOnce = new Promise((resolve) => { rejected = resolve; });
    const renameFn = transientRename({ match: isReceipt, onFailure: () => rejected() });
    const requestContext = {
      assertActive: () => {
        if (abortController.signal.aborted) {
          throw Object.assign(new Error("cancelled"), { code: "claude_cancelled" });
        }
      },
      isActive: () => !abortController.signal.aborted,
      abortSignal: abortController.signal
    };

    const pending = store(stateRoot, {
      renameFn,
      retryPolicy: testPolicy({
        backoffMs: [60_000],
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule
      })
    }).put({
      canonicalRootKey: ROOT_KEY,
      receipt: receiptFor(),
      resultText: RESULT_TEXT,
      publication: createReceiptPublicationFence().publication,
      awaitIndex: true,
      requestContext
    });
    await rejectedOnce;
    abortController.abort();

    await assert.rejects(pending, (error) => typeof error?.code === "string");
    assert.equal(renameFn.state.matched, 1, "a cancelled backoff must not reach another rename");
  });
});

test("a root deadline expiring during a backoff starts no later rename", async () => {
  await withState(async (stateRoot) => {
    // The root request delivers cancellation and deadline expiry through one
    // signal, so this drives the real deadline path rather than a second clock.
    let time = 0;
    const timers = new Map();
    let nextTimer = 1;
    const clock = {
      now: () => time,
      schedule(callback, delay) {
        const id = nextTimer++;
        timers.set(id, { at: time + Math.max(0, delay), callback });
        return id;
      },
      cancel: (id) => timers.delete(id),
      advanceTo(target) {
        time = target;
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at <= time) {
            timers.delete(id);
            timer.callback();
          }
        }
      }
    };
    const requestContext = createRequestDeadlineContext({
      deadlineAt: 100,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel
    });

    const scheduler = heldScheduler();
    let rejected;
    const rejectedOnce = new Promise((resolve) => { rejected = resolve; });
    const renameFn = transientRename({ match: isReceipt, onFailure: () => rejected() });

    const pending = store(stateRoot, {
      renameFn,
      retryPolicy: testPolicy({
        backoffMs: [60_000],
        schedule: scheduler.schedule,
        cancelSchedule: scheduler.cancelSchedule
      })
    }).put({
      canonicalRootKey: ROOT_KEY,
      receipt: receiptFor(),
      resultText: RESULT_TEXT,
      publication: createReceiptPublicationFence().publication,
      awaitIndex: true,
      requestContext
    });
    await rejectedOnce;
    clock.advanceTo(100);

    await assert.rejects(pending, (error) => typeof error?.code === "string");
    assert.equal(requestContext.abortSignal.aborted, true);
    assert.equal(renameFn.state.matched, 1, "an expired deadline must not reach another rename");
    requestContext.dispose();
  });
});
