import { spawn } from "node:child_process";
import path from "node:path";

/**
 * The budget for one Windows identity query.
 *
 * The cost here is dominated by Windows PowerShell process startup, not by the
 * query itself: locally a cold query completes in roughly a quarter of a
 * second, but on a loaded CI runner several concurrent cold starts were
 * observed to exceed five seconds, which turned a healthy process into an
 * ambiguous observation. Ambiguity fails closed, so an over-tight budget does
 * not corrupt custody, but it does block admission for a live process.
 *
 * Twenty seconds gives roughly four times the worst observed startup while
 * staying finite and far below any profile timeout. It is a liveness budget,
 * never a correctness one: exceeding it still yields AMBIGUOUS and is never
 * converted into ALIVE or DEAD.
 */
const PROCESS_QUERY_TIMEOUT_MS = 20_000;

/**
 * Bounded wait for the exact query child to close after we ask it to stop.
 * The query is read-only, so the observation stays AMBIGUOUS either way; this
 * exists so a timed-out query is not simply forgotten while still running.
 */
const PROCESS_QUERY_TERMINATION_TIMEOUT_MS = 5_000;

const MAX_PROCESS_QUERY_OUTPUT_BYTES = 4_096;
const WINDOWS_IDENTITY_SOURCE = "windows-get-process-starttime-utc-ticks";

// The script emits only invariant .NET ticks, never a localized console table.
// It calls System.Diagnostics.Process directly rather than the Get-Process
// cmdlet: the value is byte-identical (both read Process.StartTime) while
// avoiding the Management module load on every query. Exit 3 means the PID
// definitively does not exist; every other failure is ambiguous.
const WINDOWS_PROCESS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetProcessId = [int]__PROCESS_ID__
try {
  $targetProcess = [System.Diagnostics.Process]::GetProcessById($targetProcessId)
} catch [System.ArgumentException] {
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

/**
 * Reads the invariant Windows start time for one PID.
 *
 * Both deadline timers stay referenced: this observation decides PID reuse and
 * liveness for custody and proof-of-death, so the runtime must remain alive
 * until the bounded query resolves.
 *
 * Abandoned queries are not simply forgotten. When the query is cut short, the
 * exact spawned child is asked to stop and then awaited, bounded, for its
 * `close` before the observation completes. Only the handle this function
 * created is ever terminated; nothing is matched by process name. The query is
 * read-only, so every one of these paths still reports AMBIGUOUS, which fails
 * closed.
 */
function queryWindowsProcessStartTime(
  pid,
  {
    spawnProcess = spawn,
    env = process.env,
    timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
    terminationTimeoutMs = PROCESS_QUERY_TERMINATION_TIMEOUT_MS,
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
    // Set once the query has been abandoned. From then on the only remaining
    // work is the bounded wait for the exact child to close.
    let abandoned;
    let queryTimer;
    let terminationTimer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cancelSchedule(queryTimer);
      cancelSchedule(terminationTimer);
      resolve(Object.freeze(value));
    };

    // Ask exactly the child this function spawned to stop, then wait a bounded
    // time for its close. Whether or not that close arrives, the answer is the
    // same ambiguous observation; the wait exists so the query process is not
    // left running unobserved.
    const abandonQuery = (reason) => {
      if (settled || abandoned) return;
      abandoned = { reason };
      cancelSchedule(queryTimer);
      try {
        child.kill?.();
      } catch {
        // The query may already have exited.
      }
      terminationTimer = schedule(() => {
        finish({
          status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
          reason,
          queryTerminationProven: false,
          ...(abandoned?.error ? { queryError: abandoned.error } : {})
        });
      }, terminationTimeoutMs);
    };

    child.stdout?.on?.("data", (chunk) => {
      if (settled || abandoned) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > MAX_PROCESS_QUERY_OUTPUT_BYTES) {
        abandonQuery("query-output-invalid");
        return;
      }
      stdout.push(buffer);
    });
    child.once?.("error", (error) => {
      if (settled) return;
      if (abandoned) {
        // child.kill() can itself cause ChildProcess to emit an error. The
        // query is already abandoned, so that error is diagnostic only: the
        // exact query child still gets its full bounded chance to close.
        abandoned.error = error;
        return;
      }
      finish({ status: PROCESS_IDENTITY_STATUS.AMBIGUOUS, reason: "query-process-error" });
    });
    child.once?.("close", (code) => {
      if (settled) return;
      if (abandoned) {
        // The exact query child closed after we asked it to stop.
        finish({
          status: PROCESS_IDENTITY_STATUS.AMBIGUOUS,
          reason: abandoned.reason,
          queryTerminationProven: true,
          ...(abandoned.error ? { queryError: abandoned.error } : {})
        });
        return;
      }
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
    // Arm the deadline only after every lifecycle listener is present. A
    // deterministic scheduler may invoke a zero-delay callback immediately,
    // and child.kill() is allowed to emit an error synchronously.
    queryTimer = schedule(() => abandonQuery("query-timeout"), timeoutMs);
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
