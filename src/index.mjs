import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerDelegateAgentTool } from "./delegate-agent.mjs";

const SERVER_NAME = "claude-agents";
const SERVER_VERSION = "0.2.0";

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
