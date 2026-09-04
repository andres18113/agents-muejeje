import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultDurableStateRoot, repositoryStateDirectoryIn } from "../src/custody/durable-store.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaudeSource = path.join(repoRoot, "tests", "fixtures", "FakeClaude.cs");
const fakeClaudeExe = path.join(repoRoot, "tests", "fixtures", "fake-claude.exe");
const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

/**
 * This test exercises exactly one thing: a request that is already durably
 * ACTIVE is cancelled at the transport, and custody must be retained rather
 * than released by post-stop cleanup.
 *
 * Everything before that cancellation is setup, and setup is not the subject.
 * The readiness path spends its time in real subprocesses - several `git`
 * invocations plus two Windows process-identity queries, one for the
 * coordinator and one for the spawned child - so its wall-clock duration is a
 * property of machine load, not of the behaviour under test. Measured on this
 * project it ranges from under a second when idle to over eleven seconds while
 * two full suites run concurrently.
 *
 * A fixed readiness budget therefore tests the machine. These bounds are
 * watchdogs instead: they exist only so a genuinely hung run fails instead of
 * hanging forever, and they are an order of magnitude above the slowest
 * observed healthy readiness. Progress is decided by the durable record, never
 * by the clock.
 */
const READINESS_WATCHDOG_MS = 120_000;
const TERMINATION_WATCHDOG_MS = 60_000;
// Only a watchdog over the scoped terminal settlement a cancelled execution is
// still entitled to perform.
const SETTLEMENT_WATCHDOG_MS = 60_000;
const POLL_INTERVAL_MS = 50;

/** Durable states from which the delegation can no longer reach ACTIVE. */
const SETTLED_STATES = new Set(["RELEASED", "ORPHANED", "HANDOFF_READY", "TERMINAL_PROVEN"]);

function ensureFakeClaude() {
  if (!existsSync(fakeClaudeExe)) {
    const res = spawnSync(cscPath, ["/nologo", "/out:" + fakeClaudeExe, fakeClaudeSource], {
      windowsHide: true,
      shell: false
    });
    assert.equal(res.status, 0, "Failed to compile FakeClaude.cs: " + (res.stderr || res.stdout));
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("transport-level request cancellation aborts child execution and settles its own custody", async () => {
  ensureFakeClaude();

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-cancel-hermetic-"));
  const testRepo = path.join(fixtureRoot, "repo");
  const stateRoot = path.join(fixtureRoot, "state");
  const tempDir = path.join(fixtureRoot, "temp");
  await mkdir(testRepo, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  spawnSync("git", ["init", "-b", "main"], { cwd: testRepo });
  spawnSync("git", ["config", "user.name", "Hermetic Test"], { cwd: testRepo });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: testRepo });
  await writeFile(path.join(testRepo, "README.md"), "# Hermetic Cancellation Test\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: testRepo });
  spawnSync("git", ["commit", "-m", "init"], { cwd: testRepo });

  await writeFile(path.join(tempDir, "fake-claude-scenario.json"), JSON.stringify({ scenario: "hang" }), "utf8");

  // The server under test reads its own configuration from the environment,
  // including CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS, which caps the useful-work
  // envelope and therefore the whole root request. An operator override present
  // in the developer's shell would silently move that bound into the readiness
  // path this test waits on, so the fixture declares the entire CLAUDE_AGENTS_*
  // surface itself instead of inheriting it. With no override the `task`
  // profile's own 20-minute envelope applies, which is far outside any
  // readiness time this test can observe.
  const cleanEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (upper === "LOCALAPPDATA" || upper.startsWith("CLAUDE_AGENTS_")) continue;
    cleanEnv[name] = value;
  }
  cleanEnv.LOCALAPPDATA = stateRoot;
  cleanEnv.TEMP = tempDir;
  cleanEnv.TMP = tempDir;
  cleanEnv.CLAUDE_AGENTS_CLAUDE_BIN = fakeClaudeExe;

  const serverChild = spawn("node", ["src/index.mjs"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv
  });
  let serverExit;
  serverChild.on("exit", (code, signal) => {
    serverExit = { code, signal };
  });
  let serverStderr = "";
  serverChild.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString("utf8");
  });

  let buffer = "";
  const pending = new Map();
  let nextId = 1;

  serverChild.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });

  const sendRequest = (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolve) => {
      pending.set(id, resolve);
      serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    return { id, response };
  };

  const sendNotification = (method, params = {}) => {
    serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  const startedAt = Date.now();
  // Bounded: one entry per observed change, not per poll.
  const stateTrace = [];

  try {
    // 1. Initialize MCP connection and await server acknowledgement
    const initCall = sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hermetic-cancellation-client", version: "1.0.0" }
    });
    const initRes = await initCall.response;
    assert.equal(initRes.result.serverInfo.name, "claude-agents");

    sendNotification("notifications/initialized");

    // 2. Invoke delegate_agent tool (starts FakeClaude which hangs)
    const toolCall = sendRequest("tools/call", {
      name: "delegate_agent",
      arguments: {
        agent_type: "task",
        task: "run long task to be cancelled",
        cwd: testRepo
      }
    });
    // A cancelled request is never answered, so this response only ever arrives
    // when the delegation settled on its own - which means the scenario under
    // test never happened and the wait below must stop and say so.
    let toolResponse;
    void toolCall.response.then((msg) => {
      toolResponse = msg;
    });

    const durableRoot = defaultDurableStateRoot({ env: { LOCALAPPDATA: stateRoot } });
    const initialWorkspace = await resolveCanonicalWorkspaceRoot(testRepo);
    const resolvedWorkspace = await resolveRepositoryCoordinationIdentity(initialWorkspace);
    const repoKey = resolvedWorkspace.canonicalRepositoryKey;
    const custody = new DurableWriteCustodyManager({ stateRoot: durableRoot });

    const readDurable = async () => {
      try {
        return { record: await custody.getWriteAccess(repoKey) };
      } catch (error) {
        return { readError: error?.code || error?.name || String(error) };
      }
    };
    const observe = (label, { record, readError } = {}) => {
      const state = record?.state ?? (readError ? "read-error:" + readError : "absent");
      const last = stateTrace[stateTrace.length - 1];
      if (last?.label === label && last?.state === state) return state;
      stateTrace.push({
        at: Date.now() - startedAt,
        label,
        state,
        revision: record?.revision,
        transitions: record?.transitions?.map((transition) => transition.state).join(">"),
        ...(record?.orphanReason ? { orphanReason: record.orphanReason } : {})
      });
      return state;
    };
    const diagnose = (summary) => {
      const outcome = toolResponse?.result?.structuredContent ?? toolResponse?.result?.structured_content;
      return [
        summary,
        "stateTrace=" + JSON.stringify(stateTrace),
        "toolResponded=" + Boolean(toolResponse),
        "toolError=" + JSON.stringify(outcome?.execution?.error ?? null),
        "toolCustody=" + JSON.stringify(outcome?.custody ?? null),
        "serverExit=" + JSON.stringify(serverExit ?? null),
        "serverStderr=" + JSON.stringify(serverStderr.slice(-1500))
      ].join("\n  ");
    };

    // 3. Wait for the durable ACTIVE state itself. The loop ends on a real
    // condition - ACTIVE reached, or the delegation provably unable to reach it
    // - and the watchdog exists only so a hang cannot stall the suite.
    let activeRecord = null;
    let unreachable;
    const readinessDeadline = Date.now() + READINESS_WATCHDOG_MS;
    while (Date.now() < readinessDeadline) {
      const observation = await readDurable();
      const state = observe("readiness", observation);
      if (state === "ACTIVE") {
        activeRecord = observation.record;
        break;
      }
      if (SETTLED_STATES.has(state)) {
        unreachable = "the delegation settled in " + state + " before reaching ACTIVE";
        break;
      }
      if (toolResponse) {
        unreachable = "the delegation answered tools/call before reaching ACTIVE";
        break;
      }
      if (serverExit) {
        unreachable = "the MCP server exited before the delegation reached ACTIVE";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    assert.ok(
      activeRecord,
      diagnose(
        unreachable
          ? "Execution could not reach durable ACTIVE: " + unreachable +
            ". The transport-cancellation scenario was never entered, so this run proves nothing about it."
          : "Execution did not reach durable ACTIVE within the " + READINESS_WATCHDOG_MS +
            "ms readiness watchdog."
      )
    );

    // 4. Send protocol-level cancellation notification for the exact request id
    sendNotification("notifications/cancelled", {
      requestId: toolCall.id,
      reason: "transport client disconnected"
    });

    // 5. Cancellation must actually reach the child. The durable record names
    // the exact Claude process, so its disappearance is the real signal that
    // forced termination ran, rather than an assumed interval. Pid reuse cannot
    // make this wait wrong: it is only a synchronization hint, and every
    // assertion below is made against the durable record.
    const claudePid = activeRecord.claudeProcess?.pid;
    assert.ok(Number.isSafeInteger(claudePid), diagnose("Durable ACTIVE record must name the Claude process."));
    const terminationDeadline = Date.now() + TERMINATION_WATCHDOG_MS;
    let terminated = false;
    while (Date.now() < terminationDeadline) {
      if (!processIsAlive(claudePid)) {
        terminated = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.ok(
      terminated,
      diagnose("Cancellation must force-terminate the exact Claude child (pid " + claudePid + ").")
    );

    // 6. The request has lost the authority to do further work, but this
    // invocation still owns one execution whose exact child provably closed.
    // That is the one thing it may settle, and it must: otherwise the slot
    // stays held by a coordinator that can no longer prove anything about a
    // process that is already gone. The settlement is scoped to this execution
    // and revision alone, so it can never touch anything started afterwards.
    const settlementDeadline = Date.now() + SETTLEMENT_WATCHDOG_MS;
    let settled = false;
    while (Date.now() < settlementDeadline) {
      const observation = await readDurable();
      observe("post-stop", observation);
      if (!observation.record) {
        settled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.ok(
      settled,
      diagnose("A cancelled execution holding exact terminal proof must return its own custody.")
    );

    // 7. The returned custody is archived as history, and that history shows the
    // whole lifecycle: it ran, it was proven terminal, and it was released.
    const archived = JSON.parse(await readFile(
      path.join(
        repositoryStateDirectoryIn(durableRoot, repoKey),
        "executions",
        activeRecord.executionId,
        "record.json"
      ),
      "utf8"
    ));
    const states = archived.transitions.map((t) => t.state);
    assert.equal(archived.state, "RELEASED", diagnose("Settled custody must be archived as RELEASED"));
    assert.ok(states.includes("SPAWNING"), diagnose("Transitions must include SPAWNING"));
    assert.ok(states.includes("ACTIVE"), diagnose("Transitions must include ACTIVE"));
    assert.ok(
      states.includes("TERMINAL_PROVEN"),
      diagnose("Release must rest on proven termination, never on an assumption")
    );
  } finally {
    serverChild.kill();
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  }
});
