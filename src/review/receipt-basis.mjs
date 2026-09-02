import { canonicalDigest, sha256Hex } from "../canonical-json.mjs";

/**
 * How the basis of a review is measured.
 *
 * "Basis" is everything about a review other than the repository state it ran
 * against: which contract, which capability policy, which assignment, which
 * model selection, and what came back. A receipt records digests of all of it
 * so two receipts can be compared without either one storing the underlying
 * text.
 *
 * Three rules make these digests mean something precise.
 *
 * Textual values are digested as raw UTF-8 bytes, with no trimming and no
 * normalization, so the digest is of exactly what was used.
 *
 * Structured values are digested through canonical JSON, so a policy object
 * whose keys were built in a different order still digests identically.
 *
 * Assignment size is recorded as JavaScript string length (`chars`), which is
 * the unit the public delegation input contract enforces. Result size is
 * recorded as UTF-8 bytes, which is the unit actually persisted and hashed.
 * The textual digest itself is always over exact UTF-8 bytes in both cases.
 */

export function digestText(value) {
  if (typeof value !== "string") {
    throw new TypeError("Only a string can be digested as text.");
  }
  return sha256Hex(Buffer.from(value, "utf8"));
}

export function measureText(value) {
  return Object.freeze({
    sha256: digestText(value),
    chars: value.length,
    bytes: Buffer.byteLength(value, "utf8")
  });
}

export function contractDigest(contract) {
  return digestText(contract);
}

/**
 * The capability policy is a structured value, so it goes through canonical
 * JSON rather than through JSON.stringify: the resolved policy is assembled by
 * spreading a base entry into shared defaults, and key insertion order is not
 * something this digest should depend on.
 */
export function capabilityPolicyDigest(policy) {
  return canonicalDigest(policy);
}

export function assignmentBasis(task) {
  const measured = measureText(task);
  return Object.freeze({ sha256: measured.sha256, chars: measured.chars });
}

export function resultBasis(result) {
  const text = typeof result === "string" ? result : "";
  return Object.freeze({
    sha256: digestText(text),
    bytes: Buffer.byteLength(text, "utf8")
  });
}

/**
 * What model was asked for, and where the ask came from.
 *
 * Deliberately not called "model". The orchestrator selects a model by passing
 * a selector to the Claude CLI; it never observes which concrete model version
 * actually served the request, and no field here may imply that it did. A
 * consumer comparing two receipts learns that the same selector was requested
 * from the same source, which is a real and useful fact, and is not misled into
 * believing an effective model identity was recorded.
 */
export function modelBasis(runtime) {
  return Object.freeze({
    modelSelector: runtime.model,
    modelSelectorSource: runtime.modelSource,
    modelStrategy: runtime.modelStrategy,
    reasoningEffort: runtime.reasoningEffort
  });
}

export function reviewerBasis({ agentType, contract, capabilityPolicy, runtime }) {
  const model = modelBasis(runtime);
  return Object.freeze({
    agentType,
    contractSha256: contractDigest(contract),
    capabilityPolicySha256: capabilityPolicyDigest(capabilityPolicy),
    modelSelector: model.modelSelector,
    modelSelectorSource: model.modelSelectorSource,
    modelStrategy: model.modelStrategy,
    reasoningEffort: model.reasoningEffort
  });
}
