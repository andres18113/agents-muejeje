import { isWellFormedString } from "../canonical-json.mjs";

/**
 * The `git status --porcelain=v2 -z` grammar, and nothing else.
 *
 * This module knows how Git frames its records and knows nothing about change
 * sets, identity, or review. It works on Buffers throughout and decodes only
 * inside encodePath, because a path is arbitrary bytes: decoding the stream to
 * a string before splitting would corrupt any filename that is not valid UTF-8,
 * and splitting on spaces with a fixed field count would eat any filename that
 * contains one.
 *
 * The whole stream desynchronises if a `2` (rename/copy) record is treated as
 * one field, because it carries the origin path in a second NUL-terminated
 * field. That is handled explicitly even though such a record is then rejected.
 */

export class PorcelainParseError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "PorcelainParseError";
    this.reason = options.reason || "malformed_status_record";
    this.detail = options.detail;
  }
}

const SPACE = 0x20;
const NUL = 0x00;

const STATUS_CHARACTER = /^[.A-Za-z?]$/u;
const MODE = /^[0-7]{6}$/u;
const SUBMODULE_FIELD = /^(N\.\.\.|S[C.][M.][U.])$/u;

function fail(reason, detail) {
  throw new PorcelainParseError("Unparsable git status record: " + reason, { reason, detail });
}

/**
 * Splits a record into its first `count` space-delimited ASCII tokens plus the
 * raw remaining bytes. The remainder is a subarray, never a decoded string, so
 * spaces, tabs, newlines and non-UTF-8 bytes inside a path all survive.
 */
function splitLeadingTokens(field, count, reason) {
  const tokens = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const boundary = field.indexOf(SPACE, cursor);
    if (boundary < 0) fail(reason, "expected " + count + " leading fields");
    tokens.push(field.toString("latin1", cursor, boundary));
    cursor = boundary + 1;
  }
  if (cursor >= field.length) fail(reason, "record has no path");
  return { tokens, rest: field.subarray(cursor) };
}

function requireOid(value, oidLength, reason) {
  const pattern = oidLength === 64 ? /^[0-9a-f]{64}$/u : /^[0-9a-f]{40}$/u;
  if (!pattern.test(value)) fail(reason, "object id width");
  return value;
}

function requireXy(value, reason) {
  if (value.length !== 2 || !STATUS_CHARACTER.test(value[0]) || !STATUS_CHARACTER.test(value[1])) {
    fail(reason, "status field");
  }
  return value;
}

function requireMode(value, reason) {
  if (!MODE.test(value)) fail(reason, "mode field");
  return value;
}

function requireSubmoduleField(value, reason) {
  if (!SUBMODULE_FIELD.test(value)) fail(reason, "submodule field");
  return value;
}

/**
 * Encodes raw path bytes for the descriptor.
 *
 * utf8 is used only when the bytes round-trip exactly and the decoded string is
 * canonically serializable; otherwise the bytes are carried as hex. The choice
 * is a pure function of the bytes, so one path can never be represented two
 * ways and two different paths can never collide on one representation.
 */
export function encodePath(pathBytes) {
  const decoded = pathBytes.toString("utf8");
  if (isWellFormedString(decoded) && Buffer.from(decoded, "utf8").equals(pathBytes)) {
    return Object.freeze({ enc: "utf8", v: decoded });
  }
  return Object.freeze({ enc: "hex", v: pathBytes.toString("hex") });
}

export function decodePathForDisplay(encoded) {
  if (encoded?.enc === "utf8") return encoded.v;
  return "<non-utf8 path: " + String(encoded?.v ?? "") + ">";
}

function splitNulFields(buffer) {
  const fields = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const boundary = buffer.indexOf(NUL, cursor);
    if (boundary < 0) fail("malformed_status_record", "missing trailing NUL");
    fields.push(buffer.subarray(cursor, boundary));
    cursor = boundary + 1;
  }
  return fields;
}

function assertUniquePaths(entries, section) {
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.pathBytes.toString("hex");
    if (seen.has(key)) fail("duplicate_status_path", section);
    seen.add(key);
  }
}

/**
 * @param stdoutBuffer raw bytes from `git status --porcelain=v2 -z ...`
 * @param objectFormat "sha1" or "sha256"
 */
export function parsePorcelainV2(stdoutBuffer, { objectFormat } = {}) {
  if (!Buffer.isBuffer(stdoutBuffer)) fail("malformed_status_record", "expected raw bytes");
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    fail("object_format_unknown", String(objectFormat));
  }
  const oidLength = objectFormat === "sha256" ? 64 : 40;

  const headers = { branchOid: undefined, branchHead: undefined, branchUpstream: undefined };
  const ordinary = [];
  const unmerged = [];
  const untracked = [];

  const fields = splitNulFields(stdoutBuffer);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length === 0) fail("unknown_status_record", "empty record");

    const lead = field.toString("latin1", 0, 2);

    if (lead === "# ") {
      // Headers are documented as extensible, so an unrecognized one is skipped
      // rather than refused. Unknown *record* types are a different matter.
      const header = field.toString("utf8", 2);
      const boundary = header.indexOf(" ");
      if (boundary < 0) continue;
      const name = header.slice(0, boundary);
      const value = header.slice(boundary + 1);
      if (name === "branch.oid") headers.branchOid = value;
      else if (name === "branch.head") headers.branchHead = value;
      else if (name === "branch.upstream") headers.branchUpstream = value;
      continue;
    }

    if (lead === "1 ") {
      const { tokens, rest } = splitLeadingTokens(field.subarray(2), 7, "malformed_status_record");
      const [xy, sub, modeHead, modeIndex, modeWorktree, oidHead, oidIndex] = tokens;
      ordinary.push(Object.freeze({
        xy: requireXy(xy, "malformed_status_record"),
        sub: requireSubmoduleField(sub, "malformed_status_record"),
        modeHead: requireMode(modeHead, "malformed_status_record"),
        modeIndex: requireMode(modeIndex, "malformed_status_record"),
        modeWorktree: requireMode(modeWorktree, "malformed_status_record"),
        oidHead: requireOid(oidHead, oidLength, "malformed_status_record"),
        oidIndex: requireOid(oidIndex, oidLength, "malformed_status_record"),
        pathBytes: rest
      }));
      continue;
    }

    if (lead === "2 ") {
      // --no-renames was passed, so this record must not exist. Consume its
      // second field anyway before failing: a caller that catches and retries
      // must never be handed a stream that is one field out of alignment.
      splitLeadingTokens(field.subarray(2), 8, "malformed_status_record");
      index += 1;
      if (index >= fields.length) fail("malformed_status_record", "rename record missing origin path");
      fail("unexpected_rename_record", "git did not honour --no-renames");
    }

    if (lead === "u ") {
      const { tokens, rest } = splitLeadingTokens(field.subarray(2), 9, "malformed_status_record");
      const [xy, sub, mode1, mode2, mode3, modeWorktree, oid1, oid2, oid3] = tokens;
      unmerged.push(Object.freeze({
        xy: requireXy(xy, "malformed_status_record"),
        sub: requireSubmoduleField(sub, "malformed_status_record"),
        mode1: requireMode(mode1, "malformed_status_record"),
        mode2: requireMode(mode2, "malformed_status_record"),
        mode3: requireMode(mode3, "malformed_status_record"),
        modeWorktree: requireMode(modeWorktree, "malformed_status_record"),
        oid1: requireOid(oid1, oidLength, "malformed_status_record"),
        oid2: requireOid(oid2, oidLength, "malformed_status_record"),
        oid3: requireOid(oid3, oidLength, "malformed_status_record"),
        pathBytes: rest
      }));
      continue;
    }

    if (lead === "? ") {
      untracked.push(Object.freeze({ pathBytes: field.subarray(2) }));
      continue;
    }

    if (lead === "! ") fail("unexpected_ignored_record", "--ignored was never requested");

    fail("unknown_status_record", lead);
  }

  assertUniquePaths(ordinary, "index");
  assertUniquePaths(unmerged, "unmerged");
  assertUniquePaths(untracked, "untracked");

  return Object.freeze({
    headers: Object.freeze(headers),
    ordinary: Object.freeze(ordinary),
    unmerged: Object.freeze(unmerged),
    untracked: Object.freeze(untracked)
  });
}
