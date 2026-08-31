/**
 * Declarative agent catalog.
 *
 * Identity and role semantics live here; runtime/model resolution does not.
 * In particular, modelStrategy, reasoningEffort, and timeoutMs are advisory
 * profile preferences. The consolidated delegate_agent runtime consumes this
 * registry to select one specialist for each fresh Claude invocation.
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

const profiles = [
  {
    id: "explore",
    displayName: "Explore",
    sourceFamily: "copilot-derived",
    kind: "scout",
    description: "Fast, focused repository exploration for answering a bounded codebase question.",
    contractPath: "agents/explore.md",
    modelStrategy: "configurable",
    reasoningEffort: "low",
    timeoutMs: 5 * 60 * 1000,
    autoInvoke: false,
    manualOnly: false,
    mutationPosture: "read-only",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["read-files", "search-repository"],
    allowedSubagents: [],
    delegationStatus: "declarative-only",
    outputContract: "Concise evidence-backed answer with repository paths or locations and any unresolved limits."
  },
  {
    id: "task",
    displayName: "Task",
    sourceFamily: "copilot-derived",
    kind: "executor",
    description: "Execute one requested development command without redesigning or repairing the work.",
    contractPath: "agents/task.md",
    modelStrategy: "configurable",
    reasoningEffort: "low",
    timeoutMs: 15 * 60 * 1000,
    autoInvoke: false,
    manualOnly: false,
    mutationPosture: "mutation-capable",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["execute-requested-command"],
    allowedSubagents: [],
    delegationStatus: "declarative-only",
    outputContract: "Brief command result and exit status; failures include relevant diagnostics without automatic repair."
  },
  {
    id: "general-purpose",
    displayName: "General Purpose",
    sourceFamily: "copilot-derived",
    kind: "worker",
    description: "Independent worker for complex multi-step implementation or analysis within assigned scope.",
    contractPath: "agents/general-purpose.md",
    modelStrategy: "inherit",
    reasoningEffort: "high",
    timeoutMs: 15 * 60 * 1000,
    autoInvoke: false,
    manualOnly: false,
    mutationPosture: "mutation-capable",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["read-files", "search-repository", "edit-files", "execute-commands"],
    allowedSubagents: [],
    delegationStatus: "declarative-only",
    outputContract: "Clear result with completed work, validation performed, decisions, and unresolved limits."
  },
  {
    id: "code-review",
    displayName: "Code Review",
    sourceFamily: "copilot-derived",
    kind: "reviewer",
    description: "Independent high-confidence review of an existing staged, unstaged, or branch change set.",
    contractPath: "agents/code-review.md",
    modelStrategy: "configurable",
    reasoningEffort: "high",
    timeoutMs: 15 * 60 * 1000,
    autoInvoke: false,
    manualOnly: false,
    mutationPosture: "read-only",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["read-files", "search-repository", "inspect-change-set"],
    allowedSubagents: ["explore", "security-review"],
    delegationStatus: "declarative-only",
    outputContract: "Only high-confidence actionable findings with evidence and impact; explicitly state a clean result when none remain."
  },
  {
    id: "research",
    displayName: "Research",
    sourceFamily: "copilot-derived",
    kind: "researcher",
    description: "Evidence-oriented investigation that verifies claims against primary sources and records gaps.",
    contractPath: "agents/research.md",
    modelStrategy: "configurable",
    reasoningEffort: "high",
    timeoutMs: 15 * 60 * 1000,
    autoInvoke: false,
    manualOnly: true,
    mutationPosture: "runtime-dependent",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["read-files", "search-repository", "research-evidence"],
    allowedSubagents: [],
    delegationStatus: "declarative-only",
    outputContract: "Precisely sourced findings, evidence gaps, and confidence limits."
  },
  {
    id: "rubber-duck",
    displayName: "Rubber Duck",
    sourceFamily: "copilot-derived",
    kind: "critic",
    description: "Independent oppositional but constructive critique of plans, implementations, assumptions, and conclusions.",
    contractPath: "agents/rubber-duck.md",
    modelStrategy: "complementary",
    reasoningEffort: "high",
    timeoutMs: 10 * 60 * 1000,
    autoInvoke: false,
    manualOnly: false,
    mutationPosture: "read-only",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["read-files", "search-repository", "analyze-proposal"],
    allowedSubagents: [],
    delegationStatus: "declarative-only",
    outputContract: "Blocking, Non-Blocking, Suggestions, and Summary sections limited to substantive, high-confidence critique."
  },
  {
    id: "security-review",
    displayName: "Security Review",
    sourceFamily: "copilot-derived",
    kind: "security-reviewer",
    description: "Independent security-focused review that reports only high-confidence, plausibly exploitable vulnerabilities.",
    contractPath: "agents/security-review.md",
    modelStrategy: "configurable",
    reasoningEffort: "high",
    timeoutMs: 15 * 60 * 1000,
    autoInvoke: false,
    manualOnly: false,
    mutationPosture: "read-only",
    enforcementStatus: "not-yet-enforced",
    runtimeIntegrationStatus: "delegate-agent",
    declaredCapabilities: ["read-files", "search-repository", "inspect-change-set", "security-analysis"],
    allowedSubagents: ["explore"],
    delegationStatus: "declarative-only",
    outputContract: "Only high-confidence vulnerabilities with evidence, plausible exploitability, and impact; explicitly state a clean result when none remain."
  }
];

export const AGENT_REGISTRY = deepFreeze(
  Object.fromEntries(profiles.map((profile) => [profile.id, profile]))
);

export function getAgentProfile(id) {
  if (typeof id !== "string" || !Object.hasOwn(AGENT_REGISTRY, id)) {
    throw new Error("Unknown agent profile: " + String(id));
  }

  return AGENT_REGISTRY[id];
}
