#!/usr/bin/env node
import { evaluateShellPolicy, parsePreToolUseInput } from "../src/shell-policy.mjs";

function readPolicyArgument(argv) {
  const index = argv.indexOf("--policy");
  const policy = index >= 0 ? argv[index + 1] : undefined;
  if (!["git-readonly", "task", "worker"].includes(policy)) {
    throw new Error("Hook policy must be git-readonly, task, or worker.");
  }
  return policy;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const policy = readPolicyArgument(process.argv.slice(2));
  const command = parsePreToolUseInput(await readStdin());
  const decision = evaluateShellPolicy(policy, command);
  if (!decision.allowed) {
    process.stderr.write("Blocked by claude-agents shell policy: " + decision.reason + "\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(
    "Blocked by claude-agents shell policy: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n"
  );
  process.exitCode = 2;
}
