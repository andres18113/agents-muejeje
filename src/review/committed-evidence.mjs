import { runGitCommand } from "../git-command.mjs";
import { canonicalJson, sha256Hex } from "../canonical-json.mjs";

/**
 * The committed delta a final review is actually about.
 *
 * A reviewer runs with Read, Grep and Glob and no shell, so it cannot run Git
 * and cannot discover its own subject. On a dirty worktree the change-set
 * collector supplies that subject. On a clean committed worktree it supplies
 * nothing at all - every count is zero - and a review of "commit B against its
 * intended base A" would otherwise be a review of an empty change set, or of
 * whatever a human happened to paste. Neither is evidence.
 *
 * This module produces that missing subject deterministically: the exact range,
 * the exact per-path statuses including renames and deletions, which paths are
 * binary, and the exact textual patch. It states its own completeness rather
 * than quietly trimming, because a truncated patch that still reads as a
 * complete scope is the one failure mode that would make a review wrong instead
 * of merely unavailable.
 *
 * It observes and never mutates: every command here is a read.
 */

export const REVIEW_EVIDENCE_SCHEMA = "claude-agents-mcp/review-evidence/v1";
export const COMMITTED_DELTA_KIND = "committed-delta";

export const MAX_EVIDENCE_PATCH_BYTES = 512 * 1024;
export const MAX_EVIDENCE_FILES = 400;
// The patch is read with headroom so that "did this exceed the bound?" is a
// fact about the diff rather than about the reader's own buffer.
const GIT_READ_HEADROOM_BYTES = 2 * 1024 * 1024;
// Evidence collection is read-only and bounded well inside the review's own
// budget: an unresponsive repository must degrade to unavailable quickly
// rather than consume the interval the review needs.
const EVIDENCE_GIT_TIMEOUT_MS = 20_000;

export const EVIDENCE_COMPLETENESS = Object.freeze({
  COMPLETE: "complete",
  TRUNCATED: "truncated",
  UNAVAILABLE: "unavailable"
});

const OBJECT_ID = /^[0-9a-f]{40,64}$/u;

function unavailable(reasons) {
  return Object.freeze({
    schema: REVIEW_EVIDENCE_SCHEMA,
    kind: COMMITTED_DELTA_KIND,
    completeness: EVIDENCE_COMPLETENESS.UNAVAILABLE,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze({ ...reason })))
  });
}

/**
 * Reads one fact from Git, or reports that it could not be read.
 *
 * Nothing here throws. A repository that cannot be inspected - missing, not a
 * repository, git absent, the read timed out - is a fact this review has to act
 * on, and turning it into an exception would lose the review instead of
 * refusing the claim.
 */
async function readGit(args, options) {
  try {
    const result = await runGitCommand(args, {
      cwd: options.repositoryRoot,
      env: options.env,
      maxOutputBytes: options.maxOutputBytes ?? GIT_READ_HEADROOM_BYTES,
      timeoutMs: options.timeoutMs ?? EVIDENCE_GIT_TIMEOUT_MS,
      disableHooks: true,
      runProcess: options.runProcess
    });
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `--name-status -z` emits NUL-separated fields, and a rename emits three
 * fields rather than two. Parsing it positionally is the only way to keep an
 * origin path attached to the rename it belongs to.
 */
function parseNameStatus(text) {
  const fields = text.split("\u0000").filter((field) => field.length > 0);
  const files = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index];
    const status = code[0];
    if (status === "R" || status === "C") {
      const originPath = fields[index + 1];
      const targetPath = fields[index + 2];
      if (originPath === undefined || targetPath === undefined) return undefined;
      files.push({ status, path: targetPath, originPath, similarity: code.slice(1) || null });
      index += 3;
      continue;
    }
    const changedPath = fields[index + 1];
    if (changedPath === undefined) return undefined;
    files.push({ status, path: changedPath, originPath: null, similarity: null });
    index += 2;
  }
  return files;
}

/**
 * `--numstat -z` reports "-" for both counts exactly when Git treats the blob
 * as binary, which is the only reliable signal available without reading it.
 */
function parseNumstatBinaries(text) {
  const binary = new Set();
  const fields = text.split("\u0000").filter((field) => field.length > 0);
  for (let index = 0; index < fields.length;) {
    const record = fields[index];
    const parts = record.split("\t");
    if (parts.length < 3) {
      index += 1;
      continue;
    }
    const [added, deleted] = parts;
    const isRename = parts[2].length === 0;
    const changedPath = isRename ? fields[index + 2] : parts[2];
    if (added === "-" && deleted === "-" && changedPath !== undefined) binary.add(changedPath);
    index += isRename ? 3 : 1;
  }
  return binary;
}

/**
 * Collects the committed delta between a resolved base and HEAD.
 *
 * The two OIDs come from `frozen`: HEAD's commit and the target's commit as
 * the BEFORE collection captured them. They are never re-resolved here. Refs
 * are mutable, so a fresh resolution could observe a commit the BEFORE
 * subject never contained - the ref moves A->B between BEFORE's resolution
 * and this derivation, moves back B->A before AFTER, and the AFTER comparison
 * then reports a false FRESH over evidence collected from B. Frozen OIDs
 * close that ABA by construction: merge-base and diff become pure functions
 * of immutable commits, so the evidence always describes exactly the subject
 * the receipt binds.
 *
 * Every failure to establish an exact fact returns `unavailable` with a stable
 * reason rather than a partial answer, because the caller's only safe reading
 * of "partial" would be to refuse the review anyway.
 */
export async function collectCommittedReviewEvidence({
  repositoryRoot,
  repositoryId,
  target,
  frozen,
  env,
  runProcess,
  maxPatchBytes = MAX_EVIDENCE_PATCH_BYTES,
  maxFiles = MAX_EVIDENCE_FILES,
  requestContext
}) {
  const options = { repositoryRoot, env, runProcess };
  const ref = target?.spec?.kind === "ref" ? target.spec.ref : undefined;
  if (!ref) return unavailable([{ code: "review_target_not_declared" }]);

  requestContext?.assertActive?.("committed-evidence-head");
  const head = typeof frozen?.headCommit === "string" ? frozen.headCommit.trim() : null;
  if (!OBJECT_ID.test(head ?? "")) return unavailable([{ code: "head_unresolved" }]);

  requestContext?.assertActive?.("committed-evidence-base");
  const base = typeof frozen?.baseCommit === "string" ? frozen.baseCommit.trim() : null;
  if (!OBJECT_ID.test(base ?? "")) return unavailable([{ code: "review_target_unresolved" }]);

  requestContext?.assertActive?.("committed-evidence-merge-base");
  const mergeBaseRaw = (await readGit(["merge-base", base, head], options))?.trim();
  const mergeBase = OBJECT_ID.test(mergeBaseRaw ?? "") ? mergeBaseRaw : null;
  // Without a merge base the two commits share no history, and a diff across
  // unrelated roots is not the delta anyone asked to review.
  if (!mergeBase) return unavailable([{ code: "merge_base_unresolved" }]);

  const range = mergeBase + ".." + head;

  requestContext?.assertActive?.("committed-evidence-status");
  const nameStatus = await readGit(
    ["diff", "--name-status", "-z", "--find-renames", "--no-color", mergeBase, head],
    options
  );
  if (nameStatus === undefined) return unavailable([{ code: "diff_status_unavailable" }]);
  const parsed = parseNameStatus(nameStatus);
  if (!parsed) return unavailable([{ code: "diff_status_malformed" }]);

  requestContext?.assertActive?.("committed-evidence-numstat");
  const numstat = await readGit(["diff", "--numstat", "-z", "--find-renames", mergeBase, head], options);
  if (numstat === undefined) return unavailable([{ code: "diff_numstat_unavailable" }]);
  const binaries = parseNumstatBinaries(numstat);

  const files = parsed.slice(0, maxFiles).map((entry) => Object.freeze({
    status: entry.status,
    path: entry.path,
    originPath: entry.originPath,
    binary: binaries.has(entry.path)
  }));
  const filesTruncated = parsed.length > maxFiles;

  requestContext?.assertActive?.("committed-evidence-patch");
  const patchText = await readGit(
    ["diff", "--patch", "--find-renames", "--no-color", "--no-ext-diff", mergeBase, head],
    options
  );
  if (patchText === undefined) return unavailable([{ code: "diff_patch_unavailable" }]);
  const patchBytes = Buffer.byteLength(patchText, "utf8");
  const patchTruncated = patchBytes > maxPatchBytes;
  const patch = patchTruncated ? patchText.slice(0, maxPatchBytes) : patchText;

  return Object.freeze({
    schema: REVIEW_EVIDENCE_SCHEMA,
    kind: COMMITTED_DELTA_KIND,
    // Truncation is a property of the evidence, never a detail of its
    // rendering: a caller must be able to refuse on it without reading the text.
    completeness: filesTruncated || patchTruncated
      ? EVIDENCE_COMPLETENESS.TRUNCATED
      : EVIDENCE_COMPLETENESS.COMPLETE,
    repositoryId: repositoryId ?? null,
    base: Object.freeze({ ref, commit: base }),
    head,
    mergeBase,
    range,
    files: Object.freeze(files),
    filesTotal: parsed.length,
    filesTruncated,
    patch,
    patchBytes,
    patchTruncated,
    patchSha256: sha256Hex(Buffer.from(patchText, "utf8")),
    reasons: Object.freeze([])
  });
}

/**
 * The identity a ReviewReceipt binds.
 *
 * It digests exactly the facts that determine what was reviewed - the range,
 * the per-path statuses, and the full patch, whether or not the rendered copy
 * was trimmed - so that changing any relevant part of the committed delta
 * changes the identity, while re-deriving the same delta reproduces it.
 */
export function reviewEvidenceIdentity(evidence) {
  if (!evidence || evidence.schema !== REVIEW_EVIDENCE_SCHEMA) return undefined;
  if (evidence.completeness === EVIDENCE_COMPLETENESS.UNAVAILABLE) {
    return Object.freeze({
      schema: REVIEW_EVIDENCE_SCHEMA,
      kind: evidence.kind,
      completeness: EVIDENCE_COMPLETENESS.UNAVAILABLE,
      sha256: sha256Hex(Buffer.from(canonicalJson({
        schema: evidence.schema,
        kind: evidence.kind,
        completeness: evidence.completeness,
        reasons: evidence.reasons ?? []
      }), "utf8"))
    });
  }
  const basis = {
    schema: evidence.schema,
    kind: evidence.kind,
    repositoryId: evidence.repositoryId ?? null,
    base: evidence.base,
    head: evidence.head,
    mergeBase: evidence.mergeBase,
    files: evidence.files.map((file) => ({
      status: file.status,
      path: file.path,
      originPath: file.originPath,
      binary: file.binary
    })),
    filesTotal: evidence.filesTotal,
    patchSha256: evidence.patchSha256,
    patchBytes: evidence.patchBytes
  };
  return Object.freeze({
    schema: REVIEW_EVIDENCE_SCHEMA,
    kind: evidence.kind,
    completeness: evidence.completeness,
    sha256: sha256Hex(Buffer.from(canonicalJson(basis), "utf8"))
  });
}

/**
 * Whether a stored receipt can answer an authoritative committed-final-review.
 *
 * Receipts written before v0.2.2 recorded no committed-review evidence, because
 * none was collected. They remain perfectly good historical objects - readable,
 * their findings recoverable, their freshness computable - and nothing here
 * invalidates them. What they cannot do is stand in for a guarantee that did
 * not exist when they were written: a receipt whose basis was never recorded
 * cannot prove which committed delta it covered, and treating its silence as
 * "the delta was reviewed" would manufacture evidence retroactively.
 *
 * So the older receipt stays visible and stays usable for everything it was
 * always good for, and a committed final review that requires a bound basis
 * needs a new one.
 */
export const LEGACY_EVIDENCE_REASON = "legacy_receipt_without_committed_evidence";

export function receiptSatisfiesCommittedReview(receipt) {
  const evidence = receipt?.evidence;
  if (!evidence) {
    return Object.freeze({ applicable: false, reason: LEGACY_EVIDENCE_REASON });
  }
  if (evidence.kind !== COMMITTED_DELTA_KIND) {
    return Object.freeze({ applicable: false, reason: LEGACY_EVIDENCE_REASON });
  }
  if (evidence.completeness !== EVIDENCE_COMPLETENESS.COMPLETE) {
    return Object.freeze({ applicable: false, reason: "insufficient_review_scope" });
  }
  return Object.freeze({ applicable: true, evidence });
}

const STATUS_LABEL = Object.freeze({
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed"
});

/** Renders the evidence for the reviewer's prompt. */
export function formatCommittedEvidenceBlock(evidence) {
  const title = "COMMITTED REVIEW EVIDENCE";
  const lines = [title, "=".repeat(title.length), ""];
  if (!evidence || evidence.completeness === EVIDENCE_COMPLETENESS.UNAVAILABLE) {
    const codes = (evidence?.reasons ?? []).map((reason) => reason.code).join(", ");
    lines.push(
      "The exact committed delta for this review could not be produced.",
      "Reason: " + (codes || "unknown"),
      "",
      "Do not report a clean or complete review. Report that the review scope could not be " +
        "established and name the missing evidence."
    );
    return lines.join("\n");
  }
  lines.push(
    "Base: " + evidence.base.ref + " at " + evidence.base.commit,
    "HEAD: " + evidence.head,
    "Merge base: " + evidence.mergeBase,
    "Range: " + evidence.range,
    "Completeness: " + evidence.completeness,
    "",
    "Changed paths (" + evidence.filesTotal + " total):"
  );
  for (const file of evidence.files) {
    lines.push(
      "  " + (STATUS_LABEL[file.status] ?? file.status) +
        (file.originPath ? " " + file.originPath + " -> " + file.path : " " + file.path) +
        (file.binary ? "   [binary]" : "")
    );
  }
  if (evidence.filesTruncated) {
    lines.push("  [" + (evidence.filesTotal - evidence.files.length) + " additional paths omitted]");
  }
  lines.push("", "Exact patch for this range:", "", evidence.patch);
  if (evidence.patchTruncated) {
    lines.push(
      "",
      "[PATCH TRUNCATED at " + evidence.patch.length + " of " + evidence.patchBytes + " bytes. " +
        "Your review scope is incomplete: say so explicitly and do not report a complete review.]"
    );
  }
  return lines.join("\n");
}
