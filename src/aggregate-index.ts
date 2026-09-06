import { App, Notice, TFile, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, siftMatch, parseAuthorRef, writeCompletedFm } from "./types";
import { stripInlineMarkdown } from "./slug-service";
import { ConfirmModal } from "./modals";

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
  /** 0.296.0 (perf): `undefined` = NOT COMPUTED YET. Deciding this needs the
   *  note's BODY, so it is only computed at collect time when the "http" facet
   *  is already on. Turning the chip on later triggers a one-off fill pass
   *  (fillExternalLinks) that reads just the unknown rows. Treat undefined as
   *  "unknown", never as false — the filter and the globe icon both do. */
  hasExternalLinks: boolean | undefined;
  /** 0.275.2: the note contains at least one internal [[wikilink]] whose target
   *  resolves to no existing file (Obsidian's unresolvedLinks). Sibling of
   *  `orphan` — an orphan has a missing PARENT; a broken link POINTS at
   *  something missing. */
  hasBrokenLinks: boolean;
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
  brokenOnly: boolean;
  staleOnly: boolean;
  includeHome: boolean;
  sort: "modified" | "created" | "title" | "folder";
  /** Obscured rows the user tapped open in THIS view. Viewing state only. */
  revealed: Set<string>;
  /** 0.276.6: multi-select mode + the selected note file paths, for bulk acts. */
  selectMode: boolean;
  selected: Set<string>;
  /** 0.295.2 (perf): the last collected row set, reused by every UI-only
   *  repaint (facet dropdowns, chips, sort, select-mode, search). Collection is
   *  a vault-wide sweep with a cachedRead per note, so it must happen once per
   *  DATA change — not once per CLICK. null = stale, collect on next render.
   *  Invalidated by invalidateIndexRows() from the view's vault-event path. */
  rowsCache: IndexRow[] | null;
}
export function defaultIndexState(): IndexState {
  return {
    query: "", folder: "all", author: "", tag: "", color: "",
    attachmentsOnly: false, importedOnly: false, internalOnly: false, externalOnly: false,
    orphansOnly: false, brokenOnly: false, staleOnly: false, includeHome: false, sort: "modified", revealed: new Set(),
    selectMode: false, selected: new Set(),
    rowsCache: null,
  };
}

/** 0.295.2 (perf): mark the cached rows stale so the next render re-collects.
 *  Call this from anything that changes the underlying NOTES (vault events, the
 *  manual refresh button, a bulk action) — never from a facet/sort/select
 *  toggle, which is exactly the cost this cache exists to remove. */
export function invalidateIndexRows(state: IndexState): void {
  state.rowsCache = null;
}

export interface IndexOpts {
  onOpen: (folder: string, id: string) => void;
}

const EXTERNAL_URL_RE = /https?:\/\/[^\s)\]>"']+/;
/** Strip a leading YAML frontmatter block — the body is what both the first-line
 *  title and the external-link test care about. */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
/** 0.275.2: "stale" = last modified more than ~6 months ago. */
const STALE_MS = 183 * 86400000;

/** Collect one row per Stashpad note (direct children of each Stashpad folder,
 *  frontmatter `id` required — the same shape the tree indexes). Bodies are
 *  read via cachedRead: needed for the external-link facet and first-line
 *  titles, and Obsidian keeps contents memory-cached so a re-render is cheap.
 *  The one-shot cost on open is accepted for an on-demand tab.
 *
 *  0.296.0 (perf): the body read is now CONDITIONAL. It is needed for (a) the
 *  first-line title, only when the note has no heading in the metadata cache,
 *  and (b) the external-link facet, only when that chip is already on
 *  (`needExternal`). Most Stashpad notes are plain text with no heading, so in
 *  practice the title still pulls most bodies in — the real saving is that an
 *  index opened with the "http" chip OFF (the default) no longer pays for the
 *  facet, and a heading-led note is skipped entirely. */
export async function collectIndexRows(
  app: App, plugin: StashpadPlugin, opts?: { needExternal?: boolean },
): Promise<IndexRow[]> {
  const needExternal = opts?.needExternal === true;
  const folders = new Set(plugin.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")));
  // Pre-pass: every folder's id set, so the main pass can tell an orphan (a
  // parent id that resolves nowhere in its folder) from a normal child. Cache
  // reads only — no file IO.
  // 0.295.2 (perf): ONE getMarkdownFiles sweep + ONE getFileCache per file,
  // building the candidate list and the id sets together. The old code swept
  // the whole vault twice and read every file's cache twice.
  const idsByFolder = new Map<string, Set<string>>();
  type Candidate = { f: TFile; dir: string; cache: ReturnType<App["metadataCache"]["getFileCache"]>; fm: Record<string, unknown>; id: string };
  const candidates: Candidate[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const dir = (f.parent?.path ?? "").replace(/\/+$/, "");
    if (!folders.has(dir)) continue;
    const cache = app.metadataCache.getFileCache(f);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const id = typeof fm.id === "string" ? fm.id : null;
    if (!id) continue;
    let set = idsByFolder.get(dir);
    if (!set) { set = new Set(); idsByFolder.set(dir, set); }
    set.add(id);
    candidates.push({ f, dir, cache, fm, id });
  }
  const rows: IndexRow[] = [];
  for (const { f, dir, cache, fm, id } of candidates) {

    // 0.296.0 (perf): read the body ONLY if something still needs it.
    const heading = cache?.headings?.[0]?.heading;
    let body = "";
    if (needExternal || !heading) {
      try { body = (await app.vault.cachedRead(f)).replace(FRONTMATTER_RE, ""); } catch { /* unreadable → sparse row */ }
    }

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
      // 0.296.0 (perf): undefined until the facet actually asks for it.
      hasExternalLinks: needExternal ? EXTERNAL_URL_RE.test(body) : undefined,
      hasBrokenLinks: Object.keys((app.metadataCache as unknown as { unresolvedLinks?: Record<string, Record<string, number>> }).unresolvedLinks?.[f.path] ?? {}).length > 0,
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

/** Render the index into `host`. Owns `host`.
 *
 *  0.295.2 (perf): rows are collected ONCE per data change and cached on the
 *  caller-owned state. A facet change (dropdown, chip, sort, select-mode) only
 *  rebuilds the bar + repaints from the cached rows — it no longer re-sweeps
 *  the vault and cachedReads every note. Staleness is driven by the view's
 *  existing vault/metadata event plumbing, which calls invalidateIndexRows()
 *  before each full render(), so an edit still lands on the next paint. */
export async function renderMasterIndex(
  host: HTMLElement, app: App, plugin: StashpadPlugin, state: IndexState, opts: IndexOpts,
): Promise<void> {
  const token = ((host as unknown as { __sIdxToken?: number }).__sIdxToken ?? 0) + 1;
  (host as unknown as { __sIdxToken?: number }).__sIdxToken = token;
  let collected = state.rowsCache;
  if (!collected) {
    // 0.296.0 (perf): only pay for the external-link scan if the chip is already
    // on; otherwise rows carry `hasExternalLinks: undefined` and the chip's own
    // toggle fills them in once, on demand.
    collected = await collectIndexRows(app, plugin, { needExternal: state.externalOnly });
    // Token guard kept: a slower, superseded collect must not paint over (or
    // cache) a newer one.
    if ((host as unknown as { __sIdxToken?: number }).__sIdxToken !== token) return;
    state.rowsCache = collected;
  }
  const rows: IndexRow[] = collected;
  /** Repaint the whole surface (bar + rows) from the CACHED rows. */
  const rerender = (): void => { void renderMasterIndex(host, app, plugin, state, opts); };
  /** 0.295.2 (perf): the rows themselves changed (a bulk action wrote/deleted
   *  notes) — drop the cache so this render re-collects rather than painting
   *  files that no longer exist. */
  const recollect = (): void => { state.rowsCache = null; rerender(); };
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
    // 0.295.2 (perf): a facet change is a FILTER change, not a data change, and
    // the option lists are derived from ALL rows (not the filtered set), so
    // they can't go stale here. Repaint the rows only — no bar rebuild, so the
    // search box keeps its focus and caret too.
    s.onchange = () => { set(s.value); paintRows(); };
  };
  select("Folder", [{ v: "all", label: "All folders" }, ...folders.map((f) => ({ v: f, label: f.split("/").pop() || f }))], state.folder, (v) => { state.folder = v; });
  if (authors.length) select("Author", [{ v: "", label: "Any author" }, ...authors.map((a) => ({ v: a, label: a }))], state.author, (v) => { state.author = v; });
  if (tags.length) select("Tag", [{ v: "", label: "Any tag" }, ...tags.map((t) => ({ v: t, label: `#${t}` }))], state.tag, (v) => { state.tag = v; });
  if (colors.length) select("Color", [{ v: "", label: "Any color" }, ...colors.map((c) => ({ v: c, label: c }))], state.color, (v) => { state.color = v; });
  select("Sort", [
    { v: "modified", label: "Recent first" }, { v: "created", label: "Newest first" },
    { v: "title", label: "Title A→Z" }, { v: "folder", label: "By folder" },
  ], state.sort, (v) => { state.sort = v as IndexState["sort"]; });

  // 0.295.2 (perf): `isActive` is a GETTER (was a snapshot boolean) so the chip
  // can restyle itself in place after a toggle without a full re-render.
  const chip = (label: string, isActive: () => boolean, toggle: () => void, title?: string, before?: () => Promise<void>): void => {
    const c = bar.createEl("button", { cls: "stashpad-index-chip" + (isActive() ? " is-active" : ""), text: label });
    if (title) c.title = title;
    // 0.295.2 (perf): toggle the chip's own active class and repaint the rows
    // instead of re-rendering (which used to re-collect the whole vault).
    // 0.296.0 (perf): `before` is an optional one-off "this facet needs data the
    // collect pass deliberately skipped" hook (see the http chip). It runs
    // BEFORE the repaint, and its result is cached on the rows, so a second
    // toggle of the same chip is free.
    c.onclick = () => {
      toggle();
      c.toggleClass("is-active", isActive());
      if (!before) { paintRows(); return; }
      c.disabled = true;
      void before().finally(() => {
        c.disabled = false;
        // A newer render (or a re-collect) superseded us — its own paint owns
        // the DOM now, so don't paint over it from this closure's stale rows.
        if ((host as unknown as { __sIdxToken?: number }).__sIdxToken !== token) return;
        paintRows();
      });
    };
  };
  /** 0.296.0 (perf): fill in `hasExternalLinks` for rows collected without it.
   *  One pass over just the unknown rows, mutating the CACHED row objects, so
   *  the cost is paid once per data change no matter how often the chip is
   *  toggled. A vault event still drops the whole cache, which is correct: the
   *  edited note's body may have gained or lost a URL. */
  const fillExternalLinks = async (): Promise<void> => {
    if (!state.externalOnly) return; // turning the chip OFF needs no data
    const missing = rows.filter((r) => r.hasExternalLinks === undefined);
    if (!missing.length) return;
    for (const r of missing) {
      try {
        const body = (await app.vault.cachedRead(r.file)).replace(FRONTMATTER_RE, "");
        r.hasExternalLinks = EXTERNAL_URL_RE.test(body);
      } catch { r.hasExternalLinks = false; /* unreadable → treated as "no link" */ }
    }
  };
  chip("Files", () => state.attachmentsOnly, () => { state.attachmentsOnly = !state.attachmentsOnly; }, "Only notes with attachments");
  chip("Imported", () => state.importedOnly, () => { state.importedOnly = !state.importedOnly; }, "Only notes brought in by an import");
  chip("[[links]]", () => state.internalOnly, () => { state.internalOnly = !state.internalOnly; }, "Only notes linking to other notes");
  chip("http", () => state.externalOnly, () => { state.externalOnly = !state.externalOnly; }, "Only notes containing an external link", fillExternalLinks);
  chip("Orphans", () => state.orphansOnly, () => { state.orphansOnly = !state.orphansOnly; }, "Only notes whose parent is missing — they exist on disk but no list shows them. Repair with the fix-orphans command.");
  chip("Broken links", () => state.brokenOnly, () => { state.brokenOnly = !state.brokenOnly; }, "Only notes with a [[wikilink]] pointing at a note/file that doesn't exist.");
  chip("Stale", () => state.staleOnly, () => { state.staleOnly = !state.staleOnly; }, "Only notes untouched for more than ~6 months (sort by Recent first to see the oldest at the bottom).");
  chip("Home notes", () => state.includeHome, () => { state.includeHome = !state.includeHome; }, "Include each folder's home note");

  // 0.276.6: multi-select + bulk actions.
  const selToggle = bar.createEl("button", { cls: "stashpad-index-chip" + (state.selectMode ? " is-active" : ""), text: state.selectMode ? "Done" : "Select" });
  selToggle.title = "Select multiple notes to act on them";
  // 0.295.2 (perf): select-mode only adds/removes the per-row checkbox, which
  // paintRows() draws from `state.selectMode` — no re-collect needed.
  selToggle.onclick = () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    selToggle.toggleClass("is-active", state.selectMode);
    selToggle.setText(state.selectMode ? "Done" : "Select");
    paintRows(); // also calls repaintBulk(), which shows/hides the bulk bar
  };

  const bulkBar = host.createDiv({ cls: "stashpad-index-bulkbar" });
  const countEl = host.createDiv({ cls: "stashpad-index-count" });
  const listEl = host.createDiv({ cls: "stashpad-index-list" });

  const selectedRows = (): IndexRow[] => rows.filter((r) => state.selected.has(r.file.path));
  const applyToSelected = async (fn: (r: IndexRow) => Promise<void>, label: string): Promise<void> => {
    const targets = selectedRows();
    let ok = 0, failed = 0;
    for (const r of targets) { try { await fn(r); ok++; } catch (e) { failed++; console.warn(`[Stashpad] bulk ${label} failed`, r.file.path, e); } }
    new Notice(`${label}: ${ok} done${failed ? `, ${failed} failed` : ""}.`);
    // 0.295.2 (perf): a bulk action MUTATED notes — this is the one in-view
    // path that must re-collect rather than repaint the cache.
    recollect();
  };
  const repaintBulk = (): void => {
    bulkBar.empty();
    if (!state.selectMode) { bulkBar.toggleClass("is-active", false); return; }
    bulkBar.toggleClass("is-active", true);
    const n = state.selected.size;
    bulkBar.createSpan({ cls: "stashpad-index-bulkcount", text: n === 0 ? "Select notes…" : `${n} selected` });
    const shown = rows.filter(matches);
    const allSel = shown.length > 0 && shown.every((r) => state.selected.has(r.file.path));
    const selAll = bulkBar.createEl("button", { cls: "stashpad-index-bulkbtn", text: allSel ? "Clear" : "Select all" });
    selAll.onclick = () => { if (allSel) state.selected.clear(); else for (const r of shown) state.selected.add(r.file.path); paintRows(); };
    if (n === 0) return;
    const act = (text: string, icon: string, run: () => void, warn = false): void => {
      const b = bulkBar.createEl("button", { cls: "stashpad-index-bulkbtn" + (warn ? " mod-warning" : "") });
      setIcon(b.createSpan({ cls: "stashpad-index-bulkic" }), icon);
      b.createSpan({ text });
      b.onclick = run;
    };
    act("Open", "external-link", () => { for (const r of selectedRows()) opts.onOpen(r.folder, r.id); });
    act("Complete", "check", () => void applyToSelected((r) => app.fileManager.processFrontMatter(r.file, (m) => writeCompletedFm(m as Record<string, unknown>, true)), "Complete"));
    act("Reopen", "rotate-ccw", () => void applyToSelected((r) => app.fileManager.processFrontMatter(r.file, (m) => writeCompletedFm(m as Record<string, unknown>, false)), "Reopen"));
    act("Copy links", "copy", () => {
      const md = selectedRows().map((r) => `[[${r.file.path.replace(/\.md$/, "")}|${r.title}]]`).join("\n");
      void navigator.clipboard.writeText(md); new Notice(`Copied ${state.selected.size} link${state.selected.size === 1 ? "" : "s"}.`);
    });
    act("Delete", "trash-2", () => {
      const targets = selectedRows();
      new ConfirmModal(app, `Delete ${targets.length} note${targets.length === 1 ? "" : "s"}?`,
        `This moves the selected note file${targets.length === 1 ? "" : "s"} to trash. Child notes are NOT moved (they'd be orphaned) — delete a whole subtree from its folder view instead. Attachments are left in place.`,
        "Delete to trash",
        (confirmed: boolean) => { if (!confirmed) return; void applyToSelected(async (r) => { await app.fileManager.trashFile(r.file); state.selected.delete(r.file.path); }, "Delete"); },
        "Cancel",
      ).open();
    }, true);
  };

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
    if (state.brokenOnly && !r.hasBrokenLinks) return false;
    if (state.staleOnly && !(r.modified > 0 && Date.now() - r.modified > STALE_MS)) return false;
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
   *  input keeps focus. 0.295.2 (perf): facet changes rebuild the bar too, but
   *  both paths now run over the same CACHED rows — no vault sweep either way. */
  const paintRows = (): void => {
    const shown = rows.filter(matches).sort(cmp);
    countEl.setText(`${shown.length} of ${rows.length} note${rows.length === 1 ? "" : "s"}`);
    listEl.empty();
    for (const r of shown) {
      const row = listEl.createDiv({ cls: "stashpad-index-row" + (state.selectMode && state.selected.has(r.file.path) ? " is-selected" : "") });
      const blurred = r.obscured && !state.revealed.has(r.file.path);
      if (state.selectMode) {
        const cb = row.createEl("input", { type: "checkbox", cls: "stashpad-index-check" });
        cb.checked = state.selected.has(r.file.path);
        cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) state.selected.add(r.file.path); else state.selected.delete(r.file.path); paintRows(); };
      }
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
      // 0.296.0 (perf): `undefined` = not computed (the "http" chip was never
      // on, so no body was read). The globe is omitted rather than guessed;
      // turning the chip on fills the flag and the icons appear.
      if (r.hasExternalLinks === true) ic("globe", "Contains an external link");
      if (r.imported) ic("download", "Imported");
      if (r.orphan) ic("unlink", "Orphan: its parent id resolves nowhere in this folder, so no list shows it. The fix-orphans command re-homes it.");
      if (r.hasBrokenLinks) ic("link-2-off", "Has a broken link — a [[wikilink]] pointing at something that doesn't exist.");
      if (r.obscured) ic("eye-off", blurred ? "Obscured — tap the row to reveal its title here" : "Obscured (revealed in this view)");

      row.onclick = () => {
        // In select mode a row click toggles selection instead of opening.
        if (state.selectMode) {
          if (state.selected.has(r.file.path)) state.selected.delete(r.file.path); else state.selected.add(r.file.path);
          paintRows(); return;
        }
        // Same contract as a list row: the first tap on an obscured row only
        // reveals; opening takes a second, deliberate tap.
        if (blurred) { state.revealed.add(r.file.path); paintRows(); return; }
        opts.onOpen(r.folder, r.id);
      };
    }
    repaintBulk();
  };
  paintRows();
}
