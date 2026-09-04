import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EVIDENCE_COMPLETENESS,
  REVIEW_EVIDENCE_SCHEMA,
  collectCommittedReviewEvidence,
  formatCommittedEvidenceBlock,
  reviewEvidenceIdentity
} from "../src/review/committed-evidence.mjs";
import { repositoryIdForCanonicalRootKey } from "../src/write-custody.mjs";

/**
 * What a reviewer is actually shown when the worktree is clean.
 *
 * A reviewer has Read, Grep and Glob and no shell, so it cannot run Git and
 * cannot discover its own subject. On a clean committed worktree the change set
 * is empty by construction, so without an explicit committed basis the reviewer
 * would be asked to review "commit B against base A" while being handed
 * nothing - and the only way it could say anything true would be for a human to
 * paste a diff, which is not evidence anyone can later verify.
 *
 * These tests pin the basis itself: the exact range, the exact per-path
 * statuses including renames, deletions and binaries, the exact patch, and an
 * explicit completeness state. They also pin the thing that makes the basis
 * worth having - that its identity changes when the delta changes, so a receipt
 * can prove which committed delta a result was produced from rather than merely
 * which commit HEAD happened to be at.
 */

const TARGET_REF = "refs/heads/base";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + (result.stderr || result.stdout));
  return result.stdout.trim();
}

async function withRepository(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-committed-"));
  const repository = path.join(root, "repository");
  try {
    await mkdir(repository, { recursive: true });
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Committed Review Test"]);
    git(repository, ["config", "user.email", "committed@example.invalid"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    git(repository, ["config", "core.autocrlf", "false"]);
    await callback({ repository });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

/** Commit A, branch `base` at A, then commit B on main. */
async function baseAndHead(repository, mutate) {
  await writeFile(path.join(repository, "bug.js"), "export const answer = 41;\n", "utf8");
  await writeFile(path.join(repository, "keep.txt"), "unchanged\n", "utf8");
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-m", "A"]);
  git(repository, ["branch", "base"]);
  await mutate();
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-m", "B"]);
  return { base: git(repository, ["rev-parse", "base"]), head: git(repository, ["rev-parse", "HEAD"]) };
}

const collect = (repository, extra = {}) => collectCommittedReviewEvidence({
  repositoryRoot: repository,
  repositoryId: repositoryIdForCanonicalRootKey(repository.toLowerCase()),
  target: { spec: { kind: "ref", ref: TARGET_REF, source: "request" } },
  ...extra
});

test("a clean committed worktree yields the exact A..B evidence", async () => {
  await withRepository(async ({ repository }) => {
    const { base, head } = await baseAndHead(repository, async () => {
      await writeFile(path.join(repository, "bug.js"), "export const answer = 42;\n", "utf8");
    });
    // The worktree is clean: `git status` would report nothing at all, which is
    // precisely why the change set cannot be the subject here.
    assert.equal(git(repository, ["status", "--porcelain"]), "");

    const evidence = await collect(repository);
    assert.equal(evidence.completeness, EVIDENCE_COMPLETENESS.COMPLETE);
    assert.equal(evidence.base.ref, TARGET_REF);
    assert.equal(evidence.base.commit, base);
    assert.equal(evidence.head, head);
    assert.equal(evidence.mergeBase, base);
    assert.deepEqual(evidence.files.map((file) => [file.status, file.path]), [["M", "bug.js"]]);
    assert.equal(evidence.filesTruncated, false);
    assert.equal(evidence.patchTruncated, false);
    // The exact textual patch, not a summary of it.
    assert.match(evidence.patch, /-export const answer = 41;/u);
    assert.match(evidence.patch, /\+export const answer = 42;/u);
    assert.doesNotMatch(evidence.patch, /keep\.txt/u);

    // And the reviewer is handed that patch verbatim.
    const block = formatCommittedEvidenceBlock(evidence);
    assert.match(block, /COMMITTED REVIEW EVIDENCE/u);
    assert.match(block, new RegExp(head, "u"));
    assert.match(block, new RegExp(base, "u"));
    assert.match(block, /\+export const answer = 42;/u);
  });
});

test("renames, deletions and binary changes are represented deterministically", async () => {
  await withRepository(async ({ repository }) => {
    await writeFile(path.join(repository, "gone.txt"), "delete me\n", "utf8");
    await writeFile(
      path.join(repository, "moved.txt"),
      Array.from({ length: 40 }, (_, index) => "stable line " + index).join("\n") + "\n",
      "utf8"
    );
    await writeFile(path.join(repository, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
    await baseAndHead(repository, async () => {
      await rm(path.join(repository, "gone.txt"));
      git(repository, ["mv", "moved.txt", "renamed.txt"]);
      await writeFile(path.join(repository, "image.bin"), Buffer.from([9, 9, 0, 3, 0, 200, 1, 4]));
      await writeFile(path.join(repository, "added.js"), "export const added = true;\n", "utf8");
    });

    const evidence = await collect(repository);
    assert.equal(evidence.completeness, EVIDENCE_COMPLETENESS.COMPLETE);
    const byPath = new Map(evidence.files.map((file) => [file.path, file]));

    assert.equal(byPath.get("gone.txt").status, "D");
    assert.equal(byPath.get("added.js").status, "A");
    const renamed = byPath.get("renamed.txt");
    assert.equal(renamed.status, "R");
    assert.equal(renamed.originPath, "moved.txt", "a rename must keep the path it came from");
    assert.equal(byPath.get("image.bin").binary, true, "a binary change must be marked as one");
    assert.equal(byPath.get("added.js").binary, false);

    const block = formatCommittedEvidenceBlock(evidence);
    assert.match(block, /renamed moved\.txt -> renamed\.txt/u);
    assert.match(block, /deleted gone\.txt/u);
    assert.match(block, /image\.bin   \[binary\]/u);
  });
});

test("the evidence identity changes exactly when the committed delta changes", async () => {
  await withRepository(async ({ repository }) => {
    await baseAndHead(repository, async () => {
      await writeFile(path.join(repository, "bug.js"), "export const answer = 42;\n", "utf8");
    });
    const first = reviewEvidenceIdentity(await collect(repository));
    assert.equal(first.schema, REVIEW_EVIDENCE_SCHEMA);
    assert.equal(first.completeness, EVIDENCE_COMPLETENESS.COMPLETE);
    assert.match(first.sha256, /^[0-9a-f]{64}$/u);

    // Re-deriving the same delta reproduces the same identity.
    assert.equal(reviewEvidenceIdentity(await collect(repository)).sha256, first.sha256);

    // A different committed delta is a different basis, and must not be able to
    // wear the same identity.
    await writeFile(path.join(repository, "bug.js"), "export const answer = 43;\n", "utf8");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-m", "C"]);
    const second = reviewEvidenceIdentity(await collect(repository));
    assert.notEqual(second.sha256, first.sha256);

    // So is the same content reached through a different path.
    git(repository, ["mv", "bug.js", "renamed-bug.js"]);
    git(repository, ["commit", "-am", "D"]);
    assert.notEqual(reviewEvidenceIdentity(await collect(repository)).sha256, second.sha256);
  });
});

test("evidence that cannot be established is unavailable with a stable reason", async () => {
  await withRepository(async ({ repository }) => {
    await baseAndHead(repository, async () => {
      await writeFile(path.join(repository, "bug.js"), "export const answer = 42;\n", "utf8");
    });

    // A target that does not resolve is not a base, and guessing one would
    // review a delta nobody asked for.
    const unresolved = await collectCommittedReviewEvidence({
      repositoryRoot: repository,
      target: { spec: { kind: "ref", ref: "refs/heads/does-not-exist", source: "request" } }
    });
    assert.equal(unresolved.completeness, EVIDENCE_COMPLETENESS.UNAVAILABLE);
    assert.deepEqual(unresolved.reasons.map((reason) => reason.code), ["review_target_unresolved"]);

    // No declared target at all.
    const untargeted = await collectCommittedReviewEvidence({
      repositoryRoot: repository,
      target: { spec: { kind: "none" } }
    });
    assert.equal(untargeted.completeness, EVIDENCE_COMPLETENESS.UNAVAILABLE);
    assert.deepEqual(untargeted.reasons.map((reason) => reason.code), ["review_target_not_declared"]);

    // A repository that cannot be inspected at all reports the fact rather than
    // throwing it into the delegation.
    const missing = await collectCommittedReviewEvidence({
      repositoryRoot: path.join(repository, "does-not-exist"),
      target: { spec: { kind: "ref", ref: TARGET_REF, source: "request" } }
    });
    assert.equal(missing.completeness, EVIDENCE_COMPLETENESS.UNAVAILABLE);

    // Unavailable evidence still has an identity, and it is not a complete one.
    const identity = reviewEvidenceIdentity(unresolved);
    assert.equal(identity.completeness, EVIDENCE_COMPLETENESS.UNAVAILABLE);
    assert.match(identity.sha256, /^[0-9a-f]{64}$/u);

    const block = formatCommittedEvidenceBlock(unresolved);
    assert.match(block, /could not be produced/u);
    assert.match(block, /Do not report a clean or complete review/u);
  });
});

test("evidence beyond its bound is reported truncated, never silently trimmed", async () => {
  await withRepository(async ({ repository }) => {
    await baseAndHead(repository, async () => {
      await writeFile(
        path.join(repository, "bug.js"),
        Array.from({ length: 400 }, (_, index) => "export const line" + index + " = " + index + ";").join("\n") + "\n",
        "utf8"
      );
    });

    const truncated = await collect(repository, { maxPatchBytes: 200 });
    assert.equal(truncated.completeness, EVIDENCE_COMPLETENESS.TRUNCATED);
    assert.equal(truncated.patchTruncated, true);
    assert.ok(truncated.patch.length <= 200);
    // The full patch is still what the identity is taken over, so a trimmed
    // rendering cannot masquerade as a different, smaller delta.
    assert.ok(truncated.patchBytes > 200);
    assert.match(formatCommittedEvidenceBlock(truncated), /PATCH TRUNCATED/u);

    // Truncation is visible in the identity itself, so a caller can refuse
    // without reading the text.
    assert.equal(reviewEvidenceIdentity(truncated).completeness, EVIDENCE_COMPLETENESS.TRUNCATED);

    const byFiles = await collect(repository, { maxFiles: 0 });
    assert.equal(byFiles.completeness, EVIDENCE_COMPLETENESS.TRUNCATED);
    assert.equal(byFiles.filesTruncated, true);
  });
});
