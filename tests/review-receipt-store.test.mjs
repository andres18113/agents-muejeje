import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.mjs";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../src/changeset/descriptor.mjs";
import { reviewTargetSpec, NO_REVIEW_TARGET } from "../src/changeset/target.mjs";
import {
  COHERENT_ADMISSION_KIND,
  buildReviewReceipt,
  validateReviewReceipt
} from "../src/review/receipt-schema.mjs";
import {
  MAX_POINTERS_PER_SCOPE,
  MAX_RECEIPTS_PER_CHANGE_SET,
  ReviewReceiptStore
} from "../src/review/receipt-store.mjs";
import {
  DurableWriteCustodyManager,
  repositoryIdForCanonicalRootKey
} from "../src/write-custody.mjs";

const ROOT = "C:\\repo";
const ROOT_KEY = "c:\\repo";
const DIGEST = "a".repeat(64);

const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

async function withState(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-receipts-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function sectionsFor(seed) {
  return Object.fromEntries(SECTION_NAMES.map((name, index) =>
    [name, (seed + index).toString(16).padStart(64, "0")]));
}

function receiptFor({
  changeSetSeed = 1,
  agentType = "code-review",
  targetSpec = TARGET,
  recordedAt = 3_000,
  assignment = "review"
} = {}) {
  const sections = sectionsFor(changeSetSeed);
  const changeSetId = changeSetIdFromSectionDigests({ objectFormat: "sha1", sections });
  return buildReviewReceipt({
    binding: {
      changeSetId,
      objectFormat: "sha1",
      sections,
      target: targetSpec.kind === "none"
        ? { spec: targetSpec, resolution: "none", commit: null }
        : { spec: targetSpec, resolution: "resolved", commit: "1".repeat(40) },
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
      custodyExecutionId: "exec-" + changeSetSeed,
      beforeAt: 1_000,
      afterAt: 2_000
    },
    reviewer: {
      agentType,
      contractSha256: DIGEST,
      capabilityPolicySha256: DIGEST,
      modelSelector: "opus",
      modelSelectorSource: "default",
      modelStrategy: "configurable",
      reasoningEffort: "high"
    },
    assignment: {
      sha256: DIGEST,
      chars: assignment.length
    },
    execution: {
      executionId: "exec-" + changeSetSeed,
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 1_000
    },
    result: { sha256: DIGEST, bytes: 10 },
    provenance: {
      repositoryId: repositoryIdForCanonicalRootKey(ROOT_KEY),
      producer: "claude-agents-mcp/0.2.0",
      collector: "change-set-collector/v1",
      recordedAt
    }
  });
}

function store(stateRoot) {
  return new ReviewReceiptStore({ stateRoot });
}

test("a receipt is written atomically and leaves no staging directory behind", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor();
    const result = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });

    assert.equal(result.stored, "created");
    const persisted = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(validateReviewReceipt(persisted).reviewId, receipt.reviewId);

    const changeSetDirectory = path.dirname(path.dirname(result.path));
    const leftovers = (await readdir(changeSetDirectory)).filter((name) => name.startsWith("."));
    assert.deepEqual(leftovers, []);
  });
});

test("an identical put is idempotent and rewrites nothing", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor();
    const first = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    const before = await stat(first.path);

    const second = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    assert.equal(second.stored, "identical");
    const after = await stat(first.path);
    assert.equal(after.mtimeMs, before.mtimeMs, "an idempotent put must not rewrite the file");
  });
});

test("a different receipt under the same digest prefix is refused, not overwritten", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor();
    const written = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });

    // Impersonate a prefix collision by editing the file in place.
    await writeFile(written.path, canonicalJson(receiptFor({ assignment: "different" })) + "\n", "utf8");
    const before = await readFile(written.path, "utf8");

    await assert.rejects(receipts.put({ canonicalRootKey: ROOT_KEY, receipt }), (error) => {
      assert.equal(error.code, "review_receipt_prefix_collision");
      return true;
    });
    assert.equal(await readFile(written.path, "utf8"), before, "nothing may be overwritten");
  });
});

test("listForChangeSet matches on the full identifier, not the truncated directory name", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor({ changeSetSeed: 1 });
    const written = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });

    // A foreign receipt deliberately placed under the same 20-hex prefix.
    const foreign = receiptFor({ changeSetSeed: 2 });
    const foreignDirectory = path.join(path.dirname(path.dirname(written.path)), "ffffffffffffffffffff");
    await mkdir(foreignDirectory, { recursive: true });
    await writeFile(path.join(foreignDirectory, "receipt.json"), canonicalJson(foreign) + "\n", "utf8");

    const listed = await receipts.listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: receipt.binding.changeSetId
    });
    assert.deepEqual(listed.receipts.map((r) => r.reviewId), [receipt.reviewId]);
  });
});

test("corrupt entries are reported and left exactly where they are", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor();
    const written = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    const changeSetDirectory = path.dirname(path.dirname(written.path));

    const corrupt = path.join(changeSetDirectory, "0".repeat(20));
    await mkdir(corrupt, { recursive: true });
    await writeFile(path.join(corrupt, "receipt.json"), "{ not json", "utf8");

    const tampered = path.join(changeSetDirectory, "1".repeat(20));
    await mkdir(tampered, { recursive: true });
    await writeFile(
      path.join(tampered, "receipt.json"),
      canonicalJson({ ...receipt, reviewId: "rr1:" + "0".repeat(64) }) + "\n",
      "utf8"
    );

    const listed = await receipts.listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: receipt.binding.changeSetId
    });
    assert.equal(listed.receipts.length, 1);
    assert.equal(listed.skipped.length, 2);
    assert.deepEqual(listed.skipped.map((s) => s.code).sort(),
      ["review_receipt_corrupt", "review_receipt_unparsable"]);

    // Evidence is preserved; nothing is deleted heuristically.
    assert.ok(await stat(path.join(corrupt, "receipt.json")));
    assert.ok(await stat(path.join(tampered, "receipt.json")));
  });
});

test("the per-change-set cap refuses rather than evicting", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor({ changeSetSeed: 1 });
    const changeSetDirectory = path.join(
      receipts.reviewsDirectory(ROOT_KEY), "cs", receipt.binding.changeSetId.slice(4, 24)
    );
    await mkdir(changeSetDirectory, { recursive: true });
    for (let index = 0; index < MAX_RECEIPTS_PER_CHANGE_SET; index += 1) {
      await mkdir(path.join(changeSetDirectory, index.toString(16).padStart(20, "0")));
    }

    await assert.rejects(
      receipts.put({ canonicalRootKey: ROOT_KEY, receipt }),
      (error) => {
        assert.equal(error.code, "review_receipt_store_full");
        return true;
      }
    );
    assert.equal((await readdir(changeSetDirectory)).length, MAX_RECEIPTS_PER_CHANGE_SET);
  });
});

test("a state root deep enough to breach the path budget refuses to write", async () => {
  await withState(async (stateRoot) => {
    const deep = path.join(stateRoot, "d".repeat(120), "e".repeat(120));
    await assert.rejects(
      new ReviewReceiptStore({ stateRoot: deep }).put({ canonicalRootKey: ROOT_KEY, receipt: receiptFor() }),
      (error) => {
        assert.equal(error.code, "review_receipt_path_too_long");
        return true;
      }
    );
  });
});

test("a staging directory left by a crash does not block a later put", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor({ changeSetSeed: 1 });
    const changeSetDirectory = path.join(
      receipts.reviewsDirectory(ROOT_KEY), "cs", receipt.binding.changeSetId.slice(4, 24)
    );
    await mkdir(path.join(changeSetDirectory, ".review-orphan.tmp"), { recursive: true });

    const result = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    assert.equal(result.stored, "created");
  });
});

test("a receipt survives a fresh store instance", async () => {
  await withState(async (stateRoot) => {
    const receipt = receiptFor();
    await store(stateRoot).put({ canonicalRootKey: ROOT_KEY, receipt });

    const listed = await store(stateRoot).listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: receipt.binding.changeSetId
    });
    assert.deepEqual(listed.receipts.map((r) => r.reviewId), [receipt.reviewId]);
  });
});

test("a scope-index failure never downgrades an already durable receipt", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: receiptFor({ changeSetSeed: 1 }) });
    const scopeRoot = path.join(receipts.reviewsDirectory(ROOT_KEY), "sc");
    const [scopeName] = await readdir(scopeRoot);
    const scopePath = path.join(scopeRoot, scopeName);
    await rm(scopePath, { recursive: true, force: true });
    await writeFile(scopePath, "not a directory", "utf8");

    const second = receiptFor({ changeSetSeed: 2 });
    const result = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: second });
    assert.equal(result.stored, "created");
    assert.equal(validateReviewReceipt(JSON.parse(await readFile(result.path, "utf8"))).reviewId, second.reviewId);
  });
});

test("an invalid change-set lookup cannot escape the receipt tree", async () => {
  await withState(async (stateRoot) => {
    const listed = await store(stateRoot).listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: "../../outside"
    });
    assert.deepEqual(listed.receipts, []);
    assert.deepEqual(listed.skipped, [{ code: "change_set_id_invalid" }]);
  });
});

// --- discovery by scope: what makes STALE reachable ------------------------

test("a receipt is discoverable by scope after the repository has moved on", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const old = receiptFor({ changeSetSeed: 1 });
    await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: old });

    // The repository is now at a different change set. A lookup keyed by the
    // current identifier would find nothing; scope discovery still finds this.
    const byChangeSet = await receipts.listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: "cs1:" + (99).toString(16).padStart(64, "0")
    });
    assert.deepEqual(byChangeSet.receipts, []);

    const discovered = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(discovered.receipts.map((r) => r.reviewId), [old.reviewId]);
  });
});

test("discovery is scoped by agent type and by declared target", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const code = receiptFor({ changeSetSeed: 1, agentType: "code-review" });
    const security = receiptFor({ changeSetSeed: 2, agentType: "security-review" });
    const otherTarget = receiptFor({
      changeSetSeed: 3,
      targetSpec: reviewTargetSpec({ ref: "refs/heads/release", source: "request" })
    });
    const noTarget = receiptFor({ changeSetSeed: 4, targetSpec: NO_REVIEW_TARGET });
    for (const receipt of [code, security, otherTarget, noTarget]) {
      await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    }

    const found = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts.map((r) => r.reviewId), [code.reviewId]);

    const forSecurity = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "security-review",
      targetSpec: TARGET
    });
    assert.deepEqual(forSecurity.receipts.map((r) => r.reviewId), [security.reviewId]);
  });
});

test("a misplaced pointer cannot cross stable review scopes", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const expected = receiptFor({ changeSetSeed: 1 });
    const foreign = receiptFor({
      changeSetSeed: 2,
      targetSpec: reviewTargetSpec({ ref: "refs/heads/release", source: "request" })
    });
    await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: expected });
    await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: foreign });

    const scopeRoot = path.join(receipts.reviewsDirectory(ROOT_KEY), "sc");
    const scopeDirectories = await readdir(scopeRoot);
    let expectedDirectory;
    let foreignPointer;
    for (const directoryName of scopeDirectories) {
      const directory = path.join(scopeRoot, directoryName);
      const [pointerName] = await readdir(directory);
      const pointerText = await readFile(path.join(directory, pointerName), "utf8");
      const pointer = JSON.parse(pointerText);
      if (pointer.reviewId === expected.reviewId) expectedDirectory = directory;
      if (pointer.reviewId === foreign.reviewId) foreignPointer = pointerText;
    }
    assert.ok(expectedDirectory);
    assert.ok(foreignPointer);
    await writeFile(
      path.join(expectedDirectory, "9999999999999-foreign-scope.json"),
      foreignPointer,
      "utf8"
    );

    const found = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts.map((receipt) => receipt.reviewId), [expected.reviewId]);
    assert.ok(found.skipped.some((entry) => entry.code === "review_pointer_scope_mismatch"));
  });
});

test("discovery returns the newest receipts first", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const older = receiptFor({ changeSetSeed: 1, recordedAt: 3_000 });
    const newer = receiptFor({ changeSetSeed: 2, recordedAt: 9_000 });
    await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: older });
    await receipts.put({ canonicalRootKey: ROOT_KEY, receipt: newer });

    const found = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts.map((r) => r.reviewId), [newer.reviewId, older.reviewId]);
  });
});

test("the discovery index is bounded, and pruning never touches a receipt", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const written = [];
    for (let index = 1; index <= MAX_POINTERS_PER_SCOPE + 5; index += 1) {
      const receipt = receiptFor({ changeSetSeed: index, recordedAt: 3_000 + index });
      written.push(await receipts.put({ canonicalRootKey: ROOT_KEY, receipt }));
    }

    const scopeRoot = path.join(receipts.reviewsDirectory(ROOT_KEY), "sc");
    const scopeDirectory = path.join(scopeRoot, (await readdir(scopeRoot))[0]);
    assert.equal((await readdir(scopeDirectory)).length, MAX_POINTERS_PER_SCOPE);

    // Every receipt is still on disk; only pointers were dropped.
    for (const entry of written) assert.ok(await stat(entry.path));
  });
});

test("a discovered receipt is fully validated, and a dangling or lying pointer is skipped", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor({ changeSetSeed: 1 });
    const written = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });

    const scopeRoot = path.join(receipts.reviewsDirectory(ROOT_KEY), "sc");
    const scopeDirectory = path.join(scopeRoot, (await readdir(scopeRoot))[0]);

    // A pointer to a receipt that does not exist.
    await writeFile(
      path.join(scopeDirectory, "0000000000001-" + "b".repeat(20) + ".json"),
      canonicalJson({ changeSetId: "cs1:" + "b".repeat(64), recordedAt: 1, reviewId: "rr1:" + "b".repeat(64) }) + "\n",
      "utf8"
    );
    // A pointer whose claims disagree with the receipt it names.
    await writeFile(
      path.join(scopeDirectory, "0000000000002-" + "c".repeat(20) + ".json"),
      canonicalJson({
        changeSetId: receipt.binding.changeSetId,
        recordedAt: 2,
        reviewId: "rr1:" + "c".repeat(64)
      }) + "\n",
      "utf8"
    );
    await writeFile(path.join(scopeDirectory, "0000000000003-unparsable.json"), "{ nope", "utf8");
    await writeFile(
      path.join(scopeDirectory, "0000000000004-invalid.json"),
      canonicalJson({ changeSetId: "../../outside", recordedAt: 4, reviewId: "rr1:" + "d".repeat(64) }) + "\n",
      "utf8"
    );

    const found = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts.map((r) => r.reviewId), [receipt.reviewId]);
    assert.equal(found.skipped.length, 4);
    assert.ok(found.skipped.some((entry) => entry.code === "review_pointer_invalid"));

    // A tampered receipt is refused even though a valid pointer names it.
    await writeFile(written.path, canonicalJson({ ...receipt, result: { sha256: DIGEST, bytes: 99 } }) + "\n", "utf8");
    const after = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(after.receipts, []);
    const corrupt = after.skipped.find((entry) => entry.code === "review_receipt_corrupt");
    assert.equal(corrupt.reviewId, receipt.reviewId);
    assert.equal(corrupt.changeSetId, receipt.binding.changeSetId);
  });
});

test("discovery on an untouched repository is empty rather than an error", async () => {
  await withState(async (stateRoot) => {
    const found = await store(stateRoot).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts, []);
    assert.deepEqual(found.skipped, []);
  });
});

test("the receipt tree never disturbs Phase 5 custody sharing the same repository directory", async () => {
  await withState(async (stateRoot) => {
    const custody = new DurableWriteCustodyManager({
      stateRoot,
      currentPid: 100,
      now: () => 1_000,
      inspectProcess: async (pid) => ({
        status: "alive",
        identity: { pid, startTime: "10000", source: "test-identity" }
      })
    });
    await custody.reserveWriteAccess({
      executionId: "writer-a",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    await store(stateRoot).put({ canonicalRootKey: ROOT_KEY, receipt: receiptFor() });

    // Ownership must be entirely unaffected by a sibling reviews/ tree.
    const held = await custody.getWriteAccess(ROOT_KEY);
    assert.equal(held.executionId, "writer-a");
    const reconciliation = await custody.reconcileExistingOwnership(ROOT_KEY);
    assert.equal(reconciliation.released, false);
  });
});
