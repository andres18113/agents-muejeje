import { spawnSync } from "node:child_process";

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

const repositoryReady = tools.node.status === "available" &&
  tools.npm.status === "available" && tools.git.status === "available";
const registrationReady = repositoryReady &&
  tools.codex.status === "available" && tools.claude.status === "available";

console.log("repository-validation", repositoryReady ? "ready" : "blocked");
console.log("mcp-registration", registrationReady ? "prerequisites-present" : "prerequisites-missing");
console.log("Authentication is intentionally not inspected by this credential-free diagnostic.");

if (!repositoryReady) process.exitCode = 1;
