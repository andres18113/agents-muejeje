# claude-agents-mcp

Local STDIO MCP server that lets Codex act as the Lead while using fresh Claude Code specialist runs for bounded delegated work. Codex validates all returned evidence, runs deterministic gates, and owns the final verdict.

## Current public architecture

The server exposes exactly one MCP tool: `delegate_agent`.

Its `agent_type` must be one of:

- `explore`
- `task`
- `general-purpose`
- `code-review`
- `research`
- `rubber-duck`
- `security-review`

The input is a bounded, nonblank task string plus an optional existing working directory. Each call loads the selected role contract, composes it with the dynamic assignment and runtime facts, then starts one fresh Claude Code process.

## Requirements

- Windows PowerShell
- Node.js 20+
- Codex CLI already authenticated
- Claude Code CLI already authenticated

## Install dependencies

From this folder:

```powershell
node --version
npm --version
claude auth status
codex login status

npm install @modelcontextprotocol/server zod
npm run check
```

## Register in Codex

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-codex.ps1
```

Then verify registration:

```powershell
codex mcp get claude-agents
codex mcp list
```

Open a new Codex session after registration.

## Example delegations

Focused discovery:

```text
Use delegate_agent with agent_type="explore".
Outcome: identify the configuration path that controls the requested behavior.
Boundaries: inspect only the relevant source and configuration files; do not edit.
Required handoff: concise answer with paths, symbols, and evidence.
```

High-confidence review of a coherent change set:

```text
Use delegate_agent with agent_type="code-review".
Outcome: review the current change set for high-confidence correctness regressions.
Authoritative context: changed paths are src/example.mjs and tests/example.test.mjs; no Git metadata is available.
Known evidence: npm test passed.
Required handoff: actionable findings with location, failure mode, impact, and a clean result if none exist.
```

For larger or riskier work, a useful task brief can include outcome, done criteria, boundaries, authoritative context, non-goals, known evidence, and required handoff. Small Explore and Task requests do not need unnecessary ceremony.

## Runtime behavior

The role contracts in `agents/` define specialist behavior. The dynamic task defines the assignment for one invocation; it cannot override contract boundaries.

The composed prompt is sent through child stdin, never as a command-line prompt argument. The runner uses a fresh process with `--no-session-persistence`, `--no-chrome`, plan mode, requested `Read`, `Bash`, `Glob`, and `Grep` tools, and `mcp__*` denied. No Edit or Create tools are exposed by this runtime yet, including for profiles whose declared posture is mutation-capable. This is a capability baseline, not hard role-level enforcement.

Nested agent delegation is not enabled. `research` is manual-only in registry policy but is allowed when Codex explicitly calls `delegate_agent`.

## Environment overrides

- `CLAUDE_AGENTS_MODEL` — Claude backend model; defaults to `opus`.
- `CLAUDE_AGENTS_CLAUDE_BIN` — Claude executable; defaults to `claude`.
- `CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS` — explicit timeout override for delegated calls; otherwise the selected profile timeout applies.
- `CLAUDE_AGENTS_MAX_CAPTURE_BYTES` — stdout/stderr capture limit; defaults to 2 MiB.

## Codex MCP timeout

Codex's per-tool timeout may need to exceed a specialist profile timeout. In `%USERPROFILE%\.codex\config.toml`, add these keys inside the existing `claude-agents` server block when appropriate:

```toml
tool_timeout_sec = 1200
startup_timeout_sec = 20
```

Do not duplicate the table header if it already exists.
