import { createHash } from "node:crypto";
import { lstat, open, readlink } from "node:fs/promises";

/**
 * How worktree bytes are read, digested, and checked for having moved.
 *
 * Two ideas live here and nowhere else.
 *
 * Bytes are raw. Content is hashed exactly as it sits on disk - never decoded,
 * never line-ending translated, never normalized. On Windows with
 * core.autocrlf the worktree bytes legitimately differ from the blob, and the
 * question this answers is "what is in the working tree", not "what would Git
 * store". A consequence worth stating: a digest is a property of one worktree
 * on one machine and is not portable.
 *
 * Timestamps are evidence, not identity. The stat taken before hashing and the
 * stat taken after are compared to detect a file that changed underneath us.
 * They are never hashed and never reach the descriptor, because hashing them
 * would make two byte-identical trees produce different identities.
 */

export const MAX_CONTENT_BYTES_PER_FILE = 64 * 1024 * 1024;
export const MAX_CONTENT_BYTES_TOTAL = 256 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

const RETRYABLE_ERRNO = new Set(["ENOENT", "EACCES", "EBUSY", "EPERM"]);

export class WorkspaceDigestError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WorkspaceDigestError";
    this.reason = options.reason || "content_unreadable";
    this.detail = options.detail;
  }
}

function fail(reason, detail, cause) {
  throw new WorkspaceDigestError("Workspace content could not be digested: " + reason, {
    reason,
    detail,
    cause
  });
}

/**
 * Domain-separated framing, so a symlink whose target string happens to equal a
 * regular file's contents cannot collide with it.
 */
function frameDigest(kind, bytes) {
  const hash = createHash("sha256");
  hash.update("cafs1");
  hash.update(Buffer.of(0));
  hash.update(kind);
  hash.update(Buffer.of(0));
  hash.update(String(bytes.length));
  hash.update(Buffer.of(0));
  hash.update(bytes);
  return hash.digest("hex");
}

/**
 * Windows very often reports ino/dev as 0, so a zero on either side carries no
 * information and must not be read as a mismatch. Everything else must match
 * exactly for the read to count as stable.
 */
function statsAgree(before, after) {
  if (before.size !== after.size) return false;
  if (before.mtimeNs !== after.mtimeNs) return false;
  if (before.ctimeNs !== after.ctimeNs) return false;
  if (before.mode !== after.mode) return false;
  if (before.ino !== 0n && after.ino !== 0n && before.ino !== after.ino) return false;
  if (before.dev !== 0n && after.dev !== 0n && before.dev !== after.dev) return false;
  return true;
}

async function readBlobBytes(absolutePath, size, budget, openFn) {
  if (size > MAX_CONTENT_BYTES_PER_FILE) fail("content_too_large", absolutePath);
  if (budget && size > budget.remainingBytes) fail("content_too_large", absolutePath);

  const handle = await openFn(absolutePath, "r");
  try {
    const chunks = [];
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_CONTENT_BYTES_PER_FILE) fail("content_too_large", absolutePath);
      if (budget && total > budget.remainingBytes) fail("content_too_large", absolutePath);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function digestOnce(absolutePath, { expect, budget, lstatFn, openFn, readlinkFn }) {
  const before = await lstatFn(absolutePath, { bigint: true });

  let kind;
  if (before.isFile()) kind = "blob";
  else if (before.isSymbolicLink()) kind = "link";
  else if (before.isDirectory()) fail("untracked_directory_opaque", absolutePath);
  else fail("unsupported_file_type", absolutePath);

  if (expect && expect !== "any" && expect !== kind) {
    fail("unsupported_file_type", absolutePath + " is a " + kind);
  }

  const bytes = kind === "link"
    ? await readlinkFn(absolutePath, { encoding: "buffer" })
    : await readBlobBytes(absolutePath, Number(before.size), budget, openFn);

  const after = await lstatFn(absolutePath, { bigint: true });
  if (!statsAgree(before, after)) fail("content_unstable", absolutePath);

  if (budget) budget.remainingBytes -= bytes.length;
  return Object.freeze({ digest: frameDigest(kind, bytes), kind, bytes: bytes.length });
}

/**
 * Digests one worktree or untracked entry, retrying exactly once.
 *
 * One retry, not a loop: a single retry absorbs the common case of an editor
 * rewriting a file at the moment we looked, while a loop would let a
 * continuously-churning tree masquerade as a stable observation. When the retry
 * also fails the caller is expected to discard the whole attempt.
 */
export async function digestWorkspaceEntry(absolutePath, {
  expect = "any",
  budget,
  lstatFn = lstat,
  openFn = open,
  readlinkFn = readlink
} = {}) {
  const dependencies = { expect, budget, lstatFn, openFn, readlinkFn };
  try {
    return await digestOnce(absolutePath, dependencies);
  } catch (error) {
    const retryable =
      (error instanceof WorkspaceDigestError && error.reason === "content_unstable") ||
      RETRYABLE_ERRNO.has(error?.code);
    if (!retryable) {
      if (error instanceof WorkspaceDigestError) throw error;
      fail("content_unreadable", absolutePath, error);
    }
    try {
      return await digestOnce(absolutePath, dependencies);
    } catch (retryError) {
      if (retryError instanceof WorkspaceDigestError) throw retryError;
      fail("content_unreadable", absolutePath, retryError);
    }
  }
}

export function createContentBudget(totalBytes = MAX_CONTENT_BYTES_TOTAL) {
  return { remainingBytes: totalBytes };
}
