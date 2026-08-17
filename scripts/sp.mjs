// sp — a CLI for browsing and driving Stashpad the way a user does.
//
// Two backends:
//   READS  — pure filesystem. Stashpad notes are plain markdown + YAML
//            frontmatter; this walks the folder, rebuilds the parent/child
//            tree exactly like src/tree-index.ts (created-asc order with the
//            .stashpad-order.json override, self-parent + cycle guards,
//            reserved subfolders skipped), and prints it. No Obsidian needed.
//   WRITES — via the LIVE plugin over CDP (shells out to scripts/obs-dev
//            eval), calling the same bottlenecks the UI uses (createNoteUnder,
//            toggleCompletedForNode, deep-link open) so undo, synthetic
//            inserts, ordering, authorship and the action log all behave as
//            if the user did it. The CLI never writes frontmatter itself.
//
// Usage (via the scripts/sp wrapper):
//   sp ls [target]              children of a note (default: folder root)
//   sp tree [target] [-d N]     subtree outline (default depth 3)
//   sp cat <target>             full body + key frontmatter
//   sp find <query...>          Sift-style search (all tokens, any order)
//   sp path <target>            breadcrumb from root
//   sp info                     folder stats
//   sp open <target>            open the note in the obs-dev instance   [CDP]
//   sp add <target|/> <text>    create a note under target (undoable)   [CDP]
//   sp done <target>            toggle task completion (undoable-ish)   [CDP]
//
// Target = full id | unique id prefix | "/"-separated title path where each
// segment is a Sift match (all tokens, any order, case-insensitive) against
// the children of the previous level. "/" alone = the folder root.
//
// Flags: --vault <path> (default ../Claude Dev Vault — the ONLY vault writes
// may ever drive), --folder <name> (default Stashpad). Reads may point at any
// vault path; WRITE verbs always go through obs-dev, which hard-verifies the
// Claude Dev Vault sentinel before driving anything.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const ROOT_ID = "__root__";
// Mirror of RESERVED_SUBFOLDER_NAMES / SUBFOLDER_ONLY_RESERVED_NAMES in src/types.ts.
const RESERVED = new Set(["_attachments", "_authors", "_exports", "_imports", "_processed", "_archive", ".archive", "archive", "trash"]);

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--vault" || a === "--folder") flags[a.slice(2)] = argv[++i];
  else if (a === "-d" || a === "--depth") flags.depth = parseInt(argv[++i], 10);
  else pos.push(a);
}
const CMD = pos.shift();
const VAULT = resolve(flags.vault ?? resolve(REPO, "..", "Claude Dev Vault"));
const FOLDER = flags.folder ?? "Stashpad";
const FOLDER_ABS = join(VAULT, FOLDER);

// ---- tiny YAML frontmatter parser (Stashpad's schema is simple) -----------
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return [{}, text];
  const end = text.indexOf("\n---", 3);
  if (end < 0) return [{}, text];
  const raw = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const fm = {};
  let listKey = null;
  for (const line of raw.split("\n")) {
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && listKey) { fm[listKey].push(unquote(li[1])); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { listKey = null; continue; }
    const [, k, vRaw] = kv;
    const v = vRaw.trim();
    if (v === "") { fm[k] = []; listKey = k; continue; }
    listKey = null;
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      fm[k] = inner ? inner.split(",").map((s) => unquote(s.trim())) : [];
    } else if (v === "true") fm[k] = true;
    else if (v === "false") fm[k] = false;
    else fm[k] = unquote(v);
  }
  return [fm, body];
}
function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// ---- load the folder into a tree ------------------------------------------
function walkMarkdown(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!RESERVED.has(e.name) && !e.name.startsWith(".")) walkMarkdown(p, out);
    } else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function loadTree() {
  if (!existsSync(FOLDER_ABS)) die(`folder not found: ${FOLDER_ABS}`);
  const nodes = new Map();
  nodes.set(ROOT_ID, { id: ROOT_ID, parent: null, children: [], title: "(root)", fm: {}, body: "", path: null });
  for (const p of walkMarkdown(FOLDER_ABS)) {
    let text;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    const [fm, body] = parseFrontmatter(text);
    const id = fm.id;
    if (!id || id === ROOT_ID) {
      if (id === ROOT_ID) nodes.get(ROOT_ID).path = p;
      continue;
    }
    let parent = fm.parent ?? ROOT_ID;
    if (parent === id) parent = ROOT_ID; // self-parent guard (tree-index parity)
    const firstLine = (body.split("\n").find((l) => l.trim()) ?? "").trim();
    nodes.set(id, {
      id, parent, children: [],
      title: firstLine.replace(/^(?:[-*+]\s+)?\[[ xX]?\]\s*/, "").slice(0, 200) || "(empty)",
      fm, body, path: p,
      created: fm.created ?? "",
    });
  }
  // multi-node cycle guard (tree-index parity): reparent cycle members to root
  for (const n of nodes.values()) {
    if (n.id === ROOT_ID) continue;
    const seen = new Set([n.id]);
    let p = n.parent ?? ROOT_ID;
    while (p !== ROOT_ID && nodes.has(p)) {
      if (seen.has(p)) { n.parent = ROOT_ID; break; }
      seen.add(p);
      p = nodes.get(p).parent ?? ROOT_ID;
    }
  }
  for (const n of nodes.values()) {
    if (n.id === ROOT_ID) continue;
    const parent = nodes.get(n.parent) ?? nodes.get(ROOT_ID);
    parent.children.push(n.id);
  }
  // created-asc, then explicit order override
  let order = {};
  try { order = JSON.parse(readFileSync(join(FOLDER_ABS, ".stashpad-order.json"), "utf8")); } catch { /* none */ }
  for (const n of nodes.values()) {
    n.children.sort((a, b) => (nodes.get(a).created || "").localeCompare(nodes.get(b).created || ""));
    const explicit = order[n.id];
    if (Array.isArray(explicit) && explicit.length) {
      const posOf = new Map(explicit.map((id, i) => [id, i]));
      n.children.sort((a, b) => (posOf.get(a) ?? Infinity) - (posOf.get(b) ?? Infinity));
    }
  }
  return nodes;
}

// ---- target resolution ----------------------------------------------------
function sift(hay, query) {
  const h = hay.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((t) => h.includes(t));
}

function resolveTarget(nodes, target) {
  if (!target || target === "/" || target === ".") return nodes.get(ROOT_ID);
  if (nodes.has(target)) return nodes.get(target);
  // unique id prefix
  const idHits = [...nodes.keys()].filter((id) => id !== ROOT_ID && id.startsWith(target));
  if (idHits.length === 1) return nodes.get(idHits[0]);
  if (idHits.length > 1) die(`ambiguous id prefix "${target}": ${idHits.slice(0, 8).join(", ")}`);
  // title path
  let cur = nodes.get(ROOT_ID);
  for (const seg of target.split("/").map((s) => s.trim()).filter(Boolean)) {
    const kids = cur.children.map((id) => nodes.get(id));
    const hits = kids.filter((k) => sift(k.title, seg));
    if (hits.length === 0) die(`no child of "${cur.title}" matches "${seg}"`);
    if (hits.length > 1) {
      // prefer an exact-ish (startsWith) match before giving up
      const tight = hits.filter((k) => k.title.toLowerCase().startsWith(seg.toLowerCase()));
      if (tight.length === 1) { cur = tight[0]; continue; }
      die(`"${seg}" is ambiguous under "${cur.title}":\n` + hits.slice(0, 10).map((k) => `  ${k.id}  ${k.title.slice(0, 70)}`).join("\n"));
    }
    cur = hits[0];
  }
  return cur;
}

// ---- rendering ------------------------------------------------------------
function marker(n) {
  const fm = n.fm ?? {};
  if (fm.missed) return "✗";
  if (fm.task || fm.completed !== undefined || fm.due) return fm.completed ? "[x]" : "[ ]";
  return "   ";
}
function annot(n) {
  const bits = [];
  const fm = n.fm ?? {};
  if (fm.colorAlias) bits.push(`●${fm.colorAlias}`);
  else if (fm.color) bits.push(`●${fm.color}`);
  if (fm.due) bits.push(`due ${String(fm.due).slice(0, 16)}`);
  if (fm.repeat) bits.push(`↻ ${fm.repeat}`);
  if (n.children.length) bits.push(`+${n.children.length}`);
  return bits.length ? `  (${bits.join(", ")})` : "";
}
function line(n) {
  return `${n.id.padEnd(10)} ${marker(n)} ${n.title.slice(0, 80)}${annot(n)}`;
}
function breadcrumb(nodes, n) {
  const parts = [];
  const seen = new Set();
  let cur = n;
  while (cur && cur.id !== ROOT_ID && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.title.slice(0, 40));
    cur = nodes.get(cur.parent);
  }
  return "/" + parts.join(" / ");
}

// ---- CDP bridge (writes + navigation) -------------------------------------
// Self-contained client for the obs-dev instance on :9222 (same protocol as
// scripts/obs-dev.mjs, including the SAME safety interlock: refuse to drive
// unless the target is the Claude Dev Vault, verified by name + sentinel).
// SP_PORT=9223 targets the slot-B instance (Claude Dev Vault B).
const PORT = Number(process.env.SP_PORT) || 9222;
const SENTINELS = new Map([
  ["Claude Dev Vault", "claude-dev-vault-7f3a9c2e-do-not-delete"],
  ["Claude Dev Vault B", "claude-dev-vault-b-4e8d1f6a-do-not-delete"],
]);

async function cdpEvalRaw(body) {
  let targets;
  try { targets = await (await fetch(`http://localhost:${PORT}/json`, { signal: AbortSignal.timeout(1500) })).json(); }
  catch { die("obs-dev instance not reachable on :9222 — run: scripts/obs-dev start"); }
  const page = targets.find((t) => t.type === "page" && /obsidian\.md|app:\/\/obsidian/.test(t.url)) || targets[0];
  if (!page) die("no CDP page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(die("CDP websocket error")); });
  const expr = `(async () => { try { const __r = await (async () => { ${body} })(); return JSON.stringify(__r) ?? "undefined"; } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`;
  const out = await new Promise((res) => {
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) res(msg.result); };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (out.exceptionDetails) die(`CDP eval exception: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
  return out.result?.value;
}

let vaultVerified = false;
async function obsDevEval(js) {
  if (!vaultVerified) {
    const raw = await cdpEvalRaw(`
      const name = app.vault.getName();
      const fname = name === "Claude Dev Vault B" ? "CLAUDE-DEV-VAULT-B-SENTINEL.md" : "CLAUDE-DEV-VAULT-SENTINEL.md";
      const f = app.vault.getAbstractFileByPath(fname);
      let body = "";
      if (f) { try { body = await app.vault.cachedRead(f); } catch {} }
      return { name, body };`);
    let v; try { v = JSON.parse(raw); } catch { v = null; }
    const expected = v ? SENTINELS.get(v.name) : null;
    if (!v || !expected || !(v.body || "").includes(expected)) {
      die(`SAFETY ABORT — instance on :${PORT} is NOT the Claude Dev Vault (${raw}). Refusing to drive.`);
    }
    vaultVerified = true;
  }
  const raw = await cdpEvalRaw(js);
  let v; try { v = JSON.parse(raw); } catch { return raw; }
  if (v && v.__error) die(`in-app error: ${v.__error}`);
  return v;
}
// Find the Stashpad view for FOLDER by duck-typing (no view-type constant needed).
const FIND_VIEW = (folder) => `
  let view = null;
  app.workspace.iterateAllLeaves((l) => {
    const v = l.view;
    if (!view && v && typeof v.createNoteUnder === "function" && v.noteFolder === ${JSON.stringify(folder)}) view = v;
  });
`;

// ---- commands -------------------------------------------------------------
function die(msg) { console.error(msg); process.exit(1); }

const nodesNeeded = ["ls", "tree", "cat", "find", "path", "info", "open", "add", "done", "move"].includes(CMD);
const nodes = nodesNeeded ? loadTree() : null;

switch (CMD) {
  case "ls": {
    const t = resolveTarget(nodes, pos[0]);
    console.log(`${breadcrumb(nodes, t)}  [${t.id}]`);
    for (const cid of t.children) console.log("  " + line(nodes.get(cid)));
    if (!t.children.length) console.log("  (no children)");
    break;
  }
  case "tree": {
    const t = resolveTarget(nodes, pos[0]);
    const depth = flags.depth ?? 3;
    console.log(`${breadcrumb(nodes, t)}  [${t.id}]`);
    const rec = (id, d) => {
      if (d > depth) return;
      for (const cid of nodes.get(id).children) {
        console.log("  ".repeat(d) + line(nodes.get(cid)));
        rec(cid, d + 1);
      }
    };
    rec(t.id, 1);
    break;
  }
  case "cat": {
    const t = resolveTarget(nodes, pos[0] ?? die("cat needs a target"));
    const fm = t.fm ?? {};
    console.log(`# ${breadcrumb(nodes, t)}`);
    console.log(`id: ${t.id}  parent: ${t.parent}  created: ${t.created ?? ""}`);
    const extras = Object.entries(fm).filter(([k]) => !["id", "parent", "created", "attachments", "modified", "author", "contributors", "parentLink", "children"].includes(k));
    if (extras.length) console.log(extras.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("  "));
    if (Array.isArray(fm.attachments) && fm.attachments.length) console.log(`attachments: ${fm.attachments.join(", ")}`);
    console.log(`file: ${t.path}`);
    console.log("---");
    console.log(t.body.trimEnd());
    break;
  }
  case "find": {
    const q = pos.join(" ");
    if (!q) die("find needs a query");
    const hits = [...nodes.values()].filter((n) => n.id !== ROOT_ID && sift(n.body, q));
    for (const n of hits.slice(0, 50)) console.log(`${line(n)}\n    ${breadcrumb(nodes, n)}`);
    console.log(`${hits.length} match(es)${hits.length > 50 ? " (showing 50)" : ""}`);
    break;
  }
  case "path": {
    const t = resolveTarget(nodes, pos[0] ?? die("path needs a target"));
    console.log(breadcrumb(nodes, t) + `  [${t.id}]`);
    console.log(t.path ?? "(no file)");
    break;
  }
  case "info": {
    const all = [...nodes.values()].filter((n) => n.id !== ROOT_ID);
    const tasks = all.filter((n) => n.fm.completed !== undefined || n.fm.task || n.fm.due);
    const open = tasks.filter((n) => !n.fm.completed);
    console.log(`${FOLDER} @ ${VAULT}`);
    console.log(`${all.length} notes, ${nodes.get(ROOT_ID).children.length} top-level, ${tasks.length} tasks (${open.length} open)`);
    break;
  }
  case "open": {
    const t = resolveTarget(nodes, pos[0] ?? die("open needs a target"));
    await obsDevEval(`await app.plugins.plugins.stashpad.openDeepLinkTarget(${JSON.stringify(FOLDER)}, ${JSON.stringify(t.id)}); return "opened ${t.id}"`);
    console.log(`opened ${t.id} — ${t.title.slice(0, 60)}`);
    break;
  }
  case "add": {
    const t = resolveTarget(nodes, pos[0] ?? die("add needs a parent target (or /)"));
    const text = pos.slice(1).join(" ");
    if (!text) die("add needs note text");
    // Always pass the explicit id (ROOT_ID included): createNoteUnder treats
    // null as "the view's current drill-in focus", which is NOT necessarily root.
    const parentArg = JSON.stringify(t.id);
    const r = await obsDevEval(`${FIND_VIEW(FOLDER)}
      if (!view) return { __error: "no open Stashpad view on folder ${FOLDER} — run: sp open / first" };
      const id = await view.createNoteUnder(${JSON.stringify(text)}, ${parentArg});
      return { id };`);
    console.log(`created ${r.id} under ${t.id}`);
    break;
  }
  case "done": {
    const t = resolveTarget(nodes, pos[0] ?? die("done needs a target"));
    if (t.id === ROOT_ID) die("can't toggle the root");
    const r = await obsDevEval(`${FIND_VIEW(FOLDER)}
      if (!view) return { __error: "no open Stashpad view on folder ${FOLDER} — run: sp open / first" };
      const node = view.tree.get(${JSON.stringify(t.id)});
      if (!node) return { __error: "id not in live tree (view on a different folder?)" };
      await view.toggleCompletedForNode(node);
      return { completed: !${JSON.stringify(!!t.fm.completed)} };`);
    console.log(`${t.id} → ${r.completed ? "completed" : "reopened"}`);
    break;
  }
  case "move": {
    // 0.268.4: the first verb that replaces a MODAL rather than adding a new
    // capability. "Move to…" is a picker, and a picker is a dead end from a
    // terminal — the CLI could create and complete notes but never reorganise
    // them, so any task that needed reparenting stopped here.
    //
    // Drives `changeParent`, the method the picker calls once you have chosen,
    // rather than the picker's own UI. That is the durable seam: the modal's
    // markup changes often and this method does not, and it already handles
    // the tree update, the frontmatter write and the undo entry.
    const t = resolveTarget(nodes, pos[0] ?? die("move needs a target"));
    const destArg = pos[1] ?? die('move needs a destination (an id, a title, or "/" for root)');
    const dest = resolveTarget(nodes, destArg);
    if (t.id === ROOT_ID) die("can't move the root");
    if (t.id === dest.id) die("a note cannot be its own parent");
    const r = await obsDevEval(`${FIND_VIEW(FOLDER)}
      if (!view) return { __error: "no open Stashpad view on folder ${FOLDER} — run: sp open / first" };
      const node = view.tree.get(${JSON.stringify(t.id)});
      if (!node) return { __error: "id not in live tree (view on a different folder?)" };
      // Guard the cycle here as well as in the plugin: a CLI is exactly where
      // someone types a descendant's id by mistake, and the failure mode is a
      // tree that cannot be rendered.
      let walk = view.tree.get(${JSON.stringify(dest.id)});
      while (walk && walk.id !== "__root__") {
        if (walk.id === node.id) return { __error: "that destination is inside the note you are moving" };
        walk = walk.parent ? view.tree.get(walk.parent) : null;
      }
      const ok = await view.changeParent(node, ${JSON.stringify(dest.id)}, { silentSuccess: true });
      view.render();
      return { ok };`);
    if (!r.ok) die("move refused by the plugin");
    console.log(`moved ${t.id} → ${dest.id === ROOT_ID ? "/" : dest.id}`);
    break;
  }
  default:
    console.log(`sp — Stashpad CLI. Commands: ls tree cat find path info open add done move
Flags: --vault <path> --folder <name> -d <depth>
Targets: id | id-prefix | Title/Path/Segments (Sift match) | "/" for root`);
}
