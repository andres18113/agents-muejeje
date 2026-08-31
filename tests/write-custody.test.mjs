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
  WriteCustodyError
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
    createNonce: options.createNonce
  });
}

function childIdentity({
  executionId = "execution-a",
  agentType = "task",
  canonicalRoot = rootA,
  pid = 200,
  startTime = "20000",
  child = new EventEmitter(),
  startedAt = 1_100
} = {}) {
  child.pid = pid;
  return Object.freeze({
    executionId,
    agentType,
    canonicalRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
  }
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

function runReservationProcess(stateRoot, executionId) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(fixtureDirectory, "reserve-writer.mjs"), stateRoot, rootA, executionId],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

test("atomic ownership admission excludes a second real coordinator process", {
  skip: process.platform !== "win32"
}, async () => {
  await withState(async (stateRoot) => {
    const [first, second] = await Promise.all([
      runReservationProcess(stateRoot, "process-a"),
      runReservationProcess(stateRoot, "process-b")
    ]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.code === 2).length, 1, JSON.stringify(results));
    assert.match(results.find((result) => result.code === 0).stdout, /ACQUIRED/);
    assert.match(results.find((result) => result.code === 2).stderr, /write_custody_conflict/);
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
    await rm(repositoryRoot, { recursive: true, force: true });
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
