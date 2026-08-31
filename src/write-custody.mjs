/**
 * Process-local write admission for fresh Claude delegations.
 *
 * This manager deliberately retains an ORPHANED root when a writer may still
 * be alive. It does not claim cross-process, crash-safe, or Codex-vs-Claude
 * exclusion; durable reconciliation belongs to a later lifecycle phase.
 */

export class WriteCustodyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "WriteCustodyError";
    this.code = options.code || "write_custody_invalid";
  }
}

function validateIdentity(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WriteCustodyError(name + " must be a non-empty string.");
  }
  return value;
}

function processIdentitySnapshot(processIdentity) {
  if (!processIdentity) return undefined;
  return Object.freeze({
    executionId: processIdentity.executionId,
    agentType: processIdentity.agentType,
    canonicalRoot: processIdentity.canonicalRoot,
    pid: processIdentity.pid,
    startedAt: processIdentity.startedAt
  });
}

function reservationSnapshot(reservation, state = reservation.state) {
  return Object.freeze({
    executionId: reservation.executionId,
    agentType: reservation.agentType,
    canonicalRoot: reservation.canonicalRoot,
    canonicalRootKey: reservation.canonicalRootKey,
    state,
    accessMode: ["ACTIVE", "TERMINATING", "ORPHANED"].includes(state) ? "write" : "none",
    ...(reservation.processIdentity
      ? { processIdentity: processIdentitySnapshot(reservation.processIdentity) }
      : {}),
    ...(reservation.orphanReason ? { orphanReason: reservation.orphanReason } : {})
  });
}

function validateProcessIdentity(reservation, processIdentity) {
  if (!processIdentity || typeof processIdentity !== "object") {
    throw new WriteCustodyError("A process identity is required for active write custody.", {
      code: "write_custody_process_identity_missing"
    });
  }

  if (
    processIdentity.executionId !== reservation.executionId ||
    processIdentity.agentType !== reservation.agentType ||
    processIdentity.canonicalRoot !== reservation.canonicalRoot ||
    !Number.isSafeInteger(processIdentity.pid) ||
    processIdentity.pid <= 0 ||
    !processIdentity.child ||
    typeof processIdentity.child !== "object" ||
    !Number.isFinite(processIdentity.startedAt)
  ) {
    throw new WriteCustodyError("The process identity does not match this write custody reservation.", {
      code: "write_custody_process_identity_invalid"
    });
  }

  return processIdentity;
}

function requireMatchingProcessIdentity(reservation, processIdentity) {
  const validIdentity = validateProcessIdentity(reservation, processIdentity);
  if (reservation.processIdentity !== validIdentity) {
    throw new WriteCustodyError("Only the exact active child process may change write custody.", {
      code: "write_custody_process_identity_mismatch"
    });
  }
  return validIdentity;
}

function requireTerminalProof(reservation, terminalProof) {
  if (!terminalProof || typeof terminalProof !== "object") {
    throw new WriteCustodyError("A terminal proof is required before write custody can return.", {
      code: "write_custody_terminal_proof_missing"
    });
  }

  requireMatchingProcessIdentity(reservation, terminalProof.processIdentity);
  if (!['close', 'exit'].includes(terminalProof.event) || !Number.isFinite(terminalProof.observedAt)) {
    throw new WriteCustodyError("The supplied terminal proof is invalid.", {
      code: "write_custody_terminal_proof_invalid"
    });
  }
}

export class WriteCustodyManager {
  #reservations = new Map();

  reserveWriteAccess({ executionId, agentType, canonicalRoot, canonicalRootKey }) {
    const validExecutionId = validateIdentity("executionId", executionId);
    const validAgentType = validateIdentity("agentType", agentType);
    const validCanonicalRoot = validateIdentity("canonicalRoot", canonicalRoot);
    const validCanonicalRootKey = validateIdentity("canonicalRootKey", canonicalRootKey);

    const existing = this.#reservations.get(validCanonicalRootKey);
    if (existing) {
      throw new WriteCustodyError(
        "Write custody is already reserved for canonical root '" + validCanonicalRoot + "'.",
        { code: "write_custody_conflict" }
      );
    }

    const reservation = {
      executionId: validExecutionId,
      agentType: validAgentType,
      canonicalRoot: validCanonicalRoot,
      canonicalRootKey: validCanonicalRootKey,
      state: "RESERVED",
      processIdentity: undefined,
      orphanReason: undefined
    };
    this.#reservations.set(validCanonicalRootKey, reservation);
    return reservationSnapshot(reservation);
  }

  activateWriteAccess({ executionId, canonicalRootKey, processIdentity }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    if (reservation.state !== "RESERVED") {
      throw new WriteCustodyError(
        "Write custody for canonical root '" + reservation.canonicalRoot + "' is not reservable.",
        { code: "write_custody_state_invalid" }
      );
    }

    reservation.processIdentity = validateProcessIdentity(reservation, processIdentity);
    reservation.state = "ACTIVE";
    return reservationSnapshot(reservation);
  }

  beginTermination({ executionId, canonicalRootKey, processIdentity }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    requireMatchingProcessIdentity(reservation, processIdentity);
    if (reservation.state === "TERMINATING") {
      return reservationSnapshot(reservation);
    }
    if (reservation.state !== "ACTIVE") {
      throw new WriteCustodyError(
        "Write custody for canonical root '" + reservation.canonicalRoot + "' cannot enter termination.",
        { code: "write_custody_state_invalid" }
      );
    }

    reservation.state = "TERMINATING";
    return reservationSnapshot(reservation);
  }

  releaseUnstartedWriteAccess({ executionId, canonicalRootKey }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    if (reservation.state !== "RESERVED" || reservation.processIdentity) {
      throw new WriteCustodyError(
        "Write custody may be released without terminal proof only before a child process starts.",
        { code: "write_custody_terminal_proof_required" }
      );
    }

    return this.#release(reservation);
  }

  releaseWriteAccessAfterTerminal({ executionId, canonicalRootKey, terminalProof }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    if (!['ACTIVE', 'TERMINATING'].includes(reservation.state)) {
      throw new WriteCustodyError(
        "Write custody for canonical root '" + reservation.canonicalRoot + "' cannot return from its current state.",
        { code: "write_custody_state_invalid" }
      );
    }

    requireTerminalProof(reservation, terminalProof);
    return this.#release(reservation);
  }

  markOrphanedWriteAccess({ executionId, canonicalRootKey, processIdentity, reason }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    const validReason = validateIdentity("orphan reason", reason);

    if (reservation.state === "ORPHANED") {
      if (reservation.processIdentity && processIdentity) {
        requireMatchingProcessIdentity(reservation, processIdentity);
      }
      return reservationSnapshot(reservation);
    }

    if (reservation.state === "RESERVED") {
      // A child may have started but its identity was unavailable or custody
      // activation failed. Retain the root rather than treating it as a safe
      // pre-spawn reservation.
      if (processIdentity) {
        reservation.processIdentity = validateProcessIdentity(reservation, processIdentity);
      }
    } else if (['ACTIVE', 'TERMINATING'].includes(reservation.state)) {
      requireMatchingProcessIdentity(reservation, processIdentity);
    } else {
      throw new WriteCustodyError(
        "Write custody for canonical root '" + reservation.canonicalRoot + "' cannot become orphaned.",
        { code: "write_custody_state_invalid" }
      );
    }

    reservation.state = "ORPHANED";
    reservation.orphanReason = validReason;
    return reservationSnapshot(reservation);
  }

  getWriteAccess(canonicalRootKey) {
    const reservation = this.#reservations.get(canonicalRootKey);
    return reservation ? reservationSnapshot(reservation) : undefined;
  }

  #release(reservation) {
    this.#reservations.delete(reservation.canonicalRootKey);
    reservation.state = "RELEASED";
    return reservationSnapshot(reservation, "RELEASED");
  }

  #reservationForOwner({ executionId, canonicalRootKey }) {
    const validExecutionId = validateIdentity("executionId", executionId);
    const validCanonicalRootKey = validateIdentity("canonicalRootKey", canonicalRootKey);
    const reservation = this.#reservations.get(validCanonicalRootKey);

    if (!reservation) {
      throw new WriteCustodyError("No write custody exists for the requested canonical root.", {
        code: "write_custody_missing"
      });
    }
    if (reservation.executionId !== validExecutionId) {
      throw new WriteCustodyError("Only the owning execution may change write custody.", {
        code: "write_custody_owner_mismatch"
      });
    }

    return reservation;
  }
}

export const PROCESS_WRITE_CUSTODY = new WriteCustodyManager();
