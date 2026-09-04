/**
 * The one synthetic process identity, and the observation that matches it.
 *
 * A test that mints its own process identities has to supply the observation
 * those identities imply. Leaving custody on the production observation makes
 * the test half-real: it asserts identities no process ever had while asking
 * the real Windows process table about processes it never started. That query
 * is a `powershell.exe` cold start, and under CI contention it can miss its
 * liveness budget - at which point the observation is AMBIGUOUS, ambiguity
 * fails closed, and admission is refused with
 * write_custody_process_identity_ambiguous. The test then fails for a reason
 * that has nothing to do with what it was written to prove.
 *
 * Two rules make a synthetic identity and its observation the same value:
 * one identity source per fixture, and a start time that is a pure function of
 * the PID. Because both sides are minted from those rules, production's own
 * comparison reports SAME_PROCESS - which is exactly what a real, valid,
 * exactly-matching supervised child looks like. Nothing here relaxes what
 * production does with the answer: custody still requires an exact
 * PID + start-time + source match, and an identity that does not match one is
 * still refused.
 *
 * This is a test double. Real Windows process querying, PID reuse, and the
 * DEAD / SAME_PROCESS / AMBIGUOUS classification stay the business of
 * tests/process-identity.test.mjs, tests/supervised-process.test.mjs and
 * tests/windows-termination.test.mjs, which must keep observing real
 * processes and are deliberately left alone.
 */

/** The start time a synthetic PID always has, on both sides of a comparison. */
export function syntheticStartTime(pid) {
  return String(pid * 100);
}

/** The durable identity a synthetic child of `source` presents for `pid`. */
export function syntheticProcessIdentity(pid, source) {
  return Object.freeze({ pid, startTime: syntheticStartTime(pid), source });
}

/**
 * The observation seam for an in-process test: every process the fixture
 * models is alive for the whole run, so that is what it reports.
 */
export function inspectSyntheticProcess(source) {
  return async (pid) => Object.freeze({
    status: "alive",
    identity: syntheticProcessIdentity(pid, source)
  });
}

/**
 * The observation seam for a fixture that runs in its own process.
 *
 * Two independent processes must derive the same identity for the same PID to
 * compare identities the way production does, so liveness comes from signal 0
 * while the start time stays a pure function of the PID. A process that is
 * genuinely gone is DEAD; a probe that cannot answer is ambiguous and fails
 * closed, exactly as the production observation would.
 */
export function probeSyntheticProcess(source) {
  return async (pid) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return Object.freeze({ status: "dead" });
      return Object.freeze({ status: "ambiguous", reason: "fixture-probe-failed" });
    }
    return Object.freeze({ status: "alive", identity: syntheticProcessIdentity(pid, source) });
  };
}
