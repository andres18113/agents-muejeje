import assert from "node:assert/strict";
import test from "node:test";
import {
  FLAG_PROBE_STATUS,
  MINIMUM_RESTRICTED_CLAUDE_VERSION,
  PREFLIGHT_STATUS,
  REQUIRED_RESTRICTED_FLAG,
  claudeVersionSatisfies,
  compareClaudeVersions,
  evaluateClaudePreflight,
  evaluateFlagProbe,
  parseClaudeVersion
} from "../src/claude-preflight.mjs";
import { buildClaudeArgs } from "../src/claude-invocation.mjs";

/**
 * Readiness is a claim that the first request will work, and presence of an
 * executable is not that claim. Production launches with --restricted, so a
 * Claude Code that predates the flag fails immediately - reporting such a
 * system as ready would send an operator into a guaranteed failure believing
 * the diagnostic had checked.
 *
 * Four outcomes are kept distinct because they call for different actions:
 * install Claude Code, upgrade it, investigate a build that positively rejects
 * the required flag, or investigate one whose version cannot be read at all.
 * Collapsing them into a boolean would tell an operator nothing about what
 * to do next.
 *
 * Help text is deliberately not one of the refuting signals: it is not a
 * capability API, so its silence about the flag is inconclusive. Only the
 * binary itself rejecting the flag probe reports a missing capability.
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

test("help text that omits the flag is inconclusive, never a missing capability", () => {
  // The P2 regression: absence from `--help` used to report the capability
  // missing. Help output is not a capability API, so a version-satisfying
  // build with silent help is ready-but-unverified.
  const result = evaluateClaudePreflight({
    versionText: "9.9.9 (Claude Code)",
    helpText: HELP_WITHOUT_FLAG
  });
  assert.equal(result.status, PREFLIGHT_STATUS.READY);
  assert.equal(result.ready, true);
  assert.equal(result.capabilityVerified, false);
  assert.match(result.message, /neither the flag probe nor the help text confirmed/u);
});

test("a clean flag probe verifies the capability even when help is silent", () => {
  const result = evaluateClaudePreflight({
    versionText: "9.9.9 (Claude Code)",
    helpText: HELP_WITHOUT_FLAG,
    flagProbe: { status: 0, output: "Usage: claude [options]\n" }
  });
  assert.equal(result.status, PREFLIGHT_STATUS.READY);
  assert.equal(result.ready, true);
  assert.equal(result.capabilityVerified, true);
});

test("only the binary rejecting the flag probe reports a missing capability", () => {
  const result = evaluateClaudePreflight({
    versionText: "9.9.9 (Claude Code)",
    helpText: HELP_WITH_FLAG,
    flagProbe: { status: 1, output: "error: unknown option '--restricted'\n" }
  });
  assert.equal(result.status, PREFLIGHT_STATUS.MISSING_REQUIRED_CAPABILITY);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "claude_required_flag_rejected");
  assert.equal(result.requiredFlag, REQUIRED_RESTRICTED_FLAG);
});

test("an inconclusive probe leaves a version-satisfying build ready-but-unverified", () => {
  const inconclusive = [
    undefined,
    { status: null, output: undefined },
    { status: 1, output: "" },
    { status: 1, output: "some crash without diagnostics\n" },
    // A rejection naming a different token is not a verdict about this flag.
    { status: 1, output: "error: unknown option '--frobnicate'\nUsage: claude [options]\n" }
  ];
  for (const flagProbe of inconclusive) {
    const result = evaluateClaudePreflight({
      versionText: "9.9.9 (Claude Code)",
      helpText: HELP_WITHOUT_FLAG,
      flagProbe
    });
    assert.equal(result.status, PREFLIGHT_STATUS.READY, JSON.stringify(flagProbe));
    assert.equal(result.ready, true, JSON.stringify(flagProbe));
    assert.equal(result.capabilityVerified, false, JSON.stringify(flagProbe));
  }
});

test("the flag probe needs a non-zero exit, a diagnostic, and the flag's name", () => {
  assert.equal(
    evaluateFlagProbe({ status: 0, output: "Usage: claude [options]\n" }),
    FLAG_PROBE_STATUS.RECOGNIZED
  );
  // Commander-style rejection.
  assert.equal(
    evaluateFlagProbe({ status: 1, output: "error: unknown option '--restricted'\n" }),
    FLAG_PROBE_STATUS.REJECTED
  );
  // Yargs-style rejection, without dashes.
  assert.equal(
    evaluateFlagProbe({ status: 1, output: "Unrecognized argument: restricted\n" }),
    FLAG_PROBE_STATUS.REJECTED
  );
  // A non-zero exit alone is a crash, not a verdict.
  assert.equal(
    evaluateFlagProbe({ status: 1, output: "Usage: claude [options]\n" }),
    FLAG_PROBE_STATUS.UNKNOWN
  );
  // A diagnostic about another token is not a verdict about this flag, even
  // when a usage dump nearby happens to list it.
  assert.equal(
    evaluateFlagProbe({
      status: 1,
      output: "error: unknown option '--frobnicate'\n" + HELP_WITH_FLAG + "\n"
    }),
    FLAG_PROBE_STATUS.UNKNOWN
  );
  // No observation at all: timeouts and spawn failures stay unknown.
  for (const observation of [undefined, null, {}, { status: null }, { status: 1 }]) {
    assert.equal(evaluateFlagProbe(observation), FLAG_PROBE_STATUS.UNKNOWN, JSON.stringify(observation));
  }
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

test("the runtime launches exactly the flag the preflight probes for", () => {
  // Import-based, not literal-based: production cannot skew onto a different
  // flag string than the readiness check verifies.
  const args = buildClaudeArgs(
    {
      model: "opus",
      reasoningEffort: "high",
      permissionMode: "default",
      toolNames: ["Bash"],
      disallowedTools: ["mcp__*"]
    },
    "settings.json"
  );
  assert.ok(args.includes(REQUIRED_RESTRICTED_FLAG));
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
