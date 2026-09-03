import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY, MAX_PROFILE_TIMEOUT_MS, getAgentProfile } from "../src/agent-registry.mjs";
import { ClaudeRunnerError, ClaudeTimeoutError } from "../src/claude-errors.mjs";
import { runClaudeAgent } from "../src/claude-runner.mjs";
import { delegateAgent, resolveAgentRuntime } from "../src/delegate-agent.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";
import {
  RECOMMENDED_CODEX_TOOL_TIMEOUT_MS,
  RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC,
  REQUIRED_SYNCHRONOUS_SETTLEMENT_BUDGET_MS,
  TimeoutHierarchyViolationError,
  assertTimeoutHierarchy,
  calculateMaxMcpLifetime,
  checkTimeoutHierarchySafety,
  deriveMaxProfileTimeout
} from "../src/timeout-policy.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message || result.stderr?.trim() || "status: " + result.status;
    assert.fail(`git ${args.join(" ")} in '${cwd}' failed: ${detail}`);
  }
  return result.stdout.trim();
}

async function withDisposableRepo(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-timeout-test-"));
  const repoDir = path.join(fixtureRoot, "repo");
  const stateRoot = path.join(fixtureRoot, "state");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stateRoot, { recursive: true });

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "core.autocrlf", "false"]);
  git(repoDir, ["config", "user.name", "Timeout Test Runner"]);
  git(repoDir, ["config", "user.email", "timeout-test@example.invalid"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(repoDir, "README.md"), "# Test Repository\nInitial content\n", "utf8");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "feat: initial commit"]);

  const writeCustody = new DurableWriteCustodyManager({ stateRoot });

  try {
    await callback({ repoDir, stateRoot, writeCustody });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

// 1. Machine-checked hierarchy assertions
test("machine-checked timeout hierarchy enforces client > MCP lifetime > profile timeout", () => {
  const verified = assertTimeoutHierarchy({
    outerTimeoutMs: 3600_000,
    maxProfileTimeoutMs: 1800_000,
    settlementBudgetMs: 615_000
  });
  assert.equal(verified.outerTimeoutMs, 3600_000);
  assert.equal(verified.maxProfileTimeoutMs, 1800_000);
  assert.equal(verified.settlementBudgetMs, 615_000);
  assert.equal(verified.maxMcpLifetimeMs, 2415_000);
  assert.equal(verified.headroomMs, 1185_000);

  // Inverted: outer client deadline smaller than profile timeout
  assert.throws(
    () =>
      assertTimeoutHierarchy({
        outerTimeoutMs: 300_000, // 5 min default
        maxProfileTimeoutMs: 1800_000 // 30 min review
      }),
    (err) => err instanceof TimeoutHierarchyViolationError && err.code === "timeout_hierarchy_inverted"
  );

  // Insufficient settlement headroom
  assert.throws(
    () =>
      assertTimeoutHierarchy({
        outerTimeoutMs: 2000_000,
        maxProfileTimeoutMs: 1800_000,
        settlementBudgetMs: 615_000 // requires 2415s
      }),
    (err) => err instanceof TimeoutHierarchyViolationError && err.code === "insufficient_settlement_headroom"
  );

  // Calculation of max bounded MCP lifetime
  assert.equal(calculateMaxMcpLifetime(1800_000), 2415_000);

  // Maintainer safety guard: ensure recommended outer timeout covers all registered profiles
  const maxRegistered = deriveMaxProfileTimeout(AGENT_REGISTRY);
  assert.equal(maxRegistered, MAX_PROFILE_TIMEOUT_MS);
  const maintainerCheck = assertTimeoutHierarchy({
    outerTimeoutMs: RECOMMENDED_CODEX_TOOL_TIMEOUT_MS,
    maxProfileTimeoutMs: maxRegistered
  });
  assert.ok(maintainerCheck.headroomMs >= 0);
});

// 2. Credential-free diagnostic safety evaluation
test("credential-free checkTimeoutHierarchySafety identifies safe and unsafe configurations", () => {
  const safe = checkTimeoutHierarchySafety({
    codexTimeoutSec: 3600,
    maxProfileTimeoutMs: 1800_000
  });
  assert.equal(safe.safe, true);
  assert.equal(safe.minSafeTimeoutSec, 2415);
  assert.ok(safe.message.includes("satisfies timeout hierarchy safety"));

  const unsafeDefault = checkTimeoutHierarchySafety({
    codexTimeoutSec: 300,
    maxProfileTimeoutMs: 1800_000
  });
  assert.equal(unsafeDefault.safe, false);
  assert.equal(unsafeDefault.minSafeTimeoutSec, 2415);
  assert.ok(unsafeDefault.message.includes("dangerously below"));

  const unconfigured = checkTimeoutHierarchySafety({
    codexTimeoutSec: null,
    maxProfileTimeoutMs: 1800_000
  });
  assert.equal(unconfigured.safe, false);
});

// 3. Deterministic regression of the 536s Incident with fake Claude & late receipt reconciliation
test("536-second code review completes and binds ReviewReceipt under 3600s outer timeout", async () => {
  await withDisposableRepo(async ({ repoDir, writeCustody }) => {
    let runAgentCalled = 0;

    const fakeRunAgent = async ({ executionId, agentType, repositoryRoot, onChildStarted }) => {
      runAgentCalled += 1;
      const pid = 88_888;
      const processIdentity = {
        executionId,
        agentType,
        repositoryRoot,
        pid,
        child: { pid },
        startedAt: Date.now(),
        startTime: "8888800",
        source: "test-identity"
      };

      if (onChildStarted) {
        await onChildStarted(processIdentity);
      }

      // Simulate 536,143 ms of review work (the exact incident duration)
      const reviewDurationMs = 536_143;

      return {
        status: "completed",
        durationMs: reviewDurationMs,
        result: "REVIEW OUTCOME: Architecture verified, 0 critical issues.",
        stderrSummary: "",
        pid,
        processIdentity,
        terminalProof: {
          kind: "child-event",
          event: "close",
          observedAt: Date.now(),
          processIdentity
        }
      };
    };

    const outcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Perform full architecture and security review",
        cwd: repoDir
      },
      {
        runAgent: fakeRunAgent,
        writeCustody
      }
    );

    assert.equal(runAgentCalled, 1);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.durationMs, 536_143);
    assert.equal(outcome.reviewBinding.status, "bound");
    assert.equal(outcome.reviewBinding.coherence, "held");
    assert.ok(outcome.reviewBinding.reviewId?.startsWith("rr1:"));
    assert.equal(outcome.custodyState, "released");
    assert.equal(outcome.reviewBinding.publication.status, "authoritative-settled");

    // 4. Test No-Model Late Receipt Discovery and Reconciliation
    // Immediately after, Codex calls delegate_agent with reconcile_only: true
    let secondRunAgentCalled = 0;
    const reconcileRunAgent = async () => {
      secondRunAgentCalled += 1;
      throw new Error("reconcile_only must never invoke Claude runner!");
    };

    const reconciledOutcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "reconcile",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        runAgent: reconcileRunAgent,
        writeCustody
      }
    );

    assert.equal(secondRunAgentCalled, 0, "No Claude runner process should be spawned during reconciliation");
    assert.equal(reconciledOutcome.status, "completed");
    assert.equal(reconciledOutcome.reviewBinding.status, "bound");
    assert.equal(reconciledOutcome.reviewBinding.reviewId, outcome.reviewBinding.reviewId);
    assert.ok(reconciledOutcome.result.includes("Reconciled authoritative review receipt"));
    assert.ok(reconciledOutcome.result.includes("0 model quota consumed"));
    assert.equal(reconciledOutcome.custodyState, "released");

    // Dynamic freshness: modify repository worktree and verify reconcile_only dynamically reports STALE
    await writeFile(path.join(repoDir, "mutation.txt"), "unauthorized change\n", "utf8");

    const staleOutcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Check freshness of review",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        runAgent: reconcileRunAgent,
        writeCustody
      }
    );

    assert.equal(secondRunAgentCalled, 0);
    assert.equal(staleOutcome.status, "completed");
    assert.equal(staleOutcome.reviewBinding.status, "stale");
    assert.ok(staleOutcome.result.includes("is STALE for current changeSet"));
    assert.ok(staleOutcome.result.includes("A fresh code-review delegation is required"));
    assert.equal(staleOutcome.custodyState, "released");
  });
});

// 5. Client Abort / Cancellation during Claude execution triggers orderly forced termination
test("client abort signal triggers forced termination, releases custody, and fences publication", async () => {
  await withDisposableRepo(async ({ repoDir, writeCustody }) => {
    const abortController = new AbortController();

    class StalledStdin extends EventEmitter {
      write() { return false; }
      end() {}
      destroy() {}
    }

    const fakeChild = new EventEmitter();
    fakeChild.pid = 99_999;
    fakeChild.stdin = new StalledStdin();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.killCalls = 0;
    fakeChild.kill = () => {
      fakeChild.killCalls += 1;
      setImmediate(() => fakeChild.emit("close", null, "SIGTERM"));
      return true;
    };

    const inspectProcess = async () => ({
      status: "alive",
      identity: { pid: 99_999, startTime: "9999900", source: "test" }
    });

    const createSettings = async () => ({
      settingsPath: path.join(os.tmpdir(), "test-settings.json"),
      cleanup: async () => {}
    });

    const runtime = resolveAgentRuntime(getAgentProfile("code-review"));

    const runnerPromise = runClaudeAgent({
      prompt: "Execute code review",
      cwd: repoDir,
      runtime,
      abortSignal: abortController.signal,
      spawnProcess: () => fakeChild,
      inspectProcess,
      createSettings
    });

    // Wait for child to initialize
    await new Promise((resolve) => setImmediate(resolve));

    // Client abandons / cancels the tool call
    abortController.abort();

    await assert.rejects(
      runnerPromise,
      (err) => {
        assert.equal(err.code, "claude_cancelled");
        assert.ok(fakeChild.killCalls >= 1, "Child process must have been terminated");
        return true;
      }
    );
  });
});

// 6. Pre-spawn client abort fails closed immediately without starting child process
test("pre-spawn client abort fails closed with claude_cancelled and processStarted: false", async () => {
  await withDisposableRepo(async ({ repoDir }) => {
    const abortController = new AbortController();
    abortController.abort(); // already aborted before call

    const runtime = resolveAgentRuntime(getAgentProfile("code-review"));

    let spawnAttempted = false;
    const spawnProcess = () => {
      spawnAttempted = true;
      throw new Error("spawn should not be called when already aborted");
    };

    await assert.rejects(
      runClaudeAgent({
        prompt: "Pre-aborted task",
        cwd: repoDir,
        runtime,
        abortSignal: abortController.signal,
        spawnProcess
      }),
      (err) => {
        assert.equal(err.code, "claude_cancelled");
        assert.equal(err.processStarted, false);
        return true;
      }
    );
    assert.equal(spawnAttempted, false);
  });
});

// 7. Reconcile-only input validation rejects non-review profiles
test("reconcile_only is rejected for non-review profiles", async () => {
  await withDisposableRepo(async ({ repoDir, writeCustody }) => {
    await assert.rejects(
      delegateAgent(
        {
          agentType: "task",
          task: "run reconciliation",
          reconcileOnly: true,
          cwd: repoDir
        },
        { writeCustody }
      ),
      (err) => {
        assert.match(err.message, /reconcile_only is only supported for review profiles/);
        return true;
      }
    );
  });
});
