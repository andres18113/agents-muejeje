import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { superviseTaskkillHelper } from "../src/process/windows-termination.mjs";

/**
 * Regressions for the one taskkill helper watcher shared by Claude termination
 * and supervised Git. The properties under test are about evidence discipline:
 * a helper may emit anything, in any order, more than once, and long after the
 * watcher decided - and none of it may crash the process, revive a settled
 * lifecycle, or turn a kill request into proof of quiescence.
 */

function fakeHelper({ onKill } = {}) {
  const helper = new EventEmitter();
  helper.killCalls = 0;
  helper.kill = () => {
    helper.killCalls += 1;
    return onKill?.(helper) ?? true;
  };
  return helper;
}

function manualClock() {
  let time = 1_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: time + Math.max(0, delay) });
      return id;
    },
    cancelSchedule(id) {
      timers.delete(id);
    },
    advanceTo(target) {
      time = target;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pendingTimers: () => timers.size
  };
}

function supervise(helper, { clock, stopAfter = 500, closeAfter = 1_000, ...rest } = {}) {
  const failures = [];
  const settlements = [];
  const watcher = superviseTaskkillHelper(helper, {
    stopDeadlineAt: clock.now() + stopAfter,
    closeDeadlineAt: clock.now() + closeAfter,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    onFailure: (value) => failures.push(value),
    onSettled: (value) => settlements.push(value),
    ...rest
  });
  return { watcher, failures, settlements };
}

test("an error raised while requesting helper termination never becomes an unhandled error", async () => {
  const clock = manualClock();
  const helper = fakeHelper();
  const { watcher, failures, settlements } = supervise(helper, { clock });

  // The helper fails. That starts the caller's exact-handle fallback and asks
  // this exact helper to stop.
  helper.emit("error", new Error("taskkill failed"));
  assert.equal(helper.killCalls, 1, "a failed helper receives one stop request");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].closeProven, false);
  assert.equal(settlements.length, 0, "a kill request is never settlement");

  // Asking a ChildProcess to die can itself make it emit `error`, and that can
  // arrive on a later turn than kill(). An EventEmitter with no `error`
  // listener throws, so this assertion is the regression: the listener must
  // still be attached after the first error was handled.
  assert.doesNotThrow(
    () => helper.emit("error", new Error("kill request failed")),
    "the helper error listener must survive the first error"
  );
  assert.equal(helper.killCalls, 1, "a repeated error must not request another kill");
  assert.equal(failures.length, 1, "the fallback is notified exactly once");

  // Only the helper's own close proves it quiesced, and the first error is kept.
  helper.emit("close", 1, null);
  const result = await watcher.promise;
  assert.equal(result.closeProven, true);
  assert.equal(result.status, "error");
  assert.equal(result.error.message, "taskkill failed");
  assert.equal(settlements.length, 1);
});

test("late helper events after settlement run no callbacks and cannot revive the watcher", async () => {
  const clock = manualClock();
  const helper = fakeHelper();
  const { watcher, failures, settlements } = supervise(helper, { clock });

  helper.emit("close", 0, null);
  const result = await watcher.promise;
  assert.equal(result.status, "completed");
  assert.equal(result.closeProven, true);
  assert.equal(settlements.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(clock.pendingTimers(), 0, "settlement cancels both deadlines");

  // Everything below arrives after the lifecycle was decided.
  assert.doesNotThrow(() => helper.emit("error", new Error("late error")));
  helper.emit("exit", 1, null);
  helper.emit("close", 1, null);
  watcher.cancel();

  assert.equal(helper.killCalls, 0, "no late event may issue a kill request");
  assert.equal(failures.length, 0, "no late event may start a destructive fallback");
  assert.equal(settlements.length, 1, "settlement happens exactly once");
  assert.equal(await watcher.promise, result, "the settled result is immutable");
  assert.equal(watcher.getResult(), result);
});

test("repeated close and error combinations settle exactly once", async () => {
  const clock = manualClock();
  const helper = fakeHelper();
  const { watcher, failures, settlements } = supervise(helper, { clock });

  helper.emit("error", new Error("first"));
  assert.doesNotThrow(() => helper.emit("error", new Error("second")));
  helper.emit("close", null, "SIGTERM");
  assert.doesNotThrow(() => helper.emit("error", new Error("third")));
  helper.emit("close", 0, null);
  helper.emit("close", 1, null);

  const result = await watcher.promise;
  assert.equal(settlements.length, 1);
  assert.equal(result.status, "error");
  assert.equal(result.error.message, "first", "the first error observation wins");
  assert.equal(result.signal, "SIGTERM", "the first close is the terminal proof");
  assert.equal(failures.length, 1);
});

test("a nonzero exit starts the fallback but only close proves quiescence", async () => {
  const clock = manualClock();
  const helper = fakeHelper();
  const { watcher, failures, settlements } = supervise(helper, { clock });

  helper.emit("exit", 1, null);
  assert.equal(failures.length, 1, "a failed helper exit starts the exact-handle fallback");
  assert.equal(settlements.length, 0, "exit is never helper terminal proof");
  helper.emit("exit", 0, null);
  assert.equal(failures.length, 1, "a repeated exit is ignored");

  helper.emit("close", 0, null);
  const result = await watcher.promise;
  assert.equal(result.closeProven, true);
  assert.equal(result.status, "failed", "the earlier failure is not erased by a clean close");
  assert.equal(result.exitCode, 1);
  assert.equal(settlements.length, 1);
});

test("an expired close deadline settles unproven and a later close cannot change it", async () => {
  const clock = manualClock();
  const helper = fakeHelper();
  const { watcher, failures, settlements } = supervise(helper, { clock, stopAfter: 100, closeAfter: 200 });

  clock.advanceTo(1_100);
  assert.equal(helper.killCalls, 1, "the stop subdeadline asks the helper to stop");
  assert.equal(settlements.length, 0);

  clock.advanceTo(1_200);
  const result = await watcher.promise;
  assert.equal(result.closeProven, false, "a stop request is never quiescence proof");
  assert.equal(result.status, "timeout");
  assert.equal(settlements.length, 1);

  helper.emit("close", 0, null);
  assert.equal(settlements.length, 1, "a late close cannot upgrade a settled unproven result");
  assert.equal((await watcher.promise).closeProven, false);
  assert.equal(failures.length, 1);
});

test("a cancelled watcher settles unproven exactly once", async () => {
  const clock = manualClock();
  const helper = fakeHelper();
  const { watcher, failures, settlements } = supervise(helper, { clock });

  const first = watcher.cancel();
  const second = watcher.cancel();
  assert.equal(first.closeProven, false);
  assert.equal(first.status, "cancelled");
  assert.equal(first, second, "cancelling twice returns the one settled result");
  assert.equal(settlements.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(helper.killCalls, 1);
  assert.equal(await watcher.promise, first);
});

test("a helper that failed to spawn reports unproven quiescence without listeners", async () => {
  const clock = manualClock();
  const { watcher, failures, settlements } = supervise(undefined, { clock });
  const result = await watcher.promise;
  assert.equal(result.status, "spawn-failed");
  assert.equal(result.closeProven, false);
  assert.equal(failures.length, 1);
  assert.equal(settlements.length, 1);
});

test("a throwing caller callback cannot destabilize the helper lifecycle", async () => {
  const clock = manualClock();
  const helper = fakeHelper({
    onKill() {
      throw new Error("kill threw");
    }
  });
  const watcher = superviseTaskkillHelper(helper, {
    stopDeadlineAt: clock.now() + 500,
    closeDeadlineAt: clock.now() + 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    onFailure: () => {
      throw new Error("fallback threw");
    },
    onSettled: () => {
      throw new Error("evidence threw");
    }
  });

  helper.emit("exit", 1, null);
  helper.emit("close", 1, null);
  const result = await watcher.promise;
  // Both caller callbacks threw and the helper's own kill() threw. The watcher
  // still settles on the helper's exact close, and the kill() throw is recorded
  // as a diagnostic observation rather than as proof of anything.
  assert.equal(result.closeProven, true);
  assert.equal(result.status, "error");
  assert.equal(result.error.message, "kill threw");
  assert.equal(result.exitCode, 1);
});
