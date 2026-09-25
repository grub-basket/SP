/** 0.485.0 — fail the build if anything outside src/leaf-lookup.ts picks a
 *  SINGLE Stashpad leaf straight out of `getLeavesOfType(STASHPAD_VIEW_TYPE)`.
 *
 *  Why a dedicated runner rather than leaning on `pnpm run lint`: that command
 *  currently reports ~626 pre-existing errors from the obsidianmd type-aware
 *  preset, so one more error in the pile is invisible and blocks nothing. This
 *  reports ONLY the leaf-lookup rule and exits non-zero on a hit, so the mistake
 *  actually stops a build instead of being buried.
 *
 *  Rule + rationale live in eslint.config.mjs; the sanctioned helpers live in
 *  src/leaf-lookup.ts. Shipped after the same bug appeared a third time
 *  (0.68.1, 0.484.0, 0.484.1).
 */
import { ESLint } from "eslint";

const RULE = "no-restricted-syntax";
const eslint = new ESLint();
const results = await eslint.lintFiles(["src"]);

const hits = [];
for (const r of results) {
  for (const m of r.messages) {
    if (m.ruleId === RULE) hits.push(`  ${r.filePath.replace(process.cwd() + "/", "")}:${m.line}  ${m.message}`);
  }
}

if (hits.length) {
  console.error(`\nleaf-lookup check FAILED — ${hits.length} single-leaf pick(s) outside src/leaf-lookup.ts:\n`);
  console.error(hits.join("\n"));
  console.error("\ngetLeavesOfType() is in TAB order. Use the helpers in src/leaf-lookup.ts.\n");
  process.exit(1);
}
console.log("leaf-lookup check\n  ✓ no unguarded single-leaf picks outside src/leaf-lookup.ts");
