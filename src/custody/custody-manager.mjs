import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  PROCESS_IDENTITY_STATUS,
  compareProcessIdentity,
  inspectProcessIdentity
} from "../process-identity.mjs";
import {
  archiveOwnership,
  cancelledMutationError,
  createOwnershipReservation,
  defaultDurableStateRoot,
  ensureRepositoryLayout,
  executionHistoryExists,
  exists,
  mutationWasCancelled,
  ownershipDirectoryIn,
  pathIsAtOrWithin,
  publishRecord,
  readAuthoritativeRecord,
  readOwnershipSnapshot,
  repositoryStateDirectoryIn,
  worktreeDirectoryIn
} from "./durable-store.mjs";
import {
  DURABLE_STATE_SCHEMA_VERSION,
  SAFE_UNSTARTED_STATES,
  TRANSITIONS,
  WriteCustodyError,
  CUSTODY_KINDS,
  accessModeForState,
  custodyKindOf,
  cloneRecord,
  durableProcessIdentity,
  processIdentityMatches,
  recordSnapshot,
  repositoryIdForCanonicalRootKey,
  samePublicationAuthority,
  validExecutionId,
  validIdentityString,
  validTimestamp,
  validatePersistedGitOperation,
  validateDurableOwnershipRecord
} from "./record-schema.mjs";
import { validateFullyQualifiedRef } from "../git-ref-name.mjs";
import {
  RECONCILIATION_ACTION,
  decideReconciliation,
  reconciliationNeedsClaudeObservation,
  reconciliationNeedsGitObservation
} from "./reconciliation-policy.mjs";

/**
 * The custody state machine for one live coordinator.
 *
 * This class orchestrates: it decides which transition an operation may make,
 * serializes a repository's mutations against itself, and holds the in-memory
 * evidence that only this coordinator process can legitimately act on. It
 * delegates the record's legal shapes to record-schema, its persistence to
 * durable-store, and the crash-reconciliation rule to reconciliation-policy.
 *
 * Two kinds of evidence are deliberately kept apart. Durable evidence
 * (PID + StartTime written to the record) survives a restart and can be checked
 * by any later coordinator. Live evidence (#liveIdentities, #supervisedSpawns)
 * is in-memory only: it lets this coordinator terminalize a child it actually
 * spawned and watched, and it vanishes on restart, which is exactly why a
 * restarted coordinator stays fail-closed instead of inheriting a claim.
 */
export class DurableWriteCustodyManager {
  #stateRoot;
  #inspectProcess;
  #currentPid;
  #now;
  #createNonce;
  #beforePublish;
  #afterPublicationIssued;
  // Each manager represents one live coordinator. A repository's authoritative
  // read/validate/publish/archive transaction is serialized here, but external
  // process observation is deliberately performed before entering this queue.
  #mutationTails = new Map();
  #liveIdentities = new Map();
  // Executions whose Claude child this live coordinator spawned. Purely
  // in-memory: after a restart it is empty, so a SPAWNING record without a
  // durable child identity stays fail-closed exactly as before.
  #supervisedSpawns = new Map();

  constructor({
    stateRoot,
    env = process.env,
    platform = process.platform,
    inspectProcess = inspectProcessIdentity,
    currentPid = process.pid,
    now = Date.now,
    createNonce = randomUUID,
    // Test seam for pausing immediately before the final fresh CAS read. It is
    // intentionally absent from normal production construction.
    beforePublish,
    // Test seam for observing a rename that has already been issued but has
    // not yet settled. It verifies post-boundary cancellation keeps the
    // repository mutation queue occupied until actual quiescence.
    afterPublicationIssued
  } = {}) {
    this.#stateRoot = path.resolve(stateRoot || defaultDurableStateRoot({ env, platform }));
    this.#inspectProcess = inspectProcess;
    this.#currentPid = currentPid;
    this.#now = now;
    this.#createNonce = createNonce;
    this.#beforePublish = beforePublish;
    this.#afterPublicationIssued = afterPublicationIssued;
  }

  get stateRoot() {
    return this.#stateRoot;
  }

  repositoryStateDirectory(canonicalRootKey) {
    return repositoryStateDirectoryIn(this.#stateRoot, canonicalRootKey);
  }

  worktreeRootFor({ canonicalRootKey, executionId }) {
    validExecutionId(executionId);
    return worktreeDirectoryIn(this.repositoryStateDirectory(canonicalRootKey), executionId);
  }

  /**
   * Claims the one ownership slot for this repository.
   *
   * custodyKind names why the slot is being held. Both kinds contend on exactly
   * the same rename, so a coherent review excludes managed writers by the same
   * mechanism that makes writers exclude each other - there is no second lock
   * and therefore no acquisition order to get wrong.
   *
   * A write reservation omits the field entirely rather than writing "write",
   * so its on-disk record stays byte-identical to what Phase 5 produced.
   */
  async reserveWriteAccess({
    executionId,
    agentType,
    canonicalRoot,
    canonicalRootKey,
    custodyKind = CUSTODY_KINDS.WRITE,
    targetRef
  }) {
    const validId = validExecutionId(executionId);
    const validAgentType = validIdentityString("agentType", agentType);
    const validRoot = validIdentityString("canonicalRoot", canonicalRoot);
    const validRootKey = validIdentityString("canonicalRootKey", canonicalRootKey);
    if (custodyKind !== CUSTODY_KINDS.WRITE && custodyKind !== CUSTODY_KINDS.COHERENT_REVIEW) {
      throw new WriteCustodyError("Durable custody kind is invalid.", {
        code: "write_custody_kind_invalid"
      });
    }
    if (targetRef !== undefined) validateFullyQualifiedRef(targetRef);
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

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const reserved = await this.#withRepositoryMutation(validRootKey, async () => {
        const repositoryState = this.repositoryStateDirectory(validRootKey);
        await ensureRepositoryLayout(repositoryState);
        if (await executionHistoryExists(repositoryState, validId)) {
          throw new WriteCustodyError("executionId already has durable history for this repository.", {
            code: "write_custody_execution_id_conflict"
          });
        }

        const at = this.#now();
        const record = {
          schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
          revision: 0,
          executionId: validId,
          agentType: validAgentType,
          canonicalRoot: validRoot,
          canonicalRootKey: validRootKey,
          repositoryId: repositoryIdForCanonicalRootKey(validRootKey),
          accessMode: "none",
          state: "RESERVED",
          createdAt: at,
          reservedAt: at,
          updatedAt: at,
          coordinatorProcess,
          transitions: [{ state: "RESERVED", at }],
          ...(custodyKind === CUSTODY_KINDS.WRITE ? {} : { custodyKind }),
          ...(targetRef === undefined ? {} : { targetRef })
        };
        const created = await createOwnershipReservation({
          repositoryState,
          record,
          createNonce: this.#createNonce
        });
        return created ? recordSnapshot(record) : undefined;
      });
      if (reserved) return reserved;

      const reconciliation = await this.reconcileExistingOwnership(validRootKey);
      if (reconciliation.released || reconciliation.reason === "changed") continue;
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
    return await this.#withRepositoryMutation(canonicalRootKey, async () =>
      await this.#transitionOwned({ executionId, canonicalRootKey }, "PREPARING_WORKTREE", {
        baseCommit,
        worktreeRoot
      })
    );
  }

  /**
   * Persists the durable identity of the exact Git process performing a
   * mutating worktree operation. Written only after that process was spawned
   * and its PID+StartTime were established, so a coordinator crash mid-
   * preparation can be reconciled by identity instead of by guessing.
   */
  async recordWorktreeOperation({ executionId, canonicalRootKey, gitOperation }) {
    if (!validatePersistedGitOperation(gitOperation)) {
      throw new WriteCustodyError("A valid supervised Git operation identity is required.", {
        code: "write_custody_git_operation_invalid"
      });
    }
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (record.state !== "PREPARING_WORKTREE") {
        throw new WriteCustodyError("A Git worktree operation may only be recorded while preparing.", {
          code: "write_custody_state_invalid"
        });
      }
      return await this.#amendRecord(record, {
        gitOperation: {
          kind: gitOperation.kind,
          pid: gitOperation.pid,
          startTime: gitOperation.startTime,
          source: gitOperation.source
        }
      });
    });
  }

  /**
   * Clears the recorded Git operation. The caller must already hold supervised
   * terminal proof (the exact Git child closed); a timeout is never enough.
   */
  async clearWorktreeOperation({ executionId, canonicalRootKey }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (!record.gitOperation) return recordSnapshot(record);
      return await this.#amendRecord(record, { gitOperation: undefined });
    });
  }

  async markSpawning({ executionId, canonicalRootKey }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#transitionOwned({ executionId, canonicalRootKey }, "SPAWNING");
      this.#supervisedSpawns.set(record.repositoryId, record.executionId);
      return record;
    });
  }

  async activateWriteAccess({ executionId, canonicalRootKey, processIdentity, mutationSignal }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async ({ publicationGuard }) => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (record.state !== "SPAWNING") {
        throw new WriteCustodyError("Write custody is not in the spawning state.", {
          code: "write_custody_state_invalid"
        });
      }
      this.#validateClaudeIdentity(record, processIdentity);
      // Retain exact in-memory evidence even if publication is later cancelled.
      // It can then safely terminalize the same coordinator's SPAWNING record
      // after an exact close, but never creates a durable identity by itself.
      this.#liveIdentities.set(record.repositoryId, processIdentity);
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      return await this.#transitionRecord(record, "ACTIVE", {
        claudeProcess: durableProcessIdentity(processIdentity)
      }, { mutationSignal, publicationGuard });
    }, { mutationSignal });
  }

  async beginTermination({ executionId, canonicalRootKey, processIdentity, mutationSignal }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async ({ publicationGuard }) => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      this.#requireLiveIdentity(record, processIdentity);
      if (record.state === "TERMINATING") return recordSnapshot(record);
      if (record.state !== "ACTIVE") {
        throw new WriteCustodyError("Write custody cannot enter termination from its current state.", {
          code: "write_custody_state_invalid"
        });
      }
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      return await this.#transitionRecord(record, "TERMINATING", {}, { mutationSignal, publicationGuard });
    }, { mutationSignal });
  }

  async releaseUnstartedWriteAccess({ executionId, canonicalRootKey }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (!SAFE_UNSTARTED_STATES.has(record.state) || record.claudeProcess) {
        throw new WriteCustodyError(
          "Write custody may be released without child terminal proof only when the runner proved no child started.",
          { code: "write_custody_terminal_proof_required" }
        );
      }
      return await this.#terminalizeAndRelease(record, { kind: "not-started", observedAt: this.#now() });
    });
  }

  async releaseWriteAccessAfterTerminal({ executionId, canonicalRootKey, terminalProof }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (!["SPAWNING", "ACTIVE", "TERMINATING"].includes(record.state)) {
        throw new WriteCustodyError("Write custody cannot return from its current state.", {
          code: "write_custody_state_invalid"
        });
      }
      this.#validateCloseTerminalProof(terminalProof);
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
    });
  }

  /**
   * Releases custody for a Claude child that died before its durable
   * PID+StartTime identity could be captured.
   *
   * This is admissible only because the very same live coordinator both
   * spawned the exact ChildProcess and observed its `close`. That evidence is
   * in-memory (#supervisedSpawns) and cannot survive a restart, so a SPAWNING
   * record whose child was never durably identified still fails closed for any
   * other or later coordinator. No fake durable identity is ever fabricated or
   * persisted.
   */
  async releaseWriteAccessAfterSupervisedClose({ executionId, canonicalRootKey, terminalProof }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (record.state !== "SPAWNING") {
        throw new WriteCustodyError(
          "A supervised close may only terminalize a spawning reservation.",
          { code: "write_custody_state_invalid" }
        );
      }
      if (record.claudeProcess) {
        throw new WriteCustodyError(
          "A durable Claude identity exists; terminal proof must be identity-bound.",
          { code: "write_custody_terminal_proof_required" }
        );
      }
      this.#requireSupervisedCloseAuthority(record, terminalProof);
      return await this.#terminalizeAndRelease(record, {
        kind: "supervised-child-close",
        event: "close",
        observedAt: terminalProof.observedAt
      });
    });
  }

  /**
   * A termination deadline can expire before close arrives. If this same live
   * coordinator later observes close for its exact child, it may recover only
   * its own ORPHANED record. Restarted or foreign coordinators have no matching
   * in-memory identity/supervision evidence and remain fail-closed.
   */
  async releaseOrphanedWriteAccessAfterTerminal({ executionId, canonicalRootKey, terminalProof }) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
      if (record.state !== "ORPHANED") {
        throw new WriteCustodyError("Late terminal proof may only recover an orphaned execution.", {
          code: "write_custody_state_invalid"
        });
      }
      this.#requireSameCoordinator(record);
      if (terminalProof?.supervisedByCoordinator === true) {
        if (record.claudeProcess) {
          throw new WriteCustodyError("Identity-bound orphan recovery requires identity-bound proof.", {
            code: "write_custody_terminal_proof_required"
          });
        }
        this.#requireSupervisedCloseAuthority(record, terminalProof);
        return await this.#terminalizeAndRelease(record, {
          kind: "supervised-child-close",
          event: "close",
          observedAt: terminalProof.observedAt
        });
      }
      this.#validateCloseTerminalProof(terminalProof);
      this.#requireLiveIdentity(record, terminalProof.processIdentity);
      return await this.#terminalizeAndRelease(record, {
        kind: "child-event",
        event: "close",
        observedAt: terminalProof.observedAt
      });
    });
  }

  async markOrphanedWriteAccess({ executionId, canonicalRootKey, processIdentity, reason }) {
    const validReason = validIdentityString("orphan reason", reason);
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const record = await this.#ownedRecord({ executionId, canonicalRootKey });
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
    });
  }

  async getWriteAccess(canonicalRootKey) {
    return await this.#withRepositoryMutation(canonicalRootKey, async () => {
      const ownershipDirectory = ownershipDirectoryIn(this.repositoryStateDirectory(canonicalRootKey));
      if (!(await exists(ownershipDirectory))) return undefined;
      return recordSnapshot(await readAuthoritativeRecord(ownershipDirectory));
    });
  }

  /**
   * Decides what to do about a record left behind by another coordinator.
   *
   * Process observation is read-only and may be slow, so it happens outside the
   * short authoritative transaction. The snapshot it was based on is revalidated
   * by publication authority immediately before any resulting state change, so a
   * conclusion drawn from stale evidence can never publish.
   */
  async reconcileExistingOwnership(canonicalRootKey) {
    const validRootKey = validIdentityString("canonicalRootKey", canonicalRootKey);
    const snapshot = await this.#withRepositoryMutation(validRootKey, async () =>
      await this.#ownershipSnapshot(validRootKey)
    );
    if (!snapshot) return Object.freeze({ released: true, reason: "free" });
    if (snapshot.state === "RELEASED") {
      return await this.#withRepositoryMutation(validRootKey, async () => {
        const current = await this.#ownedRecord({ executionId: snapshot.executionId, canonicalRootKey: validRootKey });
        if (!samePublicationAuthority(current, snapshot)) {
          return Object.freeze({ released: false, reason: "changed" });
        }
        const released = await this.#archive(current);
        return Object.freeze({ released: true, reason: "released-record", record: released });
      });
    }

    const coordinator = await compareProcessIdentity(snapshot.coordinatorProcess, {
      inspectProcess: this.#inspectProcess
    });
    let gitOperation;
    let claude;
    if (reconciliationNeedsGitObservation(snapshot, coordinator.status)) {
      gitOperation = await compareProcessIdentity(snapshot.gitOperation, {
        inspectProcess: this.#inspectProcess
      });
    }
    if (reconciliationNeedsClaudeObservation(snapshot, coordinator.status)) {
      claude = await compareProcessIdentity(snapshot.claudeProcess, {
        inspectProcess: this.#inspectProcess
      });
    }

    return await this.#withRepositoryMutation(validRootKey, async () => {
      const current = await this.#ownershipSnapshot(validRootKey);
      if (!current) return Object.freeze({ released: true, reason: "free" });
      if (!samePublicationAuthority(current, snapshot)) {
        return Object.freeze({ released: false, reason: "changed" });
      }
      return await this.#applyReconciliation(current, decideReconciliation({
        record: current,
        coordinator: coordinator.status,
        gitOperation: gitOperation?.status,
        claude: claude?.status
      }));
    });
  }

  async #applyReconciliation(record, decision) {
    if (decision.action === RECONCILIATION_ACTION.RETAIN) return decision.outcome;
    if (decision.action === RECONCILIATION_ACTION.ORPHAN) {
      await this.#orphanDuringReconciliation(record, decision.orphanReason);
      return decision.outcome;
    }
    if (decision.action === RECONCILIATION_ACTION.COMPLETE_TERMINAL_RELEASE) {
      const released = await this.#completeTerminalRelease(record);
      return Object.freeze({ ...decision.outcome, record: released });
    }
    const released = await this.#terminalizeAndRelease(record, {
      ...decision.terminalProof,
      observedAt: this.#now()
    });
    return Object.freeze({ ...decision.outcome, record: released });
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
    const released = await this.#archive(current);
    this.#liveIdentities.delete(current.repositoryId);
    this.#supervisedSpawns.delete(current.repositoryId);
    return released;
  }

  async #archive(record) {
    return await archiveOwnership({
      repositoryState: this.repositoryStateDirectory(record.canonicalRootKey),
      record
    });
  }

  async #transitionOwned(owner, nextState, additions = {}, options = {}) {
    return await this.#transitionRecord(await this.#ownedRecord(owner), nextState, additions, options);
  }

  /**
   * Updates fields on the owned record without a state transition. Used for
   * supervised-operation bookkeeping that must not advance the lifecycle.
   */
  async #amendRecord(record, additions, { mutationSignal, publicationGuard } = {}) {
    // updatedAt is pinned to the last state transition by the durable schema,
    // and an amendment is not a transition, so it is deliberately unchanged.
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    const next = { ...cloneRecord(record), revision: record.revision + 1 };
    for (const [key, value] of Object.entries(additions)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    if (!validateDurableOwnershipRecord(next)) {
      throw new WriteCustodyError("Refusing to persist an invalid durable ownership amendment.", {
        code: "write_custody_state_invalid"
      });
    }
    await this.#publish(next, record, { mutationSignal, publicationGuard });
    return recordSnapshot(next);
  }

  async #transitionRecord(record, nextState, additions = {}, { mutationSignal, publicationGuard } = {}) {
    if (!TRANSITIONS[record.state]?.has(nextState)) {
      throw new WriteCustodyError("Invalid durable custody transition " + record.state + " -> " + nextState + ".", {
        code: "write_custody_state_invalid"
      });
    }
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    const at = Math.max(this.#now(), record.updatedAt);
    const next = {
      ...cloneRecord(record),
      ...additions,
      revision: record.revision + 1,
      state: nextState,
      accessMode: accessModeForState(nextState, custodyKindOf(record)),
      updatedAt: at,
      transitions: [...record.transitions, { state: nextState, at }]
    };
    if (!validateDurableOwnershipRecord(next)) {
      throw new WriteCustodyError("Refusing to persist an invalid durable ownership transition.", {
        code: "write_custody_state_invalid"
      });
    }
    await this.#publish(next, record, { mutationSignal, publicationGuard });
    return recordSnapshot(next);
  }

  async #publish(record, expectedRecord, { mutationSignal, publicationGuard } = {}) {
    await publishRecord({
      repositoryState: this.repositoryStateDirectory(record.canonicalRootKey),
      record,
      expectedRecord,
      createNonce: this.#createNonce,
      beforePublish: this.#beforePublish,
      afterPublicationIssued: this.#afterPublicationIssued,
      mutationSignal,
      publicationGuard
    });
  }

  async #ownedRecord({ executionId, canonicalRootKey }) {
    const validId = validExecutionId(executionId);
    const validRootKey = validIdentityString("canonicalRootKey", canonicalRootKey);
    const ownershipDirectory = ownershipDirectoryIn(this.repositoryStateDirectory(validRootKey));
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

  async #ownershipSnapshot(canonicalRootKey) {
    return await readOwnershipSnapshot(
      this.repositoryStateDirectory(canonicalRootKey),
      canonicalRootKey
    );
  }

  async #withRepositoryMutation(canonicalRootKey, operation, { mutationSignal } = {}) {
    const validRootKey = validIdentityString("canonicalRootKey", canonicalRootKey);
    const repositoryId = repositoryIdForCanonicalRootKey(validRootKey);
    const predecessor = this.#mutationTails.get(repositoryId) || Promise.resolve();
    let releaseTurn;
    const turn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const tail = predecessor.catch(() => {}).then(() => turn);
    this.#mutationTails.set(repositoryId, tail);
    // A cancelled lifecycle write can safely stop occupying the in-memory
    // transaction queue only until it has issued its final rename. Every
    // publication path checks the signal before that point, so it can no
    // longer overwrite terminal release or a later owner. Once rename starts,
    // actual quiescence still requires awaiting its result.
    const publicationGuard = { publicationStarted: false };
    let queueReleased = false;
    const releaseQueue = () => {
      if (queueReleased) return;
      queueReleased = true;
      releaseTurn();
      if (this.#mutationTails.get(repositoryId) === tail) this.#mutationTails.delete(repositoryId);
    };
    const releaseCancelledPrepublicationTurn = () => {
      if (!publicationGuard.publicationStarted) releaseQueue();
    };
    mutationSignal?.addEventListener?.("abort", releaseCancelledPrepublicationTurn, { once: true });
    if (mutationWasCancelled(mutationSignal)) releaseCancelledPrepublicationTurn();
    try {
      await predecessor.catch(() => {});
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      return await operation({ publicationGuard });
    } finally {
      mutationSignal?.removeEventListener?.("abort", releaseCancelledPrepublicationTurn);
      releaseQueue();
    }
  }

  #validateCloseTerminalProof(terminalProof) {
    if (
      !terminalProof ||
      typeof terminalProof !== "object" ||
      terminalProof.event !== "close" ||
      !validTimestamp(terminalProof.observedAt)
    ) {
      throw new WriteCustodyError(
        "Write custody returns only on a close event for the exact Claude child; an exit event is not proof.",
        { code: "write_custody_terminal_proof_missing" }
      );
    }
  }

  #requireSameCoordinator(record) {
    if (record.coordinatorProcess?.pid !== this.#currentPid) {
      throw new WriteCustodyError(
        "Only the coordinator that reserved the record may use live supervised evidence.",
        { code: "write_custody_terminal_proof_required" }
      );
    }
  }

  #requireSupervisedCloseAuthority(record, terminalProof) {
    if (
      !terminalProof ||
      typeof terminalProof !== "object" ||
      terminalProof.event !== "close" ||
      terminalProof.supervisedByCoordinator !== true ||
      !validTimestamp(terminalProof.observedAt)
    ) {
      throw new WriteCustodyError(
        "A supervised close proof for the exact spawned child is required.",
        { code: "write_custody_terminal_proof_missing" }
      );
    }
    if (this.#supervisedSpawns.get(record.repositoryId) !== record.executionId) {
      throw new WriteCustodyError(
        "This coordinator did not supervise the spawn of the owning execution.",
        { code: "write_custody_terminal_proof_required" }
      );
    }
    this.#requireSameCoordinator(record);
  }

  /**
   * The durable record spells the coordinated repository root as canonicalRoot
   * because that is the persisted schema field name. In memory the same value
   * travels as processIdentity.repositoryRoot. This comparison is the single
   * place the two vocabularies meet; both always name the repository root, and
   * never the isolated workspace root of a general-purpose worker.
   */
  #validateClaudeIdentity(record, processIdentity) {
    const durable = durableProcessIdentity(processIdentity);
    if (
      processIdentity?.executionId !== record.executionId ||
      processIdentity?.agentType !== record.agentType ||
      processIdentity?.repositoryRoot !== record.canonicalRoot ||
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
    this.#requireSameCoordinator(record);
    const liveIdentity = this.#liveIdentities.get(record.repositoryId);
    const mayRecoverUnpersistedSpawn =
      allowUnpersistedIdentity &&
      !record.claudeProcess &&
      liveIdentity === undefined &&
      this.#supervisedSpawns.get(record.repositoryId) === record.executionId &&
      record.coordinatorProcess?.pid === this.#currentPid;
    if (
      (liveIdentity !== processIdentity && !mayRecoverUnpersistedSpawn) ||
      (!allowUnpersistedIdentity && !processIdentityMatches(record.claudeProcess, processIdentity)) ||
      (record.claudeProcess && !processIdentityMatches(record.claudeProcess, processIdentity))
    ) {
      throw new WriteCustodyError("Only the exact active Claude child may return write custody.", {
        code: "write_custody_process_identity_mismatch"
      });
    }
    if (mayRecoverUnpersistedSpawn) this.#liveIdentities.set(record.repositoryId, processIdentity);
  }
}
