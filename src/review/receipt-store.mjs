import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../canonical-json.mjs";
import { repositoryIdForCanonicalRootKey, repositoryStateDirectoryIn } from "../write-custody.mjs";
import { reviewScopeKey } from "../changeset/target.mjs";
import {
  MAX_RECEIPT_BYTES,
  ReviewReceiptError,
  validateReviewReceipt
} from "./receipt-schema.mjs";
import {
  abandonReceiptPublication,
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
/**
 * Bounds on the authoritative reconciliation sweep. The sc index is allowed to
 * fail, and its failure is silent by design, so its emptiness can never be
 * reported as a proven absence of evidence without asking the cs tree. That
 * question is answered under explicit bounded scan limits, and hitting a limit is reported
 * rather than rounded down to "complete".
 */
export const MAX_RECOVERY_CHANGE_SETS = 256;
export const MAX_RECOVERY_RECEIPT_LOADS = 256;

const RECEIPT_FILE_NAME = "receipt.json";
const RECEIPTS_DIRECTORY = "cs";
const SCOPES_DIRECTORY = "sc";
const REVIEWS_DIRECTORY = "reviews";
export const ARTIFACTS_DIRECTORY = "artifacts";
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

function assertRequestActive(requestContext, phase) {
  requestContext?.assertActive?.(phase);
}

function requestStopped(error) {
  return error?.code === "claude_cancelled" ||
    error?.code === "delegate_request_deadline_exceeded";
}

function requestMayStart(requestContext) {
  return requestContext?.isActive?.() !== false;
}

function receiptMatchesRepositoryScope(receipt, canonicalRootKey) {
  return receipt?.provenance?.repositoryId === repositoryIdForCanonicalRootKey(canonicalRootKey);
}

export class ReviewReceiptStore {
  #stateRoot;
  #createNonce;
  #rename;
  #beforeAuthoritativeRename;
  #afterAuthoritativeRenameIssued;
  #beforeScopeIndex;
  #writeFileDurably;
  #readFile;

  constructor({
    stateRoot,
    createNonce = randomUUID,
    renameFn = rename,
    writeFileDurablyFn = writeFileDurably,
    readFileFn = readFile,
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
    this.#writeFileDurably = writeFileDurablyFn;
    this.#readFile = readFileFn;
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

  artifactsDirectory(canonicalRootKey) {
    return path.join(this.reviewsDirectory(canonicalRootKey), ARTIFACTS_DIRECTORY);
  }

  artifactPath(canonicalRootKey, resultSha256) {
    return path.join(this.artifactsDirectory(canonicalRootKey), resultSha256 + ".txt");
  }

  #resultArtifactBasis(resultText, receipt) {
    if (typeof resultText !== "string") {
      throw new ReviewReceiptError("A bound review receipt requires its result artifact.", {
        code: "review_result_artifact_required"
      });
    }
    const actualSha256 = sha256Hex(Buffer.from(resultText, "utf8"));
    const actualBytes = Buffer.byteLength(resultText, "utf8");
    if (actualSha256 !== receipt.result.sha256 || actualBytes !== receipt.result.bytes) {
      throw new ReviewReceiptError("Result text does not match receipt result basis.", {
        code: "review_result_basis_mismatch"
      });
    }
  }

  async #readAndVerifyResultArtifact({ canonicalRootKey, receipt, requestContext }) {
    const sha256 = receipt?.result?.sha256;
    const expectedBytes = receipt?.result?.bytes;
    if (
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(sha256) ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0
    ) {
      return Object.freeze({
        status: "invalid",
        error: "receipt_result_basis_invalid"
      });
    }

    const targetPath = this.artifactPath(canonicalRootKey, sha256);
    let content;
    try {
      assertRequestActive(requestContext, "result-artifact-read");
      content = await this.#readFile(targetPath);
    } catch (error) {
      if (requestStopped(error)) throw error;
      if (error?.code === "ENOENT") {
        return Object.freeze({ status: "missing", error: "artifact_not_found" });
      }
      return Object.freeze({
        status: "unreadable",
        error: error?.code || error?.name || "artifact_read_failed"
      });
    }

    const artifactBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const actualBytes = artifactBytes.byteLength;
    if (actualBytes !== expectedBytes) {
      return Object.freeze({
        status: "corrupt",
        error: "byte_length_mismatch",
        expectedBytes,
        actualBytes
      });
    }

    const actualSha256 = sha256Hex(artifactBytes);
    if (actualSha256 !== sha256) {
      return Object.freeze({
        status: "corrupt",
        error: "sha256_mismatch",
        expectedSha256: sha256,
        actualSha256
      });
    }

    return Object.freeze({
      status: "verified",
      text: artifactBytes.toString("utf8"),
      bytes: actualBytes,
      sha256: actualSha256
    });
  }

  async #persistAndVerifyResultArtifact({ canonicalRootKey, receipt, resultText, requestContext }) {
    this.#resultArtifactBasis(resultText, receipt);
    const artifactsDir = this.artifactsDirectory(canonicalRootKey);
    assertRequestActive(requestContext, "result-artifact-directory");
    await mkdir(artifactsDir, { recursive: true });
    const targetArtifactPath = this.artifactPath(canonicalRootKey, receipt.result.sha256);
    const existing = await this.#readAndVerifyResultArtifact({
      canonicalRootKey,
      receipt,
      requestContext
    });
    if (existing.status === "verified") return "identical";
    if (existing.status !== "missing") {
      throw new ReviewReceiptError("Existing result artifact could not be verified.", {
        code: "review_result_artifact_conflict"
      });
    }
    const artifactStaging = path.join(artifactsDir, ".artifact-" + this.#createNonce() + ".tmp");
    try {
      assertRequestActive(requestContext, "result-artifact-write");
      await this.#writeFileDurably(artifactStaging, resultText);
      try {
        assertRequestActive(requestContext, "result-artifact-rename");
        await this.#rename(artifactStaging, targetArtifactPath);
      } catch (error) {
        if (!conflictError(error)) throw error;
        const present = await this.#readAndVerifyResultArtifact({ canonicalRootKey, receipt, requestContext });
        if (present.status !== "verified") {
          throw new ReviewReceiptError(
            "Result artifact destination could not be verified after rename conflict.",
            { code: "review_result_artifact_conflict", cause: error }
          );
        }
        return "identical";
      }

      const verified = await this.#readAndVerifyResultArtifact({ canonicalRootKey, receipt, requestContext });
      if (verified.status !== "verified") {
        throw new ReviewReceiptError("Persisted result artifact could not be verified.", {
          code: "review_result_artifact_verification_failed"
        });
      }
      return "created";
    } finally {
      if (requestMayStart(requestContext)) {
        await rm(artifactStaging, { force: true }).catch(() => {});
      }
    }
  }

  async put({ canonicalRootKey, receipt, publication, resultText, awaitIndex = true, requestContext }) {
    let validated;
    const abandonBeforePublication = (error) => {
      if (publication?.guard?.publicationStarted === true) return;
      abandonReceiptPublication(publication, {
        status: "not-started",
        disposition: "failed",
        reviewId: validated?.reviewId,
        changeSetId: validated?.binding?.changeSetId,
        errorCode: error?.code || "publication_precondition_failed"
      });
    };

    try {
      assertRequestActive(requestContext, "receipt-build-validation");
      validated = validateReviewReceipt(receipt);
      if (!validated) {
        throw new ReviewReceiptError("Refusing to store an invalid review receipt.", {
          code: "review_receipt_invalid"
        });
      }
      if (!receiptMatchesRepositoryScope(validated, canonicalRootKey)) {
        throw new ReviewReceiptError("Review receipt repository provenance does not match its storage scope.", {
          code: "review_receipt_repository_mismatch"
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
      if (publication || resultText !== undefined) {
        this.#resultArtifactBasis(resultText, validated);
      }

      assertRequestActive(requestContext, "receipt-directory-create");
      await mkdir(changeSetDirectory, { recursive: true });

      const existing = await this.#listReceiptDirectories(changeSetDirectory, requestContext);
      if (!existing.includes(digestPrefix(validated.reviewId)) && existing.length >= MAX_RECEIPTS_PER_CHANGE_SET) {
        throw new ReviewReceiptError("This change set already holds the maximum number of receipts.", {
          code: "review_receipt_store_full"
        });
      }

      const staging = path.join(changeSetDirectory, ".review-" + this.#createNonce() + ".tmp");
      let stored;
      let renameIssued;
      try {
        assertRequestActive(requestContext, "receipt-staging-create");
        await mkdir(staging);
        assertRequestActive(requestContext, "receipt-staging-write");
        await this.#writeFileDurably(path.join(staging, RECEIPT_FILE_NAME), serialized);

        if (publication || resultText !== undefined) {
          await this.#persistAndVerifyResultArtifact({
            canonicalRootKey,
            receipt: validated,
            resultText,
            requestContext
          });
        }

        if (typeof this.#beforeAuthoritativeRename === "function") {
          assertRequestActive(requestContext, "receipt-authoritative-precondition");
          await this.#beforeAuthoritativeRename({ receipt: validated, finalPath });
        }

        assertRequestActive(requestContext, "receipt-publication-fence");
        if (receiptPublicationCancelled(publication)) {
          throw new ReviewReceiptError("Receipt publication authority was cancelled before rename.", {
            code: "review_receipt_publication_cancelled"
          });
        }

        if (publication && !beginReceiptPublication(publication)) {
          throw new ReviewReceiptError("Receipt publication authority was cancelled before rename.", {
            code: "review_receipt_publication_cancelled"
          });
        }

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
          assertRequestActive(requestContext, "receipt-conflict-read");
          const present = await this.#readFile(finalPath, "utf8").catch(() => undefined);
          if (present === serialized) {
            stored = "identical";
          } else {
            throw new ReviewReceiptError("A different receipt already occupies this digest prefix.", {
              code: "review_receipt_prefix_collision"
            });
          }
        }
      } finally {
        if (requestMayStart(requestContext) && await pathExists(staging)) {
          await rm(staging, { recursive: true, force: true });
        }
      }

      const indexing = requestMayStart(requestContext)
        ? this.#recordPointer(canonicalRootKey, validated, requestContext)
        : Promise.resolve();
      void indexing.catch(() => {});
      if (awaitIndex) await indexing;
      return Object.freeze({ stored, path: finalPath, indexing });
    } catch (error) {
      abandonBeforePublication(error);
      throw error;
    }
  }

  async loadResultArtifact({ canonicalRootKey, receipt, requestContext }) {
    return await this.#readAndVerifyResultArtifact({ canonicalRootKey, receipt, requestContext });
  }

  async #listReceiptDirectories(changeSetDirectory, requestContext) {
    try {
      assertRequestActive(requestContext, "receipt-directory-list");
      const entries = await readdir(changeSetDirectory, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #recordPointer(canonicalRootKey, receipt, requestContext) {
    try {
      if (!requestMayStart(requestContext)) return;
      if (typeof this.#beforeScopeIndex === "function") {
        await this.#beforeScopeIndex({ receipt, requestContext });
      }
      if (!requestMayStart(requestContext)) return;
      const scopeKey = reviewScopeKey({
        agentType: receipt.reviewer.agentType,
        targetSpec: receipt.binding.target.spec
      });
      const directory = this.#scopeDirectory(canonicalRootKey, scopeKey);
      assertRequestActive(requestContext, "scope-index-directory-create");
      await mkdir(directory, { recursive: true });

      const fileName = pointerFileName(receipt.provenance.recordedAt, receipt.reviewId);
      const pointerPath = path.join(directory, fileName);
      assertRequestActive(requestContext, "scope-index-pointer-exists");
      if (!(await pathExists(pointerPath))) {
        assertRequestActive(requestContext, "scope-index-pointer-write");
        const payload = canonicalJson({
          changeSetId: receipt.binding.changeSetId,
          recordedAt: receipt.provenance.recordedAt,
          reviewId: receipt.reviewId
        }) + "\n";
        const staging = path.join(directory, ".review-" + this.#createNonce() + ".tmp");
        try {
          assertRequestActive(requestContext, "scope-index-staging-write");
          await writeFileDurably(staging, payload);
          assertRequestActive(requestContext, "scope-index-rename");
          await rename(staging, pointerPath);
        } finally {
          if (requestMayStart(requestContext) && await pathExists(staging)) {
            await rm(staging, { force: true });
          }
        }
      }

      await this.#prunePointers(directory, requestContext);
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
  async #prunePointers(directory, requestContext) {
    let names;
    try {
      if (!requestMayStart(requestContext)) return;
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    if (names.length <= MAX_POINTERS_PER_SCOPE) return;
    for (const name of names.slice(0, names.length - MAX_POINTERS_PER_SCOPE)) {
      if (!requestMayStart(requestContext)) return;
      await unlink(path.join(directory, name)).catch(() => {});
    }
  }

  async #loadReceipt(receiptPath, canonicalRootKey, requestContext) {
    assertRequestActive(requestContext, "receipt-load-stat");
    const details = await lstat(receiptPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      return { skipped: { path: receiptPath, code: "review_receipt_not_a_file" } };
    }
    if (details.size <= 0 || details.size > MAX_RECEIPT_BYTES) {
      return { skipped: { path: receiptPath, code: "review_receipt_too_large" } };
    }
    let parsed;
    try {
      assertRequestActive(requestContext, "receipt-load-read");
      parsed = JSON.parse(await this.#readFile(receiptPath, "utf8"));
    } catch (error) {
      if (requestStopped(error)) throw error;
      return { skipped: { path: receiptPath, code: "review_receipt_unparsable" } };
    }
    const validated = validateReviewReceipt(parsed);
    if (!validated) return { skipped: { path: receiptPath, code: "review_receipt_corrupt" } };
    if (!receiptMatchesRepositoryScope(validated, canonicalRootKey)) {
      return { skipped: { path: receiptPath, code: "review_receipt_repository_mismatch" } };
    }
    return { receipt: validated };
  }

  async listForChangeSet({ canonicalRootKey, changeSetId, limit = MAX_RECEIPTS_PER_CHANGE_SET, requestContext }) {
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
    for (const name of (await this.#listReceiptDirectories(changeSetDirectory, requestContext)).slice(0, limit)) {
      assertRequestActive(requestContext, "receipt-change-set-loop");
      const outcome = await this.#loadReceipt(
        path.join(changeSetDirectory, name, RECEIPT_FILE_NAME),
        canonicalRootKey,
        requestContext
      )
        .catch((error) => {
          if (requestStopped(error)) throw error;
          return { skipped: { path: name, code: "review_receipt_unreadable" } };
        });
      if (outcome.skipped) skipped.push(outcome.skipped);
      // The truncated directory name is a lookup device, not an identity. The
      // full changeSetId inside the file is what decides a match.
      else if (outcome.receipt.binding.changeSetId === changeSetId) receipts.push(outcome.receipt);
    }
    return Object.freeze({ receipts: Object.freeze(receipts), skipped: Object.freeze(skipped) });
  }

  /**
   * Sweeps the authoritative cs tree for the receipts belonging to one scope.
   *
   * This exists because the sc index is explicitly non-evidentiary: an
   * indexing failure is swallowed so it can never downgrade a durable receipt,
   * which means an empty index is not proof that no receipt was ever written.
   * Asking the authoritative tree is the only way "complete and empty" can be
   * an honest answer, so that answer is never given without asking.
   *
   * The sweep is observational: it repairs nothing and writes nothing. It
   * reports `truncated` when a bound stopped it and `failed` when it could not
   * read what it needed, because in both cases it has proven nothing.
   */
  async #recoverScopeFromReceipts({ canonicalRootKey, scopeKey, known, requestContext }) {
    const root = path.join(this.reviewsDirectory(canonicalRootKey), RECEIPTS_DIRECTORY);
    let changeSetDirectories;
    try {
      assertRequestActive(requestContext, "authoritative-recovery-root-list");
      changeSetDirectories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      // No authoritative tree at all is a real, provable absence.
      if (requestStopped(error)) throw error;
      if (error?.code === "ENOENT") return { status: "complete", recovered: [] };
      return { status: "failed", recovered: [] };
    }

    const scanned = changeSetDirectories.slice(0, MAX_RECOVERY_CHANGE_SETS);
    let truncated = changeSetDirectories.length > scanned.length;
    let unreadable = false;
    let loads = 0;
    const recovered = [];

    for (const changeSetName of scanned) {
      assertRequestActive(requestContext, "authoritative-recovery-change-set-loop");
      if (loads >= MAX_RECOVERY_RECEIPT_LOADS) {
        truncated = true;
        break;
      }
      const changeSetDirectory = path.join(root, changeSetName);
      let receiptDirectories;
      try {
        receiptDirectories = await this.#listReceiptDirectories(changeSetDirectory, requestContext);
      } catch (error) {
        if (requestStopped(error)) throw error;
        unreadable = true;
        continue;
      }
      for (const receiptName of receiptDirectories) {
        assertRequestActive(requestContext, "authoritative-recovery-receipt-loop");
        if (loads >= MAX_RECOVERY_RECEIPT_LOADS) {
          truncated = true;
          break;
        }
        loads += 1;
        const outcome = await this
          .#loadReceipt(
            path.join(changeSetDirectory, receiptName, RECEIPT_FILE_NAME),
            canonicalRootKey,
            requestContext
          )
          .catch((error) => {
            if (requestStopped(error)) throw error;
            return { skipped: { code: "review_receipt_unreadable" } };
          });
        if (!outcome.receipt) {
          // A receipt that will not validate cannot be attributed to a scope,
          // so it counts as an unknown rather than as proven irrelevant.
          unreadable = true;
          continue;
        }
        const receiptScopeKey = reviewScopeKey({
          agentType: outcome.receipt.reviewer.agentType,
          targetSpec: outcome.receipt.binding.target.spec
        });
        if (receiptScopeKey !== scopeKey) continue;
        if (known.has(outcome.receipt.reviewId)) continue;
        known.add(outcome.receipt.reviewId);
        recovered.push(outcome.receipt);
      }
    }

    return {
      status: truncated ? "truncated" : (unreadable ? "unreadable" : "complete"),
      recovered
    };
  }

  /**
   * Finds receipts for a review scope regardless of the repository's current
   * state. This is what makes a STALE verdict reachable at all.
   *
   * `limit` bounds returned records, not authoritative reasoning. The index is
   * deliberately non-evidentiary, so it is never allowed to decide that a
   * full output list proves history exhaustiveness. The cs sweep always runs
   * under explicit scan limits; its result separately decides whether the
   * history can be called complete.
   */
  async discoverForScope({
    canonicalRootKey,
    agentType,
    targetSpec,
    limit = MAX_DISCOVERED_RECEIPTS,
    requestContext
  }) {
    const scopeKey = reviewScopeKey({ agentType, targetSpec });
    const directory = this.#scopeDirectory(canonicalRootKey, scopeKey);

    let names = [];
    try {
      assertRequestActive(requestContext, "review-history-index-list");
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse();
    } catch (error) {
      // An absent index is not an absent history. It falls through to the
      // authoritative sweep below rather than answering "complete" from here.
      if (error?.code !== "ENOENT") throw error;
    }

    const receipts = [];
    const skipped = [];
    const selected = names.slice(0, MAX_POINTERS_PER_SCOPE);
    if (names.length > selected.length) {
      skipped.push({ code: "review_history_index_truncated" });
    }
    for (const name of selected) {
      assertRequestActive(requestContext, "review-history-index-loop");
      let pointer;
      try {
        assertRequestActive(requestContext, "review-history-index-read");
        pointer = JSON.parse(await this.#readFile(path.join(directory, name), "utf8"));
      } catch (error) {
        if (requestStopped(error)) throw error;
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
      const outcome = await this.#loadReceipt(receiptPath, canonicalRootKey, requestContext)
        .catch((error) => {
          if (requestStopped(error)) throw error;
          return { skipped: { path: name, code: "review_pointer_dangling" } };
        });
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
    const recovery = await this.#recoverScopeFromReceipts({
      canonicalRootKey,
      scopeKey,
      known: new Set(receipts.map((receipt) => receipt.reviewId)),
      requestContext
    });
    if (recovery.recovered.length > 0) {
      receipts.push(...recovery.recovered);
      skipped.push({ code: "review_history_recovered_from_receipts" });
    }
    if (recovery.status === "truncated") {
      skipped.push({ code: "review_history_recovery_truncated" });
      skipped.push({ code: "review_history_completeness_unproven" });
    } else if (recovery.status === "unreadable") {
      skipped.push({ code: "review_history_recovery_unreadable" });
      skipped.push({ code: "review_history_completeness_unproven" });
    } else if (recovery.status === "failed") {
      skipped.push({ code: "review_history_recovery_failed" });
      skipped.push({ code: "review_history_completeness_unproven" });
    }

    receipts.sort((left, right) => {
      if (right.provenance.recordedAt !== left.provenance.recordedAt) {
        return right.provenance.recordedAt - left.provenance.recordedAt;
      }
      if (right.reviewId === left.reviewId) return 0;
      return right.reviewId > left.reviewId ? 1 : -1;
    });

    const outputTruncated = receipts.length > limit;
    if (outputTruncated) {
      skipped.push({ code: "review_history_truncated" });
      skipped.push({ code: "review_history_recovery_truncated" });
    }
    const truncated = recovery.status === "truncated" || outputTruncated;

    const status = recovery.status === "failed"
      ? "indeterminate"
      : (recovery.status !== "complete" || outputTruncated ? "partial" : "complete");

    return Object.freeze({
      status,
      receipts: Object.freeze(receipts.slice(0, limit)),
      allReceipts: Object.freeze(receipts),
      totalCount: receipts.length,
      authoritativeExhaustive: recovery.status === "complete",
      outputTruncated,
      skipped: Object.freeze(skipped),
      truncated
    });
  }
}
