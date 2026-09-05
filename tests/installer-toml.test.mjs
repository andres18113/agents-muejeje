import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MINIMUM_RESTRICTED_CLAUDE_VERSION } from "../src/claude-preflight.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerScriptPath = path.join(repoRoot, "install-codex.ps1");

let cachedPwshAvailable;
function pwshAvailable() {
  if (cachedPwshAvailable === undefined) {
    try {
      const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "'ok'"], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true
      });
      cachedPwshAvailable = probe.status === 0 && probe.stdout.trim() === "ok";
    } catch {
      cachedPwshAvailable = false;
    }
  }
  return cachedPwshAvailable;
}

async function extractUpdateFunction() {
  const scriptContent = await readFile(installerScriptPath, "utf8");
  const match = scriptContent.match(/function Update-CodexMcpTimeout\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "Update-CodexMcpTimeout function definition must exist in install-codex.ps1");
  return match[0];
}

function runPowerShellUpdate({ fnDef, configPath, serverName = "claude-agents", timeoutSec = 3600 }) {
  const psScript = `
${fnDef}
Update-CodexMcpTimeout -ConfigPath "${configPath.replace(/\\/g, "\\\\")}" -ServerName "${serverName}" -TimeoutSec ${timeoutSec}
`;
  const res = spawnSync("pwsh", ["-NoProfile", "-Command", psScript], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(res.status, 0, "PowerShell execution failed: " + res.stderr);
  return res.stdout;
}

test("installer TOML: absent claude-agents section leaves file completely byte-identical", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent = '[mcp_servers.other]\ncommand = "node"\nargs = ["server.js"]\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath });

    const afterContent = await readFile(configPath, "utf8");
    assert.equal(afterContent, initialContent, "File without target server section must remain byte-identical");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: section present without tool_timeout_sec inserts tool_timeout_sec", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent = '[mcp_servers.claude-agents]\ncommand = "node"\nargs = ["src/index.mjs"]\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.ok(afterContent.includes("tool_timeout_sec = 3600\n"));
    assert.ok(afterContent.includes('command = "node"'));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: timeout already 3600 is byte-stable and idempotent", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent = '[mcp_servers.claude-agents]\ntool_timeout_sec = 3600\ncommand = "node"\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.equal(afterContent, initialContent, "Content with exact timeout must remain byte-identical");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: different existing timeout is updated to 3600", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent = '[mcp_servers.claude-agents]\ntool_timeout_sec = 300\ncommand = "node"\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.ok(afterContent.includes("tool_timeout_sec = 3600"));
    assert.ok(!afterContent.includes("tool_timeout_sec = 300"));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: claude-agents.env section immediately following is preserved untouched", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent =
      '[mcp_servers.claude-agents]\ncommand = "node"\n\n[mcp_servers.claude-agents.env]\nCLAUDE_AGENTS_MODEL = "opus"\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.ok(afterContent.includes("tool_timeout_sec = 3600"));
    assert.ok(afterContent.includes('[mcp_servers.claude-agents.env]\nCLAUDE_AGENTS_MODEL = "opus"'));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: unrelated MCP servers before and after are completely preserved", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent =
      '[mcp_servers.alpha]\ncommand = "alpha"\ntool_timeout_sec = 100\n\n' +
      '[mcp_servers.claude-agents]\ncommand = "node"\n\n' +
      '[mcp_servers.omega]\ncommand = "omega"\ntool_timeout_sec = 500\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.ok(afterContent.includes("[mcp_servers.alpha]\ncommand = \"alpha\"\ntool_timeout_sec = 100\n"));
    assert.ok(afterContent.includes("[mcp_servers.omega]\ncommand = \"omega\"\ntool_timeout_sec = 500\n"));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: comments and blank lines are preserved", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent =
      '# Global header comment\n\n' +
      '[mcp_servers.claude-agents]\n' +
      '# Section comment for claude-agents\n' +
      'command = "node"\n' +
      '# End of section comment\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.ok(afterContent.includes("# Global header comment"));
    assert.ok(afterContent.includes("# Section comment for claude-agents"));
    assert.ok(afterContent.includes("# End of section comment"));
    assert.ok(afterContent.includes("tool_timeout_sec = 3600"));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: CRLF line endings are strictly preserved", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent = '[mcp_servers.claude-agents]\r\ncommand = "node"\r\nargs = ["server.mjs"]\r\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });

    const afterContent = await readFile(configPath, "utf8");
    assert.ok(afterContent.includes("\r\n"), "CRLF line endings must be preserved");
    assert.ok(!afterContent.includes("[^\r]\n"), "No isolated LF should be introduced in CRLF file");
    assert.ok(afterContent.includes("tool_timeout_sec = 3600\r\n"));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer TOML: repeated execution is strictly idempotent", async () => {
  const fnDef = await extractUpdateFunction();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "installer-test-"));
  try {
    const configPath = path.join(tmp, "config.toml");
    const initialContent = '[mcp_servers.claude-agents]\ncommand = "node"\nargs = ["server.mjs"]\n';
    await writeFile(configPath, initialContent, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });
    const firstPass = await readFile(configPath, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });
    const secondPass = await readFile(configPath, "utf8");

    runPowerShellUpdate({ fnDef, configPath, timeoutSec: 3600 });
    const thirdPass = await readFile(configPath, "utf8");

    assert.equal(secondPass, firstPass, "Second run must be byte-identical to first run");
    assert.equal(thirdPass, firstPass, "Third run must be byte-identical to first run");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("installer Claude floor matches the preflight minimum version", async () => {
  // The installer is PowerShell and cannot import the module, so the literal
  // is duplicated - and pinned here so the two cannot skew silently.
  const scriptContent = await readFile(installerScriptPath, "utf8");
  const match = scriptContent.match(/\$ClaudeMinimumVersion = "([^"]+)"/);
  assert.ok(match, "install-codex.ps1 must declare $ClaudeMinimumVersion");
  assert.equal(match[1], MINIMUM_RESTRICTED_CLAUDE_VERSION);
  assert.ok(
    scriptContent.includes("or newer is required for --restricted"),
    "the installer must refuse a Claude below the floor instead of only printing its version"
  );
});

async function extractVersionGateFunction() {
  const scriptContent = await readFile(installerScriptPath, "utf8");
  const match = scriptContent.match(/function Test-ClaudeMinimumVersion\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "Test-ClaudeMinimumVersion function definition must exist in install-codex.ps1");
  return match[0];
}

function runPowerShellVersionGate({ fnDef, versionLine, minimum }) {
  const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  const psScript = `
${fnDef}
Test-ClaudeMinimumVersion -VersionLine ${literal(versionLine)} -Minimum ${literal(minimum)}
`;
  const res = spawnSync("pwsh", ["-NoProfile", "-Command", psScript], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(res.status, 0, "PowerShell execution failed: " + res.stderr);
  return res.stdout.trim();
}

// The gate's logic runs in PowerShell, so this case matrix needs a pwsh to
// execute it; the literal pin above still runs everywhere.
test("installer Claude floor compares numerically and never guesses", { skip: !pwshAvailable() }, async () => {
  const fnDef = await extractVersionGateFunction();
  const check = (versionLine, minimum, expected) =>
    assert.equal(runPowerShellVersionGate({ fnDef, versionLine, minimum }), expected, versionLine);
  check("2.1.248 (Claude Code)", "2.1.248", "ok");
  check("2.1.260 (Claude Code)", "2.1.248", "ok");
  check("10.0.0", "2.1.248", "ok");
  // The case a string comparison gets wrong.
  check("2.1.9 (Claude Code)", "2.1.248", "below");
  check("2.1.247 (Claude Code)", "2.1.248", "below");
  check("1.9.9 (Claude Code)", "2.1.248", "below");
  // Unparsable is unknown, never ok and never below.
  for (const versionLine of ["", "unknown", "Claude Code", "v2"]) {
    check(versionLine, "2.1.248", "unknown");
  }
});
