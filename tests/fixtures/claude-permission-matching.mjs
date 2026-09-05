/**
 * A test-only model of Claude Code's documented Bash permission matching.
 *
 * It exists so the deny-rule coverage tests can prove, without a live Claude,
 * that the static rules alone - with no hook involved, which is exactly what
 * a hook timeout or failure leaves behind - deny every prohibited spelling.
 *
 * Documented facts mirrored here:
 * - A deny rule fires when ANY subcommand of a compound matches it.
 * - Compounds split on shell operators, and deny rules also apply inside
 *   subshells, command substitution, and control-flow bodies (mirrored by
 *   splitting on those delimiters too).
 * - A `*` in a Bash rule matches any text at any position.
 * - A sole trailing ` *` (space before it, the only wildcard) also matches
 *   the bare command.
 * - Leading `VAR=` assignments are skipped before a deny rule is matched.
 * - Matching is case-sensitive. Only PowerShell and WebFetch rules are
 *   documented as case-insensitive; Bash rules are documented nowhere as
 *   such, so the model assumes sensitivity and the case-variant residue is
 *   pinned as hook-judged rather than rule-covered.
 *
 * Deliberate model limits:
 * - No wrapper stripping. The model matches the raw subcommand text, while
 *   Claude additionally strips a fixed wrapper set (timeout, time, nice,
 *   nohup, stdbuf, command, builtin, noglob) before matching. For the corpus
 *   below that can only add denials, never remove them: every wrapper chain
 *   the model denies via a space-separated shape, Claude also denies either
 *   via the same shape pre-strip or via a first-position shape post-strip,
 *   and every first-position shape is asserted to exist statically.
 * - The model matches split parts only, never the whole compound at once.
 *   For rule shapes without operators inside (all of ours), a whole-command
 *   match implies a part match everywhere the verdicts below depend on it.
 * - Only the `Bash(...)` tool with `*` wildcards is modeled. Any other shape
 *   throws, so a rule using an unmodeled spelling fails the test loudly
 *   instead of being silently treated as non-matching.
 */

const RULE_PATTERN = /^Bash\((.+)\)$/u;
const SUBCOMMAND_SPLIT = /[;&|\n()`$]+/u;
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleToRegExp(rule) {
  const match = RULE_PATTERN.exec(rule);
  if (!match) throw new Error("Unsupported permission rule shape: " + rule);
  const pattern = match[1];
  if (pattern.includes(":*")) throw new Error("Unsupported permission rule spelling (use `*`): " + rule);
  const starCount = (pattern.match(/\*/g) || []).length;
  // A sole trailing ` *` also matches the bare command.
  if (starCount === 1 && pattern.endsWith(" *")) {
    return new RegExp("^" + escapeRegExp(pattern.slice(0, -2)) + "( .*|$)", "u");
  }
  return new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$", "u");
}

function stripAssignments(subcommand) {
  const tokens = subcommand.split(/\s+/u).filter((token) => token.length > 0);
  while (tokens.length > 0 && ASSIGNMENT_PREFIX.test(tokens[0])) tokens.shift();
  return tokens.join(" ");
}

export function splitBashSubcommands(command) {
  return String(command)
    .split(SUBCOMMAND_SPLIT)
    .map((part) => stripAssignments(part.trim()))
    .filter((part) => part.length > 0);
}

/**
 * Returns the first deny rule that fires for this command, or undefined.
 * A rule fires when it matches any subcommand after assignment stripping.
 */
export function firstMatchingBashDenyRule(rules, command) {
  const subcommands = splitBashSubcommands(command);
  for (const rule of rules) {
    const expression = ruleToRegExp(rule);
    if (subcommands.some((subcommand) => expression.test(subcommand))) return rule;
  }
  return undefined;
}

export function bashCommandDeniedByRules(rules, command) {
  return firstMatchingBashDenyRule(rules, command) !== undefined;
}
