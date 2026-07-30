// Dedicated test-instance driver for Stashpad.
//
// Launches a SEPARATE Obsidian instance (its own --user-data-dir) that opens ONLY
// the Claude Dev Vault, with a CDP remote-debugging port. Claude drives that
// instance exclusively, so your normal Obsidian (real vaults, no debug port) is
// completely invisible to it. No more risk of touching real work mid-test.
//
// Usage (via the scripts/obs-dev wrapper, or `node scripts/obs-dev.mjs <cmd>`):
//   obs-dev start              launch (or reuse) the dev instance + verify it's the right vault
//   obs-dev verify             confirm the debug-port instance IS the Claude Dev Vault (+ sentinel)
//   obs-dev eval '<js>'        run JS with `app` in scope against the dev instance
//   obs-dev eval-file <path>   run a JS file's contents
//   obs-dev reload             full renderer reload (picks up a fresh `pnpm run deploy`)
//   obs-dev screenshot <path>  PNG screenshot of the dev instance
//   obs-dev stop               quit the dev instance
//
// Node 18+ (global fetch / WebSocket). macOS paths.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
// 0.201.x: SLOT support — `OBS_DEV_SLOT=b obs-dev …` drives a SECOND isolated
// instance (own port + user-data-dir) pinned to "Claude Dev Vault B", for
// cross-vault feature testing. Default slot is the original Claude Dev Vault.
// 0.208.2: slots are a TABLE, not a chain of ternaries. Slot C exists to test
// the FIRST-RUN experience, which needs a vault with zero Stashpad folders —
// A and B both have content, so neither can ever exercise the welcome gate.
// Keep C empty of Stashpad folders or it stops being useful for that.
const SLOTS = {
  a: { port: 9222, vault: "Claude Dev Vault",   sentinelFile: "CLAUDE-DEV-VAULT-SENTINEL.md",   sentinel: "claude-dev-vault-7f3a9c2e-do-not-delete",   userDataDir: "obsidian-claude-dev" },
  b: { port: 9223, vault: "Claude Dev Vault B", sentinelFile: "CLAUDE-DEV-VAULT-B-SENTINEL.md", sentinel: "claude-dev-vault-b-4e8d1f6a-do-not-delete", userDataDir: "obsidian-claude-dev-b" },
  c: { port: 9224, vault: "Claude Dev Vault C", sentinelFile: "CLAUDE-DEV-VAULT-C-SENTINEL.md", sentinel: "claude-dev-vault-c-9b2e5d31-do-not-delete", userDataDir: "obsidian-claude-dev-c" },
};
const SLOT = (process.env.OBS_DEV_SLOT || "a").toLowerCase();
const CFG = SLOTS[SLOT];
if (!CFG) { console.error(`unknown OBS_DEV_SLOT="${SLOT}" (expected one of: ${Object.keys(SLOTS).join(", ")})`); process.exit(1); }
const PORT = CFG.port;
const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const VAULT_NAME = CFG.vault;
const VAULT = resolve(REPO, "..", VAULT_NAME);
const SENTINEL_FILE = CFG.sentinelFile;
const SENTINEL = CFG.sentinel;
const USER_DATA_DIR = join(process.env.HOME, "Library", "Application Support", CFG.userDataDir);

const cmd = process.argv[2];
const arg = process.argv[3];
// Upper bound for `eval`/`eval-file` so a body that awaits something that never
// resolves (a canvas view load that stalls under CDP, a leaf.openFile on a
// .canvas that never settles) fails fast with a clear message instead of hanging.
// Generous enough for legitimately slow evals (indexing); override if needed.
const EVAL_TIMEOUT = Number(process.env.OBS_DEV_EVAL_TIMEOUT) || 30000;

// ---- CDP helpers ----------------------------------------------------------
async function portReady() {
  try {
    const r = await fetch(`http://localhost:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function pickPage() {
  const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
  return targets.find((t) => t.type === "page" && /obsidian\.md|app:\/\/obsidian/.test(t.url))
    || targets.find((t) => t.type === "page" && t.url !== "about:blank")
    || targets[0];
}

// Every CDP call is TIME-BOXED. Without a bound, a `Runtime.evaluate` whose
// awaited promise never resolves — a wedged renderer mid-reload, or a canvas
// view whose load stalls under CDP — hangs the socket forever. That unbounded
// await is what defeated the poll-with-deadline loops below: the `while
// (Date.now() < deadline)` guard is only re-checked at the TOP of the loop, so a
// single hung cdp() inside the body means the deadline is never reached. On
// timeout we close the socket and reject with an actionable message.
async function cdp(method, params, timeoutMs = 15000) {
  const page = await pickPage();
  if (!page) throw new Error("no CDP page target on port " + PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const id = 1;
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(val);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`CDP ${method} timed out after ${timeoutMs}ms — renderer unresponsive (still booting, wedged mid-reload, or a canvas/await that never resolves).`)),
      timeoutMs,
    );
    ws.onerror = () => finish(reject, new Error("ws error"));
    ws.onopen = () => {
      ws.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.id !== id) return;
        if (msg.error) finish(reject, new Error(JSON.stringify(msg.error)));
        else finish(resolve, msg.result);
      };
      ws.send(JSON.stringify({ id, method, params }));
    };
  });
}

async function rawEval(wrapped, timeoutMs) {
  return cdp("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true }, timeoutMs);
}

// Run `body` as an async-function body, JSON-stringifying its return value.
// `?? "undefined"` so a void body still prints a string rather than nothing.
const wrapBody = (body) =>
  `(async () => { try { const __r = await (async () => { ${body} })(); return JSON.stringify(__r) ?? "undefined"; } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`;

async function evalExpr(code, timeoutMs) {
  // Ergonomics: accept BOTH a bare expression (`String(2+2)` → auto-returned,
  // like a REPL) and statement code that uses its own `return` (the form
  // verify/eval-file rely on). Try expression-mode first; if it's a *syntax*
  // error (i.e. the code is multiple statements / already has `return`), fall
  // back to statement-mode. Only SyntaxErrors fall back, so a runtime-throwing
  // expression isn't executed twice. (A cdp timeout THROWS out of here — a
  // hanging body doesn't produce a SyntaxError, so it won't be retried twice.)
  let r = await rawEval(wrapBody(`return (${code})`), timeoutMs);
  const syntaxErr = r.exceptionDetails &&
    /SyntaxError/.test(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "");
  if (syntaxErr) r = await rawEval(wrapBody(code), timeoutMs);
  if (r.exceptionDetails && !r.result?.value) {
    const d = r.exceptionDetails;
    return JSON.stringify({ __error: d.exception?.description || d.text });
  }
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- vault verification (name + sentinel) ---------------------------------
// Short default timeout so the poll loops iterate promptly if the renderer is
// mid-boot; a real safety check against a live instance answers in well under 8s.
async function verifyVault(timeoutMs = 8000) {
  const raw = await evalExpr(`
    const f = app.vault.getAbstractFileByPath("${SENTINEL_FILE}");
    let sentinel = false;
    if (f) { try { sentinel = (await app.vault.cachedRead(f)).includes("${SENTINEL}"); } catch {} }
    return { name: app.vault.getName(), sentinel };
  `, timeoutMs);
  let v; try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || v.name !== VAULT_NAME || !v.sentinel) {
    throw new Error(`SAFETY ABORT — debug-port instance is NOT the Claude Dev Vault (got ${raw}). Refusing to drive.`);
  }
  return v;
}

// ---- readiness (name + sentinel + workspace.layoutReady) -------------------
// `layoutReady` is the signal the app has finished booting. Gating start()/
// reload() on it is what makes a reload immediately after start safe: we never
// fire app:reload while the workspace is still assembling.
async function probeReady(timeoutMs = 4000) {
  const raw = await evalExpr(`
    const f = app.vault.getAbstractFileByPath("${SENTINEL_FILE}");
    let sentinel = false;
    if (f) { try { sentinel = (await app.vault.cachedRead(f)).includes("${SENTINEL}"); } catch {} }
    return { name: app.vault.getName(), sentinel, layoutReady: !!(app.workspace && app.workspace.layoutReady) };
  `, timeoutMs);
  try { return JSON.parse(raw); } catch { return null; }
}

// Poll until the RIGHT vault is up AND fully booted, or throw a clear, actionable
// error at the deadline (never hangs — each probe is time-boxed by cdp()). Reads
// only; it never mutates or drives, so it's safe to run against a wrong vault
// (it just keeps waiting, then reports what it saw).
async function waitReady(ms, phase) {
  const deadline = Date.now() + ms;
  let last = "no response yet";
  while (Date.now() < deadline) {
    await sleep(700);
    if (!(await portReady())) { last = "debug port down"; continue; }
    let v = null;
    try { v = await probeReady(); } catch (e) { last = e.message; continue; }
    if (!v) { last = "probe unparseable"; continue; }
    if (v.name !== VAULT_NAME || !v.sentinel) { last = `wrong/unverified vault (name=${v.name}, sentinel=${v.sentinel})`; continue; }
    if (!v.layoutReady) { last = "vault up but workspace.layoutReady still false (booting)"; continue; }
    return v;
  }
  throw new Error(`dev instance not ready (${phase}) within ${Math.round(ms / 1000)}s — last state: ${last}. Try 'obs-dev stop' then 'obs-dev start'.`);
}

// ---- launch ---------------------------------------------------------------
function seedConfig() {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const cfgPath = join(USER_DATA_DIR, "obsidian.json");
  let cfg = { vaults: {} };
  if (existsSync(cfgPath)) { try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { /* reseed */ } }
  cfg.vaults = cfg.vaults || {};
  // Mark every known vault closed, then open ONLY the Claude Dev Vault.
  for (const k of Object.keys(cfg.vaults)) cfg.vaults[k].open = false;
  let key = Object.keys(cfg.vaults).find((k) => cfg.vaults[k].path === VAULT);
  if (!key) { key = "claudedev"; cfg.vaults[key] = { path: VAULT }; }
  cfg.vaults[key].open = true;
  cfg.vaults[key].ts = Date.now();
  writeFileSync(cfgPath, JSON.stringify(cfg));
}

// Obsidian auto-updates by writing a newer `obsidian-<ver>.asar` into the
// user-data-dir (NOT the .app bundle), and loads the newest asar present there.
// The dev profile is isolated, so it never receives those updates and runs the
// bundled (older, stable) version — which can render/behave differently from the
// user's main app (e.g. the 1.13 declarative-settings API is absent on stable, so
// dev tests silently exercise a different code path). Mirror the main profile's
// newest asar into the dev profile so the dev instance matches the real app.
const MAIN_OBSIDIAN_DIR = join(process.env.HOME, "Library", "Application Support", "obsidian");
function syncInsiderAsar() {
  try {
    if (!existsSync(MAIN_OBSIDIAN_DIR)) return;
    const verOf = (f) => (f.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (verOf(a)[i] ?? 0) - (verOf(b)[i] ?? 0); if (d) return d; } return 0; };
    const asars = readdirSync(MAIN_OBSIDIAN_DIR).filter((f) => /^obsidian-.*\.asar$/.test(f)).sort(cmp);
    if (!asars.length) return; // main app on the bundled version too — nothing to mirror
    const newest = asars[asars.length - 1];
    const dst = join(USER_DATA_DIR, newest);
    if (!existsSync(dst)) {
      copyFileSync(join(MAIN_OBSIDIAN_DIR, newest), dst);
      console.log(`synced ${newest} into the dev profile (matches your main Obsidian version)`);
    }
  } catch (e) { console.warn("asar sync skipped:", e.message); }
}

async function start() {
  if (await portReady()) {
    const v = await verifyVault();
    console.log(`reuse: dev instance already up on :${PORT} → ${v.name} (sentinel ok)`);
    return;
  }
  seedConfig();
  syncInsiderAsar();
  console.log(`launching dedicated Obsidian (vault: ${VAULT_NAME}, port :${PORT}, isolated user-data-dir)…`);
  const child = spawn(OBSIDIAN_BIN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    detached: true, stdio: "ignore",
  });
  child.unref();
  // Poll for the port, then for the app to finish booting.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    if (await portReady()) break;
  }
  if (!(await portReady())) throw new Error("dev instance did not expose the debug port within 30s");
  // Wait for the renderer to finish BOOTING (workspace.layoutReady), not merely
  // for the sentinel to be readable — so an eval or reload fired right after
  // start() returns lands on a settled app, not one still assembling its layout.
  const v = await waitReady(30000, "startup");
  await ensureStashpad();
  console.log(`started: ${v.name} on :${PORT} (sentinel ok, layout ready, Stashpad enabled)`);
}

// A fresh user-data-dir opens the vault in restricted mode (community plugins
// off), so turn it on + enable Stashpad once per launch. No-op if already on.
async function ensureStashpad() {
  await evalExpr(`
    try { await app.plugins.setEnable?.(true); } catch {}
    try { if (!app.plugins.plugins.stashpad) await app.plugins.enablePlugin?.("stashpad"); } catch {}
    return !!app.plugins.plugins.stashpad;
  `);
}

function stop() {
  try {
    // user-data-dir is the LAST spawn arg, so $-anchoring distinguishes slot A from B.
    execSync(`pkill -f "${CFG.userDataDir}$"`);
    console.log("stopped the dev instance.");
  } catch { console.log("no dev instance was running."); }
}

/** Bring the instance's window to the front and un-hide its renderer.
 *  Matters for more than convenience: an occluded Obsidian window reports
 *  document.visibilityState === "hidden", and Chromium then THROTTLES timers in
 *  that renderer. Anything under test that depends on a setTimeout (e.g. the
 *  first-run welcome's settle delay) fires late or not at all while hidden, which
 *  reads as a plugin bug when it is really a background-tab artifact. Call this
 *  before timing-sensitive checks. */
async function focus() {
  await verifyVault();
  await cdp("Page.bringToFront", {});
  const state = await evalExpr('document.visibilityState');
  console.log(`focused — visibilityState now ${state}`);
}

async function screenshot(path) {
  if (!path) throw new Error("screenshot needs an output path");
  await verifyVault();
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(r.data, "base64"));
  console.log(`screenshot → ${path}`);
}

async function reload() {
  // SERIALIZE: never fire app:reload while the app is still booting — reloading a
  // half-initialized renderer is exactly what wedges it ("reload right after
  // start hangs"). Wait until fully ready first. waitReady also safety-verifies
  // the vault (name + sentinel) before we drive anything.
  await waitReady(30000, "before reload");
  // Reload from INSIDE the page (Obsidian's own "app:reload", falling back to
  // location.reload) rather than a raw CDP Page.reload. Page.reload tears the
  // target down while we're still awaiting its response, which wedges the socket
  // and has coincided with the dev instance dying outright. Fire on a short timer
  // so this eval returns before the navigation starts (a 5s cap so a boot-time
  // wedge can't hang even this fire-and-forget), and swallow the expected socket
  // drop as the page navigates.
  try {
    await rawEval(wrapBody(`
      const reloadNow = () => {
        try { if (app.commands?.commands?.["app:reload"]) { app.commands.executeCommandById("app:reload"); return; } } catch {}
        location.reload();
      };
      setTimeout(reloadNow, 50);
      return "reloading";
    `), 5000);
  } catch { /* the socket may drop as the page navigates; that's expected */ }
  console.log("reloading dev instance renderer (picks up the latest deploy)…");
  // Wait for it to come back FULLY (layoutReady). Each probe is time-boxed by
  // cdp(), so a renderer still mid-reload can't hang the loop — the deadline is
  // now actually honored, and we fail fast with a clear message instead of 120s.
  await waitReady(30000, "after reload");
  console.log("reload complete — instance healthy.");
}

// ---- dispatch -------------------------------------------------------------
try {
  switch (cmd) {
    case "start": await start(); break;
    case "verify": { const v = await verifyVault(); console.log(`OK — ${v.name} on :${PORT} (sentinel ok)`); break; }
    case "eval": { await verifyVault(); console.log(await evalExpr(arg ?? "", EVAL_TIMEOUT)); break; }
    case "eval-file": { await verifyVault(); console.log(await evalExpr(readFileSync(arg, "utf8"), EVAL_TIMEOUT)); break; }
    case "reload": await reload(); break;
    case "focus": await focus(); break;
    case "screenshot": await screenshot(arg); break;
    case "stop": stop(); break;
    default:
      console.log("usage: obs-dev start|verify|eval '<js>'|eval-file <path>|reload|screenshot <path>|stop");
  }
  process.exit(0);
} catch (e) {
  console.error(String(e && e.message || e));
  process.exit(1);
}
