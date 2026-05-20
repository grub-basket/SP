import type { TFile } from "obsidian";

export const STASHPAD_VIEW_TYPE = "stashpad-view";
export const ROOT_ID = "__root__";

export type StashpadId = string;

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
] as const;

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
  | { kind: "scroll-to-id"; id: StashpadId; align: "center" | "nearest" | "top" };

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
