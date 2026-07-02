// Release validation — a cheap structural gate that runs on every production
// build (see package.json "build"), so a broken artifact never ships a version.
//
// Why this exists: 0.122.9 shipped a CSS comment containing "mod-*/is-frameless".
// The "*/" closed the comment early; the leftover text ran into the next rule's
// selector and CSS parsers silently dropped that rule (Windows/Linux frameless
// padding). Nothing caught it — typecheck only sees TS, eslint only lints src/,
// and styles.css is merely copied to the vault, never parsed.
//
// The class of bug is "syntax that's technically balanced but corrupts a rule",
// which a brace/comment-counter would miss — so we run a REAL CSS parse via
// esbuild (already a dependency) and fail on any warning. Plus JSON validity,
// version agreement, and a built-artifact sanity check.

import esbuild from "esbuild";
import { readFileSync, statSync } from "fs";
import vm from "vm";

let failed = false;
const fail = (m) => { console.error("  ✗ " + m); failed = true; };
const pass = (m) => console.log("  ✓ " + m);

const fmtLoc = (loc) => (loc ? ` (line ${loc.line}, col ${loc.column})` : "");

// 1. CSS — real parse. esbuild reports parse problems as warnings (and hard
//    syntax errors as thrown errors); treat either as a release blocker.
console.log("styles.css");
try {
  const css = readFileSync("styles.css", "utf8");
  const res = await esbuild.transform(css, { loader: "css" });
  if (res.warnings.length) {
    for (const w of res.warnings) fail(`styles.css: ${w.text}${fmtLoc(w.location)}`);
  } else {
    pass("parses clean");
  }
} catch (e) {
  const errs = e.errors ?? [{ text: e.message }];
  for (const m of errs) fail(`styles.css: ${m.text}${fmtLoc(m.location)}`);
}

// 2. manifest.json — valid JSON + required Obsidian fields present and
//    non-empty + version agrees with package.json. A manifest that's valid
//    JSON but missing/blank a required field still loads-fails or trips store
//    review, so JSON-validity alone isn't enough.
console.log("manifest.json");
let manifest = null, pkgVer = null;
try { manifest = JSON.parse(readFileSync("manifest.json", "utf8")); pass("valid JSON"); }
catch (e) { fail(`manifest.json: ${e.message}`); }
if (manifest) {
  let fieldsOk = true;
  const bad = (m) => { fail(m); fieldsOk = false; };
  // Obsidian's required manifest keys (string, non-empty).
  for (const k of ["id", "name", "version", "minAppVersion", "description", "author"]) {
    if (typeof manifest[k] !== "string" || manifest[k].trim() === "") bad(`manifest.json: "${k}" must be a non-empty string`);
  }
  // isDesktopOnly is optional but, if present, must be a boolean (a stray
  // "true"/0 silently changes platform gating).
  if ("isDesktopOnly" in manifest && typeof manifest.isDesktopOnly !== "boolean") bad(`manifest.json: "isDesktopOnly" must be a boolean`);
  // version should look like a plain semver (no leading "v" — Obsidian's
  // tag convention — and store review rejects odd version strings).
  if (typeof manifest.version === "string" && !/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.version)) {
    bad(`manifest.json: version "${manifest.version}" is not a plain N.N.N(.N) string`);
  }
  if (fieldsOk) pass(`required fields present (id "${manifest.id}", v${manifest.version}, minApp ${manifest.minAppVersion})`);
}
try { pkgVer = JSON.parse(readFileSync("package.json", "utf8")).version; pass(`package.json valid (v${pkgVer})`); }
catch (e) { fail(`package.json: ${e.message}`); }
if (manifest?.version && pkgVer) {
  if (manifest.version !== pkgVer) fail(`version mismatch: manifest ${manifest.version} vs package ${pkgVer}`);
  else pass("manifest/package versions match");
}

// 3. main.js — size floor AND a real parse. The size floor catches a grossly
//    empty/half-written file; the parse (vm.Script compiles WITHOUT executing)
//    catches truncation/corruption that left syntactically broken JS — e.g. a
//    build killed mid-write. Parsing ≠ running, so this is side-effect-free.
console.log("main.js");
try {
  const js = readFileSync("main.js", "utf8");
  if (js.length < 1024) {
    fail(`main.js is only ${js.length} bytes — did the production build run?`);
  } else {
    try {
      new vm.Script(js, { filename: "main.js" }); // throws on a syntax/parse error
      pass(`present + parses (${Math.round(js.length / 1024)} KB)`);
    } catch (e) {
      fail(`main.js failed to parse (truncated/corrupt build?): ${e.message}`);
    }
  }
} catch { fail("main.js missing — run `pnpm run build` first"); }

if (failed) {
  console.error("\nRelease validation FAILED — fix the above before shipping a version.");
  process.exit(1);
}
console.log("\nRelease validation passed.");
