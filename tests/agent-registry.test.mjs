import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { AGENT_REGISTRY, getAgentProfile } from "../src/agent-registry.mjs";
import {
  loadAgentContract,
  resolveAgentContractPath
} from "../src/agent-contracts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDirectory = path.join(projectRoot, "agents");
const globalAgentsPath = path.join(
  process.env.USERPROFILE || "C:\\Users\\Andres",
  ".codex",
  "AGENTS.md"
);
const expectedIds = [
  "explore",
  "task",
  "general-purpose",
  "code-review",
  "research",
  "rubber-duck",
  "security-review"
];
const requiredProfileFields = [
  "id",
  "displayName",
  "sourceFamily",
  "kind",
  "description",
  "contractPath",
  "modelStrategy",
  "reasoningEffort",
  "timeoutMs",
  "autoInvoke",
  "manualOnly",
  "mutationPosture",
  "enforcementStatus",
  "runtimeIntegrationStatus",
  "declaredCapabilities",
  "allowedSubagents",
  "delegationStatus",
  "outputContract"
];

async function withExploreContractFixture({ createFile, content }, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-agents-contract-fixture-"));
  const fixtureSourceDirectory = path.join(fixtureRoot, "src");
  const fixtureAgentsDirectory = path.join(fixtureRoot, "agents");

  try {
    await Promise.all([
      mkdir(fixtureSourceDirectory, { recursive: true }),
      mkdir(fixtureAgentsDirectory, { recursive: true })
    ]);
    await Promise.all([
      copyFile(
        path.join(projectRoot, "src", "agent-registry.mjs"),
        path.join(fixtureSourceDirectory, "agent-registry.mjs")
      ),
      copyFile(
        path.join(projectRoot, "src", "agent-contracts.mjs"),
        path.join(fixtureSourceDirectory, "agent-contracts.mjs")
      )
    ]);

    if (createFile) {
      await writeFile(path.join(fixtureAgentsDirectory, "explore.md"), content, "utf8");
    }

    const fixtureModuleUrl =
      pathToFileURL(path.join(fixtureSourceDirectory, "agent-contracts.mjs")).href +
      "?fixture=" +
      encodeURIComponent(fixtureRoot);
    const fixtureLoader = await import(fixtureModuleUrl);
    await callback(fixtureLoader);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("registry contains exactly the seven Copilot-derived Phase 3B profiles", () => {
  assert.deepEqual(Object.keys(AGENT_REGISTRY), expectedIds);
  assert.equal(
    new Set(Object.values(AGENT_REGISTRY).map((profile) => profile.id)).size,
    expectedIds.length
  );
  assert.equal(Object.hasOwn(AGENT_REGISTRY, "verify"), false);
  for (const profile of Object.values(AGENT_REGISTRY)) {
    assert.equal(profile.sourceFamily, "copilot-derived");
  }
});

test("every remaining profile has complete active-runtime metadata", () => {
  for (const profile of Object.values(AGENT_REGISTRY)) {
    for (const field of requiredProfileFields) {
      assert.ok(Object.hasOwn(profile, field), profile.id + " is missing " + field);
    }

    for (const field of [
      "id",
      "displayName",
      "sourceFamily",
      "kind",
      "description",
      "contractPath",
      "modelStrategy",
      "reasoningEffort",
      "mutationPosture",
      "enforcementStatus",
      "runtimeIntegrationStatus",
      "delegationStatus",
      "outputContract"
    ]) {
      assert.equal(typeof profile[field], "string", profile.id + "." + field + " must be a string");
      assert.ok(profile[field].trim().length > 0, profile.id + "." + field + " must not be blank");
    }

    assert.equal(profile.runtimeIntegrationStatus, "delegate-agent");
    assert.equal(typeof profile.timeoutMs, "number");
    assert.ok(Number.isSafeInteger(profile.timeoutMs) && profile.timeoutMs > 0);
    assert.equal(typeof profile.autoInvoke, "boolean");
    assert.equal(typeof profile.manualOnly, "boolean");
    assert.ok(Array.isArray(profile.declaredCapabilities));
    assert.ok(profile.declaredCapabilities.length > 0);
    assert.ok(Array.isArray(profile.allowedSubagents));
  }
});

test("agents directory contains exactly the seven profile contracts and no verify contract", async () => {
  const markdownFiles = (await readdir(agentsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(markdownFiles, expectedIds.map((id) => id + ".md").sort());
  await assert.rejects(stat(path.join(agentsDirectory, "verify.md")));
});

test("all seven contracts resolve beneath agents and are substantive", async () => {
  const expectedMarkers = {
    explore: "focused repository question",
    task: "Execute exactly",
    "general-purpose": "complex multi-step",
    "code-review": "high-confidence actionable",
    research: "primary",
    "rubber-duck": "Blocking",
    "security-review": "plausible exploitability"
  };

  for (const id of expectedIds) {
    const contractPath = resolveAgentContractPath(id);
    const details = await stat(contractPath);
    assert.ok(details.isFile(), id + " contract must be a file");
    assert.equal(
      path.relative(projectRoot, contractPath).split(path.sep).join("/"),
      AGENT_REGISTRY[id].contractPath
    );

    const contract = await loadAgentContract(id);
    assert.ok(contract.trim().length >= 120, id + " contract should not be a stub");
    assert.match(contract, new RegExp(expectedMarkers[id]));
  }

  await assert.rejects(loadAgentContract("verify"), /Unknown agent profile/);
});

test("contract resolution is independent of the caller working directory", () => {
  const expectedPath = resolveAgentContractPath("explore");
  const originalWorkingDirectory = process.cwd();

  try {
    process.chdir(os.tmpdir());
    assert.equal(resolveAgentContractPath("explore"), expectedPath);
  } finally {
    process.chdir(originalWorkingDirectory);
  }
});

test("unknown and removed profile ids are rejected before contract paths are resolved", async () => {
  assert.throws(() => getAgentProfile("verify"), /Unknown agent profile/);
  assert.throws(() => getAgentProfile("../explore"), /Unknown agent profile/);
  await assert.rejects(loadAgentContract("verify"), /Unknown agent profile/);
  await assert.rejects(loadAgentContract("../explore"), /Unknown agent profile/);
});

test("loader rejects missing and whitespace-only contracts", async () => {
  await withExploreContractFixture({ createFile: false, content: "" }, async (fixtureLoader) => {
    await assert.rejects(fixtureLoader.loadAgentContract("explore"), /does not exist/);
  });

  await withExploreContractFixture(
    { createFile: true, content: "\uFEFF \r\n\t" },
    async (fixtureLoader) => {
      await assert.rejects(fixtureLoader.loadAgentContract("explore"), /is empty/);
    }
  );
});

test("declarative subagent relationships only reference valid remaining profiles", () => {
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    assert.ok(Object.hasOwn(AGENT_REGISTRY, id), "unknown agent " + id);
    assert.ok(!visiting.has(id), "delegation cycle includes " + id);
    if (visited.has(id)) return;

    visiting.add(id);
    for (const subagentId of AGENT_REGISTRY[id].allowedSubagents) {
      assert.ok(Object.hasOwn(AGENT_REGISTRY, subagentId), id + " references unknown " + subagentId);
      assert.notEqual(subagentId, id, id + " delegates to itself");
      visit(subagentId);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of expectedIds) visit(id);
});

test("specified Phase 3B policy metadata is retained", () => {
  assert.equal(AGENT_REGISTRY.research.manualOnly, true);
  assert.equal(AGENT_REGISTRY.research.autoInvoke, false);
  assert.equal(AGENT_REGISTRY["rubber-duck"].modelStrategy, "complementary");
  assert.deepEqual(AGENT_REGISTRY["code-review"].allowedSubagents, [
    "explore",
    "security-review"
  ]);
  assert.deepEqual(AGENT_REGISTRY["security-review"].allowedSubagents, ["explore"]);
  for (const profile of Object.values(AGENT_REGISTRY)) {
    assert.equal(profile.autoInvoke, false);
    assert.equal(profile.delegationStatus, "declarative-only");
  }
});

test("posture metadata remains declarative rather than falsely hard-enforced", () => {
  for (const id of ["explore", "code-review", "rubber-duck", "security-review"]) {
    assert.equal(AGENT_REGISTRY[id].mutationPosture, "read-only");
  }
  assert.equal(AGENT_REGISTRY.task.mutationPosture, "mutation-capable");
  assert.equal(AGENT_REGISTRY["general-purpose"].mutationPosture, "mutation-capable");
  assert.equal(AGENT_REGISTRY.research.mutationPosture, "runtime-dependent");
  for (const profile of Object.values(AGENT_REGISTRY)) {
    assert.equal(profile.enforcementStatus, "not-yet-enforced");
  }
});

test("registry and nested declarative fields are immutable", () => {
  assert.ok(Object.isFrozen(AGENT_REGISTRY));
  for (const profile of Object.values(AGENT_REGISTRY)) {
    assert.ok(Object.isFrozen(profile), profile.id + " profile must be frozen");
    assert.ok(Object.isFrozen(profile.declaredCapabilities));
    assert.ok(Object.isFrozen(profile.allowedSubagents));
  }

  assert.throws(() => {
    AGENT_REGISTRY.explore = null;
  }, TypeError);
  assert.throws(() => {
    AGENT_REGISTRY["code-review"].allowedSubagents.push("explore");
  }, TypeError);
});

test("the MCP entrypoint registers only delegate_agent and owns no Claude runtime", async () => {
  const indexPath = path.join(projectRoot, "src", "index.mjs");
  const delegateAgentPath = path.join(projectRoot, "src", "delegate-agent.mjs");
  const syntaxCheck = spawnSync(process.execPath, ["--check", indexPath], { encoding: "utf8" });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || syntaxCheck.stdout);

  const [indexSource, delegateSource] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(delegateAgentPath, "utf8")
  ]);
  assert.match(indexSource, /import \{ registerDelegateAgentTool \} from "\.\/delegate-agent\.mjs";/);
  assert.match(indexSource, /registerDelegateAgentTool\(server\);/);
  assert.equal((indexSource.match(/registerDelegateAgentTool\(server\)/g) ?? []).length, 1);
  assert.doesNotMatch(indexSource, /node:child_process|\bspawn\(|rolePolicy|buildPrompt|registerClaudeTool/);

  const registrations = [
    ...delegateSource.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)
  ].map((match) => match[1]);
  assert.deepEqual(registrations, ["delegate_agent"]);
});

test("the consolidated source has one child-process launch owner and no legacy runtime identifiers", async () => {
  const sourceDirectory = path.join(projectRoot, "src");
  const sourceFiles = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  const sourceByFile = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (name) => [name, await readFile(path.join(sourceDirectory, name), "utf8")])
    )
  );

  const childProcessOwners = sourceFiles.filter((name) =>
    sourceByFile[name].includes('from "node:child_process"')
  );
  assert.deepEqual(childProcessOwners, ["claude-runner.mjs"]);
  assert.match(sourceByFile["claude-runner.mjs"], /spawnProcess = spawn/);

  for (const identifier of [
    "claude_review",
    "claude_critic",
    "claude_verify",
    "rolePolicy",
    "buildPrompt",
    "registerClaudeTool",
    "LEGACY_TOOL_AGENT_MAP",
    "LEGACY_TOOL_RUNTIME_ROLE_TOKENS",
    "CLAUDE_AGENTS_EFFORT",
    "CLAUDE_AGENTS_TIMEOUT_MS"
  ]) {
    for (const [name, source] of Object.entries(sourceByFile)) {
      assert.equal(source.includes(identifier), false, identifier + " remains in " + name);
    }
  }
});

test("global routing and documentation name only the consolidated profile surface", async () => {
  const [globalPolicy, readme, installer] = await Promise.all([
    readFile(globalAgentsPath, "utf8"),
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "install-codex.ps1"), "utf8")
  ]);

  for (const id of expectedIds) {
    assert.match(globalPolicy, new RegExp('delegate_agent\\(agent_type="' + id + '"\\)'));
    assert.match(readme, new RegExp('`' + id.replace(/[-]/g, "\\-") + '`'));
  }
  assert.match(globalPolicy, /Codex performs narrow factual or evidentiary verification directly/);
  assert.doesNotMatch(globalPolicy, /delegate_agent\(agent_type="verify"\)/);
  assert.doesNotMatch(readme, /agents\/verify\.md/);

  for (const legacyIdentifier of ["claude_review", "claude_critic", "claude_verify"]) {
    assert.equal(globalPolicy.includes(legacyIdentifier), false);
    assert.equal(readme.includes(legacyIdentifier), false);
  }
  for (const legacyEnvironmentVariable of [
    "CLAUDE_AGENTS_EFFORT",
    "CLAUDE_AGENTS_TIMEOUT_MS"
  ]) {
    assert.equal(installer.includes(legacyEnvironmentVariable), false);
  }
});
