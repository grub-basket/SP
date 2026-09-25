// Delegating shim — the real driver is the SHARED one at
// <workspace>/_obs-dev/scripts/obs-dev.mjs, used by every Obsidian plugin repo
// (unified 2026-09-24; it used to be a per-repo copy that kept drifting).
// This file only locates it — by walking up from here, so it works from the main
// checkout AND from any worktree — marks this repo as the plugin under test, and
// hands over. All flags/commands/env vars are the shared driver's:
//   [OBS_DEV_SLOT=<a-z>] scripts/obs-dev start|verify|eval|reload|banner|slots|make-vault|stop|…
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.OBS_DEV_REPO ||= resolve(here, "..");
let d = here, driver = null;
for (;;) {
  const cand = join(d, "_obs-dev", "scripts", "obs-dev.mjs");
  if (existsSync(cand)) { driver = cand; break; }
  const up = dirname(d);
  if (up === d) break;
  d = up;
}
if (!driver) {
  console.error("obs-dev: shared driver not found (expected _obs-dev/scripts/obs-dev.mjs in a folder above this repo). It's local dev tooling, not part of the plugin.");
  process.exit(1);
}
await import(pathToFileURL(driver).href);
