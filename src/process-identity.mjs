import { spawn } from "node:child_process";
import path from "node:path";

const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const MAX_PROCESS_QUERY_OUTPUT_BYTES = 4_096;
const WINDOWS_IDENTITY_SOURCE = "windows-get-process-starttime-utc-ticks";

// The script emits only invariant .NET ticks. Exit 3 means Get-Process
// definitively did not find the PID; every other failure is ambiguous.
const WINDOWS_PROCESS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetProcessId = [int]__PROCESS_ID__
try {
  $targetProcess = Get-Process -Id $targetProcessId -ErrorAction Stop
} catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
  exit 3
} catch {
  exit 4
}
try {
  $ticks = $targetProcess.StartTime.ToUniversalTime().Ticks
  [Console]::Out.Write($ticks.ToString([Globalization.CultureInfo]::InvariantCulture))
} catch {
  exit 4
}
`;

export const PROCESS_IDENTITY_STATUS = Object.freeze({
  ALIVE: "alive",
  DEAD: "dead",
  AMBIGUOUS: "ambiguous"
});

export const PROCESS_IDENTITY_MATCH = Object.freeze({
  SAME_PROCESS: "same-process-alive",
  DEAD: "dead",
  PID_REUSED: "pid-reused",
  AMBIGUOUS: "ambiguous"
});

export class ProcessIdentityError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ProcessIdentityError";
    this.code = options.code || "process_identity_unavailable";
  }
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

export function validateDurableProcessIdentity(identity, name = "process identity") {
  if (
    !identity ||
    typeof identity !== "object" ||
    !validPid(identity.pid) ||
    typeof identity.startTime !== "string" ||
    !/^\d+$/u.test(identity.startTime) ||
    typeof identity.source !== "string" ||
    identity.source.length === 0
  ) {
    throw new ProcessIdentityError(name + " is malformed.", {
      code: "process_identity_invalid"
    });
  }

  return Object.freeze({
    pid: identity.pid,
    startTime: identity.startTime,
    source: identity.source
  });
}

function windowsPowerShellPath(env) {
  const systemRoot = Object.entries(env || {}).find(
    ([name, value]) => name.toUpperCase() === "SYSTEMROOT" && typeof value === "string" && value.length > 0
  )?.[1];
  return systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function queryWindowsProcessStartTime(
  pid,
  {
    spawnProcess = spawn,
    env = process.env,
    timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  } = {}
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(
        windowsPowerShellPath(env),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_PROCESS_QUERY_SCRIPT.replace("__PROCESS_ID__", String(pid))
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch {
      resolve(Object.freeze({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-spawn-failed" }));
      return;
    }

    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cancelSchedule(timer);
      resolve(Object.freeze(value));
    };
    const timer = schedule(() => {
      timedOut = true;
      try {
        child.kill?.();
      } catch {
        // The query may already have exited.
      }
      finish({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-timeout" });
    }, timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();

    child.stdout?.on?.("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > MAX_PROCESS_QUERY_OUTPUT_BYTES) {
        finish({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-output-invalid" });
        try {
          child.kill?.();
        } catch {
          // Best effort only; ambiguity is already recorded.
        }
        return;
      }
      stdout.push(buffer);
    });
    child.once?.("error", () => {
      finish({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-process-error" });
    });
    child.once?.("close", (code) => {
      if (settled || timedOut) return;
      if (code === 3) {
        finish({ status: PROCESS_IDENTITY_STATUS.DEAD });
        return;
      }
      if (code !== 0) {
        finish({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-failed" });
        return;
      }

      const startTime = Buffer.concat(stdout).toString("utf8").trim();
      if (!/^\d+$/u.test(startTime)) {
        finish({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-output-invalid" });
        return;
      }
      finish({
        status: PROCESS_IDENTITY_STATUS.ALIVE,
        identity: Object.freeze({ pid, startTime, source: WINDOWS_IDENTITY_SOURCE })
      });
    });
  });
}

/**
 * Inspect a PID without making a PID-only decision. This implementation is
 * intentionally Windows-specific; other platforms return ambiguous.
 */
export async function inspectProcessIdentity(
  pid,
  {
    platform = process.platform,
    queryWindowsProcess = queryWindowsProcessStartTime,
    ...queryDependencies
  } = {}
) {
  if (!validPid(pid)) {
    return Object.freeze({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "pid-invalid" });
  }
  if (platform !== "win32") {
    return Object.freeze({
      status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
      reason: "platform-identity-unsupported"
    });
  }

  try {
    return await queryWindowsProcess(pid, queryDependencies);
  } catch {
    return Object.freeze({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-threw" });
  }
}

export async function requireLiveProcessIdentity(pid, dependencies = {}) {
  const observation = await inspectProcessIdentity(pid, dependencies);
  if (observation.status !== PROCESS_IDENTITY_STATUS.ALIVE) {
    throw new ProcessIdentityError(
      "Durable process identity could not be established for PID " + String(pid) + ".",
      { code: "process_identity_unavailable" }
    );
  }
  return validateDurableProcessIdentity(observation.identity);
}

export async function compareProcessIdentity(
  storedIdentity,
  { inspectProcess = inspectProcessIdentity } = {}
) {
  let stored;
  try {
    stored = validateDurableProcessIdentity(storedIdentity);
  } catch {
    return Object.freeze({ status: PROCESS_IDENTITY_MATCH.AMBIGUOUS, reason: "stored-identity-invalid" });
  }

  let observation;
  try {
    observation = await inspectProcess(stored.pid);
  } catch {
    return Object.freeze({ status: PROCESS_IDENTITY_MATCH.AMBIGUOUS, reason: "inspection-threw" });
  }

  if (observation?.status === PROCESS_IDENTITY_STATUS.DEAD) {
    return Object.freeze({ status: PROCESS_IDENTITY_MATCH.DEAD });
  }
  if (observation?.status !== PROCESS_IDENTITY_STATUS.ALIVE) {
    return Object.freeze({
      status: PROCESS_IDENTITY_MATCH.AMBIGUOUS,
      reason: observation?.reason || "inspection-ambiguous"
    });
  }

  let observed;
  try {
    observed = validateDurableProcessIdentity(observation.identity, "observed process identity");
  } catch {
    return Object.freeze({ status: PROCESS_IDENTITY_MATCH.AMBIGUOUS, reason: "observed-identity-invalid" });
  }

  return Object.freeze({
    status:
      observed.source !== stored.source
        ? PROCESS_IDENTITY_MATCH.AMBIGUOUS
        : observed.startTime === stored.startTime
          ? PROCESS_IDENTITY_MATCH.SAME_PROCESS
          : PROCESS_IDENTITY_MATCH.PID_REUSED,
    ...(observed.source !== stored.source ? { reason: "identity-source-mismatch" } : {}),
    observedIdentity: observed
  });
}
