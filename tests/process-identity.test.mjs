import assert from "node:assert/strict";
import test from "node:test";
import {
  PROCESS_IDENTITY_MATCH,
  PROCESS_IDENTITY_STATUS,
  compareProcessIdentity,
  inspectProcessIdentity
} from "../src/process-identity.mjs";

const stored = Object.freeze({
  pid: 4321,
  startTime: "638923456789000000",
  source: "windows-get-process-starttime-utc-ticks"
});

test("PID plus matching start time recognizes the same live process", async () => {
  const result = await compareProcessIdentity(stored, {
    inspectProcess: async () => ({
      status: PROCESS_IDENTITY_STATUS.ALIVE,
      identity: { ...stored }
    })
  });
  assert.equal(result.status, PROCESS_IDENTITY_MATCH.SAME_PROCESS);
});

test("a live reused PID is not treated as the original owner", async () => {
  const result = await compareProcessIdentity(stored, {
    inspectProcess: async () => ({
      status: PROCESS_IDENTITY_STATUS.ALIVE,
      identity: { ...stored, startTime: "638923456789999999" }
    })
  });
  assert.equal(result.status, PROCESS_IDENTITY_MATCH.PID_REUSED);
});

test("different process identity sources are incomparable and fail closed", async () => {
  const result = await compareProcessIdentity(stored, {
    inspectProcess: async () => ({
      status: PROCESS_IDENTITY_STATUS.ALIVE,
      identity: { ...stored, source: "different-identity-source" }
    })
  });
  assert.equal(result.status, PROCESS_IDENTITY_MATCH.AMBIGUOUS);
  assert.equal(result.reason, "identity-source-mismatch");
});

test("dead and ambiguous process observations remain distinct", async () => {
  const dead = await compareProcessIdentity(stored, {
    inspectProcess: async () => ({ status: PROCESS_IDENTITY_STATUS.DEAD })
  });
  assert.equal(dead.status, PROCESS_IDENTITY_MATCH.DEAD);

  const ambiguous = await compareProcessIdentity(stored, {
    inspectProcess: async () => ({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "denied" })
  });
  assert.equal(ambiguous.status, PROCESS_IDENTITY_MATCH.AMBIGUOUS);
});

test("Windows Get-Process returns invariant start identity for the current process", {
  skip: process.platform !== "win32"
}, async () => {
  const observation = await inspectProcessIdentity(process.pid);
  assert.equal(observation.status, PROCESS_IDENTITY_STATUS.ALIVE, JSON.stringify(observation));
  assert.equal(observation.identity.pid, process.pid);
  assert.match(observation.identity.startTime, /^\d+$/u);
  assert.equal(observation.identity.source, "windows-get-process-starttime-utc-ticks");
});
