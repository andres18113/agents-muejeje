import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAKE_CLAUDE_EXE,
  FAKE_CLAUDE_SOURCE,
  buildFakeClaude,
  buildLockPathFor,
  ensureFakeClaude,
  isPublishedExecutable,
  stagingArtifactsFor
} from "./fixtures/fake-claude-build.mjs";

/**
 * The FakeClaude build is shared mutable state between parallel test workers.
 *
 * fake-claude.exe is git-ignored, so a fresh checkout - every CI run - starts
 * without it, and six test files need it. Each used to run its own
 * `if (!existsSync) spawnSync(csc, "/out:" + exe)`, which is check-then-act
 * across processes: deleting the artifact and running those six files together
 * failed about one run in three, with the compiler reporting failure and no
 * output to explain it.
 *
 * These tests drive the real builder with real concurrent processes. They work
 * on a throwaway path rather than on tests/fixtures/fake-claude.exe itself,
 * because `node --test` runs this file alongside the six that execute that
 * artifact - deleting it underneath them would trade one race for another. The
 * code exercised is identical; only the published path differs. The stress
 * against the real deleted artifact belongs to the repeat harness, not here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "fixtures", "fake-claude-build-probe.mjs");

async function withBuildRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-claude-build-"));
  try {
    await callback({ root, exePath: path.join(root, "fake-claude.exe") });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

/** A PID that certainly belongs to nobody: a process we watched exit. */
function retiredPid() {
  const finished = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.equal(finished.status, 0);
  return finished.pid;
}

/**
 * Runs `count` independent probe processes that all block until every one of
 * them is ready, then release together.
 */
async function raceProbes(count, { root, exePath }) {
  const barrier = path.join(root, "barrier");
  await rm(barrier, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(barrier, { recursive: true });

  const children = Array.from({ length: count }, (_, index) => {
    const child = spawn(process.execPath, [probe, barrier, String(index), exePath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return new Promise((resolve) => {
      child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
  });

  // Release only once every probe has announced, so they contend at once.
  const readyDeadline = Date.now() + 60_000;
  while (readdirSync(barrier).filter((name) => name.startsWith("ready-")).length < count) {
    assert.ok(Date.now() < readyDeadline, "probes did not all reach the barrier");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await writeFile(path.join(barrier, "go"), "go", "utf8");

  return await Promise.all(children);
}

test("an absent artifact is built once even when many processes ask at the same moment", async () => {
  await withBuildRoot(async ({ root, exePath }) => {
    assert.equal(existsSync(exePath), false, "the race must start from a genuinely absent artifact");

    const results = await raceProbes(6, { root, exePath });

    for (const result of results) {
      assert.equal(result.code, 0, "a probe failed: " + result.stdout + " " + result.stderr);
      assert.match(result.stdout, /^OK /u, result.stdout);
    }
    // Every process was handed the same finished image.
    const images = new Set(results.map((result) => result.stdout.replace(/ compiled=\w+$/u, "")));
    assert.equal(images.size, 1, [...images].join(" | "));

    // The invariant, and the reason this regression is deterministic rather
    // than a race the test hopes to catch: one caller owns the compilation and
    // publishes it, and every other caller waits for that result. Six
    // compilers writing one output path is exactly the defect this replaced,
    // and it fails here every time rather than one run in three.
    const compilers = results.filter((result) => result.stdout.endsWith("compiled=true"));
    assert.equal(
      compilers.length,
      1,
      "exactly one process may compile; " + compilers.length + " did: " +
        results.map((result) => result.stdout).join(" | ")
    );

    assert.ok(isPublishedExecutable(exePath), "the published artifact must be a finished image");
    assert.deepEqual(stagingArtifactsFor(exePath), [], "no staging artifact may survive");
    assert.equal(existsSync(buildLockPathFor(exePath)), false, "the build lock must be released");

    // Exactly one executable, and nothing half-built beside it.
    const published = readdirSync(root).filter((name) => name.endsWith(".exe"));
    assert.deepEqual(published, ["fake-claude.exe"]);
  });
});

test("repeated concurrent rounds keep publishing exactly one valid artifact", async () => {
  await withBuildRoot(async ({ root, exePath }) => {
    for (let round = 0; round < 3; round += 1) {
      // Round 0 races from nothing; later rounds race against an artifact that
      // already exists, which is the steady state on a warm checkout.
      const results = await raceProbes(4, { root, exePath });
      for (const result of results) {
        assert.equal(result.code, 0, "round " + round + ": " + result.stdout + " " + result.stderr);
      }
      // The cold round elects exactly one compiler; every later round finds a
      // finished artifact and compiles nothing at all.
      const compilers = results.filter((result) => result.stdout.endsWith("compiled=true")).length;
      assert.equal(
        compilers,
        round === 0 ? 1 : 0,
        "round " + round + " had " + compilers + " compilers: " +
          results.map((result) => result.stdout).join(" | ")
      );
      assert.ok(isPublishedExecutable(exePath));
      assert.deepEqual(stagingArtifactsFor(exePath), []);
      assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".exe")), ["fake-claude.exe"]);
    }
  });
});

test("an already-built artifact is reused rather than compiled again", async () => {
  await withBuildRoot(async ({ exePath }) => {
    const first = buildFakeClaude({ exePath });
    assert.equal(first.compiled, true, "the cold call must be the one that compiles");
    const stamp = statSync(first.exePath).mtimeMs;

    const second = buildFakeClaude({ exePath });
    assert.equal(second.exePath, first.exePath);
    assert.equal(second.compiled, false, "a warm call must not compile");
    assert.equal(statSync(second.exePath).mtimeMs, stamp, "a warm call must not recompile");
    assert.equal(ensureFakeClaude({ exePath }), first.exePath);
  });
});

test("a compiler that fails publishes nothing and says why", async () => {
  await withBuildRoot(async ({ root, exePath }) => {
    const missingCompiler = path.join(root, "no-such-compiler.exe");
    assert.throws(
      () => ensureFakeClaude({ exePath, compilerPath: missingCompiler, timeoutMs: 30_000 }),
      (error) => {
        // The diagnostic has to name the compiler it actually tried.
        assert.match(error.message, /Failed to build FakeClaude/u);
        assert.ok(error.message.includes(missingCompiler), error.message);
        return true;
      }
    );
    // A failed build must leave nothing that a later caller could mistake for
    // a usable executable.
    assert.equal(existsSync(exePath), false, "a failed compile must publish nothing");
    assert.equal(isPublishedExecutable(exePath), false);
    assert.deepEqual(stagingArtifactsFor(exePath), [], "a failed compile must leave no staging artifact");
    assert.equal(existsSync(buildLockPathFor(exePath)), false, "a failed compile must release its lock");
  });
});

test("a lock left behind by a crashed builder is broken instead of deadlocking", async () => {
  await withBuildRoot(async ({ exePath }) => {
    const lockPath = buildLockPathFor(exePath);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: retiredPid(), startedAt: Date.now(), host: os.hostname() }),
      "utf8"
    );

    // The owner is gone, so this must not wait out the stale window: a dead
    // owner is detected by identity, not by elapsed time.
    const startedAt = Date.now();
    const built = ensureFakeClaude({ exePath, timeoutMs: 60_000 });
    const elapsed = Date.now() - startedAt;

    assert.ok(isPublishedExecutable(built));
    assert.ok(elapsed < 30_000, "breaking a dead builder's lock took " + elapsed + "ms");
    assert.equal(existsSync(lockPath), false, "the stolen lock must be released");
  });
});

test("a live builder's lock is respected rather than stolen", async () => {
  await withBuildRoot(async ({ exePath }) => {
    const lockPath = buildLockPathFor(exePath);
    // This process is alive and the lock is fresh, so a waiter must not break
    // it - it must time out instead, which is what keeps two compilers off one
    // output path.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: os.hostname() }),
      "utf8"
    );
    assert.throws(
      () => ensureFakeClaude({ exePath, timeoutMs: 300 }),
      (error) => {
        assert.match(error.message, /timed out after 300ms waiting for another builder/u);
        assert.ok(error.message.includes("lock held by pid " + process.pid), error.message);
        return true;
      }
    );
    assert.equal(existsSync(lockPath), true, "a live builder's lock must survive");
  });
});

test("a file that is not a finished image is rebuilt rather than executed", async () => {
  await withBuildRoot(async ({ exePath }) => {
    // Exactly what an interrupted `csc /out:` used to leave behind: a file at
    // the published path that is not a PE image.
    writeFileSync(exePath, "not an executable", "utf8");
    assert.equal(isPublishedExecutable(exePath), false, "existence alone is never proof of a build");

    const built = ensureFakeClaude({ exePath });
    assert.ok(isPublishedExecutable(built), "the bad artifact must be replaced by a real one");
    assert.ok(statSync(built).size > 1_000);
  });
});

test("the shared builder is the only thing that compiles FakeClaude", async () => {
  // The race came back once already because each file carried its own copy of
  // the build. Nothing but the shared builder may name the compiler again.
  const { readFile, readdir } = await import("node:fs/promises");
  const offenders = [];
  for (const name of await readdir(here)) {
    if (!name.endsWith(".test.mjs")) continue;
    const source = await readFile(path.join(here, name), "utf8");
    if (/csc\.exe|FakeClaude\.cs/u.test(source)) offenders.push("tests/" + name);
  }
  assert.deepEqual(offenders, []);

  for (const name of await readdir(path.join(here, "fixtures"))) {
    if (!name.endsWith(".mjs") || name === "fake-claude-build.mjs") continue;
    const source = await readFile(path.join(here, "fixtures", name), "utf8");
    assert.doesNotMatch(source, /csc\.exe|FakeClaude\.cs/u, "tests/fixtures/" + name);
  }

  assert.ok(existsSync(FAKE_CLAUDE_SOURCE));
  assert.equal(path.basename(FAKE_CLAUDE_EXE), "fake-claude.exe");
});
