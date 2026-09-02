import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CUSTODY_KINDS, DurableWriteCustodyManager, WriteCustodyError } from "../src/write-custody.mjs";
import { COHERENCE, createCoherentAdmission } from "../src/review/coherent-admission.mjs";

const ROOT = "C:\\repo";
const ROOT_KEY = "c:\\repo";

function manager(stateRoot, { currentPid = 100 } = {}) {
  return new DurableWriteCustodyManager({
    stateRoot,
    currentPid,
    now: () => 1_000,
    inspectProcess: async (pid) => ({
      status: "alive",
      identity: { pid, startTime: String(pid * 100), source: "test-identity" }
    })
  });
}

async function withState(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-admission-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

test("admission on a free repository is held and records the review kind", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot);
    const admission = createCoherentAdmission({ writeCustody: custody });
    const result = await admission.admit({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY,
      targetRef: "refs/remotes/origin/main"
    });

    assert.equal(result.coherence, COHERENCE.HELD);
    assert.equal(result.record.executionId, "review-a");
    assert.equal(result.record.custodyKind, CUSTODY_KINDS.COHERENT_REVIEW);
    assert.equal(result.record.targetRef, "refs/remotes/origin/main");
    assert.equal(result.record.accessMode, "none");
  });
});

test("admission is denied while a writer holds the slot, and never throws", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot);
    await custody.reserveWriteAccess({
      executionId: "writer-a",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    const admission = createCoherentAdmission({ writeCustody: custody });
    const result = await admission.admit({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    // A denied admission is an ordinary outcome, not an error: the review still
    // runs, it simply may not bind evidence.
    assert.equal(result.coherence, COHERENCE.DENIED);
    assert.deepEqual(result.reasons.map((r) => r.code), ["coherent_admission_denied"]);
  });
});

test("admission is denied while another coherent review holds the slot", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot);
    const admission = createCoherentAdmission({ writeCustody: custody });
    await admission.admit({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    const second = await admission.admit({
      executionId: "review-b",
      agentType: "security-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });
    assert.equal(second.coherence, COHERENCE.DENIED);
  });
});

test("every custody failure maps to a distinct review reason and none escapes as a throw", async () => {
  const cases = [
    ["write_custody_conflict", "coherent_admission_denied"],
    ["write_custody_state_ambiguous", "coherent_admission_ambiguous"],
    ["write_custody_execution_id_conflict", "coherent_admission_execution_conflict"],
    ["write_custody_process_identity_ambiguous", "coherent_admission_identity_ambiguous"],
    ["write_custody_state_root_invalid", "coherent_admission_state_root_invalid"],
    ["something_unmapped", "coherent_admission_failed"]
  ];

  for (const [code, expected] of cases) {
    const admission = createCoherentAdmission({
      writeCustody: {
        reserveWriteAccess: async () => { throw new WriteCustodyError("nope", { code }); },
        getWriteAccess: async () => undefined
      }
    });
    const result = await admission.admit({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });
    assert.equal(result.coherence, COHERENCE.DENIED, code);
    assert.equal(result.reasons[0].code, expected, code);
  }
});

test("admit survives a dependency that throws something unexpected", async () => {
  const admission = createCoherentAdmission({
    writeCustody: {
      reserveWriteAccess: async () => { throw new TypeError("boom"); },
      getWriteAccess: async () => undefined
    }
  });
  const result = await admission.admit({
    executionId: "review-a",
    agentType: "code-review",
    canonicalRoot: ROOT,
    canonicalRootKey: ROOT_KEY
  });
  assert.equal(result.coherence, COHERENCE.DENIED);
  assert.equal(result.reasons[0].code, "coherent_admission_failed");
});

test("verifyStillHeld confirms our own live coherent-review record", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot);
    const admission = createCoherentAdmission({ writeCustody: custody });
    await admission.admit({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    const held = await admission.verifyStillHeld({ executionId: "review-a", canonicalRootKey: ROOT_KEY });
    assert.deepEqual({ ...held }, { held: true });
  });
});

test("verifyStillHeld refuses every way the slot can stop being ours", async () => {
  const cases = [
    [undefined, "ownership record is gone"],
    [{ executionId: "somebody-else", custodyKind: "coherent-review", state: "ACTIVE" }, "belongs to"],
    [{ executionId: "review-a", state: "ACTIVE" }, "not a coherent review"],
    [{ executionId: "review-a", custodyKind: "coherent-review", state: "RELEASED" }, "reached RELEASED"],
    [{ executionId: "review-a", custodyKind: "coherent-review", state: "TERMINAL_PROVEN" }, "reached TERMINAL_PROVEN"]
  ];

  for (const [record, fragment] of cases) {
    const admission = createCoherentAdmission({
      writeCustody: { reserveWriteAccess: async () => {}, getWriteAccess: async () => record }
    });
    const result = await admission.verifyStillHeld({ executionId: "review-a", canonicalRootKey: ROOT_KEY });
    assert.equal(result.held, false, fragment);
    assert.equal(result.reasons[0].code, "coherent_admission_lost");
    assert.match(result.reasons[0].detail, new RegExp(fragment, "u"));
  }
});

test("an unreadable ownership record makes verification ambiguous, never held", async () => {
  const admission = createCoherentAdmission({
    writeCustody: {
      reserveWriteAccess: async () => {},
      getWriteAccess: async () => { throw new WriteCustodyError("x", { code: "write_custody_state_ambiguous" }); }
    }
  });
  const result = await admission.verifyStillHeld({ executionId: "review-a", canonicalRootKey: ROOT_KEY });
  assert.equal(result.held, false);
  assert.equal(result.reasons[0].code, "coherent_admission_ambiguous");
});

test("the adapter refuses to be constructed without a custody manager", () => {
  assert.throws(() => createCoherentAdmission({}));
  assert.throws(() => createCoherentAdmission({ writeCustody: {} }));
});

test("a released review frees the slot for a writer", async () => {
  await withState(async (stateRoot) => {
    const custody = manager(stateRoot);
    const admission = createCoherentAdmission({ writeCustody: custody });
    await admission.admit({
      executionId: "review-a",
      agentType: "code-review",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });

    // Release travels the unchanged Phase 5 path; the adapter owns no release.
    await custody.releaseUnstartedWriteAccess({ executionId: "review-a", canonicalRootKey: ROOT_KEY });

    const writer = await custody.reserveWriteAccess({
      executionId: "writer-a",
      agentType: "general-purpose",
      canonicalRoot: ROOT,
      canonicalRootKey: ROOT_KEY
    });
    assert.equal(writer.executionId, "writer-a");
  });
});
