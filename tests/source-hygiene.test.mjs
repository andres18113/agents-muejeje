import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findControlCharacterFiles,
  isExpectedDiffableText,
  isForbiddenControlByte,
  listTrackedDiffableFiles
} from "../scripts/check-text-files.mjs";

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
