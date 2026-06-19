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
const PORT = 9222;
const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const VAULT = resolve(REPO, "..", "Claude Dev Vault");
const VAULT_NAME = "Claude Dev Vault";
const SENTINEL = "claude-dev-vault-7f3a9c2e-do-not-delete";
const USER_DATA_DIR = join(process.env.HOME, "Library", "Application Support", "obsidian-claude-dev");

const cmd = process.argv[2];
const arg = process.argv[3];

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

async function cdp(method, params) {
  const page = await pickPage();
  if (!page) throw new Error("no CDP page target on port " + PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const out = await new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.close();
  return out;
}

async function evalExpr(expr) {
  const wrapped = `(async () => { try { const __r = await (async () => { ${expr} })(); return JSON.stringify(__r); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`;
  const r = await cdp("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true });
  return r.result?.value;
}

// ---- vault verification (name + sentinel) ---------------------------------
async function verifyVault() {
  const raw = await evalExpr(`
    const f = app.vault.getAbstractFileByPath("CLAUDE-DEV-VAULT-SENTINEL.md");
    let sentinel = false;
    if (f) { try { sentinel = (await app.vault.cachedRead(f)).includes("${SENTINEL}"); } catch {} }
    return { name: app.vault.getName(), sentinel };
  `);
  let v; try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || v.name !== VAULT_NAME || !v.sentinel) {
    throw new Error(`SAFETY ABORT — debug-port instance is NOT the Claude Dev Vault (got ${raw}). Refusing to drive.`);
  }
  return v;
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
  // Give the renderer a moment to load the vault + plugin, then verify.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 700));
    try { const v = await verifyVault(); await ensureStashpad(); console.log(`started: ${v.name} on :${PORT} (sentinel ok, Stashpad enabled)`); return; } catch { /* keep waiting */ }
  }
  await verifyVault(); // final attempt — throws with detail if still wrong
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
    execSync(`pkill -f "obsidian-claude-dev"`);
    console.log("stopped the dev instance.");
  } catch { console.log("no dev instance was running."); }
}

async function screenshot(path) {
  if (!path) throw new Error("screenshot needs an output path");
  await verifyVault();
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(r.data, "base64"));
  console.log(`screenshot → ${path}`);
}

async function reload() {
  await verifyVault();
  await cdp("Page.reload", { ignoreCache: true });
  console.log("reloading dev instance renderer (picks up the latest deploy)…");
}

// ---- dispatch -------------------------------------------------------------
try {
  switch (cmd) {
    case "start": await start(); break;
    case "verify": { const v = await verifyVault(); console.log(`OK — ${v.name} on :${PORT} (sentinel ok)`); break; }
    case "eval": { await verifyVault(); console.log(await evalExpr(arg ?? "")); break; }
    case "eval-file": { await verifyVault(); console.log(await evalExpr(readFileSync(arg, "utf8"))); break; }
    case "reload": await reload(); break;
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
