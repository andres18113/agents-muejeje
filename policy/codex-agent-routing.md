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

## Capability, custody, and review-integrity boundaries

Every delegation starts in fresh context. Runtime capability selection is profile-specific:

- `explore`, `research`, and `rubber-duck`: Read, Grep, and Glob only.
- `code-review` and `security-review`: Read, Grep, and Glob only. Supply change-set evidence when version-control information is needed; they do not receive unrestricted shell access.
- `task`: Bash only, with write admission and a runtime shell authority guard. It does not receive Edit or Write.
- `general-purpose`: Read, Grep, Glob, Edit, Write, and guarded Bash, with write admission.

When `delegate_agent` starts a mutation-capable `task` or `general-purpose` execution for a canonical repository, Codex must not concurrently edit that repository until the delegate returns terminal custody. Write admission is durable across MCP restart and is keyed by the repository's Git common directory, so main and linked worktrees share one conservative writer. Custody returns only after the live coordinator receives exact-child terminal proof or a later coordinator proves the stored PID-plus-start-time identities dead or reused. Lease age and PID existence alone are never release proof. Live or ambiguous state remains blocked; a dead coordinator with live Claude becomes `ORPHANED`.

`general-purpose` receives a detached isolated worktree created from the recorded base commit. Its changes remain uncommitted and the worktree remains available for Codex inspection; delegation never merges, commits, rebases, pushes, applies, or automatically deletes it. `task` stays in the caller's current workspace so commands validate the intended dirty/source state, but still requires durable write admission. Read-only roles receive no worktree. This phase does not snapshot dirty main-worktree changes into an isolated worktree.

The current enforcement boundary is Claude-runtime cooperative control plus same-user durable filesystem coordination: tool exposure, isolated settings/MCP configuration, shell guarding, sanitized child environment, atomic ownership records, Windows process identity, worktree isolation, and fail-closed reconciliation. It is not an OS sandbox and cannot prevent unrelated software from ignoring the ownership record. Windows forced termination requires a fresh PID-plus-start-time match before `taskkill /PID /T /F` and still requires exact-child terminal proof; no native Job Object dependency or crash-time process-tree cleanup is claimed, and `taskkill` cannot atomically bind its PID to the checked start time. Cross-platform process identity, nested delegation, parallel writers, persistent parents, automatic integration, and dirty-worktree snapshotting are not implemented.

For `code-review` and `security-review`, the orchestrator attempts coherent review admission in the same single repository ownership slot writers use. Denial never suppresses the review: it makes the result advisory and unbound. Before the reviewer runs, a `REVIEW SUBJECT` may truthfully state that admission is currently held and will be verified later; it must never claim in advance that the completed interval was coherent. Only a valid bound `ReviewReceipt`, written after a matching AFTER collection and before release, may make that claim. Reviewers still receive no Bash.

Codex interprets Phase 6 results conservatively:

- `FRESH` means the immutable receipt's repository subject matches a current exact collection.
- `STALE` means the subject changed. It requires a fresh review unless Codex explicitly accepts the old advice in its own reasoning; that decision is not carry-forward evidence.
- `INDETERMINATE` means freshness was not proven. It must never be treated as fresh.
- `unbound` means no verified review subject exists, even if the advisory review text is useful.
- `unavailable` means binding evidence could not be produced; it does not change the specialist execution status.

Receipt history carries an explicit completeness status and Codex must read it before drawing any conclusion from an empty list. `reviews/sc` is non-evidentiary and can never prove `complete`: only a completed authoritative `reviews/cs` sweep within configured recovery bounds can. Result-list bounds are separate from authoritative reasoning; a full list never stops the sweep or silently hides a newer unindexed receipt. `partial` means output or authoritative reasoning was truncated or unreadable, with `review_history_truncated` or `review_history_completeness_unproven` as applicable. `indeterminate` means discovery could not run at all and says nothing either way; it must never be read as "no prior review exists".

Receipt publication and custody release are reported separately, and Codex must not infer either from the other. `publication` is `not-attempted`, `cancelled-before-authority` (no receipt can ever appear), `authoritative-pending` (a receipt may still land, so custody is held), or `authoritative-settled` with its disposition. A retained slot reporting `review_receipt_publication_unquiesced` is uncertainty, not a permanent lock: the same live coordinator may still release it under the unchanged guarded rules once that exact publication settles, and the durable record - not the synchronous `custodyState` in the returned outcome - is authoritative for current custody.

The `custody.recovery` block states whether an automatic recovery path is armed inside the still-live coordinator and by what mechanism, or whether manual intervention is required now. An armed path is an attempt, not a guarantee: it can fail, and if that coordinator exits first the record reconciles under the ordinary Phase 5 rules instead. The durable record, not this field, is authoritative for current custody. Codex acts on `manual-required`; it does not manually clear a record whose reported mode is `same-coordinator-terminal-proof` or `same-coordinator-publication-settlement` while that coordinator is still live. A retained worktree is always reported with its location and with whether the delegation ever adopted it; delegation never deletes one, so cleanup is an explicit operator decision.

Prior receipts are discovered through a bounded stable-scope index so a receipt for state A remains findable at state B. The index is not evidence. `reconcile_only` is custody-free, has a finite root request deadline, and observes historical evidence plus the current ChangeSet without creating a new review. With no `review_id`, it recovers zero FRESH receipts as no applicable receipt, exactly one FRESH receipt as that receipt, and more than one as `AMBIGUOUS`; it never chooses the newest convenient receipt. `review_id: rr1:<sha256>` is legal only with `reconcile_only` and recovers that exact receipt or fails closed on repository/profile/target-scope mismatch. Codex trusts only a fully validated self-verifying receipt and the orchestrator's computed freshness result. Codex never rewrites, deletes, re-labels, or reinterprets a stored receipt, and never treats a contract/model/assignment basis difference as repository-state staleness. A material correction after review changes the `ChangeSet` and requires a fresh review when independent review is still warranted.

## Structured tool output

`delegate_agent` returns a versioned structured outcome (`claude-agents-mcp/delegate-outcome/v1`) alongside its text. It is evidence only: bounded reason codes, identities, custody/termination/recovery diagnostics, and receipt history. It never contains specialist result text, assignment bodies, contract text, environment values, or secrets, and Codex must continue reading the specialist's actual findings from the text content block. Its arrays and strings are capped and the document is size-bounded, so absence of a field is never proof that the underlying fact was absent - only the explicit statuses (`complete`/`partial`/`indeterminate`, `not-attempted`/`cancelled-before-authority`/`authoritative-pending`/`authoritative-settled`) carry that meaning. A `delegate_outcome_projection_failed` error code alongside a real execution status means the outcome could not be projected; the text block remains the record.

## Operational lifecycle: general-purpose, bound review, and integration

Codex Lead orchestrates and owns all lifecycle decisions. Specialists never automatically commit, merge, rebase, push, or integrate changes.

1. **Mutating delegation (`general-purpose`)**:
   Codex delegates with `agent_type="general-purpose"` and `cwd` set to the repository root. The specialist executes inside an isolated, detached worktree under `%LOCALAPPDATA%\claude-agents-mcp\state-v1\worktrees\...`. The source repository remains untouched. The returned structured outcome reports the isolated workspace in `workspace.worktree.root` (`worktreeRoot`).

2. **Lead inspection and deterministic gates in worktree**:
   Codex inspects the specialist's uncommitted changes directly in `worktreeRoot` (`git -C <worktreeRoot> status`, `git -C <worktreeRoot> diff`) and runs project verification gates there. Any preliminary review executed before commit is advisory for that pre-commit state and must not be presented as exact binding of the resulting commit.

3. **Codex Lead commit creation in worktree**:
   When Codex decides changes are acceptable to prepare, Codex Lead creates the explicit commit inside `worktreeRoot`:
   `git -C "<worktreeRoot>" add -A`, `git -C "<worktreeRoot>" commit -m "..."`, and reads `$reviewedCommitSha = git -C "<worktreeRoot>" rev-parse HEAD`. Committing produces a new exact Git/ChangeSet state.

4. **Bound review against that committed state (`code-review` / `security-review`)**:
   Codex delegates `code-review` with **`cwd` set to `<worktreeRoot>`** (not the source repository). The reviewer inspects the Git-visible `ChangeSet` where HEAD is now `$reviewedCommitSha`. The resulting `ReviewReceipt` binds this exact committed state, and Codex verifies it reports `FRESH`. Reviewers remain strictly read-only and never execute Git write commands.

5. **Codex Lead integration preserves or replaces identity**:
   A worktree directory path is not a Git commit-ish; Codex must never run `git merge <worktreeRoot>` or `git merge --squash <worktreeRoot>`. Do not use `git diff > changes.patch` as the canonical workflow because it can omit untracked files and PowerShell redirection introduces avoidable encoding differences. If the target can fast-forward, Codex runs `git -C "<targetRepo>" merge --ff-only $reviewedCommitSha` and verifies target `HEAD` equals `$reviewedCommitSha`; the existing receipt remains subject to target freshness checks. If it cannot fast-forward, any merge, cherry-pick, squash, rebase, or conflict resolution creates a new commit `C'`. Codex runs target gates on `C'`, obtains the required bound `code-review` and/or `security-review` for `C'`, and verifies `FRESH` for `C'` before final verdict. Conflict resolution cannot inherit old FRESH authorization.

6. **Post-integration verification and final verdict**:
   Codex reruns relevant target-branch gates for the exact target `HEAD` under consideration. Codex Lead alone owns the final verdict before pushing. The isolated worktree remains intact on disk for auditability.

## Briefs, review, and evidence

Delegate only when independent context can materially improve correctness, confidence, or falsification. When useful, provide a bounded brief with Outcome, Done when, Boundaries, Authoritative context, Non-goals, Known evidence, and Required handoff. Do not require every heading for trivial exploration or a single command.

For code review, provide the coherent change-set scope, intended behavior, important invariants, risk areas, deterministic evidence, and any accepted findings already fixed. Supply `target_ref` only as a fully-qualified `refs/heads/...` or `refs/remotes/...` ref; never invent an upstream. A clean specialist result is advisory, not proof. Codex validates each substantive finding, reruns applicable deterministic gates after accepted corrections, and requests a fresh independent code review when a material correction makes the reviewed change set stale.
