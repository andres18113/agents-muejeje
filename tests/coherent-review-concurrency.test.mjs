import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentProfile } from "../src/agent-registry.mjs";
import { resolveCapabilityPolicy } from "../src/capability-policy.mjs";
import { SECTION_NAMES, changeSetIdFromSectionDigests } from "../src/changeset/descriptor.mjs";
import { NO_REVIEW_TARGET } from "../src/changeset/target.mjs";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { createCoherentAdmission } from "../src/review/coherent-admission.mjs";
import { reviewerBasis } from "../src/review/receipt-basis.mjs";
import { buildReviewReceipt, validateReviewReceipt } from "../src/review/receipt-schema.mjs";
import { ReviewReceiptStore } from "../src/review/receipt-store.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import {
  CUSTODY_KINDS,
  DurableWriteCustodyManager,
  WriteCustodyError,
  custodyKindOf,
  repositoryIdForCanonicalRootKey
} from "../src/write-custody.mjs";

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const holderFixture = path.join(fixtureDirectory, "coherent-review-holder.mjs");
const IDENTITY_SOURCE = "phase6-fixture-identity";
let childPid = 40_000;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + (result.stderr || result.stdout));
  return result.stdout.trim();
}

async function withRepository(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-review-race-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const stateRoot = path.join(fixtureRoot, "state");
  try {
    await mkdir(repositoryRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "user.email", "tests@example.invalid"]);
    git(repositoryRoot, ["config", "user.name", "Phase Six Tests"]);
    git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "base\n", "utf8");
    git(repositoryRoot, ["add", "tracked.txt"]);
    git(repositoryRoot, ["commit", "-m", "fixture base"]);
    const workspace = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(repositoryRoot)
    );
    await callback({ fixtureRoot, repositoryRoot, stateRoot, workspace });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function deterministicIdentity(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return Object.freeze({ status: "dead" });
    return Object.freeze({ status: "ambiguous", reason: "fixture-probe-failed" });
  }
  return Object.freeze({
    status: "alive",
    identity: Object.freeze({ pid, startTime: String(pid * 100), source: IDENTITY_SOURCE })
  });
}

function custodyFor(stateRoot, options = {}) {
  return new DurableWriteCustodyManager({
    stateRoot,
    inspectProcess: options.inspectProcess || deterministicIdentity,
    ...(options.currentPid === undefined ? {} : { currentPid: options.currentPid }),
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {})
  });
}

function startHolder({ stateRoot, workspace, executionId, custodyKind = "write" }) {
  const child = spawn(process.execPath, [
    holderFixture,
    stateRoot,
    workspace.repositoryRoot,
    workspace.canonicalRepositoryKey,
    executionId,
    custodyKind
  ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  const stdout = [];
  const stderr = [];
  let resolveAcquired;
  let resolveClosed;
  const acquired = new Promise((resolve) => { resolveAcquired = resolve; });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  child.stdout.on("data", (chunk) => {
    stdout.push(Buffer.from(chunk));
    if (Buffer.concat(stdout).toString("utf8").includes("ACQUIRED")) resolveAcquired(true);
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.once("close", (code) => {
    resolveAcquired(false);
    resolveClosed({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    });
  });

  return {
    acquired,
    closed,
    release() {
      try {
        child.stdin.write("RELEASE\n");
        child.stdin.end();
      } catch {
        // A losing contender has already exited; closed is still awaited.
      }
    }
  };
}

function processIdentity({ executionId, agentType = "code-review", repositoryRoot, pid = ++childPid }) {
  const child = new EventEmitter();
  child.pid = pid;
  return Object.freeze({
    executionId,
    agentType,
    repositoryRoot,
    pid,
    startTime: String(pid * 100),
    source: IDENTITY_SOURCE,
    child,
    startedAt: Date.now()
  });
}

function terminalProof(identity) {
  return Object.freeze({
    processIdentity: identity,
    event: "close",
    code: 0,
    signal: null,
    observedAt: Date.now()
  });
}

function completedRunner({ entered, resume } = {}) {
  return async (argumentsForRunner) => {
    const identity = processIdentity({
      executionId: argumentsForRunner.executionId,
      agentType: argumentsForRunner.agentType,
      repositoryRoot: argumentsForRunner.repositoryRoot
    });
    await argumentsForRunner.onChildStarted?.(identity);
    entered?.resolve();
    if (resume) await resume.promise;
    return {
      result: "no findings",
      stderrSummary: "",
      durationMs: 5,
      processStarted: Boolean(argumentsForRunner.onChildStarted),
      ...(argumentsForRunner.onChildStarted
        ? { processIdentity: identity, terminalProof: terminalProof(identity) }
        : {})
    };
  };
}

function mapInspector(observations) {
  return async (pid) => observations.get(pid) || Object.freeze({
    status: "ambiguous",
    reason: "test-identity-unknown"
  });
}

function alive(pid) {
  return Object.freeze({
    status: "alive",
    identity: Object.freeze({ pid, startTime: String(pid * 100), source: IDENTITY_SOURCE })
  });
}

function dead() {
  return Object.freeze({ status: "dead" });
}

function ambiguous() {
  return Object.freeze({ status: "ambiguous", reason: "test-ambiguous" });
}

async function activateReview(custody, workspace, {
  executionId = "review-crash",
  pid = 200
} = {}) {
  await custody.reserveWriteAccess({
    executionId,
    agentType: "code-review",
    canonicalRoot: workspace.repositoryRoot,
    canonicalRootKey: workspace.canonicalRepositoryKey,
    custodyKind: CUSTODY_KINDS.COHERENT_REVIEW
  });
  await custody.markSpawning({ executionId, canonicalRootKey: workspace.canonicalRepositoryKey });
  const identity = processIdentity({ executionId, repositoryRoot: workspace.repositoryRoot, pid });
  await custody.activateWriteAccess({
    executionId,
    canonicalRootKey: workspace.canonicalRepositoryKey,
    processIdentity: identity
  });
  return identity;
}

test("a real writer is excluded throughout a real review and succeeds after release", {
  skip: process.platform !== "win32"
}, async () => {
  await withRepository(async ({ repositoryRoot, stateRoot, workspace }) => {
    const entered = deferred();
    const resume = deferred();
    const review = delegateAgent(
      { agentType: "code-review", task: "review the change set", cwd: repositoryRoot },
      {
        writeCustody: custodyFor(stateRoot),
        runAgent: completedRunner({ entered, resume }),
        env: {}
      }
    );
    await entered.promise;

    const blocked = startHolder({ stateRoot, workspace, executionId: "writer-blocked" });
    assert.equal(await blocked.acquired, false);
    const blockedResult = await blocked.closed;
    assert.equal(blockedResult.code, 2);
    assert.match(blockedResult.stderr, /write_custody_conflict/u);
    assert.doesNotMatch(blockedResult.stderr, /ambiguous/u);

    resume.resolve();
    const outcome = await review;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reviewBinding.status, "bound");

    const admitted = startHolder({ stateRoot, workspace, executionId: "writer-after" });
    assert.equal(await admitted.acquired, true);
    admitted.release();
    assert.equal((await admitted.closed).code, 0);
  });
});

test("a real writer denies coherent admission but the review stays advisory", {
  skip: process.platform !== "win32"
}, async () => {
  await withRepository(async ({ repositoryRoot, stateRoot, workspace }) => {
    const writer = startHolder({ stateRoot, workspace, executionId: "writer-held" });
    assert.equal(await writer.acquired, true);
    try {
      const outcome = await delegateAgent(
        { agentType: "code-review", task: "review", cwd: repositoryRoot },
        { writeCustody: custodyFor(stateRoot), runAgent: completedRunner(), env: {} }
      );
      assert.equal(outcome.status, "completed");
      assert.equal(outcome.reviewBinding.status, "unavailable");
      assert.equal(outcome.reviewBinding.coherence, "denied");
      assert.ok(outcome.reviewBinding.reasons.some((reason) =>
        reason.code === "coherent_admission_denied"));
    } finally {
      writer.release();
      assert.equal((await writer.closed).code, 0);
    }
  });
});

test("a writer loses while coherent-review activation is parked before publication", {
  skip: process.platform !== "win32"
}, async () => {
  await withRepository(async ({ stateRoot, workspace }) => {
    const reached = deferred();
    const resume = deferred();
    const custody = custodyFor(stateRoot, {
      beforePublish: async ({ nextRecord }) => {
        if (nextRecord.state === "ACTIVE" && custodyKindOf(nextRecord) === CUSTODY_KINDS.COHERENT_REVIEW) {
          reached.resolve();
          await resume.promise;
        }
      }
    });
    const admission = createCoherentAdmission({ writeCustody: custody });
    const executionId = "review-publication-race";
    const admitted = await admission.admit({
      executionId,
      agentType: "code-review",
      canonicalRoot: workspace.repositoryRoot,
      canonicalRootKey: workspace.canonicalRepositoryKey
    });
    assert.equal(admitted.coherence, "held");
    await custody.markSpawning({ executionId, canonicalRootKey: workspace.canonicalRepositoryKey });
    const identity = processIdentity({ executionId, repositoryRoot: workspace.repositoryRoot });
    const activation = custody.activateWriteAccess({
      executionId,
      canonicalRootKey: workspace.canonicalRepositoryKey,
      processIdentity: identity
    });
    await reached.promise;

    const writer = startHolder({ stateRoot, workspace, executionId: "writer-at-publication" });
    assert.equal(await writer.acquired, false);
    assert.match((await writer.closed).stderr, /write_custody_conflict/u);

    resume.resolve();
    const active = await activation;
    assert.equal(active.state, "ACTIVE");
    assert.equal(custodyKindOf(active), CUSTODY_KINDS.COHERENT_REVIEW);
    await custody.releaseWriteAccessAfterTerminal({
      executionId,
      canonicalRootKey: workspace.canonicalRepositoryKey,
      terminalProof: terminalProof(identity)
    });
  });
});

test("a crash mid-review reconciles normally and leaves no receipt", async () => {
  await withRepository(async ({ stateRoot, workspace }) => {
    const observations = new Map([[100, alive(100)], [200, alive(200)]]);
    const first = custodyFor(stateRoot, {
      currentPid: 100,
      inspectProcess: mapInspector(observations)
    });
    await activateReview(first, workspace);

    observations.set(100, dead());
    observations.set(200, dead());
    observations.set(300, alive(300));
    const recovered = custodyFor(stateRoot, {
      currentPid: 300,
      inspectProcess: mapInspector(observations)
    });
    const reconciliation = await recovered.reconcileExistingOwnership(
      workspace.canonicalRepositoryKey
    );
    assert.equal(reconciliation.released, true);
    assert.equal(await recovered.getWriteAccess(workspace.canonicalRepositoryKey), undefined);

    const discovered = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: workspace.canonicalRepositoryKey,
      agentType: "code-review",
      targetSpec: NO_REVIEW_TARGET
    });
    assert.deepEqual(discovered.receipts, []);
  });
});

function crashReceipt(workspace) {
  const profile = getAgentProfile("code-review");
  const reviewer = reviewerBasis({
    agentType: profile.id,
    contract: "review contract\n",
    capabilityPolicy: resolveCapabilityPolicy(profile),
    runtime: {
      model: "opus",
      modelSource: "default",
      modelStrategy: profile.modelStrategy,
      reasoningEffort: profile.reasoningEffort
    }
  });
  const digest = "a".repeat(64);
  const sections = Object.fromEntries(SECTION_NAMES.map((name) => [name, digest]));
  return buildReviewReceipt({
    binding: {
      changeSetId: changeSetIdFromSectionDigests({ objectFormat: "sha1", sections }),
      objectFormat: "sha1",
      sections,
      target: { spec: NO_REVIEW_TARGET, resolution: "none", commit: null },
      beforeSummary: {
        headCommit: "1".repeat(40),
        branch: "main",
        detached: false,
        mergeBase: null,
        counts: { index: 0, worktree: 0, unmerged: 0, untracked: 0, submodules: 0 }
      },
      afterSummary: {
        headCommit: "1".repeat(40),
        branch: "main",
        detached: false,
        mergeBase: null,
        counts: { index: 0, worktree: 0, unmerged: 0, untracked: 0, submodules: 0 }
      }
    },
    coherence: {
      admission: "coherent-review-custody",
      custodyExecutionId: "review-after-receipt",
      beforeAt: 1_000,
      afterAt: 2_000
    },
    reviewer,
    assignment: { sha256: digest, chars: 6 },
    execution: {
      executionId: "review-after-receipt",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 1_000
    },
    result: { sha256: digest, bytes: 10 },
    provenance: {
      repositoryId: repositoryIdForCanonicalRootKey(workspace.canonicalRepositoryKey),
      producer: "claude-agents-mcp/0.2.1",
      collector: "change-set-collector/v1",
      recordedAt: 3_000
    }
  });
}

test("a crash after receipt persistence preserves valid discoverable evidence", async () => {
  await withRepository(async ({ stateRoot, workspace }) => {
    const observations = new Map([[100, alive(100)], [200, alive(200)]]);
    const first = custodyFor(stateRoot, {
      currentPid: 100,
      inspectProcess: mapInspector(observations)
    });
    await activateReview(first, workspace, { executionId: "review-after-receipt" });

    const receipt = crashReceipt(workspace);
    assert.ok(validateReviewReceipt(receipt));
    await new ReviewReceiptStore({ stateRoot }).put({
      canonicalRootKey: workspace.canonicalRepositoryKey,
      receipt
    });

    observations.set(100, dead());
    observations.set(200, dead());
    observations.set(300, alive(300));
    const recovered = custodyFor(stateRoot, {
      currentPid: 300,
      inspectProcess: mapInspector(observations)
    });
    assert.equal((await recovered.reconcileExistingOwnership(
      workspace.canonicalRepositoryKey
    )).released, true);

    const discovered = await new ReviewReceiptStore({ stateRoot }).discoverForScope({
      canonicalRootKey: workspace.canonicalRepositoryKey,
      agentType: "code-review",
      targetSpec: NO_REVIEW_TARGET
    });
    assert.equal(discovered.receipts.length, 1);
    assert.equal(discovered.receipts[0].reviewId, receipt.reviewId);
    assert.ok(validateReviewReceipt(discovered.receipts[0]));
  });
});

test("ambiguous coordinator identity retains review custody and blocks a writer", async () => {
  await withRepository(async ({ stateRoot, workspace }) => {
    const observations = new Map([[100, alive(100)], [200, alive(200)]]);
    const first = custodyFor(stateRoot, {
      currentPid: 100,
      inspectProcess: mapInspector(observations)
    });
    await activateReview(first, workspace);

    observations.set(100, ambiguous());
    observations.set(300, alive(300));
    const contender = custodyFor(stateRoot, {
      currentPid: 300,
      inspectProcess: mapInspector(observations)
    });
    await assert.rejects(
      contender.reserveWriteAccess({
        executionId: "writer-after-ambiguity",
        agentType: "general-purpose",
        canonicalRoot: workspace.repositoryRoot,
        canonicalRootKey: workspace.canonicalRepositoryKey
      }),
      (error) => error instanceof WriteCustodyError &&
        ["write_custody_conflict", "write_custody_state_ambiguous"].includes(error.code)
    );
    const retained = await contender.getWriteAccess(workspace.canonicalRepositoryKey);
    assert.equal(retained.executionId, "review-crash");
    assert.equal(custodyKindOf(retained), CUSTODY_KINDS.COHERENT_REVIEW);
  });
});
