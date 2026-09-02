import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../canonical-json.mjs";
import { repositoryStateDirectoryIn } from "../write-custody.mjs";
import { reviewScopeKey } from "../changeset/target.mjs";
import {
  MAX_RECEIPT_BYTES,
  ReviewReceiptError,
  validateReviewReceipt
} from "./receipt-schema.mjs";
import {
  beginReceiptPublication,
  receiptPublicationCancelled,
  settleReceiptPublication
} from "./publication-fence.mjs";

/**
 * How receipts reach the disk, and how an older one is found again.
 *
 * Two trees with deliberately different rules live under reviews/.
 *
 *   cs/<changeSet20>/<review20>/receipt.json
 *     Authoritative evidence. Written once, never rewritten, never renamed,
 *     never deleted by this system. A corrupt entry is reported and left
 *     exactly where it is, because destroying evidence to tidy up is worse
 *     than reporting that it is unreadable.
 *
 *   sc/<scope20>/<recordedAt>-<review20>.json
 *     A discovery index, and explicitly NOT evidence. It exists because a
 *     lookup keyed by the *current* change set can only ever find a receipt
 *     that is already fresh - the moment the repository moves, the receipt
 *     that would prove it stale becomes unfindable. The index is keyed by
 *     review scope (agent type plus the declared target spec), which survives
 *     the repository changing underneath it.
 *
 * Because the index is not evidence it may be pruned, and it is: a bounded
 * number of newest pointers per scope. Pruning a pointer never touches a
 * receipt. And because it is not evidence it is never trusted: a pointer only
 * says where to look, and the receipt found there is loaded and fully
 * validated - including recomputing its own reviewId - before any use.
 */

export const DIGEST_PATH_PREFIX_LENGTH = 20;
export const MAX_RECEIPTS_PER_CHANGE_SET = 64;
export const MAX_POINTERS_PER_SCOPE = 32;
export const MAX_RECEIPT_PATH_CHARS = 240;
export const MAX_DISCOVERED_RECEIPTS = 16;

const RECEIPT_FILE_NAME = "receipt.json";
const RECEIPTS_DIRECTORY = "cs";
const SCOPES_DIRECTORY = "sc";
const REVIEWS_DIRECTORY = "reviews";
const TIMESTAMP_DIGITS = 13;
const CHANGE_SET_ID = /^cs1:[0-9a-f]{64}$/u;
const REVIEW_ID = /^rr1:[0-9a-f]{64}$/u;
const RECEIPT_CORRUPTION_CODES = new Set([
  "review_receipt_not_a_file",
  "review_receipt_too_large",
  "review_receipt_unparsable",
  "review_receipt_corrupt",
  "review_receipt_unreadable"
]);

function validPointer(pointer) {
  return pointer && typeof pointer === "object" && !Array.isArray(pointer) &&
    Object.keys(pointer).sort().join(",") === "changeSetId,recordedAt,reviewId" &&
    CHANGE_SET_ID.test(pointer.changeSetId) && REVIEW_ID.test(pointer.reviewId) &&
    Number.isSafeInteger(pointer.recordedAt) && pointer.recordedAt >= 0;
}

function digestPrefix(identifier) {
  return identifier.slice(identifier.indexOf(":") + 1, identifier.indexOf(":") + 1 + DIGEST_PATH_PREFIX_LENGTH);
}

function scopePrefix(scopeKey) {
  return sha256Hex(Buffer.from(scopeKey, "utf8")).slice(0, DIGEST_PATH_PREFIX_LENGTH);
}

function pointerFileName(recordedAt, reviewId) {
  return String(recordedAt).padStart(TIMESTAMP_DIGITS, "0") + "-" + digestPrefix(reviewId) + ".json";
}

async function pathExists(pathname) {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
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

function conflictError(error) {
  return ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code);
}

export class ReviewReceiptStore {
  #stateRoot;
  #createNonce;
  #rename;
  #beforeAuthoritativeRename;
  #afterAuthoritativeRenameIssued;
  #beforeScopeIndex;

  constructor({
    stateRoot,
    createNonce = randomUUID,
    renameFn = rename,
    beforeAuthoritativeRename,
    afterAuthoritativeRenameIssued,
    beforeScopeIndex
  } = {}) {
    if (typeof stateRoot !== "string" || stateRoot.length === 0) {
      throw new ReviewReceiptError("A durable state root is required for the review receipt store.", {
        code: "review_receipt_invalid"
      });
    }
    this.#stateRoot = path.resolve(stateRoot);
    this.#createNonce = createNonce;
    this.#rename = renameFn;
    this.#beforeAuthoritativeRename = beforeAuthoritativeRename;
    this.#afterAuthoritativeRenameIssued = afterAuthoritativeRenameIssued;
    this.#beforeScopeIndex = beforeScopeIndex;
  }

  reviewsDirectory(canonicalRootKey) {
    return path.join(repositoryStateDirectoryIn(this.#stateRoot, canonicalRootKey), REVIEWS_DIRECTORY);
  }

  #receiptDirectory(canonicalRootKey, changeSetId, reviewId) {
    return path.join(
      this.reviewsDirectory(canonicalRootKey),
      RECEIPTS_DIRECTORY,
      digestPrefix(changeSetId),
      digestPrefix(reviewId)
    );
  }

  #scopeDirectory(canonicalRootKey, scopeKey) {
    return path.join(this.reviewsDirectory(canonicalRootKey), SCOPES_DIRECTORY, scopePrefix(scopeKey));
  }

  /**
   * Persists one receipt, then records a pointer to it.
   *
   * Order matters: the receipt is durable before anything points at it, so a
   * crash between the two leaves an unindexed receipt rather than a pointer to
   * nothing. An unindexed receipt is merely harder to discover; a dangling
   * pointer would be a lie that discovery has to defend against on every read.
   */
  async put({ canonicalRootKey, receipt, publication, awaitIndex = true }) {
    const validated = validateReviewReceipt(receipt);
    if (!validated) {
      throw new ReviewReceiptError("Refusing to store an invalid review receipt.", {
        code: "review_receipt_invalid"
      });
    }

    const serialized = canonicalJson(validated) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) {
      throw new ReviewReceiptError("Review receipt exceeds the maximum size.", {
        code: "review_receipt_too_large"
      });
    }

    const finalDirectory = this.#receiptDirectory(
      canonicalRootKey,
      validated.binding.changeSetId,
      validated.reviewId
    );
    const finalPath = path.join(finalDirectory, RECEIPT_FILE_NAME);
    if (finalPath.length > MAX_RECEIPT_PATH_CHARS) {
      throw new ReviewReceiptError("Review receipt path is too long to store safely.", {
        code: "review_receipt_path_too_long"
      });
    }

    const changeSetDirectory = path.dirname(finalDirectory);
    await mkdir(changeSetDirectory, { recursive: true });

    const existing = await this.#listReceiptDirectories(changeSetDirectory);
    if (!existing.includes(digestPrefix(validated.reviewId)) && existing.length >= MAX_RECEIPTS_PER_CHANGE_SET) {
      throw new ReviewReceiptError("This change set already holds the maximum number of receipts.", {
        code: "review_receipt_store_full"
      });
    }

    const staging = path.join(changeSetDirectory, ".review-" + this.#createNonce() + ".tmp");
    let stored;
    await mkdir(staging);
    try {
      await writeFileDurably(path.join(staging, RECEIPT_FILE_NAME), serialized);
      if (typeof this.#beforeAuthoritativeRename === "function") {
        await this.#beforeAuthoritativeRename({ receipt: validated, finalPath });
      }
      if (receiptPublicationCancelled(publication)) {
        throw new ReviewReceiptError("Receipt publication authority was cancelled before rename.", {
          code: "review_receipt_publication_cancelled"
        });
      }

      // This is the authoritative boundary: the cancellation check, authority
      // marker and reviews/cs rename invocation are synchronous and adjacent.
      // The later reviews/sc pointer is explicitly outside this fence.
      if (publication && !beginReceiptPublication(publication)) {
        throw new ReviewReceiptError("Receipt publication authority was cancelled before rename.", {
          code: "review_receipt_publication_cancelled"
        });
      }

      let renameIssued;
      try {
        renameIssued = this.#rename(staging, finalDirectory);
      } catch (error) {
        settleReceiptPublication(publication, {
          status: "settled",
          disposition: "failed",
          reviewId: validated.reviewId,
          changeSetId: validated.binding.changeSetId,
          errorCode: error?.code || "rename_failed"
        });
        throw error;
      }
      const authoritative = Promise.resolve(renameIssued).then(
        () => {
          settleReceiptPublication(publication, {
            status: "settled",
            disposition: "published",
            reviewId: validated.reviewId,
            changeSetId: validated.binding.changeSetId
          });
          return { published: true };
        },
        (error) => {
          settleReceiptPublication(publication, {
            status: "settled",
            disposition: conflictError(error) ? "conflict" : "failed",
            reviewId: validated.reviewId,
            changeSetId: validated.binding.changeSetId,
            errorCode: error?.code || "rename_failed"
          });
          return { error };
        }
      );
      void authoritative.catch(() => {});
      if (typeof this.#afterAuthoritativeRenameIssued === "function") {
        await this.#afterAuthoritativeRenameIssued({
          receipt: validated,
          finalPath,
          authoritative
        });
      }

      const renameOutcome = await authoritative;
      if (!renameOutcome.error) {
        stored = "created";
      } else {
        const error = renameOutcome.error;
        if (!conflictError(error)) throw error;
        // Something is already there. Identical content is an idempotent
        // repeat; different content under the same truncated prefix is a
        // collision, and nothing is overwritten either way.
        const present = await readFile(finalPath, "utf8").catch(() => undefined);
        if (present === serialized) {
          stored = "identical";
        } else {
          throw new ReviewReceiptError("A different receipt already occupies this digest prefix.", {
            code: "review_receipt_prefix_collision"
          });
        }
      }
    } finally {
      if (await pathExists(staging)) await rm(staging, { recursive: true, force: true });
    }

    // Scope indexing is non-evidentiary housekeeping. It starts after the
    // durable receipt is settled and is intentionally not awaited by put(), so
    // a stalled reviews/sc directory can neither downgrade the receipt nor
    // retain coherent-review custody.
    const indexing = this.#recordPointer(canonicalRootKey, validated);
    void indexing.catch(() => {});
    if (awaitIndex) await indexing;
    return Object.freeze({ stored, path: finalPath, indexing });
  }

  async #listReceiptDirectories(changeSetDirectory) {
    try {
      const entries = await readdir(changeSetDirectory, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #recordPointer(canonicalRootKey, receipt) {
    try {
      if (typeof this.#beforeScopeIndex === "function") {
        await this.#beforeScopeIndex({ receipt });
      }
      const scopeKey = reviewScopeKey({
        agentType: receipt.reviewer.agentType,
        targetSpec: receipt.binding.target.spec
      });
      const directory = this.#scopeDirectory(canonicalRootKey, scopeKey);
      await mkdir(directory, { recursive: true });

      const fileName = pointerFileName(receipt.provenance.recordedAt, receipt.reviewId);
      const pointerPath = path.join(directory, fileName);
      if (!(await pathExists(pointerPath))) {
        const payload = canonicalJson({
          changeSetId: receipt.binding.changeSetId,
          recordedAt: receipt.provenance.recordedAt,
          reviewId: receipt.reviewId
        }) + "\n";
        const staging = path.join(directory, ".review-" + this.#createNonce() + ".tmp");
        try {
          await writeFileDurably(staging, payload);
          await rename(staging, pointerPath);
        } finally {
          if (await pathExists(staging)) await rm(staging, { force: true });
        }
      }

      await this.#prunePointers(directory);
    } catch {
      // The scope index is a convenience, never evidence. Once the receipt is
      // durable, any indexing or cleanup failure must not downgrade that bound
      // review or remove its immutable receipt.
    }
  }

  /**
   * Keeps the newest pointers and drops the rest. Names begin with a
   * zero-padded timestamp, so lexical order is chronological order and pruning
   * needs no reads. Only pointers are ever removed; receipts are untouchable.
   */
  async #prunePointers(directory) {
    let names;
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    if (names.length <= MAX_POINTERS_PER_SCOPE) return;
    for (const name of names.slice(0, names.length - MAX_POINTERS_PER_SCOPE)) {
      await unlink(path.join(directory, name)).catch(() => {});
    }
  }

  async #loadReceipt(receiptPath) {
    const details = await lstat(receiptPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      return { skipped: { path: receiptPath, code: "review_receipt_not_a_file" } };
    }
    if (details.size <= 0 || details.size > MAX_RECEIPT_BYTES) {
      return { skipped: { path: receiptPath, code: "review_receipt_too_large" } };
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch {
      return { skipped: { path: receiptPath, code: "review_receipt_unparsable" } };
    }
    const validated = validateReviewReceipt(parsed);
    if (!validated) return { skipped: { path: receiptPath, code: "review_receipt_corrupt" } };
    return { receipt: validated };
  }

  async listForChangeSet({ canonicalRootKey, changeSetId, limit = MAX_RECEIPTS_PER_CHANGE_SET }) {
    if (!CHANGE_SET_ID.test(changeSetId)) {
      return Object.freeze({
        receipts: Object.freeze([]),
        skipped: Object.freeze([{ code: "change_set_id_invalid" }])
      });
    }
    const changeSetDirectory = path.join(
      this.reviewsDirectory(canonicalRootKey),
      RECEIPTS_DIRECTORY,
      digestPrefix(changeSetId)
    );
    const receipts = [];
    const skipped = [];
    for (const name of (await this.#listReceiptDirectories(changeSetDirectory)).slice(0, limit)) {
      const outcome = await this.#loadReceipt(path.join(changeSetDirectory, name, RECEIPT_FILE_NAME))
        .catch(() => ({ skipped: { path: name, code: "review_receipt_unreadable" } }));
      if (outcome.skipped) skipped.push(outcome.skipped);
      // The truncated directory name is a lookup device, not an identity. The
      // full changeSetId inside the file is what decides a match.
      else if (outcome.receipt.binding.changeSetId === changeSetId) receipts.push(outcome.receipt);
    }
    return Object.freeze({ receipts: Object.freeze(receipts), skipped: Object.freeze(skipped) });
  }

  /**
   * Finds receipts for a review scope regardless of the repository's current
   * state. This is what makes a STALE verdict reachable at all.
   */
  async discoverForScope({ canonicalRootKey, agentType, targetSpec, limit = MAX_DISCOVERED_RECEIPTS }) {
    const scopeKey = reviewScopeKey({ agentType, targetSpec });
    const directory = this.#scopeDirectory(canonicalRootKey, scopeKey);

    let names;
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse();
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({
          status: "complete",
          receipts: Object.freeze([]),
          skipped: Object.freeze([]),
          truncated: false
        });
      }
      throw error;
    }

    const receipts = [];
    const skipped = [];
    const selected = names.slice(0, limit);
    for (const name of selected) {
      let pointer;
      try {
        pointer = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      } catch {
        skipped.push({ path: name, code: "review_pointer_unparsable" });
        continue;
      }
      if (!validPointer(pointer)) {
        skipped.push({ path: name, code: "review_pointer_invalid" });
        continue;
      }
      const receiptPath = path.join(
        this.#receiptDirectory(canonicalRootKey, pointer.changeSetId, pointer.reviewId),
        RECEIPT_FILE_NAME
      );
      const outcome = await this.#loadReceipt(receiptPath)
        .catch(() => ({ skipped: { path: name, code: "review_pointer_dangling" } }));
      if (outcome.skipped) {
        skipped.push(RECEIPT_CORRUPTION_CODES.has(outcome.skipped.code)
          ? {
              ...outcome.skipped,
              reviewId: pointer.reviewId,
              changeSetId: pointer.changeSetId,
              recordedAt: pointer.recordedAt
            }
          : outcome.skipped);
        continue;
      }
      // The pointer is untrusted metadata: the receipt must agree with it, and
      // the receipt is what wins.
      if (outcome.receipt.reviewId !== pointer.reviewId ||
          outcome.receipt.binding.changeSetId !== pointer.changeSetId) {
        skipped.push({ path: name, code: "review_pointer_mismatch" });
        continue;
      }
      const receiptScopeKey = reviewScopeKey({
        agentType: outcome.receipt.reviewer.agentType,
        targetSpec: outcome.receipt.binding.target.spec
      });
      if (receiptScopeKey !== scopeKey) {
        skipped.push({ path: name, code: "review_pointer_scope_mismatch" });
        continue;
      }
      receipts.push(outcome.receipt);
    }
    const truncated = names.length > selected.length;
    return Object.freeze({
      status: skipped.length > 0 || truncated ? "partial" : "complete",
      receipts: Object.freeze(receipts),
      skipped: Object.freeze(skipped),
      truncated
    });
  }
}
