import assert from "node:assert/strict";
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
    if (!["ACTIVE", "TERMINATING"].includes(record.state)) {
      throw new WriteCustodyError("Invalid state.", { code: "write_custody_state_invalid" });
    }
    if (!terminalProof || terminalProof.processIdentity !== record.processIdentity) {
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
    async prepare({ executionId, canonicalRootKey, canonicalRoot, effectiveCwd }) {
      const worktreeRoot = writeCustody.worktreeRootFor({ executionId, canonicalRootKey });
      writeCustody.beginWorktreePreparation({
        executionId,
        canonicalRootKey,
        baseCommit: "a".repeat(40),
        worktreeRoot
      });
      writeCustody.markSpawning({ executionId, canonicalRootKey });
      return {
        effectiveCwd,
        canonicalRoot,
        canonicalRootKey,
        rootSource: "test-isolated-worktree",
        worktreeRoot,
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

function completedWriterExecution(argumentsForRunner, result = "specialist response", durationMs = 7) {
  const child = createFakeChild();
  const processIdentity = Object.freeze({
    executionId: argumentsForRunner.executionId,
    agentType: argumentsForRunner.agentType,
    canonicalRoot: argumentsForRunner.canonicalRoot,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "test-process-start",
    child,
    startedAt: 1
  });
  argumentsForRunner.onChildStarted(processIdentity);
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
    canonicalRoot: cwd,
    canonicalRootKey: cwd.toLowerCase(),
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
    assert.ok(
      runnerArguments.prompt.includes(
        "Canonical root: " + (agentType === "general-purpose" ? outcome.worktreeRoot : projectRoot)
      )
    );
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
    /no greater than 2147483647 milliseconds/
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
        const execution = completedWriterExecution(
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
  assert.equal(custody.getWriteAccess(workspaceForTest(firstRoot).canonicalRootKey), undefined);

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
        const execution = completedWriterExecution(argumentsForRunner, "unused", 10);
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
  assert.equal(custody.getWriteAccess(workspaceForTest(firstRoot).canonicalRootKey), undefined);
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
        onChildStarted(processIdentity) {
          argumentsForRunner.onChildStarted(processIdentity);
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
  const rootKey = workspaceForTest(root).canonicalRootKey;
  assert.equal(custody.getWriteAccess(rootKey).state, "ACTIVE");
  child.stdout.end("normal result");
  child.emit("close", 0, null);

  const outcome = await pending;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.custodyState, "released");
  assert.equal(custody.getWriteAccess(rootKey), undefined);
});

test("write custody remains TERMINATING through taskkill completion until exact child close proves terminal", async () => {
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
  const ids = [
    "writer-a",
    "writer-b",
    "reader-a",
    "writer-other",
    "writer-still-blocked",
    "writer-after"
  ];
  let nextId = 0;
  const runtime = writerRuntime(10);
  const writerDependencies = {
    writeCustody: custody,
    createExecutionId: () => ids[nextId++],
    resolveWorkspaceRoot: async (cwd) => workspaceForTest(cwd),
    resolveRuntime: () => runtime,
    runAgent: (argumentsForRunner) => runClaudeAgent({
      ...argumentsForRunner,
      runtime,
      createSettings: fakeSettings(),
      spawnProcess: () => child,
      terminationTimeoutMs: 50,
      terminateChild: (target, options) => terminateClaudeChild(target, {
        ...options,
        platform: "win32",
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
  await taskkillStartedPromise;
  const rootKey = workspaceForTest(root).canonicalRootKey;
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
    const rootKey = workspaceForTest(root).canonicalRootKey;
    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.error.code, "claude_termination_unproven");
    assert.equal(outcome.custodyState, "orphaned");
    assert.equal(custody.getWriteAccess(rootKey).state, "ORPHANED");
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
    assert.equal(custody.getWriteAccess(workspaceForTest(root).canonicalRootKey), undefined);
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
  const success = await registration.handler({ agent_type: "explore", task: "inspect", cwd: projectRoot });
  assert.equal(success.isError, undefined);
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
    canonicalRoot: projectRoot,
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
    canonicalRoot: projectRoot,
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

  const exitedChild = createFakeChild();
  exitedChild.pid = 6789;
  exitedChild.exitCode = 0;
  const exitedResult = await terminateClaudeChild(exitedChild, {
    platform: "win32",
    terminationTimeoutMs: 100
  });
  assert.equal(exitedResult.status, "already-terminal");
  assert.equal(exitedChild.killCalls, 0);

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
  assert.equal(reusedPidChild.killCalls, 0);
  reusedPidChild.emit("close", 0, null);
  const reusedPidResult = await reusedPidPending;
  assert.equal(reusedPidResult.status, "already-terminal");
  assert.equal(reusedPidResult.method, "identity-check");
  assert.equal(reusedPidResult.identityStatus, "pid-reused");
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
