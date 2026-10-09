import { Component, ItemView, Keymap, MarkdownRenderer, Menu, Platform, Scope, TFile, WorkspaceLeaf, loadPdfJs, moment, setIcon, type App, type ViewStateResult } from "obsidian";
import { addCopyTabLinkItem } from "./tab-link-menu";
import type StashpadPlugin from "./main";
import type { StashpadView } from "./view";
import { ROOT_ID, STASHPAD_SHOWCASE_VIEW_TYPE, attachmentLinkPath, parseAuthorRef, type StashpadId, type TreeNode } from "./types";
import { anyStashpadLeafOnFolder, stashpadLeafOnFolderIncludingDeferred } from "./leaf-lookup";
import { MediaViewerModal, mediaItemsFor, type SpotComments } from "./media-viewer";
import { isImageExt } from "./file-kinds";
import { myReactionId, openReactionPicker, readReactions, toggleReaction, type ReactionMap } from "./reactions";
import { returnToOriginOnClose } from "./leaf-return";
import { settleNewTab } from "./view-helpers";
import { notify } from "./notify";
import { ShowcaseExportModal, buildShowcaseHtml, type ExportComment, type ExportSection } from "./showcase-export";
import { appendShapeEl, formatFeedbackShape, paintShapeThumb, parseFeedbackShape, shapeAnchor, shapeFromDrag, type FeedbackShape, type ShapeKind } from "./showcase-shapes";

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
 *    `feedbackPin: "x,y"` when pinned to a spot on that image (+
 *    `feedbackShape` when it marks an area or draws an arrow, 0.556.0 — see
 *    showcase-shapes.ts) — all written in the same create. The normal list shows the target as a chip that opens the
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

/** 0.554.1: drafts outlive the view (a navigation tab can be replaced by
 *  another open and come back with ←); weak, so a closed tab lets them go. */
const DRAFTS_BY_LEAF = new WeakMap<WorkspaceLeaf, Map<string, Draft>>();
/** `scrollTo`: the section to land on (0.549.0). 0.554.1: also SAVED — the
 *  section you were looking at — so back/forward and a restored tab return to
 *  your place (quietly); `flash` marks a deliberate landing (from the list),
 *  which also highlights it. */
interface ShowcaseState { folder?: string | null; focusId?: string | null; layout?: Layout; hideResolved?: boolean; scrollTo?: string | null; flash?: boolean; flashComment?: string | null; pinOn?: string | null }

/** The quick reactions offered on every section and option: approve / reject. */
export const SHOWCASE_REACTIONS: readonly string[] = ["👍", "👎", "✅", "❌"];

/** 0.548.0: what each quick reaction MEANS, said in words — on hover, to screen
 *  readers, and (`word`) next to ✅/❌ on the bar itself, since "👍 vs ✅" was
 *  a guess. A section is approved or sent back; an option is picked or not.
 *  Presentation only: what's stored is still just the emoji. */
const REACTION_MEANING: Record<string, { section: string; option: string; word?: boolean }> = {
  "👍": { section: "Like", option: "Like" },
  "👎": { section: "Don't like", option: "Don't like" },
  "✅": { section: "Approve", option: "Select", word: true },
  "❌": { section: "Needs changes", option: "Reject", word: true },
};

type TreeLike = Pick<StashpadView["tree"], "get" | "getChildren" | "pathTo">;

/** A Showcase comment rather than a page: written by the Showcase (`feedback`)
 *  or aimed at a file / spot. */
function isFeedbackNote(app: App, n: TreeNode): boolean {
  const fm = n.file ? app.metadataCache.getFileCache(n.file)?.frontmatter as Record<string, unknown> | undefined : undefined;
  return !!fm && (fm.feedback === true || fm.feedbackOn != null || fm.feedbackPin != null);
}

/** The note links or embeds a non-note file (what readSection shows as its
 *  files) — from Obsidian's index, no disk read. */
function noteHasFiles(app: App, n: TreeNode): boolean {
  const file = n.file;
  if (!file) return false;
  const cache = app.metadataCache.getFileCache(file);
  for (const l of [...(cache?.embeds ?? []), ...(cache?.links ?? [])]) {
    const dest = app.metadataCache.getFirstLinkpathDest(attachmentLinkPath(l.link), file.path);
    if (dest instanceof TFile && dest.extension !== "md") return true;
  }
  return false;
}

/** The level a note is shown in: its parent by PATH — an orphan (parent note
 *  deleted outside Stashpad) hangs under Home while still naming the missing
 *  parent, so `node.parent` alone would point at an empty level. */
function levelOf(tree: TreeLike, id: StashpadId): StashpadId {
  const path = tree.pathTo(id);
  return path.length > 1 ? path[path.length - 2].id : ROOT_ID;
}

/** Why a level is really one page (see showcaseLanding); null = it isn't. */
export type PageReason = "empty" | "comments" | "files" | null;

/** The note EMBEDS a non-note file (`![[file]]`) — a page's picture, not a
 *  passing "see [[logo.png]]" reference. */
function noteEmbedsFiles(app: App, n: TreeNode): boolean {
  const file = n.file;
  if (!file) return false;
  for (const l of app.metadataCache.getFileCache(file)?.embeds ?? []) {
    const dest = app.metadataCache.getFirstLinkpathDest(attachmentLinkPath(l.link), file.path);
    if (dest instanceof TFile && dest.extension !== "md") return true;
  }
  return false;
}

/** 0.549.0: where a Showcase opened from the list should land.
 *
 *  Showcase pages are the CHILDREN of a level. Opened from INSIDE a note that
 *  is itself the page it used to say "Nothing at this level yet", or show the
 *  comments as the pages and never the note's own files. A note is a page
 *  when (reason):
 *  - "empty": nothing under it;
 *  - "comments": everything under it is feedback;
 *  - "files": it has files and none of the (non-feedback) notes under it do.
 *  Such a note opens a level up (orphans: Home), scrolled to it — the
 *  Showcase's own shape: the note as a page, its children as its feedback. A
 *  COMMENT that's a page (inside a comment) keeps climbing to the page it's
 *  about. "files" is a guess (a level with a cover image and text-only pages
 *  also matches), so the Showcase offers the way back down (each section's
 *  "Notes under it" button, and the notice).
 *
 *  Otherwise it opens on the level, scrolled to the page `cursorId` is on (or
 *  the section a nested cursor row sits under). */
export function showcaseLanding(app: App, tree: TreeLike, focusId: StashpadId, cursorId: StashpadId | null, depth = 0): { focusId: StashpadId; scrollTo: StashpadId | null; reason: PageReason } {
  const self = focusId === ROOT_ID ? undefined : tree.get(focusId);
  if (self?.file) {
    const kids = tree.getChildren(focusId).filter((n) => n.file);
    const pages = kids.filter((n) => !isFeedbackNote(app, n));
    const reason: PageReason = !kids.length ? "empty" : !pages.length ? "comments"
      : noteHasFiles(app, self) && !pages.some((n) => noteHasFiles(app, n)) ? "files" : null;
    if (reason) {
      const parent = levelOf(tree, focusId);
      if (depth < 16 && isFeedbackNote(app, self)) {
        const up = showcaseLanding(app, tree, parent, null, depth + 1);
        if (up.reason) return up;
      }
      return { focusId: parent, scrollTo: focusId, reason };
    }
  }
  let scrollTo: StashpadId | null = null;
  if (cursorId && cursorId !== focusId) {
    // The cursor may be on a nested row: land on the section it's under.
    const path = tree.pathTo(cursorId);
    const i = focusId === ROOT_ID ? 0 : path.findIndex((n) => n.id === focusId) + 1;
    if (i >= 0 && i < path.length && (focusId === ROOT_ID || i > 0)) scrollTo = path[i].id;
  }
  return { focusId, scrollTo, reason: null };
}

/** 0.551.0: a section's review decision, read off its own ✅ / ❌ reactions:
 *  any ❌ "Needs changes" wins (one objection is enough to send it back);
 *  else any ✅ "Approve" means approved; else no decision yet. */
type SectionStatus = "approved" | "changes" | "none";
/** Everyone who reacted `emoji`, in ANY presentation form: the emoji picker
 *  stores "✅️" (with U+FE0F), the Showcase's buttons store "✅" — same
 *  vote. Union, so one person isn't counted twice. */
export function reactorsOf(map: ReactionMap, emoji: string): string[] {
  const want = emoji.replace(/\uFE0F/g, "");
  const ids = new Set<string>();
  for (const [k, v] of Object.entries(map)) if (k.replace(/\uFE0F/g, "") === want) for (const id of v) ids.add(id);
  return [...ids];
}
export function sectionStatus(map: ReactionMap): SectionStatus {
  if (reactorsOf(map, "❌").length) return "changes";
  if (reactorsOf(map, "✅").length) return "approved";
  return "none";
}
const STATUS_TEXT: Record<SectionStatus, string> = { approved: "Approved", changes: "Needs changes", none: "No decision yet" };
const STATUS_ICON: Record<SectionStatus, string> = { approved: "check-circle-2", changes: "circle-x", none: "circle" };

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
/** 0.556.0: a press has to move this far (screen px) to draw a shape rather
 *  than drop a pin; a drawn box is at least MIN_SHAPE_PX each way. */
const DRAG_MIN_PX = 6;
const MIN_SHAPE_PX = 10;
/** A comment's close-up of its area fits inside this (CSS px). */
const THUMB_MAX_W = 280;
const THUMB_MAX_H = 150;

interface PdfJsRenderTask { promise: Promise<void>; cancel?: () => void }
interface PdfJsTextContent { items: Array<{ str?: string; hasEOL?: boolean }> }
interface PdfJsPage { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): PdfJsRenderTask; getTextContent(): Promise<PdfJsTextContent>; cleanup?: () => void }
/** pdf.js 4/5 text layer: transparent, selectable text positioned over a page. */
type PdfJsTextLayerCtor = new (o: { textContentSource: PdfJsTextContent; container: HTMLElement; viewport: unknown }) => { render(): Promise<void> };
interface PdfJsLib { getDocument(o: { data: Uint8Array }): { promise: Promise<PdfJsDoc> }; TextLayer?: PdfJsTextLayerCtor }
interface PdfJsDoc { numPages: number; getPage(n: number): Promise<PdfJsPage>; destroy?: () => Promise<void> }

interface Attachment { file: TFile; label: string; key: string }
interface SectionData { node: TreeNode; file: TFile; text: string; atts: Attachment[] }
/** `open`: the form is expanded (0.548.0 — a section shows one "Add feedback"
 *  button until asked); `focus`: move focus into the form (or, collapsed, onto
 *  its button) on the next build; `parked`: what a closed draft was for (a
 *  reply, a pin), restored when it's reopened so the text isn't re-posted as
 *  plain top-level feedback. */
interface Draft {
  text: string; target: string; replyTo: StashpadId | null; pin: string | null; posting: boolean;
  open: boolean; focus: boolean;
  parked: { replyTo: StashpadId | null; target: string; pin: string | null; text: string } | null;
}
/** Toolbar counts over EVERY section of the level (not just the rendered ones):
 *  open = unresolved feedback, comments = all top-level feedback notes. */
interface BarTally { open: number; comments: number; approved: number; changes: number }
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
  /** 0.550.0: the comment box floating at a just-placed pin (inside mainEl),
   *  and what it was built for (rebuilt only when that changes). */
  pinBox: { el: HTMLElement; key: string } | null;
  /** The pin box had the caret when it went away for a rebuild (its section
   *  redrew, or a PDF's pages are being redrawn): give it back, with this
   *  selection, when the box returns. Only the pin box reads these. */
  pinFocus: boolean;
  pinSel: [number, number] | null;
  /** 0.551.0: the section's decision chip host (in the "This section" row). */
  statusEl: HTMLElement | null;
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

/** A draft's `pin` is the pin ("x,y[,page]"), then — for an area or an arrow
 *  (0.556.0) — "|" and its `feedbackShape`. One string on purpose: every place
 *  that drops a draft's pin drops its shape with it. */
function splitDraftPin(raw: string | null | undefined): { pin: string; shape: FeedbackShape | null } | null {
  if (!raw) return null;
  const bar = raw.indexOf("|");
  return bar < 0 ? { pin: raw, shape: null } : { pin: raw.slice(0, bar), shape: parseFeedbackShape(raw.slice(bar + 1)) };
}
/** What a draft's pin marks, in words: "spot", "area" or "arrow" (with an
 *  article when `article`). */
function spotWord(raw: string | null | undefined, article = false): string {
  const k = splitDraftPin(raw)?.shape?.kind;
  const w = k === "rect" ? "area" : k === "arrow" ? "arrow" : "spot";
  return article ? (w === "spot" ? "a spot" : `an ${w}`) : w;
}
/** The pin of a draft's `pin` (see splitDraftPin), parsed. */
function parseDraftPin(raw: string | null | undefined): ReturnType<typeof parseFeedbackPin> {
  const p = splitDraftPin(raw);
  return p ? parseFeedbackPin(p.pin) : null;
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
  /** Unsent feedback per section — kept on the LEAF (DRAFTS_BY_LEAF), so it
   *  survives this view being replaced and brought back with ←. */
  private drafts: Map<string, Draft>;
  /** Section whose composer is waiting for a click on an image to place a pin. */
  private pinPicking: string | null = null;
  /** The "click the spot" hint from a 📍 click, so a repeat click replaces it. */
  private pinHint: { hide(): void } | null = null;
  /** 0.556.0: what a DRAG draws while picking (a click is always a pin). */
  private pinTool: ShapeKind = "rect";
  /** A drag just placed a shape: swallow the click that follows the release
   *  (it would place a pin on top, or open the preview). */
  private suppressClickUntil = 0;
  /** Obscured (blurred) sections the user revealed in this tab, by id. */
  private revealed = new Set<string>();
  private renderTimer: number | null = null;
  /** A section to scroll to once a render has drawn it (a jump past the
   *  "Show more" cut). Kept until it's drawn — a render already under way may
   *  have sliced the sections before the limit grew — or until it's clearly
   *  not on this level; navigating replaces it. */
  private pendingScrollId: string | null = null;
  /** 0.554.3: a comment to light up (with its pin and file) once ITS
   *  section is landed on — never on some later, unrelated landing. */
  private pendingFlashComment: { section: string; comment: string } | null = null;
  /** 0.554.5: start a 📍 comment on this file of this section once drawn. */
  private pendingPinOn: { section: string; path: string; at: number } | null = null;
  /** The pending landing returns you to your place (back/forward, restore):
   *  no "you're here" highlight. */
  private landQuietly = false;
  /** Last section seen at the top of the view (kept while the tab is hidden,
   *  when nothing can be measured). */
  private lastInView: string | null = null;
  /** The drawn window: `limit` sections from index `start` (0.549.0). "Show
   *  more" / "Show earlier" grow it; a jump or a landing outside it moves it
   *  to the target's page, so the cost stays ~one page however big the level. */
  private start = 0;
  private limit = SECTION_PAGE;
  /** The note at `start`, so the window follows it (not its index). */
  private windowAnchor: string | null = null;
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
  /** 0.549.0: "you're inside a note that is itself a page" + a way out. */
  private noticeEl: HTMLElement | null = null;
  /** 0.549.0: "Show N earlier", when the drawn window starts part-way down. */
  private earlierEl: HTMLElement | null = null;
  /** Watches the main column of each section with a pin box (a lazy image
   *  above the pinned file can move it without resizing the page). */
  private pinBoxRo: ResizeObserver | null = null;
  /** After "Show N earlier": the section that was first on screen and its
   *  offset, restored once the sections above it are drawn. */
  private keepAnchor: { id: string; offset: number } | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) {
    super(leaf);
    // Cmd/Ctrl+F finds within the page (Obsidian's own search doesn't look
    // inside a custom view — captions, comments and PDF text).
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => { this.openFind(); return false; });
    // 0.554.4: undo / redo here too (a comment deleted from its menu says
    // "Undo to bring it back"). Text boxes keep their own native undo.
    const typing = (): boolean => { const a = activeDocument.activeElement; return !!a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || (a as HTMLElement).isContentEditable); };
    this.scope.register(["Mod"], "z", () => { if (typing()) return true; this.host?.cmdUndo(); return false; });
    this.scope.register(["Mod", "Shift"], "z", () => { if (typing()) return true; this.host?.cmdRedo(); return false; });
    // 0.554.1: a navigation view, so the tab's ← → (and mouse back/forward)
    // step through levels — Obsidian's Back refuses a non-navigation view (a
    // flag flipped only around goTo records the step but can't go back).
    // Like a PDF or canvas tab, other opens (Quick Switcher, …) may now land
    // here; links inside the page open in a new tab, unsent drafts live on the
    // LEAF so ← brings them back, and Obsidian's tab pin locks it.
    this.navigation = true;
    let kept = DRAFTS_BY_LEAF.get(leaf);
    if (!kept) { kept = new Map(); DRAFTS_BY_LEAF.set(leaf, kept); }
    for (const d of kept.values()) { d.posting = false; d.focus = false; } // a post can't still be in flight
    this.drafts = kept;
  }

  getViewType(): string { return STASHPAD_SHOWCASE_VIEW_TYPE; }
  getDisplayText(): string {
    const t = this.levelTitle();
    return t ? `Showcase — ${t}` : "Showcase";
  }
  getIcon(): string { return "presentation"; }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    addCopyTabLinkItem(menu, this.plugin, this.leaf);
    // 0.548.0: moved off the toolbar — the page updates by itself; this is
    // only an escape hatch (e.g. a file edited outside Obsidian).
    menu.addItem((i) => i.setTitle("Redraw the showcase").setIcon("refresh-cw").onClick(() => { this.resetSections(); this.scheduleRender(0); }));
  }

  getState(): Record<string, unknown> {
    // 0.554.1: the section in view rides along, so going back (or restoring
    // the tab) lands where you were, not at the top.
    // A landing that hasn't happened yet (background tab, host still loading)
    // is where you're going; at the very top there's nothing to return to.
    const atTop = !!this.scrollEl && this.scrollEl.isShown() && this.scrollEl.scrollTop < 4;
    const at = this.pendingScrollId ?? (atTop ? null : (this.sectionInView() ?? this.lastInView));
    return { ...super.getState(), folder: this.folder, focusId: this.focusId, layout: this.layout, hideResolved: this.hideResolved, ...(at ? { scrollTo: at } : {}) };
  }
  async setState(state: ShowcaseState, result: ViewStateResult): Promise<void> {
    if (state) {
      const nextFolder = "folder" in state ? (state.folder ?? null) : this.folder;
      const nextFocus = (state.focusId as StashpadId | null | undefined) ?? this.focusId;
      const first = this.folder === null; // the tab's first state (open / restore)
      const moved = nextFolder !== this.folder || nextFocus !== this.focusId;
      if (moved) {
        // 0.554.1: a level change inside the tab is a history step (← →).
        if (!first && result) result.history = true;
        this.resetSections(); this.start = 0; this.windowAnchor = null; this.limit = SECTION_PAGE; this.revealed.clear();
        this.pendingScrollId = null; this.lastInView = null; this.pendingFlashComment = null;
        this.pendingPinOn = null; this.pinPicking = null; this.pinHint?.hide(); this.pinHint = null;
        // Obsidian only saves the layout for a NEW view; a level change (and
        // back/forward) must save itself, or a quit reopens the old level.
        if (!first) this.persist();
      }
      this.folder = nextFolder ? nextFolder.replace(/\/+$/, "") : null;
      this.focusId = nextFocus || ROOT_ID;
      if (state.layout === "stack" || state.layout === "compare") this.layout = state.layout;
      if (typeof state.hideResolved === "boolean") this.hideResolved = state.hideResolved;
      // Only when arriving (open, restore, a level change, back/forward) or
      // asked to: a re-applied state on the same level mustn't yank the view.
      // 0.554.3: one-shot — light up this comment (and its pin) on arrival.
      if (typeof state.flashComment === "string" && state.flashComment && typeof state.scrollTo === "string") this.pendingFlashComment = { section: state.scrollTo, comment: state.flashComment };
      // 0.554.5: one-shot — start a 📍 comment on this file once its section is drawn.
      if (typeof state.pinOn === "string" && state.pinOn && typeof state.scrollTo === "string") this.pendingPinOn = { section: state.scrollTo, path: state.pinOn, at: Date.now() };
      if (typeof state.scrollTo === "string" && state.scrollTo && (first || moved || state.flash)) {
        this.pendingScrollId = state.scrollTo;
        this.landQuietly = state.flash !== true;
      }
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
    this.noticeEl = this.scrollEl.createDiv({ cls: "stashpad-showcase-notice" });
    this.noticeEl.hide();
    this.emptyEl = this.scrollEl.createDiv({ cls: "stashpad-showcase-empty" });
    this.earlierEl = this.scrollEl.createDiv({ cls: "stashpad-showcase-more is-earlier" });
    this.earlierEl.hide();
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
    // 0.550.0: hovering (or tabbing to) a comment lights up its pin and the
    // option it's about; hovering a pin lights up its comment.
    // 0.554.1: remember the section at the top, so a save while the tab is
    // hidden (nothing measurable) still knows where you were.
    let seenTimer: number | null = null;
    // The user taking over (wheel, touch, keys) cancels a quiet landing that
    // hasn't happened yet — it must never yank the view later.
    const takeOver = (): void => { if (this.pendingScrollId && this.landQuietly) this.pendingScrollId = null; };
    this.registerDomEvent(this.scrollEl, "wheel", takeOver, { passive: true });
    this.registerDomEvent(this.scrollEl, "touchstart", takeOver, { passive: true });
    this.registerDomEvent(this.scrollEl, "keydown", takeOver);
    this.registerDomEvent(this.scrollEl, "scroll", () => {
      if (seenTimer !== null) return;
      seenTimer = window.setTimeout(() => { seenTimer = null; this.lastInView = (this.scrollEl?.scrollTop ?? 0) < 4 ? null : (this.sectionInView() ?? this.lastInView); }, 200);
    });
    const page = this.pageEl;
    this.registerDomEvent(page, "mouseover", (e) => this.linkHover(e.target));
    this.registerDomEvent(page, "focusin", (e) => this.linkHover(e.target));
    this.registerDomEvent(page, "mouseleave", () => this.linkHover(null));
    this.registerDomEvent(page, "focusout", (e) => {
      // Only when focus went somewhere outside the page (not to "nowhere":
      // the pointer may still be on the comment).
      const to = e.relatedTarget as Node | null;
      if (to && !page.contains(to)) this.linkHover(null);
    });
    // A pin box is positioned in pixels: follow the page as images load,
    // the window resizes or the layout switches.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.positionPinBoxes());
      ro.observe(page);
      this.pinBoxRo = ro;
      this.register(() => { ro.disconnect(); this.pinBoxRo = null; });
    }
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
      if (this.noticeEl) { this.noticeEl.hide(); delete this.noticeEl.dataset.key; }
      if (this.earlierEl) { this.earlierEl.hide(); delete this.earlierEl.dataset.start; }
      this.renderBar([], { open: 0, comments: 0, approved: 0, changes: 0 });
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
    // Keep the window on the same notes when notes above it come or go (by
    // position, a deletion above would push the section you're typing in out).
    if (this.start > 0 && this.windowAnchor) {
      const at = nodes.findIndex((n) => n.id === this.windowAnchor);
      if (at >= 0) this.start = at;
    }
    // A target outside the drawn window: move the window to its page (one
    // page of sections, not everything between — nothing here is virtualised).
    if (this.pendingScrollId) {
      const at = nodes.findIndex((n) => n.id === this.pendingScrollId);
      if (at >= 0 && (at < this.start || at >= this.start + this.limit)) { this.start = Math.floor(at / SECTION_PAGE) * SECTION_PAGE; this.limit = SECTION_PAGE; this.windowAnchor = null; }
    }
    if (this.start && this.start >= nodes.length) this.start = Math.floor(Math.max(0, nodes.length - 1) / SECTION_PAGE) * SECTION_PAGE; // the level shrank
    if (this.start < 0) this.start = 0; // backstop
    const start = this.start;
    this.windowAnchor = start > 0 ? (nodes[start]?.id ?? null) : null;
    const sections: SectionData[] = [];
    for (const node of nodes.slice(start, start + this.limit)) sections.push(await this.readSection(node));

    const tally: BarTally = { open: 0, comments: 0, approved: 0, changes: 0 };
    for (const n of nodes) {
      const st = sectionStatus(readReactions(this.fmOf(n.file)));
      if (st === "approved") tally.approved++; else if (st === "changes") tally.changes++;
      for (const c of host.tree.getChildren(n.id)) {
        if (!c.file || !this.isComment(c)) continue; // pages aren't feedback
        tally.comments++;
        if (!this.isResolved(c)) tally.open++;
      }
    }
    this.renderBar(sections, tally, nodes.length, start);

    const noticed = this.renderNotice(host, nodes.length);
    this.emptyEl.toggle(sections.length === 0 && !noticed);
    if (!sections.length) this.emptyEl.setText("Nothing here yet. Each note at this level shows as a page: add notes with images or files to this level in the list.");

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
        c = { root, mainEl, asideEl, mainSig: "", asideSig: "", mainComp: this.addChild(new Component()), asideComp: this.addChild(new Component()), bars: new Map(), pinHosts: new Map(), pinBox: null, pinFocus: false, pinSel: null, statusEl: null };
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
      if (mainSig !== c.mainSig) {
        // The pin box lives inside mainEl: keep its caret across the rebuild.
        const a = activeDocument.activeElement;
        if (c.pinBox && a?.instanceOf(HTMLTextAreaElement) && c.pinBox.el.contains(a)) {
          c.pinFocus = true;
          c.pinSel = [a.selectionStart, a.selectionEnd];
        }
        this.renderMain(c, s, start + i); c.mainSig = mainSig;
      }
      const num = c.mainEl.querySelector(".stashpad-showcase-sec-num");
      if (num && num.textContent !== String(start + i + 1)) num.textContent = String(start + i + 1);
      this.renderBars(c, s);
      this.updateStatus(c, s);
      const comments = host.tree.getChildren(s.node.id).filter((n) => n.file);
      const draft = this.drafts.get(s.node.id);
      const asideSig = this.asideSignature(comments, host) + `\u0000${this.hideResolved}\u0000${veiled}\u0000${draft?.posting ?? false}\u0000${s.atts.map((a) => a.file.path).join("|")}\u0000${this.pinBoxShown(c, s)}`;
      if (asideSig !== c.asideSig) { this.renderAside(c, s, comments); c.asideSig = asideSig; }
      this.renderPins(c, s, comments);
      this.updateDrill(c, comments);
      this.renderPinBox(c, s, comments);
      this.updateFeedbackJump(c, comments);
    });
    this.scheduleFind(true);
    if (this.pendingPinOn) {
      const want = this.pendingPinOn;
      const s = sections.find((x) => x.node.id === want.section);
      if (s) {
        if (this.settlePinOn(s, want)) this.pendingPinOn = null;
      } else if (want.section === this.focusId) this.pendingPinOn = null; // the level itself
      else if (host.tree.get(want.section) && levelOf(host.tree, want.section) !== this.focusId) this.pendingPinOn = null; // lives on another level
      else if (!host.tree.get(want.section) && nodes.length) this.pendingPinOn = null; // gone
    }
    if (this.keepAnchor) {
      const a = this.keepAnchor;
      this.keepAnchor = null;
      const r = this.cache.get(a.id)?.root;
      if (r?.isConnected && this.scrollEl) this.scrollEl.scrollTop += (r.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top) - a.offset;
    }
    if (this.pendingScrollId) {
      const root = this.cache.get(this.pendingScrollId)?.root;
      if (root?.isConnected) { this.pendingScrollId = null; this.land(root, !this.landQuietly); this.landQuietly = false; }
      // The level itself, or a note here that can't be drawn (no file): nothing to land on.
      else if (this.pendingScrollId === this.focusId || (host.tree.get(this.pendingScrollId) && levelOf(host.tree, this.pendingScrollId) === this.focusId && !nodes.some((n) => n.id === this.pendingScrollId))) { this.pendingScrollId = null; this.pendingFlashComment = null; }
      else {
        // Drop it only once it's known to live under another level; a tree
        // still filling in may simply not have it yet.
        if (host.tree.get(this.pendingScrollId) && levelOf(host.tree, this.pendingScrollId) !== this.focusId) { this.pendingScrollId = null; this.pendingFlashComment = null; }
        // A quiet return to a section that no longer exists (tree loaded).
        else if (this.landQuietly && nodes.length && !host.tree.get(this.pendingScrollId)) this.pendingScrollId = null;
      }
    }
    // Kept (not rebuilt) while its words don't change, so a focused button
    // keeps focus through background redraws; always the page's last child.
    const left = nodes.length - start - sections.length;
    const moreText = left > 0 ? `Show ${Math.min(SECTION_PAGE, left)} more (${left} below)` : "";
    let moreEl = this.pageEl.querySelector<HTMLElement>(":scope > .stashpad-showcase-more");
    if (moreEl && (moreEl.dataset.text !== moreText || !moreText)) { moreEl.remove(); moreEl = null; }
    if (moreText) {
      if (!moreEl) {
        moreEl = this.pageEl.createDiv({ cls: "stashpad-showcase-more" });
        moreEl.dataset.text = moreText;
        const b = moreEl.createEl("button", { text: moreText });
        b.onclick = () => { this.limit += SECTION_PAGE; this.scheduleRender(0); };
      } else if (moreEl !== this.pageEl.lastElementChild) this.pageEl.appendChild(moreEl);
    }
    // 0.549.0: the window can start part-way down (a landing or a jump).
    const earlier = this.earlierEl;
    if (earlier && earlier.dataset.start !== String(start)) {
      earlier.dataset.start = String(start);
      earlier.empty();
      earlier.toggle(start > 0);
      if (start > 0) {
        const n = Math.min(SECTION_PAGE, start);
        const b = earlier.createEl("button", { text: `Show ${n} earlier (${start} above)` });
        b.onclick = () => {
          // Clamped: the button lives until the next render finishes, so a
          // double-click (or a click mid-render) must not go below 0.
          const s0 = Math.max(0, this.start - n);
          this.limit += this.start - s0; this.start = s0;
          this.windowAnchor = null; // a deliberate move
          // Keep the section you were reading where it is on screen.
          const first = this.pageEl?.querySelector<HTMLElement>(":scope > .stashpad-showcase-section");
          if (first?.dataset.id && this.scrollEl) this.keepAnchor = { id: first.dataset.id, offset: first.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top };
          this.scheduleRender(0);
        };
      }
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
        const meta = fm ? [fm.completed === true, fm.task === true, "completed" in fm, String(fm.author ?? ""), String(fm.feedbackOn ?? ""), String(fm.feedbackPin ?? ""), String(fm.feedbackShape ?? ""), String(fm.created ?? "")].join("|") : "?";
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
    if (c.pinBox) { c.pinBox.el.remove(); c.pinBox = null; this.pinBoxRo?.unobserve(c.mainEl); }
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
  /** 0.551.1: a COMMENT (feedback to resolve) rather than a page under the
   *  section: written by the Showcase / aimed at a file, or a to-do, or a
   *  plain note with no files and nothing under it. A note with its own files
   *  or notes under it is a page ("Notes under it") — never counted as
   *  feedback, and offers no Resolve (that would check off a real page). */
  private isComment(n: TreeNode): boolean {
    if (!n.file) return false;
    if (isFeedbackNote(this.app, n)) return true;
    const fm = this.fmOf(n.file);
    if (fm && (fm.task === true || "completed" in fm)) return true;
    if (noteEmbedsFiles(this.app, n)) return false;
    // Notes under it make it a page only if THEY look like pages (a picture,
    // or notes of their own) — a plain reply under a comment doesn't.
    const tree = this.host?.tree;
    if (!tree) return true;
    return !tree.getChildren(n.id).some((k) => k.file && !isFeedbackNote(this.app, k)
      && (noteEmbedsFiles(this.app, k) || tree.getChildren(k.id).some((g) => g.file)));
  }

  /** 0.548.0: "to resolve" = a comment (see isComment) not marked resolved.
   *  (Cheap check first: isComment reads links and children.) */
  private isUnresolved(n: TreeNode): boolean { return !!n.file && !this.isResolved(n) && this.isComment(n); }

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

  private renderBar(sections: SectionData[], tally: BarTally, total = sections.length, start = 0): void {
    const bar = this.barEl!;
    // 0.551.1: rebuilt only when something it shows changes, so a focused
    // toolbar button (e.g. "Next ↓" pressed from the keyboard) keeps focus.
    const h0 = this.host;
    const crumbKey = h0 && this.focusId !== ROOT_ID ? h0.tree.pathTo(this.focusId).map((n) => `${n.id}:${h0.titleForNode(n)}`).join("/") : "";
    const into = this.drillTargets();
    const sig = JSON.stringify([this.folder, crumbKey, total, start, sections.length, sections.reduce((n, x) => n + x.atts.length, 0), sections.some((x) => x.atts.length > 1), tally, this.layout, this.hideResolved, into]);
    if (bar.dataset.sig === sig && bar.childElementCount) return;
    bar.dataset.sig = sig;
    // When it must rebuild (e.g. "Next ↓" moved the window, so the range
    // changed), give focus back to the same control afterwards.
    const was = activeDocument.activeElement;
    const role = was && bar.contains(was) ? (was as HTMLElement).dataset.role ?? null : null;
    bar.empty();
    if (role) window.setTimeout(() => bar.querySelector<HTMLElement>(`[data-role="${role}"]`)?.focus({ preventScroll: true }), 0);
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
      // Back up a level lands on the section you came from.
      if (!last) el.onclick = () => this.goTo(c.id, chain[i + 1]?.id ?? null);
    });
    // 0.554.1: the way IN from the crumbs — the sections here that have notes
    // of their own (not just comments). One: its name; several: a menu.
    if (into.length) {
      crumbs.createSpan({ cls: "stashpad-showcase-crumb-sep", text: "›" });
      if (into.length === 1) {
        const t = into[0];
        const el = crumbs.createSpan({ cls: "stashpad-showcase-crumb is-into", text: t.title, attr: { role: "button", tabindex: "0", "data-role": "into", "aria-label": `Go into “${t.title}” (${t.count} note${t.count === 1 ? "" : "s"})` } });
        el.onclick = () => this.goTo(t.id);
        el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.goTo(t.id); } });
      } else {
        const b = crumbs.createEl("button", { cls: "stashpad-showcase-crumb is-into", text: `${into.length} levels ▾`, attr: { "data-role": "into", "aria-haspopup": "menu", "aria-label": `${into.length} levels: go into one of the notes here that have notes of their own` } });
        b.onclick = () => {
          const m = new Menu();
          for (const t of into) m.addItem((it) => it.setTitle(`${t.title} · ${t.count} note${t.count === 1 ? "" : "s"}`).setIcon("corner-down-right").onClick(() => this.goTo(t.id)));
          const r = b.getBoundingClientRect();
          m.showAtPosition({ x: r.left, y: r.bottom + 4 }, b.doc);
        };
      }
    }

    const atts = sections.reduce((n, s) => n + s.atts.length, 0);
    const shownNote = total > sections.length ? (start ? ` (${start + 1}–${start + sections.length} shown)` : ` (first ${sections.length} shown)`) : "";
    bar.createSpan({ cls: "stashpad-showcase-count", text: `${total} section${total === 1 ? "" : "s"}${shownNote} · ${atts} file${atts === 1 ? "" : "s"}` });
    // 0.548.0: the feedback status says what clicking it does ("Next ↓"), and
    // tells "nothing left to resolve" apart from "nothing posted yet".
    if (tally.open) {
      const openEl = bar.createEl("button", { cls: "stashpad-showcase-open has-open", attr: { "data-role": "next-open", "aria-label": `${tally.open} to resolve. Next: jump to the next section with feedback to resolve` } });
      openEl.createSpan({ text: `${tally.open} to resolve` });
      openEl.createSpan({ text: "·", attr: { "aria-hidden": "true" } });
      openEl.createSpan({ cls: "stashpad-showcase-open-next", text: "Next ↓" });
      openEl.onclick = () => this.jumpToNextOpen();
    } else {
      bar.createSpan({ cls: "stashpad-showcase-open" + (tally.comments ? " is-done" : ""), text: tally.comments ? "Nothing left to resolve" : "No feedback yet" });
    }

    // 0.551.0: review progress across the whole level; click for a list of
    // every section with its decision, to jump straight to one.
    if (total) {
      const prog = bar.createEl("button", { cls: "stashpad-showcase-btn stashpad-showcase-progress" + (tally.approved === total ? " is-complete" : ""), attr: { "data-role": "progress", "aria-haspopup": "menu" } });
      setIcon(prog.createSpan(), "check-circle-2");
      const shown = `${tally.approved} of ${total} approved`;
      const changes = tally.changes ? `${tally.changes} need${tally.changes === 1 ? "s" : ""} changes` : "";
      prog.createSpan({ text: shown });
      if (changes) prog.createSpan({ cls: "stashpad-showcase-progress-changes stashpad-showcase-btn-text", text: `· ${changes}` });
      prog.setAttr("aria-label", `${shown}${changes ? `, ${changes}` : ""}: see every section's decision and jump to one`);
      prog.onclick = () => this.openSectionsMenu(prog);
    }

    const spacer = bar.createDiv({ cls: "stashpad-showcase-spacer" });
    spacer.setAttr("aria-hidden", "true");

    // Stack / Side by side only changes sections with 2+ files — hide it when
    // there are none (it looked like a broken control on single-image pages).
    if (sections.some((s) => s.atts.length > 1)) {
      const seg = bar.createDiv({ cls: "stashpad-showcase-seg", attr: { role: "group", "aria-label": "How to lay out a section's options" } });
      for (const [val, label, icon, tip] of [["stack", "Stack", "rows-3", "Stack: options one under another"], ["compare", "Side by side", "columns-2", "Side by side: options next to each other"]] as Array<[Layout, string, string, string]>) {
        const b = seg.createEl("button", { cls: "stashpad-showcase-segbtn" + (this.layout === val ? " is-active" : ""), attr: { "data-role": `layout-${val}`, "aria-pressed": String(this.layout === val), "aria-label": tip } });
        setIcon(b.createSpan(), icon);
        b.createSpan({ text: label });
        b.onclick = () => { if (this.layout === val) return; this.layout = val; this.persist(); this.applyLayout(); this.renderBar(sections, tally, total, start); };
      }
    }

    // A steady label with an on/off state (it used to flip between "Hide
    // resolved" and "Show resolved", so the words never said which was on).
    if (tally.comments || this.hideResolved) {
      // The name stays "Hide resolved"; aria-pressed carries on/off.
      const resolvedBtn = bar.createEl("button", { cls: "stashpad-showcase-btn stashpad-showcase-toggle" + (this.hideResolved ? " is-active" : ""), attr: { "data-role": "hide-resolved", "aria-pressed": String(this.hideResolved), "aria-label": "Hide resolved" } });
      setIcon(resolvedBtn.createSpan(), this.hideResolved ? "square-check" : "square");
      resolvedBtn.createSpan({ text: "Hide resolved" });
      resolvedBtn.onclick = () => { this.hideResolved = !this.hideResolved; this.persist(); this.scheduleRender(0); };
    }

    const findBtn = bar.createEl("button", { cls: "stashpad-showcase-btn clickable-icon", attr: { "data-role": "find", "aria-label": `Find in this page (${Platform.isMacOS ? "⌘F" : "Ctrl+F"})` } });
    setIcon(findBtn, "search");
    findBtn.onclick = () => this.openFind();

    // 0.548.0: Export + Copy link were two unlabeled-looking buttons; they're
    // both "send this to someone", so one Share menu holds them.
    const shareBtn = bar.createEl("button", { cls: "stashpad-showcase-btn", attr: { "data-role": "share", "aria-label": "Share: copy a link or export a web page", "aria-haspopup": "menu" } });
    setIcon(shareBtn.createSpan(), "share-2");
    shareBtn.createSpan({ text: "Share" });
    shareBtn.onclick = () => {
      const m = new Menu();
      // 0.533.0: a deep link straight to this page — paste it in chat/email and
      // the reviewer lands on the same Showcase level.
      m.addItem((i) => i.setTitle("Copy link to this showcase").setIcon("link").onClick(() => { void this.plugin.copyLinkForLeaf(this.leaf); }));
      m.addItem((i) => i.setTitle("Export as a web page… (no Obsidian needed)").setIcon("download").onClick(() => new ShowcaseExportModal(this.app, (o) => void this.runExport(o.includeFeedback)).open()));
      // Anchored to the button (a keyboard "click" has no useful mouse position).
      const r = shareBtn.getBoundingClientRect();
      m.showAtPosition({ x: r.left, y: r.bottom + 4 }, shareBtn.doc);
    };

    const listBtn = bar.createEl("button", { cls: "stashpad-showcase-btn", attr: { "data-role": "open-in-list", "aria-label": "Open in list: show the section you're looking at in the list view" } });
    setIcon(listBtn.createSpan(), "list-tree");
    listBtn.createSpan({ cls: "stashpad-showcase-btn-text", text: "Open in list" });
    // 0.549.0: back to the list ON the section you were looking at (a
    // highlighted row in this level), not just the level.
    listBtn.onclick = () => {
      if (!this.folder) return;
      const id = this.sectionInView();
      if (id) void this.plugin.revealRowByRef(this.folder, id);
      else void this.plugin.revealNoteByRef(this.folder, this.focusId);
    };
  }

  private applyLayout(): void {
    this.pageEl?.querySelectorAll<HTMLElement>(".stashpad-showcase-atts").forEach((el) => {
      el.toggleClass("is-compare", this.layout === "compare");
      el.toggleClass("is-stack", this.layout !== "compare");
    });
  }

  /** Change level. 0.554.1: through the leaf, so it's a step in the tab's
   *  history (← → in the tab header); setState does the reset. */
  private goTo(id: StashpadId, scrollTo: StashpadId | null = null): void {
    const state: ShowcaseState = { folder: this.folder, focusId: id, layout: this.layout, hideResolved: this.hideResolved, scrollTo, flash: !!scrollTo };
    void this.leaf.setViewState({ type: STASHPAD_SHOWCASE_VIEW_TYPE, active: true, state: state as Record<string, unknown> });
  }

  private persist(): void { this.app.workspace.requestSaveLayout(); }

  /** Next section (below the current scroll position, wrapping) with
   *  something to resolve — including sections past the "Show more" cut,
   *  which are drawn first (0.548.0: the button says "Next", so it must go). */
  private jumpToNextOpen(): void {
    const host = this.host;
    if (!host || !this.scrollEl) return;
    const ids = host.tree.getChildren(this.focusId).filter((n) => n.file && host.tree.getChildren(n.id).some((k) => this.isUnresolved(k))).map((n) => n.id);
    if (!ids.length) return;
    const top = this.scrollEl.scrollTop;
    // Page order: drawn sections come first, so an undrawn one is reached only
    // once every drawn open section is above the current position.
    const order = host.tree.getChildren(this.focusId).filter((n) => n.file).map((n) => n.id);
    const end = this.start + this.limit;
    // Below the current position: a drawn section further down, else the
    // first undrawn one after the window; else wrap to the first.
    const next = ids.find((id) => {
      const at = order.indexOf(id);
      if (at < this.start) return false;
      const el = this.cache.get(id)?.root;
      return el?.isConnected ? el.offsetTop > top + 8 : at >= end;
    }) ?? ids[0];
    this.goToSection(next);
  }

  /** Scroll to a section of this level, drawing more sections first when it's
   *  past the "Show more" cut. */
  private goToSection(id: StashpadId): void {
    const root = this.cache.get(id)?.root;
    if (root?.isConnected) { this.pendingScrollId = null; this.land(root); return; }
    if (!this.host?.tree.getChildren(this.focusId).some((n) => n.id === id)) { if (this.pendingFlashComment?.section === id) this.pendingFlashComment = null; return; }
    this.pendingScrollId = id; // renderOnce draws down to it, then lands
    this.landQuietly = false;
    this.scheduleRender(0);
  }

  /** Arrive on a section. Instant, then re-asserted twice while images and
   *  PDFs above it finish loading (they push it down), unless the user has
   *  scrolled since. A short highlight says "you're here". */
  private land(root: HTMLElement, highlight = true): void {
    const sc = this.scrollEl;
    if (!sc) return;
    root.scrollIntoView({ block: "start" });
    let last = sc.scrollTop;
    for (const t of [350, 1000]) {
      window.setTimeout(() => {
        if (!root.isConnected || Math.abs(sc.scrollTop - last) > 2) return; // user moved
        root.scrollIntoView({ block: "start" });
        last = sc.scrollTop;
      }, t);
    }
    const flash = this.pendingFlashComment;
    if (flash && flash.section === root.dataset.id) {
      // Let the landing scroll settle, then go to the comment's spot; if it
      // can't be shown (hidden by "Hide resolved"), highlight the section.
      this.pendingFlashComment = null;
      window.setTimeout(() => { void this.revealComment(flash.comment).then((ok) => { if (!ok && root.isConnected) this.highlightSection(root); }); }, 450);
      return;
    }
    if (!highlight) return;
    this.highlightSection(root);
  }

  private highlightSection(root: HTMLElement): void {
    root.removeClass("is-landed"); void root.offsetWidth; root.addClass("is-landed");
    window.setTimeout(() => root.removeClass("is-landed"), 1800);
  }

  /** Public: open on a section from outside (an existing tab reused by
   *  openShowcaseView). */
  landOn(id: StashpadId, flashComment: StashpadId | null = null, pinOn: string | null = null): void {
    this.pendingFlashComment = flashComment ? { section: id, comment: flashComment } : null;
    if (pinOn) { this.pendingPinOn = { section: id, path: pinOn, at: Date.now() }; this.scheduleRender(0); }
    // A tab just woken from the background may not have its list tab (host)
    // bound yet: keep the target for the first render that has it.
    if (!this.host) { this.pendingScrollId = id; this.landQuietly = false; this.scheduleRender(0); return; }
    this.goToSection(id);
  }

  /** 0.554.3: show one comment where it lives: ONE scroll, to the spot it's
   *  pinned on (its file / PDF page, flashed; waits up to ~3 s for a PDF page
   *  to be drawn), then the comment flashes and its pin lights, without a
   *  second scroll fighting the first. A veiled (hidden) comment only flashes
   *  itself — its file and pin stay private. Resolves false when there's
   *  nothing to show (e.g. hidden by "Hide resolved"). */
  private async revealComment(id: string): Promise<boolean> {
    const n = this.host?.tree.get(id);
    for (const [sid, c] of this.cache) {
      const item = Array.from(c.asideEl.querySelectorAll<HTMLElement>(".stashpad-showcase-comment")).find((x) => x.dataset.id === id);
      if (!item) continue;
      const fm = n?.file ? this.fmOf(n.file) : undefined;
      const target = n?.file && !item.hasClass("is-veiled") ? resolveFeedbackTarget(this.app, fm, n.file.path) : null;
      const pin = target ? parseFeedbackPin(fm?.feedbackPin) : null;
      if (target) {
        if (pin?.page) {
          for (let t = 0; t < 12 && !c.mainEl.querySelector(`.stashpad-showcase-pdfpage[data-page="${pin.page}"]`); t++) {
            await new Promise((r) => window.setTimeout(r, 250));
            if (!item.isConnected) return false;
          }
        }
        // 0.556.0: a box / arrow is shown itself (centred, lit); a pin, its file.
        if (!this.revealShape(c, id)) this.flashAttachment(sid, target.path, pin?.page);
        this.flashComment(c, id, false);
      } else this.flashComment(c, id, true);
      for (const d of Array.from(c.mainEl.querySelectorAll<HTMLElement>(".stashpad-showcase-pin[data-id]"))) {
        if (d.dataset.id !== id) continue;
        d.addClass("is-hot");
        window.setTimeout(() => d.removeClass("is-hot"), 2400);
      }
      return true;
    }
    return false;
  }

  /** 0.549.0: the section at the top of the viewport — what "Open in list"
   *  takes you back to. */
  private sectionInView(): StashpadId | null {
    const sc = this.scrollEl;
    if (!sc || !this.pageEl) return null;
    const top = sc.getBoundingClientRect().top + 40;
    for (const el of Array.from(this.pageEl.children)) {
      if (el.instanceOf(HTMLElement) && el.hasClass("stashpad-showcase-section") && el.getBoundingClientRect().bottom > top) return el.dataset.id ?? null;
    }
    return null;
  }

  /** 0.549.0: inside a note that is itself a page (see showcaseLanding) —
   *  e.g. a tab restored or a link opened on it — say so, in words that fit
   *  the reason, with the way out: the level it's a page of, scrolled to it.
   *  Returns whether the notice is showing. */
  private renderNotice(host: StashpadView, count: number): boolean {
    const el = this.noticeEl;
    if (!el) return false;
    const land = this.focusId === ROOT_ID ? null : showcaseLanding(this.app, host.tree, this.focusId, null);
    const title = Array.from(this.levelTitle() || "this note").slice(0, 40).join("");
    const key = land?.reason ? `${this.focusId}|${count}|${land.reason}|${land.focusId}|${land.scrollTo}|${title}` : "";
    if (el.dataset.key === key) return !!key;
    el.dataset.key = key;
    el.empty();
    if (!key || !land) { el.hide(); return false; }
    setIcon(el.createSpan({ cls: "stashpad-showcase-notice-icon" }), "info");
    // Climbed out of a comment: name the page it's about, not the comment.
    const climbed = land.scrollTo !== this.focusId;
    const pageNode = climbed && land.scrollTo ? host.tree.get(land.scrollTo) : null;
    const pageTitle = pageNode ? (Array.from(host.titleForNode(pageNode).trim()).slice(0, 40).join("") || "Untitled") : title;
    el.createSpan({ text: climbed ? `You're inside a comment on “${pageTitle}”.`
      : land.reason === "empty" ? `“${title}” has nothing under it to show as pages.`
      : land.reason === "comments" ? `You're inside “${title}”, so its comments show here as pages.`
      : `You're inside “${title}”. Its own files only show on the page above it.` });
    const b = el.createEl("button", { cls: "mod-cta", text: !climbed && land.reason === "files" ? `Show “${title}” with its files` : `Show “${pageTitle}” as a page` });
    const target = land.scrollTo;
    b.onclick = () => this.goTo(land.focusId, target);
    el.show();
    return true;
  }

  /** 0.554.1: sections at this level you can go INTO — they have notes of
   *  their own besides Showcase feedback. Hidden notes keep their title hidden. */
  /** A note under a section that could be a page of its own: not Showcase
   *  feedback, and not a to-do (those are comments to resolve). */
  private isPageish(k: TreeNode): boolean {
    if (!k.file || isFeedbackNote(this.app, k)) return false;
    const fm = this.fmOf(k.file);
    return !(fm && (fm.task === true || "completed" in fm));
  }

  private drillTargets(): Array<{ id: StashpadId; title: string; count: number }> {
    const h = this.host;
    if (!h) return [];
    const out: Array<{ id: StashpadId; title: string; count: number }> = [];
    for (const n of h.tree.getChildren(this.focusId)) {
      if (!n.file) continue;
      const count = h.tree.getChildren(n.id).filter((k) => this.isPageish(k)).length;
      if (!count) continue;
      const title = this.veiled(n) ? "Hidden note" : (Array.from(h.titleForNode(n).trim()).slice(0, 40).join("") || "Untitled");
      out.push({ id: n.id, title, count });
    }
    return out;
  }

  /** 0.549.0: keep a section's "Notes under it" button current: the notes
   *  under it that aren't feedback (those are its pages, if it's a level). */
  private updateDrill(c: SectionCache, comments: TreeNode[]): void {
    const b = c.mainEl.querySelector<HTMLElement>(".stashpad-showcase-drill");
    if (!b) return;
    // Every note under it that the Showcase didn't write as feedback — the
    // way down for text-only pages too (broader than "not a comment").
    const n = comments.filter((k) => this.isPageish(k)).length;
    const text = `Go in (${n})`;
    b.toggle(n > 0);
    const t = b.querySelector(".stashpad-showcase-drill-text");
    if (t && t.textContent !== text) t.textContent = text;
    b.setAttr("aria-label", `Go in: show the ${n} note${n === 1 ? "" : "s"} under this section as pages`);
  }

  // ---------------------------------------------------------------- main column

  private renderMain(c: SectionCache, s: SectionData, index: number): void {
    this.removeChild(c.mainComp);
    c.mainComp = this.addChild(new Component());
    c.bars.clear();
    c.pinHosts.clear();
    const el = c.mainEl;
    el.empty();

    // 0.548.0 layout (a grid, see styles.css): the number sits in a left
    // gutter beside the title, like a page number; the tools sit at the
    // title's right; THIS section's reactions come right under the title,
    // above the files. They used to sit under the last option, where they read
    // as that option's own.
    el.createDiv({ cls: "stashpad-showcase-sec-num", text: String(index + 1) });
    const tools = el.createDiv({ cls: "stashpad-showcase-sec-tools" });
    // 0.549.0: the way DOWN — this section's own notes (not its comments) as
    // pages. Shown only when it has some (updateDrill, every pass).
    const drill = tools.createEl("button", { cls: "stashpad-showcase-toolbtn stashpad-showcase-drill" });
    setIcon(drill.createSpan(), "layers");
    drill.createSpan({ cls: "stashpad-showcase-drill-text stashpad-showcase-btn-text" });
    drill.onclick = () => this.goTo(s.node.id);
    drill.hide();
    // 0.550.0: in a narrow pane the feedback column drops below every file;
    // this chip (shown only then, by CSS) jumps to it. Text is kept current by
    // updateFeedbackJump on every pass.
    const jump = tools.createEl("button", { cls: "stashpad-showcase-toolbtn stashpad-showcase-fbjump" });
    setIcon(jump.createSpan(), "message-square");
    jump.createSpan({ cls: "stashpad-showcase-fbjump-text" });
    jump.createSpan({ cls: "stashpad-showcase-fbjump-more stashpad-showcase-btn-text" });
    jump.onclick = () => {
      c.asideEl.scrollIntoView({ behavior: "smooth", block: "start" });
      // Keyboard / screen-reader users follow it too.
      c.asideEl.querySelector<HTMLElement>(".stashpad-showcase-addfb, textarea, .stashpad-showcase-composer.is-pinned button")?.focus({ preventScroll: true });
    };
    const reveal = tools.createEl("button", { cls: "stashpad-showcase-toolbtn", attr: { "aria-label": "Open in list: show this section in the list view" } });
    setIcon(reveal.createSpan(), "list-tree");
    reveal.createSpan({ cls: "stashpad-showcase-btn-text", text: "Open in list" });
    reveal.onclick = () => { if (this.folder) void this.plugin.revealRowByRef(this.folder, s.node.id); };
    if (s.atts.length && !this.veiled(s.node)) { // a hidden note's files stay hidden
      const all = tools.createEl("button", { cls: "stashpad-showcase-toolbtn", attr: { "aria-label": s.atts.length > 1 ? "Full size: view the files one after another" : "Full size: view the file" } });
      setIcon(all.createSpan(), "maximize-2");
      all.createSpan({ cls: "stashpad-showcase-btn-text", text: "Full size" });
      all.onclick = () => this.openViewer(s, 0);
    }
    const sectionBar = (): void => {
      const row = el.createDiv({ cls: "stashpad-showcase-sec-bar" });
      row.createSpan({ cls: "stashpad-showcase-sec-bar-label", text: "This section" });
      c.bars.set("", row.createDiv({ cls: "stashpad-showcase-reactions is-section" }));
      // 0.551.0: the decision these reactions add up to (+ the picked option),
      // filled by updateStatus on every pass.
      c.statusEl = row.createDiv({ cls: "stashpad-showcase-status" });
    };

    // Respect the list's "obscured" blur: a hidden note stays hidden here until
    // the user chooses to show it (this tab only; nothing is written).
    if (this.veiled(s.node)) {
      const veil = el.createDiv({ cls: "stashpad-showcase-veil" });
      setIcon(veil.createSpan(), "eye-off");
      veil.createSpan({ text: `Hidden note${s.atts.length ? ` · ${s.atts.length} file${s.atts.length === 1 ? "" : "s"}` : ""}` });
      const show = veil.createEl("button", { text: "Show" });
      show.onclick = () => { this.revealed.add(s.node.id); const c2 = this.cache.get(s.node.id); if (c2) c2.mainSig = ""; this.scheduleRender(0); };
      sectionBar();
      return;
    }

    if (s.text) {
      const cap = el.createDiv({ cls: "stashpad-showcase-caption markdown-rendered" });
      void MarkdownRenderer.render(this.app, s.text, cap, s.file.path, c.mainComp);
      this.wireLinks(cap, s.file.path);
    }

    // Section-level reactions (the note's own `reactions`, shown in the list too).
    sectionBar();

    if (s.atts.length) {
      const wrap = el.createDiv({ cls: "stashpad-showcase-atts " + (this.layout === "compare" ? "is-compare" : "is-stack") });
      if (s.atts.length === 1) wrap.addClass("is-single");
      s.atts.forEach((a, i) => this.renderAttachment(wrap, c, s, a, i));
    }
  }

  private renderAttachment(wrap: HTMLElement, c: SectionCache, s: SectionData, a: Attachment, i: number): void {
    const card = wrap.createDiv({ cls: "stashpad-showcase-att" });
    card.dataset.path = a.file.path;
    const head = card.createDiv({ cls: "stashpad-showcase-att-head" });
    if (a.label) head.createSpan({ cls: "stashpad-showcase-att-label", text: a.label });
    head.createSpan({ cls: "stashpad-showcase-att-name", text: a.file.name });
    // 0.534.0: pin straight from the file — no dropdown step. (A PDF that ends
    // up in the plain viewer drops this button again; see renderPdfPages.)
    // 0.554.2: a labelled "📍 Comment" (the emoji, not a line icon that read
    // like a thumbtack / tab pin), BEFORE full size — the user's order.
    const extLower = a.file.extension.toLowerCase();
    if (isImageExt(extLower) || extLower === "pdf") {
      const pin = head.createEl("button", { cls: "stashpad-showcase-att-pin", attr: { "aria-label": `Comment on ${a.file.name}: click this, then click a spot or drag over an area` } });
      pin.createSpan({ cls: "stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } });
      pin.createSpan({ cls: "stashpad-showcase-btn-text", text: "Comment" });
      pin.onclick = () => this.startPinOn(s, a);
      // 0.556.0: while picking, what a drag draws — shown only then (CSS).
      const tools = head.createDiv({ cls: "stashpad-showcase-drawtools", attr: { role: "group", "aria-label": "Dragging on the picture draws" } });
      for (const [kind, icon, label, aria] of [["rect", "square", "Box", "Drag to box an area"], ["arrow", "arrow-up-right", "Arrow", "Drag to draw an arrow"]] as const) {
        const b = tools.createEl("button", { cls: "stashpad-showcase-drawtool", attr: { "aria-pressed": String(this.pinTool === kind), "aria-label": aria } });
        b.dataset.tool = kind;
        setIcon(b.createSpan({ cls: "stashpad-showcase-drawtool-icon" }), icon);
        b.createSpan({ cls: "stashpad-showcase-btn-text", text: label });
        b.onclick = () => this.setPinTool(kind);
      }
    }
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
        if (Date.now() < this.suppressClickUntil) return;
        if (this.pinPicking === s.node.id) { this.placePin(s, a, img, e); return; }
        this.openViewer(s, i);
      };
      this.bindDraw(img, s, a);
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
    // covered by the section's own reactions above the files.
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
    // "Comment on a spot" isn't offered over a viewer that can't take the click.
    const fallback = (): void => {
      const card = media.closest(".stashpad-showcase-att");
      card?.querySelector(".stashpad-showcase-att-pin")?.remove();
      card?.querySelector(".stashpad-showcase-drawtools")?.remove(); // nothing to draw on either
      // If the user was mid-pin on this PDF, the viewer can't take the click:
      // end the picking so the section isn't stuck in it.
      const dr = this.drafts.get(s.node.id);
      if (this.pinPicking === s.node.id && dr?.target === file.path) { dr.target = ""; dr.pin = null; this.setPinPicking(null); }
      // Whole-section picking with nothing pinnable left (this PDF was it).
      else if (this.pinPicking === s.node.id && !dr?.target && !s.atts.some((x) => x.file.path !== file.path && this.pinnable(c, x))) this.setPinPicking(null);
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
          this.bindDraw(box, s, a, n);
          box.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".stashpad-showcase-pin")) return;
            if (Date.now() < this.suppressClickUntil) return;
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
          let ok = false;
          try {
            p.task = p.page.render({ canvasContext: ctx, viewport });
            await p.task.promise;
            ok = true;
          } catch { /* cancelled, destroyed mid-render, or a bad page: leave it white */ }
          finally {
            if (gen === p.gen) p.task = null;
            try { p.page.cleanup?.(); } catch { /* still rendering elsewhere — pdf.js refuses, fine */ }
          }
          // 0.556.0: comments' close-ups of this page copy from the canvas.
          if (ok && gen === p.gen && canvas.isConnected) {
            canvas.dataset.ready = "1";
            this.paintThumbsFor(c, file.path, p.n);
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
        // the composer offer "Comment on a spot" for this PDF.
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
    // 0.554.5: the 📍 row; "Comment on this" starts right here on that file.
    const host = this.host;
    const base = host ? spotCommentsHook(this.plugin, this.folder, host.tree, s.node.id, (n) => this.veiled(n) ? "Hidden comment" : host.titleForNode(n)) : undefined;
    const spot: SpotComments | undefined = base ? { ...base, comment: (file) => { this.pendingPinOn = { section: s.node.id, path: file.path, at: Date.now() }; this.scheduleRender(0); } } : undefined;
    new MediaViewerModal(this.app, items, index, (file) => { void this.app.workspace.openLinkText(file.path, "", "tab"); }, spot).open();
  }

  /** Internal links inside rendered markdown don't navigate on their own in a
   *  custom view; route them through the workspace. */
  private wireLinks(el: HTMLElement, sourcePath: string): void {
    el.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a.internal-link");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      // A new tab unless a modifier says otherwise: never replace the Showcase
      // (and lose its unsent drafts) by following a link in a caption.
      if (href) void this.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(e) || "tab");
    });
  }

  // ---------------------------------------------------------------- reactions

  /** 0.551.0: the section's decision chip (Approved / Needs changes / No
   *  decision yet) and, with several options, which one is picked (most
   *  ✅ "Select"; a tie names them all). Cheap; runs every pass. */
  private updateStatus(c: SectionCache, s: SectionData): void {
    const el = c.statusEl;
    if (!el?.isConnected) return;
    const fm = this.fmOf(s.file);
    const map = readReactions(fm);
    const st = sectionStatus(map);
    // Who sent it back: the ❌ stays until that person takes it back.
    const objectors = st === "changes" && this.host ? reactorsOf(map, "❌").map((id) => this.host!.reactionAuthorName(id)).join(", ") : "";
    let picked = ""; let tied = false;
    if (s.atts.length > 1 && !this.veiled(s.node)) {
      // An option's score is ✅ Select minus ❌ Reject; only a positive
      // score can be "picked" (one ❌ shouldn't be outvoted silently, and an
      // option with more ❌ than ✅ is never the pick).
      let best = 0; let names: string[] = [];
      for (const a of s.atts) {
        const r = this.attachmentReactions(fm, a.key);
        const score = reactorsOf(r, "✅").length - reactorsOf(r, "❌").length;
        const letter = a.label.replace(/^Option /, "");
        if (score > best) { best = score; names = [letter]; }
        else if (score > 0 && score === best) names.push(letter);
      }
      if (best > 0) { tied = names.length > 1; picked = tied ? `Tied: ${names.join(", ")}` : `Selected: Option ${names[0]}`; }
    }
    const sig = `${st}|${picked}|${objectors}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.empty();
    const chip = el.createSpan({ cls: `stashpad-showcase-status-chip is-${st}` });
    setIcon(chip.createSpan(), STATUS_ICON[st]);
    chip.createSpan({ text: STATUS_TEXT[st] });
    chip.title = st === "changes" ? `❌ Needs changes from ${objectors || "someone"}. It stays until they click ❌ again.`
      : st === "approved" ? "Marked ✅ approve, and nobody marked ❌ needs changes"
      : "Nobody has marked ✅ approve or ❌ needs changes yet";
    if (picked) {
      const p = el.createSpan({ cls: "stashpad-showcase-status-chip is-picked", text: picked });
      p.title = tied ? "These options have the same score (✅ votes minus ❌ votes)" : "Best score among the options (✅ votes minus ❌ votes)";
    }
  }

  /** 0.551.0: every section with its decision and open feedback; pick one
   *  to scroll to it (drawing more sections first if it's past "Show more"). */
  private openSectionsMenu(anchor: HTMLElement): void {
    const host = this.host;
    if (!host) return;
    const nodes = host.tree.getChildren(this.focusId).filter((n) => n.file);
    const m = new Menu();
    nodes.forEach((n, i) => {
      const st = sectionStatus(readReactions(this.fmOf(n.file)));
      const open = host.tree.getChildren(n.id).filter((k) => this.isUnresolved(k)).length;
      // A hidden (obscured) note keeps its title hidden here too.
      const title = this.veiled(n) ? "Hidden note" : (Array.from(host.titleForNode(n).trim()).slice(0, 60).join("") || "Untitled");
      m.addItem((it) => it
        .setTitle(`${i + 1}. ${title} — ${STATUS_TEXT[st]}${open ? ` · ${open} to resolve` : ""}`)
        .setIcon(STATUS_ICON[st])
        .onClick(() => this.goToSection(n.id)));
    });
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom + 4 }, anchor.doc);
  }

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
    // 0.551.1: the picker's forms ("✅️", U+FE0F) fold into the quick button,
    // so the bar and the decision chip agree; other emojis keep their own.
    const bare = (e: string): string => e.replace(/\uFE0F/g, "");
    const emojis = [...SHOWCASE_REACTIONS, ...Object.keys(map).filter((e) => !SHOWCASE_REACTIONS.includes(bare(e)))];
    for (const emoji of emojis) {
      const quick = SHOWCASE_REACTIONS.includes(emoji);
      const ids = quick ? reactorsOf(map, emoji) : (map[emoji] ?? []);
      const mine = ids.includes(me);
      const meaning = REACTION_MEANING[emoji];
      const word = meaning ? (key === "" ? meaning.section : meaning.option) : "";
      const b = host.createEl("button", { cls: "stashpad-showcase-react" + (mine ? " is-mine" : "") + (ids.length ? " has-count" : "") + (meaning?.word ? " has-word" : "") });
      b.createSpan({ cls: "stashpad-showcase-react-emoji", text: emoji });
      if (meaning?.word) b.createSpan({ cls: "stashpad-showcase-react-word", text: word });
      if (ids.length) b.createSpan({ cls: "stashpad-showcase-react-count", text: String(ids.length) });
      const who = ids.map((id) => view.reactionAuthorName(id)).join(", ");
      const name = word ? `${emoji} ${word}` : emoji;
      b.title = ids.length ? `${name}: ${who}${mine ? " (click to take yours back)" : ""}` : (word ? `${name} (click to add)` : `React ${emoji}`);
      b.setAttr("aria-label", ids.length ? `${word || emoji}, ${ids.length}: ${who}` : (word || `React ${emoji}`));
      b.setAttr("aria-pressed", String(mine));
      b.onclick = () => {
        if (key !== "") { void this.toggleAttachmentReaction(view, s, key, emoji); return; }
        // Taking yours back removes whichever form you hold ("✅" or "✅️").
        const held = quick && mine ? Object.keys(map).filter((k) => bare(k) === emoji && (map[k] ?? []).includes(me)) : [emoji];
        void (async () => { for (const k of held) await toggleReaction(view, s.node, k); })().then(() => this.scheduleRender(50));
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
    el.toggleClass("is-empty", !comments.length);

    const open = comments.filter((n) => this.isUnresolved(n)).length;
    const commentCount = comments.filter((n) => this.isComment(n)).length;
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
    // 0.548.0: same words as the toolbar ("to resolve"), not "3 open · 3".
    if (commentCount) head.createSpan({ cls: "stashpad-showcase-aside-count", text: open ? `${open} of ${commentCount} to resolve` : String(commentCount) });

    const list = el.createDiv({ cls: "stashpad-showcase-comments" });
    let hidden = 0;
    comments.forEach((n, i) => {
      if (this.hideResolved && this.isResolved(n)) { hidden++; return; }
      this.renderComment(list, c, s, n, 0, i + 1);
    });
    if (hidden) list.createDiv({ cls: "stashpad-showcase-hidden-note", text: `${hidden} resolved hidden` });
    // (No "No feedback yet." line: the "Add feedback" button below says it.)

    this.renderComposer(el, c, s, comments);
    if (hadFocus && sel) {
      const ta = el.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) { ta.focus(); ta.setSelectionRange(sel[0] ?? ta.value.length, sel[1] ?? ta.value.length); }
      // The form collapsed under the caret: keep the place on its button
      // rather than dropping focus to the page.
      else el.querySelector<HTMLElement>(".stashpad-showcase-addfb")?.focus({ preventScroll: true });
    }
  }

  private renderComment(list: HTMLElement, c: SectionCache, s: SectionData, n: TreeNode, depth: number, num: number): void {
    const host = this.host!;
    const fm = this.fmOf(n.file);
    const resolved = this.isResolved(n);
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
      item.dataset.target = target.path; // 0.550.0: hover lights up this file (linkHover)
      const att = s.atts.find((a) => a.file.path === target.path);
      const pin = parseFeedbackPin(fm?.feedbackPin);
      const shape = pin ? parseFeedbackShape(fm?.feedbackShape) : null;
      const chip = item.createDiv({ cls: "stashpad-showcase-comment-target", attr: { role: "button", tabindex: "0" } });
      if (pin) chip.createSpan({ cls: "stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } }); else setIcon(chip.createSpan(), "image");
      chip.createSpan({ text: `on ${att?.label ? att.label + " · " : ""}${target.name}${pin?.page ? ` · p. ${pin.page}` : ""}${shape ? (shape.kind === "rect" ? " · area" : " · arrow") : ""}` });
      // 0.556.0: a box / arrow is shown itself (centred, lit); else the file.
      const go = (): void => { if (!(shape && this.revealShape(c, n.id))) this.flashAttachment(s.node.id, target.path, pin?.page); };
      chip.onclick = go;
      chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      // 0.556.0: a close-up of the marked area beside the words, so the
      // comment reads on its own. Not for an obscured section's picture.
      if (shape && pin && !this.veiled(s.node)) {
        const thumb = item.createEl("button", { cls: "stashpad-showcase-shape-thumb is-empty", attr: { "aria-label": `Show the ${shape.kind === "rect" ? "marked area" : "arrow"} on ${target.name}` } });
        thumb.dataset.path = target.path;
        if (pin.page) thumb.dataset.page = String(pin.page);
        thumb.dataset.shape = formatFeedbackShape(shape);
        thumb.createEl("canvas");
        thumb.onclick = go;
        this.paintThumb(c, thumb);
      }
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
      // A page under the section (its own files / notes) isn't feedback:
      // no Resolve, which would check it off in the list.
      if (this.isComment(n)) {
        const cb = actions.createEl("button", { cls: "stashpad-showcase-resolve" + (resolved ? " is-on" : "") });
        setIcon(cb.createSpan(), resolved ? "check-circle-2" : "circle");
        cb.createSpan({ text: resolved ? "Resolved" : "Resolve" });
        cb.setAttr("aria-label", resolved ? "Resolved. Click to reopen." : "Mark this feedback resolved");
        cb.setAttr("aria-pressed", String(resolved));
        cb.onclick = () => { void host.toggleCompletedForNode(n).then(() => this.scheduleRender(50)); };
      }
      const reply = actions.createEl("button", { cls: "stashpad-showcase-replybtn", text: "Reply" });
      reply.onclick = () => {
        const d = this.draftFor(s.node.id);
        // A reply can't carry a pin: drop a pending one (its dot goes too),
        // and stop waiting for a pin click. Text being written for something
        // else is parked, so it can't turn into this reply.
        if (d.pin) { d.pin = null; d.target = ""; }
        if (this.pinPicking === s.node.id) this.setPinPicking(null);
        this.park(d);
        d.replyTo = n.id; d.open = true; d.focus = true;
        c.asideSig = ""; this.scheduleRender(0);
      };
    }
    // 0.554.4: one menu per comment — the ⋯ button, right-click, or
    // press-and-hold on touch. Edit / Delete only on YOUR comments (the user's
    // call: not security, just no accidents; the list still can); Copy link /
    // Open in list for all. Resolve stays a button for everyone.
    const more = actions.createEl("button", { cls: "clickable-icon stashpad-showcase-comment-more", attr: { "aria-label": this.isMine(n) && this.isComment(n) ? "More: edit, delete, copy link, open in list" : this.isMine(n) ? "More: edit, copy link, open in list" : "More: copy link, open in list", "aria-haspopup": "menu" } });
    setIcon(more, "more-horizontal");
    more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); this.openCommentMenu(n, { x: r.left, y: r.bottom + 4 }, more.doc); };
    // Only the innermost comment answers (replies sit inside their parent).
    const mine = (t: EventTarget | null): boolean => (t as { closest?: (sel: string) => Element | null } | null)?.closest?.(".stashpad-showcase-comment") === item;
    const native = (t: EventTarget | null): boolean => !!(t as { closest?: (sel: string) => Element | null } | null)?.closest?.("textarea, input, a");
    // Selected text in this comment keeps the system menu (Copy …).
    const selecting = (): boolean => { const sel = item.doc.getSelection(); return !!sel && !sel.isCollapsed && item.contains(sel.anchorNode); };
    item.addEventListener("contextmenu", (e) => {
      if (!mine(e.target) || native(e.target) || selecting()) return;
      e.preventDefault();
      this.openCommentMenu(n, { x: e.clientX, y: e.clientY }, item.doc);
    });
    let hold: number | null = null;
    let from: { x: number; y: number } | null = null;
    const stopHold = (): void => { if (hold !== null) { window.clearTimeout(hold); hold = null; } };
    item.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || !mine(e.target) || native(e.target)) return;
      from = { x: e.clientX, y: e.clientY };
      stopHold();
      hold = window.setTimeout(() => { hold = null; if (from && !selecting()) this.openCommentMenu(n, from, item.doc); }, 600);
    });
    item.addEventListener("pointerup", stopHold);
    item.addEventListener("pointercancel", stopHold);
    item.addEventListener("pointermove", (e) => { if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) stopHold(); });

    if (depth < 3) {
      const kids = host.tree.getChildren(n.id).filter((k) => k.file);
      if (kids.length) {
        const sub = item.createDiv({ cls: "stashpad-showcase-replies" });
        for (const k of kids) this.renderComment(sub, c, s, k, depth + 1, 0);
      }
    }
  }

  /** 0.554.5: act on a "comment on this file" request once its section is
   *  drawn. True = settled (started, or explained why not); false = wait — a
   *  PDF's pages (and so its pin layers) are drawn after the section, so give
   *  it up to 10 s, re-checking as it draws. */
  private settlePinOn(s: SectionData, want: { path: string; at: number }): boolean {
    const c = this.cache.get(s.node.id);
    if (!c) return false;
    // The preview may resolve a link to a different same-named file than the
    // note does: fall back to the one file with that name.
    const name = want.path.split("/").pop();
    const a = s.atts.find((x) => x.file.path === want.path) ?? (s.atts.filter((x) => x.file.name === name).length === 1 ? s.atts.find((x) => x.file.name === name) : undefined);
    if (this.veiled(s.node)) { notify("Stashpad: this section is hidden. Show it first, then comment on a spot."); return true; }
    if (!a) { notify("Stashpad: couldn't find that file in this section to comment on."); return true; }
    if (this.pinnable(c, a)) {
      if (!(this.pinPicking === s.node.id && this.drafts.get(s.node.id)?.target === a.file.path)) this.startPinOn(s, a); // already picking it: don't toggle off
      return true;
    }
    const card = Array.from(c.mainEl.querySelectorAll<HTMLElement>(".stashpad-showcase-att")).find((x) => x.dataset.path === a.file.path);
    const stillDrawing = a.file.extension.toLowerCase() === "pdf" && !!card?.querySelector(".stashpad-showcase-att-pin") && Date.now() - want.at < 10000;
    if (stillDrawing) { window.setTimeout(() => this.scheduleRender(0), 1200); return false; }
    notify(a.file.extension.toLowerCase() === "pdf" ? "Stashpad: this PDF is shown in the plain viewer, which can't take spot comments." : "Stashpad: couldn't comment on a spot in that file.");
    return true;
  }

  /** Close a draft that has text: it waits, with what it was for, until
   *  "Continue…". With a draft already waiting, the new text stays loose and
   *  reopening joins both (nothing is lost; there's one waiting slot). */
  private park(d: Draft): void {
    if (!d.text.trim() || d.parked) return;
    d.parked = { replyTo: d.replyTo, target: d.target, pin: d.pin, text: d.text };
    d.text = "";
  }

  private unpark(d: Draft): void {
    const p = d.parked;
    if (!p) return;
    d.replyTo = p.replyTo; d.target = p.target; d.pin = p.pin;
    d.text = [p.text, d.text].filter((t) => t.trim()).join("\n\n");
    d.parked = null;
  }

  /** Written by me (the note's `author` is my author id). */
  private isMine(n: TreeNode): boolean {
    const me = (this.plugin.settings.authorId ?? "").trim();
    return !!me && parseAuthorRef(this.fmOf(n.file)?.author)?.id === me;
  }

  private lastMenu = { id: "", at: 0 };
  /** 0.554.4: a comment's menu. Edit opens the edit window (not the list's
   *  composer); Delete is the list's own delete (to Stashpad's trash, undoable,
   *  replies included), offered only on your own comments. */
  private openCommentMenu(n: TreeNode, at: { x: number; y: number }, doc: Document): void {
    const host = this.host;
    n = host?.tree.get(n.id) ?? n; // the current node, not the one drawn earlier
    if (!host || !n.file) return;
    // Long-press can ALSO fire contextmenu on some phones: one menu, not two.
    if (this.lastMenu.id === n.id && Date.now() - this.lastMenu.at < 700) return;
    this.lastMenu = { id: n.id, at: Date.now() };
    const own = this.isMine(n);
    const m = new Menu();
    if (own) m.addItem((i) => i.setTitle("Edit").setIcon("pencil").onClick(() => { void host.cmdSplit(n, "edit", () => this.scheduleRender(50), "modal"); }));
    m.addItem((i) => i.setTitle("Copy link").setIcon("link").onClick(() => { void host.cmdCopyStashpadLink(n); }));
    m.addItem((i) => i.setTitle("Open in list").setIcon("list-tree").onClick(() => { if (this.folder) void this.plugin.revealRowByRef(this.folder, n.id); }));
    // Delete only a COMMENT (never a page under the section, which may carry
    // its own notes), counting everything that goes with it.
    if (own && this.isComment(n)) {
      m.addSeparator();
      let under = 0;
      const walk = (id: StashpadId): void => { for (const k of host.tree.getChildren(id)) if (k.file) { under++; walk(k.id); } };
      walk(n.id);
      const target = n;
      m.addItem((i) => i.setTitle(under ? `Delete (and ${under} repl${under === 1 ? "y" : "ies"} under it)` : "Delete").setIcon("trash-2").setWarning(true)
        .onClick(() => { void host.cmdDelete({ targets: [target] }).then(() => this.scheduleRender(50)); }));
    }
    m.showAtPosition(at, doc);
  }

  private draftFor(sectionId: string): Draft {
    let d = this.drafts.get(sectionId);
    if (!d) { d = { text: "", target: "", replyTo: null, pin: null, posting: false, open: false, focus: false, parked: null }; this.drafts.set(sectionId, d); }
    return d;
  }

  private renderComposer(el: HTMLElement, c: SectionCache, s: SectionData, comments: TreeNode[]): void {
    const host = this.host!;
    const d = this.draftFor(s.node.id);
    if (d.replyTo && !comments.some((n) => n.id === d.replyTo)) d.replyTo = null;
    if (d.target && !s.atts.some((a) => a.file.path === d.target)) { d.target = ""; d.pin = null; }

    // 0.548.0: one quiet "Add feedback" button per section until asked — a
    // full form on every section (15 empty text boxes on a brochure) drew the
    // eye away from the work being reviewed. Anything in progress (a reply, a
    // pin, a post in flight, pin picking) keeps the form open. Closing it keeps
    // the typed text: the button then offers to continue the draft.
    // The replied-to comment is gone: keep the text, as plain feedback.
    if (d.parked?.replyTo && !comments.some((n) => n.id === d.parked!.replyTo)) d.parked.replyTo = null;
    const picking = this.pinPicking === s.node.id;
    if (!(d.open || d.replyTo || d.pin || d.posting || picking)) {
      const addRow = el.createDiv({ cls: "stashpad-showcase-addrow" });
      const add = addRow.createEl("button", { cls: "stashpad-showcase-addfb" });
      setIcon(add.createSpan(), "plus");
      add.createSpan({ text: d.parked?.text.trim() ? (d.parked.replyTo ? "Continue your reply" : "Continue your feedback draft") : d.text.trim() ? "Continue your feedback draft" : "Add feedback" });
      add.onclick = () => {
        this.unpark(d); // what the draft was for (reply / target / pin) + its text
        d.open = true; d.focus = true; c.asideSig = ""; this.scheduleRender(0);
      };
      // 0.554.2: commenting on a spot is visible without opening the form
      // first (the user couldn't find pinning). The click on an image or a
      // PDF page then picks the file.
      if (s.atts.some((x) => this.pinnable(c, x))) {
        const spot = addRow.createEl("button", { cls: "stashpad-showcase-addfb is-spot", attr: { "aria-label": "Comment on a spot: click this, then click a spot or drag over an area on an image or page" } });
        spot.createSpan({ cls: "stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } });
        spot.createSpan({ text: "Comment on a spot" });
        spot.onclick = () => {
          d.replyTo = null; d.pin = null; d.target = ""; // parked stays until a pin is placed
          this.pinHint?.hide();
          this.pinHint = notify(`Click a spot on an image or PDF page, or drag to ${this.pinTool === "arrow" ? "draw an arrow" : "box an area"}. A comment box opens right there. Esc cancels.`, 5000);
          this.setPinPicking(s.node.id);
        };
      }
      if (d.focus) {
        d.focus = false;
        // Only if focus hasn't moved on (the render waited on file reads).
        const a = activeDocument.activeElement;
        if (!a || a === activeDocument.body || el.contains(a)) add.focus({ preventScroll: true }); // never pull the page back to it
      }
      return;
    }

    // 0.550.0: a placed pin gets its own comment box right at the pin (see
    // renderPinBox); the side form just points there instead of offering a
    // second text box for the same draft.
    if (!d.replyTo && this.pinBoxShown(c, s)) {
      const box = el.createDiv({ cls: "stashpad-showcase-composer is-pinned" });
      const att = s.atts.find((a) => a.file.path === d.target);
      const pinned = parseDraftPin(d.pin);
      const chip = box.createDiv({ cls: "stashpad-showcase-composer-chip" });
      chip.createSpan({ cls: "stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } });
      chip.createSpan({ cls: "stashpad-showcase-composer-chip-text", text: `On ${spotWord(d.pin, true)} in ${att?.label || att?.file.name || "the file"}${pinned?.page ? ` · p. ${pinned.page}` : ""}. Write it in the box by the 📍.` });
      const go = chip.createEl("button", { text: d.posting ? "Posting…" : "Go to it" });
      go.disabled = d.posting;
      go.onclick = () => {
        const ta = c.pinBox?.el.querySelector<HTMLTextAreaElement>("textarea");
        c.pinBox?.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        ta?.focus();
      };
      return;
    }

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
      // A visible "About" label: a bare "Whole section" dropdown didn't say
      // what it chose.
      const about = row.createEl("label", { cls: "stashpad-showcase-composer-about" });
      about.createSpan({ cls: "stashpad-showcase-composer-about-text", text: "About" });
      const select = about.createEl("select", { attr: { "aria-label": "What is this feedback about?" } });
      select.createEl("option", { text: "Whole section", value: "" });
      for (const a of s.atts) {
        const o = select.createEl("option", { text: `${a.label ? a.label + " · " : ""}${a.file.name}`, value: a.file.path });
        if (a.file.path === d.target) o.selected = true;
      }
      // Using the form's own controls keeps it open even when picking ends.
      select.onchange = () => { d.open = true; d.target = select.value; d.pin = null; this.setPinPicking(null); c.asideSig = ""; this.scheduleRender(0); };
      const targetAtt = s.atts.find((a) => a.file.path === d.target);
      // 0.534.0: offered whenever the page has something pinnable — with
      // "Whole section" selected, the click on an image/page picks the file.
      if (targetAtt ? this.pinnable(c, targetAtt) : s.atts.some((x) => this.pinnable(c, x))) {
        const pinBtn = row.createEl("button", { cls: "stashpad-showcase-pinbtn" + (d.pin ? " is-set" : "") + (picking ? " is-picking" : "") });
        pinBtn.createSpan({ cls: "stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } });
        const pinned = parseDraftPin(d.pin);
        pinBtn.createSpan({ text: pinned ? (pinned.page ? `On p. ${pinned.page}` : `On ${spotWord(d.pin, true)}`) : (picking ? (targetAtt ? "Click or drag on it…" : "Click or drag on a picture…") : "Comment on a spot") });
        pinBtn.title = d.pin ? `Click to remove the ${spotWord(d.pin)}` : "Then click a spot, or drag over an area, on the image or page";
        pinBtn.onclick = () => {
          d.open = true;
          if (d.pin) { d.pin = null; this.setPinPicking(null); c.asideSig = ""; this.scheduleRender(0); return; }
          this.setPinPicking(this.pinPicking === s.node.id ? null : s.node.id); // live, not as drawn
        };
      }
    }

    const ta = box.createEl("textarea", { cls: "stashpad-showcase-input", attr: { rows: "2", placeholder: d.replyTo ? "Write a reply…" : "What should change, or what works?", "aria-label": d.replyTo ? "Reply" : "Your feedback" } });
    ta.value = d.text;
    ta.oninput = () => { d.text = ta.value; d.open = true; };
    const btns = box.createDiv({ cls: "stashpad-showcase-composer-btns" });
    const cancel = btns.createEl("button", { cls: "stashpad-showcase-cancel", text: "Cancel", attr: { "aria-label": "Cancel (what you typed is kept)" } });
    const post = btns.createEl("button", { cls: "mod-cta stashpad-showcase-post", text: d.posting ? "Posting…" : (d.replyTo ? "Reply" : "Post") });
    // While a post is in flight the draft is EMPTY and the composer disabled: a
    // rebuild in the meantime (the new note's own tree event lands ~200 ms in,
    // long before a network-drive write returns) must not refill the text and
    // offer a live Post button — that double-posted.
    ta.disabled = d.posting; post.disabled = d.posting; cancel.disabled = d.posting;
    const close = (): void => {
      // Collapse, keeping the text. What it was for (a reply, a target, a
      // pin) is parked with it and comes back on "Continue…"; with no text
      // there's nothing to come back to.
      this.park(d);
      d.open = false; d.replyTo = null; d.pin = null; d.target = "";
      d.focus = true; // onto the "Add feedback" button, not the page
      // Any pin picking ends too: Esc here doesn't reach the window-level
      // Esc handler that would otherwise cancel it.
      if (this.pinPicking) this.setPinPicking(null);
      c.asideSig = ""; this.scheduleRender(0);
    };
    cancel.onclick = close;
    const submit = (): void => {
      if (!ta.value.trim() || d.posting) return;
      ta.disabled = true; post.disabled = true; cancel.disabled = true; post.setText("Posting…");
      void this.submitDraft(c, s, ta.value);
    };
    post.onclick = submit;
    ta.addEventListener("keydown", (e) => {
      // Enter posts (Shift+Enter = newline), like the composer — but on mobile
      // the on-screen Return key must stay a newline; the button posts there.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !Platform.isMobile) { e.preventDefault(); submit(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      else if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(); }
    });
    if (d.focus) { d.focus = false; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  /** Post a section's draft. The caller has already disabled its own inputs.
   *  On success the draft resets and the form collapses; on failure the text
   *  comes back. */
  private async submitDraft(c: SectionCache, s: SectionData, raw: string): Promise<void> {
    const d = this.draftFor(s.node.id);
    const text = raw.trim();
    if (!text || d.posting) return;
    const snapshot = { text: d.text, target: d.target, replyTo: d.replyTo, pin: d.pin };
    d.posting = true; d.text = "";
    const ok = await this.postFeedback(s, text, snapshot);
    d.posting = false;
    // The pin box disabled itself by hand; a quick failure may bring no
    // render while `posting` was true, so its key wouldn't change: force it.
    if (c.pinBox) c.pinBox.key = "";
    if (ok) {
      // (A parked draft belongs to something else: it stays parked.)
      d.replyTo = null; d.pin = null; d.target = ""; d.open = false;
      // The disabled box is gone; keep the place on "Add feedback".
      const a = activeDocument.activeElement;
      d.focus = c.root.isConnected && (!a || a === activeDocument.body || c.asideEl.contains(a) || !!c.pinBox?.el.contains(a));
      // 7: let go of the (disabled) pin-box text first, so the collapsed form
      // drawn before the box is removed sees focus as free.
      if (d.focus && a && c.pinBox?.el.contains(a)) (a as HTMLElement).blur();
      if (this.pinPicking === s.node.id) this.setPinPicking(null);
    }
    else {
      d.text = d.text || snapshot.text; // keep anything typed since; else restore
      // Back into the form only if the user hasn't moved on to something else.
      const a = activeDocument.activeElement;
      d.focus = !a || a === activeDocument.body || !!c.pinBox?.el.contains(a);
    }
    c.asideSig = ""; this.scheduleRender(50);
    // This view was replaced while posting (a takeover): the draft lives on
    // the leaf — let the Showcase now in it show the outcome.
    if (!this.containerEl.isConnected) { const now = this.leaf.view; if (now instanceof StashpadShowcaseView && now !== this) now.refreshSoon(); }
  }

  /** Rebuild every feedback column soon (a draft changed underneath). */
  refreshSoon(): void { for (const c of this.cache.values()) c.asideSig = ""; this.scheduleRender(0); }

  /** Create the feedback note under the section (or under the comment being
   *  replied to) through the host's normal note-creation path, with the
   *  feedback keys in the same write. Top-level feedback is an open task so it
   *  can be resolved. */
  private async postFeedback(s: SectionData, text: string, d: Pick<Draft, "target" | "replyTo" | "pin">): Promise<boolean> {
    const host = this.host;
    if (!host) { notify("Stashpad: open this folder in Stashpad first."); return false; }
    if (d.replyTo && !host.tree.get(d.replyTo)) { notify("Stashpad: the comment you were replying to was deleted. Your text is still in the box."); return false; }
    const parent = d.replyTo ?? s.node.id;
    const body = d.replyTo ? text : `[ ] ${text}`;
    const target = d.replyTo ? "" : d.target;
    const extraFm: Record<string, string | boolean> = { feedback: true };
    if (target) extraFm.feedbackOn = `[[${target}]]`;
    const placed = target ? splitDraftPin(d.pin) : null;
    if (placed) {
      extraFm.feedbackPin = placed.pin;
      if (placed.shape) extraFm.feedbackShape = formatFeedbackShape(placed.shape);
    }
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
    // 0.549.0: Find only reaches the drawn sections; say so when that's not all.
    const total = this.host?.tree.getChildren(this.focusId).filter((x) => x.file).length ?? 0;
    const drawn = this.pageEl?.querySelectorAll(":scope > .stashpad-showcase-section").length ?? 0;
    const part = q && drawn < total ? ` (in sections ${this.start + 1}–${this.start + drawn})` : "";
    if (this.findCount) this.findCount.setText(!q ? "" : (n ? `${this.findIdx + 1} of ${n}${this.findCapped ? "+" : ""}` : "No matches") + part);
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
  /** `option`: the map is one option's (✅ = "Select"), not the section's. */
  private reactionSummary(map: ReactionMap, option = false): string {
    const me = (this.plugin.settings.authorId ?? "").trim() || "local";
    const nameOf = (id: string): string => this.plugin.authorRegistry.get(id)?.name
      || (id === me ? (this.plugin.settings.authorName || "me") : id);
    // 0.548.0: the exported page says what ✅ / ❌ mean too — the reader has
    // no hover text to ask.
    const word = (e: string): string => { const m = REACTION_MEANING[e]; return m?.word ? ` ${option ? m.option : m.section}` : ""; };
    return Object.entries(map).filter(([, ids]) => ids.length)
      .map(([e, ids]) => `${e}${word(e)} ${ids.length} (${ids.map(nameOf).join(", ")})`).join(" · ");
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
              const shape = pin ? parseFeedbackShape(nfm?.feedbackShape) : null;
              const who = this.authorLabel(nfm, true);
              const created = typeof nfm?.created === "string" ? mo(nfm.created) : null;
              comments.push({
                num: depth ? 0 : i + 1, author: who.name, role: who.role,
                when: created?.isValid() ? created.format("LLL") : "",
                text, target: target ? `${att?.label ? att.label + " · " : ""}${target.name}${pin?.page ? ` · p. ${pin.page}` : ""}${shape ? (shape.kind === "rect" ? " · area" : " · arrow") : ""}` : "",
                resolved: this.isResolved(n), depth,
                pin: pin && target ? { ...pin, path: target.path, shape } : null,
              });
              if (depth < 3) await walk(host.tree.getChildren(n.id).filter((k) => k.file), depth + 1);
            }
          };
          await walk(host.tree.getChildren(s.node.id).filter((n) => n.file), 0);
        }
        sections.push({
          text: s.text, sourcePath: s.file.path, comments,
          reactions: includeFeedback ? this.reactionSummary(readReactions(fm)) : "",
          atts: s.atts.map((a) => ({ file: a.file, label: a.label, reactions: includeFeedback ? this.reactionSummary(this.attachmentReactions(fm, a.key), true) : "" })),
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

  /** 📍 on a file card: aim the comment at that file and wait for the click.
   *  Clicking the same button again while picking cancels. */
  private startPinOn(s: SectionData, a: Attachment): void {
    const d = this.draftFor(s.node.id);
    this.pinHint?.hide(); this.pinHint = null; // one hint at a time
    if (this.pinPicking === s.node.id && d.target === a.file.path && !d.pin) { this.setPinPicking(null); return; }
    d.target = a.file.path;
    d.pin = null;
    d.replyTo = null;
    this.setPinPicking(s.node.id);
    this.pinHint = notify(`Click a spot on ${a.file.name}, or drag to ${this.pinTool === "arrow" ? "draw an arrow" : "box an area"}. A comment box opens right there. Esc cancels.`, 5000);
  }

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
    this.setDraftPin(s, a, `${x.toFixed(4)},${y.toFixed(4)}${page ? `,${page}` : ""}`);
  }

  /** 0.556.0: a dragged box / arrow → the draft's pin (its anchor) + shape. */
  private placeShape(s: SectionData, a: Attachment, shape: FeedbackShape, page?: number): void {
    const at = shapeAnchor(shape);
    this.setDraftPin(s, a, `${at.x.toFixed(4)},${at.y.toFixed(4)}${page ? `,${page}` : ""}|${formatFeedbackShape(shape)}`);
  }

  private setDraftPin(s: SectionData, a: Attachment, pin: string): void {
    const d = this.draftFor(s.node.id);
    d.target = a.file.path;
    d.pin = pin;
    // (A parked draft stays parked: this pinned comment is a different one.)
    // The box that opens at the pin takes the caret (renderPinBox).
    d.open = true; d.focus = true;
    this.pinHint?.hide(); this.pinHint = null;
    this.setPinPicking(null);
  }

  private setPinTool(kind: ShapeKind): void {
    this.pinTool = kind;
    this.pageEl?.querySelectorAll<HTMLElement>(".stashpad-showcase-drawtool").forEach((b) => b.setAttr("aria-pressed", String(b.dataset.tool === kind)));
  }

  /** 0.556.0: while this section is picking, a DRAG on the picture (`el`: the
   *  image, or a PDF page box) draws the current tool's shape, with a live
   *  preview; a press that doesn't move is left to the click handler, which
   *  drops a pin as before. Pointer events, so it works with a finger too
   *  (picking turns off touch scrolling on the picture — see styles.css). */
  private bindDraw(el: HTMLElement, s: SectionData, a: Attachment, page?: number): void {
    // A picture being picked on mustn't start the browser's own image drag.
    el.addEventListener("dragstart", (e) => { if (this.pinPicking === s.node.id) e.preventDefault(); });
    el.addEventListener("pointerdown", (e) => {
      if (this.pinPicking !== s.node.id || e.button !== 0 || !e.isPrimary) return;
      if ((e.target as HTMLElement | null)?.closest?.(".stashpad-showcase-pin, .stashpad-showcase-pinbox")) return;
      const r0 = el.getBoundingClientRect();
      if (!r0.width || !r0.height) return;
      e.preventDefault(); // no text selection (PDF text layer), no focus jump
      const kind = this.pinTool;
      const frac = (ev: PointerEvent): { x: number; y: number; r: DOMRect } => {
        const r = el.getBoundingClientRect();
        return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height, r };
      };
      const start = frac(e);
      let dragging = false;
      let ghost: Element | null = null;
      const shapeTo = (ev: PointerEvent): FeedbackShape | null => {
        const p = frac(ev);
        const sh = shapeFromDrag(kind, start.x, start.y, p.x, p.y);
        if (sh?.kind !== "rect") return sh;
        // A box at least MIN_SHAPE_PX each way (a sideways drag isn't a hairline).
        const minW = MIN_SHAPE_PX / p.r.width; const minH = MIN_SHAPE_PX / p.r.height;
        const w = Math.min(1, Math.max(sh.w, minW)); const h = Math.min(1, Math.max(sh.h, minH));
        return { kind: "rect", x: Math.min(sh.x, 1 - w), y: Math.min(sh.y, 1 - h), w, h };
      };
      const move = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_MIN_PX) return;
        dragging = true;
        ghost?.remove(); ghost = null;
        // The pin layer may have been redrawn since the press: look it up live.
        const layer = this.cache.get(s.node.id)?.pinHosts.get(pinKey(a.file.path, page));
        const sh = shapeTo(ev);
        if (sh && layer?.isConnected) ghost = appendShapeEl(layer, sh, `stashpad-showcase-shape is-${sh.kind} is-pending is-ghost`);
      };
      const end = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        ghost?.remove(); ghost = null;
        if (!dragging) return; // a plain press: the click handler places a pin
        this.suppressClickUntil = Date.now() + 400;
        if (ev.type === "pointercancel" || this.pinPicking !== s.node.id) return;
        const sh = shapeTo(ev);
        if (sh) this.placeShape(s, a, sh, page);
      };
      try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  /** Numbered dots on images for comments that carry a `feedbackPin`, plus the
   *  pending pin of a draft. Repainted every pass (cheap). */
  private renderPins(c: SectionCache, s: SectionData, comments: TreeNode[]): void {
    for (const [key, host] of c.pinHosts) {
      // Same focus-keeping rule as the reaction bars: skip if nothing changed.
      const d0 = this.drafts.get(s.node.id);
      const sig = comments.map((n) => { const fm = this.fmOf(n.file); return `${n.id}:${String(fm?.feedbackPin ?? "")}:${String(fm?.feedbackShape ?? "")}:${String(fm?.feedbackOn ?? "")}:${fm?.completed === true}:${this.veiled(n)}`; }).join(",")
        + `|${this.hideResolved}|${this.veiled(s.node)}|${d0?.target ?? ""}|${d0?.pin ?? ""}`;
      if (host.dataset.sig === sig) continue;
      host.dataset.sig = sig;
      host.empty();
      // 0.556.0: boxes and arrows sit in their own clipped layer UNDER the
      // dots (a hot box dims the rest of the picture with a shadow, which
      // must stop at the picture's edge — the dots mustn't be clipped).
      let regions: HTMLElement | null = null;
      const regionLayer = (): HTMLElement => {
        if (!regions) { regions = createDiv({ cls: "stashpad-showcase-regions" }); host.prepend(regions); }
        return regions;
      };
      comments.forEach((n, i) => {
        const fm = this.fmOf(n.file);
        const pin = parseFeedbackPin(fm?.feedbackPin);
        if (!pin) return;
        const t = resolveFeedbackTarget(this.app, fm, n.file!.path);
        if (!t || pinKey(t.path, pin.page) !== key) return;
        if (this.hideResolved && this.isResolved(n)) return;
        if (this.veiled(n) || this.veiled(s.node)) return;
        const shape = parseFeedbackShape(fm?.feedbackShape);
        if (shape) {
          const el = appendShapeEl(regionLayer(), shape, `stashpad-showcase-shape is-${shape.kind}` + (this.isResolved(n) ? " is-resolved" : ""));
          el.setAttribute("data-id", n.id);
        }
        const dot = host.createEl("button", { cls: "stashpad-showcase-pin" + (this.isResolved(n) ? " is-resolved" : ""), text: String(i + 1) });
        dot.dataset.id = n.id;
        dot.style.left = `${pin.x * 100}%`;
        dot.style.top = `${pin.y * 100}%`;
        dot.setAttr("aria-label", `Feedback ${i + 1}`);
        dot.onclick = (e) => { e.stopPropagation(); this.flashComment(c, n.id); };
      });
      const d = this.drafts.get(s.node.id);
      const draftPin = d?.pin && d.target ? parseDraftPin(d.pin) : null;
      const pending = draftPin && pinKey(d!.target, draftPin.page) === key ? draftPin : null;
      if (pending) {
        const shape = splitDraftPin(d!.pin)?.shape;
        if (shape) appendShapeEl(regionLayer(), shape, `stashpad-showcase-shape is-${shape.kind} is-pending`);
        const dot = host.createDiv({ cls: "stashpad-showcase-pin is-pending", text: "+" });
        dot.style.left = `${pending.x * 100}%`;
        dot.style.top = `${pending.y * 100}%`;
      }
    }
  }

  /** "Comment 4 · Option B · cover.png · p. 2" — the pin box's title. */
  private pinBoxHead(s: SectionData, d: Draft, count: number): string {
    const att = s.atts.find((a) => a.file.path === d.target);
    const pinned = parseDraftPin(d.pin);
    return `Comment ${count + 1} · ${att?.label ? att.label + " · " : ""}${att?.file.name ?? ""}${pinned?.page ? ` · p. ${pinned.page}` : ""}`;
  }

  /** Whether the section's draft has a placed pin that's on screen (its pin
   *  layer exists), so the comment box can sit right at it. */
  private pinBoxShown(c: SectionCache, s: SectionData): boolean {
    const d = this.drafts.get(s.node.id);
    if (!d?.pin || !d.target || d.replyTo || this.veiled(s.node)) return false;
    const pin = parseDraftPin(d.pin);
    return !!pin && c.pinHosts.has(pinKey(d.target, pin.page));
  }

  /** 0.550.0: click a spot → a small comment box opens AT the pin (like a
   *  design-review tool), instead of sending you to the side column to type.
   *  Same draft and same post path as the side form (submitDraft). Cancel/Esc
   *  drops the pin and keeps the typed text as the section's draft. */
  private renderPinBox(c: SectionCache, s: SectionData, comments: TreeNode[]): void {
    const d = this.drafts.get(s.node.id);
    if (!d || !this.pinBoxShown(c, s)) {
      if (c.pinBox) { c.pinBox.el.remove(); c.pinBox = null; this.pinBoxRo?.unobserve(c.mainEl); }
      // Gone for good (pin dropped / posted, section hidden): forget the
      // caret. Gone for a moment (a PDF redrawing its pages): keep it.
      if (!d?.pin || this.veiled(s.node)) { c.pinFocus = false; c.pinSel = null; }
      return;
    }
    const headText = this.pinBoxHead(s, d, comments.length);
    const key = `${d.target}|${d.pin}|${d.posting}`;
    if (c.pinBox && c.pinBox.key === key && c.pinBox.el.isConnected) {
      // A coworker's comment changes only the number: update it in place,
      // never rebuild under the caret.
      const h = c.pinBox.el.querySelector(".stashpad-showcase-pinbox-title");
      if (h && h.textContent !== headText) h.textContent = headText;
      this.positionPinBox(c, s.node.id);
      return;
    }
    // Rebuilding (e.g. "Posting…"): keep the caret and selection if the box had it.
    const active = activeDocument.activeElement;
    if (c.pinBox && active?.instanceOf(HTMLTextAreaElement) && c.pinBox.el.contains(active)) {
      c.pinFocus = true;
      c.pinSel = [active.selectionStart, active.selectionEnd];
    }
    c.pinBox?.el.remove();

    const box = c.mainEl.createDiv({ cls: "stashpad-showcase-pinbox", attr: { role: "dialog", "aria-label": `Comment on this ${spotWord(d.pin)}` } });
    c.pinBox = { el: box, key };
    const head = box.createDiv({ cls: "stashpad-showcase-pinbox-head" });
    head.createSpan({ cls: "stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } });
    head.createSpan({ cls: "stashpad-showcase-pinbox-title", text: headText });
    const ta = box.createEl("textarea", { cls: "stashpad-showcase-input", attr: { rows: "3", placeholder: `What about this ${spotWord(d.pin)}?`, "aria-label": `Your comment on this ${spotWord(d.pin)}` } });
    ta.value = d.text;
    ta.oninput = () => { d.text = ta.value; };
    const btns = box.createDiv({ cls: "stashpad-showcase-composer-btns" });
    const cancel = btns.createEl("button", { text: "Cancel", attr: { "aria-label": `Remove the ${spotWord(d.pin) === "spot" ? "pin" : spotWord(d.pin)} (what you typed is kept)` } });
    const post = btns.createEl("button", { cls: "mod-cta", text: d.posting ? "Posting…" : "Post" });
    ta.disabled = d.posting; post.disabled = d.posting; cancel.disabled = d.posting;
    const close = (): void => {
      d.pin = null; d.target = ""; d.open = false;
      this.park(d); // the text waits as "Continue your feedback draft"
      // The side column redraws BEFORE this box goes, and only takes focus
      // when nothing else has it: let go of it first.
      ta.blur();
      d.focus = true; // onto "Add feedback" (no scroll), not the page
      c.asideSig = ""; this.scheduleRender(0);
    };
    cancel.onclick = close;
    const submit = (): void => {
      if (!ta.value.trim() || d.posting) return;
      ta.disabled = true; post.disabled = true; cancel.disabled = true; post.setText("Posting…");
      void this.submitDraft(c, s, ta.value);
    };
    post.onclick = submit;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !Platform.isMobile) { e.preventDefault(); submit(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    // Esc anywhere in the box (text, Post, Cancel) — it's a small dialog.
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.isComposing && !d.posting) { e.preventDefault(); e.stopPropagation(); close(); }
    });
    // Clicks inside the box mustn't reach the image under it (that opens the
    // preview, or places another pin).
    box.addEventListener("click", (e) => e.stopPropagation());
    this.pinBoxRo?.observe(c.mainEl);
    this.positionPinBox(c, s.node.id);
    // A restore takes the caret back only if nothing else has it by now.
    const free = (): boolean => { const a = activeDocument.activeElement; return !a || a === activeDocument.body; };
    if (d.focus || (c.pinFocus && free())) {
      const sel = c.pinFocus ? c.pinSel : null;
      d.focus = false; c.pinFocus = false; c.pinSel = null;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(sel?.[0] ?? ta.value.length, sel?.[1] ?? ta.value.length);
      if (!sel) box.scrollIntoView({ behavior: "smooth", block: "nearest" }); // a restore stays put
    } else { c.pinFocus = false; c.pinSel = null; }
  }

  /** Place a section's pin box just under its pending pin, kept inside the
   *  section's main column (it's positioned against mainEl, not the image, so
   *  the file card's rounded-corner clipping can't cut it off). */
  private positionPinBox(c: SectionCache, sectionId: string): void {
    const box = c.pinBox?.el;
    if (!box?.isConnected) return;
    const dot = Array.from(c.mainEl.querySelectorAll<HTMLElement>(".stashpad-showcase-pin.is-pending")).find((x) => x.isConnected);
    if (!dot) { box.addClass("is-unplaced"); return; }
    const m = c.mainEl.getBoundingClientRect();
    let r = dot.getBoundingClientRect();
    if (!m.width || !r.width) { box.addClass("is-unplaced"); return; }
    // 0.556.0: a drawn box / arrow: open under (or above) all of it, not
    // over it — the comment shouldn't hide what it's about.
    const shape = dot.parentElement?.querySelector(".stashpad-showcase-shape.is-pending:not(.is-ghost)");
    const sr = (shape?.querySelector(".sp-arrow-line") ?? shape)?.getBoundingClientRect();
    const hasShape = !!sr && sr.width + sr.height > 0;
    if (sr && hasShape) {
      const left = Math.min(r.left, sr.left); const top = Math.min(r.top, sr.top);
      const right = Math.max(r.right, sr.right); const bottom = Math.max(r.bottom, sr.bottom);
      r = new DOMRect(left, top, right - left, bottom - top);
    }
    box.removeClass("is-unplaced");
    const w = Math.min(320, m.width - 8);
    // A pin: the box's corner near the dot. A shape: lined up with its left edge.
    const left = Math.max(4, Math.min((hasShape ? r.left : r.left + r.width / 2 - 24) - m.left, m.width - w - 4));
    box.style.width = `${w}px`;
    box.style.left = `${left}px`;
    // Under the pin; above it when it would hang past the section's bottom
    // (over the next section) and there's room above.
    const h = box.offsetHeight;
    const below = r.bottom - m.top + 6;
    const above = r.top - m.top - 6 - h;
    // Decided once per box, so it doesn't jump sides while you type (e.g.
    // after dragging the text box taller).
    if (!box.dataset.side) box.dataset.side = below + h > m.height && above >= 0 ? "above" : "below";
    box.style.top = `${box.dataset.side === "above" ? Math.max(0, above) : below}px`;
    box.dataset.section = sectionId;
  }

  private positionPinBoxes(): void {
    for (const [id, c] of this.cache) if (c.pinBox) this.positionPinBox(c, id);
  }

  /** J: keep the narrow-pane "jump to feedback" chip's count current. */
  private updateFeedbackJump(c: SectionCache, children: TreeNode[]): void {
    const jump = c.mainEl.querySelector<HTMLElement>(".stashpad-showcase-fbjump");
    if (!jump) return;
    const comments = children.filter((n) => this.isComment(n)); // pages aren't feedback
    const open = comments.filter((n) => !this.isResolved(n)).length;
    const text = comments.length ? String(comments.length) : "Feedback";
    const more = open ? ` · ${open} to resolve` : "";
    const label = comments.length ? `Jump to this section's feedback: ${comments.length} comment${comments.length === 1 ? "" : "s"}${open ? `, ${open} to resolve` : ""}` : "Jump to this section's feedback form";
    const t = jump.querySelector(".stashpad-showcase-fbjump-text");
    if (t && t.textContent !== text) t.textContent = text;
    const m = jump.querySelector(".stashpad-showcase-fbjump-more");
    if (m && m.textContent !== more) m.textContent = more;
    if (jump.getAttr("aria-label") !== label) jump.setAttr("aria-label", label);
    jump.toggleClass("has-open", open > 0);
  }

  /** I: link a comment with its pin and file, both ways, while hovered or
   *  focused. `null` clears. */
  private hot: HTMLElement[] = [];
  private hotKey = "";
  private linkHover(target: EventTarget | null): void {
    // Any element (SVG icons included), from any window (instanceof
    // HTMLElement is false for a popout's nodes): duck-type closest().
    const t = target as { closest?: (sel: string) => Element | null } | null;
    const found = typeof t?.closest === "function" ? t.closest(".stashpad-showcase-comment:not(.is-reply), .stashpad-showcase-pin[data-id]") : null;
    const el = found as HTMLElement | null;
    const section = el?.closest<HTMLElement>(".stashpad-showcase-section") ?? null;
    const id = el?.dataset.id ?? "";
    const key = el && section && id ? `${section.dataset.id}|${id}` : "";
    if (key === this.hotKey && this.hot.every((h) => h.isConnected)) return;
    for (const h of this.hot) h.removeClass("is-hot");
    this.hot = [];
    this.hotKey = key;
    if (!key || !section) return;
    const comment = Array.from(section.querySelectorAll<HTMLElement>(".stashpad-showcase-comment:not(.is-reply)")).find((x) => x.dataset.id === id);
    const pins = Array.from(section.querySelectorAll<HTMLElement>(".stashpad-showcase-pin[data-id], .stashpad-showcase-shape[data-id]")).filter((x) => x.getAttribute("data-id") === id);
    const path = comment?.dataset.target;
    const card = path ? Array.from(section.querySelectorAll<HTMLElement>(".stashpad-showcase-att")).find((x) => x.dataset.path === path) : undefined;
    // Only worth lighting when there's a partner to light: a comment with no
    // pin and no file target has nothing to point at.
    if (!pins.length && !card) return;
    for (const h of [comment, ...pins, card]) if (h) { h.addClass("is-hot"); this.hot.push(h); }
  }

  /** 0.556.0: bring a comment's box / arrow into view, centred, and light it
   *  for a moment — a lit box dims the rest of the picture, the in-place
   *  "zoom to the area". False when the comment has none drawn here. */
  private revealShape(c: SectionCache, id: string): boolean {
    const el = Array.from(c.mainEl.querySelectorAll<HTMLElement>(".stashpad-showcase-shape[data-id]")).find((x) => x.getAttribute("data-id") === id);
    if (!el) return false;
    // An arrow's SVG covers the whole picture: aim at the line itself.
    (el.querySelector(".sp-arrow-line") ?? el).scrollIntoView({ behavior: "smooth", block: "center" });
    el.removeClass("is-flash"); void (el as HTMLElement).getBoundingClientRect(); el.addClass("is-flash");
    window.setTimeout(() => el.removeClass("is-flash"), 2400);
    return true;
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

  /** 0.556.0: paint a comment's close-up (paintShapeThumb). An image is
   *  loaded on its own (the one on the page may still be lazy); a PDF page is
   *  copied from its drawn canvas, so a page that isn't drawn leaves it empty
   *  (hidden) until it is — paintThumbsFor, from the page's draw. */
  private paintThumb(c: SectionCache, thumb: HTMLElement): void {
    const shape = parseFeedbackShape(thumb.dataset.shape);
    const cv = thumb.querySelector("canvas");
    const path = thumb.dataset.path ?? "";
    if (!shape || !cv || !path) return;
    const paint = (src: CanvasImageSource, w: number, h: number): void => {
      if (!thumb.isConnected) return;
      const color = thumb.win.getComputedStyle(thumb).getPropertyValue(thumb.closest(".is-resolved") ? "--color-green" : "--color-orange").trim() || "#e8590c";
      if (paintShapeThumb(cv, src, w, h, shape, color, THUMB_MAX_W, THUMB_MAX_H)) thumb.removeClass("is-empty");
    };
    const page = Number(thumb.dataset.page) || 0;
    if (page) {
      const att = Array.from(c.mainEl.querySelectorAll<HTMLElement>(".stashpad-showcase-att")).find((x) => x.dataset.path === path);
      const src = att?.querySelector<HTMLCanvasElement>(`.stashpad-showcase-pdfpage[data-page="${page}"] canvas[data-ready]`);
      if (src) paint(src, src.width, src.height);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const img = createEl("img");
    img.onload = () => paint(img, img.naturalWidth, img.naturalHeight);
    img.src = this.app.vault.getResourcePath(file);
  }

  /** A PDF page just finished drawing: paint the close-ups waiting on it. */
  private paintThumbsFor(c: SectionCache, path: string, page: number): void {
    for (const t of Array.from(c.asideEl.querySelectorAll<HTMLElement>(".stashpad-showcase-shape-thumb.is-empty"))) {
      if (t.dataset.path === path && Number(t.dataset.page) === page) this.paintThumb(c, t);
    }
  }

  private flashComment(c: SectionCache, id: string, scroll = true): void {
    const el = Array.from(c.asideEl.querySelectorAll<HTMLElement>(".stashpad-showcase-comment")).find((x) => x.dataset.id === id);
    if (!el) return;
    if (scroll) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
export async function openShowcaseView(plugin: StashpadPlugin, folder: string | null, focusId: StashpadId = ROOT_ID, scrollTo: StashpadId | null = null, flashComment: StashpadId | null = null, pinOn: string | null = null): Promise<void> {
  if (!folder) { notify("Stashpad: open a Stashpad folder first, then open Showcase from it."); return; }
  const { workspace } = plugin.app;
  const want = folder.replace(/\/+$/, "");
  const existing = workspace.getLeavesOfType(STASHPAD_SHOWCASE_VIEW_TYPE).find((l) => {
    const st = l.getViewState()?.state as { folder?: string | null; focusId?: string | null } | undefined;
    return (st?.folder ?? null) === want && (st?.focusId ?? ROOT_ID) === focusId;
  });
  if (existing) {
    await workspace.revealLeaf(existing);
    workspace.setActiveLeaf(existing, { focus: true }); // keys (Find, Esc) go to it
    // 0.549.0: an open tab on this level still lands on the note you're on.
    if (scrollTo && existing.view instanceof StashpadShowcaseView) existing.view.landOn(scrollTo, flashComment, pinOn);
    return;
  }
  const originLeaf = workspace.getMostRecentLeaf();
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_SHOWCASE_VIEW_TYPE, active: true, state: { folder: want, focusId, scrollTo, flash: !!scrollTo, flashComment, pinOn } });
  void workspace.revealLeaf(leaf);
  settleNewTab(workspace, originLeaf);
  returnToOriginOnClose(workspace, leaf, originLeaf, (ref) => plugin.registerEvent(ref));
}

/** 0.554.3: open the Showcase on the section a comment belongs to, landed
 *  there, with that comment (and its pin and file) lit up. Levels by path,
 *  so orphans resolve to Home. */
export async function openShowcaseAtComment(plugin: StashpadPlugin, folder: string | null, tree: TreeLike, commentId: StashpadId): Promise<void> {
  const section = levelOf(tree, commentId);
  if (section === ROOT_ID) { await openShowcaseView(plugin, folder, ROOT_ID, commentId); return; } // an orphan: drawn as a section itself
  await openShowcaseView(plugin, folder, levelOf(tree, section), section, commentId);
}

/** 0.554.5: the preview window's 📍 row for a file: every Showcase comment
 *  aimed at it in this folder (one pass over the folder's tree, no disk
 *  reads), opening one in the Showcase, and starting a new one there on the
 *  section `sectionId` (the note the preview belongs to). `titleOf` hides
 *  obscured notes' text. */
export function spotCommentsHook(plugin: StashpadPlugin, folder: string | null, tree: TreeLike & { allNodes(): TreeNode[] }, sectionId: StashpadId, titleOf: (n: TreeNode) => string): SpotComments | undefined {
  if (!folder) return undefined;
  const { app } = plugin;
  const me = (plugin.settings.authorId ?? "").trim();
  // Built once per preview window (paging slides re-asks for each file).
  let byFile: Map<string, ReturnType<SpotComments["list"]>> | null = null;
  const build = (): Map<string, ReturnType<SpotComments["list"]>> => {
    const m = new Map<string, ReturnType<SpotComments["list"]>>();
    for (const n of tree.allNodes()) {
      if (!n.file) continue;
      const fm = app.metadataCache.getFileCache(n.file)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm?.feedbackOn) continue;
      const target = resolveFeedbackTarget(app, fm, n.file.path);
      if (!target) continue;
      const pin = parseFeedbackPin(fm.feedbackPin);
      const ref = parseAuthorRef(fm.author);
      const author = (!ref ? "" : ref.id === me ? "You" : (plugin.authorRegistry.get(ref.id)?.name || ref.name)) || "Unknown";
      const list = m.get(target.path) ?? [];
      list.push({ id: n.id, author, text: titleOf(n).replace(/^\s*\[[ xX]?\]\s*/, "").trim(), resolved: fm.completed === true, page: pin?.page, pinned: !!pin });
      m.set(target.path, list);
    }
    return m;
  };
  return {
    list: (file) => (byFile ??= build()).get(file.path) ?? [],
    open: (id) => { void openShowcaseAtComment(plugin, folder, tree, id); },
    comment: (file) => { void openShowcaseView(plugin, folder, levelOf(tree, sectionId), sectionId, null, file.path); },
  };
}

/** The chip a feedback note shows in the normal list: "on <file>" — click opens
 *  the file in the preview modal (the photo the comment is about). */
export function renderFeedbackTargetChip(app: ItemView["app"], host: HTMLElement, file: TFile, showInShowcase?: () => void): void {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const target = resolveFeedbackTarget(app, fm, file.path);
  if (!target) return;
  const pin = parseFeedbackPin(fm?.feedbackPin);
  const chip = host.createDiv({ cls: "stashpad-feedback-chip", attr: { role: "button", tabindex: "0" } });
  if (pin) chip.createSpan({ cls: "stashpad-feedback-chip-icon stashpad-showcase-pin-emoji", text: "📍", attr: { "aria-hidden": "true" } });
  else setIcon(chip.createSpan({ cls: "stashpad-feedback-chip-icon" }), "message-square");
  chip.createSpan({ text: `Feedback on ${target.name}` });
  // 0.554.3: the chip opens the Showcase at this comment (the file with its
  // pin and the comment beside it); Cmd/Ctrl-click keeps the plain preview.
  chip.title = showInShowcase ? `See it in the Showcase (${Platform.isMacOS ? "⌘" : "Ctrl"}-click: just preview ${target.name})` : `Open ${target.name}`;
  const open = (e: MouseEvent | KeyboardEvent): void => {
    e.preventDefault(); e.stopPropagation();
    // isModEvent works across windows (an instanceof check fails in a popout).
    if (showInShowcase && !Keymap.isModEvent(e)) { showInShowcase(); return; }
    new MediaViewerModal(app, mediaItemsFor(app, [target.path]), 0, (f) => { void app.workspace.openLinkText(f.path, "", "tab"); }).open();
  };
  chip.addEventListener("click", open);
  chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
}
