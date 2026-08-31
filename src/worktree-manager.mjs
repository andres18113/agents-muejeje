import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalRootKey } from "./workspace-root.mjs";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

export class WorktreeManagerError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WorktreeManagerError";
    this.code = options.code || "worktree_failed";
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

export function runGit(
  args,
  {
    cwd,
    spawnProcess = spawn,
    env = process.env,
    maxOutputBytes = MAX_GIT_OUTPUT_BYTES
  } = {}
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess("git", args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new WorktreeManagerError("Failed to start Git for isolated worktree preparation.", {
        code: "worktree_git_spawn_failed",
        cause: error
      }));
      return;
    }

    const stdout = [];
    const stderr = [];
    let captured = 0;
    let overflow = false;
    const capture = (chunks, chunk) => {
      if (overflow) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      captured += buffer.length;
      if (captured > maxOutputBytes) {
        overflow = true;
        try {
          child.kill?.();
        } catch {
          // The child may already have exited.
        }
        return;
      }
      chunks.push(buffer);
    };
    child.stdout?.on?.("data", (chunk) => capture(stdout, chunk));
    child.stderr?.on?.("data", (chunk) => capture(stderr, chunk));
    child.once?.("error", (error) => {
      reject(new WorktreeManagerError("Git failed during isolated worktree preparation.", {
        code: "worktree_git_spawn_failed",
        cause: error
      }));
    });
    child.once?.("close", (code) => {
      if (overflow) {
        reject(new WorktreeManagerError("Git worktree output exceeded the capture limit.", {
          code: "worktree_git_output_overflow"
        }));
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new WorktreeManagerError(
          "Git worktree command failed with exit code " + String(code) +
            (stderrText ? ": " + stderrText : "."),
          { code: "worktree_git_failed" }
        ));
        return;
      }
      resolve(Object.freeze({ stdout: stdoutText, stderr: stderrText }));
    });
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
    canonicalRootKey: canonicalRootKey(commonDirectory, { platform })
  });
}

function isolatedCwdFor(worktreeRoot, canonicalRoot, effectiveCwd) {
  const relative = path.relative(canonicalRoot, effectiveCwd);
  if (relative === "" || relative === ".") return worktreeRoot;
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
    throw new WorktreeManagerError("Requested cwd is outside the canonical repository root.", {
      code: "worktree_cwd_outside_repository"
    });
  }
  return path.join(worktreeRoot, relative);
}

/**
 * Creates a detached worktree for a general-purpose worker. It never removes,
 * commits, merges, rebases, or pushes the resulting workspace.
 */
export class GitWorktreeManager {
  #writeCustody;
  #runGit;
  #stat;

  constructor({ writeCustody, runGitCommand = runGit, statFn = stat } = {}) {
    if (!writeCustody || typeof writeCustody.worktreeRootFor !== "function") {
      throw new WorktreeManagerError("A durable write custody manager is required.");
    }
    this.#writeCustody = writeCustody;
    this.#runGit = runGitCommand;
    this.#stat = statFn;
  }

  async prepare({ executionId, canonicalRootKey, canonicalRoot, effectiveCwd }) {
    const worktreeRoot = this.#writeCustody.worktreeRootFor({ canonicalRootKey, executionId });
    if (await pathExists(worktreeRoot)) {
      throw new WorktreeManagerError("The isolated worktree path already exists: " + worktreeRoot, {
        code: "worktree_path_conflict"
      });
    }

    let baseCommit;
    try {
      const result = await this.#runGit(["rev-parse", "--verify", "HEAD"], { cwd: canonicalRoot });
      baseCommit = result.stdout.trim();
    } catch (error) {
      throw new WorktreeManagerError(
        "general-purpose requires a Git repository with a resolvable HEAD for worktree isolation.",
        { code: "worktree_git_repository_required", cause: error }
      );
    }
    if (!/^[0-9a-f]{40,64}$/iu.test(baseCommit)) {
      throw new WorktreeManagerError("Git returned an invalid base commit for worktree isolation.", {
        code: "worktree_base_commit_invalid"
      });
    }

    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    await this.#writeCustody.beginWorktreePreparation({
      executionId,
      canonicalRootKey,
      baseCommit,
      worktreeRoot
    });
    await this.#runGit(["worktree", "add", "--detach", worktreeRoot, baseCommit], {
      cwd: canonicalRoot
    });

    const effectiveWorkerCwd = isolatedCwdFor(worktreeRoot, canonicalRoot, effectiveCwd);
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

    await this.#writeCustody.markSpawning({ executionId, canonicalRootKey });
    return Object.freeze({
      effectiveCwd: effectiveWorkerCwd,
      canonicalRoot,
      canonicalRootKey,
      rootSource: "isolated-git-worktree",
      worktreeRoot,
      baseCommit
    });
  }
}
