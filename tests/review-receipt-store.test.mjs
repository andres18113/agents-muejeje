import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../src/canonical-json.mjs";
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
  MAX_RECOVERY_CHANGE_SETS,
  ReviewReceiptStore
} from "../src/review/receipt-store.mjs";
import { createReceiptPublicationFence } from "../src/review/publication-fence.mjs";
import {
  DurableWriteCustodyManager,
  repositoryIdForCanonicalRootKey
} from "../src/write-custody.mjs";

const ROOT = "C:\\repo";
const ROOT_KEY = "c:\\repo";
const DIGEST = "a".repeat(64);

const TARGET = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  assignment = "review",
  resultText
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
    result: typeof resultText === "string"
      ? { sha256: sha256Hex(Buffer.from(resultText, "utf8")), bytes: Buffer.byteLength(resultText, "utf8") }
      : { sha256: DIGEST, bytes: 10 },
    provenance: {
      repositoryId: repositoryIdForCanonicalRootKey(ROOT_KEY),
      producer: "claude-agents-mcp/0.2.1",
      collector: "change-set-collector/v1",
      recordedAt
    }
  });
}

function store(stateRoot) {
  return new ReviewReceiptStore({ stateRoot });
}

async function writeTextDurably(pathname, text) {
  const handle = await open(pathname, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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

test("receipt provenance cannot authorize a different repository scope", async () => {
  await withState(async (stateRoot) => {
    const receipts = store(stateRoot);
    const receipt = receiptFor();
    await assert.rejects(
      receipts.put({ canonicalRootKey: "c:\\other-repository", receipt }),
      (error) => {
        assert.equal(error.code, "review_receipt_repository_mismatch");
        return true;
      }
    );

    const written = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    const otherRootKey = "c:\\other-repository";
    const relativePath = path.relative(receipts.reviewsDirectory(ROOT_KEY), written.path);
    const graftedPath = path.join(receipts.reviewsDirectory(otherRootKey), relativePath);
    await mkdir(path.dirname(graftedPath), { recursive: true });
    await copyFile(written.path, graftedPath);

    const found = await receipts.discoverForScope({
      canonicalRootKey: otherRootKey,
      agentType: receipt.reviewer.agentType,
      targetSpec: receipt.binding.target.spec
    });
    assert.equal(found.status, "partial");
    assert.equal(found.authoritativeExhaustive, false);
    assert.deepEqual(found.receipts, []);
    assert.ok(found.skipped.some((entry) => entry.code === "review_history_recovery_unreadable"));
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
    const resultText = "capacity precondition";
    const receipt = receiptFor({ changeSetSeed: 1, resultText });
    const changeSetDirectory = path.join(
      receipts.reviewsDirectory(ROOT_KEY), "cs", receipt.binding.changeSetId.slice(4, 24)
    );
    await mkdir(changeSetDirectory, { recursive: true });
    for (let index = 0; index < MAX_RECEIPTS_PER_CHANGE_SET; index += 1) {
      await mkdir(path.join(changeSetDirectory, index.toString(16).padStart(20, "0")));
    }

    const fence = createReceiptPublicationFence();
    await assert.rejects(
      receipts.put({ canonicalRootKey: ROOT_KEY, receipt, resultText, publication: fence.publication }),
      (error) => {
        assert.equal(error.code, "review_receipt_store_full");
        return true;
      }
    );
    assert.equal((await readdir(changeSetDirectory)).length, MAX_RECEIPTS_PER_CHANGE_SET);
    assert.equal(fence.publicationStarted(), false);
    assert.equal(fence.publicationSettled(), false);
    assert.equal((await fence.authoritativeSettlement()).status, "not-started");
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

test("the authoritative fence is adjacent to the receipt rename and excludes scope indexing", async () => {
  await withState(async (stateRoot) => {
    const renameIssued = deferred();
    const allowRename = deferred();
    const indexReached = deferred();
    const resultText = "authoritative artifact";
    const receipt = receiptFor({ resultText });
    const receipts = new ReviewReceiptStore({
      stateRoot,
      renameFn: async (...args) => {
        if (String(args[1]).endsWith(".txt")) return await rename(...args);
        renameIssued.resolve();
        await allowRename.promise;
        return await rename(...args);
      },
      beforeScopeIndex: async () => {
        indexReached.resolve();
        await new Promise(() => {});
      }
    });
    const fence = createReceiptPublicationFence();
    const pending = receipts.put({
      canonicalRootKey: ROOT_KEY,
      receipt,
      resultText,
      publication: fence.publication,
      awaitIndex: false
    });

    await renameIssued.promise;
    assert.equal(fence.publicationStarted(), true);
    assert.equal(fence.publicationSettled(), false);
    fence.requestCancellation();
    allowRename.resolve();

    const stored = await pending;
    await indexReached.promise;
    assert.equal(fence.publicationSettled(), true);
    const settlement = await fence.authoritativeSettlement();
    assert.equal(settlement.disposition, "published");
    assert.equal(settlement.reviewId, receipt.reviewId);
    assert.ok(await stat(stored.path), "authoritative reviews/cs evidence is already durable");
    assert.equal(
      await Promise.race([stored.indexing.then(() => "settled"), Promise.resolve("pending")]),
      "pending",
      "reviews/sc housekeeping remains outside publication quiescence"
    );
  });
});

test("cancellation before the store rename boundary can never publish a late receipt", async () => {
  await withState(async (stateRoot) => {
    const boundaryReached = deferred();
    const allowBoundary = deferred();
    const resultText = "cancel before receipt fence";
    const receipt = receiptFor({ resultText });
    const receipts = new ReviewReceiptStore({
      stateRoot,
      beforeAuthoritativeRename: async () => {
        boundaryReached.resolve();
        await allowBoundary.promise;
      }
    });
    const fence = createReceiptPublicationFence();
    const pending = receipts.put({
      canonicalRootKey: ROOT_KEY,
      receipt,
      resultText,
      publication: fence.publication,
      awaitIndex: false
    });
    await boundaryReached.promise;
    fence.requestCancellation();
    allowBoundary.resolve();

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "review_receipt_publication_cancelled");
      return true;
    });
    assert.equal(fence.publicationStarted(), false);
    const listed = await receipts.listForChangeSet({
      canonicalRootKey: ROOT_KEY,
      changeSetId: receipt.binding.changeSetId
    });
    assert.deepEqual(listed.receipts, []);
  });
});

test("artifact write failures remain before the authoritative receipt fence", async () => {
  for (const code of ["ENOSPC", "EIO", "EACCES"]) {
    await withState(async (stateRoot) => {
      const resultText = "artifact write failure " + code;
      const receipt = receiptFor({ resultText });
      let writes = 0;
      const receipts = new ReviewReceiptStore({
        stateRoot,
        writeFileDurablyFn: async (pathname, text) => {
          writes += 1;
          if (writes === 2) throw Object.assign(new Error(code), { code });
          await writeTextDurably(pathname, text);
        }
      });
      const fence = createReceiptPublicationFence();

      await assert.rejects(
        receipts.put({ canonicalRootKey: ROOT_KEY, receipt, resultText, publication: fence.publication }),
        (error) => error?.code === code
      );
      assert.equal(fence.publicationStarted(), false, code);
      assert.equal(fence.publicationSettled(), false, code);
      assert.equal((await fence.authoritativeSettlement()).status, "not-started", code);
      const listed = await receipts.listForChangeSet({
        canonicalRootKey: ROOT_KEY,
        changeSetId: receipt.binding.changeSetId
      });
      assert.deepEqual(listed.receipts, [], code);
    });
  }
});

test("artifact rename permission failure without a verified target refuses receipt publication", async () => {
  await withState(async (stateRoot) => {
    const resultText = "permission denied artifact";
    const receipt = receiptFor({ resultText });
    const receipts = new ReviewReceiptStore({
      stateRoot,
      renameFn: async (source, destination) => {
        if (String(destination).endsWith(".txt")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return await rename(source, destination);
      }
    });
    const fence = createReceiptPublicationFence();

    await assert.rejects(
      receipts.put({ canonicalRootKey: ROOT_KEY, receipt, resultText, publication: fence.publication }),
      (error) => error?.code === "review_result_artifact_conflict"
    );
    assert.equal(fence.publicationStarted(), false);
    assert.equal((await fence.authoritativeSettlement()).status, "not-started");
  });
});

test("an already valid content-addressed artifact is idempotent before receipt publication", async () => {
  await withState(async (stateRoot) => {
    const resultText = "existing valid artifact";
    const receipt = receiptFor({ resultText });
    let artifactRenameAttempts = 0;
    const receipts = new ReviewReceiptStore({
      stateRoot,
      renameFn: async (source, destination) => {
        if (String(destination).endsWith(".txt")) {
          artifactRenameAttempts += 1;
          throw Object.assign(new Error("already there"), { code: "EEXIST" });
        }
        return await rename(source, destination);
      }
    });
    const artifact = receipts.artifactPath(ROOT_KEY, receipt.result.sha256);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, resultText, "utf8");
    const fence = createReceiptPublicationFence();

    const stored = await receipts.put({
      canonicalRootKey: ROOT_KEY,
      receipt,
      resultText,
      publication: fence.publication
    });
    assert.equal(stored.stored, "created");
    assert.equal(artifactRenameAttempts, 0);
    assert.equal(fence.publicationStarted(), true);
    assert.equal((await fence.authoritativeSettlement()).disposition, "published");
    assert.equal((await receipts.loadResultArtifact({ canonicalRootKey: ROOT_KEY, receipt })).status, "verified");
  });
});

test("a corrupt existing artifact refuses receipt publication", async () => {
  await withState(async (stateRoot) => {
    const resultText = "expected artifact";
    const receipt = receiptFor({ resultText });
    let artifactRenameAttempts = 0;
    const receipts = new ReviewReceiptStore({
      stateRoot,
      renameFn: async (source, destination) => {
        if (String(destination).endsWith(".txt")) {
          artifactRenameAttempts += 1;
          throw Object.assign(new Error("already there"), { code: "ENOTEMPTY" });
        }
        return await rename(source, destination);
      }
    });
    const artifact = receipts.artifactPath(ROOT_KEY, receipt.result.sha256);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "corrupt", "utf8");
    const fence = createReceiptPublicationFence();

    await assert.rejects(
      receipts.put({ canonicalRootKey: ROOT_KEY, receipt, resultText, publication: fence.publication }),
      (error) => error?.code === "review_result_artifact_conflict"
    );
    assert.equal(artifactRenameAttempts, 0);
    assert.equal(fence.publicationStarted(), false);
    assert.equal((await fence.authoritativeSettlement()).status, "not-started");
  });
});

test("artifact verification uses raw bytes rather than a UTF-8 replacement decode", async () => {
  await withState(async (stateRoot) => {
    const resultText = "\uFFFD";
    const receipt = receiptFor({ resultText });
    const receipts = store(stateRoot);
    const artifact = receipts.artifactPath(ROOT_KEY, receipt.result.sha256);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, Buffer.from([0x80]));
    const fence = createReceiptPublicationFence();

    await assert.rejects(
      receipts.put({ canonicalRootKey: ROOT_KEY, receipt, resultText, publication: fence.publication }),
      (error) => error?.code === "review_result_artifact_conflict"
    );
    assert.equal(fence.publicationStarted(), false);
    assert.equal((await fence.authoritativeSettlement()).status, "not-started");
  });
});

test("a stalled artifact cancelled before the fence cannot leave late receipt publication armed", async () => {
  await withState(async (stateRoot) => {
    const resultText = "stalled artifact";
    const receipt = receiptFor({ resultText });
    const artifactWriteStarted = deferred();
    const allowArtifactWrite = deferred();
    let writes = 0;
    const receipts = new ReviewReceiptStore({
      stateRoot,
      writeFileDurablyFn: async (pathname, text) => {
        writes += 1;
        if (writes === 2) {
          artifactWriteStarted.resolve();
          await allowArtifactWrite.promise;
        }
        await writeTextDurably(pathname, text);
      }
    });
    const fence = createReceiptPublicationFence();
    const pending = receipts.put({ canonicalRootKey: ROOT_KEY, receipt, resultText, publication: fence.publication });

    await artifactWriteStarted.promise;
    fence.requestCancellation();
    allowArtifactWrite.resolve();
    await assert.rejects(pending, (error) => error?.code === "review_receipt_publication_cancelled");
    assert.equal(fence.publicationStarted(), false);
    assert.equal((await fence.authoritativeSettlement()).status, "not-started");
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
    assert.equal(found.status, "complete");
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
    assert.equal(after.status, "partial");
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
    assert.equal(found.status, "complete");
    assert.equal(found.truncated, false);
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

/**
 * The sc index is allowed to fail silently so that indexing can never downgrade
 * a durable receipt. That same silence is what makes an empty index unable to
 * stand on its own as evidence: nothing about it distinguishes "no review ever
 * happened" from "the pointer was never written". These tests hold the store to
 * answering that question from the authoritative cs tree instead.
 */
test("index loss cannot make durable evidence read as a proven empty history", async () => {
  await withState(async (stateRoot) => {
    const receipt = receiptFor({ changeSetSeed: 7, recordedAt: 5_000 });

    // The authoritative receipt lands; scope indexing fails outright.
    const publishing = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: () => {
        throw Object.assign(new Error("scope index unavailable"), { code: "EACCES" });
      }
    });
    const stored = await publishing.put({ canonicalRootKey: ROOT_KEY, receipt });
    assert.equal(stored.stored, "created");
    assert.ok(await stat(stored.path), "the authoritative receipt is durable");
    assert.deepEqual(
      await readdir(publishing.reviewsDirectory(ROOT_KEY)),
      ["cs"],
      "no scope index exists to discover through"
    );

    // A completely fresh store, with no memory of the publication attempt.
    const found = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });

    assert.notEqual(
      found.status === "complete" && found.receipts.length === 0,
      true,
      "durable evidence must never be reported as a proven absence"
    );
    assert.deepEqual(found.receipts.map((entry) => entry.reviewId), [receipt.reviewId]);
    assert.equal(found.status, "complete");
    assert.ok(found.skipped.some((entry) => entry.code === "review_history_recovered_from_receipts"));
  });
});

test("recovery is scoped, deduplicated and ordered like the index path", async () => {
  await withState(async (stateRoot) => {
    const unindexed = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: () => {
        throw Object.assign(new Error("no index"), { code: "EACCES" });
      }
    });
    const older = receiptFor({ changeSetSeed: 1, recordedAt: 3_000 });
    const newer = receiptFor({ changeSetSeed: 2, recordedAt: 9_000 });
    // Same repository, different review scope: must not be recovered here.
    const otherScope = receiptFor({ changeSetSeed: 3, recordedAt: 9_500, agentType: "security-review" });
    for (const receipt of [older, newer, otherScope]) {
      await unindexed.put({ canonicalRootKey: ROOT_KEY, receipt });
    }
    // One receipt that IS indexed, so the merge path is exercised too.
    const indexed = receiptFor({ changeSetSeed: 4, recordedAt: 6_000 });
    await store(stateRoot).put({ canonicalRootKey: ROOT_KEY, receipt: indexed });

    const found = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });

    assert.deepEqual(
      found.receipts.map((entry) => entry.reviewId),
      [newer.reviewId, indexed.reviewId, older.reviewId],
      "newest first, with the indexed receipt merged in exactly once"
    );
    assert.equal(
      found.receipts.filter((entry) => entry.reviewId === indexed.reviewId).length,
      1,
      "an indexed receipt must not be duplicated by recovery"
    );
    assert.equal(
      found.receipts.some((entry) => entry.reviewId === otherScope.reviewId),
      false,
      "recovery never crosses a review scope"
    );
  });
});

test("a recovery sweep that cannot complete says so instead of claiming completeness", async () => {
  await withState(async (stateRoot) => {
    // The authoritative tree cannot be enumerated at all: readdir fails with
    // something other than ENOENT, which proves nothing about the history.
    const receipts = new ReviewReceiptStore({ stateRoot });
    const reviewsDirectory = receipts.reviewsDirectory(ROOT_KEY);
    await mkdir(reviewsDirectory, { recursive: true });
    await writeFile(path.join(reviewsDirectory, "cs"), "not a directory", "utf8");

    const found = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.equal(found.status, "indeterminate");
    assert.deepEqual(found.receipts, []);
    assert.ok(found.skipped.some((entry) => entry.code === "review_history_recovery_failed"));
  });
});

test("an unreadable authoritative entry is an unknown, never a proven absence", async () => {
  await withState(async (stateRoot) => {
    const receipts = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: () => {
        throw Object.assign(new Error("no index"), { code: "EACCES" });
      }
    });
    const receipt = receiptFor({ changeSetSeed: 5, recordedAt: 4_000 });
    const stored = await receipts.put({ canonicalRootKey: ROOT_KEY, receipt });
    await writeFile(stored.path, "{ this is not a receipt", "utf8");

    const found = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts, []);
    assert.notEqual(found.status, "complete", "an unattributable receipt is not an absence");
    assert.ok(found.skipped.some((entry) => entry.code === "review_history_recovery_unreadable"));
  });
});

test("recovery stays bounded and reports the bound rather than guessing", async () => {
  await withState(async (stateRoot) => {
    const receipts = new ReviewReceiptStore({ stateRoot });
    const found = await receipts.discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET,
      limit: 1
    });
    // Nothing exists yet: an untouched repository is still a provable absence.
    assert.equal(found.status, "complete");
    assert.deepEqual(found.receipts, []);
    assert.equal(found.truncated, false);
    assert.ok(MAX_RECOVERY_CHANGE_SETS > 0, "the sweep is bounded by construction");

    // With more scope-matching receipts than the caller's bound, the sweep
    // fills the bound and reports that it stopped early.
    const unindexed = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: () => {
        throw Object.assign(new Error("no index"), { code: "EACCES" });
      }
    });
    for (const seed of [1, 2, 3]) {
      await unindexed.put({
        canonicalRootKey: ROOT_KEY,
        receipt: receiptFor({ changeSetSeed: seed, recordedAt: 3_000 + seed })
      });
    }
    const bounded = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET,
      limit: 1
    });
    assert.equal(bounded.receipts.length, 1);
    assert.equal(bounded.status, "partial");
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.skipped.some((entry) => entry.code === "review_history_recovery_truncated"));
  });
});

/**
 * Detached housekeeping, held to the claim that it is detached.
 *
 * The sc index is maintained after the authoritative receipt is durable and is
 * not awaited by publication. That is only safe if its failure is inert in
 * every direction: it must not reject into the process, must not be able to
 * unmake the receipt, and must not touch custody.
 */
async function withoutUnhandledRejections(callback) {
  const seen = [];
  const record = (reason) => seen.push(reason);
  process.on("unhandledRejection", record);
  try {
    await callback();
    // Two macrotask turns: an unhandled rejection is reported after the
    // microtask queue drains, so a single await would not have observed one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", record);
  }
  return seen;
}

test("pointer failure after put returns cannot reject into the process", async () => {
  await withState(async (stateRoot) => {
    const releaseIndex = deferred();
    const receipts = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: async () => {
        // Still pending when put() returns, then fails.
        await releaseIndex.promise;
        throw Object.assign(new Error("index exploded"), { code: "EIO" });
      }
    });
    const receipt = receiptFor({ changeSetSeed: 11, recordedAt: 7_000 });

    const unhandled = await withoutUnhandledRejections(async () => {
      const stored = await receipts.put({
        canonicalRootKey: ROOT_KEY,
        receipt,
        awaitIndex: false
      });
      assert.equal(stored.stored, "created", "publication does not wait for indexing");
      assert.ok(await stat(stored.path));
      // The caller has already been answered; only now does housekeeping fail.
      releaseIndex.resolve();
      await stored.indexing;
    });
    assert.deepEqual(unhandled, [], "detached housekeeping must never reject into the process");

    // The receipt is untouched by the failure, and still discoverable.
    const found = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts.map((entry) => entry.reviewId), [receipt.reviewId]);
  });
});

test("an ignored indexing promise is inert even when nothing ever awaits it", async () => {
  await withState(async (stateRoot) => {
    const receipts = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: async () => {
        throw Object.assign(new Error("index exploded"), { code: "EIO" });
      }
    });
    const unhandled = await withoutUnhandledRejections(async () => {
      // Deliberately drop `indexing` on the floor, the way the binder does.
      const stored = await receipts.put({
        canonicalRootKey: ROOT_KEY,
        receipt: receiptFor({ changeSetSeed: 12, recordedAt: 7_100 }),
        awaitIndex: false
      });
      assert.equal(stored.stored, "created");
    });
    assert.deepEqual(unhandled, []);
  });
});

test("the receipt store never touches write custody", async () => {
  // Housekeeping runs detached and unsupervised, so the module that performs it
  // must have no way to acquire, change, or release custody at all.
  const source = await readFile(
    path.join(import.meta.dirname, "..", "src", "review", "receipt-store.mjs"),
    "utf8"
  );
  for (const forbidden of [
    "reserveWriteAccess",
    "activateWriteAccess",
    "beginTermination",
    "markSpawning",
    "markOrphanedWriteAccess",
    "releaseWriteAccess",
    "releaseUnstartedWriteAccess",
    "custodyManager",
    "DurableWriteCustodyManager"
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      "receipt-store must not reference " + forbidden
    );
  }
});

test("a stalled scope index neither blocks publication nor unmakes the receipt", async () => {
  await withState(async (stateRoot) => {
    const indexReached = deferred();
    const receipts = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: async () => {
        indexReached.resolve();
        await new Promise(() => {});
      }
    });
    const receipt = receiptFor({ changeSetSeed: 13, recordedAt: 7_200 });
    const stored = await receipts.put({
      canonicalRootKey: ROOT_KEY,
      receipt,
      awaitIndex: false
    });

    await indexReached.promise;
    assert.equal(stored.stored, "created");
    assert.equal(
      await Promise.race([stored.indexing.then(() => "settled"), Promise.resolve("pending")]),
      "pending",
      "housekeeping is still stalled"
    );

    // Durable, valid and discoverable while the index is permanently stuck.
    assert.equal(
      validateReviewReceipt(JSON.parse(await readFile(stored.path, "utf8"))).reviewId,
      receipt.reviewId
    );
    const found = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET
    });
    assert.deepEqual(found.receipts.map((entry) => entry.reviewId), [receipt.reviewId]);
    assert.equal(found.status, "complete", "the authoritative sweep proves the recovered history");
  });
});

test("a merged history never exceeds the bound or drops a receipt silently", async () => {
  await withState(async (stateRoot) => {
    // One indexed receipt plus two that only exist authoritatively, asked for
    // under a bound of two. The merge must respect the bound and must say that
    // it stopped early rather than returning a short list as if it were whole.
    const indexed = receiptFor({ changeSetSeed: 1, recordedAt: 9_000 });
    await store(stateRoot).put({ canonicalRootKey: ROOT_KEY, receipt: indexed });

    const unindexed = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: () => {
        throw Object.assign(new Error("no index"), { code: "EACCES" });
      }
    });
    for (const seed of [2, 3]) {
      await unindexed.put({
        canonicalRootKey: ROOT_KEY,
        receipt: receiptFor({ changeSetSeed: seed, recordedAt: 8_000 + seed })
      });
    }

    const found = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET,
      limit: 2
    });

    assert.equal(found.receipts.length, 2, "the caller's bound is respected");
    assert.equal(
      new Set(found.receipts.map((entry) => entry.reviewId)).size,
      2,
      "no receipt appears twice across the index and the sweep"
    );
    assert.equal(found.status, "partial");
    assert.equal(found.truncated, true, "stopping early is reported, not rounded down");
    assert.ok(found.skipped.some((entry) => entry.code === "review_history_recovery_truncated"));
    assert.equal(
      found.receipts[0].reviewId,
      indexed.reviewId,
      "the newest receipt still leads, whichever tree it came from"
    );
  });
});

test("a full non-evidentiary index cannot hide a newer authoritative receipt behind the output bound", async () => {
  await withState(async (stateRoot) => {
    const indexed = store(stateRoot);
    for (let seed = 1; seed <= 16; seed += 1) {
      await indexed.put({
        canonicalRootKey: ROOT_KEY,
        receipt: receiptFor({ changeSetSeed: seed, recordedAt: 10_000 + seed })
      });
    }

    const newer = receiptFor({ changeSetSeed: 17, recordedAt: 99_999 });
    const unindexed = new ReviewReceiptStore({
      stateRoot,
      beforeScopeIndex: () => {
        throw Object.assign(new Error("index intentionally missing"), { code: "EIO" });
      }
    });
    await unindexed.put({ canonicalRootKey: ROOT_KEY, receipt: newer });

    const found = await store(stateRoot).discoverForScope({
      canonicalRootKey: ROOT_KEY,
      agentType: "code-review",
      targetSpec: TARGET,
      limit: 16
    });
    assert.equal(found.status, "partial", "a capped output cannot imply exhaustive history");
    assert.equal(found.totalCount, 17);
    assert.equal(found.receipts.length, 16);
    assert.equal(found.allReceipts.length, 17);
    assert.equal(found.authoritativeExhaustive, true);
    assert.equal(found.outputTruncated, true);
    assert.equal(found.receipts[0].reviewId, newer.reviewId, "authoritative newest receipt is visible");
    assert.ok(found.allReceipts.some((receipt) => receipt.reviewId === newer.reviewId));
    assert.ok(found.skipped.some((entry) => entry.code === "review_history_truncated"));
  });
});
