import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function gitMayFail(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
}

async function withRepository(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-integration-identity-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const stateRoot = path.join(fixtureRoot, "state");
  try {
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "core.autocrlf", "false"]);
    git(repositoryRoot, ["config", "user.name", "Integration Identity Test"]);
    git(repositoryRoot, ["config", "user.email", "integration@example.invalid"]);
    git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repositoryRoot, "subject.txt"), "base\n", "utf8");
    git(repositoryRoot, ["add", "subject.txt"]);
    git(repositoryRoot, ["commit", "-m", "base"]);
    await callback({ repositoryRoot, writeCustody: new DurableWriteCustodyManager({ stateRoot }) });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

let nextPid = 81_000;

function reviewRunner() {
  return async ({ executionId, agentType, repositoryRoot, onChildStarted }) => {
    const pid = nextPid++;
    const processIdentity = {
      executionId,
      agentType,
      repositoryRoot,
      pid,
      child: { pid },
      startedAt: Date.now(),
      startTime: String(pid * 100),
      source: "integration-identity"
    };
    await onChildStarted?.(processIdentity);
    return {
      result: "reviewed exact commit",
      durationMs: 1,
      processStarted: true,
      processIdentity,
      terminalProof: { processIdentity, event: "close", observedAt: Date.now() }
    };
  };
}

async function review(repositoryRoot, writeCustody) {
  return await delegateAgent(
    { agentType: "code-review", task: "bind this exact integration subject", cwd: repositoryRoot },
    { writeCustody, runAgent: reviewRunner(), env: {} }
  );
}

async function reconcile(repositoryRoot, writeCustody) {
  return await delegateAgent(
    { agentType: "code-review", task: "check review identity", reconcileOnly: true, cwd: repositoryRoot },
    {
      writeCustody,
      env: {},
      runAgent: async () => {
        throw new Error("reconciliation must not run a reviewer");
      }
    }
  );
}

test("ff-only integration preserves the reviewed SHA and its FRESH receipt", async () => {
  await withRepository(async ({ repositoryRoot, writeCustody }) => {
    git(repositoryRoot, ["checkout", "-b", "reviewed"]);
    await writeFile(path.join(repositoryRoot, "feature.txt"), "reviewed change\n", "utf8");
    git(repositoryRoot, ["add", "feature.txt"]);
    git(repositoryRoot, ["commit", "-m", "reviewed change"]);
    const reviewedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const reviewed = await review(repositoryRoot, writeCustody);
    assert.equal(reviewed.reviewBinding.status, "bound");

    git(repositoryRoot, ["checkout", "main"]);
    git(repositoryRoot, ["merge", "--ff-only", reviewedCommit]);
    assert.equal(git(repositoryRoot, ["rev-parse", "HEAD"]), reviewedCommit);
    git(repositoryRoot, ["update-index", "--really-refresh"]);
    assert.equal(git(repositoryRoot, ["status", "--porcelain=v2"]), "");

    const fresh = await reconcile(repositoryRoot, writeCustody);
    assert.equal(fresh.reviewBinding.status, "bound");
    assert.equal(fresh.reviewBinding.reviewId, reviewed.reviewBinding.reviewId);
    assert.equal(fresh.reviewBinding.receiptHistory.receipts[0].verdict, "FRESH");
  });
});

test("cherry-pick creates a new HEAD and an old receipt cannot authorize it", async () => {
  await withRepository(async ({ repositoryRoot, writeCustody }) => {
    git(repositoryRoot, ["checkout", "-b", "reviewed"]);
    await writeFile(path.join(repositoryRoot, "feature.txt"), "reviewed change\n", "utf8");
    git(repositoryRoot, ["add", "feature.txt"]);
    git(repositoryRoot, ["commit", "-m", "reviewed change"]);
    const reviewedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const reviewed = await review(repositoryRoot, writeCustody);

    git(repositoryRoot, ["checkout", "main"]);
    await writeFile(path.join(repositoryRoot, "target.txt"), "target divergence\n", "utf8");
    git(repositoryRoot, ["add", "target.txt"]);
    git(repositoryRoot, ["commit", "-m", "target divergence"]);
    git(repositoryRoot, ["cherry-pick", reviewedCommit]);
    const integratedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    assert.notEqual(integratedCommit, reviewedCommit, "cherry-pick must not be described as exact identity preservation");

    const stale = await reconcile(repositoryRoot, writeCustody);
    assert.equal(stale.reviewBinding.status, "unavailable");
    const prior = stale.reviewBinding.receiptHistory.receipts.find(
      (entry) => entry.reviewId === reviewed.reviewBinding.reviewId
    );
    assert.equal(prior?.verdict, "STALE");
    assert.match(stale.result, /fresh code-review delegation is required/u);
  });
});

test("a resolved integration conflict is a new review subject and cannot inherit FRESH authorization", async () => {
  await withRepository(async ({ repositoryRoot, writeCustody }) => {
    git(repositoryRoot, ["checkout", "-b", "reviewed"]);
    await writeFile(path.join(repositoryRoot, "subject.txt"), "reviewed side\n", "utf8");
    git(repositoryRoot, ["commit", "-am", "reviewed conflicting change"]);
    const reviewedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const reviewed = await review(repositoryRoot, writeCustody);

    git(repositoryRoot, ["checkout", "main"]);
    await writeFile(path.join(repositoryRoot, "subject.txt"), "target side\n", "utf8");
    git(repositoryRoot, ["commit", "-am", "target conflicting change"]);
    const conflict = gitMayFail(repositoryRoot, ["cherry-pick", reviewedCommit]);
    assert.notEqual(conflict.status, 0, "fixture must exercise an actual conflict");
    await writeFile(path.join(repositoryRoot, "subject.txt"), "resolved integration\n", "utf8");
    git(repositoryRoot, ["add", "subject.txt"]);
    git(repositoryRoot, ["commit", "-m", "resolve reviewed conflict"]);
    const resolvedCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    assert.notEqual(resolvedCommit, reviewedCommit);

    const stale = await reconcile(repositoryRoot, writeCustody);
    assert.equal(stale.reviewBinding.status, "unavailable");
    const prior = stale.reviewBinding.receiptHistory.receipts.find(
      (entry) => entry.reviewId === reviewed.reviewBinding.reviewId
    );
    assert.equal(prior?.verdict, "STALE");
  });
});
