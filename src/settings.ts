import { App, Notice, Platform, PluginSettingTab, Setting, SettingPage, TFile, setIcon, type SettingDefinitionItem } from "obsidian";

/** Platform-correct OS file-manager name for button/notice labels. */
function osFileManagerName(): string {
  return Platform.isMacOS ? "Finder" : Platform.isWin ? "File Explorer" : "file manager";
}
import { buildJdIndexPreview, buildJdIndexNotes, scanForJdNotes, JdBuildConfirmModal, buildJdPreviewNotice } from "./index-builder";
import { FolderSuggest } from "./folder-suggest";
import type StashpadPlugin from "./main";
import { RESERVED_FRONTMATTER, type ViewMode } from "./types";
import { LogModal, ColorPickerModal, NotificationHistoryModal, EncryptionPasswordModal, TypeToConfirmModal, ConfirmModal } from "./modals";
import { CATEGORY_LABELS, type NotificationCategory } from "./notifications";
import { startHotkeyRecording, prettifyChord } from "./hotkey-recorder";
import { DEFAULT_STOPWORDS } from "./slug-service";
import { newId } from "./id-service";
import { formatDateTime } from "./format";
import { type EncryptionConfig, defaultEncryptionConfig } from "./encryption-service";
import { getActiveView } from "./active-view";

export interface ShortcutMap {
  move: string;        // M  — move selection via picker
  pickMove: string;    // O  — move via in-list arrow nav
  merge: string;       // &
  copy: string;        // C
  copyTree: string;    // Y
  openEditor: string;  // E  — open in regular Obsidian markdown tab
  openTab: string;     // T  — open in a new Stashpad tab
  split: string;       // (empty by default) — split selected note into two
  copyOutline: string; // (empty by default) — copy selection as nested embed outline
}

export interface ModShortcuts {
  toggleSplit: string;      // e.g. "Mod+/"
  pickDestination: string;  // "Mod+D"
  search: string;           // "Mod+F"
  delete: string;           // "Mod+Backspace"
  undo: string;             // "Mod+Z"
  redo: string;             // "Mod+Shift+Z"
  toggleComplete: string;   // "Mod+Enter"
  moveUp: string;           // "Mod+ArrowUp"
  moveDown: string;         // "Mod+ArrowDown"
  moveToTop: string;        // "Mod+Shift+ArrowUp"
  moveToBottom: string;     // "Mod+Shift+ArrowDown"
  outdent: string;          // "Mod+[" — re-parent selection to its grandparent
  setColor: string;         // "Shift+:" — open color picker for selection
}

/** All keyboard-bindable commands, in display order. The labels and
 *  descriptions live in COMMAND_META below. */
export type CommandId =
  | "move" | "pickMove" | "merge" | "copy" | "copyTree" | "openEditor" | "openTab"
  | "split" | "copyOutline"
  | "toggleSplit" | "pickDestination" | "search" | "searchInParent" | "delete" | "undo" | "redo"
  | "toggleComplete" | "moveUp" | "moveDown" | "moveToTop" | "moveToBottom"
  | "outdent" | "setColor"
  | "clone" | "insertTemplate"
  | "toggleExpand"
  | "exportStash" | "importStash" | "pickFolder"
  | "cloneStashpadTab" | "selectAll" | "copyCodeBlock"
  | "swapWithParent"
  | "togglePin"
  | "toggleTask" | "setDue"
  | "jumpToTop" | "jumpToBottom"
  | "lockSelection" | "unlockAll"
  | "commandPalette";

/** Per-command bindings: up to two chord strings ("S" or "Mod+Enter").
 *  When BOTH are set, `preferRight` decides which actually fires. */
export interface CommandBinding {
  primary: string;
  secondary: string;
  preferRight: boolean;
  /** When true, BOTH `primary` and `secondary` fire — `preferRight` is
   *  ignored. Lets users bind two simultaneously-active chords for a
   *  command (e.g. "Mod+Enter" + "T") instead of having to pick one.
   *  0.59.1. */
  useBoth?: boolean;
}
export type CommandBindingMap = Record<CommandId, CommandBinding>;

export interface CommandMeta {
  id: CommandId;
  label: string;
  desc: string;
  /** Default primary chord — what users get on a fresh install. */
  defaultPrimary: string;
  /** Optional default SECONDARY chord. When set alongside defaultUseBoth,
   *  a fresh install gets two simultaneously-active chords for the command. */
  defaultSecondary?: string;
  /** When true, the default binding has BOTH chords active (useBoth). */
  defaultUseBoth?: boolean;
}

export const COMMAND_META: CommandMeta[] = [
  { id: "move",            label: "Move (picker)",                 desc: "Open a fuzzy picker to choose the new parent.",                                          defaultPrimary: "M" },
  { id: "pickMove",        label: "Move (in-list)",                desc: "Highlight a note in the list with arrows; Enter sets it as parent.",                     defaultPrimary: "O" },
  { id: "merge",           label: "Merge",                         desc: "Concatenate selected notes into the oldest one.",                                        defaultPrimary: "&" },
  { id: "copy",            label: "Copy",                          desc: "Copy selected note bodies to clipboard.",                                                defaultPrimary: "C" },
  { id: "copyTree",        label: "Copy tree",                     desc: "Copy the focused note + all descendants, indented.",                                     defaultPrimary: "Y" },
  { id: "openEditor",      label: "Open in editor",                desc: "Open the cursor row (or focused note) in a regular Obsidian markdown tab.",              defaultPrimary: "E" },
  { id: "openTab",         label: "Open in new Stashpad tab",      desc: "Open the cursor row (or focused note) in a new Stashpad tab focused on it.",             defaultPrimary: "T" },
  { id: "split",           label: "Split note",                    desc: "Split the cursor row (or focused note) into two notes at a chosen line.",                defaultPrimary: "S" },
  { id: "copyOutline",     label: "Copy as outline",               desc: "Copy selection (or cursor row) as a nested ![[embed]] outline.",                         defaultPrimary: "L" },
  { id: "toggleSplit",     label: "Toggle split-on-newlines",      desc: "Default: Mod+/",                                                                          defaultPrimary: "Mod+/" },
  { id: "pickDestination", label: "Pick destination",              desc: "Default: Mod+D",                                                                          defaultPrimary: "Mod+D" },
  { id: "search",          label: "Search notes",                  desc: "Default: Mod+F",                                                                          defaultPrimary: "Mod+F" },
  { id: "searchInParent",  label: "Search in current parent",      desc: "Default: Mod+Alt+F (Mod+Shift+F is taken by Obsidian's global search).", defaultPrimary: "Mod+Alt+F" },
  { id: "delete",          label: "Delete selection",              desc: "Default: Mod+Backspace",                                                                  defaultPrimary: "Mod+Backspace" },
  { id: "undo",            label: "Undo",                          desc: "Default: Mod+Z (Stashpad-only — won't fire while typing in the composer).",                defaultPrimary: "Mod+Z" },
  { id: "redo",            label: "Redo",                          desc: "Default: Mod+Shift+Z",                                                                    defaultPrimary: "Mod+Shift+Z" },
  { id: "toggleComplete",  label: "Toggle complete (strikethrough)", desc: "Default: Mod+Enter or X — marks selected/focused notes as complete (both chords active).", defaultPrimary: "Mod+Enter", defaultSecondary: "X", defaultUseBoth: true },
  { id: "moveUp",          label: "Move note up",                  desc: "Default: Mod+ArrowUp",                                                                    defaultPrimary: "Mod+ArrowUp" },
  { id: "moveDown",        label: "Move note down",                desc: "Default: Mod+ArrowDown",                                                                  defaultPrimary: "Mod+ArrowDown" },
  { id: "moveToTop",       label: "Move note to top",              desc: "Default: Mod+Shift+ArrowUp",                                                              defaultPrimary: "Mod+Shift+ArrowUp" },
  { id: "moveToBottom",    label: "Move note to bottom",           desc: "Default: Mod+Shift+ArrowDown",                                                            defaultPrimary: "Mod+Shift+ArrowDown" },
  { id: "outdent",         label: "Outdent (move to grandparent)", desc: "Default: Mod+[ — re-parents the selection one level up.",                                defaultPrimary: "Mod+[" },
  { id: "setColor",        label: "Set note color",                desc: "Default: Shift+: or ; — open the color picker for the selection (both chords active).",   defaultPrimary: "Shift+:", defaultSecondary: ";", defaultUseBoth: true },
  { id: "clone",           label: "Clone (duplicate / copy) selection", desc: "Default: Mod+Shift+D — clone selected notes (with their subtrees) as siblings.",   defaultPrimary: "Mod+Shift+D" },
  { id: "insertTemplate",  label: "Insert template (clone an existing note)", desc: "Pick any note in this Stashpad; clone it (with subtree + attachments) into the current view, retimestamped.", defaultPrimary: "" },
  { id: "toggleExpand",    label: "Show more / show less (expand toggle)", desc: "Default: Shift+? — toggle the clamp on the cursor row (or every selected row).", defaultPrimary: "Shift+?" },
  { id: "exportStash",     label: "Export selection to .stash",    desc: "Export the selected subtree(s) as a .stash bundle (notes + attachments).",                defaultPrimary: "" },
  { id: "importStash",     label: "Import .stash file",            desc: "Open the .stash bundle picker and import its notes into this Stashpad.",                  defaultPrimary: "" },
  { id: "pickFolder",      label: "Open / switch / create Stashpad folder", desc: "Default: Mod+S — opens the unified folder picker (reveal, switch, create, convert).", defaultPrimary: "Mod+S" },
  { id: "cloneStashpadTab",label: "Clone (duplicate / copy) this Stashpad tab", desc: "Open a second tab on the same folder + focus, mirroring the \"copy\" button in the focused-header actions.", defaultPrimary: "" },
  { id: "selectAll",       label: "Select all notes in view",      desc: "Default: Mod+A — adds every visible row to the selection.",                              defaultPrimary: "Mod+A" },
  { id: "copyCodeBlock",   label: "Copy code from codeblock",      desc: "Default: { — copy the contents of the cursor row's first codeblock (or pick one when multiple exist).", defaultPrimary: "{" },
  { id: "swapWithParent",  label: "Swap with parent (ouroboros)",  desc: "Promote the cursor row above its current parent; the parent slides under it (carrying its other children). No default — bind in this tab.", defaultPrimary: "" },
  { id: "togglePin",       label: "Pin / unpin selected note",     desc: "Default: P — toggle the sidebar pin state of the cursor row (or focused note).", defaultPrimary: "P" },
  { id: "toggleTask",      label: "Toggle task (todo)",            desc: "Default: H — mark the selection (or cursor row) as a task / todo, or clear it. Tasks appear in the Tasks panel.", defaultPrimary: "H" },
  { id: "setDue",          label: "Set due date…",                 desc: "Default: D — open a date+time picker to set (or clear) the due date on the selection. Setting a due date also marks the note as a task.", defaultPrimary: "D" },
  { id: "jumpToTop",       label: "Jump to top of list",           desc: "Default: Home — move the cursor to the first note in the current list.", defaultPrimary: "Home" },
  { id: "jumpToBottom",    label: "Jump to bottom of list",        desc: "Default: End — move the cursor to the last note in the current list.", defaultPrimary: "End" },
  { id: "commandPalette",  label: "Command palette (Stashpad only)", desc: "Default: Mod+K — open a command palette listing only Stashpad's commands, with Sift search.", defaultPrimary: "Mod+K" },
  { id: "lockSelection",   label: "Encrypt (lock) selection",      desc: "Encrypt the selected note(s) + their children into a locked .stashenc bundle in place (prompts to unlock first if needed). No default chord.", defaultPrimary: "" },
  { id: "unlockAll",       label: "Decrypt (unlock) locked notes in view", desc: "Decrypt every locked stash shown in the current view back into place, skipping any that can't be read. No default chord.", defaultPrimary: "" },
];

export function buildDefaultBindings(): CommandBindingMap {
  const out: Partial<CommandBindingMap> = {};
  for (const m of COMMAND_META) {
    out[m.id] = {
      primary: m.defaultPrimary,
      secondary: m.defaultSecondary ?? "",
      preferRight: false,
      useBoth: !!m.defaultUseBoth,
    };
  }
  return out as CommandBindingMap;
}

export interface StashpadSettings {
  folder: string;
  importDropFolder: string;
  exportFolder: string;
  /** 0.79.1: auto-import files dropped directly into a Stashpad folder
   *  root. Markdown → Stashpad note (original archived to .archive);
   *  other files → a linking note + the file moved to _attachments. */
  autoImport: boolean;
  /** 0.79.14: when on, Stashpad's link autocomplete + file surfaces also
   *  honor Obsidian's "Excluded files" (userIgnoreFilters), so exclusions
   *  are managed in one place. `.edtz` is always excluded regardless. */
  inheritObsidianExclusions: boolean;
  /** 0.86.2: folder panel — fraction of height given to the Pinned section
   *  (the rest goes to Folders). Set by dragging the divider. 0.15–0.85. */
  folderPanelPinnedFraction: number;
  /** 0.95.1: folder-panel per-folder placement. Cleaned folder paths
   *  (trailing-slash-stripped). A folder is in at most one of these; toggling
   *  one clears it from the others. Pinned cluster at the top of the Folders
   *  list, downranked sink to a dimmed group at the bottom, hidden are removed
   *  from the list entirely (restorable from the panel's "Hidden" section or
   *  the settings window). */
  folderPanelPinned: string[];
  folderPanelDownranked: string[];
  folderPanelHidden: string[];
  /** 0.95.1: how the folder-panel Pinned section orders its notes.
   *  "pin-order" (default) = flat list in pin order; "folder" = grouped under
   *  per-Stashpad headers. */
  folderPanelPinnedGrouping: "pin-order" | "folder";
  /** 0.81.1: opt-in performance profiling — accumulates render/read/write
   *  timing so the "Dump performance profile" command reports where the
   *  time goes on a slow vault. Off by default. */
  enablePerfProfiling: boolean;
  /** 0.83.1: maintain the redundant `parentLink`/`children` recovery
   *  fields on every move. Default true. Turning it off skips those writes
   *  entirely — a big speedup on slow/network drives (each is a full
   *  round-trip and a move triggers several); Rebootstrap backfills them on
   *  demand, and the canonical id/parent is unaffected. */
  writeRecoveryLinks: boolean;
  useTemplatesFormat: boolean;
  prefixTimestampsOnCopy: boolean;
  splitOnLines: boolean;
  confirmCrossParentDrag: boolean;
  /** When true (default), warn before deletes that affect more than one
   *  note — i.e. a multi-selection delete OR deleting a note that has
   *  descendants. Off = those deletes apply immediately. Single childless
   *  notes never prompt either way. */
  confirmBulkDelete: boolean;
  /** When true (default), if the note(s) being deleted reference any
   *  attachments, the delete modal includes an "Also delete attachments"
   *  checkbox (checked by default). Off = attachments are always
   *  preserved on delete, no checkbox shown, and no modal is opened for
   *  attachments alone. Attachment recognition uses both `![[…]]` embeds
   *  in the body AND the frontmatter `attachments:` list (union) so a
   *  malformed body never silently undercounts. */
  confirmAttachmentDelete: boolean;
  /** When true (default), the composer textarea is re-focused after each
   *  Enter-submit so you can keep typing the next note. Off = focus stays
   *  in the list so arrow-keys keep working without an extra click. */
  autofocusComposerAfterSend: boolean;
  /** When true (default), the "open in new window" button duplicates
   *  the current tab into the popout window (original stays open in the
   *  main window). When false, the leaf is moved — the original tab
   *  closes. 0.61.3. */
  popoutDuplicates: boolean;
  /** 0.97.0: vault encryption (Phase 1 — key management only). `encryption`
   *  holds the WRAPPED master key + verifier (never the password/raw key); see
   *  EncryptionConfig. The toggles are stored now but only take effect once the
   *  delete-encryption phase lands. */
  encryption: EncryptionConfig;
  /** Encrypt items sent to trash (default OFF). Not yet wired to delete. */
  encryptTrash: boolean;
  /** Also encrypt the FILENAMES of trashed items (default OFF) — off so external
   *  restore stays possible. */
  encryptTrashFilenames: boolean;
  /** 0.98.29 (Phase 5): when true, encrypted-delete follows Obsidian's NATIVE
   *  trash setting instead of routing into the in-vault `_deleted/` store. Default
   *  false. Following Obsidian's flow means deleted notes go to the system/OS trash
   *  (or are permanently removed) per your "Deleted files" setting — Stashpad can't
   *  encrypt OR list those, so encrypted-trash + the recoverable trash view won't
   *  apply. The `_deleted/` store is the secure default precisely because it's the
   *  only location Stashpad fully controls. */
  encryptTrashFollowObsidian?: boolean;
  /** Drop the in-memory key after N idle minutes (0 = never). */
  encryptionIdleLockMinutes: number;
  /** 0.98.14: hide the note title on locked placeholders (show a generic label
   *  instead) so a glance at the vault doesn't reveal what's locked. Default OFF
   *  (titles shown). Global for now; per-folder/trash scoping is future work. */
  hideLockedTitles: boolean;
  /** 0.98.25 (Phase 4): archive folders — notes MOVED into one of these Stashpad
   *  folders are automatically encrypted (locked). Opt-in per folder via the
   *  folder panel; requires an explicit confirm when marking (lock permanently
   *  deletes the plaintext). Never fires on create/edit — move-in only. */
  archiveFolders: string[];
  /** 0.98.28 (Phase 4): the default target for the "Move to archive" command.
   *  Optional — if blank, the command offers a pick-list of all archive folders
   *  (or uses the only one if there's exactly one). */
  defaultArchiveFolder?: string;
  /** 0.98.1: registry of locked subtrees, so the list can render a placeholder
   *  where the note was (and find the blob to unlock). One entry per `.stashenc`
   *  bundle. `parentId` = where the locked root was attached (null/ROOT = top). */
  lockedSubtrees: Array<{ folder: string; blob: string; parentId: string | null; title: string; count: number; created?: string; rootId?: string; prevSibling?: string | null }>;
  /** 0.96.0: when true (default), picking a result in the Search modal opens
   *  it in a NEW Stashpad tab instead of navigating the current tab. Applies to
   *  both same-folder and cross-Stashpad results. Folder-open picks always open
   *  a new tab regardless. */
  searchOpensInNewTab: boolean;
  /** 0.68.0: notes the user has pinned to the sidebar Pinned Notes
   *  panel. Cross-folder; rendered in array order. */
  pinnedNotes: Array<{ folder: string; id: string }>;
  /** Mobile-only: hide Obsidian's mobile toolbar (the floating bar above
   *  the keyboard) while a Stashpad view is the active leaf. Stashpad's
   *  composer doesn't need it and it covers the input on smaller screens.
   *
   *  NOTE: in practice the CSS hook driven by this flag doesn't actually
   *  hide the toolbar on current Obsidian mobile builds — the user-facing
   *  toggle was removed in 0.51.13. The flag + the body-class toggling in
   *  main.ts are kept in case a future Obsidian release exposes a
   *  reachable selector and we can wire it back up without re-introducing
   *  setting/migration churn. Defaults true so an eventual working
   *  implementation just starts hiding the toolbar for everyone. */
  hideMobileToolbarInStashpad: boolean;
  /** Words to strip out of generated slugs (file titles). One word per
   *  array entry. Falls back to DEFAULT_STOPWORDS when empty. */
  slugStopWords: string[];
  /** Folders explicitly INCLUDED in cross-Stashpad search/picker. When
   *  empty, every Stashpad folder is included by default. Use this for
   *  an allowlist setup. */
  searchIncludedFolders: string[];
  /** Folders excluded from cross-Stashpad search/picker. Notes inside
   *  excluded folders aren't surfaced when searching from another
   *  folder, but cross-folder MOVE still works (you can drop a note
   *  into an excluded folder, and you can move out of one). */
  searchExcludedFolders: string[];
  shortcuts: ShortcutMap;
  mod: ModShortcuts;
  /** Unified per-command bindings. Each command can have a primary and a
   *  secondary chord; preferRight picks which fires when both are set.
   *  Migration from legacy shortcuts/mod fills this on first load if it's
   *  missing. */
  bindings: CommandBindingMap;
  /** User-saved custom colors, appended after the default palette in the
   *  color picker. Hex strings like "#a1b2c3". */
  customPalette: string[];
  /** Per-Stashpad-folder color aliases. Outer key = folder path, inner
   *  key = hex string (lowercased), value = display name. The same hex
   *  in two different Stashpads can mean different things, so aliases
   *  are scoped per folder. Filters still operate on the underlying
   *  hex; only the label changes. */
  colorAliases: Record<string, Record<string, string>>;
  /** Per-Stashpad-folder template note path. When set, new notes are
   *  built by overlaying the template's frontmatter (and optional body,
   *  if it contains `{{body}}` it's substituted) — the auto-managed
   *  fields (id, parent, created, attachments) always win. Empty/missing
   *  = no template. */
  noteTemplates: Record<string, string>;
  /** Multiplayer / authorship. Each Obsidian config folder has its own
   *  data.json, so `authorName` + `authorId` naturally scope to a
   *  single human even when the vault is shared across coworkers via
   *  separate `--config` paths.
   *  - authorName: human-readable, shown in the note footer.
   *  - authorId: short stable id; auto-generated on first save if blank.
   *    Disambiguates same-named coworkers (links use "Name (id)").
   *  - showAuthor / showContributors / showLastEdit: footer-row toggles. */
  authorName: string;
  authorId: string;
  /** Optional title/role (e.g. "Engineer", "PM"). Surfaced in the
   *  author stub file's frontmatter so the per-user page is meaningfully
   *  populated; not currently rendered in the note footer. */
  authorRole: string;
  /** Optional department / team. Same treatment as authorRole. */
  authorDepartment: string;
  showAuthor: boolean;
  showContributors: boolean;
  showLastEdit: boolean;
  /** Per-folder view mode (Nested / Flat / Everything). Keyed by Stashpad
   *  folder path. Absence means the default "nested" mode — the file only
   *  persists folders that have an explicit non-default mode. */
  viewModes: Record<string, ViewMode>;
  /** Per-folder "include attachments" toggle for Everything mode. Defaults
   *  to false (attachments hidden — they already show inline on the notes
   *  that reference them). Only consulted when viewMode === "everything";
   *  Nested / Flat ignore it. */
  includeAttachmentsInEverything: Record<string, boolean>;
  /** Per-folder filter: hide top-level notes that have no children
   *  (i.e. show only notes that ARE parents). Applies structurally —
   *  only to the topmost level of the displayed list, regardless of
   *  view mode:
   *    - Nested: filter the immediate children of focus.
   *    - Flat / Everything: filter the immediate children of focus,
   *      THEN include each survivor's full subtree as descendants in
   *      the flat list (descendants themselves aren't filtered — the
   *      whole point is to scan every parent's task subtree).
   *  Default false. */
  hideChildlessNotes: Record<string, boolean>;
  /** 0.98.26: per-folder encryption view filter. Absent = show everything;
   *  "locked" = only 🔒 locked stubs; "unlocked" = only normal (decrypted) notes. */
  encryptionFilter?: Record<string, "locked" | "unlocked">;
  /** Per-folder filter: hide notes marked complete, UNLESS they have an
   *  incomplete descendant. Applied uniformly to every visible item
   *  (every node in the displayed list, not just the top level) — so a
   *  completed leaf is always hidden, and a completed parent stays
   *  visible only if there's still work somewhere in its subtree.
   *  Default false. */
  hideCompletedNotes: Record<string, boolean>;
  /** 0.79.8: per-folder "hide notes without attachments" filter — show
   *  only notes that have an attachment (a parent stays visible while any
   *  descendant has one). Keyed by folder path. Default false. */
  attachmentsOnlyNotes: Record<string, boolean>;
  /** Notification categories the user has silenced. Empty by default —
   *  every toast renders. Set per-category by the settings UI (commit
   *  0.55.5 wires this up). Stored as a string array on disk so future
   *  categories load gracefully. */
  mutedNotificationCategories: string[];
  /** 0.72.6: navigate INTO the destination parent automatically after
   *  moving a note via the in-parent picker (drag-onto-sibling). When
   *  off (default), the picker just reparents in place and selects the
   *  new parent; on, the view also drills into that parent so the user
   *  lands inside it. */
  autoNavOnMoveIn: boolean;
  /** 0.73.14: when on, the row under the keyboard cursor temporarily
   *  un-clamps its body — showing the full content as the user
   *  arrow-keys through the list. Moving the cursor away re-collapses
   *  the previous row. Doesn't touch the persistent expandedNotes
   *  Set (the "Show more" toggle); this is a transient view-only
   *  effect that vanishes the moment the cursor moves. Off by
   *  default. */
  autoExpandCursorRow: boolean;
  /** 0.74.1: auto-open the right-sidebar detail panel whenever a
   *  Stashpad view becomes active. Off by default — opt in via this
   *  toggle or the matching palette command. */
  autoOpenDetailPanel: boolean;
  /** 0.75.0: double-click (or double-tap on mobile) a note row to
   *  focus/open it — navigate into it, same as ArrowRight or the
   *  enter arrow. On by default. Single click still just selects. */
  doubleClickToFocus: boolean;
  /** 0.76.6: how dates (due dates, created/modified) display across
   *  the Tasks panel + detail panel. One of locale / iso / us / eu /
   *  long. Default "locale". */
  dateDisplayFormat: "locale" | "iso" | "us" | "eu" | "long";
  /** 0.76.6: IANA timezone name for date display (e.g.
   *  "America/New_York"). Empty = system timezone. */
  dateDisplayTimezone: string;
  /** 0.72.6: companion to autoNavOnMoveIn — when a note is moved OUT
   *  of the current parent (outdent / move-to-Home / cross-folder /
   *  via the cross-parent picker), drill into the new destination
   *  parent so the user follows the note. Off by default. */
  autoNavOnMoveOut: boolean;
  /** Notification history buffer cap. 0 or negative = unlimited.
   *  Default 5000. Persisted alongside the live history in
   *  `<pluginDir>/notifications.json`. */
  notificationHistoryLimit: number;
  /** 0.71.0 / 0.71.2: JD Index Builder. Two flavors:
   *    - "Preview" → writes a single Index.md inside the designated
   *      Stashpad folder, showing the would-be hierarchy + non-matches.
   *      Useful before committing to the heavier build.
   *    - "Build" → creates an actual Stashpad-note hierarchy in the
   *      designated folder, one note per prefix, child→parent
   *      relationships matching the dotted segments. */
  jdIndexScope: "vault" | "folder";
  jdIndexScopeFolder: string;
  /** Designated Stashpad folder for the index. Must be a known
   *  Stashpad folder (validated against discoverStashpadFolders).
   *  Renamed from jdIndexDestFolder in 0.71.2 for clarity. */
  jdIndexStashpadFolder: string;
  jdIndexFile: string;
  /** 0.71.2: by default, notes inside any known Stashpad folder are
   *  EXCLUDED from the scan (the destination shouldn't index itself,
   *  and other Stashpad folders are usually already organized). Toggle
   *  on to include them anyway. */
  jdIndexIncludeStashpadFolders: boolean;
  /** 0.71.2: sort mode for word-only / mixed indexes. "natural" =
   *  numbers first then alphabetical (default). "created" = sort by
   *  source file's creation time (handy when the prefix doesn't carry
   *  ordering, e.g. pure-word schemes). */
  jdIndexSort: "natural" | "created";
  /** 0.71.3: flag flips to true after the user's first successful
   *  Build. Used by the confirm modal to lead with "Try Preview first"
   *  before that — and to step back to the terser confirm once the
   *  user has built once and presumably knows what they're doing. */
  jdIndexHasBuilt: boolean;
  /** Per-folder composer draft text. Stored in the plugin's data.json. */
  drafts: Record<string, string>;
  /** Per-folder: the text most recently sent via Enter, used to suppress
   *  the "restore draft" suggestion if the saved draft happens to match. */
  lastSubmitted: Record<string, string>;
}

export const DEFAULT_SETTINGS: StashpadSettings = {
  folder: "Stashpad",
  importDropFolder: "",
  exportFolder: "_exports",
  autoImport: false,
  inheritObsidianExclusions: true,
  folderPanelPinnedFraction: 0.5,
  folderPanelPinned: [],
  folderPanelDownranked: [],
  folderPanelHidden: [],
  folderPanelPinnedGrouping: "pin-order",
  enablePerfProfiling: false,
  writeRecoveryLinks: true,
  useTemplatesFormat: false,
  prefixTimestampsOnCopy: true,
  splitOnLines: false,
  confirmCrossParentDrag: true,
  confirmBulkDelete: true,
  confirmAttachmentDelete: true,
  autofocusComposerAfterSend: true,
  popoutDuplicates: true,
  encryption: defaultEncryptionConfig(),
  encryptTrash: false,
  encryptTrashFilenames: false,
  encryptionIdleLockMinutes: 0,
  hideLockedTitles: false,
  archiveFolders: [],
  lockedSubtrees: [],
  searchOpensInNewTab: true,
  pinnedNotes: [],
  hideMobileToolbarInStashpad: true,
  slugStopWords: [],  // empty → DEFAULT_STOPWORDS used at runtime
  searchIncludedFolders: [],
  searchExcludedFolders: [],
  shortcuts: { move: "M", pickMove: "O", merge: "&", copy: "C", copyTree: "Y", openEditor: "E", openTab: "T", split: "S", copyOutline: "L" },
  mod: {
    toggleSplit: "Mod+/", pickDestination: "Mod+D", search: "Mod+F",
    delete: "Mod+Backspace", undo: "Mod+Z", redo: "Mod+Shift+Z",
    toggleComplete: "Mod+Enter",
    moveUp: "Mod+ArrowUp", moveDown: "Mod+ArrowDown",
    moveToTop: "Mod+Shift+ArrowUp", moveToBottom: "Mod+Shift+ArrowDown",
    outdent: "Mod+[",
    setColor: "Shift+:",
  },
  customPalette: [],
  colorAliases: {},
  noteTemplates: {},
  authorName: "",
  authorId: "",
  authorRole: "",
  authorDepartment: "",
  showAuthor: true,
  showContributors: true,
  showLastEdit: true,
  viewModes: {},
  includeAttachmentsInEverything: {},
  hideChildlessNotes: {},
  hideCompletedNotes: {},
  attachmentsOnlyNotes: {},
  mutedNotificationCategories: [],
  notificationHistoryLimit: 5000,
  autoNavOnMoveIn: false,
  autoNavOnMoveOut: false,
  autoExpandCursorRow: false,
  autoOpenDetailPanel: false,
  doubleClickToFocus: true,
  dateDisplayFormat: "locale",
  dateDisplayTimezone: "",
  jdIndexScope: "vault",
  jdIndexScopeFolder: "",
  jdIndexStashpadFolder: "",
  jdIndexFile: "Index",
  jdIndexIncludeStashpadFolders: false,
  jdIndexSort: "natural",
  jdIndexHasBuilt: false,
  drafts: {},
  lastSubmitted: {},
  bindings: buildDefaultBindings(),
};

let current: StashpadSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
const listeners = new Set<() => void>();

export function getSettings(): StashpadSettings { return current; }
export function setSettings(next: StashpadSettings): void {
  current = next;
  for (const fn of listeners) fn();
}
export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getTemplatesFormats(app: App): { dateFormat: string; timeFormat: string } | null {
  try {
    const tpl: any = (app as any).internalPlugins?.plugins?.templates;
    if (!tpl?.enabled) return null;
    const opts = tpl.instance?.options ?? {};
    return {
      dateFormat: opts.dateFormat || "YYYY-MM-DD",
      timeFormat: opts.timeFormat || "HH:mm",
    };
  } catch { return null; }
}

/** 0.73.1: settings tab redesigned into a tabbed UI. SETTINGS_TABS
 *  is the source of truth for both the bar at the top and the
 *  search-mode group order. Order here = display order. */
export type SettingsTabId = "general" | "encryption" | "diagnostics" | "authorship" | "templates" | "jdindex" | "hotkeys";
export const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "general",     label: "General" },
  { id: "encryption",  label: "Encryption" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "authorship",  label: "Authorship" },
  { id: "templates",   label: "Templates" },
  { id: "jdindex",     label: "JD Index" },
  { id: "hotkeys",     label: "Hotkeys" },
];

/** 0.94.0: a declarative sub-page that renders one of Stashpad's settings tabs
 *  via the existing imperative `renderTabContent`. Used by
 *  `getSettingDefinitions()` so the 1.13.0+ native-settings migration reuses all
 *  existing rendering.
 *
 *  0.96.3 — CRITICAL: `SettingPage` is a 1.13-only export. A top-level
 *  `class ... extends SettingPage` evaluates at MODULE LOAD, so on pre-1.13
 *  Obsidian (`SettingPage` === undefined) it threw `extends undefined` and the
 *  WHOLE PLUGIN failed to load. The subclass is now built LAZILY — only when the
 *  declarative `page:` callback fires, which only happens on 1.13+ (where
 *  `SettingPage` exists). On older Obsidian this factory is never called, so the
 *  module loads clean and the imperative `display()` fallback renders settings. */
let SubPageCtor: (new (title: string, renderFn: (el: HTMLElement) => void) => any) | null = null;
function makeStashpadSubPage(title: string, renderFn: (el: HTMLElement) => void): any {
  if (!SubPageCtor) {
    SubPageCtor = class extends (SettingPage as any) {
      _renderFn: (el: HTMLElement) => void;
      constructor(t: string, fn: (el: HTMLElement) => void) {
        super();
        (this as any).title = t;
        this._renderFn = fn;
      }
      display(): void {
        (this as any).containerEl.empty();
        this._renderFn((this as any).containerEl);
      }
    } as any;
  }
  return new (SubPageCtor as any)(title, renderFn);
}

export class StashpadSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: StashpadPlugin) { super(app, plugin); }

  /** 0.94.0: declarative settings (Obsidian 1.13.0+). The base
   *  `SettingTab.display()` renders from this and indexes it for Obsidian's
   *  NATIVE settings search — replacing the old custom tab-bar + in-plugin
   *  search box (both now redundant).
   *
   *  Phase 1: each former tab is a navigable `page` whose content is rendered
   *  by the existing `renderTabContent`, so behavior is unchanged and only the
   *  PAGE names are searchable. Phase 2 (follow-up versions) decomposes each
   *  page into `items` so individual settings become searchable too. */
  /** 0.96.2/0.96.3: backwards compatibility for pre-1.13 Obsidian. When the
   *  declarative settings API is present (gated on the `SettingPage` export
   *  existing — a precise capability check, not a version guess), let the base
   *  class render from getSettingDefinitions() and index it for native search by
   *  delegating to super.display(). On OLDER Obsidian there's no declarative API
   *  (and super.display() is a no-op), so render the SAME settings imperatively
   *  (one section per tab) — no native search there, which is fine. Without this
   *  the Stashpad settings tab renders BLANK on older Obsidian. */
  display(): void {
    if (SettingPage) { super.display(); return; }
    const { containerEl } = this;
    containerEl.empty();
    for (const t of SETTINGS_TABS) {
      containerEl.createEl("h2", { text: t.label });
      const items = this.itemsForTab(t.id);
      if (items) {
        for (const it of items as any[]) {
          const s = new Setting(containerEl);
          if (typeof it.render === "function") it.render(s);
          else {
            if (it.name) s.setName(it.name);
            if (it.desc) s.setDesc(it.desc);
          }
        }
      } else {
        this.renderTabContent(containerEl, t.id);
      }
    }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return SETTINGS_TABS.map((t) => {
      // Migrated tabs use declarative `items` (per-setting search). Unmigrated
      // tabs still render imperatively via a SettingPage (searchable by page
      // name only) — incremental Phase-2 migration, one tab per version.
      const items = this.itemsForTab(t.id);
      if (items) return { type: "page" as const, name: t.label, items };
      return {
        type: "page" as const,
        name: t.label,
        page: () => makeStashpadSubPage(t.label, (el) => this.renderTabContent(el, t.id)),
      };
    });
  }

  /** 0.94.1+: per-tab declarative item builders. Returns null for tabs not yet
   *  decomposed (those still render imperatively). */
  private itemsForTab(tab: SettingsTabId): SettingDefinitionItem[] | null {
    switch (tab) {
      case "hotkeys": return this.hotkeyItems();
      case "diagnostics": return this.diagnosticsItems();
      case "general": return this.generalItems();
      case "encryption": return this.encryptionItems();
      // authorship/templates/jdindex still render via the fresh-at-open `page:`
      // path (searchable by page name). They're per-folder editors that don't
      // decompose into clean per-setting entries; render-at-display via the page
      // renderer keeps them correct. Returning null falls back to that path.
      default: return null;
    }
  }

  /** Dispatch to the right render method for a tab still on the imperative
   *  `page:` path (authorship/templates/jdindex). general/diagnostics/hotkeys
   *  are declarative `items` and never routed here. */
  private renderTabContent(parent: HTMLElement, tab: SettingsTabId): void {
    switch (tab) {
      case "authorship":  this.renderAuthorshipSection(parent); break;
      case "templates":   this.renderTemplatesTab(parent); break;
      case "jdindex":     this.renderJdIndexSection(parent); break;
      // hotkeys migrated to declarative items (itemsForTab) — never routed here.
    }
  }

  // ---------- Tabs ----------

  /** Diagnostics tab: log + notification controls. Lifted verbatim
   *  from the pre-0.73.1 Log section. Inventory items A1–A4. */
  private diagnosticsItems(): SettingDefinitionItem[] {
    const muted = new Set<NotificationCategory>(
      (this.plugin.settings.mutedNotificationCategories ?? []) as NotificationCategory[],
    );
    const categories = Object.keys(CATEGORY_LABELS) as NotificationCategory[];
    return [
      this.renderDef("Write recovery navigation links", "Maintain the redundant parentLink/children frontmatter so you can walk the hierarchy from raw Markdown if the index ever breaks. On a slow / network drive this is a big per-move cost (several round-trips each); turn it off there for snappier moves — Rebootstrap rebuilds the fields on demand, and your notes' canonical structure (id/parent) is unaffected either way.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.writeRecoveryLinks).onChange(async (v) => {
          this.plugin.settings.writeRecoveryLinks = v; await this.plugin.saveSettings();
        })), ["recovery", "parentlink", "children", "frontmatter"]),

      this.renderDef("Performance profiling", "Record timing for list rendering, body reads, and file writes. Turn on, use Stashpad normally (especially the slow operations), then run “Dump performance profile” from the command palette and share the result. Off = zero overhead.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.enablePerfProfiling).onChange(async (v) => {
          this.plugin.settings.enablePerfProfiling = v; await this.plugin.saveSettings();
        })), ["perf", "profiling", "timing", "slow"]),

      this.renderDef("Open log file", "Append-only history of creates, deletes, parent changes, renames. Stored alongside the plugin's other private files.", (s) =>
        s.addButton((b) => b.setButtonText("Open log").onClick(async () => {
          const adapter = this.app.vault.adapter;
          const path = this.plugin.pluginPrivatePath("log.jsonl");
          if (!(await adapter.exists(path))) { new Notice("No log yet — make some changes first."); return; }
          const data = await adapter.read(path);
          new LogModal(this.app, data, path).open();
        })), ["log", "history", "diagnostics"]),

      this.renderDef("Notification history limit", "Maximum number of notifications kept in the persistent history. Set to 0 for unlimited (the file size grows with usage; expect a few hundred KB per ~5000 entries). Default: 5000.", (s) =>
        s.addText((t) => t
          .setValue(String(this.plugin.settings.notificationHistoryLimit ?? 5000))
          .setPlaceholder("5000")
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n)) return;
            this.plugin.settings.notificationHistoryLimit = n;
            this.plugin.notifications.setHistoryLimit(n);
            await this.plugin.saveSettings();
          })), ["notification", "history", "limit"]),

      {
        type: "group",
        heading: "Mute notification categories",
        items: categories.map((cat) => {
          const meta = CATEGORY_LABELS[cat];
          return this.renderDef(meta.label, meta.desc, (s) =>
            s.addToggle((t) => t.setValue(!muted.has(cat)).onChange(async (showOn) => {
              const muteOn = !showOn;
              if (muteOn) muted.add(cat); else muted.delete(cat);
              this.plugin.settings.mutedNotificationCategories = Array.from(muted);
              this.plugin.notifications.setMuted(cat, muteOn);
              await this.plugin.saveSettings();
            })), ["notification", "mute", "toast", "category"]);
        }),
      } as SettingDefinitionItem,

      this.renderDef("Notification history", "Browse the last 200 toasts. Filter by category. Live-updates as new notifications arrive. Muted categories still appear here so you can review what was suppressed.", (s) =>
        s.addButton((b) => b.setButtonText("View notification history").onClick(() => {
          new NotificationHistoryModal(
            this.app,
            this.plugin.notifications,
            async (folder) => {
              const adapter = this.app.vault.adapter;
              const path = this.plugin.pluginPrivatePath("log.jsonl");
              if (!(await adapter.exists(path))) { new Notice("No log yet — make some changes first."); return; }
              const data = await adapter.read(path);
              new LogModal(this.app, data, path).open();
              void folder;
            },
            this.plugin.settings.authorId || null,
            (id) => this.plugin.lookupNoteAuthorIds(id),
          ).open();
        })), ["notification", "history", "panel"]),
    ];
  }

  /** Templates tab: color aliases per Stashpad + note templates per
   *  Stashpad. Inventory items C15, C16. */
  private renderTemplatesTab(parent: HTMLElement): void {
    this.renderColorAliasesSection(parent);
    this.renderNoteTemplatesSection(parent);
  }

  /** 0.94.1: build a SettingDefinitionRender for a simple setting — the def's
   *  name/desc/aliases feed Obsidian's native settings search; `build` reuses
   *  the existing imperative row code on the Setting the API hands us. */
  private renderDef(
    name: string,
    desc: string,
    build: (s: Setting) => void,
    aliases?: string[],
  ): SettingDefinitionItem {
    return { name, desc, aliases, render: (s: Setting) => { s.setName(name).setDesc(desc); build(s); } } as SettingDefinitionItem;
  }

  /** 0.94.3: a declarative item whose render builds a whole MULTI-element
   *  section FRESH at display time (so folder-dependent content is never stale).
   *  Searchable by the section name/aliases. Strips the default row chrome and
   *  hands the section a plain host element to fill. */
  private sectionDef(
    name: string,
    desc: string,
    render: (host: HTMLElement) => void,
    aliases?: string[],
  ): SettingDefinitionItem {
    return {
      name, desc, aliases,
      render: (s: Setting) => {
        const host = s.settingEl;
        host.empty();
        host.removeClass("setting-item");
        host.addClass("stashpad-settings-section");
        render(host);
      },
    } as SettingDefinitionItem;
  }

  /** 0.94.3: General tab decomposed into per-setting items (render at DISPLAY
   *  time, so values + the folder list are always fresh). Simple settings use
   *  renderDef; the dynamic search-scope / create-Stashpad block is a
   *  sectionDef. Replaces the imperative renderGeneralTab for search. */
  private generalItems(): SettingDefinitionItem[] {
    const set = async () => this.plugin.saveSettings();
    const toggle = (
      name: string, desc: string, get: () => boolean, put: (v: boolean) => void, aliases?: string[],
    ): SettingDefinitionItem => this.renderDef(name, desc, (s) =>
      s.addToggle((t) => t.setValue(get()).onChange(async (v) => { put(v); await set(); })), aliases);

    const items: SettingDefinitionItem[] = [];

    items.push(this.renderDef("Stashpad notes folder", "Vault-relative folder where Stashpad stores its notes and attachments. Created on demand.", (s) => {
      s.addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setValue(this.plugin.settings.folder).setPlaceholder("Stashpad").onChange(async (v) => {
          const cleaned = (v || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.folder;
          const last = cleaned.split("/").filter(Boolean).pop() ?? "";
          const reserved = new Set([
            this.plugin.settings.importDropFolder,
            this.plugin.settings.exportFolder,
            "_attachments",
            "_processed",
          ].map((x) => (x ?? "").trim().replace(/^\/+|\/+$/g, "")).filter(Boolean));
          if (reserved.has(last)) {
            new Notice(`"${cleaned}" uses a reserved Stashpad subfolder name. Pick something else.`);
            return;
          }
          this.plugin.settings.folder = cleaned;
          await set();
        });
      });
    }, ["folder", "path", "location", "notes"]));

    items.push(toggle("Auto-import dropped files", "When on, any file you drop directly into a Stashpad folder is imported automatically: markdown becomes a note (the original is archived to .archive); other files move to _attachments with a note that links to them. Large drops ask for confirmation first.",
      () => this.plugin.settings.autoImport, (v) => { this.plugin.settings.autoImport = v; }, ["import", "drop", "auto"]));

    items.push(toggle("Inherit Obsidian's excluded files", "Also hide files matching Obsidian's “Excluded files” list (Settings → Files & Links) from Stashpad's link autocomplete and file surfaces — so you manage exclusions in one place. Plugin-internal formats like .edtz are always excluded regardless.",
      () => this.plugin.settings.inheritObsidianExclusions, (v) => { this.plugin.settings.inheritObsidianExclusions = v; }, ["excluded", "ignore", "files"]));

    items.push(this.renderDef("Dedicated import subfolder (optional)", "Optional. A subfolder (relative to each Stashpad folder) where dropped .stash files auto-import. Leave blank to just drop files into the Stashpad folder itself (recommended). Suggested name: _imports.", (s) =>
      s.addText((t) => t.setValue(this.plugin.settings.importDropFolder).setPlaceholder("_imports (leave blank to use the folder root)").onChange(async (v) => {
        this.plugin.settings.importDropFolder = (v || "").trim().replace(/^\/+|\/+$/g, "");
        await set();
      })), ["import", "subfolder"]));

    items.push(this.renderDef("Stash export subfolder", "Subfolder name (relative to each Stashpad folder) where exports land. Must differ from the import subfolder above.", (s) =>
      s.addText((t) => t.setValue(this.plugin.settings.exportFolder).setPlaceholder("_exports").onChange(async (v) => {
        this.plugin.settings.exportFolder = (v || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.exportFolder;
        await set();
      })), ["export", "stash", "subfolder"]));

    items.push(this.renderDef("Rebootstrap existing Stashpad folders", "Walk every folder that has a home note: ensure infrastructure (_imports, _exports, drafts file), backfill the redundant parentLink + children frontmatter fields, AND rename any note whose filename slug no longer matches its body's first line. Safe to run anytime; skip-if-equal means already-synced notes are no-op writes.", (s) =>
      s.addButton((b) =>
        b.setButtonText("Rebootstrap now").onClick(async () => {
          b.setDisabled(true).setButtonText("Working…");
          try {
            const { touched, fmChecked, fmWritten, slugsRenamed, authors, imported, attachmentsLinked } = await this.plugin.rebootstrapAllFolders();
            const parts: string[] = [];
            parts.push(`rebootstrapped ${touched.length} folder${touched.length === 1 ? "" : "s"}`);
            if (imported > 0) parts.push(`imported ${imported} loose file${imported === 1 ? "" : "s"}`);
            if (attachmentsLinked > 0) parts.push(`linked attachments on ${attachmentsLinked} note${attachmentsLinked === 1 ? "" : "s"}`);
            if (fmWritten > 0) parts.push(`updated frontmatter on ${fmWritten} of ${fmChecked} notes`);
            else if (fmChecked > 0) parts.push(`frontmatter already in sync (${fmChecked} notes checked)`);
            if (slugsRenamed > 0) parts.push(`renamed ${slugsRenamed} note${slugsRenamed === 1 ? "" : "s"} to match body`);
            if (authors > 0) parts.push(`rebuilt author registry (${authors} author${authors === 1 ? "" : "s"})`);
            new Notice(`Stashpad: ${parts.join("; ")}.`);
          } catch (e) {
            new Notice(`Stashpad: rebootstrap failed (${(e as Error).message})`);
          } finally {
            b.setDisabled(false).setButtonText("Rebootstrap now");
          }
        })), ["rebootstrap", "rebuild", "repair", "backfill", "slug"]));

    items.push(this.renderDef("Use Templates plugin date/time formats", "When on, timestamps use the formats configured in the core Templates plugin. Off: YYYY.MM.DD + HH:mm A.", (s) => {
      s.addToggle((t) => t.setValue(this.plugin.settings.useTemplatesFormat).onChange(async (v) => {
        this.plugin.settings.useTemplatesFormat = v; await set();
      }));
      const fmt = getTemplatesFormats(this.app);
      s.descEl.createDiv({ cls: "stashpad-settings-note" }).setText(fmt
        ? `Templates plugin: date = "${fmt.dateFormat}", time = "${fmt.timeFormat}"`
        : "Templates plugin not enabled.");
    }, ["templates", "date", "time", "format"]));

    // Date display block — dropdown + timezone share a live sample element.
    {
      let sampleEl: HTMLElement | null = null;
      const refreshSample = () => {
        if (!sampleEl) return;
        sampleEl.setText(`Sample: ${formatDateTime(Date.now(), this.plugin.settings)}`);
      };
      items.push(this.renderDef("Date display format", "How due dates and created/modified times are shown in the Tasks and detail panels.", (s) => {
        s.addDropdown((d) => {
          d.addOption("locale", "Locale, short (Mar 5, 9:00 AM)");
          d.addOption("long", "Locale, long (Thursday, March 5…)");
          d.addOption("iso", "ISO (2026-03-05 09:00)");
          d.addOption("us", "US (3/5/2026, 9:00 AM)");
          d.addOption("eu", "EU (5/3/2026, 09:00)");
          d.setValue(this.plugin.settings.dateDisplayFormat ?? "locale");
          d.onChange(async (v) => { this.plugin.settings.dateDisplayFormat = v as any; await set(); refreshSample(); });
        });
      }, ["date", "format", "display"]));
      items.push(this.renderDef("Display timezone", "IANA timezone name (e.g. America/New_York, Europe/London, Asia/Kolkata). Leave blank to use your system timezone.", (s) => {
        s.addText((t) => {
          t.setPlaceholder("(system timezone)");
          t.setValue(this.plugin.settings.dateDisplayTimezone ?? "");
          t.onChange(async (v) => { this.plugin.settings.dateDisplayTimezone = (v || "").trim(); await set(); refreshSample(); });
        });
      }, ["timezone", "tz", "date", "iana"]));
      items.push({
        name: "Date sample", searchable: false,
        render: (s: Setting) => {
          const host = s.settingEl; host.empty(); host.removeClass("setting-item");
          sampleEl = host.createDiv({ cls: "setting-item-description stashpad-settings-note" });
          refreshSample();
        },
      } as SettingDefinitionItem);
    }

    items.push(toggle("Navigate into parent after moving a note IN", "When you move a note onto another note via the in-list move picker (drag-onto-sibling), automatically drill into the new parent so you can see the moved note in its new home. Off = stay focused where you were.",
      () => this.plugin.settings.autoNavOnMoveIn, (v) => { this.plugin.settings.autoNavOnMoveIn = v; }, ["navigate", "move", "in"]));
    items.push(toggle("Navigate to destination after moving a note OUT", "When you outdent a note, move it via the cross-parent picker, or send it to Home, automatically drill into the destination parent. Off = stay focused where you were.",
      () => this.plugin.settings.autoNavOnMoveOut, (v) => { this.plugin.settings.autoNavOnMoveOut = v; }, ["navigate", "move", "out"]));
    items.push(toggle("Double-click a note to open it", "Double-click (or double-tap on mobile) a note in the list to focus/open it — the same as pressing → or clicking the enter arrow. Single click still just selects. On by default.",
      () => this.plugin.settings.doubleClickToFocus, (v) => { this.plugin.settings.doubleClickToFocus = v; }, ["double", "click", "open", "focus"]));
    items.push(toggle("Auto-open the detail panel", "Open the right-sidebar Stashpad detail panel automatically whenever a Stashpad view becomes active. The panel shows the cursored note's body, metadata, and children. Off = open manually via ribbon or command palette.",
      () => this.plugin.settings.autoOpenDetailPanel, (v) => { this.plugin.settings.autoOpenDetailPanel = v; }, ["detail", "panel", "sidebar"]));
    items.push(toggle("Expand the cursor row's body automatically", "As you arrow-key through the list, the row under the cursor temporarily un-clamps to show its full body. Moving away re-collapses it. Doesn't affect the persistent 'Show more' state — this is a transient view-only effect.",
      () => this.plugin.settings.autoExpandCursorRow, (v) => { this.plugin.settings.autoExpandCursorRow = v; }, ["expand", "cursor", "body"]));
    items.push(toggle("Confirm cross-parent drag-and-drop", "When dragging notes onto a note that has a different parent, ask before re-parenting (turn off to allow direct moves).",
      () => this.plugin.settings.confirmCrossParentDrag, (v) => { this.plugin.settings.confirmCrossParentDrag = v; }, ["confirm", "drag", "drop", "reparent"]));
    items.push(toggle("Confirm bulk deletes", "Warn before deletes that affect more than one note — multi-selection delete OR deleting a note that has descendants. A single childless note with no attachments never prompts. Off = those deletes apply immediately (undo still recovers everything).",
      () => this.plugin.settings.confirmBulkDelete, (v) => { this.plugin.settings.confirmBulkDelete = v; }, ["confirm", "delete", "bulk"]));
    items.push(toggle("Offer to delete attachments with note", "When a note references attachments, the delete modal includes an \"Also delete attachments\" checkbox so orphaned files don't pile up in your vault. Attachments are detected from both ![[…]] embeds in the body and the frontmatter attachments: list. Off = attachments are always preserved on delete (no checkbox shown), and a single childless note with attachments deletes silently.",
      () => this.plugin.settings.confirmAttachmentDelete, (v) => { this.plugin.settings.confirmAttachmentDelete = v; }, ["delete", "attachment", "orphan"]));

    items.push(this.renderDef("Slug stop-words", "Words removed from auto-generated note titles (filenames). One per line.", (s) => {
      let textarea: HTMLTextAreaElement | null = null;
      const initial = (this.plugin.settings.slugStopWords?.length ? this.plugin.settings.slugStopWords : DEFAULT_STOPWORDS).join("\n");
      s.addTextArea((t) => {
        t.setValue(initial);
        textarea = (t as any).inputEl as HTMLTextAreaElement;
        textarea.rows = 6;
        textarea.style.fontFamily = "var(--font-monospace)";
        t.onChange(async (v) => {
          this.plugin.settings.slugStopWords = (v || "").split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean);
          await set();
        });
      }).addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip("Reset to defaults").onClick(async () => {
          this.plugin.settings.slugStopWords = [...DEFAULT_STOPWORDS];
          if (textarea) textarea.value = DEFAULT_STOPWORDS.join("\n");
          await set();
        }));
    }, ["slug", "stopwords", "filename", "title"]));

    items.push(this.sectionDef("Cross-Stashpad search scope", "Toggle each Stashpad's pill to choose whether its notes contribute to cross-folder search. Excluded folders are still valid move destinations. Also: create a new Stashpad.", (host) => {
      const folders = this.plugin.discoverStashpadFolders();
      new Setting(host)
        .setName("Cross-Stashpad search scope")
        .setDesc("Toggle each Stashpad's pill to choose whether its notes contribute to cross-folder search. Excluded folders are still valid move destinations — their notes just don't appear in search results from elsewhere.");
      if (folders.length === 0) {
        host.createEl("p", { cls: "setting-item-description" }).setText(
          "No Stashpads found in this vault yet. A Stashpad is just a folder that contains a Stashpad-shaped note (frontmatter has both `id` and `parent`). Easiest way: open Stashpad (ribbon icon or command \"Reveal or open Stashpad\") — it auto-creates the default folder on first use. Or create one below.",
        );
      } else {
        const list = host.createDiv({ cls: "stashpad-folder-list" });
        for (const folder of folders) this.renderFolderScopeRow(list, folder);
      }
      let nameInput: HTMLInputElement | null = null;
      new Setting(host)
        .setName("Create a new Stashpad")
        .setDesc("Type a vault-relative folder path. The folder is created (with intermediates) and seeded with a Home note so Stashpad recognizes it.")
        .addText((t) => { t.setPlaceholder("my-stashpad"); nameInput = (t as any).inputEl as HTMLInputElement; })
        .addButton((b) =>
          b.setButtonText("Create").setCta().onClick(async () => {
            const raw = (nameInput?.value ?? "").trim().replace(/^\/+|\/+$/g, "");
            if (!raw) { new Notice("Enter a folder name first."); return; }
            try {
              await this.plugin.createNewStashpad(raw);
              new Notice(`Created Stashpad "${raw}".`);
              if (nameInput) nameInput.value = "";
              await this.plugin.waitForStashpadFolder(raw, 2000);
              this.update?.();
            } catch (e) {
              new Notice(`Couldn't create: ${(e as Error).message}`);
            }
          }));
    }, ["search", "scope", "exclude", "include", "create", "new", "stashpad", "folder"]));

    items.push(this.sectionDef("Folder panel placement", "Pin, downrank, or hide folders in the Stashpad folder panel. Restore hidden folders here or from the panel's “Hidden” section.", (host) => {
      new Setting(host)
        .setName("Folder panel placement")
        .setDesc("Folders you've pinned, downranked, or hidden in the Stashpad folder panel. Pin/downrank from a folder's right-click menu in the panel; restore here or from the panel's “Hidden” section.");
      this.renderFolderPlacementList(host);
    }, ["folder", "panel", "pin", "pinned", "downrank", "hide", "hidden", "restore", "placement"]));

    items.push(toggle("Autofocus composer after sending", "After Enter-submitting a note, return focus to the composer so you can keep typing. Off keeps focus in the list — useful if you want arrow keys to work without an extra click.",
      () => this.plugin.settings.autofocusComposerAfterSend, (v) => { this.plugin.settings.autofocusComposerAfterSend = v; }, ["composer", "focus", "send"]));
    items.push(toggle("Open in new window — duplicate tab", "ON: the new-window button (in the time-filter row) duplicates the current Stashpad tab — original stays open in the main window. OFF: the leaf is MOVED to the new window, closing the original tab.",
      () => this.plugin.settings.popoutDuplicates, (v) => { this.plugin.settings.popoutDuplicates = v; }, ["popout", "window", "duplicate"]));
    items.push(toggle("Search results open in a new tab", "When you pick a result in the Search modal, open it in a new Stashpad tab instead of navigating the current tab. Applies to same-folder and cross-Stashpad results alike. On by default.",
      () => this.plugin.settings.searchOpensInNewTab, (v) => { this.plugin.settings.searchOpensInNewTab = v; }, ["search", "new tab", "results", "open"]));
    items.push(toggle("Prefix timestamps when copying", "Include each note's timestamp before its body when copying with C or Y.",
      () => this.plugin.settings.prefixTimestampsOnCopy, (v) => { this.plugin.settings.prefixTimestampsOnCopy = v; }, ["copy", "timestamp", "prefix"]));

    return items;
  }

  /** 0.97.0: Encryption tab — Phase 1 KEY MANAGEMENT only (set / unlock /
   *  change / remove the vault password + the trash toggles). No file-encryption
   *  actions yet; those land in later phases. See docs/encryption-expansion-plan.md. */
  private encryptionItems(): SettingDefinitionItem[] {
    const enc = this.plugin.encryption;
    const items: SettingDefinitionItem[] = [];

    items.push(this.sectionDef("Vault encryption", "Set one password to encrypt content in this vault. Stored only on this device — there is no recovery if you lose it.", (host) => {
      host.addClass("stashpad-encryption-section");
      host.createEl("p", { cls: "setting-item-description" }).setText(
        "⚠️ One password protects everything you encrypt in this vault, and it's stored ONLY on this device — if you forget it, anything encrypted with it is gone for good. While encrypting, don't run a sync/cloud service over the vault and avoid working in Stashpad mid-operation — either can corrupt files. (File-encryption actions aren't enabled in this version yet — this screen sets up the key.)",
      );

      const kdfProbe = () => enc.argonProbe();

      if (!enc.isConfigured()) {
        new Setting(host).setName("Encryption").setDesc("Not set up yet.").addButton((b) =>
          b.setButtonText("Set up password…").setCta().onClick(() => {
            new EncryptionPasswordModal(this.app, {
              mode: "setup", offerKeychain: true, kdfProbe,
              onSubmit: async ({ next, remember }) => {
                if (!next) return "Enter a password.";
                try { await enc.setup(next, remember); } catch (e) { return (e as Error).message; }
                new Notice("Encryption set up — unlocked for this session.");
                this.update?.();
                return null;
              },
            }).open();
          }));
        return;
      }

      const kdfLabel = enc.kdf() === "argon2id" ? "Argon2id" : enc.kdf() === "pbkdf2" ? "PBKDF2 (fallback)" : "";
      const remembered = enc.isRemembered() ? " · remembered on this device" : "";
      new Setting(host).setName("Status").setDesc(
        `${enc.isUnlocked() ? "Set up · unlocked this session" : "Set up · locked"}${kdfLabel ? ` · ${kdfLabel}` : ""}${remembered}`,
      );

      if (!enc.isUnlocked()) {
        new Setting(host).setName("Unlock").setDesc("Enter your password to use encryption this session.").addButton((b) =>
          b.setButtonText("Unlock…").setCta().onClick(() => {
            new EncryptionPasswordModal(this.app, {
              mode: "unlock", offerKeychain: true,
              onSubmit: async ({ current, remember }) => {
                const ok = await enc.unlock(current!, remember);
                if (!ok) return "Wrong password. Try again.";
                new Notice("Encryption unlocked.");
                this.update?.();
                return null;
              },
            }).open();
          }));
      } else {
        new Setting(host).setName("Lock now").setDesc("Forget the password from memory until you re-enter it.").addButton((b) =>
          b.setButtonText("Lock now").onClick(() => { enc.lock(); new Notice("Encryption locked."); this.update?.(); }));
      }

      if (enc.keychainAvailable() && enc.isRemembered()) {
        new Setting(host).setName("Forget remembered password").setDesc("Remove the saved password from this device's keychain (you'll re-type it next session).").addButton((b) =>
          b.setButtonText("Forget").onClick(async () => { await enc.forgetKeychain(); new Notice("Removed from keychain."); this.update?.(); }));
      }

      new Setting(host).setName("Change password").setDesc("Re-wraps the same key under a new password — does not re-encrypt your files.").addButton((b) =>
        b.setButtonText("Change…").onClick(() => {
          new EncryptionPasswordModal(this.app, {
            mode: "change", offerKeychain: true, kdfProbe,
            onSubmit: async ({ current, next, remember }) => {
              const ok = await enc.changePassword(current!, next!, remember);
              if (!ok) return "Wrong current password. Try again.";
              new Notice("Password changed.");
              this.update?.();
              return null;
            },
          }).open();
        }));

      new Setting(host).setName("Remove encryption").setDesc("Erases the key from this vault. Refused while any locked notes exist — decrypt everything first (locked notes have NO plaintext copy; losing the key loses them forever).").addButton((b) => {
        b.setButtonText("Remove…").onClick(() => {
          // 0.98.23: HARD GUARD — locked blobs are the ONLY copy of their notes
          // (lock permanently deletes the plaintext). Erasing the key with blobs
          // still on disk = permanent data loss. Refuse until everything is
          // decrypted; offer the vault-wide unlock as the way out.
          const lockedBlobs = this.app.vault.getFiles().filter((f) => f.extension === "stashenc");
          if (lockedBlobs.length > 0) {
            new Notice(`Can't remove encryption: ${lockedBlobs.length} locked note${lockedBlobs.length === 1 ? " is" : "s are"} still encrypted and would be lost forever. Run "Decrypt (unlock) ALL locked notes in the vault" first.`, 10000);
            return;
          }
          new TypeToConfirmModal(this.app, {
            title: "Remove encryption?",
            body: "This erases the encryption key for this vault. Nothing is currently encrypted (locked notes are checked), so no content is lost — but you'll need to set a new password to encrypt later, and anything you had exported encrypted with this key stays locked to its passphrase.",
            phrase: "REMOVE ENCRYPTION",
            confirmText: "Remove encryption",
            requirePassword: (pw) => enc.verifyPassword(pw),
            onConfirm: async () => {
              // Re-check at confirm time — a lock could have happened while the
              // modal sat open (another device syncing, another window).
              if (this.app.vault.getFiles().some((f) => f.extension === "stashenc")) {
                new Notice("Locked notes appeared while this dialog was open — removal cancelled. Decrypt everything first.", 10000);
                return;
              }
              await enc.clear(); new Notice("Encryption removed."); this.update?.();
            },
          }).open();
        });
        (b as unknown as { setWarning?: (v: boolean) => void }).setWarning?.(true);
      });
    }, ["encryption", "encrypt", "password", "passphrase", "lock", "unlock", "key", "security", "private"]));

    items.push(this.renderDef("Encrypt items sent to trash", "When ON, deleted notes/folders are encrypted in the trash using your vault password. Default OFF. (Takes effect once the delete-encryption phase ships.)", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.encryptTrash).onChange(async (v) => {
        this.plugin.settings.encryptTrash = v; await this.plugin.saveSettings();
      })), ["trash", "delete", "encrypt"]));
    items.push(this.renderDef("Encrypt trash filenames", "Also encrypt the FILENAMES of trashed items. Default OFF so you can still tell what to restore when working outside the app.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.encryptTrashFilenames).onChange(async (v) => {
        this.plugin.settings.encryptTrashFilenames = v; await this.plugin.saveSettings();
      })), ["trash", "filename", "encrypt"]));
    items.push(this.renderDef("Follow Obsidian's trash setting instead", "OFF (recommended): encrypted-deleted notes go to Stashpad's own “_deleted/” store — the only trash location Stashpad fully controls, so it can encrypt, list, and restore them. ON: deletes follow Obsidian's “Deleted files” setting instead (system/OS trash or permanent). ⚠️ Stashpad CANNOT encrypt or recover notes that go to the system trash — so the encrypted trash + recoverable trash view won't apply. Only turn this on if you specifically want Obsidian's native trash behavior.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.encryptTrashFollowObsidian ?? false).onChange(async (v) => {
        this.plugin.settings.encryptTrashFollowObsidian = v || undefined; await this.plugin.saveSettings();
      })), ["trash", "obsidian", "system", "delete", "encrypt"]));
    items.push(this.renderDef("Auto-lock after idle minutes", "Forget the password from memory after this many idle minutes (0 = never). Re-prompts on the next encryption action.", (s) =>
      s.addText((t) => t.setValue(String(this.plugin.settings.encryptionIdleLockMinutes ?? 0)).onChange(async (v) => {
        const n = Math.max(0, Math.floor(Number(v) || 0));
        this.plugin.settings.encryptionIdleLockMinutes = n; await this.plugin.saveSettings();
      })), ["auto-lock", "idle", "timeout", "lock"]));
    items.push(this.renderDef("Hide titles of locked notes", "Show a generic label on 🔒 locked placeholders instead of the note's title, so a glance at the vault doesn't reveal what's locked. Default OFF.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.hideLockedTitles ?? false).onChange(async (v) => {
        this.plugin.settings.hideLockedTitles = v; await this.plugin.saveSettings();
        this.plugin.refreshAllStashpadViews?.();
      })), ["title", "hide", "private", "lock", "placeholder", "visibility"]));

    items.push(this.renderDef("Default archive folder", "Where the \"Move selection to archive\" command sends notes (they're auto-encrypted on arrival). Leaving this blank is fine — the command will just show you a list of your archive folders to pick from each time (or use the only one if you have a single archive). Mark a folder as an archive via the folder panel → right-click → \"Mark as archive\".", (s) => {
      const archives = this.plugin.settings.archiveFolders ?? [];
      s.addDropdown((d) => {
        d.addOption("", archives.length ? "— pick from list each time —" : "— no archive folders yet —");
        for (const f of archives) d.addOption(f, f);
        const cur = this.plugin.settings.defaultArchiveFolder ?? "";
        d.setValue(archives.includes(cur) ? cur : "");
        d.onChange(async (v) => { this.plugin.settings.defaultArchiveFolder = v || undefined; await this.plugin.saveSettings(); });
      });
    }, ["archive", "default", "move", "encrypt", "folder"]));

    return items;
  }

  /** 0.94.1: Hotkeys tab as declarative items — ONE searchable entry per
   *  command (so native settings search finds e.g. "toggle complete" or
   *  "command palette" by name). Each renders the existing binding row. */
  private hotkeyItems(): SettingDefinitionItem[] {
    const intro: SettingDefinitionItem = {
      name: "Hotkeys",
      desc: "Each command has up to two slots. Click a slot and press a key (or chord) to bind it; press Backspace (delete on Mac) to cancel without binding; or click ✕ to clear an existing binding. A ↺ icon appears on any slot that differs from its shipped default — click it to revert that slot. When both slots are set, the pill on the right decides which one is active.",
      searchable: false,
    } as SettingDefinitionItem;
    const rows = COMMAND_META.map((meta) => ({
      name: meta.label,
      desc: meta.desc,
      aliases: ["hotkey", "shortcut", "keybind", "binding", "key"],
      render: (s: Setting) => this.renderBindingRow(s, meta),
    } as SettingDefinitionItem));
    return [intro, ...rows];
  }

  /** 0.71.0: JD Index Builder settings section.
   *
   *  Generates a nested Index.md from notes whose basenames start with
   *  a dotted prefix — pure JD ("11.01 Driver's license") or any
   *  alphanumeric dotted scheme ("animal.duck.yellow Eggs"). Never
   *  modifies anything but the Index file; non-indexed notes are
   *  recorded inside the index itself so the user can see what didn't
   *  match. */
  private renderJdIndexSection(containerEl: HTMLElement): void {
    const header = containerEl.createEl("h3", { text: "JD Index Builder" });
    header.id = "stashpad-jd-index-section";
    const blurb = containerEl.createEl("p", { cls: "setting-item-description" });
    blurb.innerHTML =
      'Builds a Johnny-Decimal-style index inside a designated Stashpad folder. Two commands:' +
      '<br/><strong>Preview</strong> overwrites the designated folder&rsquo;s HOME note body with the would-be hierarchy + everything that didn&rsquo;t match. Frontmatter is preserved; everything below it is replaced.' +
      '<br/><strong>Build</strong> creates an actual hierarchy of Stashpad notes (one per prefix), with child→parent relationships matching the dotted segments.' +
      '<br/>Matches strict prefixes only: all-digits (<code>10 Life</code>) or alphanumeric-with-dots (<code>1.2 Family</code>, <code>animal.duck.yellow Eggs</code>). Mixed schemes sort numbers first, then alphabetically.';

    const stashpadFolders = this.plugin.discoverStashpadFolders();

    new Setting(containerEl)
      .setName("Scope")
      .setDesc("Scan the whole vault, or restrict to a single folder + its descendants.")
      .addDropdown((d) => {
        d.addOption("vault", "Entire vault");
        d.addOption("folder", "Single folder");
        d.setValue(this.plugin.settings.jdIndexScope ?? "vault");
        d.onChange(async (v) => {
          this.plugin.settings.jdIndexScope = (v === "folder" ? "folder" : "vault");
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if ((this.plugin.settings.jdIndexScope ?? "vault") === "folder") {
      new Setting(containerEl)
        .setName("Scope folder")
        .setDesc("Vault-relative path. Leave empty to fall back to the entire vault.")
        .addText((t) => {
          new FolderSuggest(this.app, t.inputEl);
          t.setPlaceholder("Path/To/Folder");
          t.setValue(this.plugin.settings.jdIndexScopeFolder ?? "");
          t.onChange(async (v) => {
            this.plugin.settings.jdIndexScopeFolder = (v || "").trim().replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Include Stashpad folders in scan")
      .setDesc("By default, notes inside any known Stashpad folder are excluded — the index destination shouldn't index itself, and other Stashpad folders are usually already organized. Toggle on if you want them included anyway.")
      .addToggle((t) => {
        t.setValue(this.plugin.settings.jdIndexIncludeStashpadFolders === true);
        t.onChange(async (v) => {
          this.plugin.settings.jdIndexIncludeStashpadFolders = v;
          await this.plugin.saveSettings();
          this.display(); // refresh preview counts
        });
      });

    new Setting(containerEl)
      .setName("Designated Stashpad folder for Index")
      .setDesc("Required. Must be a Stashpad folder. The index hierarchy is built here. New notes are created; nothing is deleted.")
      .addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder(stashpadFolders[0] ?? "(pick a Stashpad folder)");
        t.setValue(this.plugin.settings.jdIndexStashpadFolder ?? "");
        t.onChange(async (v) => {
          this.plugin.settings.jdIndexStashpadFolder = (v || "").trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Sort")
      .setDesc("Order of entries within the same depth. Natural: numbers first then alphabetical (recommended). Created: by source file's creation time — handy when prefixes are word-only and don't carry ordering.")
      .addDropdown((d) => {
        d.addOption("natural", "Natural (numeric → alphabetical)");
        d.addOption("created", "By creation time");
        d.setValue(this.plugin.settings.jdIndexSort ?? "natural");
        d.onChange(async (v) => {
          this.plugin.settings.jdIndexSort = (v === "created" ? "created" : "natural");
          await this.plugin.saveSettings();
        });
      });

    // Preview line: shows current counts before building.
    const scan = scanForJdNotes(this.app, this.plugin, this.plugin.settings);
    const previewEl = containerEl.createEl("p", { cls: "setting-item-description" });
    const skippedSuffix = scan.skippedStashpadNotes.length > 0
      ? ` (${scan.skippedStashpadNotes.length} Stashpad-folder note${scan.skippedStashpadNotes.length === 1 ? "" : "s"} excluded by default)`
      : "";
    previewEl.setText(
      `Preview: ${scan.indexed.length} note${scan.indexed.length === 1 ? "" : "s"} would be indexed, ` +
      `${scan.nonIndex.length} would NOT be indexed${skippedSuffix}.`,
    );

    new Setting(containerEl)
      .setName("Actions")
      .setDesc("Preview aggressively overwrites the designated folder's HOME note body (frontmatter preserved). Build creates Stashpad notes (existing notes with the same jdPrefix are updated, not duplicated).")
      .addButton((b) => {
        b.setButtonText("Preview");
        b.setTooltip("Overwrites the designated Stashpad folder's HOME note body with the preview.");
        b.onClick(async () => {
          try {
            const result = await buildJdIndexPreview(this.app, this.plugin, this.plugin.settings);
            if (result.error === "no-dest") {
              new Notice("Set a Designated Stashpad folder for Index first.", 5000);
              return;
            }
            if (result.error === "no-home") {
              new Notice(
                `"${this.plugin.settings.jdIndexStashpadFolder}" doesn't have a Stashpad home note. Open the folder in Stashpad first (it creates one automatically).`,
                7000,
              );
              return;
            }
            buildJdPreviewNotice(this.app, result);
            this.display();
          } catch (err) {
            console.error("[stashpad] preview failed", err);
            new Notice(`Preview failed: ${(err as Error)?.message ?? err}`, 8000);
          }
        });
      })
      .addButton((b) => {
        b.setButtonText("Build Stashpad notes");
        b.setCta();
        b.setTooltip("Create the Stashpad-note hierarchy. Existing notes with matching jdPrefix are updated.");
        b.onClick(() => {
          const dest = (this.plugin.settings.jdIndexStashpadFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
          if (!dest) {
            new Notice("Set a Designated Stashpad folder for Index first.", 5000);
            return;
          }
          // 0.71.3: confirm via the JdBuildConfirmModal so first-time
          // users get a "Preview first?" affordance (with a button that
          // runs preview inline) and large builds get a sterner warning.
          const modal = new JdBuildConfirmModal(
            this.app,
            this.plugin,
            this.plugin.settings,
            scan.indexed.length,
            async () => {
              try {
                const result = await buildJdIndexNotes(this.app, this.plugin, this.plugin.settings);
                if (result.error === "no-dest") {
                  new Notice("Set a Designated Stashpad folder for Index first.", 5000);
                  return;
                }
                if (result.error === "dest-not-stashpad") {
                  new Notice(
                    `"${result.destFolder}" isn't a known Stashpad folder. Pick a real Stashpad folder (or create one first).`,
                    7000,
                  );
                  return;
                }
                this.plugin.settings.jdIndexHasBuilt = true;
                await this.plugin.saveSettings();
                new Notice(
                  `Built: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped → ${result.destFolder}`,
                  6000,
                );
                this.display();
              } catch (err) {
                console.error("[stashpad] build failed", err);
                new Notice(`Build failed: ${(err as Error)?.message ?? err}`, 8000);
              }
            },
          );
          modal.open();
        });
      })
      .addButton((b) => {
        b.setButtonText(`Reveal in ${osFileManagerName()}`);
        b.setTooltip("Open the designated Stashpad folder in your OS file browser.");
        b.onClick(async () => {
          const dest = (this.plugin.settings.jdIndexStashpadFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
          if (!dest) { new Notice("Set a Designated Stashpad folder for Index first.", 5000); return; }
          const af = this.app.vault.getAbstractFileByPath(dest);
          if (!af) {
            new Notice(`Folder "${dest}" doesn't exist yet.`, 5000);
            return;
          }
          try {
            const basePath = (this.app.vault.adapter as any).basePath as string | undefined;
            if (basePath) {
              const { shell } = (window as any).require?.("electron") ?? {};
              const fullPath = `${basePath}/${dest}`;
              shell?.openPath?.(fullPath);
            } else {
              new Notice("Reveal in file system not supported on this platform.", 4000);
            }
          } catch (err) {
            new Notice(`Couldn't open folder: ${(err as Error)?.message ?? err}`, 5000);
          }
        });
      });
  }

  /** One Stashpad-folder row in the cross-Stashpad scope list. */
  /** Section: per-Stashpad color aliases.
   *    "Color Aliases per Stashpad" Setting w/ dropdown
   *    blurb paragraph
   *    list of [swatch | hex | alias text input] rows
   */
  private renderColorAliasesSection(parent: HTMLElement): void {
    const stashpads = this.plugin.discoverStashpadFolders();
    if (stashpads.length === 0) {
      new Setting(parent)
        .setName("Color Aliases per Stashpad")
        .setDesc("No Stashpads discovered yet — create one above first.");
      return;
    }

    // Default the picker to the active view's folder when there is one,
    // otherwise the first discovered folder.
    let chosen = (() => {
      const active = (getActiveView() as any)?.noteFolder as string | undefined;
      if (active && stashpads.includes(active)) return active;
      return stashpads[0];
    })();

    new Setting(parent)
      .setName("Color Aliases per Stashpad")
      .setDesc("Which Stashpad's colors to label.")
      .addDropdown((dd) => {
        for (const f of stashpads) dd.addOption(f, f);
        dd.setValue(chosen);
        dd.onChange((v) => { chosen = v; renderRows(); });
      });

    parent.createEl("p", {
      cls: "setting-item-description",
      text: "Give each per-note color a friendly name. Filters and pickers display the alias instead of the hex code; the underlying color stays the same. The same hex in two Stashpads can have different aliases.",
    });

    const list = parent.createDiv({ cls: "stashpad-color-aliases-list" });

    const renderRows = (): void => {
      list.empty();
      // Union of (colors currently in use) ∪ (hexes with stored aliases).
      // Used entries show their note count; aliased-only entries show
      // "unused". Sorted by used-count desc, then alphabetic.
      const used = this.plugin.collectColorsInFolder(chosen);
      const usedMap = new Map(used.map((c) => [c.hex, c.count]));
      const aliasMap = this.plugin.settings.colorAliases?.[chosen.replace(/\/+$/, "")] ?? {};
      const allHexes = new Set<string>([...usedMap.keys(), ...Object.keys(aliasMap)]);
      if (allHexes.size === 0) {
        list.createEl("p", {
          cls: "setting-item-description",
          text: `No colors used or aliased in "${chosen}" yet. Set a per-note color (Shift+: or right-click → Set color) and it'll appear here.`,
        });
        return;
      }
      const rows = [...allHexes].map((hex) => ({
        hex,
        count: usedMap.get(hex) ?? 0,
      }));
      rows.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
      for (const r of rows) this.renderColorAliasRow(list, chosen, r.hex, r.count, renderRows);
    };
    renderRows();
  }

  /** Section: per-Stashpad note template. Lets the user pick a markdown
   *  file whose frontmatter (and optional body) is layered onto every
   *  new note created in that Stashpad. Auto-managed fields
   *  (id/parent/created/attachments) always win, so the template should
   *  only carry the "extras" you want defaulted (color, tags, custom
   *  properties). The body, if present, is appended to the user-typed
   *  body — or substituted into a `{{body}}` token if you include one. */
  /** Section: multiplayer / authorship. Single text input for the
   *  display name + three footer-row toggles + a read-only author id
   *  (auto-assigned on first save so two coworkers named "Jane" get
   *  unique links). The id never changes once set, so already-stamped
   *  notes keep referring to the right person even if they rename
   *  themselves later. */
  private renderAuthorshipSection(parent: HTMLElement): void {
    parent.createEl("h3", { text: "Authorship" });
    parent.createEl("p", {
      cls: "setting-item-description",
      text: "Stamp each new note with your name. If the vault is later shared (e.g. a coworker opens it with --config pointing at their own settings folder), every modification automatically tracks contributors on top of the original author. Names link to per-user pages in <stashpad>/_authors/.",
    });

    new Setting(parent)
      .setName("Author name")
      .setDesc("Your display name. Used in the note footer + as the author/contributor link target. Leave blank to opt out (notes won't be stamped).")
      .addText((t) => {
        t.setValue(this.plugin.settings.authorName).onChange(async (v) => {
          this.plugin.settings.authorName = v.trim();
          // Generate an id on first non-empty save so future stampings
          // can disambiguate coworkers with the same name.
          if (this.plugin.settings.authorName && !this.plugin.settings.authorId) {
            this.plugin.settings.authorId = newId();
          }
          await this.plugin.saveSettings();
          // Forward sync: rename existing author stub files in every
          // Stashpad's _authors folder so they reflect the new name.
          // The reverse direction (vault rename → settings) is wired
          // in main.ts onload via vault rename events.
          await this.plugin.syncAuthorFilesToName();
        });
      });

    new Setting(parent)
      .setName("Author id (auto-assigned)")
      .setDesc("Stable id appended to your name on links so coworkers with the same name don't collide. Generated once and shouldn't change. If you really need to reset it, clear and retype your author name above.")
      .addText((t) => {
        t.setValue(this.plugin.settings.authorId).setDisabled(true);
      });

    new Setting(parent)
      .setName("Title / role")
      .setDesc("Optional. Shown on your author page (e.g. \"Engineer\", \"PM\", \"Designer\").")
      .addText((t) => {
        t.setValue(this.plugin.settings.authorRole).onChange(async (v) => {
          this.plugin.settings.authorRole = v.trim();
          await this.plugin.saveSettings();
          await this.plugin.syncAuthorFilesToName(); // also refreshes role/dept in stub frontmatter
        });
      });

    new Setting(parent)
      .setName("Department / team")
      .setDesc("Optional. Shown on your author page (e.g. \"Engineering\", \"Growth\").")
      .addText((t) => {
        t.setValue(this.plugin.settings.authorDepartment).onChange(async (v) => {
          this.plugin.settings.authorDepartment = v.trim();
          await this.plugin.saveSettings();
          await this.plugin.syncAuthorFilesToName();
        });
      });

    new Setting(parent)
      .setName("Show author in note footer")
      .addToggle((t) => t.setValue(this.plugin.settings.showAuthor).onChange(async (v) => {
        this.plugin.settings.showAuthor = v; await this.plugin.saveSettings();
      }));
    new Setting(parent)
      .setName("Show contributors in note footer")
      .addToggle((t) => t.setValue(this.plugin.settings.showContributors).onChange(async (v) => {
        this.plugin.settings.showContributors = v; await this.plugin.saveSettings();
      }));
    new Setting(parent)
      .setName("Show last edit time in note footer")
      .addToggle((t) => t.setValue(this.plugin.settings.showLastEdit).onChange(async (v) => {
        this.plugin.settings.showLastEdit = v; await this.plugin.saveSettings();
      }));

    // Folders this user has authored or contributed to. Computed by
    // walking frontmatter — re-runs on every settings tab open so the
    // counts stay current. Each row opens that folder in a fresh
    // Stashpad tab via the per-leaf folderOverride mechanism.
    const folders = this.plugin.collectAuthoredFolders();
    if (folders.length > 0) {
      parent.createEl("h4", { text: "Folders you've worked in" });
      const list = parent.createDiv({ cls: "stashpad-authored-folders-list" });
      for (const f of folders) {
        const row = list.createDiv({ cls: "stashpad-authored-folder-row" });
        const a = row.createEl("a", { cls: "stashpad-authored-folder-link", text: f.folder });
        a.onclick = (e) => { e.preventDefault(); void this.plugin.activateViewForFolder(f.folder); };
        const counts: string[] = [];
        if (f.authored > 0) counts.push(`authored ${f.authored}`);
        if (f.contributed > 0) counts.push(`contributed to ${f.contributed}`);
        row.createSpan({ cls: "stashpad-authored-folder-counts", text: ` · ${counts.join(", ")}` });
      }
    }

    this.renderKnownAuthorsSection(parent);
  }

  /** 0.77.5: surface the author registry — a rebuildable cache + rename
   *  history of every author the plugin has seen. Lists known authors
   *  with role/department + rename history, plus rebuild/restore actions.
   *  The registry is NOT authoritative (the id baked into note frontmatter
   *  is); this is recovery + an audit trail. */
  private renderKnownAuthorsSection(parent: HTMLElement): void {
    parent.createEl("h4", { text: "Known authors (registry)" });
    parent.createEl("div", {
      cls: "setting-item-description",
      text: "A rebuildable cache of every author Stashpad has seen, with rename history. Not a source of truth — the author id stored in each note is authoritative. Use it to recover deleted author pages or audit name changes.",
    });

    new Setting(parent)
      .setName("Registry maintenance")
      .setDesc("Rebuild scans the whole vault to reconstruct the list. Restore regenerates any deleted author pages across every Stashpad folder.")
      .addButton((b) => b.setButtonText("Rebuild").onClick(async () => {
        b.setDisabled(true).setButtonText("Rebuilding…");
        try {
          const r = await this.plugin.rebuildAuthorRegistry();
          new Notice(`Author registry rebuilt: ${r.total} author(s).`);
        } catch (e) { new Notice(`Rebuild failed: ${(e as Error).message}`); }
        b.setDisabled(false).setButtonText("Rebuild");
        this.display();
      }))
      .addButton((b) => b.setButtonText("Restore missing pages").onClick(async () => {
        b.setDisabled(true).setButtonText("Restoring…");
        try {
          const r = await this.plugin.restoreMissingAuthorStubs();
          new Notice(r.created > 0 ? `Restored ${r.created} author page(s).` : "No missing author pages.");
        } catch (e) { new Notice(`Restore failed: ${(e as Error).message}`); }
        b.setDisabled(false).setButtonText("Restore missing pages");
      }));

    const authors = this.plugin.authorRegistry.all();
    if (authors.length === 0) {
      parent.createEl("div", { cls: "setting-item-description", text: "No authors recorded yet. Rebuild to scan the vault." });
      return;
    }
    const list = parent.createDiv({ cls: "stashpad-known-authors-list" });
    for (const a of authors) {
      const row = list.createDiv({ cls: "stashpad-known-author-row" });
      const main = row.createDiv({ cls: "stashpad-known-author-main" });
      main.createSpan({ cls: "stashpad-known-author-name", text: a.name || "(unnamed)" });
      const meta: string[] = [];
      if (a.role) meta.push(a.role);
      if (a.department) meta.push(a.department);
      meta.push(`id ${a.id}`);
      main.createSpan({ cls: "stashpad-known-author-meta", text: ` · ${meta.join(" · ")}` });
      if (a.renames && a.renames.length > 0) {
        const hist = row.createDiv({ cls: "stashpad-known-author-history" });
        const trail = a.renames.map((r) => `${r.from} → ${r.to}`).join(", ");
        hist.setText(`Renamed: ${trail}`);
      }
    }
  }

  private renderNoteTemplatesSection(parent: HTMLElement): void {
    const stashpads = this.plugin.discoverStashpadFolders();
    if (stashpads.length === 0) return;

    new Setting(parent)
      .setName("Note templates per Stashpad")
      .setDesc("Pick a markdown file to use as the default template for new notes in each Stashpad. The template's frontmatter becomes the new note's frontmatter (id/parent/created/attachments are always set by Stashpad). If the body contains {{body}}, that's where the user-typed body goes; otherwise the user body is followed by the template body.");

    const list = parent.createDiv({ cls: "stashpad-note-templates-list" });

    const renderRow = (folder: string): void => {
      const key = folder.replace(/\/+$/, "");
      const row = list.createDiv({ cls: "stashpad-note-template-row" });
      const label = row.createSpan({ cls: "stashpad-note-template-folder" });
      label.setText(folder);

      const inputWrap = row.createDiv({ cls: "stashpad-note-template-input-wrap" });
      const input = inputWrap.createEl("input", {
        type: "text",
        cls: "stashpad-note-template-input",
        attr: { placeholder: "path/to/template.md (leave blank to disable)" },
      });
      input.value = (this.plugin.settings.noteTemplates ?? {})[key] ?? "";

      // Lightweight inline autocomplete: drop a popover beneath the input
      // listing matching markdown file paths. Uses Obsidian's vault
      // file list rather than AbstractInputSuggest so this works on every
      // Obsidian version that ships with the plugin.
      const sugg = inputWrap.createDiv({ cls: "stashpad-note-template-suggest" });
      sugg.style.display = "none";

      // Inline warning area — surfaces overlap with Stashpad's
      // auto-managed frontmatter so the user can fix the template before
      // it produces surprising notes.
      const warn = row.createDiv({ cls: "stashpad-note-template-warn" });
      warn.style.display = "none";

      const allMd = (): string[] =>
        this.app.vault.getMarkdownFiles()
          .map((f) => f.path)
          // Hide notes inside Stashpad-managed subfolders by default
          // (imports/exports/attachments) — those almost certainly aren't
          // templates.
          .filter((p) => !/\/(_imports|_exports|_attachments|\.stashpad)\//.test(p))
          .sort();

      const renderSuggestions = (): void => {
        sugg.empty();
        // 0.76.26: Sift — all-tokens, any-order match (see docs/sift.md).
        const tokens = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const sift = (p: string): boolean => {
          const h = p.toLowerCase();
          return tokens.every((t) => h.includes(t));
        };
        const matches = allMd()
          .filter((p) => sift(p))
          .slice(0, 12);
        if (matches.length === 0) { sugg.style.display = "none"; return; }
        sugg.style.display = "";
        for (const m of matches) {
          const item = sugg.createDiv({ cls: "stashpad-note-template-suggest-item", text: m });
          // mousedown (not click) so the input's blur doesn't close the
          // popover before the click registers.
          item.addEventListener("mousedown", async (ev) => {
            ev.preventDefault();
            input.value = m;
            await save();
            sugg.style.display = "none";
          });
        }
      };

      const save = async (): Promise<void> => {
        const v = input.value.trim();
        const map = { ...(this.plugin.settings.noteTemplates ?? {}) };
        if (v) map[key] = v;
        else delete map[key];
        this.plugin.settings.noteTemplates = map;
        await this.plugin.saveSettings();
        validateTemplate();
      };

      // Scan the template for frontmatter that Stashpad will overwrite.
      // The auto fields are always set by createNoteUnder; if the
      // template carries non-empty values for any of them the user will
      // probably be surprised when those values vanish from new notes.
      const validateTemplate = (): void => {
        warn.empty();
        warn.style.display = "none";
        const path = input.value.trim();
        if (!path) return;
        // Wrap in a microtask to give the metadataCache a beat to catch
        // up if the user just typed in a path.
        const tplFile = this.app.vault.getAbstractFileByPath(path);
        if (!tplFile || (tplFile as any).extension !== "md") {
          warn.style.display = "";
          warn.setText(`⚠ "${path}" is not a markdown file in this vault.`);
          return;
        }
        const fm = (this.app.metadataCache.getFileCache(tplFile as any)?.frontmatter ?? {}) as Record<string, any>;
        const RESERVED = RESERVED_FRONTMATTER;
        const conflicts = RESERVED.filter((k) => {
          const v = fm[k];
          if (v === undefined || v === null) return false;
          if (typeof v === "string" && v.trim() === "") return false;
          if (Array.isArray(v) && v.length === 0) return false;
          return true;
        });
        if (conflicts.length === 0) return;
        warn.style.display = "";
        warn.setText(
          `⚠ Template defines ${conflicts.join(", ")} — Stashpad always sets ${conflicts.length === 1 ? "this" : "these"} on new notes, so the template value${conflicts.length === 1 ? "" : "s"} will be ignored.`,
        );
      };

      input.addEventListener("focus", renderSuggestions);
      input.addEventListener("input", renderSuggestions);
      input.addEventListener("blur", () => { setTimeout(() => { sugg.style.display = "none"; }, 150); });
      input.addEventListener("change", () => { void save(); });
      // Initial validation on render so existing saved templates show
      // warnings without requiring a re-edit.
      validateTemplate();
    };

    for (const f of stashpads) renderRow(f);
  }

  /** One color → alias row. The swatch is clickable: opens the color
   *  picker so the user can bulk-recolor every note of THIS color in
   *  the chosen Stashpad to a new color (or remove the color). The
   *  "✕" deletes the alias; the input edits it. */
  private renderColorAliasRow(
    parent: HTMLElement,
    folder: string,
    hex: string,
    count: number,
    refresh: () => void,
  ): void {
    const row = parent.createDiv({ cls: "stashpad-color-alias-row" });
    if (count === 0) row.addClass("is-unused");

    const swatch = row.createSpan({ cls: "stashpad-color-alias-swatch" });
    swatch.style.background = hex;
    swatch.title = "Click to bulk-recolor every note of this color in this Stashpad";
    swatch.onclick = () => {
      const palette = this.plugin.settings.customPalette ?? [];
      new ColorPickerModal(
        this.app,
        hex,
        palette,
        async (newColor) => {
          // newColor === null means "remove color" (the slash tile).
          if ((newColor ?? null) === null && count === 0) {
            // Aliased-only with no notes to recolor — just drop the alias.
            await this.plugin.setColorAlias(folder, hex, "");
            refresh();
            return;
          }
          if (newColor && newColor.toLowerCase() === hex) { refresh(); return; }
          const touched = await this.plugin.recolorAllInFolder(folder, hex, newColor ?? null);
          if (touched > 0) {
            new Notice(`Recolored ${touched} note${touched === 1 ? "" : "s"}.`);
          } else if (count === 0) {
            // Just move the alias mapping without notes.
            const oldAlias = this.plugin.getColorAlias(folder, hex);
            if (oldAlias) {
              await this.plugin.setColorAlias(folder, hex, "");
              if (newColor) await this.plugin.setColorAlias(folder, newColor, oldAlias);
            }
          }
          refresh();
        },
        async (color) => {
          // Palette delete callback — same as ColorPickerModal usage in view.
          const list = (this.plugin.settings.customPalette ?? []).filter(
            (c) => c.toLowerCase() !== color.toLowerCase(),
          );
          this.plugin.settings.customPalette = list;
          await this.plugin.saveSettings();
          return list;
        },
      ).open();
    };

    const meta = row.createDiv({ cls: "stashpad-color-alias-meta" });
    meta.createSpan({ cls: "stashpad-color-alias-hex", text: hex });
    meta.createSpan({
      cls: "stashpad-color-alias-count",
      text: count === 0 ? "· unused" : `· ${count} note${count === 1 ? "" : "s"}`,
    });

    const input = row.createEl("input", {
      type: "text",
      cls: "stashpad-color-alias-input",
      attr: { placeholder: "Alias (optional)" },
    }) as HTMLInputElement;
    input.value = this.plugin.getColorAlias(folder, hex) ?? "";
    input.onchange = async () => {
      await this.plugin.setColorAlias(folder, hex, input.value);
      // No need to re-render unless the alias was JUST removed and the
      // row was unused — in that case it should disappear.
      if (!input.value.trim() && count === 0) refresh();
    };

    const del = row.createEl("button", {
      cls: "stashpad-color-alias-del",
      text: "×",
      attr: { title: "Delete alias" },
    });
    if (!input.value) del.style.visibility = "hidden";
    del.onclick = async () => {
      await this.plugin.setColorAlias(folder, hex, "");
      // If the row was unused AND we just removed its alias, the row
      // has no reason to exist anymore — refresh to drop it.
      if (count === 0) refresh();
      else { input.value = ""; del.style.visibility = "hidden"; }
    };
  }

  private renderFolderScopeRow(parent: HTMLElement, folder: string): void {
    const row = parent.createDiv({ cls: "stashpad-folder-row" });
    row.createSpan({ cls: "stashpad-folder-row-label", text: folder });

    const stateEl = row.createSpan({ cls: "stashpad-folder-row-state" });
    const pill = row.createDiv({ cls: "stashpad-binding-pill" });
    pill.setAttribute("role", "switch");
    pill.setAttribute("tabindex", "0");
    const knob = pill.createDiv({ cls: "stashpad-binding-pill-knob" });

    const isExcluded = (): boolean =>
      (this.plugin.settings.searchExcludedFolders ?? []).includes(folder);
    const refresh = (): void => {
      const excluded = isExcluded();
      pill.toggleClass("is-right", excluded);
      pill.setAttribute("aria-checked", String(excluded));
      knob.setText(excluded ? "X" : "✓");
      stateEl.setText(excluded ? "Excluded" : "Included");
      stateEl.toggleClass("is-excluded", excluded);
      pill.title = excluded
        ? "Excluded — notes here won't appear in cross-Stashpad search. Click to include."
        : "Included — notes here appear in cross-Stashpad search. Click to exclude.";
    };

    const flip = async () => {
      const list = new Set(this.plugin.settings.searchExcludedFolders ?? []);
      if (list.has(folder)) list.delete(folder);
      else list.add(folder);
      this.plugin.settings.searchExcludedFolders = [...list].sort();
      refresh();
      await this.plugin.saveSettings();
    };
    pill.onclick = () => void flip();
    pill.onkeydown = (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        void flip();
      }
    };
    refresh();
  }

  /** 0.95.2: settings-window mirror of the folder panel's pin/downrank/hide
   *  placements — lists each customized folder grouped by state with a control
   *  to restore it to normal. The panel's right-click menu is where you SET
   *  these; this is the at-a-glance overview + a second place to restore. */
  private renderFolderPlacementList(host: HTMLElement): void {
    const s = this.plugin.settings;
    const groups: Array<{ key: "folderPanelPinned" | "folderPanelDownranked" | "folderPanelHidden"; label: string; action: string }> = [
      { key: "folderPanelPinned", label: "Pinned", action: "Unpin" },
      { key: "folderPanelDownranked", label: "Downranked", action: "Reset" },
      { key: "folderPanelHidden", label: "Hidden", action: "Unhide" },
    ];
    const any = groups.some((g) => (s[g.key] ?? []).length > 0);
    if (!any) {
      host.createEl("p", { cls: "setting-item-description" }).setText(
        "No folders customized yet. Right-click a folder in the Stashpad folder panel to pin, downrank, or hide it.",
      );
      return;
    }
    const restore = async (folder: string) => {
      s.folderPanelPinned = (s.folderPanelPinned ?? []).filter((f) => f !== folder);
      s.folderPanelDownranked = (s.folderPanelDownranked ?? []).filter((f) => f !== folder);
      s.folderPanelHidden = (s.folderPanelHidden ?? []).filter((f) => f !== folder);
      await this.plugin.saveSettings();
      this.update?.();
    };
    for (const g of groups) {
      const folders = [...(s[g.key] ?? [])].sort();
      if (folders.length === 0) continue;
      host.createEl("div", { cls: "stashpad-folder-placement-group", text: `${g.label} (${folders.length})` });
      const list = host.createDiv({ cls: "stashpad-folder-list" });
      for (const folder of folders) {
        const row = list.createDiv({ cls: "stashpad-folder-row" });
        row.createSpan({ cls: "stashpad-folder-row-label", text: folder });
        const btn = row.createEl("button", { text: g.action });
        btn.onclick = () => void restore(folder);
      }
    }
  }

  /** One settings row: label + 2 chord recorders + active-slot toggle. */
  private renderBindingRow(row: Setting, meta: CommandMeta): void {
    row.setName(meta.label).setDesc(meta.desc);
    const get = () => this.plugin.settings.bindings[meta.id];

    let primaryInput: HTMLInputElement;
    let secondaryInput: HTMLInputElement;
    // Late-bound: assigned once the pill toggle is built below.
    let refreshToggle = (): void => {};

    const renderSlot = (which: "primary" | "secondary"): HTMLInputElement => {
      const wrap = row.controlEl.createDiv({ cls: "stashpad-binding-slot" });
      const input = wrap.createEl("input", { type: "text" }) as HTMLInputElement;
      input.readOnly = true;
      input.placeholder = "Click & press a key";
      input.value = prettifyChord(get()[which]);
      input.classList.add("stashpad-binding-input");
      // 0.59.3: belt-and-suspenders auto-resize fallback for the CSS
      // `field-sizing: content` — sync the `size` attribute to the
      // current value's length on every update so even older Electron
      // builds without field-sizing support still grow with content.
      const syncSize = () => { input.size = Math.max(3, input.value.length || input.placeholder.length); };
      syncSize();
      // This slot's default chord (primary → defaultPrimary; secondary →
      // defaultSecondary, which is "" for most commands).
      const slotDefault = which === "primary" ? meta.defaultPrimary : (meta.defaultSecondary ?? "");
      input.onclick = () => {
        startHotkeyRecording(input, async (chord) => {
          this.plugin.settings.bindings[meta.id][which] = chord;
          input.value = prettifyChord(chord);
          syncSize();
          await this.plugin.saveSettings();
          refreshToggle();
          syncRevert();
        });
      };
      const clearBtn = wrap.createEl("button", { cls: "stashpad-binding-clear", text: "×" });
      clearBtn.title = "Clear this slot";
      clearBtn.onclick = async () => {
        this.plugin.settings.bindings[meta.id][which] = "";
        input.value = "";
        syncSize();
        await this.plugin.saveSettings();
        refreshToggle();
        syncRevert();
      };
      // 0.92.0: revert-to-default icon. Shown whenever this slot differs from
      // its shipped default — most usefully after the ✕ clears a slot that HAD
      // a default (e.g. cleared "Mod+Enter"), so the user can put it back with
      // one click. Hidden when the slot already matches its default (nothing to
      // revert). A slot with no default ("") only shows it after the user binds
      // something, and reverting then clears the slot.
      const revertBtn = wrap.createEl("button", { cls: "stashpad-binding-revert" });
      setIcon(revertBtn, "rotate-ccw");
      const syncRevert = (): void => {
        const cur = get()[which];
        const differs = cur !== slotDefault;
        revertBtn.toggleClass("is-hidden", !differs);
        revertBtn.title = slotDefault
          ? `Revert to default (${prettifyChord(slotDefault)})`
          : "Revert to default (no binding)";
      };
      revertBtn.onclick = async () => {
        this.plugin.settings.bindings[meta.id][which] = slotDefault;
        input.value = prettifyChord(slotDefault);
        syncSize();
        await this.plugin.saveSettings();
        refreshToggle();
        syncRevert();
      };
      syncRevert();
      return input;
    };

    primaryInput = renderSlot("primary");
    secondaryInput = renderSlot("secondary");
    void primaryInput; void secondaryInput;

    // Active-slot pill toggle: a rounded track with a sliding knob whose
    // label is "L" when on the left (primary active) and "R" when on the
    // right (secondary active). Greyed out unless BOTH slots are bound.
    const pill = row.controlEl.createDiv({ cls: "stashpad-binding-pill" });
    pill.setAttribute("role", "switch");
    pill.setAttribute("tabindex", "0");
    const knob = pill.createDiv({ cls: "stashpad-binding-pill-knob" });

    // 0.59.1: "Use both" checkbox — when checked, both bindings fire and
    // the L/R pill becomes a no-op (visually greyed). Only meaningful
    // when both slots are filled.
    const bothWrap = row.controlEl.createDiv({ cls: "stashpad-binding-useboth" });
    const bothCb = bothWrap.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    bothCb.title = "Use both bindings simultaneously (overrides the L/R toggle)";
    bothWrap.createSpan({ text: "Use both" });
    bothCb.onchange = async () => {
      this.plugin.settings.bindings[meta.id].useBoth = bothCb.checked;
      await this.plugin.saveSettings();
      refreshToggle();
    };

    refreshToggle = (): void => {
      const b = get();
      const both = !!(b.primary && b.secondary);
      bothCb.checked = !!b.useBoth;
      bothCb.disabled = !both;
      bothWrap.toggleClass("is-disabled", !both);
      const useBoth = !!b.useBoth && both;
      // L/R pill: disabled when fewer than two slots OR when useBoth wins.
      pill.toggleClass("is-disabled", !both || useBoth);
      pill.toggleClass("is-right", b.preferRight);
      pill.setAttribute("aria-checked", String(b.preferRight));
      pill.setAttribute("aria-disabled", String(!both || useBoth));
      knob.setText(b.preferRight ? "R" : "L");
      pill.title = !both
        ? "Set both slots to enable the toggle"
        : useBoth
          ? "Overridden by \"Use both\""
          : (b.preferRight ? "Right slot active — click for left" : "Left slot active — click for right");
    };

    const flip = async () => {
      const b = get();
      if (!b.primary || !b.secondary) return;
      this.plugin.settings.bindings[meta.id].preferRight = !b.preferRight;
      refreshToggle();
      await this.plugin.saveSettings();
    };
    pill.onclick = () => void flip();
    pill.onkeydown = (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        void flip();
      }
    };

    refreshToggle();
  }
}
