import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_RECEIPT_PRODUCER_VERSION } from "../src/review/review-binding.mjs";
import { PACKAGE_VERSION, RECEIPT_PRODUCER_VERSION, SERVER_VERSION } from "../src/version.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package, server, receipt producer, and current-state documents share one candidate version", async () => {
  const [packageText, lockText, readme, handoff] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "handoff.md"), "utf8")
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);

  assert.equal(packageJson.version, PACKAGE_VERSION);
  assert.equal(packageLock.version, PACKAGE_VERSION);
  assert.equal(packageLock.packages[""].version, PACKAGE_VERSION);
  assert.equal(SERVER_VERSION, PACKAGE_VERSION);
  assert.equal(RECEIPT_PRODUCER_VERSION, packageJson.name + "/" + PACKAGE_VERSION);
  assert.equal(DEFAULT_RECEIPT_PRODUCER_VERSION, RECEIPT_PRODUCER_VERSION);
  assert.match(readme, new RegExp("^Version " + PACKAGE_VERSION.replaceAll(".", "\\.") + " candidate\\.", "m"));
  assert.match(handoff, new RegExp("^# Handoff: claude-agents-mcp " + PACKAGE_VERSION.replaceAll(".", "\\.") + " current state$", "m"));
});

/**
 * The release tag must name the exact tree it releases. v0.2.2 was tagged on
 * a tree whose internal version still said 0.2.1, and no gate caught it, so
 * this pins both sides of `internal_version == tag_version`:
 *
 * - On the tagged release commit itself, the exact HEAD tag must equal the
 *   internal version. A development tree sits on an older release tag (or no
 *   tag), which is not a mismatch - it is simply not the release commit.
 * - Anywhere else, the candidate version must not already be claimed by a tag
 *   on another commit: that is the v0.2.2 skew replayed, a tag pointing at a
 *   tree that disagrees with it.
 *
 * A git failure fails the gate rather than skipping it: an unevaluated gate
 * is how the skew shipped.
 */
test("an exact HEAD tag matches the internal version, and the candidate tag is not claimed elsewhere", () => {
  const candidateTag = "v" + PACKAGE_VERSION;
  const describe = spawnSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (describe.error) throw describe.error;
  const exactTag = describe.status === 0 ? describe.stdout.trim() : "";
  if (exactTag === candidateTag) return;

  const listed = spawnSync("git", ["tag", "--list", candidateTag], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (listed.error) throw listed.error;
  assert.equal(listed.status, 0);
  assert.equal(
    listed.stdout.trim(),
    "",
    "Tag " + candidateTag + " already exists on another commit while this tree claims internal version " +
      PACKAGE_VERSION + ": tag and internal version disagree."
  );
});
