import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { delegateAgent } from "../src/delegate-agent.mjs";
import { ReviewReceiptStore } from "../src/review/receipt-store.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";

/**
 * One directory, two spellings.
 *
 * Custody records the canonical repository root - the realpath - because that
 * is the only spelling two coordinators are guaranteed to agree on. A process
 * identity that names some other spelling of the same directory is therefore
 * not "the same thing written differently" as far as the durable record is
 * concerned: it is an identity for a repository this reservation was not
 * granted for, and the validator refuses it. That refusal is the point. Two
 * spellings resolving to one directory is exactly how a second writer could
 * otherwise satisfy custody it never held.
 *
 * The distinction is invisible on a developer machine whose temp path needs no
 * aliasing, and highly visible on a GitHub Windows runner, where os.tmpdir()
 * is the 8.3 short form (C:\\Users\\RUNNER~1\\...) of a long user directory.
 * A junction reproduces that shape deterministically here, so the contract is
 * pinned by a local test rather than by a remote runner.
 */

let nextPid = 74_000;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + (result.stderr || result.stdout));
  return result.stdout.trim();
}

/**
 * Creates an alias whose realpath is a different string. Junctions need no
 * elevation, but an environment that refuses them cannot host this test, so it
 * reports that rather than pretending to have proven something.
 */
function makeAlias(target, alias) {
  if (process.platform !== "win32") return false;
  const result = spawnSync("cmd", ["/c", "mklink", "/J", alias, target], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return false;
  try {
    return realpathSync(alias) !== alias;
  } catch {
    return false;
  }
}

async function withAliasedRepository(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-agents-aliased-"));
  const repository = path.join(root, "real-repository");
  const alias = path.join(root, "aliased-repository");
  const stateRoot = path.join(root, "state");
  try {
    await mkdir(repository, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Aliased Workspace Test"]);
    git(repository, ["config", "user.email", "aliased@example.invalid"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    git(repository, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(repository, "bug.js"), "export const answer = 41;\n", "utf8");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-m", "A"]);
    git(repository, ["branch", "base"]);
    await writeFile(path.join(repository, "bug.js"), "export const answer = 42;\n", "utf8");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-m", "B"]);

    if (!makeAlias(repository, alias)) {
      return { skipped: "this environment cannot create a directory junction" };
    }
    // The premise: the alias really is a different string that resolves to the
    // same directory. Without that, the test proves nothing.
    assert.notEqual(alias, realpathSync(alias));
    const canonical = (await resolveCanonicalWorkspaceRoot(alias)).repositoryRoot;
    assert.notEqual(canonical, alias, "the canonical root must differ from the alias");

    await callback({ repository, alias, canonical, stateRoot });
    return { skipped: false };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }).catch(() => {});
  }
}

/** A reviewer whose identity names `repositoryRoot`, chosen by the caller. */
function reviewerNaming(repositoryRootFor, captured) {
  return async ({ executionId, repositoryRoot, onChildStarted }) => {
    captured.handed.push(repositoryRoot);
    const pid = nextPid++;
    const child = new EventEmitter();
    child.pid = pid;
    const identity = Object.freeze({
      executionId,
      agentType: "code-review",
      repositoryRoot: repositoryRootFor(repositoryRoot),
      pid,
      startTime: String(pid * 100),
      source: "aliased-workspace-test",
      child,
      startedAt: 1
    });
    await onChildStarted?.(identity, {});
    return {
      result: "REVIEW FINDINGS: inspected via an aliased path.",
      durationMs: 5,
      processStarted: true,
      processIdentity: identity,
      terminalProof: Object.freeze({
        processIdentity: identity,
        event: "close",
        code: 0,
        signal: null,
        observedAt: 2
      })
    };
  };
}

async function reviewThrough(cwd, stateRoot, repositoryRootFor) {
  const captured = { handed: [] };
  const outcome = await delegateAgent(
    {
      agentType: "code-review",
      task: "review the committed delta through an aliased path",
      cwd,
      targetRef: "refs/heads/base"
    },
    {
      env: {},
      writeCustody: new DurableWriteCustodyManager({ stateRoot }),
      receiptStore: new ReviewReceiptStore({ stateRoot }),
      runAgent: reviewerNaming(repositoryRootFor, captured)
    }
  );
  return { outcome, captured };
}

test("a committed review entered through an aliased path still binds", async () => {
  const result = await withAliasedRepository(async ({ alias, canonical, stateRoot }) => {
    // The runner is handed the canonical root and names it, exactly as the real
    // runner does. Custody granted for that root accepts that identity.
    const { outcome, captured } = await reviewThrough(alias, stateRoot, (handed) => handed);
    assert.deepEqual(captured.handed, [canonical], "the runner must be handed the canonical root");
    assert.equal(
      outcome.reviewBinding.status,
      "bound",
      JSON.stringify(outcome.reviewBinding.reasons)
    );
    assert.match(outcome.reviewBinding.reviewId, /^rr1:[0-9a-f]{64}$/u);
  });
  if (result.skipped) console.log("skipped: " + result.skipped);
});

test("an identity naming a different spelling of the same directory is still refused", async () => {
  const result = await withAliasedRepository(async ({ alias, canonical, stateRoot }) => {
    // The identity names the alias while custody was granted for the canonical
    // root. Both paths reach the same directory, and that is precisely why this
    // must not be accepted: the durable record and the identity would be
    // agreeing about a repository they spell differently, which is how a second
    // writer could satisfy custody it never held.
    const { outcome } = await reviewThrough(alias, stateRoot, () => alias);
    assert.notEqual(alias, canonical);
    assert.equal(outcome.reviewBinding.status, "unavailable");
    const reasons = outcome.reviewBinding.reasons.map((reason) => reason.code);
    assert.ok(reasons.includes("coherent_admission_lifecycle_failed"), reasons.join(","));
    const detail = outcome.reviewBinding.reasons.find(
      (reason) => reason.code === "coherent_admission_lifecycle_failed"
    )?.detail;
    assert.equal(detail, "write_custody_process_identity_invalid");

    // The review itself still ran and still returned its findings: an identity
    // refusal withholds the durable claim, it never fabricates a result.
    assert.equal(outcome.status, "completed");
    assert.match(outcome.result, /REVIEW FINDINGS/u);
    assert.equal(outcome.reviewBinding.reviewId, undefined);
  });
  if (result.skipped) console.log("skipped: " + result.skipped);
});
