import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";
import { FAKE_CLAUDE_EXE, ensureFakeClaude } from "./fixtures/fake-claude-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaudeExe = FAKE_CLAUDE_EXE;

async function withFreshEnv(callback) {
  const freshTempDir = await mkdtemp(path.join(os.tmpdir(), "fresh-spec-"));
  const scenarioFile = path.join(freshTempDir, "fake-claude-scenario.json");
  const logFile = path.join(freshTempDir, "fake-claude-executions.jsonl");
  const env = {
    ...process.env,
    TEMP: freshTempDir,
    TMP: freshTempDir,
    CLAUDE_AGENTS_CLAUDE_BIN: fakeClaudeExe
  };
  try {
    await callback({ freshTempDir, scenarioFile, logFile, env });
  } finally {
    await rm(freshTempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function readExecutions(logFile) {
  if (!existsSync(logFile)) return [];
  const content = await readFile(logFile, "utf8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("fresh specialist: two sequential delegations create two distinct OS processes with isolated settings", async () => {
  ensureFakeClaude();
  await withFreshEnv(async ({ logFile, env }) => {
    // Delegation 1
    const outcome1 = await delegateAgent({
      agentType: "explore",
      task: "Task execution 1",
      cwd: repoRoot
    }, { env });

    assert.equal(outcome1.status, "completed");
    assert.ok(outcome1.pid);
    assert.ok(outcome1.executionId);

    // Delegation 2
    const outcome2 = await delegateAgent({
      agentType: "explore",
      task: "Task execution 2",
      cwd: repoRoot
    }, { env });

    assert.equal(outcome2.status, "completed");
    assert.ok(outcome2.pid);
    assert.ok(outcome2.executionId);

    // Invariant: distinct execution identities
    assert.notEqual(outcome1.executionId, outcome2.executionId, "Execution IDs must be distinct");
    assert.notEqual(outcome1.pid, outcome2.pid, "OS process IDs must be distinct across sequential calls");

    // Verify execution logs captured from fake specialist
    const executions = await readExecutions(logFile);
    assert.ok(executions.length >= 2, "Expected at least 2 execution records");
    const [exec1, exec2] = executions.slice(-2);

    assert.equal(exec1.pid, outcome1.pid);
    assert.equal(exec2.pid, outcome2.pid);
    assert.notEqual(exec1.pid, exec2.pid);

    // Verify CLI arguments and per-call isolated settings path
    const settingsArg1 = exec1.args.find((_, i) => exec1.args[i - 1] === "--settings");
    const settingsArg2 = exec2.args.find((_, i) => exec2.args[i - 1] === "--settings");

    assert.ok(settingsArg1, "Call 1 must supply --settings");
    assert.ok(settingsArg2, "Call 2 must supply --settings");
    assert.notEqual(settingsArg1, settingsArg2, "Settings paths must be distinct across delegations");

    // Invariant: settings isolation and cleanup
    // Settings file 1 should be removed after completion
    assert.ok(!existsSync(settingsArg1), "Settings file 1 must be cleaned up");
    assert.ok(!existsSync(settingsArg2), "Settings file 2 must be cleaned up");

    // Invariant: strict MCP & isolation flags
    for (const exec of [exec1, exec2]) {
      assert.ok(exec.args.includes("--no-session-persistence"), "Must enforce no session persistence");
      assert.ok(exec.args.includes("--strict-mcp-config"), "Must enforce strict MCP config");
      assert.ok(exec.args.includes("--restricted"), "Must enforce restricted mode");
      assert.ok(exec.args.includes("--no-chrome"), "Must enforce no chrome");
    }
  });
});

test("failure lifecycle: specialist non-zero exit reports bounded error and cleans up", async () => {
  ensureFakeClaude();
  await withFreshEnv(async ({ scenarioFile, env }) => {
    await writeFile(scenarioFile, JSON.stringify({ scenario: "nonzero", exitCode: 42 }), "utf8");

    const outcome = await delegateAgent({
      agentType: "explore",
      task: "Failing task",
      cwd: repoRoot
    }, { env });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "claude_non_zero_exit");
    assert.ok(outcome.durationMs >= 0);
    assert.equal(outcome.terminationDiagnostics.processStarted, true);
    assert.equal(outcome.terminationDiagnostics.terminalProof, "close");
  });
});

test("failure lifecycle: specialist timeout triggers forced termination and fails closed", async () => {
  ensureFakeClaude();
  await withFreshEnv(async ({ scenarioFile, env }) => {
    await writeFile(scenarioFile, JSON.stringify({ scenario: "hang" }), "utf8");

    const timeoutEnv = {
      ...env,
      CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "600"
    };

    const outcome = await delegateAgent({
      agentType: "explore",
      task: "Hanging task",
      cwd: repoRoot
    }, { env: timeoutEnv });

    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.error.code, "claude_timeout");
    assert.equal(outcome.terminationDiagnostics.processStarted, true);
    assert.equal(outcome.terminationDiagnostics.forcedTerminationStatus, "terminated");

    assert.equal(outcome.terminationDiagnostics.terminalProof, "close");

    let processTerminated = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        process.kill(outcome.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err) {
        if (err.code === "ESRCH") {
          processTerminated = true;
          break;
        }
      }
    }
    assert.ok(processTerminated || outcome.terminationDiagnostics.forcedTerminationStatus === "terminated");
  });
});

test("failure lifecycle: process identity ambiguity fails closed safely", async () => {
  ensureFakeClaude();
  await withFreshEnv(async ({ env }) => {
    const outcome = await delegateAgent({
      agentType: "explore",
      task: "Ambiguous identity task",
      cwd: repoRoot
    }, {
      env,
      runAgent: async (options) => {
        const { runClaudeAgent } = await import("../src/claude-runner.mjs");
        return runClaudeAgent({
          ...options,
          inspectProcess: async () => Object.freeze({
            status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
            reason: "simulated-probe-ambiguity"
          })
        });
      }
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "claude_process_identity_unavailable");
    assert.equal(outcome.terminationDiagnostics.processStarted, true);
    assert.equal(outcome.terminationDiagnostics.processIdentity, "unavailable");
  });
});

test("failure lifecycle: output overflow terminates process and reports bounded error", async () => {
  ensureFakeClaude();
  await withFreshEnv(async ({ scenarioFile, env }) => {
    await writeFile(scenarioFile, JSON.stringify({ scenario: "overflow" }), "utf8");

    const outcome = await delegateAgent({
      agentType: "explore",
      task: "Overflow task",
      cwd: repoRoot
    }, { env });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, "claude_output_capture_overflow");
    assert.ok(
      ["terminated", "already-terminal"].includes(outcome.terminationDiagnostics.forcedTerminationStatus),
      "Expected terminated or already-terminal but got " + outcome.terminationDiagnostics.forcedTerminationStatus
    );
  });
});
