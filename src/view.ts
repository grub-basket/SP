import {
  App, ItemView, Keymap, MarkdownRenderer, Menu, Notice, Platform,
  Scope, SuggestModal, TFile, TFolder, WorkspaceLeaf, debounce,
  moment, sanitizeHTMLToDom, setIcon,
} from "obsidian";
import {
  ROOT_ID, STASHPAD_VIEW_TYPE, RESERVED_FRONTMATTER, fmHasTag, fmAddTag, fmRemoveTag, parseAssignees, parseAuthorRef, attachmentLinkPath, toAttachmentLink,
  archiveSubfolderOf, isArchiveSubfolderPath,
  isReservedSubfolderName,
  isInReservedSubfolder, writeCompletedFm,
  type StashpadId, type TimeFilter, type TimeUnit, type TreeNode, type ViewConfigState, type ViewMode, type ScrollPolicy,
  type ListPinEdge,
} from "./types";
import { TreeIndex } from "./tree-index";
import { perf } from "./perf";
import { formatDateTime, formatDateOnly, formatTimeOnly } from "./format";
import { parseRecurrence, nextDueOnComplete, parseRepeatMode } from "./recurrence";
import { spawnNextOccurrence, archiveOccurrenceSnapshot } from "./recurrence-spawn";
import { OrderStore } from "./order-store";
import { SortStore, SORT_MODE_LABELS, SORT_MODES_ORDER } from "./sort-store";
import { FrontmatterSyncQueue, rebootstrapFolderFrontmatter } from "./frontmatter-sync";
import { buildFileActions, boldFragment } from "./notifications";
import { newId } from "./id-service";
import { seedDemoContent } from "./demo-content";
import { bodyToSlug, buildFilename, buildAttachmentName, parseIdFromFilename, isNoteId, stripInlineMarkdown, DEFAULT_STOPWORDS } from "./slug-service";
import { StashpadLog } from "./log";
import { IntegrityWatcher } from "./integrity-watcher";
import { getSettings, getTemplatesFormats, onSettingsChange } from "./settings";
import { StashpadSuggest } from "./note-picker";
import { buildStashpadLink } from "./deep-link";
import { populateLockedMenu } from "./locked-menu";
import { StashpadCommandPalette } from "./command-palette";
import { setActiveView, clearActiveView } from "./active-view";
import { BreadcrumbLevelsModal, type BreadcrumbLevel, ColorPickerModal, ConfirmDeleteModal, ConfirmModal, DropzoneModal, DueDatePickerModal, NoteWorkbenchModal , DuplicateIdsModal, type DuplicateIdGroup, LargeTextModal} from "./modals";
import { TextImportModal } from "./text-import-modal";
import { AppImportModal } from "./stashpad-app-import-modal";
import type { AppImportNote, HelperNote } from "./stashpad-app-importer";
import type { ImportNote } from "./text-importer";
import { isAllCheckboxLines } from "./text-importer";
import { ComposerAutocomplete } from "./composer-autocomplete";
import { matchBinding, humanCombo } from "./view-keys";
import { openAggregateView } from "./aggregate-view";
import { AuthorshipTracker } from "./authorship-tracker";
import { ViewDnD } from "./view-dnd";
import { NoteBodyRenderer } from "./note-body-renderer";
import { returnToOriginOnClose } from "./leaf-return";
import { computeSortedIds } from "./view-sort";
import {
  SHEET_KEY,
  SHEET_ORDER_KEY,
  SHEET_FINAL_KEY,
  SHEET_ORIGIN_KEY,
  FORKED_FROM_KEY,
  SIBLINGS_KEY,
  FORKED_AT_KEY,
  SHEET_COPY_SKIP_KEYS,
  sheetIdOf,
  isVersionMember,
  isOriginal,
  forkedFromName,
  sheetIsFinal,
  newSheetGroupId,
  nodeFm,
  sortVersions,
  defaultActive,
  tabTitle,
} from "./sheets-versions";
import * as clipboardCmds from "./commands/clipboard-cmds";
import * as ioCmds from "./commands/io-cmds";
import { readXvPayload, hasXvPayload, writeXvAck, writeClipboardText, type XvMeta } from "./cross-vault-clipboard";
import { importStashZip } from "./stash-package";
import { MediaViewerModal, mediaItemsFor, viewerHandles } from "./media-viewer";
import { fileKindFor, isImageExt, pickRailMode, type RailMode } from "./file-kinds";
import { QUICK_ACTION_CATALOG, QUICK_MENU_MORE } from "./quick-actions";
import { setIconSafe, isAnyModalOpen, properCaseFolderPath, computeReorder, arraysEqual, splitIntoChunks, SPLIT_MODE_LABELS, settleNewTab, buildHomeFilename, type SplitMode, rankTags, TAG_FILTER_TAGGED, TAG_FILTER_UNTAGGED } from "./view-helpers";
import type StashpadPlugin from "./main";

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

/** 0.190.0 — sync-storm detection for the render debounce.
 *
 *  More than RENDER_BURST_THRESHOLD change events inside RENDER_BURST_WINDOW_MS is
 *  machine-driven, not human: Obsidian debounces its own metadataCache while you
 *  type, so a person editing rarely exceeds ~2 change events a second. A sync
 *  landing a few hundred files easily sustains 5–20/s.
 *
 *  Threshold tuned by measurement: a realistic storm arrives BURSTY, with gaps
 *  larger than the old 80ms debounce (~150ms apart), so the old code rendered once
 *  per event. At 4-per-second the detector engages a few events in and then
 *  coalesces the rest into a single settle render. */
const RENDER_CALM_MS = 900;
const RENDER_BURST_THRESHOLD = 5;
const RENDER_STORM_DELAY_MS = 700;

/** Hysteresis band for the pinned heading's `is-stuck` collapse. Two thresholds
 *  rather than one because the class changes the very height it is measured
 *  from — see installHeadingStuckObserver for the oscillation this prevents. */
const STICK_ON_PX = 8;
const STICK_OFF_PX = 2;

/** Below this the list is too short to position anything inside — see the
 *  scroll-to-id re-assert chain, which otherwise churns forever trying. */
const MIN_SCROLLABLE_PX = 48;

/** Re-assert schedule for a positional scroll policy (restore / scroll-to-id).
 *  Same wall-clock coverage the fixed chain always had — what changed (0.270.1)
 *  is that a step only re-scrolls when the list's geometry actually moved since
 *  the previous step (see scheduleSettleApplies). */
const SCROLL_SETTLE_STEPS_MS = [60, 200, 600];


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

/** 0.271.0: the time filter is now a free "last N <unit>" expression rather
 *  than a fixed chip row. See `docs/time-filter-numeric.md`. */
interface TimeUnitMeta {
  key: TimeUnit;
  /** Plural noun for labels ("days"). Singular = drop the trailing "s". */
  plural: string;
  /** Compact suffix for the bar summary ("d"). */
  abbr: string;
  /** Milliseconds per unit in ROLLING mode. week/month/year keep the exact
   *  legacy constants (7 / 30 / 365 days) so migrated filters don't shift. */
  ms: number;
  /** moment() startOf() key for CALENDAR mode. */
  startOf: string;
  /** Calendar label at count === 1 (the old chip label). */
  calOne: string;
}
const TIME_UNITS: TimeUnitMeta[] = [
  { key: "hour",  plural: "hours",  abbr: "h", ms: 3600_000,          startOf: "hour",    calOne: "This hour" },
  { key: "day",   plural: "days",   abbr: "d", ms: 86400_000,         startOf: "day",     calOne: "Today" },
  { key: "week",  plural: "weeks",  abbr: "w", ms: 7 * 86400_000,     startOf: "isoWeek", calOne: "This week" },
  { key: "month", plural: "months", abbr: "mo", ms: 30 * 86400_000,   startOf: "month",   calOne: "This month" },
  { key: "year",  plural: "years",  abbr: "y", ms: 365 * 86400_000,   startOf: "year",    calOne: "This year" },
];
const timeUnitMeta = (u: TimeUnit): TimeUnitMeta =>
  TIME_UNITS.find((m) => m.key === u) ?? TIME_UNITS[1];

/** One-tap presets, kept so the common cases survive the move away from
 *  chips (they are the whole mobile story — see populateTimeMenuBody). */
const TIME_PRESETS: Array<{ count: number; unit: TimeUnit }> = [
  { count: 24, unit: "hour" },
  { count: 7,  unit: "day" },
  { count: 30, unit: "day" },
  { count: 365, unit: "day" },
  { count: 0,  unit: "day" },
];

/** Legacy chip key → count+unit. The ONLY migration path for saved state. */
const LEGACY_TIME_FILTER: Record<TimeFilter, { count: number; unit: TimeUnit }> = {
  all:   { count: 0, unit: "day" },
  day:   { count: 1, unit: "day" },
  week:  { count: 1, unit: "week" },
  month: { count: 1, unit: "month" },
  year:  { count: 1, unit: "year" },
};

/** 0.225.0: a bound composer target for append/prepend mode. Carries `path` and
 *  `folder` as well as `id` because the target may live in ANOTHER Stashpad —
 *  the point of the feature is to start typing wherever you happen to be and
 *  still land the text in the right note. */
interface AppendTarget {
  id: StashpadId;
  label: string;
  path: string;
  folder: string;
  mode: "append" | "prepend";
}

/** Title of the parent the importer files its reference notes under. One
 *  constant, because it is both written and matched against - and when those
 *  two drifted apart the match silently never fired. */
const APP_REFERENCE_TITLE = "Stashpad app settings & reference";

/** Below this, an import is over before a progress notice would be read. */
const PROGRESS_MIN_NOTES = 25;
/** How often to update the notice and yield a frame. Small enough that the
 *  count moves visibly, large enough that yielding is not the bottleneck. */
const PROGRESS_EVERY = 25;

/** 0.272.3: combined link-rail count above which the outgoing / backlinks rows
 *  split onto their own lines by type. Below it, a mixed row stays on one line. */
const LINK_RAIL_SPLIT_AT = 5;

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
  /** Numeric time filter: "last `timeFilterCount` `timeFilterUnit`".
   *  count 0 = All time (no cutoff). */
  private timeFilterCount = 0;
  private timeFilterUnit: TimeUnit = "day";
  /** ABSOLUTE mode: a frozen epoch-ms cutoff. null = RELATIVE (the window
   *  slides as time passes). Set by freezing the current relative cutoff. */
  private timeFilterAnchor: number | null = null;
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
  /** 0.272.4: filter to a single DAY (start-of-day epoch ms). A note matches
   *  when it was created that day, links to that date (`[[YYYY-MM-DD]]`), or has
   *  a task `due` that day. null = off. Separate from the time cutoff, which is
   *  a rolling/absolute window. */
  private dateFilter: number | null = null;
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
  private externalEditDebouncers = new Map<string, ReturnType<typeof debounce>>();
  /** public: called by AuthorshipTracker (the host interface). */
  debouncedRender: { (): void; cancel?: () => void };
  /** 0.190.0: adaptive render coalescing. A fixed 80ms debounce re-fires every
   *  ~80ms for the ENTIRE duration of a sync storm (hundreds of files landing over
   *  many seconds), which is what made the list flicker and appear to render/stop/
   *  render. We count change events in a rolling window and, once it looks like a
   *  storm rather than typing, stretch the debounce so we render ONCE after things
   *  go quiet instead of ~12x/second. */
  /** 0.266.6: timestamps of recent change events, pruned to RENDER_CALM_MS.
   *
   *  Replaces a count plus a sticky flag, which misread a slow trickle as a
   *  permanent storm — see scheduleRender. Holding the timestamps means "storm"
   *  is a RATE that is recomputed from scratch each time, so it cannot latch. */
  private renderBurstTimes: number[] = [];
  /** Crumb paths already warmed by warmCrumbTitles — see the loop it prevents.
   *  Bounded by the number of distinct notes visited as breadcrumbs, and a real
   *  edit re-renders through the file-modify path anyway, so nothing is lost by
   *  never warming the same path twice. */
  private warmedCrumbs = new Set<string>();
  /** 0.267.9: a render was skipped because this view was not on screen. Flushed
   *  the moment it becomes visible, so a deferred render is never a lost one. */
  private pendingVisibleRender = false;
  /** When the last render:sched stack was captured — see the rate limit. */
  private lastSchedStackAt = 0;
  private renderTimer: number | null = null;
  /** 0.216.1: until this timestamp, debounced renders use a LONGER trailing
   *  delay so the burst of self-inflicted events after our own note creation
   *  (vault create, metadata resolve, metadata changed, fmSync parentLink
   *  write) coalesces into one settle render instead of firing one full
   *  rebuild each. Those events arrive ~140ms apart — past the 80ms debounce,
   *  so before this every send produced FIVE full renders in ~1.4s, and each
   *  one recreated every row. On a large vault that recreation churn is
   *  visible as the just-created row appearing to select/deselect repeatedly.
   *  External edits landing inside this window still render — at worst 400ms
   *  later than usual, and only for the 2s after a create. */
  private postCreateSettleUntil = 0;
  // Bulk-render suppression: while a bulk op runs (a long split paste,
  // rebootstrap), metadata-driven re-renders are dropped so the list doesn't
  // flicker per-note as files parse and fmSync writes recovery fields. One
  // render happens after the writes settle (endBulkRender / forceReconcileRender).
  private bulkRenderDepth = 0;
  private bulkSettleTimer: number | null = null;
  private bootstrappedFolders = new Set<string>();

  /** public: read by ViewDnD (the host interface). */
  selection = new Set<StashpadId>();
  private lastSelected: StashpadId | null = null;
  /** public: read by extracted command modules (commands/*.ts). */
  cursorIdx = -1;
  /** 0.258.0: the cursor is on the pinned HEADING row (the focused note shown
   *  at the top of its own list) rather than on a child.
   *
   *  A separate flag rather than `cursorIdx = -1`, because -1 already means
   *  "no cursor at all" in a dozen places and overloading it would make every
   *  one of those checks silently wrong.
   *
   *  `currentChildren` deliberately still means CHILDREN OF `focusId` — it is
   *  read by move planning, the pickers, reorder and several tree walks, and
   *  redefining it to include the parent would change all of them at once. The
   *  heading is layered on top for cursor / selection / target resolution
   *  only. */
  private cursorOnHeading = false;
  /** Focus level the last paint was for. Compared each render to detect a level
   *  change, because the nav paths don't share one entry point — `navigateTo`
   *  funnels some, but `navigateUp` assigns `focusId` directly and back/forward
   *  restore snapshots. Level-scoped state resets here rather than in each
   *  caller, so a nav path added later can't quietly skip it. */
  private renderedFocusId: StashpadId | null = null;
  /** 0.98.6: after an async restore (e.g. decrypt → importStashZip → tree
   *  rebuild), cursor + select this id once it appears in the list. Cleared when
   *  applied. Survives the intermediate render where the note isn't in the tree yet. */
  private pendingCursorId: StashpadId | null = null;
  /** public: read by extracted command modules (commands/*.ts). */
  currentChildren: TreeNode[] = [];
  private modeSplit: boolean | null = null;
  private modeEnterSubmits = true; // per-view, defaults true
  private nextDestination: StashpadId | null = null;
  /** 0.222.0: append mode. When set, the next send appends to this note's body
   *  instead of creating a note. Cleared after one send (see the note on
   *  openAppendPicker for why it is deliberately not sticky). */
  private appendTarget: AppendTarget | null = null;
  /** 0.237.0: obscured notes the user has revealed in THIS view. Deliberately
   *  in-memory and per-view — "revealed" is a viewing state, not a property of
   *  the note, so it must never be written to the file or shared with another
   *  tab showing the same note. */
  private revealedObscured = new Set<StashpadId>();
  /** 0.272.4: two-step reveal. `revealedObscured` = TEXT shown; this second set
   *  = images/attachments shown too. First tap reveals text (media stays
   *  blurred if the note has any), second reveals media — so a glance doesn't
   *  dump every image at once. A note with no media reveals fully in one tap. */
  private mediaRevealedObscured = new Set<StashpadId>();
  private composerAppendBtn: HTMLButtonElement | null = null;
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
  // Composer controls whose appearance depends on split/enter mode. Held so a
  // mode toggle can update them IN PLACE instead of a full render() (which
  // rebuilds the list — scroll jump + collapses the button group).
  private composerSplitBtn: HTMLElement | null = null;
  private composerEnterBtn: HTMLElement | null = null;
  private composerHelperEl: HTMLElement | null = null;
  /** 0.216.0 — persistent-composer machinery. On mobile, rebuilding the
   *  composer <textarea> detaches the focused element, which dismisses the
   *  on-screen keyboard; the post-render refocus then re-summons it — a
   *  visible flicker on every send. iOS offers no reliable way to keep the
   *  keyboard up across a detach (even a same-task detach+refocus bounces the
   *  native input session), so the only real fix is to never detach it: the
   *  composer element persists across renders and only the chrome around it
   *  (filter bar, breadcrumb, header, list) is rebuilt.
   *  - chromeEl: display:contents wrapper for everything ABOVE the composer;
   *    render() empties THIS, not the view root, when the composer is reused.
   *  - composerRootEl: the persistent .stashpad-composer div.
   *  - composerSignature: the state the composer build bakes in structurally.
   *    When it changes (folder switch, tiny/compact toggle) the composer IS
   *    rebuilt — everything else is updated in place (syncComposerModeUI /
   *    refreshDestButton). */
  private chromeEl: HTMLElement | null = null;
  private composerRootEl: HTMLElement | null = null;
  private mobileNavEl: HTMLElement | null = null;
  private composerSignature = "";
  private composerDestBtn: HTMLElement | null = null;
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
  /** 0.219.4: an on-disk note count the reconcile has already PROVEN it cannot
   *  resolve — a rebuild at this count changed nothing, so retrying only costs a
   *  full list rebuild + re-render. Cleared implicitly by the count changing
   *  (a note added or removed), so a genuinely stale tree still reconciles. */
  private reconcileUnresolvableAt: number | null = null;
  /** Set once the duplicate-id warning has been surfaced, so it never nags. */
  private reportedDuplicateIds = false;
  /** 0.76.27: timestamp until which the listResizeObserver ignores
   *  scroll adjustments. Set on mobile composer focus/blur — the
   *  keyboard show/hide resizes the list, which otherwise fired the
   *  observer and yanked the scroll position each time (the list
   *  "moving" on every composer interaction). During this window we
   *  let the browser's own reflow settle without fighting it. */
  private keyboardTransitionUntil = 0;
  /** 0.108.3: while `Date.now() < this`, a mobile row tap only dismisses the
   *  keyboard (no select/open). Set on composer blur to cover the keyboard-
   *  dismiss reflow, during which rows slide out from under the finger — see
   *  shouldAbsorbDismissTap. */
  private tapSettleUntil = 0;
  /** 0.108.4: the note under the finger on the FIRST tap of a double-tap that
   *  began during the keyboard-dismiss reflow (keyboard-up layout — what the
   *  user actually aimed at). The double-tap opens THIS, not the row that slid
   *  under the second tap. Window-gated so a lone dismiss tap can't later be
   *  "opened" by an unrelated double-tap. */
  private aimedTapTargetId: string | null = null;
  private aimedTapAt = 0;
  private static readonly AIMED_TAP_WINDOW_MS = 600;
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
  /** 0.116.0: observes the header bar's width so its clusters fold into a
   *  single ⋯ overflow menu (cascading, by priority) instead of wrapping
   *  to a second row. Desktop only; see setupBarOverflow. */
  private barOverflowRO: ResizeObserver | null = null;
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
  /** 0.118.10: ids the user has MANUALLY collapsed while their row was
   *  auto-expanded by the cursor (autoExpandCursorRow). Suppresses the transient
   *  `.is-cursor-expanded` so an explicit collapse sticks; cleared when the
   *  cursor leaves the row (then it auto-expands again next time). */
  private cursorExpandOverride = new Set<StashpadId>();
  /** Has the user moved the cursor (arrow nav / row click) since this view
   *  instance loaded? Gates the cursor auto-expand (autoExpandCursorRow) so a
   *  fresh load/reload/refresh renders EVERY row collapsed — the cursor row
   *  only auto-expands once the user actively navigates. Per-instance, so an
   *  app/view reload (new instance) starts collapsed again. */
  private cursorHasMoved = false;
  /** Sheet versions: which version (note id) of a `sheet:` group is currently
   *  shown as the row. View-state only (not persisted) — falls back to the
   *  final pick / first-by-order when unset. */
  private activeVersionByGroup = new Map<string, StashpadId>();
  private focusComposerOnNextRender = false;
  /** 0.219.2: handle for the deferred FIRST paint. Obsidian calls onOpen before
   *  setState, so a view opened at a specific folder would paint the DEFAULT
   *  folder's notes first and throw them away a moment later — measured as a
   *  full 120-row render for a folder the user never asked for. The first paint
   *  is deferred by a tick so an incoming setState can cancel it and render the
   *  right folder once. Cleared either way; if setState never comes (a plain
   *  open at the default folder) the timer fires and paints normally, so first
   *  paint is never actually delayed in that case. */
  private initialRenderTimer: number | null = null;
  /** 0.213.0: vault paths of attachments THIS composer wrote during the current
   *  compose (drop / paste / paperclip). Lets a send to another folder tell
   *  "staged for this note" apart from "a link the user pasted", which decides
   *  whether the file may be carried along. Cleared on every submit. */
  private composerCreatedAttachments = new Set<string>();
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
  /** Removes the heading's scroll listener; see installHeadingStuckObserver. */
  private headingStuckCleanup: (() => void) | null = null;
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
      const base = mode === "manual" ? this.order.getOrder(folder, parentId) : computeSortedIds(this, parentId, mode);
      return this.hoistListPinned(parentId, base);
    });
    // 0.190.0: adaptive — 80ms when a human is driving, stretched to a quiet-period
    // wait during a sync storm so the list settles once instead of thrashing.
    const scheduleRender = (): void => {
      const now = Date.now();
      // 0.266.6: "storm" is a RATE — how many change events landed in the last
      // RENDER_CALM_MS — recomputed from scratch every call.
      //
      // It used to be a running count plus a sticky flag, reset only when the
      // gap between two CONSECUTIVE events exceeded the calm window. That reads
      // as "reset when things go quiet", but it actually means "reset only if
      // no two events are ever closer than 900ms" — so a slow, steady trickle
      // pinned the view in storm mode indefinitely while the burst count
      // climbed without bound. Worse, the storm delay (700ms) is SHORTER than
      // the calm window, so a trickle at roughly the storm's own cadence could
      // never clear it. Simulated: events every 800ms — about 1.25/sec, nobody's
      // idea of a storm — ended in storm mode with a burst count of 30, and
      // that is the 703ms metronome the phone traces show.
      //
      // A window that holds timestamps cannot latch: when the rate drops the
      // old entries simply age out. The earlier note here warned that a rolling
      // window "silently defeated itself" by clearing every second; that was a
      // window over the COUNT, which threw away the history it needed. Keeping
      // the timestamps is what makes the rolling version correct — verified
      // against a true 50ms burst (still a storm), an 800ms trickle (not), and
      // a burst followed by a trickle (recovers).
      this.renderBurstTimes.push(now);
      const cutoff = now - RENDER_CALM_MS;
      while (this.renderBurstTimes.length && this.renderBurstTimes[0] < cutoff) {
        this.renderBurstTimes.shift();
      }
      const storm = this.renderBurstTimes.length > RENDER_BURST_THRESHOLD;
      // 0.266.3: the ~700ms render cadence on the phone was this debounce
      // sitting in storm mode, not a stray timer — so the open question is what
      // keeps FEEDING it. Trace the caller: a storm only persists while change
      // events keep arriving, and the stack says which source is producing
      // them. Cheap (a string split, only while the debugger is on) and it
      // turns the next dump into a name instead of another hypothesis.
      // 0.267.10: capturing a stack is EXPENSIVE, and this runs on every render
      // schedule. With tracing on that made the whole app perceptibly slower —
      // reported as "hitting copy on the debug log takes a few seconds, it used
      // to be instant". The copy was never slow; everything was, because the
      // debugger was paying for a stack unwind on every scheduled render, and
      // keepNames made each unwind produce more string to build.
      //
      // Rate-limited to one capture per RATE window. The caller is only news
      // when it CHANGES, so a sample is worth as much as every occurrence and
      // costs a fraction — while a burst still gets its first frame captured,
      // which is the one that says what started it.
      if (this.plugin.settings.debugTrace) {
        const nowMs = Date.now();
        const wantStack = nowMs - this.lastSchedStackAt > 250;
        if (wantStack) this.lastSchedStackAt = nowMs;
        // 0.266.9: the caller capture came back EMPTY on iOS, which cost a whole
        // trace. `slice(2, 5)` assumed V8's format, where the stack starts with
        // an "Error" line and frames read `at fn (file)`. WebKit has no header
        // line and frames read `fn@file`, so slicing off two lines threw away
        // real frames and the normaliser matched nothing.
        //
        // Parse instead of assume: drop a leading "Error", accept BOTH frame
        // shapes, and drop this scheduler's own frames so the first name shown
        // is the actual caller.
        const frames = !wantStack ? [] : (new Error().stack ?? "").split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !/^Error\b/.test(l))
          .map((l) => l.replace(/^at\s+/, "").replace(/\s*\(.*$/, "").replace(/@.*$/, "").trim())
          .filter((l) => l && !/scheduleRender|debouncedRender/.test(l));
        this.plugin.trace("render:sched", {
          burst: this.renderBurstTimes.length,
          storm: storm ? 1 : 0,
          // Is a render ON THE STACK right now? If this is ever 1, a render is
          // scheduling the next one and the list can never settle — which is
          // exactly the shape an 80ms metronome with unchanging state has.
          inRender: StashpadView.renderDepth > 0 ? 1 : 0,
          by: !wantStack ? "(sampled out)" : (frames.slice(0, 4).join(" < ").slice(0, 160) || "(no stack)"),
        });
      }
      const delay = storm
        ? RENDER_STORM_DELAY_MS
        : (now < this.postCreateSettleUntil ? 400 : 80);
      if (this.renderTimer != null) window.clearTimeout(this.renderTimer);
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        // NB: nothing to clear here. Getting a render in doesn't end a storm —
        // events stopping does, and that falls out of the window above ageing
        // its timestamps out on the next call.
        if (this.renderSuppressed()) return;
        this.render();
      }, delay);
    };
    this.debouncedRender = Object.assign(scheduleRender, {
      cancel: () => {
        if (this.renderTimer != null) { window.clearTimeout(this.renderTimer); this.renderTimer = null; }
      },
    });
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
    try { (this.leaf as any).updateHeader?.(); } catch { /* ignore */ }
    // Direct DOM update for the in-view title — reads from the leaf's view-header.
    const headerEl: HTMLElement | undefined = (this as any).headerEl ?? (this as any).containerEl?.querySelector?.(".view-header");
    const titleEl = headerEl?.querySelector?.(".view-header-title") as HTMLElement | null
      ?? (this as any).titleEl as HTMLElement | null;
    if (titleEl && titleEl.textContent !== text) titleEl.setText(text);
  }
  getIcon(): string {
    // 0.118.0: per-folder icon (set in settings) overrides the default, so a
    // folder's tab carries its own Lucide icon. Obsidian renders the tab icon
    // via setIcon, which only understands Lucide ids — an invalid id renders
    // nothing, so the picker shows a live preview to guard against that.
    return this.plugin.getFolderIcon(this.noteFolder) ?? "list-tree";
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.addClass("stashpad-scroll-host");
    this.viewRoot = host.createDiv({ cls: "stashpad-view" });
    this.viewRoot.setAttribute("tabindex", "0");
    this.installKeyboardTrace();
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
      // 0.209.7: claim Mod+A while focus is inside a Stashpad text field.
      //
      // Another plugin registering a DOCUMENT-level keydown listener for select-all
      // can swallow Mod+A before the composer ever sees it, so the user gets that
      // plugin's behaviour while typing here. Obsidian routes keys through the
      // keymap BEFORE bubble-phase document listeners (the same reason Escape needs
      // a Scope rather than stopPropagation), so registering here preempts it
      // regardless of what any other plugin does at the document level.
      //
      // Only text fields are claimed. With focus in the LIST, we return true so the
      // event continues to the existing selectAll binding — that path already works
      // and must keep working.
      viewScope.register(["Mod"], "a", (evt: KeyboardEvent) => {
        const el = (this.containerEl?.ownerDocument?.activeElement ?? null) as HTMLElement | null;
        const isTextField = !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
        if (!isTextField) return true; // list focus — let the note select-all binding run
        evt.preventDefault();
        const field = el as HTMLTextAreaElement & { select?: () => void };
        try { field.select?.(); } catch { /* contenteditable — fall through */ }
        if (el.isContentEditable) {
          const doc = el.ownerDocument;
          const range = doc.createRange();
          range.selectNodeContents(el);
          const sel = doc.defaultView?.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        return false; // consumed — a document-level listener elsewhere never runs
      });
      (this.app as any).keymap?.pushScope(viewScope);
    };
    const popViewScope = (): void => {
      if (!viewScope) return;
      try { (this.app as any).keymap?.popScope(viewScope); } catch { /* ignore */ }
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

    this.detachTreeHook = this.tree.hookMetadataCache((structural) => {
      // 0.218.0: a frontmatter-only change (color, completed, due, assignees)
      // is repainted on the EXISTING rows — rebuilding the list for those is
      // what made it jump when you set a color or ticked a to-do. Anything
      // structural, or an attribute change the repaint can't express (a
      // checkbox appearing), still gets the full render.
      if (structural || !this.repaintRowAttributes()) this.debouncedRender();
      this.scheduleStructureSnapshot(); // 0.206.0 recovery sidecar (debounced)
    });
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
      // 0.267.1: the cache is now authoritative for this file, so drop our
      // override rather than letting it shadow a change made elsewhere.
      this.obscuredState.delete(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      for (const map of [this.completedState, this.taskTaggedState]) {
        if (map.has(oldPath)) { map.set(file.path, map.get(oldPath)!); map.delete(oldPath); }
      }
      // 0.211.6 (L9): the authorship tracker's four path-keyed maps need the same
      // re-key, or a body edit made straight after an auto-reslug is treated as a
      // first sighting and its contribution stamp is silently skipped.
      this.authorship.handleRename(oldPath, file.path);
      // 0.211.6 (L8): the order/sort sidecar stores are keyed by FOLDER path. On a
      // folder rename their debounced write would otherwise fire against the old
      // path — recreating the folder the user just renamed away, and losing the
      // reorder — and the stale cache entry could later seed a new folder created at
      // that same path.
      if (file instanceof TFolder) {
        this.order.handleFolderRename(oldPath, file.path);
        this.sortStore.handleFolderRename(oldPath, file.path);
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
    this.detachSettings = onSettingsChange((sig: string) => {
      this.loadConfig();
      /** Set when the draft reconciliation below actually changes something the
       *  user can see, so a skipped render is never a skipped update. */
      let touched = false;
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
        touched = true;
      } else if (persisted === "" && liveText !== "") {
        // User is typing — keep their text but sync composerDraft to it
        // so the next save reflects reality.
        this.composerDraft = liveText;
      }
      // Preserve composer focus across the upcoming re-render. Without
      // this, deleting all chars in the composer (debounced empty-save
      // → loud broadcast → render tears down the textarea) silently
      // dropped focus.
      // Nothing that affects this list changed, and the composer reconciliation
      // above did not touch anything either — so there is nothing to repaint.
      // This is the whole saving: a draft save now costs one comparison per open
      // view instead of a full render each.
      const changed = sig !== this.settingsRenderSig;
      this.settingsRenderSig = sig;
      if (!changed && !touched) {
        this.plugin.trace("render:skip-settings", { folder: this.noteFolder });
        return;
      }
      const hadComposerFocus = !!this.composerInputEl
        && document.activeElement === this.composerInputEl;
      if (hadComposerFocus) this.focusComposerOnNextRender = true;
      this.debouncedRender();
    });
    (this.app.vault as any).on("modify", this.onFileModify);
    (this.app.vault as any).on("create", this.onFileCreate);
    // Bind to the leaf's OWN window — a popout/tiny-window leaf lives in its own
    // Electron window with its own document, so keydowns there never reach the
    // main window's listener and list-level shortcuts were dead. Equals `window`
    // for normal leaves. Captured so onClose removes it from the same one. 0.140.17
    this.keydownWindow = (this.containerEl?.ownerDocument?.defaultView ?? window) as Window;
    this.keydownWindow.addEventListener("keydown", this.onDocKeyDown, true);
    this.loadConfig();
    // 0.208.3: DEFER the bootstrap by one task. Do not make it eager again.
    //
    // Obsidian delivers view state through setState(), which runs AFTER onOpen.
    // A tab opened on a NON-default folder therefore spends onOpen believing it
    // is the default folder — loadConfig() resolves noteFolder from
    // settings.folder — and an eager bootstrapFolder() CREATED that folder
    // (+ Home + _exports) before setState arrived and switched to the real one.
    // Net effect: opening any other Stashpad silently conjured a stray default
    // "Stashpad" folder in the vault. Long-standing, and newly VISIBLE because
    // 0.208.0 announces folder creation — so it also fired a notice naming a
    // folder the user never asked for.
    //
    // Reading leaf.getViewState() here does not help: the leaf has not stored
    // the new state yet at onOpen time (verified — the read comes back empty).
    // Deferring does, because setState lands first and its own
    // loadConfig/bootstrapFolder/rebuild handles the real folder. When no state
    // is coming (a plain default-folder open) this still bootstraps, just a tick
    // later, and bootstrappedFolders keeps the two paths from duplicating work.
    window.setTimeout(() => {
      void (async () => {
        // 0.71.36: bootstrap can throw "Folder already exists" when the vault
        // state races our cache check on tab open/close. Swallow that specific
        // case — bootstrap is idempotent on next mount.
        try { await this.bootstrapFolder(); } catch (e) {
          const msg = (e as Error)?.message ?? "";
          if (!/already exists/i.test(msg)) console.warn("[Stashpad] bootstrapFolder failed:", e);
          return;
        }
        // The first paint happened against a not-yet-bootstrapped folder, so
        // pick up the Home note this just created.
        if (!this.viewRoot?.isConnected) return;
        this.tree.rebuild(this.noteFolder);
        this.render();
      })();
    }, 0);
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
      // Sheet versions: restore which version of each group is shown.
      this.activeVersionByGroup = this.plugin.loadActiveVersions(this.noteFolder);
    } catch { /* ignore */ }
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
    // 0.219.2: deferred by a tick — see initialRenderTimer. setState cancels it
    // when it is about to render the real folder itself.
    this.initialRenderTimer = window.setTimeout(() => {
      this.initialRenderTimer = null;
      if (!this.viewRoot?.isConnected) return;
      this.render(initialPolicy);
    }, 0);
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
    // 0.132.0: on open, focus the composer only when opted in; otherwise focus
    // the LIST so arrow-key navigation works right away (composer no longer
    // grabs focus every time). focusComposer() self-gates on the same setting.
    if (getSettings().focusComposerOnOpen) this.focusComposer(); else this.focusView();
    // Re-focus whenever this Stashpad leaf becomes the active one (e.g. user closes
    // a sibling tab via Cmd+W and lands back here, or switches into a Stashpad tab).
    // Also release the sticky-bottom flag when the user switches AWAY from this
    // Stashpad — leaving the tab signals their attention has moved; coming back
    // shouldn't yank the view to the bottom on the next render. Re-arming the flag
    // is the composer-submit / scrollToBottomOnNextRender path's job.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) {
        // 0.268.16: second route for a deferred render, because the fix above
        // means far more of them are deferred and onResize is now the only
        // thing standing between a hidden view and stale content. Becoming the
        // active leaf is the other moment "hidden" stops being true, and paying
        // a redundant flush here is cheaper than one tab showing old data.
        this.flushPendingVisibleRender();
        if (getSettings().focusComposerOnOpen) this.focusComposer(); else this.focusView();
      }
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
  /** True while a bulk op (long split paste, rebootstrap) is writing, so
   *  metadata-driven re-renders are dropped to avoid per-note flicker. */
  /** Obsidian calls this when the view is laid out, which includes becoming
   *  visible — the moment a render deferred by renderSuppressed must happen. */
  onResize(): void {
    this.flushPendingVisibleRender();
  }

  /** Render now if one was deferred while this view was offscreen AND it is
   *  actually laid out again. Safe to call from anywhere: it no-ops when
   *  nothing is owed or the view is still hidden. */
  private flushPendingVisibleRender(): void {
    if (!this.pendingVisibleRender) return;
    if (!this.listEl || this.listEl.clientHeight === 0) return;   // still hidden
    this.pendingVisibleRender = false;
    this.plugin.trace("render:flush-deferred", { folder: this.noteFolder });
    // The tree may have moved on while this view was not rendering, so rebuild
    // rather than repainting a stale model — the deferral is longer now.
    this.tree.rebuild(this.noteFolder);
    this.render();
  }

  private renderSuppressed(): boolean {
    // 0.267.9: a view nobody can see does not need to render NOW.
    //
    // A phone trace showed one child-note creation rendering THREE views: the
    // visible one, plus background tabs holding 339 and 713 rows, each
    // reporting a list height of 0 because they are not on screen. Rebuilding
    // 700 offscreen rows competes with the visible list for the main thread at
    // exactly the moment it is trying to settle — which is the stutter.
    //
    // Deferred rather than dropped: the view is marked dirty and renders when
    // it becomes visible, so switching to that tab shows current data. Checked
    // via the container rather than a workspace API because what matters is
    // literally whether it has been laid out.
    // 0.268.16: `!this.pendingVisibleRender` used to be part of this condition,
    // which inverted the whole guard after its first use. Once the flag was set,
    // the term went false, the branch stopped matching, and every SUBSEQUENT
    // render on that hidden view fell through and ran. So exactly one render was
    // deferred and the rest behaved as if the suppression did not exist.
    //
    // A trace showed the cost: one settings save rebuilt 23 views, among them a
    // 714-row and two 342-row lists reporting height 0 because they are not on
    // screen, and the main thread stalled 407ms. The flag records that a render
    // is owed, so it must not also decide whether one is suppressed.
    if (this.listEl && this.containerEl.isConnected && this.listEl.clientHeight === 0
        && this.leaf.view === this) {
      this.pendingVisibleRender = true;
      return true;
    }
    return this.bulkRenderDepth > 0
      || this.bulkSettleTimer != null
      || this.autoSyncDeferActive
      || this.plugin.rebootstrapInProgress
      || this.plugin.okfRebuildingFolders.has(this.noteFolder);
  }

  /** Open a bulk-render window: metadata-driven renders are suppressed until the
   *  matching endBulkRender (+ settle). Nestable. */
  private beginBulkRender(): void {
    this.bulkRenderDepth++;
    if (this.bulkSettleTimer != null) { window.clearTimeout(this.bulkSettleTimer); this.bulkSettleTimer = null; }
  }

  /** Close a bulk-render window. Keeps suppressing through a short settle delay
   *  (so trailing metadata-parse events don't each repaint), then rebuilds +
   *  renders ONCE. */
  private endBulkRender(settleMs = 500): void {
    if (this.bulkRenderDepth > 0) this.bulkRenderDepth--;
    if (this.bulkRenderDepth > 0) return;
    if (this.bulkSettleTimer != null) window.clearTimeout(this.bulkSettleTimer);
    this.bulkSettleTimer = window.setTimeout(() => {
      this.bulkSettleTimer = null;
      if (!this.viewRoot?.isConnected) return;
      this.tree.rebuild(this.noteFolder);
      this.render();
    }, settleMs);
  }

  // --- Auto sync-burst deferral (0.122.8, F7) -----------------------------
  // Obsidian Sync (and any external bulk write) fires a stream of `modify`/
  // `create` events that none of the explicit bulk flags above cover — each
  // one would otherwise repaint the list, which on mobile makes it unusable
  // for the duration of a sync. Detect a burst of file events, engage the
  // same render suppression, surface a notice, and repaint ONCE when it
  // settles.
  private syncBurstTimes: number[] = [];
  private autoSyncDeferActive = false;
  private autoSyncSettleTimer: number | null = null;
  private autoSyncNotice: Notice | null = null;

  /** Record an external file event; returns true when the render should be
   *  deferred (a burst is in progress). Resets the settle timer on every
   *  event so the notice stays up for the whole sync, then clears. */
  private deferDuringSyncBurst(): boolean {
    // Rebootstrap has its own suppression + one-shot repaint flow — don't
    // double up a notice on top of it.
    if (this.plugin.rebootstrapInProgress) return false;
    const now = Date.now();
    this.syncBurstTimes.push(now);
    const cutoff = now - 2000;
    while (this.syncBurstTimes.length && this.syncBurstTimes[0] < cutoff) this.syncBurstTimes.shift();
    if (!this.autoSyncDeferActive && this.syncBurstTimes.length >= 6) {
      this.autoSyncDeferActive = true;
      // 0.214.1: this said "syncing", but all deferDuringSyncBurst actually
      // knows is that >= 6 file-change events landed inside 2 seconds. Obsidian
      // Sync produces that, and so does an import, a bulk paste, a folder move,
      // another plugin writing, a re-index, or a local deploy with Obsidian
      // open. Claiming Sync sent people looking at their Sync settings for a
      // problem that wasn't there. Describe the observation, not a guess at the
      // cause.
      this.autoSyncNotice = new Notice("Stashpad: lots of files are changing — list updates paused until it settles…", 0);
    }
    if (!this.autoSyncDeferActive) return false;
    if (this.autoSyncSettleTimer != null) window.clearTimeout(this.autoSyncSettleTimer);
    this.autoSyncSettleTimer = window.setTimeout(() => this.endAutoSyncDefer(), 1500);
    return true;
  }

  private endAutoSyncDefer(): void {
    this.autoSyncSettleTimer = null;
    this.autoSyncDeferActive = false;
    this.syncBurstTimes = [];
    this.autoSyncNotice?.hide();
    this.autoSyncNotice = null;
    this.forceReconcileRender();
  }

  /** Public: a one-shot rebuild + render. Used by the plugin after rebootstrap
   *  clears `rebootstrapInProgress` to repaint the (suppressed) view once. */
  forceReconcileRender(): void {
    if (!this.viewRoot?.isConnected) return;
    this.tree.rebuild(this.noteFolder);
    this.render();
  }

  private scheduleTreeReconcile(): void {
    if (this.renderSuppressed()) return;
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
        // 0.219.3: skip RESERVED subfolders — _archive / _attachments /
        // _authors / _imports / _exports / _processed and the per-folder
        // archive/ + trash/. The tree deliberately never descends into them
        // (TreeIndex.collectMarkdown), so counting their files here compared a
        // number that includes them against one that never can.
        //
        // Archived notes keep their Stashpad `id`, so the `id` test below does
        // NOT filter them out — which made the mismatch PERMANENT for any
        // folder that has ever archived a note. A permanent mismatch means this
        // reconcile rebuilds the tree and re-renders the whole list ~400ms
        // after EVERY metadata event, including our own frontmatter writes. On
        // a real vault that is what made the list jump on every color change,
        // to-do toggle and completed toggle. Measured on the user's device:
        // onDisk 417 vs tree 368 — 49 archived notes — firing before every
        // single reported jump.
        const relDirs = dir === folder ? [] : dir.slice(prefix.length).split("/");
        if (relDirs.some((seg) => isReservedSubfolderName(seg))) continue;
        const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
        if (typeof id === "string" && id) onDisk++;
      }
      if (onDisk === this.tree.fileBackedCount()) return; // in sync — no-op
      // 0.219.2: this fires ~400ms after a metadata event and, when the counts
      // disagree, rebuilds + renders — which is a full list rebuild and so an
      // anchor-restore jump. If a vault has a PERSISTENT mismatch (a note the
      // tree doesn't track, or vice versa) this runs after every frontmatter
      // write forever, which looks exactly like "the list moves when I change a
      // color". Logged so a device trace can confirm or clear it: a healthy
      // vault should show this only while a folder is first loading.
      // 0.219.4: a rebuild only helps when the tree is STALE. It cannot help
      // when the gap is structural — TreeIndex keys nodes by frontmatter `id`,
      // so N files sharing one id collapse to a single node and the counts can
      // never agree. Before this guard, such a folder rebuilt + re-rendered the
      // whole list ~400ms after EVERY metadata event, forever: the reported
      // "the list jumps when I change a color". Measured on the user's vault:
      // onDisk 418 vs tree 369 — 49 duplicate ids — unchanged by the rebuild.
      //
      // So: rebuild once, and if the count did not move, record that this count
      // is unresolvable and stop. Any real change to the note count clears it.
      if (onDisk === this.reconcileUnresolvableAt) return;
      const beforeCount = this.tree.fileBackedCount();
      this.plugin.trace("reconcile", { folder, onDisk, tree: beforeCount });
      this.tree.rebuild(folder);
      const afterCount = this.tree.fileBackedCount();
      if (afterCount === beforeCount) {
        this.reconcileUnresolvableAt = onDisk;
        this.plugin.trace("reconcile:unresolvable", { folder, onDisk, tree: afterCount, gap: onDisk - afterCount });
        this.warnDuplicateIds(folder, onDisk - afterCount);
        return; // rebuilding changed nothing — re-rendering cannot help either
      }
      this.debouncedRender();
    }, 400);
  }

  /** 0.219.4: a persistent on-disk-vs-tree gap almost always means DUPLICATE
   *  frontmatter ids — two notes claiming the same id collapse into one node,
   *  so one of them is invisible in the list while still occupying disk. That
   *  is a real data problem worth telling the user about (Stashpad has an
   *  integrity check for it), not just something to silently stop retrying.
   *  Surfaced once per session, and only when the gap is real. */
  private warnDuplicateIds(folder: string, gap: number): void {
    // 0.261.0: the guard is PLUGIN-level, not per-view. It used to be a field
    // on the view, so every open Stashpad tab reported the same vault-wide
    // problem once each — three tabs, three identical toasts. The condition is
    // about the vault, so the "already said this" flag has to be too.
    if (this.plugin.reportedDuplicateIds || this.reportedDuplicateIds || gap <= 0) return;
    // 0.219.8: check EVERY folder, not just this one. The reconcile that calls
    // us only ever runs for a folder with an open view, so scoping the warning
    // to `folder` under-reported — a vault with duplicates in three folders
    // reported whichever tab happened to be in front.
    const perFolder = this.plugin.duplicateGroupsEverywhere();
    if (!perFolder.length) return;   // gap has some other cause — don't guess
    this.reportedDuplicateIds = true;
    this.plugin.reportedDuplicateIds = true;
    const hidden = perFolder.reduce((n, f) =>
      n + f.groups.reduce((m, g) => m + g.files.filter((x) => !x.isShown).length, 0), 0);
    const where = perFolder.length === 1 ? `**${perFolder[0].folder}**` : `${perFolder.length} folders`;
    this.plugin.notifications.show({
      message: `${hidden} note${hidden === 1 ? " is" : "s are"} hidden by duplicate ids in ${where}.`,
      kind: "warning",
      category: "system",
      folder,
      duration: 0,
      actions: [{
        label: "Review duplicates",
        onClick: () => { void this.plugin.findDuplicateNoteIds(); },
      }],
    });
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
    if (!getSettings().focusComposerOnOpen) return; // 0.132.0: decoupled from after-send
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
      this.composerInputEl?.focus({ preventScroll: true });
    };
    requestAnimationFrame(tryFocus);
    setTimeout(tryFocus, 50);
    setTimeout(tryFocus, 200);
  }

  /** 0.206.0: hand the current shape to the per-folder structure snapshot —
   *  the sidecar that lets a note whose frontmatter got wiped be put back
   *  (see structure-snapshot.ts + `repairFolderFromSnapshot`). Cheap and
   *  debounced inside the store, so calling it on every tree change is fine.
   *  Never throws into the render path: a recovery aid must not be able to
   *  break the thing it's protecting. */
  private scheduleStructureSnapshot(): void {
    try {
      const folder = this.noteFolder;
      if (!folder) return;
      const notes: Record<string, { parent: string | null; path: string; created?: string; title?: string }> = {};
      for (const node of this.tree.allNodes()) {
        if (node.id === ROOT_ID || !node.file) continue;
        notes[node.id] = {
          parent: node.parent && node.parent !== ROOT_ID ? node.parent : null,
          path: node.file.path,
          created: node.created || undefined,
          title: this.titleForNode(node).trim().slice(0, 80) || undefined,
        };
      }
      this.plugin.structureStore.schedule(folder, notes);
    } catch (e) {
      console.warn("[Stashpad] structure snapshot schedule failed", e);
    }
  }

  async onClose(): Promise<void> {
    this.hideInstantTooltip();
    if (this.initialRenderTimer != null) {
      window.clearTimeout(this.initialRenderTimer);
      this.initialRenderTimer = null;
    }
    clearActiveView(this);
    // Cancel any pending debounced render so it can't fire post-close (the
    // render() isConnected guard also catches it — belt and suspenders). 0.140.9
    (this.debouncedRender as any)?.cancel?.();
    // Tear down the tiny-opacity popover's document listeners if it's still open. 0.140.17
    this.tinyOpacityClose?.();
    this.detachTreeHook?.();
    this.detachSettings?.();
    (this.app.vault as any).off("modify", this.onFileModify);
    (this.app.vault as any).off("create", this.onFileCreate);
    this.keydownWindow.removeEventListener("keydown", this.onDocKeyDown, true);
    this.listResizeObserver?.disconnect();
    this.listResizeObserver = null;
    this.stickyRowObserver?.disconnect();
    this.stickyRowObserver = null;
    this.bodyRenderer.dispose();
    this.barOverflowRO?.disconnect();
    this.barOverflowRO = null;
    this.composerNarrowObserver?.disconnect();
    this.composerNarrowObserver = null;
    this.headingStuckCleanup?.();
    this.headingStuckCleanup = null;
    if (this.treeReconcileTimer != null) { window.clearTimeout(this.treeReconcileTimer); this.treeReconcileTimer = null; }
    if (this.autoSyncSettleTimer != null) { window.clearTimeout(this.autoSyncSettleTimer); this.autoSyncSettleTimer = null; }
    this.autoSyncNotice?.hide();
    this.autoSyncNotice = null;
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
    try { await this.flushDrafts(); } catch { /* ignore */ }
    // Same idea for the order + sort stores, which debounce their writes
    // by 150ms. A close mid-window would otherwise drop the latest
    // reorder/sort-mode change. Both flushes are idempotent + safe to
    // call when nothing's pending.
    try { await this.order.flush(this.noteFolder); } catch { /* ignore */ }
    try { await this.plugin.structureStore.flush(this.noteFolder); } catch { /* ignore */ }
    try { await this.sortStore.flush(this.noteFolder); } catch { /* ignore */ }
    // Drain any pending frontmatter sync writes so the recovery fields
    // (parentLink / children) don't lag behind tree state across a
    // close + reopen.
    try { await this.fmSync.flush(); } catch { /* ignore */ }
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
    this.applyTimeFilterState(s);
  }
  getEphemeralState(): Record<string, unknown> {
    return { focusId: this.focusId, ...this.timeFilterState() };
  }

  // Persisted in workspace.json — survives reloads and app restarts.
  getState(): Record<string, unknown> {
    const base = (super.getState()) ?? {};
    return {
      ...base,
      folderOverride: this.folderOverride,
      ...this.timeFilterState(),
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
      this.applyTimeFilterState(s);
      if (s.focusId) this.focusId = s.focusId;
      // 0.132.0: a fresh tab opened "in context" from search carries the note id
      // to cursor/reveal once the list renders.
      if ((s as { cursorId?: string }).cursorId) this.pendingCursorId = (s as { cursorId?: string }).cursorId as StashpadId;
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
        // Sheet versions: re-hydrate active versions for the new folder.
        this.activeVersionByGroup = this.plugin.loadActiveVersions(this.noteFolder);
      } catch { /* ignore */ }
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
      // 0.219.2: this render supersedes the deferred first paint — drop it so
      // the default folder is never built and discarded.
      if (this.initialRenderTimer != null) {
        window.clearTimeout(this.initialRenderTimer);
        this.initialRenderTimer = null;
      }
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
        "_failed-imports",
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
    try { this.app.workspace.requestSaveLayout(); } catch { /* ignore */ }
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

  /** 0.211.6 (L1): drain any queued `parentLink`/`children` recovery writes.
   *
   *  `FrontmatterSyncQueue` drains in the background with a 100ms gap between writes,
   *  so a queued write can land AFTER the encryption lock has baselined a note's
   *  mtime. The purge then sees a newer mtime, correctly refuses to delete the note —
   *  but the bundle has already been written, so the vault ends up holding both the
   *  plaintext note and its encrypted copy, and restoring later produces a duplicate
   *  subtree. Flushing before the baseline closes that window. Public so the plugin
   *  (which owns the lock path but not the queue) can drain every open view first. */
  async flushFrontmatterSync(): Promise<void> {
    try { await this.fmSync.flush(); } catch { /* best effort — the mtime guard still protects the note */ }
  }

  /** 0.211.5 (M7 + M8): resolve the attachment refs a delete is about to remove into
   *  real TFiles, dropping any that a note OUTSIDE the delete set still references.
   *
   *  M7: the delete paths trashed every referenced attachment with no shared-use
   *  check, unlike the lock path and cross-folder paste which both compute
   *  exclusivity. An image embedded in two notes was deleted with the first, silently
   *  breaking the second.
   *
   *  M8: the delete loops trash the union of body embeds AND the frontmatter
   *  `attachments:` list, but `snapshotNotes` only collects body embeds — so a
   *  frontmatter-only attachment was trashed and never captured, and undo could not
   *  bring it back. Returning TFiles lets the caller snapshot and trash exactly the
   *  same set, which is the only way to keep those two in step.
   *
   *  Known limit: `resolvedLinks` indexes body links only, so a surviving note that
   *  references an attachment ONLY from its frontmatter list won't register as a
   *  sharer. Strictly better than the previous no-check behaviour; noted rather than
   *  papered over. */
  private async attachmentsSafeToDelete(refs: string[], deletingNotePaths: Set<string>): Promise<{ files: TFile[]; sharedSkipped: number }> {
    const byPath = new Map<string, TFile>();
    for (const ref of refs) {
      const f = this.app.metadataCache.getFirstLinkpathDest(ref, "");
      if (f) byPath.set(f.path, f);
    }
    const total = byPath.size;
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const notePath of Object.keys(resolved)) {
      if (deletingNotePaths.has(notePath)) continue; // a note being deleted isn't a sharer
      for (const target of Object.keys(resolved[notePath] ?? {})) byPath.delete(target);
    }
    return { files: [...byPath.values()], sharedSkipped: total - byPath.size };
  }

  /** Resolve a note's TFile id-first, falling back to a captured path. Undo/redo
   *  closures run long after capture; Stashpad renames a note's file ~30s after a
   *  body edit (slug change), so a path captured at command time goes stale and a
   *  path-only lookup silently returns null → the undo no-ops while the stack
   *  advances. The id is stable, so `tree.get(id)?.file` finds the note at its
   *  current path; the path fallback covers notes not (yet) in the tree. 0.140.10 */
  private fileForNote(id: StashpadId | null | undefined, path: string): TFile | null {
    const byId = id ? this.tree.get(id)?.file : null;
    return (byId ?? this.app.vault.getAbstractFileByPath(path)) as TFile | null;
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
      } catch { /* ignore */ }
    }
    for (const n of snap.notes) {
      try {
        // 0.140.9: guard against re-minting a DUPLICATE id. Undo closures capture
        // the snapshot PATH, but Stashpad renames files ~30s after a body edit
        // (slug change). If the note is still alive at a renamed path, its old
        // path is now free — creating there would put TWO files under one id in
        // the tree. Skip when a live note already carries this id.
        const fmHead = n.content.split("\n---")[0] ?? "";
        const idm = /^id:\s*["']?([^"'\s]+)/m.exec(fmHead);
        const nid = idm?.[1] as StashpadId | undefined;
        if (nid && this.tree.get(nid)?.file) continue;
        if (!(await this.app.vault.adapter.exists(n.path))) {
          await this.app.vault.create(n.path, n.content);
        }
      } catch { /* ignore */ }
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
      if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
    }
    for (const a of snap.attachments) {
      const f = this.app.vault.getAbstractFileByPath(a.path) as TFile | null;
      if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
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
    // 0.223.0: restore the bound append target alongside the draft. Resolved
    // against the tree, so a target deleted while we were away simply doesn't
    // come back (and the draft becomes an ordinary new note — the same
    // fail-safe the send path already has).
    const saved = this.plugin.settings.draftAppendTargets?.[this.noteFolder];
    // Resolved by PATH so a cross-folder target restores too. A target that was
    // deleted or moved while we were away simply doesn't come back, and the
    // draft becomes an ordinary new note — the same fail-safe the send path has.
    const savedFile = saved?.path ? this.app.vault.getAbstractFileByPath(saved.path) : null;
    this.appendTarget = savedFile instanceof TFile
      ? { id: saved!.id as StashpadId, label: saved!.label ?? savedFile.basename, path: saved!.path, folder: saved!.folder, mode: saved!.mode === "prepend" ? "prepend" : "append" }
      : null;
    this.refreshAppendButton();
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
    } catch { /* ignore */ }
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

  /** The ONE producer of the time cutoff consumed by filterChildren — so
   *  `pinnedFilterMode` keeps working off the same predicate. */
  private timeFilterCutoff(): number | null {
    if (this.timeFilterCount <= 0) return null;
    // ABSOLUTE: a fixed point in time, frozen when the user pinned it. It
    // does NOT slide, which is the whole point of the mode.
    if (this.timeFilterAnchor !== null) return this.timeFilterAnchor;
    return this.computeRelativeCutoff();
  }

  /** Evaluate the "last N <unit>" expression against NOW. */
  private computeRelativeCutoff(): number | null {
    const n = this.timeFilterCount;
    if (n <= 0) return null;
    const meta = timeUnitMeta(this.timeFilterUnit);
    if (this.timeFilterCalendar) {
      // Calendar-aligned: start of the current period, then back N-1 whole
      // periods. At n === 1 this is exactly the old Today/Week/Month/Year.
      const m = (moment as any)().startOf(meta.startOf);
      return (n > 1 ? m.subtract(n - 1, meta.plural) : m).valueOf();
    }
    return Date.now() - n * meta.ms;
  }

  /** Whether any time cutoff is in force (used by the "filter is active" hints). */
  private timeFilterActive(): boolean { return this.timeFilterCount > 0; }

  /** Legacy chip key closest to the current spec. Written into view state so
   *  an older build (or an older saved layout round-trip) still restores
   *  something sane. `hour` has no legacy equivalent → "day". */
  private legacyTimeFilter(): TimeFilter {
    if (this.timeFilterCount <= 0) return "all";
    switch (this.timeFilterUnit) {
      case "week": return "week";
      case "month": return "month";
      case "year": return "year";
      default: return "day";
    }
  }

  /** The time-filter half of view state. Writes the new count/unit/anchor
   *  keys AND the derived legacy `timeFilter` key (back-compat: an older
   *  build, or any consumer still reading the chip key, keeps working). */
  private timeFilterState(): Record<string, unknown> {
    return {
      timeFilter: this.legacyTimeFilter(),
      timeFilterCount: this.timeFilterCount,
      timeFilterUnit: this.timeFilterUnit,
      timeFilterAnchor: this.timeFilterAnchor,
    };
  }

  /** Restore from view state, migrating pre-0.271.0 state that only carries
   *  the legacy chip key. The legacy mapping preserves the exact cutoff in
   *  both rolling and calendar mode, so no saved filter silently changes. */
  private applyTimeFilterState(s: Partial<ViewConfigState> | null | undefined): void {
    if (!s) return;
    if (typeof s.timeFilterCount === "number" && Number.isFinite(s.timeFilterCount)) {
      this.timeFilterCount = Math.max(0, Math.floor(s.timeFilterCount));
      if (s.timeFilterUnit && TIME_UNITS.some((u) => u.key === s.timeFilterUnit)) {
        this.timeFilterUnit = s.timeFilterUnit;
      }
      const a = s.timeFilterAnchor;
      this.timeFilterAnchor = typeof a === "number" && Number.isFinite(a) ? a : null;
      return;
    }
    if (s.timeFilter && s.timeFilter in LEGACY_TIME_FILTER) {
      const mig = LEGACY_TIME_FILTER[s.timeFilter];
      this.timeFilterCount = mig.count;
      this.timeFilterUnit = mig.unit;
      this.timeFilterAnchor = null;
    }
  }

  private timeFilterAnchorLabel(): string {
    const t = this.timeFilterAnchor;
    if (t === null) return "";
    const fmt = this.timeFilterUnit === "hour" ? "D MMM HH:mm" : "D MMM YYYY";
    return (moment as any)(t).format(fmt);
  }

  /** Compact label for the bar / accordion summary. */
  private timeFilterShortLabel(): string {
    if (this.timeFilterCount <= 0) return "All";
    if (this.timeFilterAnchor !== null) return this.timeFilterAnchorLabel();
    const meta = timeUnitMeta(this.timeFilterUnit);
    if (this.timeFilterCalendar && this.timeFilterCount === 1) return meta.calOne;
    return `${this.timeFilterCount}${meta.abbr}`;
  }

  /** Full sentence for tooltips. */
  private timeFilterLongLabel(): string {
    if (this.timeFilterCount <= 0) return "All time";
    if (this.timeFilterAnchor !== null) return `Since ${this.timeFilterAnchorLabel()} (fixed)`;
    const meta = timeUnitMeta(this.timeFilterUnit);
    const n = this.timeFilterCount;
    const noun = n === 1 ? meta.plural.replace(/s$/, "") : meta.plural;
    if (this.timeFilterCalendar) {
      return n === 1
        ? `Since the start of ${meta.calOne.replace(/^This /, "this ").replace(/^Today$/, "today")}`
        : `Since the start of the period ${n - 1} ${n - 1 === 1 ? noun : meta.plural} ago`;
    }
    return `Last ${n} ${noun}`;
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
    // 0.121.1 (item 5 follow-up): mobile appends the focused-note header into
    // the list. In COMPACT mode skip it (matching desktop compact, which omits
    // the focused header) — with the breadcrumb also hidden, leaving the header
    // in left an empty-looking block at the top. Compact = tight list, no header.
    // 0.258.0: ONE heading row, both platforms, sticky at the top of the list.
    // Replaces the desktop "header above the list" + the mobile
    // "header in the list plus a sticky mini preview" pair: `position: sticky`
    // does what the mini was hand-rolled to do, and being a row is what makes
    // it reachable by keyboard and selectable.
    if (this.headingNode() && !this.tinyMode) {
      this.renderFocusedHeader(list, focused, { asRow: true });
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
      // Two very different "empty"s. Drilling into a childless note is a normal,
      // frequent state and wants one quiet line. Sitting at the ROOT of a
      // Stashpad with nothing in it means the user has just arrived and has no
      // idea what to do — that one earns a real zero-state. Same branch used to
      // serve both, which is why first-run guidance was a single sentence.
      if (focused.id === ROOT_ID) this.renderRootZeroState(list);
      else list.createDiv({ cls: "stashpad-empty", text: "No notes here yet. Type below to add one." });
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
    // 0.258.0: install on EVERY platform. This was mobile-only because the
    // thing it drove (the sticky mini preview) was mobile-only; it now drives
    // the heading's stuck state, and the heading is on both platforms.
    if (this.headingNode() && !this.tinyMode) this.installHeadingStuckObserver(list);
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
    const hideTitle = !lk.title; // 0.137.1: hidden iff hidden AT LOCK TIME (empty stored title)
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
      const parentId = (lk.parentId ?? entry?.parentId ?? ROOT_ID);
      const prevSibling = (lk.prevSibling ?? entry?.prevSibling ?? null);
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
        // Undo = re-lock the just-decrypted subtree; redo = unlock again. A
        // re-lock mints a new blob path, so track it for the next redo.
        if (rootId) {
          const undoFolder = this.noteFolder;
          let curBlob = lk.blob;
          this.plugin.getUndoStack(undoFolder).push({
            label: "Unlock note",
            undo: async () => { const rr = await this.plugin.lockNoteSubtree(undoFolder, rootId, prevSibling, { silent: true }); if (rr) curBlob = rr.blobPath; this.render(); },
            redo: async () => { try { await this.plugin.unlockBundleAt(curBlob, { silent: true }); } catch { /* leave */ } this.render(); },
          });
        }
      }
    };
    unlockBtn.onclick = doUnlock;
    // 0.98.24: context menu for locked stubs — right-click on desktop, ⋮ button on
    // mobile (no right-click there). Locked stubs aren't tree nodes, so the normal
    // note menu (openNoteMenu) can't serve them; this is their own small menu.
    const openLockedMenu = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      // 0.155.0: locked rows present the SAME menu as normal notes (agreed
      // design). Built by the shared `populateLockedMenu` builder (locked-menu.ts)
      // — one source of truth for this menu + the two aggregate-view locked-row
      // menus. `fullParity` renders the full openNoteMenu-mirroring item set
      // (actions needing the decrypted note show an "unlock first" notice).
      const menu = new Menu();
      populateLockedMenu(menu, {
        app: this.app,
        plugin: this.plugin,
        descriptor: { blob: lk.blob, rootId: lk.rootId, count: lk.count, folder: this.noteFolder },
        unlockLabel: "Decrypt (unlock)",
        onUnlock: () => void doUnlock(e),
        onChange: () => this.render(),
        fullParity: true,
        confirmDelete: true,
      });
      menu.showAtMouseEvent(e);
    };
    row.oncontextmenu = openLockedMenu;
    // 0.150.0: menu button now shows on desktop too (was mobile-only), for
    // parity with a normal row's ⋯ button. Desktop right-click still works.
    const menuBtn = row.createEl("button", { cls: "stashpad-pencil stashpad-locked-menu" });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttr("aria-label", "Locked note menu");
    menuBtn.onclick = (e) => openLockedMenu(e);
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
    this.syncLevelScopedState();
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

  /** 0.272.4: does this note belong to `dayStart` (start-of-day epoch ms)?
   *  Created that day, OR links to the date as `[[YYYY-MM-DD]]`, OR its task
   *  `due` falls that day. */
  private nodeMatchesDate(n: TreeNode, dayStart: number): boolean {
    if (!n.file) return false;
    // Compare by CALENDAR DAY, not an epoch window: a bare `2026-08-18` (created
    // or due) parses as UTC midnight, which a local ms-window would shift out of
    // the day. moment().format normalises both sides to the local calendar day.
    const dayStr = (moment as any)(dayStart).format("YYYY-MM-DD");
    const sameDay = (v: unknown): boolean => {
      if (v == null || v === "") return false;
      const m = (moment as any)(typeof v === "number" ? v : String(v));
      return m.isValid() && m.format("YYYY-MM-DD") === dayStr;
    };
    if (sameDay(n.created)) return true;
    const fm = this.app.metadataCache.getFileCache(n.file)?.frontmatter;
    if (fm && sameDay(fm.due)) return true;
    const links = this.app.metadataCache.getFileCache(n.file)?.links ?? [];
    return links.some((l) => l.link.includes(dayStr) || (l.displayText ?? "").includes(dayStr));
  }

  /** Set/clear the single-day filter and repaint. */
  setDateFilter(dayStart: number | null): void {
    this.dateFilter = dayStart;
    this.render();
  }
  getDateFilter(): number | null { return this.dateFilter; }

  /** 0.272.4: a small popover with a native date input to pick the day filter.
   *  Native input so mobile gets the OS date wheel and desktop a real picker. */
  openDayFilterPicker(anchor: HTMLElement): void {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-day-filter-pop").forEach((p) => p.remove());
    const pop = doc.body.createDiv({ cls: "stashpad-day-filter-pop" });
    const input = pop.createEl("input", { type: "date" });
    input.value = (moment as any)(this.dateFilter ?? Date.now()).format("YYYY-MM-DD");
    const row = pop.createDiv({ cls: "stashpad-day-filter-pop-btns" });
    let done = false;
    const cleanup = (): void => { if (done) return; done = true; pop.remove(); doc.removeEventListener("mousedown", onDoc, true); };
    const onDoc = (ev: MouseEvent): void => { if (!pop.contains(ev.target as Node) && ev.target !== anchor) cleanup(); };
    row.createEl("button", { cls: "mod-cta", text: "Apply" }).onclick = () => {
      const ms = (moment as any)(input.value, "YYYY-MM-DD").startOf("day").valueOf();
      cleanup();
      if (Number.isFinite(ms)) this.setDateFilter(ms);
    };
    row.createEl("button", { text: this.dateFilter !== null ? "Clear" : "Cancel" }).onclick = () => {
      const wasSet = this.dateFilter !== null;
      cleanup();
      if (wasSet) this.setDateFilter(null);
    };
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, (doc.defaultView?.innerWidth ?? 9999) - 240)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    setTimeout(() => doc.addEventListener("mousedown", onDoc, true), 0);
    input.focus();
  }

  private filterChildren(children: TreeNode[]): TreeNode[] {
    // Sheet versions collapse FIRST and unconditionally (before the
    // no-filters early-return below): non-active versions of a group are
    // hidden so only the active one shows as a row.
    children = this.collapseVersions(children);
    const cutoff = this.timeFilterCutoff();
    const tag = this.tagFilter?.toLowerCase();
    const color = this.colorFilter?.toLowerCase() ?? null;
    const hideCompleted = this.currentHideCompleted();
    const attachmentsOnly = this.currentAttachmentsOnly();
    const importedOnly = this.importedOnly;
    const authorId = this.authorFilter;
    const dateFilter = this.dateFilter;
    if (!cutoff && !tag && !color && !hideCompleted && !attachmentsOnly && !importedOnly && !authorId && dateFilter === null) return children;
    // 0.270.2: how far a pin outranks the filters is a three-way setting.
    // "all"  - a pinned note is never hidden (early return below).
    // "time" - it survives the TIME cutoff only; the content filters below still
    //          apply, so a pin cannot pollute a tag/colour/author-filtered view.
    // "none" - no special treatment.
    // Covers BOTH pin kinds (list pin + sidebar pin) per "pinned notes of any kind".
    const pinMode = this.plugin.settings.pinnedFilterMode;
    return children.filter((n) => {
      const pinned = pinMode !== "none" && this.isPinnedAnyKind(n.id);
      if (pinned && pinMode === "all") return true;
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
      if (cutoff && n.created && !pinned) {
        const t = Date.parse(n.created);
        if (!Number.isNaN(t) && t < cutoff) return false;
      }
      if (dateFilter !== null && !pinned && !this.nodeMatchesDate(n, dateFilter)) return false;
      if (tag) {
        if (!n.file) return false;
        if (this.tagFilter === TAG_FILTER_TAGGED) { if (!this.nodeHasAnyTag(n)) return false; }
        else if (this.tagFilter === TAG_FILTER_UNTAGGED) { if (this.nodeHasAnyTag(n)) return false; }
        else if (!this.nodeHasTag(n, tag)) return false;
      }
      if (color) {
        const c = this.colorForNode(n)?.toLowerCase() ?? null;
        if (c !== color) return false;
      }
      // Hide-completed: applied uniformly. A completed note disappears
      // only when its subtree has no remaining work — so a category
      // checked off but still containing an unchecked task stays
      // visible until the last task is done.
      // 0.197.0: a MISSED repeat is marked completed only so it drops out of the
      // active cadence — it is not finished work. Hiding it with "hide completed"
      // would make the miss invisible, which is the whole thing we're trying to
      // surface, so missed occurrences stay visible.
      if (hideCompleted && this.isCompleted(n) && !this.isMissed(n) && !this.hasIncompleteDescendant(n)) return false;
      // Attachments-only: keep a node if it (or any descendant) has an
      // attachment, so the attachment-bearing child stays reachable.
      if (attachmentsOnly && !this.hasAttachmentInSubtree(n)) return false;
      return true;
    });
  }

  /** Collapse `sheet:` version groups so only the active version remains in
   *  the list. Notes without a sheet id pass through untouched. */
  private collapseVersions(children: TreeNode[]): TreeNode[] {
    // Feature is opt-in: when off, never hide anything.
    if (!this.plugin.settings.enableSheetVersions) return children;
    // Bucket nodes by group id; non-sheet nodes go straight through.
    const groups = new Map<string, TreeNode[]>();
    let anyGroup = false;
    for (const n of children) {
      const fm = nodeFm(this.app, n);
      if (!isVersionMember(fm)) continue; // needs BOTH sheet-group + sheet-order
      anyGroup = true;
      const gid = sheetIdOf(fm)!;
      const arr = groups.get(gid);
      if (arr) arr.push(n);
      else groups.set(gid, [n]);
    }
    if (!anyGroup) return children;
    // For each group, decide the single active member to keep.
    const keep = new Set<StashpadId>();
    for (const [gid, members] of groups) {
      const active = this.activeVersionNode(gid, members);
      if (active) keep.add(active.id);
    }
    return children.filter((n) => {
      // Only fully-stamped version members are eligible to be hidden.
      if (!isVersionMember(nodeFm(this.app, n))) return true;
      return keep.has(n.id);
    });
  }

  /** The version node to show for a group, honoring an explicit user choice
   *  when that choice is still present in the current set. */
  private activeVersionNode(groupId: string, members: TreeNode[]): TreeNode | null {
    const chosen = this.activeVersionByGroup.get(groupId);
    if (chosen) {
      const hit = members.find((m) => m.id === chosen);
      if (hit) return hit;
    }
    return defaultActive(this.app, members);
  }

  /** Switch which version of a group is shown, persist it, then repaint. */
  private setActiveVersion(groupId: string, id: StashpadId): void {
    this.activeVersionByGroup.set(groupId, id);
    this.plugin.saveActiveVersion(this.noteFolder, groupId, id);
    this.render();
  }

  /** True if `node`'s file carries ANY tag (inline or frontmatter) —
   *  backs the "Tagged"/"Untagged" filter modes. */
  private nodeHasAnyTag(node: TreeNode): boolean {
    if (!node.file) return false;
    const cache = this.app.metadataCache.getFileCache(node.file);
    if (!cache) return false;
    if (cache.tags && cache.tags.length > 0) return true;
    const fmTags = cache.frontmatter?.tags;
    if (fmTags) {
      const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
      if (arr.some((t) => typeof t === "string" && t.trim().length > 0)) return true;
    }
    return false;
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
      const row = list.querySelector(`[data-id="${anchor.id}"]`);
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
    // 0.265.2 (flicker investigation): renders are traced with an ID and a
    // DEPTH. The working hypothesis for the mobile scroll flicker is "several
    // renders running at once while the keyboard is up", and a flat log of
    // "render" lines cannot show overlap — two sequential renders and two
    // nested ones look identical. An id plus a depth makes an overlap visible
    // as an overlap. Zero cost when the trace is off (trace() checks first).
    const renderId = ++StashpadView.renderSeq;
    StashpadView.renderDepth++;
    this.plugin.trace("render:start", {
      id: renderId,
      depth: StashpadView.renderDepth,
      folder: this.noteFolder,
      focus: this.focusId,
      rows: this.currentChildren.length,
      top: Math.round(this.listEl?.scrollTop ?? -1),
      h: this.listEl?.scrollHeight ?? -1,
      kb: this.keyboardVisible ? 1 : 0,
    });
    this.backlinkIndex = null;   // rebuilt on demand; never carried across renders
    try {
      this.renderInner(policy);
    } finally {
      this.plugin.trace("render:end", {
        id: renderId,
        depth: StashpadView.renderDepth,
        top: Math.round(this.listEl?.scrollTop ?? -1),
        h: this.listEl?.scrollHeight ?? -1,
      });
      StashpadView.renderDepth--;
    }
  }

  /** 0.265.2 (flicker investigation): track and trace the on-screen keyboard.
   *
   *  The reported symptom is "flicker when the keyboard is visible", and the
   *  trace previously had no way to say whether it was. iOS fires no keyboard
   *  event, so this infers it two ways and records both — `visualViewport`
   *  height collapsing is the reliable signal, focus is the intent. Recording
   *  the RESIZE separately matters: a viewport resize while the list is
   *  scrolled is itself a plausible cause, not just context for one.
   *
   *  Everything here is inert unless the debug trace is switched on. */
  private installKeyboardTrace(): void {
    const vv = (window as unknown as { visualViewport?: {
      height: number; addEventListener: (t: string, f: () => void) => void;
      removeEventListener: (t: string, f: () => void) => void } }).visualViewport;
    let lastH = vv?.height ?? window.innerHeight;
    const onResize = (): void => {
      const h = vv?.height ?? window.innerHeight;
      const delta = h - lastH;
      if (Math.abs(delta) < 60) return;   // orientation jitter, not a keyboard
      lastH = h;
      // A big SHRINK is the keyboard arriving; a big grow is it leaving.
      this.keyboardVisible = delta < 0;
      this.plugin.trace("keyboard", {
        visible: this.keyboardVisible ? 1 : 0,
        vh: Math.round(h),
        delta: Math.round(delta),
        listTop: Math.round(this.listEl?.scrollTop ?? -1),
        listH: this.listEl?.scrollHeight ?? -1,
      });
    };
    if (vv) {
      vv.addEventListener("resize", onResize);
      this.register(() => vv.removeEventListener("resize", onResize));
    }
    // Focus is the INTENT signal — it lands before the viewport moves, so a
    // trace showing focus-then-resize-then-render tells a different story from
    // resize-then-render.
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) {
        this.plugin.trace("keyboard:focus", { el: t.className.slice(0, 40) });
      }
    };
    this.viewRoot.addEventListener("focusin", onFocusIn);
    this.register(() => this.viewRoot.removeEventListener("focusin", onFocusIn));
  }

  /** Monotonic render id + live nesting depth, shared across views — the
   *  flicker may well involve two DIFFERENT views rendering at once, which a
   *  per-instance counter would hide. */
  private static renderSeq = 0;
  private static renderDepth = 0;
  /** Best-effort "is the on-screen keyboard up". Tracked from focus and from
   *  visualViewport, because neither alone is reliable on iOS. */
  private keyboardVisible = false;

  private renderInner(policy?: ScrollPolicy): void {
    this.syncLevelScopedState();
    if (perf.enabled) this._renderT0 = performance.now();
    // 0.140.9: bail if the view was torn down. A debounced/deferred render
    // firing after onClose would rebuild the whole UI on detached DOM AND
    // construct a fresh ComposerAutocomplete whose document-level capture
    // keydown never gets detached (onClose already ran, nulling the old one) —
    // a permanent listener leak per occurrence. Every timer-driven render path
    // funnels through here, so one guard covers them all.
    if (!this.viewRoot?.isConnected) return;
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
    // 0.270.1: "at bottom" only means something when there was a bottom to be
    // at. A list whose content FITS satisfies the geometric test trivially
    // (scrollTop 0 + clientHeight >= scrollHeight), so leaving a 2-row focused
    // note for a 300-row parent — a preserve render, e.g. navigateTo with no
    // saved cursor for the target level — would read "was at bottom" and pin
    // the huge new list to its bottom. The user asked to go up a level, not to
    // land at the end of it. stickToListBottom still wins outright: that flag
    // is an explicit intent (composer send), not an inference.
    const prevScrollable = !!this.listEl
      && this.listEl.scrollHeight > this.listEl.clientHeight + 2;
    const prevAtBottom = !!this.listEl
      && (this.stickToListBottom
        || (prevScrollable
          && this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 2));
    // 0.216.0: reuse the composer whenever its baked-in inputs are unchanged —
    // which includes every render a SEND triggers (the file-create render, the
    // settings-broadcast render, the metadata-cache render). The focused
    // textarea is never detached, so the mobile keyboard has no reason to
    // move. Rebuild only when the signature changed (folder switch,
    // tiny/compact transition) or the persistent elements are gone.
    const composerSigNow = this.composerSig();
    const reuseComposer = !!this.composerRootEl
      && this.composerRootEl.parentElement === root
      && this.chromeEl?.parentElement === root
      && !!this.composerInputEl?.isConnected
      && this.composerSignature === composerSigNow;
    if (reuseComposer) {
      this.chromeEl!.empty();
      // The mobile nav sits AFTER the composer and carries no focus, so it is
      // cheap to rebuild; re-appending below lands it back in the right slot.
      this.mobileNavEl?.remove();
      this.mobileNavEl = null;
    } else {
      root.empty();
      this.chromeEl = root.createDiv({ cls: "stashpad-chrome" });
      this.composerRootEl = null;
      this.mobileNavEl = null;
    }
    // Everything that used to build into `root` above the composer builds into
    // this wrapper instead. display:contents makes it invisible to the root's
    // flex column, so layout (and the gap between sections) is unchanged.
    const chrome = this.chromeEl!;
    root.toggleClass("is-mobile", Platform.isMobile);
    // 0.61.1: tiny-mode shell — skip the filter bar, breadcrumb, and
    // focused-header. Render a slim strip with the folder name +
    // sticky toggle + expand button instead.
    root.toggleClass("is-tiny", this.tinyMode);
    root.toggleClass("is-compact", this.compactMode);
    // 0.267.12: how covered notes are drawn — one class on the root so the
    // choice costs a class toggle rather than per-row work.
    root.toggleClass("obscure-solid", getSettings().obscureStyle === "solid");
    // 0.63.6 perf: also toggle classes on the leaf wrapper and the
    // workspace-tabs ancestor. Earlier code used CSS `:has()` to reach
    // these elements from the view-root's class, but `:has()` triggers
    // a global style recalc on every DOM change inside the leaf —
    // which on each arrow-key cursor move (toggles is-cursor on rows)
    // re-validated every selector. Direct classes have zero recalc cost.
    const leafEl = this.containerEl.closest(".workspace-leaf");
    if (leafEl) {
      leafEl.classList.toggle("stashpad-is-tiny", this.tinyMode);
      leafEl.classList.toggle("stashpad-is-compact", this.compactMode);
    }
    const tabsEl = this.containerEl.closest(".workspace-tabs");
    if (tabsEl) {
      tabsEl.classList.toggle("stashpad-has-tiny", this.tinyMode);
    }
    if (this.tinyMode) {
      this.renderTinyHeader(chrome);
    } else {
      // 0.61.2: compact mode skips the time-filter row on DESKTOP (folder
      // switcher, tag/color/sort/view dropdowns, time-window buttons, the three
      // view-mode buttons); the breadcrumb stays there and hosts the
      // exit-compact button + the desktop actions cluster.
      // 0.121.0 (item 5): on MOBILE compact mode, do the opposite — surface the
      // bottom toolbar (it already carries the actions cluster + the
      // compact/exit toggle on mobile) and HIDE the breadcrumb, so the
      // un-compact button is reachable and compact reads as a tight list. On
      // desktop compact, behavior is unchanged (toolbar hidden, breadcrumb +
      // its exit button shown).
      const mobileCompact = this.compactMode && Platform.isMobile;
      if (!this.compactMode || Platform.isMobile) this.renderTimeFilterBar(chrome);
      if (!mobileCompact) this.renderBreadcrumb(chrome);
    }

    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    // On desktop the focused header sits above the list (pinned). On
    // mobile it's appended INTO the list as the first child so it scrolls
    // with the rows — see further down. A 1-line sticky mini preview
    // appears at the top of the list when the full header scrolls out.
    // 0.61.1: tiny mode hides the focused-header too. 0.61.2: compact
    // mode also hides it.
    // 0.258.0: the heading no longer renders into `chrome` on desktop. It is a
    // sticky ROW at the top of the list on every platform now, so that it is
    // one thing the cursor and selection can address rather than a second
    // structure living outside the list model. See renderHeadingRow.

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

    const list = chrome.createDiv({ cls: "stashpad-list" });
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

    if (reuseComposer) {
      // In-place refresh of everything the rebuild used to provide. These two
      // already exist for the mode toggles (0.142.5) and the destination chip;
      // between them they cover placeholder, split/enter buttons, helper text
      // and the destination state.
      this.refreshDestButton();
      // Draft reconciliation: when the textarea is NOT focused, adopt an
      // externally-changed draft (another window / sync via
      // onExternalSettingsChange). When it IS focused, the live value is the
      // source of truth — never stomp in-flight typing or IME composition.
      const taLive = this.composerInputEl;
      if (taLive && taLive.ownerDocument.activeElement !== taLive && taLive.value !== this.composerDraft) {
        taLive.value = this.composerDraft;
      }
    } else {
      this.renderComposer(root);
    }
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
          try { ta.setSelectionRange(c, c); } catch { /* ignore */ }
        }
      } else {
        requestAnimationFrame(() => {
          const t = this.composerInputEl;
          if (!t) return;
          t.focus({ preventScroll: true });
          if (caret != null) {
            const c = Math.min(caret, t.value.length);
            try { t.setSelectionRange(c, c); } catch { /* ignore */ }
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
          // 0.270.1: re-assert only on the steps where the geometry moved.
          // The final step releases the scroll-save guard, so the scroll
          // listener can stamp from there forward.
          this.scheduleSettleApplies(listForRestore, apply, () => { this.suppressScrollSave = false; });
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
            // 0.266.5: don't chase a target the list has no room to show.
            //
            // Measured at a phone-sized, half-height window: the composer and
            // the pinned heading can squeeze the list's clientHeight to EIGHT
            // pixels. scrollIntoView then cannot put the row anywhere that
            // satisfies `block`, so each re-assert in this chain moves the
            // scroll again and re-triggers the sticky-heading work — churn that
            // can never converge because the viewport, not the position, is the
            // problem. The same squeeze happens on a real phone whenever the
            // keyboard is up (the traces show the list at h:202).
            //
            // Below that floor the honest thing is to leave the scroll alone.
            if (listForScroll.clientHeight < MIN_SCROLLABLE_PX) return;
            this.suppressScrollSave = true;
            const row = listForScroll.querySelector(`[data-id="${targetId}"]`);
            if (row) row.scrollIntoView({ block: align, behavior: "auto" });
            Promise.resolve().then(() => { this.suppressScrollSave = false; });
          };
          // 0.270.1: re-assert only on the steps where the geometry moved —
          // an unconditional re-scroll of a settled 300-row list is the churn
          // this chain was producing. Belt-and-suspenders: hold the suppress
          // flag a touch past the last apply so tail scroll events from the
          // browser's own scroll completion don't sneak through.
          this.scheduleSettleApplies(listForScroll, apply, () => {
            window.setTimeout(() => { this.suppressScrollSave = false; }, 100);
          });
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
        if ((e).deltaY < 0) this.stickToListBottom = false;
      }, { passive: true });
      let lastTouchY = 0;
      targetList.addEventListener("touchstart", (e) => {
        lastTouchY = (e).touches[0]?.clientY ?? 0;
      }, { passive: true });
      targetList.addEventListener("touchmove", (e) => {
        const y = (e).touches[0]?.clientY ?? lastTouchY;
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

  /** 0.118.0: re-paint the folder-switcher button's icon in place (called when
   *  the per-folder icon changes in settings, so open tabs update live without
   *  a full re-render). */
  refreshFolderSwitcherIcon(): void {
    const span = this.containerEl.querySelector(".stashpad-folder-btn .stashpad-btn-icon") as HTMLElement | null;
    if (span) { span.empty(); setIcon(span, this.plugin.getFolderIcon(this.noteFolder) ?? "folder"); }
  }

  /** 0.215.0: pick a readable text color for an accent-filled control.
   *
   *  Obsidian ships BOTH `--text-on-accent` (white) and
   *  `--text-on-accent-inverted` (black) precisely because a theme's accent can
   *  be light or dark, and it does NOT pick between them for you. Using
   *  `--text-on-accent` unconditionally is fine on the default purple (3.4:1)
   *  but unreadable on a bright accent — yellow, lime, cyan — which is exactly
   *  the case this was reported for.
   *
   *  CSS can't branch on a color's luminance, so measure the accent as the
   *  browser actually resolved it and choose. Deferred a frame because the
   *  element has no computed background until it is in the document. The value
   *  written is computed, not a literal, so it doesn't trip the store lint's
   *  no-static-styles-assignment rule. */
  private applyOnAccentText(el: HTMLElement): void {
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const bg = getComputedStyle(el).backgroundColor;
      const parts = (bg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      if (parts.length < 3) return;   // unresolvable (e.g. transparent) — leave the CSS default
      const lin = parts.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      const luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      // Pick whichever of white/black actually contrasts better on this fill.
      // The crossover is where the two WCAG ratios are equal:
      //   white: 1.05 / (L + 0.05)      black: (L + 0.05) / 0.05
      //   equal when (L + 0.05)^2 = 1.05 * 0.05  ->  L = sqrt(0.0525) - 0.05
      // which is ~0.179, NOT the ~0.36 this first used. That error mattered:
      // it left the default purple accent on white text at 3.43:1 (below the
      // 4.5:1 needed for text this size) when black would have given 6.6:1.
      const CROSSOVER = Math.sqrt(0.0525) - 0.05;
      el.style.setProperty("--sp-on-accent", luminance > CROSSOVER ? "var(--text-on-accent-inverted, black)" : "var(--text-on-accent, white)");
    });
  }

  private renderTimeFilterBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "stashpad-time-filter-bar" });

    // 0.119.0 (mobile-ui-changes-2): on mobile the folder switcher + search move
    // into the composer's bottom-left nav cluster (renderComposerNavCluster), so
    // skip them here. Desktop keeps them in the toolbar as before.
    if (!Platform.isMobile) {
      // Folder switcher
      const folderBtn = bar.createEl("button", { cls: "stashpad-folder-btn" });
      const isOverride = !!this.folderOverride;
      const displayName = (this.noteFolder.split("/").pop() || this.noteFolder) || "Stashpad";
      // 0.118.0: per-folder icon (settings) on the switcher too, falling back to
      // the generic folder glyph.
      setIcon(folderBtn.createSpan({ cls: "stashpad-btn-icon" }), this.plugin.getFolderIcon(this.noteFolder) ?? "folder");
      folderBtn.createSpan({ text: displayName, cls: "stashpad-btn-text" });
      folderBtn.title = isOverride
        ? `Folder (override): ${this.noteFolder}\nClick to change or revert to default.`
        : `Folder: ${this.noteFolder}\nClick to override for this tab.`;
      if (isOverride) { folderBtn.addClass("is-override"); this.applyOnAccentText(folderBtn); }
      folderBtn.onclick = (e) => { e.preventDefault(); this.openFolderPicker(); };

      // 0.68.4: icon-only Search button between the folder switcher and
      // the tags dropdown. Mirrors the Mod+F binding for mouse users.
      const searchBtn = bar.createEl("button", { cls: "stashpad-search-btn" });
      setIconSafe(searchBtn, "search", "🔍");
      searchBtn.title = "Search notes (Mod+F)";
      searchBtn.onclick = (e) => { e.preventDefault(); this.openSearchModal(); };
    }

    if (Platform.isMobile) {
      // 0.119.1 (mobile-ui-changes-2): the actions cluster (back / forward /
      // select / ⚡) lives here at the start of the bottom toolbar, next to the
      // ⋯ filters + compact buttons (moved out of the breadcrumb).
      this.renderActionsCluster(bar);
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
    setIcon(calBtn, this.timeFilterCalendar ? "calendar" : "clock");
    calBtn.title = this.timeFilterCalendar
      ? "Calendar mode: filters use start-of-day/week/month/year. Click for rolling windows."
      : "Rolling mode: filters look back N days from now. Click for calendar boundaries.";
    if (this.timeFilterCalendar) calBtn.addClass("is-active");
    calBtn.onclick = (e) => {
      e.preventDefault();
      this.setTimeFilterCalendar(!this.timeFilterCalendar);
    };
    // 0.272.4: filter to a single DAY — notes created, linked, or due that day.
    const dayBtn = btns.createEl("button", { cls: "stashpad-time-filter-btn stashpad-day-filter-btn" });
    setIcon(dayBtn, "calendar-days");
    const activeDay = this.dateFilter !== null;
    if (activeDay) dayBtn.addClass("is-active");
    dayBtn.title = activeDay
      ? `Showing notes for ${(moment as any)(this.dateFilter).format("D MMM YYYY")} — created that day, linking to it, or due then. Click to change or clear.`
      : "Filter to one day: notes created that day, linking to it (“[[YYYY-MM-DD]]”), or with a task due then.";
    dayBtn.onclick = (e) => { e.preventDefault(); this.openDayFilterPicker(dayBtn); };
    // 0.270.2: pinned-notes-vs-filters, as a filter-bar control rather than a
    // buried setting — it is something you flip while looking at a filtered
    // list, not something you configure once. Cycles all -> time -> none.
    // Same setting as "Pinned notes vs filters" in settings; changing either
    // moves the other.
    const PIN_MODES = [
      { key: "all"  as const, icon: "pin",     cls: "is-active",
        label: "Pinned notes are never hidden by a filter.", next: "keep them through time filters only" },
      { key: "time" as const, icon: "pin",     cls: "is-active is-partial",
        label: "Pinned notes survive the time filter, but tag / colour / author filters still hide them.", next: "filter them like any other note" },
      { key: "none" as const, icon: "pin-off", cls: "",
        label: "Pinned notes are filtered like any other note.", next: "never hide them" },
    ];
    const pinIdx = Math.max(0, PIN_MODES.findIndex((m) => m.key === this.plugin.settings.pinnedFilterMode));
    const pinMode = PIN_MODES[pinIdx];
    const pinBtn = btns.createEl("button", { cls: "stashpad-time-filter-btn stashpad-pin-filter-btn" });
    setIcon(pinBtn, pinMode.icon);
    pinBtn.title = `${pinMode.label} Click to ${pinMode.next}.`;
    if (pinMode.cls) pinMode.cls.split(" ").forEach((c) => pinBtn.addClass(c));
    pinBtn.onclick = (e) => {
      e.preventDefault();
      this.plugin.settings.pinnedFilterMode = PIN_MODES[(pinIdx + 1) % PIN_MODES.length].key;
      void this.plugin.saveSettings();
      this.render();
    };

    // 0.271.0: the chip row (24h / 7d / 30d / 365d / ∞) is replaced by a free
    // "last N <unit>" expression: number input + unit select + a
    // relative/absolute toggle. The same controls are built into
    // populateTimeMenuBody so MOBILE (which hides this whole row) and the
    // desktop ⋯ overflow popover get them too.
    this.buildTimeFilterExpression(btns);

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

    // 0.116.0: width-driven cascading overflow. When the bar is too narrow
    // to show every cluster on one row, clusters fold — in priority order
    // (mode buttons → time → color → tag → sort → view → search → folder)
    // — into a single trailing ⋯ menu, instead of clipping/wrapping to a
    // second row. Desktop only; mobile already collapses into the
    // combined-filters accordion (and returned above).
    this.setupBarOverflow(bar);
  }

  /** Install the two-phase cascading-overflow controller on the header bar.
   *
   *  The bar's clusters are organized into five GROUPS, each with its own
   *  distinctive icon and a combined popover:
   *    nav (folder+search) · filter (tag+color) · arrange (sort+view) ·
   *    time · window (tiny/compact/popout)
   *
   *  Phase A — as the bar narrows, groups fold from their expanded button
   *  row into a single iconed "combined menu" button, in this order:
   *    window → time → filter → arrange → nav   (collapsePrio ascending)
   *
   *  Phase B — once every group is a compact icon and it STILL doesn't fit,
   *  the master sideways-kebab (⋯) appears at the right and "gobbles" the
   *  group buttons right-to-left (window, time, arrange, filter, nav),
   *  surfacing them as sections inside its own menu.
   *
   *  The per-cluster `populate*MenuBody` builders are reused for the group
   *  popovers AND the kebab menu via openBarOverflowMenu(member-keys).
   *  Desktop only (mobile returns before this call). 0.116.0. */
  private setupBarOverflow(bar: HTMLElement): void {
    type Group = {
      key: string; icon: string; title: string;
      memberSel: string[];   // selectors of the cluster buttons it owns
      memberKeys: string[];  // openBarOverflowMenu section keys, display order
      collapsePrio: number;  // ASC = folds to icon first (window=1 … nav=5)
      displayIdx: number;    // L→R position (nav=0 … window=4)
    };
    const GROUPS: Group[] = [
      { key: "nav",     icon: "folder-search",      title: "Folder & search", memberSel: [".stashpad-folder-btn", ".stashpad-search-btn"], memberKeys: ["folder", "search"], collapsePrio: 5, displayIdx: 0 },
      { key: "filter",  icon: "filter",             title: "Tag & color",     memberSel: [".stashpad-tag-filter-btn", ".stashpad-color-filter-btn"], memberKeys: ["tag", "color"], collapsePrio: 3, displayIdx: 1 },
      { key: "arrange", icon: "sliders-horizontal", title: "Sort & view",     memberSel: [".stashpad-sort-btn", ".stashpad-view-btn"], memberKeys: ["sort", "view"], collapsePrio: 4, displayIdx: 2 },
      { key: "time",    icon: "clock",              title: "Time",            memberSel: [".stashpad-time-filter-btns"], memberKeys: ["time"], collapsePrio: 2, displayIdx: 3 },
      { key: "window",  icon: "app-window",         title: "Window & layout", memberSel: [".stashpad-view-mode-btns"], memberKeys: ["mode"], collapsePrio: 1, displayIdx: 4 },
    ];

    bar.addClass("stashpad-overflow-managed");

    // Wrap each group's existing cluster buttons into a group container that
    // holds the expanded row + a (hidden) collapsed icon button. The wrapper
    // is inserted at the group's first member's position so display order is
    // preserved; members are then moved into the wrapper's expanded row.
    type Built = Group & { wrapper: HTMLElement; expanded: HTMLElement; iconBtn: HTMLElement };
    const built: Built[] = [];
    for (const g of [...GROUPS].sort((a, b) => a.displayIdx - b.displayIdx)) {
      const members = g.memberSel
        .map((s) => bar.querySelector(s) as HTMLElement | null)
        .filter((e): e is HTMLElement => !!e);
      if (members.length === 0) continue;
      const wrapper = createDiv({ cls: "stashpad-bar-group" });
      bar.insertBefore(wrapper, members[0]);
      const expanded = wrapper.createDiv({ cls: "stashpad-bar-group-expanded" });
      for (const m of members) expanded.appendChild(m);
      const iconBtn = wrapper.createDiv({ cls: "stashpad-bar-overflow-btn stashpad-bar-group-icon stashpad-overflow-hidden" });
      iconBtn.setAttribute("role", "button");
      iconBtn.setAttribute("tabindex", "0");
      setIcon(iconBtn.createSpan({ cls: "stashpad-bar-group-icon-glyph" }), g.icon);
      iconBtn.title = `${g.title} — combined menu`;
      const openGroup = (e: Event): void => { e.preventDefault(); this.openBarOverflowMenu(iconBtn, g.memberKeys); };
      iconBtn.onclick = openGroup;
      iconBtn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") openGroup(e); };
      built.push({ ...g, wrapper, expanded, iconBtn });
    }

    // Master kebab — rightmost, hidden until Phase B.
    const kebab = bar.createDiv({ cls: "stashpad-bar-overflow-btn stashpad-bar-kebab stashpad-overflow-hidden" });
    kebab.setAttribute("role", "button");
    kebab.setAttribute("tabindex", "0");
    setIcon(kebab.createSpan({ cls: "stashpad-bar-overflow-icon" }), "more-horizontal");
    kebab.title = "More filters / view options";

    const collapseOrder = [...built].sort((a, b) => a.collapsePrio - b.collapsePrio);
    const gobbleOrder = [...built].sort((a, b) => b.displayIdx - a.displayIdx); // RTL
    let kebabKeys: string[] = [];

    const fits = (): boolean => bar.scrollWidth <= bar.clientWidth + 1;

    const reflow = (): void => {
      if (!bar.isConnected || bar.clientWidth === 0) return;
      // Reset to fully expanded.
      for (const g of built) {
        g.wrapper.removeClass("stashpad-overflow-hidden");
        g.expanded.removeClass("stashpad-overflow-hidden");
        g.iconBtn.addClass("stashpad-overflow-hidden");
        g.iconBtn.toggleClass("is-active", g.memberKeys.some((k) => this.barUnitActive(k)));
      }
      kebab.addClass("stashpad-overflow-hidden");
      kebabKeys = [];
      if (fits()) return;

      // Phase A — fold groups into their icon buttons (window → … → nav).
      for (const g of collapseOrder) {
        if (fits()) break;
        g.expanded.addClass("stashpad-overflow-hidden");
        g.iconBtn.removeClass("stashpad-overflow-hidden");
      }
      if (fits()) return;

      // Phase B — reveal the kebab and gobble group icons RTL.
      kebab.removeClass("stashpad-overflow-hidden");
      const gobbled: Built[] = [];
      for (const g of gobbleOrder) {
        if (fits()) break;
        g.wrapper.addClass("stashpad-overflow-hidden");
        gobbled.push(g);
      }
      // Kebab menu lists gobbled groups' members in display order.
      kebabKeys = [...gobbled].sort((a, b) => a.displayIdx - b.displayIdx).flatMap((g) => g.memberKeys);
      kebab.toggleClass("is-active", kebabKeys.some((k) => this.barUnitActive(k)));
    };

    const openKebab = (e: Event): void => { e.preventDefault(); this.openBarOverflowMenu(kebab, kebabKeys); };
    kebab.onclick = openKebab;
    kebab.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") openKebab(e); };

    try { this.barOverflowRO?.disconnect(); } catch { /* ignore */ }
    const RO = (bar.ownerDocument?.defaultView ?? window).ResizeObserver;
    // Only reflow when the bar's WIDTH actually changes. Folding clusters can
    // nudge the bar's height (icon buttons vs text rows), which would re-fire
    // the observer; without this guard each fire could re-grow the row in a
    // feedback loop. Height-only changes are ignored.
    let lastW = -1;
    this.barOverflowRO = new RO((entries) => {
      const w = Math.round(entries[entries.length - 1].contentRect.width);
      if (w === lastW) return;
      lastW = w;
      reflow();
    });
    this.barOverflowRO.observe(bar);
    // Initial pass after layout settles (fonts/icons can shift widths).
    requestAnimationFrame(() => reflow());
  }

  /** Whether a foldable cluster is currently in a non-default state — used
   *  to accent the ⋯ button so a collapsed-but-active filter stays visible. */
  private barUnitActive(key: string): boolean {
    switch (key) {
      case "folder": return !!this.folderOverride;
      case "tag": return !!this.tagFilter;
      case "color": return !!this.colorFilter;
      case "time": return this.timeFilterActive();
      case "sort": return this.currentViewMode() === "nested"
        && this.sortStore.getMode(this.noteFolder, this.focusId) !== "manual";
      case "view": return this.currentViewMode() !== "nested"
        || this.currentEncryptionFilter() !== "all"
        || this.currentHideChildless() || this.currentHideCompleted()
        || this.currentAttachmentsOnly() || this.currentIncludeAttachments();
      case "mode": return this.compactMode;
      default: return false;
    }
  }

  /** Accordion popover for the clusters currently folded into ⋯. Lists
   *  them in display order, reusing the same populate* bodies as the
   *  per-cluster popovers and the mobile combined-filters menu. 0.116.0. */
  private openBarOverflowMenu(anchor: HTMLElement, collapsedKeys: string[]): void {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-mobile-filters-popover").forEach((el) => el.remove());
    const pop = doc.body.createDiv({ cls: "stashpad-mobile-filters-popover" });
    const r = anchor.getBoundingClientRect();
    const win = doc.defaultView ?? window;
    pop.setCssStyles({
      right: `${Math.max(8, win.innerWidth - r.right)}px`,
      left: "auto",
      top: `${r.bottom + 4}px`,
      maxWidth: "min(360px, calc(100vw - 16px))",
      width: "max-content",
      minWidth: "260px",
    });

    const scope = new Scope((this.app as any).scope);
    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch { /* ignore */ }
    };
    const outside = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close();
    };

    type Section = { key: string; title: string; summary: () => string; populate: (body: HTMLElement) => void };
    // Display order (left→right on the bar). Filtered to what's folded.
    const all: Section[] = [
      { key: "folder", title: "Folder", summary: () => (this.noteFolder.split("/").pop() || this.noteFolder) || "Stashpad",
        populate: (b) => this.populateFolderMenuBody(b, close) },
      { key: "search", title: "Search", summary: () => "Search notes (Mod+F)",
        populate: (b) => this.populateSearchMenuBody(b, close) },
      { key: "tag", title: "Tag filter", summary: () => this.tagFilter ? `#${this.tagFilter}` : "All tags",
        populate: (b) => this.populateTagMenuBody(b, close) },
      { key: "color", title: "Color filter",
        summary: () => this.colorFilter ? (this.plugin.getColorAlias(this.noteFolder, this.colorFilter) ?? this.colorFilter) : "All colors",
        populate: (b) => this.populateColorMenuBody(b, this.collectFolderColors(), close) },
      { key: "sort", title: "Sort",
        summary: () => this.currentViewMode() !== "nested" ? "— (Nested only)" : SORT_MODE_LABELS[this.sortStore.getMode(this.noteFolder, this.focusId)],
        populate: (b) => {
          if (this.currentViewMode() !== "nested") { b.createDiv({ cls: "stashpad-mobile-filters-note", text: "Sort applies only in Nested view." }); return; }
          this.populateSortMenuBody(b, close);
        } },
      { key: "view", title: "View", summary: () => VIEW_MODE_LABELS[this.currentViewMode()],
        populate: (b) => this.populateViewMenuBody(b, close) },
      { key: "time", title: "Time filter",
        summary: () => this.timeFilterShortLabel(),
        populate: (b) => this.populateTimeMenuBody(b, close) },
      { key: "mode", title: "View mode", summary: () => this.compactMode ? "Compact on" : "Tiny · Compact · Window",
        populate: (b) => this.populateModeMenuBody(b, close) },
    ];
    const sections = all.filter((s) => collapsedKeys.includes(s.key));

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
          e.preventDefault(); e.stopPropagation();
          expandedKey = expandedKey === sec.key ? "" : sec.key;
          renderAccordion();
        };
        if (expandedKey === sec.key) sec.populate(sectionEl.createDiv({ cls: "stashpad-mobile-filters-body" }));
      }
    };
    renderAccordion();

    scope.register([], "Escape", (ev: KeyboardEvent) => { ev.preventDefault(); close(); return false; });
    (this.app as any).keymap?.pushScope(scope);
    setTimeout(() => { doc.addEventListener("mousedown", outside, true); }, 0);
  }

  /** ⋯-menu body for the folder cluster: open the folder picker. */
  private populateFolderMenuBody(container: HTMLElement, onPicked: () => void): void {
    const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
    row.createSpan({ cls: "stashpad-sort-popover-label", text: this.folderOverride ? "Change folder (override active)…" : "Change folder for this tab…" });
    row.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onPicked(); this.openFolderPicker(); };
  }

  /** ⋯-menu body for the search cluster: open the search modal. */
  private populateSearchMenuBody(container: HTMLElement, onPicked: () => void): void {
    const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
    row.createSpan({ cls: "stashpad-sort-popover-label", text: "Search notes…" });
    row.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onPicked(); this.openSearchModal(); };
  }

  /** ⋯-menu body for the mode cluster: tiny / compact / open-in-new-window. */
  private populateModeMenuBody(container: HTMLElement, onPicked: () => void): void {
    const addRow = (label: string, run: () => void): void => {
      const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
      row.createSpan({ cls: "stashpad-sort-popover-label", text: label });
      row.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onPicked(); run(); };
    };
    addRow("Tiny mode (popout window)", () => void this.plugin.openTinyWindow());
    const cRow = container.createDiv({ cls: "stashpad-sort-popover-row" });
    if (this.compactMode) cRow.addClass("is-active");
    cRow.createSpan({ cls: "stashpad-sort-popover-label", text: this.compactMode ? "Compact mode (on)" : "Compact mode" });
    cRow.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onPicked(); this.toggleCompactMode(); };
    addRow(getSettings().popoutDuplicates ? "Duplicate to new window" : "Move to new window", () => {
      try {
        const ws = this.app.workspace as any;
        if (getSettings().popoutDuplicates) {
          const popLeaf = ws.openPopoutLeaf?.();
          if (popLeaf) void popLeaf.setViewState({ ...this.leaf.getViewState(), active: true });
          else new Notice("Stashpad: this Obsidian build doesn't expose openPopoutLeaf.");
        } else ws.moveLeafToPopout?.(this.leaf);
      } catch (err) { new Notice(`Stashpad: open-in-new-window failed (${(err as Error).message})`); }
    });
  }

  /** Toggle compact mode + persist + re-render. 0.61.2. */
  toggleCompactMode(): void {
    this.compactMode = !this.compactMode;
    this.render();
    try { (this.app.workspace as any).requestSaveLayout?.(); } catch { /* ignore */ }
  }

  /** Select-mode toggle + ⋯ actions menu. Rendered at the START of the
   *  breadcrumb row (left of Home) on every platform. */
  /** 0.218.0: rebuild JUST the mobile actions cluster, in its existing slot.
   *
   *  The select-mode toggle no longer re-renders the list, but the toolbar
   *  button still has to flip its own icon, title and is-active state. The
   *  cluster is a handful of stateless buttons holding no focus and no scroll,
   *  so rebuilding it is free and cannot disturb the list — which is the whole
   *  point of not calling render(). */
  private refreshMobileActionsCluster(): void {
    const old = this.viewRoot?.querySelector<HTMLElement>(".stashpad-mobile-actions");
    const parent = old?.parentElement;
    if (!old || !parent) return;
    const anchor = old.nextSibling;
    old.remove();
    // renderActionsCluster appends to `parent`; put the fresh node back where
    // the old one lived so button order in the toolbar is preserved.
    this.renderActionsCluster(parent);
    const fresh = parent.lastElementChild;
    if (fresh && anchor) parent.insertBefore(fresh, anchor);
  }

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

    // 0.119.6 (mobile-ui-changes-2): jump-to-level (route) sits right after the
    // forward button on mobile (the actions cluster lives in the bottom toolbar
    // there). Always shown — at Home the picker just lists Home.
    if (Platform.isMobile) {
      const routeBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
      setIconSafe(routeBtn, "route", "⋔");
      routeBtn.title = "Jump to a level in the path";
      routeBtn.onclick = (e) => { e.preventDefault(); this.openBreadcrumbLevelsModal(); };
    }

    const selectBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn" });
    const inSelect = this.mobileSelectMode;
    setIconSafe(selectBtn, inSelect ? "check-square" : "square", inSelect ? "☑" : "☐");
    selectBtn.title = inSelect
      ? `${this.selection.size} selected — tap to exit (keeps the first selection)`
      : "Enter select mode (tap notes to add)";
    if (inSelect) selectBtn.addClass("is-active");
    selectBtn.onclick = (e) => {
      e.preventDefault();
      // 0.216.3: toggling select mode is a MODE change, not navigation — the
      // list must not move. The render's anchor-based scroll restore drifts
      // here (select mode changes row chrome, so the anchor row lands at a
      // slightly different offset — measured ~-140px on the first toggle), so
      // restore the exact pixel position instead. NOTE: render() recreates
      // this.listEl, so the restore must read the FRESH element after render —
      // restoring onto the pre-render node is a silent no-op on a detached
      // element.
      this.traceScroll("select-mode");
      // 0.218.0: no render here. Entering/leaving select mode changes only
      // which rows carry .is-selected / .is-cursor and the toolbar button's own
      // icon — no rows are added, removed or reordered. repaintSelectionClasses
      // (0.73.15, already used by arrow-key nav for the same reason) toggles
      // those classes on the live rows, so the list physically cannot move and
      // no scroll restoration is needed.
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
        this.repaintSelectionClasses();
        this.refreshMobileActionsCluster();
      } else {
        const node = this.currentChildren[Math.max(0, this.cursorIdx)];
        this.mobileSelectMode = true;
        this.selection.clear();
        if (node) {
          this.selection.add(node.id);
          this.lastSelected = node.id;
          this.firstSelectedId = node.id;
        }
        this.repaintSelectionClasses();
        this.refreshMobileActionsCluster();
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

    // Paste-and-open a Stashpad deep link. Sits next to ⚡; on narrow widths it's
    // hidden by CSS (`@container`) and folds into the ⚡ actions menu instead
    // (which always carries the same "Open Stashpad link…" item).
    const openLinkBtn = actions.createEl("button", { cls: "stashpad-mobile-action-btn stashpad-open-link-btn" });
    setIconSafe(openLinkBtn, "link", "🔗");
    openLinkBtn.title = "Open a Stashpad link (paste a deep link / URL)";
    openLinkBtn.onclick = (e) => { e.preventDefault(); this.plugin.openDeepLinkModal(); };
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
    // 0.103.x: "Reload without saving" recovery action — the fix when the view
    // looks reverted to a stale state. Kept here in the top (selection-independent)
    // group so it's visible without scrolling past the selection commands.
    menu.addItem((it: any) => it.setTitle("Reload without saving").setIcon("rotate-ccw").onClick(() => this.plugin.reloadAppForUpdate()));
    menu.addItem((it: any) => it.setTitle("Open Stashpad link…").setIcon("link").onClick(() => this.plugin.openDeepLinkModal()));
    menu.addSeparator();
    // List-wide expand/collapse — operate on every note, independent of selection.
    menu.addItem((it: any) => it.setTitle("Expand all").setIcon("unfold-vertical").onClick(() => this.cmdExpandAll()));
    menu.addItem((it: any) => it.setTitle("Collapse all").setIcon("fold-vertical").onClick(() => this.cmdCollapseAll()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("list-tree").setDisabled(!hasTargets).onClick(() => this.cmdOpenInNewStashpadTab()));
    menu.addItem((it: any) => it.setTitle("Edit in Stashpad").setIcon("pencil-line").setDisabled(!hasTargets).onClick(() => void this.cmdEdit()));
    menu.addItem((it: any) => it.setTitle("Open in Obsidian editor").setIcon("pencil").setDisabled(!hasTargets).onClick(() => this.cmdOpenInEditor()));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Move…").setIcon("arrow-right-circle").setDisabled(!hasTargets).onClick(() => this.cmdMovePicker()));
    menu.addItem((it: any) => it.setTitle("Nest under… (in-list)").setIcon("indent").setDisabled(!hasTargets).onClick(() => this.cmdInListPicker()));
    menu.addItem((it: any) => it.setTitle("Outdent").setIcon("outdent").setDisabled(!hasTargets).onClick(() => void this.cmdOutdent()));
    menu.addItem((it: any) => it.setTitle("Set color…").setIcon("palette").setDisabled(!hasTargets).onClick(() => this.cmdSetColor()));
    menu.addItem((it: any) => it.setTitle("Toggle complete").setIcon("check-circle").setDisabled(!hasTargets).onClick(() => void this.cmdToggleComplete()));
    menu.addItem((it: any) => it.setTitle("Toggle task (todo)").setIcon("check-square").setDisabled(!hasTargets).onClick(() => void this.cmdToggleTask()));
    menu.addItem((it: any) => it.setTitle("Obscure / reveal (visual only)").setIcon("eye-off").setDisabled(!hasTargets).onClick(() => void this.cmdToggleObscured()));
    menu.addItem((it: any) => it.setTitle("Set due date…").setIcon("calendar-clock").setDisabled(!hasTargets).onClick(() => this.cmdSetDue()));
    menu.addItem((it: any) => it.setTitle("Assign to…").setIcon("user-plus").setDisabled(!hasTargets).onClick(() => this.cmdAssign()));
    menu.addSeparator();
    // 0.246.0: say what the command will ACTUALLY do. "Prefix timestamps when
    // copying" silently changes the output of these three, so a menu that
    // always reads "Copy" misdescribes itself whenever the setting is on.
    const tsSuffix = getSettings().prefixTimestampsOnCopy ? " with timestamps" : "";
    menu.addItem((it: any) => it.setTitle(`Copy${tsSuffix}`).setIcon("copy").setDisabled(!hasTargets).onClick(() => void this.cmdCopy()));
    menu.addItem((it: any) => it.setTitle(`Copy tree${tsSuffix}`).setIcon("copy-plus").setDisabled(!hasTargets).onClick(() => void this.cmdCopyTree()));
    // 0.214.0: plain Copy/Cut no longer build the cross-vault payload, so these
    // are the way notes travel between vaults — they need to be findable here,
    // not only in the command palette.
    menu.addItem((it: any) => it.setTitle("Copy for another vault").setIcon("copy").setDisabled(!hasTargets).onClick(() => void this.cmdCopyForOtherVault()));
    menu.addItem((it: any) => it.setTitle("Cut for another vault").setIcon("scissors").setDisabled(!hasTargets).onClick(() => void this.cmdCutForOtherVault()));
    menu.addItem((it: any) => it.setTitle("Clone (duplicate / copy)").setIcon("files").setDisabled(!hasTargets).onClick(() => void this.cmdClone()));
    // 0.155.1: Share & export ▸ — same submenu as the desktop context menu (the
    // ⚡ menu previously had no copy-link/export). Copy-link targets the primary
    // selected note; exports act on the whole selection.
    this.addShareExportSubmenu(menu, this.getActionTargets()[0] ?? null, { normalizeToNode: false });
    if (this.plugin.settings.enableSheetVersions) {
      menu.addItem((it: any) => it.setTitle("Fork as a version (draft)").setIcon("git-fork").setDisabled(!hasTargets || !exactlyOne).onClick(() => void this.cmdForkVersion()));
      menu.addItem((it: any) => it.setTitle("Mark version as final").setIcon("star").setDisabled(!hasTargets || !exactlyOne).onClick(() => void this.cmdMarkVersionFinal()));
    }
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

  /** Human label for the current tag filter (button text). */
  private tagFilterLabel(): string {
    if (this.tagFilter === TAG_FILTER_TAGGED) return "Tagged";
    if (this.tagFilter === TAG_FILTER_UNTAGGED) return "Untagged";
    if (this.tagFilter) return `#${this.formatTagLabel(this.tagFilter)}`;
    return this.collectFolderTags().length === 0 ? "No tags" : "All tags";
  }

  /** 0.104.x: the tag filter is a custom button + searchable popover
   *  (fused from the iOS/macOS Drafts design) instead of a native
   *  <select>. Clicking opens a popover with a search box (ranked, X to
   *  clear), the "Tagged"/"Untagged" special modes, and every folder tag —
   *  navigable by ↑/↓ + Enter. Tags are tallied each render so new ones
   *  appear without a refresh. */
  private renderTagFilterDropdown(bar: HTMLElement): void {
    const tags = this.collectFolderTags();
    const btn = bar.createDiv({ cls: "stashpad-tag-filter-btn" });
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    const icon = btn.createSpan({ cls: "stashpad-tag-filter-btn-icon" });
    setIconSafe(icon, "tag", "#");
    btn.createSpan({ cls: "stashpad-tag-filter-label", text: this.tagFilterLabel() });
    if (tags.length === 0 && !this.tagFilter) btn.addClass("is-disabled");
    const open = (e: Event): void => {
      e.preventDefault();
      // Allow opening with a stale filter active even if no tags remain, so
      // it's always recoverable via the "All tags" reset.
      if (tags.length === 0 && !this.tagFilter) return;
      this.openTagFilterMenu(btn);
    };
    btn.onclick = open;
    btn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") open(e); };
  }

  /** Searchable tag-filter popover anchored beneath `anchor`. Mirrors the
   *  color-filter popover's outside-click + Escape teardown. */
  private openTagFilterMenu(anchor: HTMLElement): void {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-tag-filter-popover").forEach((el) => el.remove());

    const pop = doc.body.createDiv({ cls: "stashpad-tag-filter-popover" });
    const r = anchor.getBoundingClientRect();
    pop.setCssStyles({
      left: `${Math.max(8, r.left)}px`,
      top: `${r.bottom + 4}px`,
      minWidth: `${Math.max(r.width, 200)}px`,
      maxWidth: "min(320px, calc(100vw - 16px))",
      width: "max-content",
    });

    const scope = new Scope((this.app as any).scope);
    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch { /* ignore */ }
    };
    const outside = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close();
    };

    // Search row: icon + input + (conditionally) an X-to-clear button.
    const searchRow = pop.createDiv({ cls: "stashpad-tag-filter-search" });
    const sIcon = searchRow.createSpan({ cls: "stashpad-tag-filter-search-icon" });
    setIconSafe(sIcon, "search", "⌕");
    const input = searchRow.createEl("input", { type: "text", cls: "stashpad-tag-filter-input", attr: { placeholder: "Filter tags…" } });
    const clearX = searchRow.createSpan({ cls: "stashpad-tag-filter-clear", attr: { "aria-label": "Clear" } });
    setIconSafe(clearX, "x", "×");
    clearX.setCssStyles({ display: "none" });

    const list = pop.createDiv({ cls: "stashpad-tag-filter-list" });
    const allTags = this.collectFolderTags();
    let rows: Array<{ value: string | null; el: HTMLElement }> = [];
    let highlight = 0;

    const select = (value: string | null): void => { this.setTagFilter(value); close(); };
    const setHighlight = (i: number): void => {
      if (rows.length === 0) { highlight = 0; return; }
      highlight = (i + rows.length) % rows.length;
      rows.forEach((row, k) => row.el.toggleClass("is-highlighted", k === highlight));
      rows[highlight].el.scrollIntoView({ block: "nearest" });
    };
    const addRow = (label: string, value: string | null, count: number | undefined, active: boolean): void => {
      const row = list.createDiv({ cls: "stashpad-tag-filter-row" });
      if (active) row.addClass("is-active");
      row.createSpan({ cls: "stashpad-tag-filter-row-label", text: label });
      if (typeof count === "number") row.createSpan({ cls: "stashpad-tag-filter-row-count", text: String(count) });
      const idx = rows.length;
      rows.push({ value, el: row });
      row.onmousedown = (e) => { e.preventDefault(); select(value); };
      row.onmouseenter = () => setHighlight(idx);
    };
    const renderList = (): void => {
      const q = input.value;
      clearX.setCssStyles({ display: q ? "" : "none" });
      list.empty();
      rows = [];
      const activeRaw = this.tagFilter?.toLowerCase();
      if (!q.trim()) {
        // Empty query: special modes pinned on top, then every tag.
        addRow("All tags", null, undefined, !this.tagFilter);
        addRow("Tagged", TAG_FILTER_TAGGED, undefined, this.tagFilter === TAG_FILTER_TAGGED);
        addRow("Untagged", TAG_FILTER_UNTAGGED, undefined, this.tagFilter === TAG_FILTER_UNTAGGED);
        for (const t of allTags) addRow(`#${t.label}`, t.raw, t.count, activeRaw === t.raw.toLowerCase());
      } else {
        // Typing: hide the specials so ↑/↓ jump straight to ranked tags.
        const ranked = rankTags(q, allTags);
        if (ranked.length === 0) list.createDiv({ cls: "stashpad-tag-filter-empty", text: "No matching tags" });
        else for (const t of ranked) addRow(`#${t.label}`, t.raw, t.count, activeRaw === t.raw.toLowerCase());
      }
      setHighlight(0);
    };

    clearX.onclick = () => { input.value = ""; renderList(); input.focus(); };
    input.addEventListener("input", renderList);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(highlight + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(highlight - 1); }
      else if (e.key === "Enter") { e.preventDefault(); if (rows[highlight]) select(rows[highlight].value); }
    });

    scope.register([], "Escape", (ev: KeyboardEvent) => { ev.preventDefault(); close(); return false; });
    (this.app as any).keymap?.pushScope(scope);

    renderList();
    setTimeout(() => { doc.addEventListener("mousedown", outside, true); input.focus(); }, 0);
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
      try { (this.app as any).keymap?.popScope(scope); } catch { /* ignore */ }
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
      try { (this.app as any).keymap?.popScope(scope); } catch { /* ignore */ }
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
    const timeOn = this.timeFilterActive();
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
    // 0.119.0 (mobile-ui-changes-2): the filters button now sits at the BOTTOM
    // of the screen (toolbar moved above the composer), so opening downward
    // would run off-screen. Open UPWARD when there isn't room below.
    const openUp = r.bottom + 280 > win.innerHeight;
    pop.setCssStyles({
      right: `${Math.max(8, win.innerWidth - r.right)}px`,
      left: "auto",
      ...(openUp
        ? { bottom: `${Math.max(8, win.innerHeight - r.top + 4)}px`, top: "auto" }
        : { top: `${r.bottom + 4}px`, bottom: "auto" }),
      // Wider than the per-button popovers so accordion section headers +
      // option rows have room to breathe. Capped to viewport width.
      maxWidth: "min(360px, calc(100vw - 16px))",
      maxHeight: "min(60vh, 420px)",
      overflowY: "auto",
      width: "max-content",
      minWidth: "260px",
    });

    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      try { (this.app as any).keymap?.popScope(scope); } catch { /* ignore */ }
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
        summary: () => this.timeFilterShortLabel(),
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
      try { (this.app as any).keymap?.popScope(scope); } catch { /* ignore */ }
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
    const addRow = (mode: ViewMode, desc: string, icon: string): void => {
      const row = container.createDiv({ cls: "stashpad-view-popover-row" });
      if (mode === current) row.addClass("is-active");
      const main = row.createDiv({ cls: "stashpad-view-popover-main" });
      // 0.122.7: leading icon (matches the View dropdown button's icons).
      setIcon(main.createSpan({ cls: "stashpad-view-popover-icon" }), icon);
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
    // 0.122.7: dividers between each mode for clearer separation.
    addRow("nested", "Tree of immediate children (default).", "list-tree");
    container.createDiv({ cls: "stashpad-view-popover-divider" });
    addRow("flat", "All descendants of the current focus, flat by sort.", "list");
    container.createDiv({ cls: "stashpad-view-popover-divider" });
    addRow("everything", "All descendants PLUS non-Stashpad files in the folder.", "layout-grid");

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
    const hcCheck = hcRow.createEl("input", { type: "checkbox" });
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
    const hdCheck = hdRow.createEl("input", { type: "checkbox" });
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
    const haCheck = haRow.createEl("input", { type: "checkbox" });
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
    const attCheck = attRow.createEl("input", { type: "checkbox" });
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
    const impCheck = impRow.createEl("input", { type: "checkbox" });
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
    // 0.122.7: divider above "By author" + a leading icon; dropped the
    // -toggle class so it isn't indented like the checkbox rows.
    container.createDiv({ cls: "stashpad-view-popover-divider" });
    const authRow = container.createDiv({ cls: "stashpad-view-popover-row" });
    const authMain = authRow.createDiv({ cls: "stashpad-view-popover-main" });
    setIcon(authMain.createSpan({ cls: "stashpad-view-popover-icon" }), "user");
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

  /** The "last N <unit>" expression controls: number input + unit select +
   *  relative/absolute toggle + an All-time clear. Shared by the desktop
   *  filter bar and by populateTimeMenuBody (mobile accordion + desktop ⋯
   *  popover), so there is exactly one implementation of the interaction.
   *
   *  Commits happen on `change` (blur / Enter / picker close), NOT on every
   *  keystroke: a full `render()` rebuilds the bar and would steal focus
   *  mid-typing. Local state is patched in place instead. */
  private buildTimeFilterExpression(host: HTMLElement, variant: "bar" | "popover" = "bar"): void {
    const wrap = host.createDiv({
      cls: `stashpad-time-expr ${variant === "popover" ? "stashpad-time-expr-popover" : ""}`.trim(),
    });

    const num = wrap.createEl("input", { cls: "stashpad-time-expr-num", type: "number" });
    num.min = "0";
    num.step = "1";
    num.value = String(this.timeFilterCount);
    num.title = "How many units back. 0 = all time.";
    num.setAttribute("aria-label", "Time filter amount");

    const unitSel = wrap.createEl("select", { cls: "stashpad-time-expr-unit" });
    for (const u of TIME_UNITS) {
      const o = unitSel.createEl("option", { text: u.plural });
      o.value = u.key;
      if (u.key === this.timeFilterUnit) o.selected = true;
    }
    unitSel.setAttribute("aria-label", "Time filter unit");

    const absBtn = wrap.createEl("button", {
      cls: "stashpad-time-filter-btn stashpad-time-expr-abs",
    });
    const allBtn = wrap.createEl("button", {
      cls: "stashpad-time-filter-btn stashpad-time-expr-all", text: "All",
    });
    allBtn.title = "Clear the time filter (show all notes).";

    const syncLocal = (): void => {
      const abs = this.timeFilterAnchor !== null;
      setIcon(absBtn, abs ? "anchor" : "history");
      absBtn.title = abs
        ? `Fixed since ${this.timeFilterAnchorLabel()} — the window does NOT move as time passes. Click for a sliding window.`
        : `Sliding window (${this.timeFilterLongLabel()}) — it moves with the clock. Click to freeze it at today's cutoff.`;
      absBtn.toggleClass("is-active", abs);
      absBtn.toggleClass("is-disabled", this.timeFilterCount <= 0);
      allBtn.toggleClass("is-active", this.timeFilterCount <= 0);
      num.value = String(this.timeFilterCount);
    };
    syncLocal();

    // In the popover/accordion, NEVER full-render: it would tear down the
    // popover the user is still touching. The bar variant only avoids the
    // full render while typing (focus), and re-renders on the buttons.
    const soft = variant === "popover";
    const commit = (count: number, unit: TimeUnit): void => {
      this.setTimeFilterSpec(count, unit, { rerender: false });
      syncLocal();
    };
    num.onchange = () => commit(Number(num.value), unitSel.value as TimeUnit);
    num.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); num.blur(); } };
    unitSel.onchange = () => commit(Number(num.value), unitSel.value as TimeUnit);
    absBtn.onclick = (e) => {
      e.preventDefault();
      // No cutoff exists at "all time", so there is nothing to freeze.
      if (this.timeFilterCount <= 0) { new Notice("Set a time window first."); return; }
      this.setTimeFilterAbsolute(this.timeFilterAnchor === null, { rerender: !soft });
      if (soft) syncLocal();
    };
    allBtn.onclick = (e) => {
      e.preventDefault();
      this.setTimeFilterSpec(0, this.timeFilterUnit, { rerender: !soft });
      if (soft) syncLocal();
    };
  }

  /** Render the time-filter rows into `container`. Used by the mobile
   *  accordion section (desktop renders its own button row + select
   *  fallback in renderListBar). The Calendar / Rolling toggle is
   *  surfaced as a checkbox at the top — flipping it changes the period
   *  rows' labels (Today vs 24h, etc.) on the next open. */
  private populateTimeMenuBody(container: HTMLElement, onPicked: () => void): void {
    // 0.272.4: single-day filter — reachable on mobile, where the bar (and its
    // day button) is hidden. A native date input for the OS picker.
    const dayRow = container.createDiv({ cls: "stashpad-view-popover-row" });
    dayRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Filter to one day" });
    dayRow.createDiv({ cls: "stashpad-view-popover-desc", text: "Notes created that day, linking to it, or with a task due then." });
    const dayControls = dayRow.createDiv({ cls: "stashpad-day-filter-pop-btns" });
    const dayInput = dayControls.createEl("input", { type: "date" });
    dayInput.value = (moment as any)(this.dateFilter ?? Date.now()).format("YYYY-MM-DD");
    dayInput.onchange = () => {
      const ms = (moment as any)(dayInput.value, "YYYY-MM-DD").startOf("day").valueOf();
      if (Number.isFinite(ms)) { this.dateFilter = ms; this.refreshList(); }
    };
    if (this.dateFilter !== null) {
      dayControls.createEl("button", { text: "Clear" }).onclick = () => { this.dateFilter = null; this.refreshList(); onPicked(); };
    }

    const calRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const calCheck = calRow.createEl("input", { type: "checkbox" });
    calCheck.checked = this.timeFilterCalendar;
    calRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Calendar mode" });
    calRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: "Use calendar boundaries (start of today/week/month/year). Off = rolling windows back from now.",
    });
    calRow.onclick = (e) => {
      if (e.target !== calCheck) { e.preventDefault(); calCheck.checked = !calCheck.checked; }
      this.setTimeFilterCalendar(calCheck.checked, { rerender: false });
    };

    // 0.271.0: absolute/relative toggle. MUST live here, not only on the bar —
    // mobile hides the bar's time controls entirely and reaches time filtering
    // only through this body.
    const absRow = container.createDiv({ cls: "stashpad-view-popover-row stashpad-view-popover-toggle" });
    const absCheck = absRow.createEl("input", { type: "checkbox" });
    absCheck.checked = this.timeFilterAnchor !== null;
    absRow.createDiv({ cls: "stashpad-view-popover-main" })
      .createSpan({ cls: "stashpad-view-popover-label", text: "Fixed start date" });
    absRow.createDiv({
      cls: "stashpad-view-popover-desc",
      text: this.timeFilterAnchor !== null
        ? `Frozen at ${this.timeFilterAnchorLabel()} — the window stays put as time passes.`
        : "Off = a sliding window (e.g. \"last 14 days\" always means the last 14 days). On freezes today's cutoff into a fixed date.",
    });
    absRow.onclick = (e) => {
      if (e.target !== absCheck) { e.preventDefault(); absCheck.checked = !absCheck.checked; }
      if (absCheck.checked && this.timeFilterCount <= 0) {
        absCheck.checked = false;
        new Notice("Set a time window first.");
        return;
      }
      this.setTimeFilterAbsolute(absCheck.checked, { rerender: false });
    };

    // Custom "last N <unit>" row — the numeric control. On mobile the native
    // number input opens the numeric keypad and the <select> opens the OS
    // wheel picker, so no bespoke touch widget is needed.
    container.createDiv({ cls: "stashpad-view-popover-sep" });
    container.createDiv({ cls: "stashpad-view-popover-desc", text: "Show notes from the last…" });
    const exprRow = container.createDiv({ cls: "stashpad-sort-popover-row stashpad-time-expr-row" });
    // Stop clicks inside the inputs from closing the wrapping popover.
    exprRow.onclick = (e) => { e.stopPropagation(); };
    this.buildTimeFilterExpression(exprRow, "popover");

    // Presets — the common cases stay one tap, which is what the chip row
    // was good at and what mobile most needs.
    for (const p of TIME_PRESETS) {
      const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
      const isActive = this.timeFilterCount === p.count
        && (p.count === 0 || this.timeFilterUnit === p.unit);
      if (isActive) row.addClass("is-active");
      const meta = timeUnitMeta(p.unit);
      row.createSpan({
        cls: "stashpad-sort-popover-label",
        text: p.count === 0 ? "All time" : `Last ${p.count} ${meta.plural}`,
      });
      row.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPicked();
        this.setTimeFilterSpec(p.count, p.unit);
      };
    }

    // 0.270.2: pinned-notes-vs-filters lives here too, not only as the bar
    // button — this body is shared by the mobile combined-filters accordion and
    // the desktop overflow popover, and the bar button is hidden in BOTH of
    // those cases (mobile hides the button row outright). Without this the
    // control is simply unreachable on mobile.
    container.createDiv({ cls: "stashpad-view-popover-sep" });
    const PIN_ROWS = [
      { key: "all"  as const, label: "Never hide pinned notes",
        desc: "A pinned note stays visible whatever the filters say." },
      { key: "time" as const, label: "Keep pins through time filters only",
        desc: "Pins survive the time window, but tag / colour / author filters still hide them." },
      { key: "none" as const, label: "Filter pinned notes like any note",
        desc: "Pins get no special treatment." },
    ];
    container.createDiv({ cls: "stashpad-view-popover-desc", text: "Pinned notes vs filters" });
    for (const m of PIN_ROWS) {
      const row = container.createDiv({ cls: "stashpad-sort-popover-row" });
      if (this.plugin.settings.pinnedFilterMode === m.key) row.addClass("is-active");
      row.createSpan({ cls: "stashpad-sort-popover-label", text: m.label });
      row.title = m.desc;
      row.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPicked();
        if (this.plugin.settings.pinnedFilterMode !== m.key) {
          this.plugin.settings.pinnedFilterMode = m.key;
          void this.plugin.saveSettings();
          this.refreshList();
        }
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
    addRow("Tagged", TAG_FILTER_TAGGED);
    addRow("Untagged", TAG_FILTER_UNTAGGED);
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

  /** Apply a count+unit expression. Re-freezes the absolute anchor when the
   *  filter is in ABSOLUTE mode, otherwise the number input would look inert
   *  (the frozen cutoff would ignore the new expression). */
  private setTimeFilterSpec(count: number, unit: TimeUnit, opts: { rerender?: boolean } = {}): void {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (n === this.timeFilterCount && unit === this.timeFilterUnit) return;
    this.timeFilterCount = n;
    this.timeFilterUnit = unit;
    if (n <= 0) this.timeFilterAnchor = null;
    else if (this.timeFilterAnchor !== null) this.timeFilterAnchor = this.computeRelativeCutoff();
    this.reconcileSelectionAfterFilter();
    this.persistFocus(); // queue a workspace.json save so reload restores it
    if (opts.rerender === false) this.refreshList(); else this.render();
  }

  /** Flip the calendar/rolling boundary style, re-freezing if absolute. */
  private setTimeFilterCalendar(on: boolean, opts: { rerender?: boolean } = {}): void {
    if (this.timeFilterCalendar === on) return;
    this.timeFilterCalendar = on;
    if (this.timeFilterAnchor !== null) this.timeFilterAnchor = this.computeRelativeCutoff();
    this.reconcileSelectionAfterFilter();
    this.persistFocus();
    // rerender:false keeps an open popover/accordion alive (a full render()
    // rebuilds the bar and detaches it mid-interaction).
    if (opts.rerender === false) this.refreshList(); else this.render();
  }

  /** Flip RELATIVE (sliding window) ↔ ABSOLUTE (cutoff frozen at this instant). */
  private setTimeFilterAbsolute(on: boolean, opts: { rerender?: boolean } = {}): void {
    const next = on && this.timeFilterCount > 0 ? this.computeRelativeCutoff() : null;
    if (next === this.timeFilterAnchor) return;
    this.timeFilterAnchor = next;
    this.reconcileSelectionAfterFilter();
    this.persistFocus();
    if (opts.rerender === false) this.refreshList(); else this.render();
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
    const stickyCb = stickyWrap.createEl("input", { type: "checkbox" });
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
  private tinyOpacityClose: (() => void) | null = null;
  private toggleTinyOpacityPopover(anchor: HTMLElement): void {
    if (this.tinyOpacityPopover) {
      this.tinyOpacityPopover.remove();
      this.tinyOpacityPopover = null;
      return;
    }
    const pop = document.createElement("div");
    pop.className = "stashpad-tiny-opacity-popover";
    pop.createSpan({ cls: "stashpad-tiny-opacity-label", text: "Transparency" });
    const slider = pop.createEl("input", { type: "range" });
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
      this.tinyOpacityClose = null;
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    this.tinyOpacityPopover = pop;
    // Expose close() so onClose can tear down the document listeners if the view
    // is closed while this popover is still open. 0.140.17
    this.tinyOpacityClose = close;
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
        ?? (ownerWindow)?.["@electron/remote"];
      // First try: getCurrentWindow from the owner-document's renderer
      // context. If require is sandboxed away in the popout, this is
      // null and we fall through.
      let win = remote?.getCurrentWindow?.()
        ?? (ownerWindow)?.electronWindow
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
        } catch { /* ignore */ }
        try { win.setBounds?.({ x, y, width: targetW, height: targetH }); } catch { /* ignore */ }
        try { win.setSize?.(targetW, targetH); } catch { /* ignore */ }
        win.setAlwaysOnTop?.(!!this.tinyAlwaysOnTop);
        // 0.77.0-feat: restore the saved opacity when entering tiny.
        try { win.setOpacity?.(Math.min(1, Math.max(0.3, this.tinyOpacity))); } catch { /* ignore */ }
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
    try { this.getOwnElectronWindow()?.setOpacity?.(1); } catch { /* ignore */ }
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
    } catch { /* ignore */ }
    this.render();
    // Persist state so reload doesn't snap back to tiny.
    try { await (this.app.workspace as any).requestSaveLayout?.(); } catch { /* ignore */ }
  }

  /** Enter tiny mode (called by the command or right after the popout
   *  leaf is set up). Updates state, applies window shrink, re-renders. */
  enterTinyMode(): void {
    this.tinyMode = true;
    this.applyTinyWindow();
    this.render();
    try { (this.app.workspace as any).requestSaveLayout?.(); } catch { /* ignore */ }
  }

  private renderBreadcrumb(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "stashpad-breadcrumb" });
    // Action cluster (select-mode toggle + ⋯ menu) sits at the START of
    // the breadcrumb row, before Home — easier to reach on mobile and
    // gives the time-filter row more horizontal real estate.
    // 0.117.0: the "jump to level" button now lives inside the actions
    // cluster (rendered above), grouped with back/forward/select/⚡.
    // 0.119.1 (mobile-ui-changes-2): on mobile the actions cluster
    // (back/forward/select/⚡) moves into the bottom toolbar (time-filter-bar),
    // next to the ⋯ filters + compact buttons; the breadcrumb keeps just the trail.
    if (!Platform.isMobile) this.renderActionsCluster(bar);
    const homeBtn = bar.createSpan({ cls: "stashpad-crumb stashpad-crumb-home" });
    if (Platform.isMobile) {
      // Mobile: render as a house icon to save horizontal space.
      setIcon(homeBtn, "home");
      homeBtn.title = "Home";
    } else {
      homeBtn.setText("Home");
    }
    homeBtn.onclick = (e) => this.crumbActivate(e, ROOT_ID);
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

    type Crumb = { id: StashpadId; label: string; isEllipsis?: boolean };
    const path = this.tree.pathTo(this.focusId);
    // Warm body text for any crumb not cached yet so titleForNode shows the
    // note's first line, not its filename slug (repaints once when ready).
    this.warmCrumbTitles(path);
    const crumbs: Crumb[] = path.map((n) => {
      const raw = this.titleForNode(n);
      const label = raw.length > PER_CRUMB_MAX ? raw.slice(0, PER_CRUMB_MAX - 1) + "…" : raw;
      return { id: n.id, label };
    });

    // No total-path character budget (removed 0.148.2): the row is full-width,
    // so let every crumb render and let CSS overflow handle the rare over-long
    // path. Only the per-crumb cap above remains, to stop a single giant title
    // dominating.

    // 0.117.0: on mobile the row already has a flex `gap` between items, so
    // the spaces around the slash double the spacing and look wasteful at
    // very small widths. Use a bare "/" there and let the gap do the work;
    // desktop keeps " / " (it has no inter-item gap).
    const sepText = Platform.isMobile ? "/" : " / ";
    for (const c of crumbs) {
      bar.createSpan({ cls: "stashpad-crumb-sep", text: sepText });
      if (c.isEllipsis) {
        bar.createSpan({ cls: "stashpad-crumb stashpad-crumb-ellipsis", text: c.label }).title =
          path.map((n) => this.titleForNode(n)).join(" / ");
      } else {
        const id = c.id;
        const el = bar.createSpan({ cls: "stashpad-crumb", text: c.label });
        el.title = c.label;
        el.onclick = (e) => this.crumbActivate(e, id);
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
    // 0.117.0: "jump to level" button pinned at the END of the breadcrumb row
    // (by the crumbs, not the nav cluster). CSS absolutely-positions it at the
    // right edge with reserved padding, so it stays visible even when the
    // inline crumbs clip — which is exactly when it's needed.
    // 0.119.0 (mobile-ui-changes-2): on mobile it moves into the composer's
    // bottom-left nav cluster instead.
    if (!Platform.isMobile) this.renderBreadcrumbLevelsButton(bar);
  }

  /** 0.117.0: the breadcrumb "all levels" button. Pinned at the right end of
   *  the row (CSS), so it never clips, and opens BreadcrumbLevelsModal listing
   *  every level full-width + clickable — the escape hatch when the inline
   *  crumbs are squished. */
  private renderBreadcrumbLevelsButton(parent: HTMLElement): void {
    // Same button shape as the other actions-cluster controls (back /
    // forward / select / ⚡) so it reads as one group.
    const btn = parent.createEl("button", { cls: "stashpad-mobile-action-btn stashpad-crumb-levels-btn" });
    setIconSafe(btn, "route", "⋔");
    btn.title = "Show all levels — jump to any level in the path";
    btn.onclick = (e) => { e.preventDefault(); this.openBreadcrumbLevelsModal(); };
  }

  /** Build the level list (Home + full path, untruncated) and open the
   *  picker modal. Clicking a level navigates there. 0.117.0. */
  private openBreadcrumbLevelsModal(): void {
    const path = this.tree.pathTo(this.focusId);
    const levels: BreadcrumbLevel[] = [
      { id: ROOT_ID, label: "Home", level: 0, isCurrent: this.focusId === ROOT_ID, isHome: true },
    ];
    path.forEach((n, i) => {
      levels.push({
        id: n.id,
        label: this.titleForNode(n),
        level: i + 1,
        isCurrent: n.id === this.focusId,
      });
    });
    new BreadcrumbLevelsModal(this.app, levels, (id) => this.navigateTo(id as StashpadId), {
      // Same context menu as the inline crumbs (navigate / open in new
      // Stashpad tab / open in editor), via right-click + long-press. The
      // `close` lets a chosen action dismiss the modal.
      onContext: (id, evt, anchorEl, close) => this.openCrumbMenu(evt, id as StashpadId, anchorEl, close),
      attachLongPress: (el, cb) => this.attachLongPress(el, cb),
    }).open();
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
   *  open the underlying note in a regular Obsidian markdown tab.
   *  `anchorEl` (optional) overrides the long-press anchor — used by the
   *  levels modal, which passes the row element. `onAction` (optional) runs
   *  before each item's action — the levels modal passes its `close` so the
   *  modal dismisses when the user picks something. 0.117.0. */
  private openCrumbMenu(
    evt: MouseEvent | null,
    id: StashpadId,
    anchorEl?: HTMLElement,
    onAction?: () => void,
  ): void {
    const node = this.tree.get(id);
    if (!node) return;
    const menu = new Menu();
    // "Open in new tab" listed first (user preference, 2026-07-14).
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("list-tree").onClick(() => { onAction?.(); this.cmdOpenInNewStashpadTab(node); }));
    menu.addItem((it: any) => it.setTitle("Navigate here").setIcon("arrow-right-circle").onClick(() => { onAction?.(); this.navigateTo(id); }));
    if (node.file) {
      menu.addItem((it: any) => it.setTitle("Edit in Stashpad").setIcon("pencil-line").onClick(() => { onAction?.(); void this.cmdEdit(node); }));
      menu.addItem((it: any) => it.setTitle("Open in Obsidian editor (new tab)").setIcon("pencil").onClick(() => { onAction?.(); this.cmdOpenInEditor(node); }));
    }
    if (evt && (evt.clientX > 0 || evt.clientY > 0)) {
      menu.showAtMouseEvent(evt);
    } else {
      // Long-press path: anchor below the provided element (or the event
      // target, for the breadcrumb's own long-press).
      const el = anchorEl ?? (evt?.target as HTMLElement | null) ?? null;
      const r = el?.getBoundingClientRect();
      menu.showAtPosition({ x: r?.left ?? 8, y: (r?.bottom ?? 60) + 4 });
    }
  }

  /** Sticky 1-line preview for the focused header (mobile only). Renders
   *  at the top of the list and is hidden until the full
   *  `.stashpad-focused` row scrolls out of view (toggled by
   *  installHeadingStuckObserver). */
  /** 0.258.0: drives `is-stuck` on the pinned heading row.
   *
   *  A sticky element can't report its own stuck-ness, so a 1px sentinel
   *  (pulled back out of layout with a negative margin) is rendered
   *  immediately ABOVE it: while the sentinel is visible
   *  the heading is sitting in normal flow; once the sentinel scrolls out, the
   *  heading is pinned and compacts so a long note doesn't eat the list.
   *
   *  Replaces the old mini-preview observer — the mini existed only to fake
   *  stickiness for a header that lived outside the list, and `position:
   *  sticky` on a real row does that natively. */
  private installHeadingStuckObserver(list: HTMLElement): void {
    if (this.headingStuckCleanup) { this.headingStuckCleanup(); this.headingStuckCleanup = null; }
    const apply = (): void => {
      // Re-query each time: render() rebuilds the row, and a handler holding a
      // stale element would toggle a class on a detached node — which is
      // exactly how the IntersectionObserver version failed silently.
      const heading = list.querySelector(".stashpad-focused.is-heading-row");
      if (!heading) return;
      const stuck = heading.hasClass("is-stuck");

      // 0.266.3: hysteresis, because `is-stuck` CHANGES THE HEIGHT it is
      // measured from.
      //
      // Sticking collapses the heading to one line, which shortens the content.
      // On a short note that removes the overflow entirely, so the browser
      // clamps scrollTop to 0 — which reads as "not stuck", so the heading
      // expands, which restores the overflow, which allows the scroll again.
      // That is a self-sustaining oscillation: measured on the phone as
      // scrollHeight flipping 625 ↔ 394 indefinitely, and felt as the heading
      // flickering and swallowing taps meant for the row below it.
      //
      // Two guards break the loop. Once stuck, only a decisive scroll back to
      // the very top releases it, so the 0-or-2px region can't flip state on
      // its own; and a list that cannot scroll WHILE COLLAPSED never unsticks
      // on that basis, since expanding is precisely what would make it
      // scrollable again.
      // The two thresholds ARE the whole fix. Sticking needs a decisive scroll;
      // releasing needs a return to the very top. Nothing in between moves it,
      // so the collapse shortening the content — which clamps scrollTop to 0 —
      // releases once and then cannot re-stick, because 0 is not past the
      // sticking threshold.
      //
      // 0.266.7: an earlier third guard here ALSO refused to release whenever
      // the collapsed list wasn't scrollable. That was aimed at the same
      // oscillation the hysteresis already handles, and it broke the ordinary
      // case: a note short enough that collapsing removes the overflow stayed
      // stuck at the top of the list forever, so the heading never expanded and
      // its Show-more toggle stayed hidden. Modelled both rules against the
      // height feedback — hysteresis alone gives zero flips in the oscillation
      // case AND releases correctly at the top, so the guard bought nothing.
      if (!stuck) {
        if (list.scrollTop > STICK_ON_PX) heading.addClass("is-stuck");
        return;
      }
      if (list.scrollTop > STICK_OFF_PX) return;
      // 0.271.1: do NOT unstick while the list is auto-pinning to the bottom.
      //
      // The hysteresis above assumes scrollTop only moves when the USER scrolls.
      // That holds until a note is added: scrollListToBottom sets
      // stickToListBottom, and the listResizeObserver then FORCES scrollTop to
      // scrollHeight on every height change — turning a height change back into
      // a scroll change, the one thing the hysteresis relies on not happening.
      //
      // With a long focused header the loop is: pinned to bottom → scrollTop
      // past STICK_ON → stick → collapse to one line → content now fits → list
      // non-scrollable → scrollTop clamps to 0 → (here) unstick → expand →
      // overflow returns → re-pin to bottom → stick → … forever. Reported on a
      // phone as the header rubber-banding the instant a note was added while
      // two long notes filled the viewport.
      //
      // 0.266.7 removed an earlier "don't unstick while non-scrollable" guard as
      // redundant with the hysteresis — correct for USER scrolling, which is the
      // only case where the guard fired then. Scoping it to stickToListBottom
      // restores the loop protection for the auto-pin case WITHOUT the
      // regression 0.266.7 fixed (a short note staying stuck forever): once the
      // user touches the list, stickToListBottom clears and normal hysteresis
      // resumes, so the ordinary case is untouched. While pinned the header is
      // scrolled out of view at the top anyway, so staying stuck is invisible.
      if (this.stickToListBottom) return;
      heading.removeClass("is-stuck");
    };
    list.addEventListener("scroll", apply, { passive: true });
    this.headingStuckCleanup = () => list.removeEventListener("scroll", apply);
    apply();
  }

  /** Focused-header layout mirrors a list row: [meta | body | actions].
   *  - meta: timestamp + a grip-width spacer (no actual grip — drag
   *    isn't meaningful here).
   *  - body: the focused note's rendered body.
   *  - actions: edit pencil + duplicate-tab button. The Show More
   *    toggle (when content overflows) inserts before the pencil. */
  private renderFocusedHeader(parent: HTMLElement, node: TreeNode, opts: { asRow?: boolean } = {}): void {
    if (!node.file) return;
    const file = node.file;
    const wrap = parent.createDiv({ cls: "stashpad-focused" });
    // 0.122.2 (#9): the focused-note header gets the same right-click menu as a
    // list row (it IS a note — Copy/Cut/Move/Task/Delete all apply to it).
    // 0.266.3: right-click / long-press PUTS THE CURSOR ON THE HEADING before
    // the menu opens.
    //
    // openNoteMenu's own `focusClicked` normalises the SELECTION, which is
    // enough for the items that call it — but a command reached through "More
    // commands…" resolves its own targets via getActionTargets(), and that
    // falls back to the cursor row. On the heading the cursor was still down in
    // the list, so "Add link previews" reported nothing selected (or, worse,
    // silently acted on a child — the 0.257.0 Move bug through a second door).
    //
    // A right-click is an unambiguous "I mean THIS one", so it should focus the
    // heading the way a left-click already does. Clearing a selection that
    // doesn't contain the heading matches what focusClicked would do a moment
    // later anyway, so this changes nothing for the items that normalise and
    // fixes the ones that can't.
    wrap.oncontextmenu = (evt) => {
      evt.preventDefault();
      if (opts.asRow) {
        if (!this.selection.has(node.id)) { this.selection.clear(); this.lastSelected = null; }
        this.cursorOnHeading = true;
        this.selectHeadingCursor();
      }
      this.openNoteMenu(evt, node);
    };
    // 0.258.0: as a row, it carries the same cursor/selected state classes the
    // note rows use, so one stylesheet drives both and the cursor is visible
    // wherever it sits. `is-heading-row` is what pins it (sticky, top: 0).
    // 0.267.0: the focused header obscures too.
    //
    // is-obscured was only ever applied to list ROWS. With per-note obscuring
    // that was a small gap — you had deliberately drilled into the note. With a
    // global or per-folder default it is a hole: the pinned heading is the
    // largest text on screen, and leaving it readable while everything under it
    // blurs defeats the entire point of the switch.
    if (this.isObscured(node) && !this.isFullyRevealed(node.id)) {
      wrap.addClass("is-obscured");
      if (this.revealedObscured.has(node.id)) wrap.addClass("is-text-revealed");
      // Same contract as a row: a tap reveals and does nothing else, so you can
      // look without also acting — now in two steps (text, then media).
      wrap.addEventListener("click", (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest("button, a, input, .stashpad-note-check")) return;
        if (this.isFullyRevealed(node.id)) return;
        e.preventDefault();
        e.stopPropagation();
        this.advanceObscureReveal(node, wrap);
      }, true);
    }
    if (opts.asRow) {
      wrap.addClass("is-heading-row");
      if (this.cursorOnHeading) wrap.addClass("is-cursor");
      if (this.selection.has(node.id)) wrap.addClass("is-selected");
      wrap.dataset.headingId = node.id;
      // Click puts the cursor here — the same contract a note row has, which is
      // what "selectable" means for the rest of the command surface.
      wrap.addEventListener("click", (e) => {
        const el = e.target as HTMLElement | null;
        // Don't hijack clicks on the header's own controls (pencil, kebab,
        // task checkbox) or on rendered links inside the body.
        if (el?.closest("button, a, input, .stashpad-note-check")) return;
        this.cursorOnHeading = true;
        this.selectHeadingCursor();
      });
    }

    // meta column: timestamp + a transparent grip-shaped spacer so the
    // body's left edge column-aligns with each list row's body.
    const meta = wrap.createDiv({ cls: "stashpad-focused-meta" });
    const metaTop = meta.createDiv({ cls: "stashpad-focused-meta-top" });
    // 0.267.2: the drilled-in note needs the control too — otherwise the one
    // note you are actually looking at is the only one without it.
    if (this.isObscured(node)) this.addObscureBadge(metaTop, node);
    metaTop.createSpan({ cls: "stashpad-focused-time stashpad-note-time", text: this.formatTime(node.created) });
    metaTop.createDiv({ cls: "stashpad-focused-grip-spacer" });
    // 0.201.4: when the FOCUSED note is a task, show its completion checkbox in
    // the header too — the drilled-in parent's task state was invisible (and
    // untoggleable) unless you climbed back out to its list row.
    if (this.isTask(node)) this.addTaskCheckbox(metaTop, node);

    // 0.266.6: the pinned heading's collapsed state shows a PLAIN one-line
    // preview rather than a clamped copy of the rendered body.
    //
    // Compactness is the point: no markdown, no images, no callout chrome, and
    // an explicit "…" when further lines exist. Swapping the two is a CSS class
    // rather than a re-render, so scrolling never triggers layout work.
    //
    // NOT because the old clamp was broken. The suspicion was that
    // `-webkit-line-clamp` cannot shrink a body opening with a block element (a
    // link-preview callout), which would have explained a heading that stopped
    // collapsing on scroll. Measured, and it is false: the old rule forced the
    // children to `display: inline`, and the same callout body clamped to 20px.
    // So that bug has some other cause — most likely the sticky oscillation
    // fixed in 0.266.3 — and this change should not be credited with it.
    if (opts.asRow) {
      const stuck = wrap.createDiv({ cls: "stashpad-heading-stuck-line" });
      stuck.textContent = this.stuckPreviewText(node);
    }
    const body = wrap.createDiv({ cls: "stashpad-focused-body" });
    // Markdown rendered inside the focused header includes #tags and
    // [[wikilinks]] — without explicit click delegation those elements
    // don't fire navigation (only the row-click handler on list rows
    // does). Wire the same tag/link handling here so the focused
    // header behaves consistently with rows.
    body.addEventListener("click", (e) => this.handleRenderedClick(e, node));

    // actions column. On DESKTOP: edit pencil + duplicate-tab button (same
    // shape as a list row's actions so the icons line up). On MOBILE (0.123.0):
    // ONE button that opens the context menu — exactly like a list row's
    // mobile action — replacing the cramped edit + open-in-new-tab pair. The
    // menu already carries Focus / Open in editor / Copy / everything.
    const actions = wrap.createDiv({ cls: "stashpad-focused-actions" });
    let toggleAnchor: HTMLElement;
    if (Platform.isMobile) {
      const moreBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-note-more stashpad-focused-more" });
      // 0.163.1: vertical kebab (⋮) matching the list rows. Use `ellipsis-vertical`,
      // NOT `more-vertical` — Obsidian's app.css rotates `.lucide-more-vertical` 90°
      // on iOS/macOS (to the platform's horizontal-dots convention), so `more-vertical`
      // actually renders as a HORIZONTAL meatball there. `ellipsis-vertical` isn't
      // rotated, so it stays a true vertical kebab like the note rows use.
      setIcon(moreBtn, "ellipsis-vertical");
      moreBtn.title = "Actions";
      moreBtn.onclick = (e) => { e.stopPropagation(); this.openNoteMenu(e, node); };
      toggleAnchor = moreBtn;
      this.maybeAddQuickButton(actions, node, moreBtn);
    } else {
      const pencil = actions.createEl("button", { cls: "stashpad-pencil stashpad-focused-pencil" });
      setIcon(pencil, "pencil");
      // 0.187.0: the pencil now opens Stashpad's own editor (the default edit
      // action), not a full Obsidian tab. The Obsidian editor stays available via
      // the right-click menu ("Open in Obsidian editor") and Mod+Shift+E.
      pencil.title = "Edit in Stashpad";
      pencil.onclick = () => void this.cmdEdit(node);

      const dupBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-focused-dup" });
      // "copy" — the lucide icon is two overlapping document shapes,
      // which reads as "duplicate" / "clone the tab" at a glance.
      setIcon(dupBtn, "copy");
      dupBtn.title = "Open this Stashpad in a new tab (clone)";
      dupBtn.onclick = () => this.cmdOpenInNewStashpadTab(node);
      toggleAnchor = pencil;
    }

    this.renderNoteBody(body, node, {
      // 0.170.6: clamp on desktop too (was mobile-only), so the focused header
      // gets the same Show more / Show less toggle as list rows when the note
      // overflows — respecting the user's expand-bodies-by-default setting.
      // Previously the desktop focused header rendered un-clamped with no
      // toggle at all, so a long focused note had no collapse affordance.
      clamp: true,
      // The focused header is a single, always-visible element (and on desktop
      // lives outside the list's lazy-render observer), so render its body now
      // rather than deferring — otherwise a cold (uncached) note stays on the
      // title placeholder instead of showing its body.
      immediate: true,
      // Toggle slots into the actions cluster, BEFORE the first button — so
      // the order reads [More] [⋯] on mobile / [More] [Edit] [Duplicate] on desktop.
      toggleHost: actions,
      toggleAnchor,
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
      seg.onclick = (e) => { e.stopPropagation(); this.crumbActivate(e, a.id); };
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
  /** 0.246.0: titleList for the COPY toasts, mirroring the clipboard content.
   *
   *  The plain titleList shows bare titles, so with "prefix timestamps when
   *  copying" on, the toast previewed something different from what was
   *  actually copied. A preview that does not match the clipboard is worse
   *  than no preview — it is a quiet lie about what you now have. */
  titleListForCopy(nodes: TreeNode[], max = 3): string {
    if (!getSettings().prefixTimestampsOnCopy) return this.titleList(nodes, max);
    const titles = nodes.map((n) => {
      const t = this.titleForNode(n).trim() || "(untitled)";
      return `"${this.formatTimeInline(n.created)} ${t}"`;
    });
    if (titles.length <= max) return titles.join(", ");
    return `${titles.slice(0, max).join(", ")}, +${titles.length - max} more`;
  }

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
  /** One plain line for the collapsed pinned heading.
   *
   *  titleForNode already resolves "the note's first heading, else its first
   *  body line" and strips inline markdown, which is exactly the line to show —
   *  so this only adds the "there is more below" marker. CSS handles the other
   *  ellipsis, the one for a single line too long to fit; this one means
   *  "further lines exist", which no amount of overflow styling can convey. */
  private stuckPreviewText(node: TreeNode, knownText?: string): string {
    const title = this.titleForNode(node).trim();
    if (!node.file) return title;
    const body = knownText ?? this.plugin.renderCacheStore.get(node.file.path)?.text ?? "";
    const lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length > 1 ? `${title} …` : title;
  }

  /** Refresh the collapsed heading's preview once the body text is actually
   *  known. At heading-render time the render cache is often cold — measured on
   *  a fresh drill-in — so titleForNode falls back to the FILENAME SLUG and the
   *  collapsed heading would show "child a" for a note whose first line reads
   *  "Parent heading line one." */
  private refreshStuckPreview(container: HTMLElement, node: TreeNode, text: string): void {
    const row = container.closest(".stashpad-focused.is-heading-row");
    const line = row?.querySelector(".stashpad-heading-stuck-line");
    if (line) line.textContent = this.stuckPreviewText(node, text);
  }

  titleForNode(node: TreeNode): string {
    if (!node.file) return "Untitled";
    const cache = this.app.metadataCache.getFileCache(node.file);
    const firstHeading = cache?.headings?.[0]?.heading;
    // 0.208.4: titles are raw Markdown (a heading or the first body line), and
    // every consumer is plain text — breadcrumb, focused header, tooltips, tab
    // title — so the syntax characters showed through verbatim
    // ("**Atomic Habits**"). Strip at this single choke point rather than at each
    // call site; the tooltip/tab-title consumers can't render HTML anyway.
    if (firstHeading) return stripInlineMarkdown(firstHeading);
    // Prefer the note's first body line (what the row / focused header shows)
    // over the filename: a filename can be a short slug that doesn't match its
    // content (e.g. `grand.md` whose body is "Grandchild under child A of
    // Alpha."). The persisted render cache holds body text synchronously once a
    // note has been shown; `warmCrumbTitles` (called from renderBreadcrumb) warms
    // any crumb not cached yet. Falls back to the filename slug on a miss.
    const bodyText = this.plugin.renderCacheStore.get(node.file.path)?.text;
    const firstLine = bodyText?.slice(0, 200).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    // Strip AFTER picking the line: a line that is only syntax (e.g. "**") would
    // otherwise strip to empty and silently win over the filename fallback.
    if (firstLine) return stripInlineMarkdown(firstLine) || node.file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ") || "Untitled";
    return node.file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ") || "Untitled";
  }

  /** Warm the render cache for breadcrumb nodes that have no heading and no
   *  cached body yet (e.g. a deep-link jump straight to a note, before its
   *  ancestors were ever shown), so titleForNode can use their body's first line
   *  instead of the filename. Async + fire-once re-render; guarded against loops
   *  by only re-rendering when something was actually warmed. */
  private warmCrumbTitles(nodes: TreeNode[]): void {
    const cold = nodes.filter((n) => {
      if (!n.file) return false;
      // 0.266.9: warm each crumb AT MOST ONCE per view.
      //
      // This runs from renderBreadcrumb, i.e. on every render, and it ends by
      // calling debouncedRender — so it is a render scheduling another render.
      // That is safe only while "is it cold?" reliably flips to false after a
      // warm. If anything keeps an entry cold — an eviction, a store that never
      // took the write, a path that doesn't round-trip — the answer never
      // changes and the two feed each other forever at the debounce interval.
      //
      // A phone trace showed exactly that: renders every ~83ms (the 80ms
      // debounce plus work) with identical geometry, indefinitely, while
      // focused deep enough to have crumbs. Rather than trust the cache to
      // settle, remember what has been warmed here; then a second warm is
      // impossible by construction and the loop cannot form regardless of cause.
      if (this.warmedCrumbs.has(n.file.path)) return false;
      if (this.app.metadataCache.getFileCache(n.file)?.headings?.[0]?.heading) return false;
      // Cold = no cache ENTRY at all. A cached-but-empty body (text === "")
      // legitimately falls back to the filename, so don't re-warm it every paint.
      return !this.plugin.renderCacheStore.get(n.file.path);
    });
    if (!cold.length) return;
    for (const n of cold) if (n.file) this.warmedCrumbs.add(n.file.path);
    void Promise.all(cold.map((n) => this.bodyRenderer.getOrComputeRender(n.file!).catch(() => null)))
      .then((results) => {
        // Only repaint if at least one warm produced usable text (avoids a
        // render loop when a node genuinely has an empty body).
        if (results.some((r) => r && r.text && r.text.trim())) this.debouncedRender();
      });
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
    if (isCursor && this.cursorHasMoved && this.plugin.settings.autoExpandCursorRow && !this.cursorExpandOverride.has(node.id)) row.addClass("is-cursor-expanded");
    if (isPickTarget) row.addClass("is-pick-target");
    if (this.isCompleted(node)) row.addClass("is-completed");
    // 0.237.0: visual obscuring. The body is rendered normally and blurred by
    // CSS — the text is still in the DOM, which is exactly why this is
    // presented as hiding from a passer-by and never as encryption.
    if (this.isObscured(node) && !this.isFullyRevealed(node.id)) {
      row.addClass("is-obscured");
      if (this.revealedObscured.has(node.id)) row.addClass("is-text-revealed");
    }
    // 0.197.0: a repeating occurrence that ran out its interval unfinished is marked
    // completed so it leaves the active list — but it was MISSED, not done. Without
    // this it would be indistinguishable from work you actually finished.
    if (this.isMissed(node)) {
      row.addClass("is-missed");
      row.title = "Missed — this repeat ran past its interval without being completed.";
    }
    if (this.isListPinned(node.id)) row.addClass("is-list-pinned");
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
      // Mobile: if this double-tap began during the keyboard-dismiss reflow,
      // open the note that was under the finger when it STARTED (recorded on
      // the first, dismissing tap) — not the row that slid under the reflowed
      // second tap. One fluid double-tap on the note above the composer.
      const absorbed = this.shouldAbsorbDismissTap();
      if (absorbed && this.aimedTapTargetId && Date.now() - this.aimedTapAt <= StashpadView.AIMED_TAP_WINDOW_MS) {
        const aimed = this.aimedTapTargetId;
        this.aimedTapTargetId = null;
        this.traceTap("dblclick", e, idx, false);
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        this.navigateTo(aimed);
        return;
      }
      this.traceTap("dblclick", e, idx, absorbed);
      if (absorbed) { e.preventDefault(); return; }
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
    // 0.223.0: on mobile the checkbox goes in the TOP meta row, ahead of the
    // timestamp. It used to live in meta-bottom (0.87.1), which was fine while
    // meta-bottom sat in the left-hand meta column — but the 0.120.0 3-section
    // mobile row moved meta-bottom into the full-width `foot` area UNDER the
    // body, so the checkbox for a one-line task ended up far below its own
    // text. Nothing about the render/scroll work touched this; the trial layout
    // relocated it. Top-left is where a checklist checkbox belongs.
    const mobileTask = (this.isTask(node) || this.compactMode) && Platform.isMobile;
    if (mobileTask) this.addTaskCheckbox(metaTop, node);
    // 0.267.2: the "hidden" marker is a BUTTON, not decoration.
    //
    // It used to be a CSS ::after on this row, which cannot be tapped — so the
    // only per-note control was a right-click menu, and on a phone that is a
    // long-press away from something you can already see. The badge is exactly
    // where the eye lands when a note is blurred, so it should be the control.
    //
    // Shown whenever the note is obscured, INCLUDING while revealed, so the way
    // back is always visible — a revealed note that offered no way to re-hide
    // was the original complaint.
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
    // 0.267.6: the hide/reveal chip sits AFTER the timestamp and the grip, so
    // the meta column keeps reading time-first and the chip does not displace
    // the two things whose position people navigate by.
    if (this.isObscured(node)) this.addObscureBadge(metaTop, node);
    // 0.87.1: the children-count arrow + (on mobile) the task checkbox share one
    // horizontal line below the timestamp — the mobile checkbox sits just to the
    // LEFT of the arrow (see the desktop addTaskCheckbox call above).
    const isPinnedRow = this.isListPinned(node.id);
    if (childCount > 0 || isPinnedRow) {
      const metaBottom = meta.createDiv({ cls: "stashpad-note-meta-bottom" });
      // 0.106.x: list-pin indicator — a lucide pin icon under the timestamp,
      // placed before the children-count arrow.
      if (isPinnedRow) {
        const edge = this.listPinEdge(node.id) ?? "top";
        const pin = metaBottom.createSpan({ cls: "stashpad-note-listpin" });
        pin.addClass(edge === "bottom" ? "is-pinned-bottom" : "is-pinned-top");
        setIcon(pin, "pin");
        pin.setAttr("aria-label", `Pinned to ${edge} of list`);
      }
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
      this.maybeAddQuickButton(actions, node);
      const moreBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-note-more" });
      setIcon(moreBtn, "ellipsis-vertical");
      moreBtn.title = "Actions";
      moreBtn.onclick = (e) => { e.stopPropagation(); this.openNoteMenu(e, node); };
      toggleAnchor = moreBtn;
    } else {
      const pencil = actions.createEl("button", { cls: "stashpad-pencil" });
      setIcon(pencil, "pencil");
      // 0.187.0: pencil opens Stashpad's own editor (default edit action).
      pencil.title = "Edit in Stashpad";
      pencil.onclick = (e) => { e.stopPropagation(); void this.cmdEdit(node); };
      const enterBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-enter-btn" });
      setIcon(enterBtn, "arrow-right");
      enterBtn.title = "Open in Stashpad view";
      enterBtn.onclick = (e) => { e.stopPropagation(); this.navigateTo(node.id); };
      // "More actions" button — opens the same context menu as right-click
      // (Copy Stashpad link, Delete, Split, Move, …). One menu button keeps the
      // row uncluttered as the action set grows, instead of a button per action.
      this.maybeAddQuickButton(actions, node);
      const moreBtn = actions.createEl("button", { cls: "stashpad-pencil stashpad-note-more" });
      setIcon(moreBtn, "ellipsis-vertical");
      moreBtn.title = "More actions";
      moreBtn.onclick = (e) => { e.stopPropagation(); this.openNoteMenu(e, node); };
      toggleAnchor = pencil;
    }

    // Now the actions cluster exists, render the body and route the
    // Show More toggle into that cluster (anchored before the first button).
    this.renderNoteBody(bodyContent, node, { clamp: true, toggleHost: actions, toggleAnchor });

    // Sheet version tabs (only when this row is part of a multi-version group).
    this.renderVersionTabs(body, node);

    row.oncontextmenu = (evt) => { evt.preventDefault(); this.openNoteMenu(evt, node); };
  }

  /** Render the version tab bar at the bottom of a row whose note belongs to a
   *  `sheet:` group with more than one version. */
  private renderVersionTabs(body: HTMLElement, node: TreeNode): void {
    if (!this.plugin.settings.enableSheetVersions) return;
    if (!isVersionMember(nodeFm(this.app, node))) return;
    const gid = sheetIdOf(nodeFm(this.app, node))!;
    const parent = node.parent ?? this.focusId;
    const siblings = this.tree.getChildren(parent);
    const members = sortVersions(
      this.app,
      siblings.filter((s) => {
        const fm = nodeFm(this.app, s);
        return isVersionMember(fm) && sheetIdOf(fm) === gid;
      }),
    );
    if (members.length < 2) return;

    const bar = body.createDiv({ cls: "stashpad-version-tabs" });
    for (const m of members) {
      const isActive = m.id === node.id;
      const mFm = nodeFm(this.app, m);
      const isFinal = sheetIsFinal(mFm);
      const orig = isOriginal(mFm);
      const tab = bar.createDiv({
        cls:
          "stashpad-version-tab" +
          (isActive ? " is-active" : "") +
          (isFinal ? " is-final" : "") +
          (orig ? " is-original" : ""),
      });
      if (isFinal) tab.createSpan({ cls: "stashpad-version-star", text: "★" });
      tab.createSpan({
        cls: "stashpad-version-tab-label",
        text: tabTitle(this.app, m, this.titleForNode(m).trim() || "Untitled"),
      });
      const title = this.titleForNode(m).trim();
      tab.title = orig ? `${title} (original)` : `${title} (forked)`;
      if (!isActive) {
        tab.onclick = (e) => { e.stopPropagation(); this.setActiveVersion(gid, m.id); };
      }
    }
    const fork = bar.createEl("button", { cls: "stashpad-version-add stashpad-version-fork" });
    setIcon(fork, "git-fork");
    fork.title = "Fork this version (copy)";
    fork.onclick = (e) => { e.stopPropagation(); void this.cmdForkVersion(node); };
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
    opts: { clamp?: boolean; toggleHost?: HTMLElement; toggleAnchor?: HTMLElement; immediate?: boolean } = { clamp: true },
  ): void {
    if (!node.file) return;
    // Warm rows (cached HTML) render instantly — no deferral needed. Cold
    // rows (the expensive cachedRead misses) get a placeholder + observer.
    // `immediate` forces the now-path for elements the list's IntersectionObserver
    // doesn't cover — notably the desktop focused header, which is rendered into
    // `root` (outside the observed list), so a deferred render would never fire
    // and it'd stay stuck on the title placeholder (0.147.3 fix).
    if (opts.immediate || this.bodyRenderer.hasFreshRenderCache(node.file) || !this.bodyRenderer.isArmed()) {
      this.renderNoteBodyNow(container, node, opts);
      return;
    }
    // 0.180.0: stale-by-mtime but we DO have a cached render (this row was already
    // painted, then a write bumped the mtime). Pre-paint the cached body instantly
    // so a frontmatter-only write (color / task / due) doesn't flash the filename
    // placeholder — then recompute now; if the body actually changed it repaints.
    const cached = this.bodyRenderer.peekCache(node.file);
    if (cached) {
      this.prepaintCachedBody(container, node, cached, opts);
      this.renderNoteBodyNow(container, node, opts);
      return;
    }
    container.empty();
    const ph = container.createDiv({ cls: "stashpad-note-text is-plain is-lazy-placeholder" });
    ph.textContent = this.titleForNode(node);
    this.bodyRenderer.defer(container, () => this.renderNoteBodyNow(container, node, opts));
  }

  /** 0.180.0: synchronously paint a row's body from a (possibly stale) cache
   *  entry — just the text, clamped to match the collapsed state — to bridge a
   *  re-render without the filename-placeholder flash. renderNoteBodyNow's async
   *  recompute replaces this a tick later (identical for a frontmatter-only write;
   *  updated for a real body edit), and adds attachments / footer / the toggle. */
  private prepaintCachedBody(
    container: HTMLElement,
    node: TreeNode,
    entry: { text: string; html: string },
    opts: { clamp?: boolean },
  ): void {
    container.empty();
    const textEl = container.createDiv({ cls: "stashpad-note-text" });
    const expanded = this.isNoteExpanded(node.id);
    if (opts.clamp && !expanded) textEl.addClass("is-clamped");
    container.toggleClass("is-body-expanded", opts.clamp === true && expanded);
    if (this.compactMode || this.tinyMode) { textEl.addClass("is-plain"); textEl.textContent = entry.text; }
    else {
      textEl.append(sanitizeHTMLToDom(entry.html));
      // The prepaint is a real body the user can look at, not a placeholder, so
      // it needs the fold state too — otherwise a re-render flashes the callout
      // open before renderNoteBodyNow closes it again a tick later.
      this.applyCalloutFold(textEl, node.id);
    }
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
      const expanded = this.isNoteExpanded(node.id);
      if (opts.clamp && !expanded) textEl.addClass("is-clamped");
      // 0.171.1: the focused-header body has its own height cap
      // (.stashpad-focused-body max-height) that the text clamp doesn't
      // control. Mirror the expanded state onto the container so that cap
      // drops when the note is expanded (harmless class on list rows).
      container.toggleClass("is-body-expanded", opts.clamp === true && expanded);
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
        // the render cache; we parse it back into DOM with Obsidian's own
        // sanitizeHTMLToDom() and append the fragment to the (freshly emptied)
        // text element. This is the API the plugin-review linter blesses for
        // "HTML string → DOM" (vs. innerHTML / createContextualFragment, both
        // flagged). Event delegation for internal links / tags / embeds still
        // wires up without a fresh MarkdownRenderer pass. (Live-rendered widgets
        // like Mermaid/MathJax are the one weak spot — they won't re-execute from
        // cached HTML, but they're rare in chat-style notes and re-render on the
        // next mtime change anyway.)
        textEl.append(sanitizeHTMLToDom(html));
        this.applySpoilers(textEl);
        this.applyCalloutFold(textEl, node.id);
      }
      this.refreshStuckPreview(container, node, text);
      if (attachments.length > 0) this.renderAttachmentRail(container, attachments);
      this.renderLinkRail(container, node);
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
        // 0.118.11: an EXPANDED note isn't clamped, so its scrollHeight ==
        // clientHeight — measuring it would (wrongly) read "fits" and cache
        // ovV=false. That stale false then suppressed the toggle the moment you
        // collapsed the note (fast-path stripped the clamp, no button — the
        // "body shows but the button is gone, permanently" bug). So: never
        // measure an unclamped note. An expanded note ALWAYS gets a (collapse)
        // toggle; only measure/cache when the body is actually clamped.
        if (expanded) {
          this.attachExpandToggle(opts, container, node, expanded);
          return;
        }
        // 0.118.7: measure overflow against the ACTUAL clamped height
        // (scrollHeight vs clientHeight) — rendered markdown lines aren't a
        // fixed multiple of the base line-height, so the 0.118.5 "line-height ×
        // 2" heuristic over-triggered (a toggle on nearly every note). The only
        // wrinkle is that the cursor row is transiently unclamped by
        // `.is-cursor-expanded`; so for the read we momentarily drop that class
        // (synchronous — no repaint between the remove, the measure, and the
        // re-add), letting `.is-clamped` define clientHeight.
        const cursorRow = container.closest?.(".stashpad-note.is-cursor-expanded") as HTMLElement | null;
        if (cursorRow) cursorRow.removeClass("is-cursor-expanded");
        const overflowing = textEl.scrollHeight > textEl.clientHeight + 4;
        if (cursorRow) cursorRow.addClass("is-cursor-expanded");
        // Memoize for subsequent re-renders at this width (clamped read only).
        entry.ovW = memoW;
        entry.ovV = overflowing;
        if (!overflowing) {
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
    // 0.118.10: the row may be transiently auto-expanded by the cursor
    // (.is-cursor-expanded). The toggle must reflect what's VISIBLE — so a
    // cursor-auto-expanded row shows the "collapse" (up) affordance, and
    // clicking it actually collapses (previously the persistent state said
    // "collapsed" while the CSS kept it open, so the arrow was wrong and the
    // click did nothing visible).
    const cursorExpanded = !!container.closest?.(".stashpad-note.is-cursor-expanded");
    const effectiveExpanded = expanded || cursorExpanded;
    const toggle = host.createEl("button", { cls: "stashpad-expand-toggle" });
    toggle.title = effectiveExpanded ? "Show less" : "Show more";
    if (inHost || Platform.isMobile) {
      setIcon(toggle, effectiveExpanded ? "chevron-up" : "chevron-down");
      toggle.addClass("is-icon");
      if (inHost) toggle.addClass("is-inline");
    } else {
      toggle.setText(effectiveExpanded ? "Show less" : "Show more");
    }
    if (opts.toggleAnchor && opts.toggleAnchor.parentElement === host) {
      host.insertBefore(toggle, opts.toggleAnchor);
    }
    // 0.118.11: the row enters the note on double-click; a fast double-tap on
    // THIS button would bubble up and accidentally drill in. Swallow dblclick
    // (and mousedown) so toggle interactions never reach the row handler.
    toggle.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); });
    toggle.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    toggle.onclick = (e) => {
      e.stopPropagation();
      const rowEl = container.closest?.(".stashpad-note") as HTMLElement | null;
      const isCursorExpandedNow = !!rowEl?.classList.contains("is-cursor-expanded");
      const currentlyExpanded = this.isNoteExpanded(node.id) || isCursorExpandedNow;
      const next = !currentlyExpanded;
      if (isCursorExpandedNow && !next) {
        // Collapsing an auto-expanded cursor row: drop the transient class and
        // remember the override so the next repaint doesn't immediately re-open it.
        rowEl?.removeClass("is-cursor-expanded");
        this.cursorExpandOverride.add(node.id);
      } else if (next) {
        this.cursorExpandOverride.delete(node.id);
      }
      this.setNoteExpanded(node.id, next);
      // Re-render just this body in place to preserve list scroll.
      container.empty();
      this.renderNoteBody(container, node, opts);
    };
  }

  /** 0.268.3: path -> notes that link to it, built ONCE per render.
   *
   *  `resolvedLinks` is a vault-wide map of every link in every file. Reading
   *  it per rendered row would be the render-cost mistake this file already
   *  made twice, so it is inverted once and reused for the whole pass, then
   *  dropped. Rebuilt on the next render rather than cached across renders,
   *  because a stale backlink list is worse than a cheap rebuild: it names
   *  notes that no longer point here.
   *
   *  Null until something asks for it, so a vault with the setting off never
   *  pays anything at all. */
  private backlinkIndex: Map<string, string[]> | null = null;

  private backlinksFor(path: string): string[] {
    if (!this.backlinkIndex) {
      const idx = new Map<string, string[]>();
      const resolved = (this.app.metadataCache as unknown as {
        resolvedLinks?: Record<string, Record<string, number>>;
      }).resolvedLinks ?? {};
      for (const [from, targets] of Object.entries(resolved)) {
        for (const to of Object.keys(targets)) {
          const list = idx.get(to);
          if (list) list.push(from); else idx.set(to, [from]);
        }
      }
      this.backlinkIndex = idx;
    }
    return this.backlinkIndex.get(path) ?? [];
  }

  /** 0.268.3: the notes this one links to, and the notes that link back.
   *
   *  A SEPARATE row from the attachment rail, deliberately. Files, outgoing
   *  links and backlinks are three different kinds of thing, and one
   *  undifferentiated strip of chips would say less than no strip at all.
   *
   *  Outgoing links come from Obsidian's own parse (`getFileCache().links`)
   *  rather than a regex over the body. It already did the work, it handles
   *  aliases and headings correctly, and it means this does not touch the
   *  cached render entry's shape. */
  private renderLinkRail(parent: HTMLElement, node: TreeNode): void {
    const s = getSettings();
    if (!node.file || (!s.railShowOutgoing && !s.railShowBacklinks)) return;

    const seen = new Set<string>();
    const entries: { label: string; path: string; dir: "out" | "in" }[] = [];

    if (s.railShowOutgoing) {
      const links = this.app.metadataCache.getFileCache(node.file)?.links ?? [];
      for (const l of links) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(l.link, node.file.path);
        // Files already have the attachment rail; this row is about NOTES.
        if (!dest || dest.extension !== "md") continue;
        if (seen.has(`out:${dest.path}`)) continue;
        seen.add(`out:${dest.path}`);
        entries.push({ label: l.displayText || dest.basename, path: dest.path, dir: "out" });
      }
    }
    if (s.railShowBacklinks) {
      for (const from of this.backlinksFor(node.file.path)) {
        if (!from.endsWith(".md") || from === node.file.path) continue;
        if (seen.has(`in:${from}`)) continue;
        // 0.268.3: ignore Stashpad's OWN bookkeeping links.
        //
        // fmSync writes `parentLink` and `children` as wikilinks for recovery,
        // and `resolvedLinks` counts them like any other. Measured on a plain
        // test folder: a note with ONE real backlink reported four, the other
        // three being its parent and siblings via frontmatter. A backlink list
        // that is mostly the tree you are already looking at is worse than no
        // list.
        //
        // Obsidian parses frontmatter links separately from body links, so the
        // test is simply "does its BODY link here" rather than a guess about
        // field names.
        const src = this.app.vault.getAbstractFileByPath(from);
        if (!(src instanceof TFile)) continue;
        const bodyLinks = this.app.metadataCache.getFileCache(src)?.links ?? [];
        const linksInBody = bodyLinks.some((l) =>
          this.app.metadataCache.getFirstLinkpathDest(l.link, from)?.path === node.file!.path);
        if (!linksInBody) continue;
        seen.add(`in:${from}`);
        entries.push({ label: from.split("/").pop()?.replace(/\.md$/, "") ?? from, path: from, dir: "in" });
      }
    }
    if (!entries.length) return;

    const paintRow = (list: typeof entries): void => {
      const rail = parent.createDiv({ cls: "stashpad-link-rail" });
      for (const e of list) {
        const chip = rail.createDiv({ cls: `stashpad-link-chip is-${e.dir}` });
        setIcon(chip.createSpan({ cls: "stashpad-link-chip-icon" }), e.dir === "out" ? "arrow-up-right" : "corner-down-left");
        chip.createSpan({ cls: "stashpad-link-chip-label", text: e.label });
        chip.title = e.dir === "out" ? `Links to ${e.path}` : `${e.path} links here`;
        chip.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const f = this.app.vault.getAbstractFileByPath(e.path);
          if (f instanceof TFile) void this.openFileAtEnd(f);
        };
        chip.addEventListener("dblclick", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      }
    };

    // 0.272.3: split onto two rows BY TYPE once the combined row gets crowded —
    // outgoing on its own line, backlinks on another — so a hub note with many
    // links reads by kind instead of one long mixed scroll. A short list (both
    // kinds, few links) stays on one line; a list that is all one kind is
    // already single-type, so it never needs splitting.
    const outs = entries.filter((e) => e.dir === "out");
    const ins = entries.filter((e) => e.dir === "in");
    if (entries.length > LINK_RAIL_SPLIT_AT && outs.length > 0 && ins.length > 0) {
      paintRow(outs);
      paintRow(ins);
    } else {
      paintRow(entries);
    }
  }

  /** 0.271.5: a single reusable tooltip element, shown instantly at the cursor.
   *  Lives on document.body so the rail's `overflow-x: auto` cannot clip it. */
  private railTooltipEl: HTMLElement | null = null;
  private hideInstantTooltip = (): void => {
    this.railTooltipEl?.remove();
    this.railTooltipEl = null;
  };
  private attachInstantTooltip(el: HTMLElement, text: string): void {
    const place = (e: MouseEvent): void => {
      if (!this.railTooltipEl) {
        const doc = el.ownerDocument ?? document;
        this.railTooltipEl = doc.body.createDiv({ cls: "stashpad-instant-tip", text });
      } else {
        this.railTooltipEl.setText(text);
      }
      // Same offset as the native tooltip: just below-right of the pointer.
      this.railTooltipEl.style.left = `${e.clientX + 12}px`;
      this.railTooltipEl.style.top = `${e.clientY + 16}px`;
    };
    el.addEventListener("mouseenter", place);
    el.addEventListener("mousemove", place);
    el.addEventListener("mouseleave", this.hideInstantTooltip);
  }

  private renderAttachmentRail(parent: HTMLElement, paths: string[]): void {
    const rail = parent.createDiv({ cls: "stashpad-rail" });
    const imageCount = paths.filter((p) => isImageExt(p.split(".").pop() ?? "")).length;

    // 0.235.0: the rail picks a layout instead of always drawing thumbnails.
    // Measured from the RAIL's own width, not the window's — the rail lives in
    // a note row that may be in a narrow sidebar, and the window says nothing
    // about that. The width is 0 before layout, in which case fall back to the
    // parent's, then to a sane desktop default rather than mis-picking
    // "compact" for everything on first paint.
    const setting = getSettings().attachmentRailMode;
    const measured = rail.clientWidth || parent.clientWidth || 600;
    // 0.271.5: the flipper is a TEMPORARY per-view override, not a global write.
    // Writing the global setting made every open view re-render (thousands of
    // rows across tabs) on a single tap — the user flagged exactly this. The
    // override lives in memory on this view, so a flip re-renders only THIS
    // view and resets on reload; the persistent default stays the settings one.
    const mode: RailMode = this.railModeOverride ?? (setting === "auto"
      ? pickRailMode(paths.length, imageCount, measured)
      : setting);
    rail.addClass(`is-${mode}`);

    // 0.271.4: a layout flipper as a pseudo-file at the START of the rail, so a
    // note with many attachments can be switched between the compact icon strip
    // and the vertical filename list in one tap without a trip to settings.
    // 0.271.5: a TEMPORARY per-view override (railModeOverride), so it re-renders
    // only this view and resets on reload — not a global write. Shown only with
    // 2+ items; flipping a single file is pointless.
    // 0.272.2: the big "thumbnail" card grid is NOT a flip stop (the user's
    // request) — it stays the default/settings choice, but the flipper toggles
    // between the two denser layouts.
    if (paths.length >= 2) {
      const cycle: RailMode[] = ["filename", "compact"];
      const next = cycle[(cycle.indexOf(mode) + 1) % cycle.length];
      const flip = rail.createDiv({ cls: "stashpad-att stashpad-att-flip" });
      flip.title = `Attachment layout: ${mode} — tap for ${next}`;
      setIcon(flip, mode === "filename" ? "layout-grid" : "layout-list");
      flip.onclick = (e) => {
        e.stopPropagation();
        this.railModeOverride = next;   // per-view, in-memory; re-renders only this view
        this.render();
      };
    }

    for (const p of paths) {
      const file = this.app.metadataCache.getFirstLinkpathDest(p, "");
      const ext = (p.split(".").pop() ?? "").toLowerCase();
      const kind = fileKindFor(ext);
      const baseName = p.split("/").pop() ?? p;
      const box = rail.createDiv({ cls: "stashpad-att" });
      // 0.271.5: instant tooltip at the cursor instead of the native `title`,
      // which only appears after a ~1s delay. Same position as native (follows
      // the pointer), just no wait — the whole point of a rail is quick
      // identification, and a clamped name plus a one-second-late tooltip is not
      // quick. aria-label keeps the accessible name; the visual tip is custom.
      const tipText = file ? `${baseName} — ${kind.label}` : `${baseName} — missing`;
      box.setAttribute("aria-label", tipText);
      this.attachInstantTooltip(box, tipText);
      if (!file) box.addClass("is-missing");

      // Thumbnails in EVERY mode, including the filename list — a 24px preview
      // of the actual image identifies it better than a generic "image" glyph,
      // and the list has room for it beside the name.
      const showThumb = !!file && isImageExt(ext);
      if (showThumb) {
        const img = box.createEl("img", { cls: "stashpad-att-img" });
        img.src = this.app.vault.getResourcePath(file);
        img.alt = p;
      } else {
        // Typed icon + extension. A coloured, recognisable glyph identifies a
        // file far faster than four grey letters, which is what this used to
        // be for everything that was not an image.
        const badge = box.createDiv({ cls: "stashpad-att-badge" });
        badge.style.setProperty("--stashpad-file-color", kind.color);
        setIcon(badge, kind.icon);
        badge.createSpan({ cls: "stashpad-att-badge-ext", text: (ext || "?").toUpperCase() });
      }
      // The filename view is a list, so every row carries its name; the other
      // two only name a file when there is no thumbnail to identify it.
      if (mode === "filename" || (!showThumb && mode !== "compact")) {
        box.createDiv({ cls: "stashpad-att-name", text: baseName });
      }

      box.onclick = (e) => {
        e.stopPropagation();
        // 0.245.0: the decision looks at the WHOLE note, not just this file.
        // The viewer shows a rail of every attachment, so a zip sitting beside
        // a photo should still open it — otherwise clicking the wrong tile
        // strands you away from the rail you were reaching for.
        const st = getSettings();
        const siblingExts = paths.map((q) => q.split(".").pop() ?? "");
        const openViewer = (): void => {
          new MediaViewerModal(this.app, mediaItemsFor(this.app, paths), paths.indexOf(p), (f) => {
            const ws = this.app.workspace; const prev = ws.activeLeaf;
            void ws.getLeaf("tab").openFile(f).then(() => { settleNewTab(ws, prev); });
          }).open();
        };
        // 0.245.0: a MISSING file always opens the viewer. There is no file to
        // open in a tab, and the viewer both explains what is wrong and gets
        // you to the note's other attachments — strictly better than the
        // notice this used to show, which left you where you started.
        if (!file) { openViewer(); return; }
        if (st.mediaViewerOnClick && viewerHandles(ext, {
          excluded: st.mediaViewerExcludedExtensions,
          allTypes: st.mediaViewerAllFileTypes,
          siblingExts,
        })) { openViewer(); return; }
        const ws = this.app.workspace; const prev = ws.activeLeaf;
        void ws.getLeaf("tab").openFile(file).then(() => { settleNewTab(ws, prev); });
      };
      box.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.openAttachmentMenu(e, p, file, ext); };
    }
  }

  /** 0.184.0: context menu for an attachment in a note's rail. */
  private openAttachmentMenu(evt: MouseEvent, path: string, file: TFile | null, ext: string): void {
    const menu = new Menu();
    if (file && IMG_EXT.has(ext)) {
      menu.addItem((it: any) => it.setTitle("Copy image").setIcon("copy").onClick(() => void this.copyAttachmentImage(file)));
    }
    if (file) {
      menu.addItem((it: any) => it.setTitle("Open in new tab").setIcon("external-link").onClick(() => { const ws = this.app.workspace; const prev = ws.activeLeaf; void ws.getLeaf("tab").openFile(file).then(() => { settleNewTab(ws, prev); }); }));
      for (const a of buildFileActions(this.app, file.path, Platform.isMobile)) {
        menu.addItem((it: any) => it.setTitle(a.label).setIcon(a.label.startsWith("Reveal") ? "folder-open" : "arrow-up-right").onClick(() => void a.onClick()));
      }
    }
    menu.addItem((it: any) => it.setTitle("Copy path").setIcon("link").onClick(() => void navigator.clipboard?.writeText(path).then(() => new Notice("Path copied."), () => {})));
    menu.showAtMouseEvent(evt);
  }

  /** 0.184.0: copy an image attachment to the OS clipboard as a native image, so
   *  it can be pasted into chat apps / email / editors. Desktop only (Electron). */
  private async copyAttachmentImage(file: TFile): Promise<void> {
    try {
      const electron = (window as unknown as { require?: (m: string) => any }).require?.("electron");
      if (!electron?.clipboard?.writeImage || !electron?.nativeImage) {
        new Notice("Copying an image to the clipboard needs the desktop app.");
        return;
      }
      const buf = await this.app.vault.readBinary(file);
      const img = electron.nativeImage.createFromBuffer(Buffer.from(new Uint8Array(buf)));
      if (img.isEmpty()) { new Notice("Couldn't read that image."); return; }
      electron.clipboard.writeImage(img);
      new Notice("Image copied to the clipboard.");
    } catch (e) {
      console.warn("[Stashpad] copy image failed", e);
      new Notice("Couldn't copy the image.");
    }
  }

  /** 0.119.0 (mobile-ui-changes-2): bottom-left nav cluster in the composer —
   *  folder picker + search + jump-to-level (route). Mobile only; these moved
   *  out of the top toolbar / breadcrumb. Always visible (no collapse, per the
   *  request that always-visible is fine). */
  private renderComposerNavCluster(rail: HTMLElement): void {
    const nav = rail.createDiv({ cls: "stashpad-composer-nav" });
    // Folder picker (shows the per-folder icon if set, else the folder glyph).
    const folderBtn = nav.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-nav-folder" });
    setIcon(folderBtn, this.plugin.getFolderIcon(this.noteFolder) ?? "folder");
    // 0.119.4: show the folder NAME (capped via CSS) so you know which folder
    // you're in — not just the icon.
    const fname = (this.noteFolder.split("/").pop() || this.noteFolder) || "Stashpad";
    folderBtn.createSpan({ cls: "stashpad-btn-text", text: fname });
    folderBtn.title = `Folder: ${this.noteFolder}\nTap to switch / create.`;
    if (this.folderOverride) folderBtn.addClass("is-active");
    folderBtn.onmousedown = (e) => e.preventDefault();
    folderBtn.onclick = (e) => { e.preventDefault(); this.openFolderPicker(); };
    // Search.
    const searchBtn = nav.createEl("button", { cls: "stashpad-composer-btn" });
    setIconSafe(searchBtn, "search", "🔍");
    searchBtn.title = "Search notes (Mod+F)";
    searchBtn.onmousedown = (e) => e.preventDefault();
    searchBtn.onclick = (e) => { e.preventDefault(); this.openSearchModal(); };
    // 0.119.6: route (jump-to-level) moved to the actions cluster (after the
    // forward button) — see renderActionsCluster. The composer nav is now just
    // folder + search.
  }

  /** The composer-chrome inputs that are baked in at BUILD time rather than
   *  synced in place. If any of these change, reuse would show stale chrome, so
   *  render() rebuilds the composer (accepting one keyboard flicker for these
   *  rare, deliberate transitions). Everything not listed here is either static
   *  or refreshed in place on the reuse path. */
  private composerSig(): string {
    return [
      this.noteFolder,
      this.tinyMode,
      this.compactMode,
      Platform.isMobile,
      this.folderOverride ?? "",
      this.plugin.getFolderIcon(this.noteFolder) ?? "",
    ].join("\u0000");
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
    this.composerRootEl = composer;
    this.composerSignature = this.composerSig();

    // Wrap the textarea so we can absolutely-position the clear-X over it.
    const taWrap = composer.createDiv({ cls: "stashpad-composer-input-wrap" });
    const ta = taWrap.createEl("textarea", {
      cls: "stashpad-composer-input",
      attr: { rows: "2", placeholder: this.composerPlaceholder(enterSubmits, splitMode) },
    });

    // 0.267.1 (CONFIRMED on device): keep a selection drag inside the composer
    // from reaching Obsidian's sidebar gesture.
    //
    // Dragging to highlight text opened the left/right sidebar instead. The
    // first attempt restored `user-select: text`, on the theory that a control
    // which cannot select text leaves the drag unclaimed — measured and true,
    // but it did NOT fix the gesture, which means the handler never consults
    // selection at all.
    //
    // So this aims a layer lower: if Obsidian listens on the document during
    // the bubble phase, stopping propagation at the textarea keeps the drag
    // from ever reaching it. `stopPropagation` only, never `preventDefault` —
    // the browser must keep its own native scrolling and selection behaviour,
    // and this only hides the event from listeners further up.
    //
    // That this works proves the handler is bubble-phase and bound above this
    // element — the earlier user-select attempt failed because the handler
    // never consults selection at all.
    //
    // Trade-off, accepted knowingly: these events become invisible to anything
    // upstream over the composer, Obsidian's own gestures included. That IS the
    // point, but it is indiscriminate — which is why it is scoped to this one
    // control and not to a container.
    if (Platform.isMobile) {
      for (const evt of ["touchstart", "touchmove"]) {
        ta.addEventListener(evt, (e) => { e.stopPropagation(); }, { passive: true });
      }
    }
    ta.value = this.composerDraft;

    // 0.179.0: full-screen button (top-right of the composer) — opens the current
    // composer text in the in-app editor; Save creates the note(s) and clears the
    // composer.
    const fsBtn = taWrap.createEl("button", { cls: "stashpad-composer-fullscreen" });
    setIcon(fsBtn, "maximize");
    fsBtn.title = "Open in the full editor";
    fsBtn.setAttr("aria-label", "Open in the full editor");
    fsBtn.onmousedown = (e) => e.preventDefault();
    fsBtn.onclick = (e) => { e.preventDefault(); this.cmdComposerFullscreen(); };

    // Debounce non-empty saves so fast typing doesn't queue a disk write
    // per keystroke (a real issue on slow / network drives). Empty/clear
    // saves still go through immediately on submit/blur for promptness.
    if (!this.debouncedSaveDraft) {
      this.debouncedSaveDraft = debounce((v: string) => { void this.saveDraft(v); }, 250);
    }
    ta.addEventListener("input", () => {
      this.composerDraft = ta.value;
      this.debouncedSaveDraft!(ta.value);
      // 0.222.0: `+` ALONE in the composer means "append to an existing note".
      // Requiring it to be the whole value is what makes this safe to put on a
      // single character: it can only fire as the first keystroke into an empty
      // composer, never mid-sentence. Dismissing the picker leaves the `+`
      // in place, so a markdown "+ " bullet costs one Escape.
      if (ta.value === "+" && !this.appendTarget && getSettings().composerAppendTrigger) {
        this.openAppendPicker();
      }
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
        this.viewRoot?.focus({ preventScroll: true });
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
      try { (this.app as any).keymap?.popScope(composerScope); } catch { /* ignore */ }
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
        // Guard row taps until the keyboard-dismiss reflow settles (rows slide
        // ~336px under the finger over ~120ms; 300ms covers slower devices).
        this.tapSettleUntil = Date.now() + 300;
        // 0.89.0: tapping the list to dismiss the composer should leave the
        // selected note visible (it may have been hidden behind the composer).
        // Re-reveal after the keyboard's close animation settles the layout.
        // 0.216.2: only when the cursor row is already NEAR the viewport. This
        // reveal exists to counter the keyboard-dismiss reflow (~336px of row
        // slide as the leaf regrows) — it is a "keep what you were looking at
        // visible" fix, not navigation. Deciding unconditionally meant that
        // after a send (cursor on the newest note, which sits at the TOP of
        // the stack), tapping ANY toolbar button while the composer was
        // focused blurred it and, 350ms later, yanked the whole list to the
        // top. Measured live: scrollTop 4495 -> 129 from one select-mode tap.
        // A row within 1.5 list-heights comfortably covers the genuine reflow
        // case; anything farther means the user deliberately scrolled away.
        if (Platform.isMobile && this.cursorIdx >= 0 && this.cursorRowNearViewport()) {
          setTimeout(() => this.revealCursorRow(), 350);
        }
      });
    }
    this.composerInputEl = ta;
    // Tear down any previous autocomplete (the textarea was just rebuilt
    // by render) and attach a fresh one to the new node.
    if (this.composerAutocomplete) this.composerAutocomplete.detach();
    // 0.202.0: tell the shared input layer when Enter makes a NEWLINE rather
    // than sending — list continuation must never pre-empt a submit. Mirrors
    // the send rule in the keydown handler below (read live, so toggling the
    // Enter mode takes effect without a rebuild).
    this.composerAutocomplete = new ComposerAutocomplete(this.app, ta, {
      insertsNewline: (e) => !(this.modeEnterSubmits ? !e.shiftKey : e.shiftKey),
    }, (text) => {
      // Slash command about to run: persist the composer NOW. Many commands
      // write settings, and the settings-change handler reconciles the
      // composer against the last persisted draft — with the debounced save
      // still pending, that reconciliation can restore an older draft over
      // what the user just typed.
      this.composerDraft = text;
      void this.saveDraft(text);
    });
    this.composerAutocomplete.attach();

    // Drag-and-drop + paste of files into the composer. Both flows
    // funnel through importAttachment (same code path the paperclip
    // button uses), so each dropped/pasted file is copied into
    // <stashpad>/_attachments and an ![[wikilink]] is appended to the
    // textarea body.
    const importAndAppend = async (files: File[]): Promise<void> => {
      // 0.268.1: a dropped `.stash` is a BUNDLE, not an attachment. Routing is
      // the import service's job, since it already owns the encrypted queue and
      // the "waiting" notification; this only lays out what comes back.
      const routed = await this.plugin.importService.routeDroppedFiles(
        files, this.noteFolder, (f) => this.importAttachment(f),
      );
      let appended = "";
      for (const link of routed.links) {
        const cur = ta.value + appended;
        const sep = cur && !cur.endsWith("\n") ? "\n" : "";
        appended += `${sep}${link}\n`;
      }
      // ONE summary, never one notice per file. A five-file drop that imported
      // two bundles, parked an encrypted one and attached the rest should read
      // as a single sentence.
      if (routed.imported || routed.parked || routed.failed) {
        const bits: string[] = [];
        if (routed.imported) bits.push(`imported ${routed.imported} bundle${routed.imported === 1 ? "" : "s"}`);
        if (routed.attached) bits.push(`attached ${routed.attached} file${routed.attached === 1 ? "" : "s"}`);
        if (routed.parked) bits.push(`${routed.parked} encrypted bundle${routed.parked === 1 ? "" : "s"} waiting for a password`);
        if (routed.failed) bits.push(`${routed.failed} failed`);
        const msg = `Stashpad: ${bits.join(", ")}.`;
        if (routed.parked) {
          this.plugin.notifications.show({
            message: msg, kind: "info", category: "system",
            actions: [{
              label: "Import now",
              onClick: () => void this.plugin.importService.importPendingEncrypted(),
            }],
          });
        } else {
          new Notice(msg, 6000);
        }
      }
      if (appended) {
        ta.value = ta.value + appended;
        this.composerDraft = ta.value;
        void this.saveDraft(ta.value);
        const caret = ta.value.length;
        ta.focus();
        ta.setSelectionRange(caret, caret);
        // 0.212.2: the focus above is not enough on its own. importAttachment
        // writes the file into <stashpad>/_attachments, and that vault create
        // event drives a re-render which REBUILDS the composer textarea — so
        // `ta` becomes a detached node and the focus lands on nothing. The text
        // survived (the new textarea seeds from composerDraft, saved above),
        // which is exactly why this read as "the image attaches but I still
        // have to click into the composer".
        //
        // Claim the cross-render focus restore as well, so whichever order the
        // render lands in, the LIVE textarea ends up focused with the caret at
        // the end. Deliberately NOT focusComposer() — that self-gates on the
        // focusComposerOnOpen setting, and a drop is a direct user action in
        // the composer, not the on-open autofocus that setting governs.
        this.focusComposerOnNextRender = true;
        this.pendingComposerCaret = caret;
      }
    };

    ta.addEventListener("dragover", (e) => {
      // Only accept drags that actually carry files — otherwise text
      // selections from elsewhere in the page would be hijacked too.
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = "copy"; } catch { /* ignore */ }
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

    // (0.201.2: the hidden composer file input is gone — the paperclip opens
    // the DropzoneModal, whose zone hosts its own picker.)

    const btnRail = composer.createDiv({ cls: "stashpad-composer-btn-rail" });
    // 0.119.0 (mobile-ui-changes-2): on mobile, the folder picker + search +
    // jump-to-level (route) controls live here at the bottom-left of the
    // composer (moved out of the top toolbar / breadcrumb).
    if (Platform.isMobile) this.renderComposerNavCluster(btnRail);
    // Mobile: secondary buttons (split/dest/enter/clip) live inside a
    // collapsible group. A chevron-left button at the head of the rail
    // toggles their visibility — collapsed at rest to keep the composer
    // uncluttered. Send always stays outside the group.
    const expandedGroup = btnRail.createDiv({ cls: "stashpad-composer-btn-group" });
    const splitBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn" });
    setIcon(splitBtn, "list-end");
    this.composerSplitBtn = splitBtn;
    const splitModeLabel = SPLIT_MODE_LABELS[getSettings().splitMode].toLowerCase();
    splitBtn.title = splitMode
      ? `Split: ON — ${splitModeLabel} (Mod+/ to toggle, right-click to change)`
      : `Split into notes (Mod+/) — right-click to choose: ${splitModeLabel}`;
    if (splitMode) splitBtn.addClass("is-active");
    splitBtn.onmousedown = (e) => e.preventDefault();
    splitBtn.onclick = (e) => { e.preventDefault(); this.toggleSplit(); };
    // Right-click → choose how the paste is split (each line / paragraphs / headings).
    splitBtn.oncontextmenu = (e) => {
      e.preventDefault();
      const menu = new Menu();
      const current = getSettings().splitMode;
      (["lines", "paragraphs", "headings"] as SplitMode[]).forEach((m) => {
        menu.addItem((it: any) => it
          .setTitle(SPLIT_MODE_LABELS[m])
          .setChecked(m === current)
          .onClick(async () => {
            this.plugin.settings.splitMode = m;
            await this.plugin.saveSettings();
            this.syncComposerModeUI();
          }));
      });
      menu.showAtMouseEvent(e);
    };

    // (0.201.2: the 0.199.3 dropzone button merged into the paperclip below.)

    const destBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-dest" });
    this.composerDestBtn = destBtn;
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
      this.openQuickDestinationMenu(e, wasFocused);
    };

    // 0.222.0: append-target chip. Only rendered while a target is bound, so
    // append mode is never invisible state — you can always see where the next
    // send is going, and clear it in one tap.
    const appendBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-append" });
    this.composerAppendBtn = appendBtn;
    appendBtn.onmousedown = (e) => e.preventDefault();
    appendBtn.onclick = (e) => {
      e.preventDefault();
      const t = this.appendTarget;
      const menu = new Menu();
      if (t) {
        const flip = t.mode === "prepend" ? "append" : "prepend";
        menu.addItem((i: any) => i
          .setTitle(flip === "prepend" ? "Prepend instead (write at the top)" : "Append instead (write at the bottom)")
          .setIcon(flip === "prepend" ? "corner-right-up" : "corner-down-right")
          .onClick(() => {
            this.setAppendTarget({ ...t, mode: flip });
            this.composerInputEl?.focus();
          }));
      }
      menu.addItem((i: any) => i.setTitle("Change target note…").setIcon("search")
        .onClick(() => this.openAppendPicker(t?.mode ?? "append")));
      menu.addItem((i: any) => i.setTitle("Cancel (create a new note instead)").setIcon("x").onClick(() => {
        this.setAppendTarget(null);
        this.composerInputEl?.focus();
      }));
      menu.showAtMouseEvent(e);
    };
    this.refreshAppendButton();

    const enterBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn" });
    this.composerEnterBtn = enterBtn;
    setIcon(enterBtn, enterSubmits ? "corner-down-left" : "arrow-big-down-dash");
    enterBtn.title = enterSubmits
      ? "Enter sends (click to switch to Shift+Enter)"
      : "Shift+Enter sends (click to switch to Enter)";
    enterBtn.onmousedown = (e) => e.preventDefault();
    enterBtn.onclick = (e) => {
      e.preventDefault();
      // Toggle the Enter mode IN PLACE (a full render() would rebuild the list —
      // scroll jump + collapse the button group). The keydown handler reads
      // this.modeEnterSubmits live, so nothing to rebind.
      this.modeEnterSubmits = !this.modeEnterSubmits;
      this.syncComposerModeUI();
      ta.focus();
    };

    const appendLink = (link: string) => {
      const sep = ta.value && !ta.value.endsWith("\n") ? "\n" : "";
      ta.value += `${sep}${link}\n`;
      this.composerDraft = ta.value;
    };

    // 0.201.2: the paperclip absorbed the 0.199.3 dropzone button's powers
    // (the two were redundant): drop files straight ONTO it, or click for the
    // large dropzone modal (whose zone doubles as the file picker). Same icon
    // as always; the separate dropzone button is gone.
    const clipBtn = expandedGroup.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-drop" });
    setIcon(clipBtn, "paperclip");
    clipBtn.title = "Attach files — drop them here, or click for a bigger dropzone / file picker";
    clipBtn.onmousedown = (e) => e.preventDefault();
    clipBtn.onclick = (e) => {
      e.preventDefault();
      // 0.201.3: on MOBILE go straight to the native attachment sheet — a
      // dropzone is pointless without drag-and-drop, and the extra tap read
      // as a downgrade. Desktop keeps the big dropzone modal.
      if (Platform.isMobile) {
        const doc = this.containerEl.ownerDocument ?? document;
        const input = doc.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.setCssStyles({ display: "none" });
        input.onchange = () => {
          const picked = Array.from(input.files ?? []);
          input.remove();
          if (picked.length) void importAndAppend(picked);
        };
        doc.body.appendChild(input);
        input.click();
        return;
      }
      new DropzoneModal(this.app, (files) => void importAndAppend(files)).open();
    };
    clipBtn.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = "copy"; } catch { /* ignore */ }
      clipBtn.addClass("is-dropover");
    });
    clipBtn.addEventListener("dragleave", () => clipBtn.removeClass("is-dropover"));
    clipBtn.addEventListener("drop", (e) => {
      clipBtn.removeClass("is-dropover");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault(); e.stopPropagation();
      void importAndAppend(files);
    });
    // Button order (per product decision): destination · attachment · send-mode ·
    // split. append() moves the already-created nodes into this order without
    // disturbing their handlers or the appendLink dependency above.
    expandedGroup.append(destBtn, clipBtn, enterBtn, splitBtn);

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
    // 0.142.7: collapse only when the rail genuinely can't fit the fanned-out
    // buttons. Desktop keeps the 700px feel (secondary buttons sit inline beside
    // a wide textarea); on mobile the rail is its own row below the textarea, so a
    // normal phone (~360px+) has room to show them expanded. "Smartphones aren't
    // getting smaller" — only truly tiny widths collapse.
    const computeNarrow = () => composer.clientWidth < (Platform.isMobile ? 360 : 700);
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

    // 0.270.3: Send is UNGROUPED — a direct child of the composer, not a member
    // of the button rail. Inside the rail it was one flex item among several,
    // sharing the rail's flow (and the collapsible group's `overflow: hidden` /
    // `opacity` stacking context) with nothing to guarantee it painted last. As
    // its own composer child it can be given its own layer: mobile CSS pins it
    // absolutely over the rail's right end with a z-index, so no sibling in the
    // composer can be painted or hit-tested over it. The layout is unchanged —
    // the rail reserves exactly the width Send used to occupy.
    //
    // NOTE: this deliberately leaves the textarea and its ancestors untouched.
    // The `touchstart`/`touchmove` guard above still sits on the textarea, in
    // the same place in the tree, so the swipe-to-highlight fix is unaffected.
    const sendBtn = composer.createEl("button", { cls: "stashpad-composer-btn stashpad-composer-send" });
    // 0.270.3: the same guard the textarea carries, for the same reason. Send is
    // the rightmost control in the view, and its invisible hit-area extender
    // (`::before`, -8px) reaches into the strip along the screen edge where
    // Obsidian listens for the drawer gesture. The textarea case PROVED that
    // handler is bubble-phase and bound above us, so stopping propagation at the
    // button keeps a press that begins on Send from ever reaching it.
    // `stopPropagation` only, never `preventDefault` — the button's own
    // `touchend` handler below is on this same element and is unaffected
    // (`stopPropagation` does not silence same-element listeners).
    if (Platform.isMobile) {
      for (const evt of ["touchstart", "touchmove"]) {
        sendBtn.addEventListener(evt, (e) => { e.stopPropagation(); }, { passive: true });
      }
    }
    // 0.216.0: every sibling button already guards mousedown (destBtn's comment
    // documents why: stealing focus dismisses the mobile keyboard). Send was
    // the ONE button without it, so a tap on Send blurred the textarea at
    // gesture time — dismissing the keyboard before submit even ran.
    sendBtn.onmousedown = (e) => e.preventDefault();
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
      try { await this.saveDraft(""); } catch { /* ignore */ }
      try { await this.recordLastSubmitted(text); } catch { /* ignore */ }
      // 0.193.0: a block where EVERY line is a checkbox is a task LIST — split it
      // into one task per line even when split-on-newlines is off, since a single
      // note full of checkbox text is almost never the intent (setting-gated).
      // 0.222.0: append mode short-circuits creation entirely — no split, no
      // destination, no attachment rehoming (the target already lives here).
      const append = this.appendTarget;
      if (append) {
        this.setAppendTarget(null);
        // 0.225.0: an attachment staged in THIS composer lives in THIS folder's
        // _attachments, but a cross-folder target lives elsewhere — the link
        // would resolve to a file the target's folder doesn't own, which is the
        // stranding bug 0.213.0 fixed for new notes. Rehome first, exactly as
        // the remote-send path does.
        const outText = append.folder && append.folder !== this.noteFolder
          ? await this.rehomeComposerAttachments(text, append.folder)
          : text;
        await this.appendToTarget(append, outText);
        // Same reasoning as the create path below: whatever this compose staged
        // now belongs to the note we just wrote into. Leaving the set populated
        // would let a later send rehome those attachments out from under it.
        this.composerCreatedAttachments.clear();
        if (getSettings().autofocusComposerAfterSend) this.composerInputEl?.focus();
        return;
      }
      const allChecks = getSettings().splitCheckboxLines && isAllCheckboxLines(text);
      const split = (this.modeSplit ?? getSettings().splitOnLines) || allChecks;
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
      const createOpts = remote ? { targetFolder: destFolder } : undefined;
      // 0.213.0: an attachment added from THIS folder's composer was already
      // written to <this.noteFolder>/_attachments by importAttachment — that
      // happens at drop/paste time, before the destination is known. If the
      // send then goes somewhere else, the note lands in destFolder while its
      // attachment stays behind, and deleting this folder breaks the note.
      //
      // Fix it HERE, at creation, because this is the one moment where the
      // ownership question has an unambiguous answer: the attachment was just
      // created for a note that does not exist yet, so it has exactly ONE
      // referent and there is no competing claim to weigh. (The general
      // shared-attachment case is genuinely unresolvable by rule and is
      // handled by reporting, not moving — see rehomeStrayAttachments.)
      const sendText = remote && destFolder
        ? await this.rehomeComposerAttachments(text, destFolder)
        : text;
      // Bind the parent ONCE, here at submit time. A split otherwise reads
      // this.focusId on each per-note await, so navigating mid-paste reparents
      // the remaining notes into whatever level you moved to (the "looks
      // broken" bug). dest covers explicit/remote destinations; otherwise it's
      // the level we're submitting from.
      const parent = dest ?? this.focusId;
      if (split) {
        const lines = splitIntoChunks(sendText, getSettings().splitMode);
        if (lines.length === 1) {
          await this.createNoteUnder(lines[0], parent, createOpts);
        } else if (lines.length > 1) {
          await this.createNotesBatch(lines, parent, createOpts, sendText, remote ? destFolder : this.noteFolder);
        }
      } else {
        await this.createNoteUnder(sendText, parent, createOpts);
      }
      // 0.213.0: this compose is over — whatever it staged now belongs to the
      // note that was just created. Not clearing would let a stale path be
      // treated as "staged by this composer" on a later send and get moved out
      // from under the note now using it.
      this.composerCreatedAttachments.clear();
      // Keep focus in the composer so the user can keep typing without
      // re-clicking — unless the user disabled this in settings.
      if (getSettings().autofocusComposerAfterSend) {
        this.focusComposerOnNextRender = true;
        // 0.76.15: remote sends already rendered inside createNoteUnder
        // (before this flag was set), so restore focus directly.
        if (remote) this.composerInputEl?.focus();
      }
    };
    // 0.267.10: on mobile, act on touchend rather than waiting for the click.
    //
    // 0.216.0 gave Send the same `mousedown -> preventDefault` guard its
    // siblings have, to stop the tap blurring the textarea and dismissing the
    // keyboard before submit ran. That fixed the keyboard but made the tap
    // itself unreliable: on iOS the mouse events are SYNTHESISED after the
    // touch sequence, and preventDefault on a synthesised mousedown can
    // suppress the click that was meant to follow. A button that works most of
    // the time is worse than one that never did, because you stop watching it.
    //
    // Handling touchend removes the dependency on that synthesised click
    // entirely. preventDefault there stops the mouse emulation altogether, so
    // the keyboard still cannot be dismissed by the tap — and the guard below
    // means a double fire is impossible even if some platform still delivers
    // both.
    let lastSubmitAt = 0;
    const fireSubmit = (): void => {
      const now = Date.now();
      if (now - lastSubmitAt < 600) return;
      lastSubmitAt = now;
      void submit();
    };
    sendBtn.onclick = () => fireSubmit();
    if (Platform.isMobile) {
      sendBtn.addEventListener("touchend", (e) => {
        // Only a real tap on the button — a drag that happens to end here is
        // not a press, and multi-touch is not either.
        if (e.changedTouches.length !== 1) return;
        e.preventDefault();
        fireSubmit();
      });
    }

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
    this.composerHelperEl = helper;
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
    this.mobileNavEl = nav;
    nav.createEl("button", { text: "Home" }).onclick = () => this.navigateTo(ROOT_ID);
    nav.createEl("button", { text: "Back" }).onclick = () => this.navigateUp();
    nav.createEl("button", { text: "Bookmarks" }).onclick = () => this.openBookmarks();
  }

  // --- Click + selection ---

  /** Tag + internal-link click delegation for any rendered-markdown
   *  surface that ISN'T a row (focused header body, mini header, etc.).
   *  Same routing as handleRowClick's tag/link branches; doesn't touch
   *  selection / cursor — those concepts don't apply outside the list. */
  /** 0.265.1: fold/unfold a collapsible callout that was re-hydrated from the
   *  render cache.
   *
   *  Exactly the 0.246.0 code-block-copy problem again: note bodies are
   *  restored from cached HTML, which reproduces the callout's markup —
   *  `is-collapsible`, the fold chevron, the title — but NOT the click handler
   *  Obsidian attaches when it renders a callout live. So the chevron looked
   *  real and did nothing, and the same callout folded fine in Obsidian's own
   *  editor.
   *
   *  Toggling the class is enough: `is-collapsed` is what Obsidian's own CSS
   *  keys the hidden content off, so this drives the same state its handler
   *  would rather than reimplementing the animation.
   *
   *  Returns true when it handled the click, so callers stop there instead of
   *  also selecting or navigating the row. */
  /** Fold state the USER chose, per note, so a re-render doesn't undo it.
   *
   *  Bodies are rebuilt from cached HTML, which carries the state the note was
   *  AUTHORED in — so before this, expanding a preview and then getting any
   *  re-render snapped it shut again. That was survivable while renders were
   *  rare; at the 700ms storm cadence it closes under you while you read.
   *
   *  In-memory and per-view on purpose: this is "what I'm looking at right
   *  now", not a document property, and writing it to the note would mean a
   *  vault write per fold — which is itself a change event feeding the storm.
   *  Capped so a long session over a big folder can't grow it without bound. */
  private calloutFold = new Map<StashpadId, Map<string, boolean>>();
  private static readonly CALLOUT_FOLD_MAX = 200;

  /** Identify a callout within its body.
   *
   *  Position alone breaks when the note is edited above the callout, and the
   *  title alone breaks when a note holds two previews of the same page — so
   *  both, and a miss simply falls back to the authored state rather than
   *  applying the wrong callout's fold. Safe failure is the point: the worst
   *  case is today's behaviour. */
  private calloutKey(callout: HTMLElement, idx: number): string {
    const title = (callout.querySelector(":scope > .callout-title .callout-title-inner")
      ?.textContent ?? "").trim().slice(0, 80);
    return `${idx}:${title}`;
  }

  /** Drive one callout's collapsed state.
   *
   *  0.266.2: the class alone is not enough for a callout authored collapsed.
   *  Obsidian's renderer writes an INLINE `display: none` onto the content of a
   *  `[!info]-` callout, on top of `is-collapsed`, and an inline style outranks
   *  any stylesheet — so toggling only the class removed `is-collapsed`,
   *  rotated the chevron, and left the body hidden. A `[!info]+` callout
   *  carries no inline style, which is why the 0.265.2 toggle tested clean:
   *  previews had just moved to `+`, so the shape under test was the new one
   *  while every note enriched at 0.264.0 was the old one.
   *
   *  Clearing the inline value (rather than setting `display: block`) leaves
   *  the class plus the stylesheet as the single source of truth, so this can't
   *  fight Obsidian's own rules or hardcode the wrong display type. */
  private setCalloutCollapsed(callout: HTMLElement, collapsed: boolean): void {
    callout.toggleClass("is-collapsed", collapsed);
    const content = callout.querySelector(":scope > .callout-content") as HTMLElement | null;
    if (!content) return;
    // Collapsing needs no inline style — `is-collapsed` plus this plugin's own
    // stylesheet already hides the content. The ONLY thing an inline value is
    // needed for is CLEARING Obsidian's, so that is all this does.
    //
    // 0.266.8: it used to also assign `display: none` when collapsing, which
    // was redundant and tripped the community-store rule against setting
    // styles directly. Removing the property is not an assignment, and there
    // is no class that can beat an inline style, so this is the minimum
    // intervention that still works.
    if (!collapsed) content.style.removeProperty("display");
  }

  /** Re-apply remembered fold state after a body is (re-)hydrated. Runs beside
   *  applySpoilers, which exists for the same reason: cached HTML restores
   *  markup, not the state the user put it in. */
  private applyCalloutFold(root: HTMLElement, id: StashpadId | null): void {
    if (!id) return;
    const saved = this.calloutFold.get(id);
    if (!saved?.size) return;
    const cals = Array.from(root.querySelectorAll<HTMLElement>(".callout"));
    cals.forEach((cal, i) => {
      const want = saved.get(this.calloutKey(cal, i));
      if (want !== undefined) this.setCalloutCollapsed(cal, want);
    });
  }

  private rememberCalloutFold(callout: HTMLElement, collapsed: boolean, id: StashpadId): void {
    const body = callout.closest(
      ".stashpad-note-text, .stashpad-focused-body, .stashpad-detail-body",
    ) as HTMLElement | null;
    if (!body || !id) return;
    const idx = Array.from(body.querySelectorAll<HTMLElement>(".callout")).indexOf(callout);
    if (idx < 0) return;
    let saved = this.calloutFold.get(id);
    if (!saved) {
      if (this.calloutFold.size >= StashpadView.CALLOUT_FOLD_MAX) {
        const oldest = this.calloutFold.keys().next().value;
        if (oldest !== undefined) this.calloutFold.delete(oldest);
      }
      saved = new Map();
      this.calloutFold.set(id, saved);
    }
    saved.set(this.calloutKey(callout, idx), collapsed);
  }

  private maybeToggleCallout(e: MouseEvent, ownerId: StashpadId): boolean {
    const el = e.target as HTMLElement | null;
    // 0.265.2: only the CHEVRON folds, not the whole title.
    //
    // Obsidian folds on a title click because nothing else competes for it. In
    // a Stashpad row, double-click enters the note — so folding on the title
    // meant a double-click folded, unfolded, and navigated, which reads as a
    // flicker. `stopPropagation` on the click doesn't help: `dblclick` is a
    // separate event and fires anyway.
    //
    // Restricting to the chevron removes the conflict outright rather than
    // arbitrating it with a timer, which would have put a delay on every fold
    // to serve the rarer gesture. The chevron's hit area is enlarged in CSS so
    // it stays tappable on a phone.
    const fold = el?.closest?.(".callout-fold") as HTMLElement | null;
    if (!fold) return false;
    const callout = fold.closest(".callout") as HTMLElement | null;
    if (!callout || !callout.classList.contains("is-collapsible")) return false;
    e.preventDefault();
    e.stopPropagation();
    const collapsed = !callout.classList.contains("is-collapsed");
    this.setCalloutCollapsed(callout, collapsed);
    // 0.266.4: remember it, so the next render doesn't undo it.
    this.rememberCalloutFold(callout, collapsed, ownerId);
    return true;
  }

  private handleRenderedClick(e: MouseEvent, node: TreeNode): void {
    if (this.maybeToggleCallout(e, node.id)) return;
    const targetEl = e.target as HTMLElement | null;
    // 0.246.0: same delegation for the non-row surfaces (focused header, mini
    // header) — they re-hydrate cached HTML too.
    const copyBtnR = targetEl?.closest?.(".copy-code-button") as HTMLElement | null;
    if (copyBtnR) {
      e.preventDefault();
      e.stopPropagation();
      void this.copyCodeFromButton(copyBtnR);
      return;
    }
    // 0.237.0: a spoiler reveals itself and swallows the click, so revealing
    // never also navigates.
    const spoiler = targetEl?.closest?.(".stashpad-spoiler") as HTMLElement | null;
    if (spoiler && !spoiler.hasClass("is-revealed")) {
      e.preventDefault();
      e.stopPropagation();
      spoiler.addClass("is-revealed");
      return;
    }
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
    // Mobile: a tap during the keyboard-dismiss reflow only dismisses the
    // keyboard — acting on it would select whatever row slid under the finger.
    const absorbed = this.shouldAbsorbDismissTap();
    this.traceTap("click", e, idx, absorbed);
    // 0.246.0: Obsidian's own code-block copy button. The row body is
    // re-hydrated from CACHED HTML via sanitizeHTMLToDom, which reproduces the
    // button's markup but NOT the click handler Obsidian's live post-processor
    // attached — so it looked correct and did nothing. Delegating here is the
    // fix that survives the cache, and it has to run BEFORE the row handlers
    // or the same click also selects the row.
    // 0.265.1: fold a callout instead of selecting the row. Must run before the
    // row handlers for the same reason the copy button does.
    if (!absorbed && this.maybeToggleCallout(e, node.id)) return;
    const copyBtn = (e.target as HTMLElement | null)?.closest?.(".copy-code-button") as HTMLElement | null;
    if (!absorbed && copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      void this.copyCodeFromButton(copyBtn);
      return;
    }
    // 0.237.0: a spoiler inside a LIST ROW. handleRenderedClick only covers the
    // non-row surfaces (focused header, mini header), so without this a
    // spoiler was inert everywhere it actually appears.
    const spoilerEl = (e.target as HTMLElement | null)?.closest?.(".stashpad-spoiler") as HTMLElement | null;
    if (!absorbed && spoilerEl && !spoilerEl.hasClass("is-revealed")) {
      e.preventDefault();
      e.stopPropagation();
      spoilerEl.addClass("is-revealed");
      return;
    }
    // 0.237.0: first click on an obscured row REVEALS it and does nothing else.
    // Consuming the click matters: otherwise the same tap that unblurs also
    // selects or drills in, so you cannot look at a hidden note without acting
    // on it. Revealing is per-view and in-memory only.
    if (!absorbed && this.isObscured(node) && !this.isFullyRevealed(node.id)) {
      const t = e.target as HTMLElement | null;
      // Let the row's real controls through — tapping the checkbox or the ⋯
      // menu on a blurred row should still work.
      if (!t?.closest?.(".stashpad-note-task-checkbox, .stashpad-note-more, .stashpad-expand-toggle, button, a")) {
        e.preventDefault();
        e.stopPropagation();
        const rowEl = (e.currentTarget as HTMLElement | null)
          ?? this.listEl?.querySelector<HTMLElement>(`.stashpad-note[data-id="${node.id}"]`) ?? null;
        if (rowEl) this.advanceObscureReveal(node, rowEl);   // two-step: text, then media
        return;
      }
    }
    if (absorbed) {
      // Remember the note under the finger on this dismissing tap (keyboard-up
      // layout = what the user aimed at) so a double-tap that began here opens
      // THAT note, not whatever slides under the reflowed second tap. Keep the
      // earliest tap of the burst — don't let the second tap overwrite it.
      if (!this.aimedTapTargetId || Date.now() - this.aimedTapAt > StashpadView.AIMED_TAP_WINDOW_MS) {
        this.aimedTapTargetId = node.id;
        this.aimedTapAt = Date.now();
      }
      e.stopPropagation();
      return;
    }
    // Normal (settled) tap — drop any stale aimed target so it can't leak into
    // a later unrelated double-tap.
    this.aimedTapTargetId = null;
    // A real tap on a row counts as a cursor move — arm the cursor auto-expand
    // (kept off through the initial post-load render).
    this.cursorHasMoved = true;
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
    // 0.258.3: acting on a ROW hands the cursor over from the heading.
    // Without this the heading kept its is-cursor ring after you clicked a
    // note, and — worse for shift/mod-click, which ADD to the selection rather
    // than replacing it — the heading's id stayed in `selection`, so it was
    // silently counted as a target alongside its own children. The heading is
    // single-select by design (0.258.0), so it leaves the selection entirely.
    if (this.cursorOnHeading) {
      this.cursorOnHeading = false;
      const h = this.headingNode();
      if (h) {
        this.selection.delete(h.id);
        if (this.firstSelectedId === h.id) this.firstSelectedId = null;
        if (this.lastSelected === h.id) this.lastSelected = null;
      }
    }
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

  /** True when the cursor row sits within ~1.5 list-heights of the visible
   *  list area. Used at composer-blur time to decide whether the post-dismiss
   *  reveal is a reflow correction (row nearby — do it) or an unwanted jump to
   *  wherever the cursor happens to live (row far away — skip). 0.216.2. */
  private cursorRowNearViewport(): boolean {
    const list = this.listEl;
    if (!list || this.cursorIdx < 0) return false;
    const row = list.querySelector(`[data-idx="${this.cursorIdx}"]`) as HTMLElement | null;
    if (!row) return false;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const margin = lr.height * 1.5;
    return rr.bottom > lr.top - margin && rr.top < lr.bottom + margin;
  }

  /** 0.216.4: hold the list exactly where it is across a render.
   *
   *  render()'s default policy is ANCHOR-based (re-scroll so the same row sits
   *  at the same visual offset), which is right when CONTENT changed. It is
   *  wrong for an in-place ATTRIBUTE change — select mode, a color, a task
   *  checkbox — because those alter row chrome, so the anchor row lands at a
   *  slightly different offset and the list creeps. Measured: ~130px UP per
   *  color change / task toggle, and the same on the select toggle.
   *
   *  Call BEFORE the mutation, invoke the returned function right after
   *  this.render().
   *
   *  Two things this gets right that a naive scrollTop save/restore does not:
   *  - render() RECREATES this.listEl, so the restore reads the element FRESH
   *    each time. Capturing the node up front writes to a detached element and
   *    silently no-ops.
   *  - AT THE BOTTOM, restoring a fixed pixel is wrong: lazy note bodies keep
   *    growing scrollHeight for a few hundred ms afterwards, so the saved
   *    offset stops being the bottom and the list visibly settles backwards
   *    (the "jiggle"). When we started at the bottom we re-pin to the bottom
   *    instead, which absorbs that growth smoothly. */
  /** 0.218.1: record what actually moves the list, ON THE DEVICE.
   *
   *  Emulation has now reported 0px movement four times while the phone still
   *  showed the list shifting, so the remaining work cannot be done here.
   *  This samples scrollTop + scrollHeight every frame for ~2s after an action
   *  and writes the result into the existing debug-trace ring buffer (local
   *  only, copied out from Settings -> Diagnostics), so a real device can say
   *  which write lands last and whether the content height is still growing.
   *
   *  Zero cost when debugTrace is off — trace() checks the flag, and the rAF
   *  loop never starts. */
  private traceScroll(label: string): void {
    if (!this.plugin.settings.debugTrace) return;
    const list = this.listEl;
    if (!list) return;
    const t0 = performance.now();
    const start = { top: list.scrollTop, h: list.scrollHeight, c: list.clientHeight };
    let lastTop = start.top, lastH = start.h;
    // 0.218.2: the frame sampler says the list moved, not WHO moved it. Trap
    // assignments to scrollTop on this element and record the caller, so a big
    // jump names its own culprit instead of being guessed at. Instance-level
    // override of the native accessor; removed when the window closes.
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    let trapped = false;
    if (desc?.get && desc?.set) {
      try {
        Object.defineProperty(list, "scrollTop", {
          configurable: true,
          get(this: HTMLElement) { return desc.get!.call(this) as number; },
          set(this: HTMLElement, v: number) {
            const prev = desc.get!.call(this) as number;
            // Only interesting when it actually moves, and only for real jumps.
            if (Math.abs(v - prev) > 8) {
              const where = (new Error().stack ?? "").split("\n").slice(2, 5)
                .map((l) => l.trim().replace(/^at\s+/, "").replace(/\s*\(.*$/, "")).join(" < ");
              (this as unknown as { __spTrace?: (c: string, d: Record<string, unknown>) => void });
              plugin.trace("scroll:set", { at: label, ms: Math.round(performance.now() - t0), from: Math.round(prev), to: Math.round(v), by: where.slice(0, 120) });
            }
            desc.set!.call(this, v);
          },
        });
        trapped = true;
      } catch { /* accessor override refused — the frame sampler still works */ }
    }
    const plugin = this.plugin;
    const untrap = (): void => {
      if (!trapped) return;
      trapped = false;
      try { delete (list as unknown as Record<string, unknown>).scrollTop; } catch { /* ignore */ }
    };
    const tick = (): void => {
      const el = this.listEl;
      if (!el || !el.isConnected) return;
      const dt = performance.now() - t0;
      // Log only CHANGES, so the buffer holds signal rather than 120 identical
      // frames — the timestamps still show when each change landed.
      if (el.scrollTop !== lastTop || el.scrollHeight !== lastH) {
        this.plugin.trace("scroll", {
          at: label,
          ms: Math.round(dt),
          top: Math.round(el.scrollTop),
          dTop: Math.round(el.scrollTop - start.top),
          h: el.scrollHeight,
          dH: el.scrollHeight - start.h,
        });
        lastTop = el.scrollTop;
        lastH = el.scrollHeight;
      }
      if (dt < 2000) requestAnimationFrame(tick);
      else untrap();
    };
    this.plugin.trace("scroll:start", { at: label, top: Math.round(start.top), h: start.h, c: start.c });
    requestAnimationFrame(tick);
  }

  private holdListScroll(): () => void {
    const list = this.listEl;
    const top = list?.scrollTop ?? 0;
    const atBottom = !!list && (list.scrollTop + list.clientHeight >= list.scrollHeight - 2);
    return () => {
      const apply = (): void => {
        const el = this.listEl;
        if (!el) return;
        el.scrollTop = atBottom ? el.scrollHeight - el.clientHeight : top;
      };
      apply();
      requestAnimationFrame(apply);
      window.setTimeout(apply, 60);
      // Lazy bodies can still resize rows for a while; a late pass keeps both
      // the pinned-bottom and the fixed-offset cases stable through it.
      window.setTimeout(apply, 220);
      window.setTimeout(apply, 500);
    };
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
        const comp = this.viewRoot?.querySelector(".stashpad-composer");
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

  /** Mobile only. True if a row tap should be absorbed (dismiss-the-keyboard
   *  only, no select/open). When the soft keyboard dismisses, Obsidian regrows
   *  the leaf by the keyboard height a beat later; the list stays pinned to the
   *  bottom, so existing rows slide DOWN under a stationary finger (measured:
   *  ~336px over ~120ms). A tap that lands during that reflow — including the
   *  second tap of a quick double-tap that began while the keyboard was up —
   *  opens whatever row slid under the finger, not the one the user aimed at.
   *  So while the list height is still settling we treat the tap as a pure
   *  keyboard-dismiss and let the user re-aim on the stable list (which is the
   *  manual workaround, now automatic). */
  private shouldAbsorbDismissTap(): boolean {
    return Platform.isMobile && Date.now() < this.tapSettleUntil;
  }

  /** Diagnostics: record the tap's coordinate picture so a tap-vs-row offset
   *  can be measured from a real device. No-op (and no layout reads) unless
   *  debugTrace is on. */
  private traceTap(type: string, e: MouseEvent, idx: number, absorbed: boolean): void {
    if (!this.plugin.settings.debugTrace || !this.listEl) return;
    const list = this.listEl;
    const vv = window.visualViewport;
    const dRect = list.querySelector<HTMLElement>(`.stashpad-note[data-idx="${idx}"]`)?.getBoundingClientRect();
    this.plugin.trace(`tap:${type}`, {
      absorbed,
      clientY: Math.round(e.clientY), clientX: Math.round(e.clientX),
      idx, rowTop: dRect ? Math.round(dRect.top) : null,
      listTop: Math.round(list.getBoundingClientRect().top),
      listScrollTop: Math.round(list.scrollTop),
      listScrollH: Math.round(list.scrollHeight),
      listClientH: Math.round(list.clientHeight),
      innerH: window.innerHeight,
      vvHeight: vv ? Math.round(vv.height) : null,
      vvOffsetTop: vv ? Math.round(vv.offsetTop) : null,
      tapSettleInMs: Math.max(0, this.tapSettleUntil - Date.now()),
      kbOpen: document.body.classList.contains("stashpad-keyboard-open"),
    });
  }

  // --- Document-level keyboard ---

  /** The window the keydown listener is bound to — the leaf's own (popout-aware).
   *  Defaults to the main window; set in onOpen. 0.140.17 */
  private keydownWindow: Window = window;
  /** Last render-relevant settings signature this view acted on. Empty until the
   *  first broadcast, so the first one always renders. 0.268.13 */
  private settingsRenderSig = "";
  /** 0.271.5: temporary per-view attachment-rail layout, set by the rail's
   *  flipper. null = follow the global `attachmentRailMode` setting. In-memory,
   *  so it resets on reload — the flipper is a quick "show me this differently
   *  right now", not a persisted preference. */
  private railModeOverride: RailMode | null = null;
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

    // 0.239.0: "Focus the list" must fire FROM an input — leaving the composer
    // is its entire job, so it belongs ABOVE the inInput guard rather than
    // below it with the list-mutating shortcuts. It sat below, which meant the
    // one situation it exists for was the one situation it was discarded in.
    // Safe here because it only moves focus; it mutates nothing.
    if (matchBinding(e, b.focusList)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdFocusList(); return; }

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
    if (matchBinding(e, b.toggleObscured)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdToggleObscured(); return; }
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
    // 0.258.0: the pinned heading is a stop in the cursor order, sitting ABOVE
    // index 0 — which is where it sits on screen. Shift-arrow deliberately does
    // NOT extend a range onto or off it: a selection spanning a note AND its
    // own children is not a coherent target for move/delete/clone, so the
    // heading is a single-select stop (see 0.258.0 design decision).
    const heading = this.headingNode();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.cursorOnHeading) {
        this.cursorOnHeading = false;
        this.cursorIdx = 0;
      } else if (this.cursorIdx >= this.currentChildren.length - 1) {
        // Past the last child: onto the heading if there is one, else wrap.
        if (heading) { this.cursorOnHeading = true; this.selectHeadingCursor(); return; }
        this.cursorIdx = 0;
      } else this.cursorIdx++;
      this.selectCursor(e.shiftKey); return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.cursorOnHeading) {
        // Off the top of the heading wraps to the last child.
        this.cursorOnHeading = false;
        this.cursorIdx = this.currentChildren.length - 1;
      } else if (this.cursorIdx <= 0) {
        if (heading) { this.cursorOnHeading = true; this.selectHeadingCursor(); return; }
        this.cursorIdx = this.currentChildren.length - 1;
      } else this.cursorIdx--;
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
    if (matchBinding(e, sb.pasteNotes) && (this.plugin.noteClipboard || hasXvPayload())) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdPasteNotes(); return; }
    // openAllTasks (default Shift+T) is global — no selection/cursor needed — AND
    // must be checked BEFORE openTab (plain "T"): a plain-letter binding also fires
    // on its shifted form (matchKey ignores Shift, the shifted-key trap), so if
    // "T" ran first it would swallow Shift+T. Checking here (above the gated block
    // that holds openTab) fixes both.
    if (matchBinding(e, sb.openAllTasks)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void openAggregateView(this.plugin, "tasks"); return; }
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
      // 0.214.0: explicit cross-vault copy/cut. No default chord (both are
      // deliberate, occasional actions) — bindable in settings if wanted.
      if (matchBinding(e, sb.copyForOtherVault)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyForOtherVault(); return; }
      if (matchBinding(e, sb.cutForOtherVault)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCutForOtherVault(); return; }
      if (matchBinding(e, sb.copyTree)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyTree(); return; }
      if (matchBinding(e, sb.copyLink)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdCopyStashpadLink(); return; }
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
      // editParent (Shift+E) is checked BEFORE edit (E): a plain-letter binding also
      // fires on its shifted form (matchKey ignores Shift), so Shift+E must consume
      // the event first or "E" would swallow it. (The shifted-key trap.)
      if (matchBinding(e, sb.editParent)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdEditParent(); return; }
      if (matchBinding(e, sb.edit)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdEdit(); return; }
      if (matchBinding(e, sb.clone)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdClone(); return; }
      if (matchBinding(e, sb.forkNote)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdForkNote(); return; }
      if (matchBinding(e, sb.insertTemplate)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdInsertTemplate(); return; }
      if (matchBinding(e, sb.toggleExpand)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdToggleExpand(); return; }
      if (matchBinding(e, sb.expandAll)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdExpandAll(); return; }
      if (matchBinding(e, sb.collapseAll)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.cmdCollapseAll(); return; }
      if (matchBinding(e, sb.togglePin)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdTogglePin(); return; }
      if (matchBinding(e, sb.listPin)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdToggleListPin("top"); return; }
      if (matchBinding(e, sb.listPinBottom)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void this.cmdToggleListPin("bottom"); return; }
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

  /** 0.258.0: land the cursor on the pinned heading and select just it.
   *  Always single-select — a range containing a note and its own children
   *  isn't a coherent target set, so the heading never joins one. */
  private selectHeadingCursor(): void {
    const h = this.headingNode();
    if (!h) { this.cursorOnHeading = false; return; }
    this.cursorHasMoved = true;
    this.cursorIdx = -1;
    this.selection.clear();
    this.selection.add(h.id);
    this.firstSelectedId = h.id;
    this.lastSelected = h.id;
    // Same cheap path the note rows use — a full render() here would rebuild
    // every row just to flip two classes (the 0.73.4 lesson).
    this.repaintSelectionClasses();
    this.stampSelectedCursor();
    this.plugin.notifyStashpadSelectionChanged();
    // 0.258.2: deliberately does NOT scroll. An earlier version yanked the list
    // to the top so the cursor would be "visible" — pointless, because the
    // heading is sticky and therefore always on screen, and destructive,
    // because it threw away the user's scroll position every time the cursor
    // touched the heading. Landing on a pinned row should move nothing.
  }

  private selectCursor(shift: boolean): void {
    // Moving onto a child always leaves the heading.
    this.cursorOnHeading = false;
    const node = this.currentChildren[this.cursorIdx];
    if (!node) return;
    // First real cursor move since load — arm the cursor auto-expand (so the
    // initial render stayed fully collapsed).
    this.cursorHasMoved = true;
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
  /** 0.218.0: repaint COLOUR on the existing rows, touching no structure.
   *
   *  A color is a pure visual attribute — a class plus CSS custom properties
   *  on the row, its grip and its children-count arrow. Rebuilding 120 rows to
   *  change one of them was both wasteful and the direct cause of the list
   *  moving (the rebuild destroys the rows, so the scroll position has to be
   *  reconstructed afterwards, and it lands slightly off). Nothing is destroyed
   *  here, so there is nothing to restore: the list cannot move.
   *
   *  Repaints EVERY visible row, not just the changed one, because color is
   *  inherited: a colored note paints a depth-faded side stripe on its
   *  descendants, so changing one note's color changes its whole subtree's
   *  appearance. Walking the visible rows is still trivially cheaper than a
   *  rebuild — no element creation, no markdown re-render, no layout thrash.
   *
   *  Mirrors the color half of renderRow; if that gains a new color-driven
   *  element, add it here too. */
  /** 0.218.0: repaint every in-place ATTRIBUTE on the live rows — color,
   *  completed, missed, selection — without touching structure.
   *
   *  The general form of the targeted repaints: the metadata hook calls this for
   *  any frontmatter-only change, so a color set from anywhere (command, menu,
   *  undo, another window, sync) updates without the list being rebuilt under
   *  the user.
   *
   *  Returns FALSE when it finds a change it cannot express as an attribute —
   *  specifically a row whose checkbox needs to appear or disappear, which is
   *  element creation, not a class toggle. The caller then falls back to a full
   *  render, so a note becoming a task stays correct; it just costs the rebuild
   *  it genuinely needs. */
  private repaintRowAttributes(): boolean {
    const list = this.listEl;
    if (!list) return false;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".stashpad-note"));
    // Structural pre-check FIRST, before mutating anything, so a fallback render
    // never lands on half-updated rows.
    for (const row of rows) {
      const node = this.tree.get((row.dataset.id ?? "") as StashpadId);
      if (!node) return false;
      const wantsCheckbox = this.isTask(node) || this.compactMode;
      if (wantsCheckbox !== !!row.querySelector(".stashpad-note-task-checkbox")) return false;
    }
    this.repaintRowColors();
    this.repaintSelectionClasses();
    for (const row of rows) {
      const node = this.tree.get((row.dataset.id ?? "") as StashpadId);
      if (!node) continue;
      const cb = row.querySelector<HTMLElement>(".stashpad-note-task-checkbox");
      if (cb) {
        const done = this.isCompleted(node);
        cb.empty();
        setIcon(cb, done ? "check-square" : "square");
        cb.title = done ? "Mark not done" : "Mark done";
        row.classList.toggle("is-completed", done);
      }
      row.classList.toggle("is-missed", this.isMissed(node));
    }
    return true;
  }

  private repaintRowColors(): void {
    const list = this.listEl;
    if (!list) return;
    for (const row of Array.from(list.querySelectorAll<HTMLElement>(".stashpad-note"))) {
      const id = row.dataset.id ?? "";
      const node = this.tree.get(id as StashpadId);
      if (!node) continue;
      const color = this.colorForNode(node);

      row.classList.toggle("has-color", !!color);
      if (color) row.style.setProperty("--stashpad-note-color", color);
      else row.style.removeProperty("--stashpad-note-color");

      // Inherited stripe: only when the note has no color of its own.
      const inherited = color ? null : this.inheritedColorForNode(node);
      const showInherited = !!inherited && inherited.depth > 0;
      row.classList.toggle("has-inherited-color", showInherited);
      if (showInherited && inherited) {
        row.style.setProperty("--stashpad-inherited-color", inherited.hex);
        row.style.setProperty("--stashpad-inherited-depth", String(inherited.depth));
      } else {
        row.style.removeProperty("--stashpad-inherited-color");
        row.style.removeProperty("--stashpad-inherited-depth");
      }

      const grip = row.querySelector<HTMLElement>(".stashpad-note-grip");
      if (grip) {
        grip.classList.toggle("has-color", !!color);
        if (color) grip.style.setProperty("--stashpad-note-color", color);
        else grip.style.removeProperty("--stashpad-note-color");
        const draggable = grip.draggable;
        grip.title = draggable
          ? (color ? "Drag to reorder · right-click to change color" : "Drag to reorder")
          : (color ? "Right-click to change color · drag disabled in this view mode" : "Drag disabled in this view mode");
      }

      const enter = row.querySelector<HTMLElement>(".stashpad-note-enter");
      if (enter) {
        if (color) enter.style.color = color;
        else enter.style.removeProperty("color");
      }
    }
  }

  /** 0.218.0: repaint COMPLETED (checked / unchecked) in place.
   *
   *  Only valid when the checkbox already exists — see cmdToggleTask, where
   *  making a note a task CREATES the checkbox and is therefore structural.
   *  Returns false when the fast path does not apply, so the caller can fall
   *  back to a full render rather than silently leaving a stale row. */
  private repaintCompletedState(ids: StashpadId[]): boolean {
    const list = this.listEl;
    if (!list) return false;
    const targets: { row: HTMLElement; node: TreeNode; cb: HTMLElement }[] = [];
    for (const id of ids) {
      const row = list.querySelector<HTMLElement>(`.stashpad-note[data-id="${CSS.escape(id)}"]`);
      const node = this.tree.get(id);
      const cb = row?.querySelector<HTMLElement>(".stashpad-note-task-checkbox");
      // Row off-screen / not rendered, or no checkbox to update → not our case.
      if (!row || !node || !cb) return false;
      targets.push({ row, node, cb });
    }
    for (const { row, node, cb } of targets) {
      const done = this.isCompleted(node);
      cb.empty();
      setIcon(cb, done ? "check-square" : "square");
      cb.title = done ? "Mark not done" : "Mark done";
      row.classList.toggle("is-completed", done);
    }
    return true;
  }

  private repaintSelectionClasses(): void {
    if (!this.listEl) return;
    // 0.258.0: the heading row participates in the fast class-toggle path too.
    // It is not a `.stashpad-note`, so the row loop below skips it — without
    // this it kept a stale is-cursor/is-selected after the cursor moved away,
    // since arrow-key nav deliberately avoids a full render().
    const headingEl = this.listEl.querySelector<HTMLElement>(".stashpad-focused.is-heading-row");
    if (headingEl) {
      const hid = headingEl.dataset.headingId ?? "";
      headingEl.classList.toggle("is-cursor", this.cursorOnHeading);
      headingEl.classList.toggle("is-selected", this.selection.has(hid));
    }
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
      // 0.118.10: respect a manual-collapse override; clear it once the cursor
      // leaves the row so the auto-expand resumes on the next visit.
      if (!isCursor) this.cursorExpandOverride.delete(id);
      row.classList.toggle("is-cursor-expanded", autoExpand && isCursor && this.cursorHasMoved && !this.cursorExpandOverride.has(id));
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

  /** Reset state that only makes sense within one focus level, whenever the
   *  level actually changed. Called from both paint entry points. */
  private syncLevelScopedState(): void {
    if (this.renderedFocusId === this.focusId) return;
    const first = this.renderedFocusId === null;
    this.renderedFocusId = this.focusId;
    if (first) return; // the initial paint isn't a level CHANGE
    // The heading is about to be a DIFFERENT note; a cursor parked on it must
    // not carry over and silently target the new one.
    this.cursorOnHeading = false;
    // 0.258.3 (pre-existing): changing level already cleared the SELECTION but
    // left mobile select mode switched ON, so you arrived at the new level in a
    // mode with nothing selected — the actions button acted on nothing and the
    // only way out was to hunt down the toggle. Select mode is per-level.
    if (this.mobileSelectMode) {
      this.mobileSelectMode = false;
      this.firstSelectedId = null;
      this.refreshMobileActionsCluster();
    }
  }

  /** 0.258.0: the note rendered as the pinned heading row, or null when this
   *  view isn't showing one (tiny / compact mode, or a focused node with no
   *  file). Single source of truth for "is there a heading to land on". */
  headingNode(): TreeNode | null {
    if (this.tinyMode || this.compactMode) return null;
    const focused = this.tree.get(this.focusId) ?? this.tree.getRoot();
    return focused?.file ? focused : null;
  }

  /** public: called by AuthorshipTracker (the host interface). */
  getActionTargets(): TreeNode[] {
    // 0.258.0: cursor-on-heading resolves to the heading note. Checked before
    // the selection branch is skipped, but AFTER it — an explicit selection
    // still wins, exactly as it does for a cursor sitting on a child row.
    if (this.selection.size > 0) {
      const targets = [...this.selection].map((id) => this.tree.get(id)).filter((n): n is TreeNode => !!n && !!n.file);
      // 0.199.1: return targets in LIST order, not click order. `selection` is
      // a Set, so its iteration order is the order notes were selected — which
      // made a multi-select copy paste out of chronological/visual order when
      // the user clicked rows bottom-up or cherry-picked. Rank by a DFS over
      // the current display list (covers nested expansions + sort modes);
      // anything not currently displayed sinks to the end, keeping its
      // selection order among peers (sort is stable).
      const order = new Map<string, number>();
      let i = 0;
      const walk = (n: TreeNode): void => {
        if (order.has(n.id)) return;
        order.set(n.id, i++);
        for (const c of this.tree.getChildren(n.id)) walk(c);
      };
      for (const top of this.currentChildren) walk(top);
      const pos = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER;
      return targets.sort((a, b) => pos(a.id) - pos(b.id));
    }
    if (this.cursorOnHeading) {
      const h = this.headingNode();
      if (h) return [h];
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
  /** Lock (encrypt) the selection AND hide each note's filename, regardless of
   *  the folder's encrypt-filenames pref. Backs the "hide filename" command. */
  cmdLockSelectionHideName(): Promise<void> { return this.cmdLockSelection({ hideName: true }); }

  async cmdLockSelection(opts: { hideName?: boolean } = {}): Promise<void> {
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice("Set up encryption first (Settings → Stashpad → Encryption).");
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
      // 0.210.1: visited-set guarded. A parent cycle in the index (see
      // TreeIndex.wouldCycle) used to make this spin forever and hang Obsidian on
      // the next delete / lock / copy / clone. Bail out treating it as "not a
      // root" rather than looping.
      const seenAnc = new Set<StashpadId>();
      while (p) { if (ids.has(p)) return false; if (seenAnc.has(p)) return false; seenAnc.add(p); p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) { new Notice("Nothing to lock (already locked)."); return; }
    let locked = 0;
    const lockedItems: Array<{ rootId: StashpadId; prevSibling: StashpadId | null; blob: string }> = [];
    for (const t of roots) {
      // Capture the preceding sibling in any explicit manual order, so unlock can
      // drop the note back into the same slot (mirrors the context-menu handler).
      const order = this.order.getOrder(this.noteFolder, t.parent ?? ROOT_ID);
      const idx = order.indexOf(t.id);
      const prevSibling = idx > 0 ? order[idx - 1] : null;
      // Silent per-item; one summary toast below (a batch shouldn't spam).
      const r = await this.plugin.lockNoteSubtree(this.noteFolder, t.id, prevSibling, { silent: true, hideTitle: opts.hideName });
      if (r) { locked++; lockedItems.push({ rootId: t.id, prevSibling, blob: r.blobPath }); await this.log.append({ type: "lock", id: t.id }); }
    }
    if (locked > 0) {
      this.selection.clear();
      this.lastSelected = null;
      this.render();
      // Undo = unlock (decrypt) the just-locked bundles; redo = re-lock. A
      // re-lock mints a NEW blob path, so update each item's blob for the next undo.
      const folder = this.noteFolder;
      this.plugin.getUndoStack(folder).push({
        label: `Lock ${locked} stash${locked === 1 ? "" : "es"}`,
        undo: async () => { for (const it of lockedItems) { try { await this.plugin.unlockBundleAt(it.blob, { silent: true }); } catch { /* leave the rest */ } } this.render(); },
        redo: async () => { for (const it of lockedItems) { const rr = await this.plugin.lockNoteSubtree(folder, it.rootId, it.prevSibling, { silent: true, hideTitle: opts.hideName }); if (rr) it.blob = rr.blobPath; } this.render(); },
      });
      this.plugin.notifications.show({ message: `Locked ${locked} stash${locked === 1 ? "" : "es"} — undo to unlock.`, kind: "success", category: "system", folder: this.noteFolder, actions: [{ label: "All encrypted", onClick: () => void openAggregateView(this.plugin, "encrypted") }] });
    }
  }

  /** 0.136.0: move the selected note(s) into THIS folder's own `archive/`
   *  subfolder (plaintext unless the folder's "Encrypt archived notes" is on). */
  async cmdMoveToArchive(): Promise<void> {
    const targets = this.getActionTargets();
    if (targets.length === 0) return;
    const cur = (this.noteFolder ?? "").replace(/\/+$/, "");
    // 0.136.0 (per-folder archive): archiving ALWAYS targets this folder's own
    // `archive/` subfolder — no picker, no default-archive setting, no separate
    // dedicated archive folders.
    if (isArchiveSubfolderPath(cur)) {
      new Notice("These notes are already in an archive.", 6000);
      return;
    }
    void this.archiveSources(targets, archiveSubfolderOf(cur));
  }

  /** 0.98.34 (Phase 4): archive the given notes into `dest` — encrypt each root's
   *  subtree with the BLOB written into the archive folder (so the 🔒 stub appears
   *  there) while reading + deleting the plaintext from THIS source folder. Pushes
   *  ONE undo entry that restores them to the source folder (Ctrl+Z). Clicking the
   *  stub's Unlock later restores in the archive folder, as before. No file move +
   *  no async hook, so undo is a clean self-contained reversal. */
  private async archiveSources(sources: TreeNode[], dest: string): Promise<void> {
    const src = this.noteFolder;
    const cleanDest = dest.replace(/\/+$/, "");
    // 0.136.0: dest is `<parent>/archive` — the encrypt-or-not pref lives on the
    // PARENT folder (folderEncPrefs[parent].archiveEncryptContent, plaintext
    // default via the shared B1 resolver).
    const parentFolder = cleanDest.replace(/\/archive$/, "");
    const encryptDest = this.plugin.archiveEncryptFor(parentFolder);
    // The subfolder may not exist yet — create it before any move/blob write.
    try { if (!(await this.app.vault.adapter.exists(cleanDest))) await this.app.vault.createFolder(cleanDest); } catch { /* race / exists */ }
    if (!encryptDest) {
      // Plaintext archive (encryption off): MOVE the subtree's files into the
      // destination (de-indexed via the archive flag, but not encrypted). Stashpad's
      // re-home listener reparents the moved roots in the destination folder.
      const ids0 = new Set(sources.map((t) => t.id));
      const roots0 = sources.filter((t) => { let p = t.parent; while (p) { if (ids0.has(p)) return false; p = this.tree.get(p)?.parent ?? null; } return true; });
      if (roots0.length === 0) return;
      const files: TFile[] = [];
      const seen0 = new Set<string>();
      const walk0 = (n: TreeNode) => { if (seen0.has(n.id)) return; seen0.add(n.id); if (n.file) files.push(n.file); for (const c of this.tree.getChildren(n.id)) walk0(c); };
      for (const r of roots0) walk0(r);
      const moves: Array<{ from: string; to: string }> = [];
      for (const f of files) {
        const fromPath = f.path;
        const name = f.name; const dot = name.lastIndexOf("."); const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : "";
        let to = `${cleanDest}/${name}`;
        for (let n = 1; await this.app.vault.adapter.exists(to); n++) to = `${cleanDest}/${stem}-${n}${ext}`;
        try { await this.app.fileManager.renameFile(f, to); moves.push({ from: fromPath, to }); } catch (e) { console.warn("[Stashpad] plaintext archive move failed", fromPath, e); }
      }
      this.selection.clear(); this.lastSelected = null; this.tree.rebuild(src); this.render();
      if (moves.length > 0) for (const rt of roots0) await this.log.append({ type: "archive", id: rt.id, payload: { to: cleanDest, encrypted: false } });
      const nm = cleanDest.split("/").pop() || cleanDest;
      this.plugin.notifications.show({ message: `Moved ${moves.length} note${moves.length === 1 ? "" : "s"} → plaintext archive “${nm}” (de-indexed, not encrypted). Undo to bring ${moves.length === 1 ? "it" : "them"} back.`, kind: "success", category: "system", folder: src, actions: [{ label: "All archived", onClick: () => void openAggregateView(this.plugin, "archived") }] });
      this.plugin.getUndoStack(src).push({
        label: `Archive (plaintext, ${roots0.length})`,
        undo: async () => { for (const m of moves) { const fl = this.app.vault.getAbstractFileByPath(m.to); if (fl instanceof TFile) { try { await this.app.fileManager.renameFile(fl, m.from); } catch (e) { console.warn("[Stashpad] plaintext archive undo failed", m.to, e); } } } this.tree.rebuild(src); this.render(); },
        // 0.140.9: re-apply the archive move on redo. Without a redo the entry
        // was undo-only — Cmd+Shift+Z would "succeed" without re-archiving, then
        // the next Cmd+Z ran the restore against already-restored paths.
        redo: async () => { for (const m of moves) { const fl = this.app.vault.getAbstractFileByPath(m.from); if (fl instanceof TFile) { try { await this.app.fileManager.renameFile(fl, m.to); } catch (e) { console.warn("[Stashpad] plaintext archive redo failed", m.from, e); } } } this.tree.rebuild(src); this.render(); },
      });
      return;
    }
    if (!this.plugin.encryption?.isConfigured?.()) {
      new Notice(`Archiving here encrypts the notes ("Encrypt archived notes" is on for “${parentFolder.split("/").pop()}”), but encryption isn't set up yet (Settings → Stashpad → Encryption). Set it up — or turn that toggle off for a plaintext archive.`, 9000);
      return;
    }
    const ids = new Set(sources.map((t) => t.id));
    const roots = sources.filter((t) => {
      let p = t.parent;
      // 0.210.1: visited-set guarded. A parent cycle in the index (see
      // TreeIndex.wouldCycle) used to make this spin forever and hang Obsidian on
      // the next delete / lock / copy / clone. Bail out treating it as "not a
      // root" rather than looping.
      const seenAnc = new Set<StashpadId>();
      while (p) { if (ids.has(p)) return false; if (seenAnc.has(p)) return false; seenAnc.add(p); p = this.tree.get(p)?.parent ?? null; }
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
      if (r) { blobs.push(r.blobPath); await this.log.append({ type: "archive", id: t.id, payload: { to: dest, encrypted: true } }); }
    }
    if (blobs.length === 0) return;
    this.selection.clear(); this.lastSelected = null; this.tree.rebuild(src); this.render();
    const name = dest.split("/").pop() || dest;
    this.plugin.notifications.show({ message: `Archived ${blobs.length} note${blobs.length === 1 ? "" : "s"} → “${name}”. Undo to bring ${blobs.length === 1 ? "it" : "them"} back.`, kind: "success", category: "system", folder: src, actions: [{ label: "All archived", onClick: () => void openAggregateView(this.plugin, "archived") }] });
    this.plugin.getUndoStack(src).push({
      label: `Archive (${blobs.length})`,
      undo: async () => {
        // Restore the blobs back to the SOURCE folder (not the archive folder).
        // 0.140.2: only DROP the ones that actually restored — if a restore
        // failed (key prompt declined, error), keep it in `blobs` so undo can be
        // retried and redo doesn't rebuild from a phantom-empty state.
        const failed: string[] = [];
        for (const b of blobs) {
          try { if (!(await this.plugin.unlockBundleAt(b, { silent: true, destFolder: src }))) failed.push(b); }
          catch (e) { failed.push(b); console.warn("[Stashpad] archive undo failed", b, e); }
        }
        blobs = failed;
        if (failed.length) new Notice(`Undo incomplete: ${failed.length} archived item${failed.length === 1 ? "" : "s"} couldn't be restored (they're still in the archive). Try again, or restore from the Archived view.`, 8000);
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
      new Notice("Set up encryption first (Settings → Stashpad → Encryption)."); return;
    }
    const targets = this.getActionTargets();
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    const roots = targets.filter((t) => {
      let p = t.parent;
      // 0.210.1: visited-set guarded. A parent cycle in the index (see
      // TreeIndex.wouldCycle) used to make this spin forever and hang Obsidian on
      // the next delete / lock / copy / clone. Bail out treating it as "not a
      // root" rather than looping.
      const seenAnc = new Set<StashpadId>();
      while (p) { if (ids.has(p)) return false; if (seenAnc.has(p)) return false; seenAnc.add(p); p = this.tree.get(p)?.parent ?? null; }
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
      new Notice("Set up encryption first (Settings → Stashpad → Encryption)."); return;
    }
    const ids = new Set(sources.map((t) => t.id));
    const roots = sources.filter((t) => {
      let p = t.parent;
      // 0.210.1: visited-set guarded. A parent cycle in the index (see
      // TreeIndex.wouldCycle) used to make this spin forever and hang Obsidian on
      // the next delete / lock / copy / clone. Bail out treating it as "not a
      // root" rather than looping.
      const seenAnc = new Set<StashpadId>();
      while (p) { if (ids.has(p)) return false; if (seenAnc.has(p)) return false; seenAnc.add(p); p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) return;
    const folder = this.noteFolder;
    const rootIds = roots.map((r) => r.id);
    let blobs: string[] = [];
    for (const id of rootIds) { const b = await this.plugin.encryptDeleteSubtree(folder, id); if (b) blobs.push(b); }
    if (blobs.length === 0) return;
    this.selection.clear(); this.lastSelected = null; this.tree.rebuild(folder); this.render();
    this.plugin.notifications.show({ message: `Securely deleted ${blobs.length} note${blobs.length === 1 ? "" : "s"} → encrypted trash. Undo to bring ${blobs.length === 1 ? "it" : "them"} back.`, kind: "success", category: "system", folder, actions: [{ label: "Open Trash", onClick: () => this.plugin.openEncryptedTrash() }] });
    this.plugin.getUndoStack(folder).push({
      label: `Secure delete (${blobs.length})`,
      undo: async () => {
        // 0.140.2: keep the ones that failed to restore so undo is retryable.
        const failed: string[] = [];
        for (const b of blobs) {
          try { if (!(await this.plugin.restoreDeletedAt(b, { silent: true }))) failed.push(b); }
          catch (e) { failed.push(b); console.warn("[Stashpad] secure-delete undo failed", b, e); }
        }
        blobs = failed;
        if (failed.length) new Notice(`Undo incomplete: ${failed.length} deleted item${failed.length === 1 ? "" : "s"} couldn't be restored (still in Trash). Try again, or restore from the Trash view.`, 8000);
        this.tree.rebuild(folder); this.render();
      },
      redo: async () => {
        blobs = [];
        for (const id of rootIds) { const b = await this.plugin.encryptDeleteSubtree(folder, id); if (b) blobs.push(b); }
        this.tree.rebuild(folder); this.render();
      },
    });
  }

  /** 0.145.0: the DEFAULT (encryption-off) delete — bundle the source subtrees into
   *  Stashpad's own per-folder trash/ as plaintext `.stashpack` bundles (recoverable
   *  from the Trash view), plaintext gone from the folder, and push ONE undo entry
   *  that restores them. Mirrors secureDeleteSources without the crypto; no confirm
   *  (undo + the Trash view are the safety net, same as the encrypted path). */
  private async plaintextDeleteToStashpadTrash(sources: TreeNode[]): Promise<void> {
    const ids = new Set(sources.map((t) => t.id));
    const roots = sources.filter((t) => {
      let p = t.parent;
      // 0.210.1: visited-set guarded. A parent cycle in the index (see
      // TreeIndex.wouldCycle) used to make this spin forever and hang Obsidian on
      // the next delete / lock / copy / clone. Bail out treating it as "not a
      // root" rather than looping.
      const seenAnc = new Set<StashpadId>();
      while (p) { if (ids.has(p)) return false; if (seenAnc.has(p)) return false; seenAnc.add(p); p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    if (roots.length === 0) return;
    const folder = this.noteFolder;
    const rootIds = roots.map((r) => r.id);
    let blobs: string[] = [];
    for (const id of rootIds) { const b = await this.plugin.plaintextDeleteSubtree(folder, id); if (b) { blobs.push(b); await this.log.append({ type: "delete", id, payload: { to: "trash", bundle: b } }); } }
    if (blobs.length === 0) return;
    this.selection.clear(); this.lastSelected = null; this.tree.rebuild(folder); this.render();
    this.plugin.notifications.show({ message: `Deleted ${blobs.length} note${blobs.length === 1 ? "" : "s"} → Trash. Undo to bring ${blobs.length === 1 ? "it" : "them"} back.`, kind: "success", category: "system", folder, actions: [{ label: "Open Trash", onClick: () => this.plugin.openEncryptedTrash() }] });
    this.plugin.getUndoStack(folder).push({
      label: `Delete (${blobs.length})`,
      undo: async () => {
        const failed: string[] = [];
        for (const b of blobs) {
          try { if (!(await this.plugin.restoreDeletedAt(b, { silent: true }))) failed.push(b); }
          catch (e) { failed.push(b); console.warn("[Stashpad] plaintext-trash undo failed", b, e); }
        }
        blobs = failed;
        if (failed.length) new Notice(`Undo incomplete: ${failed.length} deleted item${failed.length === 1 ? "" : "s"} couldn't be restored (still in Trash). Try again, or restore from the Trash view.`, 8000);
        this.tree.rebuild(folder); this.render();
      },
      redo: async () => {
        blobs = [];
        for (const id of rootIds) { const b = await this.plugin.plaintextDeleteSubtree(folder, id); if (b) blobs.push(b); }
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
      new Notice("Set up encryption first (Settings → Stashpad → Encryption).");
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
    // 0.143.0: per-folder only — unlock THIS view's folder key (each blob then
    // resolves the folder key it was locked under).
    if (!(await this.plugin.ensureFolderUnlocked(this.noteFolder))) return;
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

  /** Update the composer controls that depend on split/enter mode WITHOUT a full
   *  render(). Split/enter mode never change the list — only the split button's
   *  active state/title, the enter button's icon/title, the textarea placeholder,
   *  and the helper text. A render() here caused the list scroll to jump and the
   *  expanded button group to re-collapse. */
  private syncComposerModeUI(): void {
    const split = this.modeSplit ?? getSettings().splitOnLines;
    const enter = this.modeEnterSubmits;
    if (this.composerSplitBtn) {
      this.composerSplitBtn.toggleClass("is-active", split);
      const label = SPLIT_MODE_LABELS[getSettings().splitMode].toLowerCase();
      this.composerSplitBtn.title = split
        ? `Split: ON — ${label} (Mod+/ to toggle, right-click to change)`
        : `Split into notes (Mod+/) — right-click to choose: ${label}`;
    }
    if (this.composerEnterBtn) {
      setIcon(this.composerEnterBtn, enter ? "corner-down-left" : "arrow-big-down-dash");
      this.composerEnterBtn.title = enter
        ? "Enter sends (click to switch to Shift+Enter)"
        : "Shift+Enter sends (click to switch to Enter)";
    }
    if (this.composerInputEl) this.composerInputEl.placeholder = this.composerPlaceholder(enter, split);
    if (this.composerHelperEl) this.composerHelperEl.setText(this.composerHelperText(enter, split));
  }

  /** Rebuild the destination button (icon + optional label + active state) and
   *  the helper text IN PLACE — picking a destination only changes the composer,
   *  never the list, so a full render() (scroll jump + group collapse) is wrong.
   *  0.142.7 */
  private refreshDestButton(): void {
    const btn = this.composerDestBtn;
    if (btn) {
      btn.empty();
      setIcon(btn, "map-pin");
      if (this.nextDestination) btn.createSpan({ text: ` ${this.destinationLabel()}`, cls: "stashpad-btn-text" });
      btn.toggleClass("is-active", !!this.nextDestination);
    }
    this.syncComposerModeUI(); // the helper text embeds the destination label
  }

  toggleSplit(): void {
    const cur = this.modeSplit ?? getSettings().splitOnLines;
    this.modeSplit = !cur;
    this.syncComposerModeUI();
    this.composerInputEl?.focus();
  }

  /** Single writer for the append target so the persisted copy can never drift
   *  from the in-memory one. */
  private setAppendTarget(t: AppendTarget | null): void {
    this.appendTarget = t;
    const all = { ...(this.plugin.settings.draftAppendTargets ?? {}) };
    // Persist the PATH as well as the id: a cross-folder target isn't in this
    // view's tree, so an id alone can't be resolved back on reload.
    if (t) all[this.noteFolder] = { id: t.id, path: t.path, folder: t.folder, mode: t.mode };
    else delete all[this.noteFolder];
    this.plugin.settings.draftAppendTargets = all;
    void this.plugin.saveSettings();
    this.refreshAppendButton();
  }

  private refreshAppendButton(): void {
    const btn = this.composerAppendBtn;
    if (!btn) return;
    btn.empty();
    const t = this.appendTarget;
    btn.toggleClass("is-active", !!t);
    btn.toggleClass("is-hidden", !t);
    if (!t) return;
    setIcon(btn, t.mode === "prepend" ? "corner-right-up" : "corner-down-right");
    // Cross-folder targets say WHICH folder — otherwise two notes with the same
    // title in different Stashpads are indistinguishable on the chip.
    const where = t.folder && t.folder !== this.noteFolder
      ? `${t.folder.split("/").pop()} ▸ ${t.label}`
      : t.label;
    btn.createSpan({ text: ` ${where}`, cls: "stashpad-btn-text" });
    btn.title = `${t.mode === "prepend" ? "Prepending to" : "Appending to"} "${where}" — click to change, flip, or cancel`;
  }

  /** 0.222.0: bind a note to append to; 0.225.0: cross-folder + prepend.
   *
   *  Cross-folder is the whole point rather than a bonus: it turns the composer
   *  into "start typing anywhere, land it in the right note", which is what the
   *  destination picker does for NEW notes. This is the same move for EXISTING
   *  ones — a destination picker plus an edit macro.
   *
   *  Safe to allow across folders here (unlike a normal cross-folder send)
   *  because we are writing text into a note that already exists in its own
   *  folder; there is no new note whose attachments need rehoming. Attachments
   *  staged in THIS composer are the exception — see appendToTarget.
   *
   *  The target is cleared after ONE send rather than staying sticky. Sticky is
   *  more convenient for a run of appends, but it fails dangerously: forget it
   *  is on and your next thought is silently buried inside an old note instead
   *  of becoming its own. Clearing fails safe — the worst case is you create a
   *  normal note. The chip makes re-binding one tap. */
  private openAppendPicker(mode: "append" | "prepend" = "append"): void {
    const ta = this.composerInputEl;
    const hadPlusOnly = ta?.value === "+";
    let picked = false;
    const verb = mode === "prepend" ? "Prepend" : "Append";
    const bind = (file: TFile, id: StashpadId, label: string, folder: string): void => {
      this.setAppendTarget({ id, label, path: file.path, folder, mode });
      // Consume the `+` that opened this; leaving it would prefix the text.
      if (ta && ta.value === "+") {
        ta.value = "";
        this.composerDraft = "";
        void this.saveDraft("");
      }
      ta?.focus();
    };
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "pick", placeholder: `${verb} what you type next to which note?`,
      onPick: async (item) => {
        picked = true;
        if (item.crossFolder) {
          const file = item.crossFile;
          // A synthetic "Home — <folder>" root has no file; a folder has no body.
          if (!file) {
            new Notice("Pick a note — a folder's Home has no body to write into.");
            this.composerInputEl?.focus();
            return;
          }
          const id = (item.crossId ?? item.id.replace(/^cross:/, "")) as StashpadId;
          bind(file, id, file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " "), item.crossFolder);
          return;
        }
        const node = this.tree.get(item.id);
        if (item.id === ROOT_ID || !node?.file) {
          new Notice("Pick a note — Home has no body to write into.");
          this.composerInputEl?.focus();
          return;
        }
        bind(node.file, item.id, this.titleForNode(node), this.noteFolder);
      },
      crossFolderNotes: () => this.collectCrossFolderDestinations(),
      onClose: () => {
        // Dismissed without picking: the `+` stays exactly as typed, so it is
        // still usable as a markdown bullet. Only refocus, never rewrite.
        if (!picked && hadPlusOnly) ta?.focus();
      },
    }).open();
  }

  /** Write `text` into the target note's body — at the end (append) or directly
   *  after the frontmatter (prepend). Undoable. Returns false if the target
   *  vanished between binding and sending. */
  private async appendToTarget(target: AppendTarget, text: string): Promise<boolean> {
    // Resolve by PATH, not through the tree: the target may live in another
    // Stashpad, which this view's tree knows nothing about.
    const found = this.app.vault.getAbstractFileByPath(target.path);
    const file = found instanceof TFile ? found : null;
    if (!file) {
      this.plugin.notifications.show({
        message: `Could not write to "${target.label}" — it no longer exists at ${target.path}.`,
        kind: "error", category: "system", folder: this.noteFolder,
      });
      return false;
    }
    const before = await this.app.vault.read(file);
    let after: string;
    if (target.mode === "prepend") {
      // Insert AFTER the frontmatter block, never before it — a note whose file
      // starts with anything but `---` loses its frontmatter entirely. Measured
      // from the metadata cache when available, with a conservative regex
      // fallback; if neither finds a block, treat the whole file as body.
      const fmPos = this.app.metadataCache.getFileCache(file)?.frontmatterPosition;
      let cut = 0;
      if (fmPos) cut = fmPos.end.offset + 1;
      else {
        const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(before);
        if (m) cut = m[0].length;
      }
      const head = before.slice(0, cut);
      const body = before.slice(cut).replace(/^\r?\n+/, "");
      after = `${head}${text}\n\n${body}`;
    } else {
      const sep = before.endsWith("\n") ? "" : "\n";
      after = `${before}${sep}\n${text}\n`;
    }
    await this.app.vault.modify(file, after);
    // 0.226.0: re-slug here rather than relying on onFileModify. That handler
    // early-returns for paths outside THIS view's noteFolder, so a cross-folder
    // write never got slug handling and left the filename describing a first
    // line that had been replaced. Doing it inline also covers the same-folder
    // case immediately instead of on the 30s debounce. No-ops when the name
    // already matches, which is every ordinary append.
    await this.reslugFile(file, this.stripFrontmatter(after));
    const path = file.path;
    const verb = target.mode === "prepend" ? "Prepend" : "Append";
    const where = target.folder && target.folder !== this.noteFolder
      ? `${target.folder.split("/").pop()} ▸ ${target.label}`
      : target.label;
    // Cross-folder writes are invisible — the row isn't in this list, so without
    // a notice there is no feedback that anything happened at all.
    if (target.folder && target.folder !== this.noteFolder) {
      this.plugin.notifications.show({
        message: `${verb}ed to “${where}”.`,
        kind: "success", category: "system", folder: this.noteFolder,
      });
    }
    this.plugin.getUndoStack(this.noteFolder).push({
      label: `${verb} to "${where}"`,
      // Re-resolve by path at undo time. A PREPEND changes the note's first
      // line, so Stashpad's own slug-rename may move the file — resolve by
      // frontmatter id first and fall back to the original path.
      // Undo/redo re-slug too, or the filename keeps describing the reverted
      // first line. Resolve by frontmatter id FIRST, since the write above may
      // already have renamed the file out from under `path`.
      undo: async () => {
        const f = this.plugin.fileByFrontmatterId(target.id, target.folder) ?? this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) {
          await this.app.vault.modify(f, before);
          await this.reslugFile(f, this.stripFrontmatter(before));
        }
      },
      redo: async () => {
        const f = this.plugin.fileByFrontmatterId(target.id, target.folder) ?? this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) {
          await this.app.vault.modify(f, after);
          await this.reslugFile(f, this.stripFrontmatter(after));
        }
      },
    });
    return true;
  }

  /** 0.221.0: a compact destination menu — recent folders first, with a "More…"
   *  row that opens the full picker.
   *
   *  The full picker is right for "find a specific note in a specific folder",
   *  but it is heavy for the case actually hit on mobile: start typing in
   *  whichever folder opened, then want the note to land in a different one.
   *  That is a one-tap decision among a handful of folders, so it gets a
   *  one-tap menu; anything more specific falls through to the picker,
   *  unchanged.
   *
   *  Sends to the folder's HOME (ROOT_ID) — a quick send means "put this in
   *  that folder", not "under a particular note", which is the picker's job.
   *  The draft never moves: this sets a destination for the NEXT send, so the
   *  collision problem that dogged the carry-the-draft idea never arises. */
  private openQuickDestinationMenu(e: MouseEvent, wasFocused: boolean): void {
    const folders = this.plugin.quickDestinationFolders(this.noteFolder);
    if (!folders.length) { this.openDestinationPicker(wasFocused); return; }
    const menu = new Menu();
    if (this.nextDestination) {
      menu.addItem((i: any) => i.setTitle("Clear destination").setIcon("x").onClick(() => {
        this.nextDestination = null;
        this.nextDestinationFolder = null;
        this.nextDestinationLabel = null;
        this.refreshDestButton();
        if (wasFocused) this.composerInputEl?.focus();
      }));
      menu.addSeparator();
    }
    for (const folder of folders) {
      const name = folder.split("/").pop() || folder;
      menu.addItem((i: any) => i
        .setTitle(name)
        .setIcon(this.plugin.getFolderIcon(folder) ?? "folder")
        .onClick(() => {
          this.nextDestination = ROOT_ID;
          this.nextDestinationFolder = folder;
          this.nextDestinationLabel = name;
          // MRU only — a send must not change which folder opens on launch.
          this.plugin.recordFolderUsed(folder, { opened: false });
          this.refreshDestButton();
          // Straight back to typing — the point is not to lose the mobile
          // keyboard over a one-tap decision.
          if (wasFocused) this.composerInputEl?.focus();
        }));
    }
    menu.addSeparator();
    menu.addItem((i: any) => i
      .setTitle("More… (pick a note)")
      .setIcon("search")
      .onClick(() => this.openDestinationPicker(wasFocused)));
    menu.showAtMouseEvent(e);
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
          this.refreshDestButton();
          this.composerInputEl?.focus();
          return;
        }
        this.nextDestination = item.id;
        this.nextDestinationFolder = null;
        this.nextDestinationLabel = null;
        this.refreshDestButton();
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
    // 0.224.0: pinned folders lead here too, in folders-panel order, so the
    // Stashpads you actually send to are the first roots you see. Applied here
    // rather than inside searchableFolders so plain search results keep their
    // existing (alphabetical) order.
    const folders = this.plugin.rankFoldersByPin(
      this.plugin.searchableFolders(this.noteFolder).filter((f) => f !== this.noteFolder),
    );
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
    });
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
        // 0.124.0: a locked (encrypted) result isn't a tree node — navigate to
        // its parent so the locked stub is visible in the list, ready to unlock.
        if (item.locked) {
          const pid = item.locked.parentId ?? ROOT_ID;
          if (newTab) void this.openNoteInNewTab(this.noteFolder, pid);
          else this.navigateTo(pid);
          return;
        }
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
          // 0.132.0: "open in context" focuses the note's PARENT (so the note is
          // a row in its list) and cursors/scrolls to it, instead of focusing
          // INTO the note (which lands on the focused-header). Off = old behavior.
          const ctx = this.plugin.settings.searchOpensInContext !== false;
          const focusTarget = ctx ? (item.node.parent ?? ROOT_ID) : item.node.id;
          const cursor = ctx ? item.node.id : undefined;
          if (newTab) void this.openNoteInNewTab(this.noteFolder, focusTarget, cursor);
          else { if (cursor) this.pendingCursorId = cursor as StashpadId; this.navigateTo(focusTarget); }
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
      // 0.124.0: surface encrypted/locked notes in search (placeholder when titles hidden).
      lockedNotes: () => this.plugin.lockedSubtreesInFolder(this.noteFolder),
      hideLockedTitles: false, // 0.137.1: global option removed; picker falls back to !lk.title
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
    // 0.140.17: capture each move so the whole outdent is ONE undo entry (was N),
    // and suppress the per-move toast (silentSuccess) so a clean outdent shows a
    // single summary toast instead of N "Reparented" ones.
    const priorParents: { id: StashpadId; path: string; oldParent: StashpadId | null; newParent: StashpadId }[] = [];
    for (const t of targets) {
      const parent = t.parent ? this.tree.get(t.parent) : null;
      if (!parent || parent.id === ROOT_ID) { skipped.push(t.id); continue; }
      const grandparent = parent.parent ?? ROOT_ID;
      priorParents.push({ id: t.id, path: t.file?.path ?? "", oldParent: t.parent ?? null, newParent: grandparent });
      await this.changeParent(t, grandparent, { record: false, silentSuccess: true });
      moved.push(t);
    }
    if (moved.length === 0) {
      new Notice(skipped.length ? "Already at the top level." : "Nothing to outdent.");
      return;
    }
    const outdentFolder = this.noteFolder;
    this.plugin.getUndoStack(outdentFolder).push({
      label: `Outdent (${moved.length})`,
      undo: async () => {
        for (const p of priorParents) {
          const f = this.fileForNote(p.id, p.path);
          if (f) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = p.oldParent ?? ROOT_ID; });
        }
        this.tree.rebuild(outdentFolder); this.render();
      },
      redo: async () => {
        for (const p of priorParents) {
          const f = this.fileForNote(p.id, p.path);
          if (f) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.parent = p.newParent; });
        }
        this.tree.rebuild(outdentFolder); this.render();
      },
    });
    this.render();
    // One summary toast, always (not only when some were skipped).
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
  /** 0.227.0: move focus out of the composer and onto the list from anywhere,
   *  including the command palette. Escape already does this, but only while
   *  the composer has focus — there was no way to ASK for the list. Lands on
   *  the last note selected at this level, matching the ArrowUp-out-of-composer
   *  behaviour rather than inventing a second landing rule. */
  cmdFocusList(): void {
    this.composerInputEl?.blur();
    this.viewRoot?.focus({ preventScroll: true });
    if (!this.currentChildren.length) return;
    const lastId = this.lastCursorByFocus.get(this.focusId) ?? this.lastSelected;
    const idx = lastId ? this.currentChildren.findIndex((n) => n.id === lastId) : -1;
    this.cursorIdx = idx >= 0 ? idx : this.currentChildren.length - 1;
    this.selectCursor(false);
  }

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
          // 0.218.0: repainted in place by repaintRowColors below, so the
          // follow-up re-render (which is what shifts the list) is skipped.
          this.markFmSelfWrite(t.file.path, true);
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
        // 0.218.0: repaint color on the live rows instead of rebuilding the
        // list. Nothing is destroyed, so the list cannot move — no scroll
        // restoration required.
        this.traceScroll("color");
        this.repaintRowColors();
        // 0.59.0: push an undo entry so the user can reverse a color
        // change with Cmd+Z. Restores each target's prior color (or
        // removes the color frontmatter entirely if there was none).
        const undoFolder = this.noteFolder;
        const newColor = color;
        const applyColors = async (mapping: { id: StashpadId; path: string; col: string | null }[]) => {
          for (const m of mapping) {
            const file = this.fileForNote(m.id, m.path);
            if (!file) continue;
            try {
              this.markFmSelfWrite(file.path, true); // repainted in place below
              await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (m.col) fm.color = m.col;
                else delete fm.color;
              });
            } catch { /* ignore */ }
          }
          this.tree.rebuild(undoFolder);
          // Same in-place repaint as the apply path (0.218.0). tree.rebuild
          // above refreshes the model the repaint reads from.
          this.repaintRowColors();
        };
        this.plugin.getUndoStack(undoFolder).push({
          label: priors.length === 1 ? "Color change" : `Color change (${priors.length})`,
          undo: () => applyColors(priors.map((p) => ({ id: p.id, path: p.path, col: p.was }))),
          redo: () => applyColors(priors.map((p) => ({ id: p.id, path: p.path, col: newColor }))),
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
    // 0.253.0: this used to rebootstrap BOTH folders in full. Correct, but it
    // meant one move rewrote the frontmatter of every stale note in both
    // folders — archived subtrees included — and every one of those writes is
    // a file Obsidian Sync re-uploads. The set of notes a move can actually
    // dirty is small and known here, so name it: the moved notes (their
    // parentLink and children now point across a folder boundary), the parents
    // they left, and the parent they joined. ROOT stands in for "top level",
    // whose children list lives on the home note.
    const sourceFolder = this.noteFolder;
    const affectedIds = new Set<string>(plan.map((p) => p.id));
    affectedIds.add(newParentId);
    for (const p of plan) {
      if (p.isRoot) affectedIds.add(p.oldParent ?? ROOT_ID);
    }
    // Both folders get the same id set: which side a given note is on flips
    // with undo/redo, and an id that isn't in a folder simply isn't found
    // there. The setting is read at call time, not captured, so turning
    // recovery links off later also silences the undo path.
    const repairMovedLinks = (): void => {
      if (!getSettings().writeRecoveryLinks) return;
      window.setTimeout(() => {
        void rebootstrapFolderFrontmatter(this.app, sourceFolder, { onlyIds: affectedIds });
        void rebootstrapFolderFrontmatter(this.app, targetDir, { onlyIds: affectedIds });
      }, 350);
    };
    repairMovedLinks();

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
          } catch { /* ignore */ }
        }
        this.tree.rebuild(this.noteFolder);
        this.render();
        repairMovedLinks();
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
          } catch { /* ignore */ }
        }
        this.tree.rebuild(this.noteFolder);
        this.render();
        repairMovedLinks();
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
    // 0.191.0: surface the new home in a BACKGROUND tab (setting-gated, on by
    // default). Skipped when autoNavOnMoveIn is on — that already drills you into
    // the parent, so a tab would just duplicate where you already are.
    if (!this.plugin.settings.autoNavOnMoveIn) void this.openParentInBackgroundTab(target.id);
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
    const reassignments: { childId: StashpadId; childPath: string; oldParent: StashpadId | null; newParent: StashpadId }[] = [];

    const bodies: string[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const raw = await this.app.vault.cachedRead(t.file);
      bodies.push(this.stripFrontmatter(raw).trim());
    }
    const newBody = bodies.map((b) => b.trim()).filter(Boolean).join("\n");
    const oldestRaw = await this.app.vault.read(oldest.file);
    // 0.140.9: guard a malformed frontmatter block. If the kept note opens with
    // `---` but has no closing `\n---`, indexOf returns -1 and `-1 + 4 = 3` would
    // slice off just "---", destroying the note's real frontmatter (id included).
    const fmClose = oldestRaw.startsWith("---") ? oldestRaw.indexOf("\n---", 3) : -1;
    if (oldestRaw.startsWith("---") && fmClose < 0) {
      this.plugin.notifications.show({
        message: "Can't merge — the kept note's frontmatter is malformed (no closing ---).",
        kind: "warning", category: "merge", folder: this.noteFolder,
      });
      return;
    }
    const fmEnd = oldestRaw.startsWith("---") ? fmClose + 4 : 0;
    const fmBlock = oldestRaw.slice(0, fmEnd);
    const newOldestContent = `${fmBlock}\n${newBody}\n`;
    await this.app.vault.modify(oldest.file, newOldestContent);

    // 0.211.6 (L2): register undo BEFORE the destructive loop. It used to be pushed
    // only after every sibling had been reparented and trashed, so a throw mid-loop
    // (a failed reparent, a trash the OS refuses, a log write) left the kept note
    // rewritten and some siblings already in the trash with NO undo entry at all —
    // nothing in the UI could put it back. Both closures read `reassignments` and
    // `deletedSnap` when they RUN rather than now, and restoreSnapshots skips files
    // that still exist, so one entry is correct whether the loop finishes or stops
    // halfway.
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
        const f = this.fileForNote(oldest.id, oldestPath);
        if (f) await this.app.vault.modify(f, oldestOriginal);
        // Restore each child's parent.
        for (const r of reassignments) {
          const cf = this.fileForNote(r.childId, r.childPath);
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
        const f = this.fileForNote(oldest.id, oldestPath);
        if (f) await this.app.vault.modify(f, newOldestContent);
        // Re-reassign children.
        for (const r of reassignments) {
          const cf = this.fileForNote(r.childId, r.childPath);
          // Use the recorded destination, NOT oldest.id — the kept note (if it
          // was a child of a merged-away target) was reparented to that target's
          // parent, so replaying oldest.id here would write parent:<self>. 0.140.9
          if (cf) await this.app.fileManager.processFrontMatter(cf, (fm) => { fm.parent = r.newParent; });
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });

    try {
    for (let i = 1; i < targets.length; i++) {
      const t = targets[i];
      if (!t.file) continue;
      for (const c of this.tree.getChildren(t.id)) {
        const oldParent = c.parent;
        // If the KEPT note is itself a child of this merged-away target, it can't
        // be re-parented to itself (changeParent refuses) — move it up to the
        // merged-away note's own parent instead. Record ONLY moves that actually
        // happened, else redo would replay a refused move as parent:<self>. 0.140.9
        const dest = c.id === oldest.id ? (t.parent ?? ROOT_ID) : oldest.id;
        const moved = await this.changeParent(c, dest, { record: false });
        if (moved && c.file) reassignments.push({ childId: c.id, childPath: c.file.path, oldParent, newParent: dest });
      }
      await this.app.fileManager.trashFile(t.file);
      await this.log.append({ type: "delete", id: t.id, payload: { mergedInto: oldest.id } });
    }
    } catch (e) {
      // The undo entry is already on the stack, so the user can back this out.
      console.warn("[Stashpad] merge stopped partway", e);
      this.tree.rebuild(folder);
      this.render();
      this.plugin.notifications.show({
        message: `Merge stopped partway — ${(e as Error).message}. Press Cmd+Z to undo what did happen.`,
        kind: "warning", category: "merge", folder,
      });
      return;
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

  }

  // Clipboard commands — implementations live in commands/clipboard-cmds.ts.
  // These thin delegators keep the public method names stable for the keydown
  // dispatcher + main.ts's call("<method>") palette wiring.
  cmdCopy(): Promise<void> { return clipboardCmds.cmdCopy(this); }
  cmdCopyCodeBlock(): Promise<void> { return clipboardCmds.cmdCopyCodeBlock(this); }
  cmdCopyTree(): Promise<void> { return clipboardCmds.cmdCopyTree(this); }
  cmdCopyFocusedSubtree(): Promise<void> { return clipboardCmds.cmdCopyFocusedSubtree(this); }
  cmdCopyOutline(): Promise<void> { return clipboardCmds.cmdCopyOutline(this); }

  /** 0.193.0: reverse color-alias lookup — friendly name → hex for THIS folder.
   *  (settings.colorAliases stores hex → name, so this scans.) Case-insensitive. */
  private hexForColorAlias(folder: string, name: string): string | null {
    const map = this.plugin.settings.colorAliases?.[folder.replace(/\/+$/, "")] ?? {};
    const want = name.trim().toLowerCase();
    for (const [hex, alias] of Object.entries(map)) {
      if (typeof alias === "string" && alias.trim().toLowerCase() === want) return hex;
    }
    return null;
  }

  /** 0.198.0: push a repeating task to its NEXT occurrence without completing it —
   *  "not this time". Completing would either mark work done you didn't do or spawn a
   *  history entry claiming you did; skipping just advances the schedule. Honours the
   *  rule's anchor, so a "when done" task counts from now and a due-anchored one keeps
   *  its cadence. */
  async cmdSkipOccurrence(node?: TreeNode): Promise<void> {
    const targets = node ? [node] : this.getActionTargets();
    const skipped: Array<{ title: string; when: number }> = [];
    const prior: Array<{ path: string; due: unknown }> = [];
    for (const t of targets) {
      if (!t.file) continue;
      const fm = this.app.metadataCache.getFileCache(t.file)?.frontmatter;
      const rec = parseRecurrence(fm?.repeat as string | undefined);
      if (!rec) continue;
      const oldDue = fm?.due != null ? Date.parse(String(fm.due)) : NaN;
      const next = nextDueOnComplete(rec, Number.isFinite(oldDue) ? oldDue : null, Date.now());
      prior.push({ path: t.file.path, due: fm?.due });
      this.markFmSelfWrite(t.file.path);
      await this.app.fileManager.processFrontMatter(t.file, (m) => {
        m.due = new Date(next).toISOString();
        // Skipping is not completing, and not a miss — it's a deliberate pass.
        delete m.completed;
        delete m.missed;
        delete m.missedAt;
      });
      skipped.push({ title: this.titleForNode(t), when: next });
    }
    if (!skipped.length) { new Notice("Nothing to skip — select a repeating task."); return; }
    this.tree.rebuild(this.noteFolder);
    this.render();
    this.plugin.notifications.show({
      message: skipped.length === 1
        ? `⏭️ Skipped “${skipped[0].title}” → next on ${formatDateTime(skipped[0].when, this.plugin.settings)}.`
        : `⏭️ Skipped ${skipped.length} repeating tasks to their next occurrence.`,
      kind: "success", category: "system", folder: this.noteFolder,
    });
    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: `Skip occurrence (${skipped.length})`,
      undo: async () => {
        for (const p of prior) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (m) => {
            if (p.due === undefined) delete m.due; else m.due = p.due;
          });
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.192.0: open the paste-text importer — the standalone Stashpad Importer web
   *  app's job, done in-plugin (no `.stash` round-trip). Level-1 notes land under
   *  whatever is currently focused, so you can import straight into a subtree. */
  cmdImportText(): void {
    const focus = this.focusId && this.focusId !== ROOT_ID ? this.tree.get(this.focusId) : null;
    const dest = focus ? `“${this.titleForNode(focus)}”` : `“${this.noteFolder}” (home)`;
    const run = (notes: ImportNote[]) => this.runTextImport(notes);
    new TextImportModal(
      this.app, dest, run,
      // Pop out into a full tab, carrying the typed text + options across.
      (state) => void this.plugin.openTextImporter({ state, destinationLabel: dest, onImport: run }),
    ).open();
  }

  /** Create the parsed notes in order: each note's parent is resolved from the
   *  already-created note at its parentIndex, colors are stamped after creation,
   *  and the whole batch is ONE undo entry. */
  private async runTextImport(notes: ImportNote[]): Promise<void> {
    if (!notes.length) return;
    const folder = this.noteFolder;
    const rootParent: StashpadId = this.focusId ?? ROOT_ID;
    const collected: Array<{ path: string; content: string }> = [];
    const createdIds: Array<StashpadId | null> = [];
    const base = Date.now();
    let failed = 0;

    this.beginBulkRender();
    try {
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        // A parent that failed to create falls back to the import root rather than
        // orphaning the child.
        const parentId = n.parentIndex == null ? rootParent : (createdIds[n.parentIndex] ?? rootParent);
        const before = collected.length;
        const id = await this.createNoteUnder(n.body, parentId, {
          record: false,
          // Ascending by 1ms so the imported order is preserved by created-time sort.
          createdOverride: new Date(base + i).toISOString(),
          deferRender: true,
          collectInto: collected,
        });
        createdIds.push(id);
        if (!id) { failed++; continue; }
        // 0.193.0: an unresolved color NAME ("[color: boogers]") is looked up in
        // this folder's own color aliases before giving up — built-in names like
        // "amber" were already resolved by the parser.
        let hex = n.color;
        if (!hex && n.colorName) hex = this.hexForColorAlias(folder, n.colorName);
        if (hex) {
          const path = collected.length > before ? collected[collected.length - 1].path : null;
          const f = path ? (this.app.vault.getAbstractFileByPath(path) as TFile | null) : null;
          if (f) {
            try {
              await this.app.fileManager.processFrontMatter(f, (m: any) => { m.color = hex; });
            } catch { /* color is cosmetic — never fail the import over it */ }
          }
          // Carry the friendly color name across as a folder color alias, so a
          // round-tripped copy keeps its palette names.
          if (n.colorAlias) {
            try { await this.plugin.setColorAlias(folder, hex, n.colorAlias); } catch { /* ignore */ }
          }
        }
      }
    } finally {
      try { await this.fmSync.flush(); } catch { /* best effort */ }
      this.endBulkRender();
    }

    this.tree.rebuild(folder);
    this.render();
    const made = collected.length;
    const importedIds = createdIds.filter((x): x is StashpadId => !!x);
    // 0.210.0: the importer no longer closes itself on Import, so the receipt has
    // to be the thing that takes you to the result — otherwise you import and are
    // left staring at the importer with no idea where the notes went. The action
    // focuses the Stashpad tab for this folder and reveals the first import.
    this.plugin.notifications.show({
      message: `Imported ${made} note${made === 1 ? "" : "s"} into **${folder}**${failed ? ` (${failed} failed)` : ""}`,
      kind: failed ? "warning" : "success",
      category: "system",
      affectedIds: importedIds,
      folder,
      duration: 0,
      actions: importedIds.length
        ? [{
            label: "Show imported notes",
            onClick: () => {
              void (async () => {
                await this.plugin.openFolderInStashpad(folder);
                const target = importedIds[0];
                // Prefer THIS view when it is still showing that folder; otherwise
                // find any open Stashpad view on it (openFolderInStashpad above has
                // already opened one if none existed).
                const v = (this.noteFolder === folder && this.viewRoot?.isConnected)
                  ? this
                  : (this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
                      .map((l) => l.view as StashpadView | undefined)
                      .find((x) => x?.noteFolder === folder));
                if (!v) return;
                v.selection.clear();
                for (const id of importedIds) v.selection.add(id);
                const idx = v.currentChildren.findIndex((n) => n.id === target);
                if (idx >= 0) v.cursorIdx = idx;
                v.render();
                v.revealCursorRow();
              })();
            },
          }]
        : undefined,
    });

    const created = collected.slice();
    this.plugin.getUndoStack(folder).push({
      label: `Import ${made} note${made === 1 ? "" : "s"}`,
      undo: async () => {
        for (const { path } of created) {
          const nf = this.app.vault.getAbstractFileByPath(path) as TFile | null;
          if (nf) { try { await this.app.fileManager.trashFile(nf); } catch { /* ignore */ } }
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.216.0: open the importer for data extracted from the dead Stashpad DESKTOP
   *  app. Separate from cmdImportText because that one infers structure from
   *  indentation, while the export carries explicit parent ids — see
   *  docs/stashpad-app-import-plan.md. */
  cmdImportStashpadApp(): void {
    const focus = this.focusId && this.focusId !== ROOT_ID ? this.tree.get(this.focusId) : null;
    const dest = focus ? `“${this.titleForNode(focus)}”` : `“${this.noteFolder}” (home)`;
    // Ids written during THIS importer session. The metadata cache hasn't
    // parsed the files we just created by the time the importer re-parses, so a
    // cache-only lookup would still miss them and let a second press duplicate
    // everything. Scoped to one importer session (a fresh open starts empty),
    // so deleting notes and re-importing them deliberately still works.
    const session = new Set<string>();
    // The destination is chosen inside the importer, so route there before
    // writing. Switching the view is deliberate: createNoteUnder, the undo stack
    // and the render path are all scoped to a view's own folder, so importing
    // "into" a different folder from here would mean a second, untested write
    // path for the riskiest operation in the plugin.
    const run = async (notes: AppImportNote[], helpers: HelperNote[], destination: string) => {
      let target: StashpadView = this;
      if (destination && destination !== this.noteFolder) {
        await this.plugin.openFolderInStashpad(destination);
        const found = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
          .map((l) => l.view as StashpadView | undefined)
          .find((v) => v?.noteFolder === destination);
        if (!found) {
          new Notice(`Could not open "${destination}" - nothing was imported.`);
          return;
        }
        target = found;
      }
      await target.runAppImport(notes, helpers);
      for (const n of notes) if (!n.synthetic && n.sourceId) session.add(n.sourceId);
    };
    // Ids already imported into this folder, so a second run can skip them
    // instead of duplicating everything. 0.224.0: recomputed on every parse
    // rather than snapshotted once — the importer stays open after an import,
    // so a snapshot made "Skip notes already imported" a no-op on the second
    // press and the whole export landed twice.
    // Takes the folder: the destination is picked in the importer, so the guard
    // has to look at wherever the user is actually about to write.
    const existing = (folder: string): ReadonlySet<string> => {
      const ids = this.importedAppIds(folder || this.noteFolder);
      for (const id of session) ids.add(id);
      return ids;
    };
    // Every vault folder, not just the Stashpad ones: importing into a plain
    // folder is how you convert it, so refusing to offer them would hide the
    // simplest way to keep an archive separate from existing notes.
    const stash = new Set(this.plugin.discoverStashpadFolders());
    const ranked = this.plugin.rankFoldersByPin([...stash]);
    const others = this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !!f.path && f.path !== "/")
      .map((f) => f.path)
      .filter((p) => !stash.has(p))
      // Top level only, for now: a vault of any size turns the list into a wall
      // of nested paths, and importing into a subfolder is rare enough to ask
      // for explicitly later.
      .filter((p) => !p.includes("/"))
      // Never offer Stashpad's own machine-managed subfolders (_exports,
      // _attachments, _authors, archive/, trash/ ...). These showed up as
      // "<folder>/_exports (not a Stashpad folder yet)" - technically true, and
      // a destination that would quietly corrupt the folder it belongs to.
      .filter((p) => !isInReservedSubfolder(p) && !isReservedSubfolderName(p))
      .sort((a, b) => a.localeCompare(b));
    const folders = [
      ...ranked.map((path) => ({ path, isStashpad: true })),
      ...others.map((path) => ({ path, isStashpad: false })),
    ];
    const modal = new AppImportModal(
      this.app, dest, run,
      (state) => void this.plugin.openAppImporter({
        state, destinationLabel: dest, onImport: run, existingSourceIds: existing,
        folders, currentFolder: this.noteFolder,
        ensureFolder: (path) => this.ensureFolder(path),
      }),
      {},
      existing,
      folders,
      this.noteFolder,
      (path) => this.ensureFolder(path),
    );
    modal.open();
  }

  /** Create the imported notes. Same parentIndex walk as runTextImport, plus the
   *  desktop app's own metadata stamped onto each note.
   *
   *  The app's ids, extra parents and attachment records go into `stashpadApp*`
   *  keys rather than Stashpad's own `attachments` / `parent` fields: those are
   *  RESERVED (src/types.ts) and Stashpad stamps them itself, and the attachment
   *  records point at images that no longer exist anywhere. */
  /** Every Stashpad-app id already present in `folder`, read from frontmatter.
   *  Cheap: the metadata cache already holds it, so no file reads. */
  private importedAppIds(folder: string): Set<string> {
    const out = new Set<string>();
    const prefix = `${folder.replace(/\/+$/, "")}/`;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.stashpadAppId;
      if (typeof id === "string" && id) out.add(id);
    }
    return out;
  }

  /** Section parents ("Stashpad Todos", "Recovered from Stashpad", …) already in
   *  this folder, keyed by the source root they represent.
   *
   *  0.226.2: these are synthetic too, so like the reference notes they carry no
   *  stashpadAppId and the id guard cannot see them. Importing a SECOND export
   *  over the first — the delta from another machine, say — brought in a handful
   *  of genuinely new notes and built a duplicate section parent to hold them.
   *  Now the existing one is reused. */
  private existingSectionParents(folder: string): Map<string, StashpadId> {
    const out = new Map<string, StashpadId>();
    const prefix = `${folder.replace(/\/+$/, "")}/`;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const root = fm?.stashpadAppSectionRoot;
      const id = fm?.id;
      if (typeof root === "string" && root && typeof id === "string" && id && !out.has(root)) {
        out.set(root, id as StashpadId);
      }
    }
    return out;
  }

  /** True when this folder already holds the importer's reference parent.
   *  Those notes are synthetic, so they carry no stashpadAppId and the re-run
   *  guard cannot match them by id — this is what stops a second Import from
   *  rebuilding the reference tree. */
  private hasAppReferenceNote(folder: string): boolean {
    const prefix = `${folder.replace(/\/+$/, "")}/`;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache?.frontmatter?.stashpadAppReference === true) return true;
      // Fallback for notes imported before the marker existed (0.226.1). Compare
      // on letters and digits only: slugification lowercases, drops "&" and
      // turns spaces into hyphens, so any literal comparison against the title
      // silently never matches - which is exactly what the first version did.
      const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (norm(f.basename.replace(/-[a-z0-9]{6}$/i, "")).startsWith(norm(APP_REFERENCE_TITLE))) return true;
    }
    return false;
  }

  private async runAppImport(notes: AppImportNote[], helpers: HelperNote[]): Promise<void> {
    if (!notes.length && !helpers.length) return;
    // Disarm the drop-watcher for the duration. It listens for files appearing
    // in a Stashpad folder, and this is about to create thousands of them - each
    // one adopted, which mints a FRESH id over a note that already has one and
    // orphans its children. Restored in a finally inside suspendFor, so a failed
    // import cannot leave auto-import switched off.
    return this.plugin.importService.suspendFor(() => this.runAppImportInner(notes, helpers));
  }

  private async runAppImportInner(notes: AppImportNote[], helpers: HelperNote[]): Promise<void> {
    const folder = this.noteFolder;
    const rootParent: StashpadId = this.focusId ?? ROOT_ID;
    const collected: Array<{ path: string; content: string }> = [];
    const createdIds: Array<StashpadId | null> = [];
    const base = Date.now();
    let failed = 0;

    const sectionParents = this.existingSectionParents(folder);

    // A full archive is tens of thousands of file writes on the main thread. It
    // used to run with no feedback at all: the window looked idle, so the
    // natural thing was to start browsing - and every few hundred notes the list
    // rebuilt under you and jumped. Two changes: say what is happening, and give
    // the UI a chance to paint.
    const total = notes.length + (helpers.length ? helpers.length + 1 : 0);
    const progress = total > PROGRESS_MIN_NOTES ? new Notice("", 0) : null;
    const tick = (done: number, what: string): void => {
      if (!progress) return;
      const pct = Math.floor((done / Math.max(1, total)) * 100);
      progress.setMessage(
        `Importing from Stashpad — ${done.toLocaleString()} of ${total.toLocaleString()} (${pct}%)\n${what}`,
      );
    };
    tick(0, "starting…");

    this.beginBulkRender();
    try {
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (i % PROGRESS_EVERY === 0) {
          tick(i, `into “${folder}”`);
          // Hand the frame back so the notice actually paints and the window
          // stays responsive. Without this the whole import is one long block.
          await new Promise((r) => window.setTimeout(r, 0));
        }
        // Reuse a section parent that is already here rather than making a second
        // one; children below it resolve through createdIds either way.
        // A section root may now be the app's OWN note rather than an invented
        // one, so key on sectionRoot rather than synthetic.
        if (n.sectionRoot) {
          const existingId = sectionParents.get(String(n.sectionRoot));
          if (existingId) { createdIds.push(existingId); continue; }
        }
        const parentId = n.parentIndex == null ? rootParent : (createdIds[n.parentIndex] ?? rootParent);
        const before = collected.length;
        // A task arrives as a normalised "[x] " prefix, which createNoteUnder's
        // existing parser turns into task frontmatter.
        // Guard the prefix: a handful of notes already start with their own
        // checkbox, and "[x] [x] foo" would be visible nonsense.
        const alreadyChecked = /^\s*(?:[-*+]\s*)?\[[ xX]\]/.test(n.body);
        const body = n.task === "done" && !alreadyChecked ? `[x] ${n.body}` : n.body;
        const id = await this.createNoteUnder(body, parentId, {
          record: false,
          // Real Stashpad timestamp when we have one; otherwise ascending by 1ms
          // so the import order survives a created-time sort.
          createdOverride: n.createdAt ?? new Date(base + i).toISOString(),
          deferRender: true,
          collectInto: collected,
        });
        createdIds.push(id);
        if (!id) { failed++; continue; }

        const path = collected.length > before ? collected[collected.length - 1].path : null;
        const f = path ? (this.app.vault.getAbstractFileByPath(path) as TFile | null) : null;
        if (!f) continue;
        try {
          await this.app.fileManager.processFrontMatter(f, (m: any) => {
            if (n.color) m.color = n.color;
            // A grouping note the importer invented has no source id to stamp —
            // stamping one would make the re-run guard skip it next time.
            if (!n.synthetic && n.sourceId) m.stashpadAppId = n.sourceId;
            // Lets a later import find this section instead of duplicating it.
            if (n.sectionRoot) m.stashpadAppSectionRoot = String(n.sectionRoot);
            // Obsidian's own tag key, so they work in search, the tag pane and
            // Bases without anything extra. Merged with whatever is already
            // there rather than replacing it, so a re-import cannot wipe tags
            // the user added by hand.
            if (n.tags.length) {
              const prev = Array.isArray(m.tags) ? m.tags.map(String)
                : typeof m.tags === "string" && m.tags ? [m.tags] : [];
              m.tags = [...new Set([...prev, ...n.tags])];
            }
            if (n.pinned) {
              m.pinned = true;
              // Keep the app's own sidebar order: pinnedAt is just a sort key.
              m.pinnedAt = base + (n.pinnedOrder ?? 0) * 1000;
            }
            if (n.modifiedAt) m.stashpadAppModified = n.modifiedAt;
            if (n.root && n.root !== "HOME") m.stashpadAppSection = n.root;
            if (n.orphaned) m.stashpadAppRecovered = true;
            // Only for the handful of notes Stashpad filed in two places at once;
            // a folder tree can hold them once, so the other parent is recorded.
            if (n.extraParents.length) m.stashpadAppAlsoUnder = n.extraParents;
            if (n.attachments.length) {
              m.stashpadAppAttachments = n.attachments.map((a) => `${a.name} (${a.type}, ${a.size} bytes)`);
            }
          });
        } catch { /* metadata is not worth failing an import over */ }
        if (n.color && n.colorAlias) {
          try { await this.plugin.setColorAlias(folder, n.color, n.colorAlias); } catch { /* ignore */ }
        }
      }

      tick(notes.length, "writing the reference notes…");
      // Reference notes from the export's supporting files, filed under one parent
      // so they never mix with the user's own notes.
      //
      // 0.226.1: skip them when that parent is already here. These are synthetic —
      // they carry no stashpadAppId — so the re-run guard, which matches on that
      // field, cannot see them. Without this check a second Import in the same
      // session rebuilt the whole reference tree even though every real note was
      // correctly skipped.
      if (helpers.length && this.hasAppReferenceNote(folder)) {
        helpers = [];
      }
      if (helpers.length) {
        const hostId = await this.createNoteUnder(
          `${APP_REFERENCE_TITLE}\n\nHow the old desktop app was set up, what was pinned, what was done, `
          + "and what could not be carried across. Kept together so it never mixes with your actual notes.",
          rootParent, {
          record: false, deferRender: true, collectInto: collected,
        });
        if (hostId) {
          // Mark it, so a later run can recognise it without relying on the
          // title surviving slugification.
          const hostPath = collected.length ? collected[collected.length - 1].path : null;
          const hostFile = hostPath ? (this.app.vault.getAbstractFileByPath(hostPath) as TFile | null) : null;
          if (hostFile) {
            try {
              await this.app.fileManager.processFrontMatter(hostFile, (m: any) => { m.stashpadAppReference = true; });
            } catch { /* the filename check below still covers it */ }
          }
          for (const h of helpers) {
            await this.createNoteUnder(`# ${h.title}\n\n${h.body}`, hostId, {
              record: false, deferRender: true, collectInto: collected,
            });
          }
        }
      }
    } finally {
      // These two are the "settling" the user sees as flicker: the frontmatter
      // queue draining and the tree rebuilding. Naming them beats an idle window.
      // The linking phase is the long one and it used to sit on a single frozen
      // line, which reads as "hung" rather than "working". fmSync exposes its
      // queue depth, so report it - and say plainly that it is safe to wait.
      const linkTotal = this.fmSync.pendingCount();
      const linkTicker = window.setInterval(() => {
        const left = this.fmSync.pendingCount();
        const done = Math.max(0, linkTotal - left);
        tick(total, linkTotal
          ? `linking notes to their parents — ${done.toLocaleString()} of ${linkTotal.toLocaleString()} · safe to leave this running`
          : "linking notes to their parents…");
      }, 400);
      try { await this.fmSync.flush(); } catch { /* best effort */ }
      finally { window.clearInterval(linkTicker); }
      tick(total, "rebuilding the list…");
      this.endBulkRender();
    }

    this.tree.rebuild(folder);
    this.render();
    progress?.hide();
    const made = collected.length;
    const importedIds = createdIds.filter((x): x is StashpadId => !!x);
    this.plugin.notifications.show({
      message: `**Import complete.** ${made} note${made === 1 ? "" : "s"} from the Stashpad app are in **${folder}**, fully linked${failed ? ` (${failed} failed)` : ""}.`,
      kind: failed ? "warning" : "success",
      category: "system",
      affectedIds: importedIds,
      folder,
      duration: 0,
      actions: importedIds.length
        ? [{
            label: "Show imported notes",
            onClick: () => {
              void (async () => {
                await this.plugin.openFolderInStashpad(folder);
                const target = importedIds[0];
                const v = (this.noteFolder === folder && this.viewRoot?.isConnected)
                  ? this
                  : (this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
                      .map((l) => l.view as StashpadView | undefined)
                      .find((x) => x?.noteFolder === folder));
                if (!v) return;
                v.selection.clear();
                for (const id of importedIds) v.selection.add(id);
                const idx = v.currentChildren.findIndex((n) => n.id === target);
                if (idx >= 0) v.cursorIdx = idx;
                v.render();
                v.revealCursorRow();
              })();
            },
          }]
        : undefined,
    });

    const createdPaths = collected.slice();
    this.plugin.getUndoStack(folder).push({
      label: `Import ${made} note${made === 1 ? "" : "s"} from the Stashpad app`,
      undo: async () => {
        for (const { path } of createdPaths) {
          const nf = this.app.vault.getAbstractFileByPath(path) as TFile | null;
          if (nf) { try { await this.app.fileManager.trashFile(nf); } catch { /* ignore */ } }
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.188.0: inline task/color metadata prefix for a COPIED note, so a task
   *  pastes as a real Obsidian checkbox and a note's color (+ its alias) survive
   *  as inline metadata in a plain note. Public so the clipboard commands can
   *  reuse the private task/color getters. Returns the pieces so each copy
   *  format places them correctly relative to its own leading dash:
   *    - `needsDash` — true when the note is a task (a checkbox needs a "- " to
   *      render as a checkbox). Formats that ALREADY emit "- " ignore this.
   *    - `checkbox`  — "[ ] " (incomplete) / "[x] " (completed), or "".
   *    - `meta`      — "[color: #hex | alias: name] " (alias only when the color
   *      has one), or "".
   *  Compose as `<dash?><checkbox><meta><body>`; empty-checkbox keeps the space
   *  between brackets so Obsidian renders it. */
  copyMetaPrefix(node: TreeNode): { needsDash: boolean; checkbox: string; meta: string } {
    const task = this.isTask(node);
    const checkbox = task ? (this.isCompleted(node) ? "[x] " : "[ ] ") : "";
    const color = this.colorForNode(node);
    let meta = "";
    if (color) {
      const alias = this.plugin.getColorAlias(this.noteFolder, color);
      meta = alias ? `[color: ${color} | alias: ${alias}] ` : `[color: ${color}] `;
    }
    return { needsDash: task, checkbox, meta };
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
    const anyCollapsed = targets.some((t) => !this.isNoteExpanded(t.id));
    for (const t of targets) this.setNoteExpanded(t.id, anyCollapsed);
    this.render();
  }

  /** Is this note's body currently shown expanded (un-clamped)?
   *  The expandedNotes Set stores ids that DIFFER from the default:
   *  when expandBodiesByDefault is off (default), membership = expanded;
   *  when on, membership = collapsed. This lets one Set serve both modes. */
  isNoteExpanded(id: StashpadId): boolean {
    const differsFromDefault = this.expandedNotes.has(id);
    return this.plugin.settings.expandBodiesByDefault ? !differsFromDefault : differsFromDefault;
  }

  /** Set a note's expanded/collapsed state, normalizing against the
   *  default so the Set only ever holds the non-default ids. */
  setNoteExpanded(id: StashpadId, expanded: boolean): void {
    const defaultExpanded = this.plugin.settings.expandBodiesByDefault;
    if (expanded === defaultExpanded) this.expandedNotes.delete(id);
    else this.expandedNotes.add(id);
  }

  /** Expand every note in the current list (un-clamp all bodies). */
  cmdExpandAll(): void {
    for (const n of this.currentChildren) this.setNoteExpanded(n.id, true);
    this.render();
  }

  /** Collapse every note in the current list (re-clamp all bodies). */
  cmdCollapseAll(): void {
    for (const n of this.currentChildren) this.setNoteExpanded(n.id, false);
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
    opts: { preserveCreated?: boolean; copyKind?: "fork" } = {},
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

    const cloneId = this.plugin.mintNoteId();
    const slug = bodyToSlug(body, this.activeStopwords());
    const filename = buildFilename(slug, cloneId);
    const path = `${this.noteFolder}/${filename}`;
    const nowIso = new Date().toISOString();
    // With `preserveCreated` (a fork) the copy keeps the source's `created` and
    // records `modified` = now. All other callers (Clone, insert-template, note
    // paste) keep the default new-note `created`.
    const created = opts.preserveCreated && source.created ? source.created : nowIso;
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
            // A duplicate is a NEW note, not a member of the source's version
            // group — never inherit sheet/provenance keys (would falsely mark
            // it original/final or collide on order).
            if (SHEET_COPY_SKIP_KEYS.includes(k)) continue;
            m[k] = v;
          }
          if (opts.preserveCreated) m.modified = nowIso; // edited = when the copy was made
          if (opts.copyKind === "fork") m[FORKED_AT_KEY] = nowIso;
        });
      } catch (e) {
        console.warn("[Stashpad] cloneSubtree: processFrontMatter failed", e);
      }
      // Synthetic insert so the row appears immediately, before metadataCache parses.
      try {
        this.tree.insertSynthetic({
          id: cloneId, parent: newParent, children: [], file: newFile, created,
        });
      } catch { /* ignore */ }
      // Background-sync the new clone's recovery fields + bump the new
      // parent's children list. Cheap enqueue; the queue drains in the
      // background, not blocking the clone loop.
      this.fmSync.scheduleParentChange(cloneId, null, newParent);
    }

    // Recurse into children — each becomes a child of the just-cloned
    // node. 0.67.4: use the pre-insert snapshot, NEVER call
    // getChildren again at this depth.
    for (const c of childrenSnapshot) {
      await this.cloneSubtree(c, cloneId, createdPaths, opts);
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
    const targets = this.getActionTargets();
    if (!targets.length) { new Notice("Nothing to clone."); return; }
    // Collapse nested selections: a descendant already gets cloned inside its
    // selected ancestor's subtree, so cloning it again as a sibling would
    // duplicate it. Same root-filter cmdLockSelection/archiveSources use. 0.140.9
    const ids = new Set(targets.map((t) => t.id));
    const roots = targets.filter((t) => {
      let p = t.parent;
      // 0.210.1: visited-set guarded. A parent cycle in the index (see
      // TreeIndex.wouldCycle) used to make this spin forever and hang Obsidian on
      // the next delete / lock / copy / clone. Bail out treating it as "not a
      // root" rather than looping.
      const seenAnc = new Set<StashpadId>();
      while (p) { if (ids.has(p)) return false; if (seenAnc.has(p)) return false; seenAnc.add(p); p = this.tree.get(p)?.parent ?? null; }
      return true;
    });
    const folder = this.noteFolder;
    const createdPaths: string[] = [];
    const newRootIds: StashpadId[] = [];
    try {
      for (const r of roots) {
        if (!r.file) continue;
        // Sibling of the source: same parent. Falls back to the current
        // focused subtree if the source somehow lacks a parent (shouldn't
        // happen for non-root nodes).
        const parent = r.parent ?? this.focusId;
        const id = await this.cloneSubtree(r, parent, createdPaths);
        if (id) newRootIds.push(id);
      }
    } catch (e) {
      // A mid-loop failure (name collision, adapter error) would otherwise leave
      // already-created clone files with no undo entry. Notice, then fall through
      // so the undo below still covers whatever got created. 0.140.9
      console.warn("[Stashpad] clone failed partway", e);
      new Notice(`Clone stopped early: ${(e as Error).message}`);
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
          if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
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

  /** Fork a single note: duplicate its subtree as a standalone "variant" and
   *  place it under a parent chosen via the picker. The current parent is
   *  named as the default in the placeholder; Esc cancels. Same-folder only
   *  for now (cross-folder forking deferred). NOTE: distinct from the sheet
   *  "Fork as version" (cmdForkVersion) — that makes a draft within a sheet
   *  group; this makes a separate note you can re-home. */
  cmdForkNote(): void {
    const node = this.getActionTargets()[0];
    if (!node?.file) { new Notice("Nothing to fork."); return; }
    const curParent = node.parent ?? ROOT_ID;
    const curNode = curParent === ROOT_ID ? null : this.tree.get(curParent);
    const curLabel = curNode ? this.titleForNode(curNode) : "Home";
    new StashpadSuggest(this.app, this.tree, (n) => this.titleForNode(n), {
      mode: "pick",
      allowCreate: true,
      placeholder: `Fork "${this.titleForNode(node)}" under… (default: ${curLabel})`,
      onPick: (item) => {
        if (item.crossFolder) { new Notice("Fork stays in this folder for now."); return; }
        void this.forkNoteUnder(node, item.id);
      },
      onCreate: (q) => { void (async () => { const id = await this.createNoteUnder(q, this.focusId); if (id) await this.forkNoteUnder(node, id); })(); },
    }).open();
  }

  /** Clone `node`'s subtree under `parentId`, focus the new root, with undo.
   *  Mirrors cmdClone's clone+snapshot+undo machinery for a single node. */
  private async forkNoteUnder(node: TreeNode, parentId: StashpadId): Promise<void> {
    if (!node.file) return;
    const folder = this.noteFolder;
    const createdPaths: string[] = [];
    const newRootId = await this.cloneSubtree(node, parentId, createdPaths, { preserveCreated: true, copyKind: "fork" });
    if (!newRootId) return;
    // Provenance: the forked root records the note it was forked from. (The
    // sheet/origin keys were stripped by cloneSubtree, so this is the only
    // version marker a re-homed fork carries.)
    const rootFile = createdPaths[0] ? this.app.vault.getAbstractFileByPath(createdPaths[0]) as TFile | null : null;
    if (rootFile) {
      try {
        await this.app.fileManager.processFrontMatter(rootFile, (m: any) => { m[FORKED_FROM_KEY] = `[[${node.file!.basename}]]`; });
      } catch { /* ignore */ }
    }
    this.tree.rebuild(folder);
    this.pendingFocusIds = [newRootId];
    this.render();
    // Cross-link the lineage: the origin + all its separate-note forks.
    await this.syncForkSiblings(this.forkFamilyFiles({ originName: node.file.basename, include: [node.file, rootFile] }));
    const snapNodes: TreeNode[] = createdPaths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => !!f && (f as any).extension === "md")
      .map((file) => ({ id: parseIdFromFilename(file.basename) ?? file.basename, parent: null, children: [], file, created: new Date().toISOString() }));
    const snap = await this.snapshotNotes(snapNodes, false);
    this.plugin.getUndoStack(folder).push({
      label: "Fork note",
      undo: async () => {
        for (const p of [...createdPaths].reverse()) {
          const f = this.app.vault.getAbstractFileByPath(p) as TFile | null;
          if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
        }
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => { await this.restoreSnapshots(snap, [newRootId]); },
    });
    const forked = this.tree.get(newRootId);
    this.plugin.notifications.show({
      message: forked
        ? `Forked "${this.titleForNode(node)}" → "${this.titleForNode(forked)}" (${createdPaths.length} file${createdPaths.length === 1 ? "" : "s"})`
        : "Forked note",
      kind: "success",
      category: "clone",
      affectedIds: [newRootId],
      folder,
    });
  }

  // --- Sheet versions ---

  /** Ensure a note carries a `sheet:` group id, stamping a fresh one (and an
   *  initial order of 0) if it doesn't. Returns the group id. */
  private async ensureSheetGroup(file: TFile): Promise<string> {
    const existing = sheetIdOf(this.app.metadataCache.getFileCache(file)?.frontmatter);
    if (existing) return existing;
    const gid = newSheetGroupId();
    await this.app.fileManager.processFrontMatter(file, (m: any) => {
      m[SHEET_KEY] = gid;
      if (typeof m[SHEET_ORDER_KEY] !== "number") m[SHEET_ORDER_KEY] = 0;
      // This note seeded the group → it's the original. Forks never get this.
      m[SHEET_ORIGIN_KEY] = true;
    });
    return gid;
  }

  /** All notes in a fork family: either a sheet group's members (by `gid`) or
   *  a separate-note lineage (the origin `originId` + everything forked from
   *  it). `include` force-adds freshly-written files the cache may still lag. */
  private forkFamilyFiles(opts: { gid?: string | null; originName?: string | null; include?: (TFile | null)[] }): TFile[] {
    const set = new Map<string, TFile>();
    const add = (f: TFile | null) => { if (f) set.set(f.path, f); };
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (opts.gid && sheetIdOf(fm) === opts.gid) add(f);
      if (opts.originName) {
        // The origin note itself, plus everything whose forked-from links to it.
        if (f.basename === opts.originName || forkedFromName(fm) === opts.originName) add(f);
      }
    }
    for (const f of opts.include ?? []) add(f);
    return [...set.values()];
  }

  /** Write each family member's `fork-siblings` to wikilinks of the others. */
  private async syncForkSiblings(family: TFile[]): Promise<void> {
    for (const f of family) {
      const others = family.filter((o) => o.path !== f.path).map((o) => `[[${o.basename}]]`);
      await this.app.fileManager.processFrontMatter(f, (m: any) => {
        if (others.length) m[SIBLINGS_KEY] = others;
        else delete m[SIBLINGS_KEY];
      });
    }
  }

  /** Create a new version of `source` as a sibling sharing its sheet group.
   *  `blank` → empty body; otherwise the source body is duplicated (a fork).
   *  The new version becomes the shown one. Used by the row "+" button, the
   *  context menu, and the command. */
  async cmdForkVersion(source?: TreeNode): Promise<void> {
    // Explicitly invoking a version command opts you in — turn the feature on
    // rather than nagging about a setting.
    if (!this.plugin.settings.enableSheetVersions) {
      this.plugin.settings.enableSheetVersions = true;
      await this.plugin.saveSettings();
      new Notice("Sheet versions enabled.");
    }
    const src = source ?? this.getActionTargets()[0];
    if (!src?.file) { new Notice("Select a note to version."); return; }
    const folder = this.noteFolder;
    // Snapshot the source frontmatter BEFORE ensureSheetGroup mutates it — the
    // metadata cache lags processFrontMatter, so reading it afterward returns
    // stale/partial data (drops color/tags, miscounts order).
    const srcFm = { ...(this.app.metadataCache.getFileCache(src.file)?.frontmatter ?? {}) } as Record<string, any>;
    const gid = await this.ensureSheetGroup(src.file);
    const parent = src.parent ?? this.focusId;

    // Next order = one past the current highest in the group. Start from the
    // source's own order (from the snapshot — its cache entry is now stale),
    // then fold in the other members' cached orders.
    let maxOrder = typeof srcFm[SHEET_ORDER_KEY] === "number" ? srcFm[SHEET_ORDER_KEY] : 0;
    for (const s of this.tree.getChildren(parent)) {
      if (s.id === src.id) continue;
      const fm = nodeFm(this.app, s);
      if (sheetIdOf(fm) !== gid) continue;
      const o = fm?.[SHEET_ORDER_KEY];
      if (typeof o === "number" && o > maxOrder) maxOrder = o;
    }
    const order = maxOrder + 1;

    const createdPaths: string[] = [];
    // Fork: duplicate the whole subtree as a sibling. cloneSubtree already
    // copies color/tags/custom keys and STRIPS the sheet/provenance keys
    // (SHEET_COPY_SKIP_KEYS) from every copied node, so only the new root
    // becomes a version — its children are plain copies.
    const newRootId = await this.cloneSubtree(src, parent, createdPaths, { preserveCreated: true, copyKind: "fork" });
    if (!newRootId || !createdPaths.length) { new Notice("Sheets: could not create version."); return; }
    const rootFile = this.app.vault.getAbstractFileByPath(createdPaths[0]) as TFile | null;
    if (rootFile) {
      await this.app.fileManager.processFrontMatter(rootFile, (m: any) => {
        m[SHEET_KEY] = gid;
        m[SHEET_ORDER_KEY] = order;
        delete m[SHEET_FINAL_KEY];
        delete m[SHEET_ORIGIN_KEY]; // a fork is never the original…
        m[FORKED_FROM_KEY] = `[[${src.file!.basename}]]`; // …and records what it came from
      });
    }

    this.tree.rebuild(folder);
    this.activeVersionByGroup.set(gid, newRootId); // show the new version
    this.plugin.saveActiveVersion(folder, gid, newRootId);
    this.render();

    // Keep every group member's `fork-siblings` list current.
    const newRootFile = this.app.vault.getAbstractFileByPath(createdPaths[0]) as TFile | null;
    await this.syncForkSiblings(this.forkFamilyFiles({ gid, include: [src.file, newRootFile] }));

    this.plugin.getUndoStack(folder).push({
      label: "Fork version",
      undo: async () => {
        for (const p of [...createdPaths].reverse()) {
          const f = this.app.vault.getAbstractFileByPath(p) as TFile | null;
          if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
        }
        this.activeVersionByGroup.delete(gid);
        this.tree.rebuild(folder);
        this.render();
      },
      redo: async () => { /* best-effort: re-running the command recreates it */ },
    });
    const n = createdPaths.length;
    new Notice(`Forked a new version${n > 1 ? ` (${n} notes)` : ""}`);
  }

  /** Toggle the "final" flag on a version, clearing it from its group-mates. */
  async cmdMarkVersionFinal(target?: TreeNode): Promise<void> {
    if (!this.plugin.settings.enableSheetVersions) {
      this.plugin.settings.enableSheetVersions = true;
      await this.plugin.saveSettings();
    }
    const node = target ?? this.getActionTargets()[0];
    if (!node?.file) return;
    const gid = sheetIdOf(nodeFm(this.app, node));
    if (!gid) { new Notice("Not a versioned note."); return; }
    const makeFinal = !sheetIsFinal(nodeFm(this.app, node));
    const parent = node.parent ?? this.focusId;
    const members = this.tree.getChildren(parent)
      .filter((s) => sheetIdOf(nodeFm(this.app, s)) === gid);
    for (const m of members) {
      if (!m.file) continue;
      const wasFinal = sheetIsFinal(nodeFm(this.app, m));
      const shouldBeFinal = makeFinal && m.id === node.id;
      if (wasFinal === shouldBeFinal) continue;
      await this.app.fileManager.processFrontMatter(m.file, (fm: any) => {
        if (shouldBeFinal) fm[SHEET_FINAL_KEY] = true;
        else delete fm[SHEET_FINAL_KEY];
      });
    }
    this.render();
  }

  // ---- 0.99.0: note clipboard — copy / cut / paste of note BLOCKS ----
  // Runs in parallel with the system clipboard: copy/cut also put the bodies
  // on the system clipboard as text (so pasting in the composer or any app
  // works normally); paste IN THE LIST operates on the notes themselves.

  /** 0.209.3: user-facing outcome of the cross-vault clipboard stamp.
   *
   *  The stamp is deliberately async (it reads every file in the selection and
   *  zips them — seconds on a big selection or a network drive), and while it
   *  runs the OS clipboard holds ONLY plain text. In the destination vault the
   *  paste keybinding gates on hasXvPayload(), so pasting during that window
   *  does nothing at all — which users experienced as "mash paste until it
   *  kicks in". The fix is not to make the stamp faster (disk speed is disk
   *  speed) but to make its STATE visible: say when the payload is ready, and
   *  say when it failed instead of leaving a console.warn nobody sees. */
  private reportXvStamp(r: { status: "ok" | "too-big" | "failed" | "empty"; mb?: string }, verb: "copy" | "cut"): void {
    if (r.status === "ok") {
      this.plugin.notifications.show({
        message: `📋 Ready to paste in another vault — ${verb === "cut" ? "cut" : "copied"} from **${this.app.vault.getName()}**.`,
        kind: "success", category: "system", folder: this.noteFolder, duration: 5000,
      });
      return;
    }
    if (r.status === "too-big") { this.offerExportForOversize(r.mb ?? "?"); return; }
    // failed / empty: the plain-text copy still happened; only cross-vault won't work.
    // 0.214.1: through the service, not a plain Notice — a FAILED cross-vault
    // prepare is exactly the kind of event the notification history exists for,
    // and a plain Notice never reaches it.
    this.plugin.notifications.show({
      message: `Couldn't prepare the cross-vault ${verb} from **${this.app.vault.getName()}** — pasting into ANOTHER vault won't work this time. `
        + `The plain text is on the clipboard, and pasting within **${this.app.vault.getName()}** still works. `
        + `(Use Share/Export → .stash file as the reliable route for this selection.)`,
      kind: "error", category: "system", folder: this.noteFolder, duration: 0,
    });
  }

  async cmdCopyNotes(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) { new Notice("Nothing to copy."); return; }
    await clipboardCmds.cmdCopy(this); // bodies → system clipboard (+ toast)
    this.plugin.clearNoteClipboard(); // drop any prior cut/copy (+ its notice)
    this.plugin.noteClipboard = { mode: "copy", folder: this.noteFolder, ids: targets.map((t) => t.id) };
    this.render(); // paint the .is-copy-pending tint
    // 0.214.0: the cross-vault payload is NO LONGER stamped here. Building it
    // reads every note and attachment in the selection (stash-package
    // buildStashZip) and that cost was paid on EVERY copy, for a feature used
    // occasionally — punishing on a large selection or a network drive. It is
    // now an explicit action: cmdCopyForOtherVault. Same-vault copy/paste is
    // unaffected and is what this command is for.
    //
    // 0.214.2: unless the user opts back in. On a fast machine the read cost is
    // unnoticeable and always-on is more convenient than remembering a second
    // command, so the old behaviour is available as a setting.
    if (getSettings().alwaysStampCrossVault) await this.stampForOtherVault(targets.map((t) => t.id), "copy");
  }

  /** 0.214.0: copy AND stamp the cross-vault clipboard payload — the deliberate
   *  version of what plain copy used to do implicitly on every invocation.
   *
   *  The payload is a .stash zip of the whole selected subtree, built by reading
   *  every note and attachment in it, so it is the expensive part of a copy. Now
   *  you only pay it when you actually intend to paste into another vault. */
  async cmdCopyForOtherVault(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) { new Notice("Nothing to copy."); return; }
    await this.cmdCopyNotes();
    // cmdCopyNotes already stamped if the always-on setting is enabled.
    if (!getSettings().alwaysStampCrossVault) await this.stampForOtherVault(targets.map((t) => t.id), "copy");
  }

  /** 0.214.0: cut AND stamp for another vault. The cut half also arms the ACK
   *  handshake (pendingXvCut), which is what later offers to delete the
   *  originals here once the other vault confirms the paste — so a cross-vault
   *  MOVE has to go through this command, not plain cut. */
  async cmdCutForOtherVault(): Promise<void> {
    const targets = this.getActionTargets();
    if (!targets.length) { new Notice("Nothing to cut."); return; }
    await this.cmdCutNotes();
    if (!getSettings().alwaysStampCrossVault) await this.stampForOtherVault(targets.map((t) => t.id), "cut");
  }

  /** Shared tail of the two "for another vault" commands: re-read the plain text
   *  the copy/cut just put on the clipboard so both flavors carry the same
   *  string, then attach the hidden payload alongside it. */
  private async stampForOtherVault(ids: StashpadId[], mode: "copy" | "cut"): Promise<void> {
    let plain = "";
    try {
      const req = (window as unknown as { require?: (m: string) => { clipboard?: { readText?: () => string } } }).require;
      plain = req?.("electron")?.clipboard?.readText?.() ?? "";
    } catch { /* fall through — reported below */ }
    if (!plain) { this.reportXvStamp({ status: "failed" }, mode); return; }
    const notice = new Notice(`Preparing ${ids.length} note${ids.length === 1 ? "" : "s"} for another vault…`, 0);
    try {
      const r = await this.plugin.stampCrossVaultClipboard(this.noteFolder, ids, mode, plain);
      this.reportXvStamp(r, mode);
    } finally {
      notice.hide();
    }
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
    // 0.209.3: Electron-first write (navigator.clipboard rejects when the
    // document is not focused — same lesson as the deep-link auto-paste).
    if (!(await writeClipboardText(cutText))) new Notice("Couldn't write to the clipboard — the cut was not started.", 6000);
    this.plugin.clearNoteClipboard(); // drop any prior cut/copy (+ its notice)
    this.plugin.noteClipboard = { mode: "cut", folder: this.noteFolder, ids: targets.map((t) => t.id), text: cutText };
    this.render(); // paint the ghosted .is-cut-pending rows immediately
    // 0.214.0: no cross-vault stamp here either — see cmdCopyNotes. A
    // cross-vault MOVE goes through cmdCutForOtherVault, which also arms the
    // ACK handshake that later offers to delete the originals. 0.214.2: honoured
    // here too when the user has opted into always stamping.
    if (getSettings().alwaysStampCrossVault) void this.stampForOtherVault(targets.map((t) => t.id), "cut");
    // Persistent: a pending cut is a MODE — the user should see it until they
    // paste or cancel (Escape). Stored so it can be dismissed on resolve.
    // 0.199.x tidy-up: structured, line-per-part message — count of parents
    // (+ their children), a short bulleted list, then the how-to lines.
    const childCount = targets.reduce((n, t) => n + this.countDescendants(t.id), 0);
    const bullets = targets.slice(0, 10).map((t) => {
      const title = (this.titleForNode(t).trim() || "(untitled)");
      return `• **${title.length > 36 ? title.slice(0, 36) + "…" : title}**`;
    });
    if (targets.length > 10) bullets.push(`• …+${targets.length - 10} more`);
    this.plugin.noteClipboardNotice = this.plugin.notifications.show({
      message: [
        `✂️ Cut ${targets.length} note${targets.length === 1 ? "" : "s"}${childCount ? ` (with ${childCount} child${childCount === 1 ? "" : "ren"})` : ""} from **${this.app.vault.getName()}**`,
        ...bullets,
        "Paste in a LIST to move them there; paste in a COMPOSER to insert the text and delete the originals (undoable).",
        "Esc cancels — nothing happens until you paste.",
      ].join("\n"),
      kind: "info", category: "system", affectedIds: targets.map((t) => t.id), folder: this.noteFolder, duration: 0,
    });
  }

  /** 0.201.1: the selection was too big for the clipboard payload — offer the
   *  FULL export modal (so encryption etc. are available) instead. The plain
   *  text copy/cut already happened; only the cross-vault flavor was skipped. */
  private offerExportForOversize(mb: string): void {
    new ConfirmModal(
      this.app,
      "Selection too large for the clipboard",
      `This selection is ${mb} MB with attachments — too big to carry on the clipboard for cross-vault paste.\nThe normal text copy still worked; only the cross-vault payload was skipped.\nTo move this much out of **${this.app.vault.getName()}**, export it as a .stash file (optionally encrypted) and import it in the destination vault.`,
      "Open the export modal",
      (confirmed) => { if (confirmed) void this.cmdExportStash(); },
    ).open();
  }

  /** Number of descendants under `id` (children, grandchildren, …). */
  private countDescendants(id: StashpadId): number {
    let n = 0;
    const stack = [...(this.tree.get(id)?.children ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      n++;
      const node = this.tree.get(cur);
      if (node) stack.push(...node.children);
    }
    return n;
  }

  /** 0.201.0: paste a cross-vault clipboard payload (a .stash zip written by
   *  another vault's copy/cut) as real notes under the paste target. Uses the
   *  same import engine as .stash files — id remap on collision (cut keeps
   *  ids: it's a move in spirit; copy mints fresh ones), attachments deduped
   *  by content, reserved frontmatter stripped (the clipboard is external
   *  transport — same trust level as a .stash from disk, 0.140.6 invariant).
   *  NEVER touches the source vault: a cross-vault cut cannot transactionally
   *  delete over there, so the originals stay and the receipt notice says so. */
  private async pasteCrossVault(xv: { meta: XvMeta; zip: Uint8Array }): Promise<void> {
    // 0.211.6 (L6): the payload is ordinary HTML on the system clipboard, so ANY web
    // page the user copies from can craft one — and `sourceVault` is attacker-chosen
    // text that Stashpad otherwise reports verbatim, so a page can name itself after
    // the user's own vault and have the paste look routine. The writes themselves are
    // already contained (safeZipEntryName blocks zip-slip, stripReserved drops
    // Stashpad-owned frontmatter), so this is about consent, not containment: confirm
    // the FIRST paste from a given source name, then remember it.
    const srcName = (xv.meta.sourceVault ?? "").slice(0, 80);
    const trusted = getSettings().trustedXvSources ?? [];
    if (!trusted.includes(srcName)) {
      const total0 = xv.meta.parents + xv.meta.children;
      const ok = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          "Paste notes from another vault?",
          `The clipboard holds ${total0} note${total0 === 1 ? "" : "s"} claiming to come from the vault **${srcName || "(unnamed)"}**, to be pasted into **${this.app.vault.getName()}**.\n\nStashpad can't verify that name — anything that can write to your clipboard, including a web page you copied from, can set it. Only continue if you just copied these notes from **${srcName || "(unnamed)"}** yourself.`,
          "Paste notes",
          resolve,
        ).open();
      });
      if (!ok) { new Notice("Paste cancelled."); return; }
      const list = [...(this.plugin.settings.trustedXvSources ?? [])];
      if (!list.includes(srcName)) list.push(srcName);
      this.plugin.settings.trustedXvSources = list.slice(-20); // bounded; oldest age out
      await this.plugin.saveSettings();
    }
    const folder = this.noteFolder;
    const cursor = this.currentChildren[this.cursorIdx] ?? null;
    const destParent = ((cursor?.parent ?? this.focusId) ?? ROOT_ID);
    const total = xv.meta.parents + xv.meta.children;
    // 0.212.0: a plain Notice renders a string verbatim, so build a fragment and
    // run the shared tokenizer over it — otherwise the **bold** markers used
    // everywhere else in the cross-vault wording would show as literal asterisks.
    const progress = new Notice(
      boldFragment(`⇄ Receiving ${total} note${total === 1 ? "" : "s"} from **${xv.meta.sourceVault}** into **${this.app.vault.getName()}**…`),
      0,
    );
    try {
      const existingIds = await this.plugin.idsInFolder(folder);
      const summary = await importStashZip(this.app, xv.zip, folder, existingIds, {
        forceNewIds: xv.meta.mode === "copy",
        reparentRootsTo: destParent === ROOT_ID ? null : destParent,
        stripReserved: true,
        dedupeExisting: true,
      });
      if (summary.colorAliases) {
        for (const [hex, name] of Object.entries(summary.colorAliases)) {
          try { await this.plugin.setColorAlias(folder, hex, name); } catch { /* non-fatal */ }
        }
      }
      const newIds = Object.values(summary.idRemap);
      this.tree.rebuild(folder);
      this.pendingFocusIds = newIds.slice();
      this.render();
      // Undo/redo: snapshot the created files (same pattern as same-vault
      // copy-paste) — undo trashes them, redo restores from the snapshot.
      // Paths come from the import summary, NOT the tree — the metadata cache
      // lags fresh creates, so tree-derived paths can silently miss files
      // (caught live: undo stranded a grandchild whose cache entry wasn't in yet).
      const createdPaths = summary.notePaths.slice();
      const snapNodes: TreeNode[] = createdPaths
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => !!f && (f as TFile).extension === "md")
        .map((file) => ({ id: parseIdFromFilename(file.basename) ?? file.basename, parent: null, children: [], file, created: new Date().toISOString() }));
      const snap = await this.snapshotNotes(snapNodes, false);
      this.plugin.getUndoStack(folder).push({
        label: `Paste ${xv.meta.parents} note${xv.meta.parents === 1 ? "" : "s"} from vault ${xv.meta.sourceVault}`,
        undo: async () => {
          for (const p of [...createdPaths].reverse()) {
            const f = this.app.vault.getAbstractFileByPath(p) as TFile | null;
            if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
          }
          this.tree.rebuild(folder);
          this.render();
        },
        redo: async () => { await this.restoreSnapshots(snap, newIds); },
      });
      const lines = [
        `⇄ Pasted ${summary.notesWritten} note${summary.notesWritten === 1 ? "" : "s"} from **${xv.meta.sourceVault}** into **${this.app.vault.getName()}**${summary.attachmentsWritten ? ` (+${summary.attachmentsWritten} attachment${summary.attachmentsWritten === 1 ? "" : "s"})` : ""}.`,
      ];
      if (xv.meta.mode === "cut") {
        // 0.201.1: ACK the cut on the clipboard — when the user switches back
        // to the source vault, ITS Stashpad offers to delete the originals.
        //
        // 0.211.3 — ONLY ack a COMPLETE paste. The ACK is what licenses the source
        // vault to delete the originals, so acking a partial import destroys the only
        // remaining copy of whatever didn't arrive. importStashZip resolves normally
        // when it skips entries (a note with no id in its frontmatter, a missing
        // attachment); previously any non-throwing import acked, so a paste that
        // dropped notes still offered to delete all of them at the source.
        //
        // Deliberately conservative: any warning at all, or fewer notes written than
        // the payload advertised, blocks the ACK. A false "incomplete" costs the user
        // one manual delete in the source vault; a false "complete" costs them notes.
        const expected = xv.meta.parents + xv.meta.children;
        const complete = !summary.warnings.length && summary.notesWritten >= expected;
        const acked = complete && xv.meta.cutToken
          ? writeXvAck(xv.meta.cutToken, this.app.vault.getName())
          : false;
        if (acked) {
          lines.push(`The originals are still in **${xv.meta.sourceVault}**. Switch back there and Stashpad will offer to delete them.`);
        } else if (!complete) {
          lines.push(`⚠️ Only ${summary.notesWritten} of ${expected} notes arrived, so Stashpad will **not** offer to delete the originals in **${xv.meta.sourceVault}** — they're your only copy of what's missing. Check what landed here before removing anything there.`);
        } else {
          lines.push(`Cross-vault cut can't remove the originals — they still exist in **${xv.meta.sourceVault}**, as well as here in **${this.app.vault.getName()}**. Delete them in **${xv.meta.sourceVault}** if you meant to move.`);
        }
      }
      if (summary.warnings.length) lines.push(`${summary.warnings.length} entr${summary.warnings.length === 1 ? "y was" : "ies were"} skipped (see console).`);
      this.plugin.notifications.show({
        message: lines.join("\n"),
        kind: "success", category: "clone", affectedIds: newIds, folder, duration: 0,
      });
    } catch (e) {
      // 0.211.4 (F6): don't claim "nothing was changed" — an import can fail after it
      // has already written notes, and telling the user their vault is untouched when
      // it isn't is worse than admitting uncertainty. Per-note write failures are
      // warnings now rather than throws, so reaching here means the failure was
      // earlier/structural, but a partial write is still possible.
      console.warn("[Stashpad] cross-vault paste failed", e);
      this.plugin.notifications.show({
        message: `Cross-vault paste from **${xv.meta.sourceVault}** into **${this.app.vault.getName()}** failed. `
          + `Some notes may already have been written — check this folder in **${this.app.vault.getName()}** before pasting again, `
          + `and don't delete the originals in **${xv.meta.sourceVault}** yet. See console for details.`,
        kind: "error", category: "import", folder: this.noteFolder, duration: 0,
      });
    } finally {
      progress.hide();
    }
  }

  async cmdPasteNotes(): Promise<void> {
    const clip = this.plugin.noteClipboard;
    if (!clip) {
      // 0.201.0: no local note clipboard — check the OS clipboard for a
      // cross-vault payload written by ANOTHER vault's Stashpad.
      const xv = await readXvPayload();
      if (xv && xv.meta.sourceVault !== this.app.vault.getName()) { await this.pasteCrossVault(xv); return; }
      new Notice("The note clipboard is empty — copy or cut notes first.");
      return;
    }
    // Cross-folder paste: the source notes live in another Stashpad folder, so
    // route through the plugin's bundle-based engine — it carries ATTACHMENTS
    // into this folder's _attachments, mints fresh ids for a copy (keeps them for
    // a cut), and refuses an archive/auto-encrypting destination.
    if (clip.folder !== this.noteFolder) {
      const cursorX = this.currentChildren[this.cursorIdx] ?? null;
      const destParent = ((cursorX?.parent ?? this.focusId) ?? ROOT_ID);
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
    const parentId = ((cursor?.parent ?? this.focusId) ?? ROOT_ID);

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
      await this.moveAcrossThenReorder(nodes.map((n) => n.id), parentId, anchor, "after", "Moved");
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
          if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
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
          if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
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
              if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
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
    // 0.237.0: leaving the level re-blurs anything revealed here, when the
    // setting says reveals are momentary. Signal-like: you looked, you left,
    // it is hidden again.
    if (getSettings().obscureReHides) { this.revealedObscured.clear(); this.mediaRevealedObscured.clear(); }
    // 0.258.0: the heading is about to become a DIFFERENT note, so a cursor
    // parked on it must not silently carry over and target the new one.
    this.cursorOnHeading = false;
    // 0.258.3 (pre-existing): leaving a level clears the SELECTION but used to
    // leave mobile select mode switched on, so you arrived at the new level
    // still in a mode with nothing selected — the ⚡ actions applied to
    // nothing and the only way out was to find the toggle again. Select mode
    // is a per-level activity; changing level ends it.
    if (this.mobileSelectMode) {
      this.mobileSelectMode = false;
      this.firstSelectedId = null;
      // The cluster is rebuilt by the render this navigation triggers, but
      // refresh explicitly so the button's state is right even if a caller
      // navigates without a repaint.
      this.refreshMobileActionsCluster();
    }
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
    if (this.tagFilter && this.tagFilter !== TAG_FILTER_TAGGED && this.tagFilter !== TAG_FILTER_UNTAGGED) {
      // Sentinel modes (Tagged/Untagged) are always valid; only real tags
      // get cleared when the new subtree doesn't contain them.
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
    // 0.122.7 (F2): back/forward changed the cursor — notify so the detail panel
    // re-resolves to the new selection instead of staying pinned to the old one.
    this.plugin.notifyStashpadSelectionChanged();
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
    // 0.122.7 (F2): navigating OUT moves the cursor to the note we exited;
    // notify so the detail panel (pinned to the child we were on) re-resolves to
    // this new selection (the parent) instead of staying on the stale child.
    this.plugin.notifyStashpadSelectionChanged();
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

  /** The first thing a new user actually looks at: an empty Stashpad root.
   *  Says what this pane is, what the composer does, and offers the two ways
   *  out (example content, or the welcome walkthrough). Only rendered at the
   *  root — see the call site for why. */
  private renderRootZeroState(list: HTMLElement): void {
    const zero = list.createDiv({ cls: "stashpad-zerostate" });
    zero.createDiv({ cls: "stashpad-zerostate-title", text: "This Stashpad is empty" });
    zero.createDiv({
      cls: "stashpad-zerostate-body",
      text: "Type in the box below and press Enter — each line becomes a note. Click a note to drill into it and add notes underneath, building a tree you can navigate.",
    });

    const hints = zero.createEl("ul", { cls: "stashpad-zerostate-hints" });
    hints.createEl("li", { text: "Enter adds a note here. Click one to go deeper." });
    hints.createEl("li", { text: "Start a line with [] to make it a task." });
    hints.createEl("li", { text: "Everything is plain markdown in your vault — nothing is locked away." });

    const actions = zero.createDiv({ cls: "stashpad-zerostate-actions" });
    const demoBtn = actions.createEl("button", { text: "Load example content", cls: "mod-cta" });
    // Seed into THIS folder, not a new one. The command-palette version creates a
    // separate "Stashpad demo" so it can't mix examples into someone's real
    // notes — but that reasoning doesn't apply here: this folder is provably
    // empty (it's why the zero-state is on screen), and jumping the user to a
    // different folder after they clicked a button labelled "load example
    // content" would be a surprise.
    demoBtn.addEventListener("click", () => {
      void (async () => {
        demoBtn.disabled = true; // seeding ~35 notes isn't instant
        try {
          const { created } = await seedDemoContent(this.app, this.plugin, this.noteFolder);
          new Notice(`Stashpad: added ${created} example note${created === 1 ? "" : "s"}.`, 6000);
          this.tree.rebuild(this.noteFolder);
          this.render();
        } catch (e) {
          demoBtn.disabled = false;
          new Notice(`Stashpad: couldn't add the example notes — ${e instanceof Error ? e.message : String(e)}`, 0);
        }
      })();
    });
    const helpBtn = actions.createEl("button", { text: "Getting started" });
    helpBtn.addEventListener("click", () => this.plugin.showWelcome());
  }

  // --- Bootstrap ---

  private async bootstrapFolder(): Promise<void> {
    if (this.bootstrappedFolders.has(this.noteFolder)) return;
    // Opening the view CREATES the folder, a Home note and two subfolders if
    // they don't exist. That used to happen with no prompt and no notice — a
    // plugin writing four things into someone's vault while they were still
    // working out what it does. Check first so we can say so afterwards.
    const preexisting = await this.app.vault.adapter.exists(this.noteFolder);
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
    // Tell the user what just appeared in their vault. Only when we actually
    // created the folder — reopening an existing Stashpad must stay silent.
    if (!preexisting) {
      const n = new Notice("", 10000);
      n.noticeEl.createSpan({
        text: `Stashpad created the folder "${this.noteFolder}" with a Home note. It's ordinary markdown — move or delete it whenever.`,
      });
    }
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

    // 0.266.9: the loop above asks the METADATA CACHE for each file's id, and
    // the cache has not parsed a file that was written moments ago — so right
    // after a folder is created it reports "no home note" for a home note that
    // is already on disk. That is how a brand-new Stashpad ended up with two
    // notes carrying id __root__.
    //
    // The path is knowable without the cache, so check it directly. This also
    // keeps `vault.create` below from throwing "file already exists" now that
    // createNewStashpad writes this very filename.
    const existing = this.app.vault.getAbstractFileByPath(desiredPath);
    if (existing instanceof TFile) return existing;

    // Same cold-cache window, but for a home note written under an OLDER name
    // (a bare `Home.md`, which is what createNewStashpad produced before
    // 0.266.9). The loop above would adopt and rename it once the cache warms;
    // in the meantime it is invisible, and creating alongside it is what makes
    // the duplicate. Read the frontmatter off disk to settle it.
    //
    // Bounded deliberately: only files the cache has NO frontmatter for, and
    // only ones named like a home note — so this is a couple of reads on a cold
    // folder, not a scan of every note.
    for (const f of files) {
      if (this.app.metadataCache.getFileCache(f)?.frontmatter) continue;
      if (!/^home\b/i.test(f.basename)) continue;
      try {
        const head = (await this.app.vault.cachedRead(f)).slice(0, 400);
        if (new RegExp(`^id:\\s*["']?${ROOT_ID}["']?\\s*$`, "m").test(head)) return f;
      } catch { /* unreadable — fall through and create */ }
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
    return buildHomeFilename(folder);
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

  /** 0.191.0: open a Stashpad tab focused on `focusId` WITHOUT stealing focus —
   *  used after nesting a note into another note so its new home is one click away
   *  while you keep working. Gated by the openParentTabOnMoveIn setting.
   *
   *  No-ops when the destination is Home/root (nothing meaningful to open) or when a
   *  Stashpad tab is already focused there (so repeated nesting into the same parent
   *  doesn't pile up duplicate tabs). Focus is restored to whatever leaf was active
   *  before, which is what makes it a genuine background tab. */
  async openParentInBackgroundTab(focusId: StashpadId): Promise<void> {
    if (!this.plugin.settings.openParentTabOnMoveIn) return;
    if (!focusId || focusId === ROOT_ID) return;
    const ws = this.app.workspace;
    // Already open on that parent? Leave it alone.
    let existing = false;
    ws.iterateAllLeaves((l) => {
      const v: any = l.view;
      if (v?.getViewType?.() === STASHPAD_VIEW_TYPE && v?.focusId === focusId && v?.noteFolder === this.noteFolder) existing = true;
    });
    if (existing) return;
    const active = ws.activeLeaf;
    try {
      const leaf = ws.getLeaf("tab");
      await leaf.setViewState({
        type: STASHPAD_VIEW_TYPE,
        active: false,
        state: { focusId, ...this.timeFilterState(), folderOverride: this.folderOverride },
      });
      // getLeaf("tab") fronts the new tab; hand focus straight back so the move
      // never interrupts the user's place.
      if (active) ws.setActiveLeaf(active, { focus: true });
    } catch (e) {
      console.warn("[Stashpad] background parent tab failed", e);
    }
  }

  /** 0.266.7: what a click on a breadcrumb crumb does.
   *
   *  Plain click navigates in place, as before. Mod+click opens the crumb in a
   *  new Stashpad tab — the gesture every other link in Obsidian already uses,
   *  so it needs no discovering. `Keymap.isModEvent` is Obsidian's own test, so
   *  this follows the platform (Cmd on macOS, Ctrl elsewhere) and middle-click
   *  rather than hardcoding a key.
   *
   *  Focus follows the user's preference by construction: openInNewStashpadTab
   *  ends in settleNewTab, which hands focus back when "new tabs open in the
   *  background" is on. */
  private crumbActivate(e: MouseEvent, id: StashpadId): void {
    if (Keymap.isModEvent(e)) {
      e.preventDefault();
      void this.openInNewStashpadTab(id);
      return;
    }
    this.navigateTo(id);
  }

  private async openInNewStashpadTab(focusId: StashpadId): Promise<void> {
    const ws = this.app.workspace;
    const originLeaf = this.leaf;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        focusId,
        ...this.timeFilterState(),
        folderOverride: this.folderOverride,
      },
    });
    ws.setActiveLeaf(leaf, { focus: true });
    ws.revealLeaf(leaf);
    settleNewTab(ws, originLeaf); // 0.199.0 background-tabs behavior
    // 0.57.5: when this spawned tab closes, the originating Stashpad tab
    // regains focus (see returnToOriginOnClose — shared by every opener).
    returnToOriginOnClose(ws, leaf, originLeaf, (ref) => this.plugin.registerEvent(ref));
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
  private async openNoteInNewTab(folder: string, noteId: string, cursorId?: string): Promise<void> {
    const cleaned = (folder || "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned || !noteId) return;
    const settingsFolder = (this.plugin.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "") || "Stashpad";
    const ws = this.app.workspace;
    const originLeaf = this.leaf;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        focusId: noteId,
        folderOverride: cleaned === settingsFolder ? null : cleaned,
        // 0.132.0: "search opens in context" focuses the parent (noteId) and
        // cursors the child (cursorId) once the fresh tab renders.
        ...(cursorId ? { cursorId } : {}),
      },
    });
    ws.setActiveLeaf(leaf, { focus: true });
    ws.revealLeaf(leaf);
    settleNewTab(ws, originLeaf); // 0.199.0 background-tabs behavior
    // 0.133.0: closing the search-opened tab returns to the tab you searched
    // from, not the tab to the right.
    returnToOriginOnClose(ws, leaf, originLeaf, (ref) => this.plugin.registerEvent(ref));
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
    ws.setActiveLeaf(leaf, { focus: true });
    ws.revealLeaf(leaf);
    settleNewTab(ws, originLeaf); // 0.199.0 background-tabs behavior
    // When the spawned leaf closes, restore focus to the originating tab.
    returnToOriginOnClose(ws, leaf, originLeaf, (ref) => this.plugin.registerEvent(ref));
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

  /** Copy an `obsidian://stashpad?…` deep link to the cursor row (or first
   *  selected note). Paste it anywhere — clicking it lands back on this exact
   *  note. Uses the note's stable frontmatter `id`, so it survives renames. */
  async cmdCopyStashpadLink(node?: TreeNode): Promise<void> {
    // A specific node (right-click) links just that note; otherwise link EVERY
    // action target — so a multi-selection (⚡ menu / hotkey) copies one deep
    // link per selected note, newline-separated, rather than only the first.
    const targets = node ? [node] : this.getActionTargets();
    const valid = targets.filter((t) => !!t?.id);
    if (valid.length === 0) { new Notice("No note selected to link to."); return; }
    const links = valid.map((t) => buildStashpadLink({
      vault: this.app.vault.getName(),
      folder: this.noteFolder,
      note: t.id,
      run: ["reveal"],
    }));
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      new Notice(links.length > 1 ? `${links.length} Stashpad links copied.` : "Stashpad link copied.");
    } catch {
      new Notice("Couldn't copy the link to the clipboard.");
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
    // 0.269.0: this IS "open in the Obsidian editor", so it must reach the
    // editor even when notes are being routed into Stashpad. Stamped before
    // openFile so the router sees the mark on the very first file-open event.
    this.plugin.markEditorBypass(leaf, file);
    await leaf.openFile(file, { active: true });
    ws.setActiveLeaf(leaf, { focus: true });
    ws.revealLeaf(leaf);

    // When the edit tab closes, reveal the originating Stashpad leaf instead
    // of whatever Obsidian picked (the tab to the right).
    returnToOriginOnClose(ws, leaf, originLeaf, (ref) => this.plugin.registerEvent(ref));

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
      } catch { /* ignore */ }
    });
  }

  /** T key. Opens the cursor row (or focused note) in a new Stashpad tab focused on it. */
  /** Mod+Enter: toggle the "completed" frontmatter flag on selected/cursor/focused notes.
   *  When true, the row body renders with a strikethrough. */
  /** 0.210.2: split a note's raw text into (frontmatter, body), REFUSING when the
   *  frontmatter block is unterminated.
   *
   *  `md.slice(0, md.indexOf("\n---", 3) + 4)` returns `"---"` when there is no
   *  closing fence, because indexOf gives -1 and -1 + 4 = 3. Writing that back
   *  produced `---\n<body>` — an unterminated block — so the note lost `id`,
   *  `parent`, `created` and `attachments`, dropped out of the tree, and became an
   *  unparented orphan. The merge path already guards this (the 0.140.9 fix); the
   *  edit and split paths did not.
   *
   *  Reachable whenever a read catches a partially-written file (network share,
   *  sync mid-write) or a note whose frontmatter was already truncated. Returns
   *  null to mean "do not write". */
  private splitFrontmatterForWrite(md: string, path: string): { fm: string; body: string } | null {
    if (!md.startsWith("---")) return { fm: "", body: md };
    const close = md.indexOf("\n---", 3);
    if (close < 0) {
      new Notice(
        `Can't save “${path}” — its frontmatter block is missing a closing "---".\n`
        + "Saving would strip the note's id and parent and detach it from the tree. "
        + "Nothing was written; fix the frontmatter in the Obsidian editor first.",
        0,
      );
      return null;
    }
    return { fm: md.slice(0, close + 4), body: md.slice(close + 4) };
  }

  /** 0.209.9: reveal the selected notes in the OS file manager.
   *
   *  Desktop only — `shell.showItemInFolder` is an Electron API and there is no
   *  mobile equivalent, so the command hides itself there rather than failing.
   *
   *  One window per DISTINCT PARENT FOLDER, not one per note. Revealing 12 notes
   *  from the same folder should not open 12 identical Finder windows; the OS
   *  selects the item within a folder it already has open, so per-note calls to
   *  the same directory just fight each other. Notes spread across folders DO get
   *  a window each, which is the case the user asked for.
   *
   *  Capped, and the cap is REPORTED rather than silently applied — opening 40
   *  windows because someone hit Select All is not a feature. */
  async cmdRevealInFileManager(): Promise<void> {
    if (Platform.isMobile) { new Notice("Revealing files needs a desktop app."); return; }
    const targets = this.getActionTargets().filter((t) => !!t.file);
    if (!targets.length) { new Notice("Select one or more notes first."); return; }
    const shell = (window as unknown as { require?: (m: string) => { shell?: { showItemInFolder?: (p: string) => void } } })
      .require?.("electron")?.shell;
    if (!shell?.showItemInFolder) { new Notice("Couldn't reach the file manager on this platform."); return; }
    const adapter = this.app.vault.adapter as unknown as { getFullPath?: (p: string) => string };

    // One representative note per parent folder, preserving list order.
    const byFolder = new Map<string, string>();
    for (const t of targets) {
      const path = t.file!.path;
      const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      if (!byFolder.has(dir)) byFolder.set(dir, path);
    }
    const MAX_WINDOWS = 8;
    const picks = [...byFolder.values()];
    const opening = picks.slice(0, MAX_WINDOWS);
    let opened = 0;
    for (const rel of opening) {
      try {
        const full = adapter?.getFullPath?.(rel);
        if (full) { shell.showItemInFolder(full); opened++; }
      } catch (e) { console.warn("[Stashpad] showItemInFolder failed", e); }
    }
    const noteWord = `${targets.length} note${targets.length === 1 ? "" : "s"}`;
    if (opened === 0) { new Notice("Couldn't reveal those notes — see the console."); return; }
    const skipped = picks.length - opening.length;
    new Notice(
      `Revealed ${noteWord} in ${opened} folder${opened === 1 ? "" : "s"}.`
      + (skipped > 0 ? ` ${skipped} more folder${skipped === 1 ? "" : "s"} not opened (limit ${MAX_WINDOWS}).` : ""),
      skipped > 0 ? 8000 : 4000,
    );
  }

  /** 0.209.2: read-only snapshot of the selection pipeline, for diagnosing
   *  "select-all missed some notes" reports.
   *
   *  Deliberately mutates NOTHING — the whole point is to run it immediately
   *  after a bad Mod+A and see the state that produced it. It reports each
   *  stage separately so the shortfall can be attributed instead of guessed:
   *
   *    files on disk -> tree -> currentChildren -> selection -> action targets
   *
   *  The two counts that matter most are `selectedNotInTree` and
   *  `selectedWithoutFile`: getActionTargets() drops any selected id whose node
   *  is missing or has no `.file` (a synthetic row whose metadata-cache entry
   *  has not landed yet), which is exactly how a note can look selected and
   *  still not be acted on. A gap at `currentChildren` instead points at a
   *  filter or the view mode; a gap at `tree` points at indexing. */
  selectionDiagnostics(): Record<string, unknown> {
    const focused = this.tree.get(this.focusId);
    const ids = [...this.selection];
    const nodes = ids.map((id) => this.tree.get(id));
    const folderPrefix = this.noteFolder.replace(/\/+$/, "") + "/";
    const onDisk = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(folderPrefix)).length;
    return {
      folder: this.noteFolder,
      focusId: this.focusId,
      viewMode: this.currentViewMode(),
      // A filter runs BEFORE selection, so an active one legitimately shrinks
      // the set — worth seeing before calling anything a bug.
      filtersActive: {
        tag: this.tagFilter ?? null,
        color: this.colorFilter ?? null,
        time: this.timeFilterLongLabel(),
        hideCompleted: this.currentHideCompleted(),
        hideChildless: this.currentHideChildless(),
        attachmentsOnly: this.currentAttachmentsOnly(),
        importedOnly: this.importedOnly,
        author: this.authorFilter ?? null,
      },
      mdFilesUnderFolder: onDisk,
      treeChildrenOfFocus: focused ? this.tree.getChildren(this.focusId).length : null,
      currentChildren: this.currentChildren.length,
      selectionSize: this.selection.size,
      actionTargets: this.getActionTargets().length,
      selectedNotInTree: nodes.filter((n) => !n).length,
      selectedWithoutFile: nodes.filter((n) => !!n && !n.file).length,
      domRows: this.listEl?.querySelectorAll(".stashpad-note").length ?? 0,
      domSelected: this.listEl?.querySelectorAll(".stashpad-note.is-selected").length ?? 0,
      pluginVersion: this.plugin.manifest.version,
    };
  }

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

  /** Which END of the sibling list this note is pinned to, or null if unpinned.
   *  0.270.0: `listPinned` accepts "top" | "bottom"; legacy `true` reads as
   *  "top" so notes pinned before this release keep their behavior. */
  listPinEdge(id: StashpadId): ListPinEdge | null {
    const node = this.tree.get(id);
    if (!node?.file) return null;
    const ov = this.listPinnedState.get(node.file.path);
    if (ov) return ov.pinned ? (ov.edge ?? "top") : null;
    const raw = this.app.metadataCache.getFileCache(node.file)?.frontmatter?.listPinned;
    if (raw === true || raw === "top") return "top";
    if (raw === "bottom") return "bottom";
    return null;
  }

  /** Pinned in EITHER sense: floated in this list, or pinned to the sidebar
   *  panel. Backs the "pinned notes ignore filters" rule. Granularity (letting
   *  the two pin kinds behave differently here) is a deliberate TODO. */
  isPinnedAnyKind(id: StashpadId): boolean {
    if (this.isListPinned(id)) return true;
    return this.plugin.isPinned({ folder: this.noteFolder, id });
  }

  /** Is this note list-pinned (floated to either end of its sibling list)?
   *  Distinct from the sidebar pin (plugin.isPinned). Reads frontmatter. */
  isListPinned(id: StashpadId): boolean {
    return this.listPinEdge(id) !== null;
  }
  private listPinnedAt(id: StashpadId): number {
    const node = this.tree.get(id);
    if (!node?.file) return 0;
    const ov = this.listPinnedState.get(node.file.path);
    if (ov) return ov.at;
    const v = this.app.metadataCache.getFileCache(node.file)?.frontmatter?.listPinnedAt;
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? 0 : t;
  }
  /** Float list-pinned children to the ends of `base` (in pin order): notes
   *  pinned "top" lead, notes pinned "bottom" trail. Returns `base` unchanged
   *  when nothing in this parent is pinned — so unpinned lists keep EXACTLY
   *  their prior ordering/behavior (zero regression risk). */
  private hoistListPinned(parentId: StashpadId, base: StashpadId[]): StashpadId[] {
    const childIds = this.tree.getChildren(parentId).map((n) => n.id);
    if (!childIds.some((id) => this.isListPinned(id))) return base;
    // base may be empty (manual order unset) — fall back to the tree's order.
    const seen = new Set(base);
    const full = [...base, ...childIds.filter((id) => !seen.has(id))];
    const byPinTime = (a: StashpadId, b: StashpadId) => this.listPinnedAt(a) - this.listPinnedAt(b);
    const top = full.filter((id) => this.listPinEdge(id) === "top").sort(byPinTime);
    const bottom = full.filter((id) => this.listPinEdge(id) === "bottom").sort(byPinTime);
    const rest = full.filter((id) => this.listPinEdge(id) === null);
    return [...top, ...rest, ...bottom];
  }

  /** Toggle the list pin on the action targets, at either END of the list.
   *  Distinct from the sidebar pin (cmdTogglePin). Writes listPinned/
   *  listPinnedAt + undo. Re-running with the SAME edge unpins; running with
   *  the other edge MOVES the pin across rather than unpinning. */
  async cmdToggleListPin(edge: ListPinEdge = "top"): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to pin."); return; }
    // Pin when anything isn't already pinned to THIS edge (so "pin to bottom"
    // on a top-pinned note moves it down instead of unpinning it).
    const anyUnpinned = targets.some((t) => this.listPinEdge(t.id) !== edge);
    const prior: { path: string; listPinned: unknown; listPinnedAt: unknown }[] = [];
    const stamp = new Date().toISOString();
    const changed: StashpadId[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const fm = this.app.metadataCache.getFileCache(t.file)?.frontmatter as any;
      prior.push({ path: t.file.path, listPinned: fm?.listPinned, listPinnedAt: fm?.listPinnedAt });
      const at = anyUnpinned ? (typeof fm?.listPinnedAt === "string" ? Date.parse(fm.listPinnedAt) || Date.parse(stamp) : Date.parse(stamp)) : 0;
      // Override now so the re-sort below reflects the new state immediately
      // (the metadata cache lags the frontmatter write by a tick).
      this.listPinnedState.set(t.file.path, { pinned: anyUnpinned, at, edge });
      await this.app.fileManager.processFrontMatter(t.file, (m) => {
        if (anyUnpinned) { m.listPinned = edge; if (!m.listPinnedAt) m.listPinnedAt = stamp; }
        else { delete m.listPinned; delete m.listPinnedAt; }
      });
      changed.push(t.id);
    }
    const folder = this.noteFolder;
    this.tree.rebuild(folder);
    this.render();
    this.plugin.notifications.show({
      message: anyUnpinned ? `Pinned ${changed.length} to ${edge} of list` : `Unpinned ${changed.length} from list`,
      kind: "success", category: "edit", affectedIds: changed, folder,
    });
    this.plugin.getUndoStack(folder).push({
      label: anyUnpinned ? `Pin to ${edge} (${changed.length})` : `Unpin from ${edge} (${changed.length})`,
      undo: async () => {
        for (const p of prior) {
          const f = this.app.vault.getAbstractFileByPath(p.path) as TFile | null;
          if (!f) continue;
          await this.app.fileManager.processFrontMatter(f, (m) => {
            if (p.listPinned === undefined) delete m.listPinned; else m.listPinned = p.listPinned;
            if (p.listPinnedAt === undefined) delete m.listPinnedAt; else m.listPinnedAt = p.listPinnedAt;
          });
          const priorEdge: ListPinEdge | null =
            p.listPinned === true || p.listPinned === "top" ? "top"
            : p.listPinned === "bottom" ? "bottom" : null;
          const at = typeof p.listPinnedAt === "string" ? (Date.parse(p.listPinnedAt) || 0) : 0;
          this.listPinnedState.set(p.path, { pinned: priorEdge !== null, at, edge: priorEdge ?? undefined });
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
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
    // 0.140.1: capture the pre-toggle due + whether it rolled, so undo/redo can
    // reverse a recurrence roll (not just the `completed` flag).
    const priorStates: { id: StashpadId; path: string; was: boolean; dueBefore: string | null; rolledTo: string | null }[] = [];

    const changedIds: StashpadId[] = [];
    const rolled: Array<{ title: string; when: number }> = []; // recurring tasks rescheduled
    // 0.197.0: occurrences spawned for the next interval, and notes whose completion
    // should also be filed into archive/ (repeatMode "archive").
    let spawned = 0;
    const archivedSnapshots: Array<{ file: TFile; dueIso: string | null }> = [];
    for (const t of targets) {
      if (!t.file) continue;
      const was = this.isCompleted(t);
      const rec0 = this.app.metadataCache.getFileCache(t.file)?.frontmatter;
      const dueBefore = rec0?.due != null ? String(rec0.due) : null;
      const ps = { id: t.id, path: t.file.path, was, dueBefore, rolledTo: null as string | null };
      priorStates.push(ps);
      if (was === newState) continue;
      let didRoll = false;
      // 0.197.0: what completing a repeating task does now depends on its repeat
      // MODE. rollForward re-dates this note (historic behaviour, no history);
      // complete/interval leave this occurrence done and spawn the next one;
      // archive re-dates the live note but files a completed copy in archive/.
      let spawnNextIso: string | null = null;
      let archiveThis = false;
      // 0.224.0: `repainted: true`. This path updates the affected rows itself
      // (repaintCompletedState below) or does its own full render when the
      // change is structural — either way the follow-up re-render onFileModify
      // would otherwise schedule is redundant, and that is the render whose
      // anchor restore lands slightly off and scrolls the list.
      this.markFmSelfWrite(t.file.path, true); // body unchanged → no placeholder flash
      await this.app.fileManager.processFrontMatter(t.file, (fm) => {
        const rec = newState ? parseRecurrence(fm.repeat as string | undefined) : null;
        const mode = parseRepeatMode(fm.repeatMode);
        if (rec) {
          const oldDue = fm.due != null ? Date.parse(String(fm.due)) : NaN;
          const next = nextDueOnComplete(rec, Number.isFinite(oldDue) ? oldDue : null, Date.now());
          const nextIso = new Date(next).toISOString();
          if (mode === "complete" || mode === "interval") {
            // This occurrence is genuinely finished — it stays completed, and a
            // fresh incomplete one is created for the next interval.
            writeCompletedFm(fm, true);
            delete fm.missed;
            spawnNextIso = nextIso;
          } else {
            // rollForward / archive: the same note moves to the next date.
            fm.due = nextIso;
            delete fm.completed;
            ps.rolledTo = nextIso;
            didRoll = true;
            if (mode === "archive") archiveThis = true;
          }
          rolled.push({ title: (t.file!.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim()) || "task", when: next });
        } else writeCompletedFm(fm, newState);
      });
      if (spawnNextIso) {
        const made = await spawnNextOccurrence(this.app, t.file, spawnNextIso, () => this.plugin.mintNoteId());
        if (made) spawned++;
      }
      if (archiveThis) archivedSnapshots.push({ file: t.file, dueIso: ps.dueBefore });
      // A rolled task is NOT completed — reflect its real (incomplete) state.
      this.completedState.set(t.file.path, didRoll ? false : newState);
      changedIds.push(t.id);
    }
    // repeatMode "archive": file the completed snapshot after the live note rolled.
    for (const a of archivedSnapshots) await archiveOccurrenceSnapshot(this.app, a.file, a.dueIso, () => this.plugin.mintNoteId());
    // 0.224.0: toggling completion is usually just a checkbox glyph + a class,
    // so repaint in place instead of rebuilding the list (which is what made
    // the list jump on mobile — colours and mark-as-task were already fixed in
    // 0.218.0, this path was simply missed).
    //
    // A full render IS still required when the change is structural:
    //   - "hide completed" is on, so the row must actually leave the list
    //   - a recurring task rolled / spawned a next occurrence / archived a
    //     snapshot — those add or re-date rows
    // repaintCompletedState also self-reports false (off-screen row, no
    // checkbox), so an unhandled case degrades to the old behaviour, never to
    // a stale row.
    const structural = this.currentHideCompleted()
      || rolled.length > 0 || spawned > 0 || archivedSnapshots.length > 0;
    if (structural || !this.repaintCompletedState(changedIds)) this.render();
    for (const r of rolled) {
      const verb = spawned > 0 ? "Next up" : "Rescheduled";
      this.plugin.notifications.show({ message: `🔁 ${verb}: “${r.title}” → ${formatDateTime(r.when, this.plugin.settings)}.`, kind: "success", category: "system", folder: this.noteFolder });
    }
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
            if (p.rolledTo != null) {
              // 0.140.1: reverse a recurrence roll — restore the old due, keep
              // it an active (incomplete) task.
              if (p.dueBefore != null) fm.due = p.dueBefore; else delete fm.due;
              delete fm.completed;
            } else if (p.was) fm.completed = true;
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
            if (p.rolledTo != null) { fm.due = p.rolledTo; delete fm.completed; } // re-roll
            else if (newState) fm.completed = true;
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
  /** 0.267.1: obscured OVERRIDE per path — the same device as completedState
   *  and taskTaggedState, for the same reason.
   *
   *  cmdToggleObscured wrote frontmatter and then re-rendered, while isObscured
   *  read the value straight back out of the metadataCache. The cache has not
   *  reparsed by then, so the render showed the OLD value: obscuring one note
   *  looked like it did nothing, and obscuring five blurred only the ones whose
   *  reparse happened to land first. Exactly the "top two of five" report.
   *
   *  Three-valued like the flag itself: true / false / "absent". Cleared by the
   *  metadataCache "changed" listener once the real value catches up. */
  private obscuredState = new Map<string, boolean | "absent">();
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

  /** 0.105.0: list-pin override per path (pinned flag + pin timestamp), so a
   *  pin/unpin re-sorts the list on THIS render rather than n+1 (the metadata
   *  cache lags a frontmatter write). Reads fall back to the live cache when
   *  there's no override. */
  private listPinnedState = new Map<string, { pinned: boolean; at: number; edge?: ListPinEdge }>();

  /** 0.197.0: was this occurrence closed out as MISSED (interval elapsed unfinished)
   *  rather than actually completed? Frontmatter-backed so it survives body edits. */
  isMissed(node: TreeNode): boolean {
    if (!node.file) return false;
    const fm = this.app.metadataCache.getFileCache(node.file)?.frontmatter as { missed?: unknown } | undefined;
    return fm?.missed === true;
  }

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
  cmdSetDue(node?: TreeNode): void {
    let targets: TreeNode[];
    if (node) targets = [node];
    else {
      targets = this.getActionTargets();
      if (targets.length === 0) {
        const focused = this.tree.get(this.focusId);
        if (focused?.file) targets = [focused];
      }
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
      void this.applyDue(targets, result.iso, result.assignees, false, {
        repeat: result.repeat, autoDoneAfter: result.autoDoneAfter, remindEvery: result.remindEvery, repeatMode: result.repeatMode,
      });
    }, { knownAuthors, currentAssignees, quickAdjusts: this.plugin.settings.dueQuickAdjusts,
      // 0.140.1: recurrence is a per-note concept — only show/write it for a
      // single target, else a multi-select would clobber 2..n's rules with #1's.
      showRecurrence: targets.length === 1,
      currentRepeat: typeof curFm?.repeat === "string" ? curFm.repeat : "",
      currentRepeatMode: typeof curFm?.repeatMode === "string" ? curFm.repeatMode : "",
      currentAutoDoneAfter: typeof curFm?.autoDoneAfter === "string" ? curFm.autoDoneAfter : "",
      currentRemindEvery: typeof curFm?.remindEvery === "string" ? curFm.remindEvery : "",
    }).open();
  }

  /** 0.125.0: Snooze — reschedule a task's due date. Reuses the due-date picker
   *  (date-only: the assignee section is hidden) and writes the new due via
   *  applyDue in dueOnly mode, so existing assignees are preserved. The quick
   *  "+1h / tomorrow / next week" buttons are future work (task-scheduling). */
  cmdSnooze(node?: TreeNode): void {
    let targets: TreeNode[];
    if (node) targets = [node];
    else {
      targets = this.getActionTargets();
      if (targets.length === 0) { const f = this.tree.get(this.focusId); if (f?.file) targets = [f]; }
    }
    if (targets.length === 0) { new Notice("Nothing to snooze."); return; }
    const first = targets[0];
    const curFm = first.file ? this.app.metadataCache.getFileCache(first.file)?.frontmatter as any : null;
    const current = curFm && (typeof curFm.due === "string" || typeof curFm.due === "number") ? String(curFm.due) : null;
    new DueDatePickerModal(this.app, current, (result) => {
      void this.applyDue(targets, result.iso, [], true);
    }, { title: "Snooze — reschedule", hideAssignees: true, quickAdjusts: this.plugin.settings.dueQuickAdjusts }).open();
  }

  /** Write the chosen due value (or clear it) across `targets`, with
   *  undo. Setting a date also flips `task: true`; clearing leaves the
   *  task flag intact (clearing a due ≠ "no longer a task"). */
  private async applyDue(targets: TreeNode[], iso: string | null, assignees: Array<{ id: string; name: string }> = [], dueOnly = false, recur?: { repeat?: string; autoDoneAfter?: string; remindEvery?: string; repeatMode?: string }): Promise<void> {
    const prior: { id: StashpadId; path: string; due: unknown; task: unknown; assignedTo: unknown; assignedBy: unknown; wasTagged: boolean; repeat: unknown; autoDoneAfter: unknown; remindEvery: unknown; repeatMode: unknown }[] = [];
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
      prior.push({ id: t.id, path: t.file.path, due: fm?.due, task: fm?.task, assignedTo: fm?.assignedTo, assignedBy: fm?.assignedBy, wasTagged, repeat: fm?.repeat, autoDoneAfter: fm?.autoDoneAfter, remindEvery: fm?.remindEvery, repeatMode: fm?.repeatMode });
      this.markFmSelfWrite(t.file.path); // body unchanged → no placeholder flash
      await this.app.fileManager.processFrontMatter(t.file, (m) => {
        if (iso === null) delete m.due;
        else { m.due = iso; m.task = true; }
        // 0.140.0: recurrence + reminder fields — an empty string clears the
        // field; a non-empty one sets it (and implies task-ness).
        if (recur) {
          const set3 = (k: "repeat" | "autoDoneAfter" | "remindEvery" | "repeatMode", v?: string) => {
            const val = (v ?? "").trim();
            if (val) { m[k] = val; m.task = true; } else delete m[k];
          };
          set3("repeat", recur.repeat);
          // Only meaningful with a repeat rule; clearing repeat clears the mode too.
          set3("repeatMode", recur.repeat ? recur.repeatMode : "");
          set3("autoDoneAfter", recur.autoDoneAfter);
          set3("remindEvery", recur.remindEvery);
        }
        // 0.125.0: Snooze passes dueOnly — reschedule the due date WITHOUT
        // touching assignees (the plain applyDue would clear them on an empty
        // list). Skip all assignee writes in that mode.
        if (dueOnly) return;
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
            // 0.140.1: restore recurrence/reminder fields too (else undo left them).
            if (p.repeat === undefined) delete m.repeat; else m.repeat = p.repeat;
            if (p.repeatMode === undefined) delete m.repeatMode; else m.repeatMode = p.repeatMode;
            if (p.autoDoneAfter === undefined) delete m.autoDoneAfter; else m.autoDoneAfter = p.autoDoneAfter;
            if (p.remindEvery === undefined) delete m.remindEvery; else m.remindEvery = p.remindEvery;
          });
          this.taskTaggedState.set(p.path, p.wasTagged); // 0.85.1
        }
        this.tree.rebuild(folder);
        this.render();
      },
    });
  }

  /** 0.104.x: "Assign to" opens the SAME unified modal as "Set due date"
   *  (date+time picker + assignee picker). Both commands now share one
   *  modal — only the title differs. Pre-fills the first target's current
   *  due date AND assignees, and commits through applyDue (which flips
   *  `task: true` on any due/assignment — so assigning or scheduling a
   *  plain note auto-converts it to a task). */
  cmdAssign(): void {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to assign."); return; }
    const first = targets[0];
    const curFm = first.file ? this.app.metadataCache.getFileCache(first.file)?.frontmatter as any : null;
    const current = curFm && (typeof curFm.due === "string" || typeof curFm.due === "number") ? String(curFm.due) : null;
    const knownAuthors = this.plugin.collectKnownAuthors();
    const currentAssignees = parseAssignees(curFm ?? {});
    new DueDatePickerModal(this.app, current, (result) => {
      void this.applyDue(targets, result.iso, result.assignees, false, {
        repeat: result.repeat, autoDoneAfter: result.autoDoneAfter, remindEvery: result.remindEvery, repeatMode: result.repeatMode,
      });
    }, { knownAuthors, currentAssignees, title: "Assign / schedule task",
      // 0.155.0: Assign opens the SAME picker as "Set due date" with the full
      // control set — the quick +/- adjust row (was silently missing here) plus
      // recurrence (single-target only; see cmdSetDue). Unifies the two entry
      // points so the modal is identical regardless of how it's opened.
      quickAdjusts: this.plugin.settings.dueQuickAdjusts,
      showRecurrence: targets.length === 1,
      currentRepeat: typeof curFm?.repeat === "string" ? curFm.repeat : "",
      currentRepeatMode: typeof curFm?.repeatMode === "string" ? curFm.repeatMode : "",
      currentAutoDoneAfter: typeof curFm?.autoDoneAfter === "string" ? curFm.autoDoneAfter : "",
      currentRemindEvery: typeof curFm?.remindEvery === "string" ? curFm.remindEvery : "",
    }).open();
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
      this.markFmSelfWrite(t.file.path); // body unchanged → no placeholder flash
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
    // 0.216.4/0.218.0: this one genuinely IS structural — marking a note as a
    // task CREATES its checkbox element (and on mobile can create the meta row
    // that hosts it), so there is no in-place repaint to do; it needs the full
    // render. Hold the scroll across it, since the anchor restore drifts
    // (measured -130px).
    this.traceScroll("mark-as-task");
    const restoreTaskScroll = this.holdListScroll();
    this.render();
    restoreTaskScroll();
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
    // 0.218.0: frontmatter-only, and repainted in place below — mark it so the
    // modify handler neither evicts the render cache nor schedules the render
    // that moves the list.
    this.markFmSelfWrite(path, true);
    /** Prior completion stamp, restored verbatim on undo so re-completing via
     *  undo doesn't falsify WHEN the task was actually finished. 0.273.1 */
    let wasAt: unknown;
    await this.app.fileManager.processFrontMatter(node.file, (m: any) => {
      wasAt = m.completedAt;
      writeCompletedFm(m, !was);
    });
    this.completedState.set(path, !was); // authoritative, pre-cache-event
    await this.log.append({ type: was ? "uncomplete" : "complete", id: node.id });
    // 0.218.0: ticking an EXISTING checkbox swaps an icon and a class — repaint
    // it in place so the list never moves. The note stays a task either way, so
    // the checkbox is already there; the guarded fallback covers the cases the
    // fast path can't see (row scrolled out of the rendered set, no checkbox).
    this.traceScroll("completed");
    if (!this.repaintCompletedState([node.id])) this.render();
    const folder = this.noteFolder;
    this.plugin.getUndoStack(folder).push({
      label: was ? "Mark incomplete" : "Mark complete",
      undo: async () => {
        const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (!f) return;
        this.markFmSelfWrite(path, true);
        await this.app.fileManager.processFrontMatter(f, (m: any) => {
          writeCompletedFm(m, was);
          if (was && wasAt !== undefined) m.completedAt = wasAt;   // restore the real stamp
        });
        this.completedState.set(path, was);
        this.tree.rebuild(folder);
        if (!this.repaintCompletedState([node.id])) this.render();
      },
    });
  }

  /** Tag-only task check (used by the H toggle's decision). Distinct
   *  from isTask, which also counts the bare `completed` field for
   *  panel inclusion. */
  /** 0.237.0: turn `||text||` into a blurred span you tap to reveal.
   *
   *  Applied to the RENDERED DOM rather than the markdown source, walking text
   *  nodes only. That is deliberate: rewriting the source string before
   *  Markdown rendering would let the delimiters land inside a code fence or a
   *  link target, and building the span from an HTML string would trip the
   *  no-raw-HTML security invariant. Walking text nodes cannot touch code, and
   *  creates real elements.
   *
   *  Skips code/pre, so `||` inside a code block stays literal. */
  private applySpoilers(root: HTMLElement): void {
    if (!getSettings().spoilerMarkup) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (!t.nodeValue || !/\|\|[^|]/.test(t.nodeValue)) continue;
      if ((t.parentElement as HTMLElement | null)?.closest("code, pre, .stashpad-spoiler")) continue;
      targets.push(t);
    }
    for (const t of targets) {
      const parts = (t.nodeValue ?? "").split(/\|\|([^|]+)\|\|/g);
      if (parts.length < 3) continue;
      const frag = document.createDocumentFragment();
      parts.forEach((part, i) => {
        if (!part) return;
        // Odd indices are the captured spoiler bodies.
        if (i % 2 === 1) {
          const span = frag.createSpan({ cls: "stashpad-spoiler", text: part });
          span.setAttr("role", "button");
          span.setAttr("tabindex", "0");
          span.setAttr("aria-label", "Hidden text — activate to reveal");
          span.title = "Tap to reveal (visual only)";
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      });
      t.replaceWith(frag);
    }
  }

  /** Copy the code beside Obsidian's own copy button.
   *
   *  The button lives INSIDE the <pre>, as a sibling of the <code>, so read the
   *  <code> rather than the <pre> — `pre.textContent` would swallow the
   *  button's own text and anything else Obsidian puts in there later. */
  private async copyCodeFromButton(btn: HTMLElement): Promise<void> {
    const pre = btn.closest("pre");
    const code = pre?.querySelector("code");
    const text = code?.textContent ?? "";
    if (!text) { new Notice("Nothing to copy."); return; }
    try {
      await navigator.clipboard.writeText(text);
      // Confirm on the button itself, the way Obsidian's own does: a copy you
      // just clicked does not need a toast telling you it happened.
      setIcon(btn, "check");
      btn.setAttr("aria-label", "Copied");
      window.setTimeout(() => { setIcon(btn, "copy"); btn.setAttr("aria-label", "Copy"); }, 1200);
    } catch {
      new Notice("Couldn't copy the code block.");
    }
  }

  /** 0.237.0: is this note marked to render blurred?
   *
   *  0.267.0: three sources can now say so — the note, its folder, and a global
   *  switch — so the PRECEDENCE is written down rather than left to whichever
   *  check happens to run first:
   *
   *    1. an explicit per-note value wins, in both directions;
   *    2. otherwise the folder default;
   *    3. otherwise the global switch.
   *
   *  "In both directions" is what makes this usable. `obscured: false` is now
   *  meaningful rather than merely absent: it is how one note opts OUT of a
   *  folder that is obscured by default, which is the first thing anyone wants
   *  after turning a folder on. Absent still means "no opinion", so existing
   *  notes are unaffected and the flag is only written when the user acts. */
  /** What this folder would do absent any per-note value — folder default,
   *  else the global switch. Used when writing the flag: turning a note OFF
   *  inside an obscured-by-default folder has to write an explicit `false`,
   *  because deleting the key would just fall back to the default and the note
   *  would stay blurred, which reads as the command doing nothing. */
  private defaultObscured(): boolean {
    const s = getSettings();
    const perFolder = s.obscureFolders?.[this.noteFolder.replace(/\/+$/, "")];
    if (typeof perFolder === "boolean") return perFolder;
    // Not the global switch: when that is on, cmdToggleObscured returns early,
    // so this is only ever consulted while the folder default is what matters.
    return false;
  }

  /** The tappable "hidden" badge — it toggles whether the note is SHOWN, and
   *  never whether it is obscured.
   *
   *  0.267.4: it used to un-obscure a hidden note, which meant the control
   *  could delete itself: the badge only exists on an obscured note, so one tap
   *  removed the flag and the badge vanished with no way back from the row.
   *  Reported as "after two toggles the badge disappears completely".
   *
   *  So the badge is now purely a peek switch, which is also what makes it
   *  worth having on a phone: tapping the note BODY reveals too, but the body
   *  is also the double-tap-to-enter target, and a small dedicated control is
   *  not. Changing whether a note is obscured writes to the file, so it stays
   *  a deliberate act in the menu, where all three states are spelled out. */
  private addObscureBadge(host: HTMLElement, node: TreeNode): void {
    const btn = host.createEl("button", { cls: "stashpad-obscure-badge" });
    this.paintObscureBadge(btn, node);
    // 0.267.5: the badge owns its pointer events outright, the same way the
    // task checkbox and the expand toggle already do.
    //
    // Stopping `click` alone is not enough: `dblclick` is a SEPARATE event and
    // fires regardless, so two quick taps on the badge still drilled into the
    // note. Same trap as the callout fold in 0.265.2 — worth stating plainly,
    // since stopping a click feels like it should cover the double.
    //
    // `mousedown` goes too, because that is what starts row selection: without
    // it, tapping the badge selects the row underneath as a side effect.
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleObscureForNode(node);
    };
  }

  /** What the badge SAYS, in one place.
   *
   *  0.267.2: revealing a row deliberately does not re-render — it strips the
   *  class off the element in place, which is what keeps a peek cheap. So the
   *  badge has to be repainted by hand there, or it keeps saying "hidden" on a
   *  note that is plainly visible. Same failure as the context-menu label
   *  offering "Reveal" on an already-revealed note: both read a two-valued
   *  answer out of a three-valued state. */
  private paintObscureBadge(btn: HTMLElement, node: TreeNode): void {
    const revealed = this.revealedObscured.has(node.id);
    btn.toggleClass("is-revealed", revealed);
    btn.textContent = revealed ? "revealed" : "hidden";
    btn.setAttribute("aria-label", revealed ? "Hide this note again" : "Stop obscuring this note");
    btn.title = revealed ? "Hide again (visual only)" : "Stop obscuring this note (visual only)";
  }

  /** Badge action for ONE note, independent of the current selection — the
   *  badge is attached to a specific row, so it must never act on whatever
   *  happens to be selected elsewhere. */
  /** What the MENU item does — which is not what the badge does.
   *
   *  The badge is a peek switch and deliberately never writes. The menu is
   *  where the note's actual state is changed, so it covers all three cases:
   *  a revealed note is hidden again (no write), and otherwise the obscured
   *  flag is flipped. Keeping these separate is what stops the badge from
   *  being able to remove itself. */
  private async menuObscureAction(node: TreeNode): Promise<void> {
    if (this.isObscured(node) && this.revealedObscured.has(node.id)) {
      this.toggleObscureForNode(node);   // hide again; viewing state only
      return;
    }
    const prevSel = new Set(this.selection);
    const prevCursorOnHeading = this.cursorOnHeading;
    this.selection.clear();
    this.selection.add(node.id);
    try { await this.cmdToggleObscured(); }
    finally {
      this.selection.clear();
      for (const id of prevSel) this.selection.add(id);
      this.cursorOnHeading = prevCursorOnHeading;
      this.render();
    }
  }

  private toggleObscureForNode(node: TreeNode): void {
    // The badge is an explicit control, so it reveals/hides FULLY in one tap
    // (text + media) — the gradual two-step is for tapping the blurred body.
    const revealing = !this.revealedObscured.has(node.id);
    if (revealing) { this.revealedObscured.add(node.id); this.mediaRevealedObscured.add(node.id); }
    else { this.revealedObscured.delete(node.id); this.mediaRevealedObscured.delete(node.id); }
    // Repaint the affected row in place rather than re-rendering the list: this
    // is a viewing state, it changes one element, and a full render here would
    // move the list under a finger that just tapped a small target.
    const rowEl = this.listEl?.querySelector<HTMLElement>(`.stashpad-note[data-id="${node.id}"]`) ?? null;
    const headEl = this.containerEl.querySelector<HTMLElement>(`.stashpad-focused[data-heading-id="${node.id}"]`)
      ?? (this.headingNode()?.id === node.id
        ? this.containerEl.querySelector<HTMLElement>(".stashpad-focused")
        : null);
    for (const el of [rowEl, headEl]) {
      if (!el) continue;
      el.toggleClass("is-obscured", !revealing);
      el.removeClass("is-text-revealed");   // full reveal or full hide, never partial
      const badge = el.querySelector<HTMLElement>(".stashpad-obscure-badge");
      if (badge) this.paintObscureBadge(badge, node);
    }
  }

  /** 0.267.9: measure real scroll frame times in THIS view, on THIS device.
   *
   *  Desktop showed the blur costing nothing — 16.7ms either way with 126
   *  covered rows — but a phone has far less compositing memory and GPU fill
   *  rate, and `filter: blur()` spends both. That question cannot be answered
   *  from a laptop, and "does it feel smooth?" is not an answer either.
   *
   *  So: an identical, programmatic sweep that anyone can run twice — once
   *  covered, once not — producing numbers that can be compared. Frame DELTAS
   *  during a real scroll, because that captures paint and compositing, which
   *  is where a blur actually costs; a synchronous layout loop would miss it.
   *
   *  Reports the row and blurred counts alongside, since a comparison between
   *  two runs showing different amounts on screen would be meaningless. */
  async cmdMeasureScrollPerf(): Promise<void> {
    const list = this.listEl;
    if (!list) { new Notice("Open a Stashpad list first."); return; }
    const maxTop = list.scrollHeight - list.clientHeight;
    if (maxTop < 40) {
      new Notice("This list is too short to scroll — open a folder with more notes and try again.", 6000);
      return;
    }
    new Notice("Measuring… don't touch the screen for a few seconds.", 4000);
    const startTop = list.scrollTop;
    const times: number[] = [];
    await new Promise<void>((done) => {
      let last = performance.now(), n = 0, dir = 1;
      const step = (): void => {
        const now = performance.now();
        times.push(now - last);
        last = now;
        list.scrollTop += dir * 60;
        if (list.scrollTop <= 0 || list.scrollTop >= maxTop - 1) dir *= -1;
        if (++n < 90) window.requestAnimationFrame(step);
        else done();
      };
      window.requestAnimationFrame(step);
    });
    list.scrollTop = startTop;
    // Drop the first frame: it carries the cost of starting, not of scrolling.
    const f = times.slice(1).sort((a, b) => a - b);
    const at = (q: number): number => Math.round(f[Math.min(f.length - 1, Math.floor(f.length * q))] * 10) / 10;
    const covered = this.containerEl.querySelectorAll(".is-obscured").length;
    const rows = this.containerEl.querySelectorAll(".stashpad-note").length;
    const result = {
      coverOn: this.plugin.getObscureAll() ? 1 : 0,
      rows, covered,
      median: at(0.5), p90: at(0.9), worst: Math.round(f[f.length - 1] * 10) / 10,
      frames: f.length,
    };
    this.plugin.trace("perf:scroll", result);
    new Notice(
      `Scroll: median ${result.median}ms · p90 ${result.p90}ms · worst ${result.worst}ms\n`
      + `${rows} rows, ${covered} covered, cover ${result.coverOn ? "ON" : "OFF"}`,
      12000,
    );
  }

  /** Drop every "I peeked at this" reveal in THIS view. Called when the obscure
   *  settings change, so a switch turned on covers notes revealed before it. */
  clearObscureReveals(): void { this.revealedObscured.clear(); this.mediaRevealedObscured.clear(); }

  /** True once a note is FULLY revealed (text + media), so it should no longer
   *  carry `is-obscured`. */
  private isFullyRevealed(id: StashpadId): boolean { return this.mediaRevealedObscured.has(id); }

  /** Does this revealed element hold anything that needs the second (media)
   *  step — a real blurred image/embed, or an image chip in the rail? */
  private hasBlurrableMedia(el: HTMLElement): boolean {
    return !!el.querySelector(
      ".stashpad-note-body :is(img, svg, video, canvas, iframe, .internal-embed),"
      + " .stashpad-focused-body :is(img, svg, video, canvas, iframe, .internal-embed),"
      + " .stashpad-rail .stashpad-att-img",
    );
  }

  /** Advance the two-step reveal for `node`, updating `el`'s classes in place
   *  (no re-render — a peek stays cheap). First call reveals text; second
   *  reveals media. A note with no media is fully revealed in one call. */
  private advanceObscureReveal(node: TreeNode, el: HTMLElement): void {
    if (!this.revealedObscured.has(node.id)) {
      this.revealedObscured.add(node.id);
      // Solid-cover mode paints one opaque bar over everything, so a text-only
      // step would reveal nothing — reveal fully in one tap there. Blur mode
      // gets the two-step (text, then media) when the note has media.
      const twoStep = getSettings().obscureStyle !== "solid" && this.hasBlurrableMedia(el);
      if (twoStep) {
        el.addClass("is-text-revealed");           // text shown, media still blurred
      } else {
        this.mediaRevealedObscured.add(node.id);   // nothing more to show
        el.removeClass("is-obscured");
      }
    } else if (!this.mediaRevealedObscured.has(node.id)) {
      this.mediaRevealedObscured.add(node.id);
      el.removeClass("is-obscured");
      el.removeClass("is-text-revealed");
    }
    const badge = el.querySelector<HTMLElement>(".stashpad-obscure-badge");
    if (badge) this.paintObscureBadge(badge, node);
  }

  isObscured(node: TreeNode): boolean {
    if (!node.file) return false;
    const s = getSettings();
    // 0.267.7: the global switch is an OVERRIDE, checked FIRST — not a
    // fallback checked last.
    //
    // It used to sit at the bottom of the chain, so any note carrying an
    // explicit `obscured: false` stayed readable through it. Measured: with the
    // switch on, four of five rows covered and the opted-out one did not. That
    // is the switch failing at the only job it has. "Cover everything" has to
    // mean everything, or it cannot be trusted in the moment it exists for —
    // and that moment does not allow for auditing which notes opted out.
    //
    // The cost is real and accepted: while the global switch is on, a folder
    // set to "Never" and a note set to "don't obscure" are both overruled.
    // Both come back exactly as they were the moment it goes off, because
    // neither is modified — the switch outranks them rather than rewriting
    // them.
    if (this.plugin.getObscureAll()) return true;
    const pending = this.obscuredState.get(node.file.path);
    const own = pending !== undefined
      ? (pending === "absent" ? undefined : pending)
      : this.app.metadataCache.getFileCache(node.file)?.frontmatter?.obscured;
    if (own === true || own === false) return own;
    const folder = this.noteFolder.replace(/\/+$/, "");
    const perFolder = s.obscureFolders?.[folder];
    if (typeof perFolder === "boolean") return perFolder;
    return false;
  }

  /** Toggle the obscured flag on the selection.
   *
   *  This is VISUAL ONLY and the UI says so everywhere it is surfaced. The
   *  plaintext stays in the markdown file, in the metadata cache, in search
   *  results, in Obsidian's own editor, in sync, and in every other plugin —
   *  a CSS blur stops someone glancing at your screen and nothing else. Real
   *  privacy is the per-folder encryption feature, which this must never be
   *  confused with; hence "obscure", never "lock" or "encrypt". */
  async cmdToggleObscured(): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing to obscure."); return; }

    // 0.267.7: with the global cover on, nothing per-note can change what you
    // SEE — the switch overrides every note. Writing the flag anyway would look
    // like the command silently failed, so say what is actually going on rather
    // than editing files to no visible effect.
    if (this.plugin.getObscureAll()) {
      new Notice("Everything is covered by the global switch — turn it off to change notes individually.", 6000);
      return;
    }

    // 0.267.0: RE-HIDE first. If a target is obscured and currently revealed,
    // this control's obvious job is to put it back — not to strip the flag and
    // unhide it permanently, which is what it used to do and is very hard to
    // notice you have done.
    //
    // It is also the cheap path: re-hiding is a viewing state, so it touches no
    // file, needs no undo entry, and cannot fail. Only when nothing is revealed
    // does this fall through to actually changing the notes.
    const revealed = targets.filter((t) => this.isObscured(t) && this.revealedObscured.has(t.id));
    if (revealed.length > 0) {
      for (const t of revealed) this.revealedObscured.delete(t.id);
      this.render();
      return;
    }

    const makeObscured = targets.some((t) => !this.isObscured(t));
    const prior: { id: StashpadId; path: string; was: unknown }[] = [];
    for (const t of targets) {
      if (!t.file) continue;
      const fmNow = this.app.metadataCache.getFileCache(t.file)?.frontmatter as any;
      prior.push({ id: t.id, path: t.file.path, was: fmNow?.obscured });
      this.markFmSelfWrite(t.file.path); // body unchanged
      const willBe: boolean | "absent" =
        makeObscured ? true : (this.defaultObscured() ? false : "absent");
      await this.app.fileManager.processFrontMatter(t.file, (m: any) => {
        if (willBe === true) m.obscured = true;
        else if (willBe === false) m.obscured = false;  // explicit opt-out
        else delete m.obscured;
      });
      // Write through BEFORE the render, so what is drawn matches what was
      // just written rather than whatever the cache still believes.
      this.obscuredState.set(t.file.path, willBe);
      // Revealing is a viewing state; turning obscuring ON must clear it, or
      // the note stays visible until you navigate away.
      if (makeObscured) this.revealedObscured.delete(t.id);
    }
    const apply = async (rows: { id: StashpadId; path: string; was: unknown }[]): Promise<void> => {
      for (const r of rows) {
        const f = this.plugin.fileByFrontmatterId(r.id, this.noteFolder)
          ?? this.app.vault.getAbstractFileByPath(r.path);
        if (!(f instanceof TFile)) continue;
        this.markFmSelfWrite(f.path);
        await this.app.fileManager.processFrontMatter(f, (m: any) => {
          // `was` is now three-valued (true / false / absent) since an explicit
          // false is meaningful — restoring it as "absent" would silently
          // re-obscure a note the user had opted out.
          if (r.was === true) m.obscured = true;
          else if (r.was === false) m.obscured = false;
          else delete m.obscured;
        });
        this.obscuredState.set(f.path,
          r.was === true ? true : r.was === false ? false : "absent");
      }
      this.tree.rebuild(this.noteFolder);
      this.render();
    };
    this.plugin.getUndoStack(this.noteFolder).push({
      label: makeObscured
        ? (prior.length === 1 ? "Obscure note" : `Obscure ${prior.length} notes`)
        : (prior.length === 1 ? "Unobscure note" : `Unobscure ${prior.length} notes`),
      undo: () => apply(prior),
      redo: () => apply(prior.map((r) => ({ ...r, was: makeObscured ? true : undefined }))),
    });
    this.render();
    this.plugin.notifications.show({
      message: makeObscured
        ? `Obscured ${prior.length} note${prior.length === 1 ? "" : "s"} — visual only, not encrypted.`
        : `Revealed ${prior.length} note${prior.length === 1 ? "" : "s"}.`,
      kind: "success", category: "system", folder: this.noteFolder,
    });
  }

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
    // 0.187.0: the success-toast verb. "Nested" when dropping/picking INTO a
    // target, "Moved" for a cross-parent before/after drop — clearer than the
    // old generic "Reparented" and matches the confirm dialog's wording.
    verb = "Reparented",
  ): Promise<void> {
    // Capture prior state for undo: each source's old parent + path.
    const priorParents: { id: StashpadId; path: string; oldParent: StashpadId | null }[] = [];
    const affectedParents = new Set<StashpadId>();
    for (const id of sourceIds) {
      const n = this.tree.get(id);
      if (!n?.file) continue;
      priorParents.push({ id, path: n.file.path, oldParent: n.parent });
      affectedParents.add((n.parent ?? ROOT_ID));
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
    const focusTarget: StashpadId = targetIsFocused ? sourceIds[0] : targetParentId;
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
        verb,
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

    // 0.191.0: open the destination parent in a BACKGROUND tab so the moved note's
    // new home is one click away without stealing focus (setting-gated, on by
    // default; no-ops for a move to Home or when that parent is already open).
    void this.openParentInBackgroundTab(targetParentId);

    // Undo: revert each parent change AND restore the order snapshots for every affected parent.
    this.plugin.getUndoStack(folder).push({
      label: `Move + reorder (${sourceIds.length})`,
      undo: async () => {
        for (const p of priorParents) {
          const f = this.fileForNote(p.id, p.path);
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
          const f = this.fileForNote(p.id, p.path);
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
    // Decide which parent the sources will end up under.
    const newParentId = position === "into"
      ? targetId
      : ((targetNode.parent as StashpadId) ?? ROOT_ID);

    // Cycle guard — applies to ALL positions, not just "into" (0.140.4 review).
    // For "before"/"after" the destination parent is targetNode.parent, so
    // dropping a parent adjacent to its own child (newParent === the source) or
    // to a deeper descendant (newParent is a descendant of the source) would
    // write a self-parent / cycle to frontmatter. The tree-index guard would
    // reset it in-memory, but the on-disk `parent` field would still be corrupt.
    for (const src of sourceNodes) {
      if (newParentId === src.id || this.isDescendant(newParentId, src.id)) {
        this.plugin.notifications.show({
          message: `Can't move "${this.titleForNode(src)}" under itself or one of its own descendants — that would create a cycle.`,
          kind: "warning",
          category: "move",
          folder: this.noteFolder,
        });
        return;
      }
    }

    // Detect cross-parent sources (relative to the new destination).
    const isCross = sourceNodes.some((n) => (n.parent ?? ROOT_ID) !== newParentId);
    if (isCross) {
      const settings = getSettings();
      const doMove = async () => {
        if (position === "into") {
          // Append to target's children at the end (no targetId-relative position).
          await this.moveAcrossThenReorder(sourceNodes.map((n) => n.id), newParentId, /*targetId for ordering*/ "", "after", "Nested");
        } else {
          await this.moveAcrossThenReorder(sourceNodes.map((n) => n.id), newParentId, targetId, position, "Moved");
        }
      };
      if (settings.confirmCrossParentDrag) {
        const rawTitle = this.titleForNode(targetNode);
        // 0.184.0: cap the preview + put the target note on its OWN line (the line
        // above and below stay separate) so a long note title doesn't sprawl.
        const targetTitle = rawTitle.length > 120 ? rawTitle.slice(0, 120).trimEnd() + "…" : rawTitle;
        const n = sourceNodes.length;
        const verb = position === "into" ? "Nest" : "Move";
        const prep = position === "into" ? "as children of" : "under";
        new ConfirmModal(
          this.app,
          position === "into" ? "Nest under target?" : "Move under different parent?",
          `${verb} ${n} note${n === 1 ? "" : "s"} ${prep}:\n"${targetTitle}"\nTheir parent will change.`,
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

  /** Delete selection via Obsidian's OWN trash routing (system trash or `.trash`,
   *  per Obsidian's "Deleted files" setting), unencrypted — bypasses the "Encrypt
   *  items sent to trash" override so it hands the notes straight to Obsidian even
   *  when that folder encrypts its trash. (0.143.1: an explicit "just delete it the
   *  normal Obsidian way" escape hatch; counterpart to "Encrypt (lock) & delete".) */
  async cmdDeleteUnencrypted(): Promise<void> { await this.cmdDelete({ forcePlaintext: true }); }

  /** Mod+Backspace handler: delete the selected notes (or cursor row, or focused note). */
  async cmdDelete(opts: { forcePlaintext?: boolean } = {}): Promise<void> {
    let targets = this.getActionTargets();
    if (targets.length === 0) {
      const focused = this.tree.get(this.focusId);
      if (focused?.file) targets = [focused];
    }
    if (targets.length === 0) { new Notice("Nothing selected to delete."); return; }
    // 0.258.0: never delete a folder's home note — it's the root every other
    // note in the folder hangs from. Reachable two ways: the fallback just
    // above (nothing selected while focused on Home) and, now that the heading
    // is a cursor stop, parking the cursor on Home's own heading row. Dropped
    // from the target set rather than aborting the whole delete, so a
    // multi-select that happens to include it still deletes the rest.
    const withoutHome = targets.filter((t) => t.id !== ROOT_ID);
    if (withoutHome.length !== targets.length) {
      if (withoutHome.length === 0) {
        this.plugin.notifications.show({
          message: "The home note can't be deleted — it's what the folder's notes hang from.",
          kind: "warning",
          category: "delete",
          folder: this.noteFolder,
        });
        return;
      }
      targets = withoutHome;
    }
    // 0.98.32: secure-delete override — when "Encrypt items sent to trash" is ON,
    // a normal delete routes to the encrypted trash (recoverable + Ctrl+Z) instead
    // of plaintext-trashing. Scoped to Stashpad's own delete (per the agreed design).
    // ("Follow Obsidian's trash setting" opts back out of the override.)
    // Per-folder overhaul: this folder's prefs override the globals — its
    // trashEncryptContent + trashHandling (stashpad/obsidian) take precedence.
    const _delFolder = (this.noteFolder ?? "").replace(/\/+$/, "");
    const _delFp = (this.plugin.settings.folderEncPrefs ?? {})[_delFolder] ?? {};
    // 0.151.1: encrypted-trash is strictly PER-FOLDER now. Dropped the legacy
    // `settings.encryptTrash` global fallback: its UI was removed when encryption
    // went per-folder, but a stale saved `true` kept forcing the encrypt-trash
    // path on folders that never opted in — so deleting in an unconfigured folder
    // wrongly hit "…encryption isn't set up. Nothing was deleted." Now a folder
    // with no `trashEncryptContent` pref just uses the default (Stashpad) trash.
    const _encryptTrash = _delFp.trashEncryptContent ?? false;
    const _followObsidian = _delFp.trashHandling === "obsidian"; // 0.137.1: global follow-Obsidian option removed
    // 0.143.1: `forcePlaintext` (the "Delete to Obsidian trash (unencrypted)"
    // command) opts out of the encrypt-trash override — hands the notes to
    // Obsidian's native trash (deleteNote/multi-delete use fileManager.trashFile)
    // instead of the folder's encrypted trash.
    if (_encryptTrash && !_followObsidian && !opts.forcePlaintext) {
      if (!this.plugin.encryption?.isConfigured?.()) {
        // Don't silently fall back to the plaintext trash the user asked to avoid.
        new Notice("“Encrypt items sent to trash” is ON but encryption isn't set up (Settings → Stashpad → Encryption). Nothing was deleted.");
        return;
      }
      await this.secureDeleteSources(targets);
      return;
    }
    // 0.145.0: the DEFAULT delete (encryption OFF) now lands in Stashpad's OWN
    // per-folder trash/ as a recoverable plaintext bundle — surfaced in the Trash
    // view — instead of Obsidian's trash. Only `forcePlaintext` (the explicit
    // "Delete to Obsidian's trash (unencrypted)" command) or the folder's
    // trashHandling="obsidian" pref routes to Obsidian's native trash below.
    if (!opts.forcePlaintext && !_followObsidian) {
      await this.plaintextDeleteToStashpadTrash(targets);
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
          // 0.211.5 (M7/M8): trash only attachments no surviving note references, and
          // make sure every file we trash is in the snapshot undo restores from.
          const deletingPaths = new Set(allNotes.map((n) => n.file?.path).filter((p): p is string => !!p));
          const { files: attFiles, sharedSkipped } = await this.attachmentsSafeToDelete(uniqueAtts, deletingPaths);
          const inSnap = new Set(snap.attachments.map((a) => a.path));
          for (const f of attFiles) {
            if (inSnap.has(f.path)) continue;
            try { snap.attachments.push({ path: f.path, data: await this.app.vault.readBinary(f) }); inSnap.add(f.path); }
            catch { /* unreadable — trashing it below would be unrecoverable, so skip it */ }
          }
          if (sharedSkipped > 0) {
            this.plugin.notifications.show({
              message: `Kept ${sharedSkipped} attachment${sharedSkipped === 1 ? "" : "s"} — still used by ${sharedSkipped === 1 ? "another note" : "other notes"}.`,
              kind: "info", category: "delete", folder: this.noteFolder, duration: 7000,
            });
          }
          for (const f of attFiles.filter((f) => inSnap.has(f.path))) {
            {
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
              } catch { /* ignore */ }
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
          try { await this.app.fileManager.trashFile(n.file); } catch { /* ignore */ }
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
        // 0.211.4 (M1): the toast's Undo and the undo-stack entry are two independent
        // controllers of one restore, and they only shared a boolean. Pressing the
        // toast's Undo left the stack entry in place, so a later Ctrl+Z silently
        // no-opped (the flag was set) while the stack still advanced, and the matching
        // Ctrl+Shift+Z reset the flag and re-trashed the note — by then live and
        // possibly edited. A further Ctrl+Z then restored the stale pre-delete
        // snapshot, losing every edit made since. Once the toast restores, the entry is
        // neutralised: its undo and redo both become no-ops, because the toast has
        // taken the operation out of the stack's hands and the pairing no longer holds.
        let handledOutOfBand = false;
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
          actions: [{ label: "Undo delete", onClick: () => { handledOutOfBand = true; void doRestore(); } }],
        });
        this.plugin.getUndoStack(folder).push({
          label: `Delete ${targets.length} note${targets.length === 1 ? "" : "s"}`,
          undo: async () => { if (handledOutOfBand) return; await doRestore(); },
          redo: async () => {
            if (handledOutOfBand) return;
            // Defence in depth alongside the handledOutOfBand guard: never re-trash a
            // note whose content has diverged from the snapshot this redo would undo.
            // Trashing it would discard edits the snapshot cannot restore.
            for (const n of snap.notes) {
              const f = this.app.vault.getAbstractFileByPath(n.path) as TFile | null;
              if (!f) continue;
              let cur: string | null = null;
              try { cur = await this.app.vault.read(f); } catch { cur = null; }
              if (cur !== null && cur !== n.content) {
                new Notice("Didn't redo the delete — one of those notes has been edited since. Delete it again if you meant to.", 8000);
                return;
              }
            }
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
  /** 0.170.0: also the entry for the in-app EDIT surface — `surface: "edit"` opens
   *  the same modal on the Edit tab (edits + Save), which can toggle to Split. */
  cmdEdit(node?: TreeNode): Promise<void> { return this.cmdSplit(node, "edit"); }

  /** 0.179.0: open the COMPOSER's current text in the full in-app editor. Save
   *  creates the note(s) under the current focus (a split creates several) and
   *  clears the composer — a roomier way to compose than the 2-row textarea. */
  cmdComposerFullscreen(): void {
    const seed = this.composerInputEl?.value ?? this.composerDraft ?? "";
    const clearComposer = async (): Promise<void> => {
      if (this.composerInputEl) this.composerInputEl.value = "";
      this.composerDraft = "";
      try { await this.saveDraft(""); } catch { /* ignore */ }
    };
    const createParts = async (parts: string[]): Promise<void> => {
      const clean = parts.map((p) => p.trim()).filter((p) => p.length > 0);
      if (clean.length === 0) { new Notice("Nothing to save."); return; }
      const parent = this.focusId;
      this.autoSelectNewest = true;
      this.scrollToBottomOnNextRender = true;
      if (clean.length === 1) await this.createNoteUnder(clean[0], parent);
      else await this.createNotesBatch(clean, parent, undefined, clean.join("\n\n"), this.noteFolder);
      await clearComposer();
      this.render();
    };
    const splitCore = {
      onSplitAtLine: async (idx: number): Promise<void> => {
        const lines = seed.replace(/\r\n/g, "\n").split("\n");
        await createParts([lines.slice(0, idx).join("\n"), lines.slice(idx).join("\n")]);
      },
      onSplitAtChar: async (text: string, ch: number): Promise<void> => {
        await createParts([text.slice(0, ch), text.slice(ch)]);
      },
      onSplitMany: async (chunks: string[]): Promise<void> => { await createParts(chunks); },
      onSave: async (body: string): Promise<void> => { await createParts([body]); },
      onOpenExternal: undefined,
      onImportFile: (f: File): Promise<string | null> => this.importAttachment(f),
    };
    new NoteWorkbenchModal(
      this.app,
      seed,
      { ...splitCore, popOut: (state) => void this.plugin.openWorkbench(seed, splitCore, state) },
      { surface: "edit" },
    ).open();
  }

  /** 0.170.2: edit the focused parent note in the in-app editor (Shift+E). */
  cmdEditParent(): Promise<void> {
    const focused = this.tree.get(this.focusId);
    if (!focused?.file) { new Notice("No focused parent to edit."); return Promise.resolve(); }
    return this.cmdEdit(focused);
  }

  async cmdSplit(node?: TreeNode, surface: "edit" | "split" = "split"): Promise<void> {
    const target = node ?? this.resolveActionTarget();
    if (!target?.file) { new Notice(surface === "edit" ? "Pick a note to edit." : "Pick a note to split."); return; }
    const file = target.file;
    const md = await this.app.vault.read(file);
    const body = this.stripFrontmatter(md).replace(/\s+$/, "");
    const lines = body.split(/\r?\n/);
    // Split needs ≥2 chars to be meaningful; editing has no such floor.
    if (surface === "split" && body.trim().length < 2) { new Notice("Note is too short to split."); return; }
    const originalContent = md;
    const originalPath = file.path;
    // 0.211.4 (H6): undo/redo closures below run long after this point, and Stashpad
    // auto-renames a note ~30s after its first line changes. Capture the stable id so
    // those closures can resolve the note via fileForNote() instead of the stale path
    // — a path-only lookup returns null after the reslug, and the undo then trashed
    // the split-off half while never restoring the original's pre-split body.
    const originalId = target.id;
    // 0.170.0: Edit-surface Save — write the edited body back to the note (frontmatter
    // preserved), as one undo entry.
    const performEdit = async (newBody: string): Promise<void> => {
      const nb = newBody.replace(/\s+$/, "");
      if (!nb.trim()) { new Notice("Can't save an empty note."); return; }

      // 0.210.6: take the frontmatter from a FRESH read, never from the snapshot
      // taken when the surface opened.
      //
      // The old code spliced `md` (read at open time) back together with the new
      // body and overwrote the whole file. Anything that touched the note's
      // frontmatter while the editor sat open was therefore silently reverted on
      // Save — and the most frequent writer is Stashpad ITSELF: FrontmatterSyncQueue
      // writing parentLink/children, a color change, a completed toggle, a drag
      // that rewrites `parent`, an author contribution stamp. Reverting `parent`
      // moves the note back under its old parent on disk.
      //
      // Re-reading fixes the whole self-write class outright, because we only ever
      // write OUR body onto THEIR frontmatter. A concurrent BODY edit is the one
      // case that cannot be merged, so it asks instead of picking a winner.
      const current = await this.app.vault.read(file);
      const fresh = this.splitFrontmatterForWrite(current, originalPath);
      if (!fresh) return;   // truncated frontmatter — refuse rather than orphan the note
      const openSplit = this.splitFrontmatterForWrite(md, originalPath);
      const freshBody = fresh.body.replace(/\s+$/, "");
      const openBody = (openSplit?.body ?? "").replace(/\s+$/, "");
      if (freshBody !== openBody && freshBody !== nb) {
        const proceed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(
            this.app,
            "This note changed while you were editing",
            `"${this.titleForNode(target)}" was modified somewhere else (another window, a synced device, or a collaborator) after you opened it here.\n\n`
            + "Saving now replaces their version of the text with yours. Their edit is not merged.\n\n"
            + "Cancel keeps both: nothing is written, and your text stays in the editor so you can copy it out.",
            "Overwrite with my version",
            // Single callback taking the choice; ConfirmModal reports Escape and
            // overlay-clicks as Cancel, so this always resolves.
            (confirmed: boolean) => resolve(confirmed),
            "Cancel (keep both)",
          ).open();
        });
        if (!proceed) return;
      }
      const fm = fresh.fm;
      const newContent = fm + (fm ? "\n" : "") + nb + "\n";
      if (newContent === current) return; // no change
      await this.app.vault.modify(file, newContent);
      // 0.170.2: re-slug the filename to match the new first line (user chose auto-rename).
      const renamedTo = await this.reslugFile(file, nb);
      const finalPath = renamedTo ?? originalPath;
      // 0.274.0: record the in-app edit so the activity heatmap can count it.
      // `external_edit` covers writes from elsewhere; this is the matching entry
      // for edits made through Stashpad's own editor (which are self-writes and
      // otherwise leave no log trace).
      void this.log.append({ type: "edit", id: target.id, payload: { path: finalPath } });
      this.tree.rebuild(this.noteFolder);
      this.render();
      this.plugin.notifications.show({
        message: `Saved "${this.titleForNode(target)}"`, kind: "success", category: "split",
        affectedIds: [target.id], folder: this.noteFolder,
      });
      const folder = this.noteFolder;
      this.plugin.getUndoStack(folder).push({
        label: "Edit note",
        // 0.211.4: same stale-path class as H6. A save can trigger an auto-reslug, so
        // by the time undo runs the note may sit at neither finalPath nor originalPath;
        // a path-only lookup then silently no-ops while the undo stack advances, and
        // the user's edit is unrecoverable through undo. Resolve id-first.
        undo: async () => {
          const f = this.fileForNote(target.id, finalPath) ?? this.fileForNote(target.id, originalPath);
          if (!f) { new Notice("Can't undo the edit — that note was moved or deleted."); return; }
          if (f.path !== originalPath) { try { await this.app.fileManager.renameFile(f, originalPath); } catch { /* ignore */ } }
          await this.app.vault.modify(f, originalContent);
          this.tree.rebuild(folder); this.render();
        },
        redo: async () => {
          const f = this.fileForNote(target.id, originalPath);
          if (f) { await this.app.vault.modify(f, newContent); if (f.path !== finalPath) { try { await this.app.fileManager.renameFile(f, finalPath); } catch { /* ignore */ } } }
          this.tree.rebuild(folder); this.render();
        },
      });
    };
    const performSplit = async (firstBody: string, secondBody: string, payload: Record<string, unknown>, nest = false) => {
      if (!firstBody.trim() || !secondBody.trim()) { new Notice("Split would leave one part empty."); return; }
      try {
        const split = this.splitFrontmatterForWrite(md, originalPath);
      if (!split) return;   // truncated frontmatter — refuse rather than orphan the note
      const fm = split.fm;
        const newOriginal = fm + (fm ? "\n" : "") + firstBody + "\n";
        await this.app.vault.modify(file, newOriginal);
        // 0.168.3: nest → the new part becomes a CHILD of the original; otherwise a sibling.
        const parentId = nest ? target.id : (target.parent ?? ROOT_ID);
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
        this.viewRoot?.focus({ preventScroll: true });
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
        const newContentForRedo = newPath ? await this.app.vault.read(newNode.file!) : null;

        const folder = this.noteFolder;
        this.plugin.getUndoStack(folder).push({
          label: "Split note",
          undo: async () => {
            // Trash the new note, restore the original's full body.
            // 0.211.4 (H6): resolve the original FIRST and bail if it's gone. Undo is
            // only safe as a pair — trashing the split-off half without restoring the
            // original's full body destroys part two outright. Both lookups go through
            // fileForNote so an auto-reslug rename since the split doesn't strand them.
            const of = this.fileForNote(originalId, originalPath);
            if (!of) { new Notice("Can't undo the split — the original note was moved or deleted. The split-off note was left in place."); return; }
            if (newPath) {
              const nf = this.fileForNote(newId, newPath);
              if (nf) { try { await this.app.fileManager.trashFile(nf); } catch { /* ignore */ } }
            }
            await this.app.vault.modify(of, originalContent);
            this.tree.rebuild(folder);
            this.render();
          },
          redo: async () => {
            const of = this.fileForNote(originalId, originalPath);
            if (of) await this.app.vault.modify(of, newOriginal);
            // 0.211.6 (L4): a path check alone isn't enough. The split-off note
            // reslugs when its first line changes, so it can be alive at a DIFFERENT
            // path — the path lookup then misses and redo creates a second file
            // carrying the same id. restoreSnapshots already guards this way; match
            // it. Recreate only when the id is genuinely absent from the tree.
            if (newPath && newContentForRedo
              && !(newId && this.tree.get(newId))
              && !(await this.app.vault.adapter.exists(newPath))) {
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

    // Multi-split: the original keeps part 1; parts 2..N become new siblings
    // (in order, via incrementing createdOverride). One bulk-render window + one
    // grouped undo, same as the composer batch.
    const performMultiSplit = async (parts: string[], nest = false): Promise<void> => {
      if (parts.length < 2) return;
      try {
        const split = this.splitFrontmatterForWrite(md, originalPath);
      if (!split) return;   // truncated frontmatter — refuse rather than orphan the note
      const fm = split.fm;
        const firstBody = parts[0].replace(/\s+$/, "");
        if (!firstBody.trim()) { new Notice("Split would leave the first part empty."); return; }
        const newOriginal = fm + (fm ? "\n" : "") + firstBody + "\n";
        await this.app.vault.modify(file, newOriginal);
        // 0.168.3: nest → parts 2..N become CHILDREN of the original; else siblings.
        const parentId = nest ? target.id : (target.parent ?? ROOT_ID);
        const baseTime = Date.parse(target.created || "");
        const base = Number.isFinite(baseTime) ? baseTime : Date.now();
        const collected: Array<{ path: string; content: string }> = [];
        this.beginBulkRender();
        try {
          for (let i = 1; i < parts.length; i++) {
            await this.createNoteUnder(parts[i], parentId, {
              record: false,
              createdOverride: new Date(base + i).toISOString(),
              deferRender: true,
              collectInto: collected,
            });
          }
        } finally {
          try { await this.fmSync.flush(); } catch { /* best effort */ }
          this.endBulkRender();
        }
        await this.log.append({ type: "rename", id: target.id, payload: { action: "split-many", parts: parts.length } });
        this.suppressComposerFocusUntil = Date.now() + 500;
        this.viewRoot?.focus({ preventScroll: true });
        this.plugin.notifications.show({
          message: `Split "${this.titleForNode(target)}" into ${parts.length}`,
          kind: "success", category: "split", affectedIds: [target.id], folder: this.noteFolder,
        });
        const created = collected.slice();
        const folder = this.noteFolder;
        this.plugin.getUndoStack(folder).push({
          label: `Split note into ${parts.length}`,
          undo: async () => {
            // 0.211.4 (H6): fail closed — resolve the original before trashing any of
            // the parts, or an undo after the original was renamed/removed would delete
            // every split-off part while restoring nothing. Parts resolve id-first too
            // (id parsed from the filename), since they reslug on their own first line.
            const of = this.fileForNote(originalId, originalPath);
            if (!of) { new Notice("Can't undo the split — the original note was moved or deleted. The split-off notes were left in place."); return; }
            for (const { path } of created) {
              const nf = this.fileForNote(parseIdFromFilename(path.split("/").pop()!.replace(/\.md$/, "")), path);
              if (nf) { try { await this.app.fileManager.trashFile(nf); } catch { /* ignore */ } }
            }
            await this.app.vault.modify(of, originalContent);
            this.tree.rebuild(folder);
            this.render();
          },
          redo: async () => {
            const of = this.fileForNote(originalId, originalPath);
            if (of) await this.app.vault.modify(of, newOriginal);
            // 0.211.6 (L4): id-first check, same reasoning as the single-split redo —
            // a part that reslugged is alive at a different path, and a path-only test
            // would mint a duplicate carrying the same id.
            for (const { path, content } of created) {
              const partId = parseIdFromFilename(path.split("/").pop()!.replace(/\.md$/, ""));
              if (partId && this.tree.get(partId)) continue;
              if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.create(path, content);
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

    // 0.169.0: the split handlers, shared by the modal AND the popped-out tab.
    const splitCore = {
      onSplitAtLine: async (lineIdx: number, nest: boolean) => {
        const firstBody = lines.slice(0, lineIdx).join("\n").replace(/\s+$/, "");
        const secondBody = lines.slice(lineIdx).join("\n").replace(/^\s+|\s+$/g, "");
        await performSplit(firstBody, secondBody, { mode: "line", splitAtLine: lineIdx, nest }, nest);
      },
      onSplitAtChar: async (text: string, charIdx: number, nest: boolean) => {
        // 0.168.0: split the (possibly edited) text from the modal, not the
        // original body — so edits made in the cursor textarea are honored.
        const firstBody = text.slice(0, charIdx).replace(/\s+$/, "");
        const secondBody = text.slice(charIdx).replace(/^\s+|\s+$/g, "");
        await performSplit(firstBody, secondBody, { mode: "cursor", splitAtChar: charIdx, edited: text !== body, nest }, nest);
      },
      onSplitMany: async (parts: string[], nest: boolean) => { await performMultiSplit(parts, nest); },
      onSave: performEdit,
      onOpenExternal: () => { void this.openFileAtEnd(file); },
      onImportFile: (f: File): Promise<string | null> => this.importAttachment(f),
    };
    new NoteWorkbenchModal(this.app, body, {
      ...splitCore,
      popOut: (state) => { void this.plugin.openWorkbench(body, splitCore, state); },
    }, { surface }).open();
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
  cmdImportStash(): Promise<void> { return ioCmds.cmdImportStash(this); }
  processStashFile(file: TFile): Promise<void> { return ioCmds.processStashFile(this, file); }

  // --- Note creation ---

  private async createNoteUnder(body: string, parentOverride: StashpadId | null, opts: { record?: boolean; createdOverride?: string; targetFolder?: string; deferRender?: boolean; deferUndo?: boolean; collectInto?: Array<{ path: string; content: string }> } = { record: true }): Promise<StashpadId | null> {
    // 0.76.15: targetFolder lets the destination picker SHIP a note to
    // another Stashpad folder without switching this view there. When
    // it differs from the current folder we skip the synthetic insert
    // / render / fmSync that assume the note belongs to this view's
    // tree, and instead surface a "sent to <folder>" notice with a
    // Jump action.
    const folder = (opts.targetFolder ?? this.noteFolder).replace(/\/+$/, "");
    const remote = folder !== this.noteFolder;
    // 0.201.2 → 0.201.3: heal ANY run of 3+ consecutive brackets down to a
    // pair (per user: nothing beyond [[ ]] is ever intentional). Creation-time
    // only — never rewrites already-saved notes.
    body = body.replace(/\[{3,}/g, "[[").replace(/\]{3,}/g, "]]");
    await this.ensureFolder(folder);
    const id = this.plugin.mintNoteId();

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

    // 0.176.0: a leading checkbox prefix makes the note a task. "[]" / "[ ]" →
    // 0.193.0: an optional "- "/"* "/"+ " list marker is allowed in front, because
    // that's exactly what Copy emits ("- [x] text") — without it, pasting your own
    // copied tasks back in produced plain notes that merely LOOKED like checkboxes.
    // open task; "[x]" / "[X]" → completed. The prefix (and any trailing space)
    // is stripped from the stored body, so the slug/title/first-line are clean.
    // Requires actual content after the bracket, so a bare "[]" isn't swallowed.
    let taskPrefix: { completed: boolean } | null = null;
    {
      const m = body.match(/^\s*(?:[-*+]\s+)?\[([ xX]?)\]\s*(?=\S)/);
      if (m) {
        taskPrefix = { completed: /[xX]/.test(m[1]) };
        body = body.slice(m[0].length);
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
    // 0.176.0: a "[]"/"[x]" body prefix made this note a task on creation.
    if (taskPrefix) fmLines.push("task: true", `completed: ${taskPrefix.completed}`);
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
      // 0.216.1: everything this write sets in motion (create event, metadata
      // resolve/changed, the fmSync parentLink write ~100ms out) lands as a
      // trickle of debounced renders. Stretch the debounce for the next 2s so
      // they coalesce into one settle render — stamped BEFORE the write,
      // because the create event fires inside it.
      this.postCreateSettleUntil = Date.now() + 2000;
      await perf.timeAsync("write.createNote.file", () => this.app.vault.create(path, fullContent));
      opts.collectInto?.push({ path, content: fullContent });
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
            // 0.159.0: seed the render cache from the body we JUST wrote, so the
            // new row paints its real body immediately — no filename-title
            // placeholder and no `cachedRead` (the slow network round-trip). On a
            // slow/network drive this is the difference between an instant, stable
            // new row and the body→title→body flash while the read resolves.
            await this.bodyRenderer.primeRender(f as TFile, body);
            // Batched splits defer the render to a single pass at the end
            // (see createNotesBatch) so a long paste doesn't repaint per note.
            if (!opts.deferRender) {
              this.render();
              // 0.267.14: that render already shows the finished row, so every
              // render the create sets in motion after it is redundant — and
              // visible, as 3-4 brief flickers.
              //
              // 0.216.1 stretched the debounce to 400ms for two seconds, but a
              // trailing debounce does not COALESCE a trickle: the create
              // event, the metadata resolve, and the fmSync parentLink write
              // ~100ms out each arrive after the previous one has already
              // fired, so each got its own repaint. Suppressing outright and
              // rendering ONCE when it settles is what the 400ms window was
              // reaching for.
              //
              // Suppression only affects DEBOUNCED renders. Direct render()
              // calls still paint, so typing a second note during the window
              // still shows its row instantly — which is the whole point of
              // the synthetic insert above and must not regress.
              this.beginBulkRender();
              this.endBulkRender(1200);
            }
            this.fmSync.scheduleParentChange(id, null, parentId);
          } else {
            // 0.76.15: remote send — the note belongs to another
            // folder's tree, not this view's. Just refresh the local
            // view (clears the destination badge) and tell the user
            // where it went, with a Jump action. (Batched splits defer
            // both: createNotesBatch renders once + shows one summary.)
            if (!opts.deferRender) this.render();
            const folderName = folder.split("/").pop() || folder;
            const noteTitle = (body.split("\n").find((s) => s.trim()) ?? "note").trim().slice(0, 60);
            if (!opts.deferUndo) this.plugin.notifications.show({
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
                for (const [k, v] of Object.entries(templateFm)) {
                  if (RESERVED_FRONTMATTER.includes(k)) continue;
                  if (SHEET_COPY_SKIP_KEYS.includes(k)) continue; // templates don't seed version groups
                  if (m[k] === undefined) m[k] = v;
                }
              });
            } catch (e) {
              console.warn("[Stashpad] template fm overlay failed", e);
            }
          }
        }
      } catch { /* ignore */ }
      // log.append is fire-and-forget — no actual await happens, but we keep `await` for symmetry.
      await this.log.append({ type: "create", id, payload: { path, parent: parentId } });
      if (opts.record !== false && !opts.deferUndo) {
        // 0.76.15: push the undo onto the TARGET folder's stack (so it
        // belongs with that folder's history), and only rebuild THIS
        // view's tree when the create was local — a remote create
        // mustn't repoint this.tree at the remote folder. (deferUndo:
        // batched splits push ONE grouped undo in createNotesBatch.)
        const originalBody = body;
        this.plugin.getUndoStack(folder).push({
          label: remote ? "Send note" : "Create note",
          undo: async () => {
            // id-first: the just-created note may have been slug-renamed before
            // the user hits undo, making the captured path stale. 0.140.10
            const f = this.fileForNote(id, path);
            if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
            // Restore the body to the composer so the send/create can be
            // re-typed. (For remote sends the destination is gone after
            // submit, but the text returning is still the useful part.)
            // 0.140.9: only if the composer is empty — don't destroy a draft the
            // user started typing after submitting.
            const curDraft = this.composerInputEl?.value ?? this.composerDraft;
            if (!curDraft.trim()) {
              this.composerDraft = originalBody;
              void this.saveDraft(originalBody);
              void this.recordLastSubmitted("");
              if (this.composerInputEl) {
                this.composerInputEl.value = originalBody;
                const end = originalBody.length;
                this.composerInputEl.setSelectionRange(end, end);
                this.composerInputEl.focus();
              }
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

  /** Create many notes from a split paste as ONE batch. The parent is fixed by
   *  the caller (so mid-paste navigation can't reparent them), rendering happens
   *  once at the end instead of per note, a progress bar shows for long pastes,
   *  and the whole set collapses into a single undo. */
  private async createNotesBatch(
    lines: string[],
    parent: StashpadId | null,
    createOpts: { targetFolder?: string } | undefined,
    originalText: string,
    folder: string,
  ): Promise<void> {
    const total = lines.length;
    const collected: Array<{ path: string; content: string }> = [];
    const remote = !!createOpts?.targetFolder && createOpts.targetFolder !== this.noteFolder;

    // Progress bar only for long pastes — short ones finish before it'd register.
    const SHOW_BAR_AT = 8;
    let bar: { notice: Notice; fill: HTMLElement; label: HTMLElement } | null = null;
    if (total >= SHOW_BAR_AT) {
      const notice = new Notice("", 0);
      const el = notice.messageEl;
      el.empty();
      el.createDiv({ cls: "stashpad-split-progress-title", text: `Splitting into ${total} notes…` });
      const wrap = el.createDiv({ cls: "stashpad-split-progress-bar" });
      const fill = wrap.createDiv({ cls: "stashpad-split-progress-fill" });
      const label = el.createDiv({ cls: "stashpad-split-progress-label", text: `0 / ${total}` });
      bar = { notice, fill, label };
    }

    this.beginBulkRender();
    try {
      for (let i = 0; i < total; i++) {
        await this.createNoteUnder(lines[i], parent, {
          ...(createOpts ?? {}),
          deferRender: true,
          deferUndo: true,
          collectInto: collected,
        });
        if (bar) {
          const done = i + 1;
          bar.label.setText(`${done} / ${total}`);
          bar.fill.setCssStyles({ width: `${Math.round((done / total) * 100)}%` });
          // Yield every few notes so the bar paints and the UI stays responsive.
          if (done % 5 === 0) await new Promise((r) => window.setTimeout(r, 0));
        }
      }
    } finally {
      bar?.notice.hide();
      // Drain the recovery-field writes NOW (instead of one-per-100ms over
      // several seconds), so they don't trickle in and repaint the list note
      // by note. Then endBulkRender renders once after a short settle.
      try { await this.fmSync.flush(); } catch { /* best effort */ }
      this.endBulkRender();
    }

    // Single grouped undo for the whole paste.
    if (collected.length) {
      const created = collected.slice();
      this.plugin.getUndoStack(folder).push({
        label: `Create ${created.length} notes`,
        undo: async () => {
          for (const { path } of created) {
            const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
            if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* ignore */ } }
          }
          this.composerDraft = originalText;
          void this.saveDraft(originalText);
          void this.recordLastSubmitted("");
          if (this.composerInputEl) {
            this.composerInputEl.value = originalText;
            const end = originalText.length;
            this.composerInputEl.setSelectionRange(end, end);
            this.composerInputEl.focus();
          }
          if (!remote) this.tree.rebuild(this.noteFolder);
          this.render();
        },
        redo: async () => {
          for (const { path, content } of created) {
            if (!(await this.app.vault.adapter.exists(path))) {
              await this.app.vault.create(path, content);
            }
          }
          this.composerDraft = "";
          void this.saveDraft("");
          if (this.composerInputEl) this.composerInputEl.value = "";
          if (!remote) this.tree.rebuild(this.noteFolder);
          this.render();
        },
      });
    }

    if (total >= SHOW_BAR_AT) {
      this.plugin.notifications.show({
        message: `Created ${collected.length} notes${remote ? ` in \`${folder.split("/").pop()}\`` : ""}.`,
        kind: "success",
        category: "create",
      });
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

  /** 0.213.0: move attachments that this composer wrote into THIS folder over to
   *  `destFolder` when the note is being sent elsewhere, and rewrite the body's
   *  links to match. Returns the rewritten body.
   *
   *  Only touches files under `<this.noteFolder>/_attachments` — a link pointing
   *  anywhere else (a vault attachment, another Stashpad's folder, an absolute
   *  path the user typed) is left exactly as-is; it isn't ours to relocate.
   *
   *  Reference-aware even though the common case can't be ambiguous. The note
   *  being created doesn't exist yet, so normally the only referent is this
   *  body — but the user can paste an existing `![[…]]` link into the composer,
   *  and then the file IS referenced by a note that stays behind. Moving it
   *  would break that note to fix this one. So: if any OTHER note references
   *  the file, leave it in place and keep the absolute link (which still
   *  resolves from the destination folder) rather than moving it.
   *
   *  Never throws — an attachment that can't be moved falls back to its
   *  original link, which is exactly today's behaviour. */
  private async rehomeComposerAttachments(body: string, destFolder: string): Promise<string> {
    const srcDir = `${this.noteFolder.replace(/\/+$/, "")}/_attachments`;
    const destDir = `${destFolder.replace(/\/+$/, "")}/_attachments`;
    if (srcDir === destDir) return body;
    // Only the embeds that point into THIS folder's _attachments are candidates.
    const refs = new Set<string>();
    for (const m of body.matchAll(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g)) {
      const p = m[1].trim();
      if (p.startsWith(`${srcDir}/`)) refs.add(p);
    }
    if (!refs.size) return body;

    let out = body;
    let moved = 0;
    let sharedLeftBehind = 0;
    for (const ref of refs) {
      try {
        const af = this.app.vault.getAbstractFileByPath(ref);
        if (!(af instanceof TFile)) continue;               // already gone / never written
        // Two conditions, and BOTH must hold. Only relocate a file this composer
        // created during this compose (so we know it was staged for this note,
        // not linked from somewhere), and only when nothing already references
        // it. A pasted link to an existing attachment fails the first test; a
        // file some other note embeds fails the second. Anything we don't move
        // keeps its absolute link, which still resolves from the destination.
        if (!this.composerCreatedAttachments.has(ref) || this.attachmentReferencedElsewhere(ref)) {
          sharedLeftBehind++;
          continue;
        }
        await this.ensureFolder(destDir);
        // Collision-safe: the destination may already hold a same-named file.
        let target = `${destDir}/${af.name}`;
        for (let i = 1; i < 1000 && this.app.vault.getAbstractFileByPath(target); i++) {
          target = `${destDir}/${buildAttachmentName(af.name, `${i}`)}`;
        }
        await this.app.fileManager.renameFile(af, target);
        // Replace the link precisely. A bare split/join on the path would also
        // rewrite a LONGER path that merely starts with it (x.png vs x.png.bak),
        // silently repointing a different attachment.
        out = out.split(`[[${ref}]]`).join(`[[${target}]]`).split(`[[${ref}|`).join(`[[${target}|`);
        this.composerCreatedAttachments.delete(ref);
        moved++;
        await this.log.append({ type: "attachment_add", id: ROOT_ID, payload: { path: target, name: af.name, size: 0 } });
      } catch (e) {
        // Leave the link pointing at the original path — it still resolves.
        console.warn("[Stashpad] couldn't re-home composer attachment", ref, e);
      }
    }
    if (moved || sharedLeftBehind) {
      const bits: string[] = [];
      if (moved) bits.push(`Moved ${moved} attachment${moved === 1 ? "" : "s"} to **${destFolder}** with the note.`);
      if (sharedLeftBehind) {
        // Covers both reasons a file stays put: another note references it, or
        // it wasn't staged by this composer (a pasted link). Either way the
        // user-visible fact is the same — it lives in the other folder now, and
        // the link still works — so say that rather than guess which applied.
        bits.push(
          `${sharedLeftBehind} attachment${sharedLeftBehind === 1 ? "" : "s"} stayed in **${this.noteFolder}** because ${sharedLeftBehind === 1 ? "it is" : "they are"} used elsewhere or ${sharedLeftBehind === 1 ? "was" : "were"} not added here. `
          + `The note links to ${sharedLeftBehind === 1 ? "it" : "them"} across folders, so deleting **${this.noteFolder}** would break ${sharedLeftBehind === 1 ? "that link" : "those links"}.`,
        );
      }
      this.plugin.notifications.show({
        message: bits.join("\n"),
        kind: sharedLeftBehind ? "warning" : "success",
        category: "attachment",
        folder: destFolder,
        duration: sharedLeftBehind ? 0 : 5000,
      });
    }
    return out;
  }

  /** True when any note already embeds `path` — i.e. moving it would break an
   *  existing note.
   *
   *  Deliberately NOT a full-vault body scan. The obvious implementation
   *  (getMarkdownFiles + cachedRead each) is O(vault) on every send that carries
   *  an attachment, and cachedRead hits the disk for anything not already
   *  loaded — which on a large vault on a network drive is exactly the cost
   *  profile we are trying to avoid elsewhere. resolvedLinks is an in-memory
   *  index Obsidian already maintains, and it includes embeds. */
  private attachmentReferencedElsewhere(path: string): boolean {
    const links = this.app.metadataCache.resolvedLinks ?? {};
    for (const targets of Object.values(links)) {
      if (targets && Object.prototype.hasOwnProperty.call(targets, path)) return true;
    }
    return false;
  }

  /** 0.215.0: where a NEW attachment is written, per the attachment-location
   *  setting. Existing files are never relocated by changing this — only the
   *  destination for what comes next changes, so switching modes can't strand
   *  or break anything already on disk.
   *
   *  "per-folder" keeps every attachment inside the Stashpad that uses it,
   *  which is what makes a folder self-contained and portable — and also what
   *  creates the stranding problem the 0.213.x work manages, since a note sent
   *  to another folder leaves its files behind. The other two modes put
   *  attachments outside any single Stashpad, so that problem does not arise.
   *
   *  Falls back to per-folder whenever the configured destination is unusable,
   *  rather than failing the attach. */
  private attachmentDirFor(): string {
    const perFolder = `${this.noteFolder}/_attachments`;
    const s = getSettings();
    if (s.attachmentLocation === "universal") {
      const dir = (s.attachmentUniversalFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
      return dir || perFolder;
    }
    if (s.attachmentLocation === "obsidian") {
      // Obsidian's own setting. "" means the vault root; a leading "./" means
      // "next to the note", which has no single answer for a Stashpad note
      // being composed, so that case falls back to per-folder.
      const raw = (this.app.vault as { getConfig?: (k: string) => unknown }).getConfig?.("attachmentFolderPath");
      if (typeof raw !== "string") return perFolder;
      const dir = raw.trim();
      if (dir === "" || dir === "/") return "";           // vault root
      if (dir.startsWith("./")) return perFolder;          // note-relative — not resolvable here
      return dir.replace(/^\/+|\/+$/g, "");
    }
    return perFolder;
  }

  private async importAttachment(file: File): Promise<string | null> {
    try {
      const buf = await file.arrayBuffer();
      const folder = this.attachmentDirFor();
      // "" is the vault ROOT (Obsidian's attachment setting allows it). Don't
      // ensureFolder it, and don't join with a slash — `/name.png` is not a
      // valid vault path.
      if (folder) await this.ensureFolder(folder);
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const stamp = Date.now().toString(36);
      const leaf = buildAttachmentName(safeName, stamp);
      const path = folder ? `${folder}/${leaf}` : leaf;
      await this.app.vault.createBinary(path, buf);
      // 0.213.0: remember that THIS composer staged this file, so a later send
      // to another folder knows it is safe to carry along (see
      // rehomeComposerAttachments). Cleared on submit.
      this.composerCreatedAttachments.add(path);
      await this.log.append({ type: "attachment_add", id: ROOT_ID, payload: { path, name: file.name, size: file.size } });
      this.plugin.notifications.show({
        message: `Attached ${file.name}`,
        kind: "success",
        category: "attachment",
        affectedPaths: [path],
        folder: this.noteFolder,
      });
      // 0.268.2: name first, then the file, separated by a SPACE.
      //
      // A bare attachment link leaves the note with nothing to read: it shows
      // blank in the list, and its filename comes from the path rather than
      // from anything the user chose. A space rather than a newline keeps it
      // one line, so the note still reads as a single item.
      const s = getSettings();
      const ref = s.attachmentsEmbedded ? `![[${path}]]` : `[[${path}]]`;
      return s.attachmentNamePrefix ? `${file.name} ${ref}` : ref;
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

  /** 0.180.0: paths we just wrote frontmatter-ONLY to (color/task/complete/due),
   *  with the write timestamp. onFileModify consults `wasRecentFmSelfWrite` so it
   *  retags the render cache (no placeholder flash / re-read) instead of evicting.
   *  One-shot per write; 2.5s grace (matches fmSync). */
  private recentFmSelfWrites = new Map<string, { at: number; repainted: boolean }>();
  /** Call right before a Stashpad frontmatter-only write so the resulting modify
   *  event is recognized as ours. */
  /** `repainted: true` means the caller has ALREADY updated the affected rows in
   *  place (0.218.0), so the follow-up re-render this would otherwise trigger is
   *  redundant — and that render is the one that moves the list, because its
   *  anchor restore lands slightly off. Callers that only write frontmatter and
   *  rely on the render to repaint (due badges, etc.) leave it false. */
  markFmSelfWrite(path: string, repainted = false): void {
    this.recentFmSelfWrites.set(path, { at: Date.now(), repainted });
  }
  private wasRecentFmSelfWrite(path: string): { hit: boolean; repainted: boolean } {
    const e = this.recentFmSelfWrites.get(path);
    if (!e) return { hit: false, repainted: false };
    this.recentFmSelfWrites.delete(path); // one-shot
    return { hit: Date.now() - e.at < 2500, repainted: e.repainted };
  }

  private onFileModify = (file: TFile): void => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith(this.noteFolder + "/")) return;
    // 0.160.0: our OWN recovery-field write (fmSync parentLink/children) only
    // touches frontmatter — the body is provably unchanged, so the rendered body
    // is still correct. Evicting + re-rendering here would flash the filename
    // placeholder and re-read the body over the network (the SECOND create flash
    // on a slow drive). Instead just move the cache entry to the new mtime so it
    // stays a hit, and skip the re-render + slug/attachment/authorship handling
    // (none apply to a frontmatter-only write). One-shot per write, so a genuine
    // later body edit is still handled below.
    if (this.fmSync.wasRecentSelfWrite(file.path)) {
      this.bodyRenderer.retagMtime(file.path, file.stat.mtime);
      return;
    }
    // 0.180.0: our OWN frontmatter-only command write (color / task / complete /
    // due). The body is unchanged, so RETAG the render cache (keeps it fresh → the
    // re-render paints from cache with no filename-placeholder flash and no re-read)
    // — but, unlike the fmSync recovery write above, we STILL re-render so the
    // visible chip / checkbox / due badge updates.
    const fmSelf = this.wasRecentFmSelfWrite(file.path);
    if (fmSelf.hit) {
      this.bodyRenderer.retagMtime(file.path, file.stat.mtime);
      // 0.218.0: when the caller already repainted the row in place, this
      // render has nothing left to do — and doing it anyway is what moved the
      // list. Measured: color change repainted in place held at 0px until this
      // fired ~1.1s later and shifted it 95px.
      if (fmSelf.repainted) return;
      if (this.deferDuringSyncBurst()) return;
      this.debouncedRender();
      return;
    }
    // 0.227.0: everything above returned for one of OUR OWN writes, so reaching
    // here means the change came from somewhere else — another editor, Obsidian's
    // own, or sync. Those are the writes with no other trace (no command ran, so
    // nothing else logs them), and they are what you want to see when a note's
    // frontmatter or filename drifts from its body. Debounced per path so a
    // burst from sync, or a character-by-character edit in another pane, records
    // once instead of hundreds of times.
    this.logExternalEdit(file);
    // 0.122.6 (#13): drop this file's (possibly stale-content-but-fresh-mtime)
    // render-cache entry so the debounced re-render below recomputes from fresh
    // content — fixes the truncated/attachment-less "earlier version" render
    // that stuck until reload (network drive / external edits).
    this.bodyRenderer.evict(file);
    this.scheduleSlugRename(file);
    this.scheduleAttachmentSync(file);
    // 0.72.4: classify self vs external and queue the contributor stamp.
    this.authorship.noteModify(file);
    // Re-render so any visible row of this file picks up new body
    // content (and re-evaluates the "Show more" overflow check). The
    // metadataCache hook only fires for metadata-affecting edits — pure
    // body changes (e.g. pasting a long block of plain text) wouldn't
    // otherwise trigger a re-render, leaving stale clamp state.
    // 0.122.8 (F7): during a sync/bulk-write burst, hold the repaint and let
    // deferDuringSyncBurst do one render when it settles.
    if (this.deferDuringSyncBurst()) return;
    this.debouncedRender();
  };
  private onFileCreate = (file: TFile): void => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith(this.noteFolder + "/")) return;
    if (this.deferDuringSyncBurst()) return;
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
  /** 0.170.2: rename `file` so its slug matches `body`'s first line. Returns the new
   *  path if it renamed, else null. Like maybeRenameForSlug but takes a known body
   *  (used by the Edit-surface Save so it doesn't wait on the cache). */
  private async reslugFile(file: TFile, body: string): Promise<string | null> {
    const fmIdRaw = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
    const fmId = typeof fmIdRaw === "string" ? fmIdRaw : null;
    const fnId = parseIdFromFilename(file.basename);
    const id = fnId ?? (isNoteId(fmId ?? "") ? fmId : null);
    if (!id || id === ROOT_ID) return null;
    if (fmId !== id) return null;
    const desired = buildFilename(bodyToSlug(body, this.activeStopwords()), id);
    if (file.name === desired) return null;
    const newPath = file.parent ? `${file.parent.path}/${desired}` : desired;
    if (this.app.vault.getAbstractFileByPath(newPath)) return null;
    const oldPath = file.path;
    try {
      await this.app.fileManager.renameFile(file, newPath);
      await this.log.append({ type: "rename", id, payload: { from: oldPath, to: newPath } });
      return newPath;
    } catch { return null; }
  }

  private async maybeRenameForSlug(file: TFile): Promise<void> {
    const fmIdRaw = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
    const fmId = typeof fmIdRaw === "string" ? fmIdRaw : null;
    // Filename id, else the frontmatter id when it's a real note id — so a note
    // whose filename lost its `-<id>` suffix still gets re-slugged on edit.
    const fnId = parseIdFromFilename(file.basename);
    const id = fnId ?? (isNoteId(fmId) ? fmId : null);
    if (!id || id === ROOT_ID) return;
    if (fmId !== id) return; // must be a genuine Stashpad note
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
    } catch { /* ignore */ }
  }

  /** 0.227.0: record a not-by-us body edit in the per-folder action log.
   *  Debounced per path (5s) — a sync burst or a live edit in another pane
   *  fires `modify` continuously, and one entry per keystroke would drown the
   *  log it is meant to make readable. */
  private logExternalEdit(file: TFile): void {
    let d = this.externalEditDebouncers.get(file.path);
    if (d) d.cancel();
    d = debounce(() => {
      const fmId = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
      const id = (typeof fmId === "string" ? fmId : parseIdFromFilename(file.basename)) ?? ROOT_ID;
      void this.log.append({ type: "external_edit", id, payload: { path: file.path } });
      this.externalEditDebouncers.delete(file.path);
    }, 5000);
    this.externalEditDebouncers.set(file.path, d);
    d();
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
    const currentRaw = Array.isArray(fm?.attachments) ? (fm.attachments as unknown[]) : [];
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
    const text = md.replace(/^\uFEFF/, "");
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
    // 0.121.7: when NOT using the Templates plugin format, honour the user's
    // "Date display format" dropdown (+ timezone) for the two-line list
    // timestamp — previously this ignored the dropdown and was hardcoded to
    // YYYY.MM.DD / HH:mm A, so the dropdown only affected the detail/tasks panels.
    const ms = d.valueOf();
    return `${formatDateOnly(ms, settings)}\n${formatTimeOnly(ms, settings)}`;
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
  /** 0.270.1: run a positional scroll (`restore` / `scroll-to-id`) now, then
   *  RE-run it only on the steps where the list's geometry actually changed.
   *
   *  The old shape was an unconditional chain — apply at 0 / rAF / 60 / 200 /
   *  600ms — which meant that on a big list every one of those five steps
   *  moved the scroll again even when nothing had shifted. On a 347-row root
   *  list each move also re-triggers the sticky-heading work and the lazy-body
   *  observer, so the settled list kept being nudged for 600ms after the
   *  navigation: visible churn, and it is the churn the flicker report
   *  describes when you navigate UP into a large parent.
   *
   *  Gating on "did scrollHeight or clientHeight move since the last look"
   *  turns the chain into what it was always trying to be — re-apply *after*
   *  the row set settles — without inventing another timer. In the settled
   *  case it collapses to one apply plus the rAF confirmation; in the
   *  still-growing case (async markdown / attachment layout) it re-applies
   *  exactly as before.
   *
   *  clientHeight is watched as well as scrollHeight deliberately: on iOS the
   *  soft keyboard shrinks the list to ~200px and Obsidian regrows the leaf a
   *  beat later, so a scroll computed against the squeezed viewport lands
   *  clamped and the content slides ~336px when the viewport comes back. When
   *  that transition is in flight the tail step is pushed out past
   *  keyboardTransitionUntil so the final apply lands on the settled viewport
   *  rather than the squeezed one. */
  private scheduleSettleApplies(list: HTMLElement, apply: () => void, done?: () => void): void {
    let lastH = list.scrollHeight;
    let lastVH = list.clientHeight;
    apply();
    let finished = false;
    const step = (final: boolean) => (): void => {
      if (finished) return;
      // A newer render replaced the list, or the view was torn down: stop
      // touching it, but still release the caller's guard.
      if (!list.isConnected || list !== this.listEl) {
        if (final) { finished = true; done?.(); }
        return;
      }
      const h = list.scrollHeight;
      const vh = list.clientHeight;
      const moved = h !== lastH || vh !== lastVH;
      lastH = h;
      lastVH = vh;
      if (moved) apply();
      if (final) { finished = true; done?.(); }
    };
    requestAnimationFrame(step(false));
    // If the on-screen keyboard is mid-transition the viewport is still
    // moving; carry the tail past the end of that transition so the last
    // apply sees the height the user will actually be looking at.
    const kbTail = this.keyboardTransitionUntil - Date.now() + 200;
    const tail = Math.max(SCROLL_SETTLE_STEPS_MS[SCROLL_SETTLE_STEPS_MS.length - 1], kbTail);
    for (const ms of SCROLL_SETTLE_STEPS_MS) {
      if (ms >= tail) continue;
      window.setTimeout(step(false), ms);
    }
    window.setTimeout(step(true), tail);
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

  /** 0.155.1: shared "Share & export ▸" submenu — used by BOTH the desktop note
   *  context menu (`openNoteMenu`) and the mobile ⚡ actions menu, so the two
   *  entry points stay in sync (the ⚡ menu previously had no copy-link/export at
   *  all). Copy Stashpad link acts on `node` (disabled when null); the exports
   *  act on `node` (right-click semantics, `normalizeToNode: true`) or on the
   *  current selection (⚡ menu, `false`). Degrades to the command palette when
   *  the running Obsidian lacks setSubmenu (never on the 1.13 floor). */
  private addShareExportSubmenu(menu: Menu, node: TreeNode | null, opts: { normalizeToNode: boolean }): void {
    const norm = (): void => {
      if (opts.normalizeToNode && node && !this.selection.has(node.id)) {
        this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id;
      }
    };
    const add = (target: { addItem: (cb: (it: any) => unknown) => unknown }): void => {
      target.addItem((it: any) => {
        it.setTitle("Copy Stashpad link").setIcon("link");
        // Right-click (normalizeToNode) links the clicked note; the ⚡ menu links
        // the WHOLE selection (multi-link) via the no-arg selection path.
        if (node) it.onClick(() => void this.cmdCopyStashpadLink(opts.normalizeToNode ? node : undefined));
        else it.setDisabled(true);
      });
      // 0.167.0: one unified "Export…" entry — the modal now picks .stash / OKF /
      // plain .zip + content scope, so the two old items collapsed into one.
      target.addItem((it: any) => it.setTitle("Export…").setIcon("package").onClick(() => { norm(); void this.cmdExportStash(); }));
      // 0.209.9: desktop-only reveal. Hidden on mobile rather than shown-and-broken,
      // since showItemInFolder is an Electron API with no mobile equivalent.
      if (!Platform.isMobile) {
        target.addItem((it: any) => it
          .setTitle("Reveal in Finder / file manager")
          .setIcon("folder-open")
          .onClick(() => { norm(); void this.cmdRevealInFileManager(); }));
      }
    };
    menu.addItem((it: any) => {
      it.setTitle("Share & export").setIcon("share-2");
      const sub = typeof it.setSubmenu === "function" ? it.setSubmenu() : null;
      if (sub && typeof sub.addItem === "function") add(sub);
      else it.onClick(() => this.openCommandPalette());
    });
  }

  /** 0.272.0: show the note's text large enough to read across a table. */
  cmdRevealLargeText(node: TreeNode): void {
    if (!node.file) return;
    const title = this.titleForNode(node).trim();
    const body = this.plugin.renderCacheStore.get(node.file.path)?.text ?? "";
    if (body.trim()) { new LargeTextModal(this.app, title, body).open(); return; }
    // Not cached yet (row never shown): read the file, strip frontmatter.
    void this.app.vault.cachedRead(node.file).then((raw) => {
      new LargeTextModal(this.app, title, this.stripFrontmatter(raw)).open();
    }).catch(() => new Notice("Couldn't read that note."));
  }

  /** 0.272.0: run one quick-action by id against `node`. Normalises the
   *  selection to the clicked note first (same invariant as openNoteMenu), so
   *  the selection-based cmd* helpers act on the note the user tapped. */
  private runQuickAction(id: string, node: TreeNode, evt?: MouseEvent | KeyboardEvent): void {
    // "More commands…" opens the full ⋮ menu; it needs a position, so it does
    // NOT normalise the selection here (openNoteMenu does that itself).
    if (id === "more") {
      const mouse = evt instanceof MouseEvent ? evt : this.lastQuickMenuEvt;
      if (mouse) this.openNoteMenu(mouse, node);
      return;
    }
    if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
    switch (id) {
      case "copy":      void this.cmdCopy(); break;
      case "copyTree":  void this.cmdCopyTree(); break;
      case "move":      this.cmdMovePicker(); break;
      case "clone":     void this.cmdClone(); break;
      case "setColor":  this.cmdSetColor(); break;
      case "blur":      void this.cmdToggleObscured(); break;
      case "setDue":    this.cmdSetDue(); break;
      case "archive":   void this.cmdMoveToArchive(); break;
      case "largeText": this.cmdRevealLargeText(node); break;
      case "edit":      void this.cmdEdit(node); break;
      default: /* unknown id (stale settings) — skip silently */ break;
    }
  }

  /** 0.272.0: add the star quick-action button to a row/header actions cluster,
   *  before the ⋮ menu button. Hidden entirely when the user has emptied the
   *  quick-action list (nothing to show). `before`, when given, positions the
   *  star ahead of that element (the focused header creates its ⋮ first). */
  private maybeAddQuickButton(container: HTMLElement, node: TreeNode, before?: HTMLElement): void {
    if ((getSettings().quickMenuActions ?? []).length === 0) return;
    const btn = container.createEl("button", { cls: "stashpad-pencil stashpad-note-quick" });
    setIcon(btn, "star");
    btn.title = "Quick actions";
    btn.onclick = (e) => { e.stopPropagation(); this.openQuickMenu(e, node); };
    if (before) container.insertBefore(btn, before);
  }

  /** 0.272.0: the short, user-curated quick menu opened by the star button.
   *  Sits before the full ⋮ menu; contents come from `settings.quickMenuActions`
   *  in that order. Falls back to nothing (button hidden) when the list is
   *  empty — see the star-button render guard. */
  private lastQuickMenuEvt: MouseEvent | null = null;
  private openQuickMenu(evt: MouseEvent, node: TreeNode): void {
    if (!node.file) return;
    this.lastQuickMenuEvt = evt;   // fallback position for "More commands…"
    const ids = getSettings().quickMenuActions ?? [];
    const byId = new Map(QUICK_ACTION_CATALOG.map((a) => [a.id, a]));
    const menu = new Menu();
    let added = 0;
    for (const id of ids) {
      const def = byId.get(id);
      if (!def) continue;   // stale/unknown id
      menu.addItem((it: any) => it.setTitle(def.label).setIcon(def.icon).onClick((e: MouseEvent | KeyboardEvent) => this.runQuickAction(id, node, e)));
      added += 1;
    }
    if (added === 0) { this.openNoteMenu(evt, node); return; }   // nothing configured → fall back to full menu
    // "More commands…" escape hatch to the full ⋮ menu, on by default.
    if (getSettings().quickMenuIncludeMore) {
      menu.addSeparator();
      menu.addItem((it: any) => it.setTitle(QUICK_MENU_MORE.label).setIcon(QUICK_MENU_MORE.icon).onClick((e: MouseEvent | KeyboardEvent) => this.runQuickAction("more", node, e)));
    }
    menu.showAtMouseEvent(evt);
  }

  private openNoteMenu(evt: MouseEvent, node: TreeNode): void {
    if (!node.file) return;
    const file = node.file;
    const menu = new Menu();
    /** THE invariant of this menu: an item acts on the note that was
     *  right-clicked, even when it isn't the selected one — and, from the
     *  focused-note header, even when it isn't in the list at all. An existing
     *  multi-selection that already contains this note is preserved.
     *
     *  Any item whose command resolves its own targets (i.e. calls
     *  `getActionTargets()` rather than taking a node) MUST call this first.
     *  This was five copy-pasted copies of the same line; "Move to…" was the
     *  one that never got a copy, and it silently moved the wrong note until
     *  0.257.0. One definition now, so a new item has something to call rather
     *  than something to remember. */
    const focusClicked = (): void => {
      if (!this.selection.has(node.id)) { this.selection.clear(); this.selection.add(node.id); this.lastSelected = node.id; }
    };
    menu.addItem((it: any) => it.setTitle("Open in new Stashpad tab").setIcon("layout-grid").onClick(() => {
      void this.openInNewStashpadTab(node.id);
    }));
    menu.addItem((it: any) => it.setTitle("Open in Obsidian editor").setIcon("file-text").onClick(() => {
      void this.openFileAtEnd(file);
    }));
    menu.addItem((it: any) => it.setTitle("Focus in Stashpad").setIcon("arrow-right").onClick(() => this.navigateTo(node.id)));
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Edit in Stashpad").setIcon("pencil-line").onClick(() => void this.cmdEdit(node)));
    menu.addItem((it: any) => it.setTitle("Split note…").setIcon("split").onClick(() => void this.cmdSplit(node)));
    // Only meaningful on a repeating task; hidden otherwise so the menu stays short.
    if (parseRecurrence(this.app.metadataCache.getFileCache(node.file!)?.frontmatter?.repeat as string | undefined)) {
      menu.addItem((it: any) => it.setTitle("Skip to next occurrence").setIcon("skip-forward").onClick(() => void this.cmdSkipOccurrence(node)));
    }
    // 0.122.2 (#9): copy the note's text. `focusClicked` (defined below)
    // normalises selection to the right-clicked row.
    // 0.122.10: ordered above Clone so the plain "Copy text" reads first.
    menu.addItem((it: any) => it.setTitle(`Copy text${getSettings().prefixTimestampsOnCopy ? " with timestamps" : ""}`).setIcon("copy").onClick(() => { focusClicked(); void this.cmdCopy(); }));
    menu.addItem((it: any) => it.setTitle("Clone (duplicate / copy)").setIcon("files").onClick(() => {
      // Operate on the right-clicked row even if it isn't selected.
      focusClicked();
      void this.cmdClone();
    }));
    // 0.122.7: "Cut note" pulled from the menu for now — cut/paste has known bugs
    // and cutting a parent/home note from the context menu is too easy a footgun.
    // Still available via the cutNotes hotkey. (See ui-polish todos.)
    menu.addItem((it: any) => it.setTitle("Fork into a separate note…").setIcon("git-branch").onClick(() => {
      focusClicked();
      this.cmdForkNote();
    }));
    // 0.122.2 (#9): "Insert template…" removed from the right-click menu to keep
    // it compact — still available via command palette + its hotkey.
    // 0.155.0: Copy Stashpad link + both export flows grouped under a shared
    // "Share & export ▸" submenu (mirrors the Task ▸ submenu + the locked-row
    // menu) so the top level stays short. Multi-select normalisation matches
    // Clone / Delete / Set color. Degrades to the command palette if the running
    // Obsidian lacks setSubmenu (never on the 1.13 minAppVersion floor).
    this.addShareExportSubmenu(menu, node, { normalizeToNode: true });
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
    // 0.257.0: focusClicked FIRST. Without it this moved whatever the LIST had
    // selected instead of the note the menu was opened on — and since a list
    // row is always selected, it always moved the wrong note. Worst from the
    // focused-note header, where the note you right-clicked isn't even in the
    // list: you asked to move the parent and a child moved. Every other item in
    // this menu already normalises (directly, via focusClicked, or via taskAct);
    // this one was the only hole.
    // 0.267.1: obscure/reveal on the ROW menu, not only the lightning menu.
    //
    // Without it there was no per-note control at all once a global or folder
    // default was on: a note carrying an explicit "don't obscure" had no
    // visible way back, and the state was invisible too. The title states the
    // CURRENT state rather than a bare "toggle", so the menu answers "is this
    // one hidden?" without having to try it.
    // 0.267.2: THREE states, not two. `isObscured` stays true for a note that
    // is merely revealed — revealing is a viewing state, not a change to the
    // note — so asking it alone offered "Reveal" on something already revealed.
    //
    // Routed through the same per-node action the badge uses, so the label and
    // the behaviour cannot drift apart.
    const obscured = this.isObscured(node);
    const shown = obscured && this.revealedObscured.has(node.id);
    menu.addItem((it: any) => it
      .setTitle(shown ? "Hide this note again"
        : obscured ? "Stop obscuring this note"
        : "Obscure this note (visual only)")
      .setIcon(shown || !obscured ? "eye-off" : "eye")
      .onClick(() => { focusClicked(); void this.menuObscureAction(node); }));
    menu.addItem((it: any) => it.setTitle("Move to…").setIcon("move").onClick(() => { focusClicked(); this.cmdMovePicker(); }));
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
    // 0.105.0: list pin — float to an end of THIS list (distinct from sidebar).
    // 0.270.0: now a submenu, since there are two ends to pin to. A pinned note
    // also ignores the time filter, so the label says so once here rather than
    // surprising the user later.
    const pinEdge = this.listPinEdge(node.id);
    menu.addItem((it: any) => {
      it.setTitle("Pin in list").setIcon(pinEdge ? "pin-off" : "pin");
      const sub = it.setSubmenu();
      sub.addItem((s: any) => s
        .setTitle("Top of list")
        .setIcon("arrow-up-to-line")
        .setChecked(pinEdge === "top")
        .onClick(() => { focusClicked(); void this.cmdToggleListPin("top"); }));
      sub.addItem((s: any) => s
        .setTitle("Bottom of list")
        .setIcon("arrow-down-to-line")
        .setChecked(pinEdge === "bottom")
        .onClick(() => { focusClicked(); void this.cmdToggleListPin("bottom"); }));
      if (pinEdge) {
        sub.addSeparator();
        sub.addItem((s: any) => s
          .setTitle("Unpin from list")
          .setIcon("pin-off")
          .onClick(() => { focusClicked(); void this.cmdToggleListPin(pinEdge); }));
      }
    });
    menu.addItem((it: any) => it.setTitle("Set color…").setIcon("palette").onClick(() => {
      // Operate on the right-clicked row even if it isn't selected.
      focusClicked();
      this.cmdSetColor();
    }));
    // 0.104.x: task actions grouped under a "Task ▸" submenu to keep the
    // right-click menu compact (Obsidian already repositions to stay
    // on-screen; height is the real lever). Task gating: completion is only
    // offered once a note IS a task — non-tasks show "Turn into task"; tasks
    // show "Mark complete" + "Remove from tasks". Right-click is single-node,
    // so the gate is unambiguous (the mobile ⚡ menu keeps its multi-select
    // toggles). Every entry normalises selection to the right-clicked row.
    // setSubmenu is internal/untyped — accessed via the existing `it: any`
    // pattern; falls back to opening the command palette if unavailable
    // (effectively never on the 1.13 minAppVersion floor).
    // 0.224.0: these items live in a SUBMENU. Obsidian dismisses the menu a
    // clicked item belongs to, but on mobile the parent sheet stays up — so
    // marking a task complete left the overlay covering the very row you were
    // acting on. Close the ROOT menu explicitly, before running the action, so
    // the list is visible while it updates.
    let taskSubmenu: { close?: () => void } | null = null;
    const taskAct = (fn: () => unknown): void => {
      focusClicked();
      // Close the SUBMENU explicitly as well as the root. Closing the root
      // usually cascades, but the submenu is the sheet actually covering the
      // row on mobile — so it is the one that must be gone, and it should not
      // depend on cascade behaviour we don't control.
      try { taskSubmenu?.close?.(); } catch { /* not all builds expose it */ }
      menu.close();
      void fn();
    };
    const addTaskItems = (target: { addItem: (cb: (it: any) => unknown) => unknown }): void => {
      const isTaskNote = this.isTask(node);
      if (isTaskNote) {
        const isDone = this.isCompleted(node);
        target.addItem((it: any) => it.setTitle(isDone ? "Mark incomplete" : "Mark complete").setIcon(isDone ? "circle" : "check-circle").onClick(() => taskAct(() => this.cmdToggleComplete())));
      } else {
        // 0.122.2 (#10): let non-tasks be marked complete too (sets `completed`;
        // the note then counts as a task via the bare-completed field).
        target.addItem((it: any) => it.setTitle("Mark complete").setIcon("check-circle").onClick(() => taskAct(() => this.toggleCompletedForNode(node))));
        target.addItem((it: any) => it.setTitle("Turn into task").setIcon("check-square").onClick(() => taskAct(() => this.cmdToggleTask())));
      }
      target.addItem((it: any) => it.setTitle("Assign / schedule…").setIcon("user-plus").onClick(() => taskAct(() => this.cmdAssign())));
      if (isTaskNote) {
        // 0.125.0: Snooze — reschedule the due date (date-only picker).
        target.addItem((it: any) => it.setTitle("Snooze (reschedule)…").setIcon("alarm-clock").onClick(() => taskAct(() => this.cmdSnooze(node))));
        target.addItem((it: any) => it.setTitle("Remove from tasks").setIcon("square").onClick(() => taskAct(() => this.cmdToggleTask())));
      }
    };
    menu.addItem((it: any) => {
      it.setTitle("Task").setIcon("check-square");
      const sub = typeof it.setSubmenu === "function" ? it.setSubmenu() : null;
      if (sub && typeof sub.addItem === "function") { taskSubmenu = sub; addTaskItems(sub); }
      else it.onClick(() => this.openCommandPalette()); // degraded fallback
    });
    menu.addSeparator();
    menu.addItem((it: any) => it.setTitle("Delete").setIcon("trash").onClick(async () => {
      // Route through cmdDelete (not deleteNote directly) so the encryptTrash
      // override applies here too — otherwise right-click Delete sends
      // plaintext to the system trash with "Encrypt items sent to trash" ON.
      focusClicked();
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
        // 0.211.5 (M7/M8): same exclusivity + snapshot-parity fix as the bulk delete —
        // see attachmentsSafeToDelete. Don't trash an attachment a surviving note still
        // uses, and never trash one the undo snapshot doesn't hold.
        const deletingPaths = new Set(all.map((n) => n.file?.path).filter((p): p is string => !!p));
        const { files: attFiles, sharedSkipped } = await this.attachmentsSafeToDelete(uniqueAtts, deletingPaths);
        const inSnap = new Set(snap.attachments.map((a) => a.path));
        for (const f of attFiles) {
          if (inSnap.has(f.path)) continue;
          try { snap.attachments.push({ path: f.path, data: await this.app.vault.readBinary(f) }); inSnap.add(f.path); }
          catch { /* unreadable — skip rather than trash something undo can't restore */ }
        }
        if (sharedSkipped > 0) {
          this.plugin.notifications.show({
              message: `Kept ${sharedSkipped} attachment${sharedSkipped === 1 ? "" : "s"} — still used by ${sharedSkipped === 1 ? "another note" : "other notes"}.`,
              kind: "info", category: "delete", folder: this.noteFolder, duration: 7000,
            });
        }
        for (const f of attFiles.filter((f) => inSnap.has(f.path))) {
          {
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
            } catch { /* ignore */ }
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
        try { await this.app.fileManager.trashFile(n.file); } catch { /* ignore */ }
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
      // 0.211.4 (M1): same two-controllers-one-boolean defect as the bulk delete above
      // — see the comment there. Restoring via the toast neutralises the stack entry,
      // and redo additionally refuses to re-trash a note edited since the snapshot.
      let restored = false;
      let handledOutOfBand = false;
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
        actions: [{ label: "Undo delete", onClick: () => { handledOutOfBand = true; void doRestore(); } }],
      });
      this.plugin.getUndoStack(folder).push({
        label,
        undo: async () => { if (handledOutOfBand) return; await doRestore(); },
        redo: async () => {
          if (handledOutOfBand) return;
          for (const n of snap.notes) {
            const f = this.app.vault.getAbstractFileByPath(n.path) as TFile | null;
            if (!f) continue;
            let cur: string | null = null;
            try { cur = await this.app.vault.read(f); } catch { cur = null; }
            if (cur !== null && cur !== n.content) {
              new Notice("Didn't redo the delete — that note has been edited since. Delete it again if you meant to.", 8000);
              return;
            }
          }
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
    // 0.257.0: the home note IS the folder's root — reparenting it would give
    // the tree a root with a parent. Previously unreachable in practice (the
    // home note is never a cursor row and nothing selected it), but normalising
    // the context menu's "Move to…" to the right-clicked note makes the Home
    // header's own menu a live path to it. Guarded here rather than by hiding
    // the menu item, so every caller — drag, hotkey, palette — is covered.
    if (node.id === ROOT_ID) {
      this.plugin.notifications.show({
        message: "The home note can't be moved — it's what the folder's notes hang from.",
        kind: "warning",
        category: "move",
        folder: this.noteFolder,
      });
      return false;
    }
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
          const f = this.fileForNote(movedId, filePath);
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
          const f = this.fileForNote(movedId, filePath);
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

// (0.136.0: ArchiveFolderSuggestModal removed — archiving always targets the
// current folder's own `archive/` subfolder now, so there's nothing to pick.)

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
