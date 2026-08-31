# Codex Agent Routing Contract

## Lead authority

Codex is the Lead. It understands the task, plans, implements, debugs, runs deterministic gates, validates Claude findings against repository evidence, and owns the final verdict. Claude specialists return advice, work, or evidence; they never take final responsibility from Codex.

## MCP entry point and valid roles

`delegate_agent` is the only claude-agents MCP entry point. Its valid `agent_type` values are exactly:

- `explore`
- `task`
- `general-purpose`
- `code-review`
- `research`
- `rubber-duck`
- `security-review`

There is no verification profile or compatibility alias. Codex performs narrow factual and evidentiary verification directly with repository evidence and deterministic gates.

## Routing guidance

- Use `explore` for a focused repository question where independent discovery has net value.
- Use `task` for one exact command or validation operation. Do not ask it to redesign or automatically repair failures.
- Use `general-purpose` for bounded multi-step secondary work when an independent context materially helps.
- Use `code-review` for a fresh, high-confidence review of a coherent change set after relevant deterministic gates.
- Use `research` only through an explicit/manual delegation for deeper evidence-oriented investigation.
- Use `rubber-duck` for adversarial but constructive critique of plans, architecture, assumptions, tests, implementation reasoning, or causal conclusions.
- Use `security-review` for security-sensitive changed-code review with high-confidence exploitability criteria.

## Phase 4 capability and custody boundaries

Every delegation starts in fresh context. Runtime capability selection is profile-specific:

- `explore`, `research`, and `rubber-duck`: Read, Grep, and Glob only.
- `code-review` and `security-review`: Read, Grep, and Glob only. Supply change-set evidence when version-control information is needed; they do not receive unrestricted shell access.
- `task`: Bash only, with write admission and a runtime shell authority guard. It does not receive Edit or Write.
- `general-purpose`: Read, Grep, Glob, Edit, Write, and guarded Bash, with write admission.

When `delegate_agent` starts a mutation-capable `task` or `general-purpose` execution for a canonical root, Codex must not concurrently edit that same root until the delegate returns terminal custody. Custody returns only after the exact spawned Claude child has a demonstrated terminal `close` or `exit` event. If the delegate reports `claude_termination_unproven`, its process-local root remains blocked as `ORPHANED`; do not start another writer for that root in this MCP process. A server restart only loses the in-memory block; it is not proof that the orphan exited. Codex may continue read-only inspection, external reasoning, unrelated work in another root, and later deterministic validation after custody returns.

The current enforcement boundary is Claude-runtime cooperative control: tool exposure, isolated settings/MCP configuration, shell guarding, sanitized child environment, and process-local write custody with fail-closed termination proof. It is not an OS sandbox, does not prevent Codex or another MCP process from writing, and does not create a durable cross-process lease or orphan reconciliation. Nested delegation is not implemented.

## Briefs, review, and evidence

Delegate only when independent context can materially improve correctness, confidence, or falsification. When useful, provide a bounded brief with Outcome, Done when, Boundaries, Authoritative context, Non-goals, Known evidence, and Required handoff. Do not require every heading for trivial exploration or a single command.

For code review, provide the coherent change-set scope, intended behavior, important invariants, risk areas, deterministic evidence, and any accepted findings already fixed. A clean specialist result is advisory, not proof. Codex validates each substantive finding, reruns applicable deterministic gates after accepted corrections, and requests a fresh independent code review when a material correction makes the reviewed change set stale.
