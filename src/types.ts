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
