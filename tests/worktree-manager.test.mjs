import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";
import {
  GitWorktreeManager,
  resolveRepositoryCoordinationIdentity
} from "../src/worktree-manager.mjs";
import {
  canonicalRootKey,
  resolveCanonicalWorkspaceRoot
} from "../src/workspace-root.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function withRepository(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-worktree-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const stateRoot = path.join(fixtureRoot, "state");
  try {
    await mkdir(repositoryRoot, { recursive: true });
    git(repositoryRoot, ["init"]);
    git(repositoryRoot, ["config", "user.email", "tests@example.invalid"]);
    git(repositoryRoot, ["config", "user.name", "Phase Five Tests"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "base\n", "utf8");
    git(repositoryRoot, ["add", "tracked.txt"]);
    git(repositoryRoot, ["commit", "-m", "fixture base"]);
    await callback({ fixtureRoot, repositoryRoot, stateRoot });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function liveObservation(pid, startTime = String(pid * 100)) {
  return Object.freeze({
    status: PROCESS_IDENTITY_STATUS.ALIVE,
    identity: Object.freeze({ pid, startTime, source: "test-process-start" })
  });
}

function custodyFor(stateRoot) {
  return new DurableWriteCustodyManager({
    stateRoot,
    currentPid: 100,
    inspectProcess: async (pid) => liveObservation(pid),
    now: (() => {
      let now = 1_000;
      return () => now++;
    })()
  });
}

function successfulWriter({ onCwd } = {}) {
  return async (argumentsForRunner) => {
    await onCwd?.(argumentsForRunner);
    const child = new EventEmitter();
    child.pid = 200;
    const processIdentity = Object.freeze({
      executionId: argumentsForRunner.executionId,
      agentType: argumentsForRunner.agentType,
      canonicalRoot: argumentsForRunner.canonicalRoot,
      pid: 200,
      startTime: "20000",
      source: "test-process-start",
      child,
      startedAt: 1_100
    });
    await argumentsForRunner.onChildStarted(processIdentity);
    return {
      result: "fake agent completed",
      stderrSummary: "",
      durationMs: 5,
      pid: 200,
      processStarted: true,
      processIdentity,
      terminalProof: Object.freeze({
        processIdentity,
        event: "close",
        code: 0,
        signal: null,
        observedAt: 1_200
      })
    };
  };
}

test("main checkout and linked worktrees share one canonical repository identity", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot }) => {
    const linkedRoot = path.join(fixtureRoot, "linked");
    git(repositoryRoot, ["worktree", "add", "--detach", linkedRoot, "HEAD"]);
    const mainWorkspace = await resolveCanonicalWorkspaceRoot(repositoryRoot, { accessMode: "write" });
    const linkedWorkspace = await resolveCanonicalWorkspaceRoot(linkedRoot, { accessMode: "write" });
    const mainIdentity = await resolveRepositoryCoordinationIdentity(mainWorkspace);
    const linkedIdentity = await resolveRepositoryCoordinationIdentity(linkedWorkspace);
    assert.equal(mainIdentity.canonicalRootKey, linkedIdentity.canonicalRootKey);
    assert.equal(mainIdentity.repositoryIdentity, linkedIdentity.repositoryIdentity);
  });
});

test("general-purpose runs in a persisted detached worktree that remains inspectable", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    const worktrees = new GitWorktreeManager({ writeCustody: custody });
    const baseCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    let runnerArguments;

    const outcome = await delegateAgent(
      {
        agentType: "general-purpose",
        task: "change tracked.txt without committing",
        cwd: repositoryRoot
      },
      {
        writeCustody: custody,
        worktreeManager: worktrees,
        createExecutionId: () => "isolated-worker",
        runAgent: successfulWriter({
          async onCwd(argumentsForRunner) {
            runnerArguments = argumentsForRunner;
            await writeFile(path.join(argumentsForRunner.cwd, "tracked.txt"), "worker change\n", "utf8");
          }
        })
      }
    );

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.custodyState, "released");
    assert.equal(outcome.baseCommit, baseCommit);
    assert.equal(outcome.worktreeRoot, runnerArguments.cwd);
    assert.notEqual(runnerArguments.cwd, repositoryRoot);
    assert.equal(runnerArguments.canonicalRoot, repositoryRoot);
    assert.ok(runnerArguments.prompt.includes("Working directory: " + runnerArguments.cwd));
    assert.ok(runnerArguments.prompt.includes("Canonical root: " + outcome.worktreeRoot));
    assert.equal(runnerArguments.prompt.includes("Canonical root: " + repositoryRoot), false);
    assert.equal(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8"), "base\n");
    assert.equal(await readFile(path.join(outcome.worktreeRoot, "tracked.txt"), "utf8"), "worker change\n");
    assert.equal(git(outcome.worktreeRoot, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(git(outcome.worktreeRoot, ["status", "--short"]), "M tracked.txt");
    assert.equal(git(repositoryRoot, ["status", "--short"]), "");
    await access(outcome.worktreeRoot);

    const repositoryState = custody.repositoryStateDirectory(
      canonicalRootKey(path.join(repositoryRoot, ".git"))
    );
    const history = JSON.parse(
      await readFile(path.join(repositoryState, "executions", "isolated-worker", "record.json"), "utf8")
    );
    assert.equal(history.baseCommit, baseCommit);
    assert.equal(history.worktreeRoot, outcome.worktreeRoot);
    assert.equal(history.state, "RELEASED");
    assert.equal((await readdir(path.join(repositoryState, "worktrees"))).includes("isolated-worker"), true);
  });
});

test("task remains root-bound and does not create a worktree", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    let observedCwd;
    const outcome = await delegateAgent(
      { agentType: "task", task: "run one validation command", cwd: repositoryRoot },
      {
        writeCustody: custody,
        createExecutionId: () => "root-bound-task",
        runAgent: successfulWriter({
          onCwd(argumentsForRunner) {
            observedCwd = argumentsForRunner.cwd;
          }
        })
      }
    );

    assert.equal(outcome.status, "completed");
    assert.equal(observedCwd, repositoryRoot);
    assert.equal(Object.hasOwn(outcome, "worktreeRoot"), false);
    const entries = await readdir(
      path.join(
        custody.repositoryStateDirectory(canonicalRootKey(path.join(repositoryRoot, ".git"))),
        "worktrees"
      )
    );
    assert.deepEqual(entries, []);
  });
});

test("read-only roles never invoke worktree preparation", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    let worktreeCalled = false;
    const outcome = await delegateAgent(
      { agentType: "code-review", task: "inspect the current diff", cwd: repositoryRoot },
      {
        writeCustody: custody,
        worktreeManager: {
          async prepare() {
            worktreeCalled = true;
            throw new Error("read-only role must not prepare a worktree");
          }
        },
        runAgent: async (argumentsForRunner) => ({
          result: "review complete",
          stderrSummary: "",
          durationMs: 1,
          observedCwd: argumentsForRunner.cwd
        })
      }
    );
    assert.equal(outcome.status, "completed");
    assert.equal(worktreeCalled, false);
    assert.equal(outcome.effectiveCwd, repositoryRoot);
  });
});
