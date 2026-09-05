/**
 * Whether the installed Claude Code can actually run what production runs.
 *
 * The runner launches with `--restricted`, and that flag is not cosmetic: it is
 * how tool exposure is constrained for every delegation. A Claude Code that
 * does not understand it does not start in a weaker mode, it fails on the first
 * launch - so treating "the executable exists" as readiness reports a system as
 * ready that cannot serve a single request.
 *
 * Three signals, each read for what it actually says. The version floor is the
 * support statement: builds below it predate the flag, so below-the-floor is
 * positive evidence of incompatibility. The binary is then asked directly with
 * a supported, non-destructive probe - `claude --restricted --help`, the flag
 * under test plus `--help` so the CLI answers without doing any work. Only the
 * binary rejecting that probe proves the capability missing. The help text is
 * corroboration in one direction only: mentioning the flag confirms it, but
 * help output is not a capability API - flags can be hidden, truncated, or
 * laid out differently - so absence there proves nothing and never reports a
 * missing capability on its own.
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

export const FLAG_PROBE_STATUS = Object.freeze({
  RECOGNIZED: "recognized",
  REJECTED: "rejected",
  UNKNOWN: "unknown"
});

// Heads of unknown-option diagnostics across common CLI frameworks, each
// requiring the flag's own name on the same line so a rejection of some other
// token - or a usage dump that merely lists every flag - cannot read as a
// rejection of this one.
const UNKNOWN_OPTION_HEADS = [
  "unknown option",
  "unknown flag",
  "unrecognized option",
  "unrecognized flag",
  "unrecognized argument",
  "no such option"
];

/**
 * Reads one flag-recognition probe: the exit status and combined output of
 * `claude <flag> --help`.
 *
 * `rejected` is deliberately hard to reach. It needs all three of a real
 * non-zero exit, an unknown-option diagnostic, and the flag's own name on the
 * same line as that diagnostic - a timeout, a spawn failure, a crash without
 * diagnostics, or a rejection naming a different token all read as `unknown`
 * rather than as a verdict about this flag. The same-line bound matters: an
 * error followed by a usage dump lists every flag, and a window reaching past
 * the line break would launder that dump into a verdict. `recognized` needs a
 * clean exit: the binary accepted the flag far enough to render help.
 */
export function evaluateFlagProbe(observation, requiredFlag = REQUIRED_RESTRICTED_FLAG) {
  const status = observation?.status;
  const output = observation?.output;
  if (status === 0) return FLAG_PROBE_STATUS.RECOGNIZED;
  if (!Number.isSafeInteger(status) || status === 0 || typeof output !== "string" || output.length === 0) {
    return FLAG_PROBE_STATUS.UNKNOWN;
  }
  const flagName = String(requiredFlag).replace(/^-+/u, "").toLowerCase();
  if (!flagName) return FLAG_PROBE_STATUS.UNKNOWN;
  for (const line of output.toLowerCase().split("\n")) {
    if (!UNKNOWN_OPTION_HEADS.some((head) => line.includes(head))) continue;
    if (line.includes(flagName)) return FLAG_PROBE_STATUS.REJECTED;
  }
  return FLAG_PROBE_STATUS.UNKNOWN;
}

/**
 * Decides readiness from observations, so the decision is testable without
 * spawning anything.
 *
 * `helpText` and `flagProbe` are optional corroborating evidence. Either one
 * confirming the flag verifies the capability; neither one may refute it
 * except the probe's positive rejection. In particular, help text that omits
 * the flag is inconclusive - help output is not a capability API - so a
 * version-satisfying build with unhelpful help is ready-but-unverified, never
 * missing.
 */
export function evaluateClaudePreflight({
  versionText,
  helpText,
  flagProbe,
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

  // Only the binary itself rejecting the flag proves the capability missing.
  // Help text that omits it proves nothing: help output is not a capability
  // API, so silence there leaves the build ready-but-unverified.
  const probeStatus = evaluateFlagProbe(flagProbe, requiredFlag);
  if (probeStatus === FLAG_PROBE_STATUS.REJECTED) {
    return Object.freeze({
      status: PREFLIGHT_STATUS.MISSING_REQUIRED_CAPABILITY,
      ready: false,
      reason: "claude_required_flag_rejected",
      version: version.text,
      requiredFlag,
      message: "Claude Code " + version.text + " rejects " + requiredFlag + "."
    });
  }

  // Said plainly, because "ready" resting on a version alone is a weaker
  // statement than "ready" that saw the flag accepted or advertised.
  const capabilityVerified = probeStatus === FLAG_PROBE_STATUS.RECOGNIZED ||
    (typeof helpText === "string" && helpText.includes(requiredFlag));
  return Object.freeze({
    status: PREFLIGHT_STATUS.READY,
    ready: true,
    version: version.text,
    requiredFlag,
    capabilityVerified,
    message: capabilityVerified
      ? "Claude Code " + version.text + " satisfies " + requiredFlag + "."
      : "Claude Code " + version.text + " meets the " + minimumVersion +
        " minimum for " + requiredFlag + ", but neither the flag probe nor the help text confirmed it."
  });
}
