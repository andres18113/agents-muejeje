import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentProfile } from "../src/agent-registry.mjs";
import { evaluateDiagnoseTimeout } from "../src/diagnose-timeout.mjs";
import {
  DelegateAgentConfigurationError,
  DelegateAgentInputError,
  delegateAgent,
  resolveAgentRuntime
} from "../src/delegate-agent.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";
import {
  checkTimeoutHierarchySafety,
  MAX_SUPPORTED_DELEGATE_TIMEOUT_MS
} from "../src/timeout-policy.mjs";
import { createRequestDeadlineContext } from "../src/request-context.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function withRepository(callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-reconcile-contract-"));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const stateRoot = path.join(fixtureRoot, "state");
  try {
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "user.name", "Reconciliation Test"]);
    git(repositoryRoot, ["config", "user.email", "reconciliation@example.invalid"]);
    git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# reconciliation fixture\n", "utf8");
    git(repositoryRoot, ["add", "README.md"]);
    git(repositoryRoot, ["commit", "-m", "fixture"]);
    await callback({ repositoryRoot, writeCustody: new DurableWriteCustodyManager({ stateRoot }) });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

let nextPid = 71_000;

function completedReviewRunner(result) {
  return async ({ executionId, agentType, repositoryRoot, onChildStarted }) => {
    const pid = nextPid++;
    const processIdentity = {
      executionId,
      agentType,
      repositoryRoot,
      pid,
      child: { pid },
      startedAt: Date.now(),
      startTime: String(pid * 100),
      source: "reconciliation-contract"
    };
    await onChildStarted?.(processIdentity);
    return {
      result,
      durationMs: 1,
      processStarted: true,
      processIdentity,
      terminalProof: {
        processIdentity,
        event: "close",
        observedAt: Date.now()
      }
    };
  };
}

test("reconcile_only never silently selects among multiple FRESH receipts and review_id selects exactly one", async () => {
  await withRepository(async ({ repositoryRoot, writeCustody }) => {
    const first = await delegateAgent(
      { agentType: "code-review", task: "review purpose alpha", cwd: repositoryRoot },
      { writeCustody, runAgent: completedReviewRunner("ALPHA FINDINGS"), env: {} }
    );
    const second = await delegateAgent(
      { agentType: "code-review", task: "review purpose beta", cwd: repositoryRoot },
      { writeCustody, runAgent: completedReviewRunner("BETA FINDINGS"), env: {} }
    );
    assert.equal(first.reviewBinding.status, "bound");
    assert.equal(second.reviewBinding.status, "bound");
    assert.notEqual(first.reviewBinding.reviewId, second.reviewBinding.reviewId);

    let runnerCalls = 0;
    const neverRun = async () => {
      runnerCalls += 1;
      throw new Error("reconcile_only must not invoke a reviewer");
    };
    const ambiguous = await delegateAgent(
      { agentType: "code-review", task: "reconcile all purposes", reconcileOnly: true, cwd: repositoryRoot },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(runnerCalls, 0);
    assert.equal(ambiguous.status, "completed");
    assert.equal(ambiguous.custodyState, "not-applicable");
    assert.equal(ambiguous.reviewBinding.status, "ambiguous");
    assert.equal(ambiguous.reviewBinding.reviewId, null);
    assert.ok(ambiguous.reviewBinding.reasons.some((reason) => reason.code === "multiple_fresh_reviews"));
    assert.match(ambiguous.result, /Multiple FRESH authoritative review receipts/u);

    const exact = await delegateAgent(
      {
        agentType: "code-review",
        task: "recover alpha only",
        reconcileOnly: true,
        reviewId: first.reviewBinding.reviewId,
        cwd: repositoryRoot
      },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(runnerCalls, 0);
    assert.equal(exact.reviewBinding.status, "bound");
    assert.equal(exact.reviewBinding.reviewId, first.reviewBinding.reviewId);
    assert.match(exact.result, /ALPHA FINDINGS/u);
    assert.match(exact.result, /Result Artifact: VERIFIED/u);
    assert.doesNotMatch(exact.result, /BETA FINDINGS/u);

    const wrongScope = await delegateAgent(
      {
        agentType: "security-review",
        task: "recover code review under the wrong profile",
        reconcileOnly: true,
        reviewId: first.reviewBinding.reviewId,
        cwd: repositoryRoot
      },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(wrongScope.reviewBinding.status, "unavailable");
    assert.ok(wrongScope.reviewBinding.reasons.some((reason) => reason.code === "review_id_not_recovered"));

    const wrongTarget = await delegateAgent(
      {
        agentType: "code-review",
        task: "recover code review under the wrong target",
        reconcileOnly: true,
        reviewId: first.reviewBinding.reviewId,
        targetRef: "refs/heads/main",
        cwd: repositoryRoot
      },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(wrongTarget.reviewBinding.status, "unavailable");
    assert.ok(wrongTarget.reviewBinding.reasons.some((reason) => reason.code === "review_id_not_recovered"));

    const nonexistent = await delegateAgent(
      {
        agentType: "code-review",
        task: "recover a nonexistent review",
        reconcileOnly: true,
        reviewId: "rr1:" + "f".repeat(64),
        cwd: repositoryRoot
      },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(nonexistent.reviewBinding.status, "unavailable");
    assert.ok(nonexistent.reviewBinding.reasons.some((reason) => reason.code === "review_id_not_recovered"));

    const otherRepository = path.join(path.dirname(repositoryRoot), "other-repository");
    await mkdir(otherRepository, { recursive: true });
    git(otherRepository, ["init", "-b", "main"]);
    git(otherRepository, ["config", "user.name", "Other Repository"]);
    git(otherRepository, ["config", "user.email", "other@example.invalid"]);
    await writeFile(path.join(otherRepository, "README.md"), "# other repository\n", "utf8");
    git(otherRepository, ["add", "README.md"]);
    git(otherRepository, ["commit", "-m", "other fixture"]);
    const wrongRepository = await delegateAgent(
      {
        agentType: "code-review",
        task: "recover code review under the wrong repository",
        reconcileOnly: true,
        reviewId: first.reviewBinding.reviewId,
        cwd: otherRepository
      },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(wrongRepository.reviewBinding.status, "unavailable");
    assert.ok(wrongRepository.reviewBinding.reasons.some((reason) => reason.code === "review_id_not_recovered"));

    await writeFile(path.join(repositoryRoot, "README.md"), "# stale fixture\n", "utf8");
    const stale = await delegateAgent(
      {
        agentType: "code-review",
        task: "recover an exact stale review",
        reconcileOnly: true,
        reviewId: first.reviewBinding.reviewId,
        cwd: repositoryRoot
      },
      { writeCustody, runAgent: neverRun, env: {} }
    );
    assert.equal(stale.reviewBinding.status, "bound");
    assert.equal(stale.reviewBinding.reviewId, first.reviewBinding.reviewId);
    assert.ok(stale.reviewBinding.reasons.some((reason) => reason.code === "worktree_state_changed"));
    assert.match(stale.result, /STALE/u);

    const indeterminate = await delegateAgent(
      {
        agentType: "code-review",
        task: "recover an exact indeterminate review",
        reconcileOnly: true,
        reviewId: first.reviewBinding.reviewId,
        cwd: repositoryRoot
      },
      {
        writeCustody,
        runAgent: neverRun,
        env: {},
        collectChangeSet: async () => ({
          status: "indeterminate",
          reasons: [{ code: "untracked_directory_opaque" }]
        })
      }
    );
    assert.equal(indeterminate.reviewBinding.status, "unavailable");
    assert.equal(indeterminate.reviewBinding.reviewId, first.reviewBinding.reviewId);
    assert.ok(indeterminate.reviewBinding.reasons.some((reason) => reason.code === "untracked_directory_opaque"));
    assert.match(indeterminate.result, /INDETERMINATE/u);
    assert.equal(runnerCalls, 0);

    await assert.rejects(
      delegateAgent(
        {
          agentType: "code-review",
          task: "review with an invalid historical selector",
          reviewId: first.reviewBinding.reviewId,
          cwd: repositoryRoot
        },
        { writeCustody, runAgent: completedReviewRunner("unused"), env: {} }
      ),
      (error) => error instanceof DelegateAgentInputError && /reconcile_only/u.test(error.message)
    );
  });
});

test("review binding disabled for future reviews does not make durable reconciliation undefined", async () => {
  await withRepository(async ({ repositoryRoot, writeCustody }) => {
    const created = await delegateAgent(
      { agentType: "code-review", task: "create durable review", cwd: repositoryRoot },
      { writeCustody, runAgent: completedReviewRunner("DURABLE FINDINGS"), env: {} }
    );
    let runnerCalls = 0;
    const reconciled = await delegateAgent(
      {
        agentType: "code-review",
        task: "read durable review with future binding disabled",
        reconcileOnly: true,
        reviewId: created.reviewBinding.reviewId,
        cwd: repositoryRoot
      },
      {
        writeCustody,
        env: { CLAUDE_AGENTS_REVIEW_BINDING: "off" },
        runAgent: async () => {
          runnerCalls += 1;
          throw new Error("reconcile_only must not invoke a reviewer");
        }
      }
    );
    assert.equal(runnerCalls, 0);
    assert.equal(reconciled.status, "completed");
    assert.equal(reconciled.custodyState, "not-applicable");
    assert.equal(reconciled.reviewBinding.status, "bound");
    assert.equal(reconciled.reviewBinding.reviewId, created.reviewBinding.reviewId);
    assert.match(reconciled.result, /DURABLE FINDINGS/u);
  });
});

test("an effective delegation override above the supported cap is unsafe before execution", () => {
  assert.throws(
    () => resolveAgentRuntime(getAgentProfile("code-review"), {
      env: { CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "7200000" }
    }),
    (error) => error instanceof DelegateAgentConfigurationError &&
      /CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS/u.test(error.message)
  );

  const unsafe = checkTimeoutHierarchySafety({
    codexTimeoutSec: 3600,
    maxProfileTimeoutMs: 1_800_000,
    effectiveDelegateTimeoutMs: 7_200_000,
    effectiveDelegateTimeoutValid: false
  });
  assert.equal(MAX_SUPPORTED_DELEGATE_TIMEOUT_MS, 1_800_000);
  assert.equal(unsafe.safe, false);
  assert.equal(unsafe.status, "unsafe-effective-delegate-timeout");
  assert.doesNotMatch(unsafe.message, /satisfies timeout hierarchy safety/u);

  const diagnostic = evaluateDiagnoseTimeout({
    registry: { "code-review": getAgentProfile("code-review") },
    codexTimeoutSec: 3600,
    env: { CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "7200000" }
  });
  assert.equal(diagnostic.effectiveDelegateTimeout.valid, false);
  assert.equal(diagnostic.timeoutSafety.status, "unsafe-effective-delegate-timeout");
  assert.equal(diagnostic.timeoutSafety.safe, false);
});

test("an unsafe effective timeout override is rejected at startup", () => {
  const startup = spawnSync(process.execPath, ["src/index.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS: "7200000" }
  });
  assert.notEqual(startup.status, 0);
  assert.match(startup.stderr, /CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS/u);
  assert.doesNotMatch(startup.stderr, /timeout-hierarchy safe/u);
});

test("an already-cancelled root request starts no filesystem or runner phase", async () => {
  const abortController = new AbortController();
  abortController.abort();
  let cwdResolutionStarted = false;
  let runnerStarted = false;

  await assert.rejects(
    delegateAgent(
      {
        agentType: "code-review",
        task: "cancel before request entry",
        cwd: "C:\\cancelled-root",
        abortSignal: abortController.signal
      },
      {
        env: {},
        resolveWorkingDirectory: async () => {
          cwdResolutionStarted = true;
          throw new Error("cwd resolution must not start");
        },
        runAgent: async () => {
          runnerStarted = true;
          throw new Error("runner must not start");
        }
      }
    ),
    (error) => error?.code === "claude_cancelled"
  );
  assert.equal(cwdResolutionStarted, false);
  assert.equal(runnerStarted, false);
});

test("the root observer rechecks cancellation immediately before starting a phase", async () => {
  const clock = manualClock();
  const abortController = new AbortController();
  const requestContext = createRequestDeadlineContext({
    deadlineAt: 100,
    abortSignal: abortController.signal,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancel
  });
  let operationStarted = false;
  try {
    const pending = requestContext.observe("cancellation-race", () => {
      operationStarted = true;
      return "must not run";
    });
    abortController.abort();
    await assert.rejects(pending, (error) => error?.code === "claude_cancelled");
    assert.equal(operationStarted, false);
  } finally {
    requestContext.dispose();
  }
});

function manualClock(initial = 0) {
  let time = initial;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: time + Math.max(0, delay), callback });
      return id;
    },
    cancel(id) {
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

const DEADLINE_WORKSPACE = Object.freeze({
  effectiveCwd: "C:\\deadline-fixture",
  repositoryRoot: "C:\\deadline-fixture",
  canonicalRepositoryKey: "c:\\deadline-fixture",
  rootSource: "git-boundary"
});

function deadlineDependencies(clock, extra = {}) {
  return {
    env: { CLAUDE_AGENTS_REVIEW_BINDING: "off" },
    now: clock.now,
    scheduleRequestDeadline: clock.schedule,
    cancelRequestDeadline: clock.cancel,
    requestDeadlineAt: 100,
    requestSettlementBudgetMs: 40,
    createExecutionId: () => "deadline-execution",
    resolveWorkingDirectory: async () => DEADLINE_WORKSPACE.effectiveCwd,
    resolveWorkspaceRoot: async () => DEADLINE_WORKSPACE,
    resolveRepositoryIdentity: async () => DEADLINE_WORKSPACE,
    loadContract: async () => "deadline contract",
    writeCustody: {
      stateRoot: "C:\\deadline-state",
      repositoryStateDirectory: () => "C:\\deadline-state\\repository"
    },
    ...extra
  };
}

test("one root request deadline bounds reconcile_only even without a Claude runner", async () => {
  const clock = manualClock();
  let runnerCalls = 0;
  let beforeStarted;
  const started = new Promise((resolve) => { beforeStarted = resolve; });
  const pending = delegateAgent(
    {
      agentType: "code-review",
      task: "bounded historical reconciliation",
      reconcileOnly: true,
      cwd: DEADLINE_WORKSPACE.effectiveCwd
    },
    deadlineDependencies(clock, {
      env: {},
      reviewBinder: {
        async before() {
          beforeStarted();
          await new Promise(() => {});
        },
        async loadResultArtifact() { return { status: "unavailable" }; }
      },
      runAgent: async () => {
        runnerCalls += 1;
        throw new Error("reconcile_only must not invoke a reviewer");
      }
    })
  );
  await started;
  clock.advanceTo(100);
  const outcome = await pending;
  assert.equal(runnerCalls, 0);
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.custodyState, "not-applicable");
  assert.equal(outcome.error.code, "delegate_request_deadline_exceeded");
});

test("the root deadline bounds an in-flight coherent-admission operation and delivers its abort signal", async () => {
  const clock = manualClock();
  let admissionStarted;
  let admissionSignal;
  const started = new Promise((resolve) => { admissionStarted = resolve; });
  const pending = delegateAgent(
    { agentType: "code-review", task: "bound coherent admission", cwd: DEADLINE_WORKSPACE.effectiveCwd },
    deadlineDependencies(clock, {
      env: {},
      coherentAdmission: {
        async admit({ mutationSignal }) {
          admissionSignal = mutationSignal;
          admissionStarted();
          await new Promise(() => {});
        }
      }
    })
  );

  await started;
  clock.advanceTo(100);
  const outcome = await pending;
  assert.equal(admissionSignal.aborted, true);
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.error.code, "delegate_request_deadline_exceeded");
  assert.equal(outcome.custodyState, "not-acquired");
});

test("the root deadline bounds an in-flight custody settlement and does not start a second mutation", async () => {
  const clock = manualClock();
  let releaseStarted;
  let releaseSignal;
  const started = new Promise((resolve) => { releaseStarted = resolve; });
  const pending = delegateAgent(
    { agentType: "code-review", task: "bound custody settlement", cwd: DEADLINE_WORKSPACE.effectiveCwd },
    deadlineDependencies(clock, {
      env: {},
      coherentAdmission: {
        async admit() { return { coherence: "held", record: { state: "RESERVED" } }; }
      },
      reviewBinder: {
        async before() {
          return {
            status: "unavailable",
            coherence: "held",
            reasons: [{ code: "review_binding_unavailable" }],
            priorReviews: [],
            receiptHistory: { status: "indeterminate", receipts: [], diagnostics: [] }
          };
        }
      },
      writeCustody: {
        stateRoot: "C:\\deadline-state",
        repositoryStateDirectory: () => "C:\\deadline-state\\repository",
        async markSpawning() { return { state: "SPAWNING" }; },
        async releaseUnstartedWriteAccess({ mutationSignal }) {
          releaseSignal = mutationSignal;
          releaseStarted();
          await new Promise(() => {});
        },
        async markOrphanedWriteAccess() {
          throw new Error("root stop must not start a second custody mutation");
        }
      },
      runAgent: async () => {
        throw Object.assign(new Error("runner proved no child started"), { processStarted: false });
      }
    })
  );

  await started;
  clock.advanceTo(100);
  const outcome = await pending;
  assert.equal(releaseSignal.aborted, true);
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.error.code, "delegate_request_deadline_exceeded");
  assert.equal(outcome.custodyState, "retention-failed");
});

test("the root envelope clips Claude useful work while reserving settlement", async () => {
  const clock = manualClock();
  let usefulWorkTimeout;
  const outcome = await delegateAgent(
    { agentType: "code-review", task: "clip useful work", cwd: DEADLINE_WORKSPACE.effectiveCwd },
    deadlineDependencies(clock, {
      runAgent: async ({ runtime }) => {
        usefulWorkTimeout = runtime.timeoutMs;
        return { result: "completed before the deadline", durationMs: 1, processStarted: false };
      }
    })
  );
  assert.equal(outcome.status, "completed");
  assert.equal(usefulWorkTimeout, 60);
});

test("pre-run work consumes the root envelope before runner clipping and insufficient reserve fails before spawn", async () => {
  const clock = manualClock();
  let runnerStarted;
  let runnerSignal;
  let usefulWorkTimeout;
  const started = new Promise((resolve) => { runnerStarted = resolve; });
  const pending = delegateAgent(
    { agentType: "code-review", task: "clip after deterministic prework", cwd: DEADLINE_WORKSPACE.effectiveCwd },
    deadlineDependencies(clock, {
      loadContract: async () => {
        clock.advanceTo(55);
        return "deadline contract";
      },
      runAgent: async ({ runtime, abortSignal }) => {
        usefulWorkTimeout = runtime.timeoutMs;
        runnerSignal = abortSignal;
        runnerStarted();
        await new Promise(() => {});
      }
    })
  );

  await started;
  // 100ms root deadline - 55ms pre-run work - 40ms mandatory settlement = 5ms.
  assert.equal(usefulWorkTimeout, 5);
  clock.advanceTo(100);
  const timedOut = await pending;
  assert.equal(runnerSignal.aborted, true);
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.error.code, "delegate_request_deadline_exceeded");

  const insufficientClock = manualClock();
  let runnerCalls = 0;
  const insufficient = await delegateAgent(
    { agentType: "code-review", task: "reserve before runner", cwd: DEADLINE_WORKSPACE.effectiveCwd },
    deadlineDependencies(insufficientClock, {
      loadContract: async () => {
        insufficientClock.advanceTo(60);
        return "deadline contract";
      },
      runAgent: async () => {
        runnerCalls += 1;
        throw new Error("runner must not start without settlement reserve");
      }
    })
  );
  assert.equal(runnerCalls, 0);
  assert.equal(insufficient.status, "timeout");
  assert.equal(insufficient.error.code, "delegate_request_deadline_exceeded");
});
