import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_REGISTRY, getAgentProfile } from "../src/agent-registry.mjs";
import { loadAgentContract } from "../src/agent-contracts.mjs";
import {
  DELEGATE_AGENT_TYPES,
  MAX_DELEGATE_TASK_CHARS,
  delegateAgent as delegateAgentImplementation,
  delegateAgentInputSchema,
  formatDelegateAgentOutcome,
  registerDelegateAgentTool,
  resolveAgentRuntime,
  resolveDelegationWorkingDirectory
} from "../src/delegate-agent.mjs";
import {
  delegateAgentOutputSchema,
  projectDelegateAgentOutcome
} from "../src/delegate-outcome.mjs";
import {
  ClaudeExitError,
  ClaudeOutputCaptureOverflowError,
  ClaudeRunnerError,
  ClaudeTimeoutError,
  getClaudeRunnerArgs,
  observeClaudeChildTerminal,
  runClaudeAgent as runClaudeAgentImplementation,
  terminateClaudeChild
} from "../src/claude-runner.mjs";
import { WriteCustodyError } from "../src/write-custody.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedAgentTypes = [
  "explore",
  "task",
  "general-purpose",
  "code-review",
  "research",
  "rubber-duck",
  "security-review"
];

class WriteCustodyManager {
  #records = new Map();

  worktreeRootFor({ executionId }) {
    return path.join(os.tmpdir(), "test-worktree-" + executionId);
  }

  reserveWriteAccess(record) {
    if (this.#records.has(record.canonicalRootKey)) {
      throw new WriteCustodyError("Write custody is already reserved.", { code: "write_custody_conflict" });
    }
    const reserved = { ...record, state: "RESERVED", accessMode: "none" };
    this.#records.set(record.canonicalRootKey, reserved);
    return reserved;
  }

  beginWorktreePreparation(owner) {
    return this.#transition(owner, "PREPARING_WORKTREE", "none");
  }

  markSpawning(owner) {
    return this.#transition(owner, "SPAWNING", "none");
  }

  activateWriteAccess({ processIdentity, ...owner }) {
    const record = this.#owned(owner);
    record.processIdentity = processIdentity;
    return this.#transition(owner, "ACTIVE", "write");
  }

  beginTermination({ processIdentity, ...owner }) {
    const record = this.#owned(owner);
    if (record.processIdentity !== processIdentity) {
      throw new WriteCustodyError("Process identity mismatch.", { code: "write_custody_process_identity_mismatch" });
    }
    return this.#transition(owner, "TERMINATING", "write");
  }

  releaseUnstartedWriteAccess(owner) {
    const record = this.#owned(owner);
    if (record.processIdentity) {
      throw new WriteCustodyError("Terminal proof required.", { code: "write_custody_terminal_proof_required" });
    }
    this.#records.delete(owner.canonicalRootKey);
    return { ...record, state: "RELEASED", accessMode: "none" };
  }

  releaseWriteAccessAfterTerminal({ terminalProof, ...owner }) {
    const record = this.#owned(owner);
    // Mirrors production: SPAWNING is accepted because a child can close
    // before its durable identity was persisted.
    if (!["SPAWNING", "ACTIVE", "TERMINATING"].includes(record.state)) {
      throw new WriteCustodyError("Invalid state.", { code: "write_custody_state_invalid" });
    }
    if (!terminalProof || terminalProof.event !== "close") {
      throw new WriteCustodyError("Terminal proof missing.", {
        code: "write_custody_terminal_proof_missing"
      });
    }
    const identityMustMatch = record.state !== "SPAWNING" || record.processIdentity !== undefined;
    if (identityMustMatch && terminalProof.processIdentity !== record.processIdentity) {
      throw new WriteCustodyError("Terminal proof mismatch.", { code: "write_custody_process_identity_mismatch" });
    }
    this.#records.delete(owner.canonicalRootKey);
    return { ...record, state: "RELEASED", accessMode: "none" };
  }

  releaseWriteAccessAfterSupervisedClose({ terminalProof, ...owner }) {
    const record = this.#owned(owner);
    if (record.state !== "SPAWNING") {
      throw new WriteCustodyError("Invalid state.", { code: "write_custody_state_invalid" });
    }
    if (record.processIdentity) {
      throw new WriteCustodyError("Identity-bound proof required.", {
        code: "write_custody_terminal_proof_required"
      });
    }
    if (
      !terminalProof ||
      terminalProof.event !== "close" ||
      terminalProof.supervisedByCoordinator !== true
    ) {
      throw new WriteCustodyError("Supervised close proof required.", {
        code: "write_custody_terminal_proof_missing"
      });
    }
    this.#records.delete(owner.canonicalRootKey);
    return { ...record, state: "RELEASED", accessMode: "none" };
  }

  releaseOrphanedWriteAccessAfterTerminal({ terminalProof, ...owner }) {
    const record = this.#owned(owner);
    if (record.state !== "ORPHANED") {
      throw new WriteCustodyError("Invalid state.", { code: "write_custody_state_invalid" });
    }
    if (!terminalProof || terminalProof.event !== "close") {
      throw new WriteCustodyError("Terminal proof missing.", {
        code: "write_custody_terminal_proof_missing"
      });
    }
    if (terminalProof.supervisedByCoordinator !== true && terminalProof.processIdentity !== record.processIdentity) {
      throw new WriteCustodyError("Terminal proof mismatch.", { code: "write_custody_process_identity_mismatch" });
    }
    this.#records.delete(owner.canonicalRootKey);
    return { ...record, state: "RELEASED", accessMode: "none" };
  }

  markOrphanedWriteAccess({ processIdentity, reason, ...owner }) {
    const record = this.#owned(owner);
    if (processIdentity) record.processIdentity = processIdentity;
    record.orphanReason = reason;
    return this.#transition(owner, "ORPHANED", "write");
  }

  getWriteAccess(key) {
    const record = this.#records.get(key);
    return record ? { ...record } : undefined;
  }

  #owned({ executionId, canonicalRootKey }) {
    const record = this.#records.get(canonicalRootKey);
    if (!record) throw new WriteCustodyError("Missing custody.", { code: "write_custody_missing" });
    if (record.executionId !== executionId) {
      throw new WriteCustodyError("Owner mismatch.", { code: "write_custody_owner_mismatch" });
    }
    return record;
  }

  #transition(owner, state, accessMode) {
    const record = this.#owned(owner);
    record.state = state;
    record.accessMode = accessMode;
    return { ...record };
  }
}

function passthroughWorktreeManager(writeCustody) {
  return {
    async prepare({ executionId, canonicalRepositoryKey, repositoryRoot, effectiveCwd }) {
      const workspaceRoot = writeCustody.worktreeRootFor({
        executionId,
        canonicalRootKey: canonicalRepositoryKey
      });
      writeCustody.beginWorktreePreparation({
        executionId,
        canonicalRootKey: canonicalRepositoryKey,
        baseCommit: "a".repeat(40),
        worktreeRoot: workspaceRoot
      });
      writeCustody.markSpawning({ executionId, canonicalRootKey: canonicalRepositoryKey });
      return {
        effectiveCwd,
        repositoryRoot,
        canonicalRepositoryKey,
        rootSource: "test-isolated-worktree",
        workspaceRoot,
        baseCommit: "a".repeat(40)
      };
    }
  };
}

async function delegateAgent(input, dependencies = {}) {
  const writeCustody = dependencies.writeCustody || new WriteCustodyManager();
  return await delegateAgentImplementation(input, {
    ...dependencies,
    writeCustody,
    resolveRepositoryIdentity: dependencies.resolveRepositoryIdentity || (async (workspace) => workspace),
    worktreeManager: dependencies.worktreeManager || passthroughWorktreeManager(writeCustody)
  });
}

async function inspectFakeProcess(pid) {
  return {
    status: "alive",
    identity: {
      pid,
      startTime: String(pid * 100),
      source: "test-process-start"
    }
  };
}

function runClaudeAgent(argumentsForRunner) {
  return runClaudeAgentImplementation({
    inspectProcess: inspectFakeProcess,
    ...argumentsForRunner
  });
}

function runtimeForTest(overrides = {}) {
  return {
    claudeBin: "claude",
    model: "opus",
    reasoningEffort: "medium",
    timeoutMs: 100,
    timeoutSource: "profile",
    maxCaptureBytes: 1024 * 1024,
    permissionMode: "plan",
    accessMode: "read",
    toolNames: ["Read", "Grep", "Glob"],
    disallowedTools: ["Agent", "Task", "mcp__*"],
    shellPolicy: "none",
    childEnvironment: { PATH: "test-path", SystemRoot: "C:\\Windows" },
    capabilityDescription:
      "Available Claude tools: Read, Grep, Glob. Bash is not exposed.",
    ...overrides
  };
}

function fakeSettings(cleanup = async () => {}) {
  return async () => ({
    settingsPath: "C:\\temp\\claude-runtime-settings.json",
    cleanup
  });
}

function afterRunnerStarts() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Settles a delegation that runs on a manual clock.
 *
 * A wall-clock execution budget measures delegation-entry-to-deadline, so the
 * real preamble (working-directory resolution, contract loading) consumes the
 * same budget the runner needs to start. Under full-suite contention that
 * preamble can exceed a tight budget and clipUsefulWorkTimeout throws before
 * the runner is ever invoked, which is an honest never-started release - but
 * it is not the post-spawn timeout the ORPHANED tests mean to exercise. The
 * manual clock freezes that budget until the test advances it past gates the
 * runner has provably reached, so spawn-before-deadline is established rather
 * than assumed. The bounded advance loop fails loudly instead of hanging the
 * file if production ever stops settling.
 */
async function settleManualClockDelegation(clock, pending) {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < 10 && !settled; i++) {
    clock.advanceTo(clock.now() + 1_000);
    await afterRunnerStarts();
  }
  assert.equal(settled, true, "delegation must settle under the manual clock");
  return await pending;
}

function manualClock(initialTime = 1_000) {
  let time = initialTime;
  let nextId = 1;
  const timers = new Map();
  let onSchedule = null;
  return {
    now: () => time,
    setOnSchedule(fn) {
      onSchedule = fn;
    },
    schedule(callback, delay) {
      const id = nextId++;
      const timer = { callback, at: time + Math.max(0, delay) };
      timers.set(id, timer);
      if (onSchedule) onSchedule(id, timer);
      return id;
    },
    cancelSchedule(id) {
      timers.delete(id);
    },
    advanceTo(target) {
      time = target;
      let fired;
      do {
        fired = false;
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at <= time) {
            timers.delete(id);
            timer.callback();
            fired = true;
          }
        }
      } while (fired && [...timers.values()].some((t) => t.at <= time));
    },
    pendingTimers: () => timers.size
  };
}

function terminateFakeChild(child, options = {}) {
  return terminateClaudeChild(child, {
    ...options,
    platform: "linux"
  });
}

let nextFakePid = 20_000;

function createFakeChild({ stdin, stdout, stderr, pid = nextFakePid++, closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdin = stdin || new PassThrough();
  child.stdout = stdout || new PassThrough();
  child.stderr = stderr || new PassThrough();
  child.pid = pid;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (closeOnKill) {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
    }
    return true;
  };
  return child;
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Mirrors production ordering: runClaudeAgent awaits onChildStarted (which
 * persists durable ownership) before the child can report a terminal result.
 * A double that fires the callback without awaiting would represent an
 * interleaving production cannot produce.
 */
async function completedWriterExecution(argumentsForRunner, result = "specialist response", durationMs = 7) {
  const child = createFakeChild();
  const processIdentity = Object.freeze({
    executionId: argumentsForRunner.executionId,
    agentType: argumentsForRunner.agentType,
    repositoryRoot: argumentsForRunner.repositoryRoot,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "test-process-start",
    child,
    startedAt: 1
  });
  await argumentsForRunner.onChildStarted(processIdentity);
  return {
    result,
    stderrSummary: "",
    durationMs,
    processStarted: true,
    processIdentity,
    terminalProof: Object.freeze({
      processIdentity,
      event: "close",
      code: 0,
      signal: null,
      observedAt: 2
    })
  };
}

function completedRunner(result = "specialist response") {
  return async (argumentsForRunner = {}) => {
    if (!argumentsForRunner.onChildStarted) {
      return { result, stderrSummary: "", durationMs: 7 };
    }
    return completedWriterExecution(argumentsForRunner, result);
  };
}

function workspaceForTest(cwd) {
  return {
    effectiveCwd: cwd,
    repositoryRoot: cwd,
    canonicalRepositoryKey: cwd.toLowerCase(),
    rootSource: "test"
  };
}

test("delegate_agent schema accepts exactly seven profiles and rejects removed or unknown types", () => {
  assert.deepEqual(DELEGATE_AGENT_TYPES, expectedAgentTypes);
  for (const agentType of expectedAgentTypes) {
    assert.equal(
      delegateAgentInputSchema.safeParse({ agent_type: agentType, task: "inspect this" }).success,
      true,
      agentType + " should be accepted"
    );
  }

  for (const invalidAgentType of ["verify", "unknown", "claude_review", "claude_critic", "claude_verify"]) {
    assert.equal(
      delegateAgentInputSchema.safeParse({ agent_type: invalidAgentType, task: "inspect this" }).success,
      false,
      invalidAgentType + " should be rejected"
    );
  }
  assert.equal(
    delegateAgentInputSchema.safeParse({ agent_type: "explore", task: "   " }).success,
    false
  );
  assert.equal(
    delegateAgentInputSchema.safeParse({
      agent_type: "explore",
      task: "x".repeat(MAX_DELEGATE_TASK_CHARS + 1)
    }).success,
    false
  );
  assert.equal(
    delegateAgentInputSchema.safeParse({ agent_type: "explore", task: "inspect", cwd: "  " }).success,
    false
  );
});

test("each remaining profile is looked up from the registry and receives only its own contract", async () => {
  const registrySnapshot = JSON.stringify(AGENT_REGISTRY);

  for (const agentType of expectedAgentTypes) {
    const task = "ASSIGNMENT-ONLY-" + agentType + "-5d2ba5aa";
    let requestedProfileId;
    let runnerArguments;
    const outcome = await delegateAgent(
      { agentType, task, cwd: projectRoot },
      {
        getProfile(id) {
          requestedProfileId = id;
          return getAgentProfile(id);
        },
        runAgent: async (argumentsForRunner) => {
          runnerArguments = argumentsForRunner;
          const execution = await completedRunner("completed " + agentType)(argumentsForRunner);
          return { ...execution, durationMs: 11 };
        },
        env: { CLAUDE_AGENTS_MODEL: "test-claude" }
      }
    );

    const expectedContract = await loadAgentContract(agentType);
    assert.equal(requestedProfileId, agentType);
    assert.equal(outcome.agentType, agentType);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.model, "test-claude");
    assert.equal(runnerArguments.profile, AGENT_REGISTRY[agentType]);
    assert.ok(runnerArguments.prompt.includes(expectedContract.trim()));
    assert.equal(countOccurrences(runnerArguments.prompt, task), 1);
    assert.ok(runnerArguments.prompt.includes("Working directory: " + projectRoot));
    // The prompt reports the workspace root Claude actually operates in and the
    // repository root that coordinates it. They differ only for general-purpose.
    const expectedWorkspaceRoot =
      agentType === "general-purpose" ? outcome.worktreeRoot : projectRoot;
    assert.ok(runnerArguments.prompt.includes("Workspace root: " + expectedWorkspaceRoot));
    assert.ok(runnerArguments.prompt.includes("Repository root: " + projectRoot));
    assert.equal(
      runnerArguments.prompt.includes("Canonical root:"),
      false,
      "the ambiguous canonical-root label must not reappear"
    );
    // The runner binds process identity to the repository, never the workspace.
    assert.equal(runnerArguments.repositoryRoot, projectRoot);
    assert.match(runnerArguments.prompt, /Execution ID: [A-Za-z0-9_-]+/);
    assert.match(runnerArguments.prompt, /Runtime capabilities:/);
    assert.match(
      runnerArguments.prompt,
      /does not override the Role Contract's safety, scope, mutation, delegation, confidence, or output boundaries/
    );

    for (const otherAgentType of expectedAgentTypes) {
      if (otherAgentType === agentType) continue;
      const otherContract = await loadAgentContract(otherAgentType);
      assert.equal(
        runnerArguments.prompt.includes(otherContract.trim()),
        false,
        agentType + " prompt must not contain the " + otherAgentType + " contract"
      );
    }
  }

  assert.equal(JSON.stringify(AGENT_REGISTRY), registrySnapshot);
});

test("removed and unknown profiles fail rather than silently falling back", async () => {
  for (const agentType of ["verify", "not-a-profile"]) {
    await assert.rejects(
      delegateAgent(
        { agentType, task: "inspect this", cwd: projectRoot },
        { runAgent: completedRunner() }
      ),
      /Unknown agent profile/
    );
  }
});

test("contract loading remains independent of the caller process cwd", async () => {
  const originalCwd = process.cwd();
  let prompt;

  try {
    process.chdir(os.tmpdir());
    const outcome = await delegateAgent(
      { agentType: "explore", task: "cwd independence", cwd: projectRoot },
      {
        runAgent: async (argumentsForRunner) => {
          prompt = argumentsForRunner.prompt;
          return { result: "ok", stderrSummary: "", durationMs: 1 };
        }
      }
    );
    assert.equal(outcome.status, "completed");
    assert.ok(prompt.includes((await loadAgentContract("explore")).trim()));
  } finally {
    process.chdir(originalCwd);
  }
});

test("working directories are normalized and invalid directories are rejected", async () => {
  const resolved = await resolveDelegationWorkingDirectory(".", { baseCwd: projectRoot });
  assert.equal(resolved, projectRoot);
  await assert.rejects(
    resolveDelegationWorkingDirectory(path.join(projectRoot, "package.json")),
    /cwd is not a directory/
  );
  await assert.rejects(
    resolveDelegationWorkingDirectory(path.join(projectRoot, "does-not-exist")),
    /cwd does not exist/
  );
  await assert.rejects(resolveDelegationWorkingDirectory("   "), /cwd must not be blank/);
  assert.equal((await stat(resolved)).isDirectory(), true);
});

test("runtime resolution uses the configured backend with profile effort and timeout", () => {
  for (const profile of Object.values(AGENT_REGISTRY)) {
    const runtime = resolveAgentRuntime(profile, {
      env: { CLAUDE_AGENTS_MODEL: "configured-claude" }
    });
    assert.equal(runtime.model, "configured-claude");
    assert.equal(runtime.reasoningEffort, profile.reasoningEffort);
    assert.equal(runtime.timeoutMs, profile.timeoutMs);
    assert.equal(runtime.timeoutSource, "profile");
    assert.equal(runtime.modelStrategy, profile.modelStrategy);
    assert.ok(Object.isFrozen(runtime));
  }

  const overridden = resolveAgentRuntime(AGENT_REGISTRY.explore, {
    env: {
      CLAUDE_AGENTS_CLAUDE_BIN: "custom-claude",
      CLAUDE_AGENTS_MODEL: "configured-claude",
      CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "1234"
    }
  });
  assert.equal(overridden.claudeBin, "custom-claude");
  assert.equal(overridden.model, "configured-claude");
  assert.equal(overridden.reasoningEffort, AGENT_REGISTRY.explore.reasoningEffort);
  assert.equal(overridden.timeoutMs, 1234);
  assert.equal(overridden.timeoutSource, "operator-override");
  assert.equal(overridden.accessMode, "read");
  assert.deepEqual(overridden.toolNames, ["Read", "Grep", "Glob"]);
  assert.deepEqual(overridden.disallowedTools, ["Agent", "Task", "mcp__*"]);
  assert.equal(overridden.shellPolicy, "none");
  assert.equal(overridden.toolNames.includes("Task"), false);
  assert.match(overridden.capabilityDescription, /not an OS sandbox/);

  assert.throws(
    () => resolveAgentRuntime(AGENT_REGISTRY.explore, { env: { CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "0" } }),
    /positive integer/
  );
  assert.throws(
    () =>
      resolveAgentRuntime(AGENT_REGISTRY.explore, {
        env: { CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "2147483648" }
      }),
    /no greater than 1800000 milliseconds/
  );
  assert.throws(
    () =>
      resolveAgentRuntime(
        { ...AGENT_REGISTRY.explore, timeoutMs: 2147483648 },
        { env: {} }
      ),
    /invalid timeoutMs/
  );
  assert.throws(
    () =>
      resolveAgentRuntime(AGENT_REGISTRY.explore, {
        env: { CLAUDE_AGENTS_MAX_CAPTURE_BYTES: "0" }
      }),
    /positive integer number of bytes/
  );
});

test("research remains explicitly delegable despite its manual-only registry policy", async () => {
  assert.equal(AGENT_REGISTRY.research.manualOnly, true);
  const outcome = await delegateAgent(
    { agentType: "research", task: "research a single fact", cwd: projectRoot },
    { runAgent: completedRunner("research result") }
  );
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.agentType, "research");
});

test("each explicit delegation invokes a fresh runner and keeps nested MCP delegation disabled", async () => {
  const calls = [];
  const runner = async (argumentsForRunner) => {
    calls.push(argumentsForRunner);
    return { result: "ok", stderrSummary: "", durationMs: 1 };
  };

  const first = await delegateAgent(
    { agentType: "explore", task: "first", cwd: projectRoot },
    { runAgent: runner }
  );
  const second = await delegateAgent(
    { agentType: "explore", task: "second", cwd: projectRoot },
    { runAgent: runner }
  );

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
  assert.notEqual(first.executionId, second.executionId);
  assert.match(calls[0].prompt, /Nested claude-agents MCP delegation is unavailable/);
  assert.equal(calls[0].runtime.disallowedTools.includes("mcp__*"), true);
  assert.equal(calls[0].runtime.toolNames.includes("Task"), false);
});

test("write admission releases on terminal outcomes and leaves reads concurrent", async () => {
  const custody = new WriteCustodyManager();
  const firstRoot = projectRoot;
  const secondRoot = os.tmpdir();
  const executionIds = ["writer-one", "writer-two", "reader-one", "writer-three", "writer-four"];
  let nextExecution = 0;
  const commonDependencies = {
    writeCustody: custody,
    createExecutionId: () => executionIds[nextExecution++],
    resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd)
  };

  let completeFirst;
  const firstStarted = new Promise((resolve) => {
    completeFirst = resolve;
  });
  let firstRunnerStarted;
  const firstRunnerStartedPromise = new Promise((resolve) => {
    firstRunnerStarted = resolve;
  });
  const first = delegateAgent(
    { agentType: "task", task: "npm test", cwd: firstRoot },
    {
      ...commonDependencies,
      runAgent: async (argumentsForRunner) => {
        const execution = await completedWriterExecution(
          argumentsForRunner,
          "first complete",
          10
        );
        firstRunnerStarted();
        await firstStarted;
        return execution;
      }
    }
  );
  await firstRunnerStartedPromise;

  let secondRunnerCalled = false;
  const second = await delegateAgent(
    { agentType: "general-purpose", task: "implement bounded fix", cwd: firstRoot },
    {
      ...commonDependencies,
      runAgent: async () => {
        secondRunnerCalled = true;
        return { result: "unexpected", stderrSummary: "", durationMs: 1 };
      }
    }
  );
  assert.equal(second.status, "failed");
  assert.equal(second.error.code, "write_custody_conflict");
  assert.equal(secondRunnerCalled, false);

  const readWhileWriting = await delegateAgent(
    { agentType: "explore", task: "find one file", cwd: firstRoot },
    { ...commonDependencies, runAgent: completedRunner("read complete") }
  );
  assert.equal(readWhileWriting.status, "completed");
  assert.equal(readWhileWriting.accessMode, "read");
  assert.equal(readWhileWriting.custodyState, "not-applicable");

  completeFirst();
  const firstOutcome = await first;
  assert.equal(firstOutcome.status, "completed");
  assert.equal(firstOutcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(workspaceForTest(firstRoot).canonicalRepositoryKey), undefined);

  const differentRoot = await delegateAgent(
    { agentType: "general-purpose", task: "bounded work", cwd: secondRoot },
    { ...commonDependencies, runAgent: completedRunner("different root complete") }
  );
  assert.equal(differentRoot.status, "completed");
  assert.equal(differentRoot.custodyState, "released");

  const timeout = await delegateAgent(
    { agentType: "task", task: "npm test", cwd: firstRoot },
    {
      ...commonDependencies,
      runAgent: async (argumentsForRunner) => {
        const execution = await completedWriterExecution(argumentsForRunner, "unused", 10);
        throw new ClaudeTimeoutError(10, {
          durationMs: 10,
          processStarted: true,
          processIdentity: execution.processIdentity,
          terminalProof: execution.terminalProof
        });
      }
    }
  );
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.custodyState, "released");
  assert.equal(custody.getWriteAccess(workspaceForTest(firstRoot).canonicalRepositoryKey), undefined);
  assert.notEqual(firstOutcome.executionId, second.executionId);
  assert.notEqual(second.executionId, readWhileWriting.executionId);
});

function writerRuntime(timeoutMs = 20) {
  return runtimeForTest({
    accessMode: "write",
    timeoutMs,
    toolNames: ["Bash"],
    shellPolicy: "task",
    capabilityDescription: "Available Claude tools: Bash. Write admission is active."
  });
}

function stalledChildForTermination() {
  class StalledStdin extends EventEmitter {
    write() { return false; }
    end() {}
  }
  return createFakeChild({
    stdin: new StalledStdin(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    closeOnKill: false
  });
}

test("normal exact child close returns active writer custody", async () => {
  const custody = new WriteCustodyManager();
  const child = createFakeChild();
  const root = projectRoot;
  const runtime = writerRuntime();
  let writerStarted;
  const writerStartedPromise = new Promise((resolve) => {
    writerStarted = resolve;
  });
  const pending = delegateAgent(
    { agentType: "general-purpose", task: "bounded normal work", cwd: root },
    {
      writeCustody: custody,
      createExecutionId: () => "normal-close-writer",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        async onChildStarted(processIdentity) {
          // Production awaits this; the wrapper must not drop the promise.
          await argumentsForRunner.onChildStarted(processIdentity);
          writerStarted();
        },
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminateChild: terminateFakeChild
      })
    }
  );
  await writerStartedPromise;
  await afterRunnerStarts();
  const rootKey = workspaceForTest(root).canonicalRepositoryKey;
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");
  child.stdout.end("normal result");
  child.emit("close", 0, null);

  const outcome = await pending;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(rootKey), undefined);
});

test("write custody remains TERMINATING through taskkill completion until exact child close proves terminal", async () => {
  const clock = manualClock();
  const custody = new WriteCustodyManager();
  const root = projectRoot;
  const otherRoot = os.tmpdir();
  const child = stalledChildForTermination();
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  let taskkillStarted;
  const taskkillStartedPromise = new Promise((resolve) => {
    taskkillStarted = resolve;
  });
  let writerStarted;
  const writerStartedPromise = new Promise((resolve) => {
    writerStarted = resolve;
  });
  const ids = [
    "writer-a",
    "writer-b",
    "reader-a",
    "writer-other",
    "writer-still-blocked",
    "writer-after"
  ];
  let nextId = 0;
  const runtime = writerRuntime(1_000);
  const terminationTimeoutMs = 5_000;
  const writerDependencies = {
    writeCustody: custody,
    createExecutionId: () => ids[nextId++],
    resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
    resolveRuntime: () => runtime,
    runAgent: (argumentsForRunner) => runClaudeAgent({
      ...argumentsForRunner,
      runtime,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule,
      async onChildStarted(processIdentity) {
        await argumentsForRunner.onChildStarted(processIdentity);
        writerStarted();
      },
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      terminationTimeoutMs,
      terminateChild: (target, options) => terminateClaudeChild(target, {
        ...options,
        platform: "win32",
        now: clock.now,
        schedule: clock.schedule,
        cancelSchedule: clock.cancelSchedule,
        spawnTerminator() {
          taskkillStarted();
          return terminator;
        }
      })
    })
  };

  const first = delegateAgent(
    { agentType: "task", task: "run exactly one command", cwd: root },
    writerDependencies
  );
  await writerStartedPromise;
  await afterRunnerStarts();
  const rootKey = workspaceForTest(root).canonicalRepositoryKey;
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");

  // Explicitly trigger execution timeout via manual clock
  clock.advanceTo(clock.now() + runtime.timeoutMs);
  await taskkillStartedPromise;
  assert.equal(custody.getWriteAccess(rootKey).state, "TERMINATING");

  let secondRunnerCalled = false;
  const second = await delegateAgent(
    { agentType: "general-purpose", task: "would write", cwd: root },
    {
      ...writerDependencies,
      runAgent: async () => {
        secondRunnerCalled = true;
        return { result: "unexpected", stderrSummary: "", durationMs: 1 };
      }
    }
  );
  assert.equal(second.status, "failed");
  assert.equal(second.error.code, "write_custody_conflict");
  assert.equal(secondRunnerCalled, false);

  const reader = await delegateAgent(
    { agentType: "explore", task: "read while writer terminates", cwd: root },
    {
      writeCustody: custody,
      createExecutionId: () => ids[nextId++],
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      runAgent: completedRunner("reader completed")
    }
  );
  assert.equal(reader.status, "completed");
  assert.equal(reader.custodyState, "not-applicable");

  const otherWriter = await delegateAgent(
    { agentType: "general-purpose", task: "write another root", cwd: otherRoot },
    {
      writeCustody: custody,
      createExecutionId: () => ids[nextId++],
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: completedRunner("other root completed")
    }
  );
  assert.equal(otherWriter.status, "completed");
  assert.equal(otherWriter.custodyState, "released");

  // Explicitly control taskkill helper close
  terminator.emit("close", 0, null);
  await afterRunnerStarts();
  assert.equal(custody.getWriteAccess(rootKey).state, "TERMINATING");
  let afterTaskkillRunnerCalled = false;
  const afterTaskkill = await delegateAgent(
    { agentType: "task", task: "must remain blocked after taskkill exits", cwd: root },
    {
      ...writerDependencies,
      runAgent: async () => {
        afterTaskkillRunnerCalled = true;
        return { result: "unexpected", stderrSummary: "", durationMs: 1 };
      }
    }
  );
  assert.equal(afterTaskkill.status, "failed");
  assert.equal(afterTaskkill.error.code, "write_custody_conflict");
  assert.equal(afterTaskkillRunnerCalled, false);

  // Emit exact child close while still inside the controlled termination window
  child.emit("close", null, "SIGKILL");
  const firstOutcome = await first;
  assert.equal(firstOutcome.status, "timeout");
  assert.equal(firstOutcome.error.code, "claude_timeout");
  assert.equal(firstOutcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(rootKey), undefined);

  const afterTerminal = await delegateAgent(
    { agentType: "task", task: "writer after proven terminal", cwd: root },
    {
      writeCustody: custody,
      createExecutionId: () => ids[nextId++],
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: completedRunner("after terminal completed")
    }
  );
  assert.equal(afterTerminal.status, "completed");
  assert.equal(afterTerminal.custodyState, "released");
});

test("termination deadline crossed without exact child close fails closed with claude_termination_unproven and retains ORPHANED custody", async () => {
  const clock = manualClock();
  const custody = new WriteCustodyManager();
  const root = projectRoot;
  const child = stalledChildForTermination();
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  let taskkillStarted;
  const taskkillStartedPromise = new Promise((resolve) => {
    taskkillStarted = resolve;
  });
  let writerStarted;
  const writerStartedPromise = new Promise((resolve) => {
    writerStarted = resolve;
  });
  const ids = ["timeout-unproven-1", "timeout-unproven-2"];
  let nextId = 0;
  const runtime = writerRuntime(1_000);
  const terminationTimeoutMs = 5_000;
  const writerDependencies = {
    writeCustody: custody,
    createExecutionId: () => ids[nextId++],
    resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
    resolveRuntime: () => runtime,
    runAgent: (argumentsForRunner) => runClaudeAgent({
      ...argumentsForRunner,
      runtime,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule,
      async onChildStarted(processIdentity) {
        await argumentsForRunner.onChildStarted(processIdentity);
        writerStarted();
      },
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      terminationTimeoutMs,
      terminateChild: (target, options) => terminateClaudeChild(target, {
        ...options,
        platform: "win32",
        now: clock.now,
        schedule: clock.schedule,
        cancelSchedule: clock.cancelSchedule,
        spawnTerminator() {
          taskkillStarted();
          return terminator;
        }
      })
    })
  };

  const first = delegateAgent(
    { agentType: "task", task: "run exactly one command", cwd: root },
    writerDependencies
  );
  await writerStartedPromise;
  await afterRunnerStarts();
  const rootKey = workspaceForTest(root).canonicalRepositoryKey;
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");

  // Advance clock to trigger execution timeout
  clock.advanceTo(clock.now() + runtime.timeoutMs);
  await taskkillStartedPromise;
  assert.equal(custody.getWriteAccess(rootKey).state, "TERMINATING");

  // Taskkill helper completes
  terminator.emit("close", 0, null);
  await afterRunnerStarts();

  // Deliberately cross the termination deadline WITHOUT emitting child close
  clock.advanceTo(clock.now() + terminationTimeoutMs + 100);

  // 5. Outcome must fail closed with claude_termination_unproven and ORPHANED custody
  const firstOutcome = await first;
  assert.equal(firstOutcome.status, "timeout");
  assert.equal(firstOutcome.error.code, "claude_termination_unproven");
  assert.equal(firstOutcome.custodyState, "orphaned");
  assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");

  child.emit("close", null, "SIGKILL");
});


test("taskkill failure or timeout retains ORPHANED custody and only readers remain admissible", async () => {
  for (const terminatorMode of ["failed", "timeout"]) {
    const custody = new WriteCustodyManager();
    const root = projectRoot;
    const child = stalledChildForTermination();
    const terminator = new EventEmitter();
    terminator.kill = () => true;
    const runtime = writerRuntime(10);
    let nextId = 0;
    const ids = ["orphan-writer-" + terminatorMode, "orphan-reader-" + terminatorMode, "orphan-next-" + terminatorMode];
    const first = delegateAgent(
      { agentType: "task", task: "timeout with " + terminatorMode, cwd: root },
      {
        writeCustody: custody,
        createExecutionId: () => ids[nextId++],
        resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
        resolveRuntime: () => runtime,
        runAgent: (argumentsForRunner) => runClaudeAgent({
          ...argumentsForRunner,
          runtime,
          createSettings: fakeSettings(),
          spawnProcess: () => child,
          terminationTimeoutMs: 10,
          terminateChild: (target, options) => terminateClaudeChild(target, {
            ...options,
            platform: "win32",
            spawnTerminator() {
              if (terminatorMode === "failed") {
                setImmediate(() => terminator.emit("close", 1, null));
              }
              return terminator;
            }
          })
        })
      }
    );
    const outcome = await first;
    const rootKey = workspaceForTest(root).canonicalRepositoryKey;
    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.error.code, "claude_termination_unproven");
    assert.equal(outcome.custodyState, "orphaned");
    assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");
    assert.equal(
      child.killCalls,
      1,
      terminatorMode + " taskkill failure falls back to the exact in-memory child handle"
    );
    assert.match(formatDelegateAgentOutcome(outcome), /CustodyState: orphaned/);
    assert.match(formatDelegateAgentOutcome(outcome), /ErrorCode: claude_termination_unproven/);
    assert.match(formatDelegateAgentOutcome(outcome), /write custody must remain retained/i);

    const reader = await delegateAgent(
      { agentType: "explore", task: "read orphaned root", cwd: root },
      {
        writeCustody: custody,
        createExecutionId: () => ids[nextId++],
        resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
        runAgent: completedRunner("reader completed")
      }
    );
    assert.equal(reader.status, "completed");

    let nextWriterCalled = false;
    const nextWriter = await delegateAgent(
      { agentType: "general-purpose", task: "must remain blocked", cwd: root },
      {
        writeCustody: custody,
        createExecutionId: () => ids[nextId++],
        resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
        resolveRuntime: () => runtime,
        runAgent: async () => {
          nextWriterCalled = true;
          return { result: "unexpected", stderrSummary: "", durationMs: 1 };
        }
      }
    );
    assert.equal(nextWriter.status, "failed");
    assert.equal(nextWriter.error.code, "write_custody_conflict");
    assert.equal(nextWriterCalled, false);
  }
});

test("target close cannot release writer custody while a launched taskkill helper is unproven", async () => {
  const custody = new WriteCustodyManager();
  const child = stalledChildForTermination();
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
    return true;
  };
  let taskkillStarted;
  const taskkillStartedPromise = new Promise((resolve) => {
    taskkillStarted = resolve;
  });
  const runtime = writerRuntime(10);
  const pending = delegateAgent(
    { agentType: "task", task: "target closes before helper", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "helper-unproven-writer",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminationTimeoutMs: 20,
        terminateChild: (target, options) => terminateClaudeChild(target, {
          ...options,
          platform: "win32",
          spawnTerminator() {
            taskkillStarted();
            return terminator;
          }
        })
      })
    }
  );

  await taskkillStartedPromise;
  child.emit("close", null, "SIGTERM");
  const outcome = await pending;
  const rootKey = workspaceForTest(projectRoot).canonicalRepositoryKey;
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.error.code, "claude_termination_unproven");
  assert.equal(outcome.custodyState, "orphaned");
  assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");
  assert.equal(terminator.killCalls, 1, "the hanging helper receives an exact-handle stop request");
});

test("synchronous spawn and pre-spawn failures return an unstarted reservation safely", async () => {
  for (const code of ["claude_spawn_failed", "claude_runtime_settings_failed"]) {
    const custody = new WriteCustodyManager();
    const root = projectRoot;
    const runtime = writerRuntime();
    const outcome = await delegateAgent(
      { agentType: "task", task: "pre-spawn failure", cwd: root },
      {
        writeCustody: custody,
        createExecutionId: () => "pre-spawn-" + code,
        resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
        resolveRuntime: () => runtime,
        runAgent: (argumentsForRunner) => runClaudeAgent({
          ...argumentsForRunner,
          runtime,
          createSettings: code === "claude_runtime_settings_failed"
            ? async () => {
                throw new Error("settings failure");
              }
            : fakeSettings(),
          spawnProcess: () => {
            throw new Error("synchronous spawn failure");
          }
        })
      }
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.code, code);
    assert.equal(outcome.custodyState, "released");
    assert.equal(custody.getWriteAccess(workspaceForTest(root).canonicalRepositoryKey), undefined);
  }
});

/**
 * Wraps real timers so a test can prove a bounded wait both fires and never
 * detaches itself from the event loop. Every timer this scheduler hands out
 * records whether unref() was called on it.
 */
function recordingScheduler() {
  const timers = [];
  const schedule = (callback, delayMs) => {
    const timer = {
      unrefCalls: 0,
      handle: setTimeout(callback, delayMs),
      unref() {
        this.unrefCalls += 1;
        return this;
      }
    };
    timers.push(timer);
    return timer;
  };
  const cancelSchedule = (timer) => {
    if (timer?.handle) clearTimeout(timer.handle);
  };
  return { timers, schedule, cancelSchedule };
}

test("terminal-proof and terminator deadlines resolve deterministically on referenced timers", async () => {
  // Non-Windows path: the child never becomes terminal, so only the deadline
  // can settle the wait.
  const proofScheduler = recordingScheduler();
  const stalledChild = stalledChildForTermination();
  const proofResult = await terminateClaudeChild(stalledChild, {
    platform: "linux",
    terminationTimeoutMs: 10,
    schedule: proofScheduler.schedule,
    cancelSchedule: proofScheduler.cancelSchedule
  });
  assert.equal(proofResult.status, "termination-unproven");
  assert.equal(proofResult.method, "child-kill");
  assert.equal(proofResult.terminalProof, undefined);
  assert.ok(proofScheduler.timers.length > 0, "the terminal-proof wait must arm a bounded deadline");

  // Windows path: taskkill starts but never closes, so the terminator deadline
  // and the following terminal-proof deadline both have to fire.
  const terminatorScheduler = recordingScheduler();
  const windowsChild = stalledChildForTermination();
  const terminator = new EventEmitter();
  let terminatorKillCalls = 0;
  terminator.kill = () => {
    terminatorKillCalls += 1;
    return true;
  };
  const processIdentity = {
    executionId: "deadline-writer",
    agentType: "task",
    repositoryRoot: projectRoot,
    pid: windowsChild.pid,
    startTime: String(windowsChild.pid * 100),
    source: "test-process-start",
    child: windowsChild,
    startedAt: 1
  };
  const terminatorResult = await terminateClaudeChild(windowsChild, {
    platform: "win32",
    terminationTimeoutMs: 10,
    processIdentity,
    inspectProcess: async (pid) => inspectFakeProcess(pid),
    spawnTerminator: () => terminator,
    schedule: terminatorScheduler.schedule,
    cancelSchedule: terminatorScheduler.cancelSchedule
  });
  assert.equal(terminatorResult.status, "termination-unproven");
  assert.equal(terminatorResult.method, "taskkill");
  assert.equal(terminatorResult.taskkillStatus, "timeout");
  assert.equal(terminatorResult.terminalProof, undefined);
  assert.equal(terminatorKillCalls, 1, "the terminator deadline must kill only the process it spawned");
  assert.ok(terminatorScheduler.timers.length >= 2, "both bounded waits must arm a deadline");

  // The lifecycle property: no deadline that a custody decision depends on may
  // detach itself from the event loop.
  for (const timer of [...proofScheduler.timers, ...terminatorScheduler.timers]) {
    assert.equal(timer.unrefCalls, 0, "lifecycle deadline timers must stay referenced");
  }
});

test("a taskkill helper that errors again while being stopped stays bounded and fails closed", async () => {
  // The Claude path through the shared helper watcher. The helper reports a
  // failure, which makes us ask that exact helper to stop; asking a real
  // ChildProcess to die can make it emit `error` again on a later turn. That
  // second event must be absorbed rather than crash the coordinator, and the
  // termination must still report unproven quiescence.
  const child = stalledChildForTermination();
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
    // The stop request fails asynchronously, after the first error was handled.
    setImmediate(() => terminator.emit("error", new Error("kill request failed")));
    return true;
  };
  const processIdentity = {
    executionId: "helper-error-writer",
    agentType: "task",
    repositoryRoot: projectRoot,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "test-process-start",
    child,
    startedAt: 1
  };

  const result = await terminateClaudeChild(child, {
    platform: "win32",
    terminationTimeoutMs: 40,
    processIdentity,
    inspectProcess: async (pid) => inspectFakeProcess(pid),
    spawnTerminator: () => {
      setImmediate(() => terminator.emit("error", new Error("taskkill failed")));
      return terminator;
    }
  });

  assert.equal(result.status, "termination-unproven");
  assert.equal(result.method, "taskkill");
  assert.equal(result.terminalProof, undefined, "no proof may be produced without both closes");
  assert.equal(result.taskkillHelperQuiescenceProven, false);
  assert.equal(result.helperQuiescenceUnproven, true);
  assert.equal(terminator.killCalls, 1, "a repeated helper error must not request another kill");
  assert.equal(child.killCalls, 1, "helper failure falls back to the exact target handle once");

  // A late error arriving after the watcher settled is still absorbed.
  assert.doesNotThrow(() => terminator.emit("error", new Error("late error")));
});

test("an unproven taskkill termination records the helper identity for later quiescence", async () => {
  // The helper outlives the termination bound without closing. Same-session
  // reclaim must later be able to observe that exact helper - PID plus start
  // time - so the unproven result carries its durable identity.
  const child = stalledChildForTermination();
  const helperPid = 48_001;
  const terminator = new EventEmitter();
  terminator.pid = helperPid;
  terminator.kill = () => true;
  const processIdentity = {
    executionId: "helper-identity-writer",
    agentType: "task",
    repositoryRoot: projectRoot,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "test-process-start",
    child,
    startedAt: 1
  };

  const result = await terminateClaudeChild(child, {
    platform: "win32",
    terminationTimeoutMs: 20,
    processIdentity,
    inspectProcess: async (pid) => {
      if (pid === helperPid) {
        return {
          status: "alive",
          identity: { pid: helperPid, startTime: String(helperPid * 100), source: "test-process-start" }
        };
      }
      return inspectFakeProcess(pid);
    },
    spawnTerminator: () => terminator
  });

  assert.equal(result.status, "termination-unproven");
  assert.equal(result.method, "taskkill");
  assert.equal(result.taskkillLaunched, true);
  assert.equal(result.taskkillHelperQuiescenceProven, false);
  assert.deepEqual(result.taskkillHelperIdentity, {
    pid: helperPid,
    startTime: String(helperPid * 100),
    source: "test-process-start"
  });
});

test("an unproven taskkill termination without a helper PID degrades to absent identity", async () => {
  // A helper the coordinator cannot even name (no PID on the handle) leaves
  // no durable identity to re-observe. The launch is still reported honestly;
  // reclaim then stays fail-closed via evidence-unknown.
  const child = stalledChildForTermination();
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  const processIdentity = {
    executionId: "helper-no-pid-writer",
    agentType: "task",
    repositoryRoot: projectRoot,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "test-process-start",
    child,
    startedAt: 1
  };

  const result = await terminateClaudeChild(child, {
    platform: "win32",
    terminationTimeoutMs: 20,
    processIdentity,
    inspectProcess: async (pid) => inspectFakeProcess(pid),
    spawnTerminator: () => terminator
  });

  assert.equal(result.status, "termination-unproven");
  assert.equal(result.method, "taskkill");
  assert.equal(result.taskkillLaunched, true);
  assert.equal(result.taskkillHelperQuiescenceProven, false);
  assert.equal(result.taskkillHelperIdentity, undefined);
});

test("lifecycle waits keep the runtime alive until the bounded decision resolves", () => {
  // Runs each bounded wait in a Node process that holds no other event-loop
  // handle. With an unref'd deadline the runtime drains and the Promise is
  // still pending at exit, which is exactly how remote CI reported
  // "Promise resolution is still pending but the event loop has already
  // resolved". Both modes must settle before exit.
  for (const mode of ["terminal-proof", "terminator"]) {
    const probe = spawnSync(
      process.execPath,
      [path.join(projectRoot, "tests", "fixtures", "lifecycle-event-loop-probe.mjs"), mode],
      { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 }
    );
    assert.equal(probe.status, 0, mode + " probe failed: " + (probe.stderr || ""));
    assert.match(probe.stdout, /^RESOLVED /mu, mode + " lifecycle Promise never settled");
    assert.match(probe.stdout, /^SETTLED true$/mu, mode + " settled only after the event loop drained");
  }
});

test("an ORPHANED custody transition settles instead of leaving a pending Promise", async () => {
  // The remote CI failure surfaced here: the writer times out, taskkill never
  // closes, and the delegation must still reach a terminal ORPHANED outcome
  // under real timers rather than hanging on a detached deadline.
  const custody = new WriteCustodyManager();
  const child = stalledChildForTermination();
  const terminator = new EventEmitter();
  terminator.kill = () => true;
  const runtime = writerRuntime(10);
  const scheduler = recordingScheduler();

  const outcome = await delegateAgent(
    { agentType: "task", task: "orphan under real timers", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "orphan-settles",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminationTimeoutMs: 10,
        terminateChild: (target, options) => terminateClaudeChild(target, {
          ...options,
          platform: "win32",
          schedule: scheduler.schedule,
          cancelSchedule: scheduler.cancelSchedule,
          spawnTerminator: () => terminator
        })
      })
    }
  );

  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.error.code, "claude_termination_unproven");
  assert.equal(outcome.custodyState, "orphaned");
  assert.equal(
    custody.getWriteAccess(workspaceForTest(projectRoot).canonicalRepositoryKey).state,
    "ORPHANED"
  );
  for (const timer of scheduler.timers) {
    assert.equal(timer.unrefCalls, 0, "the ORPHANED decision must not depend on a detached timer");
  }
});

test("runner lifecycle failures never become completed outcomes", async () => {
  const timeout = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: projectRoot },
    {
      runAgent: async () => {
        throw new ClaudeTimeoutError(100, { durationMs: 12 });
      }
    }
  );
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.error.code, "claude_timeout");
  assert.match(formatDelegateAgentOutcome(timeout), /Status: timeout/);

  const failure = await delegateAgent(
    { agentType: "security-review", task: "review", cwd: projectRoot },
    {
      runAgent: async () => {
        throw new ClaudeExitError(1, null, { durationMs: 3, stderrSummary: "bad input" });
      }
    }
  );
  assert.equal(failure.status, "failed");
  assert.equal(failure.error.code, "claude_non_zero_exit");
  assert.equal(Object.hasOwn(failure, "result"), false);
  assert.match(formatDelegateAgentOutcome(failure), /StderrSummary:\nbad input/);
  assert.match(formatDelegateAgentOutcome(failure), /ErrorCode: claude_non_zero_exit/);
});

test("contract-loader failures become MCP errors and do not call the runner", async () => {
  let runnerCalled = false;
  await assert.rejects(
    delegateAgent(
      { agentType: "explore", task: "inspect contract", cwd: projectRoot },
      {
        loadContract: async () => {
          throw new Error("contract missing for test");
        },
        runAgent: async () => {
          runnerCalled = true;
          return { result: "unexpected", stderrSummary: "", durationMs: 1 };
        }
      }
    ),
    /contract missing for test/
  );
  assert.equal(runnerCalled, false);

  let registration;
  registerDelegateAgentTool(
    {
      registerTool(name, definition, handler) {
        registration = { name, definition, handler };
      }
    },
    { delegate: async () => { throw new Error("contract missing for test"); } }
  );
  const response = await registration.handler({
    agent_type: "explore",
    task: "inspect contract",
    cwd: projectRoot
  });
  assert.equal(registration.name, "delegate_agent");
  assert.equal(response.isError, true);
  assert.equal(delegateAgentOutputSchema.safeParse(response.structuredContent).success, true);
  assert.equal(response.structuredContent.status, "rejected");
  assert.match(response.content[0].text, /delegate_agent failed:\ncontract missing for test/);
});

test("MCP handler exposes completed metadata and treats failed execution as an error", async () => {
  let registration;
  const server = {
    registerTool(name, definition, handler) {
      registration = { name, definition, handler };
    }
  };

  registerDelegateAgentTool(server, {
    delegate: async ({ agentType }) => ({
      executionId: "execution-success",
      agentType,
      status: "completed",
      accessMode: "read",
      effectiveCwd: projectRoot,
      canonicalRoot: projectRoot,
      custodyState: "not-applicable",
      model: "test-claude",
      reasoningEffort: "low",
      timeoutMs: 100,
      timeoutSource: "profile",
      durationMs: 4,
      runtimeCapabilities: "Read only requested tools.",
      result: "agent response",
      stderrSummary: ""
    })
  });
  assert.equal(registration.name, "delegate_agent");
  assert.equal(registration.definition.inputSchema, delegateAgentInputSchema);
  assert.equal(registration.definition.outputSchema, delegateAgentOutputSchema);
  const success = await registration.handler({ agent_type: "explore", task: "inspect", cwd: projectRoot });
  assert.equal(success.isError, undefined);
  assert.equal(delegateAgentOutputSchema.safeParse(success.structuredContent).success, true);
  assert.equal(success.structuredContent.schema, "claude-agents-mcp/delegate-outcome/v1");
  assert.equal(success.structuredContent.execution.id, "execution-success");
  assert.match(success.content[0].text, /Agent: explore/);
  assert.match(success.content[0].text, /ExecutionId: execution-success/);
  assert.match(success.content[0].text, /Status: completed/);
  assert.match(success.content[0].text, /AccessMode: read/);
  assert.match(success.content[0].text, /CanonicalRoot: /);
  assert.match(success.content[0].text, /CustodyState: not-applicable/);
  assert.match(success.content[0].text, /agent response/);

  registerDelegateAgentTool(server, {
    delegate: async ({ agentType }) => ({
      executionId: "execution-timeout",
      agentType,
      status: "timeout",
      accessMode: "write",
      effectiveCwd: projectRoot,
      canonicalRoot: projectRoot,
      custodyState: "released",
      model: "test-claude",
      reasoningEffort: "medium",
      timeoutMs: 100,
      timeoutSource: "profile",
      durationMs: 100,
      runtimeCapabilities: "Read only requested tools.",
      error: { code: "claude_timeout", message: "timed out" },
      stderrSummary: ""
    })
  });
  const failure = await registration.handler({ agent_type: "explore", task: "inspect" });
  assert.equal(failure.isError, true);
  assert.equal(delegateAgentOutputSchema.safeParse(failure.structuredContent).success, true);
  assert.equal(failure.structuredContent.execution.error.code, "claude_timeout");
  assert.match(failure.content[0].text, /Status: timeout/);
  assert.match(failure.content[0].text, /Error: timed out/);
});

test("Claude runner transports multi-KB prompts through stdin, never argv", async () => {
  const prompt = "large role contract and assignment\n".repeat(2500);
  const runtime = runtimeForTest();
  const child = createFakeChild();
  child.pid = 6789;
  const received = [];
  let spawnedArgs;
  let spawnedOptions;
  child.stdin.on("data", (chunk) => received.push(Buffer.from(chunk)));

  const pending = runClaudeAgent({
    prompt,
    cwd: projectRoot,
    runtime,
    createSettings: fakeSettings(),
    spawnProcess(_bin, args, options) {
      spawnedArgs = args;
      spawnedOptions = options;
      return child;
    }
  });
  await afterRunnerStarts();
  child.stdout.end("specialist output");
  child.stderr.end();
  child.emit("close", 0, null);

  const result = await pending;
  assert.equal(Buffer.concat(received).toString("utf8"), prompt);
  assert.deepEqual(
    spawnedArgs,
    getClaudeRunnerArgs(runtime, "C:\\temp\\claude-runtime-settings.json")
  );
  assert.equal(spawnedArgs.includes(prompt), false);
  assert.equal(spawnedArgs.includes("--input-format"), true);
  assert.equal(spawnedArgs.includes("--setting-sources"), true);
  assert.equal(spawnedArgs.includes("--strict-mcp-config"), true);
  assert.equal(spawnedArgs.includes("--restricted"), true);
  assert.equal(spawnedArgs.includes("--no-session-persistence"), true);
  assert.equal(spawnedOptions.shell, false);
  assert.equal(spawnedOptions.windowsHide, true);
  assert.deepEqual(spawnedOptions.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(spawnedOptions.env, runtime.childEnvironment);
  assert.equal(result.result, "specialist output");
  assert.equal(result.pid, 6789);
});

test("Claude stdin remains gated until PID plus start-time identity is accepted", async () => {
  const child = createFakeChild({ pid: 6790 });
  const received = [];
  child.stdin.on("data", (chunk) => received.push(Buffer.from(chunk)));
  let releaseIdentityPersistence;
  const identityPersisted = new Promise((resolve) => {
    releaseIdentityPersistence = resolve;
  });
  let identityObserved;
  let notifyIdentityObserved;
  const identityObservedPromise = new Promise((resolve) => {
    notifyIdentityObserved = resolve;
  });

  const pending = runClaudeAgent({
    prompt: "gated prompt",
    cwd: projectRoot,
    repositoryRoot: projectRoot,
    executionId: "identity-gate",
    agentType: "task",
    runtime: runtimeForTest(),
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    async onChildStarted(processIdentity) {
      identityObserved = processIdentity;
      notifyIdentityObserved();
      await identityPersisted;
    }
  });

  await identityObservedPromise;
  assert.equal(identityObserved.pid, 6790);
  assert.equal(identityObserved.startTime, "679000");
  assert.equal(received.length, 0);
  releaseIdentityPersistence();
  await afterRunnerStarts();
  assert.equal(Buffer.concat(received).toString("utf8"), "gated prompt");
  child.stdout.end("done");
  child.emit("close", 0, null);
  await pending;
});

test("a child that closes during durable activation is handled without waiting for the profile timeout", async () => {
  const child = createFakeChild({ pid: 6791 });
  const received = [];
  child.stdin.on("data", (chunk) => received.push(Buffer.from(chunk)));
  let releaseActivation;
  const activationMayFinish = new Promise((resolve) => {
    releaseActivation = resolve;
  });
  let notifyActivationStarted;
  const activationStarted = new Promise((resolve) => {
    notifyActivationStarted = resolve;
  });

  const pending = runClaudeAgent({
    prompt: "must remain gated",
    cwd: projectRoot,
    repositoryRoot: projectRoot,
    executionId: "early-close-during-activation",
    agentType: "task",
    runtime: runtimeForTest({ timeoutMs: 1_000 }),
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    async onChildStarted() {
      notifyActivationStarted();
      await activationMayFinish;
    }
  });

  await activationStarted;
  child.stderr.end("startup failed before prompt");
  child.emit("close", 7, null);
  releaseActivation();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof ClaudeExitError);
    assert.equal(error.code, "claude_non_zero_exit");
    assert.equal(error.stderrSummary, "startup failed before prompt");
    return true;
  });
  assert.equal(received.length, 0);
});

test("startup stdout and a clean close before assignment cannot complete a writer", async () => {
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ pid: 6792 });
  const received = [];
  child.stdin.on("data", (chunk) => received.push(Buffer.from(chunk)));
  let notifyActivationStarted;
  const activationStarted = new Promise((resolve) => {
    notifyActivationStarted = resolve;
  });
  let notifyCancellationObserved;
  const cancellationObserved = new Promise((resolve) => {
    notifyCancellationObserved = resolve;
  });
  let notifyActivationFinished;
  const activationFinished = new Promise((resolve) => {
    notifyActivationFinished = resolve;
  });
  let activationSignal;
  let terminalRelease;
  const releaseAfterTerminal = custody.releaseWriteAccessAfterTerminal.bind(custody);
  custody.releaseWriteAccessAfterTerminal = (details) => {
    terminalRelease = details.terminalProof;
    return releaseAfterTerminal(details);
  };
  const runtime = writerRuntime(1_000);

  const pending = delegateAgent(
    { agentType: "task", task: "must not treat startup text as an answer", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "clean-close-before-assignment",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        async onChildStarted(processIdentity, context) {
          activationSignal = context.mutationSignal;
          notifyActivationStarted();
          await new Promise((resolve) => {
            const continueAfterCancellation = () => {
              notifyCancellationObserved();
              resolve();
            };
            context.mutationSignal.addEventListener("abort", continueAfterCancellation, { once: true });
            if (context.mutationSignal.aborted) continueAfterCancellation();
          });
          // This deliberately completes after runner cancellation was
          // requested, modeling a lifecycle callback that was already in
          // flight. The terminal release still serializes against it.
          await argumentsForRunner.onChildStarted(processIdentity, context);
          notifyActivationFinished();
        }
      })
    }
  );

  await activationStarted;
  child.stdout.end("startup text is not a specialist result");
  child.emit("close", 0, null);
  await cancellationObserved;
  await activationFinished;

  const outcome = await pending;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "claude_exited_before_ready");
  assert.equal("result" in outcome, false);
  assert.equal(activationSignal.aborted, true);
  assert.equal(Buffer.concat(received).length, 0);
  assert.equal(terminalRelease.event, "close");
  assert.equal(terminalRelease.code, 0);
  assert.equal(custody.getWriteAccess(workspaceForTest(projectRoot).canonicalRepositoryKey), undefined);
});

test("Claude runner removes per-invocation settings on success, failure, and timeout", async () => {
  let successfulCleanup = 0;
  const successfulChild = createFakeChild();
  const successful = runClaudeAgent({
    prompt: "success",
    cwd: projectRoot,
    runtime: runtimeForTest(),
    createSettings: fakeSettings(async () => {
      successfulCleanup += 1;
    }),
    spawnProcess: () => successfulChild
  });
  await afterRunnerStarts();
  successfulChild.stdout.end("done");
  successfulChild.emit("close", 0, null);
  await successful;
  assert.equal(successfulCleanup, 1);

  let failureCleanup = 0;
  const failedChild = createFakeChild();
  const failed = runClaudeAgent({
    prompt: "failure",
    cwd: projectRoot,
    runtime: runtimeForTest(),
    createSettings: fakeSettings(async () => {
      failureCleanup += 1;
    }),
    spawnProcess: () => failedChild
  });
  await afterRunnerStarts();
  failedChild.stderr.end("failure diagnostic");
  failedChild.emit("close", 1, null);
  await assert.rejects(failed, ClaudeExitError);
  assert.equal(failureCleanup, 1);

  let timeoutCleanup = 0;
  class StalledStdin extends EventEmitter {
    write() { return false; }
    end() {}
  }
  const timedOutChild = createFakeChild({
    stdin: new StalledStdin(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  });
  await assert.rejects(
    runClaudeAgent({
      prompt: "timeout",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 10 }),
      createSettings: fakeSettings(async () => {
        timeoutCleanup += 1;
      }),
      spawnProcess: () => timedOutChild,
      terminateChild: terminateFakeChild
    }),
    ClaudeTimeoutError
  );
  assert.equal(timeoutCleanup, 1);
});

test("runtime settings failures fail closed before Claude spawn and spawn failures still clean up", async () => {
  let spawnedAfterSettingsFailure = false;
  await assert.rejects(
    runClaudeAgent({
      prompt: "settings failure",
      cwd: projectRoot,
      runtime: runtimeForTest(),
      createSettings: async () => {
        throw new Error("cannot create settings");
      },
      spawnProcess: () => {
        spawnedAfterSettingsFailure = true;
        return createFakeChild();
      }
    }),
    (error) => error instanceof ClaudeRunnerError && error.code === "claude_runtime_settings_failed"
  );
  assert.equal(spawnedAfterSettingsFailure, false);

  let spawnFailureCleanup = 0;
  await assert.rejects(
    runClaudeAgent({
      prompt: "spawn failure",
      cwd: projectRoot,
      runtime: runtimeForTest(),
      createSettings: fakeSettings(async () => {
        spawnFailureCleanup += 1;
      }),
      spawnProcess: () => {
        throw new Error("spawn unavailable");
      }
    }),
    (error) => error instanceof ClaudeRunnerError && error.code === "claude_spawn_failed"
  );
  assert.equal(spawnFailureCleanup, 1);

  let malformedSettingsCleanup = 0;
  await assert.rejects(
    runClaudeAgent({
      prompt: "malformed settings",
      cwd: projectRoot,
      runtime: runtimeForTest(),
      createSettings: async () => ({
        settingsPath: "",
        cleanup: async () => {
          malformedSettingsCleanup += 1;
        }
      }),
      spawnProcess: () => {
        throw new Error("runner must not spawn with malformed settings");
      }
    }),
    (error) => error instanceof ClaudeRunnerError && error.code === "invalid_runtime_policy"
  );
  assert.equal(malformedSettingsCleanup, 1);
});

test("Claude arms asynchronous ChildProcess spawn errors before identity inspection", async () => {
  const child = createFakeChild();
  child.pid = undefined;
  const pending = runClaudeAgent({
    prompt: "async spawn failure",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 1_000 }),
    createSettings: fakeSettings(),
    spawnProcess: () => {
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      return child;
    },
    inspectProcess: async () => new Promise(() => {})
  });

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "claude_spawn_failed");
    assert.equal(error.processStarted, false);
    return true;
  });
});

test("identity-unavailable Claude termination uses the exact handle, never PID-only taskkill", async () => {
  const child = createFakeChild({ pid: 67_891 });
  let taskkillCalled = false;
  await assert.rejects(
    runClaudeAgent({
      prompt: "ambiguous identity",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 1_000 }),
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      inspectProcess: async () => ({ status: "ambiguous", reason: "denied" }),
      terminateChild: (target, options) => terminateClaudeChild(target, {
        ...options,
        platform: "win32",
        spawnTerminator() {
          taskkillCalled = true;
          throw new Error("taskkill must not receive an identity-less PID");
        }
      })
    }),
    (error) => {
      assert.equal(error.code, "claude_process_identity_unavailable");
      assert.equal(error.terminalProof.supervisedByCoordinator, true);
      return true;
    }
  );
  assert.equal(child.killCalls, 1);
  assert.equal(taskkillCalled, false);
});

test("an exit during identity capture cannot become a durable Claude identity", async () => {
  const child = createFakeChild({ closeOnKill: false, pid: 67_892 });
  let resolveInspection;
  const inspection = new Promise((resolve) => {
    resolveInspection = resolve;
  });
  let activated = false;
  const pending = runClaudeAgent({
    prompt: "identity race",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 1_000 }),
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    inspectProcess: async () => await inspection,
    onChildStarted() {
      activated = true;
    },
    terminateChild: terminateFakeChild
  });

  await afterRunnerStarts();
  child.emit("exit", 0, null);
  resolveInspection({
    status: "alive",
    identity: { pid: child.pid, startTime: "6789200", source: "test-process-start" }
  });
  child.emit("close", 0, null);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "claude_exited_before_ready");
    assert.equal(error.processIdentity, undefined);
    assert.equal(error.terminalProof.supervisedByCoordinator, true);
    return true;
  });
  assert.equal(activated, false);
});

test("profile deadlines include identity and durable activation setup", async () => {
  const stalledIdentityChild = createFakeChild();
  await assert.rejects(
    runClaudeAgent({
      prompt: "identity deadline",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 15 }),
      createSettings: fakeSettings(),
      spawnProcess: () => stalledIdentityChild,
      inspectProcess: async () => await new Promise(() => {}),
      terminateChild: terminateFakeChild
    }),
    ClaudeTimeoutError
  );
  assert.equal(stalledIdentityChild.killCalls, 1);

  const stalledActivationChild = createFakeChild();
  await assert.rejects(
    runClaudeAgent({
      prompt: "activation deadline",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 15 }),
      createSettings: fakeSettings(),
      spawnProcess: () => stalledActivationChild,
      onChildStarted: async () => await new Promise(() => {}),
      terminateChild: terminateFakeChild
    }),
    ClaudeTimeoutError
  );
  assert.equal(stalledActivationChild.killCalls, 1);
});

test("root cancellation during identity capture never starts durable activation", async () => {
  const controller = new AbortController();
  const child = createFakeChild();
  let releaseIdentity;
  const identityMayFinish = new Promise((resolve) => {
    releaseIdentity = resolve;
  });
  let notifyIdentityStarted;
  const identityStarted = new Promise((resolve) => {
    notifyIdentityStarted = resolve;
  });
  let activated = false;

  const pending = runClaudeAgent({
    prompt: "root cancellation during identity",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 1_000 }),
    abortSignal: controller.signal,
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    async inspectProcess() {
      notifyIdentityStarted();
      return await identityMayFinish;
    },
    onChildStarted() {
      activated = true;
    },
    terminateChild: terminateFakeChild
  });

  await identityStarted;
  controller.abort();
  releaseIdentity({
    status: "alive",
    identity: { pid: child.pid, startTime: String(child.pid * 100), source: "test-process-start" }
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "claude_cancelled");
    return true;
  });
  assert.equal(activated, false);
  assert.equal(child.killCalls, 1);
});

test("root cancellation before deferred settings creation starts no runner filesystem setup", async () => {
  const controller = new AbortController();
  let settingsStarted = false;
  let spawnStarted = false;
  const pending = runClaudeAgent({
    prompt: "root cancellation before settings",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 1_000 }),
    abortSignal: controller.signal,
    createSettings: async () => {
      settingsStarted = true;
      return {
        settingsPath: "C:\\temp\\must-not-exist.json",
        cleanup: async () => {}
      };
    },
    spawnProcess: () => {
      spawnStarted = true;
      return createFakeChild();
    }
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "claude_cancelled");
    assert.equal(error.processStarted, false);
    return true;
  });
  assert.equal(settingsStarted, false);
  assert.equal(spawnStarted, false);
});

test("root cancellation reaches an in-flight durable activation mutation", async () => {
  const controller = new AbortController();
  const child = createFakeChild();
  let releaseActivation;
  const activationMayFinish = new Promise((resolve) => {
    releaseActivation = resolve;
  });
  let notifyActivationStarted;
  const activationStarted = new Promise((resolve) => {
    notifyActivationStarted = resolve;
  });
  let activationSignal;

  const pending = runClaudeAgent({
    prompt: "root cancellation during activation",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 1_000 }),
    abortSignal: controller.signal,
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    async onChildStarted(_processIdentity, { mutationSignal }) {
      activationSignal = mutationSignal;
      notifyActivationStarted();
      await activationMayFinish;
    },
    terminateChild: terminateFakeChild
  });

  await activationStarted;
  controller.abort();
  const signalWasAborted = activationSignal.aborted;
  releaseActivation();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "claude_cancelled");
    return true;
  });
  assert.equal(signalWasAborted, true);
  assert.equal(child.killCalls, 1);
});

test("a timed-out durable termination transition reports cancellation without claiming pre-publication invalidation", async () => {
  const child = createFakeChild();
  let mutationSignal;
  let callbackTerminationDeadlineAt;
  let childTerminationDeadlineAt;
  await assert.rejects(
    runClaudeAgent({
      prompt: "termination callback timeout",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 10 }),
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      terminationTimeoutMs: 20,
      onTerminationStarted(_processIdentity, context) {
        mutationSignal = context.mutationSignal;
        callbackTerminationDeadlineAt = context.terminationDeadlineAt;
        return new Promise(() => {});
      },
      terminateChild: async (target, options) => {
        childTerminationDeadlineAt = options.terminationDeadlineAt;
        target.emit("close", null, "SIGTERM");
        return {
          status: "terminated",
          method: "test",
          terminalProof: options.terminalObserver.getTerminalProof()
        };
      }
    }),
    (error) => {
      assert.equal(error.code, "claude_timeout");
      assert.equal(error.terminationResult.durableTransition.status, "timed-out");
      assert.equal(error.terminationResult.durableTransition.cancellationRequested, true);
      assert.equal(
        Object.hasOwn(error.terminationResult.durableTransition, "authorityInvalidated"),
        false
      );
      assert.equal(error.terminalProof.event, "close");
      return true;
    }
  );
  assert.equal(mutationSignal.aborted, true);
  assert.equal(callbackTerminationDeadlineAt, childTerminationDeadlineAt);
});

test("a close that wins after durable termination starts records truthful transition evidence", async () => {
  const child = createFakeChild({ closeOnKill: false });
  let transitionStarted;
  const transitionStartedPromise = new Promise((resolve) => {
    transitionStarted = resolve;
  });
  let mutationSignal;
  const pending = runClaudeAgent({
    prompt: "close races durable termination",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 100, maxCaptureBytes: 1 }),
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    onTerminationStarted(_processIdentity, context) {
      mutationSignal = context.mutationSignal;
      transitionStarted();
      return new Promise(() => {});
    },
    terminateChild: terminateFakeChild
  });

  await afterRunnerStarts();
  child.stdout.emit("data", Buffer.from("overflow"));
  await transitionStartedPromise;
  child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "claude_output_capture_overflow");
    assert.equal(error.terminalProof.event, "close");
    assert.equal(error.terminationResult.durableTransition.status, "terminal-close-won");
    assert.equal(error.terminationResult.durableTransition.transitionStarted, true);
    assert.equal(error.terminationResult.durableTransition.cancellationRequested, true);
    assert.equal(
      Object.hasOwn(error.terminationResult.durableTransition, "authorityInvalidated"),
      false
    );
    return true;
  });
  assert.equal(mutationSignal.aborted, true);
});

test("settings cleanup failure preserves close proof and releases writer custody", async () => {
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ pid: 67_893 });
  const runtime = writerRuntime(1_000);
  const outcome = await delegateAgent(
    { agentType: "task", task: "cleanup evidence", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "cleanup-evidence",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        createSettings: fakeSettings(async () => {
          throw new Error("settings cleanup denied");
        }),
        spawnProcess: () => child,
        async onChildStarted(processIdentity) {
          await argumentsForRunner.onChildStarted(processIdentity);
          child.stdout.end("completed before cleanup");
          child.emit("close", 0, null);
        }
      })
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "claude_settings_cleanup_failed");
  assert.equal(outcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(workspaceForTest(projectRoot).canonicalRepositoryKey), undefined);
});

test("settings cleanup timeout preserves close proof and releases writer custody", async () => {
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ pid: 67_894 });
  const runtime = writerRuntime(1_000);
  const outcome = await delegateAgent(
    { agentType: "task", task: "cleanup timeout evidence", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "cleanup-timeout-evidence",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        housekeepingTimeoutMs: 10,
        createSettings: fakeSettings(async () => await new Promise(() => {})),
        spawnProcess: () => child,
        async onChildStarted(processIdentity) {
          await argumentsForRunner.onChildStarted(processIdentity);
          child.stdout.end("completed before cleanup timeout");
          child.emit("close", 0, null);
        }
      })
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "claude_settings_cleanup_timeout");
  assert.equal(outcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(workspaceForTest(projectRoot).canonicalRepositoryKey), undefined);
});

test("cleanup failure retains the original forced-termination evidence", async () => {
  const child = createFakeChild();
  await assert.rejects(
    runClaudeAgent({
      prompt: "cleanup after timeout",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 10 }),
      createSettings: fakeSettings(async () => {
        throw new Error("cleanup denied");
      }),
      spawnProcess: () => child,
      terminateChild: terminateFakeChild
    }),
    (error) => {
      assert.equal(error.code, "claude_settings_cleanup_failed");
      assert.equal(error.processOutcome.code, "claude_timeout");
      assert.equal(error.terminalProof.event, "close");
      assert.equal(error.terminationResult.status, "terminated");
      assert.equal(error.cleanupFailure.message, "cleanup denied");
      return true;
    }
  );
});

test("Windows forced termination targets only the exact Claude child PID and awaits terminal proof", async () => {
  const child = createFakeChild();
  child.pid = 4321;
  const processIdentity = Object.freeze({
    child,
    pid: child.pid,
    startTime: "432100",
    source: "test-process-start"
  });
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
  };
  let invocation;
  const terminalObserver = observeClaudeChildTerminal(child, processIdentity);
  let settled = false;
  const pending = terminateClaudeChild(child, {
    platform: "win32",
    processIdentity,
    terminalObserver,
    terminationTimeoutMs: 100,
    inspectProcess: inspectFakeProcess,
    spawnTerminator(command, args, options) {
      invocation = { command, args, options };
      return terminator;
    }
  });
  pending.then(() => {
    settled = true;
  });
  await afterRunnerStarts();
  assert.deepEqual(invocation, {
    command: "taskkill",
    args: ["/PID", "4321", "/T", "/F"],
    options: { shell: false, windowsHide: true, stdio: "ignore" }
  });
  assert.equal(child.killCalls, 0);
  terminator.emit("close", 0, null);
  await afterRunnerStarts();
  assert.equal(settled, false);
  child.emit("close", null, "SIGKILL");
  const terminated = await pending;
  assert.equal(terminated.status, "terminated");
  assert.equal(terminated.method, "taskkill");
  assert.equal(terminated.terminalProof.processIdentity, processIdentity);
  assert.equal(terminator.killCalls, 0);

  const noPidChild = createFakeChild({ pid: null });
  const noPidResult = await terminateClaudeChild(noPidChild, {
    platform: "win32",
    terminationTimeoutMs: 100
  });
  assert.equal(noPidResult.status, "terminated");
  assert.equal(noPidResult.method, "child-kill");
  assert.equal(noPidChild.killCalls, 1);

  // An exited-but-not-closed child is NOT terminal for custody purposes: its
  // stdio may still be held open by a descendant. The bounded wait must expire
  // and report the termination as unproven rather than claiming success.
  const exitedChild = createFakeChild();
  exitedChild.pid = 6789;
  exitedChild.exitCode = 0;
  const exitedObserver = observeClaudeChildTerminal(exitedChild, undefined);
  const exitedResult = await terminateClaudeChild(exitedChild, {
    platform: "win32",
    terminalObserver: exitedObserver,
    terminationTimeoutMs: 20
  });
  assert.equal(exitedResult.status, "termination-unproven");
  assert.equal(exitedResult.terminalProof, undefined);
  assert.equal(exitedChild.killCalls, 0);
  // The exit is still recorded for diagnostics.
  assert.equal(exitedObserver.getExitObservation().event, "exit");
  assert.equal(exitedObserver.getExitObservation().code, 0);
  assert.equal(exitedObserver.getTerminalProof(), undefined);

  // Once the same child actually closes, it is terminal.
  const closedChild = createFakeChild();
  closedChild.pid = 6790;
  closedChild.exitCode = 0;
  const closedObserver = observeClaudeChildTerminal(closedChild, undefined);
  closedChild.emit("close", 0, null);
  const closedResult = await terminateClaudeChild(closedChild, {
    platform: "win32",
    terminalObserver: closedObserver,
    terminationTimeoutMs: 100
  });
  assert.equal(closedResult.status, "already-terminal");
  assert.equal(closedResult.terminalProof.event, "close");
  assert.equal(closedChild.killCalls, 0);

  const mismatchedChild = createFakeChild({ closeOnKill: false });
  const mismatchedIdentity = Object.freeze({
    child: new EventEmitter(),
    pid: mismatchedChild.pid + 1
  });
  let mismatchedSpawnCalled = false;
  const mismatchedResult = await terminateClaudeChild(mismatchedChild, {
    platform: "win32",
    processIdentity: mismatchedIdentity,
    terminalObserver: observeClaudeChildTerminal(mismatchedChild, mismatchedIdentity),
    spawnTerminator() {
      mismatchedSpawnCalled = true;
      return new EventEmitter();
    }
  });
  assert.equal(mismatchedResult.status, "termination-failed");
  assert.equal(mismatchedResult.reason, "process-identity-mismatch");
  assert.equal(mismatchedSpawnCalled, false);

  const reusedPidChild = createFakeChild({ closeOnKill: false, pid: 7654 });
  const reusedPidIdentity = Object.freeze({
    child: reusedPidChild,
    pid: reusedPidChild.pid,
    startTime: "765400",
    source: "test-process-start"
  });
  let reusedPidSpawnCalled = false;
  const reusedPidObserver = observeClaudeChildTerminal(reusedPidChild, reusedPidIdentity);
  const reusedPidPending = terminateClaudeChild(reusedPidChild, {
    platform: "win32",
    processIdentity: reusedPidIdentity,
    terminalObserver: reusedPidObserver,
    terminationTimeoutMs: 100,
    inspectProcess: async () => ({
      status: "alive",
      identity: {
        pid: reusedPidChild.pid,
        startTime: "765499",
        source: "test-process-start"
      }
    }),
    spawnTerminator() {
      reusedPidSpawnCalled = true;
      return new EventEmitter();
    }
  });
  await afterRunnerStarts();
  assert.equal(reusedPidSpawnCalled, false);
  // PID reuse forbids taskkill, but the coordinator still owns this exact
  // ChildProcess handle and makes the bounded direct-handle termination attempt.
  assert.equal(reusedPidChild.killCalls, 1);
  reusedPidChild.emit("close", 0, null);
  const reusedPidResult = await reusedPidPending;
  assert.equal(reusedPidResult.status, "terminated");
  assert.equal(reusedPidResult.method, "child-kill");
  assert.equal(reusedPidResult.identityStatus, "pid-reused");
});

test("Windows taskkill helper close is separately required before Claude termination is safe", async () => {
  const child = createFakeChild({ closeOnKill: false, pid: 67_900 });
  const processIdentity = Object.freeze({
    child,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "test-process-start"
  });
  const terminalObserver = observeClaudeChildTerminal(child, processIdentity);
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
    return true;
  };
  let taskkillStarted;
  const taskkillStartedPromise = new Promise((resolve) => {
    taskkillStarted = resolve;
  });
  const hanging = terminateClaudeChild(child, {
    platform: "win32",
    processIdentity,
    terminalObserver,
    terminationTimeoutMs: 20,
    inspectProcess: inspectFakeProcess,
    spawnTerminator() {
      taskkillStarted();
      return terminator;
    }
  });
  await taskkillStartedPromise;
  child.emit("close", null, "SIGTERM");
  const unproven = await hanging;
  assert.equal(unproven.status, "termination-unproven");
  assert.equal(unproven.terminalProof, undefined);
  assert.equal(unproven.targetTerminalProofObserved, true);
  assert.equal(unproven.taskkillHelperQuiescenceProven, false);
  assert.equal(terminator.killCalls, 1, "the hung helper receives an exact-handle stop request");

  const recoveringChild = createFakeChild({ closeOnKill: false, pid: 67_901 });
  const recoveringIdentity = Object.freeze({
    child: recoveringChild,
    pid: recoveringChild.pid,
    startTime: String(recoveringChild.pid * 100),
    source: "test-process-start"
  });
  const recoveringObserver = observeClaudeChildTerminal(recoveringChild, recoveringIdentity);
  const failingTerminator = new EventEmitter();
  failingTerminator.killCalls = 0;
  failingTerminator.kill = () => {
    failingTerminator.killCalls += 1;
    return true;
  };
  let recoveredTaskkillStarted;
  const recoveredTaskkillStartedPromise = new Promise((resolve) => {
    recoveredTaskkillStarted = resolve;
  });
  let recoveredSettled = false;
  const recovering = terminateClaudeChild(recoveringChild, {
    platform: "win32",
    processIdentity: recoveringIdentity,
    terminalObserver: recoveringObserver,
    terminationTimeoutMs: 100,
    inspectProcess: inspectFakeProcess,
    spawnTerminator() {
      recoveredTaskkillStarted();
      return failingTerminator;
    }
  });
  recovering.then(() => {
    recoveredSettled = true;
  });
  await recoveredTaskkillStartedPromise;
  failingTerminator.emit("exit", 1, null);
  await afterRunnerStarts();
  assert.equal(recoveringChild.killCalls, 1, "nonzero taskkill exit falls back to the exact Claude handle");
  assert.equal(failingTerminator.killCalls, 1, "nonzero taskkill exit requests helper termination");

  recoveringChild.emit("close", null, "SIGTERM");
  await afterRunnerStarts();
  assert.equal(recoveredSettled, false, "target close cannot be confused with helper close");

  failingTerminator.emit("close", 1, null);
  const recovered = await recovering;
  assert.equal(recovered.terminalProof, recoveringObserver.getTerminalProof());
  assert.equal(recovered.taskkillHelperQuiescenceProven, true);
  assert.equal(recovered.taskkillHelper.closeProven, true);
});

test("Claude runner arms timeout before a stalled stdin can block execution", async () => {
  class StalledStdin extends EventEmitter {
    write() {
      return false;
    }

    end() {}
  }

  const child = createFakeChild({
    stdin: new StalledStdin(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  });
  const pending = runClaudeAgent({
    prompt: "stalled stdin test",
    cwd: projectRoot,
    runtime: runtimeForTest({ timeoutMs: 20 }),
    createSettings: fakeSettings(),
    spawnProcess: () => child,
    terminateChild: terminateFakeChild
  });
  await afterRunnerStarts();
  child.stdin.emit("error", new Error("write EOF"));

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof ClaudeTimeoutError);
    assert.equal(error.code, "claude_timeout");
    return true;
  });
  assert.equal(child.killCalls, 1);
});

test("Claude runner preserves early-exit diagnostics and fails closed", async () => {
  const stdinErrorChild = createFakeChild();
  const stdinFailure = runClaudeAgent({
    prompt: "stdin error",
    cwd: projectRoot,
    runtime: runtimeForTest(),
    createSettings: fakeSettings(),
    spawnProcess: () => stdinErrorChild
  });
  await afterRunnerStarts();
  stdinErrorChild.stdin.emit("error", new Error("EPIPE"));
  stdinErrorChild.stderr.end("real early-exit diagnostic");
  stdinErrorChild.stdout.end("real early-exit stdout");
  stdinErrorChild.emit("close", 129, null);
  await assert.rejects(stdinFailure, (error) => {
    assert.ok(error instanceof ClaudeExitError);
    assert.equal(error.code, "claude_non_zero_exit");
    assert.equal(error.stderrSummary, "real early-exit diagnostic");
    assert.match(error.message, /stdout:\nreal early-exit stdout/);
    return true;
  });
  assert.equal(stdinErrorChild.killCalls, 0);

  const zeroExitAfterStdinErrorChild = createFakeChild();
  const zeroExitAfterStdinFailure = runClaudeAgent({
    prompt: "stdin error with zero exit",
    cwd: projectRoot,
    runtime: runtimeForTest(),
    createSettings: fakeSettings(),
    spawnProcess: () => zeroExitAfterStdinErrorChild
  });
  await afterRunnerStarts();
  zeroExitAfterStdinErrorChild.stdin.emit("error", new Error("EPIPE"));
  zeroExitAfterStdinErrorChild.stdout.end("incomplete response");
  zeroExitAfterStdinErrorChild.emit("close", 0, null);
  await assert.rejects(zeroExitAfterStdinFailure, (error) => {
    assert.ok(error instanceof ClaudeRunnerError);
    assert.equal(error.code, "claude_stdin_failed");
    return true;
  });

  const exitChild = createFakeChild();
  const exitFailure = runClaudeAgent({
    prompt: "exit error",
    cwd: projectRoot,
    runtime: runtimeForTest(),
    createSettings: fakeSettings(),
    spawnProcess: () => exitChild
  });
  await afterRunnerStarts();
  exitChild.stderr.end("invalid invocation");
  exitChild.emit("close", 1, null);
  await assert.rejects(exitFailure, (error) => {
    assert.ok(error instanceof ClaudeExitError);
    assert.equal(error.code, "claude_non_zero_exit");
    assert.equal(error.stderrSummary, "invalid invocation");
    return true;
  });

  const overflowChild = createFakeChild();
  const overflowFailure = runClaudeAgent({
    prompt: "overflow",
    cwd: projectRoot,
    runtime: runtimeForTest({ maxCaptureBytes: 5 }),
    createSettings: fakeSettings(),
    spawnProcess: () => overflowChild,
    terminateChild: terminateFakeChild
  });
  await afterRunnerStarts();
  overflowChild.stdout.emit("data", Buffer.from("123456"));
  await assert.rejects(overflowFailure, (error) => {
    assert.ok(error instanceof ClaudeOutputCaptureOverflowError);
    assert.equal(error.code, "claude_output_capture_overflow");
    return true;
  });
  assert.equal(overflowChild.killCalls, 1);

  await assert.rejects(
    runClaudeAgent({
      prompt: "invalid timeout",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 2147483648 }),
      createSettings: fakeSettings(),
      spawnProcess: () => {
        throw new Error("runner must not spawn with an invalid timeout");
      }
    }),
    (error) => {
      assert.ok(error instanceof ClaudeRunnerError);
      assert.equal(error.code, "invalid_timeout");
      return true;
    }
  );
});

test("the terminal observer treats exit as diagnostic and only close as proof", async () => {
  const child = createFakeChild({ closeOnKill: false });
  const observer = observeClaudeChildTerminal(child, undefined, { now: () => 5_000 });

  // 1. An exit records a diagnostic observation and nothing else.
  child.emit("exit", 0, null);
  assert.equal(observer.getTerminalProof(), undefined);
  assert.equal(observer.getCloseProof(), undefined);
  assert.equal(observer.getExitObservation().event, "exit");
  assert.equal(observer.getExitObservation().code, 0);

  let resolvedWith;
  observer.terminalPromise.then((proof) => {
    resolvedWith = proof;
  });
  await afterRunnerStarts();
  // 3. The terminal promise stays pending across the gap between exit and close.
  assert.equal(resolvedWith, undefined);

  // 2. The close for the exact same child is terminal proof.
  child.emit("close", 0, "SIGTERM");
  await afterRunnerStarts();
  assert.equal(resolvedWith.event, "close");
  assert.equal(observer.getTerminalProof().event, "close");
  assert.equal(observer.getTerminalProof().signal, "SIGTERM");
  // The earlier exit is still available for diagnostics.
  assert.equal(observer.getExitObservation().event, "exit");
});

test("a writer that only exits keeps custody until its child actually closes", async () => {
  // 3, end to end: exit -> delay -> close. Custody must survive the gap.
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ closeOnKill: false });
  const runtime = writerRuntime(2_000);
  let writerActive;
  const writerActivePromise = new Promise((resolve) => {
    writerActive = resolve;
  });

  const pending = delegateAgent(
    { agentType: "task", task: "exit before close", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "exit-then-close",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        async onChildStarted(processIdentity) {
          await argumentsForRunner.onChildStarted(processIdentity);
          writerActive();
        },
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminateChild: terminateFakeChild
      })
    }
  );

  await writerActivePromise;
  await afterRunnerStarts();
  const rootKey = workspaceForTest(projectRoot).canonicalRepositoryKey;
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");

  child.stdout.write("partial result");
  child.emit("exit", 0, null);
  await afterRunnerStarts();
  await afterRunnerStarts();
  // Still owned: the direct child ended but its stdio has not closed, so a
  // descendant could still be writing.
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");

  child.stdout.end();
  child.emit("close", 0, null);
  const outcome = await pending;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(rootKey), undefined);
});

test("a child that dies before durable identity capture releases custody via supervised close", async () => {
  // 4. inspectProcess reports the child already dead, so no durable
  // PID+StartTime identity can be built. This coordinator nevertheless spawned
  // the exact ChildProcess and observed its close.
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ closeOnKill: false });
  const runtime = writerRuntime(2_000);
  let supervisedRelease;
  const releaseSupervised = custody.releaseWriteAccessAfterSupervisedClose.bind(custody);
  custody.releaseWriteAccessAfterSupervisedClose = (owner) => {
    supervisedRelease = owner.terminalProof;
    return releaseSupervised(owner);
  };

  const outcome = await delegateAgent(
    { agentType: "task", task: "die before identity capture", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "fast-death",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => {
        // The child closes during the identity query, before it can resolve.
        setImmediate(() => child.emit("close", 0, null));
        return runClaudeAgent({
          ...argumentsForRunner,
          runtime,
          createSettings: fakeSettings(),
          spawnProcess: () => child,
          inspectProcess: async () => {
            await afterRunnerStarts();
            return { status: "dead" };
          },
          terminateChild: terminateFakeChild
        });
      }
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "claude_exited_before_ready");
  // Released rather than orphaned: the coordinator saw the exact child close.
  assert.equal(outcome.custodyState, "released");
  assert.equal(supervisedRelease.event, "close");
  assert.equal(supervisedRelease.supervisedByCoordinator, true);
  // No fabricated durable identity travelled with the proof.
  assert.equal(supervisedRelease.processIdentity, undefined);
});

test("a child that neither closes nor identifies still fails closed", async () => {
  // The counterpart to the supervised-close path: without a close there is no
  // evidence at all, so custody must be retained.
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ closeOnKill: false });
  const runtime = writerRuntime(2_000);

  const outcome = await delegateAgent(
    { agentType: "task", task: "no identity and no close", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "no-evidence",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        inspectProcess: async () => ({ status: "dead" }),
        terminationTimeoutMs: 10,
        terminateChild: (target, options) => terminateClaudeChild(target, {
          ...options,
          platform: "linux"
        })
      })
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "claude_termination_unproven");
  assert.equal(outcome.custodyState, "orphaned");
  assert.equal(
    custody.getWriteAccess(workspaceForTest(projectRoot).canonicalRepositoryKey).state,
    "ORPHANED"
  );
});

test("lifecycle test doubles await async callbacks the way production does", async () => {
  // 13. runClaudeAgent awaits onChildStarted before the child may report a
  // terminal result. A double that fires the callback without awaiting would
  // model an interleaving production cannot produce, so assert the ordering
  // both in production and in the shared writer double.
  let activationFinished = false;
  let resultObserved = false;

  const custody = new WriteCustodyManager();
  const runtime = writerRuntime(2_000);
  const outcome = await delegateAgent(
    { agentType: "task", task: "ordered lifecycle", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "ordered-lifecycle",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: async (argumentsForRunner) => {
        const originalOnChildStarted = argumentsForRunner.onChildStarted;
        const execution = await completedWriterExecution(
          {
            ...argumentsForRunner,
            async onChildStarted(processIdentity) {
              await afterRunnerStarts();
              await originalOnChildStarted(processIdentity);
              activationFinished = true;
            }
          },
          "ordered result"
        );
        // The double must not have produced a terminal result before durable
        // activation completed.
        assert.equal(activationFinished, true, "onChildStarted must be awaited before the result");
        resultObserved = true;
        return execution;
      }
    }
  );

  assert.equal(outcome.status, "completed");
  assert.equal(resultObserved, true);
  assert.equal(outcome.custodyState, "released");
});

test("a rejected or slow durable activation callback fails closed without hanging", async () => {
  // Production awaits onChildStarted; if durable persistence rejects, the run
  // must stop, terminate the child, and settle.
  const custody = new WriteCustodyManager();
  const child = createFakeChild();
  const runtime = writerRuntime(2_000);

  const outcome = await delegateAgent(
    { agentType: "task", task: "activation rejects", cwd: projectRoot },
    {
      writeCustody: custody,
      createExecutionId: () => "activation-rejects",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        async onChildStarted() {
          await afterRunnerStarts();
          throw new Error("durable activation failed");
        },
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminateChild: terminateFakeChild
      })
    }
  );

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error.message, /durable activation failed|termination/iu);
  assert.notEqual(outcome.custodyState, "active");
});

test("Claude never writes assignment bytes after the absolute execution deadline", async () => {
  let clock = 0;
  const child = createFakeChild();
  const received = [];
  child.stdin.on("data", (chunk) => received.push(Buffer.from(chunk)));
  await assert.rejects(
    runClaudeAgent({
      prompt: "must not reach stdin",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 10 }),
      now: () => clock,
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      async onChildStarted() {
        // Simulate durable setup consuming exactly the profile budget.
        clock = 10;
      },
      terminateChild: terminateFakeChild
    }),
    (error) => error instanceof ClaudeTimeoutError && error.code === "claude_timeout"
  );
  assert.equal(Buffer.concat(received).length, 0);
  assert.equal(child.killCalls, 1);
});

test("forced interruption gets the same fixed proof-of-death grace before or at the execution deadline", async () => {
  async function observeGrace(interruptionAt) {
    let clock = 0;
    const child = createFakeChild({ closeOnKill: false });
    let terminationDeadlineAt;
    const pending = runClaudeAgent({
      prompt: "grace test",
      cwd: projectRoot,
      runtime: runtimeForTest({ timeoutMs: 100, maxCaptureBytes: 1 }),
      now: () => clock,
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      terminationTimeoutMs: 25,
      terminateChild: async (target, options) => {
        terminationDeadlineAt = options.terminationDeadlineAt;
        target.emit("close", null, "SIGTERM");
        return {
          status: "terminated",
          method: "test",
          terminalProof: options.terminalObserver.getTerminalProof()
        };
      }
    });
    await afterRunnerStarts();
    clock = interruptionAt;
    child.stdout.emit("data", Buffer.from("overflow"));
    await assert.rejects(pending, ClaudeOutputCaptureOverflowError);
    return terminationDeadlineAt - interruptionAt;
  }

  assert.equal(await observeGrace(99), 25);
  assert.equal(await observeGrace(100), 25);
});

test("hanging settings cleanup is bounded and preserves exact terminal evidence", async () => {
  const child = createFakeChild();
  await assert.rejects(
    (async () => {
      const pending = runClaudeAgent({
        prompt: "cleanup timeout",
        cwd: projectRoot,
        runtime: runtimeForTest(),
        housekeepingTimeoutMs: 10,
        createSettings: fakeSettings(async () => await new Promise(() => {})),
        spawnProcess: () => child
      });
      await afterRunnerStarts();
      child.stdout.end("completed before housekeeping timeout");
      child.emit("close", 0, null);
      return await pending;
    })(),
    (error) => {
      assert.equal(error.code, "claude_settings_cleanup_timeout");
      assert.equal(error.terminalProof.event, "close");
      assert.equal(error.processOutcome.status, "completed");
      assert.ok(error.cleanupFailure);
      return true;
    }
  );
});

test("a later exact close releases same-coordinator ORPHANED custody", async () => {
  const clock = manualClock();
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ closeOnKill: false });
  const runtime = writerRuntime(10);
  let writerStarted;
  const writerStartedPromise = new Promise((resolve) => {
    writerStarted = resolve;
  });
  const pending = delegateAgent(
    { agentType: "task", task: "late exact close", cwd: projectRoot },
    {
      writeCustody: custody,
      now: clock.now,
      scheduleRequestDeadline: clock.schedule,
      cancelRequestDeadline: clock.cancelSchedule,
      createExecutionId: () => "late-close-recovery",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        now: clock.now,
        schedule: clock.schedule,
        cancelSchedule: clock.cancelSchedule,
        async onChildStarted(processIdentity) {
          // Production awaits this; the wrapper must not drop the promise.
          await argumentsForRunner.onChildStarted(processIdentity);
          writerStarted();
        },
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminationTimeoutMs: 10,
        terminateChild: terminateFakeChild
      })
    }
  );
  // The child must provably exist before the execution budget expires;
  // otherwise the timeout is a never-started release, not this test's premise.
  await writerStartedPromise;
  await afterRunnerStarts();
  const outcome = await settleManualClockDelegation(clock, pending);
  const rootKey = workspaceForTest(projectRoot).canonicalRepositoryKey;
  assert.equal(outcome.custodyState, "orphaned");
  assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");
  const publicOutcome = projectDelegateAgentOutcome(outcome);
  assert.equal(publicOutcome.custody.orphaned, true);
  assert.equal(publicOutcome.custody.durableState, "orphaned");
  assert.equal(publicOutcome.custody.termination.processIdentity, "recorded");
  assert.equal(publicOutcome.custody.termination.terminalProof, "unavailable");
  assert.equal(publicOutcome.custody.recovery.automatic, true);
  assert.equal(
    publicOutcome.custody.recovery.mode,
    "same-coordinator-terminal-proof"
  );

  child.emit("close", null, "SIGTERM");
  await afterRunnerStarts();
  await afterRunnerStarts();
  assert.equal(custody.getWriteAccess(rootKey), undefined);
  // The returned outcome is a synchronous snapshot. Late exact-close recovery
  // advances durable custody rather than mutating an already returned result.
  assert.equal(outcome.custodyState, "orphaned");
});

test("a failed late ORPHANED recovery stays fail-closed and reports its persistence error", async () => {
  const clock = manualClock();
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ closeOnKill: false });
  const runtime = writerRuntime(10);
  const diagnostics = [];
  const rootKey = workspaceForTest(projectRoot).canonicalRepositoryKey;
  const recoveryFailure = new Error("late custody persistence failed");
  custody.releaseOrphanedWriteAccessAfterTerminal = () => {
    throw recoveryFailure;
  };
  let unhandledRejection;
  const recordUnhandledRejection = (reason) => {
    unhandledRejection = reason;
  };
  process.on("unhandledRejection", recordUnhandledRejection);
  try {
    let writerStarted;
    const writerStartedPromise = new Promise((resolve) => {
      writerStarted = resolve;
    });
    const pending = delegateAgent(
      { agentType: "task", task: "late recovery persistence failure", cwd: projectRoot },
      {
        writeCustody: custody,
        now: clock.now,
        scheduleRequestDeadline: clock.schedule,
        cancelRequestDeadline: clock.cancelSchedule,
        createExecutionId: () => "late-close-recovery-failure",
        resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
        resolveRuntime: () => runtime,
        runAgent: (argumentsForRunner) => runClaudeAgent({
          ...argumentsForRunner,
          runtime,
          now: clock.now,
          schedule: clock.schedule,
          cancelSchedule: clock.cancelSchedule,
          async onChildStarted(processIdentity) {
            // Production awaits this; the wrapper must not drop the promise.
            await argumentsForRunner.onChildStarted(processIdentity);
            writerStarted();
          },
          createSettings: fakeSettings(),
          spawnProcess: () => child,
          terminationTimeoutMs: 10,
          terminateChild: terminateFakeChild,
          async onLateRecoveryFailure(error, context) {
            diagnostics.push({ error, context });
            throw new Error("diagnostic sink unavailable");
          }
        })
      }
    );
    // The child must provably exist before the execution budget expires;
    // otherwise the timeout is a never-started release, not this test's premise.
    await writerStartedPromise;
    await afterRunnerStarts();
    const outcome = await settleManualClockDelegation(clock, pending);
    assert.equal(outcome.custodyState, "orphaned");
    assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");

    child.emit("close", null, "SIGTERM");
    await afterRunnerStarts();
    await afterRunnerStarts();
    assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");
    assert.equal(outcome.custodyState, "orphaned", "late recovery never mutates returned outcomes");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].error, recoveryFailure);
    assert.equal(diagnostics[0].context.terminalProof.event, "close");
    assert.equal(unhandledRejection, undefined);
  } finally {
    process.removeListener("unhandledRejection", recordUnhandledRejection);
  }
});

test("a late exact close after the request stopped starts no recovery mutation", async () => {
  const clock = manualClock();
  const controller = new AbortController();
  const custody = new WriteCustodyManager();
  const child = createFakeChild({ closeOnKill: false });
  const runtime = writerRuntime(10);
  const diagnostics = [];
  const rootKey = workspaceForTest(projectRoot).canonicalRepositoryKey;
  let recoveryAttempts = 0;
  const release = custody.releaseOrphanedWriteAccessAfterTerminal.bind(custody);
  custody.releaseOrphanedWriteAccessAfterTerminal = (...args) => {
    recoveryAttempts += 1;
    return release(...args);
  };
  let writerStarted;
  const writerStartedPromise = new Promise((resolve) => {
    writerStarted = resolve;
  });
  const pending = delegateAgent(
    { agentType: "task", task: "late close after stop", cwd: projectRoot, abortSignal: controller.signal },
    {
      writeCustody: custody,
      now: clock.now,
      scheduleRequestDeadline: clock.schedule,
      cancelRequestDeadline: clock.cancelSchedule,
      createExecutionId: () => "late-close-after-stop",
      resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
      resolveRuntime: () => runtime,
      runAgent: (argumentsForRunner) => runClaudeAgent({
        ...argumentsForRunner,
        runtime,
        now: clock.now,
        schedule: clock.schedule,
        cancelSchedule: clock.cancelSchedule,
        async onChildStarted(processIdentity) {
          // Production awaits this; the wrapper must not drop the promise.
          await argumentsForRunner.onChildStarted(processIdentity);
          writerStarted();
        },
        createSettings: fakeSettings(),
        spawnProcess: () => child,
        terminationTimeoutMs: 10,
        terminateChild: terminateFakeChild,
        async onLateRecoveryFailure(error, context) {
          diagnostics.push({ error, context });
        }
      })
    }
  );
  await writerStartedPromise;
  await afterRunnerStarts();
  // The request stops while the runner is still supervised: termination goes
  // unproven, late recovery arms, but the stopped request retains instead of
  // orphaning, so the later close must not authorize a new mutation.
  controller.abort();
  const outcome = await settleManualClockDelegation(clock, pending);
  assert.equal(outcome.custodyState, "retained");
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");

  child.emit("close", null, "SIGTERM");
  await afterRunnerStarts();
  await afterRunnerStarts();
  assert.equal(recoveryAttempts, 0);
  assert.equal(diagnostics.length, 0);
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");
  assert.equal(outcome.custodyState, "retained", "late recovery never mutates returned outcomes");
});
