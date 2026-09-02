import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectChangeSet } from "../src/changeset/collector.mjs";
import { NO_REVIEW_TARGET, reviewTargetSpec } from "../src/changeset/target.mjs";
import { evaluateFreshness } from "../src/review/freshness.mjs";
import { ReviewReceiptStore } from "../src/review/receipt-store.mjs";
import { validateReviewReceipt } from "../src/review/receipt-schema.mjs";
import { DurableWriteCustodyManager } from "../src/write-custody.mjs";
import { delegateAgent, formatDelegateAgentOutcome } from "../src/delegate-agent.mjs";
import { resolveCanonicalWorkspaceRoot } from "../src/workspace-root.mjs";
import { resolveRepositoryCoordinationIdentity } from "../src/worktree-manager.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + (result.stderr || result.stdout));
  return result.stdout.trim();
}

function gitAllowingFailure(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
}

/**
 * A real repository in a real temporary directory. realpath because os.tmpdir()
 * can hand back an 8.3 alias on Windows while Git reports the long form.
 */
async function withRepository(callback, { initialCommit = true } = {}) {
  const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-agents-changeset-")));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const stateRoot = path.join(fixtureRoot, "state");
  try {
    await mkdir(repositoryRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "user.email", "tests@example.invalid"]);
    git(repositoryRoot, ["config", "user.name", "Phase Six Tests"]);
    git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
    if (initialCommit) {
      await writeFile(path.join(repositoryRoot, "tracked.txt"), "base\n", "utf8");
      git(repositoryRoot, ["add", "tracked.txt"]);
      git(repositoryRoot, ["commit", "-m", "fixture base"]);
    }
    await callback({ fixtureRoot, repositoryRoot, stateRoot });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

async function collect(repositoryRoot, { targetSpec = NO_REVIEW_TARGET, cwd } = {}) {
  const workspace = await resolveCanonicalWorkspaceRoot(cwd || repositoryRoot);
  return collectChangeSet(
    {
      effectiveCwd: workspace.effectiveCwd,
      rootSource: workspace.rootSource,
      canonicalRepositoryKey: workspace.canonicalRepositoryKey,
      targetSpec
    },
    { readOwnership: async () => undefined }
  );
}

async function identityOf(result) {
  assert.equal(result.status, "exact",
    "expected an exact collection, got " + JSON.stringify(result.reasons));
  return result.changeSetId;
}

test("a clean repository collects exactly and reproducibly", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const first = await identityOf(await collect(repositoryRoot));
    const second = await identityOf(await collect(repositoryRoot));
    assert.equal(first, second);
  });
});

test("editing a tracked file changes the identity, and restoring the bytes restores it", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const tracked = path.join(repositoryRoot, "tracked.txt");
    const clean = await identityOf(await collect(repositoryRoot));

    await writeFile(tracked, "modified\n", "utf8");
    const dirty = await identityOf(await collect(repositoryRoot));
    assert.notEqual(dirty, clean);

    await writeFile(tracked, "base\n", "utf8");
    assert.equal(await identityOf(await collect(repositoryRoot)), clean);
  });
});

test("staging a modification is distinct from both clean and unstaged", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const clean = await identityOf(await collect(repositoryRoot));
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "modified\n", "utf8");
    const unstaged = await identityOf(await collect(repositoryRoot));

    git(repositoryRoot, ["add", "tracked.txt"]);
    const staged = await identityOf(await collect(repositoryRoot));

    assert.notEqual(staged, clean);
    assert.notEqual(staged, unstaged);
  });
});

test("an untracked file changes the identity, and deleting it restores the original", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const clean = await identityOf(await collect(repositoryRoot));
    const extra = path.join(repositoryRoot, "notes.txt");

    await writeFile(extra, "hello\n", "utf8");
    assert.notEqual(await identityOf(await collect(repositoryRoot)), clean);

    await unlink(extra);
    assert.equal(await identityOf(await collect(repositoryRoot)), clean);
  });
});

test("ignored files sit outside the change set", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, ".gitignore"), "secret.txt\n", "utf8");
    git(repositoryRoot, ["add", ".gitignore"]);
    git(repositoryRoot, ["commit", "-m", "ignore secrets"]);

    const before = await identityOf(await collect(repositoryRoot));
    await writeFile(path.join(repositoryRoot, "secret.txt"), "shhh\n", "utf8");
    assert.equal(await identityOf(await collect(repositoryRoot)), before,
      "an ignored file is outside the subject");
  });
});

test("deleting a tracked file is recorded with no content digest", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const clean = await identityOf(await collect(repositoryRoot));
    await unlink(path.join(repositoryRoot, "tracked.txt"));

    const result = await collect(repositoryRoot);
    assert.equal(result.status, "exact");
    assert.notEqual(result.changeSetId, clean);
    const deleted = result.descriptor.worktree.find((entry) => entry.path.v === "tracked.txt");
    assert.equal(deleted.y, "D");
    assert.equal(deleted.content, null);
  });
});

test("awkward filenames survive collection intact", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    // '?' is a valid Git path byte but not a valid Win32 filename. The pure
    // porcelain-parser suite covers it byte-for-byte; this real-filesystem
    // case exercises every awkward name the host can actually create.
    const names = [
      "a file with spaces.txt",
      "hash#name.txt",
      ...(process.platform === "win32" ? [] : ["question?name.txt"]),
      "bang!name.txt"
    ];
    for (const name of names) {
      await writeFile(path.join(repositoryRoot, name), "x\n", "utf8");
    }
    const result = await collect(repositoryRoot);
    assert.equal(result.status, "exact");
    const collected = result.descriptor.untracked.map((entry) => entry.path.v).sort();
    assert.deepEqual(collected, [...names].sort());
  });
});

test("a merge conflict collects exactly, with all three stages recorded", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const file = path.join(repositoryRoot, "tracked.txt");

    git(repositoryRoot, ["checkout", "-b", "left"]);
    await writeFile(file, "left\n", "utf8");
    git(repositoryRoot, ["commit", "-am", "left change"]);

    git(repositoryRoot, ["checkout", "main"]);
    git(repositoryRoot, ["checkout", "-b", "right"]);
    await writeFile(file, "right\n", "utf8");
    git(repositoryRoot, ["commit", "-am", "right change"]);

    const merge = gitAllowingFailure(repositoryRoot, ["merge", "left"]);
    assert.notEqual(merge.status, 0, "the fixture must actually conflict");

    const result = await collect(repositoryRoot);
    assert.equal(result.status, "exact");
    const conflicted = result.descriptor.unmerged.find((entry) => entry.path.v === "tracked.txt");
    assert.ok(conflicted, "the conflicted path must be represented");
    assert.match(conflicted.oid1, /^[0-9a-f]{40}$/u);
    assert.match(conflicted.oid2, /^[0-9a-f]{40}$/u);
    assert.match(conflicted.oid3, /^[0-9a-f]{40}$/u);
    assert.match(conflicted.content, /^[0-9a-f]{64}$/u, "conflicted worktree bytes are hashed");
  });
});

test("an unborn HEAD collects exactly", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, "first.txt"), "x\n", "utf8");
    const result = await collect(repositoryRoot);
    assert.equal(result.status, "exact");
    assert.equal(result.descriptor.head.unborn, true);
    assert.equal(result.descriptor.head.commit, null);
  }, { initialCommit: false });
});

test("a subdirectory cwd and a differently-cased drive letter produce one identity", async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const nested = path.join(repositoryRoot, "src", "deep");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "file.txt"), "x\n", "utf8");

    const fromRoot = await identityOf(await collect(repositoryRoot));
    const fromNested = await identityOf(await collect(repositoryRoot, { cwd: nested }));
    assert.equal(fromNested, fromRoot, "cwd depth must not change the subject");

    if (process.platform === "win32" && /^[a-zA-Z]:/u.test(repositoryRoot)) {
      const flipped = repositoryRoot[0] === repositoryRoot[0].toUpperCase()
        ? repositoryRoot[0].toLowerCase() + repositoryRoot.slice(1)
        : repositoryRoot[0].toUpperCase() + repositoryRoot.slice(1);
      assert.equal(await identityOf(await collect(repositoryRoot, { cwd: flipped })), fromRoot);
    }
  });
});

test("a linked worktree shares one coordination identity with the main checkout", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot }) => {
    const linked = path.join(fixtureRoot, "linked");
    git(repositoryRoot, ["worktree", "add", "--detach", linked, "HEAD"]);

    const result = await collect(linked);
    assert.equal(result.status, "exact");
    assert.equal(result.descriptor.summary.detached, true);

    // Receipts and admission must land on one slot for both spellings, or a
    // review in a linked worktree would exclude nobody.
    const mainIdentity = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(repositoryRoot)
    );
    const linkedIdentity = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(linked)
    );
    assert.equal(linkedIdentity.canonicalRepositoryKey, mainIdentity.canonicalRepositoryKey);
  });
});

// --- target movement through the real runtime ------------------------------

async function withRemote(repositoryRoot, fixtureRoot) {
  const remote = path.join(fixtureRoot, "remote.git");
  git(fixtureRoot, ["init", "--bare", "-b", "main", remote]);
  git(repositoryRoot, ["remote", "add", "origin", remote]);
  git(repositoryRoot, ["push", "origin", "main"]);
  git(repositoryRoot, ["fetch", "origin"]);
  return remote;
}

test("a target that advances makes an untouched worktree STALE, and only the target changed", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot }) => {
    const remote = await withRemote(repositoryRoot, fixtureRoot);
    const targetSpec = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });

    const before = await collect(repositoryRoot, { targetSpec });
    assert.equal(before.status, "exact");

    // Advance the remote from a second clone, then fetch. The worktree here is
    // never touched, so only the target can have moved.
    const other = path.join(fixtureRoot, "other");
    git(fixtureRoot, ["clone", remote, other]);
    git(other, ["config", "user.email", "tests@example.invalid"]);
    git(other, ["config", "user.name", "Phase Six Tests"]);
    await writeFile(path.join(other, "remote-change.txt"), "x\n", "utf8");
    git(other, ["add", "remote-change.txt"]);
    git(other, ["commit", "-m", "advance"]);
    git(other, ["push", "origin", "main"]);
    git(repositoryRoot, ["fetch", "origin"]);

    const after = await collect(repositoryRoot, { targetSpec });
    assert.equal(after.status, "exact");
    assert.notEqual(after.changeSetId, before.changeSetId);

    const changed = Object.keys(before.sections).filter((name) => before.sections[name] !== after.sections[name]);
    assert.deepEqual(changed, ["target"], "nothing but the target may have moved");
  });
});

test("a deleted target is exact and unresolved, not indeterminate", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot }) => {
    await withRemote(repositoryRoot, fixtureRoot);
    const targetSpec = reviewTargetSpec({ ref: "refs/remotes/origin/main", source: "request" });
    const before = await collect(repositoryRoot, { targetSpec });

    git(repositoryRoot, ["remote", "remove", "origin"]);
    git(repositoryRoot, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const after = await collect(repositoryRoot, { targetSpec });
    assert.equal(after.status, "exact");
    assert.equal(after.descriptor.target.resolution, "unresolved");
    assert.notEqual(after.changeSetId, before.changeSetId);
  });
});

test("two different declared targets over one repository state are different subjects", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot }) => {
    await withRemote(repositoryRoot, fixtureRoot);
    git(repositoryRoot, ["branch", "release"]);

    const one = await collect(repositoryRoot, {
      targetSpec: reviewTargetSpec({ ref: "refs/heads/main", source: "request" })
    });
    const two = await collect(repositoryRoot, {
      targetSpec: reviewTargetSpec({ ref: "refs/heads/release", source: "request" })
    });
    assert.notEqual(await identityOf(one), await identityOf(two));
  });
});

test("branch.upstream is never used to invent a target", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot }) => {
    await withRemote(repositoryRoot, fixtureRoot);
    git(repositoryRoot, ["branch", "--set-upstream-to=origin/main", "main"]);

    const result = await collect(repositoryRoot);
    assert.equal(result.status, "exact");
    assert.equal(result.descriptor.target.spec.kind, "none",
      "an upstream is not a declared review target");
  });
});

test("a symlink is collected as a symlink where the platform permits one", async (t) => {
  await withRepository(async ({ repositoryRoot }) => {
    try {
      await symlink(path.join(repositoryRoot, "tracked.txt"), path.join(repositoryRoot, "link.txt"));
    } catch (error) {
      // Windows without Developer Mode cannot create one; that is a missing
      // privilege, not a defect.
      t.skip("symlink creation unavailable: " + error.code);
      return;
    }
    const result = await collect(repositoryRoot);
    assert.equal(result.status, "exact");
    const link = result.descriptor.untracked.find((entry) => entry.path.v === "link.txt");
    assert.ok(link);
  });
});

// --- end to end through delegateAgent, with a fake runner ------------------

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 30_000 + Math.floor(Math.random() * 1_000);
  child.kill = () => true;
  return child;
}

function custodyFor(stateRoot) {
  return new DurableWriteCustodyManager({
    stateRoot,
    currentPid: process.pid,
    inspectProcess: async (pid) => ({
      status: "alive",
      identity: { pid, startTime: String(pid * 100), source: "integration-identity" }
    })
  });
}

/**
 * Mirrors production ordering: the runner reports its child before it can
 * report a result, so durable ownership is always established first.
 */
function completedRunner({ beforeReturn } = {}) {
  return async (argumentsForRunner) => {
    const child = fakeChild();
    const processIdentity = Object.freeze({
      executionId: argumentsForRunner.executionId,
      agentType: argumentsForRunner.agentType,
      repositoryRoot: argumentsForRunner.repositoryRoot,
      pid: child.pid,
      startTime: String(child.pid * 100),
      source: "integration-identity",
      child,
      startedAt: 1
    });
    await argumentsForRunner.onChildStarted?.(processIdentity);
    if (beforeReturn) await beforeReturn(argumentsForRunner);
    return {
      result: "no findings",
      stderrSummary: "",
      durationMs: 5,
      processStarted: true,
      processIdentity,
      terminalProof: Object.freeze({
        processIdentity, event: "close", code: 0, signal: null, observedAt: 2
      })
    };
  };
}

async function review(repositoryRoot, stateRoot, options = {}) {
  return delegateAgent(
    { agentType: "code-review", task: "review the change set", cwd: repositoryRoot, ...options.input },
    {
      writeCustody: custodyFor(stateRoot),
      runAgent: options.runAgent || completedRunner(),
      env: {},
      ...options.dependencies
    }
  );
}

test("a stable review binds a receipt that validates on disk", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const outcome = await review(repositoryRoot, stateRoot);

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reviewBinding.status, "bound");
    assert.equal(outcome.reviewBinding.coherence, "held");
    assert.match(outcome.reviewBinding.changeSetId, /^cs1:[0-9a-f]{64}$/u);

    const formatted = formatDelegateAgentOutcome(outcome);
    assert.match(formatted, /ReviewBinding: bound/u);
    assert.match(formatted, /ReviewCoherence: held/u);
    assert.match(formatted, /ReviewId: rr1:/u);

    const receipts = await new ReviewReceiptStore({ stateRoot }).listForChangeSet({
      canonicalRootKey: (await resolveRepositoryCoordinationIdentity(
        await resolveCanonicalWorkspaceRoot(repositoryRoot)
      )).canonicalRepositoryKey,
      changeSetId: outcome.reviewBinding.changeSetId
    });
    assert.equal(receipts.receipts.length, 1);
    assert.ok(validateReviewReceipt(receipts.receipts[0]));
    assert.equal(receipts.receipts[0].reviewId, outcome.reviewBinding.reviewId);
  });
});

test("an unchanged repository reports its prior review as FRESH", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const first = await review(repositoryRoot, stateRoot);
    const second = await review(repositoryRoot, stateRoot);

    assert.equal(second.reviewBinding.status, "bound");
    assert.equal(second.reviewBinding.priorReviews.length, 1);
    assert.equal(second.reviewBinding.priorReviews[0].verdict, "FRESH");
    assert.equal(second.reviewBinding.priorReviews[0].reviewId, first.reviewBinding.reviewId);
  });
});

test("after the repository changes, the earlier review is discovered and reported STALE", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const first = await review(repositoryRoot, stateRoot);
    assert.equal(first.reviewBinding.status, "bound");

    // The repository moves on. A lookup keyed by the current change set could
    // never find this receipt; scope discovery is what makes STALE reachable.
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "changed\n", "utf8");

    const second = await review(repositoryRoot, stateRoot);
    assert.equal(second.reviewBinding.status, "bound");
    assert.notEqual(second.reviewBinding.changeSetId, first.reviewBinding.changeSetId);

    const prior = second.reviewBinding.priorReviews.find(
      (entry) => entry.reviewId === first.reviewBinding.reviewId
    );
    assert.ok(prior, "the earlier receipt must still be discoverable");
    assert.equal(prior.verdict, "STALE");
    assert.deepEqual(prior.changedSections, ["worktree"]);

    assert.match(formatDelegateAgentOutcome(second), /ReceiptHistoryStatus: complete/u);
    assert.match(formatDelegateAgentOutcome(second), /PriorReviews: \d+/u);
  });
});

test("a target that moves makes an earlier review STALE through the real runtime", async () => {
  await withRepository(async ({ fixtureRoot, repositoryRoot, stateRoot }) => {
    const remote = await withRemote(repositoryRoot, fixtureRoot);
    const input = { targetRef: "refs/remotes/origin/main" };

    const first = await review(repositoryRoot, stateRoot, { input });
    assert.equal(first.reviewBinding.status, "bound");

    const other = path.join(fixtureRoot, "other");
    git(fixtureRoot, ["clone", remote, other]);
    git(other, ["config", "user.email", "tests@example.invalid"]);
    git(other, ["config", "user.name", "Phase Six Tests"]);
    await writeFile(path.join(other, "advance.txt"), "x\n", "utf8");
    git(other, ["add", "advance.txt"]);
    git(other, ["commit", "-m", "advance"]);
    git(other, ["push", "origin", "main"]);
    git(repositoryRoot, ["fetch", "origin"]);

    const second = await review(repositoryRoot, stateRoot, { input });
    const prior = second.reviewBinding.priorReviews.find(
      (entry) => entry.reviewId === first.reviewBinding.reviewId
    );
    assert.ok(prior, "the same review scope must still find the earlier receipt");
    assert.equal(prior.verdict, "STALE");
    assert.deepEqual(prior.changedSections, ["target"],
      "the worktree never moved; only the declared target did");
  });
});

test("a review whose workspace changes mid-review is unbound and stores nothing", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const outcome = await review(repositoryRoot, stateRoot, {
      runAgent: completedRunner({
        beforeReturn: async () => {
          await writeFile(path.join(repositoryRoot, "sneaky.txt"), "x\n", "utf8");
        }
      })
    });

    assert.equal(outcome.status, "completed", "the review text is still returned");
    assert.equal(outcome.reviewBinding.status, "unbound");
    assert.deepEqual(outcome.reviewBinding.reasons.map((r) => r.code), ["workspace_mutated_during_review"]);
    assert.notEqual(outcome.reviewBinding.beforeChangeSetId, outcome.reviewBinding.afterChangeSetId);

    const reviewsRoot = path.join(stateRoot, "repositories");
    const repositories = await readdir(reviewsRoot);
    for (const repository of repositories) {
      const entries = await readdir(path.join(reviewsRoot, repository));
      assert.equal(entries.includes("reviews"), false, "an unbound review must persist nothing");
    }
  });
});

test("a review denied coherent admission still runs, advisory and unbound", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    const workspace = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(repositoryRoot)
    );
    // A managed writer already holds the one slot.
    await custody.reserveWriteAccess({
      executionId: "writer-holding",
      agentType: "general-purpose",
      canonicalRoot: workspace.repositoryRoot,
      canonicalRootKey: workspace.canonicalRepositoryKey
    });

    const outcome = await delegateAgent(
      { agentType: "code-review", task: "review", cwd: repositoryRoot },
      { writeCustody: custody, runAgent: completedRunner(), env: {} }
    );

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.result, "no findings");
    assert.equal(outcome.reviewBinding.coherence, "denied");
    assert.equal(outcome.reviewBinding.status, "unavailable");
    assert.ok(outcome.reviewBinding.reasons.some((r) => r.code === "coherent_admission_denied"));
  });
});

test("the review subject reaches the reviewer prompt with honest coherence wording", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "changed\n", "utf8");
    let prompt;
    await review(repositoryRoot, stateRoot, {
      runAgent: async (argumentsForRunner) => {
        prompt = argumentsForRunner.prompt;
        return completedRunner()(argumentsForRunner);
      }
    });

    assert.match(prompt, /REVIEW SUBJECT/u);
    assert.match(prompt, /ChangeSetId: cs1:/u);
    assert.match(prompt, /\.M tracked\.txt/u);
    assert.match(prompt, /Coherent review admission is currently held/u);
    assert.doesNotMatch(prompt, /held for the whole review/iu);
  });
});

test("the kill switch restores Phase 5 review behaviour exactly", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const outcome = await delegateAgent(
      { agentType: "code-review", task: "review", cwd: repositoryRoot },
      {
        writeCustody: custodyFor(stateRoot),
        runAgent: completedRunner(),
        env: { CLAUDE_AGENTS_REVIEW_BINDING: "off" }
      }
    );

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reviewBinding, undefined);
    assert.equal(outcome.custodyState, "not-applicable");
    assert.doesNotMatch(formatDelegateAgentOutcome(outcome), /ReviewBinding/u);
  });
});

test("a general-purpose target ref is recorded and inherited by a review of its worktree", async () => {
  await withRepository(async ({ repositoryRoot, stateRoot }) => {
    const custody = custodyFor(stateRoot);
    const workspace = await resolveRepositoryCoordinationIdentity(
      await resolveCanonicalWorkspaceRoot(repositoryRoot)
    );

    await custody.reserveWriteAccess({
      executionId: "worker-1",
      agentType: "general-purpose",
      canonicalRoot: workspace.repositoryRoot,
      canonicalRootKey: workspace.canonicalRepositoryKey,
      targetRef: "refs/heads/main"
    });
    const held = await custody.getWriteAccess(workspace.canonicalRepositoryKey);
    assert.equal(held.targetRef, "refs/heads/main");

    // Release so a review can take the slot; the archived record keeps the ref.
    await custody.releaseUnstartedWriteAccess({
      executionId: "worker-1",
      canonicalRootKey: workspace.canonicalRepositoryKey
    });

    const { resolveReviewTargetSpec } = await import("../src/review/target-provenance.mjs");
    const inherited = await resolveReviewTargetSpec({
      requestedTargetRef: undefined,
      effectiveCwd: custody.worktreeRootFor({
        canonicalRootKey: workspace.canonicalRepositoryKey,
        executionId: "worker-1"
      }),
      repositoryStateDirectory: custody.repositoryStateDirectory(workspace.canonicalRepositoryKey)
    });
    assert.deepEqual({ ...inherited }, {
      kind: "ref",
      ref: "refs/heads/main",
      source: "worktree-metadata"
    });
  });
});
