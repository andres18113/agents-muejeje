import { DurableWriteCustodyManager } from "../../src/write-custody.mjs";

const [stateRoot, canonicalRoot, executionId] = process.argv.slice(2);
const custody = new DurableWriteCustodyManager({ stateRoot });

try {
  await custody.reserveWriteAccess({
    executionId,
    agentType: "task",
    canonicalRoot,
    canonicalRootKey: canonicalRoot.toLowerCase()
  });
  process.stdout.write("ACQUIRED\n");
  await new Promise((resolve) => setTimeout(resolve, 750));
} catch (error) {
  process.stderr.write((error?.code || "failed") + "\n");
  process.exitCode = 2;
}

