import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { DurableWriteCustodyManager, WriteCustodyError } from "../src/write-custody.mjs";

/**
 * What happens after an ambiguity resolves.
 *
 * Phase E' is the one cancellation the coordinator may not settle: termination
 * began, the exact child's death could not be proven inside the bound, and a
 * process that might still be mutating the repository is not something a
 * deadline gets to declare finished. Retaining there is right.
 *
 * But that retention is ignorance about a moment, not a fact about forever. The
 * child does eventually die, and when it does the very same coordinator holds
 * everything needed to prove it: the in-memory evidence that it supervised that
 * exact spawn, and the durable identity - PID together with start time - to
 * re-observe. Ordinary reconciliation cannot use any of it, because it answers
 * only "what may a live coordinator conclude about some OTHER coordinator's
 * record", and this coordinator's own record is never that. Left alone, the
 * repository would stay held for the remaining life of the process purely
 * because the proof arrived late.
 *
 * So the next writer in the same session asks again, and the answer is decided
 * by observation rather than by elapsed time: still running or unknowable keeps
 * the orphan, provably gone releases it - and only the pinned execution,
 * repository and revision.
 */

const REPOSITORY = "C:\\workspace\\eventual-reclaim";
const REPOSITORY_KEY = REPOSITORY.toLowerCase();
const WORKSPACE = Object.freeze({
  requestedCwd: REPOSITORY,
  effectiveCwd: REPOSITORY,
  repositoryRoot: REPOSITORY,
  repositoryIdentity: REPOSITORY + "\\.git",
  canonicalRepositoryKey: REPOSITORY_KEY,
  rootSource: "git-boundary",
  isolated: false
});

const COORDINATOR_PID = 100;
const CLAUDE_PID = 61_000;
const HELPER_PID = 62_000;

/**
 * One observable process table. The Claude child starts alive, which is what
 * makes the initial settlement unable to prove anything, and the test decides
 * when it dies.
 */
function processWorld() {
  const alive = new Map([
    [COORDINATOR_PID, String(COORDINATOR_PID * 100)],
    [CLAUDE_PID, String(CLAUDE_PID * 100)],
    [HELPER_PID, String(HELPER_PID * 100)]
  ]);
  return {
    alive,
    inspections: [],
    kill(pid) {
      alive.delete(pid);
    },
    /** A different process now holds the same PID: reuse, not survival. */
    reusePid(pid) {
      alive.set(pid, "999999999");
    },
    inspect: async (pid) => {
      const startTime = alive.get(pid);
      return Object.freeze(startTime === undefined
        ? { status: PROCESS_IDENTITY_STATUS.DEAD }
        : {
          status: PROCESS_IDENTITY_STATUS.ALIVE,
          identity: Object.freeze({ pid, startTime, source: "eventual-reclaim" })
        });
    }
  };
}

function custodyFor(stateRoot, world) {
  return new DurableWriteCustodyManager({
    stateRoot,
    currentPid: COORDINATOR_PID,
    inspectProcess: async (pid) => {
      world.inspections.push(pid);
      return await world.inspect(pid);
    },
    now: () => 1_000
  });
}

function claudeIdentity(executionId) {
  const child = new EventEmitter();
  child.pid = CLAUDE_PID;
  return Object.freeze({
    executionId,
    agentType: "task",
    repositoryRoot: REPOSITORY,
    pid: CLAUDE_PID,
    startTime: String(CLAUDE_PID * 100),
    source: "eventual-reclaim",
    child,
    startedAt: 1_100
  });
}

function dependencies(writeCustody, { runAgent, executionId }) {
  return {
    env: {},
    writeCustody,
    createExecutionId: () => executionId,
    resolveWorkingDirectory: async () => WORKSPACE.effectiveCwd,
    resolveWorkspaceRoot: async () => WORKSPACE,
    resolveRepositoryIdentity: async () => WORKSPACE,
    loadContract: async () => "eventual reclaim contract",
    runAgent
  };
}

/** Phase E': ACTIVE, cancelled, termination begun, death unproven. */
async function runUnprovenTermination(writeCustody, executionId) {
  const abortController = new AbortController();
  return await delegateAgent(
    {
      agentType: "task",
      task: "writer A whose termination cannot be proven",
      cwd: WORKSPACE.effectiveCwd,
      abortSignal: abortController.signal
    },
    dependencies(writeCustody, {
      executionId,
      runAgent: async ({ onChildStarted, onTerminationStarted }) => {
        const identity = claudeIdentity(executionId);
        await onChildStarted?.(identity, {});
        abortController.abort();
        await onTerminationStarted?.(identity, {});
        throw Object.assign(new Error("forced termination could not be proven"), {
          code: "claude_termination_unproven",
          processStarted: true,
          processIdentity: identity
        });
      }
    })
  );
}

async function writerB(writeCustody, executionId) {
  try {
    return await delegateAgent(
      { agentType: "task", task: "the next writer in this same session", cwd: WORKSPACE.effectiveCwd },
      dependencies(writeCustody, {
        executionId,
        runAgent: async ({ onChildStarted }) => {
          const child = new EventEmitter();
          child.pid = CLAUDE_PID + 1;
          const identity = Object.freeze({
            executionId,
            agentType: "task",
            repositoryRoot: REPOSITORY,
            pid: child.pid,
            startTime: String(child.pid * 100),
            source: "eventual-reclaim",
            child,
            startedAt: 1_200
          });
          await onChildStarted?.(identity, {});
          return {
            result: "writer B completed",
            durationMs: 1,
            processStarted: true,
            processIdentity: identity,
            terminalProof: Object.freeze({
              processIdentity: identity,
              event: "close",
              code: 0,
              signal: null,
              observedAt: 1_300
            })
          };
        }
      })
    );
  } catch (error) {
    return { status: "threw", error: { code: error?.code } };
  }
}

async function withCoordinator(callback) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-eventual-"));
  const world = processWorld();
  try {
    await callback({ stateRoot, world, writeCustody: custodyFor(stateRoot, world) });
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

test("an unproven termination retains, and keeps retaining while the child is still alive", async () => {
  await withCoordinator(async ({ world, writeCustody }) => {
    const outcome = await runUnprovenTermination(writeCustody, "execution-a");
    assert.notEqual(outcome.custodyState, "released");

    const orphaned = await writeCustody.getWriteAccess(REPOSITORY_KEY);
    assert.ok(orphaned, "an unproven termination must retain durable custody");
    assert.equal(orphaned.state, "TERMINATING");
    assert.equal(orphaned.executionId, "execution-a");
    assert.ok(orphaned.claudeProcess, "the record must name the child it is waiting on");

    // The child is still running. Nothing has become provable, so the next
    // writer is still refused - availability is never bought with a guess.
    const blocked = await writerB(writeCustody, "execution-b");
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.error.code, "write_custody_conflict");
    assert.equal((await writeCustody.getWriteAccess(REPOSITORY_KEY)).state, "TERMINATING");
  });
});

test("once the exact child is provably gone the same session reclaims and admits writer B", async () => {
  await withCoordinator(async ({ world, writeCustody }) => {
    await runUnprovenTermination(writeCustody, "execution-a");
    const orphaned = await writeCustody.getWriteAccess(REPOSITORY_KEY);
    assert.equal(orphaned.state, "TERMINATING");

    // The ambiguity resolves: the exact supervised child dies.
    world.kill(CLAUDE_PID);

    // The next writer in the SAME coordinator - never restarted - re-observes
    // that exact identity, obtains its proof, and proceeds.
    const admitted = await writerB(writeCustody, "execution-b");
    assert.equal(admitted.status, "completed", JSON.stringify(admitted.error ?? null));
    assert.ok(world.inspections.includes(CLAUDE_PID), "the exact child identity must be re-observed");

    // Writer A's record is archived as a proven terminal release, not deleted
    // and not silently overwritten.
    assert.equal(await writeCustody.getWriteAccess(REPOSITORY_KEY), undefined);
  });
});

test("release rests on the observation, never on elapsed time", async () => {
  // A PID that is merely reused is still proof the original process is gone.
  await withCoordinator(async ({ world, writeCustody }) => {
    await runUnprovenTermination(writeCustody, "execution-a");
    world.reusePid(CLAUDE_PID);
    const reclaimed = await writeCustody.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: REPOSITORY_KEY
    });
    assert.equal(reclaimed.released, true);
    assert.equal(reclaimed.record.state, "RELEASED");
    assert.equal(reclaimed.record.terminalProof.kind, "same-coordinator-process-identity");
    assert.equal(reclaimed.record.terminalProof.claude, "pid-reused");
  });

  // An observation that cannot decide is not a proof, however long we wait.
  await withCoordinator(async ({ world, writeCustody }) => {
    await runUnprovenTermination(writeCustody, "execution-a");
    const ambiguous = custodyFor(await mkdtemp(path.join(os.tmpdir(), "unused-")), world);
    void ambiguous;
    world.inspect = async () => Object.freeze({
      status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
      reason: "query-failed"
    });
    const refused = await writeCustody.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: REPOSITORY_KEY
    });
    assert.equal(refused.released, false);
    assert.equal(refused.reason, "claude-not-proven-gone");
    assert.equal((await writeCustody.getWriteAccess(REPOSITORY_KEY)).state, "TERMINATING");
  });
});

test("the reclaim is pinned to its own execution, repository and revision", async () => {
  await withCoordinator(async ({ world, writeCustody }) => {
    await runUnprovenTermination(writeCustody, "execution-a");
    const orphaned = await writeCustody.getWriteAccess(REPOSITORY_KEY);
    world.kill(CLAUDE_PID);

    // A different execution is not this coordinator's orphan to settle.
    const foreign = await writeCustody.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-somebody-else",
      canonicalRootKey: REPOSITORY_KEY
    });
    assert.equal(foreign.released, false);
    assert.equal(foreign.reason, "not-own-orphan");

    // A revision other than the one observed is a different durable fact.
    await assert.rejects(
      writeCustody.reclaimOwnOrphanedWriteAccess({
        executionId: "execution-a",
        canonicalRootKey: REPOSITORY_KEY,
        expectedRevision: orphaned.revision + 5
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_settlement_scope_lost"
    );
    assert.equal((await writeCustody.getWriteAccess(REPOSITORY_KEY)).state, "TERMINATING");

    // The exact revision settles exactly that record.
    const reclaimed = await writeCustody.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: REPOSITORY_KEY,
      expectedRevision: orphaned.revision
    });
    assert.equal(reclaimed.released, true);
  });
});

test("a restarted or foreign coordinator cannot reclaim someone else's orphan this way", async () => {
  await withCoordinator(async ({ stateRoot, world, writeCustody }) => {
    await runUnprovenTermination(writeCustody, "execution-a");
    world.kill(CLAUDE_PID);

    // Same PID, but no in-memory supervision evidence: this stands for the
    // coordinator having restarted. The reclaim is refused, because the whole
    // basis for it is memory a restart does not have.
    const restarted = custodyFor(stateRoot, world);
    const refused = await restarted.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: REPOSITORY_KEY
    });
    assert.equal(refused.released, false);
    assert.equal(refused.reason, "not-supervised-by-this-coordinator");
    assert.equal((await restarted.getWriteAccess(REPOSITORY_KEY)).state, "TERMINATING");
  });
});

/**
 * Writer A whose forced termination launched a destructive taskkill helper
 * that outlived the termination bound. The request stays active so the
 * outcome orphans with the helper evidence attached - exactly what the real
 * unproven error carries.
 */
async function runUnprovenTaskkillTermination(writeCustody, executionId, { helperCloseProven }) {
  const helperIdentity = Object.freeze({
    pid: HELPER_PID,
    startTime: String(HELPER_PID * 100),
    source: "eventual-reclaim"
  });
  const outcome = await delegateAgent(
    {
      agentType: "task",
      task: "writer A whose taskkill helper outlived termination",
      cwd: WORKSPACE.effectiveCwd
    },
    dependencies(writeCustody, {
      executionId,
      runAgent: async ({ onChildStarted, onTerminationStarted }) => {
        const identity = claudeIdentity(executionId);
        await onChildStarted?.(identity, {});
        await onTerminationStarted?.(identity, {});
        throw Object.assign(new Error("forced termination could not be proven"), {
          code: "claude_termination_unproven",
          processStarted: true,
          processIdentity: identity,
          lateRecoveryAllowed: helperCloseProven,
          terminationResult: Object.freeze({
            status: "termination-unproven",
            method: "taskkill",
            taskkillLaunched: true,
            taskkillHelperQuiescenceProven: helperCloseProven,
            ...(helperCloseProven ? {} : { taskkillHelperIdentity: helperIdentity })
          })
        });
      }
    })
  );
  return { outcome, helperIdentity };
}

test("a launched taskkill helper keeps writer B blocked until the helper itself is proven gone", async () => {
  await withCoordinator(async ({ world, writeCustody }) => {
    const { outcome, helperIdentity } = await runUnprovenTaskkillTermination(writeCustody, "execution-a", {
      helperCloseProven: false
    });
    assert.equal(outcome.custodyState, "orphaned");

    // The orphan record names the launched helper and its durable identity so
    // a later observation - not elapsed time - can decide quiescence.
    const orphaned = await writeCustody.getWriteAccess(REPOSITORY_KEY);
    assert.equal(orphaned.state, "ORPHANED");
    assert.equal(orphaned.destructiveHelper?.launched, true);
    assert.equal(orphaned.destructiveHelper?.closeProven, false);
    assert.deepEqual(orphaned.destructiveHelper?.helper, { ...helperIdentity });

    // Claude dies but the helper is still running: a dead target alone must
    // never release custody while a destructive helper may still be acting.
    world.kill(CLAUDE_PID);
    const blocked = await writerB(writeCustody, "execution-b");
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.error.code, "write_custody_conflict");
    assert.equal((await writeCustody.getWriteAccess(REPOSITORY_KEY)).state, "ORPHANED");
    const refused = await writeCustody.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: REPOSITORY_KEY
    });
    assert.equal(refused.released, false);
    assert.equal(refused.reason, "destructive-helper-quiescence-unproven");

    // The helper itself dies: its durable identity is observed gone, so the
    // same session reclaims and writer B is admitted.
    world.kill(HELPER_PID);
    const admitted = await writerB(writeCustody, "execution-b");
    assert.equal(admitted.status, "completed", JSON.stringify(admitted.error ?? null));
    assert.ok(world.inspections.includes(HELPER_PID), "the helper identity must be re-observed, never assumed");
    assert.equal(await writeCustody.getWriteAccess(REPOSITORY_KEY), undefined);
  });
});

test("a launched helper without an observable identity can never quiesce", async () => {
  await withCoordinator(async ({ world, writeCustody }) => {
    const identity = claudeIdentity("execution-a");
    await delegateAgent(
      {
        agentType: "task",
        task: "writer A whose helper evidence was lost",
        cwd: WORKSPACE.effectiveCwd
      },
      dependencies(writeCustody, {
        executionId: "execution-a",
        runAgent: async ({ onChildStarted, onTerminationStarted }) => {
          await onChildStarted?.(identity, {});
          await onTerminationStarted?.(identity, {});
          throw Object.assign(new Error("forced termination could not be proven"), {
            code: "claude_termination_unproven",
            processStarted: true,
            processIdentity: identity,
            lateRecoveryAllowed: false,
            // Launched, unproven, and no durable identity to re-observe: the
            // evidence a reclaim would need does not exist.
            terminationResult: Object.freeze({
              status: "termination-unproven",
              method: "taskkill",
              taskkillLaunched: true,
              taskkillHelperQuiescenceProven: false
            })
          });
        }
      })
    );

    world.kill(CLAUDE_PID);
    const refused = await writeCustody.reclaimOwnOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: REPOSITORY_KEY
    });
    assert.equal(refused.released, false);
    assert.equal(refused.reason, "destructive-helper-evidence-unknown");
    const blocked = await writerB(writeCustody, "execution-b");
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.error.code, "write_custody_conflict");
    assert.equal((await writeCustody.getWriteAccess(REPOSITORY_KEY)).state, "ORPHANED");
  });
});

test("a helper proven closed before the orphan needs no later observation", async () => {
  await withCoordinator(async ({ world, writeCustody }) => {
    const { outcome } = await runUnprovenTaskkillTermination(writeCustody, "execution-a", {
      helperCloseProven: true
    });
    assert.equal(outcome.custodyState, "orphaned");

    // Even if the helper PID later becomes unobservable, the proven close
    // stands: quiescence was established, not inferred.
    world.inspect = async (pid) => {
      if (pid === HELPER_PID) {
        return Object.freeze({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-failed" });
      }
      const startTime = world.alive.get(pid);
      return Object.freeze(startTime === undefined
        ? { status: PROCESS_IDENTITY_STATUS.DEAD }
        : {
          status: PROCESS_IDENTITY_STATUS.ALIVE,
          identity: Object.freeze({ pid, startTime, source: "eventual-reclaim" })
        });
    };
    world.kill(CLAUDE_PID);
    const admitted = await writerB(writeCustody, "execution-b");
    assert.equal(admitted.status, "completed", JSON.stringify(admitted.error ?? null));
    assert.equal(await writeCustody.getWriteAccess(REPOSITORY_KEY), undefined);
  });
});
