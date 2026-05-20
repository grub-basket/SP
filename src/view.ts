import {
  FuzzySuggestModal, ItemView, MarkdownRenderer, Menu, Notice, Platform,
  Scope, SuggestModal, TFile, TFolder, WorkspaceLeaf, debounce, moment, setIcon,
} from "obsidian";
import {
  ROOT_ID, STASHPAD_VIEW_TYPE, RESERVED_FRONTMATTER, type StashpadId, type TimeFilter, type TreeNode, type ViewConfigState, type ViewMode, type ScrollPolicy,
} from "./types";
import { TreeIndex } from "./tree-index";
import { OrderStore } from "./order-store";
import { SortStore, type SortMode, SORT_MODE_LABELS, SORT_MODES_ORDER } from "./sort-store";
import { FrontmatterSyncQueue } from "./frontmatter-sync";
import { buildFileActions } from "./notifications";
import { newId } from "./id-service";
import { bodyToSlug, buildFilename, parseIdFromFilename, DEFAULT_STOPWORDS } from "./slug-service";
import { StashpadLog } from "./log";
import { IntegrityWatcher } from "./integrity-watcher";
import { getSettings, getTemplatesFormats, onSettingsChange } from "./settings";
import { StashpadSuggest } from "./note-picker";
import { setActiveView, clearActiveView } from "./active-view";
import { ColorPickerModal, ConfirmDeleteModal, ConfirmModal, SplitNoteModal } from "./modals";
import { ComposerAutocomplete } from "./composer-autocomplete";
import { buildStashZip, importStashZip, STASH_EXT } from "./stash-package";
import type StashpadPlugin from "./main";

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  nested: "Nested",
  flat: "Flat",
  everything: "Everything",
};

/** Heuristic: returns true when an Obsidian modal/prompt/menu is currently
 *  open. Used to gate the view's keydown handler so arrow/Enter shortcuts
 *  don't bleed through to the underlying note list. Tries multiple shapes
 *  because the exact DOM varies by Obsidian version. */
function isAnyModalOpen(target?: EventTarget | null): boolean {
  // Definitive: the keydown originated inside a modal-ish container.
  if (target instanceof Element) {
    if (target.closest(".modal, .modal-container, .suggestion-container, .menu, .prompt")) return true;
  }
  // Fallback: any modal/prompt/menu is in the DOM (regardless of focus).
  // Use specific selectors that are only added when actively open, not
  // the always-present .modal-container shell.
  if (document.body.querySelector(".modal-bg")) return true;
  if (document.body.querySelector(".modal-container .modal")) return true;
  if (document.body.querySelector(".suggestion-container")) return true;
  if (document.body.querySelector(".menu.mod-active")) return true;
  return false;
}

/** Labels for each time-filter mode, plus a per-mode short label and
 *  long-form description used as the button's tooltip. The displayed
 *  short label switches between calendar mode (Today/Week/…) and rolling
 *  mode (24h/7d/30d/365d/∞) based on the active filterCalendar flag. */
interface TimeFilterOption {
  key: TimeFilter;
  /** Short label in calendar mode (e.g. "Today"). */
  calShort: string;
  /** Short label in rolling mode (e.g. "24h"). */
  rollShort: string;
  /** Tooltip in calendar mode. */
  calLong: string;
  /** Tooltip in rolling mode. */
  rollLong: string;
}
const TIME_FILTER_OPTIONS: TimeFilterOption[] = [
  // "All" sits at the end of the row now (the user wanted it after the
  // bounded filters, not before).
  { key: "day",   calShort: "Today", rollShort: "24h",  calLong: "Since midnight today",       rollLong: "Last 24 hours" },
  { key: "week",  calShort: "Week",  rollShort: "7d",   calLong: "Since Monday this week",     rollLong: "Last 7 days" },
  { key: "month", calShort: "Month", rollShort: "30d",  calLong: "Since the 1st of this month", rollLong: "Last 30 days" },
  { key: "year",  calShort: "Year",  rollShort: "365d", calLong: "Since January 1 this year",  rollLong: "Last 365 days" },
  { key: "all",   calShort: "All",   rollShort: "ad infinitum",    calLong: "All time",                   rollLong: "All time" },
];

export class StashpadView extends ItemView {
  private plugin: StashpadPlugin;
  private viewRoot!: HTMLElement;

  private tree: TreeIndex;
  private log: StashpadLog;
  private integrity: IntegrityWatcher;
  private order: OrderStore;
  private sortStore: SortStore;
  /** Background queue that writes redundant `parentLink` + `children`
   *  fields to frontmatter. Fire-and-forget — callers don't await. See
   *  FrontmatterSyncQueue jsdoc for the why. */
  private fmSync: FrontmatterSyncQueue;

  private focusId: StashpadId = ROOT_ID;
  private timeFilter: TimeFilter = "all";
  /** When true, time filters use CALENDAR boundaries (start of today /
   *  this week / this month / this year) instead of rolling N-day
   *  windows backward from now. View-local; not persisted. */
  private timeFilterCalendar = false;
  /** Active tag filter — null means show everything; otherwise the
   *  raw tag (without leading #) that visible notes must carry. */
  private tagFilter: string | null = null;
  /** Active color filter — null means show everything; otherwise the
   *  hex string (e.g. "#E07A78") that visible notes must carry. */
  private colorFilter: string | null = null;
  private noteFolder = "stashpad";
  private folderOverride: string | null = null;
  private detachTreeHook: (() => void) | null = null;
  private detachSettings: (() => void) | null = null;
  private slugDebouncers = new Map<string, ReturnType<typeof debounce>>();
  private attachmentDebouncers = new Map<string, ReturnType<typeof debounce>>();
  private debouncedRender: ReturnType<typeof debounce>;
  private bootstrappedFolders = new Set<string>();

  private selection = new Set<StashpadId>();
  private lastSelected: StashpadId | null = null;
  private cursorIdx = -1;
  private currentChildren: TreeNode[] = [];
  private modeSplit: boolean | null = null;
  private modeEnterSubmits = true; // per-view, defaults true
  private nextDestination: StashpadId | null = null;
  private inListPicker: { activeIdx: number } | null = null;
  private listEl: HTMLElement | null = null;
  private composerInputEl: HTMLTextAreaElement | null = null;
  private composerDraft = "";
  private draftsLoadedFor: string | null = null;
  private autoSelectNewest = false;
  private scrollToBottomOnNextRender = false;
  /** Debounce token for the scroll-event listener that keeps scrollByFocus
   *  fresh as the user scrolls. Without this, reload could only restore
   *  positions the user explicitly navigated to/from — free scrolling
   *  inside one focus would never be saved. */
  private scrollListenerSaveTimer: number | null = null;
  /** Set true while restore-policy's multi-frame apply is asserting
   *  scrollTop programmatically. The scroll listener checks this and
   *  skips stamping the map — otherwise a transient clamped scrollTop
   *  (scrollHeight not yet settled) overwrites the saved target with
   *  the WRONG value. Reset by a microtask after each apply. */
  private suppressScrollSave = false;
  /** Generation counter bumped on focus change (navigateTo / navigateUp /
   *  folder switch). The defensive tryReselect timers in moveAcrossThenReorder,
   *  commitInListPicker, undo paths, etc. capture the counter at schedule
   *  time and bail when it differs at fire time — that's what stops a
   *  120/400ms re-apply from leaking selection across a navigation.
   *  Removed in 0.56.11 once those flows are folded into a unified
   *  selection-after-mutation primitive. */
  private selectionGuardKey = 0;
  /** Explicit scroll policy for the in-flight render() call. Set by render()
   *  itself from its arg; consumed and cleared by the post-render block.
   *  When null, legacy flag inference takes over (the ~70 sites that
   *  haven't been annotated yet). Removed in 0.56.6. */
  private pendingRenderPolicy: ScrollPolicy | null = null;
  /** When true, the listResizeObserver re-pins scroll to the bottom each time
   *  the list grows. Set after scrollListToBottom; cleared on user scroll. */
  private stickToListBottom = false;
  /** Per-row ResizeObserver attached during scrollListToBottom — re-pins
   *  the list to the bottom whenever a row's height changes. Survives
   *  past the initial paint so cold-cache markdown / late font loads
   *  don't leave the last note tucked behind the composer. Disconnected
   *  on user scroll-up (via stickToListBottom flipping false) or on view
   *  teardown. */
  private stickyRowObserver: ResizeObserver | null = null;
  private listResizeObserver: ResizeObserver | null = null;
  /** Per-focus "last cursor note id" — persisted via plugin.saveLastCursor.
   *  Read on view open / folder switch; restored via the `scroll-to-id`
   *  policy so the user lands looking at the same note they were on, even
   *  when row heights shift between sessions. 0.56.14. */
  private lastCursorByFocus = new Map<StashpadId, StashpadId>();
  private expandedNotes = new Set<StashpadId>();
  private focusComposerOnNextRender = false;
  /** Debounced wrapper around saveDraft for the input event. Lazily
   *  initialized on first composer render. */
  private debouncedSaveDraft?: (v: string) => void;
  /** Composer autocomplete instance — recreated whenever the composer
   *  textarea is rebuilt (i.e. on each render). */
  private composerAutocomplete: ComposerAutocomplete | null = null;
  /** First note added to the current select-mode session. Restored as
   *  the lone selection when the user taps the select-mode button to
   *  exit. Cleared whenever selection drops to zero. */
  private firstSelectedId: string | null = null;
  /** Mobile-only: true when the user has explicitly entered select mode
   *  via the top-right button. Distinct from selection.size > 0 because
   *  the cursor highlight always populates selection with one entry —
   *  that doesn't count as "select mode" in the user's mental model. */
  private mobileSelectMode = false;
  /** Observer that toggles the sticky mini focused-header preview. */
  private focusedMiniObserver: IntersectionObserver | null = null;
  /** When set, the next composer render restores the caret to this index
   *  in the new textarea. Paired with focusComposerOnNextRender. */
  private pendingComposerCaret: number | null = null;
  private navForwardStack: StashpadId[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: StashpadPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.tree = new TreeIndex(this.app);
    this.log = plugin.newLog();
    this.integrity = new IntegrityWatcher(this.tree, this.log);
    this.order = new OrderStore(this.app);
    this.sortStore = new SortStore(this.app);
    this.fmSync = new FrontmatterSyncQueue(this.app, () => this.tree);
    // Plug the order store into the tree's children sort. The provider
    // dispatches per-parent:
    //   - sort mode === "manual" → defer to OrderStore (explicit manual array
    //     when the user has dragged things, else empty = fall through to the
    //     tree's default created-asc sort).
    //   - sort mode !== "manual" → synthesize an order array by sorting the
    //     parent's children according to the chosen mode.
    // Either way the tree's rebuild handles the actual array reordering;
    // the provider just supplies the canonical id list.
    this.tree.setOrderProvider((parentId) => {
      const folder = this.noteFolder;
      const mode = this.sortStore.getMode(folder, parentId);
      if (mode === "manual") return this.order.getOrder(folder, parentId);
      return this.computeSortedIds(parentId, mode);
    });
    this.debouncedRender = debounce(() => this.render(), 80);
  }

  getViewType(): string { return STASHPAD_VIEW_TYPE; }
  getDisplayText(): string {
    const folder = (this.noteFolder || "").trim();
    const name = folder.split("/").pop() || folder || "Stashpad";
    // When focused INTO a note, append its title so the tab/header reads
    // "FolderName — Note Title". Root focus shows just the folder name.
    if (this.focusId && this.focusId !== ROOT_ID) {
      const node = this.tree.get(this.focusId);
      if (node) {
        const title = this.titleForNode(node).trim();
        const truncated = title.length > 40 ? title.slice(0, 40) + "…" : title;
        if (truncated) return `${name} — ${truncated}`;
      }
    }
    return name;
  }

  /** Force-update both the tab header AND the in-view header title element,
   *  since updateHeader() doesn't always refresh the visible view-header DOM. */
  private refreshHeaderTitle(): void {
    const text = this.getDisplayText();
    try { (this.leaf as any).updateHeader?.(); } catch {}
    // Direct DOM update for the in-view title — reads from the leaf's view-header.
    const headerEl: HTMLElement | undefined = (this as any).headerEl ?? (this as any).containerEl?.querySelector?.(".view-header");
    const titleEl = headerEl?.querySelector?.(".view-header-title") as HTMLElement | null
      ?? (this as any).titleEl as HTMLElement | null;
    if (titleEl && titleEl.textContent !== text) titleEl.setText(text);
  }
  getIcon(): string { return "list-tree"; }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.addClass("stashpad-scroll-host");
    this.viewRoot = host.createDiv({ cls: "stashpad-view" });
    this.viewRoot.setAttribute("tabindex", "0");
    this.viewRoot.addEventListener("focusin", () => setActiveView(this));
    this.viewRoot.addEventListener("click", () => setActiveView(this));
    // Mouse side-buttons: button 3 = back, button 4 = forward.
    this.viewRoot.addEventListener("mouseup", (e) => {
      if (e.button === 3) { e.preventDefault(); this.navigateBack(); }
      else if (e.button === 4) { e.preventDefault(); this.navigateForward(); }
    });
    // Some systems fire auxclick instead.
    this.viewRoot.addEventListener("auxclick", (e) => {
      if (e.button === 3) { e.preventDefault(); this.navigateBack(); }
      else if (e.button === 4) { e.preventDefault(); this.navigateForward(); }
    });

    setActiveView(this);

    // Push a keymap Scope while focus is anywhere inside the view so
    // Escape can never warp to the previous tab. This sits BENEATH any
    // composer/popup-specific scope (those push their own on top), so
    // the popup-aware Escape handlers still win when they're active.
    // When the view loses focus entirely, we pop it so global Escape
    // behavior is restored elsewhere in Obsidian.
    let viewScope: Scope | null = null;
    const pushViewScope = (): void => {
      if (viewScope) return;
      // Pass app.scope as the parent so unhandled keys fall through to
      // Obsidian's global hotkey dispatch (Cmd+P, Cmd+O, etc.). Without
      // a parent, the new scope becomes a dead-end and every key the
      // user presses while focus is in the view gets swallowed.
      viewScope = new Scope((this.app as any).scope);
      viewScope.register([], "Escape", () => {
        // List-mode Escape: collapse multi-selection if any. Otherwise
        // a no-op — but we still return false so the workspace's
        // "Escape returns to last leaf" never fires.
        if (this.selection.size > 1) {
          const collapseTo = this.firstSelectedId
            ?? this.selection.values().next().value
            ?? null;
          this.selection.clear();
          this.firstSelectedId = null;
          if (collapseTo) {
            const idx = this.currentChildren.findIndex((n) => n.id === collapseTo);
            this.selection.add(collapseTo);
            this.lastSelected = collapseTo;
            if (idx >= 0) this.cursorIdx = idx;
          }
          this.render();
          this.revealCursorRow();
        }
        return false;
      });
      (this.app as any).keymap?.pushScope(viewScope);
    };
    const popViewScope = (): void => {
      if (!viewScope) return;
      try { (this.app as any).keymap?.popScope(viewScope); } catch {}
      viewScope = null;
    };
    this.viewRoot.addEventListener("focusin", pushViewScope);
    // focusout fires when focus moves to any element outside viewRoot.
    // Use relatedTarget to detect "leaving" — moving between children
    // (composer ↔ list) shouldn't pop the scope.
    this.viewRoot.addEventListener("focusout", (e: FocusEvent) => {
      const next = e.relatedTarget as HTMLElement | null;
      if (next && this.viewRoot && this.viewRoot.contains(next)) return;
      popViewScope();
    });
    // Pop on view teardown.
    this.register(() => popViewScope());

    this.detachTreeHook = this.tree.hookMetadataCache(() => this.debouncedRender());
    this.detachSettings = onSettingsChange(() => {
      this.loadConfig();
      // Cross-tab draft sync: if another Stashpad tab on the same folder
      // just cleared its draft (post-submit broadcast), drop our stale
      // in-memory composerDraft so it doesn't get blur-saved back to disk.
      // CRITICAL: don't wipe the live textarea if the user is actively
      // typing — that'd erase their in-progress text mid-word. We only
      // clear the in-memory copy in that case; the next blur/submit
      // will re-persist whatever they're currently typing.
      const persisted = this.plugin.settings.drafts?.[this.noteFolder] ?? "";
      const liveText = this.composerInputEl?.value ?? "";
      if (persisted === "" && this.composerDraft !== "" && liveText === "") {
        this.composerDraft = "";
        if (this.composerInputEl) this.composerInputEl.value = "";
      } else if (persisted === "" && liveText !== "") {
        // User is typing — keep their text but sync composerDraft to it
        // so the next save reflects reality.
        this.composerDraft = liveText;
      }
      // Preserve composer focus across the upcoming re-render. Without
      // this, deleting all chars in the composer (debounced empty-save
      // → loud broadcast → render tears down the textarea) silently
      // dropped focus.
      const hadComposerFocus = !!this.composerInputEl
        && document.activeElement === this.composerInputEl;
      if (hadComposerFocus) this.focusComposerOnNextRender = true;
      this.debouncedRender();
    });
    (this.app.vault as any).on("modify", this.onFileModify);
    (this.app.vault as any).on("create", this.onFileCreate);
    window.addEventListener("keydown", this.onDocKeyDown, true);
    this.loadConfig();
    await this.bootstrapFolder();
    this.tree.rebuild(this.noteFolder);
    // Subscribe the persistent "updating recovery metadata…" notice
    // to the fmSync queue's activity events. Done BEFORE the backfill
    // schedules anything so its events are caught from the first
    // pending-set change. Idempotent — only installs once per view.
    this.installFmSyncActivityNotice();
    // Now that the tree has been built from the metadata cache, run a
    // background backfill of the redundant parentLink / children fields
    // so notes from before 0.54.0 pick them up without requiring a
    // mutation. Paced; non-blocking; safe to call on every onOpen
    // (idempotent — already-correct fields are no-op writes).
    this.backfillFrontmatterSync();
    // Integrity sweep is owned by the plugin (runs once at startup), not
    // per-view. Mounting / switching Stashpad tabs no longer triggers it —
    // that was producing repeated false-missing entries when the tree was
    // mid-warm-up. See StashpadPlugin.maybeSweepFolder.
    void this.plugin.maybeSweepFolder(this.noteFolder);
    this.defaultCursorToLast();
    this.refreshHeaderTitle();
    await this.loadDraftsForFolder();
    // 0.56.14: hydrate per-focus last-cursor-note from localStorage. Used
    // by the initial render's scroll-to-id policy below — far more robust
    // than the pixel-scrollTop approach (which fought layout reflows on
    // every reload).
    try {
      const loaded = this.plugin.loadLastCursor(this.noteFolder);
      for (const [focusId, noteId] of loaded) this.lastCursorByFocus.set(focusId, noteId);
    } catch {}
    // On a fresh mount (app reload, tab restore, first-ever open), scroll
    // to the end of the list so the newest notes are visible. Once the
    // user navigates into / out of a parent, scrollByFocus has a saved
    // position for the focus and that takes precedence — no surprise
    // jumps mid-session.
    // 0.56.14: initial policy is scroll-to-id when we have a saved last
    // cursor for this focus; otherwise pin-bottom (fresh mount, no memory).
    const savedCursorId = this.lastCursorByFocus.get(this.focusId);
    let initialPolicy: ScrollPolicy;
    if (savedCursorId && this.tree.get(savedCursorId)) {
      // 0.56.16: align "start" (not "center"). captureScrollAnchor returns
      // the TOPMOST visible row, so if we centered the saved id, the
      // anchor returned on next save would be some row ABOVE it — and
      // each reload would drift upward. Aligning to "start" puts the
      // saved row at the top of the viewport, where captureScrollAnchor
      // re-picks the same row. Stable across reloads.
      initialPolicy = { kind: "scroll-to-id", id: savedCursorId, align: "start" };
      // Also restore cursor + selection to that note so the user picks
      // up exactly where they left off.
      this.pendingFocusIds = [savedCursorId];
    } else {
      this.scrollToBottomOnNextRender = true;
      initialPolicy = { kind: "pin-bottom", until: "next-user-input" };
    }
    this.render(initialPolicy);
    // Flush drafts before the app/window unloads. 0.56.17: also eager-stamp
    // last-selected cursor so reload restores by id even if the debounce
    // hasn't fired.
    this.registerDomEvent(window, "beforeunload", () => { void this.flushDrafts(); this.stampSelectedCursor(true); });
    this.registerDomEvent(window, "blur", () => { void this.flushDrafts(); this.stampSelectedCursor(true); });
    // Auto-focus the composer so users can type immediately on open.
    this.focusComposer();
    // Re-focus whenever this Stashpad leaf becomes the active one (e.g. user closes
    // a sibling tab via Cmd+W and lands back here, or switches into a Stashpad tab).
    // Also release the sticky-bottom flag when the user switches AWAY from this
    // Stashpad — leaving the tab signals their attention has moved; coming back
    // shouldn't yank the view to the bottom on the next render. Re-arming the flag
    // is the composer-submit / scrollToBottomOnNextRender path's job.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) this.focusComposer();
      else this.stickToListBottom = false;
    }));
  }

  private focusView(): void {
    // Defer to next frame so Obsidian's own focus handling has settled first.
    requestAnimationFrame(() => {
      if (!this.viewRoot?.isConnected) return;
      if (document.activeElement instanceof HTMLElement
          && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) {
        return;
      }
      this.viewRoot.focus({ preventScroll: true });
    });
  }

  /** Focus the composer input. Used when activating the view so users can type immediately.
   *  Runs multiple times to outlast Obsidian's own focus management on leaf activation. */
  private focusComposer(): void {
    const tryFocus = () => {
      if (!this.viewRoot?.isConnected) return;
      const ae = document.activeElement as HTMLElement | null;
      // Don't steal from another input/modal that the user is intentionally in.
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && ae !== this.composerInputEl) return;
      // Don't steal if user has tabbed to a button on purpose.
      if (ae && ae.tagName === "BUTTON" && this.viewRoot.contains(ae)) {
        // …unless it was just Obsidian's auto-focus to a default button (which lands during open).
        // We only respect button focus if it's been there for >150ms (handled by skipping later attempts).
      }
      this.composerInputEl?.focus({ preventScroll: true } as any);
    };
    requestAnimationFrame(tryFocus);
    setTimeout(tryFocus, 50);
    setTimeout(tryFocus, 200);
  }

  async onClose(): Promise<void> {
    clearActiveView(this);
    this.detachTreeHook?.();
    this.detachSettings?.();
    (this.app.vault as any).off("modify", this.onFileModify);
    (this.app.vault as any).off("create", this.onFileCreate);
    window.removeEventListener("keydown", this.onDocKeyDown, true);
    this.listResizeObserver?.disconnect();
    this.listResizeObserver = null;
    this.stickyRowObserver?.disconnect();
    this.stickyRowObserver = null;
    this.focusedMiniObserver?.disconnect();
    this.focusedMiniObserver = null;
    this.composerAutocomplete?.detach();
    this.composerAutocomplete = null;
    for (const d of this.slugDebouncers.values()) d.cancel();
    for (const d of this.attachmentDebouncers.values()) d.cancel();
    for (const t of this.contribTimers.values()) clearTimeout(t);
    this.contribTimers.clear();
    // Persist any in-flight draft text before tear-down. Await so Obsidian
    // doesn't unload the view before saveData() resolves.
    try { await this.flushDrafts(); } catch {}
    // Same idea for the order + sort stores, which debounce their writes
    // by 150ms. A close mid-window would otherwise drop the latest
    // reorder/sort-mode change. Both flushes are idempotent + safe to
    // call when nothing's pending.
    try { await this.order.flush(this.noteFolder); } catch {}
    try { await this.sortStore.flush(this.noteFolder); } catch {}
    // Drain any pending frontmatter sync writes so the recovery fields
    // (parentLink / children) don't lag behind tree state across a
    // close + reopen.
    try { await this.fmSync.flush(); } catch {}
    // 0.56.17: eager-stamp last-selected cursor; sync localStorage means
    // it survives the reload that follows close.
    this.stampSelectedCursor(true);
    // Tear down the fmSync failure-notice subscription so it doesn't
    // outlive the view.
    this.fmSyncUnsubscribe?.();
    this.fmSyncUnsubscribe = null;
  }

  setEphemeralState(state: unknown): void {
    const s = state as Partial<ViewConfigState> | null;
    if (s?.focusId) this.focusId = s.focusId;
    if (s?.timeFilter) this.timeFilter = s.timeFilter;
  }
  getEphemeralState(): Record<string, unknown> {
    return { focusId: this.focusId, timeFilter: this.timeFilter };
  }

  // Persisted in workspace.json — survives reloads and app restarts.
  getState(): Record<string, unknown> {
    const base = (super.getState() as Record<string, unknown>) ?? {};
    return {
      ...base,
      folderOverride: this.folderOverride,
      timeFilter: this.timeFilter,
      focusId: this.focusId,
      // Persist the per-view filter state so reloads restore the same
      // view (tag filter, calendar/rolling mode).
      tagFilter: this.tagFilter,
      colorFilter: this.colorFilter,
      timeFilterCalendar: this.timeFilterCalendar,
    };
  }
  async setState(state: unknown, result: any): Promise<void> {
    const s = (state as (Partial<ViewConfigState> & {
      folderOverride?: string | null;
      tagFilter?: string | null;
      colorFilter?: string | null;
      timeFilterCalendar?: boolean;
    }) | null) ?? null;
    if (s) {
      if ("folderOverride" in s) this.folderOverride = s.folderOverride ?? null;
      if (s.timeFilter) this.timeFilter = s.timeFilter;
      if (s.focusId) this.focusId = s.focusId;
      if ("tagFilter" in s) this.tagFilter = s.tagFilter ?? null;
      if ("colorFilter" in s) this.colorFilter = s.colorFilter ?? null;
      if ("timeFilterCalendar" in s) this.timeFilterCalendar = !!s.timeFilterCalendar;
    }
    // Resolve noteFolder immediately so getDisplayText() reflects the right folder
    // even before onOpen() has run (Obsidian queries it during view restore).
    const settingsFolder = (this.plugin?.settings?.folder ?? "stashpad").trim().replace(/^\/+|\/+$/g, "");
    const overrideFolder = this.folderOverride?.trim().replace(/^\/+|\/+$/g, "") || null;
    this.noteFolder = overrideFolder || settingsFolder || "stashpad";
    await super.setState(state, result);
    this.refreshHeaderTitle();
    // If the view is already mounted, refresh now that state has changed.
    if (this.viewRoot) {
      this.loadConfig();
      await this.bootstrapFolder();
      this.tree.rebuild(this.noteFolder);
      this.backfillFrontmatterSync();
      this.defaultCursorToLast();
      // CRITICAL: reset stale composerDraft/cache and reload drafts for the new folder.
      // Otherwise a draft from the OLD folder (set by onOpen running before setState)
      // gets blur-saved into the NEW folder's drafts entry, corrupting it.
      this.draftsLoadedFor = null;
      this.composerDraft = "";
      await this.loadDraftsForFolder();
      // 0.56.20: re-run lastCursor restore for the new folder. onOpen ran
      // against the default folder (state hadn't loaded yet); now that we
      // know the actual folder, hydrate + scroll-to-id again.
      this.lastCursorByFocus.clear();
      try {
        const loaded = this.plugin.loadLastCursor(this.noteFolder);
        for (const [focusId, noteId] of loaded) this.lastCursorByFocus.set(focusId, noteId);
      } catch {}
      const savedCursorId = this.lastCursorByFocus.get(this.focusId);
      let policy: ScrollPolicy;
      if (savedCursorId && this.tree.get(savedCursorId)) {
        this.pendingFocusIds = [savedCursorId];
        policy = { kind: "scroll-to-id", id: savedCursorId, align: "start" };
      } else {
        policy = { kind: "pin-bottom", until: "next-user-input" };
      }
      this.render(policy);
    }
  }
  focus(): void { this.viewRoot?.focus({ preventScroll: true }); }

  private loadConfig(): void {
    const settingsFolder = (this.plugin?.settings?.folder ?? "stashpad").trim().replace(/^\/+|\/+$/g, "");
    const overrideFolder = this.folderOverride?.trim().replace(/^\/+|\/+$/g, "") || null;
    const folder = overrideFolder || settingsFolder || "stashpad";
    if (folder !== this.noteFolder) {
      this.noteFolder = folder;
      this.tree.rebuild(this.noteFolder);
    } else {
      this.noteFolder = folder;
    }
  }

  private async setFolderOverride(folder: string | null): Promise<void> {
    const cleaned = folder?.trim().replace(/^\/+|\/+$/g, "") || null;
    if (cleaned && this.isReservedFolder(cleaned)) {
      new Notice(`"${cleaned}" is a reserved Stashpad subfolder (imports/exports/attachments). Pick a different folder.`);
      return;
    }
    if ((cleaned || null) === (this.folderOverride || null)) return;
    this.folderOverride = cleaned;
    this.focusId = ROOT_ID;
    this.lastCursorByFocus.clear();
    this.selection.clear();
    this.cursorIdx = -1;
    this.lastSelected = null;
    this.composerDraft = "";
    // Flush any in-flight draft writes for the previous folder, then load the new one's drafts.
    await this.flushDrafts();
    this.draftsLoadedFor = null;
    this.loadConfig();
    await this.bootstrapFolder();
    this.tree.rebuild(this.noteFolder);
    this.backfillFrontmatterSync();
    // Integrity sweep is owned by the plugin (runs once at startup), not
    // per-view. Mounting / switching Stashpad tabs no longer triggers it —
    // that was producing repeated false-missing entries when the tree was
    // mid-warm-up. See StashpadPlugin.maybeSweepFolder.
    void this.plugin.maybeSweepFolder(this.noteFolder);
    this.defaultCursorToLast();
    await this.loadDraftsForFolder();
    // Immediate (not debounced) layout save so folderOverride persists even if
    // the user reloads-without-saving right after switching folders.
    try {
      const ws: any = this.app.workspace;
      if (typeof ws.saveLayout === "function") await ws.saveLayout();
      else this.app.workspace.requestSaveLayout();
    } catch {
      this.app.workspace.requestSaveLayout();
    }
    this.refreshHeaderTitle();
    this.render();
  }

  /** Public so main.ts can dispatch a command to it. */
  cmdOpenFolderPicker(): void { this.openFolderPicker(); }

  private openFolderPicker(): void {
    // 0.57.1: limit the list to folders that ACTUALLY contain Stashpad
    // notes (per discoverStashpadFolders). Vanilla vault folders without
    // any Stashpad notes are noise here. Plugin default is always
    // present even if it doesn't have notes yet. The create-new path
    // below still lets users type any path to create a fresh folder.
    const stashpadFolders = this.plugin.discoverStashpadFolders();
    const allVaultFolders = this.listVaultFolders();
    const settingsFolder = (this.plugin.settings.folder || "stashpad").trim().replace(/^\/+|\/+$/g, "") || "stashpad";
    type Item = { kind: "default" | "folder" | "create"; folder: string; label: string };
    // Always include the settings default even if it has no notes (it's
    // where freshly-created notes go).
    const folderSet = new Set(stashpadFolders);
    if (settingsFolder) folderSet.delete(settingsFolder);
    const folders = [...folderSet].sort((a, b) => a.localeCompare(b));
    const baseItems: Item[] = [
      { kind: "default", folder: settingsFolder, label: `Use plugin default — ${settingsFolder}` },
      ...folders.map((f) => ({ kind: "folder" as const, folder: f, label: f })),
    ];
    const view = this;
    const modal = new (class extends SuggestModal<Item> {
      getSuggestions(query: string): Item[] {
        const q = query.trim().toLowerCase();
        // 0.57.0: token-order-agnostic match — every whitespace-separated
        // token must appear in the label (any order).
        const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
        const matchesAll = (haystack: string) => {
          if (!tokens.length) return true;
          for (const t of tokens) if (!haystack.includes(t)) return false;
          return true;
        };
        const filtered = q
          ? baseItems.filter((it) => matchesAll(it.label.toLowerCase()))
          : baseItems.slice();
        // Offer "create" when the query is non-empty and not an exact
        // path of an EXISTING folder in the vault (Stashpad or not).
        // Using the full allVaultFolders list here — not just Stashpad
        // ones — so typing the name of a vanilla folder doesn't show a
        // misleading "Create" suggestion.
        const cleaned = query.trim().replace(/^\/+|\/+$/g, "");
        if (cleaned
            && !allVaultFolders.some((f) => f.toLowerCase() === cleaned.toLowerCase())
            && !view.isReservedFolder(cleaned)) {
          const cased = properCaseFolderPath(cleaned);
          filtered.push({ kind: "create", folder: cleaned, label: `+ Create folder “${cased}”` });
        }
        return filtered;
      }
      renderSuggestion(item: Item, el: HTMLElement): void {
        el.createDiv({ cls: "stashpad-suggest-title", text: item.label });
        if (item.kind === "create") el.addClass("stashpad-suggest-create");
      }
      async onChooseSuggestion(item: Item): Promise<void> {
        if (item.kind === "default") { void view.setFolderOverride(null); return; }
        if (item.kind === "create") {
          try {
            const properCased = properCaseFolderPath(item.folder);
            await view.ensureFolder(properCased);
            await view.setFolderOverride(properCased);
          } catch (e) {
            new Notice(`Stashpad: couldn't create folder (${(e as Error).message})`);
          }
          return;
        }
        void view.setFolderOverride(item.folder);
      }
    })(this.app);
    modal.setPlaceholder("Pick a folder, or type a new path to create one…");
    modal.open();
  }

  private listVaultFolders(): string[] {
    const out: string[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder) {
        if (f.path === "/" || f.path === "") continue;
        if (f.path.startsWith(".")) continue;
        if (this.isReservedFolder(f.path)) continue;
        out.push(f.path);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  /** True if the folder path's last segment is one of our reserved subfolder names. */
  private isReservedFolder(path: string): boolean {
    const last = path.split("/").filter(Boolean).pop() ?? "";
    if (!last) return false;
    const reserved = new Set(
      [
        this.plugin.settings.importDropFolder,
        this.plugin.settings.exportFolder,
        "_attachments",
        "_processed",
        "_authors",
      ]
        .map((s) => (s ?? "").trim().replace(/^\/+|\/+$/g, ""))
        .filter(Boolean),
    );
    return reserved.has(last);
  }
  /** Push the current focusId/timeFilter into workspace.json. getEphemeralState
   *  alone isn't enough — Obsidian only writes layout on saveLayout, and
   *  without explicitly nudging it, navigating then immediately reloading
   *  loses the new focus. requestSaveLayout is debounced by Obsidian so
   *  rapid navigation won't thrash disk. */
  private persistFocus(): void {
    try { this.app.workspace.requestSaveLayout(); } catch {}
  }

  // --- Undo / Redo ---

  cmdUndo(): void {
    const stack = this.plugin.getUndoStack(this.noteFolder);
    if (!stack.canUndo()) { new Notice("Nothing to undo."); return; } // info — keep raw
    const label = stack.peekUndoLabel();
    // Lazy category propagation: read the most-recent notification's
    // category and re-use it for the undo toast. This makes the
    // undone action show up under the appropriate filter in history
    // (e.g. undoing a delete files under "delete" instead of
    // "system"). `system` remains the fallback if there's no recent
    // record or it's unrelated.
    const recentCat = this.plugin.notifications.recent()[0]?.category ?? "system";
    void stack.undo()
      .then(() => this.plugin.notifications.show({
        message: `Undid: ${label}`,
        kind: "info",
        category: recentCat,
        folder: this.noteFolder,
      }))
      .catch((e: any) => this.plugin.notifications.show({
        message: `Undo failed: ${(e as Error).message}`,
        kind: "error",
        category: "system",
        folder: this.noteFolder,
      }));
  }

  cmdRedo(): void {
    const stack = this.plugin.getUndoStack(this.noteFolder);
    if (!stack.canRedo()) { new Notice("Nothing to redo."); return; }
    const label = stack.peekRedoLabel();
    const recentCat = this.plugin.notifications.recent()[0]?.category ?? "system";
    void stack.redo()
      .then(() => this.plugin.notifications.show({
        message: `Redid: ${label}`,
        kind: "info",
        category: recentCat,
        folder: this.noteFolder,
      }))
      .catch((e: any) => this.plugin.notifications.show({
        message: `Redo failed: ${(e as Error).message}`,
        kind: "error",
        category: "system",
        folder: this.noteFolder,
      }));
  }

  /** Snapshot a set of notes (and optionally their attachments) so we can recreate them.
   *
   *  Network-drive-aware: every read in here used to be `await`-in-a-loop, which
   *  becomes round-trip × N on slow drives. Now we:
   *    1. Dedupe paths up front and read all bodies in one Promise.all.
   *    2. Reuse those bodies for the attachment scan (the previous version
   *       did a second serial `vault.read` over the same files just to find
   *       attachment refs — N extra round-trips for no reason).
   *    3. Read all attachment binaries in one Promise.all.
   *
   *  Order of `noteSnaps` is the order `nodes` was passed in (first occurrence
   *  for duplicates) — restoreSnapshots / trashNotesAndAttachments don't
   *  depend on a specific order, so this is safe. */
  private async snapshotNotes(nodes: TreeNode[], includeAttachments: boolean):
    Promise<{ notes: { path: string; content: string }[]; attachments: { path: string; data: ArrayBuffer }[] }> {
    // Step 1: gather unique files in first-seen order.
    const uniqueFiles: TFile[] = [];
    const seenPaths = new Set<string>();
    for (const n of nodes) {
      if (!n.file || seenPaths.has(n.file.path)) continue;
      seenPaths.add(n.file.path);
      uniqueFiles.push(n.file);
    }
    // Step 2: parallel read every note body in one batch.
    const contents = await Promise.all(uniqueFiles.map((f) => this.app.vault.read(f)));
    const noteSnaps = uniqueFiles.map((f, i) => ({ path: f.path, content: contents[i] }));

    // Step 3: attachment scan reuses `contents` — no second read pass.
    const attSnaps: { path: string; data: ArrayBuffer }[] = [];
    if (includeAttachments) {
      const seenAtt = new Set<string>();
      const attFiles: TFile[] = [];
      for (const md of contents) {
        for (const ref of this.extractAttachments(this.stripFrontmatter(md))) {
          const f = this.app.metadataCache.getFirstLinkpathDest(ref, "");
          if (f && !seenAtt.has(f.path)) {
            seenAtt.add(f.path);
            attFiles.push(f);
          }
        }
      }
      // Step 4: parallel readBinary for every unique attachment.
      const datas = await Promise.all(attFiles.map((f) => this.app.vault.readBinary(f)));
      for (let i = 0; i < attFiles.length; i++) {
        attSnaps.push({ path: attFiles[i].path, data: datas[i] });
      }
    }
    return { notes: noteSnaps, attachments: attSnaps };
  }

  /** Recreate notes/attachments from a snapshot (skip ones that already exist). */
  private async restoreSnapshots(
    snap: { notes: { path: string; content: string }[]; attachments: { path: string; data: ArrayBuffer }[] },
    focusIds?: StashpadId[],
  ): Promise<void> {
    for (const a of snap.attachments) {
      try {
        if (!(await this.app.vault.adapter.exists(a.path))) {
          await this.app.vault.createBinary(a.path, a.data);
        }
      } catch {}
    }
    for (const n of snap.notes) {
      try {
        if (!(await this.app.vault.adapter.exists(n.path))) {
          await this.app.vault.create(n.path, n.content);
        }
      } catch {}
    }
    // Re-apply pendingFocusIds on every pass so the cursor lands on the restored
    // notes once the metadata cache catches up. Stop once they're found.
    // 0.56.6: follow-cursor policy on each render so the restored note is
    // scrolled into view, not just selected. Particularly important for
    // undo-of-delete where the previously-deleted row needs to reappear in
    // the viewport so the user can see what just came back.
    const tryFocus = () => {
      if (focusIds) {
        const inList = focusIds.some((id) => this.tree.get(id));
        if (inList) this.pendingFocusIds = focusIds.slice();
      }
    };
    tryFocus();
    this.tree.rebuild(this.noteFolder);
    this.render({ kind: "follow-cursor" });
    setTimeout(() => { tryFocus(); this.tree.rebuild(this.noteFolder); this.render({ kind: "follow-cursor" }); }, 100);
    setTimeout(() => { tryFocus(); this.tree.rebuild(this.noteFolder); this.render({ kind: "follow-cursor" }); }, 400);
    // Restored notes carry their pre-delete frontmatter — which may
    // include stale parentLink / children from before the tree
    // evolved. Schedule the restored ids (and any parent they now
    // point at) for re-sync so recovery fields land consistent with
    // the live tree, not the snapshot.
    setTimeout(() => {
      for (const n of snap.notes) {
        const id = this.tree.idForPath(n.path);
        if (id) this.fmSync.schedule(id);
      }
    }, 500);
  }

  private async trashNotesAndAttachments(snap: { notes: { path: string; content: string }[]; attachments: { path: string; data: ArrayBuffer }[] }): Promise<void> {
    // Collect parents BEFORE the trash so we can re-sync their children
    // lists after the deletion settles.
    const orphanedParents = new Set<StashpadId>();
    for (const n of snap.notes) {
      const id = this.tree.idForPath(n.path);
      if (!id) continue;
      const node = this.tree.get(id);
      if (node?.parent) orphanedParents.add(node.parent);
    }
    // Trash notes (children before parents — already in that order from our delete walk).
    for (const n of snap.notes) {
      const f = this.app.vault.getAbstractFileByPath(n.path) as TFile | null;
      if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
    }
    for (const a of snap.attachments) {
      const f = this.app.vault.getAbstractFileByPath(a.path) as TFile | null;
      if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
    }
    this.tree.rebuild(this.noteFolder);
    this.render();
    for (const pid of orphanedParents) this.fmSync.scheduleParentOfDeleted(pid);
  }

  // --- Per-folder composer drafts (one shared draft per Stashpad folder) ---

  private async loadDraftsForFolder(): Promise<void> {
    if (this.draftsLoadedFor === this.noteFolder) return;
    this.draftsLoadedFor = this.noteFolder;
    const all = this.plugin.settings.drafts ?? {};
    this.composerDraft = all[this.noteFolder] ?? "";
    console.debug("[Stashpad] loadDrafts", { folder: this.noteFolder, has: !!all[this.noteFolder], available: Object.keys(all) });
  }

  private async saveDraft(text: string): Promise<void> {
    try {
      // Snapshot the folder we're saving for, in case noteFolder changes mid-await.
      const folder = this.noteFolder;
      const existing = this.plugin.settings.drafts?.[folder] ?? "";
      // No-op when the slot already matches the desired state. Without
      // this, blur events from torn-down textareas during render would
      // fire saveDraft("") even though the slot was already empty,
      // looping through saveSettings → broadcast → render → blur and
      // producing a visible focus-border flicker on the new composer.
      if (existing === text) return;
      const all = { ...(this.plugin.settings.drafts ?? {}) };
      if (text.length === 0) delete all[folder];
      else all[folder] = text;
      this.plugin.settings.drafts = all;
      // Cleared drafts (post-submit) broadcast via saveSettings so OTHER
      // Stashpad tabs viewing the same folder drop their stale in-memory
      // composerDraft and don't write it back on the next blur. Mid-typing
      // saves stay quiet to avoid focus-stealing re-render storms.
      if (text.length === 0) await this.plugin.saveSettings();
      else await this.plugin.persistSettingsQuiet();
    } catch (e) { console.warn("Stashpad: drafts save failed", e); }
  }

  private async recordLastSubmitted(text: string): Promise<void> {
    try {
      const all = { ...(this.plugin.settings.lastSubmitted ?? {}) };
      all[this.noteFolder] = text;
      this.plugin.settings.lastSubmitted = all;
      await this.plugin.persistSettingsQuiet();
    } catch {}
  }

  /** True if there's a saved draft for this folder that's worth offering to restore. */
  private hasRestorableDraft(): boolean {
    const saved = this.plugin.settings.drafts?.[this.noteFolder];
    if (!saved || !saved.trim()) return false;
    const last = this.plugin.settings.lastSubmitted?.[this.noteFolder];
    if (last && last === saved) return false; // Auto-clear didn't land but the text was just sent.
    return true;
  }

  /** Kept as a no-op (called from old call sites). The per-folder draft doesn't change with focus. */
  private syncComposerDraftForFocus(): void { /* per-folder, not per-focus anymore */ }
  /** Kept as alias for backwards compat with old call sites. */
  private async flushDrafts(): Promise<void> {
    if (this.composerInputEl) await this.saveDraft(this.composerInputEl.value);
    else await this.saveDraft(this.composerDraft);
  }

  private timeFilterCutoff(): number | null {
    if (this.timeFilter === "all") return null;
    if (this.timeFilterCalendar) {
      // Calendar-aligned: start of today / this week (Monday) / this
      // month / this year, in the user's local timezone via moment.
      const m = (moment as any)();
      switch (this.timeFilter) {
        case "day":   return m.startOf("day").valueOf();
        case "week":  return m.startOf("isoWeek").valueOf();
        case "month": return m.startOf("month").valueOf();
        case "year":  return m.startOf("year").valueOf();
      }
    }
    // Rolling N-day windows from "now" — the original behavior.
    const now = Date.now();
    switch (this.timeFilter) {
      case "day": return now - 86400_000;
      case "week": return now - 7 * 86400_000;
      case "month": return now - 30 * 86400_000;
      case "year": return now - 365 * 86400_000;
    }
    return null;
  }
  private allowedByBases(): Set<string> | null { return null; }
  /** Per-folder view mode lookup. Absent entry = "nested" (the default). */
  private currentViewMode(): ViewMode {
    return this.plugin.settings.viewModes?.[this.noteFolder] ?? "nested";
  }

  /** Per-folder "include attachments in Everything mode" flag. Defaults
   *  to false — attachments already appear inline on the notes that
   *  reference them, so duplicating them in the main list is noise. */
  private currentIncludeAttachments(): boolean {
    return !!this.plugin.settings.includeAttachmentsInEverything?.[this.noteFolder];
  }
  private async setIncludeAttachments(on: boolean): Promise<void> {
    const map = { ...(this.plugin.settings.includeAttachmentsInEverything ?? {}) };
    if (!on) delete map[this.noteFolder];
    else map[this.noteFolder] = true;
    this.plugin.settings.includeAttachmentsInEverything = map;
    await this.plugin.saveSettings();
  }

  /** Per-folder filter: when true, hide top-level notes that have no
   *  children. Structural (applies to the top of the displayed list,
   *  not recursively into descendants) — see settings jsdoc. Default
   *  off. */
  private currentHideChildless(): boolean {
    return !!this.plugin.settings.hideChildlessNotes?.[this.noteFolder];
  }
  private async setHideChildless(on: boolean): Promise<void> {
    const map = { ...(this.plugin.settings.hideChildlessNotes ?? {}) };
    if (!on) delete map[this.noteFolder];
    else map[this.noteFolder] = true;
    this.plugin.settings.hideChildlessNotes = map;
    await this.plugin.saveSettings();
  }

  /** Per-folder filter: hide completed notes, unless they still have any
   *  incomplete descendant somewhere in their subtree. Default off. */
  private currentHideCompleted(): boolean {
    return !!this.plugin.settings.hideCompletedNotes?.[this.noteFolder];
  }
  private async setHideCompleted(on: boolean): Promise<void> {
    const map = { ...(this.plugin.settings.hideCompletedNotes ?? {}) };
    if (!on) delete map[this.noteFolder];
    else map[this.noteFolder] = true;
    this.plugin.settings.hideCompletedNotes = map;
    await this.plugin.saveSettings();
  }

  /** True when any descendant of `node` is NOT completed. Used by the
   *  hide-completed filter to keep parents visible while their subtree
   *  still has work. Recurses depth-first; bails as soon as it finds
   *  one incomplete descendant. */
  private hasIncompleteDescendant(node: TreeNode): boolean {
    for (const cid of node.children) {
      const child = this.tree.get(cid);
      if (!child) continue;
      if (!this.isCompleted(child)) return true;
      if (this.hasIncompleteDescendant(child)) return true;
    }
    return false;
  }

  /** Set of paths embedded as attachments in the Stashpad notes of the
   *  current folder. Used to hide attachments from the Everything-mode
   *  file list (unless includeAttachments is on). Reads frontmatter
   *  `attachments:` from every node so a malformed body (missing
   *  brackets) doesn't accidentally surface the attachment as a stray
   *  file. */
  private collectEmbeddedAttachmentPaths(): Set<string> {
    const out = new Set<string>();
    const folder = this.noteFolder;
    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) return out;
    const stack: TFolder[] = [root];
    while (stack.length) {
      const f = stack.pop()!;
      for (const child of f.children) {
        if (child instanceof TFolder) { stack.push(child); continue; }
        if (!(child instanceof TFile) || child.extension !== "md") continue;
        const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
        if (!fm || !Array.isArray(fm.attachments)) continue;
        for (const a of fm.attachments) {
          if (typeof a !== "string") continue;
          // attachments may be stored as bare path or with a leading slash;
          // resolve via Obsidian's linkpath resolver when possible, fall
          // back to literal path.
          const resolved = this.app.metadataCache.getFirstLinkpathDest(a, child.path);
          if (resolved) out.add(resolved.path);
          else out.add(a);
        }
      }
    }
    return out;
  }

  /** Collect non-Stashpad-note files for Everything mode. Always folder-wide
   *  (non-Stashpad files don't belong to any note), regardless of focus.
   *  Excludes:
   *    - .md files (Stashpad notes are handled via the TreeNode pipeline)
   *    - Reserved Stashpad subfolders: _authors, _imports, _exports,
   *      _processed (and _attachments unless includeAttachments is on)
   *    - The sidecar JSON files (.stashpad-order.json, .stashpad-sort.json)
   *    - Files referenced as attachments inside notes (unless includeAtts)
   */
  private collectFileItems(_focusId: StashpadId): TFile[] {
    const folder = this.noteFolder;
    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) return [];
    const includeAtts = this.currentIncludeAttachments();
    const embedded = includeAtts ? new Set<string>() : this.collectEmbeddedAttachmentPaths();
    const RESERVED_SUBFOLDERS = new Set(["_authors", "_imports", "_exports", "_processed"]);
    const out: TFile[] = [];
    const stack: TFolder[] = [root];
    while (stack.length) {
      const f = stack.pop()!;
      for (const child of f.children) {
        if (child instanceof TFolder) {
          // Filter reserved subfolders only at the top level — nested
          // user folders named "_authors" inside arbitrary notes are
          // unlikely; this guard mirrors how the bootstrap creates them.
          const relName = child.name;
          if (f === root && RESERVED_SUBFOLDERS.has(relName)) continue;
          if (f === root && relName === "_attachments" && !includeAtts) continue;
          stack.push(child);
          continue;
        }
        if (!(child instanceof TFile)) continue;
        if (child.extension === "md") continue; // Stashpad notes go through TreeNode
        // Skip Stashpad's own JSON sidecars.
        if (child.name === ".stashpad-order.json" || child.name === ".stashpad-sort.json") continue;
        // Hide attachments that are already embedded in some note unless
        // the user has explicitly opted in.
        if (!includeAtts && embedded.has(child.path)) continue;
        out.push(child);
      }
    }
    return out;
  }

  /** Render a non-Stashpad file row in Everything mode. Single-line layout:
   *  ctime + filename + extension badge. Click opens via Obsidian's default
   *  handler (`workspace.openLinkText`), which routes images/PDFs/etc. to
   *  the right viewer. File rows are intentionally simple — they're not
   *  selectable, draggable, or part of the keyboard-nav cursor. */
  /** Populate the list container with the current children + (in
   *  Everything mode) interleaved file rows. Pulled out of render() so
   *  refreshList() can reuse the same logic to re-paint just the list
   *  without rebuilding the header bar / focused header / composer —
   *  used when a checkbox toggles a filter and the user expects the
   *  list to update without the full-view flicker. */
  private populateListBody(list: HTMLElement, focused: TreeNode): void {
    if (focused.file && Platform.isMobile) {
      this.renderFocusedHeaderMini(list, focused);
      this.renderFocusedHeader(list, focused);
    }
    // Render path.
    //   - Nested / Flat: pure Stashpad-note list, rendered in order.
    //   - Everything: interleave Stashpad notes with non-Stashpad files
    //     from the same folder, sorted by created (notes) / ctime (files).
    //     File rows are click-to-open and not part of the selection /
    //     cursor / keyboard-nav model.
    const mode = this.currentViewMode();
    const fileItems = mode === "everything" ? this.collectFileItems(focused.id) : [];
    if (this.currentChildren.length === 0 && fileItems.length === 0) {
      list.createDiv({ cls: "stashpad-empty", text: "No notes here yet. Type below to add one." });
    } else if (fileItems.length === 0) {
      for (let i = 0; i < this.currentChildren.length; i++) this.renderNote(list, this.currentChildren[i], i);
    } else {
      type Item =
        | { kind: "note"; ts: number; idx: number }
        | { kind: "file"; ts: number; file: TFile };
      const noteItems: Item[] = this.currentChildren.map((n, idx) => {
        const t = Number.isFinite(Date.parse(n.created)) ? Date.parse(n.created) : 0;
        return { kind: "note", ts: t, idx };
      });
      const items: Item[] = [
        ...noteItems,
        ...fileItems.map((f) => ({ kind: "file" as const, ts: f.stat.ctime, file: f })),
      ];
      items.sort((a, b) => a.ts - b.ts);
      for (const it of items) {
        if (it.kind === "note") this.renderNote(list, this.currentChildren[it.idx], it.idx);
        else this.renderFileRow(list, it.file);
      }
    }
    if (focused.file && Platform.isMobile) this.installFocusedMiniObserver(list);
  }

  /** Re-paint just the list. Used after a filter / view-toggle setting
   *  changes — the header bar, focused header, and composer don't need
   *  to be rebuilt, and rebuilding them caused the visible flicker /
   *  apparent "reload" on mobile. Falls back to a full render() if
   *  listEl isn't around yet (first paint / view hasn't mounted). */
  refreshList(): void {
    if (!this.listEl) { this.render(); return; }
    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    this.currentChildren = this.filterChildren(this.collectViewItems(focused.id));
    // Clamp cursor to new length so arrow-key nav doesn't land out-of-bounds.
    if (this.cursorIdx >= this.currentChildren.length) {
      this.cursorIdx = this.currentChildren.length - 1;
    }
    // Preserve scroll. emptying + repopulating the list resets scrollTop
    // to 0; re-apply afterward so a toggle (like Calendar mode) doesn't
    // jump the user to the top of the list. Falls back to "bottom" when
    // we were already pinned to the bottom, so chronological views that
    // people scroll to the latest item don't visually drift.
    const prevAtBottom = this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 2;
    const prevScroll = this.listEl.scrollTop;
    this.listEl.empty();
    this.populateListBody(this.listEl, focused);
    if (prevAtBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
    else this.listEl.scrollTop = prevScroll;
  }

  private renderFileRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "stashpad-file-row" });
    row.dataset.path = file.path;
    const meta = row.createDiv({ cls: "stashpad-file-meta" });
    meta.createSpan({ cls: "stashpad-file-time", text: this.formatTime(new Date(file.stat.ctime).toISOString()) });
    const body = row.createDiv({ cls: "stashpad-file-body" });
    body.createSpan({ cls: "stashpad-file-name", text: file.name });
    body.createSpan({ cls: "stashpad-file-ext", text: file.extension.toUpperCase() });
    row.title = `${file.path} — click to open`;
    row.onclick = (e) => {
      e.preventDefault();
      // openLinkText with the file's path opens it in Obsidian's default
      // viewer for the extension (PDF viewer, image preview, etc.).
      this.app.workspace.openLinkText(file.path, "", false);
    };
  }

  /** Persist a new view mode for the current folder. "nested" deletes the
   *  entry (keeps data.json compact — it's the default). */
  private async setViewMode(mode: ViewMode): Promise<void> {
    const map = { ...(this.plugin.settings.viewModes ?? {}) };
    if (mode === "nested") delete map[this.noteFolder];
    else map[this.noteFolder] = mode;
    this.plugin.settings.viewModes = map;
    await this.plugin.saveSettings();
  }

  /** Resolve the set of TreeNodes that should populate the list under
   *  the current focus + view mode + hide-childless filter.
   *
   *  Hide-childless is STRUCTURAL — it's applied at the top level only:
   *    - Nested: filter the immediate children of focus directly.
   *    - Flat / Everything: filter the immediate children of focus,
   *      THEN expand each survivor's full subtree into the flat list.
   *      Descendants are NOT re-filtered — the whole point of the toggle
   *      in these modes is "find every parent and scan its subtree for
   *      tasks," so hiding descendant leaves would defeat the purpose.
   *
   *  Content filters (tag / color / time) apply later via
   *  filterChildren and operate on every visible item uniformly. */
  private collectViewItems(focusId: StashpadId): TreeNode[] {
    const mode = this.currentViewMode();
    const hideChildless = this.currentHideChildless();
    const topLevel = this.tree.getChildren(focusId);
    const survivingTopLevel = hideChildless
      ? topLevel.filter((c) => c.children.length > 0)
      : topLevel;

    if (mode === "nested") return survivingTopLevel;

    // Flat / Everything: include each surviving top-level child AND every
    // descendant of it (descendants pass through regardless of childless
    // status — see jsdoc).
    const out: TreeNode[] = [];
    const walk = (node: TreeNode): void => {
      out.push(node);
      for (const child of this.tree.getChildren(node.id)) walk(child);
    };
    for (const top of survivingTopLevel) walk(top);
    return out;
  }

  private filterChildren(children: TreeNode[]): TreeNode[] {
    const cutoff = this.timeFilterCutoff();
    const tag = this.tagFilter?.toLowerCase();
    const color = this.colorFilter?.toLowerCase() ?? null;
    const hideCompleted = this.currentHideCompleted();
    if (!cutoff && !tag && !color && !hideCompleted) return children;
    return children.filter((n) => {
      if (cutoff && n.created) {
        const t = Date.parse(n.created);
        if (!Number.isNaN(t) && t < cutoff) return false;
      }
      if (tag) {
        if (!n.file) return false;
        if (!this.nodeHasTag(n, tag)) return false;
      }
      if (color) {
        const c = this.colorForNode(n)?.toLowerCase() ?? null;
        if (c !== color) return false;
      }
      // Hide-completed: applied uniformly. A completed note disappears
      // only when its subtree has no remaining work — so a category
      // checked off but still containing an unchecked task stays
      // visible until the last task is done.
      if (hideCompleted && this.isCompleted(n) && !this.hasIncompleteDescendant(n)) return false;
      return true;
    });
  }

  /** True if `node`'s file carries `tag` (case-insensitive) — checks
   *  inline tags AND frontmatter `tags`. */
  private nodeHasTag(node: TreeNode, tagLower: string): boolean {
    if (!node.file) return false;
    const cache = this.app.metadataCache.getFileCache(node.file);
    if (!cache) return false;
    if (cache.tags) {
      for (const t of cache.tags) {
        const raw = (t.tag || "").replace(/^#/, "").toLowerCase();
        if (raw === tagLower) return true;
      }
    }
    const fmTags = cache.frontmatter?.tags;
    if (fmTags) {
      const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
      for (const t of arr) {
        if (typeof t === "string" && t.replace(/^#/, "").toLowerCase() === tagLower) return true;
      }
    }
    return false;
  }

  /** Tally tags found on the IMMEDIATE children of the current focus.
   *  filterChildren operates on the same set, so the dropdown contents
   *  always match what the filter can act on — no "tag is shown but
   *  selecting it gives zero results" surprises from grandchildren-
   *  only tags. Tags deeper in the subtree only surface once you
   *  navigate down to that level. Sorted by frequency desc, ties
   *  alphabetical. */
  private collectFolderTags(): Array<{ raw: string; label: string; count: number }> {
    const counts = new Map<string, number>();
    const kids = this.tree.getChildren(this.focusId);
    for (const node of kids) {
      if (!node.file) continue;
      const cache = this.app.metadataCache.getFileCache(node.file);
      if (cache?.tags) {
        for (const t of cache.tags) {
          const raw = (t.tag || "").replace(/^#/, "");
          if (raw) counts.set(raw, (counts.get(raw) ?? 0) + 1);
        }
      }
      const fmTags = cache?.frontmatter?.tags;
      if (fmTags) {
        const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
        for (const t of arr) {
          if (typeof t !== "string") continue;
          const raw = t.replace(/^#/, "");
          if (raw) counts.set(raw, (counts.get(raw) ?? 0) + 1);
        }
      }
    }
    const out = [...counts.entries()].map(([raw, count]) => ({
      raw, count, label: this.formatTagLabel(raw),
    }));
    out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return out;
  }

  /** Display form for a tag: split on - / _ / camelCase boundaries,
   *  capitalize the first letter of each piece, preserve any other
   *  caps the user already typed, join with a space. */
  private formatTagLabel(raw: string): string {
    if (!raw) return raw;
    // Split nested tags by "/" and process each segment, then rejoin.
    return raw.split("/").map((seg) => {
      // Insert spaces at camelCase boundaries (lowercase → Uppercase),
      // then split on - and _ as well.
      const withSpaces = seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
      const pieces = withSpaces.split(/[-_\s]+/).filter(Boolean);
      return pieces.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
    }).join(" / ");
  }

  /** Tally per-note colors found on the IMMEDIATE children of the
   *  current focus. Same scoping as collectFolderTags so the dropdown
   *  matches the filter exactly. Returns hex strings (lower-cased) +
   *  count, sorted by frequency desc, ties by hex string. */
  private collectFolderColors(): Array<{ hex: string; count: number }> {
    const counts = new Map<string, number>();
    const kids = this.tree.getChildren(this.focusId);
    for (const node of kids) {
      const c = this.colorForNode(node);
      if (!c) continue;
      const k = c.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out = [...counts.entries()].map(([hex, count]) => ({ hex, count }));
    out.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
    return out;
  }

  private defaultCursorToLast(): void {
    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    const kids = this.filterChildren(this.collectViewItems(focused.id));
    this.cursorIdx = kids.length - 1;
    this.selection.clear();
    if (kids.length > 0) {
      this.selection.add(kids[kids.length - 1].id);
      this.lastSelected = kids[kids.length - 1].id;
    }
  }

  /** Persist the current cursor row's id as "last selected" for this focus.
   *  Drives reload's scroll-to-id restoration. Debounced 400ms so a
   *  flurry of arrow-key cursor moves doesn't hammer localStorage —
   *  the eager onClose / blur / navigateTo / navigateUp paths flush
   *  immediately. 0.56.17. */
  private stampLastCursorTimer: number | null = null;
  private stampSelectedCursor(eager = false): void {
    const node = this.currentChildren[this.cursorIdx];
    const id = node?.id ?? this.lastSelected;
    if (!id) return;
    this.lastCursorByFocus.set(this.focusId, id);
    const flush = () => {
      const cur = this.lastCursorByFocus.get(this.focusId);
      if (cur) this.plugin.saveLastCursor(this.noteFolder, this.focusId, cur);
    };
    if (eager) {
      if (this.stampLastCursorTimer != null) window.clearTimeout(this.stampLastCursorTimer);
      this.stampLastCursorTimer = null;
      flush();
      return;
    }
    if (this.stampLastCursorTimer != null) window.clearTimeout(this.stampLastCursorTimer);
    this.stampLastCursorTimer = window.setTimeout(() => {
      this.stampLastCursorTimer = null;
      flush();
    }, 400);
  }

  /** Snapshot of "what row is the user looking at" so the post-render
   *  block can re-scroll to keep that row at the same on-screen position.
   *  Pixel-only prevScroll restoration can't do this — if rows ABOVE the
   *  viewport shift in height between renders (markdown re-render of a
   *  long note, attachment rail growing, sibling reorder), the same
   *  scrollTop value now shows different content.
   *
   *  Pick policy: the topmost row whose top is inside the viewport. Fall
   *  back to the first row whose bottom is inside (handles the case where
   *  one tall row straddles the entire viewport). Returns null when the
   *  list is empty / no row qualifies. */
  private captureScrollAnchor(): { id: StashpadId; offsetFromListTop: number } | null {
    const list = this.listEl;
    if (!list) return null;
    const listTop = list.getBoundingClientRect().top;
    const rows = Array.from(list.querySelectorAll(".stashpad-note")) as HTMLElement[];
    if (rows.length === 0) return null;
    let best: { id: StashpadId; offsetFromListTop: number } | null = null;
    for (const row of rows) {
      const id = row.dataset.id;
      if (!id) continue;
      const top = row.getBoundingClientRect().top - listTop;
      // First row whose top is inside the viewport (top >= 0) wins.
      if (top >= 0) {
        best = { id, offsetFromListTop: top };
        break;
      }
      // Otherwise remember the most recent row whose top is above viewport;
      // that's the row currently filling the top of the viewport.
      best = { id, offsetFromListTop: top };
    }
    return best;
  }

  /** Restore the anchor row to its captured viewport offset. Falls back to
   *  the pixel scrollTop if the anchor row is gone (deleted, filtered out,
   *  navigated past). */
  private restoreScrollAnchor(
    anchor: { id: StashpadId; offsetFromListTop: number } | null,
    fallbackScrollTop: number,
  ): void {
    const list = this.listEl;
    if (!list) return;
    if (anchor) {
      const row = list.querySelector(`[data-id="${anchor.id}"]`) as HTMLElement | null;
      if (row) {
        const listTop = list.getBoundingClientRect().top;
        const rowTop = row.getBoundingClientRect().top - listTop;
        // Adjust scrollTop by the delta so rowTop ends up at offsetFromListTop.
        list.scrollTop += rowTop - anchor.offsetFromListTop;
        return;
      }
    }
    if (fallbackScrollTop > 0) list.scrollTop = fallbackScrollTop;
  }

  private render(policy?: ScrollPolicy): void {
    // 0.56.3: unannotated render() calls default to "preserve". That kills
    // the bouncing class of regressions where metadataCache-driven
    // re-renders (color change, frontmatter mod, fmSync rewrites) would
    // pin the view to the bottom via the legacy prevAtBottom geometric
    // inference. The few sites that genuinely want a different policy
    // (composer submit → pin-bottom; the 3 already-annotated nav sites)
    // pass an explicit policy.
    //
    // Legacy `scrollToBottomOnNextRender` is still honoured as an override
    // within the preserve branch until 0.56.4 converts composer submit to
    // pass an explicit pin-bottom policy directly.
    this.pendingRenderPolicy = policy ?? { kind: "preserve" };
    this.loadConfig();
    const root = this.viewRoot;
    const prevScroll = this.listEl?.scrollTop ?? 0;
    // 0.56.4: scroll anchoring. Capture the row whose top is closest to the
    // viewport top (preferring rows fully inside the viewport over ones
    // straddling the boundary). Its id + the offset between its rect.top
    // and the list's rect.top lets the post-render block re-scroll so the
    // SAME row sits at the SAME visual position — eliminating the bouncing
    // caused by height shifts in rows ABOVE the viewport (which
    // pixel-only prevScroll restoration can't compensate for).
    const anchor = this.captureScrollAnchor();
    // Preserve composer focus across the rebuild. Without this, every
    // render that rebuilds the textarea drops focus for a frame and the
    // user sees the focus border flicker — especially noticeable when
    // multiple renders fire in quick succession (nav + metadataCache
    // hook + settings broadcast). Capture caret position too so it
    // doesn't snap back to the start.
    const composerHadFocus = !!this.composerInputEl
      && document.activeElement === this.composerInputEl;
    if (composerHadFocus) {
      this.focusComposerOnNextRender = true;
      this.pendingComposerCaret = this.composerInputEl?.selectionStart ?? null;
    }
    // Detect "at bottom" before tearing down the list. If we were within ~2px
    // of the bottom, the post-render restore should re-pin to the new
    // scrollHeight rather than the literal old scrollTop — otherwise tiny
    // height fluctuations between renders (markdown re-render, border swap)
    // leave us a row or two short of the bottom.
    // stickToListBottom is the source of truth for "user wants to be at
    // bottom" — when it's set, treat as at-bottom even if the geometric
    // check disagrees. The geometric check has a 2px tolerance, but if
    // scrollHeight grew by more than 2px since the last pin (cold-cache
    // markdown / image / font growth), the check fails and the
    // `else if (prevScroll > 0)` branch below would restore the
    // now-stale prevScroll, freezing the view at the old "bottom" which
    // is now mid-list. Honouring stickToListBottom shortcircuits that.
    const prevAtBottom = !!this.listEl
      && (this.stickToListBottom
        || this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 2);
    root.empty();
    root.toggleClass("is-mobile", Platform.isMobile);

    this.renderTimeFilterBar(root);
    this.renderBreadcrumb(root);

    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    // On desktop the focused header sits above the list (pinned). On
    // mobile it's appended INTO the list as the first child so it scrolls
    // with the rows — see further down. A 1-line sticky mini preview
    // appears at the top of the list when the full header scrolls out.
    if (focused.file && !Platform.isMobile) this.renderFocusedHeader(root, focused);

    this.currentChildren = this.filterChildren(this.collectViewItems(focused.id));
    if (this.autoSelectNewest && this.currentChildren.length > 0) {
      const last = this.currentChildren[this.currentChildren.length - 1];
      this.cursorIdx = this.currentChildren.length - 1;
      this.selection.clear();
      this.selection.add(last.id);
      this.lastSelected = last.id;
      this.autoSelectNewest = false;
    } else if (this.pendingFocusIds) {
      const ids = this.pendingFocusIds;
      this.pendingFocusIds = null;
      this.selection.clear();
      let firstIdx = -1;
      for (const id of ids) {
        const idx = this.currentChildren.findIndex((n) => n.id === id);
        if (idx >= 0) {
          this.selection.add(id);
          if (firstIdx < 0) firstIdx = idx;
        }
      }
      this.cursorIdx = firstIdx;
      if (firstIdx >= 0) this.lastSelected = ids.find((id) => this.currentChildren.some((n) => n.id === id)) ?? null;
    } else if (this.cursorIdx >= this.currentChildren.length) {
      this.cursorIdx = this.currentChildren.length - 1;
    }

    const list = root.createDiv({ cls: "stashpad-list" });
    this.listEl = list;
    // List-level dragover: handles the case where the cursor is in the *gap* between
    // rows (no row's dragover fires there). Picks the nearest row + position.
    // 0.56.10: keep scrollByFocus fresh while the user scrolls within the
    // current focus. Stamps the in-memory map on every scroll (cheap),
    // debounces the disk write to 400ms so a fast scroll doesn't hammer
    // the adapter. Reload then has an up-to-date saved position even if
    // the user never navigated away from the focus.
    // 0.56.17: scroll listener no longer captures the topmost row. We now
    // persist the LAST SELECTED note id (cursor row) and restore by
    // scrolling to it at the top of the viewport. The scroll listener
    // is still in place for the suppressScrollSave gate's interactions
    // (anchor restoration during preserve renders), but the save itself
    // happens on selection mutations (see stampSelectedCursor).
    list.addEventListener("dragover", (e: DragEvent) => {
      if (!this.dragSourceIds) return;
      const t = e.target as HTMLElement | null;
      // If the cursor is over a row, the per-row handler decides (above/into/below).
      // BUT we still want to recompute when cursor is over the placeholder (so the
      // placeholder slides to a new gap as the user moves through the list).
      if (t && t.closest && t.closest(".stashpad-note")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rows = Array.from(list.querySelectorAll(".stashpad-note")) as HTMLElement[];
      if (rows.length === 0) return;
      // Find the first row whose vertical midpoint is below the cursor → drop before it.
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          this.placePlaceholder(r, "before");
          return;
        }
      }
      // Cursor is below all rows → drop after the last row.
      this.placePlaceholder(rows[rows.length - 1], "after");
    });
    list.addEventListener("drop", (e: DragEvent) => {
      // Only handle if no nested target consumed it.
      if (!this.dragSourceIds) return;
      e.preventDefault();
      const sources = this.dragSourceIds.slice();
      this.dragSourceIds = null;
      if (!this.dragPlaceholder) return;
      const after = this.dragPlaceholder.nextElementSibling as HTMLElement | null;
      const before = this.dragPlaceholder.previousElementSibling as HTMLElement | null;
      this.removeDragPlaceholder();
      if (after && after.classList.contains("stashpad-note")) {
        const id = (after as HTMLElement).dataset.id;
        if (id) void this.reorderToTarget(sources, id, "before");
      } else if (before && before.classList.contains("stashpad-note")) {
        const id = (before as HTMLElement).dataset.id;
        if (id) void this.reorderToTarget(sources, id, "after");
      }
    });
    this.populateListBody(list, focused);

    this.renderComposer(root);
    if (Platform.isMobile) this.renderMobileNav(root);
    if (this.focusComposerOnNextRender) {
      this.focusComposerOnNextRender = false;
      const caret = this.pendingComposerCaret;
      this.pendingComposerCaret = null;
      // Synchronously focus when the textarea is already in the DOM —
      // avoids the one-frame focus-blur flicker the RAF path produced
      // when multiple renders fired in quick succession.
      const ta = this.composerInputEl;
      if (ta && ta.isConnected) {
        ta.focus({ preventScroll: true });
        if (caret != null) {
          const c = Math.min(caret, ta.value.length);
          try { ta.setSelectionRange(c, c); } catch {}
        }
      } else {
        requestAnimationFrame(() => {
          const t = this.composerInputEl;
          if (!t) return;
          t.focus({ preventScroll: true });
          if (caret != null) {
            const c = Math.min(caret, t.value.length);
            try { t.setSelectionRange(c, c); } catch {}
          }
        });
      }
    }
    // 0.56.2: explicit policy short-circuits legacy inference. When a
    // policy is set (currently the 3 annotated sites: onOpen, navigateTo,
    // navigateUp), it owns the scroll outcome; legacy flags are skipped
    // so the two paths don't fight. Stale legacy flags from those sites
    // get reset here too so they don't leak into the next render.
    const scrollPolicy = this.pendingRenderPolicy;
    this.pendingRenderPolicy = null;
    if (scrollPolicy && this.listEl) {
      // 0.56.22: legacy `scrollToBottomOnNextRender` (composer submit)
      // still routes through here as a pin-bottom override on the
      // preserve branch. `pendingScrollRestore` retired.
      const legacyPinBottom = this.scrollToBottomOnNextRender;
      this.scrollToBottomOnNextRender = false;
      switch (scrollPolicy.kind) {
        case "preserve":
          // Anchor restore (id + viewport offset of topmost row) keeps the
          // same row at the same on-screen position even when rows above
          // change height. Composer submit's pin-bottom flag wins when set.
          if (legacyPinBottom) {
            this.scrollListToBottom();
          } else {
            this.restoreScrollAnchor(anchor, prevScroll);
          }
          break;
        case "pin-bottom":
          this.scrollListToBottom();
          break;
        case "restore": {
          // 0.56.10: multi-frame restore — async markdown layout shifts row
          // heights AFTER the synchronous render finishes. 0.56.12: also
          // suppress the scroll-save listener during apply() so transient
          // clamped values (when scrollHeight hasn't grown enough yet)
          // can't overwrite the saved target with WRONG values in the
          // map. Without this, restoring to a top-half scrollTop would
          // get clamped to maxTop=bottom on the first apply, the scroll
          // listener would stamp that bottom value into the map, and a
          // quick reload would then "restore" to the bottom — exactly
          // the regression the user saw.
          const target = scrollPolicy.scrollTop;
          const listForRestore = this.listEl;
          const apply = () => {
            this.suppressScrollSave = true;
            const maxTop = Math.max(0, listForRestore.scrollHeight - listForRestore.clientHeight);
            listForRestore.scrollTop = Math.min(target, maxTop);
            // Release after the scroll event fires (microtask).
            Promise.resolve().then(() => { this.suppressScrollSave = false; });
          };
          apply();
          requestAnimationFrame(apply);
          setTimeout(apply, 60);
          setTimeout(apply, 200);
          // Final hard re-assert after layout has fully settled — the
          // scroll listener can stamp from here forward.
          setTimeout(apply, 600);
          break;
        }
        case "follow-cursor":
          // Defer to revealCursorRow which already handles the multi-frame
          // settle dance for async row-height changes.
          if (prevScroll > 0) this.listEl.scrollTop = prevScroll;
          this.revealCursorRow();
          break;
        case "scroll-to-id": {
          // 0.56.14: multi-frame scroll-to-id. Same logic as restore —
          // async markdown layout shifts row positions after the
          // synchronous render. Re-asserting across frames + a 600ms
          // tail catches late layouts so the saved note stays centered.
          // 0.56.15: suppressScrollSave gate so the scroll listener
          // doesn't stamp transient anchors back into the map (which
          // corrupted the saved id on every subsequent reload).
          const targetId = scrollPolicy.id;
          const align = scrollPolicy.align;
          const listForScroll = this.listEl;
          const apply = () => {
            this.suppressScrollSave = true;
            const row = listForScroll.querySelector(`[data-id="${targetId}"]`) as HTMLElement | null;
            if (row) row.scrollIntoView({ block: align, behavior: "auto" });
            Promise.resolve().then(() => { this.suppressScrollSave = false; });
          };
          apply();
          requestAnimationFrame(apply);
          setTimeout(apply, 60);
          setTimeout(apply, 200);
          setTimeout(apply, 600);
          // Belt-and-suspenders: after the last apply settles, hold the
          // suppress flag a touch longer so any tail scroll events from
          // the browser's smooth-scroll-completion don't sneak through.
          setTimeout(() => { this.suppressScrollSave = false; }, 700);
          break;
        }
      }
    } else if (this.scrollToBottomOnNextRender) {
      this.scrollToBottomOnNextRender = false;
      this.scrollListToBottom();
    } else if (this.listEl && prevAtBottom) {
      // Was at bottom — re-pin to the *new* bottom and attach the
      // per-row ResizeObserver scrollListToBottom uses, so async
      // markdown / font / image growth keeps pinning. Covers the
      // cold-cache reload case where a second render fires while
      // markdown is still parsing.
      this.scrollListToBottom();
    } else if (this.listEl && prevScroll > 0) {
      this.listEl.scrollTop = prevScroll;
    }

    // 0.56.17: stamp the current cursor row as last-selected (debounced).
    // Coalesces a burst of renders into one localStorage write. Eager
    // paths (onClose / blur / navigateTo / navigateUp) flush immediately.
    this.stampSelectedCursor();

    // Re-pin scroll if list's height changes post-render (async markdown in focused header, etc).
    if (this.listEl) {
      this.listResizeObserver?.disconnect();
      const targetList = this.listEl;
      let settleTop = targetList.scrollTop;
      const ro = new ResizeObserver(() => {
        // Sticky-to-bottom mode: every growth of the list jumps to the new bottom.
        if (this.stickToListBottom) {
          targetList.scrollTop = targetList.scrollHeight;
          settleTop = targetList.scrollTop;
          return;
        }
        const maxTop = Math.max(0, targetList.scrollHeight - targetList.clientHeight);
        if (targetList.scrollTop < settleTop && settleTop <= maxTop) {
          targetList.scrollTop = settleTop;
        } else {
          settleTop = targetList.scrollTop;
        }
      });
      ro.observe(targetList);
      this.listResizeObserver = ro;
      // ANY user interaction with the list signals "I'm in control now,
      // stop yanking me to the bottom on every render." This covers:
      //
      //  - Wheel up: classic "let me read older notes" gesture.
      //  - Touch swipe down: same on mobile.
      //  - Mouse down on any row: the user is targeting a specific
      //    note for select / drag / right-click. Mutations triggered
      //    from there (color, reparent, delete, etc.) shouldn't bounce
      //    the view back to the bottom afterward.
      //  - Any keydown on the list (Arrow up/down, Tab, letter keys
      //    for shortcuts, etc.). Sticky-bottom is only appropriate
      //    while the user is in "watching the bottom for new notes"
      //    mode — typing anything signals they've moved on.
      //
      // The composer doesn't share the list's keydown surface (its
      // textarea handles its own events), so this doesn't interfere
      // with typing-into-composer-then-submitting flows: the submit
      // path explicitly calls scrollListToBottom, re-arming the flag.
      targetList.addEventListener("wheel", (e) => {
        if ((e as WheelEvent).deltaY < 0) this.stickToListBottom = false;
      }, { passive: true });
      let lastTouchY = 0;
      targetList.addEventListener("touchstart", (e) => {
        lastTouchY = (e as TouchEvent).touches[0]?.clientY ?? 0;
      }, { passive: true });
      targetList.addEventListener("touchmove", (e) => {
        const y = (e as TouchEvent).touches[0]?.clientY ?? lastTouchY;
        if (y > lastTouchY) this.stickToListBottom = false; // finger moved DOWN → list scrolls UP
        lastTouchY = y;
      }, { passive: true });
      targetList.addEventListener("mousedown", () => {
        this.stickToListBottom = false;
      });
      targetList.addEventListener("keydown", () => {
        this.stickToListBottom = false;
      });
    }
  }

  private renderTimeFilterBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "stashpad-time-filter-bar" });

    // Folder switcher
    const folderBtn = bar.createEl("button", { cls: "stashpad-folder-btn" });
    const isOverride = !!this.folderOverride;
    const displayName = (this.noteFolder.split("/").pop() || this.noteFolder) || "stashpad";
    setIcon(folderBtn.createSpan({ cls: "stashpad-btn-icon" }), "folder");
    folderBtn.createSpan({ text: displayName, cls: "stashpad-btn-text" });
    folderBtn.title = isOverride
      ? `Folder (override): ${this.noteFolder}\nClick to change or revert to default.`
      : `Folder: ${this.noteFolder}\nClick to override for this tab.`;
    if (isOverride) folderBtn.addClass("is-override");
    folderBtn.onclick = (e) => { e.preventDefault(); this.openFolderPicker(); };

    if (Platform.isMobile) {
      // Mobile: collapse the four filter/view buttons into a single
      // entry-point button. Tapping it opens a vertical accordion with
      // one section per former button — keeps the header bar uncluttered
      // on narrow screens while still surfacing every option.
      this.renderMobileFiltersButton(bar);
    } else {
      // Desktop: each control gets its own header-bar button.
      this.renderTagFilterDropdown(bar);
      this.renderColorFilterDropdown(bar);
      this.renderSortDropdown(bar);
      this.renderViewDropdown(bar);
    }

    // Buttons row (visible by default; hidden via CSS when narrow).
    const btns = bar.createDiv({ cls: "stashpad-time-filter-btns" });
    // Calendar/rolling toggle — sits before "All". Active = calendar
    // mode (start of today / week / month / year). Inactive = rolling
    // N-day windows backward from now (the historical default).
    const calBtn = btns.createEl("button", {
      cls: "stashpad-time-filter-btn stashpad-time-filter-cal",
    });
    // Icon flips with the mode so a glance tells you which is active:
    //   calendar = calendar/start-of-period boundaries
    //   history  = rolling window N units back from now
    setIcon(calBtn, this.timeFilterCalendar ? "calendar" : "history");
    calBtn.title = this.timeFilterCalendar
      ? "Calendar mode: filters use start-of-day/week/month/year. Click for rolling windows."
      : "Rolling mode: filters look back N days from now. Click for calendar boundaries.";
    if (this.timeFilterCalendar) calBtn.addClass("is-active");
    calBtn.onclick = (e) => {
      e.preventDefault();
      this.timeFilterCalendar = !this.timeFilterCalendar;
      this.persistFocus();
      this.render();
    };
    for (const opt of TIME_FILTER_OPTIONS) {
      const short = this.timeFilterCalendar ? opt.calShort : opt.rollShort;
      const long  = this.timeFilterCalendar ? opt.calLong  : opt.rollLong;
      const b = btns.createEl("button", { cls: "stashpad-time-filter-btn", text: short });
      b.title = long;
      if (this.timeFilter === opt.key) b.addClass("is-active");
      b.onclick = (e) => { e.preventDefault(); this.setTimeFilter(opt.key); };
    }

    // Compact dropdown (hidden by default; shown via CSS when narrow).
    const sel = bar.createEl("select", { cls: "stashpad-time-filter-select" });
    for (const opt of TIME_FILTER_OPTIONS) {
      const long = this.timeFilterCalendar ? opt.calLong : opt.rollLong;
      const o = sel.createEl("option", { text: long });
      o.value = opt.key;
      if (this.timeFilter === opt.key) o.selected = true;
    }
    sel.onchange = () => this.setTimeFilter(sel.value as TimeFilter);

    // Action cluster moved to the breadcrumb row's start — see
    // renderActionsCluster, called from renderBreadcrumb.
  }

  /** Select-mode toggle + ⋯ actions menu. Rendered at the START of the
   *  breadcrumb row (left of Home) on every platform. */
  private renderActionsCluster(parent: HTMLElement): void {
    const actions = parent.createDiv({ cls: "stashpad-mobile-actions" });
    const selectBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
    const inSelect = this.mobileSelectMode;
    setIcon(selectBtn, inSelect ? "check-square" : "square");
    selectBtn.title = inSelect
      ? `${this.selection.size} selected — tap to exit (keeps the first selection)`
      : "Enter select mode (tap notes to add)";
    if (inSelect) selectBtn.addClass("is-active");
    selectBtn.onclick = (e) => {
      e.preventDefault();
      if (this.mobileSelectMode) {
        const first = this.firstSelectedId ?? this.selection.values().next().value;
        this.selection.clear();
        if (first) {
          const idx = this.currentChildren.findIndex((n) => n.id === first);
          this.selection.add(first);
          this.lastSelected = first;
          if (idx >= 0) this.cursorIdx = idx;
        }
        this.firstSelectedId = null;
        this.mobileSelectMode = false;
        this.render();
      } else {
        const node = this.currentChildren[Math.max(0, this.cursorIdx)];
        this.mobileSelectMode = true;
        this.selection.clear();
        if (node) {
          this.selection.add(node.id);
          this.lastSelected = node.id;
          this.firstSelectedId = node.id;
        }
        this.render();
        // Unicode bolt ⚡ matches the lightning-bolt icon on the
        // actions button (Obsidian's Notice doesn't render Lucide icons
        // inline, so the emoji is the next-best visual match).
        new Notice("Select mode: tap notes to add, press ⚡ for actions");
      }
    };

    const moreBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
    setIcon(moreBtn, "zap");
    moreBtn.title = "Actions (move, delete, undo, …)";
    moreBtn.onclick = (e) => {
      e.preventDefault();
      this.openMobileActionsMenu(moreBtn);
    };
  }

  /** Action menu for mobile — a single Menu with the most common
   *  selection-aware commands plus undo/redo. Reachable from the
   *  top-right ⋯ button. */
  private openMobileActionsMenu(anchor: HTMLElement): void {
    const menu = new Menu();
    const hasTargets = this.selection.size > 0 || (this.cursorIdx >= 0 && !!this.currentChildren[this.cursorIdx]);
    const exactlyOne = this.selection.size <= 1;
    // Undo / Redo at the top — independent of selection state.
    menu.addItem((it: any) => it.setTitle("Undo").setIcon("undo").onClick(() => this.cmdUndo()));
    menu.addItem((it: any) => it.setTitle("Redo").setIcon("redo").onClick(() => this.cmdRedo()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("list-tree").setDisabled(!hasTargets).onClick(() => this.cmdOpenInNewStashpadTab()));
    menu.addItem((it: any) => it.setTitle("Open in editor").setIcon("pencil").setDisabled(!hasTargets).onClick(() => this.cmdOpenInEditor()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Move…").setIcon("arrow-right-circle").setDisabled(!hasTargets).onClick(() => this.cmdMovePicker()));
    menu.addItem((it: any) => it.setTitle("Nest under… (in-list)").setIcon("indent").setDisabled(!hasTargets).onClick(() => this.cmdInListPicker()));
    menu.addItem((it: any) => it.setTitle("Outdent").setIcon("outdent").setDisabled(!hasTargets).onClick(() => void this.cmdOutdent()));
    menu.addItem((it: any) => it.setTitle("Set color…").setIcon("palette").setDisabled(!hasTargets).onClick(() => this.cmdSetColor()));
    menu.addItem((it: any) => it.setTitle("Toggle complete").setIcon("check-circle").setDisabled(!hasTargets).onClick(() => void this.cmdToggleComplete()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Copy").setIcon("copy").setDisabled(!hasTargets).onClick(() => void this.cmdCopy()));
    menu.addItem((it: any) => it.setTitle("Copy tree").setIcon("copy-plus").setDisabled(!hasTargets).onClick(() => void this.cmdCopyTree()));
    menu.addItem((it: any) => it.setTitle("Clone (duplicate / copy)").setIcon("files").setDisabled(!hasTargets).onClick(() => void this.cmdClone()));
    menu.addItem((it: any) => it.setTitle("Insert template…").setIcon("file-plus-2").onClick(() => this.cmdInsertTemplate()));
    menu.addItem((it: any) => it.setTitle("Merge").setIcon("merge").setDisabled(this.selection.size < 2).onClick(() => void this.cmdMerge()));
    // Split only operates on a single note — the cmdSplit modal would
    // be ambiguous across a multi-selection. Disable when 2+ selected.
    menu.addItem((it: any) => it.setTitle("Split note…").setIcon("scissors").setDisabled(!hasTargets || !exactlyOne).onClick(() => void this.cmdSplit()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Delete").setIcon("trash-2").setDisabled(!hasTargets).onClick(() => void this.cmdDelete()));
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  /** Render the tag-filter <select>. Folder tags are tallied + sorted
   *  here on each render so newly-added tags appear without a refresh. */
  private renderTagFilterDropdown(bar: HTMLElement): void {
    const sel = bar.createEl("select", { cls: "stashpad-tag-filter-select" });
    const all = sel.createEl("option", { text: "All tags" });
    all.value = "";
    if (!this.tagFilter) all.selected = true;

    const tags = this.collectFolderTags();
    if (tags.length === 0) {
      sel.disabled = true;
      all.text = "No tags";
    } else {
      for (const t of tags) {
        const opt = sel.createEl("option", { text: `${t.label} (${t.count})` });
        opt.value = t.raw;
        if (this.tagFilter && this.tagFilter.toLowerCase() === t.raw.toLowerCase()) opt.selected = true;
      }
    }

    sel.onchange = () => this.setTagFilter(sel.value || null);
  }

  /** Color filter — custom button + popover. Native <select> is unable
   *  to honor per-option text color reliably (Obsidian's theme + macOS
   *  WebKit's native dropdown both override us), so we build it
   *  ourselves: a button that shows the current selection (with a
   *  colored swatch), and a click-anchored popover listing colored
   *  swatches for each hex in the focused subtree. */
  private renderColorFilterDropdown(bar: HTMLElement): void {
    const colors = this.collectFolderColors();
    const btn = bar.createDiv({ cls: "stashpad-color-filter-btn" });
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");

    const renderBtnContent = (): void => {
      btn.empty();
      const swatch = btn.createSpan({ cls: "stashpad-color-filter-swatch" });
      const label = btn.createSpan({ cls: "stashpad-color-filter-label" });
      if (this.colorFilter) {
        const hex = this.colorFilter.toLowerCase();
        swatch.style.background = hex;
        // Show alias if the user set one for this Stashpad; fall back
        // to the hex code when no alias exists.
        const alias = this.plugin.getColorAlias(this.noteFolder, hex);
        label.setText(alias ?? hex);
      } else if (colors.length === 0) {
        // No active filter and nothing to filter by — disabled.
        swatch.addClass("is-empty");
        label.setText("No colors");
        btn.addClass("is-disabled");
      } else {
        swatch.addClass("is-empty");
        label.setText("All colors");
      }
    };
    renderBtnContent();

    const open = (e: Event) => {
      e.preventDefault();
      // Allow opening when a filter is active even if no notes carry any
      // color now — otherwise a stale filter (e.g. its color was just
      // cleared from the only note) would be unrecoverable without
      // navigating away. The popover always offers the "All colors" reset.
      if (colors.length === 0 && !this.colorFilter) return;
      this.openColorFilterMenu(btn, colors);
    };
    btn.onclick = open;
    btn.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") open(e);
    };
  }

  /** Show the color picker popover anchored beneath `anchor`. Each row
   *  is a colored swatch + hex + count. Clicking commits the filter. */
  private openColorFilterMenu(
    anchor: HTMLElement,
    colors: Array<{ hex: string; count: number }>,
  ): void {
    // Use the anchor's own document so the popover lands in the same
    // window as the view — Obsidian secondary windows have their own
    // document, and a plain `document.body` always points at the main
    // window (which is why the popover used to appear there).
    const doc = anchor.ownerDocument ?? document;
    // Tear down any existing popover first.
    doc.querySelectorAll(".stashpad-color-filter-popover").forEach((el) => el.remove());

    const pop = doc.body.createDiv({ cls: "stashpad-color-filter-popover" });
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    // Size to content; cap so very long aliases don't run off-screen.
    pop.style.minWidth = `${r.width}px`;
    pop.style.maxWidth = "min(280px, calc(100vw - 16px))";
    pop.style.width = "max-content";

    this.populateColorMenuBody(pop, colors, close);

    // Push a keymap Scope that consumes Escape so Obsidian's workspace
    // handler ("Escape returns to last leaf") doesn't fire and yank the
    // user back to a previously-active non-Stashpad tab. DOM listeners
    // alone aren't enough — Obsidian routes Escape through its keymap
    // ahead of bubble-phase listeners.
    const scope = new Scope((this.app as any).scope);
    scope.register([], "Escape", (ev: KeyboardEvent) => {
      ev.preventDefault();
      close();
      return false;
    });
    (this.app as any).keymap?.pushScope(scope);

    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch {}
    };
    const outside = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) {
        close();
      }
    };
    // Defer the listener attach so the click that opened us doesn't immediately close it.
    setTimeout(() => {
      doc.addEventListener("mousedown", outside, true);
    }, 0);
  }

  /** Sort dropdown — mirrors the color-filter pattern (custom button +
   *  click-anchored popover) since native <select> can't carry the same
   *  styling and Scope plumbing reliably across Obsidian builds. Scope is
   *  per-parent: the button shows the mode for whatever parent the user
   *  is currently focused into.
   *
   *  Disabled in non-Nested view modes — Sort is per-parent, and Flat /
   *  Everything synthesize a flat list that doesn't map to a single
   *  parent's stored sort. The dropdown still renders (so users see it
   *  exists) but reads "—" and won't open. */
  private renderSortDropdown(bar: HTMLElement): void {
    const folder = this.noteFolder;
    const parentId = this.focusId;
    const currentMode = this.sortStore.getMode(folder, parentId);
    const viewMode = this.currentViewMode();
    const disabled = viewMode !== "nested";

    const btn = bar.createDiv({ cls: "stashpad-sort-btn" });
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", disabled ? "-1" : "0");
    if (disabled) btn.addClass("is-disabled");

    const icon = btn.createSpan({ cls: "stashpad-sort-icon" });
    setIcon(icon, "arrow-up-down");
    const label = btn.createSpan({ cls: "stashpad-sort-label" });
    if (disabled) {
      label.setText("Sort: —");
      btn.title = `Sort is per-parent and applies only to Nested view. The current view (${VIEW_MODE_LABELS[viewMode]}) shows a synthesized flat list sorted by created time — switch back to Nested to change sort.`;
    } else {
      label.setText(SORT_MODE_LABELS[currentMode]);
      if (currentMode !== "manual") btn.addClass("is-active");
      btn.title = currentMode === "manual"
        ? "Sort children of this view. Click to change. Drag-reorder always reverts the affected parent to Manual."
        : `Currently: ${SORT_MODE_LABELS[currentMode]}. Drag-reorder will revert this parent to Manual.`;
    }

    const open = (e: Event) => {
      if (disabled) return;
      e.preventDefault();
      this.openSortMenu(btn);
    };
    btn.onclick = open;
    btn.onkeydown = (e) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") open(e);
    };
  }

  /** Show the sort-mode picker popover anchored beneath `anchor`. Matches
   *  the color-filter popover's outside-click + Escape teardown so it
   *  behaves identically. */
  private openSortMenu(anchor: HTMLElement): void {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-sort-popover").forEach((el) => el.remove());

    const pop = doc.body.createDiv({ cls: "stashpad-sort-popover" });
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.minWidth = `${r.width}px`;
    pop.style.maxWidth = "min(280px, calc(100vw - 16px))";
    pop.style.width = "max-content";

    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch {}
    };
    const outside = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) {
        close();
      }
    };
    this.populateSortMenuBody(pop, close);

    // Same Scope-based Escape handling as the color-filter popover so a
    // press here doesn't escape the Stashpad view entirely.
    const scope = new Scope((this.app as any).scope);
    scope.register([], "Escape", (ev: KeyboardEvent) => {
      ev.preventDefault();
      close();
      return false;
    });
    (this.app as any).keymap?.pushScope(scope);
    setTimeout(() => { doc.addEventListener("mousedown", outside, true); }, 0);
  }

  /** Mobile: combined filters button. Replaces the four individual
   *  desktop buttons (tag / color / sort / view) with a single icon
   *  that opens an accordion popover containing all four sections.
   *  Shows a small "active" accent when any filter / non-default view
   *  state is in effect so you can see at a glance the view isn't in
   *  its default state. */
  private renderMobileFiltersButton(bar: HTMLElement): void {
    const btn = bar.createDiv({ cls: "stashpad-mobile-filters-btn" });
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    const icon = btn.createSpan({ cls: "stashpad-mobile-filters-icon" });
    setIcon(icon, "sliders-horizontal");
    btn.title = "Filters / view options";

    // Light "something is active" hint: any non-default state across
    // the four sections lights up the accent border.
    const tagOn = !!this.tagFilter;
    const colorOn = !!this.colorFilter;
    const timeOn = this.timeFilter !== "all";
    const sortOn = this.sortStore.getMode(this.noteFolder, this.focusId) !== "manual";
    const viewOn = this.currentViewMode() !== "nested"
      || this.currentHideChildless()
      || this.currentHideCompleted()
      || this.currentIncludeAttachments();
    if (tagOn || colorOn || timeOn || sortOn || viewOn) btn.addClass("is-active");

    const open = (e: Event) => { e.preventDefault(); this.openMobileFiltersMenu(btn); };
    btn.onclick = open;
    btn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") open(e); };
  }

  /** Build the mobile accordion popover. Four sections (Tag / Color /
   *  Sort / View), each with a header that toggles its body open/closed.
   *  Only one section is expanded at a time — pure accordion. The View
   *  section starts expanded so the most "settings"-shaped one is
   *  immediately visible on first tap. */
  private openMobileFiltersMenu(anchor: HTMLElement): void {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-mobile-filters-popover").forEach((el) => el.remove());

    const pop = doc.body.createDiv({ cls: "stashpad-mobile-filters-popover" });
    const r = anchor.getBoundingClientRect();
    const win = doc.defaultView ?? window;
    // The mobile filters button is anchored to the right edge of the
    // header bar, so position the popover's RIGHT edge under the
    // button's right edge — the menu grows leftward into the viewport
    // instead of off the right side of the screen. Min 8px gutter
    // from the viewport right edge as a safety margin if the button
    // is itself off-screen for any reason.
    pop.style.right = `${Math.max(8, win.innerWidth - r.right)}px`;
    pop.style.left = "auto";
    pop.style.top = `${r.bottom + 4}px`;
    // Wider than the per-button popovers so accordion section headers +
    // option rows have room to breathe. Capped to viewport width.
    pop.style.maxWidth = "min(360px, calc(100vw - 16px))";
    pop.style.width = "max-content";
    pop.style.minWidth = "260px";

    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch {}
    };
    const outside = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close();
    };

    // Build one section per former button. `populate` fills the body
    // when expanded (and we re-call it on each open in case state
    // changed in another section). `summary` is the small line of
    // muted text shown beside the header when the section is collapsed.
    type Section = {
      key: string;
      title: string;
      summary: () => string;
      populate: (body: HTMLElement) => void;
    };
    const sections: Section[] = [
      {
        key: "tag",
        title: "Tag filter",
        summary: () => this.tagFilter ? `#${this.tagFilter}` : "All tags",
        populate: (body) => this.populateTagMenuBody(body, close),
      },
      {
        key: "color",
        title: "Color filter",
        summary: () => {
          if (!this.colorFilter) return "All colors";
          const alias = this.plugin.getColorAlias(this.noteFolder, this.colorFilter);
          return alias ?? this.colorFilter;
        },
        populate: (body) => this.populateColorMenuBody(body, this.collectFolderColors(), close),
      },
      {
        key: "time",
        title: "Time filter",
        summary: () => {
          const opt = TIME_FILTER_OPTIONS.find((o) => o.key === this.timeFilter);
          if (!opt) return "All";
          return this.timeFilterCalendar ? opt.calShort : opt.rollShort;
        },
        populate: (body) => this.populateTimeMenuBody(body, close),
      },
      {
        key: "sort",
        title: "Sort",
        summary: () => this.currentViewMode() !== "nested"
          ? "— (Nested only)"
          : SORT_MODE_LABELS[this.sortStore.getMode(this.noteFolder, this.focusId)],
        populate: (body) => {
          if (this.currentViewMode() !== "nested") {
            body.createDiv({ cls: "stashpad-mobile-filters-note", text: "Sort applies only in Nested view." });
            return;
          }
          this.populateSortMenuBody(body, close);
        },
      },
      {
        key: "view",
        title: "View",
        summary: () => VIEW_MODE_LABELS[this.currentViewMode()],
        populate: (body) => this.populateViewMenuBody(body, close),
      },
    ];

    // All sections start collapsed — the user picks which to expand.
    // Previously the View section auto-opened, but that pre-empted the
    // user's choice and made the menu taller than it needed to be on
    // first open.
    let expandedKey = "";
    const renderAccordion = (): void => {
      pop.empty();
      for (const sec of sections) {
        const sectionEl = pop.createDiv({ cls: "stashpad-mobile-filters-section" });
        const header = sectionEl.createDiv({ cls: "stashpad-mobile-filters-header" });
        const chev = header.createSpan({ cls: "stashpad-mobile-filters-chev" });
        setIcon(chev, expandedKey === sec.key ? "chevron-down" : "chevron-right");
        header.createSpan({ cls: "stashpad-mobile-filters-title", text: sec.title });
        header.createSpan({ cls: "stashpad-mobile-filters-summary", text: sec.summary() });
        header.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          expandedKey = expandedKey === sec.key ? "" : sec.key;
          renderAccordion();
        };
        if (expandedKey === sec.key) {
          const body = sectionEl.createDiv({ cls: "stashpad-mobile-filters-body" });
          sec.populate(body);
        }
      }
    };
    renderAccordion();

    const scope = new Scope((this.app as any).scope);
    scope.register([], "Escape", (ev: KeyboardEvent) => { ev.preventDefault(); close(); return false; });
    (this.app as any).keymap?.pushScope(scope);
    setTimeout(() => { doc.addEventListener("mousedown", outside, true); }, 0);
  }

  /** View dropdown — Nested / Flat / Everything. Per-folder. The label
   *  uses an active accent when the mode differs from the default
   *  ("nested") so it reads at a glance. */
  private renderViewDropdown(bar: HTMLElement): void {
    const mode = this.currentViewMode();
    const btn = bar.createDiv({ cls: "stashpad-view-btn" });
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    const icon = btn.createSpan({ cls: "stashpad-view-icon" });
    setIcon(icon, mode === "flat" ? "list" : mode === "everything" ? "layout-grid" : "list-tree");
    const label = btn.createSpan({ cls: "stashpad-view-label" });
    label.setText(VIEW_MODE_LABELS[mode]);
    if (mode !== "nested") btn.addClass("is-active");
    btn.title = mode === "nested"
      ? "View: Nested (the default). Click to switch to Flat or Everything."
      : mode === "flat"
        ? "View: Flat — all descendants of the current focus, flat by sort order. Drag-reorder is disabled in this mode. Click to change."
        : "View: Everything — all descendants of the current focus PLUS non-Stashpad files in the folder, flat by created/ctime. Click to change.";

    const open = (e: Event) => {
      e.preventDefault();
      this.openViewMenu(btn);
    };
    btn.onclick = open;
    btn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") open(e); };
  }

  /** Pick-a-mode popover anchored beneath the View dropdown button. Same
   *  Scope/outside-click teardown shape as the sort/color popovers. */
  private openViewMenu(anchor: HTMLElement): void {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-view-popover").forEach((el) => el.remove());
    const pop = doc.body.createDiv({ cls: "stashpad-view-popover" });
    // Popover is appended to doc.body (not inside the Stashpad view),
    // so the view's .is-mobile class doesn't reach it via inheritance.
    // Tag the popover directly so its CSS rules can hide descriptions
    // on mobile for a compact layout.
    if (Platform.isMobile) pop.addClass("is-mobile");
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.minWidth = `${r.width}px`;
    pop.style.maxWidth = "min(320px, calc(100vw - 16px))";
    pop.style.width = "max-content";

    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch {}
    };
    const outside = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close();
    };
    this.populateViewMenuBody(pop, close);
    const scope = new Scope((this.app as any).scope);
    scope.register([], "Escape", (ev: KeyboardEvent) => { ev.preventDefault(); close(); return false; });
    (this.app as any).keymap?.pushScope(scope);
    setTimeout(() => { doc.addEventListener("mousedown", outside, true); }, 0);
  }

  /** Render the view-menu body (mode rows + 3 toggles) into `container`.
   *  Used by both the desktop popover and the mobile combined-filters
   *  accordion section. `onPicked` is invoked after any choice so the
   *  caller can close the wrapping popover/accordion. */
  private populateViewMenuBody(container: HTMLElement, onPicked: () => void): void {
    const current = this.currentViewMode();
    const addRow = (mode: ViewMode, desc: string): void => {
      const row = container.createDiv({ cls: "stashpad-view-popover-row" });
      if (mode === current) row.addClass("is-active");
      const main = row.createDiv({ cls: "stashpad-view-popover-main" });
      main.createSpan({ cls: "stashpad-view-popover-label", text: VIEW_MODE_LABELS[mode] });
      row.createDiv({ cls: "stashpad-view-popover-desc", text: desc });
      row.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPicked();
        if (mode === current) return;
        await this.setViewMode(mode);
        this.render();
      };
    };
    addRow("nested", "Tree of immediate children (default).");
    addRow("flat", "All descendants of the current focus, flat by sort.");
    addRow("everything", "All descendants PLUS non-Stashpad files in the folder.");

    container.createDiv({ cls: "stashpad-view-popover-divider" });

    const hcRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const hcCheck = hcRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    hcCheck.checked = this.currentHideChildless();
    hcRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Hide childless notes" });
    hcRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: current === "nested"
        ? "Show only notes that have children. Applied at this level."
        : "Hide top-level notes without children; keep every parent's full subtree so no task is overlooked.",
    });
    hcRow.onclick = async (e) => {
      if (e.target !== hcCheck) { e.preventDefault(); hcCheck.checked = !hcCheck.checked; }
      await this.setHideChildless(hcCheck.checked);
      // Toggles don't close the menu (chain multiple flips). And we
      // repaint ONLY the list — not the full view — to avoid the
      // flicker / apparent "reload" that a full render() would cause
      // while the popover stays open above it.
      this.refreshList();
    };

    const hdRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const hdCheck = hdRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    hdCheck.checked = this.currentHideCompleted();
    hdRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Hide completed notes" });
    hdRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: "Hide notes marked complete. A completed parent stays visible while any descendant is still incomplete.",
    });
    hdRow.onclick = async (e) => {
      if (e.target !== hdCheck) { e.preventDefault(); hdCheck.checked = !hdCheck.checked; }
      await this.setHideCompleted(hdCheck.checked);
      this.refreshList();
    };

    container.createDiv({ cls: "stashpad-view-popover-divider" });

    const attRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    if (current !== "everything") attRow.addClass("is-disabled");
    const attCheck = attRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    attCheck.checked = this.currentIncludeAttachments();
    attCheck.disabled = current !== "everything";
    attRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Include attachments" });
    attRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: current === "everything"
        ? "Show attachments referenced by notes as their own rows in the file list. Off by default — they already appear inline on the notes that embed them."
        : "Only applies in Everything mode.",
    });
    attRow.onclick = async (e) => {
      if (current !== "everything") return;
      if (e.target !== attCheck) { e.preventDefault(); attCheck.checked = !attCheck.checked; }
      await this.setIncludeAttachments(attCheck.checked);
      this.refreshList();
    };
  }

  private setTagFilter(raw: string | null): void {
    if ((this.tagFilter ?? null) === (raw ?? null)) return;
    this.tagFilter = raw;
    this.reconcileSelectionAfterFilter();
    this.persistFocus(); // queue a workspace.json save so reload restores it
    this.render();
  }

  /** Render the sort-mode rows into `container`. Shared between the
   *  desktop sort popover and the mobile combined-filters accordion. */
  private populateSortMenuBody(container: HTMLElement, onPicked: () => void): void {
    const folder = this.noteFolder;
    const parentId = this.focusId;
    const currentMode = this.sortStore.getMode(folder, parentId);
    for (const mode of SORT_MODES_ORDER) {
      const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
      if (mode === currentMode) row.addClass("is-active");
      row.createSpan({ cls: "stashpad-sort-popover-label", text: SORT_MODE_LABELS[mode] });
      row.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPicked();
        if (mode === currentMode) return;
        this.sortStore.setMode(folder, parentId, mode);
        await this.sortStore.save(folder);
        this.tree.rebuild(folder);
        this.render();
      };
    }
  }

  /** Render the time-filter rows into `container`. Used by the mobile
   *  accordion section (desktop renders its own button row + select
   *  fallback in renderListBar). The Calendar / Rolling toggle is
   *  surfaced as a checkbox at the top — flipping it changes the period
   *  rows' labels (Today vs 24h, etc.) on the next open. */
  private populateTimeMenuBody(container: HTMLElement, onPicked: () => void): void {
    const calRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const calCheck = calRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    calCheck.checked = this.timeFilterCalendar;
    calRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Calendar mode" });
    calRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: "Use calendar boundaries (start of today/week/month/year). Off = rolling windows back from now.",
    });
    calRow.onclick = (e) => {
      if (e.target !== calCheck) { e.preventDefault(); calCheck.checked = !calCheck.checked; }
      this.timeFilterCalendar = calCheck.checked;
      this.persistFocus();
      this.refreshList();
    };

    // Period rows — same shape as sort rows, with active highlighting
    // on the currently-selected period.
    for (const opt of TIME_FILTER_OPTIONS) {
      const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
      if (this.timeFilter === opt.key) row.addClass("is-active");
      const long = this.timeFilterCalendar ? opt.calLong : opt.rollLong;
      row.createSpan({ cls: "stashpad-sort-popover-label", text: long });
      row.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPicked();
        if (this.timeFilter !== opt.key) this.setTimeFilter(opt.key);
      };
    }
  }

  /** Render the color-filter rows into `container`. Pulled out of
   *  openColorFilterMenu so the mobile combined-filters accordion can
   *  reuse the same row markup inside an accordion section. `onPicked`
   *  is called after the filter is applied so the caller can close any
   *  wrapping popover. */
  private populateColorMenuBody(
    container: HTMLElement,
    colors: Array<{ hex: string; count: number }>,
    onPicked: () => void,
  ): void {
    const addRow = (label: string, swatchHex: string | null, onPick: () => void): void => {
      const row = container.createDiv({ cls: "stashpad-color-filter-popover-row" });
      const sw = row.createSpan({ cls: "stashpad-color-filter-swatch" });
      if (swatchHex) sw.style.background = swatchHex;
      else sw.addClass("is-empty");
      const txt = row.createSpan({ cls: "stashpad-color-filter-popover-label" });
      txt.setText(label);
      if (swatchHex) txt.style.color = swatchHex;
      row.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPick();
        onPicked();
      };
    };
    addRow("All colors", null, () => this.setColorFilter(null));
    for (const c of colors) {
      const alias = this.plugin.getColorAlias(this.noteFolder, c.hex);
      const label = alias ? `${alias} (${c.count})` : `${c.hex} (${c.count})`;
      addRow(label, c.hex, () => this.setColorFilter(c.hex));
    }
  }

  /** Same shape as populateColorMenuBody, for the tag filter. Rows render
   *  inside the mobile accordion — the desktop tag filter is still a
   *  native <select> for fast keyboard nav. */
  private populateTagMenuBody(container: HTMLElement, onPicked: () => void): void {
    const tags = this.collectFolderTags();
    const addRow = (label: string, raw: string | null): void => {
      const row = container.createDiv({ cls: "stashpad-color-filter-popover-row" });
      // Tag rows have no swatch; render an empty placeholder so the
      // text aligns with the colored rows in the same accordion when
      // both sections are open.
      row.createSpan({ cls: "stashpad-color-filter-swatch is-empty" });
      const txt = row.createSpan({ cls: "stashpad-color-filter-popover-label" });
      txt.setText(label);
      const active = (this.tagFilter ?? "") === (raw ?? "");
      if (active) row.addClass("is-active");
      row.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTagFilter(raw);
        onPicked();
      };
    };
    addRow(tags.length === 0 ? "No tags" : "All tags", null);
    for (const t of tags) addRow(`${t.label} (${t.count})`, t.raw);
  }

  private setColorFilter(hex: string | null): void {
    const next = hex ? hex.toLowerCase() : null;
    if ((this.colorFilter ?? null) === next) return;
    this.colorFilter = next;
    // 0.56.9: preserve any selected ids that still pass the new filter
    // instead of wiping selection wholesale. Drop the ones that no longer
    // match; recompute cursorIdx against the surviving selection.
    this.reconcileSelectionAfterFilter();
    this.persistFocus();
    this.render();
  }

  private setTimeFilter(tf: TimeFilter): void {
    if (this.timeFilter === tf) return;
    this.timeFilter = tf;
    this.reconcileSelectionAfterFilter();
    this.persistFocus(); // queue a workspace.json save so reload restores it
    this.render();
  }

  /** After a filter change, drop selected ids that no longer pass the
   *  filter, then re-index cursorIdx against the new currentChildren.
   *  Wins back the "stay-put after toggling time/color/tag" UX without
   *  letting stale selection point at filtered-out rows. */
  private reconcileSelectionAfterFilter(): void {
    const next = this.filterChildren(this.collectViewItems(this.focusId));
    const visibleIds = new Set(next.map((n) => n.id));
    for (const id of [...this.selection]) {
      if (!visibleIds.has(id)) this.selection.delete(id);
    }
    if (this.firstSelectedId && !visibleIds.has(this.firstSelectedId)) {
      this.firstSelectedId = null;
    }
    if (this.lastSelected && !visibleIds.has(this.lastSelected)) {
      this.lastSelected = null;
    }
    // Recompute cursorIdx to the first surviving selection's position,
    // falling back to clamping into the new list bounds.
    if (this.selection.size > 0) {
      const firstIdx = next.findIndex((n) => this.selection.has(n.id));
      this.cursorIdx = firstIdx >= 0 ? firstIdx : Math.min(this.cursorIdx, next.length - 1);
    } else if (this.cursorIdx >= next.length) {
      this.cursorIdx = next.length - 1;
    }
  }

  private renderBreadcrumb(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "stashpad-breadcrumb" });
    // Action cluster (select-mode toggle + ⋯ menu) sits at the START of
    // the breadcrumb row, before Home — easier to reach on mobile and
    // gives the time-filter row more horizontal real estate.
    this.renderActionsCluster(bar);
    const homeBtn = bar.createSpan({ cls: "stashpad-crumb stashpad-crumb-home" });
    if (Platform.isMobile) {
      // Mobile: render as a house icon to save horizontal space.
      setIcon(homeBtn, "home");
      homeBtn.title = "Home";
    } else {
      homeBtn.setText("Home");
    }
    homeBtn.onclick = () => this.navigateTo(ROOT_ID);
    if (this.focusId === ROOT_ID) return;

    const PER_CRUMB_MAX = 28;     // hard per-crumb char cap (then per-CSS visual ellipsis)
    const TOTAL_CHAR_BUDGET = 100; // path length budget across all crumbs (excluding "Home")

    type Crumb = { id: StashpadId; label: string; isEllipsis?: boolean };
    const path = this.tree.pathTo(this.focusId);
    const crumbs: Crumb[] = path.map((n) => {
      const raw = this.titleForNode(n);
      const label = raw.length > PER_CRUMB_MAX ? raw.slice(0, PER_CRUMB_MAX - 1) + "…" : raw;
      return { id: n.id, label };
    });

    const lengthOf = (cs: Crumb[]): number =>
      cs.reduce((sum, c) => sum + c.label.length + 3 /* " / " */, 0);

    // Collapse middle crumbs (left-to-right after Home) until under budget.
    // Always preserve: first crumb (top of subtree) and last crumb (current focus).
    if (lengthOf(crumbs) > TOTAL_CHAR_BUDGET && crumbs.length > 2) {
      let inserted = false;
      // Drop crumbs at index 1 (just after the first non-Home crumb) repeatedly.
      while (lengthOf(crumbs) > TOTAL_CHAR_BUDGET && crumbs.length > 2) {
        crumbs.splice(1, 1);
        if (!inserted) {
          crumbs.splice(1, 0, { id: "__ellipsis__", label: "…", isEllipsis: true });
          inserted = true;
        }
      }
    }

    for (const c of crumbs) {
      bar.createSpan({ cls: "stashpad-crumb-sep", text: " / " });
      if (c.isEllipsis) {
        bar.createSpan({ cls: "stashpad-crumb stashpad-crumb-ellipsis", text: c.label }).title =
          path.map((n) => this.titleForNode(n)).join(" / ");
      } else {
        const id = c.id;
        const el = bar.createSpan({ cls: "stashpad-crumb", text: c.label });
        el.title = c.label;
        el.onclick = () => this.navigateTo(id);
        // Right-click (desktop) or long-press (mobile) → context menu
        // for opening the crumb's note in a new Stashpad tab or a regular
        // Obsidian editor tab.
        el.oncontextmenu = (evt) => {
          evt.preventDefault();
          this.openCrumbMenu(evt, id);
        };
        if (Platform.isMobile) this.attachLongPress(el, () => this.openCrumbMenu(null, id));
      }
    }
    // Home crumb gets the same affordance.
    bar.querySelector(".stashpad-crumb-home")?.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.openCrumbMenu(evt as MouseEvent, ROOT_ID);
    });
    if (Platform.isMobile) {
      const homeEl = bar.querySelector(".stashpad-crumb-home") as HTMLElement | null;
      if (homeEl) this.attachLongPress(homeEl, () => this.openCrumbMenu(null, ROOT_ID));
    }
  }

  /** Long-press helper. Triggers `cb` after 500ms of touchstart held in
   *  place; cancelled on touchmove / touchend / touchcancel. */
  private attachLongPress(el: HTMLElement, cb: () => void): void {
    let timer: number | null = null;
    let startX = 0, startY = 0;
    const cancel = () => { if (timer != null) { window.clearTimeout(timer); timer = null; } };
    el.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      startX = t?.clientX ?? 0;
      startY = t?.clientY ?? 0;
      cancel();
      timer = window.setTimeout(() => { timer = null; cb(); }, 500);
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) cancel();
    }, { passive: true });
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchcancel", cancel);
  }

  /** Context menu for a breadcrumb crumb — open in a new Stashpad tab or
   *  open the underlying note in a regular Obsidian markdown tab. */
  private openCrumbMenu(evt: MouseEvent | null, id: StashpadId): void {
    const node = this.tree.get(id);
    if (!node) return;
    const menu = new Menu();
    menu.addItem((it: any) => it.setTitle("Navigate here").setIcon("arrow-right-circle").onClick(() => this.navigateTo(id)));
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("list-tree").onClick(() => this.cmdOpenInNewStashpadTab(node)));
    if (node.file) {
      menu.addItem((it: any) => it.setTitle("Open in editor (new tab)").setIcon("pencil").onClick(() => this.cmdOpenInEditor(node)));
    }
    if (evt && (evt.clientX > 0 || evt.clientY > 0)) {
      menu.showAtMouseEvent(evt);
    } else {
      // Long-press path: anchor below the crumb element.
      const el = (evt?.target as HTMLElement | null) ?? null;
      const r = el?.getBoundingClientRect();
      menu.showAtPosition({ x: r?.left ?? 8, y: (r?.bottom ?? 60) + 4 });
    }
  }

  /** Sticky 1-line preview for the focused header (mobile only). Renders
   *  at the top of the list and is hidden until the full
   *  `.stashpad-focused` row scrolls out of view (toggled by
   *  installFocusedMiniObserver). */
  private renderFocusedHeaderMini(parent: HTMLElement, node: TreeNode): void {
    if (!node.file) return;
    const file = node.file;
    const mini = parent.createDiv({ cls: "stashpad-focused-mini" });
    mini.dataset.id = node.id;
    const text = mini.createDiv({ cls: "stashpad-focused-mini-text" });
    text.setText(this.titleForNode(node).trim());
    const pencil = mini.createEl("button", { cls: "stashpad-pencil stashpad-focused-mini-pencil" });
    setIcon(pencil, "pencil");
    pencil.title = "Edit in new tab";
    pencil.onclick = (e) => { e.stopPropagation(); void this.openFileAtEnd(file); };
  }

  /** IntersectionObserver: hide the sticky mini preview while the full
   *  focused header is in view; show it when the full one scrolls past
   *  the top of the list. */
  private installFocusedMiniObserver(list: HTMLElement): void {
    const full = list.querySelector(".stashpad-focused") as HTMLElement | null;
    const mini = list.querySelector(".stashpad-focused-mini") as HTMLElement | null;
    if (!full || !mini) return;
    if (this.focusedMiniObserver) this.focusedMiniObserver.disconnect();
    this.focusedMiniObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          mini.toggleClass("is-visible", !e.isIntersecting);
        }
      },
      { root: list, threshold: 0.05 },
    );
    this.focusedMiniObserver.observe(full);
  }

  /** Focused-header layout mirrors a list row: [meta | body | actions].
   *  - meta: timestamp + a grip-width spacer (no actual grip — drag
   *    isn't meaningful here).
   *  - body: the focused note's rendered body.
   *  - actions: edit pencil + duplicate-tab button. The Show More
   *    toggle (when content overflows) inserts before the pencil. */
  private renderFocusedHeader(parent: HTMLElement, node: TreeNode): void {
    if (!node.file) return;
    const file = node.file;
    const wrap = parent.createDiv({ cls: "stashpad-focused" });

    // meta column: timestamp + a transparent grip-shaped spacer so the
    // body's left edge column-aligns with each list row's body.
    const meta = wrap.createDiv({ cls: "stashpad-focused-meta" });
    const metaTop = meta.createDiv({ cls: "stashpad-focused-meta-top" });
    metaTop.createSpan({ cls: "stashpad-focused-time stashpad-note-time", text: this.formatTime(node.created) });
    metaTop.createDiv({ cls: "stashpad-focused-grip-spacer" });

    const body = wrap.createDiv({ cls: "stashpad-focused-body" });
    // Markdown rendered inside the focused header includes #tags and
    // [[wikilinks]] — without explicit click delegation those elements
    // don't fire navigation (only the row-click handler on list rows
    // does). Wire the same tag/link handling here so the focused
    // header behaves consistently with rows.
    body.addEventListener("click", (e) => this.handleRenderedClick(e, node));

    // actions column: edit pencil + duplicate-tab button. Same shape as
    // a list row's actions (pencil + arrow) so the icons line up.
    const actions = wrap.createDiv({ cls: "stashpad-focused-actions" });
    const pencil = actions.createEl("button", { cls: "stashpad-pencil stashpad-focused-pencil" });
    setIcon(pencil, "pencil");
    pencil.title = "Edit in new tab";
    pencil.onclick = () => void this.openFileAtEnd(file);

    const dupBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-focused-dup" });
    // "copy" — the lucide icon is two overlapping document shapes,
    // which reads as "duplicate" / "clone the tab" at a glance.
    setIcon(dupBtn, "copy");
    dupBtn.title = "Open this Stashpad in a new tab (clone)";
    dupBtn.onclick = () => this.cmdOpenInNewStashpadTab(node);

    this.renderNoteBody(body, node, {
      clamp: Platform.isMobile,
      // Toggle slots into the actions cluster, BEFORE the pencil — so
      // the order (when present) reads: [More] [Edit] [Duplicate].
      toggleHost: actions,
      toggleAnchor: pencil,
    });
  }

  /** Render a clickable breadcrumb above a row's body in Flat / Everything
   *  modes — the chain of ancestors between the current focus and this
   *  note's parent (both exclusive). Each segment focuses into that
   *  ancestor on click. No-op when there are no intermediates (the row's
   *  parent IS the focus). */
  private renderRowBreadcrumb(parent: HTMLElement, node: TreeNode): void {
    const path = this.tree.pathTo(node.id);
    // path is [ancestor1, ancestor2, ..., node] (root excluded).
    // We want the slice strictly between focus and node. Focus might be
    // ROOT (not in path) → focusIdx === -1 → ancestors = all but the
    // node itself.
    const focusIdx = path.findIndex((p) => p.id === this.focusId);
    const ancestors = path.slice(focusIdx + 1, path.length - 1);
    if (ancestors.length === 0) return;

    const bc = parent.createDiv({ cls: "stashpad-row-breadcrumb" });
    ancestors.forEach((a, i) => {
      const seg = bc.createSpan({ cls: "stashpad-row-breadcrumb-seg", text: this.titleForNode(a) });
      seg.title = `Focus into "${this.titleForNode(a)}"`;
      seg.onclick = (e) => { e.stopPropagation(); this.navigateTo(a.id); };
      if (i < ancestors.length - 1) {
        bc.createSpan({ cls: "stashpad-row-breadcrumb-sep", text: " / " });
      }
    });
  }

  /** Thin shim over the shared `buildFileActions` helper so existing
   *  call sites read naturally. Returns Reveal/Show actions for a
   *  vault file; [] when the path doesn't resolve. */
  private actionsForFile(path: string): import("./notifications").NotificationAction[] {
    return buildFileActions(this.app, path, Platform.isMobile);
  }

  /** Collect distinct author + contributor ids touching the given
   *  nodes — read from each node's current frontmatter (author +
   *  contributors). Used to pre-stamp `affectedAuthorIds` on
   *  destructive notifications so the history modal's Cross-author
   *  filter still works AFTER the notes are gone from the metadata
   *  cache (a post-delete resolver lookup would return nothing). */
  private collectAuthorIds(nodes: TreeNode[]): string[] {
    const out = new Set<string>();
    const extract = (raw: unknown): string | null => {
      if (typeof raw !== "string") return null;
      const m = raw.match(/-([a-z0-9]{4,12})(?:\.md)?(?:\||\]\])/i);
      return m ? m[1] : null;
    };
    for (const n of nodes) {
      if (!n.file) continue;
      const fm = this.app.metadataCache.getFileCache(n.file)?.frontmatter;
      if (!fm) continue;
      const a = extract(fm.author);
      if (a) out.add(a);
      if (Array.isArray(fm.contributors)) {
        for (const c of fm.contributors) {
          const cid = extract(c);
          if (cid) out.add(cid);
        }
      }
    }
    return Array.from(out);
  }

  /** Multi-line bulleted list of titles, headered by the verb. Used
   *  by every bulk-action notification (delete / move / merge / etc.)
   *  so the user sees a clean, scannable list of what was touched.
   *
   *  - Empty nodes array → just the verb (+ suffix / dest).
   *  - Single node     → "Verb \"Title\" suffix dest" (single line).
   *  - 2+ nodes        → header line + bulleted list, capped at
   *                       `bulletMax` (default 10). Overflow tail is
   *                       "…+ N more". */
  private bulkActionMessage(opts: {
    verb: string;
    nodes: TreeNode[];
    suffix?: string;
    destination?: string;
    bulletMax?: number;
  }): string {
    const titles = opts.nodes.map((n) =>
      `"${this.titleForNode(n).trim() || "(untitled)"}"`,
    );
    const suffix = opts.suffix ? ` ${opts.suffix}` : "";
    const dest = opts.destination ? ` ${opts.destination}` : "";
    if (titles.length === 0) return `${opts.verb}${suffix}${dest}`;
    if (titles.length === 1) return `${opts.verb} ${titles[0]}${suffix}${dest}`;
    const max = opts.bulletMax ?? 10;
    const body = titles.length <= max
      ? titles.map((t) => `• ${t}`).join("\n")
      : titles.slice(0, max).map((t) => `• ${t}`).join("\n")
        + `\n…+ ${titles.length - max} more`;
    return `${opts.verb} ${titles.length} notes${suffix}${dest}:\n${body}`;
  }

  /** Build a short comma-separated list of node titles for use in
   *  verbose notification messages. Caps at `max` to keep toasts
   *  scannable; tail becomes `+N more`. Quotes each title so the
   *  delimiters read cleanly even with titles that contain commas.
   *  Falls back to "(untitled)" for nodes without a resolvable title.
   *  Prefer `bulkActionMessage` for >1-item action confirmations. */
  private titleList(nodes: TreeNode[], max = 3): string {
    if (!nodes.length) return "";
    const titles = nodes.map((n) => this.titleForNode(n).trim() || "(untitled)");
    if (titles.length <= max) {
      return titles.map((t) => `"${t}"`).join(", ");
    }
    const head = titles.slice(0, max).map((t) => `"${t}"`).join(", ");
    return `${head}, +${titles.length - max} more`;
  }

  private titleForNode(node: TreeNode): string {
    if (!node.file) return "Untitled";
    const cache = this.app.metadataCache.getFileCache(node.file);
    const firstHeading = cache?.headings?.[0]?.heading;
    if (firstHeading) return firstHeading;
    return node.file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ") || "Untitled";
  }

  /** Synthesize an id order array for a parent under a non-manual sort mode.
   *  Reads the parent's existing children straight from the TreeIndex (which
   *  has already been populated by the rebuild) and sorts them per the mode.
   *  Title/modified lookups use the metadata cache — cheap and consistent
   *  with how the rest of the view reads frontmatter. */
  private computeSortedIds(parentId: StashpadId, mode: SortMode): string[] {
    const kids = this.tree.getChildren(parentId);
    return kids.slice().sort((a, b) => this.compareForSort(a, b, mode)).map((n) => n.id);
  }

  private compareForSort(a: TreeNode, b: TreeNode, mode: SortMode): number {
    switch (mode) {
      case "created-asc":
        return (a.created || "").localeCompare(b.created || "");
      case "created-desc":
        return (b.created || "").localeCompare(a.created || "");
      case "modified-asc":
      case "modified-desc": {
        // Fall back to created when modified is absent so a never-edited
        // note still has a stable position.
        const ma = this.modifiedFor(a) || a.created || "";
        const mb = this.modifiedFor(b) || b.created || "";
        return mode === "modified-asc"
          ? ma.localeCompare(mb)
          : mb.localeCompare(ma);
      }
      case "title-az":
      case "title-za": {
        const ta = this.titleForNode(a);
        const tb = this.titleForNode(b);
        // `numeric: true` makes "Item 2" come before "Item 10", which is
        // what you want when notes are numbered lists. `sensitivity: base`
        // makes the sort case-insensitive (A and a tie before the next
        // letter). Both compare-options are universally supported.
        const opts = { numeric: true, sensitivity: "base" } as const;
        return mode === "title-az"
          ? ta.localeCompare(tb, undefined, opts)
          : tb.localeCompare(ta, undefined, opts);
      }
      default:
        return 0;
    }
  }

  private modifiedFor(node: TreeNode): string {
    if (!node.file) return "";
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
    return (typeof fm?.modified === "string" ? fm.modified : "") || "";
  }

  /** Force a parent's sort mode back to "manual" after any operation that
   *  mutates its manual order (drag-reorder, keyboard move). Without this,
   *  dragging a row while in a non-manual sort would silently update the
   *  stored manual order behind the scenes and the visible order wouldn't
   *  change — confusing. Per the design decision: drag means "I want this
   *  exact order," so we honor it by snapping the view to manual mode. */
  private async forceManualMode(parentId: StashpadId): Promise<void> {
    const folder = this.noteFolder;
    if (this.sortStore.getMode(folder, parentId) === "manual") return;
    this.sortStore.setMode(folder, parentId, "manual");
    await this.sortStore.save(folder);
  }

  private renderNote(parent: HTMLElement, node: TreeNode, idx: number): void {
    if (!node.file) return;
    const file = node.file;
    const childCount = this.tree.getChildren(node.id).length;
    const isSelected = this.selection.has(node.id);
    const isCursor = idx === this.cursorIdx;
    const isPickTarget = this.inListPicker?.activeIdx === idx;

    const row = parent.createDiv({ cls: "stashpad-note" });
    if (isSelected) row.addClass("is-selected");
    if (isCursor) row.addClass("is-cursor");
    if (isPickTarget) row.addClass("is-pick-target");
    if (this.isCompleted(node)) row.addClass("is-completed");
    row.dataset.idx = String(idx);
    row.dataset.id = node.id;
    // Drag-reorder is only meaningful when we're showing immediate children
    // of the focus (Nested mode). In Flat / Everything the row's "position"
    // among its siblings is synthesized from a sort, not stored — dragging
    // would have nothing well-defined to mutate.
    const draggable = this.currentViewMode() === "nested";
    row.draggable = draggable;
    if (draggable) this.attachRowDnD(row, node, idx);

    row.addEventListener("click", (e) => this.handleRowClick(e, idx, node));

    const meta = row.createDiv({ cls: "stashpad-note-meta" });
    const metaTop = meta.createDiv({ cls: "stashpad-note-meta-top" });
    metaTop.createSpan({ cls: "stashpad-note-time", text: this.formatTime(node.created) });
    // Drag handle / color swatch: a single element that shows a colored
    // square at rest (when this note has a custom color) and swaps to the
    // grip-vertical icon on row hover. Explicitly draggable so the grip
    // (an SVG-containing div) participates in the row's HTML5 drag.
    const color = this.colorForNode(node);
    const grip = metaTop.createDiv({ cls: "stashpad-note-grip" });
    if (color) grip.addClass("has-color");
    setIcon(grip, "grip-vertical");
    grip.title = color ? "Drag to reorder · right-click to change color" : "Drag to reorder";
    grip.draggable = draggable;
    if (!draggable) grip.title = color ? "Right-click to change color · drag disabled in this view mode" : "Drag disabled in this view mode";
    if (color) grip.style.setProperty("--stashpad-note-color", color);
    if (childCount > 0) {
      const enter = meta.createSpan({ cls: "stashpad-note-enter" });
      if (color) enter.style.color = color;
      setIcon(enter.createSpan({ cls: "stashpad-btn-icon" }), "corner-down-right");
      enter.createSpan({ text: ` ${childCount}` });
      enter.onclick = (e) => { e.stopPropagation(); this.navigateTo(node.id); };
    }
    if (color) {
      row.addClass("has-color");
      row.style.setProperty("--stashpad-note-color", color);
    } else {
      // No own color — see if an ancestor is colored and paint a side
      // stripe tinted by that ancestor, faded by depth. Only meaningful
      // when depth > 0 (depth 0 means this note IS the colored one, and
      // the existing has-color path handles that case with a full border).
      const inherited = this.inheritedColorForNode(node);
      if (inherited && inherited.depth > 0) {
        row.addClass("has-inherited-color");
        row.style.setProperty("--stashpad-inherited-color", inherited.hex);
        row.style.setProperty("--stashpad-inherited-depth", String(inherited.depth));
      }
    }

    const body = row.createDiv({ cls: "stashpad-note-body" });
    // In Flat / Everything mode show a small clickable breadcrumb above
    // the body — the chain of ancestors between the current focus and
    // this note's parent. Gives "where does this row live in the tree"
    // context that's otherwise lost when the list is flat. Click on a
    // segment focuses into that ancestor. Skipped when the parent IS
    // the focus (i.e. the row would be a child in nested mode too —
    // nothing to disambiguate).
    if (this.currentViewMode() !== "nested") {
      this.renderRowBreadcrumb(body, node);
    }
    // The actual note body content (text + attachment rail + authorship
    // footer) lives in its own wrapper so renderNoteBody's container.empty()
    // doesn't wipe the breadcrumb above.
    const bodyContent = body.createDiv({ cls: "stashpad-note-body-content" });
    // Build the actions cluster first so we can pass it (and the pencil)
    // to renderNoteBody as the host/anchor for the Show More toggle —
    // the toggle then lands beside the pencil instead of below the body.
    const actions = row.createDiv({ cls: "stashpad-note-actions" });
    const pencil = actions.createEl("button", { cls: "stashpad-pencil" });
    setIcon(pencil, "pencil");
    pencil.title = "Edit in new tab";
    pencil.onclick = (e) => { e.stopPropagation(); void this.openFileAtEnd(file); };
    const enterBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-enter-btn" });
    setIcon(enterBtn, "arrow-right");
    enterBtn.title = "Open in Stashpad view";
    enterBtn.onclick = (e) => { e.stopPropagation(); this.navigateTo(node.id); };

    // Now the actions cluster exists, render the body and route the
    // Show More toggle into that cluster (anchored before the pencil).
    this.renderNoteBody(bodyContent, node, { clamp: true, toggleHost: actions, toggleAnchor: pencil });

    row.oncontextmenu = (evt) => { evt.preventDefault(); this.openNoteMenu(evt, node); };
  }

  /** Per-file rendered-body cache, keyed by `(path, mtime)`. Stores the
   *  parsed (stripped frontmatter, attachments split out) text + rendered
   *  HTML so a re-render of the same row doesn't re-issue the cachedRead,
   *  re-run stripFrontmatter/splitAttachments, or re-run MarkdownRenderer.
   *
   *  On a network drive this skips the round-trip; on a low-spec CPU it
   *  skips the markdown parse (the dominant per-row cost). On mtime
   *  mismatch the entry is silently replaced — Obsidian updates `stat.mtime`
   *  whenever the file changes, so cache invalidation is automatic.
   *
   *  Memory profile: typical Stashpad note renders to ~2-5 KB of HTML, so
   *  a 1000-note vault sits around 2-5 MB. Acceptable; an LRU bound can
   *  go on later if it becomes a problem. */
  private renderCache = new Map<string, { mtime: number; text: string; attachments: string[]; html: string }>();

  private async getOrComputeRender(file: TFile): Promise<{ text: string; attachments: string[]; html: string }> {
    const cached = this.renderCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached;
    // Cache miss / stale entry. Read + parse + render into a detached div
    // and stash the result before returning.
    const md = await this.app.vault.cachedRead(file);
    const raw = this.stripFrontmatter(md);
    const { text, attachments } = this.splitAttachments(raw);
    const detached = createDiv({ cls: "stashpad-note-text" });
    await MarkdownRenderer.render(this.app, text, detached, file.path, this as any);
    const html = detached.innerHTML;
    const entry = { mtime: file.stat.mtime, text, attachments, html };
    this.renderCache.set(file.path, entry);
    return entry;
  }

  private renderNoteBody(
    container: HTMLElement,
    node: TreeNode,
    opts: { clamp?: boolean; toggleHost?: HTMLElement; toggleAnchor?: HTMLElement } = { clamp: true },
  ): void {
    if (!node.file) return;
    const file = node.file;
    // Token guard: if a newer render starts on the same container before our
    // async resolve, we abort. Without this, two renders in quick succession
    // would both append to the container — producing duplicated bodies,
    // ghost rows, and "row that doesn't visually change on select" because
    // the second resolve attached over a stale shell.
    const token = ((container as any).__stashpadRenderToken ?? 0) + 1;
    (container as any).__stashpadRenderToken = token;
    void this.getOrComputeRender(file).then((entry) => {
      if ((container as any).__stashpadRenderToken !== token) return;
      const { text: _text, attachments, html } = entry;
      // Clear any stale content that earlier renders left behind before
      // appending fresh nodes.
      container.empty();
      const textEl = container.createDiv({ cls: "stashpad-note-text" });
      const expanded = this.expandedNotes.has(node.id);
      if (opts.clamp && !expanded) textEl.addClass("is-clamped");
      // Re-hydrate the cached markdown HTML by assigning innerHTML. Obsidian
      // uses event delegation for internal links / tags / embeds, so the
      // restored DOM still wires up correctly without needing a fresh
      // MarkdownRenderer pass. (Live-rendered widgets like Mermaid/MathJax
      // are the one weak spot — those won't re-execute from cached HTML,
      // but they're rare in chat-style notes and re-render on next mtime
      // change anyway.)
      textEl.innerHTML = html;
      if (attachments.length > 0) this.renderAttachmentRail(container, attachments);
      // Multiplayer footer: author / contributors / last-edit. Each
      // sub-piece is gated by its own toggle in settings; the row only
      // renders if at least one piece is enabled AND has data.
      this.renderAuthorshipFooter(container, node);
      if (!opts.clamp) return;
      // After layout, decide whether to keep the clamp + show the toggle.
      requestAnimationFrame(() => {
        // With line-clamp the text node's clientHeight reflects the
        // 2-line cap; scrollHeight reflects the full unconstrained
        // height. A small tolerance avoids spurious "More" toggles for
        // text that fits in 2 lines exactly.
        const overflowing = textEl.scrollHeight > textEl.clientHeight + 4;
        if (!overflowing && !expanded) {
          // Short note that fits — drop the clamp so the fade gradient doesn't apply.
          textEl.removeClass("is-clamped");
          return;
        }
        // Render the toggle into the host the caller provided (e.g. the
        // actions cluster on a list row, or the focused-header bar) so
        // it sits beside the edit pencil instead of below the body. The
        // host always gets icon-only treatment regardless of platform —
        // it's living inline with other action buttons. When no host is
        // provided, fall back to inline-text-button below the body.
        const inHost = !!opts.toggleHost;
        const host = opts.toggleHost ?? container;
        // Remove any old toggle the host may already have (re-renders).
        host.querySelector(".stashpad-expand-toggle")?.remove();
        const toggle = host.createEl("button", { cls: "stashpad-expand-toggle" });
        toggle.title = expanded ? "Show less" : "Show more";
        if (inHost || Platform.isMobile) {
          setIcon(toggle, expanded ? "chevron-up" : "chevron-down");
          toggle.addClass("is-icon");
          if (inHost) toggle.addClass("is-inline");
        } else {
          toggle.setText(expanded ? "Show less" : "Show more");
        }
        // If the caller wanted the toggle slotted before a specific
        // sibling (e.g. before the pencil), do that.
        if (opts.toggleAnchor && opts.toggleAnchor.parentElement === host) {
          host.insertBefore(toggle, opts.toggleAnchor);
        }
        toggle.onclick = (e) => {
          e.stopPropagation();
          if (this.expandedNotes.has(node.id)) this.expandedNotes.delete(node.id);
          else this.expandedNotes.add(node.id);
          // Re-render just this body in place to preserve list scroll.
          container.empty();
          this.renderNoteBody(container, node, opts);
        };
      });
    });
  }

  private splitAttachments(body: string): { text: string; attachments: string[] } {
    const attachments: string[] = [];
    const text = body.replace(/!\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]/g, (_m, p1) => {
      attachments.push(p1);
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { text, attachments };
  }

  private renderAttachmentRail(parent: HTMLElement, paths: string[]): void {
    const rail = parent.createDiv({ cls: "stashpad-rail" });
    for (const p of paths) {
      const file = this.app.metadataCache.getFirstLinkpathDest(p, "");
      const ext = (p.split(".").pop() ?? "").toLowerCase();
      const box = rail.createDiv({ cls: "stashpad-att" });
      box.title = p;
      if (file && IMG_EXT.has(ext)) {
        const img = box.createEl("img", { cls: "stashpad-att-img" });
        img.src = this.app.vault.getResourcePath(file);
        img.alt = p;
      } else {
        box.createDiv({ cls: "stashpad-att-ext", text: ext.toUpperCase() || "?" });
        const name = (p.split("/").pop() ?? p).replace(/\.[^.]+$/, "");
        box.createDiv({ cls: "stashpad-att-name", text: name });
      }
      box.onclick = (e) => {
        e.stopPropagation();
        if (file) void this.app.workspace.getLeaf("tab").openFile(file);
      };
    }
  }

  private renderComposer(parent: HTMLElement): void {
    const settings = getSettings();
    const enterSubmits = this.modeEnterSubmits;
    const splitMode = this.modeSplit ?? settings.splitOnLines;

    // Auto-restore was a band-aid that papered over an upstream race
    // (loadDraftsForFolder running before the right noteFolder was set).
    // It also caused the "draft keeps coming back after Enter" bug across
    // multiple Stashpad tabs sharing the default folder. Removed entirely;
    // the textarea now reflects only what loadDraftsForFolder put into
    // composerDraft. If composerDraft is wrong, fix it at the source.
    const restoredText: string | null = null;

    const composer = parent.createDiv({ cls: "stashpad-composer" });

    // Wrap the textarea so we can absolutely-position the clear-X over it.
    const taWrap = composer.createDiv({ cls: "stashpad-composer-input-wrap" });
    const ta = taWrap.createEl("textarea", {
      cls: "stashpad-composer-input",
      attr: { rows: "2", placeholder: this.composerPlaceholder(enterSubmits, splitMode) },
    }) as HTMLTextAreaElement;
    ta.value = this.composerDraft;

    // Clear-X button: only shown right after auto-restore. Hides on input or click.
    let clearBtn: HTMLButtonElement | null = null;
    const removeClearBtn = () => {
      if (clearBtn) { clearBtn.remove(); clearBtn = null; }
    };
    if (restoredText !== null && restoredText.length > 0) {
      clearBtn = taWrap.createEl("button", { cls: "stashpad-composer-clear" }) as HTMLButtonElement;
      setIcon(clearBtn, "x");
      clearBtn.title = "Clear restored draft";
      clearBtn.onmousedown = (e) => e.preventDefault(); // don't steal focus from textarea
      clearBtn.onclick = (e) => {
        e.preventDefault();
        ta.value = "";
        this.composerDraft = "";
        void this.saveDraft("");
        removeClearBtn();
        ta.focus();
      };
      // Select all on next frame so the user can type-to-replace.
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(0, ta.value.length);
      });
    }

    // Debounce non-empty saves so fast typing doesn't queue a disk write
    // per keystroke (a real issue on slow / network drives). Empty/clear
    // saves still go through immediately on submit/blur for promptness.
    if (!this.debouncedSaveDraft) {
      this.debouncedSaveDraft = debounce((v: string) => { void this.saveDraft(v); }, 250);
    }
    ta.addEventListener("input", () => {
      this.composerDraft = ta.value;
      this.debouncedSaveDraft!(ta.value);
      removeClearBtn(); // any keystroke means the user is past the "restored" state
    });
    ta.addEventListener("blur", () => { void this.saveDraft(ta.value); });

    // Push a keymap Scope while the composer is focused that consumes
    // Escape — without this, hitting Escape on an empty composer fires
    // Obsidian's workspace-level "Escape returns to last leaf" handler
    // and warps the user to a previously-active tab. The autocomplete
    // popup pushes its OWN deeper scope when open, so this handler only
    // fires when no popup is on top. On Escape with no popup, we just
    // blur back to the view root (no destructive behavior) and return
    // false so the workspace handler never sees the event.
    let composerScope: Scope | null = null;
    const pushComposerScope = (): void => {
      if (composerScope) return;
      composerScope = new Scope((this.app as any).scope);
      composerScope.register([], "Escape", () => {
        ta.blur();
        this.viewRoot?.focus({ preventScroll: true } as any);
        return false;
      });
      (this.app as any).keymap?.pushScope(composerScope);
    };
    const popComposerScope = (): void => {
      if (!composerScope) return;
      try { (this.app as any).keymap?.popScope(composerScope); } catch {}
      composerScope = null;
    };
    ta.addEventListener("focus", pushComposerScope);
    ta.addEventListener("blur", popComposerScope);
    // If the textarea was already focused when this code runs (e.g. the
    // composer just rendered with focus restored), push immediately.
    if (document.activeElement === ta) pushComposerScope();
    // Mobile: treat composer focus as a keyboard-up signal. visualViewport
    // events don't fire reliably inside Obsidian's webview, so this is a
    // more dependable proxy for "keyboard is showing right now."
    if (Platform.isMobile) {
      ta.addEventListener("focus", () => document.body.classList.add("stashpad-keyboard-open"));
      ta.addEventListener("blur", () => document.body.classList.remove("stashpad-keyboard-open"));
    }
    this.composerInputEl = ta;
    // Tear down any previous autocomplete (the textarea was just rebuilt
    // by render) and attach a fresh one to the new node.
    if (this.composerAutocomplete) this.composerAutocomplete.detach();
    this.composerAutocomplete = new ComposerAutocomplete(this.app, ta);
    this.composerAutocomplete.attach();

    // Drag-and-drop + paste of files into the composer. Both flows
    // funnel through importAttachment (same code path the paperclip
    // button uses), so each dropped/pasted file is copied into
    // <stashpad>/_attachments and an ![[wikilink]] is appended to the
    // textarea body.
    const importAndAppend = async (files: File[]): Promise<void> => {
      let appended = "";
      for (const f of files) {
        const link = await this.importAttachment(f);
        if (!link) continue;
        const cur = ta.value + appended;
        const sep = cur && !cur.endsWith("\n") ? "\n" : "";
        appended += `${sep}${link}\n`;
      }
      if (appended) {
        ta.value = ta.value + appended;
        this.composerDraft = ta.value;
        void this.saveDraft(ta.value);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    };

    ta.addEventListener("dragover", (e) => {
      // Only accept drags that actually carry files — otherwise text
      // selections from elsewhere in the page would be hijacked too.
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = "copy"; } catch {}
    });
    ta.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void importAndAppend(files);
    });
    ta.addEventListener("paste", (e) => {
      // clipboardData.files covers explicit file copies (Finder/Explorer);
      // .items covers screenshot pastes (image/png with no .files entry
      // on some platforms). Iterating items and grabbing kind:"file" is
      // the safe superset.
      const out: File[] = [];
      const data = e.clipboardData;
      if (!data) return;
      for (const f of Array.from(data.files ?? [])) out.push(f);
      if (out.length === 0) {
        for (const it of Array.from(data.items ?? [])) {
          if (it.kind === "file") {
            const f = it.getAsFile();
            if (f) out.push(f);
          }
        }
      }
      if (out.length === 0) return; // pure text paste — let it through
      e.preventDefault();
      e.stopPropagation();
      void importAndAppend(out);
    });

    const fileInput = composer.createEl("input", {
      cls: "stashpad-composer-file-input", type: "file", attr: { multiple: "true" },
    }) as HTMLInputElement;
    fileInput.style.display = "none";

    const btnRail = composer.createDiv({ cls: "stashpad-composer-btn-rail" });
    // Mobile: secondary buttons (split/dest/enter/clip) live inside a
    // collapsible group. A chevron-left button at the head of the rail
    // toggles their visibility — collapsed at rest to keep the composer
    // uncluttered. Send always stays outside the group.
    const expandedGroup = btnRail.createDiv({ cls: "stashpad-composer-btn-group" });
    const splitBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn" });
    setIcon(splitBtn, "list-end");
    splitBtn.title = splitMode ? "Split on newlines: ON (Mod+/)" : "Split on newlines (Mod+/)";
    if (splitMode) splitBtn.addClass("is-active");
    splitBtn.onmousedown = (e) => e.preventDefault();
    splitBtn.onclick = (e) => { e.preventDefault(); this.toggleSplit(); };

    const destBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn" });
    setIcon(destBtn, "map-pin");
    if (this.nextDestination) {
      destBtn.createSpan({ text: ` ${this.destinationLabel()}`, cls: "stashpad-btn-text" });
    }
    destBtn.title = "Set destination (Mod+D)";
    if (this.nextDestination) destBtn.addClass("is-active");
    // mousedown.preventDefault stops the button from stealing focus from
    // the composer (which on mobile would dismiss the keyboard). The
    // click still fires.
    destBtn.onmousedown = (e) => e.preventDefault();
    destBtn.onclick = (e) => {
      e.preventDefault();
      const wasFocused = document.activeElement === ta;
      this.openDestinationPicker();
      // Refocus the composer once the picker dialog closes (covers the
      // "tap dest, then dismiss" path without losing the keyboard).
      if (wasFocused) {
        const refocus = () => { ta.focus(); };
        setTimeout(refocus, 50);
        setTimeout(refocus, 250);
      }
    };

    const enterBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn" });
    setIcon(enterBtn, enterSubmits ? "corner-down-left" : "arrow-big-down-dash");
    enterBtn.title = enterSubmits
      ? "Enter sends (click to switch to Shift+Enter)"
      : "Shift+Enter sends (click to switch to Enter)";
    enterBtn.onmousedown = (e) => e.preventDefault();
    enterBtn.onclick = (e) => {
      e.preventDefault();
      this.modeEnterSubmits = !enterSubmits;
      this.render();
      // After render, `ta` is detached — use the freshly mounted composerInputEl.
      this.composerInputEl?.focus();
    };

    const appendLink = (link: string) => {
      const sep = ta.value && !ta.value.endsWith("\n") ? "\n" : "";
      ta.value += `${sep}${link}\n`;
      this.composerDraft = ta.value;
    };

    const clipBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn" });
    setIcon(clipBtn, "paperclip");
    clipBtn.title = "Attach files";
    clipBtn.onmousedown = (e) => e.preventDefault();
    clipBtn.onclick = (e) => {
      e.preventDefault();
      const wasFocused = document.activeElement === ta;
      fileInput.click();
      // The native file picker is a system overlay and will blur the
      // textarea regardless of preventDefault. Re-focus once the user
      // cancels or the change event lands.
      if (wasFocused) {
        const refocus = () => { ta.focus(); };
        setTimeout(refocus, 100);
        setTimeout(refocus, 500);
      }
    };
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = "";
      for (const f of files) {
        const link = await this.importAttachment(f);
        if (link) appendLink(link);
      }
      ta.focus();
    });

    // Mobile: insert the expand-toggle BEFORE the group in the rail.
    // Tapping it slides the group out (and flips the chevron). Desktop
    // ignores this — the group is always visible there via CSS.
    if (Platform.isMobile) {
      const toggleBtn = btnRail.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-rail-toggle" });
      setIcon(toggleBtn, "chevron-left");
      toggleBtn.title = "Show more composer options";
      // Prepend so it sits BEFORE the group in source order.
      btnRail.insertBefore(toggleBtn, expandedGroup);
      const setExpanded = (open: boolean): void => {
        btnRail.toggleClass("is-expanded", open);
        toggleBtn.title = open ? "Hide options" : "Show more composer options";
        // Flip the chevron to face right when open (rail collapses to the right).
        setIcon(toggleBtn, open ? "chevron-right" : "chevron-left");
      };
      toggleBtn.onmousedown = (e) => e.preventDefault();
      toggleBtn.onclick = (e) => {
        e.preventDefault();
        setExpanded(!btnRail.hasClass("is-expanded"));
      };
      setExpanded(false);
    }

    const sendBtn = btnRail.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-send" });
    sendBtn.title = "Send (Enter)";
    setIcon(sendBtn, "arrow-up");
    const submit = async () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = "";
      this.composerDraft = "";
      // Clear the persisted draft IMMEDIATELY and AWAIT both writes so a
      // reload (or beforeunload race) right after Enter can't see a stale
      // draft on disk. Earlier this was fire-and-forget, which let the
      // draft re-appear on reload if writes were still in flight.
      try { await this.saveDraft(""); } catch {}
      try { await this.recordLastSubmitted(text); } catch {}
      const split = this.modeSplit ?? getSettings().splitOnLines;
      const dest = this.nextDestination;
      this.nextDestination = null;
      this.autoSelectNewest = true;
      this.scrollToBottomOnNextRender = true;
      if (split) {
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) await this.createNoteUnder(t, dest);
        }
      } else {
        await this.createNoteUnder(text, dest);
      }
      // Keep focus in the composer so the user can keep typing without
      // re-clicking — unless the user disabled this in settings.
      if (getSettings().autofocusComposerAfterSend) {
        this.focusComposerOnNextRender = true;
      }
    };
    sendBtn.onclick = () => void submit();

    ta.addEventListener("keydown", (e) => {
      const submitsOnEnter = this.modeEnterSubmits;
      // Cmd+Z / Cmd+Shift+Z: when the composer is empty (typically right after submit),
      // route to Stashpad's undo/redo instead of the textarea's native undo.
      if (ta.value.length === 0) {
        const cb = getSettings().bindings;
        if (matchBinding(e, cb.undo)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdUndo(); return; }
        if (matchBinding(e, cb.redo)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdRedo(); return; }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ta.blur();
        this.viewRoot.focus({ preventScroll: true });
        return;
      }
      // ↑ at the very start of the textarea → jump out into the list, landing on
      // the LAST note (closest to composer) regardless of any prior cursor state.
      // Subsequent arrow ups within the list decrement normally.
      if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        ta.blur();
        this.viewRoot.focus({ preventScroll: true });
        if (this.currentChildren.length > 0) {
          this.cursorIdx = this.currentChildren.length - 1;
          this.selectCursor(false);
        }
        return;
      }
      if (e.key === "Enter" && !e.isComposing) {
        const send = submitsOnEnter ? !e.shiftKey : e.shiftKey;
        if (send) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void submit(); }
      }
    });

    const helper = parent.createDiv({ cls: "stashpad-composer-help" });
    helper.setText(this.composerHelperText(enterSubmits, splitMode));
  }

  private composerPlaceholder(enterSubmits: boolean, split: boolean): string {
    // Short placeholder on mobile — the long send/newline hint is desktop
    // chrome that mobile users don't need (and that wraps to two lines on
    // narrow screens).
    if (Platform.isMobile) return split ? "New notes (split on newlines)" : "New note";
    const send = enterSubmits ? "Enter" : "Shift+Enter";
    const newline = enterSubmits ? "Shift+Enter" : "Enter";
    return `Type a note. ${send} = send, ${newline} = newline${split ? " (each line → a note)" : ""}…`;
  }
  private composerHelperText(enterSubmits: boolean, split: boolean): string {
    const send = enterSubmits ? "Enter" : "Shift+Enter";
    const newline = enterSubmits ? "Shift+Enter" : "Enter";
    // Pick whichever slot is set (preferRight wins when both); fall back to
    // primary so the helper text always has something to show.
    const b = getSettings().bindings;
    const pickActive = (id: keyof typeof b): string => {
      const x = b[id];
      if (x.primary && x.secondary) return x.preferRight ? x.secondary : x.primary;
      return x.primary || x.secondary;
    };
    const tf = humanCombo(pickActive("toggleSplit"));
    const pd = humanCombo(pickActive("pickDestination"));
    const sr = humanCombo(pickActive("search"));
    const dest = this.nextDestination ? `  •  destination: ${this.destinationLabel()}` : "";
    return `${send} sends · ${newline} newline · ${tf} split: ${split ? "ON" : "off"} · ${pd} destination · ${sr} search${dest}`;
  }
  private destinationLabel(): string {
    if (!this.nextDestination) return "current";
    if (this.nextDestination === ROOT_ID) return "Home";
    const node = this.tree.get(this.nextDestination);
    return node ? this.titleForNode(node).trim() : "?";
  }

  private renderMobileNav(parent: HTMLElement): void {
    const nav = parent.createDiv({ cls: "stashpad-mobile-nav" });
    nav.createEl("button", { text: "Home" }).onclick = () => this.navigateTo(ROOT_ID);
    nav.createEl("button", { text: "Back" }).onclick = () => this.navigateUp();
    nav.createEl("button", { text: "Bookmarks" }).onclick = () => this.openBookmarks();
  }

  // --- Click + selection ---

  /** Tag + internal-link click delegation for any rendered-markdown
   *  surface that ISN'T a row (focused header body, mini header, etc.).
   *  Same routing as handleRowClick's tag/link branches; doesn't touch
   *  selection / cursor — those concepts don't apply outside the list. */
  private handleRenderedClick(e: MouseEvent, node: TreeNode): void {
    const targetEl = e.target as HTMLElement | null;
    const tag = targetEl?.closest?.(".tag") as HTMLElement | null;
    if (tag) {
      e.preventDefault();
      e.stopPropagation();
      const raw = tag.getAttribute("href") || tag.textContent || "";
      const name = raw.replace(/^#/, "").trim();
      if (name) {
        const sp = (this.app as any).internalPlugins?.plugins?.["global-search"];
        const open = sp?.instance?.openGlobalSearch?.bind(sp.instance);
        if (open) open(`tag:#${name}`);
      }
      return;
    }
    const link = targetEl?.closest?.(".internal-link") as HTMLElement | null;
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute("data-href") || link.getAttribute("href");
      if (href) {
        const sourcePath = node.file?.path || "";
        void this.app.workspace.openLinkText(href, sourcePath, true);
      }
    }
  }

  private handleRowClick(e: MouseEvent, idx: number, node: TreeNode): void {
    const targetEl = e.target as HTMLElement | null;
    // Tag click → open global search filtered by that tag.
    const tag = targetEl?.closest?.(".tag") as HTMLElement | null;
    if (tag) {
      e.preventDefault();
      e.stopPropagation();
      const raw = tag.getAttribute("href") || tag.textContent || "";
      const name = raw.replace(/^#/, "").trim();
      if (name) {
        const sp = (this.app as any).internalPlugins?.plugins?.["global-search"];
        const open = sp?.instance?.openGlobalSearch?.bind(sp.instance);
        if (open) open(`tag:#${name}`);
      }
      return;
    }
    // If the click is on an internal link inside the rendered note body, open the
    // target note in a new tab and don't treat it as a row select.
    const link = targetEl?.closest?.(".internal-link") as HTMLElement | null;
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute("data-href") || link.getAttribute("href");
      if (href) {
        const sourcePath = node.file?.path || "";
        // Always open in a new tab (third arg = true means "split / new leaf").
        void this.app.workspace.openLinkText(href, sourcePath, true);
      }
      return;
    }
    // External links (target=_blank): let them fall through to default browser handling.
    if (targetEl?.tagName === "A" && (targetEl as HTMLAnchorElement).href) {
      // Don't stopPropagation — let Obsidian's external link handler open it.
      return;
    }
    e.stopPropagation();
    if (this.inListPicker) {
      this.inListPicker.activeIdx = idx;
      void this.commitInListPicker();
      return;
    }
    this.cursorIdx = idx;
    // Track the FIRST id added to the current selection sequence — set
    // when selection grows from empty, cleared when it goes back to
    // empty. Esc collapses multi-select down to this anchor.
    const wasEmpty = this.selection.size === 0;
    if (e.shiftKey && this.lastSelected) {
      const lastIdx = this.currentChildren.findIndex((n) => n.id === this.lastSelected);
      if (wasEmpty) this.firstSelectedId = this.lastSelected;
      if (lastIdx !== -1) {
        const [a, b] = lastIdx < idx ? [lastIdx, idx] : [idx, lastIdx];
        for (let i = a; i <= b; i++) this.selection.add(this.currentChildren[i].id);
      } else this.selection.add(node.id);
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selection.has(node.id)) {
        this.selection.delete(node.id);
        if (this.firstSelectedId === node.id) this.firstSelectedId = null;
      } else {
        if (wasEmpty) this.firstSelectedId = node.id;
        this.selection.add(node.id);
      }
    } else if (this.mobileSelectMode) {
      // In explicit select mode: taps toggle membership. Tap the select
      // button (top-right) to exit — that collapses to the first added.
      if (this.selection.has(node.id)) {
        this.selection.delete(node.id);
        if (this.firstSelectedId === node.id) this.firstSelectedId = null;
      } else {
        this.selection.add(node.id);
      }
    } else {
      // Plain click: replace the selection. Reset firstSelectedId so
      // the new anchor is this node.
      this.selection.clear();
      this.selection.add(node.id);
      this.firstSelectedId = node.id;
    }
    if (this.selection.size === 0) this.firstSelectedId = null;
    this.lastSelected = node.id;
    this.viewRoot.focus({ preventScroll: true });
    this.render();
    this.revealCursorRow();
  }

  private revealCursorRow(): void {
    const doReveal = () => {
      const row = this.listEl?.querySelector(`[data-idx="${this.cursorIdx}"]`) as HTMLElement | null;
      if (!row || !this.listEl) return;
      const list = this.listEl;
      const lr = list.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const pad = 4;
      if (rr.top < lr.top + pad) list.scrollTop += rr.top - lr.top - pad;
      else if (rr.bottom > lr.bottom - pad) list.scrollTop += rr.bottom - lr.bottom + pad;
    };
    doReveal();
    requestAnimationFrame(doReveal);
    setTimeout(doReveal, 60);
    setTimeout(doReveal, 200);
  }

  // --- Document-level keyboard ---

  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (!this.viewRoot.isConnected) return;
    // Run when our Stashpad leaf is the active one, regardless of where focus
    // happens to live (chrome, viewRoot, an inner button, etc). This is what lets
    // space work right after tab activation, before the user has clicked in.
    if (this.app.workspace.activeLeaf !== this.leaf) return;
    // Bail out while ANY Obsidian modal is open — arrow keys / Enter /
    // shortcuts all belong to the modal then. Try several selectors
    // because Obsidian's exact DOM shape varies by version: sometimes the
    // .modal-container is always present (with .mod-show toggled), other
    // times it's added/removed wholesale. Cover the common shapes.
    if (isAnyModalOpen(e.target)) return;

    const b = getSettings().bindings;
    // VIEW-LEVEL global shortcuts (fire even from within the composer textarea):
    //   - toggleSplit / pickDestination / search affect view state, not list data,
    //     and users expect them to work while composing too.
    if (matchBinding(e, b.toggleSplit)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.toggleSplit(); return; }
    if (matchBinding(e, b.pickDestination)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.openDestinationPicker(); return; }
    if (matchBinding(e, b.search)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.openSearchModal(); return; }
    if (matchBinding(e, b.searchInParent)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.openSearchInParentModal(); return; }
    // Folder switch / .stash import-export bindings — fire from anywhere
    // in the view (composer or list). Default chord is empty; user binds
    // explicitly via settings. Listed here so a keybind set to
    // exportStash etc. actually fires.
    if (matchBinding(e, b.exportStash)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdExportStash(); return; }
    if (matchBinding(e, b.importStash)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdImportStash(); return; }
    if (matchBinding(e, b.pickFolder)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdOpenFolderPicker(); return; }
    if (matchBinding(e, b.cloneStashpadTab)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdCloneStashpadTab(); return; }

    const target = e.target as HTMLElement | null;
    const inTextInput = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    // Space focuses the composer from anywhere in the view (buttons, view body, list rows).
    // Only let it fall through when the textarea/input is already focused (so typing space works).
    if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !inTextInput) {
      const ta = this.composerInputEl;
      if (ta) {
        e.preventDefault();
        e.stopPropagation();
        ta.focus();
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
        return;
      }
    }
    const inInput = !!target && (
      target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "BUTTON"
      || target.tagName === "SELECT"
    );

    // Esc when focus is on a BUTTON or SELECT inside our view: kick
    // focus back to the notes list so the user isn't stuck having to
    // tab around. Skip TEXTAREA / INPUT — those have their own Esc
    // handlers (composer textarea blurs to viewRoot above).
    if (e.key === "Escape"
        && target instanceof HTMLElement
        && (target.tagName === "BUTTON" || target.tagName === "SELECT")
        && this.viewRoot.contains(target)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Don't preventScroll on the focus call; if the cursor row is
      // off-screen, letting Obsidian scroll it into view is fine.
      this.viewRoot.focus();
      return;
    }

    // Esc always cancels the in-list picker, even when focus is in the composer
    // (the picker is a transient mode and should be dismissable from anywhere).
    if (this.inListPicker && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.inListPicker = null;
      // Pin scroll across the cancel-render so dismissing the highlight near
      // the bottom of the list doesn't bump the viewport up. (When the user
      // is at the very end, ResizeObserver settle picks a slightly smaller
      // settleTop after render and the list jumps; re-asserting scrollTop
      // through the next few frames keeps it glued to the bottom.)
      const list = this.listEl;
      const wasAtBottom = !!list && (list.scrollTop + list.clientHeight >= list.scrollHeight - 2);
      const keepScroll = list?.scrollTop ?? 0;
      this.render();
      if (list) {
        const target = wasAtBottom ? list.scrollHeight : keepScroll;
        list.scrollTop = target;
        requestAnimationFrame(() => { list.scrollTop = wasAtBottom ? list.scrollHeight : keepScroll; });
        setTimeout(() => { list.scrollTop = wasAtBottom ? list.scrollHeight : keepScroll; }, 60);
        // The previously-highlighted row's body re-renders async on cancel
        // (renderNoteBody is .then-based). Its body shrinks momentarily,
        // scrollHeight drops, and the browser clamps scrollTop down — which
        // hides the cursor row behind the composer. revealCursorRow runs
        // across multiple frames and pushes it back into view if needed.
        // (No-op when the row is already comfortably visible.)
        this.revealCursorRow();
      }
      return;
    }
    if (this.inListPicker && !inInput) {
      if (e.key === "ArrowDown") { e.preventDefault(); this.inListPicker.activeIdx = Math.min(this.currentChildren.length - 1, this.inListPicker.activeIdx + 1); this.render(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); this.inListPicker.activeIdx = Math.max(0, this.inListPicker.activeIdx - 1); this.render(); return; }
      if (e.key === "Enter") { e.preventDefault(); void this.commitInListPicker(); return; }
      return;
    }

    if (inInput) return;

    // LIST-MUTATING mod shortcuts: only fire when focus is NOT in an input/button.
    // Cmd+Backspace, Cmd+Enter, Cmd+arrow keys would otherwise hijack native textarea
    // behavior (delete-to-line-start, newline, caret nav).
    if (matchBinding(e, b.delete)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdDelete(); return; }
    if (matchBinding(e, b.toggleComplete)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdToggleComplete(); return; }
    if (matchBinding(e, b.moveToTop)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdMoveToTop(); return; }
    if (matchBinding(e, b.moveToBottom)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdMoveToBottom(); return; }
    if (matchBinding(e, b.moveUp)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdMoveUp(); return; }
    if (matchBinding(e, b.moveDown)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdMoveDown(); return; }
    if (matchBinding(e, b.outdent)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdOutdent(); return; }
    if (matchBinding(e, b.setColor)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdSetColor(); return; }

    // Stashpad undo/redo when focus is on the view (not the composer).
    if (matchBinding(e, b.undo)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdUndo(); return; }
    if (matchBinding(e, b.redo)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdRedo(); return; }

    if (e.key === " ") {
      e.preventDefault();
      const ta = this.composerInputEl;
      if (ta) {
        ta.focus();
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Wrap from last → first.
      if (this.cursorIdx >= this.currentChildren.length - 1) this.cursorIdx = 0;
      else this.cursorIdx++;
      this.selectCursor(e.shiftKey); return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      // Wrap from first → last (consistent with down-wrap).
      if (this.cursorIdx <= 0) this.cursorIdx = this.currentChildren.length - 1;
      else this.cursorIdx--;
      this.selectCursor(e.shiftKey); return;
    }
    // Browser-style history nav. Mouse buttons 3/4 are often hijacked by
    // Obsidian for tab navigation, so provide a keyboard equivalent.
    // (Checked BEFORE the bare ArrowLeft/Right cases so the modifier wins.)
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); this.navigateBack(); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); this.navigateForward(); return; }
    // ArrowRight navigates into the cursor row. Enter is intentionally NOT
    // bound here — it caused Enter inside modals (e.g. color picker) to
    // bleed through and navigate the underlying list. Use ArrowRight or
    // click to enter a note.
    if (e.key === "ArrowRight") {
      const node = this.currentChildren[this.cursorIdx];
      if (node) { e.preventDefault(); this.navigateTo(node.id); }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "Backspace") { e.preventDefault(); this.navigateUp(); return; }
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      // Multi-selection → collapse down to the FIRST note that was
      // added (not the last). The last-was-anchor behavior was awkward
      // because shift-click extends FROM the original anchor — losing
      // it makes you re-anchor before re-selecting.
      const collapseTo = this.firstSelectedId
        ?? (this.selection.size > 0 ? this.selection.values().next().value : null);
      this.selection.clear();
      this.firstSelectedId = null;
      if (collapseTo) {
        const idx = this.currentChildren.findIndex((n) => n.id === collapseTo);
        this.selection.add(collapseTo);
        this.lastSelected = collapseTo;
        if (idx >= 0) this.cursorIdx = idx;
      }
      this.render();
      this.revealCursorRow();
      return;
    }

    const sb = getSettings().bindings;
    if (this.selection.size > 0 || (this.cursorIdx >= 0 && this.currentChildren[this.cursorIdx])) {
      if (matchBinding(e, sb.move)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdMovePicker(); return; }
      if (matchBinding(e, sb.pickMove)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdInListPicker(); return; }
      if (matchBinding(e, sb.merge)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdMerge(); return; }
      if (matchBinding(e, sb.copy)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopy(); return; }
      if (matchBinding(e, sb.copyTree)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyTree(); return; }
      if (matchBinding(e, sb.copyOutline)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyOutline(); return; }
      if (matchBinding(e, sb.openEditor)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (e.shiftKey) {
          // Shift+E → edit the parent (focused) note, regardless of what's selected.
          const focused = this.tree.get(this.focusId);
          if (focused?.file) this.cmdOpenInEditor(focused);
        } else {
          this.cmdOpenInEditor();
        }
        return;
      }
      if (matchBinding(e, sb.openTab)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdOpenInNewStashpadTab(); return; }
      if (matchBinding(e, sb.split)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdSplit(); return; }
      if (matchBinding(e, sb.clone)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdClone(); return; }
      if (matchBinding(e, sb.insertTemplate)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdInsertTemplate(); return; }
      if (matchBinding(e, sb.toggleExpand)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdToggleExpand(); return; }
    }
    // Allow E / T from focused-header context too (no selection / cursor required).
    const focused = this.tree.get(this.focusId);
    if (focused?.file) {
      if (matchBinding(e, sb.openEditor)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        // Both plain E and Shift+E land on the focused note here (it's the only target).
        this.cmdOpenInEditor(focused);
        return;
      }
      if (matchBinding(e, sb.openTab)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdOpenInNewStashpadTab(focused); return; }
    }
  };

  private selectCursor(shift: boolean): void {
    const node = this.currentChildren[this.cursorIdx];
    if (!node) return;
    if (!shift) this.selection.clear();
    this.selection.add(node.id);
    this.lastSelected = node.id;
    this.render();
    this.revealCursorRow();
  }

  private getActionTargets(): TreeNode[] {
    if (this.selection.size > 0) {
      return [...this.selection].map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n && !!n.file);
    }
    const cur = this.currentChildren[this.cursorIdx];
    return cur ? [cur] : [];
  }

  // --- Public commands (used by main.ts addCommand too) ---

  toggleSplit(): void {
    const cur = this.modeSplit ?? getSettings().splitOnLines;
    this.modeSplit = !cur;
    this.render();
    this.composerInputEl?.focus();
  }

  openDestinationPicker(): void {
    // 0.57.2: destination picker now spans all Stashpad folders + offers
    // each external Stashpad's root (Home) as its own pick. Picking a
    // cross-folder destination switches the view to that folder first
    // (matching the search modal's behaviour), then sets nextDestination
    // there — so the next composer submit lands in the right place.
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "pick", placeholder: "Send next note(s) under which note?",
      allowCreate: true,
      onPick: async (item) => {
        if (item.crossFolder) {
          const targetId = item.id.replace(/^cross:/, "");
          await this.switchToFolderAndFocus(item.crossFolder, targetId);
          this.nextDestination = targetId;
          this.render();
          this.composerInputEl?.focus();
          return;
        }
        this.nextDestination = item.id;
        this.render();
        this.composerInputEl?.focus();
      },
      onCreate: async (q) => {
        const id = await this.createNoteUnder(q, this.focusId);
        if (id) { this.nextDestination = id; this.render(); this.composerInputEl?.focus(); }
      },
      crossFolderNotes: () => this.collectCrossFolderDestinations(),
    }).open();
  }

  /** Like `collectCrossFolderNotes` but with synthetic "Home of <folder>"
   *  entries prepended for each external Stashpad folder. Used by the
   *  destination picker so the user can target another folder's root
   *  directly without having to navigate there first. 0.57.2. */
  private collectCrossFolderDestinations(): import("./note-picker").CrossFolderNote[] {
    const out = this.collectCrossFolderNotes();
    const folders = this.plugin.searchableFolders(this.noteFolder)
      .filter((f) => f !== this.noteFolder);
    // Surface each folder's root as a first-class pick. id = ROOT_ID so
    // the cross-folder onPick handler can route directly into the new
    // folder's home.
    const roots = folders.map((folder) => ({
      folder,
      id: ROOT_ID,
      title: `Home — ${folder.split("/").pop() || folder}`,
      body: "",
    }));
    return [...roots, ...out];
  }

  /** Search restricted to the currently focused parent's direct children
   *  (and their descendants). Picking a result navigates to it. */
  openSearchInParentModal(): void {
    // Build a transient TreeIndex-like wrapper that only exposes the
    // focused subtree, then feed it to StashpadSuggest. Simpler approach:
    // open the regular suggest, but install a filter that ignores any
    // note whose ancestor chain doesn't contain the current focusId.
    const focusId = this.focusId;
    const inSubtree = (id: StashpadId): boolean => {
      if (id === focusId) return true;
      let cur: TreeNode | undefined = this.tree.get(id);
      while (cur && cur.id !== ROOT_ID) {
        if (cur.parent === focusId) return true;
        if (cur.id === focusId) return true;
        if (!cur.parent) return false;
        cur = this.tree.get(cur.parent);
      }
      return focusId === ROOT_ID;
    };
    const subtreeTree = new Proxy(this.tree, {
      get: (target, prop) => {
        if (prop === "getRoot") {
          return () => target.get(focusId) ?? target.getRoot();
        }
        if (prop === "getChildren") {
          // Same as the underlying tree — the seed root is already
          // scoped to focusId.
          return (id: StashpadId) => target.getChildren(id);
        }
        return (target as any)[prop];
      },
    }) as unknown as typeof this.tree;
    new StashpadSuggest(this.app, subtreeTree, (n) => this.titleForNode(n), {
      mode: "search",
      placeholder: `Search in "${this.titleForNode(this.tree.get(focusId) ?? this.tree.getRoot()).trim()}"…`,
      allowCreate: false,
      onPick: (item) => {
        if (item.node && inSubtree(item.node.id)) this.navigateTo(item.node.id);
        else if (item.node) this.navigateTo(item.node.id);
      },
      // No cross-folder source — in-parent search is intentionally local.
    }).open();
  }

  openSearchModal(): void {
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "search", placeholder: "Search Stashpad notes…",
      allowCreate: false,
      onPick: (item) => {
        // 0.57.3: folder-open picks open the target folder in a new tab,
        // leaving the current tab on its current folder. Useful for
        // quickly side-by-side comparing two Stashpad folders.
        if (item.kind === "folder-open" && item.folder) {
          void this.openFolderInNewTab(item.folder);
          return;
        }
        if (item.crossFolder && item.crossFile) {
          // Cross-Stashpad result: switch this view's folder and focus
          // the picked note. The setState path rebuilds the tree, so by
          // the time render runs we can navigate to the picked id.
          const targetId = item.id.replace(/^cross:/, "");
          void this.switchToFolderAndFocus(item.crossFolder, targetId);
          return;
        }
        if (item.node) this.navigateTo(item.node.id);
      },
      crossFolderNotes: () => this.collectCrossFolderNotes(),
      folderResults: () => this.plugin.discoverStashpadFolders().filter((f) => f !== this.noteFolder),
    }).open();
  }

  /** Walk the vault for every Stashpad note that lives in a folder
   *  eligible for cross-Stashpad search (per settings), excluding the
   *  active folder (those are already in the local tier). */
  private collectCrossFolderNotes(): import("./note-picker").CrossFolderNote[] {
    const out: import("./note-picker").CrossFolderNote[] = [];
    const folders = this.plugin.searchableFolders(this.noteFolder)
      .filter((f) => f !== this.noteFolder);
    if (!folders.length) return out;
    const folderSet = new Set(folders);
    // Build a quick id-lookup so we can resolve parent blurbs.
    const filesByFolder = new Map<string, TFile[]>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folderSet.has(dir)) continue;
      let bucket = filesByFolder.get(dir);
      if (!bucket) { bucket = []; filesByFolder.set(dir, bucket); }
      bucket.push(f);
    }
    for (const folder of folders) {
      const files = filesByFolder.get(folder) ?? [];
      // Index by id for parent lookups within the same folder.
      const byId = new Map<string, TFile>();
      for (const f of files) {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
          | { id?: string } | undefined;
        if (typeof fm?.id === "string") byId.set(fm.id, f);
      }
      for (const file of files) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
          | { id?: string; parent?: string | null } | undefined;
        const id = typeof fm?.id === "string" ? fm.id : "";
        if (!id) continue;
        const title = file.basename
          .replace(/-[a-z0-9]{4,12}$/, "")
          .replace(/-/g, " ");
        // Parent blurb: try to read the parent file synchronously from
        // the metadataCache (no body — the picker will fill it later
        // via cachedRead for the row's main body).
        let parentBlurb: string | undefined = undefined;
        const parentId = fm?.parent ?? null;
        if (parentId && parentId !== ROOT_ID) {
          const parentFile = byId.get(parentId);
          if (parentFile) {
            parentBlurb = parentFile.basename
              .replace(/-[a-z0-9]{4,12}$/, "")
              .replace(/-/g, " ");
          }
        }
        out.push({ file, folder, id, title, body: "", parentBlurb });
      }
    }
    return out;
  }

  /** Re-target this Stashpad view at `folder` and focus `noteId` once
   *  the new folder's tree has loaded. Used by cross-folder picks. */
  private async switchToFolderAndFocus(folder: string, noteId: string): Promise<void> {
    await this.setFolderOverride(folder);
    // setFolderOverride rebuilds the tree, so the id should resolve now.
    if (this.tree.get(noteId)) {
      this.navigateTo(noteId);
    }
  }

  /** Re-parent the current selection (or cursor row) one level up.
   *  Skips notes that have no parent or whose parent is already ROOT. */
  async cmdOutdent(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) return;
    const moved: TreeNode[] = [];
    const skipped: string[] = [];
    for (const t of targets) {
      const parent = t.parent ? this.tree.get(t.parent) : null;
      if (!parent || parent.id === ROOT_ID) { skipped.push(t.id); continue; }
      const grandparent = parent.parent ?? ROOT_ID;
      await this.changeParent(t, grandparent);
      moved.push(t);
    }
    if (moved.length === 0) {
      new Notice(skipped.length ? "Already at the top level." : "Nothing to outdent.");
      return;
    }
    this.render();
    if (skipped.length) {
      const outdentedNodes = moved.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
      this.plugin.notifications.show({
        message: this.bulkActionMessage({
          verb: "Outdented",
          nodes: outdentedNodes,
          suffix: skipped.length ? `(${skipped.length} already at root)` : undefined,
        }),
        kind: "success",
        category: "move",
        affectedIds: moved,
        folder: this.noteFolder,
      });
    }
  }

  /** Open the color picker for the current selection (or cursor row).
   *  Applies the chosen color to every target's frontmatter; null clears it. */
  cmdSetColor(): void {
    const targets = this.getActionTargets();
    if (!targets.length) return;
    // Seed the picker with the current color iff every target shares one.
    const colors = new Set(targets.map((n) => this.colorForNode(n) ?? ""));
    const seed = colors.size === 1 ? (Array.from(colors)[0] || null) : null;
    const palette = this.plugin.settings.customPalette ?? [];
    new ColorPickerModal(
      this.app,
      seed,
      palette,
      async (color, opts) => {
        for (const t of targets) {
          if (!t.file) continue;
          try {
            await this.app.fileManager.processFrontMatter(t.file, (fm) => {
              if (color) fm.color = color;
              else delete fm.color;
            });
          } catch (e) {
            new Notice(`Couldn't set color for ${t.id}: ${(e as Error).message}`);
          }
        }
        // Save the custom color into the persisted palette if requested.
        if (opts.addToPalette && typeof color === "string") {
          const list = [...(this.plugin.settings.customPalette ?? [])];
          const lower = color.toLowerCase();
          if (!list.some((c) => c.toLowerCase() === lower)) {
            list.push(color);
            this.plugin.settings.customPalette = list;
            await this.plugin.persistSettingsQuiet();
            await this.log.append({ type: "palette_color_add", id: ROOT_ID, payload: { color } });
          }
        }
        this.render();
      },
      async (color) => {
        // Delete a saved custom color from the palette.
        const list = (this.plugin.settings.customPalette ?? []).filter(
          (c) => c.toLowerCase() !== color.toLowerCase(),
        );
        this.plugin.settings.customPalette = list;
        await this.plugin.persistSettingsQuiet();
        await this.log.append({ type: "palette_color_remove", id: ROOT_ID, payload: { color } });
        return list;
      },
    ).open();
  }

  cmdMovePicker(): void {
    const targets = this.getActionTargets();
    if (!targets.length) return;
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "pick", placeholder: "Move to which note?", allowCreate: true,
      onPick: async (item) => {
        if (item.crossFolder) {
          // Picked a parent in another Stashpad → cross-folder move.
          const newParentId = item.id.replace(/^cross:/, "");
          await this.moveAcrossFolders(targets, item.crossFolder, newParentId);
          this.selection.clear(); this.render();
          return;
        }
        const newParent = item.id;
        for (const t of targets) await this.changeParent(t, newParent);
        this.selection.clear(); this.render();
      },
      onCreate: async (q) => {
        const newId = await this.createNoteUnder(q, this.focusId);
        if (!newId) return;
        for (const t of targets) await this.changeParent(t, newId);
        this.selection.clear(); this.render();
      },
      // 0.57.2: use the same cross-folder + synthetic-root list the
      // destination picker uses, so a move can target "Home of folder X"
      // as a one-shot result without searching for it.
      crossFolderNotes: () => this.collectCrossFolderDestinations(),
    }).open();
  }

  /** Move a list of notes (each with its full subtree) into another
   *  Stashpad folder, re-parenting the roots to `newParentId` (which
   *  must live in `targetFolder`). Logs each file move and pushes a
   *  single undo entry that reverses the entire batch.
   *
   *  Mechanics:
   *  - For each source root, walk its subtree (depth-first).
   *  - For each subtree file, compute the destination path under
   *    `targetFolder`. On collision, append "-1", "-2", … to the
   *    basename (without disturbing the trailing "-id" suffix that
   *    parseIdFromFilename relies on).
   *  - renameFile to physically move the file into the target folder.
   *  - Update the source root's frontmatter parent to newParentId.
   *  - Descendants retain their existing parent ids (they reference
   *    other moved notes).
   */
  private async moveAcrossFolders(
    sources: TreeNode[],
    targetFolder: string,
    newParentId: StashpadId,
  ): Promise<void> {
    if (!sources.length) return;
    const targetDir = (targetFolder || "").replace(/\/+$/, "");
    if (!targetDir) { new Notice("Target folder is empty"); return; }

    // Gather (rootId, file, oldParent, newPath) for every file we'll move.
    interface Plan { id: StashpadId; file: TFile; oldPath: string; newPath: string; oldParent: StashpadId | null; isRoot: boolean; }
    const plan: Plan[] = [];
    const taken = new Set<string>();
    // Pre-seed taken with existing files in the target directory so we
    // can detect collisions across the batch.
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir === targetDir) taken.add(f.path);
    }

    const planFor = (node: TreeNode, isRoot: boolean): void => {
      if (!node.file) return;
      const orig = node.file;
      let candidate = `${targetDir}/${orig.name}`;
      if (taken.has(candidate)) {
        // Insert "-N" before the trailing "-<id>.md" so parseIdFromFilename
        // still recovers the id from the new filename.
        const m = orig.basename.match(/^(.*)(-[a-z0-9]{4,12})$/);
        const stem = m ? m[1] : orig.basename;
        const idTail = m ? m[2] : "";
        for (let i = 1; i < 1000; i++) {
          const tryName = `${stem}-${i}${idTail}.md`;
          const tryPath = `${targetDir}/${tryName}`;
          if (!taken.has(tryPath)) { candidate = tryPath; break; }
        }
      }
      taken.add(candidate);
      plan.push({
        id: node.id,
        file: orig,
        oldPath: orig.path,
        newPath: candidate,
        oldParent: node.parent,
        isRoot,
      });
      // Recurse into children.
      for (const c of this.tree.getChildren(node.id)) planFor(c, false);
    };
    for (const s of sources) planFor(s, true);
    if (!plan.length) return;

    // Make sure target folder exists (createNoteUnder uses ensureFolder
    // for this; replicate by creating intermediates if missing).
    await this.ensureFolder(targetDir);

    // Execute plan: renameFile + frontmatter update for roots.
    for (const p of plan) {
      try {
        await this.app.fileManager.renameFile(p.file, p.newPath);
        if (p.isRoot) {
          await this.app.fileManager.processFrontMatter(p.file, (fm) => { fm.parent = newParentId; });
        }
        await this.log.append({
          type: "parent_change", id: p.id,
          payload: { from: p.oldParent, to: p.isRoot ? newParentId : p.oldParent, crossFolder: { from: this.noteFolder, to: targetDir } },
        });
      } catch (e) {
        new Notice(`Move failed for ${p.id}: ${(e as Error).message}`);
      }
    }

    // Source view loses these notes; rebuild + render.
    this.tree.rebuild(this.noteFolder);
    const crossMovedNodes = sources.map((s) => this.tree.get(s.id)).filter((n): n is TreeNode => !!n);
    const titleSummary = crossMovedNodes.length > 0
      ? this.titleList(crossMovedNodes)
      : `${sources.length} note${sources.length === 1 ? "" : "s"}`;
    this.plugin.notifications.show({
      message: `Moved ${titleSummary} → \`${targetDir}\``,
      kind: "success",
      category: "move",
      affectedIds: sources.map((s) => s.id),
      folder: this.noteFolder,
    });

    // Undo: reverse every rename + restore root parent ids. Stored on
    // THIS view's folder undo stack (the originating Stashpad).
    this.plugin.getUndoStack(this.noteFolder).push({
      label: `Cross-Stashpad move (${plan.length})`,
      undo: async () => {
        for (const p of plan) {
          const f = this.app.vault.getAbstractFileByPath(p.newPath) as TFile | null;
          if (!f) continue;
          try {
            await this.app.fileManager.renameFile(f, p.oldPath);
            if (p.isRoot) {
              await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = p.oldParent; });
            }
          } catch {}
        }
        this.tree.rebuild(this.noteFolder);
        this.render();
      },
      redo: async () => {
        for (const p of plan) {
          const f = this.app.vault.getAbstractFileByPath(p.oldPath) as TFile | null;
          if (!f) continue;
          try {
            await this.app.fileManager.renameFile(f, p.newPath);
            if (p.isRoot) {
              await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = newParentId; });
            }
          } catch {}
        }
        this.tree.rebuild(this.noteFolder);
        this.render();
      },
    });
  }

  private cmdInListPicker(): void {
    if (this.currentChildren.length === 0) return;
    // Pre-select the note above the cursor (the most common nest target).
    // Falls back to index 0 when the cursor is already at the top.
    const start = this.cursorIdx > 0 ? this.cursorIdx - 1 : 0;
    this.inListPicker = { activeIdx: start };
    new Notice("Arrows to pick parent, Enter confirms, Esc cancels.");
    // Preserve scroll position across the activation render — the highlight is
    // a visual cue only; we shouldn't jump the viewport to reveal it.
    const keepScroll = this.listEl?.scrollTop ?? 0;
    this.render();
    if (this.listEl) {
      const list = this.listEl;
      list.scrollTop = keepScroll;
      requestAnimationFrame(() => { list.scrollTop = keepScroll; });
      setTimeout(() => { list.scrollTop = keepScroll; }, 60);
    }
  }
  private async commitInListPicker(): Promise<void> {
    if (!this.inListPicker) return;
    const target = this.currentChildren[this.inListPicker.activeIdx];
    this.inListPicker = null;
    if (!target) { this.render(); return; }
    const targets = this.getActionTargets().filter((n) => n.id !== target.id);
    for (const t of targets) await this.changeParent(t, target.id);
    // 0.56.7: select the new parent (the picker target) so the user sees
    // where their note(s) went — matches the drag drop-into behaviour
    // shipped in 0.56.5. Defensive re-apply at 120ms + 400ms covers the
    // metadataCache-driven debouncedRender race (see moveAcrossThenReorder).
    this.selection.clear();
    this.cursorIdx = -1;
    this.pendingFocusIds = [target.id];
    this.render({ kind: "follow-cursor" });
    const guardKey = this.selectionGuardKey;
    const tryReselect = () => {
      if (this.selectionGuardKey !== guardKey) return;
      if (this.selection.has(target.id)) return;
      const idx = this.currentChildren.findIndex((n) => n.id === target.id);
      if (idx < 0) return;
      this.selection.add(target.id);
      this.cursorIdx = idx;
      this.render({ kind: "follow-cursor" });
    };
    setTimeout(tryReselect, 120);
    setTimeout(tryReselect, 400);
  }

  async cmdMerge(): Promise<void> {
    const targets = this.getActionTargets();
    if (targets.length < 2) { new Notice("Select 2+ notes to merge."); return; }
    targets.sort((a, b) => (a.created || "").localeCompare(b.created || ""));
    const oldest = targets[0];
    if (!oldest.file) return;

    // Snapshot everything first so we can undo the merge.
    const oldestPath = oldest.file.path;
    const oldestOriginal = await this.app.vault.read(oldest.file);
    const deletedSnap = await this.snapshotNotes(targets.slice(1), false);
    // Capture parent reassignments so we can undo them.
    const reassignments: { childId: StashpadId; childPath: string; oldParent: StashpadId | null }[] = [];

    const bodies: string[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const raw = await this.app.vault.cachedRead(t.file);
      bodies.push(this.stripFrontmatter(raw).trim());
    }
    const newBody = bodies.map((b) => b.trim()).filter(Boolean).join("\n");
    const oldestRaw = await this.app.vault.read(oldest.file);
    const fmEnd = oldestRaw.startsWith("---") ? oldestRaw.indexOf("\n---", 3) + 4 : 0;
    const fmBlock = oldestRaw.slice(0, fmEnd);
    const newOldestContent = `${fmBlock}\n${newBody}\n`;
    await this.app.vault.modify(oldest.file, newOldestContent);

    for (let i = 1; i < targets.length; i++) {
      const t = targets[i];
      if (!t.file) continue;
      for (const c of this.tree.getChildren(t.id)) {
        if (c.file) reassignments.push({ childId: c.id, childPath: c.file.path, oldParent: c.parent });
        await this.changeParent(c, oldest.id, { record: false });
      }
      await this.app.fileManager.trashFile(t.file);
      await this.log.append({ type: "delete", id: t.id, payload: { mergedInto: oldest.id } });
    }
    // 0.56.9: focus the kept (merged) note so the user can see what was
    // consolidated. Previously cleared selection left the user in the
    // dark about where the data ended up.
    this.selection.clear();
    this.cursorIdx = -1;
    this.pendingFocusIds = [oldest.id];
    const keptTitle = this.titleForNode(oldest);
    this.plugin.notifications.show({
      message: this.bulkActionMessage({
        verb: "Merged",
        nodes: targets,
        destination: `→ kept "${keptTitle}"`,
      }),
      kind: "success",
      category: "merge",
      affectedIds: targets.map((t) => t.id),
      folder: this.noteFolder,
    });
    this.tree.rebuild(this.noteFolder);
    this.render({ kind: "follow-cursor" });
    {
      const keptId = oldest.id;
      const guardKey = this.selectionGuardKey;
      const tryReselect = () => {
        if (this.selectionGuardKey !== guardKey) return;
        if (this.selection.has(keptId)) return;
        const idx = this.currentChildren.findIndex((n) => n.id === keptId);
        if (idx < 0) return;
        this.selection.add(keptId);
        this.cursorIdx = idx;
        this.render({ kind: "follow-cursor" });
      };
      setTimeout(tryReselect, 120);
      setTimeout(tryReselect, 400);
    }

    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: `Merge ${targets.length} notes`,
      undo: async () => {
        // Restore the deleted siblings first (children may need to be re-parented to them).
        // 0.56.9: pass the full set of merged ids so restoreSnapshots
        // selects + scrolls to all of them (cursor lands on the topmost
        // surviving id via render()'s pendingFocusIds resolution).
        await this.restoreSnapshots(deletedSnap, targets.map((t) => t.id));
        // Revert the kept (oldest) note's body.
        const f = this.app.vault.getAbstractFileByPath(oldestPath) as TFile | null;
        if (f) await this.app.vault.modify(f, oldestOriginal);
        // Restore each child's parent.
        for (const r of reassignments) {
          const cf = this.app.vault.getAbstractFileByPath(r.childPath) as TFile | null;
          if (cf) await this.app.fileManager.processFrontMatter(cf, (fm) => { fm.parent = r.oldParent; });
        }
        this.pendingFocusIds = targets.map((t) => t.id);
        this.tree.rebuild(folder);
        this.render({ kind: "follow-cursor" });
      },
      redo: async () => {
        // Re-trash the merged-away notes.
        await this.trashNotesAndAttachments(deletedSnap);
        // Re-write the kept note.
        const f = this.app.vault.getAbstractFileByPath(oldestPath) as TFile | null;
        if (f) await this.app.vault.modify(f, newOldestContent);
        // Re-reassign children.
        for (const r of reassignments) {
          const cf = this.app.vault.getAbstractFileByPath(r.childPath) as TFile | null;
          if (cf) await this.app.fileManager.processFrontMatter(cf, (fm) => { fm.parent = oldest.id; });
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  async cmdCopy(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) return;
    const prefix = getSettings().prefixTimestampsOnCopy;
    const out: string[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const raw = await this.app.vault.cachedRead(t.file);
      const body = this.stripFrontmatter(raw).trim();
      out.push(prefix ? `${this.formatTimeInline(t.created)} ${body}` : body);
    }
    await navigator.clipboard.writeText(out.join("\n\n"));
    this.plugin.notifications.show({
      message: `Copied ${this.titleList(targets)} to clipboard`,
      kind: "success",
      category: "system",
      affectedIds: targets.map((t) => t.id),
      folder: this.noteFolder,
    });
  }

  async cmdCopyTree(): Promise<void> {
    // Roots: selection > cursor row > focused note (last resort).
    let roots = this.getActionTargets();
    if (roots.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) roots = [focused];
    }
    if (roots.length === 0) { new Notice("Nothing to copy."); return; }
    const prefix = getSettings().prefixTimestampsOnCopy;
    const lines: string[] = [];
    const walk = async (node: TreeNode, depth: number): Promise<void> => {
      if (node.file) {
        const raw = await this.app.vault.cachedRead(node.file);
        const body = this.stripFrontmatter(raw).trim().split(/\r?\n/).join(" ");
        const ts = prefix ? `${this.formatTimeInline(node.created)} ` : "";
        lines.push(`${"  ".repeat(depth)}- ${ts}${body}`);
      }
      for (const c of this.tree.getChildren(node.id)) await walk(c, depth + 1);
    };
    for (const r of roots) await walk(r, 0);
    await navigator.clipboard.writeText(lines.join("\n"));
    this.plugin.notifications.show({
      message: `Copied tree of ${this.titleList(roots)} (${lines.length} entries)`,
      kind: "success",
      category: "system",
      affectedIds: roots.map((r) => r.id),
      folder: this.noteFolder,
    });
  }

  /** Copy selection (or cursor row, or focused note) as a bullet list of
   *  ![[embed]] links, indented by nesting depth. Useful for transcluding a
   *  subtree into a regular Obsidian note. */
  async cmdCopyOutline(): Promise<void> {
    let roots = this.getActionTargets();
    if (roots.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) roots = [focused];
    }
    if (roots.length === 0) { new Notice("Nothing to copy."); return; }
    const lines: string[] = [];
    const walk = (node: TreeNode, depth: number) => {
      if (!node.file) return;
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- ![[${node.file.basename}]]`);
      for (const c of this.tree.getChildren(node.id)) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    await navigator.clipboard.writeText(lines.join("\n"));
    this.plugin.notifications.show({
      message: `Copied outline of ${this.titleList(roots)} (${lines.length} entr${lines.length === 1 ? "y" : "ies"})`,
      kind: "success",
      category: "system",
      affectedIds: roots.map((r) => r.id),
      folder: this.noteFolder,
    });
  }

  /** Toggle the "Show more / show less" clamp for the current target(s).
   *  Targets follow getActionTargets (selection > cursor row). Each
   *  target's id is added to or removed from this.expandedNotes; if any
   *  target is currently un-expanded, ALL targets become expanded (so
   *  a mixed selection collapses to a single "expand" gesture). Then a
   *  full re-render picks up the new clamp state. */
  cmdToggleExpand(): void {
    const targets = this.getActionTargets();
    if (!targets.length) return;
    const anyCollapsed = targets.some((t) => !this.expandedNotes.has(t.id));
    for (const t of targets) {
      if (anyCollapsed) this.expandedNotes.add(t.id);
      else this.expandedNotes.delete(t.id);
    }
    this.render();
  }

  // --- Clone / duplicate ---

  /** Deep-clone one source subtree into the vault under `newParent`.
   *
   *  - Walks source children recursively, generating a fresh id per node.
   *  - Copies the source's frontmatter wholesale via processFrontMatter,
   *    then overwrites the auto-managed fields (id, parent, created,
   *    attachments) — color, tags, custom keys are preserved.
   *  - Body is copied verbatim, so attachment links inside the body keep
   *    pointing at the original attachment files (we don't duplicate the
   *    binaries — that would just balloon the vault).
   *  - `createdPaths` accumulates every new file path (for undo).
   *  Returns the new id of the cloned root, or null if source has no file. */
  private async cloneSubtree(
    source: TreeNode,
    newParent: StashpadId,
    createdPaths: string[],
  ): Promise<StashpadId | null> {
    if (!source.file) return null;
    const sourceFile = source.file;
    const oldRaw = await this.app.vault.read(sourceFile);
    const body = this.stripFrontmatter(oldRaw);
    const sourceFm = (this.app.metadataCache.getFileCache(sourceFile)?.frontmatter ?? {}) as Record<string, any>;

    const cloneId = newId();
    const slug = bodyToSlug(body, this.activeStopwords());
    const filename = buildFilename(slug, cloneId);
    const path = `${this.noteFolder}/${filename}`;
    const created = new Date().toISOString();
    const attachments = this.extractAttachments(body);

    // Minimal initial file — just enough to be a valid Stashpad note. The
    // rest of the source frontmatter is layered on with processFrontMatter
    // so we don't have to hand-write a YAML serializer.
    const fmInit = ["---", `id: ${cloneId}`, `parent: ${newParent}`, `created: ${created}`];
    if (attachments.length > 0) {
      fmInit.push("attachments:");
      for (const a of attachments) fmInit.push(`  - "${a.replace(/"/g, '\\"')}"`);
    } else {
      fmInit.push("attachments: []");
    }
    fmInit.push("---", body);
    await this.ensureFolder(this.noteFolder);
    await this.app.vault.create(path, fmInit.join("\n"));
    createdPaths.push(path);

    // Layer over remaining source frontmatter (color, tags, custom keys).
    // The auto-managed fields are deliberately NOT copied.
    const newFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (newFile) {
      try {
        await this.app.fileManager.processFrontMatter(newFile, (m: any) => {
          for (const [k, v] of Object.entries(sourceFm)) {
            if (RESERVED_FRONTMATTER.includes(k)) continue;
            m[k] = v;
          }
        });
      } catch (e) {
        console.warn("[Stashpad] cloneSubtree: processFrontMatter failed", e);
      }
      // Synthetic insert so the row appears immediately, before metadataCache parses.
      try {
        this.tree.insertSynthetic({
          id: cloneId, parent: newParent, children: [], file: newFile, created,
        });
      } catch {}
      // Background-sync the new clone's recovery fields + bump the new
      // parent's children list. Cheap enqueue; the queue drains in the
      // background, not blocking the clone loop.
      this.fmSync.scheduleParentChange(cloneId, null, newParent);
    }

    // Recurse into children — each becomes a child of the just-cloned node.
    for (const c of this.tree.getChildren(source.id)) {
      await this.cloneSubtree(c, cloneId, createdPaths);
    }
    return cloneId;
  }

  /** Mod+Shift+D / command: clone selected notes (or cursor row) as
   *  siblings of their current parent. Each clone gets a fresh id and
   *  `created` timestamp; descendants are cloned recursively.
   *
   *  Discoverability: the command surfaces "clone, copy, duplicate" so
   *  fuzzy lookup hits all three terms. */
  async cmdClone(): Promise<void> {
    const roots = this.getActionTargets();
    if (!roots.length) { new Notice("Nothing to clone."); return; }
    const folder = this.noteFolder;
    const createdPaths: string[] = [];
    const newRootIds: StashpadId[] = [];
    for (const r of roots) {
      if (!r.file) continue;
      // Sibling of the source: same parent. Falls back to the current
      // focused subtree if the source somehow lacks a parent (shouldn't
      // happen for non-root nodes).
      const parent = r.parent ?? this.focusId;
      const id = await this.cloneSubtree(r, parent, createdPaths);
      if (id) newRootIds.push(id);
    }
    if (!newRootIds.length) return;
    this.tree.rebuild(folder);
    this.pendingFocusIds = newRootIds.slice();
    this.render();

    // Snapshot AFTER creation so redo can restore from the cloned content
    // (covers the case where the user mutates the originals between
    // clone+undo+redo). Attachments aren't duplicated, so we only
    // snapshot the markdown files themselves.
    const snapNodes: TreeNode[] = createdPaths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => !!f && (f as any).extension === "md")
      .map((file) => ({ id: parseIdFromFilename(file.basename) ?? file.basename, parent: null, children: [], file, created: new Date().toISOString() }));
    const snap = await this.snapshotNotes(snapNodes, false);

    this.plugin.getUndoStack(folder).push({
      label: `Clone ${newRootIds.length} note${newRootIds.length === 1 ? "" : "s"}`,
      undo: async () => {
        // Trash children-first ordering: createdPaths was filled
        // depth-first parent → child, so reverse it for safe deletion.
        for (const p of [...createdPaths].reverse()) {
          const f = this.app.vault.getAbstractFileByPath(p) as TFile | null;
          if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
        }
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => {
        await this.restoreSnapshots(snap, newRootIds);
      },
    });
    const clonedRootNodes = newRootIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
    this.plugin.notifications.show({
      message: this.bulkActionMessage({
        verb: "Cloned",
        nodes: clonedRootNodes,
        suffix: `(${createdPaths.length} file${createdPaths.length === 1 ? "" : "s"} total)`,
      }),
      kind: "success",
      category: "clone",
      affectedIds: newRootIds,
      folder: this.noteFolder,
    });
  }

  /** Insert-template flow: open the note picker, then deep-clone the
   *  picked note (with its subtree) under the current focus. Same
   *  cloning machinery as cmdClone, but the new root is parented to
   *  `focusId` instead of the source's parent, so it appears as a child
   *  in the current view. Cross-folder picks are accepted as long as
   *  the source lives in this same Stashpad — cross-Stashpad templates
   *  would need extra plumbing (different tree, different folder). */
  cmdInsertTemplate(): void {
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "pick",
      placeholder: "Insert which note as a template?",
      allowCreate: false,
      onPick: async (item) => {
        if (item.crossFolder) {
          new Notice("Cross-Stashpad templates aren't supported yet — pick a note from this Stashpad.");
          return;
        }
        const source = this.tree.get(item.id);
        if (!source?.file) return;
        const folder = this.noteFolder;
        const createdPaths: string[] = [];
        const id = await this.cloneSubtree(source, this.focusId, createdPaths);
        if (!id) return;
        this.tree.rebuild(folder);
        this.pendingFocusIds = [id];
        this.render();
        const snapNodes: TreeNode[] = createdPaths
          .map((p) => this.app.vault.getAbstractFileByPath(p))
          .filter((f): f is TFile => !!f && (f as any).extension === "md")
          .map((file) => ({ id: parseIdFromFilename(file.basename) ?? file.basename, parent: null, children: [], file, created: new Date().toISOString() }));
        const snap = await this.snapshotNotes(snapNodes, false);
        this.plugin.getUndoStack(folder).push({
          label: "Insert template",
          undo: async () => {
            for (const p of [...createdPaths].reverse()) {
              const f = this.app.vault.getAbstractFileByPath(p) as TFile | null;
              if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
            }
            this.tree.rebuild(folder);
            this.render();
          },
          redo: async () => { await this.restoreSnapshots(snap, [id]); },
        });
        this.plugin.notifications.show({
          message: `Inserted template (${createdPaths.length} file${createdPaths.length === 1 ? "" : "s"})`,
          kind: "success",
          category: "clone",
          folder: this.noteFolder,
        });
      },
    }).open();
  }

  // --- Navigation ---

  private navigateTo(id: StashpadId, opts: { keepForwardStack?: boolean } = {}): void {
    // 0.56.9: invalidate pending tryReselect timers from prior mutations so
    // they don't apply a stale selection in the new focus.
    this.selectionGuardKey++;
    if (this.listEl) {
      // 0.56.17: stamp last-selected cursor for the focus we're leaving
      // so returning restores to it via scroll-to-id.
      this.stampSelectedCursor(true);
    }
    // Stash current focus's draft before switching.
    if (!opts.keepForwardStack) this.navForwardStack = [];
    this.focusId = id;
    this.persistFocus();
    this.defaultCursorToLast();
    this.syncComposerDraftForFocus();
    // Clear an active tag/color filter if the new subtree doesn't
    // contain it — otherwise we'd show "All …" in the dropdown while
    // a hidden filter empties the list.
    if (this.tagFilter) {
      const wanted = this.tagFilter.toLowerCase();
      const present = this.collectFolderTags().some((t) => t.raw.toLowerCase() === wanted);
      if (!present) this.tagFilter = null;
    }
    if (this.colorFilter) {
      const wanted = this.colorFilter.toLowerCase();
      const present = this.collectFolderColors().some((c) => c.hex === wanted);
      if (!present) this.colorFilter = null;
    }
    // 0.56.22: navigateTo uses the saved last-cursor for the new focus to
    // scroll-to-id (id-based, robust). Falls back to preserve when there's
    // no memory for this focus — fine, since defaultCursorToLast pre-set
    // cursor to last child and the user will see something coherent.
    const savedCursorId = this.lastCursorByFocus.get(id);
    let navPolicy: ScrollPolicy;
    if (savedCursorId && this.tree.get(savedCursorId)) {
      this.pendingFocusIds = [savedCursorId];
      navPolicy = { kind: "scroll-to-id", id: savedCursorId, align: "start" };
    } else {
      navPolicy = { kind: "preserve" };
    }
    this.render(navPolicy);
    this.refreshHeaderTitle();
    this.viewRoot.focus({ preventScroll: true });
  }

  /** Mouse "back" button — alias for navigating to the parent. */
  navigateBack(): void { this.navigateUp(); }
  /** Mouse "forward" button — re-enter the last child you came back from, if any. */
  navigateForward(): void {
    const id = this.navForwardStack.pop();
    if (!id) return;
    if (!this.tree.get(id)) return;
    // History nav clears any active tag/color filter — the user has
    // changed context and probably doesn't expect filters to keep
    // applying.
    this.tagFilter = null;
    this.colorFilter = null;
    this.navigateTo(id, { keepForwardStack: true });
  }

  private navigateUp(): void {
    this.selectionGuardKey++;
    // History nav (back / Up arrow / Backspace) clears tag + color
    // filters for the same reason as navigateForward.
    this.tagFilter = null;
    this.colorFilter = null;
    const node = this.tree.get(this.focusId);
    if (!node || node.parent == null) return this.navigateTo(ROOT_ID);
    const cameFrom = this.focusId;
    this.navForwardStack.push(cameFrom);
    if (this.listEl) {
      // Stamp the focus we're leaving (`cameFrom`), not the new focus.
      const cur = this.currentChildren[this.cursorIdx];
      const id = cur?.id ?? this.lastSelected;
      if (id) this.plugin.saveLastCursor(this.noteFolder, cameFrom, id);
    }
    this.focusId = node.parent;
    this.persistFocus();
    this.syncComposerDraftForFocus();
    const kids = this.filterChildren(this.tree.getChildren(this.focusId));
    const idx = kids.findIndex((k) => k.id === cameFrom);
    this.selection.clear();
    if (idx >= 0) {
      this.cursorIdx = idx;
      this.selection.add(cameFrom);
      this.lastSelected = cameFrom;
    } else {
      this.cursorIdx = kids.length - 1;
      if (kids.length > 0) {
        this.selection.add(kids[kids.length - 1].id);
        this.lastSelected = kids[kids.length - 1].id;
      }
    }
    // 0.56.22: follow-cursor — we just set cursor to `cameFrom` (the
    // child we came from). It IS the right thing to scroll to.
    this.render({ kind: "follow-cursor" });
    this.refreshHeaderTitle();
    // Always reveal — the cached scroll restore puts us approximately back,
    // but the cursor row (often the child we just left) can still hide
    // behind the composer when it sits at the bottom of a long list.
    // revealCursorRow is a no-op if the row is already comfortably visible.
    this.revealCursorRow();
  }
  private openBookmarks(): void {
    const bookmarks = (this.app as any).internalPlugins?.plugins?.bookmarks?.instance?.items ?? [];
    const allowed = this.allowedByBases();
    const menu = new Menu();
    let added = 0;
    for (const b of bookmarks) {
      if (b.type !== "file") continue;
      if (allowed && !allowed.has(b.path)) continue;
      const id = this.tree.idForPath(b.path);
      if (!id) continue;
      menu.addItem((it: any) => it.setTitle(b.title || b.path).onClick(() => this.navigateTo(id)));
      added++;
    }
    if (!added) menu.addItem((it: any) => it.setTitle("(no bookmarks in scope)").setDisabled(true));
    menu.showAtMouseEvent(new MouseEvent("click", { clientX: 200, clientY: 400 }));
  }

  // --- Bootstrap ---

  private async bootstrapFolder(): Promise<void> {
    if (this.bootstrappedFolders.has(this.noteFolder)) return;
    await this.ensureFolder(this.noteFolder);
    await this.ensureHomeNote();
    await this.migrateNullParents();
    // Pre-create the import + export subfolders so users have an obvious target.
    const importSub = (this.plugin.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const exportSub = (this.plugin.settings.exportFolder || "").trim().replace(/^\/+|\/+$/g, "");
    if (importSub) await this.ensureFolder(`${this.noteFolder}/${importSub}`);
    if (exportSub) await this.ensureFolder(`${this.noteFolder}/${exportSub}`);
    // Pre-load the order map for this folder so the first rebuild has it.
    await this.order.load(this.noteFolder);
    // Same for the per-parent sort modes (`.stashpad-sort.json`). Reads
    // are cheap; doing it here guarantees the orderProvider sees the
    // user's saved preference on the very first render.
    await this.sortStore.load(this.noteFolder);
    this.bootstrappedFolders.add(this.noteFolder);
  }

  /** First-time-per-session backfill of the redundant parentLink +
   *  children fields across every note in the folder. Designed to be
   *  called AFTER tree.rebuild so getRoot().children is actually
   *  populated — that's the bug the previous in-bootstrap call hit
   *  (bootstrapFolder runs before rebuild, so the tree was empty and
   *  the schedule loop was a no-op).
   *
   *  Walks every node and enqueues it. The queue's 100ms pacing means
   *  a 500-note folder finishes in roughly a minute — non-blocking,
   *  runs entirely in the background.
   *
   *  Each `syncOne` short-circuits when fields are already correct, so
   *  subsequent bootstraps of an already-synced vault produce zero
   *  writes (and zero render churn). On the FIRST bootstrap of a
   *  pre-0.54 vault, the queue churns through actual writes — and
   *  every frontmatter modify cascades into a debounced render, which
   *  is what the user sees as "the composer flashing". Show a notice
   *  so it's clear that's what's happening. */
  private backfillFrontmatterSync(): void {
    // Walk the tree, pre-filter via wouldWrite, schedule only ids that
    // would result in actual writes. Already-synced vaults schedule
    // zero writes here. The visible progress notice (if any) is
    // managed by installFmSyncActivityNotice() — it fires for ANY
    // sustained queue activity, not just the bootstrap backfill, so
    // we don't need a threshold check or batch-specific UI here.
    const candidates: StashpadId[] = [ROOT_ID];
    const root = this.tree.getRoot();
    const walk = (id: StashpadId): void => {
      for (const child of this.tree.getChildren(id)) {
        candidates.push(child.id);
        walk(child.id);
      }
    };
    for (const childId of root.children) walk(childId);
    for (const id of candidates) {
      if (this.fmSync.wouldWrite(id)) this.fmSync.schedule(id);
    }
  }

  /** Subscribe to fmSync queue FAILURE events. Successful writes are
   *  silent (per user feedback: the previous activity-based notice
   *  was too chatty for external edits + dismissed too fast to read
   *  for big batches). A failure, by contrast, demands attention —
   *  recovery fields drift out of sync and the user needs to know.
   *
   *  Records each failure to notification history with kind=error.
   *  Persistent toast (duration 0) so the user has time to read +
   *  decide whether to investigate. Path is included verbatim in
   *  the message body. */
  private fmSyncUnsubscribe: (() => void) | null = null;
  private installFmSyncActivityNotice(): void {
    if (this.fmSyncUnsubscribe) return; // already installed
    this.fmSyncUnsubscribe = this.fmSync.onError((path, error) => {
      this.plugin.notifications.show({
        message: `Stashpad: couldn't update recovery metadata\nFile: \`${path}\`\nError: ${error.message}`,
        kind: "error",
        category: "system",
        duration: 0,
        affectedPaths: [path],
        folder: this.noteFolder,
      });
    });
  }
  private async ensureHomeNote(): Promise<TFile> {
    const folder = this.noteFolder;
    const desiredPath = `${folder}/${this.buildHomeFilename(folder)}`;

    // Locate any existing home note in this folder (regardless of filename)
    // by frontmatter id, so legacy files like `home-__root__.md` are
    // picked up and renamed in place to the new folder-tagged form.
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/"));
    for (const f of files) {
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (id !== ROOT_ID) continue;
      if (f.path === desiredPath) return f;
      // Found an old-style home note. Rename it to the new path. Skip if
      // the desired path is somehow occupied (collision is unexpected
      // since only one note carries id=ROOT_ID per folder).
      const collision = this.app.vault.getAbstractFileByPath(desiredPath);
      if (collision) return f;
      try {
        await this.app.fileManager.renameFile(f, desiredPath);
        // After rename, return the new TFile reference so callers
        // operate on the up-to-date file.
        const renamed = this.app.vault.getAbstractFileByPath(desiredPath);
        if (renamed instanceof TFile) return renamed;
      } catch (e) {
        console.warn("[Stashpad] home note rename failed; keeping legacy path", e);
      }
      return f;
    }

    // No home note exists yet — create at the canonical path.
    const created = new Date().toISOString();
    const body = [
      "---", `id: ${ROOT_ID}`, "parent: null", `created: ${created}`, "attachments: []", "---",
      "", "# Home", "", "This is your Stashpad home note. Edit me freely — everything else nests below.", "",
    ].join("\n");
    return this.app.vault.create(desiredPath, body);
  }

  /** Build the home-note filename for a given Stashpad folder. Uses the
   *  folder's last path segment so multiple Stashpads don't all produce
   *  identically-named "Home" files visible in Obsidian's file finder.
   *  Sanitises to alnum + dash + underscore so the filename is safe on
   *  every filesystem. */
  private buildHomeFilename(folder: string): string {
    const lastSeg = folder.split("/").filter(Boolean).pop() ?? "stashpad";
    const slug = lastSeg
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `Home-${slug || "stashpad"}.md`;
  }
  private async migrateNullParents(): Promise<void> {
    const folder = this.noteFolder;
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/"));
    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const id = fm?.id;
      if (!id || id === ROOT_ID) continue;
      const parent = fm?.parent;
      if (parent === null || parent === undefined || parent === "" || parent === "null") {
        await this.app.fileManager.processFrontMatter(f, (front) => { front.parent = ROOT_ID; });
        await this.log.append({ type: "parent_change", id, payload: { from: null, to: ROOT_ID, reason: "migration" } });
      }
    }
  }

  // --- Open in new Stashpad tab ---

  private async openInNewStashpadTab(focusId: StashpadId): Promise<void> {
    const ws = this.app.workspace;
    const originLeaf = this.leaf;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        focusId,
        timeFilter: this.timeFilter,
        folderOverride: this.folderOverride,
      },
    });
    ws.setActiveLeaf(leaf, { focus: true } as any);
    ws.revealLeaf(leaf);
    // 0.57.5: same return-to-origin one-shot as openFolderInNewTab /
    // openFileAtEnd — when this spawned tab closes, the originating
    // Stashpad tab regains focus.
    const off = ws.on("active-leaf-change", () => {
      const stillOpen = (() => {
        let found = false;
        ws.iterateAllLeaves((l) => { if (l === leaf) found = true; });
        return found;
      })();
      if (stillOpen) return;
      ws.offref(off);
      const originStillOpen = (() => {
        let found = false;
        ws.iterateAllLeaves((l) => { if (l === originLeaf) found = true; });
        return found;
      })();
      if (originStillOpen) {
        ws.setActiveLeaf(originLeaf, { focus: true } as any);
        ws.revealLeaf(originLeaf);
      }
    });
  }

  /** Open a Stashpad folder's home in a new tab (any folder, not just
   *  this view's current one). Used by the search modal's folder-open
   *  pick. 0.57.3.
   *
   *  Refocus behaviour (0.57.4): same one-shot return-to-origin pattern
   *  as `openFileAtEnd` — when the spawned tab closes, the originating
   *  Stashpad tab regains focus instead of whatever tab Obsidian's
   *  default would pick (usually the tab to the right). */
  private async openFolderInNewTab(folder: string): Promise<void> {
    const cleaned = (folder || "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const settingsFolder = (this.plugin.settings.folder || "stashpad").trim().replace(/^\/+|\/+$/g, "") || "stashpad";
    const ws = this.app.workspace;
    const originLeaf = this.leaf;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        focusId: ROOT_ID,
        // Only override when it's not the plugin default — keeps state
        // tidy (folderOverride null means "use plugin default").
        folderOverride: cleaned === settingsFolder ? null : cleaned,
      },
    });
    ws.setActiveLeaf(leaf, { focus: true } as any);
    ws.revealLeaf(leaf);

    // One-shot: when the spawned leaf closes, restore focus to the
    // originating Stashpad tab.
    const off = ws.on("active-leaf-change", () => {
      const stillOpen = (() => {
        let found = false;
        ws.iterateAllLeaves((l) => { if (l === leaf) found = true; });
        return found;
      })();
      if (stillOpen) return;
      ws.offref(off);
      const originStillOpen = (() => {
        let found = false;
        ws.iterateAllLeaves((l) => { if (l === originLeaf) found = true; });
        return found;
      })();
      if (originStillOpen) {
        ws.setActiveLeaf(originLeaf, { focus: true } as any);
        ws.revealLeaf(originLeaf);
      }
    });
  }

  // --- Open shortcuts ---

  /** E key. Opens the cursor row (or focused note) in a regular Obsidian markdown tab. */
  cmdOpenInEditor(node?: TreeNode): void {
    if (node) { void this.openFileAtEnd(node.file!); return; }
    // No explicit node → open every selected note (or just the cursor
    // row when nothing's selected). Multiple notes open as separate
    // tabs, in selection order.
    const targets = this.getActionTargets();
    if (!targets.length) return;
    for (const t of targets) {
      if (t.file) void this.openFileAtEnd(t.file);
    }
  }

  /** Open the focused-parent note in a new editor tab — useful when
   *  you've drilled into a child and want to jump back to editing the
   *  parent without navigating up first. */
  cmdOpenParentInEditor(): void {
    const focused = this.tree.get(this.focusId);
    if (!focused?.file) {
      new Notice("No focused parent to open.");
      return;
    }
    void this.openFileAtEnd(focused.file);
  }

  /** Open a file in a new tab and place the cursor at the very end of the body. */
  private async openFileAtEnd(file: TFile): Promise<void> {
    const ws = this.app.workspace;
    // Remember which Stashpad leaf opened this edit tab so we can restore
    // focus to it when the edit tab closes. Without this, Obsidian falls
    // back to the tab to the right — which is rarely what the user wants.
    const originLeaf = this.leaf;
    const leaf = ws.getLeaf("tab");
    await leaf.openFile(file, { active: true });
    ws.setActiveLeaf(leaf, { focus: true } as any);
    ws.revealLeaf(leaf);

    // One-shot listener: when the active leaf changes AND our edit leaf is
    // no longer in the workspace (closed), reveal the originating Stashpad
    // leaf instead of whatever Obsidian picked.
    const off = ws.on("active-leaf-change", () => {
      const stillOpen = (() => {
        let found = false;
        ws.iterateAllLeaves((l) => { if (l === leaf) found = true; });
        return found;
      })();
      if (stillOpen) return;
      // Edit leaf is gone. Detach this listener and (if the origin leaf
      // is still around) make it active.
      ws.offref(off);
      const originStillOpen = (() => {
        let found = false;
        ws.iterateAllLeaves((l) => { if (l === originLeaf) found = true; });
        return found;
      })();
      if (originStillOpen) {
        ws.setActiveLeaf(originLeaf, { focus: true } as any);
        ws.revealLeaf(originLeaf);
      }
    });

    const view: any = leaf.view;
    const editor: any = view?.editor;
    if (!editor) return;
    // Wait one frame so the editor has its document loaded.
    requestAnimationFrame(() => {
      try {
        const last = editor.lastLine();
        const ch = editor.getLine(last)?.length ?? 0;
        editor.setCursor({ line: last, ch });
        editor.scrollIntoView({ from: { line: last, ch }, to: { line: last, ch } }, true);
        editor.focus();
      } catch {}
    });
  }

  /** T key. Opens the cursor row (or focused note) in a new Stashpad tab focused on it. */
  /** Mod+Enter: toggle the "completed" frontmatter flag on selected/cursor/focused notes.
   *  When true, the row body renders with a strikethrough. */
  async cmdToggleComplete(): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to toggle."); return; }

    // Sample state from first target — we'll set ALL to the opposite of that, so
    // a mixed selection becomes uniformly toggled (toward whichever direction is
    // more useful: if any are incomplete, mark all complete).
    const anyIncomplete = targets.some((t) => !this.isCompleted(t));
    const newState = anyIncomplete; // true means "mark complete"
    const priorStates: { id: StashpadId; path: string; was: boolean }[] = [];

    const changedIds: StashpadId[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const was = this.isCompleted(t);
      priorStates.push({ id: t.id, path: t.file.path, was });
      if (was === newState) continue;
      await this.app.fileManager.processFrontMatter(t.file, (fm) => {
        if (newState) fm.completed = true;
        else delete fm.completed;
      });
      changedIds.push(t.id);
    }
    this.render();
    if (changedIds.length > 0) {
      await this.log.append({
        type: newState ? "complete" : "uncomplete",
        id: changedIds[0],
        payload: { ids: changedIds, count: changedIds.length },
      });
      const toggledNodes = changedIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
      this.plugin.notifications.show({
        message: this.bulkActionMessage({
          verb: newState ? "Marked complete" : "Unmarked",
          nodes: toggledNodes,
        }),
        kind: "success",
        category: newState ? "complete" : "uncomplete",
        affectedIds: changedIds,
        folder: this.noteFolder,
      });
    }

    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: `${newState ? "Mark complete" : "Unmark complete"} (${targets.length})`,
      undo: async () => {
        const reverted: StashpadId[] = [];
        for (const p of priorStates) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (fm) => {
            if (p.was) fm.completed = true;
            else delete fm.completed;
          });
          if (changedIds.includes(p.id)) reverted.push(p.id);
        }
        if (reverted.length > 0) {
          await this.log.append({
            type: newState ? "uncomplete" : "complete",
            id: reverted[0],
            payload: { ids: reverted, count: reverted.length, undo: true },
          });
        }
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => {
        for (const p of priorStates) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (fm) => {
            if (newState) fm.completed = true;
            else delete fm.completed;
          });
        }
        if (changedIds.length > 0) {
          await this.log.append({
            type: newState ? "complete" : "uncomplete",
            id: changedIds[0],
            payload: { ids: changedIds, count: changedIds.length, redo: true },
          });
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  private isCompleted(node: TreeNode): boolean {
    if (!node.file) return false;
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
    return !!fm?.completed;
  }

  /** Return the per-note color from frontmatter (already validated as a
   *  hex triple/sextuple), or null when unset/invalid. */
  private colorForNode(node: TreeNode): string | null {
    if (!node.file) return null;
    const raw = this.app.metadataCache.getFileCache(node.file)?.frontmatter?.color;
    if (typeof raw !== "string") return null;
    const v = raw.trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return null;
    return v;
  }

  /** Walk up from `node` looking for the nearest ancestor (or `node`
   *  itself) with a color frontmatter. Returns the hex and the depth
   *  distance — 0 means the node itself is colored, 1 means its
   *  immediate parent, etc. Returns null if nothing in the chain up to
   *  root carries a color.
   *
   *  Used to paint inherited-color side-stripes on descendant rows:
   *  every note in a colored subtree picks up a faded tint of the
   *  nearest colored ancestor, so the visual grouping is preserved
   *  even in Flat / Everything where the tree structure isn't drawn. */
  private inheritedColorForNode(node: TreeNode): { hex: string; depth: number } | null {
    let cur: TreeNode | undefined = node;
    let depth = 0;
    while (cur && cur.id !== ROOT_ID) {
      const c = this.colorForNode(cur);
      if (c) return { hex: c, depth };
      cur = cur.parent ? this.tree.get(cur.parent) : undefined;
      depth += 1;
    }
    return null;
  }

  // --- Drag-and-drop reordering ---

  private dragSourceIds: StashpadId[] | null = null;
  private dragPlaceholder: HTMLElement | null = null;
  private dragRowHeight = 0;
  /** When set, the next render() will use this list of ids to compute cursor &
   *  selection (find their positions in currentChildren). Used by reorder/move/undo
   *  to stop the stale cursor lingering on the previous row's slot. */
  private pendingFocusIds: StashpadId[] | null = null;

  private attachRowDnD(row: HTMLElement, node: TreeNode, _idx: number): void {
    row.addEventListener("dragstart", (e: DragEvent) => {
      const ids = this.selection.has(node.id) && this.selection.size > 1
        ? [...this.selection]
        : [node.id];
      this.dragSourceIds = ids;
      this.dragRowHeight = row.offsetHeight;
      row.addClass("is-dragging");
      // Pre-create the placeholder once per drag (kept detached until first dragover).
      if (this.listEl) {
        this.dragPlaceholder = this.listEl.createDiv({ cls: "stashpad-drop-placeholder" });
        this.dragPlaceholder.style.height = "0px";
        // Make the placeholder a valid drop target so dropping in the gap actually
        // fires a drop event (without this it'd be inert and the drop would be lost).
        this.dragPlaceholder.addEventListener("dragover", (de: DragEvent) => {
          if (!this.dragSourceIds) return;
          de.preventDefault();
          if (de.dataTransfer) de.dataTransfer.dropEffect = "move";
        });
        this.dragPlaceholder.addEventListener("drop", (de: DragEvent) => {
          if (!this.dragSourceIds || !this.dragPlaceholder) return;
          de.preventDefault();
          de.stopPropagation();
          const sources = this.dragSourceIds.slice();
          this.dragSourceIds = null;
          // Determine the target by looking at the row that comes AFTER the placeholder
          // (drop "before" that row). If placeholder is the last sibling, drop "after"
          // the row before it.
          const after = this.dragPlaceholder.nextElementSibling as HTMLElement | null;
          const before = this.dragPlaceholder.previousElementSibling as HTMLElement | null;
          this.removeDragPlaceholder();
          let targetId: string | undefined;
          let position: "before" | "after" = "before";
          if (after && after.classList.contains("stashpad-note")) {
            targetId = (after as HTMLElement).dataset.id;
            position = "before";
          } else if (before && before.classList.contains("stashpad-note")) {
            targetId = (before as HTMLElement).dataset.id;
            position = "after";
          }
          if (targetId) void this.reorderToTarget(sources, targetId, position);
        });
        this.dragPlaceholder.remove();
      }
      // Use text/plain — some Chromium versions don't initiate drag without a
      // standard MIME type set on dataTransfer.
      e.dataTransfer?.setData("text/plain", ids.join(","));
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // Use the whole row as the drag image (not just the grip when that's the source).
        try { e.dataTransfer.setDragImage(row, 12, 12); } catch {}
      }
    });
    row.addEventListener("dragend", () => {
      row.removeClass("is-dragging");
      this.clearDropIndicators();
      this.removeDragPlaceholder();
      this.dragSourceIds = null;
    });
    row.addEventListener("dragover", (e: DragEvent) => {
      if (!this.dragSourceIds) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const zone = this.dropZone(e, row);
      this.clearDropIndicators();
      if (zone === "drop-into") {
        this.removeDragPlaceholder();
        row.addClass("drop-into");
      } else {
        row.removeClass("drop-into");
        this.placePlaceholder(row, zone === "drop-above" ? "before" : "after");
      }
    });
    row.addEventListener("dragleave", (e: DragEvent) => {
      // Only clear if we've actually left the row (not just moved over a child).
      const r = row.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        row.removeClass("drop-into");
      }
    });
    row.addEventListener("drop", (e: DragEvent) => {
      if (!this.dragSourceIds) return;
      e.preventDefault();
      e.stopPropagation();
      const sources = this.dragSourceIds.slice();
      this.dragSourceIds = null;
      const zone = this.dropZone(e, row);
      this.clearDropIndicators();
      this.removeDragPlaceholder();
      row.removeClass("is-dragging");
      if (zone === "drop-into") {
        void this.reorderToTarget(sources, node.id, "into");
      } else {
        void this.reorderToTarget(sources, node.id, zone === "drop-above" ? "before" : "after");
      }
    });
  }

  private placePlaceholder(row: HTMLElement, where: "before" | "after"): void {
    if (!this.dragPlaceholder || !this.listEl) return;
    const sibling = where === "before" ? row : row.nextSibling;
    // Avoid redundant DOM moves (which would re-trigger animations).
    if (where === "before" && this.dragPlaceholder.nextSibling === row) return;
    if (where === "after" && this.dragPlaceholder.previousSibling === row) return;
    const wasMounted = !!this.dragPlaceholder.parentElement;
    this.listEl.insertBefore(this.dragPlaceholder, sibling);
    // Always restore visibility — drop-into → drop-above transitions had been
    // leaving the placeholder at opacity 0 / height 0 from a previous animated remove.
    this.dragPlaceholder.style.opacity = "1";
    if (!wasMounted) {
      this.dragPlaceholder.style.height = "0px";
      // Force layout, then animate to full height.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      this.dragPlaceholder.offsetHeight;
      this.dragPlaceholder.style.height = `${this.dragRowHeight}px`;
    } else {
      this.dragPlaceholder.style.height = `${this.dragRowHeight}px`;
    }
  }

  private removeDragPlaceholder(): void {
    if (!this.dragPlaceholder?.parentElement) return;
    const ph = this.dragPlaceholder;
    // Animate collapse, then remove. Keep a reference so a fast next-drag isn't
    // confused (we null out below regardless).
    ph.style.height = "0px";
    ph.style.opacity = "0";
    setTimeout(() => { if (ph.parentElement) ph.remove(); }, 150);
  }

  /** Three-zone hit test for drop position relative to a row's vertical bounds:
   *  top 30% → drop-above, middle 40% → drop-into, bottom 30% → drop-below. */
  private dropZone(e: DragEvent, row: HTMLElement): "drop-above" | "drop-into" | "drop-below" {
    const rect = row.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < rect.height * 0.3) return "drop-above";
    if (y > rect.height * 0.7) return "drop-below";
    return "drop-into";
  }

  private clearDropIndicators(): void {
    if (!this.listEl) return;
    for (const el of Array.from(this.listEl.querySelectorAll(".drop-into"))) {
      (el as HTMLElement).removeClass("drop-into");
    }
  }

  /** True if `descId` is a descendant of `ancestorId` in the tree (used to prevent
   *  cycles when nesting via drag-into). */
  private isDescendant(descId: StashpadId, ancestorId: StashpadId): boolean {
    let cur = this.tree.get(descId);
    const seen = new Set<StashpadId>();
    while (cur && cur.parent && !seen.has(cur.id)) {
      if (cur.parent === ancestorId) return true;
      seen.add(cur.id);
      cur = this.tree.get(cur.parent);
    }
    return false;
  }

  /** Cross-parent drag: re-parent the sources to targetParent, then place them at
   *  the drop position relative to targetId. Logged + undoable as a single step. */
  private async moveAcrossThenReorder(
    sourceIds: StashpadId[],
    targetParentId: StashpadId,
    targetId: StashpadId,
    position: "before" | "after",
  ): Promise<void> {
    // Capture prior state for undo: each source's old parent + path.
    const priorParents: { id: StashpadId; path: string; oldParent: StashpadId | null }[] = [];
    const affectedParents = new Set<StashpadId>();
    for (const id of sourceIds) {
      const n = this.tree.get(id);
      if (!n?.file) continue;
      priorParents.push({ id, path: n.file.path, oldParent: n.parent });
      affectedParents.add((n.parent ?? ROOT_ID) as StashpadId);
    }
    affectedParents.add(targetParentId);

    // Capture author/contributor ids BEFORE the move so cross-author filtering picks it up.
    const movedAuthorIds = this.collectAuthorIds(
      sourceIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n)
    );

    const folder = this.noteFolder;

    // Snapshot affected parents' current orders before mutating.
    const orderSnapshot: Record<string, string[]> = {};
    for (const p of affectedParents) orderSnapshot[p] = this.order.getOrder(folder, p).slice();

    // Step 1: re-parent each source via processFrontMatter + log.
    for (const p of priorParents) {
      const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
      if (!f) continue;
      await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = targetParentId; });
      // Schedule background recovery-fields sync for the moved note +
      // both parents.
      this.fmSync.scheduleParentChange(p.id, p.oldParent, targetParentId);
      await this.log.append({
        type: "parent_change", id: p.id,
        payload: { from: p.oldParent, to: targetParentId, reason: "drag" },
      });
      // Remove the id from any previous parent's order array.
      this.order.removeChild(folder, p.id);
    }

    // Step 2: rebuild the tree so we see the new parent assignments, then build
    // the new order under targetParent based on getChildren (which already includes
    // the moved notes appended at the end).
    this.tree.rebuild(folder);
    const childrenAfter = this.tree.getChildren(targetParentId).map((n) => n.id);
    const sourceSet = new Set(sourceIds);
    const others = childrenAfter.filter((id) => !sourceSet.has(id));
    let insertAt = others.indexOf(targetId);
    if (insertAt < 0) insertAt = others.length;
    if (position === "after") insertAt += 1;
    const newOrder = [...others.slice(0, insertAt), ...sourceIds.filter((id) => !!this.tree.get(id)), ...others.slice(insertAt)];
    this.order.setOrder(folder, targetParentId, newOrder);
    await this.order.save(folder);
    // Drag/keyboard reorder always snaps the destination parent back to
    // manual sort — see forceManualMode jsdoc.
    await this.forceManualMode(targetParentId);
    await this.log.append({
      type: "reorder",
      id: targetParentId,
      payload: { dir: "drag-cross", parent: targetParentId, ids: sourceIds, count: sourceIds.length },
    });

    // Cursor follows: if we're currently viewing the new parent, focus the
    // moved notes; otherwise the moved notes are now off-screen — so focus
    // the new parent instead (when it's visible in the current view). That
    // gives the user a visible anchor pointing at "where your notes went."
    // 0.56.5: previously this just cleared selection, which left the user
    // staring at an unrelated row.
    // 0.56.6: also re-apply selection on a delayed pass to cover the case
    // where the metadataCache-driven debouncedRender (fired by
    // processFrontMatter writes during the move) lands AFTER our render
    // and wipes the highlight. tryReselect bails as soon as the row is
    // visibly selected, so it's a no-op if the first render stuck.
    const targetIsFocused = this.focusId === targetParentId;
    const focusTarget: StashpadId = targetIsFocused ? sourceIds[0]! : targetParentId;
    const focusIdsForRender = targetIsFocused ? sourceIds.slice() : [targetParentId];
    if (targetIsFocused) {
      this.pendingFocusIds = focusIdsForRender;
    } else {
      this.selection.clear();
      this.cursorIdx = -1;
      this.pendingFocusIds = focusIdsForRender;
    }
    this.tree.rebuild(folder);
    this.render({ kind: "follow-cursor" });
    const guardKey = this.selectionGuardKey;
    const tryReselect = () => {
      if (this.selectionGuardKey !== guardKey) return; // user navigated away
      if (this.selection.has(focusTarget)) return;
      const idx = this.currentChildren.findIndex((n) => n.id === focusTarget);
      if (idx < 0) return;
      this.selection.add(focusTarget);
      this.cursorIdx = idx;
      this.render({ kind: "follow-cursor" });
    };
    setTimeout(tryReselect, 120);
    setTimeout(tryReselect, 400);
    const movedNodes = sourceIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
    const targetNode = this.tree.get(targetParentId);
    const targetTitle = targetNode ? this.titleForNode(targetNode) : "(root)";
    this.plugin.notifications.show({
      message: this.bulkActionMessage({
        verb: "Reparented",
        nodes: movedNodes,
        destination: `→ "${targetTitle}"`,
      }),
      kind: "success",
      category: "move",
      affectedIds: sourceIds,
      affectedAuthorIds: movedAuthorIds,
      folder,
      actions: targetParentId === ROOT_ID ? [] : [{
        label: `Jump to "${targetTitle}"`,
        onClick: () => this.navigateTo(targetParentId),
      }],
    });

    // Undo: revert each parent change AND restore the order snapshots for every affected parent.
    this.plugin.getUndoStack(folder).push({
      label: `Move + reorder (${sourceIds.length})`,
      undo: async () => {
        for (const p of priorParents) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (fm) => {
            if (p.oldParent === null || p.oldParent === undefined) fm.parent = ROOT_ID;
            else fm.parent = p.oldParent;
          });
          await this.log.append({
            type: "parent_change", id: p.id,
            payload: { from: targetParentId, to: p.oldParent, reason: "drag-undo" },
          });
        }
        for (const [pid, ord] of Object.entries(orderSnapshot)) {
          if (ord.length === 0) {
            const map = (this.order as any).cache.get(folder) ?? {};
            delete map[pid];
            (this.order as any).cache.set(folder, map);
          } else {
            this.order.setOrder(folder, pid, ord);
          }
        }
        await this.order.save(folder);
        // After undo: clear cursor/selection so the previously-target parent doesn't
        // keep a stale highlight on a row that's no longer the moved-in note.
        this.pendingFocusIds = sourceIds.slice();
        this.selection.clear();
        this.cursorIdx = -1;
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => {
        for (const p of priorParents) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = targetParentId; });
          this.order.removeChild(folder, p.id);
        }
        this.order.setOrder(folder, targetParentId, newOrder);
        await this.order.save(folder);
        this.pendingFocusIds = sourceIds.slice();
        if (this.focusId !== targetParentId) { this.selection.clear(); this.cursorIdx = -1; }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** Place sourceIds before/after targetId, OR nest them as children of targetId
   *  ("into"). Cross-parent + nest both prompt a confirm (unless disabled in settings). */
  private async reorderToTarget(
    sourceIds: StashpadId[],
    targetId: StashpadId,
    position: "before" | "after" | "into",
  ): Promise<void> {
    const targetNode = this.tree.get(targetId);
    if (!targetNode) return;
    const sourceNodes = sourceIds
      .map((id) => this.tree.get(id))
      .filter((n): n is TreeNode => !!n && !!n.file);
    if (sourceNodes.length === 0) return;
    if (sourceNodes.some((n) => n.id === targetId)) {
      // User tried to drop a note onto itself — silent today; surface
      // an error so the user knows the action was understood and
      // intentionally refused (not just ignored).
      this.plugin.notifications.show({
        message: "Can't move a note into itself.",
        kind: "warning",
        category: "move",
        folder: this.noteFolder,
      });
      return;
    }
    // For nesting: prevent dropping onto a descendant of the source (would create a cycle).
    if (position === "into") {
      for (const src of sourceNodes) {
        if (this.isDescendant(targetId, src.id)) {
          this.plugin.notifications.show({
            message: `Can't nest "${this.titleForNode(src)}" under one of its own descendants — that would create a cycle.`,
            kind: "warning",
            category: "move",
            folder: this.noteFolder,
          });
          return;
        }
      }
    }

    // Decide which parent the sources will end up under.
    const newParentId = position === "into"
      ? targetId
      : ((targetNode.parent as StashpadId) ?? ROOT_ID);

    // Detect cross-parent sources (relative to the new destination).
    const isCross = sourceNodes.some((n) => (n.parent ?? ROOT_ID) !== newParentId);
    if (isCross) {
      const settings = getSettings();
      const doMove = async () => {
        if (position === "into") {
          // Append to target's children at the end (no targetId-relative position).
          await this.moveAcrossThenReorder(sourceNodes.map((n) => n.id), newParentId, /*targetId for ordering*/ "", "after");
        } else {
          await this.moveAcrossThenReorder(sourceNodes.map((n) => n.id), newParentId, targetId, position);
        }
      };
      if (settings.confirmCrossParentDrag) {
        const targetTitle = this.titleForNode(targetNode);
        const n = sourceNodes.length;
        const verb = position === "into" ? "Nest" : "Move";
        const prep = position === "into" ? "as children of" : "under";
        new ConfirmModal(
          this.app,
          position === "into" ? "Nest under target?" : "Move under different parent?",
          `${verb} ${n} note${n === 1 ? "" : "s"} ${prep} "${targetTitle}"? Their parent will change.`,
          verb,
          (ok) => { if (ok) void doMove(); },
        ).open();
      } else {
        await doMove();
      }
      return;
    }

    const parentId = newParentId;

    // Same-parent reorder path.
    const validSources = sourceNodes.map((n) => n.id);

    const all = this.tree.getChildren(parentId).map((n) => n.id);
    const sourceSet = new Set(validSources);
    const others = all.filter((id) => !sourceSet.has(id));
    let insertAt = others.indexOf(targetId);
    if (insertAt < 0) return;
    if (position === "after") insertAt += 1;
    const newOrder = [...others.slice(0, insertAt), ...validSources, ...others.slice(insertAt)];
    if (arraysEqual(newOrder, all)) return;

    const folder = this.noteFolder;
    const prev = this.order.getOrder(folder, parentId).slice();
    this.order.setOrder(folder, parentId, newOrder);
    await this.order.save(folder);
    // Same-parent drag-reorder snaps this parent to manual sort.
    await this.forceManualMode(parentId);
    await this.log.append({
      type: "reorder",
      id: parentId,
      payload: { dir: "drag", parent: parentId, ids: validSources, count: validSources.length },
    });
    this.pendingFocusIds = validSources.slice();
    this.tree.rebuild(folder);
    this.render();
    const reorderedNodes = validSources.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
    this.plugin.notifications.show({
      message: this.bulkActionMessage({ verb: "Reordered", nodes: reorderedNodes }),
      kind: "success",
      category: "reorder",
      affectedIds: validSources,
      folder,
    });

    this.plugin.getUndoStack(folder).push({
      label: `Reorder (drag, ${validSources.length})`,
      undo: async () => {
        if (prev.length === 0) {
          const map = (this.order as any).cache.get(folder) ?? {};
          delete map[parentId];
          (this.order as any).cache.set(folder, map);
        } else {
          this.order.setOrder(folder, parentId, prev);
        }
        await this.order.save(folder);
        await this.log.append({
          type: "reorder",
          id: parentId,
          payload: { dir: "undo", parent: parentId, ids: validSources, count: validSources.length },
        });
        this.pendingFocusIds = validSources.slice();
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => {
        this.order.setOrder(folder, parentId, newOrder);
        await this.order.save(folder);
        await this.log.append({
          type: "reorder",
          id: parentId,
          payload: { dir: "redo:drag", parent: parentId, ids: validSources, count: validSources.length },
        });
        this.pendingFocusIds = validSources.slice();
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  // --- Reorder commands (Mod+Up/Down, Mod+Shift+Up/Down) ---

  cmdMoveUp(): void { void this.reorderSelection("up"); }
  cmdMoveDown(): void { void this.reorderSelection("down"); }
  cmdMoveToTop(): void { void this.reorderSelection("top"); }
  cmdMoveToBottom(): void { void this.reorderSelection("bottom"); }

  /** Reorder the currently-selected notes (or cursor row) within their parent. */
  private async reorderSelection(dir: "up" | "down" | "top" | "bottom"): Promise<void> {
    // Resolve targets: selection (must all share parent), else cursor row.
    let targets: TreeNode[] = [];
    if (this.selection.size > 0) {
      const sel = [...this.selection].map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n && !!n.file);
      if (sel.length === 0) return;
      const parents = new Set(sel.map((n) => n.parent));
      if (parents.size > 1) { new Notice("Reorder requires a single-parent selection."); return; }
      targets = sel;
    } else if (this.cursorIdx >= 0 && this.currentChildren[this.cursorIdx]) {
      targets = [this.currentChildren[this.cursorIdx]];
    }
    if (targets.length === 0) { new Notice("Nothing to reorder."); return; }

    const parentId = (targets[0].parent as StashpadId) ?? ROOT_ID;
    // Build the current child order for this parent (post-filter by time-filter
    // would be wrong; we want the full child list so reorder respects everything).
    const allChildren = this.tree.getChildren(parentId).map((n) => n.id);
    if (allChildren.length === 0) return;

    // Sort targets by current position so block moves stay contiguous.
    const targetSet = new Set(targets.map((t) => t.id));
    const targetIds = allChildren.filter((id) => targetSet.has(id));
    if (targetIds.length === 0) return;

    const newOrder = computeReorder(allChildren, targetIds, dir);
    if (arraysEqual(newOrder, allChildren)) return; // already at the edge

    const folder = this.noteFolder;
    const prev = this.order.getOrder(folder, parentId).slice();
    this.order.setOrder(folder, parentId, newOrder);
    await this.order.save(folder);
    // Keyboard moveUp/Down/Top/Bottom is a manual reorder — same auto-flip
    // semantics as drag.
    await this.forceManualMode(parentId);
    await this.log.append({
      type: "reorder",
      id: parentId,
      payload: { dir, parent: parentId, ids: targetIds, count: targetIds.length },
    });

    // Re-render to reflect the new sort. Keep the cursor on the moved note(s).
    // 0.56.5: explicit follow-cursor policy so the moved row gets scrolled
    // into view. Without this, holding ⌥↑ would let the row slide out of
    // the viewport because preserve's anchor restoration locks the OLD
    // top-of-viewport row in place, not the cursor.
    this.pendingFocusIds = targetIds.slice();
    this.tree.rebuild(folder);
    this.render({ kind: "follow-cursor" });
    const keyMovedNodes = targetIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
    this.plugin.notifications.show({
      message: this.bulkActionMessage({
        verb: "Moved",
        nodes: keyMovedNodes,
        destination: dir,
      }),
      kind: "success",
      category: "reorder",
      affectedIds: targetIds,
      folder,
    });

    // Undo support.
    this.plugin.getUndoStack(folder).push({
      label: `Reorder (${dir})`,
      undo: async () => {
        if (prev.length === 0) {
          const map = (this.order as any).cache.get(folder) ?? {};
          delete map[parentId];
          (this.order as any).cache.set(folder, map);
        } else {
          this.order.setOrder(folder, parentId, prev);
        }
        await this.order.save(folder);
        await this.log.append({
          type: "reorder",
          id: parentId,
          payload: { dir: "undo", parent: parentId, ids: targetIds, count: targetIds.length },
        });
        this.pendingFocusIds = targetIds.slice();
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => {
        this.order.setOrder(folder, parentId, newOrder);
        await this.order.save(folder);
        await this.log.append({
          type: "reorder",
          id: parentId,
          payload: { dir: `redo:${dir}`, parent: parentId, ids: targetIds, count: targetIds.length },
        });
        this.pendingFocusIds = targetIds.slice();
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** Mod+Backspace handler: delete the selected notes (or cursor row, or focused note). */
  async cmdDelete(): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing selected to delete."); return; }
    if (targets.length === 1) { await this.deleteNote(targets[0]); return; }

    // Multi-delete: gather totals and confirm once.
    const allNotes: TreeNode[] = [];
    const seen = new Set<StashpadId>();
    const walk = (n: TreeNode): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      for (const c of this.tree.getChildren(n.id)) walk(c);
      allNotes.push(n);
    };
    for (const t of targets) walk(t);

    // Same body-embeds ∪ frontmatter-list union as the single-note path.
    // Parallelize the body reads — on a network drive this loop used to be
    // N serial round-trips before the modal could even open.
    const attNotes = allNotes.filter((n): n is TreeNode & { file: TFile } => !!n.file);
    const rawBodies = await Promise.all(attNotes.map((n) => this.app.vault.read(n.file)));
    const attachments: string[] = [];
    for (let i = 0; i < attNotes.length; i++) {
      const n = attNotes[i];
      attachments.push(...this.extractAttachments(this.stripFrontmatter(rawBodies[i])));
      const fm = this.app.metadataCache.getFileCache(n.file)?.frontmatter;
      if (Array.isArray(fm?.attachments)) {
        for (const a of fm.attachments) {
          if (typeof a === "string" && a.trim()) attachments.push(a);
        }
      }
    }
    const uniqueAtts = [...new Set(attachments)];
    const descCount = allNotes.length - targets.length;

    // The actual delete pipeline is hoisted into a closure so we can
    // invoke it either after the confirm modal OR directly when the
    // user has chosen to skip confirmation in settings. When skipping,
    // attachments are NOT auto-deleted (no checkbox to opt in) — the
    // safer default for an unattended path.
    const performDelete = async (alsoAtts: boolean) => {
        const snap = await this.snapshotNotes(allNotes, alsoAtts);
        let attsRemoved = 0;
        if (alsoAtts) {
          for (const p of uniqueAtts) {
            const f = this.app.metadataCache.getFirstLinkpathDest(p, "");
            if (f) {
              try {
                await this.app.fileManager.trashFile(f);
                await this.log.append({ type: "attachment_remove", id: ROOT_ID, payload: { path: f.path } });
                // Route through plugin.notifications so this matches the
                // parent delete's styled toast (left-border accent,
                // history entry, mute support via the "attachment"
                // category). Kind=warning to mirror the parent.
                this.plugin.notifications.show({
                  message: `Deleted attachment "${f.name}"`,
                  kind: "warning",
                  category: "attachment",
                  affectedPaths: [f.path],
                  folder: this.noteFolder,
                });
                attsRemoved += 1;
              } catch {}
            }
          }
        }
        // Capture surviving parent ids BEFORE we delete, so the
        // post-delete sync can update their children lists.
        const orphanedParents = new Set<StashpadId>();
        for (const n of allNotes) if (n.parent) orphanedParents.add(n.parent);
        // Capture author/contributor ids BEFORE deletion so cross-author
        // filtering can pick this up (resolver can't read deleted files).
        const deletedAuthorIds = this.collectAuthorIds(allNotes);
        // 0.56.5: pick a surviving neighbour for cursor BEFORE the rebuild
        // wipes everything. Look forward from the topmost deleted position
        // for the first non-deleted sibling; fall back to looking backward.
        const deletedIdSet = new Set(targets.map((t) => t.id));
        const deletedIndices = this.currentChildren
          .map((c, i) => (deletedIdSet.has(c.id) ? i : -1))
          .filter((i) => i >= 0);
        const topDeletedIdx = deletedIndices.length > 0 ? deletedIndices[0] : -1;
        let neighbourId: StashpadId | null = null;
        if (topDeletedIdx >= 0) {
          for (let i = topDeletedIdx + 1; i < this.currentChildren.length; i++) {
            if (!deletedIdSet.has(this.currentChildren[i].id)) {
              neighbourId = this.currentChildren[i].id;
              break;
            }
          }
          if (!neighbourId) {
            for (let i = topDeletedIdx - 1; i >= 0; i--) {
              if (!deletedIdSet.has(this.currentChildren[i].id)) {
                neighbourId = this.currentChildren[i].id;
                break;
              }
            }
          }
        }
        for (const n of allNotes) {
          if (!n.file) continue;
          try { await this.app.fileManager.trashFile(n.file); } catch {}
          await this.log.append({ type: "delete", id: n.id, payload: { path: n.file.path, attachmentsRemoved: alsoAtts ? uniqueAtts : [] } });
        }
        this.selection.clear();
        this.cursorIdx = -1;
        if (neighbourId) this.pendingFocusIds = [neighbourId];
        this.tree.rebuild(this.noteFolder);
        for (const pid of orphanedParents) {
          if (allNotes.some((n) => n.id === pid)) continue;
          this.fmSync.scheduleParentOfDeleted(pid);
        }
        this.render({ kind: "follow-cursor" });
        const attSuffix = attsRemoved > 0
          ? ` with ${attsRemoved} attachment${attsRemoved === 1 ? "" : "s"}`
          : "";
        this.plugin.notifications.show({
          message: this.bulkActionMessage({
            verb: "Deleted",
            nodes: targets,
            suffix: attSuffix.trim() || undefined,
          }),
          kind: "warning",
          category: "delete",
          affectedIds: targets.map((t) => t.id),
          affectedAuthorIds: deletedAuthorIds,
          folder: this.noteFolder,
        });
        const folder = this.noteFolder;
        const undoFocusIds = targets.map((t) => t.id);
        this.plugin.getUndoStack(folder).push({
          label: `Delete ${targets.length} note${targets.length === 1 ? "" : "s"}`,
          undo: async () => {
            this.selection.clear();
            this.cursorIdx = -1;
            await this.restoreSnapshots(snap, undoFocusIds.slice());
          },
          redo: async () => {
            this.selection.clear();
            this.cursorIdx = -1;
            await this.trashNotesAndAttachments(snap);
          },
        });
        this.focusView();
    };

    // Two-gate logic (same shape as deleteNote). A multi-selection is
    // itself a "bulk" delete, so confirmBulkDelete gates the whole batch
    // even when there are no descendants.
    const settings = getSettings();
    const promptForBulk = settings.confirmBulkDelete; // targets.length > 1 is implicit here
    const promptForAttachments = uniqueAtts.length > 0 && settings.confirmAttachmentDelete;
    if (!promptForBulk && !promptForAttachments) {
      await performDelete(false);
      return;
    }

    new ConfirmDeleteModal(
      this.app,
      `${targets.length} selected note${targets.length === 1 ? "" : "s"}`,
      descCount,
      uniqueAtts.length,
      promptForAttachments,
      performDelete,
    ).open();
  }

  /** Split the cursor row (or focused/passed) note in two at a chosen line.
   *  First part keeps the original note's id, file, and children.
   *  Second part becomes a new sibling with no children. */
  async cmdSplit(node?: TreeNode): Promise<void> {
    const target = node ?? this.resolveActionTarget();
    if (!target?.file) { new Notice("Pick a note to split."); return; }
    const file = target.file;
    const md = await this.app.vault.read(file);
    const body = this.stripFrontmatter(md).replace(/\s+$/, "");
    const lines = body.split(/\r?\n/);
    if (body.trim().length < 2) { new Notice("Note is too short to split."); return; }
    const originalContent = md;
    const originalPath = file.path;
    const performSplit = async (firstBody: string, secondBody: string, payload: Record<string, unknown>) => {
      if (!firstBody.trim() || !secondBody.trim()) { new Notice("Split would leave one part empty."); return; }
      try {
        const fm = md.startsWith("---") ? md.slice(0, md.indexOf("\n---", 3) + 4) : "";
        const newOriginal = fm + (fm ? "\n" : "") + firstBody + "\n";
        await this.app.vault.modify(file, newOriginal);
        const parentId = target.parent ?? ROOT_ID;
        // Don't record the createNoteUnder action — the split itself
        // becomes one combined undo entry. Inherit the source note's
        // `created` time PLUS 1 ms so the second half sorts immediately
        // after the first half (instead of either jumping to the end
        // or tying for the same instant). ISO-8601 carries millisecond
        // precision so this round-trips cleanly.
        const baseTime = Date.parse(target.created || "");
        const inheritedCreated = Number.isFinite(baseTime)
          ? new Date(baseTime + 1).toISOString()
          : new Date().toISOString();
        const newId = await this.createNoteUnder(secondBody, parentId, {
          record: false,
          createdOverride: inheritedCreated,
        });
        await this.log.append({
          type: "rename", id: target.id,
          payload: { action: "split", into: newId, ...payload },
        });
        this.tree.rebuild(this.noteFolder);
        this.render();
        this.plugin.notifications.show({
          message: `Split "${this.titleForNode(target)}" into two`,
          kind: "success",
          category: "split",
          affectedIds: [target.id],
          folder: this.noteFolder,
        });

        // Find the new note's path so undo/redo can locate it.
        const newNode = newId ? this.tree.get(newId) : undefined;
        const newPath = newNode?.file?.path;
        const newContentForRedo = newPath ? await this.app.vault.read(newNode!.file!) : null;

        const folder = this.noteFolder;
        this.plugin.getUndoStack(folder).push({
          label: "Split note",
          undo: async () => {
            // Trash the new note, restore the original's full body.
            if (newPath) {
              const nf = this.app.vault.getAbstractFileByPath(newPath) as TFile | null;
              if (nf) { try { await this.app.fileManager.trashFile(nf); } catch {} }
            }
            const of = this.app.vault.getAbstractFileByPath(originalPath) as TFile | null;
            if (of) await this.app.vault.modify(of, originalContent);
            this.tree.rebuild(folder);
            this.render();
          },
          redo: async () => {
            const of = this.app.vault.getAbstractFileByPath(originalPath) as TFile | null;
            if (of) await this.app.vault.modify(of, newOriginal);
            if (newPath && newContentForRedo && !(await this.app.vault.adapter.exists(newPath))) {
              await this.app.vault.create(newPath, newContentForRedo);
            }
            this.tree.rebuild(folder);
            this.render();
          },
        });
      } catch (e) {
        new Notice(`Stashpad: split failed (${(e as Error).message})`);
        console.error(e);
      }
    };

    new SplitNoteModal(
      this.app,
      body,
      async (lineIdx) => {
        const firstBody = lines.slice(0, lineIdx).join("\n").replace(/\s+$/, "");
        const secondBody = lines.slice(lineIdx).join("\n").replace(/^\s+|\s+$/g, "");
        await performSplit(firstBody, secondBody, { mode: "line", splitAtLine: lineIdx });
      },
      async (charIdx) => {
        const firstBody = body.slice(0, charIdx).replace(/\s+$/, "");
        const secondBody = body.slice(charIdx).replace(/^\s+|\s+$/g, "");
        await performSplit(firstBody, secondBody, { mode: "cursor", splitAtChar: charIdx });
      },
    ).open();
  }

  cmdOpenInNewStashpadTab(node?: TreeNode): void {
    const target = node ?? this.resolveActionTarget();
    if (!target?.file) return;
    void this.openInNewStashpadTab(target.id);
  }

  /** Clone the current Stashpad tab — same folder, same focus — so the
   *  user has a second viewport on the same subtree. Mirrors the
   *  "duplicate" button (lucide "copy" icon) in the focused-header
   *  actions cluster. Falls back to the Home id if the focused note
   *  somehow lacks a file. */
  cmdCloneStashpadTab(): void {
    const focused = this.tree.get(this.focusId);
    if (focused?.file) this.cmdOpenInNewStashpadTab(focused);
    else void this.openInNewStashpadTab(this.focusId);
  }

  private resolveActionTarget(): TreeNode | undefined {
    if (this.cursorIdx >= 0 && this.currentChildren[this.cursorIdx]) {
      return this.currentChildren[this.cursorIdx];
    }
    const focused = this.tree.get(this.focusId);
    return focused?.file ? focused : undefined;
  }

  // --- Stash export / import ---

  /** Export selected notes (or cursor row if no selection, or focused note as last resort) as .stash. */
  async cmdExportStash(rootNode?: TreeNode): Promise<void> {
    const roots = this.collectExportRoots(rootNode);
    if (roots.length === 0) { new Notice("Nothing to export."); return; }
    const all = this.collectExportSubtree(roots);
    if (all.length === 0) { new Notice("No exportable notes (no files attached)."); return; }
    try {
      const buf = await buildStashZip(this.app, {
        rootNotes: roots.filter((n) => !!n.file).map((n) => ({ id: n.id, file: n.file! })),
        allDescendants: all
          .filter((n) => !roots.some((r) => r.id === n.id))
          .filter((n) => !!n.file)
          .map((n) => ({ id: n.id, file: n.file! })),
        sourceFolder: this.noteFolder,
      });
      const stamp = (moment as any)().format("YYYYMMDD-HHmmss");
      const baseName = roots.length === 1 ? this.titleForNode(roots[0]) : `stashpad-${roots.length}notes`;
      const safe = baseName.replace(/[^\w.\-]+/g, "_").slice(0, 60) || "stash-export";
      const exportSub = (this.plugin.settings.exportFolder || "_exports").trim().replace(/^\/+|\/+$/g, "");
      const exportFolder = `${this.noteFolder}/${exportSub}`;
      await this.ensureFolder(exportFolder);
      const outPath = `${exportFolder}/${safe}-${stamp}.${STASH_EXT}`;
      await this.app.vault.createBinary(outPath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      await this.log.append({
        type: "stash_export",
        id: roots[0].id,
        payload: { path: outPath, noteCount: all.length, rootIds: roots.map((r) => r.id) },
      });
      this.plugin.notifications.show({
        message: `Exported ${all.length} note${all.length === 1 ? "" : "s"} → \`${outPath}\``,
        kind: "success",
        category: "export",
        affectedPaths: [outPath],
        folder: this.noteFolder,
        actions: this.actionsForFile(outPath),
      });
    } catch (e) {
      this.plugin.notifications.show({
        message: `Stashpad: export failed\nError: ${(e as Error).message}\nCheck disk space + write permissions on the export folder.`,
        kind: "error",
        category: "export",
      });
      console.error(e);
    }
  }

  private collectExportRoots(node?: TreeNode): TreeNode[] {
    if (node?.file) return [node];
    if (this.selection.size > 0) {
      return [...this.selection]
        .map((id) => this.tree.get(id))
        .filter((n): n is TreeNode => !!n?.file);
    }
    if (this.cursorIdx >= 0 && this.currentChildren[this.cursorIdx]) {
      return [this.currentChildren[this.cursorIdx]];
    }
    const focused = this.tree.get(this.focusId);
    return focused?.file ? [focused] : [];
  }

  private collectExportSubtree(roots: TreeNode[]): TreeNode[] {
    const seen = new Set<StashpadId>();
    const out: TreeNode[] = [];
    const walk = (n: TreeNode): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      if (n.file) out.push(n);
      for (const c of this.tree.getChildren(n.id)) walk(c);
    };
    for (const r of roots) walk(r);
    return out;
  }

  /** Import a .stash file from anywhere in the vault into the current Stashpad folder. */
  async cmdImportStash(): Promise<void> {
    const files = this.app.vault.getFiles().filter((f) => f.extension === STASH_EXT);
    if (files.length === 0) { new Notice("No .stash files found in this vault."); return; }
    const view = this;
    const modal = new (class extends FuzzySuggestModal<TFile> {
      getItems(): TFile[] { return files; }
      getItemText(f: TFile): string { return f.path; }
      onChooseItem(f: TFile): void { void view.processStashFile(f); }
    })(this.app);
    modal.setPlaceholder("Pick a .stash file to import…");
    modal.open();
  }

  async processStashFile(file: TFile): Promise<void> {
    try {
      const buf = await this.app.vault.readBinary(file);
      const summary = await importStashZip(this.app, new Uint8Array(buf), this.noteFolder, this.collectExistingIds());
      this.tree.rebuild(this.noteFolder);
      this.render();
      await this.log.append({
        type: "stash_import",
        id: ROOT_ID,
        payload: {
          from: file.path, into: this.noteFolder,
          noteCount: summary.notesWritten,
          attachmentsWritten: summary.attachmentsWritten,
          collisionsRenamed: summary.collisionsRenamed,
        },
      });
      // Send the source .stash to trash on success (respects user's deleted-files setting).
      try { await this.app.fileManager.trashFile(file); } catch {}
      const parts = [`Imported ${summary.notesWritten} note${summary.notesWritten === 1 ? "" : "s"}`];
      if (summary.attachmentsWritten) parts.push(`+ ${summary.attachmentsWritten} attachment${summary.attachmentsWritten === 1 ? "" : "s"}`);
      if (summary.collisionsRenamed) parts.push(`(${summary.collisionsRenamed} id collision${summary.collisionsRenamed === 1 ? "" : "s"} renamed)`);
      this.plugin.notifications.show({
        message: parts.join(" "),
        kind: "success",
        category: "import",
        folder: this.noteFolder,
      });
    } catch (e) {
      this.plugin.notifications.show({
        message: `Stashpad: import failed\nFile: \`${file.name}\`\nError: ${(e as Error).message}\nInspect with the buttons below — rename to .zip to crack it open in an archive tool.`,
        kind: "error",
        category: "import",
        affectedPaths: [file.path],
        // Reveal/Show actions on the source .stash so the user can
        // inspect the bad bundle. Failure path doesn't trash the file
        // (only success does), so it's still there to inspect.
        actions: this.actionsForFile(file.path),
      });
      console.error(e);
    }
  }

  private collectExistingIds(): Set<StashpadId> {
    const out = new Set<StashpadId>();
    const walk = (id: StashpadId): void => {
      out.add(id);
      const node = this.tree.get(id);
      if (!node) return;
      for (const c of this.tree.getChildren(id)) walk(c.id);
    };
    walk(ROOT_ID);
    return out;
  }

  // --- Note creation ---

  private async createNoteUnder(body: string, parentOverride: StashpadId | null, opts: { record?: boolean; createdOverride?: string } = { record: true }): Promise<StashpadId | null> {
    await this.ensureFolder(this.noteFolder);
    const id = newId();

    // Per-Stashpad template: if the user has set one for this folder, fold
    // its body into the new note's body. Frontmatter overlay happens AFTER
    // file creation via processFrontMatter (so we don't have to hand-roll
    // YAML serialization). Auto-managed fields (id/parent/created/
    // attachments) always win over the template.
    let templateFm: Record<string, any> | null = null;
    {
      const tplPath = (this.plugin.settings.noteTemplates ?? {})[this.noteFolder.replace(/\/+$/, "")];
      if (tplPath) {
        const tplFile = this.app.vault.getAbstractFileByPath(tplPath) as TFile | null;
        if (tplFile && (tplFile as any).extension === "md") {
          try {
            const tplRaw = await this.app.vault.cachedRead(tplFile);
            const tplBody = this.stripFrontmatter(tplRaw);
            templateFm = (this.app.metadataCache.getFileCache(tplFile)?.frontmatter ?? {}) as Record<string, any>;
            // Body merge:
            //   - "{{body}}" token in the template → substitute user body.
            //   - else if user body is empty → use template body.
            //   - else → user body first, then template body (newline-separated).
            if (tplBody.includes("{{body}}")) {
              body = tplBody.replace(/\{\{body\}\}/g, body);
            } else if (!body.trim()) {
              body = tplBody;
            } else if (tplBody.trim()) {
              body = `${body}\n\n${tplBody}`;
            }
          } catch (e) {
            console.warn("[Stashpad] template read failed", e);
          }
        }
      }
    }

    const slug = bodyToSlug(body, this.activeStopwords());
    const filename = buildFilename(slug, id);
    const path = `${this.noteFolder}/${filename}`;
    const parentId = parentOverride ?? this.focusId;
    // createdOverride lets callers (e.g. split) preserve the source
    // note's created time for the second half so it sorts in the same
    // chronological position as its sibling.
    const created = opts.createdOverride ?? new Date().toISOString();
    const attachments = this.extractAttachments(body);
    // Author stamping. Only stamp when the user has set a name in
    // settings (otherwise leave authorship out so non-multiplayer
    // workflows aren't polluted). The author stub file is created
    // lazily so the wikilink resolves on click.
    const author = this.currentAuthorLink();
    if (author) { void this.ensureAuthorFile(author); }

    const fmLines = [
      "---", `id: ${id}`, `parent: ${parentId}`, `created: ${created}`,
      `modified: ${created}`,
    ];
    if (author) fmLines.push(`author: "${author.link.replace(/"/g, '\\"')}"`);
    if (attachments.length > 0) {
      fmLines.push("attachments:");
      for (const a of attachments) fmLines.push(`  - "${a.replace(/"/g, '\\"')}"`);
    } else {
      fmLines.push("attachments: []");
    }
    // No trailing newline — keeps the file ending tight on the body's last
    // character. (Editors that auto-add a final newline on save will still
    // append one, but freshly-created notes start clean.)
    fmLines.push("---", body);
    try {
      const fullContent = fmLines.join("\n");
      await this.app.vault.create(path, fullContent);
      // Synthetic insert: put the node into the tree immediately, without waiting
      // for metadataCache to parse the new file. On slow drives the cache parse is
      // the dominant lag — this makes the new note appear in the list right away.
      try {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f && (f as any).extension === "md") {
          this.tree.insertSynthetic({
            id, parent: parentId, children: [], file: f as TFile, created,
          });
          this.render();
          // Schedule the redundant parentLink / children fields. The
          // tree is now in its post-create shape, so the queue will
          // see the right state when it drains.
          this.fmSync.scheduleParentChange(id, null, parentId);
          // Layer template frontmatter (color, tags, custom keys). Auto
          // fields (id/parent/created/attachments) are skipped so the
          // values written above always win.
          if (templateFm) {
            try {
              await this.app.fileManager.processFrontMatter(f as TFile, (m: any) => {
                for (const [k, v] of Object.entries(templateFm!)) {
                  if (RESERVED_FRONTMATTER.includes(k)) continue;
                  if (m[k] === undefined) m[k] = v;
                }
              });
            } catch (e) {
              console.warn("[Stashpad] template fm overlay failed", e);
            }
          }
        }
      } catch {}
      // log.append is fire-and-forget — no actual await happens, but we keep `await` for symmetry.
      await this.log.append({ type: "create", id, payload: { path, parent: parentId } });
      if (opts.record !== false) {
        const folder = this.noteFolder;
        const originalBody = body;
        this.plugin.getUndoStack(folder).push({
          label: "Create note",
          undo: async () => {
            const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
            if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
            // Restore the body to the per-folder composer draft.
            this.composerDraft = originalBody;
            void this.saveDraft(originalBody);
            // Clear the "last submitted" marker so this restored draft is offered on reload
            // (otherwise the suggestion-suppression guard treats it as already-sent).
            void this.recordLastSubmitted("");
            if (this.composerInputEl) {
              this.composerInputEl.value = originalBody;
              const end = originalBody.length;
              this.composerInputEl.setSelectionRange(end, end);
              this.composerInputEl.focus();
            }
            this.tree.rebuild(folder);
            this.render();
          },
          redo: async () => {
            if (!(await this.app.vault.adapter.exists(path))) {
              await this.app.vault.create(path, fullContent);
            }
            this.composerDraft = "";
            void this.saveDraft("");
            // Re-record the body as last-submitted so the restore-banner guard kicks back in.
            void this.recordLastSubmitted(originalBody);
            if (this.composerInputEl) this.composerInputEl.value = "";
            this.tree.rebuild(folder);
            this.render();
          },
        });
      }
      return id;
    } catch (e) {
      new Notice(`Stashpad: failed to create note (${(e as Error).message})`);
      return null;
    }
  }

  private extractAttachments(body: string): string[] {
    const out: string[] = [];
    const re = /!\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push(m[1]);
    return out;
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error(`${path} exists and is not a folder`);
    await this.app.vault.createFolder(path);
  }

  private async importAttachment(file: File): Promise<string | null> {
    try {
      const buf = await file.arrayBuffer();
      const folder = `${this.noteFolder}/_attachments`;
      await this.ensureFolder(folder);
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const stamp = Date.now().toString(36);
      const path = `${folder}/${stamp}-${safeName}`;
      await this.app.vault.createBinary(path, buf);
      await this.log.append({ type: "attachment_add", id: ROOT_ID, payload: { path, name: file.name, size: file.size } });
      this.plugin.notifications.show({
        message: `Attached ${file.name}`,
        kind: "success",
        category: "attachment",
        affectedPaths: [path],
        folder: this.noteFolder,
      });
      return `![[${path}]]`;
    } catch (e) {
      new Notice(`Stashpad: attachment failed (${(e as Error).message})`);
      return null;
    }
  }

  // --- Multiplayer / authorship ---

  /** Build the wikilink string Stashpad writes into author/contributors
   *  frontmatter: "[[<noteFolder>/_authors/<safe-name>-<id>|<displayName>]]".
   *  Falls back to null when the user hasn't set an author name (i.e.
   *  they've opted out of stamping). The display alias means readers
   *  see "Jane Doe", not the safe-slug-with-id. */
  private currentAuthorLink(): { link: string; path: string; name: string; id: string } | null {
    const name = (this.plugin.settings.authorName ?? "").trim();
    const id = (this.plugin.settings.authorId ?? "").trim();
    if (!name || !id) return null;
    const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "author";
    const path = `${this.noteFolder}/_authors/${safe}-${id}.md`;
    const link = `[[${path}|${name}]]`;
    return { link, path, name, id };
  }

  /** Lazily create the author stub file under <stashpad>/_authors/.
   *  Idempotent: skips if the file already exists. The stub carries a
   *  small frontmatter with id + display name + created stamp, plus a
   *  level-1 heading so it reads cleanly when opened directly.
   *  Failures are swallowed (we don't want author-stub creation to
   *  block note creation) but logged for diagnosis. */
  private async ensureAuthorFile(info: { path: string; name: string; id: string }): Promise<void> {
    try {
      const folder = `${this.noteFolder}/_authors`;
      await this.ensureFolder(folder);
      if (await this.app.vault.adapter.exists(info.path)) return;
      const created = new Date().toISOString();
      const content = [
        "---",
        `authorId: ${info.id}`,
        `name: "${info.name.replace(/"/g, '\\"')}"`,
        `created: ${created}`,
        "---",
        `# ${info.name}`,
      ].join("\n");
      await this.app.vault.create(info.path, content);
    } catch (e) {
      console.warn("[Stashpad] ensureAuthorFile failed", e);
    }
  }

  /** Render the author / contributors / last-edit footer at the bottom
   *  of a note body. Each piece is independently toggle-gated in
   *  settings. Author + contributors are surfaced as inline wikilinks
   *  (clickable via the existing handleRenderedClick delegation); the
   *  last-edit timestamp is plain text. The whole row is omitted if
   *  every enabled piece has no data — keeps unstamped notes clean. */
  private renderAuthorshipFooter(container: HTMLElement, node: TreeNode): void {
    if (!node.file) return;
    const s = this.plugin.settings;
    if (!s.showAuthor && !s.showContributors && !s.showLastEdit) return;
    const fm = (this.app.metadataCache.getFileCache(node.file)?.frontmatter ?? {}) as Record<string, any>;
    const authorRaw = typeof fm.author === "string" ? fm.author : "";
    const contributorsRaw: string[] = Array.isArray(fm.contributors)
      ? fm.contributors.filter((c: unknown): c is string => typeof c === "string" && c.trim() !== "")
      : [];
    const modifiedRaw = typeof fm.modified === "string" ? fm.modified : (typeof fm.created === "string" ? fm.created : "");

    const showAuthorPart = s.showAuthor && !!authorRaw;
    const showContribPart = s.showContributors && contributorsRaw.length > 0;
    const showEditPart = s.showLastEdit && !!modifiedRaw;
    if (!showAuthorPart && !showContribPart && !showEditPart) return;

    const footer = container.createDiv({ cls: "stashpad-note-authorship" });

    // Render a `[[path|alias]]` (or bare `[[name]]`) wikilink as an
    // anchor that handleRenderedClick will route. We render the alias
    // text (or the basename) so the user reads the human-friendly name.
    const appendLink = (parent: HTMLElement, raw: string): void => {
      // Strip surrounding [[ ]]
      const inner = raw.replace(/^\[\[/, "").replace(/\]\]$/, "");
      const pipe = inner.indexOf("|");
      const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
      const alias = pipe >= 0 ? inner.slice(pipe + 1) : (inner.split("/").pop() ?? inner);
      const a = parent.createEl("a", { cls: "internal-link", text: alias });
      a.setAttribute("data-href", target);
      a.setAttribute("href", target);
    };

    // Build the list of pieces first so we can interleave separators
    // only between actually-rendered pieces (no leading/trailing dots,
    // no double-gap when the middle piece is missing).
    const pieces: Array<(host: HTMLElement) => void> = [];
    if (showAuthorPart) {
      pieces.push((host) => {
        host.createSpan({ cls: "stashpad-authorship-label", text: "by " });
        appendLink(host, authorRaw);
      });
    }
    if (showContribPart) {
      pieces.push((host) => {
        host.createSpan({ cls: "stashpad-authorship-label", text: "with " });
        contributorsRaw.forEach((c, i) => {
          if (i > 0) host.createSpan({ text: ", " });
          appendLink(host, c);
        });
      });
    }
    if (showEditPart) {
      pieces.push((host) => {
        host.createSpan({ cls: "stashpad-authorship-label", text: "edited " });
        host.createSpan({ text: this.formatTimeInline(modifiedRaw) });
      });
    }
    pieces.forEach((emit, i) => {
      if (i > 0) footer.createSpan({ cls: "stashpad-authorship-sep", text: "·" });
      const span = footer.createSpan({ cls: "stashpad-authorship-piece" });
      emit(span);
    });

    // Reuse the existing tag/internal-link delegation so the footer
    // links open in a new tab.
    footer.addEventListener("click", (e) => this.handleRenderedClick(e, node));
  }

  // --- File events ---

  /** Body strings keyed by path. Populated on first sighting of a file
   *  and on every modify; used to distinguish body-edits (a real user
   *  change) from frontmatter-only writes (Stashpad's own
   *  processFrontMatter calls for color, attachments, contributor
   *  bumps, etc.). Only body-edits trigger contributor stamping, so
   *  Stashpad's internal writes don't add the local user as a
   *  contributor on every color change. */
  private knownBodies = new Map<string, string>();
  /** Per-path debouncers for the contributor-stamping pass. We batch
   *  modify events so a continuous edit session ("user types for 30
   *  seconds") produces ONE contribution write at the end, instead of
   *  hammering processFrontMatter on every keystroke. The flush also
   *  no-ops if the body matches what we already saw, so the
   *  contribution write itself doesn't recurse. */
  private contribTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private onFileModify = (file: TFile): void => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith(this.noteFolder + "/")) return;
    this.scheduleSlugRename(file);
    this.scheduleAttachmentSync(file);
    this.scheduleContribution(file);
    // Re-render so any visible row of this file picks up new body
    // content (and re-evaluates the "Show more" overflow check). The
    // metadataCache hook only fires for metadata-affecting edits — pure
    // body changes (e.g. pasting a long block of plain text) wouldn't
    // otherwise trigger a re-render, leaving stale clamp state.
    this.debouncedRender();
  };

  /** Queue (or re-queue) a contributor stamp for `file`, flushing 1.5s
   *  after the most recent modify. Continuous typing keeps pushing the
   *  flush out, so a long edit session writes one contribution at the
   *  end. Quiescence threshold tuned to "slightly longer than the
   *  natural pause between sentences" — short enough to feel timely,
   *  long enough to not stamp mid-thought. */
  private scheduleContribution(file: TFile): void {
    const existing = this.contribTimers.get(file.path);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.contribTimers.delete(file.path);
      void this.maybeRecordContribution(file);
    }, 1500);
    this.contribTimers.set(file.path, t);
  }

  /** Compare the current file body against the last seen body for this
   *  path. If it changed, treat it as a user edit: bump `modified` and
   *  add the local user to `contributors` (unless they're the author
   *  or already in the list). Frontmatter-only writes don't move the
   *  body string, so they're skipped — keeping Stashpad's own
   *  processFrontMatter calls (color tweaks, attachment sync, even
   *  this very contribution write) from spuriously self-stamping. */
  private async maybeRecordContribution(file: TFile): Promise<void> {
    let raw = "";
    try { raw = await this.app.vault.cachedRead(file); } catch { return; }
    const body = this.stripFrontmatter(raw);
    const prev = this.knownBodies.get(file.path);
    this.knownBodies.set(file.path, body);
    if (prev === undefined) return;       // first sighting — no contribution
    if (prev === body) return;            // frontmatter-only write — skip
    const author = this.currentAuthorLink();
    if (!author) return;                  // user opted out of stamping
    void this.ensureAuthorFile(author);
    const now = new Date().toISOString();
    try {
      await this.app.fileManager.processFrontMatter(file, (m: any) => {
        m.modified = now;
        const a = typeof m.author === "string" ? m.author : "";
        const contributors: string[] = Array.isArray(m.contributors)
          ? m.contributors.filter((c: unknown): c is string => typeof c === "string")
          : [];
        const idTag = `-${author.id}`;
        const isAuthor = a.includes(idTag);
        const already = contributors.some((c) => c.includes(idTag));
        if (!isAuthor && !already) contributors.push(author.link);
        m.contributors = contributors;
      });
    } catch (e) {
      console.warn("[Stashpad] maybeRecordContribution failed", e);
    }
  }
  private onFileCreate = (file: TFile): void => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith(this.noteFolder + "/")) return;
    this.debouncedRender();
  };

  /** User-configured stopwords. Always returns the persisted list — empty
   *  is a valid user choice (no stop-words). loadSettings seeds the list
   *  with DEFAULT_STOPWORDS on first run so a fresh install isn't
   *  unexpectedly stop-word-less. */
  private activeStopwords(): string[] {
    return this.plugin.settings.slugStopWords ?? DEFAULT_STOPWORDS;
  }

  private scheduleSlugRename(file: TFile): void {
    let d = this.slugDebouncers.get(file.path);
    if (d) d.cancel();
    d = debounce(() => void this.maybeRenameForSlug(file), 30_000);
    this.slugDebouncers.set(file.path, d);
    d();
  }
  private async maybeRenameForSlug(file: TFile): Promise<void> {
    const id = parseIdFromFilename(file.basename);
    if (!id || id === ROOT_ID) return;
    const raw = await this.app.vault.cachedRead(file);
    const body = this.stripFrontmatter(raw);
    const newSlug = bodyToSlug(body, this.activeStopwords());
    const desired = buildFilename(newSlug, id);
    if (file.name === desired) return;
    const newPath = file.parent ? `${file.parent.path}/${desired}` : desired;
    if (this.app.vault.getAbstractFileByPath(newPath)) return;
    const oldPath = file.path;
    try {
      await this.app.fileManager.renameFile(file, newPath);
      await this.log.append({ type: "rename", id, payload: { from: oldPath, to: newPath } });
    } catch {}
  }

  private scheduleAttachmentSync(file: TFile): void {
    let d = this.attachmentDebouncers.get(file.path);
    if (d) d.cancel();
    d = debounce(() => void this.syncAttachmentsFrontmatter(file), 1500);
    this.attachmentDebouncers.set(file.path, d);
    d();
  }
  private async syncAttachmentsFrontmatter(file: TFile): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    const body = this.stripFrontmatter(raw);
    const found = this.extractAttachments(body);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const current: string[] = Array.isArray(fm?.attachments) ? (fm!.attachments as string[]) : [];
    const same = current.length === found.length && current.every((v, i) => v === found[i]);
    if (same) return;
    await this.app.fileManager.processFrontMatter(file, (front) => { front.attachments = found; });
  }

  // --- Helpers ---

  private stripFrontmatter(md: string): string {
    // Strip BOM if present so the opening-fence detection still works.
    const text = md.replace(/^﻿/, "");
    // Match: optional leading whitespace, "---", newline, anything (lazy),
    // newline, "---", optional trailing whitespace, then either a newline
    // or end-of-string. This covers \r\n line endings, missing trailing
    // newline, and trailing spaces on the closing fence — all of which
    // the previous strict check was missing, causing the YAML to render
    // as note body in the focused header.
    const m = text.match(/^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
    if (!m) return text;
    return text.slice(m[0].length);
  }
  private formatTime(iso: string): string {
    if (!iso) return "";
    const d = (moment as any)(iso);
    if (!d.isValid()) return "";
    const settings = getSettings();
    if (settings.useTemplatesFormat) {
      const fmt = getTemplatesFormats(this.app);
      if (fmt) return `${d.format(fmt.dateFormat)}\n${d.format(fmt.timeFormat)}`;
    }
    return `${d.format("YYYY.MM.DD")}\n${d.format("HH:mm A")}`;
  }
  private formatTimeInline(iso: string): string {
    // Used by Copy / Copy tree when prefixTimestampsOnCopy is on. Includes
    // seconds (display formatTime stops at minutes) so paste targets like
    // logs / chat threads keep ordering even within the same minute.
    if (!iso) return "";
    const d = (moment as any)(iso);
    if (!d.isValid()) return "";
    const settings = getSettings();
    if (settings.useTemplatesFormat) {
      const fmt = getTemplatesFormats(this.app);
      if (fmt) {
        // Inject `:ss` into the user's time format if missing. Tolerates
        // common patterns: HH:mm, h:mm a, HH:mm A, kk:mm.
        const tf = /:ss/.test(fmt.timeFormat)
          ? fmt.timeFormat
          : fmt.timeFormat.replace(/(:mm)/, "$1:ss");
        return `${d.format(fmt.dateFormat)} ${d.format(tf)}`;
      }
    }
    return `${d.format("YYYY.MM.DD")} ${d.format("HH:mm:ss A")}`;
  }
  private scrollListToBottom(): void {
    const list = this.listEl;
    if (!list) return;
    this.stickToListBottom = true;
    list.scrollTop = list.scrollHeight;

    // Per-row ResizeObserver: re-pin to bottom whenever any row's height
    // changes. Catches direct size changes (block re-layout, expand
    // toggles, etc.).
    this.stickyRowObserver?.disconnect();
    const pinOrStop = (): void => {
      if (!this.stickToListBottom) {
        this.stickyRowObserver?.disconnect();
        this.stickyRowObserver = null;
        return;
      }
      list.scrollTop = list.scrollHeight;
    };
    const ro = new ResizeObserver(pinOrStop);
    for (const child of Array.from(list.children)) {
      if (child instanceof HTMLElement) ro.observe(child);
    }
    this.stickyRowObserver = ro;

    // Watchdog rAF poll for 30 seconds. Some scrollHeight changes
    // don't manifest as a ResizeObserver fire on any direct child —
    // image embeds finishing decode inside an attachment rail, async
    // font swap shifting a wrapped line, late MarkdownRenderer flushes
    // — and on Obsidian reload the user reported these landing
    // silently, leaving the last note tucked behind the composer.
    // Polling scrollHeight every frame guarantees we catch any growth.
    // 30s is well past any plausible late paint; the loop is a no-op
    // once user scrolls away (stickToListBottom flips false).
    const startedAt = performance.now();
    let lastH = list.scrollHeight;
    const watchdog = (): void => {
      if (!this.stickToListBottom) return;
      const h = list.scrollHeight;
      if (h !== lastH) {
        list.scrollTop = h;
        lastH = h;
      }
      if (performance.now() - startedAt < 30000) {
        requestAnimationFrame(watchdog);
      } else {
        // Initial paint has long since settled. Releasing the sticky
        // flag here prevents the regression where every subsequent
        // mutation (color change, reparent, move, etc.) bounces the
        // view back to the bottom even though the user had navigated
        // away. Disconnect the row observer too — it'd otherwise
        // remain wired to the now-stale list children, doing nothing
        // useful but holding references.
        this.stickToListBottom = false;
        this.stickyRowObserver?.disconnect();
        this.stickyRowObserver = null;
      }
    };
    requestAnimationFrame(watchdog);
  }

  private openNoteMenu(evt: MouseEvent, node: TreeNode): void {
    if (!node.file) return;
    const file = node.file;
    const menu = new Menu();
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("layout-grid").onClick(() => {
      void this.openInNewStashpadTab(node.id);
    }));
    menu.addItem((it: any) => it.setTitle("Open in editor").setIcon("file-text").onClick(() => {
      void this.openFileAtEnd(file);
    }));
    menu.addItem((it: any) => it.setTitle("Focus in Stashpad").setIcon("arrow-right").onClick(() => this.navigateTo(node.id)));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Split note…").setIcon("split").onClick(() => void this.cmdSplit(node)));
    menu.addItem((it: any) => it.setTitle("Clone (duplicate / copy)").setIcon("files").onClick(() => {
      // Operate on the right-clicked row even if it isn't selected.
      if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
      void this.cmdClone();
    }));
    menu.addItem((it: any) => it.setTitle("Insert template…").setIcon("file-plus-2").onClick(() => this.cmdInsertTemplate()));
    menu.addItem((it: any) => it.setTitle("Export to .stash").setIcon("package").onClick(() => void this.cmdExportStash(node)));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Move to…").setIcon("move").onClick(() => this.cmdMovePicker()));
    menu.addItem((it: any) => it.setTitle("Move to Home").setIcon("home").onClick(async () => { await this.changeParent(node, ROOT_ID); }));
    menu.addItem((it: any) => it.setTitle("Set color…").setIcon("palette").onClick(() => {
      // Operate on the right-clicked row even if it isn't selected.
      if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
      this.cmdSetColor();
    }));
    // 0.58.0: toggle complete — label flips based on current state of the
    // right-clicked node. Operates on the right-clicked row, normalising
    // selection first so cmdToggleComplete picks the right target.
    const isDone = this.isCompleted(node);
    menu.addItem((it: any) => it.setTitle(isDone ? "Mark incomplete" : "Mark complete").setIcon(isDone ? "circle" : "check-circle").onClick(() => {
      if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
      void this.cmdToggleComplete();
    }));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Delete").setIcon("trash").onClick(async () => {
      await this.deleteNote(node);
    }));
    menu.showAtMouseEvent(evt);
  }

  private async deleteNote(node: TreeNode): Promise<void> {
    if (!node.file) return;
    // gather descendants (depth-first, children before parents for safe delete)
    const descendants: TreeNode[] = [];
    const walk = (n: TreeNode): void => {
      for (const c of this.tree.getChildren(n.id)) { walk(c); descendants.push(c); }
    };
    walk(node);
    const all = [...descendants, node];

    // Union body embeds + frontmatter `attachments:` list so a malformed
    // body (missing brackets after some external edit) never silently
    // undercounts. Frontmatter is the system of record everywhere else
    // in the plugin; treating it as authoritative here closes the loop.
    //
    // Parallelize the reads — even cachedRead can be slow on a cold
    // network drive and N serial awaits add up for a deep subtree delete.
    const attNotes = all.filter((n): n is TreeNode & { file: TFile } => !!n.file);
    const rawBodies = await Promise.all(attNotes.map((n) => this.app.vault.cachedRead(n.file)));
    const attachments: string[] = [];
    for (let i = 0; i < attNotes.length; i++) {
      const n = attNotes[i];
      attachments.push(...this.extractAttachments(this.stripFrontmatter(rawBodies[i])));
      const fm = this.app.metadataCache.getFileCache(n.file)?.frontmatter;
      if (Array.isArray(fm?.attachments)) {
        for (const a of fm.attachments) {
          if (typeof a === "string" && a.trim()) attachments.push(a);
        }
      }
    }
    const uniqueAtts = [...new Set(attachments)];

    // Captured BEFORE deletion so cross-author filtering works after files are gone.
    const deletedAuthorIds = this.collectAuthorIds(all);
    const doDelete = async (alsoAtts: boolean) => {
      const snap = await this.snapshotNotes(all, alsoAtts);
      let attsRemoved = 0;
      if (alsoAtts) {
        for (const p of uniqueAtts) {
          const f = this.app.metadataCache.getFirstLinkpathDest(p, "");
          if (f) {
            try {
              await this.app.fileManager.trashFile(f);
              await this.log.append({ type: "attachment_remove", id: ROOT_ID, payload: { path: f.path } });
              // Per-attachment toast so the user has visible confirmation
              // for every external file that disappeared. Routed via
              // plugin.notifications for matching styling + history;
              // kind=warning mirrors the parent delete toast.
              this.plugin.notifications.show({
                message: `Deleted attachment "${f.name}"`,
                kind: "warning",
                category: "attachment",
                affectedPaths: [f.path],
                folder: this.noteFolder,
              });
              attsRemoved += 1;
            } catch {}
          }
        }
      }
      // Capture parents of every deleted note BEFORE we trash them, so
      // the post-delete recovery-fields sync can update those parents'
      // children lists. The deleted notes themselves are gone, so we
      // don't bother with their own fields.
      const orphanedParents = new Set<StashpadId>();
      for (const n of all) if (n.parent) orphanedParents.add(n.parent);
      // 0.56.5: surviving-neighbour selection for the single-delete path.
      // Look forward in currentChildren for the next non-self sibling;
      // fall back to the previous sibling.
      const nodeIdx = this.currentChildren.findIndex((c) => c.id === node.id);
      let neighbourId: StashpadId | null = null;
      if (nodeIdx >= 0) {
        for (let i = nodeIdx + 1; i < this.currentChildren.length; i++) {
          if (this.currentChildren[i].id !== node.id) {
            neighbourId = this.currentChildren[i].id;
            break;
          }
        }
        if (!neighbourId) {
          for (let i = nodeIdx - 1; i >= 0; i--) {
            if (this.currentChildren[i].id !== node.id) {
              neighbourId = this.currentChildren[i].id;
              break;
            }
          }
        }
      }
      for (const n of all) {
        if (!n.file) continue;
        try { await this.app.fileManager.trashFile(n.file); } catch {}
        await this.log.append({ type: "delete", id: n.id, payload: { path: n.file.path, attachmentsRemoved: alsoAtts ? uniqueAtts : [] } });
      }
      this.selection.clear();
      this.cursorIdx = -1;
      if (neighbourId) this.pendingFocusIds = [neighbourId];
      this.tree.rebuild(this.noteFolder);
      this.render({ kind: "follow-cursor" });
      // Now that the tree reflects the deletions, schedule the surviving
      // parents so their children lists drop the trashed entries.
      // Filter out any parent that was itself just deleted.
      for (const pid of orphanedParents) {
        if (all.some((n) => n.id === pid)) continue;
        this.fmSync.scheduleParentOfDeleted(pid);
      }
      const folder = this.noteFolder;
      const label = `Delete "${this.titleForNode(node)}"`;
      const undoFocusId = node.id;
      const attSuffix = attsRemoved > 0
        ? ` with ${attsRemoved} attachment${attsRemoved === 1 ? "" : "s"}`
        : "";
      this.plugin.notifications.show({
        message: `Deleted "${this.titleForNode(node)}"${attSuffix}`,
        kind: "warning",
        category: "delete",
        affectedIds: [node.id],
        affectedAuthorIds: deletedAuthorIds,
        folder: this.noteFolder,
      });
      this.plugin.getUndoStack(folder).push({
        label,
        undo: async () => {
          this.selection.clear();
          this.cursorIdx = -1;
          await this.restoreSnapshots(snap, [undoFocusId]);
        },
        redo: async () => {
          this.selection.clear();
          this.cursorIdx = -1;
          await this.trashNotesAndAttachments(snap);
        },
      });
    };

    // Two independent gates (each backed by its own setting):
    //   - confirmBulkDelete  → prompt when there are descendants
    //   - confirmAttachmentDelete → prompt + offer the "also delete atts"
    //     checkbox when attachments are involved
    // The trivial case (single childless note, no attachments) is always
    // silent. When neither gate triggers, the delete fires silently with
    // attachments preserved (safer default, no checkbox to opt in).
    const settings = getSettings();
    const promptForDescendants = descendants.length > 0 && settings.confirmBulkDelete;
    const promptForAttachments = uniqueAtts.length > 0 && settings.confirmAttachmentDelete;
    if (!promptForDescendants && !promptForAttachments) {
      await doDelete(false);
      this.focusView();
      return;
    }
    new ConfirmDeleteModal(this.app, this.titleForNode(node), descendants.length, uniqueAtts.length, promptForAttachments, async (alsoAtts) => {
      await doDelete(alsoAtts);
      this.focusView();
    }).open();
  }

  private async changeParent(node: TreeNode, newParent: StashpadId, opts: { record?: boolean; quiet?: boolean } = { record: true }): Promise<void> {
    if (!node.file) return;
    const file = node.file;
    const oldParent = node.parent;
    // 0.58.2: surface a warning when a move is a no-op so the user knows
    // their action was understood and intentionally refused (not just
    // ignored). null parent and ROOT_ID both mean "home" — normalise so
    // "Move to Home" on a note already at home fires the warning.
    const norm = (p: StashpadId | null): StashpadId => (p == null ? ROOT_ID : p);
    if (norm(oldParent) === norm(newParent)) {
      if (!opts.quiet) {
        const title = this.titleForNode(node);
        const dest = newParent === ROOT_ID ? "Home" : `"${this.titleForNode(this.tree.get(newParent) ?? node)}"`;
        this.plugin.notifications.show({
          message: `"${title}" is already under ${dest}.`,
          kind: "info",
          category: "move",
          affectedIds: [node.id],
          folder: this.noteFolder,
        });
      }
      return;
    }
    if (newParent === node.id) {
      if (!opts.quiet) {
        this.plugin.notifications.show({
          message: `Can't move "${this.titleForNode(node)}" into itself.`,
          kind: "warning",
          category: "move",
          affectedIds: [node.id],
          folder: this.noteFolder,
        });
      }
      return;
    }
    const movedAuthorIds = this.collectAuthorIds([node]);
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.parent = newParent; });
    // Background-sync the moved note + both parents' redundant fields.
    this.fmSync.scheduleParentChange(node.id, oldParent, newParent);
    await this.log.append({ type: "parent_change", id: node.id, payload: { from: oldParent, to: newParent } });
    // Cursor follows the moved note. Selection stays on it as well.
    this.pendingFocusIds = [node.id];
    if (this.focusId !== newParent && this.focusId !== oldParent) {
      this.selection.clear();
      this.cursorIdx = -1;
    } else if (this.focusId === oldParent) {
      // Source moved out of the current view; clear cursor/selection.
      this.selection.clear();
      this.cursorIdx = -1;
      this.pendingFocusIds = null;
    }
    if (!opts.quiet) {
      const dest = this.tree.get(newParent);
      const destTitle = dest ? this.titleForNode(dest) : "(root)";
      this.plugin.notifications.show({
        message: `Reparented "${this.titleForNode(node)}" → "${destTitle}"`,
        kind: "success",
        category: "move",
        affectedIds: [node.id],
        affectedAuthorIds: movedAuthorIds,
        folder: this.noteFolder,
        actions: newParent === ROOT_ID ? [] : [{
          label: `Jump to "${destTitle}"`,
          onClick: () => this.navigateTo(newParent),
        }],
      });
    }
    if (opts.record !== false) {
      const folder = this.noteFolder;
      const filePath = file.path;
      const movedId = node.id;
      this.plugin.getUndoStack(folder).push({
        label: "Move note",
        undo: async () => {
          const f = this.app.vault.getAbstractFileByPath(filePath) as TFile | null;
          if (!f) return;
          await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = oldParent; });
          this.pendingFocusIds = [movedId];
          if (this.focusId !== oldParent && this.focusId !== newParent) {
            this.selection.clear();
            this.cursorIdx = -1;
          } else if (this.focusId === newParent) {
            this.selection.clear();
            this.cursorIdx = -1;
            this.pendingFocusIds = null;
          }
          this.tree.rebuild(folder);
          // 0.56.8: follow-cursor so the un-nested note scrolls back into
          // view, and a delayed re-apply covers the metadataCache race.
          this.render({ kind: "follow-cursor" });
          {
            const guardKey = this.selectionGuardKey;
            const tryReselect = () => {
              if (this.selectionGuardKey !== guardKey) return;
              if (this.selection.has(movedId)) return;
              const idx = this.currentChildren.findIndex((n) => n.id === movedId);
              if (idx < 0) return;
              this.selection.add(movedId);
              this.cursorIdx = idx;
              this.render({ kind: "follow-cursor" });
            };
            setTimeout(tryReselect, 120);
            setTimeout(tryReselect, 400);
          }
        },
        redo: async () => {
          const f = this.app.vault.getAbstractFileByPath(filePath) as TFile | null;
          if (!f) return;
          await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = newParent; });
          this.pendingFocusIds = [movedId];
          if (this.focusId !== newParent && this.focusId !== oldParent) {
            this.selection.clear();
            this.cursorIdx = -1;
          } else if (this.focusId === oldParent) {
            this.selection.clear();
            this.cursorIdx = -1;
            this.pendingFocusIds = null;
          }
          this.tree.rebuild(folder);
          this.render({ kind: "follow-cursor" });
          {
            const guardKey = this.selectionGuardKey;
            const tryReselect = () => {
              if (this.selectionGuardKey !== guardKey) return;
              if (this.selection.has(movedId)) return;
              const idx = this.currentChildren.findIndex((n) => n.id === movedId);
              if (idx < 0) return;
              this.selection.add(movedId);
              this.cursorIdx = idx;
              this.render({ kind: "follow-cursor" });
            };
            setTimeout(tryReselect, 120);
            setTimeout(tryReselect, 400);
          }
        },
      });
    }
  }
}

function matchKey(e: KeyboardEvent, key: string): boolean {
  if (!key) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/** Try a chord regardless of whether it's a single key or a Mod combo. */
function matchChord(e: KeyboardEvent, chord: string): boolean {
  if (!chord) return false;
  if (chord.includes("+")) return matchMod(e, chord);
  return matchKey(e, chord);
}

/** Match a CommandBinding against the event, honoring preferRight when both
 *  primary and secondary are set. */
export function matchBinding(e: KeyboardEvent, b?: { primary: string; secondary: string; preferRight: boolean }): boolean {
  if (!b) return false;
  const { primary, secondary, preferRight } = b;
  if (primary && secondary) {
    return preferRight ? matchChord(e, secondary) : matchChord(e, primary);
  }
  return matchChord(e, primary) || matchChord(e, secondary);
}

function humanCombo(combo: string): string {
  if (!combo) return "";
  const isMac = (Platform as any).isMacOS ?? (navigator.platform.toLowerCase().includes("mac"));
  return combo
    .split("+")
    .map((p) => {
      const s = p.trim();
      if (!s) return "";
      if (s.toLowerCase() === "mod") return isMac ? "Cmd" : "Ctrl";
      if (s.toLowerCase() === "alt") return isMac ? "Opt" : "Alt";
      return s.length === 1 ? s.toUpperCase() : s;
    })
    .filter(Boolean)
    .join("+");
}

function matchMod(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const keyPart = parts[parts.length - 1].toLowerCase();
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const wantMod = mods.has("mod");
  const wantCtrl = mods.has("ctrl") || mods.has("control");
  const wantCmd = mods.has("cmd") || mods.has("meta") || mods.has("command");
  const wantAlt = mods.has("alt") || mods.has("option");
  const wantShift = mods.has("shift");
  const isMac = (Platform as any).isMacOS ?? (navigator.platform.toLowerCase().includes("mac"));
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  if (wantMod && !modPressed) return false;
  if (wantCtrl && !e.ctrlKey) return false;
  if (wantCmd && !e.metaKey) return false;
  if (wantAlt !== e.altKey) return false;
  if (wantShift !== e.shiftKey) return false;
  if (!wantMod) {
    if (!wantCtrl && e.ctrlKey) return false;
    if (!wantCmd && e.metaKey) return false;
  }
  return e.key.toLowerCase() === keyPart;
}

/** Capitalize the first letter of every space-separated word inside each "/"-separated
 *  segment, but never lowercase already-capitalized characters. So:
 *    "my health stuff/2026 notes" → "My Health Stuff/2026 Notes"
 *    "HealthMD/work-stuff"        → "HealthMD/Work-stuff"
 *    "BIG"                        → "BIG"
 */
function properCaseFolderPath(path: string): string {
  return path
    .split("/")
    .map((seg) => seg.split(" ").map((w) => (w && /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" "))
    .join("/");
}

/** Compute a new child-order array for a parent, given the current order and
 *  the ids being moved (assumed contiguous-as-a-block in the result). */
function computeReorder(all: string[], targetIds: string[], dir: "up" | "down" | "top" | "bottom"): string[] {
  const targetSet = new Set(targetIds);
  const others = all.filter((id) => !targetSet.has(id));
  // Anchor: where the block currently sits (first target's index).
  const firstIdx = all.findIndex((id) => targetSet.has(id));
  if (firstIdx < 0) return all.slice();

  switch (dir) {
    case "top":
      return [...targetIds, ...others];
    case "bottom":
      return [...others, ...targetIds];
    case "up": {
      // Insert the block one position earlier than the first target's current index.
      const insertAt = Math.max(0, firstIdx - 1);
      const result = others.slice();
      result.splice(insertAt, 0, ...targetIds);
      return result;
    }
    case "down": {
      // Move past one non-target. lastIdx + 2 in the original space → new index in `others`.
      const lastIdx = (() => { let i = -1; all.forEach((id, k) => { if (targetSet.has(id)) i = k; }); return i; })();
      // Count non-targets before the position we want to land at (lastIdx + 2 in original space).
      let othersBefore = 0;
      for (let i = 0; i < Math.min(all.length, lastIdx + 2); i++) {
        if (!targetSet.has(all[i])) othersBefore++;
      }
      const insertAt = Math.min(others.length, othersBefore);
      const result = others.slice();
      result.splice(insertAt, 0, ...targetIds);
      return result;
    }
  }
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
