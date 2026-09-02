import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { collectChangeSet } from "../src/changeset/collector.mjs";
import { NO_REVIEW_TARGET } from "../src/changeset/target.mjs";
import { evaluateFreshness } from "../src/review/freshness.mjs";
import { buildReviewReceipt } from "../src/review/receipt-schema.mjs";
import { ReviewReceiptStore } from "../src/review/receipt-store.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaudeSource = path.join(repoRoot, "tests", "fixtures", "FakeClaude.cs");
const fakeClaudeExe = path.join(repoRoot, "tests", "fixtures", "fake-claude.exe");
const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

const REAL_CISCO_MCP_DIR = "C:\\Users\\Andres\\Desktop\\Universidad\\Uce\\Cuarto\\Infra\\Cisco-MCP";
const REAL_RUNTIME_RIPV2_DIR = path.join(REAL_CISCO_MCP_DIR, ".claude", "worktrees", "runtime-ripv2");
const KNOWN_REVISION = "2b8327e48b5166bfef862463e0ca508e37232bc7";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  assert.equal(result.status, 0, "git " + args.join(" ") + " failed: " + (result.stderr || result.stdout));
  return result.stdout.trim();
}

function ensureFakeClaude() {
  if (!existsSync(fakeClaudeExe)) {
    const res = spawnSync(cscPath, ["/nologo", "/out:" + fakeClaudeExe, fakeClaudeSource], {
      windowsHide: true,
      shell: false
    });
    assert.equal(res.status, 0, "Failed to compile FakeClaude.cs: " + (res.stderr || res.stdout));
  }
}

function captureGitSnapshot(cwd) {
  return {
    head: git(cwd, ["rev-parse", "HEAD"]),
    indexTree: git(cwd, ["write-tree"]),
    porcelain: git(cwd, ["status", "--porcelain=v1"])
  };
}

async function withDisposableCiscoRepo(callback) {
  const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "cisco-mcp-disposable-")));
  const repoCopy = path.join(fixtureRoot, "repo");

  // Snapshot the real repositories before any operations to ensure they remain untouched
  const realCiscoSnapshotBefore = captureGitSnapshot(REAL_CISCO_MCP_DIR);
  let realRuntimeRipv2SnapshotBefore = null;
  if (existsSync(REAL_RUNTIME_RIPV2_DIR)) {
    realRuntimeRipv2SnapshotBefore = captureGitSnapshot(REAL_RUNTIME_RIPV2_DIR);
  }

  try {
    // Clone locally into the disposable fixture with core.autocrlf=false
    git(fixtureRoot, ["-c", "core.autocrlf=false", "clone", REAL_CISCO_MCP_DIR, repoCopy]);
    git(repoCopy, ["config", "core.autocrlf", "false"]);
    git(repoCopy, ["checkout", KNOWN_REVISION]);
    git(repoCopy, ["config", "user.name", "Deterministic Verification"]);
    git(repoCopy, ["config", "user.email", "verify@example.invalid"]);
    git(repoCopy, ["config", "commit.gpgsign", "false"]);

    const scenarioFile = path.join(fixtureRoot, "fake-claude-scenario.json");
    const env = {
      ...process.env,
      TEMP: fixtureRoot,
      TMP: fixtureRoot,
      CLAUDE_AGENTS_CLAUDE_BIN: fakeClaudeExe
    };

    await callback({ fixtureRoot, repoCopy, scenarioFile, env });
  } finally {
    // Verify real repositories are completely untouched
    const realCiscoSnapshotAfter = captureGitSnapshot(REAL_CISCO_MCP_DIR);
    assert.deepEqual(
      realCiscoSnapshotAfter,
      realCiscoSnapshotBefore,
      "CRITICAL INVARIANT VIOLATION: Real Cisco-MCP was modified!"
    );

    if (realRuntimeRipv2SnapshotBefore && existsSync(REAL_RUNTIME_RIPV2_DIR)) {
      const realRuntimeRipv2SnapshotAfter = captureGitSnapshot(REAL_RUNTIME_RIPV2_DIR);
      assert.deepEqual(
        realRuntimeRipv2SnapshotAfter,
        realRuntimeRipv2SnapshotBefore,
        "CRITICAL INVARIANT VIOLATION: Real runtime-ripv2 worktree was modified!"
      );
    }

    // Clean up disposable clone
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("source-worktree safety & Cisco-MCP compatibility: writer delegations isolate changes in detached worktree without touching source repo", async () => {
  ensureFakeClaude();
  await withDisposableCiscoRepo(async ({ repoCopy, scenarioFile, env }) => {
    const beforeSnapshot = captureGitSnapshot(repoCopy);

    // Instruct fake specialist to modify a file
    await writeFile(
      scenarioFile,
      JSON.stringify({
        scenario: "success",
        modifyFileName: "writer-modification.txt",
        modifyFileContent: "deterministic write from general-purpose specialist\n"
      }),
      "utf8"
    );

    // Execute writer specialist
    const outcome = await delegateAgent({
      agentType: "general-purpose",
      task: "Perform controlled modification on Cisco-MCP",
      cwd: repoCopy
    }, { env });

    if (outcome.status !== "completed") {
      console.log("TEST 1 FAILURE DETAILS:", {
        status: outcome.status,
        error: outcome.error,
        custodyReasons: outcome.custodyReasons,
        terminationDiagnostics: outcome.terminationDiagnostics
      });
    }

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.accessMode, "write");
    assert.ok(outcome.worktreeRoot, "Writer must receive an isolated worktree root");
    assert.notEqual(outcome.worktreeRoot, repoCopy, "Writer worktree must differ from source repository root");
    assert.ok(outcome.worktreeRoot.includes("worktrees"), "Worktree must be in an isolated worktrees directory");

    // Invariant: file was modified inside the worktree
    const worktreeModFile = path.join(outcome.worktreeRoot, "writer-modification.txt");
    assert.ok(existsSync(worktreeModFile), "Modified file must exist inside writer worktree");
    const modContent = await readFile(worktreeModFile, "utf8");
    assert.match(modContent, /deterministic write from general-purpose specialist/);

    // Invariant: file was NOT created in the source repository root
    const sourceModFile = path.join(repoCopy, "writer-modification.txt");
    assert.ok(!existsSync(sourceModFile), "Writer file must NOT exist in source repository");

    // Invariant: source HEAD, index, and untracked files are 100% UNCHANGED
    const afterSnapshot = captureGitSnapshot(repoCopy);
    assert.equal(afterSnapshot.head, beforeSnapshot.head, "Source HEAD must be identical");
    assert.equal(afterSnapshot.indexTree, beforeSnapshot.indexTree, "Source git index must be identical");
    assert.equal(afterSnapshot.porcelain, beforeSnapshot.porcelain, "Source git working tree status must be identical");

    // Invariant: no automatic commit, merge, rebase, or push occurred in worktree
    const worktreeHead = git(outcome.worktreeRoot, ["rev-parse", "HEAD"]);
    assert.equal(worktreeHead, beforeSnapshot.head, "No commit occurred; worktree HEAD must equal base HEAD");

    const worktreeStatus = git(outcome.worktreeRoot, ["status", "--porcelain=v1"]);
    assert.ok(worktreeStatus.includes("writer-modification.txt"), "Modification remains uncommitted");

    await rm(scenarioFile, { force: true });
  });
});

test("ChangeSet and review integrity: Cisco-MCP collections, mutations, restoration, and ReviewReceipt binding", async () => {
  ensureFakeClaude();
  await withDisposableCiscoRepo(async ({ repoCopy, scenarioFile, env }) => {
    const workspace = await resolveCanonicalWorkspaceRoot(repoCopy);
    const collectorDeps = { readOwnership: async () => null };

    // 1. Initial collection on clean repository
    const cs1 = await collectChangeSet({
      effectiveCwd: workspace.effectiveCwd,
      rootSource: workspace.rootSource,
      canonicalRepositoryKey: workspace.canonicalRepositoryKey,
      targetSpec: NO_REVIEW_TARGET
    }, collectorDeps);

    assert.ok(cs1.changeSetId.startsWith("cs1:"));
    assert.equal(cs1.status, "exact");

    // 2. Exact reproducibility
    const cs1Reproduced = await collectChangeSet({
      effectiveCwd: workspace.effectiveCwd,
      rootSource: workspace.rootSource,
      canonicalRepositoryKey: workspace.canonicalRepositoryKey,
      targetSpec: NO_REVIEW_TARGET
    }, collectorDeps);
    assert.equal(cs1Reproduced.changeSetId, cs1.changeSetId, "Clean collection must be bit-for-bit reproducible");

    // 3. Delegate code-review to bind an authoritative ReviewReceipt on the clean state
    const reviewOutcome1 = await delegateAgent({
      agentType: "code-review",
      task: "Review clean Cisco-MCP codebase",
      cwd: repoCopy
    }, { env });

    assert.equal(reviewOutcome1.status, "completed");
    assert.equal(reviewOutcome1.reviewBinding.status, "bound");
    assert.ok(reviewOutcome1.reviewBinding.reviewId);
    assert.equal(reviewOutcome1.reviewBinding.changeSetId, cs1.changeSetId);

    // 4. Mutate a tracked file in Cisco-MCP (e.g. README.md)
    const readmePath = path.join(repoCopy, "README.md");
    const originalBytes = await readFile(readmePath);
    await writeFile(readmePath, Buffer.concat([originalBytes, Buffer.from("\n<!-- operational verification mutation -->\n")]));

    // 5. Collect after mutation: identity must change
    const cs2 = await collectChangeSet({
      effectiveCwd: workspace.effectiveCwd,
      rootSource: workspace.rootSource,
      canonicalRepositoryKey: workspace.canonicalRepositoryKey,
      targetSpec: NO_REVIEW_TARGET
    }, collectorDeps);

    assert.notEqual(cs2.changeSetId, cs1.changeSetId, "Mutation must produce distinct changeSetId");
    assert.ok(cs2.descriptor.worktree.length > 0, "Mutated file must appear in worktree entries");
    assert.equal(cs1.descriptor.worktree.length, 0, "Clean repository has 0 worktree entries");

    // 6. Delegate second code-review: prior review must be reported as STALE
    const reviewOutcome2 = await delegateAgent({
      agentType: "code-review",
      task: "Review mutated Cisco-MCP codebase",
      cwd: repoCopy
    }, { env });

    assert.equal(reviewOutcome2.status, "completed");
    assert.equal(reviewOutcome2.reviewBinding.status, "bound");
    assert.ok(reviewOutcome2.reviewBinding.receiptHistory.receipts.length > 0);
    const priorInReview2 = reviewOutcome2.reviewBinding.receiptHistory.receipts.find(
      (r) => r.reviewId === reviewOutcome1.reviewBinding.reviewId
    );
    assert.ok(priorInReview2, "Prior review must be discovered in history");
    assert.equal(priorInReview2.verdict, "STALE");
    assert.ok(priorInReview2.changedSections.includes("worktree"));

    // 7. Restore the file bytes exactly
    await writeFile(readmePath, originalBytes);

    // 8. Collect after restoration: exact identity restored
    const cs3 = await collectChangeSet({
      effectiveCwd: workspace.effectiveCwd,
      rootSource: workspace.rootSource,
      canonicalRepositoryKey: workspace.canonicalRepositoryKey,
      targetSpec: NO_REVIEW_TARGET
    }, collectorDeps);

    assert.equal(cs3.changeSetId, cs1.changeSetId, "Byte restoration must restore identical changeSetId");

    // 9. Delegate third code-review: restored state reports the first review as FRESH again
    const reviewOutcome3 = await delegateAgent({
      agentType: "code-review",
      task: "Review restored Cisco-MCP codebase",
      cwd: repoCopy
    }, { env });

    assert.equal(reviewOutcome3.status, "completed");
    const priorInReview3 = reviewOutcome3.reviewBinding.receiptHistory.receipts.find(
      (r) => r.reviewId === reviewOutcome1.reviewBinding.reviewId
    );
    assert.ok(priorInReview3, "Initial review must be discovered in history");
    assert.equal(priorInReview3.verdict, "FRESH");
  });
});

test("Cisco-MCP complexity: repository discovery and subfolder navigation resolve single coordination identity", async () => {
  await withDisposableCiscoRepo(async ({ repoCopy }) => {
    // Top level
    const topLevel = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(repoCopy)
    );

    // Nested subdirectory in Cisco-MCP (src/ or application/)
    const subDir = path.join(repoCopy, "src");
    const subLevel = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(subDir)
    );

    assert.equal(
      subLevel.canonicalRepositoryKey,
      topLevel.canonicalRepositoryKey,
      "Subdirectory must resolve to identical canonical repository coordination key"
    );
    assert.equal(
      subLevel.repositoryRoot,
      topLevel.repositoryRoot,
      "Subdirectory must identify the same repository root"
    );
  });
});
