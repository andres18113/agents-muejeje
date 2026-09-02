import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTENT_BYTES_PER_FILE,
  WorkspaceDigestError,
  createContentBudget,
  digestWorkspaceEntry
} from "../src/changeset/workspace-digest.mjs";

function stat({ kind = "file", size = 4, mtimeNs = 10n, ctimeNs = 11n, mode = 0o100644, ino = 5n, dev = 7n }) {
  return {
    size: BigInt(size),
    mtimeNs,
    ctimeNs,
    mode: BigInt(mode),
    ino,
    dev,
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
    isDirectory: () => kind === "directory"
  };
}

function fileHandle(bytes) {
  let offset = 0;
  return {
    async read(buffer, position, length) {
      const slice = bytes.subarray(offset, offset + length);
      slice.copy(buffer, 0);
      offset += slice.length;
      return { bytesRead: slice.length };
    },
    async close() {}
  };
}

function deps({ stats, bytes = Buffer.from("data", "utf8"), linkTarget, openError }) {
  const queue = [...stats];
  const seen = { lstatCalls: 0 };
  return {
    seen,
    lstatFn: async () => {
      seen.lstatCalls += 1;
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    openFn: async () => {
      if (openError) throw openError;
      return fileHandle(bytes);
    },
    readlinkFn: async () => linkTarget
  };
}

test("a regular file digests its exact bytes", async () => {
  const bytes = Buffer.from("hello", "utf8");
  const d = deps({ stats: [stat({ size: bytes.length })], bytes });
  const result = await digestWorkspaceEntry("C:\\repo\\a.txt", d);
  assert.equal(result.kind, "blob");
  assert.equal(result.bytes, bytes.length);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test("a symlink digests its target bytes and cannot collide with a file of the same content", async () => {
  const shared = Buffer.from("target/path", "utf8");
  const asFile = await digestWorkspaceEntry("C:\\repo\\a", deps({
    stats: [stat({ size: shared.length })],
    bytes: shared
  }));
  const asLink = await digestWorkspaceEntry("C:\\repo\\b", deps({
    stats: [stat({ kind: "symlink", size: shared.length, mode: 0o120000 })],
    linkTarget: shared
  }));

  assert.equal(asLink.kind, "link");
  // Domain separation: identical bytes under different kinds must not share a
  // digest, or a symlink could impersonate a file.
  assert.notEqual(asFile.digest, asLink.digest);
});

test("bytes are hashed raw, with no line-ending translation", async () => {
  const crlf = Buffer.from("a\r\nb\r\n", "utf8");
  const lf = Buffer.from("a\nb\n", "utf8");
  const one = await digestWorkspaceEntry("C:\\repo\\a", deps({ stats: [stat({ size: crlf.length })], bytes: crlf }));
  const two = await digestWorkspaceEntry("C:\\repo\\b", deps({ stats: [stat({ size: lf.length })], bytes: lf }));
  assert.notEqual(one.digest, two.digest);
});

test("a directory is opaque and an unsupported type is refused", async () => {
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\nested", deps({ stats: [stat({ kind: "directory" })] })),
    (error) => {
      assert.equal(error.reason, "untracked_directory_opaque");
      return true;
    }
  );

  const fifo = stat({});
  fifo.isFile = () => false;
  fifo.isSymbolicLink = () => false;
  fifo.isDirectory = () => false;
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\pipe", deps({ stats: [fifo] })),
    (error) => {
      assert.equal(error.reason, "unsupported_file_type");
      return true;
    }
  );
});

test("an oversized file is refused before it is read into memory", async () => {
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\big", deps({ stats: [stat({ size: MAX_CONTENT_BYTES_PER_FILE + 1 })] })),
    (error) => {
      assert.equal(error.reason, "content_too_large");
      return true;
    }
  );
});

test("a shared budget is consumed across files and then refuses the next one", async () => {
  const budget = createContentBudget(8);
  const bytes = Buffer.from("12345", "utf8");
  await digestWorkspaceEntry("C:\\repo\\a", { ...deps({ stats: [stat({ size: 5 })], bytes }), budget });
  assert.equal(budget.remainingBytes, 3);
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\b", { ...deps({ stats: [stat({ size: 5 })], bytes }), budget }),
    (error) => {
      assert.equal(error.reason, "content_too_large");
      return true;
    }
  );
});

test("a file that changes underneath the read is retried once and then succeeds", async () => {
  const bytes = Buffer.from("data", "utf8");
  // First bracket disagrees; the retry's bracket agrees.
  const stats = [
    stat({ size: 4, mtimeNs: 10n }),
    stat({ size: 4, mtimeNs: 99n }),
    stat({ size: 4, mtimeNs: 50n }),
    stat({ size: 4, mtimeNs: 50n })
  ];
  let index = 0;
  const result = await digestWorkspaceEntry("C:\\repo\\a.txt", {
    lstatFn: async () => stats[Math.min(index++, stats.length - 1)],
    openFn: async () => fileHandle(bytes),
    readlinkFn: async () => Buffer.alloc(0)
  });
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test("a file that keeps changing is reported unstable rather than digested", async () => {
  let tick = 0n;
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\churn.txt", {
      lstatFn: async () => stat({ size: 4, mtimeNs: tick++ }),
      openFn: async () => fileHandle(Buffer.from("data", "utf8")),
      readlinkFn: async () => Buffer.alloc(0)
    }),
    (error) => {
      assert.equal(error.reason, "content_unstable");
      return true;
    }
  );
});

test("ino and dev of zero are tolerated, because Windows reports them that way", async () => {
  const zeroed = () => stat({ ino: 0n, dev: 0n });
  const result = await digestWorkspaceEntry("C:\\repo\\a.txt", {
    lstatFn: async () => zeroed(),
    openFn: async () => fileHandle(Buffer.from("data", "utf8")),
    readlinkFn: async () => Buffer.alloc(0)
  });
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test("a genuine inode change is still a mismatch when both sides report one", async () => {
  const stats = [stat({ ino: 1n }), stat({ ino: 2n }), stat({ ino: 3n }), stat({ ino: 4n })];
  let index = 0;
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\a.txt", {
      lstatFn: async () => stats[Math.min(index++, stats.length - 1)],
      openFn: async () => fileHandle(Buffer.from("data", "utf8")),
      readlinkFn: async () => Buffer.alloc(0)
    }),
    (error) => {
      assert.equal(error.reason, "content_unstable");
      return true;
    }
  );
});

test("a mode change alone is a mismatch", async () => {
  const stats = [
    stat({ mode: 0o100644 }), stat({ mode: 0o100755 }),
    stat({ mode: 0o100644 }), stat({ mode: 0o100755 })
  ];
  let index = 0;
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\a.txt", {
      lstatFn: async () => stats[Math.min(index++, stats.length - 1)],
      openFn: async () => fileHandle(Buffer.from("data", "utf8")),
      readlinkFn: async () => Buffer.alloc(0)
    }),
    WorkspaceDigestError
  );
});

test("an unreadable file is retried once and then reported unreadable", async () => {
  let attempts = 0;
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\locked.txt", {
      lstatFn: async () => stat({}),
      openFn: async () => {
        attempts += 1;
        throw denied;
      },
      readlinkFn: async () => Buffer.alloc(0)
    }),
    (error) => {
      assert.equal(error.reason, "content_unreadable");
      return true;
    }
  );
  assert.equal(attempts, 2, "exactly one retry, never a loop");
});

test("a vanished file is retried once and then reported unreadable", async () => {
  const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
  let attempts = 0;
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\gone.txt", {
      lstatFn: async () => {
        attempts += 1;
        throw missing;
      },
      openFn: async () => fileHandle(Buffer.alloc(0)),
      readlinkFn: async () => Buffer.alloc(0)
    }),
    (error) => {
      assert.equal(error.reason, "content_unreadable");
      return true;
    }
  );
  assert.equal(attempts, 2);
});

test("cancellation during an in-flight digest prevents every later filesystem operation", async () => {
  const controller = new AbortController();
  let finishFirstLstat;
  const firstLstat = new Promise((resolve) => {
    finishFirstLstat = resolve;
  });
  const operations = [];

  const pending = digestWorkspaceEntry("C:\\repo\\cancelled.txt", {
    cancelled: () => controller.signal.aborted,
    lstatFn: async () => {
      operations.push("lstat-before");
      await firstLstat;
      return stat({ size: 4 });
    },
    openFn: async () => {
      operations.push("open");
      return fileHandle(Buffer.from("data", "utf8"));
    },
    readlinkFn: async () => {
      operations.push("readlink");
      return Buffer.alloc(0);
    }
  });

  controller.abort();
  finishFirstLstat();

  await assert.rejects(pending, (error) => {
    assert.equal(error.reason, "collection_deadline_exceeded");
    return true;
  });
  assert.deepEqual(
    operations,
    ["lstat-before"],
    "open, read, after-stat and retry must not begin after cancellation"
  );
});

/**
 * Cancellation at every boundary inside one entry's digest.
 *
 * The claim is not "the digest is cancellable" but the stronger one that after
 * cancellation no NEW filesystem operation begins, while the operation already
 * in flight is allowed to finish. A test that cancels before the digest starts
 * would prove neither half, so each case here cancels from inside a specific
 * in-flight call and then asserts the exact operation log.
 */
function tracingDeps({ cancelDuring, controller, kind = "file", size = 8 }) {
  const operations = [];
  // Two chunk-sized reads, so cancellation can land between them.
  const bytes = Buffer.alloc(size, 0x61);
  let offset = 0;
  let lstatCalls = 0;

  const maybeCancel = (stage) => {
    if (cancelDuring === stage) controller.abort();
  };

  return {
    operations,
    cancelled: () => controller.signal.aborted,
    lstatFn: async () => {
      lstatCalls += 1;
      const stage = lstatCalls === 1 ? "first-lstat" : "confirming-lstat";
      operations.push(stage);
      maybeCancel(stage);
      return stat({ kind, size });
    },
    openFn: async () => {
      operations.push("open");
      maybeCancel("open");
      return {
        async read(buffer, position, length) {
          operations.push("read");
          maybeCancel("read");
          const slice = bytes.subarray(offset, offset + Math.min(length, 4));
          slice.copy(buffer, 0);
          offset += slice.length;
          return { bytesRead: slice.length };
        },
        async close() {
          operations.push("close");
        }
      };
    },
    readlinkFn: async () => {
      operations.push("readlink");
      maybeCancel("readlink");
      return Buffer.from("target", "utf8");
    }
  };
}

test("cancellation inside a digest lets the in-flight call finish and starts nothing new", async () => {
  for (const [stage, kind, expected] of [
    // Cancelled from inside the opening lstat: nothing else may begin.
    ["first-lstat", "file", ["first-lstat"]],
    // Cancelled from inside open(): the handle is closed, no read begins.
    ["open", "file", ["first-lstat", "open", "close"]],
    // Cancelled from inside the first chunk read: no second chunk begins.
    ["read", "file", ["first-lstat", "open", "read", "close"]],
    // Cancelled from inside readlink(): no confirming lstat begins.
    ["readlink", "symlink", ["first-lstat", "readlink"]]
  ]) {
    const controller = new AbortController();
    const dependencies = tracingDeps({ cancelDuring: stage, controller, kind });

    await assert.rejects(
      digestWorkspaceEntry("C:\\repo\\entry", dependencies),
      (error) => {
        assert.ok(error instanceof WorkspaceDigestError, stage);
        assert.equal(error.reason, "collection_deadline_exceeded", stage);
        return true;
      },
      "cancellation during " + stage + " must refuse rather than return a digest"
    );

    assert.deepEqual(
      dependencies.operations,
      expected,
      "after cancelling during " + stage + ", no further filesystem operation may begin"
    );
  }
});

test("cancellation during the confirming stat finishes it and begins nothing further", async () => {
  // The last bracket call was already authorized when it started, so it is
  // allowed to finish. Every byte in the result was read before cancellation,
  // and no operation begins afterwards - which is the whole guarantee. The
  // collection around it still reports itself cancelled; this entry simply
  // does not invent extra filesystem work to discover that.
  const controller = new AbortController();
  const dependencies = tracingDeps({
    cancelDuring: "confirming-lstat",
    controller,
    kind: "symlink"
  });

  const result = await digestWorkspaceEntry("C:\\repo\\entry", dependencies);
  assert.equal(result.kind, "link");
  assert.deepEqual(
    dependencies.operations,
    ["first-lstat", "readlink", "confirming-lstat"],
    "no operation may begin after the in-flight confirming stat completes"
  );
  assert.equal(controller.signal.aborted, true);
});

test("an unstable entry under cancellation is refused instead of re-read", async () => {
  // The confirming stat disagrees, which normally earns the one permitted
  // retry. Cancellation arrived during that confirming stat, so the retry -
  // a fresh sequence of filesystem calls - must not begin.
  const controller = new AbortController();
  const operations = [];
  let lstatCalls = 0;

  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\churning.txt", {
      cancelled: () => controller.signal.aborted,
      lstatFn: async () => {
        lstatCalls += 1;
        operations.push("lstat-" + lstatCalls);
        if (lstatCalls === 2) {
          controller.abort();
          // Different size: the bracket disagrees and the entry is unstable.
          return stat({ size: 99 });
        }
        return stat({ size: 4 });
      },
      openFn: async () => {
        operations.push("open-" + (operations.filter((o) => o.startsWith("open")).length + 1));
        return fileHandle(Buffer.from("data", "utf8"));
      },
      readlinkFn: async () => Buffer.alloc(0)
    }),
    (error) => {
      assert.equal(error.reason, "collection_deadline_exceeded");
      return true;
    }
  );

  assert.deepEqual(
    operations,
    ["lstat-1", "open-1", "lstat-2"],
    "the retry must not re-open or re-stat the entry after cancellation"
  );
});

test("a retry is a new operation and never begins after cancellation", async () => {
  // The entry vanishes, which normally earns exactly one retry. Cancellation
  // arrives while that first failing attempt is still in flight, so the retry
  // - a fresh sequence of filesystem calls - must not start.
  const controller = new AbortController();
  const operations = [];
  let lstatCalls = 0;

  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\vanishing.txt", {
      cancelled: () => controller.signal.aborted,
      lstatFn: async () => {
        lstatCalls += 1;
        operations.push("lstat-" + lstatCalls);
        // Cancellation lands during the attempt that is about to fail.
        controller.abort();
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
      openFn: async () => {
        operations.push("open");
        throw new Error("must not be reached");
      },
      readlinkFn: async () => {
        operations.push("readlink");
        throw new Error("must not be reached");
      }
    }),
    (error) => {
      assert.equal(error.reason, "collection_deadline_exceeded");
      return true;
    }
  );

  assert.deepEqual(operations, ["lstat-1"], "the retry attempt must never begin");
  assert.equal(lstatCalls, 1);
});

test("without cancellation the same vanishing entry really does retry", async () => {
  // Guards the test above: the retry it forbids is one that otherwise happens,
  // so a passing result cannot come from the retry having been removed.
  let lstatCalls = 0;
  await assert.rejects(
    digestWorkspaceEntry("C:\\repo\\vanishing.txt", {
      cancelled: () => false,
      lstatFn: async () => {
        lstatCalls += 1;
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
      openFn: async () => fileHandle(Buffer.alloc(0)),
      readlinkFn: async () => Buffer.alloc(0)
    }),
    (error) => {
      assert.equal(error.reason, "content_unreadable");
      return true;
    }
  );
  assert.equal(lstatCalls, 2, "the uncancelled path takes its one permitted retry");
});
