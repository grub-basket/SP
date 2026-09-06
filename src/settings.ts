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
import { QUICK_ACTION_CATALOG } from "./quick-actions";
import { LogModal, ColorPickerModal, NotificationHistoryModal, EncryptionPasswordModal, TypeToConfirmModal, ConfirmModal } from "./modals";
import { CATEGORY_LABELS, type NotificationCategory } from "./notifications";
import { startHotkeyRecording, prettifyChord } from "./hotkey-recorder";
import { DEFAULT_STOPWORDS } from "./slug-service";
import { newId } from "./id-service";
import { COPY_TS_MODIFIER_ORDER, type CopyTsModifier, parseModifierTokens, serializeModifierTokens, copyTimestampStatus, humanCombo } from "./view-keys";
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
  edit: string;        // E — edit selected note in the in-app editor
  editParent: string;  // Shift+E — edit the focused parent note in the in-app editor
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
  focusList: string;        // "Mod+Shift+L" — move focus from the composer into the list
  toggleObscured: string;   // "" — blur/unblur the selection (visual only)
}

/** All keyboard-bindable commands, in display order. The labels and
 *  descriptions live in COMMAND_META below. */
export type CommandId =
  | "move" | "pickMove" | "merge" | "copy" | "copyTree" | "copyLink" | "openEditor" | "openTab"
  | "split" | "edit" | "editParent" | "copyOutline"
  | "toggleSplit" | "pickDestination" | "search" | "searchInParent" | "delete" | "undo" | "redo"
  | "toggleComplete" | "moveUp" | "moveDown" | "moveToTop" | "moveToBottom"
  | "outdent" | "setColor"
  | "clone" | "forkNote" | "insertTemplate"
  | "toggleExpand" | "expandAll" | "collapseAll"
  | "exportStash" | "importStash" | "pickFolder"
  | "cloneStashpadTab" | "selectAll" | "copyCodeBlock"
  | "swapWithParent"
  | "togglePin" | "listPin" | "listPinBottom"
  | "toggleTask" | "setDue" | "openAllTasks"
  | "jumpToTop" | "jumpToBottom"
  | "lockSelection" | "unlockAll" | "moveToArchive" | "encryptDelete"
  | "copyNotes" | "cutNotes" | "pasteNotes"
  | "copyForOtherVault" | "cutForOtherVault"
  | "commandPalette"
  | "focusList"
  | "toggleObscured";

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
  { id: "copyTree",        label: "Copy tree",                     desc: "Copy the selected note(s) + everything nested under them, indented. For the note you are currently inside, use the \"Copy focused subtree\" command.",                                     defaultPrimary: "Y" },
  { id: "copyLink",        label: "Copy Stashpad link",            desc: "Copy an obsidian://stashpad deep link to the cursor row (or first selected note) — click it anywhere to jump back. No default chord.", defaultPrimary: "" },
  { id: "openEditor",      label: "Open in Obsidian editor",       desc: "Open the cursor row (or focused note) in a regular Obsidian markdown tab.",              defaultPrimary: "Mod+Shift+E" },
  { id: "openTab",         label: "Open in new Stashpad tab",      desc: "Open the cursor row (or focused note) in a new Stashpad tab focused on it.",             defaultPrimary: "T" },
  { id: "split",           label: "Split note",                    desc: "Split the cursor row (or focused note) into two notes at a chosen line.",                defaultPrimary: "S" },
  { id: "edit",            label: "Edit note in Stashpad",         desc: "Edit the cursor row (or focused note) in Stashpad's own editor (with a Split toggle) instead of a full Obsidian tab.", defaultPrimary: "E" },
  { id: "editParent",      label: "Edit parent note in Stashpad",  desc: "Edit the focused parent note in Stashpad's own editor.",                                 defaultPrimary: "Shift+E" },
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
  { id: "focusList",       label: "Focus the list",                desc: "Default: Mod+Shift+L — move keyboard focus out of the composer and onto the list, landing on the last note you had selected.", defaultPrimary: "Mod+Shift+L" },
  { id: "toggleObscured",  label: "Obscure / reveal note",          desc: "Blur the selected note(s) until tapped. VISUAL ONLY — the text stays in the file, in search and in the editor; this hides it from someone glancing at your screen, nothing more. For real privacy use per-folder encryption. No default chord.", defaultPrimary: "" },
  { id: "clone",           label: "Clone (duplicate / copy) selection", desc: "Default: Mod+Shift+D — clone selected notes (with their subtrees) as siblings.",   defaultPrimary: "Mod+Shift+D" },
  { id: "forkNote",        label: "Fork into a separate note (under a chosen parent)", desc: "Duplicate the cursor row (with its subtree) as a separate note and pick which parent it nests under. Distinct from \"Fork as a version\" (a draft within a sheet group). No default chord.", defaultPrimary: "" },
  { id: "insertTemplate",  label: "Insert template (clone an existing note)", desc: "Pick any note in this Stashpad; clone it (with subtree + attachments) into the current view, retimestamped.", defaultPrimary: "" },
  { id: "toggleExpand",    label: "Show more / show less (expand toggle)", desc: "Default: Shift+? — toggle the clamp on the cursor row (or every selected row).", defaultPrimary: "Shift+?" },
  { id: "expandAll",       label: "Expand all (show every note's full body)", desc: "Un-clamp every note in the current list at once.", defaultPrimary: "" },
  { id: "collapseAll",     label: "Collapse all (clamp every note's body)", desc: "Re-clamp every note in the current list at once.", defaultPrimary: "" },
  { id: "exportStash",     label: "Export selection…",             desc: "Open the export dialog for the selected subtree(s) — pick .stash / OKF / plain .zip and full/frontmatter/body content.", defaultPrimary: "" },
  { id: "importStash",     label: "Import .stash file",            desc: "Open the .stash bundle picker and import its notes into this Stashpad.",                  defaultPrimary: "" },
  { id: "pickFolder",      label: "Open / switch / create Stashpad folder", desc: "Default: Mod+S — opens the unified folder picker (reveal, switch, create, convert).", defaultPrimary: "Mod+S" },
  { id: "cloneStashpadTab",label: "Clone (duplicate / copy) this Stashpad tab", desc: "Open a second tab on the same folder + focus, mirroring the \"copy\" button in the focused-header actions.", defaultPrimary: "" },
  { id: "selectAll",       label: "Select all notes in view",      desc: "Default: Mod+A — adds every visible row to the selection.",                              defaultPrimary: "Mod+A" },
  { id: "copyCodeBlock",   label: "Copy code from codeblock",      desc: "Default: { — copy the contents of the cursor row's first codeblock (or pick one when multiple exist).", defaultPrimary: "{" },
  { id: "swapWithParent",  label: "Swap with parent (ouroboros)",  desc: "Promote the cursor row above its current parent; the parent slides under it (carrying its other children). No default — bind in this tab.", defaultPrimary: "" },
  { id: "togglePin",       label: "Pin / unpin selected note",     desc: "Default: P — toggle the sidebar pin state of the cursor row (or focused note).", defaultPrimary: "P" },
  { id: "listPin",         label: "Pin / unpin to top of list",    desc: "Float the cursor row (or selection) to the TOP of its list — distinct from the sidebar pin. Pinned notes ignore the time filter. No default chord.", defaultPrimary: "" },
  { id: "listPinBottom",   label: "Pin / unpin to bottom of list", desc: "Float the cursor row (or selection) to the BOTTOM of its list. Pinned notes ignore the time filter. No default chord.", defaultPrimary: "" },
  { id: "toggleTask",      label: "Toggle task (todo)",            desc: "Default: G — mark the selection (or cursor row) as a task / todo, or clear it. Tasks appear in the Tasks panel.", defaultPrimary: "G" },
  { id: "setDue",          label: "Set due date…",                 desc: "Default: D — open a date+time picker to set (or clear) the due date on the selection. Setting a due date also marks the note as a task.", defaultPrimary: "D" },
  { id: "openAllTasks",    label: "Open all tasks (aggregate view)", desc: "Default: Shift+T — open the aggregate “All tasks” view collecting tasks across every Stashpad folder.", defaultPrimary: "Shift+T" },
  { id: "jumpToTop",       label: "Jump to top of list",           desc: "Default: Home — move the cursor to the first note in the current list.", defaultPrimary: "Home" },
  { id: "jumpToBottom",    label: "Jump to bottom of list",        desc: "Default: End — move the cursor to the last note in the current list.", defaultPrimary: "End" },
  { id: "commandPalette",  label: "Command palette (Stashpad only)", desc: "Default: Mod+K — open a command palette listing only Stashpad's commands, with Sift search.", defaultPrimary: "Mod+K" },
  { id: "lockSelection",   label: "Encrypt (lock) selection",      desc: "Encrypt the selected note(s) + their children into a locked .stashenc bundle in place (prompts to unlock first if needed). No default chord.", defaultPrimary: "" },
  { id: "unlockAll",       label: "Decrypt (unlock) locked notes in view", desc: "Decrypt every locked stash shown in the current view back into place, skipping any that can't be read. No default chord.", defaultPrimary: "" },
  { id: "moveToArchive",   label: "Move selection to archive", desc: "Move the selected note(s) into this folder's own archive subfolder (drops out of search; plaintext unless this folder encrypts its archive). Undoable. No default chord.", defaultPrimary: "" },
  { id: "encryptDelete",   label: "Encrypt & delete selection",     desc: "Send the selected note(s) to the encrypted trash (recoverable with your password, Ctrl/Cmd+Z undoable). No default chord.", defaultPrimary: "" },
  { id: "copyNotes",       label: "Copy notes (note clipboard)",    desc: "Copy the selected note(s) as NOTES: paste in the list to duplicate them (new ids), or anywhere else to paste their text. Skipped when text is highlighted (normal copy wins).", defaultPrimary: "Mod+C" },
  { id: "cutNotes",        label: "Cut notes",                      desc: "Cut the selected note(s): paste in the list to MOVE them, or in the composer to extract their text and delete the originals (undoable).", defaultPrimary: "Mod+X" },
  { id: "copyForOtherVault", label: "Copy for another vault",         desc: "Copy the selected note(s) AND prepare the cross-vault payload, so they can be pasted into a DIFFERENT vault. Slower than plain copy — it reads every note and attachment in the selection — which is why it is its own command.", defaultPrimary: "" },
  { id: "cutForOtherVault",  label: "Cut for another vault",          desc: "Cut the selected note(s) for a DIFFERENT vault. After the other vault confirms the paste, Stashpad offers to delete the originals here. Nothing is deleted until then.", defaultPrimary: "" },
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

// (0.143.0: SHOW_SHARING_UI + SHOW_FORGET_KEYCHAIN_BUTTON removed with the
// vault-wide sharing / device-keychain UI — encryption is strictly per-folder.)

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

/** 0.138.0: one watchlist entry — a subtree that WAS encrypted and is now
 *  plaintext. Per-SUBTREE (rootId) granularity: children ride with their root. */
export interface ReEncryptWatchEntry {
  folder: string;
  rootId: string;
  title: string;
  count: number;
  /** ISO timestamp of the unlock/restore that put it on the list. */
  unlockedAt: string;
  /** How it became plaintext: an ad-hoc unlock, or a restore from trash. */
  via: "unlock" | "restore";
  /** Dismissed by the user — lives in the "Removed from watchlist" section
   *  (recoverable) and is excluded from sweeps/nudges. */
  removed?: boolean;
  removedAt?: string;
  /** 0.139.0 (peek): per-note override of the auto-re-encrypt idle delay
   *  (minutes). Wins over the per-folder + global settings. 0 = off for this
   *  note; undefined = fall through to folder/global. */
  peekMin?: number;
}

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
  /** 0.139.0 (peek): auto-re-encrypt this folder's unlocked notes after N idle
   *  minutes. Overrides the global `reEncryptAfterMin`; 0/undef = use global. */
  reEncryptAfterMin?: number;
}

export interface StashpadSettings {
  folder: string;
  /** True once the first-run welcome has been answered (including "Set up
   *  later" and dismissing it). Gates the modal so it asks exactly once —
   *  the other gate is "you have zero Stashpad folders". */
  onboardingAnswered: boolean;
  /** What they picked, for diagnostics only — nothing branches on it. */
  onboardingChoice: "later" | "fresh" | "demo" | null;
  /** The Stashpad folder most recently viewed. Ranked first in the folder
   *  switcher so the common "back to what I was doing" case is one keystroke. */
  lastUsedFolder: string;
  /** 0.221.0: most-recently-used Stashpad folders, newest first, capped. Backs
   *  the composer's quick-destination menu so the common "send this somewhere
   *  else" case is one tap instead of a full picker. */
  recentFolders: string[];
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
  /** 0.254.0: type `/` in the composer or the note editor to run a Stashpad
   *  command from a popup, instead of reaching for a chord or the palette. */
  slashCommands: boolean;
  /** 0.264.0: callout type used for link-preview blocks ("info", "quote",
   *  "abstract"…). Purely cosmetic — it picks the icon and colour Obsidian
   *  renders. */
  linkPreviewCallout: string;
  /** Politeness delay between link-preview fetches, ms. Applies to backfill
   *  most of all: a sweep over an archive is thousands of requests. */
  linkPreviewDelayMs: number;
  /** 0.265.0: fetch previews automatically for links in notes as they are
   *  saved, instead of only on an explicit command. OFF by default — it turns
   *  typing a URL into a network request and a note write. */
  linkPreviewAuto: boolean;
  /** Start preview callouts folded shut. Off by default: folding hides the
   *  description, which is the thing worth capturing. */
  linkPreviewCollapsed: boolean;
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
  /** 0.164.0: pin-order key for pinned FOLDERS, mirroring a note's `pinnedAt`
   *  frontmatter. Lets pinned folders interleave + drag-reorder with pinned notes
   *  in the Pinned section (one shared numeric order), and drives the pinned
   *  folders' order in the Folders section. Keyed by cleaned folder path; a
   *  missing entry is backfilled from the folder's position in `folderPanelPinned`. */
  folderPanelPinnedAt: Record<string, number>;
  /** 0.164.3: the WITHIN-GROUP order for the Pinned section's "group by folder"
   *  view — a separate store from `pinnedAt` so the two modes keep independent
   *  arrangements (switching modes never resets either). Keyed by folder path →
   *  an ordered list of item keys (`f:<folder>` for the folder itself, `n:<folder>:<id>`
   *  for a note). Items not listed sort after, by pin order; new pins append. */
  folderPanelGroupItemOrder: Record<string, string[]>;
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
  /** 0.272.0: ordered list of quick-action ids shown in the per-note star menu
   *  (a short, user-curated menu that sits before the full ⋮ menu). Empty hides
   *  the star button entirely. Ids are QUICK_ACTION keys. */
  quickMenuActions: string[];
  /** 0.272.1: append a "More commands…" escape hatch (opens the full ⋮ menu) to
   *  the quick menu. A separate boolean rather than a catalog id so it defaults
   *  on for existing installs without a migration. */
  quickMenuIncludeMore: boolean;
  /** 0.269.0: when a Stashpad note is opened in an ordinary editor tab — the
   *  quick switcher, a wikilink, the file explorer — close that tab and show
   *  the note inside Stashpad instead. Off by default: it changes what a very
   *  ordinary action does, so it has to be chosen. */
  openNotesInStashpad: boolean;
  debugTrace: boolean;
  /** 0.268.18: mirror the trace to disk so it survives a crash or force-quit.
   *  OFF by default — see the comment on the default below. */
  debugTracePersist: boolean;
  /** 0.255.0: epoch ms when a diagnostic mode was last switched ON, so it can
   *  expire itself if forgotten. 0 = off / never stamped. Both diagnostics
   *  cost something continuously (perf profiling accumulates timing; the debug
   *  trace runs a two-second rAF scroll watch after several common actions),
   *  and a mode left on for months is pure cost with no one reading it. */
  diagnosticsEnabledAt: { perf: number; trace: number };
  /** 0.83.1: maintain the redundant `parentLink`/`children` recovery
   *  fields on every move. Default true. Turning it off skips those writes
   *  entirely — a big speedup on slow/network drives (each is a full
   *  round-trip and a move triggers several); Rebootstrap backfills them on
   *  demand, and the canonical id/parent is unaffected. */
  writeRecoveryLinks: boolean;
  useTemplatesFormat: boolean;
  /** 0.278.0 — modifier gesture that adds each note's timestamp when copying.
   *  Stored as a canonical `+`-joined subset of "mod"/"ctrl"/"alt"/"shift"
   *  (see COPY_TS_MODIFIER_ORDER); empty string = off (copies never include
   *  timestamps). Replaces the old boolean `prefixTimestampsOnCopy` toggle. */
  copyTimestampModifiers: string;
  /** 0.279.4 — when copying a subtree (Copy tree / Copy focused subtree), prefix
   *  each line with a `[L<n>]` DEPTH MARKER (relative to the copied root: the
   *  root(s) = L1, their children L2, …) instead of relying on leading
   *  indentation, which many apps strip on paste. See docs/public/level-markers.md
   *  — the "Stashpad level-marker copy" convention. */
  copyTreeLevelMarkers: boolean;
  /** 0.282.0 (teams): show "similar notes" as you type in the composer (Sift over
   *  titles), so you notice a possible duplicate before creating one. Desktop is
   *  live; mobile gates it behind a per-session composer toggle (off by default). */
  duplicateHints: boolean;
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
  /** 0.214.2: stamp the cross-vault payload on EVERY cut/copy again (pre-0.214.0
   *  behaviour). Off by default because building it reads every note and
   *  attachment in the selection, which is slow on a big selection or a network
   *  drive. On a fast machine that cost is unnoticeable and always-on is more
   *  convenient than remembering the explicit command. */
  alwaysStampCrossVault: boolean;
  /** 0.215.0: set once the one-shot "automatic link updating is off" notice has
   *  been shown, so it never nags. The settings warning stays regardless. */
  /** 0.246.0: retained so an existing vault's saved value loads without a
   *  schema mismatch, but NO LONGER READ — the link-update reminder recurs for
   *  as long as the setting is off rather than firing once. Safe to drop in a
   *  future cleanup once no installed build still writes it. */
  linkUpdateWarningShown: boolean;
  /** 0.215.0: where NEW attachments are written.
   *  - "per-folder" (default): `<stashpadFolder>/_attachments` — today's behaviour.
   *  - "universal": one folder for every Stashpad, `attachmentUniversalFolder`.
   *  - "obsidian": wherever Obsidian's own attachment setting points.
   *  Only affects attachments added from now on; existing files stay put. */
  attachmentLocation: "per-folder" | "universal" | "obsidian";
  /** Destination for attachmentLocation === "universal". */
  attachmentUniversalFolder: string;
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
  // (0.135.0: encryptionIdleLockMinutes removed — idle auto-lock is gone.
  //  0.137.1: encryptTrashFollowObsidian + hideLockedTitles removed — trash
  //  handling and filename-hiding are per-folder (folderEncPrefs) now. Stale
  //  values in an existing data.json are simply ignored.)
  /** 0.124.1: one-time migration marker — the default "Toggle task" hotkey
   *  changed from H to G. Existing installs persist the full bindings map, so
   *  the default change alone wouldn't reach them; on first load we flip a
   *  still-default `H` to `G` once, then set this so it never re-flips (the user
   *  can rebind to H afterwards and it sticks). */
  migratedToggleTaskG: boolean;
  /** 0.136.0: one-time move of legacy dedicated-archive folders' notes into
   *  each folder's own `archive/` subfolder (per-folder archive overhaul). */
  migratedArchiveToSubfolders: boolean;
  /** 0.137.0: one-time move of _deleted/ encrypted-trash blobs into each
   *  origin folder's own trash/ subfolder (per-folder trash overhaul). */
  migratedTrashToSubfolders: boolean;
  /** 0.138.0 (smart re-encrypt sweep): subtrees that WERE encrypted and got
   *  unlocked back to plaintext (ad-hoc unlock or restore-from-trash).
   *  Unlimited — the "Previously encrypted" review view manages it. `removed`
   *  entries live in that view's "Removed from watchlist" section (a
   *  recoverable dismissal, not a delete). */
  reEncryptWatch: ReEncryptWatchEntry[];
  /** 0.138.0: on startup, if the watchlist has active entries, show a Notice
   *  with a Review button that opens the review view. Default OFF. */
  reEncryptNudge: boolean;
  /** 0.139.0 (peek): GLOBAL auto-re-encrypt idle delay (minutes). After a
   *  previously-encrypted note has been unlocked + idle this long, a cancellable
   *  countdown re-locks it. 0 = OFF (default). Per-folder / per-note override. */
  reEncryptAfterMin: number;
  /** 0.137.3: settings write generation for the multi-writer collision guard
   *  (see guardedSave in main.ts). Bumped on every save; a save that sees a
   *  HIGHER rev on disk knows another instance/machine wrote since. */
  settingsRev?: number;
  /** 0.125.1: quick relative time-adjust presets shown in the due-date / snooze
   *  picker (e.g. ["5m","15m","1h","1d"]). A +/- flip toggles add vs subtract. */
  dueQuickAdjusts: string[];
  /** 0.276.0: tags offered in the due/assign picker. `taskTagChips` are shown as
   *  one-tap quick chips; `taskTagSuggestions` (plus the chips) feed the
   *  type-to-add autocomplete. Both are plain tag names (no leading #). */
  taskTagChips: string[];
  taskTagSuggestions: string[];
  /** 0.276.0: log when a Stashpad note is opened, so the activity heatmap can
   *  show a "Viewed" bucket. Off by default — opens are frequent and would grow
   *  the action log noticeably; only turn on if you want view tracking. */
  logNoteOpens: boolean;
  /** 0.276.10: companion/sidecar file extensions (leading dot) that Stashpad
   *  should encrypt ALONGSIDE a note when locking it, so plaintext history left
   *  by other plugins doesn't linger. Default [".edtz"] (Edit History plugin).
   *  See docs/security-findings.md (2026-08-29). The packaging/restore change
   *  that consumes this is the focused next step; the setting is groundwork. */
  encryptCompanionExts: string[];
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
  /** 0.174.0: when ON, clicking a folder (folders panel, folder switcher,
   *  file-explorer "Open folder in Stashpad") always opens it in a NEW tab at the
   *  home note instead of reusing/revealing an already-open tab — and the folder
   *  switcher drops its "Reveal <folder> tab" (reuse) option. */
  foldersAlwaysNewTab: boolean;
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
  /** 0.283.0 (teams): desktop/in-app notifications when SOMEONE ELSE creates a
   *  note (their author id != yours). Default on. */
  teamNotifications: boolean;
  /** Use OS desktop notifications (Notification API) in addition to the in-app
   *  toast. Default on; falls back to the toast if permission is denied. */
  teamNotificationsDesktop: boolean;
  /** Only notify for these folders (empty = every Stashpad folder). The "watch"
   *  list — livestream someone working in a specific place. */
  watchedFolders: string[];
  /** Never notify for these author ids / folder names — the mute list. */
  mutedAuthors: string[];
  mutedFolders: string[];
  showAuthor: boolean;
  showContributors: boolean;
  showLastEdit: boolean;
  /** 0.279.7 — render author/contributor names in the note footer as clickable
   *  links (opening the author file) vs plain text. Default OFF (plain text):
   *  clickable names steal taps, e.g. the second tap of a double-tap to enter a
   *  just-unblurred note lands on the author link and opens it instead. */
  authorNamesAsLinks: boolean;
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
  /** 0.193.0: when a submission's every non-empty line is a checkbox ("- [ ] a" /
   *  "[x] b"), treat it as a task LIST and split it into one task per line, even if
   *  split-on-lines is off. Pasting a checklist is the common case and one giant note
   *  full of checkbox text is almost never what's wanted. On by default. */
  splitCheckboxLines: boolean;
  /** 0.222.0: typing `+` alone into an empty composer opens the note picker and
   *  binds an append target. Off = `+` is just a character (markdown `+ ` list
   *  bullets keep working with no dismiss step). */
  composerAppendTrigger: boolean;
  /** 0.234.0: clicking an image attachment opens the media viewer instead of a
   *  new tab. Off restores the pre-0.234 behaviour exactly. */
  mediaViewerOnClick: boolean;
  /** 0.235.0: how a note's attachment rail lays out. "auto" picks from the file
   *  mix and the rail's measured width. */
  attachmentRailMode: "auto" | "thumbnail" | "compact" | "filename";
  /** 0.245.0: extensions that must NEVER open in the media viewer. Inverted
   *  from 0.244.0's include-list — see the comment on viewerHandles. The old
   *  `mediaViewerExtensions` key is deliberately dropped rather than migrated:
   *  reading an include list as an exclude list would do exactly the wrong
   *  thing to every type in it. */
  mediaViewerExcludedExtensions: string;
  /** 0.245.0: open the viewer for file types it cannot render either. Off by
   *  default — a card is a weaker answer than the real app for, say, a .docx,
   *  so this is opt-in. Note that even when off, an unrenderable file still
   *  opens the viewer if a SIBLING attachment on the same note is renderable. */
  mediaViewerAllFileTypes: boolean;
  /** 0.237.0: re-blur an obscured note when you navigate away or reload.
   *  On = Signal-like (reveal is momentary). Off = revealing sticks for the
   *  session. */
  obscureReHides: boolean;
  /** 0.267.0: obscure EVERY note, in every folder, regardless of the per-note
   *  flag. A panic switch rather than a preference — for handing someone your
   *  screen, or working somewhere overlooked. Individual notes can still be
   *  revealed by tapping; the setting governs the resting state. */
  obscureAll: boolean;
  /** 0.267.0: folders whose notes are obscured by default, keyed by cleaned
   *  folder path. A per-folder answer, because "hide my journal" and "hide
   *  nothing in my work notes" are both reasonable at once. An explicit
   *  per-note `obscured` value still wins — see isObscured for the precedence
   *  and why it is written down. */
  obscureFolders: Record<string, boolean>;
  /** 0.267.8: does the global cover travel between devices, or stay on the one
   *  you flipped it on?
   *
   *  "device" by default. The switch is about the SCREEN in front of you —
   *  someone is looking over your shoulder, or you are handing your phone
   *  across — and that is not a fact about the vault. Synced, covering your
   *  phone would also cover a desktop nobody is standing near, and worse,
   *  uncovering on that desktop later would uncover the phone.
   *
   *  Some people do want it vault-wide (cover everything, everywhere, then put
   *  all the devices down), hence the choice rather than a hardcoded answer. */
  obscureAllScope: "device" | "synced";
  /** 0.267.12: how a covered note is drawn.
   *
   *  "blur" keeps the shape of the text, which reads as "something is here,
   *  hidden". "solid" paints a bar over it — cheaper AND hides more, since a
   *  blur still leaks word shapes and lengths, and short text is guessable
   *  from those. Blur is the default only because it is what the feature has
   *  always looked like. */
  obscureStyle: "blur" | "solid";
  /** 0.279.17 — scheduled obscuring. When enabled, a folder set to
   *  "obscure by default" only obscures DURING the daily window
   *  [start, end) in LOCAL time; outside it (e.g. at home / off-hours) the folder
   *  stays clear. The schedule only adds a "when" to folders already set to
   *  obscure — it never obscures a folder that isn't. Per-note explicit obscure
   *  and the global "obscure everything" switch are unaffected. Hours are 0–23;
   *  end < start means an overnight window (e.g. 22→6). Because the window is
   *  local, it re-evaluates on a timezone change (travel), which is the point. */
  obscureScheduleEnabled: boolean;
  obscureScheduleStart: number;
  obscureScheduleEnd: number;
  /** 0.279.21 — IANA timezone the schedule's hours are anchored to (your HOME
   *  zone), e.g. "America/Chicago". Empty = the device's current local zone. Set
   *  it (with the "Use current" button) to keep the window in home time as you
   *  travel, instead of drifting with wherever the device is. */
  obscureScheduleTimezone: string;
  /** 0.279.24 — recently-used home timezones (most-recent first), shown as chips
   *  so an accidental "Use current" can be undone by picking a previous zone.
   *  Also accrues zones the device has actually been in (the schedule timer
   *  records a new one on a tz change). */
  obscureScheduleTimezoneHistory: string[];
  /** 0.279.31 — desktop: select text inside note bodies. ON makes the body
   *  selectable and moves row dragging to the grip handle; OFF restores
   *  drag-from-anywhere-on-the-row (no text selection). Desktop only. */
  selectableNoteText: boolean;
  /** 0.268.2: put the file's name in front of the link when you attach one.
   *
   *  On by default. An attachment on its own is a link and nothing else, so the
   *  note reads as blank in the list and sorts under a name derived from the
   *  file path rather than anything you chose. The name in front gives the note
   *  something to say and something to search for. */
  attachmentNamePrefix: boolean;
  /** 0.268.2: attach files as an EMBED (`![[x]]`) rather than a plain link
   *  (`[[x]]`). On by default, which is the existing behaviour. Off suits
   *  people who want a list of files rather than a wall of previews. */
  attachmentsEmbedded: boolean;
  /** 0.268.3: show the notes THIS note links to, under the attachment rail.
   *  Off by default — it is useful for a hub note and noise for everything
   *  else, and a capture-first list should stay quiet unless asked. */
  railShowOutgoing: boolean;
  /** 0.268.3: show the notes that link TO this one. Off by default, and
   *  separately from outgoing, because "what does this point at" and "who
   *  cares about this" are different questions and people want them at
   *  different times. */
  railShowBacklinks: boolean;
  /** 0.237.0: render ||spoiler|| in note bodies as blurred-until-tapped. */
  spoilerMarkup: boolean;
  /** 0.238.0: bulk recolour from the colour-alias swatch applies to EVERY
   *  Stashpad rather than only the one selected. Off by default — a vault-wide
   *  write should be opted into, not stumbled into. */
  bulkRecolorAllFolders: boolean;
  autoNavOnMoveIn: boolean;
  /** 0.191.0: after moving/nesting a note INTO another note, open that destination
   *  parent in a BACKGROUND Stashpad tab — so the note's new home is one click away
   *  without yanking you out of what you were doing. Distinct from autoNavOnMoveIn,
   *  which drills the CURRENT view into the parent (and steals your place). On by
   *  default; skipped when the destination is Home/root or already open in a tab. */
  openParentTabOnMoveIn: boolean;
  /** 0.199.0: route every "open in a new tab" Stashpad performs through a
   *  BACKGROUND tab — the tab opens, but focus stays where you are. Covers
   *  folder opens, note/attachment "open in new tab", reminder clicks,
   *  aggregate/tasks/trash views, deep links. Off by default. */
  newTabsInBackground: boolean;
  /** 0.199.2: composer/edit textareas auto-close `[[` with `]]` and type-over
   *  an existing closing bracket. On by default. */
  autoPairBrackets: boolean;
  /** 0.207.0: line-number gutter beside the edit/split editor (desktop). */
  showEditorLineNumbers: boolean;
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
  /** 0.270.2: how much a pin outranks the filters. Applies to BOTH pin kinds
   *  (the list pin and the sidebar pin).
   *    "all"  — a pinned note is never hidden by any filter (default).
   *    "time" — a pinned note survives the TIME filter, but the content filters
   *             (tag / colour / author / hide-completed / attachments-only /
   *             imported-only) still hide it if it does not match.
   *    "none" — pins get no special treatment; filters hide them like any note.
   *  Replaced the 0.270.1 boolean `pinnedIgnoreFilters` (true -> "all",
   *  false -> "none"); that key is migrated on load. */
  pinnedFilterMode: "all" | "time" | "none";
  /** 0.276.2: when a pinned note survives a filter, also keep its whole subtree
   *  (all descendants) visible, so the pinned note isn't shown empty. Off by
   *  default. No effect when pinnedFilterMode is "none". */
  pinnedChildrenPersist: boolean;
  /** Notification history buffer cap. 0 or negative = unlimited.
   *  Default 5000. Persisted alongside the live history in
   *  `<pluginDir>/notifications.json`. */
  notificationHistoryLimit: number;
  /** Keys (`<id>@<dueRaw>`) of task due-reminders already fired, so they don't
   *  re-fire on every launch. Bounded; pruned when it grows. */
  notifiedDueKeys: string[];
  /** 0.211.6 (L6): vault names the user has accepted a cross-vault clipboard payload
   *  from. The payload is just HTML on the system clipboard, so ANY web page can craft
   *  one and set `sourceVault` to whatever it likes — including the user's own vault
   *  name. The first paste from a given name asks for confirmation; later ones don't. */
  trustedXvSources: string[];
  /** 0.140.0: last-fired ms per task id for PERSISTENT reminders (`remindEvery`)
   *  — so a persistent task re-notifies on its interval, not once. */
  persistReminderLog?: Record<string, number>;
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
  /** 0.223.0: per-folder append target (frontmatter id) that rides along with
   *  the draft, so binding a target then reloading doesn't silently turn the
   *  append into a new note. Cleared whenever the target is cleared. */
  draftAppendTargets: Record<string, { id: string; label?: string; path: string; folder: string; mode: "append" | "prepend" }>;
  /** Per-folder: the text most recently sent via Enter, used to suppress
   *  the "restore draft" suggestion if the saved draft happens to match. */
  lastSubmitted: Record<string, string>;
}

export const DEFAULT_SETTINGS: StashpadSettings = {
  folder: "Stashpad",
  onboardingAnswered: false,
  onboardingChoice: null,
  lastUsedFolder: "",
  recentFolders: [],
  importDropFolder: "",
  exportFolder: "_exports",
  autoImport: false,
  inheritObsidianExclusions: true,
  folderPanelPinnedFraction: 0.5,
  folderPanelPinned: [],
  folderPanelPinnedAt: {},
  folderPanelGroupItemOrder: {},
  folderPanelDownranked: [],
  folderPanelHidden: [],
  folderPanelPinnedGrouping: "pin-order",
  enablePerfProfiling: false,
  diagnosticsEnabledAt: { perf: 0, trace: 0 },
  quickMenuActions: ["copy", "move", "blur", "largeText"],
  quickMenuIncludeMore: true,
  openNotesInStashpad: false,
  debugTrace: false,
  // 0.268.18: OFF. Persistence was added for a bug thought to hang the app,
  // where a force-quit would take the only copy of the trace with it. That
  // turned out not to be the fault, and meanwhile leaving the trace on meant a
  // localStorage stamp every 250ms and a file write every second, indefinitely,
  // on the user's disk. A capability worth having for a crash is not worth
  // paying for continuously, so it is now asked for rather than assumed.
  debugTracePersist: false,
  writeRecoveryLinks: true,
  slashCommands: true,
  linkPreviewCallout: "info",
  linkPreviewDelayMs: 300,
  linkPreviewAuto: false,
  linkPreviewCollapsed: false,
  useTemplatesFormat: false,
  copyTimestampModifiers: "",
  copyTreeLevelMarkers: false,
  duplicateHints: true,
  splitOnLines: false,
  splitMode: "lines",
  confirmCrossParentDrag: true,
  confirmBulkDelete: true,
  confirmAttachmentDelete: true,
  alwaysStampCrossVault: false,
  linkUpdateWarningShown: false,
  attachmentLocation: "per-folder",
  attachmentUniversalFolder: "Attachments",
  autofocusComposerAfterSend: true,
  focusComposerOnOpen: false,
  searchOpensInContext: true,
  popoutDuplicates: true,
  encryption: defaultEncryptionConfig(),
  encryptTrash: false,
  encryptTrashFilenames: false,
  migratedToggleTaskG: false,
  migratedArchiveToSubfolders: false,
  migratedTrashToSubfolders: false,
  reEncryptWatch: [],
  reEncryptNudge: false,
  reEncryptAfterMin: 0,
  dueQuickAdjusts: ["5m", "15m", "30m", "1h", "1d", "1w"],
  taskTagChips: [],
  taskTagSuggestions: [],
  logNoteOpens: false,
  encryptCompanionExts: [".edtz"],
  archiveFolders: [],
  folderEncPrefs: {},
  folderIcons: {},
  folderSwitcherIncludePinned: false,
  foldersAlwaysNewTab: false,
  importExcludePrefixes: "_",
  lockedSubtrees: [],
  searchOpensInNewTab: true,
  pinnedNotes: [],
  hideMobileToolbarInStashpad: true,
  slugStopWords: [],  // empty → DEFAULT_STOPWORDS used at runtime
  searchIncludedFolders: [],
  searchExcludedFolders: [],
  shortcuts: { move: "M", pickMove: "O", merge: "&", copy: "C", copyTree: "Y", openEditor: "Mod+Shift+E", openTab: "T", split: "S", edit: "E", editParent: "Shift+E", copyOutline: "L" },
  mod: {
    toggleSplit: "Mod+/", pickDestination: "Mod+D", search: "Mod+F",
    delete: "Mod+Backspace", undo: "Mod+Z", redo: "Mod+Shift+Z",
    toggleComplete: "Mod+Enter",
    moveUp: "Mod+ArrowUp", moveDown: "Mod+ArrowDown",
    moveToTop: "Mod+Shift+ArrowUp", moveToBottom: "Mod+Shift+ArrowDown",
    outdent: "Mod+[",
    setColor: "Shift+:",
    focusList: "Mod+Shift+L",
    toggleObscured: "",
  },
  customPalette: [],
  colorAliases: {},
  noteTemplates: {},
  authorName: "",
  authorId: "",
  authorRole: "",
  authorDepartment: "",
  teamNotifications: true,
  teamNotificationsDesktop: true,
  watchedFolders: [],
  mutedAuthors: [],
  mutedFolders: [],
  showAuthor: true,
  showContributors: true,
  showLastEdit: true,
  authorNamesAsLinks: false,
  viewModes: {},
  includeAttachmentsInEverything: {},
  hideChildlessNotes: {},
  hideCompletedNotes: {},
  attachmentsOnlyNotes: {},
  mutedNotificationCategories: [],
  notificationHistoryLimit: 5000,
  notifiedDueKeys: [],
  trustedXvSources: [],
  splitCheckboxLines: true,
  composerAppendTrigger: true,
  mediaViewerOnClick: true,
  attachmentRailMode: "auto",
  mediaViewerExcludedExtensions: "",
  mediaViewerAllFileTypes: false,
  obscureReHides: true,
  obscureAll: false,
  obscureFolders: {},
  obscureAllScope: "device",
  obscureStyle: "blur",
  obscureScheduleEnabled: false,
  obscureScheduleStart: 9,
  obscureScheduleEnd: 17,
  obscureScheduleTimezone: "",
  obscureScheduleTimezoneHistory: [],
  selectableNoteText: true,
  attachmentNamePrefix: false, // 0.279.1: default OFF — undoes the 0.268.2 filename prefix (user: "we'll survive without the clutter")
  attachmentsEmbedded: true,
  railShowOutgoing: false,
  railShowBacklinks: false,
  spoilerMarkup: true,
  bulkRecolorAllFolders: false,
  autoNavOnMoveIn: false,
  openParentTabOnMoveIn: true,
  newTabsInBackground: false,
  autoPairBrackets: true,
  showEditorLineNumbers: true,
  autoNavOnMoveOut: false,
  pinnedFilterMode: "all",
  pinnedChildrenPersist: false,
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
  draftAppendTargets: {},
  lastSubmitted: {},
  bindings: buildDefaultBindings(),
};

let current: StashpadSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
const listeners = new Set<(sig: string) => void>();

export function getSettings(): StashpadSettings { return current; }

/** 0.279.17: is NOW inside the daily obscure window [start, end) in LOCAL time?
 *  start === end → never (degenerate/empty window); end < start → overnight
 *  window (e.g. 22→6). Used by isObscured() to gate per-folder obscure defaults,
 *  and by the plugin's minute timer to refresh views when the window flips. */
export function isWithinObscureSchedule(
  s: Pick<StashpadSettings, "obscureScheduleStart" | "obscureScheduleEnd" | "obscureScheduleTimezone">,
  now: Date = new Date(),
): boolean {
  const h = currentHourInTz(s.obscureScheduleTimezone, now);
  const start = Math.max(0, Math.min(23, s.obscureScheduleStart));
  const end = Math.max(0, Math.min(24, s.obscureScheduleEnd));
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end; // overnight
}

/** Fractional current hour (0–24) in an IANA timezone; falls back to device local
 *  time when the tz is empty or invalid. 0.279.21 */
function currentHourInTz(tz: string | undefined, now: Date): number {
  const local = now.getHours() + now.getMinutes() / 60;
  if (!tz) return local;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    const hh = Number(parts.find((p) => p.type === "hour")?.value);
    const mm = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return local;
    return (hh % 24) + mm / 60; // "24:00" midnight → 0
  } catch {
    return local; // invalid tz id → device local
  }
}
/** 0.268.13: keys whose change cannot affect how a list RENDERS.
 *
 *  A settings save broadcasts to every open view and each one re-rendered
 *  unconditionally. A trace from a real session showed 21 views repainting on a
 *  single save — two of them 714 and 341 rows — for a composer DRAFT, which is
 *  the most frequent write there is: it fires as you type.
 *
 *  The list is deliberately tiny and the default is to re-render. An unknown key
 *  changing still repaints everything, so the failure mode of this optimisation
 *  is "no faster", never "stale UI". Drafts are safe to skip because the
 *  listener syncs the composer's text directly and reports whether it did. */
const RENDER_IRRELEVANT_KEYS: ReadonlySet<string> = new Set([
  "drafts", "lastSubmitted", "draftAppendTargets",
  "notifiedDueKeys", "persistReminderLog", "settingsRev",
  // 0.292.0 (perf): device-local MRU state. Neither key is read by any render
  // path — the only consumers are main.ts `recordFolderUsed` (the writer),
  // `quickDestinationFolders` (built on demand when the quick-destination menu
  // OPENS, never during a list render) and the launch-folder lookup at
  // main.ts:5639. `recordFolderUsed` fires on the active-leaf-change firehose,
  // so before this every tab switch full-rendered every open leaf.
  "lastUsedFolder", "recentFolders",
  // 0.292.0 (perf): per-folder Record<folder, …> filter/mode state. Each is read
  // during render, but ONLY by views on that same folder — a leaf on another
  // folder cannot be affected, and previously every one of them repainted.
  // Every setter lives in view.ts (setViewMode / setIncludeAttachments /
  // setEncryptionFilter / setHideChildless / setHideCompleted /
  // setAttachmentsOnly); each call site already repaints ITS OWN view
  // (render() / refreshList()), and each setter now also calls
  // `refreshFolderPeers()` so a second tab on the SAME folder still updates.
  // None of these has a settings-tab control, so no settings-tab toggle relies
  // on the broadcast to repaint a list.
  "viewModes", "includeAttachmentsInEverything", "encryptionFilter",
  "hideChildlessNotes", "hideCompletedNotes", "attachmentsOnlyNotes",
  // DELIBERATELY NOT EXCLUDED: `pinnedFilterMode`. It is a single GLOBAL scalar
  // read by every view's render, and it has a settings-tab dropdown that relies
  // on the broadcast to repaint open lists. It also changes rarely (an explicit
  // user toggle), so it is not part of the churn this is fixing.
]);

/** 0.292.0 (perf): the render-relevant key list, cached across calls. The keys
 *  of the settings object are fixed once loaded, so re-sorting ~94 strings on
 *  every save was pure waste. Guarded on key COUNT so a shape change (a
 *  migration adding a key mid-session) still rebuilds — an unknown key must
 *  never be silently dropped from the signature. */
let sigKeysCache: string[] | null = null;
let sigKeysShape = "";

function renderSignature(s: StashpadSettings): string {
  const bag = s as unknown as Record<string, unknown>;
  const all = Object.keys(bag);
  // Keyed on the joined key list, not just its length: a same-size shape change
  // (one key dropped, another added) must rebuild too. Still one cheap join vs
  // the sort + ~94 stringifies it replaces.
  const shape = all.join(" ");
  if (!sigKeysCache || sigKeysShape !== shape) {
    sigKeysCache = all.filter((k) => !RENDER_IRRELEVANT_KEYS.has(k)).sort();
    sigKeysShape = shape;
  }
  const parts: string[] = [];
  for (const k of sigKeysCache) {
    try { parts.push(`${k}=${JSON.stringify(bag[k])}`); } catch { parts.push(`${k}=?`); }
  }
  return parts.join("|");
}

/** 0.292.0 (perf): monotonic counter used to make a forced signature unique. */
let forceTick = 0;

/** @param force  Bypass the signature comparison and repaint every open view.
 *  Needed on the SYNC adoption path (`onExternalDataJsonChange`): another device
 *  can change an excluded per-folder key, and no local setter runs to repaint
 *  it, so the signature alone would leave the list stale. */
export function setSettings(next: StashpadSettings, force = false): void {
  current = next;
  // Computed ONCE per save and handed to every listener. Per-view computation
  // would repeat this work for each open view, which is the cost being removed.
  const sig = force ? `${renderSignature(next)}|force=${++forceTick}` : renderSignature(next);
  for (const fn of listeners) fn(sig);
}
export function onSettingsChange(fn: (sig: string) => void): () => void {
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
  | "organizationSystems" | "maintenance" | "diagnostics" | "hotkeys"
  | "help";
export const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = ([
  { id: "foldersStorage", label: "📁 Folders & Storage" },
  // Every plugin should answer "what does this do and how do I use it" without
  // the user leaving Obsidian. Stashpad had no such section at all until
  // 0.208.0 — no feature list, no command list, no version, no links.
  { id: "help",           label: "❓ Help & Getting started" },
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
    // 0.268.7 diagnostic: the base `update()` calls this on every declarative
    // re-render, so the CALL RATE is the thing worth seeing. One line per open
    // is normal; a burst of them means something is driving update() in a loop
    // (see refreshSettingsIfStashpadsChanged in main.ts), which is the shape a
    // frozen settings window would have.
    const t0 = performance.now();
    const defs = this.buildSettingDefinitions();
    this.plugin.trace("settings:defs", { ms: Math.round(performance.now() - t0) });
    return this.instrumentDefs(defs, "");
  }

  /** 0.268.14: time EVERY settings item, not just the Hotkeys rows.
   *
   *  Hotkeys was instrumented alone because that was the reported symptom, and
   *  it came back innocent — 2-5ms, every time. Which leaves the possibility
   *  that the expensive thing is on another page, or in a page's own display(),
   *  and the trace simply had nothing to say about it. Wrapping centrally here
   *  covers every section without touching each renderer.
   *
   *  Timings aggregate per page and flush as ONE line per burst, so coverage
   *  goes up without the line count following it. */
  private instrumentDefs(items: SettingDefinitionItem[], path: string): SettingDefinitionItem[] {
    return items.map((it) => {
      const raw = it as unknown as Record<string, unknown>;
      const name = typeof raw.name === "string" ? raw.name : "?";
      const here = path ? `${path} › ${name}` : name;
      const out: Record<string, unknown> = { ...raw };

      if (typeof raw.render === "function") {
        const orig = raw.render as (s: Setting) => void;
        out.render = (s: Setting): void => {
          const t0 = performance.now();
          try { orig.call(this, s); }
          catch (e) {
            // 0.268.17: contain a row that throws.
            //
            // An exception here escaped into Obsidian's page builder, which
            // abandoned the rest of the page AND left the settings navigation
            // dead — after opening Hotkeys, no other section could be clicked.
            // One unrenderable row is a bad row; it is not a reason to lose the
            // whole settings window, and the containment costs nothing.
            //
            // Traced with the item's name, so the next occurrence identifies
            // itself instead of needing another round of instrumentation.
            this.plugin.trace("settings:item-error", {
              page: path || name, item: name,
              err: (e as Error)?.message ?? String(e),
            });
            try { s.setName(name); s.setDesc("This setting could not be displayed. See the debug trace."); } catch { /* last resort */ }
          }
          finally { this.noteItemRender(path || name, performance.now() - t0); }
        };
      }
      if (Array.isArray(raw.items)) {
        out.items = this.instrumentDefs(raw.items as SettingDefinitionItem[], here);
      }
      if (typeof raw.page === "function") {
        const origPage = raw.page as () => { display?: () => void };
        out.page = (): unknown => {
          // A page builds lazily on navigation, and its display() is where an
          // imperative tab does all its work — the begin/end pair is what makes
          // "opened this page, never finished" readable after a force-quit.
          this.plugin.trace("settings:page-begin", { page: here });
          const p = origPage.call(this);
          const disp = p?.display;
          if (typeof disp === "function") {
            p.display = (): void => {
              this.plugin.trace("settings:page-display-begin", { page: here });
              const t0 = performance.now();
              try { disp.call(p); }
              finally {
                this.plugin.trace("settings:page-display", { page: here, ms: Math.round(performance.now() - t0) });
              }
            };
          }
          return p;
        };
      }
      return out as unknown as SettingDefinitionItem;
    });
  }

  private buildSettingDefinitions(): SettingDefinitionItem[] {
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
      case "help": return this.helpItems();
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

  /** Help & Getting started (0.208.0).
   *
   *  Answers "what is this / how do I start / what can it do" in-app. Derived
   *  from source wherever possible — the command list comes from COMMAND_META
   *  and the version from manifest.json — so it can't silently drift as
   *  features land. When you add a command or a known issue elsewhere, it
   *  shows up (or should be added) here in the same change. */
  private helpItems(): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [];

    items.push(this.sectionDef("What this plugin is", "", (host) => {
      host.createEl("p", {
        text:
          "Stashpad turns a folder in your vault into a chat-style outliner: type a line, it becomes " +
          "a note; nest notes under each other to build a tree you can drill into.",
      });
      // This definition used to exist ONLY inside the Cross-Stashpad Search
      // Scope section, and only while you had zero Stashpads — i.e. it vanished
      // exactly when someone might come looking for it. It belongs here.
      host.createEl("p", {
        text:
          "A \"Stashpad\" is just a folder that contains a Stashpad-shaped note — one whose frontmatter " +
          "has both an `id` and a `parent`. There's no database and no registry: the notes are ordinary " +
          "markdown, and a folder stops being a Stashpad when those notes are gone. You can have as many " +
          "as you like.",
      });
    }, ["what", "intro", "getting started", "concept", "explain"]));

    items.push(this.renderDef(
      "Getting started",
      "Reopen the welcome walkthrough — name a folder, start fresh, or load example content.",
      (s) => s.addButton((b) => b.setButtonText("Open welcome").onClick(() => this.plugin.showWelcome())),
      ["welcome", "onboarding", "tutorial", "start", "help"],
    ));

    items.push(this.renderDef(
      "Example content",
      "Create a new folder of realistic example notes (a trip, a reading list, a few tasks) to see how nesting works. They're normal notes — delete them whenever.",
      (s) => s.addButton((b) => b.setButtonText("Create demo Stashpad").onClick(() => { void this.plugin.createDemoStashpad(); })),
      ["demo", "example", "sample", "try"],
    ));

    items.push(this.headingDef("✨ Features"));
    items.push(this.sectionDef("", "", (host) => {
      const ul = host.createEl("ul");
      for (const line of [
        "Chat-style composer — type a line, press Enter, it's a note.",
        "Nesting without limits: drill into any note and add notes under it.",
        "Tasks with due dates and reminders (start a line with []). Recurring tasks are experimental — see Known limitations.",
        "Move, merge, clone, and reorder notes from the keyboard.",
        "Per-folder colors, filters, and saved sort orders.",
        "Import from and export to plain markdown, plus a portable .stash bundle.",
        "Optional per-folder encryption for notes you'd rather not leave in plaintext.",
        "Sidebar panels: folders, a detail pane, and aggregate archive/trash views.",
      ]) ul.createEl("li", { text: line });
    }, ["features", "what can it do"]));

    items.push(this.headingDef("⌨️ Commands"));
    items.push(this.sectionDef("", "", (host) => {
      host.createEl("p", {
        cls: "setting-item-description",
        text:
          "Every command below is in the command palette (search \"Stashpad\") and can be given a hotkey " +
          "in the Hotkeys tab. The chord shown is Stashpad's own in-view default.",
      });
      const ul = host.createEl("ul");
      for (const m of COMMAND_META) {
        const li = ul.createEl("li");
        li.createSpan({ text: m.label });
        if (m.defaultPrimary) li.createEl("code", { text: ` ${m.defaultPrimary}` });
        li.createSpan({ cls: "stashpad-help-cmd-desc", text: ` — ${m.desc}` });
      }
    }, ["commands", "hotkeys", "shortcuts", "keyboard"]));

    items.push(this.headingDef("⚠️ Known limitations"));
    items.push(this.sectionDef("", "", (host) => {
      const ul = host.createEl("ul");
      for (const line of [
        "Requires Obsidian 1.13.0 or newer.",
        "Recurring tasks are EXPERIMENTAL. Repeat rules work, but they are not thoroughly tested across time zones, missed occurrences, or multi-device sync. Don't rely on them for anything with real consequences — keep a reminder you trust for deadlines that matter. A one-off due date and reminder is the well-trodden path.",
        "Very large folders (many thousands of notes in one Stashpad) can be slow to first paint; the render cache warms after the first visit.",
        "Encryption protects note contents at rest in your vault — it is not a substitute for full-disk encryption or a password manager.",
        "Encryption locks a note's FILE on disk (into a .stashenc bundle); it is NOT a “decrypted-in-RAM-only” model. So while a note is plaintext — before you lock it, or after you unlock it — other software may keep plaintext copies that Stashpad can't reach: Obsidian's File Recovery snapshots and Sync version history, other plugins' sidecar files (e.g. the Edit History plugin's .edtz), and OS-level backups (Time Machine, etc.). Encrypting a note does not retroactively purge those. Treat encryption as protecting a locked note going forward, not as guaranteeing no plaintext trace ever existed.",
        "Mobile supports the core outliner, but some desktop-only affordances (drag-to-reorder, pop-out windows) differ or are unavailable.",
      ]) ul.createEl("li", { text: line });
    }, ["limitations", "known issues", "bugs", "caveats"]));

    items.push(this.headingDef("ℹ️ About"));
    items.push(this.sectionDef("", "", (host) => {
      const version = this.plugin.manifest?.version ?? "unknown";
      host.createEl("p", { text: `Stashpad v${version}` });
      const p = host.createEl("p");
      p.createEl("a", { text: "Source, issues & changelog on GitHub", href: "https://github.com/grub-basket/SP" });
    }, ["about", "version", "github", "issues", "support", "changelog"]));

    return items;
  }

  /** Diagnostics tab: log + notification controls. Lifted verbatim
   *  from the pre-0.73.1 Log section. Inventory items A1–A4. */
  private diagnosticsItems(): SettingDefinitionItem[] {
    return [
      this.renderDef("Performance profiling", "Record timing for list rendering, body reads, and file writes. Turn on, use Stashpad normally (especially the slow operations), then run “Dump performance profile” from the command palette and share the result. Off = zero overhead.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.enablePerfProfiling).onChange(async (v) => {
          this.plugin.settings.enablePerfProfiling = v;
          this.plugin.stampDiagnostic("perf", v);
          await this.plugin.saveSettings();
        })), ["perf", "profiling", "timing", "slow"]),

      this.renderDef("Debug trace", "Record low-level diagnostic lines to an in-memory buffer while you reproduce a bug, then copy them below to share. Captures tap coordinates vs the row they resolve to, and — after a color change, a to-do toggle, or entering select mode — every change to the list's scroll position and content height for two seconds, which is how a list that moves when it shouldn't gets diagnosed on a real device. Kept in memory only, so nothing is written to disk unless you also turn on the setting below. Local only — no network; zero overhead when off.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.debugTrace).onChange(async (v) => {
          this.plugin.settings.debugTrace = v;
          this.plugin.stampDiagnostic("trace", v);
          await this.plugin.saveSettings();
          if (!v) await this.plugin.removeTraceFiles();
        })), ["debug", "trace", "diagnostics", "tap", "log"]),

      this.renderDef("Save the debug trace to disk", "Only useful for a bug that CRASHES Obsidian or hangs it badly enough to need a force-quit, which would otherwise take the trace with it. While on, a copy is written beside Stashpad's settings file about once a second and a marker is saved every quarter second; the previous session's copy is kept so you can retrieve it after a restart. Leave it off otherwise — the trace still records everything and both copy commands still work, so this only buys surviving a crash, and it writes to your disk continuously for as long as it's on. Turning it off deletes both copies.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.debugTracePersist).onChange(async (v) => {
          this.plugin.settings.debugTracePersist = v;
          await this.plugin.saveSettings();
          if (!v) await this.plugin.removeTraceFiles();
        })), ["debug", "trace", "disk", "persist", "crash", "force-quit"]),

      this.renderDef("Log note opens (activity heatmap)", "Record when you open a Stashpad note so the activity heatmap can show a “Viewed” bucket. Off by default — opens are frequent and grow the action log; turn on only if you want to track what you looked at. Local only; nothing leaves your vault.", (s) =>
        s.addToggle((t) => t.setValue(this.plugin.settings.logNoteOpens).onChange(async (v) => {
          this.plugin.settings.logNoteOpens = v;
          await this.plugin.saveSettings();
        })), ["log", "open", "opens", "viewed", "heatmap", "activity", "track"]),

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
    const s0 = this.plugin.settings;
    const parseCsv = (v: string): string[] => v.split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
    const mutedA = new Set<string>(s0.mutedAuthors ?? []);
    const people = this.plugin.collectKnownAuthors().filter((a) => a.id !== (s0.authorId ?? "").trim());
    const teamGroup: SettingDefinitionItem[] = [
      {
        type: "group",
        heading: "Team activity",
        items: [
          this.renderDef("Notify me about teammates’ notes",
            "When a teammate creates a note in a Stashpad folder, show a notification. Detected from the note’s author, so your own notes never notify.",
            (s) => s.addToggle((t) => t.setValue(s0.teamNotifications).onChange(async (v) => { s0.teamNotifications = v; await this.plugin.saveSettings(); })),
            ["team", "notify", "teammate", "activity", "multiplayer"]),
          this.renderDef("Also send desktop notifications",
            "In addition to the in-app toast, raise an operating-system notification so activity reaches you when Obsidian is in the background. Asks for permission the first time.",
            (s) => s.addToggle((t) => t.setValue(s0.teamNotificationsDesktop).onChange(async (v) => { s0.teamNotificationsDesktop = v; await this.plugin.saveSettings(); })),
            ["team", "desktop", "os", "notification", "background"]),
          this.renderDef("Watch only these folders",
            "Comma-separated folder paths. When set, only these folders notify and the rest go quiet — livestream one place a teammate is working. Leave empty to watch every Stashpad folder.",
            (s) => s.addText((t) => {
              t.setValue((s0.watchedFolders ?? []).join(", ")).setPlaceholder("Team, Projects/Q3");
              const commit = async () => { s0.watchedFolders = parseCsv(t.getValue()); await this.plugin.saveSettings(); };
              t.inputEl.addEventListener("blur", () => void commit());
              t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void commit(); });
            }),
            ["team", "watch", "folder", "livestream", "follow"]),
          this.renderDef("Mute these folders",
            "Comma-separated folder paths that should never notify, even when watched.",
            (s) => s.addText((t) => {
              t.setValue((s0.mutedFolders ?? []).join(", ")).setPlaceholder("Scratch, Archive");
              const commit = async () => { s0.mutedFolders = parseCsv(t.getValue()); await this.plugin.saveSettings(); };
              t.inputEl.addEventListener("blur", () => void commit());
              t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void commit(); });
            }),
            ["team", "mute", "folder", "silence"]),
          ...(people.length ? [{
            type: "group" as const,
            heading: "Per-person notifications",
            items: people.map((pn) => this.renderDef(pn.name || pn.id,
              "Turn off to silence notifications for this teammate’s notes.",
              (s) => s.addToggle((t) => t.setValue(!mutedA.has(pn.id)).onChange(async (on) => {
                if (on) mutedA.delete(pn.id); else mutedA.add(pn.id);
                s0.mutedAuthors = [...mutedA];
                await this.plugin.saveSettings();
              })),
              ["team", "mute", "person", "author", pn.name])),
          } as SettingDefinitionItem] : []),
        ],
      } as SettingDefinitionItem,
    ];
    return [
      ...teamGroup,
      this.renderDef("Notification history limit", "Maximum number of notifications kept in the persistent history. Set to 0 for unlimited (the file size grows with usage; expect a few hundred KB per ~5000 entries). Default: 5000.", (s) =>
        s.addText((t) => {
          t.setValue(String(this.plugin.settings.notificationHistoryLimit ?? 5000)).setPlaceholder("5000");
          // Commit on blur/Enter, NOT per keystroke: setHistoryLimit prunes, so
          // typing "5000" would transiently apply 5 and a notification arriving
          // mid-type would truncate the history to 5 permanently. Reject NaN /
          // negatives (restore the prior value). 0.140.11
          const commit = async () => {
            const n = parseInt(t.getValue(), 10);
            if (!Number.isFinite(n) || n < 0) { t.setValue(String(this.plugin.settings.notificationHistoryLimit ?? 5000)); return; }
            this.plugin.settings.notificationHistoryLimit = n;
            this.plugin.notifications.setHistoryLimit(n);
            await this.plugin.saveSettings();
          };
          t.inputEl.addEventListener("blur", () => void commit());
          t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void commit(); });
        }), ["notification", "history", "limit"]),

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

      this.renderDef("Notification history", `Browse recorded notifications (${((this.plugin.settings.notificationHistoryLimit ?? 5000) > 0) ? "up to " + (this.plugin.settings.notificationHistoryLimit ?? 5000) + ", per the limit above" : "unlimited, per the limit above"}). Filter by category. Live-updates as new notifications arrive. Muted categories still appear here so you can review what was suppressed.`, (s) =>
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
  /** 0.272.0: the quick-action (star) menu customization — one checkbox per
   *  catalog action; checked ones make up `quickMenuActions` in catalog order.
   *  Emptying every box hides the star button entirely. */
  private quickMenuSection(): SettingDefinitionItem {
    return this.sectionDef(
      "Quick actions menu (the star button)",
      "A short, tap-first menu on each note, shown before the full ⋮ menu. Pick which actions appear; uncheck them all to hide the star button. Actions run on the note you tapped.",
      (host) => {
        new Setting(host)
          .setName("End with \"More commands…\"")
          .setDesc("Append an item that opens the full ⋮ menu, so nothing is out of reach.")
          .addToggle((t) => t.setValue(this.plugin.settings.quickMenuIncludeMore).onChange(async (v) => {
            this.plugin.settings.quickMenuIncludeMore = v;
            await this.plugin.saveSettings();
          }));
        const chosen = new Set(this.plugin.settings.quickMenuActions ?? []);
        for (const def of QUICK_ACTION_CATALOG) {
          const row = new Setting(host).setName(def.label);
          row.addToggle((t) => t.setValue(chosen.has(def.id)).onChange(async (on) => {
            if (on) chosen.add(def.id); else chosen.delete(def.id);
            // Persist in CATALOG order so the menu order is stable and matches
            // what this list shows top-to-bottom.
            this.plugin.settings.quickMenuActions =
              QUICK_ACTION_CATALOG.filter((a) => chosen.has(a.id)).map((a) => a.id);
            await this.plugin.saveSettings();
          }));
        }
      },
      ["quick", "menu", "star", "actions", "shortcut", "copy", "move", "blur", "large text"],
    );
  }

  /** 0.278.0: timestamps-when-copying as a MODIFIER gesture instead of a plain
   *  toggle. Copies never include timestamps by default; holding the configured
   *  modifier(s) while copying (keyboard shortcut, or while clicking the menu's
   *  "Copy"/"Copy tree" items) adds each note's timestamp. No modifiers picked =
   *  off. A live status line reports whether the keyboard path will actually fire
   *  given the current Copy shortcut (adding a modifier already in that shortcut
   *  can't form a distinct chord). See view-keys.ts copyTimestampStatus. */
  private copyTimestampModifiersSection(): SettingDefinitionItem {
    return this.sectionDef(
      "Timestamps when copying",
      "Copies don't include each note's timestamp unless you hold a modifier while copying. Pick which modifier(s) below — none = off. Works with the Copy / Copy tree keyboard shortcuts and with holding the modifier while clicking those items in the ⋮ menu.",
      (host) => {
        // sectionDef renders no chrome of its own (name/desc feed native search
        // only), so draw this section's own heading + intro — matching how the
        // toggle rows around it each carry a name + description. 0.278.2
        new Setting(host).setName("Timestamps when copying").setHeading();
        host.createEl("p", {
          cls: "setting-item-description",
          text: "Copies don't include each note's timestamp unless you hold a modifier while copying. Pick which modifier(s) below — none = off. Works with the Copy / Copy tree keyboard shortcuts, and with holding the modifier while choosing those items in the ⋮ menu.",
        });
        const chosen = new Set<CopyTsModifier>(parseModifierTokens(this.plugin.settings.copyTimestampModifiers));
        for (const mod of COPY_TS_MODIFIER_ORDER) {
          const label = humanCombo(mod);
          const row = new Setting(host).setName(label);
          row.addToggle((t) => t.setValue(chosen.has(mod)).onChange(async (on) => {
            if (on) chosen.add(mod); else chosen.delete(mod);
            this.plugin.settings.copyTimestampModifiers = serializeModifierTokens(chosen);
            await this.plugin.saveSettings();
            refreshStatus();
          }));
        }
        // Below the toggles: whether the chosen combo will actually fire (keyboard
        // path collapses if the modifier is already part of the Copy shortcut).
        const statusEl = host.createEl("p", { cls: "stashpad-copy-ts-status" });
        const refreshStatus = () => {
          const mods = COPY_TS_MODIFIER_ORDER.filter((m) => chosen.has(m));
          statusEl.setText(copyTimestampStatus(mods, this.plugin.settings.bindings?.copy));
        };
        refreshStatus();
      },
      ["copy", "timestamp", "prefix", "modifier", "shift", "alt", "ctrl", "cmd", "meta"],
    );
  }

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
      intro: "A separate password just for this folder. Save it in a password manager BEFORE you continue — the device keychain is a convenience that can be wiped at any time, not a backup. There is NO recovery if it's lost: Stashpad cannot recover it, and everything encrypted under it becomes permanently unreadable. If you plan to SHARE this folder, add a Recovery password afterwards and keep it somewhere separate — anyone you share the main password with can change it, and only a recovery password gets you back in.",
      onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; try { await this.plugin.encryption.setupFolderKey(folder, next, this.folderKeyLabel(folder), remember); } catch (e) { return (e as Error).message; } new Notice("Folder password set — share it securely."); this.update?.(); this.pfeRerender?.(); return null; } }).open();
  }
  private promptChangeFolderPassword(folder: string): void {
    new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: true, title: `Change password for “${folder.split("/").pop()}”`,
      intro: "Re-wraps this folder's key under a new password. The OLD password stops working on THIS device right away (un-synced copies elsewhere keep working until they sync). To truly cut off someone who left, remove encryption and re-encrypt the folder under a fresh password.",
      onSubmit: async ({ next, remember }) => { if (!next) return "Enter a password."; try { await this.plugin.encryption.changeFolderPassword(folder, next, remember); } catch (e) { return (e as Error).message; } new Notice("Folder password changed."); this.update?.(); this.pfeRerender?.(); return null; } }).open();
  }
  private promptSetFolderRecovery(folder: string): void {
    const name = folder.split("/").pop() || folder;
    new EncryptionPasswordModal(this.app, { mode: "setup", offerKeychain: false, title: `Recovery password for “${name}”`,
      intro: "A SECOND password that also unlocks this folder. Either one works, so it is exactly as sensitive as the main password. It only buys you anything if you store it SOMEWHERE ELSE — a different password manager, printed and filed, or with someone you trust; two entries in the same manager both vanish with that manager. Its other job: it survives a change of the main password, so on a SHARED folder it's your way back in if a collaborator rotates the password, and it can't go stale the way a saved copy of a rotated password does. Setting it again replaces any existing recovery password.",
      onSubmit: async ({ next }) => { if (!next) return "Enter a password."; try { await this.plugin.encryption.setFolderRecoveryPassword(folder, next); } catch (e) { return (e as Error).message; } new Notice("Recovery password set — keep it somewhere safe."); this.update?.(); this.pfeRerender?.(); return null; } }).open();
  }
  private promptRemoveFolderRecovery(folder: string): void {
    const name = folder.split("/").pop() || folder;
    new ConfirmModal(this.app, `Remove recovery password for “${name}”?`,
      "The recovery password will no longer unlock this folder. The main folder password is unchanged. You can add a new recovery password later.",
      "Remove recovery",
      async (ok) => {
        if (!ok) return;
        try { await this.plugin.encryption.removeFolderRecoveryPassword(folder); } catch (e) { new Notice((e as Error).message); return; }
        new Notice("Recovery password removed."); this.update?.(); this.pfeRerender?.();
      }).open();
  }
  private promptUnlockFolder(folder: string): void {
    new EncryptionPasswordModal(this.app, { mode: "unlock", offerKeychain: true, title: `Unlock “${folder.split("/").pop()}”`, intro: "Enter this folder's password.",
      onSubmit: async ({ current, remember }) => { const ok = await this.plugin.encryption.unlockFolder(folder, current!, remember); if (!ok) return "Wrong password. Try again."; new Notice("Folder unlocked."); this.update?.(); this.pfeRerender?.(); return null; } }).open();
  }

  // (0.143.0: encryptionOrOnboard removed — there is no vault-wide encryption to
  // onboard. Per-folder options require the folder's own password, checked inline.)

  /** The folder selected in the per-folder dropdown — kept on the tab instance so it
   *  survives the declarative `update()` re-renders (no ghosting between folders). */
  private pfeSelected: string | null = null;
  /** 0.136.0: local re-render for the per-folder encryption panel (see
   *  renderPerFolderEncryption — update() alone left stale toggle state). */
  private pfeRerender: (() => void) | null = null;
  /** 0.118.6: selected folder for the (searchable) per-folder icon control in
   *  Folders & Storage. */
  private obscurePickFolder: string | null = null;
  private iconPickFolder: string | null = null;

  private renderPerFolderEncryption(host: HTMLElement): void {
    // 0.142.3: per-folder passwords stand alone — no vault encryption required
    // first. Setting a folder password can be the FIRST encryption in the vault;
    // a folder without its own password falls back to the vault key IF one exists.
    // (The no-recovery caution now lives in the single merged warning callout at
    // the top of the Vault Encryption section — 0.134.3.)
    const folders = this.plugin.discoverStashpadFolders();
    if (folders.length === 0) { host.createEl("p", { cls: "setting-item-description" }).setText("No Stashpad folders found yet."); return; }
    // Keep a VALID selection across re-renders (default to the first folder).
    if (!this.pfeSelected || !folders.includes(this.pfeSelected)) this.pfeSelected = folders[0];

    // One dropdown to pick the folder; the panel below shows only that folder's
    // options — so the section stays compact regardless of folder count.
    // 0.136.0: the panel re-renders LOCALLY (pfeRerender) — `this.update?.()`
    // proved unreliable for refreshing section content in place (toggles kept
    // stale values: a cancelled password prompt left the switch flipped, and
    // the hide-filenames sub-toggles never enabled after their parent did).
    const panel = host.createDiv({ cls: "stashpad-folderenc-panel" });
    this.pfeRerender = () => { panel.empty(); this.renderFolderEncPanel(panel, this.pfeSelected!); };
    // 0.143.0: "Folder" is a heading, and the folder picker is enlarged to read as
    // a heading-sized selector (the folder IS the subject of everything below).
    const folderRow = new Setting(host).setName("Folder")
      .setDesc("Pick a folder to configure its password, archive, and trash options. Everything below applies to the selected folder only.")
      .setHeading()
      .addDropdown((d) => {
        for (const f of folders) d.addOption(f, f);
        d.setValue(this.pfeSelected!);
        d.selectEl.addClass("stashpad-folderenc-picker");
        d.onChange((v) => { this.pfeSelected = v; this.pfeRerender?.(); });
      });
    // 0.214.4: mark the ROW too. The control column is `flex: 0 0 auto` by
    // default, which is what pinned the picker to a narrow intrinsic width and
    // truncated a folder name far earlier than it needed to. CSS can't reach a
    // parent, so the row gets its own class to widen the control column.
    folderRow.settingEl.addClass("stashpad-folderenc-row");
    // (createDiv above put the panel before the dropdown in the DOM — move it
    // back below so the layout reads Folder → panel.)
    host.appendChild(panel);
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
      head.addButton((b) => b.setButtonText("Manage on parent folder").onClick(() => { this.pfeSelected = owner; this.update?.(); this.pfeRerender?.(); }));
    } else if (!hasOwn) {
      head.addButton((b) => b.setButtonText("Set folder password…").setCta().onClick(() => this.promptSetFolderPassword(folder)));
    } else if (!unlocked) {
      head.addButton((b) => b.setButtonText("Unlock…").setCta().onClick(() => this.promptUnlockFolder(folder)));
    } else {
      // (0.135.0: the per-folder "Lock (forget password)" button is gone, same
      // reasoning as the vault-level "Lock now". Encrypting/decrypting the
      // folder's content is the "Encrypt this folder's notes" toggle below.)
      head.addButton((b) => b.setButtonText("Change password…").onClick(() => this.promptChangeFolderPassword(folder)));
    }

    // 0.142.1: optional recovery password — a SECOND password that unlocks the same
    // folder, in case the primary is lost. Only offered once the folder owns its key
    // AND is unlocked (setting it wraps the live DEK). Managing recovery for an
    // inherited folder happens on its key-owning parent.
    if (hasOwn && unlocked) {
      const hasRec = this.plugin.encryption.folderHasRecovery(folder);
      const rec = new Setting(host).setName("Recovery password")
        .setDesc(hasRec
          ? "A second password that also unlocks this folder. Keep it somewhere SEPARATE from the main password — a different password manager, printed, or with someone you trust."
          : "Optional second password that also unlocks this folder. Only worth it if you store it somewhere SEPARATE from the main password — two entries in the same password manager don't protect you from losing that manager. Recommended for SHARED folders: it survives someone else changing the main password.");
      rec.addButton((b) => b.setButtonText(hasRec ? "Change recovery…" : "Add recovery…").onClick(() => this.promptSetFolderRecovery(folder)));
      if (hasRec) rec.addButton((b) => { b.setButtonText("Remove recovery").onClick(() => this.promptRemoveFolderRecovery(folder)); b.buttonEl.addClass("mod-warning"); });
    }

    const setPref = async (patch: Partial<FolderEncPrefs>) => {
      this.plugin.settings.folderEncPrefs = { ...(this.plugin.settings.folderEncPrefs ?? {}), [folder]: { ...((this.plugin.settings.folderEncPrefs ?? {})[folder] ?? {}), ...patch } };
      await this.plugin.saveSettings();
    };

    // (0.136.0: the per-folder "Archive" mark toggle is gone — every folder
    // implicitly owns an `archive/` subfolder. What remains configurable is
    // whether archiving INTO it encrypts: the "Encrypt archived notes" pair
    // below.)

    // 0.137.1: no more "Use global default" — the global follow-Obsidian's-
    // trash option is gone; unset simply means Stashpad's own trash.
    new Setting(host).setName("Trash handling").setDesc("Where notes deleted from this folder go.")
      .addDropdown((d) => d
        .addOption("", "Stashpad trash (default)")
        .addOption("obsidian", "Obsidian native trash")
        .setValue(prefs.trashHandling === "obsidian" ? "obsidian" : "")
        .onChange((v) => setPref({ trashHandling: (v || undefined) as FolderEncPrefs["trashHandling"] })));

    // 0.136.0: `requireKey` gates turning a pair ON behind an actual unlock
    // (vault key, or this folder's own key) — the archive/trash pairs used to
    // flip on without ever proving a key exists. Every path ends in
    // pfeRerender so the toggles + sub-toggles always show the REAL state
    // (a cancelled password prompt used to leave the switch flipped, and the
    // hide-filenames sub-toggles never enabled without a full reopen).
    const pair = (label: string, cKey: keyof FolderEncPrefs, fKey: keyof FolderEncPrefs, onContent?: (v: boolean) => Promise<void>, requireKey = false) => {
      new Setting(host).setName(label)
        .addToggle((t) => t.setValue(!!prefs[cKey]).onChange(async (v) => {
          if (v && requireKey) {
            // 0.143.0: per-folder only — this option needs the folder's OWN key.
            // If it has none, tell the user to set a folder password first.
            if (!this.plugin.encryption.hasFolderKey(folder)) {
              new Notice("Give this folder a password first (the “Set folder password…” button above), then enable this.");
              this.pfeRerender?.(); return;
            }
            const dek = await this.plugin.ensureFolderUnlocked(folder);
            if (!dek) { this.pfeRerender?.(); return; } // prompt cancelled/failed → revert
          }
          const patch: Partial<FolderEncPrefs> = {}; (patch as Record<string, unknown>)[cKey] = v; if (!v) (patch as Record<string, unknown>)[fKey] = false;
          await setPref(patch);
          if (onContent) await onContent(v);
          this.pfeRerender?.();
        }));
      new Setting(host).setName(`↳ ${label} — hide filenames`).setClass("stashpad-subsetting")
        .addToggle((t) => { t.setValue(!!prefs[fKey]); t.setDisabled(!prefs[cKey]); t.onChange(async (v) => { const p: Partial<FolderEncPrefs> = {}; (p as Record<string, unknown>)[fKey] = v; await setPref(p); this.pfeRerender?.(); }); });
    };
    pair("Encrypt this folder's notes", "encryptContent", "encryptFilenames", async (v) => {
      if (v) await this.plugin.lockFolder(folder); else await this.plugin.unlockFolder(folder);
      // Lock/unlock may be cancelled (password prompt dismissed) or partial — set the
      // pref to the folder's ACTUAL locked state so the toggle never claims a state
      // the folder isn't in.
      const has = (this.plugin.settings.lockedSubtrees ?? []).some((e) => (e.folder || "").replace(/\/+$/, "") === folder);
      await setPref({ encryptContent: has, ...(has ? {} : { encryptFilenames: false }) });
    });
    pair("Encrypt archived notes", "archiveEncryptContent", "archiveEncryptFilenames", async (v) => {
      // 0.137.2 (retro-apply): offer to lock what's ALREADY in the archive —
      // the pref alone only affects future arrivals.
      if (!v) return;
      const plainCount = this.plugin.archivedPlainNotesIn(`${folder}/archive`).length;
      if (plainCount === 0) return;
      new ConfirmModal(this.app,
        `Encrypt the ${plainCount} note${plainCount === 1 ? "" : "s"} already archived?`,
        `“${folder.split("/").pop()}”'s archive already holds ${plainCount} plaintext note${plainCount === 1 ? "" : "s"}. Encrypt ${plainCount === 1 ? "it" : "them"} now too? (Skipping leaves ${plainCount === 1 ? "it" : "them"} readable; only notes archived from now on get encrypted.)`,
        "Encrypt them",
        async (ok) => {
          if (!ok) return;
          const n = await this.plugin.encryptExistingArchiveNotes(folder);
          new Notice(n > 0 ? `Encrypted ${n} archived note${n === 1 ? "" : "s"}.` : "Nothing was encrypted (cancelled or already locked).");
          this.pfeRerender?.();
        }).open();
    }, true);
    pair("Encrypt trashed notes", "trashEncryptContent", "trashEncryptFilenames", undefined, true);

    // 0.139.0 (peek): per-folder auto-re-encrypt idle override. Blank = use the
    // global setting; a number overrides it for this folder; 0 = off here.
    new Setting(host).setName("Auto re-encrypt after idle minutes")
      .setDesc("Override the global auto-re-encrypt timer for this folder. Blank = use global; 0 = off for this folder. A cancellable countdown always shows first, and open notes are never touched.")
      .addText((t) => {
        t.setPlaceholder("global");
        t.setValue(prefs.reEncryptAfterMin == null ? "" : String(prefs.reEncryptAfterMin));
        t.onChange((v) => {
          const s = v.trim();
          { const n = Number(s); if (s === "") void setPref({ reEncryptAfterMin: undefined }); else if (Number.isFinite(n) && n >= 0) void setPref({ reEncryptAfterMin: Math.floor(n) }); else { t.setValue(prefs.reEncryptAfterMin == null ? "" : String(prefs.reEncryptAfterMin)); } }
        });
      });

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
            this.update?.(); this.pfeRerender?.();
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
        t.setValue(this.plugin.settings.folder).setPlaceholder("Stashpad");
        // 0.140.16: validate + persist on COMMIT (blur/Enter), not per keystroke —
        // the old onChange wrote settings.folder for every prefix ("S", "St", …),
        // so other subsystems reading it mid-type (or a settings-close mid-type)
        // saw a bogus folder. Also check EVERY path segment against the FULL
        // reserved set (was last-segment-only and missing the Stashpad reserved
        // subfolders), so the notes folder can't be nested inside archive/_deleted/etc.
        const commit = async (): Promise<void> => {
          const cleaned = (t.getValue() || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.folder;
          const segs = cleaned.split("/").filter(Boolean);
          const reserved = new Set([
            this.plugin.settings.importDropFolder,
            this.plugin.settings.exportFolder,
            // Stashpad-reserved subfolders — a notes folder must not BE or live under one.
            "_attachments", "_processed", "_failed-imports", "_authors", "_deleted", "archive", "trash", ".stashpad",
          ].map((x) => (x ?? "").trim().replace(/^\/+|\/+$/g, "")).filter(Boolean));
          if (segs.some((seg) => reserved.has(seg))) {
            new Notice(`"${cleaned}" uses a reserved Stashpad subfolder name. Pick something else.`);
            t.setValue(this.plugin.settings.folder); // restore the last valid value
            return;
          }
          if (cleaned === this.plugin.settings.folder) return;
          this.plugin.settings.folder = cleaned;
          await set();
        };
        t.inputEl.addEventListener("blur", () => void commit());
        t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void commit(); });
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

    // 0.267.1: per-folder obscure default, mirrored here from the folder
    // panel's right-click menu. The menu is where you reach for it while
    // working; settings is where you go to see them ALL at once, which the
    // menu cannot show — you would have to right-click every folder to learn
    // which ones are set.
    cats.listDisplay.push(this.renderDef("Obscure notes by default, per folder", "Choose whether a folder's notes start blurred, when the vault-wide switch above is OFF. \"Follow global\" means no opinion; \"Always\" and \"Never\" are explicit answers for this folder, and a note with its own setting overrides its folder. While the vault-wide switch is ON it covers everything regardless. VISUAL ONLY.", (st) => {
      const folders = this.plugin.discoverStashpadFolders();
      if (folders.length === 0) { st.setDesc("No Stashpad folders found yet."); return; }
      if (!this.obscurePickFolder || !folders.includes(this.obscurePickFolder)) this.obscurePickFolder = folders[0];
      let modeDrop: import("obsidian").DropdownComponent | null = null;
      const modeFor = (f: string): string => {
        const v = this.plugin.settings.obscureFolders?.[f.replace(/\/+$/, "")];
        return v === true ? "always" : v === false ? "never" : "global";
      };
      st.addDropdown((d) => {
        for (const f of folders) d.addOption(f, f.split("/").pop() || f);
        d.setValue(this.obscurePickFolder!);
        d.onChange((v) => { this.obscurePickFolder = v; modeDrop?.setValue(modeFor(v)); });
      });
      st.addDropdown((d) => {
        modeDrop = d;
        d.addOption("global", "Follow global");
        d.addOption("always", "Always obscure");
        d.addOption("never", "Never obscure");
        d.setValue(modeFor(this.obscurePickFolder!));
        d.onChange(async (v) => {
          await this.plugin.setFolderObscured(this.obscurePickFolder!,
            v === "always" ? true : v === "never" ? false : null);
        });
      });
    }, ["obscure", "blur", "hide", "folder", "default", "privacy"]));

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

    // 0.215.0: a standing warning while Obsidian's automatic link updating is
    // off. The startup toast fires once; this stays for as long as the problem
    // does, so the explanation is findable after that toast is dismissed.
    if (this.plugin.linkUpdatesDisabled()) {
      cats.maintenance.push(this.sectionDef(
        "⚠️ Automatic link updating is OFF",
        "",
        (host) => {
          host.createEl("p", { text:
            "Obsidian's “Automatically update internal links” setting is turned off for this vault. " +
            "Stashpad renames a note's file when its first line changes, and with that setting off Obsidian " +
            "will not repoint [[wikilinks]] to the renamed note — so links to your Stashpad notes break " +
            "silently as you edit them." });
          host.createEl("p", { cls: "setting-item-description", text:
            "Fix it in Obsidian's Settings → Files and links → “Automatically update internal links”. " +
            "Stashpad deliberately does not change this for you: it is a vault-wide Obsidian preference, " +
            "and you may have turned it off on purpose. This warning disappears once it is on." });
        },
        ["links", "wikilinks", "rename", "broken", "update", "automatically"],
      ));
    }

    cats.composerCopy.push(toggle("Add link previews automatically",
      "When a note containing a link is saved, fetch that link's title and description and add a preview to the note — without you running a command. Off by default: it turns typing a URL into a network request and a write to the note. Previews are still never overwritten, so anything you have edited by hand is safe. If the list feels jumpy while notes are being written, turn this off.",
      () => this.plugin.settings.linkPreviewAuto, (v) => { this.plugin.settings.linkPreviewAuto = v; },
      ["link", "preview", "auto", "automatic", "unfurl", "url"]));
    cats.composerCopy.push(toggle("Start link previews folded",
      "Show preview callouts collapsed to just their title. Off by default — folding hides the description, which is the part worth keeping. Turn it on if notes with several links feel dominated by previews.",
      () => this.plugin.settings.linkPreviewCollapsed, (v) => { this.plugin.settings.linkPreviewCollapsed = v; },
      ["link", "preview", "collapsed", "folded", "callout"]));
    cats.composerCopy.push(this.renderDef("Link preview callout style",
      'Which Obsidian callout type link previews use — "info", "quote", "abstract", "note" and so on. Cosmetic: it decides the icon and colour. Previews are always collapsed by default so a note with several links is not mostly preview.',
      (s) => s.addText((t) => t
        .setPlaceholder("info")
        .setValue(this.plugin.settings.linkPreviewCallout)
        .onChange(async (v) => {
          this.plugin.settings.linkPreviewCallout = (v || "info").trim().replace(/[^a-z0-9-]/gi, "") || "info";
          await set();
        })), ["link", "preview", "callout", "unfurl", "url"]));
    cats.composerCopy.push(this.renderDef("Pause between link fetches (ms)",
      "How long to wait between fetching one link preview and the next. Backfilling an archive is thousands of requests, and hammering a site is both rude and a good way to get rate-limited. 300ms is a reasonable default; raise it if a host starts refusing.",
      (s) => s.addText((t) => t
        .setPlaceholder("300")
        .setValue(String(this.plugin.settings.linkPreviewDelayMs))
        .onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.linkPreviewDelayMs = Number.isFinite(n) && n >= 0 ? Math.min(10000, n) : 300;
          await set();
        })), ["link", "preview", "delay", "rate", "throttle"]));

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
      const parseTags = (v: string): string[] => [...new Set(v.split(",").map((x) => x.trim().replace(/^#+/, "").replace(/\s+/g, "-")).filter(Boolean))];
      cats.datesTime.push(this.renderDef("Task tag chips", "Comma-separated tags shown as one-tap chips in the due-date / assign picker, so you can label a task (e.g. events, saga, outage) without typing. Plain names, no # needed.", (s) => {
        s.addText((t) => {
          t.setPlaceholder("events, saga, outage");
          t.setValue((this.plugin.settings.taskTagChips ?? []).join(", "));
          t.onChange(async (v) => { this.plugin.settings.taskTagChips = parseTags(v); await set(); });
        });
      }, ["tag", "tags", "chip", "task", "due", "assign", "event", "saga"]));
      cats.datesTime.push(this.renderDef("Task tag suggestions", "Extra tags offered in the type-to-add autocomplete in the due-date / assign picker (the chips above are always suggested too). You can still type any tag not listed here.", (s) => {
        s.addText((t) => {
          t.setPlaceholder("incident, review, blocked");
          t.setValue((this.plugin.settings.taskTagSuggestions ?? []).join(", "));
          t.onChange(async (v) => { this.plugin.settings.taskTagSuggestions = parseTags(v); await set(); });
        });
      }, ["tag", "tags", "suggest", "autocomplete", "task", "due", "assign"]));
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
    cats.listDisplay.push(toggle("Re-hide obscured notes when you leave", "An obscured note goes back to blurred when you navigate away, switch folders, or reload — revealing it is momentary, like Signal. Off keeps it revealed until you re-hide it or restart. On by default. Note: obscuring is VISUAL ONLY; see the description on the obscure command.",
      () => this.plugin.settings.obscureReHides, (v) => { this.plugin.settings.obscureReHides = v; }, ["obscure", "blur", "hide", "spoiler", "privacy", "rehide"]));
    cats.listDisplay.push(toggle("Obscure every note, everywhere", "Blur every note in every Stashpad \u2014 for handing someone your screen, or working somewhere overlooked. This OVERRIDES everything else while it is on: a folder set to Never and a note set not to obscure are both covered. Nothing is rewritten, so they come back exactly as they were when you turn it off. Tapping a note still reveals it one at a time. VISUAL ONLY: the text is unchanged in the file and still turns up in search.",
      () => this.plugin.getObscureAll(), (v) => { void this.plugin.setObscureAll(v); }, ["obscure", "blur", "hide", "all", "global", "privacy", "panic"]));
    cats.listDisplay.push(toggle("Put the file name in front of an attachment", "When you attach a file, the note reads \"report.pdf\" followed by the file itself, separated by a space. Without it the note is a link and nothing else, so it shows up blank in the list and is hard to search for. On by default.",
      () => this.plugin.settings.attachmentNamePrefix, (v) => { this.plugin.settings.attachmentNamePrefix = v; }, ["attachment", "file", "name", "prefix", "title"]));
    cats.listDisplay.push(toggle("Embed attached files", "Attach files as an embed, so images and PDFs preview in the note. Turn this off to insert a plain link instead, which keeps a note with several files readable as a list. On by default. Either way the file is in the rail.",
      () => this.plugin.settings.attachmentsEmbedded, (v) => { this.plugin.settings.attachmentsEmbedded = v; }, ["attachment", "embed", "link", "preview", "file"]));

    cats.listDisplay.push(toggle("Show outgoing links in the rail", "List the notes this note links to, in a row under its files. Off by default: it earns its place on a hub note and is noise on everything else. Files are unaffected \u2014 they are always in the rail.",
      () => this.plugin.settings.railShowOutgoing, (v) => { this.plugin.settings.railShowOutgoing = v; this.plugin.refreshAllStashpadViews(); }, ["rail", "links", "outgoing", "backlinks"]));
    cats.listDisplay.push(toggle("Show backlinks in the rail", "List the notes that link TO this one, in a row under its files. Off by default. Kept separate from outgoing links because \"what does this point at\" and \"who refers to this\" are different questions.",
      () => this.plugin.settings.railShowBacklinks, (v) => { this.plugin.settings.railShowBacklinks = v; this.plugin.refreshAllStashpadViews(); }, ["rail", "backlinks", "incoming", "links"]));
    cats.listDisplay.push(toggle("Similar-note hints in the composer", "As you type a note, show existing notes with a similar title so you can spot a duplicate before creating one — Discourse-style. Desktop searches live; on mobile it is off until you tap the ⌕ toggle in the composer (so the keyboard isn't crowded). On by default. Click a hint to open that note.",
      () => this.plugin.settings.duplicateHints, (v) => { this.plugin.settings.duplicateHints = v; this.plugin.refreshAllStashpadViews(); }, ["duplicate", "similar", "hint", "composer", "search", "discourse"]));
    cats.listDisplay.push(toggle("Select text in notes (desktop)", "Let you select and copy text inside a note in the list. On by default. With it on, you drag a note to reorder by its grip handle (a draggable row can't have selectable text); turn it off to drag a note from anywhere on the row again, with no text selection. Desktop only — mobile is always tap-first.",
      () => this.plugin.settings.selectableNoteText, (v) => { this.plugin.settings.selectableNoteText = v; this.plugin.refreshAllStashpadViews(); }, ["select", "text", "copy", "drag", "grip", "reorder"]));

    cats.listDisplay.push(this.renderDef("How covered notes look", "\"Blur\" keeps the shape of the text. \"Solid bar\" paints over it — faster on a phone, because a blur has to be computed for every glyph every time the text is drawn, and it hides more, since a blur still leaks word shapes and lengths. Either way the text is untouched in the file.", (st) => {
      st.addDropdown((d) => {
        d.addOption("blur", "Blur");
        d.addOption("solid", "Solid bar (faster)");
        d.setValue(this.plugin.settings.obscureStyle === "solid" ? "solid" : "blur");
        d.onChange(async (v) => {
          this.plugin.settings.obscureStyle = v === "solid" ? "solid" : "blur";
          await this.plugin.saveSettings();
          this.plugin.reHideAndRefreshAllViews();
        });
      });
    }, ["obscure", "blur", "solid", "redact", "style", "performance"]));

    cats.listDisplay.push(this.renderDef("Where the global cover applies", "\"This device only\" keeps the switch on the screen you flipped it on \u2014 covering your phone leaves a desktop nobody is standing near untouched, and uncovering there later cannot uncover your phone. \"All devices\" syncs it with the rest of your settings, for when you want everything covered everywhere at once.", (st) => {
      st.addDropdown((d) => {
        d.addOption("device", "This device only");
        d.addOption("synced", "All devices (syncs)");
        d.setValue(this.plugin.settings.obscureAllScope === "synced" ? "synced" : "device");
        d.onChange(async (v) => {
          // Carry the CURRENT state across the change, so switching scope can
          // never uncover something that was covered a moment ago.
          const wasOn = this.plugin.getObscureAll();
          this.plugin.settings.obscureAllScope = v === "synced" ? "synced" : "device";
          await this.plugin.saveSettings();
          await this.plugin.setObscureAll(wasOn);
        });
      });
    }, ["obscure", "blur", "sync", "device", "local", "scope", "privacy"]));
    // 0.279.17: scheduled obscuring — a folder set to obscure-by-default only
    // covers during set hours; outside them (e.g. at home / off-hours) it's clear.
    cats.listDisplay.push(this.sectionDef("Only blur folders during set hours", "", (host) => {
      host.createEl("p", { cls: "setting-item-description", text: "When on, a folder you've set to obscure by default only blurs DURING the daily window below — outside it (say, evenings at home) that folder stays clear. The schedule only adds a \"when\" to folders already set to obscure; it never blurs a folder that isn't, and it doesn't touch a note you've obscured by hand or the global \"obscure everything\" switch." });
      host.createEl("p", { cls: "setting-item-description", text: "Times are your device's LOCAL time (24-hour). An end earlier than the start means an overnight window (e.g. 22 to 6). Because the window is local, it re-evaluates when your timezone changes as you travel." });
      const applied = (): void => { void this.plugin.saveSettings().then(() => this.plugin.reHideAndRefreshAllViews()); };
      new Setting(host)
        .setName("Blur only during set hours")
        .addToggle((t) => t.setValue(this.plugin.settings.obscureScheduleEnabled).onChange((v) => { this.plugin.settings.obscureScheduleEnabled = v; applied(); }));
      const hourDropdown = (setting: Setting, get: () => number, put: (n: number) => void): void => {
        setting.addDropdown((d) => {
          for (let h = 0; h < 24; h++) d.addOption(String(h), `${String(h).padStart(2, "0")}:00`);
          d.setValue(String(Math.max(0, Math.min(23, get()))));
          d.onChange((v) => { put(parseInt(v, 10) || 0); applied(); });
        });
      };
      hourDropdown(new Setting(host).setName("Start blurring at"), () => this.plugin.settings.obscureScheduleStart, (n) => { this.plugin.settings.obscureScheduleStart = n; });
      hourDropdown(new Setting(host).setName("Stop blurring at"), () => this.plugin.settings.obscureScheduleEnd, (n) => { this.plugin.settings.obscureScheduleEnd = n; });
      // Home timezone: the hours are read in this zone. Empty = follow the device.
      // "Use current" locks in the device's zone so the window stays in home time
      // as you travel; "Follow device" clears it back to local.
      const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
      // Set the home zone AND remember the value being replaced, so an accidental
      // change is one click to undo via the chips below.
      const setTz = (tz: string): void => {
        const prev = this.plugin.settings.obscureScheduleTimezone;
        const hist = this.plugin.settings.obscureScheduleTimezoneHistory ?? [];
        const next = [prev, tz, ...hist].filter((z) => !!z);
        this.plugin.settings.obscureScheduleTimezoneHistory = [...new Set(next)].slice(0, 6);
        this.plugin.settings.obscureScheduleTimezone = tz;
        applied();
        this.display();
      };
      const tzSetting = new Setting(host)
        .setName("Home timezone")
        .setDesc(this.plugin.settings.obscureScheduleTimezone
          ? `Hours are read in ${this.plugin.settings.obscureScheduleTimezone}.`
          : `Following this device (${deviceTz || "local"}). Lock it in so the window stays in home time when you travel.`);
      tzSetting.addButton((b) => b.setButtonText("Use current").onClick(() => setTz(deviceTz)));
      if (this.plugin.settings.obscureScheduleTimezone) {
        tzSetting.addButton((b) => b.setButtonText("Follow device").onClick(() => {
          this.plugin.settings.obscureScheduleTimezone = "";
          applied();
          this.display();
        }));
      }
      // Chips: recently-used zones (and ones the device has been in), so hitting
      // "Use current" by accident is undone by clicking the previous zone. The
      // active zone is marked and not clickable.
      const active = this.plugin.settings.obscureScheduleTimezone;
      const chips = (this.plugin.settings.obscureScheduleTimezoneHistory ?? []).filter((z) => !!z);
      if (chips.length) {
        const row = host.createDiv({ cls: "stashpad-tz-chips" });
        row.createSpan({ cls: "setting-item-description", text: "Recent: " });
        for (const z of chips) {
          const chip = row.createEl("button", { cls: "stashpad-tz-chip" + (z === active ? " is-active" : ""), text: z });
          if (z === active) { chip.disabled = true; chip.title = "Current home zone"; }
          else chip.onclick = () => setTz(z);
        }
      }
    }, ["obscure", "blur", "schedule", "hours", "time", "timezone", "privacy", "home", "work"]));
    // 0.279.14: be explicit about the gaps, since obscure is glance-protection and
    // reads as more than it is otherwise.
    cats.listDisplay.push(this.sectionDef("What obscuring does NOT cover", "", (host) => {
      host.createEl("p", { cls: "setting-item-description", text: "Obscuring is glance-protection only — VISUAL, on this screen. It does not encrypt anything (for that, use per-folder encryption), and the text stays readable in the file, in search, in the editor, and to other plugins." });
      host.createEl("p", { cls: "setting-item-description", text: "A few things stay readable on purpose or by limitation: the tab title (it can lead with the focused note's title — Obsidian's tab bar can't be blurred), the note timestamps, and the \"by …\" / \"edited …\" labels. The author/contributor NAME is blurred; the labels and times around it are not. If a tab title showing a note name is a concern, keep that note's Stashpad in a set-aside folder." });
    }, ["obscure", "blur", "privacy", "limitation", "tab", "title", "not", "covered", "encryption"]));
    cats.listDisplay.push(toggle("Spoiler markup", "Render ||text|| in a note as blurred until you tap it. Uses the Discord/Telegram convention. Off leaves the pipes as plain text. On by default. Like obscuring, this is VISUAL ONLY — the text is still in the file and still turns up in search.",
      () => this.plugin.settings.spoilerMarkup, (v) => { this.plugin.settings.spoilerMarkup = v; }, ["spoiler", "blur", "hide", "markup", "reveal"]));
    cats.listDisplay.push(toggle("Open every file type in the media viewer", "Open the preview even for files it can't display \u2014 a .docx or a .zip shows a card with its type, size and date, plus a button to open it properly. Off by default, because for those files the real app is usually the better answer. Either way, a file it can't display still opens the viewer when another attachment on the same note can be previewed, so you never lose the row of files.",
      () => this.plugin.settings.mediaViewerAllFileTypes, (v) => { this.plugin.settings.mediaViewerAllFileTypes = v; }, ["media", "viewer", "all", "file type", "unsupported", "preview"]));
    cats.listDisplay.push(this.renderDef("File types to keep out of the media viewer", "Comma-separated list of extensions that should always open in a new tab (or your default app) instead of the preview. Dots are optional \u2014 \u201cpdf, .zip, DOCX\u201d works. Leave blank to exclude nothing.", (row) => {
      row.addText((t) => {
        t.setPlaceholder("e.g. pdf, zip");
        t.setValue(this.plugin.settings.mediaViewerExcludedExtensions);
        // Persist on COMMIT (blur/Enter), not per keystroke — a half-typed
        // list is full of half-written extensions.
        const el = (t as any).inputEl as HTMLInputElement;
        el.addEventListener("blur", async () => {
          this.plugin.settings.mediaViewerExcludedExtensions = el.value;
          await set();
        });
        el.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") el.blur(); });
      });
    }, ["media", "viewer", "exclude", "extension", "file type", "tab", "default app"]));
    cats.listDisplay.push(this.renderDef("Attachment layout", "How a note's attachments are laid out. Auto picks per note: thumbnails when the files are mostly images and there is room to see them, a compact icon strip when they would be too small to recognise, and a named list when they are mostly non-images (a spreadsheet is identified by its name, not a preview).", (row) => {
      row.addDropdown((dd) => {
        dd.addOption("auto", "Auto");
        dd.addOption("thumbnail", "Thumbnails");
        dd.addOption("compact", "Compact icons");
        dd.addOption("filename", "File names");
        dd.setValue(this.plugin.settings.attachmentRailMode);
        dd.onChange(async (v) => {
          this.plugin.settings.attachmentRailMode = v as "auto" | "thumbnail" | "compact" | "filename";
          await set();
        });
      });
    }, ["attachment", "rail", "thumbnail", "compact", "layout", "view", "file", "icon"]));
    cats.listDisplay.push(toggle("Open images in the media viewer", "Clicking an image attached to a note opens a large preview with zoom, rotation and a rail of the note's other files, instead of opening it in a new tab. Non-image files still open in a tab. The viewer has an \u201cOpen in a new tab\u201d button, so nothing is lost either way. On by default.",
      () => this.plugin.settings.mediaViewerOnClick, (v) => { this.plugin.settings.mediaViewerOnClick = v; }, ["image", "media", "viewer", "lightbox", "preview", "zoom", "attachment"]));
    cats.composerCopy.push(toggle('Type "+" to append to an existing note', 'Typing + as the only character in an empty composer opens the note picker. Pick a note and what you send next is appended to the bottom of that note\'s body on a new line, instead of creating a new note. The target clears after one send. Dismissing the picker leaves the + as ordinary text, so markdown "+ " bullets still work. On by default.',
      () => this.plugin.settings.composerAppendTrigger, (v) => { this.plugin.settings.composerAppendTrigger = v; }, ["append", "plus", "existing", "composer", "add"]));
    cats.composerCopy.push(toggle('Type "/" to run a command', 'Start a line with / in the composer or the note editor to search Stashpad\'s commands and run one — the same commands as the palette, without leaving the keyboard. The / is removed when the command runs, and Escape dismisses the list leaving it as ordinary text. Only at the start of a line, so a / mid-sentence stays a / . On by default.',
      () => this.plugin.settings.slashCommands, (v) => { this.plugin.settings.slashCommands = v; }, ["slash", "command", "composer", "palette", "shortcut"]));
    cats.composerCopy.push(toggle("Split a pasted checklist into separate tasks", 'When every line of what you submit is a checkbox — "- [ ] milk", "[x] eggs" — create one task per line instead of a single note. Applies even when "split on newlines" is off. On by default.',
      () => this.plugin.settings.splitCheckboxLines, (v) => { this.plugin.settings.splitCheckboxLines = v; }, ["checkbox", "task", "split", "paste", "checklist"]));
    cats.movingNotes.push(toggle("Open the new parent in a background tab after moving a note IN", "When you nest a note into another note, open that parent in a background Stashpad tab so its new home is one click away — without stealing focus from what you're doing. Skipped when the destination is Home or already open in a tab. On by default.",
      () => this.plugin.settings.openParentTabOnMoveIn, (v) => { this.plugin.settings.openParentTabOnMoveIn = v; }, ["background", "tab", "move", "in", "parent"]));
    cats.movingNotes.push(toggle("Navigate to destination after moving a note OUT", "When you outdent a note, move it via the cross-parent picker, or send it to Home, automatically drill into the destination parent. Off = stay focused where you were.",
      () => this.plugin.settings.autoNavOnMoveOut, (v) => { this.plugin.settings.autoNavOnMoveOut = v; }, ["navigate", "move", "out"]));
    cats.listDisplay.push(this.renderDef("Pinned notes vs filters", "How much a pin outranks the filters. \"Never hide\" keeps a pinned note visible no matter what. \"Keep through time filters only\" holds it in place as you narrow the time window, but still hides it when it does not match a tag / colour / author filter. \"Filter like any note\" gives pins no special treatment. Applies to both pin kinds (pinned in the list, and pinned to the sidebar).", (s) => {
      s.addDropdown((d) => {
        d.addOption("all", "Never hide pinned notes");
        d.addOption("time", "Keep through time filters only");
        d.addOption("none", "Filter like any note");
        d.setValue(this.plugin.settings.pinnedFilterMode);
        d.onChange(async (v) => { this.plugin.settings.pinnedFilterMode = v as "all" | "time" | "none"; await set(); });
      });
    }, ["pin", "pinned", "filter", "time", "hide", "tag", "colour", "color"]));
    cats.listDisplay.push(toggle("Keep a pinned note's children too", "When a pin keeps a note visible through a filter, also keep its whole subtree (all descendants) visible — so the pinned note isn't left showing with its contents filtered away. Off by default; no effect when the setting above is \"Filter like any note\".",
      () => this.plugin.settings.pinnedChildrenPersist, (v) => { this.plugin.settings.pinnedChildrenPersist = v; }, ["pin", "pinned", "children", "subtree", "descendants", "filter"]));
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

    cats.movingNotes.push(toggle("Always prepare cut/copy for another vault", "Cross-vault copy/cut builds a bundle of the whole selection — every note and every attachment is read — so it is the slow part of a copy, especially on a network drive or a big selection. By default that only happens when you run “Copy/Cut for another vault”, keeping ordinary cut/copy instant. Turn this ON to prepare it on EVERY cut and copy, so plain Mod+C in one vault can be pasted into another. Fine on a fast machine; noticeable on a slow disk.",
      () => this.plugin.settings.alwaysStampCrossVault, (v) => { this.plugin.settings.alwaysStampCrossVault = v; }, ["cross-vault", "clipboard", "copy", "cut", "paste", "slow", "zip", "performance"]));

    // 0.215.0: where new attachments go. Default stays per-folder so existing
    // vaults are unchanged; the description names the trade-off honestly,
    // because the stranding risk is the whole reason the other modes exist.
    cats.foldersStorage.push(this.renderDef(
      "Where new attachments are stored",
      "Per-Stashpad keeps each folder's files inside it (<folder>/_attachments), which makes a Stashpad "
      + "self-contained and portable — but it is also what causes STRANDED ATTACHMENTS: attach a file, then "
      + "send or move that note to a different folder, and the file stays behind in the folder it was "
      + "dropped in. Stashpad now carries staged attachments across on send and can re-home strays during "
      + "Rebootstrap, but a file used by SEVERAL folders has no single correct home, so it is reported "
      + "rather than moved — and deleting the folder holding it breaks the other folders' notes. "
      + "One shared folder, or Obsidian's own attachment location, avoids the whole problem by never "
      + "putting attachments inside a Stashpad. Changing this only affects attachments added from now on; "
      + "existing files stay exactly where they are.",
      (s) => s.addDropdown((d) => {
        d.addOption("per-folder", "Per-Stashpad (<folder>/_attachments)");
        d.addOption("universal", "One shared folder (set below)");
        d.addOption("obsidian", "Follow Obsidian's attachment setting");
        d.setValue(this.plugin.settings.attachmentLocation ?? "per-folder");
        d.onChange(async (v) => {
          this.plugin.settings.attachmentLocation = v as "per-folder" | "universal" | "obsidian";
          await this.plugin.saveSettings();
        });
      }),
      ["attachment", "attachments", "storage", "location", "stranded", "images", "files"],
    ));
    cats.foldersStorage.push(this.renderDef(
      "Shared attachments folder",
      "Used when the setting above is “One shared folder”. Created on first use if it does not exist.",
      (s) => s.addText((t) => {
        new FolderSuggest(this.app, t.inputEl);
        t.setPlaceholder("Attachments");
        t.setValue(this.plugin.settings.attachmentUniversalFolder ?? "");
        t.inputEl.addEventListener("blur", async () => {
          const v = t.getValue().trim().replace(/^\/+|\/+$/g, "");
          this.plugin.settings.attachmentUniversalFolder = v || "Attachments";
          await this.plugin.saveSettings();
        });
      }),
      ["attachment", "attachments", "shared", "universal", "folder"],
    ));

    // 0.229.0: the search-scope pills become a declarative GROUP of real
    // toggles — one definition per Stashpad. Two wins over the hand-rolled
    // pill: each folder is individually findable in native settings search
    // (previously only the section was), and Obsidian's own toggle replaces a
    // hand-built role="switch" with its own keydown/aria handling, so
    // accessibility stops being ours to maintain.
    //
    // These are `render` defs rather than key-bound `control` defs on purpose:
    // the value is MEMBERSHIP IN AN ARRAY (searchExcludedFolders), not a
    // settings key, so there is nothing for `key` to bind to.
    //
    // Phrased as "Include in cross-Stashpad search" (ON = included) rather
    // than mirroring the stored `excluded` flag — a toggle labelled with a
    // negative reads backwards.
    for (const def of this.searchScopeGroup()) cats.foldersStorage.push(def);

    // 0.228.0: ported from a hand-rolled row+button list to the declarative
    // `type: "list"`. The framework supplies the delete affordance AND the
    // Delete/Backspace keyboard shortcut, plus the empty state — so this
    // DELETES row-rendering code rather than adding any, and each folder row
    // becomes individually searchable in native settings search.
    //
    // No `addItem` here on purpose: folders enter these lists from the panel's
    // right-click menu, not from settings. That also sidesteps the index
    // hazard — the mobile add-row is NOT part of the indexed `items` and is not
    // counted by onDelete indices, so a list WITH an add affordance has to map
    // indices carefully. This one maps 1:1.
    for (const def of this.folderPlacementLists()) cats.foldersStorage.push(def);

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
    cats.windowsTabs.push(toggle("Open Stashpad notes in Stashpad", "When a Stashpad note is opened in an ordinary editor tab — from the quick switcher, a wikilink in another note, the file explorer, a search result, or a third-party switcher — close that tab and show the note inside Stashpad instead. Off by default. Stashpad's own \"Open in Obsidian editor\" is exempt and always reaches the editor, so this cannot loop; switching to an editor tab you already had open is also left alone. Only notes with a Stashpad id in a known Stashpad folder are affected.",
      () => this.plugin.settings.openNotesInStashpad, (v) => { this.plugin.settings.openNotesInStashpad = v; }, ["open", "route", "redirect", "intercept", "editor", "switcher", "wikilink", "quick switcher"]));
    cats.windowsTabs.push(toggle("Search opens the note in its list (in context)", "When you pick a search result, open the LIST that contains the note (focus its parent) and scroll to the note — so you see it in context instead of landing on the focused-note header. On by default.",
      () => this.plugin.settings.searchOpensInContext, (v) => { this.plugin.settings.searchOpensInContext = v; }, ["search", "context", "list", "scroll", "parent"]));
    cats.windowsTabs.push(this.quickMenuSection());
    cats.windowsTabs.push(toggle("Open in new window — duplicate tab", "ON: the new-window button (in the time-filter row) duplicates the current Stashpad tab — original stays open in the main window. OFF: the leaf is MOVED to the new window, closing the original tab.",
      () => this.plugin.settings.popoutDuplicates, (v) => { this.plugin.settings.popoutDuplicates = v; }, ["popout", "window", "duplicate"]));
    cats.windowsTabs.push(toggle("Search results open in a new tab", "When you pick a result in the Search modal, open it in a new Stashpad tab instead of navigating the current tab. Applies to same-folder and cross-Stashpad results alike. On by default.",
      () => this.plugin.settings.searchOpensInNewTab, (v) => { this.plugin.settings.searchOpensInNewTab = v; }, ["search", "new tab", "results", "open"]));
    cats.windowsTabs.push(toggle("Folders always open in a new tab", "When you open a folder (folders panel, folder switcher, or the file-explorer “Open folder in Stashpad”), always open a NEW tab at the home note instead of reusing an already-open tab. The folder switcher also drops its “Reveal <folder> tab” option. Off by default (reuses an existing tab when there is one).",
      () => this.plugin.settings.foldersAlwaysNewTab, (v) => { this.plugin.settings.foldersAlwaysNewTab = v; }, ["folder", "new tab", "reveal", "open", "panel"]));
    cats.windowsTabs.push(toggle("New tabs open in the background", "When Stashpad opens something in a new tab — a folder, a note, an attachment, a reminder's task, an aggregate/tasks/trash view — the tab opens WITHOUT stealing focus; you stay where you are and switch when ready. Off by default (new tabs come to the front).",
      () => this.plugin.settings.newTabsInBackground, (v) => { this.plugin.settings.newTabsInBackground = v; }, ["background", "tab", "focus", "steal", "new"]));
    cats.composerCopy.push(toggle("Line numbers in the editor", "Show a line-number gutter beside the edit/split editor, and a line count alongside the word and character counts. Desktop only — on a phone the gutter costs width the editor needs more. On by default.",
      () => this.plugin.settings.showEditorLineNumbers, (v) => { this.plugin.settings.showEditorLineNumbers = v; }, ["line", "number", "gutter", "editor", "count"]));
    cats.composerCopy.push(toggle("Auto-pair Markdown syntax", "Brackets, parentheses, quotes (double + single, at word starts only — apostrophes are safe), inline code, **bold**, ~~strikethrough~~ and ==highlight== markers auto-close with the caret between them. Select text first and the character WRAPS it instead of replacing it (press again to nest: [note] → [[note]], *word* → **word**). Typing the closing character steps over an existing one, and Backspace on an empty pair removes both. Applies to the composer and the edit/split textareas. On by default.",
      () => this.plugin.settings.autoPairBrackets, (v) => { this.plugin.settings.autoPairBrackets = v; }, ["bracket", "autopair", "wikilink", "close", "complete"]));
    cats.composerCopy.push(this.copyTimestampModifiersSection());
    cats.composerCopy.push(toggle("Indent-safe copy (level markers)", "When copying a subtree (Copy tree / Copy focused subtree), prefix each line with a `[L1]`, `[L2]`, … depth marker instead of leading spaces — relative to what you copied, so the top of the selection is always `[L1]`. Survives pasting into apps that strip indentation. Off by default (normal indented outline).",
      () => this.plugin.settings.copyTreeLevelMarkers, (v) => { this.plugin.settings.copyTreeLevelMarkers = v; }, ["copy", "indent", "level", "marker", "tree", "depth", "paste"]));

    return cats;
  }

  /** 0.97.0: Encryption tab — Phase 1 KEY MANAGEMENT only (set / unlock /
   *  change / remove the vault password + the trash toggles). No file-encryption
   *  actions yet; those land in later phases. See docs/encryption-expansion-plan.md. */
  private encryptionItems(): SettingDefinitionItem[] {
    const enc = this.plugin.encryption;
    const items: SettingDefinitionItem[] = [];

    items.push(this.sectionDef("Vault Encryption", "Encrypt notes per folder with a password you choose. Keep that password in a password manager — there is no recovery if it is lost.", (host) => {
      host.addClass("stashpad-encryption-section");
      const betaRow = host.createDiv({ cls: "stashpad-beta-row" });
      betaRow.createEl("span", { cls: "stashpad-beta-badge", text: "BETA" });
      // 0.195.0: say the quiet part — beta code can lose data even when your key is
      // perfectly safe (a bug, an interrupted lock/unlock, a sync writing mid-op).
      betaRow.createEl("span", { cls: "stashpad-beta-note", text: "Encryption is in beta — data can be lost with or without your key. Keep your own unencrypted backups." });
      // 0.134.3: ONE merged warning callout (was three: the AI disclaimer box,
      // a ⚠️ description paragraph here, and a "no recovery" callout at the top
      // of the per-folder section). Same .stashpad-enc-warning callout style.
      const warn = host.createEl("div", { cls: "stashpad-enc-warning" });
      // 0.194.0: keychain loss leads, because it's the failure that actually happens.
      // (Real incident: a server/profile reset wiped the OS keychain and took the only
      // copy of a folder password with it.) The key itself lives in the folder's
      // `.stashkey`; the keychain only ever held a CONVENIENCE copy of the password —
      // so if that copy was the only one, the content is gone.
      warn.createEl("p", { cls: "stashpad-enc-lead" }).setText(
        "⚠️ Write your password down somewhere outside this computer — a password manager — BEFORE you encrypt anything.",
      );
      warn.createEl("p").setText(
        "“Remember on this device (keychain)” is a convenience, NOT a backup. An OS or keychain reset, a wiped/restored profile, a reinstall, a new machine, or an IT/server event can erase it at any time, without warning and without asking you. If the only copy of your password was in the keychain, everything encrypted under it is permanently unreadable — by you, by us, by anyone.",
      );
      // 0.209.7: name the concrete triggers, because "can be erased" reads as
      // hypothetical until you have seen it happen. Verified where these actually
      // live: Obsidian keeps saved secrets in the APP's local data (a
      // `…-secrets-encrypted` localStorage entry, encrypted via the OS), NOT inside
      // your vault — so a vault backup or sync does NOT carry them, and anything
      // that resets the app's local data takes them with it. Stashpad's own
      // IndexedDB use is the render cache only, which is rebuildable and holds no
      // key material.
      warn.createEl("p").setText(
        "Where it lives, and what wipes it: saved passwords are kept in Obsidian's local app data on this computer, not in your vault — so backing up or syncing your vault does NOT back them up. Downgrading or reinstalling Obsidian, clearing the app's local storage, a new profile, or a machine/server event at work can zero them out. The folder's key file (.stashkey) DOES live in your vault and survives all of that — but it can only be opened with the password. That is the whole reason to keep the password somewhere else.",
      );
      warn.createEl("p").setText(
        "Store the password in a password manager (1Password, Bitwarden, KeePass…) — that alone is what saves you, and it lives outside the keychain so it survives the events above. A Recovery password is a SECOND way in, but only helps if you keep it somewhere separate from the main one (a different manager, printed, or with someone you trust); two entries in the same manager add little. Do set one for SHARED folders — it survives a collaborator changing the main password.",
      );
      warn.createEl("p").setText(
        "⚠️ AI-built, NOT human-audited. This encryption was written by an AI assistant — not reviewed or security-audited by a human. Treat it as best-effort protection against a casual snoop, not a guarantee — and always keep your own unencrypted backups of anything important.",
      );
      warn.createEl("p").setText(
        "There is NO recovery. If you lose a password, anything encrypted under it (notes, archived items, encrypted-trash items) is gone for good. Locking, encrypted archiving, and secure-deleting permanently remove the plaintext — the encrypted copy is the only one left. (A plaintext archive only de-indexes notes from search; it does NOT encrypt them.)",
      );
      warn.createEl("p").setText(
        "Each device unlocks with its own password (it never leaves the device); collaborators get access by device approval, not a shared password. If everyone with access loses their password, the content is unrecoverable. While encrypting or decrypting, avoid having a sync/cloud service write the vault mid-operation — it can corrupt files.",
      );
      warn.createEl("p", { cls: "stashpad-enc-liability" }).setText(
        "No warranty of any kind. This encryption has never been audited, so it is not proven to protect anything. Stashpad cannot recover keys or passwords, and is not liable for the loss of keys, passwords or data, for a fault in this beta encryption, or for any harm that follows if it fails to keep your data private. Keeping your own backups — and deciding what is safe to trust it with — are yours to do.",
      );

      // 0.137.4: ONE collapsible, toggle-free "how it works" reference block, so
      // the individual setting rows below can stay one-liners instead of each
      // re-explaining hide-filenames / plaintext-archive / trash / inheritance.
      const info = host.createEl("details", { cls: "stashpad-enc-info" });
      info.createEl("summary", { text: "ℹ️ How Stashpad encryption works (concepts)" });
      const infoItem = (term: string, body: string): void => {
        const p = info.createEl("p", { cls: "stashpad-enc-info-item" });
        p.createEl("strong", { text: `${term} — ` });
        p.appendText(body);
      };
      infoItem("Per-folder passwords",
        "Encryption is per folder: give a folder its OWN password (a separate key) and its notes lock under that key. Subfolders inherit their nearest keyed ancestor's password. A folder with no password of its own (or inherited) is not encrypted. Share a folder by handing over its password out-of-band.");
      infoItem("Encrypt notes vs Hide filenames",
        "“Encrypt … notes” scrambles the note body into a locked .stashenc blob (the plaintext is removed). “Hide filenames” goes further: it replaces the on-disk name AND the placeholder title with a generic label, so a glance at the vault doesn't reveal WHAT is locked. Whether a title is hidden is decided when the note is locked.");
      infoItem("Archive: plaintext vs encrypted",
        "Every folder has its own “archive” subfolder. Archiving is a plain move by default — the notes drop out of cross-folder search but stay readable. Turn on “Encrypt archived notes” for a folder to lock notes as they're archived instead.");
      infoItem("Trash: Stashpad vs Obsidian",
        "Deleting a note normally sends it to that folder's own “trash” subfolder — encrypted if the folder encrypts its trash — and it's recoverable from the Trash view. Set a folder's “Trash handling” to “Obsidian native trash” to use Obsidian's plain deleted-files behavior instead (Stashpad can't encrypt or recover those).");
      infoItem("No recovery",
        "There is no backdoor and no reset. If a password is lost, everything encrypted under it is gone — so keep your own unencrypted backups of anything you can't afford to lose.");

      // 0.277.2: which companion/sidecar extensions get encrypted alongside a note
      // (default `.edtz` = the Edit History plugin). Comma/space-separated; each is
      // normalized to a leading dot. `.md` is rejected — a companion is matched as
      // `<noteBasename><ext>`, so `.md` would resolve to the note file itself.
      new Setting(host).setName("Companion files to encrypt")
        .setDesc("Sidecar files other plugins keep next to a note (matched as “<note><ext>” in the same folder) that should be locked inside the note's encrypted bundle and restored on unlock. Default “.edtz” covers the Edit History plugin. Comma-separated; leave blank to encrypt none.")
        .addText((t) => {
          t.setPlaceholder(".edtz, .vhistory")
            .setValue((this.plugin.settings.encryptCompanionExts ?? []).join(", "));
          const commit = async (): Promise<void> => {
            const raw = t.getValue();
            const seen = new Set<string>();
            const cleaned: string[] = [];
            const rejected: string[] = [];
            for (const tok of raw.split(/[\s,]+/)) {
              const s = tok.trim();
              if (!s) continue;
              const ext = (s.startsWith(".") ? s : `.${s}`).toLowerCase();
              if (ext === ".md") { rejected.push(ext); continue; } // would match the note itself
              if (!/^\.[a-z0-9][a-z0-9._-]*$/.test(ext)) { rejected.push(s); continue; }
              if (seen.has(ext)) continue;
              seen.add(ext); cleaned.push(ext);
            }
            this.plugin.settings.encryptCompanionExts = cleaned;
            await this.plugin.saveSettings();
            t.setValue(cleaned.join(", ")); // reflect the normalized value
            if (rejected.length) new Notice(`Ignored invalid companion extension${rejected.length === 1 ? "" : "s"}: ${rejected.join(", ")}${rejected.includes(".md") ? " (a note can't be its own companion)" : ""}.`);
          };
          t.inputEl.addEventListener("blur", () => void commit());
          t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } });
        });

      // 0.277.0: one-click Encrypt-all — confirm (naming what it sweeps) → a
      // blocking overlay that freezes the Stashpad UI → lock the full applicable
      // set (watchlist + folders set to encrypt notes/archive) → acknowledge.
      // Shown once any folder is keyed (nothing to sweep otherwise).
      if (enc.hasAnyFolderKey()) {
        new Setting(host).setName("Encrypt everything now")
          .setDesc("Locks everything that should be encrypted but is currently plaintext — notes you unlocked or restored, and any folder set to encrypt its notes or archive — in one pass. You confirm what it will sweep first; the UI is frozen while it runs. Companion sidecars (e.g. Edit History .edtz) are encrypted alongside their notes.")
          .addButton((b) => b.setButtonText("Encrypt everything now").setCta().onClick(() => void this.plugin.encryptAllNow()));
      }

      // 0.143.0: encryption is strictly per-folder now — set / unlock / change /
      // recover passwords per folder under "Per-Folder Passwords" below. This
      // top-level section only carries the vault-wide "remove all encryption"
      // safety valve (bulk-decrypt + delete every folder key). It's shown ONLY when
      // something is actually encrypted — nothing to remove otherwise.
      if (!enc.hasAnyFolderKey()) {
        new Setting(host).setName("Remove all encryption")
          .setDesc("Nothing is encrypted in this vault yet. Give a folder a password under “Per-Folder Passwords” below to start.");
      } else
      new Setting(host).setName("Remove all encryption").setDesc("Decrypts everything back to plaintext and deletes every folder's password/key. If anything is still locked, you'll be offered to decrypt it (needs each folder's password) or — if a password is lost — permanently delete it. Then type the confirmation phrase.").addButton((b) => {
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
                },
                "Cancel",
                // Irreversible — focus Cancel so a stray Enter (e.g. after an Esc
                // that opened this from the fork above) can't purge everything. 0.140.11
                /*dangerous*/ true).open();
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
                (discard) => { if (discard) proceedToConfirm(" ⚠️ The encrypted trash is being permanently discarded.", true); },
                "Cancel",
                // Esc on the fork above routes here — focus Cancel so a reflex
                // Enter can't confirm the permanent discard. 0.140.11
                /*dangerous*/ true).open();
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
        // 0.136.0: loading button — the state check can take a while on slow
        // (network) drives, and spam-clicks used to queue several removal runs
        // (each spawning its own "delete encrypted contents" modal). While the
        // check runs the button dims with a loading bar and SWALLOWS clicks.
        let removalBusy = false;
        b.setButtonText("Remove…").onClick(async () => {
          if (removalBusy) return;
          removalBusy = true;
          b.setDisabled(true);
          b.buttonEl.addClass("stashpad-btn-loading");
          try { await runRemoval(); }
          finally {
            removalBusy = false;
            b.setDisabled(false);
            b.buttonEl.removeClass("stashpad-btn-loading");
          }
        });
        b.buttonEl.addClass("mod-warning");
      });

      // Phase 5: retire the LEGACY central keyfile. Encryption is per-folder now; the
      // old `.stashpad/keys.json` is just a read-only backup. Retiring PARKS it
      // (reversible, KEEPS a recoverable backup); a separate hard-wipe permanently
      // deletes all old key material for users who want a clean removal (finding #1).
      const hardWipe = (): void => {
        new TypeToConfirmModal(this.app, {
          title: "Permanently delete the old key material?",
          body: "This PERMANENTLY deletes the old central keyfile (.stashpad/keys.json), its _keys/ backups, and any retired-keyfile backups — with NO copy kept and NO way to recover them. It does NOT touch your per-folder passwords or currently-encrypted content (use “Remove all encryption” above for those). Only do this if you're sure you'll never need the old key material back.",
          phrase: "DELETE KEY MATERIAL",
          confirmText: "Permanently delete",
          onConfirm: async () => {
            // 0.211.3: the wipe now REFUSES when a folder's key still lives only in
            // the old keyfile. Surface that refusal — without the catch it would be an
            // unhandled rejection and the user would see nothing happen at all, having
            // just typed a confirmation phrase.
            try {
              const n = await enc.wipeLegacyKeyMaterial();
              new Notice(n > 0 ? `Permanently deleted the old key material (${n} item${n === 1 ? "" : "s"}). Not recoverable.` : "No old key material found to delete.", 9000);
              this.update?.();
            } catch (e) { new Notice((e as Error).message, 12000); }
          },
        }).open();
      };
      if (enc.hasLegacyKeyfile()) {
        new Setting(host).setName("Retire the old encryption keyfile")
          .setDesc("This vault still has the old central keyfile (.stashpad/keys.json), kept only as a read-only backup now that encryption is per-folder. “Retire” MOVES it and its _keys/ backups into .stashpad/retired-keyfile-<date>/ — reversible, and a recoverable copy is KEPT (nothing is deleted). “Permanently delete” instead removes all old key material with no backup. Retire is blocked if any folder's key still lives only in the old keyfile.")
          .addButton((b) => b.setButtonText("Retire (keep backup)").onClick(async () => {
            try {
              const n = await enc.retireLegacyKeyfile();
              new Notice(`Retired the old keyfile — ${n} file${n === 1 ? "" : "s"} moved into .stashpad/retired-keyfile-… Reversible; a copy is kept.`, 9000);
              this.update?.();
            } catch (e) { new Notice((e as Error).message, 12000); }
          }))
          .addButton((b) => { b.setButtonText("Permanently delete…").onClick(hardWipe); b.buttonEl.addClass("mod-warning"); });
      } else if (enc.hasRecoverableKeyMaterial()) {
        // No live keyfile, but a prior retire left recoverable backups on disk — let
        // the user finish the job with a clean, permanent removal.
        new Setting(host).setName("Delete retired keyfile backups")
          .setDesc("The old keyfile was retired, but a recoverable backup is still on disk (.stashpad/retired-keyfile-… / _keys/). Permanently delete it if you no longer want it recoverable. Doesn't touch your per-folder passwords or encrypted content.")
          .addButton((b) => { b.setButtonText("Permanently delete…").onClick(hardWipe); b.buttonEl.addClass("mod-warning"); });
      }

      // (0.143.0: vault-wide setup/unlock/change-device/shared-password/collaborator
      // UI is gone — encryption is strictly per-folder. Share a folder by handing
      // over its folder password out-of-band.)
    }, ["encryption", "encrypt", "password", "passphrase", "lock", "unlock", "key", "security", "private", "folder", "share", "keyfile", "retire"]));

    items.push(this.headingDef("Encrypted-note defaults", "Global defaults for previously-encrypted notes. Per-folder encryption + trash options live under “Per-Folder Passwords” below."));
    // (0.143.0: the vault-wide "Encrypt items sent to trash" / "Encrypt trash
    // filenames" toggles are gone — encryption is per-folder, so trash encryption
    // is set per folder under "Per-Folder Passwords" (the "Encrypt trashed notes"
    // option). There is no vault key to encrypt a keyless folder's trash under.)
    // 0.138.0: re-encrypt sweep nudge (default OFF). Never auto-encrypts —
    // the Notice just carries a Review button into the watchlist view.
    items.push(this.renderDef("Remind me about unlocked encrypted notes", "On startup, if notes that WERE encrypted are still sitting plaintext (you unlocked them, or restored them from the trash), show a notice with a Review button that opens the “Previously encrypted” view. Nothing is ever re-encrypted automatically.", (s) =>
      s.addToggle((t) => t.setValue(this.plugin.settings.reEncryptNudge ?? false).onChange(async (v) => {
        this.plugin.settings.reEncryptNudge = v; await this.plugin.saveSettings();
      })), ["remind", "nudge", "re-encrypt", "watchlist", "unlocked", "sweep"]));
    items.push(this.renderDef("Auto re-encrypt after idle minutes (global)", "0 = OFF (default). After an unlocked, previously-encrypted note sits idle this long, Stashpad shows a “Re-encrypting in 10s… [Keep unlocked]” countdown you can cancel, then re-locks it. It NEVER re-encrypts a note you have open in an editor. Set per-folder overrides under “Per-Folder Passwords”; per-note in the “Previously encrypted” view.", (s) =>
      s.addText((t) => t.setValue(String(this.plugin.settings.reEncryptAfterMin ?? 0)).onChange(async (v) => {
        { const n = Number(v.trim()); if (v.trim() === "") this.plugin.settings.reEncryptAfterMin = 0; else if (Number.isFinite(n) && n >= 0) this.plugin.settings.reEncryptAfterMin = Math.floor(n); else { t.setValue(String(this.plugin.settings.reEncryptAfterMin ?? 0)); return; } await this.plugin.saveSettings(); }
      })), ["auto", "re-encrypt", "idle", "timer", "peek", "lock"]));
    // (0.135.0: "Auto-lock after idle minutes" removed — the surprise
    // key-forgetting caused more confusion than protection.)
    // (0.137.1: the global "Follow Obsidian's trash setting" and "Hide titles
    // of locked notes" options are gone — trash handling and filename-hiding
    // are per-folder now ("Per-Folder Passwords" below). Whether a title is
    // hidden is decided AT LOCK TIME by the folder's hide-filenames prefs and
    // stored in the placeholder, so display simply follows the stored title.)

    // (0.136.0: the global "Archive" section is gone — every folder owns an
    // `archive/` subfolder now; "Move selection to archive" always targets the
    // current folder's own archive. Per-folder encryption of archived notes
    // lives under "Per-Folder Passwords" below.)
    items.push(this.headingDef("Archive", "Every folder has its own “archive” subfolder: “Move selection to archive” tucks notes into it, archived notes drop out of search, and everything shows up in the aggregated Archived view. Whether a folder's archive is encrypted is set per folder under “Per-Folder Passwords” below (“Encrypt archived notes”)."));

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
    this.plugin.trace("settings:hotkey-items", { rows: rows.length });
    return [intro, ...rows];
  }

  /** 0.268.7 diagnostic: the Hotkeys page is by far the heaviest — one row per
   *  command, each building a segmented control, two inputs and four buttons.
   *  Rows render one at a time, so the interesting number is the TOTAL for the
   *  page, not any single row. Accumulate and emit one line once the synchronous
   *  render burst finishes, so a slow page costs one trace line rather than 58.
   *
   *  This is what separates the two candidate causes of a frozen window: a
   *  single large `ms` here means the page itself is slow to build, whereas a
   *  small `ms` repeated many times means something is re-rendering it in a
   *  loop and the render cost is incidental. */
  private itemRenderMs = new Map<string, number>();
  private itemRenderRows = new Map<string, number>();
  private itemRenderFlush: number | null = null;

  private noteItemRender(page: string, ms: number): void {
    // Mark the START of a burst as its own line. If the window hangs partway
    // through, the flush below never runs — so a "begin" with no matching
    // "settings:item-render" after it is the finding, not a gap in the data.
    if (this.itemRenderFlush === null) this.plugin.trace("settings:item-render-begin");
    this.itemRenderMs.set(page, (this.itemRenderMs.get(page) ?? 0) + ms);
    this.itemRenderRows.set(page, (this.itemRenderRows.get(page) ?? 0) + 1);
    if (this.itemRenderFlush !== null) return;
    this.itemRenderFlush = window.setTimeout(() => {
      this.itemRenderFlush = null;
      // Slowest page first: with every section covered, the ordering is the
      // answer to "which one is expensive" without reading the whole line.
      const rows = [...this.itemRenderMs.entries()].sort((a, b) => b[1] - a[1]);
      for (const [page, total] of rows) {
        this.plugin.trace("settings:item-render", {
          page,
          rows: this.itemRenderRows.get(page) ?? 0,
          ms: Math.round(total),
        });
      }
      this.itemRenderMs.clear();
      this.itemRenderRows.clear();
    }, 0);
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

    // 0.238.0: scope for the swatch-click bulk recolour. Off by default —
    // rewriting every note of a colour across the whole vault should be
    // deliberate, not something you discover after doing it.
    new Setting(parent)
      .setName("Recolor across all Stashpads")
      .setDesc("When you click a color swatch below to recolor, apply it to EVERY Stashpad instead of just the one selected above. Colors usually mean the same thing everywhere, so this is for \u201cchange every red note to orange\u201d. Off by default.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.bulkRecolorAllFolders)
        .onChange(async (v) => {
          this.plugin.settings.bulkRecolorAllFolders = v;
          await this.plugin.saveSettings();
        }));

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
      (s) => s.addText((t) => {
        t.setValue(this.plugin.settings.authorName).onChange(async (v) => {
          // Persist the name per keystroke (cheap) so it's saved even if the
          // settings close before blur — but DON'T run the vault-wide stub
          // rename here: syncAuthorFilesToName renamed every _authors stub to
          // each intermediate ("j-…", "ja-…") and logged junk into the rename
          // history. Defer it to commit (blur/Enter). 0.140.11
          this.plugin.settings.authorName = v.trim();
          if (this.plugin.settings.authorName && !this.plugin.settings.authorId) this.plugin.settings.authorId = newId();
          await this.plugin.saveSettings();
        });
        const commit = () => void this.plugin.syncAuthorFilesToName();
        t.inputEl.addEventListener("blur", commit);
        t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") commit(); });
      }), ["author", "name", "identity", "stamp"]));
    items.push(this.renderDef("Author id (auto-assigned)",
      "Stable id appended to your name on links so coworkers with the same name don't collide. Generated once and shouldn't change. To reset it, clear and retype your author name.",
      (s) => s.addText((t) => t.setValue(this.plugin.settings.authorId).setDisabled(true)), ["author", "id"]));
    items.push(this.renderDef("Title / role",
      "Optional. Shown on your author page (e.g. \"Engineer\", \"PM\", \"Designer\").",
      (s) => s.addText((t) => {
        t.setValue(this.plugin.settings.authorRole).onChange(async (v) => {
          this.plugin.settings.authorRole = v.trim(); await this.plugin.saveSettings();
        });
        const commit = () => void this.plugin.syncAuthorFilesToName(); // rewrite stubs on commit, not per keystroke (0.140.11)
        t.inputEl.addEventListener("blur", commit);
        t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") commit(); });
      }), ["role", "title", "job"]));
    items.push(this.renderDef("Department / team",
      "Optional. Shown on your author page (e.g. \"Engineering\", \"Growth\").",
      (s) => s.addText((t) => {
        t.setValue(this.plugin.settings.authorDepartment).onChange(async (v) => {
          this.plugin.settings.authorDepartment = v.trim(); await this.plugin.saveSettings();
        });
        const commit = () => void this.plugin.syncAuthorFilesToName();
        t.inputEl.addEventListener("blur", commit);
        t.inputEl.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") commit(); });
      }), ["department", "team"]));
    const footerToggle = (name: string, get: () => boolean, put: (v: boolean) => void, aliases: string[]): SettingDefinitionItem =>
      this.renderDef(name, "", (s) => s.addToggle((t) => t.setValue(get()).onChange(async (v) => { put(v); await this.plugin.saveSettings(); })), aliases);
    items.push(footerToggle("Show author in note footer", () => this.plugin.settings.showAuthor, (v) => { this.plugin.settings.showAuthor = v; }, ["author", "footer", "show"]));
    items.push(footerToggle("Show contributors in note footer", () => this.plugin.settings.showContributors, (v) => { this.plugin.settings.showContributors = v; }, ["contributors", "footer", "show"]));
    items.push(footerToggle("Show last edit time in note footer", () => this.plugin.settings.showLastEdit, (v) => { this.plugin.settings.showLastEdit = v; }, ["last edit", "modified", "footer", "time"]));
    items.push(footerToggle("Author names are clickable links", () => this.plugin.settings.authorNamesAsLinks, (v) => { this.plugin.settings.authorNamesAsLinks = v; }, ["author", "contributor", "link", "clickable", "footer"]));
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
  openSettingsPage(pageName: string): void {
    // Obsidian has no public API to open a plugin's own settings SUB-PAGE (see
    // docs/obsidian-limitations.md). Best-effort: reset to the Stashpad page list,
    // then click the matching entry — but ONLY inside the active tab's CONTENT
    // pane, never the left sidebar (whose core/community plugin tabs, e.g. the core
    // "Templates" plugin, would otherwise match by name and mis-navigate). If we
    // can't find it in-content, we DON'T guess — we just point the way.
    const hint = () => new Notice(`Open Settings → Stashpad → ${pageName}.`);
    try {
      const setting = (this.app as App & { open?: () => void; setting?: { openTabById?: (id: string) => void; modalEl?: HTMLElement } } & { setting?: { open?: () => void } }).setting as
        { open?: () => void; openTabById?: (id: string) => void; modalEl?: HTMLElement } | undefined;
      if (!setting?.openTabById) { hint(); return; }
      // 0.283.1: the modal may not be open yet (a command fired it), and the page
      // list renders async — the old single 60ms probe raced the first open, so
      // the very first invocation "opened Stashpad but not the section". Open the
      // modal, land on the Stashpad page list, then POLL for the row.
      setting.open?.();
      setting.openTabById("stashpad");
      const deadline = Date.now() + 1500;
      const tryClick = (): void => {
        const content = setting.modalEl?.querySelector<HTMLElement>(".vertical-tab-content");
        const hit = content
          ? Array.from(content.querySelectorAll<HTMLElement>(".setting-item-name, *"))
              .find((e) => e.childElementCount === 0 && e.textContent?.trim() === pageName && !e.closest(".vertical-tab-header"))
          : undefined;
        const link = hit?.closest<HTMLElement>("[class*='nav'], .setting-item, button, a");
        if (link && !link.closest(".vertical-tab-header")) { link.click(); return; }
        if (Date.now() < deadline) { window.setTimeout(tryClick, 50); return; }
        hint();
      };
      window.setTimeout(tryClick, 50);
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
          const vaultWide = this.plugin.settings.bulkRecolorAllFolders;
          let touched: number;
          if (vaultWide) {
            const res = await this.plugin.recolorEverywhere(hex, newColor ?? null);
            touched = res.total;
            const folders = Object.keys(res.byFolder);
            if (touched > 0) {
              // Name the folders. A bare total hides that one folder may
              // account for all of it — and this write crossed folders the
              // user was not looking at, so it has to say where it landed.
              const where = folders.length <= 3
                ? folders.join(", ")
                : `${folders.slice(0, 3).join(", ")} +${folders.length - 3} more`;
              new Notice(`Recolored ${touched} note${touched === 1 ? "" : "s"} across ${folders.length} Stashpad${folders.length === 1 ? "" : "s"}: ${where}`);
            }
          } else {
            touched = await this.plugin.recolorAllInFolder(folder, hex, newColor ?? null);
            if (touched > 0) new Notice(`Recolored ${touched} note${touched === 1 ? "" : "s"}.`);
          }
          if (touched === 0 && count === 0) {
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

  /** 0.95.2: settings-window mirror of the folder panel's pin/downrank/hide
   *  placements — lists each customized folder grouped by state with a control
   *  to restore it to normal. The panel's right-click menu is where you SET
   *  these; this is the at-a-glance overview + a second place to restore. */
  /** 0.229.0: cross-Stashpad search scope as a searchable group of toggles.
   *  Replaces renderFolderScopeRow's hand-rolled pill. */
  private searchScopeGroup(): SettingDefinitionItem[] {
    const folders = this.plugin.discoverStashpadFolders();
    const out: SettingDefinitionItem[] = [];
    if (folders.length === 0) {
      // Unchanged from the old empty state: the "what IS a Stashpad" answer
      // lives in Help & Getting started, where someone looking for it can find
      // it — it must not live only inside a section about search scope.
      // Keep the HEADING even when the list is empty. sectionDef strips
      // `.setting-item`, so a bare paragraph rendered a wall of text with no
      // heading — the section became unidentifiable, which is exactly how a
      // stale empty state managed to look like a layout bug rather than a
      // missing list.
      out.push(this.sectionDef("Cross-folder search scope", "", (host) => {
        new Setting(host).setName("Cross-folder search scope").setHeading();
        host.createEl("p", { cls: "setting-item-description" }).setText(
          "No Stashpads found in this vault yet. See the “Help & Getting started” tab for what a Stashpad is and how to make your first one — or create one below.",
        );
      }, ["search", "scope", "stashpad", "folder"]));
    } else {
      out.push({
        type: "group",
        heading: "Cross-folder search scope",
        // 1.13.1: a search box scoped to this group. Useful the moment someone
        // has more than a handful of Stashpads, which is exactly when scanning
        // the list by eye stops working.
        search: {
          placeholder: "Filter Stashpads…",
          match: (def: any, query: string) => {
            // Sift semantics (docs/sift.md): all tokens, any order, case-insensitive.
            const hay = `${def?.name ?? ""} ${(def?.aliases ?? []).join(" ")}`.toLowerCase();
            return query.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
          },
        },
        items: folders.map((folder) => this.renderDef(
          folder,
          "Included — notes here appear in cross-Stashpad search. Off excludes them; excluded folders are still valid move destinations.",
          (s) => {
            s.addToggle((t) => t
              .setValue(!(this.plugin.settings.searchExcludedFolders ?? []).includes(folder))
              .onChange(async (included) => {
                // Recompute from the CURRENT setting each time rather than
                // closing over a snapshot — another surface may have changed
                // the list while this page was open.
                const list = new Set(this.plugin.settings.searchExcludedFolders ?? []);
                if (included) list.delete(folder); else list.add(folder);
                this.plugin.settings.searchExcludedFolders = [...list].sort();
                await this.plugin.saveSettings();
              }));
          },
          ["search", "scope", "exclude", "include", "stashpad", "folder", folder.toLowerCase()],
        )),
      } as SettingDefinitionItem);
    }
    // The create-a-Stashpad action stays its own row, below the group.
    out.push(this.renderDef(
      "Create a new Stashpad",
      "Type a vault-relative folder path. The folder is created (with intermediates) and seeded with a Home note so Stashpad recognizes it.",
      (s) => {
        let nameInput: HTMLInputElement | null = null;
        s.addText((t) => { t.setPlaceholder("my-stashpad"); nameInput = (t as any).inputEl as HTMLInputElement; })
          .addButton((b) => b.setButtonText("Create").setCta().onClick(async () => {
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
      },
      ["create", "new", "stashpad", "folder"],
    ));
    return out;
  }

  /** 0.228.0: the folder-panel placement editor as declarative lists — one
   *  `type: "list"` per bucket (Pinned / Downranked / Hidden).
   *
   *  Each folder is its own definition, so native settings search finds a
   *  folder by name instead of only finding the section. `onDelete` gives both
   *  the delete button and the Delete/Backspace shortcut for free. */
  private folderPlacementLists(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const out: SettingDefinitionItem[] = [];

    type Placement = "normal" | "pinned" | "downranked" | "hidden";
    const PLACEMENT_LABELS: Record<Placement, string> = {
      normal: "Normal",
      pinned: "Pinned to top",
      downranked: "Downranked",
      hidden: "Hidden",
    };

    const placementOf = (folder: string): Placement =>
      (s.folderPanelPinned ?? []).includes(folder) ? "pinned"
        : (s.folderPanelDownranked ?? []).includes(folder) ? "downranked"
          : (s.folderPanelHidden ?? []).includes(folder) ? "hidden"
            : "normal";

    /** Single writer for a folder's placement. Always clears the folder from
     *  ALL THREE lists first — the three states are mutually exclusive, and a
     *  folder that ended up both pinned and hidden would render inconsistently
     *  depending on which list a given surface checked first. */
    const setPlacement = async (folder: string, next: Placement): Promise<void> => {
      s.folderPanelPinned = (s.folderPanelPinned ?? []).filter((f) => f !== folder);
      s.folderPanelDownranked = (s.folderPanelDownranked ?? []).filter((f) => f !== folder);
      s.folderPanelHidden = (s.folderPanelHidden ?? []).filter((f) => f !== folder);
      if (next === "pinned") s.folderPanelPinned = [...s.folderPanelPinned, folder];
      else if (next === "downranked") s.folderPanelDownranked = [...s.folderPanelDownranked, folder];
      else if (next === "hidden") s.folderPanelHidden = [...s.folderPanelHidden, folder];
      await this.plugin.saveSettings();
      // Rebuild: the row has to move between sections, which no in-place
      // mutation can express.
      this.update?.();
    };

    /** 0.233.0: every folder row now carries a placement dropdown, so this page
     *  can SET a placement instead of only undoing one. Previously the only way
     *  in was the folder panel's right-click menu, which made the settings
     *  section a read-only mirror — it could undo but never do. */
    const rowDef = (folder: string, extraAliases: string[]): SettingDefinitionItem =>
      this.renderDef(
        folder,
        "",
        (row) => {
          row.addDropdown((dd) => {
            (Object.keys(PLACEMENT_LABELS) as Placement[]).forEach((k) => dd.addOption(k, PLACEMENT_LABELS[k]));
            // Read the placement at RENDER time, not from the enclosing loop —
            // another surface (the folder panel) may have changed it since the
            // definitions were built.
            dd.setValue(placementOf(folder));
            dd.onChange((v) => { void setPlacement(folder, v as Placement); });
          });
        },
        ["folder", "panel", "placement", "pin", "downrank", "hide", folder.toLowerCase(), ...extraAliases],
      );

    const buckets: Array<{ key: "folderPanelPinned" | "folderPanelDownranked" | "folderPanelHidden"; label: string; verb: string }> = [
      { key: "folderPanelPinned", label: "Pinned folders", verb: "pin" },
      { key: "folderPanelDownranked", label: "Downranked folders", verb: "downrank" },
      { key: "folderPanelHidden", label: "Hidden folders", verb: "hide" },
    ];
    const customized = new Set<string>();
    for (const g of buckets) {
      // Snapshot the sorted order ONCE and index onDelete into THIS array, so
      // the row the user deleted is the folder that gets reset even though the
      // stored array is unsorted.
      const folders = [...(s[g.key] ?? [])].sort();
      folders.forEach((f) => customized.add(f));
      out.push({
        type: "list",
        heading: folders.length ? `${g.label} (${folders.length})` : g.label,
        emptyState: `No ${g.label.toLowerCase()}. Use the dropdown beside a folder below to ${g.verb} it — or right-click it in the Stashpad folder panel.`,
        // Delete = "reset to Normal". Kept alongside the dropdown because it is
        // the one-gesture path for the common case, and it carries the
        // Delete/Backspace shortcut.
        onDelete: (index: number) => { void setPlacement(folders[index], "normal"); },
        items: folders.map((folder) => rowDef(folder, [g.label.toLowerCase()])),
      } as SettingDefinitionItem);
    }

    // 0.233.0: the fourth section — every Stashpad NOT already customized.
    // Without it the page could only ever show folders you had already acted on
    // elsewhere, so there was no way in.
    //
    // A plain `group`, not a `list`: there is nothing to delete here (these
    // folders have no placement to remove), and a delete affordance on a row
    // whose state is already Normal would be a no-op control.
    const others = this.plugin.discoverStashpadFolders()
      .filter((f) => !customized.has(f))
      .sort();
    out.push({
      type: "group",
      heading: others.length ? `Other folders (${others.length})` : "Other folders",
      search: {
        placeholder: "Filter folders…",
        match: (def: any, query: string) => {
          const hay = `${def?.name ?? ""} ${(def?.aliases ?? []).join(" ")}`.toLowerCase();
          return query.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
        },
      },
      items: others.length
        ? others.map((folder) => rowDef(folder, ["other", "uncustomized", "normal"]))
        : [this.sectionDef("", "", (host) => {
            host.createEl("p", { cls: "setting-item-description" }).setText(
              customized.size
                ? "Every Stashpad in this vault has a placement set above."
                : "No Stashpads found in this vault yet.",
            );
          })],
    } as SettingDefinitionItem);
    return out;
  }

  /** One settings row: label + 2 chord recorders + active-slot toggle. */
  // 0.268.14: the per-row timing wrapper that used to live here is gone. Every
  // item's render is now wrapped centrally in instrumentDefs, which already
  // covers these rows — keeping both would double-count them.
  private renderBindingRow(row: Setting, meta: CommandMeta): void {
    row.setName(meta.label).setDesc(meta.desc);
    row.settingEl.addClass("stashpad-binding-row");
    // 0.268.17: a MISSING entry used to throw right here — `get()[which]` on
    // undefined — and that single throw killed the whole Hotkeys page and the
    // settings navigation with it. It happened when a synced device running an
    // older build wrote a bindings map that predates a command and this one
    // adopted it wholesale (fixed at source in main.ts, healAdoptedBindings).
    //
    // Restored at its shipped default rather than skipped, so a row that came
    // back empty still works and still shows the chord the user expects. Kept
    // even with the source fixed: this is the last line between one absent key
    // and an unusable settings window, and it costs a property check.
    if (!this.plugin.settings.bindings[meta.id]) {
      this.plugin.trace("settings:binding-missing", { id: meta.id });
      this.plugin.settings.bindings[meta.id] = {
        primary: meta.defaultPrimary,
        secondary: meta.defaultSecondary ?? "",
        preferRight: false,
        useBoth: !!meta.defaultUseBoth,
      };
      void this.plugin.saveSettings();
    }
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
          // Non-blocking conflict warning: if this chord is already bound to a
          // DIFFERENT command, whichever matchBinding runs first in view.ts wins,
          // so a silent double-bind is confusing. Still allow it. 0.140.16
          const clash = COMMAND_META.find((m) => {
            if (m.id === meta.id) return false;
            const b = this.plugin.settings.bindings[m.id];
            return !!b && (b.primary === chord || b.secondary === chord);
          });
          if (clash) new Notice(`Note: ${prettifyChord(chord)} is also bound to "${clash.label}". Both will trigger; the first match wins.`, 6000);
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
