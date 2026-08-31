/**
 * Executable capability policy. Agent profiles describe identity and intended
 * posture; this module translates that metadata into the narrow Claude Code
 * runtime surface for one fresh delegation.
 *
 * This is Claude-runtime enforcement, not an operating-system sandbox.
 */

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}

const COMMON_DISALLOWED_TOOLS = ["Agent", "Task", "mcp__*"];

const policies = {
  explore: {
    accessMode: "read",
    toolNames: ["Read", "Grep", "Glob"],
    shellPolicy: "none",
    permissionMode: "plan"
  },
  task: {
    accessMode: "write",
    toolNames: ["Bash"],
    shellPolicy: "task",
    permissionMode: "auto"
  },
  "general-purpose": {
    accessMode: "write",
    toolNames: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    shellPolicy: "worker",
    permissionMode: "auto"
  },
  "code-review": {
    accessMode: "read",
    toolNames: ["Read", "Grep", "Glob"],
    shellPolicy: "none",
    permissionMode: "plan"
  },
  research: {
    accessMode: "read",
    toolNames: ["Read", "Grep", "Glob"],
    shellPolicy: "none",
    permissionMode: "plan"
  },
  "rubber-duck": {
    accessMode: "read",
    toolNames: ["Read", "Grep", "Glob"],
    shellPolicy: "none",
    permissionMode: "plan"
  },
  "security-review": {
    accessMode: "read",
    toolNames: ["Read", "Grep", "Glob"],
    shellPolicy: "none",
    permissionMode: "plan"
  }
};

export const CAPABILITY_POLICY = deepFreeze(
  Object.fromEntries(
    Object.entries(policies).map(([id, policy]) => [
      id,
      {
        ...policy,
        disallowedTools: [...COMMON_DISALLOWED_TOOLS],
        nestedDelegation: false,
        environmentPolicy: "sanitized-allowlist",
        settingsIsolation: "explicit-runtime-settings-only",
        mcpIsolation: "strict-runtime-config",
        enforcementBoundary: "claude-runtime-cooperative"
      }
    ])
  )
);

export class CapabilityPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapabilityPolicyError";
    this.code = "capability_policy_invalid";
  }
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || typeof profile.id !== "string") {
    throw new CapabilityPolicyError("A registered agent profile is required for capability resolution.");
  }

  if (!Object.hasOwn(CAPABILITY_POLICY, profile.id)) {
    throw new CapabilityPolicyError("No capability policy exists for agent profile '" + profile.id + "'.");
  }

  const policy = CAPABILITY_POLICY[profile.id];
  if (
    !["read", "write"].includes(policy.accessMode) ||
    !["none", "git-readonly", "task", "worker"].includes(policy.shellPolicy) ||
    !["plan", "auto"].includes(policy.permissionMode) ||
    !Array.isArray(policy.toolNames) ||
    policy.toolNames.length === 0 ||
    policy.nestedDelegation !== false
  ) {
    throw new CapabilityPolicyError("Capability policy for '" + profile.id + "' is malformed.");
  }

  return policy;
}

export function resolveCapabilityPolicy(profile) {
  return validateProfile(profile);
}

export function describeRuntimeCapabilities(policy) {
  const lines = [
    "Available Claude tools: " + policy.toolNames.join(", ") + ".",
    "Access mode: " + policy.accessMode + "."
  ];

  if (policy.toolNames.includes("Bash")) {
    lines.push(
      policy.shellPolicy === "task"
        ? "Bash is guarded for a single assigned command; external, publication, host-administration, and destructive authority is denied when classified."
        : "Bash is guarded for bounded repository work; external, publication, host-administration, and destructive authority is denied when classified."
    );
  } else {
    lines.push("Bash is not exposed.");
  }

  if (!policy.toolNames.includes("Edit")) {
    lines.push("Edit is not exposed.");
  }
  if (!policy.toolNames.includes("Write")) {
    lines.push("Write is not exposed.");
  }
  if (policy.accessMode === "write") {
    lines.push("Write admission is required before Claude starts and is active for the canonical root during execution.");
  }

  lines.push(
    "Nested Agent/Task delegation and external MCP tools are disabled.",
    "Tool exposure, settings isolation, shell policy, and write admission are Claude-runtime controls, not an OS sandbox."
  );

  return lines.join(" ");
}
