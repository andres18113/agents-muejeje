/**
 * Whether the installed Claude Code can actually run what production runs.
 *
 * The runner launches with `--restricted`, and that flag is not cosmetic: it is
 * how tool exposure is constrained for every delegation. A Claude Code that
 * does not understand it does not start in a weaker mode, it fails on the first
 * launch - so treating "the executable exists" as readiness reports a system as
 * ready that cannot serve a single request.
 *
 * Two independent checks, because either alone is a lie by omission. The
 * version is parsed and compared, since that is the only statement about the
 * whole feature set. The flag is then looked for in the CLI's own help output,
 * because a version number is a claim about a build and the help text is the
 * build itself answering. A version that satisfies the floor but whose help
 * does not mention the flag is reported as missing the capability rather than
 * quietly accepted.
 *
 * Nothing here invokes a model, spends a token, or needs a credential: it reads
 * `--version` and `--help` from whichever executable the environment points at,
 * which is what keeps this runnable in CI against a fake Claude.
 */

export const REQUIRED_RESTRICTED_FLAG = "--restricted";
export const MINIMUM_RESTRICTED_CLAUDE_VERSION = "2.1.248";

export const PREFLIGHT_STATUS = Object.freeze({
  UNAVAILABLE: "unavailable",
  INCOMPATIBLE_VERSION: "incompatible-version",
  MISSING_REQUIRED_CAPABILITY: "missing-required-capability",
  MALFORMED_VERSION: "malformed-version",
  READY: "ready"
});

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/u;

/**
 * Extracts the semantic version from a `claude --version` line.
 *
 * The line carries a product name and often a parenthesised suffix, so the
 * numbers are located rather than assumed to be the whole string. A line with
 * no version-shaped triple is malformed: it is not treated as very old, because
 * "we could not tell" and "it is too old" call for different operator action.
 */
export function parseClaudeVersion(text) {
  if (typeof text !== "string") return undefined;
  const match = VERSION_PATTERN.exec(text);
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1, 4).map((part) => Number(part));
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part >= 0)) return undefined;
  return Object.freeze({ major, minor, patch, text: match[0] });
}

export function compareClaudeVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return 0;
}

export function claudeVersionSatisfies(version, minimum = MINIMUM_RESTRICTED_CLAUDE_VERSION) {
  const parsedMinimum = parseClaudeVersion(minimum);
  if (!version || !parsedMinimum) return false;
  return compareClaudeVersions(version, parsedMinimum) >= 0;
}

/**
 * Decides readiness from observations, so the decision is testable without
 * spawning anything.
 *
 * `helpText` is optional evidence. When it is available the flag must appear in
 * it; when the CLI could not be asked, the version check stands alone and the
 * result says so rather than implying the flag was verified.
 */
export function evaluateClaudePreflight({
  versionText,
  helpText,
  requireRestricted = true,
  minimumVersion = MINIMUM_RESTRICTED_CLAUDE_VERSION,
  requiredFlag = REQUIRED_RESTRICTED_FLAG
} = {}) {
  if (versionText === undefined || versionText === null || versionText === "") {
    return Object.freeze({
      status: PREFLIGHT_STATUS.UNAVAILABLE,
      ready: false,
      reason: "claude_executable_unavailable",
      message: "Claude Code was not found on PATH or could not be executed."
    });
  }

  const version = parseClaudeVersion(versionText);
  if (!version) {
    return Object.freeze({
      status: PREFLIGHT_STATUS.MALFORMED_VERSION,
      ready: false,
      reason: "claude_version_unparsable",
      message: "Claude Code reported a version this preflight cannot parse: " + String(versionText).slice(0, 120)
    });
  }

  if (!requireRestricted) {
    return Object.freeze({
      status: PREFLIGHT_STATUS.READY,
      ready: true,
      version: version.text,
      capabilityVerified: false,
      message: "Claude Code " + version.text + " is present; " + requiredFlag + " was not required."
    });
  }

  if (!claudeVersionSatisfies(version, minimumVersion)) {
    return Object.freeze({
      status: PREFLIGHT_STATUS.INCOMPATIBLE_VERSION,
      ready: false,
      reason: "claude_version_below_minimum",
      version: version.text,
      minimumVersion,
      message: "Claude Code " + version.text + " is below the " + minimumVersion +
        " required for " + requiredFlag + "; production would fail on its first launch."
    });
  }

  // A version floor is a claim about a build. The help output is that build
  // answering for itself, so when it is available it decides.
  if (typeof helpText === "string" && helpText.length > 0 && !helpText.includes(requiredFlag)) {
    return Object.freeze({
      status: PREFLIGHT_STATUS.MISSING_REQUIRED_CAPABILITY,
      ready: false,
      reason: "claude_required_flag_absent",
      version: version.text,
      requiredFlag,
      message: "Claude Code " + version.text + " does not advertise " + requiredFlag + "."
    });
  }

  return Object.freeze({
    status: PREFLIGHT_STATUS.READY,
    ready: true,
    version: version.text,
    requiredFlag,
    // Said plainly, because "ready" resting on a version alone is a weaker
    // statement than "ready" that saw the flag.
    capabilityVerified: typeof helpText === "string" && helpText.includes(requiredFlag),
    message: "Claude Code " + version.text + " satisfies " + requiredFlag + "."
  });
}
