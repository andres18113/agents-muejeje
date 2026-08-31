import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WriteCustodyError, WriteCustodyManager } from "../src/write-custody.mjs";

const rootA = "C:\\workspace\\root-a";
const rootB = "C:\\workspace\\root-b";
const rootAKey = rootA.toLowerCase();
const rootBKey = rootB.toLowerCase();

function processIdentity({
  executionId = "execution-a",
  agentType = "general-purpose",
  canonicalRoot = rootA,
  pid = 4321,
  child = new EventEmitter(),
  startedAt = 1
} = {}) {
  return Object.freeze({ executionId, agentType, canonicalRoot, pid, child, startedAt });
}

function terminalProof(identity, event = "close") {
  return Object.freeze({
    processIdentity: identity,
    event,
    code: 0,
    signal: null,
    observedAt: 2
  });
}

function reserve(custody, { executionId = "execution-a", agentType = "general-purpose", canonicalRoot = rootA, canonicalRootKey = rootAKey } = {}) {
  return custody.reserveWriteAccess({ executionId, agentType, canonicalRoot, canonicalRootKey });
}

test("normal child terminal proof allows FREE -> RESERVED -> ACTIVE -> RELEASED", () => {
  const custody = new WriteCustodyManager();
  const identity = processIdentity();

  assert.equal(reserve(custody).state, "RESERVED");
  const active = custody.activateWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    processIdentity: identity
  });
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.accessMode, "write");
  assert.equal(active.processIdentity.pid, 4321);

  const released = custody.releaseWriteAccessAfterTerminal({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    terminalProof: terminalProof(identity)
  });
  assert.equal(released.state, "RELEASED");
  assert.equal(released.accessMode, "none");
  assert.equal(custody.getWriteAccess(rootAKey), undefined);
});

test("a reservation safely releases only when no child process started", () => {
  const custody = new WriteCustodyManager();
  reserve(custody);

  const released = custody.releaseUnstartedWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey
  });
  assert.equal(released.state, "RELEASED");
  assert.equal(custody.getWriteAccess(rootAKey), undefined);

  reserve(custody);
  const identity = processIdentity();
  custody.activateWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    processIdentity: identity
  });
  assert.throws(
    () => custody.releaseUnstartedWriteAccess({
      executionId: "execution-a",
      canonicalRootKey: rootAKey
    }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_terminal_proof_required"
  );
});

test("TERMINATING and ORPHANED roots remain blocked until a matching terminal proof", () => {
  const custody = new WriteCustodyManager();
  const identity = processIdentity();
  reserve(custody);
  custody.activateWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    processIdentity: identity
  });
  const terminating = custody.beginTermination({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    processIdentity: identity
  });
  assert.equal(terminating.state, "TERMINATING");

  assert.throws(
    () => reserve(custody, { executionId: "execution-b", agentType: "task" }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_conflict"
  );
  assert.throws(
    () => custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(processIdentity({ pid: 9999, child: identity.child }))
    }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_process_identity_mismatch"
  );

  const orphaned = custody.markOrphanedWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    processIdentity: identity,
    reason: "termination-unproven"
  });
  assert.equal(orphaned.state, "ORPHANED");
  assert.equal(orphaned.accessMode, "write");
  assert.throws(
    () => reserve(custody, { executionId: "execution-b", agentType: "task" }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_conflict"
  );
  assert.throws(
    () => custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(identity)
    }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_state_invalid"
  );
});

test("only the owner and exact ChildProcess identity can return custody", () => {
  const custody = new WriteCustodyManager();
  const identity = processIdentity();
  reserve(custody);
  custody.activateWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey,
    processIdentity: identity
  });

  assert.throws(
    () => custody.beginTermination({
      executionId: "execution-b",
      canonicalRootKey: rootAKey,
      processIdentity: identity
    }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_owner_mismatch"
  );
  assert.throws(
    () => custody.releaseWriteAccessAfterTerminal({
      executionId: "execution-a",
      canonicalRootKey: rootAKey,
      terminalProof: terminalProof(processIdentity({ child: new EventEmitter() }))
    }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_process_identity_mismatch"
  );
  assert.equal(custody.getWriteAccess(rootAKey).state, "ACTIVE");
});

test("different roots remain independently reservable", () => {
  const custody = new WriteCustodyManager();
  reserve(custody);
  reserve(custody, {
    executionId: "execution-b",
    agentType: "task",
    canonicalRoot: rootB,
    canonicalRootKey: rootBKey
  });
  assert.equal(custody.getWriteAccess(rootAKey).executionId, "execution-a");
  assert.equal(custody.getWriteAccess(rootBKey).executionId, "execution-b");
});
