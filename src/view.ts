import {
  App, ItemView, MarkdownRenderer, Menu, Notice, Platform,
  Scope, SuggestModal, TFile, TFolder, WorkspaceLeaf, debounce,
  moment, setIcon,
} from "obsidian";
import {
  ROOT_ID, STASHPAD_VIEW_TYPE, RESERVED_FRONTMATTER, fmHasTag, fmAddTag, fmRemoveTag, parseAssignees, parseAuthorRef, attachmentLinkPath, toAttachmentLink,
  type StashpadId, type TimeFilter, type TreeNode, type ViewConfigState, type ViewMode, type ScrollPolicy,
} from "./types";
import { TreeIndex } from "./tree-index";
import { perf } from "./perf";
import { formatDateTime } from "./format";
import { OrderStore } from "./order-store";
import { SortStore, SORT_MODE_LABELS, SORT_MODES_ORDER } from "./sort-store";
import { FrontmatterSyncQueue, rebootstrapFolderFrontmatter } from "./frontmatter-sync";
import { buildFileActions } from "./notifications";
import { newId } from "./id-service";
import { bodyToSlug, buildFilename, parseIdFromFilename, DEFAULT_STOPWORDS } from "./slug-service";
import { StashpadLog } from "./log";
import { IntegrityWatcher } from "./integrity-watcher";
import { getSettings, getTemplatesFormats, onSettingsChange } from "./settings";
import { StashpadSuggest } from "./note-picker";
import { StashpadCommandPalette } from "./command-palette";
import { setActiveView, clearActiveView } from "./active-view";
import { AssignModal, ColorPickerModal, ConfirmDeleteModal, ConfirmModal, DueDatePickerModal, SplitNoteModal } from "./modals";
import { ComposerAutocomplete } from "./composer-autocomplete";
import { matchBinding, humanCombo } from "./view-keys";
import { AuthorshipTracker } from "./authorship-tracker";
import { ViewDnD } from "./view-dnd";
import { NoteBodyRenderer } from "./note-body-renderer";
import { computeSortedIds } from "./view-sort";
import * as clipboardCmds from "./commands/clipboard-cmds";
import * as ioCmds from "./commands/io-cmds";
import { setIconSafe, isAnyModalOpen, properCaseFolderPath, computeReorder, arraysEqual } from "./view-helpers";
import type StashpadPlugin from "./main";

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  nested: "Nested",
  flat: "Flat",
  everything: "Everything",
};

/** Labels for each time-filter mode, plus a per-mode short label and
 *  long-form description used as the button's tooltip. The displayed
 *  short label switches between calendar mode (Today/Week/…) and rolling
 *  mode (24h/7d/30d/365d/∞) based on the active filterCalendar flag. */
/** Per-tab navigation history snapshot — folder + focus, the two
 *  axes the user can navigate along. Used by the back/forward stacks
 *  in 0.67.0. */
interface NavSnapshot {
  folder: string;
  focusId: StashpadId;
}

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
  /** public: read by AuthorshipTracker (the host interface). */
  plugin: StashpadPlugin;
  private viewRoot!: HTMLElement;

  /** Owns authorship/contribution stamping + multiplayer write tracking. */
  authorship: AuthorshipTracker;

  /** Owns the drag-and-drop row interaction (drag state + drop placeholder). */
  dnd: ViewDnD;

  /** public: read by AuthorshipTracker (the host interface). */
  tree: TreeIndex;
  /** public: used by extracted command modules (commands/*.ts). */
  log: StashpadLog;
  private integrity: IntegrityWatcher;
  private order: OrderStore;
  private sortStore: SortStore;
  /** Background queue that writes redundant `parentLink` + `children`
   *  fields to frontmatter. Fire-and-forget — callers don't await. See
   *  FrontmatterSyncQueue jsdoc for the why. */
  private fmSync: FrontmatterSyncQueue;

  /** public: read by extracted command modules (commands/*.ts). */
  focusId: StashpadId = ROOT_ID;
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
  /** 0.88.1: when true, show only notes that came in via import
   *  (frontmatter `imported: true`). Per-session, like tag/color. */
  private importedOnly = false;
  /** 0.88.1: when set, show only notes whose author id matches. Per-session. */
  private authorFilter: string | null = null;
  /** public: read by AuthorshipTracker (the host interface). */
  noteFolder = "Stashpad";
  private folderOverride: string | null = null;
  /** 0.61.1: tiny-mode flag — when true the view renders a minimal
   *  shell (folder name + list + composer + sticky/expand controls)
   *  and the leaf's BrowserWindow gets shrunk + optionally pinned
   *  always-on-top. Persisted via view state so a tiny-mode tab
   *  survives reloads. */
  private tinyMode = false;
  private tinyAlwaysOnTop = false;
  /** 0.77.0-feat: tiny-mode popout window opacity (0.3–1.0). Electron
   *  `BrowserWindow.setOpacity` — desktop popouts only; a no-op on
   *  mobile / non-popout. Persisted via view state. 1 = fully opaque. */
  private tinyOpacity = 1;
  /** 0.61.2: compact mode — like tiny mode but stays in the current
   *  tab/leaf (no popout, no resize). Hides the time filter row and
   *  focused-header; keeps breadcrumb + list + composer. Persisted. */
  private compactMode = false;
  private detachTreeHook: (() => void) | null = null;
  private detachSettings: (() => void) | null = null;
  private slugDebouncers = new Map<string, ReturnType<typeof debounce>>();
  private attachmentDebouncers = new Map<string, ReturnType<typeof debounce>>();
  /** public: called by AuthorshipTracker (the host interface). */
  debouncedRender: ReturnType<typeof debounce>;
  private bootstrappedFolders = new Set<string>();

  /** public: read by ViewDnD (the host interface). */
  selection = new Set<StashpadId>();
  private lastSelected: StashpadId | null = null;
  /** public: read by extracted command modules (commands/*.ts). */
  cursorIdx = -1;
  /** 0.98.6: after an async restore (e.g. decrypt → importStashZip → tree
   *  rebuild), cursor + select this id once it appears in the list. Cleared when
   *  applied. Survives the intermediate render where the note isn't in the tree yet. */
  private pendingCursorId: StashpadId | null = null;
  /** public: read by extracted command modules (commands/*.ts). */
  currentChildren: TreeNode[] = [];
  private modeSplit: boolean | null = null;
  private modeEnterSubmits = true; // per-view, defaults true
  private nextDestination: StashpadId | null = null;
  /** 0.76.15: when the chosen destination lives in ANOTHER Stashpad
   *  folder, this holds that folder (and a display label). The next
   *  composer submit creates the note THERE, remotely, without
   *  switching this view away from where you are — the whole point of
   *  "ship it off while stationary." Null = destination is in the
   *  current folder. */
  private nextDestinationFolder: string | null = null;
  private nextDestinationLabel: string | null = null;
  private inListPicker: { activeIdx: number } | null = null;
  /** 0.91.2: timestamp of the last Escape that cancelled the in-list picker.
   *  The picker-cancel and the multi-selection "collapse to one" live in TWO
   *  different Escape handlers (the keymap Scope handler + the document keydown
   *  handler) and their firing order isn't guaranteed — whichever runs first
   *  nulls `inListPicker`, so the other can't tell the picker was active and
   *  wrongly collapses the selection. Stamping this lets the collapse paths
   *  skip when a picker-cancel just happened (within ~350ms). */
  private pickerEscapeAt = 0;
  /** 0.92.3: timestamp of the Escape that just blurred the composer back to the
   *  list. A single Escape to exit the composer already keeps the selection
   *  (composerScope preempts the collapse), but a SECOND quick Escape — the
   *  common "I hit space by accident, mash Escape to get out" fumble — would
   *  hit the list-level collapse and drop the multi-selection to one. Within
   *  this grace window the collapse is skipped so the selection survives the
   *  round-trip; a deliberate, later Escape still deselects as before. */
  private composerExitAt = 0;
  /** public: read by ViewDnD (the host interface). */
  listEl: HTMLElement | null = null;
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
  /** 0.76.27: timestamp until which the listResizeObserver ignores
   *  scroll adjustments. Set on mobile composer focus/blur — the
   *  keyboard show/hide resizes the list, which otherwise fired the
   *  observer and yanked the scroll position each time (the list
   *  "moving" on every composer interaction). During this window we
   *  let the browser's own reflow settle without fighting it. */
  private keyboardTransitionUntil = 0;
  /** Per-row ResizeObserver attached during scrollListToBottom — re-pins
   *  the list to the bottom whenever a row's height changes. Survives
   *  past the initial paint so cold-cache markdown / late font loads
   *  don't leave the last note tucked behind the composer. Disconnected
   *  on user scroll-up (via stickToListBottom flipping false) or on view
   *  teardown. */
  private stickyRowObserver: ResizeObserver | null = null;
  private listResizeObserver: ResizeObserver | null = null;
  /** 0.61.4: observes the composer's width so the secondary-button
   *  rail can collapse behind a chevron when the composer is narrow
   *  (compact mode, tiny window, narrow split). */
  private composerNarrowObserver: ResizeObserver | null = null;
  /** Per-focus "last cursor note id" — persisted via plugin.saveLastCursor.
   *  Read on view open / folder switch; restored via the `scroll-to-id`
   *  policy so the user lands looking at the same note they were on, even
   *  when row heights shift between sessions. 0.56.14. */
  private lastCursorByFocus = new Map<StashpadId, StashpadId>();
  /** Per-focus persisted MULTI-SELECTION (via plugin.saveLastSelection).
   *  Read on view open / folder switch; folded into pendingFocusIds so a
   *  reload restores the same notes selected — even when the tab was deferred
   *  (lazy-loaded) on reload. 0.91.0. */
  private lastSelectionByFocus = new Map<StashpadId, StashpadId[]>();
  private expandedNotes = new Set<StashpadId>();
  private focusComposerOnNextRender = false;
  /** 0.76.21: timestamp until which the activation auto-focus
   *  (focusComposer) is suppressed. Set after actions that close a
   *  modal and re-activate the leaf (e.g. Split) — the leaf
   *  re-activation otherwise yanks focus into the composer regardless
   *  of the autofocus-after-send setting. */
  private suppressComposerFocusUntil = 0;
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
  /** 0.67.0: per-tab navigation history. Each entry is a snapshot of
   *  `{folder, focusId}` so going back restores the previous folder
   *  AND its focus, not just the previous note within the same
   *  folder. Browser-style: every recordable nav mutation pushes the
   *  PRE-change state onto navBack; navigateBack pops from there and
   *  pushes onto navForward; navigateForward does the reverse. New
   *  navigation (when not going via back/forward) clears the forward
   *  stack. */
  private navBackStack: NavSnapshot[] = [];
  private navForwardSnapshots: NavSnapshot[] = [];

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
      return computeSortedIds(this, parentId, mode);
    });
    this.debouncedRender = debounce(() => this.render(), 80);
    this.authorship = new AuthorshipTracker(this);
    this.dnd = new ViewDnD(this);
    // 0.83.2: back the body render cache with the plugin's persisted store
    // so rendered bodies survive reloads (cold open reads one cache file,
    // not N bodies over a slow drive).
    this.bodyRenderer = new NoteBodyRenderer(this, this, this.plugin.renderCacheStore);
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
        // Append the note id so two tabs on notes with the SAME title (or same
        // folder) stay distinguishable in the tab bar — and the title is unique
        // enough to tell duplicates apart at a glance. 0.99.3.
        if (truncated) return `${name} — ${truncated} · ${this.focusId}`;
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
    // 0.77.12: periodically bound the multiplayer-tracking maps so a
    // long-lived session doesn't accumulate dead per-file entries.
    // registerInterval auto-clears on view unload.
    this.registerInterval(window.setInterval(() => this.authorship.pruneContribMaps(), 60_000));

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
        // 0.91.1: when the in-list parent picker is active, Escape CANCELS the
        // picker without touching the selection. This Scope handler is what
        // real Escape keypresses hit (it preempts the document keydown
        // handler's picker-cancel branch), so without this guard pressing O
        // then Escape would fall through to the collapse-below and drop every
        // selected note but one — the exact repro the user reported.
        if (this.inListPicker) {
          this.inListPicker = null;
          this.pickerEscapeAt = Date.now();
          this.repaintSelectionClasses(); // clears the pick-target highlight
          return false;
        }
        // If the OTHER Escape handler just cancelled the picker (it nulled
        // inListPicker before we ran), don't treat this same keypress as a
        // selection-collapse. 0.91.2.
        if (Date.now() - this.pickerEscapeAt < 350) return false;
        // 0.92.3: just Escaped out of the composer — keep the selection through
        // the round-trip (a fumbled double-Escape shouldn't deselect).
        if (Date.now() - this.composerExitAt < 400) return false;
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
    // 0.76.30: self-heal stale trees after a sync burst / cold start.
    // The per-file create/changed hooks above can miss files that
    // sync in before the view's listeners attach (mobile cold start)
    // or land in a burst — leaving the folder showing fewer notes
    // (or a stale layout) until a manual reload. metadataCache
    // "resolved" fires when Obsidian finishes (re)indexing, which is
    // exactly when synced-in files become known; reconcile then. The
    // reconcile only rebuilds + renders when this folder's markdown
    // file count actually differs from the tree, so it's a no-op
    // during normal editing.
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleTreeReconcile()));
    // 0.76.11: keep the authoritative completed-state map in sync with
    // the metadataCache. A "changed" event means the cache is fresh
    // for that file, so re-sync our cached value from it. This is what
    // lets isCompleted read a STABLE value during the synthetic
    // create-render (when getFileCache can transiently return stale
    // frontmatter for sibling rows) — fixes "adding a note strips the
    // completed styling off a previously-completed item."
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.extension !== "md") return;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
      this.completedState.set(file.path, !!fm?.completed);
      // 0.85.1: resync the task-ness override too, now that the cache is fresh.
      this.taskTaggedState.set(file.path, this.taggedFromFm(fm));
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      for (const map of [this.completedState, this.taskTaggedState]) {
        if (map.has(oldPath)) { map.set(file.path, map.get(oldPath)!); map.delete(oldPath); }
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.completedState.delete(file.path);
      this.taskTaggedState.delete(file.path);
      // Refresh the list when a note in THIS folder is deleted on the filesystem
      // (sync client, another device, OS-level delete) — the map cleanup above
      // doesn't redraw, and the metadataCache "resolved" reconcile can lag or not
      // fire for a lone delete. Scoped to this folder; rebuild is cheap + render
      // is debounced, so it's a no-op for unrelated deletes.
      const slash = file.path.lastIndexOf("/");
      const dir = (slash >= 0 ? file.path.slice(0, slash) : "").replace(/\/+$/, "");
      if (file.path.endsWith(".md") && dir === this.noteFolder.replace(/\/+$/, "")) {
        this.tree.rebuild(this.noteFolder);
        this.debouncedRender();
      }
    }));
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
    // 0.71.36: bootstrap can throw "Folder already exists" when the
    // vault state races our cache check on tab open/close. Swallow
    // that specific case so the wrap doesn't surface as Obsidian's
    // "Failed to open view" — bootstrap is idempotent on next mount.
    try { await this.bootstrapFolder(); } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (!/already exists/i.test(msg)) console.warn("[Stashpad] bootstrapFolder failed:", e);
    }
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
      // 0.91.0: hydrate the persisted multi-selection alongside the cursor.
      this.lastSelectionByFocus = this.plugin.loadLastSelection(this.noteFolder);
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
    // 0.91.0: restore a persisted multi-selection (app reload / workspace
    // restore). Obsidian may call onOpen BEFORE setState, in which case
    // restoredSelectionIds isn't populated yet and this no-ops — setState's
    // own render path runs the same fold. Whichever fires with the field set
    // wins; the helper consumes it so it only applies once.
    const restoredSel = this.foldRestoredSelection(savedCursorId);
    if (restoredSel) this.pendingFocusIds = restoredSel;
    this.render(initialPolicy);
    // 0.91.1: re-assert the selection after post-mount reconcile renders settle.
    this.scheduleSelectionRestore();
    // 0.61.7: defer the tiny resize to ~1s after launch. Obsidian's own
    // popout init grabs the BrowserWindow size during the first frames,
    // and racing it with rAF/150ms/600ms calls only sometimes won. Let
    // the popout settle at its default size, THEN shrink. A second
    // pass at 1500ms catches the edge case where the first resize is
    // still clamped.
    if (this.tinyMode) {
      setTimeout(() => this.applyTinyWindow(), 1000);
      setTimeout(() => this.applyTinyWindow(), 1500);
    }
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

  /** 0.76.30: debounced reconcile against the metadata cache. Counts
   *  the markdown files actually under this folder and, if that count
   *  differs from what the tree knows, rebuilds + re-renders — so a
   *  folder that mounted with a stale/partial tree (mobile cold start,
   *  post-sync burst) self-heals without a manual reload. No-op when
   *  the counts already match. */
  private treeReconcileTimer: number | null = null;
  private scheduleTreeReconcile(): void {
    if (this.treeReconcileTimer != null) return;
    this.treeReconcileTimer = window.setTimeout(() => {
      this.treeReconcileTimer = null;
      if (!this.viewRoot?.isConnected) return;
      const folder = this.noteFolder;
      const prefix = folder + "/";
      // Count actual Stashpad NOTES on disk (markdown files under this
      // folder whose frontmatter carries an id) — matching what the
      // tree tracks. Counting all markdown would over-count _authors
      // stubs / templates and trigger perpetual no-op rebuilds.
      let onDisk = 0;
      for (const f of this.app.vault.getMarkdownFiles()) {
        const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
        if (!(dir === folder || (folder !== "" && dir.startsWith(prefix)))) continue;
        const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
        if (typeof id === "string" && id) onDisk++;
      }
      if (onDisk === this.tree.fileBackedCount()) return; // in sync — no-op
      this.tree.rebuild(folder);
      this.debouncedRender();
    }, 400);
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
    // 0.76.24: honour the autofocus setting. This activation auto-focus
    // previously ignored it, so the composer kept grabbing focus on
    // view open / leaf re-activation even with the setting OFF. When
    // off, the user clicks the composer to type. (Focus PRESERVATION
    // across renders — focusComposerOnNextRender — is separate and
    // still works: it only re-focuses when the composer already had
    // focus.)
    if (!getSettings().autofocusComposerAfterSend) return;
    const tryFocus = () => {
      if (!this.viewRoot?.isConnected) return;
      // 0.76.21: skip the activation auto-focus during the suppression
      // window (set right after a Split etc. so the modal-close leaf
      // re-activation doesn't steal focus into the composer).
      if (Date.now() < this.suppressComposerFocusUntil) return;
      // 0.86.6: plugin-wide suppression — the folder panel sets this before
      // revealing a leaf so tapping a pinned note doesn't pop the keyboard.
      if (Date.now() < this.plugin.suppressComposerAutofocusUntil) return;
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
    this.bodyRenderer.dispose();
    this.composerNarrowObserver?.disconnect();
    this.composerNarrowObserver = null;
    this.focusedMiniObserver?.disconnect();
    this.focusedMiniObserver = null;
    if (this.treeReconcileTimer != null) { window.clearTimeout(this.treeReconcileTimer); this.treeReconcileTimer = null; }
    this.composerAutocomplete?.detach();
    this.composerAutocomplete = null;
    for (const d of this.slugDebouncers.values()) d.cancel();
    for (const d of this.attachmentDebouncers.values()) d.cancel();
    // 0.77.12: cancel pending stamps + release the per-file multiplayer-
    // tracking maps so they don't outlive the view (knownBodies in
    // particular holds full body strings). They rebuild lazily on the next
    // modify event.
    this.authorship.dispose();
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
    this.stampSelectedCursor(true); // 0.91.1: also persists the selection (piggybacked)
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
      tinyMode: this.tinyMode,
      tinyAlwaysOnTop: this.tinyAlwaysOnTop,
      tinyOpacity: this.tinyOpacity,
      compactMode: this.compactMode,
      // 0.67.2: persist nav stacks so reloads keep the back/forward
      // history. Without this every reload starts the user with empty
      // stacks → the back arrow has nowhere to go.
      navBackStack: this.navBackStack,
      navForwardSnapshots: this.navForwardSnapshots,
    };
  }
  async setState(state: unknown, result: any): Promise<void> {
    const s = (state as (Partial<ViewConfigState> & {
      folderOverride?: string | null;
      tagFilter?: string | null;
      colorFilter?: string | null;
      timeFilterCalendar?: boolean;
      tinyMode?: boolean;
      tinyAlwaysOnTop?: boolean;
      tinyOpacity?: number;
      compactMode?: boolean;
      navBackStack?: NavSnapshot[];
      navForwardSnapshots?: NavSnapshot[];
    }) | null) ?? null;
    if (s) {
      if ("folderOverride" in s) this.folderOverride = s.folderOverride ?? null;
      if (s.timeFilter) this.timeFilter = s.timeFilter;
      if (s.focusId) this.focusId = s.focusId;
      if ("tagFilter" in s) this.tagFilter = s.tagFilter ?? null;
      if ("colorFilter" in s) this.colorFilter = s.colorFilter ?? null;
      if ("timeFilterCalendar" in s) this.timeFilterCalendar = !!s.timeFilterCalendar;
      if ("tinyMode" in s) this.tinyMode = !!s.tinyMode;
      if ("tinyAlwaysOnTop" in s) this.tinyAlwaysOnTop = !!s.tinyAlwaysOnTop;
      if (typeof s.tinyOpacity === "number" && Number.isFinite(s.tinyOpacity)) {
        this.tinyOpacity = Math.min(1, Math.max(0.3, s.tinyOpacity));
      }
      if ("compactMode" in s) this.compactMode = !!s.compactMode;
      // 0.67.2: restore nav stacks from view state. Validate the
      // shape so a malformed entry doesn't crash navigation later.
      const isSnap = (x: any): x is NavSnapshot =>
        x && typeof x.folder === "string" && typeof x.focusId === "string";
      if (Array.isArray(s.navBackStack)) {
        this.navBackStack = s.navBackStack.filter(isSnap);
      }
      if (Array.isArray(s.navForwardSnapshots)) {
        this.navForwardSnapshots = s.navForwardSnapshots.filter(isSnap);
      }
    }
    // Resolve noteFolder immediately so getDisplayText() reflects the right folder
    // even before onOpen() has run (Obsidian queries it during view restore).
    const settingsFolder = (this.plugin?.settings?.folder ?? "Stashpad").trim().replace(/^\/+|\/+$/g, "");
    const overrideFolder = this.folderOverride?.trim().replace(/^\/+|\/+$/g, "") || null;
    this.noteFolder = overrideFolder || settingsFolder || "Stashpad";
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
      this.lastSelectionByFocus.clear();
      try {
        const loaded = this.plugin.loadLastCursor(this.noteFolder);
        for (const [focusId, noteId] of loaded) this.lastCursorByFocus.set(focusId, noteId);
        // 0.91.0: re-hydrate the persisted multi-selection for the new folder.
        this.lastSelectionByFocus = this.plugin.loadLastSelection(this.noteFolder);
      } catch {}
      const savedCursorId = this.lastCursorByFocus.get(this.focusId);
      let policy: ScrollPolicy;
      if (savedCursorId && this.tree.get(savedCursorId)) {
        this.pendingFocusIds = [savedCursorId];
        policy = { kind: "scroll-to-id", id: savedCursorId, align: "start" };
      } else {
        policy = { kind: "pin-bottom", until: "next-user-input" };
      }
      // 0.91.0: fold in a persisted multi-selection (overrides the single-id
      // cursor restore above). This is the path that actually runs on a normal
      // app reload, since Obsidian calls setState after onOpen.
      const restoredSel = this.foldRestoredSelection(savedCursorId);
      if (restoredSel) this.pendingFocusIds = restoredSel;
      this.render(policy);
      // 0.91.1: re-assert the selection after post-mount reconcile renders.
      this.scheduleSelectionRestore();
    }
  }
  focus(): void { this.viewRoot?.focus({ preventScroll: true }); }

  /** 0.91.0: fold a persisted multi-selection (from setState) into the list to
   *  hand render()'s pendingFocusIds path. Orders the saved cursor note first
   *  so the cursor lands where it left off; validates every id against the
   *  rebuilt tree (render's loop further prunes to children of the focus, so
   *  off-screen ids drop cleanly). Consumes `restoredSelectionIds` so it only
   *  applies once across the onOpen / setState restore races. Returns null when
   *  there's nothing to restore (leave pendingFocusIds untouched). */
  private foldRestoredSelection(savedCursorId: StashpadId | null | undefined): StashpadId[] | null {
    // Source from localStorage only (stamped on EVERY selection change, so
    // always fresh). The view-state `selectedIds` path was removed in 0.91.2:
    // selection changes don't trigger a workspace-layout save, so getState()
    // captured a STALE selection and restored the wrong notes — then a
    // post-restore stamp overwrote the good localStorage value with it.
    const ids = this.lastSelectionByFocus.get(this.focusId) ?? null;
    if (!ids || !ids.length) return null;
    const valid = ids.filter((id) => !!this.tree.get(id));
    if (!valid.length) return null;
    return savedCursorId && valid.includes(savedCursorId)
      ? [savedCursorId, ...valid.filter((id) => id !== savedCursorId)]
      : valid;
  }

  /** 0.91.0: persist the current multi-selection to localStorage for this
   *  (folder, focus) so a reload restores it. `eager` flushes synchronously
   *  (beforeunload/blur/onClose); otherwise it debounces like the cursor stamp.
   *  An empty selection clears the stored entry. */
  private stampSelection(eager = false): void {
    const ids = [...this.selection];
    const flush = (): void => {
      try { this.plugin.saveLastSelection(this.noteFolder, this.focusId, ids); }
      catch { /* localStorage unavailable — non-fatal */ }
    };
    if (this.stampSelectionTimer != null) { window.clearTimeout(this.stampSelectionTimer); this.stampSelectionTimer = null; }
    if (eager) { flush(); return; }
    this.stampSelectionTimer = window.setTimeout(() => { this.stampSelectionTimer = null; flush(); }, 400);
  }

  /** 0.91.1: re-apply a persisted selection AFTER the list has actually loaded.
   *  The initial pendingFocusIds restore (during the first render) can be
   *  clobbered by a metadata-cache reconcile render that fires shortly after
   *  mount — which is why selection "didn't survive reload" despite being
   *  persisted. These staggered retries re-assert the saved selection until it
   *  sticks, but ONLY when the current selection is empty or a shrunk subset of
   *  the saved one, so we never fight a selection the user has begun building. */
  private scheduleSelectionRestore(): void {
    const saved = this.lastSelectionByFocus.get(this.focusId);
    if (!saved || !saved.length) return;
    const apply = (): void => {
      const valid = saved.filter((id) => this.currentChildren.some((n) => n.id === id));
      if (!valid.length) return;
      const cur = [...this.selection];
      const savedSet = new Set(valid);
      const lostOrShrunk = cur.length < valid.length && cur.every((id) => savedSet.has(id));
      if (!lostOrShrunk) return; // already fully restored, or the user changed it
      this.selection.clear();
      for (const id of valid) this.selection.add(id);
      this.firstSelectedId = valid[0];
      this.lastSelected = valid[valid.length - 1];
      this.repaintSelectionClasses();
    };
    for (const delay of [120, 400, 900, 1600]) window.setTimeout(apply, delay);
  }

  private loadConfig(): void {
    const settingsFolder = (this.plugin?.settings?.folder ?? "Stashpad").trim().replace(/^\/+|\/+$/g, "");
    const overrideFolder = this.folderOverride?.trim().replace(/^\/+|\/+$/g, "") || null;
    const folder = overrideFolder || settingsFolder || "Stashpad";
    if (folder !== this.noteFolder) {
      this.noteFolder = folder;
      this.tree.rebuild(this.noteFolder);
    } else {
      this.noteFolder = folder;
    }
  }

  /** Snapshot the active state for the history stacks. */
  private captureNavSnapshot(): NavSnapshot {
    return { folder: this.noteFolder, focusId: this.focusId };
  }

  /** Push current state onto back stack + clear forward unless told
   *  otherwise. Called by every nav mutation that should be reversible
   *  via back. 0.67.0. */
  private recordNavState(opts: { keepForward?: boolean } = {}): void {
    const snap = this.captureNavSnapshot();
    // Skip if the new state is identical to the most recent back-stack
    // entry — avoids stacking duplicates from re-render flushes.
    const last = this.navBackStack[this.navBackStack.length - 1];
    if (last && last.folder === snap.folder && last.focusId === snap.focusId) return;
    this.navBackStack.push(snap);
    if (!opts.keepForward) this.navForwardSnapshots = [];
  }

  private async setFolderOverride(folder: string | null, opts: { skipHistory?: boolean } = {}): Promise<void> {
    const cleaned = folder?.trim().replace(/^\/+|\/+$/g, "") || null;
    if (cleaned && this.isReservedFolder(cleaned)) {
      new Notice(`"${cleaned}" is a reserved Stashpad subfolder (imports/exports/attachments). Pick a different folder.`);
      return;
    }
    if ((cleaned || null) === (this.folderOverride || null)) return;
    // 0.67.0: record current state so back can return to the previous
    // folder + focus. Skip when applyNavSnapshot is the caller (it
    // already arranged the stacks).
    if (!opts.skipHistory) this.recordNavState();
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
    // 0.71.36: bootstrap can throw "Folder already exists" when the
    // vault state races our cache check on tab open/close. Swallow
    // that specific case so the wrap doesn't surface as Obsidian's
    // "Failed to open view" — bootstrap is idempotent on next mount.
    try { await this.bootstrapFolder(); } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (!/already exists/i.test(msg)) console.warn("[Stashpad] bootstrapFolder failed:", e);
    }
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

  /** 0.65.0: delegate to the plugin's unified folder picker. The old
   *  view-local SuggestModal had its own (less polished) layout and
   *  fewer item kinds. The plugin's version covers reveal / open /
   *  switch-current / create with icons and full token matching. */
  private openFolderPicker(): void {
    this.plugin.openFolderPicker();
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
  /** 0.98.26: per-folder encryption filter — "all" | "locked" | "unlocked". */
  private currentEncryptionFilter(): "all" | "locked" | "unlocked" {
    return this.plugin.settings.encryptionFilter?.[this.noteFolder] ?? "all";
  }
  private async setEncryptionFilter(v: "all" | "locked" | "unlocked"): Promise<void> {
    const map = { ...(this.plugin.settings.encryptionFilter ?? {}) };
    if (v === "all") delete map[this.noteFolder];
    else map[this.noteFolder] = v;
    this.plugin.settings.encryptionFilter = map;
    await this.plugin.saveSettings();
  }

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

  /** 0.79.8: per-folder "hide notes without attachments" filter. */
  private currentAttachmentsOnly(): boolean {
    return !!this.plugin.settings.attachmentsOnlyNotes?.[this.noteFolder];
  }
  private async setAttachmentsOnly(on: boolean): Promise<void> {
    const map = { ...(this.plugin.settings.attachmentsOnlyNotes ?? {}) };
    if (!on) delete map[this.noteFolder];
    else map[this.noteFolder] = true;
    this.plugin.settings.attachmentsOnlyNotes = map;
    await this.plugin.saveSettings();
  }
  /** True if `node`'s own frontmatter `attachments` array is non-empty. */
  private nodeHasAttachment(node: TreeNode): boolean {
    if (!node.file) return false;
    const a = this.app.metadataCache.getFileCache(node.file)?.frontmatter?.attachments;
    return Array.isArray(a) && a.length > 0;
  }
  /** True if `node` or any descendant has an attachment — keeps parents
   *  visible so the attachment-bearing child stays reachable. */
  private hasAttachmentInSubtree(node: TreeNode): boolean {
    if (this.nodeHasAttachment(node)) return true;
    for (const child of this.tree.getChildren(node.id)) {
      if (this.hasAttachmentInSubtree(child)) return true;
    }
    return false;
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
          // attachments may be a wikilink ([[path]]), a bare path, or have a
          // leading slash; normalize to the linktext then resolve via
          // Obsidian, falling back to the literal path.
          const linktext = attachmentLinkPath(a);
          const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext, child.path);
          if (resolved) out.add(resolved.path);
          else out.add(linktext);
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
    const RESERVED_SUBFOLDERS = new Set(["_authors", "_imports", "_exports", "_processed", "_attachments", "_archive", ".archive"]);
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
    // 0.76.7: capture the list width ONCE per paint as the key for the
    // per-row overflow memo (see getOrComputeRender). One layout read
    // instead of one per row.
    this.lastListWidth = list.clientWidth || this.lastListWidth;
    // 0.82.1: (re)arm the lazy-body observer for this paint. Cold rows
    // (no cached render) get a cheap title placeholder and only do the
    // expensive cachedRead + MarkdownRenderer once they scroll near the
    // viewport — the profile showed body reads at full-list scale were
    // ~97% of the time.
    this.bodyRenderer.arm();
    // 0.98.6: a pending cursor target (e.g. a just-decrypted note) — apply it
    // once the note actually appears in the list, then clear. Until then it
    // survives intermediate renders (the restored note arrives a tick later via
    // the metadataCache → tree rebuild).
    if (this.pendingCursorId) {
      const idx = this.currentChildren.findIndex((n) => n.id === this.pendingCursorId);
      if (idx >= 0) {
        this.cursorIdx = idx;
        this.selection.clear();
        this.selection.add(this.pendingCursorId);
        this.lastSelected = this.pendingCursorId;
        this.pendingCursorId = null;
      }
    }
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
    // 0.98.1/0.98.4: locked-subtree placeholders, interleaved by the locked
    // note's `created` so a locked note keeps its slot (no jarring sink-to-bottom).
    // A scan-only blob with no recorded created sorts to the end.
    type Lk = { blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null };
    const lockTs = (lk: Lk) => (lk.created && Number.isFinite(Date.parse(lk.created)) ? Date.parse(lk.created) : Number.POSITIVE_INFINITY);
    // Nested: stubs directly under the focus. Flat/Everything show the WHOLE
    // subtree flattened, so gather stubs anchored to the focus OR any currently-
    // shown descendant (a locked stub always anchors to a visible note — a locked
    // parent keeps its children inside its own blob). Otherwise a deeply-nested
    // locked note would vanish from the flat list entirely. (0.98.20)
    // 0.98.26: encryption filter — "unlocked" hides locked stubs entirely.
    const encFilter = this.currentEncryptionFilter();
    let lockSource: Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null }>;
    if (encFilter === "unlocked") {
      lockSource = [];
    } else if (mode === "nested") {
      lockSource = this.plugin.lockedSubtreesFor(this.noteFolder, focused.id);
    } else {
      const ids = new Set<StashpadId>([focused.id, ...this.currentChildren.map((n) => n.id)]);
      const seen = new Set<string>();
      lockSource = [];
      for (const id of ids) {
        for (const lk of this.plugin.lockedSubtreesFor(this.noteFolder, id)) {
          if (!seen.has(lk.blob)) { seen.add(lk.blob); lockSource.push(lk); }
        }
      }
    }
    const lockItems = lockSource
      .map((lk) => ({ lk, ts: lockTs(lk) }))
      .sort((a, b) => a.ts - b.ts);

    // 0.98.9: in MANUAL sort, a locked placeholder keeps the exact slot its note
    // occupied — anchored after its `prevSibling` (the left-neighbor captured at
    // lock), NOT by `created`. Otherwise locking a reordered note would jump the
    // placeholder to its creation-time slot (usually the top). Matches the
    // unlock-side restore so lock→unlock is positionally stable.
    // Manual prevSibling-anchoring only applies in nested view (flat/everything
    // synthesize a created-sorted list and ignore manual sort).
    const manual = mode === "nested" && this.sortStore.getMode(this.noteFolder, focused.id) === "manual";

    if (this.currentChildren.length === 0 && fileItems.length === 0 && lockItems.length === 0) {
      list.createDiv({ cls: "stashpad-empty", text: "No notes here yet. Type below to add one." });
    } else if (manual && lockItems.length > 0) {
      // Build the full sibling sequence (unlocked notes + locked placeholders),
      // inserting each placeholder after its `prevSibling`. CHAIN-RESOLVING: a
      // prevSibling can be another LOCKED note (when you lock note B then note C
      // whose left-neighbor was B) — so we iterate until every placeholder whose
      // anchor is already placed gets inserted. Without this, the 2nd lock's
      // anchor wouldn't resolve and the placeholder floated to the top.
      const idxOfNote = new Map<StashpadId, number>(this.currentChildren.map((n, i) => [n.id, i]));
      const lockByRoot = new Map<StashpadId, Lk>();
      for (const { lk } of lockItems) if (lk.rootId) lockByRoot.set(lk.rootId, lk);
      const seq: StashpadId[] = this.currentChildren.map((n) => n.id);
      // Newest-first so multiple placeholders sharing one anchor end up oldest-
      // closest-to-anchor after repeated insert-at(anchor+1).
      const pending = lockItems.map(({ lk }) => lk).filter((lk) => lk.rootId)
        .sort((a, b) => lockTs(b) - lockTs(a));
      let progress = true;
      while (pending.length && progress) {
        progress = false;
        for (let i = 0; i < pending.length; i++) {
          const lk = pending[i];
          const prev = lk.prevSibling ?? null;
          let at: number;
          if (prev == null) at = 0;                       // genuinely first → top
          else { const p = seq.indexOf(prev); if (p < 0) continue; at = p + 1; }
          seq.splice(at, 0, lk.rootId!);
          pending.splice(i, 1); i--; progress = true;
        }
      }
      // Anchor pointed at something no longer present → trail at the end.
      for (const lk of pending) seq.push(lk.rootId!);
      for (const id of seq) {
        const ni = idxOfNote.get(id);
        if (ni !== undefined) this.renderNote(list, this.currentChildren[ni], ni);
        else { const lk = lockByRoot.get(id); if (lk) this.renderLockedPlaceholder(list, lk); }
      }
      // Loose files (everything mode) trail the manual list, oldest first.
      for (const f of fileItems.slice().sort((a, b) => a.stat.ctime - b.stat.ctime)) this.renderFileRow(list, f);
    } else if (fileItems.length === 0) {
      // Notes keep their tree order; each placeholder is inserted before the
      // first note whose created is later than the placeholder's.
      let pi = 0;
      for (let i = 0; i < this.currentChildren.length; i++) {
        const nts = Number.isFinite(Date.parse(this.currentChildren[i].created)) ? Date.parse(this.currentChildren[i].created) : 0;
        while (pi < lockItems.length && lockItems[pi].ts <= nts) { this.renderLockedPlaceholder(list, lockItems[pi].lk); pi++; }
        this.renderNote(list, this.currentChildren[i], i);
      }
      while (pi < lockItems.length) { this.renderLockedPlaceholder(list, lockItems[pi].lk); pi++; }
    } else {
      type Item =
        | { kind: "note"; ts: number; idx: number }
        | { kind: "file"; ts: number; file: TFile }
        | { kind: "lock"; ts: number; lk: Lk };
      const items: Item[] = [
        ...this.currentChildren.map((n, idx) => ({ kind: "note" as const, ts: Number.isFinite(Date.parse(n.created)) ? Date.parse(n.created) : 0, idx })),
        ...fileItems.map((f) => ({ kind: "file" as const, ts: f.stat.ctime, file: f })),
        ...lockItems.map((l) => ({ kind: "lock" as const, ts: l.ts, lk: l.lk })),
      ];
      items.sort((a, b) => a.ts - b.ts);
      for (const it of items) {
        if (it.kind === "note") this.renderNote(list, this.currentChildren[it.idx], it.idx);
        else if (it.kind === "file") this.renderFileRow(list, it.file);
        else this.renderLockedPlaceholder(list, it.lk);
      }
    }
    if (focused.file && Platform.isMobile) this.installFocusedMiniObserver(list);
  }

  /** 0.98.1: a locked-subtree placeholder row. Click → unlock (prompts for the
   *  password if needed) → decrypt back. Delete-guarded: no delete affordance,
   *  and it's not a tree node so the delete commands never target it. */
  private renderLockedPlaceholder(list: HTMLElement, lk: { blob: string; title: string; count: number; created?: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null }): void {
    const row = list.createDiv({ cls: "stashpad-locked-row" });
    // 0.98.11: left-hand timestamp, matching a normal note row's `created` time,
    // so a locked stub still reads on the same timeline as the notes around it.
    if (lk.created) row.createSpan({ cls: "stashpad-note-time stashpad-locked-time", text: this.formatTime(lk.created) });
    const icon = row.createSpan({ cls: "stashpad-locked-icon" });
    setIcon(icon, "lock");
    // 0.98.14: optionally hide the real title (privacy) — show a generic label.
    // Also fall back to generic when the on-disk title is empty (it was locked with
    // hide-titles on, so the real title lives only inside the blob).
    const hideTitle = (this.plugin.settings.hideLockedTitles ?? false) || !lk.title;
    row.createSpan({ cls: "stashpad-locked-title", text: hideTitle ? "Locked note" : lk.title });
    row.createSpan({ cls: "stashpad-locked-count", text: lk.count > 1 ? `${lk.count} notes · locked` : "locked" });
    const unlockBtn = row.createEl("button", { cls: "stashpad-locked-unlock", text: "Unlock" });
    setIcon(unlockBtn.createSpan({ cls: "stashpad-btn-icon" }), "unlock");
    const doUnlock = async (e: Event) => {
      e.preventDefault(); e.stopPropagation();
      // Positional fields come straight from the placeholder (sidecar-backed via
      // lockedSubtreesFor), so the restore survives a lost in-memory registry.
      // Fall back to the registry entry only if the scan didn't carry them.
      const entry = (this.plugin.settings.lockedSubtrees ?? []).find((x) => x.blob === lk.blob);
      const rootId = lk.rootId ?? entry?.rootId ?? null;
      const parentId = (lk.parentId ?? entry?.parentId ?? ROOT_ID) as StashpadId;
      const prevSibling = (lk.prevSibling ?? entry?.prevSibling ?? null) as StashpadId | null;
      const ok = await this.plugin.unlockBundleAt(lk.blob);
      if (ok) {
        this.selection.clear();
        this.lastSelected = null;
        if (rootId) {
          // Restore the note's manual slot. If the parent has no explicit order
          // yet but IS in manual sort, seed one from the current display order
          // (incl. the just-restored note) so prevSibling reinsert can take hold —
          // otherwise a reordered note would fall back to created-asc (its
          // ORIGINAL position), which is the bug this fixes.
          let order = this.order.getOrder(this.noteFolder, parentId);
          const manual = this.sortStore.getMode(this.noteFolder, parentId) === "manual";
          if (order.length === 0 && manual) {
            order = this.tree.getChildren(parentId).map((n) => n.id);
          }
          if (order.length > 0) {
            const without = order.filter((id) => id !== rootId);
            const at = prevSibling && without.includes(prevSibling) ? without.indexOf(prevSibling) + 1 : 0;
            without.splice(Math.max(0, at), 0, rootId);
            this.order.setOrder(this.noteFolder, parentId, without);
            void this.order.flush(this.noteFolder);
          }
          // Cursor + select the decrypted note once it re-appears in the list.
          this.pendingCursorId = rootId;
        }
        this.render();
      }
    };
    unlockBtn.onclick = doUnlock;
    // 0.98.24: context menu for locked stubs — right-click on desktop, ⋮ button on
    // mobile (no right-click there). Locked stubs aren't tree nodes, so the normal
    // note menu (openNoteMenu) can't serve them; this is their own small menu.
    const openLockedMenu = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i: any) => i.setTitle("Decrypt (unlock)").setIcon("unlock")
        .onClick(() => void doUnlock(e)));
      if (!Platform.isMobile) {
        const osManager = Platform.isMacOS ? "Finder" : Platform.isWin ? "File Explorer" : "file manager";
        menu.addItem((i: any) => i.setTitle(`Show in ${osManager}`).setIcon("folder-search").onClick(() => {
          try {
            const shell = (window as any).require?.("electron")?.shell;
            const fullPath = (this.app.vault.adapter as any)?.getFullPath?.(lk.blob);
            if (fullPath && shell?.showItemInFolder) shell.showItemInFolder(fullPath);
          } catch (err) { console.warn("[Stashpad] showItemInFolder failed", err); }
        }));
      }
      menu.addItem((i: any) => i.setTitle("Copy encrypted file path").setIcon("copy").onClick(() => {
        // 0.98.32: full absolute path on desktop (pasteable into Finder/Explorer);
        // mobile has no usable filesystem path, so fall back to the vault-relative one.
        let path = lk.blob;
        if (!Platform.isMobile) {
          try { path = (this.app.vault.adapter as any)?.getFullPath?.(lk.blob) || lk.blob; } catch { /* keep relative */ }
        }
        void navigator.clipboard.writeText(path);
        new Notice("Path copied.");
      }));
      menu.showAtMouseEvent(e);
    };
    row.oncontextmenu = openLockedMenu;
    if (Platform.isMobile) {
      const menuBtn = row.createEl("button", { cls: "stashpad-locked-menu" });
      setIcon(menuBtn, "more-vertical");
      menuBtn.setAttr("aria-label", "Locked note menu");
      menuBtn.onclick = (e) => openLockedMenu(e);
    }
    // 0.98.8: only the Unlock button decrypts — clicking elsewhere on the row
    // must NOT trigger the (heavyweight, password-prompting) decrypt by accident.
    row.setAttr("aria-label", `${hideTitle ? "Locked note" : `Locked: ${lk.title}`}. Use the Unlock button to decrypt.`);
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
    // 0.98.26: "locked" filter hides non-Stashpad file rows too (not encrypted).
    if (this.currentEncryptionFilter() === "locked") return;
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
    const attachmentsOnly = this.currentAttachmentsOnly();
    const importedOnly = this.importedOnly;
    const authorId = this.authorFilter;
    if (!cutoff && !tag && !color && !hideCompleted && !attachmentsOnly && !importedOnly && !authorId) return children;
    return children.filter((n) => {
      // 0.88.1: imported-only + by-author filters (node-level, like tag/color).
      if (importedOnly) {
        if (!n.file) return false;
        if (this.app.metadataCache.getFileCache(n.file)?.frontmatter?.imported !== true) return false;
      }
      if (authorId) {
        if (!n.file) return false;
        const a = parseAuthorRef(this.app.metadataCache.getFileCache(n.file)?.frontmatter?.author);
        if (!a || a.id !== authorId) return false;
      }
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
      // Attachments-only: keep a node if it (or any descendant) has an
      // attachment, so the attachment-bearing child stays reachable.
      if (attachmentsOnly && !this.hasAttachmentInSubtree(n)) return false;
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
  private stampSelectionTimer: number | null = null;
  private stampSelectedCursor(eager = false): void {
    // 0.91.1: persist the multi-selection on the same cadence as the cursor —
    // stampSelectedCursor is already called at every selection-change site
    // (eager on close/blur/reload, debounced otherwise), so piggybacking here
    // keeps localStorage continuously fresh instead of relying on a single
    // beforeunload stamp that can miss.
    this.stampSelection(eager);
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

  private _renderT0: number | null = null;
  /** public: called by extracted command modules (commands/*.ts). */
  render(policy?: ScrollPolicy): void {
    if (perf.enabled) this._renderT0 = performance.now();
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
    // 0.63.6 perf: only capture the anchor when the policy that will
    // run actually needs it (preserve). Skip the per-row rect walk for
    // pin-bottom / scroll-to-id / restore / follow-cursor paths.
    // Anchor MUST be captured BEFORE root.empty() destroys the rows it
    // reads, so we read the policy here pre-rebuild.
    const _policyForAnchor = policy ?? { kind: "preserve" as const };
    const anchor = _policyForAnchor.kind === "preserve"
      ? this.captureScrollAnchor()
      : null;
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
    // 0.61.1: tiny-mode shell — skip the filter bar, breadcrumb, and
    // focused-header. Render a slim strip with the folder name +
    // sticky toggle + expand button instead.
    root.toggleClass("is-tiny", this.tinyMode);
    root.toggleClass("is-compact", this.compactMode);
    // 0.63.6 perf: also toggle classes on the leaf wrapper and the
    // workspace-tabs ancestor. Earlier code used CSS `:has()` to reach
    // these elements from the view-root's class, but `:has()` triggers
    // a global style recalc on every DOM change inside the leaf —
    // which on each arrow-key cursor move (toggles is-cursor on rows)
    // re-validated every selector. Direct classes have zero recalc cost.
    const leafEl = this.containerEl.closest(".workspace-leaf") as HTMLElement | null;
    if (leafEl) {
      leafEl.classList.toggle("stashpad-is-tiny", this.tinyMode);
      leafEl.classList.toggle("stashpad-is-compact", this.compactMode);
    }
    const tabsEl = this.containerEl.closest(".workspace-tabs") as HTMLElement | null;
    if (tabsEl) {
      tabsEl.classList.toggle("stashpad-has-tiny", this.tinyMode);
    }
    if (this.tinyMode) {
      this.renderTinyHeader(root);
    } else {
      // 0.61.2: compact mode skips the time-filter row (folder switcher,
      // tag/color/sort/view dropdowns, time-window buttons, the three
      // view-mode buttons). Breadcrumb stays — it's the smallest signal
      // of "where am I" worth keeping, and the breadcrumb is where the
      // actions cluster (select-mode toggle + ⚡ actions menu) lives.
      if (!this.compactMode) this.renderTimeFilterBar(root);
      this.renderBreadcrumb(root);
    }

    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    // On desktop the focused header sits above the list (pinned). On
    // mobile it's appended INTO the list as the first child so it scrolls
    // with the rows — see further down. A 1-line sticky mini preview
    // appears at the top of the list when the full header scrolls out.
    // 0.61.1: tiny mode hides the focused-header too. 0.61.2: compact
    // mode also hides it.
    if (focused.file && !Platform.isMobile && !this.tinyMode && !this.compactMode) this.renderFocusedHeader(root, focused);

    this.currentChildren = this.filterChildren(this.collectViewItems(focused.id));
    let selectionMovedByRender = false;
    if (this.autoSelectNewest && this.currentChildren.length > 0) {
      const last = this.currentChildren[this.currentChildren.length - 1];
      this.cursorIdx = this.currentChildren.length - 1;
      this.selection.clear();
      this.selection.add(last.id);
      this.lastSelected = last.id;
      this.autoSelectNewest = false;
      // 0.79.9: auto-selecting the just-created note is a genuine
      // selection change — let the detail panel follow it instead of
      // staying pinned to the previously-displayed note.
      selectionMovedByRender = true;
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
    this.dnd.attachListDnD(list);
    this.populateListBody(list, focused);

    this.renderComposer(root);
    if (Platform.isMobile) this.renderMobileNav(root);
    // 0.74.6: a full render is a CONTENT change, not a selection
    // change. Firing selection-changed here made the detail panel
    // re-lock to the live cursor on every reorder/edit re-render —
    // so reordering children yanked the panel off the note being
    // reordered. Content-changed lets the panel refresh in place
    // while staying pinned to its displayed note. Genuine selection
    // changes fire from selectCursor / handleRowClick / navigateTo.
    if (this._renderT0 != null) { perf.record("render.total", performance.now() - this._renderT0); this._renderT0 = null; }
    this.plugin.notifyStashpadContentChanged();
    // 0.79.9: when this render auto-selected a newly-created note, that's
    // a real selection change — notify so the detail panel unlocks and
    // follows it (content-changed alone keeps it pinned to the old note).
    if (selectionMovedByRender) this.plugin.notifyStashpadSelectionChanged();
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
          // 0.59.5: when the user was at the bottom (within 12px), pin to
          // the new bottom instead of anchor-restoring. Otherwise mutating
          // a near-bottom row (color border thickness change, completed
          // strikethrough wrap, hide-completed making it disappear) shifts
          // the anchor row's offset and the view jitters.
          if (legacyPinBottom) {
            this.scrollListToBottom();
          } else if (prevAtBottom) {
            // 0.59.6: use scrollListToBottom (with its multi-frame
            // settle watchdog) instead of a one-shot scrollTop set.
            // The async markdown re-render of the just-mutated row
            // shifts the row height a few hundred ms later; the
            // watchdog keeps re-pinning until layout stabilises.
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
        // 0.76.27: during a mobile keyboard show/hide the list resizes;
        // don't touch scrollTop then, or the list visibly jumps on
        // every composer tap. Let the browser's reflow settle.
        if (Date.now() < this.keyboardTransitionUntil) return;
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
    const displayName = (this.noteFolder.split("/").pop() || this.noteFolder) || "Stashpad";
    setIcon(folderBtn.createSpan({ cls: "stashpad-btn-icon" }), "folder");
    folderBtn.createSpan({ text: displayName, cls: "stashpad-btn-text" });
    folderBtn.title = isOverride
      ? `Folder (override): ${this.noteFolder}\nClick to change or revert to default.`
      : `Folder: ${this.noteFolder}\nClick to override for this tab.`;
    if (isOverride) folderBtn.addClass("is-override");
    folderBtn.onclick = (e) => { e.preventDefault(); this.openFolderPicker(); };

    // 0.68.4: icon-only Search button between the folder switcher and
    // the tags dropdown. Mirrors the Mod+F binding for mouse users.
    const searchBtn = bar.createEl("button", { cls: "stashpad-search-btn" });
    setIconSafe(searchBtn, "search", "🔍");
    searchBtn.title = "Search notes (Mod+F)";
    searchBtn.onclick = (e) => { e.preventDefault(); this.openSearchModal(); };

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

    // 0.61.2: three view-mode buttons at the end of the time-filter row
    // (after the time buttons, NOT anchored to the right). Tiny mode,
    // compact mode, and "open this tab in a new window" — the latter
    // is mildly redundant with native Obsidian "Open in new window"
    // but more discoverable.
    const modeBtns = bar.createDiv({ cls: "stashpad-view-mode-btns" });
    // 0.71.16: on mobile, hide the tiny-mode + open-in-new-window
    // buttons — neither works on mobile (no popout windows). Compact
    // mode still has value on small screens.
    if (!Platform.isMobile) {
      const tinyBtn = modeBtns.createEl("button", { cls: "stashpad-view-mode-btn" });
      setIcon(tinyBtn, "minimize-2");
      tinyBtn.title = "Tiny mode — open this tab in a small always-on-top-capable popout window.";
      tinyBtn.onclick = (e) => { e.preventDefault(); void this.plugin.openTinyWindow(); };
    }
    const compactBtn = modeBtns.createEl("button", { cls: "stashpad-view-mode-btn" });
    // 0.71.16: when compact mode is ON, swap the icon to one that
    // reads as "exit / expand" so the affordance flips clearly.
    setIcon(compactBtn, this.compactMode ? "panel-top" : "rows-2");
    compactBtn.title = this.compactMode
      ? "Compact mode is ON — click to restore full chrome."
      : "Compact mode — hide the filter row + focused header; keep breadcrumb + list + composer.";
    if (this.compactMode) compactBtn.addClass("is-active");
    compactBtn.onclick = (e) => { e.preventDefault(); this.toggleCompactMode(); };
    if (Platform.isMobile) return; // skip the popout button on mobile
    const popoutBtn = modeBtns.createEl("button", { cls: "stashpad-view-mode-btn" });
    setIcon(popoutBtn, "external-link");
    popoutBtn.title = getSettings().popoutDuplicates
      ? "Duplicate this Stashpad tab into a new Obsidian window. (Toggle in Settings → Open in new window — duplicate tab.)"
      : "Move this Stashpad tab to a new Obsidian window. (Toggle in Settings → Open in new window — duplicate tab.)";
    popoutBtn.onclick = (e) => {
      e.preventDefault();
      const duplicate = getSettings().popoutDuplicates;
      try {
        const ws = this.app.workspace as any;
        if (duplicate) {
          // Spawn a new popout leaf carrying this leaf's full state, then
          // re-set it so the popout shows the same folder/focus. Original
          // tab stays open.
          const state = this.leaf.getViewState();
          const popLeaf = ws.openPopoutLeaf?.();
          if (popLeaf) void popLeaf.setViewState({ ...state, active: true });
          else new Notice("Stashpad: this Obsidian build doesn't expose openPopoutLeaf.");
        } else {
          ws.moveLeafToPopout?.(this.leaf);
        }
      } catch (err) {
        new Notice(`Stashpad: open-in-new-window failed (${(err as Error).message})`);
      }
    };

    // Action cluster moved to the breadcrumb row's start — see
    // renderActionsCluster, called from renderBreadcrumb.
  }

  /** Toggle compact mode + persist + re-render. 0.61.2. */
  toggleCompactMode(): void {
    this.compactMode = !this.compactMode;
    this.render();
    try { (this.app.workspace as any).requestSaveLayout?.(); } catch {}
  }

  /** Select-mode toggle + ⋯ actions menu. Rendered at the START of the
   *  breadcrumb row (left of Home) on every platform. */
  private renderActionsCluster(parent: HTMLElement): void {
    const actions = parent.createDiv({ cls: "stashpad-mobile-actions" });
    // 0.66.0: Stashpad-internal back / forward nav buttons. Stashpad
    // keeps its own focusId stack (navigateUp / navigateForward) that
    // Obsidian's view-header back/forward doesn't touch — and in
    // compact / tiny mode we hide view-header entirely, leaving the
    // user no way to undo an accidental drill-in. These two buttons
    // sit at the start of the actions cluster so they're always
    // visible alongside the breadcrumb.
    const backBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
    setIconSafe(backBtn, "arrow-left", "‹");
    const canGoBack = this.navBackStack.length > 0 || this.focusId !== ROOT_ID;
    backBtn.title = this.navBackStack.length > 0 ? "Back" : (this.focusId !== ROOT_ID ? "Back (up to parent)" : "No back history");
    if (!canGoBack) backBtn.addClass("is-disabled");
    backBtn.onclick = (e) => { e.preventDefault(); this.navigateBack(); };
    const fwdBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
    setIconSafe(fwdBtn, "arrow-right", "›");
    const canGoFwd = this.navForwardSnapshots.length > 0;
    fwdBtn.title = canGoFwd ? "Forward" : "No forward history";
    if (!canGoFwd) fwdBtn.addClass("is-disabled");
    fwdBtn.onclick = (e) => { e.preventDefault(); this.navigateForward(); };

    const selectBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
    const inSelect = this.mobileSelectMode;
    setIconSafe(selectBtn, inSelect ? "check-square" : "square", inSelect ? "☑" : "☐");
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
    setIconSafe(moreBtn, "zap", "⚡");
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
    // 0.62.4: shortcut to the notification history / log so users
    // don't have to dive into Settings or the command palette to
    // review what happened. Triggers the same command palette entry.
    menu.addItem((it: any) => it.setTitle("Notification history…").setIcon("bell").onClick(() => {
      (this.app as any).commands?.executeCommandById?.("stashpad:stashpad-open-notification-history");
    }));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("list-tree").setDisabled(!hasTargets).onClick(() => this.cmdOpenInNewStashpadTab()));
    menu.addItem((it: any) => it.setTitle("Open in editor").setIcon("pencil").setDisabled(!hasTargets).onClick(() => this.cmdOpenInEditor()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Move…").setIcon("arrow-right-circle").setDisabled(!hasTargets).onClick(() => this.cmdMovePicker()));
    menu.addItem((it: any) => it.setTitle("Nest under… (in-list)").setIcon("indent").setDisabled(!hasTargets).onClick(() => this.cmdInListPicker()));
    menu.addItem((it: any) => it.setTitle("Outdent").setIcon("outdent").setDisabled(!hasTargets).onClick(() => void this.cmdOutdent()));
    menu.addItem((it: any) => it.setTitle("Set color…").setIcon("palette").setDisabled(!hasTargets).onClick(() => this.cmdSetColor()));
    menu.addItem((it: any) => it.setTitle("Toggle complete").setIcon("check-circle").setDisabled(!hasTargets).onClick(() => void this.cmdToggleComplete()));
    menu.addItem((it: any) => it.setTitle("Toggle task (todo)").setIcon("check-square").setDisabled(!hasTargets).onClick(() => void this.cmdToggleTask()));
    menu.addItem((it: any) => it.setTitle("Set due date…").setIcon("calendar-clock").setDisabled(!hasTargets).onClick(() => this.cmdSetDue()));
    menu.addItem((it: any) => it.setTitle("Assign to…").setIcon("user-plus").setDisabled(!hasTargets).onClick(() => this.cmdAssign()));
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
    menu.addSeparator();
    // 0.87.0: escape hatch to the full command set — anything not surfaced
    // here (or in the context menu) is reachable via the command palette.
    menu.addItem((it: any) => it.setTitle("More commands…").setIcon("terminal").onClick(() => this.openCommandPalette()));
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  /** Open Obsidian's command palette (the "more commands" escape hatch from the
   *  ⚡ + context menus). Type "Stashpad" to narrow to this plugin's commands. */
  private openCommandPalette(): void {
    (this.app as any).commands?.executeCommandById?.("command-palette:open");
  }

  /** 0.90.0: open Stashpad's OWN command palette (default Mod+K) — only this
   *  plugin's commands, Sift-searchable, no "Stashpad: " prefix. Distinct from
   *  `openCommandPalette` above, which opens Obsidian's global palette. */
  openStashpadCommandPalette(): void {
    new StashpadCommandPalette(this.app).open();
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
        swatch.setCssStyles({ background: hex });
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
    // Size to content; cap so very long aliases don't run off-screen.
    pop.setCssStyles({
      left: `${Math.max(8, r.left)}px`,
      top: `${r.bottom + 4}px`,
      minWidth: `${r.width}px`,
      maxWidth: "min(280px, calc(100vw - 16px))",
      width: "max-content",
    });

    // 0.69.13: `close` was being referenced before its `const close =`
    // declaration (TDZ ReferenceError) — populateColorMenuBody and the
    // Escape Scope handler both captured it, which crashed the whole
    // wiring and left the popover non-functional. Declare scope +
    // close + outside FIRST, then attach.
    const scope = new Scope((this.app as any).scope);
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

    // Escape closes; pushed onto Obsidian's keymap so its workspace-level
    // "Escape returns to last leaf" handler doesn't fire instead.
    scope.register([], "Escape", (ev: KeyboardEvent) => {
      ev.preventDefault();
      close();
      return false;
    });
    (this.app as any).keymap?.pushScope(scope);

    this.populateColorMenuBody(pop, colors, close);

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
    pop.setCssStyles({
      left: `${Math.max(8, r.left)}px`,
      top: `${r.bottom + 4}px`,
      minWidth: `${r.width}px`,
      maxWidth: "min(280px, calc(100vw - 16px))",
      width: "max-content",
    });

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
      || this.currentAttachmentsOnly()
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
    pop.setCssStyles({
      right: `${Math.max(8, win.innerWidth - r.right)}px`,
      left: "auto",
      top: `${r.bottom + 4}px`,
      // Wider than the per-button popovers so accordion section headers +
      // option rows have room to breathe. Capped to viewport width.
      maxWidth: "min(360px, calc(100vw - 16px))",
      width: "max-content",
      minWidth: "260px",
    });

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
    if (mode !== "nested" || this.currentEncryptionFilter() !== "all") btn.addClass("is-active");
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
    pop.setCssStyles({
      left: `${Math.max(8, r.left)}px`,
      top: `${r.bottom + 4}px`,
      minWidth: `${r.width}px`,
      maxWidth: "min(320px, calc(100vw - 16px))",
      width: "max-content",
    });

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

    // 0.98.26: encryption filter — show all / only locked stubs / only decrypted.
    // Only shown once encryption is set up (otherwise nothing is ever locked).
    if (this.plugin.encryption?.isConfigured?.()) {
      const encNow = this.currentEncryptionFilter();
      const addEncRow = (val: "all" | "locked" | "unlocked", label: string, desc: string): void => {
        const row = container.createDiv({ cls: "stashpad-view-popover-row" });
        if (val === encNow) row.addClass("is-active");
        row.createDiv({ cls: "stashpad-view-popover-main" })
          .createSpan({ cls: "stashpad-view-popover-label", text: label });
        row.createDiv({ cls: "stashpad-view-popover-desc", text: desc });
        row.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (val !== encNow) { await this.setEncryptionFilter(val); this.refreshList(); }
          onPicked();
        };
      };
      addEncRow("all", "Encryption: show all", "Both locked 🔒 and decrypted notes.");
      addEncRow("locked", "Encryption: locked only", "Show only locked 🔒 stubs.");
      addEncRow("unlocked", "Encryption: decrypted only", "Hide locked 🔒 stubs.");
      container.createDiv({ cls: "stashpad-view-popover-divider" });
    }

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

    // 0.79.8: hide notes without attachments (works in every view mode).
    const haRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const haCheck = haRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    haCheck.checked = this.currentAttachmentsOnly();
    haRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Hide notes without attachments" });
    haRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: "Show only notes that have an attachment. A parent stays visible while any descendant has one.",
    });
    haRow.onclick = async (e) => {
      if (e.target !== haCheck) { e.preventDefault(); haCheck.checked = !haCheck.checked; }
      await this.setAttachmentsOnly(haCheck.checked);
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

    // 0.88.1: imported-only + by-author filters. Most useful in Flat/Everything
    // (which flatten descendants), but they apply in every mode.
    container.createDiv({ cls: "stashpad-view-popover-divider" });

    const impRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const impCheck = impRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    impCheck.checked = this.importedOnly;
    impRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Imported notes only" });
    impRow.createDiv({ cls: "stashpad-view-popover-desc", text: "Show only notes that came in via import." });
    impRow.onclick = (e) => {
      if (e.target !== impCheck) { e.preventDefault(); impCheck.checked = !impCheck.checked; }
      this.importedOnly = impCheck.checked;
      this.reconcileSelectionAfterFilter();
      this.refreshList();
    };

    // By-author dropdown — distinct authors present in this folder.
    const authors = new Map<string, string>();
    const dir = this.noteFolder.replace(/\/+$/, "");
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== dir) continue;
      const a = parseAuthorRef(this.app.metadataCache.getFileCache(f)?.frontmatter?.author);
      if (a) authors.set(a.id, a.name);
    }
    const authRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const authMain = authRow.createDiv({ cls: "stashpad-view-popover-main" });
    authMain.createSpan({ cls: "stashpad-view-popover-label", text: "By author" });
    const authSel = authMain.createEl("select", { cls: "stashpad-view-author-select" });
    const allO = authSel.createEl("option", { text: "All authors", value: "" });
    if (!this.authorFilter) allO.selected = true;
    for (const [id, name] of [...authors.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      const o = authSel.createEl("option", { text: name, value: id });
      if (this.authorFilter === id) o.selected = true;
    }
    authSel.onclick = (e) => e.stopPropagation();
    authSel.onchange = () => {
      this.authorFilter = authSel.value || null;
      this.reconcileSelectionAfterFilter();
      this.refreshList();
    };
    authRow.createDiv({ cls: "stashpad-view-popover-desc", text: authors.size ? "Show only notes by the chosen author." : "No authored notes in this folder yet." });
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
      if (swatchHex) sw.setCssStyles({ background: swatchHex });
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

  /** Slim header strip rendered in tiny mode — folder/focus title +
   *  sticky-on-top checkbox + expand-out button. No back/home crumbs,
   *  no time filter, no action cluster (the whole point of tiny mode
   *  is "just compose"). 0.61.1. */
  private renderTinyHeader(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "stashpad-tiny-header" });
    // 0.66.0: back / forward at the very start so tiny mode users have
    // a way to undo accidental drill-ins. The tiny header replaces
    // both the view-header and the breadcrumb, so without these the
    // user is stuck unless they ⤢ out of tiny mode first.
    const backBtn = bar.createEl("button", { cls: "stashpad-tiny-nav-btn" });
    setIconSafe(backBtn, "arrow-left", "‹");
    backBtn.title = "Back (up to parent)";
    const tinyCanBack = this.navBackStack.length > 0 || this.focusId !== ROOT_ID;
    if (!tinyCanBack) backBtn.addClass("is-disabled");
    backBtn.title = this.navBackStack.length > 0
      ? "Back"
      : (this.focusId !== ROOT_ID ? "Back (up to parent)" : "No back history");
    backBtn.onclick = () => this.navigateBack();
    const fwdBtn = bar.createEl("button", { cls: "stashpad-tiny-nav-btn" });
    setIconSafe(fwdBtn, "arrow-right", "›");
    fwdBtn.title = this.navForwardSnapshots.length > 0 ? "Forward" : "No forward history";
    if (this.navForwardSnapshots.length === 0) fwdBtn.addClass("is-disabled");
    fwdBtn.onclick = () => this.navigateForward();

    // 0.67.1: folder/title is now a button — click opens the unified
    // folder picker (same as the regular view's folder switcher).
    // Visually still reads as the slim path label, but it's
    // tap-actionable in tiny mode.
    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    const folderLabel = (this.noteFolder.split("/").pop() || this.noteFolder).trim();
    const focusLabel = this.focusId === ROOT_ID
      ? folderLabel
      : `${folderLabel} / ${this.titleForNode(focused).trim()}`;
    const title = bar.createEl("button", { cls: "stashpad-tiny-title stashpad-folder-btn" });
    const iconEl = title.createSpan({ cls: "stashpad-tiny-title-icon stashpad-btn-icon" });
    setIcon(iconEl, "folder");
    title.createSpan({ cls: "stashpad-tiny-title-text stashpad-btn-text", text: focusLabel });
    title.title = `${this.noteFolder}${this.focusId !== ROOT_ID ? ` / ${this.titleForNode(focused).trim()}` : ""}\nClick to switch / create folder.`;
    title.onclick = (e) => { e.preventDefault(); this.plugin.openFolderPicker(); };

    // Sticky-on-top checkbox.
    const stickyWrap = bar.createDiv({ cls: "stashpad-tiny-sticky" });
    const stickyCb = stickyWrap.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    stickyCb.checked = this.tinyAlwaysOnTop;
    stickyWrap.createSpan({ text: "Sticky" });
    stickyCb.onchange = () => {
      this.tinyAlwaysOnTop = stickyCb.checked;
      // 0.61.6: only toggle always-on-top; don't re-trigger the window
      // resize. Re-applying full applyTinyWindow on the sticky toggle
      // was snapping the user's manually-resized window back to 280×360.
      this.applyTinyAlwaysOnTop();
    };

    // 0.77.0-feat: window-transparency button. Desktop popouts only
    // (Electron setOpacity) — hidden on mobile, where there's no
    // window to make transparent. Click toggles a small slider popover.
    if (!Platform.isMobile) {
      const opacityBtn = bar.createEl("button", { cls: "stashpad-tiny-nav-btn stashpad-tiny-opacity-btn" });
      setIcon(opacityBtn, "contrast");
      opacityBtn.title = "Window transparency";
      if (this.tinyOpacity < 1) opacityBtn.addClass("is-active");
      opacityBtn.onclick = (e) => { e.stopPropagation(); this.toggleTinyOpacityPopover(opacityBtn); };
    }

    // 0.61.8: ALWAYS render the compact-toggle button in the tiny
    // header. Carrying compactMode through to tiny was meant to surface
    // the exit, but if a user enters tiny WITHOUT being in compact
    // (the common case — there's no compact-toggle UI in normal mode
    // OUTSIDE the time-filter row) they had no way to flip compact.
    // Now the rows-2 button always shows, tooltip flips, and clicking
    // toggles the underlying compactMode state regardless.
    const compactBtn = bar.createEl("button", { cls: "stashpad-tiny-expand stashpad-tiny-exit-compact" });
    // 0.71.17: flip icon to "exit / expand" when compact mode is on,
    // same as the desktop button.
    setIcon(compactBtn, this.compactMode ? "panel-top" : "rows-2");
    compactBtn.title = this.compactMode
      ? "Compact mode is ON — click to turn off."
      : "Compact mode — click to turn on (strips row metadata).";
    if (this.compactMode) compactBtn.addClass("is-active");
    compactBtn.onclick = () => { this.toggleCompactMode(); };

    // Expand button — exit tiny mode + restore window size.
    // 0.71.20: swap the ⤢ glyph for the maximize-2 lucide icon so it
    // matches the rest of the header's icon-button styling.
    const expandBtn = bar.createEl("button", { cls: "stashpad-tiny-expand" });
    setIcon(expandBtn, "maximize-2");
    expandBtn.title = "Exit tiny mode";
    expandBtn.onclick = () => { void this.exitTinyMode(); };
  }

  /** 0.77.0-feat: handle to the open opacity popover so a second click
   *  (or click-outside) closes it. */
  private tinyOpacityPopover: HTMLElement | null = null;
  private toggleTinyOpacityPopover(anchor: HTMLElement): void {
    if (this.tinyOpacityPopover) {
      this.tinyOpacityPopover.remove();
      this.tinyOpacityPopover = null;
      return;
    }
    const pop = document.createElement("div");
    pop.className = "stashpad-tiny-opacity-popover";
    pop.createSpan({ cls: "stashpad-tiny-opacity-label", text: "Transparency" });
    const slider = pop.createEl("input", { type: "range" }) as HTMLInputElement;
    slider.min = "30"; slider.max = "100"; slider.step = "1";
    slider.value = String(Math.round(this.tinyOpacity * 100));
    const pct = pop.createSpan({ cls: "stashpad-tiny-opacity-pct", text: `${slider.value}%` });
    // Live-apply as the user drags — opacity is cheap to set.
    slider.addEventListener("input", () => {
      const v = Math.min(100, Math.max(30, parseInt(slider.value, 10) || 100));
      this.tinyOpacity = v / 100;
      pct.setText(`${v}%`);
      this.applyTinyOpacity();
      anchor.toggleClass("is-active", this.tinyOpacity < 1);
    });
    // Persist on release so the value survives reloads (view state).
    slider.addEventListener("change", () => { this.app.workspace.requestSaveLayout(); });
    // Position under the anchor button.
    this.viewRoot.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const rootR = this.viewRoot.getBoundingClientRect();
    pop.setCssStyles({
      top: `${r.bottom - rootR.top + 4}px`,
      left: `${Math.max(4, Math.min(r.left - rootR.left, rootR.width - 180))}px`,
    });
    // Close on click-outside / Escape. Added next tick so the opening
    // click doesn't immediately dismiss it.
    const onDoc = (ev: Event) => {
      if (pop.contains(ev.target as Node) || ev.target === anchor || anchor.contains(ev.target as Node)) return;
      close();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    const close = () => {
      pop.remove();
      this.tinyOpacityPopover = null;
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    this.tinyOpacityPopover = pop;
    slider.focus();
  }

  /** Resolve the Electron BrowserWindow that hosts THIS view's leaf —
   *  not the main app window. Each Obsidian popout runs its own renderer,
   *  so require() must be invoked through the leaf's owner-document's
   *  global to land in the correct context. Otherwise calls bleed into
   *  the main window (which the user saw shrink + hide other windows).
   *  0.61.2. */
  private getOwnElectronWindow(): any | null {
    try {
      const ownerWindow = (this.containerEl?.ownerDocument?.defaultView ?? window) as any;
      const electron = ownerWindow?.require?.("electron")
        ?? (window as any).require?.("electron");
      const remote = electron?.remote
        ?? ownerWindow?.electron?.remote
        ?? (ownerWindow as any)?.["@electron/remote"];
      // First try: getCurrentWindow from the owner-document's renderer
      // context. If require is sandboxed away in the popout, this is
      // null and we fall through.
      let win = remote?.getCurrentWindow?.()
        ?? (ownerWindow as any)?.electronWindow
        ?? null;
      // 0.61.5 fallback: enumerate every BrowserWindow and match the one
      // whose webContents ID equals the owner window's webContents ID.
      // Lets us resolve the popout from the MAIN renderer's electron
      // module when the popout itself can't access require().
      if (!win) {
        try {
          const mainElectron = (window as any).require?.("electron");
          const mainRemote = mainElectron?.remote ?? mainElectron?.["@electron/remote"];
          const BrowserWindow = mainRemote?.BrowserWindow ?? mainElectron?.BrowserWindow;
          const all: any[] = BrowserWindow?.getAllWindows?.() ?? [];
          if (all.length === 1) {
            win = all[0];
          } else if (all.length > 1) {
            // Prefer the most recently focused one (popouts get focus
            // right after open) as the "current" window for tiny ops.
            const focused = mainRemote?.getFocusedWindow?.() ?? null;
            win = focused ?? all[all.length - 1];
          }
        } catch (e) {
          console.debug("[Stashpad] BrowserWindow.getAllWindows fallback failed", e);
        }
      }
      if (!win) console.debug("[Stashpad] couldn't resolve own electron window");
      return win ?? null;
    } catch (e) {
      console.debug("[Stashpad] resolve own electron window failed", e);
      return null;
    }
  }

  /** Toggle always-on-top WITHOUT touching window size. Separated from
   *  applyTinyWindow so the sticky checkbox doesn't snap the window
   *  back to 280×360 when the user has already manually resized it.
   *  0.61.6. */
  private applyTinyAlwaysOnTop(): void {
    const win = this.getOwnElectronWindow();
    if (!win) return;
    try { win.setAlwaysOnTop?.(!!this.tinyAlwaysOnTop); } catch (e) {
      console.debug("[Stashpad] setAlwaysOnTop failed", e);
    }
  }

  /** 0.77.0-feat: push this.tinyOpacity onto the host BrowserWindow.
   *  Electron-only; silent no-op on mobile / sandboxed builds. Clamped
   *  to [0.3, 1] so the window can't vanish entirely. */
  private applyTinyOpacity(): void {
    const win = this.getOwnElectronWindow();
    if (!win) return;
    const o = Math.min(1, Math.max(0.3, this.tinyOpacity));
    try { win.setOpacity?.(o); } catch (e) {
      console.debug("[Stashpad] setOpacity failed", e);
    }
  }

  /** Apply tiny-mode side-effects to the BrowserWindow that hosts this
   *  leaf: resize down + optionally pin always-on-top. Best-effort —
   *  bails silently if Electron's window APIs aren't reachable
   *  (sandboxed builds). 0.61.1 / 0.61.2 fix-window-target. */
  private applyTinyWindow(): void {
    const win = this.getOwnElectronWindow();
    if (!win) return;
    try {
      if (this.tinyMode) {
        // Decisive resize path. setMinimumSize first so prior constraints
        // can't clamp the new size up. Then prefer setBounds over setSize
        // because some Electron versions ignore setSize on a freshly-
        // created BrowserWindow until the renderer is fully painted —
        // setBounds with an explicit position is usually honoured.
        const targetW = 280;
        const targetH = 360;
        win.setMinimumSize?.(220, 260);
        // Preserve current position if available so the window doesn't
        // jump to (0, 0). Fallback to (100, 100) if bounds aren't
        // readable.
        let x = 100, y = 100;
        try {
          const cur = win.getBounds?.();
          if (cur && typeof cur.x === "number") { x = cur.x; y = cur.y; }
        } catch {}
        try { win.setBounds?.({ x, y, width: targetW, height: targetH }); } catch {}
        try { win.setSize?.(targetW, targetH); } catch {}
        win.setAlwaysOnTop?.(!!this.tinyAlwaysOnTop);
        // 0.77.0-feat: restore the saved opacity when entering tiny.
        try { win.setOpacity?.(Math.min(1, Math.max(0.3, this.tinyOpacity))); } catch {}
      } else {
        win.setAlwaysOnTop?.(false);
      }
    } catch (e) {
      console.debug("[Stashpad] tiny window apply failed", e);
    }
  }

  /** Flip out of tiny mode. Maximises the host window on the way out
   *  so the user lands back at near-fullscreen instead of a fixed
   *  900×700 (which the user noted was way too small on hi-res screens). */
  private async exitTinyMode(): Promise<void> {
    this.tinyMode = false;
    this.tinyAlwaysOnTop = false;
    // 0.77.0-feat: restore full opacity on the way out so the
    // expanded window isn't left see-through.
    this.tinyOpacity = 1;
    try { this.getOwnElectronWindow()?.setOpacity?.(1); } catch {}
    // 0.61.10: also clear compact when leaving tiny. The user expected
    // expand-out to restore the full chrome, not retain the compact
    // row-stripping. (They can still toggle compact back on via the
    // time-filter row's compact button.)
    this.compactMode = false;
    this.applyTinyWindow();
    const win = this.getOwnElectronWindow();
    try {
      // Reset the minimum first so maximise/setSize aren't clamped.
      win?.setMinimumSize?.(400, 300);
      // Maximise on Windows/Linux; on macOS the system "maximize" button
      // does true fullscreen which is more disruptive, so prefer setSize
      // to the screen's workArea bounds when available.
      const isMac = (Platform as any).isMacOS ?? false;
      if (isMac) {
        const electron = (this.containerEl?.ownerDocument?.defaultView as any)?.require?.("electron")
          ?? (window as any).require?.("electron");
        const screen = electron?.remote?.screen ?? electron?.screen;
        const wa = screen?.getPrimaryDisplay?.().workArea;
        if (wa) {
          win?.setBounds?.({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
        } else {
          win?.maximize?.();
        }
      } else {
        win?.maximize?.();
      }
    } catch {}
    this.render();
    // Persist state so reload doesn't snap back to tiny.
    try { await (this.app.workspace as any).requestSaveLayout?.(); } catch {}
  }

  /** Enter tiny mode (called by the command or right after the popout
   *  leaf is set up). Updates state, applies window shrink, re-renders. */
  enterTinyMode(): void {
    this.tinyMode = true;
    this.applyTinyWindow();
    this.render();
    try { (this.app.workspace as any).requestSaveLayout?.(); } catch {}
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
    if (this.focusId === ROOT_ID) {
      // 0.61.4: even at root, surface the exit-compact button + the
      // children-count chip when applicable. The earlier early-return
      // skipped both, which left the user stranded in compact mode
      // when at home.
      const childCount = this.tree.getChildren(this.focusId).length;
      if (childCount > 0) {
        bar.createSpan({ cls: "stashpad-crumb-count", text: `· ${childCount}` })
          .title = `${childCount} direct child${childCount === 1 ? "" : "ren"}`;
      }
      if (this.compactMode) {
        const exitBtn = bar.createEl("button", { cls: "stashpad-compact-exit-btn" });
        // 0.71.18: this exit button only renders while compact mode
        // is on, so the icon is always "exit / expand."
        setIcon(exitBtn, "panel-top");
        exitBtn.title = "Exit compact mode";
        exitBtn.onclick = (e) => { e.preventDefault(); this.toggleCompactMode(); };
      }
      return;
    }

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
    // 0.59.0: children count chip at the end of the breadcrumb. Counts
    // immediate children of the focus from the tree (unfiltered) so the
    // number reflects the parent's actual subtree size, not the
    // currently-visible filtered slice.
    const childCount = this.tree.getChildren(this.focusId).length;
    if (childCount > 0) {
      bar.createSpan({ cls: "stashpad-crumb-count", text: `· ${childCount}` })
        .title = `${childCount} direct child${childCount === 1 ? "" : "ren"}`;
    }
    // 0.61.3: exit-compact button. The compact toggle in the time-filter
    // row is hidden while compact mode is on (the entire row is gone),
    // so we surface a way out here. Only rendered when compactMode is
    // active.
    if (this.compactMode) {
      const exitBtn = bar.createEl("button", { cls: "stashpad-compact-exit-btn" });
      // 0.71.17: this button only renders WHILE in compact mode, so
      // its icon is always the "exit / expand" affordance.
      setIcon(exitBtn, "panel-top");
      exitBtn.title = "Exit compact mode";
      exitBtn.onclick = (e) => { e.preventDefault(); this.toggleCompactMode(); };
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
  /** public: called by extracted command modules (commands/*.ts). */
  actionsForFile(path: string): import("./notifications").NotificationAction[] {
    return buildFileActions(this.app, path, Platform.isMobile);
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
  /** public: read by extracted command modules (commands/*.ts). */
  titleList(nodes: TreeNode[], max = 3): string {
    if (!nodes.length) return "";
    const titles = nodes.map((n) => this.titleForNode(n).trim() || "(untitled)");
    if (titles.length <= max) {
      return titles.map((t) => `"${t}"`).join(", ");
    }
    const head = titles.slice(0, max).map((t) => `"${t}"`).join(", ");
    return `${head}, +${titles.length - max} more`;
  }

  /** public: read by view-sort's compareForSort (the SortHost interface). */
  titleForNode(node: TreeNode): string {
    if (!node.file) return "Untitled";
    const cache = this.app.metadataCache.getFileCache(node.file);
    const firstHeading = cache?.headings?.[0]?.heading;
    if (firstHeading) return firstHeading;
    return node.file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ") || "Untitled";
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
    // 0.98.26: "locked" encryption filter hides normal (decrypted) note rows.
    if (this.currentEncryptionFilter() === "locked") return;
    const file = node.file;
    const childCount = this.tree.getChildren(node.id).length;
    const isSelected = this.selection.has(node.id);
    const isCursor = idx === this.cursorIdx;
    const isPickTarget = this.inListPicker?.activeIdx === idx;

    const row = parent.createDiv({ cls: "stashpad-note" });
    if (isSelected) row.addClass("is-selected");
    if (isCursor) row.addClass("is-cursor");
    // 0.73.14: auto-expand the cursor row on initial render too (not
    // just on arrow-key repaints). Settings-gated.
    if (isCursor && this.plugin.settings.autoExpandCursorRow) row.addClass("is-cursor-expanded");
    if (isPickTarget) row.addClass("is-pick-target");
    if (this.isCompleted(node)) row.addClass("is-completed");
    // 0.99.5: ghost rows that are sitting on a pending CUT (note clipboard),
    // mirroring a file manager — they're about to move/be-extracted on paste.
    if (this.isCutPending(node.id)) row.addClass("is-cut-pending");
    else if (this.isCopyPending(node.id)) row.addClass("is-copy-pending");
    row.dataset.idx = String(idx);
    row.dataset.id = node.id;
    // Drag-reorder is only meaningful when we're showing immediate children
    // of the focus (Nested mode). In Flat / Everything the row's "position"
    // among its siblings is synthesized from a sort, not stored — dragging
    // would have nothing well-defined to mutate.
    const draggable = this.currentViewMode() === "nested";
    row.draggable = draggable;
    if (draggable) this.dnd.attachRowDnD(row, node, idx);

    row.addEventListener("click", (e) => this.handleRowClick(e, idx, node));
    // 0.75.0: double-click / double-tap focuses (navigates into) the
    // note — same as ArrowRight or the enter arrow. Settings-gated,
    // on by default. Skip when the dblclick lands on a link / tag so
    // those keep their own behavior, and clear the word-selection the
    // browser makes on double-click so it doesn't flash before nav.
    row.addEventListener("dblclick", (e) => {
      if (!this.plugin.settings.doubleClickToFocus) return;
      const t = e.target as HTMLElement | null;
      // 0.76.12: also skip the task checkbox — double-clicking it
      // should toggle, never navigate.
      if (t?.closest?.(".internal-link, .tag, a, .stashpad-note-task-checkbox")) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.navigateTo(node.id);
    });

    // 0.76.10: task checkbox at the leftmost edge of the row when the
    // note is a task. Reflects `completed`; click toggles it in place
    // (no need to open the Tasks panel). Sits before the meta column.
    // 0.96.1 (experiment): in COMPACT mode, show a checkbox on EVERY row so
    // compact reads as a tight checklist — not just task-tagged notes.
    const showCheckbox = this.isTask(node) || this.compactMode;
    if (showCheckbox) {
      row.addClass("is-task"); // desktop: adds the leading checkbox grid column
      // 0.87.1: on mobile the checkbox moves into the meta column (left of the
      // children-count arrow) so the single right-side action button doesn't
      // wrap to the next line; on desktop it stays at the leftmost edge.
      if (!Platform.isMobile) this.addTaskCheckbox(row, node);
    }

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
    // 0.87.1: the children-count arrow + (on mobile) the task checkbox share one
    // horizontal line below the timestamp — the mobile checkbox sits just to the
    // LEFT of the arrow (see the desktop addTaskCheckbox call above).
    const mobileTask = showCheckbox && Platform.isMobile;
    if (childCount > 0 || mobileTask) {
      const metaBottom = meta.createDiv({ cls: "stashpad-note-meta-bottom" });
      if (mobileTask) this.addTaskCheckbox(metaBottom, node);
      if (childCount > 0) {
        const enter = metaBottom.createSpan({ cls: "stashpad-note-enter" });
        if (color) enter.style.color = color;
        setIcon(enter.createSpan({ cls: "stashpad-btn-icon" }), "corner-down-right");
        enter.createSpan({ text: ` ${childCount}` });
        enter.onclick = (e) => { e.stopPropagation(); this.navigateTo(node.id); };
      }
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
    let toggleAnchor: HTMLElement;
    if (Platform.isMobile) {
      // 0.87.1: ONE button on mobile — it opens the context menu, which already
      // carries Focus / Open in editor / everything (the two separate focus +
      // edit buttons were too cramped on a phone). Press-and-hold is avoided
      // deliberately (it would fight drag-reorder / nesting).
      const moreBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-note-more" });
      setIcon(moreBtn, "ellipsis-vertical");
      moreBtn.title = "Actions";
      moreBtn.onclick = (e) => { e.stopPropagation(); this.openNoteMenu(e as unknown as MouseEvent, node); };
      toggleAnchor = moreBtn;
    } else {
      const pencil = actions.createEl("button", { cls: "stashpad-pencil" });
      setIcon(pencil, "pencil");
      pencil.title = "Edit in new tab";
      pencil.onclick = (e) => { e.stopPropagation(); void this.openFileAtEnd(file); };
      const enterBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-enter-btn" });
      setIcon(enterBtn, "arrow-right");
      enterBtn.title = "Open in Stashpad view";
      enterBtn.onclick = (e) => { e.stopPropagation(); this.navigateTo(node.id); };
      toggleAnchor = pencil;
    }

    // Now the actions cluster exists, render the body and route the
    // Show More toggle into that cluster (anchored before the first button).
    this.renderNoteBody(bodyContent, node, { clamp: true, toggleHost: actions, toggleAnchor });

    row.oncontextmenu = (evt) => { evt.preventDefault(); this.openNoteMenu(evt, node); };
  }

  /** Create + wire the task checkbox (used at the row's left edge on desktop,
   *  or inside the meta column on mobile). 0.87.1. */
  private addTaskCheckbox(parent: HTMLElement, node: TreeNode): void {
    const cb = parent.createSpan({ cls: "stashpad-note-task-checkbox" });
    const done = this.isCompleted(node);
    setIcon(cb, done ? "check-square" : "square");
    cb.title = done ? "Mark not done" : "Mark done";
    // The checkbox owns its pointer events so toggling never selects/focuses or
    // navigates the row (mousedown = selection, click = handleRowClick,
    // dblclick = open).
    cb.addEventListener("mousedown", (e) => e.stopPropagation());
    cb.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); });
    cb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); void this.toggleCompletedForNode(node); };
  }

  /** Lazy-body render cache + IntersectionObserver machinery (0.82.1).
   *  Owns renderCache / bodyObserver / lazyBodies; see NoteBodyRenderer. */
  bodyRenderer: NoteBodyRenderer;
  /** Width the list was last laid out at — the key for the overflow
   *  memo above. Captured once per populateListBody (one read), not
   *  per row. */
  private lastListWidth = 0;

  /** Public entry: render the body NOW if it's already cached (cheap), or
   *  show a title placeholder and defer the expensive read+render until the
   *  row scrolls into view. 0.82.1. */
  private renderNoteBody(
    container: HTMLElement,
    node: TreeNode,
    opts: { clamp?: boolean; toggleHost?: HTMLElement; toggleAnchor?: HTMLElement } = { clamp: true },
  ): void {
    if (!node.file) return;
    // Warm rows (cached HTML) render instantly — no deferral needed. Cold
    // rows (the expensive cachedRead misses) get a placeholder + observer.
    if (this.bodyRenderer.hasFreshRenderCache(node.file) || !this.bodyRenderer.isArmed()) {
      this.renderNoteBodyNow(container, node, opts);
      return;
    }
    container.empty();
    const ph = container.createDiv({ cls: "stashpad-note-text is-plain is-lazy-placeholder" });
    ph.textContent = this.titleForNode(node);
    this.bodyRenderer.defer(container, () => this.renderNoteBodyNow(container, node, opts));
  }

  private renderNoteBodyNow(
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
    void this.bodyRenderer.getOrComputeRender(file).then((entry) => {
      if ((container as any).__stashpadRenderToken !== token) return;
      const { text, attachments, html } = entry;
      // Clear any stale content that earlier renders left behind before
      // appending fresh nodes.
      container.empty();
      const textEl = container.createDiv({ cls: "stashpad-note-text" });
      const expanded = this.expandedNotes.has(node.id);
      if (opts.clamp && !expanded) textEl.addClass("is-clamped");
      // 0.71.23: in compact/tiny modes the row is too short to host
      // rendered markdown — headings overflow, code blocks get clipped
      // mid-line, lists wrap awkwardly. Render the raw text instead so
      // every row reads as plain prose at the same line-height. The
      // markdown HTML is still cached, so toggling back out of
      // compact/tiny re-uses it instantly.
      if (this.compactMode || this.tinyMode) {
        textEl.addClass("is-plain");
        textEl.textContent = text;
      } else {
        // Re-hydrate the cached markdown HTML. The string was produced by
        // Obsidian's own MarkdownRenderer from the user's note and persisted in
        // the render cache; we parse it back into nodes and append them to the
        // (freshly emptied) text element rather than assigning innerHTML
        // (Obsidian lint: no-unsafe-innerHTML). createContextualFragment yields
        // identical DOM — and, like innerHTML, never executes <script> — so
        // event delegation for internal links / tags / embeds still wires up
        // without a fresh MarkdownRenderer pass. (Live-rendered widgets like
        // Mermaid/MathJax are the one weak spot — they won't re-execute from
        // cached HTML, but they're rare in chat-style notes and re-render on
        // the next mtime change anyway.)
        textEl.append(document.createRange().createContextualFragment(html));
      }
      if (attachments.length > 0) this.renderAttachmentRail(container, attachments);
      // Multiplayer footer: author / contributors / last-edit. Each
      // sub-piece is gated by its own toggle in settings; the row only
      // renders if at least one piece is enabled AND has data.
      this.renderAuthorshipFooter(container, node);
      if (!opts.clamp) return;
      // 0.76.7: fast path — if we've already measured this exact body
      // (same path+mtime) at the current list width, reuse the cached
      // overflow decision and skip the scrollHeight read entirely.
      // This is what spares a 200-child Home from 200 layout reflows
      // when one note is added (199 rows hit this branch).
      const memoW = this.lastListWidth;
      if (entry.ovW === memoW && entry.ovV !== undefined && !expanded) {
        if (!entry.ovV) {
          textEl.removeClass("is-clamped");
        } else {
          this.attachExpandToggle(opts, container, node, expanded);
        }
        return;
      }
      // After layout, decide whether to keep the clamp + show the toggle.
      requestAnimationFrame(() => {
        // 0.73.16: if the row is currently auto-expanded by the cursor
        // (CSS rule on .is-cursor-expanded unclamps the text), the
        // overflow check would see scrollHeight == clientHeight and
        // strip .is-clamped — permanently destroying the clamp so the
        // text NEVER re-collapses when the cursor moves away. Bail
        // early when the cursor is on this row; the next renderNoteBody
        // pass (or a future repaint) will measure correctly.
        if (container.closest?.(".stashpad-note.is-cursor-expanded")) return;
        // With line-clamp the text node's clientHeight reflects the
        // 2-line cap; scrollHeight reflects the full unconstrained
        // height. A small tolerance avoids spurious "More" toggles for
        // text that fits in 2 lines exactly.
        const overflowing = textEl.scrollHeight > textEl.clientHeight + 4;
        // Memoize for subsequent re-renders at this width.
        entry.ovW = memoW;
        entry.ovV = overflowing;
        if (!overflowing && !expanded) {
          // Short note that fits — drop the clamp so the fade gradient doesn't apply.
          textEl.removeClass("is-clamped");
          return;
        }
        this.attachExpandToggle(opts, container, node, expanded);
      });
    });
  }

  /** 0.76.7: extracted from renderNoteBody so the cached-overflow fast
   *  path can build the Show-more/less toggle without re-measuring.
   *  Renders the toggle into the caller's host (actions cluster) or
   *  inline below the body, wired to flip expandedNotes + re-render
   *  just this body. */
  private attachExpandToggle(
    opts: { clamp?: boolean; toggleHost?: HTMLElement; toggleAnchor?: HTMLElement },
    container: HTMLElement,
    node: TreeNode,
    expanded: boolean,
  ): void {
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
    // composerDraft. If composerDraft is wrong, fix it at the source. (The old
    // post-restore "clear-X" button went with it — 0.97.x removed the dead code.)

    const composer = parent.createDiv({ cls: "stashpad-composer" });

    // Wrap the textarea so we can absolutely-position the clear-X over it.
    const taWrap = composer.createDiv({ cls: "stashpad-composer-input-wrap" });
    const ta = taWrap.createEl("textarea", {
      cls: "stashpad-composer-input",
      attr: { rows: "2", placeholder: this.composerPlaceholder(enterSubmits, splitMode) },
    }) as HTMLTextAreaElement;
    ta.value = this.composerDraft;

    // Debounce non-empty saves so fast typing doesn't queue a disk write
    // per keystroke (a real issue on slow / network drives). Empty/clear
    // saves still go through immediately on submit/blur for promptness.
    if (!this.debouncedSaveDraft) {
      this.debouncedSaveDraft = debounce((v: string) => { void this.saveDraft(v); }, 250);
    }
    ta.addEventListener("input", () => {
      this.composerDraft = ta.value;
      this.debouncedSaveDraft!(ta.value);
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
        // 0.92.3: mark that Escape just took us OUT of the composer, so a quick
        // follow-up Escape doesn't collapse the multi-selection (see the
        // composerExitAt guard in the list-level Escape handlers).
        this.composerExitAt = Date.now();
        ta.blur();
        this.viewRoot?.focus({ preventScroll: true } as any);
        return false;
      });
      // 0.69.39: Mod+Z / Mod+Shift+Z must reach the textarea's native
      // undo / redo. Without these no-op handlers, composerScope's
      // dispatch would walk to its parent (app.scope) whose Mod+Z
      // handler consumes the event (preventDefault) — blocking
      // browser-native textarea undo. Returning `true` stops scope
      // dispatch here without triggering Keymap's preventDefault, so
      // the DOM keydown reaches the textarea and native undo runs.
      composerScope.register(["Mod"], "z", () => true);
      composerScope.register(["Mod", "Shift"], "z", () => true);
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
      const keyboardTransition = () => { this.keyboardTransitionUntil = Date.now() + 600; };
      ta.addEventListener("focus", () => { document.body.classList.add("stashpad-keyboard-open"); keyboardTransition(); });
      ta.addEventListener("blur", () => {
        document.body.classList.remove("stashpad-keyboard-open");
        keyboardTransition();
        // 0.89.0: tapping the list to dismiss the composer should leave the
        // selected note visible (it may have been hidden behind the composer).
        // Re-reveal after the keyboard's close animation settles the layout.
        if (Platform.isMobile && this.cursorIdx >= 0) setTimeout(() => this.revealCursorRow(), 350);
      });
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
      const clip = this.plugin.noteClipboard;
      // 0.99.9: composer paste = TEXT. The cut/copied note's body drops into the
      // composer so you can fold it into what you're writing — same as pasting a
      // plain copy. (Structural move/duplicate is the LIST paste — cmdPasteNotes,
      // when the list, not the composer, has focus.) A COPY rides the native
      // text paste below. A CUT we insert ourselves — so the text survives the
      // re-render the delete triggers — then delete the original(s).
      if (clip?.mode === "cut" && clip.text && e.clipboardData?.getData("text/plain") === clip.text) {
        if (this.focusedInsideCut(clip.ids)) {
          // Can't paste a cut note into ITSELF or a descendant — you'd delete the
          // note you're inside. (The list paste guards this too.)
          e.preventDefault();
          new Notice("Can't paste a cut note into the note you're cutting.");
          return;
        }
        e.preventDefault();
        // Gathers the FULL subtree text (note + all children), inserts it, then
        // deletes the originals.
        void this.completeCutIntoComposer();
        return;
      }
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
    fileInput.setCssStyles({ display: "none" });

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
      // 0.85.10: pass whether the composer had focus so the picker can
      // refocus it ONLY when dismissed without a pick. The old blind
      // setTimeout(ta.focus, 50/250) fired while the picker was still open
      // and yanked focus/keyboard back to the composer — the reported
      // "cursor stays in the composer" mobile bug.
      const wasFocused = document.activeElement === ta;
      this.openDestinationPicker(wasFocused);
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

    // 0.61.4: render the expand-toggle on BOTH mobile and desktop. CSS
    // controls when it's actually visible — by default desktop hides it
    // (the secondary buttons fit), but when the composer is narrow
    // (`.is-narrow` set by the ResizeObserver below), the toggle shows
    // and the secondary-button group collapses behind it. Tiny mode +
    // compact mode in a small window benefit most.
    const toggleBtn = btnRail.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-rail-toggle" });
    setIcon(toggleBtn, "chevron-left");
    toggleBtn.title = "Show more composer options";
    btnRail.insertBefore(toggleBtn, expandedGroup);
    const setExpanded = (open: boolean): void => {
      btnRail.toggleClass("is-expanded", open);
      toggleBtn.title = open ? "Hide options" : "Show more composer options";
      setIcon(toggleBtn, open ? "chevron-right" : "chevron-left");
    };
    toggleBtn.onmousedown = (e) => e.preventDefault();
    toggleBtn.onclick = (e) => {
      e.preventDefault();
      setExpanded(!btnRail.hasClass("is-expanded"));
    };
    setExpanded(false);
    // 0.61.10: ResizeObserver runs on every platform (no isMobile gate
    // — mobile already has its own narrow rendering and the class is a
    // no-op there). The CSS-only chevron-toggle now triggers when the
    // composer drops below 700px wide. Also do an immediate eager
    // class assignment so the first paint already reflects narrow
    // state without waiting for the observer's first callback.
    const computeNarrow = () => composer.clientWidth < 700;
    const applyNarrow = () => {
      const narrow = computeNarrow();
      composer.toggleClass("is-narrow", narrow);
      // 0.61.12: also collapse the rail when transitioning INTO narrow.
      // The old code only force-expanded on widening; on narrowing we
      // left is-expanded at whatever it was, so the group stayed
      // visible after a wide → narrow resize.
      if (narrow) setExpanded(false);
      else setExpanded(true);
    };
    applyNarrow();
    // 0.63.6 perf: drop the 100ms setTimeout retry — the rAF below
    // catches the post-layout width, and the observer covers later
    // changes. The extra setTimeout fired on every arrow-key render
    // for no observable benefit.
    requestAnimationFrame(applyNarrow);
    const ro = new ResizeObserver(applyNarrow);
    ro.observe(composer);
    this.composerNarrowObserver?.disconnect();
    this.composerNarrowObserver = ro;

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
      // 0.76.15: capture the cross-folder target (if any) before
      // resetting. A remote destination creates the note in that
      // folder without moving this view.
      const destFolder = this.nextDestinationFolder;
      const remote = !!destFolder && destFolder !== this.noteFolder;
      this.nextDestination = null;
      this.nextDestinationFolder = null;
      this.nextDestinationLabel = null;
      // autoSelectNewest only makes sense for LOCAL creates (the new
      // row is in this view). Remote sends leave the local list alone.
      this.autoSelectNewest = !remote;
      this.scrollToBottomOnNextRender = !remote;
      const createOpts = remote ? { targetFolder: destFolder! } : undefined;
      if (split) {
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) await this.createNoteUnder(t, dest, createOpts);
        }
      } else {
        await this.createNoteUnder(text, dest, createOpts);
      }
      // Keep focus in the composer so the user can keep typing without
      // re-clicking — unless the user disabled this in settings.
      if (getSettings().autofocusComposerAfterSend) {
        this.focusComposerOnNextRender = true;
        // 0.76.15: remote sends already rendered inside createNoteUnder
        // (before this flag was set), so restore focus directly.
        if (remote) this.composerInputEl?.focus();
      }
    };
    sendBtn.onclick = () => void submit();

    ta.addEventListener("keydown", (e) => {
      const submitsOnEnter = this.modeEnterSubmits;
      // 0.69.38: Mod+Z / Mod+Shift+Z inside the composer is ALWAYS
      // routed to the textarea's native undo, regardless of whether
      // the textarea is currently empty. Previously, when value.length
      // was 0 we'd route to Stashpad's cmdUndo — intended as a "after
      // submit, Mod+Z undoes the submit" shortcut. But that broke a
      // common pattern: user types text → deletes it via keyboard
      // shortcut (Cmd+Backspace etc.) → presses Mod+Z to restore.
      // The textarea was now empty so Stashpad's undo fired instead
      // of restoring the deleted text, often unwinding the prior
      // note creation. To undo a Stashpad action from the composer
      // now, blur first (Esc) — then Mod+Z hits the view-level
      // binding.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ta.blur();
        this.viewRoot.focus({ preventScroll: true });
        return;
      }
      // ↑ at the very start of the textarea → jump out into the list.
      // 0.80.2: land on the LAST-FOCUSED note for this level (the one that
      // still has the ring), not always the bottommost — so escaping the
      // composer returns you to where you were. Falls back to the last
      // note when there's no remembered cursor.
      if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        ta.blur();
        this.viewRoot.focus({ preventScroll: true });
        if (this.currentChildren.length > 0) {
          const lastId = this.lastCursorByFocus.get(this.focusId) ?? this.lastSelected;
          const idx = lastId ? this.currentChildren.findIndex((n) => n.id === lastId) : -1;
          this.cursorIdx = idx >= 0 ? idx : this.currentChildren.length - 1;
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
    // 0.76.15: cross-folder destination — the parent isn't in this
    // view's tree, so use the label captured at pick time.
    if (this.nextDestinationFolder) return this.nextDestinationLabel ?? this.nextDestinationFolder;
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
    // 0.63.5: defer setting cursorIdx until we know the click's intent.
    // Mod-click-deselect should NOT move the cursor onto the just-
    // deselected row (the residual is-cursor highlight is what the user
    // perceived as a "thin highlight left behind").
    const wasEmpty = this.selection.size === 0;
    if (e.shiftKey && this.lastSelected) {
      this.cursorIdx = idx;
      const lastIdx = this.currentChildren.findIndex((n) => n.id === this.lastSelected);
      if (wasEmpty) this.firstSelectedId = this.lastSelected;
      if (lastIdx !== -1) {
        const [a, b] = lastIdx < idx ? [lastIdx, idx] : [idx, lastIdx];
        for (let i = a; i <= b; i++) this.selection.add(this.currentChildren[i].id);
      } else this.selection.add(node.id);
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selection.has(node.id)) {
        // Deselect — keep cursor off this row entirely. Move it to the
        // most-recently-selected remaining note when possible.
        this.selection.delete(node.id);
        if (this.firstSelectedId === node.id) this.firstSelectedId = null;
        if (this.lastSelected === node.id) {
          this.lastSelected = this.selection.size > 0 ? [...this.selection][this.selection.size - 1] : null;
        }
        if (this.selection.size === 0) {
          this.cursorIdx = -1;
        } else {
          const fallbackId = this.lastSelected ?? [...this.selection][this.selection.size - 1];
          const fallbackIdx = fallbackId ? this.currentChildren.findIndex((n) => n.id === fallbackId) : -1;
          if (fallbackIdx >= 0) this.cursorIdx = fallbackIdx;
        }
      } else {
        this.cursorIdx = idx;
        if (wasEmpty) this.firstSelectedId = node.id;
        this.selection.add(node.id);
      }
    } else if (this.mobileSelectMode) {
      this.cursorIdx = idx;
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
      this.cursorIdx = idx;
      this.selection.clear();
      this.selection.add(node.id);
      this.firstSelectedId = node.id;
      this.lastSelected = node.id;
    }
    if (this.selection.size === 0) this.firstSelectedId = null;
    // 0.63.5: only stamp lastSelected when the click ADDED the row.
    // The Mod-deselect branch already chose a fallback lastSelected
    // (or cleared it); the plain/shift/add paths set it inline.
    if (this.selection.has(node.id)) this.lastSelected = node.id;
    this.viewRoot.focus({ preventScroll: true });
    // 0.73.4 perf: row clicks only mutate selection state — same
    // cheap-repaint path as arrow-key nav. Skips the full
    // this.render() that previously rebuilt every row's DOM (markdown
    // hydrate, drag handlers, etc.) on each click.
    this.repaintSelectionClasses();
    this.revealCursorRow();
    this.stampSelectedCursor();
    this.plugin.notifyStashpadSelectionChanged();
  }

  private revealCursorRow(): void {
    const doReveal = () => {
      if (this.cursorIdx < 0) return;
      const row = this.listEl?.querySelector(`[data-idx="${this.cursorIdx}"]`) as HTMLElement | null;
      if (!row || !this.listEl) return;
      const list = this.listEl;
      const lr = list.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const pad = 4;
      const topBound = lr.top + pad;
      let bottomBound = lr.bottom - pad;
      // 0.89.0 mobile: while the keyboard/composer is up the list extends BEHIND
      // the composer, so a row that's technically "in the list rect" can still
      // be hidden. Clamp the visible bottom to just above the composer so the
      // tapped/selected row scrolls into the area you can actually see.
      if (Platform.isMobile && document.body.classList.contains("stashpad-keyboard-open")) {
        const comp = this.viewRoot?.querySelector(".stashpad-composer") as HTMLElement | null;
        if (comp) bottomBound = Math.min(bottomBound, comp.getBoundingClientRect().top - pad);
      }
      if (rr.top < topBound) list.scrollTop += rr.top - topBound;
      else if (rr.bottom > bottomBound) list.scrollTop += rr.bottom - bottomBound;
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
    if (matchBinding(e, b.commandPalette)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.openStashpadCommandPalette(); return; }
    if (matchBinding(e, b.lockSelection)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdLockSelection(); return; }
    if (matchBinding(e, b.unlockAll)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdUnlockAll(); return; }
    if (matchBinding(e, b.moveToArchive)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdMoveToArchive(); return; }
    if (matchBinding(e, b.encryptDelete)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdEncryptDelete(); return; }
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
      this.pickerEscapeAt = Date.now(); // 0.91.2: suppress the sibling collapse handler
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
      // 0.73.15 perf: arrow-key picker nav used to call full
      // this.render() on every step — on a 200-note list that's the
      // same 100–300ms regression we fixed for normal cursor nav in
      // 0.73.4. Now we just repaint the .is-pick-target class on
      // existing rows and scroll the new target into view.
      // 0.80.4: skip the notes being moved (the current selection) — you
      // can't nest them under themselves, so stepping onto them is wasted
      // motion. Both directions skip, so reversing also hops over the
      // selected run.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.inListPicker.activeIdx = this.nextPickableIdx(this.inListPicker.activeIdx, 1);
        this.repaintSelectionClasses();
        this.revealRowAt(this.inListPicker.activeIdx);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.inListPicker.activeIdx = this.nextPickableIdx(this.inListPicker.activeIdx, -1);
        this.repaintSelectionClasses();
        this.revealRowAt(this.inListPicker.activeIdx);
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); void this.commitInListPicker(); return; }
      // 0.91.0: changed your mind? Pressing the Move (picker) key while the
      // in-list picker is up cancels it and opens the fuzzy move modal on the
      // SAME selection — so "I meant to hit M, not O" doesn't cost you the
      // picker round-trip (or the selection). Honors the user's actual Move
      // binding, not a hard-coded "M".
      if (matchBinding(e, getSettings().bindings.move)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        this.inListPicker = null;
        this.repaintSelectionClasses(); // drop the pick-target highlight
        this.cmdMovePicker();
        return;
      }
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
    // 0.59.0: select all visible notes.
    if (matchBinding(e, b.selectAll)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdSelectAll(); return; }
    if (matchBinding(e, b.swapWithParent)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdSwapWithParent(); return; }

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
      // 0.91.2: if the in-list picker was just cancelled by the sibling Escape
      // handler (it nulled inListPicker before this ran), don't also collapse
      // the multi-selection on the same keypress.
      if (Date.now() - this.pickerEscapeAt < 350) return;
      // 0.92.3: just Escaped out of the composer — preserve the selection
      // through the round-trip (don't let a quick second Escape deselect).
      if (Date.now() - this.composerExitAt < 400) return;
      // 0.99.6: a pending note-clipboard cut/copy in THIS folder is a mode —
      // Escape cancels it (drops the ghost/tint + dismisses the cut notice)
      // before touching the selection. A second Escape then collapses as usual.
      if (this.plugin.noteClipboard && this.plugin.noteClipboard.folder === this.noteFolder) {
        this.plugin.clearNoteClipboard();
        this.render();
        return;
      }
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
      // 0.73.4 perf: collapse-selection on Escape only changes class
      // state — no row content moved. Cheap class repaint instead of
      // a full this.render() saves 100–300ms on big folders.
      this.repaintSelectionClasses();
      this.revealCursorRow();
      return;
    }

    const sb = getSettings().bindings;
    // 0.99.12: PASTE fires regardless of selection/cursor — you can paste into
    // an empty parent, or right after navigating in with no cursor row. (Copy
    // and cut need a target, so they stay in the selection/cursor-gated block
    // below; paste used to be trapped there too, which is why pasting inside a
    // parent only worked when a child happened to be selected/under the cursor.)
    if (matchBinding(e, sb.pasteNotes) && this.plugin.noteClipboard) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdPasteNotes(); return; }
    if (this.selection.size > 0 || (this.cursorIdx >= 0 && this.currentChildren[this.cursorIdx])) {
      if (matchBinding(e, sb.move)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdMovePicker(); return; }
      if (matchBinding(e, sb.pickMove)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdInListPicker(); return; }
      if (matchBinding(e, sb.merge)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdMerge(); return; }
      if (matchBinding(e, sb.copy)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopy(); return; }
      // 0.99.0 note clipboard. Copy/cut defer to the native clipboard when
      // text is highlighted (Mod+C on a text selection must stay normal copy);
      // paste only intercepts when the note clipboard actually holds notes.
      if (matchBinding(e, sb.copyNotes) && !window.getSelection()?.toString()) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyNotes(); return; }
      if (matchBinding(e, sb.cutNotes) && !window.getSelection()?.toString()) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCutNotes(); return; }
      // (pasteNotes is handled above the block — it doesn't need a target.)
      if (matchBinding(e, sb.copyTree)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyTree(); return; }
      if (matchBinding(e, sb.copyOutline)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyOutline(); return; }
      if (matchBinding(e, sb.copyCodeBlock)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyCodeBlock(); return; }
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
      if (matchBinding(e, sb.togglePin)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdTogglePin(); return; }
      if (matchBinding(e, sb.toggleTask)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdToggleTask(); return; }
      if (matchBinding(e, sb.setDue)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdSetDue(); return; }
    }
    // Jump to top/bottom: no selection required — only a non-empty list.
    if (this.currentChildren.length > 0) {
      if (matchBinding(e, sb.jumpToTop)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.jumpToTop(); return; }
      if (matchBinding(e, sb.jumpToBottom)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.jumpToBottom(); return; }
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

  /** 0.80.3: move the cursor to the first / last note in the current list
   *  and reveal it. Single-select (no shift-range). */
  jumpToTop(): void {
    if (this.currentChildren.length === 0) return;
    this.cursorIdx = 0;
    this.selectCursor(false);
  }
  jumpToBottom(): void {
    if (this.currentChildren.length === 0) return;
    this.cursorIdx = this.currentChildren.length - 1;
    this.selectCursor(false);
  }

  private selectCursor(shift: boolean): void {
    const node = this.currentChildren[this.cursorIdx];
    if (!node) return;
    if (!shift) {
      this.selection.clear();
      this.selection.add(node.id);
      this.firstSelectedId = node.id;
      this.lastSelected = node.id;
    } else {
      // 0.73.4 perf: shift-arrow range selection. Backing up toward the
      // anchor drops the just-passed rows. Mirrors text-editor /
      // file-explorer multi-select conventions.
      const anchorId = this.firstSelectedId ?? node.id;
      const anchorIdx = this.currentChildren.findIndex((n) => n.id === anchorId);
      if (anchorIdx === -1) {
        this.selection.add(node.id);
        this.firstSelectedId = node.id;
      } else {
        const [a, b] = anchorIdx < this.cursorIdx ? [anchorIdx, this.cursorIdx] : [this.cursorIdx, anchorIdx];
        this.selection.clear();
        for (let i = a; i <= b; i++) this.selection.add(this.currentChildren[i].id);
        this.firstSelectedId = anchorId;
      }
      this.lastSelected = node.id;
    }
    // 0.73.4 perf: arrow-key nav used to trigger a full this.render(),
    // which rebuilt every row (markdown re-hydration, drag handlers,
    // authorship footer reads, etc.) just to flip two CSS classes. On
    // folders with 200+ notes that was 100–300ms per keystroke. Now
    // we just toggle .is-cursor / .is-selected on existing rows. The
    // selection model is fully described by this.selection +
    // this.cursorIdx, so no rebuild is needed.
    this.repaintSelectionClasses();
    this.revealCursorRow();
    this.stampSelectedCursor();
    // 0.74.1: notify the right-sidebar detail panel so it can refresh
    // to match the new cursor row.
    this.plugin.notifyStashpadSelectionChanged();
  }

  /** O(N rows) class toggle — far cheaper than a full render(). Read
   *  the live selection state and bring each row's .is-cursor /
   *  .is-selected classes in line with it. Used by arrow-key nav and
   *  any other "only the selection changed" path. 0.73.4. */
  private repaintSelectionClasses(): void {
    if (!this.listEl) return;
    const autoExpand = !!this.plugin.settings.autoExpandCursorRow;
    const pickIdx = this.inListPicker?.activeIdx ?? -1;
    const rows = this.listEl.querySelectorAll<HTMLElement>(".stashpad-note");
    rows.forEach((row) => {
      const idx = Number(row.dataset.idx);
      const id = row.dataset.id ?? "";
      const isCursor = idx === this.cursorIdx;
      row.classList.toggle("is-cursor", isCursor);
      row.classList.toggle("is-selected", this.selection.has(id));
      // 0.73.14: transient auto-expand. CSS-only — flips off the
      // clamp on the cursor row's text without mutating the
      // expandedNotes Set, so moving away naturally re-collapses.
      row.classList.toggle("is-cursor-expanded", autoExpand && isCursor);
      // 0.73.15: pick-target class. Used by the in-list parent picker
      // so its arrow-key nav also avoids the full-render rebuild.
      row.classList.toggle("is-pick-target", idx === pickIdx);
    });
  }

  /** 0.73.15: scroll the row at `idx` into view (centered when far
   *  out of viewport, nearest edge when close). Cheap alternative to
   *  a full render() when we just need to follow a moving cursor /
   *  picker target. */
  private revealRowAt(idx: number): void {
    if (!this.listEl) return;
    const row = this.listEl.querySelector<HTMLElement>(`.stashpad-note[data-idx="${idx}"]`);
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const listRect = this.listEl.getBoundingClientRect();
    if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
      row.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  /** public: called by AuthorshipTracker (the host interface). */
  getActionTargets(): TreeNode[] {
    if (this.selection.size > 0) {
      return [...this.selection].map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n && !!n.file);
    }
    const cur = this.currentChildren[this.cursorIdx];
    return cur ? [cur] : [];
  }

  // --- Public commands (used by main.ts addCommand too) ---

  /** 0.98.10: lock (encrypt) the selected note(s) — or the cursor row if nothing
   *  is selected — into `.stashenc` bundle(s) in place. Command-palette /
   *  keybind counterpart of the context-menu "Encrypt (lock) note + children".
   *  If a parent AND one of its descendants are both selected, only the parent
   *  is locked (its subtree already subsumes the descendant). */
  async cmdLockSelection(): Promise<void> {
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice("Set up encryption first (Settings → Encryption).");
      return;
    }
    const targets = this.getActionTargets();
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    // Drop targets nested under another target (a parent lock already subsumes its
    // descendants) AND any target already represented by a locked bundle — both
    // would otherwise double-process a subtree.
    const alreadyLocked = new Set((this.plugin.settings.lockedSubtrees ?? []).map((e) => e.rootId).filter((x): x is StashpadId => !!x));
    const roots = targets.filter((t) => {
      if (alreadyLocked.has(t.id)) return false;
      let p = t.parent;
      while (p) { if (ids.has(p)) return false; p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) { new Notice("Nothing to lock (already locked)."); return; }
    let locked = 0;
    for (const t of roots) {
      // Capture the preceding sibling in any explicit manual order, so unlock can
      // drop the note back into the same slot (mirrors the context-menu handler).
      const order = this.order.getOrder(this.noteFolder, t.parent ?? ROOT_ID);
      const idx = order.indexOf(t.id);
      const prevSibling = idx > 0 ? order[idx - 1] : null;
      // Silent per-item; one summary toast below (a batch shouldn't spam).
      const r = await this.plugin.lockNoteSubtree(this.noteFolder, t.id, prevSibling, { silent: true });
      if (r) locked++;
    }
    if (locked > 0) {
      this.selection.clear();
      this.lastSelected = null;
      this.render();
      this.plugin.notifications.show({ message: `Locked ${locked} stash${locked === 1 ? "" : "es"}.`, kind: "success", category: "system", folder: this.noteFolder });
    }
  }

  /** 0.98.28 (Phase 4): move the selected note(s) into an archive folder, which
   *  auto-encrypts them on arrival. Uses the default archive folder if set; else
   *  the only archive folder if there's just one; else offers a pick-list. */
  async cmdMoveToArchive(): Promise<void> {
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice("Set up encryption first (Settings → Encryption)."); return;
    }
    const archives = (this.plugin.settings.archiveFolders ?? []).filter((f) => f !== this.noteFolder);
    if (archives.length === 0) {
      new Notice("No archive folder available. Mark a folder as archive first (folder panel → right-click → “Mark as archive”).", 8000);
      return;
    }
    const targets = this.getActionTargets();
    if (targets.length === 0) return;
    const def = this.plugin.settings.defaultArchiveFolder;
    const dest = (def && archives.includes(def)) ? def : (archives.length === 1 ? archives[0] : null);
    const go = (folder: string) => { void this.archiveSources(targets, folder); };
    if (dest) { go(dest); return; }
    // Several archives, no default → pick one.
    new ArchiveFolderSuggestModal(this.app, archives, go).open();
  }

  /** 0.98.34 (Phase 4): archive the given notes into `dest` — encrypt each root's
   *  subtree with the BLOB written into the archive folder (so the 🔒 stub appears
   *  there) while reading + deleting the plaintext from THIS source folder. Pushes
   *  ONE undo entry that restores them to the source folder (Ctrl+Z). Clicking the
   *  stub's Unlock later restores in the archive folder, as before. No file move +
   *  no async hook, so undo is a clean self-contained reversal. */
  private async archiveSources(sources: TreeNode[], dest: string): Promise<void> {
    const src = this.noteFolder;
    const ids = new Set(sources.map((t) => t.id));
    const roots = sources.filter((t) => {
      let p = t.parent;
      while (p) { if (ids.has(p)) return false; p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) return;
    const rootIds = roots.map((r) => r.id);
    let blobs: string[] = [];
    for (const t of roots) {
      const order = this.order.getOrder(src, t.parent ?? ROOT_ID);
      const idx = order.indexOf(t.id);
      const prevSibling = idx > 0 ? order[idx - 1] : null;
      const r = await this.plugin.lockNoteSubtree(src, t.id, prevSibling, { silent: true, blobFolder: dest });
      if (r) blobs.push(r.blobPath);
    }
    if (blobs.length === 0) return;
    this.selection.clear(); this.lastSelected = null; this.tree.rebuild(src); this.render();
    const name = dest.split("/").pop() || dest;
    this.plugin.notifications.show({ message: `Archived ${blobs.length} note${blobs.length === 1 ? "" : "s"} → “${name}”. Undo to bring ${blobs.length === 1 ? "it" : "them"} back.`, kind: "success", category: "system", folder: src });
    this.plugin.getUndoStack(src).push({
      label: `Archive (${blobs.length})`,
      undo: async () => {
        // Restore the blobs back to the SOURCE folder (not the archive folder).
        for (const b of blobs) { try { await this.plugin.unlockBundleAt(b, { silent: true, destFolder: src }); } catch (e) { console.warn("[Stashpad] archive undo failed", b, e); } }
        blobs = [];
        this.tree.rebuild(src); this.render();
      },
      redo: async () => {
        blobs = [];
        for (const id of rootIds) { const r = await this.plugin.lockNoteSubtree(src, id, null, { silent: true, blobFolder: dest }); if (r) blobs.push(r.blobPath); }
        this.tree.rebuild(src); this.render();
      },
    });
  }

  /** 0.98.29 (Phase 5): encrypt the selected note(s) + children and move them to
   *  Stashpad's encrypted trash (`_deleted/`), permanently removing the plaintext.
   *  Recoverable via "Restore from encrypted trash". Confirm-gated. */
  async cmdEncryptDelete(): Promise<void> {
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice("Set up encryption first (Settings → Encryption)."); return;
    }
    const targets = this.getActionTargets();
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    const roots = targets.filter((t) => {
      let p = t.parent;
      while (p) { if (ids.has(p)) return false; p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) return;
    const n = roots.length;
    new ConfirmModal(
      this.app,
      `Encrypt & delete ${n} note${n === 1 ? "" : "s"}?`,
      [
        `The selected note${n === 1 ? "" : "s"} (and any children) will be encrypted and moved to Stashpad's encrypted trash.`,
        ``,
        `• The readable copy is permanently removed from the folder.`,
        `• You can restore ${n === 1 ? "it" : "them"} later from the encrypted trash — you'll need your encryption password.`,
        `• If you lose your password, ${n === 1 ? "it's" : "they're"} gone for good.`,
      ].join("\n"),
      "Encrypt & delete",
      async (ok) => {
        // Route through secureDeleteSources so it pushes a Ctrl+Z undo entry
        // (previously this manual loop left nothing for Undo to grab — Mod+Z fell
        // through to the composer).
        if (ok) await this.secureDeleteSources(roots);
      },
    ).open();
  }

  /** 0.98.30 (Phase 5): securely delete the given source notes from THIS folder
   *  (encrypt → `_deleted/`, plaintext gone), recording this folder as the origin,
   *  and push ONE undo entry that restores them right back here. Called by the
   *  trash-folder move divert. No confirm (the trash-folder gesture is the intent;
   *  Undo is the safety net). */
  private async secureDeleteSources(sources: TreeNode[]): Promise<void> {
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice("Set up encryption first (Settings → Encryption)."); return;
    }
    const ids = new Set(sources.map((t) => t.id));
    const roots = sources.filter((t) => {
      let p = t.parent;
      while (p) { if (ids.has(p)) return false; p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) return;
    const folder = this.noteFolder;
    const rootIds = roots.map((r) => r.id);
    let blobs: string[] = [];
    for (const id of rootIds) { const b = await this.plugin.encryptDeleteSubtree(folder, id); if (b) blobs.push(b); }
    if (blobs.length === 0) return;
    this.selection.clear(); this.lastSelected = null; this.tree.rebuild(folder); this.render();
    this.plugin.notifications.show({ message: `Securely deleted ${blobs.length} note${blobs.length === 1 ? "" : "s"} → encrypted trash. Undo to bring ${blobs.length === 1 ? "it" : "them"} back.`, kind: "success", category: "system", folder });
    this.plugin.getUndoStack(folder).push({
      label: `Secure delete (${blobs.length})`,
      undo: async () => {
        for (const b of blobs) { try { await this.plugin.restoreDeletedAt(b, { silent: true }); } catch (e) { console.warn("[Stashpad] secure-delete undo failed", b, e); } }
        blobs = [];
        this.tree.rebuild(folder); this.render();
      },
      redo: async () => {
        blobs = [];
        for (const id of rootIds) { const b = await this.plugin.encryptDeleteSubtree(folder, id); if (b) blobs.push(b); }
        this.tree.rebuild(folder); this.render();
      },
    });
  }

  /** 0.98.12: decrypt (unlock) locked stashes back into place. Counterpart to
   *  cmdLockSelection. Recursively unlocks every locked stash under the action
   *  target's subtree (0.98.12.02), falling back to the focused view's locked set.
   *  Each blob is independent — we unlock them one by one, SKIPPING any that fail
   *  the encrypted-envelope check or have already been removed (so a half-finished
   *  batch never corrupts or double-imports). */
  async cmdUnlockAll(): Promise<void> {
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice("Set up encryption first (Settings → Encryption).");
      return;
    }
    // Target-aware + RECURSIVE: point at a DECRYPTED parent note and unlock
    // decrypts every locked stash anywhere in its subtree (you can't cursor a
    // locked stub itself). We expand each target to itself + all descendant
    // notes, then collect the locked stashes hanging off any of them. (A locked
    // parent keeps its children INSIDE its blob, so locked entries only ever
    // anchor to currently-decrypted notes — the live tree walk reaches them all.)
    // If a target's subtree has no locked stashes — e.g. the stubs are top-level
    // siblings you can't put a cursor on — fall back to the focused view's set.
    const blobs = new Set<string>();
    const scope = new Set<StashpadId>();
    const stack = this.getActionTargets().map((t) => t.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (scope.has(id)) continue;
      scope.add(id);
      for (const c of this.tree.getChildren(id)) stack.push(c.id);
    }
    for (const id of scope) {
      for (const lk of this.plugin.lockedSubtreesFor(this.noteFolder, id)) blobs.add(lk.blob);
    }
    if (blobs.size === 0) {
      const focusedId = (this.tree.get(this.focusId) ?? this.tree.getRoot()).id;
      for (const lk of this.plugin.lockedSubtreesFor(this.noteFolder, focusedId)) blobs.add(lk.blob);
    }
    if (blobs.size === 0) { new Notice("No locked notes to unlock here."); return; }
    if (!(await this.plugin.ensureEncryptionUnlocked())) return;
    let unlocked = 0;
    for (const blob of blobs) {
      // unlockBundleAt re-checks the file exists + is a valid encrypted envelope
      // (isEncryptedStash) and returns false / throws otherwise — so a stale or
      // bad path is skipped, not fatal to the rest of the batch.
      try { if (await this.plugin.unlockBundleAt(blob, { silent: true })) unlocked++; }
      catch (e) { console.warn("[Stashpad] batch unlock skipped", blob, e); }
    }
    if (unlocked > 0) {
      this.selection.clear();
      this.lastSelected = null;
      this.render();
      this.plugin.notifications.show({ message: `Unlocked ${unlocked} stash${unlocked === 1 ? "" : "es"}.`, kind: "success", category: "system", folder: this.noteFolder });
    }
  }

  toggleSplit(): void {
    const cur = this.modeSplit ?? getSettings().splitOnLines;
    this.modeSplit = !cur;
    this.render();
    this.composerInputEl?.focus();
  }

  openDestinationPicker(refocusComposerOnDismiss = false): void {
    // 0.76.36: do NOT blur the composer here. On iOS, blur() dismisses the
    // soft keyboard, and once dismissed a programmatic focus() on the
    // picker input can't bring it back (iOS only re-summons the keyboard
    // inside a live user gesture). Instead the picker focuses its own
    // input synchronously inside the tap gesture (see note-picker onOpen),
    // which lets iOS hop the keyboard straight from the composer textarea
    // to the picker input without ever dismissing it.
    // 0.85.10: `picked` tracks whether a selection was made so onClose can
    // refocus the composer ONLY on dismiss (Esc / tap-out) — never while
    // the picker is open (which was stealing the keyboard back to the
    // composer on mobile).
    let picked = false;
    // 0.57.2: destination picker now spans all Stashpad folders + offers
    // each external Stashpad's root (Home) as its own pick. Picking a
    // cross-folder destination switches the view to that folder first
    // (matching the search modal's behaviour), then sets nextDestination
    // there — so the next composer submit lands in the right place.
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "pick", placeholder: "Send next note(s) under which note?",
      allowCreate: true,
      onPick: async (item) => {
        picked = true;
        if (item.crossFolder) {
          const targetId = item.crossId ?? item.id.replace(/^cross:/, "");
          // 0.76.15: DON'T switch folders. Record the cross-folder
          // destination; the next submit ships the note there while
          // this view stays exactly where it is. Composer content is
          // untouched (no folder switch to clear it).
          this.nextDestination = targetId;
          this.nextDestinationFolder = item.crossFolder;
          const folderName = item.crossFolder.split("/").pop() || item.crossFolder;
          const noteTitle = targetId === ROOT_ID
            ? "Home"
            : (item.crossFile?.basename ?? "note").replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ");
          this.nextDestinationLabel = `${folderName} ▸ ${noteTitle}`;
          this.render();
          this.composerInputEl?.focus();
          return;
        }
        this.nextDestination = item.id;
        this.nextDestinationFolder = null;
        this.nextDestinationLabel = null;
        this.render();
        this.composerInputEl?.focus();
      },
      onCreate: async (q) => {
        picked = true;
        const id = await this.createNoteUnder(q, this.focusId);
        if (id) {
          this.nextDestination = id;
          this.nextDestinationFolder = null;
          this.nextDestinationLabel = null;
          this.render();
          this.composerInputEl?.focus();
        }
      },
      crossFolderNotes: () => this.collectCrossFolderDestinations(),
      // 0.92.1: only offer "Search excluded folders" when there actually are
      // excluded Stashpad folders (else the callback stays undefined and the
      // bottom action never renders).
      excludedFolderNotes: this.excludedSearchFolders().length > 0
        ? () => this.collectExcludedFolderNotes()
        : undefined,
      onClose: () => {
        // Only when the picker was dismissed WITHOUT a pick: hop focus (and
        // the mobile keyboard) back to the composer. This fires inside the
        // dismiss gesture (Esc / tap-out), so iOS re-summons the keyboard.
        // On a successful pick, onPick already refocused the composer.
        if (refocusComposerOnDismiss && !picked) this.composerInputEl?.focus();
      },
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
    // 0.71.22: attach the home note's file so the picker can fill a
    // body preview via cachedRead — matters when the home note has
    // been renamed/customized.
    const homeFileByFolder = new Map<string, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folders.includes(dir)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: string } | undefined;
      if (fm?.id === ROOT_ID) homeFileByFolder.set(dir, f);
    }
    const roots = folders.map((folder) => {
      const homeFile = homeFileByFolder.get(folder);
      return {
        file: homeFile,
        folder,
        id: ROOT_ID,
        title: `Home — ${folder.split("/").pop() || folder}`,
        body: "",
      };
    });
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
      const seen = new Set<StashpadId>();   // cycle guard
      let cur: TreeNode | undefined = this.tree.get(id);
      while (cur && cur.id !== ROOT_ID && !seen.has(cur.id)) {
        seen.add(cur.id);
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

  /** 0.69.35: track the currently-open Stashpad search modal so a
   *  second press of the keybind selects-all in the existing modal's
   *  input (escape any popover the user is in + clear-by-typing). */
  private openSearchInstance: StashpadSuggest | null = null;
  openSearchModal(): void {
    // If a search modal is already open, focus its input + select all
    // so the next keystroke replaces the query. Don't stack a new modal.
    if (this.openSearchInstance) {
      const existing = (this.openSearchInstance as any).inputEl as HTMLInputElement | undefined;
      if (existing) {
        existing.focus();
        existing.select();
      }
      return;
    }
    const instance = new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "search", placeholder: "Search Stashpad notes…",
      // 0.69.22 / 0.69.24 / 0.69.25: Create flow opens a destination
      // picker. The picker spans EVERY searchable Stashpad folder so
      // the user can drop the new note under any parent across the
      // vault — not just within the active folder. Picking a
      // cross-folder parent switches the view to that folder first
      // (via setFolderOverride / rebuild), then creates the note
      // under the picked parent.
      allowCreate: true,
      onCreate: async (q) => {
        const trimmed = q.trim();
        if (!trimmed) return;
        new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
          mode: "pick",
          placeholder: `Create "${trimmed}" under which note?`,
          allowCreate: false,
          crossFolderNotes: () => this.collectCrossFolderDestinations(),
      // 0.92.1: only offer "Search excluded folders" when there actually are
      // excluded Stashpad folders (else the callback stays undefined and the
      // bottom action never renders).
      excludedFolderNotes: this.excludedSearchFolders().length > 0
        ? () => this.collectExcludedFolderNotes()
        : undefined,
          folderResults: () => this.plugin.discoverStashpadFolders().filter((f) => f !== this.noteFolder),
          localFolder: this.noteFolder,
          // 0.69.26: always spawn a NEW Stashpad tab on the picked
          // parent's folder + focus, then create the note in that
          // fresh view. Avoids hijacking the current tab and works
          // identically for local and cross-folder parent picks.
          onPick: async (picked) => {
            const parentId = picked.crossFolder
              ? (picked.crossId ?? picked.id.replace(/^cross:/, ""))
              : picked.node?.id;
            const folder = picked.crossFolder ?? this.noteFolder;
            if (!parentId) return;
            const settingsFolder = (this.plugin.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "") || "Stashpad";
            const ws = this.app.workspace;
            const leaf = ws.getLeaf("tab");
            await leaf.setViewState({
              type: STASHPAD_VIEW_TYPE,
              active: true,
              state: {
                focusId: parentId,
                folderOverride: folder === settingsFolder ? null : folder,
              },
            });
            ws.revealLeaf(leaf);
            // The freshly-mounted view rebuilt its tree during
            // setViewState. Reach into it to create the note + navigate.
            const newView = leaf.view as any;
            if (newView && typeof newView.createNoteUnder === "function") {
              const newId = await newView.createNoteUnder(trimmed, parentId);
              if (newId && typeof newView.navigateTo === "function") newView.navigateTo(newId);
            }
          },
        }).open();
      },
      onPick: (item) => {
        // 0.57.3: folder-open picks open the target folder in a new tab,
        // leaving the current tab on its current folder. Useful for
        // quickly side-by-side comparing two Stashpad folders.
        if (item.kind === "folder-open" && item.folder) {
          void this.openFolderInNewTab(item.folder);
          return;
        }
        // 0.96.0: when "Search results open in a new tab" is on (default), pick
        // opens the result in a fresh tab; off = the old in-place navigation.
        const newTab = this.plugin.settings.searchOpensInNewTab !== false;
        if (item.crossFolder && item.crossFile) {
          // Cross-Stashpad result: switch this view's folder and focus
          // the picked note. The setState path rebuilds the tree, so by
          // the time render runs we can navigate to the picked id.
          const targetId = item.crossId ?? item.id.replace(/^cross:/, "");
          if (newTab) void this.openNoteInNewTab(item.crossFolder, targetId);
          else void this.switchToFolderAndFocus(item.crossFolder, targetId);
          return;
        }
        if (item.node) {
          if (newTab) void this.openNoteInNewTab(this.noteFolder, item.node.id);
          else this.navigateTo(item.node.id);
        }
      },
      crossFolderNotes: () => this.collectCrossFolderDestinations(),
      // 0.92.1: only offer "Search excluded folders" when there actually are
      // excluded Stashpad folders (else the callback stays undefined and the
      // bottom action never renders).
      excludedFolderNotes: this.excludedSearchFolders().length > 0
        ? () => this.collectExcludedFolderNotes()
        : undefined,
      folderResults: () => this.plugin.discoverStashpadFolders().filter((f) => f !== this.noteFolder),
      // 0.64.0: search modal gets the filter chips row.
      showFilterChips: true,
      // 0.69.3: show the active folder badge on local results too.
      localFolder: this.noteFolder,
    });
    this.openSearchInstance = instance;
    // Wrap onClose to clear our tracked reference when the modal closes.
    const prevOnClose = instance.onClose.bind(instance);
    instance.onClose = (): void => {
      prevOnClose();
      if (this.openSearchInstance === instance) this.openSearchInstance = null;
    };
    instance.open();
  }

  /** Walk the vault for every Stashpad note that lives in a folder
   *  eligible for cross-Stashpad search (per settings), excluding the
   *  active folder (those are already in the local tier). */
  /** 0.92.1: the discovered Stashpad folders currently EXCLUDED from search
   *  (via searchExcludedFolders or the include-allowlist), minus the active
   *  folder. Cheap — used to decide whether to offer "Search excluded folders". */
  private excludedSearchFolders(): string[] {
    const searchable = new Set(this.plugin.searchableFolders(this.noteFolder));
    return this.plugin.discoverStashpadFolders()
      .filter((f) => f !== this.noteFolder && !searchable.has(f));
  }

  /** 0.92.1: notes (+ synthetic home roots) from the EXCLUDED folders — the
   *  on-demand source behind the picker's "Search excluded folders" action. */
  private collectExcludedFolderNotes(): import("./note-picker").CrossFolderNote[] {
    const folders = this.excludedSearchFolders();
    if (!folders.length) return [];
    const notes = this.collectCrossFolderNotes(folders);
    const homeFileByFolder = new Map<string, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folders.includes(dir)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: string } | undefined;
      if (fm?.id === ROOT_ID) homeFileByFolder.set(dir, f);
    }
    const roots = folders.map((folder) => ({
      file: homeFileByFolder.get(folder),
      folder,
      id: ROOT_ID,
      title: `Home — ${folder.split("/").pop() || folder}`,
      body: "",
    }));
    return [...roots, ...notes];
  }

  private collectCrossFolderNotes(folderList?: string[]): import("./note-picker").CrossFolderNote[] {
    const out: import("./note-picker").CrossFolderNote[] = [];
    const folders = (folderList ?? this.plugin.searchableFolders(this.noteFolder))
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
        // 0.71.22: skip the folder's home note here — it's surfaced via
        // the synthetic "Home — <folder>" entry in
        // `collectCrossFolderDestinations` so it doesn't appear twice.
        if (id === ROOT_ID) continue;
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
        out.push({ file, folder, id, title, body: "", parentBlurb, parentId: parentId ?? null });
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
      // 0.97.x fix: `moved` already holds the outdented TreeNodes — the old code
      // ran them back through tree.get() (which wants an id), getting undefined
      // for every entry so the message listed nothing; and passed node objects
      // as affectedIds. Use the nodes directly + map to ids.
      this.plugin.notifications.show({
        message: this.bulkActionMessage({
          verb: "Outdented",
          nodes: moved,
          suffix: skipped.length ? `(${skipped.length} already at root)` : undefined,
        }),
        kind: "success",
        category: "move",
        affectedIds: moved.map((n) => n.id),
        folder: this.noteFolder,
      });
    }
    // 0.72.6 / 0.73.8: optionally follow the outdented note(s) into
    // their new (shared) grandparent. Works only when every moved
    // target shares the same destination; mixed-source outdents
    // would otherwise surprise-jump somewhere arbitrary. The earlier
    // version excluded ROOT_ID entirely — that broke the common
    // "outdent a child of Note A back to Home" case (the user was
    // focused on Note A, dest was ROOT_ID, nav was skipped). Now we
    // only skip when the dest IS the current focus (already there,
    // nothing to navigate to).
    if (this.plugin.settings.autoNavOnMoveOut && moved.length > 0) {
      const dest = moved[0].parent;
      const allShareDest = dest != null && moved.every((m) => m.parent === dest);
      if (allShareDest && dest !== this.focusId) this.navigateTo(dest);
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
        // 0.59.0: capture prior color per target so we can undo. null
        // (or absent) means "no color set."
        const priors: { id: StashpadId; path: string; was: string | null }[] = [];
        for (const t of targets) {
          if (!t.file) continue;
          priors.push({ id: t.id, path: t.file.path, was: this.colorForNode(t) ?? null });
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
        // 0.59.0: push an undo entry so the user can reverse a color
        // change with Cmd+Z. Restores each target's prior color (or
        // removes the color frontmatter entirely if there was none).
        const undoFolder = this.noteFolder;
        const newColor = color;
        const applyColors = async (mapping: { path: string; col: string | null }[]) => {
          for (const m of mapping) {
            const file = this.app.vault.getAbstractFileByPath(m.path) as TFile | null;
            if (!file) continue;
            try {
              await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (m.col) fm.color = m.col;
                else delete fm.color;
              });
            } catch {}
          }
          this.tree.rebuild(undoFolder);
          this.render();
        };
        this.plugin.getUndoStack(undoFolder).push({
          label: priors.length === 1 ? "Color change" : `Color change (${priors.length})`,
          undo: () => applyColors(priors.map((p) => ({ path: p.path, col: p.was }))),
          redo: () => applyColors(priors.map((p) => ({ path: p.path, col: newColor }))),
        });
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
          const newParentId = item.crossId ?? item.id.replace(/^cross:/, "");
          await this.moveAcrossFolders(targets, item.crossFolder, newParentId);
          this.selection.clear(); this.render();
          return;
        }
        const newParent = item.id;
        // 0.91.1: quiet per-note moves + one consolidated persistent toast.
        const childCounts = new Map(targets.map((t) => [t.id, this.tree.getChildren(t.id).length]));
        const movedTargets: TreeNode[] = [];
        for (const t of targets) {
          if (await this.changeParent(t, newParent, { silentSuccess: true })) movedTargets.push(t);
        }
        this.notifyBatchMove(movedTargets, newParent, childCounts);
        this.selection.clear(); this.render();
        // 0.72.6 / 0.73.8: optionally follow the moved note(s) into
        // the new parent. Skip only when the destination IS the
        // current focus (no nav needed). The earlier ROOT_ID guard
        // assumed Home is always the focus — wrong when the user is
        // focused on a sub-parent and picks Home as destination.
        if (this.plugin.settings.autoNavOnMoveOut && newParent !== this.focusId) {
          this.navigateTo(newParent);
        }
      },
      onCreate: async (q) => {
        const newId = await this.createNoteUnder(q, this.focusId);
        if (!newId) return;
        const childCounts = new Map(targets.map((t) => [t.id, this.tree.getChildren(t.id).length]));
        const movedTargets: TreeNode[] = [];
        for (const t of targets) {
          if (await this.changeParent(t, newId, { silentSuccess: true })) movedTargets.push(t);
        }
        this.notifyBatchMove(movedTargets, newId, childCounts);
        this.selection.clear(); this.render();
        if (this.plugin.settings.autoNavOnMoveOut) this.navigateTo(newId);
      },
      // 0.57.2: use the same cross-folder + synthetic-root list the
      // destination picker uses, so a move can target "Home of folder X"
      // as a one-shot result without searching for it.
      crossFolderNotes: () => this.collectCrossFolderDestinations(),
      // 0.92.1: only offer "Search excluded folders" when there actually are
      // excluded Stashpad folders (else the callback stays undefined and the
      // bottom action never renders).
      excludedFolderNotes: this.excludedSearchFolders().length > 0
        ? () => this.collectExcludedFolderNotes()
        : undefined,
      // 0.64.1: move picker also gets the advanced filter chips — same
      // in:/before:/after:/on: syntax helps narrow long destination lists.
      showFilterChips: true,
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

    // 0.86.7: this loop only wrote the canonical `parent` id — the recovery
    // wikilink fields (`parentLink` on the moved notes, `children` on the old +
    // new parents) were left stale, so a moved note's parentLink kept pointing
    // at the OLD folder. Refresh recovery fields for BOTH folders (source:
    // drop the moved note from the old parent's children; dest: rebuild the
    // moved note's parentLink + the new parent's children). Deferred so the
    // metadata cache reflects the move; skip-if-equal so it only writes what
    // changed; honours the writeRecoveryLinks setting.
    if (getSettings().writeRecoveryLinks) {
      const sourceFolder = this.noteFolder;
      window.setTimeout(() => {
        void rebootstrapFolderFrontmatter(this.app, sourceFolder);
        void rebootstrapFolderFrontmatter(this.app, targetDir);
      }, 350);
    }

    // 0.91.2: name the moved notes from the pre-move `sources` (they're gone
    // from this folder's tree after the move, so the old tree.get() lookup
    // always came back empty → "N notes" with no titles). `sources` are the
    // original TreeNodes, still resolvable for titles.
    const titleSummary = this.titleList(sources);
    // Source view loses these notes; rebuild + render.
    this.tree.rebuild(this.noteFolder);
    // 0.59.0: cross-folder move notice gets a Jump-to-destination action
    // (intra-folder moves already had one). Action switches THIS view
    // to the target folder + navigates to the new parent (or Home when
    // the new parent is ROOT_ID).
    // 0.72.1: action labels are short verbs now — the destination
    // context already lives in the message body.
    const destLabel = newParentId === ROOT_ID ? "Open home" : "Open parent";
    // 0.91.2: PERSISTENT (duration 0). A cross-folder move renames files on
    // disk, so Obsidian fires its own burst of "link update" notices that bury
    // a 4s toast before the user can read it or click the button. Keep ours up
    // until dismissed so the Open-destination button stays reachable.
    const totalNested = Math.max(0, plan.length - sources.length);
    const movedSummary = sources.length === 1
      ? `Moved ${titleSummary}${totalNested > 0 ? ` and its ${totalNested} nested note${totalNested === 1 ? "" : "s"}` : ""} → \`${targetDir}\``
      : `Moved ${titleSummary}${totalNested > 0 ? ` (${totalNested} nested)` : ""} → \`${targetDir}\``;
    this.plugin.notifications.show({
      message: movedSummary,
      kind: "success",
      category: "move",
      duration: 0,
      affectedIds: sources.map((s) => s.id),
      folder: this.noteFolder,
      actions: [{
        label: destLabel,
        onClick: () => { void this.switchToFolderAndFocus(targetDir, newParentId); },
      }],
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

  /** 0.80.4: next index from `from` in `dir` whose note isn't part of the
   *  current selection (the notes being moved — invalid as their own
   *  parent). Stays put if there's no unselected note that way. */
  private nextPickableIdx(from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < this.currentChildren.length; i += dir) {
      const node = this.currentChildren[i];
      if (node && !this.selection.has(node.id)) return i;
    }
    return from;
  }

  private cmdInListPicker(): void {
    if (this.currentChildren.length === 0) return;
    // Pre-select the note above the cursor (the most common nest target).
    // Falls back to index 0 when the cursor is already at the top.
    let start = this.cursorIdx > 0 ? this.cursorIdx - 1 : 0;
    // 0.80.4: if that lands on a note being moved, hop to the nearest
    // unselected one (look up first, then down).
    if (this.currentChildren[start] && this.selection.has(this.currentChildren[start].id)) {
      const up = this.nextPickableIdx(start, -1);
      start = up !== start ? up : this.nextPickableIdx(start, 1);
    }
    this.inListPicker = { activeIdx: start };
    // 0.91.0: surface the "switch to the full move picker" shortcut, using the
    // user's actual Move binding (default M) so the hint stays accurate.
    const moveBind = getSettings().bindings.move;
    const moveLabel = humanCombo(moveBind.primary || moveBind.secondary || "M");
    new Notice(`Arrows to pick parent, Enter confirms, ${moveLabel} for the full picker, Esc cancels.`);
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
    // 0.91.1: move quietly (no per-note success toasts), then emit ONE
    // consolidated persistent notification with a Jump-to-destination button.
    // Capture child counts BEFORE moving so the summary is accurate even if a
    // metadata-driven tree rebuild races the notification.
    const childCounts = new Map(targets.map((t) => [t.id, this.tree.getChildren(t.id).length]));
    const movedTargets: TreeNode[] = [];
    for (const t of targets) {
      if (await this.changeParent(t, target.id, { silentSuccess: true })) movedTargets.push(t);
    }
    this.notifyBatchMove(movedTargets, target.id, childCounts);
    // 0.72.6: optional auto-navigate INTO the destination parent so
    // the user follows their moved note. Skips the select-in-place
    // flow below because navigateTo rebuilds the view for the new
    // focus anyway.
    if (this.plugin.settings.autoNavOnMoveIn) {
      this.navigateTo(target.id);
      return;
    }
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
      const idx = this.currentChildren.findIndex((n) => n.id === target.id);
      if (idx < 0) return; // destination not in the list yet — a later pass catches it
      // Re-assert BOTH selection AND cursor on the destination only. After the
      // move the list shifts up (the moved note vanished), so the initial render
      // can leave the cursor on the destination's STALE index — which now points
      // at the NEXT note. (Previously this bailed as soon as the selection
      // matched, so it never corrected that stale cursor.) Bail only when both
      // selection and cursor are already exactly the destination.
      if (this.selection.size === 1 && this.selection.has(target.id) && this.cursorIdx === idx) return;
      this.selection.clear();
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

  // Clipboard commands — implementations live in commands/clipboard-cmds.ts.
  // These thin delegators keep the public method names stable for the keydown
  // dispatcher + main.ts's call("<method>") palette wiring.
  cmdCopy(): Promise<void> { return clipboardCmds.cmdCopy(this); }
  cmdCopyCodeBlock(): Promise<void> { return clipboardCmds.cmdCopyCodeBlock(this); }
  cmdCopyTree(): Promise<void> { return clipboardCmds.cmdCopyTree(this); }
  cmdCopyOutline(): Promise<void> { return clipboardCmds.cmdCopyOutline(this); }

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
    // 0.67.4: SAFETY CHECK — refuse to clone a node into itself or a
    // descendant of itself. Previously, picking the Home note as the
    // insert-template target made cloneSubtree recurse infinitely:
    // each iteration added a clone to Home's children, which the
    // for-loop below then saw and cloned again, ad infinitum.
    if (source.id === newParent || this.isDescendant(newParent, source.id)) {
      new Notice(`Can't insert "${this.titleForNode(source)}" into itself or a descendant — that would loop forever.`);
      return null;
    }
    // SNAPSHOT children NOW, before insertSynthetic mutates source's
    // parent's children list. Otherwise the just-inserted clone shows
    // up in the iteration and we recurse onto it.
    const childrenSnapshot = this.tree.getChildren(source.id).slice();
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

    // Recurse into children — each becomes a child of the just-cloned
    // node. 0.67.4: use the pre-insert snapshot, NEVER call
    // getChildren again at this depth.
    for (const c of childrenSnapshot) {
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

  // ---- 0.99.0: note clipboard — copy / cut / paste of note BLOCKS ----
  // Runs in parallel with the system clipboard: copy/cut also put the bodies
  // on the system clipboard as text (so pasting in the composer or any app
  // works normally); paste IN THE LIST operates on the notes themselves.

  async cmdCopyNotes(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) { new Notice("Nothing to copy."); return; }
    await clipboardCmds.cmdCopy(this); // bodies → system clipboard (+ toast)
    this.plugin.clearNoteClipboard(); // drop any prior cut/copy (+ its notice)
    this.plugin.noteClipboard = { mode: "copy", folder: this.noteFolder, ids: targets.map((t) => t.id) };
    this.render(); // paint the .is-copy-pending tint
  }

  /** True when `id` is on a pending CUT in THIS folder — drives the ghosted
   *  `.is-cut-pending` row style until the cut is pasted, replaced, or cancelled. */
  isCutPending(id: StashpadId): boolean {
    const clip = this.plugin.noteClipboard;
    return !!clip && clip.mode === "cut" && clip.folder === this.noteFolder && clip.ids.includes(id);
  }
  /** True when `id` is on a pending COPY in THIS folder — drives the subtle
   *  `.is-copy-pending` tint (lighter than cut; nothing moves on paste). */
  isCopyPending(id: StashpadId): boolean {
    const clip = this.plugin.noteClipboard;
    return !!clip && clip.mode === "copy" && clip.folder === this.noteFolder && clip.ids.includes(id);
  }

  /** Insert text into the composer at the caret (or append), updating the
   *  persisted draft so it survives a re-render (the new textarea seeds from
   *  `composerDraft`). Used by cut-paste-into-composer. */
  private insertIntoComposer(text: string): void {
    const ta = this.composerInputEl;
    if (!ta) { this.composerDraft = this.composerDraft ? `${this.composerDraft}\n\n${text}` : text; return; }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const caret = start + text.length;
    try { ta.setSelectionRange(caret, caret); } catch { /* detached */ }
    this.composerDraft = ta.value;
  }

  /** True when the note you're focused INTO is one of `ids` (or a descendant of
   *  one) — i.e. pasting that cut here would delete the note you're viewing. */
  private focusedInsideCut(ids: StashpadId[]): boolean {
    const set = new Set(ids);
    let cur: StashpadId | null = this.focusId;
    let hops = 0;
    while (cur && cur !== ROOT_ID && hops++ < 1000) {
      if (set.has(cur)) return true;
      cur = this.tree.get(cur)?.parent ?? null;
    }
    return false;
  }

  async cmdCutNotes(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) { new Notice("Nothing to cut."); return; }
    const out: string[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      out.push(this.stripFrontmatter(await this.app.vault.cachedRead(t.file)).trim());
    }
    const cutText = out.join("\n\n");
    await navigator.clipboard.writeText(cutText);
    this.plugin.clearNoteClipboard(); // drop any prior cut/copy (+ its notice)
    this.plugin.noteClipboard = { mode: "cut", folder: this.noteFolder, ids: targets.map((t) => t.id), text: cutText };
    this.render(); // paint the ghosted .is-cut-pending rows immediately
    // Persistent: a pending cut is a MODE — the user should see it until they
    // paste or cancel (Escape). Stored so it can be dismissed on resolve.
    this.plugin.noteClipboardNotice = this.plugin.notifications.show({
      message: `Cut ${this.titleList(targets)} — paste in the LIST to move it there as a note; paste in a note's COMPOSER to drop its text in and delete the original (undoable). Esc cancels. Nothing happens until you paste.`,
      kind: "info", category: "system", affectedIds: targets.map((t) => t.id), folder: this.noteFolder, duration: 0,
    });
  }

  async cmdPasteNotes(): Promise<void> {
    const clip = this.plugin.noteClipboard;
    if (!clip) { new Notice("The note clipboard is empty — copy or cut notes first."); return; }
    // Cross-folder paste: the source notes live in another Stashpad folder, so
    // route through the plugin's bundle-based engine — it carries ATTACHMENTS
    // into this folder's _attachments, mints fresh ids for a copy (keeps them for
    // a cut), and refuses an archive/auto-encrypting destination.
    if (clip.folder !== this.noteFolder) {
      const cursorX = this.currentChildren[this.cursorIdx] ?? null;
      const destParent = ((cursorX?.parent ?? this.focusId) ?? ROOT_ID) as StashpadId;
      const mode = clip.mode;
      const srcFolder = clip.folder;
      const result = await this.plugin.crossFolderPaste(srcFolder, clip.ids, this.noteFolder, destParent, mode);
      if (!result || !result.rootIds.length) return; // refused (archive) / nothing found — Notice already shown
      if (mode === "cut") this.plugin.clearNoteClipboard();
      const folder = this.noteFolder;
      this.tree.rebuild(folder);
      this.pendingFocusIds = result.rootIds.slice();
      this.render();
      if (mode === "cut") this.plugin.refreshOpenViewsForFolder(srcFolder); // source lost notes
      const srcLabel = srcFolder.split("/").pop();
      const n = result.rootIds.length;
      // Undo/redo: the engine returns reversible file-level closures; we wrap them
      // with a rebuild + render of THIS folder and a refresh of the source folder.
      const refreshBoth = () => { this.tree.rebuild(folder); this.render(); this.plugin.refreshOpenViewsForFolder(srcFolder); };
      this.plugin.getUndoStack(folder).push({
        label: `${mode === "cut" ? "Move" : "Paste"} ${n} note${n === 1 ? "" : "s"} from ${srcLabel}`,
        undo: async () => { await result.undo(); refreshBoth(); },
        redo: async () => { await result.redo(); refreshBoth(); },
      });
      const verb = mode === "cut" ? "Moved" : "Pasted (copied)";
      this.plugin.notifications.show({
        message: `${verb} ${n} note${n === 1 ? "" : "s"} (${result.noteCount} total) from "${srcLabel}" into this folder. Undo (in the list) reverses it.`,
        kind: "success", category: mode === "cut" ? "move" : "clone", affectedIds: result.rootIds, folder, duration: 0,
      });
      return;
    }
    const nodes = clip.ids.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n && !!n.file);
    if (!nodes.length) { this.plugin.clearNoteClipboard(); this.render(); new Notice("Those notes no longer exist."); return; }
    // Paste position: after the cursor row (same parent); fall back to the
    // focused subtree root when there's no cursor.
    const cursor = this.currentChildren[this.cursorIdx] ?? null;
    const parentId = ((cursor?.parent ?? this.focusId) ?? ROOT_ID) as StashpadId;

    if (clip.mode === "cut") {
      // Cycle guard: never paste a subtree under itself/its own descendant.
      const cutIds = new Set(clip.ids);
      for (let p: StashpadId | null = parentId; p && p !== ROOT_ID; p = this.tree.get(p)?.parent ?? null) {
        if (cutIds.has(p)) { new Notice("Can't paste cut notes under themselves."); return; }
      }
      // moveAcrossThenReorder pushes the undo entry + persistent notification.
      const anchor = cursor && !cutIds.has(cursor.id) ? cursor.id : "";
      // Clear the clipboard BEFORE the move so its re-render doesn't re-apply
      // the .is-cut-pending ghost to the just-moved rows (ids already captured).
      this.plugin.clearNoteClipboard();
      await this.moveAcrossThenReorder(nodes.map((n) => n.id), parentId, anchor, "after");
      return;
    }

    // copy → duplicate with fresh ids at the paste target (same machinery as
    // cmdClone, but parented where the user pasted; clipboard stays loaded so
    // repeated pastes make repeated duplicates).
    const folder = this.noteFolder;
    const createdPaths: string[] = [];
    const newRootIds: StashpadId[] = [];
    for (const n of nodes) {
      const id = await this.cloneSubtree(n, parentId, createdPaths);
      if (id) newRootIds.push(id);
    }
    if (!newRootIds.length) return;
    this.tree.rebuild(folder);
    this.pendingFocusIds = newRootIds.slice();
    this.render();
    const snapNodes: TreeNode[] = createdPaths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => !!f && (f as any).extension === "md")
      .map((file) => ({ id: parseIdFromFilename(file.basename) ?? file.basename, parent: null, children: [], file, created: new Date().toISOString() }));
    const snap = await this.snapshotNotes(snapNodes, false);
    this.plugin.getUndoStack(folder).push({
      label: `Paste ${newRootIds.length} note${newRootIds.length === 1 ? "" : "s"}`,
      undo: async () => {
        for (const p of [...createdPaths].reverse()) {
          const f = this.app.vault.getAbstractFileByPath(p) as TFile | null;
          if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
        }
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => { await this.restoreSnapshots(snap, newRootIds); },
    });
    const pastedRoots = newRootIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
    this.plugin.notifications.show({
      message: this.bulkActionMessage({ verb: "Pasted (duplicated)", nodes: pastedRoots, suffix: `(${createdPaths.length} file${createdPaths.length === 1 ? "" : "s"} total)` }),
      kind: "success", category: "clone", affectedIds: newRootIds, folder, duration: 0,
    });
  }

  /** Composer paste of CUT notes: the textarea's native paste already inserted
   *  the bodies (they're on the system clipboard); this completes the cut by
   *  deleting the original notes + their subtrees (snapshot-undoable). */
  async completeCutIntoComposer(): Promise<void> {
    const clip = this.plugin.noteClipboard;
    if (!clip || clip.mode !== "cut") return;
    if (clip.folder !== this.noteFolder) {
      // Cross-folder cut → composer: the cut text is on the system clipboard
      // (clip.text); insert it here, then trash the source subtree(s). This is the
      // "fold the text into what I'm writing" path — no structural move.
      const srcFolder = clip.folder;
      const rootIds = clip.ids.slice();
      this.plugin.clearNoteClipboard();
      // Build the SAME indented bullet outline as the same-folder path (note +
      // all children, 2-space indent per depth, optional time prefix), reading
      // the source subtree from disk since it isn't in this view's tree.
      const ordered = await this.plugin.orderedSubtreeNodes(srcFolder, rootIds);
      const prefixTs = getSettings().prefixTimestampsOnCopy;
      const outline: string[] = [];
      for (const { file, created, depth } of ordered) {
        try {
          const body = this.stripFrontmatter(await this.app.vault.cachedRead(file)).trim().split(/\r?\n/).join(" ");
          const ts = prefixTs ? `${this.formatTimeInline(created)} ` : "";
          outline.push(`${"  ".repeat(depth)}- ${ts}${body}`);
        } catch { /* skip unreadable */ }
      }
      this.insertIntoComposer(outline.length ? outline.join("\n") : (clip.text ?? ""));
      // Snapshot the source BEFORE trashing so undo can restore it.
      const snapPaths = await this.plugin.subtreeFilePaths(srcFolder, rootIds);
      const snap = await this.plugin.snapshotPaths(snapPaths);
      const trashed = await this.plugin.trashSubtrees(srcFolder, rootIds);
      this.plugin.refreshOpenViewsForFolder(srcFolder);
      const noteN = trashed.filter((f) => f.extension === "md").length;
      this.plugin.getUndoStack(srcFolder).push({
        label: `Cut ${rootIds.length} note${rootIds.length === 1 ? "" : "s"} into composer (from ${srcFolder.split("/").pop()})`,
        undo: async () => { await this.plugin.restoreSnapshot(snap); this.plugin.refreshOpenViewsForFolder(srcFolder); },
        redo: async () => { await this.plugin.trashSubtrees(srcFolder, rootIds); this.plugin.refreshOpenViewsForFolder(srcFolder); },
      });
      this.plugin.notifications.show({
        message: `Pasted the text of ${rootIds.length} cut note${rootIds.length === 1 ? "" : "s"} from "${srcFolder.split("/").pop()}" into the composer and removed the original${noteN === 1 ? "" : "s"} (${noteN} note${noteN === 1 ? "" : "s"}). Undo restores them.`,
        kind: "warning", category: "delete", affectedIds: rootIds, folder: srcFolder, duration: 0,
      });
      return;
    }
    this.plugin.clearNoteClipboard();
    const roots = clip.ids.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n && !!n.file);
    if (!roots.length) return;
    // PRE-order (parent → children) WITH depth so the text reads as an indented
    // outline; dedup overlaps.
    const pre: { node: TreeNode; depth: number }[] = [];
    const seen = new Set<StashpadId>();
    const walk = (n: TreeNode, depth: number): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      pre.push({ node: n, depth });
      for (const c of this.tree.getChildren(n.id)) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    const folder = this.noteFolder;
    // Drop the WHOLE subtree into the composer as an INDENTED BULLET OUTLINE —
    // same format as the "Copy tree" command (2-space indent per depth, "- "
    // bullet, body flattened to one line, optional time prefix) — then delete
    // the originals (children-first = reverse pre-order).
    const prefixTs = getSettings().prefixTimestampsOnCopy;
    const lines: string[] = [];
    for (const { node, depth } of pre) {
      if (!node.file) continue;
      try {
        const body = this.stripFrontmatter(await this.app.vault.cachedRead(node.file)).trim().split(/\r?\n/).join(" ");
        const ts = prefixTs ? `${this.formatTimeInline(node.created)} ` : "";
        lines.push(`${"  ".repeat(depth)}- ${ts}${body}`);
      } catch { /* skip unreadable */ }
    }
    this.insertIntoComposer(lines.join("\n"));
    const allNotes = pre.map((x) => x.node);
    const snap = await this.snapshotNotes(allNotes, false);
    for (const n of [...allNotes].reverse()) {
      if (!n.file) continue;
      try { await this.app.fileManager.trashFile(n.file); } catch (e) { console.warn("[Stashpad] cut-paste delete failed", n.file.path, e); }
    }
    this.selection.clear();
    this.tree.rebuild(folder);
    this.render();
    const rootIds = roots.map((r) => r.id);
    this.plugin.getUndoStack(folder).push({
      label: `Cut ${roots.length} note${roots.length === 1 ? "" : "s"} into composer`,
      undo: async () => { await this.restoreSnapshots(snap, rootIds); },
      redo: async () => {
        for (const sn of [...snap.notes]) {
          const f = this.app.vault.getAbstractFileByPath(sn.path) as TFile | null;
          if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
    this.plugin.notifications.show({
      message: `Pasted the text of ${this.titleList(roots)} into the composer and deleted the original${roots.length === 1 ? "" : "s"} (${allNotes.length} note${allNotes.length === 1 ? "" : "s"}). Undo (in the list) restores them.`,
      kind: "warning", category: "delete", affectedIds: rootIds, folder, duration: 0,
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
    // 0.67.0: record pre-change state so back can return here. Skip
    // when keepForwardStack:true (the legacy "we're navigating via
    // back/forward, don't disturb history" signal).
    if (!opts.keepForwardStack) this.recordNavState();
    // 0.56.9: invalidate pending tryReselect timers from prior mutations so
    // they don't apply a stale selection in the new focus.
    this.selectionGuardKey++;
    if (this.listEl) {
      // 0.56.17: stamp last-selected cursor for the focus we're leaving
      // so returning restores to it via scroll-to-id.
      this.stampSelectedCursor(true);
    }
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
    // 0.74.6: drilling into a different note is a genuine selection
    // change — the detail panel should follow. (render() above only
    // fires content-changed, which keeps the panel pinned.)
    this.plugin.notifyStashpadSelectionChanged();
  }

  /** Browser-style back: pop the back stack, push current onto forward,
   *  apply. 0.67.0 — restores folder switches too, not just tree-up.
   *  0.67.2: when the back stack is empty (e.g. fresh reload), fall
   *  through to navigateUp so the user still has a way to climb out
   *  of a deeply-focused state. */
  navigateBack(): void {
    const target = this.navBackStack.pop();
    if (!target) {
      // Fallback: walk up the tree if there's anywhere to go.
      if (this.focusId !== ROOT_ID) this.navigateUp();
      return;
    }
    this.navForwardSnapshots.push(this.captureNavSnapshot());
    void this.applyNavSnapshot(target);
  }
  /** Browser-style forward: pop forward, push current onto back, apply. */
  navigateForward(): void {
    const target = this.navForwardSnapshots.pop();
    if (!target) return;
    this.navBackStack.push(this.captureNavSnapshot());
    void this.applyNavSnapshot(target);
  }

  /** Apply a {folder, focusId} snapshot to the live view, handling the
   *  cross-folder case (delegate to setFolderOverride with skipHistory)
   *  and the intra-folder case (just navigate). 0.67.0. */
  private async applyNavSnapshot(snap: NavSnapshot): Promise<void> {
    this.tagFilter = null;
    this.colorFilter = null;
    if (snap.folder !== this.noteFolder) {
      await this.setFolderOverride(snap.folder, { skipHistory: true });
      // After folder switch the view is at ROOT_ID; nudge focus to the
      // captured focusId if it differs and exists in the new tree.
      if (snap.focusId !== this.focusId && this.tree.get(snap.focusId)) {
        this.focusId = snap.focusId;
        this.render({ kind: "preserve" });
      }
      return;
    }
    if (!this.tree.get(snap.focusId)) return;
    this.selectionGuardKey++;
    if (this.listEl) this.stampSelectedCursor(true);
    this.focusId = snap.focusId;
    this.persistFocus();
    this.defaultCursorToLast();
    this.syncComposerDraftForFocus();
    const savedCursorId = this.lastCursorByFocus.get(snap.focusId);
    let policy: ScrollPolicy;
    if (savedCursorId && this.tree.get(savedCursorId)) {
      this.pendingFocusIds = [savedCursorId];
      policy = { kind: "scroll-to-id", id: savedCursorId, align: "start" };
    } else {
      policy = { kind: "preserve" };
    }
    this.render(policy);
    this.refreshHeaderTitle();
    this.viewRoot.focus({ preventScroll: true });
  }

  private navigateUp(): void {
    this.selectionGuardKey++;
    // History nav (back / Up arrow / Backspace) clears tag + color
    // filters for the same reason as navigateForward.
    this.tagFilter = null;
    this.colorFilter = null;
    const node = this.tree.get(this.focusId);
    if (!node || node.parent == null) {
      // Already at home — if there's history, go back through it instead
      // of being a dead-end.
      if (this.navBackStack.length > 0) { this.navigateBack(); return; }
      return this.navigateTo(ROOT_ID);
    }
    const cameFrom = this.focusId;
    // 0.67.0: record current state on the back stack so a subsequent
    // back can return here. navigateUp is itself a recordable nav.
    this.recordNavState();
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
    // 0.80.3 / 0.82.4: pin the note we came from to the TOP of the view
    // (when it's still present in the parent list). NOTE: the align value
    // is passed to scrollIntoView({ block }), which only accepts
    // start/center/end/nearest — "top" was invalid and silently did
    // nothing (cursor set, but scroll stayed at 0). "start" = top.
    if (idx >= 0) this.render({ kind: "scroll-to-id", id: cameFrom, align: "start" });
    else this.render({ kind: "follow-cursor" });
    this.refreshHeaderTitle();
    // Belt-and-suspenders reveal in the fallback case.
    if (idx < 0) this.revealCursorRow();
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
    const lastSeg = folder.split("/").filter(Boolean).pop() ?? "Stashpad";
    const slug = lastSeg
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `Home-${slug || "Stashpad"}.md`;
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
  /** 0.96.0: open a search result in a NEW Stashpad tab, focused on the picked
   *  note (in its own folder). Mirrors openFolderInNewTab but lands on a note
   *  instead of the folder root. Used by the search modal when
   *  searchOpensInNewTab is on. */
  private async openNoteInNewTab(folder: string, noteId: string): Promise<void> {
    const cleaned = (folder || "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned || !noteId) return;
    const settingsFolder = (this.plugin.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "") || "Stashpad";
    const ws = this.app.workspace;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        focusId: noteId,
        folderOverride: cleaned === settingsFolder ? null : cleaned,
      },
    });
    ws.setActiveLeaf(leaf, { focus: true } as any);
    ws.revealLeaf(leaf);
  }

  private async openFolderInNewTab(folder: string): Promise<void> {
    const cleaned = (folder || "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const settingsFolder = (this.plugin.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "") || "Stashpad";
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
  /** Add every visible note to the selection. Default Mod+A. 0.59.0. */
  cmdSelectAll(): void {
    if (this.currentChildren.length === 0) return;
    this.selection.clear();
    for (const n of this.currentChildren) this.selection.add(n.id);
    this.firstSelectedId = this.currentChildren[0].id;
    this.lastSelected = this.currentChildren[this.currentChildren.length - 1].id;
    this.cursorIdx = this.currentChildren.length - 1;
    this.render();
  }

  /** Toggle the sidebar-pin state of every action-target (cursor row or
   *  selection; falls back to focused note). 0.68.1. */
  async cmdTogglePin(): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to pin."); return; }
    // If any target is unpinned, pin all; else unpin all (mirrors
    // cmdToggleComplete's "majority-toward-action" heuristic).
    const anyUnpinned = targets.some((t) => !this.plugin.isPinned({ folder: this.noteFolder, id: t.id }));
    let pinned = 0, unpinned = 0;
    for (const t of targets) {
      const ref = { folder: this.noteFolder, id: t.id };
      if (anyUnpinned) {
        if (!this.plugin.isPinned(ref)) { await this.plugin.pinNote(ref); pinned++; }
      } else {
        if (this.plugin.isPinned(ref)) { await this.plugin.unpinNote(ref); unpinned++; }
      }
    }
    if (pinned > 0) new Notice(`Pinned ${pinned} note${pinned === 1 ? "" : "s"} to sidebar.`);
    else if (unpinned > 0) new Notice(`Unpinned ${unpinned} note${unpinned === 1 ? "" : "s"} from sidebar.`);
  }

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
      this.completedState.set(t.file.path, newState); // 0.76.11
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

  /** 0.76.11 / 0.76.32: completed-state OVERRIDE per path. Holds only
   *  values written authoritatively — our own toggles + the
   *  metadataCache "changed" listener (which fires as files parse).
   *  isCompleted prefers an override when present (keeps a row stable
   *  during the synthetic create-render, when getFileCache can
   *  transiently return stale frontmatter for siblings); otherwise it
   *  reads the LIVE cache.
   *
   *  0.76.32 fix: we no longer lazily cache a live read into the map.
   *  That poisoned hide-completed on mobile cold start — the first
   *  render ran before frontmatter parsed, cached `false` for a
   *  completed note, and the cached value stuck forever (so the note
   *  was treated as incomplete). Reading live when there's no override
   *  self-corrects on the parse-triggered re-render, and the "changed"
   *  listener still fills the map for create-render stability. */
  private completedState = new Map<string, boolean>();
  /** 0.85.1: task-TAG OVERRIDE per path — the exact analogue of
   *  `completedState`, for the SAME reason. The task TOGGLE read tag-ness
   *  (`isTaskTagged`) straight from the live metadataCache, both to DECIDE the
   *  toggle direction and to RENDER. On a slow/network drive the cache reparse
   *  lags well past the write, so the immediate `render()` showed stale state
   *  AND the next toggle re-read "not yet tagged" → re-toggled the same way (a
   *  no-op), so the change only landed on the *next* press ("n+1"). Our own
   *  writes set this authoritatively before the render; the "changed" listener
   *  resyncs it once the cache is fresh. Holds tag-ness (what `isTaskTagged`
   *  returns); `isTask` builds on it (+ the bare `completed` field). Reads fall
   *  back to the live cache when there's no override. */
  private taskTaggedState = new Map<string, boolean>();

  private isCompleted(node: TreeNode): boolean {
    if (!node.file) return false;
    const override = this.completedState.get(node.file.path);
    if (override !== undefined) return override;
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
    return !!fm?.completed;
  }

  /** Tag-ness of a frontmatter shape: the `task` tag or the legacy `task: true`
   *  boolean (NOT the bare `completed` field — that's `isTask`, not tagged). */
  private taggedFromFm(fm: any): boolean {
    if (!fm) return false;
    return fmHasTag(fm, "task") || fm.task === true;
  }

  /** 0.76.1: open the due-date picker for the action targets and write
   *  (or clear) the `due` frontmatter. Setting a due date also marks
   *  the note(s) as a task so they surface in the Tasks panel. Bound
   *  to D by default. Pre-fills from the first target's existing due. */
  cmdSetDue(): void {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to schedule."); return; }
    const first = targets[0];
    const curFm = first.file ? this.app.metadataCache.getFileCache(first.file)?.frontmatter as any : null;
    const current = curFm && (typeof curFm.due === "string" || typeof curFm.due === "number") ? String(curFm.due) : null;
    // 0.78.1: offer known authors (registry, newest-first) for assignment,
    // and pre-fill any assignees already on the first target.
    const knownAuthors = this.plugin.collectKnownAuthors();
    const currentAssignees = parseAssignees(curFm ?? {});
    new DueDatePickerModal(this.app, current, (result) => {
      void this.applyDue(targets, result.iso, result.assignees);
    }, { knownAuthors, currentAssignees }).open();
  }

  /** Write the chosen due value (or clear it) across `targets`, with
   *  undo. Setting a date also flips `task: true`; clearing leaves the
   *  task flag intact (clearing a due ≠ "no longer a task"). */
  private async applyDue(targets: TreeNode[], iso: string | null, assignees: Array<{ id: string; name: string }> = []): Promise<void> {
    const prior: { id: StashpadId; path: string; due: unknown; task: unknown; assignedTo: unknown; assignedBy: unknown; wasTagged: boolean }[] = [];
    const changedIds: StashpadId[] = [];
    // 0.78.1: who is doing the assigning (the local user) — stamped as
    // assignedBy so the "assigned by me" filter works. Null if the user
    // hasn't set an author name.
    const me = this.authorship.currentAuthorLink();
    // Ensure an author stub exists in THIS folder for each assignee so
    // their wikilink resolves (free-entry names mint a fresh stub).
    for (const a of assignees) {
      await this.plugin.ensureAuthorStubFor(this.noteFolder, a.id, a.name);
    }
    const assignLinks = assignees.map((a) => this.plugin.authorRefFor(this.noteFolder, a.id, a.name));
    for (const t of targets) {
      if (!t.file) continue;
      const fm = this.app.metadataCache.getFileCache(t.file)?.frontmatter as any;
      const wasTagged = this.isTaskTagged(t);
      prior.push({ id: t.id, path: t.file.path, due: fm?.due, task: fm?.task, assignedTo: fm?.assignedTo, assignedBy: fm?.assignedBy, wasTagged });
      await this.app.fileManager.processFrontMatter(t.file, (m) => {
        if (iso === null) delete m.due;
        else { m.due = iso; m.task = true; }
        // Assignment: empty list clears it; any assignment also flips the
        // task flag (assigning makes it a task even without a due date).
        if (assignLinks.length > 0) {
          m.assignedTo = assignLinks;
          if (me) m.assignedBy = me.link;
          m.task = true;
        } else {
          delete m.assignedTo;
          delete m.assignedBy;
        }
      });
      // 0.85.1: a due date or an assignment makes it a task; clearing leaves
      // task-ness unchanged. Set the override so the checkbox shows now, not n+1.
      const becomesTask = iso !== null || assignLinks.length > 0;
      this.taskTaggedState.set(t.file.path, becomesTask || wasTagged);
      changedIds.push(t.id);
    }
    this.render();
    if (changedIds.length > 0) {
      const nodes = changedIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
      this.plugin.notifications.show({
        message: this.bulkActionMessage({
          verb: iso === null ? "Cleared due date" : `Due ${formatDateTime(Date.parse(iso), this.plugin.settings)}`,
          nodes,
        }),
        kind: "success",
        category: "edit",
        affectedIds: changedIds,
        folder: this.noteFolder,
      });
    }
    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: iso === null ? `Clear due date (${targets.length})` : `Set due date (${targets.length})`,
      undo: async () => {
        for (const p of prior) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (m) => {
            if (p.due === undefined) delete m.due; else m.due = p.due;
            if (p.task === undefined) delete m.task; else m.task = p.task;
            if (p.assignedTo === undefined) delete m.assignedTo; else m.assignedTo = p.assignedTo;
            if (p.assignedBy === undefined) delete m.assignedBy; else m.assignedBy = p.assignedBy;
          });
          this.taskTaggedState.set(p.path, p.wasTagged); // 0.85.1
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.78.3: standalone assign command — assign people to the target
   *  task(s) without touching the due date. Opens AssignModal pre-filled
   *  with the first target's current assignees. */
  cmdAssign(): void {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to assign."); return; }
    const first = targets[0];
    const curFm = first.file ? this.app.metadataCache.getFileCache(first.file)?.frontmatter as any : null;
    const knownAuthors = this.plugin.collectKnownAuthors();
    const currentAssignees = parseAssignees(curFm ?? {});
    new AssignModal(this.app, { knownAuthors, currentAssignees }, (assignees) => {
      void this.applyAssignees(targets, assignees);
    }).open();
  }

  /** Write `assignedTo`/`assignedBy` across `targets` (without touching
   *  `due`), with undo. An empty list clears the assignment. Assigning
   *  also flips `task: true`. */
  private async applyAssignees(targets: TreeNode[], assignees: Array<{ id: string; name: string }>): Promise<void> {
    const me = this.authorship.currentAuthorLink();
    for (const a of assignees) {
      await this.plugin.ensureAuthorStubFor(this.noteFolder, a.id, a.name);
    }
    const assignLinks = assignees.map((a) => this.plugin.authorRefFor(this.noteFolder, a.id, a.name));
    const prior: { path: string; assignedTo: unknown; assignedBy: unknown; task: unknown; wasTagged: boolean }[] = [];
    const changedIds: StashpadId[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const fm = this.app.metadataCache.getFileCache(t.file)?.frontmatter as any;
      const wasTagged = this.isTaskTagged(t);
      prior.push({ path: t.file.path, assignedTo: fm?.assignedTo, assignedBy: fm?.assignedBy, task: fm?.task, wasTagged });
      await this.app.fileManager.processFrontMatter(t.file, (m) => {
        if (assignLinks.length > 0) {
          m.assignedTo = assignLinks;
          if (me) m.assignedBy = me.link;
          m.task = true;
        } else {
          delete m.assignedTo;
          delete m.assignedBy;
        }
      });
      // 0.85.1: assigning makes it a task; clearing leaves task-ness unchanged.
      this.taskTaggedState.set(t.file.path, assignLinks.length > 0 || wasTagged);
      changedIds.push(t.id);
    }
    this.render();
    if (changedIds.length > 0) {
      const nodes = changedIds.map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n);
      const names = assignees.map((a) => a.name).join(", ");
      this.plugin.notifications.show({
        message: this.bulkActionMessage({
          verb: assignLinks.length > 0 ? `Assigned to ${names}` : "Cleared assignment",
          nodes,
        }),
        kind: "success",
        category: "edit",
        affectedIds: changedIds,
        folder: this.noteFolder,
      });
    }
    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: assignLinks.length > 0 ? `Assign (${targets.length})` : `Clear assignment (${targets.length})`,
      undo: async () => {
        for (const p of prior) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (m) => {
            if (p.assignedTo === undefined) delete m.assignedTo; else m.assignedTo = p.assignedTo;
            if (p.assignedBy === undefined) delete m.assignedBy; else m.assignedBy = p.assignedBy;
            if (p.task === undefined) delete m.task; else m.task = p.task;
          });
          this.taskTaggedState.set(p.path, p.wasTagged); // 0.85.1
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.76.3: a note is a task when it carries the `task` tag in
   *  frontmatter. (Legacy: the 0.76.1 `task: true` boolean and a bare
   *  `completed` field also count, so older test notes still show.)
   *  The checkbox STATE is the `completed` field — false = open
   *  (unfilled box), true = done (checked box). */
  private isTask(node: TreeNode): boolean {
    if (!node.file) return false;
    // Tag-ness from the override (fresh on slow drives), OR the bare `completed`
    // field (panel inclusion) read live — that part still self-corrects via the
    // metadataCache repaint, but it doesn't gate the task toggle.
    if (this.isTaskTagged(node)) return true;
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter as any;
    return fm?.completed !== undefined;
  }

  /** 0.76.3: mark/unmark the selection (or cursor row, or focused
   *  note) as a task. Marking adds the `task` tag and sets
   *  `completed: false` (an unfilled checkbox) unless it's already
   *  done. Unmarking strips the tag + the completed field. Mixed
   *  selections resolve toward "make all tasks." Undo/redo via a
   *  frontmatter snapshot. Bound to H by default. */
  async cmdToggleTask(): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to toggle."); return; }

    const makeTask = targets.some((t) => !this.isTaskTagged(t));
    // Snapshot the full prior frontmatter shape we touch (tags +
    // completed + legacy task) so undo restores exactly.
    const prior: { id: StashpadId; path: string; tags: unknown; completed: unknown; task: unknown; wasTagged: boolean }[] = [];
    const changedIds: StashpadId[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const wasTagged = this.isTaskTagged(t);
      const fmNow = this.app.metadataCache.getFileCache(t.file)?.frontmatter as any;
      prior.push({ id: t.id, path: t.file.path, tags: fmNow?.tags, completed: fmNow?.completed, task: fmNow?.task, wasTagged });
      if (wasTagged === makeTask) continue;
      let nowCompleted = false;
      await this.app.fileManager.processFrontMatter(t.file, (m: any) => {
        if (makeTask) {
          fmAddTag(m, "task");
          if (m.completed === undefined) m.completed = false; // unfilled checkbox
          nowCompleted = m.completed === true;
          delete m.task; // drop the legacy 0.76.1 boolean
        } else {
          fmRemoveTag(m, "task");
          delete m.completed;
          delete m.task;
          nowCompleted = false;
        }
      });
      this.completedState.set(t.file.path, nowCompleted); // 0.76.11
      this.taskTaggedState.set(t.file.path, makeTask);           // 0.85.1
      changedIds.push(t.id);
    }
    this.render();
    if (changedIds.length > 0) {
      // 0.76.3: title-first wording — '"Foo" marked as task'.
      const verb = makeTask ? "marked as task" : "unmarked as task";
      let message: string;
      if (changedIds.length === 1) {
        const n = this.tree.get(changedIds[0]);
        const title = n ? (this.titleForNode(n).trim() || "(untitled)") : "(untitled)";
        message = `"${title}" ${verb}`;
      } else {
        message = `${changedIds.length} notes ${verb}`;
      }
      this.plugin.notifications.show({
        message,
        kind: "success",
        category: "edit",
        affectedIds: changedIds,
        folder: this.noteFolder,
      });
    }

    const folder = this.noteFolder;
    const restore = async () => {
      for (const p of prior) {
        const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
        if (!f) continue;
        await this.app.fileManager.processFrontMatter(f, (m: any) => {
          if (p.tags === undefined) delete m.tags; else m.tags = p.tags;
          if (p.completed === undefined) delete m.completed; else m.completed = p.completed;
          if (p.task === undefined) delete m.task; else m.task = p.task;
        });
        this.completedState.set(p.path, !!p.completed); // 0.85.1: pre-cache-event
        this.taskTaggedState.set(p.path, p.wasTagged);
      }
      this.tree.rebuild(folder);
      this.render();
    };
    this.plugin.getUndoStack(folder).push({
      label: `${makeTask ? "Mark task" : "Unmark task"} (${targets.length})`,
      undo: restore,
      redo: async () => {
        for (const p of prior) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          let nowCompleted = false;
          await this.app.fileManager.processFrontMatter(f, (m: any) => {
            if (makeTask) {
              fmAddTag(m, "task");
              if (m.completed === undefined) m.completed = false;
              nowCompleted = m.completed === true;
              delete m.task;
            } else {
              fmRemoveTag(m, "task");
              delete m.completed;
              delete m.task;
              nowCompleted = false;
            }
          });
          this.completedState.set(p.path, nowCompleted); // 0.85.1
          this.taskTaggedState.set(p.path, makeTask);
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.76.10: toggle one note's `completed` field straight from its
   *  row checkbox (main list / detail panel). Flips true↔false (keeps
   *  the field present so the row stays a task), logs, re-renders,
   *  and pushes an undo. */
  async toggleCompletedForNode(node: TreeNode): Promise<void> {
    if (!node.file) return;
    const path = node.file.path;
    const was = this.isCompleted(node);
    await this.app.fileManager.processFrontMatter(node.file, (m: any) => {
      m.completed = !was;
    });
    this.completedState.set(path, !was); // authoritative, pre-cache-event
    await this.log.append({ type: was ? "uncomplete" : "complete", id: node.id });
    this.render();
    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: was ? "Mark incomplete" : "Mark complete",
      undo: async () => {
        const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (!f) return;
        await this.app.fileManager.processFrontMatter(f, (m: any) => { m.completed = was; });
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** Tag-only task check (used by the H toggle's decision). Distinct
   *  from isTask, which also counts the bare `completed` field for
   *  panel inclusion. */
  private isTaskTagged(node: TreeNode): boolean {
    if (!node.file) return false;
    const override = this.taskTaggedState.get(node.file.path);
    if (override !== undefined) return override;
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter as any;
    return this.taggedFromFm(fm);
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
    const seen = new Set<StashpadId>();   // cycle guard
    while (cur && cur.id !== ROOT_ID && !seen.has(cur.id)) {
      seen.add(cur.id);
      const c = this.colorForNode(cur);
      if (c) return { hex: c, depth };
      cur = cur.parent ? this.tree.get(cur.parent) : undefined;
      depth += 1;
    }
    return null;
  }

  // --- Drag-and-drop reordering ---

  /** When set, the next render() will use this list of ids to compute cursor &
   *  selection (find their positions in currentChildren). Used by reorder/move/undo
   *  to stop the stale cursor lingering on the previous row's slot. */
  private pendingFocusIds: StashpadId[] | null = null;

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
    const movedAuthorIds = this.authorship.collectAuthorIds(
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
        // 0.72.1: short verb label; the destination title is in the message.
        label: "Jump to parent",
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
  /** public: called by ViewDnD (the host interface) from drop handlers. */
  async reorderToTarget(
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
    // 0.98.32: secure-delete override — when "Encrypt items sent to trash" is ON,
    // a normal delete routes to the encrypted trash (recoverable + Ctrl+Z) instead
    // of plaintext-trashing. Scoped to Stashpad's own delete (per the agreed design).
    // ("Follow Obsidian's trash setting" opts back out of the override.)
    if ((this.plugin.settings.encryptTrash ?? false) && !(this.plugin.settings.encryptTrashFollowObsidian ?? false)) {
      if (!this.plugin.encryption?.isConfigured?.()) {
        // Don't silently fall back to the plaintext trash the user asked to avoid.
        new Notice("“Encrypt items sent to trash” is ON but encryption isn't set up (Settings → Encryption). Nothing was deleted.");
        return;
      }
      await this.secureDeleteSources(targets);
      return;
    }
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
          // 0.79.18: entries may be wikilinks now — normalize to linktext.
          if (typeof a === "string" && a.trim()) attachments.push(attachmentLinkPath(a));
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
        const deletedAuthorIds = this.authorship.collectAuthorIds(allNotes);
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
        const folder = this.noteFolder;
        const undoFocusIds = targets.map((t) => t.id);
        // Shared restore — used by both the notification's Undo button and
        // the undo stack; guarded so a double-fire is a no-op.
        let restored = false;
        const doRestore = async () => {
          if (restored) return; restored = true;
          this.selection.clear();
          this.cursorIdx = -1;
          await this.restoreSnapshots(snap, undoFocusIds.slice());
        };
        // 0.79.11: persistent + an explicit Undo button on the delete toast.
        this.plugin.notifications.show({
          message: this.bulkActionMessage({
            verb: "Deleted",
            nodes: targets,
            suffix: attSuffix.trim() || undefined,
          }),
          kind: "warning",
          category: "delete",
          duration: 0,
          affectedIds: targets.map((t) => t.id),
          affectedAuthorIds: deletedAuthorIds,
          folder: this.noteFolder,
          actions: [{ label: "Undo delete", onClick: () => void doRestore() }],
        });
        this.plugin.getUndoStack(folder).push({
          label: `Delete ${targets.length} note${targets.length === 1 ? "" : "s"}`,
          undo: async () => { await doRestore(); },
          redo: async () => {
            this.selection.clear();
            this.cursorIdx = -1;
            restored = false;
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
        // 0.76.21: keep focus in the list, not the composer. Splitting
        // closes a modal which re-activates the leaf and (via
        // focusComposer) used to pull focus into the composer even
        // with autofocus-after-send OFF. Suppress that activation
        // focus briefly and land on the list instead.
        this.suppressComposerFocusUntil = Date.now() + 500;
        this.viewRoot?.focus({ preventScroll: true } as any);
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
  // Implementations live in commands/io-cmds.ts; these thin delegators keep
  // the public method names stable for the keydown dispatcher + main.ts.
  cmdExportStash(rootNode?: TreeNode): Promise<void> { return ioCmds.cmdExportStash(this, rootNode); }
  cmdExportOkf(rootNode?: TreeNode): Promise<void> { return ioCmds.cmdExportOkf(this, rootNode); }
  cmdImportStash(): Promise<void> { return ioCmds.cmdImportStash(this); }
  processStashFile(file: TFile): Promise<void> { return ioCmds.processStashFile(this, file); }

  // --- Note creation ---

  private async createNoteUnder(body: string, parentOverride: StashpadId | null, opts: { record?: boolean; createdOverride?: string; targetFolder?: string } = { record: true }): Promise<StashpadId | null> {
    // 0.76.15: targetFolder lets the destination picker SHIP a note to
    // another Stashpad folder without switching this view there. When
    // it differs from the current folder we skip the synthetic insert
    // / render / fmSync that assume the note belongs to this view's
    // tree, and instead surface a "sent to <folder>" notice with a
    // Jump action.
    const folder = (opts.targetFolder ?? this.noteFolder).replace(/\/+$/, "");
    const remote = folder !== this.noteFolder;
    await this.ensureFolder(folder);
    const id = newId();

    // Per-Stashpad template: if the user has set one for this folder, fold
    // its body into the new note's body. Frontmatter overlay happens AFTER
    // file creation via processFrontMatter (so we don't have to hand-roll
    // YAML serialization). Auto-managed fields (id/parent/created/
    // attachments) always win over the template.
    let templateFm: Record<string, any> | null = null;
    {
      const tplPath = (this.plugin.settings.noteTemplates ?? {})[folder];
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
    const path = `${folder}/${filename}`;
    // For remote sends parentOverride is always supplied (the picked
    // remote parent); falling back to this.focusId would be wrong (it
    // belongs to the current folder).
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
    const author = this.authorship.currentAuthorLink();
    if (author) { void this.authorship.ensureAuthorFile(author); }

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
      // 0.79.20: exempt our own new note from auto-import. On a slow
      // network drive the file's frontmatter may not have flushed when the
      // importer's create event fires, so its disk id-check would miss the
      // id and "import" the note into Home. Long TTL covers a laggy create.
      this.plugin.importService.suppress(path, 60000);
      await perf.timeAsync("write.createNote.file", () => this.app.vault.create(path, fullContent));
      try {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f && (f as any).extension === "md") {
          if (!remote) {
            // Local create: synthetic insert so the row appears instantly
            // (before the metadataCache parses), render, and sync the
            // redundant recovery fields.
            this.tree.insertSynthetic({
              id, parent: parentId, children: [], file: f as TFile, created,
            });
            this.render();
            this.fmSync.scheduleParentChange(id, null, parentId);
          } else {
            // 0.76.15: remote send — the note belongs to another
            // folder's tree, not this view's. Just refresh the local
            // view (clears the destination badge) and tell the user
            // where it went, with a Jump action.
            this.render();
            const folderName = folder.split("/").pop() || folder;
            const noteTitle = (body.split("\n").find((s) => s.trim()) ?? "note").trim().slice(0, 60);
            this.plugin.notifications.show({
              // 0.76.16: persistent so it waits for you to act, and the
              // Jump action targets the NOTE itself (not just its parent).
              message: `"${noteTitle}" landed in \`${folderName}\``,
              kind: "success",
              category: "create",
              duration: 0,
              folder,
              affectedIds: [id],
              actions: [{
                label: "Jump to note",
                onClick: () => { void this.switchToFolderAndFocus(folder, id); },
              }],
            });
          }
          // Layer template frontmatter (color, tags, custom keys). Auto
          // fields (id/parent/created/attachments) are skipped so the
          // values written above always win. Applies local + remote.
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
        // 0.76.15: push the undo onto the TARGET folder's stack (so it
        // belongs with that folder's history), and only rebuild THIS
        // view's tree when the create was local — a remote create
        // mustn't repoint this.tree at the remote folder.
        const originalBody = body;
        this.plugin.getUndoStack(folder).push({
          label: remote ? "Send note" : "Create note",
          undo: async () => {
            const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
            if (f) { try { await this.app.fileManager.trashFile(f); } catch {} }
            // Restore the body to the composer so the send/create can be
            // re-typed. (For remote sends the destination is gone after
            // submit, but the text returning is still the useful part.)
            this.composerDraft = originalBody;
            void this.saveDraft(originalBody);
            void this.recordLastSubmitted("");
            if (this.composerInputEl) {
              this.composerInputEl.value = originalBody;
              const end = originalBody.length;
              this.composerInputEl.setSelectionRange(end, end);
              this.composerInputEl.focus();
            }
            if (!remote) this.tree.rebuild(this.noteFolder);
            this.render();
          },
          redo: async () => {
            if (!(await this.app.vault.adapter.exists(path))) {
              await this.app.vault.create(path, fullContent);
            }
            this.composerDraft = "";
            void this.saveDraft("");
            void this.recordLastSubmitted(originalBody);
            if (this.composerInputEl) this.composerInputEl.value = "";
            if (!remote) this.tree.rebuild(this.noteFolder);
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

  /** public: called by AuthorshipTracker (the host interface). */
  async ensureFolder(path: string): Promise<void> {
    // 0.71.35: prefer the adapter (authoritative for on-disk state)
    // over getAbstractFileByPath, which races the metadataCache on
    // plugin reload — returning null for folders that actually exist,
    // which then makes createFolder throw "Folder already exists."
    if (await this.app.vault.adapter.exists(path)) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFolder)) {
        throw new Error(`${path} exists and is not a folder`);
      }
      return;
    }
    try {
      await this.app.vault.createFolder(path);
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (!/already exists/i.test(msg)) throw e;
    }
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

  // 0.77.8: claim-authorship command-palette entry points (called from
  // main.ts via call("<method>")). The implementation lives in
  // AuthorshipTracker; these thin wrappers keep the view's public method
  // names stable for main.ts.
  claimSelectedAsAuthor(): void { this.authorship.claimSelectedAsAuthor(); }
  claimFolderAsAuthor(): void { this.authorship.claimFolderAsAuthor(); }
  claimSelectedWithContributor(): void { this.authorship.claimSelectedWithContributor(); }
  claimFolderWithContributor(): void { this.authorship.claimFolderWithContributor(); }

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

  private onFileModify = (file: TFile): void => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith(this.noteFolder + "/")) return;
    this.scheduleSlugRename(file);
    this.scheduleAttachmentSync(file);
    // 0.72.4: classify self vs external and queue the contributor stamp.
    this.authorship.noteModify(file);
    // Re-render so any visible row of this file picks up new body
    // content (and re-evaluates the "Show more" overflow check). The
    // metadataCache hook only fires for metadata-affecting edits — pure
    // body changes (e.g. pasting a long block of plain text) wouldn't
    // otherwise trigger a re-render, leaving stale clamp state.
    this.debouncedRender();
  };
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
    const found = this.extractAttachments(body); // bare paths from ![[...]]
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const currentRaw = Array.isArray(fm?.attachments) ? (fm!.attachments as unknown[]) : [];
    // 0.85.9: compare by BARE PATH so a canonical `[[link]]` that already
    // matches the body embed counts as equal. Comparing raw strings made the
    // link form (written by import + the rebootstrap convert pass) look
    // "different" from the plain body-derived paths, so this sync rewrote it to
    // plain text every time the note was touched — silently reverting
    // convertAttachmentsToLinks (the "do it then revert it" bug).
    const currentPaths = currentRaw
      .filter((x): x is string => typeof x === "string")
      .map((x) => attachmentLinkPath(x));
    const same = currentPaths.length === found.length && currentPaths.every((v, i) => v === found[i]);
    if (same) return;
    // Write the canonical `[[link]]` form so this sync agrees with import +
    // convert and the three never fight over format.
    const links = found.map((p) => toAttachmentLink(p));
    await this.app.fileManager.processFrontMatter(file, (front) => { front.attachments = links; });
  }

  // --- Helpers ---

  /** public: called by AuthorshipTracker (the host interface). */
  stripFrontmatter(md: string): string {
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
  /** public: read by extracted command modules (commands/*.ts). */
  formatTimeInline(iso: string): string {
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

    // 0.76.37: on mobile, skip the continuous re-pin entirely. The soft
    // keyboard animating in/out, visualViewport resizes, and late
    // markdown/attachment layout all change scrollHeight repeatedly after
    // a composer submit — and the desktop watchdog below would yank the
    // list to the bottom on every one of those, producing a visible
    // up/down bounce. Instead do a few discrete, transition-aware
    // settle scrolls and then leave the list alone.
    if (Platform.isMobile) {
      let tries = 0;
      const settle = (): void => {
        if (!this.stickToListBottom || tries >= 8) return;
        tries++;
        // Don't fight the keyboard while it's animating — just wait it out.
        if (Date.now() >= this.keyboardTransitionUntil) {
          list.scrollTop = list.scrollHeight;
        }
        window.setTimeout(settle, 120);
      };
      window.setTimeout(settle, 60);
      return;
    }

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
    menu.addItem((it: any) => it.setTitle("Export to .stash").setIcon("package").onClick(() => {
      // Multi-select normalisation (matches Clone / Delete / Set color):
      // if the right-clicked row isn't in the selection, treat the
      // right-click as a single-target action. Otherwise honour the
      // full selection.
      if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
      void this.cmdExportStash();
    }));
    if (this.plugin.settings.okfEnabled) {
      menu.addItem((it: any) => it.setTitle("Export as OKF…").setIcon("book-marked").onClick(() => {
        if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
        void this.cmdExportOkf();
      }));
    }
    // 0.98.1: encrypt (lock) this note + its whole subtree into one .stashenc
    // bundle, in place. Only shown once a vault encryption password is set up.
    if (this.plugin.encryption?.isConfigured?.()) {
      menu.addItem((it: any) => it.setTitle("Encrypt (lock) note + children").setIcon("lock").onClick(async () => {
        // Capture the note's preceding sibling in any explicit manual order, so
        // unlock can drop it back into the same slot.
        const order = this.order.getOrder(this.noteFolder, node.parent ?? ROOT_ID);
        const idx = order.indexOf(node.id);
        const prevSibling = idx > 0 ? order[idx - 1] : null;
        const r = await this.plugin.lockNoteSubtree(this.noteFolder, node.id, prevSibling);
        if (r) this.render();
      }));
    }
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Move to…").setIcon("move").onClick(() => this.cmdMovePicker()));
    menu.addItem((it: any) => it.setTitle("Move to Home").setIcon("home").onClick(async () => {
      await this.changeParent(node, ROOT_ID);
      // 0.72.6: follow the moved note up to Home if the user enabled
      // it. No-op when the view is already focused on Home.
      if (this.plugin.settings.autoNavOnMoveOut && this.focusId !== ROOT_ID) {
        this.navigateTo(ROOT_ID);
      }
    }));
    // 0.68.0: pin / unpin from the sidebar Pinned Notes panel.
    const pinRef = { folder: this.noteFolder, id: node.id };
    const pinned = this.plugin.isPinned(pinRef);
    menu.addItem((it: any) => it
      .setTitle(pinned ? "Unpin from sidebar" : "Pin to sidebar")
      .setIcon(pinned ? "pin-off" : "pin")
      .onClick(async () => {
        if (pinned) await this.plugin.unpinNote(pinRef);
        else await this.plugin.pinNote(pinRef);
      }));
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
      // Route through cmdDelete (not deleteNote directly) so the encryptTrash
      // override applies here too — otherwise right-click Delete sends
      // plaintext to the system trash with "Encrypt items sent to trash" ON.
      if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
      await this.cmdDelete();
    }));
    menu.addSeparator();
    // 0.87.0: "more commands" escape hatch (parity with the ⚡ menu).
    menu.addItem((it: any) => it.setTitle("More commands…").setIcon("terminal").onClick(() => this.openCommandPalette()));
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
          // 0.79.18: entries may be wikilinks now — normalize to linktext.
          if (typeof a === "string" && a.trim()) attachments.push(attachmentLinkPath(a));
        }
      }
    }
    const uniqueAtts = [...new Set(attachments)];

    // Captured BEFORE deletion so cross-author filtering works after files are gone.
    const deletedAuthorIds = this.authorship.collectAuthorIds(all);
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
      // 0.79.11: persistent delete toast with a shared Undo (button +
      // undo stack), single-fire guarded.
      let restored = false;
      const doRestore = async () => {
        if (restored) return; restored = true;
        this.selection.clear();
        this.cursorIdx = -1;
        await this.restoreSnapshots(snap, [undoFocusId]);
      };
      this.plugin.notifications.show({
        message: `Deleted "${this.titleForNode(node)}"${attSuffix}`,
        kind: "warning",
        category: "delete",
        duration: 0,
        affectedIds: [node.id],
        affectedAuthorIds: deletedAuthorIds,
        folder: this.noteFolder,
        actions: [{ label: "Undo delete", onClick: () => void doRestore() }],
      });
      this.plugin.getUndoStack(folder).push({
        label,
        undo: async () => { await doRestore(); },
        redo: async () => {
          this.selection.clear();
          this.cursorIdx = -1;
          restored = false;
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

  /** Swap a note with its direct parent — the user's "ouroboros"
   *  feature. Net effect:
   *  - The child takes the parent's slot (under the grandparent).
   *  - The parent slides under the child, in front of any existing
   *    children of the child.
   *  - All other descendants stay attached to their immediate parents.
   *
   *  Algorithmically this is just two frontmatter writes (one for each
   *  note's `parent` field) plus an ordering update under the
   *  grandparent and the child. Tree rebuilds from frontmatter so the
   *  new shape materialises automatically. 0.63.0. */
  async cmdSwapWithParent(): Promise<void> {
    // 0.63.1: pick the CURSOR ROW explicitly (not getActionTargets()'s
    // "first selected"). Multi-selection's "first" was insertion-order
    // dependent — confusing. The cursor row is what the user is
    // visually focused on.
    const node = this.cursorIdx >= 0 ? this.currentChildren[this.cursorIdx] : null;
    if (!node?.file) { new Notice("Pick a note first (move the cursor onto it)."); return; }
    if (!node.parent || node.parent === ROOT_ID) {
      new Notice("Already at Home — no parent to swap with.");
      return;
    }
    const parent = this.tree.get(node.parent);
    if (!parent?.file) { new Notice("Couldn't find the parent note."); return; }
    const grandparent: StashpadId = parent.parent ?? ROOT_ID;
    // 0.63.3: terser modal copy per user feedback — title + one line of
    // "X becomes child of Y", plus an optional sibling-count footer.
    const nodeTitle = this.titleForNode(node);
    const parentTitle = this.titleForNode(parent);
    const siblingCount = this.tree.getChildren(parent.id).filter((c) => c.id !== node.id).length;
    const lines = [
      `"${parentTitle}" becomes a child of "${nodeTitle}".`,
    ];
    if (siblingCount > 0) {
      lines.push(`${siblingCount} sibling${siblingCount === 1 ? "" : "s"} move with it.`);
    }
    new ConfirmModal(
      this.app,
      "Swap notes?",
      lines.join("\n"),
      "Swap",
      async (ok) => {
        if (!ok) return;
        await this.swapParentChild(parent, node, grandparent);
      },
    ).open();
  }

  /** Modal recovery flow when the user tries to nest a note under one
   *  of its own descendants — instead of silently refusing (the old
   *  warning toast) or crashing (the pre-0.63.0 freeze), offer the
   *  swap as the "did you mean this?" path. */
  private offerSwapForDescendantMove(node: TreeNode, descendantId: StashpadId): void {
    const desc = this.tree.get(descendantId);
    if (!desc?.file) {
      this.plugin.notifications.show({
        message: `Can't nest "${this.titleForNode(node)}" under one of its own descendants — that would create a cycle.`,
        kind: "warning", category: "move", affectedIds: [node.id], folder: this.noteFolder,
      });
      return;
    }
    // Only direct-parent ↔ direct-child swaps are supported in this MVP.
    // For non-adjacent (descendant is a grandchild or deeper), show the
    // legacy warning so the user knows it's structurally complex.
    if (desc.parent !== node.id) {
      this.plugin.notifications.show({
        message: `Can't nest "${this.titleForNode(node)}" under "${this.titleForNode(desc)}" — it's a deeper descendant. Only direct parent ↔ child swaps are supported (try moving "${this.titleForNode(desc)}" up first, then swap).`,
        kind: "warning", category: "move", affectedIds: [node.id, desc.id], folder: this.noteFolder,
      });
      return;
    }
    // Direct parent → child case — offer the swap. Terse 0.63.3 copy.
    const nodeTitle = this.titleForNode(node);
    const descTitle = this.titleForNode(desc);
    const siblingCount = this.tree.getChildren(node.id).filter((c) => c.id !== desc.id).length;
    const lines = [
      `"${nodeTitle}" becomes a child of "${descTitle}".`,
    ];
    if (siblingCount > 0) {
      lines.push(`${siblingCount} sibling${siblingCount === 1 ? "" : "s"} move with it.`);
    }
    new ConfirmModal(
      this.app,
      "Confirm Note Swap",
      lines.join("\n"),
      "Swap",
      async (ok) => {
        if (!ok) return;
        const gp: StashpadId = node.parent ?? ROOT_ID;
        await this.swapParentChild(node, desc, gp);
      },
    ).open();
  }

  /** Execute a parent ↔ child swap. Assumes `child.parent === parent.id`
   *  (caller validates).
   *
   *  Post-swap shape per user request (0.63.1):
   *  - `child` takes `parent`'s slot under `grandparent`.
   *  - `parent` slides under `child` with NO children of its own.
   *  - All of `parent`'s OTHER children (the to-be-swapped child's
   *    former siblings) ALSO move under `child` — they become siblings
   *    of `parent` rather than staying with it. So if A had B, C, T, …
   *    and T is promoted, T ends up with {A, B, C, …} as children
   *    and A is empty.
   *  - `child`'s ORIGINAL children stay under `child` (they were
   *    already there).
   *
   *  Frontmatter write order is cycle-safe at every step. Pushes a
   *  single undo entry that reverses all changes in cycle-safe order
   *  too. 0.63.1. */
  private async swapParentChild(parent: TreeNode, child: TreeNode, grandparent: StashpadId): Promise<void> {
    if (!parent.file || !child.file) return;
    if (child.parent !== parent.id) {
      new Notice("Swap aborted: parent/child relationship changed.");
      return;
    }
    const folder = this.noteFolder;
    const priorParentParent = parent.parent;
    // Capture parent's OTHER children (siblings of `child`) BEFORE
    // any mutations — they'll all be re-parented to `child` so they
    // surface as siblings of `parent` post-swap.
    const otherChildren = this.tree.getChildren(parent.id)
      .filter((c) => c.id !== child.id)
      .filter((c): c is TreeNode & { file: TFile } => !!c.file);
    const otherChildPriors = otherChildren.map((c) => ({ id: c.id, path: c.file.path, was: c.parent }));
    // Snapshot orderings so undo can restore them verbatim.
    const gpOrder = this.order.getOrder(folder, grandparent).slice();
    const childOrder = this.order.getOrder(folder, child.id).slice();
    const parentOrder = this.order.getOrder(folder, parent.id).slice();

    // ---- Forward writes — cycle-safe order ----
    // (a) child.parent → grandparent. Both child and parent are now
    //     siblings under grandparent — no cycle.
    await this.app.fileManager.processFrontMatter(child.file, (fm) => { fm.parent = grandparent; });
    this.fmSync.scheduleParentChange(child.id, parent.id, grandparent);
    // (b) parent.parent → child.id. parent slides under child; child is
    //     under grandparent — still no cycle.
    await this.app.fileManager.processFrontMatter(parent.file, (fm) => { fm.parent = child.id; });
    this.fmSync.scheduleParentChange(parent.id, priorParentParent, child.id);
    // (c) Re-parent each of parent's other children to `child` — they
    //     become siblings of `parent` under `child`.
    for (const oc of otherChildren) {
      await this.app.fileManager.processFrontMatter(oc.file, (fm) => { fm.parent = child.id; });
      this.fmSync.scheduleParentChange(oc.id, parent.id, child.id);
    }

    // ---- Ordering updates ----
    // Grandparent: replace parent.id with child.id in-place. Tree
    // rebuild fills order if there was no explicit one.
    if (gpOrder.length > 0) {
      const newGp = gpOrder.includes(parent.id)
        ? gpOrder.map((id) => id === parent.id ? child.id : id)
        : [...gpOrder.filter((id) => id !== child.id), child.id];
      this.order.setOrder(folder, grandparent, newGp);
    }
    // Under child after swap: parent first (just demoted), then child's
    // original children, then the former siblings (in their original
    // order from parent's child list).
    const formerSiblingIds = otherChildren.map((c) => c.id);
    const newChildOrder = [
      parent.id,
      ...childOrder.filter((id) => id !== parent.id && !formerSiblingIds.includes(id)),
      ...formerSiblingIds,
    ];
    this.order.setOrder(folder, child.id, newChildOrder);
    // Parent has no children now — clear its order.
    this.order.setOrder(folder, parent.id, []);
    await this.order.save(folder);

    await this.log.append({ type: "parent_change", id: child.id, payload: { from: parent.id, to: grandparent, reason: "swap" } });
    await this.log.append({ type: "parent_change", id: parent.id, payload: { from: priorParentParent, to: child.id, reason: "swap" } });
    for (const p of otherChildPriors) {
      await this.log.append({ type: "parent_change", id: p.id, payload: { from: p.was, to: child.id, reason: "swap" } });
    }

    this.tree.rebuild(folder);
    this.pendingFocusIds = [child.id];
    this.render({ kind: "follow-cursor" });
    this.plugin.notifications.show({
      message: `Swapped "${this.titleForNode(child)}" ↔ "${this.titleForNode(parent)}".`,
      kind: "success",
      category: "move",
      affectedIds: [child.id, parent.id, ...formerSiblingIds],
      folder,
    });

    // ---- Undo — cycle-safe REVERSE order ----
    // The trap: if we set child.parent=parent.id while parent.parent is
    // still child.id, the tree has a 2-node cycle for the duration of
    // the next render and tree.rebuild recurses forever → freeze. So
    // restore parent.parent FIRST, then child.parent, then siblings.
    this.plugin.getUndoStack(folder).push({
      label: `Swap "${this.titleForNode(child)}" ↔ parent`,
      undo: async () => {
        const p = this.tree.get(parent.id);
        const c = this.tree.get(child.id);
        // 1) parent.parent back to its original. No cycle: parent
        //    leaves child's subtree, child stays under grandparent.
        if (p?.file) await this.app.fileManager.processFrontMatter(p.file, (fm) => {
          if (priorParentParent == null || priorParentParent === ROOT_ID) {
            delete fm.parent;
            fm.parent = ROOT_ID;
          } else {
            fm.parent = priorParentParent;
          }
        });
        // 2) child.parent back to parent.id. parent.parent is now the
        //    original grandparent, so child going under parent is
        //    cycle-free.
        if (c?.file) await this.app.fileManager.processFrontMatter(c.file, (fm) => { fm.parent = parent.id; });
        // 3) Re-parent each former sibling back to parent.id.
        for (const op of otherChildPriors) {
          const f = this.app.vault.getAbstractFileByPath(op.path) as TFile | null;
          if (f) await this.app.fileManager.processFrontMatter(f, (fm) => {
            if (op.was == null) fm.parent = ROOT_ID;
            else fm.parent = op.was;
          });
        }
        // 4) Restore orderings.
        this.order.setOrder(folder, grandparent, gpOrder);
        this.order.setOrder(folder, child.id, childOrder);
        this.order.setOrder(folder, parent.id, parentOrder);
        await this.order.save(folder);
        this.tree.rebuild(folder);
        this.pendingFocusIds = [parent.id];
        this.render({ kind: "follow-cursor" });
      },
      redo: async () => { await this.swapParentChild(parent, child, grandparent); },
    });
  }

  private async changeParent(node: TreeNode, newParent: StashpadId, opts: { record?: boolean; quiet?: boolean; silentSuccess?: boolean } = { record: true }): Promise<boolean> {
    if (!node.file) return false;
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
      return false;
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
      return false;
    }
    // 0.63.0 ouroboros: refuse to nest a note under one of its own
    // descendants — that creates a cycle in the parent chain and
    // tree.rebuild walks it infinitely → app freeze. The cycle-aware
    // recovery flow is "swap": see cmdSwapWithParent / offerSwapForDescendantMove.
    if (newParent !== ROOT_ID && this.isDescendant(newParent, node.id)) {
      if (!opts.quiet) {
        this.offerSwapForDescendantMove(node, newParent);
      }
      return false;
    }
    const movedAuthorIds = this.authorship.collectAuthorIds([node]);
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
    if (!opts.quiet && !opts.silentSuccess) {
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
          // 0.72.1: short verb label; the destination title is in the message.
          label: "Jump to parent",
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
    return true;
  }

  /** 0.91.1: ONE consolidated, persistent notification for a batch reparent —
   *  replaces the per-note "Reparented …" toast spam. For a single moved note
   *  it calls out its child count ("…and its N children"); for several it
   *  summarises the count (+ nested total). Persistent (duration 0) when there's
   *  a destination to jump to, so the "Jump to destination" button is always
   *  clickable; root moves use the default duration (no jump target). */
  private notifyBatchMove(targets: TreeNode[], newParent: StashpadId, childCounts: Map<StashpadId, number>): void {
    if (!targets.length) return;
    const destNode = this.tree.get(newParent);
    const destLabel = newParent === ROOT_ID
      ? "Home"
      : `"${destNode ? this.titleForNode(destNode) : "the destination"}"`;
    const kidsOf = (t: TreeNode): number => childCounts.get(t.id) ?? 0;
    let message: string;
    if (targets.length === 1) {
      const title = this.titleForNode(targets[0]);
      const kids = kidsOf(targets[0]);
      message = kids > 0
        ? `Moved "${title}" and its ${kids} ${kids === 1 ? "child" : "children"} → ${destLabel}`
        : `Moved "${title}" → ${destLabel}`;
    } else {
      const nested = targets.reduce((sum, t) => sum + kidsOf(t), 0);
      message = nested > 0
        ? `Moved ${targets.length} notes (${nested} nested) → ${destLabel}`
        : `Moved ${targets.length} notes → ${destLabel}`;
    }
    this.plugin.notifications.show({
      message,
      kind: "success",
      category: "move",
      duration: newParent === ROOT_ID ? undefined : 0, // persistent when there's a Jump target
      affectedIds: targets.map((t) => t.id),
      affectedAuthorIds: this.authorship.collectAuthorIds(targets),
      folder: this.noteFolder,
      actions: newParent === ROOT_ID ? [] : [{
        label: "Jump to destination",
        onClick: () => this.navigateTo(newParent),
      }],
    });
  }
}

// matchBinding + properCaseFolderPath are re-exported for external importers
// (main.ts); the implementations now live in view-keys.ts / view-helpers.ts.
export { matchBinding } from "./view-keys";
export { properCaseFolderPath } from "./view-helpers";

/** 0.98.28: tiny fuzzy picker over archive folders, for "Move to archive" when
 *  more than one archive exists and no default is set. */
class ArchiveFolderSuggestModal extends SuggestModal<string> {
  constructor(app: App, private folders: string[], private onPick: (folder: string) => void) {
    super(app);
    this.setPlaceholder("Move to which archive folder?");
  }
  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.folders.filter((f) => f.toLowerCase().includes(q));
  }
  renderSuggestion(folder: string, el: HTMLElement): void {
    el.createDiv({ text: folder.split("/").pop() || folder });
    el.createEl("small", { text: folder, cls: "stashpad-suggest-path" });
  }
  onChooseSuggestion(folder: string): void { this.onPick(folder); }
}

/** 0.98.29: minimal restore picker over the encrypted trash. The richer grouped
 *  trash VIEW is separate; this is the keyboard/command path. Entries are
 *  pre-loaded {blob, label, folder}. */
export class DeletedTrashSuggestModal extends SuggestModal<{ blob: string; label: string; folder: string }> {
  constructor(app: App, private entries: { blob: string; label: string; folder: string }[], private onPick: (blob: string) => void) {
    super(app);
    this.setPlaceholder("Restore which deleted note?");
  }
  getSuggestions(query: string): { blob: string; label: string; folder: string }[] {
    const q = query.toLowerCase();
    return this.entries.filter((e) => `${e.label} ${e.folder}`.toLowerCase().includes(q));
  }
  renderSuggestion(e: { blob: string; label: string; folder: string }, el: HTMLElement): void {
    el.createDiv({ text: e.label });
    el.createEl("small", { text: `from ${e.folder}`, cls: "stashpad-suggest-path" });
  }
  onChooseSuggestion(e: { blob: string; label: string; folder: string }): void { this.onPick(e.blob); }
}
