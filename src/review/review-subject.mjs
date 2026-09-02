import { decodePathForDisplay } from "../changeset/porcelain-parser.mjs";

/**
 * The evidence block handed to a reviewer.
 *
 * Reviewers run with Read, Grep and Glob and no shell, so they cannot run Git
 * and cannot discover their own change set. This block is the only channel by
 * which the orchestrator's collected evidence reaches them.
 *
 * The wording is load-bearing. This text is composed BEFORE the review runs, at
 * a point where the only true statement is that admission is held right now.
 * Whether it stayed held across the whole interval is not knowable yet - it is
 * verified after the reviewer finishes and before any receipt is written. So
 * nothing here may claim the interval was coherent; only a successful
 * ReviewReceipt gets to make that claim, and it makes it afterwards. Getting
 * this wrong would have the orchestrator asserting a guarantee it has not yet
 * earned, inside the very prompt whose output the guarantee is about.
 */

export const MAX_REVIEW_SUBJECT_PATHS = 200;

const SECTION_TITLE = "REVIEW SUBJECT";

function renderTarget(target) {
  if (!target || target.spec?.kind !== "ref") {
    return "Target: none declared (no target ref was supplied for this review)";
  }
  const provenance = target.spec.source === "request"
    ? "supplied with this request"
    : "inherited from the worktree that produced these changes";
  if (target.resolution === "resolved") {
    return "Target: " + target.spec.ref + " at " + target.commit + " (" + provenance + ")";
  }
  return "Target: " + target.spec.ref + " (" + provenance + ") — this ref does not currently resolve";
}

function renderPaths(descriptor) {
  const lines = [];
  for (const entry of descriptor.index) {
    lines.push(entry.x + ". " + decodePathForDisplay(entry.path) + "   [staged]");
  }
  for (const entry of descriptor.worktree) {
    lines.push("." + entry.y + " " + decodePathForDisplay(entry.path) + "   [unstaged]");
  }
  for (const entry of descriptor.unmerged) {
    lines.push(entry.xy + " " + decodePathForDisplay(entry.path) + "   [conflicted]");
  }
  for (const entry of descriptor.untracked) {
    lines.push("?? " + decodePathForDisplay(entry.path) + "   [untracked]");
  }
  return lines;
}

function coherenceSentence(coherence) {
  if (coherence === "held") {
    return "Coherent review admission is currently held: this orchestrator's own managed writers " +
      "are excluded from this repository right now. Whether that admission survives the whole " +
      "review is verified after you finish, before any evidence is recorded. Do not assume it held " +
      "throughout.";
  }
  return "Coherent review admission was NOT obtained, so this review is advisory and will not be " +
    "bound to a recorded change set. Managed writers may be modifying this repository while you " +
    "work; treat the state below as a starting point, not as a stable subject.";
}

/**
 * @param subject { status, coherence, changeSetId?, descriptor?, reasons? }
 */
export function formatReviewSubjectBlock(subject, { maxPaths = MAX_REVIEW_SUBJECT_PATHS } = {}) {
  const lines = [SECTION_TITLE, "=".repeat(SECTION_TITLE.length), ""];

  if (subject.status !== "exact") {
    const codes = (subject.reasons ?? []).map((reason) => reason.code).join(", ");
    lines.push(
      "An exact change-set identity for this repository is unavailable.",
      codes ? "Reason: " + codes : "Reason: unknown",
      "",
      coherenceSentence(subject.coherence),
      "",
      "Establish the review scope from the Assignment alone. If the Assignment does not supply " +
        "sufficient concrete scope, do not report a clean review: report that review scope could " +
        "not be established and name the missing evidence."
    );
    return lines.join("\n");
  }

  const descriptor = subject.descriptor;
  const counts = descriptor.summary.counts;

  lines.push(
    "ChangeSetId: " + subject.changeSetId,
    descriptor.head.unborn
      ? "HEAD: unborn (this repository has no commits yet)"
      : "HEAD: " + descriptor.head.commit,
    renderTarget(descriptor.target),
    "Merge base: " + (descriptor.summary.mergeBase ?? "not applicable"),
    "Branch: " + (descriptor.summary.branch ?? (descriptor.summary.detached ? "detached HEAD" : "unknown")),
    "",
    "Changed paths — staged " + counts.index +
      ", unstaged " + counts.worktree +
      ", conflicted " + counts.unmerged +
      ", untracked " + counts.untracked +
      ", submodules " + counts.submodules,
    ""
  );

  const paths = renderPaths(descriptor);
  for (const line of paths.slice(0, maxPaths)) lines.push("  " + line);
  if (paths.length > maxPaths) {
    lines.push(
      "  [" + (paths.length - maxPaths) + " additional paths omitted — state in your review that " +
        "your reported scope was truncated]"
    );
  }

  lines.push(
    "",
    "This is the exact repository state observed immediately before this review started. " +
      "Ignored files are outside this change set.",
    coherenceSentence(subject.coherence)
  );

  return lines.join("\n");
}
