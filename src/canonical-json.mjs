import { createHash } from "node:crypto";

/**
 * Deterministic bytes for every Phase 6 digest.
 *
 * This is RFC 8785 (JCS) restricted to the value domain Phase 6 actually uses,
 * not a general canonicalizer. The restriction is the point: by refusing every
 * value whose serialization is debatable, the module never has to make a
 * debatable choice. Two structurally identical values always produce identical
 * bytes, and anything that could serialize two ways is rejected loudly instead
 * of being silently normalized.
 *
 * Why not JSON.stringify over sorted keys: it emits lone surrogates as \udXXX
 * (not valid Unicode, so two distinct inputs could conflate), silently drops
 * undefined members, honours toJSON, and admits numbers whose exact
 * serialization this domain has never pinned down.
 *
 * Why not the canonicalize package: it declares node >= 22 and CI runs 20, and
 * the project has exactly two dependencies. This is ~120 lines.
 */

export class CanonicalJsonError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CanonicalJsonError";
    this.code = options.code || "canonical_json_unsupported_value";
  }
}

const MAX_DEPTH = 64;

function unsupported(detail) {
  return new CanonicalJsonError("Value is outside the canonical JSON domain: " + detail, {
    code: "canonical_json_unsupported_value"
  });
}

/**
 * Rejects lone surrogates.
 *
 * Implemented explicitly rather than via String.prototype.isWellFormed so the
 * behaviour is pinned to this code and directly testable, and so the module
 * carries no assumption about which Node minor shipped that method.
 */
function requireWellFormed(value, role) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw unsupported("lone high surrogate in " + role);
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw unsupported("lone low surrogate in " + role);
    }
  }
  return value;
}

/**
 * True when the string can be canonically serialized at all.
 *
 * Exported because a path decoded from Git bytes must satisfy exactly this
 * condition before it may be stored as a utf8-encoded path; otherwise the
 * descriptor would hold a value its own digest could not encode.
 */
export function isWellFormedString(value) {
  if (typeof value !== "string") return false;
  try {
    requireWellFormed(value, "string");
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeScalar(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(requireWellFormed(value, "string"));
  if (typeof value === "number") {
    // Safe integers only. The domain never carries a fractional number, so the
    // ECMAScript shortest-round-trip float rules are never exercised and never
    // have to be reimplemented. -0 is refused because it round-trips to "0".
    if (!Number.isSafeInteger(value)) throw unsupported("number " + String(value));
    if (Object.is(value, -0)) throw unsupported("negative zero");
    return String(value);
  }
  if (value === undefined) throw unsupported("undefined");
  if (typeof value === "bigint") throw unsupported("bigint");
  if (typeof value === "function") throw unsupported("function");
  if (typeof value === "symbol") throw unsupported("symbol");
  throw unsupported("unrecognized primitive");
}

function requireSupportedContainer(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && !isPlainObject(value)) {
    throw unsupported("non-plain object (" + (value.constructor?.name || "unknown") + ")");
  }
  if (isPlainObject(value) && typeof value.toJSON === "function") {
    throw unsupported("object exposing toJSON");
  }
}

/**
 * Serializes iteratively with an explicit stack. Recursion would make the depth
 * limit a stack-overflow crash instead of a refusal.
 */
export function canonicalJson(value) {
  const out = [];
  const active = new Set();

  // frame: { value, kind, index, keys } - kind "value" emits, others resume.
  const stack = [{ kind: "value", value, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();

    if (frame.kind === "close") {
      out.push(frame.text);
      active.delete(frame.container);
      continue;
    }
    if (frame.kind === "separator") {
      out.push(frame.text);
      continue;
    }

    const current = frame.value;
    if (frame.depth > MAX_DEPTH) {
      throw new CanonicalJsonError("Canonical JSON nesting exceeds " + MAX_DEPTH + " levels.", {
        code: "canonical_json_depth_exceeded"
      });
    }

    if (current === null || typeof current !== "object") {
      out.push(encodeScalar(current));
      continue;
    }
    requireSupportedContainer(current);
    if (active.has(current)) throw unsupported("cyclic reference");
    active.add(current);

    if (Array.isArray(current)) {
      out.push("[");
      stack.push({ kind: "close", text: "]", container: current });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index > 0) {
          stack.push({ kind: "value", value: current[index], depth: frame.depth + 1 });
          stack.push({ kind: "separator", text: "," });
        } else {
          stack.push({ kind: "value", value: current[index], depth: frame.depth + 1 });
        }
      }
      continue;
    }

    // Ascending by UTF-16 code unit, which is what plain `<` on strings does.
    // Not locale-aware and not by code point: U+1F600 must sort before U+FFFF.
    const keys = Object.keys(current).sort();
    out.push("{");
    stack.push({ kind: "close", text: "}", container: current });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const member = current[key];
      if (member === undefined) throw unsupported("undefined member '" + key + "'");
      stack.push({ kind: "value", value: member, depth: frame.depth + 1 });
      stack.push({
        kind: "separator",
        text: (index > 0 ? "," : "") + JSON.stringify(requireWellFormed(key, "key")) + ":"
      });
    }
  }

  return out.join("");
}

export function sha256Hex(bufferOrString) {
  return createHash("sha256")
    .update(Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(bufferOrString, "utf8"))
    .digest("hex");
}

export function canonicalDigest(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}
