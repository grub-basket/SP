/** 0.580.0 — add (or remove) the date-time prefix on EXISTING file names.
 *
 *  New notes and attachments get the prefix when they are made (see
 *  datePrefixFor in slug-service.ts). This module is the opt-in sweep for files
 *  that already exist, run from the "Add dates to existing file names" command
 *  / settings button, or from Rebootstrap when fileDatePrefixInRebootstrap is on.
 *
 *  Deliberately two phases, so it is careful rather than fast:
 *  1. planDatePrefixRenames — READ-ONLY. Walks every Stashpad folder's notes
 *     and its attachments folder and decides each file's new name, collecting
 *     what would be skipped and why. Nothing on disk changes.
 *  2. executeDatePrefixRenames — renames the planned files ONE AT A TIME with a
 *     pause between each, re-checking every file right before it is touched
 *     (it may have been renamed, moved or deleted since the plan was made).
 *     Stoppable between files. Writes an old → new list to the plugin's
 *     private folder so the run can be inspected or reversed by hand; the
 *     "Remove dates" mode is the built-in undo.
 *
 *  Only one sweep runs at a time (plugin.datePrefixRenameRunning), and it never
 *  runs while Rebootstrap does. Title-change renames cannot fight it: they
 *  ignore a prefix entirely (THE NO-FIGHT RULE in slug-service.ts).
 */
import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type StashpadPlugin from "./main";
import {
  attachmentStampMs, bodyToSlug, createdMsOf, datePrefixFor, DEFAULT_STOPWORDS, isNoteId,
  parseIdFromFilename, parseLegacyAttachmentPrefix, prefixFitsCreated, splitDatePrefix,
} from "./slug-service";
import { readId } from "./id-service";

export type DatePrefixMode = "add" | "remove";

export interface DatePrefixRenameItem {
  file: TFile;
  from: string;
  to: string;
  kind: "note" | "attachment";
}

export interface DatePrefixPlan {
  mode: DatePrefixMode;
  items: DatePrefixRenameItem[];
  /** Files left alone on purpose, with the reason. */
  skipped: { path: string; reason: string }[];
  /** Files that already have the wanted name (add: dated in the current format;
   *  remove: no date). */
  alreadyDone: number;
  folders: number;
  /** The Stashpad folders walked (their notes' `attachments` lists are fixed
   *  up after attachment renames). */
  folderList: string[];
  notesChecked: number;
  attachmentsChecked: number;
  /** Obsidian's "Automatically update internal links". Without it a rename
   *  would orphan every link to the file, so the sweep refuses to run. */
  linkUpdatesOn: boolean;
}

/** Pause between renames. Each rename makes Obsidian rewrite every link to the
 *  file (parent/children frontmatter, embeds), so pacing keeps the vault, the
 *  sync client and the open views from being hammered. */
const PAUSE_MS = 120;

const ROOT_ID = "__root__";

export function linkUpdatesOn(app: App): boolean {
  return !!(app.vault as { getConfig?: (k: string) => unknown }).getConfig?.("alwaysUpdateLinks");
}

/** The attachment folders the sweep covers: each Stashpad folder's own
 *  `_attachments`, plus the shared folder when attachments go to one place.
 *  Obsidian's own attachment folder is NOT covered: it can be the vault root
 *  or hold files that have nothing to do with Stashpad. */
function attachmentDirs(plugin: StashpadPlugin, folders: string[]): { dirs: string[]; shared: string | null } {
  const dirs = folders.map((f) => `${f}/_attachments`);
  const s = plugin.settings;
  let shared: string | null = null;
  if (s.attachmentLocation === "universal") {
    const u = (s.attachmentUniversalFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (u && !dirs.includes(u)) { dirs.push(u); shared = u; }
  }
  return { dirs, shared };
}

/** Phase 1: decide every rename. Read-only (reads each note to know its title). */
export async function planDatePrefixRenames(plugin: StashpadPlugin, mode: DatePrefixMode): Promise<DatePrefixPlan> {
  const app = plugin.app;
  const s = plugin.settings;
  // The sweep always writes the CURRENT format, even when new-file prefixes are
  // turned off: running "Add dates" is itself the request.
  const fmt = { fileDatePrefix: true, fileDatePrefixSep: s.fileDatePrefixSep ?? "-" };
  const folders = plugin.discoverStashpadFolders().map((f) => f.replace(/\/+$/, ""));
  const folderSet = new Set(folders);
  const plan: DatePrefixPlan = {
    mode, items: [], skipped: [], alreadyDone: 0, folders: folders.length, folderList: folders,
    notesChecked: 0, attachmentsChecked: 0, linkUpdatesOn: linkUpdatesOn(app),
  };
  const targets = new Set<string>();
  const stopwords = s.slugStopWords ?? DEFAULT_STOPWORDS;

  const consider = (
    file: TFile, kind: "note" | "attachment", ms: number | null, stemFloor: string,
    known?: { has: boolean; bare: string },
  ): void => {
    // `known`: the split is certain (the note's title is known). Otherwise guess
    // from the shape plus the created time. `stemFloor`: what must remain after
    // removing a prefix for it to count as one (a whole-date title keeps it).
    let has: boolean, bare: string;
    if (known) ({ has, bare } = known);
    else {
      const sp = splitDatePrefix(file.name);
      has = !!sp && sp.rest !== stemFloor && prefixFitsCreated(sp.ms, ms);
      bare = has ? sp!.rest : file.name;
    }
    let to: string;
    if (mode === "add") {
      if (ms == null) { plan.skipped.push({ path: file.path, reason: "no creation date to use" }); return; }
      to = `${datePrefixFor(fmt, ms)}-${bare}`;
    } else {
      if (!has) { plan.alreadyDone++; return; }
      to = bare;
    }
    if (to === file.name) { plan.alreadyDone++; return; }
    const dir = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "";
    const toPath = dir ? `${dir}/${to}` : to;
    if (targets.has(toPath) || app.vault.getAbstractFileByPath(toPath)) {
      plan.skipped.push({ path: file.path, reason: `the new name is already taken (${to})` });
      return;
    }
    targets.add(toPath);
    plan.items.push({ file, from: file.path, to: toPath, kind });
  };

  // Notes: the direct children of each Stashpad folder (the same set the
  // Rebootstrap title pass walks). Home notes are left alone: Stashpad finds
  // a folder's home note by its exact name.
  for (const file of app.vault.getMarkdownFiles()) {
    const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    if (!folderSet.has(dir)) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const fmId = readId(fm?.id);
    if (!fmId || fmId === ROOT_ID) continue;
    const fnId = parseIdFromFilename(file.basename);
    const id = fnId ?? (isNoteId(fmId) ? fmId : null);
    if (!id || id !== fmId) continue; // not a Stashpad note (or a broken one Rebootstrap repairs)
    plan.notesChecked++;
    // Read the title so a title that itself starts with a date-time is never
    // taken for (or stripped as) a prefix: the name is [prefix-]<slug>-<id>.md.
    let known: { has: boolean; bare: string } | undefined;
    try {
      const raw = await app.vault.cachedRead(file);
      const body = raw.startsWith("---") ? raw.slice(raw.indexOf("\n---", 3) + 4).replace(/^\r?\n/, "") : raw;
      const tail = `${bodyToSlug(body, stopwords)}-${id}.md`;
      if (file.name === tail) known = { has: false, bare: tail };
      else if (file.name.endsWith(`-${tail}`)) {
        const sp = splitDatePrefix(file.name.slice(0, file.name.length - tail.length));
        if (sp && sp.rest === "") known = { has: true, bare: tail };
      }
      // Otherwise the name's title part is stale (Rebootstrap fixes that): guess.
    } catch { /* unreadable → guess from the name */ }
    consider(file, "note", createdMsOf(fm?.created), `${id}.md`, known);
  }

  // Attachments. A shared ("universal") attachments folder may also hold files
  // that are nothing to do with Stashpad (it is often the same folder Obsidian
  // uses), so there only files a Stashpad note links to are touched.
  const { dirs, shared } = attachmentDirs(plugin, folders);
  let linkedFromStashpad: Set<string> | null = null;
  if (shared) {
    linkedFromStashpad = new Set();
    const resolved = app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
    for (const [src, targets] of Object.entries(resolved)) {
      const dir = src.slice(0, Math.max(0, src.lastIndexOf("/")));
      if (!folderSet.has(dir)) continue;
      for (const t of Object.keys(targets)) linkedFromStashpad.add(t);
    }
  }
  for (const dirPath of dirs) {
    const af = app.vault.getAbstractFileByPath(dirPath);
    if (!(af instanceof TFolder)) continue;
    for (const c of af.children) {
      if (!(c instanceof TFile)) continue;
      if (dirPath === shared && !linkedFromStashpad!.has(c.path)) continue;
      plan.attachmentsChecked++;
      if (parseLegacyAttachmentPrefix(c.name)) {
        plan.skipped.push({ path: c.path, reason: "old-style name; run Rebootstrap first" });
        continue;
      }
      // An attachment has no title to confuse with a date, so a leading date of
      // the right shape IS its prefix. Its time: the upload stamp in the name;
      // else the date already in front (only the separator may change); only
      // then the file's creation time, which a sync resets to the download time.
      const stem = c.extension ? c.name.slice(0, -(c.extension.length + 1)) : c.name;
      const sp = splitDatePrefix(c.name);
      const has = !!sp && !!sp.rest && sp.rest !== `.${c.extension}`;
      const bareStem = (has ? splitDatePrefix(stem)?.rest : null) || stem;
      const ms = attachmentStampMs(bareStem) ?? (has ? sp!.ms : (c.stat?.ctime || null));
      consider(c, "attachment", ms, "", { has, bare: has ? sp!.rest : c.name });
    }
  }
  return plan;
}

export interface DatePrefixRunResult {
  renamed: number;
  /** Notes whose plain-text `attachments` entries were pointed at renamed files. */
  attachmentListsFixed: number;
  failed: { path: string; reason: string }[];
  stopped: boolean;
  logPath: string | null;
}

/** Phase 2: rename the planned files, one at a time. */
export async function executeDatePrefixRenames(
  plugin: StashpadPlugin,
  plan: DatePrefixPlan,
  opts: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<DatePrefixRunResult> {
  const app = plugin.app;
  const result: DatePrefixRunResult = { renamed: 0, attachmentListsFixed: 0, failed: [], stopped: false, logPath: null };
  if (!plan.linkUpdatesOn || !linkUpdatesOn(app)) {
    // Re-checked here too: the setting can change between plan and run.
    throw new Error("Obsidian's \"Automatically update internal links\" is off, so renaming would break links. Turn it on in Settings → Files and links, then try again.");
  }
  const done: { from: string; to: string }[] = [];
  const total = plan.items.length;
  // Who links to what, resolved to TFile objects BEFORE any rename (they keep
  // their identity when a later item renames them). Each rename makes Obsidian
  // rewrite those notes' links; they are marked quiet for a few seconds so the
  // rewrite isn't recorded as the user's edit (AuthorshipTracker checks it).
  const linkers = new Map<string, TFile[]>();
  const resolved = app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
  for (const [src, targets] of Object.entries(resolved)) {
    const sf = app.vault.getAbstractFileByPath(src);
    if (!(sf instanceof TFile)) continue;
    for (const t of Object.keys(targets)) {
      const list = linkers.get(t);
      if (list) list.push(sf); else linkers.set(t, [sf]);
    }
  }
  const quiet = (path: string): void => {
    const until = Date.now() + 5000;
    for (const f of linkers.get(path) ?? []) plugin.linkRewriteQuiet.set(f, until);
  };
  for (let i = 0; i < total; i++) {
    if (opts.shouldStop?.()) { result.stopped = true; break; }
    const it = plan.items[i];
    opts.onProgress?.(i, total);
    // Re-check right before touching it: still there, under the same name, and
    // the target still free.
    if (app.vault.getAbstractFileByPath(it.from) !== it.file) {
      result.failed.push({ path: it.from, reason: "moved, renamed or deleted since the check" });
      continue;
    }
    if (app.vault.getAbstractFileByPath(it.to)) {
      result.failed.push({ path: it.from, reason: "the new name was taken since the check" });
      continue;
    }
    try {
      quiet(it.from);
      await app.fileManager.renameFile(it.file, it.to);
      quiet(it.from); // restart the window from when the rewrite actually began
      done.push({ from: it.from, to: it.to });
      result.renamed++;
    } catch (e) {
      result.failed.push({ path: it.from, reason: (e as Error)?.message || "rename failed" });
    }
    await new Promise((r) => window.setTimeout(r, PAUSE_MS));
  }
  opts.onProgress?.(total, total);
  const attRenames = done.filter((d) => plan.items.some((it) => it.kind === "attachment" && it.from === d.from));
  if (attRenames.length) result.attachmentListsFixed = await fixAttachmentLists(plugin, plan.folderList, attRenames);
  if (done.length) {
    try {
      const dir = plugin.pluginPrivatePath("rename-logs");
      if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = `${dir}/${stamp}-${plan.mode}-dates.json`;
      await app.vault.adapter.write(path, JSON.stringify({ mode: plan.mode, at: new Date().toISOString(), renames: done }, null, 2));
      result.logPath = path;
    } catch (e) { console.warn("[Stashpad] could not write the rename log", e); }
  }
  return result;
}

/** Obsidian rewrites `[[links]]` when a file is renamed, but an `attachments`
 *  frontmatter entry can be a PLAIN string (the embed's link text), which it
 *  leaves alone. Point those at the new names so the attachment list and the
 *  "everything" views don't treat the renamed files as strays. */
async function fixAttachmentLists(
  plugin: StashpadPlugin, folders: string[], renames: { from: string; to: string }[],
): Promise<number> {
  const app = plugin.app;
  const map = new Map<string, string>();
  const base = (p: string): string => p.split("/").pop() ?? p;
  for (const r of renames) { map.set(r.from, r.to); map.set(base(r.from), base(r.to)); }
  const mapEntry = (e: unknown): unknown => {
    if (typeof e !== "string" || /^!?\[\[/.test(e)) return e;
    if (map.has(e)) return map.get(e);
    const tail = base(e);
    return tail !== e && map.has(tail) ? `${e.slice(0, e.length - tail.length)}${map.get(tail)}` : e;
  };
  const folderSet = new Set(folders);
  let fixed = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!folderSet.has(file.parent?.path?.replace(/\/+$/, "") ?? "")) continue;
    const list = app.metadataCache.getFileCache(file)?.frontmatter?.attachments;
    if (!Array.isArray(list) || !list.some((e) => mapEntry(e) !== e)) continue;
    try {
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (Array.isArray(fm.attachments)) fm.attachments = fm.attachments.map(mapEntry);
      });
      fixed++;
      await new Promise((r) => window.setTimeout(r, 30));
    } catch (e) { console.warn("[Stashpad] could not update the attachments list", file.path, e); }
  }
  return fixed;
}

/** Group skip reasons for display: "reason (count)". */
function summarizeSkips(list: { path: string; reason: string }[]): string[] {
  const by = new Map<string, number>();
  for (const s of list) {
    const key = s.reason.replace(/ \(.*\)$/, "");
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([r, n]) => `${n} × ${r}`);
}

/** The confirm step between plan and run. Resolves true to go ahead. */
export class DatePrefixConfirmModal extends Modal {
  private resolve!: (go: boolean) => void;
  readonly result = new Promise<boolean>((r) => { this.resolve = r; });
  private decided = false;

  constructor(app: App, private plan: DatePrefixPlan) { super(app); }

  onOpen(): void {
    const p = this.plan;
    const { contentEl } = this;
    const adding = p.mode === "add";
    this.setTitle(adding ? "Add dates to file names" : "Remove dates from file names");
    const notes = p.items.filter((i) => i.kind === "note").length;
    const atts = p.items.length - notes;
    contentEl.createEl("p", {
      text: `Checked ${p.notesChecked} note${p.notesChecked === 1 ? "" : "s"} and ${p.attachmentsChecked} attachment${p.attachmentsChecked === 1 ? "" : "s"} in ${p.folders} Stashpad folder${p.folders === 1 ? "" : "s"}. Nothing has been changed yet.`,
    });
    const ul = contentEl.createEl("ul");
    ul.createEl("li", { text: `${adding ? "Will add a date to" : "Will remove the date from"} ${notes} note${notes === 1 ? "" : "s"} and ${atts} attachment${atts === 1 ? "" : "s"}.` });
    ul.createEl("li", { text: `${p.alreadyDone} already ${adding ? "have a date in this format" : "have no date"}.` });
    if (p.skipped.length) {
      const li = ul.createEl("li", { text: `${p.skipped.length} will be left alone:` });
      const sub = li.createEl("ul");
      for (const line of summarizeSkips(p.skipped)) sub.createEl("li", { text: line });
    }
    if (p.items.length) {
      contentEl.createEl("p", { text: "Examples:" });
      const ex = contentEl.createEl("ul", { cls: "stashpad-date-prefix-examples" });
      for (const it of p.items.slice(0, 6)) {
        const li = ex.createEl("li");
        li.createEl("code", { text: it.from.split("/").pop() ?? it.from });
        li.appendText(" → ");
        li.createEl("code", { text: it.to.split("/").pop() ?? it.to });
      }
      const secs = Math.max(1, Math.round((p.items.length * (PAUSE_MS + 80)) / 1000));
      contentEl.createEl("p", {
        text: `Files are renamed one at a time with a short pause, about ${secs < 90 ? `${secs} second${secs === 1 ? "" : "s"}` : `${Math.round(secs / 60)} minutes`}. You can stop part way; a list of every old and new name is saved so nothing is lost. Links to each file are updated as it is renamed.`,
      });
    }
    if (!p.linkUpdatesOn) {
      contentEl.createEl("p", {
        cls: "mod-warning",
        text: "Obsidian is set not to update links when a file is renamed, so renaming would break links. Turn on automatic link updates in Obsidian's files and links settings, then run this again.",
      });
    }
    const row = new Setting(contentEl);
    row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)));
    if (p.items.length && p.linkUpdatesOn) {
      row.addButton((b) => b.setCta().setButtonText(`Rename ${p.items.length} file${p.items.length === 1 ? "" : "s"}`).onClick(() => this.finish(true)));
    }
  }

  private finish(go: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(go);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) { this.decided = true; this.resolve(false); }
  }
}

/** A persistent progress notice with a Stop button, in Rebootstrap's style. */
export function datePrefixProgressNotice(title: string): {
  update: (done: number, total: number) => void;
  stopRequested: () => boolean;
  finish: (ok: boolean, heading: string, detail: string) => void;
} {
  const notice = new Notice("", 0);
  const el = notice.noticeEl;
  el.empty();
  el.addClass("stashpad-progress-notice");
  el.createDiv({ cls: "stashpad-progress-title", text: title });
  const bar = el.createDiv({ cls: "stashpad-progress-bar" });
  const fill = bar.createDiv({ cls: "stashpad-progress-fill" });
  const sub = el.createDiv({ cls: "stashpad-progress-sub", text: "Starting…" });
  let stop = false;
  const btn = el.createEl("button", { text: "Stop" });
  btn.addEventListener("click", (e) => {
    // The notice dismisses itself on click; keep it up so progress stays visible.
    e.stopPropagation();
    stop = true;
    btn.disabled = true;
    btn.setText("Stopping…");
  });
  return {
    update: (done, total) => {
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
      fill.style.width = `${pct}%`;
      sub.setText(`${done} of ${total} · ${pct}%`);
    },
    stopRequested: () => stop,
    finish: (ok, heading, detail) => {
      el.empty();
      el.removeClass("stashpad-progress-notice");
      el.addClass(ok ? "stashpad-progress-done" : "stashpad-progress-error");
      el.createDiv({ cls: "stashpad-progress-title", text: heading });
      el.createDiv({ cls: "stashpad-progress-sub", text: detail });
    },
  };
}

/** One-line outcome for the finished notice. */
export function describeRun(mode: DatePrefixMode, r: DatePrefixRunResult): string {
  const parts = [`${mode === "add" ? "Added a date to" : "Removed the date from"} ${r.renamed} file${r.renamed === 1 ? "" : "s"}`];
  if (r.stopped) parts.push("stopped early");
  if (r.failed.length) parts.push(`${r.failed.length} skipped (changed since the check; see console)`);
  if (r.logPath) parts.push(`old and new names saved to ${r.logPath}`);
  return `${parts.join("; ")}.`;
}
