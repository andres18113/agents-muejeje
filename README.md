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
npm.cmd run diagnose
npm.cmd ci
npm.cmd run ci
```

In PowerShell, `npm` resolves to the `npm.cmd` shim; spelling it explicitly is what makes these lines copy-pasteable into a non-interactive shell, and it is the spelling the installer's own diagnostics use.

`npm.cmd run diagnose` is a credential-free setup check. It reports the resolved version and availability of Node, npm, Git, Codex, and Claude, refuses a Node older than 20, and prints two verdicts: `repository-validation` (Node, npm, and Git, all that `npm.cmd run ci` needs) and `mcp-registration` (those plus Codex and Claude). It exits non-zero only when repository validation itself is blocked, because a missing Codex or Claude blocks registration, not validation. It never inspects authentication.

`npm.cmd run ci` runs the source-hygiene gate, syntax validation, and the complete Node built-in test suite. It does not require Codex or Claude authentication, does not call either product, and does not read a user-global Codex policy file.

`npm.cmd run check:text` is the source-hygiene gate. Every tracked source and text file must be free of raw control characters other than tab, line feed, and carriage return. A literal NUL is the hard case: it makes Git classify the file as binary, which silently removes it from every diff and review that the rest of this system's evidence depends on. The remaining C0 controls and DEL do not change that classification but are invisible in every editor and review surface, which is its own hazard - a `\b` word-boundary escape that decayed into a literal backspace had already turned one assertion into a test that could never match, with nothing to show it. Source that needs these characters writes them as escapes, where they can be read.

GitHub Actions runs the same credential-free validation on `windows-latest` with Node 20 through `.github/workflows/ci.yml`.

## MCP registration

Registering the MCP server additionally requires the Codex and Claude Code commands to be installed and authenticated. Repository tests do not. `install-codex.ps1` resolves and prints the exact `node`, `npm.cmd`, Codex, and Claude executables it will use, with their versions, and refuses a Node older than 20 before it registers anything. It prefers the `.cmd`/`.exe` shims that actually execute on Windows and registers the resolved absolute Codex path rather than relying on `PATH` resolution at call time.

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

## Operational workflow: delegation, review, and integration

Codex Lead acts as the orchestrator and final authority. Claude specialists never automatically commit, merge, rebase, push, or integrate changes.

```text
general-purpose specialist
          |
isolated worktree W with uncommitted changes
          |
Codex Lead inspects diff (git -C "<worktreeRoot>" diff)
          |
Codex runs deterministic gates in W
          |
optional/preliminary code-review on W (advisory for pre-commit state)
          |
Codex decides changes are acceptable to prepare
          |
Codex Lead creates the commit in W (git -C "<worktreeRoot>" commit -m "...")
          |
new exact Git/ChangeSet state (HEAD = reviewedCommitSha)
          |
code-review and/or security-review with cwd = W
          |
ReviewReceipt binds the committed state
          |
Codex verifies FRESH
          |
Codex cherry-picks the exact reviewed commit SHA into target repository
          |
target-branch deterministic gates
          |
Codex final verdict
```

### 1. Delegating mutating work (`general-purpose`)
Codex invokes `delegate_agent` with `agent_type="general-purpose"` and `cwd` set to the repository root:
```json
{
  "name": "delegate_agent",
  "arguments": {
    "agent_type": "general-purpose",
    "task": "Implement feature X and associated unit tests",
    "cwd": "C:\\path\\to\\repository"
  }
}
```
The specialist executes inside an isolated detached Git worktree under `%LOCALAPPDATA%\claude-agents-mcp\state-v1\worktrees\...`. The source repository remains 100% clean and untouched. The response envelope returns `worktreeRoot` in `structuredContent.workspace.worktree.root` (and in human-readable `WorktreeRoot:`).

### 2. Lead inspection and deterministic gates
Codex Lead inspects the specialist's uncommitted changes and executes deterministic tests directly inside the isolated worktree `W`:
```powershell
git -C "<worktreeRoot>" status --short
git -C "<worktreeRoot>" diff
# Run test and verification gates directly inside worktreeRoot
```
Any preliminary `code-review` run on `W` while uncommitted is strictly advisory for that pre-commit state and must not be presented as exact binding of the resulting commit.

### 3. Lead commit creation in worktree
When Codex decides the changes are acceptable to prepare, Codex Lead creates the explicit commit inside `W`:
```powershell
git -C "<worktreeRoot>" add -A
git -C "<worktreeRoot>" commit -m "feat: validated specialist changes"
$reviewedCommitSha = (git -C "<worktreeRoot>" rev-parse HEAD).Trim()
```
Committing advances HEAD and cleans the index/worktree in `W`, producing a new exact Git/ChangeSet state.

### 4. Bound review against the committed state
To bind the exact state intended for integration, Codex Lead delegates `code-review` (or `security-review`) with **`cwd` set to `worktreeRoot`**:
```json
{
  "name": "delegate_agent",
  "arguments": {
    "agent_type": "code-review",
    "task": "Review committed changes for correctness regressions and invariant violations",
    "cwd": "<worktreeRoot>"
  }
}
```
`cwd` must be the exact specialist worktree `W`. The reviewer inspects the Git-visible `ChangeSet` where HEAD is now `$reviewedCommitSha`. The resulting `ReviewReceipt` binds this committed state and Codex verifies it is reported as `FRESH`. Reviewers remain strictly read-only and never execute Git write commands.

### 5. Lead integration via cherry-pick
A worktree directory path is not a Git commit-ish. Never run `git merge <worktreeRoot>` or `git merge --squash <worktreeRoot>`. Do not use `git diff > changes.patch` as the canonical workflow because it can omit untracked files and PowerShell redirection introduces avoidable encoding differences.

Codex Lead integrates the exact reviewed commit SHA into the target repository:
```powershell
git -C "<targetRepo>" cherry-pick $reviewedCommitSha
```

### 6. Target-branch verification and final verdict
Codex Lead reruns applicable target-branch verification gates in `<targetRepo>` after the cherry-pick. Codex Lead alone owns the final verdict before any push. The isolated worktree remains intact on disk for auditability.

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

### Review integrity

`code-review` and `security-review` participate in Phase 6 review binding because their existing profile capabilities declare `inspect-change-set`. They still receive only Read, Grep, and Glob: reviewers do not receive Bash and do not run Git. Before either reviewer starts, the orchestrator attempts to occupy the same durable ownership slot used by writers, collects a binary-safe Git-visible `ChangeSet`, and adds a `REVIEW SUBJECT` evidence block to the prompt. That block says only that admission is held at that moment and will be checked after the review; it never claims in advance that coherence covered the completed interval. If admission is denied, the reviewer still runs, but its result is advisory and unbound.

The exact bound-review guarantee is:

> The orchestrator excluded its own managed writers during the review interval and observed the same exact Git-visible ChangeSet and target context immediately before and after the review.

Only a successfully persisted `ReviewReceipt` makes that completed-interval claim. A receipt is written only for a completed execution when coherent admission is still verifiably held and the independently collected BEFORE and AFTER identities match. Collection, admission, persistence, or binding failure does not change the specialist's execution status or discard its text; it produces `ReviewBinding: unavailable` or `ReviewBinding: unbound` with reason codes instead.

The AFTER binding runs under its own outer deadline, and a deadline observes work rather than stopping it. Receipt publication is therefore fenced across that boundary using the same rule Phase 5 applies to durable custody writes.

The fence sits at exactly one place: the atomic rename that makes a receipt durable under `reviews/cs`. The cancellation check, the authority marker, and that rename are adjacent with no `await` between them, so a cancellation either lands before the check - and then no receipt can ever appear - or after authority was taken, and then the orchestrator must wait rather than release. There is no interleaving in which it does neither. Publication settlement is reported by the fence itself rather than by the binder returning, because a binder's return is not evidence about a write it merely issued.

The `reviews/sc` scope index is deliberately outside that boundary. It is non-evidentiary housekeeping that starts only after the receipt is already durable and is not awaited by publication, so a stalled or failing index can neither downgrade a receipt nor hold coherent-review custody open.

If the bounded quiescence wait expires, nothing has been proven: the slot is retained rather than released, and the outcome reports `review_receipt_publication_unquiesced` alongside `coherent_admission_retained`. Retention there is uncertainty, not permanent ownership. The same still-live coordinator keeps watching that exact publication, and if it later settles, the coordinator performs the same guarded release it would have performed synchronously, using the same terminal evidence and the same ownership and revision checks. A record that has since moved to another owner, been archived, or been released is refused and stays fail-closed; the synchronously reported `custodyState` remains the snapshot it always was, and the durable record stays authoritative. Nothing else, and no other coordinator, may take that path.

A binder failure is not a withdrawal of authority. If the binder rejects after crossing the publication boundary, the failure is reported as `review_binding_internal_error` while custody is held exactly as it would be for a binder that never returned, because an already-authorized write can still land. Conversely, a binding the binder did return is never discarded to preserve a timer's guess: its identities are reported alongside an unsettled publication rather than replaced by a synthetic timeout.

The `ChangeSet` identity covers eight independently digested sections: `head`, declared review `target`, collection `policy`, staged `index`, unstaged `worktree`, `unmerged`, `untracked`, and `submodules`. Worktree and untracked content is hashed from exact bytes with file/symlink domain separation. Repository-relative path bytes, modes, object IDs, unmerged stages, and target resolution are identity-bearing. Branch name, merge-base, and counts are summary metadata and are not hashed. Ignored files are excluded. A sparse checkout, dirty submodule, opaque untracked directory, unstable read, custody ambiguity, size/deadline breach, or unsupported state yields an indeterminate collection instead of a guessed identity.

Every identity-bearing observation is bracketed, not only porcelain status. One collection observes status, then the resolved review target, then the resolved worktree HEAD of every clean submodule; it hashes content; then it re-observes all three in the same order. Any disagreement is instability, retried inside the bounded attempt budget and reported as `collector_unstable` when it persists. Both extra observations are load-bearing: a target ref that moves, and a clean submodule checked out from one non-index commit to another under a structurally unchanged porcelain field, each change the subject while leaving status output byte-identical. Only the literal `branch.oid (initial)` produces an unborn HEAD; a missing, malformed, or wrong-width `branch.oid` is indeterminate rather than an assertion that the repository has no commits. Encoded descriptor paths are identity and display representations and are never used as filesystem locators: a non-UTF-8 path is addressed by its raw Git bytes where the platform can address them and is indeterminate where it cannot, so a file literally named with another's hexadecimal spelling can never be hashed in its place. The collection deadline cancels the collection as well as the wait, so no Git command and no filesystem read begins after it expires. That check is per-operation rather than per-entry: inside one file's digest, cancellation is rechecked before the first `lstat`, before the open, before every chunk read, before the link read, before the confirming `lstat`, and before the single retry a vanished or unstable entry is allowed. A retry is a new collection operation and must not begin after cancellation.

An optional `target_ref` may be supplied to `delegate_agent` for `general-purpose`, `code-review`, or `security-review`. It must be fully qualified under `refs/heads/` or `refs/remotes/`. A review resolves the target independently during both collections; movement or deletion therefore changes the subject. No upstream, `origin/HEAD`, `origin/main`, or status-header target is inferred. A `general-purpose` worktree records its declared target so a later review inside that retained worktree can inherit it with explicit `worktree-metadata` provenance.

Receipts are immutable, self-verifying canonical-JSON records. Validation recomputes both `reviewId` and the `changeSetId` derivation from the stored object format and all eight section digests. Their basis contains the exact UTF-8 SHA-256 of the contract, canonical-JSON SHA-256 of the resolved capability policy, exact UTF-8 assignment SHA-256 plus JavaScript character count, exact UTF-8 result SHA-256 plus byte count, requested model selector and its source, profile model strategy, and requested reasoning effort. The model selector is not represented as an observed effective model: this runtime cannot prove which concrete served model fulfilled the selector. Receipts contain no assignment body, review text, contract text, environment values, secrets, absolute paths, or repository-relative path names. They are integrity-protected but unsigned, so they do not authenticate an author or producer. A receipt records the two observations' non-identity metadata separately as `beforeSummary` and `afterSummary`: the reviewer was shown the BEFORE summary, so a single undifferentiated field filled from AFTER would present metadata the reviewer never saw as if it were the subject it worked from. Neither summary is hashed into `changeSetId`.

Durable evidence and non-evidentiary discovery are separate:

```text
%LOCALAPPDATA%\claude-agents-mcp\state-v1\repositories\<repository-sha256>\
  ownership\record.json
  reviews\
    cs\<change-set-prefix>\<review-prefix>\receipt.json
    sc\<stable-scope-prefix>\<timestamp>-<review-prefix>.json
```

The `cs` tree is authoritative immutable evidence. The bounded `sc` tree contains only lookup pointers keyed by stable review scope (reviewer profile plus declared target ref), not by the current `changeSetId`. This is why receipt A remains discoverable after the repository becomes B and can be validated and evaluated as `STALE`. A pointer is never trusted as evidence: its identifiers are strictly validated, its referenced receipt must validate, the receipt's full scope must match the lookup, and both content-addressed IDs are recomputed. At most 16 prior receipts are returned per discovery, the newest 32 pointers per scope are retained, and at most 64 immutable receipts are admitted per change set. Pointer pruning never deletes a receipt; failure to update the non-evidentiary index never downgrades or removes an already durable receipt. The system has no receipt retention or automatic cleanup.

Because indexing failure is deliberately silent, an empty index is not evidence either. Nothing about an absent pointer distinguishes "no review ever happened" from "the pointer was never written", so discovery never answers `complete` from the index alone. Whenever the index does not fill the requested bound, the authoritative `cs` tree is swept under a hard bound for receipts in the same review scope. Recovered receipts are reported normally and marked `review_history_recovered_from_receipts`; a sweep stopped by its bound reports `review_history_recovery_truncated`, an entry it could not validate reports `review_history_recovery_unreadable`, and a tree it could not enumerate at all makes the history `indeterminate` with `review_history_recovery_failed`. The sweep is observational: it repairs no pointer, writes nothing, and never touches custody. Its practical effect is that a receipt orphaned by index failure or pruning stays discoverable and can still be evaluated `STALE`.

Receipt history is reported with an explicit completeness status, because an empty list has two very different meanings. `complete` means discovery ran and returned every receipt in scope - an empty `complete` history is a proven absence of prior reviews. `partial` means discovery ran but something was skipped or truncated: a dangling or lying pointer, a corrupt receipt, or a scope with more pointers than the bound returns. `indeterminate` means discovery could not be performed at all, so the history says nothing either way and must never be read as "no prior reviews exist". Every skip and truncation is reported as a bounded diagnostic code beside the receipts it excluded, and a skipped receipt that is still identifiable is itself listed as `INDETERMINATE` rather than dropped.

Freshness is computed and never stored. `FRESH` means the current exact identity matches the receipt. `STALE` means it differs and reports the changed sections. `INDETERMINATE` means the current state, receipt, or schema comparison cannot prove either answer. Contract, capability-policy, assignment, requested model, model strategy, and effort differences are reported as basis differences but never alter repository-state freshness. Prior receipts are reported; they never skip a new review or mutate/carry forward old evidence.

Review binding can be disabled with `CLAUDE_AGENTS_REVIEW_BINDING=off`, which restores the Phase 5 review path: no review admission, collection, receipt, or binding output. `target_ref` is still validated at the public boundary.

The honest limits are:

1. There is no filesystem snapshot isolation. Double Git-status and per-file double-stat brackets detect churn conservatively but cannot detect every change-and-revert within one timestamp tick.
2. Paths Git reports clean use Git's index/object evidence rather than re-hashing every tracked file, so collection inherits Git's racily-clean semantics.
3. Only cooperating managed writers are excluded. A user, IDE, or unrelated process may ignore custody; BEFORE/AFTER comparison detects many such mutations, not all possible transient ones.
4. Receipts are unsigned. A local actor able to write the state directory can forge a self-consistent receipt.
5. `changeSetId` is machine- and worktree-local. Raw checkout bytes, including line endings, intentionally make it unsuitable as a portable logical-patch identity.
6. Ignored files are outside the subject even though a reviewer with Read may be able to open one by name.
7. Dirty submodules and sparse checkouts are indeterminate; recursive exact representation is deferred.
8. Target commit is identity-bearing. A fetched branch advance conservatively makes prior receipts stale even when worktree bytes did not change.
9. A crashed coherent review can block writers under the same fail-closed reconciliation rules as a crashed writer, and reviews of one repository serialize.
10. A review attempted while a writer owns the slot degrades to an advisory unbound review.
11. A repository or target that changes during the review produces no receipt; runtime output reports both identities when available.
12. Receipts have no automatic retention or pruning. The per-change-set cap bounds one namespace, but manual external cleanup is the operator's responsibility. Authoritative recovery is bounded too: a repository with more accumulated change sets than the sweep's bound reports a truncated history rather than scanning without limit.
13. Twenty-hex path prefixes can theoretically collide. Collisions are detected and refused, never merged silently.
14. `changeSetId` does not include repository identity. Receipts are nevertheless stored beneath the repository's own SHA-256 coordination identity.
15. Non-UTF-8 paths are identity-bearing as hex but displayed as `<non-utf8 path: ...>`, so the reviewer may not be able to address them by native name. Windows cannot address such a pathname at all, so a change set containing one is indeterminate there rather than approximated.
16. Collection costs two brackets of status, target, and submodule-head observation plus content hashing. Entry, byte, output, and 180-second collection limits yield indeterminate rather than hanging, and the collection deadline stops further observation rather than merely stopping the wait. Final review binding has a separate outer deadline so it cannot retain custody forever; a receipt write already in flight when that deadline expires keeps custody retained rather than released, and is released later only if that same publication settles inside the same still-live coordinator under the unchanged guarded release rules. If the coordinator exits first, the record stays retained and reconciles under the ordinary Phase 5 rules rather than being released by anything weaker.
17. There is no carry-forward mechanism. Accepting a stale review is a Lead decision outside the receipt and never changes it.
18. Process-identity reconciliation remains Windows-specific. On other platforms a foreign crashed owner remains fail-closed and may require manual intervention.

`task` and `general-purpose` acquire durable write admission before Claude starts. The authoritative record lives outside the checkout at `%LOCALAPPDATA%\claude-agents-mcp\state-v1\repositories\<repository-sha256>\ownership\record.json`. It contains only versioned lifecycle metadata: execution/profile identity, canonical repository identity, timestamps, coordinator and Claude PID-plus-start-time identities, the identity of a supervised mutating Git operation while one is in flight, worktree metadata when applicable, and a monotonic record revision. It never contains the assignment, role contract, secrets, or environment values. Valid Phase 5.2 schema-1 records remain readable and upgrade to the revisioned schema on their next guarded mutation; unknown record shapes fail closed.

Admission uses an atomically renamed ownership directory, so separate MCP processes contend for the same Git common-directory identity. Within one live coordinator, every authoritative ownership read, validation, revision-checked publication, archive, and admission is serialized per repository. Each mutation validates its execution and record revision again immediately before publication, so a stale callback cannot overwrite a later state, released archive, or newly admitted owner. The lifecycle is `RESERVED` (`accessMode:none`), optional `PREPARING_WORKTREE`, `SPAWNING`, `ACTIVE`, optional `TERMINATING`/`ORPHANED`, `TERMINAL_PROVEN`, `HANDOFF_READY`, and `RELEASED`. A terminal record is archived under `executions/<executionId>`; its disappearance is never inferred from time or lease expiry. Before admitting a new writer, reconciliation checks both coordinator and Claude identities. The same live process blocks; a definitely dead or PID-reused process can be reconciled; unavailable identity remains blocked. A dead coordinator with live Claude is retained as `ORPHANED`. A `SPAWNING`/preparation record without sufficient child identity also fails closed. A record whose coordinator had already begun forced termination (`TERMINATING`, or an existing `ORPHANED`) never releases automatically after that coordinator dies, even when the recorded Claude process is itself proven dead: beginning termination is what may have launched a destructive `taskkill` helper, and that helper's lifecycle was known only in the crashed coordinator's memory, so no later coordinator can observe whether it finished. A dead target proves the target died, not that the repository is quiet, so such records stay `ORPHANED` and keep blocking. Only states whose terminal proof is already durable (`TERMINAL_PROVEN`, `HANDOFF_READY`) may complete a release after coordinator death.

While `git worktree add` runs, the record also carries that exact Git process's PID-plus-start-time identity, so a coordinator that dies mid-preparation can be reconciled by identity rather than by guessing. A still-live Git operation blocks; an ambiguous one blocks; a dead or PID-reused one is recognized as no longer running but still cannot prove preparation completed consistently, so the execution is orphaned. In every case any partially or fully created worktree is preserved for inspection and never deleted heuristically.

One narrow case releases custody without a durable Claude identity: the child died before its PID-plus-start-time could be captured, yet the same live coordinator spawned that exact `ChildProcess` and observed its `close`. That evidence is in-memory only, so after a coordinator restart the same record stays fail-closed. No placeholder identity is ever fabricated or persisted. Likewise, if a bounded termination attempt leaves the record `ORPHANED` but that same live coordinator later receives an exact close for the same child, it may explicitly progress `ORPHANED -> TERMINAL_PROVEN -> HANDOFF_READY -> RELEASED`; foreign or restarted coordinators cannot use that recovery path. A late recovery persistence failure leaves custody `ORPHANED` and is reported through the runner's narrow stderr diagnostic path. `custodyState` in a returned delegation outcome is the state observed at synchronous finalization, not a live view: authorized late recovery can advance the durable record afterward, and that record is authoritative for current custody.

`general-purpose` runs in a detached Git worktree under the durable state directory, created from and recording the exact current `HEAD`. Its uncommitted changes remain there after completion for Codex to inspect; the MCP never commits, merges, rebases, pushes, applies, or automatically removes that worktree. Main-checkout dirty changes are not snapshotted into it. Orchestration-owned Git runs with an explicit environment allowlist rather than the inherited `process.env`, ignores system and per-user Git configuration, and disables repository hooks for the worktree checkout, so preparing an isolated workspace does not execute repository-supplied scripts. That is not the same as a side-effect-free checkout: clean/smudge filters, `.gitattributes` rules, and repository-local config still apply and remain inside the local-repository trust boundary. `task` intentionally remains root-bound so validation targets the caller's current workspace, while still taking durable write admission because its command may mutate. The five read-only profiles create no worktree.

Codex must not concurrently edit the same canonical repository while custody is open. The lock coordinates cooperating claude-agents MCP instances for the current user; it is not an OS sandbox and cannot stop an unrelated process from ignoring the state directory.

The runner uses `--restricted`, `--setting-sources ""`, `--strict-mcp-config`, and a private per-invocation settings file. The settings file contains only runtime policy and an optional Bash PreToolUse guard; it never contains the task body and is removed during terminal cleanup. The child environment is built from a compatibility allowlist instead of inheriting `process.env`, so ordinary secret-bearing variables are not passed by default. One invocation has an absolute execution deadline for useful work, a separate fixed proof-of-death deadline that begins when forced termination starts (including its durable transition), and a bounded housekeeping deadline for settings cleanup. A deadline winning a Promise race is bounded observation, not quiescence: it requests cancellation of a durable lifecycle mutation. A mutation still before its rename boundary cannot publish; a rename already issued remains serialized and quiesces before any later custody mutation or handoff. A cleanup timeout is reported separately and never discards already-proven close evidence. Immediately before the first prompt byte is written, the runner rechecks the absolute execution deadline; a clean close before delivery is a pre-ready failure even when it emitted startup stdout.

On Windows, process identity is `{pid, process StartTime UTC ticks}` obtained through `System.Diagnostics.Process.GetProcessById` and `Process.StartTime`; output is machine-readable invariant data, not localized text. PID existence alone is never a destructive or release decision. Forced timeout/overflow termination passes two independent gates before it may create a `taskkill /PID <pid> /T /F` helper. The durable gate comes first: the ownership record must already have published `TERMINATING`. If that publication fails, times out, is cancelled before its rename, or otherwise cannot be proven, no PID-based helper is created at all and only the exact in-memory `ChildProcess` handle is asked to die. The identity gate follows: a fresh recheck that the PID still has the stored start identity, where only `SAME_PROCESS` authorizes the command. The durable gate exists because a taskkill helper is a detached process with no durable identity, tracked solely in the launching coordinator's memory; launching one while the record still said `ACTIVE` would let a crash strand a record that reconciliation may legitimately release while that helper was still running. The enforced invariant is therefore: a taskkill helper was launched only if durable `TERMINATING` was published first, which is what keeps the `ACTIVE` + coordinator-dead + Claude-dead release path safe. If taskkill errors, exits unsuccessfully, or hangs, supervision falls back to a request through the exact in-memory `ChildProcess` handle and waits the remaining proof-of-death grace. Once taskkill is launched, its exact helper `close` is separately required before safe handoff: target-child `close` proves only the target, while helper `close` proves only that the destructive helper has quiesced. If either proof is absent at its bounded deadline, custody remains fail-closed. Dead, reused, or ambiguous identities are never sent to `taskkill`, and requesting termination alone never returns custody. Only `close` is terminal proof. Node's `exit` means the direct child ended while its stdio may still be open, which is exactly the case where a descendant still holds the inherited pipes, so `exit` is kept as a diagnostic observation and never returns write custody on its own. Initial PID-plus-start-time binding is race-hardened by refusing a query result once the exact child has already exited or closed, but it is not atomic or handle-bound; formal elimination requires native Windows process-handle identity/containment such as a future Job Object design. The honest guarantee is therefore: Phase 5 proves termination of the exact supervised Claude child and any launched destructive helper before returning custody; it does not prove that every escaped descendant is dead. A stronger transitive writer-authority guarantee requires Job Object or process-tree containment and remains future hardening. A dependency-free Node implementation does not provide reliable Job Object containment, so abrupt coordinator death may leave Claude descendants alive. Because `taskkill` itself accepts only a PID, Phase 5 also retains a narrow start-identity check/use race before taskkill; a Job Object or held native process handle would be needed for that stronger guarantee. Durable reconciliation detects and blocks a still-live recorded Claude process, but Phase 5 does not claim automatic process-tree cleanup after coordinator crash or cross-platform process identity. Fresh context and `--no-session-persistence` remain mandatory; there is no persistent parent, stage-persistent context, nested delegation, automatic integration, or parallel writer support.

`research` remains manual-only in registry policy but is allowed when Codex explicitly calls `delegate_agent`.

Reasoning effort has one shared domain - `low`, `medium`, `high`, `xhigh`, `max` - used by both runtime resolution and durable receipt validation. A second private copy is how a profile becomes legal to run and impossible to record: `xhigh` and `max` were previously valid runtimes whose receipts could not validate. Any profile this server will start is therefore representable as review evidence, and anything outside the shared domain is refused at both boundaries.

### Structured delegation outcome

`delegate_agent` advertises an output schema and returns a versioned structured outcome alongside the human-readable text. The envelope is `claude-agents-mcp/delegate-outcome/v1` with a top-level `status` of `completed`, `failed`, `timeout`, or `rejected`, plus:

- `execution` - execution id, agent type, status, timing, pid, requested model selector, reasoning effort, and a bounded error code and message.
- `workspace` - effective cwd, canonical root and its source, and a `worktree` block when one exists. `retained` is always true because nothing here ever deletes a worktree; `adopted` says whether the delegation actually ran in it, so a worktree left behind by failed preparation is still reported with its location instead of vanishing from the outcome.
- `custody` - the synchronous `state`, the `durableState` observed on the record, `retained`/`orphaned` flags, bounded reason codes, a `recovery` block (`automatic`, `manualInterventionRequired`, and one of `not-needed`, `same-coordinator-terminal-proof`, `same-coordinator-publication-settlement`, `manual-required`, `unknown`). `automatic` means an automatic recovery path is armed inside this still-live coordinator, not that recovery has happened or will succeed: an armed path is an attempt, the durable record stays authoritative, and if the coordinator exits first the record simply reconciles under the ordinary Phase 5 rules, and a `termination` block reporting whether a process started, whether its identity was recorded, whether terminal proof was a `close`, the forced-termination status and method, whether a destructive helper was authorized, and whether that helper's quiescence was proven.
- `review` - binding status and coherence, the BEFORE and AFTER `ChangeSet` identities separately as well as the bound `changeSetId`, the `reviewId`, bounded reason codes, the `receiptHistory` block described above with per-receipt freshness verdict, changed sections and basis differences, and a `publication` block reporting `not-attempted`, `cancelled-before-authority`, `authoritative-pending`, or `authoritative-settled` with its disposition.

The structured outcome is deterministically bounded and carries evidence only. Reason and diagnostic arrays are capped, paths and error messages are truncated with an explicit `pathsTruncated` flag, the serialized document is refused above 128 KiB, and every code is validated against a conservative character class. Every bound says when it bit, because a cap that says nothing turns a partial list into an apparently complete one: a capped reason list ends in `public_reasons_truncated`, receipt history reports `count` as the receipts the delegation actually held rather than the number that survived the bound, and anything dropped is named by `public_receipt_history_truncated` or `public_receipt_history_unprojectable`. Discovery-side truncation is reported separately as `review_history_truncated`. A reason `detail` survives only for an allowlisted set of reason codes whose detail is itself a machine code (an errno, a durable-store failure code), and only when the value is machine-code shaped; every other reason keeps its code alone. That is a shape and allowlist guarantee, not a value guarantee: it is what keeps free text, paths, and environment values out, and it is the reason details are produced only from error codes in the first place. Specialist result text, assignment bodies, contract text, environment values, and secrets never appear in it - the specialist's text is returned only in the text content block. Because losing a real execution's status to a projection defect would be worse than losing its detail, a projection failure degrades to the same versioned envelope carrying the true status plus a `delegate_outcome_projection_failed` code rather than being reported as a rejected request.

The human-readable text reports the same facts, including `EffectiveCwd`, `CanonicalRootSource`, `DurableCustodyState`, `RetainedWorktreeRoot`, `CustodyReasons`, `RecoveryMode`, `ManualInterventionRequired`, the termination diagnostics, and `ReceiptHistoryStatus` with one `PriorReview` line per discovered receipt.

An `ORPHANED` or retained outcome is meant to be acted on without reading the durable store by hand. It names why custody was retained (`terminal-proof-unavailable`, `worktree-preparation-ambiguous`, `custody-release-proof-failed`, `custody-retention-failed`, or `review_receipt_publication_unquiesced`), whether an automatic recovery path is armed and by which mechanism, whether manual intervention is required now, and where any retained worktree was left.

## Environment overrides

- `CLAUDE_AGENTS_MODEL` — Claude backend model; defaults to `opus`.
- `CLAUDE_AGENTS_CLAUDE_BIN` — Claude executable; defaults to `claude`.
- `CLAUDE_AGENTS_DELEGATE_TIMEOUT_MS` — explicit delegated-call timeout override; otherwise the selected profile timeout applies.
- `CLAUDE_AGENTS_MAX_CAPTURE_BYTES` — stdout/stderr capture limit; defaults to 2 MiB.
- `CLAUDE_AGENTS_REVIEW_BINDING` — `on` (default) enables coherent review binding; `off` restores the Phase 5 review path.

## Operational timeout hierarchy and late-receipt recovery

A reliable MCP delegation architecture requires an unbroken timeout hierarchy across all layers:

```text
Layer 1: Outer Codex MCP Client Tool Timeout (tool_timeout_sec = 3600)
    ↓
Layer 2: Maximum Bounded MCP Call Lifetime (Useful-Work + Settlement Budget = 2415s)
    ↓
Layer 3: Specialist Useful-Work Execution Deadline (max profile timeout = 1800s)
```

### The three timeout layers

1. **Outer Codex client tool-call deadline (`tool_timeout_sec = 3600`)**:
   Codex's outer timeout envelope controls how long Codex will wait for a `tools/call` response before abandoning the call. By default, Codex terminates tool calls after 300 seconds (5 minutes). Because complex code and security reviews on realistic repositories can run for 10–30 minutes, `install-codex.ps1` explicitly configures `tool_timeout_sec = 3600` (60 minutes) under `[mcp_servers.claude-agents]` in `~/.codex/config.toml`.

2. **Maximum bounded MCP call lifetime (`2415s` = 40.25 minutes)**:
   The total synchronous duration of an MCP tool call comprises Claude's useful-work execution plus a strictly bounded **synchronous settlement budget** of `615s` (10.25 minutes). This settlement budget accounts for every possible post-execution or pre-execution lifecycle phase:
   - Git repository state and common directory inspection (180s)
   - Process identity confirmation (20s)
   - ChangeSet BEFORE collection deadline (180s)
   - Process tree forced termination (5s)
   - Process query termination (5s)
   - Runtime settings housekeeping cleanup (5s)
   - Review binding AFTER collection and hash settlement (190s)
   - Authoritative ReviewReceipt disk publication quiescence (30s)

3. **Specialist useful-work execution deadline (`1800s` = 30 minutes)**:
   The maximum wall-clock time Claude Code is permitted to run for its assigned task. In `src/agent-registry.mjs`, registered profile execution timeouts are:
   - `explore`: 10 minutes (`600_000` ms)
   - `rubber-duck`: 15 minutes (`900_000` ms)
   - `task`: 20 minutes (`1_200_000` ms)
   - `general-purpose`: 30 minutes (`1_800_000` ms)
   - `code-review`: 30 minutes (`1_800_000` ms)
   - `research`: 30 minutes (`1_800_000` ms)
   - `security-review`: 30 minutes (`1_800_000` ms)

### Why the outer client timeout must exceed MCP lifetime

If the outer client deadline is shorter than the MCP execution and settlement lifetime (for instance, the default 300s Codex timeout vs a 536s review):
- The client abandons the tool call and reports an unhandled timeout.
- The specialist may continue running and eventually succeed, durably publishing a valid `ReviewReceipt`.
- The client falsely assumes no receipt exists and may waste quota re-running the review.
- Or if the client disconnects, cancellation signals must be propagated to terminate the child, cleanly release write custody, and cancel the publication fence so that no unquiesced or unauthorized mutation is produced.

To guarantee that client abandonment never occurs during normal execution, `src/timeout-policy.mjs` provides a machine-checked invariant:

$$\text{Outer Client Timeout} \ge \text{Max Profile Timeout} + \text{Settlement Budget}$$
$$3600\text{s} \ge 1800\text{s} + 615\text{s} = 2415\text{s}$$

### Late-receipt discovery and reconciliation (zero Claude delegated quota)

If Codex ever disconnects, restarts, or timed out under an older client timeout during a long review, **the durable `ReviewReceipt` is never lost**. Once the specialist process completes, the receipt and its content-addressed result artifact (`reviews/artifacts/<sha256>.txt`) are atomically committed to durable storage.

Codex Lead can discover, verify, and reconcile that review receipt immediately without spawning a fresh Claude specialist and without consuming Claude delegated quota:

```json
{
  "name": "delegate_agent",
  "arguments": {
    "agent_type": "code-review",
    "task": "Reconcile prior code review receipt",
    "reconcile_only": true,
    "cwd": "<worktreeRoot>"
  }
}
```

> [!NOTE]
> `reconcile_only: true` is the sole explicit signal that activates reconciliation mode. `task` remains ordinary descriptive assignment/context text and never silently selects an execution mode. Non-review profiles reject `reconcile_only`.

#### What `reconcile_only` does and does not do:

1. **Observational read-only check**: Collects the live `ChangeSet` from the repository without acquiring write custody.
2. **Authoritative receipt lookup**: Sweeps the durable review receipt store for the matching repository, target ref, and review profile scope.
3. **Independent binding vs. freshness**:
   - `reviewBinding.status` reflects historical binding: `"bound"` if a receipt is found for the historical scope, `"unavailable"` if no receipt is found or history is indeterminate. (Binding status is never `"stale"`).
   - Freshness is independently evaluated against current live state: `"FRESH"`, `"STALE"`, or `"INDETERMINATE"`.
4. **Content-addressed artifact recovery & verification**:
   - Recovers the original semantic reviewer output from `reviews/artifacts/<sha256>.txt`.
   - Strictly validates both byte length and SHA-256 digest against `receipt.result.bytes` and `receipt.result.sha256`.
   - If the artifact is missing, unreadable, or corrupted, reconciliation **fails closed**: reviewer output is withheld and the result warns that findings cannot be verified.
5. **Zero Claude delegated quota**:
   - Spawns **0 child processes** and consumes **0 Claude delegated-model quota**.
   - Note: Total token consumption depends on the orchestrator; Codex itself may consume model tokens while orchestrating or processing the MCP tool call.

#### Critical Semantic Rule: FRESH != CLEAN

> [!IMPORTANT]
> **`FRESH != CLEAN`**
> - **`FRESH`** means strictly: *"this receipt still applies to the observed current ChangeSet."* A fresh review receipt might contain severe blocking vulnerabilities or critical architectural findings.
> - **`CLEAN`** / passing verdicts come solely from the recovered, verified reviewer output itself. Receipt discovery alone never implies approval.

#### Operator Action on Freshness Verdicts:

- **`FRESH`**: The recovered reviewer findings apply to the current repository state. Review findings are displayed for Lead inspection.
- **`STALE`**: The worktree or repository moved since the review was conducted. The historical receipt remains bound to its historical ChangeSet, but cannot authorize the current worktree. **Operator Action:** A fresh `code-review` delegation is required.
- **`INDETERMINATE`**: Collector uncertainty or history gaps prevent proving freshness. Fails closed (`status: "unavailable"`). **Operator Action:** Manual verification of git state or a fresh `code-review` delegation is required.
