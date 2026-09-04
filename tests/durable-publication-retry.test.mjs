import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rename as realRename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";
import { createRequestDeadlineContext } from "../src/request-context.mjs";
import {
  archiveOwnership,
  executionHistoryDirectoryIn,
  repositoryStateDirectoryIn
} from "../src/custody/durable-store.mjs";
import {
  DurableWriteCustodyManager,
  WINDOWS_TRANSIENT_RENAME_CODES,
  WriteCustodyError,
  createAdmissionPublicationFence,
  createPublicationRetryPolicy,
  repositoryIdForCanonicalRootKey
} from "../src/write-custody.mjs";

/**
 * A Windows host can reject an already-issued publication rename with a sharing
 * violation while some other process momentarily holds the destination open.
 * MoveFileExW is synchronous, so that rejection settles the attempt: nothing
 * moved, and nothing can land afterwards. Treating it as terminal destroyed
 * healthy delegations; treating it as a licence to rename again would be far
 * worse, because a second rename issued on the first attempt's authority could
 * overwrite state that changed in between.
 *
 * These tests pin the only safe reading. A retry is a whole new authorized
 * publication - fresh observation, revalidated authority, rechecked
 * cancellation - and everything that fails closed today still fails closed the
 * first time it happens.
 */

const rootA = "C:\\workspace\\retry-root-a";
const rootAKey = rootA.toLowerCase();
const source = "publication-retry-test";

function live(pid, startTime = String(pid * 100)) {
  return Object.freeze({
    status: PROCESS_IDENTITY_STATUS.ALIVE,
    identity: Object.freeze({ pid, startTime, source })
  });
}

function childIdentity({ executionId = "execution-a", pid = 200, startTime = "20000" } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  return Object.freeze({
    executionId,
    agentType: "task",
    repositoryRoot: rootA,
    pid,
    startTime,
    source,
    child,
    startedAt: 1_100
  });
}

function terminalProof(identity, observedAt = 1_200) {
  return Object.freeze({ processIdentity: identity, event: "close", code: 0, signal: null, observedAt });
}

async function withState(callback) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-retry-"));
  try {
    await callback(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** A scheduler that only fires when the test says so, so a backoff can be held open. */
function heldScheduler() {
  const pending = new Map();
  let nextId = 1;
  return {
    schedule(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelSchedule(id) {
      pending.delete(id);
    },
    pendingCount: () => pending.size
  };
}

/** The retry policy under test, forced onto the Windows domain and given no real delay. */
function testPolicy(overrides = {}) {
  return createPublicationRetryPolicy({
    platform: "win32",
    backoffMs: [0],
    ...overrides
  });
}

/**
 * A rename seam that rejects the way Windows does - same errno, same syscall -
 * for the first `failures` attempts against a matching destination.
 */
function transientRename({ failures = Infinity, code = "EPERM", match = () => true, onFailure } = {}) {
  const state = { matched: 0, total: 0 };
  const seam = async (from, to) => {
    state.total += 1;
    if (!match(String(to))) return await realRename(from, to);
    state.matched += 1;
    if (state.matched > failures) return await realRename(from, to);
    if (onFailure) await onFailure(state.matched, { from, to });
    const error = new Error(code + ": operation not permitted, rename '" + from + "' -> '" + to + "'");
    error.code = code;
    error.syscall = "rename";
    error.errno = -4048;
    error.path = String(from);
    error.dest = String(to);
    throw error;
  };
  seam.state = state;
  return seam;
}

const isRecordPublication = (to) => to.endsWith(path.join("ownership", "record.json"));
const isAdmission = (to) => to.endsWith(path.sep + "ownership");
const isArchive = (to) => to.includes(path.sep + "executions" + path.sep);

function manager(stateRoot, options = {}) {
  return new DurableWriteCustodyManager({
    stateRoot,
    currentPid: 100,
    inspectProcess: async (pid) => (pid === 100 ? live(100, "10000") : live(pid)),
    now: options.now || (() => 1_000),
    renamePath: options.renamePath,
    retryPolicy: options.retryPolicy,
    afterPublicationIssued: options.afterPublicationIssued
  });
}

async function reserve(custody, { executionId = "execution-a", admissionFence, mutationSignal } = {}) {
  return await custody.reserveWriteAccess({
    executionId,
    agentType: "task",
    canonicalRoot: rootA,
    canonicalRootKey: rootAKey,
    ...(admissionFence ? { admissionFence } : {}),
    ...(mutationSignal ? { mutationSignal } : {})
  });
}

async function activate(custody, identity, options = {}) {
  await custody.markSpawning({ executionId: identity.executionId, canonicalRootKey: rootAKey });
  return await custody.activateWriteAccess({
    executionId: identity.executionId,
    canonicalRootKey: rootAKey,
    processIdentity: identity,
    ...options
  });
}

function ownershipRecordPath(stateRoot) {
  return path.join(
    stateRoot,
    "repositories",
    repositoryIdForCanonicalRootKey(rootAKey),
    "ownership",
    "record.json"
  );
}

/** Replaces the authoritative record so the next attempt provably loses its CAS. */
async function displaceAuthority(stateRoot, mutate) {
  const recordPath = ownershipRecordPath(stateRoot);
  const current = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, JSON.stringify(mutate(current), null, 2) + "\n", "utf8");
}

test("the retryable domain is exactly the Windows transient rename codes", () => {
  assert.deepEqual([...WINDOWS_TRANSIENT_RENAME_CODES], ["EPERM", "EACCES", "EBUSY"]);
  const windows = testPolicy();
  for (const code of WINDOWS_TRANSIENT_RENAME_CODES) {
    assert.equal(
      windows.isTransientPublicationFailure(Object.assign(new Error(code), { code, syscall: "rename" })),
      true,
      code
    );
  }
  // A matching errno raised by any other syscall is a real fault, not a
  // publication conflict, and must never be absorbed.
  assert.equal(
    windows.isTransientPublicationFailure(Object.assign(new Error("open"), { code: "EPERM", syscall: "open" })),
    false
  );
  for (const code of ["ENOENT", "ENOSPC", "EIO", "EROFS", "ENOTDIR", "EEXIST"]) {
    assert.equal(
      windows.isTransientPublicationFailure(Object.assign(new Error(code), { code, syscall: "rename" })),
      false,
      code
    );
  }
  // A custody decision is never a host condition.
  assert.equal(
    windows.isTransientPublicationFailure(new WriteCustodyError("stale", { code: "write_custody_stale_mutation" })),
    false
  );
  // Off Windows the policy is one attempt, so the retry path does not exist.
  assert.equal(createPublicationRetryPolicy({ platform: "linux" }).maxAttempts, 1);
  assert.ok(testPolicy().maxAttempts > 1);
});

test("a transient publication rejection is retried and advances the record exactly once", async () => {
  await withState(async (stateRoot) => {
    const renamePath = transientRename({ failures: 2, match: isRecordPublication });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    const identity = childIdentity();
    await reserve(custody);

    const activated = await activate(custody, identity);
    assert.equal(activated.state, "ACTIVE");
    // markSpawning published once and activation published once, each retried.
    assert.equal(activated.revision, 2);
    assert.deepEqual(activated.transitions.map((t) => t.state), ["RESERVED", "SPAWNING", "ACTIVE"]);

    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.state, "ACTIVE");
    assert.equal(authoritative.revision, 2);
    assert.deepEqual(authoritative.transitions.map((t) => t.state), ["RESERVED", "SPAWNING", "ACTIVE"]);
  });
});

test("every transient rename code is retried, and a non-transient one is fatal at once", async () => {
  for (const code of WINDOWS_TRANSIENT_RENAME_CODES) {
    await withState(async (stateRoot) => {
      const renamePath = transientRename({ failures: 1, code, match: isRecordPublication });
      const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
      await reserve(custody);
      const spawning = await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
      assert.equal(spawning.state, "SPAWNING", code);
      assert.equal(renamePath.state.matched, 2, code);
    });
  }
  await withState(async (stateRoot) => {
    const renamePath = transientRename({ failures: 1, code: "EIO", match: isRecordPublication });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    await reserve(custody);
    await assert.rejects(
      custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_persist_failed"
    );
    // One attempt only: a real IO fault is never tried again.
    assert.equal(renamePath.state.matched, 1);
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("a persistently rejected publication exhausts its bound and leaves durable state untouched", async () => {
  await withState(async (stateRoot) => {
    // Only the activation publication is rejected, so the bound observed below
    // belongs to exactly one mutation.
    let rejecting = false;
    const renamePath = transientRename({
      match: (to) => rejecting && isRecordPublication(to)
    });
    const policy = testPolicy();
    const custody = manager(stateRoot, { renamePath, retryPolicy: policy });
    await reserve(custody);
    const identity = childIdentity();
    await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    const beforeState = await custody.getWriteAccess(rootAKey);
    rejecting = true;

    await assert.rejects(
      custody.activateWriteAccess({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        processIdentity: identity
      }),
      (error) => {
        assert.ok(error instanceof WriteCustodyError);
        assert.equal(error.code, "write_custody_publication_retry_exhausted");
        assert.equal(error.cause?.code, "EPERM");
        return true;
      }
    );
    assert.equal(renamePath.state.matched, policy.maxAttempts, "the bound is honoured exactly");

    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.state, "SPAWNING");
    assert.equal(authoritative.revision, beforeState.revision);
    assert.deepEqual(authoritative.transitions.map((t) => t.state), ["RESERVED", "SPAWNING"]);
  });
});

test("a record that moves between attempts loses its compare-and-set instead of overwriting", async () => {
  await withState(async (stateRoot) => {
    const renamePath = transientRename({
      failures: 1,
      match: isRecordPublication,
      // The slot advances under us while the first attempt is settling failed.
      onFailure: async () => {
        await displaceAuthority(stateRoot, (record) => ({ ...record, revision: record.revision + 5 }));
      }
    });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    await reserve(custody);

    await assert.rejects(
      custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_stale_mutation"
    );
    // The retry re-read, saw different authority, and refused before renaming.
    assert.equal(renamePath.state.matched, 1);
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.state, "RESERVED");
    assert.equal(authoritative.revision, 5);
  });
});

test("a foreign owner appearing between attempts is refused, never replaced", async () => {
  await withState(async (stateRoot) => {
    const renamePath = transientRename({
      failures: 1,
      match: isRecordPublication,
      onFailure: async () => {
        await displaceAuthority(stateRoot, (record) => ({ ...record, executionId: "execution-foreign" }));
      }
    });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    await reserve(custody);

    await assert.rejects(
      custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_owner_mismatch"
    );
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-foreign");
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("cancellation during a backoff issues no further rename", async () => {
  await withState(async (stateRoot) => {
    const scheduler = heldScheduler();
    const failed = deferred();
    const renamePath = transientRename({
      match: isRecordPublication,
      onFailure: async () => failed.resolve()
    });
    const custody = manager(stateRoot, {
      renamePath,
      retryPolicy: testPolicy({ backoffMs: [60_000], schedule: scheduler.schedule, cancelSchedule: scheduler.cancelSchedule })
    });
    await reserve(custody);

    const controller = new AbortController();
    const spawning = custody.markSpawning({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      mutationSignal: controller.signal
    });
    await failed.promise;
    controller.abort();

    await assert.rejects(
      spawning,
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_mutation_cancelled"
    );
    assert.equal(renamePath.state.matched, 1, "a cancelled backoff must not reach another rename");
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("a root deadline expiring during a backoff issues no further rename", async () => {
  await withState(async (stateRoot) => {
    // The root request delivers cancellation and deadline expiry through one
    // signal, so this drives the real deadline path rather than a second clock.
    let time = 0;
    const timers = new Map();
    let nextTimer = 1;
    const clock = {
      now: () => time,
      schedule(callback, delay) {
        const id = nextTimer++;
        timers.set(id, { at: time + Math.max(0, delay), callback });
        return id;
      },
      cancel: (id) => timers.delete(id),
      advanceTo(target) {
        time = target;
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at <= time) {
            timers.delete(id);
            timer.callback();
          }
        }
      }
    };
    const requestContext = createRequestDeadlineContext({
      deadlineAt: 100,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel
    });

    const scheduler = heldScheduler();
    const failed = deferred();
    const renamePath = transientRename({
      match: isRecordPublication,
      onFailure: async () => failed.resolve()
    });
    const custody = manager(stateRoot, {
      renamePath,
      retryPolicy: testPolicy({ backoffMs: [60_000], schedule: scheduler.schedule, cancelSchedule: scheduler.cancelSchedule })
    });
    await reserve(custody);

    const spawning = custody.markSpawning({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      mutationSignal: requestContext.abortSignal
    });
    await failed.promise;
    clock.advanceTo(100);

    await assert.rejects(
      spawning,
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_mutation_cancelled"
    );
    assert.equal(requestContext.abortSignal.aborted, true);
    assert.equal(renamePath.state.matched, 1, "an expired deadline must not reach another rename");
    requestContext.dispose();
  });
});

test("an exhausted admission reports a settled failure, not an unresolved publication", async () => {
  await withState(async (stateRoot) => {
    const renamePath = transientRename({ match: isAdmission });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    const admissionFence = createAdmissionPublicationFence();

    await assert.rejects(
      reserve(custody, { admissionFence }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_publication_retry_exhausted"
    );
    // The boundary was crossed, so the fence says so - but every attempt was an
    // issued rename the host rejected outright, which is a settled failure. A
    // caller must be able to conclude "no custody" rather than "unknown".
    assert.equal(admissionFence.publicationStarted(), true);
    assert.equal(admissionFence.disposition(), "failed");
    assert.equal(admissionFence.publishedRecord(), undefined);
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);

    // The mutation queue was handed back, so an ordinary admission still works.
    const recovered = manager(stateRoot);
    const admitted = await reserve(recovered, { executionId: "execution-b" });
    assert.equal(admitted.executionId, "execution-b");
  });
});

test("a transiently rejected admission retries while the slot is still free", async () => {
  await withState(async (stateRoot) => {
    const renamePath = transientRename({ failures: 2, match: isAdmission });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    const admissionFence = createAdmissionPublicationFence();

    const admitted = await reserve(custody, { admissionFence });
    assert.equal(admitted.executionId, "execution-a");
    assert.equal(admitted.state, "RESERVED");
    assert.equal(admissionFence.disposition(), "published");
    assert.equal(renamePath.state.matched, 3);
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-a");
  });
});

test("an admission that finds a competitor after a rejection conflicts and never overwrites", async () => {
  await withState(async (stateRoot) => {
    const competitor = manager(stateRoot);
    const renamePath = transientRename({
      failures: 1,
      match: isAdmission,
      // Windows reports "the slot is taken" and "the slot is momentarily held"
      // with the same errno, so the observation after the rejection - not the
      // errno - has to decide. Here a real competitor takes the slot.
      onFailure: async () => {
        await reserve(competitor, { executionId: "execution-competitor" });
      }
    });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });

    await assert.rejects(
      reserve(custody, { executionId: "execution-a" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_conflict"
    );
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-competitor");
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("a transiently rejected archive retries, and refuses if the record moved meanwhile", async () => {
  // Terminal release archives inline, so the archive rename under test is the
  // one issued by releaseWriteAccessAfterTerminal.
  await withState(async (stateRoot) => {
    const renamePath = transientRename({ failures: 2, match: isArchive });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    const released = await custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity)
    });
    assert.equal(released.state, "RELEASED");
    assert.equal(renamePath.state.matched, 3);
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);
    const archived = JSON.parse(await readFile(
      path.join(executionHistoryDirectoryIn(repositoryStateDirectoryIn(stateRoot, rootAKey), "execution-a"), "record.json"),
      "utf8"
    ));
    assert.equal(archived.state, "RELEASED");
  });

  await withState(async (stateRoot) => {
    const renamePath = transientRename({
      failures: 1,
      match: isArchive,
      onFailure: async () => {
        await displaceAuthority(stateRoot, (record) => ({ ...record, revision: record.revision + 5 }));
      }
    });
    const custody = manager(stateRoot, { renamePath, retryPolicy: testPolicy() });
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    await assert.rejects(
      custody.releaseWriteAccessAfterTerminal({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: terminalProof(identity)
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_stale_mutation"
    );
    assert.equal(renamePath.state.matched, 1, "the retry refused before issuing a second rename");
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.state, "RELEASED");
  });
});

test("an occupied archive destination is idempotent only on exact evidence", async () => {
  const releasedFixture = async (stateRoot) => {
    const custody = manager(stateRoot);
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);
    const released = await custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity)
    });
    return { released, repositoryState: repositoryStateDirectoryIn(stateRoot, rootAKey) };
  };

  // Exact match: the destination holds precisely this released record and the
  // ownership slot is genuinely gone, so a repeated archive is complete.
  await withState(async (stateRoot) => {
    const { released, repositoryState } = await releasedFixture(stateRoot);
    const again = await archiveOwnership({ repositoryState, record: released });
    assert.equal(again.state, "RELEASED");
    assert.equal(again.executionId, "execution-a");
    assert.equal(again.revision, released.revision);
  });

  // Mismatch: the path is occupied by something that is not this record. An
  // occupied destination is not evidence of identity, so this fails closed.
  await withState(async (stateRoot) => {
    const { released, repositoryState } = await releasedFixture(stateRoot);
    const history = executionHistoryDirectoryIn(repositoryState, "execution-a");
    const archived = JSON.parse(await readFile(path.join(history, "record.json"), "utf8"));
    await writeFile(
      path.join(history, "record.json"),
      JSON.stringify({ ...archived, revision: archived.revision + 9 }, null, 2) + "\n",
      "utf8"
    );

    await assert.rejects(
      archiveOwnership({ repositoryState, record: released }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
  });

  // Occupied destination while the ownership slot still exists is ambiguous
  // regardless of what the destination contains.
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot);
    const identity = childIdentity();
    await reserve(custody);
    const spawning = await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    const repositoryState = repositoryStateDirectoryIn(stateRoot, rootAKey);
    const history = executionHistoryDirectoryIn(repositoryState, "execution-a");
    await mkdir(history, { recursive: true });
    await writeFile(path.join(history, "record.json"), JSON.stringify(spawning, null, 2) + "\n", "utf8");

    await assert.rejects(
      archiveOwnership({ repositoryState, record: spawning }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
    assert.equal((await custody.getWriteAccess(rootAKey)).state, "SPAWNING");
    void identity;
  });
});

test("real Windows publication survives repeated lifecycles on the real filesystem", { skip: process.platform !== "win32" ? "Windows publication path" : false }, async () => {
  await withState(async (stateRoot) => {
    // No injected rename and no injected policy: this is the production path,
    // exercised hard enough that a host that intermittently holds a destination
    // open has ample opportunity to reject one of these publications.
    const repositories = Array.from({ length: 4 }, (_, index) => {
      const root = "C:\\workspace\\retry-stress-" + index;
      return { root, key: root.toLowerCase() };
    });
    let completed = 0;
    for (let round = 0; round < 12; round += 1) {
      await Promise.all(repositories.map(async (repository, index) => {
        const custody = new DurableWriteCustodyManager({
          stateRoot,
          currentPid: 100,
          inspectProcess: async (pid) => (pid === 100 ? live(100, "10000") : live(pid)),
          now: () => 1_000 + round
        });
        const executionId = "stress-" + round + "-" + index;
        const child = new EventEmitter();
        child.pid = 30_000 + round * 10 + index;
        const identity = Object.freeze({
          executionId,
          agentType: "task",
          repositoryRoot: repository.root,
          pid: child.pid,
          startTime: String(child.pid * 100),
          source,
          child,
          startedAt: 1_100
        });
        await custody.reserveWriteAccess({
          executionId,
          agentType: "task",
          canonicalRoot: repository.root,
          canonicalRootKey: repository.key
        });
        await custody.markSpawning({ executionId, canonicalRootKey: repository.key });
        await custody.activateWriteAccess({
          executionId,
          canonicalRootKey: repository.key,
          processIdentity: identity
        });
        await custody.releaseWriteAccessAfterTerminal({
          executionId,
          canonicalRootKey: repository.key,
          terminalProof: terminalProof(identity, 1_200 + round)
        });
        const reconciled = await custody.reconcileExistingOwnership(repository.key);
        assert.equal(reconciled.released, true, executionId);
        completed += 1;
      }));
    }
    assert.equal(completed, 48);
  });
});
