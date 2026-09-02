import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_REVIEW_TARGET,
  resolveReviewTargetContext,
  reviewScopeKey,
  reviewTargetSpec,
  validateReviewTargetContext,
  validateReviewTargetSpec
} from "../src/changeset/target.mjs";

const COMMIT = "5".repeat(40);

function gitStub(behaviour) {
  const calls = [];
  return {
    calls,
    runGit: async (args, options) => {
      calls.push({ args, options });
      return behaviour(args);
    }
  };
}

function nonzeroExit() {
  return Object.assign(new Error("bad revision"), {
    code: "supervised_process_failed",
    reason: "nonzero-exit",
    exitCode: 128
  });
}

test("a spec requires a fully-qualified ref and a concrete provenance", () => {
  assert.deepEqual({ ...reviewTargetSpec({}) }, { kind: "none", ref: null, source: "unspecified" });
  assert.deepEqual(
    { ...reviewTargetSpec({ ref: "refs/heads/main", source: "request" }) },
    { kind: "ref", ref: "refs/heads/main", source: "request" }
  );
  assert.throws(() => reviewTargetSpec({ ref: "main", source: "request" }));
  assert.throws(() => reviewTargetSpec({ ref: "origin/main", source: "request" }));
  assert.throws(() => reviewTargetSpec({ ref: "refs/heads/main" }));
  assert.throws(() => reviewTargetSpec({ ref: "refs/heads/main", source: "unspecified" }));
});

test("spec validation refuses shapes that do not agree with themselves", () => {
  assert.ok(validateReviewTargetSpec({ kind: "none", ref: null, source: "unspecified" }));
  assert.equal(validateReviewTargetSpec({ kind: "none", ref: "refs/heads/x", source: "unspecified" }), undefined);
  assert.equal(validateReviewTargetSpec({ kind: "ref", ref: "refs/heads/x", source: "unspecified" }), undefined);
  assert.equal(validateReviewTargetSpec({ kind: "ref", ref: "x", source: "request" }), undefined);
  assert.equal(validateReviewTargetSpec({ kind: "ref", ref: "refs/heads/x", source: "request", extra: 1 }), undefined);
  assert.equal(validateReviewTargetSpec(undefined), undefined);
});

test("a spec with no target resolves without invoking Git at all", async () => {
  const git = gitStub(() => assert.fail("no Git may run for an absent target"));
  const resolved = await resolveReviewTargetContext(NO_REVIEW_TARGET, { cwd: "C:\\repo", runGit: git.runGit });
  assert.equal(resolved.status, "ok");
  assert.deepEqual({ ...resolved.context }, {
    spec: NO_REVIEW_TARGET,
    resolution: "none",
    commit: null
  });
  assert.equal(git.calls.length, 0);
});

test("a resolvable ref yields its commit, via an exact argv", async () => {
  const git = gitStub(() => ({ stdout: COMMIT + "\n" }));
  const spec = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });
  const resolved = await resolveReviewTargetContext(spec, { cwd: "C:\\repo", runGit: git.runGit });

  assert.equal(resolved.context.resolution, "resolved");
  assert.equal(resolved.context.commit, COMMIT);
  assert.deepEqual(git.calls[0].args, [
    "rev-parse", "--verify", "--end-of-options", "refs/remotes/origin/main^{commit}"
  ]);
});

test("a ref that does not resolve is an exact fact, not indeterminacy", async () => {
  // Deleting the target branch genuinely changes what is being reviewed, so
  // this must remain collectable rather than poisoning the whole collection.
  const git = gitStub(() => { throw nonzeroExit(); });
  const spec = reviewTargetSpec({ ref: "refs/remotes/origin/gone", source: "request" });
  const resolved = await resolveReviewTargetContext(spec, { cwd: "C:\\repo", runGit: git.runGit });

  assert.equal(resolved.status, "ok");
  assert.equal(resolved.context.resolution, "unresolved");
  assert.equal(resolved.context.commit, null);
});

test("a timeout or spawn failure is indeterminate, never unresolved", async () => {
  for (const [code, expected] of [
    ["collection_deadline_exceeded", "collection_deadline_exceeded"],
    ["supervised_process_timeout", "git_command_timeout"],
    ["supervised_process_spawn_failed", "git_command_failed"],
    ["supervised_process_output_overflow", "git_command_failed"]
  ]) {
    const git = gitStub(() => { throw Object.assign(new Error("x"), { code }); });
    const spec = reviewTargetSpec({ ref: "refs/heads/main", source: "request" });
    const resolved = await resolveReviewTargetContext(spec, { cwd: "C:\\repo", runGit: git.runGit });
    assert.equal(resolved.status, "indeterminate");
    assert.equal(resolved.reasons[0].code, expected);
  }
});

test("unusable rev-parse output is indeterminate rather than trusted", async () => {
  const git = gitStub(() => ({ stdout: "not-a-commit\n" }));
  const spec = reviewTargetSpec({ ref: "refs/heads/main", source: "request" });
  const resolved = await resolveReviewTargetContext(spec, { cwd: "C:\\repo", runGit: git.runGit });
  assert.equal(resolved.status, "indeterminate");
  assert.equal(resolved.reasons[0].code, "git_command_failed");
});

test("object id width is enforced per repository hash algorithm", async () => {
  const sha256 = "c".repeat(64);
  const spec = reviewTargetSpec({ ref: "refs/heads/main", source: "request" });

  const wide = await resolveReviewTargetContext(spec, {
    cwd: "C:\\repo",
    runGit: gitStub(() => ({ stdout: sha256 })).runGit,
    objectFormat: "sha256"
  });
  assert.equal(wide.context.commit, sha256);

  const mismatched = await resolveReviewTargetContext(spec, {
    cwd: "C:\\repo",
    runGit: gitStub(() => ({ stdout: sha256 })).runGit,
    objectFormat: "sha1"
  });
  assert.equal(mismatched.status, "indeterminate");
});

test("the same spec resolved twice can produce different contexts when the ref moves", async () => {
  const spec = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });
  const first = await resolveReviewTargetContext(spec, {
    cwd: "C:\\repo",
    runGit: gitStub(() => ({ stdout: "a".repeat(40) })).runGit
  });
  const second = await resolveReviewTargetContext(spec, {
    cwd: "C:\\repo",
    runGit: gitStub(() => ({ stdout: "b".repeat(40) })).runGit
  });

  // Durable intent is identical; the live observation is not. That gap is what
  // makes a moving target able to stale a review.
  assert.deepEqual(first.context.spec, second.context.spec);
  assert.notEqual(first.context.commit, second.context.commit);
});

test("buffer stdout is accepted as readily as string stdout", async () => {
  const git = gitStub(() => ({ stdout: Buffer.from(COMMIT + "\n", "utf8") }));
  const spec = reviewTargetSpec({ ref: "refs/heads/main", source: "request" });
  const resolved = await resolveReviewTargetContext(spec, { cwd: "C:\\repo", runGit: git.runGit });
  assert.equal(resolved.context.commit, COMMIT);
});

test("context validation ties resolution, commit and spec together", () => {
  const spec = { kind: "ref", ref: "refs/heads/main", source: "request" };
  assert.ok(validateReviewTargetContext({ spec, resolution: "resolved", commit: COMMIT }));
  assert.equal(validateReviewTargetContext({ spec, resolution: "resolved", commit: null }), undefined);
  assert.equal(validateReviewTargetContext({ spec, resolution: "unresolved", commit: COMMIT }), undefined);
  assert.equal(validateReviewTargetContext({ spec, resolution: "none", commit: null }), undefined);
  assert.equal(
    validateReviewTargetContext({ spec: NO_REVIEW_TARGET, resolution: "resolved", commit: COMMIT }),
    undefined
  );
  assert.ok(validateReviewTargetContext({ spec: NO_REVIEW_TARGET, resolution: "none", commit: null }));
});

test("the review scope key is stable across repository state and distinguishes targets", () => {
  const withMain = reviewScopeKey({
    agentType: "code-review",
    targetSpec: reviewTargetSpec({ ref: "refs/heads/main", source: "request" })
  });
  // Provenance must not split the scope: the same ref inherited from a worktree
  // is the same review scope as the same ref supplied by hand.
  const inherited = reviewScopeKey({
    agentType: "code-review",
    targetSpec: reviewTargetSpec({ ref: "refs/heads/main", source: "worktree-metadata" })
  });
  assert.equal(withMain, inherited);

  assert.notEqual(withMain, reviewScopeKey({
    agentType: "security-review",
    targetSpec: reviewTargetSpec({ ref: "refs/heads/main", source: "request" })
  }));
  assert.notEqual(withMain, reviewScopeKey({
    agentType: "code-review",
    targetSpec: reviewTargetSpec({ ref: "refs/heads/other", source: "request" })
  }));
  assert.notEqual(withMain, reviewScopeKey({ agentType: "code-review", targetSpec: NO_REVIEW_TARGET }));
});
