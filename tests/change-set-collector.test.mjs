import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  COLLECTOR_REASONS,
  MAX_CHANGE_SET_ENTRIES,
  collectChangeSet
} from "../src/changeset/collector.mjs";
import { NO_REVIEW_TARGET, reviewTargetSpec } from "../src/changeset/target.mjs";

const TOP_LEVEL = "C:\\repo";
const HEAD = "1".repeat(40);
const TARGET = "2".repeat(40);
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

/**
 * Every reason code this suite has actually produced. Asserted at the end so a
 * new refusal path cannot be added without a test that reaches it.
 */
const produced = new Set();

function record(result) {
  if (result.status === "indeterminate") {
    for (const reason of result.reasons) produced.add(reason.code);
  }
  return result;
}

/**
 * Records may be Buffers so a test can put raw non-UTF-8 path bytes into the
 * stream exactly as Git would. `branchOid: null` omits the header entirely.
 */
function statusStream(records, { branchOid = HEAD, branchHead = "main" } = {}) {
  const fields = [
    ...(branchOid === null ? [] : ["# branch.oid " + branchOid]),
    "# branch.head " + branchHead,
    ...records
  ];
  return Buffer.concat(fields.map((field) => Buffer.concat([
    Buffer.isBuffer(field) ? field : Buffer.from(field, "utf8"),
    Buffer.of(0)
  ])));
}

function ordinary(xy, pathText, { sub = "N...", modeWorktree = "100644", oidHead = OID_A, oidIndex = OID_B } = {}) {
  const prefix = "1 " + xy + " " + sub + " 100644 100644 " + modeWorktree + " " + oidHead + " " + oidIndex + " ";
  return Buffer.isBuffer(pathText)
    ? Buffer.concat([Buffer.from(prefix, "utf8"), pathText])
    : prefix + pathText;
}

function untrackedRecord(pathBytes) {
  return Buffer.concat([Buffer.from("? ", "utf8"), pathBytes]);
}

/**
 * A locator is a string for a UTF-8 name and a Buffer of raw bytes otherwise.
 * Keying on both the kind and the exact bytes is what lets a test prove that
 * two paths which share a spelling were never addressed as one file.
 */
function locatorKey(locator) {
  return Buffer.isBuffer(locator) ? "bytes:" + locator.toString("hex") : "text:" + locator;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitRouter(handlers) {
  const calls = [];
  return {
    calls,
    runGit: async (args, options) => {
      calls.push({ args, options });
      const key = args.find((arg) => !arg.startsWith("-")) || args[0];
      if (args[0] === "-C") {
        if (handlers.submodule) return handlers.submodule(args, options);
        throw Object.assign(new Error("no submodule handler"), { code: "supervised_process_failed", reason: "nonzero-exit" });
      }
      if (args.includes("--show-toplevel")) return { stdout: TOP_LEVEL };
      if (args.includes("--show-object-format")) return { stdout: handlers.objectFormat ?? "sha1" };
      if (args.includes("core.sparseCheckout")) return { stdout: handlers.sparse ?? "false" };
      if (key === "status") {
        if (handlers.status) return handlers.status(calls.filter((c) => c.args[1] === "status").length - 1);
        return { stdout: statusStream([]) };
      }
      if (key === "merge-base") {
        if (handlers.mergeBase) return handlers.mergeBase();
        return { stdout: HEAD };
      }
      if (args.includes("--verify")) {
        if (handlers.revParse) return handlers.revParse(args);
        return { stdout: TARGET };
      }
      throw new Error("unexpected git invocation: " + args.join(" "));
    }
  };
}

function fsStubs({ digestable = true } = {}) {
  const stat = () => ({
    size: 4n,
    mtimeNs: 10n,
    ctimeNs: 11n,
    mode: 0o100644n,
    ino: 0n,
    dev: 0n,
    isFile: () => digestable,
    isSymbolicLink: () => false,
    isDirectory: () => !digestable
  });
  return {
    lstatFn: async () => stat(),
    openFn: async () => {
      let done = false;
      return {
        async read(buffer, offset, length) {
          if (done) return { bytesRead: 0 };
          done = true;
          const bytes = Buffer.from("data", "utf8");
          bytes.copy(buffer, 0);
          return { bytesRead: bytes.length };
        },
        async close() {}
      };
    },
    readlinkFn: async () => Buffer.from("target", "utf8")
  };
}

function collect(overrides = {}, dependencies = {}) {
  const git = dependencies.git || gitRouter({});
  return collectChangeSet(
    {
      effectiveCwd: TOP_LEVEL,
      rootSource: "git-boundary",
      canonicalRepositoryKey: "c:\\repo",
      targetSpec: NO_REVIEW_TARGET,
      custodyExpectation: { mode: "observational" },
      ...overrides
    },
    {
      runGit: git.runGit,
      readOwnership: dependencies.readOwnership || (async () => undefined),
      realpathFn: async (value) => value,
      now: dependencies.now,
      ...(dependencies.platform ? { platform: dependencies.platform } : {}),
      ...(dependencies.deadlineMs ? { deadlineMs: dependencies.deadlineMs } : {}),
      ...fsStubs(dependencies.fs || {}),
      ...(dependencies.fsOverrides || {})
    }
  );
}

test("a clean repository collects exactly, with the pinned status argv", async () => {
  const git = gitRouter({});
  const result = record(await collect({}, { git }));

  assert.equal(result.status, "exact");
  assert.match(result.changeSetId, /^cs1:[0-9a-f]{64}$/u);

  const statusCall = git.calls.find((call) => call.args[1] === "status");
  assert.deepEqual(statusCall.args, [
    "--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch",
    "--no-ahead-behind", "--untracked-files=all", "--ignore-submodules=none", "--no-renames"
  ]);
  assert.equal(statusCall.options.encoding, "buffer", "status must be read as raw bytes");
});

test("staged, unstaged, untracked and deleted entries land in the right sections", async () => {
  const git = gitRouter({
    status: () => ({
      stdout: statusStream([
        ordinary("M.", "staged.txt"),
        ordinary(".M", "unstaged.txt"),
        ordinary(".D", "deleted.txt", { modeWorktree: "000000" }),
        "? new.txt"
      ])
    })
  });
  const result = record(await collect({}, { git }));

  assert.equal(result.status, "exact");
  assert.deepEqual(result.descriptor.index.map((e) => e.path.v), ["staged.txt"]);
  assert.deepEqual(result.descriptor.worktree.map((e) => e.path.v), ["deleted.txt", "unstaged.txt"]);
  assert.deepEqual(result.descriptor.untracked.map((e) => e.path.v), ["new.txt"]);

  const deleted = result.descriptor.worktree.find((e) => e.path.v === "deleted.txt");
  assert.equal(deleted.content, null, "a deleted file has no bytes to hash");
  const unstaged = result.descriptor.worktree.find((e) => e.path.v === "unstaged.txt");
  assert.match(unstaged.content, /^[0-9a-f]{64}$/u);
});

test("a path both staged and further modified appears in both sections", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream([ordinary("MM", "both.txt")]) }) });
  const result = record(await collect({}, { git }));
  assert.deepEqual(result.descriptor.index.map((e) => e.path.v), ["both.txt"]);
  assert.deepEqual(result.descriptor.worktree.map((e) => e.path.v), ["both.txt"]);
});

test("a non-git workspace is never collected", async () => {
  const result = record(await collect({ rootSource: "cwd" }));
  assert.equal(result.status, "indeterminate");
  assert.equal(result.reasons[0].code, "not_a_git_worktree");
});

test("under observational custody any live foreign record blocks an exact reading", async () => {
  for (const state of ["RESERVED", "PREPARING_WORKTREE", "SPAWNING", "ACTIVE", "TERMINATING", "ORPHANED"]) {
    const result = record(await collect({}, {
      readOwnership: async () => ({ state, executionId: "other" })
    }));
    assert.equal(result.status, "indeterminate", state + " must block");
    assert.equal(result.reasons[0].code, "concurrent_write_custody_active");
  }
});

test("a released or absent record leaves collection free to proceed", async () => {
  for (const record_ of [undefined, { state: "RELEASED", executionId: "old" }]) {
    const result = await collect({}, { readOwnership: async () => record_ });
    assert.equal(result.status, "exact");
  }
});

test("an unreadable ownership record is ambiguous, never treated as absent", async () => {
  const result = record(await collect({}, {
    readOwnership: async () => { throw new Error("corrupt"); }
  }));
  assert.equal(result.reasons[0].code, "custody_state_ambiguous");
});

test("under held admission the slot must still be ours", async () => {
  const cases = [
    [undefined, "ownership record is gone"],
    [{ state: "ACTIVE", executionId: "somebody-else", custodyKind: "coherent-review" }, "belongs"],
    [{ state: "ACTIVE", executionId: "mine" }, "not a coherent review"],
    [{ state: "RELEASED", executionId: "mine", custodyKind: "coherent-review" }, "reached"]
  ];
  for (const [ownership, fragment] of cases) {
    const result = record(await collect(
      { custodyExpectation: { mode: "exclusive-held", executionId: "mine" } },
      { readOwnership: async () => ownership }
    ));
    assert.equal(result.status, "indeterminate");
    assert.equal(result.reasons[0].code, "coherent_admission_lost");
    assert.match(result.reasons[0].detail, new RegExp(fragment, "u"));
  }
});

test("our own live coherent-review record satisfies held admission", async () => {
  const result = await collect(
    { custodyExpectation: { mode: "exclusive-held", executionId: "mine" } },
    { readOwnership: async () => ({ state: "ACTIVE", executionId: "mine", custodyKind: "coherent-review" }) }
  );
  assert.equal(result.status, "exact");
});

test("a sparse checkout cannot be reported exactly", async () => {
  const result = record(await collect({}, { git: gitRouter({ sparse: "true" }) }));
  assert.equal(result.reasons[0].code, "sparse_checkout_unsupported");
});

test("an unknown object format is refused", async () => {
  const result = record(await collect({}, { git: gitRouter({ objectFormat: "sha512" }) }));
  assert.equal(result.reasons[0].code, "object_format_unknown");
});

test("sha256 repositories are collected with 64-hex object ids", async () => {
  const wide = "c".repeat(64);
  const git = gitRouter({
    objectFormat: "sha256",
    status: () => ({
      stdout: statusStream(
        ["1 M. N... 100644 100644 100644 " + wide + " " + wide + " a.txt"],
        { branchOid: wide }
      )
    })
  });
  const result = record(await collect({}, { git }));
  assert.equal(result.status, "exact");
  assert.equal(result.descriptor.objectFormat, "sha256");
});

test("status overflow and timeout are distinct refusals", async () => {
  for (const [code, expected] of [
    ["supervised_process_output_overflow", "status_output_overflow"],
    ["supervised_process_timeout", "git_command_timeout"],
    ["supervised_process_spawn_failed", "git_command_failed"]
  ]) {
    const git = gitRouter({ status: () => { throw Object.assign(new Error("x"), { code }); } });
    const result = record(await collect({}, { git }));
    assert.equal(result.reasons[0].code, expected);
  }
});

test("overflow outside status is a Git failure, not a status overflow", async () => {
  const git = gitRouter({ objectFormat: "sha1" });
  git.runGit = async (args, options) => {
    if (args.includes("--show-object-format")) {
      throw Object.assign(new Error("overflow"), { code: "supervised_process_output_overflow" });
    }
    return gitRouter({}).runGit(args, options);
  };
  const result = record(await collect({}, { git }));
  assert.equal(result.reasons[0].code, "git_command_failed");
});

test("malformed, unknown, rename, ignored and duplicate records each refuse distinctly", async () => {
  const cases = [
    ["1 .M N... 100644", "malformed_status_record"],
    ["Z nonsense", "unknown_status_record"],
    ["2 R. N... 100644 100644 100644 " + OID_A + " " + OID_B + " R100 new.txt", "unexpected_rename_record"],
    ["! ignored.txt", "unexpected_ignored_record"]
  ];
  for (const [line, expected] of cases) {
    const extra = expected === "unexpected_rename_record" ? ["old.txt"] : [];
    const git = gitRouter({ status: () => ({ stdout: statusStream([line, ...extra]) }) });
    const result = record(await collect({}, { git }));
    assert.equal(result.reasons[0].code, expected, line);
  }

  const dup = gitRouter({ status: () => ({ stdout: statusStream(["? d.txt", "? d.txt"]) }) });
  assert.equal(record(await collect({}, { git: dup })).reasons[0].code, "duplicate_status_path");
});

test("an oversized change set is refused before any file is hashed", async () => {
  const many = Array.from({ length: MAX_CHANGE_SET_ENTRIES + 1 }, (_, i) => "? f" + i + ".txt");
  const git = gitRouter({ status: () => ({ stdout: statusStream(many) }) });
  let hashed = false;
  const result = record(await collect({}, {
    git,
    fsOverrides: { openFn: async () => { hashed = true; throw new Error("must not read"); } }
  }));
  assert.equal(result.reasons[0].code, "change_set_too_large");
  assert.equal(hashed, false, "the entry cap must be enforced before any content read");
});

test("an unborn head collects exactly", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream(["? first.txt"], { branchOid: "(initial)" }) }) });
  const result = record(await collect({}, { git }));
  assert.equal(result.status, "exact");
  assert.equal(result.descriptor.head.unborn, true);
  assert.equal(result.descriptor.head.commit, null);
});

test("a detached head is reported as detached rather than as a branch", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream([], { branchHead: "(detached)" }) }) });
  const result = record(await collect({}, { git }));
  assert.equal(result.descriptor.summary.detached, true);
  assert.equal(result.descriptor.summary.branch, null);
});

test("a target is resolved, unresolvable, or fatal, and each is distinct", async () => {
  const spec = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

  const resolved = record(await collect({ targetSpec: spec }));
  assert.equal(resolved.descriptor.target.resolution, "resolved");
  assert.equal(resolved.descriptor.target.commit, TARGET);

  const gone = gitRouter({
    revParse: () => { throw Object.assign(new Error("x"), { code: "supervised_process_failed", reason: "nonzero-exit" }); }
  });
  const unresolved = record(await collect({ targetSpec: spec }, { git: gone }));
  assert.equal(unresolved.status, "exact", "a deleted target is an exact fact");
  assert.equal(unresolved.descriptor.target.resolution, "unresolved");

  const broken = gitRouter({
    revParse: () => { throw Object.assign(new Error("x"), { code: "supervised_process_timeout" }); }
  });
  assert.equal(record(await collect({ targetSpec: spec }, { git: broken })).reasons[0].code, "git_command_timeout");
});

test("branch.upstream is never used to invent a target", async () => {
  const git = gitRouter({
    status: () => ({
      stdout: Buffer.concat([
        Buffer.from("# branch.oid " + HEAD + "\u0000# branch.head main\u0000# branch.upstream origin/main\u0000", "utf8")
      ])
    })
  });
  const result = record(await collect({}, { git }));
  assert.equal(result.descriptor.target.resolution, "none");
  assert.equal(result.descriptor.target.spec.kind, "none");
  assert.equal(git.calls.some((call) => call.args.includes("--verify")), false);
});

test("a failed merge-base leaves the summary null without spoiling the collection", async () => {
  const spec = reviewTargetSpec({ ref: "refs/heads/main", source: "request" });
  const git = gitRouter({
    mergeBase: () => { throw Object.assign(new Error("unrelated"), { code: "supervised_process_failed", reason: "nonzero-exit" }); }
  });
  const result = record(await collect({ targetSpec: spec }, { git }));
  assert.equal(result.status, "exact");
  assert.equal(result.descriptor.summary.mergeBase, null);
});

test("a dirty submodule cannot be represented and is refused", async () => {
  for (const sub of ["S.M.", "S..U", "SCMU"]) {
    const git = gitRouter({ status: () => ({ stdout: statusStream([ordinary("M.", "vendor/lib", { sub })]) }) });
    const result = record(await collect({}, { git }));
    assert.equal(result.reasons[0].code, "dirty_submodule", sub);
  }
});

test("a clean submodule with a changed commit resolves its head via git -C", async () => {
  const git = gitRouter({
    status: () => ({ stdout: statusStream([ordinary("M.", "vendor/lib", { sub: "SC.." })]) }),
    submodule: () => ({ stdout: OID_A })
  });
  const result = record(await collect({}, { git }));
  assert.equal(result.status, "exact");
  assert.deepEqual(result.descriptor.submodules.map((e) => e.worktreeHead), [OID_A]);

  const call = git.calls.find((c) => c.args[0] === "-C");
  assert.deepEqual(call.args.slice(2), ["rev-parse", "--verify", "HEAD"]);
});

test("an unresolvable submodule head is refused", async () => {
  const git = gitRouter({
    status: () => ({ stdout: statusStream([ordinary("M.", "vendor/lib", { sub: "SC.." })]) }),
    submodule: () => { throw Object.assign(new Error("x"), { code: "supervised_process_failed", reason: "nonzero-exit" }); }
  });
  assert.equal(record(await collect({}, { git })).reasons[0].code, "submodule_head_unresolved");
});

test("an untracked nested repository is opaque, detected by trailing slash and by stat", async () => {
  const bySlash = gitRouter({ status: () => ({ stdout: statusStream(["? nested/"]) }) });
  assert.equal(record(await collect({}, { git: bySlash })).reasons[0].code, "untracked_directory_opaque");

  const byStat = gitRouter({ status: () => ({ stdout: statusStream(["? nested"]) }) });
  assert.equal(
    record(await collect({}, { git: byStat, fs: { digestable: false } })).reasons[0].code,
    "untracked_directory_opaque"
  );
});

test("an unreadable file makes the whole collection indeterminate", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream(["? locked.txt"]) }) });
  const result = record(await collect({}, {
    git,
    fsOverrides: { openFn: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }
  }));
  assert.equal(result.reasons[0].code, "content_unreadable");
});

test("an unsupported file type is refused", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream(["? pipe"]) }) });
  const result = record(await collect({}, {
    git,
    fsOverrides: {
      lstatFn: async () => ({
        size: 0n, mtimeNs: 1n, ctimeNs: 1n, mode: 0n, ino: 0n, dev: 0n,
        isFile: () => false, isSymbolicLink: () => false, isDirectory: () => false
      })
    }
  }));
  assert.equal(result.reasons[0].code, "unsupported_file_type");
});

test("an oversized file is refused", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream(["? big.bin"]) }) });
  const result = record(await collect({}, {
    git,
    fsOverrides: {
      lstatFn: async () => ({
        size: BigInt(1024 * 1024 * 1024), mtimeNs: 1n, ctimeNs: 1n, mode: 0o100644n, ino: 0n, dev: 0n,
        isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false
      })
    }
  }));
  assert.equal(result.reasons[0].code, "content_too_large");
});

test("a symlink is recorded as a symlink, not as a file", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream(["? link"]) }) });
  const result = record(await collect({}, {
    git,
    fsOverrides: {
      lstatFn: async () => ({
        size: 6n, mtimeNs: 1n, ctimeNs: 1n, mode: 0o120000n, ino: 0n, dev: 0n,
        isFile: () => false, isSymbolicLink: () => true, isDirectory: () => false
      })
    }
  }));
  assert.equal(result.status, "exact");
  assert.equal(result.descriptor.untracked[0].kind, "symlink");
});

test("a status that changes between the two snapshots is retried, then reported unstable", async () => {
  let snapshot = 0;
  const git = gitRouter({
    status: () => ({ stdout: statusStream(["? churn" + snapshot++ + ".txt"]) })
  });
  const result = record(await collect({}, { git }));

  assert.equal(result.reasons[0].code, "collector_unstable");
  // Three attempts, two status runs each: the bracket is genuinely re-taken.
  assert.equal(git.calls.filter((call) => call.args[1] === "status").length, 6);
});

test("a status that settles on the second attempt collects exactly", async () => {
  let call = 0;
  const git = gitRouter({
    status: () => {
      call += 1;
      return { stdout: statusStream([call === 1 ? "? a.txt" : "? b.txt"]) };
    }
  });
  const result = await collect({}, { git });
  assert.equal(result.status, "exact");
  assert.deepEqual(result.descriptor.untracked.map((e) => e.path.v), ["b.txt"]);
});

test("an exceeded deadline is reported rather than allowed to run long", async () => {
  let clock = 0;
  const result = record(await collect({}, { now: () => (clock += 500_000) }));
  assert.equal(result.reasons[0].code, "collection_deadline_exceeded");
});

test("every Git child is bounded by the remaining collection deadline", async () => {
  let clock = 0;
  const git = gitRouter({});
  const result = await collect({}, { git, now: () => (clock += 100) });
  assert.equal(result.status, "exact");
  assert.ok(git.calls.length > 0);
  assert.ok(git.calls.every((call) => Number.isSafeInteger(call.options.timeoutMs)));
  assert.ok(git.calls.every((call) => call.options.timeoutMs > 0 && call.options.timeoutMs < 180_000));
  for (let index = 1; index < git.calls.length; index += 1) {
    assert.ok(git.calls[index].options.timeoutMs < git.calls[index - 1].options.timeoutMs);
  }
});

test("the collector never throws, whatever the dependency does", async () => {
  const exploding = await collectChangeSet(
    { effectiveCwd: TOP_LEVEL, rootSource: "git-boundary", canonicalRepositoryKey: "c:\\repo" },
    { runGit: async () => { throw new TypeError("boom"); }, readOwnership: async () => undefined }
  );
  assert.equal(exploding.status, "indeterminate");
  assert.equal(typeof exploding.reasons[0].code, "string");
});

test("an invalid target spec is refused", async () => {
  const result = record(await collect({ targetSpec: { kind: "ref", ref: "nope", source: "request" } }));
  assert.equal(result.reasons[0].code, "review_target_spec_invalid");
});

test("a submodule head of the wrong object-id width is refused by descriptor validation", async () => {
  const git = gitRouter({
    objectFormat: "sha256",
    status: () => ({
      stdout: statusStream(
        ["1 M. SC.. 100644 100644 100644 " + "c".repeat(64) + " " + "d".repeat(64) + " vendor/lib"],
        { branchOid: "c".repeat(64) }
      )
    }),
    // A 40-hex id in a sha256 repository: loosely plausible, structurally wrong.
    submodule: () => ({ stdout: OID_A })
  });
  const result = record(await collect({}, { git }));
  assert.equal(result.status, "indeterminate");
  assert.equal(result.reasons[0].code, "descriptor_invalid");
});

test("a persistently unstable file exhausts the retry budget as collector instability", async () => {
  const git = gitRouter({ status: () => ({ stdout: statusStream(["? churn.txt"]) }) });
  let tick = 0n;
  const result = record(await collect({}, {
    git,
    fsOverrides: {
      lstatFn: async () => ({
        size: 4n, mtimeNs: tick++, ctimeNs: 1n, mode: 0o100644n, ino: 0n, dev: 0n,
        isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false
      })
    }
  }));
  assert.equal(result.reasons[0].code, "collector_unstable");
});


/**
 * The adversarial pair. `a\xffb` is a real filename whose bytes are not valid
 * UTF-8, so the descriptor carries it as enc "hex" with v "61ff62". A second,
 * completely unrelated file is literally named "61ff62" in ASCII, so it carries
 * enc "utf8" with the same v. Using v as a pathname collapses them into one.
 */
const RAW_NON_UTF8_PATH = Buffer.from([0x61, 0xff, 0x62]);
const HEX_LOOKALIKE_PATH = Buffer.from("61ff62", "utf8");

/**
 * The two locator keys, each derived the way production derives its own.
 *
 * A UTF-8 entry is joined with node:path, so its separator is the host's - "\\"
 * on Windows, "/" elsewhere. Spelling it by hand made this suite pass only on
 * a POSIX host, which is precisely the mistake the test exists to catch.
 *
 * The raw-byte locator keeps its explicit 0x2f: that side is the simulated
 * POSIX branch, forced by `platform: "linux"`, and the collector joins those
 * bytes itself rather than through node:path. It is host-independent by
 * construction and must stay literal.
 */
const HEX_LOOKALIKE_LOCATOR = "text:" + path.join(TOP_LEVEL, HEX_LOOKALIKE_PATH.toString("utf8"));
const RAW_NON_UTF8_LOCATOR = "bytes:" + Buffer.concat([
  Buffer.from(TOP_LEVEL, "utf8"),
  Buffer.of(0x2f),
  RAW_NON_UTF8_PATH
]).toString("hex");

function twoPathFilesystem() {
  const contents = new Map([
    [RAW_NON_UTF8_LOCATOR, Buffer.from("bytes-file-contents", "utf8")],
    [HEX_LOOKALIKE_LOCATOR, Buffer.from("hex-lookalike-contents", "utf8")]
  ]);
  const addressed = [];
  const contentFor = (locator) => {
    const key = locatorKey(locator);
    addressed.push(key);
    const bytes = contents.get(key);
    if (!bytes) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    return bytes;
  };
  return {
    addressed,
    stubs: {
      lstatFn: async (locator) => {
        const bytes = contentFor(locator);
        return {
          size: BigInt(bytes.length), mtimeNs: 5n, ctimeNs: 6n, mode: 0o100644n, ino: 0n, dev: 0n,
          isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false
        };
      },
      openFn: async (locator) => {
        const bytes = contentFor(locator);
        let done = false;
        return {
          async read(buffer) {
            if (done) return { bytesRead: 0 };
            done = true;
            bytes.copy(buffer, 0);
            return { bytesRead: bytes.length };
          },
          async close() {}
        };
      },
      readlinkFn: async () => { throw new Error("not a link"); }
    }
  };
}

test("a raw non-UTF-8 path and a literal hex-looking path can never be hashed as one file", async () => {
  const filesystem = twoPathFilesystem();
  const git = gitRouter({
    status: () => ({
      stdout: statusStream([
        untrackedRecord(RAW_NON_UTF8_PATH),
        untrackedRecord(HEX_LOOKALIKE_PATH)
      ])
    })
  });
  const result = await collect({}, {
    git,
    platform: "linux",
    fsOverrides: filesystem.stubs
  });

  assert.equal(result.status, "exact");
  const byEncoding = new Map(result.descriptor.untracked.map((entry) => [entry.path.enc, entry]));
  assert.deepEqual([...byEncoding.keys()].sort(), ["hex", "utf8"]);

  // The trap: both entries spell their path "61ff62". Only the encoding tells
  // them apart, and only the raw bytes address them.
  assert.equal(byEncoding.get("hex").path.v, "61ff62");
  assert.equal(byEncoding.get("utf8").path.v, "61ff62");
  assert.notEqual(
    byEncoding.get("hex").content,
    byEncoding.get("utf8").content,
    "two distinct files must never share a content digest"
  );

  // And the proof of how: the hex-encoded entry was addressed by raw bytes, the
  // UTF-8 entry by its name, and the hex spelling was never used as a pathname.
  assert.deepEqual(
    [...new Set(filesystem.addressed)].sort(),
    [RAW_NON_UTF8_LOCATOR, HEX_LOOKALIKE_LOCATOR].sort()
  );
});

test("an unreadable non-UTF-8 entry reports its display form, never raw locator bytes", async () => {
  const git = gitRouter({
    status: () => ({ stdout: statusStream([untrackedRecord(RAW_NON_UTF8_PATH)]) })
  });
  const result = record(await collect({}, {
    git,
    platform: "linux",
    fsOverrides: {
      lstatFn: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }
    }
  }));

  assert.equal(result.reasons[0].code, "content_unreadable");
  assert.equal(typeof result.reasons[0].detail, "string", "a Buffer must never reach a reason");
  assert.equal(result.reasons[0].detail, "<non-utf8 path: 61ff62>");
});

test("a path this platform cannot address is indeterminate, never the hexadecimal filename", async () => {
  const filesystem = twoPathFilesystem();
  const git = gitRouter({
    status: () => ({ stdout: statusStream([untrackedRecord(RAW_NON_UTF8_PATH)]) })
  });
  const result = record(await collect({}, {
    git,
    platform: "win32",
    fsOverrides: filesystem.stubs
  }));

  assert.equal(result.status, "indeterminate");
  assert.equal(result.reasons[0].code, "path_not_addressable");
  assert.equal(
    filesystem.addressed.includes(HEX_LOOKALIKE_LOCATOR),
    false,
    "the hex spelling must never become a pathname"
  );
});

test("a submodule at a non-UTF-8 path is never handed to git as its hex spelling", async () => {
  for (const platform of ["linux", "win32"]) {
    const git = gitRouter({
      status: () => ({
        stdout: statusStream([ordinary("M.", RAW_NON_UTF8_PATH, { sub: "SC.." })])
      }),
      submodule: () => ({ stdout: OID_A })
    });
    const result = record(await collect({}, { git, platform }));
    assert.equal(result.reasons[0].code, "path_not_addressable", platform);
    assert.equal(git.calls.some((call) => call.args[0] === "-C"), false, platform);
  }
});

test("a target ref that moves during one collection is retried, then reported unstable", async () => {
  let resolution = 0;
  const git = gitRouter({
    revParse: () => ({ stdout: String(resolution++).padStart(40, "0") })
  });
  const result = record(await collect(
    { targetSpec: reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" }) },
    { git }
  ));

  assert.equal(result.status, "indeterminate");
  assert.equal(result.reasons[0].code, "collector_unstable");
  assert.equal(result.reasons[0].detail, "review target moved during collection");
  // Two resolutions per attempt: the target bracket is genuinely re-taken.
  assert.equal(resolution, 2 * 3);
});

test("a target ref that stays put across the bracket collects exactly", async () => {
  let resolutions = 0;
  const git = gitRouter({
    revParse: () => {
      resolutions += 1;
      return { stdout: TARGET };
    }
  });
  const result = await collect(
    { targetSpec: reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" }) },
    { git }
  );
  assert.equal(result.status, "exact");
  assert.equal(result.descriptor.target.commit, TARGET);
  assert.equal(resolutions, 2, "the target is observed on both sides of the collection");
});

test("a clean submodule head that moves under an unchanged porcelain status is unstable", async () => {
  // Both status snapshots are byte-identical - same `SC..` field, same index
  // and head object ids - while the submodule worktree is checked out from one
  // non-index commit to another. Only re-resolving the head can catch it.
  let observation = 0;
  const git = gitRouter({
    status: () => ({ stdout: statusStream([ordinary("M.", "vendor/lib", { sub: "SC.." })]) }),
    submodule: () => ({ stdout: observation++ % 2 === 0 ? OID_A : OID_B })
  });
  const result = record(await collect({}, { git }));

  assert.equal(result.status, "indeterminate");
  assert.equal(result.reasons[0].code, "collector_unstable");
  assert.equal(result.reasons[0].detail, "submodule head moved during collection");
  assert.equal(observation, 2 * 3, "the submodule head is observed on both sides of every attempt");
});

test("a clean submodule head observed identically on both sides collects exactly", async () => {
  let observations = 0;
  const git = gitRouter({
    status: () => ({ stdout: statusStream([ordinary("M.", "vendor/lib", { sub: "SC.." })]) }),
    submodule: () => {
      observations += 1;
      return { stdout: OID_A };
    }
  });
  const result = await collect({}, { git });
  assert.equal(result.status, "exact");
  assert.equal(observations, 2);
  assert.deepEqual(result.descriptor.submodules.map((entry) => entry.worktreeHead), [OID_A]);
});

test("only the literal (initial) may produce an unborn HEAD", async () => {
  const missing = record(await collect({}, {
    git: gitRouter({ status: () => ({ stdout: statusStream(["? a.txt"], { branchOid: null }) }) })
  }));
  assert.equal(missing.status, "indeterminate");
  assert.equal(missing.reasons[0].code, "branch_oid_unusable");

  for (const branchOid of ["", "not-an-object-id", "(unknown)", HEAD.slice(0, 39), HEAD + "0"]) {
    const result = record(await collect({}, {
      git: gitRouter({ status: () => ({ stdout: statusStream([], { branchOid }) }) })
    }));
    assert.equal(result.status, "indeterminate", JSON.stringify(branchOid));
    assert.equal(result.reasons[0].code, "branch_oid_unusable", JSON.stringify(branchOid));
  }

  const unborn = await collect({}, {
    git: gitRouter({ status: () => ({ stdout: statusStream([], { branchOid: "(initial)" }) }) })
  });
  assert.equal(unborn.status, "exact");
  assert.equal(unborn.descriptor.head.unborn, true);
});

test("a sha1-width head in a sha256 repository is unusable rather than accepted", async () => {
  const git = gitRouter({
    objectFormat: "sha256",
    status: () => ({ stdout: statusStream([], { branchOid: HEAD }) })
  });
  const result = record(await collect({}, { git }));
  assert.equal(result.reasons[0].code, "branch_oid_unusable");
});

test("after the collection deadline no new Git command or filesystem read begins", async () => {
  const base = gitRouter({ status: () => ({ stdout: statusStream(["? slow.txt"]) }) });
  const begun = [];
  let stalled = false;
  const git = {
    calls: base.calls,
    runGit: async (args, options) => {
      begun.push(args.join(" "));
      if (!stalled && args[1] === "status") {
        stalled = true;
        await delay(200);
      }
      return base.runGit(args, options);
    }
  };
  let reads = 0;
  const result = record(await collect({}, {
    git,
    deadlineMs: 50,
    fsOverrides: {
      lstatFn: async () => {
        reads += 1;
        throw Object.assign(new Error("must not stat"), { code: "EIO" });
      },
      openFn: async () => {
        reads += 1;
        throw Object.assign(new Error("must not read"), { code: "EIO" });
      }
    }
  }));

  assert.equal(result.status, "indeterminate");
  assert.equal(result.reasons[0].code, "collection_deadline_exceeded");

  const begunAtReturn = begun.length;
  await delay(400);
  assert.equal(begun.length, begunAtReturn, "no Git command may begin after the deadline");
  assert.equal(reads, 0, "no filesystem read may begin after the deadline");
});

test("every declared collector reason is reachable", () => {
  // A refusal code that no test can produce is either dead or untested; both
  // are defects, so this assertion is the suite's own completeness check.
  const unreached = COLLECTOR_REASONS.filter((code) => !produced.has(code));
  assert.deepEqual(unreached, [], "unreachable reason codes: " + unreached.join(", "));
});
