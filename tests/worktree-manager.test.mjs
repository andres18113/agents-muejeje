import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
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
  GIT_COMMAND_TIMEOUT_MS,
  GitWorktreeManager,
  WorktreeManagerError,
  buildGitEnvironment,
  gitHookIsolationArguments,
  resolveRepositoryCoordinationIdentity,
  runGit
} from "../src/worktree-manager.mjs";
import {
  canonicalRepositoryKey,
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

/**
 * Windows exposes several textual spellings of the same directory: os.tmpdir()
 * can return a short 8.3 alias while realpath resolves the long form, and the
 * two spellings name one directory. Production canonicalizes through realpath, so
 * the fixture canonicalizes once here and every assertion compares canonical
 * identities rather than whichever spelling the OS happened to hand back.
 */
async function withRepository(callback) {
  const fixtureRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "claude-agents-worktree-"))
  );
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

/**
 * Compares two paths by filesystem identity, not by spelling. Both sides are
 * resolved through realpath so an 8.3 alias, a differing drive-letter case, or
 * any other alternate representation of the same directory still compares
 * equal. Production canonicalization is never weakened to make these pass.
 */
async function assertSamePath(actual, expected, message) {
  assert.equal(await realpath(actual), await realpath(expected), message);
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
      repositoryRoot: argumentsForRunner.repositoryRoot,
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
    assert.equal(mainIdentity.canonicalRepositoryKey, linkedIdentity.canonicalRepositoryKey);
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
    await assertSamePath(outcome.worktreeRoot, runnerArguments.cwd);
    assert.notEqual(runnerArguments.cwd, repositoryRoot);
    // The runner binds process identity to the coordinated repository, while
    // Claude actually executes inside the isolated worktree.
    await assertSamePath(runnerArguments.repositoryRoot, repositoryRoot);
    assert.ok(runnerArguments.prompt.includes("Working directory: " + runnerArguments.cwd));
    assert.ok(runnerArguments.prompt.includes("Workspace root: " + outcome.worktreeRoot));
    assert.ok(runnerArguments.prompt.includes("Repository root: " + repositoryRoot));
    assert.equal(runnerArguments.prompt.includes("Workspace root: " + repositoryRoot), false);
    assert.match(runnerArguments.prompt, /isolated Git worktree checked out from the repository root/);
    assert.equal(await readFile(path.join(repositoryRoot, "tracked.txt"), "utf8"), "base\n");
    assert.equal(await readFile(path.join(outcome.worktreeRoot, "tracked.txt"), "utf8"), "worker change\n");
    assert.equal(git(outcome.worktreeRoot, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(git(outcome.worktreeRoot, ["status", "--short"]), "M tracked.txt");
    assert.equal(git(repositoryRoot, ["status", "--short"]), "");
    await access(outcome.worktreeRoot);

    const repositoryState = custody.repositoryStateDirectory(
      canonicalRepositoryKey(path.join(repositoryRoot, ".git"))
    );
    const history = JSON.parse(
      await readFile(path.join(repositoryState, "executions", "isolated-worker", "record.json"), "utf8")
    );
    assert.equal(history.baseCommit, baseCommit);
    await assertSamePath(history.worktreeRoot, outcome.worktreeRoot);
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
    await assertSamePath(observedCwd, repositoryRoot);
    // Root-bound roles run with workspaceRoot === repositoryRoot.
    assert.equal(Object.hasOwn(outcome, "worktreeRoot"), false);
    await assertSamePath(outcome.canonicalRoot, repositoryRoot);
    const entries = await readdir(
      path.join(
        custody.repositoryStateDirectory(canonicalRepositoryKey(path.join(repositoryRoot, ".git"))),
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
    await assertSamePath(outcome.effectiveCwd, repositoryRoot);
  });
});

/** A Git child that only does what the test tells it to do. */
let nextFakeGitPid = 7_000;

function fakeGitChild() {
  const child = new EventEmitter();
  child.pid = nextFakeGitPid++;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

/**
 * Wraps real timers so a test can prove a deadline both fires and never
 * detaches itself from the event loop.
 */
function recordingScheduler() {
  const timers = [];
  const schedule = (callback, delayMs) => {
    const timer = {
      unrefCalls: 0,
      handle: setTimeout(callback, delayMs),
      unref() {
        this.unrefCalls += 1;
        return this;
      }
    };
    timers.push(timer);
    return timer;
  };
  const cancelSchedule = (timer) => {
    if (timer?.handle) clearTimeout(timer.handle);
  };
  return { timers, schedule, cancelSchedule };
}

test("Git worktree commands are bounded and settle exactly once", async () => {
  assert.ok(
    Number.isSafeInteger(GIT_COMMAND_TIMEOUT_MS) && GIT_COMMAND_TIMEOUT_MS > 0,
    "the default Git deadline must be finite"
  );

  // Success.
  const successChild = fakeGitChild();
  const success = runGit(["rev-parse", "HEAD"], {
    spawnProcess: () => successChild,
    timeoutMs: 5_000
  });
  successChild.stdout.emit("data", Buffer.from("deadbeef"));
  successChild.stderr.emit("data", Buffer.from("warning"));
  successChild.emit("close", 0);
  assert.deepEqual({ ...(await success) }, { stdout: "deadbeef", stderr: "warning" });
  assert.equal(successChild.killCalls, 0);

  // Nonzero exit surfaces Git's own diagnostics.
  const failingChild = fakeGitChild();
  const failing = runGit(["worktree", "add", "--detach", "x", "y"], {
    spawnProcess: () => failingChild,
    timeoutMs: 5_000
  });
  failingChild.stderr.emit("data", Buffer.from("fatal: invalid reference"));
  failingChild.emit("close", 128);
  await assert.rejects(failing, (error) => {
    assert.ok(error instanceof WorktreeManagerError);
    assert.equal(error.code, "worktree_git_failed");
    assert.equal(error.sideEffectsUnproven, false);
    assert.match(error.message, /exit code 128/u);
    assert.match(error.message, /fatal: invalid reference/u);
    return true;
  });

  // Output overflow still kills only the spawned Git process.
  const overflowChild = fakeGitChild();
  const overflow = runGit(["worktree", "list"], {
    spawnProcess: () => overflowChild,
    platform: "linux",
    maxOutputBytes: 8,
    timeoutMs: 5_000
  });
  overflowChild.stdout.emit("data", Buffer.from("x".repeat(64)));
  overflowChild.emit("close", 0);
  await assert.rejects(overflow, (error) => {
    assert.equal(error.code, "worktree_git_output_overflow");
    return true;
  });
  assert.equal(overflowChild.killCalls, 1);

  // Timeout: bounded, kills exactly the spawned handle, and stays ambiguous.
  const scheduler = recordingScheduler();
  const stalledChild = fakeGitChild();
  const timedOut = runGit(["worktree", "add", "--detach", "target", "base"], {
    spawnProcess: () => stalledChild,
    platform: "linux",
    timeoutMs: 10,
    terminationTimeoutMs: 10,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule
  });
  await assert.rejects(timedOut, (error) => {
    assert.ok(error instanceof WorktreeManagerError);
    assert.equal(error.code, "worktree_git_timeout");
    assert.equal(
      error.sideEffectsUnproven,
      true,
      "a Git deadline must never claim the command had no effect"
    );
    assert.match(error.message, /git worktree add --detach target base/u);
    return true;
  });
  assert.equal(stalledChild.killCalls, 1, "only the exact spawned Git process may be killed");
  assert.ok(scheduler.timers.length > 0);
  for (const timer of scheduler.timers) {
    assert.equal(timer.unrefCalls, 0, "the Git deadline must stay referenced");
  }

  // A late close after the deadline must not settle the Promise a second time.
  stalledChild.emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));

  // An invalid deadline fails closed rather than running unbounded.
  await assert.rejects(
    runGit(["status"], { spawnProcess: () => fakeGitChild(), platform: "linux", timeoutMs: 0 }),
    (error) => {
      assert.equal(error.code, "worktree_git_timeout_invalid");
      return true;
    }
  );

  // A spawn that throws is reported, never left pending.
  await assert.rejects(
    runGit(["status"], {
      spawnProcess: () => {
        throw new Error("git missing");
      }
    }),
    (error) => {
      assert.equal(error.code, "worktree_git_spawn_failed");
      return true;
    }
  );
});

test("a Git deadline during worktree preparation retains custody instead of releasing it", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    const baseCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    let addAttempted = false;

    // rev-parse succeeds; `git worktree add` starts and then never finishes.
    const runGitCommand = async (args, options) => {
      if (args[0] === "rev-parse") {
        const child = fakeGitChild();
        const pending = runGit(args, { ...options, spawnProcess: () => child, timeoutMs: 5_000 });
        child.stdout.emit("data", Buffer.from(baseCommit));
        child.emit("close", 0);
        return await pending;
      }
      addAttempted = true;
      // Pinned to the direct-handle path so the test never starts a real
      // taskkill against a stub PID.
      return await runGit(args, {
        ...options,
        spawnProcess: () => fakeGitChild(),
        platform: "linux",
        timeoutMs: 10,
        terminationTimeoutMs: 10
      });
    };

    let runnerCalled = false;
    const outcome = await delegateAgent(
      { agentType: "general-purpose", task: "prepare a worktree that stalls", cwd: repositoryRoot },
      {
        writeCustody: custody,
        worktreeManager: new GitWorktreeManager({ writeCustody: custody, runGitCommand }),
        createExecutionId: () => "stalled-preparation",
        runAgent: async () => {
          runnerCalled = true;
          return { result: "unreachable", stderrSummary: "", durationMs: 1 };
        }
      }
    );

    assert.equal(addAttempted, true);
    assert.equal(runnerCalled, false, "Claude must never start when preparation is ambiguous");
    assert.equal(outcome.status, "failed");
    // Truthful: no Claude child existed, so this is not a termination problem.
    assert.equal(outcome.error.code, "worktree_preparation_ambiguous");
    assert.match(outcome.error.message, /side effects are unproven/u);
    assert.equal(outcome.custodyState, "orphaned");

    const retained = await custody.getWriteAccess(
      canonicalRepositoryKey(path.join(repositoryRoot, ".git"))
    );
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.orphanReason, "worktree-preparation-ambiguous");

    // Fail closed: the ambiguous repository admits no new writer.
    const blocked = await delegateAgent(
      { agentType: "task", task: "must remain blocked", cwd: repositoryRoot },
      {
        writeCustody: custody,
        createExecutionId: () => "blocked-after-ambiguity",
        runAgent: successfulWriter()
      }
    );
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.error.code, "write_custody_conflict");
  });
});

test("an interrupted Git child resolves whether or not it closes after the kill", async () => {
  // 6 and 7. Both interruption reasons must settle, and the outcome must state
  // honestly whether termination was actually proven.
  for (const [label, trigger] of [
    ["timeout", () => {}],
    ["overflow", (child) => child.stdout.emit("data", Buffer.from("x".repeat(64)))]
  ]) {
    // (a) The child ignores the kill and never closes: the bounded terminal
    // wait must still settle the Promise, with termination unproven.
    const stubborn = fakeGitChild();
    const stubbornRun = runGit(["worktree", "add", "--detach", "t", "b"], {
      spawnProcess: () => stubborn,
      platform: "linux",
      maxOutputBytes: 8,
      timeoutMs: 10,
      terminationTimeoutMs: 10
    });
    trigger(stubborn);
    await assert.rejects(stubbornRun, (error) => {
      assert.ok(error instanceof WorktreeManagerError, label);
      assert.equal(error.sideEffectsUnproven, true, label);
      assert.equal(error.terminationProven, false, label + " must not claim proven termination");
      return true;
    });
    assert.equal(stubborn.killCalls, 1, label + " must ask the exact child to die once");

    // (b) The child closes after the kill: termination is proven and the
    // failure is deterministic, but side effects are still unproven.
    const compliant = fakeGitChild();
    compliant.kill = () => {
      compliant.killCalls += 1;
      setImmediate(() => compliant.emit("close", null, "SIGTERM"));
      return true;
    };
    const compliantRun = runGit(["worktree", "add", "--detach", "t", "b"], {
      spawnProcess: () => compliant,
      platform: "linux",
      maxOutputBytes: 8,
      timeoutMs: 10,
      terminationTimeoutMs: 5_000
    });
    trigger(compliant);
    await assert.rejects(compliantRun, (error) => {
      assert.equal(error.terminationProven, true, label + " close after kill proves termination");
      assert.equal(error.sideEffectsUnproven, true, label + " still cannot prove what Git wrote");
      return true;
    });
  }
});

test("orchestration Git runs in a built environment, never the inherited one", async () => {
  // 8. Git is an external execution boundary: unrelated secret-bearing values
  // must not reach Git or anything Git starts.
  const parentEnvironment = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    GITHUB_TOKEN: "ghp-should-not-propagate",
    AWS_SECRET_ACCESS_KEY: "aws-should-not-propagate",
    NPM_TOKEN: "npm-should-not-propagate",
    ANTHROPIC_API_KEY: "anthropic-should-not-propagate",
    GIT_SSH_COMMAND: "ssh -i /should/not/propagate",
    SSH_AUTH_SOCK: "/should/not/propagate"
  };

  const built = buildGitEnvironment(parentEnvironment, { platform: "win32" });
  assert.equal(built.PATH, "C:\\Windows\\System32");
  assert.equal(built.SystemRoot, "C:\\Windows");
  assert.equal(built.TEMP, "C:\\Temp");
  for (const secret of [
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "ANTHROPIC_API_KEY",
    "GIT_SSH_COMMAND",
    "SSH_AUTH_SOCK"
  ]) {
    assert.equal(built[secret], undefined, secret + " must not reach orchestration Git");
  }
  // No forwarded value may carry a secret through under any name.
  for (const value of Object.values(built)) {
    assert.doesNotMatch(String(value), /should-not-propagate|should\/not\/propagate/u);
  }
  // Deterministic Git behavior, independent of host configuration.
  assert.equal(built.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(built.GIT_CONFIG_GLOBAL, "NUL");
  assert.equal(built.GIT_CONFIG_SYSTEM, "NUL");
  assert.equal(built.GIT_TERMINAL_PROMPT, "0");
  assert.equal(buildGitEnvironment(parentEnvironment, { platform: "linux" }).GIT_CONFIG_GLOBAL, "/dev/null");

  // End to end: the environment actually handed to the spawned process.
  let spawnedOptions;
  const child = fakeGitChild();
  const pending = runGit(["rev-parse", "HEAD"], {
    env: parentEnvironment,
    platform: "win32",
    timeoutMs: 5_000,
    spawnProcess: (command, args, options) => {
      spawnedOptions = options;
      return child;
    }
  });
  child.stdout.emit("data", Buffer.from("abc"));
  child.emit("close", 0);
  await pending;
  assert.equal(spawnedOptions.env.GITHUB_TOKEN, undefined);
  assert.equal(spawnedOptions.env.PATH, "C:\\Windows\\System32");
  assert.equal(spawnedOptions.shell, false);
});

test("mutating worktree preparation disables repository hooks", async () => {
  // 9a. Only the mutating checkout carries hook isolation; read-only identity
  // commands are left alone.
  const invocations = [];
  const runProcess = async (command, args) => {
    invocations.push({ command, args });
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runGit(["worktree", "add", "--detach", "target", "base"], {
    platform: "win32",
    timeoutMs: 5_000,
    disableHooks: true,
    runProcess
  });
  await runGit(["rev-parse", "HEAD"], { platform: "win32", timeoutMs: 5_000, runProcess });

  assert.deepEqual(invocations[0].args, [
    "-c",
    "core.hooksPath=NUL",
    "worktree",
    "add",
    "--detach",
    "target",
    "base"
  ]);
  assert.deepEqual(invocations[1].args, ["rev-parse", "HEAD"]);
  assert.deepEqual(gitHookIsolationArguments({ platform: "linux" }), ["-c", "core.hooksPath=/dev/null"]);
});

test("a repository post-checkout hook does not run during isolated worktree preparation", async () => {
  // 9b. The real guarantee, against real Git: preparing an isolated workspace
  // must not execute repository-supplied scripts.
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const marker = path.join(repositoryRoot, "hook-executed.txt");
    const hookPath = path.join(repositoryRoot, ".git", "hooks", "post-checkout");
    await writeFile(
      hookPath,
      "#!/bin/sh\ntouch " + JSON.stringify(marker.split(path.sep).join("/")) + "\n",
      "utf8"
    );
    await chmod(hookPath, 0o755);

    // The hook is real: an ordinary checkout runs it.
    const controlWorktree = path.join(stateRoot, "control-worktree");
    git(repositoryRoot, ["worktree", "add", "--detach", controlWorktree, "HEAD"]);
    await access(marker);
    await rm(marker, { force: true });

    const custody = custodyFor(stateRoot);
    const outcome = await delegateAgent(
      { agentType: "general-purpose", task: "prepare without running hooks", cwd: repositoryRoot },
      {
        writeCustody: custody,
        worktreeManager: new GitWorktreeManager({
          writeCustody: custody,
          inspectProcess: async (pid) => liveObservation(pid)
        }),
        createExecutionId: () => "hook-isolated-worker",
        runAgent: successfulWriter()
      }
    );

    assert.equal(outcome.status, "completed");
    await access(outcome.worktreeRoot);
    assert.equal(
      await pathIsPresent(marker),
      false,
      "orchestration worktree preparation must not run repository hooks"
    );
  });
});

async function pathIsPresent(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

test("the supervised Git operation identity is persisted while preparing and cleared on close", async () => {
  // D. The durable record must be able to distinguish "Git still running" from
  // "Git gone" after a coordinator crash during worktree preparation.
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    const observed = [];
    const worktrees = new GitWorktreeManager({
      writeCustody: custody,
      inspectProcess: async (pid) => liveObservation(pid)
    });
    const repositoryKey = canonicalRepositoryKey(path.join(repositoryRoot, ".git"));

    const originalRecord = custody.recordWorktreeOperation.bind(custody);
    custody.recordWorktreeOperation = async (input) => {
      const result = await originalRecord(input);
      observed.push({ ...input.gitOperation });
      // While preparing, the live record names the exact Git process.
      const live = await custody.getWriteAccess(repositoryKey);
      observed.push({ persisted: live.gitOperation, state: live.state });
      return result;
    };

    const outcome = await delegateAgent(
      { agentType: "general-purpose", task: "record the git operation", cwd: repositoryRoot },
      {
        writeCustody: custody,
        worktreeManager: worktrees,
        createExecutionId: () => "git-operation-worker",
        runAgent: successfulWriter()
      }
    );

    assert.equal(outcome.status, "completed");
    assert.equal(observed[0].kind, "worktree-add");
    assert.ok(Number.isSafeInteger(observed[0].pid) && observed[0].pid > 0);
    assert.equal(observed[1].state, "PREPARING_WORKTREE");
    assert.equal(observed[1].persisted.kind, "worktree-add");
    assert.equal(observed[1].persisted.pid, observed[0].pid);

    // Cleared once the exact Git child closed, so the completed history does
    // not claim an operation is still in flight.
    const history = JSON.parse(
      await readFile(
        path.join(
          custody.repositoryStateDirectory(repositoryKey),
          "executions",
          "git-operation-worker",
          "record.json"
        ),
        "utf8"
      )
    );
    assert.equal(history.state, "RELEASED");
    assert.equal(history.gitOperation, undefined);
  });
});

test("Windows Git termination targets the exact PID tree and never a process name", async () => {
  // C. Same conservative rules as the Claude child: exact PID, never a name,
  // bounded terminator, and a bounded terminal wait afterwards.
  const child = fakeGitChild();
  child.pid = 31_337;
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  let invocation;

  const pending = runGit(["worktree", "add", "--detach", "target", "base"], {
    spawnProcess: () => child,
    platform: "win32",
    timeoutMs: 10,
    terminationTimeoutMs: 50,
    spawnTerminator: (command, args, options) => {
      invocation = { command, args, options };
      return terminator;
    }
  });

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "worktree_git_timeout");
    assert.equal(error.sideEffectsUnproven, true);
    // The Git child never closed, so termination is not proven.
    assert.equal(error.terminationProven, false);
    return true;
  });

  assert.deepEqual(invocation, {
    command: "taskkill",
    args: ["/PID", "31337", "/T", "/F"],
    options: { shell: false, windowsHide: true, stdio: "ignore" }
  });
  // The direct handle is not also killed when the PID tree was targeted.
  assert.equal(child.killCalls, 0);

  // A Git child that does close after the PID-tree kill yields proven
  // termination while its side effects stay unproven.
  const closing = fakeGitChild();
  closing.pid = 31_338;
  const closingTerminator = new EventEmitter();
  closingTerminator.kill = () => true;
  const closingRun = runGit(["worktree", "add", "--detach", "t2", "b2"], {
    spawnProcess: () => closing,
    platform: "win32",
    timeoutMs: 10,
    terminationTimeoutMs: 5_000,
    spawnTerminator: () => {
      setImmediate(() => {
        closingTerminator.emit("close", 0);
        closing.emit("close", null, "SIGKILL");
      });
      return closingTerminator;
    }
  });
  await assert.rejects(closingRun, (error) => {
    assert.equal(error.code, "worktree_git_timeout");
    assert.equal(error.terminationProven, true);
    assert.equal(error.sideEffectsUnproven, true);
    return true;
  });
});

test("an unproven Git termination leaves the operation identity on the record", async () => {
  // D. The identity is cleared only on proven close. A worktree add that was
  // interrupted without an observed close must keep it, so a later coordinator
  // can reconcile the repository by identity instead of guessing.
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    const baseCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const repositoryKey = canonicalRepositoryKey(path.join(repositoryRoot, ".git"));

    const runGitCommand = async (args, options) => {
      if (args[0] === "rev-parse") {
        const child = fakeGitChild();
        const pending = runGit(args, { ...options, spawnProcess: () => child, timeoutMs: 5_000 });
        child.stdout.emit("data", Buffer.from(baseCommit));
        child.emit("close", 0);
        return await pending;
      }
      // Stalls, ignores the kill, and never closes.
      return await runGit(args, {
        ...options,
        spawnProcess: () => fakeGitChild(),
        platform: "linux",
        timeoutMs: 10,
        terminationTimeoutMs: 10
      });
    };

    const outcome = await delegateAgent(
      { agentType: "general-purpose", task: "interrupted preparation", cwd: repositoryRoot },
      {
        writeCustody: custody,
        worktreeManager: new GitWorktreeManager({
          writeCustody: custody,
          runGitCommand,
          inspectProcess: async (pid) => liveObservation(pid)
        }),
        createExecutionId: () => "unproven-preparation",
        runAgent: successfulWriter()
      }
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "worktree_preparation_ambiguous");
    assert.equal(outcome.custodyState, "orphaned");

    const retained = await custody.getWriteAccess(repositoryKey);
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.orphanReason, "worktree-preparation-ambiguous");
    // The exact Git process identity survives for reconciliation.
    assert.equal(retained.gitOperation.kind, "worktree-add");
    assert.ok(Number.isSafeInteger(retained.gitOperation.pid));
  });
});
