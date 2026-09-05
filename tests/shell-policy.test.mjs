import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_COMMAND_NAMES,
  DANGEROUS_GIT_OPERATION_NAMES,
  EXECUTABLE_SUFFIXES,
  GIT_CONFIGURATION_OPERATIONS,
  ShellPolicyError,
  evaluateShellPolicy,
  hardDeniedBashRules,
  parsePreToolUseInput
} from "../src/shell-policy.mjs";
import { bashCommandDeniedByRules, firstMatchingBashDenyRule } from "./fixtures/claude-permission-matching.mjs";

/**
 * P1-3: the documented Bash prohibitions hold without the hook.
 *
 * A timed-out or failed PreToolUse hook does not block the tool call, so the
 * static deny rules - evaluated by the runtime that owns the call - are the
 * fail-closed gate, and the hook is defense in depth plus the judgements no
 * rule can express. These tests pin both layers and, crucially, the seam
 * between them:
 *
 * - the hook denies every prohibited spelling it can classify (suffixes,
 *   case variants, absolute paths, every wrapper, nested wrappers, leading
 *   assignments, compounds);
 * - the static rules deny every prohibited spelling except case variants
 *   and non-first-position `publish`, proved by matching the generated rules
 *   against a documented model of Claude's permission matching with no hook
 *   involved at all;
 * - the hook-only residue (case variants, `npm run publish`) is pinned as
 *   exactly that: hook-denied, rule-invisible, and documented;
 * - legitimate writer commands stay allowed in both layers.
 */

const DENY = hardDeniedBashRules();
const SUFFIXES = ["", ...EXECUTABLE_SUFFIXES];

function hookDenies(command, shellPolicy = "worker") {
  assert.equal(
    evaluateShellPolicy(shellPolicy, command).allowed,
    false,
    "hook must deny (" + shellPolicy + "): " + command
  );
}

function hookAllows(command, shellPolicy = "worker") {
  assert.equal(
    evaluateShellPolicy(shellPolicy, command).allowed,
    true,
    "hook must allow (" + shellPolicy + "): " + command
  );
}

function rulesDeny(command) {
  assert.equal(
    bashCommandDeniedByRules(DENY, command),
    true,
    "static rules must deny without any hook: " + command
  );
}

function rulesAllow(command) {
  assert.equal(
    bashCommandDeniedByRules(DENY, command),
    false,
    "static rules must not deny legitimate work: " + command +
      " (matched by " + firstMatchingBashDenyRule(DENY, command) + ")"
  );
}

test("deny rules are deterministic, frozen, and duplicate-free", () => {
  assert.deepEqual(hardDeniedBashRules(), DENY);
  assert.ok(Object.isFrozen(DENY));
  assert.equal(new Set(DENY).size, DENY.length, "no duplicate rules");
  assert.ok(DENY.length > 2000, "the anchored shapes number in the thousands, got " + DENY.length);
  for (const rule of DENY) {
    assert.match(rule, /^Bash\(.+\)$/u, "every rule targets the Bash tool: " + rule);
  }
});

test("every blocked command is denied in every suffix spelling and shape", () => {
  assert.ok(BLOCKED_COMMAND_NAMES.length > 40);
  for (const command of BLOCKED_COMMAND_NAMES) {
    for (const suffix of (command === "." ? [""] : SUFFIXES)) {
      const program = command + suffix;
      for (const rule of [
        "Bash(" + program + " *)",
        "Bash(* " + program + " *)",
        "Bash(* " + program + ")",
        "Bash(*/" + program + " *)",
        "Bash(*/" + program + ")",
        "Bash(*\\" + program + " *)",
        "Bash(*\\" + program + ")"
      ]) {
        assert.ok(DENY.includes(rule), "missing static rule: " + rule);
      }
    }
  }
});

test("every dangerous git operation is denied in every suffix spelling and shape", () => {
  const operations = [...DANGEROUS_GIT_OPERATION_NAMES, ...GIT_CONFIGURATION_OPERATIONS];
  assert.ok(operations.length >= 20);
  for (const suffix of SUFFIXES) {
    const git = "git" + suffix;
    for (const operation of operations) {
      for (const rule of [
        "Bash(" + git + " " + operation + " *)",
        "Bash(* " + git + " " + operation + " *)",
        "Bash(* " + git + " " + operation + ")",
        "Bash(*/" + git + " " + operation + " *)",
        "Bash(*/" + git + " " + operation + ")",
        "Bash(*\\" + git + " " + operation + " *)",
        "Bash(*\\" + git + " " + operation + ")"
      ]) {
        assert.ok(DENY.includes(rule), "missing static rule: " + rule);
      }
    }
    for (const rule of [
      "Bash(" + git + " -*)",
      "Bash(* " + git + " -*)",
      "Bash(*/" + git + " -*)",
      "Bash(*\\" + git + " -*)"
    ]) {
      assert.ok(DENY.includes(rule), "missing static rule: " + rule);
    }
  }
});

test("every canonical publication command is denied in every suffix spelling and shape", () => {
  for (const suffix of SUFFIXES) {
    for (const head of ["npm" + suffix + " publish", "pnpm" + suffix + " publish", "yarn" + suffix + " npm publish"]) {
      for (const rule of [
        "Bash(" + head + " *)",
        "Bash(* " + head + " *)",
        "Bash(* " + head + ")",
        "Bash(*/" + head + " *)",
        "Bash(*/" + head + ")",
        "Bash(*\\" + head + " *)",
        "Bash(*\\" + head + ")"
      ]) {
        assert.ok(DENY.includes(rule), "missing static rule: " + rule);
      }
    }
  }
});

test("hook and rules deny every prohibited canonical spelling", () => {
  const prohibited = [
    "rm -rf build",
    "rm",
    "taskkill /IM node.exe",
    "curl http://example.invalid",
    "ssh deploy@example.invalid",
    "sudo make install",
    "shutdown /s",
    "powershell -Command Get-Process",
    "cmd /c echo hi",
    "bash -c 'echo hi'",
    "git push",
    "git push origin main",
    "git commit -m x",
    "git merge feature",
    "git rebase main",
    "git fetch",
    "git pull",
    "git checkout main",
    "git reset --hard",
    "git restore file",
    "git stash push",
    "git tag v1",
    "git add file",
    "git clean -fd",
    "git switch main",
    "git cherry-pick abc123",
    "git am patch",
    "git apply patch",
    "git config user.name x",
    "git remote add origin url",
    "git clone url",
    "git init",
    "git worktree add path",
    "git -c protocol.ext.allow=always fetch",
    "git --exec-path=/tmp/x status",
    "git --version",
    "npm publish",
    "npm publish --access public",
    "pnpm publish",
    "yarn npm publish"
  ];
  for (const command of prohibited) {
    // The hook refuses quoted commands wholesale; spelling variants with
    // quotes are covered separately as hook-denied.
    if (!command.includes("'")) hookDenies(command);
    rulesDeny(command);
  }
});

test("hook and rules deny every Windows suffix spelling", () => {
  for (const suffix of EXECUTABLE_SUFFIXES) {
    for (const command of [
      "git" + suffix + " push",
      "rm" + suffix + " -rf build",
      "npm" + suffix + " publish",
      "taskkill" + suffix + " /IM node.exe",
      "powershell" + suffix + " -Command Get-Process"
    ]) {
      hookDenies(command);
      rulesDeny(command);
    }
  }
});

test("hook and rules deny absolute paths in both slash styles", () => {
  for (const command of [
    "/usr/bin/git push",
    "/bin/rm -rf build",
    "/usr/local/bin/npm publish",
    "/sbin/shutdown",
    "C:\\Windows\\System32\\cmd.exe /c echo hi",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-Process",
    "C:\\tools\\npm.cmd publish",
    ".\\git.exe push",
    "../bin/git push"
  ]) {
    hookDenies(command);
    rulesDeny(command);
  }
});

test("paths with spaces pin the hook/rule seam exactly", () => {
  // Unquoted, an absolute path with spaces splits into several tokens, so the
  // hook classifies only its first fragment - but that spelling cannot
  // execute as intended on any shell (the program path itself is broken), so
  // allowing it is harmless. The rules still deny it textually, so the net
  // verdict without any hook is deny.
  hookAllows("C:\\Program Files\\Git\\cmd\\git.exe push");
  rulesDeny("C:\\Program Files\\Git\\cmd\\git.exe push");
  // Quoted, the same path runs - and quoting is a hook-only judgement: the
  // hook refuses all quotes while no rule shape expresses them. Like case
  // variants, this residue is pinned rather than silently assumed covered.
  hookDenies('"C:\\Program Files\\Git\\cmd\\git.exe push"');
  rulesAllow('"C:\\Program Files\\Git\\cmd\\git.exe push"');
  hookDenies("git \"push\"");
  rulesAllow("git \"push\"");
});

test("hook and rules deny every wrapper around a prohibited command", () => {
  const inners = ["git push", "rm -rf build", "npm publish"];
  const wrappers = [
    "command",
    "builtin",
    "exec",
    "env",
    "env FOO=1",
    "env -u FOO",
    "nohup",
    "setsid",
    "nice",
    "nice -n 5",
    "ionice",
    "stdbuf -o0",
    "time",
    "timeout 5",
    "timeout -s KILL 5",
    "xargs",
    "xargs -n1"
  ];
  for (const wrapper of wrappers) {
    for (const inner of inners) {
      const command = wrapper + " " + inner;
      hookDenies(command);
      rulesDeny(command);
    }
  }
});

test("hook and rules deny nested wrappers at any depth", () => {
  for (const command of [
    "timeout 5 env git push",
    "env timeout 5 rm -rf build",
    "nice -n 5 setsid git push",
    "xargs -n1 env npm publish",
    "time timeout 5 env git push",
    "/usr/bin/env /usr/bin/git push",
    "/bin/timeout 5 /bin/rm -rf build",
    "FOO=1 timeout 5 git push"
  ]) {
    hookDenies(command);
    rulesDeny(command);
  }
  // Nesting past the hook's bound is refused rather than half-classified,
  // while the rules see through any depth.
  const deep = "env env env env env git push";
  hookDenies(deep);
  rulesDeny(deep);
});

test("hook and rules deny leading assignments before a prohibited command", () => {
  for (const command of [
    "FOO=1 git push",
    "FOO=1 rm -rf build",
    "A=1 B=2 npm publish",
    "FOO=1 /usr/bin/git push",
    "FOO=1 timeout 5 git push",
    "command FOO=1 git push"
  ]) {
    hookDenies(command);
    rulesDeny(command);
  }
  hookDenies("FOO=1", "worker");
});

test("hook and rules deny wrappers with nothing left to run", () => {
  for (const command of ["env", "timeout 5", "xargs -n1", "command", "exec", "time"]) {
    hookDenies(command);
  }
});

test("hook and rules deny prohibited commands inside compounds", () => {
  for (const command of [
    "git status; git push",
    "git push; git status",
    "echo hi && git push",
    "git push || echo failed",
    "npm test && npm publish",
    "(git push)",
    "echo $(git push)",
    "FOO=1 git push; echo done"
  ]) {
    hookDenies(command);
    rulesDeny(command);
  }
});

test("hook and rules deny execution wrappers the policy blocks outright", () => {
  // `coproc`, `!`, `su`, `runuser`, `batch`, `crontab`, `eval`, `source`,
  // and `.` all execute other commands (or schedule them) in ways no
  // token-position classifier can see through, so they are denied as
  // programs rather than resolved. None is a legitimate writer command:
  // privilege escalation, backgrounding, scheduled execution, and
  // file-sourced execution are never the writer's job.
  for (const command of [
    "coproc git push",
    "! git push",
    "! rm -rf build",
    "su -c git push",
    "runuser -u nobody -- git push",
    "eval git push",
    "source evil.sh",
    ". evil.sh",
    "batch",
    "crontab evil.cron"
  ]) {
    hookDenies(command);
    rulesDeny(command);
  }
});

test("case variants are hook-denied and pinned as the hook-only residue", () => {
  // Bash rule matching is documented nowhere as case-insensitive, so rules
  // cannot express these; the hook classifies case-insensitively instead.
  // On POSIX a case-variant external command fails to resolve on its own,
  // which narrows this residue to Windows - where the hook still judges it.
  for (const command of ["GIT push", "Git Push", "RM -rf build", "Rm -rf build", "NPM publish", "Npm Publish"]) {
    hookDenies(command);
    rulesAllow(command);
  }
});

test("non-first-position publish is hook-denied and pinned as the hook-only residue", () => {
  // `npm run publish` runs a local repo script, under the same authority as
  // `npm test`; denying it by rule would need an unanchored substring that
  // also matches `grep publish`, so the hook judges it instead.
  hookDenies("npm run publish");
  rulesAllow("npm run publish");
});

test("hook denies shell composition, quoting, globs, and substitution wholesale", () => {
  for (const command of [
    "git status; echo done",
    "git status && git log",
    "git log | head",
    "echo hi > out.txt",
    "git status `echo hi`",
    "echo $(git status)",
    "echo ${HOME}",
    "echo $HOME",
    "git log --grep 'fix bug'",
    'git log --grep "fix bug"',
    "cat *.js",
    "git status --short\n git log"
  ]) {
    hookDenies(command);
  }
  assert.throws(() => evaluateShellPolicy("observer", "git status"), ShellPolicyError);
});

test("the git-readonly policy allows only read-only git", () => {
  for (const command of [
    "git status",
    "git diff",
    "git log --oneline",
    "git show HEAD",
    "git rev-parse HEAD",
    "git ls-files",
    "git grep pattern",
    "git branch --show-current",
    "/usr/bin/git status",
    "timeout 5 git log"
  ]) {
    hookAllows(command, "git-readonly");
  }
  for (const command of [
    "git",
    "git push",
    "git commit",
    "GIT PUSH",
    "git -c x status",
    "git branch",
    "git branch -D x",
    "node build.mjs",
    "rm -rf build",
    "env git push"
  ]) {
    hookDenies(command, "git-readonly");
  }
});

test("legitimate writer commands stay allowed in both layers", () => {
  for (const command of [
    "git status",
    "git diff --stat",
    "git log --oneline",
    "git show HEAD",
    "git rev-parse HEAD",
    "git ls-files",
    "git grep pattern",
    "git branch --show-current",
    "npm test",
    "npm run build",
    "npx jest",
    "node build.mjs",
    "python -m pytest",
    "cat file.txt",
    "ls -la",
    "echo hello",
    "FOO=1 npm test",
    "timeout 60 npm test",
    "env FOO=1 npm test",
    "time npm test",
    "git status && npm test",
    "git status | tee out.txt"
  ]) {
    if (command.includes("&&") || command.includes("|")) {
      // Compounds are hook-refused wholesale but rule-judged per subcommand:
      // both subcommands are clean, so the rules allow the compound and the
      // hook remains the stricter layer when it runs.
      hookDenies(command);
      rulesAllow(command);
    } else {
      hookAllows(command);
      rulesAllow(command);
    }
  }
});

test("anchored shapes do not match lookalike tool names", () => {
  // The space/slash anchors are load-bearing: unanchored substring rules
  // would deny these legitimate tools.
  for (const command of ["cat file.txt", "legit push", "digit 5", "myrm file", "gitsy status"]) {
    hookAllows(command);
    rulesAllow(command);
  }
});

test("hook input parsing fails closed on anything but a Bash PreToolUse event", () => {
  assert.equal(
    parsePreToolUseInput(JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" }
    })),
    "git status"
  );
  for (const input of [
    "",
    "{not json",
    JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "x" } }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { command: "x" } }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 42 } }),
    "null"
  ]) {
    assert.throws(() => parsePreToolUseInput(input), ShellPolicyError);
  }
});

test("the hook command exits fail-closed: deny blocks, errors block, allow passes", () => {
  const hookPath = fileURLToPath(new URL("../hooks/claude-pretool-policy.mjs", import.meta.url));
  const runHook = (policyArgs, stdin) =>
    spawnSync(process.execPath, [hookPath, ...policyArgs], {
      input: stdin,
      encoding: "utf8",
      windowsHide: true
    });
  const eventFor = (command) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  for (const policy of ["git-readonly", "task", "worker"]) {
    const denied = runHook(["--policy", policy], eventFor("git push"));
    assert.equal(denied.status, 2, policy + " must exit 2 for a denied command");
    assert.match(denied.stderr, /Blocked by claude-agents shell policy/u);
  }
  const allowed = runHook(["--policy", "worker"], eventFor("git status"));
  assert.equal(allowed.status, 0, "an allowed command must exit 0, got: " + allowed.stderr);

  // Every hook-side failure blocks the call rather than waving it through.
  for (const [label, args, stdin] of [
    ["malformed JSON", ["--policy", "worker"], "{not json"],
    ["empty input", ["--policy", "worker"], ""],
    ["wrong tool", ["--policy", "worker"], eventFor("git status").replace('"Bash"', '"Read"')],
    ["missing policy", [], eventFor("git status")],
    ["bad policy", ["--policy", "observer"], eventFor("git status")]
  ]) {
    const failed = runHook(args, stdin);
    assert.equal(failed.status, 2, label + " must exit 2, got " + failed.status);
  }
});
