import { DurableWriteCustodyManager } from "../../src/write-custody.mjs";
import { probeSyntheticProcess } from "./synthetic-process-identity.mjs";

const [stateRoot, canonicalRoot, executionId, identityMode] = process.argv.slice(2);

/**
 * A deterministic, cross-process-consistent identity provider for the atomic
 * admission fixture.
 *
 * That test exists to prove real durable admission under real contention
 * between real processes. It must not also depend on how fast Windows
 * PowerShell can cold-start, which is what made it fail on CI. Liveness comes
 * from signal 0 and the start time is a pure function of the PID, so two
 * independent fixture processes derive the same identity for the same PID and
 * can compare identities exactly as production does.
 *
 * This is a test double. Production identity semantics (real PID + StartTime,
 * PID-reuse detection, ambiguity failing closed) are exercised by the dedicated
 * Windows integration tests instead.
 */
const deterministicIdentity = () => probeSyntheticProcess("fixture-deterministic-identity");

/** Holds the reservation open until the parent says the contention is over. */
function waitForRelease() {
  return new Promise((resolve) => {
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.includes("RELEASE")) resolve();
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
  });
}

const custody = new DurableWriteCustodyManager({
  stateRoot,
  ...(identityMode === "deterministic" ? { inspectProcess: deterministicIdentity() } : {})
});

try {
  await custody.reserveWriteAccess({
    executionId,
    agentType: "task",
    canonicalRoot,
    canonicalRootKey: canonicalRoot.toLowerCase()
  });
  process.stdout.write("ACQUIRED\n");
  await waitForRelease();
} catch (error) {
  process.stderr.write((error?.code || "failed") + "\n");
  process.exitCode = 2;
}
