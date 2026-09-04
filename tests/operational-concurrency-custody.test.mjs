import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { digestWorkspaceEntry } from "../src/changeset/workspace-digest.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import {
  CUSTODY_KINDS,
  DurableWriteCustodyManager,
  WriteCustodyError,
  repositoryIdForCanonicalRootKey
} from "../src/write-custody.mjs";
import { FAKE_CLAUDE_EXE, ensureFakeClaude } from "./fixtures/fake-claude-build.mjs";

const fakeClaudeExe = FAKE_CLAUDE_EXE;

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

async function withTestRepository(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-concurrency-"));
  const repositoryRoot = path.join(fixtureRoot, "repo");
  const stateRoot = path.join(fixtureRoot, "state");
  const scenarioFile = path.join(fixtureRoot, "fake-claude-scenario.json");
  const env = {
    ...process.env,
    TEMP: fixtureRoot,
    TMP: fixtureRoot,
    CLAUDE_AGENTS_CLAUDE_BIN: fakeClaudeExe
  };

  try {
    await mkdir(repositoryRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "user.name", "Concurrency Test"]);
    git(repositoryRoot, ["config", "user.email", "concurrency@example.invalid"]);
    git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
    git(repositoryRoot, ["config", "core.autocrlf", "false"]);

    await writeFile(path.join(repositoryRoot, "tracked.txt"), "hello world\n", "utf8");
    git(repositoryRoot, ["add", "tracked.txt"]);
    git(repositoryRoot, ["commit", "-m", "initial commit"]);

    const writeCustody = new DurableWriteCustodyManager({ stateRoot });
    await callback({ fixtureRoot, repositoryRoot, stateRoot, writeCustody, scenarioFile, env });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// Only a watchdog against a hung fixture; progress is decided by the barrier
// file and by Writer A's own settlement, never by this number.
const BARRIER_WATCHDOG_MS = 120_000;

test("Area 4 - Writer A vs Writer B competing processes fail closed", async () => {
  ensureFakeClaude();
  await withTestRepository(async ({ fixtureRoot, repositoryRoot, writeCustody, scenarioFile, env }) => {
    const readyFile = path.join(fixtureRoot, "fake-claude-ready.txt");
    const releaseFile = path.join(fixtureRoot, "fake-claude-release.txt");

    // Configure barrier execution for Writer A
    await writeFile(
      scenarioFile,
      JSON.stringify({
        scenario: "barrier"
      }),
      "utf8"
    );

    let writerASettlement;
    const writerAPromise = delegateAgent(
      {
        agentType: "general-purpose",
        task: "Writer A background operation",
        cwd: repositoryRoot
      },
      { env, writeCustody }
    );
    void writerAPromise.then(
      (outcome) => { writerASettlement = { outcome }; },
      (error) => { writerASettlement = { error }; }
    );

    // Wait until Writer A has actually reached the barrier. Getting there runs
    // through workspace resolution, a worktree preparation and a spawn, so its
    // duration belongs to machine load rather than to the exclusion this test
    // is about. The wait therefore ends on the barrier itself, or as soon as
    // Writer A settles and can no longer reach it, and the remaining bound is
    // a watchdog an order of magnitude above the slowest healthy readiness.
    const barrierDeadline = Date.now() + BARRIER_WATCHDOG_MS;
    while (Date.now() < barrierDeadline && !existsSync(readyFile) && !writerASettlement) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      existsSync(readyFile),
      writerASettlement
        ? "Writer A settled before holding the barrier, so Writer B never contended with it: " +
          JSON.stringify({
            status: writerASettlement.outcome?.status,
            error: writerASettlement.outcome?.error?.code ?? writerASettlement.error?.code,
            custody: writerASettlement.outcome?.custodyState
          })
        : "Writer A did not reach the ready barrier within the " + BARRIER_WATCHDOG_MS + "ms watchdog"
    );

    // Writer B attempts delegation while Writer A is actively holding custody
    const outcomeB = await delegateAgent(
      {
        agentType: "general-purpose",
        task: "Writer B competing operation",
        cwd: repositoryRoot
      },
      { env, writeCustody }
    );

    assert.equal(outcomeB.status, "failed");
    assert.ok(
      outcomeB.error.code === "write_custody_conflict" ||
      outcomeB.error.code === "concurrent_write_custody_active",
      "Writer B must fail with custody conflict, got: " + outcomeB.error.code
    );

    // Release Writer A
    await writeFile(releaseFile, "release\n", "utf8");
    const outcomeA = await writerAPromise;
    assert.equal(outcomeA.status, "completed");

    await rm(scenarioFile, { force: true });
    const outcomeC = await delegateAgent(
      {
        agentType: "general-purpose",
        task: "Writer C sequential operation",
        cwd: repositoryRoot
      },
      { env, writeCustody }
    );
    assert.equal(outcomeC.status, "completed");
  });
});

test("Area 4 - Multiple readers execute concurrently without mutual exclusion", async () => {
  ensureFakeClaude();
  await withTestRepository(async ({ repositoryRoot, writeCustody, env }) => {
    const [readerA, readerB] = await Promise.all([
      delegateAgent(
        {
          agentType: "explore",
          task: "Reader A inspection",
          cwd: repositoryRoot
        },
        { env, writeCustody }
      ),
      delegateAgent(
        {
          agentType: "explore",
          task: "Reader B inspection",
          cwd: repositoryRoot
        },
        { env, writeCustody }
      )
    ]);

    assert.equal(readerA.status, "completed");
    assert.equal(readerB.status, "completed");
    assert.equal(readerA.accessMode, "read");
    assert.equal(readerB.accessMode, "read");
  });
});

test("Area 4 - Coordinator crash recovery reconciles dead PIDs and admits new writer", async () => {
  await withTestRepository(async ({ repositoryRoot, stateRoot }) => {
    const workspace = await resolveCanonicalWorkspaceRoot(repositoryRoot);
    const key = workspace.canonicalRepositoryKey;

    const observations = new Map([
      [100, { status: "alive", identity: { pid: 100, startTime: "1000", source: "test" } }],
      [200, { status: "alive", identity: { pid: 200, startTime: "2000", source: "test" } }]
    ]);
    const inspector = async (pid) => observations.get(pid) || { status: "dead" };

    const firstCustody = new DurableWriteCustodyManager({
      stateRoot,
      currentPid: 100,
      inspectProcess: inspector
    });

    await firstCustody.reserveWriteAccess({
      executionId: "crashed-exec-id",
      agentType: "general-purpose",
      canonicalRoot: repositoryRoot,
      canonicalRootKey: key
    });

    // Coordinator 100 crashes and dies
    observations.set(100, { status: "dead" });
    observations.set(300, { status: "alive", identity: { pid: 300, startTime: "3000", source: "test" } });

    // Second coordinator 300 arrives
    const secondCustody = new DurableWriteCustodyManager({
      stateRoot,
      currentPid: 300,
      inspectProcess: inspector
    });

    const reconciliation = await secondCustody.reconcileExistingOwnership(key);
    assert.equal(reconciliation.released, true);
    assert.equal(await secondCustody.getWriteAccess(key), undefined);

    // New writer can now cleanly reserve and acquire custody
    const reserved = await secondCustody.reserveWriteAccess({
      executionId: "new-writer-id",
      agentType: "general-purpose",
      canonicalRoot: repositoryRoot,
      canonicalRootKey: key
    });
    assert.equal(reserved.state, "RESERVED");
  });
});

test("Area 4 - Custody safety: stale execution release rejection and no double release", async () => {
  await withTestRepository(async ({ repositoryRoot, writeCustody }) => {
    const workspace = await resolveCanonicalWorkspaceRoot(repositoryRoot);
    const key = workspace.canonicalRepositoryKey;

    await writeCustody.reserveWriteAccess({
      executionId: "correct-execution",
      agentType: "general-purpose",
      canonicalRoot: repositoryRoot,
      canonicalRootKey: key
    });

    // Attempting to release with a mismatched execution ID must fail closed
    await assert.rejects(
      writeCustody.releaseUnstartedWriteAccess({
        executionId: "wrong-execution",
        canonicalRootKey: key
      }),
      (err) => {
        assert.ok(err instanceof WriteCustodyError);
        assert.equal(err.code, "write_custody_owner_mismatch");
        return true;
      }
    );

    // Legitimate release succeeds
    const release1 = await writeCustody.releaseUnstartedWriteAccess({
      executionId: "correct-execution",
      canonicalRootKey: key
    });
    assert.equal(release1.state, "RELEASED");

    // Double release must reject / fail closed
    await assert.rejects(
      writeCustody.releaseUnstartedWriteAccess({
        executionId: "correct-execution",
        canonicalRootKey: key
      }),
      (err) => {
        assert.ok(err instanceof WriteCustodyError);
        return true;
      }
    );
  });
});

test("Area 7 - Cancellation blocks new operations and terminates cleanly", async () => {
  await withTestRepository(async ({ repositoryRoot }) => {
    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      digestWorkspaceEntry(path.join(repositoryRoot, "tracked.txt"), {
        cancelled: () => abortController.signal.aborted
      }),
      (err) => {
        return true;
      }
    );
  });
});
