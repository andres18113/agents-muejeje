import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("concurrent real Windows identity observations all resolve to one live identity", {
  skip: process.platform !== "win32"
}, async () => {
  // This is the condition GitHub Actions exposed: several cold PowerShell
  // starts at once. Every observation must still resolve ALIVE with the same
  // PID and start time; none may degrade to an ambiguous timeout.
  const rounds = 3;
  const concurrency = 6;
  const observations = [];

  for (let round = 0; round < rounds; round += 1) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => inspectProcessIdentity(process.pid))
    );
    observations.push(...batch);
  }

  const ambiguous = observations.filter(
    (observation) => observation.status !== PROCESS_IDENTITY_STATUS.ALIVE
  );
  assert.equal(
    ambiguous.length,
    0,
    "concurrent identity queries must not degrade: " + JSON.stringify(ambiguous)
  );

  const startTimes = new Set(observations.map((observation) => observation.identity.startTime));
  assert.equal(startTimes.size, 1, "one process must report one start time: " + JSON.stringify([...startTimes]));
  for (const observation of observations) {
    assert.equal(observation.identity.pid, process.pid);
    assert.match(observation.identity.startTime, /^\d+$/u);
    assert.equal(observation.identity.source, "windows-get-process-starttime-utc-ticks");
  }

  // Concurrent observations of the same process must compare as the same
  // process, which is what durable admission depends on.
  const stored = observations[0].identity;
  const comparisons = await Promise.all(
    Array.from({ length: concurrency }, () => compareProcessIdentity(stored))
  );
  for (const comparison of comparisons) {
    assert.equal(comparison.status, PROCESS_IDENTITY_MATCH.SAME_PROCESS, JSON.stringify(comparison));
  }
});

test("a real Windows query for an unused PID is definitely dead, not ambiguous", {
  skip: process.platform !== "win32"
}, async () => {
  // The dead/ambiguous distinction must survive the switch to the direct
  // process API: a PID that does not exist is proven dead.
  const observation = await inspectProcessIdentity(0x7ffffff0);
  assert.equal(observation.status, PROCESS_IDENTITY_STATUS.DEAD, JSON.stringify(observation));
});

function stubQueryChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

test("an abandoned identity query terminates the exact child and awaits its close", async () => {
  // Timeout: the query child is asked to stop and then awaited. When it does
  // close, termination is proven; the observation is ambiguous either way and
  // is never converted into alive or dead.
  const closing = stubQueryChild();
  const closingResult = inspectProcessIdentity(4321, {
    platform: "win32",
    spawnProcess: () => closing,
    timeoutMs: 5,
    terminationTimeoutMs: 5_000
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closing.killCalls, 1, "exactly the spawned query child is terminated");
  closing.emit("close", 1);
  const closed = await closingResult;
  assert.equal(closed.status, PROCESS_IDENTITY_STATUS.AMBIGUOUS);
  assert.equal(closed.reason, "query-timeout");
  assert.equal(closed.queryTerminationProven, true);

  // A query child that ignores the request still settles on the bounded
  // termination deadline; nothing is left pending.
  const stubborn = stubQueryChild();
  const stubbornResult = await inspectProcessIdentity(4321, {
    platform: "win32",
    spawnProcess: () => stubborn,
    timeoutMs: 5,
    terminationTimeoutMs: 10
  });
  assert.equal(stubbornResult.status, PROCESS_IDENTITY_STATUS.AMBIGUOUS);
  assert.equal(stubbornResult.reason, "query-timeout");
  assert.equal(stubbornResult.queryTerminationProven, false);
  assert.equal(stubborn.killCalls, 1);

  // A late close after the query was abandoned never revives it into a
  // successful observation.
  const overflowing = stubQueryChild();
  const overflowResult = inspectProcessIdentity(4321, {
    platform: "win32",
    spawnProcess: () => overflowing,
    timeoutMs: 60_000,
    terminationTimeoutMs: 5_000
  });
  overflowing.stdout.emit("data", Buffer.from("9".repeat(8_192)));
  assert.equal(overflowing.killCalls, 1);
  overflowing.emit("close", 0);
  const overflowed = await overflowResult;
  assert.equal(overflowed.status, PROCESS_IDENTITY_STATUS.AMBIGUOUS);
  assert.equal(overflowed.reason, "query-output-invalid");
  assert.equal(overflowed.queryTerminationProven, true);

  // A kill-triggered ChildProcess error is diagnostic after abandonment. It
  // must not cancel the bounded close wait and settle before close arrives.
  const erroring = stubQueryChild();
  const erroringResult = inspectProcessIdentity(4321, {
    platform: "win32",
    spawnProcess: () => erroring,
    timeoutMs: 5,
    terminationTimeoutMs: 5_000
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  let settled = false;
  erroringResult.then(() => {
    settled = true;
  });
  erroring.emit("error", new Error("kill reported an error"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the abandoned query remains in its bounded close wait");
  erroring.emit("close", 1);
  const errored = await erroringResult;
  assert.equal(errored.status, PROCESS_IDENTITY_STATUS.AMBIGUOUS);
  assert.equal(errored.reason, "query-timeout");
  assert.equal(errored.queryTerminationProven, true);
  assert.equal(errored.queryError.message, "kill reported an error");
});

test("a healthy stubbed query is unaffected by the termination path", async () => {
  const child = stubQueryChild();
  const pending = inspectProcessIdentity(4321, {
    platform: "win32",
    spawnProcess: () => child,
    timeoutMs: 60_000,
    terminationTimeoutMs: 5_000
  });
  child.stdout.emit("data", Buffer.from("638923456789000000"));
  child.emit("close", 0);
  const observation = await pending;
  assert.equal(observation.status, PROCESS_IDENTITY_STATUS.ALIVE);
  assert.equal(observation.identity.startTime, "638923456789000000");
  assert.equal(child.killCalls, 0, "a healthy query is never terminated");

  const dead = stubQueryChild();
  const deadPending = inspectProcessIdentity(4321, {
    platform: "win32",
    spawnProcess: () => dead,
    timeoutMs: 60_000,
    terminationTimeoutMs: 5_000
  });
  dead.emit("close", 3);
  assert.equal((await deadPending).status, PROCESS_IDENTITY_STATUS.DEAD);
  assert.equal(dead.killCalls, 0);
});
