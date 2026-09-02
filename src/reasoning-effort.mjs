/**
 * The reasoning-effort vocabulary accepted by both runtime resolution and
 * durable ReviewReceipt validation. Keeping the ordered domain here prevents
 * an otherwise valid runtime profile from becoming unrepresentable as review
 * evidence when one side evolves independently.
 */

export const SUPPORTED_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

const SUPPORTED_REASONING_EFFORT_SET = new Set(SUPPORTED_REASONING_EFFORTS);

export function isSupportedReasoningEffort(value) {
  return SUPPORTED_REASONING_EFFORT_SET.has(value);
}
