# Handoff: claude-agents-mcp 0.2.1 current state

## Candidate Scope

- `0.2.1` is a candidate version, not a release declaration.
- `delegate_agent` owns one root request context: `{ deadlineAt, abortSignal, now }`.
- The supported maximum useful-work timeout is 30 minutes; the root MCP response envelope is useful work plus the 615-second settlement reserve. It bounds response settlement, not preemption of already-issued kernel I/O or escaped process trees.
- `reconcile_only` is finite, read-only, and custody-free. It supports optional `review_id: rr1:<sha256>` only in reconciliation mode.

## Evidence Invariants

- Receipt publication order is: validate receipt, persist and verify result artifact, cancellation check, publication marker, immediate `reviews/cs` rename, settlement, then `reviews/sc` housekeeping.
- A result-artifact conflict is idempotent only after exact byte-count and SHA-256 verification of the destination.
- `reviews/sc` is non-evidentiary. Only an authoritative `reviews/cs` sweep can establish complete history; `authoritativeExhaustive` and `outputTruncated` separately report scan completeness and caller output bounds.
- No `review_id` reconciliation selects among multiple FRESH receipts; it returns structured reason `multiple_fresh_reviews`. An exact requested ID must match the current repository/profile/target scope or fails closed.
- After root cancellation, no new custody release or detached late-release mutation starts; unresolved custody remains for ordinary reconciliation.
- The rename that creates `ownership/` is a publication like any other: it holds the repository mutation queue until it settles, and a cancellation racing it yields retained or unproven custody, never `not-acquired`.

## Integration Contract

- A reviewed commit may retain its receipt only when the target fast-forwards and target `HEAD` equals the reviewed SHA.
- Cherry-pick, merge, squash, rebase, and conflict resolution create a distinct review subject. Run gates and a new bound review for that target commit before final verdict.

## Validation State

- Required release gates are `npm.cmd run check`, `npm.cmd run check:text`, `npm.cmd test`, `npm.cmd run ci`, `git diff --check`, and `npm.cmd run diagnose`.
- No real Claude invocation, push, tag, or history rewrite is part of this candidate state.
