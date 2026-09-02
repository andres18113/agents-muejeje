import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.mjs";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../src/changeset/descriptor.mjs";
import {
  COHERENT_ADMISSION_KIND,
  MAX_RECEIPT_BYTES,
  ReviewReceiptError,
  buildReviewReceipt,
  computeReviewId,
  validateReviewReceipt
} from "../src/review/receipt-schema.mjs";
import {
  assignmentBasis,
  capabilityPolicyDigest,
  contractDigest,
  digestText,
  measureText,
  modelBasis,
  resultBasis,
  reviewerBasis
} from "../src/review/receipt-basis.mjs";
import { resolveCapabilityPolicy } from "../src/capability-policy.mjs";
import { getAgentProfile } from "../src/agent-registry.mjs";

const DIGEST = "a".repeat(64);

function sections() {
  return Object.fromEntries(SECTION_NAMES.map((name, index) => [name, String(index).repeat(64).slice(0, 64)]));
}

function parts(overrides = {}) {
  const sectionDigests = sections();
  return {
    binding: {
      changeSetId: changeSetIdFromSectionDigests({ objectFormat: "sha1", sections: sectionDigests }),
      objectFormat: "sha1",
      sections: sectionDigests,
      target: {
        spec: { kind: "ref", ref: "refs/remotes/origin/main", source: "request" },
        resolution: "resolved",
        commit: "1".repeat(40)
      },
      summary: {
        headCommit: "2".repeat(40),
        branch: "main",
        detached: false,
        mergeBase: "3".repeat(40),
        counts: { index: 1, worktree: 2, unmerged: 0, untracked: 1, submodules: 0 }
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
      reasoningEffort: "high"
    },
    assignment: { sha256: DIGEST, chars: 12 },
    execution: {
      executionId: "exec-1",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 1_000
    },
    result: { sha256: DIGEST, bytes: 42 },
    provenance: {
      repositoryId: DIGEST,
      producer: "claude-agents-mcp/0.2.0",
      collector: "change-set-collector/v1",
      recordedAt: 3_000
    },
    ...overrides
  };
}

test("a receipt round-trips through canonical JSON and verifies itself", () => {
  const receipt = buildReviewReceipt(parts());
  assert.match(receipt.reviewId, /^rr1:[0-9a-f]{64}$/u);

  const revived = validateReviewReceipt(JSON.parse(canonicalJson(receipt)));
  assert.ok(revived);
  assert.equal(revived.reviewId, receipt.reviewId);
});

test("the review id is computed with the field absent, never with a placeholder", () => {
  const receipt = buildReviewReceipt(parts());
  const { reviewId, ...body } = receipt;
  assert.equal(computeReviewId(body), reviewId);
  assert.throws(() => computeReviewId(receipt), ReviewReceiptError);
});

test("input field order never changes the review id", () => {
  const forward = buildReviewReceipt(parts());
  const reversedParts = parts();
  const reordered = {
    provenance: reversedParts.provenance,
    result: reversedParts.result,
    execution: reversedParts.execution,
    assignment: reversedParts.assignment,
    reviewer: reversedParts.reviewer,
    coherence: reversedParts.coherence,
    binding: reversedParts.binding
  };
  assert.equal(buildReviewReceipt(reordered).reviewId, forward.reviewId);
});

const MUTATIONS = [
  ["a section digest", (p) => {
    p.binding.sections.head = "f".repeat(64);
    p.binding.changeSetId = changeSetIdFromSectionDigests({
      objectFormat: p.binding.objectFormat,
      sections: p.binding.sections
    });
  }],
  ["binding.summary.branch", (p) => { p.binding.summary.branch = "other"; }],
  ["binding.summary.counts", (p) => { p.binding.summary.counts.index = 9; }],
  ["coherence.custodyExecutionId", (p) => { p.coherence.custodyExecutionId = "other"; }],
  ["coherence.beforeAt", (p) => { p.coherence.beforeAt = 1_001; }],
  ["reviewer.modelSelector", (p) => { p.reviewer.modelSelector = "sonnet"; }],
  ["assignment.chars", (p) => { p.assignment.chars = 11; }],
  ["result.bytes", (p) => { p.result.bytes = 43; }],
  ["provenance.recordedAt", (p) => { p.provenance.recordedAt = 3_001; }]
];

for (const [name, mutate] of MUTATIONS) {
  test("changing " + name + " changes the review id", () => {
    const base = buildReviewReceipt(parts());
    const changed = parts();
    mutate(changed);
    assert.notEqual(buildReviewReceipt(changed).reviewId, base.reviewId);
  });
}

test("a tampered receipt keeping its old id fails validation", () => {
  const receipt = buildReviewReceipt(parts());
  const tampered = {
    ...receipt,
    binding: { ...receipt.binding, changeSetId: "cs1:" + "9".repeat(64) }
  };
  assert.equal(validateReviewReceipt(tampered), undefined);
});

const REJECTIONS = [
  ["an extra top-level key", (r) => ({ ...r, extra: 1 })],
  ["an extra binding key", (r) => ({ ...r, binding: { ...r.binding, extra: 1 } })],
  ["an extra coherence key", (r) => ({ ...r, coherence: { ...r.coherence, extra: 1 } })],
  ["an extra reviewer key", (r) => ({ ...r, reviewer: { ...r.reviewer, extra: 1 } })],
  ["an extra assignment key", (r) => ({ ...r, assignment: { ...r.assignment, extra: 1 } })],
  ["an extra execution key", (r) => ({ ...r, execution: { ...r.execution, extra: 1 } })],
  ["an extra provenance key", (r) => ({ ...r, provenance: { ...r.provenance, extra: 1 } })],
  ["a missing key", (r) => { const { result, ...rest } = r; return rest; }],
  ["a wrong schema", (r) => ({ ...r, schema: "other" })],
  ["a non-completed execution", (r) => ({ ...r, execution: { ...r.execution, status: "timeout" } })],
  ["completedAt before startedAt", (r) => ({ ...r, execution: { ...r.execution, completedAt: 1 } })],
  ["recordedAt before completedAt", (r) => ({ ...r, provenance: { ...r.provenance, recordedAt: 1 } })],
  ["afterAt before beforeAt", (r) => ({ ...r, coherence: { ...r.coherence, afterAt: 1 } })],
  ["a non-review agent type", (r) => ({ ...r, reviewer: { ...r.reviewer, agentType: "general-purpose" } })],
  ["a short digest", (r) => ({ ...r, result: { ...r.result, sha256: "a".repeat(63) } })],
  ["a cs2 change set id", (r) => ({ ...r, binding: { ...r.binding, changeSetId: "cs2:" + DIGEST } })],
  ["a change set id inconsistent with its sections", (r) => ({ ...r, binding: {
    ...r.binding, changeSetId: "cs1:" + "b".repeat(64)
  } })],
  ["a wrong-width summary head", (r) => ({ ...r, binding: {
    ...r.binding, summary: { ...r.binding.summary, headCommit: "2".repeat(64) }
  } })],
  ["a wrong-width merge base", (r) => ({ ...r, binding: {
    ...r.binding, summary: { ...r.binding.summary, mergeBase: "3".repeat(64) }
  } })],
  ["a non-string branch", (r) => ({ ...r, binding: {
    ...r.binding, summary: { ...r.binding.summary, branch: 7 }
  } })],
  ["an unknown admission kind", (r) => ({ ...r, coherence: { ...r.coherence, admission: "handshake" } })],
  ["an unknown model selector source", (r) => ({ ...r, reviewer: { ...r.reviewer, modelSelectorSource: "guessed" } })]
];

for (const [name, mutate] of REJECTIONS) {
  test("validation rejects " + name, () => {
    assert.equal(validateReviewReceipt(mutate(buildReviewReceipt(parts()))), undefined);
  });
}

test("validation rejects a receipt with seven section digests instead of eight", () => {
  const seven = sections();
  delete seven.worktree;
  assert.throws(() => buildReviewReceipt(parts({
    binding: { ...parts().binding, sections: seven }
  })), ReviewReceiptError);
});

test("an oversized receipt is refused rather than stored", () => {
  assert.throws(() => buildReviewReceipt(parts({
    provenance: { ...parts().provenance, producer: "x".repeat(MAX_RECEIPT_BYTES) }
  })), (error) => {
    assert.equal(error.code, "review_receipt_too_large");
    return true;
  });
});

test("validation never throws, whatever it is handed", () => {
  for (const value of [undefined, null, 1, "x", [], {}, { schema: 1 }]) {
    assert.equal(validateReviewReceipt(value), undefined);
  }
});

// --- basis derivation (correction 3) ---------------------------------------

test("textual digests are taken over raw UTF-8 bytes with no trimming", () => {
  assert.equal(digestText("  padded  "), digestText("  padded  "));
  assert.notEqual(digestText("  padded  "), digestText("padded"));
  assert.equal(
    digestText("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("chars and bytes are distinct measurements and both are recorded", () => {
  // "é" is one UTF-16 code unit and two UTF-8 bytes; an emoji is two units and
  // four bytes. Conflating the two has misled every reader who assumed one.
  const measured = measureText("é\u{1f600}");
  assert.equal(measured.chars, 3);
  assert.equal(measured.bytes, 6);
  assert.equal(measured.sha256, digestText("é\u{1f600}"));

  const ascii = measureText("abc");
  assert.equal(ascii.chars, 3);
  assert.equal(ascii.bytes, 3);
});

test("the assignment basis measures the exact task text", () => {
  const basis = assignmentBasis("review the diff");
  assert.equal(basis.chars, 15);
  assert.equal(basis.sha256, digestText("review the diff"));
  assert.deepEqual(Object.keys(basis).sort(), ["chars", "sha256"]);
});

test("the result basis measures bytes, and a missing result is the empty string", () => {
  assert.equal(resultBasis("héllo").bytes, 6);
  assert.equal(resultBasis(undefined).sha256, digestText(""));
  assert.equal(resultBasis(undefined).bytes, 0);
  assert.equal(Object.hasOwn(resultBasis("x"), "chars"), false, "a result has no character contract");
});

test("the capability policy is digested through canonical JSON, not insertion order", () => {
  const policy = resolveCapabilityPolicy(getAgentProfile("code-review"));
  const reordered = Object.fromEntries(Object.entries(policy).reverse());
  assert.equal(capabilityPolicyDigest(policy), capabilityPolicyDigest(reordered));
  assert.notEqual(
    capabilityPolicyDigest(policy),
    capabilityPolicyDigest({ ...policy, shellPolicy: "git-readonly" })
  );
});

test("the two reviewers share a capability policy digest but not a contract digest", () => {
  const code = resolveCapabilityPolicy(getAgentProfile("code-review"));
  const security = resolveCapabilityPolicy(getAgentProfile("security-review"));
  assert.equal(capabilityPolicyDigest(code), capabilityPolicyDigest(security));
  assert.notEqual(contractDigest("code contract"), contractDigest("security contract"));
});

test("the model basis records the selector and its provenance, never an effective model", () => {
  const runtime = {
    model: "opus",
    modelSource: "operator-override",
    modelStrategy: "configurable",
    reasoningEffort: "high"
  };
  const basis = modelBasis(runtime);
  assert.deepEqual({ ...basis }, {
    modelSelector: "opus",
    modelSelectorSource: "operator-override",
    modelStrategy: "configurable",
    reasoningEffort: "high"
  });
  // Nothing in the receipt vocabulary may suggest the served model was observed.
  assert.equal(Object.hasOwn(basis, "model"), false);
  assert.equal(Object.hasOwn(basis, "effectiveModel"), false);
});

test("reviewerBasis assembles exactly the receipt's reviewer block", () => {
  const profile = getAgentProfile("security-review");
  const basis = reviewerBasis({
    agentType: profile.id,
    contract: "contract text",
    capabilityPolicy: resolveCapabilityPolicy(profile),
    runtime: {
      model: "opus",
      modelSource: "default",
      modelStrategy: profile.modelStrategy,
      reasoningEffort: profile.reasoningEffort
    }
  });
  assert.deepEqual(Object.keys(basis).sort(), [
    "agentType", "capabilityPolicySha256", "contractSha256",
    "modelSelector", "modelSelectorSource", "modelStrategy", "reasoningEffort"
  ]);
  assert.equal(basis.contractSha256, digestText("contract text"));
  assert.ok(validateReviewReceipt(buildReviewReceipt(parts({ reviewer: basis }))));
});
