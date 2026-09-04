import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { delegateAgent, registerDelegateAgentTool } from "../../src/delegate-agent.mjs";
import { ReviewReceiptStore } from "../../src/review/receipt-store.mjs";
import { DurableWriteCustodyManager } from "../../src/write-custody.mjs";
import {
  inspectSyntheticProcess,
  syntheticStartTime
} from "./synthetic-process-identity.mjs";

const phase = process.env.CLAUDE_AGENTS_TEST_PHASE;
const stateRoot = process.env.CLAUDE_AGENTS_TEST_STATE_ROOT;
const markerDirectory = process.env.CLAUDE_AGENTS_TEST_MARKER_DIRECTORY;

if (!phase || !stateRoot || !markerDirectory) {
  throw new Error("Cancellation fixture requires phase, state root, and marker directory.");
}

const IDENTITY_SOURCE = "stdio-cancellation-fixture";
const writeCustody = new DurableWriteCustodyManager({
  stateRoot,
  inspectProcess: inspectSyntheticProcess(IDENTITY_SOURCE)
});
let nextPid = 91_000;

function cancellationError() {
  return Object.assign(new Error("Transport request cancelled."), {
    code: "claude_cancelled",
    processStarted: false
  });
}

async function markReached(name) {
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(path.join(markerDirectory, name + ".ready"), "ready\n", "utf8");
}

async function waitForAbort(signal, marker) {
  await markReached(marker);
  if (signal?.aborted) throw cancellationError();
  await new Promise((resolve, reject) => {
    signal?.addEventListener?.("abort", () => reject(cancellationError()), { once: true });
  });
}

function seededReviewRunner() {
  return async ({ executionId, agentType, repositoryRoot, onChildStarted }) => {
    const pid = nextPid++;
    const processIdentity = {
      executionId,
      agentType,
      repositoryRoot,
      pid,
      child: { pid },
      startedAt: Date.now(),
      startTime: syntheticStartTime(pid),
      source: IDENTITY_SOURCE
    };
    await onChildStarted?.(processIdentity);
    return {
      result: "seeded durable review artifact",
      durationMs: 1,
      processStarted: true,
      processIdentity,
      terminalProof: { processIdentity, event: "close", observedAt: Date.now() }
    };
  };
}

function seedStore() {
  return new ReviewReceiptStore({
    stateRoot,
    // The test wants an unindexed authoritative receipt so the next request
    // must traverse reviews/cs rather than conveniently finding a pointer.
    beforeScopeIndex: async () => await new Promise(() => {})
  });
}

function historyDiscoveryStallStore() {
  return {
    async discoverForScope({ requestContext }) {
      await waitForAbort(requestContext?.abortSignal, "before-history");
      return { status: "complete", receipts: [], skipped: [] };
    },
    async listForChangeSet() { return { receipts: [], skipped: [] }; },
    async put() { throw new Error("AFTER must not run after cancelled BEFORE discovery"); },
    async loadResultArtifact() { return { status: "unavailable", error: "not-used" }; }
  };
}

function stalledRecoveryStore(input) {
  return new ReviewReceiptStore({
    stateRoot,
    readFileFn: async (pathname, encoding) => {
      const normalized = String(pathname).replaceAll("\\", "/");
      if (phase === "authoritative-recovery" && normalized.includes("/reviews/cs/")) {
        await waitForAbort(input.abortSignal, "authoritative-recovery");
      }
      if (phase === "reconcile-artifact" && normalized.includes("/reviews/artifacts/")) {
        await waitForAbort(input.abortSignal, "reconcile-artifact");
      }
      return await readFile(pathname, encoding);
    }
  });
}

async function delegateForFixture(input, dependencies) {
  const common = {
    ...dependencies,
    writeCustody,
    env: {},
    runAgent: seededReviewRunner()
  };

  if (input.task === "seed durable receipt") {
    return await delegateAgent(input, { ...common, receiptStore: seedStore() });
  }

  if (phase === "worktree-preparation") {
    return await delegateAgent(input, {
      ...common,
      worktreeManager: {
        async prepare({ requestContext }) {
          await waitForAbort(requestContext?.abortSignal, "worktree-preparation");
        }
      }
    });
  }

  if (phase === "before-history") {
    return await delegateAgent(input, { ...common, receiptStore: historyDiscoveryStallStore() });
  }

  return await delegateAgent(input, { ...common, receiptStore: stalledRecoveryStore(input) });
}

function createServer() {
  const server = new McpServer({ name: "claude-agents-cancellation-fixture", version: "test" });
  registerDelegateAgentTool(server, { delegate: delegateForFixture });
  return server;
}

void serveStdio(createServer);
