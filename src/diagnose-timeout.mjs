import {
  checkTimeoutHierarchySafety,
  deriveMaxProfileTimeout,
  effectiveDelegateTimeoutFromEnvironment
} from "./timeout-policy.mjs";

export function evaluateDiagnoseTimeout({ registry, codexTimeoutSec, env = process.env } = {}) {
  const maxProfileTimeoutMs = deriveMaxProfileTimeout(registry);
  const effectiveDelegateTimeout = effectiveDelegateTimeoutFromEnvironment(env, maxProfileTimeoutMs);
  const timeoutSafety = checkTimeoutHierarchySafety({
    codexTimeoutSec,
    maxProfileTimeoutMs,
    effectiveDelegateTimeoutMs: effectiveDelegateTimeout.timeoutMs,
    effectiveDelegateTimeoutValid: effectiveDelegateTimeout.valid
  });
  return Object.freeze({ maxProfileTimeoutMs, effectiveDelegateTimeout, timeoutSafety });
}
