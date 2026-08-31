# claude-agents-mcp

Version 0.2.0. This local STDIO MCP server lets Codex act as the Lead while using fresh Claude Code specialist runs for bounded delegated work. Codex validates returned evidence, runs deterministic gates, and owns the final verdict.

## Public architecture

The server exposes exactly one MCP tool: `delegate_agent`.

Its valid `agent_type` values are:

- `explore`
- `task`
- `general-purpose`
- `code-review`
- `research`
- `rubber-duck`
- `security-review`

Each call loads the selected role contract, combines it with the dynamic task and runtime facts, and starts one fresh Claude Code process.

## Reproducible repository validation

Repository validation requires only Windows PowerShell and Node.js 20+.

```powershell
node --version
npm --version
npm ci
npm run ci
```

`npm run ci` runs syntax validation and the complete Node built-in test suite. It does not require Codex or Claude authentication, does not call either product, and does not read a user-global Codex policy file.

GitHub Actions runs the same credential-free validation on `windows-latest` with Node 20 through `.github/workflows/ci.yml`.

## MCP registration

Registering the MCP server additionally requires the Codex and Claude Code commands to be installed and authenticated. Repository tests do not.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-codex.ps1
```

Then confirm registration:

```powershell
codex mcp get claude-agents
codex mcp list
```

Open a new Codex session after registration.

## Routing policy ownership

[`policy/codex-agent-routing.md`](policy/codex-agent-routing.md) is the tracked project-owned routing contract. It documents the one entry point, the seven roles, Codex final authority, and the current runtime limits.

Your applicable Codex `AGENTS.md` remains user-owned. Review and merge relevant routing guidance manually when durable local orchestration policy is wanted; `install-codex.ps1` never overwrites or appends to it.

## Example delegations

Focused discovery:

```text
Use delegate_agent with agent_type="explore".
Outcome: identify the configuration path that controls the requested behavior.
Boundaries: inspect only relevant source and configuration files; do not edit.
Required handoff: concise answer with paths, symbols, and evidence.
```

High-confidence review of a coherent change set:

```text
Use delegate_agent with agent_type="code-review".
Outcome: review the stated change set for high-confidence correctness regressions.
Authoritative context: name changed paths, intended behavior, and relevant gates.
Required handoff: actionable findings with location, failure mode, impact, and a clean result if none exist.
```

For larger or riskier work, a brief may include Outcome, Done when, Boundaries, Authoritative context, Non-goals, Known evidence, and Required handoff. Small Explore and Task requests do not need unnecessary ceremony.

## Runtime behavior

Role contracts in `agents/` define specialist behavior. The dynamic task defines one assignment and cannot override contract boundaries.

The composed prompt is sent through child stdin, never as a command-line prompt argument. The runner uses a fresh process with `--no-session-persistence`, `--no-chrome`, plan mode, requested `Read`, `Bash`, `Glob`, and `Grep` tools, and `mcp__*` denied. No Edit or Create tools are exposed, including for profiles whose declared posture is mutation-capable. This is a capability baseline, not hard role-level enforcement; Phase 4 will address hard capability enforcement.

Nested delegation is not enabled. `research` is manual-only in registry policy but is allowed when Codex explicitly calls `delegate_agent`.

## Environment overrides

- `CLAUDE_AGENTS_MODEL` — Claude backend model; defaults to `opus`.
- `CLAUDE_AGENTS_CLAUDE_BIN` — Claude executable; defaults to `claude`.
- `CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS` — explicit delegated-call timeout override; otherwise the selected profile timeout applies.
- `CLAUDE_AGENTS_MAX_CAPTURE_BYTES` — stdout/stderr capture limit; defaults to 2 MiB.

## Codex MCP timeout

Codex's per-tool timeout may need to exceed a specialist profile timeout. In `%USERPROFILE%\.codex\config.toml`, add these keys inside the existing `claude-agents` server block when appropriate:

```toml
tool_timeout_sec = 1200
startup_timeout_sec = 20
```

Do not duplicate the table header if it already exists.
