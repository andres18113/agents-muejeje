/**
 * Process-local write admission for fresh Claude delegations. This intentionally
 * does not claim cross-process, crash-safe, or Codex-vs-Claude exclusion.
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

function reservationSnapshot(reservation, state = reservation.state) {
  return Object.freeze({
    executionId: reservation.executionId,
    agentType: reservation.agentType,
    canonicalRoot: reservation.canonicalRoot,
    canonicalRootKey: reservation.canonicalRootKey,
    state,
    accessMode: state === "ACTIVE" ? "write" : "none"
  });
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
      state: "RESERVED"
    };
    this.#reservations.set(validCanonicalRootKey, reservation);
    return reservationSnapshot(reservation);
  }

  activateWriteAccess({ executionId, canonicalRootKey }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    if (reservation.state !== "RESERVED") {
      throw new WriteCustodyError(
        "Write custody for canonical root '" + reservation.canonicalRoot + "' is not reservable.",
        { code: "write_custody_state_invalid" }
      );
    }

    reservation.state = "ACTIVE";
    return reservationSnapshot(reservation);
  }

  releaseWriteAccess({ executionId, canonicalRootKey }) {
    const reservation = this.#reservationForOwner({ executionId, canonicalRootKey });
    if (!["RESERVED", "ACTIVE"].includes(reservation.state)) {
      throw new WriteCustodyError(
        "Write custody for canonical root '" + reservation.canonicalRoot + "' cannot be released from its current state.",
        { code: "write_custody_state_invalid" }
      );
    }

    this.#reservations.delete(reservation.canonicalRootKey);
    reservation.state = "RELEASED";
    return reservationSnapshot(reservation, "RELEASED");
  }

  getWriteAccess(canonicalRootKey) {
    const reservation = this.#reservations.get(canonicalRootKey);
    return reservation ? reservationSnapshot(reservation) : undefined;
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
