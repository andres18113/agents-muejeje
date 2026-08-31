import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspaceRootError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WorkspaceRootError";
    this.code = options.code || "workspace_root_unresolved";
  }
}

/**
 * Derives the coordination key for a repository root. The key exists only to
 * make two textual spellings of the same root contend for the same durable
 * writer record; it is never used as a filesystem path.
 */
export function canonicalRepositoryKey(repositoryRoot, { platform = process.platform } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new WorkspaceRootError("A non-empty repository root is required.");
  }

  const normalized = path.normalize(repositoryRoot);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function gitBoundaryExists(directory, { lstatFn }) {
  try {
    const details = await lstatFn(path.join(directory, ".git"));
    return details.isDirectory() || details.isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/**
 * Canonicalize the requested working directory, then walk upward to the
 * nearest Git worktree/repository marker. A .git directory and a worktree's
 * .git pointer file are both valid boundaries. Non-Git workspaces use their
 * real cwd as their independent root.
 *
 * Returns the coordinated repository identity:
 *   effectiveCwd           the canonicalized directory that was requested
 *   repositoryRoot         the original repository/root used for coordination
 *                          and durable ownership
 *   canonicalRepositoryKey the coordination key derived from repositoryRoot
 *
 * repositoryRoot is never the isolated worktree a general-purpose worker later
 * executes in; that root is named workspaceRoot and is produced downstream by
 * the worktree manager.
 */
export async function resolveCanonicalWorkspaceRoot(
  cwd,
  {
    accessMode = "read",
    realpathFn = realpath,
    lstatFn = lstat,
    platform = process.platform
  } = {}
) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new WorkspaceRootError("A non-empty working directory is required.");
  }
  if (!["read", "write"].includes(accessMode)) {
    throw new WorkspaceRootError("Workspace access mode must be read or write.", {
      code: "workspace_access_mode_invalid"
    });
  }

  let effectiveCwd;
  try {
    effectiveCwd = await realpathFn(cwd);
  } catch (error) {
    if (accessMode === "write") {
      throw new WorkspaceRootError(
        "Cannot establish a canonical repository root for write access: " + cwd,
        { cause: error }
      );
    }

    effectiveCwd = path.resolve(cwd);
    return Object.freeze({
      effectiveCwd,
      repositoryRoot: effectiveCwd,
      canonicalRepositoryKey: canonicalRepositoryKey(effectiveCwd, { platform }),
      rootSource: "read-cwd-fallback"
    });
  }

  let candidate = effectiveCwd;
  try {
    while (true) {
      if (await gitBoundaryExists(candidate, { lstatFn })) {
        return Object.freeze({
          effectiveCwd,
          repositoryRoot: candidate,
          canonicalRepositoryKey: canonicalRepositoryKey(candidate, { platform }),
          rootSource: "git-boundary"
        });
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
    }
  } catch (error) {
    if (accessMode === "write") {
      throw new WorkspaceRootError(
        "Cannot establish a canonical repository root for write access: " + effectiveCwd,
        { cause: error }
      );
    }
  }

  return Object.freeze({
    effectiveCwd,
    repositoryRoot: effectiveCwd,
    canonicalRepositoryKey: canonicalRepositoryKey(effectiveCwd, { platform }),
    rootSource: "cwd"
  });
}
