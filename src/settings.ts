import { App, Notice, Platform, PluginSettingTab, Setting, SettingPage, setIcon, type SettingDefinitionItem } from "obsidian";

/** Platform-correct OS file-manager name for button/notice labels. */
function osFileManagerName(): string {
  return Platform.isMacOS ? "Finder" : Platform.isWin ? "File Explorer" : "file manager";
}
import { buildJdIndexPreview, buildJdIndexNotes, scanForJdNotes, JdBuildConfirmModal, buildJdPreviewNotice } from "./index-builder";
import { FolderSuggest } from "./folder-suggest";
import { IconSuggest } from "./icon-suggest";
import type StashpadPlugin from "./main";
import { RESERVED_FRONTMATTER, type ViewMode } from "./types";
import { type SplitMode } from "./view-helpers";
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
  | "clone" | "forkNote" | "insertTemplate"
  | "toggleExpand" | "expandAll" | "collapseAll"
  | "exportStash" | "importStash" | "pickFolder"
  | "cloneStashpadTab" | "selectAll" | "copyCodeBlock"
  | "swapWithParent"
  | "togglePin" | "listPin"
  | "toggleTask" | "setDue"
  | "jumpToTop" | "jumpToBottom"
  | "lockSelection" | "unlockAll" | "moveToArchive" | "encryptDelete"
  | "copyNotes" | "cutNotes" | "pasteNotes"
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
  { id: "forkNote",        label: "Fork into a separate note (under a chosen parent)", desc: "Duplicate the cursor row (with its subtree) as a separate note and pick which parent it nests under. Distinct from \"Fork as a version\" (a draft within a sheet group). No default chord.", defaultPrimary: "" },
  { id: "insertTemplate",  label: "Insert template (clone an existing note)", desc: "Pick any note in this Stashpad; clone it (with subtree + attachments) into the current view, retimestamped.", defaultPrimary: "" },
  { id: "toggleExpand",    label: "Show more / show less (expand toggle)", desc: "Default: Shift+? — toggle the clamp on the cursor row (or every selected row).", defaultPrimary: "Shift+?" },
  { id: "expandAll",       label: "Expand all (show every note's full body)", desc: "Un-clamp every note in the current list at once.", defaultPrimary: "" },
  { id: "collapseAll",     label: "Collapse all (clamp every note's body)", desc: "Re-clamp every note in the current list at once.", defaultPrimary: "" },
  { id: "exportStash",     label: "Export selection to .stash",    desc: "Export the selected subtree(s) as a .stash bundle (notes + attachments).",                defaultPrimary: "" },
  { id: "importStash",     label: "Import .stash file",            desc: "Open the .stash bundle picker and import its notes into this Stashpad.",                  defaultPrimary: "" },
  { id: "pickFolder",      label: "Open / switch / create Stashpad folder", desc: "Default: Mod+S — opens the unified folder picker (reveal, switch, create, convert).", defaultPrimary: "Mod+S" },
  { id: "cloneStashpadTab",label: "Clone (duplicate / copy) this Stashpad tab", desc: "Open a second tab on the same folder + focus, mirroring the \"copy\" button in the focused-header actions.", defaultPrimary: "" },
  { id: "selectAll",       label: "Select all notes in view",      desc: "Default: Mod+A — adds every visible row to the selection.",                              defaultPrimary: "Mod+A" },
  { id: "copyCodeBlock",   label: "Copy code from codeblock",      desc: "Default: { — copy the contents of the cursor row's first codeblock (or pick one when multiple exist).", defaultPrimary: "{" },
  { id: "swapWithParent",  label: "Swap with parent (ouroboros)",  desc: "Promote the cursor row above its current parent; the parent slides under it (carrying its other children). No default — bind in this tab.", defaultPrimary: "" },
  { id: "togglePin",       label: "Pin / unpin selected note",     desc: "Default: P — toggle the sidebar pin state of the cursor row (or focused note).", defaultPrimary: "P" },
  { id: "listPin",         label: "Pin / unpin to top of list",    desc: "Float the cursor row (or selection) to the TOP of its list — distinct from the sidebar pin. No default chord.", defaultPrimary: "" },
  { id: "toggleTask",      label: "Toggle task (todo)",            desc: "Default: G — mark the selection (or cursor row) as a task / todo, or clear it. Tasks appear in the Tasks panel.", defaultPrimary: "G" },
  { id: "setDue",          label: "Set due date…",                 desc: "Default: D — open a date+time picker to set (or clear) the due date on the selection. Setting a due date also marks the note as a task.", defaultPrimary: "D" },
  { id: "jumpToTop",       label: "Jump to top of list",           desc: "Default: Home — move the cursor to the first note in the current list.", defaultPrimary: "Home" },
  { id: "jumpToBottom",    label: "Jump to bottom of list",        desc: "Default: End — move the cursor to the last note in the current list.", defaultPrimary: "End" },
  { id: "commandPalette",  label: "Command palette (Stashpad only)", desc: "Default: Mod+K — open a command palette listing only Stashpad's commands, with Sift search.", defaultPrimary: "Mod+K" },
  { id: "lockSelection",   label: "Encrypt (lock) selection",      desc: "Encrypt the selected note(s) + their children into a locked .stashenc bundle in place (prompts to unlock first if needed). No default chord.", defaultPrimary: "" },
  { id: "unlockAll",       label: "Decrypt (unlock) locked notes in view", desc: "Decrypt every locked stash shown in the current view back into place, skipping any that can't be read. No default chord.", defaultPrimary: "" },
  { id: "moveToArchive",   label: "Move selection to archive (encrypt)", desc: "Move the selected note(s) to the default archive folder, encrypted on arrival. Undoable. No default chord.", defaultPrimary: "" },
  { id: "encryptDelete",   label: "Encrypt & delete selection",     desc: "Send the selected note(s) to the encrypted trash (recoverable with your password, Ctrl/Cmd+Z undoable). No default chord.", defaultPrimary: "" },
  { id: "copyNotes",       label: "Copy notes (note clipboard)",    desc: "Copy the selected note(s) as NOTES: paste in the list to duplicate them (new ids), or anywhere else to paste their text. Skipped when text is highlighted (normal copy wins).", defaultPrimary: "Mod+C" },
  { id: "cutNotes",        label: "Cut notes",                      desc: "Cut the selected note(s): paste in the list to MOVE them, or in the composer to extract their text and delete the originals (undoable).", defaultPrimary: "Mod+X" },
  { id: "pasteNotes",      label: "Paste notes",                    desc: "Paste previously copied/cut notes at the cursor row (after it, same parent). Does nothing if the note clipboard is empty.", defaultPrimary: "Mod+V" },
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

/** Per-folder overhaul: the manual shared-password model is how sharing works now,
 *  so the device-approval ("Model 3") collaborator UI is hidden by default. The
 *  service code (approveJoinRequest/removeMember/…) is kept DORMANT — flip this to
 *  true to bring the UI back. */
const SHOW_DEVICE_APPROVAL_UI = false;

/** Per-folder overhaul: the dedicated "Forget password on this device" buttons are
 *  discontinued (passwords are retained, never deleted — see the no-delete policy).
 *  The forgetKeychain service code stays for remove-encryption + possible reinstate;
 *  flip this to bring the buttons back. */
const SHOW_FORGET_KEYCHAIN_BUTTON = false;

/** Per-folder encryption/archive/trash preferences (per-folder overhaul, Phase A).
 *  Keyed by cleaned folder PATH in `StashpadSettings.folderEncPrefs`, matching the
 *  existing per-folder Record pattern (viewModes, colorAliases, …). The KEY MATERIAL
 *  lives in the synced keyfile (`FolderKeyEntry`); these are the user-facing TOGGLES
 *  that decide whether/what a folder encrypts. All optional → unset means "off"
 *  (plaintext), preserving current behavior for folders the user never touched.
 *
 *  The six "encrypt" flags are the 6-checkbox model: a content flag + a filename
 *  flag for each of folder / archive / trash. A filename flag is only meaningful
 *  when its content flag is on (the UI greys it out otherwise). */
export interface FolderEncPrefs {
  /** Folder is an archive (de-indexed from cross-folder search). Supersedes the
   *  legacy `archiveFolders[]` list over time; both honored during migration. */
  archive?: boolean;
  /** Per-folder trash destination: Stashpad's own `_deleted/` trash tab, or
   *  Obsidian's native `.trash`/system handling. Unset → global default. */
  trashHandling?: "stashpad" | "obsidian";
  encryptContent?: boolean;
  encryptFilenames?: boolean;
  archiveEncryptContent?: boolean;
  archiveEncryptFilenames?: boolean;
  trashEncryptContent?: boolean;
  trashEncryptFilenames?: boolean;
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
  /** 0.108.2: opt-in local debug tracing — records structured diagnostic
   *  lines (e.g. tap coordinates vs resolved row) to an in-memory ring buffer
   *  you can copy from the Diagnostics tab. Purely local, no network, no file
   *  writes; a no-op when off. Ships dormant — never needs stripping for the
   *  store / pristine. */
  debugTrace: boolean;
  /** 0.83.1: maintain the redundant `parentLink`/`children` recovery
   *  fields on every move. Default true. Turning it off skips those writes
   *  entirely — a big speedup on slow/network drives (each is a full
   *  round-trip and a move triggers several); Rebootstrap backfills them on
   *  demand, and the canonical id/parent is unaffected. */
  writeRecoveryLinks: boolean;
  useTemplatesFormat: boolean;
  prefixTimestampsOnCopy: boolean;
  splitOnLines: boolean;
  /** Delimiter used when split-on-submit is on (and the Split modal's default
   *  preset): each line, blank-line paragraphs, or Markdown headings. */
  splitMode: SplitMode;
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
  /** 0.132.0: focus the COMPOSER when a Stashpad note/view is opened or
   *  re-activated. Off (default) focuses the list instead, so you can keyboard-
   *  navigate immediately rather than the composer grabbing focus every time.
   *  Separate from autofocusComposerAfterSend (which is post-send only). */
  focusComposerOnOpen: boolean;
  /** 0.132.0: when a search result is picked, open the LIST that contains the
   *  note (focus its parent) and scroll/cursor to the note — so you land with it
   *  in context, not stuck in the focused-header/composer. On by default. */
  searchOpensInContext: boolean;
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
  /** 0.124.1: one-time migration marker — the default "Toggle task" hotkey
   *  changed from H to G. Existing installs persist the full bindings map, so
   *  the default change alone wouldn't reach them; on first load we flip a
   *  still-default `H` to `G` once, then set this so it never re-flips (the user
   *  can rebind to H afterwards and it sticks). */
  migratedToggleTaskG: boolean;
  /** 0.125.1: quick relative time-adjust presets shown in the due-date / snooze
   *  picker (e.g. ["5m","15m","1h","1d"]). A +/- flip toggles add vs subtract. */
  dueQuickAdjusts: string[];
  /** 0.98.25 (Phase 4): archive folders — notes MOVED into one of these Stashpad
   *  folders are automatically encrypted (locked). Opt-in per folder via the
   *  folder panel; requires an explicit confirm when marking (lock permanently
   *  deletes the plaintext). Never fires on create/edit — move-in only. */
  archiveFolders: string[];
  /** 0.98.28 (Phase 4): the default target for the "Move to archive" command.
   *  Optional — if blank, the command offers a pick-list of all archive folders
   *  (or uses the only one if there's exactly one). */
  defaultArchiveFolder?: string;
  /** Per-folder overhaul (Phase A): per-folder encryption/archive/trash toggles,
   *  keyed by cleaned folder path. See `FolderEncPrefs`. Empty default → no folder
   *  is encrypted until the user opts in, so existing vaults are unaffected. */
  folderEncPrefs: Record<string, FolderEncPrefs>;
  /** 0.118.0: per-folder tab/panel icon. Keyed by cleaned folder path → a Lucide
   *  icon id (e.g. "rocket", "star"). When set, the folder's Stashpad tab (and the
   *  folder panel + folder switcher) show this icon instead of the default
   *  "list-tree". Empty/absent → default icon. */
  folderIcons: Record<string, string>;
  /** 0.118.3: when true, the folder switcher / creator modal also lists pinned
   *  notes (jump straight to one). Off by default to keep the picker focused on
   *  folders. */
  folderSwitcherIncludePinned: boolean;
  /** Comma-separated subfolder-name prefixes (default "_") that EXCLUDE a folder from
   *  Stashpad discovery + import — it stays local, not surfaced/pulled in. A path is
   *  excluded if any of its segments starts with a listed prefix. */
  importExcludePrefixes: string;
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
  /** When on, note bodies render fully expanded by default; the
   *  per-note "Show more / show less" toggle and the expand/collapse-all
   *  commands then act as a *collapse* opt-out (the expandedNotes Set is
   *  interpreted as "differs from this default"). Off = current behavior
   *  (bodies clamp by default, expand is opt-in). */
  expandBodiesByDefault: boolean;
  /** 0.74.1: auto-open the right-sidebar detail panel whenever a
   *  Stashpad view becomes active. Off by default — opt in via this
   *  toggle or the matching palette command. */
  autoOpenDetailPanel: boolean;
  /** 0.75.0: double-click (or double-tap on mobile) a note row to
   *  focus/open it — navigate into it, same as ArrowRight or the
   *  enter arrow. On by default. Single click still just selects. */
  doubleClickToFocus: boolean;
  /** 0.107.0: enable "Sheet versions" — treat notes sharing a `sheet-group`
   *  frontmatter id as alternate versions of one item (only the active one
   *  shows as a row; siblings collapse into a tab bar). Off by default so the
   *  collapse filter never touches anyone who hasn't opted in. */
  enableSheetVersions: boolean;
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
  /** Keys (`<id>@<dueRaw>`) of task due-reminders already fired, so they don't
   *  re-fire on every launch. Bounded; pruned when it grows. */
  notifiedDueKeys: string[];
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
  /** OKF (Open Knowledge Format) support — master toggle. When on, folders using
   *  the OKF template get OKF frontmatter + a generated index.md (see
   *  docs/branches/okf.md). */
  okfEnabled: boolean;
  /** Vault path of the auto-created OKF template note (assigned per-folder via the
   *  Templates section). Empty until OKF is first enabled. */
  okfTemplatePath: string;
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
  debugTrace: false,
  writeRecoveryLinks: true,
  useTemplatesFormat: false,
  prefixTimestampsOnCopy: true,
  splitOnLines: false,
  splitMode: "lines",
  confirmCrossParentDrag: true,
  confirmBulkDelete: true,
  confirmAttachmentDelete: true,
  autofocusComposerAfterSend: true,
  focusComposerOnOpen: false,
  searchOpensInContext: true,
  popoutDuplicates: true,
  encryption: defaultEncryptionConfig(),
  encryptTrash: false,
  encryptTrashFilenames: false,
  encryptionIdleLockMinutes: 0,
  hideLockedTitles: false,
  migratedToggleTaskG: false,
  dueQuickAdjusts: ["5m", "15m", "30m", "1h", "1d", "1w"],
  archiveFolders: [],
  folderEncPrefs: {},
  folderIcons: {},
  folderSwitcherIncludePinned: false,
  importExcludePrefixes: "_",
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
  notifiedDueKeys: [],
  autoNavOnMoveIn: false,
  autoNavOnMoveOut: false,
  autoExpandCursorRow: false,
  expandBodiesByDefault: false,
  autoOpenDetailPanel: false,
  doubleClickToFocus: true,
  enableSheetVersions: false,
  dateDisplayFormat: "locale",
  dateDisplayTimezone: "",
  jdIndexScope: "vault",
  jdIndexScopeFolder: "",
  jdIndexStashpadFolder: "",
  jdIndexFile: "Index",
  jdIndexIncludeStashpadFolders: false,
  jdIndexSort: "natural",
  jdIndexHasBuilt: false,
  okfEnabled: false,
  okfTemplatePath: "",
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
export type SettingsTabId =
  | "foldersStorage" | "importExport" | "datesTime" | "behaviors"
  | "notifications" | "encryption" | "authorship" | "templates"
  | "organizationSystems" | "maintenance" | "diagnostics" | "hotkeys";
export const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = ([
  { id: "foldersStorage", label: "📁 Folders & Storage" },
  { id: "importExport",   label: "🔄 Import & Export" },
  { id: "datesTime",      label: "🕒 Dates & Time" },
  // 0.121.9: the six toggle-only sections (List & Display, Moving Notes,
  // Deleting, Composer & Copying, Windows & Tabs, Misc) are folded into one
  // "Behavior" tab as sub-headings (see itemsForTab).
  { id: "behaviors",      label: "🎛️ Behavior" },
  { id: "notifications",  label: "🔔 Notifications" },
  { id: "encryption",     label: "🔒 Encryption" },
  { id: "authorship",     label: "✒️ Authorship" },
  { id: "templates",      label: "📄 Templates" },
  // 0.121.9: JD Index + OKF folded into one "Organization Systems" tab.
  { id: "organizationSystems", label: "🗂️ Organization Systems" },
  { id: "maintenance",    label: "🛠️ Maintenance" },
  { id: "diagnostics",    label: "🩺 Diagnostics" },
  { id: "hotkeys",        label: "⌨️ Hotkeys" },
// 0.112.9: sections shown alphabetically by label. Display order only — the
// `id`-keyed itemsForTab dispatch is unaffected, and new tabs auto-sort in.
] as Array<{ id: SettingsTabId; label: string }>).sort((a, b) => {
  // Sort by the label TEXT, ignoring the leading emoji prefix (else the order would
  // scramble by emoji codepoint).
  const strip = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, "");
  return strip(a.label).localeCompare(strip(b.label));
});

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
    };
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
  /** 0.112.11: IMPERATIVE fallback ONLY. On 1.13+ Obsidian ignores display()
   *  whenever getSettingDefinitions() returns items — it renders declaratively
   *  via the base `update()` (a navigable page list + native search). So this
   *  runs only on pre-1.13 (no declarative API). It must NOT call super.display()
   *  — on 1.13 that renders nothing (the source of the earlier blank tab) and on
   *  pre-1.13 it's a no-op. Just render every tab's items inline.
   *
   *  CRITICAL: do NOT override `update()`. The base SettingTab.update() IS the
   *  1.13 declarative renderer + search indexer; overriding it (as 0.112.8 did,
   *  based on stale-Obsidian testing where update() didn't exist) blanks the tab
   *  and forces this imperative fallback. The `this.update?.()` refresh calls
   *  resolve to the base update() on 1.13 (re-render) and no-op on pre-1.13. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const t of SETTINGS_TABS) {
      new Setting(containerEl).setName(t.label).setHeading();
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
      case "notifications": return this.notificationsItems();
      // General split into focused categories (0.110.0) — each pulls its bucket.
      case "foldersStorage": return this.buildGeneralCategories().foldersStorage;
      case "importExport": return this.buildGeneralCategories().importExport;
      case "datesTime": return this.buildGeneralCategories().datesTime;
      case "maintenance": return this.buildGeneralCategories().maintenance;
      // 0.121.9: "Behavior" merges the six toggle-only sections, each kept as a
      // labelled sub-heading so the groupings still read clearly.
      case "behaviors": {
        const c = this.buildGeneralCategories();
        return [
          this.headingDef("📋 List & Display"), ...c.listDisplay,
          this.headingDef("↕️ Moving Notes"), ...c.movingNotes,
          this.headingDef("✍️ Composer & Copying"), ...c.composerCopy,
          this.headingDef("🗑️ Deleting"), ...c.deleting,
          this.headingDef("🪟 Windows & Tabs"), ...c.windowsTabs,
          this.headingDef("⚙️ Misc"), ...c.misc,
        ];
      }
      // 0.121.9: "Organization Systems" merges JD Index + OKF as sub-sections.
      case "organizationSystems": return [
        this.headingDef("🔢 JD Index (Johnny Decimal)"), ...this.jdIndexItems(),
        this.headingDef("📚 Open Knowledge Format (OKF)"), ...this.okfItems(),
      ];
      case "encryption": return this.encryptionItems();
      // 0.99.15: authorship/templates/jdindex decomposed too — static fields as
      // per-setting items, the per-folder editors as sectionDefs (rendered fresh
      // at display) — so individual settings are searchable, not just page names.
      case "authorship": return this.authorshipItems();
      case "templates": return this.templatesItems();
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
      // jdindex/okf now live under the "Organization Systems" tab (declarative
      // items via itemsForTab); hotkeys are declarative too — neither routed here.
    }
  }

  // ---------- Tabs ----------

  /** Diagnostics tab: log + notification controls. Lifted verbatim
   *  from the pre-0.73.1 Log section. Inventory items A1–A4. */
  private diagnosticsItems(): SettingDefinitionItem[] {
    return [
      this.renderDef("Performance profiling", "Record timing for list rendering, body reads, and file writes. Turn on, use Stashpad normally (especially the slow operations), then run “Dump performance profile” from the command palette and share the result. Off = zero overhead.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.enablePerfProfiling).onChange(async (v) => {
          this.plugin.settings.enablePerfProfiling = v; await this.plugin.saveSettings();
        })), ["perf", "profiling", "timing", "slow"]),

      this.renderDef("Debug trace", "Record low-level diagnostic lines (e.g. tap coordinates vs the row they resolve to) to an in-memory buffer while you reproduce a bug, then copy them below to share. Local only — no network, no file writes; zero overhead when off.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.debugTrace).onChange(async (v) => {
          this.plugin.settings.debugTrace = v; await this.plugin.saveSettings();
        })), ["debug", "trace", "diagnostics", "tap", "log"]),

      this.renderDef("Copy / clear debug trace", "Copy the captured debug lines to the clipboard (paste them back to share), or clear the buffer to start a fresh capture.", (s) => {
        s.addButton((b) => b.setButtonText("Copy").onClick(async () => {
          const text = this.plugin.getDebugTrace();
          if (!text) { new Notice("Debug trace is empty — enable it and reproduce the issue first."); return; }
          try { await navigator.clipboard.writeText(text); new Notice("Debug trace copied."); }
          catch { new Notice("Couldn't access clipboard."); }
        }));
        s.addButton((b) => b.setButtonText("Clear").onClick(() => {
          this.plugin.clearDebugTrace(); new Notice("Debug trace cleared.");
        }));
      }, ["debug", "trace", "copy", "clear"]),

      this.renderDef("Open log file", "Append-only history of creates, deletes, parent changes, renames. Stored alongside the plugin's other private files.", (s) =>
        s.addButton((b) => b.setButtonText("Open log").onClick(async () => {
          const adapter = this.app.vault.adapter;
          const path = this.plugin.pluginPrivatePath("log.jsonl");
          if (!(await adapter.exists(path))) { new Notice("No log yet — make some changes first."); return; }
          const data = await adapter.read(path);
          new LogModal(this.app, data, path).open();
        })), ["log", "history", "diagnostics"]),
    ];
  }

  /** 0.110.0: Notifications tab — split out of Diagnostics. Toast history
   *  limit, per-category mute toggles, and the history browser. */
  private notificationsItems(): SettingDefinitionItem[] {
    const muted = new Set<NotificationCategory>(
      (this.plugin.settings.mutedNotificationCategories ?? []) as NotificationCategory[],
    );
    const categories = Object.keys(CATEGORY_LABELS) as NotificationCategory[];
    return [
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
    // 0.112.5: try/catch so a single throwing control (e.g. a missing Obsidian
    // API on an older build) degrades to a labelled row instead of aborting the
    // ENTIRE declarative settings render and blanking every later section.
    return { name, desc, aliases, render: (s: Setting) => {
      s.setName(name).setDesc(desc);
      try { build(s); } catch (e) { console.error(`[Stashpad] settings control "${name}" failed to render:`, e); }
    } };
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
        try { render(host); } catch (e) { console.error(`[Stashpad] settings section "${name}" failed to render:`, e); }
      },
    };
  }

  /** A group HEADING + divider (like the "Sharing" header) as a standalone item, to
   *  visually divide a settings tab into sections. */
  private headingDef(name: string, desc?: string): SettingDefinitionItem {
    return this.sectionDef(name, desc ?? "", (host) => {
      const s = new Setting(host).setName(name).setHeading();
      if (desc) s.setDesc(desc);
    }, [name.toLowerCase()]);
  }

  // ---- Per-folder encryption (per-folder overhaul) ----
  /** "YYYY-MM-DD HH:mm – folder – author|authorId" key label (overhaul plan #3). */
  private folderKeyLabel(folder: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    // Compact stamp (no internal dashes) so the keychain id keeps more room for long
    // folder names: "20260620-1430" rather than "2026-06-20-14-30".
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    // Author INITIALS (not the full name) — the keyId suffix already disambiguates,
    // so initials keep the keychain id short for long folder names. "Sam Chen" → "SC";
    // no name → first 4 of the authorId.
    const name = (this.plugin.settings.authorName || "").trim();
    const who = name ? name.split(/\s+/).map((w) => w[0]).join("") : (this.plugin.settings.authorId || "anon").slice(0, 4);
    return `${stamp} - ${folder.split("/").pop() || folder} - ${who}`;
  }
  private promptSetFolderPassword(folder: string): void {
    new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: true, title: `Set password for “${folder.split("/").pop()}”`,
      intro: "A separate password just for this folder. Share it with collaborators out-of-band (a password manager, Signal, in person). There is NO recovery if it's lost.",
      onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; try { await this.plugin.encryption.setupFolderKey(folder, next, this.folderKeyLabel(folder), remember); } catch (e) { return (e as Error).message; } new Notice("Folder password set — share it securely."); this.update?.(); return null; } }).open();
  }
  private promptChangeFolderPassword(folder: string): void {
    new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: true, title: `Change password for “${folder.split("/").pop()}”`,
      intro: "Re-wraps this folder's key under a new password. The OLD password stops working on THIS device right away (un-synced copies elsewhere keep working until they sync). To truly cut off someone who left, you'll want “Rotate key” (re-encrypts everything) — coming soon.",
      onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; try { await this.plugin.encryption.changeFolderPassword(folder, next, remember); } catch (e) { return (e as Error).message; } new Notice("Folder password changed."); this.update?.(); return null; } }).open();
  }
  private promptRotateFolderKey(folder: string): void {
    const name = folder.split("/").pop() || folder;
    new ConfirmModal(this.app, `Rotate key for “${name}”?`,
      `This RE-ENCRYPTS every locked note in “${name}” under a brand-new key, then retires the old password so it can no longer decrypt them — even copies a collaborator synced earlier. Use this when someone should LOSE access (e.g. they left the org). Large folders can take a while. Everyone who should keep access will need the new password.`,
      "Rotate key",
      (ok) => {
        if (!ok) return;
        new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: true, title: `New password for “${name}”`, intro: "The new password to use after rotating. Share it only with people who should keep access.",
          onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; const n = await this.plugin.rotateFolderKey(folder, next, remember); if (n < 0) return "Rotation failed — see the notice."; this.update?.(); return null; } }).open();
      }).open();
  }
  private promptUnlockFolder(folder: string): void {
    new EncryptionPasswordModal(this.app, { mode: "unlock", offerKeychain: true, title: `Unlock “${folder.split("/").pop()}”`, intro: "Enter this folder's password.",
      onSubmit: async ({ current, remember }) => { const ok = await this.plugin.encryption.unlockFolder(folder, current!, remember); if (!ok) return "Wrong password. Try again."; new Notice("Folder unlocked."); this.update?.(); return null; } }).open();
  }

  /** Gate for settings that do nothing without vault encryption: returns true if
   *  it's set up; otherwise warns and opens the setup flow (onboarding), returning
   *  false so the caller can leave the toggle off until setup completes. */
  private encryptionOrOnboard(): boolean {
    if (this.plugin.encryption?.isConfigured?.()) return true;
    new Notice("That setting needs vault encryption, which isn't set up yet — let's set it up first.", 6000);
    new EncryptionPasswordModal(this.app, {
      mode: "setup", offerKeychain: true,
      title: "Set up encryption",
      intro: "One password protects what you encrypt in this vault. It's stored only on this device — there is NO recovery if you lose it.",
      onSubmit: async ({ next, remember }) => {
        if (!next) return "Enter a password.";
        try { await this.plugin.encryption.setup(next, remember, this.plugin.settings.authorName || "This device"); } catch (e) { return (e as Error).message; }
        new Notice("Encryption set up — now switch on the setting you wanted.");
        this.update?.();
        return null;
      },
    }).open();
    return false;
  }

  /** The folder selected in the per-folder dropdown — kept on the tab instance so it
   *  survives the declarative `update()` re-renders (no ghosting between folders). */
  private pfeSelected: string | null = null;
  /** 0.118.6: selected folder for the (searchable) per-folder icon control in
   *  Folders & Storage. */
  private iconPickFolder: string | null = null;

  private renderPerFolderEncryption(host: HTMLElement): void {
    const enc = this.plugin.encryption;
    if (!enc.isConfigured()) {
      host.createEl("p", { cls: "setting-item-description" }).setText("Set up vault encryption above first. Per-folder passwords layer on top: a folder with its own password uses a separate key; folders without one use the vault password.");
      return;
    }
    // Merged archive + trash caution (the same warnings the folder-panel modal shows
    // on the action) — surfaced here at the start of the folder section.
    host.createEl("p", { cls: "setting-item-description stashpad-enc-warning" }).setText("⚠️ Encryption has no recovery — if you lose a password, anything encrypted under it (notes, archived items, and encrypted-trash items) is gone for good. Locking / archiving / secure-deleting permanently removes the plaintext; the encrypted copy is the only one left. A plaintext archive only de-indexes notes from search — it does NOT encrypt them.");
    const folders = this.plugin.discoverStashpadFolders();
    if (folders.length === 0) { host.createEl("p", { cls: "setting-item-description" }).setText("No Stashpad folders found yet."); return; }
    // Keep a VALID selection across re-renders (default to the first folder).
    if (!this.pfeSelected || !folders.includes(this.pfeSelected)) this.pfeSelected = folders[0];

    // One dropdown to pick the folder; the panel below shows only that folder's
    // options — so the section stays compact regardless of folder count.
    new Setting(host).setName("Folder")
      .setDesc("Pick a folder to configure its password, archive, and trash options. Everything below applies to the selected folder only.")
      .addDropdown((d) => {
        for (const f of folders) d.addOption(f, f);
        d.setValue(this.pfeSelected!);
        d.onChange((v) => { this.pfeSelected = v; this.update?.(); });
      });

    const panel = host.createDiv({ cls: "stashpad-folderenc-panel" });
    this.renderFolderEncPanel(panel, this.pfeSelected);
  }

  /** Render the encryption/archive/trash controls for ONE folder. Built fresh on
   *  every selection change (closures capture the SELECTED folder only — no stale
   *  associations). */
  private renderFolderEncPanel(host: HTMLElement, folder: string): void {
    const enc = this.plugin.encryption;
    const hasOwn = enc.hasOwnFolderKey(folder);              // this exact folder has a key
    const owner = enc.folderKeyEntry(folder)?.folderPath ?? null; // key-owning folder (self or ancestor)
    const inherited = !!owner && !hasOwn;                    // subfolder inheriting an ancestor's key
    const unlocked = enc.isFolderUnlocked(folder);
    const prefs = (this.plugin.settings.folderEncPrefs ?? {})[folder] ?? {};
    const status = hasOwn
      ? (unlocked ? "Has its own password · unlocked" : "Has its own password · locked")
      : inherited
        ? `Inherits “${(owner!.split("/").pop()) || owner}”'s password · ${unlocked ? "unlocked" : "locked"}`
        : "Uses the vault password";

    const head = new Setting(host).setName("Password").setDesc(status);
    if (inherited) {
      head.addButton((b) => b.setButtonText("Manage on parent folder").onClick(() => { this.pfeSelected = owner; this.update?.(); }));
    } else if (!hasOwn) {
      head.addButton((b) => b.setButtonText("Set folder password…").setCta().onClick(() => this.promptSetFolderPassword(folder)));
    } else if (!unlocked) {
      head.addButton((b) => b.setButtonText("Unlock…").setCta().onClick(() => this.promptUnlockFolder(folder)));
    } else {
      // "Lock" = forget THIS folder's key from memory (re-prompts on next access) —
      // the per-folder analog of the vault "Lock now". It must NOT call
      // plugin.lockFolder (that's the batch ENCRYPT op). Encrypting/decrypting the
      // folder's content is the "Encrypt this folder's notes" toggle below.
      head.addButton((b) => b.setButtonText("Lock (forget password)").onClick(() => { this.plugin.encryption.lockFolder(folder); new Notice("Folder locked — you'll re-enter its password next time."); this.update?.(); }));
      head.addButton((b) => b.setButtonText("Change password…").onClick(() => this.promptChangeFolderPassword(folder)));
      head.addButton((b) => { b.setButtonText("Rotate key…").onClick(() => this.promptRotateFolderKey(folder)); b.buttonEl.addClass("mod-warning"); });
    }

    const setPref = async (patch: Partial<FolderEncPrefs>) => {
      this.plugin.settings.folderEncPrefs = { ...(this.plugin.settings.folderEncPrefs ?? {}), [folder]: { ...((this.plugin.settings.folderEncPrefs ?? {})[folder] ?? {}), ...patch } };
      await this.plugin.saveSettings();
    };

    new Setting(host).setName("Archive")
      .setDesc("De-indexes this folder from cross-folder search; notes moved in get auto-encrypted (when “Encrypt archived notes” is on below).")
      .addToggle((t) => t.setValue(!!prefs.archive).onChange(async (v) => {
        await setPref({ archive: v, ...(v && prefs.archiveEncryptContent === undefined ? { archiveEncryptContent: true } : {}) });
        const set = new Set((this.plugin.settings.archiveFolders ?? []).map((f) => f.replace(/\/+$/, "")));
        if (v) set.add(folder); else set.delete(folder);
        this.plugin.settings.archiveFolders = [...set];
        if (!v && (this.plugin.settings.defaultArchiveFolder ?? "") === folder) this.plugin.settings.defaultArchiveFolder = undefined;
        await this.plugin.saveSettings();
        this.plugin.refreshFolderPanels();
        this.update?.();
      }));
    // (The default archive target is chosen via the "Default archive folder" dropdown
    // in the global settings below — no per-folder toggle needed.)

    new Setting(host).setName("Trash handling").setDesc("Where notes deleted from this folder go.")
      .addDropdown((d) => d
        .addOption("", "Use global default")
        .addOption("stashpad", "Stashpad encrypted trash")
        .addOption("obsidian", "Obsidian native trash")
        .setValue(prefs.trashHandling ?? "")
        .onChange((v) => setPref({ trashHandling: (v || undefined) as FolderEncPrefs["trashHandling"] })));

    const pair = (label: string, cKey: keyof FolderEncPrefs, fKey: keyof FolderEncPrefs, onContent?: (v: boolean) => Promise<void>) => {
      new Setting(host).setName(label)
        .addToggle((t) => t.setValue(!!prefs[cKey]).onChange(async (v) => {
          const patch: Partial<FolderEncPrefs> = {}; (patch as Record<string, unknown>)[cKey] = v; if (!v) (patch as Record<string, unknown>)[fKey] = false;
          await setPref(patch);
          if (onContent) await onContent(v);
          this.update?.();
        }));
      new Setting(host).setName(`↳ ${label} — hide filenames`).setClass("stashpad-subsetting")
        .addToggle((t) => { t.setValue(!!prefs[fKey]); t.setDisabled(!prefs[cKey]); t.onChange((v) => { const p: Partial<FolderEncPrefs> = {}; (p as Record<string, unknown>)[fKey] = v; void setPref(p); }); });
    };
    pair("Encrypt this folder's notes", "encryptContent", "encryptFilenames", async (v) => {
      if (v) await this.plugin.lockFolder(folder); else await this.plugin.unlockFolder(folder);
      // Lock/unlock may be cancelled (password prompt dismissed) or partial — set the
      // pref to the folder's ACTUAL locked state so the toggle never claims a state
      // the folder isn't in.
      const has = (this.plugin.settings.lockedSubtrees ?? []).some((e) => (e.folder || "").replace(/\/+$/, "") === folder);
      await setPref({ encryptContent: has, ...(has ? {} : { encryptFilenames: false }) });
    });
    pair("Encrypt archived notes", "archiveEncryptContent", "archiveEncryptFilenames");
    pair("Encrypt trashed notes", "trashEncryptContent", "trashEncryptFilenames");

    // Subfolders: each shares this folder's key (inheritance), but you can encrypt
    // their notes / hide their filenames individually.
    const subs = this.plugin.discoverStashpadFolders().filter((sf) => sf !== folder && sf.startsWith(folder + "/")).sort();
    if (subs.length) {
      new Setting(host).setName("Subfolders").setDesc(`${subs.length} subfolder${subs.length === 1 ? "" : "s"} — they use “${folder.split("/").pop()}”'s password. Encrypt each individually.`).setHeading();
      for (const sub of subs) {
        const sp = (this.plugin.settings.folderEncPrefs ?? {})[sub] ?? {};
        const setSubPref = async (patch: Partial<FolderEncPrefs>) => {
          this.plugin.settings.folderEncPrefs = { ...(this.plugin.settings.folderEncPrefs ?? {}), [sub]: { ...((this.plugin.settings.folderEncPrefs ?? {})[sub] ?? {}), ...patch } };
          await this.plugin.saveSettings();
        };
        const subLocked = (this.plugin.settings.lockedSubtrees ?? []).some((e) => (e.folder || "").replace(/\/+$/, "") === sub);
        const rel = sub.slice(folder.length + 1);
        new Setting(host).setName(rel)
          .addToggle((t) => t.setValue(subLocked).onChange(async (v) => {
            if (v) await this.plugin.lockFolder(sub); else await this.plugin.unlockFolder(sub);
            const has = (this.plugin.settings.lockedSubtrees ?? []).some((e) => (e.folder || "").replace(/\/+$/, "") === sub);
            await setSubPref({ encryptContent: has, ...(has ? {} : { encryptFilenames: false }) });
            this.update?.();
          }));
        new Setting(host).setName(`↳ ${rel} — hide filenames`).setClass("stashpad-subsetting")
          .addToggle((t) => { t.setValue(!!sp.encryptFilenames); t.setDisabled(!subLocked); t.onChange((v) => void setSubPref({ encryptFilenames: v })); });
      }
    }
  }

  /** 0.94.3: General tab decomposed into per-setting items (render at DISPLAY
   *  time, so values + the folder list are always fresh). Simple settings use
   *  renderDef; the dynamic search-scope / create-Stashpad block is a
   *  sectionDef. Replaces the imperative renderGeneralTab for search. */
  /** 0.110.0: the old monolithic "General" tab decomposed into focused
   *  categories. Every setting's code is unchanged — each is just pushed into
   *  the bucket whose heading it's most relevant to. itemsForTab routes each
   *  bucket to its own settings page. Anything that doesn't fit a precise
   *  category goes to `misc`. */
  private buildGeneralCategories(): Record<
    "foldersStorage" | "importExport" | "datesTime" | "listDisplay"
    | "movingNotes" | "deleting" | "composerCopy" | "windowsTabs" | "maintenance" | "misc",
    SettingDefinitionItem[]
  > {
    const set = async () => this.plugin.saveSettings();
    const toggle = (
      name: string, desc: string, get: () => boolean, put: (v: boolean) => void, aliases?: string[],
    ): SettingDefinitionItem => this.renderDef(name, desc, (s) =>
      s.addToggle((t) => t.setValue(get()).onChange(async (v) => { put(v); await set(); })), aliases);

    const cats = {
      foldersStorage: [] as SettingDefinitionItem[],
      importExport: [] as SettingDefinitionItem[],
      datesTime: [] as SettingDefinitionItem[],
      listDisplay: [] as SettingDefinitionItem[],
      movingNotes: [] as SettingDefinitionItem[],
      deleting: [] as SettingDefinitionItem[],
      composerCopy: [] as SettingDefinitionItem[],
      windowsTabs: [] as SettingDefinitionItem[],
      maintenance: [] as SettingDefinitionItem[],
      misc: [] as SettingDefinitionItem[],
    };

    cats.foldersStorage.push(this.renderDef("Stashpad notes folder", "Vault-relative folder where Stashpad stores its notes and attachments. Created on demand.", (s) => {
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

    cats.importExport.push(toggle("Auto-import dropped files", "When on, any file you drop directly into a Stashpad folder is imported automatically: markdown becomes a note (the original is archived to .archive); other files move to _attachments with a note that links to them. Large drops ask for confirmation first.",
      () => this.plugin.settings.autoImport, (v) => { this.plugin.settings.autoImport = v; }, ["import", "drop", "auto"]));

    cats.foldersStorage.push(toggle("Inherit Obsidian's excluded files", "Also hide files matching Obsidian's “Excluded files” list (Settings → Files & Links) from Stashpad's link autocomplete and file surfaces — so you manage exclusions in one place. Plugin-internal formats like .edtz are always excluded regardless.",
      () => this.plugin.settings.inheritObsidianExclusions, (v) => { this.plugin.settings.inheritObsidianExclusions = v; }, ["excluded", "ignore", "files"]));

    cats.foldersStorage.push(toggle("Include pinned notes in the folder switcher", "When on, the folder switcher / creator (the folder button and the “Open or switch Stashpad folder” command) also lists your pinned notes, so you can jump straight to one. Off keeps the picker focused on folders.",
      () => this.plugin.settings.folderSwitcherIncludePinned, (v) => { this.plugin.settings.folderSwitcherIncludePinned = v; }, ["pinned", "switcher", "folder", "picker", "jump"]));

    // 0.118.6: per-folder tab icon — moved here from the Encryption tab's
    // per-folder panel so it's searchable. Pick a folder, then enter a Lucide
    // icon id; a live preview shows whether it's valid.
    cats.foldersStorage.push(this.renderDef("Folder tab icon", "Give a folder its own Lucide icon (e.g. rocket, star, book-open) shown on its tab, the folder switcher, and its folder-panel row. Pick a folder, then start typing in the icon box — matching icons appear with previews; pick one. Blank = the default icon. Set per folder.", (s) => {
      const folders = this.plugin.discoverStashpadFolders();
      if (folders.length === 0) { s.setDesc("No Stashpad folders found yet."); return; }
      if (!this.iconPickFolder || !folders.includes(this.iconPickFolder)) this.iconPickFolder = folders[0];
      let textComp: import("obsidian").TextComponent | null = null;
      const preview = s.controlEl.createSpan({ cls: "stashpad-folder-icon-preview" });
      const paint = (val: string): void => { preview.empty(); const v = val.trim(); if (v) setIcon(preview, v); };
      s.addDropdown((d) => {
        for (const f of folders) d.addOption(f, f.split("/").pop() || f);
        d.setValue(this.iconPickFolder!);
        d.onChange((v) => { this.iconPickFolder = v; const cur = this.plugin.getFolderIcon(v) ?? ""; textComp?.setValue(cur); paint(cur); });
      });
      s.addText((t) => {
        textComp = t;
        t.setPlaceholder("type to search… (e.g. rocket)");
        // 0.121.10: type-ahead icon search with previews — no need to know ids.
        new IconSuggest(this.app, t.inputEl);
        t.setValue(this.plugin.getFolderIcon(this.iconPickFolder!) ?? "");
        t.onChange(async (v) => { paint(v); await this.plugin.setFolderIcon(this.iconPickFolder!, v.trim()); });
      });
      paint(this.plugin.getFolderIcon(this.iconPickFolder) ?? "");
    }, ["icon", "folder", "tab", "lucide", "emoji", "switcher"]));

    cats.importExport.push(this.renderDef("Dedicated import subfolder (optional)", "Optional. A subfolder (relative to each Stashpad folder) where dropped .stash files auto-import. Leave blank to just drop files into the Stashpad folder itself (recommended). Suggested name: _imports.", (s) =>
      s.addText((t) => t.setValue(this.plugin.settings.importDropFolder).setPlaceholder("_imports (leave blank to use the folder root)").onChange(async (v) => {
        this.plugin.settings.importDropFolder = (v || "").trim().replace(/^\/+|\/+$/g, "");
        await set();
      })), ["import", "subfolder"]));

    cats.importExport.push(this.renderDef("Stash export subfolder", "Subfolder name (relative to each Stashpad folder) where exports land. Must differ from the import subfolder above.", (s) =>
      s.addText((t) => t.setValue(this.plugin.settings.exportFolder).setPlaceholder("_exports").onChange(async (v) => {
        this.plugin.settings.exportFolder = (v || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.exportFolder;
        await set();
      })), ["export", "stash", "subfolder"]));
    cats.importExport.push(this.renderDef("Exclude subfolders by prefix", "Comma-separated name prefixes (default “_”). A subfolder whose name starts with any of these — at any depth — is NOT surfaced as a Stashpad folder or imported (it stays local). To encrypt such a folder, right-click it in Obsidian's file explorer → “🔒 Encrypt with Stashpad”.", (s) =>
      s.addText((t) => t.setValue(this.plugin.settings.importExcludePrefixes ?? "_").setPlaceholder("_").onChange(async (v) => {
        this.plugin.settings.importExcludePrefixes = v; await set();
      })), ["import", "exclude", "prefix", "subfolder", "underscore", "ignore"]));

    cats.maintenance.push(this.renderDef("Rebootstrap existing Stashpad folders", "Walk every folder that has a home note: ensure infrastructure (_imports, _exports, drafts file), backfill the redundant parentLink + children frontmatter fields, rename any note whose filename slug no longer matches its body's first line, AND migrate legacy attachment filenames to the new name-first format (`photo-<id>.png`). Safe to run anytime; skip-if-equal means already-synced notes are no-op writes.", (s) =>
      s.addButton((b) =>
        b.setButtonText("Rebootstrap now").onClick(async () => {
          // 0.118.4: progress bar + persistent success live in the shared
          // runRebootstrapWithUI (so the command and this button match).
          b.setDisabled(true).setButtonText("Working…");
          try {
            await this.plugin.runRebootstrapWithUI();
          } catch { /* the helper already showed an error notice */ }
          finally {
            b.setDisabled(false).setButtonText("Rebootstrap now");
          }
        })), ["rebootstrap", "rebuild", "repair", "backfill", "slug"]));

    cats.maintenance.push(this.renderDef("Write recovery navigation links", "Maintain the redundant parentLink/children frontmatter so you can walk the hierarchy from raw Markdown if the index ever breaks. On a slow / network drive this is a big per-move cost (several round-trips each); turn it off there for snappier moves — Rebootstrap rebuilds the fields on demand, and your notes' canonical structure (id/parent) is unaffected either way.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.writeRecoveryLinks).onChange(async (v) => {
        this.plugin.settings.writeRecoveryLinks = v; await set();
      })), ["recovery", "parentlink", "children", "frontmatter"]));

    // Date display block — dropdown leads (it now drives EVERY timestamp surface:
    // notes list, Tasks, detail panel), then the Templates-format toggle, the
    // timezone, and a live sample. 0.121.7: reordered + copy updated.
    {
      let sampleEl: HTMLElement | null = null;
      const refreshSample = () => {
        if (!sampleEl) return;
        sampleEl.setText(`Sample: ${formatDateTime(Date.now(), this.plugin.settings)}`);
      };
      cats.datesTime.push(this.renderDef("Date display format", "How created / edited timestamps and due dates are shown — in the notes list, the Tasks panel, and the detail panel. Overridden by the Templates-plugin formats when the option below is on.", (s) => {
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
      cats.datesTime.push(this.renderDef("Use Templates plugin date/time formats", "Use the date/time formats configured in the core Templates plugin instead of the Date display format above. Off = the Date display format above is used everywhere.", (s) => {
        s.addToggle((t) => t.setValue(this.plugin.settings.useTemplatesFormat).onChange(async (v) => {
          this.plugin.settings.useTemplatesFormat = v; await set(); refreshSample();
        }));
        const fmt = getTemplatesFormats(this.app);
        s.descEl.createDiv({ cls: "stashpad-settings-note" }).setText(fmt
          ? `Templates plugin: date = "${fmt.dateFormat}", time = "${fmt.timeFormat}"`
          : "Templates plugin not enabled.");
      }, ["templates", "date", "time", "format"]));
      cats.datesTime.push(this.renderDef("Display timezone", "IANA timezone name (e.g. America/New_York, Europe/London, Asia/Kolkata). Leave blank to use your system timezone.", (s) => {
        s.addText((t) => {
          t.setPlaceholder("(system timezone)");
          t.setValue(this.plugin.settings.dateDisplayTimezone ?? "");
          t.onChange(async (v) => { this.plugin.settings.dateDisplayTimezone = (v || "").trim(); await set(); refreshSample(); });
        });
      }, ["timezone", "tz", "date", "iana"]));
      cats.datesTime.push(this.renderDef("Quick due-date adjustments", "Comma-separated relative amounts shown as quick +/- buttons in the due-date and snooze pickers (e.g. 5m, 15m, 1h, 1d, 1w). Units: m=minutes, h=hours, d=days, w=weeks. A +/- flip in the picker toggles add vs subtract. Leave blank to hide the row.", (s) => {
        s.addText((t) => {
          t.setPlaceholder("5m, 15m, 1h, 1d, 1w");
          t.setValue((this.plugin.settings.dueQuickAdjusts ?? []).join(", "));
          t.onChange(async (v) => {
            // Keep only well-formed tokens (N + m/h/d/w); normalise to lowercase,
            // no spaces. Invalid/in-progress tokens are dropped silently.
            const parts = v.split(",").map((x) => x.trim())
              .filter((x) => /^\d+\s*[mhdw]$/i.test(x))
              .map((x) => x.replace(/\s+/g, "").toLowerCase());
            this.plugin.settings.dueQuickAdjusts = parts;
            await set();
          });
        });
      }, ["quick", "adjust", "snooze", "due", "preset", "increment", "decrement"]));
      cats.datesTime.push({
        name: "Date sample", searchable: false,
        render: (s: Setting) => {
          // 0.121.5: mark the host as a settings-section so the sample picks up
          // the standard 14px inset (otherwise it sits flush against the edge).
          const host = s.settingEl; host.empty(); host.removeClass("setting-item"); host.addClass("stashpad-settings-section");
          sampleEl = host.createDiv({ cls: "setting-item-description stashpad-settings-note stashpad-date-sample" });
          refreshSample();
        },
      });
    }

    cats.movingNotes.push(toggle("Navigate into parent after moving a note IN", "When you move a note onto another note via the in-list move picker (drag-onto-sibling), automatically drill into the new parent so you can see the moved note in its new home. Off = stay focused where you were.",
      () => this.plugin.settings.autoNavOnMoveIn, (v) => { this.plugin.settings.autoNavOnMoveIn = v; }, ["navigate", "move", "in"]));
    cats.movingNotes.push(toggle("Navigate to destination after moving a note OUT", "When you outdent a note, move it via the cross-parent picker, or send it to Home, automatically drill into the destination parent. Off = stay focused where you were.",
      () => this.plugin.settings.autoNavOnMoveOut, (v) => { this.plugin.settings.autoNavOnMoveOut = v; }, ["navigate", "move", "out"]));
    cats.listDisplay.push(toggle("Double-click a note to open it", "Double-click (or double-tap on mobile) a note in the list to focus/open it — the same as pressing → or clicking the enter arrow. Single click still just selects. On by default.",
      () => this.plugin.settings.doubleClickToFocus, (v) => { this.plugin.settings.doubleClickToFocus = v; }, ["double", "click", "open", "focus"]));
    cats.misc.push(toggle("Sheet versions (alternate drafts)", "Treat notes that share a 'sheet-group' frontmatter id as alternate versions of one item: only the active version shows as a row, and its siblings collapse into a tab bar at the bottom of that row. Use \"Fork as version\" on a note to start. Off by default — when off, no note is ever hidden by this feature and the commands do nothing.",
      () => this.plugin.settings.enableSheetVersions, (v) => { this.plugin.settings.enableSheetVersions = v; }, ["sheet", "version", "draft", "alternate", "fork"]));
    cats.listDisplay.push(toggle("Auto-open the detail panel", "Open the right-sidebar Stashpad detail panel automatically whenever a Stashpad view becomes active. The panel shows the cursored note's body, metadata, and children. Off = open manually via ribbon or command palette.",
      () => this.plugin.settings.autoOpenDetailPanel, (v) => { this.plugin.settings.autoOpenDetailPanel = v; }, ["detail", "panel", "sidebar"]));
    cats.listDisplay.push(toggle("Expand the cursor row's body automatically", "As you arrow-key through the list, the row under the cursor temporarily un-clamps to show its full body. Moving away re-collapses it. Doesn't affect the persistent 'Show more' state — this is a transient view-only effect.",
      () => this.plugin.settings.autoExpandCursorRow, (v) => { this.plugin.settings.autoExpandCursorRow = v; }, ["expand", "cursor", "body"]));
    cats.listDisplay.push(toggle("Expand note bodies by default", "Show every note's full body by default instead of clamping long notes. The per-note 'Show more / show less' toggle and the Expand-all / Collapse-all commands then work in reverse — they let you collapse individual notes back down. Off = bodies clamp by default (expand is opt-in).",
      () => this.plugin.settings.expandBodiesByDefault, (v) => { this.plugin.settings.expandBodiesByDefault = v; }, ["expand", "collapse", "default", "body", "clamp"]));
    cats.movingNotes.push(toggle("Confirm cross-parent drag-and-drop", "When dragging notes onto a note that has a different parent, ask before re-parenting (turn off to allow direct moves).",
      () => this.plugin.settings.confirmCrossParentDrag, (v) => { this.plugin.settings.confirmCrossParentDrag = v; }, ["confirm", "drag", "drop", "reparent"]));
    cats.deleting.push(toggle("Confirm bulk deletes", "Warn before deletes that affect more than one note — multi-selection delete OR deleting a note that has descendants. A single childless note with no attachments never prompts. Off = those deletes apply immediately (undo still recovers everything).",
      () => this.plugin.settings.confirmBulkDelete, (v) => { this.plugin.settings.confirmBulkDelete = v; }, ["confirm", "delete", "bulk"]));
    cats.deleting.push(toggle("Offer to delete attachments with note", "When a note references attachments, the delete modal includes an \"Also delete attachments\" checkbox so orphaned files don't pile up in your vault. Attachments are detected from both ![[…]] embeds in the body and the frontmatter attachments: list. Off = attachments are always preserved on delete (no checkbox shown), and a single childless note with attachments deletes silently.",
      () => this.plugin.settings.confirmAttachmentDelete, (v) => { this.plugin.settings.confirmAttachmentDelete = v; }, ["delete", "attachment", "orphan"]));

    cats.foldersStorage.push(this.sectionDef("Cross-Stashpad Search Scope", "Toggle each Stashpad's pill to choose whether its notes contribute to cross-folder search. Excluded folders are still valid move destinations. Also: create a new Stashpad.", (host) => {
      const folders = this.plugin.discoverStashpadFolders();
      new Setting(host)
        .setName("Cross-Stashpad Search Scope")
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

    cats.foldersStorage.push(this.sectionDef("Folder Panel Placement", "Pin, downrank, or hide folders in the Stashpad folder panel. Restore hidden folders here or from the panel's “Hidden” section.", (host) => {
      new Setting(host)
        .setName("Folder Panel Placement")
        .setDesc("Folders you've pinned, downranked, or hidden in the Stashpad folder panel. Pin/downrank from a folder's right-click menu in the panel; restore here or from the panel's “Hidden” section.");
      this.renderFolderPlacementList(host);
    }, ["folder", "panel", "pin", "pinned", "downrank", "hide", "hidden", "restore", "placement"]));

    // 0.121.6: Note Titles folded into Folders & Storage as a trailing
    // sub-section (was its own tab). Keep the labelled "🏷️ Note Titles" header.
    cats.foldersStorage.push(this.headingDef("🏷️ Note Titles"));
    cats.foldersStorage.push(this.renderDef("Slug stop-words", "Words removed from auto-generated note titles (filenames). One per line.", (s) => {
      let textarea: HTMLTextAreaElement | null = null;
      const initial = (this.plugin.settings.slugStopWords?.length ? this.plugin.settings.slugStopWords : DEFAULT_STOPWORDS).join("\n");
      s.addTextArea((t) => {
        t.setValue(initial);
        textarea = (t as any).inputEl as HTMLTextAreaElement;
        textarea.rows = 6;
        textarea.setCssStyles({ fontFamily: "var(--font-monospace)" });
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
    }, ["slug", "stopwords", "filename", "title", "note titles"]));

    cats.composerCopy.push(toggle("Autofocus composer after sending", "After Enter-submitting a note, return focus to the composer so you can keep typing. Off keeps focus in the list — useful if you want arrow keys to work without an extra click.",
      () => this.plugin.settings.autofocusComposerAfterSend, (v) => { this.plugin.settings.autofocusComposerAfterSend = v; }, ["composer", "focus", "send"]));
    cats.composerCopy.push(toggle("Focus composer when opening a note", "Focus the composer when you open or switch into a Stashpad view. OFF (default) focuses the LIST instead, so arrow-key navigation works right away instead of the composer grabbing focus every time. (Separate from 'after sending' above.)",
      () => this.plugin.settings.focusComposerOnOpen, (v) => { this.plugin.settings.focusComposerOnOpen = v; }, ["composer", "focus", "open", "navigate", "list"]));
    cats.windowsTabs.push(toggle("Search opens the note in its list (in context)", "When you pick a search result, open the LIST that contains the note (focus its parent) and scroll to the note — so you see it in context instead of landing on the focused-note header. On by default.",
      () => this.plugin.settings.searchOpensInContext, (v) => { this.plugin.settings.searchOpensInContext = v; }, ["search", "context", "list", "scroll", "parent"]));
    cats.windowsTabs.push(toggle("Open in new window — duplicate tab", "ON: the new-window button (in the time-filter row) duplicates the current Stashpad tab — original stays open in the main window. OFF: the leaf is MOVED to the new window, closing the original tab.",
      () => this.plugin.settings.popoutDuplicates, (v) => { this.plugin.settings.popoutDuplicates = v; }, ["popout", "window", "duplicate"]));
    cats.windowsTabs.push(toggle("Search results open in a new tab", "When you pick a result in the Search modal, open it in a new Stashpad tab instead of navigating the current tab. Applies to same-folder and cross-Stashpad results alike. On by default.",
      () => this.plugin.settings.searchOpensInNewTab, (v) => { this.plugin.settings.searchOpensInNewTab = v; }, ["search", "new tab", "results", "open"]));
    cats.composerCopy.push(toggle("Prefix timestamps when copying", "Include each note's timestamp before its body when copying with C or Y.",
      () => this.plugin.settings.prefixTimestampsOnCopy, (v) => { this.plugin.settings.prefixTimestampsOnCopy = v; }, ["copy", "timestamp", "prefix"]));

    return cats;
  }

  /** 0.97.0: Encryption tab — Phase 1 KEY MANAGEMENT only (set / unlock /
   *  change / remove the vault password + the trash toggles). No file-encryption
   *  actions yet; those land in later phases. See docs/encryption-expansion-plan.md. */
  private encryptionItems(): SettingDefinitionItem[] {
    const enc = this.plugin.encryption;
    const items: SettingDefinitionItem[] = [];

    items.push(this.sectionDef("Vault Encryption", "Set one password to encrypt content in this vault. Stored only on this device — there is no recovery if you lose it.", (host) => {
      host.addClass("stashpad-encryption-section");
      const betaRow = host.createDiv({ cls: "stashpad-beta-row" });
      betaRow.createEl("span", { cls: "stashpad-beta-badge", text: "BETA" });
      betaRow.createEl("span", { cls: "stashpad-beta-note", text: "Encryption is in beta — keep your own backups of anything important." });
      host.createEl("div", { cls: "stashpad-ai-disclaimer" }).setText(
        "⚠️ AI-built, NOT human-audited. This encryption was written by an AI assistant — not designed, reviewed, or security-audited by a human, and not tested by any security professional. It may carry real security, privacy, and DATA-LOSS risks. Treat it as a best-effort nice-to-have that might buy a little time against a casual snoop — nothing is guaranteed. Do NOT rely on it for anything sensitive, and always keep your own unencrypted backups of anything important.",
      );
      host.createEl("p", { cls: "setting-item-description" }).setText(
        "⚠️ Encryption protects what you lock in this vault. Each device unlocks with its own password (which never leaves the device); the vault key is shared with collaborators by approving their device — no shared password. If everyone with access loses their password, anything encrypted is gone for good. While encrypting, avoid a sync/cloud service writing the vault mid-operation — it can corrupt files.",
      );

      const kdfProbe = () => enc.argonProbe();
      const deviceLabel = () => (this.plugin.settings.authorName?.trim() || "This device");
      // Pull the latest synced keyfile, then re-render once if our access state
      // changed (e.g. a collaborator approved this device since the page opened).
      const state0 = enc.accessState();
      void enc.refresh().then(() => { if (enc.accessState() !== state0) this.update?.(); });
      const state = state0;

      if (state === "none") {
        new Setting(host).setName("Encryption").setDesc("Not set up yet in this vault.").addButton((b) =>
          b.setButtonText("Set up password…").setCta().onClick(() => {
            new EncryptionPasswordModal(this.app, {
              mode: "setup", offerKeychain: true, kdfProbe,
              onSubmit: async ({ next, remember }) => {
                if (!next) return "Enter a password.";
                try { await enc.setup(next, remember, deviceLabel()); } catch (e) { return (e as Error).message; }
                new Notice("Encryption set up — unlocked for this session.");
                this.update?.();
                return null;
              },
            }).open();
          }));
        return;
      }

      // Outsider with NO way in yet (no shared password, not already unlocked):
      // offer both join methods — type the shared password if the vault has one,
      // or request device approval.
      if (state === "outsider" && !enc.isUnlocked()) {
        if (enc.hasSharedPassword()) {
          new Setting(host).setName("This vault is encrypted")
            .setDesc("Enter the shared password (ask whoever set it up — they'll send it via a password manager or secure message).")
            .addButton((b) => b.setButtonText("Unlock with shared password…").setCta().onClick(() => {
              new EncryptionPasswordModal(this.app, {
                mode: "unlock", offerKeychain: true,
                onSubmit: async ({ current, remember }) => {
                  const ok = await enc.unlock(current!, remember);
                  if (!ok) return "Wrong password (or the keyfile hasn't synced here yet).";
                  new Notice("Encryption unlocked."); this.update?.(); return null;
                },
              }).open();
            }));
        }
        new Setting(host).setName(enc.hasSharedPassword() ? "Or request device approval" : "This vault is encrypted by a collaborator")
          .setDesc("Request access — pick a password for THIS device, then ask an existing member to approve it. Once approved (and the keyfile syncs to you), you'll unlock with that password. No shared secret.")
          .addButton((b) => b.setButtonText("Request access…").onClick(() => {
            new EncryptionPasswordModal(this.app, {
              mode: "setup", offerKeychain: true, kdfProbe,
              onSubmit: async ({ next, remember }) => {
                if (!next) return "Choose a password for this device.";
                try { await enc.requestAccess(deviceLabel(), next, remember); } catch (e) { return (e as Error).message; }
                new Notice("Access requested. An existing member can now approve this device.");
                this.update?.();
                return null;
              },
            }).open();
          }));
        return;
      }

      if (state === "pending") {
        new Setting(host).setName("Access requested — waiting for approval")
          .setDesc("An existing member needs to approve this device. After they do and the keyfile syncs here, reopen this page to unlock with the password you chose.")
          .addButton((b) => b.setButtonText("Try unlock now").setCta().onClick(() => {
            new EncryptionPasswordModal(this.app, {
              mode: "unlock", offerKeychain: true,
              onSubmit: async ({ current, remember }) => {
                const ok = await enc.unlock(current!, remember);
                if (!ok) return "Not approved yet (or wrong password). Ask a member to approve this device, then try again.";
                new Notice("Encryption unlocked.");
                this.update?.();
                return null;
              },
            }).open();
          }))
          .addButton((b) => b.setButtonText("Cancel request").onClick(async () => {
            const myId = enc.myIdentityId(); if (myId) await enc.denyJoinRequest(myId);
            new Notice("Access request cancelled."); this.update?.();
          }));
        return;
      }

      // state === "member"
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

      if (SHOW_FORGET_KEYCHAIN_BUTTON && enc.keychainAvailable() && enc.isRemembered()) {
        new Setting(host).setName("Forget password on this device").setDesc("Drops ONLY the copy saved in this device's keychain — your encryption stays set up and nothing is decrypted or deleted. You'll just re-type the password next session. (To turn encryption off entirely, use “Remove encryption” below.)").addButton((b) =>
          b.setButtonText("Forget on this device").onClick(async () => { await enc.forgetKeychain(); new Notice("Removed from this device's keychain — encryption still set up."); this.update?.(); }));
      }

      if (enc.amIMember()) {
        new Setting(host).setName("Change this device's password").setDesc("Re-wraps THIS device's key under a new password — doesn't re-encrypt files or affect other people.").addButton((b) =>
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
      }

      if (enc.amIMember()) {
      new Setting(host).setName("Remove encryption").setDesc("Erases the key for this vault so you can start fresh. If anything is still encrypted, you'll be offered to decrypt it (needs your password) or — if you've lost the password — permanently delete it. Then just type the confirmation phrase; no password needed.").addButton((b) => {
        const runRemoval = async (): Promise<void> => {
          // 0.112.0: authoritative-but-cheap state check (in-memory index + two
          // folder listings of `_deleted/` and `.trash/`) instead of the old full
          // recursive adapter walk that took minutes.
          const state = await this.plugin.encryptionStateStrict();
          if (state.live) {
            // 0.112.7: live locked content has no plaintext copy. Offer to either
            // DECRYPT everything (needs the password) or DELETE it forever (for a
            // lost password), then re-enter the removal flow. Mirrors the trash.
            const deleteAllLocked = (): void => {
              new ConfirmModal(this.app, "Delete all locked content forever?",
                "This PERMANENTLY destroys every locked note and folder — there is NO decrypted copy and NO recovery. Only do this if you've lost the password and want to start fresh.",
                "Delete locked content forever",
                async (del) => {
                  if (!del) return;
                  const n = await this.plugin.purgeAllLockedContent();
                  new Notice(`Deleted ${n} locked item${n === 1 ? "" : "s"}.`);
                  void runRemoval();
                }).open();
            };
            const decryptAll = async (): Promise<void> => {
              await this.plugin.unlockAllInVault(); // prompts for the password if locked
              if ((await this.plugin.encryptionStateStrict()).live) {
                new Notice("Some notes are still locked (decryption was cancelled or failed) — removal cancelled.", 10000);
                return;
              }
              void runRemoval();
            };
            new ConfirmModal(this.app, "Encrypted notes are still locked",
              "Some notes or folders are still encrypted (locked) and have no plaintext copy. Before removing encryption:\n\n• Decrypt everything — unlock them back to normal notes (needs your password).\n• Delete locked content — permanently destroy them (only if you've lost the password).",
              "Decrypt everything",
              (decrypt) => { if (decrypt) void decryptAll(); else deleteAllLocked(); },
              "Delete locked content").open();
            return;
          }
          // No password required to remove encryption. By the time we get here
          // there is nothing recoverable to protect: live locked content already
          // HARD-REFUSES removal (you must decrypt it first), and the trash has
          // been explicitly decrypted or discarded. So the "REMOVE ENCRYPTION"
          // phrase is the only gate — critically, this lets a user who has LOST
          // the password (keychain empty/zeroed) still start fresh.
          // trashConsented: the user already chose to decrypt or discard the
          // encrypted trash; the confirm-time re-check uses it to abort only if
          // NEW encrypted content appears mid-dialog.
          const proceedToConfirm = (extraWarn: string, trashConsented: boolean): void => {
            new TypeToConfirmModal(this.app, {
              title: "Remove encryption?",
              body: `This erases the encryption key for this vault. No locked notes/folders exist, so your live content is safe.${extraWarn} You'll need to set a new password to encrypt again later, and anything previously exported with this key stays locked to its passphrase.`,
              phrase: "REMOVE ENCRYPTION",
              confirmText: "Remove encryption",
              onConfirm: async () => {
                // Re-check authoritatively at confirm time — a lock or encrypt-
                // delete could have synced in while the modal sat open.
                const now = await this.plugin.encryptionStateStrict();
                if (now.live) {
                  new Notice("Locked notes appeared while this dialog was open — removal cancelled. Decrypt everything first.", 10000);
                  return;
                }
                if (now.trash && !trashConsented) {
                  new Notice("Encrypted trash appeared while this dialog was open — removal cancelled. Re-open Remove encryption to handle it.", 10000);
                  return;
                }
                // Discard path: actually DELETE the encrypted-trash blobs now, so
                // removal doesn't leave orphaned, forever-unreadable files behind.
                // (Decrypt path already emptied `_deleted/`, so this is a no-op there.)
                const leftover = await this.plugin.listDeletedTrash();
                for (const it of leftover) await this.plugin.purgeDeletedAt(it.blob);
                await enc.clear(); new Notice("Encryption removed."); this.update?.();
              },
            }).open();
          };

          if (state.trash) {
            // Encrypted trash exists but no live locked content. Removing the key
            // makes the trash permanently unreadable. Fork: Decrypt Trash (CTA,
            // recommended — restores them to their folders) vs Discard trash
            // (→ a second Cancel/Confirm step before anything is lost). Esc on
            // this modal routes to the Discard confirm, which is cancelable.
            const decryptThenRemove = async (): Promise<void> => {
              const n = await this.plugin.restoreAllTrash();
              // Authoritative re-check — restore removes blobs via raw adapter
              // (no vault event), so confirm `_deleted/` is actually empty.
              if ((await this.plugin.encryptionStateStrict()).trash) {
                new Notice("Some encrypted-trash items couldn't be decrypted — removal cancelled. Check the trash tab and try again.", 10000);
                return;
              }
              proceedToConfirm(n > 0 ? ` (${n} trash item${n === 1 ? "" : "s"} were decrypted back to their folders.)` : "", true);
            };
            const confirmDiscard = (): void => {
              new ConfirmModal(this.app, "Discard encrypted trash?",
                "The encrypted-trash items will be PERMANENTLY lost the moment the key is erased — there is no recovery. Continue?",
                "Confirm",
                (discard) => { if (discard) proceedToConfirm(" ⚠️ The encrypted trash is being permanently discarded.", true); }).open();
            };
            new ConfirmModal(this.app, "Encrypted notes in the trash",
              "There are encrypted, deleted notes in the trash. Removing encryption makes them PERMANENTLY unreadable.\n\n• Decrypt Trash — restore them to their original folders first (recommended).\n• Discard trash — let them be permanently erased with the key.",
              "Decrypt Trash",
              (decrypt) => { if (decrypt) void decryptThenRemove(); else confirmDiscard(); },
              "Discard trash").open();
            return;
          }
          // Nothing encrypted at all → clean removal.
          proceedToConfirm("", false);
        };
        b.setButtonText("Remove…").onClick(() => void runRemoval());
        b.buttonEl.addClass("mod-warning");
      });
      }

      // ---- Sharing method 1: shared password (Model 1) ----
      new Setting(host).setName("Sharing").setHeading();
      if (!enc.isUnlocked()) {
        host.createEl("p", { cls: "setting-item-description" }).setText("Unlock encryption above to manage how this vault is shared.");
      } else {
        if (enc.hasSharedPassword()) {
          new Setting(host).setName("Shared password").setDesc("ON — anyone who knows it can unlock this vault (no approval). Share it via a password manager or secure message; don't send it in the clear.")
            .addButton((b) => b.setButtonText("Change…").onClick(() => {
              new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: true, kdfProbe, title: "Change shared password", intro: "Everyone who unlocks with the shared password will need the new one. Re-share it securely after changing.",
                onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; try { await enc.setSharedPassword(next, remember); } catch (e) { return (e as Error).message; } new Notice("Shared password updated."); this.update?.(); return null; } }).open();
            }))
            .addButton((b) => { b.setButtonText("Turn off").onClick(async () => { await enc.removeSharedPassword(); new Notice("Shared password turned off."); this.update?.(); }); b.buttonEl.addClass("mod-warning"); });
        } else {
          new Setting(host).setName("Shared password").setDesc("OFF — set one passphrase that everyone types to unlock (the simplest way to share). Anyone who knows it can unlock; turning it off later doesn't claw back copies already synced elsewhere.")
            .addButton((b) => b.setButtonText("Set shared password…").onClick(() => {
              new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: true, kdfProbe, title: "Set shared password", intro: "One passphrase everyone types to unlock this vault. Anyone who knows it gets in — share it ONLY through a password manager or secure message, never in the clear. You can turn it off later.",
                onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; try { await enc.setSharedPassword(next, remember); } catch (e) { return (e as Error).message; } new Notice("Shared password set — share it securely with your collaborators."); this.update?.(); return null; } }).open();
            }));
        }
      }

      // ---- Sharing method 2: device approval (Model 3) — members + requests ----
      // Hidden in the per-folder overhaul (manual password sharing is the model
      // now). Code kept dormant; flip SHOW_DEVICE_APPROVAL_UI to re-enable.
      if (SHOW_DEVICE_APPROVAL_UI) {
      new Setting(host).setName("Collaborators (device approval)").setHeading();
      host.createEl("p", { cls: "setting-item-description" }).setText(
        "Everyone who can unlock this vault, and devices waiting for access. Approving a request shares the vault key with that device — it never sees a password. Removing a member revokes future access (existing synced copies they already hold aren't clawed back — rotate the key for that, a future feature).",
      );
      const refreshBtn = new Setting(host).setName("Synced from the vault keyfile");
      refreshBtn.addButton((b) => b.setButtonText("Refresh").onClick(async () => { await enc.refresh(); this.update?.(); }));

      if (!enc.isUnlocked()) {
        host.createEl("p", { cls: "setting-item-description" }).setText("Unlock encryption above to approve or remove collaborators.");
      } else {
        const myId = enc.myIdentityId();
        for (const m of enc.members()) {
          const isMe = m.id === myId;
          const s = new Setting(host).setName(`${m.label}${isMe ? " — this device" : ""}`).setDesc(isMe ? "You" : "Member");
          if (!isMe) {
            s.addButton((b) => { b.setButtonText("Remove").onClick(async () => {
              await enc.removeMember(m.id);
              new Notice(`Removed ${m.label}. (Not full revocation without rotating the key.)`);
              this.update?.();
            }); b.buttonEl.addClass("mod-warning"); });
          }
        }
        const reqs = enc.pendingJoinRequests();
        if (reqs.length === 0) {
          host.createEl("p", { cls: "setting-item-description" }).setText("No pending access requests.");
        } else {
          for (const r of reqs) {
            new Setting(host).setName(r.label).setDesc("Wants access to this vault")
              .addButton((b) => b.setButtonText("Approve").setCta().onClick(async () => {
                try { await enc.approveJoinRequest(r.id); } catch (e) { new Notice((e as Error).message); return; }
                new Notice(`Approved ${r.label} — they can unlock once the keyfile syncs to them.`);
                this.update?.();
              }))
              .addButton((b) => b.setButtonText("Deny").onClick(async () => { await enc.denyJoinRequest(r.id); new Notice("Request denied."); this.update?.(); }));
          }
        }
      }
      } // end SHOW_DEVICE_APPROVAL_UI
    }, ["encryption", "encrypt", "password", "passphrase", "lock", "unlock", "key", "security", "private", "collaborator", "share", "team", "member", "approve"]));

    items.push(this.headingDef("Trash & title defaults", "Vault-wide defaults for deleted notes and locked-note titles. Per-folder overrides live under “Per-Folder Passwords” below."));
    items.push(this.renderDef("Encrypt items sent to trash", "When ON, deleting a note sends it to Stashpad's encrypted trash (recoverable with your password) instead of a plaintext trash. Default OFF.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.encryptTrash).onChange(async (v) => {
        if (v && !this.encryptionOrOnboard()) { this.update?.(); return; }
        this.plugin.settings.encryptTrash = v; await this.plugin.saveSettings();
      })), ["trash", "delete", "encrypt"]));
    items.push(this.renderDef("Encrypt trash filenames", "Hide the filename + origin folder of encrypted-trashed items (opaque names on disk; shown under “Hidden” in the trash tab). Default OFF so you can still tell what to restore when working outside the app.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.encryptTrashFilenames).onChange(async (v) => {
        if (v && !this.encryptionOrOnboard()) { this.update?.(); return; }
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
    items.push(this.renderDef("Hide titles of locked notes (default)", "The DEFAULT for hiding 🔒 locked-placeholder titles — used by any folder/trash that doesn't set its own “hide filenames” option in Per-Folder Passwords below (those override this). Shows a generic label instead of the note's title so a glance doesn't reveal what's locked. Default OFF.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.hideLockedTitles ?? false).onChange(async (v) => {
        if (v && !this.encryptionOrOnboard()) { this.update?.(); return; }
        this.plugin.settings.hideLockedTitles = v; await this.plugin.saveSettings();
        this.plugin.refreshAllStashpadViews?.();
      })), ["title", "hide", "private", "lock", "placeholder", "visibility"]));

    items.push(this.headingDef("Archive", "Archive folders are de-indexed from cross-folder search; mark a folder as an archive (and set whether it encrypts) under “Per-Folder Passwords” below."));
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

    // ---- Per-folder passwords (per-folder overhaul) — below the global settings ----
    items.push(this.sectionDef("Per-Folder Passwords", "Give a folder its own password (a separate key) so you can share just that folder with collaborators. Folders without their own password use the vault password.", (host) => {
      this.renderPerFolderEncryption(host);
    }, ["folder", "per-folder", "password", "encrypt", "key", "share", "collaborator", "archive", "unlock", "lock"]));

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
    };
    const rows = COMMAND_META.map((meta) => ({
      name: meta.label,
      desc: meta.desc,
      aliases: ["hotkey", "shortcut", "keybind", "binding", "key"],
      render: (s: Setting) => this.renderBindingRow(s, meta),
    }));
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
    const header = new Setting(containerEl).setName("JD Index Builder").setHeading();
    header.settingEl.id = "stashpad-jd-index-section";
    // 0.121.2: render the description into a .stashpad-settings-section host so
    // it picks up the standard 14px inset (a bare <p> on containerEl sits flush
    // against the modal edge — it's not a Setting row and not a section child).
    const blurb = containerEl.createEl("div", { cls: "stashpad-settings-section" })
      .createEl("p", { cls: "setting-item-description" });
    // 0.121.4: built with safe DOM helpers instead of innerHTML (the Obsidian
    // store linter flags raw HTML strings). Same rendered output: <br> breaks,
    // <strong> command names, <code> prefix examples.
    blurb.appendText("Builds a Johnny-Decimal-style index inside a designated Stashpad folder. Two commands:");
    blurb.createEl("br");
    blurb.createEl("strong", { text: "Preview" });
    blurb.appendText(" overwrites the designated folder’s HOME note body with the would-be hierarchy + everything that didn’t match. Frontmatter is preserved; everything below it is replaced.");
    blurb.createEl("br");
    blurb.createEl("strong", { text: "Build" });
    blurb.appendText(" creates an actual hierarchy of Stashpad notes (one per prefix), with child→parent relationships matching the dotted segments.");
    blurb.createEl("br");
    blurb.appendText("Matches strict prefixes only: all-digits (");
    blurb.createEl("code", { text: "10 Life" });
    blurb.appendText(") or alphanumeric-with-dots (");
    blurb.createEl("code", { text: "1.2 Family" });
    blurb.appendText(", ");
    blurb.createEl("code", { text: "animal.duck.yellow Eggs" });
    blurb.appendText("). Mixed schemes sort numbers first, then alphabetically.");

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
    const previewEl = containerEl.createEl("div", { cls: "stashpad-settings-section" })
      .createEl("p", { cls: "setting-item-description" });
    const skippedSuffix = scan.skippedStashpadNotes.length > 0
      ? ` (${scan.skippedStashpadNotes.length} Stashpad-folder note${scan.skippedStashpadNotes.length === 1 ? "" : "s"} excluded by default)`
      : "";
    previewEl.setText(
      `Preview: ${scan.indexed.length} note${scan.indexed.length === 1 ? "" : "s"} would be indexed, ` +
      `${scan.nonIndex.length} would NOT be indexed${skippedSuffix}.`,
    );

    new Setting(containerEl)
      .setName("Actions")
      .setClass("stashpad-jd-actions")
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
        .setName("Color aliases per Stashpad")
        .setDesc("No Stashpads discovered yet — create one above first.");
      return;
    }

    // Default the picker to the active view's folder when there is one,
    // otherwise the first discovered folder.
    let chosen = (() => {
      const active = (getActiveView())?.noteFolder as string | undefined;
      if (active && stashpads.includes(active)) return active;
      return stashpads[0];
    })();

    new Setting(parent)
      .setName("Color aliases per Stashpad")
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
  /** 0.99.15: Authorship tab decomposed for native settings search — static
   *  fields as per-setting renderDefs; the dynamic "folders worked in" + "known
   *  authors" lists as sectionDefs (rendered fresh at display). */
  private authorshipItems(): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [];
    items.push(this.renderDef("Author name",
      "Your display name. Used in the note footer + as the author/contributor link target. Leave blank to opt out (notes won't be stamped).",
      (s) => s.addText((t) => t.setValue(this.plugin.settings.authorName).onChange(async (v) => {
        this.plugin.settings.authorName = v.trim();
        if (this.plugin.settings.authorName && !this.plugin.settings.authorId) this.plugin.settings.authorId = newId();
        await this.plugin.saveSettings();
        await this.plugin.syncAuthorFilesToName();
      })), ["author", "name", "identity", "stamp"]));
    items.push(this.renderDef("Author id (auto-assigned)",
      "Stable id appended to your name on links so coworkers with the same name don't collide. Generated once and shouldn't change. To reset it, clear and retype your author name.",
      (s) => s.addText((t) => t.setValue(this.plugin.settings.authorId).setDisabled(true)), ["author", "id"]));
    items.push(this.renderDef("Title / role",
      "Optional. Shown on your author page (e.g. \"Engineer\", \"PM\", \"Designer\").",
      (s) => s.addText((t) => t.setValue(this.plugin.settings.authorRole).onChange(async (v) => {
        this.plugin.settings.authorRole = v.trim(); await this.plugin.saveSettings(); await this.plugin.syncAuthorFilesToName();
      })), ["role", "title", "job"]));
    items.push(this.renderDef("Department / team",
      "Optional. Shown on your author page (e.g. \"Engineering\", \"Growth\").",
      (s) => s.addText((t) => t.setValue(this.plugin.settings.authorDepartment).onChange(async (v) => {
        this.plugin.settings.authorDepartment = v.trim(); await this.plugin.saveSettings(); await this.plugin.syncAuthorFilesToName();
      })), ["department", "team"]));
    const footerToggle = (name: string, get: () => boolean, put: (v: boolean) => void, aliases: string[]): SettingDefinitionItem =>
      this.renderDef(name, "", (s) => s.addToggle((t) => t.setValue(get()).onChange(async (v) => { put(v); await this.plugin.saveSettings(); })), aliases);
    items.push(footerToggle("Show author in note footer", () => this.plugin.settings.showAuthor, (v) => { this.plugin.settings.showAuthor = v; }, ["author", "footer", "show"]));
    items.push(footerToggle("Show contributors in note footer", () => this.plugin.settings.showContributors, (v) => { this.plugin.settings.showContributors = v; }, ["contributors", "footer", "show"]));
    items.push(footerToggle("Show last edit time in note footer", () => this.plugin.settings.showLastEdit, (v) => { this.plugin.settings.showLastEdit = v; }, ["last edit", "modified", "footer", "time"]));
    items.push(this.sectionDef("Folders You've Worked In",
      "Folders where you've authored or contributed notes. Click one to open it.",
      (host) => this.renderAuthoredFolders(host),
      ["folders", "authored", "contributed", "worked"]));
    items.push(this.sectionDef("Known Authors",
      "Everyone the plugin has seen, with role/department + rename history; rebuild/restore the registry.",
      (host) => this.renderKnownAuthorsSection(host),
      ["authors", "registry", "rename", "known", "rebuild"]));
    return items;
  }

  /** The "folders you've worked in" list, extracted so the authorship sectionDef
   *  can render it fresh at display time. */
  private renderAuthoredFolders(parent: HTMLElement): void {
    // 0.121.5: this sectionDef renders no heading of its own, so label the list.
    new Setting(parent).setName("Folders you've worked in").setHeading();
    const folders = this.plugin.collectAuthoredFolders();
    if (folders.length === 0) { parent.createEl("p", { cls: "setting-item-description", text: "No authored or contributed folders yet." }); return; }
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

  /** 0.99.15: Templates tab — the two per-folder editors as searchable sections. */
  private templatesItems(): SettingDefinitionItem[] {
    return [
      this.sectionDef("Color Aliases",
        "Give your note colors friendly names, per Stashpad folder.",
        (host) => this.renderColorAliasesSection(host),
        ["color", "colour", "alias", "name", "swatch", "palette", "label"]),
      this.sectionDef("Note Templates",
        "Per-Stashpad note templates — content stamped into new notes.",
        (host) => this.renderNoteTemplatesSection(host),
        ["template", "note", "default", "boilerplate", "snippet"]),
    ];
  }

  /** 0.99.15: JD Index tab as a searchable section (scope/preview/build inside). */
  private jdIndexItems(): SettingDefinitionItem[] {
    return [
      this.sectionDef("JD Index (Johnny Decimal)",
        "Build a Johnny-Decimal-style index from dotted-prefix note titles — set the scope, preview, then build.",
        (host) => this.renderJdIndexSection(host),
        ["jd", "johnny", "decimal", "index", "scope", "build", "preview", "hierarchy", "folder"]),
    ];
  }

  /** OKF (Open Knowledge Format) tab. Phase 1: master toggle + docs + how-to.
   *  Frontmatter/index.md/export land in later phases (docs/branches/okf.md). */
  private okfItems(): SettingDefinitionItem[] {
    return [
      this.sectionDef("Open Knowledge Format (OKF)",
        "Turn a Stashpad folder into a browsable OKF bundle — markdown concept files with OKF frontmatter, a generated index.md, and relative-markdown cross-links — that LLMs/agents can read. Complements (never replaces) Stashpad's own frontmatter and links.",
        (host) => this.renderOkfSection(host),
        ["okf", "open knowledge format", "knowledge", "catalog", "index", "export", "bundle", "tarball", "agent", "google"]),
    ];
  }

  /** Append `text` to an element/fragment, rendering `backtick` spans as <code>
   *  (monospace) via text nodes — safe for interpolated values (no innerHTML). */
  private appendCode(el: HTMLElement | DocumentFragment, text: string): void {
    text.split(/`([^`]+)`/g).forEach((part, i) => {
      if (i % 2 === 1) el.createEl("code", { text: part });
      else if (part) el.appendText(part);
    });
  }
  /** A setting-description fragment with `backtick` → <code>, for setDesc(). */
  private codeDesc(text: string): DocumentFragment {
    const f = document.createDocumentFragment();
    this.appendCode(f, text);
    return f;
  }

  private renderOkfSection(parent: HTMLElement): void {
    parent.createDiv({ cls: "stashpad-beta-row" }).createEl("span", { cls: "stashpad-beta-badge", text: "BETA" });

    new Setting(parent)
      .setName("Enable OKF")
      .setDesc(this.codeDesc("Master switch. When on, you choose which folders use OKF by assigning the OKF template to them in Stashpad's own Templates section (the 📄 Templates settings here — NOT Obsidian's core Templates plugin) — all / some / none, your call. Those folders then get OKF frontmatter and a maintained `index.md`. Turning this off leaves existing OKF files in place; it just stops maintaining them."))
      .addToggle((t) => t.setValue(this.plugin.settings.okfEnabled).onChange(async (v) => {
        this.plugin.settings.okfEnabled = v;
        await this.plugin.saveSettings();
        if (v) { try { await this.plugin.ensureOkfTemplate(); } catch (e) { console.warn("[Stashpad] OKF template create failed", e); } }
        new Notice(v
          ? `OKF on. Next: assign the template "${this.plugin.okfTemplatePathOrDefault()}" to a folder — use “Create template + open Templates” below. Heads-up: OKF frontmatter + index.md refresh automatically but NOT instantly (a few seconds after changes); hit Rebuild for an immediate pass.`
          : "OKF disabled.", v ? 0 : 4000); // persistent CTA on enable (stays until dismissed)
        this.update?.();
      }));

    if (this.plugin.settings.okfEnabled) {
      const okfPath = this.plugin.okfTemplatePathOrDefault();
      const okfCount = this.plugin.okfActiveFolders().length;
      const steps = parent.createEl("div", { cls: "setting-item-description stashpad-okf-howto" });
      steps.createEl("p", { text: "How to use OKF in a folder:" });
      const ol = steps.createEl("ol");
      this.appendCode(ol.createEl("li"), `Open Stashpad's 📄 Templates section (here in Stashpad's settings — not Obsidian's core Templates plugin) and set a folder's template to \`${okfPath}\` (archive folders are skipped).`);
      this.appendCode(ol.createEl("li"), "Hit Rebuild below to write OKF frontmatter (`okfParent`/`okfChildren` + `okfType`/`okfTitle`/`okfTimestamp`) and generate that folder's `index.md`.");
      this.appendCode(ol.createEl("li"), "Right-click a note (or a selection) → “Export as OKF…” to save a `.zip` / `.tar.gz` bundle (or `.stash`).");
      steps.createEl("p", { cls: "stashpad-okf-soon", text: "OKF frontmatter + index.md refresh automatically a few seconds after you add, move, or delete notes — NOT instantly. Use Rebuild for an immediate pass." });
      if (okfCount === 0) {
        const cta = parent.createEl("p", { cls: "stashpad-okf-cta" });
        this.appendCode(cta, "👉 No folder is using OKF yet. Click “Create template + open Templates” below, then set a folder's template to `" + okfPath + "`.");
      } else {
        steps.createEl("p", { cls: "stashpad-okf-soon", text: `Currently ${okfCount} folder${okfCount === 1 ? "" : "s"} actively using OKF.` });
      }

      new Setting(parent)
        .setName("Assign OKF to folders")
        .setDesc(this.codeDesc(`Creates the OKF template if needed (never duplicates it), then opens Templates — set a folder's template to \`${okfPath}\` there.`))
        .addButton((b) => { b.setButtonText("Create template + open Templates").setCta(); b.onClick(async () => {
          let path: string;
          try { path = await this.plugin.ensureOkfTemplate(); }
          catch (e) { new Notice(`Couldn't create the OKF template: ${(e as Error).message}`); return; }
          new Notice(`OKF template ready at "${path}" — set a folder's template to that path.`);
          this.update?.();
          this.openSettingsPage("Templates");
        }); });

      new Setting(parent)
        .setName("Rebuild OKF frontmatter")
        .setDesc(this.codeDesc("Write/refresh OKF fields for every folder using the OKF template — `okfParent`/`okfChildren` relative links (managed) plus `okfType`/`okfTitle`/`okfTimestamp` defaults (yours to edit after). Heads-up: adding, moving, or deleting notes already auto-refreshes the folder, but NOT instantly — it waits ~a few seconds after you stop. Use this button for an immediate rebuild (e.g. right after first assigning the template). Complements Stashpad's own links; nothing is removed."))
        .addButton((b) => b.setButtonText("Rebuild now").onClick(async () => {
          const r = await this.plugin.rebuildAllOkf();
          new Notice(r.folders === 0
            ? "No folders use the OKF template yet — assign it in Templates first."
            : `OKF: updated ${r.written} of ${r.checked} notes across ${r.folders} folder${r.folders === 1 ? "" : "s"}.`);
          this.update?.();
        }));
    }

    // Docs
    const docs = new Setting(parent).setName("Learn about OKF").setDesc("Google's open, vendor-neutral spec for sharing curated knowledge with agents.");
    docs.addButton((b) => b.setButtonText("Spec / repo").onClick(() => window.open("https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf")));
    docs.addButton((b) => b.setButtonText("Announcement").onClick(() => window.open("https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/")));
  }

  /** Best-effort jump to another Stashpad settings sub-page by its visible name.
   *  Obsidian exposes no public sub-page nav, so we reset to the Stashpad page
   *  list (openTabById) then click the matching entry; falls back to a hint. */
  private openSettingsPage(pageName: string): void {
    // Obsidian has no public API to open a plugin's own settings SUB-PAGE (see
    // docs/obsidian-limitations.md). Best-effort: reset to the Stashpad page list,
    // then click the matching entry — but ONLY inside the active tab's CONTENT
    // pane, never the left sidebar (whose core/community plugin tabs, e.g. the core
    // "Templates" plugin, would otherwise match by name and mis-navigate). If we
    // can't find it in-content, we DON'T guess — we just point the way.
    const hint = () => new Notice(`Open Settings → Stashpad → ${pageName}.`);
    try {
      const setting = (this.app as App & { setting?: { openTabById?: (id: string) => void; modalEl?: HTMLElement } }).setting;
      if (!setting?.openTabById) { hint(); return; }
      setting.openTabById("stashpad");
      window.setTimeout(() => {
        const content = setting.modalEl?.querySelector<HTMLElement>(".vertical-tab-content");
        if (!content) { hint(); return; }
        const hit = Array.from(content.querySelectorAll<HTMLElement>("*"))
          .find((e) => e.childElementCount === 0 && e.textContent?.trim() === pageName && !e.closest(".vertical-tab-header"));
        const link = hit?.closest<HTMLElement>("[class*='nav'], .setting-item, button, a");
        if (link && !link.closest(".vertical-tab-header")) link.click(); else hint();
      }, 60);
    } catch { hint(); }
  }

  private renderAuthorshipSection(parent: HTMLElement): void {
    new Setting(parent).setName("Authorship").setHeading();
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
      new Setting(parent).setName("Folders You've Worked In").setHeading();
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
    new Setting(parent).setName("Known Authors (registry)").setHeading();
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

    if (this.plugin.settings.okfEnabled) {
      const okfPath = this.plugin.okfTemplatePathOrDefault();
      this.appendCode(parent.createEl("p", { cls: "setting-item-description" }),
        `💡 OKF tip: type \`${okfPath}\` into a folder's template field below to turn that folder into an OKF bundle (OKF frontmatter + a maintained \`index.md\`). Assign it to all, some, or none of your folders — it's per-folder. Manage OKF itself in Settings → OKF.`,
      );
    }

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
      sugg.setCssStyles({ display: "none" });
      let currentMatches: string[] = [];
      let itemEls: HTMLElement[] = [];
      let activeIdx = -1;
      const isOpen = (): boolean => sugg.style.display !== "none" && currentMatches.length > 0;
      const highlight = (i: number): void => {
        activeIdx = i;
        itemEls.forEach((el, idx) => el.toggleClass("is-active", idx === i));
        if (i >= 0 && itemEls[i]) itemEls[i].scrollIntoView({ block: "nearest" });
      };
      const closeSugg = (): void => { sugg.setCssStyles({ display: "none" }); activeIdx = -1; };
      const choose = async (m: string): Promise<void> => { input.value = m; await save(); closeSugg(); };

      // Inline warning area — surfaces overlap with Stashpad's
      // auto-managed frontmatter so the user can fix the template before
      // it produces surprising notes.
      const warn = row.createDiv({ cls: "stashpad-note-template-warn" });
      warn.setCssStyles({ display: "none" });

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
        itemEls = [];
        // 0.76.26: Sift — all-tokens, any-order match (see docs/sift.md).
        const tokens = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const sift = (p: string): boolean => {
          const h = p.toLowerCase();
          return tokens.every((t) => h.includes(t));
        };
        currentMatches = allMd().filter((p) => sift(p)).slice(0, 12);
        if (currentMatches.length === 0) { closeSugg(); return; }
        sugg.setCssStyles({ display: "" });
        currentMatches.forEach((m, idx) => {
          const item = sugg.createDiv({ cls: "stashpad-note-template-suggest-item", text: m });
          itemEls.push(item);
          item.addEventListener("mousemove", () => highlight(idx));
          // mousedown (not click) so the input's blur doesn't close the
          // popover before the click registers.
          item.addEventListener("mousedown", async (ev) => { ev.preventDefault(); await choose(m); });
        });
        activeIdx = activeIdx >= 0 && activeIdx < currentMatches.length ? activeIdx : -1;
        if (activeIdx >= 0) highlight(activeIdx);
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
        warn.setCssStyles({ display: "none" });
        const path = input.value.trim();
        if (!path) return;
        // Wrap in a microtask to give the metadataCache a beat to catch
        // up if the user just typed in a path.
        const tplFile = this.app.vault.getAbstractFileByPath(path);
        if (!tplFile || (tplFile as any).extension !== "md") {
          warn.setCssStyles({ display: "" });
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
        warn.setCssStyles({ display: "" });
        warn.setText(
          `⚠ Template defines ${conflicts.join(", ")} — Stashpad always sets ${conflicts.length === 1 ? "this" : "these"} on new notes, so the template value${conflicts.length === 1 ? "" : "s"} will be ignored.`,
        );
      };

      input.addEventListener("focus", renderSuggestions);
      input.addEventListener("input", () => { activeIdx = -1; renderSuggestions(); });
      input.addEventListener("blur", () => { setTimeout(closeSugg, 150); });
      input.addEventListener("change", () => { void save(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (!isOpen()) { renderSuggestions(); if (currentMatches.length) highlight(0); }
          else highlight((activeIdx + 1) % currentMatches.length);
        } else if (e.key === "ArrowUp") {
          if (!isOpen()) return;
          e.preventDefault();
          highlight((activeIdx - 1 + currentMatches.length) % currentMatches.length);
        } else if (e.key === "Enter") {
          if (isOpen() && activeIdx >= 0) { e.preventDefault(); void choose(currentMatches[activeIdx]); }
        } else if (e.key === "Escape") {
          if (isOpen()) { e.preventDefault(); closeSugg(); }
        } else if (e.key === "Tab" && !e.shiftKey) {
          // Per-segment ("per word") completion: extend the input toward the
          // active (or first) match by one path segment, narrowing the list.
          // Only swallow Tab when we actually complete — otherwise let it move
          // focus as usual.
          if (!isOpen()) return;
          const target = currentMatches[activeIdx >= 0 ? activeIdx : 0];
          const cur = input.value;
          let next: string;
          if (target.toLowerCase().startsWith(cur.toLowerCase())) {
            const slash = target.indexOf("/", cur.length);
            next = slash >= 0 ? target.slice(0, slash + 1) : target;
          } else {
            next = target; // token (non-prefix) match — complete it fully
          }
          if (next && next !== cur) {
            e.preventDefault();
            input.value = next;
            activeIdx = -1;
            renderSuggestions();
            if (currentMatches.length === 1) highlight(0);
          }
        }
      });
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
    swatch.setCssStyles({ background: hex });
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
    });
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
    if (!input.value) del.setCssStyles({ visibility: "hidden" });
    del.onclick = async () => {
      await this.plugin.setColorAlias(folder, hex, "");
      // If the row was unused AND we just removed its alias, the row
      // has no reason to exist anymore — refresh to drop it.
      if (count === 0) refresh();
      else { input.value = ""; del.setCssStyles({ visibility: "hidden" }); }
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
    row.settingEl.addClass("stashpad-binding-row");
    const get = () => this.plugin.settings.bindings[meta.id];

    let primaryInput: HTMLInputElement;
    let secondaryInput: HTMLInputElement;
    let refreshToggle = (): void => {};
    // 0.121.11 (#8/#9): a tri-state segmented control (Left | Both | Right) on
    // the LEFT, then the two key slots STACKED on the right — replacing the old
    // L/R pill + separate "Use both" checkbox. `setState` is assigned once the
    // slots exist (below); the buttons just call it.
    let setState = async (_s: "left" | "both" | "right"): Promise<void> => {};
    const seg = row.controlEl.createDiv({ cls: "stashpad-binding-seg", attr: { role: "group", "aria-label": "Active binding" } });
    const segBtns = {
      left: seg.createEl("button", { cls: "stashpad-binding-seg-btn", text: "Left" }),
      both: seg.createEl("button", { cls: "stashpad-binding-seg-btn", text: "Both" }),
      right: seg.createEl("button", { cls: "stashpad-binding-seg-btn", text: "Right" }),
    };
    (["left", "both", "right"] as const).forEach((k) => { segBtns[k].onclick = () => void setState(k); });
    const slotsCol = row.controlEl.createDiv({ cls: "stashpad-binding-slots" });

    const renderSlot = (which: "primary" | "secondary"): HTMLInputElement => {
      const wrap = slotsCol.createDiv({ cls: "stashpad-binding-slot" });
      const input = wrap.createEl("input", { type: "text" });
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
      // 0.121.12 (#4): clear (×) + revert (↺) share a wrapper so they can stack
      // vertically on mobile instead of widening the row.
      const slotBtns = wrap.createDiv({ cls: "stashpad-binding-slot-btns" });
      const clearBtn = slotBtns.createEl("button", { cls: "stashpad-binding-clear", text: "×" });
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
      const revertBtn = slotBtns.createEl("button", { cls: "stashpad-binding-revert" });
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

    // 0.121.11: tri-state behaviour. Left = primary only, Right = secondary
    // only, Both = both fire. Only meaningful once BOTH slots are bound (until
    // then the lone bound slot just fires and the control is disabled).
    setState = async (state: "left" | "both" | "right"): Promise<void> => {
      const b = this.plugin.settings.bindings[meta.id];
      if (!(b.primary && b.secondary)) return;
      if (state === "both") { b.useBoth = true; }
      else { b.useBoth = false; b.preferRight = state === "right"; }
      await this.plugin.saveSettings();
      refreshToggle();
    };

    refreshToggle = (): void => {
      const b = get();
      const both = !!(b.primary && b.secondary);
      const active: "left" | "both" | "right" = b.useBoth ? "both" : (b.preferRight ? "right" : "left");
      (["left", "both", "right"] as const).forEach((k) => {
        segBtns[k].toggleClass("is-active", both && k === active);
        segBtns[k].disabled = !both;
      });
      seg.toggleClass("is-disabled", !both);
      seg.title = both
        ? "Which binding is active — Left, Both, or Right"
        : "Bind both slots to choose Left / Both / Right";
    };

    refreshToggle();
  }
}
