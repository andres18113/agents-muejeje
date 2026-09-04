import { existsSync, statSync, writeFileSync } from "node:fs";
import { buildFakeClaude } from "./fake-claude-build.mjs";

/**
 * One independent process asking for FakeClaude, used by the concurrency
 * regression.
 *
 * Every probe announces itself and then blocks on a release file the parent
 * writes only once all of them have announced. That is a real barrier, so the
 * processes contend for the build at genuinely the same moment rather than
 * being spread out by however long each took to boot. Nothing here sleeps for
 * a fixed guess.
 *
 * Prints `OK <path> <size> compiled=<bool>` and exits 0, or `ERR <message>`
 * and exits 1. The compiled flag is what lets the parent prove that exactly
 * one of them owned the build.
 */
const [barrierDirectory, index, exePath] = process.argv.slice(2);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

writeFileSync(barrierDirectory + "/ready-" + index, "ready", "utf8");

const releaseDeadline = Date.now() + 60_000;
while (!existsSync(barrierDirectory + "/go") && Date.now() < releaseDeadline) {
  sleepSync(5);
}

try {
  const built = buildFakeClaude(exePath ? { exePath } : {});
  process.stdout.write(
    "OK " + built.exePath + " " + statSync(built.exePath).size + " compiled=" + built.compiled + "\n"
  );
} catch (error) {
  process.stdout.write("ERR " + (error?.message || String(error)).replaceAll("\n", " ") + "\n");
  process.exitCode = 1;
}
