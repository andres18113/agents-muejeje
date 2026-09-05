import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AGENT_REGISTRY } from "../src/agent-registry.mjs";
import { evaluateDiagnoseTimeout } from "../src/diagnose-timeout.mjs";
import {
  MINIMUM_RESTRICTED_CLAUDE_VERSION,
  REQUIRED_RESTRICTED_FLAG,
  evaluateClaudePreflight
} from "../src/claude-preflight.mjs";
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

/**
 * The executable production would actually launch, so the preflight inspects
 * the same binary rather than whatever happens to be first on PATH.
 */
function claudeCandidates() {
  const configured = process.env.CLAUDE_AGENTS_CLAUDE_BIN;
  if (typeof configured === "string" && configured.length > 0) return [configured];
  return process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
}

/**
 * Full output rather than its first line: a capability check has to read the
 * whole help text, and a one-line summary would report every build as lacking
 * every flag.
 */
function commandOutput(commands, args) {
  for (const command of commands) {
    const isWindowsCommandShim = process.platform === "win32" && command.endsWith(".cmd");
    const executable = isWindowsCommandShim ? (process.env.ComSpec || "cmd.exe") : command;
    const commandArgs = isWindowsCommandShim ? ["/d", "/s", "/c", command, ...args] : args;
    const result = spawnSync(executable, commandArgs, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false
    });
    if (result.error?.code === "ENOENT") continue;
    if (result.error) return undefined;
    return ((result.stdout || "") + (result.stderr || "")) || undefined;
  }
  return undefined;
}

/**
 * The exit status plus the combined output of one probe invocation. The
 * preflight needs both: a clean exit means the flag was accepted, while a
 * rejection needs a non-zero exit together with the diagnostic naming the
 * flag. Anything unobservable - a missing binary, a timeout, a spawn failure -
 * is undefined, which the preflight reads as inconclusive rather than as a
 * verdict.
 */
function commandProbe(commands, args) {
  for (const command of commands) {
    const isWindowsCommandShim = process.platform === "win32" && command.endsWith(".cmd");
    const executable = isWindowsCommandShim ? (process.env.ComSpec || "cmd.exe") : command;
    const commandArgs = isWindowsCommandShim ? ["/d", "/s", "/c", command, ...args] : args;
    const result = spawnSync(executable, commandArgs, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false
    });
    if (result.error?.code === "ENOENT") continue;
    if (result.error) return undefined;
    return { status: result.status, output: (result.stdout || "") + (result.stderr || "") };
  }
  return undefined;
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
  claude: commandVersion(claudeCandidates())
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

// Presence is not readiness. Production launches with --restricted, so a
// Claude Code that predates it fails on the first request; reporting such a
// system as ready would be reporting a system that cannot serve one call. The
// probe asks the binary itself - the flag plus --help, so it answers without
// doing any work - while the help text stays one-directional corroboration:
// mentioning the flag confirms it, omitting it proves nothing.
const claudeHelp = tools.claude.status === "available"
  ? commandOutput(claudeCandidates(), ["--help"])
  : undefined;
const claudeFlagProbe = tools.claude.status === "available"
  ? commandProbe(claudeCandidates(), [REQUIRED_RESTRICTED_FLAG, "--help"])
  : undefined;
const claudePreflight = evaluateClaudePreflight({
  versionText: tools.claude.status === "available" ? tools.claude.version : undefined,
  helpText: claudeHelp,
  flagProbe: claudeFlagProbe
});
console.log(
  "claude-runtime",
  claudePreflight.status,
  claudePreflight.message + (claudePreflight.ready && !claudePreflight.capabilityVerified
    ? " (version checked; " + REQUIRED_RESTRICTED_FLAG + " confirmed by neither the flag probe nor help output)"
    : "")
);
console.log("claude-minimum-version", MINIMUM_RESTRICTED_CLAUDE_VERSION);

const repositoryReady = tools.node.status === "available" &&
  tools.npm.status === "available" && tools.git.status === "available";
const registrationReady = repositoryReady &&
  tools.codex.status === "available" && claudePreflight.ready;

console.log("repository-validation", repositoryReady ? "ready" : "blocked");

if (!registrationReady) {
  console.log(
    "mcp-registration",
    claudePreflight.ready ? "prerequisites-missing" : "claude-runtime-" + claudePreflight.status
  );
} else if (!timeoutSafety.safe) {
  console.log("mcp-registration", "unsafe-timeout-configuration");
} else {
  console.log("mcp-registration", "prerequisites-present");
}

console.log(
  "bash-authority",
  "permissions.deny provides independent hard denials; the PreToolUse hook is an additional policy "
    + "layer and is not the sole gate (a hook timeout is absence, not denial). Native Windows Bash "
    + "policy is not a transitive OS sandbox: an allowed node/python/npm child exercises its own "
    + "authority. For stronger isolation run the coordinator inside WSL2, a container, or a VM."
);
console.log("Authentication is intentionally not inspected by this credential-free diagnostic.");

if (!repositoryReady) process.exitCode = 1;
