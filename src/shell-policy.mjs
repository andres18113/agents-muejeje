const COMPOSITION_PATTERN = /[\r\n;&|<>`()]/u;
const COMMAND_SUBSTITUTION_PATTERN = /\$\(|\$\{/u;
const VARIABLE_EXPANSION_PATTERN = /\$/u;
const QUOTING_PATTERN = /["']/u;
const GLOB_PATTERN = /[*?\[\]]/u;

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "show",
  "log",
  "rev-parse",
  "ls-files",
  "grep"
]);
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "fetch",
  "merge",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "stash",
  "switch",
  "tag"
]);
// Configuration-scale Git operations the hook refuses alongside the dangerous
// subcommands above. Shared with the static deny rules so the two layers
// cannot skew on which operations are prohibited.
const GIT_CONFIGURATION_OPERATIONS = Object.freeze(["config", "remote", "clone", "init", "worktree"]);
export { GIT_CONFIGURATION_OPERATIONS };
export const DANGEROUS_GIT_OPERATION_NAMES = Object.freeze([...DANGEROUS_GIT_SUBCOMMANDS]);
const BLOCKED_COMMANDS = new Set([
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "curl",
  "wget",
  "invoke-webrequest",
  "iwr",
  "irm",
  "gh",
  "docker",
  "kubectl",
  "helm",
  "terraform",
  "systemctl",
  "service",
  "sc",
  "schtasks",
  "at",
  "shutdown",
  "reboot",
  "restart-computer",
  "stop-computer",
  "kill",
  "pkill",
  "taskkill",
  "stop-process",
  "sudo",
  "runas",
  "su",
  "runuser",
  "batch",
  "crontab",
  "coproc",
  "eval",
  "source",
  ".",
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "format",
  "diskpart",
  "reg",
  "set-itemproperty",
  "set-content",
  "add-content",
  "out-file",
  "claude",
  "codex",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "sh",
  "zsh"
]);
// Frozen read-only views for the coverage tests: the deny-rule generator and
// the hook classify from these same sets, so the tests pin that every entry
// is denied in every spelling rather than re-listing the entries by hand.
export const BLOCKED_COMMAND_NAMES = Object.freeze(
  [...BLOCKED_COMMANDS].filter((command) => command === "." || !command.includes("."))
);

/**
 * The subset of the policy that Claude Code enforces itself, as permission
 * deny rules. These rules are evaluated by the runtime that owns the tool
 * call whether the hook runs or not: a timed-out or failed PreToolUse hook
 * does not block the call, so anything that must hold without the hook must
 * be denied here. The hook stays configured as defense in depth and for the
 * judgements below that no rule can express.
 *
 * A `*` in a Bash rule matches any text at any position, and a deny rule
 * fires when any subcommand of a compound matches it. Each prohibited
 * program is therefore denied in seven anchored shapes per Windows suffix
 * spelling: bare first-position, space-separated (which sees through every
 * wrapper chain - `env`, `timeout 5 env`, nested wrappers at any depth,
 * absolute wrapper paths, `find -exec` - without enumerating combinations),
 * slash-pathed, and backslash-pathed, each with and without trailing
 * arguments. Anchoring on a space or a slash keeps `cat` from matching an
 * `at` rule and `legit` from matching a `git` rule; unanchored substring
 * rules would deny legitimate tools.
 *
 * Three judgements stay hook-side because no rule shape expresses them.
 * Case variants (`GIT push`) cannot be enumerated - Bash rule matching is
 * documented nowhere as case-insensitive, so it is assumed sensitive - and
 * the hook classifies case-insensitively instead; on POSIX systems a
 * case-variant external command fails to resolve on its own, which narrows
 * the hook-only residue to Windows. A non-first-position `publish` token
 * (`npm run publish`, a local script under the same authority as `npm test`)
 * would need an unanchored substring that also matches `grep publish`. Shell
 * composition, quoting, and globs are refused wholesale by the hook while
 * the rules judge each subcommand on its own, which is the safe direction in
 * both layers: a compound is denied when any part of it is prohibited.
 */
export function hardDeniedBashRules() {
  const rules = [];
  const suffixes = ["", ...EXECUTABLE_SUFFIXES];
  // Every prohibited bare command in every spelling the OS resolves. Dotted
  // entries (`cmd.exe`) are skipped: the bare name plus the suffix expansion
  // already covers them, and `cmd.exe.exe` would be a nonsense rule. The `.`
  // builtin takes no suffix for the same reason. Every shape uses the
  // documented `*` spelling, including first position: a sole trailing ` *`
  // also matches the bare command.
  for (const command of BLOCKED_COMMANDS) {
    if (command.includes(".") && command !== ".") continue;
    for (const suffix of (command === "." ? [""] : suffixes)) {
      const program = command + suffix;
      rules.push("Bash(" + program + " *)");
      rules.push("Bash(* " + program + " *)");
      rules.push("Bash(* " + program + ")");
      rules.push("Bash(*/" + program + " *)");
      rules.push("Bash(*/" + program + ")");
      rules.push("Bash(*\\" + program + " *)");
      rules.push("Bash(*\\" + program + ")");
    }
  }
  // Dangerous Git operations the hook refuses in `git <operation>` position,
  // denied here in every spelling Windows resolves for the git executable.
  // The "-" shapes mirror the Git policy's refusal of any `git -<option>`
  // global-option shape; the wildcard sits immediately after the dash so
  // `git -c`, `git --version`, and every other option spelling match.
  const gitOperations = [...DANGEROUS_GIT_SUBCOMMANDS, ...GIT_CONFIGURATION_OPERATIONS];
  for (const suffix of suffixes) {
    const git = "git" + suffix;
    for (const operation of gitOperations) {
      rules.push("Bash(" + git + " " + operation + " *)");
      rules.push("Bash(* " + git + " " + operation + " *)");
      rules.push("Bash(* " + git + " " + operation + ")");
      rules.push("Bash(*/" + git + " " + operation + " *)");
      rules.push("Bash(*/" + git + " " + operation + ")");
      rules.push("Bash(*\\" + git + " " + operation + " *)");
      rules.push("Bash(*\\" + git + " " + operation + ")");
    }
    rules.push("Bash(" + git + " -*)");
    rules.push("Bash(* " + git + " -*)");
    rules.push("Bash(*/" + git + " -*)");
    rules.push("Bash(*\\" + git + " -*)");
  }
  // Canonical package publication commands. A non-first-position `publish`
  // token (`npm run publish`) is hook-side: an unanchored rule would also
  // match `grep publish`.
  const publications = [["npm", "publish"], ["pnpm", "publish"], ["yarn", "npm publish"]];
  for (const suffix of suffixes) {
    for (const [tool, tail] of publications) {
      const head = tool + suffix + " " + tail;
      rules.push("Bash(" + head + " *)");
      rules.push("Bash(* " + head + " *)");
      rules.push("Bash(* " + head + ")");
      rules.push("Bash(*/" + head + " *)");
      rules.push("Bash(*/" + head + ")");
      rules.push("Bash(*\\" + head + " *)");
      rules.push("Bash(*\\" + head + ")");
    }
  }
  return Object.freeze(rules);
}

export class ShellPolicyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ShellPolicyError";
    this.code = options.code || "shell_policy_invalid";
  }
}

function denied(reason) {
  return Object.freeze({ allowed: false, reason });
}

function allowed() {
  return Object.freeze({ allowed: true, reason: "" });
}

function tokenizeSimpleCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { error: "Bash command must be a non-empty string." };
  }
  if (
    COMPOSITION_PATTERN.test(command) ||
    COMMAND_SUBSTITUTION_PATTERN.test(command) ||
    VARIABLE_EXPANSION_PATTERN.test(command)
  ) {
    return { error: "Shell composition, redirection, substitution, or multiline commands are not allowed." };
  }
  if (QUOTING_PATTERN.test(command)) {
    return { error: "Quoted shell arguments are not allowed because they cannot be safely classified." };
  }
  if (GLOB_PATTERN.test(command)) {
    return { error: "Shell glob arguments are not allowed because expansion cannot be safely classified." };
  }

  const tokens = command.trim().split(/\s+/u);
  if (tokens.some((token) => token.length === 0 || token.includes("\u0000"))) {
    return { error: "Malformed shell command." };
  }
  return { tokens };
}

/**
 * Windows resolves several suffixes for the same program, so a policy that
 * recognizes only one of them recognizes none of them: npm.cmd, git.exe and
 * claude.bat all reach exactly what their bare name reaches.
 */
const EXECUTABLE_SUFFIXES = Object.freeze([".exe", ".cmd", ".bat", ".com"]);
export { EXECUTABLE_SUFFIXES };

function commandBasename(token) {
  const basename = token.split(/[\\/]/u).pop().toLowerCase();
  const suffix = EXECUTABLE_SUFFIXES.find((candidate) => basename.endsWith(candidate));
  return suffix ? basename.slice(0, -suffix.length) : basename;
}

/**
 * Wrappers that run another program. Classifying by token 1 alone would read
 * `env rm -rf x` as `env`, which is not what runs.
 *
 * `skipValueFlags` names flags that consume the following token, and
 * `skipPositional` counts leading non-flag operands the wrapper itself
 * consumes - the duration in `timeout 5 curl ...`.
 */
const COMMAND_WRAPPERS = new Map([
  // `!` negates a pipeline's exit status and runs what follows it; without
  // this entry `! git push` would classify as the program `!`.
  ["!", { assignments: false, skipPositional: 0, skipValueFlags: [] }],
  ["command", { assignments: false, skipPositional: 0, skipValueFlags: [] }],
  ["builtin", { assignments: false, skipPositional: 0, skipValueFlags: [] }],
  ["exec", { assignments: false, skipPositional: 0, skipValueFlags: [] }],
  ["env", { assignments: true, skipPositional: 0, skipValueFlags: ["-u", "--unset", "-C", "--chdir"] }],
  ["nohup", { assignments: false, skipPositional: 0, skipValueFlags: [] }],
  ["setsid", { assignments: false, skipPositional: 0, skipValueFlags: [] }],
  ["nice", { assignments: false, skipPositional: 0, skipValueFlags: ["-n", "--adjustment"] }],
  ["ionice", { assignments: false, skipPositional: 0, skipValueFlags: ["-c", "-n", "-p"] }],
  ["stdbuf", { assignments: false, skipPositional: 0, skipValueFlags: ["-i", "-o", "-e"] }],
  ["time", { assignments: false, skipPositional: 0, skipValueFlags: ["-f", "--format", "-o", "--output"] }],
  ["timeout", { assignments: false, skipPositional: 1, skipValueFlags: ["-s", "--signal", "-k", "--kill-after"] }],
  ["xargs", { assignments: false, skipPositional: 0, skipValueFlags: ["-n", "-P", "-I", "-d", "-E", "-s", "-a"] }]
]);

const MAX_WRAPPER_DEPTH = 4;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * Resolves the executable a command actually runs, peeling wrappers.
 *
 * Anything it cannot resolve confidently - a wrapper with nothing left to run,
 * an unrecognized option shape, more nesting than makes sense - is reported as
 * unresolved so the caller fails closed rather than classifying the wrapper.
 */
function resolveEffectiveCommand(tokens) {
  let remaining = tokens;
  for (let depth = 0; depth <= MAX_WRAPPER_DEPTH; depth += 1) {
    // Leading `VAR=value` assignments are stripped at every level: the shell
    // runs what follows them, so classifying `FOO=1 git push` as the program
    // `FOO=1` would allow exactly what the policy prohibits.
    while (remaining.length > 0 && ASSIGNMENT_PATTERN.test(remaining[0])) {
      remaining = remaining.slice(1);
    }
    if (remaining.length === 0) {
      return { error: "A shell command must name a program to run." };
    }
    const name = commandBasename(remaining[0]);
    const wrapper = COMMAND_WRAPPERS.get(name);
    if (!wrapper) return { name, tokens: remaining };

    let index = 1;
    let positionalsToSkip = wrapper.skipPositional;
    while (index < remaining.length) {
      const token = remaining[index];
      if (wrapper.assignments && ASSIGNMENT_PATTERN.test(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) {
        if (token === "--") {
          index += 1;
          break;
        }
        // A flag whose value is a separate token would otherwise be mistaken
        // for the program being wrapped.
        if (wrapper.skipValueFlags.includes(token)) {
          index += 2;
          continue;
        }
        if (/^-[A-Za-z](?:[0-9A-Za-z.,:=-]*)$/u.test(token) || /^--[A-Za-z][A-Za-z-]*(?:=.*)?$/u.test(token)) {
          index += 1;
          continue;
        }
        return { error: "Wrapper option '" + token + "' cannot be safely classified." };
      }
      if (positionalsToSkip > 0) {
        positionalsToSkip -= 1;
        index += 1;
        continue;
      }
      break;
    }
    if (positionalsToSkip > 0 || index >= remaining.length) {
      return { error: "Command wrapper '" + name + "' does not name a program to run." };
    }
    remaining = remaining.slice(index);
  }
  return { error: "Command wrapping is nested too deeply to classify." };
}

function rejectDangerousGit(tokens) {
  const argumentsLowercase = tokens.slice(1).map((token) => token.toLowerCase());
  const dangerousSubcommand = argumentsLowercase.find((token) => DANGEROUS_GIT_SUBCOMMANDS.has(token));
  if (dangerousSubcommand) {
    return "Git operation '" + dangerousSubcommand + "' is not allowed by the runtime shell guard.";
  }
  if (argumentsLowercase.some((token) => GIT_CONFIGURATION_OPERATIONS.includes(token))) {
    return "Git configuration, remote, clone, init, and worktree operations are not allowed by the runtime shell guard.";
  }
  if (tokens.slice(1).some((token) => /^(?:-c|--config-env|--exec-path|--git-dir|--work-tree|--paginate|--ext-diff|-o|--output(?:=.+)?)$/iu.test(token))) {
    return "Git configuration, external-command, or file-output options are not allowed by the runtime shell guard.";
  }
  return "";
}

function evaluateGitReadonly(tokens) {
  if (commandBasename(tokens[0]) !== "git") {
    return denied("Only explicitly allowlisted read-only Git commands are available to this role.");
  }
  if (tokens.length < 2) {
    return denied("A Git subcommand is required for read-only VCS access.");
  }
  if (tokens[1].startsWith("-")) {
    return denied("Git global options are not allowed by the read-only VCS policy.");
  }

  const subcommand = tokens[1].toLowerCase();
  if (subcommand === "branch") {
    if (tokens.length === 3 && tokens[2] === "--show-current") {
      return allowed();
    }
    return denied("Only 'git branch --show-current' is allowed by the read-only VCS policy.");
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return denied("Git subcommand '" + subcommand + "' is not allowlisted for read-only VCS access.");
  }

  const dangerous = rejectDangerousGit(tokens);
  return dangerous ? denied(dangerous) : allowed();
}

function evaluateWriterCommand(tokens) {
  const command = commandBasename(tokens[0]);
  if (BLOCKED_COMMANDS.has(command)) {
    return denied("Command '" + command + "' is denied by the runtime authority guard.");
  }

  if (command === "git") {
    return evaluateGitReadonly(tokens);
  }
  if (
    ((command === "npm" || command === "pnpm") &&
      tokens.slice(1).some((token) => token.toLowerCase() === "publish")) ||
    (command === "yarn" &&
      tokens.slice(1).some((token) => token.toLowerCase() === "npm") &&
      tokens.slice(1).some((token) => token.toLowerCase() === "publish"))
  ) {
    return denied("Package publication is denied by the runtime authority guard.");
  }

  return allowed();
}

/**
 * Apply a conservative command policy for a Claude Bash tool call. It guards
 * clearly classifiable authority only; it is deliberately not represented as
 * an OS sandbox or a complete shell-security proof.
 */
export function evaluateShellPolicy(shellPolicy, command) {
  if (!["git-readonly", "task", "worker"].includes(shellPolicy)) {
    throw new ShellPolicyError("Unsupported shell policy: " + String(shellPolicy));
  }

  const parsed = tokenizeSimpleCommand(command);
  if (parsed.error) return denied(parsed.error);

  // What runs is the effective executable, not token 1. A wrapper that cannot
  // be resolved is refused rather than classified as itself.
  const effective = resolveEffectiveCommand(parsed.tokens);
  if (effective.error) return denied(effective.error);

  return shellPolicy === "git-readonly"
    ? evaluateGitReadonly(effective.tokens)
    : evaluateWriterCommand(effective.tokens);
}

export function parsePreToolUseInput(inputText) {
  if (typeof inputText !== "string" || inputText.length === 0) {
    throw new ShellPolicyError("Hook input is empty.", { code: "shell_policy_hook_input_invalid" });
  }

  let input;
  try {
    input = JSON.parse(inputText);
  } catch (error) {
    throw new ShellPolicyError("Hook input is not valid JSON.", {
      code: "shell_policy_hook_input_invalid"
    });
  }

  if (
    !input ||
    typeof input !== "object" ||
    input.hook_event_name !== "PreToolUse" ||
    input.tool_name !== "Bash" ||
    !input.tool_input ||
    typeof input.tool_input.command !== "string"
  ) {
    throw new ShellPolicyError("Hook input is not a valid Bash PreToolUse event.", {
      code: "shell_policy_hook_input_invalid"
    });
  }

  return input.tool_input.command;
}
