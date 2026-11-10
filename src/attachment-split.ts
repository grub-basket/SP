/** 0.605.0: give every Stashpad folder its own copy of an attachment that
 *  several folders share.
 *
 *  Why: with one shared file, deleting it (or the folder holding it) breaks the
 *  other folders. With a copy each, a delete only ever affects one folder.
 *
 *  How, and in this order for each file, so a failure can only leave extra files
 *  and never a broken link:
 *  1. planAttachmentSplit is READ-ONLY and fixes the list the run works from.
 *  2. Each folder's copy is made and compared with the original.
 *  3. That folder's notes are repointed (body and frontmatter), then re-read to
 *     confirm no link still reaches the original.
 *  4. Only then does the original move to the holding folder's
 *     `archive/_attachment-originals/<date>/`. If anything could still be using
 *     it (a note outside Stashpad, a canvas, a note made since the preview), it
 *     stays where it is and the reason is reported.
 *
 *  A JSON log sits beside the originals, written before anything changes and
 *  updated per file. It is the record of what was done and what Undo reads. It
 *  is deliberately NOT in a dot folder: those don't travel with every sync
 *  method, and the log is only useful where the copies are.
 *
 *  Locked notes need no special handling. Their attachments are inside the
 *  encrypted bundle with a recorded origin, and an unlock writes a fresh copy
 *  when the origin is gone (see importStashZip).
 */
import { App, FuzzySuggestModal, Modal, Notice, Platform, TFile, TFolder, getFrontMatterInfo, getLinkpath, parseYaml } from "obsidian";
import type StashpadPlugin from "./main";
import { folderTag, humanSize, rewriteLinks, type Retarget } from "./attachment-split-core";
import { companionFilesFor } from "./encryption-ops";
import { formatDateOnly } from "./format";
import { formatGroupedPaths } from "./notification-text";
import { buildAttachmentName } from "./slug-service";
import { archiveSubfolderOf, attachmentLinkPath, owningFolder, toAttachmentLink } from "./types";

const ORIGINALS_DIR = "_attachment-originals";
const LOG_PREFIX = "split-";
/** Pause between files, so the vault and any sync client aren't hammered. */
const PAUSE_MS = 120;
/** Above these, a file isn't loaded whole just to compare it. */
const MOBILE_COMPARE_LIMIT = 64 * 1024 * 1024;
const DESKTOP_COMPARE_LIMIT = 1024 * 1024 * 1024;

export interface SplitCopyPlan {
  folder: string;
  notes: TFile[];
}

export interface SplitItem {
  file: TFile;
  path: string;
  size: number;
  mtime: number;
  /** The Stashpad folder whose `_attachments` holds the file. */
  holder: string;
  /** One per folder that gets a copy. */
  copies: SplitCopyPlan[];
  /** Every Stashpad folder using it, for display. */
  usedBy: string[];
  /** Why the original can't be archived, or null when it can. */
  keepOriginal: string | null;
  large: boolean;
}

export interface SplitPlan {
  /** False when attachments aren't stored per folder: they're shared on purpose. */
  supported: boolean;
  items: SplitItem[];
  /** Shared files the user chose to always keep shared. */
  keptShared: string[];
  folders: number;
}

export interface SplitLogCopy {
  folder: string;
  path: string;
  notes: string[];
  /** Undo has finished with this copy, so a retry skips it. */
  undone?: boolean;
  /** 0.605.3: sidecar files made next to this copy. */
  sidecars?: string[];
}

export interface SplitLogEntry {
  original: string;
  archivedTo: string | null;
  size: number;
  holder: string;
  copies: SplitLogCopy[];
  status: "planned" | "done" | "partial" | "skipped" | "undone";
  note?: string;
  /** 0.605.3: sidecar files that moved to the archive with the original. */
  sidecars?: { from: string; to: string }[];
}

export interface SplitLog {
  version: 1;
  runId: string;
  at: string;
  status: "running" | "done" | "undone";
  entries: SplitLogEntry[];
}

export interface SplitRunResult {
  runId: string;
  done: SplitLogEntry[];
  /** Files left as they were, with the reason. */
  skipped: { path: string; reason: string }[];
  /** Split, but the original stayed in place. */
  keptOriginals: { path: string; reason: string }[];
  stopped: boolean;
}

const parentOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

async function ensureFolder(app: App, dir: string): Promise<void> {
  let cur = "";
  for (const seg of dir.split("/").filter(Boolean)) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (app.vault.getAbstractFileByPath(cur)) continue;
    try { await app.vault.createFolder(cur); }
    catch (e) { if (!/already exists/i.test((e as Error)?.message ?? "")) throw e; }
  }
}

interface RefInfo {
  byFolder: Map<string, Set<TFile>>;
  outside: Set<TFile>;
}

/** Who links to each target: every link kind the metadata cache knows about,
 *  plus plain-text `attachments` entries, which it doesn't see as links. */
function collectRefs(app: App, folders: ReadonlySet<string>, targets: ReadonlyMap<string, TFile>): Map<string, RefInfo> {
  const names = new Set([...targets.values()].map((f) => f.name));
  const out = new Map<string, RefInfo>();
  for (const note of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(note);
    if (!cache) continue;
    const paths = new Set<string>();
    for (const l of [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]) paths.add(getLinkpath(l.link));
    const att: unknown = cache.frontmatter?.attachments;
    for (const e of Array.isArray(att) ? att : [att]) {
      if (typeof e === "string" && e.trim()) paths.add(attachmentLinkPath(e));
    }
    for (const lp of paths) {
      if (!names.has(lp.split("/").pop() ?? lp)) continue;
      const dest = app.metadataCache.getFirstLinkpathDest(lp, note.path);
      if (!dest || !targets.has(dest.path)) continue;
      let info = out.get(dest.path);
      if (!info) { info = { byFolder: new Map(), outside: new Set() }; out.set(dest.path, info); }
      const owner = owningFolder(parentOf(note.path), folders);
      if (!owner) { info.outside.add(note); continue; }
      let set = info.byFolder.get(owner);
      if (!set) { set = new Set(); info.byFolder.set(owner, set); }
      set.add(note);
    }
  }
  return out;
}

/** Vault paths a canvas uses, through a file card or a link in a text card.
 *  Canvases aren't notes, so nothing else would notice one depending on a file. */
async function canvasReferences(app: App): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of app.vault.getFiles()) {
    if (f.extension !== "canvas") continue;
    try {
      const data = JSON.parse(await app.vault.cachedRead(f)) as { nodes?: { type?: string; file?: string; text?: string }[] };
      for (const n of data.nodes ?? []) {
        if (n.type === "file" && n.file) out.add(n.file);
        if (n.type === "text" && n.text) {
          rewriteLinks(n.text, (lp) => {
            const dest = app.metadataCache.getFirstLinkpathDest(lp, f.path);
            if (dest) out.add(dest.path);
            return null;
          });
        }
      }
    } catch { /* an unreadable canvas references nothing we can act on */ }
  }
  return out;
}

/** Why `path` can't be retired yet, or null when nothing uses it. Reads
 *  Obsidian's own link index, so a link form our rewriter doesn't understand is
 *  still caught. `handled` notes were just rewritten and may take a moment to
 *  reindex; any other note linking to it is a real reference straight away. */
async function stillLinked(app: App, path: string, handled: ReadonlySet<string>): Promise<string | null> {
  const deadline = Date.now() + 3000;
  for (;;) {
    let waiting: string | null = null;
    for (const [src, targets] of Object.entries(app.metadataCache.resolvedLinks ?? {})) {
      if (!(targets ?? {})[path]) continue;
      if (!handled.has(src)) return `another note links to it (${src})`;
      waiting = src;
    }
    if (!waiting) return null;
    if (Date.now() > deadline) return `a link in ${waiting} couldn't be updated`;
    await sleep(60);
  }
}

/** Phase 1: decide what would happen. Read-only (reads canvases, writes nothing). */
export async function planAttachmentSplit(plugin: StashpadPlugin): Promise<SplitPlan> {
  const app = plugin.app;
  const s = plugin.settings;
  const folders = plugin.discoverStashpadFolders().map((f) => f.replace(/\/+$/, ""));
  const plan: SplitPlan = { supported: (s.attachmentLocation ?? "per-folder") === "per-folder", items: [], keptShared: [], folders: folders.length };
  if (!plan.supported) return plan;
  const folderSet = new Set(folders);
  const targets = new Map<string, TFile>();
  const holderOf = new Map<string, string>();
  for (const folder of folders) {
    const af = app.vault.getAbstractFileByPath(`${folder}/_attachments`);
    if (!(af instanceof TFolder)) continue;
    for (const c of af.children) {
      if (c instanceof TFile && c.extension !== "md") { targets.set(c.path, c); holderOf.set(c.path, folder); }
    }
  }
  const refs = collectRefs(app, folderSet, targets);
  const canvases = await canvasReferences(app);
  const kept = new Set(s.attachmentAlwaysShared ?? []);
  const warnBytes = Math.max(0, s.attachmentSplitWarnMB ?? 25) * 1024 * 1024;
  for (const [path, info] of refs) {
    if (info.byFolder.size < 2) continue;
    if (kept.has(path)) { plan.keptShared.push(path); continue; }
    const file = targets.get(path);
    const holder = holderOf.get(path);
    if (!file || !holder) continue;
    const keepOriginal = info.outside.size
      ? `a note outside Stashpad links to it (${[...info.outside][0].path})`
      : canvases.has(path) ? "a canvas uses it" : null;
    // When the original has to stay, the holder just keeps using it.
    const copies = [...info.byFolder]
      .filter(([folder]) => !(keepOriginal && folder === holder))
      .map(([folder, notes]) => ({ folder, notes: [...notes] }));
    plan.items.push({
      file, path, size: file.stat.size, mtime: file.stat.mtime, holder, copies,
      usedBy: [...info.byFolder.keys()], keepOriginal,
      large: warnBytes > 0 && file.stat.size >= warnBytes,
    });
  }
  plan.items.sort((a, b) => a.path.localeCompare(b.path));
  for (const path of s.attachmentAlwaysShared ?? []) {
    if (!plan.keptShared.includes(path)) plan.keptShared.push(path); // no longer shared, still listed so it can be removed
  }
  return plan;
}

/** Same content? "unknown" means equal size but too large to load here, and a
 *  caller must never treat that as proof of a copy. */
async function compareFiles(app: App, a: TFile, b: TFile): Promise<"same" | "different" | "unknown"> {
  if (a.stat.size !== b.stat.size) return "different";
  if (a.stat.size > (Platform.isMobile ? MOBILE_COMPARE_LIMIT : DESKTOP_COMPARE_LIMIT)) return "unknown";
  const [x, y] = await Promise.all([app.vault.readBinary(a), app.vault.readBinary(b)]);
  const ax = new Uint8Array(x);
  const ay = new Uint8Array(y);
  if (ax.length !== ay.length) return "different";
  for (let i = 0; i < ax.length; i++) if (ax[i] !== ay[i]) return "different";
  return "same";
}

/** Make `folder`'s copy, or reuse one an interrupted run already made. The name
 *  depends only on the file and the folder, which is what makes a re-run safe.
 *  `verified` is false when the file is too large to compare on this device: the
 *  copy can be used, but it isn't proof enough to retire the original. */
async function placeCopy(app: App, file: TFile, folder: string): Promise<{ path: string; verified: boolean }> {
  const dir = `${folder}/_attachments`;
  await ensureFolder(app, dir);
  const tag = folderTag(folder);
  for (let i = 0; i < 100; i++) {
    const path = `${dir}/${buildAttachmentName(file.name, i ? `${tag}-${i}` : tag)}`;
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if ((await compareFiles(app, file, existing)) === "same") return { path, verified: true };
      continue;
    }
    if (existing) continue;
    const made = await app.vault.copy(file, path);
    const result = await compareFiles(app, file, made);
    if (result === "different") {
      await app.fileManager.trashFile(made);
      throw new Error("the copy didn't match the original");
    }
    return { path, verified: result === "same" };
  }
  throw new Error("no free file name");
}

/** 0.605.3: the name a sidecar should have beside a file now called `newName`.
 *  Sidecars are named after their owner, either the full name (`a.png.edtz`) or
 *  the name without its extension (`a.edtz`), and the same form is kept. */
function sidecarNameFor(sidecar: TFile, owner: TFile, newName: string): string {
  if (sidecar.name.startsWith(owner.name)) return `${newName}${sidecar.name.slice(owner.name.length)}`;
  const dot = newName.lastIndexOf(".");
  return `${dot > 0 ? newName.slice(0, dot) : newName}${sidecar.name.slice(owner.basename.length)}`;
}

function sidecarsOf(plugin: StashpadPlugin, file: TFile): TFile[] {
  return companionFilesFor(plugin.app, file, plugin.settings.encryptCompanionExts ?? []);
}

/** 0.605.3: give a new copy its own copies of the owner's sidecars. One already
 *  there (an interrupted run) is left as it is. Returns their paths. */
async function copySidecars(plugin: StashpadPlugin, owner: TFile, copyPath: string): Promise<string[]> {
  const app = plugin.app;
  const out: string[] = [];
  const copyName = copyPath.split("/").pop() ?? copyPath;
  for (const s of sidecarsOf(plugin, owner)) {
    const to = `${parentOf(copyPath)}/${sidecarNameFor(s, owner, copyName)}`;
    if (!app.vault.getAbstractFileByPath(to)) await app.vault.copy(s, to);
    out.push(to);
  }
  return out;
}

/** Apply `retarget` to one frontmatter value. Returns the new value and how many
 *  links it changed. A plain-text `attachments` entry counts as a link. */
function fixFrontmatterValue(value: unknown, retarget: Retarget, inAttachments: boolean): { value: unknown; changed: number } {
  if (typeof value === "string") {
    if (value.includes("[[") || value.includes("](")) {
      const r = rewriteLinks(value, retarget, { raw: true });
      return { value: r.text, changed: r.changed };
    }
    if (inAttachments && value.trim()) {
      const next = retarget(attachmentLinkPath(value));
      if (next) return { value: toAttachmentLink(next), changed: 1 };
    }
    return { value, changed: 0 };
  }
  if (Array.isArray(value)) {
    let changed = 0;
    const out = value.map((v) => {
      const r = fixFrontmatterValue(v, retarget, inAttachments);
      changed += r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = fixFrontmatterValue(v, retarget, false);
      changed += r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: 0 };
}

function fixFrontmatter(fm: Record<string, unknown>, retarget: Retarget): number {
  let changed = 0;
  for (const key of Object.keys(fm)) {
    const r = fixFrontmatterValue(fm[key], retarget, key === "attachments");
    if (r.changed) { fm[key] = r.value; changed += r.changed; }
  }
  return changed;
}

function parseFrontmatterOf(text: string): Record<string, unknown> | null {
  const info = getFrontMatterInfo(text);
  if (!info.exists) return null;
  try { return (parseYaml(info.frontmatter) as Record<string, unknown>) ?? null; }
  catch { return null; }
}

/** Point one note's links through `retarget`. `process` so an edit landing at
 *  the same moment can't be overwritten; frontmatter only when it really has a
 *  matching link, because the YAML writer reformats whatever it touches. */
async function rewriteNote(plugin: StashpadPlugin, note: TFile, retarget: Retarget): Promise<void> {
  const app = plugin.app;
  plugin.linkRewriteQuiet.set(note, Date.now() + 5000);
  await app.vault.process(note, (data) => rewriteLinks(data, retarget).text);
  const fm = parseFrontmatterOf(await app.vault.read(note));
  if (fm && fixFrontmatter(fm, retarget) > 0) {
    await app.fileManager.processFrontMatter(note, (m: Record<string, unknown>) => { fixFrontmatter(m, retarget); });
  }
  plugin.linkRewriteQuiet.set(note, Date.now() + 5000);
}

/** How many links in `note` `matches` still claims, from the note's current text. */
async function countLinks(app: App, note: TFile, matches: (linkpath: string) => boolean): Promise<number> {
  const text = await app.vault.read(note);
  let n = 0;
  const count: Retarget = (lp) => { if (matches(lp)) n++; return null; };
  rewriteLinks(text, count);
  const fm = parseFrontmatterOf(text);
  if (fm) fixFrontmatter(JSON.parse(JSON.stringify(fm)) as Record<string, unknown>, count);
  return n;
}

function originalsDir(plugin: StashpadPlugin, holder: string): string {
  const seg = formatDateOnly(Date.now(), plugin.settings).replace(/[/\\:]+/g, "-").replace(/\s+/g, " ").trim() || "undated";
  return `${archiveSubfolderOf(holder)}/${ORIGINALS_DIR}/${seg}`;
}

async function freePath(app: App, dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let path = `${dir}/${name}`;
  for (let i = 1; app.vault.getAbstractFileByPath(path) || await app.vault.adapter.exists(path); i++) path = `${dir}/${stem}-${i}${ext}`;
  return path;
}

/** Phase 2: split the chosen files, one at a time. */
export async function executeAttachmentSplit(
  plugin: StashpadPlugin,
  items: SplitItem[],
  opts: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<SplitRunResult> {
  const app = plugin.app;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
  const result: SplitRunResult = { runId, done: [], skipped: [], keptOriginals: [], stopped: false };

  // One log per holding folder, written BEFORE anything changes.
  const logs = new Map<string, { path: string; log: SplitLog }>();
  const entryOf = new Map<SplitItem, SplitLogEntry>();
  for (const it of items) {
    let rec = logs.get(it.holder);
    if (!rec) {
      const dir = originalsDir(plugin, it.holder);
      await ensureFolder(app, dir);
      rec = { path: `${dir}/${LOG_PREFIX}${stamp}.json`, log: { version: 1, runId, at: new Date().toISOString(), status: "running", entries: [] } };
      logs.set(it.holder, rec);
    }
    const entry: SplitLogEntry = {
      original: it.path, archivedTo: null, size: it.size, holder: it.holder,
      copies: it.copies.map((c) => ({ folder: c.folder, path: "", notes: c.notes.map((n) => n.path) })),
      status: "planned",
    };
    rec.log.entries.push(entry);
    entryOf.set(it, entry);
  }
  const save = async (holder: string): Promise<void> => {
    const rec = logs.get(holder);
    if (rec) await app.vault.adapter.write(rec.path, JSON.stringify(rec.log, null, 2));
  };
  for (const holder of logs.keys()) await save(holder);
  const canvases = await canvasReferences(app); // fresh: the preview may be old

  const total = items.length;
  for (let i = 0; i < total; i++) {
    if (opts.shouldStop?.()) { result.stopped = true; break; }
    const it = items[i];
    const entry = entryOf.get(it) as SplitLogEntry;
    opts.onProgress?.(i, total);
    // The list was fixed at the preview; anything since is left for next time.
    if (app.vault.getAbstractFileByPath(it.path) !== it.file || it.file.stat.mtime !== it.mtime || it.file.stat.size !== it.size) {
      entry.status = "skipped";
      entry.note = "changed since the preview";
      result.skipped.push({ path: it.path, reason: entry.note });
      await save(it.holder);
      continue;
    }
    const linksHere = (note: TFile, lp: string): boolean => app.metadataCache.getFirstLinkpathDest(lp, note.path) === it.file;
    const handled = new Set<string>();
    let remaining = 0;
    let failure: string | null = null;
    let allVerified = true;
    for (let c = 0; c < it.copies.length; c++) {
      const plan = it.copies[c];
      const logged = entry.copies[c];
      try {
        const placed = await placeCopy(app, it.file, plan.folder);
        logged.path = placed.path;
        if (!placed.verified) allVerified = false;
        logged.sidecars = await copySidecars(plugin, it.file, placed.path);
        const target = logged.path;
        for (const note of plan.notes) {
          if (app.vault.getAbstractFileByPath(note.path) !== note) continue; // deleted since the preview
          await rewriteNote(plugin, note, (lp) => (linksHere(note, lp) ? target : null));
          handled.add(note.path);
          remaining += await countLinks(app, note, (lp) => linksHere(note, lp));
        }
      } catch (e) {
        failure = (e as Error)?.message || "the copy failed";
        break;
      }
    }
    // Decide the original's fate from what's true now, not from the preview.
    let reason = it.keepOriginal ?? (failure ? `stopped part way: ${failure}` : null);
    if (!reason && remaining > 0) reason = "some links couldn't be updated";
    if (!reason && !allVerified) reason = "too large to confirm the copies on this device";
    if (!reason && canvases.has(it.path)) reason = "a canvas uses it";
    if (!reason) reason = await stillLinked(app, it.path, handled);
    if (!reason) {
      try {
        const dir = originalsDir(plugin, it.holder);
        await ensureFolder(app, dir);
        const to = await freePath(app, dir, it.file.name);
        // Worked out first: the lookup goes by the owner's current name.
        const archivedName = to.split("/").pop() ?? to;
        const sidecars = sidecarsOf(plugin, it.file)
          .map((s) => ({ file: s, to: `${dir}/${sidecarNameFor(s, it.file, archivedName)}` }));
        // vault.rename, NOT fileManager.renameFile: every link has already
        // moved, and the latter would rewrite links by the user's format setting.
        await app.vault.rename(it.file, to);
        entry.archivedTo = to;
        for (const s of sidecars) {
          const from = s.file.path;
          await app.vault.rename(s.file, s.to);
          (entry.sidecars ??= []).push({ from, to: s.to });
        }
      } catch (e) {
        reason = (e as Error)?.message || "the move to the archive failed";
      }
    }
    entry.status = failure ? "partial" : "done";
    if (reason) {
      entry.note = reason;
      result.keptOriginals.push({ path: it.path, reason });
    }
    result.done.push(entry);
    await save(it.holder);
    await sleep(PAUSE_MS);
  }
  opts.onProgress?.(total, total);
  for (const [holder, rec] of logs) {
    rec.log.status = "done";
    await save(holder);
  }
  return result;
}

export interface SplitRun {
  runId: string;
  at: string;
  undone: boolean;
  logs: { path: string; log: SplitLog }[];
}

/** Every recorded run, newest first. Finds the logs through the in-memory file
 *  tree, so a vault that has never split anything costs no disk reads. */
export async function findSplitRuns(plugin: StashpadPlugin): Promise<SplitRun[]> {
  const app = plugin.app;
  const runs = new Map<string, SplitRun>();
  const visit = async (folder: TFolder): Promise<void> => {
    for (const c of folder.children) {
      if (c instanceof TFolder) { await visit(c); continue; }
      if (!(c instanceof TFile) || c.extension !== "json" || !c.name.startsWith(LOG_PREFIX)) continue;
      try {
        const log = JSON.parse(await app.vault.read(c)) as SplitLog;
        if (log.version !== 1 || !log.runId) continue;
        let run = runs.get(log.runId);
        if (!run) { run = { runId: log.runId, at: log.at, undone: true, logs: [] }; runs.set(log.runId, run); }
        run.logs.push({ path: c.path, log });
        // A run stopped before its first file did nothing, so nothing to undo.
        if (log.status !== "undone" && log.entries.some((e) => e.status === "done" || e.status === "partial")) run.undone = false;
      } catch (e) { console.warn("[Stashpad] unreadable split log", c.path, e); }
    }
  };
  for (const folder of plugin.discoverStashpadFolders()) {
    const af = app.vault.getAbstractFileByPath(`${archiveSubfolderOf(folder)}/${ORIGINALS_DIR}`);
    if (af instanceof TFolder) await visit(af);
  }
  return [...runs.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export interface UndoResult {
  restored: number;
  /** Copies kept because they were edited or are still in use. */
  keptCopies: { path: string; reason: string }[];
  problems: { path: string; reason: string }[];
}

/** Put a run back: originals return, links point at them again, and the copies
 *  go to the trash unless they've been edited since. */
export async function undoSplitRun(plugin: StashpadPlugin, run: SplitRun): Promise<UndoResult> {
  const app = plugin.app;
  const result: UndoResult = { restored: 0, keptCopies: [], problems: [] };
  // Links written by the split may be seconds old, and the search below reads
  // the metadata cache.
  await sleep(1200);
  const folders = new Set(plugin.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")));
  const canvases = await canvasReferences(app);
  for (const { path: logPath, log } of run.logs) {
    relocateLogPaths(log, logPath);
    for (const entry of log.entries) {
      if (entry.status !== "done" && entry.status !== "partial") continue;
      if (entry.archivedTo) {
        const af = app.vault.getAbstractFileByPath(entry.archivedTo);
        if (af instanceof TFile) {
          if (app.vault.getAbstractFileByPath(entry.original)) {
            // Something else took the name. Pointing links there would attach
            // these notes to the wrong file.
            result.problems.push({ path: entry.original, reason: "a different file now has that name, so this one was left split" });
            continue;
          }
          await app.vault.rename(af, entry.original);
        }
      }
      for (const s of entry.sidecars ?? []) {
        const sf = app.vault.getAbstractFileByPath(s.to);
        if (sf instanceof TFile && !app.vault.getAbstractFileByPath(s.from)) await app.vault.rename(sf, s.from);
      }
      const original = app.vault.getAbstractFileByPath(entry.original);
      if (!(original instanceof TFile)) {
        result.problems.push({ path: entry.original, reason: "the original is missing, so its links were left on the copies" });
        continue;
      }
      const copies = new Map<string, TFile>();
      for (const c of entry.copies) {
        const f = c.path ? app.vault.getAbstractFileByPath(c.path) : null;
        if (f instanceof TFile) copies.set(f.path, f);
      }
      const refs = collectRefs(app, folders, copies);
      let incomplete = false;
      for (const c of entry.copies) {
        if (!c.path || c.undone) continue;
        const notes = new Set<TFile>();
        for (const p of c.notes) {
          const n = app.vault.getAbstractFileByPath(p);
          if (n instanceof TFile) notes.add(n);
        }
        const info = refs.get(c.path);
        for (const set of info?.byFolder.values() ?? []) for (const n of set) notes.add(n);
        for (const n of info?.outside ?? []) notes.add(n);
        const copy = copies.get(c.path) ?? null;
        const handled = new Set([...notes].map((n) => n.path));
        for (const note of notes) {
          await rewriteNote(plugin, note, (lp) => {
            if (lp === c.path) return entry.original;
            return copy && app.metadataCache.getFirstLinkpathDest(lp, note.path) === copy ? entry.original : null;
          });
        }
        if (!copy) {
          result.problems.push({ path: c.path, reason: "this copy was renamed or removed, so links to it couldn't all be restored" });
          incomplete = true;
          continue;
        }
        c.undone = true;
        const compared = await compareFiles(app, original, copy);
        if (compared !== "same") {
          result.keptCopies.push({ path: copy.path, reason: compared === "different" ? "edited since the split" : "too large to confirm it's unchanged on this device" });
          continue;
        }
        const inUse = canvases.has(copy.path) ? "a canvas uses it" : await stillLinked(app, copy.path, handled);
        if (inUse) {
          result.keptCopies.push({ path: copy.path, reason: inUse });
          continue;
        }
        await app.fileManager.trashFile(copy);
        for (const p of c.sidecars ?? []) {
          const sf = app.vault.getAbstractFileByPath(p);
          if (sf instanceof TFile) await app.fileManager.trashFile(sf);
        }
      }
      // A copy we couldn't reach leaves the entry open, so putting it back and
      // running Undo again can finish the job.
      if (!incomplete) {
        entry.status = "undone";
        result.restored++;
      }
      await sleep(PAUSE_MS);
    }
    // Entries left split stay eligible, so clearing the problem and running
    // Undo again finishes the job.
    if (!log.entries.some((e) => e.status === "done" || e.status === "partial")) log.status = "undone";
    await app.vault.adapter.write(logPath, JSON.stringify(log, null, 2));
  }
  return result;
}

/** A log records paths as they were. If the holding folder has since been
 *  renamed or moved, the log (which lives inside it) shows where it is now. */
function relocateLogPaths(log: SplitLog, logPath: string): void {
  const marker = `/archive/${ORIGINALS_DIR}/`;
  const at = logPath.indexOf(marker);
  if (at < 0) return;
  const holderNow = logPath.slice(0, at);
  for (const entry of log.entries) {
    const before = entry.holder;
    if (before === holderNow) continue;
    const move = (p: string): string => (p.startsWith(`${before}/`) ? `${holderNow}${p.slice(before.length)}` : p);
    entry.original = move(entry.original);
    if (entry.archivedTo) entry.archivedTo = move(entry.archivedTo);
    entry.sidecars = entry.sidecars?.map((s) => ({ from: move(s.from), to: move(s.to) }));
    for (const c of entry.copies) {
      c.path = move(c.path);
      c.notes = c.notes.map(move);
      c.sidecars = c.sidecars?.map(move);
      if (c.folder === before) c.folder = holderNow;
    }
    entry.holder = holderNow;
  }
}

/** 0.605.4: originals a split retired, mapped to a file still holding their
 *  content (the archived original, else a copy). A note's undo snapshot may hold
 *  such a file; writing it back would quietly undo the split and block a later
 *  Undo of it. */
export async function retiredAttachments(plugin: StashpadPlugin): Promise<Map<string, TFile>> {
  const app = plugin.app;
  const out = new Map<string, TFile>();
  try {
    for (const run of await findSplitRuns(plugin)) {
      if (run.undone) continue;
      for (const { path: logPath, log } of run.logs) {
        relocateLogPaths(log, logPath);
        for (const entry of log.entries) {
          if ((entry.status !== "done" && entry.status !== "partial") || !entry.archivedTo) continue;
          if (out.has(entry.original)) continue; // newest run first
          for (const p of [entry.archivedTo, ...entry.copies.map((c) => c.path)]) {
            const f = p ? app.vault.getAbstractFileByPath(p) : null;
            if (f instanceof TFile) { out.set(entry.original, f); break; }
          }
        }
      }
    }
  } catch (e) { console.warn("[Stashpad] couldn't read the split logs", e); }
  return out;
}

/** 0.605.6: is this snapshot file really the one a split retired? The path alone
 *  isn't proof: a different file may have taken that name since, and skipping it
 *  would lose it. Only identical bytes count. */
export async function isRetiredContent(app: App, retired: ReadonlyMap<string, TFile>, path: string, data: ArrayBuffer): Promise<boolean> {
  const source = retired.get(path);
  if (!source || source.stat.size !== data.byteLength) return false;
  try {
    const a = new Uint8Array(data);
    const b = new Uint8Array(await app.vault.readBinary(source));
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch { return false; }
}

/** 0.605.4: a note brought back from before a split still links to where the
 *  original used to be. Point it at its own folder's copy, making one if that
 *  folder has none (it may have been the only note there using the file). Only
 *  touches links that no longer resolve. Never throws: a restore must not fail
 *  because of this. Returns how many notes changed. */
export async function repointRestoredNotes(plugin: StashpadPlugin, notes: TFile[], alsoFolders: string[] = []): Promise<number> {
  const app = plugin.app;
  let changed = 0;
  try {
    if (!notes.length) return 0;
    interface Found { entry: SplitLogEntry; log: SplitLog; logPath: string }
    const byPath = new Map<string, Found>();
    const byName = new Map<string, Found | null>(); // null: two originals share the name
    const byArchived = new Map<string, Found>();
    for (const run of await findSplitRuns(plugin)) { // newest first, so the latest wins
      if (run.undone) continue;
      for (const { path: logPath, log } of run.logs) {
        relocateLogPaths(log, logPath);
        for (const entry of log.entries) {
          if ((entry.status !== "done" && entry.status !== "partial") || !entry.archivedTo || byPath.has(entry.original)) continue;
          const found = { entry, log, logPath };
          byPath.set(entry.original, found);
          byArchived.set(entry.archivedTo, found);
          const name = entry.original.split("/").pop() ?? entry.original;
          byName.set(name, byName.has(name) ? null : found);
        }
      }
    }
    if (!byPath.size) return 0;
    const folders = new Set([...plugin.discoverStashpadFolders(), ...alsoFolders].map((f) => f.replace(/\/+$/, "")));
    const lookup = (note: TFile, lp: string): Found | null => {
      // A short link can resolve to the archived original, which keeps its name.
      // That isn't "still works": it's the note reaching into the archive.
      const dest = app.metadataCache.getFirstLinkpathDest(lp, note.path);
      if (dest) return byArchived.get(dest.path) ?? null;
      return byPath.get(lp) ?? (lp.includes("/") ? null : byName.get(lp) ?? null);
    };
    for (const note of notes) {
      const needed = new Set<Found>();
      await countLinks(app, note, (lp) => {
        const f = lookup(note, lp);
        if (f) needed.add(f);
        return !!f;
      });
      if (!needed.size) continue;
      const owner = owningFolder(parentOf(note.path), folders);
      const targets = new Map<Found, string>();
      for (const f of needed) {
        const path = await copyForRestoredNote(plugin, f.entry, owner, note);
        if (!path) continue;
        targets.set(f, path);
        await app.vault.adapter.write(f.logPath, JSON.stringify(f.log, null, 2));
      }
      if (!targets.size) continue;
      await rewriteNote(plugin, note, (lp) => {
        const f = lookup(note, lp);
        return f ? targets.get(f) ?? null : null;
      });
      changed++;
    }
  } catch (e) { console.warn("[Stashpad] couldn't repoint restored notes", e); }
  return changed;
}

/** The copy a restored note should use, recorded in the log so Undo covers it. */
async function copyForRestoredNote(plugin: StashpadPlugin, entry: SplitLogEntry, owner: string | null, note: TFile): Promise<string | null> {
  const app = plugin.app;
  const live = entry.copies.filter((c) => c.path && !c.undone && app.vault.getAbstractFileByPath(c.path) instanceof TFile);
  const own = live.find((c) => c.folder === owner);
  if (own) { own.notes.push(note.path); return own.path; }
  // A note outside every Stashpad has no folder to give a copy to.
  if (!owner) {
    if (!live.length) return null;
    live[0].notes.push(note.path);
    return live[0].path;
  }
  const archived = entry.archivedTo ? app.vault.getAbstractFileByPath(entry.archivedTo) : null;
  const liveCopy = live.length ? app.vault.getAbstractFileByPath(live[0].path) : null;
  const source = archived instanceof TFile ? archived : liveCopy instanceof TFile ? liveCopy : null;
  if (!source) return null;
  const placed = await placeCopy(app, source, owner);
  entry.copies.push({ folder: owner, path: placed.path, notes: [note.path], sidecars: await copySidecars(plugin, source, placed.path) });
  return placed.path;
}

export interface FoundCopies {
  /** Compared byte for byte. */
  same: TFile[];
  /** Same size and a related name, but too large to compare on this device. */
  unverified: TFile[];
}

/** Every other file in the vault with the same content as `file`. `sameSize` is
 *  the vault's files of that size, when a caller checking many has them indexed. */
export async function findCopies(app: App, file: TFile, sameSize?: TFile[]): Promise<FoundCopies> {
  const out: FoundCopies = { same: [], unverified: [] };
  if (file.stat.size === 0) return out;
  const related = (f: TFile): boolean => f.basename.startsWith(file.basename) || file.basename.startsWith(f.basename);
  for (const f of sameSize ?? app.vault.getFiles()) {
    if (f === file || f.stat.size !== file.stat.size || f.extension !== file.extension) continue;
    try {
      const r = await compareFiles(app, file, f);
      if (r === "same") out.same.push(f);
      else if (r === "unknown" && related(f)) out.unverified.push(f);
    } catch { /* unreadable: not provably a copy */ }
  }
  return out;
}

/** Tell the user when attachments they're deleting also exist elsewhere. Called
 *  before the delete, while the files can still be compared. */
export async function warnAboutOtherCopies(plugin: StashpadPlugin, files: TFile[]): Promise<void> {
  showOtherCopiesWarning(plugin, await otherCopiesOf(plugin, files));
}

/** 0.605.5: the copies that will survive deleting `files`. Sizes are indexed once,
 *  so a folder with many attachments only reads files that could really match.
 *  `alsoDeleted` covers anything else going in the same delete. Sidecars don't
 *  count: they aren't copies of anything, and they follow their owner. */
export async function otherCopiesOf(plugin: StashpadPlugin, files: TFile[], alsoDeleted?: (f: TFile) => boolean): Promise<FoundCopies> {
  const same = new Map<string, TFile>();
  const unverified = new Map<string, TFile>();
  try {
    const bySize = new Map<number, TFile[]>();
    for (const f of plugin.app.vault.getFiles()) {
      const list = bySize.get(f.stat.size);
      if (list) list.push(f); else bySize.set(f.stat.size, [f]);
    }
    const deleting = new Set(files);
    const sidecarExts = new Set((plugin.settings.encryptCompanionExts ?? []).map((e) => e.trim().replace(/^\./, "").toLowerCase()));
    const survives = (c: TFile): boolean => !deleting.has(c) && !alsoDeleted?.(c);
    for (const f of files) {
      if (sidecarExts.has(f.extension.toLowerCase())) continue;
      const found = await findCopies(plugin.app, f, bySize.get(f.stat.size));
      for (const c of found.same) if (survives(c)) same.set(c.path, c);
      for (const c of found.unverified) if (survives(c)) unverified.set(c.path, c);
    }
  } catch (e) { console.warn("[Stashpad] copy check before delete failed", e); }
  return { same: [...same.values()], unverified: [...unverified.values()] };
}

export function showOtherCopiesWarning(plugin: StashpadPlugin, found: FoundCopies): void {
  const { same, unverified } = found;
  if (!same.length && !unverified.length) return;
  const lines: string[] = [];
  if (same.length) lines.push(`${same.length === 1 ? "A copy" : `${same.length} copies`} of what you deleted still ${same.length === 1 ? "exists" : "exist"} elsewhere:`, formatGroupedPaths(same.map((f) => f.path)));
  if (unverified.length) lines.push(`${unverified.length === 1 ? "This file" : "These files"} may also be a copy, but ${unverified.length === 1 ? "is" : "are"} too large to compare on this device:`, formatGroupedPaths(unverified.map((f) => f.path)));
  const all = [...same, ...unverified];
  plugin.notifications.show({
    message: lines.join("\n"),
    kind: "warning", category: "attachment", duration: 0, affectedPaths: all.map((f) => f.path),
    actions: [{ label: "Review copies", onClick: () => { new DeleteCopiesModal(plugin, all[0], found).open(); } }],
  });
}

/** The outcome, as one notification. The warning comes before the list so it
 *  survives being cut short on a phone. */
export function notifySplitResult(plugin: StashpadPlugin, r: SplitRunResult, onUndo: () => void): void {
  const n = r.done.length;
  const lines: string[] = [];
  if (n) {
    lines.push(`**${n} attachment${n === 1 ? " now has" : "s now have"} a separate copy per folder.** To remove something private, delete every copy: use "Find and delete all copies" on the attachment.`);
  } else {
    lines.push("No attachments were split.");
  }
  if (r.stopped) lines.push("Stopped early. Run it again to finish.");
  if (r.keptOriginals.length) {
    lines.push(`${r.keptOriginals.length} original${r.keptOriginals.length === 1 ? "" : "s"} stayed in place:`);
    for (const k of r.keptOriginals) lines.push(`• ${k.path.split("/").pop()}: ${k.reason}`);
  }
  if (r.skipped.length) {
    lines.push(`${r.skipped.length} skipped:`);
    for (const s of r.skipped) lines.push(`• ${s.path.split("/").pop()}: ${s.reason}`);
  }
  const copies = r.done.flatMap((e) => e.copies.map((c) => c.path)).filter(Boolean);
  if (copies.length) lines.push("New copies:", formatGroupedPaths(copies));
  plugin.notifications.show({
    message: lines.join("\n"),
    kind: r.keptOriginals.length || r.skipped.length ? "warning" : "success",
    category: "attachment", duration: 0, affectedPaths: copies,
    actions: n ? [{ label: "Undo", onClick: onUndo }] : [],
  });
}

/** The preview. Resolves with the files to split, or null on cancel. */
export class SplitPreviewModal extends Modal {
  private resolve!: (items: SplitItem[] | null) => void;
  readonly result = new Promise<SplitItem[] | null>((r) => { this.resolve = r; });
  private decided = false;
  private chosen = new Set<SplitItem>();

  constructor(app: App, private plugin: StashpadPlugin, private plan: SplitPlan) {
    super(app);
    for (const it of plan.items) if (!it.large) this.chosen.add(it);
  }

  onOpen(): void {
    this.modalEl.addClass("stashpad-attsplit-modal");
    this.setTitle("Give each folder its own copy");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const p = this.plan;
    const count = p.items.length;
    contentEl.createEl("p", { text: count
      ? `${count} attachment${count === 1 ? " is" : "s are"} used by more than one Stashpad folder. Nothing has changed yet.`
      : "No attachments need splitting." });
    if (count) {
      contentEl.createEl("p", { cls: "stashpad-attsplit-sub", text: "Each folder gets its own copy and its links are updated. The original then moves to its folder's archive. After this, deleting a file only affects one folder, but something private has to be deleted from every copy." });
      const tools = contentEl.createDiv({ cls: "stashpad-attsplit-tools" });
      tools.createEl("button", { text: "Select all" }).addEventListener("click", () => { for (const it of p.items) this.chosen.add(it); this.render(); });
      tools.createEl("button", { text: "Select none" }).addEventListener("click", () => { this.chosen.clear(); this.render(); });
      const large = p.items.filter((i) => i.large);
      if (large.length) {
        contentEl.createEl("h4", { text: `Large files (over ${this.plugin.settings.attachmentSplitWarnMB ?? 25} MB)` });
        contentEl.createEl("p", { cls: "stashpad-attsplit-sub", text: "Left unticked so you can decide. Each copy takes the same space again and has to sync." });
        this.renderGroups(contentEl, large);
      }
      const rest = p.items.filter((i) => !i.large);
      if (rest.length) this.renderGroups(contentEl, rest);
    }
    if (p.keptShared.length) this.renderKept(contentEl);
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(null));
    if (count) {
      const picked = p.items.filter((i) => this.chosen.has(i));
      const extra = picked.reduce((sum, i) => sum + i.size * i.copies.length, 0);
      const go = row.createEl("button", { cls: "mod-cta", text: picked.length ? `Split ${picked.length} (uses ${humanSize(extra)} more)` : "Split" });
      go.disabled = !picked.length;
      go.addEventListener("click", () => this.finish(picked));
    }
  }

  private renderGroups(host: HTMLElement, items: SplitItem[]): void {
    const byHolder = new Map<string, SplitItem[]>();
    for (const it of items) {
      const list = byHolder.get(it.holder);
      if (list) list.push(it); else byHolder.set(it.holder, [it]);
    }
    for (const [holder, list] of byHolder) {
      host.createDiv({ cls: "stashpad-attsplit-holder", text: `${holder}/_attachments/` });
      for (const it of list) this.renderItem(host, it);
    }
  }

  private renderItem(host: HTMLElement, it: SplitItem): void {
    const row = host.createDiv({ cls: "stashpad-attsplit-row" });
    const label = row.createEl("label", { cls: "stashpad-attsplit-main" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.chosen.has(it);
    box.addEventListener("change", () => {
      if (box.checked) this.chosen.add(it); else this.chosen.delete(it);
      this.render();
    });
    const text = label.createDiv({ cls: "stashpad-attsplit-text" });
    text.createDiv({ cls: "stashpad-attsplit-name", text: `${it.file.name} (${humanSize(it.size)})` });
    // Short names unless two folders would read the same.
    const short = it.usedBy.map((f) => f.split("/").pop() ?? f);
    text.createDiv({ cls: "stashpad-attsplit-sub", text: `Used by: ${(new Set(short).size === short.length ? short : it.usedBy).join(", ")}` });
    if (it.keepOriginal) text.createDiv({ cls: "stashpad-attsplit-sub", text: `The original stays in place: ${it.keepOriginal}.` });
    row.createEl("button", { cls: "stashpad-attsplit-keep", text: "Always keep shared" }).addEventListener("click", () => { void this.keepShared(it); });
  }

  private renderKept(host: HTMLElement): void {
    const details = host.createEl("details", { cls: "stashpad-attsplit-kept" });
    details.createEl("summary", { text: `Always kept shared (${this.plan.keptShared.length})` });
    for (const path of this.plan.keptShared) {
      const row = details.createDiv({ cls: "stashpad-attsplit-row" });
      row.createDiv({ cls: "stashpad-attsplit-main stashpad-attsplit-name", text: path });
      row.createEl("button", { cls: "stashpad-attsplit-keep", text: "Stop keeping" }).addEventListener("click", () => { void this.stopKeeping(path); });
    }
  }

  private async keepShared(it: SplitItem): Promise<void> {
    const s = this.plugin.settings;
    s.attachmentAlwaysShared = [...new Set([...(s.attachmentAlwaysShared ?? []), it.path])];
    await this.plugin.saveSettings();
    this.plan.items = this.plan.items.filter((i) => i !== it);
    this.plan.keptShared = [...new Set([...this.plan.keptShared, it.path])];
    this.chosen.delete(it);
    this.render();
  }

  private async stopKeeping(path: string): Promise<void> {
    const s = this.plugin.settings;
    s.attachmentAlwaysShared = (s.attachmentAlwaysShared ?? []).filter((p) => p !== path);
    await this.plugin.saveSettings();
    // The whole plan is rebuilt, because this file may be splittable again.
    this.plan = await planAttachmentSplit(this.plugin);
    this.chosen = new Set(this.plan.items.filter((i) => !i.large));
    this.render();
  }

  private finish(items: SplitItem[] | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(items);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) { this.decided = true; this.resolve(null); }
  }
}

/** Find every copy of a file and move the chosen ones to the trash. */
export class DeleteCopiesModal extends Modal {
  private chosen = new Set<TFile>();
  private files: TFile[] = [];
  private unverified = new Set<TFile>();

  /** `known`: review exactly these files instead of searching from `file`. */
  constructor(private plugin: StashpadPlugin, private file: TFile, private known?: FoundCopies) { super(plugin.app); }

  onOpen(): void {
    this.modalEl.addClass("stashpad-attsplit-modal");
    this.setTitle("Find and delete all copies");
    if (this.known) {
      // Anything deleted since the warning appeared has dropped out.
      const here = (f: TFile): boolean => this.app.vault.getAbstractFileByPath(f.path) === f;
      const same = this.known.same.filter(here);
      this.unverified = new Set(this.known.unverified.filter(here));
      this.files = [...same, ...this.unverified];
      this.chosen = new Set(same); // something unproven is never pre-ticked
      this.render();
      return;
    }
    this.contentEl.createEl("p", { text: "Looking for copies…" });
    void findCopies(this.app, this.file).then((found) => {
      this.unverified = new Set(found.unverified);
      this.files = [this.file, ...found.same, ...found.unverified];
      // Something unproven is never ticked for the trash on the user's behalf.
      this.chosen = new Set([this.file, ...found.same]);
      this.render();
    });
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.known
      ? `${this.files.length} cop${this.files.length === 1 ? "y" : "ies"} of what you deleted. Anything you delete here moves to the trash, and notes linking to it will show a broken link.`
      : this.files.length === 1
      ? `No other copies of ${this.file.name} were found.`
      : `${this.files.length} files look like copies of this one. Anything you delete moves to the trash, and notes linking to it will show a broken link.` });
    contentEl.createEl("p", { cls: "stashpad-attsplit-sub", text: "A locked note keeps its own encrypted copy, which can't be searched from here." });
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const f of this.files) {
      const linked = Object.values(resolved).filter((t) => (t ?? {})[f.path]).length;
      const row = contentEl.createDiv({ cls: "stashpad-attsplit-row" });
      const label = row.createEl("label", { cls: "stashpad-attsplit-main" });
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = this.chosen.has(f);
      box.addEventListener("change", () => {
        if (box.checked) this.chosen.add(f); else this.chosen.delete(f);
        this.render();
      });
      const text = label.createDiv({ cls: "stashpad-attsplit-text" });
      text.createDiv({ cls: "stashpad-attsplit-name", text: f.path });
      const sidecars = sidecarsOf(this.plugin, f).length;
      text.createDiv({ cls: "stashpad-attsplit-sub", text: `Linked from ${linked} note${linked === 1 ? "" : "s"}${sidecars ? `, and its ${sidecars === 1 ? "sidecar file goes" : `${sidecars} sidecar files go`} with it` : ""}` });
      if (this.unverified.has(f)) text.createDiv({ cls: "stashpad-attsplit-sub", text: "Same size and a similar name, but too large to compare on this device." });
    }
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const go = row.createEl("button", { cls: "mod-warning", text: `Move ${this.chosen.size} to trash` });
    go.disabled = !this.chosen.size;
    go.addEventListener("click", () => { void this.trash(); });
  }

  private async trash(): Promise<void> {
    let n = 0;
    for (const f of this.chosen) {
      // Looked up first: a sidecar is found through its owner's name and folder.
      // It goes too, or a private file's history would be left behind.
      const sidecars = sidecarsOf(this.plugin, f);
      try {
        await this.app.fileManager.trashFile(f);
        n++;
        for (const s of sidecars) {
          if (this.app.vault.getAbstractFileByPath(s.path) === s) await this.app.fileManager.trashFile(s);
        }
      } catch (e) { console.warn("[Stashpad] could not trash", f.path, e); }
    }
    new Notice(`Moved ${n} file${n === 1 ? "" : "s"} to the trash.`);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Pick an attachment, for the command palette route to DeleteCopiesModal. */
export class AttachmentPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private plugin: StashpadPlugin) {
    super(app);
    this.setPlaceholder("Find an attachment…");
  }

  getItems(): TFile[] {
    const folders = new Set(this.plugin.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")));
    const sidecarExts = new Set((this.plugin.settings.encryptCompanionExts ?? []).map((e) => e.trim().replace(/^\./, "").toLowerCase()));
    return this.app.vault.getFiles().filter((f) => f.extension !== "md" && !sidecarExts.has(f.extension.toLowerCase())
      && (f.path.includes("/_attachments/") || f.path.includes(`/${ORIGINALS_DIR}/`))
      && !f.name.startsWith(LOG_PREFIX)
      && owningFolder(parentOf(f.path), folders) !== null);
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    new DeleteCopiesModal(this.plugin, f).open();
  }
}
