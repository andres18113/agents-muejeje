import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";
import { inspectSyntheticProcess } from "./fixtures/synthetic-process-identity.mjs";

// Matches the identities the spawned server fixture mints.
const inspectProcess = inspectSyntheticProcess("stdio-cancellation-fixture");
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

/**
 * Waits for a real condition, not for an interval.
 *
 * Readiness here runs through a spawned MCP server, several git subprocesses
 * and a Windows process-identity query, so its duration is a property of
 * machine load rather than of the behaviour under test, and a fixed budget
 * measures the machine. This ends on the condition, or as soon as the scenario
 * becomes unreachable, and its remaining bound is a watchdog set an order of
 * magnitude above the slowest observed healthy readiness so only a genuinely
 * hung run fails on time.
 */
const READINESS_WATCHDOG_MS = 120_000;

async function waitFor(condition, {
  timeoutMs = READINESS_WATCHDOG_MS,
  intervalMs = 25,
  detail = "condition",
  unreachable,
  diagnose
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    const blocked = await unreachable?.();
    if (blocked) {
      assert.fail(
        `Cannot reach ${detail}: ${blocked}. The scenario was never entered, so this run proves nothing about it.` +
          (diagnose ? "; " + (await diagnose()) : "")
      );
    }
    await delay(intervalMs);
  }
  assert.fail(
    `Timed out waiting for ${detail} after ${timeoutMs}ms` + (diagnose ? "; " + (await diagnose()) : "")
  );
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
      const call = { id, settled: false };
      const response = new Promise((resolve) => pending.set(id, resolve));
      serverChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      // A request that has answered can no longer reach a phase marker, so a
      // readiness wait can stop at once instead of running out its watchdog.
      call.response = response.then((message) => {
        call.settled = true;
        return message;
      });
      return call;
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
      custody: new DurableWriteCustodyManager({ stateRoot, inspectProcess }),
      repositoryKey: workspace.canonicalRepositoryKey
    });
  } finally {
    serverChild.kill();
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

async function cancelAtMarker({ client, markerDirectory, marker, request }) {
  const markerPath = path.join(markerDirectory, marker + ".ready");
  await waitFor(() => existsSync(markerPath), {
    detail: marker + " marker",
    unreachable: () => (request.settled ? "the request answered before reaching the marker" : undefined),
    diagnose: () => "stderr=" + JSON.stringify(String(client.stderr).slice(-1200))
  });
  client.notify("notifications/cancelled", { requestId: request.id, reason: "transport cancellation test" });
  // MCP cancellation may intentionally suppress the original response. The
  // durable custody state, rather than an optional late response, proves that
  // cancellation reached the request lifecycle.
  await delay(50);
}

/**
 * A cancellation that lands before any child of the execution exists leaves the
 * coordinator able to prove something exact: this invocation still owns this
 * record, no Claude process of it was ever started, and preparation reported no
 * unproven side effect. That is proof of absence, not a deadline's assumption
 * that nothing started, and it is enough to return the invocation's own custody.
 *
 * Retaining here would lock the repository for the remaining life of the
 * coordinator - reconciliation cannot reclaim a slot whose coordinator is still
 * alive - which is the lockout this contract exists to prevent.
 */
test("STDIO cancellation before any child exists returns that invocation's own custody", async () => {
  await withTransport("worktree-preparation", async ({ client, repositoryRoot, markerDirectory, custody, repositoryKey }) => {
    const request = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "general-purpose", task: "stall worktree preparation", cwd: repositoryRoot }
    });
    await waitFor(async () => Boolean(await custody.getWriteAccess(repositoryKey)), {
      detail: "worktree reservation",
      unreachable: () => (request.settled ? "the delegation answered before taking custody" : undefined),
      diagnose: () => "stderr=" + JSON.stringify(String(client.stderr).slice(-1200))
    });
    await cancelAtMarker({ client, markerDirectory, marker: "worktree-preparation", request });
    await waitFor(async () => (await custody.getWriteAccess(repositoryKey)) === undefined, {
      detail: "settled worktree custody",
      diagnose: async () => "state=" + JSON.stringify(
        (await custody.getWriteAccess(repositoryKey))?.state ?? null
      )
    });
  });
});

test("STDIO cancellation during BEFORE history discovery returns the coherent review's own custody", async () => {
  await withTransport("before-history", async ({ client, repositoryRoot, markerDirectory, custody, repositoryKey }) => {
    const request = client.request("tools/call", {
      name: "delegate_agent",
      arguments: { agent_type: "code-review", task: "stall before history", cwd: repositoryRoot }
    });
    await waitFor(async () => Boolean(await custody.getWriteAccess(repositoryKey)), {
      detail: "coherent review reservation",
      unreachable: () => (request.settled ? "the delegation answered before taking custody" : undefined),
      diagnose: () => "stderr=" + JSON.stringify(String(client.stderr).slice(-1200))
    });
    await cancelAtMarker({ client, markerDirectory, marker: "before-history", request });
    // No reviewer process was ever spawned and no receipt authority was taken,
    // so the review can prove its own absence and returns the slot.
    await waitFor(async () => (await custody.getWriteAccess(repositoryKey)) === undefined, {
      detail: "settled coherent review custody",
      diagnose: async () => "state=" + JSON.stringify(
        (await custody.getWriteAccess(repositoryKey))?.state ?? null
      )
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
