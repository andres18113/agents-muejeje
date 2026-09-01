/**
 * The failure and lifecycle-evidence vocabulary of one Claude invocation.
 *
 * Every error carried across the runner/termination boundary states not only
 * what went wrong but what was proven while it did: whether a process started,
 * whether an exact `close` was observed, and what the forced-termination
 * attempt concluded. Custody decisions read that evidence, so it lives with the
 * errors rather than being reassembled at each call site.
 */

export class ClaudeRunnerError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ClaudeRunnerError";
    this.code = options.code || "claude_runner_failed";
    this.stderrSummary = options.stderrSummary || "";
    this.stdoutSummary = options.stdoutSummary || "";
    this.durationMs = options.durationMs;
    this.pid = options.pid;
    this.processIdentity = options.processIdentity;
    this.terminalProof = options.terminalProof;
    this.terminationResult = options.terminationResult;
    this.processStarted = options.processStarted;
    // Cleanup is housekeeping evidence, not a replacement for the process
    // outcome that caused it. Keeping both lets custody consume a close proof
    // even when removing temporary settings later fails.
    this.processOutcome = options.processOutcome;
    this.cleanupFailure = options.cleanupFailure;
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

/**
 * The child may have received a forced-termination request, but no close/exit
 * event proved that this exact ChildProcess instance became terminal. Callers
 * must retain write custody when this error is associated with a writer.
 */
export class ClaudeTerminationUnprovenError extends ClaudeRunnerError {
  constructor(originalError, terminationResult, options = {}) {
    super(
      "Claude child termination could not be proven; write custody must remain retained.",
      {
        ...options,
        code: "claude_termination_unproven",
        cause: originalError,
        stderrSummary: originalError?.stderrSummary || "",
        stdoutSummary: originalError?.stdoutSummary || "",
        terminationResult,
        processStarted: true
      }
    );
    this.name = "ClaudeTerminationUnprovenError";
    this.originalErrorCode = originalError?.code || "claude_runner_failed";
    this.timeoutOccurred =
      originalError instanceof ClaudeTimeoutError || originalError?.code === "claude_timeout";
    // A late exact target close can recover ORPHANED custody only when no
    // launched taskkill helper remains unproven. This stays internal lifecycle
    // evidence; returned delegation outcomes are never mutated afterward.
    this.lateRecoveryAllowed = options.lateRecoveryAllowed !== false;
  }
}

/**
 * Attaches lifecycle evidence to an error without overwriting evidence it
 * already carries. Only fields the caller actually established are copied, so
 * an absent proof stays absent instead of becoming a falsy claim.
 */
export function attachLifecycle(error, lifecycle) {
  if (!error || typeof error !== "object") return error;
  if (lifecycle.processIdentity) error.processIdentity = lifecycle.processIdentity;
  if (lifecycle.terminalProof) error.terminalProof = lifecycle.terminalProof;
  if (lifecycle.terminationResult) error.terminationResult = lifecycle.terminationResult;
  if (lifecycle.processStarted !== undefined) error.processStarted = lifecycle.processStarted;
  if (lifecycle.processOutcome !== undefined) error.processOutcome = lifecycle.processOutcome;
  if (lifecycle.cleanupFailure !== undefined) error.cleanupFailure = lifecycle.cleanupFailure;
  return error;
}
