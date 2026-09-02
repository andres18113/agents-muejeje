import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runGitCommand, buildGitEnvironment } from "../src/git-command.mjs";
import { runGit, WorktreeManagerError } from "../src/worktree-manager.mjs";

function fakeChild({ stdout = [], stderr = [], exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    for (const chunk of stdout) child.stdout.emit("data", chunk);
    for (const chunk of stderr) child.stderr.emit("data", chunk);
    child.emit("exit", exitCode, null);
    child.emit("close", exitCode, null);
  });
  return child;
}

function spawnStub(options) {
  const calls = [];
  return {
    calls,
    spawnProcess: (command, args, spawnOptions) => {
      calls.push({ command, args, spawnOptions });
      return fakeChild(options);
    }
  };
}

test("buffer mode returns exact bytes, untrimmed, including embedded NULs", async () => {
  const payload = Buffer.from("  1 .M N... 100644 100644 100644 aaa bbb x\u0000? y\u0000", "utf8");
  const stub = spawnStub({ stdout: [payload] });
  const result = await runGitCommand(["status"], {
    cwd: "C:\\repo",
    encoding: "buffer",
    spawnProcess: stub.spawnProcess
  });

  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual(result.stdout, payload);
  assert.equal(result.stdout.includes(0x00), true, "NUL bytes must survive");
  assert.equal(result.stdout[0], 0x20, "leading whitespace must not be trimmed");
  assert.equal(result.exitCode, 0);
});

test("utf8 mode still trims, exactly as Phase 5 behaved", async () => {
  const stub = spawnStub({ stdout: [Buffer.from("  deadbeef  \n", "utf8")] });
  const result = await runGitCommand(["rev-parse", "HEAD"], {
    cwd: "C:\\repo",
    spawnProcess: stub.spawnProcess
  });
  assert.equal(result.stdout, "deadbeef");
});

test("an invalid encoding is refused before any process is started", async () => {
  let spawned = false;
  await assert.rejects(
    runGitCommand(["status"], {
      cwd: "C:\\repo",
      encoding: "latin1",
      spawnProcess: () => {
        spawned = true;
        return fakeChild();
      }
    }),
    (error) => {
      assert.equal(error.code, "supervised_process_encoding_invalid");
      return true;
    }
  );
  assert.equal(spawned, false, "nothing may be spawned for an invalid encoding");
});

test("runGitCommand propagates the raw supervised error with its exit code", async () => {
  const stub = spawnStub({ stderr: [Buffer.from("bad ref", "utf8")], exitCode: 128 });
  await assert.rejects(
    runGitCommand(["rev-parse", "--verify", "refs/heads/missing^{commit}"], {
      cwd: "C:\\repo",
      spawnProcess: stub.spawnProcess
    }),
    (error) => {
      // The read-only path depends on telling "the ref does not resolve" from
      // "Git broke", and that distinction lives in these two fields.
      assert.equal(error.code, "supervised_process_failed");
      assert.equal(error.reason, "nonzero-exit");
      assert.equal(error.exitCode, 128);
      assert.equal(error instanceof WorktreeManagerError, false);
      return true;
    }
  );
});

test("runGit still maps failures into the worktree vocabulary and hides the exit code", async () => {
  const stub = spawnStub({ exitCode: 1 });
  await assert.rejects(
    runGit(["worktree", "add"], { cwd: "C:\\repo", spawnProcess: stub.spawnProcess }),
    (error) => {
      assert.ok(error instanceof WorktreeManagerError);
      assert.equal(error.code, "worktree_git_failed");
      return true;
    }
  );

  const success = await runGit(["rev-parse", "HEAD"], {
    cwd: "C:\\repo",
    spawnProcess: spawnStub({ stdout: [Buffer.from("deadbeef", "utf8")] }).spawnProcess
  });
  assert.deepEqual({ ...success }, { stdout: "deadbeef", stderr: "" });
});

test("combined stdout and stderr overflow is still enforced in buffer mode", async () => {
  const stub = spawnStub({
    stdout: [Buffer.alloc(64, 0x61)],
    stderr: [Buffer.alloc(64, 0x62)]
  });
  await assert.rejects(
    runGitCommand(["status"], {
      cwd: "C:\\repo",
      encoding: "buffer",
      maxOutputBytes: 80,
      spawnProcess: stub.spawnProcess
    }),
    (error) => {
      assert.equal(error.code, "supervised_process_output_overflow");
      return true;
    }
  );
});

test("every Git invocation receives a built environment, never the inherited one", async () => {
  const stub = spawnStub({ stdout: [Buffer.from("ok", "utf8")] });
  await runGitCommand(["status"], {
    cwd: "C:\\repo",
    env: { PATH: "C:\\bin", SECRET_TOKEN: "leak-me" },
    platform: "win32",
    spawnProcess: stub.spawnProcess
  });

  const passed = stub.calls[0].spawnOptions.env;
  assert.equal(passed.SECRET_TOKEN, undefined, "secrets must not reach Git");
  assert.equal(passed.PATH, "C:\\bin");
  assert.equal(passed.GIT_CONFIG_GLOBAL, "NUL");
  assert.equal(passed.GIT_OPTIONAL_LOCKS, "0");
  assert.deepEqual(passed, buildGitEnvironment({ PATH: "C:\\bin", SECRET_TOKEN: "leak-me" }, { platform: "win32" }));
});

test("hook isolation arguments precede the command when requested", async () => {
  const stub = spawnStub({ stdout: [Buffer.from("ok", "utf8")] });
  await runGitCommand(["status"], {
    cwd: "C:\\repo",
    platform: "win32",
    disableHooks: true,
    spawnProcess: stub.spawnProcess
  });
  assert.deepEqual(stub.calls[0].args, ["-c", "core.hooksPath=NUL", "status"]);
});
