import { spawn } from "node:child_process";

const STDERR_SUMMARY_BYTES = 16 * 1024;
export const MAX_CLAUDE_TIMEOUT_MS = 2_147_483_647;

export class ClaudeRunnerError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ClaudeRunnerError";
    this.code = options.code || "claude_runner_failed";
    this.stderrSummary = options.stderrSummary || "";
    this.stdoutSummary = options.stdoutSummary || "";
    this.durationMs = options.durationMs;
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
    super(
      diagnostics,
      { ...options, code: "claude_non_zero_exit" }
    );
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

function buildClaudeArgs(runtime) {
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
    "--no-session-persistence",
    "--no-chrome",
    "--output-format",
    "text"
  ];
}

export function getClaudeRunnerArgs(runtime) {
  return [...buildClaudeArgs(runtime)];
}

function runtimeTimeoutIsValid(timeoutMs) {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= MAX_CLAUDE_TIMEOUT_MS
  );
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
  runtime,
  spawnProcess = spawn,
  now = Date.now
}) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new ClaudeRunnerError("Claude prompt must be a non-empty string.", {
      code: "invalid_prompt"
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

  const startedAt = now();
  const args = buildClaudeArgs(runtime);
  let child;

  try {
    child = spawnProcess(runtime.claudeBin, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    throw new ClaudeRunnerError(
      "Failed to launch '" + runtime.claudeBin + "'. Ensure Claude Code is on PATH. " +
        (error instanceof Error ? error.message : String(error)),
      { code: "claude_spawn_failed", cause: error, durationMs: now() - startedAt }
    );
  }

  if (!child.stdin || !child.stdout || !child.stderr) {
    try {
      child.kill();
    } catch {
      // Nothing further is required if an incomplete child cannot be stopped.
    }
    throw new ClaudeRunnerError("Claude process did not expose the required stdio streams.", {
      code: "claude_stdio_unavailable",
      durationMs: now() - startedAt
    });
  }

  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let pendingStdinError;

    const durationMs = () => Math.max(0, now() - startedAt);

    const stopChild = () => {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
    };

    const diagnostics = () => ({
      stdoutSummary: summarizeBuffer(Buffer.concat(stdoutChunks), "stdout"),
      stderrSummary: summarizeBuffer(Buffer.concat(stderrChunks), "stderr")
    });

    const finishError = (error, stop = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.durationMs === undefined) {
        error.durationMs = durationMs();
      }
      if (stop) {
        stopChild();
      }
      reject(error);
    };

    const timer = setTimeout(() => {
      finishError(new ClaudeTimeoutError(runtime.timeoutMs, diagnostics()), true);
    }, runtime.timeoutMs);

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

      settled = true;
      clearTimeout(timer);
      resolve({
        result,
        stderrSummary: outputDiagnostics.stderrSummary,
        durationMs: durationMs()
      });
    });

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
