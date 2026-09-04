import { DurableWriteCustodyManager } from "../../src/write-custody.mjs";
import { probeSyntheticProcess } from "./synthetic-process-identity.mjs";

const [
  stateRoot,
  canonicalRoot,
  canonicalRootKey,
  executionId,
  custodyKind = "coherent-review"
] = process.argv.slice(2);

const IDENTITY_SOURCE = "phase6-fixture-identity";

const inspectProcess = probeSyntheticProcess(IDENTITY_SOURCE);

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

const custody = new DurableWriteCustodyManager({ stateRoot, inspectProcess });

try {
  await custody.reserveWriteAccess({
    executionId,
    agentType: custodyKind === "coherent-review" ? "code-review" : "general-purpose",
    canonicalRoot,
    canonicalRootKey,
    ...(custodyKind === "coherent-review" ? { custodyKind } : {})
  });
  process.stdout.write("ACQUIRED\n");
  await waitForRelease();
  await custody.releaseUnstartedWriteAccess({ executionId, canonicalRootKey });
} catch (error) {
  process.stderr.write((error?.code || "failed") + "\n");
  process.exitCode = 2;
}
