import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROCESS_IDENTITY_STATUS } from "../src/process-identity.mjs";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";

/**
 * What a client cancellation may cost, phase by phase.
 *
 * A cancelled request loses the right to begin work. The repository must not
 * also lose its next writer, because reconciliation deliberately refuses to
 * reclaim a slot whose coordinator is still alive - so anything this invocation
 * declines to settle stays held for as long as the MCP server runs. That is a
 * lockout, not safety.
 *
 * The rule this matrix pins: a stopped request may settle the one execution it
 * owns when, and only when, it can prove one of exactly two things.
 *
 *   the exact child it spawned closed   -> terminal proof, release;
 *   no child of it ever existed         -> proven absence, release.
 *
 * Everything else retains. In particular a deadline's own error reports
 * processStarted:false by construction, and that is an assumption rather than an
 * observation: absence counts only when the runner itself settles saying so, or
 * when the runner was never invoked at all.
 *
 * Each phase below drives a real durable store through a scripted runner, then
 * asks the question that actually matters - can the very next writer, in this
 * same coordinator, proceed?
 */

const REPOSITORY = "C:\\workspace\\phase-matrix";
const REPOSITORY_KEY = REPOSITORY.toLowerCase();
const WORKSPACE = Object.freeze({
  requestedCwd: REPOSITORY,
  effectiveCwd: REPOSITORY,
  repositoryRoot: REPOSITORY,
  repositoryIdentity: REPOSITORY + "\\.git",
  canonicalRepositoryKey: REPOSITORY_KEY,
  rootSource: "git-boundary",
  isolated: false
});

let nextPid = 41_000;

function childIdentity(executionId) {
  const child = new EventEmitter();
  child.pid = nextPid++;
  return Object.freeze({
    executionId,
    agentType: "task",
    repositoryRoot: REPOSITORY,
    pid: child.pid,
    startTime: String(child.pid * 100),
    source: "phase-matrix",
    child,
    startedAt: 1_100
  });
}

function closeProof(processIdentity, { supervised = false } = {}) {
  return Object.freeze({
    processIdentity,
    event: "close",
    code: 0,
    signal: null,
    observedAt: 1_200,
    ...(supervised ? { supervisedByCoordinator: true } : {})
  });
}

function cancellationError(extra) {
  return Object.assign(new Error("Client cancelled delegation."), {
    code: "claude_cancelled",
    ...extra
  });
}

async function withCoordinator(callback) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-phase-matrix-"));
  try {
    await callback(new DurableWriteCustodyManager({
      stateRoot,
      currentPid: 100,
      inspectProcess: async (pid) => Object.freeze({
        status: PROCESS_IDENTITY_STATUS.ALIVE,
        identity: Object.freeze({ pid, startTime: String(pid * 100), source: "phase-matrix" })
      }),
      now: () => 1_000
    }));
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function dependencies(writeCustody, { runAgent, executionId }) {
  return {
    env: {},
    writeCustody,
    createExecutionId: () => executionId,
    resolveWorkingDirectory: async () => WORKSPACE.effectiveCwd,
    resolveWorkspaceRoot: async () => WORKSPACE,
    resolveRepositoryIdentity: async () => WORKSPACE,
    loadContract: async () => "phase matrix contract",
    runAgent
  };
}

/**
 * Runs one cancellation phase and reports everything the matrix asserts on:
 * the outcome, the durable record left behind, and whether the very next writer
 * in this same coordinator is admitted.
 */
async function runPhase(writeCustody, { runAgent, executionId = "phase-execution" }) {
  const abortController = new AbortController();
  const outcome = await delegateAgent(
    {
      agentType: "task",
      task: "phase under cancellation",
      cwd: WORKSPACE.effectiveCwd,
      abortSignal: abortController.signal
    },
    dependencies(writeCustody, { runAgent: (args) => runAgent(args, abortController), executionId })
  );
  const durable = await writeCustody.getWriteAccess(REPOSITORY_KEY);

  let writerB;
  try {
    writerB = await delegateAgent(
      { agentType: "task", task: "the next writer in this same session", cwd: WORKSPACE.effectiveCwd },
      dependencies(writeCustody, {
        executionId: executionId + "-next",
        runAgent: async ({ onChildStarted }) => {
          const identity = childIdentity(executionId + "-next");
          await onChildStarted?.(identity, {});
          return {
            result: "next writer completed",
            durationMs: 1,
            processStarted: true,
            processIdentity: identity,
            terminalProof: closeProof(identity)
          };
        }
      })
    );
  } catch (error) {
    writerB = { status: "threw", error: { code: error?.code } };
  }
  return { outcome, durable, writerB };
}

test("phase A - cancelled before the runner is ever invoked", async () => {
  await withCoordinator(async (writeCustody) => {
    // The runner is never reached, so no spawn was issued and no child can
    // exist. Absence is structural rather than inferred.
    let runnerCalls = 0;
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async (_args, abortController) => {
        runnerCalls += 1;
        abortController.abort();
        throw cancellationError({ processStarted: false });
      }
    });
    assert.equal(runnerCalls, 1);
    assert.equal(outcome.error.code, "claude_cancelled");
    // Proven absent: settled, archived, nothing retained.
    assert.equal(outcome.custodyState, "released");
    assert.ok(outcome.custodyReasons.some((r) => r.code === "custody_settled_no_process_started"));
    assert.equal(durable, undefined);
    assert.equal(writerB.status, "completed");
  });
});

test("phase B - cancelled after spawn is issued but before process identity", async () => {
  await withCoordinator(async (writeCustody) => {
    // A child exists but was never bound to a durable identity. The runner
    // force-terminates it and returns supervised close proof; that proof, not
    // the cancellation, is what authorizes the release.
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async (_args, abortController) => {
        const identity = childIdentity("phase-execution");
        abortController.abort();
        throw cancellationError({
          processStarted: true,
          terminalProof: closeProof(identity, { supervised: true })
        });
      }
    });
    assert.equal(outcome.error.code, "claude_cancelled");
    assert.equal(outcome.custodyState, "released");
    assert.ok(outcome.custodyReasons.some((r) => r.code === "custody_settled_after_request_stop"));
    assert.equal(durable, undefined);
    assert.equal(writerB.status, "completed");
  });
});

test("phase C - cancelled after process identity but before ACTIVE", async () => {
  await withCoordinator(async (writeCustody) => {
    // Identity was captured, activation never published. The record is still
    // SPAWNING, and the exact child's close is what settles it.
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async (_args, abortController) => {
        const identity = childIdentity("phase-execution");
        abortController.abort();
        throw cancellationError({
          processStarted: true,
          processIdentity: identity,
          terminalProof: closeProof(identity)
        });
      }
    });
    assert.equal(outcome.error.code, "claude_cancelled");
    assert.equal(outcome.custodyState, "released");
    assert.equal(durable, undefined);
    assert.equal(writerB.status, "completed");
  });
});

test("phase D - cancelled while durably ACTIVE", async () => {
  await withCoordinator(async (writeCustody) => {
    let activated;
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async ({ onChildStarted }, abortController) => {
        const identity = childIdentity("phase-execution");
        activated = await onChildStarted?.(identity, {});
        abortController.abort();
        throw cancellationError({
          processStarted: true,
          processIdentity: identity,
          terminalProof: closeProof(identity)
        });
      }
    });
    void activated;
    assert.equal(outcome.error.code, "claude_cancelled");
    assert.equal(outcome.custodyState, "released");
    assert.equal(outcome.durableCustodyState, "released");
    assert.equal(durable, undefined);
    assert.equal(writerB.status, "completed");
  });
});

test("phase E - cancelled during termination, proven and unproven", async () => {
  // Proven: termination completes and yields exact close evidence.
  await withCoordinator(async (writeCustody) => {
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async ({ onChildStarted, onTerminationStarted }, abortController) => {
        const identity = childIdentity("phase-execution");
        await onChildStarted?.(identity, {});
        abortController.abort();
        await onTerminationStarted?.(identity, {});
        throw cancellationError({
          processStarted: true,
          processIdentity: identity,
          terminalProof: closeProof(identity)
        });
      }
    });
    assert.equal(outcome.custodyState, "released");
    assert.equal(durable, undefined);
    assert.equal(writerB.status, "completed");
  });

  // Unproven: termination could not establish that the child is gone. This is
  // the one genuine ambiguity - a process may still be mutating the repository
  // - so custody is retained and the next writer is refused. Availability is
  // never bought at the price of exclusion.
  await withCoordinator(async (writeCustody) => {
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async ({ onChildStarted, onTerminationStarted }, abortController) => {
        const identity = childIdentity("phase-execution");
        await onChildStarted?.(identity, {});
        abortController.abort();
        await onTerminationStarted?.(identity, {});
        throw cancellationError({
          processStarted: true,
          processIdentity: identity,
          code: "claude_termination_unproven"
        });
      }
    });
    assert.notEqual(outcome.custodyState, "released");
    assert.ok(durable, "an unproven termination must retain durable custody");
    assert.notEqual(durable.state, "RELEASED");
    assert.equal(writerB.status, "failed");
    assert.equal(writerB.error.code, "write_custody_conflict");
  });
});

test("a deadline's own assumption that nothing started never settles custody", async () => {
  await withCoordinator(async (writeCustody) => {
    // The runner never settles, so the only thing reporting processStarted:false
    // is the request stop itself - which is an assumption, not an observation.
    // A child may be running, so nothing may be released on that basis.
    const { outcome, durable, writerB } = await runPhase(writeCustody, {
      runAgent: async ({ onChildStarted }, abortController) => {
        await onChildStarted?.(childIdentity("phase-execution"), {});
        abortController.abort();
        await new Promise(() => {});
      }
    });
    assert.equal(outcome.error.code, "claude_cancelled");
    assert.notEqual(outcome.custodyState, "released");
    assert.ok(durable, "unobserved runner settlement must retain durable custody");
    assert.equal(writerB.status, "failed");
    assert.equal(writerB.error.code, "write_custody_conflict");
  });
});
