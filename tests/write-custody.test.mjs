import assert from "node:assert/strict";
import test from "node:test";
import { WriteCustodyError, WriteCustodyManager } from "../src/write-custody.mjs";

const rootA = "C:\\workspace\\root-a";
const rootB = "C:\\workspace\\root-b";
const rootAKey = rootA.toLowerCase();
const rootBKey = rootB.toLowerCase();

test("write custody uses FREE -> RESERVED -> ACTIVE -> RELEASED ownership transitions", () => {
  const custody = new WriteCustodyManager();
  const reserved = custody.reserveWriteAccess({
    executionId: "execution-a",
    agentType: "general-purpose",
    canonicalRoot: rootA,
    canonicalRootKey: rootAKey
  });
  assert.equal(reserved.state, "RESERVED");
  assert.equal(reserved.accessMode, "none");
  assert.equal(custody.getWriteAccess(rootAKey).state, "RESERVED");

  const active = custody.activateWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey
  });
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.accessMode, "write");

  const released = custody.releaseWriteAccess({
    executionId: "execution-a",
    canonicalRootKey: rootAKey
  });
  assert.equal(released.state, "RELEASED");
  assert.equal(released.accessMode, "none");
  assert.equal(custody.getWriteAccess(rootAKey), undefined);
});

test("write custody rejects a second same-root writer without stealing ownership", () => {
  const custody = new WriteCustodyManager();
  custody.reserveWriteAccess({
    executionId: "execution-a",
    agentType: "task",
    canonicalRoot: rootA,
    canonicalRootKey: rootAKey
  });

  assert.throws(
    () => custody.reserveWriteAccess({
      executionId: "execution-b",
      agentType: "general-purpose",
      canonicalRoot: rootA,
      canonicalRootKey: rootAKey
    }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_conflict"
  );
  assert.equal(custody.getWriteAccess(rootAKey).executionId, "execution-a");
});

test("write custody permits independent roots and requires release by the owning execution", () => {
  const custody = new WriteCustodyManager();
  custody.reserveWriteAccess({
    executionId: "execution-a",
    agentType: "task",
    canonicalRoot: rootA,
    canonicalRootKey: rootAKey
  });
  custody.reserveWriteAccess({
    executionId: "execution-b",
    agentType: "general-purpose",
    canonicalRoot: rootB,
    canonicalRootKey: rootBKey
  });
  assert.equal(custody.getWriteAccess(rootAKey).executionId, "execution-a");
  assert.equal(custody.getWriteAccess(rootBKey).executionId, "execution-b");

  assert.throws(
    () => custody.releaseWriteAccess({ executionId: "execution-b", canonicalRootKey: rootAKey }),
    (error) => error instanceof WriteCustodyError && error.code === "write_custody_owner_mismatch"
  );
  assert.equal(custody.getWriteAccess(rootAKey).executionId, "execution-a");
});
