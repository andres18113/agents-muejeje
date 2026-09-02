import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CUSTODY_KINDS,
  DurableWriteCustodyManager,
  custodyKindOf,
  validateDurableOwnershipRecord
} from "../src/write-custody.mjs";
import { EventEmitter } from "node:events";
import { PROCESS_IDENTITY_MATCH } from "../src/process-identity.mjs";
import { decideReconciliation } from "../src/custody/reconciliation-policy.mjs";

const ROOT = "C:\\repo";
const ROOT_KEY = "c:\\repo";

function live(pid, startTime) {
  return { status: "alive", identity: { pid, startTime, source: "test-identity" } };
}

function dead() {
  return { status: "dead" };
}

function manager(stateRoot, observations, currentPid = 100) {
  return new DurableWriteCustodyManager({
    stateRoot,
    currentPid,
    now: () => 1_000,
    inspectProcess: async (pid) => observations.get(pid) || dead()
  });
}

async function withState(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-custody-kind-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

/**
 * The in-memory identity a coordinator holds for the child it actually spawned.
 * Custody validates the whole shape, not just the PID, so the review lifecycle
 * has to present the same evidence a writer's does.
 */
function childIdentity({ executionId, agentType, pid = 200, startTime = "20000" } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  return Object.freeze({
    executionId,
    agentType,
    repositoryRoot: ROOT,
    pid,
    startTime,
    source: "test-identity",
    child,
    startedAt: 1_100
  });
}

async function readOwnershipFile(custody, stateRoot) {
  const directory = custody.repositoryStateDirectory(ROOT_KEY);
  return JSON.parse(await readFile(path.join(directory, "ownership", "record.json"), "utf8"));
}

const PHASE_FIVE_KEYS = [
  "accessMode", "agentType", "canonicalRoot", "canonicalRootKey", "coordinatorProcess",
  "createdAt", "executionId", "repositoryId", "reservedAt", "revision", "schemaVersion",
  "state", "transitions", "updatedAt"
];

test("a write reservation writes no custodyKind at all, staying byte-identical to Phase 5", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]));
    await custody.reserveWriteAccess({
      executionId: "writer-a",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    const persisted = await readOwnershipFile(custody, stateRoot);
    assert.deepEqual(Object.keys(persisted).sort(), PHASE_FIVE_KEYS);
    assert.equal(Object.hasOwn(persisted, "custodyKind"), false);
    assert.equal(custodyKindOf(persisted), CUSTODY_KINDS.WRITE);
  });
});

test("a coherent review holds the slot with no write authority in any state", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]));
    const reserved = await custody.reserveWriteAccess({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: CUSTODY_KINDS.COHERENT_REVIEW
    });
    assert.equal(reserved.accessMode, "none");
    assert.equal(custodyKindOf(reserved), CUSTODY_KINDS.COHERENT_REVIEW);
  });
});

test("a coherent review record reports accessMode none through its whole lifecycle", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")], [200, live(200, "20000")]]));
    await custody.reserveWriteAccess({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: CUSTODY_KINDS.COHERENT_REVIEW,
      targetRef: "refs/remotes/origin/main"
    });

    const spawning = await custody.markSpawning({ executionId: "review-a", canonicalRootKey: ROOT_KEY });
    assert.equal(spawning.accessMode, "none");

    // The same identity object throughout: custody matches the exact live child
    // it admitted, not merely one that looks like it.
    const identity = childIdentity({ executionId: "review-a", agentType: "code-review" });
    const active = await custody.activateWriteAccess({
      executionId: "review-a",
      canonicalRootKey: ROOT_KEY,
      processIdentity: identity
    });
    // ACTIVE would mean "write" for a writer. A reviewer never has write
    // authority; it blocks because the slot is taken, not because it may mutate.
    assert.equal(active.accessMode, "none");
    assert.equal(custodyKindOf(active), CUSTODY_KINDS.COHERENT_REVIEW);
    assert.equal(active.targetRef, "refs/remotes/origin/main");

    const terminating = await custody.beginTermination({
      executionId: "review-a",
      canonicalRootKey: ROOT_KEY,
      processIdentity: identity
    });
    assert.equal(terminating.accessMode, "none");
  });
});

test("the one slot excludes in both directions", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]));
    await custody.reserveWriteAccess({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: CUSTODY_KINDS.COHERENT_REVIEW
    });

    // A writer cannot enter while a review holds the slot.
    await assert.rejects(custody.reserveWriteAccess({
      executionId: "writer-b",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    }), (error) => {
      assert.equal(error.code, "write_custody_conflict");
      return true;
    });

    // And a second review cannot either.
    await assert.rejects(custody.reserveWriteAccess({
      executionId: "review-b",
      agentType: "security-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: CUSTODY_KINDS.COHERENT_REVIEW
    }), (error) => {
      assert.equal(error.code, "write_custody_conflict");
      return true;
    });
  });
});

test("a writer holding the slot excludes a review", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]));
    await custody.reserveWriteAccess({
      executionId: "writer-a",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });
    await assert.rejects(custody.reserveWriteAccess({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: CUSTODY_KINDS.COHERENT_REVIEW
    }), (error) => {
      assert.equal(error.code, "write_custody_conflict");
      return true;
    });
  });
});

test("an unknown custody kind is refused at the API boundary", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]));
    await assert.rejects(custody.reserveWriteAccess({
      executionId: "x",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: "bogus"
    }), (error) => {
      assert.equal(error.code, "write_custody_kind_invalid");
      return true;
    });
  });
});

test("a malformed target ref is refused at the API boundary", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot, new Map([[100, live(100, "10000")]]));
    await assert.rejects(custody.reserveWriteAccess({
      executionId: "x",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      targetRef: "main"
    }), (error) => {
      assert.equal(error.code, "git_ref_name_invalid");
      return true;
    });
  });
});

function validRecord(overrides = {}) {
  return {
    schemaVersion: 2,
    revision: 0,
    executionId: "e-1",
    agentType: "code-review",
    canonicalRoot: ROOT,
    canonicalRootKey: ROOT_KEY,
    repositoryId: "0".repeat(64),
    accessMode: "none",
    state: "RESERVED",
    createdAt: 1,
    reservedAt: 1,
    updatedAt: 1,
    coordinatorProcess: { pid: 1, startTime: "1", source: "s" },
    transitions: [{ state: "RESERVED", at: 1 }],
    ...overrides
  };
}

test("hand-written records with impossible custody shapes are refused", async () => {
  // repositoryId must agree with the key, so compute the real one first.
  const { repositoryIdForCanonicalRootKey } = await import("../src/write-custody.mjs");
  const repositoryId = repositoryIdForCanonicalRootKey(ROOT_KEY);
  const base = (overrides) => validRecord({ repositoryId, ...overrides });

  assert.ok(validateDurableOwnershipRecord(base({})));
  assert.ok(validateDurableOwnershipRecord(base({ custodyKind: "coherent-review" })));

  assert.equal(validateDurableOwnershipRecord(base({ custodyKind: "bogus" })), undefined);
  assert.equal(
    validateDurableOwnershipRecord(base({ custodyKind: "coherent-review", accessMode: "write" })),
    undefined,
    "a reviewer may never claim write authority"
  );
  assert.equal(
    validateDurableOwnershipRecord(base({
      custodyKind: "coherent-review",
      worktreeRoot: "C:\\wt",
      baseCommit: "a".repeat(40)
    })),
    undefined,
    "a reviewer never prepares a worktree"
  );
  assert.equal(
    validateDurableOwnershipRecord(base({
      custodyKind: "coherent-review",
      gitOperation: { kind: "worktree-add", pid: 1, startTime: "1", source: "s" }
    })),
    undefined,
    "a reviewer never supervises a mutating Git child"
  );
  assert.equal(
    validateDurableOwnershipRecord(base({
      custodyKind: "coherent-review",
      state: "PREPARING_WORKTREE",
      transitions: [{ state: "RESERVED", at: 1 }, { state: "PREPARING_WORKTREE", at: 1 }]
    })),
    undefined
  );
  assert.equal(validateDurableOwnershipRecord(base({ targetRef: "main" })), undefined);
  assert.ok(validateDurableOwnershipRecord(base({ targetRef: "refs/heads/main" })));
  assert.equal(validateDurableOwnershipRecord(base({ custodyKind: undefined })), undefined);
  assert.equal(validateDurableOwnershipRecord(base({ targetRef: undefined })), undefined);
  assert.equal(
    validateDurableOwnershipRecord(base({ custodyKind: "coherent-review", worktreeRoot: undefined })),
    undefined,
    "a present write-only key is malformed even when its value is undefined"
  );
});

test("a legacy schema-1 record still normalizes and still blocks", async () => {
  const { repositoryIdForCanonicalRootKey } = await import("../src/write-custody.mjs");
  const legacy = validRecord({ repositoryId: repositoryIdForCanonicalRootKey(ROOT_KEY) });
  delete legacy.revision;
  legacy.schemaVersion = 1;
  assert.ok(validateDurableOwnershipRecord(legacy));
  assert.equal(custodyKindOf(legacy), CUSTODY_KINDS.WRITE);
});

test("a crashed coherent review reconciles under exactly the writer rules", () => {
  const reviewRecord = { state: "ACTIVE", claudeProcess: { pid: 2 }, custodyKind: "coherent-review" };

  // Coordinator and reviewer both proven gone: release, exactly as a writer.
  const released = decideReconciliation({
    record: reviewRecord,
    coordinator: PROCESS_IDENTITY_MATCH.DEAD,
    claude: PROCESS_IDENTITY_MATCH.DEAD
  });
  assert.equal(released.action, "terminalize-and-release");

  // Reviewer still alive: orphaned and blocking, exactly as a writer.
  const orphaned = decideReconciliation({
    record: reviewRecord,
    coordinator: PROCESS_IDENTITY_MATCH.DEAD,
    claude: PROCESS_IDENTITY_MATCH.SAME_PROCESS
  });
  assert.equal(orphaned.action, "orphan");

  // Ambiguity retains, exactly as a writer. No weaker path exists for reviews:
  // a forgeable custodyKind must never make a repository easier to seize.
  const ambiguous = decideReconciliation({
    record: reviewRecord,
    coordinator: PROCESS_IDENTITY_MATCH.AMBIGUOUS
  });
  assert.equal(ambiguous.action, "retain");

  // Forced termination remains unproven for a review too.
  const forced = decideReconciliation({
    record: { ...reviewRecord, state: "TERMINATING" },
    coordinator: PROCESS_IDENTITY_MATCH.DEAD,
    claude: PROCESS_IDENTITY_MATCH.DEAD
  });
  assert.equal(forced.action, "orphan");
  assert.equal(forced.orphanReason, "forced-termination-helper-quiescence-unproven");
});

test("a crashed coherent review is released and the slot becomes free again", async () => {
  await withState(async (stateRoot) => {
    const first = manager(stateRoot, new Map([[100, live(100, "10000")], [200, live(200, "20000")]]), 100);
    await first.reserveWriteAccess({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      custodyKind: CUSTODY_KINDS.COHERENT_REVIEW
    });
    await first.markSpawning({ executionId: "review-a", canonicalRootKey: ROOT_KEY });
    await first.activateWriteAccess({
      executionId: "review-a",
      canonicalRootKey: ROOT_KEY,
      processIdentity: childIdentity({ executionId: "review-a", agentType: "code-review" })
    });

    // The coordinator crashed: a new one takes over with the old PIDs dead.
    const restarted = manager(
      stateRoot,
      new Map([[100, dead()], [200, dead()], [300, live(300, "30000")]]),
      300
    );
    const reconciliation = await restarted.reconcileExistingOwnership(ROOT_KEY);
    assert.equal(reconciliation.released, true);

    const writer = await restarted.reserveWriteAccess({
      executionId: "writer-after-crash",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });
    assert.equal(writer.executionId, "writer-after-crash");
  });
});
