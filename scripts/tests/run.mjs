// Minimal test runner for the plugin's PURE (DOM-free) modules. esbuild
// transpiles a TS test entry to ESM in a temp file, we import it, and it throws
// on the first failed assertion. Run with `node scripts/tests/run.mjs`.
import esbuild from "esbuild";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const ENTRIES = [
  "scripts/tests/config-layout.test.ts",
  "scripts/tests/md-tables.test.ts",
];

let passed = 0;
export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  passed++;
}
export function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`ASSERT FAILED: ${msg}\n  expected ${B}\n  got      ${A}`);
  passed++;
}

const dir = mkdtempSync(join(tmpdir(), "sp-tests-"));
for (const entry of ENTRIES) {
  const out = join(dir, entry.replace(/[\/.]/g, "_") + ".mjs");
  esbuild.buildSync({
    entryPoints: [entry], bundle: true, format: "esm", platform: "node",
    outfile: out, logLevel: "silent",
    // the test files import { assert, eq } from this runner — keep it external so
    // both sides share the same counter via the injected globals below.
    banner: { js: "globalThis.__assert=(c,m)=>{if(!c)throw new Error('ASSERT FAILED: '+m);globalThis.__passed=(globalThis.__passed||0)+1;};globalThis.__eq=(a,b,m)=>{const A=JSON.stringify(a),B=JSON.stringify(b);if(A!==B)throw new Error('ASSERT FAILED: '+m+'\\n  expected '+B+'\\n  got      '+A);globalThis.__passed=(globalThis.__passed||0)+1;};" },
  });
  await import(pathToFileURL(out));
  console.log(`✓ ${entry}`);
}
console.log(`\nAll tests passed (${globalThis.__passed} assertions).`);
