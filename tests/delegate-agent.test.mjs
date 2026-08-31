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
  delegateAgent,
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
  runClaudeAgent,
  terminateClaudeChild
} from "../src/claude-runner.mjs";
import { WriteCustodyManager } from "../src/write-custody.mjs";

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

function createFakeChild({ stdin, stdout, stderr } = {}) {
  const child = new EventEmitter();
  child.stdin = stdin || new PassThrough();
  child.stdout = stdout || new PassThrough();
  child.stderr = stderr || new PassThrough();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function completedRunner(result = "specialist response") {
  return async () => ({
    result,
    stderrSummary: "",
    durationMs: 7
  });
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
          return { result: "completed " + agentType, stderrSummary: "", durationMs: 11 };
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
    assert.ok(runnerArguments.prompt.includes("Canonical root: " + projectRoot));
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
  assert.match(calls[0].prompt, /Nested claude-agents MCP delegation is unavailable in Phase 4/);
  assert.equal(calls[0].runtime.disallowedTools.includes("mcp__*"), true);
  assert.equal(calls[0].runtime.toolNames.includes("Task"), false);
});

test("write admission is process-local, releases on all terminal outcomes, and leaves reads concurrent", async () => {
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
      runAgent: async () => {
        firstRunnerStarted();
        await firstStarted;
        return { result: "first complete", stderrSummary: "", durationMs: 10 };
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
      runAgent: async () => {
        throw new ClaudeTimeoutError(10, { durationMs: 10 });
      }
    }
  );
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.custodyState, "released");
  assert.equal(custody.getWriteAccess(workspaceForTest(firstRoot).canonicalRootKey), undefined);
  assert.notEqual(firstOutcome.executionId, second.executionId);
  assert.notEqual(second.executionId, readWhileWriting.executionId);
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
      spawnProcess: () => timedOutChild
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

test("Windows forced termination targets only the exact Claude child PID", () => {
  const child = createFakeChild();
  child.pid = 4321;
  const terminator = new EventEmitter();
  terminator.killCalls = 0;
  terminator.kill = () => {
    terminator.killCalls += 1;
  };
  let invocation;
  let scheduled;
  const method = terminateClaudeChild(child, {
    platform: "win32",
    spawnTerminator(command, args, options) {
      invocation = { command, args, options };
      return terminator;
    },
    schedule(callback, delay) {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
    cancelSchedule() {}
  });
  assert.equal(method, "taskkill");
  assert.deepEqual(invocation, {
    command: "taskkill",
    args: ["/PID", "4321", "/T", "/F"],
    options: { shell: false, windowsHide: true, stdio: "ignore" }
  });
  assert.equal(child.killCalls, 0);
  scheduled.callback();
  assert.equal(terminator.killCalls, 1);

  const noPidChild = createFakeChild();
  assert.equal(terminateClaudeChild(noPidChild, { platform: "win32" }), "child-kill");
  assert.equal(noPidChild.killCalls, 1);

  const exitedChild = createFakeChild();
  exitedChild.pid = 6789;
  exitedChild.exitCode = 0;
  assert.equal(terminateClaudeChild(exitedChild, { platform: "win32" }), "already-exited");
  assert.equal(exitedChild.killCalls, 0);
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
    spawnProcess: () => child
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
    spawnProcess: () => overflowChild
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
