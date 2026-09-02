import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodePath } from "../src/changeset/porcelain-parser.mjs";
import {
  pathBytesEndWithSeparator,
  submodulePathArgument,
  worktreeEntryLocator
} from "../src/changeset/path-locator.mjs";
import { digestWorkspaceEntry } from "../src/changeset/workspace-digest.mjs";

/**
 * The adversarial pair, at the layer that actually touches the disk.
 *
 * `a\xffb` is a legal filename on any POSIX filesystem and is not valid UTF-8,
 * so the descriptor spells it as hex: "61ff62". A different file may be named
 * "61ff62" in plain ASCII, and it is spelled exactly the same way. If the
 * encoded spelling were ever used as a pathname, one file's bytes would be
 * hashed as the other's - and the change set would assert an identity for a
 * tree that never existed.
 */
const RAW_NON_UTF8 = Buffer.from([0x61, 0xff, 0x62]);
const HEX_LOOKALIKE = "61ff62";
const TOP_LEVEL = "/repo";

const posixOnly = { skip: process.platform === "win32" ? "POSIX pathname bytes only" : false };

test("the two paths share a spelling and differ in encoding", () => {
  const raw = encodePath(RAW_NON_UTF8);
  const lookalike = encodePath(Buffer.from(HEX_LOOKALIKE, "utf8"));
  assert.equal(raw.enc, "hex");
  assert.equal(lookalike.enc, "utf8");
  assert.equal(raw.v, lookalike.v, "the trap is that both spell the same string");
});

test("a UTF-8 path is addressed by name on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const located = worktreeEntryLocator({
      topLevel: TOP_LEVEL,
      encoded: encodePath(Buffer.from("docs/notes.md", "utf8")),
      pathBytes: Buffer.from("docs/notes.md", "utf8"),
      platform
    });
    assert.equal(located.status, "ok", platform);
    assert.equal(typeof located.locator, "string", platform);
    assert.equal(located.locator, path.join(TOP_LEVEL, "docs/notes.md"), platform);
  }
});

test("a non-UTF-8 path is addressed by raw bytes where the platform allows it", () => {
  for (const platform of ["linux", "darwin"]) {
    const located = worktreeEntryLocator({
      topLevel: TOP_LEVEL,
      encoded: encodePath(RAW_NON_UTF8),
      pathBytes: RAW_NON_UTF8,
      platform
    });
    assert.equal(located.status, "ok", platform);
    assert.ok(Buffer.isBuffer(located.locator), platform + " must address raw bytes");
    assert.deepEqual(
      located.locator,
      Buffer.concat([Buffer.from(TOP_LEVEL, "utf8"), Buffer.of(0x2f), RAW_NON_UTF8]),
      platform
    );
    assert.notEqual(located.locator.toString("latin1"), TOP_LEVEL + "/" + HEX_LOOKALIKE);
  }
});

test("a non-UTF-8 path is unaddressable on Windows rather than invented", () => {
  const located = worktreeEntryLocator({
    topLevel: "C:\\repo",
    encoded: encodePath(RAW_NON_UTF8),
    pathBytes: RAW_NON_UTF8,
    platform: "win32"
  });
  assert.equal(located.status, "unaddressable");
  assert.equal(located.locator, undefined);
});

test("a separator already on the top level is not doubled", () => {
  const located = worktreeEntryLocator({
    topLevel: "/",
    encoded: encodePath(RAW_NON_UTF8),
    pathBytes: RAW_NON_UTF8,
    platform: "linux"
  });
  assert.deepEqual(located.locator, Buffer.concat([Buffer.from("/", "utf8"), RAW_NON_UTF8]));
});

test("a submodule argument refuses a non-UTF-8 path on every platform", () => {
  assert.equal(
    submodulePathArgument({
      topLevel: TOP_LEVEL,
      encoded: encodePath(RAW_NON_UTF8)
    }).status,
    "unaddressable",
    "process arguments are strings everywhere, so raw bytes never survive"
  );
  const usable = submodulePathArgument({
    topLevel: TOP_LEVEL,
    encoded: encodePath(Buffer.from("vendor/lib", "utf8"))
  });
  assert.equal(usable.status, "ok");
  assert.equal(usable.value, path.join(TOP_LEVEL, "vendor/lib"));
});

test("an untracked directory is detected on raw bytes, not on the encoded spelling", () => {
  assert.equal(pathBytesEndWithSeparator(Buffer.from("nested/", "utf8")), true);
  assert.equal(pathBytesEndWithSeparator(Buffer.from("nested", "utf8")), false);
  // The whole point: a hex-encoded path never ends in a slash, so testing the
  // encoded string would silently treat an opaque directory as a file.
  const directoryBytes = Buffer.concat([RAW_NON_UTF8, Buffer.of(0x2f)]);
  assert.equal(pathBytesEndWithSeparator(directoryBytes), true);
  assert.equal(encodePath(directoryBytes).v.endsWith("/"), false);
});

test("the two files are distinct on a real filesystem and digest differently", posixOnly, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-path-"));
  try {
    const rawLocator = Buffer.concat([Buffer.from(root, "utf8"), Buffer.of(0x2f), RAW_NON_UTF8]);
    const lookalikeLocator = path.join(root, HEX_LOOKALIKE);
    await writeFile(rawLocator, "raw non-utf8 bytes");
    await writeFile(lookalikeLocator, "literal hex-looking name");

    const names = (await readdir(root, { encoding: "buffer" })).map((name) => name.toString("hex")).sort();
    assert.deepEqual(
      names,
      [Buffer.from(HEX_LOOKALIKE, "utf8").toString("hex"), RAW_NON_UTF8.toString("hex")].sort(),
      "both files exist side by side under names that are not the same bytes"
    );

    const raw = await digestWorkspaceEntry(rawLocator);
    const lookalike = await digestWorkspaceEntry(lookalikeLocator);
    assert.notEqual(raw.digest, lookalike.digest);

    // And the locator the collector would build from the encoded spelling
    // addresses the other file entirely - which is exactly why it is refused.
    const located = worktreeEntryLocator({
      topLevel: root,
      encoded: encodePath(RAW_NON_UTF8),
      pathBytes: RAW_NON_UTF8,
      platform: "linux"
    });
    assert.deepEqual(located.locator, rawLocator);
    assert.equal((await digestWorkspaceEntry(located.locator)).digest, raw.digest);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
