/**
 * Build the child environment from an explicit compatibility allowlist.
 * Values are intentionally never logged. This is not a secret scanner: it
 * prevents the default inheritance of unrelated parent-process variables.
 */

export const CLAUDE_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "SystemDrive",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS"
]);

function findEnvironmentValue(env, name) {
  if (!env || typeof env !== "object") {
    return undefined;
  }

  const expected = name.toUpperCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toUpperCase() === expected && typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

/**
 * Returns only compatibility variables needed to start Claude Code and find
 * its local profile/configuration on Windows and other supported platforms.
 */
export function buildClaudeEnvironment(parentEnvironment = process.env) {
  const childEnvironment = {};

  for (const name of CLAUDE_ENVIRONMENT_ALLOWLIST) {
    const value = findEnvironmentValue(parentEnvironment, name);
    if (value !== undefined) {
      childEnvironment[name] = value;
    }
  }

  return Object.freeze(childEnvironment);
}
