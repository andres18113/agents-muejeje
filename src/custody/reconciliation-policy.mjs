import { PROCESS_IDENTITY_MATCH } from "../process-identity.mjs";
import { DURABLE_TERMINAL_STATES, FORCED_TERMINATION_STATES } from "./record-schema.mjs";

/**
 * What a live coordinator may conclude about a durable record left behind by
 * another coordinator.
 *
 * This is a pure decision: it takes an already-read record plus already-made
 * process comparisons and returns the single action to perform. It touches no
 * filesystem and starts no observation, so the rule that governs whether a
 * repository changes hands can be read, and tested, in one place.
 *
 * The governing principle is that release requires proof, not the absence of
 * contrary evidence. Every path that cannot prove the repository is quiet
 * resolves to ORPHANED and keeps the record blocking.
 */

const RETAIN = "retain";
const ORPHAN = "orphan";
const COMPLETE_TERMINAL_RELEASE = "complete-terminal-release";
const TERMINALIZE_AND_RELEASE = "terminalize-and-release";

export const RECONCILIATION_ACTION = Object.freeze({
  RETAIN,
  ORPHAN,
  COMPLETE_TERMINAL_RELEASE,
  TERMINALIZE_AND_RELEASE
});

function retain(outcome) {
  return Object.freeze({ action: RETAIN, outcome: Object.freeze(outcome) });
}

function orphan(orphanReason, outcome) {
  return Object.freeze({ action: ORPHAN, orphanReason, outcome: Object.freeze(outcome) });
}

function coordinatorIsGone(status) {
  return (
    status !== PROCESS_IDENTITY_MATCH.SAME_PROCESS &&
    status !== PROCESS_IDENTITY_MATCH.AMBIGUOUS
  );
}

export function reconciliationNeedsGitObservation(record, coordinatorStatus) {
  return Boolean(coordinatorIsGone(coordinatorStatus) && record.gitOperation);
}

export function reconciliationNeedsClaudeObservation(record, coordinatorStatus) {
  return Boolean(
    coordinatorIsGone(coordinatorStatus) && !record.gitOperation && record.claudeProcess
  );
}

/**
 * @param record       the durable snapshot being reconciled
 * @param coordinator  comparison status for the recording coordinator
 * @param gitOperation comparison status for a persisted mutating Git operation
 * @param claude       comparison status for the recorded Claude child
 */
export function decideReconciliation({ record, coordinator, gitOperation, claude }) {
  if (coordinator === PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
    return retain({ released: false, reason: "live", coordinator });
  }
  if (coordinator === PROCESS_IDENTITY_MATCH.AMBIGUOUS) {
    return retain({ released: false, reason: "ambiguous", coordinator });
  }

  // The proof these states rest on was written to disk before the crash, so it
  // is still available now. They are the only states a dead coordinator's
  // record may finish releasing from.
  if (DURABLE_TERMINAL_STATES.has(record.state)) {
    return Object.freeze({
      action: COMPLETE_TERMINAL_RELEASE,
      outcome: Object.freeze({ released: true, reason: "terminal-record", coordinator })
    });
  }

  if (record.gitOperation) {
    if (gitOperation === PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
      return orphan("coordinator-dead-git-operation-alive", {
        released: false,
        reason: "live",
        coordinator,
        gitOperation
      });
    }
    if (gitOperation === PROCESS_IDENTITY_MATCH.AMBIGUOUS || !gitOperation) {
      return orphan("git-operation-identity-ambiguous", {
        released: false,
        reason: "ambiguous",
        coordinator,
        gitOperation
      });
    }
    // The Git process is gone, but a mutating worktree-add that was interrupted
    // leaves the repository in a state this coordinator never observed.
    return orphan("git-operation-terminal-preparation-unproven", {
      released: false,
      reason: "preparation-unproven",
      coordinator,
      gitOperation
    });
  }

  if (record.claudeProcess) {
    if (claude === PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
      return orphan("coordinator-dead-claude-alive", {
        released: false,
        reason: "live",
        coordinator,
        claude
      });
    }
    if (claude === PROCESS_IDENTITY_MATCH.AMBIGUOUS || !claude) {
      return orphan("claude-identity-ambiguous", {
        released: false,
        reason: "ambiguous",
        coordinator,
        claude
      });
    }

    // Claude is proven gone - but that is not enough when the dead coordinator
    // had already begun forced termination. Beginning termination is exactly
    // what may have launched a destructive taskkill helper, and that helper's
    // quiescence is knowable, if at all, only through evidence the crashed
    // coordinator left behind. Its memory is gone, and durable helper evidence
    // is spent only by the same live coordinator that wrote it (see
    // reclaimOwnOrphanedWriteAccess), never across coordinators - so no live
    // coordinator concludes quiescence here. A dead target therefore proves
    // the target died, not that the repository is quiet. Fail closed and hand
    // ownership to nobody.
    if (FORCED_TERMINATION_STATES.has(record.state)) {
      return orphan("forced-termination-helper-quiescence-unproven", {
        released: false,
        reason: "forced-termination-unproven",
        coordinator,
        claude
      });
    }

    return Object.freeze({
      action: TERMINALIZE_AND_RELEASE,
      terminalProof: Object.freeze({
        kind: "process-identity-reconciliation",
        coordinator,
        claude
      }),
      outcome: Object.freeze({ released: true, reason: "both-dead", coordinator, claude })
    });
  }

  // RESERVED proves no external child operation has begun. PREPARING may have a
  // live git child, and SPAWNING/ORPHANED may have an unrecorded Claude child,
  // so those states remain blocked without identity proof.
  if (record.state !== "RESERVED") {
    return Object.freeze({
      action: record.state === "ORPHANED" ? RETAIN : ORPHAN,
      orphanReason: "process-identity-not-persisted",
      outcome: Object.freeze({ released: false, reason: "ambiguous", coordinator })
    });
  }
  return Object.freeze({
    action: TERMINALIZE_AND_RELEASE,
    terminalProof: Object.freeze({ kind: "process-identity-reconciliation", coordinator }),
    outcome: Object.freeze({ released: true, reason: "dead-reservation", coordinator })
  });
}
