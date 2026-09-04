import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";
import {
  DurableWriteCustodyManager,
  WriteCustodyError,
  createAdmissionPublicationFence
} from "../src/write-custody.mjs";

const rootA = "C:\\workspace\\root-a";
const rootAKey = rootA.toLowerCase();
const rootB = "C:\\workspace\\root-b";
const rootBKey = rootB.toLowerCase();
const source = "test-process-start";
const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function durableIdentity(pid, startTime = String(pid * 100)) {
  return Object.freeze({ pid, startTime, source });
}

function live(pid, startTime) {
  return Object.freeze({
    status: PROCESS_IDENTITY_STATUS.ALIVE,
    identity: durableIdentity(pid, startTime)
  });
}

function dead() {
  return Object.freeze({ status: PROCESS_IDENTITY_STATUS.DEAD });
}

function ambiguous() {
  return Object.freeze({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "test-ambiguous" });
}

function inspector(observations) {
  return async (pid) => observations.get(pid) || ambiguous();
}

function manager(stateRoot, observations, currentPid, options = {}) {
  return new DurableWriteCustodyManager({
    stateRoot,
    inspectProcess: inspector(observations),
    currentPid,
    now: options.now || (() => 1_000),
    createNonce: options.createNonce,
    beforePublish: options.beforePublish,
    afterPublicationIssued: options.afterPublicationIssued
  });
}

function childIdentity({
  executionId = "execution-a",
  agentType = "task",
  repositoryRoot = rootA,
  pid = 200,
  startTime = "20000",
  child = new EventEmitter(),
  startedAt = 1_100
} = {}) {
  child.pid = pid;
  return Object.freeze({
    executionId,
    agentType,
    // In-memory process identity names the repository root; the durable record
    // persists the same value under its canonicalRoot schema field.
    repositoryRoot,
    pid,
    startTime,
    source,
    child,
    startedAt
  });
}

function terminalProof(identity, observedAt = 1_200) {
  return Object.freeze({
    processIdentity: identity,
    event: "close",
    code: 0,
    signal: null,
    observedAt
  });
}

async function withState(callback) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-custody-"));
  try {
    await callback(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function reserve(custody, {
  executionId = "execution-a",
  agentType = "task",
  canonicalRoot = rootA,
  canonicalRootKey = rootAKey
} = {}) {
  return await custody.reserveWriteAccess({ executionId, agentType, canonicalRoot, canonicalRootKey });
}

async function activate(custody, identity = childIdentity()) {
  await custody.markSpawning({ executionId: identity.executionId, canonicalRootKey: rootAKey });
  return await custody.activateWriteAccess({
    executionId: identity.executionId,
    canonicalRootKey: rootAKey,
    processIdentity: identity
  });
}

/**
 * Starts one real coordinator process that competes for durable admission.
 *
 * The child is launched immediately so both contenders race for the same
 * atomic rename. A winner then parks until the parent releases it, so the
 * loser always attempts its reservation while the winner is provably still
 * alive. That replaces a fixed sleep with an explicit handshake.
 */
function startReservationProcess(stateRoot, executionId) {
  const child = spawn(
    process.execPath,
    [path.join(fixtureDirectory, "reserve-writer.mjs"), stateRoot, rootA, executionId, "deterministic"],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  const stdout = [];
  const stderr = [];
  let acquired;
  let exited;
  const acquiredPromise = new Promise((resolve) => {
    acquired = resolve;
  });
  const exitedPromise = new Promise((resolve) => {
    exited = resolve;
  });

  child.stdout.on("data", (chunk) => {
    stdout.push(Buffer.from(chunk));
    if (Buffer.concat(stdout).toString("utf8").includes("ACQUIRED")) acquired(true);
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.once("close", (code) => {
    acquired(false);
    exited({
      executionId,
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    });
  });

  return {
    executionId,
    child,
    // Resolves true once the reservation is held, false if the process ended
    // first. Either way the contender has reached a decision.
    settled: acquiredPromise,
    exited: exitedPromise,
    release() {
      try {
        child.stdin.write("RELEASE\n");
        child.stdin.end();
      } catch {
        // Already gone; its close is awaited regardless.
      }
    }
  };
}

test("atomic ownership admission excludes a second real coordinator process", {
  skip: process.platform !== "win32"
}, async () => {
  await withState(async (stateRoot) => {
    // Real Node processes, real durable filesystem admission, real contention.
    // Identity resolution is injected and deterministic so this test measures
    // atomic admission and nothing else.
    const contenders = [
      startReservationProcess(stateRoot, "process-a"),
      startReservationProcess(stateRoot, "process-b")
    ];

    // Both contenders have reached a decision: one holds the reservation, the
    // other has already failed and exited.
    const held = await Promise.all(contenders.map((contender) => contender.settled));
    assert.equal(
      held.filter(Boolean).length,
      1,
      "exactly one real coordinator may hold durable admission"
    );

    // The winner only lets go once the loser is done contending.
    for (const contender of contenders) contender.release();
    const results = await Promise.all(contenders.map((contender) => contender.exited));

    const diagnostics = JSON.stringify(results);
    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code === 2);
    assert.equal(winners.length, 1, diagnostics);
    assert.equal(losers.length, 1, diagnostics);
    assert.match(winners[0].stdout, /ACQUIRED/u, diagnostics);
    assert.match(losers[0].stderr, /write_custody_conflict/u, diagnostics);
    // The loser must fail because ownership is held, never because identity
    // resolution was too slow to decide.
    assert.doesNotMatch(losers[0].stderr, /ambiguous/u, diagnostics);
    assert.equal(losers[0].stdout.includes("ACQUIRED"), false, diagnostics);

    // The durable record belongs to the winner and survives the contention.
    const retained = await manager(stateRoot, new Map(), 100).getWriteAccess(rootAKey);
    assert.equal(retained.executionId, winners[0].executionId);
    assert.equal(retained.state, "RESERVED");
  });
});

test("durable ownership prevents two coordinator instances from owning one repository", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const first = manager(stateRoot, observations, 100);
    const second = manager(stateRoot, observations, 100);

    assert.equal((await reserve(first)).state, "RESERVED");
    await assert.rejects(
      reserve(second, { executionId: "execution-b" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_conflict"
    );
    assert.equal((await second.getWriteAccess(rootAKey)).executionId, "execution-a");
  });
});

test("durable state is rejected when configured inside the working tree", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-state-boundary-"));
  try {
    const custody = manager(
      path.join(repositoryRoot, ".durable-state"),
      new Map([[100, live(100, "10000")]]),
      100
    );
    await assert.rejects(
      reserve(custody, {
        canonicalRoot: repositoryRoot,
        canonicalRootKey: repositoryRoot.toLowerCase()
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_root_invalid"
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("normal terminal proof persists the full lifecycle before releasing ownership", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const custody = manager(stateRoot, observations, 100);
    const identity = childIdentity();

    await reserve(custody);
    const active = await activate(custody, identity);
    assert.equal(active.state, "ACTIVE");
    assert.deepEqual(active.claudeProcess, durableIdentity(200, "20000"));

    await assert.rejects(
      custody.releaseWriteAccessAfterTerminal({
        executionId: "execution-a",
        canonicalRootKey: rootAKey
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_terminal_proof_missing"
    );

    const released = await custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity)
    });
    assert.equal(released.state, "RELEASED");
    assert.equal(released.accessMode, "none");
    assert.deepEqual(
      released.transitions.map((entry) => entry.state),
      ["RESERVED", "SPAWNING", "ACTIVE", "TERMINAL_PROVEN", "HANDOFF_READY", "RELEASED"]
    );
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);

    const historyPath = path.join(
      custody.repositoryStateDirectory(rootAKey),
      "executions",
      "execution-a",
      "record.json"
    );
    assert.equal(JSON.parse(await readFile(historyPath, "utf8")).state, "RELEASED");
    await assert.rejects(
      reserve(custody),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_execution_id_conflict"
    );
  });
});

test("only the exact in-memory child identity can provide terminal proof", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const custody = manager(stateRoot, observations, 100);
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    await assert.rejects(
      custody.releaseWriteAccessAfterTerminal({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: terminalProof(childIdentity({ child: new EventEmitter() }))
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_process_identity_mismatch"
    );
    assert.equal((await custody.getWriteAccess(rootAKey)).state, "ACTIVE");
  });
});

test("exact terminal proof can recover the identity-persisted SPAWNING window", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const custody = manager(stateRoot, observations, 100, { createNonce: () => "fixed" });
    const identity = childIdentity();
    await reserve(custody);
    await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });

    const collisionPath = path.join(custody.repositoryStateDirectory(rootAKey), ".record-fixed.tmp");
    await writeFile(collisionPath, "force one persistence failure", "utf8");
    await assert.rejects(
      custody.activateWriteAccess({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        processIdentity: identity
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_persist_failed"
    );
    assert.equal((await custody.getWriteAccess(rootAKey)).state, "SPAWNING");

    const released = await custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity)
    });
    assert.equal(released.state, "RELEASED");
    assert.deepEqual(released.claudeProcess, durableIdentity(200, "20000"));
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);
  });
});

test("a definitely dead RESERVED owner is reconciled and a new owner is admitted", async () => {
  await withState(async (stateRoot) => {
    const firstObservations = new Map([[100, live(100, "10000")]]);
    const first = manager(stateRoot, firstObservations, 100);
    await reserve(first);

    const secondObservations = new Map([
      [100, dead()],
      [300, live(300, "30000")]
    ]);
    const second = manager(stateRoot, secondObservations, 300);
    const acquired = await reserve(second, { executionId: "execution-b" });
    assert.equal(acquired.executionId, "execution-b");
    assert.equal(acquired.state, "RESERVED");
  });
});

test("PID reuse is treated as death of the stored owner, not as the original process", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(first);

    const second = manager(
      stateRoot,
      new Map([
        [100, live(100, "99999")],
        [300, live(300, "30000")]
      ]),
      300
    );
    const acquired = await reserve(second, { executionId: "execution-b" });
    assert.equal(acquired.executionId, "execution-b");
  });
});

test("ambiguous owner identity remains blocked", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(first);
    const second = manager(
      stateRoot,
      new Map([
        [100, ambiguous()],
        [300, live(300, "30000")]
      ]),
      300
    );
    await assert.rejects(
      reserve(second, { executionId: "execution-b" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
  });
});

test("a dead coordinator cannot release an unrecorded SPAWNING child window", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(first);
    await first.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });

    const second = manager(
      stateRoot,
      new Map([
        [100, dead()],
        [300, live(300, "30000")]
      ]),
      300
    );
    await assert.rejects(
      reserve(second, { executionId: "execution-b" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
    assert.equal((await second.getWriteAccess(rootAKey)).state, "ORPHANED");
  });
});

test("malformed authoritative state fails closed", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([
      [100, live(100, "10000")],
      [300, live(300, "30000")]
    ]);
    const first = manager(stateRoot, observations, 100);
    await reserve(first);
    const recordPath = path.join(first.repositoryStateDirectory(rootAKey), "ownership", "record.json");
    await writeFile(recordPath, "{not-json", "utf8");

    const second = manager(stateRoot, observations, 300);
    await assert.rejects(
      reserve(second, { executionId: "execution-b" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
  });
});

test("unknown nested durable identity fields fail closed", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([
      [100, live(100, "10000")],
      [300, live(300, "30000")]
    ]);
    const first = manager(stateRoot, observations, 100);
    await reserve(first);
    const recordPath = path.join(first.repositoryStateDirectory(rootAKey), "ownership", "record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.coordinatorProcess.unexpected = "field";
    await writeFile(recordPath, JSON.stringify(record), "utf8");

    const second = manager(stateRoot, observations, 300);
    await assert.rejects(
      reserve(second, { executionId: "execution-b" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_ambiguous"
    );
  });
});

test("coordinator crash with live Claude becomes ORPHANED and remains owned", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    const identity = childIdentity();
    await reserve(first);
    await activate(first, identity);

    const second = manager(
      stateRoot,
      new Map([
        [100, dead()],
        [200, live(200, "20000")],
        [300, live(300, "30000")]
      ]),
      300
    );
    await assert.rejects(reserve(second, { executionId: "execution-b" }), /already retained/);
    const retained = await second.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.accessMode, "write");
    assert.equal(retained.orphanReason, "coordinator-dead-claude-alive");
  });
});

test("coordinator and Claude both proven dead are reconciled", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(first);
    await activate(first, childIdentity());

    const second = manager(
      stateRoot,
      new Map([
        [100, dead()],
        [200, dead()],
        [300, live(300, "30000")]
      ]),
      300
    );
    const acquired = await reserve(second, { executionId: "execution-b" });
    assert.equal(acquired.executionId, "execution-b");
  });
});

test("a crashed coordinator's TERMINATING record never releases even when Claude is proven dead", async () => {
  await withState(async (stateRoot) => {
    // Real durable state, not a fixture: reserve, spawn, activate and begin
    // termination through the ordinary API so the record on disk is exactly
    // what a coordinator writes just before it starts killing its child.
    const identity = childIdentity();
    const first = manager(stateRoot, new Map([[100, live(100, "10000")], [200, live(200, "20000")]]), 100);
    await reserve(first);
    await activate(first, identity);
    const terminating = await first.beginTermination({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity
    });
    assert.equal(terminating.state, "TERMINATING");

    // Read the record straight off the filesystem to prove the durable state
    // under test really is TERMINATING with a persisted Claude identity.
    const recordPath = path.join(
      first.repositoryStateDirectory(rootAKey),
      "ownership",
      "record.json"
    );
    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(persisted.state, "TERMINATING");
    assert.deepEqual(persisted.claudeProcess, durableIdentity(200, "20000"));

    // The coordinator crashed. Its Claude child is gone too - but the taskkill
    // helper it may have launched had no durable identity, so nothing can prove
    // the repository is quiet. Releasing here would hand the tree to a new
    // writer while a destructive tree-kill could still be running.
    const restarted = manager(
      stateRoot,
      new Map([
        [100, dead()],
        [200, dead()],
        [300, live(300, "30000")]
      ]),
      300
    );
    const reconciliation = await restarted.reconcileExistingOwnership(rootAKey);
    assert.equal(reconciliation.released, false, "TERMINATING must never auto-release");
    assert.equal(reconciliation.reason, "forced-termination-unproven");
    assert.equal(reconciliation.coordinator, "dead");
    assert.equal(reconciliation.claude, "dead");

    await assert.rejects(
      reserve(restarted, { executionId: "execution-b" }),
      (error) => {
        assert.ok(error instanceof WriteCustodyError);
        assert.equal(error.code, "write_custody_conflict");
        return true;
      },
      "a new writer must remain blocked"
    );

    const retained = await restarted.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.orphanReason, "forced-termination-helper-quiescence-unproven");
    assert.equal(retained.accessMode, "write");
    assert.equal(retained.executionId, "execution-a");
    assert.equal(retained.terminalProof, undefined, "no terminal proof may be fabricated");

    // Repeated reconciliation must stay fail-closed rather than eventually
    // releasing once the record has settled into ORPHANED.
    const second = await restarted.reconcileExistingOwnership(rootAKey);
    assert.equal(second.released, false);
    assert.equal(second.reason, "forced-termination-unproven");
    await assert.rejects(reserve(restarted, { executionId: "execution-c" }), /already retained/);
    assert.equal((await restarted.getWriteAccess(rootAKey)).state, "ORPHANED");
  });
});

test("an already ORPHANED record with a dead Claude also stays fail-closed after a crash", async () => {
  await withState(async (stateRoot) => {
    // Reaching ORPHANED is the coordinator admitting it could not prove
    // termination, which is precisely when an unproven taskkill helper may
    // still exist. A later coordinator must not read "Claude is dead" as
    // permission to take the repository.
    const identity = childIdentity();
    const first = manager(stateRoot, new Map([[100, live(100, "10000")], [200, live(200, "20000")]]), 100);
    await reserve(first);
    await activate(first, identity);
    const orphaned = await first.markOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      reason: "termination-grace-expired"
    });
    assert.equal(orphaned.state, "ORPHANED");

    const restarted = manager(
      stateRoot,
      new Map([[100, dead()], [200, dead()], [300, live(300, "30000")]]),
      300
    );
    const reconciliation = await restarted.reconcileExistingOwnership(rootAKey);
    assert.equal(reconciliation.released, false);
    assert.equal(reconciliation.reason, "forced-termination-unproven");
    await assert.rejects(reserve(restarted, { executionId: "execution-b" }), /already retained/);
    const retained = await restarted.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");
    // The original orphan reason is preserved: the record was already ORPHANED,
    // so reconciliation records no new transition.
    assert.equal(retained.orphanReason, "termination-grace-expired");
  });
});

test("durable terminal states still complete their release after the coordinator dies", async () => {
  await withState(async (stateRoot) => {
    // The counterpart to the rule above: TERMINAL_PROVEN and HANDOFF_READY rest
    // on proof that was written to disk before the crash, so a later
    // coordinator can finish the handoff it can still verify.
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(first);
    const recordPath = path.join(
      first.repositoryStateDirectory(rootAKey),
      "ownership",
      "record.json"
    );
    const reserved = JSON.parse(await readFile(recordPath, "utf8"));
    const at = reserved.updatedAt;
    await writeFile(
      recordPath,
      JSON.stringify({
        ...reserved,
        revision: reserved.revision + 1,
        state: "TERMINAL_PROVEN",
        accessMode: "none",
        updatedAt: at,
        transitions: [...reserved.transitions, { state: "TERMINAL_PROVEN", at }],
        terminalProof: { kind: "not-started", observedAt: at }
      }, null, 2) + "\n",
      "utf8"
    );

    const restarted = manager(stateRoot, new Map([[100, dead()], [300, live(300, "30000")]]), 300);
    const reconciliation = await restarted.reconcileExistingOwnership(rootAKey);
    assert.equal(reconciliation.released, true);
    assert.equal(reconciliation.reason, "terminal-record");
    assert.equal(reconciliation.record.state, "RELEASED");
    const acquired = await reserve(restarted, { executionId: "execution-b" });
    assert.equal(acquired.executionId, "execution-b");
  });
});

test("stale observational lease data never releases live ownership", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const first = manager(stateRoot, observations, 100);
    await reserve(first);
    await writeFile(
      path.join(first.repositoryStateDirectory(rootAKey), "lease-observation.json"),
      JSON.stringify({ expiresAt: 0 }),
      "utf8"
    );
    const second = manager(stateRoot, observations, 100);
    await assert.rejects(
      reserve(second, { executionId: "execution-b" }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_conflict"
    );
  });
});

test("different canonical repositories remain independently reservable", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const custody = manager(stateRoot, observations, 100);
    await reserve(custody);
    await reserve(custody, {
      executionId: "execution-b",
      canonicalRoot: rootB,
      canonicalRootKey: rootBKey
    });
    assert.equal((await custody.getWriteAccess(rootAKey)).executionId, "execution-a");
    assert.equal((await custody.getWriteAccess(rootBKey)).executionId, "execution-b");
  });
});

test("completed durable records never persist task bodies, contracts, or environment values", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(custody);
    const released = await custody.releaseUnstartedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey
    });
    const text = JSON.stringify(released);
    for (const forbidden of ["SENSITIVE_ASSIGNMENT_BODY", "ROLE_CONTRACT_TEXT", "SECRET_ENV_VALUE"]) {
      assert.equal(text.includes(forbidden), false);
    }
  });
});

test("exit alone never returns write custody and close does", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")], [200, live(200)]]), 100);
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    // 1. `exit` is not proof: the direct child ended but its stdio may still be
    // held open by a descendant that can keep writing to the repository.
    await assert.rejects(
      custody.releaseWriteAccessAfterTerminal({
        executionId: identity.executionId,
        canonicalRootKey: rootAKey,
        terminalProof: {
          processIdentity: identity,
          event: "exit",
          code: 0,
          signal: null,
          observedAt: 1_200
        }
      }),
      (error) => {
        assert.equal(error.code, "write_custody_terminal_proof_missing");
        assert.match(error.message, /exit event is not proof/u);
        return true;
      }
    );
    // 3. Custody is still fully owned while only an exit has been seen.
    const stillOwned = await custody.getWriteAccess(rootAKey);
    assert.equal(stillOwned.state, "ACTIVE");
    assert.equal(stillOwned.accessMode, "write");

    // 2 and 3. The later close for the exact same child does release it.
    const released = await custody.releaseWriteAccessAfterTerminal({
      executionId: identity.executionId,
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity, 1_300)
    });
    assert.equal(released.state, "RELEASED");
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);
  });
});

test("a persisted exit-only terminal proof is rejected as malformed durable state", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(custody);
    const recordPath = path.join(
      custody.repositoryStateDirectory(rootAKey),
      "ownership",
      "record.json"
    );
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.state = "TERMINAL_PROVEN";
    record.terminalProof = { kind: "child-event", event: "exit", observedAt: 1_100 };
    record.transitions = [...record.transitions, { state: "TERMINAL_PROVEN", at: 1_100 }];
    await writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");

    const second = manager(stateRoot, new Map([[100, dead()], [300, live(300)]]), 300);
    await assert.rejects(reserve(second, { executionId: "execution-b" }), /ambiguous|malformed|invalid/iu);
  });
});

test("a supervised close releases custody only inside the coordinator that spawned the child", async () => {
  await withState(async (stateRoot) => {
    // 4. The child died before its durable PID+StartTime could be captured, so
    // no claudeProcess was ever persisted. The same live coordinator did watch
    // the exact ChildProcess it spawned reach close.
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(custody);
    await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    const spawning = await custody.getWriteAccess(rootAKey);
    assert.equal(spawning.state, "SPAWNING");
    assert.equal(spawning.claudeProcess, undefined);

    const released = await custody.releaseWriteAccessAfterSupervisedClose({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: { event: "close", code: 0, signal: null, observedAt: 1_150, supervisedByCoordinator: true }
    });
    assert.equal(released.state, "RELEASED");
    assert.equal(released.terminalProof.kind, "supervised-child-close");
    // No fabricated durable identity was persisted for the dead child.
    assert.equal(released.claudeProcess, undefined);
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);
  });
});

test("supervised close evidence is refused without a real supervised spawn", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(custody);
    const proof = { event: "close", code: 0, signal: null, observedAt: 1_150, supervisedByCoordinator: true };

    // Not spawning yet: nothing was supervised.
    await assert.rejects(
      custody.releaseWriteAccessAfterSupervisedClose({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: proof
      }),
      (error) => {
        assert.equal(error.code, "write_custody_state_invalid");
        return true;
      }
    );

    await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    // An exit is never supervised close evidence.
    await assert.rejects(
      custody.releaseWriteAccessAfterSupervisedClose({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: { ...proof, event: "exit" }
      }),
      (error) => {
        assert.equal(error.code, "write_custody_terminal_proof_missing");
        return true;
      }
    );
    // Neither is a proof that does not claim coordinator supervision.
    await assert.rejects(
      custody.releaseWriteAccessAfterSupervisedClose({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: { ...proof, supervisedByCoordinator: false }
      }),
      (error) => {
        assert.equal(error.code, "write_custody_terminal_proof_missing");
        return true;
      }
    );
  });
});

test("supervised close evidence does not survive a coordinator restart", async () => {
  await withState(async (stateRoot) => {
    // 5. Same durable state, new coordinator process: the in-memory evidence is
    // gone, so the record must stay fail-closed rather than being released.
    const first = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(first);
    await first.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });

    const restarted = manager(stateRoot, new Map([[100, dead()], [300, live(300)]]), 300);
    const proof = { event: "close", code: 0, signal: null, observedAt: 1_150, supervisedByCoordinator: true };
    await assert.rejects(
      restarted.releaseWriteAccessAfterSupervisedClose({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: proof
      }),
      (error) => {
        assert.equal(error.code, "write_custody_terminal_proof_required");
        return true;
      }
    );

    // Reconciliation from the restarted coordinator also stays blocked.
    await assert.rejects(reserve(restarted, { executionId: "execution-b" }), /already retained/);
    const retained = await restarted.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.orphanReason, "process-identity-not-persisted");
  });
});

async function prepareWithGitOperation(custody, { pid = 500, startTime } = {}) {
  await reserve(custody);
  await custody.beginWorktreePreparation({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    baseCommit: "a".repeat(40),
    worktreeRoot: "C:\\state\\worktrees\\execution-a"
  });
  await custody.recordWorktreeOperation({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    gitOperation: {
      kind: "worktree-add",
      pid,
      startTime: startTime || String(pid * 100),
      source
    }
  });
}

test("a live persisted Git worktree operation blocks reconciliation", async () => {
  await withState(async (stateRoot) => {
    // 10. Coordinator died while `git worktree add` was running and that exact
    // Git process is still alive: the repository is still being written.
    const first = manager(stateRoot, new Map([[100, live(100, "10000")], [500, live(500)]]), 100);
    await prepareWithGitOperation(first);

    const second = manager(
      stateRoot,
      new Map([[100, dead()], [500, live(500)], [300, live(300)]]),
      300
    );
    await assert.rejects(reserve(second, { executionId: "execution-b" }), /already retained/);
    const retained = await second.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.orphanReason, "coordinator-dead-git-operation-alive");
    assert.equal(retained.accessMode, "write");
    // The worktree is preserved, never deleted heuristically.
    assert.equal(retained.worktreeRoot, "C:\\state\\worktrees\\execution-a");
  });
});

test("an ambiguous persisted Git worktree operation remains blocked", async () => {
  await withState(async (stateRoot) => {
    // 12. Nothing can be concluded about the Git process, so fail closed.
    const first = manager(stateRoot, new Map([[100, live(100, "10000")], [500, live(500)]]), 100);
    await prepareWithGitOperation(first);

    const second = manager(
      stateRoot,
      new Map([[100, dead()], [500, ambiguous()], [300, live(300)]]),
      300
    );
    await assert.rejects(reserve(second, { executionId: "execution-b" }), /already retained/);
    const retained = await second.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");
    assert.equal(retained.orphanReason, "git-operation-identity-ambiguous");
    assert.equal(retained.worktreeRoot, "C:\\state\\worktrees\\execution-a");
  });
});

test("a dead or PID-reused Git worktree operation is recognized as no longer running", async () => {
  await withState(async (stateRoot) => {
    // 11. Both the proven-dead and the PID-reused cases mean that exact Git
    // process is gone. Preparation consistency still cannot be proven, so the
    // execution is orphaned and its worktree preserved rather than guessed at.
    for (const [label, observation] of [
      ["dead", dead()],
      ["pid-reused", live(500, "999999")]
    ]) {
      await withState(async (innerRoot) => {
        const first = manager(innerRoot, new Map([[100, live(100, "10000")], [500, live(500)]]), 100);
        await prepareWithGitOperation(first);

        const second = manager(
          innerRoot,
          new Map([[100, dead()], [500, observation], [300, live(300)]]),
          300
        );
        await assert.rejects(
          reserve(second, { executionId: "execution-b" }),
          /already retained/,
          label + " must still block a new writer"
        );
        const retained = await second.getWriteAccess(rootAKey);
        assert.equal(retained.state, "ORPHANED", label);
        assert.equal(retained.orphanReason, "git-operation-terminal-preparation-unproven", label);
        assert.equal(retained.worktreeRoot, "C:\\state\\worktrees\\execution-a", label);
      });
    }
  });
});

test("a cleared Git worktree operation no longer participates in reconciliation", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")], [500, live(500)]]), 100);
    await prepareWithGitOperation(first);
    const cleared = await first.clearWorktreeOperation({
      executionId: "execution-a",
      canonicalRootKey: rootAKey
    });
    assert.equal(cleared.gitOperation, undefined);
    assert.equal(cleared.state, "PREPARING_WORKTREE");

    const second = manager(
      stateRoot,
      new Map([[100, dead()], [500, live(500)], [300, live(300)]]),
      300
    );
    await assert.rejects(reserve(second, { executionId: "execution-b" }), /already retained/);
    const retained = await second.getWriteAccess(rootAKey);
    // Falls back to the generic preparing-state rule, not the Git-operation one.
    assert.equal(retained.orphanReason, "process-identity-not-persisted");
  });
});

test("a stale beginTermination publication cannot overwrite a released execution or a new owner", async () => {
  await withState(async (stateRoot) => {
    const publicationReached = deferred();
    const resumePublication = deferred();
    const observations = new Map([
      [100, live(100, "10000")],
      [200, live(200, "20000")],
      [300, live(300, "30000")],
      [400, live(400, "40000")]
    ]);
    const first = manager(stateRoot, observations, 100, {
      beforePublish: async ({ nextRecord }) => {
        if (nextRecord.executionId === "execution-a" && nextRecord.state === "TERMINATING") {
          publicationReached.resolve();
          await resumePublication.promise;
        }
      }
    });
    const identityA = childIdentity();
    await reserve(first);
    await activate(first, identityA);

    const staleTermination = first.beginTermination({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identityA
    });
    await publicationReached.promise;

    // This separate manager represents a later coordinator after A died. It
    // terminalizes A through reconciliation, archives it, then admits B.
    observations.set(100, dead());
    observations.set(200, dead());
    const second = manager(stateRoot, observations, 300);
    await reserve(second, { executionId: "execution-b" });
    const identityB = childIdentity({ executionId: "execution-b", pid: 400, startTime: "40000" });
    await activate(second, identityB);

    resumePublication.resolve();
    await assert.rejects(
      staleTermination,
      (error) => error instanceof WriteCustodyError &&
        ["write_custody_owner_mismatch", "write_custody_stale_mutation"].includes(error.code)
    );
    const authoritative = await second.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-b");
    assert.equal(authoritative.state, "ACTIVE");
  });
});

test("cancelled delayed activation stops blocking terminal recovery and never later publishes ACTIVE", async () => {
  await withState(async (stateRoot) => {
    const publicationReached = deferred();
    const resumePublication = deferred();
    const observations = new Map([[100, live(100, "10000")], [200, live(200, "20000")]]);
    const custody = manager(stateRoot, observations, 100, {
      beforePublish: async ({ nextRecord }) => {
        if (nextRecord.state === "ACTIVE") {
          publicationReached.resolve();
          await resumePublication.promise;
        }
      }
    });
    const identity = childIdentity();
    await reserve(custody);
    await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    const controller = new AbortController();
    const activation = custody.activateWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      mutationSignal: controller.signal
    });
    await publicationReached.promise;
    controller.abort();

    // The aborted write is still paused before its final rename, but it no
    // longer has publication authority. Terminal recovery can therefore make
    // conservative durable progress instead of waiting behind it forever.
    const orphaned = await custody.markOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      reason: "activation-deadline-expired"
    });
    assert.equal(orphaned.state, "ORPHANED");
    await custody.releaseOrphanedWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity, 1_250)
    });
    const admitted = await reserve(custody, { executionId: "execution-b" });
    assert.equal(admitted.executionId, "execution-b");
    resumePublication.resolve();
    await assert.rejects(
      activation,
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_mutation_cancelled"
    );
    const record = await custody.getWriteAccess(rootAKey);
    assert.equal(record.executionId, "execution-b");
    assert.equal(record.state, "RESERVED");
  });
});

test("cancelled beginTermination cannot race exact terminal release or a later admission", async () => {
  await withState(async (stateRoot) => {
    const publicationReached = deferred();
    const resumePublication = deferred();
    const observations = new Map([[100, live(100, "10000")], [200, live(200, "20000")]]);
    const custody = manager(stateRoot, observations, 100, {
      beforePublish: async ({ nextRecord }) => {
        if (nextRecord.state === "TERMINATING") {
          publicationReached.resolve();
          await resumePublication.promise;
        }
      }
    });
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    const controller = new AbortController();
    const terminating = custody.beginTermination({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      mutationSignal: controller.signal
    });
    await publicationReached.promise;
    controller.abort();

    const released = await custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity, 1_250)
    });
    assert.equal(released.state, "RELEASED");
    const admitted = await reserve(custody, { executionId: "execution-b" });
    assert.equal(admitted.executionId, "execution-b");

    resumePublication.resolve();
    await assert.rejects(
      terminating,
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_mutation_cancelled"
    );
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-b");
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("post-publication cancellation lets an issued transition quiesce before release and admission", async () => {
  await withState(async (stateRoot) => {
    const publicationIssued = deferred();
    const resumePublication = deferred();
    const observations = new Map([[100, live(100, "10000")], [200, live(200, "20000")]]);
    const custody = manager(stateRoot, observations, 100, {
      afterPublicationIssued: async ({ nextRecord }) => {
        if (nextRecord.executionId === "execution-a" && nextRecord.state === "TERMINATING") {
          publicationIssued.resolve();
          await resumePublication.promise;
        }
      }
    });
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    const controller = new AbortController();
    let terminationSettled = false;
    const terminating = custody.beginTermination({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      mutationSignal: controller.signal
    }).then((record) => {
      terminationSettled = true;
      return record;
    });
    await publicationIssued.promise;

    // Cancellation arrives after the rename call. It must not be represented
    // as pre-publication invalidation or let later ownership work overtake the
    // still-issued transition.
    controller.abort();
    let releaseSettled = false;
    let admissionSettled = false;
    const released = custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity, 1_250)
    }).then((record) => {
      releaseSettled = true;
      return record;
    });
    const admitted = reserve(custody, { executionId: "execution-b" }).then((record) => {
      admissionSettled = true;
      return record;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminationSettled, false);
    assert.equal(releaseSettled, false);
    assert.equal(admissionSettled, false);

    resumePublication.resolve();
    const [transitioned, releasedRecord, admittedRecord] = await Promise.all([
      terminating,
      released,
      admitted
    ]);
    assert.equal(controller.signal.aborted, true);
    assert.equal(transitioned.state, "TERMINATING");
    assert.equal(releasedRecord.state, "RELEASED");
    assert.equal(admittedRecord.executionId, "execution-b");
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-b");
    assert.equal(authoritative.state, "RESERVED");
  });
});

/**
 * The initial reservation publishes through exactly one rename, the same way
 * every later transition does, so it is bound by the same two rules: before the
 * rename is issued a cancellation permanently removes publication authority,
 * and once it is issued nothing - including a root cancellation - may conclude
 * anything about durable state until it settles.
 *
 * The two tests below pin one rule each, on either side of that boundary.
 */
test("cancellation before the initial admission rename publishes no ownership at all", async () => {
  await withState(async (stateRoot) => {
    const inspectionReached = deferred();
    const resumeInspection = deferred();
    const custody = new DurableWriteCustodyManager({
      stateRoot,
      currentPid: 100,
      now: () => 1_000,
      inspectProcess: async (pid) => {
        inspectionReached.resolve();
        await resumeInspection.promise;
        return live(pid, "10000");
      }
    });

    const controller = new AbortController();
    const reserving = custody.reserveWriteAccess({
      executionId: "execution-a",
      agentType: "task",
      canonicalRoot: rootA,
      canonicalRootKey: rootAKey,
      mutationSignal: controller.signal
    });
    await inspectionReached.promise;
    controller.abort();
    resumeInspection.resolve();

    await assert.rejects(
      reserving,
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_mutation_cancelled"
    );
    assert.equal(await custody.getWriteAccess(rootAKey), undefined);
  });
});

test("post-publication cancellation of the initial reservation quiesces before a second admission", async () => {
  await withState(async (stateRoot) => {
    const publicationIssued = deferred();
    const resumePublication = deferred();
    const observations = new Map([[100, live(100, "10000")]]);
    // Every reservation stamps its record from this clock inside the repository
    // mutation, and nowhere else in this test, so the call count is exactly the
    // number of admissions that have been let into the queue.
    let admissionsEntered = 0;
    const custody = manager(stateRoot, observations, 100, {
      now: () => {
        admissionsEntered += 1;
        return 1_000;
      },
      afterPublicationIssued: async ({ nextRecord }) => {
        if (nextRecord.executionId === "execution-a" && nextRecord.state === "RESERVED") {
          publicationIssued.resolve();
          await resumePublication.promise;
        }
      }
    });

    const controller = new AbortController();
    const admissionFence = createAdmissionPublicationFence();
    let reservationSettled = false;
    const reserving = custody.reserveWriteAccess({
      executionId: "execution-a",
      agentType: "task",
      canonicalRoot: rootA,
      canonicalRootKey: rootAKey,
      admissionFence,
      mutationSignal: controller.signal
    }).then((record) => {
      reservationSettled = true;
      return record;
    });
    await publicationIssued.promise;
    assert.equal(admissionFence.publicationStarted(), true);
    assert.equal(admissionsEntered, 1);

    // Cancellation arrives after the admission rename was issued. It can no
    // longer unmake ownership, so it must neither be reported as
    // pre-publication invalidation nor let a second admission overtake it.
    controller.abort();
    let contenderSettled = false;
    const contenderFence = createAdmissionPublicationFence();
    const contender = custody.reserveWriteAccess({
      executionId: "execution-b",
      agentType: "task",
      canonicalRoot: rootA,
      canonicalRootKey: rootAKey,
      admissionFence: contenderFence
    }).then(
      (record) => {
        contenderSettled = "reserved";
        return record;
      },
      (error) => {
        contenderSettled = "refused";
        return error;
      }
    );
    // Long enough for a contender that was wrongly released into the queue to
    // complete its own directory work; a correctly blocked one can never enter,
    // however long this waits.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reservationSettled, false);
    assert.equal(contenderSettled, false);
    // The decisive check: the cancelled admission still occupies the queue
    // because its publication has not settled, so no second admission has begun
    // building a record for the same ownership slot.
    assert.equal(admissionsEntered, 1);

    resumePublication.resolve();
    const reserved = await reserving;
    assert.equal(controller.signal.aborted, true);
    assert.equal(reserved.executionId, "execution-a");
    assert.equal(reserved.state, "RESERVED");
    assert.equal(admissionFence.disposition(), "published");
    assert.equal(admissionFence.publishedRecord()?.executionId, "execution-a");

    const refused = await contender;
    assert.equal(contenderSettled, "refused");
    assert.equal(refused.code, "write_custody_conflict");
    // It observed an occupied slot rather than racing the first rename for it.
    assert.equal(contenderFence.publicationStarted(), false);
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-a");
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("concurrent mutations of one real ownership record serialize in invocation order", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")], [200, live(200, "20000")]]), 100);
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);

    const terminating = custody.beginTermination({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity
    });
    const orphaning = custody.markOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      reason: "test-concurrent-order"
    });
    await Promise.all([terminating, orphaning]);
    const record = await custody.getWriteAccess(rootAKey);
    assert.equal(record.state, "ORPHANED");
    assert.deepEqual(record.transitions.map((entry) => entry.state), [
      "RESERVED",
      "SPAWNING",
      "ACTIVE",
      "TERMINATING",
      "ORPHANED"
    ]);
    assert.equal(record.revision, 4);
  });
});

test("archive and admission cannot interleave an old released record over a new owner", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")]]);
    const custody = manager(stateRoot, observations, 100);
    await reserve(custody);
    const release = custody.releaseUnstartedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey
    });
    const admission = reserve(custody, { executionId: "execution-b" });
    const [released, admitted] = await Promise.all([release, admission]);
    assert.equal(released.state, "RELEASED");
    assert.equal(admitted.executionId, "execution-b");
    const authoritative = await custody.getWriteAccess(rootAKey);
    assert.equal(authoritative.executionId, "execution-b");
    assert.equal(authoritative.state, "RESERVED");
  });
});

test("a valid Phase 5.2 record migrates to revisioned publication on its next mutation", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]), 100);
    await reserve(custody);
    const recordPath = path.join(custody.repositoryStateDirectory(rootAKey), "ownership", "record.json");
    const legacy = JSON.parse(await readFile(recordPath, "utf8"));
    legacy.schemaVersion = 1;
    delete legacy.revision;
    await writeFile(recordPath, JSON.stringify(legacy, null, 2), "utf8");

    const spawning = await custody.markSpawning({ executionId: "execution-a", canonicalRootKey: rootAKey });
    assert.equal(spawning.schemaVersion, 2);
    assert.equal(spawning.revision, 1);
    const durable = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(durable.schemaVersion, 2);
    assert.equal(durable.revision, 1);
  });
});

test("the same live coordinator can release ORPHANED custody on a later exact close", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")], [200, live(200, "20000")]]);
    const custody = manager(stateRoot, observations, 100);
    const identity = childIdentity();
    await reserve(custody);
    await activate(custody, identity);
    await custody.markOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      reason: "termination-grace-expired"
    });

    const released = await custody.releaseOrphanedWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity, 1_300)
    });
    assert.equal(released.state, "RELEASED");
    assert.deepEqual(released.transitions.map((entry) => entry.state), [
      "RESERVED",
      "SPAWNING",
      "ACTIVE",
      "ORPHANED",
      "TERMINAL_PROVEN",
      "HANDOFF_READY",
      "RELEASED"
    ]);
  });
});

test("foreign or ambiguous late proof cannot release ORPHANED custody", async () => {
  await withState(async (stateRoot) => {
    const observations = new Map([[100, live(100, "10000")], [200, live(200, "20000")]]);
    const first = manager(stateRoot, observations, 100);
    const identity = childIdentity();
    await reserve(first);
    await activate(first, identity);
    await first.markOrphanedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      processIdentity: identity,
      reason: "termination-grace-expired"
    });

    const foreign = manager(stateRoot, new Map([[300, live(300, "30000")]]), 300);
    await assert.rejects(
      foreign.releaseOrphanedWriteAccessAfterTerminal({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: terminalProof(identity, 1_300)
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_terminal_proof_required"
    );
    const retained = await first.getWriteAccess(rootAKey);
    assert.equal(retained.state, "ORPHANED");

    await assert.rejects(
      first.releaseOrphanedWriteAccessAfterTerminal({
        executionId: "execution-a",
        canonicalRootKey: rootAKey,
        terminalProof: terminalProof(childIdentity({ child: new EventEmitter() }), 1_400)
      }),
      (error) => error instanceof WriteCustodyError && error.code === "write_custody_process_identity_mismatch"
    );
    assert.equal((await first.getWriteAccess(rootAKey)).state, "ORPHANED");
  });
});
