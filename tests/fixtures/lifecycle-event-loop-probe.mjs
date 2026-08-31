import { EventEmitter } from "node:events";
import { PROCESS_IDENTITY_STATUS } from "../../src/process-identity.mjs";
import { terminateClaudeChild } from "../../src/claude-runner.mjs";

/**
 * Runs one bounded lifecycle wait in a process that holds no other event-loop
 * handle, then reports whether the Promise settled before Node exited.
 *
 * This is the shape that failed on remote CI: with an unref'd deadline timer
 * the runtime drained its event loop while the custody decision was still
 * pending, and the Promise never settled ("Promise resolution is still pending
 * but the event loop has already resolved"). The child stubs below are plain
 * EventEmitters, so the deadline timer really is the only remaining handle.
 *
 * Prints RESOLVED <json> on success and, from the exit hook, SETTLED <bool>.
 */
const mode = process.argv[2];

// Never emits close/exit, so only the bounded deadline can settle the wait.
function stalledChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => true;
  return child;
}

function liveObservation(pid) {
  return Object.freeze({
    status: PROCESS_IDENTITY_STATUS.ALIVE,
    identity: Object.freeze({
      pid,
      startTime: String(pid * 100),
      source: "probe-process-start"
    })
  });
}

let settled = false;
process.on("exit", () => {
  process.stdout.write("SETTLED " + String(settled) + "\n");
});

const pid = 424_242;
const child = stalledChild(pid);
let pending;

if (mode === "terminal-proof") {
  // Non-Windows path: child.kill() is requested, then the terminal-proof wait
  // must resolve on its deadline rather than hanging.
  pending = terminateClaudeChild(child, {
    platform: "linux",
    terminationTimeoutMs: 50
  });
} else if (mode === "terminator") {
  // Windows path: taskkill is spawned but never closes, so both the terminator
  // wait and the following terminal-proof wait must resolve on their deadlines.
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  const processIdentity = {
    executionId: "probe",
    agentType: "task",
    repositoryRoot: "C:\\probe\\repository",
    pid,
    startTime: String(pid * 100),
    source: "probe-process-start",
    child,
    startedAt: 1
  };
  pending = terminateClaudeChild(child, {
    platform: "win32",
    terminationTimeoutMs: 50,
    processIdentity,
    inspectProcess: async (queriedPid) => liveObservation(queriedPid),
    spawnTerminator: () => terminator
  });
} else {
  process.stdout.write("UNKNOWN MODE\n");
  process.exit(2);
}

pending.then((result) => {
  settled = true;
  process.stdout.write("RESOLVED " + JSON.stringify(result) + "\n");
});
