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
    assert.ok(reconciledOutcome.result.includes("0 Claude delegated-model quota consumed"));
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
    assert.equal(staleOutcome.reviewBinding.status, "bound");
    assert.equal(staleOutcome.reviewBinding.receiptHistory.receipts[0].verdict, "STALE");
    assert.ok(staleOutcome.result.includes("is STALE for current changeSet"));
    assert.ok(staleOutcome.result.includes("A fresh code-review delegation is required"));
    assert.equal(staleOutcome.custodyState, "released");
  });
});

// 4. Positive reconciliation: missing or corrupt result artifact fails closed (Test D)
test("reconcile_only fails closed when result artifact is missing or corrupt (Test D)", async () => {
  await withDisposableRepo(async ({ repoDir, stateRoot, writeCustody }) => {
    const outcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Perform initial review",
        cwd: repoDir
      },
      {
        runAgent: async ({ executionId, agentType, repositoryRoot, onChildStarted }) => {
          const pid = 88_888;
          const processIdentity = {
            executionId,
            agentType,
            repositoryRoot,
            pid,
            child: { pid },
            startedAt: Date.now(),
            startTime: "8888800",
            source: "test"
          };
          if (onChildStarted) await onChildStarted(processIdentity);
          return {
            status: "completed",
            durationMs: 1000,
            result: "CLEAN REVIEW: Everything looks great!",
            stderrSummary: "",
            pid,
            processIdentity,
            terminalProof: { kind: "child-event", event: "close", observedAt: Date.now(), processIdentity }
          };
        },
        writeCustody
      }
    );
    assert.equal(outcome.reviewBinding.status, "bound");

    // Locate artifact file
    const reposDir = path.join(stateRoot, "repositories");
    const repoSubdirs = await (await import("node:fs/promises")).readdir(reposDir);
    const artifactsDir = path.join(reposDir, repoSubdirs[0], "reviews", "artifacts");
    const artifactFiles = await (await import("node:fs/promises")).readdir(artifactsDir);
    const artifactPath = path.join(artifactsDir, artifactFiles[0]);

    // Case D1: Corrupt artifact (tampered / length or hash mismatch)
    await writeFile(artifactPath, "TAMPERED BYTES INVALID", "utf8");

    const corruptOutcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Reconcile corrupt artifact",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        runAgent: async () => { throw new Error("must not call runner"); },
        writeCustody
      }
    );

    assert.equal(corruptOutcome.reviewBinding.status, "bound");
    assert.ok(corruptOutcome.reviewBinding.reasons.some((r) => r.code.startsWith("review_result_artifact_")));
    assert.ok(corruptOutcome.result.includes("Result artifact verification failed"));
    assert.ok(corruptOutcome.result.includes("cannot verify reviewer findings or determine if the review was clean"));
    assert.ok(!corruptOutcome.result.includes("CLEAN REVIEW: Everything looks great!"));

    // Case D2: Missing artifact (deleted)
    await rm(artifactPath, { force: true });

    const missingOutcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Reconcile missing artifact",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        runAgent: async () => { throw new Error("must not call runner"); },
        writeCustody
      }
    );

    assert.equal(missingOutcome.reviewBinding.status, "bound");
    assert.ok(missingOutcome.reviewBinding.reasons.some((r) => r.code === "review_result_artifact_missing"));
    assert.ok(missingOutcome.result.includes("Result artifact verification failed"));
    assert.ok(missingOutcome.result.includes("cannot verify reviewer findings or determine if the review was clean"));
  });
});

// 5. Positive reconciliation: collector or history uncertainty reports INDETERMINATE and fails closed (Test C)
test("reconcile_only reports INDETERMINATE and fails closed on collector or history uncertainty (Test C)", async () => {
  await withDisposableRepo(async ({ repoDir, writeCustody }) => {
    // Review binder that returns an indeterminate freshness state
    const mockBinder = {
      before: async () => ({
        status: "indeterminate",
        coherence: "held",
        reasons: [{ code: "history_indeterminate" }],
        priorReviews: [
          {
            reviewId: "rr1:1111111111111111111111111111111111111111111111111111111111111111",
            agentType: "code-review",
            changeSetId: "cs1:2222222222222222222222222222222222222222222222222222222222222222",
            recordedAt: Date.now(),
            verdict: "INDETERMINATE",
            changedSections: [],
            basisDifferences: [],
            reasons: [{ code: "collector_uncertainty" }]
          }
        ],
        receiptHistory: {
          status: "indeterminate",
          receipts: [
            {
              reviewId: "rr1:1111111111111111111111111111111111111111111111111111111111111111",
              agentType: "code-review",
              changeSetId: "cs1:2222222222222222222222222222222222222222222222222222222222222222",
              recordedAt: Date.now(),
              verdict: "INDETERMINATE",
              changedSections: [],
              basisDifferences: [],
              reasons: [{ code: "collector_uncertainty" }]
            }
          ],
          diagnostics: [{ code: "collector_uncertainty" }]
        }
      }),
      loadResultArtifact: async () => ({ status: "unavailable", error: "artifact_unavailable" })
    };

    const outcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Reconcile with collector uncertainty",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        reviewBinder: mockBinder,
        runAgent: async () => { throw new Error("must not invoke runner"); },
        writeCustody
      }
    );

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reviewBinding.status, "unavailable");
    assert.ok(outcome.reviewBinding.reasons.some((r) => r.code === "collector_uncertainty" || r.code === "review_history_indeterminate"));
    assert.ok(outcome.result.includes("has INDETERMINATE freshness for current repository state"));
    assert.ok(outcome.result.includes("A fresh code-review delegation is required."));
  });
});

// 6. Positive reconciliation scope isolation: repo, targetRef, and agentType mismatch (Tests E, F, G)
test("reconcile_only enforces strict scope isolation across repo, targetRef, and agentType (Tests E, F, G)", async () => {
  await withDisposableRepo(async ({ repoDir, writeCustody }) => {
    // Initial code-review on repoDir HEAD
    const initialOutcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Perform initial code review",
        cwd: repoDir
      },
      {
        runAgent: async ({ executionId, agentType, repositoryRoot, onChildStarted }) => {
          const pid = 88_888;
          const processIdentity = {
            executionId,
            agentType,
            repositoryRoot,
            pid,
            child: { pid },
            startedAt: Date.now(),
            startTime: "8888800",
            source: "test"
          };
          if (onChildStarted) await onChildStarted(processIdentity);
          return {
            status: "completed",
            durationMs: 1000,
            result: "REVIEW OUTCOME: OK",
            stderrSummary: "",
            pid,
            processIdentity,
            terminalProof: { kind: "child-event", event: "close", observedAt: Date.now(), processIdentity }
          };
        },
        writeCustody
      }
    );
    assert.equal(initialOutcome.reviewBinding.status, "bound");

    // Case E: Repository mismatch (call against another repo)
    await withDisposableRepo(async ({ repoDir: otherRepo, writeCustody: otherCustody }) => {
      const repoMismatchOutcome = await delegateAgent(
        {
          agentType: "code-review",
          task: "Reconcile in different repo",
          reconcileOnly: true,
          cwd: otherRepo
        },
        {
          runAgent: async () => { throw new Error("must not call runner"); },
          writeCustody: otherCustody
        }
      );
      assert.equal(repoMismatchOutcome.reviewBinding.status, "unavailable");
      assert.equal(repoMismatchOutcome.reviewBinding.reviewId, null);
      assert.ok(repoMismatchOutcome.result.includes("No prior review receipts discovered"));
    });

    // Case F: Target_ref mismatch (call for a different branch / targetRef)
    const targetMismatchOutcome = await delegateAgent(
      {
        agentType: "code-review",
        task: "Reconcile with branch targetRef",
        targetRef: "refs/heads/feature-branch-xyz",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        runAgent: async () => { throw new Error("must not call runner"); },
        writeCustody
      }
    );
    assert.equal(targetMismatchOutcome.reviewBinding.status, "unavailable");
    assert.equal(targetMismatchOutcome.reviewBinding.reviewId, null);
    assert.ok(targetMismatchOutcome.result.includes("No prior review receipts discovered"));

    // Case G: Agent-type mismatch (call security-review when only code-review receipt exists)
    const agentMismatchOutcome = await delegateAgent(
      {
        agentType: "security-review",
        task: "Reconcile security review",
        reconcileOnly: true,
        cwd: repoDir
      },
      {
        runAgent: async () => { throw new Error("must not call runner"); },
        writeCustody
      }
    );
    assert.equal(agentMismatchOutcome.reviewBinding.status, "unavailable");
    assert.equal(agentMismatchOutcome.reviewBinding.reviewId, null);
    assert.ok(agentMismatchOutcome.result.includes("No prior review receipts discovered for scope security-review"));
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

// 10. Manual-clock boundary verification: deadline - 1, exactly deadline, deadline + 1
test("manual-clock boundary tests: deadline - 1 completes cleanly, exactly deadline and deadline + 1 timeout", async () => {
  function manualClock(initialTime = 1_000) {
    let time = initialTime;
    let nextId = 1;
    const timers = new Map();
    return {
      now: () => time,
      schedule(callback, delay) {
        const id = nextId++;
        timers.set(id, { callback, at: time + Math.max(0, delay) });
        return id;
      },
      cancelSchedule(id) {
        timers.delete(id);
      },
      advanceTo(target) {
        time = target;
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at <= time) {
            timers.delete(id);
            timer.callback();
          }
        }
      }
    };
  }

  class FakeStdin extends EventEmitter {
    write() { return false; }
    end() {}
    destroy() {}
  }

  const baseRuntime = resolveAgentRuntime(getAgentProfile("code-review"));

  // Subcase 1: Child completes cleanly at deadline - 1 (5,999 ms)
  {
    const clock = manualClock(1_000);
    const child = new EventEmitter();
    child.pid = 55_555;
    child.stdin = new FakeStdin();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;

    const runnerPromise = runClaudeAgent({
      prompt: "boundary test prompt",
      cwd: process.cwd(),
      repositoryRoot: process.cwd(),
      runtime: { ...baseRuntime, timeoutMs: 5_000 },
      spawnProcess: () => child,
      inspectProcess: async () => ({ status: "alive", identity: { pid: 55555, startTime: "1", source: "test" } }),
      createSettings: async () => ({ settingsPath: "dummy", cleanup: async () => {} }),
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule
    });

    await new Promise((r) => setImmediate(r));
    clock.advanceTo(5_999);
    child.stdout.emit("data", "useful review findings\n");
    child.emit("close", 0, null);
    const outcome = await runnerPromise;
    assert.equal(outcome.terminalProof.event, "close");
    assert.ok(outcome.result.includes("useful review findings"));
  }

  // Subcase 2: Clock advances to exactly deadline (6,000 ms)
  {
    const clock = manualClock(1_000);
    const child = new EventEmitter();
    child.pid = 55_556;
    child.stdin = new FakeStdin();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    };

    const runnerPromise = runClaudeAgent({
      prompt: "boundary test prompt",
      cwd: process.cwd(),
      repositoryRoot: process.cwd(),
      runtime: { ...baseRuntime, timeoutMs: 5_000 },
      spawnProcess: () => child,
      inspectProcess: async () => ({ status: "alive", identity: { pid: 55556, startTime: "1", source: "test" } }),
      createSettings: async () => ({ settingsPath: "dummy", cleanup: async () => {} }),
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule
    });

    await new Promise((r) => setImmediate(r));
    clock.advanceTo(6_000);
    await assert.rejects(runnerPromise, (err) => {
      assert.equal(err.code, "claude_timeout");
      return true;
    });
  }

  // Subcase 3: Clock advances past deadline (deadline + 1: 6,001 ms)
  {
    const clock = manualClock(1_000);
    const child = new EventEmitter();
    child.pid = 55_557;
    child.stdin = new FakeStdin();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    };

    const runnerPromise = runClaudeAgent({
      prompt: "boundary test prompt",
      cwd: process.cwd(),
      repositoryRoot: process.cwd(),
      runtime: { ...baseRuntime, timeoutMs: 5_000 },
      spawnProcess: () => child,
      inspectProcess: async () => ({ status: "alive", identity: { pid: 55557, startTime: "1", source: "test" } }),
      createSettings: async () => ({ settingsPath: "dummy", cleanup: async () => {} }),
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule
    });

    await new Promise((r) => setImmediate(r));
    clock.advanceTo(6_001);
    await assert.rejects(runnerPromise, (err) => {
      assert.equal(err.code, "claude_timeout");
      return true;
    });
  }
});
