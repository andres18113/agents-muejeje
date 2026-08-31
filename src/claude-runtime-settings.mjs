import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultHookPath = path.resolve(moduleDirectory, "..", "hooks", "claude-pretool-policy.mjs");

export class ClaudeRuntimeSettingsError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ClaudeRuntimeSettingsError";
    this.code = options.code || "claude_runtime_settings_failed";
  }
}

function quotedCommandArgument(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || value.includes('"')) {
    throw new ClaudeRuntimeSettingsError("Runtime hook command contains an unsafe path argument.");
  }
  return '"' + value + '"';
}

export function buildRuntimeSettingsPayload({ shellPolicy, hookPath = defaultHookPath, nodePath = process.execPath }) {
  if (shellPolicy === "none") {
    return Object.freeze({});
  }
  if (!["git-readonly", "task", "worker"].includes(shellPolicy)) {
    throw new ClaudeRuntimeSettingsError("Unsupported runtime shell policy: " + String(shellPolicy));
  }

  const command = [
    quotedCommandArgument(nodePath),
    quotedCommandArgument(hookPath),
    "--policy",
    shellPolicy
  ].join(" ");

  return Object.freeze({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command,
              timeout: 10
            }
          ]
        }
      ]
    }
  });
}

/**
 * Create one private, task-free settings file for a fresh invocation. The
 * caller owns cleanup and must invoke it on every terminal path.
 */
export async function createRuntimeSettings(
  {
    executionId,
    shellPolicy,
    tempDirectory = os.tmpdir(),
    hookPath = defaultHookPath,
    nodePath = process.execPath
  },
  { mkdtempFn = mkdtemp, writeFileFn = writeFile, rmFn = rm } = {}
) {
  if (
    typeof executionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(executionId)
  ) {
    throw new ClaudeRuntimeSettingsError("A safe executionId is required for runtime settings.");
  }

  let directory;
  try {
    directory = await mkdtempFn(path.join(tempDirectory, "claude-agents-" + executionId + "-"));
    const settingsPath = path.join(directory, "settings.json");
    const payload = buildRuntimeSettingsPayload({ shellPolicy, hookPath, nodePath });
    await writeFileFn(settingsPath, JSON.stringify(payload), "utf8");

    let cleaned = false;
    return Object.freeze({
      settingsPath,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rmFn(directory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (directory) {
      try {
        await rmFn(directory, { recursive: true, force: true });
      } catch {
        // Preserve the original generation failure; no process has started.
      }
    }
    throw new ClaudeRuntimeSettingsError(
      "Failed to create isolated Claude runtime settings. " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }
}
