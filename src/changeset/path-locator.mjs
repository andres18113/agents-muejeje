import path from "node:path";

/**
 * Where a change-set entry actually lives on disk.
 *
 * An encoded descriptor path is an identity and display representation, not a
 * filesystem locator. When `enc` is "hex" its `v` is the hexadecimal spelling
 * of raw bytes, and a repository is perfectly entitled to also contain a file
 * literally named with those hex characters. Using `v` as a pathname would
 * silently address that second file, so the collector would hash one path's
 * bytes as if they belonged to the other and mint an identity for a tree that
 * never existed.
 *
 * The rule this module enforces is therefore absolute: `encoded.v` becomes a
 * pathname only when `enc === "utf8"`. Everything else is addressed by the raw
 * Git path bytes, which are carried separately from the encoding, and on a
 * platform that cannot address those bytes the answer is "unaddressable" -
 * which the collector turns into INDETERMINATE. Inventing the hexadecimal
 * filename is never one of the options.
 *
 * Two locator kinds exist because they have genuinely different limits.
 *
 *   Filesystem locator - Node's fs API accepts a Buffer pathname and passes the
 *   bytes through unmodified on POSIX, so raw non-UTF-8 names are addressable
 *   there. Windows pathnames are UTF-16 and Node transcodes a Buffer through
 *   UTF-8 with replacement characters, so bytes that are not valid UTF-8 cannot
 *   be addressed at all.
 *
 *   Command argument - child process arguments are strings on every platform
 *   and Node replaces invalid sequences when converting a Buffer, so a
 *   non-UTF-8 pathname can never be handed to `git -C` anywhere.
 */

export const PATH_SEPARATOR_BYTE = 0x2f;

/**
 * Git terminates an untracked directory record with a slash. That test has to
 * be made on the raw bytes: a hex-encoded path never ends in "/" no matter what
 * the underlying name was, so testing the encoded string would silently accept
 * an opaque directory as a file.
 */
export function pathBytesEndWithSeparator(pathBytes) {
  return pathBytes.length > 0 && pathBytes[pathBytes.length - 1] === PATH_SEPARATOR_BYTE;
}

function joinPathBytes(topLevel, pathBytes) {
  const root = Buffer.from(topLevel, "utf8");
  const separated = root.length > 0 && root[root.length - 1] !== PATH_SEPARATOR_BYTE;
  return separated
    ? Buffer.concat([root, Buffer.of(PATH_SEPARATOR_BYTE), pathBytes])
    : Buffer.concat([root, pathBytes]);
}

/**
 * The filesystem locator for one change-set entry.
 *
 * @param encoded the descriptor's encoded path - consulted only for `enc`
 * @param pathBytes the raw Git path bytes, which are what actually address it
 * @returns { status: "ok", locator } with a string or Buffer pathname, or
 *          { status: "unaddressable", reason } when this platform cannot name
 *          the file at all.
 */
export function worktreeEntryLocator({ topLevel, encoded, pathBytes, platform = process.platform } = {}) {
  if (encoded?.enc === "utf8") {
    return Object.freeze({ status: "ok", locator: path.join(topLevel, encoded.v) });
  }
  if (!Buffer.isBuffer(pathBytes) || pathBytes.length === 0) {
    return Object.freeze({ status: "unaddressable", reason: "raw path bytes are unavailable" });
  }
  if (platform === "win32") {
    return Object.freeze({
      status: "unaddressable",
      reason: "a non-UTF-8 pathname cannot be addressed on this platform"
    });
  }
  return Object.freeze({ status: "ok", locator: joinPathBytes(topLevel, pathBytes) });
}

/**
 * The `git -C <dir>` argument for one submodule.
 *
 * Process arguments are strings everywhere, so unlike a filesystem read this
 * has no platform on which raw bytes survive.
 */
export function submodulePathArgument({ topLevel, encoded } = {}) {
  if (encoded?.enc !== "utf8") {
    return Object.freeze({
      status: "unaddressable",
      reason: "a non-UTF-8 submodule pathname cannot be passed to git"
    });
  }
  return Object.freeze({ status: "ok", value: path.join(topLevel, encoded.v) });
}
