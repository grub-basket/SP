/** Fail the build if the version in `manifest.json` is already claimed by another
 *  branch — via a commit, a tag, or a RESERVATION on the parallel board.
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
 *  THE RULE. Look for any commit whose subject ANNOUNCES the version — the styles in
 *  use differ per repo (`0.4.0:`, `0.4.0 —`, `Release 0.4.0 —`, `Merge x (0.4.0):`),
 *  all handled below — or any tag naming it, anywhere in the repo. Ignore the ones
 *  reachable from HEAD — those are this branch's own history, including a version
 *  already committed here, so a plain rebuild never trips. Anything left is another
 *  branch that got there first, and this version needs to move.
 *
 *  RESERVATIONS (the part that catches it EARLIER). A commit only exists after
 *  someone has already done the work under the colliding number. `/parallel` workers
 *  therefore reserve their version on `.claude/parallel/BOARD.md` when they claim a
 *  lane, before the first bump — so this check also reads that board's `version`
 *  column and flags a number another BRANCH has reserved but not yet committed.
 *  Matching is on branch, not on worker id: that works for a human running the build
 *  too, and needs no session environment.
 *
 *  A reservation is considered SPENT once a commit for that version is reachable from
 *  HEAD — otherwise every merge of a finished lane would leave its row flagging the
 *  version that just landed.
 *
 *  Deliberately NON-FATAL when git can't answer (no repo, no git binary, a shallow
 *  or exported tree). A published copy of this repo must still build; a missing
 *  branch graph is not evidence of a collision.
 */
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";

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

// 1. Commits on ANY ref whose subject ANNOUNCES this version.
//
// The subject convention is NOT the same across this author's repos, and a pattern
// that only matched one of them would make this check a silent no-op elsewhere —
// worse than absent, because it reports a confident ✓. Surveyed 2026-09-25:
//   stashpad / gridsense / draft-tabs / highlight-migrator / tab-focus-history
//                              "0.24.0: summary"        (colon)
//   trynalist                  "0.65.2 — summary"       (em dash)
//   bases-toolbox              "Release 0.1.68 — …"     ("Release " prefix)
//   any repo                   "Merge <branch> (0.4.0): …"  (merge commits)
//
// So: ask git for every subject CONTAINING the version (cheap, over-broad), then
// decide here with anchored patterns. Doing the matching in JS rather than in
// `--grep` also sidesteps git's regex dialect and any escaping of `.` in a version.
const vEsc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANNOUNCES = [
  new RegExp(`^v?${vEsc}\\s*[:\\u2014\\u2013-]`),   // "0.4.0:"  "0.4.0 —"  "v0.4.0 -"
  new RegExp(`^v?${vEsc}\\s*$`),                    // bare "0.4.0"
  new RegExp(`^Release\\s+v?${vEsc}\\b`, "i"),      // "Release 0.1.68 — …"
  new RegExp(`\\(v?${vEsc}\\)`),                    // "Merge feat/x (0.4.0): …"
];
const announces = (subject) => ANNOUNCES.some((re) => re.test(subject));

let candidates = [];
try {
  // `--fixed-strings` so the version's dots are literal.
  const out = git("log", "--all", "--format=%H%x09%D%x09%s", "--grep", version, "--fixed-strings");
  candidates = (out ? out.split("\n").filter(Boolean) : [])
    .filter((line) => announces(line.split("\t")[2] ?? ""));
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

// 1b. A RESERVATION on the parallel board held by a different branch.
//
// The board lives in the MAIN checkout — a linked worktree has its own folder, so
// `.claude/parallel/BOARD.md` relative to cwd would be the worktree's copy (or
// missing). `--git-common-dir` points at the main checkout's `.git`, so its parent is
// the shared root. This is what makes the check work from inside a worktree, which is
// where parallel workers actually build.
//
// A reservation is SPENT once this branch already ships the version. Two signals:
//
//   • `HEAD:manifest.json` already names it — the bump is committed here, so a
//     rebuild must not trip. This is the load-bearing one, and the naive version of
//     this check got it wrong: it only looked for a commit SUBJECT starting
//     `<version>:`, but a version can land via a MERGE commit ("Merge <branch>
//     (0.490.0): …"), which matches nothing. That produced a false positive on
//     `main` immediately after merging a finished lane — the row was still there,
//     correctly, and the build refused.
//   • a reachable commit subject (`reachable`), which covers a squashed or
//     differently-worded history where the manifest has since moved on.
let headVersion = "";
try { headVersion = JSON.parse(git("show", "HEAD:manifest.json")).version || ""; } catch { /* no manifest at HEAD */ }
const alreadyShipped = headVersion === version || reachable.size > 0;

if (!alreadyShipped) {
  try {
    const sharedRoot = dirname(git("rev-parse", "--git-common-dir"));
    const boardPath = join(sharedRoot, ".claude", "parallel", "BOARD.md");
    const board = readFileSync(boardPath, "utf8");
    let branch = "";
    try { branch = git("rev-parse", "--abbrev-ref", "HEAD"); } catch { /* detached */ }

    // Locate the `version` column by header name rather than by position, so adding
    // or reordering columns later doesn't silently turn this check off.
    const lines = board.split("\n");
    const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /\bversion\b/i.test(l) && /\bbranch\b/i.test(l));
    if (headerIdx >= 0) {
      const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
      const header = cells(lines[headerIdx]).map((h) => h.toLowerCase());
      const vCol = header.indexOf("version");
      const bCol = header.indexOf("branch");
      if (vCol >= 0 && bCol >= 0) {
        for (const line of lines) {
          if (!/^\s*\|/.test(line) || line === lines[headerIdx]) continue;
          if (/^\s*\|[\s|:-]*\|\s*$/.test(line)) continue;       // the |---|---| separator
          const c = cells(line);
          if (c.length <= Math.max(vCol, bCol)) continue;
          const rowVersion = c[vCol].replace(/[`*]/g, "").trim();
          if (rowVersion !== version) continue;
          const rowBranch = c[bCol].replace(/[`*]/g, "").trim();
          // "Mine" = the row names my branch. Lenient `includes` because a row's
          // branch cell is hand-written and sometimes lists more than one branch.
          if (branch && rowBranch.includes(branch)) continue;
          problems.push(`  BOARD reservation  ${rowVersion}  held by branch "${rowBranch}"  (.claude/parallel/BOARD.md)`);
        }
      }
    }
  } catch { /* no board, or unreadable — reservations are an optional layer */ }
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
    `\nAnother branch got to ${version} first. Pick the next free version in ` +
    `manifest.json AND package.json, update your row's \`version\` cell on ` +
    `.claude/parallel/BOARD.md, then rebuild.\n` +
    `Merging will NOT warn you about this: two branches writing the same version ` +
    `string merge without a conflict.\n`,
  );
  process.exit(1);
}

console.log(`version-collision check\n  ✓ ${version} is free (no commit, tag, or board reservation on another branch)`);
