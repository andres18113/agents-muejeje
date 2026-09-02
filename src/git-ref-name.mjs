/**
 * What counts as a valid fully-qualified Git ref for a review target.
 *
 * Deliberately narrow. A review target must name exactly one ref in a form
 * that cannot be reinterpreted: no shorthand, no revision expressions, no
 * @{upstream}, no HEAD. "origin/main" is rejected because it is ambiguous
 * between a branch literally named that and a remote-tracking shorthand, and
 * resolving that ambiguity would be inference. Phase 6 never infers a target.
 *
 * This is a pure module with no imports so both the durable custody schema and
 * the live target resolver can share one definition of validity.
 */

export const REVIEW_TARGET_REF_MAX_BYTES = 200;

const ALLOWED_PREFIXES = Object.freeze(["refs/heads/", "refs/remotes/"]);

// The git check-ref-format subset that matters here. Anything Git would refuse,
// and anything a revision parser could reinterpret, is refused.
const FORBIDDEN_CHARACTERS = new Set([" ", "~", "^", ":", "?", "*", "[", "\\", "\u007f"]);

function componentIsLegal(component) {
  if (component.length === 0) return false;
  if (component.startsWith(".")) return false;
  if (component.endsWith(".")) return false;
  if (component.endsWith(".lock")) return false;
  return true;
}

function hasWellFormedUtf16(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isFullyQualifiedRef(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!hasWellFormedUtf16(value)) return false;
  if (Buffer.byteLength(value, "utf8") > REVIEW_TARGET_REF_MAX_BYTES) return false;

  const prefix = ALLOWED_PREFIXES.find((candidate) => value.startsWith(candidate));
  if (!prefix) return false;

  const remainder = value.slice(prefix.length);
  if (remainder.length === 0) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("..")) return false;
  if (value.includes("@{")) return false;
  if (value.includes("//")) return false;

  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || FORBIDDEN_CHARACTERS.has(character)) return false;
  }

  return value.split("/").every(componentIsLegal);
}

export class GitRefNameError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "GitRefNameError";
    this.code = options.code || "git_ref_name_invalid";
  }
}

export function validateFullyQualifiedRef(value) {
  if (!isFullyQualifiedRef(value)) {
    throw new GitRefNameError(
      "A review target must be a fully-qualified ref under refs/heads/ or refs/remotes/.",
      { code: "git_ref_name_invalid" }
    );
  }
  return value;
}
