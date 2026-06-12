import { Notice, Platform, TFile, type App } from "obsidian";
import type { StashpadId } from "./types";

/** Visual severity. Drives the toast's color + the history panel's
 *  icon. "success" reads green, "warning" reads orange, "error" reads
 *  red; "info" is the neutral default. */
export type NotificationKind = "info" | "success" | "warning" | "error";

/** What kind of operation produced this notification. Used by:
 *  - The history panel for filtering.
 *  - The per-category mute settings (e.g. "stop telling me when I delete").
 *  - Multiplayer activity filters (delete/move on someone else's note
 *    surfaces in the cross-author filter).
 *
 *  Add categories as new notification sites come online. The "system"
 *  category is the catch-all for plumbing notifications (backfill,
 *  integrity sweep, error messages) that don't map to user-action
 *  verbs. */
export type NotificationCategory =
  | "create" | "edit" | "delete" | "move"
  | "merge" | "split" | "clone"
  | "complete" | "uncomplete"
  | "export" | "import"
  | "attachment"
  | "color" | "reorder"
  | "multiplayer"
  | "reminder"
  | "system";

/** Human-readable labels for each category, used by the settings UI
 *  + the history modal's filter dropdown. Keep terse — there are a
 *  lot of categories. */
export const CATEGORY_LABELS: Record<NotificationCategory, { label: string; desc: string }> = {
  create:      { label: "Create",        desc: "Confirmations after a new note is created." },
  edit:        { label: "Edit",          desc: "Edit-related toasts (currently rare)." },
  delete:      { label: "Delete",        desc: "Confirmations after deleting one or more notes." },
  move:        { label: "Move",          desc: "After reparenting or moving notes between folders." },
  merge:       { label: "Merge",         desc: "After combining multiple notes into one." },
  split:       { label: "Split",         desc: "After splitting a note in two." },
  clone:       { label: "Clone",         desc: "After duplicating notes or subtrees." },
  complete:    { label: "Complete",      desc: "When a note is marked complete." },
  uncomplete:  { label: "Uncomplete",    desc: "When a note's complete mark is removed." },
  export:      { label: "Export",        desc: ".stash exports — success + the action buttons." },
  import:      { label: "Import",        desc: ".stash imports (both manual and the drop-folder auto-import)." },
  attachment:  { label: "Attachment",    desc: "Attachment add / remove notifications." },
  color:       { label: "Color",         desc: "Per-note color changes." },
  reorder:     { label: "Reorder",       desc: "Drag-reorder and keyboard moveUp/Down/Top/Bottom." },
  multiplayer: { label: "Multiplayer",   desc: "Cross-author activity (someone else touched your notes or vice versa)." },
  reminder:    { label: "Reminder",      desc: "Task due-date reminders — surfaced when a task comes due (fired at launch / periodically)." },
  system:      { label: "System",        desc: "Plumbing toasts: backfill progress, integrity warnings, errors not tied to a verb." },
};

/** Button rendered inside the toast. The toast auto-dismisses on click
 *  unless the action sets `keepOpen: true` — useful for actions that
 *  open another tab/window and want the toast around as a back-link. */
export interface NotificationAction {
  label: string;
  /** Invoked on click. May be async; the toast doesn't wait on it. */
  onClick: () => void | Promise<void>;
  /** When true, clicking the action button doesn't dismiss the toast.
   *  Default false (most actions navigate away, dismissing is fine). */
  keepOpen?: boolean;
}

export interface NotifyOptions {
  /** The headline string shown on the toast. Multi-line OK; the first
   *  line carries the bulk of the visual weight. */
  message: string;
  kind?: NotificationKind;
  category?: NotificationCategory;
  /** 0 = persistent (user has to dismiss). Otherwise, ms. Defaults
   *  scale with kind: info/success 4s, warning 6s, error 10s. */
  duration?: number;
  actions?: NotificationAction[];
  /** Whichever author identity produced this notification — usually
   *  the local user, but cross-user collaboration may stamp another
   *  authorId so multiplayer filters can pivot on "who did this". */
  authorId?: string;
  /** Stashpad ids touched by this action — feeds the history panel's
   *  per-note drill-down and lets the multiplayer filter match
   *  cross-author activity by file. */
  affectedIds?: StashpadId[];
  /** Vault-relative paths touched — for non-Stashpad files (attachments,
   *  exports, imports). */
  affectedPaths?: string[];
  /** Distinct author / contributor ids associated with the affected
   *  notes, captured at the moment the action happened. Used by the
   *  history modal's "Cross-author" filter, which compares these
   *  against the actor's authorId. Pre-stamping (vs. looking up the
   *  authors at filter time) is the only way to track cross-author
   *  activity for DESTROYED notes — once a note is deleted, the
   *  metadata cache won't return its frontmatter, so a resolver-only
   *  approach would miss "I deleted a note by someone else." */
  affectedAuthorIds?: string[];
  /** Folder this notification belongs to (for filtering history by
   *  Stashpad folder later on). Optional. */
  folder?: string;
}

export interface NotificationRecord extends Required<Pick<NotifyOptions, "message">> {
  id: number;
  ts: number;
  kind: NotificationKind;
  category: NotificationCategory;
  authorId?: string;
  affectedIds: StashpadId[];
  affectedPaths: string[];
  affectedAuthorIds: string[];
  folder?: string;
  /** Snapshot of action labels for the history panel (we don't keep
   *  the click handlers — they'd close over view state that may be
   *  stale by the time the user opens history). */
  actionLabels: string[];
}

const DEFAULT_DURATION: Record<NotificationKind, number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 10000,
};

/** Default history cap. Was 200 in 0.55.0 — bumped to 5000 after
 *  user feedback that 200 lost relevant entries within a normal
 *  session. The settings UI lets users override (0 or negative =
 *  unlimited; the service treats any non-positive value as
 *  "no cap"). */
const DEFAULT_HISTORY_LIMIT = 5000;

/** Plugin-level notification service. One instance lives on the plugin
 *  (`plugin.notifications`). Views and commands route their toasts
 *  through it instead of `new Notice()` directly so:
 *    - History accumulates centrally.
 *    - Per-category muting works uniformly.
 *    - Multiplayer/category filters in the history panel have
 *      everything to filter against. */
export class NotificationService {
  private history: NotificationRecord[] = [];
  private nextId = 1;
  private historyLimit = DEFAULT_HISTORY_LIMIT;
  private changeListeners = new Set<() => void>();
  /** Categories the user has silenced. Reads from settings on
   *  construction; updated via setMuted / wiring from the settings UI.
   *  Default empty (nothing muted). */
  private muted = new Set<NotificationCategory>();
  /** Default authorId stamped onto records when the caller didn't
   *  provide one. Set from the plugin's authorName/authorId settings
   *  on load. Lets the multiplayer history filter answer "who acted
   *  here" without every call site having to remember to pass it. */
  private defaultAuthorId: string | null = null;

  constructor(private app: App) {}

  setDefaultAuthorId(id: string | null): void {
    this.defaultAuthorId = id || null;
  }

  /** Show a toast. Returns the Notice in case the caller wants to keep
   *  a handle (e.g. to hide it programmatically). When the category is
   *  muted, the history is still recorded but no toast renders — so
   *  the user can review what would've shown in the history panel. */
  show(opts: NotifyOptions): Notice | null {
    const kind = opts.kind ?? "info";
    const category = opts.category ?? "system";
    const record: NotificationRecord = {
      id: this.nextId++,
      ts: Date.now(),
      message: opts.message,
      kind,
      category,
      // Auto-stamp the local user's authorId when the caller didn't
      // override it — feeds the "Me" / "Cross-author" multiplayer
      // filters in the history modal.
      authorId: opts.authorId ?? this.defaultAuthorId ?? undefined,
      affectedIds: opts.affectedIds ? opts.affectedIds.slice() : [],
      affectedPaths: opts.affectedPaths ? opts.affectedPaths.slice() : [],
      affectedAuthorIds: opts.affectedAuthorIds ? opts.affectedAuthorIds.slice() : [],
      folder: opts.folder,
      actionLabels: (opts.actions ?? []).map((a) => a.label),
    };
    this.pushHistory(record);

    if (this.muted.has(category)) return null;

    const frag = this.buildContent(opts, kind);
    const duration = opts.duration ?? DEFAULT_DURATION[kind];
    return new Notice(frag, duration);
  }

  /** Subscribe to history changes. The history panel uses this to
   *  re-render when new toasts land. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Returns history sorted newest-first. Cheap; just a slice of the
   *  in-memory array. */
  recent(): NotificationRecord[] {
    return this.history.slice().reverse();
  }

  clearHistory(): void {
    this.history = [];
    this.emit();
  }

  setMuted(category: NotificationCategory, muted: boolean): void {
    if (muted) this.muted.add(category);
    else this.muted.delete(category);
  }

  isMuted(category: NotificationCategory): boolean {
    return this.muted.has(category);
  }

  /** Bulk-set the muted categories. Used when settings load. */
  loadMutedFromList(list: NotificationCategory[]): void {
    this.muted = new Set(list);
  }

  /** Snapshot the muted set for settings persistence. */
  mutedList(): NotificationCategory[] {
    return Array.from(this.muted);
  }

  /** Replace the in-memory history wholesale. Used by the plugin on
   *  load to restore the persisted history. Trims to the active limit
   *  on the way in. nextId is bumped past the max persisted id so
   *  new records don't collide with restored ones. */
  loadHistory(records: NotificationRecord[]): void {
    const trimmed = this.applyLimit(records.slice());
    this.history = trimmed;
    let maxId = 0;
    for (const r of trimmed) if (r.id > maxId) maxId = r.id;
    this.nextId = Math.max(this.nextId, maxId + 1);
    this.emit();
  }

  /** Set the on-disk cap. Non-positive values mean "no cap" (history
   *  grows forever; the plugin still has to fit data.json so plan
   *  accordingly). Trims the in-memory buffer to the new cap. */
  setHistoryLimit(limit: number): void {
    this.historyLimit = Number.isFinite(limit) ? limit : DEFAULT_HISTORY_LIMIT;
    this.history = this.applyLimit(this.history);
    this.emit();
  }

  private applyLimit(arr: NotificationRecord[]): NotificationRecord[] {
    if (this.historyLimit <= 0) return arr;
    if (arr.length <= this.historyLimit) return arr;
    return arr.slice(arr.length - this.historyLimit);
  }

  private pushHistory(record: NotificationRecord): void {
    this.history.push(record);
    this.history = this.applyLimit(this.history);
    this.emit();
  }

  private emit(): void {
    for (const cb of this.changeListeners) {
      try { cb(); } catch (e) { console.warn("[Stashpad] notification listener failed", e); }
    }
  }

  private buildContent(opts: NotifyOptions, kind: NotificationKind): DocumentFragment {
    const frag = document.createDocumentFragment();
    const wrap = document.createElement("div");
    wrap.className = `stashpad-notice stashpad-notice-${kind}`;
    const msg = document.createElement("div");
    msg.className = "stashpad-notice-message";
    // Inline-code via backticks. `path/to/file.md` renders as
    // monospace + slightly tinted background. Plain text outside
    // backticks uses textNodes (no XSS exposure — never set
    // innerHTML to message content).
    const parts = opts.message.split(/(`[^`\n]+`)/);
    for (const part of parts) {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        msg.appendChild(code);
      } else if (part.length > 0) {
        msg.appendChild(document.createTextNode(part));
      }
    }
    wrap.appendChild(msg);
    if (opts.actions && opts.actions.length > 0) {
      const row = document.createElement("div");
      row.className = "stashpad-notice-actions";
      for (const action of opts.actions) {
        const btn = document.createElement("button");
        btn.className = "stashpad-notice-action";
        btn.textContent = action.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          // Call the action handler — fire-and-forget.
          void Promise.resolve()
            .then(() => action.onClick())
            .catch((err) => console.warn("[Stashpad] notification action failed", err));
          // Dismiss the toast by removing it from the DOM unless the
          // action explicitly wants to stay open.
          if (!action.keepOpen) {
            const noticeEl = btn.closest(".notice");
            if (noticeEl && noticeEl.parentElement) noticeEl.parentElement.removeChild(noticeEl);
          }
        });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    }
    frag.appendChild(wrap);
    return frag;
  }
}

/** Build a pair of notification actions targeting a vault file:
 *  "Reveal in file explorer" (Obsidian's File Explorer view scrolls
 *  to the file) and "Show in OS File System" (Finder / Windows
 *  Explorer via Electron's shell). The second is desktop-only —
 *  pass isMobile=true to omit it.
 *
 *  Free function (not on NotificationService) so both plugin-level
 *  callers in main.ts and view-level callers in view.ts can use it
 *  without dragging a view instance around. Returns [] when the path
 *  doesn't resolve to a file — caller can spread the result into a
 *  notification's actions array without a guard. */
export function buildFileActions(
  app: App,
  path: string,
  isMobile: boolean,
): NotificationAction[] {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return [];
  // keepOpen=true on both — these are "go inspect the file" actions
  // that open another window/pane. The user often wants to click one,
  // glance at the file, then come back to use the OTHER action. The
  // toast staying open lets them do that without re-triggering.
  // 0.72.1: short verb labels — the file path is already in the
  // message body, so the buttons just need to name the action.
  const actions: NotificationAction[] = [{
    label: "Reveal",
    keepOpen: true,
    onClick: () => {
      // 0.72.2: reveal the file-explorer LEAF first, then call
      // revealInFolder. Without the revealLeaf step, the scroll-to /
      // highlight runs inside a collapsed sidebar tab and isn't
      // visible until the user manually switches to the Files panel —
      // at which point the previous reveal has long been overwritten.
      const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
      if (!leaf) return;
      app.workspace.revealLeaf(leaf);
      const fe = leaf.view as any;
      fe?.revealInFolder?.(file);
    },
  }];
  if (!isMobile) {
    // Platform-correct OS file-manager name (Windows: "File Explorer",
    // capitalised; macOS: "Finder"; otherwise generic).
    const osManager = Platform.isMacOS ? "Finder"
      : Platform.isWin ? "File Explorer"
      : "file manager";
    actions.push({
      label: `Show in ${osManager}`,
      keepOpen: true,
      onClick: () => {
        try {
          const shell = (window as any).require?.("electron")?.shell;
          const adapter = app.vault.adapter as any;
          const fullPath = adapter?.getFullPath?.(path);
          if (fullPath && shell?.showItemInFolder) shell.showItemInFolder(fullPath);
        } catch (e) {
          console.warn("[Stashpad] showItemInFolder failed", e);
        }
      },
    });
  }
  return actions;
}
