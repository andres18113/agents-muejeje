# Handoff: claude-agents-mcp v0.2.1 Operational State

## Current Operational State

This document records the exact operational state of `claude-agents-mcp` following the v0.2.1 timeout, cancellation, artifact storage, and reconciliation hardening.

### 1. Architectural Invariants

- **Timeout Hierarchy**:
  $$\text{Outer Client Timeout (Codex: 3600s)} \ge \text{Max Profile Timeout (1800s)} + \text{Settlement Budget (615s)} = 2415\text{s}$$
  - `runtime.timeoutMs` represents the total useful-work execution envelope for `runClaudeAgent` (from child process spawn through completion), not pure inference time.
  - Settlement budget ($615\text{s}$) strictly bounds all synchronous teardown: process tree inspection, forced termination ladder (grace period + `taskkill` helper), worktree retention/release, and durable atomic record publication.
  - The client must configure `tool_timeout_sec = 3600` in `~/.codex/config.toml`.

- **Transport-Level Request Cancellation**:
  - `@modelcontextprotocol/sdk` handles JSON-RPC `notifications/cancelled` via `ctx.mcpReq.signal`.
  - `registerDelegateAgentTool` wires this signal as `clientAbortSignal`.
  - In-flight cancellation triggers immediate orderly forced termination of Claude runner child processes, verifies terminal proof (`close`), advances durable state to `TERMINAL_PROVEN`, and safely releases custody (`RELEASED`).
  - Pre-spawn cancellation fails closed with `claude_cancelled` and `processStarted: false` without invoking the child process.

- **Content-Addressed Review Result Artifacts**:
  - Reviewer outputs are stored under `reviews/artifacts/<sha256>.txt`.
  - Atomic persistence via `.tmp` staging and durable file sync before the authoritative `ReviewReceipt` rename.
  - Storage is content-addressed: filename is SHA-256 of the output text.
  - Recovery requires byte length and SHA-256 digest validation against `receipt.result.bytes` and `receipt.result.sha256`.
  - Corrupt, altered, or missing artifacts fail closed: findings are withheld, reasons contain `review_result_artifact_<status>`, and a fresh review is required.

- **Reconciliation Semantics (`reconcile_only: true`)**:
  - Activated strictly via explicit argument: `reconcile_only: true` (or camelCase `reconcileOnly: true`).
  - `task` remains ordinary descriptive assignment/context text and never acts as an implicit execution mode alias.
  - Non-review profiles (`task`, `general-purpose`, `explore`) reject `reconcile_only` with `DelegateAgentInputError`.
  - Binding and freshness are strictly separated dimensions:
    - `reviewBinding.status`: `"bound"` (receipt exists for historical scope) or `"unavailable"` (no receipt or indeterminate). Status is never `"stale"`.
    - Freshness verdict: `"FRESH"`, `"STALE"`, or `"INDETERMINATE"`.
  - **FRESH != CLEAN**: A fresh receipt proves applicability to the current ChangeSet, not approval. Review findings are extracted solely from the verified result artifact.
  - Zero Claude delegated quota: spawns 0 child processes and consumes 0 Claude specialist quota.

- **Installer TOML Safety**:
  - `install-codex.ps1` updates `tool_timeout_sec = 3600` under `[mcp_servers.claude-agents]` using UTF-8 without BOM.
  - Preserves CRLF line endings, comments, blank lines, and adjacent sections (`[mcp_servers.claude-agents.env]`, unrelated MCP servers).
  - Byte-stable and idempotent when the timeout is already configured.

### 2. Operational Procedures for Operators

- **On `FRESH`**: The verified reviewer findings apply to the current ChangeSet. Inspect recovered reviewer output.
- **On `STALE`**: The worktree or repository state has moved since the review was conducted. Operator must delegate a fresh review.
- **On `INDETERMINATE`**: Collector uncertainty prevents proving freshness. Fails closed. Operator must check git state or delegate a fresh review.
- **On `review_result_artifact_*` failure**: Fails closed. Operator must delegate a fresh review.

### 3. Test Suites & Verification

- `tests/operational-timeout-hierarchy.test.mjs`:
  - Machine-checked hierarchy assertions.
  - Credential-free timeout safety calculation.
  - 536-second incident regression & positive reconciliation (Tests A, B).
  - Missing and corrupt artifact fail-closed handling (Test D).
  - Collector uncertainty INDETERMINATE fail-closed handling (Test C).
  - Scope isolation across repository, target_ref, and agent_type (Tests E, F, G).
  - Client abort forced termination & custody release.
  - Pre-spawn client abort rejection.
  - Non-review profile rejection (Test H).
  - Manual-clock boundary tests for `deadline - 1`, `exactly deadline`, and `deadline + 1`.
- `tests/mcp-transport-cancellation.test.mjs`:
  - STDIO transport-level `notifications/cancelled` end-to-end integration test.
- `tests/installer-toml.test.mjs`:
  - 9 deterministic TOML fixture tests exercising all configuration edge cases.
