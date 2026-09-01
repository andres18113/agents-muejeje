import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeTimeoutError } from "../src/claude-errors.mjs";
import { terminateClaudeChild, terminateStartedChild } from "../src/claude-termination.mjs";
import { runClaudeAgent } from "../src/claude-runner.mjs";
import { observeChildTerminal } from "../src/process/terminal-observer.mjs";
import { DurableWriteCustodyManager, WriteCustodyError } from "../src/write-custody.mjs";

/**
 * The Phase 5 freeze invariant for destructive termination:
 *
 *   a taskkill helper was launched  =>  the durable ownership record had
 *                                       already published TERMINATING.
 *
 * A taskkill helper is a detached PID-tree process with no durable identity;
 * only the launching coordinator's memory tracks it. If one could start while
 * the record still said ACTIVE, a crash would leave a durable ACTIVE record
 * that reconciliation may legitimately release - with an unproven destructive
 * helper still running. Requiring published TERMINATING first is precisely what
 * makes the ACTIVE + coordinator-dead + Claude-dead release path safe.
 *
 * These tests observe the real DurableWriteCustodyManager against a real
 * temporary filesystem wherever the ordering is what is under test. No real
 * Claude process is ever launched.
 */

const canonicalRoot = "C:\\workspace\\ordering-root";
const canonicalRootKey = canonicalRoot.toLowerCase();
const identitySource = "test-process-start";

let nextPid = 70_000;

function stalledChild({ pid = nextPid++, closeOnKill = false } = {}) {
  class StalledStdin extends EventEmitter {
    write() {
      return false;
    }
    end() {}
    destroy() {}
  }
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new StalledStdin();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (closeOnKill) setImmediate(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

function aliveObservation(pid, startTime = String(pid * 100)) {
  return Object.freeze({
    status: "alive",
    identity: Object.freeze({ pid, startTime, source: identitySource })
  });
}

const inspectAlive = async (pid) => aliveObservation(pid);

function childIdentityFor(child, { executionId = "execution-a", agentType = "task" } = {}) {
  return Object.freeze({
    executionId,
    agentType,
    repositoryRoot: canonicalRoot,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: identitySource,
    child,
    startedAt: 1_000
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withStateRoot(callback) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-ordering-"));
  try {
    await callback(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function custodyManager(stateRoot, options = {}) {
  return new DurableWriteCustodyManager({
    stateRoot,
    // The coordinator is this test process; the child PIDs are the fakes.
    inspectProcess: async (pid) => aliveObservation(pid),
    currentPid: process.pid,
    ...options
  });
}

function recordPathFor(custody) {
  return path.join(custody.repositoryStateDirectory(canonicalRootKey), "ownership", "record.json");
}

/** Drives a real record to ACTIVE and returns its bound Claude identity. */
async function reachActiveState(custody, child, { executionId = "execution-a" } = {}) {
  await custody.reserveWriteAccess({
    executionId,
    agentType: "task",
    canonicalRoot,
    canonicalRootKey
  });
  await custody.markSpawning({ executionId, canonicalRootKey });
  const identity = childIdentityFor(child, { executionId });
  await custody.activateWriteAccess({ executionId, canonicalRootKey, processIdentity: identity });
  return identity;
}

/**
 * Runs forced termination for one already-ACTIVE child, counting every taskkill
 * launch and recording what the durable record said at the exact instant of
 * each launch. The read is synchronous on purpose: it happens inside the spawn
 * adapter, so it observes the record as it was when the helper was created.
 */
function forceTermination({
  child,
  processIdentity,
  onTerminationStarted,
  recordPath,
  freshObservation = inspectAlive,
  terminationTimeoutMs = 200,
  helper
}) {
  const launches = [];
  const terminalObserver = observeChildTerminal(child, processIdentity);
  const promise = terminateStartedChild({
    child,
    processIdentity,
    terminalObserver,
    originalError: new ClaudeTimeoutError(1_000),
    onTerminationStarted,
    terminateChild: (target, options) => terminateClaudeChild(target, {
      ...options,
      platform: "win32",
      inspectProcess: freshObservation,
      spawnTerminator: () => {
        launches.push({
          durableStateAtLaunch: recordPath
            ? JSON.parse(readFileSync(recordPath, "utf8")).state
            : undefined
        });
        return helper ?? new EventEmitter();
      }
    }),
    executionDeadlineAt: Date.now() + 60_000,
    terminationTimeoutMs,
    inspectProcess: inspectAlive,
    now: Date.now,
    schedule: setTimeout,
    cancelSchedule: clearTimeout
  });
  return { promise, launches, terminalObserver };
}

test("a failed durable TERMINATING publication forbids the taskkill helper", async () => {
  await withStateRoot(async (stateRoot) => {
    const custody = custodyManager(stateRoot);
    const child = stalledChild();
    const identity = await reachActiveState(custody, child);
    const recordPath = recordPathFor(custody);

    // beginTermination rejects before publishing anything.
    let transitionAttempts = 0;
    const { promise, launches } = forceTermination({
      child,
      processIdentity: identity,
      recordPath,
      onTerminationStarted: async () => {
        transitionAttempts += 1;
        throw new WriteCustodyError("Failed to persist durable ownership state.", {
          code: "write_custody_persist_failed"
        });
      }
    });
    const error = await promise;

    assert.equal(transitionAttempts, 1);
    assert.equal(launches.length, 0, "no PID-based helper may be created");
    // The exact in-memory handle is still a legitimate termination request: it
    // targets a handle this process owns and creates no detached helper.
    assert.equal(child.killCalls, 1, "the exact child handle is still asked to die");

    assert.equal(error.code, "claude_termination_unproven");
    assert.equal(error.terminationResult.destructiveHelperAuthorized, false);
    assert.equal(error.terminationResult.durableTransition.status, "failed");
    assert.equal(error.terminationResult.terminalProof, undefined);
    assert.notEqual(error.terminationResult.taskkillLaunched, true);

    // Custody stays conservative: the record never moved and still blocks.
    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(persisted.state, "ACTIVE");
    assert.equal(persisted.accessMode, "write");
    await assert.rejects(
      custody.reserveWriteAccess({
        executionId: "execution-b",
        agentType: "task",
        canonicalRoot,
        canonicalRootKey
      }),
      /already retained/
    );
  });
});

test("a transition cancelled before publication forbids taskkill and can never publish later", async () => {
  await withStateRoot(async (stateRoot) => {
    // The custody mutation reaches its pre-publication pause and stays there
    // until after the transition deadline has passed, so cancellation lands
    // strictly before the rename that would have published TERMINATING.
    const held = deferred();
    const reachedPublicationGate = deferred();
    const custody = custodyManager(stateRoot, {
      beforePublish: async ({ nextRecord }) => {
        if (nextRecord.state !== "TERMINATING") return;
        reachedPublicationGate.resolve();
        await held.promise;
      }
    });
    const child = stalledChild();
    const identity = await reachActiveState(custody, child);
    const recordPath = recordPathFor(custody);

    let pendingTransition;
    const { promise, launches } = forceTermination({
      child,
      processIdentity: identity,
      recordPath,
      // A short grace makes the transition subdeadline expire while the
      // mutation is parked at its publication gate.
      terminationTimeoutMs: 120,
      onTerminationStarted: (processIdentity, { mutationSignal } = {}) => {
        pendingTransition = custody.beginTermination({
          executionId: "execution-a",
          canonicalRootKey,
          processIdentity,
          mutationSignal
        });
        return pendingTransition;
      }
    });

    await reachedPublicationGate.promise;
    const error = await promise;

    assert.equal(launches.length, 0, "a timed-out transition must not authorize taskkill");
    assert.equal(child.killCalls, 1, "only the exact child handle is asked to die");
    assert.equal(error.code, "claude_termination_unproven");
    assert.equal(error.terminationResult.destructiveHelperAuthorized, false);
    assert.equal(error.terminationResult.durableTransition.status, "timed-out");
    assert.equal(error.terminationResult.durableTransition.cancellationRequested, true);

    // Release the parked mutation. Its cancellation was requested before the
    // rename, so it must refuse to publish rather than land a stale TERMINATING
    // after the lifecycle already reported an unproven outcome.
    held.resolve();
    await assert.rejects(pendingTransition, (rejection) => {
      assert.ok(rejection instanceof WriteCustodyError);
      assert.equal(rejection.code, "write_custody_mutation_cancelled");
      return true;
    });

    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(persisted.state, "ACTIVE", "a cancelled transition never publishes");
    assert.equal(persisted.revision, 2, "no extra revision was published");
  });
});

test("a published durable TERMINATING permits taskkill, still gated by fresh identity and helper close", async () => {
  await withStateRoot(async (stateRoot) => {
    const custody = custodyManager(stateRoot);
    const child = stalledChild();
    const identity = await reachActiveState(custody, child);
    const recordPath = recordPathFor(custody);

    const beginTermination = (processIdentity, { mutationSignal } = {}) =>
      custody.beginTermination({
        executionId: "execution-a",
        canonicalRootKey,
        processIdentity,
        mutationSignal
      });

    // The helper is launched but never closes, so helper quiescence stays
    // unproven even though the durable gate opened.
    const helper = new EventEmitter();
    helper.killCalls = 0;
    helper.kill = () => {
      helper.killCalls += 1;
      return true;
    };
    const { promise, launches } = forceTermination({
      child,
      processIdentity: identity,
      recordPath,
      onTerminationStarted: beginTermination,
      helper
    });
    const error = await promise;

    assert.equal(launches.length, 1, "a published TERMINATING permits the destructive helper");
    assert.equal(
      launches[0].durableStateAtLaunch,
      "TERMINATING",
      "the record already said TERMINATING when the helper was created"
    );
    assert.equal(error.terminationResult.destructiveHelperAuthorized, true);
    assert.equal(error.terminationResult.durableTransition.status, "completed");

    // Launching is not proving. Without the helper's own close, custody stays
    // fail-closed regardless of the target.
    assert.equal(error.code, "claude_termination_unproven");
    assert.equal(error.terminationResult.terminalProof, undefined);
    assert.equal(error.terminationResult.taskkillHelperQuiescenceProven, false);
    assert.equal(helper.killCalls, 1, "the hung helper is itself bounded");

    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(persisted.state, "TERMINATING");
  });
});

test("a published TERMINATING still cannot authorize taskkill for a reused or dead PID", async () => {
  for (const [label, freshObservation] of [
    ["pid-reused", async (pid) => aliveObservation(pid, "999999")],
    ["dead", async () => ({ status: "dead" })],
    ["ambiguous", async () => ({ status: "ambiguous", reason: "denied" })]
  ]) {
    await withStateRoot(async (stateRoot) => {
      const custody = custodyManager(stateRoot);
      const child = stalledChild({ closeOnKill: true });
      const identity = await reachActiveState(custody, child);
      const recordPath = recordPathFor(custody);

      const { promise, launches } = forceTermination({
        child,
        processIdentity: identity,
        recordPath,
        freshObservation,
        onTerminationStarted: (processIdentity, { mutationSignal } = {}) =>
          custody.beginTermination({
            executionId: "execution-a",
            canonicalRootKey,
            processIdentity,
            mutationSignal
          })
      });
      await promise;

      // The durable gate opened, but the identity gate is independent and
      // still refuses every non-SAME_PROCESS observation.
      assert.equal(launches.length, 0, label + " must never authorize taskkill");
      assert.equal(child.killCalls, 1, label + " falls back to the exact handle");
      const persisted = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(persisted.state, "TERMINATING", label + " still published TERMINATING first");
    });
  }
});

test("the durable ordering invariant holds end to end through runClaudeAgent", async () => {
  // The architectural implication, observed through the real runner, the real
  // DurableWriteCustodyManager and a real record file: whenever a taskkill
  // helper is created, the record read at that exact instant already says
  // TERMINATING. The two scenarios differ only in whether the durable
  // transition is allowed to publish.
  for (const [label, transitionPublishes, expectedLaunches] of [
    ["published transition", true, 1],
    ["failed transition", false, 0]
  ]) {
    await withStateRoot(async (stateRoot) => {
      const custody = custodyManager(stateRoot);
      const executionId = "execution-a";
      await custody.reserveWriteAccess({
        executionId,
        agentType: "task",
        canonicalRoot,
        canonicalRootKey
      });
      await custody.markSpawning({ executionId, canonicalRootKey });
      const recordPath = recordPathFor(custody);

      const child = stalledChild();
      const launches = [];
      const helper = new EventEmitter();
      helper.kill = () => true;

      await assert.rejects(runClaudeAgent({
        prompt: "assignment body",
        cwd: canonicalRoot,
        repositoryRoot: canonicalRoot,
        executionId,
        agentType: "task",
        runtime: {
          claudeBin: "claude",
          model: "opus",
          reasoningEffort: "medium",
          timeoutMs: 40,
          maxCaptureBytes: 1024 * 1024,
          permissionMode: "plan",
          accessMode: "write",
          toolNames: ["Bash"],
          disallowedTools: ["Agent", "Task", "mcp__*"],
          shellPolicy: "task",
          childEnvironment: { PATH: "test-path", SystemRoot: "C:\\Windows" }
        },
        createSettings: async () => ({
          settingsPath: "C:\\temp\\claude-runtime-settings.json",
          cleanup: async () => {}
        }),
        spawnProcess: () => child,
        inspectProcess: inspectAlive,
        terminationTimeoutMs: 200,
        onChildStarted: (processIdentity, { mutationSignal } = {}) =>
          custody.activateWriteAccess({
            executionId,
            canonicalRootKey,
            processIdentity,
            mutationSignal
          }),
        onTerminationStarted: (processIdentity, { mutationSignal } = {}) => {
          if (!transitionPublishes) {
            return Promise.reject(new WriteCustodyError("publication refused", {
              code: "write_custody_persist_failed"
            }));
          }
          return custody.beginTermination({
            executionId,
            canonicalRootKey,
            processIdentity,
            mutationSignal
          });
        },
        terminateChild: (target, options) => terminateClaudeChild(target, {
          ...options,
          platform: "win32",
          inspectProcess: inspectAlive,
          spawnTerminator: () => {
            launches.push(JSON.parse(readFileSync(recordPath, "utf8")).state);
            return helper;
          }
        })
      }), (error) => {
        assert.equal(error.processStarted, true, label);
        return true;
      });

      assert.equal(launches.length, expectedLaunches, label + " taskkill launch count");
      // The invariant itself, stated directly and checked for every launch.
      for (const durableStateAtLaunch of launches) {
        assert.equal(
          durableStateAtLaunch,
          "TERMINATING",
          label + ": taskkill launched while the record said " + durableStateAtLaunch
        );
      }
      const persisted = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(persisted.state, transitionPublishes ? "TERMINATING" : "ACTIVE", label);
    });
  }
});
