import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PROCESS_IDENTITY_STATUS, inspectProcessIdentity } from "./process-identity.mjs";
import {
  GIT_COMMAND_TIMEOUT_MS,
  GIT_ENVIRONMENT_ALLOWLIST,
  MAX_GIT_OUTPUT_BYTES,
  buildGitEnvironment,
  gitHookIsolationArguments,
  runGitCommand
} from "./git-command.mjs";
import { canonicalRepositoryKey } from "./workspace-root.mjs";

export class WorktreeManagerError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WorktreeManagerError";
    this.code = options.code || "worktree_failed";
    // A timed-out Git process is killed, but killing it never proves what it
    // had already written. Callers must treat this as ambiguous, not as
    // evidence that the command had no effect.
    this.sideEffectsUnproven = options.sideEffectsUnproven === true;
    // True only when the exact Git child was observed to close after we asked
    // it to die and any launched taskkill helper also proved its own close.
    // Never implied by a timeout alone.
    this.terminationProven = options.terminationProven === true;
  }
}

async function pathExists(pathname) {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The Git primitives now live in git-command.mjs so a read-only caller can use
 * them without importing this module's writer lifecycle. They are re-exported
 * here because they are part of this module's established public surface.
 */
export {
  GIT_COMMAND_TIMEOUT_MS,
  GIT_ENVIRONMENT_ALLOWLIST,
  buildGitEnvironment,
  gitHookIsolationArguments
};

/**
 * Runs one orchestration Git command and maps every failure into this module's
 * error vocabulary.
 *
 * The returned shape is deliberately narrower than runGitCommand's: callers in
 * the worktree lifecycle branch on WorktreeManagerError, never on an exit code,
 * so exposing one here would invite a second way to decide the same thing.
 */
export async function runGit(
  args,
  {
    maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
    timeoutMs = GIT_COMMAND_TIMEOUT_MS,
    ...options
  } = {}
) {
  try {
    const result = await runGitCommand(args, { ...options, maxOutputBytes, timeoutMs });
    return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    throw asWorktreeManagerError(error);
  }
}

const GIT_ERROR_CODES = Object.freeze({
  supervised_process_timeout: "worktree_git_timeout",
  supervised_process_output_overflow: "worktree_git_output_overflow",
  supervised_process_spawn_failed: "worktree_git_spawn_failed",
  supervised_process_timeout_invalid: "worktree_git_timeout_invalid",
  supervised_process_output_limit_invalid: "worktree_git_output_limit_invalid",
  supervised_process_failed: "worktree_git_failed"
});

function asWorktreeManagerError(error) {
  if (error instanceof WorktreeManagerError) return error;
  const code = GIT_ERROR_CODES[error?.code] || "worktree_git_failed";
  return new WorktreeManagerError(error?.message || "Git worktree command failed.", {
    code,
    cause: error,
    sideEffectsUnproven: error?.sideEffectsUnproven === true,
    terminationProven: error?.terminationProven === true
  });
}

/**
 * Use Git's common directory as the durable repository identity so the main
 * checkout and every linked worktree contend for the same writer record.
 */
export async function resolveRepositoryCoordinationIdentity(
  workspace,
  {
    runGitCommand = runGit,
    realpathFn = realpath,
    platform = process.platform
  } = {}
) {
  if (!workspace || typeof workspace !== "object") {
    throw new WorktreeManagerError("A resolved workspace is required for repository identity.", {
      code: "repository_identity_invalid"
    });
  }
  if (workspace.rootSource !== "git-boundary") return Object.freeze({ ...workspace });

  let commonDirectory;
  try {
    const result = await runGitCommand(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: workspace.effectiveCwd }
    );
    const reported = result.stdout.trim();
    if (!reported) throw new Error("empty common Git directory");
    commonDirectory = await realpathFn(
      path.isAbsolute(reported) ? reported : path.resolve(workspace.effectiveCwd, reported)
    );
  } catch (error) {
    throw new WorktreeManagerError(
      "Cannot establish the canonical Git repository identity for durable write admission.",
      { code: "repository_identity_unavailable", cause: error }
    );
  }

  return Object.freeze({
    ...workspace,
    repositoryIdentity: commonDirectory,
    canonicalRepositoryKey: canonicalRepositoryKey(commonDirectory, { platform })
  });
}

/**
 * Re-anchors the requested directory from the repository root onto the
 * isolated workspace root, preserving the caller's relative position.
 */
function isolatedCwdFor(workspaceRoot, repositoryRoot, effectiveCwd) {
  const relative = path.relative(repositoryRoot, effectiveCwd);
  if (relative === "" || relative === ".") return workspaceRoot;
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
    throw new WorktreeManagerError("Requested cwd is outside the canonical repository root.", {
      code: "worktree_cwd_outside_repository"
    });
  }
  return path.join(workspaceRoot, relative);
}

/**
 * Creates a detached worktree for a general-purpose worker. It never removes,
 * commits, merges, rebases, or pushes the resulting workspace.
 */
export class GitWorktreeManager {
  #writeCustody;
  #runGit;
  #stat;
  #inspectProcess;

  constructor({
    writeCustody,
    runGitCommand = runGit,
    statFn = stat,
    inspectProcess = inspectProcessIdentity
  } = {}) {
    if (!writeCustody || typeof writeCustody.worktreeRootFor !== "function") {
      throw new WorktreeManagerError("A durable write custody manager is required.");
    }
    this.#writeCustody = writeCustody;
    this.#runGit = runGitCommand;
    this.#stat = statFn;
    this.#inspectProcess = inspectProcess;
  }

  /**
   * Captures the durable identity of the exact Git process performing the
   * mutating worktree add and persists it on the owning record. A coordinator
   * that dies after this point leaves behind enough evidence for the next one
   * to tell a live Git operation from a finished one.
   */
  async #recordGitOperation(child, { executionId, canonicalRepositoryKey }) {
    let observation;
    try {
      observation = await this.#inspectProcess(child?.pid);
    } catch {
      return;
    }
    if (observation?.status !== PROCESS_IDENTITY_STATUS.ALIVE || !observation.identity) return;
    await this.#writeCustody.recordWorktreeOperation({
      executionId,
      canonicalRootKey: canonicalRepositoryKey,
      gitOperation: {
        kind: "worktree-add",
        pid: observation.identity.pid,
        startTime: observation.identity.startTime,
        source: observation.identity.source
      }
    });
  }

  /**
   * Builds the isolated execution workspace for one general-purpose worker.
   *
   *   repositoryRoot the coordinated repository this worktree is cut from
   *   workspaceRoot  the isolated worktree the worker actually operates in
   *   effectiveCwd   the requested directory re-anchored inside workspaceRoot
   */
  async prepare({ executionId, canonicalRepositoryKey, repositoryRoot, effectiveCwd }) {
    const workspaceRoot = this.#writeCustody.worktreeRootFor({
      canonicalRootKey: canonicalRepositoryKey,
      executionId
    });
    if (await pathExists(workspaceRoot)) {
      throw new WorktreeManagerError("The isolated worktree path already exists: " + workspaceRoot, {
        code: "worktree_path_conflict"
      });
    }

    let baseCommit;
    try {
      const result = await this.#runGit(["rev-parse", "--verify", "HEAD"], { cwd: repositoryRoot });
      baseCommit = result.stdout.trim();
    } catch (error) {
      throw new WorktreeManagerError(
        "general-purpose requires a Git repository with a resolvable HEAD for worktree isolation.",
        {
          code: "worktree_git_repository_required",
          cause: error,
          // A Git deadline says nothing about what Git already did. Any timeout
          // inside preparation stays ambiguous so custody fails closed.
          sideEffectsUnproven: error?.sideEffectsUnproven === true
        }
      );
    }
    if (!/^[0-9a-f]{40,64}$/iu.test(baseCommit)) {
      throw new WorktreeManagerError("Git returned an invalid base commit for worktree isolation.", {
        code: "worktree_base_commit_invalid"
      });
    }

    await mkdir(path.dirname(workspaceRoot), { recursive: true });
    await this.#writeCustody.beginWorktreePreparation({
      executionId,
      canonicalRootKey: canonicalRepositoryKey,
      baseCommit,
      worktreeRoot: workspaceRoot
    });
    // `git worktree add` mutates the repository. Hooks are disabled so that
    // preparing an isolated workspace never executes repository-supplied
    // post-checkout scripts. If it times out the error carries
    // sideEffectsUnproven so the caller retains custody instead of treating
    // the delegation as provably side-effect free.
    let operationRecorded = Promise.resolve();
    const worktreeAdd = this.#runGit(["worktree", "add", "--detach", workspaceRoot, baseCommit], {
      cwd: repositoryRoot,
      disableHooks: true,
      onSpawned: (child) => {
        operationRecorded = this.#recordGitOperation(child, {
          executionId,
          canonicalRepositoryKey
        });
      }
    });
    // The Git run is bounded and always settles. The recorded operation is
    // cleared only when that exact Git child is proven to have closed: on
    // success, on a plain nonzero exit, or after a termination whose close we
    // observed. An unproven termination deliberately leaves the identity on
    // the record so a later coordinator can reconcile it.
    let addFailure;
    try {
      await worktreeAdd;
    } catch (error) {
      addFailure = error;
    }
    try {
      await operationRecorded;
    } catch (error) {
      // The Git process was already running when recording failed, so nothing
      // proves the repository was left untouched. Fail closed rather than
      // releasing custody as if preparation had never started.
      throw new WorktreeManagerError(
        "Could not persist the supervised Git worktree operation identity.",
        { code: "worktree_git_operation_unrecorded", cause: error, sideEffectsUnproven: true }
      );
    }
    const gitChildProvenClosed = !addFailure ||
      addFailure.code === "worktree_git_failed" ||
      addFailure.terminationProven === true;
    if (gitChildProvenClosed) {
      await this.#writeCustody.clearWorktreeOperation({
        executionId,
        canonicalRootKey: canonicalRepositoryKey
      });
    }
    if (addFailure) throw addFailure;

    const effectiveWorkerCwd = isolatedCwdFor(workspaceRoot, repositoryRoot, effectiveCwd);
    let details;
    try {
      details = await this.#stat(effectiveWorkerCwd);
    } catch (error) {
      throw new WorktreeManagerError(
        "The requested cwd does not exist in the isolated worktree: " + effectiveWorkerCwd,
        { code: "worktree_effective_cwd_missing", cause: error }
      );
    }
    if (!details.isDirectory()) {
      throw new WorktreeManagerError("The isolated worker cwd is not a directory: " + effectiveWorkerCwd, {
        code: "worktree_effective_cwd_invalid"
      });
    }

    await this.#writeCustody.markSpawning({
      executionId,
      canonicalRootKey: canonicalRepositoryKey
    });
    return Object.freeze({
      effectiveCwd: effectiveWorkerCwd,
      repositoryRoot,
      canonicalRepositoryKey,
      rootSource: "isolated-git-worktree",
      workspaceRoot,
      baseCommit
    });
  }
}
