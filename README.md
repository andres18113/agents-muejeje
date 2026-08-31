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

`task` and `general-purpose` acquire durable write admission before Claude starts. The authoritative record lives outside the checkout at `%LOCALAPPDATA%\claude-agents-mcp\state-v1\repositories\<repository-sha256>\ownership\record.json`. It contains only versioned lifecycle metadata: execution/profile identity, canonical repository identity, timestamps, coordinator and Claude PID-plus-start-time identities, the identity of a supervised mutating Git operation while one is in flight, and worktree metadata when applicable. It never contains the assignment, role contract, secrets, or environment values.

Admission uses an atomically renamed ownership directory, so separate MCP processes contend for the same Git common-directory identity. The lifecycle is `RESERVED` (`accessMode:none`), optional `PREPARING_WORKTREE`, `SPAWNING`, `ACTIVE`, optional `TERMINATING`/`ORPHANED`, `TERMINAL_PROVEN`, `HANDOFF_READY`, and `RELEASED`. A terminal record is archived under `executions/<executionId>`; its disappearance is never inferred from time or lease expiry. Before admitting a new writer, reconciliation checks both coordinator and Claude identities. The same live process blocks; a definitely dead or PID-reused process can be reconciled; unavailable identity remains blocked. A dead coordinator with live Claude is retained as `ORPHANED`. A `SPAWNING`/preparation record without sufficient child identity also fails closed.

While `git worktree add` runs, the record also carries that exact Git process's PID-plus-start-time identity, so a coordinator that dies mid-preparation can be reconciled by identity rather than by guessing. A still-live Git operation blocks; an ambiguous one blocks; a dead or PID-reused one is recognized as no longer running but still cannot prove preparation completed consistently, so the execution is orphaned. In every case any partially or fully created worktree is preserved for inspection and never deleted heuristically.

One narrow case releases custody without a durable Claude identity: the child died before its PID-plus-start-time could be captured, yet the same live coordinator spawned that exact `ChildProcess` and observed its `close`. That evidence is in-memory only, so after a coordinator restart the same record stays fail-closed. No placeholder identity is ever fabricated or persisted.

`general-purpose` runs in a detached Git worktree under the durable state directory, created from and recording the exact current `HEAD`. Its uncommitted changes remain there after completion for Codex to inspect; the MCP never commits, merges, rebases, pushes, applies, or automatically removes that worktree. Main-checkout dirty changes are not snapshotted into it. Orchestration-owned Git runs with an explicit environment allowlist rather than the inherited `process.env`, ignores system and per-user Git configuration, and disables repository hooks for the worktree checkout, so preparing an isolated workspace does not execute repository-supplied scripts. That is not the same as a side-effect-free checkout: clean/smudge filters, `.gitattributes` rules, and repository-local config still apply and remain inside the local-repository trust boundary. `task` intentionally remains root-bound so validation targets the caller's current workspace, while still taking durable write admission because its command may mutate. The five read-only profiles create no worktree.

Codex must not concurrently edit the same canonical repository while custody is open. The lock coordinates cooperating claude-agents MCP instances for the current user; it is not an OS sandbox and cannot stop an unrelated process from ignoring the state directory.

The runner uses `--restricted`, `--setting-sources ""`, `--strict-mcp-config`, and a private per-invocation settings file. The settings file contains only runtime policy and an optional Bash PreToolUse guard; it never contains the task body and is deleted at terminal cleanup. The child environment is built from a compatibility allowlist instead of inheriting `process.env`, so ordinary secret-bearing variables are not passed by default.

On Windows, process identity is `{pid, process StartTime UTC ticks}` obtained with `Get-Process`; output is machine-readable invariant data, not localized text. PID existence alone is never a destructive or release decision. Forced timeout/overflow termination rechecks that the PID still has the stored start identity before targeting the exact spawned Claude child with `taskkill /PID <pid> /T /F`, then waits for that exact `ChildProcess` to emit `close`; dead, reused, or ambiguous identities are not sent to `taskkill`, and requesting termination alone never returns custody. Only `close` is terminal proof. Node's `exit` means the direct child ended while its stdio may still be open, which is exactly the case where a descendant still holds the inherited pipes, so `exit` is kept as a diagnostic observation and never returns write custody on its own. The honest guarantee is therefore: Phase 5.1 proves termination of the exact supervised Claude child before returning custody; it does not prove that every escaped descendant is dead. A stronger transitive writer-authority guarantee requires Job Object or process-tree containment and remains future hardening. A dependency-free Node implementation does not provide reliable Job Object containment, so abrupt coordinator death may leave Claude descendants alive. Because `taskkill` itself accepts only a PID, Phase 5 also cannot eliminate the narrow check/use race between the start-identity recheck and `taskkill`; a Job Object or held native process handle would be needed for that stronger guarantee. Durable reconciliation detects and blocks a still-live recorded Claude process, but Phase 5 does not claim automatic process-tree cleanup after coordinator crash or cross-platform process identity. Fresh context and `--no-session-persistence` remain mandatory; there is no persistent parent, stage-persistent context, nested delegation, automatic integration, or parallel writer support.

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
