import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardDeniedBashRules } from "./shell-policy.mjs";

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
    // The deny rules are the fail-closed gate; the hook is defense in depth.
    // A PreToolUse hook runs as a separate process: it can time out or fail,
    // and neither blocks the tool call. So everything statable as a rule is
    // denied by the runtime that owns the call - prohibited commands,
    // dangerous Git operations, and canonical publication, each in
    // first-position, wrapper-separated, and absolute-path spellings - while
    // the hook only adds the judgements no rule can express: case variants,
    // non-first-position publication, and quoted or composed commands.
    permissions: {
      deny: hardDeniedBashRules()
    },
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
        await rmFn(directory, { recursive: true, force: true });
        // A failed removal is still live cleanup work and must remain retryable.
        cleaned = true;
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
