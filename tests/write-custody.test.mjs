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
