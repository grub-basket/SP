import { Component, ItemView, Keymap, MarkdownRenderer, Platform, Scope, TFile, WorkspaceLeaf, loadPdfJs, moment, setIcon, type ViewStateResult } from "obsidian";
import type StashpadPlugin from "./main";
import type { StashpadView } from "./view";
import { ROOT_ID, STASHPAD_SHOWCASE_VIEW_TYPE, attachmentLinkPath, parseAuthorRef, type StashpadId, type TreeNode } from "./types";
import { anyStashpadLeafOnFolder, stashpadLeafOnFolderIncludingDeferred } from "./leaf-lookup";
import { MediaViewerModal, mediaItemsFor } from "./media-viewer";
import { isImageExt } from "./file-kinds";
import { myReactionId, openReactionPicker, readReactions, toggleReaction, type ReactionMap } from "./reactions";
import { returnToOriginOnClose } from "./leaf-return";
import { settleNewTab } from "./view-helpers";
import { notify } from "./notify";
import { ShowcaseExportModal, buildShowcaseHtml, type ExportComment, type ExportSection } from "./showcase-export";

/** 0.530.0: SHOWCASE — one Stashpad level laid out as a single flat page for
 *  reviewing visual work (built for a brochure review between coworkers).
 *
 *  - Each child of the level is a SECTION, in the level's own order (the host
 *    view's tree, so manual order / sort mode / list pins all carry over).
 *  - A section's text renders as markdown; every attachment it embeds or links
 *    (images, PDFs, video, audio, other files) renders LARGE inline. Several
 *    attachments are presented as lettered options (Option A, B, …) that can be
 *    stacked or compared side by side, each with its own quick reactions so a
 *    team can pick between a designer's proposals.
 *  - FEEDBACK is not a separate storage feature: it is the section's ordinary
 *    child notes, drawn as a comment column. A comment posted from the Showcase
 *    is created through the normal note-creation path as an open task ("[ ]"),
 *    so "resolve" is the existing complete checkbox. It carries `feedback: true`,
 *    plus `feedbackOn: "[[file]]"` when it is about one attachment and
 *    `feedbackPin: "x,y"` when pinned to a spot on that image — all written in
 *    the same create. The normal list shows the target as a chip that opens the
 *    file. Replies to a comment are its children.
 *  - Per-attachment reactions live on the SECTION note as a FLAT list,
 *    `attachmentReactions: ["👍:<authorId>:<vault path>", …]` — flat on purpose
 *    (a nested map shows as an "unsupported type" in Obsidian's Properties, the
 *    reason `reactions` itself went flat). Section-level reactions are the
 *    note's normal `reactions`, so they show in the list too.
 *
 *  The view is read-mostly and borrows a live Stashpad view on the same folder
 *  (the "host") for its tree and for every write — note creation, reactions,
 *  completion and undo all go through the same code the list uses. Without an
 *  open host it shows a button to open the folder. */

type Layout = "stack" | "compare";
interface ShowcaseState { folder?: string | null; focusId?: string | null; layout?: Layout; hideResolved?: boolean }

/** The quick reactions offered on every section and option: approve / reject. */
export const SHOWCASE_REACTIONS: readonly string[] = ["👍", "👎", "✅", "❌"];

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]);

/** `![[x]]` or `[[x]]` (optional `|alias`). Group 1 = "!" when embedded, group 2 = link text. */
const LINK_RE = /(!?)\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;

/** obsidian's `moment` export is typed as a namespace; call it through this. */
const mo = moment as unknown as (x: string) => { isValid: () => boolean; fromNow: () => string; format: (f: string) => string };

/** Sections rendered at once; "Show more" adds this many. Every section is a
 *  disk read plus big media, and nothing here is virtualised. */
const SECTION_PAGE = 30;
/** PDFs above this open in Obsidian's own viewer instead of being read whole
 *  into memory for the iframe. */
const PDF_INLINE_LIMIT = 60 * 1024 * 1024;
/** 0.532.2: PDFs up to this many pages are drawn page by page with Obsidian's
 *  pdf.js, so each page can carry pins; longer ones keep the browser viewer. */
const PDF_PAGE_RENDER_MAX = 60;
/** Widest canvas a page is drawn at (CSS width × devicePixelRatio, capped). */
const PDF_PAGE_MAX_PX = 2400;

interface PdfJsRenderTask { promise: Promise<void>; cancel?: () => void }
interface PdfJsTextContent { items: Array<{ str?: string; hasEOL?: boolean }> }
interface PdfJsPage { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): PdfJsRenderTask; getTextContent(): Promise<PdfJsTextContent>; cleanup?: () => void }
/** pdf.js 4/5 text layer: transparent, selectable text positioned over a page. */
type PdfJsTextLayerCtor = new (o: { textContentSource: PdfJsTextContent; container: HTMLElement; viewport: unknown }) => { render(): Promise<void> };
interface PdfJsLib { getDocument(o: { data: Uint8Array }): { promise: Promise<PdfJsDoc> }; TextLayer?: PdfJsTextLayerCtor }
interface PdfJsDoc { numPages: number; getPage(n: number): Promise<PdfJsPage>; destroy?: () => Promise<void> }

interface Attachment { file: TFile; label: string; key: string }
interface SectionData { node: TreeNode; file: TFile; text: string; atts: Attachment[] }
interface Draft { text: string; target: string; replyTo: StashpadId | null; pin: string | null; posting: boolean }
interface SectionCache {
  root: HTMLElement;
  mainEl: HTMLElement;
  asideEl: HTMLElement;
  mainSig: string;
  asideSig: string;
  mainComp: Component;
  asideComp: Component;
  /** Hosts for the reaction bars, repainted on every pass (cheap, and frontmatter-
   *  only changes must not rebuild the media above them). key "" = section. */
  bars: Map<string, HTMLElement>;
  /** Hosts for pin overlays: an image's vault path, or "path#page" for a PDF
   *  page drawn by pdf.js (0.532.2). */
  pinHosts: Map<string, HTMLElement>;
}

/** Strip a leading YAML frontmatter block. */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? raw.slice(m[0].length) : raw;
}

function optionLabel(i: number): string {
  let s = ""; let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/** Parse `feedbackPin: "0.42,0.31"` (an image) or `"0.42,0.31,3"` (page 3 of
 *  a PDF, 0.532.2) → fractions in [0,1] (+ 1-based page), or null. */
export function parseFeedbackPin(raw: unknown): { x: number; y: number; page?: number } | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9]+)\s*)?$/);
  if (!m) return null;
  const x = Number(m[1]); const y = Number(m[2]);
  if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (m[3] === undefined) return { x, y };
  const page = Number(m[3]);
  return Number.isInteger(page) && page >= 1 ? { x, y, page } : null;
}

/** Lower-case for Find WITHOUT changing the string's length, so every index
 *  still maps back to the same character in the page text. A code point whose
 *  lower-case form is longer ("İ" → "i̇") folds to its base letter ("i") when
 *  that keeps the length, else stays as is. */
export function foldForFind(s: string): string {
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    // Final sigma: lowering per code point loses toLowerCase's context rule,
    // so treat ς and σ as the same letter (same length — indices hold).
    if (l.length === ch.length) { out += l === "\u03C2" ? "\u03C3" : l; continue; }
    // Longer lower-case = base letter + combining mark(s) (İ → i + U+0307):
    // keep just the base letter when it fits, so "istanbul" finds "İstanbul".
    const base = l.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    out += base.length === ch.length ? base : ch;
  }
  return out;
}

/** The pin-layer key for an image (its path) or one PDF page ("path#page"). */
function pinKey(path: string, page?: number): string {
  return page ? `${path}#${page}` : path;
}

/** Resolve a feedback note's `feedbackOn` target to a file. The value is
 *  written as `[[<full vault path>]]`, so try that path verbatim FIRST — a path
 *  with `#`, `^` or `|` in a folder name would be cut short by link parsing —
 *  then fall back to normal link resolution (hand-written or renamed links). */
export function resolveFeedbackTarget(app: ItemView["app"], fm: Record<string, unknown> | undefined, sourcePath: string): TFile | null {
  const raw = fm?.feedbackOn;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const inner = raw.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  const exact = app.vault.getAbstractFileByPath(inner);
  if (exact instanceof TFile) return exact;
  const f = app.metadataCache.getFirstLinkpathDest(attachmentLinkPath(raw), sourcePath);
  return f instanceof TFile ? f : null;
}

/** `attachmentReactions` entries are "<emoji>:<authorId>:<vault path>". Emoji
 *  and ids never contain ":"; the path is everything after the second one. */
export function readAttachmentReactions(fm: Record<string, unknown> | undefined, path: string): ReactionMap {
  const raw = fm?.attachmentReactions;
  const map: ReactionMap = {};
  if (!Array.isArray(raw)) return map;
  for (const e of raw) {
    if (typeof e !== "string") continue;
    const a = e.indexOf(":"); const b = a < 0 ? -1 : e.indexOf(":", a + 1);
    if (a <= 0 || b <= a + 1 || e.slice(b + 1) !== path) continue;
    const emoji = e.slice(0, a); const id = e.slice(a + 1, b);
    const ids = (map[emoji] ??= []);
    if (!ids.includes(id)) ids.push(id);
  }
  return map;
}

export class StashpadShowcaseView extends ItemView {
  private folder: string | null = null;
  private focusId: StashpadId = ROOT_ID;
  private layout: Layout = "stack";
  private hideResolved = false;

  private host: StashpadView | null = null;
  private unsubTree: (() => void) | null = null;
  private cache = new Map<string, SectionCache>();
  private drafts = new Map<string, Draft>();
  /** Section whose composer is waiting for a click on an image to place a pin. */
  private pinPicking: string | null = null;
  /** Obscured (blurred) sections the user revealed in this tab, by id. */
  private revealed = new Set<string>();
  private renderTimer: number | null = null;
  /** How many sections to render (grows with "Show more"). */
  private limit = SECTION_PAGE;
  /** Option-reaction toggles in flight ("<path>|<emoji>") — a fast double
   *  click must not read a stale cache and push a no-op + a second undo. */
  private pendingReacts = new Set<string>();
  /** An export is being built (one at a time — each holds the whole page in memory). */
  private exporting = false;
  private rendering = false;
  private renderAgain = false;
  private dirty = false;

  private barEl: HTMLElement | null = null;
  /** 0.532.5: Find bar (persistent — the toolbar is rebuilt every pass). */
  private findEl: HTMLElement | null = null;
  private findInput: HTMLInputElement | null = null;
  private findCount: HTMLElement | null = null;
  private findIdx = -1;
  private findMatches: Array<{ range: Range } | { page: HTMLElement }> = [];
  /** A queued Find run keeps the current match only if EVERY request asked to
   *  (a user's typing must not be swallowed by a render-triggered re-run). */
  private findKeepPending = true;
  /** pdf.js page text, fetched lazily (first Find open, or when the page's text
   *  layer is built) and shared by both. */
  private pdfTextSources = new Map<HTMLElement, () => Promise<PdfJsTextContent>>();
  /** PDFs not opened yet (still lazy): Find opens them all so their text exists. */
  private pdfBuilders = new Set<() => void>();
  /** Highlight names are global PER WINDOW: one owning Showcase tab per
   *  window, and each tab remembers which window it painted in. */
  private static findOwners = new WeakMap<Window, StashpadShowcaseView>();
  private findWin: Window | null = null;
  /** Whether the last run hit the match cap (shows "1000+"). */
  private findCapped = false;
  /** The previous current match was a whole-page stop (so when it turns into
   *  the exact words, scroll to them). */
  private findWasPageStop = false;
  private findTimer: number | null = null;
  /** Plain text of every pdf.js page box, for Find on pages not yet drawn. */
  private pdfText = new Map<HTMLElement, string>();
  private scrollEl: HTMLElement | null = null;
  private pageEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) {
    super(leaf);
    // Cmd/Ctrl+F finds within the page (Obsidian's own search doesn't look
    // inside a custom view — captions, comments and PDF text).
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => { this.openFind(); return false; });
  }

  getViewType(): string { return STASHPAD_SHOWCASE_VIEW_TYPE; }
  getDisplayText(): string {
    const t = this.levelTitle();
    return t ? `Showcase — ${t}` : "Showcase";
  }
  getIcon(): string { return "presentation"; }

  getState(): Record<string, unknown> {
    return { ...super.getState(), folder: this.folder, focusId: this.focusId, layout: this.layout, hideResolved: this.hideResolved };
  }
  async setState(state: ShowcaseState, result: ViewStateResult): Promise<void> {
    if (state) {
      const nextFolder = "folder" in state ? (state.folder ?? null) : this.folder;
      const nextFocus = (state.focusId as StashpadId | null | undefined) ?? this.focusId;
      if (nextFolder !== this.folder || nextFocus !== this.focusId) { this.resetSections(); this.limit = SECTION_PAGE; this.revealed.clear(); }
      this.folder = nextFolder ? nextFolder.replace(/\/+$/, "") : null;
      this.focusId = nextFocus || ROOT_ID;
      if (state.layout === "stack" || state.layout === "compare") this.layout = state.layout;
      if (typeof state.hideResolved === "boolean") this.hideResolved = state.hideResolved;
    }
    await super.setState(state, result);
    this.scheduleRender(0);
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-showcase");
    this.barEl = root.createDiv({ cls: "stashpad-showcase-bar" });
    this.buildFindBar(root.createDiv({ cls: "stashpad-showcase-find" }));
    this.scrollEl = root.createDiv({ cls: "stashpad-showcase-scroll" });
    this.emptyEl = this.scrollEl.createDiv({ cls: "stashpad-showcase-empty" });
    this.pageEl = this.scrollEl.createDiv({ cls: "stashpad-showcase-page" });

    // Live updates: the host tree tells us about structure (create / delete /
    // move / reorder); the metadata cache tells us about edits (body text,
    // reactions, completion) to any note in the folder.
    const inFolder = (p: string): boolean => !!this.folder && p.startsWith(this.folder + "/");
    this.registerEvent(this.app.metadataCache.on("changed", (f) => { if (inFolder(f.path)) this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (inFolder(f.path)) this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("rename", (f, old) => { if (inFolder(f.path) || inFolder(old)) this.scheduleRender(); }));
    // A Stashpad view opening / closing / switching folder changes the host.
    // layout-change fires on ANY pane change, so only act when the host we hold
    // is gone or no longer on our folder (or we have none yet).
    this.registerEvent(this.app.workspace.on("layout-change", () => { if (this.hostStale()) this.scheduleRender(); }));
    // No timer poll: everything drawn here comes from Obsidian's vault index,
    // so a coworker's change on a network drive appears when Obsidian notices
    // the file — the same moment the list itself updates. A poll would only
    // redraw identical data (and steal keyboard focus doing it).
    // Background tabs only mark themselves dirty; catch up when shown.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf && this.dirty) this.scheduleRender(0);
      // Highlights are per window: repaint ours when this tab comes back.
      if (leaf === this.leaf && this.findEl?.hasClass("is-open")) this.paintFind(false);
    }));
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.pinPicking) { this.setPinPicking(null); }
    });
    this.scheduleRender(0);
  }

  async onClose(): Promise<void> {
    if (this.findTimer !== null) { window.clearTimeout(this.findTimer); this.findTimer = null; }
    this.clearFindHighlights();
    if (this.renderTimer !== null) { window.clearTimeout(this.renderTimer); this.renderTimer = null; }
    this.unsubTree?.(); this.unsubTree = null;
    this.resetSections();
    this.contentEl.empty();
  }

  // ---------------------------------------------------------------- host

  /** The live Stashpad view on this folder, loading a deferred leaf if needed. */
  private async resolveHost(): Promise<StashpadView | null> {
    if (!this.folder) return null;
    const leaf = stashpadLeafOnFolderIncludingDeferred(this.app, this.folder, this.plugin.settings.folder || "Stashpad");
    if (!leaf) return null;
    const lazy = leaf as unknown as { isDeferred?: boolean; loadIfDeferred?: () => Promise<void> };
    if (lazy.isDeferred && lazy.loadIfDeferred) await lazy.loadIfDeferred();
    const v = leaf.view as unknown as StashpadView;
    return v && v.tree && typeof v.createNoteUnder === "function" ? v : null;
  }

  private bindHost(v: StashpadView | null): void {
    if (v === this.host) return;
    this.unsubTree?.(); this.unsubTree = null;
    this.host = v;
    if (v) this.unsubTree = v.tree.onChange(() => this.scheduleRender());
  }

  private hostStale(): boolean {
    const h = this.host;
    if (!h) return true;
    if ((h.noteFolder ?? "").replace(/\/+$/, "") !== this.folder) return true;
    let alive = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l.view === (h as unknown)) alive = true; });
    return !alive;
  }

  /** Called by the plugin when obscuring changes ("Cover everything", the
   *  schedule, a folder default): forget this tab's reveals and redraw. */
  reHide(): void {
    // Veil state is part of both signatures, so only sections whose veil
    // actually flips rebuild — not every PDF on the page.
    this.revealed.clear();
    this.scheduleRender(0);
  }

  private veiled(n: TreeNode): boolean {
    return !!this.host?.isObscured(n) && !this.revealed.has(n.id);
  }

  private levelTitle(): string {
    const h = this.host;
    if (this.focusId === ROOT_ID || !h) return this.folder ? (this.folder.split("/").pop() || this.folder) : "";
    const n = h.tree.get(this.focusId);
    return n ? (h.titleForNode(n).trim() || "Untitled") : (this.folder?.split("/").pop() ?? "");
  }

  // ---------------------------------------------------------------- render loop

  private scheduleRender(delay = 200): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (!this.containerEl.isShown()) { this.dirty = true; return; }
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    if (this.rendering) { this.renderAgain = true; return; }
    this.rendering = true;
    try {
      do {
        this.renderAgain = false;
        this.dirty = false;
        await this.renderOnce();
      } while (this.renderAgain);
    } catch (e) {
      console.error("Stashpad showcase: render failed", e);
    } finally {
      this.rendering = false;
    }
  }

  private async renderOnce(): Promise<void> {
    if (!this.pageEl || !this.emptyEl || !this.barEl) return;
    const host = await this.resolveHost();
    this.bindHost(host);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();

    if (!host) {
      this.renderBar([], 0);
      this.resetSections();
      this.emptyEl.empty();
      this.emptyEl.show();
      if (!this.folder) { this.emptyEl.setText("No folder selected. Open this view from a level in the list."); return; }
      this.emptyEl.createDiv({ text: `Showcase needs the "${this.folder.split("/").pop()}" Stashpad open in a tab to read and write its notes.` });
      const btn = this.emptyEl.createEl("button", { cls: "mod-cta", text: "Open it" });
      btn.onclick = () => { if (this.folder) void this.plugin.revealNoteByRef(this.folder, this.focusId); };
      return;
    }

    const nodes = host.tree.getChildren(this.focusId).filter((n) => n.file);
    const sections: SectionData[] = [];
    for (const node of nodes.slice(0, this.limit)) sections.push(await this.readSection(node));

    let open = 0;
    for (const n of nodes) for (const c of host.tree.getChildren(n.id)) if (this.isOpenTask(c)) open++;
    this.renderBar(sections, open, nodes.length);

    this.emptyEl.toggle(sections.length === 0);
    if (!sections.length) this.emptyEl.setText("Nothing at this level yet. Add notes with images or files in the list, and they show up here as pages.");

    // Keyed reconcile: reuse each section's DOM; rebuild only the half whose
    // inputs changed, so a new comment never reloads a PDF above it.
    const keep = new Set(sections.map((s) => s.node.id));
    for (const [id, c] of this.cache) if (!keep.has(id)) { this.disposeSection(c); this.cache.delete(id); }
    let prev: HTMLElement | null = null;
    sections.forEach((s, i) => {
      let c = this.cache.get(s.node.id);
      if (!c) {
        const root = createDiv({ cls: "stashpad-showcase-section" });
        root.dataset.id = s.node.id;
        const mainEl = root.createDiv({ cls: "stashpad-showcase-main" });
        const asideEl = root.createDiv({ cls: "stashpad-showcase-aside" });
        c = { root, mainEl, asideEl, mainSig: "", asideSig: "", mainComp: this.addChild(new Component()), asideComp: this.addChild(new Component()), bars: new Map(), pinHosts: new Map() };
        this.cache.set(s.node.id, c);
      }
      const want = prev ? prev.nextSibling : this.pageEl!.firstChild;
      if (want !== c.root) this.pageEl!.insertBefore(c.root, want);
      prev = c.root;

      // The section number is NOT part of the key: a page added near the top
      // renumbers everything below in place instead of rebuilding (and
      // re-reading every PDF) under it.
      const veiled = this.veiled(s.node);
      const mainSig = `${veiled}\u0000${s.text}\u0000${s.atts.map((a) => a.file.path + "@" + a.file.stat.mtime).join("|")}`;
      if (mainSig !== c.mainSig) { this.renderMain(c, s, i); c.mainSig = mainSig; }
      const num = c.mainEl.querySelector(".stashpad-showcase-sec-num");
      if (num && num.textContent !== String(i + 1)) num.textContent = String(i + 1);
      this.renderBars(c, s);
      const comments = host.tree.getChildren(s.node.id).filter((n) => n.file);
      const draft = this.drafts.get(s.node.id);
      const asideSig = this.asideSignature(comments, host) + `\u0000${this.hideResolved}\u0000${veiled}\u0000${draft?.posting ?? false}\u0000${s.atts.map((a) => a.file.path).join("|")}`;
      if (asideSig !== c.asideSig) { this.renderAside(c, s, comments); c.asideSig = asideSig; }
      this.renderPins(c, s, comments);
    });
    this.scheduleFind(true);
    this.pageEl.querySelector(".stashpad-showcase-more")?.remove();
    if (nodes.length > sections.length) {
      const more = this.pageEl.createDiv({ cls: "stashpad-showcase-more" });
      const left = nodes.length - sections.length;
      const b = more.createEl("button", { text: `Show ${Math.min(SECTION_PAGE, left)} more (${left} not shown)` });
      b.onclick = () => { this.limit += SECTION_PAGE; this.scheduleRender(0); };
    }
  }

  private asideSignature(comments: TreeNode[], host: StashpadView): string {
    const parts: string[] = [];
    const walk = (ns: TreeNode[], depth: number): void => {
      for (const n of ns) {
        // Everything the aside reads from the metadata cache is in the key, not
        // just mtime: a just-posted note is in the tree before the cache has
        // parsed it, and its "changed" event arrives with the same mtime — keyed
        // on mtime alone, the comment stayed "Unknown" / unresolvable.
        const fm = this.fmOf(n.file);
        const meta = fm ? [fm.completed === true, fm.task === true, "completed" in fm, String(fm.author ?? ""), String(fm.feedbackOn ?? ""), String(fm.feedbackPin ?? ""), String(fm.created ?? "")].join("|") : "?";
        const who = parseAuthorRef(fm?.author);
        const rec = who ? this.plugin.authorRegistry.get(who.id) : null;
        parts.push(`${depth}:${n.id}:${n.file?.stat.mtime ?? 0}:${this.veiled(n) ? 1 : 0}:${meta}:${rec?.name ?? ""}:${rec?.role ?? ""}`);
        if (depth < 3) walk(host.tree.getChildren(n.id).filter((k) => k.file), depth + 1);
      }
    };
    walk(comments, 0);
    return parts.join(",");
  }

  private resetSections(): void {
    for (const c of this.cache.values()) this.disposeSection(c);
    this.cache.clear();
    this.pageEl?.empty();
  }

  private disposeSection(c: SectionCache): void {
    this.removeChild(c.mainComp);
    this.removeChild(c.asideComp);
    c.root.remove();
  }

  // ---------------------------------------------------------------- data

  private async readSection(node: TreeNode): Promise<SectionData> {
    const file = node.file!;
    let body = "";
    try { body = stripFrontmatter(await this.app.vault.cachedRead(file)); } catch { /* unreadable → empty */ }
    const atts: Attachment[] = [];
    const seen = new Set<string>();
    const text = body.replace(LINK_RE, (whole, _bang: string, link: string) => {
      const dest = this.app.metadataCache.getFirstLinkpathDest(attachmentLinkPath(link), file.path);
      if (!(dest instanceof TFile) || dest.extension === "md") return whole; // note links/embeds stay in the text
      if (!seen.has(dest.path)) { seen.add(dest.path); atts.push({ file: dest, label: "", key: dest.path }); }
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    atts.forEach((a, i) => { a.label = atts.length > 1 ? `Option ${optionLabel(i)}` : ""; });
    return { node, file, text, atts };
  }

  private fmOf(file: TFile | null): Record<string, unknown> | undefined {
    return file ? (this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined) : undefined;
  }

  private isResolved(n: TreeNode): boolean { return this.fmOf(n.file)?.completed === true; }
  private isOpenTask(n: TreeNode): boolean {
    const fm = this.fmOf(n.file);
    if (!fm || fm.completed === true) return false;
    return fm.task === true || "completed" in fm;
  }

  /** `realName`: for exports, where "You" would mean the reader. */
  private authorLabel(fm: Record<string, unknown> | undefined, realName = false): { name: string; role: string } {
    const ref = parseAuthorRef(fm?.author);
    if (!ref) return { name: "Unknown", role: "" };
    const me = (this.plugin.settings.authorId ?? "").trim();
    const rec = this.plugin.authorRegistry.get(ref.id);
    const name = ref.id === me && !realName ? "You" : (rec?.name || ref.name);
    return { name, role: rec?.role ?? "" };
  }

  // ---------------------------------------------------------------- bar

  private renderBar(sections: SectionData[], open: number, total = sections.length): void {
    const bar = this.barEl!;
    bar.empty();
    const crumbs = bar.createDiv({ cls: "stashpad-showcase-crumbs" });
    const h = this.host;
    const chain: Array<{ id: StashpadId; title: string }> = [{ id: ROOT_ID, title: this.folder?.split("/").pop() || "Home" }];
    if (h && this.focusId !== ROOT_ID) {
      const path = h.tree.pathTo(this.focusId).filter((n) => n.id !== ROOT_ID);
      for (const n of path) chain.push({ id: n.id, title: h.titleForNode(n).trim().slice(0, 40) || "Untitled" });
    }
    chain.forEach((c, i) => {
      if (i) crumbs.createSpan({ cls: "stashpad-showcase-crumb-sep", text: "›" });
      const last = i === chain.length - 1;
      const el = crumbs.createSpan({ cls: "stashpad-showcase-crumb" + (last ? " is-current" : ""), text: c.title });
      if (!last) el.onclick = () => this.goTo(c.id);
    });

    const atts = sections.reduce((n, s) => n + s.atts.length, 0);
    const shownNote = total > sections.length ? ` (first ${sections.length} shown)` : "";
    bar.createSpan({ cls: "stashpad-showcase-count", text: `${total} section${total === 1 ? "" : "s"}${shownNote} · ${atts} file${atts === 1 ? "" : "s"}` });
    const openEl = bar.createSpan({ cls: "stashpad-showcase-open" + (open ? " has-open" : ""), text: open ? `${open} open feedback` : "No open feedback" });
    if (open) {
      openEl.setAttr("role", "button");
      openEl.title = "Jump to the next section with open feedback";
      openEl.onclick = () => this.jumpToNextOpen();
    }

    const spacer = bar.createDiv({ cls: "stashpad-showcase-spacer" });
    spacer.setAttr("aria-hidden", "true");

    const seg = bar.createDiv({ cls: "stashpad-showcase-seg", attr: { role: "group", "aria-label": "Layout of multiple files" } });
    for (const [val, label, icon] of [["stack", "Stack", "rows-3"], ["compare", "Side by side", "columns-2"]] as Array<[Layout, string, string]>) {
      const b = seg.createEl("button", { cls: "stashpad-showcase-segbtn" + (this.layout === val ? " is-active" : ""), attr: { "aria-pressed": String(this.layout === val), "aria-label": label } });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.onclick = () => { if (this.layout === val) return; this.layout = val; this.persist(); this.applyLayout(); this.renderBar(sections, open, total); };
    }

    const resolvedBtn = bar.createEl("button", { cls: "stashpad-showcase-btn" + (this.hideResolved ? " is-active" : ""), text: this.hideResolved ? "Show resolved" : "Hide resolved" });
    resolvedBtn.onclick = () => { this.hideResolved = !this.hideResolved; this.persist(); this.scheduleRender(0); };

    const findBtn = bar.createEl("button", { cls: "stashpad-showcase-btn clickable-icon", attr: { "aria-label": "Find in this page" } });
    setIcon(findBtn, "search");
    findBtn.onclick = () => this.openFind();

    const exportBtn = bar.createEl("button", { cls: "stashpad-showcase-btn", attr: { "aria-label": "Export this page as one web page file (no Obsidian needed)" } });
    setIcon(exportBtn.createSpan(), "download");
    exportBtn.createSpan({ text: "Export" });
    exportBtn.onclick = () => new ShowcaseExportModal(this.app, (o) => void this.runExport(o.includeFeedback)).open();

    const listBtn = bar.createEl("button", { cls: "stashpad-showcase-btn clickable-icon", attr: { "aria-label": "Show this level in the list" } });
    setIcon(listBtn, "list-tree");
    listBtn.onclick = () => { if (this.folder) void this.plugin.revealNoteByRef(this.folder, this.focusId); };

    const refresh = bar.createEl("button", { cls: "stashpad-showcase-btn clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => { this.resetSections(); this.scheduleRender(0); };
  }

  private applyLayout(): void {
    this.pageEl?.querySelectorAll<HTMLElement>(".stashpad-showcase-atts").forEach((el) => {
      el.toggleClass("is-compare", this.layout === "compare");
      el.toggleClass("is-stack", this.layout !== "compare");
    });
  }

  private goTo(id: StashpadId): void {
    this.focusId = id;
    this.limit = SECTION_PAGE;
    this.resetSections();
    this.persist();
    this.scheduleRender(0);
  }

  private persist(): void { this.app.workspace.requestSaveLayout(); }

  private jumpToNextOpen(): void {
    const els = Array.from(this.pageEl?.querySelectorAll<HTMLElement>(".stashpad-showcase-section.has-open") ?? []);
    if (!els.length || !this.scrollEl) return;
    const top = this.scrollEl.scrollTop;
    const next = els.find((el) => el.offsetTop > top + 8) ?? els[0];
    next.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------------------------------------------------------------- main column

  private renderMain(c: SectionCache, s: SectionData, index: number): void {
    this.removeChild(c.mainComp);
    c.mainComp = this.addChild(new Component());
    c.bars.clear();
    c.pinHosts.clear();
    const el = c.mainEl;
    el.empty();

    const head = el.createDiv({ cls: "stashpad-showcase-sec-head" });
    head.createSpan({ cls: "stashpad-showcase-sec-num", text: String(index + 1) });
    const tools = head.createDiv({ cls: "stashpad-showcase-sec-tools" });
    const reveal = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Show in the list" } });
    setIcon(reveal, "list-tree");
    reveal.onclick = () => { if (this.folder) void this.plugin.revealNoteByRef(this.folder, s.node.id); };
    if (s.atts.length) {
      const all = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open every file in the preview" } });
      setIcon(all, "maximize-2");
      all.onclick = () => this.openViewer(s, 0);
    }

    // Respect the list's "obscured" blur: a hidden note stays hidden here until
    // the user chooses to show it (this tab only; nothing is written).
    if (this.veiled(s.node)) {
      const veil = el.createDiv({ cls: "stashpad-showcase-veil" });
      setIcon(veil.createSpan(), "eye-off");
      veil.createSpan({ text: `Hidden note${s.atts.length ? ` · ${s.atts.length} file${s.atts.length === 1 ? "" : "s"}` : ""}` });
      const show = veil.createEl("button", { text: "Show" });
      show.onclick = () => { this.revealed.add(s.node.id); const c2 = this.cache.get(s.node.id); if (c2) c2.mainSig = ""; this.scheduleRender(0); };
      const foot = el.createDiv({ cls: "stashpad-showcase-sec-foot" });
      c.bars.set("", foot.createDiv({ cls: "stashpad-showcase-reactions" }));
      return;
    }

    if (s.text) {
      const cap = el.createDiv({ cls: "stashpad-showcase-caption markdown-rendered" });
      void MarkdownRenderer.render(this.app, s.text, cap, s.file.path, c.mainComp);
      this.wireLinks(cap, s.file.path);
    }

    if (s.atts.length) {
      const wrap = el.createDiv({ cls: "stashpad-showcase-atts " + (this.layout === "compare" ? "is-compare" : "is-stack") });
      if (s.atts.length === 1) wrap.addClass("is-single");
      s.atts.forEach((a, i) => this.renderAttachment(wrap, c, s, a, i));
    }

    // Section-level reactions (the note's own `reactions`, shown in the list too).
    const foot = el.createDiv({ cls: "stashpad-showcase-sec-foot" });
    c.bars.set("", foot.createDiv({ cls: "stashpad-showcase-reactions" }));
  }

  private renderAttachment(wrap: HTMLElement, c: SectionCache, s: SectionData, a: Attachment, i: number): void {
    const card = wrap.createDiv({ cls: "stashpad-showcase-att" });
    card.dataset.path = a.file.path;
    const head = card.createDiv({ cls: "stashpad-showcase-att-head" });
    if (a.label) head.createSpan({ cls: "stashpad-showcase-att-label", text: a.label });
    head.createSpan({ cls: "stashpad-showcase-att-name", text: a.file.name });
    const open = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `Open ${a.file.name} in the preview` } });
    setIcon(open, "maximize-2");
    open.onclick = () => this.openViewer(s, i);

    const media = card.createDiv({ cls: "stashpad-showcase-media" });
    const ext = a.file.extension.toLowerCase();
    if (isImageExt(ext)) {
      const box = media.createDiv({ cls: "stashpad-showcase-imgbox" });
      const img = box.createEl("img", { cls: "stashpad-showcase-img", attr: { alt: a.file.basename, loading: "lazy" } });
      img.src = this.app.vault.getResourcePath(a.file);
      img.onclick = (e) => {
        if (this.pinPicking === s.node.id) { this.placePin(s, a, img, e); return; }
        this.openViewer(s, i);
      };
      c.pinHosts.set(a.file.path, box.createDiv({ cls: "stashpad-showcase-pins" }));
    } else if (ext === "pdf") {
      this.renderPdfPages(media, c, s, a, i);
    } else if (VIDEO_EXT.has(ext)) {
      const v = media.createEl("video", { cls: "stashpad-showcase-video", attr: { controls: "", preload: "metadata" } });
      v.src = this.app.vault.getResourcePath(a.file);
    } else if (AUDIO_EXT.has(ext)) {
      const au = media.createEl("audio", { cls: "stashpad-showcase-audio", attr: { controls: "", preload: "metadata" } });
      au.src = this.app.vault.getResourcePath(a.file);
    } else {
      const fc = media.createDiv({ cls: "stashpad-showcase-filecard" });
      setIcon(fc.createSpan({ cls: "stashpad-showcase-filecard-icon" }), "file");
      fc.createSpan({ text: `${a.file.name} · ${Math.max(1, Math.round(a.file.stat.size / 1024))} KB` });
      const b = fc.createEl("button", { text: "Open" });
      b.onclick = () => this.openViewer(s, i);
    }

    // Per-option reactions only when there is a choice to make; a lone file is
    // covered by the section's own reactions below it.
    if (s.atts.length > 1) c.bars.set(a.key, card.createDiv({ cls: "stashpad-showcase-reactions is-option" }));
  }

  /** PDFs: the Chromium viewer in an iframe (every page, scrollable), loaded when
   *  near the viewport. The bytes are read through the vault adapter and shown
   *  from a blob: URL, not the app:// resource URL, which renders blank on some
   *  synced/network vaults. If the read fails, or on mobile (no iframe PDF
   *  viewer), fall back to Obsidian's own PDF embed. */
  private renderPdf(media: HTMLElement, file: TFile, comp: Component): void {
    const box = media.createDiv({ cls: "stashpad-showcase-pdf" });
    const viaObsidian = async (): Promise<void> => {
      box.empty();
      box.addClass("is-embed");
      await MarkdownRenderer.render(this.app, `![[${file.path}]]`, box, file.path, comp);
    };
    const load = async (): Promise<void> => {
      if (Platform.isMobile || file.stat.size > PDF_INLINE_LIMIT) { await viaObsidian(); return; }
      let bytes: ArrayBuffer | null = null;
      try { bytes = await this.app.vault.readBinary(file); } catch { bytes = null; }
      if (!box.isConnected) return;
      if (!bytes || !bytes.byteLength) { await viaObsidian(); return; }
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      comp.register(() => URL.revokeObjectURL(url));
      const frame = box.createEl("iframe", { cls: "stashpad-showcase-pdfframe", attr: { title: file.name } });
      // No thumbnail rail, fit to width: reads as pages, not as a PDF app.
      frame.src = `${url}#navpanes=0&view=FitH`;
    };
    if (typeof IntersectionObserver === "undefined") { void load(); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); void load(); }
    }, { root: this.scrollEl, rootMargin: "800px 0px" });
    io.observe(box);
    comp.register(() => io.disconnect());
  }

  /** 0.532.2: a PDF as its pages, each drawn by Obsidian's bundled pdf.js into a
   *  canvas when it nears the viewport, each with its own pin layer — so a
   *  comment can be pinned to a spot on page 3 exactly like on an image. Reads
   *  the file through the vault (never the app:// URL, which blanks on some
   *  network vaults). Over PDF_PAGE_RENDER_MAX pages, over PDF_INLINE_LIMIT
   *  bytes, or if pdf.js fails, it falls back to the browser/Obsidian viewer
   *  (renderPdf), without pins. */
  private renderPdfPages(media: HTMLElement, c: SectionCache, s: SectionData, a: Attachment, index: number): void {
    const comp = c.mainComp;
    const file = a.file;
    const wrap = media.createDiv({ cls: "stashpad-showcase-pdfpages" });
    // Back to the viewer (no pins). Drop any page pin layers already made so
    // "Pin a spot" isn't offered over a viewer that can't take the click.
    const fallback = (): void => {
      void doc?.destroy?.(); doc = null;
      wrap.remove();
      for (const k of [...c.pinHosts.keys()]) if (k.startsWith(file.path + "#")) c.pinHosts.delete(k);
      c.asideSig = "";
      this.renderPdf(media, file, comp);
      this.scheduleRender(0);
    };
    if (file.stat.size > PDF_INLINE_LIMIT) { fallback(); return; }
    let doc: PdfJsDoc | null = null;
    comp.register(() => { void doc?.destroy?.(); doc = null; });
    const build = async (): Promise<void> => {
      try {
        const bytes = await this.app.vault.readBinary(file);
        const pdfjs = await loadPdfJs() as PdfJsLib;
        const d = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
        if (!wrap.isConnected) { void d.destroy?.(); return; }
        doc = d;
        if (!d.numPages || d.numPages > PDF_PAGE_RENDER_MAX) { fallback(); return; }
        const pages: Array<{ n: number; box: HTMLElement; page: PdfJsPage; drawn: boolean; gen: number; task: PdfJsRenderTask | null; textLayer: boolean; text: Promise<PdfJsTextContent> | null }> = [];
        for (let n = 1; n <= d.numPages; n++) {
          const page = await d.getPage(n);
          if (!wrap.isConnected) return;
          const vp = page.getViewport({ scale: 1 });
          const box = wrap.createDiv({ cls: "stashpad-showcase-pdfpage" });
          box.style.aspectRatio = `${vp.width} / ${vp.height}`;
          box.dataset.page = String(n);
          box.setAttr("role", "img");
          box.setAttr("aria-label", `${file.basename}, page ${n} of ${d.numPages}`);
          box.createDiv({ cls: "stashpad-showcase-pdfpage-num", text: `${n} / ${d.numPages}` });
          c.pinHosts.set(pinKey(file.path, n), box.createDiv({ cls: "stashpad-showcase-pins" }));
          // pdf.js's text-layer CSS rounds its size with these (normally set by
          // its own viewer); 1px = no rounding, so the layer matches the box.
          box.setCssProps({ "--scale-round-x": "1px", "--scale-round-y": "1px" });
          box.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".stashpad-showcase-pin")) return;
            if (this.pinPicking === s.node.id) { this.placePin(s, a, box, e, n); return; }
            const win = box.win;
            const selectingText = (): boolean => {
              const sel = win.getSelection();
              return !!sel && !sel.isCollapsed && box.contains(sel.anchorNode);
            };
            // A drag that selected text isn't a click to open the preview.
            if (selectingText() || e.detail > 1) return;
            // On the text itself, wait out a possible double/triple click
            // (word/line selection) before treating it as "open".
            if ((e.target as HTMLElement).closest(".textLayer")) {
              win.setTimeout(() => { if (box.isConnected && !selectingText()) this.openViewer(s, index); }, 280);
              return;
            }
            this.openViewer(s, index);
          });
          pages.push({ n, box, page, drawn: false, gen: 0, task: null, textLayer: false, text: null });
        }
        // Page text, fetched once per page and only when needed: by the text
        // layer when the page draws, or for every page when Find opens (so a
        // match on a page that isn't drawn yet can be jumped to). Joined the
        // same way the text layer lays it out (item text, a space per line
        // end), so a match found here still matches once the page draws.
        const textOf = (p: typeof pages[number]): Promise<PdfJsTextContent> => {
          if (!p.text) {
            p.text = p.page.getTextContent();
            void p.text.then((tc) => {
              if (!p.box.isConnected) return;
              // Exactly the DOM side's rule (blockText): item text, plus one space
              // at a line end unless the text already ends in one.
              let t = "";
              for (const it of tc.items) { t += it.str ?? ""; if (it.hasEOL && t && !t.endsWith(" ")) t += " "; }
              this.pdfText.set(p.box, t);
              this.scheduleFind(true);
            }).catch(() => { p.text = null; /* retry next time it's asked for */ });
          }
          return p.text;
        };
        for (const p of pages) this.pdfTextSources.set(p.box, () => textOf(p));
        if (this.findEl?.hasClass("is-open")) for (const p of pages) void textOf(p).catch(() => undefined);
        comp.register(() => { for (const p of pages) { this.pdfText.delete(p.box); this.pdfTextSources.delete(p.box); } });
        // The text layer scales with the page box via --total-scale-factor
        // (pdf.js 5 sizes it as calc(var(--total-scale-factor) * <page pt>)).
        const setScale = (): void => {
          for (const p of pages) {
            const w = p.box.clientWidth; const base = p.page.getViewport({ scale: 1 }).width;
            if (w && base) p.box.setCssProps({ "--total-scale-factor": String(w / base) });
          }
        };
        setScale();
        if (typeof ResizeObserver !== "undefined") {
          const ro = new ResizeObserver(() => setScale());
          ro.observe(wrap);
          comp.register(() => ro.disconnect());
        }
        /** Selectable text over the page (built once, kept when the canvas is
         *  released so Find highlights survive scrolling). */
        const buildText = async (p: typeof pages[number]): Promise<void> => {
          if (p.textLayer || !pdfjs.TextLayer) return;
          p.textLayer = true;
          let layer: HTMLElement | null = null;
          try {
            const tc = await textOf(p);
            if (!p.box.isConnected) return;
            layer = p.box.createDiv({ cls: "textLayer stashpad-showcase-textlayer" });
            await new pdfjs.TextLayer({ textContentSource: tc, container: layer, viewport: p.page.getViewport({ scale: 1 }) }).render();
            this.scheduleFind(true);
          } catch {
            layer?.remove(); // never leave an empty layer for Find to read
            p.textLayer = false;
          }
        };
        // Canvases are big (a page at 2× is ~10 MB), so only pages near the
        // viewport keep one: leaving the margin releases it, coming back redraws.
        // Mobile gets a smaller cap — WebKit has a total canvas-memory limit and
        // returns no context past it.
        const maxPx = Platform.isMobile ? 1400 : PDF_PAGE_MAX_PX;
        const release = (p: typeof pages[number]): void => {
          p.gen++;
          p.drawn = false;
          p.task?.cancel?.(); // stop rasterising a page that scrolled away
          p.task = null;
          const cv = p.box.querySelector("canvas");
          if (cv) { cv.width = 0; cv.height = 0; cv.remove(); }
        };
        const draw = async (p: typeof pages[number]): Promise<void> => {
          if (p.drawn || !p.box.isConnected) return;
          p.drawn = true;
          const gen = ++p.gen;
          const cssW = Math.max(1, p.box.clientWidth);
          const base = p.page.getViewport({ scale: 1 });
          const dpr = activeWindow.devicePixelRatio || 1;
          const scale = Math.min(maxPx, cssW * dpr) / base.width;
          const viewport = p.page.getViewport({ scale });
          const canvas = p.box.createEl("canvas", { cls: "stashpad-showcase-pdfcanvas" });
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          p.box.prepend(canvas);
          const ctx = canvas.getContext("2d");
          if (!ctx) { release(p); return; } // out of canvas memory: retry on next entry
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
          void buildText(p);
          try {
            p.task = p.page.render({ canvasContext: ctx, viewport });
            await p.task.promise;
          } catch { /* cancelled, destroyed mid-render, or a bad page: leave it white */ }
          finally {
            if (gen === p.gen) p.task = null;
            try { p.page.cleanup?.(); } catch { /* still rendering elsewhere — pdf.js refuses, fine */ }
          }
        };
        if (typeof IntersectionObserver === "undefined") { for (const p of pages) void draw(p); }
        else {
          // Hysteresis: draw within 600 px of the viewport, release only past
          // 1800 px — a page sitting on one shared edge re-rendered on every
          // small back-and-forth scroll.
          const drawIo = new IntersectionObserver((entries) => {
            for (const en of entries) {
              const p = pages.find((x) => x.box === en.target);
              if (p && en.isIntersecting) void draw(p);
            }
          }, { root: this.scrollEl, rootMargin: "600px 0px" });
          const releaseIo = new IntersectionObserver((entries) => {
            for (const en of entries) {
              const p = pages.find((x) => x.box === en.target);
              if (p && !en.isIntersecting && p.drawn) release(p);
            }
          }, { root: this.scrollEl, rootMargin: "1800px 0px" });
          for (const p of pages) { drawIo.observe(p.box); releaseIo.observe(p.box); }
          comp.register(() => { drawIo.disconnect(); releaseIo.disconnect(); });
        }
        wrap.removeClass("is-loading");
        // Pages (and their pin layers) exist now: paint existing pins and let
        // the composer offer "Pin a spot" for this PDF.
        c.asideSig = "";
        this.scheduleRender(0);
      } catch (e) {
        if (!wrap.isConnected) return; // section rebuilt / view closed — not a failure
        console.warn("Stashpad showcase: pdf.js couldn't draw this PDF; using the viewer", file.path, e);
        fallback();
      }
    };
    if (typeof IntersectionObserver === "undefined") { void build(); return; }
    let started = false;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) start();
    }, { root: this.scrollEl, rootMargin: "1200px 0px" });
    // Open the PDF (pages + text, not drawing) — when it nears the viewport,
    // or as soon as Find opens, so a PDF further down the page is searchable.
    const start = (): void => {
      if (started) return;
      started = true;
      io.disconnect();
      this.pdfBuilders.delete(start);
      void build();
    };
    this.pdfBuilders.add(start);
    if (this.findEl?.hasClass("is-open")) start();
    // A sized placeholder so the observer has something to see before pages exist.
    wrap.addClass("is-loading");
    io.observe(wrap);
    comp.register(() => { io.disconnect(); this.pdfBuilders.delete(start); });
  }

  /** True when this file can take pins: an image, or a PDF drawn as pages. */
  private pinnable(c: SectionCache, a: Attachment): boolean {
    if (isImageExt(a.file.extension.toLowerCase())) return true;
    for (const k of c.pinHosts.keys()) if (k.startsWith(a.file.path + "#")) return true;
    return false;
  }

  private openViewer(s: SectionData, index: number): void {
    const items = mediaItemsFor(this.app, s.atts.map((a) => a.file.path));
    new MediaViewerModal(this.app, items, index, (file) => { void this.app.workspace.openLinkText(file.path, "", "tab"); }).open();
  }

  /** Internal links inside rendered markdown don't navigate on their own in a
   *  custom view; route them through the workspace. */
  private wireLinks(el: HTMLElement, sourcePath: string): void {
    el.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a.internal-link");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      if (href) void this.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(e));
    });
  }

  // ---------------------------------------------------------------- reactions

  private renderBars(c: SectionCache, s: SectionData): void {
    const fm = this.fmOf(s.file);
    for (const [key, host] of c.bars) {
      const map = key === "" ? readReactions(fm) : this.attachmentReactions(fm, key);
      // Rebuild only when the reactions changed, so an unrelated edit in the
      // folder doesn't knock keyboard focus off a reaction button.
      const sig = JSON.stringify(map);
      if (host.dataset.sig === sig && host.childElementCount) continue;
      host.dataset.sig = sig;
      this.renderReactionBar(host, map, key, s);
    }
  }

  private attachmentReactions(fm: Record<string, unknown> | undefined, key: string): ReactionMap {
    return readAttachmentReactions(fm, key);
  }

  private renderReactionBar(host: HTMLElement, map: ReactionMap, key: string, s: SectionData): void {
    host.empty();
    const view = this.host;
    if (!view) return;
    const me = myReactionId(view);
    const emojis = [...SHOWCASE_REACTIONS, ...Object.keys(map).filter((e) => !SHOWCASE_REACTIONS.includes(e))];
    for (const emoji of emojis) {
      const ids = map[emoji] ?? [];
      const mine = ids.includes(me);
      const b = host.createEl("button", { cls: "stashpad-showcase-react" + (mine ? " is-mine" : "") + (ids.length ? " has-count" : "") });
      b.createSpan({ cls: "stashpad-showcase-react-emoji", text: emoji });
      if (ids.length) b.createSpan({ cls: "stashpad-showcase-react-count", text: String(ids.length) });
      const who = ids.map((id) => view.reactionAuthorName(id)).join(", ");
      b.title = ids.length ? `${emoji} ${who}` : `React ${emoji}`;
      b.setAttr("aria-label", ids.length ? `${emoji} ${ids.length}: ${who}` : `React ${emoji}`);
      b.setAttr("aria-pressed", String(mine));
      b.onclick = () => {
        if (key === "") void toggleReaction(view, s.node, emoji).then(() => this.scheduleRender(50));
        else void this.toggleAttachmentReaction(view, s, key, emoji);
      };
    }
    if (key === "") {
      const more = host.createEl("button", { cls: "stashpad-showcase-react is-more", attr: { "aria-label": "More reactions" } });
      setIcon(more, "smile-plus");
      more.onclick = () => openReactionPicker(view, s.node, more);
    }
  }

  /** Toggle the current user's `emoji` on one attachment of a section. Undoable
   *  through the folder's normal undo stack; the toggle is its own inverse. */
  private async toggleAttachmentReaction(view: StashpadView, s: SectionData, key: string, emoji: string): Promise<void> {
    const me = myReactionId(view);
    // 0.532.5: hold the FILES, not their paths. A TFile keeps its identity
    // (and updates its .path) through renames, so undo/redo after the image
    // was renamed — or after the section note's slug changed — still hits the
    // right note and the right entry; with captured paths it silently did
    // nothing.
    const noteFile = s.file;
    const attAbs = this.app.vault.getAbstractFileByPath(key);
    const attFile = attAbs instanceof TFile ? attAbs : null;
    const write = async (add: boolean): Promise<void> => {
      if (this.app.vault.getAbstractFileByPath(noteFile.path) !== noteFile) return; // note deleted
      const attPath = attFile && this.app.vault.getAbstractFileByPath(attFile.path) === attFile ? attFile.path : key;
      view.markFmSelfWrite(noteFile.path, true);
      await this.app.fileManager.processFrontMatter(noteFile, (fm: Record<string, unknown>) => {
        // Read-modify-write of ONE entry: other people's entries (and other
        // files' entries) pass through untouched, so a coworker's concurrent
        // reaction survives unless both writes land on the same instant.
        const list = Array.isArray(fm.attachmentReactions) ? (fm.attachmentReactions as unknown[]).filter((e): e is string => typeof e === "string") : [];
        const entry = `${emoji}:${me}:${attPath}`;
        const next = list.filter((e) => e !== entry);
        if (add) next.push(entry);
        if (next.length) fm.attachmentReactions = next; else delete fm.attachmentReactions;
      });
    };
    const pendingKey = `${key}|${emoji}`;
    if (this.pendingReacts.has(pendingKey)) return;
    this.pendingReacts.add(pendingKey);
    const had = (this.attachmentReactions(this.fmOf(s.file), key)[emoji] ?? []).includes(me);
    try { await write(!had); } catch (e) { this.pendingReacts.delete(pendingKey); notify(`Stashpad: couldn't save the reaction (${(e as Error).message})`); return; }
    // Hold the key until the cache has caught up (next render reads it fresh).
    window.setTimeout(() => this.pendingReacts.delete(pendingKey), 600);
    this.scheduleRender(50);
    const name = attFile?.name ?? key.split("/").pop() ?? key;
    view.plugin.getUndoStack(view.noteFolder).push({
      label: had ? `Remove ${emoji} on ${name}` : `React ${emoji} on ${name}`,
      undo: async () => { await write(had); this.scheduleRender(50); },
      redo: async () => { await write(!had); this.scheduleRender(50); },
    });
  }

  // ---------------------------------------------------------------- feedback column

  private renderAside(c: SectionCache, s: SectionData, comments: TreeNode[]): void {
    const host = this.host;
    if (!host) return;
    // Keep focus + caret in the composer across a rebuild (a coworker's comment
    // can land while you're typing).
    const active = activeDocument.activeElement;
    const hadFocus = active instanceof HTMLTextAreaElement && c.asideEl.contains(active);
    const sel = hadFocus ? [active.selectionStart, active.selectionEnd] : null;

    this.removeChild(c.asideComp);
    c.asideComp = this.addChild(new Component());
    const el = c.asideEl;
    el.empty();

    const open = comments.filter((n) => this.isOpenTask(n)).length;
    c.root.toggleClass("has-open", open > 0);
    if (this.veiled(s.node)) {
      // The feedback is about hidden content — keep it hidden too.
      const head = el.createDiv({ cls: "stashpad-showcase-aside-head" });
      setIcon(head.createSpan({ cls: "stashpad-showcase-aside-icon" }), "eye-off");
      head.createSpan({ text: comments.length ? `Feedback hidden (${comments.length})` : "Feedback" });
      return;
    }
    const head = el.createDiv({ cls: "stashpad-showcase-aside-head" });
    setIcon(head.createSpan({ cls: "stashpad-showcase-aside-icon" }), "message-square");
    head.createSpan({ text: "Feedback" });
    if (comments.length) head.createSpan({ cls: "stashpad-showcase-aside-count", text: open ? `${open} open · ${comments.length}` : String(comments.length) });

    const list = el.createDiv({ cls: "stashpad-showcase-comments" });
    let hidden = 0;
    comments.forEach((n, i) => {
      if (this.hideResolved && this.isResolved(n)) { hidden++; return; }
      this.renderComment(list, c, s, n, 0, i + 1);
    });
    if (hidden) list.createDiv({ cls: "stashpad-showcase-hidden-note", text: `${hidden} resolved hidden` });
    if (!comments.length) list.createDiv({ cls: "stashpad-showcase-nocomments", text: "No feedback yet." });

    this.renderComposer(el, c, s, comments);
    if (hadFocus && sel) {
      const ta = el.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) { ta.focus(); ta.setSelectionRange(sel[0] ?? ta.value.length, sel[1] ?? ta.value.length); }
    }
  }

  private renderComment(list: HTMLElement, c: SectionCache, s: SectionData, n: TreeNode, depth: number, num: number): void {
    const host = this.host!;
    const fm = this.fmOf(n.file);
    const resolved = this.isResolved(n);
    const isTask = this.isOpenTask(n) || resolved;
    const item = list.createDiv({ cls: "stashpad-showcase-comment" + (depth ? " is-reply" : "") + (resolved ? " is-resolved" : "") });
    item.dataset.id = n.id;
    const meta = item.createDiv({ cls: "stashpad-showcase-comment-meta" });
    if (!depth) {
      const badge = meta.createSpan({ cls: "stashpad-showcase-comment-num", text: String(num) });
      badge.dataset.num = String(num);
    }
    const who = this.authorLabel(fm);
    meta.createSpan({ cls: "stashpad-showcase-comment-author", text: who.name });
    if (who.role) meta.createSpan({ cls: "stashpad-showcase-comment-role", text: who.role });
    const created = typeof fm?.created === "string" ? mo(fm.created) : null;
    if (created?.isValid()) {
      const t = meta.createSpan({ cls: "stashpad-showcase-comment-time", text: created.fromNow() });
      t.title = created.format("LLL");
    }

    if (this.veiled(n)) {
      item.addClass("is-veiled");
      const veil = item.createDiv({ cls: "stashpad-showcase-comment-veil" });
      veil.createSpan({ text: "Hidden comment" });
      const show = veil.createEl("button", { text: "Show" });
      show.onclick = () => { this.revealed.add(n.id); c.asideSig = ""; this.scheduleRender(0); };
      return;
    }

    const target = depth ? null : resolveFeedbackTarget(this.app, fm, n.file!.path);
    if (target) {
      const att = s.atts.find((a) => a.file.path === target.path);
      const pin = parseFeedbackPin(fm?.feedbackPin);
      const chip = item.createDiv({ cls: "stashpad-showcase-comment-target", attr: { role: "button", tabindex: "0" } });
      setIcon(chip.createSpan(), pin ? "map-pin" : "image");
      chip.createSpan({ text: `on ${att?.label ? att.label + " · " : ""}${target.name}${pin?.page ? ` · p. ${pin.page}` : ""}` });
      const go = (): void => this.flashAttachment(s.node.id, target.path, pin?.page);
      chip.onclick = go;
      chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    }

    const body = item.createDiv({ cls: "stashpad-showcase-comment-body markdown-rendered" });
    const comp = c.asideComp; // capture: the aside may rebuild before the read resolves
    void this.app.vault.cachedRead(n.file!).then((raw) => {
      if (!body.isConnected) return;
      const text = stripFrontmatter(raw).replace(/^\s*\[[ xX]?\]\s*/, "").trim();
      return MarkdownRenderer.render(this.app, text || "(empty)", body, n.file!.path, comp);
    }).catch(() => body.setText("Couldn't read this note."));
    this.wireLinks(body, n.file!.path);

    const actions = item.createDiv({ cls: "stashpad-showcase-comment-actions" });
    if (!depth) {
      const cb = actions.createEl("button", { cls: "stashpad-showcase-resolve" + (resolved ? " is-on" : "") });
      setIcon(cb.createSpan(), resolved ? "check-circle-2" : "circle");
      cb.createSpan({ text: resolved ? "Resolved" : (isTask ? "Resolve" : "Mark resolved") });
      cb.setAttr("aria-pressed", String(resolved));
      cb.onclick = () => { void host.toggleCompletedForNode(n).then(() => this.scheduleRender(50)); };
      const reply = actions.createEl("button", { cls: "stashpad-showcase-replybtn", text: "Reply" });
      reply.onclick = () => {
        const d = this.draftFor(s.node.id);
        d.replyTo = n.id;
        c.asideSig = ""; this.scheduleRender(0);
        window.setTimeout(() => c.asideEl.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 260);
      };
    }
    const reveal = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Show in the list" } });
    setIcon(reveal, "list-tree");
    reveal.onclick = () => { if (this.folder) void this.plugin.revealNoteByRef(this.folder, n.id); };

    if (depth < 3) {
      const kids = host.tree.getChildren(n.id).filter((k) => k.file);
      if (kids.length) {
        const sub = item.createDiv({ cls: "stashpad-showcase-replies" });
        for (const k of kids) this.renderComment(sub, c, s, k, depth + 1, 0);
      }
    }
  }

  private draftFor(sectionId: string): Draft {
    let d = this.drafts.get(sectionId);
    if (!d) { d = { text: "", target: "", replyTo: null, pin: null, posting: false }; this.drafts.set(sectionId, d); }
    return d;
  }

  private renderComposer(el: HTMLElement, c: SectionCache, s: SectionData, comments: TreeNode[]): void {
    const host = this.host!;
    const d = this.draftFor(s.node.id);
    if (d.replyTo && !comments.some((n) => n.id === d.replyTo)) d.replyTo = null;
    if (d.target && !s.atts.some((a) => a.file.path === d.target)) { d.target = ""; d.pin = null; }

    const box = el.createDiv({ cls: "stashpad-showcase-composer" });
    if (d.replyTo) {
      const n = host.tree.get(d.replyTo);
      const chip = box.createDiv({ cls: "stashpad-showcase-composer-chip" });
      chip.createSpan({ text: `Replying to ${n ? this.authorLabel(this.fmOf(n.file)).name : "a comment"}` });
      const x = chip.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Cancel reply" } });
      setIcon(x, "x");
      x.onclick = () => { d.replyTo = null; c.asideSig = ""; this.scheduleRender(0); };
    } else if (s.atts.length) {
      const row = box.createDiv({ cls: "stashpad-showcase-composer-target" });
      const select = row.createEl("select", { attr: { "aria-label": "What is this feedback about?" } });
      select.createEl("option", { text: "Whole section", value: "" });
      for (const a of s.atts) {
        const o = select.createEl("option", { text: `${a.label ? a.label + " · " : ""}${a.file.name}`, value: a.file.path });
        if (a.file.path === d.target) o.selected = true;
      }
      select.onchange = () => { d.target = select.value; d.pin = null; this.setPinPicking(null); c.asideSig = ""; this.scheduleRender(0); };
      const targetAtt = s.atts.find((a) => a.file.path === d.target);
      if (targetAtt && this.pinnable(c, targetAtt)) {
        const pinBtn = row.createEl("button", { cls: "stashpad-showcase-pinbtn" + (d.pin ? " is-set" : "") + (this.pinPicking === s.node.id ? " is-picking" : "") });
        setIcon(pinBtn.createSpan(), "map-pin");
        const pinned = d.pin ? parseFeedbackPin(d.pin) : null;
        pinBtn.createSpan({ text: pinned ? (pinned.page ? `Pinned on p. ${pinned.page}` : "Pinned") : (this.pinPicking === s.node.id ? "Click the spot…" : "Pin a spot") });
        pinBtn.title = d.pin ? "Click to remove the pin" : "Then click the exact spot on the image or page";
        pinBtn.onclick = () => {
          if (d.pin) { d.pin = null; this.setPinPicking(null); c.asideSig = ""; this.scheduleRender(0); return; }
          this.setPinPicking(this.pinPicking === s.node.id ? null : s.node.id);
        };
      }
    }

    const ta = box.createEl("textarea", { cls: "stashpad-showcase-input", attr: { rows: "2", placeholder: d.replyTo ? "Write a reply…" : "Add feedback…", "aria-label": d.replyTo ? "Reply" : "Add feedback" } });
    ta.value = d.text;
    ta.oninput = () => { d.text = ta.value; };
    const post = box.createEl("button", { cls: "mod-cta stashpad-showcase-post", text: d.posting ? "Posting…" : (d.replyTo ? "Reply" : "Post") });
    // While a post is in flight the draft is EMPTY and the composer disabled: a
    // rebuild in the meantime (the new note's own tree event lands ~200 ms in,
    // long before a network-drive write returns) must not refill the text and
    // offer a live Post button — that double-posted.
    ta.disabled = d.posting; post.disabled = d.posting;
    const submit = async (): Promise<void> => {
      const text = ta.value.trim();
      if (!text || d.posting) return;
      const snapshot = { text: d.text, target: d.target, replyTo: d.replyTo, pin: d.pin };
      d.posting = true; d.text = "";
      ta.disabled = true; post.disabled = true; post.setText("Posting…");
      const ok = await this.postFeedback(s, text, snapshot);
      d.posting = false;
      if (ok) { d.replyTo = null; d.pin = null; d.target = ""; this.setPinPicking(null); }
      else { d.text = d.text || snapshot.text; } // keep anything typed since; else restore
      c.asideSig = ""; this.scheduleRender(50);
    };
    post.onclick = () => void submit();
    ta.addEventListener("keydown", (e) => {
      // Enter posts (Shift+Enter = newline), like the composer — but on mobile
      // the on-screen Return key must stay a newline; the button posts there.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !Platform.isMobile) { e.preventDefault(); void submit(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
    });
  }

  /** Create the feedback note under the section (or under the comment being
   *  replied to) through the host's normal note-creation path, with the
   *  feedback keys in the same write. Top-level feedback is an open task so it
   *  can be resolved. */
  private async postFeedback(s: SectionData, text: string, d: Pick<Draft, "target" | "replyTo" | "pin">): Promise<boolean> {
    const host = this.host;
    if (!host) { notify("Stashpad: open this folder in Stashpad first."); return false; }
    const parent = d.replyTo ?? s.node.id;
    const body = d.replyTo ? text : `[ ] ${text}`;
    const target = d.replyTo ? "" : d.target;
    const extraFm: Record<string, string | boolean> = { feedback: true };
    if (target) extraFm.feedbackOn = `[[${target}]]`;
    if (target && d.pin) extraFm.feedbackPin = d.pin;
    // One write: the feedback keys go into the note's YAML at creation, so no
    // follow-up frontmatter write races the create or reads as a coworker's
    // edit. No folder template (a comment isn't a page) and no composer
    // side effects on undo (it didn't come from the list composer).
    try {
      const id = await host.createNoteUnder(body, parent, { record: true, extraFm, skipTemplate: true, keepComposer: true });
      return !!id;
    } catch (e) {
      notify(`Stashpad: couldn't post feedback (${(e as Error).message})`);
      return false;
    }
  }

  // ---------------------------------------------------------------- find

  private buildFindBar(el: HTMLElement): void {
    this.findEl = el;
    const input = el.createEl("input", { cls: "stashpad-showcase-find-input", attr: { type: "search", placeholder: "Find in captions, comments and PDF text", "aria-label": "Find in this page" } });
    this.findInput = input;
    this.findCount = el.createSpan({ cls: "stashpad-showcase-find-count", attr: { "aria-live": "polite" } });
    const prev = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Previous match" } });
    setIcon(prev, "chevron-up");
    const next = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Next match" } });
    setIcon(next, "chevron-down");
    const close = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close find" } });
    setIcon(close, "x");
    input.addEventListener("input", () => { this.findIdx = -1; this.scheduleFind(false); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); this.closeFind(); }
    });
    prev.onclick = () => this.stepFind(-1);
    next.onclick = () => this.stepFind(1);
    close.onclick = () => this.closeFind();
  }

  private openFind(): void {
    if (!this.findEl || !this.findInput) return;
    const wasOpen = this.findEl.hasClass("is-open");
    this.findEl.addClass("is-open");
    const sel = this.containerEl.win.getSelection()?.toString().trim();
    if (sel && sel.length < 80 && !sel.includes("\n")) this.findInput.value = sel;
    this.findInput.focus();
    this.findInput.select();
    // First open: open every PDF not opened yet, and fetch every page's text,
    // so pages that aren't drawn (or PDFs far down the page) are searchable.
    if (!wasOpen) {
      for (const start of [...this.pdfBuilders]) start();
      for (const get of this.pdfTextSources.values()) void get().catch(() => undefined);
    }
    this.findIdx = -1;
    this.scheduleFind(false);
  }

  private closeFind(): void {
    this.findEl?.removeClass("is-open");
    this.findInput?.blur(); // don't leave focus in a hidden input
    this.findMatches = []; this.findIdx = -1;
    if (this.findTimer !== null) { window.clearTimeout(this.findTimer); this.findTimer = null; }
    this.pageEl?.querySelectorAll(".stashpad-showcase-pdfpage.is-find-current").forEach((el) => el.removeClass("is-find-current"));
    this.findWasPageStop = false;
    this.clearFindHighlights();
  }

  /** `keepPlace`: a re-run after the page changed (render, text arriving) —
   *  keep the current match rather than restarting. Queued requests combine:
   *  if any asked for a fresh search, the run is a fresh search. */
  private scheduleFind(keepPlace: boolean): void {
    if (!this.findEl?.hasClass("is-open")) return;
    this.findKeepPending = this.findKeepPending && keepPlace;
    // A run is already queued: fold this request into it rather than pushing
    // it back — a stream of page-text arrivals must not starve Find. (A fresh
    // typing request still shortens nothing, but it can't be postponed either.)
    if (this.findTimer !== null) return;
    this.findTimer = window.setTimeout(() => {
      this.findTimer = null;
      const keep = this.findKeepPending;
      this.findKeepPending = true;
      this.runFind(keep);
    }, keepPlace ? 300 : 150);
  }

  /** The searchable text of a block plus a map back to its text nodes.
   *  Line breaks (<br>, which the PDF text layer emits at each line end) and
   *  block boundaries count as one space, so phrases match across pdf.js items
   *  and lines the same way as in the extracted page text. */
  private blockText(scope: HTMLElement): { text: string; segs: Array<{ node: Text; start: number }> } {
    const doc = scope.doc;
    const BLOCK = /^(P|LI|H[1-6]|DIV|BLOCKQUOTE|PRE|TR|TD|TH|DT|DD)$/;
    let text = "";
    const segs: Array<{ node: Text; start: number }> = [];
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const v = n.nodeValue ?? "";
        if (!v) continue;
        segs.push({ node: n as Text, start: text.length });
        text += v;
      } else {
        const tag = (n as Element).tagName;
        if ((tag === "BR" || BLOCK.test(tag)) && text && !text.endsWith(" ")) text += " ";
      }
    }
    return { text, segs };
  }

  /** Matches in page order: ranges (possibly spanning several text nodes) in
   *  captions, comment bodies and drawn PDF text layers; a PDF page not drawn
   *  yet is a whole-page stop per occurrence in its extracted text. Capped so a
   *  one-letter query on a long PDF can't build tens of thousands of ranges. */
  private runFind(keepPlace: boolean): void {
    const q = foldForFind((this.findInput?.value ?? "").trim()).replace(/\s+/g, " ");
    const CAP = 1000;
    const matches: Array<{ range: Range } | { page: HTMLElement }> = [];
    if (q && this.pageEl) {
      const blocks = this.pageEl.querySelectorAll<HTMLElement>(".stashpad-showcase-caption, .stashpad-showcase-comment-body, .stashpad-showcase-pdfpage");
      outer: for (const block of Array.from(blocks)) {
        if (block.closest(".stashpad-showcase-veil, .is-veiled")) continue;
        const scope = block.hasClass("stashpad-showcase-pdfpage") ? block.querySelector<HTMLElement>(".textLayer") : block;
        if (scope) {
          const { text, segs } = this.blockText(scope);
          if (!segs.length) continue;
          const hay = foldForFind(text).replace(/\s/g, " ");
          // index → (text node, offset); an index on a virtual space snaps to
          // the next real character (start) / previous one (end).
          const at = (i: number, isEnd: boolean): [Text, number] | null => {
            for (let k = 0; k < segs.length; k++) {
              const sg = segs[k]; const len = sg.node.nodeValue?.length ?? 0;
              if (isEnd ? (i > sg.start && i <= sg.start + len) : (i >= sg.start && i < sg.start + len)) return [sg.node, i - sg.start];
              if (!isEnd && i < sg.start) return [sg.node, 0];
              if (isEnd && i <= sg.start) return k > 0 ? [segs[k - 1].node, segs[k - 1].node.nodeValue?.length ?? 0] : null;
            }
            const last = segs[segs.length - 1];
            return isEnd ? [last.node, last.node.nodeValue?.length ?? 0] : null;
          };
          for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
            const a = at(i, false); const b = at(i + q.length, true);
            if (!a || !b) continue;
            const r = scope.doc.createRange();
            try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); } catch { continue; }
            matches.push({ range: r });
            if (matches.length >= CAP) break outer;
          }
        } else {
          const hay = foldForFind(this.pdfText.get(block) ?? "").replace(/\s/g, " ");
          for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
            matches.push({ page: block });
            if (matches.length >= CAP) break outer;
          }
        }
      }
    }
    this.findMatches = matches;
    this.findCapped = matches.length >= CAP;
    if (!matches.length) this.findIdx = -1;
    else if (!keepPlace || this.findIdx < 0) this.findIdx = 0;
    else if (this.findIdx >= matches.length) this.findIdx = matches.length - 1;
    const cur = this.findIdx >= 0 ? matches[this.findIdx] : null;
    const pageStopResolved = keepPlace && this.findWasPageStop && !!cur && "range" in cur;
    this.paintFind(!keepPlace || pageStopResolved);
  }

  private stepFind(dir: 1 | -1): void {
    if (!this.findMatches.length) { this.runFind(false); return; }
    this.findIdx = (this.findIdx + dir + this.findMatches.length) % this.findMatches.length;
    this.paintFind(true);
  }

  private paintFind(scroll: boolean): void {
    const n = this.findMatches.length;
    const q = (this.findInput?.value ?? "").trim();
    if (this.findCount) this.findCount.setText(!q ? "" : n ? `${this.findIdx + 1} of ${n}${this.findCapped ? "+" : ""}` : "No matches");
    // Highlights live in the window this view is in (popouts have their own).
    const win = this.containerEl.win as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...r: Range[]) => unknown };
    const reg = win.CSS?.highlights; const HL = win.Highlight;
    const cur = this.findIdx >= 0 ? this.findMatches[this.findIdx] : null;
    if (reg && HL) {
      const w = this.containerEl.win;
      if (this.findWin && this.findWin !== w) this.clearFindHighlights(); // moved windows: clean the old one
      StashpadShowcaseView.findOwners.set(w, this);
      this.findWin = w;
      const others = this.findMatches.filter((m): m is { range: Range } => "range" in m && m !== cur).map((m) => m.range);
      reg.set("stashpad-find", new HL(...others));
      if (cur && "range" in cur) reg.set("stashpad-find-current", new HL(cur.range)); else reg.delete("stashpad-find-current");
    }
    this.pageEl?.querySelectorAll(".stashpad-showcase-pdfpage.is-find-current").forEach((el) => el.removeClass("is-find-current"));
    this.findWasPageStop = !!cur && "page" in cur;
    if (!cur) return;
    if ("range" in cur) {
      if (scroll) cur.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      // A page that isn't drawn yet: go there; once its text layer exists the
      // keep-place re-run swaps this stop for the exact words.
      cur.page.addClass("is-find-current");
      if (scroll) cur.page.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  private clearFindHighlights(): void {
    const w = this.findWin;
    if (!w) return;
    this.findWin = null;
    if (StashpadShowcaseView.findOwners.get(w) !== this) return; // another tab owns that window's now
    StashpadShowcaseView.findOwners.delete(w);
    const reg = (w as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    reg?.delete("stashpad-find"); reg?.delete("stashpad-find-current");
  }

  // ---------------------------------------------------------------- export

  /** "👍 2 (Alex, Sam) · ❌ 1 (Kim)" with real names — the export's reader isn't "You". */
  private reactionSummary(map: ReactionMap): string {
    const me = (this.plugin.settings.authorId ?? "").trim() || "local";
    const nameOf = (id: string): string => this.plugin.authorRegistry.get(id)?.name
      || (id === me ? (this.plugin.settings.authorName || "me") : id);
    return Object.entries(map).filter(([, ids]) => ids.length)
      .map(([e, ids]) => `${e} ${ids.length} (${ids.map(nameOf).join(", ")})`).join(" · ");
  }

  private async runExport(includeFeedback: boolean): Promise<void> {
    const host = this.host;
    if (!host) { notify("Stashpad: open this folder in Stashpad first."); return; }
    if (this.exporting) { notify("Stashpad: an export is already being built."); return; }
    this.exporting = true;
    const progress = notify("Stashpad: building the page…", 0);
    try {
      const title = this.levelTitle() || "Showcase"; // before the awaits: navigating mid-export mustn't rename it
      const sections: ExportSection[] = [];
      for (const node of host.tree.getChildren(this.focusId).filter((n) => n.file)) {
        // A blurred note stays out of an export unless it's revealed in this tab.
        if (host.isObscured(node) && !this.revealed.has(node.id)) continue;
        const s = await this.readSection(node);
        const fm = this.fmOf(s.file);
        const comments: ExportComment[] = [];
        if (includeFeedback) {
          const walk = async (ns: TreeNode[], depth: number): Promise<void> => {
            for (const [i, n] of ns.entries()) {
              if (this.veiled(n)) continue; // hidden comments stay out of exports
              const nfm = this.fmOf(n.file);
              let text = "";
              try { text = stripFrontmatter(await this.app.vault.cachedRead(n.file!)).replace(/^\s*\[[ xX]?\]\s*/, "").trim(); } catch { /* unreadable */ }
              const target = depth ? null : resolveFeedbackTarget(this.app, nfm, n.file!.path);
              const att = target ? s.atts.find((a) => a.file.path === target.path) : undefined;
              const pin = target ? parseFeedbackPin(nfm?.feedbackPin) : null;
              const who = this.authorLabel(nfm, true);
              const created = typeof nfm?.created === "string" ? mo(nfm.created) : null;
              comments.push({
                num: depth ? 0 : i + 1, author: who.name, role: who.role,
                when: created?.isValid() ? created.format("LLL") : "",
                text, target: target ? `${att?.label ? att.label + " · " : ""}${target.name}${pin?.page ? ` · p. ${pin.page}` : ""}` : "",
                resolved: this.isResolved(n), depth,
                pin: pin && target ? { ...pin, path: target.path } : null,
              });
              if (depth < 3) await walk(host.tree.getChildren(n.id).filter((k) => k.file), depth + 1);
            }
          };
          await walk(host.tree.getChildren(s.node.id).filter((n) => n.file), 0);
        }
        sections.push({
          text: s.text, sourcePath: s.file.path, comments,
          reactions: includeFeedback ? this.reactionSummary(readReactions(fm)) : "",
          atts: s.atts.map((a) => ({ file: a.file, label: a.label, reactions: includeFeedback ? this.reactionSummary(this.attachmentReactions(fm, a.key)) : "" })),
        });
      }
      const { html, skipped } = await buildShowcaseHtml(this.app, title, sections, {
        includeFeedback,
        onProgress: (msg) => progress?.setMessage(`Stashpad: building the page… ${msg}`),
      });
      const sub = (this.plugin.settings.exportFolder || "_exports").trim().replace(/^\/+|\/+$/g, "");
      const folder = `${host.noteFolder}/${sub}`;
      await host.ensureFolder(folder);
      // Emoji-safe cut (by code point), no leading dots (hidden file).
      const cleaned = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
      const safe = Array.from(cleaned).slice(0, 80).join("").trim() || "Showcase";
      const stamp = mo(new Date().toISOString()).format("YYYYMMDD-HHmmss");
      const base = `${folder}/${safe} - page${includeFeedback ? " + feedback" : ""} - ${stamp}`;
      let path = `${base}.html`;
      for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} (${n}).html`;
      await this.app.vault.create(path, html);
      progress?.hide();
      const mb = (html.length / 1048576).toFixed(1);
      this.plugin.notifications.show({
        message: `Exported "${title}" as one web page (${mb} MB) → \`${path}\`${skipped.length ? `. Left out (too large): ${skipped.join(", ")}` : ""}`,
        kind: "success", category: "export", affectedPaths: [path], folder: host.noteFolder,
        actions: host.actionsForFile(path), duration: 0,
      });
    } catch (e) {
      progress?.hide();
      notify(`Stashpad: export failed (${(e as Error).message})`);
    } finally {
      this.exporting = false;
    }
  }

  // ---------------------------------------------------------------- pins

  private setPinPicking(sectionId: string | null): void {
    this.pinPicking = sectionId;
    this.pageEl?.querySelectorAll<HTMLElement>(".stashpad-showcase-section").forEach((el) => {
      el.toggleClass("is-pin-picking", !!sectionId && el.dataset.id === sectionId);
    });
    // Rebuild composers so the pin button label follows.
    for (const c of this.cache.values()) c.asideSig = "";
    this.scheduleRender(0);
  }

  /** `el` = the image, or a PDF page box (then `page` is its 1-based number). */
  private placePin(s: SectionData, a: Attachment, el: HTMLElement, e: MouseEvent, page?: number): void {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const d = this.draftFor(s.node.id);
    d.target = a.file.path;
    d.pin = `${x.toFixed(4)},${y.toFixed(4)}${page ? `,${page}` : ""}`;
    this.setPinPicking(null);
    window.setTimeout(() => this.cache.get(s.node.id)?.asideEl.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 260);
  }

  /** Numbered dots on images for comments that carry a `feedbackPin`, plus the
   *  pending pin of a draft. Repainted every pass (cheap). */
  private renderPins(c: SectionCache, s: SectionData, comments: TreeNode[]): void {
    for (const [key, host] of c.pinHosts) {
      // Same focus-keeping rule as the reaction bars: skip if nothing changed.
      const d0 = this.drafts.get(s.node.id);
      const sig = comments.map((n) => { const fm = this.fmOf(n.file); return `${n.id}:${String(fm?.feedbackPin ?? "")}:${String(fm?.feedbackOn ?? "")}:${fm?.completed === true}:${this.veiled(n)}`; }).join(",")
        + `|${this.hideResolved}|${this.veiled(s.node)}|${d0?.target ?? ""}|${d0?.pin ?? ""}`;
      if (host.dataset.sig === sig) continue;
      host.dataset.sig = sig;
      host.empty();
      comments.forEach((n, i) => {
        const fm = this.fmOf(n.file);
        const pin = parseFeedbackPin(fm?.feedbackPin);
        if (!pin) return;
        const t = resolveFeedbackTarget(this.app, fm, n.file!.path);
        if (!t || pinKey(t.path, pin.page) !== key) return;
        if (this.hideResolved && this.isResolved(n)) return;
        if (this.veiled(n) || this.veiled(s.node)) return;
        const dot = host.createEl("button", { cls: "stashpad-showcase-pin" + (this.isResolved(n) ? " is-resolved" : ""), text: String(i + 1) });
        dot.style.left = `${pin.x * 100}%`;
        dot.style.top = `${pin.y * 100}%`;
        dot.setAttr("aria-label", `Feedback ${i + 1}`);
        dot.onclick = (e) => { e.stopPropagation(); this.flashComment(c, n.id); };
      });
      const d = this.drafts.get(s.node.id);
      const draftPin = d?.pin && d.target ? parseFeedbackPin(d.pin) : null;
      const pending = draftPin && pinKey(d!.target, draftPin.page) === key ? draftPin : null;
      if (pending) {
        const dot = host.createDiv({ cls: "stashpad-showcase-pin is-pending", text: "+" });
        dot.style.left = `${pending.x * 100}%`;
        dot.style.top = `${pending.y * 100}%`;
      }
    }
  }

  private flashAttachment(sectionId: string, path: string, page?: number): void {
    const c = this.cache.get(sectionId);
    const att = c ? Array.from(c.mainEl.querySelectorAll<HTMLElement>(".stashpad-showcase-att")).find((el) => el.dataset.path === path) : null;
    // A pin on a PDF page scrolls to (and flashes) that page, not the whole PDF.
    const card = (page && att?.querySelector<HTMLElement>(`.stashpad-showcase-pdfpage[data-page="${page}"]`)) || att;
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.removeClass("is-flash"); void card.offsetWidth; card.addClass("is-flash");
    window.setTimeout(() => card.removeClass("is-flash"), 1600);
  }

  private flashComment(c: SectionCache, id: string): void {
    const el = Array.from(c.asideEl.querySelectorAll<HTMLElement>(".stashpad-showcase-comment")).find((x) => x.dataset.id === id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    el.removeClass("is-flash"); void el.offsetWidth; el.addClass("is-flash");
    window.setTimeout(() => el.removeClass("is-flash"), 1600);
  }

}

/** 0.532.1: keep Showcase review state attached to a file through renames and
 *  moves. Per-option reactions are keyed by the file's vault path
 *  (`"<emoji>:<authorId>:<path>"`), so without this a renamed proposal lost
 *  its votes. Also re-points a comment's `feedbackOn` if Obsidian's own link
 *  updater left it on the old path (it normally updates frontmatter links —
 *  then this is a no-op). Renames are batched (a folder move renames every
 *  file in it) and chained (a→b→c within one batch resolves to c). Only the
 *  device that performs the rename runs this; the edit syncs like any other. */
export function installAttachmentRenameSync(plugin: StashpadPlugin): void {
  const { app } = plugin;
  const pending = new Map<string, string>();
  let timer: number | null = null;
  let chain: Promise<void> = Promise.resolve();
  const entryPath = (e: string): string => {
    const a = e.indexOf(":"); const b = a < 0 ? -1 : e.indexOf(":", a + 1);
    return b < 0 ? "" : e.slice(b + 1);
  };
  const flush = async (): Promise<void> => {
    const moves = new Map(pending); pending.clear();
    for (const [k, v] of moves) if (k === v) moves.delete(k); // moved back = no change
    if (!moves.size) return;
    const finalPath = (p: string): string => moves.get(p) ?? p;
    for (const f of app.vault.getMarkdownFiles()) {
      const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm) continue;
      const list = Array.isArray(fm.attachmentReactions) ? (fm.attachmentReactions as unknown[]) : null;
      const hitReactions = !!list?.some((e) => typeof e === "string" && moves.has(entryPath(e)));
      const fbRaw = typeof fm.feedbackOn === "string" ? fm.feedbackOn : "";
      const fbInner = fbRaw.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
      const hitFeedback = !!fbInner && moves.has(fbInner);
      if (!hitReactions && !hitFeedback) continue;
      const leaf = anyStashpadLeafOnFolder(app, f.parent?.path ?? "", { normalize: true });
      const markSelf = (): void => (leaf?.view as unknown as { markFmSelfWrite?: (p: string) => void } | undefined)?.markFmSelfWrite?.(f.path);
      try {
        await app.fileManager.processFrontMatter(f, (m: Record<string, unknown>) => {
          const before = JSON.stringify([m.attachmentReactions, m.feedbackOn]);
          if (Array.isArray(m.attachmentReactions)) {
            const out: string[] = [];
            for (const e of m.attachmentReactions as unknown[]) {
              if (typeof e !== "string") continue;
              const path = entryPath(e);
              const next = path && moves.has(path) ? e.slice(0, e.length - path.length) + finalPath(path) : e;
              if (!out.includes(next)) out.push(next);
            }
            if (out.length) m.attachmentReactions = out; else delete m.attachmentReactions;
          }
          if (typeof m.feedbackOn === "string") {
            const inner = m.feedbackOn.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
            // Only if nothing lives at the old path any more: when a path was
            // reused in the batch, Obsidian's own link updater has already
            // rewritten this link, and mapping it again would mis-point it.
            if (moves.has(inner) && !app.vault.getAbstractFileByPath(inner)) m.feedbackOn = `[[${finalPath(inner)}]]`;
          }
          // Mark it as our own write only when something actually changed — an
          // unused marker would hide a real outside edit's log line for a while.
          if (JSON.stringify([m.attachmentReactions, m.feedbackOn]) !== before) markSelf();
        });
      } catch (e) {
        console.warn("Stashpad showcase: couldn't move review state after a rename", f.path, e);
      }
    }
  };
  plugin.registerEvent(app.vault.on("rename", (file, oldPath) => {
    if (!(file instanceof TFile) || file.extension === "md") return;
    // Map ORIGINAL path → CURRENT path, composed as renames arrive, so each
    // lookup is one step: A→B then C→A keeps C's votes on A (a chain walk
    // sent them to B), and a swap through a temp name resolves correctly.
    let composed = false;
    for (const [orig, cur] of pending) if (cur === oldPath) { pending.set(orig, file.path); composed = true; break; }
    // A NEW file at an original key's path renamed again mustn't take over
    // that key (its votes, if any, aren't the moved file's).
    if (!composed && !pending.has(oldPath)) pending.set(oldPath, file.path);
    if (timer !== null) window.clearTimeout(timer);
    // Flushes run one after another: a batch that starts while the previous
    // one is still writing would read a cache that hasn't caught up.
    timer = window.setTimeout(() => { timer = null; chain = chain.then(flush, flush); }, 600);
  }));
  plugin.register(() => { if (timer !== null) window.clearTimeout(timer); });
}

/** Open (or reveal) the Showcase for a level — mirrors openKanbanView. */
export async function openShowcaseView(plugin: StashpadPlugin, folder: string | null, focusId: StashpadId = ROOT_ID): Promise<void> {
  if (!folder) { notify("Stashpad: open a Stashpad folder first, then open Showcase from it."); return; }
  const { workspace } = plugin.app;
  const want = folder.replace(/\/+$/, "");
  const existing = workspace.getLeavesOfType(STASHPAD_SHOWCASE_VIEW_TYPE).find((l) => {
    const st = l.getViewState()?.state as { folder?: string | null; focusId?: string | null } | undefined;
    return (st?.folder ?? null) === want && (st?.focusId ?? ROOT_ID) === focusId;
  });
  if (existing) { void workspace.revealLeaf(existing); return; }
  const originLeaf = workspace.getMostRecentLeaf();
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_SHOWCASE_VIEW_TYPE, active: true, state: { folder: want, focusId } });
  void workspace.revealLeaf(leaf);
  settleNewTab(workspace, originLeaf);
  returnToOriginOnClose(workspace, leaf, originLeaf, (ref) => plugin.registerEvent(ref));
}

/** The chip a feedback note shows in the normal list: "on <file>" — click opens
 *  the file in the preview modal (the photo the comment is about). */
export function renderFeedbackTargetChip(app: ItemView["app"], host: HTMLElement, file: TFile): void {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const target = resolveFeedbackTarget(app, fm, file.path);
  if (!target) return;
  const pin = parseFeedbackPin(fm?.feedbackPin);
  const chip = host.createDiv({ cls: "stashpad-feedback-chip", attr: { role: "button", tabindex: "0" } });
  setIcon(chip.createSpan({ cls: "stashpad-feedback-chip-icon" }), pin ? "map-pin" : "message-square");
  chip.createSpan({ text: `Feedback on ${target.name}` });
  chip.title = `Open ${target.name}`;
  const open = (e: Event): void => {
    e.preventDefault(); e.stopPropagation();
    new MediaViewerModal(app, mediaItemsFor(app, [target.path]), 0, (f) => { void app.workspace.openLinkText(f.path, "", "tab"); }).open();
  };
  chip.addEventListener("click", open);
  chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
}
