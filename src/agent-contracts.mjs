import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentProfile } from "./agent-registry.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const agentsDirectory = path.join(projectRoot, "agents");
const contractCache = new Map();

function resolveProfileContractPath(profile) {
  const expectedContractPath = "agents/" + profile.id + ".md";
  const contractPath = profile.contractPath;

  if (contractPath !== expectedContractPath || path.isAbsolute(contractPath)) {
    throw new Error("Unsafe contract path for agent '" + profile.id + "'.");
  }

  const segments = contractPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Unsafe contract path for agent '" + profile.id + "'.");
  }

  const resolvedPath = path.resolve(projectRoot, ...segments);
  const relativeToAgentsDirectory = path.relative(agentsDirectory, resolvedPath);
  if (
    relativeToAgentsDirectory === "" ||
    relativeToAgentsDirectory === ".." ||
    relativeToAgentsDirectory.startsWith(".." + path.sep) ||
    path.isAbsolute(relativeToAgentsDirectory)
  ) {
    throw new Error("Contract path escapes the agents directory for '" + profile.id + "'.");
  }

  return resolvedPath;
}

export function resolveAgentContractPath(id) {
  return resolveProfileContractPath(getAgentProfile(id));
}

export async function loadAgentContract(id) {
  const profile = getAgentProfile(id);
  const cached = contractCache.get(profile.id);
  if (cached !== undefined) {
    return cached;
  }

  const contractPath = resolveProfileContractPath(profile);
  let details;
  try {
    details = await stat(contractPath);
  } catch (error) {
    throw new Error(
      "Contract file for agent '" + profile.id + "' does not exist: " + contractPath,
      { cause: error }
    );
  }

  if (!details.isFile()) {
    throw new Error(
      "Contract path for agent '" + profile.id + "' is not a file: " + contractPath
    );
  }

  const contract = await readFile(contractPath, "utf8");
  if (contract.trim().length === 0) {
    throw new Error("Contract file for agent '" + profile.id + "' is empty: " + contractPath);
  }

  contractCache.set(profile.id, contract);
  return contract;
}
