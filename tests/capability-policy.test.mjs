import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.mjs";
import {
  CAPABILITY_POLICY,
  CapabilityPolicyError,
  describeRuntimeCapabilities,
  resolveCapabilityPolicy
} from "../src/capability-policy.mjs";
import { buildClaudeEnvironment } from "../src/claude-environment.mjs";
import {
  buildRuntimeSettingsPayload,
  createRuntimeSettings
} from "../src/claude-runtime-settings.mjs";
import { resolveAgentRuntime } from "../src/delegate-agent.mjs";
import {
  evaluateShellPolicy,
  parsePreToolUseInput,
  ShellPolicyError
} from "../src/shell-policy.mjs";
import {
  canonicalRootKey,
  resolveCanonicalWorkspaceRoot
} from "../src/workspace-root.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedIds = [
  "explore",
  "task",
  "general-purpose",
  "code-review",
  "research",
  "rubber-duck",
  "security-review"
];

async function withTemporaryDirectory(prefix, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("central capability policy is complete, immutable, and profile-specific", () => {
  assert.deepEqual(Object.keys(CAPABILITY_POLICY), expectedIds);
  assert.ok(Object.isFrozen(CAPABILITY_POLICY));

  const expected = {
    explore: { accessMode: "read", tools: ["Read", "Grep", "Glob"], shell: "none" },
    task: { accessMode: "write", tools: ["Bash"], shell: "task" },
    "general-purpose": {
      accessMode: "write",
      tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      shell: "worker"
    },
    "code-review": { accessMode: "read", tools: ["Read", "Grep", "Glob"], shell: "none" },
    research: { accessMode: "read", tools: ["Read", "Grep", "Glob"], shell: "none" },
    "rubber-duck": { accessMode: "read", tools: ["Read", "Grep", "Glob"], shell: "none" },
    "security-review": { accessMode: "read", tools: ["Read", "Grep", "Glob"], shell: "none" }
  };

  for (const id of expectedIds) {
    const policy = resolveCapabilityPolicy(AGENT_REGISTRY[id]);
    assert.equal(policy.accessMode, expected[id].accessMode);
    assert.deepEqual(policy.toolNames, expected[id].tools);
    assert.equal(policy.shellPolicy, expected[id].shell);
    assert.equal(policy.nestedDelegation, false);
    assert.equal(policy.disallowedTools.includes("Agent"), true);
    assert.equal(policy.disallowedTools.includes("Task"), true);
    assert.equal(policy.disallowedTools.includes("mcp__*"), true);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.toolNames));
  }

  assert.equal(AGENT_REGISTRY.research.manualOnly, true);
  for (const profile of Object.values(AGENT_REGISTRY)) {
    assert.equal(profile.contextStrategy, "fresh");
  }
  assert.throws(() => resolveCapabilityPolicy({ id: "unknown" }), CapabilityPolicyError);
  assert.throws(() => {
    CAPABILITY_POLICY.explore.toolNames.push("Bash");
  }, TypeError);
});

test("runtime resolution exposes exactly the selected policy and no generic tool baseline", () => {
  const env = {
    PATH: "C:\\test-bin",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\safe-user",
    ANTHROPIC_API_KEY: "must-not-pass",
    GITHUB_TOKEN: "must-not-pass",
    ASSIGNMENT_BODY: "must-not-pass"
  };

  for (const id of expectedIds) {
    const runtime = resolveAgentRuntime(AGENT_REGISTRY[id], { env });
    const policy = resolveCapabilityPolicy(AGENT_REGISTRY[id]);
    assert.equal(runtime.accessMode, policy.accessMode);
    assert.deepEqual(runtime.toolNames, policy.toolNames);
    assert.equal(runtime.shellPolicy, policy.shellPolicy);
    assert.equal(runtime.permissionMode, policy.permissionMode);
    assert.equal(runtime.nestedDelegation, false);
    assert.equal(runtime.settingsIsolation, "explicit-runtime-settings-only");
    assert.equal(runtime.mcpIsolation, "strict-runtime-config");
    assert.match(runtime.capabilityDescription, new RegExp(policy.toolNames.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const task = resolveAgentRuntime(AGENT_REGISTRY.task, { env });
  assert.equal(task.accessMode, "write");
  assert.equal(task.toolNames.includes("Edit"), false);
  assert.equal(task.toolNames.includes("Write"), false);
  assert.equal(task.toolNames.includes("Bash"), true);
  assert.match(task.capabilityDescription, /Write admission is required/);

  const worker = resolveAgentRuntime(AGENT_REGISTRY["general-purpose"], { env });
  assert.deepEqual(worker.toolNames, ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);

  for (const id of ["explore", "rubber-duck", "research", "code-review", "security-review"]) {
    const runtime = resolveAgentRuntime(AGENT_REGISTRY[id], { env });
    assert.equal(runtime.accessMode, "read");
    assert.equal(runtime.toolNames.includes("Bash"), false);
    assert.equal(runtime.toolNames.includes("Edit"), false);
    assert.equal(runtime.toolNames.includes("Write"), false);
  }
});

test("child environment uses a compatibility allowlist without task or secret inheritance", () => {
  const parent = {
    Path: "C:\\Windows\\System32;C:\\tools",
    PATHEXT: ".COM;.EXE",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    SystemDrive: "C:\\",
    USERPROFILE: "C:\\safe-user",
    HOME: "C:\\safe-user",
    APPDATA: "C:\\safe-user\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\safe-user\\AppData\\Local",
    TEMP: "C:\\temp",
    TMP: "C:\\temp",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    AWS_SESSION_TOKEN: "secret",
    DATABASE_URL: "secret",
    TASK_BODY: "sensitive assignment"
  };
  const child = buildClaudeEnvironment(parent);

  assert.equal(child.PATH, parent.Path);
  for (const required of [
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "SystemDrive",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP"
  ]) {
    assert.ok(Object.hasOwn(child, required), required + " should be retained");
  }
  for (const secret of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "DATABASE_URL",
    "TASK_BODY"
  ]) {
    assert.equal(Object.hasOwn(child, secret), false, secret + " must not be inherited");
  }
  assert.ok(Object.isFrozen(child));
});

test("temporary settings are unique, task-free, and hook-enabled only for Bash policies", async () => {
  await withTemporaryDirectory("claude-agents-settings-", async (temporaryDirectory) => {
    const first = await createRuntimeSettings({
      executionId: "execution-one",
      shellPolicy: "worker",
      tempDirectory: temporaryDirectory,
      nodePath: process.execPath,
      hookPath: path.join(projectRoot, "hooks", "claude-pretool-policy.mjs")
    });
    const second = await createRuntimeSettings({
      executionId: "execution-two",
      shellPolicy: "none",
      tempDirectory: temporaryDirectory
    });

    assert.notEqual(first.settingsPath, second.settingsPath);
    const workerSettings = await readFile(first.settingsPath, "utf8");
    const readOnlySettings = await readFile(second.settingsPath, "utf8");
    assert.match(workerSettings, /PreToolUse/);
    assert.match(workerSettings, /--policy worker/);
    assert.doesNotMatch(workerSettings, /ASSIGNMENT-SECRET/);
    assert.deepEqual(JSON.parse(readOnlySettings), {});

    await first.cleanup();
    await second.cleanup();
    await assert.rejects(stat(first.settingsPath));
    await assert.rejects(stat(second.settingsPath));
  });

  const payload = buildRuntimeSettingsPayload({
    shellPolicy: "task",
    nodePath: "C:\\node.exe",
    hookPath: "C:\\hooks\\policy.mjs"
  });
  assert.match(payload.hooks.PreToolUse[0].hooks[0].command, /--policy task/);
});

test("canonical roots use real paths, Git boundaries, and a deterministic non-Git fallback", async () => {
  assert.equal(
    canonicalRootKey("C:\\Workspace\\Root", { platform: "win32" }),
    "c:\\workspace\\root"
  );
  await withTemporaryDirectory("claude-agents-root-", async (temporaryDirectory) => {
    const gitRoot = path.join(temporaryDirectory, "git-root");
    const subdirectory = path.join(gitRoot, "src", "nested");
    const siblingSubdirectory = path.join(gitRoot, "tests", "nested");
    await mkdir(path.join(gitRoot, ".git"), { recursive: true });
    await mkdir(subdirectory, { recursive: true });
    await mkdir(siblingSubdirectory, { recursive: true });

    const resolved = await resolveCanonicalWorkspaceRoot(subdirectory, { accessMode: "write" });
    assert.equal(resolved.canonicalRoot, await realpath(gitRoot));
    assert.equal(resolved.rootSource, "git-boundary");
    const siblingResolved = await resolveCanonicalWorkspaceRoot(siblingSubdirectory, { accessMode: "write" });
    assert.equal(siblingResolved.canonicalRoot, resolved.canonicalRoot);
    assert.equal(siblingResolved.canonicalRootKey, resolved.canonicalRootKey);

    const worktreeRoot = path.join(temporaryDirectory, "worktree-root");
    const worktreeSubdirectory = path.join(worktreeRoot, "lib");
    await mkdir(worktreeSubdirectory, { recursive: true });
    await writeFile(path.join(worktreeRoot, ".git"), "gitdir: ../metadata", "utf8");
    const worktreeResolved = await resolveCanonicalWorkspaceRoot(worktreeSubdirectory, { accessMode: "read" });
    assert.equal(worktreeResolved.rootSource, "git-boundary");

    const plainRoot = path.join(temporaryDirectory, "plain-root");
    await mkdir(plainRoot, { recursive: true });
    const plainResolved = await resolveCanonicalWorkspaceRoot(plainRoot, { accessMode: "read" });
    assert.equal(plainResolved.canonicalRoot, plainResolved.effectiveCwd);
    assert.equal(plainResolved.rootSource, "cwd");
  });

  await assert.rejects(
    resolveCanonicalWorkspaceRoot("unresolvable-write-root", {
      accessMode: "write",
      realpathFn: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    }),
    /Cannot establish a canonical workspace root for write access/
  );
  const readFallback = await resolveCanonicalWorkspaceRoot("read-fallback", {
    accessMode: "read",
    realpathFn: async () => {
      throw new Error("missing");
    }
  });
  assert.equal(readFallback.rootSource, "read-cwd-fallback");
});

test("shell policy is allowlisted for read-only Git and fail-closed for malformed or dangerous commands", () => {
  assert.equal(evaluateShellPolicy("git-readonly", "git status").allowed, true);
  assert.equal(evaluateShellPolicy("git-readonly", "git diff --stat").allowed, true);
  assert.equal(evaluateShellPolicy("git-readonly", "git branch --show-current").allowed, true);
  assert.equal(evaluateShellPolicy("git-readonly", "git add file.txt").allowed, false);
  assert.equal(evaluateShellPolicy("git-readonly", "npm test").allowed, false);
  assert.equal(evaluateShellPolicy("git-readonly", "git diff --output=result.txt").allowed, false);
  assert.equal(evaluateShellPolicy("git-readonly", "git status > result.txt").allowed, false);
  assert.equal(evaluateShellPolicy("git-readonly", "git status && git log").allowed, false);

  assert.equal(evaluateShellPolicy("task", "npm test").allowed, true);
  assert.equal(evaluateShellPolicy("worker", "node --version").allowed, true);
  assert.equal(evaluateShellPolicy("worker", "git status").allowed, true);
  for (const command of [
    "git push",
    "git --no-pager push",
    "git commit -m update",
    "npm publish",
    "npm --registry https://registry.example.test publish",
    "curl https://example.test",
    "C:\\Windows\\System32\\curl.exe https://example.test",
    "rm -rf build",
    "taskkill /IM node.exe",
    "npm test && git push"
  ]) {
    assert.equal(evaluateShellPolicy("worker", command).allowed, false, command + " must be denied");
  }
  assert.throws(() => evaluateShellPolicy("none", "git status"), ShellPolicyError);
  assert.throws(() => parsePreToolUseInput("not-json"), ShellPolicyError);
  assert.throws(
    () => parsePreToolUseInput(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read" })),
    ShellPolicyError
  );
});

test("the PreToolUse hook process allows safe commands and exits 2 for denied commands", () => {
  const hookPath = path.join(projectRoot, "hooks", "claude-pretool-policy.mjs");
  const allowed = spawnSync(process.execPath, [hookPath, "--policy", "worker"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" }
    }),
    encoding: "utf8"
  });
  assert.equal(allowed.status, 0, allowed.stderr);

  const denied = spawnSync(process.execPath, [hookPath, "--policy", "worker"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" }
    }),
    encoding: "utf8"
  });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /Blocked by claude-agents shell policy/);

  const malformed = spawnSync(process.execPath, [hookPath, "--policy", "worker"], {
    input: "not-json",
    encoding: "utf8"
  });
  assert.equal(malformed.status, 2, malformed.stderr);
});
