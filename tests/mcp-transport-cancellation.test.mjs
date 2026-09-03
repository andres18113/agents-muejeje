import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

function ensureFakeClaude() {
  if (!existsSync(fakeClaudeExe)) {
    const res = spawnSync(cscPath, ["/nologo", "/out:" + fakeClaudeExe, fakeClaudeSource], {
      windowsHide: true,
      shell: false
    });
    assert.equal(res.status, 0, "Failed to compile FakeClaude.cs: " + (res.stderr || res.stdout));
  }
}

test("transport-level request cancellation aborts child execution, proves termination, and releases custody", async () => {
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

  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.toLowerCase() === "localappdata") delete cleanEnv[k];
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
    return new Promise((resolve) => {
      pending.set(id, resolve);
      serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  const sendNotification = (method, params = {}) => {
    serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  try {
    // 1. Initialize MCP connection and await server acknowledgement
    const initRes = await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hermetic-cancellation-client", version: "1.0.0" }
    });
    assert.equal(initRes.result.serverInfo.name, "claude-agents");

    sendNotification("notifications/initialized");

    // 2. Invoke delegate_agent tool (starts FakeClaude which hangs)
    const callPromise = sendRequest("tools/call", {
      name: "delegate_agent",
      arguments: {
        agent_type: "task",
        task: "run long task to be cancelled",
        cwd: testRepo
      }
    });

    // 3. Wait for child to be spawned and reach durable ACTIVE state
    const durableRoot = defaultDurableStateRoot({ env: { LOCALAPPDATA: stateRoot } });
    const initialWorkspace = await resolveCanonicalWorkspaceRoot(testRepo);
    const resolvedWorkspace = await resolveRepositoryCoordinationIdentity(initialWorkspace);
    const repoKey = resolvedWorkspace.canonicalRepositoryKey;
    const custody = new DurableWriteCustodyManager({ stateRoot: durableRoot });

    let activeRecord = null;
    for (let i = 0; i < 50; i++) {
      activeRecord = await custody.getWriteAccess(repoKey);
      if (activeRecord?.state === "ACTIVE") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(activeRecord?.state, "ACTIVE", "Execution must reach durable ACTIVE state before cancellation");

    // 4. Send protocol-level cancellation notification
    sendNotification("notifications/cancelled", {
      requestId: 2,
      reason: "transport client disconnected"
    });

    // 5. Poll for durable state to settle to RELEASED
    let custodyReleased = false;
    for (let i = 0; i < 50; i++) {
      const current = await custody.getWriteAccess(repoKey);
      if (current === undefined) {
        custodyReleased = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(custodyReleased, true, "Active write custody must be cleanly released after cancellation");

    // 6. Verify archived execution history transitions and terminal proof
    const repoStateDir = repositoryStateDirectoryIn(durableRoot, repoKey);
    const execDir = path.join(repoStateDir, "executions");
    const executionDirs = await readdir(execDir);
    assert.equal(executionDirs.length, 1, "Exactly one execution must be archived");

    const recordText = await readFile(path.join(execDir, executionDirs[0], "record.json"), "utf8");
    const record = JSON.parse(recordText);

    assert.equal(record.state, "RELEASED");
    const states = record.transitions.map((t) => t.state);
    assert.ok(states.includes("SPAWNING"), "Transitions must include SPAWNING");
    assert.ok(states.includes("ACTIVE"), "Transitions must include ACTIVE");
    assert.ok(states.includes("TERMINATING"), "Transitions must include TERMINATING");
    assert.ok(states.includes("TERMINAL_PROVEN"), "Transitions must include TERMINAL_PROVEN");
    assert.ok(states.includes("RELEASED"), "Transitions must include RELEASED");
    assert.equal(record.terminalProof?.kind, "child-event");
    assert.equal(record.terminalProof?.event, "close");
  } finally {
    serverChild.kill();
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  }
});
