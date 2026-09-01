import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runSupervisedProcess } from "../src/supervised-process.mjs";

let nextPid = 90_000;

function fakeChild({ pid = nextPid++, onKill } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return onKill?.(child) ?? true;
  };
  return child;
}

function liveIdentity(pid, startTime = String(pid * 100)) {
  return Object.freeze({
    status: "alive",
    identity: Object.freeze({ pid, startTime, source: "test-process-start" })
  });
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function run(child, overrides = {}) {
  return runSupervisedProcess("git", ["status"], {
    spawnProcess: () => child,
    maxOutputBytes: 64,
    timeoutMs: 20,
    terminationTimeoutMs: 20,
    describeCommand: () => "git status",
    ...overrides
  });
}

test("supervised process converts an asynchronous spawn error into a controlled failure", async () => {
  const child = fakeChild({ pid: undefined });
  const pending = run(child);
  child.emit("error", new Error("ENOENT"));

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "supervised_process_spawn_failed");
    return true;
  });
});

test("supervised process resolves normal close and never treats exit alone as terminal", async () => {
  const normal = fakeChild();
  const complete = run(normal);
  normal.stdout.emit("data", Buffer.from("ok"));
  normal.stderr.emit("data", Buffer.from("warning"));
  normal.emit("close", 0, null);
  assert.deepEqual(await complete, { stdout: "ok", stderr: "warning", exitCode: 0 });

  const exitedOnly = fakeChild({ onKill: () => true });
  let settled = false;
  const pending = run(exitedOnly, { timeoutMs: 10, terminationTimeoutMs: 10 });
  pending.finally(() => {
    settled = true;
  }).catch(() => {});
  exitedOnly.emit("exit", 0, null);
  await nextTurn();
  assert.equal(settled, false, "exit remains diagnostic until close");
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    return true;
  });
});

test("supervised process proves timeout termination only after close", async () => {
  const closing = fakeChild({
    onKill(child) {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    }
  });
  await assert.rejects(run(closing, { timeoutMs: 10 }), (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, true);
    assert.equal(error.sideEffectsUnproven, true);
    return true;
  });
  assert.equal(closing.killCalls, 1);

  const stubborn = fakeChild({ onKill: () => true });
  await assert.rejects(run(stubborn, { timeoutMs: 10, terminationTimeoutMs: 10 }), (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    return true;
  });
  assert.equal(stubborn.killCalls, 1);
});

test("supervised process bounds output overflow and direct-handle failures", async () => {
  const overflow = fakeChild({
    onKill(child) {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    }
  });
  const overflowed = run(overflow, { maxOutputBytes: 3 });
  overflow.stdout.emit("data", Buffer.from("overflow"));
  await assert.rejects(overflowed, (error) => {
    assert.equal(error.code, "supervised_process_output_overflow");
    assert.equal(error.terminationProven, true);
    return true;
  });

  const throwingKill = fakeChild({
    onKill() {
      throw new Error("kill failed");
    }
  });
  await assert.rejects(run(throwingKill, { timeoutMs: 10, terminationTimeoutMs: 10 }), (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    return true;
  });

  const erroringKill = fakeChild({
    onKill(child) {
      child.emit("error", new Error("kill emitted error"));
      return true;
    }
  });
  await assert.rejects(run(erroringKill, { timeoutMs: 10, terminationTimeoutMs: 10 }), (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    return true;
  });
});

test("Windows taskkill helper error cannot replace either helper or target close proof", async () => {
  const child = fakeChild();
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
    return true;
  };
  let invocation;
  const pending = run(child, {
    platform: "win32",
    inspectProcess: async (pid) => liveIdentity(pid),
    spawnTerminator(command, args) {
      invocation = { command, args };
      setImmediate(() => {
        terminator.emit("error", new Error("taskkill failed"));
        child.emit("close", null, "SIGKILL");
      });
      return terminator;
    },
    timeoutMs: 10
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    assert.equal(error.targetTerminationProven, true);
    assert.equal(error.taskkillHelperQuiescenceProven, false);
    return true;
  });
  assert.deepEqual(invocation, { command: "taskkill", args: ["/PID", String(child.pid), "/T", "/F"] });
  assert.equal(child.killCalls, 1, "taskkill error falls back to the exact spawned child handle");
  assert.equal(terminator.killCalls, 1, "a failed helper receives an exact-handle stop request");

  const hangingChild = fakeChild();
  const hangingTerminator = new EventEmitter();
  hangingTerminator.killCalls = 0;
  hangingTerminator.kill = () => {
    hangingTerminator.killCalls += 1;
    return true;
  };
  await assert.rejects(run(hangingChild, {
    platform: "win32",
    inspectProcess: async (pid) => liveIdentity(pid),
    spawnTerminator: () => hangingTerminator,
    timeoutMs: 10,
    terminationTimeoutMs: 10
  }), (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    return true;
  });
  assert.equal(hangingTerminator.killCalls, 1, "a hung taskkill is itself bounded");
  assert.equal(hangingChild.killCalls, 1, "a hung taskkill reserves grace for exact-handle fallback");
});

test("Windows taskkill helper close is independent from target close", async () => {
  const child = fakeChild({ onKill: () => true });
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
    return true;
  };
  let spawned;
  const spawnedPromise = new Promise((resolve) => {
    spawned = resolve;
  });
  let settled = false;
  const pending = run(child, {
    platform: "win32",
    timeoutMs: 100,
    terminationTimeoutMs: 100,
    inspectProcess: async (pid) => liveIdentity(pid),
    spawnTerminator: () => {
      spawned();
      return terminator;
    }
  });
  pending.finally(() => {
    settled = true;
  }).catch(() => {});

  await spawnedPromise;
  terminator.emit("error", new Error("taskkill failed"));
  await nextTurn();
  assert.equal(child.killCalls, 1, "helper failure falls back to the exact target handle");
  assert.equal(terminator.killCalls, 1, "helper error requests termination of the exact helper handle");

  child.emit("close", null, "SIGTERM");
  await nextTurn();
  assert.equal(settled, false, "target close alone cannot prove taskkill quiescence");

  terminator.emit("close", null, "SIGTERM");
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, true);
    assert.equal(error.targetTerminationProven, true);
    assert.equal(error.taskkillHelperQuiescenceProven, true);
    assert.equal(error.taskkillHelper.closeProven, true);
    return true;
  });
});

test("Windows taskkill refuses reused, ambiguous, and dead identities", async () => {
  for (const [label, freshObservation] of [
    ["reused", (pid) => liveIdentity(pid, "different-start-time")],
    ["ambiguous", () => ({ status: "ambiguous", reason: "denied" })],
    ["dead", () => ({ status: "dead" })]
  ]) {
    const child = fakeChild({
      onKill(target) {
        setImmediate(() => target.emit("close", null, "SIGTERM"));
        return true;
      }
    });
    let calls = 0;
    let taskkillCalls = 0;
    const pending = run(child, {
      platform: "win32",
      timeoutMs: 10,
      inspectProcess: async (pid) => {
        calls += 1;
        return calls === 1 ? liveIdentity(pid) : freshObservation(pid);
      },
      spawnTerminator() {
        taskkillCalls += 1;
        return new EventEmitter();
      }
    });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "supervised_process_timeout");
      assert.equal(error.terminationProven, true);
      return true;
    });
    assert.equal(calls, 2, label + " requires a fresh comparison");
    assert.equal(taskkillCalls, 0, label + " never authorizes taskkill");
    assert.equal(child.killCalls, 1, label + " falls back to the exact handle");
  }
});

test("an unsuccessfully completed taskkill falls back to the exact handle and still requires close", async () => {
  const child = fakeChild({
    onKill(target) {
      setImmediate(() => target.emit("close", null, "SIGTERM"));
      return true;
    }
  });
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  const pending = run(child, {
    platform: "win32",
    timeoutMs: 20,
    terminationTimeoutMs: 20,
    inspectProcess: async (pid) => liveIdentity(pid),
    spawnTerminator: () => {
      setImmediate(() => terminator.emit("close", 1, null));
      return terminator;
    }
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, true);
    return true;
  });
  assert.equal(child.killCalls, 1);

  const noClose = fakeChild({ onKill: () => true });
  const failedTerminator = new EventEmitter();
  failedTerminator.kill = () => true;
  await assert.rejects(run(noClose, {
    platform: "win32",
    timeoutMs: 10,
    terminationTimeoutMs: 10,
    inspectProcess: async (pid) => liveIdentity(pid),
    spawnTerminator: () => {
      setImmediate(() => failedTerminator.emit("close", 1, null));
      return failedTerminator;
    }
  }), (error) => {
    assert.equal(error.terminationProven, false, "kill request alone is never terminal proof");
    return true;
  });
  assert.equal(noClose.killCalls, 1);
});

test("a taskkill helper that errors again while being stopped keeps Git bounded and fails closed", async () => {
  // The Git path through the same shared helper watcher as Claude termination.
  // The helper fails, we ask that exact helper to stop, and the stop request
  // makes it emit `error` a second time on a later turn.
  const child = fakeChild({ onKill: () => true });
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
    setImmediate(() => terminator.emit("error", new Error("kill request failed")));
    return true;
  };

  const pending = run(child, {
    platform: "win32",
    timeoutMs: 10,
    terminationTimeoutMs: 40,
    inspectProcess: async (pid) => liveIdentity(pid),
    spawnTerminator: () => {
      setImmediate(() => terminator.emit("error", new Error("taskkill failed")));
      return terminator;
    }
  });

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "supervised_process_timeout");
    assert.equal(error.terminationProven, false);
    assert.equal(error.taskkillHelperQuiescenceProven, false);
    assert.equal(error.sideEffectsUnproven, true);
    return true;
  });
  assert.equal(terminator.killCalls, 1, "a repeated helper error must not request another kill");
  assert.equal(child.killCalls, 1, "helper failure falls back to the exact target handle once");
  assert.doesNotThrow(() => terminator.emit("error", new Error("late error")));
});

test("late lifecycle events cannot settle a supervised process twice", async () => {
  const child = fakeChild({ onKill: () => true });
  const pending = run(child, { timeoutMs: 10, terminationTimeoutMs: 10 });
  let settlements = 0;
  pending.then(
    () => { settlements += 1; },
    () => { settlements += 1; }
  );
  await assert.rejects(pending, (error) => error.code === "supervised_process_timeout");
  child.emit("close", null, "SIGTERM");
  child.emit("error", new Error("late error"));
  await nextTurn();
  assert.equal(settlements, 1, "late close/error events are no-ops after settlement");
});
