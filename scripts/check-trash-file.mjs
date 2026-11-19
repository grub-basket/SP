/** 0.610.0 — fail the build if anything outside src/trash.ts calls
 *  `fileManager.trashFile(` directly.
 *
 *  From Obsidian 1.15.1, `trashFile` resolves to `false` and leaves the file in
 *  place when the system trash refuses it. Callers that don't check would think
 *  the file is gone. `trashVaultFile()` in src/trash.ts handles that case (falls
 *  back to the vault's `.trash`), so every delete must go through it.
 *
 *  A plain text scan, not ESLint: it flags any `.trashFile(` (aliases and
 *  split chains included); comment lines are skipped; opt a line out with a
 *  `trash-file: ok` comment on it or the line above. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set(["src/trash.ts"]);
// Any `.trashFile(` — not just `fileManager.trashFile(` — so an alias
// (`const fm = app.fileManager; fm.trashFile(f)`) or a chain split across lines
// (`app.fileManager` / `.trashFile(f)`) is caught too. `trashVaultFile(` has no
// dot before "trashFile", so the helper's own call sites never match.
const PATTERN = /\.\s*trashFile\s*\(/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk("src")) {
  if (ALLOWED.has(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!PATTERN.test(line)) return;
    const t = line.trim();
    // Comment lines. A line that OPENS a block comment counts only if the
    // comment doesn't close before the call (`/* x */ app.fileManager.trashFile(f)`).
    if (t.startsWith("//") || t.startsWith("*")) return;
    if (t.startsWith("/*") && !/\*\/.*\.\s*trashFile\s*\(/.test(t)) return;
    if (line.includes("trash-file: ok") || (lines[i - 1] ?? "").includes("trash-file: ok")) return;
    hits.push(`  ${file}:${i + 1}  ${t.slice(0, 120)}`);
  });
}

if (hits.length) {
  console.error(`\ntrash-file check FAILED — ${hits.length} direct fileManager.trashFile call(s):\n`);
  console.error(hits.join("\n"));
  console.error("\nUse trashVaultFile(app, file) from src/trash.ts (handles Obsidian 1.15.1's `false` result).\n");
  process.exit(1);
}
console.log("trash-file check\n  ✓ every delete goes through trashVaultFile (src/trash.ts)");
