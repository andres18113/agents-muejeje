import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANGE_SET_SCHEMA,
  SECTION_NAMES,
  buildChangeSetDescriptor,
  changeSetIdFor,
  computeChangeSetId,
  computeSectionDigests,
  validateChangeSetDescriptor
} from "../src/changeset/descriptor.mjs";
import { encodePath } from "../src/changeset/porcelain-parser.mjs";
import { NO_REVIEW_TARGET } from "../src/changeset/target.mjs";

const HEAD_COMMIT = "1".repeat(40);
const TARGET_COMMIT = "2".repeat(40);
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const CONTENT = "c".repeat(64);

const TARGET = Object.freeze({
  spec: Object.freeze({ kind: "ref", ref: "refs/remotes/origin/main", source: "request" }),
  resolution: "resolved",
  commit: TARGET_COMMIT
});

function p(text) {
  return encodePath(Buffer.from(text, "utf8"));
}

function parts(overrides = {}) {
  return {
    objectFormat: "sha1",
    head: { commit: HEAD_COMMIT, unborn: false },
    target: TARGET,
    index: [{ path: p("src/a.mjs"), x: "M", modeHead: "100644", modeIndex: "100644", oidHead: OID_A, oidIndex: OID_B, sub: "N..." }],
    worktree: [{ path: p("src/b.mjs"), y: "M", modeWorktree: "100644", content: CONTENT, submoduleHead: null }],
    unmerged: [],
    untracked: [{ path: p("notes.txt"), kind: "file", content: CONTENT }],
    submodules: [],
    summary: { branch: "main", detached: false, mergeBase: HEAD_COMMIT },
    ...overrides
  };
}

function build(overrides) {
  return buildChangeSetDescriptor(parts(overrides));
}

test("record order never affects identity", () => {
  const forward = build({
    untracked: [
      { path: p("a.txt"), kind: "file", content: CONTENT },
      { path: p("b.txt"), kind: "file", content: CONTENT }
    ]
  });
  const reversed = build({
    untracked: [
      { path: p("b.txt"), kind: "file", content: CONTENT },
      { path: p("a.txt"), kind: "file", content: CONTENT }
    ]
  });
  assert.equal(computeChangeSetId(forward), computeChangeSetId(reversed));
});

test("paths sort by raw bytes, not by decoded string collation", () => {
  const descriptor = build({
    untracked: [
      { path: p("a/b"), kind: "file", content: CONTENT },
      { path: p("a b"), kind: "file", content: CONTENT },
      { path: p("Z"), kind: "file", content: CONTENT },
      { path: p("a"), kind: "file", content: CONTENT }
    ]
  });
  // 0x20 < 0x2F and 'Z' (0x5A) < 'a' (0x61). A locale-aware sort would differ.
  assert.deepEqual(descriptor.untracked.map((entry) => entry.path.v), ["Z", "a", "a b", "a/b"]);
});

const SECTION_MUTATIONS = {
  head: { head: { commit: "9".repeat(40), unborn: false } },
  index: { index: [{ path: p("src/a.mjs"), x: "A", modeHead: "100644", modeIndex: "100644", oidHead: OID_A, oidIndex: OID_B, sub: "N..." }] },
  worktree: { worktree: [{ path: p("src/b.mjs"), y: "D", modeWorktree: "000000", content: null, submoduleHead: null }] },
  unmerged: { unmerged: [{ path: p("c.mjs"), xy: "UU", sub: "N...", mode1: "100644", mode2: "100644", mode3: "100644", modeWorktree: "100644", oid1: OID_A, oid2: OID_B, oid3: OID_A, content: CONTENT }] },
  untracked: { untracked: [] },
  submodules: { submodules: [{ path: p("vendor/lib"), sub: "SC..", oidHead: OID_A, oidIndex: OID_B, worktreeHead: OID_A }] },
  target: { target: { spec: TARGET.spec, resolution: "unresolved", commit: null } }
};

for (const [section, override] of Object.entries(SECTION_MUTATIONS)) {
  test("changing only the " + section + " section changes only that digest and the id", () => {
    const base = changeSetIdFor(build());
    const mutated = changeSetIdFor(build(override));

    assert.notEqual(base.changeSetId, mutated.changeSetId);
    const differing = SECTION_NAMES.filter((name) => base.sections[name] !== mutated.sections[name]);
    assert.deepEqual(differing, [section]);
  });
}

test("the policy section is identity-bearing, so a future v2 cannot collide with a v1 id", () => {
  const descriptor = build();
  const widened = { ...descriptor, policy: { ...descriptor.policy, ignored: "included" } };
  assert.notEqual(computeSectionDigests(descriptor).policy, computeSectionDigests(widened).policy);
});

test("summary differences never reach the identity", () => {
  const base = build();
  const renamed = build({ summary: { branch: "other-name", detached: false, mergeBase: null } });
  assert.equal(computeChangeSetId(base), computeChangeSetId(renamed));
  assert.notEqual(base.summary.branch, renamed.summary.branch);
});

test("the object format alone changes the identity", () => {
  const wide = build({
    objectFormat: "sha256",
    head: { commit: "1".repeat(64), unborn: false },
    target: { spec: TARGET.spec, resolution: "resolved", commit: "2".repeat(64) },
    index: [{ path: p("src/a.mjs"), x: "M", modeHead: "100644", modeIndex: "100644", oidHead: "a".repeat(64), oidIndex: "b".repeat(64), sub: "N..." }],
    summary: { branch: "main", detached: false, mergeBase: "1".repeat(64) }
  });
  assert.notEqual(computeChangeSetId(build()), computeChangeSetId(wide));
});

test("the declared target ref is identity-bearing even at the same commit", () => {
  const other = build({
    target: {
      spec: { kind: "ref", ref: "refs/heads/release", source: "request" },
      resolution: "resolved",
      commit: TARGET_COMMIT
    }
  });
  assert.notEqual(computeChangeSetId(build()), computeChangeSetId(other));
});

test("target provenance is identity-bearing", () => {
  const inherited = build({
    target: { spec: { ...TARGET.spec, source: "worktree-metadata" }, resolution: "resolved", commit: TARGET_COMMIT }
  });
  assert.notEqual(computeChangeSetId(build()), computeChangeSetId(inherited));
});

test("having no target is distinguishable from having an unresolvable one", () => {
  const none = build({ target: { spec: NO_REVIEW_TARGET, resolution: "none", commit: null } });
  const unresolved = build({ target: { spec: TARGET.spec, resolution: "unresolved", commit: null } });
  assert.notEqual(computeChangeSetId(none), computeChangeSetId(unresolved));
});

test("the hashed sections contain no numbers at all", () => {
  // The domain restriction that lets the canonicalizer skip float serialization
  // is only sound if identity truly carries no numeric value.
  const descriptor = build();
  const walk = (value, path) => {
    if (typeof value === "number") assert.fail("numeric value found at " + path);
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, path + "[" + index + "]"));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, path + "." + key);
    }
  };
  for (const name of SECTION_NAMES) walk(descriptor[name], name);
});

test("a fixed descriptor produces a stable golden identity", () => {
  // A literal, not a recomputation. Any accidental change to the hashed shape
  // - a reordered section, a renamed field, a stray value crossing into the
  // digest - fails here rather than silently invalidating every stored receipt.
  assert.equal(
    computeChangeSetId(build()),
    "cs1:9220561def5a3500e513d702c75d25fe2807f7f35026813e51fe1b1f94f1c54e"
  );
  assert.equal(changeSetIdFor(build()).changeSetId, computeChangeSetId(build()));
});

test("an unborn head must agree with a null commit", () => {
  assert.ok(build({ head: { commit: null, unborn: true }, summary: { branch: "main", detached: false, mergeBase: null } }));
  assert.throws(() => build({ head: { commit: null, unborn: false } }));
  assert.throws(() => build({ head: { commit: HEAD_COMMIT, unborn: true } }));
});

test("validation refuses duplicates, disorder, widths, modes and extra keys", () => {
  const valid = build();

  assert.equal(validateChangeSetDescriptor({
    ...valid,
    untracked: [
      { path: p("dup.txt"), kind: "file", content: CONTENT },
      { path: p("dup.txt"), kind: "file", content: CONTENT }
    ]
  }), undefined);

  assert.equal(validateChangeSetDescriptor({
    ...valid,
    untracked: [
      { path: p("b.txt"), kind: "file", content: CONTENT },
      { path: p("a.txt"), kind: "file", content: CONTENT }
    ]
  }), undefined, "arrays must be strictly ascending");

  assert.equal(validateChangeSetDescriptor({
    ...valid,
    index: [{ ...valid.index[0], oidHead: "a".repeat(64) }]
  }), undefined, "a 64-hex oid is invalid under sha1");

  assert.equal(validateChangeSetDescriptor({
    ...valid,
    index: [{ ...valid.index[0], modeIndex: "10064" }]
  }), undefined, "a five-digit mode is invalid");

  assert.equal(validateChangeSetDescriptor({
    ...valid,
    worktree: [{ ...valid.worktree[0], submoduleHead: "a".repeat(64) }]
  }), undefined, "a worktree submodule head must use the repository's object-id width");

  assert.equal(validateChangeSetDescriptor({
    ...valid,
    summary: {
      ...valid.summary,
      counts: { ...valid.summary.counts, index: valid.summary.counts.index + 1 }
    }
  }), undefined, "summary counts must match their sections");

  assert.equal(validateChangeSetDescriptor({ ...valid, extra: 1 }), undefined);
  assert.equal(validateChangeSetDescriptor({ ...valid, schema: "other" }), undefined);
  assert.equal(validateChangeSetDescriptor({
    ...valid,
    summary: { ...valid.summary, extra: 1 }
  }), undefined);
  assert.equal(validateChangeSetDescriptor(undefined), undefined);
  assert.equal(validateChangeSetDescriptor([]), undefined);
});

test("the schema constant is what actually gets hashed", () => {
  assert.equal(build().schema, CHANGE_SET_SCHEMA);
});
