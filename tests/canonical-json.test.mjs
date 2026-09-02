import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJson,
  isWellFormedString,
  sha256Hex
} from "../src/canonical-json.mjs";

/**
 * The RFC 8785 vectors below are the input/output pairs published with
 * erdtman/canonicalize (test/testdata). They are reproduced here rather than
 * depended on: the package declares node >= 22 and CI runs 20.
 */

test("JCS vectors serialize byte-exactly", () => {
  assert.equal(
    canonicalJson([56, { d: true, 10: null, 1: [] }]),
    '[56,{"1":[],"10":null,"d":true}]'
  );

  assert.equal(
    canonicalJson({
      "": "empty",
      1: { "\n": 56, f: { f: "hi", F: 5 } },
      10: {},
      111: [{ e: "yes", E: "no" }],
      A: { b: "123" },
      a: {}
    }),
    '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{"b":"123"},"a":{}}'
  );

  // No Unicode normalization: the decomposed form stays decomposed.
  assert.equal(
    canonicalJson({ "Unnormalized Unicode": "Å" }),
    '{"Unnormalized Unicode":"Å"}'
  );

  // U+0080 is a control character JSON does not require escaping, and RFC 8785
  // emits it raw. Escaping it would make two canonicalizers disagree.
  assert.equal(canonicalJson({ x: "" }), '{"x":""}');

  assert.equal(
    canonicalJson({ peach: "This sorting order", péché: "is wrong according to French", "éclair": "!" }),
    '{"peach":"This sorting order","péché":"is wrong according to French","éclair":"!"}'
  );
});

test("keys sort by UTF-16 code unit, not code point and not locale", () => {
  // The decisive case: U+1F600 is a surrogate pair beginning 0xD83D, which is
  // below 0xFFFF as code units and above it as code points.
  assert.equal(canonicalJson({ "￿": 1, "\u{1f600}": 2 }), '{"\u{1f600}":2,"￿":1}');
  assert.equal(canonicalJson({ "דּ": 1, "\u{1f600}": 2 }), '{"\u{1f600}":2,"דּ":1}');
  assert.equal(canonicalJson({ 1: "one", "\r": "cr" }), '{"\\r":"cr","1":"one"}');
});

test("insertion order never affects the bytes or the digest", () => {
  const left = { b: 1, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalDigest(left), canonicalDigest(right));
});

test("nested arrays and objects keep their element order", () => {
  assert.equal(canonicalJson({ a: [1, [2, [3]], 4], b: "x" }), '{"a":[1,[2,[3]],4],"b":"x"}');
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([[], {}, null, true, false]), "[[],{},null,true,false]");
});

const REJECTED = [
  ["undefined value", undefined],
  ["function", () => {}],
  ["symbol", Symbol("s")],
  ["bigint", 10n],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["negative zero", -0],
  ["fractional number", 1.5],
  ["unsafe integer", 2 ** 53],
  ["Date", new Date(0)],
  ["toJSON object", { toJSON() { return 1; } }],
  ["boxed number", new Number(1)],
  ["boxed string", new String("s")],
  ["Map", new Map()],
  ["Set", new Set()],
  ["typed array", new Uint8Array([1])],
  ["lone high surrogate", "\ud800"],
  ["lone low surrogate", "\udc00"]
];

for (const [name, value] of REJECTED) {
  test("canonical JSON rejects a " + name, () => {
    assert.throws(() => canonicalJson(value), (error) => {
      assert.ok(error instanceof CanonicalJsonError);
      assert.equal(error.code, "canonical_json_unsupported_value");
      return true;
    });
  });
}

test("canonical JSON rejects an undefined member and a class instance", () => {
  assert.throws(() => canonicalJson({ a: undefined }), CanonicalJsonError);
  class Thing { constructor() { this.a = 1; } }
  assert.throws(() => canonicalJson(new Thing()), CanonicalJsonError);
});

test("canonical JSON rejects a lone surrogate used as a key", () => {
  assert.throws(() => canonicalJson({ "\ud800": 1 }), CanonicalJsonError);
});

test("canonical JSON rejects a cycle rather than overflowing", () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), CanonicalJsonError);
});

test("canonical JSON refuses nesting past the depth limit instead of crashing", () => {
  let deep = 1;
  for (let index = 0; index < 70; index += 1) deep = [deep];
  assert.throws(() => canonicalJson(deep), (error) => {
    assert.equal(error.code, "canonical_json_depth_exceeded");
    return true;
  });

  let shallow = 1;
  for (let index = 0; index < 60; index += 1) shallow = [shallow];
  assert.equal(typeof canonicalJson(shallow), "string");
});

test("the RFC 8785 numeric vectors are rejected, because the domain excludes them", () => {
  // values.json in the upstream suite carries 1E30, 4.50 and 2e-3. Phase 6
  // never needs a non-integer, so these are a rejection test rather than an
  // output test, and the float rules are never exercised.
  for (const value of [1e30, 4.5, 2e-3]) {
    assert.throws(() => canonicalJson({ v: value }), CanonicalJsonError);
  }
});

test("safe integers serialize as plain decimal", () => {
  assert.equal(canonicalJson({ a: 0, b: 1, c: -1, d: Number.MAX_SAFE_INTEGER }),
    '{"a":0,"b":1,"c":-1,"d":9007199254740991}');
});

test("sha256Hex accepts strings and buffers identically", () => {
  assert.equal(sha256Hex("abc"), sha256Hex(Buffer.from("abc", "utf8")));
  assert.match(sha256Hex(""), /^[0-9a-f]{64}$/u);
});

test("canonicalDigest is the sha256 of the canonical utf8 bytes", () => {
  const value = { b: "ü", a: 1 };
  assert.equal(canonicalDigest(value), sha256Hex(Buffer.from(canonicalJson(value), "utf8")));
});

test("isWellFormedString detects lone surrogates in both positions", () => {
  assert.equal(isWellFormedString("ok"), true);
  assert.equal(isWellFormedString("\u{1f600}"), true);
  assert.equal(isWellFormedString("\ud800"), false);
  assert.equal(isWellFormedString("\udc00x"), false);
  assert.equal(isWellFormedString("a\ud83d"), false);
  assert.equal(isWellFormedString(42), false);
});
