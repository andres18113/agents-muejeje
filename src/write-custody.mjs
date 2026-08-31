import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PROCESS_IDENTITY_MATCH,
  PROCESS_IDENTITY_STATUS,
  compareProcessIdentity,
  inspectProcessIdentity,
  validateDurableProcessIdentity
} from "./process-identity.mjs";

export const DURABLE_STATE_SCHEMA_VERSION = 1;

const STATE_DIRECTORY_NAME = "claude-agents-mcp";
const STATE_VERSION_DIRECTORY = "state-v1";
const RECORD_FILE_NAME = "record.json";
const OWNERSHIP_DIRECTORY_NAME = "ownership";
const EXECUTIONS_DIRECTORY_NAME = "executions";
const WORKTREES_DIRECTORY_NAME = "worktrees";
const MAX_RECORD_BYTES = 128 * 1024;

const STATES = new Set([
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
const SAFE_UNSTARTED_STATES = new Set(["RESERVED", "PREPARING_WORKTREE", "SPAWNING"]);

const TRANSITIONS = Object.freeze({
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

function validIdentityString(name, value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new WriteCustodyError(name + " must be a non-empty string.");
  }
  return value;
}

function validExecutionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new WriteCustodyError("executionId is invalid.", {
      code: "write_custody_execution_id_invalid"
    });
  }
  return value;
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function accessModeForState(state) {
  return WRITE_STATES.has(state) ? "write" : "none";
}

function durableProcessIdentity(processIdentity) {
  return validateDurableProcessIdentity(processIdentity);
}

function processIdentityMatches(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.source === right.source
  );
}

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
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
  for (const optional of [
    "claudeProcess",
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
    return hasExactKeys(proof, ["event", "kind", "observedAt"]) && ["close", "exit"].includes(proof.event);
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
    if (record.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION) return undefined;
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
    if (record.terminalProof !== undefined && !validateTerminalProof(record.terminalProof)) return undefined;
    if (["TERMINAL_PROVEN", "HANDOFF_READY", "RELEASED"].includes(record.state) && !record.terminalProof) {
      return undefined;
    }
    return Object.freeze(record);
  } catch {
    return undefined;
  }
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function recordSnapshot(record) {
  return Object.freeze(cloneRecord(record));
}

export function repositoryIdForCanonicalRootKey(canonicalRootKey) {
  validIdentityString("canonicalRootKey", canonicalRootKey);
  return createHash("sha256").update(canonicalRootKey, "utf8").digest("hex");
}

export function defaultDurableStateRoot({ env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") {
    const localAppData = Object.entries(env || {}).find(
      ([name, value]) => name.toUpperCase() === "LOCALAPPDATA" && typeof value === "string" && value.length > 0
    )?.[1];
    if (!localAppData) {
      throw new WriteCustodyError("LOCALAPPDATA is required for durable write custody on Windows.", {
        code: "write_custody_state_root_unavailable"
      });
    }
    return path.join(localAppData, STATE_DIRECTORY_NAME, STATE_VERSION_DIRECTORY);
  }
  return path.join(os.homedir(), ".local", "state", STATE_DIRECTORY_NAME, STATE_VERSION_DIRECTORY);
}

function errorIsPathConflict(error) {
  return ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code);
}

function pathIsAtOrWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
}

async function exists(pathname) {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requirePlainDirectory(pathname, description) {
  const details = await lstat(pathname);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new WriteCustodyError(description + " is not a plain directory.", {
      code: "write_custody_state_ambiguous"
    });
  }
}

async function readAuthoritativeRecord(ownershipDirectory) {
  try {
    await requirePlainDirectory(ownershipDirectory, "Durable ownership state");
    const recordPath = path.join(ownershipDirectory, RECORD_FILE_NAME);
    const details = await lstat(recordPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > MAX_RECORD_BYTES) {
      throw new WriteCustodyError("Durable ownership record is not a plain file.", {
        code: "write_custody_state_ambiguous"
      });
    }
    const record = validateDurableOwnershipRecord(JSON.parse(await readFile(recordPath, "utf8")));
    if (!record) throw new Error("invalid ownership schema");
    return record;
  } catch (error) {
    if (error instanceof WriteCustodyError) throw error;
    throw new WriteCustodyError("Durable ownership state is missing or malformed; write admission is blocked.", {
      code: "write_custody_state_ambiguous",
      cause: error
    });
  }
}

async function writeFileDurably(pathname, text) {
  const handle = await open(pathname, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class DurableWriteCustodyManager {
  #stateRoot;
  #inspectProcess;
  #currentPid;
  #now;
  #createNonce;
  #liveIdentities = new Map();

  constructor({
    stateRoot,
    env = process.env,
    platform = process.platform,
    inspectProcess = inspectProcessIdentity,
    currentPid = process.pid,
    now = Date.now,
    createNonce = randomUUID
  } = {}) {
    this.#stateRoot = path.resolve(stateRoot || defaultDurableStateRoot({ env, platform }));
    this.#inspectProcess = inspectProcess;
    this.#currentPid = currentPid;
    this.#now = now;
    this.#createNonce = createNonce;
  }

  get stateRoot() {
    return this.#stateRoot;
  }

  repositoryStateDirectory(canonicalRootKey) {
    return path.join(this.#stateRoot, "repositories", repositoryIdForCanonicalRootKey(canonicalRootKey));
  }

  worktreeRootFor({ canonicalRootKey, executionId }) {
    validExecutionId(executionId);
    return path.join(this.repositoryStateDirectory(canonicalRootKey), WORKTREES_DIRECTORY_NAME, executionId);
  }

  async reserveWriteAccess({ executionId, agentType, canonicalRoot, canonicalRootKey }) {
    const validId = validExecutionId(executionId);
    const validAgentType = validIdentityString("agentType", agentType);
    const validRoot = validIdentityString("canonicalRoot", canonicalRoot);
    const validRootKey = validIdentityString("canonicalRootKey", canonicalRootKey);
    if (pathIsAtOrWithin(validRoot, this.#stateRoot)) {
      throw new WriteCustodyError("Durable custody state must be outside the canonical working tree.", {
        code: "write_custody_state_root_invalid"
      });
    }
    const coordinatorObservation = await this.#inspectProcess(this.#currentPid);
    if (coordinatorObservation?.status !== PROCESS_IDENTITY_STATUS.ALIVE) {
      throw new WriteCustodyError("Coordinator process identity is unavailable; write admission is blocked.", {
        code: "write_custody_process_identity_ambiguous"
      });
    }
    const coordinatorProcess = durableProcessIdentity(coordinatorObservation.identity);
    if (coordinatorProcess.pid !== this.#currentPid) {
      throw new WriteCustodyError("Coordinator process identity does not match the current process.", {
        code: "write_custody_process_identity_ambiguous"
      });
    }

    const repositoryId = repositoryIdForCanonicalRootKey(validRootKey);
    const repositoryState = this.repositoryStateDirectory(validRootKey);
    await mkdir(repositoryState, { recursive: true });
    await mkdir(path.join(repositoryState, EXECUTIONS_DIRECTORY_NAME), { recursive: true });
    await mkdir(path.join(repositoryState, WORKTREES_DIRECTORY_NAME), { recursive: true });
    if (await exists(path.join(repositoryState, EXECUTIONS_DIRECTORY_NAME, validId))) {
      throw new WriteCustodyError("executionId already has durable history for this repository.", {
        code: "write_custody_execution_id_conflict"
      });
    }
    const ownershipDirectory = path.join(repositoryState, OWNERSHIP_DIRECTORY_NAME);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const at = this.#now();
      const record = {
        schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
        executionId: validId,
        agentType: validAgentType,
        canonicalRoot: validRoot,
        canonicalRootKey: validRootKey,
        repositoryId,
        accessMode: "none",
        state: "RESERVED",
        createdAt: at,
        reservedAt: at,
        updatedAt: at,
        coordinatorProcess,
        transitions: [{ state: "RESERVED", at }]
      };
      const temporaryDirectory = path.join(repositoryState, ".ownership-" + this.#createNonce() + ".tmp");
      await mkdir(temporaryDirectory);
      try {
        await writeFileDurably(path.join(temporaryDirectory, RECORD_FILE_NAME), JSON.stringify(record, null, 2) + "\n");
        try {
          await rename(temporaryDirectory, ownershipDirectory);
          return recordSnapshot(record);
        } catch (error) {
          if (!errorIsPathConflict(error)) throw error;
        }
      } finally {
        if (await exists(temporaryDirectory)) await rm(temporaryDirectory, { recursive: true, force: true });
      }

      const reconciliation = await this.reconcileExistingOwnership(validRootKey);
      if (reconciliation.released) continue;
      throw new WriteCustodyError("Write custody is already retained for canonical root '" + validRoot + "'.", {
        code: reconciliation.reason === "ambiguous" ? "write_custody_state_ambiguous" : "write_custody_conflict",
        details: reconciliation
      });
    }

    throw new WriteCustodyError("Write custody admission could not be completed after reconciliation.", {
      code: "write_custody_conflict"
    });
  }

  async beginWorktreePreparation({ executionId, canonicalRootKey, baseCommit, worktreeRoot }) {
    if (typeof baseCommit !== "string" || !/^[0-9a-f]{40,64}$/iu.test(baseCommit)) {
      throw new WriteCustodyError("A valid worktree base commit is required.", {
        code: "write_custody_worktree_metadata_invalid"
      });
    }
    validIdentityString("worktreeRoot", worktreeRoot);
    return await this.#transitionOwned({ executionId, canonicalRootKey }, "PREPARING_WORKTREE", {
      baseCommit,
      worktreeRoot
    });
  }

  async markSpawning({ executionId, canonicalRootKey }) {
    return await this.#transitionOwned({ executionId, canonicalRootKey }, "SPAWNING");
  }

  async activateWriteAccess({ executionId, canonicalRootKey, processIdentity }) {
    const record = await this.#ownedRecord({ executionId, canonicalRootKey });
    if (record.state !== "SPAWNING") {
      throw new WriteCustodyError("Write custody is not in the spawning state.", {
        code: "write_custody_state_invalid"
      });
    }
    this.#validateClaudeIdentity(record, processIdentity);
    this.#liveIdentities.set(record.repositoryId, processIdentity);
    return await this.#transitionRecord(record, "ACTIVE", {
      claudeProcess: durableProcessIdentity(processIdentity)
    });
  }

  async beginTermination({ executionId, canonicalRootKey, processIdentity }) {
    const record = await this.#ownedRecord({ executionId, canonicalRootKey });
    this.#requireLiveIdentity(record, processIdentity);
    if (record.state === "TERMINATING") return recordSnapshot(record);
    if (record.state !== "ACTIVE") {
      throw new WriteCustodyError("Write custody cannot enter termination from its current state.", {
        code: "write_custody_state_invalid"
      });
    }
    return await this.#transitionRecord(record, "TERMINATING");
  }

  async releaseUnstartedWriteAccess({ executionId, canonicalRootKey }) {
    const record = await this.#ownedRecord({ executionId, canonicalRootKey });
    if (!SAFE_UNSTARTED_STATES.has(record.state) || record.claudeProcess) {
      throw new WriteCustodyError(
        "Write custody may be released without child terminal proof only when the runner proved no child started.",
        { code: "write_custody_terminal_proof_required" }
      );
    }
    return await this.#terminalizeAndRelease(record, { kind: "not-started", observedAt: this.#now() });
  }

  async releaseWriteAccessAfterTerminal({ executionId, canonicalRootKey, terminalProof }) {
    const record = await this.#ownedRecord({ executionId, canonicalRootKey });
    if (!["SPAWNING", "ACTIVE", "TERMINATING"].includes(record.state)) {
      throw new WriteCustodyError("Write custody cannot return from its current state.", {
        code: "write_custody_state_invalid"
      });
    }
    if (
      !terminalProof ||
      typeof terminalProof !== "object" ||
      !["close", "exit"].includes(terminalProof.event) ||
      !validTimestamp(terminalProof.observedAt)
    ) {
      throw new WriteCustodyError("A valid terminal proof is required before write custody can return.", {
        code: "write_custody_terminal_proof_missing"
      });
    }
    this.#requireLiveIdentity(record, terminalProof.processIdentity, {
      allowUnpersistedIdentity: record.state === "SPAWNING"
    });
    return await this.#terminalizeAndRelease(record, {
      kind: "child-event",
      event: terminalProof.event,
      observedAt: terminalProof.observedAt
    }, record.claudeProcess
      ? {}
      : { claudeProcess: durableProcessIdentity(terminalProof.processIdentity) });
  }

  async markOrphanedWriteAccess({ executionId, canonicalRootKey, processIdentity, reason }) {
    const record = await this.#ownedRecord({ executionId, canonicalRootKey });
    const validReason = validIdentityString("orphan reason", reason);
    if (record.state === "ORPHANED") return recordSnapshot(record);
    let claudeProcess = record.claudeProcess;
    if (["ACTIVE", "TERMINATING"].includes(record.state)) {
      this.#requireLiveIdentity(record, processIdentity);
    } else if (processIdentity) {
      this.#validateClaudeIdentity(record, processIdentity);
      claudeProcess = durableProcessIdentity(processIdentity);
      this.#liveIdentities.set(record.repositoryId, processIdentity);
    }
    return await this.#transitionRecord(record, "ORPHANED", {
      ...(claudeProcess ? { claudeProcess } : {}),
      orphanReason: validReason
    });
  }

  async getWriteAccess(canonicalRootKey) {
    const ownershipDirectory = path.join(this.repositoryStateDirectory(canonicalRootKey), OWNERSHIP_DIRECTORY_NAME);
    if (!(await exists(ownershipDirectory))) return undefined;
    return recordSnapshot(await readAuthoritativeRecord(ownershipDirectory));
  }

  async reconcileExistingOwnership(canonicalRootKey) {
    const repositoryState = this.repositoryStateDirectory(canonicalRootKey);
    const ownershipDirectory = path.join(repositoryState, OWNERSHIP_DIRECTORY_NAME);
    if (!(await exists(ownershipDirectory))) return Object.freeze({ released: true, reason: "free" });

    const record = await readAuthoritativeRecord(ownershipDirectory);
    if (record.canonicalRootKey !== canonicalRootKey) {
      throw new WriteCustodyError("Durable ownership repository identity is inconsistent.", {
        code: "write_custody_state_ambiguous"
      });
    }
    if (record.state === "RELEASED") {
      const released = await this.#finishRelease(record);
      return Object.freeze({ released: true, reason: "released-record", record: released });
    }

    const coordinator = await compareProcessIdentity(record.coordinatorProcess, {
      inspectProcess: this.#inspectProcess
    });
    if (coordinator.status === PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
      return Object.freeze({ released: false, reason: "live", coordinator: coordinator.status });
    }
    if (coordinator.status === PROCESS_IDENTITY_MATCH.AMBIGUOUS) {
      return Object.freeze({ released: false, reason: "ambiguous", coordinator: coordinator.status });
    }

    if (["TERMINAL_PROVEN", "HANDOFF_READY"].includes(record.state)) {
      const released = await this.#completeTerminalRelease(record);
      return Object.freeze({
        released: true,
        reason: "terminal-record",
        coordinator: coordinator.status,
        record: released
      });
    }

    if (record.claudeProcess) {
      const claude = await compareProcessIdentity(record.claudeProcess, {
        inspectProcess: this.#inspectProcess
      });
      if (claude.status === PROCESS_IDENTITY_MATCH.SAME_PROCESS) {
        await this.#orphanDuringReconciliation(record, "coordinator-dead-claude-alive");
        return Object.freeze({ released: false, reason: "live", coordinator: coordinator.status, claude: claude.status });
      }
      if (claude.status === PROCESS_IDENTITY_MATCH.AMBIGUOUS) {
        await this.#orphanDuringReconciliation(record, "claude-identity-ambiguous");
        return Object.freeze({ released: false, reason: "ambiguous", coordinator: coordinator.status, claude: claude.status });
      }
      const released = await this.#terminalizeAndRelease(record, {
        kind: "process-identity-reconciliation",
        coordinator: coordinator.status,
        claude: claude.status,
        observedAt: this.#now()
      });
      return Object.freeze({
        released: true,
        reason: "both-dead",
        coordinator: coordinator.status,
        claude: claude.status,
        record: released
      });
    }

    // RESERVED proves no external child operation has begun. PREPARING may
    // have a live git child, and SPAWNING/ORPHANED may have an unrecorded
    // Claude child, so those states remain blocked without identity proof.
    if (record.state !== "RESERVED") {
      if (record.state !== "ORPHANED") {
        await this.#orphanDuringReconciliation(record, "process-identity-not-persisted");
      }
      return Object.freeze({ released: false, reason: "ambiguous", coordinator: coordinator.status });
    }

    const released = await this.#terminalizeAndRelease(record, {
      kind: "process-identity-reconciliation",
      coordinator: coordinator.status,
      observedAt: this.#now()
    });
    return Object.freeze({ released: true, reason: "dead-reservation", coordinator: coordinator.status, record: released });
  }

  async #orphanDuringReconciliation(record, reason) {
    if (record.state === "ORPHANED") return recordSnapshot(record);
    return await this.#transitionRecord(record, "ORPHANED", { orphanReason: reason });
  }

  async #terminalizeAndRelease(record, terminalProof, additions = {}) {
    let current = record;
    if (current.state !== "TERMINAL_PROVEN") {
      current = await this.#transitionRecord(current, "TERMINAL_PROVEN", { ...additions, terminalProof });
    }
    return await this.#completeTerminalRelease(current);
  }

  async #completeTerminalRelease(record) {
    let current = record;
    if (current.state === "TERMINAL_PROVEN") {
      current = await this.#transitionRecord(current, "HANDOFF_READY");
    }
    if (current.state === "HANDOFF_READY") {
      current = await this.#transitionRecord(current, "RELEASED");
    }
    if (current.state !== "RELEASED") {
      throw new WriteCustodyError("Terminal ownership cannot be released from its current state.", {
        code: "write_custody_state_invalid"
      });
    }
    this.#liveIdentities.delete(current.repositoryId);
    return await this.#finishRelease(current);
  }

  async #finishRelease(record) {
    const repositoryState = this.repositoryStateDirectory(record.canonicalRootKey);
    const ownershipDirectory = path.join(repositoryState, OWNERSHIP_DIRECTORY_NAME);
    const historyDirectory = path.join(repositoryState, EXECUTIONS_DIRECTORY_NAME, record.executionId);
    await mkdir(path.dirname(historyDirectory), { recursive: true });
    if (await exists(historyDirectory)) {
      if (!(await exists(ownershipDirectory))) {
        const archived = await readAuthoritativeRecord(historyDirectory);
        if (archived.executionId === record.executionId && archived.state === "RELEASED") {
          return recordSnapshot(archived);
        }
      }
      throw new WriteCustodyError("Durable execution history already exists; release is ambiguous.", {
        code: "write_custody_state_ambiguous"
      });
    }
    try {
      await rename(ownershipDirectory, historyDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return recordSnapshot(record);
      throw new WriteCustodyError("Failed to archive released ownership state.", {
        code: "write_custody_release_failed",
        cause: error
      });
    }
    return recordSnapshot(record);
  }

  async #transitionOwned(owner, nextState, additions = {}) {
    return await this.#transitionRecord(await this.#ownedRecord(owner), nextState, additions);
  }

  async #transitionRecord(record, nextState, additions = {}) {
    if (!TRANSITIONS[record.state]?.has(nextState)) {
      throw new WriteCustodyError("Invalid durable custody transition " + record.state + " -> " + nextState + ".", {
        code: "write_custody_state_invalid"
      });
    }
    const at = Math.max(this.#now(), record.updatedAt);
    const next = {
      ...cloneRecord(record),
      ...additions,
      state: nextState,
      accessMode: accessModeForState(nextState),
      updatedAt: at,
      transitions: [...record.transitions, { state: nextState, at }]
    };
    if (!validateDurableOwnershipRecord(next)) {
      throw new WriteCustodyError("Refusing to persist an invalid durable ownership transition.", {
        code: "write_custody_state_invalid"
      });
    }
    await this.#writeRecord(next);
    return recordSnapshot(next);
  }

  async #writeRecord(record) {
    const repositoryState = this.repositoryStateDirectory(record.canonicalRootKey);
    const ownershipDirectory = path.join(repositoryState, OWNERSHIP_DIRECTORY_NAME);
    const current = await readAuthoritativeRecord(ownershipDirectory);
    if (current.executionId !== record.executionId) {
      throw new WriteCustodyError("Only the durable owning execution may update custody.", {
        code: "write_custody_owner_mismatch"
      });
    }
    const temporaryPath = path.join(repositoryState, ".record-" + this.#createNonce() + ".tmp");
    try {
      await writeFileDurably(temporaryPath, JSON.stringify(record, null, 2) + "\n");
      await rename(temporaryPath, path.join(ownershipDirectory, RECORD_FILE_NAME));
    } catch (error) {
      throw new WriteCustodyError("Failed to persist durable ownership state.", {
        code: "write_custody_persist_failed",
        cause: error
      });
    } finally {
      if (await exists(temporaryPath)) await rm(temporaryPath, { force: true });
    }
  }

  async #ownedRecord({ executionId, canonicalRootKey }) {
    const validId = validExecutionId(executionId);
    const validRootKey = validIdentityString("canonicalRootKey", canonicalRootKey);
    const ownershipDirectory = path.join(this.repositoryStateDirectory(validRootKey), OWNERSHIP_DIRECTORY_NAME);
    if (!(await exists(ownershipDirectory))) {
      throw new WriteCustodyError("No durable write custody exists for the requested repository.", {
        code: "write_custody_missing"
      });
    }
    const record = await readAuthoritativeRecord(ownershipDirectory);
    if (record.executionId !== validId || record.canonicalRootKey !== validRootKey) {
      throw new WriteCustodyError("Only the owning execution may change durable write custody.", {
        code: "write_custody_owner_mismatch"
      });
    }
    return record;
  }

  #validateClaudeIdentity(record, processIdentity) {
    const durable = durableProcessIdentity(processIdentity);
    if (
      processIdentity?.executionId !== record.executionId ||
      processIdentity?.agentType !== record.agentType ||
      processIdentity?.canonicalRoot !== record.canonicalRoot ||
      !processIdentity?.child ||
      typeof processIdentity.child !== "object" ||
      !validTimestamp(processIdentity.startedAt) ||
      processIdentity.child.pid !== durable.pid
    ) {
      throw new WriteCustodyError("Claude process identity does not match this durable reservation.", {
        code: "write_custody_process_identity_invalid"
      });
    }
    return durable;
  }

  #requireLiveIdentity(record, processIdentity, { allowUnpersistedIdentity = false } = {}) {
    this.#validateClaudeIdentity(record, processIdentity);
    const liveIdentity = this.#liveIdentities.get(record.repositoryId);
    if (
      liveIdentity !== processIdentity ||
      (!allowUnpersistedIdentity && !processIdentityMatches(record.claudeProcess, processIdentity)) ||
      (record.claudeProcess && !processIdentityMatches(record.claudeProcess, processIdentity))
    ) {
      throw new WriteCustodyError("Only the exact active Claude child may return write custody.", {
        code: "write_custody_process_identity_mismatch"
      });
    }
  }
}

export const WriteCustodyManager = DurableWriteCustodyManager;
export const PROCESS_WRITE_CUSTODY = new DurableWriteCustodyManager();
