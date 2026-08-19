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
/** Per-folder overhaul (Phase A): on-the-fly "database" tab that lists notes by
 *  state across the whole vault. One view type, two modes via view state:
 *  "encrypted" (all locked subtrees) and "archived" (all archive folders). The
 *  "deleted" aggregate is the existing trash view. Read-only: list + navigate. */
export const STASHPAD_AGGREGATE_VIEW_TYPE = "stashpad-aggregate";
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

/** LEGACY time-filter keys. Superseded by the count+unit model
 *  (`TimeUnit` + `ViewConfigState.timeFilterCount`), but still written and
 *  read in view state so older saved layouts migrate. See
 *  `docs/time-filter-numeric.md`. */
export type TimeFilter = "all" | "year" | "month" | "week" | "day";

/** Unit for the numeric time filter ("last N <unit>"). */
export type TimeUnit = "hour" | "day" | "week" | "month" | "year";

/** 0.270.0: which end of its sibling list a note is pinned to. Frontmatter
 *  `listPinned` stores this; legacy `true` reads as "top". */
export type ListPinEdge = "top" | "bottom";

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
  // 0.237.0: visual obscuring ("blurred until tapped"). Stashpad-managed, so a
  // clone or template must not silently inherit someone else's hidden state —
  // inheriting it the WRONG way (a note that should be blurred arriving
  // un-blurred) is the failure that matters.
  "obscured",
  // 0.86.3: sidebar pin state lives on the note (so it SYNCS with the note
  // across devices). Stashpad-managed; clones/templates must not inherit it.
  "pinned", "pinnedAt",
  // 0.105.0: list pin — floats a note to the TOP of its sibling list (distinct
  // from the sidebar pin above). Stashpad-managed; not inherited by clones.
  "listPinned", "listPinnedAt",
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
/** 0.207.1: every PER-FOLDER sidecar file Stashpad writes beside a folder's
 *  notes. All are dotfiles, which means Obsidian's vault index cannot see them
 *  (`getAbstractFileByPath` returns null, and they never appear in
 *  `folder.children`) — they're read and written through `vault.adapter`.
 *
 *  This list is the CANONICAL one, and it exists because that invisibility has
 *  already cost a sibling plugin three separate investigations: its folder
 *  converter couldn't see the order file, then couldn't see the structure file.
 *  Anything that walks, copies, backs up or converts a Stashpad folder needs
 *  this set, and reverse-engineering it from scattered string literals is how
 *  you miss one. (`.stashpad-sort.json` is exactly the one you'd miss.)
 *
 *  ADDING A NEW SIDECAR? Add it here, and say so in
 *  `docs/interop-trynalist.md` — a sibling plugin mirrors this list, and a
 *  missed entry surfaces as silent data weirdness, not an error. */
export const STASHPAD_SIDECAR_FILES: readonly string[] = [
  ".stashpad-order.json",        // manual sibling order        (order-store.ts)
  ".stashpad-sort.json",         // per-parent sort mode        (sort-store.ts)
  ".stashpad-structure.json",    // recovery snapshot           (structure-snapshot.ts)
  ".stashpad-structure.prev.json", // rotated previous generation
] as const;

/** True when `path` names one of Stashpad's per-folder sidecars. */
export function isStashpadSidecar(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return STASHPAD_SIDECAR_FILES.includes(name);
}

export const RESERVED_SUBFOLDER_NAMES: ReadonlySet<string> = new Set([
  "_attachments", "_authors", "_exports", "_imports", "_processed", "_failed-imports",
  "_archive", ".archive", // .archive is legacy (pre-0.79.10)
]);

/** 0.136.0 (per-folder archive/trash overhaul): every Stashpad folder owns an
 *  `archive/` (and, Phase 2, a `trash/`) subfolder. These names are reserved
 *  ONLY as subfolders — a TOP-LEVEL folder literally named "archive"/"trash"
 *  stays a normal folder. NOTE: a pre-existing user SUBfolder named
 *  `archive`/`trash` becomes that folder's archive/trash — its notes stay
 *  reachable via the aggregated views. */
export const SUBFOLDER_ONLY_RESERVED_NAMES: ReadonlySet<string> = new Set(["archive", "trash"]);

/** A reserved name in SUBFOLDER position (never applies to a path's first
 *  segment for archive/trash; always applies for the underscore names). */
export function isReservedSubfolderName(name: string): boolean {
  return RESERVED_SUBFOLDER_NAMES.has(name) || SUBFOLDER_ONLY_RESERVED_NAMES.has(name);
}

/** 0.136.0: the archive subfolder for a Stashpad folder. */
export function archiveSubfolderOf(folder: string): string {
  return `${(folder || "").replace(/\/+$/, "")}/archive`;
}
/** 0.136.0: is `path` (a folder or file path) inside some folder's `archive/`
 *  subfolder? Matches any `archive` segment except a leading one (a top-level
 *  folder literally named "archive" is a normal folder, not a subfolder). */
export function isArchiveSubfolderPath(path: string): boolean {
  return (path || "").replace(/\/+$/, "").split("/").slice(1).includes("archive");
}
/** True if any path segment is a reserved Stashpad subfolder. archive/trash
 *  count only in SUBfolder position (see SUBFOLDER_ONLY_RESERVED_NAMES). */
export function isInReservedSubfolder(path: string): boolean {
  return path.split("/").some((seg, i) =>
    RESERVED_SUBFOLDER_NAMES.has(seg) || (i > 0 && SUBFOLDER_ONLY_RESERVED_NAMES.has(seg)));
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
  /** Legacy; still written (derived) + read as the migration source. */
  timeFilter: TimeFilter;
  /** 0 = All time. Absent in pre-numeric state → migrate from `timeFilter`. */
  timeFilterCount?: number;
  timeFilterUnit?: TimeUnit;
  /** Frozen epoch-ms cutoff when the filter is ABSOLUTE; null/absent = relative. */
  timeFilterAnchor?: number | null;
}

export type LogEventType =
  | "create" | "delete" | "missing" | "parent_change" | "rename" | "reorder"
  | "complete" | "uncomplete"
  | "stash_export" | "stash_import"
  | "attachment_add" | "attachment_remove"
  | "palette_color_add" | "palette_color_remove"
  // 0.136.0: one-time move of legacy dedicated-archive contents into the
  // folder's own archive/ subfolder (per-folder archive overhaul).
  | "archive_migration"
  // 0.146.0: encryption / archive / trash lifecycle — previously surfaced only
  // as notifications; now also recorded in the per-folder action log.
  | "lock" | "unlock" | "archive" | "restore"
  // 0.227.0: a body edit that did NOT come from Stashpad — an external editor,
  // Obsidian's own editor, or sync. Recorded because these are exactly the
  // writes with no other trace: no command ran, so nothing else logs them, and
  // they are the ones you want to see when frontmatter drifts.
  | "external_edit";

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
