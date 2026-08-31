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

Every invocation uses a fresh Claude process. The full role contract and assignment travel only over child stdin, never in command-line arguments. Nested Agent/Task delegation and external MCP tools are disabled.

| Profile | Access | Exposed Claude tools | Shell policy |
|---|---|---|---|
| `explore` | read | Read, Grep, Glob | none |
| `task` | write | Bash | guarded command execution; no Edit/Write |
| `general-purpose` | write | Read, Grep, Glob, Edit, Write, Bash | guarded bounded-repository work |
| `code-review` | read | Read, Grep, Glob | none; Lead supplies VCS/change-set evidence when needed |
| `research` | read | Read, Grep, Glob | none |
| `rubber-duck` | read | Read, Grep, Glob | none |
| `security-review` | read | Read, Grep, Glob | none; Lead supplies VCS/change-set evidence when needed |

`task` and `general-purpose` reserve process-local write admission before Claude starts, then become `ACTIVE` only when the exact spawned child is identified. Within one live MCP server process, a canonical root moves through `RESERVED`, `ACTIVE`, optionally `TERMINATING`, and only returns to `RELEASED` after that exact child has a terminal `close` or `exit` observation. Codex must not concurrently edit that root while custody is open. If forced termination cannot be proven, the root remains `ORPHANED` and rejects later writers for the remaining lifetime of that MCP process; readers may still run. Restarting the server discards only this in-memory block and is not orphan reconciliation. This does not prevent Codex, another MCP process, or another same-user process from writing; it is not system-wide locking or an OS sandbox.

The runner uses `--restricted`, `--setting-sources ""`, `--strict-mcp-config`, and a private per-invocation settings file. The settings file contains only runtime policy and an optional Bash PreToolUse guard; it never contains the task body and is deleted at terminal cleanup. The child environment is built from a compatibility allowlist instead of inheriting `process.env`, so ordinary secret-bearing variables are not passed by default.

On Windows, forced timeout/overflow termination targets only the exact spawned Claude PID with `taskkill /PID <pid> /T /F`. The runner waits for bounded `taskkill` completion and a terminal event from that exact `ChildProcess`; requesting termination alone never returns custody. If either proof is missing, the MCP result uses `claude_termination_unproven` and retains the process-local root block. Fresh context and `--no-session-persistence` remain mandatory; there is no persistent parent, resume, durable lease, orphan reconciliation, worktree isolation, or cross-process custody yet. Those stronger lifecycle and ownership controls are Phase 5 work.

`research` remains manual-only in registry policy but is allowed when Codex explicitly calls `delegate_agent`.

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
