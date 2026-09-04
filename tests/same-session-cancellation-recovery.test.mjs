import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultDurableStateRoot } from "../src/custody/durable-store.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";

/**
 * Cancelling a writer must not cost the repository its next writer.
 *
 * A cancelled request loses the authority to do further work. It does not lose
 * the fact that it already took durable custody, and the exact child it spawned
 * may still have closed under it. When those two authorities were the same
 * thing, a cancelled writer left an ACTIVE record nobody had standing to
 * return: the coordinator was alive, so reconciliation correctly refused to
 * reclaim the slot, and every later writer in that session was refused too.
 * Restarting the MCP server was the only way out.
 *
 * These tests fix both halves of the corrected rule against a real server, a
 * real repository and a real durable store. A cancelled execution that can
 * prove its child closed settles its own custody and the next writer proceeds;
 * one that cannot prove it stays exactly where it is, and the next writer is
 * still refused. Exclusion is never traded for availability.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaudeSource = path.join(repoRoot, "tests", "fixtures", "FakeClaude.cs");
const fakeClaudeExe = path.join(repoRoot, "tests", "fixtures", "fake-claude.exe");
const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

// Watchdogs only. Every wait below ends on a durable condition or on proof that
// the condition can no longer occur; these bounds exist so a hung run fails.
const READINESS_WATCHDOG_MS = 120_000;
const SETTLEMENT_WATCHDOG_MS = 60_000;
const POLL_INTERVAL_MS = 50;

function ensureFakeClaude() {
  if (!existsSync(fakeClaudeExe)) {
    const res = spawnSync(cscPath, ["/nologo", "/out:" + fakeClaudeExe, fakeClaudeSource], {
      windowsHide: true,
      shell: false
    });
    assert.equal(res.status, 0, "Failed to compile FakeClaude.cs: " + (res.stderr || res.stdout));
  }
}

async function withCoordinator(callback) {
  ensureFakeClaude();
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "same-session-cancel-"));
  const testRepo = path.join(fixtureRoot, "repo");
  const stateRoot = path.join(fixtureRoot, "state");
  const tempDir = path.join(fixtureRoot, "temp");
  await mkdir(testRepo, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  spawnSync("git", ["init", "-b", "main"], { cwd: testRepo });
  spawnSync("git", ["config", "user.name", "Same Session Test"], { cwd: testRepo });
  spawnSync("git", ["config", "user.email", "same-session@example.invalid"], { cwd: testRepo });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: testRepo });
  await writeFile(path.join(testRepo, "README.md"), "# same session fixture\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: testRepo });
  spawnSync("git", ["commit", "-m", "init"], { cwd: testRepo });

  const scenarioFile = path.join(tempDir, "fake-claude-scenario.json");
  await writeFile(scenarioFile, JSON.stringify({ scenario: "hang" }), "utf8");

  // The server reads its own configuration from the environment, so the whole
  // CLAUDE_AGENTS_* surface is declared here rather than inherited.
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
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {}
    }
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    const call = { id, settled: false };
    const response = new Promise((resolve) => pending.set(id, resolve));
    serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    call.response = response.then((message) => {
      call.settled = true;
      return message;
    });
    return call;
  };
  const notify = (method, params = {}) => {
    serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "same-session-client", version: "1.0.0" }
    }).response;
    assert.equal(initialized.result?.serverInfo?.name, "claude-agents");
    notify("notifications/initialized");

    const durableRoot = defaultDurableStateRoot({ env: { LOCALAPPDATA: stateRoot } });
    const workspace = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(testRepo)
    );
    await callback({
      request,
      notify,
      testRepo,
      scenarioFile,
      custody: new DurableWriteCustodyManager({ stateRoot: durableRoot }),
      repositoryKey: workspace.canonicalRepositoryKey,
      diagnostics: () => ({ serverExit, serverStderr: serverStderr.slice(-1500) })
    });
  } finally {
    serverChild.kill();
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }).catch(() => {});
  }
}

const delegate = (request, args) => request("tools/call", { name: "delegate_agent", arguments: args });

/** Waits for a durable condition, or for proof the request can no longer reach it. */
async function waitForDurable(custody, repositoryKey, predicate, { call, detail, diagnostics }) {
  const deadline = Date.now() + READINESS_WATCHDOG_MS;
  let last;
  while (Date.now() < deadline) {
    last = await custody.getWriteAccess(repositoryKey);
    if (predicate(last)) return last;
    if (call?.settled) {
      assert.fail(
        "Cannot reach " + detail + ": the delegation answered first. " +
          JSON.stringify({ last: last?.state ?? null, ...diagnostics?.() })
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  assert.fail(
    "Timed out waiting for " + detail + ". " +
      JSON.stringify({ last: last?.state ?? null, ...diagnostics?.() })
  );
}

test("a cancelled writer settles its own custody and the same session admits the next writer", async () => {
  await withCoordinator(async ({ request, notify, testRepo, scenarioFile, custody, repositoryKey, diagnostics }) => {
    const writerA = delegate(request, {
      agent_type: "task",
      task: "writer A to be cancelled while active",
      cwd: testRepo
    });
    const active = await waitForDurable(custody, repositoryKey, (record) => record?.state === "ACTIVE", {
      call: writerA,
      detail: "writer A durable ACTIVE",
      diagnostics
    });
    assert.ok(Number.isSafeInteger(active.claudeProcess?.pid));

    notify("notifications/cancelled", { requestId: writerA.id, reason: "transport client disconnected" });

    // The cancelled execution proves its exact child closed, so it settles the
    // custody it owns. Nothing else about the coordinator changes.
    const settlementDeadline = Date.now() + SETTLEMENT_WATCHDOG_MS;
    let free = false;
    while (Date.now() < settlementDeadline) {
      if (!(await custody.getWriteAccess(repositoryKey))) {
        free = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.ok(
      free,
      "A cancelled writer holding exact terminal proof must return its own custody. " +
        JSON.stringify(diagnostics())
    );

    // The decisive property: the very same coordinator process, never restarted,
    // admits the next writer for the same repository.
    await rm(scenarioFile, { force: true });
    const writerB = await delegate(request, {
      agent_type: "task",
      task: "writer B in the same session",
      cwd: testRepo
    }).response;
    const outcomeB = writerB.result?.structuredContent ?? writerB.result?.structured_content;
    assert.equal(
      outcomeB?.status,
      "completed",
      "Writer B must proceed without restarting the MCP server: " + JSON.stringify({ outcomeB, ...diagnostics() })
    );
    assert.notEqual(outcomeB.execution.id, active.executionId);
  });
});

test("a cancelled writer without exact terminal proof keeps custody and still excludes the next writer", async () => {
  await withCoordinator(async ({ request, notify, testRepo, custody, repositoryKey, diagnostics }) => {
    // general-purpose prepares an isolated worktree before it ever spawns, so
    // cancelling here stops the request while custody is held by an execution
    // whose process demonstrably never started. That is an inference, not close
    // proof, and it must not be enough to release.
    const writerA = delegate(request, {
      agent_type: "general-purpose",
      task: "writer A cancelled before its child can start",
      cwd: testRepo
    });
    const reserved = await waitForDurable(custody, repositoryKey, (record) => Boolean(record), {
      call: writerA,
      detail: "writer A durable reservation",
      diagnostics
    });
    // Any pre-spawn state will do; what matters is that no child is proven to
    // have run, so no close proof can exist for this execution.
    assert.notEqual(reserved.state, "ACTIVE", reserved.state);

    notify("notifications/cancelled", { requestId: writerA.id, reason: "transport client disconnected" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const retained = await custody.getWriteAccess(repositoryKey);
    assert.ok(
      retained,
      "Custody without exact terminal proof must be retained for reconciliation. " + JSON.stringify(diagnostics())
    );
    assert.notEqual(retained.state, "RELEASED");
    assert.equal(retained.executionId, reserved.executionId);

    // And the exclusion the retained record represents is still enforced.
    const writerB = await delegate(request, {
      agent_type: "task",
      task: "writer B must be refused while custody is retained",
      cwd: testRepo
    }).response;
    const outcomeB = writerB.result?.structuredContent ?? writerB.result?.structured_content;
    assert.equal(outcomeB?.status, "failed", JSON.stringify({ outcomeB, ...diagnostics() }));
    assert.equal(outcomeB.execution.error.code, "write_custody_conflict");
  });
});
