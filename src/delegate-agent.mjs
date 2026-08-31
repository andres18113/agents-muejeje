import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { AGENT_REGISTRY, getAgentProfile } from "./agent-registry.mjs";
import { loadAgentContract } from "./agent-contracts.mjs";
import {
  describeRuntimeCapabilities,
  resolveCapabilityPolicy
} from "./capability-policy.mjs";
import { buildClaudeEnvironment } from "./claude-environment.mjs";
import {
  MAX_CLAUDE_TIMEOUT_MS,
  ClaudeTimeoutError,
  runClaudeAgent
} from "./claude-runner.mjs";
import { composeAgentPrompt } from "./prompt-composer.mjs";
import { PROCESS_WRITE_CUSTODY } from "./write-custody.mjs";
import { resolveCanonicalWorkspaceRoot } from "./workspace-root.mjs";

export const DELEGATE_AGENT_TYPES = Object.freeze(Object.keys(AGENT_REGISTRY));
export const MAX_DELEGATE_TASK_CHARS = 100_000;

const DEFAULT_MODEL = "opus";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CAPTURE_BYTES = 2 * 1024 * 1024;
const SUPPORTED_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export class DelegateAgentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DelegateAgentConfigurationError";
    this.code = "delegate_runtime_configuration_invalid";
  }
}

export class DelegateAgentInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "DelegateAgentInputError";
    this.code = "delegate_input_invalid";
  }
}

function optionalEnvironmentString(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  if (typeof raw !== "string") {
    throw new DelegateAgentConfigurationError(
      name + " must be a non-empty string when configured."
    );
  }

  return raw.trim() || fallback;
}

function positiveIntegerFromEnvironment(env, name, fallback, unit) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new DelegateAgentConfigurationError(
      name + " must be a positive integer number of " + unit + "."
    );
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DelegateAgentConfigurationError(
      name + " must be a positive integer number of " + unit + "."
    );
  }

  return value;
}

function requirePositiveProfileTimeout(profile) {
  if (
    !Number.isSafeInteger(profile.timeoutMs) ||
    profile.timeoutMs <= 0 ||
    profile.timeoutMs > MAX_CLAUDE_TIMEOUT_MS
  ) {
    throw new DelegateAgentConfigurationError(
      "Agent profile '" +
        profile.id +
        "' has an invalid timeoutMs; it must be a positive integer no greater than " +
        MAX_CLAUDE_TIMEOUT_MS +
        " milliseconds."
    );
  }

  return profile.timeoutMs;
}

/**
 * Resolves the executable backend state for one profile. modelStrategy is
 * intentionally not a historical model lookup: all current strategies use
 * the configured Claude backend until a later multi-provider routing phase.
 *
 * CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS is an explicit operator override. In its
 * absence, the selected profile's timeout remains authoritative.
 */
export function resolveAgentRuntime(profile, { env = process.env } = {}) {
  if (!profile || typeof profile !== "object") {
    throw new DelegateAgentConfigurationError("An agent profile is required.");
  }

  if (!SUPPORTED_REASONING_EFFORTS.has(profile.reasoningEffort)) {
    throw new DelegateAgentConfigurationError(
      "Agent profile '" + profile.id + "' has unsupported reasoning effort '" +
        String(profile.reasoningEffort) +
        "'."
    );
  }

  if (!["configurable", "inherit", "complementary"].includes(profile.modelStrategy)) {
    throw new DelegateAgentConfigurationError(
      "Agent profile '" + profile.id + "' has unsupported model strategy."
    );
  }

  const profileTimeoutMs = requirePositiveProfileTimeout(profile);
  const capabilityPolicy = resolveCapabilityPolicy(profile);
  const timeoutOverride = env?.CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS;
  const timeoutMs = positiveIntegerFromEnvironment(
    env,
    "CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS",
    profileTimeoutMs || DEFAULT_TIMEOUT_MS,
    "milliseconds"
  );
  if (timeoutMs > MAX_CLAUDE_TIMEOUT_MS) {
    throw new DelegateAgentConfigurationError(
      "CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS must be no greater than " +
        MAX_CLAUDE_TIMEOUT_MS +
        " milliseconds."
    );
  }
  const maxCaptureBytes = positiveIntegerFromEnvironment(
    env,
    "CLAUDE_AGENTS_MAX_CAPTURE_BYTES",
    DEFAULT_CAPTURE_BYTES,
    "bytes"
  );

  return Object.freeze({
    claudeBin: optionalEnvironmentString(env, "CLAUDE_AGENTS_CLAUDE_BIN", "claude"),
    model: optionalEnvironmentString(env, "CLAUDE_AGENTS_MODEL", DEFAULT_MODEL),
    modelStrategy: profile.modelStrategy,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs,
    timeoutSource:
      timeoutOverride === undefined || timeoutOverride === null || timeoutOverride === ""
        ? "profile"
        : "operator-override",
    maxCaptureBytes,
    accessMode: capabilityPolicy.accessMode,
    permissionMode: capabilityPolicy.permissionMode,
    toolNames: capabilityPolicy.toolNames,
    disallowedTools: capabilityPolicy.disallowedTools,
    shellPolicy: capabilityPolicy.shellPolicy,
    nestedDelegation: capabilityPolicy.nestedDelegation,
    environmentPolicy: capabilityPolicy.environmentPolicy,
    settingsIsolation: capabilityPolicy.settingsIsolation,
    mcpIsolation: capabilityPolicy.mcpIsolation,
    enforcementBoundary: capabilityPolicy.enforcementBoundary,
    childEnvironment: buildClaudeEnvironment(env),
    capabilityDescription: describeRuntimeCapabilities(capabilityPolicy)
  });
}

export async function resolveDelegationWorkingDirectory(
  requestedCwd,
  { baseCwd = process.cwd(), statFn = stat } = {}
) {
  if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
    throw new DelegateAgentInputError("cwd must be a string when supplied.");
  }

  if (requestedCwd !== undefined && requestedCwd.trim().length === 0) {
    throw new DelegateAgentInputError("cwd must not be blank when supplied.");
  }

  const candidate = path.resolve(requestedCwd === undefined ? baseCwd : requestedCwd.trim());
  let details;
  try {
    details = await statFn(candidate);
  } catch (error) {
    throw new DelegateAgentInputError("cwd does not exist: " + candidate);
  }

  if (!details.isDirectory()) {
    throw new DelegateAgentInputError("cwd is not a directory: " + candidate);
  }

  return candidate;
}

function validateDelegationTask(task) {
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new DelegateAgentInputError("task must be a non-empty string.");
  }

  if (task.length > MAX_DELEGATE_TASK_CHARS) {
    throw new DelegateAgentInputError(
      "task is too long (" +
        task.length +
        " chars). Keep delegate_agent assignments at or below " +
        MAX_DELEGATE_TASK_CHARS +
        " characters."
    );
  }
}

function outcomeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: error?.code || "claude_execution_failed",
    message
  };
}

function requireExecutionId(createExecutionId) {
  const executionId = createExecutionId();
  if (
    typeof executionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(executionId)
  ) {
    throw new DelegateAgentConfigurationError("Execution ID generation returned an invalid value.");
  }
  return executionId;
}

function baseOutcome({ profile, runtime, workspace, executionId, startedAt, now, custodyState }) {
  return {
    executionId,
    agentType: profile.id,
    effectiveCwd: workspace.effectiveCwd,
    canonicalRoot: workspace.canonicalRoot,
    canonicalRootSource: workspace.rootSource,
    accessMode: runtime.accessMode,
    custodyState,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    timeoutMs: runtime.timeoutMs,
    timeoutSource: runtime.timeoutSource,
    startedAt,
    durationMs: Math.max(0, now() - startedAt),
    runtimeCapabilities: runtime.capabilityDescription
  };
}

function failedStatus(error) {
  return error instanceof ClaudeTimeoutError || error?.code === "claude_timeout"
    ? "timeout"
    : "failed";
}

/**
 * Executes exactly one explicit profile delegation. Dependencies are injectable
 * so unit tests can verify composition and lifecycle behavior without a real
 * Claude process.
 */
export async function delegateAgent(input, dependencies = {}) {
  const agentType = input?.agentType;
  const task = input?.task;
  const cwd = input?.cwd;
  const getProfile = dependencies.getProfile || getAgentProfile;
  const loadContract = dependencies.loadContract || loadAgentContract;
  const resolveCwd =
    dependencies.resolveWorkingDirectory || resolveDelegationWorkingDirectory;
  const resolveRuntime = dependencies.resolveRuntime || resolveAgentRuntime;
  const resolveWorkspace =
    dependencies.resolveWorkspaceRoot || resolveCanonicalWorkspaceRoot;
  const composePrompt = dependencies.composePrompt || composeAgentPrompt;
  const runAgent = dependencies.runAgent || runClaudeAgent;
  const writeCustody = dependencies.writeCustody || PROCESS_WRITE_CUSTODY;
  const createExecutionId = dependencies.createExecutionId || randomUUID;
  const env = dependencies.env || process.env;
  const now = dependencies.now || Date.now;

  validateDelegationTask(task);
  const executionId = requireExecutionId(createExecutionId);
  const profile = getProfile(agentType);
  const runtime = resolveRuntime(profile, { env });
  const requestedCwd = await resolveCwd(cwd);
  const workspace = await resolveWorkspace(requestedCwd, {
    accessMode: runtime.accessMode
  });
  const contract = await loadContract(profile.id);
  const prompt = composePrompt({
    profile,
    contract,
    task,
    cwd: workspace.effectiveCwd,
    canonicalRoot: workspace.canonicalRoot,
    executionId,
    runtime
  });
  const startedAt = now();
  let reservation;
  let custodyState = runtime.accessMode === "write" ? "not-acquired" : "not-applicable";
  let outcome;

  try {
    if (runtime.accessMode === "write") {
      reservation = writeCustody.reserveWriteAccess({
        executionId,
        agentType: profile.id,
        canonicalRoot: workspace.canonicalRoot,
        canonicalRootKey: workspace.canonicalRootKey
      });
      custodyState = reservation.state.toLowerCase();
      reservation = writeCustody.activateWriteAccess({
        executionId,
        canonicalRootKey: workspace.canonicalRootKey
      });
      custodyState = reservation.state.toLowerCase();
    }

    const execution = await runAgent({
      profile,
      prompt,
      cwd: workspace.effectiveCwd,
      canonicalRoot: workspace.canonicalRoot,
      executionId,
      runtime
    });

    outcome = {
      ...baseOutcome({
        profile,
        runtime,
        workspace,
        executionId,
        startedAt,
        now,
        custodyState
      }),
      status: "completed",
      durationMs:
        Number.isFinite(execution.durationMs) ? execution.durationMs : Math.max(0, now() - startedAt),
      result: execution.result,
      stderrSummary: execution.stderrSummary || "",
      ...(Number.isSafeInteger(execution.pid) ? { pid: execution.pid } : {})
    };
  } catch (error) {
    outcome = {
      ...baseOutcome({
        profile,
        runtime,
        workspace,
        executionId,
        startedAt,
        now,
        custodyState
      }),
      status: failedStatus(error),
      durationMs:
        Number.isFinite(error?.durationMs) ? error.durationMs : Math.max(0, now() - startedAt),
      error: outcomeError(error),
      stderrSummary: error?.stderrSummary || "",
      ...(Number.isSafeInteger(error?.pid) ? { pid: error.pid } : {})
    };
  } finally {
    if (reservation) {
      try {
        const released = writeCustody.releaseWriteAccess({
          executionId,
          canonicalRootKey: workspace.canonicalRootKey
        });
        custodyState = released.state.toLowerCase();
        if (outcome) outcome.custodyState = custodyState;
      } catch (releaseError) {
        custodyState = "release-failed";
        outcome = {
          ...baseOutcome({
            profile,
            runtime,
            workspace,
            executionId,
            startedAt,
            now,
            custodyState
          }),
          status: "failed",
          error: outcomeError(releaseError),
          stderrSummary: outcome?.stderrSummary || ""
        };
      }
    }
  }

  return outcome;
}

export function formatDelegateAgentOutcome(outcome) {
  const lines = [
    "Agent: " + outcome.agentType,
    "ExecutionId: " + outcome.executionId,
    "Status: " + outcome.status,
    "AccessMode: " + outcome.accessMode,
    "CanonicalRoot: " + outcome.canonicalRoot,
    "CustodyState: " + outcome.custodyState,
    "Model: " + outcome.model,
    "ReasoningEffort: " + outcome.reasoningEffort,
    "TimeoutMs: " + outcome.timeoutMs,
    "TimeoutSource: " + outcome.timeoutSource,
    "DurationMs: " + outcome.durationMs,
    "RuntimeCapabilities: " + outcome.runtimeCapabilities
  ];

  if (Number.isSafeInteger(outcome.pid)) {
    lines.push("Pid: " + outcome.pid);
  }

  if (outcome.status === "completed") {
    lines.push("", outcome.result);
  } else {
    lines.push("", "ErrorCode: " + outcome.error.code, "Error: " + outcome.error.message);
    if (outcome.stderrSummary) {
      lines.push("", "StderrSummary:", outcome.stderrSummary);
    }
  }

  return lines.join("\n");
}

export const delegateAgentInputSchema = z.object({
  agent_type: z
    .enum(DELEGATE_AGENT_TYPES)
    .describe("Registered specialist profile to run in a fresh Claude process."),
  task: z
    .string()
    .refine((value) => value.trim().length > 0, "task must not be blank.")
    .max(MAX_DELEGATE_TASK_CHARS)
    .describe(
      "Self-contained dynamic assignment from the Lead. Include task-specific scope, evidence, constraints, and desired output."
    ),
  cwd: z
    .string()
    .refine((value) => value.trim().length > 0, "cwd must not be blank when supplied.")
    .optional()
    .describe(
      "Repository/workspace directory Claude should inspect. Defaults to the MCP server process cwd."
    )
});

function mcpText(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {})
  };
}

export function registerDelegateAgentTool(server, { delegate = delegateAgent } = {}) {
  server.registerTool(
    "delegate_agent",
    {
      description:
        "Run one explicitly selected registered specialist in a fresh Claude Code process. The task is a dynamic assignment supplied by the Lead.",
      inputSchema: delegateAgentInputSchema
    },
    async ({ agent_type: agentType, task, cwd }) => {
      try {
        const outcome = await delegate({
          agentType,
          task,
          cwd
        });
        return mcpText(
          formatDelegateAgentOutcome(outcome),
          outcome.status !== "completed"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return mcpText("delegate_agent failed:\n" + message, true);
      }
    }
  );
}
