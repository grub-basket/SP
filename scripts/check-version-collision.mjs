/** Fail the build if the version in `manifest.json` is already claimed by a commit
 *  or tag that is NOT part of this branch's history.
 *
 *  WHY THIS EXISTS. Two parallel branches bumped to `0.485.0` from the same base on
 *  2026-09-25. The usual safety net is documented in CLAUDE.md — "expect a
 *  manifest.json/package.json version conflict on the 2nd+ merge; keep the incoming
 *  higher version" — but that only fires when the two versions DIFFER. Two branches
 *  writing the IDENTICAL string merge completely cleanly and say nothing, which is
 *  strictly worse than a conflict: the collision reaches `main` silently and only
 *  surfaces later as two different features sharing a version number. (It had
 *  already happened once before, with `0.469.0`.) A human noticing is not a control.
 *
 *  THE RULE. Look for any commit whose subject begins `<version>:` (the project's
 *  convention), or any tag naming the version, anywhere in the repo. Ignore the ones
 *  reachable from HEAD — those are this branch's own history, including a version
 *  already committed here, so a plain rebuild never trips. Anything left is another
 *  branch that got there first, and this version needs to move.
 *
 *  Deliberately NON-FATAL when git can't answer (no repo, no git binary, a shallow
 *  or exported tree). A published copy of this repo must still build; a missing
 *  branch graph is not evidence of a collision.
 */
import { readFileSync } from "fs";
import { execFileSync } from "child_process";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

let version;
try {
  version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
} catch {
  console.log("version-collision check\n  – skipped (no readable manifest.json)");
  process.exit(0);
}
if (typeof version !== "string" || !version) {
  console.log("version-collision check\n  – skipped (manifest.json has no version)");
  process.exit(0);
}

// Is this even a git repo we can reason about? If not, say so and pass.
try {
  git("rev-parse", "--is-inside-work-tree");
  git("rev-parse", "HEAD");
} catch {
  console.log(`version-collision check\n  – skipped (not a usable git repo)`);
  process.exit(0);
}

const problems = [];

// 1. Commits on ANY ref whose subject starts with "<version>:" …
let candidates = [];
try {
  const out = git("log", "--all", "--format=%H%x09%D%x09%s", `--grep=^${version}:`);
  candidates = out ? out.split("\n").filter(Boolean) : [];
} catch { /* no matches, or no refs yet */ }

// … minus the ones this branch already contains.
let reachable = new Set();
if (candidates.length) {
  for (const line of candidates) {
    const sha = line.split("\t")[0];
    try {
      git("merge-base", "--is-ancestor", sha, "HEAD");
      reachable.add(sha);
    } catch { /* not an ancestor → it lives on another branch */ }
  }
  for (const line of candidates) {
    const [sha, refs, subject] = line.split("\t");
    if (reachable.has(sha)) continue;
    const where = refs ? ` (${refs})` : "";
    problems.push(`  ${sha.slice(0, 9)}${where}  ${subject}`);
  }
}

// 2. A tag naming this version that isn't reachable either.
try {
  const tags = git("tag", "--list", version, `v${version}`);
  for (const tag of tags.split("\n").filter(Boolean)) {
    try {
      const sha = git("rev-list", "-n", "1", tag);
      git("merge-base", "--is-ancestor", sha, "HEAD");
    } catch {
      problems.push(`  tag ${tag}  (not in this branch's history)`);
    }
  }
} catch { /* no tags */ }

if (problems.length) {
  console.error(`\nversion-collision check FAILED — ${version} is already claimed outside this branch:\n`);
  console.error(problems.join("\n"));
  console.error(
    `\nAnother branch bumped to ${version} first. Pick the next free version in ` +
    `manifest.json AND package.json, then rebuild.\n` +
    `Merging will NOT warn you about this: two branches writing the same version ` +
    `string merge without a conflict.\n`,
  );
  process.exit(1);
}

console.log(`version-collision check\n  ✓ ${version} is not claimed by another branch or tag`);
