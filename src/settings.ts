import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type StashpadPlugin from "./main";
import { RESERVED_FRONTMATTER, type ViewMode } from "./types";
import { LogModal, ColorPickerModal, NotificationHistoryModal } from "./modals";
import { CATEGORY_LABELS, type NotificationCategory } from "./notifications";
import { startHotkeyRecording, prettifyChord } from "./hotkey-recorder";
import { DEFAULT_STOPWORDS } from "./slug-service";
import { newId } from "./id-service";
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
  | "cloneStashpadTab" | "selectAll" | "copyCodeBlock";

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
  { id: "toggleComplete",  label: "Toggle complete (strikethrough)", desc: "Default: Mod+Enter — marks selected/focused notes as complete.",                       defaultPrimary: "Mod+Enter" },
  { id: "moveUp",          label: "Move note up",                  desc: "Default: Mod+ArrowUp",                                                                    defaultPrimary: "Mod+ArrowUp" },
  { id: "moveDown",        label: "Move note down",                desc: "Default: Mod+ArrowDown",                                                                  defaultPrimary: "Mod+ArrowDown" },
  { id: "moveToTop",       label: "Move note to top",              desc: "Default: Mod+Shift+ArrowUp",                                                              defaultPrimary: "Mod+Shift+ArrowUp" },
  { id: "moveToBottom",    label: "Move note to bottom",           desc: "Default: Mod+Shift+ArrowDown",                                                            defaultPrimary: "Mod+Shift+ArrowDown" },
  { id: "outdent",         label: "Outdent (move to grandparent)", desc: "Default: Mod+[ — re-parents the selection one level up.",                                defaultPrimary: "Mod+[" },
  { id: "setColor",        label: "Set note color",                desc: "Default: Shift+: — open the color picker for the selection.",                              defaultPrimary: "Shift+:" },
  { id: "clone",           label: "Clone (duplicate / copy) selection", desc: "Default: Mod+Shift+D — clone selected notes (with their subtrees) as siblings.",   defaultPrimary: "Mod+Shift+D" },
  { id: "insertTemplate",  label: "Insert template (clone an existing note)", desc: "Pick any note in this Stashpad; clone it (with subtree + attachments) into the current view, retimestamped.", defaultPrimary: "" },
  { id: "toggleExpand",    label: "Show more / show less (expand toggle)", desc: "Default: Shift+? — toggle the clamp on the cursor row (or every selected row).", defaultPrimary: "Shift+?" },
  { id: "exportStash",     label: "Export selection to .stash",    desc: "Export the selected subtree(s) as a .stash bundle (notes + attachments).",                defaultPrimary: "" },
  { id: "importStash",     label: "Import .stash file",            desc: "Open the .stash bundle picker and import its notes into this Stashpad.",                  defaultPrimary: "" },
  { id: "pickFolder",      label: "Switch this Stashpad tab to another folder", desc: "Open the folder picker so this tab shows a different Stashpad.",            defaultPrimary: "" },
  { id: "cloneStashpadTab",label: "Clone (duplicate / copy) this Stashpad tab", desc: "Open a second tab on the same folder + focus, mirroring the \"copy\" button in the focused-header actions.", defaultPrimary: "" },
  { id: "selectAll",       label: "Select all notes in view",      desc: "Default: Mod+A — adds every visible row to the selection.",                              defaultPrimary: "Mod+A" },
  { id: "copyCodeBlock",   label: "Copy code from codeblock",      desc: "Default: { — copy the contents of the cursor row's first codeblock (or pick one when multiple exist).", defaultPrimary: "{" },
];

export function buildDefaultBindings(): CommandBindingMap {
  const out: Partial<CommandBindingMap> = {};
  for (const m of COMMAND_META) {
    out[m.id] = { primary: m.defaultPrimary, secondary: "", preferRight: false };
  }
  return out as CommandBindingMap;
}

export interface StashpadSettings {
  folder: string;
  importDropFolder: string;
  exportFolder: string;
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
  /** Per-folder filter: hide notes marked complete, UNLESS they have an
   *  incomplete descendant. Applied uniformly to every visible item
   *  (every node in the displayed list, not just the top level) — so a
   *  completed leaf is always hidden, and a completed parent stays
   *  visible only if there's still work somewhere in its subtree.
   *  Default false. */
  hideCompletedNotes: Record<string, boolean>;
  /** Notification categories the user has silenced. Empty by default —
   *  every toast renders. Set per-category by the settings UI (commit
   *  0.55.5 wires this up). Stored as a string array on disk so future
   *  categories load gracefully. */
  mutedNotificationCategories: string[];
  /** Notification history buffer cap. 0 or negative = unlimited.
   *  Default 5000. Persisted alongside the live history in
   *  `<pluginDir>/notifications.json`. */
  notificationHistoryLimit: number;
  /** Per-folder composer draft text. Stored in the plugin's data.json. */
  drafts: Record<string, string>;
  /** Per-folder: the text most recently sent via Enter, used to suppress
   *  the "restore draft" suggestion if the saved draft happens to match. */
  lastSubmitted: Record<string, string>;
}

export const DEFAULT_SETTINGS: StashpadSettings = {
  folder: "Stashpad",
  importDropFolder: "_imports",
  exportFolder: "_exports",
  useTemplatesFormat: false,
  prefixTimestampsOnCopy: true,
  splitOnLines: false,
  confirmCrossParentDrag: true,
  confirmBulkDelete: true,
  confirmAttachmentDelete: true,
  autofocusComposerAfterSend: true,
  popoutDuplicates: true,
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
  mutedNotificationCategories: [],
  notificationHistoryLimit: 5000,
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

export class StashpadSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: StashpadPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Stashpad", cls: "stashpad-settings-title" });

    // 0.62.4: Log section promoted to the top of settings — diagnostic
    // shortcuts (log file, notification history) are usually what
    // people open Settings for, and burying them below Authorship +
    // General was a tax. Authorship + the rest follow.
    containerEl.createEl("h3", { text: "Log" });
    new Setting(containerEl)
      .setName("Open log file")
      .setDesc("Append-only history of creates, deletes, parent changes, renames. Stored alongside the plugin's other private files.")
      .addButton((b) =>
        b.setButtonText("Open log").onClick(async () => {
          const adapter = this.app.vault.adapter;
          const path = this.plugin.pluginPrivatePath("log.jsonl");
          if (!(await adapter.exists(path))) {
            new Notice("No log yet — make some changes first.");
            return;
          }
          const data = await adapter.read(path);
          new LogModal(this.app, data, path).open();
        }));

    new Setting(containerEl)
      .setName("Notification history limit")
      .setDesc("Maximum number of notifications kept in the persistent history. Set to 0 for unlimited (the file size grows with usage; expect a few hundred KB per ~5000 entries). Default: 5000.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.notificationHistoryLimit ?? 5000))
          .setPlaceholder("5000")
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n)) return;
            this.plugin.settings.notificationHistoryLimit = n;
            this.plugin.notifications.setHistoryLimit(n);
            await this.plugin.saveSettings();
          }));

    // Per-category mute settings — collapsed by default to keep the
    // settings tab scannable. Toggling here updates both
    // settings.mutedNotificationCategories AND the runtime service
    // so muting takes effect immediately, no reload required.
    const muteDetails = containerEl.createEl("details", { cls: "stashpad-notif-mute-details" });
    muteDetails.createEl("summary", { text: "Mute notification categories" });
    const muteHelp = muteDetails.createDiv({ cls: "stashpad-notif-mute-help" });
    muteHelp.setText("Muted categories don't pop toasts but still appear in the history panel so you can review what was suppressed.");
    const muted = new Set<NotificationCategory>(
      (this.plugin.settings.mutedNotificationCategories ?? []) as NotificationCategory[],
    );
    const categories = Object.keys(CATEGORY_LABELS) as NotificationCategory[];
    for (const cat of categories) {
      const meta = CATEGORY_LABELS[cat];
      new Setting(muteDetails)
        .setName(meta.label)
        .setDesc(meta.desc)
        .addToggle((t) =>
          t.setValue(!muted.has(cat)).onChange(async (showOn) => {
            // Toggle reads "show this category" — checked = show, unchecked = mute.
            const muteOn = !showOn;
            if (muteOn) muted.add(cat);
            else muted.delete(cat);
            this.plugin.settings.mutedNotificationCategories = Array.from(muted);
            this.plugin.notifications.setMuted(cat, muteOn);
            await this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName("Notification history")
      .setDesc("Browse the last 200 toasts. Filter by category. Live-updates as new notifications arrive. Muted categories still appear here so you can review what was suppressed.")
      .addButton((b) =>
        b.setButtonText("View notification history").onClick(() => {
          new NotificationHistoryModal(
            this.app,
            this.plugin.notifications,
            async (folder) => {
              // Open-log shortcut from inside the history modal. Falls
              // back to the per-plugin log when no folder is supplied
              // (the history just hasn't recorded any folder-scoped
              // entries yet).
              const adapter = this.app.vault.adapter;
              const path = this.plugin.pluginPrivatePath("log.jsonl");
              if (!(await adapter.exists(path))) {
                new Notice("No log yet — make some changes first.");
                return;
              }
              const data = await adapter.read(path);
              new LogModal(this.app, data, path).open();
              void folder;
            },
            this.plugin.settings.authorId || null,
            (id) => this.plugin.lookupNoteAuthorIds(id),
          ).open();
        }));

    // Authorship reinserted between Log and General per 0.62.4.
    this.renderAuthorshipSection(containerEl);

    containerEl.createEl("h3", { text: "General" });

    new Setting(containerEl)
      .setName("Stashpad notes folder")
      .setDesc("Vault-relative folder where Stashpad stores its notes and attachments. Created on demand.")
      .addText((t) =>
        t.setValue(this.plugin.settings.folder).setPlaceholder("Stashpad").onChange(async (v) => {
          const cleaned = (v || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.folder;
          const last = cleaned.split("/").filter(Boolean).pop() ?? "";
          const reserved = new Set([
            this.plugin.settings.importDropFolder,
            this.plugin.settings.exportFolder,
            "_attachments",
            "_processed",
          ].map((s) => (s ?? "").trim().replace(/^\/+|\/+$/g, "")).filter(Boolean));
          if (reserved.has(last)) {
            new Notice(`"${cleaned}" uses a reserved Stashpad subfolder name. Pick something else.`);
            return; // don't save
          }
          this.plugin.settings.folder = cleaned;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Stash import subfolder")
      .setDesc("Subfolder name (relative to each Stashpad folder) where dropped .stash files auto-import. Created on demand. Leave blank to disable auto-import.")
      .addText((t) =>
        t.setValue(this.plugin.settings.importDropFolder).setPlaceholder("_imports").onChange(async (v) => {
          this.plugin.settings.importDropFolder = (v || "").trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Stash export subfolder")
      .setDesc("Subfolder name (relative to each Stashpad folder) where exports land. Must differ from the import subfolder above.")
      .addText((t) =>
        t.setValue(this.plugin.settings.exportFolder).setPlaceholder("_exports").onChange(async (v) => {
          const cleaned = (v || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.exportFolder;
          this.plugin.settings.exportFolder = cleaned;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Rebootstrap existing Stashpad folders")
      .setDesc("Walk every folder that has a home note: ensure infrastructure (_imports, _exports, drafts file), backfill the redundant parentLink + children frontmatter fields, AND rename any note whose filename slug no longer matches its body's first line. Safe to run anytime; skip-if-equal means already-synced notes are no-op writes.")
      .addButton((b) =>
        b.setButtonText("Rebootstrap now").onClick(async () => {
          b.setDisabled(true).setButtonText("Working…");
          try {
            const { touched, fmChecked, fmWritten, slugsRenamed } = await this.plugin.rebootstrapAllFolders();
            const parts: string[] = [];
            parts.push(`rebootstrapped ${touched.length} folder${touched.length === 1 ? "" : "s"}`);
            if (fmWritten > 0) parts.push(`updated frontmatter on ${fmWritten} of ${fmChecked} notes`);
            else if (fmChecked > 0) parts.push(`frontmatter already in sync (${fmChecked} notes checked)`);
            if (slugsRenamed > 0) parts.push(`renamed ${slugsRenamed} note${slugsRenamed === 1 ? "" : "s"} to match body`);
            new Notice(`Stashpad: ${parts.join("; ")}.`);
          } catch (e) {
            new Notice(`Stashpad: rebootstrap failed (${(e as Error).message})`);
          } finally {
            b.setDisabled(false).setButtonText("Rebootstrap now");
          }
        }));

    new Setting(containerEl)
      .setName("Use Templates plugin date/time formats")
      .setDesc("When on, timestamps use the formats configured in the core Templates plugin. Off: YYYY.MM.DD + HH:mm A.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useTemplatesFormat).onChange(async (v) => {
          this.plugin.settings.useTemplatesFormat = v;
          await this.plugin.saveSettings();
        }));

    const fmt = getTemplatesFormats(this.app);
    const info = containerEl.createDiv({ cls: "setting-item-description stashpad-settings-note" });
    info.setText(fmt
      ? `Templates plugin: date = "${fmt.dateFormat}", time = "${fmt.timeFormat}"`
      : "Templates plugin not enabled.");

    new Setting(containerEl)
      .setName("Confirm cross-parent drag-and-drop")
      .setDesc("When dragging notes onto a note that has a different parent, ask before re-parenting (turn off to allow direct moves).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmCrossParentDrag).onChange(async (v) => {
          this.plugin.settings.confirmCrossParentDrag = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Confirm bulk deletes")
      .setDesc("Warn before deletes that affect more than one note — multi-selection delete OR deleting a note that has descendants. A single childless note with no attachments never prompts. Off = those deletes apply immediately (undo still recovers everything).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmBulkDelete).onChange(async (v) => {
          this.plugin.settings.confirmBulkDelete = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Offer to delete attachments with note")
      .setDesc("When a note references attachments, the delete modal includes an \"Also delete attachments\" checkbox so orphaned files don't pile up in your vault. Attachments are detected from both ![[…]] embeds in the body and the frontmatter attachments: list. Off = attachments are always preserved on delete (no checkbox shown), and a single childless note with attachments deletes silently.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmAttachmentDelete).onChange(async (v) => {
          this.plugin.settings.confirmAttachmentDelete = v;
          await this.plugin.saveSettings();
        }));

    {
      let textarea: HTMLTextAreaElement | null = null;
      // Resolve the value to render: prefer the user's saved list, fall
      // back to the defaults so the textbox is never blank.
      const initial = (this.plugin.settings.slugStopWords?.length
        ? this.plugin.settings.slugStopWords
        : DEFAULT_STOPWORDS).join("\n");
      new Setting(containerEl)
        .setName("Slug stop-words")
        .setDesc("Words removed from auto-generated note titles (filenames). One per line.")
        .addTextArea((t) => {
          t.setValue(initial);
          textarea = (t as any).inputEl as HTMLTextAreaElement;
          textarea.rows = 6;
          textarea.style.fontFamily = "var(--font-monospace)";
          t.onChange(async (v) => {
            const list = (v || "").split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
            this.plugin.settings.slugStopWords = list;
            await this.plugin.saveSettings();
          });
        })
        .addExtraButton((b) =>
          b.setIcon("rotate-ccw")
            .setTooltip("Reset to defaults")
            .onClick(async () => {
              this.plugin.settings.slugStopWords = [...DEFAULT_STOPWORDS];
              if (textarea) textarea.value = DEFAULT_STOPWORDS.join("\n");
              await this.plugin.saveSettings();
            }));
    }

    // Cross-Stashpad search scope. One row per discovered Stashpad with
    // a binary pill: Included ⇄ Excluded. Default is Included; toggling
    // to Excluded adds the folder to searchExcludedFolders. Excluded
    // folders can still receive moves; their notes just don't appear in
    // search results from elsewhere.
    {
      const folders = this.plugin.discoverStashpadFolders();
      new Setting(containerEl)
        .setName("Cross-Stashpad search scope")
        .setDesc("Toggle each Stashpad's pill to choose whether its notes contribute to cross-folder search. Excluded folders are still valid move destinations — their notes just don't appear in search results from elsewhere.");

      if (folders.length === 0) {
        const empty = containerEl.createEl("p", { cls: "setting-item-description" });
        empty.setText(
          "No Stashpads found in this vault yet. A Stashpad is just a folder " +
          "that contains a Stashpad-shaped note (frontmatter has both `id` and " +
          "`parent`). Easiest way: open Stashpad (ribbon icon or command " +
          '"Reveal or open Stashpad") — it auto-creates the default folder ' +
          'on first use. Or create one below.',
        );
      } else {
        const list = containerEl.createDiv({ cls: "stashpad-folder-list" });
        for (const folder of folders) {
          this.renderFolderScopeRow(list, folder);
        }
      }

      // Always offer the "create a new Stashpad" affordance, even when
      // some already exist — useful for adding more Stashpads without
      // leaving settings.
      let nameInput: HTMLInputElement | null = null;
      new Setting(containerEl)
        .setName("Create a new Stashpad")
        .setDesc("Type a vault-relative folder path. The folder is created (with intermediates) and seeded with a Home note so Stashpad recognizes it.")
        .addText((t) => {
          t.setPlaceholder("my-stashpad");
          nameInput = (t as any).inputEl as HTMLInputElement;
        })
        .addButton((b) =>
          b.setButtonText("Create").setCta().onClick(async () => {
            const raw = (nameInput?.value ?? "").trim().replace(/^\/+|\/+$/g, "");
            if (!raw) { new Notice("Enter a folder name first."); return; }
            try {
              await this.plugin.createNewStashpad(raw);
              new Notice(`Created Stashpad "${raw}".`);
              if (nameInput) nameInput.value = "";
              // Wait for the metadataCache to actually parse the freshly-
              // created Home.md before refreshing the settings tab.
              // Otherwise discoverStashpadFolders runs before the cache
              // has the new note and the row doesn't appear.
              await this.plugin.waitForStashpadFolder(raw, 2000);
              this.display();
            } catch (e) {
              new Notice(`Couldn't create: ${(e as Error).message}`);
            }
          }));
    }

    // Color aliases — pick a Stashpad, label each hex used in it.
    this.renderColorAliasesSection(containerEl);

    // Per-Stashpad note template — pick a Stashpad, point it at a markdown
    // file whose frontmatter (and optional body) is layered onto every
    // new note created in that Stashpad.
    this.renderNoteTemplatesSection(containerEl);

    // The "Hide Obsidian's mobile toolbar in Stashpad" toggle used to live
    // here. Removed in 0.51.13 because the underlying CSS hook didn't
    // actually hide the toolbar on current mobile builds — the toggle did
    // nothing user-visible. The flag itself is retained in settings (see
    // hideMobileToolbarInStashpad jsdoc) so the body-class plumbing in
    // main.ts can be re-enabled cheaply if Obsidian later exposes a
    // selector we can target.

    new Setting(containerEl)
      .setName("Autofocus composer after sending")
      .setDesc("After Enter-submitting a note, return focus to the composer so you can keep typing. Off keeps focus in the list — useful if you want arrow keys to work without an extra click.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autofocusComposerAfterSend).onChange(async (v) => {
          this.plugin.settings.autofocusComposerAfterSend = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Open in new window — duplicate tab")
      .setDesc("ON: the new-window button (in the time-filter row) duplicates the current Stashpad tab — original stays open in the main window. OFF: the leaf is MOVED to the new window, closing the original tab.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.popoutDuplicates).onChange(async (v) => {
          this.plugin.settings.popoutDuplicates = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Prefix timestamps when copying")
      .setDesc("Include each note's timestamp before its body when copying with C or Y.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.prefixTimestampsOnCopy).onChange(async (v) => {
          this.plugin.settings.prefixTimestampsOnCopy = v;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "Keyboard shortcuts" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Each command has up to two slots. Click a slot and press a key (or chord) to bind it; press Backspace (delete on Mac) to cancel without binding; or click ✕ to clear an existing binding. When both slots are set, the pill on the right decides which one is active.",
    });

    for (const meta of COMMAND_META) {
      this.renderBindingRow(containerEl, meta);
    }
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
        const q = input.value.trim().toLowerCase();
        const matches = allMd()
          .filter((p) => !q || p.toLowerCase().includes(q))
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

  /** One settings row: label + 2 chord recorders + active-slot toggle. */
  private renderBindingRow(parent: HTMLElement, meta: CommandMeta): void {
    const row = new Setting(parent).setName(meta.label).setDesc(meta.desc);
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
      input.onclick = () => {
        startHotkeyRecording(input, async (chord) => {
          this.plugin.settings.bindings[meta.id][which] = chord;
          input.value = prettifyChord(chord);
          syncSize();
          await this.plugin.saveSettings();
          refreshToggle();
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
      };
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
