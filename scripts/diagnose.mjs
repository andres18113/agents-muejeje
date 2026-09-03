import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AGENT_REGISTRY } from "../src/agent-registry.mjs";
import { evaluateDiagnoseTimeout } from "../src/diagnose-timeout.mjs";
import {
  RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC,
  REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS
} from "../src/timeout-policy.mjs";

const MINIMUM_NODE_MAJOR = 20;

function commandVersion(commands, args = ["--version"]) {
  for (const command of Array.isArray(commands) ? commands : [commands]) {
    const isWindowsCommandShim = process.platform === "win32" && command.endsWith(".cmd");
    const executable = isWindowsCommandShim ? (process.env.ComSpec || "cmd.exe") : command;
    const commandArgs = isWindowsCommandShim ? ["/d", "/s", "/c", command, ...args] : args;
    const result = spawnSync(executable, commandArgs, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      shell: false
    });
    if (result.error?.code === "ENOENT") continue;
    if (result.error) return { status: "error", detail: result.error.code || result.error.name };
    const output = (result.stdout || result.stderr || "").trim().split(/\r?\n/u)[0];
    return result.status === 0
      ? { status: "available", version: output || "version unavailable" }
      : { status: "error", detail: "exit-" + String(result.status) };
  }
  return { status: "missing" };
}

function readCodexConfiguredTimeout() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, "utf8");
    const headerMatch = content.match(/\[mcp_servers\.(?:claude-agents|"claude-agents"|'claude-agents')\]/);
    if (!headerMatch) return null;
    const after = content.slice(headerMatch.index);
    const nextSection = after.slice(1).search(/\r?\n\[/);
    const section = nextSection !== -1 ? after.slice(0, nextSection + 1) : after;
    const timeoutMatch = section.match(/tool_timeout_sec\s*=\s*(\d+)/);
    if (timeoutMatch) return Number(timeoutMatch[1]);
    return 300; // Codex default when not specified
  } catch {
    return null;
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const tools = {
  node: {
    status: Number.isSafeInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
      ? "available"
      : "unsupported",
    version: process.version,
    minimum: ">=" + MINIMUM_NODE_MAJOR
  },
  npm: commandVersion(process.platform === "win32" ? "npm.cmd" : "npm"),
  git: commandVersion("git"),
  codex: commandVersion(process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex"]
    : "codex"),
  claude: commandVersion(process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude"]
    : "claude")
};

for (const [name, diagnostic] of Object.entries(tools)) {
  const details = [diagnostic.version, diagnostic.minimum ? "required " + diagnostic.minimum : ""]
    .filter(Boolean)
    .join("; ");
  console.log(name.padEnd(7), diagnostic.status.padEnd(11), details || diagnostic.detail || "");
}

const configuredCodexTimeoutSec = readCodexConfiguredTimeout();
const { maxProfileTimeoutMs, effectiveDelegateTimeout, timeoutSafety } = evaluateDiagnoseTimeout({
  registry: AGENT_REGISTRY,
  codexTimeoutSec: configuredCodexTimeoutSec,
  env: process.env
});

console.log("profile-max-useful-work", (maxProfileTimeoutMs / 1000) + "s", `(${maxProfileTimeoutMs / 60000}m)`);
console.log(
  "effective-delegate-useful-work",
  effectiveDelegateTimeout.valid
    ? (effectiveDelegateTimeout.timeoutMs / 1000) + "s (" + effectiveDelegateTimeout.source + ")"
    : "unsafe " + effectiveDelegateTimeout.source
);
console.log("settlement-budget", (REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS / 1000) + "s", `(${REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS / 60000}m)`);
console.log(
  "min-safe-client-timeout",
  Number.isFinite(timeoutSafety.minSafeTimeoutSec) ? timeoutSafety.minSafeTimeoutSec + "s" : "unavailable"
);
console.log("recommended-codex-timeout", RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC + "s");
console.log(
  "configured-codex-timeout",
  configuredCodexTimeoutSec !== null
    ? configuredCodexTimeoutSec + "s"
    : "not configured (default 300s)"
);
console.log("timeout-hierarchy", timeoutSafety.safe ? "safe" : "unsafe", timeoutSafety.message);

const repositoryReady = tools.node.status === "available" &&
  tools.npm.status === "available" && tools.git.status === "available";
const registrationReady = repositoryReady &&
  tools.codex.status === "available" && tools.claude.status === "available";

console.log("repository-validation", repositoryReady ? "ready" : "blocked");

if (!registrationReady) {
  console.log("mcp-registration", "prerequisites-missing");
} else if (!timeoutSafety.safe) {
  console.log("mcp-registration", "unsafe-timeout-configuration");
} else {
  console.log("mcp-registration", "prerequisites-present");
}

console.log("Authentication is intentionally not inspected by this credential-free diagnostic.");

if (!repositoryReady) process.exitCode = 1;
