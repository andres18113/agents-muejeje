import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { getAgentProfile } from "../src/agent-registry.mjs";
import {
  DelegateAgentConfigurationError,
  DelegateAgentInputError,
  delegateAgent,
  delegateAgentInputSchema,
  formatDelegateAgentOutcome,
  resolveAgentRuntime
} from "../src/delegate-agent.mjs";

const WORKSPACE = Object.freeze({
  requestedCwd: "C:\\repo",
  effectiveCwd: "C:\\repo",
  workspaceRoot: "C:\\repo",
  repositoryRoot: "C:\\repo",
  repositoryIdentity: "C:\\repo\\.git",
  canonicalRepositoryKey: "c:\\repo\\.git",
  rootSource: "git-boundary",
  isolated: false
});

function identity(executionId, agentType) {
  const child = new EventEmitter();
  child.pid = 42_000;
  return Object.freeze({
    executionId,
    agentType,
    repositoryRoot: WORKSPACE.repositoryRoot,
    pid: child.pid,
    startTime: "4200000",
    source: "phase6-delegate-test",
    child,
    startedAt: 1
  });
}

function proof(processIdentity) {
  return Object.freeze({
    processIdentity,
    event: "close",
    code: 0,
    signal: null,
    observedAt: 2
  });
}

function baseDependencies(overrides = {}) {
  return {
    env: {},
    createExecutionId: () => "phase6-review-execution",
    resolveWorkingDirectory: async () => WORKSPACE.effectiveCwd,
    resolveWorkspaceRoot: async () => WORKSPACE,
    resolveRepositoryIdentity: async () => WORKSPACE,
    loadContract: async () => "contract bytes\n",
    ...overrides
  };
}

function reviewHarness({
  admission = "held",
  beforeThrows = false,
  afterThrows = false,
  afterHangs = false,
  markSpawningThrows = false,
  activateThrows = false
} = {}) {
  const events = [];
  let afterInput;
  const writeCustody = {
    stateRoot: "C:\\durable-state",
    repositoryStateDirectory: () => "C:\\durable-state\\repository",
    async markSpawning() {
      events.push("mark-spawning");
      if (markSpawningThrows) throw Object.assign(new Error("mark failed"), { code: "mark_failed" });
      return { state: "SPAWNING" };
    },
    async activateWriteAccess() {
      events.push("activate");
      if (activateThrows) throw Object.assign(new Error("activate failed"), { code: "activate_failed" });
      return { state: "ACTIVE" };
    },
    async releaseUnstartedWriteAccess() {
      events.push("release-unstarted");
      return { state: "RELEASED" };
    },
    async releaseWriteAccessAfterTerminal() {
      events.push("release");
      return { state: "RELEASED" };
    },
    async markOrphanedWriteAccess() {
      events.push("orphan");
      return { state: "ORPHANED" };
    }
  };
  const coherentAdmission = {
    async admit() {
      events.push("admit");
      if (admission === "throws") throw Object.assign(new Error("admit failed"), { code: "admit_failed" });
      if (admission === "denied") {
        return { coherence: "denied", reasons: [{ code: "coherent_admission_denied" }] };
      }
      return { coherence: "held", record: { state: "RESERVED" } };
    }
  };
  const reviewBinder = {
    async before() {
      events.push("before");
      if (beforeThrows) throw Object.assign(new Error("before failed"), { code: "before_failed" });
      return {
        status: "collected",
        coherence: admission === "held" ? "held" : "denied",
        reviewSubject: "REVIEW SUBJECT\n==============\n\nfixture",
        priorReviews: []
      };
    },
    async after(input) {
      events.push("after");
      afterInput = input;
      if (afterHangs) return new Promise(() => {});
      if (afterThrows) throw Object.assign(new Error("after failed"), { code: "after_failed" });
      if (input.beforeState?.coherence !== "held") {
        return {
          status: "unavailable",
          coherence: input.beforeState?.coherence || "denied",
          reasons: [{ code: "coherent_admission_denied" }],
          priorReviews: []
        };
      }
      return {
        status: "bound",
        coherence: "held",
        reasons: [],
        changeSetId: "cs1:" + "a".repeat(64),
        reviewId: "rr1:" + "b".repeat(64),
        priorReviews: []
      };
    }
  };
  const runAgent = async (argumentsForRunner) => {
    events.push("run");
    let processIdentity;
    if (argumentsForRunner.onChildStarted) {
      processIdentity = identity(argumentsForRunner.executionId, argumentsForRunner.agentType);
      await argumentsForRunner.onChildStarted(processIdentity);
    }
    return {
      result: "review result",
      stderrSummary: "",
      durationMs: 5,
      processStarted: Boolean(processIdentity),
      ...(processIdentity ? { processIdentity, terminalProof: proof(processIdentity) } : {})
    };
  };
  return {
    events,
    afterInput: () => afterInput,
    dependencies: baseDependencies({ writeCustody, coherentAdmission, reviewBinder, runAgent })
  };
}

test("the MCP input schema has exactly the Phase 6 public fields", () => {
  assert.deepEqual(Object.keys(delegateAgentInputSchema.shape).sort(), [
    "agent_type", "cwd", "target_ref", "task"
  ]);
  assert.equal(delegateAgentInputSchema.safeParse({
    agent_type: "code-review",
    task: "review",
    target_ref: "refs/remotes/origin/main"
  }).success, true);
  assert.equal(delegateAgentInputSchema.safeParse({
    agent_type: "code-review",
    task: "review",
    target_ref: "origin/main"
  }).success, false);
});

test("both review profiles run admit, BEFORE, reviewer, AFTER, then release", async () => {
  for (const agentType of ["code-review", "security-review"]) {
    const harness = reviewHarness();
    const outcome = await delegateAgent(
      {
        agentType,
        task: "review",
        cwd: WORKSPACE.effectiveCwd,
        targetRef: "refs/remotes/origin/main"
      },
      harness.dependencies
    );
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reviewBinding.status, "bound");
    assert.deepEqual(harness.events, [
      "admit", "mark-spawning", "before", "run", "activate", "after", "release"
    ]);
    const formatted = formatDelegateAgentOutcome(outcome);
    assert.match(formatted, /ReviewBinding: bound/u);
    assert.match(formatted, /ReviewCoherence: held/u);
    assert.match(formatted, /ChangeSetId: cs1:/u);
    assert.match(formatted, /ReviewId: rr1:/u);
  }
});

test("admission and binder failures never change a completed review outcome", async () => {
  for (const configuration of [
    { admission: "throws", reason: "coherent_admission_failed" },
    { beforeThrows: true, reason: "review_binding_internal_error" },
    { afterThrows: true, reason: "review_binding_internal_error" },
    { markSpawningThrows: true, reason: "coherent_admission_lifecycle_failed" },
    { activateThrows: true, reason: "coherent_admission_lifecycle_failed" }
  ]) {
    const harness = reviewHarness(configuration);
    const outcome = await delegateAgent(
      { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
      harness.dependencies
    );
    assert.equal(outcome.status, "completed", JSON.stringify(configuration));
    assert.equal(outcome.result, "review result");
    assert.equal(outcome.reviewBinding.status, "unavailable");
    assert.ok(outcome.reviewBinding.reasons.some((entry) => entry.code === configuration.reason));
  }
});

test("a lifecycle failure is visible to AFTER and cannot produce a bound receipt", async () => {
  const harness = reviewHarness({ activateThrows: true });
  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    harness.dependencies
  );
  assert.equal(harness.afterInput().beforeState.coherence, "lost");
  assert.notEqual(outcome.reviewBinding.status, "bound");
});

test("a hung AFTER binding cannot retain coherent review custody", async () => {
  const harness = reviewHarness({ afterHangs: true });
  harness.dependencies.reviewBindingAfterTimeoutMs = 10;
  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    harness.dependencies
  );

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.reviewBinding.status, "unavailable");
  assert.ok(outcome.reviewBinding.reasons.some((reason) => reason.code === "review_binding_timeout"));
  assert.ok(harness.events.includes("release"), "custody must release after the binding deadline");
});

test("repository identity failure runs advisory and never attempts admission on a worktree-local key", async () => {
  let admitCalled = false;
  let beforeCoherence;
  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    baseDependencies({
      resolveRepositoryIdentity: async () => {
        throw Object.assign(new Error("common directory unavailable"), { code: "git_identity_failed" });
      },
      coherentAdmission: {
        async admit() {
          admitCalled = true;
          return { coherence: "held", record: { state: "RESERVED" } };
        }
      },
      reviewBinder: {
        async before(input) {
          beforeCoherence = input.coherence;
          return {
            status: "collected",
            coherence: input.coherence,
            reviewSubject: "REVIEW SUBJECT\n==============\n\nadvisory",
            priorReviews: []
          };
        },
        async after({ beforeState }) {
          return {
            status: "unavailable",
            coherence: beforeState.coherence,
            reasons: [{ code: "coherent_admission_denied" }],
            priorReviews: []
          };
        }
      },
      runAgent: async () => ({ result: "advisory review", durationMs: 1 })
    })
  );

  assert.equal(outcome.status, "completed");
  assert.equal(admitCalled, false);
  assert.equal(beforeCoherence, "not-attempted");
  assert.equal(outcome.reviewBinding.coherence, "not-attempted");
  assert.ok(outcome.reviewBinding.reasons.some((reason) =>
    reason.code === "repository_identity_unavailable"));
  assert.equal(outcome.reviewBinding.reasons.some((reason) =>
    reason.code === "not_a_git_worktree"), false);
});

test("target_ref is rejected for the four non-participating profiles before workspace resolution", async () => {
  for (const agentType of ["explore", "task", "research", "rubber-duck"]) {
    let workspaceResolved = false;
    await assert.rejects(
      delegateAgent(
        {
          agentType,
          task: "work",
          cwd: WORKSPACE.effectiveCwd,
          targetRef: "refs/heads/main"
        },
        baseDependencies({
          resolveWorkspaceRoot: async () => {
            workspaceResolved = true;
            return WORKSPACE;
          }
        })
      ),
      (error) => error instanceof DelegateAgentInputError && error.code === "delegate_input_invalid"
    );
    assert.equal(workspaceResolved, false, agentType);
  }
});

test("general-purpose records an accepted target_ref on its writer reservation", async () => {
  let reservedTarget;
  const writeCustody = {
    async reserveWriteAccess(input) {
      reservedTarget = input.targetRef;
      return { state: "RESERVED" };
    },
    async activateWriteAccess() { return { state: "ACTIVE" }; },
    async releaseWriteAccessAfterTerminal() { return { state: "RELEASED" }; },
    async markOrphanedWriteAccess() { return { state: "ORPHANED" }; }
  };
  const processIdentity = identity("phase6-review-execution", "general-purpose");
  const outcome = await delegateAgent(
    {
      agentType: "general-purpose",
      task: "work",
      cwd: WORKSPACE.effectiveCwd,
      targetRef: "refs/heads/main"
    },
    baseDependencies({
      writeCustody,
      worktreeManager: { async prepare() { return WORKSPACE; } },
      runAgent: async (argumentsForRunner) => {
        await argumentsForRunner.onChildStarted(processIdentity);
        return {
          result: "done",
          durationMs: 1,
          processStarted: true,
          processIdentity,
          terminalProof: proof(processIdentity)
        };
      }
    })
  );
  assert.equal(reservedTarget, "refs/heads/main");
  assert.equal(outcome.status, "completed");
});

test("the kill switch and its validation are explicit", async () => {
  assert.throws(
    () => resolveAgentRuntime(getAgentProfile("code-review"), {
      env: { CLAUDE_AGENTS_REVIEW_BINDING: "sometimes" }
    }),
    DelegateAgentConfigurationError
  );

  const outcome = await delegateAgent(
    { agentType: "code-review", task: "review", cwd: WORKSPACE.effectiveCwd },
    baseDependencies({
      env: { CLAUDE_AGENTS_REVIEW_BINDING: "off" },
      runAgent: async () => ({ result: "review", durationMs: 1 })
    })
  );
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.reviewBinding, undefined);
  assert.equal(outcome.custodyState, "not-applicable");
});

test("a blank model override is truthfully recorded as the default selector", () => {
  const runtime = resolveAgentRuntime(getAgentProfile("code-review"), {
    env: { CLAUDE_AGENTS_MODEL: "   " }
  });
  assert.equal(runtime.model, "opus");
  assert.equal(runtime.modelSource, "default");
});
