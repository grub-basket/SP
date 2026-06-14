import type { TFile } from "obsidian";

export const STASHPAD_VIEW_TYPE = "stashpad-view";
/** 0.68.0: sidebar panels view (Pinned Notes + future panels). */
export const STASHPAD_PANELS_VIEW_TYPE = "stashpad-panels";
/** 0.86.0: left-sidebar folder picker (pinned notes + folders, split). */
export const STASHPAD_FOLDER_PANEL_VIEW_TYPE = "stashpad-folder-panel";
/** 0.74.1: right-sidebar detail panel. Shows the currently-cursored
 *  note's body + metadata + children. Lives separately from the
 *  left-sidebar panels view (Pinned/Shared/Tasks). */
export const STASHPAD_DETAIL_VIEW_TYPE = "stashpad-detail";
/** 0.98.35: dedicated encrypted-trash tab (recoverable deleted notes, grouped by
 *  the folder they came from). */
export const STASHPAD_TRASH_VIEW_TYPE = "stashpad-trash";
export const ROOT_ID = "__root__";

/** A user's pinned-note record. Cross-folder by design — the panel
 *  shows pins from every Stashpad folder in one flat list with a
 *  folder badge for context. 0.68.0. */
export interface PinnedNoteRef {
  folder: string;
  id: StashpadId;
}

export type StashpadId = string;

/** 0.76.3: frontmatter `tags` helpers. Obsidian allows `tags` as
 *  either a YAML list or a space/comma-separated string; these
 *  normalize to an array, mutate, and write back as an array (or
 *  delete the key when empty). `fm` is a live processFrontMatter
 *  object or a cached frontmatter snapshot. Tags are compared
 *  without a leading '#'. */
function fmTagList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
  return [];
}
export function fmHasTag(fm: any, tag: string): boolean {
  const want = tag.replace(/^#/, "");
  return fmTagList(fm?.tags).some((t) => t.replace(/^#/, "") === want);
}
export function fmAddTag(fm: any, tag: string): void {
  const want = tag.replace(/^#/, "");
  const list = fmTagList(fm.tags);
  if (!list.some((t) => t.replace(/^#/, "") === want)) list.push(want);
  fm.tags = list;
}
export function fmRemoveTag(fm: any, tag: string): void {
  const want = tag.replace(/^#/, "");
  const list = fmTagList(fm.tags).filter((t) => t.replace(/^#/, "") !== want);
  if (list.length) fm.tags = list;
  else delete fm.tags;
}

export interface NoteFrontmatter {
  id: StashpadId;
  parent: StashpadId | null;
  created: string;
  attachments?: string[];
  tags?: string[];
  /** Optional hex color (e.g. "#E07A78") that tints the row's swatch, border,
   *  and child-count arrow. Stored verbatim in frontmatter. */
  color?: string | null;
}

export interface TreeNode {
  id: StashpadId;
  parent: StashpadId | null;
  children: StashpadId[];
  file: TFile | null;
  created: string;
}

export type TimeFilter = "all" | "year" | "month" | "week" | "day";

/** Per-folder view mode (settings.viewModes keyed by folder path).
 *  - "nested" (default): tree, immediate children of focus.
 *  - "flat": all descendants of focus, flat, sorted by the current sort mode.
 *  - "everything": all descendants of focus PLUS every non-Stashpad file in
 *    the Stashpad folder, interleaved by created/ctime. Non-Stashpad files
 *    are always folder-wide (they don't belong to any note).
 *
 *  Drag-reorder and tree-mutation commands only operate in "nested" mode;
 *  in flat/everything the list is a synthesized view and direct
 *  position/parent changes would have no meaningful target. */
export type ViewMode = "nested" | "flat" | "everything";

/** Frontmatter keys Stashpad auto-manages. Templates / clones / settings
 *  UI must filter these out of any user-supplied frontmatter so the
 *  plugin always wins on these. Centralised here so every guard reads
 *  from the same list.
 *
 *  - `id`, `parent`, `created`, `attachments`, `position` — canonical
 *    machine-readable structure (mutating these here would corrupt the
 *    tree).
 *  - `modified`, `author`, `contributors` — auto-stamped on edit.
 *  - `parentLink`, `children` — redundant recovery fields written by
 *    FrontmatterSyncQueue; human-clickable navigation back-up.
 */
export const RESERVED_FRONTMATTER: readonly string[] = [
  "id", "parent", "created", "modified", "attachments", "position",
  "author", "contributors",
  "parentLink", "children",
  // 0.78.1: task scheduling/assignment — Stashpad-managed, so clones /
  // templates must not carry someone else's due date or assignees.
  "due", "assignedTo", "assignedBy",
  // 0.86.3: sidebar pin state lives on the note (so it SYNCS with the note
  // across devices). Stashpad-managed; clones/templates must not inherit it.
  "pinned", "pinnedAt",
  // 0.88.0: marks a note that came in via import (used by the "imported only"
  // view filter). Stashpad-managed; a clone of an imported note isn't imported.
  "imported",
  // 0.101.x: OKF relative-markdown cross-links, derived from the tree and
  // Stashpad-managed (rebuilt by the OKF pass). The user-editable OKF fields
  // (okfType/okfTitle/okfTimestamp) are intentionally NOT reserved.
  "okfParent", "okfChildren",
] as const;

/** Reserved Stashpad subfolder names (machine-managed; not user notes).
 *  Centralised so search/link/folder surfaces filter them consistently. */
export const RESERVED_SUBFOLDER_NAMES: ReadonlySet<string> = new Set([
  "_attachments", "_authors", "_exports", "_imports", "_processed",
  "_archive", ".archive", // .archive is legacy (pre-0.79.10)
]);
/** True if any path segment is a reserved Stashpad subfolder. */
export function isInReservedSubfolder(path: string): boolean {
  return path.split("/").some((seg) => RESERVED_SUBFOLDER_NAMES.has(seg));
}
/** True if the path lives under an archive subfolder (`_archive`/`.archive`)
 *  — the import-originals graveyard, excluded from search + link surfaces. */
export function isArchivedPath(path: string): boolean {
  return path.split("/").some((seg) => seg === "_archive" || seg === ".archive");
}

/** 0.79.18: an `attachments` frontmatter entry as a wikilink. Idempotent —
 *  returns an existing `[[...]]` unchanged (never double-brackets), so it's
 *  safe to run repeatedly (e.g. in rebootstrap) without looping. */
export function toAttachmentLink(entry: string): string {
  const s = (entry ?? "").trim();
  if (!s) return s;
  if (/^\[\[.*\]\]$/.test(s)) return s;
  return `[[${s}]]`;
}
/** The resolvable vault path/linktext inside an attachment entry — strips
 *  `[[ ]]`, a trailing `|alias`, and `#heading`/`^block` refs. Accepts both
 *  the new wikilink form and the legacy plain-path form. */
export function attachmentLinkPath(entry: string): string {
  let s = (entry ?? "").trim();
  const m = s.match(/^\[\[(.*)\]\]$/);
  if (m) s = m[1];
  return s.split("|")[0].split("#")[0].split("^")[0].trim();
}

/** File extensions Stashpad never surfaces in link/search (plugin-internal
 *  formats users don't link to). `.edtz` = Encrypted Templater. */
export const IGNORED_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["edtz"]);
export function isIgnoredFileExtension(path: string): boolean {
  const m = path.match(/\.([^./]+)$/);
  return !!m && IGNORED_FILE_EXTENSIONS.has(m[1].toLowerCase());
}

/** Test a path against Obsidian's "Excluded files" entries
 *  (`userIgnoreFilters`): an entry wrapped in `/.../` is a regex; otherwise
 *  it's a path prefix. Lets our surfaces inherit the user's exclusion list
 *  so they manage it in one place. */
export function matchesObsidianIgnore(path: string, filters: string[] | undefined): boolean {
  if (!Array.isArray(filters)) return false;
  for (const raw of filters) {
    const f = (raw ?? "").trim();
    if (!f) continue;
    if (f.length > 2 && f.startsWith("/") && f.endsWith("/")) {
      try { if (new RegExp(f.slice(1, -1)).test(path)) return true; } catch { /* bad regex */ }
    } else if (path === f || path.startsWith(f.endsWith("/") ? f : f + "/")) {
      return true;
    }
  }
  return false;
}

/** Sift: the canonical Stashpad search match — all whitespace-split tokens
 *  must each appear (case-insensitive substring) somewhere in the haystack,
 *  in any order. Empty query matches everything. See docs/sift.md. Exported
 *  so simple inputs (e.g. the assignee picker) reuse it instead of
 *  re-implementing `includes`. */
export function siftMatch(query: string, haystack: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = haystack.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** 0.78.1: parse an author wikilink as Stashpad writes it into
 *  author / contributors / assignedTo / assignedBy frontmatter —
 *  `[[demo/_authors/Jane-743jcy.md|Jane Doe]]` → { id: "743jcy",
 *  name: "Jane Doe" }. The alias (after `|`) is the display name; if
 *  absent we de-slug the filename stem. Returns null when no id segment
 *  is present. Shared so main/view/panels parse identically. */
export function parseAuthorRef(raw: unknown): { id: string; name: string } | null {
  if (typeof raw !== "string") return null;
  const inner = raw.replace(/^\[\[/, "").replace(/\]\]$/, "");
  const [target, alias] = inner.split("|");
  const m = target.match(/_authors\/(.+?)-([a-z0-9]{4,12})(?:\.md)?$/i);
  if (!m) return null;
  const id = m[2];
  const name = (alias ?? "").trim() || m[1].replace(/-/g, " ").trim();
  return { id, name };
}

/** Read an assignee list (`assignedTo`) from frontmatter into
 *  {id,name}[]. Accepts an array of wikilinks or a single wikilink. */
export function parseAssignees(fm: any): Array<{ id: string; name: string }> {
  const raw = fm?.assignedTo;
  const arr = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
  const out: Array<{ id: string; name: string }> = [];
  for (const r of arr) { const p = parseAuthorRef(r); if (p) out.push(p); }
  return out;
}

/** Explicit instruction for what the post-`render()` block should do with
 *  the list scrollTop. Replaces the legacy quorum of flags
 *  (scrollToBottomOnNextRender, stickToListBottom, pendingScrollRestore,
 *  prevAtBottom/prevScroll inference). Every render() caller picks one;
 *  `preserve` is the default and the safe choice for any "data changed,
 *  user wasn't intending a viewport move" mutation.
 *
 *  See `docs/branches/scroll-rewrite-2.md` for the full rationale + the
 *  per-call-site assignment table.
 *
 *  Wired in incrementally:
 *  - 0.56.0: type introduced; render() accepts but ignores it.
 *  - 0.56.1: every caller passes an explicit policy.
 *  - 0.56.2: render() honours the policy alongside legacy flags.
 *  - 0.56.4+: legacy flags retired. */
export type ScrollPolicy =
  | { kind: "preserve" }
  | { kind: "pin-bottom"; until: "settle" | "next-user-input" }
  | { kind: "restore"; scrollTop: number }
  | { kind: "follow-cursor" }
  // `align` is passed straight to scrollIntoView({ block }), so it must be
  // one of its valid values — "start" means top. ("top" was a long-standing
  // typo that silently no-op'd; esbuild doesn't typecheck so it slipped by.)
  | { kind: "scroll-to-id"; id: StashpadId; align: "start" | "center" | "end" | "nearest" };

export interface ViewConfigState {
  focusId: StashpadId;
  timeFilter: TimeFilter;
}

export type LogEventType =
  | "create" | "delete" | "missing" | "parent_change" | "rename" | "reorder"
  | "complete" | "uncomplete"
  | "stash_export" | "stash_import"
  | "attachment_add" | "attachment_remove"
  | "palette_color_add" | "palette_color_remove";

export interface LogEvent {
  ts: string;
  type: LogEventType;
  id: StashpadId;
  payload?: Record<string, unknown>;
  /** Display name of whoever performed the action. Stamped automatically
   *  by StashpadLog.append() from the plugin's authorName setting; older
   *  log lines may lack this field, in which case readers should treat
   *  it as unknown. */
  author?: string;
}
