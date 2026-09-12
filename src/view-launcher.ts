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
import { App, SuggestModal, setIcon } from "obsidian";
import { siftMatch } from "./types";

/** One row in the view launcher: what it is, extra search words, a one-line
 *  hint, a Lucide icon, and the Obsidian command id whose opener it delegates
 *  to. */
export interface LauncherEntry {
  id: string;
  label: string;
  keywords: string;
  hint: string;
  /** Lucide icon id shown beside the row. 0.306.0: each view its own icon —
   *  reuses each view's own tab/ribbon icon so the launcher matches the tabs. */
  icon: string;
  /** Full `stashpad:<id>` command id of the existing opener to run. */
  command: string;
}

/** Static catalogue of the openable Stashpad views. `command` is the id
 *  Obsidian namespaces each Stashpad command under (`stashpad:<addCommand id>`).
 *  Every one of these targets a plain-`callback` command (not a checkCallback),
 *  so `executeCommandById` fires it unconditionally. Icons mirror each view's
 *  own `getIcon()` (main list → list-tree; aggregate modes → their per-mode
 *  icons; sidebar panels → their panel icons) so the picker reads like the tabs. */
export const LAUNCHER_ENTRIES: LauncherEntry[] = [
  {
    id: "notes",
    label: "Note list",
    keywords: "main list view open reveal notes stashpad home",
    hint: "The main Stashpad list — reveal it if open, else open it",
    icon: "list-tree",
    command: "stashpad:stashpad-reveal",
  },
  {
    id: "index",
    label: "All notes (master index)",
    keywords: "aggregate index database every note facet filter master",
    hint: "Every note across every folder, with facet filters",
    icon: "table",
    command: "stashpad:stashpad-open-all-notes",
  },
  {
    id: "tasks",
    label: "Tasks",
    keywords: "aggregate tasks todo all open due checkbox",
    hint: "Aggregated tasks across all folders",
    icon: "square-check-big",
    command: "stashpad:stashpad-open-all-tasks",
  },
  {
    id: "timeline",
    label: "Task timeline",
    keywords: "aggregate timeline tasks created completed span axis gantt",
    hint: "Each task as a created → completed span on a time axis",
    icon: "calendar-range",
    command: "stashpad:stashpad-open-task-timeline",
  },
  {
    id: "calendar",
    label: "Due calendar",
    keywords: "aggregate calendar month grid due date day",
    hint: "Month grid of notes by created / due / linked day",
    icon: "calendar",
    command: "stashpad:stashpad-open-due-calendar",
  },
  {
    id: "heatmap",
    label: "Activity heatmap",
    keywords: "aggregate heatmap activity github per-day action count log",
    hint: "GitHub-style per-day action counts from the log",
    icon: "activity",
    command: "stashpad:stashpad-open-activity-heatmap",
  },
  {
    id: "encrypted",
    label: "Encrypted notes",
    keywords: "aggregate encrypted locked secure notes",
    hint: "Aggregated view of every encrypted / locked note",
    icon: "lock",
    command: "stashpad:stashpad-open-all-encrypted",
  },
  {
    id: "archived",
    label: "Archived notes",
    keywords: "aggregate archive archived notes",
    hint: "Aggregated view of archived notes",
    icon: "archive",
    command: "stashpad:stashpad-open-all-archived",
  },
  {
    id: "watch",
    label: "Previously encrypted (watchlist)",
    keywords: "aggregate watchlist previously encrypted re-encrypt sweep review",
    hint: "Notes that were encrypted before — the re-encrypt review",
    icon: "history",
    command: "stashpad:stashpad-open-watchlist",
  },
  {
    id: "trash",
    label: "Trash",
    keywords: "aggregate trash deleted restore recover bin",
    hint: "Aggregated Trash view (restore / recover deleted notes)",
    icon: "trash-2",
    command: "stashpad:stashpad-restore-trash",
  },
  {
    id: "pinned",
    label: "Pinned notes",
    keywords: "pinned pins notes bookmarks favourites favorites starred",
    hint: "Your pinned notes as a standalone view",
    icon: "pin",
    command: "stashpad:stashpad-open-pinned-view",
  },
  {
    id: "shared",
    label: "Shared notes",
    keywords: "shared contributors authored collaborators multiplayer",
    hint: "Notes you authored with contributors, and folders you share",
    icon: "users",
    command: "stashpad:stashpad-open-shared-view",
  },
  {
    id: "notifications",
    label: "Notifications",
    keywords: "notifications history alerts toasts activity feed tab",
    hint: "Notification history as a standalone tab",
    icon: "bell",
    command: "stashpad:stashpad-open-notification-history",
  },
  {
    id: "log",
    label: "Log",
    keywords: "log action history audit changes journal tab",
    hint: "The Stashpad action log as a standalone tab",
    icon: "scroll-text",
    command: "stashpad:stashpad-open-log",
  },
  {
    id: "panels",
    label: "Panels (left sidebar)",
    keywords: "sidebar panels pinned shared tasks left",
    hint: "The sidebar panels view (Pinned / Shared / Tasks)",
    icon: "panel-left",
    command: "stashpad:stashpad-open-panels",
  },
  {
    id: "folder-panel",
    label: "Folder panel (left sidebar)",
    keywords: "sidebar folder panel picker pinned folders left navigation",
    hint: "The left-sidebar folder panel (pinned notes + folders)",
    icon: "folders",
    command: "stashpad:stashpad-open-folder-panel",
  },
  {
    id: "detail",
    label: "Detail panel (right sidebar)",
    keywords: "sidebar detail panel right inspector metadata",
    hint: "The right-sidebar detail panel",
    icon: "panel-right",
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
    const q = query.trim().toLowerCase();
    // Empty query → the full list, alphabetical (0.320.3).
    if (!q) return [...LAUNCHER_ENTRIES].sort((a, b) => a.label.localeCompare(b.label));
    // 0.321.2 (user): rank NAME matches above description/keyword matches.
    //   0 exact label · 1 label starts-with · 2 label contains · 3 hint contains ·
    //   4 keyword/sift-only. Within a rank, alphabetical.
    const rank = (e: LauncherEntry): number => {
      const label = e.label.toLowerCase();
      if (label === q) return 0;
      if (label.startsWith(q)) return 1;
      if (label.includes(q)) return 2;
      if ((e.hint ?? "").toLowerCase().includes(q)) return 3;
      return 4;
    };
    return LAUNCHER_ENTRIES
      .filter((e) => siftMatch(query, `${e.label} ${e.keywords} ${e.hint ?? ""}`))
      .map((e) => ({ e, r: rank(e) }))
      .sort((a, b) => a.r - b.r || a.e.label.localeCompare(b.e.label))
      .map((x) => x.e);
  }

  renderSuggestion(entry: LauncherEntry, el: HTMLElement): void {
    // 0.306.0: each row leads with the view's own icon, then label + hint.
    el.addClass("stashpad-launcher-row");
    const icon = el.createDiv({ cls: "stashpad-launcher-icon" });
    setIcon(icon, entry.icon);
    const text = el.createDiv({ cls: "stashpad-launcher-text" });
    text.createDiv({ text: entry.label, cls: "stashpad-launcher-name" });
    text.createDiv({ text: entry.hint, cls: "stashpad-launcher-hint" });
  }

  onChooseSuggestion(entry: LauncherEntry): void {
    (this.app as any).commands?.executeCommandById?.(entry.command);
  }
}
