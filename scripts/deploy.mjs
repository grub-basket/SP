#!/usr/bin/env node
// Copy the three plugin artifacts (main.js, manifest.json, styles.css)
// into the vault's plugin folder. Replaces a symlink-based setup that
// Obsidian Sync was indexing slowly.
//
// Configure the destination once:
//   - Either set STASHPAD_DEPLOY in your environment.
//   - Or create a `.deploy-target` file at the project root containing
//     the absolute path of the vault plugin folder, e.g.:
//         /Users/you/Vault/.obsidian/plugins/stashpad
//     The file is gitignored.
//
// Usage:
//   npm run deploy           — build + copy
//   npm run deploy:files     — copy only (no build)

import { existsSync, readFileSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use fileURLToPath so spaces (and other URL-encoded chars) in the
// project path don't break the resolved filesystem path.
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

function resolveTargets() {
  // Multiple targets supported: STASHPAD_DEPLOY or `.deploy-target` may list ONE
  // PATH PER LINE (blank lines + `#` comments ignored). EVERY target is updated on
  // each deploy — keep the Plugin Test vault and the Claude Dev Vault in sync so
  // live testing never runs a stale build.
  const fromText = (raw) => raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => resolve(l));
  const envTarget = process.env.STASHPAD_DEPLOY?.trim();
  if (envTarget) return fromText(envTarget);
  const cfgPath = join(ROOT, ".deploy-target");
  if (existsSync(cfgPath)) {
    const targets = fromText(readFileSync(cfgPath, "utf8"));
    if (targets.length) return targets;
  }
  return [];
}

function fail(msg) {
  console.error(`\n[deploy] ${msg}\n`);
  process.exit(1);
}

const targets = resolveTargets();
if (targets.length === 0) {
  fail(
    "No deploy target configured. Set STASHPAD_DEPLOY env var or create a\n" +
    ".deploy-target file at the project root with one destination path per line.\n" +
    "Example: /Users/you/MyVault/.obsidian/plugins/stashpad",
  );
}

let totalCopied = 0;
const allMissing = new Set();
for (const target of targets) {
  const targetParent = dirname(target);
  if (!existsSync(target)) {
    try { mkdirSync(target, { recursive: true }); }
    catch (e) { fail(`Couldn't create destination folder: ${target}\n${e.message}`); }
  }
  if (!existsSync(targetParent)) fail(`Parent of destination doesn't exist: ${targetParent}`);

  let copied = 0;
  for (const name of ARTIFACTS) {
    const src = join(ROOT, name);
    if (!existsSync(src)) { allMissing.add(name); continue; }
    const dst = join(target, name);
    copyFileSync(src, dst);
    const sz = statSync(dst).size;
    console.log(`[deploy] ${name.padEnd(14)} → ${dst}  (${sz} bytes)`);
    copied++;
  }
  console.log(`[deploy] copied ${copied}/${ARTIFACTS.length} → ${target}`);
  totalCopied += copied;
}
if (allMissing.size) {
  console.warn(`[deploy] WARNING: missing artifacts: ${[...allMissing].join(", ")} — did you build?`);
}
console.log(`[deploy] done — ${targets.length} target${targets.length === 1 ? "" : "s"}, ${totalCopied} file copies`);
