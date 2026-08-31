import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ClaudeRuntimeSettingsError,
  createRuntimeSettings
} from "./claude-runtime-settings.mjs";

const STDERR_SUMMARY_BYTES = 16 * 1024;
const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;
export const MAX_CLAUDE_TIMEOUT_MS = 2_147_483_647;

export class ClaudeRunnerError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ClaudeRunnerError";
    this.code = options.code || "claude_runner_failed";
    this.stderrSummary = options.stderrSummary || "";
    this.stdoutSummary = options.stdoutSummary || "";
    this.durationMs = options.durationMs;
    this.pid = options.pid;
  }
}

export class ClaudeTimeoutError extends ClaudeRunnerError {
  constructor(timeoutMs, options = {}) {
    super(
      "Claude timed out after " + Math.round(timeoutMs / 1000) + " seconds.",
      { ...options, code: "claude_timeout" }
    );
    this.name = "ClaudeTimeoutError";
  }
}

export class ClaudeOutputCaptureOverflowError extends ClaudeRunnerError {
  constructor(maxCaptureBytes, options = {}) {
    super(
      "Claude output exceeded the configured capture limit of " + maxCaptureBytes + " bytes.",
      { ...options, code: "claude_output_capture_overflow" }
    );
    this.name = "ClaudeOutputCaptureOverflowError";
  }
}

export class ClaudeExitError extends ClaudeRunnerError {
  constructor(exitCode, signal, options = {}) {
    const diagnostics = [
      "Claude exited with code " + String(exitCode) + (signal ? " signal=" + signal : "") + ".",
      options.stderrSummary ? "stderr:\n" + options.stderrSummary : "",
      options.stdoutSummary ? "stdout:\n" + options.stdoutSummary : ""
    ]
      .filter(Boolean)
      .join("\n");
    super(diagnostics, { ...options, code: "claude_non_zero_exit" });
    this.name = "ClaudeExitError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

function summarizeBuffer(buffer, streamName) {
  if (buffer.length <= STDERR_SUMMARY_BYTES) {
    return buffer.toString("utf8").trim();
  }

  return (
    buffer.subarray(0, STDERR_SUMMARY_BYTES).toString("utf8").trim() +
    "\n[" + streamName + " summary truncated]"
  );
}

function requireRuntimeSetting(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaudeRunnerError("Claude runtime " + name + " must be a non-empty string.", {
      code: "invalid_runtime_policy"
    });
  }
}

function validateRuntimePolicy(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new ClaudeRunnerError("Claude runtime policy is required.", {
      code: "invalid_runtime_policy"
    });
  }
  requireRuntimeSetting("claudeBin", runtime.claudeBin);
  requireRuntimeSetting("model", runtime.model);
  requireRuntimeSetting("reasoningEffort", runtime.reasoningEffort);
  requireRuntimeSetting("permissionMode", runtime.permissionMode);
  if (!Array.isArray(runtime.toolNames) || runtime.toolNames.length === 0) {
    throw new ClaudeRunnerError("Claude runtime must contain a non-empty tool list.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!Array.isArray(runtime.disallowedTools) || !runtime.disallowedTools.includes("mcp__*")) {
    throw new ClaudeRunnerError("Claude runtime must deny external MCP tools.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!["none", "git-readonly", "task", "worker"].includes(runtime.shellPolicy)) {
    throw new ClaudeRunnerError("Claude runtime shell policy is invalid.", {
      code: "invalid_runtime_policy"
    });
  }
  if (!runtime.childEnvironment || typeof runtime.childEnvironment !== "object") {
    throw new ClaudeRunnerError("Claude runtime child environment is required.", {
      code: "invalid_runtime_policy"
    });
  }
}

function buildClaudeArgs(runtime, settingsPath) {
  requireRuntimeSetting("settings path", settingsPath);
  return [
    "-p",
    "--input-format",
    "text",
    "--model",
    runtime.model,
    "--effort",
    runtime.reasoningEffort,
    "--permission-mode",
    runtime.permissionMode,
    "--tools",
    runtime.toolNames.join(","),
    "--disallowed-tools",
    runtime.disallowedTools.join(","),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    settingsPath,
    "--restricted",
    "--no-session-persistence",
    "--no-chrome",
    "--output-format",
    "text"
  ];
}

export function getClaudeRunnerArgs(runtime, settingsPath = "<runtime-settings>") {
  return [...buildClaudeArgs(runtime, settingsPath)];
}

function runtimeTimeoutIsValid(timeoutMs) {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= MAX_CLAUDE_TIMEOUT_MS
  );
}

function fallbackChildKill(child) {
  try {
    child.kill();
  } catch {
    // The process may already have exited.
  }
  return "child-kill";
}

/**
 * On Windows, target only the exact Claude child PID with taskkill /T /F so
 * timeouts and forced failures include its descendants. This is bounded and
 * falls back to child.kill() if taskkill itself cannot start. It is not a
 * process-group or crash-recovery system.
 */
export function terminateClaudeChild(
  child,
  {
    platform = process.platform,
    spawnTerminator = spawn,
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  } = {}
) {
  if (
    child &&
    ((child.exitCode !== undefined && child.exitCode !== null) ||
      (child.signalCode !== undefined && child.signalCode !== null))
  ) {
    return "already-exited";
  }
  if (platform !== "win32" || !Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    return fallbackChildKill(child);
  }

  try {
    const terminator = spawnTerminator(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" }
    );
    if (!terminator || typeof terminator !== "object") {
      return fallbackChildKill(child);
    }
    const timer = schedule(() => {
      try {
        terminator.kill();
      } catch {
        // The terminator may have already exited.
      }
    }, PROCESS_TREE_TERMINATION_TIMEOUT_MS);
    if (typeof timer?.unref === "function") timer.unref();
    terminator.once?.("close", () => cancelSchedule(timer));
    terminator.once?.("error", () => {
      cancelSchedule(timer);
      fallbackChildKill(child);
    });
    return "taskkill";
  } catch {
    return fallbackChildKill(child);
  }
}

async function cleanupSettings(settings, startedAt, now, pid) {
  try {
    await settings.cleanup();
  } catch (error) {
    throw new ClaudeRunnerError(
      "Failed to remove isolated Claude runtime settings. " +
        (error instanceof Error ? error.message : String(error)),
      {
        code: "claude_settings_cleanup_failed",
        cause: error,
        durationMs: Math.max(0, now() - startedAt),
        pid
      }
    );
  }
}

/**
 * Launches one fresh Claude print-mode process for one delegation.
 *
 * The composed prompt is deliberately sent over stdin. It is never placed in
 * argv, so large contracts and assignments do not encounter Windows command
 * length limits or become visible in command-line process inspection.
 */
export async function runClaudeAgent({
  prompt,
  cwd,
  canonicalRoot = cwd,
  executionId = randomUUID(),
  runtime,
  spawnProcess = spawn,
  createSettings = createRuntimeSettings,
  terminateChild = terminateClaudeChild,
  now = Date.now
}) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new ClaudeRunnerError("Claude prompt must be a non-empty string.", {
      code: "invalid_prompt"
    });
  }
  if (
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    typeof canonicalRoot !== "string" ||
    canonicalRoot.length === 0
  ) {
    throw new ClaudeRunnerError("Claude cwd and canonical root must be non-empty strings.", {
      code: "invalid_workspace"
    });
  }
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new ClaudeRunnerError("Claude executionId must be a non-empty string.", {
      code: "invalid_execution_id"
    });
  }
  if (!runtimeTimeoutIsValid(runtime?.timeoutMs)) {
    throw new ClaudeRunnerError(
      "Claude timeoutMs must be a positive integer no greater than " +
        MAX_CLAUDE_TIMEOUT_MS +
        " milliseconds.",
      { code: "invalid_timeout" }
    );
  }
  validateRuntimePolicy(runtime);

  const startedAt = now();
  let settings;
  try {
    settings = await createSettings({
      executionId,
      shellPolicy: runtime.shellPolicy
    });
  } catch (error) {
    const settingsError = error instanceof ClaudeRuntimeSettingsError
      ? error
      : new ClaudeRuntimeSettingsError(String(error), { cause: error });
    throw new ClaudeRunnerError(settingsError.message, {
      code: settingsError.code || "claude_runtime_settings_failed",
      cause: settingsError,
      durationMs: Math.max(0, now() - startedAt)
    });
  }

  let args;
  try {
    args = buildClaudeArgs(runtime, settings.settingsPath);
  } catch (error) {
    await cleanupSettings(settings, startedAt, now);
    throw error;
  }
  let child;

  try {
    child = spawnProcess(runtime.claudeBin, args, {
      cwd,
      env: runtime.childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    await cleanupSettings(settings, startedAt, now);
    throw new ClaudeRunnerError(
      "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
        (error instanceof Error ? error.message : String(error)),
      { code: "claude_spawn_failed", cause: error, durationMs: now() - startedAt }
    );
  }

  if (!child.stdin || !child.stdout || !child.stderr) {
    terminateChild(child);
    await cleanupSettings(settings, startedAt, now, child.pid);
    throw new ClaudeRunnerError("Claude process did not expose the required stdio streams.", {
      code: "claude_stdio_unavailable",
      durationMs: now() - startedAt,
      pid: child.pid
    });
  }

  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let pendingStdinError;
    let timer;

    const durationMs = () => Math.max(0, now() - startedAt);

    const diagnostics = () => ({
      stdoutSummary: summarizeBuffer(Buffer.concat(stdoutChunks), "stdout"),
      stderrSummary: summarizeBuffer(Buffer.concat(stderrChunks), "stderr")
    });

    const settle = (error, value, stop = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && error.durationMs === undefined) {
        error.durationMs = durationMs();
      }
      if (error && error.pid === undefined) {
        error.pid = child.pid;
      }
      if (stop) terminateChild(child);

      void cleanupSettings(settings, startedAt, now, child.pid).then(
        () => {
          if (error) reject(error);
          else resolve(value);
        },
        (cleanupError) => reject(cleanupError)
      );
    };

    const finishError = (error, stop = false) => settle(error, undefined, stop);

    const capture = (chunks, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (capturedBytes + buffer.length > runtime.maxCaptureBytes) {
        finishError(
          new ClaudeOutputCaptureOverflowError(runtime.maxCaptureBytes, diagnostics()),
          true
        );
        return;
      }

      capturedBytes += buffer.length;
      chunks.push(buffer);
    };

    child.stdout.on("data", (chunk) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => capture(stderrChunks, chunk));
    child.stdout.on("error", (error) => {
      finishError(
        new ClaudeRunnerError("Claude stdout failed: " + error.message, {
          code: "claude_stdout_failed",
          cause: error,
          ...diagnostics()
        }),
        true
      );
    });
    child.stderr.on("error", (error) => {
      finishError(
        new ClaudeRunnerError("Claude stderr failed: " + error.message, {
          code: "claude_stderr_failed",
          cause: error,
          ...diagnostics()
        }),
        true
      );
    });
    child.stdin.on("error", (error) => {
      // A large stdin prompt can race an early child exit. Preserve the
      // child's eventual exit code and diagnostics when close arrives; the
      // already-armed timeout still bounds a child that never closes.
      if (!settled && !pendingStdinError) {
        pendingStdinError = error;
      }
    });
    child.on("error", (error) => {
      finishError(
        new ClaudeRunnerError(
          "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
            error.message,
          { code: "claude_spawn_failed", cause: error, ...diagnostics() }
        )
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;

      const outputDiagnostics = diagnostics();
      if (code !== 0) {
        finishError(new ClaudeExitError(code, signal, outputDiagnostics));
        return;
      }

      if (pendingStdinError) {
        finishError(
          new ClaudeRunnerError("Claude stdin failed: " + pendingStdinError.message, {
            code: "claude_stdin_failed",
            cause: pendingStdinError,
            ...outputDiagnostics
          })
        );
        return;
      }

      const result = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (!result) {
        finishError(
          new ClaudeRunnerError(
            "Claude returned no stdout." +
              (outputDiagnostics.stderrSummary
                ? " stderr: " + outputDiagnostics.stderrSummary
                : ""),
            { code: "claude_empty_output", ...outputDiagnostics }
          )
        );
        return;
      }

      settle(undefined, {
        result,
        stderrSummary: outputDiagnostics.stderrSummary,
        durationMs: durationMs(),
        ...(Number.isSafeInteger(child.pid) ? { pid: child.pid } : {})
      });
    });

    timer = setTimeout(() => {
      finishError(new ClaudeTimeoutError(runtime.timeoutMs, diagnostics()), true);
    }, runtime.timeoutMs);

    try {
      child.stdin.write(prompt, "utf8");
      child.stdin.end();
    } catch (error) {
      if (!pendingStdinError) {
        pendingStdinError = error instanceof Error ? error : new Error(String(error));
      }
    }
  });
}
