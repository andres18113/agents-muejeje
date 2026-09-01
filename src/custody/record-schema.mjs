import { createHash } from "node:crypto";
import { PROCESS_IDENTITY_MATCH, validateDurableProcessIdentity } from "../process-identity.mjs";

/**
 * The durable ownership record: its vocabulary, its legal shapes, and the
 * transitions it may make.
 *
 * Everything here is pure. It reads no filesystem and observes no process, so
 * "is this record well formed" can never be confused with "is this record still
 * true". A record that fails validation is rejected rather than repaired:
 * an unrecognized shape is ambiguous, and ambiguity must block admission.
 *
 * Version 1 records predate optimistic publication. They remain readable and
 * are migrated on their next successful durable mutation. New records carry a
 * monotonic revision that is checked again immediately before publication.
 */

export const DURABLE_STATE_SCHEMA_VERSION = 2;
const LEGACY_DURABLE_STATE_SCHEMA_VERSION = 1;

export const STATES = new Set([
  "RESERVED",
  "PREPARING_WORKTREE",
  "SPAWNING",
  "ACTIVE",
  "TERMINATING",
  "ORPHANED",
  "TERMINAL_PROVEN",
  "HANDOFF_READY",
  "RELEASED"
]);

const WRITE_STATES = new Set(["ACTIVE", "TERMINATING", "ORPHANED"]);
export const SAFE_UNSTARTED_STATES = new Set(["RESERVED", "PREPARING_WORKTREE", "SPAWNING"]);

/**
 * States a durable record may already be in when its coordinator dies while a
 * destructive Windows taskkill helper could still be running. The helper's
 * lifecycle is known only in the coordinator's memory, so it does not survive
 * the crash and cannot be re-observed. These records therefore never complete
 * an automatic release during reconciliation, no matter what the recorded
 * Claude identity reports.
 */
export const FORCED_TERMINATION_STATES = new Set(["TERMINATING", "ORPHANED"]);

/**
 * States whose terminal proof is already durable. Only these may finish a
 * release after their coordinator is gone, because the proof they rely on was
 * written to disk before the crash rather than held in memory.
 */
export const DURABLE_TERMINAL_STATES = new Set(["TERMINAL_PROVEN", "HANDOFF_READY"]);

export const TRANSITIONS = Object.freeze({
  RESERVED: new Set(["PREPARING_WORKTREE", "SPAWNING", "ORPHANED", "TERMINAL_PROVEN"]),
  PREPARING_WORKTREE: new Set(["SPAWNING", "ORPHANED", "TERMINAL_PROVEN"]),
  SPAWNING: new Set(["ACTIVE", "ORPHANED", "TERMINAL_PROVEN"]),
  ACTIVE: new Set(["TERMINATING", "ORPHANED", "TERMINAL_PROVEN"]),
  TERMINATING: new Set(["ORPHANED", "TERMINAL_PROVEN"]),
  ORPHANED: new Set(["TERMINAL_PROVEN"]),
  TERMINAL_PROVEN: new Set(["HANDOFF_READY"]),
  HANDOFF_READY: new Set(["RELEASED"]),
  RELEASED: new Set()
});

export class WriteCustodyError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WriteCustodyError";
    this.code = options.code || "write_custody_invalid";
    this.details = options.details;
  }
}

export function validIdentityString(name, value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new WriteCustodyError(name + " must be a non-empty string.");
  }
  return value;
}

export function validExecutionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new WriteCustodyError("executionId is invalid.", {
      code: "write_custody_execution_id_invalid"
    });
  }
  return value;
}

export function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function accessModeForState(state) {
  return WRITE_STATES.has(state) ? "write" : "none";
}

export function durableProcessIdentity(processIdentity) {
  return validateDurableProcessIdentity(processIdentity);
}

export function processIdentityMatches(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.source === right.source
  );
}

export function repositoryIdForCanonicalRootKey(canonicalRootKey) {
  validIdentityString("canonicalRootKey", canonicalRootKey);
  return createHash("sha256").update(canonicalRootKey, "utf8").digest("hex");
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const SUPERVISED_GIT_OPERATIONS = new Set(["worktree-add"]);

/**
 * A mutating Git operation this coordinator supervised. Persisting its durable
 * PID+StartTime identity lets a later coordinator tell "Git is still running"
 * apart from "Git is gone" after a crash during worktree preparation.
 */
export function validatePersistedGitOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return false;
  if (!hasExactKeys(operation, ["kind", "pid", "source", "startTime"])) return false;
  if (!SUPERVISED_GIT_OPERATIONS.has(operation.kind)) return false;
  durableProcessIdentity(operation);
  return true;
}

function validatePersistedProcessIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  if (!hasExactKeys(identity, ["pid", "source", "startTime"])) return false;
  durableProcessIdentity(identity);
  return true;
}

function expectedRecordKeys(record) {
  const keys = [
    "schemaVersion",
    "executionId",
    "agentType",
    "canonicalRoot",
    "canonicalRootKey",
    "repositoryId",
    "accessMode",
    "state",
    "createdAt",
    "reservedAt",
    "updatedAt",
    "coordinatorProcess",
    "transitions"
  ];
  if (record?.schemaVersion === DURABLE_STATE_SCHEMA_VERSION) keys.push("revision");
  for (const optional of [
    "claudeProcess",
    "gitOperation",
    "worktreeRoot",
    "baseCommit",
    "orphanReason",
    "terminalProof"
  ]) {
    if (Object.hasOwn(record, optional)) keys.push(optional);
  }
  return keys.sort();
}

function validateTransitionHistory(transitions, state) {
  if (!Array.isArray(transitions) || transitions.length === 0) return false;
  let previous;
  let previousAt;
  for (const transition of transitions) {
    if (
      !transition ||
      typeof transition !== "object" ||
      Object.keys(transition).sort().join(",") !== "at,state" ||
      !STATES.has(transition.state) ||
      !validTimestamp(transition.at)
    ) {
      return false;
    }
    if (previous && !TRANSITIONS[previous]?.has(transition.state)) return false;
    if (previousAt !== undefined && transition.at < previousAt) return false;
    previous = transition.state;
    previousAt = transition.at;
  }
  return previous === state && transitions[0].state === "RESERVED";
}

function validateTerminalProof(proof) {
  if (!proof || typeof proof !== "object" || typeof proof.kind !== "string") return false;
  if (!validTimestamp(proof.observedAt)) return false;
  if (proof.kind === "child-event") {
    // Only `close` proves the exact child and its stdio ended. `exit` alone
    // leaves stdio open, which is exactly the case where a descendant still
    // holds the pipes, so it is never accepted as custody proof.
    return hasExactKeys(proof, ["event", "kind", "observedAt"]) && proof.event === "close";
  }
  if (proof.kind === "supervised-child-close") {
    return hasExactKeys(proof, ["event", "kind", "observedAt"]) && proof.event === "close";
  }
  if (proof.kind === "not-started") {
    return hasExactKeys(proof, ["kind", "observedAt"]);
  }
  if (proof.kind === "process-identity-reconciliation") {
    return (
      hasExactKeys(
        proof,
        proof.claude === undefined
          ? ["coordinator", "kind", "observedAt"]
          : ["claude", "coordinator", "kind", "observedAt"]
      ) &&
      [PROCESS_IDENTITY_MATCH.DEAD, PROCESS_IDENTITY_MATCH.PID_REUSED].includes(proof.coordinator) &&
      (proof.claude === undefined ||
        [PROCESS_IDENTITY_MATCH.DEAD, PROCESS_IDENTITY_MATCH.PID_REUSED].includes(proof.claude))
    );
  }
  return false;
}

export function validateDurableOwnershipRecord(record) {
  try {
    if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
    if (Object.keys(record).sort().join(",") !== expectedRecordKeys(record).join(",")) return undefined;
    if (
      record.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION &&
      record.schemaVersion !== LEGACY_DURABLE_STATE_SCHEMA_VERSION
    ) return undefined;
    if (
      record.schemaVersion === DURABLE_STATE_SCHEMA_VERSION &&
      (!Number.isSafeInteger(record.revision) || record.revision < 0)
    ) return undefined;
    validExecutionId(record.executionId);
    validIdentityString("agentType", record.agentType);
    validIdentityString("canonicalRoot", record.canonicalRoot);
    validIdentityString("canonicalRootKey", record.canonicalRootKey);
    if (
      !/^[0-9a-f]{64}$/u.test(record.repositoryId) ||
      record.repositoryId !== repositoryIdForCanonicalRootKey(record.canonicalRootKey)
    ) {
      return undefined;
    }
    if (!STATES.has(record.state) || record.accessMode !== accessModeForState(record.state)) return undefined;
    if (
      !validTimestamp(record.createdAt) ||
      !validTimestamp(record.reservedAt) ||
      !validTimestamp(record.updatedAt) ||
      record.createdAt > record.reservedAt ||
      record.reservedAt > record.updatedAt
    ) {
      return undefined;
    }
    if (!validatePersistedProcessIdentity(record.coordinatorProcess)) return undefined;
    if (!validateTransitionHistory(record.transitions, record.state)) return undefined;
    if (record.transitions[0].at !== record.reservedAt) return undefined;
    if (record.transitions.at(-1).at !== record.updatedAt) return undefined;
    if (record.claudeProcess && !validatePersistedProcessIdentity(record.claudeProcess)) return undefined;
    if (["ACTIVE", "TERMINATING"].includes(record.state) && !record.claudeProcess) return undefined;
    if (record.worktreeRoot !== undefined) validIdentityString("worktreeRoot", record.worktreeRoot);
    if (record.baseCommit !== undefined && !/^[0-9a-f]{40,64}$/iu.test(record.baseCommit)) return undefined;
    if ((record.worktreeRoot === undefined) !== (record.baseCommit === undefined)) return undefined;
    if (record.orphanReason !== undefined) validIdentityString("orphanReason", record.orphanReason);
    if (record.state === "ORPHANED" && !record.orphanReason) return undefined;
    if (record.gitOperation !== undefined && !validatePersistedGitOperation(record.gitOperation)) return undefined;
    if (record.terminalProof !== undefined && !validateTerminalProof(record.terminalProof)) return undefined;
    if (["TERMINAL_PROVEN", "HANDOFF_READY", "RELEASED"].includes(record.state) && !record.terminalProof) {
      return undefined;
    }
    return Object.freeze(record);
  } catch {
    return undefined;
  }
}

export function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

export function recordSnapshot(record) {
  return Object.freeze(cloneRecord(record));
}

/**
 * Phase 5.2 records did not have a publication revision. They are valid only
 * in their exact old shape and become revision 0 in memory; the first guarded
 * write upgrades them to schema 2. Unknown shapes remain ambiguous and block
 * admission rather than being guessed at.
 */
export function normalizeOwnershipRecord(record) {
  const validated = validateDurableOwnershipRecord(record);
  if (!validated) return undefined;
  if (validated.schemaVersion === DURABLE_STATE_SCHEMA_VERSION) return validated;
  return Object.freeze({
    ...cloneRecord(validated),
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    revision: 0
  });
}

/**
 * The compare half of every checked publication. A mutation may publish only
 * onto exactly the record revision, state and history it read; anything else
 * means another writer moved the record first.
 */
export function samePublicationAuthority(current, expected) {
  return Boolean(
    current &&
    expected &&
    current.executionId === expected.executionId &&
    current.revision === expected.revision &&
    current.state === expected.state &&
    current.updatedAt === expected.updatedAt &&
    JSON.stringify(current.transitions) === JSON.stringify(expected.transitions)
  );
}
