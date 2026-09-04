import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WriteCustodyError,
  normalizeOwnershipRecord,
  recordSnapshot,
  repositoryIdForCanonicalRootKey,
  samePublicationAuthority,
  validIdentityString
} from "./record-schema.mjs";

/**
 * How durable ownership reaches the filesystem, and how it is read back.
 *
 * This module owns the on-disk layout and the atomicity story, nothing else. It
 * makes no lifecycle decisions: it never chooses a next state, never inspects a
 * process, and never decides who may write. It only guarantees that a record
 * which reaches disk is complete, that a record read from disk is well formed
 * or else refused, and that a publication lands only onto exactly the revision
 * its author read.
 *
 * The publication boundary is one rename() call. Everything before it may be
 * cancelled without effect; once it is issued it may still land, so callers
 * keep their mutation queue occupied until it settles.
 */

const STATE_DIRECTORY_NAME = "claude-agents-mcp";
const STATE_VERSION_DIRECTORY = "state-v1";
const RECORD_FILE_NAME = "record.json";
const OWNERSHIP_DIRECTORY_NAME = "ownership";
const EXECUTIONS_DIRECTORY_NAME = "executions";
export const WORKTREES_DIRECTORY_NAME = "worktrees";
const MAX_RECORD_BYTES = 128 * 1024;

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

export function repositoryStateDirectoryIn(stateRoot, canonicalRootKey) {
  return path.join(stateRoot, "repositories", repositoryIdForCanonicalRootKey(canonicalRootKey));
}

export function ownershipDirectoryIn(repositoryState) {
  return path.join(repositoryState, OWNERSHIP_DIRECTORY_NAME);
}

export function executionHistoryDirectoryIn(repositoryState, executionId) {
  return path.join(repositoryState, EXECUTIONS_DIRECTORY_NAME, executionId);
}

export function worktreeDirectoryIn(repositoryState, executionId) {
  return path.join(repositoryState, WORKTREES_DIRECTORY_NAME, executionId);
}

export function pathIsAtOrWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
}

function errorIsPathConflict(error) {
  return ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code);
}

export async function exists(pathname, { mutationSignal } = {}) {
  try {
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
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

/**
 * Reads the one authoritative record out of an ownership or history directory.
 *
 * Anything unexpected - a symlink, an oversized file, unparsable JSON, a shape
 * this schema version does not recognize - is reported as ambiguous state
 * rather than as "no owner", because "no owner" would admit a second writer.
 */
export async function readAuthoritativeRecord(ownershipDirectory) {
  try {
    await requirePlainDirectory(ownershipDirectory, "Durable ownership state");
    const recordPath = path.join(ownershipDirectory, RECORD_FILE_NAME);
    const details = await lstat(recordPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > MAX_RECORD_BYTES) {
      throw new WriteCustodyError("Durable ownership record is not a plain file.", {
        code: "write_custody_state_ambiguous"
      });
    }
    const record = normalizeOwnershipRecord(JSON.parse(await readFile(recordPath, "utf8")));
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

async function writeFileDurably(pathname, text, { mutationSignal } = {}) {
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  const handle = await open(pathname, "wx", 0o600);
  try {
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    await handle.writeFile(text, "utf8");
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function mutationWasCancelled(signal) {
  return signal?.aborted === true;
}

export function cancelledMutationError() {
  return new WriteCustodyError("Durable custody mutation authority was invalidated before publication.", {
    code: "write_custody_mutation_cancelled"
  });
}

export async function ensureRepositoryLayout(repositoryState, { mutationSignal } = {}) {
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  await mkdir(repositoryState, { recursive: true });
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  await mkdir(path.join(repositoryState, EXECUTIONS_DIRECTORY_NAME), { recursive: true });
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  await mkdir(path.join(repositoryState, WORKTREES_DIRECTORY_NAME), { recursive: true });
}

export async function executionHistoryExists(repositoryState, executionId, { mutationSignal } = {}) {
  return await exists(executionHistoryDirectoryIn(repositoryState, executionId), { mutationSignal });
}

/**
 * The admission publication boundary, made observable to the request that owns
 * the reservation.
 *
 * The very first rename - the one that creates ownership/ - is a publication
 * exactly like every later one and obeys the same rule: before it is issued a
 * cancellation removes the authority to publish for good, and once it is issued
 * nothing can unmake it. A caller whose deadline fires mid-flight therefore
 * cannot conclude "custody was never acquired" from the cancellation alone.
 * The fence records which side of that boundary the reservation reached and,
 * when the rename did land, the record it published, so the caller reports the
 * durable truth rather than the timer's guess.
 */
export function createAdmissionPublicationFence() {
  const state = { publicationStarted: false, disposition: undefined, record: undefined };
  return Object.freeze({
    state,
    publicationStarted: () => state.publicationStarted === true,
    disposition: () => state.disposition,
    publishedRecord: () => state.record
  });
}

/**
 * Marks the boundary as crossed. The caller must issue the rename immediately
 * afterwards with no intervening await: that adjacency is what makes "cancelled
 * before publication" and "publication started" mutually exclusive.
 *
 * Admission may retry after losing a rename, so every attempt re-arms the fence
 * and only the last attempt's disposition describes durable state.
 */
export function beginAdmissionPublication(fence) {
  if (!fence?.state) return false;
  fence.state.publicationStarted = true;
  fence.state.disposition = undefined;
  fence.state.record = undefined;
  return true;
}

export function settleAdmissionPublication(fence, { disposition, record } = {}) {
  if (!fence?.state || fence.state.publicationStarted !== true) return false;
  fence.state.disposition = disposition;
  fence.state.record = record;
  return true;
}

/**
 * Creates the ownership directory for a brand-new reservation.
 *
 * The record is written into a private temporary directory and only then
 * renamed into place, so the ownership directory never exists in a partially
 * written state. Returns false when another coordinator won the same rename;
 * that is a normal race outcome, not an error.
 */
export async function createOwnershipReservation({
  repositoryState,
  record,
  createNonce,
  mutationSignal,
  publicationGuard,
  admissionFence,
  afterPublicationIssued
}) {
  const ownershipDirectory = ownershipDirectoryIn(repositoryState);
  if (await exists(ownershipDirectory, { mutationSignal })) return false;

  const temporaryDirectory = path.join(repositoryState, ".ownership-" + createNonce() + ".tmp");
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  await mkdir(temporaryDirectory);
  let published = false;
  try {
    await writeFileDurably(
      path.join(temporaryDirectory, RECORD_FILE_NAME),
      JSON.stringify(record, null, 2) + "\n",
      { mutationSignal }
    );
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    // The next synchronous rename call is the admission publication boundary.
    // Once it is issued it can still create durable ownership even after the
    // caller's deadline fires, so the mutation queue must stay occupied until
    // it settles and the caller must be told the boundary was crossed.
    if (publicationGuard) publicationGuard.publicationStarted = true;
    beginAdmissionPublication(admissionFence);
    const publication = rename(temporaryDirectory, ownershipDirectory);
    // Keep a rejection observed while a test intentionally pauses after the OS
    // rename has been issued. The original promise is still awaited below, so
    // its outcome remains authoritative to the mutation caller.
    void publication.catch(() => {});
    if (typeof afterPublicationIssued === "function") {
      await afterPublicationIssued({ nextRecord: recordSnapshot(record) });
    }
    try {
      await publication;
    } catch (error) {
      if (!errorIsPathConflict(error)) {
        settleAdmissionPublication(admissionFence, { disposition: "failed" });
        throw error;
      }
      settleAdmissionPublication(admissionFence, { disposition: "conflict" });
      return false;
    }
    published = true;
    settleAdmissionPublication(admissionFence, {
      disposition: "published",
      record: recordSnapshot(record)
    });
    return true;
  } finally {
    // A landed rename has already moved this directory, so there is nothing to
    // clean up and nothing cleanup could usefully report. Running it anyway
    // would let an unrelated stat failure turn a published reservation into a
    // rejection, which is the one thing a crossed publication boundary forbids.
    if (!published && !mutationWasCancelled(mutationSignal) && await exists(temporaryDirectory)) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Publishes the next revision of an existing record under a compare-and-set.
 *
 * The read immediately before the rename is the compare step: the on-disk
 * record must still be exactly the revision, state and history this mutation
 * was built from, and must still belong to the same execution. A cancelled
 * mutation is refused at every checkpoint up to the rename; after the rename is
 * issued, cancellation can no longer unmake it.
 */
export async function publishRecord({
  repositoryState,
  record,
  expectedRecord,
  createNonce,
  beforePublish,
  afterPublicationIssued,
  mutationSignal,
  publicationGuard
}) {
  const ownershipDirectory = ownershipDirectoryIn(repositoryState);
  if (
    !expectedRecord ||
    record.executionId !== expectedRecord.executionId ||
    record.revision !== expectedRecord.revision + 1
  ) {
    throw new WriteCustodyError("Durable ownership publication has an invalid revision transition.", {
      code: "write_custody_state_invalid"
    });
  }
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  const temporaryPath = path.join(repositoryState, ".record-" + createNonce() + ".tmp");
  try {
    await writeFileDurably(temporaryPath, JSON.stringify(record, null, 2) + "\n", { mutationSignal });
    // The test seam pauses after the next record is durable but before the
    // final authoritative read. A stale caller must then lose its CAS rather
    // than rename an old execution over a newer owner.
    if (typeof beforePublish === "function") {
      await beforePublish({
        expectedRecord: recordSnapshot(expectedRecord),
        nextRecord: recordSnapshot(record)
      });
    }
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    const current = await readAuthoritativeRecord(ownershipDirectory);
    if (current.executionId !== record.executionId) {
      throw new WriteCustodyError("Only the durable owning execution may update custody.", {
        code: "write_custody_owner_mismatch"
      });
    }
    if (!samePublicationAuthority(current, expectedRecord)) {
      throw new WriteCustodyError("Durable ownership changed before this mutation could publish.", {
        code: "write_custody_stale_mutation"
      });
    }
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    // The next synchronous rename call is the publication boundary. Once it
    // is issued it can still publish even if a caller's deadline fires. The
    // mutation queue must then remain occupied until rename settles. Before
    // that boundary an aborted lifecycle mutation has no publication
    // authority and may safely stop blocking terminal recovery behind it.
    if (publicationGuard) publicationGuard.publicationStarted = true;
    const publication = rename(temporaryPath, path.join(ownershipDirectory, RECORD_FILE_NAME));
    // Keep a rejection observed while a test intentionally pauses after the
    // OS rename has been issued. The original promise is still awaited below
    // so its failure remains authoritative to the mutation caller.
    void publication.catch(() => {});
    if (typeof afterPublicationIssued === "function") {
      await afterPublicationIssued({
        expectedRecord: recordSnapshot(expectedRecord),
        nextRecord: recordSnapshot(record)
      });
    }
    await publication;
  } catch (error) {
    if (error instanceof WriteCustodyError) throw error;
    throw new WriteCustodyError("Failed to persist durable ownership state.", {
      code: "write_custody_persist_failed",
      cause: error
    });
  } finally {
    if (!mutationWasCancelled(mutationSignal) && await exists(temporaryPath)) {
      await rm(temporaryPath, { force: true });
    }
  }
}

/**
 * Moves a RELEASED record out of the ownership slot and into execution history,
 * which is what actually frees the repository for a new writer.
 *
 * A partially completed archive from an earlier attempt is recognized and
 * treated as done only when the history holds exactly this released record and
 * the ownership slot is genuinely gone. Any other combination is ambiguous.
 */
export async function archiveOwnership({ repositoryState, record, mutationSignal, publicationGuard }) {
  const ownershipDirectory = ownershipDirectoryIn(repositoryState);
  const historyDirectory = executionHistoryDirectoryIn(repositoryState, record.executionId);
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  await mkdir(path.dirname(historyDirectory), { recursive: true });
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  if (await exists(historyDirectory, { mutationSignal })) {
    if (!(await exists(ownershipDirectory, { mutationSignal }))) {
      const archived = await readAuthoritativeRecord(historyDirectory);
      if (samePublicationAuthority(archived, record) && archived.state === "RELEASED") {
        return recordSnapshot(archived);
      }
    }
    throw new WriteCustodyError("Durable execution history already exists; release is ambiguous.", {
      code: "write_custody_state_ambiguous"
    });
  }
  try {
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    const current = await readAuthoritativeRecord(ownershipDirectory);
    if (current.executionId !== record.executionId) {
      throw new WriteCustodyError("Only the durable owning execution may archive custody.", {
        code: "write_custody_owner_mismatch"
      });
    }
    if (!samePublicationAuthority(current, record)) {
      throw new WriteCustodyError("Durable ownership changed before release could be archived.", {
        code: "write_custody_stale_mutation"
      });
    }
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    // Archiving is the final durable handoff boundary. Once this rename is
    // issued, a root cancellation cannot prove whether it landed, so the
    // manager's mutation queue must remain occupied until it settles.
    if (publicationGuard) publicationGuard.publicationStarted = true;
    const publication = rename(ownershipDirectory, historyDirectory);
    void publication.catch(() => {});
    await publication;
  } catch (error) {
    if (error instanceof WriteCustodyError) throw error;
    if (error?.code === "ENOENT") {
      if (!(await exists(ownershipDirectory, { mutationSignal })) &&
          await exists(historyDirectory, { mutationSignal })) {
        const archived = await readAuthoritativeRecord(historyDirectory);
        if (samePublicationAuthority(archived, record) && archived.state === "RELEASED") {
          return recordSnapshot(archived);
        }
      }
    }
    throw new WriteCustodyError("Failed to archive released ownership state.", {
      code: "write_custody_release_failed",
      cause: error
    });
  }
  return recordSnapshot(record);
}

/**
 * Reads the current owner, or undefined when the repository is genuinely free.
 * The record must name the repository it was found under; a mismatch means the
 * state tree itself is inconsistent and must block rather than be trusted.
 */
export async function readOwnershipSnapshot(repositoryState, canonicalRootKey) {
  validIdentityString("canonicalRootKey", canonicalRootKey);
  const ownershipDirectory = ownershipDirectoryIn(repositoryState);
  if (!(await exists(ownershipDirectory))) return undefined;
  const record = await readAuthoritativeRecord(ownershipDirectory);
  if (record.canonicalRootKey !== canonicalRootKey) {
    throw new WriteCustodyError("Durable ownership repository identity is inconsistent.", {
      code: "write_custody_state_ambiguous"
    });
  }
  return recordSnapshot(record);
}
