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
import {
  DEFAULT_PUBLICATION_RETRY_POLICY,
  PUBLICATION_ATTEMPT,
  withBoundedPublicationRetry
} from "./publication-retry.mjs";

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
 *
 * That boundary may be attempted more than once. A Windows host can reject an
 * issued rename outright with a sharing violation, which settles the attempt
 * without moving anything, and publication-retry bounds how often this module
 * may try again. Each try re-runs the whole operation - fresh authoritative
 * observation, revalidated authority, cancellation recheck - so a retry is a
 * newly authorized publication and never a replay of a stale one.
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

async function requirePlainDirectory(pathname, description, lstatFn = lstat) {
  const details = await lstatFn(pathname);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new WriteCustodyError(description + " is not a plain directory.", {
      code: "write_custody_state_ambiguous"
    });
  }
}

/**
 * Reads the raw record bytes out of an ownership or history directory once.
 *
 * A vanishing slot surfaces as a raw ENOENT so the stable loop can tell "gone
 * mid-read, observe again" apart from "stably invalid". Anything else
 * unexpected - a symlink, an oversized file - is ambiguous state rather than
 * "no owner", because "no owner" would admit a second writer.
 */
async function readSlotBytes(ownershipDirectory, { lstatFn, readFileFn }) {
  await requirePlainDirectory(ownershipDirectory, "Durable ownership state", lstatFn);
  const recordPath = path.join(ownershipDirectory, RECORD_FILE_NAME);
  const details = await lstatFn(recordPath);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > MAX_RECORD_BYTES) {
    throw new WriteCustodyError("Durable ownership record is not a plain file.", {
      code: "write_custody_state_ambiguous"
    });
  }
  return await readFileFn(recordPath, "utf8");
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
    const record = normalizeOwnershipRecord(
      JSON.parse(await readSlotBytes(ownershipDirectory, { lstatFn: lstat, readFileFn: readFile }))
    );
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

export const STABLE_READ_MAX_ATTEMPTS = 3;

async function lstatOrUndefined(pathname, lstatFn) {
  try {
    return await lstatFn(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function malformedSlotError(cause) {
  return new WriteCustodyError("Durable ownership state is missing or malformed; write admission is blocked.", {
    code: "write_custody_state_ambiguous",
    cause
  });
}

/**
 * Reads one ownership slot as a coherent snapshot.
 *
 * An exists-then-read sequence is a race: the slot may be renamed away
 * (archived) or replaced (published) between the probe and the read, and the
 * resulting ENOENT is then evidence of a concurrent handoff, not of a free
 * repository. Turning that transient ENOENT into "free" would admit a second
 * writer; turning it directly into "ambiguous" blocks admission on a race the
 * store itself created.
 *
 * So the observation restarts instead. Absence is reported only when it is
 * stable across two probes, and a record is returned only when two full reads
 * agree byte for byte. Revisions are monotonic, so equal bytes rule out an
 * interleaving publication - there is no ABA at byte level. A stably invalid
 * record (unparsable, wrong shape, not a plain file) is ambiguous
 * immediately: publications land atomically, so transient malformation is
 * impossible and retrying it would only launder a real inconsistency. A slot
 * that keeps changing past the bounded attempts is ambiguous too, rather than
 * retried without limit.
 *
 * Stability here is best-effort within the read; the compare-and-set on
 * revision before every publication remains the authoritative guard against a
 * change that lands after this function returns.
 */
export async function readOwnershipSlot(
  ownershipDirectory,
  { lstatFn = lstat, readFileFn = readFile, mutationSignal } = {}
) {
  for (let attempt = 1; attempt <= STABLE_READ_MAX_ATTEMPTS; attempt += 1) {
    if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
    if ((await lstatOrUndefined(ownershipDirectory, lstatFn)) === undefined) {
      // Only stable absence is "free": confirm the slot did not appear during
      // this very observation.
      if ((await lstatOrUndefined(ownershipDirectory, lstatFn)) === undefined) {
        return { found: false };
      }
      continue;
    }
    let recordBytes;
    try {
      recordBytes = await readSlotBytes(ownershipDirectory, { lstatFn, readFileFn });
    } catch (error) {
      // The slot vanished mid-read: a concurrent handoff, not a free
      // repository and not an inconsistency. Observe again.
      if (error?.code === "ENOENT") continue;
      if (error instanceof WriteCustodyError) throw error;
      throw malformedSlotError(error);
    }
    let record;
    try {
      record = normalizeOwnershipRecord(JSON.parse(recordBytes));
    } catch (error) {
      throw malformedSlotError(error);
    }
    if (!record) throw malformedSlotError(new Error("invalid ownership schema"));
    let confirmBytes;
    try {
      confirmBytes = await readSlotBytes(ownershipDirectory, { lstatFn, readFileFn });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof WriteCustodyError) throw error;
      throw malformedSlotError(error);
    }
    // Changed during the read: restart the observation rather than returning
    // a record that is already stale.
    if (confirmBytes !== recordBytes) continue;
    return { found: true, record };
  }
  throw new WriteCustodyError(
    "Durable ownership state changed during a bounded read; write admission is blocked.",
    { code: "write_custody_state_ambiguous" }
  );
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

/**
 * Issues one publication rename and reports which state the attempt settled in.
 *
 * The guard is raised immediately before the call and deliberately never
 * lowered: while a bounded retry sequence is still running another rename may
 * still be issued, so the repository's mutation queue must stay occupied for
 * the whole sequence rather than for one attempt.
 *
 * `observeIssued` is the existing test seam for pausing between an issued
 * rename and its settlement.
 */
async function issuePublicationRename(from, to, {
  renamePath,
  publicationGuard,
  observeIssued,
  onAttemptState
}) {
  onAttemptState?.(PUBLICATION_ATTEMPT.NOT_ISSUED);
  if (publicationGuard) publicationGuard.publicationStarted = true;
  onAttemptState?.(PUBLICATION_ATTEMPT.ISSUED);
  const publication = renamePath(from, to);
  // Keep a rejection observed while a test intentionally pauses after the OS
  // rename has been issued. The original promise is still awaited below, so its
  // outcome remains authoritative to the mutation caller.
  void publication.catch(() => {});
  if (typeof observeIssued === "function") await observeIssued();
  try {
    await publication;
  } catch (error) {
    onAttemptState?.(PUBLICATION_ATTEMPT.SETTLED_FAILED, error);
    throw error;
  }
  onAttemptState?.(PUBLICATION_ATTEMPT.SETTLED_PUBLISHED);
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
 *
 * Admission is the one publication whose conflict and whose transient host
 * failure arrive as the same errno: Windows reports both a directory that is
 * already there and a directory something is momentarily holding as EPERM. The
 * errno therefore decides nothing here. A fresh observation of the ownership
 * slot does: still absent means the host refused a rename that could have
 * succeeded, and may be attempted again; present means a competitor won, which
 * is an ordinary conflict this function reports and never overwrites.
 */
export async function createOwnershipReservation({
  repositoryState,
  record,
  createNonce,
  mutationSignal,
  publicationGuard,
  admissionFence,
  afterPublicationIssued,
  renamePath = rename,
  retryPolicy = DEFAULT_PUBLICATION_RETRY_POLICY
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
    const admitted = await withBoundedPublicationRetry(async () => {
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      // The expected state for admission is an absent slot, so this is the
      // compare step and it is repeated in full before every attempt.
      if (await exists(ownershipDirectory, { mutationSignal })) return { conflict: true };
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      try {
        await issuePublicationRename(temporaryDirectory, ownershipDirectory, {
          renamePath,
          publicationGuard,
          observeIssued: typeof afterPublicationIssued === "function"
            ? () => afterPublicationIssued({ nextRecord: recordSnapshot(record) })
            : undefined,
          onAttemptState: (state) => {
            if (state === PUBLICATION_ATTEMPT.ISSUED) beginAdmissionPublication(admissionFence);
          }
        });
      } catch (error) {
        if (!errorIsPathConflict(error)) throw error;
        // A conflict-shaped rejection proves nothing on its own. Ask the slot.
        if (await exists(ownershipDirectory, { mutationSignal })) return { conflict: true };
        // Still free: the host refused, not a competitor. Let the retry policy
        // decide whether this is one of its transient codes.
        throw error;
      }
      return { published: true };
    }, {
      policy: retryPolicy,
      mutationSignal,
      cancelled: mutationWasCancelled,
      cancelledError: cancelledMutationError
    }).catch((error) => {
      settleAdmissionPublication(admissionFence, { disposition: "failed" });
      throw error;
    });
    if (admitted.conflict) {
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
 *
 * The compare step belongs to the attempt, not to the operation, so a retry
 * after a transient host rejection reads the authoritative record again and
 * revalidates the same authority. A record that moved on while this mutation
 * was backing off loses its CAS exactly as it would have lost it on the first
 * attempt; no stale writer can reach the slot through a retry.
 */
export async function publishRecord({
  repositoryState,
  record,
  expectedRecord,
  createNonce,
  beforePublish,
  afterPublicationIssued,
  mutationSignal,
  publicationGuard,
  renamePath = rename,
  retryPolicy = DEFAULT_PUBLICATION_RETRY_POLICY,
  lstatFn = lstat,
  readFileFn = readFile
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
    await withBoundedPublicationRetry(async () => {
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      const slot = await readOwnershipSlot(ownershipDirectory, { lstatFn, readFileFn, mutationSignal });
      if (!slot.found) {
        throw new WriteCustodyError("Durable ownership changed before this mutation could publish.", {
          code: "write_custody_stale_mutation"
        });
      }
      const current = slot.record;
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
      await issuePublicationRename(temporaryPath, path.join(ownershipDirectory, RECORD_FILE_NAME), {
        renamePath,
        publicationGuard,
        observeIssued: typeof afterPublicationIssued === "function"
          ? () => afterPublicationIssued({
              expectedRecord: recordSnapshot(expectedRecord),
              nextRecord: recordSnapshot(record)
            })
          : undefined
      });
    }, {
      policy: retryPolicy,
      mutationSignal,
      cancelled: mutationWasCancelled,
      cancelledError: cancelledMutationError
    });
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
 *
 * That rule is what a retry leans on. An errno alone never establishes that the
 * archive already happened: the destination is read back and must hold exactly
 * this released record, with the ownership slot genuinely gone, before the
 * archive is called done. Every retry also revalidates the ownership record's
 * authority, so a slot that changed hands during a backoff is refused.
 */
export async function archiveOwnership({
  repositoryState,
  record,
  mutationSignal,
  publicationGuard,
  renamePath = rename,
  retryPolicy = DEFAULT_PUBLICATION_RETRY_POLICY,
  lstatFn = lstat,
  readFileFn = readFile
}) {
  const ownershipDirectory = ownershipDirectoryIn(repositoryState);
  const historyDirectory = executionHistoryDirectoryIn(repositoryState, record.executionId);
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  await mkdir(path.dirname(historyDirectory), { recursive: true });
  if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
  // An archive that already exists is accepted only on exact evidence, never on
  // the mere fact that the destination path is occupied. Both slots are read
  // as coherent snapshots: a rename landing between two probes must restart
  // the observation, never read as a half-moved state.
  const settledArchive = async () => {
    const history = await readOwnershipSlot(historyDirectory, { lstatFn, readFileFn, mutationSignal });
    if (!history.found) return undefined;
    const ownership = await readOwnershipSlot(ownershipDirectory, { lstatFn, readFileFn, mutationSignal });
    if (ownership.found) return undefined;
    if (!samePublicationAuthority(history.record, record) || history.record.state !== "RELEASED") return undefined;
    return recordSnapshot(history.record);
  };
  if (await exists(historyDirectory, { mutationSignal })) {
    const alreadyArchived = await settledArchive();
    if (alreadyArchived) return alreadyArchived;
    throw new WriteCustodyError("Durable execution history already exists; release is ambiguous.", {
      code: "write_custody_state_ambiguous"
    });
  }
  let archivedByRetry;
  try {
    archivedByRetry = await withBoundedPublicationRetry(async ({ isRetry }) => {
      if (mutationWasCancelled(mutationSignal)) throw cancelledMutationError();
      if (isRetry) {
        // A previous attempt was rejected without moving anything, but the
        // destination is rechecked anyway before this one is authorized.
        const alreadyArchived = await settledArchive();
        if (alreadyArchived) return alreadyArchived;
        if (await exists(historyDirectory, { mutationSignal })) {
          throw new WriteCustodyError("Durable execution history already exists; release is ambiguous.", {
            code: "write_custody_state_ambiguous"
          });
        }
      }
      const slot = await readOwnershipSlot(ownershipDirectory, { lstatFn, readFileFn, mutationSignal });
      if (!slot.found) {
        // The slot moved while this archive was authorizing. Either our own
        // previous attempt already landed it - settled below - or another
        // writer moved the record first.
        const alreadyArchived = await settledArchive();
        if (alreadyArchived) return alreadyArchived;
        throw new WriteCustodyError("Durable ownership changed before release could be archived.", {
          code: "write_custody_stale_mutation"
        });
      }
      const current = slot.record;
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
      await issuePublicationRename(ownershipDirectory, historyDirectory, {
        renamePath,
        publicationGuard
      });
      return undefined;
    }, {
      policy: retryPolicy,
      mutationSignal,
      cancelled: mutationWasCancelled,
      cancelledError: cancelledMutationError
    });
  } catch (error) {
    if (error instanceof WriteCustodyError) throw error;
    if (error?.code === "ENOENT") {
      const alreadyArchived = await settledArchive();
      if (alreadyArchived) return alreadyArchived;
    }
    throw new WriteCustodyError("Failed to archive released ownership state.", {
      code: "write_custody_release_failed",
      cause: error
    });
  }
  return archivedByRetry ?? recordSnapshot(record);
}

/**
 * Reads the current owner, or undefined when the repository is genuinely free.
 * The record must name the repository it was found under; a mismatch means the
 * state tree itself is inconsistent and must block rather than be trusted.
 */
export async function readOwnershipSnapshot(
  repositoryState,
  canonicalRootKey,
  { lstatFn = lstat, readFileFn = readFile } = {}
) {
  validIdentityString("canonicalRootKey", canonicalRootKey);
  const ownershipDirectory = ownershipDirectoryIn(repositoryState);
  const slot = await readOwnershipSlot(ownershipDirectory, { lstatFn, readFileFn });
  if (!slot.found) return undefined;
  if (slot.record.canonicalRootKey !== canonicalRootKey) {
    throw new WriteCustodyError("Durable ownership repository identity is inconsistent.", {
      code: "write_custody_state_ambiguous"
    });
  }
  return recordSnapshot(slot.record);
}
