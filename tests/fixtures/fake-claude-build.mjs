import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one place that builds tests/fixtures/fake-claude.exe.
 *
 * The executable is git-ignored, so a fresh checkout - which is every CI run -
 * has to compile it. Six test files need it, `node --test` runs files in
 * parallel worker processes, and each file used to carry its own copy of
 *
 *     if (!existsSync(exe)) spawnSync(csc, ["/out:" + exe, source])
 *
 * against the same output path. That is check-then-act across processes with no
 * exclusion: two workers both see the file missing and both start a compiler
 * writing the same bytes, or one worker executes an executable a second
 * worker's compiler is still writing. Deleting the artifact and running the six
 * files together reproduced it at roughly one run in three, as
 * "Failed to compile FakeClaude.cs" with the compiler's output empty.
 *
 * Two mechanisms fix it, and they are deliberately layered:
 *
 *   Publication is what makes it *correct*. A build always compiles to a
 *   private staging path that no other process can name, is validated there,
 *   and only then is renamed onto the published path. Rename within a
 *   directory is atomic, so the published path never exists in a half-written
 *   state and no compiler ever writes to a path another process may execute.
 *   This holds even if the lock below fails completely: the worst case is two
 *   redundant compilations, of which exactly one rename lands.
 *
 *   The lock is what makes it *cheap*. An exclusive create (O_CREAT|O_EXCL,
 *   which is atomic on Windows and POSIX alike) elects one builder so the
 *   other five workers wait for its result instead of each running a compiler.
 *
 * Existence is never accepted as proof of a completed build. The published
 * path is validated - a real file, plausibly sized, carrying the MZ signature
 * of a PE image - before it is trusted, so a truncated or garbage file left by
 * an older, unsafe build is rebuilt rather than executed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_CLAUDE_SOURCE = path.join(here, "FakeClaude.cs");
export const FAKE_CLAUDE_EXE = path.join(here, "fake-claude.exe");

/** The published artifact must outlive one compile; this bounds a wait, never a race. */
export const BUILD_WAIT_TIMEOUT_MS = 120_000;
/**
 * How long a lock may be held before a waiter is allowed to break it. A
 * compile takes a second or two, so a minute means the owner is gone or wedged.
 * Breaking it is safe rather than merely tolerable: staging plus atomic publish
 * already make a concurrent second compile harmless.
 */
export const STALE_LOCK_MS = 60_000;
const POLL_INTERVAL_MS = 25;
const MIN_PLAUSIBLE_EXE_BYTES = 512;

/** Blocks this thread without burning it. ensureFakeClaude must stay synchronous. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function findCsc(env = process.env) {
  const candidates = [
    env.CSC_PATH,
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "csc.exe";
}

/**
 * Whether a path holds something that could only be a finished build. A
 * compiler that died midway, or an interrupted copy, fails here and is rebuilt.
 */
export function isPublishedExecutable(exePath) {
  let stats;
  try {
    stats = statSync(exePath);
  } catch {
    return false;
  }
  if (!stats.isFile() || stats.size < MIN_PLAUSIBLE_EXE_BYTES) return false;
  try {
    const header = Buffer.alloc(2);
    const handle = openSync(exePath, "r");
    try {
      readSync(handle, header, 0, 2, 0);
    } finally {
      closeSync(handle);
    }
    // Every PE image starts with the DOS "MZ" signature. A truncated or
    // garbage file left behind by an interrupted build fails here.
    return header.toString("latin1") === "MZ";
  } catch {
    return false;
  }
}

function lockPathFor(exePath) {
  return exePath + ".build-lock";
}

function stagingPathFor(exePath) {
  const unique = process.pid.toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  return exePath + "." + unique + ".staging";
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function ownerIsGone(owner, now) {
  if (!owner || !Number.isSafeInteger(owner.pid)) return true;
  if (owner.host !== os.hostname()) {
    // Another machine's lock in a shared checkout: only age can judge it.
    return now - (owner.startedAt ?? 0) > STALE_LOCK_MS;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return true;
  }
  return now - (owner.startedAt ?? 0) > STALE_LOCK_MS;
}

/**
 * Breaks a lock only if it is still the same dead owner we judged. Re-reading
 * before unlinking means a fresh lock taken in the meantime is left alone.
 */
function breakStaleLock(lockPath, owner) {
  const current = readLockOwner(lockPath);
  if (!current || !owner) return;
  if (current.pid !== owner.pid || current.startedAt !== owner.startedAt) return;
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Someone else broke it first; the next acquire attempt decides.
  }
}

function acquireLock(lockPath, now) {
  let handle;
  try {
    handle = openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") return undefined;
    throw error;
  }
  try {
    writeSync(handle, JSON.stringify({ pid: process.pid, startedAt: now(), host: os.hostname() }));
  } catch {
    // Metadata is diagnostic only; the exclusive create is the actual lock.
  } finally {
    closeSync(handle);
  }
  return lockPath;
}

function compileTo(stagingPath, { sourcePath, compilerPath }) {
  const result = spawnSync(compilerPath, ["/nologo", "/out:" + stagingPath, sourcePath], {
    windowsHide: true,
    shell: false,
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail: [
        "compiler: " + compilerPath,
        "source: " + sourcePath,
        result.error ? "spawn error: " + (result.error.message || result.error) : undefined,
        result.signal ? "signal: " + result.signal : undefined,
        "status: " + String(result.status),
        result.stderr?.trim() ? "stderr: " + result.stderr.trim() : undefined,
        result.stdout?.trim() ? "stdout: " + result.stdout.trim() : undefined
      ].filter(Boolean).join("; ")
    };
  }
  if (!isPublishedExecutable(stagingPath)) {
    return {
      ok: false,
      detail: "compiler: " + compilerPath + "; the compiler reported success but produced no usable image at " +
        stagingPath
    };
  }
  return { ok: true };
}

/**
 * Returns the path to a built fake-claude.exe, building it once across every
 * concurrent caller. Safe to call from any number of processes at any time.
 */
export function ensureFakeClaude(options = {}) {
  return buildFakeClaude(options).exePath;
}

/**
 * The same build, reporting whether *this* caller was the one that compiled.
 *
 * Exactly one concurrent caller may answer `compiled: true`; everyone else
 * waits for that build and observes the published result. The concurrency
 * regression asserts precisely that, which is what makes it deterministic
 * rather than dependent on catching a narrow window.
 */
export function buildFakeClaude({
  exePath = FAKE_CLAUDE_EXE,
  sourcePath = FAKE_CLAUDE_SOURCE,
  compilerPath,
  env = process.env,
  timeoutMs = BUILD_WAIT_TIMEOUT_MS,
  now = Date.now
} = {}) {
  if (isPublishedExecutable(exePath)) return { exePath, compiled: false };

  const lockPath = lockPathFor(exePath);
  const compiler = compilerPath || findCsc(env);
  const deadline = now() + timeoutMs;
  let lastCompileFailure;

  mkdirSync(path.dirname(exePath), { recursive: true });

  while (now() < deadline) {
    if (isPublishedExecutable(exePath)) return { exePath, compiled: false };

    if (acquireLock(lockPath, now)) {
      try {
        // Another builder may have published while we were taking the lock.
        if (isPublishedExecutable(exePath)) return { exePath, compiled: false };

        const stagingPath = stagingPathFor(exePath);
        try {
          const built = compileTo(stagingPath, { sourcePath, compilerPath: compiler });
          if (!built.ok) {
            lastCompileFailure = built.detail;
            // A failed compile publishes nothing, so the path stays absent and
            // is never mistaken for a usable build.
            break;
          }
          renameSync(stagingPath, exePath);
          return { exePath, compiled: true };
        } catch (error) {
          // A rename can lose to a concurrent publisher, or to a reader still
          // holding the old image on Windows. Either way the question is only
          // whether a valid artifact now exists.
          if (isPublishedExecutable(exePath)) return { exePath, compiled: false };
          lastCompileFailure = "publication failed: " + (error?.code || "") + " " + (error?.message || error);
          break;
        } finally {
          try {
            rmSync(stagingPath, { force: true });
          } catch {
            // Best effort; a stray staging file is never executed by anyone.
          }
        }
      } finally {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // A lock we cannot remove is broken by the next waiter's staleness check.
        }
      }
    }

    const owner = readLockOwner(lockPath);
    if (owner && ownerIsGone(owner, now())) {
      breakStaleLock(lockPath, owner);
      continue;
    }
    sleepSync(POLL_INTERVAL_MS);
  }

  if (isPublishedExecutable(exePath)) return { exePath, compiled: false };
  const owner = readLockOwner(lockPath);
  assert.fail(
    "Failed to build FakeClaude at " + exePath + ". " +
    (lastCompileFailure
      ? lastCompileFailure
      : "timed out after " + timeoutMs + "ms waiting for another builder" +
        (owner ? " (lock held by pid " + owner.pid + " on " + owner.host + " since " + owner.startedAt + ")" : " (no lock present)"))
  );
}

/** Test-support: every staging artifact currently beside the published path. */
export function stagingArtifactsFor(exePath = FAKE_CLAUDE_EXE) {
  const directory = path.dirname(exePath);
  const base = path.basename(exePath);
  try {
    return readdirSync(directory).filter((name) => name.startsWith(base + ".") && name.endsWith(".staging"));
  } catch {
    return [];
  }
}

/** Test-support: the lock path, so a regression can plant a stale one. */
export function buildLockPathFor(exePath = FAKE_CLAUDE_EXE) {
  return lockPathFor(exePath);
}
