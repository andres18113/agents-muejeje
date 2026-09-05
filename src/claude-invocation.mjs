import { ClaudeRunnerError } from "./claude-errors.mjs";
import { REQUIRED_RESTRICTED_FLAG } from "./claude-preflight.mjs";

/**
 * The contract for invoking the Claude CLI: what a runtime policy must contain,
 * and the exact argument vector one delegation is allowed to launch.
 *
 * This is a policy surface, not a lifecycle one. It changes when the CLI's
 * flags or the enforced runtime posture change, which is a different reason
 * from anything in the process supervision or custody layers - so the flags
 * that enforce isolation (no inherited setting sources, strict MCP config, a
 * denied external-MCP glob, no session persistence) are visible in one place
 * rather than spread through an orchestrator.
 *
 * The composed prompt is deliberately absent from argv. It is written to stdin
 * by the runner, so large contracts and assignments neither hit Windows command
 * length limits nor become visible to command-line process inspection.
 */

function requireRuntimeSetting(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaudeRunnerError("Claude runtime " + name + " must be a non-empty string.", {
      code: "invalid_runtime_policy"
    });
  }
}

export function validateRuntimePolicy(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new ClaudeRunnerError("Claude runtime policy is required.", {
      code: "invalid_runtime_policy"
    });
  }
  requireRuntimeSetting("claudeBin", runtime.claudeBin);
  requireRuntimeSetting("model", runtime.model);
  requireRuntimeSetting("reasoningEffort", runtime.reasoningEffort);
  requireRuntimeSetting("permissionMode", runtime.permissionMode);
  if (!Array.isArray(runtime.toolNames) || runtime.toolNames.length === 0) {
    throw new ClaudeRunnerError("Claude runtime must contain a non-empty tool list.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!Array.isArray(runtime.disallowedTools) || !runtime.disallowedTools.includes("mcp__*")) {
    throw new ClaudeRunnerError("Claude runtime must deny external MCP tools.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!["none", "git-readonly", "task", "worker"].includes(runtime.shellPolicy)) {
    throw new ClaudeRunnerError("Claude runtime shell policy is invalid.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!runtime.childEnvironment || typeof runtime.childEnvironment !== "object") {
    throw new ClaudeRunnerError("Claude runtime child environment is required.", {
      code: "invalid_runtime_policy"
    });
  }
}

export function buildClaudeArgs(runtime, settingsPath) {
  requireRuntimeSetting("settings path", settingsPath);
  return [
    "-p",
    "--input-format",
    "text",
    "--model",
    runtime.model,
    "--effort",
    runtime.reasoningEffort,
    "--permission-mode",
    runtime.permissionMode,
    "--tools",
    runtime.toolNames.join(","),
    "--disallowed-tools",
    runtime.disallowedTools.join(","),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    settingsPath,
    // The same constant the preflight probes for: the runtime requirement and
    // the readiness check cannot skew on which flag production needs.
    REQUIRED_RESTRICTED_FLAG,
    "--no-session-persistence",
    "--no-chrome",
    "--output-format",
    "text"
  ];
}

export function getClaudeRunnerArgs(runtime, settingsPath = "<runtime-settings>") {
  return [...buildClaudeArgs(runtime, settingsPath)];
}
