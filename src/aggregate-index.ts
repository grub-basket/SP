import { App, TFile, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, siftMatch, parseAuthorRef } from "./types";
import { stripInlineMarkdown } from "./slug-service";

/** 0.273.0: the "All notes" master index — one flat, vault-wide table of every
 *  Stashpad note, with facet filters that fold most of the long-logged
 *  aggregate-view wishlist into a single surface instead of a tab per idea:
 *
 *    master index      the table itself (title · folder · author · dates)
 *    timeline          sort by modified/created
 *    by author         author facet
 *    by tag            tag facet
 *    by color          color facet
 *    attachments       "has files" chip
 *    imported          "imported" chip
 *    internal links    "[[links]]" chip (from the metadata cache)
 *    external links    "http(s)" chip (from the body text)
 *
 *    orphans           "Orphans" chip (0.273.1 — parent resolves nowhere)
 *
 *  Read-only: rows OPEN the note in its own Stashpad view; nothing here edits.
 *  Orphan REPAIR stays with the integrity check / fix-orphans commands — this
 *  only makes them browsable. */

export interface IndexRow {
  file: TFile;
  folder: string;
  id: string;
  title: string;
  created: number;   // epoch ms, 0 = unknown
  modified: number;  // epoch ms, 0 = unknown
  authorName: string;
  tags: string[];
  color: string | null;
  imported: boolean;
  hasAttachments: boolean;
  internalLinks: number;
  hasExternalLinks: boolean;
  isHome: boolean;
  obscured: boolean;
  /** 0.274.0 (due calendar): the note's `due` frontmatter as a local calendar
   *  day string "YYYY-MM-DD", or null. Kept as a day string (not epoch) because
   *  a bare `due: 2026-08-18` is a day, not an instant — see nodeMatchesDate. */
  dueDay: string | null;
  /** 0.274.0: every "YYYY-MM-DD" this note LINKS to (`[[2026-08-18]]`), for the
   *  calendar's "links to this day" membership rule. */
  linkedDays: string[];
  /** 0.273.1 (#8): the note's `parent` id doesn't resolve in its folder — it
   *  exists on disk but hangs off nothing, so no list ever shows it. Browsable
   *  here; REPAIR stays with the integrity check / fix-orphans commands. */
  orphan: boolean;
}

/** Caller-owned facet state — the same object is passed back on every re-render
 *  so choices survive (the task-triage pattern). */
export interface IndexState {
  query: string;
  folder: string;      // "all" | folder path
  author: string;      // "" = any; author NAME (ids differ per machine history)
  tag: string;         // "" = any
  color: string;       // "" = any; lowercase hex
  attachmentsOnly: boolean;
  importedOnly: boolean;
  internalOnly: boolean;
  externalOnly: boolean;
  orphansOnly: boolean;
  includeHome: boolean;
  sort: "modified" | "created" | "title" | "folder";
  /** Obscured rows the user tapped open in THIS view. Viewing state only. */
  revealed: Set<string>;
}
export function defaultIndexState(): IndexState {
  return {
    query: "", folder: "all", author: "", tag: "", color: "",
    attachmentsOnly: false, importedOnly: false, internalOnly: false, externalOnly: false,
    orphansOnly: false, includeHome: false, sort: "modified", revealed: new Set(),
  };
}

export interface IndexOpts {
  onOpen: (folder: string, id: string) => void;
}

const EXTERNAL_URL_RE = /https?:\/\/[^\s)\]>"']+/;

/** Collect one row per Stashpad note (direct children of each Stashpad folder,
 *  frontmatter `id` required — the same shape the tree indexes). Bodies are
 *  read via cachedRead: needed for the external-link facet and first-line
 *  titles, and Obsidian keeps contents memory-cached so a re-render is cheap.
 *  The one-shot cost on open is accepted for an on-demand tab. */
export async function collectIndexRows(app: App, plugin: StashpadPlugin): Promise<IndexRow[]> {
  const folders = new Set(plugin.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")));
  // Pre-pass: every folder's id set, so the main pass can tell an orphan (a
  // parent id that resolves nowhere in its folder) from a normal child. Cache
  // reads only — no file IO.
  const idsByFolder = new Map<string, Set<string>>();
  for (const f of app.vault.getMarkdownFiles()) {
    const dir = (f.parent?.path ?? "").replace(/\/+$/, "");
    if (!folders.has(dir)) continue;
    const fid = (app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined)?.id;
    if (typeof fid !== "string") continue;
    let set = idsByFolder.get(dir);
    if (!set) { set = new Set(); idsByFolder.set(dir, set); }
    set.add(fid);
  }
  const rows: IndexRow[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const dir = (f.parent?.path ?? "").replace(/\/+$/, "");
    if (!folders.has(dir)) continue;
    const cache = app.metadataCache.getFileCache(f);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const id = typeof fm.id === "string" ? fm.id : null;
    if (!id) continue;

    let body = "";
    try { body = (await app.vault.cachedRead(f)).replace(/^---\n[\s\S]*?\n---\n?/, ""); } catch { /* unreadable → sparse row */ }

    const heading = cache?.headings?.[0]?.heading;
    const firstLine = body.slice(0, 400).split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
    const title = stripInlineMarkdown(heading ?? firstLine).trim()
      || f.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ")
      || "Untitled";

    const links = cache?.links ?? [];
    const embeds = cache?.embeds ?? [];
    const hasExt = (raw: string): boolean => {
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(raw.split(/[?#]/)[0])?.[1]?.toLowerCase();
      return !!ext && ext !== "md";
    };
    const fmAtts = Array.isArray(fm.attachments) ? fm.attachments.length : 0;
    const hasAttachments = fmAtts > 0
      || embeds.some((e) => hasExt(e.link))
      || links.some((l) => hasExt(l.link));
    const internalLinks = links.filter((l) => !hasExt(l.link)).length;

    const tagSet = new Set<string>();
    if (Array.isArray(fm.tags)) for (const t of fm.tags) if (typeof t === "string") tagSet.add(t.replace(/^#/, ""));
    for (const t of cache?.tags ?? []) tagSet.add(t.tag.replace(/^#/, ""));

    const t = (v: unknown): number => { const n = Date.parse(String(v ?? "")); return Number.isFinite(n) ? n : 0; };
    // Day strings for the due calendar. moment normalises a bare `2026-08-18`
    // (UTC-midnight) and a full ISO timestamp to the same LOCAL calendar day,
    // matching view.ts's nodeMatchesDate so the calendar and the day filter agree.
    const dayStr = (v: unknown): string | null => {
      if (v == null || v === "") return null;
      const m = (moment as unknown as (x: unknown) => { isValid: () => boolean; format: (f: string) => string })(typeof v === "number" ? v : String(v));
      return m.isValid() ? m.format("YYYY-MM-DD") : null;
    };
    const DAY_RE = /\d{4}-\d{2}-\d{2}/g;
    const linkedDays = new Set<string>();
    for (const l of links) {
      for (const src of [l.link, l.displayText ?? ""]) {
        const hits = src.match(DAY_RE);
        if (hits) for (const h of hits) linkedDays.add(h);
      }
    }
    rows.push({
      file: f, folder: dir, id, title,
      created: t(fm.created), modified: t(fm.modified ?? fm.created),
      authorName: parseAuthorRef(fm.author)?.name ?? "",
      tags: [...tagSet],
      color: typeof fm.color === "string" && /^#[0-9a-f]{6}$/i.test(fm.color) ? fm.color.toLowerCase() : null,
      imported: fm.imported === true,
      hasAttachments,
      internalLinks,
      hasExternalLinks: EXTERNAL_URL_RE.test(body),
      isHome: id === ROOT_ID,
      obscured: plugin.isFileObscured(f),
      dueDay: dayStr(fm.due),
      linkedDays: [...linkedDays],
      orphan: id !== ROOT_ID && (() => {
        const parent = typeof fm.parent === "string" ? fm.parent : "";
        if (!parent) return true;                     // no parent at all
        if (parent === ROOT_ID) return false;         // top-level — fine
        return !(idsByFolder.get(dir)?.has(parent));  // parent id resolves nowhere
      })(),
    });
  }
  return rows;
}

const momentFn = moment as unknown as (ms: number) => { fromNow: () => string; format: (f: string) => string };

/** Render the index into `host`. Owns `host`; re-renders itself on any facet
 *  change (rows are re-collected — cachedRead makes that cheap after the first
 *  pass, and stale rows after an edit would be worse than the cost). */
export async function renderMasterIndex(
  host: HTMLElement, app: App, plugin: StashpadPlugin, state: IndexState, opts: IndexOpts,
): Promise<void> {
  const token = ((host as unknown as { __sIdxToken?: number }).__sIdxToken ?? 0) + 1;
  (host as unknown as { __sIdxToken?: number }).__sIdxToken = token;
  const rows = await collectIndexRows(app, plugin);
  if ((host as unknown as { __sIdxToken?: number }).__sIdxToken !== token) return; // superseded
  const rerender = (): void => { void renderMasterIndex(host, app, plugin, state, opts); };
  host.empty();
  host.addClass("stashpad-index");

  // ---- facet options come from the DATA, so a facet never offers a dead value ----
  const folders = [...new Set(rows.map((r) => r.folder))].sort((a, b) => a.localeCompare(b));
  const authors = [...new Set(rows.map((r) => r.authorName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const tags = [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));
  const colors = [...new Set(rows.map((r) => r.color).filter((c): c is string => !!c))].sort();

  const bar = host.createDiv({ cls: "stashpad-index-bar" });
  const search = bar.createEl("input", { type: "search", cls: "stashpad-index-search", attr: { placeholder: "Search title / folder / tags…" } });
  search.value = state.query;
  search.oninput = () => { state.query = search.value; paintRows(); };

  const select = (label: string, options: Array<{ v: string; label: string }>, cur: string, set: (v: string) => void): void => {
    const s = bar.createEl("select", { cls: "stashpad-index-select", attr: { "aria-label": label } });
    for (const o of options) {
      const opt = s.createEl("option", { text: o.label });
      opt.value = o.v;
      if (o.v === cur) opt.selected = true;
    }
    s.onchange = () => { set(s.value); rerender(); };
  };
  select("Folder", [{ v: "all", label: "All folders" }, ...folders.map((f) => ({ v: f, label: f.split("/").pop() || f }))], state.folder, (v) => { state.folder = v; });
  if (authors.length) select("Author", [{ v: "", label: "Any author" }, ...authors.map((a) => ({ v: a, label: a }))], state.author, (v) => { state.author = v; });
  if (tags.length) select("Tag", [{ v: "", label: "Any tag" }, ...tags.map((t) => ({ v: t, label: `#${t}` }))], state.tag, (v) => { state.tag = v; });
  if (colors.length) select("Color", [{ v: "", label: "Any color" }, ...colors.map((c) => ({ v: c, label: c }))], state.color, (v) => { state.color = v; });
  select("Sort", [
    { v: "modified", label: "Recent first" }, { v: "created", label: "Newest first" },
    { v: "title", label: "Title A→Z" }, { v: "folder", label: "By folder" },
  ], state.sort, (v) => { state.sort = v as IndexState["sort"]; });

  const chip = (label: string, active: boolean, toggle: () => void, title?: string): void => {
    const c = bar.createEl("button", { cls: "stashpad-index-chip" + (active ? " is-active" : ""), text: label });
    if (title) c.title = title;
    c.onclick = () => { toggle(); rerender(); };
  };
  chip("Files", state.attachmentsOnly, () => { state.attachmentsOnly = !state.attachmentsOnly; }, "Only notes with attachments");
  chip("Imported", state.importedOnly, () => { state.importedOnly = !state.importedOnly; }, "Only notes brought in by an import");
  chip("[[links]]", state.internalOnly, () => { state.internalOnly = !state.internalOnly; }, "Only notes linking to other notes");
  chip("http", state.externalOnly, () => { state.externalOnly = !state.externalOnly; }, "Only notes containing an external link");
  chip("Orphans", state.orphansOnly, () => { state.orphansOnly = !state.orphansOnly; }, "Only notes whose parent is missing — they exist on disk but no list shows them. Repair with the fix-orphans command.");
  chip("Home notes", state.includeHome, () => { state.includeHome = !state.includeHome; }, "Include each folder's home note");

  const countEl = host.createDiv({ cls: "stashpad-index-count" });
  const listEl = host.createDiv({ cls: "stashpad-index-list" });

  const matches = (r: IndexRow): boolean => {
    if (!state.includeHome && r.isHome) return false;
    if (state.folder !== "all" && r.folder !== state.folder) return false;
    if (state.author && r.authorName !== state.author) return false;
    if (state.tag && !r.tags.includes(state.tag)) return false;
    if (state.color && r.color !== state.color) return false;
    if (state.attachmentsOnly && !r.hasAttachments) return false;
    if (state.importedOnly && !r.imported) return false;
    if (state.internalOnly && r.internalLinks === 0) return false;
    if (state.externalOnly && !r.hasExternalLinks) return false;
    if (state.orphansOnly && !r.orphan) return false;
    // An OBSCURED note must not leak its title/tags through search: an
    // unrevealed one matches only on its folder (chrome, not content).
    const hay = r.obscured && !state.revealed.has(r.file.path)
      ? r.folder
      : `${r.title} ${r.folder} ${r.tags.join(" ")} ${r.authorName}`;
    return siftMatch(state.query, hay);
  };
  const cmp = (a: IndexRow, b: IndexRow): number => {
    switch (state.sort) {
      case "modified": return b.modified - a.modified;
      case "created": return b.created - a.created;
      case "title": return a.title.localeCompare(b.title);
      case "folder": return a.folder.localeCompare(b.folder) || b.modified - a.modified;
    }
  };

  /** Rows repaint on SEARCH keystrokes without rebuilding the facet bar, so the
   *  input keeps focus. Facet changes re-collect + full re-render. */
  const paintRows = (): void => {
    const shown = rows.filter(matches).sort(cmp);
    countEl.setText(`${shown.length} of ${rows.length} note${rows.length === 1 ? "" : "s"}`);
    listEl.empty();
    for (const r of shown) {
      const row = listEl.createDiv({ cls: "stashpad-index-row" });
      const blurred = r.obscured && !state.revealed.has(r.file.path);
      const main = row.createDiv({ cls: "stashpad-index-main" });
      const titleEl = main.createDiv({ cls: "stashpad-index-title" + (blurred ? " is-blurred" : ""), text: r.title });
      if (r.isHome) titleEl.createSpan({ cls: "stashpad-index-home-badge", text: "home" });
      const meta = main.createDiv({ cls: "stashpad-index-meta" });
      meta.createSpan({ cls: "stashpad-index-folder", text: r.folder.split("/").pop() || r.folder });
      if (r.modified) { const m = meta.createSpan({ text: momentFn(r.modified).fromNow() }); m.title = momentFn(r.modified).format("YYYY-MM-DD HH:mm"); }
      if (r.authorName && !blurred) meta.createSpan({ text: r.authorName });
      for (const t of blurred ? [] : r.tags.slice(0, 4)) meta.createSpan({ cls: "stashpad-index-tag", text: `#${t}` });

      const icons = row.createDiv({ cls: "stashpad-index-icons" });
      const ic = (name: string, title: string): void => { const s = icons.createSpan({ cls: "stashpad-index-ic" }); setIcon(s, name); s.title = title; };
      if (r.color) { const sw = icons.createSpan({ cls: "stashpad-index-swatch" }); sw.style.background = r.color; sw.title = r.color; }
      if (r.hasAttachments) ic("paperclip", "Has attachments");
      if (r.internalLinks > 0) ic("link", `${r.internalLinks} internal link${r.internalLinks === 1 ? "" : "s"}`);
      if (r.hasExternalLinks) ic("globe", "Contains an external link");
      if (r.imported) ic("download", "Imported");
      if (r.orphan) ic("unlink", "Orphan: its parent id resolves nowhere in this folder, so no list shows it. The fix-orphans command re-homes it.");
      if (r.obscured) ic("eye-off", blurred ? "Obscured — tap the row to reveal its title here" : "Obscured (revealed in this view)");

      row.onclick = () => {
        // Same contract as a list row: the first tap on an obscured row only
        // reveals; opening takes a second, deliberate tap.
        if (blurred) { state.revealed.add(r.file.path); paintRows(); return; }
        opts.onOpen(r.folder, r.id);
      };
    }
  };
  paintRows();
}
