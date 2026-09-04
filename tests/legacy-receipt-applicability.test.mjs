import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Hex } from "../src/canonical-json.mjs";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../src/changeset/descriptor.mjs";
import { reviewTargetSpec } from "../src/changeset/target.mjs";
import {
  LEGACY_EVIDENCE_REASON,
  receiptSatisfiesCommittedReview
} from "../src/review/committed-evidence.mjs";
import { COHERENT_ADMISSION_KIND, buildReviewReceipt, validateReviewReceipt } from "../src/review/receipt-schema.mjs";
import { ReviewReceiptStore } from "../src/review/receipt-store.mjs";
import { createReceiptPublicationFence } from "../src/review/publication-fence.mjs";
import { repositoryIdForCanonicalRootKey } from "../src/write-custody.mjs";

/**
 * What a receipt written before v0.2.2 may still be used for.
 *
 * Those receipts recorded no committed-review evidence, because none was
 * collected. That does not make them wrong, and it must not make them
 * unreadable: they remain valid objects, their findings are still recoverable,
 * and their freshness against the current repository is still computable. All
 * of that is history worth keeping.
 *
 * What they cannot do is answer a question that did not exist when they were
 * written. A receipt whose basis was never recorded cannot say which committed
 * delta it covered, so accepting one as an authoritative committed final review
 * would be manufacturing evidence retroactively - the reviewer's silence about
 * a delta would be read as having reviewed it. The older receipt therefore
 * stays fully usable for everything it was always good for, and a committed
 * final review that needs a bound basis needs a new receipt.
 */

const ROOT_KEY = "c:\\repo";
const DIGEST = "a".repeat(64);
const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });
const RESULT_TEXT = "LEGACY REVIEW FINDINGS: one defect found in bug.js\n";

function evidenceIdentity(seed = "1") {
  return Object.freeze({
    schema: "claude-agents-mcp/review-evidence/v1",
    kind: "committed-delta",
    completeness: "complete",
    sha256: sha256Hex(Buffer.from("evidence-" + seed, "utf8"))
  });
}

function receiptFor({ changeSetSeed = 1, evidence, resultText = RESULT_TEXT } = {}) {
  const sections = Object.fromEntries(SECTION_NAMES.map((name, index) =>
    [name, (changeSetSeed + index).toString(16).padStart(64, "0")]));
  const summary = {
    headCommit: "2".repeat(40),
    branch: "main",
    detached: false,
    mergeBase: null,
    counts: { index: 0, worktree: 0, unmerged: 0, untracked: 0, submodules: 0 }
  };
  return buildReviewReceipt({
    binding: {
      changeSetId: changeSetIdFromSectionDigests({ objectFormat: "sha1", sections }),
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
    },
    ...(evidence ? { evidence } : {})
  });
}

async function withStore(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-legacy-"));
  try {
    await callback(new ReviewReceiptStore({ stateRoot: root }), root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

const publish = (store, receipt) => store.put({
  canonicalRootKey: ROOT_KEY,
  receipt,
  resultText: RESULT_TEXT,
  publication: createReceiptPublicationFence().publication,
  awaitIndex: true
});

test("A - a v0.2.1 receipt without an evidence key remains valid and loadable", async () => {
  const legacy = receiptFor();
  // The shape a v0.2.1 receipt actually has: no evidence key at all.
  assert.equal(Object.hasOwn(legacy, "evidence"), false);
  assert.ok(validateReviewReceipt(legacy), "a legacy receipt must still validate");

  await withStore(async (store) => {
    const stored = await publish(store, legacy);
    assert.equal(stored.stored, "created");
    const reloaded = validateReviewReceipt(JSON.parse(await readFile(stored.path, "utf8")));
    assert.ok(reloaded, "a legacy receipt must survive a round trip through the store");
    assert.equal(reloaded.reviewId, legacy.reviewId);
    // History still discovers it: nothing here removes it from the record.
    const history = await store.listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: legacy.binding.changeSetId
    });
    assert.equal(history.receipts.length, 1);
    assert.equal(history.receipts[0].reviewId, legacy.reviewId);
  });
});

test("B - the findings of a legacy receipt remain recoverable", async () => {
  await withStore(async (store) => {
    const legacy = receiptFor();
    await publish(store, legacy);
    const artifact = await store.loadResultArtifact({ canonicalRootKey: ROOT_KEY, receipt: legacy });
    assert.equal(artifact.status, "verified");
    assert.equal(artifact.text, RESULT_TEXT);
    assert.match(artifact.text, /LEGACY REVIEW FINDINGS/u);
  });
});

test("C - a legacy receipt cannot satisfy an authoritative committed final review", () => {
  const verdict = receiptSatisfiesCommittedReview(receiptFor());
  assert.equal(verdict.applicable, false);
  assert.equal(verdict.reason, LEGACY_EVIDENCE_REASON);
});

test("D - an evidence-bound receipt can", () => {
  const bound = receiptFor({ evidence: evidenceIdentity() });
  assert.equal(Object.hasOwn(bound, "evidence"), true);
  assert.ok(validateReviewReceipt(bound));
  const verdict = receiptSatisfiesCommittedReview(bound);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.evidence.sha256, bound.evidence.sha256);

  // And a receipt whose bound basis was incomplete is refused for a different,
  // equally specific reason: it recorded a basis, but not a whole one.
  const truncated = receiptFor({
    changeSetSeed: 2,
    evidence: { ...evidenceIdentity("2"), completeness: "truncated" }
  });
  const partial = receiptSatisfiesCommittedReview(truncated);
  assert.equal(partial.applicable, false);
  assert.equal(partial.reason, "insufficient_review_scope");
});

test("E and F - selection never substitutes a legacy receipt where evidence is required", () => {
  // The selection rule the reconciliation path applies, exercised directly on
  // the two shapes that matter.
  const legacy = { reviewId: "rr1:" + "1".repeat(64), verdict: "FRESH", receipt: receiptFor() };
  const bound = {
    reviewId: "rr1:" + "2".repeat(64),
    verdict: "FRESH",
    receipt: receiptFor({ changeSetSeed: 5, evidence: evidenceIdentity("5") })
  };
  const applicable = (entry) => receiptSatisfiesCommittedReview(entry.receipt).applicable;

  // E: a legacy receipt alone leaves nothing selectable, rather than being
  // quietly promoted into the answer.
  assert.deepEqual([legacy].filter(applicable), []);
  assert.equal(receiptSatisfiesCommittedReview(legacy.receipt).reason, LEGACY_EVIDENCE_REASON);

  // F: with both present, only the evidence-bound one is eligible - the legacy
  // one cannot be chosen just because it is also FRESH.
  const eligible = [legacy, bound].filter(applicable);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].reviewId, bound.reviewId);

  // Where committed evidence is not required, both remain usable, so advisory
  // and historical inspection is unaffected.
  const withoutRequirement = [legacy, bound].filter(() => true);
  assert.equal(withoutRequirement.length, 2);
});

test("legacy and evidence-bound receipts are distinct durable objects", async () => {
  await withStore(async (store) => {
    // Same review content, one with a bound basis and one without: the basis is
    // part of the identity, so they are not interchangeable.
    const legacy = receiptFor({ changeSetSeed: 7 });
    const bound = receiptFor({ changeSetSeed: 7, evidence: evidenceIdentity("7") });
    assert.notEqual(bound.reviewId, legacy.reviewId);
    assert.equal(bound.binding.changeSetId, legacy.binding.changeSetId);

    await publish(store, legacy);
    await publish(store, bound);
    const history = await store.listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: legacy.binding.changeSetId
    });
    assert.equal(history.receipts.length, 2, "both remain discoverable history");
    const applicableIds = history.receipts
      .filter((entry) => receiptSatisfiesCommittedReview(entry).applicable)
      .map((entry) => entry.reviewId);
    assert.deepEqual(applicableIds, [bound.reviewId]);
  });
});
