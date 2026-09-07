// 0.301.0: a searchable modal that lists every openable Stashpad view /
// launcher, so you can jump to any of them from one hotkey instead of hunting
// the ribbon or sidebar. This is the "simple version" — just the picker; a
// later pass may add favourites / ranking.
//
// Each entry delegates to the EXISTING opener by running that view's already
// registered command via `commands.executeCommandById`. That is exactly how
// the ribbon icons and the native command palette open these views, so the
// reveal-if-already-open behaviour (openAggregateView / openStashpadPanelsView /
// activateView all reuse an existing leaf) comes for free and this file never
// reimplements view creation. Search uses Sift (all tokens, any order,
// case-insensitive substring) — the same matcher every other Stashpad search
// surface uses — over each entry's label + keywords.
import { App, SuggestModal } from "obsidian";
import { siftMatch } from "./types";

/** One row in the view launcher: what it is, extra search words, a one-line
 *  hint, and the Obsidian command id whose opener it delegates to. */
export interface LauncherEntry {
  id: string;
  label: string;
  keywords: string;
  hint: string;
  /** Full `stashpad:<id>` command id of the existing opener to run. */
  command: string;
}

/** Static catalogue of the openable Stashpad views. `command` is the id
 *  Obsidian namespaces each Stashpad command under (`stashpad:<addCommand id>`).
 *  Every one of these targets a plain-`callback` command (not a checkCallback),
 *  so `executeCommandById` fires it unconditionally. */
export const LAUNCHER_ENTRIES: LauncherEntry[] = [
  {
    id: "notes",
    label: "Note list",
    keywords: "main list view open reveal notes stashpad home",
    hint: "The main Stashpad list — reveal it if open, else open it",
    command: "stashpad:stashpad-reveal",
  },
  {
    id: "index",
    label: "All notes (master index)",
    keywords: "aggregate index database every note facet filter master",
    hint: "Every note across every folder, with facet filters",
    command: "stashpad:stashpad-open-all-notes",
  },
  {
    id: "tasks",
    label: "Tasks",
    keywords: "aggregate tasks todo all open due checkbox",
    hint: "Aggregated tasks across all folders",
    command: "stashpad:stashpad-open-all-tasks",
  },
  {
    id: "timeline",
    label: "Task timeline",
    keywords: "aggregate timeline tasks created completed span axis gantt",
    hint: "Each task as a created → completed span on a time axis",
    command: "stashpad:stashpad-open-task-timeline",
  },
  {
    id: "calendar",
    label: "Due calendar",
    keywords: "aggregate calendar month grid due date day",
    hint: "Month grid of notes by created / due / linked day",
    command: "stashpad:stashpad-open-due-calendar",
  },
  {
    id: "heatmap",
    label: "Activity heatmap",
    keywords: "aggregate heatmap activity github per-day action count log",
    hint: "GitHub-style per-day action counts from the log",
    command: "stashpad:stashpad-open-activity-heatmap",
  },
  {
    id: "encrypted",
    label: "Encrypted notes",
    keywords: "aggregate encrypted locked secure notes",
    hint: "Aggregated view of every encrypted / locked note",
    command: "stashpad:stashpad-open-all-encrypted",
  },
  {
    id: "archived",
    label: "Archived notes",
    keywords: "aggregate archive archived notes",
    hint: "Aggregated view of archived notes",
    command: "stashpad:stashpad-open-all-archived",
  },
  {
    id: "watch",
    label: "Previously encrypted (watchlist)",
    keywords: "aggregate watchlist previously encrypted re-encrypt sweep review",
    hint: "Notes that were encrypted before — the re-encrypt review",
    command: "stashpad:stashpad-open-watchlist",
  },
  {
    id: "trash",
    label: "Trash",
    keywords: "aggregate trash deleted restore recover bin",
    hint: "Aggregated Trash view (restore / recover deleted notes)",
    command: "stashpad:stashpad-restore-trash",
  },
  {
    id: "panels",
    label: "Panels (left sidebar)",
    keywords: "sidebar panels pinned shared tasks left",
    hint: "The sidebar panels view (Pinned / Shared / Tasks)",
    command: "stashpad:stashpad-open-panels",
  },
  {
    id: "folder-panel",
    label: "Folder panel (left sidebar)",
    keywords: "sidebar folder panel picker pinned folders left navigation",
    hint: "The left-sidebar folder panel (pinned notes + folders)",
    command: "stashpad:stashpad-open-folder-panel",
  },
  {
    id: "detail",
    label: "Detail panel (right sidebar)",
    keywords: "sidebar detail panel right inspector metadata",
    hint: "The right-sidebar detail panel",
    command: "stashpad:stashpad-open-detail",
  },
];

/** 0.301.0: fuzzy launcher to jump to any Stashpad view. Mirrors
 *  `StashpadCommandPalette` (SuggestModal + Sift); the base handles
 *  close-on-pick and Escape, and it works on mobile like every other
 *  SuggestModal-based Stashpad picker. */
export class ViewLauncherModal extends SuggestModal<LauncherEntry> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("Jump to a Stashpad view…");
  }

  getSuggestions(query: string): LauncherEntry[] {
    return LAUNCHER_ENTRIES.filter((e) => siftMatch(query, `${e.label} ${e.keywords}`));
  }

  renderSuggestion(entry: LauncherEntry, el: HTMLElement): void {
    el.createDiv({ text: entry.label, cls: "stashpad-launcher-name" });
    el.createDiv({ text: entry.hint, cls: "stashpad-launcher-hint" });
  }

  onChooseSuggestion(entry: LauncherEntry): void {
    (this.app as any).commands?.executeCommandById?.(entry.command);
  }
}
