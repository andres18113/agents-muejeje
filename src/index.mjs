import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerDelegateAgentTool } from "./delegate-agent.mjs";
import {
  effectiveDelegateTimeoutFromEnvironment,
  MAX_SUPPORTED_DELEGATE_TIMEOUT_MS
} from "./timeout-policy.mjs";
import { SERVER_VERSION } from "./version.mjs";

const SERVER_NAME = "claude-agents";
const effectiveDelegateTimeout = effectiveDelegateTimeoutFromEnvironment(process.env);

if (!effectiveDelegateTimeout.valid) {
  throw new Error(
    "CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS must be a positive integer no greater than " +
      MAX_SUPPORTED_DELEGATE_TIMEOUT_MS + " milliseconds."
  );
}

function createServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  registerDelegateAgentTool(server);
  return server;
}

void serveStdio(createServer);
console.error(`[${SERVER_NAME}] MCP stdio server ready; tool=delegate_agent`);
