import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findControlCharacterFiles,
  isExpectedDiffableText,
  isForbiddenControlByte,
  listTrackedDiffableFiles
} from "../scripts/check-text-files.mjs";
import {
  PROCESS_IDENTITY_MATCH,
  PROCESS_IDENTITY_STATUS,
  compareProcessIdentity,
  inspectProcessIdentity,
  validateDurableProcessIdentity
} from "../src/process-identity.mjs";
import {
  inspectSyntheticProcess,
  syntheticProcessIdentity,
  syntheticStartTime
} from "./fixtures/synthetic-process-identity.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("every tracked diffable source/text file is free of raw control characters", async () => {
  const files = listTrackedDiffableFiles(projectRoot);
  // The two files that previously carried raw bytes, so a regression here is
  // caught by name rather than only by the whole-tree sweep.
  assert.ok(files.includes("src/changeset/target.mjs"));
  assert.ok(files.includes("tests/git-ref-name.test.mjs"));
  assert.ok(files.includes("tests/agent-registry.test.mjs"));
  assert.deepEqual(await findControlCharacterFiles({ root: projectRoot, files }), []);
});

test("tab, newline and carriage return are text; NUL and the rest are not", () => {
  for (const allowed of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0x7e]) {
    assert.equal(isForbiddenControlByte(allowed), false, "0x" + allowed.toString(16));
  }
  // 0x00 breaks Git's diffs outright; 0x08 is the backspace that silently
  // replaced a `\b` word boundary; 0x1b and 0x7f are equally unreadable.
  for (const forbidden of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f]) {
    assert.equal(isForbiddenControlByte(forbidden), true, "0x" + forbidden.toString(16));
  }
});

test("the source hygiene gate names the offending bytes and skips binary assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-source-hygiene-"));
  try {
    await writeFile(path.join(root, "bad.mjs"), Buffer.from([0x61, 0x00, 0x62, 0x08]));
    await writeFile(path.join(root, "good.mjs"), Buffer.from([0x61, 0x09, 0x0a, 0x0d, 0x62]));
    assert.deepEqual(
      await findControlCharacterFiles({ root, files: ["bad.mjs", "good.mjs"] }),
      [{ file: "bad.mjs", codes: ["0x00", "0x08"] }]
    );
    assert.equal(isExpectedDiffableText("README.md"), true);
    assert.equal(isExpectedDiffableText("asset.png"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Files whose custody manager is deliberately left on the production
 * observation, with the reason it has to stay there. Every one of these drives
 * real spawned processes, so the real process table is the only thing that can
 * answer truthfully about them - replacing the observation would delete what
 * the test proves rather than stabilise it.
 */
const REAL_OBSERVATION_BY_DESIGN = new Map([
  [
    "tests/same-session-cancellation-recovery.test.mjs",
    "drives a real fake-claude.exe child; its PID and start time are real"
  ],
  [
    "tests/mcp-transport-cancellation.test.mjs",
    "drives a real fake-claude.exe child through a real stdio transport"
  ],
  [
    "tests/operational-concurrency-custody.test.mjs",
    "proves real durable admission under real contention between real processes"
  ]
]);

/** Every `new DurableWriteCustodyManager(...)` call, read whole. */
function custodyConstructions(source) {
  const needle = "new DurableWriteCustodyManager(";
  const calls = [];
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    // Balance from the opening parenthesis so a multi-line option object is
    // read entire, rather than truncated at the first newline.
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")" && (depth -= 1) === 0) break;
    }
    calls.push(source.slice(at, end + 1));
  }
  return calls;
}

test("a test that mints process identities never leaves custody on the real Windows query", async () => {
  const testFiles = listTrackedDiffableFiles(projectRoot)
    .filter((file) => /^tests\/.*\.mjs$/u.test(file))
    // This file names the constructor only in order to search for it, and
    // constructs no custody of its own.
    .filter((file) => file !== "tests/source-hygiene.test.mjs");
  assert.ok(testFiles.length > 40, "the sweep must actually see the test tree");

  const offenders = [];
  let checked = 0;
  for (const file of testFiles) {
    const source = await readFile(path.join(projectRoot, file), "utf8");
    for (const call of custodyConstructions(source)) {
      checked += 1;
      if (call.includes("inspectProcess")) continue;
      if (REAL_OBSERVATION_BY_DESIGN.has(file)) continue;
      offenders.push(file + ": " + call.replace(/\s+/gu, " ").slice(0, 120));
    }
  }

  // A custody manager built without an observation seam falls back to a real
  // powershell.exe query of the live process table. Under CI contention that
  // query can miss its liveness budget, and the AMBIGUOUS result fails closed
  // as write_custody_process_identity_ambiguous - a denial that looks like a
  // product regression and is only a slow host. Either pass a seam from
  // tests/fixtures/synthetic-process-identity.mjs, or say here why this file
  // has to observe real processes.
  assert.deepEqual(offenders, []);
  assert.ok(checked >= 20, "the sweep must actually see custody constructions: " + checked);

  // The allowlist stays honest: an entry that no longer names a real file, or
  // whose file stopped constructing custody at all, is removed rather than
  // left as permanent permission.
  for (const [file] of REAL_OBSERVATION_BY_DESIGN) {
    assert.ok(testFiles.includes(file), "stale allowlist entry: " + file);
    const source = await readFile(path.join(projectRoot, file), "utf8");
    assert.ok(custodyConstructions(source).length > 0, "allowlist entry constructs no custody: " + file);
  }
});

test("a synthetic identity and its observation are the same value to production", async () => {
  const source = "synthetic-consistency-probe";
  const inspectProcess = inspectSyntheticProcess(source);

  for (const pid of [1, 4, 52_000, 71_000, 88_888, 2_147_483_647]) {
    const minted = syntheticProcessIdentity(pid, source);
    // Production's own validator must accept what the helper mints.
    assert.deepEqual(validateDurableProcessIdentity(minted), minted);

    const observation = await inspectProcess(pid);
    assert.equal(observation.status, PROCESS_IDENTITY_STATUS.ALIVE);
    assert.deepEqual(observation.identity, minted);

    // And production's own comparison must call the two the same process.
    // That is the whole contract: a minted child is a real, valid, exactly
    // matching one, so nothing about ambiguity handling had to be relaxed.
    const comparison = await compareProcessIdentity(minted, { inspectProcess });
    assert.equal(comparison.status, PROCESS_IDENTITY_MATCH.SAME_PROCESS);
  }

  // The helper answers from arithmetic, never from the process table: it is
  // not the production observation, and it holds no spawn behind it.
  assert.notEqual(inspectProcess, inspectProcessIdentity);
  assert.equal(syntheticStartTime(4), "400");

  // A start time that is not the PID's own is a different process, not a
  // near miss - the seam does not make mismatches pass.
  const wrong = { pid: 4, startTime: syntheticStartTime(5), source };
  assert.equal(
    (await compareProcessIdentity(wrong, { inspectProcess })).status,
    PROCESS_IDENTITY_MATCH.PID_REUSED
  );
  // A foreign source is ambiguous, exactly as production decides it.
  assert.equal(
    (await compareProcessIdentity({ ...wrong, startTime: "400", source: "other" }, { inspectProcess })).status,
    PROCESS_IDENTITY_MATCH.AMBIGUOUS
  );
});
