import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  executionHistoryDirectoryIn,
  validateDurableOwnershipRecord
} from "../write-custody.mjs";
import { NO_REVIEW_TARGET, reviewTargetSpec } from "../changeset/target.mjs";

/**
 * Where a review's target comes from when the request did not name one.
 *
 * A general-purpose execution may declare the ref its work is aimed at, and
 * that declaration is recorded on its ownership record and archived with it.
 * When a review later runs inside that retained worktree, it should inherit the
 * same target rather than silently reviewing against nothing.
 *
 * The lookup is by name, never by scanning. A managed worktree lives at
 * <repositoryState>/worktrees/<executionId>, so the directory name *is* the
 * execution id, and the archived record is then one known path away. Nothing
 * here enumerates a directory, which keeps it consistent with the rest of the
 * durable-state code and immune to unrelated siblings appearing.
 *
 * Every failure is silent and returns "no target". An unreadable record means
 * we do not know the target, and not knowing is correctly represented by the
 * absence of one - never by a guess.
 */

const WORKTREES_DIRECTORY_NAME = "worktrees";
const RECORD_FILE_NAME = "record.json";

function segmentsWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || path.isAbsolute(relative)) return undefined;
  if (relative === ".." || relative.startsWith(".." + path.sep)) return undefined;
  return relative.split(path.sep).filter((segment) => segment.length > 0);
}

/**
 * Returns the execution id of the managed worktree containing this directory,
 * or undefined when the directory is not inside one.
 */
export function managedWorktreeExecutionId({ effectiveCwd, repositoryStateDirectory }) {
  const worktreesRoot = path.join(repositoryStateDirectory, WORKTREES_DIRECTORY_NAME);
  const segments = segmentsWithin(worktreesRoot, effectiveCwd);
  return segments && segments.length > 0 ? segments[0] : undefined;
}

async function readRecordTargetRef(recordPath, requestContext) {
  try {
    requestContext?.assertActive?.("review-target-record-read");
    const record = validateDurableOwnershipRecord(JSON.parse(await readFile(recordPath, "utf8")));
    return record?.targetRef;
  } catch (error) {
    if (error?.code === "claude_cancelled" || error?.code === "delegate_request_deadline_exceeded") {
      throw error;
    }
    return undefined;
  }
}

/**
 * Resolves the review target spec for one delegation.
 *
 * An explicit request always wins; a retained worktree's recorded target is the
 * fallback; otherwise there is no target. Inheritance is deliberately limited
 * to these two provenances so a spec can always say where it came from.
 */
export async function resolveReviewTargetSpec({
  requestedTargetRef,
  effectiveCwd,
  repositoryStateDirectory,
  requestContext
}) {
  if (requestedTargetRef !== undefined && requestedTargetRef !== null) {
    return reviewTargetSpec({ ref: requestedTargetRef, source: "request" });
  }

  if (!repositoryStateDirectory) return NO_REVIEW_TARGET;

  const executionId = managedWorktreeExecutionId({ effectiveCwd, repositoryStateDirectory });
  if (!executionId) return NO_REVIEW_TARGET;

  const archived = path.join(
    executionHistoryDirectoryIn(repositoryStateDirectory, executionId),
    RECORD_FILE_NAME
  );
  const targetRef = await readRecordTargetRef(archived, requestContext);
  if (targetRef === undefined) return NO_REVIEW_TARGET;

  try {
    return reviewTargetSpec({ ref: targetRef, source: "worktree-metadata" });
  } catch {
    return NO_REVIEW_TARGET;
  }
}
