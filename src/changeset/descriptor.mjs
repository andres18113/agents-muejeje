import { canonicalJson, isWellFormedString, sha256Hex } from "../canonical-json.mjs";
import { validateReviewTargetContext } from "./target.mjs";

/**
 * What a change set is, and what its identity is.
 *
 * The descriptor is a deterministic representation of the exact Git-visible
 * subject: HEAD, the declared and resolved review target, the index side, the
 * worktree side, untracked content, unmerged stages, submodule state, and the
 * collection policy that produced it.
 *
 * Identity is computed over eight per-section digests rather than over the
 * whole descriptor. That is what lets freshness report *which* section changed
 * instead of only that something did, and it is why `summary` - branch name,
 * merge base, counts - sits outside the hashed set by construction rather than
 * by a rule someone has to remember.
 *
 * Sorting is by raw path bytes. Never by decoded string, never locale-aware,
 * never case-insensitive: those all make identity depend on the machine.
 */

export const CHANGE_SET_SCHEMA = "claude-agents-mcp/change-set/v1";
export const CHANGE_SET_ID_PREFIX = "cs1";

export const SECTION_NAMES = Object.freeze([
  "head",
  "index",
  "policy",
  "submodules",
  "target",
  "unmerged",
  "untracked",
  "worktree"
]);

export const COLLECTION_POLICY = Object.freeze({
  untracked: "all",
  ignored: "excluded",
  renames: "disabled",
  submodules: "not-ignored",
  sparseCheckout: false
});

export class ChangeSetDescriptorError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ChangeSetDescriptorError";
    this.reason = options.reason || "descriptor_invalid";
    this.detail = options.detail;
  }
}

const HEX_64 = /^[0-9a-f]{64}$/u;
const MODE = /^[0-7]{6}$/u;
const STATUS_CHARACTER = /^[.A-Za-z?]$/u;
const SUBMODULE_FIELD = /^(N\.\.\.|S[C.][M.][U.])$/u;

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function oidPattern(objectFormat) {
  return objectFormat === "sha256" ? /^[0-9a-f]{64}$/u : /^[0-9a-f]{40}$/u;
}

function validEncodedPath(value) {
  if (!value || typeof value !== "object" || !hasExactKeys(value, ["enc", "v"])) return false;
  if (value.enc === "utf8") return typeof value.v === "string" && isWellFormedString(value.v);
  if (value.enc === "hex") return typeof value.v === "string" && /^([0-9a-f]{2})+$/u.test(value.v);
  return false;
}

function pathBytesOf(encoded) {
  return encoded.enc === "hex" ? Buffer.from(encoded.v, "hex") : Buffer.from(encoded.v, "utf8");
}

function strictlyAscendingByPathBytes(entries) {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = pathBytesOf(entries[index - 1].path);
    const current = pathBytesOf(entries[index].path);
    if (Buffer.compare(previous, current) >= 0) return false;
  }
  return true;
}

function sortByPathBytes(entries) {
  return [...entries].sort((left, right) =>
    Buffer.compare(pathBytesOf(left.path), pathBytesOf(right.path)));
}

/**
 * Builds the descriptor from already-collected parts. Pure: no Git, no
 * filesystem, no clock. Every array is sorted here so a caller can never make
 * identity depend on the order Git happened to report entries in.
 */
export function buildChangeSetDescriptor({
  objectFormat,
  head,
  target,
  index,
  worktree,
  unmerged,
  untracked,
  submodules,
  summary
}) {
  const descriptor = {
    schema: CHANGE_SET_SCHEMA,
    objectFormat,
    policy: { ...COLLECTION_POLICY },
    head: { commit: head.commit, unborn: head.unborn },
    target: {
      spec: { ...target.spec },
      resolution: target.resolution,
      commit: target.commit
    },
    index: sortByPathBytes(index),
    worktree: sortByPathBytes(worktree),
    unmerged: sortByPathBytes(unmerged),
    untracked: sortByPathBytes(untracked),
    submodules: sortByPathBytes(submodules),
    summary: {
      branch: summary.branch,
      detached: summary.detached,
      mergeBase: summary.mergeBase,
      counts: {
        index: index.length,
        worktree: worktree.length,
        unmerged: unmerged.length,
        untracked: untracked.length,
        submodules: submodules.length
      }
    }
  };

  const validated = validateChangeSetDescriptor(descriptor);
  if (!validated) {
    throw new ChangeSetDescriptorError("Refusing to build an invalid change-set descriptor.", {
      reason: "descriptor_invalid"
    });
  }
  return validated;
}

function validIndexEntry(entry, oid) {
  if (!hasExactKeys(entry, ["path", "x", "modeHead", "modeIndex", "oidHead", "oidIndex", "sub"])) return false;
  if (!validEncodedPath(entry.path)) return false;
  if (!STATUS_CHARACTER.test(entry.x)) return false;
  if (!MODE.test(entry.modeHead) || !MODE.test(entry.modeIndex)) return false;
  if (!oid.test(entry.oidHead) || !oid.test(entry.oidIndex)) return false;
  return SUBMODULE_FIELD.test(entry.sub);
}

function validWorktreeEntry(entry, oid) {
  if (!hasExactKeys(entry, ["path", "y", "modeWorktree", "content", "submoduleHead"])) return false;
  if (!validEncodedPath(entry.path)) return false;
  if (!STATUS_CHARACTER.test(entry.y)) return false;
  if (!MODE.test(entry.modeWorktree)) return false;
  if (entry.content !== null && !HEX_64.test(entry.content)) return false;
  return entry.submoduleHead === null || oid.test(entry.submoduleHead);
}

function validUnmergedEntry(entry, oid) {
  if (!hasExactKeys(entry, [
    "path", "xy", "sub", "mode1", "mode2", "mode3", "modeWorktree", "oid1", "oid2", "oid3", "content"
  ])) return false;
  if (!validEncodedPath(entry.path)) return false;
  if (typeof entry.xy !== "string" || entry.xy.length !== 2) return false;
  if (!STATUS_CHARACTER.test(entry.xy[0]) || !STATUS_CHARACTER.test(entry.xy[1])) return false;
  if (!SUBMODULE_FIELD.test(entry.sub)) return false;
  for (const mode of [entry.mode1, entry.mode2, entry.mode3, entry.modeWorktree]) {
    if (!MODE.test(mode)) return false;
  }
  for (const value of [entry.oid1, entry.oid2, entry.oid3]) {
    if (!oid.test(value)) return false;
  }
  return entry.content === null || HEX_64.test(entry.content);
}

function validUntrackedEntry(entry) {
  if (!hasExactKeys(entry, ["path", "kind", "content"])) return false;
  if (!validEncodedPath(entry.path)) return false;
  if (entry.kind !== "file" && entry.kind !== "symlink") return false;
  return HEX_64.test(entry.content);
}

function validSubmoduleEntry(entry, oid) {
  if (!hasExactKeys(entry, ["path", "sub", "oidHead", "oidIndex", "worktreeHead"])) return false;
  if (!validEncodedPath(entry.path)) return false;
  if (!SUBMODULE_FIELD.test(entry.sub)) return false;
  if (!oid.test(entry.oidHead) || !oid.test(entry.oidIndex)) return false;
  return entry.worktreeHead === null || oid.test(entry.worktreeHead);
}

export function validateChangeSetDescriptor(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (!hasExactKeys(value, [
      "schema", "objectFormat", "policy", "head", "target",
      "index", "worktree", "unmerged", "untracked", "submodules", "summary"
    ])) return undefined;
    if (value.schema !== CHANGE_SET_SCHEMA) return undefined;
    if (value.objectFormat !== "sha1" && value.objectFormat !== "sha256") return undefined;
    const oid = oidPattern(value.objectFormat);

    if (!hasExactKeys(value.policy, Object.keys(COLLECTION_POLICY))) return undefined;
    for (const [name, expected] of Object.entries(COLLECTION_POLICY)) {
      if (value.policy[name] !== expected) return undefined;
    }

    if (!hasExactKeys(value.head, ["commit", "unborn"])) return undefined;
    if (typeof value.head.unborn !== "boolean") return undefined;
    if (value.head.unborn !== (value.head.commit === null)) return undefined;
    if (value.head.commit !== null && !oid.test(value.head.commit)) return undefined;

    if (!validateReviewTargetContext(value.target, { objectFormat: value.objectFormat })) return undefined;

    for (const [section, validate] of [
      ["index", (entry) => validIndexEntry(entry, oid)],
      ["worktree", (entry) => validWorktreeEntry(entry, oid)],
      ["unmerged", (entry) => validUnmergedEntry(entry, oid)],
      ["untracked", validUntrackedEntry],
      ["submodules", (entry) => validSubmoduleEntry(entry, oid)]
    ]) {
      const entries = value[section];
      if (!Array.isArray(entries)) return undefined;
      if (!entries.every((entry) => entry && typeof entry === "object" && validate(entry))) return undefined;
      if (!strictlyAscendingByPathBytes(entries)) return undefined;
    }

    if (!hasExactKeys(value.summary, ["branch", "detached", "mergeBase", "counts"])) return undefined;
    if (typeof value.summary.detached !== "boolean") return undefined;
    if (value.summary.branch !== null && typeof value.summary.branch !== "string") return undefined;
    if (value.summary.mergeBase !== null && !oid.test(value.summary.mergeBase)) return undefined;
    if (!hasExactKeys(value.summary.counts, ["index", "worktree", "unmerged", "untracked", "submodules"])) {
      return undefined;
    }
    for (const section of ["index", "worktree", "unmerged", "untracked", "submodules"]) {
      const count = value.summary.counts[section];
      if (!Number.isSafeInteger(count) || count < 0 || count !== value[section].length) return undefined;
    }

    return Object.freeze(value);
  } catch {
    return undefined;
  }
}

/**
 * The eight per-section digests. `summary` is not among them and cannot be:
 * SECTION_NAMES is the complete hashed surface.
 */
export function computeSectionDigests(descriptor) {
  const sections = {};
  for (const name of SECTION_NAMES) {
    sections[name] = sha256Hex(Buffer.from(canonicalJson(descriptor[name]), "utf8"));
  }
  return Object.freeze(sections);
}

/**
 * Identity is the digest of the schema, the object format, and the eight
 * section digests - never of the descriptor object, so `summary` cannot reach
 * it even by accident.
 */
export function changeSetIdFor(descriptor) {
  const sections = computeSectionDigests(descriptor);
  const changeSetId = changeSetIdFromSectionDigests({
    objectFormat: descriptor.objectFormat,
    sections
  });
  return Object.freeze({ sections, changeSetId });
}

/**
 * Reconstructs the identifier from the exact identity-bearing values stored in
 * a receipt. This prevents a self-consistent ReviewReceipt from pairing an
 * arbitrary changeSetId with unrelated section digests.
 */
export function changeSetIdFromSectionDigests({ objectFormat, sections } = {}) {
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new ChangeSetDescriptorError("Change-set object format is invalid.");
  }
  if (!sections || !hasExactKeys(sections, SECTION_NAMES) ||
      !SECTION_NAMES.every((name) => HEX_64.test(sections[name]))) {
    throw new ChangeSetDescriptorError("Change-set section digests are invalid.");
  }
  const identity = {
    schema: CHANGE_SET_SCHEMA,
    objectFormat,
    sections: { ...sections }
  };
  return CHANGE_SET_ID_PREFIX + ":" + sha256Hex(Buffer.from(canonicalJson(identity), "utf8"));
}

export function computeChangeSetId(descriptor) {
  return changeSetIdFor(descriptor).changeSetId;
}
