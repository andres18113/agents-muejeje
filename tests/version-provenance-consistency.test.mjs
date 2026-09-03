import assert from "node:assert/strict";
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
