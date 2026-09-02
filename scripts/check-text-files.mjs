import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Why tracked text is checked for raw control bytes at all.
 *
 * A literal NUL makes Git classify a file as binary. The file then disappears
 * from every diff, review, and blame that the rest of this system's evidence
 * depends on, silently and without any error. That is the hard failure.
 *
 * The other C0 controls and DEL do not change Git's classification, but they
 * are invisible in every editor and review surface, which is its own hazard:
 * a `\b` word-boundary escape that decayed into a literal backspace turned a
 * real assertion into one that could never match, and nothing showed it. Source
 * that needs these characters writes them as escapes, where they can be read.
 *
 * Tab, line feed, and carriage return are ordinary text and are allowed.
 */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

const DIFFABLE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs",
  ".ps1", ".ts", ".txt", ".yaml", ".yml"
]);
const DIFFABLE_NAMES = new Set([".gitattributes", ".gitignore", ".npmrc"]);

export function isExpectedDiffableText(file) {
  const name = path.basename(file).toLowerCase();
  return DIFFABLE_NAMES.has(name) || DIFFABLE_EXTENSIONS.has(path.extname(name));
}

export function isForbiddenControlByte(byte) {
  if (ALLOWED_CONTROL_BYTES.has(byte)) return false;
  return byte < 0x20 || byte === 0x7f;
}

export function listTrackedDiffableFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  return output.split("\0").filter(Boolean).filter(isExpectedDiffableText).sort();
}

/**
 * Returns one entry per offending file with the distinct forbidden byte values
 * it contains, so a failure names what to look for rather than only where.
 */
export async function findControlCharacterFiles({ root, files = listTrackedDiffableFiles(root) }) {
  const matches = [];
  for (const file of files) {
    const contents = await readFile(path.join(root, file));
    const codes = new Set();
    for (const byte of contents) {
      if (isForbiddenControlByte(byte)) codes.add(byte);
    }
    if (codes.size > 0) {
      matches.push({
        file,
        codes: [...codes].sort((a, b) => a - b).map((code) => "0x" + code.toString(16).padStart(2, "0"))
      });
    }
  }
  return matches;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const matches = await findControlCharacterFiles({ root });
  if (matches.length > 0) {
    const shown = matches
      .slice(0, 20)
      .map((match) => "  " + match.file + " (" + match.codes.join(", ") + ")")
      .join("\n");
    throw new Error(
      "Tracked source/text files contain raw control characters; use source escapes instead:\n" + shown
    );
  }
  console.log("Tracked diffable source/text files contain no raw control characters.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
