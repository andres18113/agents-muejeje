const COMPOSITION_PATTERN = /[\r\n;&|<>`]/u;
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

function commandBasename(token) {
  const basename = token.split(/[\\/]/u).pop().toLowerCase();
  return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
}

function rejectDangerousGit(tokens) {
  const argumentsLowercase = tokens.slice(1).map((token) => token.toLowerCase());
  const dangerousSubcommand = argumentsLowercase.find((token) => DANGEROUS_GIT_SUBCOMMANDS.has(token));
  if (dangerousSubcommand) {
    return "Git operation '" + dangerousSubcommand + "' is not allowed by the runtime shell guard.";
  }
  if (argumentsLowercase.some((token) => ["config", "remote", "clone", "init", "worktree"].includes(token))) {
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

  return shellPolicy === "git-readonly"
    ? evaluateGitReadonly(parsed.tokens)
    : evaluateWriterCommand(parsed.tokens);
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
