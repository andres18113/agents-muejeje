import path from "node:path";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { GIT_COMMAND_TIMEOUT_MS, runGitCommand } from "../git-command.mjs";
import { CUSTODY_KINDS, custodyKindOf } from "../write-custody.mjs";
import { encodePath, parsePorcelainV2 } from "./porcelain-parser.mjs";
import {
  buildChangeSetDescriptor,
  changeSetIdFor
} from "./descriptor.mjs";
import { NO_REVIEW_TARGET, resolveReviewTargetContext } from "./target.mjs";
import {
  MAX_CONTENT_BYTES_TOTAL,
  createContentBudget,
  digestWorkspaceEntry
} from "./workspace-digest.mjs";

/**
 * Collects the exact Git-visible change set, or says it could not.
 *
 * The contract is the whole point: this returns "exact" only when every
 * condition below held, and "indeterminate" otherwise. It never throws, and it
 * never downgrades an unknown into a guess. A caller that receives "exact" may
 * treat the identity as authoritative; a caller that receives "indeterminate"
 * knows nothing and must say so.
 *
 * There is no filesystem snapshot isolation here and none is claimed. What
 * there is: a double-status bracket around the whole collection, a double-stat
 * bracket around every file read, and a refusal to report certainty when either
 * bracket disagrees with itself.
 */

export const COLLECTOR_VERSION = "change-set-collector/v1";
export const MAX_CHANGE_SET_ENTRIES = 5_000;
export const MAX_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024;
export const COLLECTION_DEADLINE_MS = 180_000;
export const MAX_COLLECTION_ATTEMPTS = 3;

const LIVE_CUSTODY_STATES = new Set([
  "RESERVED",
  "PREPARING_WORKTREE",
  "SPAWNING",
  "ACTIVE",
  "TERMINATING",
  "ORPHANED"
]);

const TERMINAL_CUSTODY_STATES = new Set(["TERMINAL_PROVEN", "HANDOFF_READY", "RELEASED"]);

/**
 * Every reason a collection can decline to be exact. Exported so the test suite
 * can assert that each one is actually reachable rather than aspirational.
 */
export const COLLECTOR_REASONS = Object.freeze([
  "not_a_git_worktree",
  "custody_state_ambiguous",
  "concurrent_write_custody_active",
  "coherent_admission_lost",
  "object_format_unknown",
  "sparse_checkout_unsupported",
  "status_output_overflow",
  "git_command_timeout",
  "git_command_failed",
  "malformed_status_record",
  "unknown_status_record",
  "unexpected_rename_record",
  "unexpected_ignored_record",
  "duplicate_status_path",
  "change_set_too_large",
  "review_target_spec_invalid",
  "dirty_submodule",
  "submodule_head_unresolved",
  "untracked_directory_opaque",
  "unsupported_file_type",
  "content_too_large",
  "content_unreadable",
  // A persistently unstable file is reported as collector instability rather
  // than as its own code: workspace-digest's content_unstable is what triggers
  // a retry, and only the exhausted retry budget reaches a caller.
  "collector_unstable",
  "collection_deadline_exceeded",
  "descriptor_invalid"
]);

const STATUS_ARGUMENTS = Object.freeze([
  "--no-optional-locks",
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--no-ahead-behind",
  "--untracked-files=all",
  "--ignore-submodules=none",
  "--no-renames"
]);

class CollectorAbort extends Error {
  constructor(reasons) {
    super("change-set collection is indeterminate");
    this.name = "CollectorAbort";
    this.reasons = reasons;
  }
}

function indeterminate(code, detail) {
  throw new CollectorAbort([detail === undefined ? { code } : { code, detail }]);
}

function gitFailureReason(error, { status = false } = {}) {
  if (error?.code === "collection_deadline_exceeded") return "collection_deadline_exceeded";
  if (error?.code === "supervised_process_timeout") return "git_command_timeout";
  if (status && error?.code === "supervised_process_output_overflow") return "status_output_overflow";
  return "git_command_failed";
}

async function gitText(runGit, args, { cwd }) {
  try {
    const result = await runGit(args, { cwd });
    return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
  } catch (error) {
    indeterminate(gitFailureReason(error), "git " + args.join(" "));
  }
}

/**
 * A nonzero exit is an answer ("no"); anything else is an absence of one.
 */
async function gitTextAllowingFailure(runGit, args, { cwd }) {
  try {
    const result = await runGit(args, { cwd });
    return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
  } catch (error) {
    if (error?.code === "supervised_process_failed" && error?.reason === "nonzero-exit") return undefined;
    indeterminate(gitFailureReason(error), "git " + args.join(" "));
  }
}

function parsedSnapshotsAgree(left, right) {
  if (JSON.stringify(left.headers) !== JSON.stringify(right.headers)) return false;
  for (const section of ["ordinary", "unmerged", "untracked"]) {
    if (left[section].length !== right[section].length) return false;
    for (let index = 0; index < left[section].length; index += 1) {
      const a = { ...left[section][index], pathBytes: left[section][index].pathBytes.toString("hex") };
      const b = { ...right[section][index], pathBytes: right[section][index].pathBytes.toString("hex") };
      if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    }
  }
  return true;
}

async function readStatusSnapshot(runGit, { cwd }) {
  let result;
  try {
    result = await runGit(STATUS_ARGUMENTS, {
      cwd,
      encoding: "buffer",
      maxOutputBytes: MAX_STATUS_OUTPUT_BYTES
    });
  } catch (error) {
    indeterminate(gitFailureReason(error, { status: true }), "git status");
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, "utf8");
}

function parseSnapshot(buffer, objectFormat) {
  try {
    return parsePorcelainV2(buffer, { objectFormat });
  } catch (error) {
    indeterminate(error?.reason || "malformed_status_record", error?.detail);
  }
}

/**
 * Checks that the custody situation matches what the caller believes.
 *
 * Under exclusive-held the slot must still be ours: a coordinator wrongly
 * judged dead could have had its record reconciled away, and if that happened
 * the interval was never actually held. Under observational any live foreign
 * record means a writer may be mutating the tree right now, and reporting an
 * exact identity while that is true would be dishonest.
 */
async function verifyCustodyExpectation(readOwnership, canonicalRepositoryKey, expectation) {
  if (!expectation || expectation.mode === "none") return;

  let record;
  try {
    record = await readOwnership(canonicalRepositoryKey);
  } catch {
    indeterminate("custody_state_ambiguous");
  }

  if (expectation.mode === "exclusive-held") {
    if (!record) indeterminate("coherent_admission_lost", "ownership record is gone");
    if (record.executionId !== expectation.executionId) {
      indeterminate("coherent_admission_lost", "ownership belongs to " + record.executionId);
    }
    if (custodyKindOf(record) !== CUSTODY_KINDS.COHERENT_REVIEW) {
      indeterminate("coherent_admission_lost", "ownership is not a coherent review");
    }
    if (TERMINAL_CUSTODY_STATES.has(record.state)) {
      indeterminate("coherent_admission_lost", "ownership reached " + record.state);
    }
    return;
  }

  if (record && LIVE_CUSTODY_STATES.has(record.state)) {
    indeterminate("concurrent_write_custody_active", record.state);
  }
}

function summaryFromHeaders(headers) {
  const head = headers.branchHead;
  if (head === "(detached)") return { branch: null, detached: true };
  if (head === "(unknown)" || head === undefined) return { branch: null, detached: false };
  return { branch: head, detached: false };
}

function needsWorktreeContent(entry) {
  const y = entry.xy[1];
  return (y === "M" || y === "T") && entry.sub[0] !== "S";
}

export async function collectChangeSet(input = {}, dependencies = {}) {
  let deadlineTimer;
  const deadlineResult = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(Object.freeze({
      status: "indeterminate",
      reasons: Object.freeze([{ code: "collection_deadline_exceeded" }])
    })), COLLECTION_DEADLINE_MS);
  });

  try {
    return await Promise.race([
      collectChangeSetWithinDeadline(input, dependencies),
      deadlineResult
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function collectChangeSetWithinDeadline({
  effectiveCwd,
  rootSource,
  canonicalRepositoryKey,
  targetSpec = NO_REVIEW_TARGET,
  custodyExpectation = { mode: "observational" }
} = {}, dependencies = {}) {
  const {
    runGit = runGitCommand,
    readOwnership,
    now = () => performance.now(),
    realpathFn = realpath,
    lstatFn,
    openFn,
    readlinkFn
  } = dependencies;

  const deadlineAt = now() + COLLECTION_DEADLINE_MS;
  const checkDeadline = () => {
    if (now() >= deadlineAt) indeterminate("collection_deadline_exceeded");
  };
  const runGitWithinDeadline = async (args, options = {}) => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      throw Object.assign(new Error("change-set collection deadline exceeded"), {
        code: "collection_deadline_exceeded"
      });
    }
    return runGit(args, {
      ...options,
      timeoutMs: Math.max(1, Math.min(
        options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
        Math.ceil(remaining)
      ))
    });
  };

  try {
    if (rootSource !== "git-boundary") indeterminate("not_a_git_worktree", String(rootSource));
    await verifyCustodyExpectation(readOwnership, canonicalRepositoryKey, custodyExpectation);

    const topLevelRaw = await gitText(
      runGitWithinDeadline,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      { cwd: effectiveCwd }
    );
    let topLevel;
    try {
      topLevel = await realpathFn(topLevelRaw.trim());
    } catch (error) {
      indeterminate("not_a_git_worktree", "unusable worktree top level");
    }

    const objectFormat = (await gitText(runGitWithinDeadline, ["rev-parse", "--show-object-format"], { cwd: topLevel })).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      indeterminate("object_format_unknown", objectFormat);
    }

    // A sparse checkout leaves tracked paths absent from the worktree while
    // status reports nothing about them, so "exact" would be a false claim.
    const sparse = (await gitText(
      runGitWithinDeadline,
      ["config", "--bool", "--default", "false", "--get", "core.sparseCheckout"],
      { cwd: topLevel }
    )).trim();
    if (sparse === "true") indeterminate("sparse_checkout_unsupported");

    let lastAbort;
    for (let attempt = 0; attempt < MAX_COLLECTION_ATTEMPTS; attempt += 1) {
      checkDeadline();
      try {
        return await collectOnce({
          topLevel,
          objectFormat,
          targetSpec,
          runGit: runGitWithinDeadline,
          lstatFn,
          openFn,
          readlinkFn,
          checkDeadline
        });
      } catch (error) {
        if (!(error instanceof CollectorAbort)) throw error;
        // Only instability is worth another attempt. Every other refusal is a
        // fact about the repository that a retry cannot change.
        const retryable = error.reasons.every((reason) =>
          reason.code === "content_unstable" || reason.code === "collector_unstable");
        if (!retryable) throw error;
        lastAbort = error;
      }
    }
    throw new CollectorAbort([{ code: "collector_unstable", detail: lastAbort?.reasons?.[0]?.detail }]);
  } catch (error) {
    if (error instanceof CollectorAbort) {
      return Object.freeze({ status: "indeterminate", reasons: Object.freeze(error.reasons) });
    }
    return Object.freeze({
      status: "indeterminate",
      reasons: Object.freeze([{ code: "git_command_failed", detail: error?.code || "unexpected" }])
    });
  }
}

async function collectOnce({
  topLevel,
  objectFormat,
  targetSpec,
  runGit,
  lstatFn,
  openFn,
  readlinkFn,
  checkDeadline
}) {
  const snapshotA = await readStatusSnapshot(runGit, { cwd: topLevel });
  const parsedA = parseSnapshot(snapshotA, objectFormat);

  const totalEntries = parsedA.ordinary.length + parsedA.unmerged.length + parsedA.untracked.length;
  if (totalEntries > MAX_CHANGE_SET_ENTRIES) {
    indeterminate("change_set_too_large", String(totalEntries));
  }
  checkDeadline();

  const head = parsedA.headers.branchOid === "(initial)" || parsedA.headers.branchOid === undefined
    ? { commit: null, unborn: true }
    : { commit: parsedA.headers.branchOid.toLowerCase(), unborn: false };

  const targetResolution = await resolveReviewTargetContext(targetSpec, {
    cwd: topLevel,
    runGit,
    objectFormat
  });
  if (targetResolution.status !== "ok") throw new CollectorAbort(targetResolution.reasons);
  const target = targetResolution.context;
  checkDeadline();

  // Metadata only, and deliberately never fatal: "authored from A" and "aimed
  // at B" are different questions, and unrelated histories are a legitimate
  // answer to the first one.
  let mergeBase = null;
  if (target.commit && head.commit) {
    const output = await gitTextAllowingFailure(runGit, ["merge-base", head.commit, target.commit], {
      cwd: topLevel
    });
    const candidate = output?.trim().toLowerCase();
    if (candidate && /^[0-9a-f]{40,64}$/u.test(candidate)) mergeBase = candidate;
  }

  const index = [];
  const worktree = [];
  const submodules = [];
  const budget = createContentBudget(MAX_CONTENT_BYTES_TOTAL);

  for (const entry of parsedA.ordinary) {
    const encoded = encodePath(entry.pathBytes);
    const x = entry.xy[0];
    const y = entry.xy[1];

    if (x !== ".") {
      index.push({
        path: encoded,
        x,
        modeHead: entry.modeHead,
        modeIndex: entry.modeIndex,
        oidHead: entry.oidHead,
        oidIndex: entry.oidIndex,
        sub: entry.sub
      });
    }

    let submoduleHead = null;
    if (entry.sub[0] === "S") {
      if (entry.sub[2] === "M" || entry.sub[3] === "U") {
        // A dirty submodule's content is not representable by any object id, so
        // reporting the bare dirty bit as exact identity would be a lie.
        indeterminate("dirty_submodule", encoded.v);
      }
      if (entry.sub[1] === "C") {
        const output = await gitTextAllowingFailure(
          runGit,
          ["-C", path.join(topLevel, encoded.v), "rev-parse", "--verify", "HEAD"],
          { cwd: topLevel }
        );
        const candidate = output?.trim().toLowerCase();
        if (!candidate || !/^[0-9a-f]{40,64}$/u.test(candidate)) {
          indeterminate("submodule_head_unresolved", encoded.v);
        }
        submoduleHead = candidate;
      }
      submodules.push({
        path: encoded,
        sub: entry.sub,
        oidHead: entry.oidHead,
        oidIndex: entry.oidIndex,
        worktreeHead: submoduleHead
      });
    }

    if (y !== ".") {
      let content = null;
      if (needsWorktreeContent(entry)) {
        checkDeadline();
        content = (await digestEntry(path.join(topLevel, encoded.v), {
          budget, lstatFn, openFn, readlinkFn
        })).digest;
      }
      worktree.push({
        path: encoded,
        y,
        modeWorktree: entry.modeWorktree,
        content,
        submoduleHead
      });
    }
  }

  const unmerged = [];
  for (const entry of parsedA.unmerged) {
    const encoded = encodePath(entry.pathBytes);
    let content = null;
    if (entry.modeWorktree !== "000000") {
      checkDeadline();
      content = (await digestEntry(path.join(topLevel, encoded.v), {
        budget, lstatFn, openFn, readlinkFn
      })).digest;
    }
    unmerged.push({
      path: encoded,
      xy: entry.xy,
      sub: entry.sub,
      mode1: entry.mode1,
      mode2: entry.mode2,
      mode3: entry.mode3,
      modeWorktree: entry.modeWorktree,
      oid1: entry.oid1,
      oid2: entry.oid2,
      oid3: entry.oid3,
      content
    });
  }

  const untracked = [];
  for (const entry of parsedA.untracked) {
    const encoded = encodePath(entry.pathBytes);
    // Git does not descend into a nested repository even with -uall, so it
    // reports the directory itself. That entry is unexpandable, and pretending
    // otherwise would silently drop everything inside it.
    if (encoded.v.endsWith("/")) indeterminate("untracked_directory_opaque", encoded.v);
    checkDeadline();
    const digested = await digestEntry(path.join(topLevel, encoded.v), {
      budget, lstatFn, openFn, readlinkFn
    });
    untracked.push({
      path: encoded,
      kind: digested.kind === "link" ? "symlink" : "file",
      content: digested.digest
    });
  }

  const snapshotB = await readStatusSnapshot(runGit, { cwd: topLevel });
  const parsedB = parseSnapshot(snapshotB, objectFormat);
  if (!parsedSnapshotsAgree(parsedA, parsedB)) {
    throw new CollectorAbort([{ code: "collector_unstable", detail: "status changed during collection" }]);
  }

  const branchSummary = summaryFromHeaders(parsedA.headers);
  let descriptor;
  try {
    descriptor = buildChangeSetDescriptor({
      objectFormat,
      head,
      target,
      index,
      worktree,
      unmerged,
      untracked,
      submodules,
      summary: { ...branchSummary, mergeBase }
    });
  } catch (error) {
    indeterminate("descriptor_invalid", error?.detail);
  }

  const { sections, changeSetId } = changeSetIdFor(descriptor);
  return Object.freeze({
    status: "exact",
    descriptor,
    changeSetId,
    sections,
    summary: descriptor.summary
  });
}

async function digestEntry(absolutePath, { budget, lstatFn, openFn, readlinkFn }) {
  try {
    return await digestWorkspaceEntry(absolutePath, {
      budget,
      ...(lstatFn ? { lstatFn } : {}),
      ...(openFn ? { openFn } : {}),
      ...(readlinkFn ? { readlinkFn } : {})
    });
  } catch (error) {
    indeterminate(error?.reason || "content_unreadable", error?.detail);
  }
}
