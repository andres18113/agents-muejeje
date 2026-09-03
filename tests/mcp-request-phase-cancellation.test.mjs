import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureServer = path.join(projectRoot, "tests", "fixtures", "request-phase-cancellation-server.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition, { timeoutMs = 8_000, intervalMs = 25, detail = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(intervalMs);
  }
  assert.fail(`Timed out waiting for ${detail}`);
}

function startClient(serverChild) {
  let buffered = "";
  let nextId = 1;
  const pending = new Map();
  let stderr = "";
  serverChild.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  serverChild.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return {
    get stderr() { return stderr; },
    request(method, params = {}) {
      const id = nextId++;
      const response = new Promise((resolve) => pending.set(id, resolve));
      serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return { id, response };
    },
    notify(method, params = {}) {
      serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }
  };
}

async function responseWithin(response, milliseconds, stderr) {
  return await Promise.race([
    response,
    delay(milliseconds).then(() => assert.fail("MCP response timed out: " + stderr))
  ]);
}

async function withTransport(phase, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-stdio-phase-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const stateRoot = path.join(fixtureRoot, "state");
  const markerDirectory = path.join(fixtureRoot, "markers");
  const serverChild = spawn(process.execPath, [fixtureServer], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CLAUDE_AGENTS_TEST_PHASE: phase,
      CLAUDE_AGENTS_TEST_STATE_ROOT: stateRoot,
      CLAUDE_AGENTS_TEST_MARKER_DIRECTORY: markerDirectory
    }
  });
  try {
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "core.autocrlf", "false"]);
    git(repositoryRoot, ["config", "user.name", "STDIO Cancellation Test"]);
    git(repositoryRoot, ["config", "user.email", "stdio@example.invalid"]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# transport fixture\n", "utf8");
    git(repositoryRoot, ["add", "README.md"]);
    git(repositoryRoot, ["commit", "-m", "fixture"]);

    const client = startClient(serverChild);
    const initialized = client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "request-phase-cancellation-test", version: "1.0.0" }
    });
    const initializedResponse = await responseWithin(initialized.response, 5_000, client.stderr);
    assert.equal(initializedResponse.result?.serverInfo?.name, "claude-agents-cancellation-fixture");
    client.notify("notifications/initialized");
    const workspace = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(repositoryRoot)
    );
    await callback({
      client,
      repositoryRoot,
      markerDirectory,
      custody: new DurableWriteCustodyManager({ stateRoot }),
      repositoryKey: workspace.canonicalRepositoryKey
    });
  } finally {
    serverChild.kill();
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

async function cancelAtMarker({ client, markerDirectory, marker, request }) {
  const markerPath = path.join(markerDirectory, marker + ".ready");
  await waitFor(() => existsSync(markerPath), { detail: marker + " marker" });
  client.notify("notifications/cancelled", { requestId: request.id, reason: "transport cancellation test" });
  // MCP cancellation may intentionally suppress the original response. The
  // durable custody state, rather than an optional late response, proves that
  // cancellation reached the request lifecycle.
  await delay(50);
}

test("STDIO cancellation during worktree preparation releases unstarted custody", async () => {
  await withTransport("worktree-preparation", async ({ client, repositoryRoot, markerDirectory, custody, repositoryKey }) => {
    const request = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "general-purpose", task: "stall worktree preparation", cwd: repositoryRoot }
    });
    await waitFor(async () => Boolean(await custody.getWriteAccess(repositoryKey)), { detail: "worktree reservation" });
    await cancelAtMarker({ client, markerDirectory, marker: "worktree-preparation", request });
    await waitFor(async () => (await custody.getWriteAccess(repositoryKey)) === undefined, {
      detail: "released worktree custody"
    });
  });
});

test("STDIO cancellation during BEFORE history discovery releases coherent review custody", async () => {
  await withTransport("before-history", async ({ client, repositoryRoot, markerDirectory, custody, repositoryKey }) => {
    const request = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "code-review", task: "stall before history", cwd: repositoryRoot }
    });
    await waitFor(async () => Boolean(await custody.getWriteAccess(repositoryKey)), { detail: "coherent review reservation" });
    await cancelAtMarker({ client, markerDirectory, marker: "before-history", request });
    await waitFor(async () => (await custody.getWriteAccess(repositoryKey)) === undefined, {
      detail: "released coherent review custody"
    });
  });
});

test("STDIO cancellation during authoritative recovery remains custody-free", async () => {
  await withTransport("authoritative-recovery", async ({ client, repositoryRoot, markerDirectory, custody, repositoryKey }) => {
    const seed = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "code-review", task: "seed durable receipt", cwd: repositoryRoot }
    });
    const seeded = await responseWithin(seed.response, 8_000, client.stderr);
    assert.equal(seeded.result?.isError, undefined, JSON.stringify(seeded));
    const request = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "code-review", task: "stall authoritative recovery", reconcile_only: true, cwd: repositoryRoot }
    });
    await cancelAtMarker({ client, markerDirectory, marker: "authoritative-recovery", request });
    assert.equal(await custody.getWriteAccess(repositoryKey), undefined);
  });
});

test("STDIO cancellation during reconcile artifact recovery remains custody-free", async () => {
  await withTransport("reconcile-artifact", async ({ client, repositoryRoot, markerDirectory, custody, repositoryKey }) => {
    const seed = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "code-review", task: "seed durable receipt", cwd: repositoryRoot }
    });
    const seeded = await responseWithin(seed.response, 8_000, client.stderr);
    assert.equal(seeded.result?.isError, undefined, JSON.stringify(seeded));
    const request = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "code-review", task: "stall artifact recovery", reconcile_only: true, cwd: repositoryRoot }
    });
    await cancelAtMarker({ client, markerDirectory, marker: "reconcile-artifact", request });
    assert.equal(await custody.getWriteAccess(repositoryKey), undefined);
  });
});
