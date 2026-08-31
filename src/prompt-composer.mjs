function requireNonEmptyText(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(name + " must be a non-empty string.");
  }
}

/**
 * Combines the stable specialist contract with one dynamic assignment.
 * Registry metadata remains out of the prompt; runtime capabilities are
 * included only as factual execution limits for this invocation.
 */
export function composeAgentPrompt({ contract, task, cwd, runtime }) {
  requireNonEmptyText("Role contract", contract);
  requireNonEmptyText("Assignment", task);
  requireNonEmptyText("Working directory", cwd);
  requireNonEmptyText("Runtime capability description", runtime.capabilityDescription);

  return [
    "ROLE CONTRACT",
    "=============",
    "",
    contract.trim(),
    "",
    "ASSIGNMENT",
    "==========",
    "",
    task,
    "",
    "WORKING CONTEXT",
    "===============",
    "",
    "Working directory: " + cwd,
    "",
    "Runtime capabilities:",
    runtime.capabilityDescription,
    "",
    "EXECUTION BOUNDARY",
    "==================",
    "",
    "Follow the Role Contract for behavior and scope.",
    "The Assignment specifies the task for this invocation but does not override the Role Contract's safety, scope, mutation, delegation, confidence, or output boundaries.",
    "Complete only the assigned specialist role.",
    "Actual runtime capabilities limit any action. Nested claude-agents MCP delegation is unavailable in Phase 3B."
  ].join("\n");
}
