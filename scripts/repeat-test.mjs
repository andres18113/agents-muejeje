import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Runs one test file repeatedly, keeping every iteration's evidence.
 *
 * This exists because a one-off file-level failure was lost. A repeat loop had
 * redirected all its iterations to a single log, so the run that failed was
 * overwritten by the next one, and the only surviving trace was what happened
 * to be on screen: five passing tests, then the file itself failing with
 * `'test failed'` and nothing else. That is the least diagnosable form a
 * failure can take - `node --test` reports a file-level failure identically
 * whether the child exited non-zero silently, threw after the last test, or
 * was killed by a signal - and the detail that separates them is only in the
 * TAP body and stderr of that exact run.
 *
 * So every iteration gets its own record: number, timestamps, duration, exit
 * code, signal, full TAP stdout and full stderr. The TAP reporter is used
 * deliberately - it prints `exitCode` and `signal` for the file entry, which
 * the spec reporter does not.
 *
 * Usage:
 *   node scripts/repeat-test.mjs <testFile> [iterations] [--out <dir>] [--stop-on-fail]
 */

function parseArguments(argv) {
  const positional = [];
  const options = { out: undefined, stopOnFail: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      options.out = argv[index + 1];
      index += 1;
    } else if (argument === "--stop-on-fail") {
      options.stopOnFail = true;
    } else {
      positional.push(argument);
    }
  }
  return { testFile: positional[0], iterations: Number(positional[1] || 100), options };
}

const { testFile, iterations, options } = parseArguments(process.argv.slice(2));

if (!testFile || !Number.isSafeInteger(iterations) || iterations < 1) {
  console.error("usage: node scripts/repeat-test.mjs <testFile> [iterations] [--out <dir>] [--stop-on-fail]");
  process.exit(2);
}

const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const outputDirectory = path.resolve(
  options.out || path.join("run-logs", path.basename(testFile, ".test.mjs") + "-" + stamp)
);
await mkdir(outputDirectory, { recursive: true });

function runOnce(iteration) {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    ["--test", "--test-reporter=tap", testFile],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on("close", (exitCode, signal) => {
      resolve({
        iteration,
        testFile,
        startedAtIso: new Date(startedAt).toISOString(),
        finishedAtIso: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        exitCode,
        signal,
        pid: child.pid,
        stdout,
        stderr
      });
    });
  });
}

const width = String(iterations).length;
const failures = [];
let passed = 0;

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const record = await runOnce(iteration);
  const ok = record.exitCode === 0 && !record.signal;
  const name = "iteration-" + String(iteration).padStart(width, "0") + (ok ? "" : "-FAIL") + ".json";
  const recordPath = path.join(outputDirectory, name);
  // Written for every iteration, passing or not: a failure is only
  // interpretable next to the runs that surrounded it.
  await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");

  if (ok) {
    passed += 1;
  } else {
    failures.push({ iteration, exitCode: record.exitCode, signal: record.signal, recordPath });
    console.error(
      "FAIL iteration " + iteration + " exitCode=" + record.exitCode +
      " signal=" + record.signal + " record=" + recordPath
    );
    if (options.stopOnFail) break;
  }
}

const summary = { testFile, iterations, passed, failed: failures.length, outputDirectory, failures };
await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(
  "repeat-test " + testFile + ": pass=" + passed + " fail=" + failures.length +
  " of " + iterations + "; records in " + outputDirectory
);
process.exitCode = failures.length === 0 ? 0 : 1;
