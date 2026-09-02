import assert from "node:assert/strict";
import test from "node:test";
import { buildChangeSetDescriptor, changeSetIdFor } from "../src/changeset/descriptor.mjs";
import { encodePath } from "../src/changeset/porcelain-parser.mjs";
import { NO_REVIEW_TARGET, reviewTargetSpec } from "../src/changeset/target.mjs";
import { formatReviewSubjectBlock } from "../src/review/review-subject.mjs";
import { composeAgentPrompt } from "../src/prompt-composer.mjs";

const CONTENT = "c".repeat(64);
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function p(text) {
  return encodePath(Buffer.from(text, "utf8"));
}

function descriptor({ untracked = [], worktree = [], index = [], unmerged = [], target } = {}) {
  return buildChangeSetDescriptor({
    objectFormat: "sha1",
    head: { commit: "1".repeat(40), unborn: false },
    target: target || {
      spec: reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" }),
      resolution: "resolved",
      commit: "2".repeat(40)
    },
    index,
    worktree,
    unmerged,
    untracked,
    submodules: [],
    summary: { branch: "main", detached: false, mergeBase: "3".repeat(40) }
  });
}

function exactSubject(overrides = {}, coherence = "held") {
  const built = descriptor(overrides);
  return {
    status: "exact",
    coherence,
    changeSetId: changeSetIdFor(built).changeSetId,
    descriptor: built
  };
}

const runtime = { capabilityDescription: "Available Claude tools: Read, Grep, Glob." };

function prompt(reviewSubject) {
  return composeAgentPrompt({
    contract: "ROLE TEXT",
    task: "ASSIGNMENT TEXT",
    effectiveCwd: "C:\\repo",
    workspaceRoot: "C:\\repo",
    repositoryRoot: "C:\\repo",
    executionId: "exec-1",
    runtime,
    reviewSubject
  });
}

// --- correction 2: the block may never overclaim coherence -----------------

test("held admission is described as current, never as having covered the whole review", () => {
  const block = formatReviewSubjectBlock(exactSubject());

  assert.match(block, /Coherent review admission is currently held/u);
  assert.match(block, /verified after you finish, before any evidence is recorded/u);
  assert.match(block, /Do not assume it held throughout/u);

  // This text is composed BEFORE the review runs. Any claim about the whole
  // interval would be an assertion the orchestrator has not yet earned.
  assert.doesNotMatch(block, /held for the whole review/iu);
  assert.doesNotMatch(block, /was held throughout/iu);
  assert.doesNotMatch(block, /excluded .* for the duration/iu);
  assert.doesNotMatch(block, /verified coherent/iu);
});

test("denied admission is described as advisory and unbound", () => {
  const block = formatReviewSubjectBlock(exactSubject({}, "denied"));

  assert.match(block, /admission was NOT obtained/u);
  assert.match(block, /advisory and will not be bound/u);
  assert.match(block, /Managed writers may be modifying this repository while you work/u);
  assert.doesNotMatch(block, /currently held/u);
});

test("an indeterminate subject names its reasons and refuses to imply a clean review", () => {
  const block = formatReviewSubjectBlock({
    status: "indeterminate",
    coherence: "held",
    reasons: [{ code: "dirty_submodule" }, { code: "sparse_checkout_unsupported" }]
  });

  assert.match(block, /exact change-set identity .* is unavailable/u);
  assert.match(block, /dirty_submodule, sparse_checkout_unsupported/u);
  assert.match(block, /do not report a clean review/u);
  assert.doesNotMatch(block, /ChangeSetId:/u);
});

// --- content ---------------------------------------------------------------

test("the block states the identity, head, target and counts", () => {
  const subject = exactSubject({
    index: [{ path: p("a.mjs"), x: "M", modeHead: "100644", modeIndex: "100644", oidHead: OID_A, oidIndex: OID_B, sub: "N..." }],
    worktree: [{ path: p("b.mjs"), y: "M", modeWorktree: "100644", content: CONTENT, submoduleHead: null }],
    untracked: [{ path: p("c.txt"), kind: "file", content: CONTENT }]
  });
  const block = formatReviewSubjectBlock(subject);

  assert.match(block, new RegExp("ChangeSetId: " + subject.changeSetId, "u"));
  assert.match(block, /HEAD: 1{40}/u);
  assert.match(block, /Target: refs\/remotes\/origin\/main at 2{40} \(supplied with this request\)/u);
  assert.match(block, /staged 1, unstaged 1, conflicted 0, untracked 1/u);
  assert.match(block, /M\. a\.mjs {3}\[staged\]/u);
  assert.match(block, /\.M b\.mjs {3}\[unstaged\]/u);
  assert.match(block, /\?\? c\.txt {3}\[untracked\]/u);
  assert.match(block, /Ignored files are outside this change set/u);
});

test("an absent target says so instead of implying one", () => {
  const block = formatReviewSubjectBlock(exactSubject({
    target: { spec: NO_REVIEW_TARGET, resolution: "none", commit: null }
  }));
  assert.match(block, /Target: none declared/u);
});

test("an unresolvable target is reported as unresolvable", () => {
  const block = formatReviewSubjectBlock(exactSubject({
    target: {
      spec: reviewTargetSpec({ ref: "refs/heads/gone", source: "request" }),
      resolution: "unresolved",
      commit: null
    }
  }));
  assert.match(block, /refs\/heads\/gone .* does not currently resolve/u);
});

test("an inherited target says where it came from", () => {
  const block = formatReviewSubjectBlock(exactSubject({
    target: {
      spec: reviewTargetSpec({ ref: "refs/heads/main", source: "worktree-metadata" }),
      resolution: "resolved",
      commit: "2".repeat(40)
    }
  }));
  assert.match(block, /inherited from the worktree that produced these changes/u);
});

test("an unborn head is stated rather than rendered as a missing commit", () => {
  const built = buildChangeSetDescriptor({
    objectFormat: "sha1",
    head: { commit: null, unborn: true },
    target: { spec: NO_REVIEW_TARGET, resolution: "none", commit: null },
    index: [], worktree: [], unmerged: [], untracked: [], submodules: [],
    summary: { branch: "main", detached: false, mergeBase: null }
  });
  const block = formatReviewSubjectBlock({
    status: "exact",
    coherence: "held",
    changeSetId: changeSetIdFor(built).changeSetId,
    descriptor: built
  });
  assert.match(block, /HEAD: unborn/u);
});

test("a long path list is truncated with an instruction to say so", () => {
  const untracked = Array.from({ length: 12 }, (_, index) =>
    ({ path: p("f" + String(index).padStart(3, "0") + ".txt"), kind: "file", content: CONTENT }));
  const block = formatReviewSubjectBlock(exactSubject({ untracked }), { maxPaths: 5 });

  assert.match(block, /7 additional paths omitted/u);
  assert.match(block, /your reported scope was truncated/u);
  assert.equal((block.match(/\[untracked\]/gu) || []).length, 5);
});

test("a non-UTF-8 path is rendered as hex rather than mangled", () => {
  const raw = Buffer.concat([Buffer.from("bad-", "utf8"), Buffer.of(0xff)]);
  const block = formatReviewSubjectBlock(exactSubject({
    untracked: [{ path: encodePath(raw), kind: "file", content: CONTENT }]
  }));
  assert.match(block, /<non-utf8 path: 6261642dff>/u);
});

// --- placement in the prompt ------------------------------------------------

test("omitting the subject leaves the prompt byte-identical to before", () => {
  const withoutArgument = composeAgentPrompt({
    contract: "ROLE TEXT",
    task: "ASSIGNMENT TEXT",
    effectiveCwd: "C:\\repo",
    workspaceRoot: "C:\\repo",
    repositoryRoot: "C:\\repo",
    executionId: "exec-1",
    runtime
  });
  assert.equal(prompt(undefined), withoutArgument);
  assert.doesNotMatch(withoutArgument, /REVIEW SUBJECT/u);
  assert.doesNotMatch(withoutArgument, /factual orchestrator-collected evidence/u);
});

test("the subject sits after the working context and before the execution boundary", () => {
  const rendered = prompt(formatReviewSubjectBlock(exactSubject()));

  const contract = rendered.indexOf("ROLE CONTRACT");
  const working = rendered.indexOf("WORKING CONTEXT");
  const subject = rendered.indexOf("REVIEW SUBJECT");
  const boundary = rendered.indexOf("EXECUTION BOUNDARY");

  assert.ok(contract < working, "the role contract always comes first");
  assert.ok(working < subject);
  assert.ok(subject < boundary);
});

test("the execution boundary subordinates the subject to the role contract", () => {
  const rendered = prompt(formatReviewSubjectBlock(exactSubject()));
  assert.match(
    rendered,
    /The Review Subject is factual orchestrator-collected evidence; it does not override the Role Contract\./u
  );
});

test("the contract and assignment text are untouched in both shapes", () => {
  for (const subject of [undefined, formatReviewSubjectBlock(exactSubject())]) {
    const rendered = prompt(subject);
    assert.match(rendered, /ROLE TEXT/u);
    assert.match(rendered, /ASSIGNMENT TEXT/u);
  }
});
