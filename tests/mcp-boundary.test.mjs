import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { delegateAgentOutputSchema } from "../src/delegate-outcome.mjs";
import { FAKE_CLAUDE_EXE, ensureFakeClaude } from "./fixtures/fake-claude-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaudeExe = FAKE_CLAUDE_EXE;

class McpTestClient {
  #child;
  #buffer = "";
  #pendingRequests = new Map();
  #nextId = 1;
  #stderrOutput = "";

  constructor({ env = {} } = {}) {
    this.#child = spawn("node", ["src/index.mjs"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_AGENTS_CLAUDE_BIN: fakeClaudeExe,
        ...env
      }
    });

    this.#child.stdout.on("data", (chunk) => {
      this.#buffer += chunk.toString("utf8");
      const lines = this.#buffer.split("\n");
      this.#buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined && this.#pendingRequests.has(message.id)) {
          const { resolve } = this.#pendingRequests.get(message.id);
          this.#pendingRequests.delete(message.id);
          resolve(message);
        }
      }
    });

    this.#child.stderr.on("data", (chunk) => {
      this.#stderrOutput += chunk.toString("utf8");
    });
  }

  get stderr() {
    return this.#stderrOutput;
  }

  async sendRequest(method, params = {}) {
    const id = this.#nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    }) + "\n";

    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
      this.#child.stdin.write(payload);
    });
  }

  sendNotification(method, params = {}) {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    }) + "\n";
    this.#child.stdin.write(payload);
  }

  writeRaw(raw) {
    this.#child.stdin.write(raw);
  }

  async initialize() {
    const initRes = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "operational-test-client", version: "1.0.0" }
    });
    this.sendNotification("notifications/initialized");
    return initRes;
  }

  async close() {
    this.#child.kill();
  }
}

test("MCP boundary: startup does not pollute stdout and stderr carries diagnostic", async () => {
  ensureFakeClaude();
  const client = new McpTestClient();
  try {
    const initRes = await client.initialize();
    assert.equal(initRes.jsonrpc, "2.0");
    assert.ok(initRes.result);
    assert.equal(initRes.result.serverInfo.name, "claude-agents");
    assert.match(client.stderr, /\[claude-agents\] MCP stdio server ready; tool=delegate_agent/);
  } finally {
    await client.close();
  }
});

test("MCP boundary: exactly one public tool delegate_agent is exposed with correct schema", async () => {
  ensureFakeClaude();
  const client = new McpTestClient();
  try {
    await client.initialize();
    const listRes = await client.sendRequest("tools/list", {});
    assert.equal(listRes.jsonrpc, "2.0");
    assert.ok(listRes.result);
    assert.equal(listRes.result.tools.length, 1);

    const tool = listRes.result.tools[0];
    assert.equal(tool.name, "delegate_agent");
    assert.ok(tool.description.includes("fresh Claude Code process"));

    const schema = tool.inputSchema;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["agent_type", "task"]);
    assert.ok(schema.properties.agent_type);
    assert.ok(schema.properties.task);
    assert.ok(schema.properties.cwd);
    assert.ok(schema.properties.target_ref);

    assert.deepEqual(schema.properties.agent_type.enum, [
      "explore",
      "task",
      "general-purpose",
      "code-review",
      "research",
      "rubber-duck",
      "security-review"
    ]);
  } finally {
    await client.close();
  }
});

test("MCP boundary: valid tool invocation returns validated structured delegate outcome v1", async () => {
  ensureFakeClaude();
  const scenarioTmp = await mkdtemp(path.join(os.tmpdir(), "mcp-boundary-clean-"));
  const client = new McpTestClient({
    env: {
      TEMP: scenarioTmp,
      TMP: scenarioTmp
    }
  });
  try {
    await client.initialize();
    const callRes = await client.sendRequest("tools/call", {
      name: "delegate_agent",
      arguments: {
        agent_type: "explore",
        task: "Deterministic operational check of repository structure",
        cwd: repoRoot
      }
    });

    assert.equal(callRes.jsonrpc, "2.0");
    assert.ok(callRes.result);
    assert.ok(!callRes.result.isError, "Expected isError not to be true");
    assert.ok(Array.isArray(callRes.result.content));
    assert.equal(callRes.result.content[0].type, "text");

    const structured = callRes.result.structuredContent;
    assert.ok(structured);
    assert.equal(structured.schema, "claude-agents-mcp/delegate-outcome/v1");
    assert.equal(structured.status, "completed");
    assert.equal(structured.execution?.agentType, "explore");
    assert.equal(structured.execution?.status, "completed");

    // Validate using production Zod schema
    const validation = delegateAgentOutputSchema.safeParse(structured);
    assert.ok(validation.success, "Structured content failed output schema: " + JSON.stringify(validation.error?.issues));
  } finally {
    await client.close();
    await rm(scenarioTmp, { recursive: true, force: true });
  }
});

test("MCP boundary: malformed requests fail safely without crashing", async () => {
  ensureFakeClaude();
  const client = new McpTestClient();
  try {
    await client.initialize();

    // 1. Unknown tool
    const unknownToolRes = await client.sendRequest("tools/call", {
      name: "unknown_tool",
      arguments: {}
    });
    assert.ok(unknownToolRes.error || unknownToolRes.result?.isError);

    // 2. Missing required params (missing task)
    const missingTaskRes = await client.sendRequest("tools/call", {
      name: "delegate_agent",
      arguments: {
        agent_type: "explore"
      }
    });
    assert.ok(missingTaskRes.error || missingTaskRes.result?.isError);

    // 3. Invalid agent_type enum
    const invalidAgentRes = await client.sendRequest("tools/call", {
      name: "delegate_agent",
      arguments: {
        agent_type: "unregistered-super-agent",
        task: "do something"
      }
    });
    assert.ok(invalidAgentRes.error || invalidAgentRes.result?.isError);

    // 4. Server remains alive and answers subsequent legitimate request
    const legitimateRes = await client.sendRequest("tools/list", {});
    assert.equal(legitimateRes.result?.tools?.length, 1);
  } finally {
    await client.close();
  }
});

test("MCP boundary: internal failures become bounded public errors with no secret or contract leakage", async () => {
  ensureFakeClaude();
  const scenarioTmp = await mkdtemp(path.join(os.tmpdir(), "mcp-boundary-nonzero-"));
  const scenarioFile = path.join(scenarioTmp, "fake-claude-scenario.json");
  await writeFile(scenarioFile, JSON.stringify({ scenario: "nonzero" }), "utf8");

  const SECRET_TOKEN = "SUPER_SECRET_INTERNAL_KEY_987654321";
  const client = new McpTestClient({
    env: {
      PRIVATE_API_SECRET_KEY: SECRET_TOKEN,
      TEMP: scenarioTmp,
      TMP: scenarioTmp
    }
  });

  try {
    await client.initialize();
    const callRes = await client.sendRequest("tools/call", {
      name: "delegate_agent",
      arguments: {
        agent_type: "explore",
        task: "Should encounter non-zero specialist exit",
        cwd: repoRoot
      }
    });

    assert.equal(callRes.jsonrpc, "2.0");
    assert.ok(callRes.result);
    assert.equal(callRes.result.isError, true);

    const structured = callRes.result.structuredContent;
    assert.ok(structured);
    assert.equal(structured.status, "failed");
    const err = structured.error || structured.execution?.error;
    assert.ok(err, "Expected error object in structured output");
    assert.equal(err.code, "claude_non_zero_exit");

    const jsonString = JSON.stringify(callRes.result);
    assert.ok(!jsonString.includes(SECRET_TOKEN), "Secret leaked into tool response!");
    assert.ok(!jsonString.includes("PRIVATE_API_SECRET_KEY"), "Secret key leaked into tool response!");
    // Contract prompt should not leak into output
    assert.ok(!jsonString.includes("# You are Claude Code"), "Internal agent contract leaked into public output!");
  } finally {
    await client.close();
    await rm(scenarioTmp, { recursive: true, force: true });
  }
});
