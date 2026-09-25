/** 0.486.0 — every Stashpad-spawned tab should hand focus back when it closes.
 *
 *  Obsidian's default on closing a tab is to activate the tab to its RIGHT,
 *  which is almost never where the user was. `returnToOriginOnClose`
 *  (src/leaf-return.ts) fixes that per spawned tab — but only where it is
 *  actually called, and three openers were silently missing it until 0.486.0
 *  (Reveal-or-open Stashpad, open saved view, deep-link "open").
 *
 *  "Did you wire the return?" is not a syntactic property, so this is a
 *  proximity check rather than an eslint rule: for each `getLeaf("tab")`, look
 *  ahead a short window for `returnToOriginOnClose`. If it is genuinely not
 *  wanted, say so explicitly with a marker comment near the call:
 *
 *      // tab-return: n/a — <why>
 *
 *  The point is not to be clever, it is to make forgetting impossible and
 *  opting out deliberate.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = "src";
const LOOKAHEAD = 30;
const OPENER = /\.getLeaf\(\s*["']tab["']\s*\)/;
const WIRED = /returnToOriginOnClose/;
const OPTOUT = /tab-return:\s*n\/a/;

/** A line that plainly starts a NEW declaration. The lookahead stops here so a
 *  wired opener in the NEXT function cannot vouch for an unwired one above it —
 *  which a plain N-line window does, and which let a deliberately planted
 *  regression pass on the first attempt at this script. */
const BOUNDARY = /^\s*(\/\*\*|export\s|function\s|(private|public|protected|static)\s)/;

const files = (await readdir(SRC)).filter((f) => f.endsWith(".ts"));
const problems = [];

for (const f of files) {
  const path = join(SRC, f);
  const lines = (await readFile(path, "utf8")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!OPENER.test(lines[i])) continue;
    // Walk forward to the end of THIS declaration (or the lookahead cap).
    let end = i + 1;
    const cap = Math.min(lines.length, i + LOOKAHEAD);
    while (end < cap && !BOUNDARY.test(lines[end])) end++;
    const from = Math.max(0, i - 3);
    const window = lines.slice(from, end).join("\n");
    // COUNT, don't just detect. A single `returnToOriginOnClose` cannot vouch
    // for two openers in the same function — that blind spot let a second,
    // deliberately unwired opener pass while the first was correctly wired.
    const count = (re) => (window.match(new RegExp(re.source, "g")) ?? []).length;
    const openers = count(OPENER);
    const accounted = count(WIRED) + count(OPTOUT);
    if (accounted >= openers) continue;
    problems.push(`  ${path}:${i + 1}  ${lines[i].trim().slice(0, 90)}`);
  }
}

if (problems.length) {
  console.error(`\ntab-opener check FAILED — ${problems.length} new-tab opener(s) with no return-on-close:\n`);
  console.error(problems.join("\n"));
  console.error(`\nWire returnToOriginOnClose(ws, leaf, prev, ref => plugin.registerEvent(ref)) —`);
  console.error(`capture \`prev\` BEFORE getLeaf("tab") — or mark it \`// tab-return: n/a — <why>\`.\n`);
  process.exit(1);
}
console.log(`tab-opener check\n  ✓ all ${files.length > 0 ? "" : ""}new-tab openers wire return-on-close (or opt out explicitly)`);
