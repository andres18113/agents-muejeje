# Handoff: claude-agents-mcp 0.2.1 current state

## Candidate Scope

- `0.2.1` is a candidate version, not a release declaration.
- `delegate_agent` owns one root request context: `{ deadlineAt, abortSignal, now }`.
- The supported maximum useful-work timeout is 30 minutes; the root lifetime is useful work plus the 615-second settlement reserve.
- `reconcile_only` is finite, read-only, and custody-free. It supports optional `review_id: rr1:<sha256>` only in reconciliation mode.

## Evidence Invariants

- Receipt publication order is: validate receipt, persist and verify result artifact, cancellation check, publication marker, immediate `reviews/cs` rename, settlement, then `reviews/sc` housekeeping.
- A result-artifact conflict is idempotent only after exact byte-count and SHA-256 verification of the destination.
- `reviews/sc` is non-evidentiary. Only an authoritative `reviews/cs` sweep can establish complete history; output bounds remain explicit partial results.
- No `review_id` reconciliation selects among multiple FRESH receipts. An exact requested ID must match the current repository/profile/target scope or fails closed.

## Integration Contract

- A reviewed commit may retain its receipt only when the target fast-forwards and target `HEAD` equals the reviewed SHA.
- Cherry-pick, merge, squash, rebase, and conflict resolution create a distinct review subject. Run gates and a new bound review for that target commit before final verdict.

## Validation State

- Required release gates are `npm.cmd run check`, `npm.cmd run check:text`, `npm.cmd test`, `npm.cmd run ci`, `git diff --check`, and `npm.cmd run diagnose`.
- No real Claude invocation, push, tag, or history rewrite is part of this candidate state.
