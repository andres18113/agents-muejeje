import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { lstat as realLstat, readFile as realReadFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STABLE_READ_MAX_ATTEMPTS,
  ownershipDirectoryIn,
  readAuthoritativeRecord,
  readOwnershipSlot,
  repositoryStateDirectoryIn
} from "../src/custody/durable-store.mjs";
import { DurableWriteCustodyManager, WriteCustodyError } from "../src/write-custody.mjs";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";

/**
 * P1-4: a durable read that races a concurrent rename/archive must restart
 * its observation, not report the transient ENOENT as "free" or "ambiguous".
 *
 * exists ownership -> concurrent rename/archive -> read ownership -> ENOENT
 *
 * is a real interleaving on Windows (and, as a TOCTOU, on every platform).
 * The stable reader below answers it with a coherent snapshot: absence counts
 * only when stable across two probes, a record counts only when two full
 * reads agree byte for byte, a stably invalid record is ambiguous at once,
 * and a slot that keeps changing past a bounded number of attempts is
 * ambiguous rather than retried without limit.
 */

const rootA = "C:\\workspace\\read-stability";
const rootAKey = rootA.toLowerCase();
const identitySource = "read-stability";

function enoent(pathname) {
  return Object.assign(new Error("ENOENT: no such file or directory, lstat '" + pathname + "'"), {
    code: "ENOENT"
  });
}

function dirStat() {
  return { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false, size: 4096 };
}

function fileStat(size) {
  return { isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true, size };
}

function live(pid, startTime) {
  return Object.freeze({
    status: PROCESS_IDENTITY_STATUS.ALIVE,
    identity: Object.freeze({ pid, startTime, source: identitySource })
  });
}

/**
 * A virtual ownership slot whose presence and bytes mutate on scripted calls,
 * so a concurrent rename/archive landing between two specific filesystem
 * calls is deterministic rather than a matter of scheduling luck. Hooks fire
 * before serving their numbered call (counted across lstat and read calls in
 * serving order).
 */
function flappingSlot({ present = true, bytes = "", hooks = [] } = {}) {
  const world = {
    present,
    bytes,
    lstatCalls: 0,
    readCalls: 0,
    calls: 0,
    async lstatFn(pathname) {
      world.calls += 1;
      for (const hook of hooks) {
        if (hook.atCall === world.calls) hook.apply(world);
      }
      world.lstatCalls += 1;
      if (!world.present) throw enoent(pathname);
      return String(pathname).endsWith("record.json") ? fileStat(Buffer.byteLength(world.bytes)) : dirStat();
    },
    async readFileFn(pathname) {
      world.calls += 1;
      for (const hook of hooks) {
        if (hook.atCall === world.calls) hook.apply(world);
      }
      world.readCalls += 1;
      if (!world.present || !String(pathname).endsWith("record.json")) throw enoent(pathname);
      return world.bytes;
    }
  };
  return world;
}

async function withState(callback) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-read-stability-"));
  try {
    await callback(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function managerFor(stateRoot, observations, currentPid, options = {}) {
  return new DurableWriteCustodyManager({
    stateRoot,
    inspectProcess: async (pid) => observations.get(pid) || Object.freeze({
      status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
      reason: "read-stability-test"
    }),
    currentPid,
    now: () => 1_000,
    ...options
  });
}

/** Seeds a real RESERVED record and returns its exact on-disk bytes. */
async function seedReservedBytes(stateRoot) {
  const custody = managerFor(stateRoot, new Map([[100, live(100, "10000")]]), 100);
  await custody.reserveWriteAccess({
    executionId: "execution-a",
    agentType: "task",
    canonicalRoot: rootA,
    canonicalRootKey: rootAKey
  });
  const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
  return await readFile(path.join(slotDir, "record.json"), "utf8");
}

/** Seeds a real record at two consecutive revisions and returns both byte strings. */
async function seedTwoRevisions(stateRoot) {
  const custody = managerFor(stateRoot, new Map([[100, live(100, "10000")]]), 100);
  await custody.reserveWriteAccess({
    executionId: "execution-a",
    agentType: "task",
    canonicalRoot: rootA,
    canonicalRootKey: rootAKey
  });
  const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
  const recordPath = path.join(slotDir, "record.json");
  const rev0 = await readFile(recordPath, "utf8");
  await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
  const rev1 = await readFile(recordPath, "utf8");
  assert.notEqual(rev1, rev0, "the two seeded revisions must differ at byte level");
  return { rev0, rev1, slotDir };
}

test("the legacy single-shot read still maps a racing vanish to ambiguous", async () => {
  await withState(async (stateRoot) => {
    // This pins why the slot reader exists: a single exists-then-read (or a
    // single direct read) cannot tell a concurrent handoff from a broken
    // store, so it must answer ambiguous. The stable reader above is the
    // primitive that restarts the observation instead.
    const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
    await assert.rejects(
      readAuthoritativeRecord(slotDir),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
    const stable = await readOwnershipSlot(slotDir, { lstatFn: realLstat, readFileFn: realReadFile });
    assert.equal(stable.found, false, "stable absence on a settled slot is free");
  });
});

test("exists, then a concurrent archive, then read resolves to free rather than ambiguous", async () => {
  await withState(async (stateRoot) => {
    const bytes = await seedReservedBytes(stateRoot);
    const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
    // The probe sees the slot; the archive lands before the directory read;
    // the observation restarts and confirms stable absence.
    const world = flappingSlot({
      present: true,
      bytes,
      hooks: [{ atCall: 2, apply: (slot) => { slot.present = false; } }]
    });
    const slot = await readOwnershipSlot(slotDir, world);
    assert.equal(slot.found, false);
    assert.equal(world.readCalls, 0, "a vanished slot is never read, only re-probed");
  });
});

test("a record replaced mid-read restarts and returns the stable revision", async () => {
  await withState(async (stateRoot) => {
    const { rev0, rev1, slotDir } = await seedTwoRevisions(stateRoot);
    // First read observes rev0; the publication lands before the confirm
    // read; the observation restarts and settles on rev1 twice in a row.
    // Calls: probe, dir, record, read#1, confirm-dir, confirm-record,
    // confirm-read. The hook fires before the confirm phase starts.
    const world = flappingSlot({
      present: true,
      bytes: rev0,
      hooks: [{ atCall: 5, apply: (slot) => { slot.bytes = rev1; } }]
    });
    const slot = await readOwnershipSlot(slotDir, world);
    assert.equal(slot.found, true);
    assert.equal(slot.record.revision, 1);
    assert.equal(world.readCalls, 4, "exactly one restart: two attempts of two reads");
  });
});

test("a slot that vanishes and reappears restarts instead of reporting free", async () => {
  await withState(async (stateRoot) => {
    const bytes = await seedReservedBytes(stateRoot);
    const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
    // Attempt 1 probes present but the directory read finds nothing; attempt
    // 2 probes absent but the confirm probe finds it again; attempt 3 reads
    // it stably. ENOENT never maps directly to free.
    const world = flappingSlot({
      present: true,
      bytes,
      hooks: [
        { atCall: 2, apply: (slot) => { slot.present = false; } },
        { atCall: 4, apply: (slot) => { slot.present = true; } }
      ]
    });
    const slot = await readOwnershipSlot(slotDir, world);
    assert.equal(slot.found, true);
    assert.equal(slot.record.state, "RESERVED");
    assert.equal(world.readCalls, 2, "only the settled attempt performs full reads");
  });
});

test("a slot that never settles reports ambiguous after a bounded number of attempts", async () => {
  await withState(async (stateRoot) => {
    const { rev0, rev1, slotDir } = await seedTwoRevisions(stateRoot);
    let reads = 0;
    const readFileFn = async (pathname) => {
      reads += 1;
      // Every confirm disagrees with its first read, forever.
      return reads % 2 === 1 ? rev0 : rev1;
    };
    await assert.rejects(
      readOwnershipSlot(slotDir, { lstatFn: realLstat, readFileFn }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
    assert.equal(
      reads,
      2 * STABLE_READ_MAX_ATTEMPTS,
      "two reads per attempt, then the bound - never retried without limit"
    );
  });
});

test("a stably invalid record is ambiguous immediately, without any retry", async () => {
  await withState(async (stateRoot) => {
    const bytes = await seedReservedBytes(stateRoot);
    const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
    for (const invalid of ["{not json", JSON.stringify({ ...JSON.parse(bytes), state: "BOGUS" })]) {
      const world = flappingSlot({ present: true, bytes: invalid });
      await assert.rejects(
        readOwnershipSlot(slotDir, world),
        (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
      );
      assert.equal(world.readCalls, 1, "stable malformation is never re-read: " + invalid.slice(0, 24));
    }
  });
});

test("a cancelled stable read reports cancellation rather than a slot verdict", async () => {
  await withState(async (stateRoot) => {
    const bytes = await seedReservedBytes(stateRoot);
    const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      readOwnershipSlot(slotDir, {
        lstatFn: realLstat,
        readFileFn: realReadFile,
        mutationSignal: controller.signal
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_mutation_cancelled"
    );
  });
});

test("reconciliation survives a read racing an archive and reports free", async () => {
  await withState(async (stateRoot) => {
    const bytes = await seedReservedBytes(stateRoot);
    // No record is live in this state root for the reconciling manager: the
    // virtual slot starts present and is archived away mid-observation.
    const world = flappingSlot({
      present: true,
      bytes,
      hooks: [{ atCall: 2, apply: (slot) => { slot.present = false; } }]
    });
    const custody = managerFor(stateRoot, new Map([[300, live(300, "30000")]]), 300, {
      lstatFn: world.lstatFn,
      readFileFn: world.readFileFn
    });
    // The seed above left a real record behind; remove the whole repository
    // state so the only observation is the virtual race.
    await rm(repositoryStateDirectoryIn(stateRoot, rootAKey), { recursive: true, force: true });
    const reconciliation = await custody.reconcileExistingOwnership(rootAKey);
    assert.equal(reconciliation.released, true);
    assert.equal(reconciliation.reason, "free");
  });
});

test("a publish racing an archive reports stale rather than ambiguous", async () => {
  await withState(async (stateRoot) => {
    const { EventEmitter } = await import("node:events");
    // Reads serve the real filesystem until the scripted archive lands; the
    // owned-record read then succeeds while the compare step finds the slot
    // stably gone.
    const world = { present: true, flipOnPublish: false };
    const custody = managerFor(
      stateRoot,
      new Map([[100, live(100, "10000")], [200, live(200, "20000")]]),
      100,
      {
        lstatFn: async (pathname) => {
          if (!world.present) throw enoent(pathname);
          return await realLstat(pathname);
        },
        readFileFn: async (pathname, encoding) => {
          if (!world.present) throw enoent(pathname);
          return await realReadFile(pathname, encoding);
        },
        beforePublish: async () => {
          if (world.flipOnPublish) world.present = false;
        }
      }
    );
    const child = new EventEmitter();
    child.pid = 200;
    const identity = Object.freeze({
      executionId: "execution-a",
      agentType: "task",
      repositoryRoot: rootA,
      pid: 200,
      startTime: "20000",
      source: identitySource,
      child,
      startedAt: 1_100
    });
    await custody.reserveWriteAccess({
      executionId: "execution-a",
      agentType: "task",
      canonicalRoot: rootA,
      canonicalRootKey: rootAKey
    });
    await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    await custody.activateWriteAccess({ executionId: "execution-a", canonicalRootKey: rootAKey, processIdentity: identity });
    const slotDir = ownershipDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey));
    const currentBytes = await readFile(path.join(slotDir, "record.json"), "utf8");

    // The archive lands after the next record is durable but before the
    // compare step, via the documented seam.
    world.flipOnPublish = true;
    await assert.rejects(
      custody.beginTermination({ executionId: "execution-a", canonicalRootKey: rootAKey, processIdentity: identity }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_stale_mutation"
    );
    // Nothing published: the on-disk record is byte-identical.
    assert.equal(await readFile(path.join(slotDir, "record.json"), "utf8"), currentBytes);
  });
});

test("repeated single-flap reads all settle instead of leaking retries", async () => {
  await withState(async (stateRoot) => {
    const { rev0, rev1, slotDir } = await seedTwoRevisions(stateRoot);
    // Fifty sequential reads where the first confirm of each read disagrees
    // exactly once: every one must restart once and then settle, proving the
    // bounded loop neither gives up early nor accumulates state.
    for (let round = 0; round < 50; round += 1) {
      let reads = 0;
      const readFileFn = async () => {
        reads += 1;
        return reads === 2 ? rev1 : rev0;
      };
      const world = flappingSlot({ present: true, bytes: rev0 });
      const slot = await readOwnershipSlot(slotDir, {
        lstatFn: world.lstatFn,
        readFileFn
      });
      assert.equal(slot.found, true);
      assert.equal(slot.record.revision, 0);
      assert.equal(reads, 4, "round " + round + ": one restart, then stable");
    }
  });
});

test("concurrent readers and publishers settle with schema-valid observations", async () => {
  await withState(async (stateRoot) => {
    // Two live coordinators on one state root: only across managers can a
    // publication rename land inside another coordinator's read, which is
    // the interleaving under test. One manager would serialize everything
    // through its own mutation queue and prove nothing.
    const publisherCustody = managerFor(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    const readerCustody = managerFor(stateRoot, new Map([[300, live(300, "30000")]]), 300);
    await publisherCustody.reserveWriteAccess({
      executionId: "execution-a",
      agentType: "task",
      canonicalRoot: rootA,
      canonicalRootKey: rootAKey
    });
    await publisherCustody.beginWorktreePreparation({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      baseCommit: "a".repeat(40),
      worktreeRoot: stateRoot
    });

    const gitOperation = (pid) => ({ kind: "worktree-add", pid, startTime: String(pid * 100), source: identitySource });
    const publisher = (async () => {
      for (let round = 0; round < 30; round += 1) {
        await publisherCustody.recordWorktreeOperation({
          executionId: "execution-a",
          canonicalRootKey: rootAKey,
          gitOperation: gitOperation(500 + (round % 7))
        });
        await publisherCustody.clearWorktreeOperation({ executionId: "execution-a", canonicalRootKey: rootAKey });
      }
    })();
    const readOutcomes = [];
    const readers = Array.from({ length: 4 }, async (_, reader) => {
      for (let round = 0; round < 40; round += 1) {
        try {
          const snapshot = await readerCustody.getWriteAccess(rootAKey);
          assert.ok(
            snapshot === undefined || snapshot.executionId === "execution-a",
            "reader " + reader + " round " + round + ": only the live record or free"
          );
          readOutcomes.push("read");
        } catch (error) {
          // Under genuine sustained churn the bounded read may legitimately
          // refuse; anything else - a crash, a malformed record, a hang -
          // fails the test.
          assert.ok(
            error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous",
            "reader " + reader + " round " + round + ": only bounded-read ambiguity is tolerable"
          );
          readOutcomes.push("ambiguous");
        }
      }
    });
    await Promise.all([publisher, ...readers]);
    assert.equal(readOutcomes.length, 160);
    const final = await readerCustody.getWriteAccess(rootAKey);
    assert.equal(final.executionId, "execution-a");
    assert.equal(final.gitOperation, undefined, "the publisher left no operation behind");
  });
});
