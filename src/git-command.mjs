import { runSupervisedProcess } from "./supervised-process.mjs";

/**
 * The read-capable Git invocation primitive.
 *
 * This module owns how an orchestration-owned Git child is configured and
 * bounded, and nothing else. It makes no lifecycle decisions, holds no custody,
 * and never classifies a failure into a domain vocabulary: a caller that wants
 * worktree-shaped errors wraps it, and a caller that needs to tell "this ref
 * does not resolve" from "Git broke" reads the SupervisedProcessError directly.
 *
 * It was extracted from worktree-manager so a read-only path (change-set
 * collection) can run Git without importing the writer lifecycle. The exported
 * environment and hook-isolation behavior is byte-for-byte what Phase 5 used.
 */

export const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

/**
 * Every Git process this module starts is bounded. Three minutes is
 * deliberately generous: `git worktree add` on a large repository, on a cold
 * page cache, or on a network-backed Windows volume can legitimately take a
 * long time, and a false timeout costs a repository its write custody. It is
 * still finite, so a wedged Git process can never hang a delegation forever.
 */
export const GIT_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Orchestration Git is an external execution boundary, exactly like the Claude
 * child. It gets an explicit compatibility allowlist rather than the parent
 * environment, so unrelated secret-bearing variables (tokens, cloud
 * credentials, CI secrets) are not handed to Git or to anything Git starts.
 *
 * Only what is needed to locate and run Git, operate on Windows, use a
 * temporary directory, and act on a local repository is preserved. Nothing
 * here selects a remote, an identity, or a credential helper.
 */
export const GIT_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "SystemDrive",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TEMP",
  "TMP",
  "TMPDIR",
  "OS",
  "PROCESSOR_ARCHITECTURE"
]);

function findEnvironmentValue(env, name) {
  if (!env || typeof env !== "object") return undefined;
  const expected = name.toUpperCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toUpperCase() === expected && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Builds the environment for one orchestration-owned Git invocation.
 *
 * Beyond the allowlist it pins deterministic Git behavior:
 *
 *   GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM
 *     ignore system and per-user configuration, so orchestration Git does not
 *     depend on whatever the host developer happens to have configured;
 *   GIT_TERMINAL_PROMPT / GIT_ASKPASS / GIT_OPTIONAL_LOCKS
 *     never block on an interactive prompt;
 *   GIT_ATTR_NOSYSTEM
 *     ignore system-wide attribute files.
 *
 * The empty config paths are the documented Git mechanism for "no config
 * file"; on Windows the null device is used, which is not machine-specific.
 */
export function buildGitEnvironment(parentEnvironment = process.env, { platform = process.platform } = {}) {
  const environment = {};
  for (const name of GIT_ENVIRONMENT_ALLOWLIST) {
    const value = findEnvironmentValue(parentEnvironment, name);
    if (value !== undefined) environment[name] = value;
  }

  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = nullDevice;
  environment.GIT_CONFIG_SYSTEM = nullDevice;
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_ASKPASS = "";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return Object.freeze(environment);
}

/**
 * Arguments that disable ordinary repository hooks for one invocation.
 *
 * `git worktree add` performs a checkout, which runs post-checkout hooks from
 * the repository's configured hooks directory. Orchestration-owned worktree
 * creation must not execute repository-supplied scripts as a side effect of
 * preparing an isolated workspace, so core.hooksPath is pointed at the null
 * device: a deterministic, non-machine-specific location that contains no
 * executable hook.
 *
 * Honest scope: this stops hooks. It does NOT make checkout side-effect free.
 * Checkout still applies clean/smudge filters, .gitattributes rules and
 * config-driven behavior from the repository itself. Those remain inside the
 * local-repository trust boundary and are not neutralized here.
 */
export function gitHookIsolationArguments({ platform = process.platform } = {}) {
  return ["-c", "core.hooksPath=" + (platform === "win32" ? "NUL" : "/dev/null")];
}

/**
 * Runs exactly one orchestration Git command through the supervised external
 * process primitive: bounded execution, bounded output, exact-process
 * termination, bounded terminal wait, and fail-closed ambiguity.
 *
 * Unlike runGit, this propagates the raw SupervisedProcessError and returns the
 * exit code. Both matter to a read-only caller: a nonzero exit from
 * `rev-parse --verify` is an exact fact about the repository, while a timeout
 * or a spawn failure is an absence of knowledge, and the two must not collapse
 * into one error type.
 */
export async function runGitCommand(
  args,
  {
    cwd,
    env = process.env,
    platform = process.platform,
    maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
    timeoutMs = GIT_COMMAND_TIMEOUT_MS,
    disableHooks = false,
    encoding = "utf8",
    runProcess = runSupervisedProcess,
    onSpawned,
    ...supervision
  } = {}
) {
  const gitArguments = disableHooks
    ? [...gitHookIsolationArguments({ platform }), ...args]
    : [...args];

  const result = await runProcess("git", gitArguments, {
    cwd,
    env: buildGitEnvironment(env, { platform }),
    platform,
    maxOutputBytes,
    timeoutMs,
    encoding,
    describeCommand: () => "git " + args.join(" "),
    onSpawned,
    ...supervision
  });
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
}
