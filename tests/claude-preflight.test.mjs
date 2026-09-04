import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_RESTRICTED_CLAUDE_VERSION,
  PREFLIGHT_STATUS,
  REQUIRED_RESTRICTED_FLAG,
  claudeVersionSatisfies,
  compareClaudeVersions,
  evaluateClaudePreflight,
  parseClaudeVersion
} from "../src/claude-preflight.mjs";

/**
 * Readiness is a claim that the first request will work, and presence of an
 * executable is not that claim. Production launches with --restricted, so a
 * Claude Code that predates the flag fails immediately - reporting such a
 * system as ready would send an operator into a guaranteed failure believing
 * the diagnostic had checked.
 *
 * Four outcomes are kept distinct because they call for different actions:
 * install Claude Code, upgrade it, investigate a build that does not advertise
 * what its version implies, or investigate one whose version cannot be read at
 * all. Collapsing them into a boolean would tell an operator nothing about what
 * to do next.
 *
 * Every case here is decided from observed text, so the whole matrix runs
 * without invoking a model, spending a token, or needing a credential.
 */

const HELP_WITH_FLAG = [
  "Usage: claude [options] [command] [prompt]",
  "Options:",
  "  --restricted                          Restricted mode: removes built-in tools",
  "  --strict-mcp-config                   Only use MCP servers from --mcp-config",
  "  -h, --help                            Display help for command"
].join("\n");

const HELP_WITHOUT_FLAG = [
  "Usage: claude [options] [command] [prompt]",
  "Options:",
  "  --strict-mcp-config                   Only use MCP servers from --mcp-config",
  "  -h, --help                            Display help for command"
].join("\n");

test("a version line is located inside whatever text the CLI prints around it", () => {
  assert.deepEqual(
    { ...parseClaudeVersion("2.1.260 (Claude Code)") },
    { major: 2, minor: 1, patch: 260, text: "2.1.260" }
  );
  assert.equal(parseClaudeVersion("claude version 10.0.3 build 7").text, "10.0.3");
  // Not a version: reported as unreadable rather than guessed at.
  for (const malformed of ["", "unknown", "v2", "2.1", "Claude Code", undefined, null, 42]) {
    assert.equal(parseClaudeVersion(malformed), undefined, String(malformed));
  }
});

test("versions order numerically, not lexically", () => {
  const version = (text) => parseClaudeVersion(text);
  // The case a string comparison gets wrong, and the reason this is numeric.
  assert.equal(compareClaudeVersions(version("2.1.9"), version("2.1.248")), -1);
  assert.equal(compareClaudeVersions(version("2.1.248"), version("2.1.248")), 0);
  assert.equal(compareClaudeVersions(version("2.2.0"), version("2.1.999")), 1);
  assert.equal(compareClaudeVersions(version("10.0.0"), version("9.9.9")), 1);
  assert.equal(claudeVersionSatisfies(version("2.1.247")), false);
  assert.equal(claudeVersionSatisfies(version("2.1.248")), true);
});

test("below the minimum is incompatible, and says which minimum", () => {
  const result = evaluateClaudePreflight({
    versionText: "2.1.247 (Claude Code)",
    helpText: HELP_WITH_FLAG
  });
  assert.equal(result.status, PREFLIGHT_STATUS.INCOMPATIBLE_VERSION);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "claude_version_below_minimum");
  assert.equal(result.minimumVersion, MINIMUM_RESTRICTED_CLAUDE_VERSION);
  assert.match(result.message, /2\.1\.247/u);
  assert.match(result.message, new RegExp(REQUIRED_RESTRICTED_FLAG, "u"));
});

test("exactly the minimum is ready", () => {
  const result = evaluateClaudePreflight({
    versionText: MINIMUM_RESTRICTED_CLAUDE_VERSION + " (Claude Code)",
    helpText: HELP_WITH_FLAG
  });
  assert.equal(result.status, PREFLIGHT_STATUS.READY);
  assert.equal(result.ready, true);
  assert.equal(result.capabilityVerified, true);
});

test("a newer compatible build is ready", () => {
  const result = evaluateClaudePreflight({
    versionText: "3.4.0 (Claude Code)",
    helpText: HELP_WITH_FLAG
  });
  assert.equal(result.status, PREFLIGHT_STATUS.READY);
  assert.equal(result.ready, true);
  assert.equal(result.version, "3.4.0");
});

test("a malformed version is unreadable, never treated as old or as new", () => {
  const result = evaluateClaudePreflight({ versionText: "Claude Code (dev build)", helpText: HELP_WITH_FLAG });
  assert.equal(result.status, PREFLIGHT_STATUS.MALFORMED_VERSION);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "claude_version_unparsable");
});

test("a build whose help lacks the required flag is not ready, whatever its version says", () => {
  const result = evaluateClaudePreflight({
    versionText: "9.9.9 (Claude Code)",
    helpText: HELP_WITHOUT_FLAG
  });
  assert.equal(result.status, PREFLIGHT_STATUS.MISSING_REQUIRED_CAPABILITY);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "claude_required_flag_absent");
  assert.equal(result.requiredFlag, REQUIRED_RESTRICTED_FLAG);
});

test("an absent executable is unavailable, and is not confused with an old one", () => {
  for (const versionText of [undefined, null, ""]) {
    const result = evaluateClaudePreflight({ versionText, helpText: HELP_WITH_FLAG });
    assert.equal(result.status, PREFLIGHT_STATUS.UNAVAILABLE);
    assert.equal(result.ready, false);
    assert.equal(result.reason, "claude_executable_unavailable");
  }
});

test("readiness that rested only on a version says so rather than implying more", () => {
  // The CLI could not be asked for its help, so the flag was never confirmed.
  const result = evaluateClaudePreflight({ versionText: "2.1.260 (Claude Code)" });
  assert.equal(result.status, PREFLIGHT_STATUS.READY);
  assert.equal(result.ready, true);
  assert.equal(result.capabilityVerified, false, "an unverified capability must not read as verified");
});

test("when the flag is not required, the version floor does not apply", () => {
  const result = evaluateClaudePreflight({
    versionText: "1.0.0 (Claude Code)",
    helpText: HELP_WITHOUT_FLAG,
    requireRestricted: false
  });
  assert.equal(result.status, PREFLIGHT_STATUS.READY);
  assert.equal(result.ready, true);
  assert.equal(result.capabilityVerified, false);
});
