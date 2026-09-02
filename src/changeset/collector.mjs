import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { GIT_COMMAND_TIMEOUT_MS, runGitCommand } from "../git-command.mjs";
import { CUSTODY_KINDS, custodyKindOf } from "../write-custody.mjs";
import { decodePathForDisplay, encodePath, parsePorcelainV2 } from "./porcelain-parser.mjs";
import {
  pathBytesEndWithSeparator,
  submodulePathArgument,
  worktreeEntryLocator
} from "./path-locator.mjs";
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
 * there is: a bracket around every identity-bearing observation, a double-stat
 * bracket around every file read, and a refusal to report certainty when any
 * bracket disagrees with itself.
 *
 * The bracket covers every observation that reaches the identity, not merely
 * porcelain status. Status is only one of three: the resolved review target and
 * the resolved worktree HEAD of every clean submodule are equally part of the
 * hashed descriptor, and both can move while porcelain output stays
 * byte-identical. So the order is fixed and complete:
 *
 *     status A, target A, submodule heads A,
 *     content collection,
 *     status B, target B, submodule heads B
 *
 * and every A must equal its B. Anything else is instability, retried within
 * the bounded attempt budget and then reported as collector_unstable.
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
  "branch_oid_unusable",
  "change_set_too_large",
  "review_target_spec_invalid",
  "dirty_submodule",
  "submodule_head_unresolved",
  "path_not_addressable",
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

function unstable(detail) {
  throw new CollectorAbort([{ code: "collector_unstable", detail }]);
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

/**
 * The review target is part of the hashed descriptor, so "the same target" has
 * to mean the same declared spec, the same resolution outcome, and the same
 * resolved commit. A ref that moved from one commit to another, or that
 * stopped resolving, changes the subject even though porcelain status is
 * unaffected by either.
 */
function targetContextsAgree(left, right) {
  return left.spec.kind === right.spec.kind &&
    left.spec.ref === right.spec.ref &&
    left.spec.source === right.spec.source &&
    left.resolution === right.resolution &&
    left.commit === right.commit;
}

/**
 * Clean submodule worktree HEADs are hashed too, and a submodule can be checked
 * out from one non-index commit to another without its porcelain `SC..` field
 * changing at all. Comparing the resolved ids is the only thing that catches it.
 */
function submoduleHeadsAgree(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
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

/**
 * Only the literal "(initial)" means an unborn HEAD.
 *
 * A missing header is not a claim that the repository has no commits; it is a
 * claim about nothing at all, and the two are opposite kinds of fact. Treating
 * an absent or unusable branch.oid as unborn would let a truncated,
 * differently-versioned or otherwise unreadable status stream mint a descriptor
 * that asserts an empty history for a repository full of commits.
 */
function headFromHeaders(headers, objectFormat) {
  const raw = headers.branchOid;
  if (raw === "(initial)") return { commit: null, unborn: true };
  if (typeof raw !== "string" || raw.length === 0) {
    indeterminate("branch_oid_unusable", "status reported no branch.oid header");
  }
  const commit = raw.trim().toLowerCase();
  const width = objectFormat === "sha256" ? 64 : 40;
  if (!new RegExp("^[0-9a-f]{" + width + "}$", "u").test(commit)) {
    indeterminate("branch_oid_unusable", raw);
  }
  return { commit, unborn: false };
}

function needsWorktreeContent(entry) {
  const y = entry.xy[1];
  return (y === "M" || y === "T") && entry.sub[0] !== "S";
}

export async function collectChangeSet(input = {}, dependencies = {}) {
  const { deadlineMs = COLLECTION_DEADLINE_MS } = dependencies;
  // The deadline race observes the collection; it does not stop it. This
  // controller is what actually stops it, so no Git child and no filesystem
  // read can begin after the caller has already been told the deadline expired.
  const cancellation = new AbortController();
  let deadlineTimer;
  const deadlineResult = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => {
      cancellation.abort();
      resolve(Object.freeze({
        status: "indeterminate",
        reasons: Object.freeze([{ code: "collection_deadline_exceeded" }])
      }));
    }, deadlineMs);
  });

  try {
    return await Promise.race([
      collectChangeSetWithinDeadline(input, {
        ...dependencies,
        cancellationSignal: cancellation.signal
      }),
      deadlineResult
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    // Whatever ended this collection, nothing further may be observed on its
    // behalf. Cancelling here is what makes that true for the success path too.
    cancellation.abort();
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
    platform = process.platform,
    deadlineMs = COLLECTION_DEADLINE_MS,
    cancellationSignal,
    lstatFn,
    openFn,
    readlinkFn
  } = dependencies;

  const deadlineAt = now() + deadlineMs;
  const cancelled = () => cancellationSignal?.aborted === true;
  const checkDeadline = () => {
    if (cancelled()) indeterminate("collection_deadline_exceeded", "collection was cancelled");
    if (now() >= deadlineAt) indeterminate("collection_deadline_exceeded");
  };
  const runGitWithinDeadline = async (args, options = {}) => {
    const remaining = deadlineAt - now();
    if (cancelled() || remaining <= 0) {
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
    checkDeadline();
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
          platform,
          cancelled,
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

/**
 * Resolves the worktree HEAD of every clean submodule whose commit differs from
 * the index, keyed by raw path bytes.
 *
 * Dirty submodules are refused here rather than during content collection, so
 * that both sides of the bracket ask the repository exactly the same question
 * in exactly the same order.
 */
async function readCleanSubmoduleHeads(parsed, { topLevel, runGit, checkDeadline }) {
  const heads = new Map();
  for (const entry of parsed.ordinary) {
    if (entry.sub[0] !== "S") continue;
    const encoded = encodePath(entry.pathBytes);
    if (entry.sub[2] === "M" || entry.sub[3] === "U") {
      // A dirty submodule's content is not representable by any object id, so
      // reporting the bare dirty bit as exact identity would be a lie.
      indeterminate("dirty_submodule", decodePathForDisplay(encoded));
    }
    if (entry.sub[1] !== "C") continue;
    checkDeadline();
    const argument = submodulePathArgument({ topLevel, encoded });
    if (argument.status !== "ok") {
      indeterminate("path_not_addressable", decodePathForDisplay(encoded));
    }
    const output = await gitTextAllowingFailure(
      runGit,
      ["-C", argument.value, "rev-parse", "--verify", "HEAD"],
      { cwd: topLevel }
    );
    const candidate = output?.trim().toLowerCase();
    if (!candidate || !/^[0-9a-f]{40,64}$/u.test(candidate)) {
      indeterminate("submodule_head_unresolved", decodePathForDisplay(encoded));
    }
    heads.set(entry.pathBytes.toString("hex"), candidate);
  }
  return heads;
}

async function collectOnce({
  topLevel,
  objectFormat,
  targetSpec,
  runGit,
  platform,
  cancelled,
  lstatFn,
  openFn,
  readlinkFn,
  checkDeadline
}) {
  // ---- observation A ------------------------------------------------------
  const snapshotA = await readStatusSnapshot(runGit, { cwd: topLevel });
  const parsedA = parseSnapshot(snapshotA, objectFormat);

  const totalEntries = parsedA.ordinary.length + parsedA.unmerged.length + parsedA.untracked.length;
  if (totalEntries > MAX_CHANGE_SET_ENTRIES) {
    indeterminate("change_set_too_large", String(totalEntries));
  }
  checkDeadline();

  const head = headFromHeaders(parsedA.headers, objectFormat);

  const targetA = await resolveTargetContext(targetSpec, { topLevel, runGit, objectFormat });
  checkDeadline();

  const submoduleHeadsA = await readCleanSubmoduleHeads(parsedA, {
    topLevel,
    runGit,
    checkDeadline
  });
  checkDeadline();

  // ---- content collection -------------------------------------------------
  const index = [];
  const worktree = [];
  const submodules = [];
  const budget = createContentBudget(MAX_CONTENT_BYTES_TOTAL);
  const locate = (encoded, pathBytes) => {
    const located = worktreeEntryLocator({ topLevel, encoded, pathBytes, platform });
    if (located.status !== "ok") indeterminate("path_not_addressable", decodePathForDisplay(encoded));
    return located.locator;
  };

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
      submoduleHead = submoduleHeadsA.get(entry.pathBytes.toString("hex")) ?? null;
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
        content = (await digestEntry(locate(encoded, entry.pathBytes), {
          budget, cancelled, display: decodePathForDisplay(encoded), lstatFn, openFn, readlinkFn
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
      content = (await digestEntry(locate(encoded, entry.pathBytes), {
        budget, cancelled, display: decodePathForDisplay(encoded), lstatFn, openFn, readlinkFn
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
    // otherwise would silently drop everything inside it. The test is on the
    // raw bytes because a hex-encoded path can never end in a slash.
    if (pathBytesEndWithSeparator(entry.pathBytes)) {
      indeterminate("untracked_directory_opaque", decodePathForDisplay(encoded));
    }
    checkDeadline();
    const digested = await digestEntry(locate(encoded, entry.pathBytes), {
      budget, cancelled, display: decodePathForDisplay(encoded), lstatFn, openFn, readlinkFn
    });
    untracked.push({
      path: encoded,
      kind: digested.kind === "link" ? "symlink" : "file",
      content: digested.digest
    });
  }

  // ---- observation B ------------------------------------------------------
  const snapshotB = await readStatusSnapshot(runGit, { cwd: topLevel });
  const parsedB = parseSnapshot(snapshotB, objectFormat);
  if (!parsedSnapshotsAgree(parsedA, parsedB)) {
    unstable("status changed during collection");
  }

  const targetB = await resolveTargetContext(targetSpec, { topLevel, runGit, objectFormat });
  if (!targetContextsAgree(targetA, targetB)) {
    unstable("review target moved during collection");
  }

  const submoduleHeadsB = await readCleanSubmoduleHeads(parsedB, {
    topLevel,
    runGit,
    checkDeadline
  });
  if (!submoduleHeadsAgree(submoduleHeadsA, submoduleHeadsB)) {
    unstable("submodule head moved during collection");
  }

  // Metadata only, and deliberately never fatal: "authored from A" and "aimed
  // at B" are different questions, and unrelated histories are a legitimate
  // answer to the first one. It is not identity-bearing, so it is computed
  // after the bracket closes rather than inside it, where it would widen the
  // window without adding any certainty.
  let mergeBase = null;
  if (targetA.commit && head.commit) {
    const output = await gitTextAllowingFailure(runGit, ["merge-base", head.commit, targetA.commit], {
      cwd: topLevel
    });
    const candidate = output?.trim().toLowerCase();
    if (candidate && /^[0-9a-f]{40,64}$/u.test(candidate)) mergeBase = candidate;
  }

  const branchSummary = summaryFromHeaders(parsedA.headers);
  let descriptor;
  try {
    descriptor = buildChangeSetDescriptor({
      objectFormat,
      head,
      target: targetA,
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

async function resolveTargetContext(targetSpec, { topLevel, runGit, objectFormat }) {
  const resolution = await resolveReviewTargetContext(targetSpec, {
    cwd: topLevel,
    runGit,
    objectFormat
  });
  if (resolution.status !== "ok") throw new CollectorAbort(resolution.reasons);
  return resolution.context;
}

async function digestEntry(locator, { budget, cancelled, display, lstatFn, openFn, readlinkFn }) {
  // No filesystem read may begin once the collection has been cancelled.
  if (cancelled?.()) indeterminate("collection_deadline_exceeded", "collection was cancelled");
  try {
    return await digestWorkspaceEntry(locator, {
      budget,
      ...(lstatFn ? { lstatFn } : {}),
      ...(openFn ? { openFn } : {}),
      ...(readlinkFn ? { readlinkFn } : {})
    });
  } catch (error) {
    // A raw-bytes locator is a Buffer, and a Buffer has no place in a reason a
    // caller will read or serialize. Report the entry's own display form
    // instead of re-spelling the bytes we were careful not to spell.
    indeterminate(
      error?.reason || "content_unreadable",
      Buffer.isBuffer(error?.detail) ? display : error?.detail
    );
  }
}
