function requireNonEmptyText(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(name + " must be a non-empty string.");
  }
}

/**
 * Combines the stable specialist contract with one dynamic assignment.
 * Registry metadata remains out of the prompt; runtime capabilities are
 * included only as factual execution limits for this invocation.
 *
 * The working context names three distinct identities and never conflates
 * them:
 *   effectiveCwd   the directory Claude is actually started in
 *   workspaceRoot  the filesystem root Claude is actually operating in
 *   repositoryRoot the coordinated repository this work belongs to
 *
 * For root-bound roles workspaceRoot and repositoryRoot are the same path.
 * For general-purpose they differ, and the prompt says so explicitly so the
 * worker never assumes its edits are visible in the coordinated checkout.
 */
export function composeAgentPrompt({
  contract,
  task,
  effectiveCwd,
  workspaceRoot,
  repositoryRoot,
  executionId,
  runtime
}) {
  requireNonEmptyText("Role contract", contract);
  requireNonEmptyText("Assignment", task);
  requireNonEmptyText("Working directory", effectiveCwd);
  requireNonEmptyText("Workspace root", workspaceRoot);
  requireNonEmptyText("Repository root", repositoryRoot);
  requireNonEmptyText("Execution ID", executionId);
  requireNonEmptyText("Runtime capability description", runtime.capabilityDescription);

  const isolated = workspaceRoot !== repositoryRoot;

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
    "Working directory: " + effectiveCwd,
    "Workspace root: " + workspaceRoot,
    "Repository root: " + repositoryRoot,
    "Execution ID: " + executionId,
    "",
    isolated
      ? "The workspace root is an isolated Git worktree checked out from the repository root. Work inside the workspace root; changes made there do not appear in the repository root working tree and are not committed, merged, rebased, or pushed for you."
      : "The workspace root is the coordinated repository root. Work inside it; changes are not committed, merged, rebased, or pushed for you.",
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
    "Actual runtime capabilities limit any action. Nested claude-agents MCP delegation is unavailable."
  ].join("\n");
}
