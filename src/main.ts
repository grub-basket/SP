import { Notice, Platform, Plugin, SuggestModal, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import { STASHPAD_DETAIL_VIEW_TYPE, STASHPAD_FOLDER_PANEL_VIEW_TYPE, STASHPAD_PANELS_VIEW_TYPE, STASHPAD_VIEW_TYPE, parseAuthorRef, toAttachmentLink, isInReservedSubfolder, type PinnedNoteRef, type StashpadId } from "./types";
import { StashpadDetailView, openStashpadDetailView } from "./detail-view";
import { StashpadView, properCaseFolderPath, DeletedTrashSuggestModal } from "./view";
import { StashpadTrashView, openTrashView } from "./trash-view";
import { STASHPAD_TRASH_VIEW_TYPE } from "./types";
import { StashpadPanelsView, openStashpadPanelsView, PANEL_REGISTRY, type PanelId } from "./panels-view";
import { StashpadFolderPanelView, openFolderPanelView } from "./folder-panel-view";
import { EncryptionService, defaultEncryptionConfig } from "./encryption-service";
import { lockSubtree, unlockBundle, readLockedMeta, type LockResult, deleteEncryptSubtree, restoreDeleted, listDeletedBlobs, readDeletedMeta, deletedRestoreDest, backfillTrashEncrypt, restoreRawTrash, OBSIDIAN_TRASH_DIR, type DeletedMeta, collectSubtree } from "./encryption-ops";
import { EncryptionPasswordModal } from "./modals";
import {
  DEFAULT_SETTINGS, StashpadSettings, StashpadSettingTab, setSettings, SETTINGS_TABS,
  buildDefaultBindings, COMMAND_META, type CommandBindingMap,
} from "./settings";
import { DEFAULT_STOPWORDS, bodyToSlug, buildFilename, parseIdFromFilename } from "./slug-service";
import { getActiveView, onActiveViewChange } from "./active-view";
import { importStashZip, buildStashZip, resolveNoteAttachmentFiles, STASH_EXT, splitFrontmatter } from "./stash-package";
import { ensureOkfTemplate, okfFolders, rebuildOkfForFolder, OKF_DEFAULT_TEMPLATE_PATH } from "./okf";
import { buildOkfBundleFiles, zipBundle, tarGzBundle } from "./okf-export";
import { formatDateTime } from "./format";
import { resolveStashBytes, isEncryptedStash } from "./stash-crypto";
import { StashpadLog } from "./log";
import { ROOT_ID, parseAssignees } from "./types";
import { OrderStore } from "./order-store";
import { UndoStack } from "./undo-stack";
import { rebootstrapFolderFrontmatter } from "./frontmatter-sync";
import { NotificationService, buildFileActions } from "./notifications";
import { AuthorRegistry } from "./author-registry";
import { ImportService } from "./import-service";
import { ImportLog } from "./import-log";
import { perf } from "./perf";
import { RenderCacheStore } from "./render-cache-store";

/** 0.89.1: localStorage key — set right before an update-triggered app reload so
 *  the next load knows to un-ghost the deferred Stashpad tabs. */
const UNGHOST_FLAG = "stashpad:unghost-after-reload";

/** A captured file's content, for snapshot-backed undo/redo of file operations. */
interface FileSnapshot { path: string; binary: boolean; text?: string; data?: ArrayBuffer; }

export default class StashpadPlugin extends Plugin {
  settings: StashpadSettings = { ...DEFAULT_SETTINGS };
  private undoStacks = new Map<string, UndoStack>();
  /** Most-recently-active Stashpad leaf — set on active-leaf-change.
   *  Used by sidebar panel actions (Search, Home) so they target the
   *  user's actual current tab rather than getLeavesOfType()[0]. */
  lastActiveStashpadLeaf: WorkspaceLeaf | null = null;
  /** 0.97.0: vault encryption key-management service (Phase 1). Holds the
   *  wrapped master key + session key; no file ops yet. */
  encryption!: EncryptionService;
  /** 0.79.19: true while rebootstrap is running. Suppresses the
   *  contribution stamp so rebootstrap's own frontmatter writes — and the
   *  wikilink rewrites Obsidian does when slug-renames move files — never
   *  bump `modified` (or add the local user as a contributor). */
  rebootstrapInProgress = false;
  /** 0.86.6: while `Date.now() < this`, a Stashpad view's activation
   *  auto-focus skips grabbing the composer. Set by the folder panel before it
   *  reveals/opens a leaf so tapping a pinned note on mobile doesn't pop the
   *  keyboard. */
  suppressComposerAutofocusUntil = 0;
  /** 0.73.10: keep a handle on the settings tab so command-palette
   *  entries can pre-select a specific tab when opening Settings. */
  settingTab: StashpadSettingTab | null = null;
  /** 0.74.1: selection-change listeners. Stashpad views fire this on
   *  every cursor/selection mutation; the right-side detail panel
   *  subscribes so it re-renders to match. Generic registry so future
   *  surfaces (other detail views, status bar) can also subscribe. */
  private stashpadSelectionListeners = new Set<() => void>();
  /** 0.74.6: content-change listeners. Distinct from selection
   *  listeners — these fire on every Stashpad render() (reorder,
   *  edit, child added, color change) WITHOUT implying the user
   *  picked a different note. The detail panel re-renders on these
   *  but keeps showing the same locked note, so a background reorder
   *  doesn't yank the panel to whatever the live cursor became. */
  private stashpadContentListeners = new Set<() => void>();
  /** Plugin-level notification service. Routes all toasts through one
   *  pipe so history + per-category mute + multiplayer filters work
   *  uniformly across views. Instantiated lazily on first access in
   *  case `this.app` isn't ready at field-initialiser time. */
  private _notifications: NotificationService | null = null;
  get notifications(): NotificationService {
    if (!this._notifications) this._notifications = new NotificationService(this.app);
    return this._notifications;
  }
  /** 0.77.1: rebuildable author registry (authors.json in the plugin
   *  private dir). NOT a source of truth — a recovery cache + rename
   *  history. See author-registry.ts. Lazily constructed; load() is
   *  awaited once during onload. */
  private _authorRegistry: AuthorRegistry | null = null;
  get authorRegistry(): AuthorRegistry {
    if (!this._authorRegistry) {
      this._authorRegistry = new AuthorRegistry(this.app, this.pluginPrivatePath());
    }
    return this._authorRegistry;
  }
  /** 0.79.1: auto-import engine for files dropped into a Stashpad folder. */
  private _importService: ImportService | null = null;
  get importService(): ImportService {
    if (!this._importService) this._importService = new ImportService(this);
    return this._importService;
  }
  /** 0.79.3: append-only import history (de-dupe + viewer). */
  private _importLog: ImportLog | null = null;
  get importLog(): ImportLog {
    if (!this._importLog) this._importLog = new ImportLog(this.app, this.pluginPrivatePath());
    return this._importLog;
  }
  /** 0.83.2: persisted render cache (rendered note bodies survive reload —
   *  a cold open reads one cache file instead of N bodies over a slow
   *  drive). Shared across views. */
  /** 0.99.0: the note clipboard (copy/cut/paste of note BLOCKS — runs in
   *  parallel with the system text clipboard, which gets the bodies as text).
   *  Plugin-level so it survives view re-renders; ids resolve against the
   *  source folder's tree at paste time (stale ids just shrink the paste). */
  noteClipboard: { mode: "copy" | "cut"; folder: string; ids: StashpadId[]; text?: string } | null = null;
  /** The persistent "cut pending" notice, kept so it can be dismissed when the
   *  cut resolves (paste) or is cancelled (Escape / replaced by a new copy). */
  noteClipboardNotice: Notice | null = null;

  /** Clear the note clipboard + dismiss its notice. Callers re-render to drop
   *  the .is-cut-pending / .is-copy-pending row styling. */
  clearNoteClipboard(): void {
    try { this.noteClipboardNotice?.hide(); } catch { /* already gone */ }
    this.noteClipboardNotice = null;
    this.noteClipboard = null;
  }

  private _renderCacheStore: RenderCacheStore | null = null;
  get renderCacheStore(): RenderCacheStore {
    if (!this._renderCacheStore) this._renderCacheStore = new RenderCacheStore(this.app, this.pluginPrivatePath());
    return this._renderCacheStore;
  }

  async onunload(): Promise<void> {
    // 0.97.0: wipe the in-memory encryption key on unload.
    try { this.encryption?.dispose(); } catch { /* best-effort */ }
    // Cancel pending archive-sweep timers — firing after unload would run
    // lockNoteSubtree against disposed services (key just wiped).
    try { for (const p of this.archivePending.values()) window.clearTimeout(p.timer); this.archivePending.clear(); } catch { /* best-effort */ }
    // 0.83.2: flush any pending render-cache writes (the store's save is
    // debounced, so a recent change could still be in the buffer).
    try { await this._renderCacheStore?.save(); } catch { /* best-effort */ }
  }

  /** Vault-relative path to a file/dir inside the plugin's private
   *  folder (`.obsidian/plugins/<id>/.stashpad/...`). Used for the log,
   *  integrity state, and the relocated data.json. */
  pluginPrivatePath(rel = ""): string {
    const dir = (this.manifest as any).dir as string;
    const base = `${dir.replace(/\/+$/, "")}/.stashpad`;
    if (!rel) return base;
    return `${base}/${rel.replace(/^\/+/, "")}`;
  }

  /** Construct a StashpadLog pointed at the plugin's private dir. */
  newLog(): StashpadLog {
    return new StashpadLog(
      this.app,
      this.pluginPrivatePath(),
      // Lazy author lookup so a name change in settings is reflected
      // on the next log entry without re-creating the StashpadLog.
      () => (this.settings?.authorName ?? "").trim(),
    );
  }

  /** One-shot migration from the old paths to the new private folder.
   *  Idempotent: re-running has no effect once the new files exist.
   *  Old paths are LEFT in place for safety — the user can delete them
   *  manually after confirming the new location works. */
  private async migrateLegacyPaths(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const newDir = this.pluginPrivatePath();
    const ensureDir = async (): Promise<void> => {
      const parts = newDir.split("/").filter(Boolean);
      let cur = "";
      for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p;
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      }
    };

    // 1) data.json: default Obsidian path is <pluginDir>/data.json.
    const oldData = `${(this.manifest as any).dir.replace(/\/+$/, "")}/data.json`;
    const newData = this.pluginPrivatePath("data.json");
    if (await adapter.exists(oldData) && !(await adapter.exists(newData))) {
      try {
        await ensureDir();
        const txt = await adapter.read(oldData);
        await adapter.write(newData, txt);
        console.debug("[Stashpad] migrated data.json →", newData);
      } catch (e) {
        console.warn("Stashpad: data.json migration failed", e);
      }
    }

    // 2) .stashpad/ at the vault root (log.jsonl + state.json + any
    //    timestamped log exports the user has accumulated).
    const oldRoot = ".stashpad";
    if (await adapter.exists(oldRoot)) {
      try {
        await ensureDir();
        const list = await adapter.list(oldRoot);
        for (const file of list.files) {
          const name = file.replace(/^.*\//, "");
          const target = this.pluginPrivatePath(name);
          if (await adapter.exists(target)) continue; // don't clobber
          try {
            const data = await adapter.read(file);
            await adapter.write(target, data);
            console.debug("[Stashpad] migrated", file, "→", target);
          } catch (e) {
            console.warn(`Stashpad: failed to migrate ${file}`, e);
          }
        }
      } catch (e) {
        console.warn("Stashpad: .stashpad migration scan failed", e);
      }
    }
  }

  /** Override Plugin.loadData to read from <pluginDir>/.stashpad/data.json
   *  instead of the default <pluginDir>/data.json. We want all of the
   *  plugin's persistent state living in one private folder. */
  async loadData(): Promise<any> {
    const adapter = this.app.vault.adapter;
    const path = this.pluginPrivatePath("data.json");
    if (!(await adapter.exists(path))) return null;
    try {
      return JSON.parse(await adapter.read(path));
    } catch (e) {
      console.warn("Stashpad: data.json parse failed", e);
      return null;
    }
  }

  /** Companion to loadData — writes to the relocated path and ensures
   *  the directory exists. */
  async saveData(data: any): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.pluginPrivatePath();
    if (!(await adapter.exists(dir))) {
      // mkdir intermediates (manifest.dir + ".stashpad").
      const parts = dir.split("/").filter(Boolean);
      let cur = "";
      for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p;
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      }
    }
    await adapter.write(this.pluginPrivatePath("data.json"), JSON.stringify(data, null, 2));
  }
  /** Create a brand-new Stashpad: ensures the folder exists (with any
   *  needed intermediates) and seeds it with a Home note that has the
   *  ROOT_ID frontmatter. Throws on collision so the caller can surface
   *  a clear error. After this resolves, discoverStashpadFolders will
   *  include the new folder. */
  async createNewStashpad(folder: string): Promise<void> {
    const cleaned = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) throw new Error("Folder name is empty");
    const adapter = this.app.vault.adapter;
    // mkdir intermediates.
    const parts = cleaned.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    // Seed Home note. Use the same shape createNoteUnder/the home note
    // bootstrap uses so the rest of the plugin recognizes it.
    const homePath = `${cleaned}/Home.md`;
    if (await adapter.exists(homePath)) {
      // A Home already exists — make sure its frontmatter is shaped right
      // so the discovery passes. We don't overwrite an existing body.
      const homeFile = this.app.vault.getAbstractFileByPath(homePath) as TFile | null;
      if (homeFile) {
        await this.app.fileManager.processFrontMatter(homeFile, (fm) => {
          if (typeof fm.id !== "string" || !fm.id) fm.id = ROOT_ID;
          if (!("parent" in fm)) fm.parent = null;
          if (typeof fm.created !== "string" || !fm.created) {
            fm.created = new Date().toISOString();
          }
        });
      }
      return;
    }
    const created = new Date().toISOString();
    const body = [
      "---",
      `id: ${ROOT_ID}`,
      "parent: null",
      `created: ${created}`,
      "---",
      "Home",
    ].join("\n");
    await this.app.vault.create(homePath, body);
    // 0.77.7: seed the local user's author page into the new folder so
    // their links resolve everywhere from the start.
    try { await this.seedLocalAuthorStub(cleaned); } catch {}
    // 0.99.17 (#2): also seed every KNOWN author (coworkers from other folders)
    // so a new folder auto-populates and you can assign anyone immediately.
    try { await this.seedKnownAuthorsInFolder(cleaned); } catch {}
  }

  /** Tally per-note colors found in EVERY markdown file under `folder`.
   *  Used by the settings UI's color-alias section. Returns hex strings
   *  (lowercased) + count, sorted by frequency desc, ties by hex. */
  collectColorsInFolder(folder: string): Array<{ hex: string; count: number }> {
    const counts = new Map<string, number>();
    const f = folder.replace(/\/+$/, "");
    for (const file of this.app.vault.getMarkdownFiles()) {
      const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== f && !dir.startsWith(f + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { color?: unknown } | undefined;
      const raw = typeof fm?.color === "string" ? fm.color.trim() : "";
      if (!raw) continue;
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) continue;
      const k = raw.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out = [...counts.entries()].map(([hex, count]) => ({ hex, count }));
    out.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
    return out;
  }

  /** Bulk-recolor every note in `folder` whose frontmatter color
   *  matches `oldHex` (case-insensitive). When `newHex` is null, the
   *  color frontmatter is REMOVED entirely (note becomes uncolored).
   *  Returns the number of files updated. */
  async recolorAllInFolder(folder: string, oldHex: string, newHex: string | null): Promise<number> {
    const f = folder.replace(/\/+$/, "");
    const wantOld = oldHex.toLowerCase();
    let touched = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== f && !dir.startsWith(f + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { color?: unknown } | undefined;
      const cur = typeof fm?.color === "string" ? fm.color.trim().toLowerCase() : "";
      if (cur !== wantOld) continue;
      try {
        await this.app.fileManager.processFrontMatter(file, (m) => {
          if (newHex) m.color = newHex;
          else delete m.color;
        });
        touched++;
      } catch (e) {
        console.warn(`Stashpad: recolor failed for ${file.path}`, e);
      }
    }
    // Migrate alias bookkeeping. The old hex's alias (if any) follows
    // the color when newHex is set; vanishes when newHex is null.
    const map = this.settings.colorAliases?.[f];
    if (map) {
      const oldAlias = map[wantOld];
      if (oldAlias) {
        delete map[wantOld];
        if (newHex) map[newHex.toLowerCase()] = oldAlias;
        if (Object.keys(map).length === 0) delete this.settings.colorAliases[f];
        await this.saveSettings();
      }
    }
    return touched;
  }

  /** Look up a user-defined alias for a color in a given Stashpad.
   *  Returns undefined when no alias is set; callers fall back to
   *  the hex string itself. */
  getColorAlias(folder: string, hex: string): string | undefined {
    const f = folder.replace(/\/+$/, "");
    const map = this.settings.colorAliases?.[f];
    if (!map) return undefined;
    const v = map[hex.toLowerCase()];
    return v && v.trim() ? v : undefined;
  }

  /** Set or clear an alias. Empty string removes it. */
  async setColorAlias(folder: string, hex: string, alias: string): Promise<void> {
    const f = folder.replace(/\/+$/, "");
    const lower = hex.toLowerCase();
    if (!this.settings.colorAliases) this.settings.colorAliases = {};
    if (!this.settings.colorAliases[f]) this.settings.colorAliases[f] = {};
    const map = this.settings.colorAliases[f];
    const trimmed = alias.trim();
    if (trimmed) map[lower] = trimmed;
    else delete map[lower];
    if (Object.keys(map).length === 0) delete this.settings.colorAliases[f];
    await this.saveSettings();
  }

  /** Resolve once `folder` shows up in discoverStashpadFolders, or after
   *  `timeoutMs` regardless. Lets the settings UI re-render immediately
   *  after createNewStashpad without racing the metadataCache parse. */
  async waitForStashpadFolder(folder: string, timeoutMs = 2000): Promise<void> {
    const cleaned = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.discoverStashpadFolders().includes(cleaned)) return;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /** Discover every folder in the vault that holds at least one
   *  *Stashpad-shaped* note. Stashpad-shaped means the frontmatter has
   *  BOTH a string `id` AND a `parent` field (even if `parent` is null
   *  or ROOT_ID). This avoids false-positives from other plugins or
   *  templates that happen to write a generic `id:` field. */
  /** 0.95.1: snapshot of the most recent discoverStashpadFolders() result, so a
   *  vault "delete" event (which fires AFTER the folder's notes are gone) can
   *  still tell whether the deleted folder was a Stashpad. */
  knownStashpadFolders = new Set<string>();

  discoverStashpadFolders(): string[] {
    const folders = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown; parent?: unknown } | undefined;
      if (typeof fm?.id !== "string" || !fm.id.trim()) continue;
      // Require parent to be present in the frontmatter (any value —
      // including null and ROOT_ID — counts). A note without a parent
      // field isn't a Stashpad note.
      if (!fm || !("parent" in fm)) continue;
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir) folders.add(dir);
    }
    const sorted = [...folders].sort();
    this.knownStashpadFolders = new Set(sorted);
    return sorted;
  }

  /** Folder paths whose delete WE initiated (panel delete with undo). The vault
   *  "delete" listener skips these so it doesn't double-notify. Cleared after a
   *  short window. */
  private suppressedFolderDeletes = new Set<string>();

  /** Detach any open Stashpad tab on `cleaned` (or nested under it). Returns the
   *  count closed. Reads deferred leaves' persisted folder too. */
  private closeStashpadTabsFor(cleaned: string): number {
    let closed = 0;
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      let f = ((leaf.view as any)?.noteFolder ?? "") as string;
      if (!f) {
        const st = ((leaf.getViewState?.() as any)?.state ?? {}) as { folderOverride?: string | null };
        f = (st.folderOverride ?? "") || this.settings.folder || "Stashpad";
      }
      f = (f || "").replace(/\/+$/, "");
      if (f === cleaned || f.startsWith(cleaned + "/")) { leaf.detach(); closed++; }
    }
    return closed;
  }

  /** Drop a folder (and anything nested under it) from the folder-panel
   *  placement lists. Persists only if something changed. */
  private async prunePlacementFor(cleaned: string): Promise<void> {
    const s = this.settings;
    const prune = (arr: string[] | undefined): string[] =>
      (arr ?? []).filter((p) => p !== cleaned && !p.startsWith(cleaned + "/"));
    const before = (s.folderPanelPinned?.length ?? 0) + (s.folderPanelDownranked?.length ?? 0) + (s.folderPanelHidden?.length ?? 0);
    s.folderPanelPinned = prune(s.folderPanelPinned);
    s.folderPanelDownranked = prune(s.folderPanelDownranked);
    s.folderPanelHidden = prune(s.folderPanelHidden);
    const after = s.folderPanelPinned.length + s.folderPanelDownranked.length + s.folderPanelHidden.length;
    if (after !== before) await this.saveSettings();
  }

  /** 0.95.2: delete a Stashpad folder from the panel WITH undo. We move it into
   *  the vault's `.trash` ourselves (rather than fileManager.trashFile, whose
   *  destination depends on the user's trash setting and may be unrecoverable)
   *  so Undo is always a simple move-back. Closes open tabs + posts a PERSISTENT
   *  notification carrying the Undo action. */
  async deleteStashpadFolderWithUndo(tf: TFolder): Promise<void> {
    const cleaned = tf.path.replace(/\/+$/, "");
    const name = tf.name;
    const adapter = this.app.vault.adapter;
    const trashDir = ".trash";
    try { if (!(await adapter.exists(trashDir))) await adapter.mkdir(trashDir); }
    catch (e) { console.warn("[Stashpad] couldn't ensure .trash", e); }
    let dest = `${trashDir}/${name}`;
    for (let n = 1; await adapter.exists(dest); n++) dest = `${trashDir}/${name} (${n})`;

    this.suppressedFolderDeletes.add(cleaned);
    window.setTimeout(() => this.suppressedFolderDeletes.delete(cleaned), 5000);
    const closed = this.closeStashpadTabsFor(cleaned);
    await this.prunePlacementFor(cleaned);
    this.knownStashpadFolders.delete(cleaned);
    try {
      await adapter.rename(cleaned, dest);
    } catch (e) {
      console.warn("[Stashpad] folder delete failed", e);
      this.suppressedFolderDeletes.delete(cleaned);
      new Notice("Delete failed (see console).");
      return;
    }

    const msg = closed > 0
      ? `Deleted “${name}” — closed ${closed} open tab${closed === 1 ? "" : "s"}.`
      : `Deleted “${name}”.`;
    this.notifications.show({
      message: msg,
      kind: "warning",
      category: "delete",
      duration: 0,
      folder: cleaned,
      actions: [{
        label: "Undo",
        onClick: async () => {
          try {
            if (await adapter.exists(cleaned)) { new Notice(`Can't undo — “${name}” already exists.`); return; }
            this.suppressedFolderDeletes.add(cleaned);
            window.setTimeout(() => this.suppressedFolderDeletes.delete(cleaned), 5000);
            await adapter.rename(dest, cleaned);
            new Notice(`Restored “${name}”.`);
            void this.activateViewForFolder(cleaned);
          } catch (e) {
            console.warn("[Stashpad] folder undo failed", e);
            new Notice("Undo failed (see console).");
          }
        },
      }],
    });
  }

  /** 0.95.1: a Stashpad folder was deleted from OUTSIDE the panel (file
   *  explorer, sync, …) — we didn't trash it, so no undo, but still close any
   *  open tabs on it, drop it from placement lists, and notify so a vanished tab
   *  isn't a surprise. Skips folders we just deleted ourselves (those already
   *  notified with Undo). */
  async handleStashpadFolderDeleted(path: string): Promise<void> {
    const cleaned = path.replace(/\/+$/, "");
    if (!cleaned || this.suppressedFolderDeletes.has(cleaned)) return;
    const closed = this.closeStashpadTabsFor(cleaned);
    await this.prunePlacementFor(cleaned);
    this.knownStashpadFolders.delete(cleaned);
    const name = cleaned.split("/").pop() || cleaned;
    this.notifications.show({
      message: closed > 0
        ? `Stashpad “${name}” was deleted — closed ${closed} open tab${closed === 1 ? "" : "s"}.`
        : `Stashpad “${name}” was deleted.`,
      kind: "warning",
      category: "delete",
      folder: cleaned,
    });
  }

  /** The folders eligible for cross-Stashpad search results, derived from
   *  discoverStashpadFolders + the included/excluded settings:
   *  - When `searchIncludedFolders` is non-empty, only those folders are
   *    eligible (allowlist mode).
   *  - When empty, every discovered folder is eligible MINUS those in
   *    `searchExcludedFolders`.
   *  The currently-active folder is always returned first so callers can
   *  show its results before the rest. */
  searchableFolders(activeFolder: string): string[] {
    const allowed = new Set(this.settings.searchIncludedFolders);
    const excluded = new Set(this.settings.searchExcludedFolders);
    // 0.98.32: archive folders are auto-excluded from CROSS-folder search — their
    // contents are private-at-rest, so they shouldn't surface as search hits or
    // move targets elsewhere. (The active folder is still searched within itself —
    // it's unshifted back below.)
    const autoExcluded = new Set(
      (this.settings.archiveFolders ?? []).map((s) => (s ?? "").replace(/\/+$/, "")),
    );
    const all = this.discoverStashpadFolders();
    const filtered = all.filter((f) => {
      if (autoExcluded.has(f)) return false;
      if (allowed.size > 0) return allowed.has(f);
      return !excluded.has(f);
    });
    // Move the active folder to the front (or insert if it was excluded —
    // callers always want their own folder first).
    const a = (activeFolder || "").trim().replace(/\/+$/, "");
    const out = filtered.filter((f) => f !== a);
    if (a) out.unshift(a);
    return out;
  }

  /** Folders we've already run the integrity sweep on this session.
   *  Subsequent requests for the same folder are no-ops — the sweep is
   *  expensive and re-running it just repeats the noise. */
  private sweptFolders = new Set<string>();

  /** Once-per-session SILENT refresh: brings .stashpad/state.json into
   *  sync with the current vault snapshot WITHOUT writing log entries.
   *  This is what runs when a Stashpad view mounts. Every actual user
   *  action (create / parent-change / rename / delete) is already logged
   *  inline by view.ts, so a noisy diff here is redundant — and worse,
   *  it'd re-log every note created in the previous session every time
   *  the plugin reloads.
   *
   *  Use cmdRunIntegrityCheck() (command palette) for the loud version
   *  that surfaces external/out-of-band changes. */
  async maybeSweepFolder(folder: string): Promise<void> {
    const f = (folder || "").trim().replace(/\/+$/, "");
    if (!f || this.sweptFolders.has(f)) return;
    this.sweptFolders.add(f);
    setTimeout(() => { void this.runSweep(f, { silent: true }); }, 3000);
  }

  /** Manual integrity check — writes log entries for every delta between
   *  state.json and the current vault snapshot. Triggered from the
   *  command palette, not on view mount. */
  async runIntegrityCheckOnFolder(folder: string): Promise<void> {
    const f = (folder || "").trim().replace(/\/+$/, "");
    if (!f) return;
    await this.runSweep(f, { silent: false });
  }

  private async runSweep(folder: string, opts: { silent: boolean }): Promise<void> {
    try {
      const log = this.newLog();
      // Build the current snapshot directly from the vault + metadataCache.
      const cur: Record<string, { parent: string | null; path: string }> = {};
      const files = this.app.vault.getMarkdownFiles().filter((f) =>
        f.path === folder || f.path.startsWith(folder + "/"),
      );
      for (const f of files) {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
          | { id?: string; parent?: string | null } | undefined;
        const id = typeof fm?.id === "string" ? fm.id.trim() : "";
        if (!id) continue;
        const parent = (fm && "parent" in fm ? (fm.parent ?? null) : null) as string | null;
        cur[id] = { parent, path: f.path };
      }

      const prev = await log.readState();
      const inFolder = (path: string): boolean =>
        path === folder || path.startsWith(folder + "/");

      if (!opts.silent) {
        for (const [id, info] of Object.entries(cur)) {
          const before = prev[id];
          if (!before) {
            await log.append({ type: "create", id, payload: { path: info.path, parent: info.parent } });
          } else if (before.parent !== info.parent) {
            await log.append({ type: "parent_change", id, payload: { from: before.parent, to: info.parent } });
          } else if (before.path !== info.path) {
            await log.append({ type: "rename", id, payload: { from: before.path, to: info.path } });
          }
        }
        for (const [id, info] of Object.entries(prev)) {
          if (!cur[id] && inFolder(info.path)) {
            await log.append({ type: "missing", id, payload: { lastPath: info.path } });
          }
        }
      }
      // State refresh always happens — that's the whole point of the silent
      // pass. Without this, future sweeps would re-discover every change
      // made during this session as a fresh delta.

      const merged: Record<string, { parent: string | null; path: string }> = {};
      for (const [id, info] of Object.entries(prev)) if (!inFolder(info.path)) merged[id] = info;
      for (const [id, info] of Object.entries(cur)) merged[id] = info;
      await log.writeState(merged);
    } catch (e) {
      console.warn("Stashpad: integrity sweep failed", e);
    }
  }

  getUndoStack(folder: string): UndoStack {
    let s = this.undoStacks.get(folder);
    if (!s) { s = new UndoStack(); this.undoStacks.set(folder, s); }
    return s;
  }

  async onload(): Promise<void> {
    // Migrate any legacy state from the OLD locations (vault root
    // .stashpad/ and the default plugin-folder data.json) into the
    // NEW private folder under <pluginDir>/.stashpad/. Runs before
    // loadSettings so the data.json move is in place when we read.
    await this.migrateLegacyPaths();
    await this.loadSettings();
    perf.enabled = !!this.settings.enablePerfProfiling;
    this.encryption = new EncryptionService(
      this.app,
      // Merge defaults so a settings blob written by an older (v1) version still
      // satisfies the v2 identity fields (they read as null until set up).
      () => ({ ...defaultEncryptionConfig(), ...(this.settings.encryption ?? {}) }),
      async (cfg) => { this.settings.encryption = cfg; await this.saveSettings(); },
      () => this.settings.encryptionIdleLockMinutes ?? 0,
    );
    // Load the synced keyfile into the service's cache FIRST (isConfigured /
    // accessState / tryAutoUnlock all read it), then auto-unlock if a password is
    // remembered on this device.
    void this.encryption.init().then(() => this.encryption.tryAutoUnlock());
    // Reconcile the locked-subtree registry from on-disk `.stashmeta` sidecars
    // (recovers placeholder placement after a settings desync or cross-device
    // sync). Deferred to onLayoutReady (below) so it runs AFTER the vault has
    // finished indexing the `.stashenc` blobs — running it during onload once
    // wiped the registry against an empty file index.
    this.settingTab = new StashpadSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // 0.83.2: load the persisted render cache before views open, so the
    // first cold paint can hit it instead of reading every body over the
    // (possibly slow) drive.
    await this.renderCacheStore.load();
    // Evict cache rows when their file goes away — an entry holds the full
    // body + HTML, and after an encryption lock/secure-delete it would be the
    // last readable plaintext copy, sitting in render-cache.json.
    this.registerEvent(this.app.vault.on("delete", (f) => this.renderCacheStore.evict(f.path)));
    this.registerEvent(this.app.vault.on("rename", (_f, oldPath) => this.renderCacheStore.evict(oldPath)));
    // 0.102.x: OKF auto-rebuild — when a note is added/deleted/moved in an OKF
    // folder, refresh that folder's OKF frontmatter + index.md (debounced). Gated
    // through okfActiveFolders so it never runs when OKF is off / for non-OKF /
    // archive folders. Frontmatter writes are "modify" events (not listened here),
    // so this can't loop on its own work; index.md is ignored explicitly.
    this.registerEvent(this.app.vault.on("create", (f) => this.onOkfFileEvent(f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onOkfFileEvent(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { this.onOkfFileEvent(f.path); this.onOkfFileEvent(oldPath); }));
    // 0.77.1: load the author registry and seed it with the local user.
    await this.authorRegistry.load();
    {
      const id = (this.settings.authorId ?? "").trim();
      if (id) {
        this.authorRegistry.record({
          id,
          name: this.settings.authorName,
          role: this.settings.authorRole,
          department: this.settings.authorDepartment,
        });
      }
    }
    // 0.77.7: backfill the local user's author page into any existing
    // Stashpad folder that lacks it. Deferred + after the metadata cache
    // has settled so folder discovery + the "already has my stub" check
    // are accurate (avoids creating a duplicate before the cache lists
    // the existing one). New folders are seeded at creation time instead.
    this.app.workspace.onLayoutReady(() => {
      // Vault is fully indexed now — safe to reconcile locked placeholders
      // (drop entries whose blob is truly gone, add cross-device blobs).
      void this.reconcileLockedRegistry();
      // 0.99.19: fire reminders for tasks that came due while Obsidian was
      // closed (delay so the metadata cache is populated), then re-check on an
      // interval so tasks coming due while it's open also surface.
      window.setTimeout(() => void this.checkDueReminders(), 6000);
      this.registerInterval(window.setInterval(() => void this.checkDueReminders(), 5 * 60 * 1000));
      window.setTimeout(() => { void this.seedLocalAuthorStubsEverywhere(); }, 4000);
      // 0.79.12: register each Stashpad folder's _archive in Obsidian's
      // "Excluded files" so native search / quick switcher / graph / link
      // suggestions de-prioritise the import-originals graveyard.
      window.setTimeout(() => this.syncObsidianExcludedArchives(), 4500);
      // 0.79.15: arm auto-import only AFTER the startup create-storm has
      // passed (Obsidian replays a create event for every existing file on
      // load). Until armed, enqueue() ignores events — so opening the vault
      // never looks like a mass "drop".
      window.setTimeout(() => this.importService.setArmed(true), 2500);
      // 0.84.11: retroactive auto-import — a startup sweep (after arming) so
      // items added while Obsidian was closed get imported, plus a 5-min
      // interval so external Finder copies that never fired a vault event are
      // eventually caught. Both no-op unless autoImport is on. registerInterval
      // is auto-cleared on unload.
      window.setTimeout(() => void this.runAutoImportSweep(), 5000);
      this.registerInterval(window.setInterval(() => void this.runAutoImportSweep(), 5 * 60 * 1000));
      // 0.86.3: migrate legacy per-device pinned list → note frontmatter (so
      // pins sync). After the metadata cache has settled so fileForPin resolves.
      window.setTimeout(() => void this.migratePinnedNotesToFrontmatter(), 3000);
      // 0.89.1: if this load follows our update-reload, un-ghost the deferred
      // Stashpad tabs so they render with the fresh code (no blank tabs/buttons).
      window.setTimeout(() => void this.unghostStashpadTabsIfFlagged(), 1200);
    });

    this.registerView(
      STASHPAD_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadView(leaf, this),
    );
    // 0.74.1: right-sidebar detail panel.
    this.registerView(
      STASHPAD_DETAIL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadDetailView(leaf, this),
    );
    // 0.68.0: sidebar panels view (Pinned Notes + future panels).
    this.registerView(
      STASHPAD_PANELS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadPanelsView(leaf, this),
    );
    // 0.98.35: encrypted-trash tab (recoverable deleted notes, grouped by origin).
    this.registerView(
      STASHPAD_TRASH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadTrashView(leaf, this),
    );
    this.registerView(
      STASHPAD_FOLDER_PANEL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadFolderPanelView(leaf, this),
    );
    // 0.68.1: track the most-recently-active Stashpad leaf so the
    // sidebar panel's Search / Home buttons target the leaf the user
    // last worked in — not "leaves[0]" (= leftmost tab) which has
    // nothing to do with recency.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf && leaf.view.getViewType() === STASHPAD_VIEW_TYPE) {
        this.lastActiveStashpadLeaf = leaf;
        // 0.74.1: auto-open the right-sidebar detail panel when the
        // user enters a Stashpad view, if the setting is on AND the
        // panel isn't already open. Defer one tick so the leaf is
        // fully settled before we touch workspace state.
        if (this.settings.autoOpenDetailPanel) {
          const existing = this.app.workspace.getLeavesOfType(STASHPAD_DETAIL_VIEW_TYPE);
          if (existing.length === 0) {
            setTimeout(() => { void openStashpadDetailView(this.app); }, 0);
          }
        }
        // Always notify selection listeners when the active leaf
        // becomes a Stashpad — the detail panel needs to refresh to
        // match the new leaf's cursor row even if the leaf was open
        // all along.
        this.notifyStashpadSelectionChanged();
      }
    }));

    // Toggle a body class while a Stashpad view is the active leaf, so
    // CSS can hide Obsidian's mobile toolbar (or other chrome we don't
    // want) only when the user is in a Stashpad. Listens to BOTH the
    // workspace's active-leaf-change (catches tab switching) and our own
    // active-view notifications (catches focus shifts within the view).
    //
    // NOTE (0.51.13): the .stashpad-hide-mobile-toolbar class doesn't
    // appear to actually hide the toolbar on current Obsidian mobile
    // builds — the user-facing setting was removed because flipping it
    // had no observable effect. The body-class toggling is kept so a
    // future fix (CSS targeting the right element, or a different DOM
    // hook entirely) just needs to update styles.css. `.stashpad-active`
    // is still useful on its own as a generic "Stashpad view is focused"
    // marker for other CSS rules.
    const refreshActiveClass = (): void => {
      const v = getActiveView();
      const stashpadActive = !!v
        && this.app.workspace.activeLeaf
        && this.app.workspace.activeLeaf.view === v;
      const wantHide = !!stashpadActive && this.settings.hideMobileToolbarInStashpad;
      document.body.classList.toggle("stashpad-hide-mobile-toolbar", wantHide);
      document.body.classList.toggle("stashpad-active", !!stashpadActive);
    };
    this.register(onActiveViewChange(refreshActiveClass));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refreshActiveClass));

    // 0.61.9: Obsidian popout windows don't automatically inherit
    // plugin stylesheets — opening a Stashpad view in a popout (tiny
    // mode, "open in new window" button, native Obsidian popout) means
    // our CSS rules silently no-op. Clone every <style> tag from the
    // main document into each popout window on open. Also do an
    // immediate pass for popouts that already exist.
    const injectStashpadStyles = (popoutDoc: Document): void => {
      try {
        // Only clone OUR stylesheets — they have hashes Obsidian adds.
        // The cheapest reliable filter: any <style> whose text mentions
        // `.stashpad-` (we use that prefix everywhere).
        const own = Array.from(document.querySelectorAll("style"))
          .filter((s) => (s.textContent ?? "").includes(".stashpad-"));
        for (const s of own) {
          // Skip if already cloned (by data-stashpad attr).
          const id = s.id || "";
          const sel = id ? `style[data-stashpad-source="${id}"]` : null;
          if (sel && popoutDoc.head.querySelector(sel)) continue;
          const clone = popoutDoc.createElement("style");
          if (id) clone.setAttribute("data-stashpad-source", id);
          else clone.setAttribute("data-stashpad-source", "anon");
          clone.textContent = s.textContent ?? "";
          popoutDoc.head.appendChild(clone);
        }
      } catch (e) {
        console.warn("[Stashpad] inject popout styles failed", e);
      }
    };
    this.registerEvent((this.app.workspace as any).on("window-open", (win: any) => {
      const doc = win?.doc ?? win?.win?.document ?? null;
      if (doc) injectStashpadStyles(doc);
    }));

    // 0.93.0: file-explorer context menu → "Open folder in Stashpad", but ONLY
    // for folders that are ALREADY Stashpad folders (have at least one Stashpad
    // note). Lets you jump into an existing Stashpad from the file nav without
    // turning every folder's menu into a Stashpad entry-point.
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFolder)) return;
      const path = file.path.replace(/\/+$/, "");
      if (!this.discoverStashpadFolders().includes(path)) return;
      menu.addItem((item) => {
        item
          .setTitle("Open folder in Stashpad")
          .setIcon("layout-list")
          .onClick(() => void this.openFolderInStashpad(path));
      });
    }));
    // Existing popouts at plugin-load time (e.g. after a reload while
    // a tiny window was open) — walk all known windows and inject.
    setTimeout(() => {
      try {
        const ws = this.app.workspace as any;
        if (typeof ws.iterateAllLeaves === "function") {
          ws.iterateAllLeaves((leaf: any) => {
            const d = leaf?.view?.containerEl?.ownerDocument;
            if (d && d !== document) injectStashpadStyles(d);
          });
        }
      } catch {}
    }, 200);
    refreshActiveClass();
    // Re-evaluate when settings change (the toggle could have flipped).
    this.register(() => document.body.classList.remove("stashpad-hide-mobile-toolbar", "stashpad-active"));

    // Mobile: keep two CSS variables on body up to date so the view
    // can reserve the right amount of bottom space:
    //   --stashpad-toolbar-h : measured height of Obsidian's docked
    //                          mobile toolbar (0 when not present).
    //   --stashpad-vv-bottom-gap : difference between window.innerHeight
    //                              and visualViewport.height (the
    //                              keyboard's height when open, 0 when
    //                              closed).
    const vv: VisualViewport | undefined = (window as any).visualViewport;
    const refreshGeometry = (): void => {
      // Toolbar measurement: try a few selectors Obsidian has used.
      const toolbar = document.querySelector(
        ".mobile-toolbar, .mobile-toolbar-container",
      ) as HTMLElement | null;
      const tbH = toolbar && toolbar.isConnected ? toolbar.offsetHeight : 0;
      document.body.style.setProperty("--stashpad-toolbar-h", `${tbH}px`);
      // Keyboard height via visualViewport.
      let kbH = 0;
      if (vv) kbH = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.body.style.setProperty("--stashpad-vv-bottom-gap", `${kbH}px`);
      document.body.classList.toggle("stashpad-keyboard-open", kbH > 100);
    };
    refreshGeometry();
    if (vv) {
      vv.addEventListener("resize", refreshGeometry);
      vv.addEventListener("scroll", refreshGeometry);
      this.register(() => {
        vv.removeEventListener("resize", refreshGeometry);
        vv.removeEventListener("scroll", refreshGeometry);
      });
    }
    window.addEventListener("resize", refreshGeometry);
    this.register(() => window.removeEventListener("resize", refreshGeometry));
    // Re-measure on a short interval too — the toolbar may mount AFTER
    // initial onload, and there's no clean event for "Obsidian finished
    // attaching the mobile toolbar." A few RAF/timeout passes catch it.
    requestAnimationFrame(refreshGeometry);
    setTimeout(refreshGeometry, 250);
    setTimeout(refreshGeometry, 1000);

    // 0.62.0: ribbon click ALWAYS shows the folder/leaf menu. Earlier
    // behaviour (0 or 1 leaves → silently open/reveal; 2+ → menu) was
    // confusing — users with multiple Stashpad folders couldn't reach
    // the picker without right-clicking, and the leaves-count heuristic
    // wasn't discoverable. Now: click → menu listing every Stashpad
    // folder; picking one reveals its tab if open, else opens a new
    // tab on it. Empty case (no folders discovered yet) falls through
    // to creating the default Stashpad.
    const ribbon = this.addRibbonIcon("list-tree", "Open Stashpad", () => {
      const folders = this.discoverStashpadFolders();
      if (folders.length === 0) {
        void this.activateView({ reveal: true });
        return;
      }
      this.openFolderPicker();
    });
    ribbon.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.openFolderPicker();
    });

    // 0.68.1: ribbon icon for the sidebar panels view — installed by
    // default so users discover it without running a command first.
    // The matching command-palette entry still works as a restore
    // path if the user removes the ribbon icon.
    this.addRibbonIcon("panel-left", "Open Stashpad panels (sidebar)", () => {
      void openStashpadPanelsView(this.app);
    });
    // 0.86.1: folder panel ribbon entry — the main way to open it on mobile
    // (commands are buried; the other sidebar panels are reached via ribbon).
    this.addRibbonIcon("folders", "Open Stashpad folder panel (sidebar)", () => {
      void openFolderPanelView(this.app);
    });
    // 0.74.1: right-sidebar detail panel ribbon entry.
    this.addRibbonIcon("panel-right", "Open Stashpad detail panel (right sidebar)", () => {
      void openStashpadDetailView(this.app);
    });

    // 0.62.3: same smarts as the ribbon icon — if there's more than one
    // Stashpad folder, show the picker instead of silently defaulting
    // to the plugin's configured folder. Single-folder vaults still
    // get the direct "open" behaviour they had before.
    this.addCommand({
      id: "stashpad-open",
      name: "Open Stashpad in new tab",
      callback: () => {
        const folders = this.discoverStashpadFolders();
        if (folders.length >= 2) {
          this.openFolderPicker();
          return;
        }
        void this.activateView({ reveal: false });
      },
    });
    this.addCommand({
      id: "stashpad-reveal",
      name: "Reveal or open Stashpad",
      callback: () => void this.activateView({ reveal: true }),
    });
    // 0.95.3: bounce focus between the Stashpad side panels and your work.
    // Layout-independent (no left/right/up/down geometry): "focus tab" snaps to
    // the Stashpad tab you were last in; "focus panel" reveals the folder panel.
    this.addCommand({
      id: "stashpad-focus-last-tab",
      name: "Focus last Stashpad tab",
      callback: () => void this.focusLastStashpadTab(),
    });
    this.addCommand({
      id: "stashpad-focus-folder-panel",
      name: "Focus folder panel",
      callback: () => void this.focusFolderPanel(),
    });
    // 0.97.2: forget the in-memory encryption key (re-prompt on next use). The
    // explicit alternative to background auto-relock.
    this.addCommand({
      id: "stashpad-lock-encryption",
      name: "Lock encryption (forget password)",
      callback: () => {
        if (!this.encryption.isConfigured()) { new Notice("Encryption isn't set up."); return; }
        this.encryption.lock();
        new Notice("Encryption locked.");
      },
    });

    const call = (method: string) => {
      const v = getActiveView();
      if (v && typeof v[method] === "function") v[method]();
    };

    this.addCommand({
      id: "stashpad-toggle-split",
      name: "Toggle split-on-newlines",
      callback: () => call("toggleSplit"),
    });
    this.addCommand({
      id: "stashpad-command-palette",
      name: "Command palette (Stashpad only)",
      callback: () => call("openStashpadCommandPalette"),
    });
    this.addCommand({
      id: "stashpad-lock-selection",
      name: "Encrypt (lock) selection (notes + children)",
      callback: () => call("cmdLockSelection"),
    });
    this.addCommand({
      id: "stashpad-unlock-all",
      name: "Decrypt (unlock) locked notes in view",
      callback: () => call("cmdUnlockAll"),
    });
    this.addCommand({
      id: "stashpad-unlock-all-vault",
      name: "Decrypt (unlock) ALL locked notes in the vault",
      callback: () => void this.unlockAllInVault(),
    });
    // 0.99.0: note clipboard — copy/cut/paste of note blocks.
    this.addCommand({
      id: "stashpad-copy-notes",
      name: "Copy notes (note clipboard — paste to duplicate)",
      callback: () => call("cmdCopyNotes"),
    });
    this.addCommand({
      id: "stashpad-cut-notes",
      name: "Cut notes (paste in list to move, in composer to extract text)",
      callback: () => call("cmdCutNotes"),
    });
    this.addCommand({
      id: "stashpad-paste-notes",
      name: "Paste notes (from the note clipboard)",
      callback: () => call("cmdPasteNotes"),
    });
    this.addCommand({
      id: "stashpad-move-to-archive",
      name: "Move selection to archive (encrypt)",
      callback: () => call("cmdMoveToArchive"),
    });
    this.addCommand({
      id: "stashpad-encrypt-delete",
      name: "Encrypt & delete selection (to encrypted trash)",
      callback: () => call("cmdEncryptDelete"),
    });
    this.addCommand({
      id: "stashpad-restore-trash",
      name: "Open encrypted trash (restore deleted)…",
      callback: () => this.openEncryptedTrash(),
    });
    // v2 backfill: "Encrypt items sent to trash" only covers going-forward
    // deletes — this sweeps what's ALREADY sitting in plaintext in `.trash/`.
    this.addCommand({
      id: "stashpad-encrypt-existing-trash",
      name: "Encrypt existing Obsidian trash (backfill .trash into encrypted trash)",
      callback: () => void this.encryptExistingTrash(),
    });
    this.addCommand({
      id: "stashpad-close-duplicate-tabs",
      name: "Close duplicate & orphaned Stashpad tabs (tidy up)",
      callback: () => void this.closeDuplicateStashpadTabs(),
    });
    // 0.77.8: claim authorship retroactively (for notes created before the
    // user set their author name). Author-only variants only fill blank
    // author fields; the "+ contributor" variants also add the user as a
    // contributor to notes someone else already authored. All undoable.
    this.addCommand({
      id: "stashpad-claim-selected-author",
      name: "Claim authorship of selected notes",
      callback: () => call("claimSelectedAsAuthor"),
    });
    this.addCommand({
      id: "stashpad-claim-folder-author",
      name: "Claim authorship of all unauthored notes in this folder",
      callback: () => call("claimFolderAsAuthor"),
    });
    this.addCommand({
      id: "stashpad-claim-selected-contributor",
      name: "Claim selected notes (author if unowned, else add me as contributor)",
      callback: () => call("claimSelectedWithContributor"),
    });
    this.addCommand({
      id: "stashpad-claim-folder-contributor",
      name: "Claim all notes in this folder (author if unowned, else add me as contributor)",
      callback: () => call("claimFolderWithContributor"),
    });
    this.addCommand({
      id: "stashpad-pick-destination",
      name: "Pick destination for next note",
      callback: () => call("openDestinationPicker"),
    });
    this.addCommand({
      id: "stashpad-search",
      name: "Search Stashpad notes",
      callback: () => call("openSearchModal"),
    });
    this.addCommand({
      id: "stashpad-search-in-parent",
      name: "Search in current parent",
      callback: () => call("openSearchInParentModal"),
    });
    this.addCommand({
      id: "stashpad-move-picker",
      name: "Move selection (picker)",
      callback: () => call("cmdMovePicker"),
    });
    this.addCommand({
      id: "stashpad-merge",
      name: "Merge selection",
      callback: () => call("cmdMerge"),
    });
    this.addCommand({
      id: "stashpad-copy",
      name: "Copy selection",
      callback: () => call("cmdCopy"),
    });
    this.addCommand({
      id: "stashpad-copy-tree",
      name: "Copy focused subtree",
      callback: () => call("cmdCopyTree"),
    });
    this.addCommand({
      id: "stashpad-copy-outline",
      name: "Copy as outline (nested embeds)",
      callback: () => call("cmdCopyOutline"),
    });
    this.addCommand({
      id: "stashpad-split",
      name: "Split note…",
      callback: () => call("cmdSplit"),
    });
    this.addCommand({
      id: "stashpad-edit-note",
      name: "Edit note in new tab (selection)",
      callback: () => call("cmdOpenInEditor"),
    });
    this.addCommand({
      id: "stashpad-edit-parent",
      name: "Edit parent note in new tab",
      callback: () => call("cmdOpenParentInEditor"),
    });
    this.addCommand({
      id: "stashpad-delete",
      name: "Delete selection",
      callback: () => call("cmdDelete"),
    });
    this.addCommand({ id: "stashpad-move-up", name: "Move note up", callback: () => call("cmdMoveUp") });
    this.addCommand({ id: "stashpad-move-down", name: "Move note down", callback: () => call("cmdMoveDown") });
    this.addCommand({ id: "stashpad-move-to-top", name: "Move note to top", callback: () => call("cmdMoveToTop") });
    this.addCommand({ id: "stashpad-move-to-bottom", name: "Move note to bottom", callback: () => call("cmdMoveToBottom") });
    this.addCommand({ id: "stashpad-outdent", name: "Outdent (move to grandparent)", callback: () => call("cmdOutdent") });
    this.addCommand({ id: "stashpad-set-color", name: "Set note color…", callback: () => call("cmdSetColor") });
    // "Clone / duplicate / copy" — three synonyms in the name so command-palette
    // fuzzy search hits regardless of which word the user reaches for.
    this.addCommand({ id: "stashpad-clone", name: "Clone selection (duplicate / copy notes)", callback: () => call("cmdClone") });
    this.addCommand({ id: "stashpad-insert-template", name: "Insert template (clone an existing note)", callback: () => call("cmdInsertTemplate") });
    this.addCommand({ id: "stashpad-toggle-expand", name: "Show more / show less (expand toggle)", callback: () => call("cmdToggleExpand") });
    // Three view-level keybinds that previously had no command-palette
    // entry. Names mirror their COMMAND_META labels for fuzzy lookup.
    this.addCommand({ id: "stashpad-pick-move", name: "Move (in-list, arrow + Enter)", callback: () => call("cmdInListPicker") });
    this.addCommand({ id: "stashpad-open-in-new-tab", name: "Open in new Stashpad tab", callback: () => call("cmdOpenInNewStashpadTab") });
    this.addCommand({ id: "stashpad-toggle-complete", name: "Toggle complete (strikethrough)", callback: () => call("cmdToggleComplete") });
    this.addCommand({ id: "stashpad-toggle-task", name: "Toggle task (todo)", callback: () => call("cmdToggleTask") });
    this.addCommand({ id: "stashpad-set-due", name: "Set due date…", callback: () => call("cmdSetDue") });
    // 0.81.1: performance profiling — dump / reset the timing report.
    this.addCommand({
      id: "stashpad-dump-perf",
      name: "Dump performance profile (copy to clipboard)",
      callback: async () => {
        if (!this.settings.enablePerfProfiling) {
          new Notice("Enable “Performance profiling” in Stashpad settings first, then use the app and run this again.");
          return;
        }
        const report = perf.report();
        console.log(report);
        try { await navigator.clipboard.writeText(report); } catch {}
        new Notice("Performance profile copied to clipboard (also in the console).");
      },
    });
    this.addCommand({
      id: "stashpad-reset-perf",
      name: "Reset performance profile",
      callback: () => { perf.reset(); new Notice("Performance profile reset."); },
    });
    this.addCommand({ id: "stashpad-jump-to-top", name: "Jump to top of list", callback: () => call("jumpToTop") });
    this.addCommand({ id: "stashpad-jump-to-bottom", name: "Jump to bottom of list", callback: () => call("jumpToBottom") });
    this.addCommand({ id: "stashpad-assign", name: "Assign task to…", callback: () => call("cmdAssign") });
    // 0.79.3: view what's been auto-imported.
    this.addCommand({
      id: "stashpad-open-import-log",
      name: "Open import log",
      callback: async () => {
        await this.importLog.load();
        const { ImportLogModal } = await import("./modals");
        new ImportLogModal(this.app, this.importLog.recent()).open();
      },
    });
    // 0.79.4: import via the OS file picker. Opens a chooser whose pinned
    // top result is "open the file picker" (targeting the active folder);
    // the remaining results let you pick a different destination folder.
    this.addCommand({
      id: "stashpad-import-files",
      name: "Import file(s) into Stashpad…",
      callback: () => this.openImportPicker(),
    });
    // 0.84.1: manual sweep of the current folder for loose files moved in
    // from outside (the counterpart to auto-import, for when it's off or the
    // live watcher didn't catch an external Finder/Explorer copy).
    this.addCommand({
      id: "stashpad-import-loose-files",
      name: "Import loose files & folders in this folder (scan for moved-in / unprocessed items)",
      checkCallback: (checking: boolean) => {
        const folder = this.importService.defaultDestination();
        if (checking) return !!folder;
        if (folder) void this.runImportLooseFiles(folder);
        return true;
      },
    });
    // 0.85.2: per-step counterparts to rebootstrap, scoped to the current
    // folder — so you can re-run just one repair pass without the heavy
    // full-vault sweep. They call the SAME functions rebootstrap uses, so a
    // fix in one place applies to both.
    this.addCommand({
      id: "stashpad-rerun-slug-pass",
      name: "Re-run filename (slug) pass on this folder",
      checkCallback: (checking: boolean) => {
        const folder = this.importService.defaultDestination();
        if (checking) return !!folder;
        if (folder) void this.runFolderSlugPass(folder);
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-rerun-frontmatter-backfill",
      name: "Re-run frontmatter backfill (recovery links) on this folder",
      checkCallback: (checking: boolean) => {
        const folder = this.importService.defaultDestination();
        if (checking) return !!folder;
        if (folder) void this.runFolderFrontmatterBackfill(folder);
        return true;
      },
    });
    this.addCommand({ id: "stashpad-select-all", name: "Select all visible notes", callback: () => call("cmdSelectAll") });
    this.addCommand({ id: "stashpad-copy-codeblock", name: "Copy code from codeblock", callback: () => call("cmdCopyCodeBlock") });
    // 0.68.0: open the sidebar panels view (Pinned Notes + future panels).
    this.addCommand({
      id: "stashpad-open-panels",
      name: "Open Stashpad panels (sidebar)",
      callback: () => void openStashpadPanelsView(this.app),
    });
    // 0.86.0: open the left-sidebar folder picker (pinned notes + folders).
    this.addCommand({
      id: "stashpad-open-folder-panel",
      name: "Open folder panel (sidebar)",
      callback: () => void openFolderPanelView(this.app),
    });
    // 0.74.1: open the right-sidebar detail panel.
    this.addCommand({
      id: "stashpad-open-detail",
      name: "Open Stashpad detail panel (right sidebar)",
      callback: () => void openStashpadDetailView(this.app),
    });
    // 0.76.19: jump from a plain Obsidian markdown tab to the same
    // note inside Stashpad — for when you open a Stashpad note in the
    // normal editor by accident. Reuses an existing Stashpad tab on
    // that folder if one's open, else opens a fresh one, then focuses
    // the note.
    this.addCommand({
      id: "stashpad-reveal-active-note",
      name: "Open this note in Stashpad",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && file.extension === "md" && this.isStashpadNoteFile(file);
        if (checking) return ok;
        if (ok && file) void this.revealNoteInStashpad(file);
        return ok;
      },
    });
    // 0.73.11: per-panel shortcuts — open the sidebar panels view AND
    // select the matching tab (Pinned / Shared / Tasks).
    const panelIds = Object.keys(PANEL_REGISTRY) as PanelId[];
    for (const id of panelIds) {
      const meta = PANEL_REGISTRY[id];
      this.addCommand({
        id: `stashpad-open-panels-${id}`,
        name: `Open Stashpad panel: ${meta.label}`,
        callback: async () => {
          await openStashpadPanelsView(this.app);
          // Find the now-active panels view and flip it to the picked
          // panel. There's at most one panels view per workspace.
          const leaves = this.app.workspace.getLeavesOfType(STASHPAD_PANELS_VIEW_TYPE);
          const view = leaves[0]?.view as StashpadPanelsView | undefined;
          view?.setActivePanel?.(id);
        },
      });
    }
    this.addCommand({ id: "stashpad-swap-with-parent", name: "Swap with parent (ouroboros)", callback: () => call("cmdSwapWithParent") });
    this.addCommand({ id: "stashpad-toggle-pin", name: "Pin / unpin selected note (sidebar)", callback: () => call("cmdTogglePin") });
    // 0.61.1: tiny mode — opens a popout window with the minimal shell
    // (folder/focus title + list + composer + sticky/expand controls).
    this.addCommand({
      id: "stashpad-open-tiny",
      name: "Open Stashpad in tiny window",
      callback: () => void this.openTinyWindow(),
    });
    // Mirror of the "copy" / duplicate button in the focused-header
    // actions cluster. Three synonyms in the name for fuzzy lookup.
    this.addCommand({ id: "stashpad-clone-tab", name: "Clone (duplicate / copy) this Stashpad tab", callback: () => call("cmdCloneStashpadTab") });
    this.addCommand({
      id: "stashpad-undo",
      name: "Undo last Stashpad action",
      callback: () => call("cmdUndo"),
    });
    this.addCommand({
      id: "stashpad-redo",
      name: "Redo last undone Stashpad action",
      callback: () => call("cmdRedo"),
    });
    this.addCommand({
      id: "stashpad-export-stash",
      name: "Export selection to .stash",
      callback: () => call("cmdExportStash"),
    });
    this.addCommand({
      id: "stashpad-export-okf",
      name: "Export selection as OKF bundle (.zip / .tar.gz / .stash)",
      callback: () => call("cmdExportOkf"),
    });
    this.addCommand({
      id: "stashpad-import-stash",
      name: "Import .stash file…",
      callback: () => call("cmdImportStash"),
    });
    // 0.65.0: command-palette entry calls the plugin's unified picker
    // directly so it works even when no Stashpad tab is active. (The
    // view-local `call("cmdOpenFolderPicker")` only fires when an
    // active Stashpad view is present.) Renamed for the broader scope.
    this.addCommand({
      id: "stashpad-pick-folder",
      name: "Stashpad: open / switch / create folder…",
      callback: () => this.openFolderPicker(),
    });
    this.addCommand({
      id: "stashpad-run-integrity-check",
      name: "Run integrity check on active Stashpad folder",
      checkCallback: (checking) => {
        const v = getActiveView();
        const folder = (v && (v as any).noteFolder) as string | undefined;
        if (!folder) return false;
        if (checking) return true;
        new Notice(`Running integrity check on "${folder}"…`);
        void this.runIntegrityCheckOnFolder(folder).then(() => {
          new Notice(`Integrity check complete — see Stashpad log.`);
        });
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-fix-orphans",
      name: "Set missing parents to Home (orphan fix)",
      callback: () => void this.fixOrphanParents(),
    });
    // 0.77.2: rebuild the author registry from a full vault scan.
    this.addCommand({
      id: "stashpad-rebuild-author-registry",
      name: "Rebuild author registry (scan authors + note frontmatter)",
      callback: async () => {
        new Notice("Stashpad: rebuilding author registry…");
        try {
          const r = await this.rebuildAuthorRegistry();
          this.notifications.show({
            message: `Author registry rebuilt: ${r.total} author(s) — ${r.fromStubs} from stubs, ${r.fromNotes} from note links.`,
            kind: "success",
            category: "system",
          });
        } catch (e) {
          new Notice(`Author registry rebuild failed: ${(e as Error).message}`);
        }
      },
    });
    // 0.77.3: regenerate any author stub files that were deleted, from
    // the registry's remembered name/role/department.
    this.addCommand({
      id: "stashpad-restore-author-stubs",
      name: "Restore missing author stubs (from registry)",
      callback: async () => {
        new Notice("Stashpad: restoring author stubs…");
        try {
          const r = await this.restoreMissingAuthorStubs();
          this.notifications.show({
            message: r.created > 0
              ? `Restored ${r.created} author stub(s) across ${r.folders} folder(s).`
              : `No missing author stubs — all present across ${r.folders} folder(s).`,
            kind: "success",
            category: "system",
          });
        } catch (e) {
          new Notice(`Restore author stubs failed: ${(e as Error).message}`);
        }
      },
    });
    // 0.58.0: rebootstrap as a command palette entry — mirrors the
    // "Rebootstrap now" button in settings. Useful when troubleshooting
    // / migrating without opening Settings.
    this.addCommand({
      id: "stashpad-sync-authors",
      name: "Sync authors across all folders (multiplayer)",
      callback: () => void this.syncAuthorsAcrossFolders(),
    });
    this.addCommand({
      id: "stashpad-rebootstrap-all",
      name: "Rebootstrap all Stashpad folders (backfill metadata + rename stale titles)",
      callback: async () => {
        new Notice("Stashpad: rebootstrapping…");
        try {
          const { touched, fmChecked, fmWritten, slugsRenamed, authors, imported, attachmentsLinked } = await this.rebootstrapAllFolders();
          const parts: string[] = [];
          parts.push(`rebootstrapped ${touched.length} folder${touched.length === 1 ? "" : "s"}`);
          if (imported > 0) parts.push(`imported ${imported} loose file${imported === 1 ? "" : "s"}`);
          if (attachmentsLinked > 0) parts.push(`linked attachments on ${attachmentsLinked} note${attachmentsLinked === 1 ? "" : "s"}`);
          if (fmWritten > 0) parts.push(`updated ${fmWritten} note${fmWritten === 1 ? "" : "s"}' metadata`);
          if (slugsRenamed > 0) parts.push(`renamed ${slugsRenamed} note${slugsRenamed === 1 ? "" : "s"}`);
          if (authors > 0) parts.push(`${authors} author${authors === 1 ? "" : "s"} in registry`);
          parts.push(`(checked ${fmChecked} total)`);
          new Notice(`Stashpad: ${parts.join(" · ")}`);
        } catch (e) {
          new Notice(`Stashpad: rebootstrap failed (${(e as Error).message})`);
        }
      },
    });
    this.addCommand({
      id: "stashpad-adopt-note",
      name: "Adopt active note into Stashpad (fill missing frontmatter)",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (checking) return true;
        void this.adoptNote(f);
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-open-notification-history",
      name: "Open notification history",
      callback: () => {
        // Lazy require to avoid a hard import dependency at plugin
        // load time — the modal pulls in modals.ts which is fine but
        // we keep the surface area minimal.
        void import("./modals").then(({ NotificationHistoryModal, LogModal }) => {
          new NotificationHistoryModal(
            this.app,
            this.notifications,
            async () => {
              const adapter = this.app.vault.adapter;
              const path = this.pluginPrivatePath("log.jsonl");
              if (!(await adapter.exists(path))) {
                new Notice("No log yet — make some changes first.");
                return;
              }
              const data = await adapter.read(path);
              new LogModal(this.app, data, path).open();
            },
            this.settings.authorId || null,
            (id) => this.lookupNoteAuthorIds(id),
          ).open();
        });
      },
    });
    // 0.73.12: every General-tab settings toggle now mirrors into the
    // command palette as "Toggle: <name>". Lets power users flip
    // behavior without opening Settings. Fires a Notice confirming
    // the new state. Booleans only — text/textarea/dropdown settings
    // stay in the Settings UI where they belong.
    const TOGGLES: Array<{ key: keyof StashpadSettings; label: string }> = [
      { key: "prefixTimestampsOnCopy",    label: "Prefix timestamps when copying" },
      { key: "useTemplatesFormat",        label: "Use Templates plugin date/time formats" },
      { key: "autoNavOnMoveIn",           label: "Auto-navigate into parent on move IN" },
      { key: "autoNavOnMoveOut",          label: "Auto-navigate to destination on move OUT" },
      { key: "confirmCrossParentDrag",    label: "Confirm cross-parent drag-and-drop" },
      { key: "confirmBulkDelete",         label: "Confirm bulk deletes" },
      { key: "confirmAttachmentDelete",   label: "Offer to delete attachments with note" },
      { key: "autofocusComposerAfterSend", label: "Autofocus composer after sending" },
      { key: "popoutDuplicates",          label: "Open in new window — duplicate tab" },
      { key: "autoExpandCursorRow",       label: "Expand the cursor row's body automatically" },
      { key: "autoOpenDetailPanel",       label: "Auto-open the detail panel" },
      { key: "doubleClickToFocus",        label: "Double-click a note to open it" },
    ];
    for (const t of TOGGLES) {
      const cmdId = `stashpad-toggle-${String(t.key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      this.addCommand({
        id: cmdId,
        name: `Toggle: ${t.label}`,
        callback: async () => {
          const next = !(this.settings as any)[t.key];
          (this.settings as any)[t.key] = next;
          await this.saveSettings();
          new Notice(`${t.label}: ${next ? "ON" : "OFF"}`);
        },
      });
    }
    this.addCommand({
      id: "stashpad-open-settings",
      name: "Open Stashpad settings",
      callback: () => {
        const setting = (this.app as any).setting;
        if (!setting?.open || !setting?.openTabById) return;
        setting.open();
        setting.openTabById(this.manifest.id);
      },
    });
    // 0.73.13: search-focused shortcut — opens Settings and lands the
    // cursor in the search box so the user types straight into it.
    this.addCommand({
      id: "stashpad-search-settings",
      name: "Search Stashpad settings…",
      callback: () => {
        const setting = (this.app as any).setting;
        if (!setting?.open || !setting?.openTabById) return;
        setting.open();
        setting.openTabById(this.manifest.id);
        // 0.94.4: focus Obsidian's NATIVE settings search input (the old
        // in-plugin search box is gone — settings are indexed via
        // getSettingDefinitions now).
        setTimeout(() => {
          const inp = setting?.modalEl?.querySelector?.("input[type='search']") as HTMLInputElement | undefined;
          inp?.focus();
        }, 0);
      },
    });
    // 0.73.10: per-tab settings shortcuts. Each opens the Settings
    // modal scrolled to the matching tab of the redesigned tabbed UI.
    for (const t of SETTINGS_TABS) {
      this.addCommand({
        id: `stashpad-open-settings-${t.id}`,
        name: `Open Stashpad settings: ${t.label}`,
        callback: () => {
          const setting = (this.app as any).setting;
          if (!setting?.open || !setting?.openTabById) return;
          // 0.94.4: native settings own page navigation; we can't deep-link to
          // a specific sub-page, so this lands on Stashpad's settings page list.
          setting.open();
          setting.openTabById(this.manifest.id);
        },
      });
    }
    // 0.71.0 / 0.71.2: JD-style index builder.
    // Two commands so the heavyweight "create Stashpad notes" is
    // separable from the cheap single-file Preview that the user can
    // inspect before committing.
    const openSettingsToJd = (): void => {
      const setting = (this.app as any).setting;
      if (!setting?.open || !setting?.openTabById) return;
      setting.open();
      setting.openTabById(this.manifest.id);
      // Scroll to the JD section if the heading is present.
      setTimeout(() => {
        const header = document.getElementById("stashpad-jd-index-section");
        header?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    };
    this.addCommand({
      id: "stashpad-preview-jd-index",
      name: "Preview JD index (overwrites home note body)",
      callback: async () => {
        try {
          const { buildJdIndexPreview } = await import("./index-builder");
          const result = await buildJdIndexPreview(this.app, this, this.settings);
          if (result.error === "no-dest") {
            new Notice("Set a Designated Stashpad folder for Index in settings first.", 6000);
            openSettingsToJd();
            return;
          }
          if (result.error === "no-home") {
            new Notice(
              `"${this.settings.jdIndexStashpadFolder}" has no Stashpad home note. Open the folder in Stashpad first to create one.`,
              7000,
            );
            return;
          }
          const { buildJdPreviewNotice } = await import("./index-builder");
          buildJdPreviewNotice(this.app, result);
        } catch (err) {
          console.error("[stashpad] preview failed", err);
          new Notice(`Preview failed: ${(err as Error)?.message ?? err}`, 8000);
        }
      },
    });
    this.addCommand({
      id: "stashpad-build-jd-index",
      name: "Build JD index notes (creates Stashpad-note hierarchy)",
      callback: async () => {
        try {
          const { buildJdIndexNotes, scanForJdNotes, JdBuildConfirmModal } = await import("./index-builder");
          const dest = (this.settings.jdIndexStashpadFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
          if (!dest) {
            new Notice("Set a Designated Stashpad folder for Index in settings first.", 6000);
            openSettingsToJd();
            return;
          }
          const scan = scanForJdNotes(this.app, this, this.settings);
          // 0.71.3: route through the confirm modal so first-time users
          // see the "Preview first?" affordance + large-build warning.
          const modal = new JdBuildConfirmModal(
            this.app,
            this,
            this.settings,
            scan.indexed.length,
            async () => {
              try {
                const result = await buildJdIndexNotes(this.app, this, this.settings);
                if (result.error === "no-dest") {
                  new Notice("Set a Designated Stashpad folder for Index in settings first.", 6000);
                  openSettingsToJd();
                  return;
                }
                if (result.error === "dest-not-stashpad") {
                  new Notice(
                    `"${result.destFolder}" isn't a known Stashpad folder. Pick a real Stashpad folder in settings.`,
                    7000,
                  );
                  openSettingsToJd();
                  return;
                }
                this.settings.jdIndexHasBuilt = true;
                await this.saveSettings();
                new Notice(
                  `Index built: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped → ${result.destFolder}`,
                  6000,
                );
              } catch (err) {
                console.error("[stashpad] build failed", err);
                new Notice(`Build failed: ${(err as Error)?.message ?? err}`, 8000);
              }
            },
          );
          modal.open();
        } catch (err) {
          console.error("[stashpad] build failed", err);
          new Notice(`Build failed: ${(err as Error)?.message ?? err}`, 8000);
        }
      },
    });

    // Drop-folder watcher: a .stash file appearing (created OR moved) inside any
    // "<stashpadFolder>/<dropSub>/" path gets auto-imported into that <stashpadFolder>.
    const onMaybeDrop = (file: TFile) => {
      if (file.extension !== STASH_EXT) return;
      const dropSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
      const exportSub = (this.settings.exportFolder || "").trim().replace(/^\/+|\/+$/g, "");
      const parent = file.parent?.path || "";
      const parentBase = parent.split("/").pop() ?? "";
      // Case 1: dropped into the configured `_imports` drop subfolder.
      if (dropSub && parentBase === dropSub) {
        // Guard: ignore files that came from an export folder of the same Stashpad folder.
        if (exportSub && parent.endsWith(`/${exportSub}`)) return;
        // Destination = the parent of the dropSub (i.e. the actual Stashpad folder).
        const destFolder = parent.slice(0, parent.length - dropSub.length).replace(/\/+$/, "") || this.settings.folder;
        void this.autoImportStash(file, destFolder);
        return;
      }
      // Case 2 (0.84.10): with auto-import ON, a .stash dropped directly in a
      // Stashpad folder ROOT auto-imports too — matching the manual loose-import
      // command, so a blank importDropFolder no longer silently disables it.
      // Reserved subfolders (incl. _exports, where our own exports land) are
      // excluded so an export never gets re-imported.
      if (!this.settings.autoImport) return;
      // Skip Obsidian's startup `create` replay — otherwise every pre-existing
      // root-level .stash would auto-import on each launch. Armed ~2.5s after
      // layout-ready (shared with the loose-file watcher).
      if (!this.importService.isArmed()) return;
      if (isInReservedSubfolder(file.path)) return;
      if (this.discoverStashpadFolders().includes(parent)) {
        void this.autoImportStash(file, parent);
      }
    };
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) onMaybeDrop(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) onMaybeDrop(file);
    }));

    // Auto-fix orphan parent frontmatter on .md files that arrive in a
    // Stashpad folder (via create or rename). Waits briefly for the
    // metadataCache to parse, then runs the same guarded check as the
    // manual fixOrphanParents command — but for one file. Existing
    // notes whose parent is already set are never touched.
    const onMaybeOrphan = (file: TFile): void => {
      if (file.extension !== "md") return;
      const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!this.discoverStashpadFolders().includes(dir)) return;
      // Defer to give metadataCache time to parse the frontmatter.
      setTimeout(() => { void this.fixOrphanParentForFile(file); }, 800);
    };
    // 0.72.5: bare .md files dropped into <stashpad>/<importSub>/ get
    // adopted into the parent Stashpad — move them up to the folder
    // root + stamp orphan frontmatter so they appear as Home-rooted
    // notes. Mirrors what .stash drops already do, but for raw
    // markdown the user shares without packaging.
    const onMaybeMarkdownImport = (file: TFile): void => {
      if (file.extension !== "md") return;
      const dropSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
      if (!dropSub) return;
      const parent = file.parent?.path?.replace(/\/+$/, "") ?? "";
      const parentBase = parent.split("/").pop() ?? "";
      if (parentBase !== dropSub) return;
      // Stashpad folder is the parent of the dropSub.
      const stashFolder = parent.slice(0, parent.length - dropSub.length).replace(/\/+$/, "");
      if (!stashFolder || !this.discoverStashpadFolders().includes(stashFolder)) return;
      // Defer to let the metadataCache parse the file, then move it
      // up + run the orphan-fix path. Picks a unique filename if a
      // name collision exists at the destination.
      setTimeout(() => { void this.adoptMarkdownDrop(file, stashFolder); }, 200);
    };
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) { onMaybeOrphan(file); onMaybeMarkdownImport(file); }
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) { onMaybeOrphan(file); onMaybeMarkdownImport(file); }
    }));
    // 0.95.1: a Stashpad folder was deleted (panel button OR file explorer OR
    // anywhere) — close its open tabs + notify. The "delete" event fires after
    // the folder's notes are gone, so we rely on the knownStashpadFolders
    // snapshot (refreshed on every discoverStashpadFolders) to recognize it.
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFolder)) return;
      const cleaned = file.path.replace(/\/+$/, "");
      if (this.knownStashpadFolders.has(cleaned)) void this.handleStashpadFolderDeleted(cleaned);
    }));
    // 0.86.5: when a note's FILE moves to a DIFFERENT folder (e.g. dragged in
    // Obsidian's file explorer), its `parent` still points at a note in the OLD
    // folder — a dangling parent that orphans it in the new one. The
    // missing-parent orphan-fix above doesn't catch this (the parent value is
    // present, just invalid here), so re-home such notes to Home. Gated on a
    // real cross-folder move, so in-folder reparents/renames are untouched.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.maybeReHomeOnCrossFolderMove(file, oldPath);
    }));

    // 0.98.25 (Phase 4): archive folders — a note MOVED into a marked folder is
    // auto-encrypted after a settle window. Move-in only (rename event), never
    // create/edit, so a note being written can't be locked out from under you.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.maybeArchiveOnMoveIn(file, oldPath);
    }));

    // 0.79.1: auto-import — any file appearing directly in a Stashpad
    // folder root (not a reserved subfolder, not an existing note) gets
    // turned into a note. The service guards + debounces internally.
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.importService.enqueue(file);
      else if (file instanceof TFolder) this.importService.enqueueFolder(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) this.importService.enqueue(file);
      else if (file instanceof TFolder) this.importService.enqueueFolder(file);
    }));

    // Multiplayer: keep settings.authorName in sync with the on-disk
    // _authors stub file basenames. If the user renames their author
    // file in Obsidian (file explorer), we update the setting and
    // propagate the new name back across every Stashpad's _authors
    // folder so all stubs stay aligned. Reverse direction (settings →
    // files) lives in syncAuthorFilesToName, called from the settings
    // tab's onChange.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      void this.maybeAdoptAuthorRename(file, oldPath);
    }));

    // 0.76.31: detect when a newer plugin build has synced in but
    // Obsidian is still running the old code (no hot-reload). Check
    // shortly after load (let Sync settle) and whenever the app
    // foregrounds. Nudges the user to reload so they're not stuck on
    // stale code (the "old UI after opening the app" report).
    this.registerDomEvent(window, "focus", () => void this.checkForSyncedBuild());
    setTimeout(() => void this.checkForSyncedBuild(), 5000);
    // 0.92.2: also poll periodically. Focus + one-shot-at-5s missed the case
    // where a newer build lands WHILE the window stays focused (a fresh deploy,
    // or Sync pushing a build mid-session) — without a refocus nothing
    // re-checked, so the reload nudge never appeared. A 45s poll catches it.
    // (checkForSyncedBuild dedupes on version, so a quiet vault costs one cheap
    // manifest read per tick and shows the toast at most once per new version.)
    this.registerInterval(window.setInterval(() => void this.checkForSyncedBuild(), 45_000));
  }

  /** 0.76.31: compare the version Obsidian LOADED (this.manifest, read
   *  from manifest.json at launch) against the manifest.json currently
   *  on disk. If they differ, a different build has synced in since
   *  launch and the user is running stale code — surface a persistent
   *  notice with a Reload action. 0.89.1: the action now runs the FULL app
   *  reload ("Reload app without saving") — plugin disable/enable often left
   *  the renderer on the cached old main.js, so the update "didn't take".
   *  Notifies once per detected on-disk version. */
  private notifiedBuildVersion: string | null = null;
  private async checkForSyncedBuild(): Promise<void> {
    try {
      const dir = (this.manifest as any).dir as string | undefined;
      if (!dir) return;
      const path = `${dir.replace(/\/+$/, "")}/manifest.json`;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return;
      const onDisk = JSON.parse(await adapter.read(path))?.version as string | undefined;
      const loaded = this.manifest.version;
      if (typeof onDisk !== "string" || !onDisk || onDisk === loaded) return;
      // 0.76.35: ONLY nudge when the on-disk build is strictly newer than
      // what's running. If on-disk is OLDER (e.g. Obsidian Sync pushed a
      // stale manifest.json back onto disk — a known Sync regression),
      // reloading wouldn't help and the nudge would recur on every window
      // focus forever. Silently ignore older/equal on-disk versions.
      if (!this.isSemverGreater(onDisk, loaded)) return;
      if (this.notifiedBuildVersion === onDisk) return;
      this.notifiedBuildVersion = onDisk;
      this.notifications.show({
        message: `A newer Stashpad build synced in (\`${loaded}\` → \`${onDisk}\`). Reload the app to apply it.`,
        kind: "info",
        category: "system",
        duration: 0,
        actions: [{
          label: "Reload app",
          onClick: () => this.reloadAppForUpdate(),
        }],
      });
    } catch (e) {
      console.debug("[Stashpad] synced-build check failed", e);
    }
  }

  /** 0.89.1: full app reload ("Reload app without saving") — the reliable way to
   *  pick up a freshly-synced build. Plugin disable/enable often left the
   *  renderer on the cached old main.js, so the update wouldn't take. Falls back
   *  to a raw window reload if the command isn't available. */
  private reloadAppForUpdate(): void {
    // 0.89.1: leave a one-shot flag so the NEXT load un-ghosts deferred Stashpad
    // tabs. Obsidian defers inactive leaves on launch; after an update reload
    // they'd otherwise sit as blank "ghost" tabs (and dead buttons) until tapped.
    // (We can't activate them here — app:reload tears down this JS context.)
    try { window.localStorage?.setItem(UNGHOST_FLAG, "1"); } catch { /* private mode */ }
    try {
      if ((this.app as any).commands?.executeCommandById?.("app:reload")) return;
    } catch (e) {
      console.warn("[Stashpad] app:reload command failed", e);
    }
    try {
      window.location.reload();
    } catch {
      new Notice("Reload Obsidian (close + reopen) to apply the Stashpad update.");
    }
  }

  /** 0.89.1: if the last reload was our update-reload, load every deferred
   *  Stashpad leaf so the tabs render with the fresh code instead of showing as
   *  blank ghosts. One-shot (clears the flag); only un-ghosts OUR view type. */
  private async unghostStashpadTabsIfFlagged(): Promise<void> {
    let flagged = false;
    try { flagged = window.localStorage?.getItem(UNGHOST_FLAG) === "1"; } catch { /* ignore */ }
    if (!flagged) return;
    try { window.localStorage?.removeItem(UNGHOST_FLAG); } catch { /* ignore */ }
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      try {
        const l = leaf as any;
        if (l.isDeferred && typeof l.loadIfDeferred === "function") await l.loadIfDeferred();
      } catch (e) {
        console.warn("[Stashpad] un-ghost leaf failed", e);
      }
    }
  }

  /** Tiny semver-ish compare: is `a` greater than `b`? Pads to equal
   *  length, numeric per segment. Non-numeric segments compare as 0. */
  private isSemverGreater(a: string, b: string): boolean {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  /** Author files live at "<stashpadFolder>/_authors/<safe-name>-<id>.md".
   *  Returns the {name, id} parsed from a path matching that pattern, or
   *  null if it doesn't fit. */
  private parseAuthorFilePath(path: string): { name: string; id: string } | null {
    const m = path.match(/\/_authors\/([^/]+?)-([a-z0-9]{4,12})\.md$/i);
    if (!m) return null;
    const name = m[1].replace(/-/g, " ");
    return { name, id: m[2] };
  }

  /** Convert an author display name to the safe filename component used
   *  in author file paths. Mirror of currentAuthorLink in view.ts. */
  private authorNameToSafe(name: string): string {
    return name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "author";
  }

  /** Forward sync: rename every existing author stub whose id matches
   *  this.settings.authorId so its filename reflects the new name.
   *  Idempotent (skips files already named correctly), so it's safe to
   *  call after every settings save. Walks all discovered Stashpads
   *  because each has its own _authors folder. */
  async syncAuthorFilesToName(): Promise<void> {
    const id = (this.settings.authorId ?? "").trim();
    const name = (this.settings.authorName ?? "").trim();
    if (!id || !name) return;
    const safe = this.authorNameToSafe(name);
    for (const folder of this.discoverStashpadFolders()) {
      const dir = `${folder}/_authors`;
      if (!(await this.app.vault.adapter.exists(dir))) continue;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(dir + "/")) continue;
        const parsed = this.parseAuthorFilePath(file.path);
        if (!parsed || parsed.id !== id) continue;
        const targetPath = `${dir}/${safe}-${id}.md`;
        let target = file;
        if (file.path !== targetPath) {
          try {
            this.authorRenameInFlight.add(file.path);
            this.authorRenameInFlight.add(targetPath);
            await this.app.fileManager.renameFile(file, targetPath);
            const f2 = this.app.vault.getAbstractFileByPath(targetPath) as TFile | null;
            if (f2) target = f2;
          } catch (e) {
            console.warn("[Stashpad] author file rename failed", e);
            continue;
          }
        }
        // Always refresh the stub's H1 + name/role/department frontmatter
        // even when no rename was needed (e.g. user only changed role).
        try { await this.refreshAuthorStub(target); } catch {}
      }
    }
  }

  /** Rewrite an author stub file's H1 heading + aliases/role/department
   *  frontmatter to match the current settings. Idempotent. 0.77.4: the
   *  display name now lives in the Obsidian-native `aliases` array; the
   *  legacy custom `name` key is migrated away (deleted) here. */
  private async refreshAuthorStub(file: TFile): Promise<void> {
    const name = (this.settings.authorName ?? "").trim();
    const role = (this.settings.authorRole ?? "").trim();
    const dept = (this.settings.authorDepartment ?? "").trim();
    if (!name) return;
    try {
      const raw = await this.app.vault.read(file);
      const replaced = raw.replace(/^# .*$/m, `# ${name}`);
      if (replaced !== raw) await this.app.vault.modify(file, replaced);
      await this.app.fileManager.processFrontMatter(file, (m: any) => {
        // Stashpad owns these stubs, so the alias list is authoritative:
        // set it to exactly the current display name. This avoids
        // accumulating stale names across renames (an old name would
        // otherwise linger as an "extra" alias). Migrate off the legacy
        // custom `name` key.
        m.aliases = [name];
        delete m.name;
        if (role) m.role = role; else delete m.role;
        if (dept) m.department = dept; else delete m.department;
      });
    } catch (e) {
      console.warn("[Stashpad] refreshAuthorStub failed", e);
    }
  }

  /** Track in-flight renames we initiated so the reverse listener
   *  (maybeAdoptAuthorRename) can ignore them and avoid feedback loops. */
  private authorRenameInFlight = new Set<string>();

  /** Reverse sync: when an author stub is renamed in the vault by the
   *  user (or any external process), pick up the new display name and
   *  update settings.authorName. The forward sync runs after to
   *  propagate the change to author stubs in other Stashpad folders. */
  private async maybeAdoptAuthorRename(file: TFile, oldPath: string): Promise<void> {
    if (this.authorRenameInFlight.delete(file.path) || this.authorRenameInFlight.delete(oldPath)) return;
    const parsed = this.parseAuthorFilePath(file.path);
    if (!parsed) return;
    const id = (this.settings.authorId ?? "").trim();
    if (!id || parsed.id !== id) return;
    const newName = parsed.name.trim();
    if (!newName || newName === (this.settings.authorName ?? "").trim()) return;
    this.settings.authorName = newName;
    await this.saveSettings();
    await this.syncAuthorFilesToName();
  }

  /** 0.72.5: move a markdown file that landed in <stashpad>/<importSub>
   *  up into the Stashpad root, then stamp Home-rooted frontmatter.
   *  Adopts files a user dropped without packaging into a .stash —
   *  they show up as fresh top-level notes ready to be reparented. */
  private async adoptMarkdownDrop(file: TFile, stashFolder: string): Promise<void> {
    try {
      // Pick a non-colliding destination filename. If <basename>.md
      // already exists in the Stashpad root, append "-1", "-2", … until
      // we find a free slot.
      const adapter = this.app.vault.adapter;
      let destName = file.name;
      const dot = destName.lastIndexOf(".");
      const stem = dot > 0 ? destName.slice(0, dot) : destName;
      const ext = dot > 0 ? destName.slice(dot) : "";
      let suffix = 0;
      while (await adapter.exists(`${stashFolder}/${destName}`)) {
        suffix += 1;
        destName = `${stem}-${suffix}${ext}`;
      }
      const destPath = `${stashFolder}/${destName}`;
      await this.app.fileManager.renameFile(file, destPath);
      // The rename event re-fires onMaybeOrphan via the registered
      // listener, which runs the standard frontmatter backfill. We
      // also call it directly here so the timing is deterministic
      // (no race against the metadataCache reparse) and the user sees
      // the adoption notice promptly.
      const moved = this.app.vault.getAbstractFileByPath(destPath);
      if (moved instanceof TFile) {
        // Small delay so metadataCache catches up to the new path.
        setTimeout(() => { void this.fixOrphanParentForFile(moved); }, 500);
      }
      this.notifications.show({
        message: `Imported \`${file.name}\` → \`${stashFolder}\``,
        kind: "success",
        category: "import",
        folder: stashFolder,
        affectedPaths: [destPath],
      });
    } catch (e) {
      console.warn("Stashpad: markdown drop adoption failed", e);
      this.notifications.show({
        message: `Couldn't import \`${file.name}\`: ${(e as Error).message}`,
        kind: "error",
        category: "import",
      });
    }
  }

  /** Single-file version of fixOrphanParents. Stamps id/parent/created
   *  iff each is missing. Never overwrites an existing value. */
  private async fixOrphanParentForFile(file: TFile): Promise<void> {
    try {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: unknown; parent?: unknown; created?: unknown } | undefined;
      const idStr = typeof fm?.id === "string" ? fm.id.trim() : "";
      const p = fm?.parent;
      const hasParent = typeof p === "string" ? p.trim() !== "" : (p !== undefined && p !== null);
      const hasCreated = typeof fm?.created === "string" && fm.created.trim() !== "";
      const addId = !idStr;
      const addParent = !hasParent;
      const addCreated = !hasCreated;
      if (!addId && !addParent && !addCreated) return;

      const { newId } = await import("./id-service");
      let stampedId: string | undefined;
      let stampedParent = false;
      let stampedCreated = false;
      await this.app.fileManager.processFrontMatter(file, (m) => {
        // Re-check inside the write against the file's TRUE frontmatter
        // (the metadataCache may have been stale when we built this
        // task — common on mobile right after a sync brings the file
        // in). Only modify slots that are actually empty on disk.
        if (addId) {
          const cur = typeof m.id === "string" ? m.id.trim() : "";
          if (!cur) { stampedId = newId(); m.id = stampedId; }
        }
        if (addParent) {
          const cur = m.parent;
          const set = typeof cur === "string" ? cur.trim() !== "" : (cur !== undefined && cur !== null);
          if (!set) { m.parent = ROOT_ID; stampedParent = true; }
        }
        if (addCreated) {
          const cur = typeof m.created === "string" ? m.created.trim() : "";
          if (!cur) { m.created = new Date(file.stat.ctime).toISOString(); stampedCreated = true; }
        }
      });
      // No-op if the file was already valid (the cache was stale but the
      // disk content was fine). Don't log, don't notify.
      if (!stampedId && !stampedParent && !stampedCreated) return;
      const log = this.newLog();
      const id = stampedId || idStr;
      if (id) {
        await log.append({
          type: "parent_change", id,
          payload: { from: null, to: ROOT_ID, reason: "orphan_auto_fix", path: file.path,
            addedId: !!stampedId, addedParent: stampedParent, addedCreated: stampedCreated },
        });
      }
      new Notice(`Adopted ${file.basename} → Home`);
    } catch (e) {
      console.warn("Stashpad: orphan auto-fix failed", e);
    }
  }

  /** 0.86.5: paths with a pending re-home check (de-dupes burst rename events). */
  private reHomePending = new Set<string>();

  /** A markdown note's file just moved. If it landed in a DIFFERENT Stashpad
   *  folder and its `parent` points at a note that isn't in the new folder,
   *  re-home it to ROOT after a debounce (lets the metadata cache settle and
   *  lets a Stashpad-initiated move stamp the correct parent first). */
  private maybeReHomeOnCrossFolderMove(file: TFile, oldPath: string): void {
    if (file.extension !== "md") return;
    const newDir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const slash = oldPath.lastIndexOf("/");
    const oldDir = (slash >= 0 ? oldPath.slice(0, slash) : "").replace(/\/+$/, "");
    if (newDir === oldDir) return;                                  // not a cross-folder move
    if (!this.discoverStashpadFolders().includes(newDir)) return;   // not moved into a Stashpad
    if (this.reHomePending.has(file.path)) return;
    this.reHomePending.add(file.path);
    setTimeout(() => {
      this.reHomePending.delete(file.path);
      void this.reHomeDanglingParent(file, newDir);
    }, 900);
  }

  /** Set `parent` to ROOT iff the note's current parent is a non-ROOT id with
   *  no matching note in `dir`. Conservative: a present, resolvable parent (and
   *  one Stashpad's own move already fixed) is left alone. */
  private async reHomeDanglingParent(file: TFile, dir: string): Promise<void> {
    try {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: unknown; parent?: unknown } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      const parent = typeof fm?.parent === "string" ? fm.parent.trim() : "";
      if (!id || !parent || parent === ROOT_ID) return;            // no id / no or home parent
      const parentInFolder = this.app.vault.getMarkdownFiles().some((f) =>
        (f.parent?.path?.replace(/\/+$/, "") ?? "") === dir
        && this.app.metadataCache.getFileCache(f)?.frontmatter?.id === parent);
      if (parentInFolder) return;                                  // parent resolves here — fine
      await this.app.fileManager.processFrontMatter(file, (m: any) => {
        // re-check against disk truth (cache may have lagged)
        const cur = typeof m.parent === "string" ? m.parent.trim() : "";
        if (cur && cur !== ROOT_ID) m.parent = ROOT_ID;
      });
      await this.newLog().append({
        type: "parent_change", id,
        payload: { from: parent, to: ROOT_ID, reason: "rehome_cross_folder_move", path: file.path },
      });
      new Notice(`Re-homed ${file.basename} → Home (its parent isn't in this folder)`);
    } catch (e) {
      console.warn("[Stashpad] re-home on cross-folder move failed", e);
    }
  }

  private async autoImportStash(file: TFile, destFolder: string): Promise<void> {
    try {
      const raw = new Uint8Array(await this.app.vault.readBinary(file));
      // 0.84.16: an encrypted .stash arriving via the live drop-watcher is NOT
      // prompted inline anymore — park it and surface the same non-blocking
      // "import?" notification as the sweep (notification-first; the password
      // modal opens only when you click "Import now"). Don't trash the source.
      if (isEncryptedStash(raw)) {
        this.importService.parkEncrypted(file.path);
        this.notifyPendingEncrypted();
        return;
      }
      // Plain .stash imports straight away.
      const buf = await resolveStashBytes(this.app, raw);
      if (!buf) return;
      const view = getActiveView();
      const existingIds = new Set<string>();
      if (view && typeof (view as any).collectExistingIds === "function" && (view as any).noteFolder === destFolder) {
        // Reuse the active view's tree if it already points at the destination folder.
        for (const id of (view as any).collectExistingIds() as Set<string>) existingIds.add(id);
      } else {
        // Otherwise scan the destination folder ourselves.
        for (const f of this.app.vault.getMarkdownFiles()) {
          if (!f.path.startsWith(destFolder + "/")) continue;
          const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
          if (typeof id === "string") existingIds.add(id);
        }
      }
      const summary = await importStashZip(this.app, buf, destFolder, existingIds);
      try {
        await this.newLog().append({
          type: "stash_import",
          id: ROOT_ID,
          payload: {
            from: file.path, into: destFolder,
            noteCount: summary.notesWritten,
            attachmentsWritten: summary.attachmentsWritten,
            collisionsRenamed: summary.collisionsRenamed,
            auto: true,
          },
        });
      } catch {}
      // Send the processed file to trash (respects the user's "Deleted files" setting in Obsidian).
      try { await this.app.fileManager.trashFile(file); } catch {}
      const parts = [`Auto-imported ${summary.notesWritten} note${summary.notesWritten === 1 ? "" : "s"} from ${file.name}`];
      if (summary.attachmentsWritten) parts.push(`+ ${summary.attachmentsWritten} attachment${summary.attachmentsWritten === 1 ? "" : "s"}`);
      if (summary.collisionsRenamed) parts.push(`(${summary.collisionsRenamed} renamed)`);
      this.notifications.show({
        message: parts.join(" "),
        kind: "success",
        category: "import",
        folder: destFolder,
      });
      if (view && typeof (view as any).debouncedRender === "function") (view as any).debouncedRender();
    } catch (e) {
      this.notifications.show({
        message: `Stashpad: auto-import failed\nFile: \`${file.name}\`\nError: ${(e as Error).message}\nInspect with the buttons below — rename to .zip to crack it open in an archive tool.`,
        kind: "error",
        category: "import",
        affectedPaths: [file.path],
        // On failure, the source .stash is NOT trashed (only success
        // trashes), so the file is still at its drop path. Reveal /
        // Show actions point at it for inspection.
        actions: buildFileActions(this.app, file.path, Platform.isMobile),
      });
      console.error(e);
    }
  }

  /** Resolve a Stashpad id → all author + contributor ids for that
   *  note. Author lives in frontmatter as a wikilink (e.g.
   *  `[[demo/_authors/Jane-743jcy.md|Jane]]`); contributors is an
   *  array of the same shape. Each wikilink has the authorId as the
   *  `-<id>` suffix of the target's basename.
   *
   *  Returns the distinct list — for the history modal's
   *  Cross-author filter, "any party of an affected note differs
   *  from the actor" is enough to qualify.
   *
   *  O(n) per call (full vault scan). Acceptable since this fires
   *  only inside the history filter, not in any hot path. Returns
   *  [] when the id isn't found or all fields are absent / malformed. */
  lookupNoteAuthorIds(id: string): string[] {
    const out = new Set<string>();
    const extract = (raw: unknown): string | null => {
      if (typeof raw !== "string") return null;
      const m = raw.match(/-([a-z0-9]{4,12})(?:\.md)?(?:\||\]\])/i);
      return m ? m[1] : null;
    };
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.id !== id) continue;
      const author = extract(fm?.author);
      if (author) out.add(author);
      const contribs = fm?.contributors;
      if (Array.isArray(contribs)) {
        for (const c of contribs) {
          const cid = extract(c);
          if (cid) out.add(cid);
        }
      }
      break;
    }
    return Array.from(out);
  }

  /** Back-compat wrapper for callers that just want the primary
   *  author. Unused since 0.55.15 — the history modal now consumes
   *  lookupNoteAuthorIds directly — but kept for downstream / future
   *  callers that need the simpler shape. */
  lookupNoteAuthorId(id: string): string | null {
    return this.lookupNoteAuthorIds(id)[0] ?? null;
  }

  /** Walk every folder in the vault that contains a Stashpad home note (id=__root__),
   *  ensure it has the import/export subfolders, and run the redundant-frontmatter
   *  backfill (parentLink + children) so older notes pick up the recovery fields.
   *  Used by the "Rebootstrap" button in settings to retrofit older folders. */
  async rebootstrapAllFolders(): Promise<{ touched: string[]; fmChecked: number; fmWritten: number; slugsRenamed: number; authors: number; imported: number; attachmentsLinked: number }> {
    // 0.79.19: suppress contribution stamping for the duration (+ a short
    // tail to catch async link-rewrite modify events) so rebootstrap never
    // bumps `modified`/`created` or adds contributors.
    this.rebootstrapInProgress = true;
    try {
      return await this.rebootstrapAllFoldersInner();
    } finally {
      window.setTimeout(() => { this.rebootstrapInProgress = false; }, 2500);
    }
  }

  private async rebootstrapAllFoldersInner(): Promise<{ touched: string[]; fmChecked: number; fmWritten: number; slugsRenamed: number; authors: number; imported: number; attachmentsLinked: number }> {
    const ROOT_ID = "__root__";
    const seen = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (id !== ROOT_ID) continue;
      const folder = f.parent?.path;
      if (folder) seen.add(folder);
    }
    const importSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const exportSub = (this.settings.exportFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const touched: string[] = [];
    const ensureFolder = async (path: string) => {
      if (!path) return;
      if (await this.app.vault.adapter.exists(path)) return;
      try {
        await this.app.vault.createFolder(path);
      } catch (e) {
        const msg = (e as Error)?.message ?? "";
        if (!/already exists/i.test(msg)) throw e;
      }
    };
    let fmChecked = 0;
    let fmWritten = 0;
    let slugsRenamed = 0;
    let imported = 0;
    const okfSet = new Set(this.okfActiveFolders());
    for (const folder of seen) {
      try {
        if (importSub) await ensureFolder(`${folder}/${importSub}`);
        if (exportSub) await ensureFolder(`${folder}/${exportSub}`);
        // 0.79.5: sweep any pre-existing loose files in the folder root
        // into notes (the rebootstrap "provision" for auto-import). Gated
        // on the autoImport setting so a user who turned it off isn't
        // surprised. Runs before the frontmatter backfill so the new notes
        // get stamped in the same pass.
        // 0.84.7: now goes through the shared importLooseInto (files +
        // folders), so rebootstrap also sweeps loose SUBFOLDERS into nested
        // note trees and inherits the reserved-merge / identity-preserving
        // adoption fixes — same code path as the standalone command.
        if (this.settings.autoImport) {
          try {
            const swept = await this.importService.importLooseInto(folder);
            imported += swept.files + swept.folders + swept.stashes;
          } catch (e) { console.warn("Stashpad: loose sweep failed", folder, e); }
        }
        // Standalone (no-view-required) frontmatter backfill: reads
        // metadata cache, skip-if-equal, writes only what's actually
        // different. Paced internally so multi-folder rebootstrap
        // doesn't stall the FS.
        const stats = await rebootstrapFolderFrontmatter(this.app, folder);
        fmChecked += stats.checked;
        fmWritten += stats.written;
        // 0.58.1: rename files whose slug no longer matches their body's
        // first line — catches notes from before the auto-retitle logic
        // landed (and any whose body was edited without the per-view
        // scheduleSlugRename firing).
        slugsRenamed += await this.rebootstrapFolderSlugs(folder);
        // 0.102.x: rebootstrap also fixes OKF frontmatter + regenerates index.md
        // for OKF-enabled folders (those using the OKF template). The OKF-section
        // "Rebuild" button is just a scoped shortcut to this same pass — not an
        // alias for the whole rebootstrap.
        if (okfSet.has(folder.replace(/\/+$/, ""))) {
          try { await rebuildOkfForFolder(this.app, folder); } catch (e) { console.warn("Stashpad: OKF rebuild during rebootstrap failed", folder, e); }
        }
        touched.push(folder);
      } catch (e) {
        console.warn(`Stashpad: rebootstrap skipped ${folder}`, e);
      }
    }
    // 0.77.6: rebootstrap is the catch-all full-vault repair, so refresh
    // the author registry cache from the same scan. This is read-only
    // w.r.t. the user's notes (it only rewrites the plugin-private
    // authors.json). NOTE: we deliberately do NOT restore deleted author
    // STUB files here — that creates files and a user may have deleted a
    // page on purpose; stub restoration stays an explicit action.
    let authors = 0;
    try { authors = (await this.rebuildAuthorRegistry()).total; }
    catch (e) { console.warn("Stashpad: rebootstrap author-registry rebuild failed", e); }
    // 0.79.18: convert any plain-text attachment frontmatter to links.
    let attachmentsLinked = 0;
    try { attachmentsLinked = await this.convertAttachmentsToLinks(); }
    catch (e) { console.warn("Stashpad: attachment-link conversion failed", e); }
    return { touched, fmChecked, fmWritten, slugsRenamed, authors, imported, attachmentsLinked };
  }

  /** Walk every Stashpad note in `folder`. For each one whose filename
   *  slug no longer matches its current body's first line, rename via
   *  fileManager.renameFile. Returns the number of files renamed.
   *  Standalone — no view dependency. 0.58.1. */
  private async rebootstrapFolderSlugs(folder: string): Promise<number> {
    const ROOT_ID = "__root__";
    const dir = folder.replace(/\/+$/, "");
    const stopwords = this.settings.slugStopWords ?? DEFAULT_STOPWORDS;
    let renamed = 0;
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.parent?.path?.replace(/\/+$/, "") ?? "";
      return p === dir;
    });
    for (const file of files) {
      const id = parseIdFromFilename(file.basename);
      if (!id || id === ROOT_ID) continue;
      // Confirm it's actually a Stashpad note (id matches frontmatter).
      const fmId = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
      if (fmId !== id) continue;
      try {
        const raw = await this.app.vault.cachedRead(file);
        const body = raw.startsWith("---")
          ? raw.slice(raw.indexOf("\n---", 3) + 4).replace(/^\r?\n/, "")
          : raw;
        const newSlug = bodyToSlug(body, stopwords);
        const desired = buildFilename(newSlug, id);
        if (file.name === desired) continue;
        const newPath = file.parent ? `${file.parent.path}/${desired}` : desired;
        if (this.app.vault.getAbstractFileByPath(newPath)) continue;
        await this.app.fileManager.renameFile(file, newPath);
        renamed += 1;
      } catch (e) {
        console.warn(`Stashpad: slug rebootstrap skipped ${file.path}`, e);
      }
    }
    return renamed;
  }

  // ---------- Sidebar panels (0.68.0) ----------

  /** 0.74.1: subscribe to Stashpad-view selection changes. Listeners
   *  fire whenever a Stashpad view's cursor/selection mutates. The
   *  detail panel uses this to re-render in lock-step with the user
   *  arrow-keying through the list. Returns an unsubscribe handle. */
  onStashpadSelectionChange(fn: () => void): () => void {
    this.stashpadSelectionListeners.add(fn);
    return () => this.stashpadSelectionListeners.delete(fn);
  }

  /** 0.74.1: called by StashpadView whenever its cursor/selection
   *  changes. Public so the view layer can fire from any selection-
   *  mutation site (selectCursor, handleRowClick, Escape collapse,
   *  navigate). Listener exceptions are swallowed so one broken
   *  subscriber can't break the rest. */
  notifyStashpadSelectionChanged(): void {
    for (const fn of this.stashpadSelectionListeners) {
      try { fn(); } catch (e) { console.warn("[Stashpad] selection listener failed", e); }
    }
  }

  /** 0.74.6: subscribe to Stashpad content changes (every render that
   *  isn't a deliberate selection change). The detail panel uses this
   *  to refresh its body + children list while staying pinned to the
   *  same note. Returns an unsubscribe handle. */
  onStashpadContentChange(fn: () => void): () => void {
    this.stashpadContentListeners.add(fn);
    return () => this.stashpadContentListeners.delete(fn);
  }

  /** 0.74.6: fired from StashpadView.render() — "something repainted,
   *  but the user didn't necessarily switch notes." */
  notifyStashpadContentChanged(): void {
    for (const fn of this.stashpadContentListeners) {
      try { fn(); } catch (e) { console.warn("[Stashpad] content listener failed", e); }
    }
  }

  /** 0.74.1: snapshot of "which Stashpad note is currently selected"
   *  for the detail panel. Returns null when no Stashpad view is
   *  active or when no row is selected/cursored. */
  getActiveStashpadSelection(): { folder: string; id: StashpadId; file: TFile } | null {
    const leaf = this.lastActiveStashpadLeaf;
    const view = leaf?.view as any;
    if (!view || view.getViewType?.() !== STASHPAD_VIEW_TYPE) return null;
    const folder = (view.noteFolder as string | undefined) ?? "";
    if (!folder) return null;
    // Prefer the cursor row; fall back to the first selected id.
    const children: Array<{ id: StashpadId; file: TFile | null }> = view.currentChildren ?? [];
    let node: { id: StashpadId; file: TFile | null } | undefined;
    if (typeof view.cursorIdx === "number" && view.cursorIdx >= 0) {
      node = children[view.cursorIdx];
    }
    if (!node && view.selection?.size > 0) {
      const firstId = view.firstSelectedId ?? [...view.selection][0];
      node = children.find((n) => n.id === firstId);
    }
    if (!node?.file) return null;
    return { folder, id: node.id, file: node.file };
  }

  /** 0.86.3: pin state lives in the NOTE'S frontmatter (`pinned: true` +
   *  `pinnedAt` epoch-ms order key) so it syncs with the note across devices,
   *  rather than in per-device plugin data. */
  fileForPin(folder: string, id: string): TFile | null {
    const dir = folder.replace(/\/+$/, "");
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== dir) continue;
      if (this.app.metadataCache.getFileCache(f)?.frontmatter?.id === id) return f;
    }
    return null;
  }

  /** Pin a note. Idempotent — writes `pinned: true` + `pinnedAt` to its FM. */
  async pinNote(pin: PinnedNoteRef): Promise<void> {
    const file = this.fileForPin(pin.folder, pin.id);
    if (!file) return;
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned === true) return;
    await this.app.fileManager.processFrontMatter(file, (fm: any) => {
      fm.pinned = true;
      fm.pinnedAt = Date.now();
    });
    this.refreshPanelsView();
  }

  /** Remove a pin (clears the frontmatter keys). Idempotent. */
  async unpinNote(pin: PinnedNoteRef): Promise<void> {
    const file = this.fileForPin(pin.folder, pin.id);
    if (!file) return;
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned !== true) return;
    await this.app.fileManager.processFrontMatter(file, (fm: any) => {
      delete fm.pinned;
      delete fm.pinnedAt;
    });
    this.refreshPanelsView();
  }

  isPinned(pin: PinnedNoteRef): boolean {
    const file = this.fileForPin(pin.folder, pin.id);
    if (!file) return false;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned === true;
  }

  /** All pinned notes across discovered Stashpad folders, ordered by `pinnedAt`
   *  (then path for stability). One metadata-cache scan — backs both the panels
   *  Pinned section and the folder panel. */
  listPinnedNotes(): Array<{ folder: string; id: string; pinnedAt: number; file: TFile }> {
    const folders = new Set(this.discoverStashpadFolders());
    const out: Array<{ folder: string; id: string; pinnedAt: number; file: TFile }> = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folders.has(dir)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      if (!fm || fm.pinned !== true || typeof fm.id !== "string" || !fm.id) continue;
      const at = typeof fm.pinnedAt === "number" ? fm.pinnedAt : 0;
      out.push({ folder: dir, id: fm.id, pinnedAt: at, file: f });
    }
    out.sort((a, b) => a.pinnedAt - b.pinnedAt || a.file.path.localeCompare(b.file.path));
    return out;
  }

  /** 0.86.3: one-time migration — convert the old per-device
   *  `settings.pinnedNotes` list into `pinned`/`pinnedAt` frontmatter so pins
   *  sync. Runs after layout-ready (metadata cache settled); clears the setting
   *  when done so it never re-runs. */
  private async migratePinnedNotesToFrontmatter(): Promise<void> {
    const list = this.settings.pinnedNotes ?? [];
    if (list.length === 0) return;
    let stamp = Date.now() - list.length * 1000; // preserve order via increasing ts
    for (const pin of list) {
      const file = this.fileForPin(pin.folder, pin.id);
      if (!file) { stamp += 1000; continue; }
      try {
        if (this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned !== true) {
          const at = stamp;
          await this.app.fileManager.processFrontMatter(file, (fm: any) => {
            fm.pinned = true;
            fm.pinnedAt = at;
          });
        }
      } catch (e) { console.warn("[Stashpad] pin migration failed for", pin, e); }
      stamp += 1000;
    }
    this.settings.pinnedNotes = [];
    await this.saveSettings();
    this.refreshPanelsView();
  }

  /** Force any open panels view to re-render — used after pin/unpin. */
  private refreshPanelsView(): void {
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_PANELS_VIEW_TYPE);
    for (const leaf of leaves) {
      const v = leaf.view as any;
      if (v && typeof v.render === "function") v.render();
    }
  }

  /** Re-render every open Stashpad list view — used after a setting that changes
   *  how rows render (e.g. hide-locked-titles) so the change shows immediately. */
  refreshAllStashpadViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const v = leaf.view as any;
      if (v && typeof v.render === "function") v.render();
    }
  }

  /** Unified folder picker / switcher / creator — the single entry
   *  point for the ribbon button, the view's switch-folder button, and
   *  the `pickFolder` keybinding / command-palette entry. 0.65.0.
   *
   *  Items (built dynamically based on context + query):
   *  - Reveal an existing Stashpad tab (icon: layout-grid).
   *  - Open a Stashpad folder in a new tab (icon: layout-template).
   *  - When the user is on a Stashpad tab AND types a query matching a
   *    DIFFERENT existing folder: "Switch this tab to <folder>"
   *    (icon: folder-input). When the user is NOT on a Stashpad tab,
   *    this entry is hidden — "open in new tab" carries the load
   *    instead, so we don't accidentally repurpose someone's random
   *    Stashpad tab.
   *  - When the typed value doesn't match any existing folder + isn't
   *    reserved: "Create new Stashpad" (icon: folder-plus). Creates
   *    the folder; if the user's on a Stashpad tab, switches that tab
   *    to the new folder; otherwise opens it in a fresh tab. */
  openFolderPicker(): void {
    type Item =
      | { kind: "reveal"; folder: string; label: string; leaf: WorkspaceLeaf; icon: string }
      | { kind: "open"; folder: string; label: string; icon: string }
      | { kind: "open-anyway"; folder: string; label: string; icon: string }
      | { kind: "switch-current"; folder: string; label: string; icon: string }
      | { kind: "create"; folder: string; label: string; icon: string }
      | { kind: "convert"; folder: string; label: string; icon: string }
      | { kind: "trash"; label: string; icon: string };

    const folderForLeaf = (leaf: WorkspaceLeaf): string => {
      const state = leaf.getViewState();
      const fOverride = (state.state as any)?.folderOverride;
      if (typeof fOverride === "string" && fOverride.trim()) {
        return fOverride.trim().replace(/^\/+|\/+$/g, "");
      }
      return (this.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "");
    };

    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    const stashpadFolders = this.discoverStashpadFolders();
    const activeView = getActiveView();
    const activeFolder = activeView ? ((activeView as any).noteFolder ?? "").trim().replace(/^\/+|\/+$/g, "") : "";

    // Collect every folder path in the vault (for the create guard:
    // don't offer "Create" if the path already exists as a vanilla
    // folder).
    const allVaultFolderPaths = new Set<string>();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if ((f as any).children) {
        const path = (f as any).path as string;
        if (path && path !== "/" && !path.startsWith(".")) {
          allVaultFolderPaths.add(path);
        }
      }
    }
    const isReservedFolder = (p: string): boolean => {
      const last = p.split("/").filter(Boolean).pop() ?? "";
      if (!last) return false;
      const reserved = new Set(
        [this.settings.importDropFolder, this.settings.exportFolder, "_attachments", "_processed", "_authors", "_exports", "_imports", "_archive", ".archive", "_deleted"]
          .map((s) => (s ?? "").trim().replace(/^\/+|\/+$/g, ""))
          .filter(Boolean),
      );
      return reserved.has(last);
    };

    const seenOpen = new Set<string>();
    const baseItems: Item[] = [];
    // 0.65.1: for each open Stashpad folder we ALSO emit an
    // "Open <folder> in new tab anyway" entry — kept separate from
    // baseItems and appended at the very end of the suggestion list so
    // it doesn't compete with the reveal-existing-tab default. Useful
    // when the user actually wants a second tab on the same folder
    // (e.g., for tiny mode + main side by side).
    const openAnywayItems: Item[] = [];
    // 0.71.21: dedupe by folder. When two tabs are open on the same
    // folder the picker used to emit two identical "Reveal X" rows
    // (and two "Open X anyway" rows). Now we emit one row per
    // distinct folder; the leaf picked for reveal is the first tab
    // encountered (workspace order).
    const seenLeafFolders = new Set<string>();
    for (const leaf of leaves) {
      const folder = folderForLeaf(leaf);
      if (seenLeafFolders.has(folder)) continue;
      seenLeafFolders.add(folder);
      seenOpen.add(folder);
      const label = folder.split("/").pop() || folder;
      // 0.98.37: archive folders carry the archive icon so they read at a glance.
      baseItems.push({ kind: "reveal", folder, label: `Reveal "${label}" tab`, leaf, icon: this.isArchiveFolder(folder) ? "archive" : "layout-grid" });
      openAnywayItems.push({ kind: "open-anyway", folder, label: `Open "${label}" in another new tab`, icon: "layout-template" });
    }
    for (const folder of stashpadFolders.filter((f) => !seenOpen.has(f))) {
      const label = folder.split("/").pop() || folder;
      baseItems.push({ kind: "open", folder, label: `Open "${label}" in new tab`, icon: this.isArchiveFolder(folder) ? "archive" : "layout-template" });
    }

    const plugin = this;
    const modal = new (class extends SuggestModal<Item> {
      getSuggestions(query: string): Item[] {
        const q = query.trim().toLowerCase();
        const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
        const matchesAll = (s: string) => {
          if (!tokens.length) return true;
          const h = s.toLowerCase();
          for (const t of tokens) if (!h.includes(t)) return false;
          return true;
        };
        const filtered = !q ? baseItems.slice() : baseItems.filter((it) => {
          const f = "folder" in it ? (it as any).folder : "";
          return matchesAll(it.label) || matchesAll(f);
        });
        // Switch-current items: only when there's an active Stashpad
        // view and the query matches a stashpad folder that isn't its
        // current one. The user said: if not on a Stashpad tab, don't
        // surface this — "open in new tab" is the safe fallback.
        if (q && activeView && activeFolder) {
          for (const folder of stashpadFolders) {
            if (folder.toLowerCase() === activeFolder.toLowerCase()) continue;
            const last = folder.split("/").pop() ?? folder;
            const haystack = `${folder} ${last}`;
            if (!matchesAll(haystack)) continue;
            filtered.push({
              kind: "switch-current",
              folder,
              label: `Switch this tab to "${last}"`,
              icon: "folder-input",
            });
          }
        }
        // Create / convert offer. Query is non-empty AND isn't reserved.
        //  - If the folder doesn't exist anywhere in the vault →
        //    "Create new Stashpad" (creates folder + opens new tab).
        //  - If it exists as a vault folder but isn't a Stashpad folder
        //    yet → "Convert <folder> into a Stashpad" (opens new tab
        //    which bootstraps a Home note inside; non-destructive).
        //  - If it's already a Stashpad folder, neither offer fires —
        //    the existing reveal/open entries handle it.
        const cleaned = query.trim().replace(/^\/+|\/+$/g, "");
        if (cleaned && !isReservedFolder(cleaned)) {
          const existsLower = Array.from(allVaultFolderPaths).find((f) => f.toLowerCase() === cleaned.toLowerCase());
          const isStashpad = stashpadFolders.some((f) => f.toLowerCase() === cleaned.toLowerCase());
          if (existsLower && !isStashpad) {
            filtered.push({
              kind: "convert",
              folder: existsLower,
              label: `Convert “${properCaseFolderPath(existsLower)}” into a Stashpad…`,
              icon: "folder-cog",
            });
          } else if (!existsLower) {
            const cased = properCaseFolderPath(cleaned);
            filtered.push({
              kind: "create",
              folder: cleaned,
              label: `+ Create new Stashpad “${cased}”`,
              icon: "folder-plus",
            });
          }
        }
        // 0.65.1: open-anyway entries pinned to the very bottom — one
        // per currently-open folder, in case the user wants a second
        // tab on the same folder (e.g., main + tiny side by side).
        const openAnywayFiltered = openAnywayItems.filter((it) => matchesAll(it.label) || matchesAll("folder" in it ? it.folder : ""));
        filtered.push(...openAnywayFiltered);
        // 0.98.37: encrypted-trash entry, pinned to the very bottom. Only when
        // encryption is set up; matches on "trash"/"deleted"/"encrypted".
        if (plugin.encryption?.isConfigured?.() && matchesAll("trash deleted encrypted")) {
          filtered.push({ kind: "trash", label: "Open encrypted trash", icon: "trash-2" });
        }
        return filtered;
      }
      renderSuggestion(item: Item, el: HTMLElement): void {
        el.addClass("stashpad-suggest-item");
        el.addClass("stashpad-ribbon-suggest-item");
        if (item.kind === "create") el.addClass("stashpad-suggest-create");
        const iconEl = el.createSpan({ cls: "stashpad-ribbon-suggest-icon" });
        setIcon(iconEl, item.icon);
        const body = el.createDiv({ cls: "stashpad-ribbon-suggest-body" });
        body.createDiv({ cls: "stashpad-suggest-title", text: item.label });
        if ("folder" in item && item.folder && item.label !== item.folder) {
          body.createDiv({ cls: "stashpad-suggest-preview", text: item.folder });
        }
      }
      async onChooseSuggestion(item: Item): Promise<void> {
        if (item.kind === "trash") { plugin.openEncryptedTrash(); return; }
        if (item.kind === "reveal") {
          plugin.app.workspace.revealLeaf(item.leaf);
          return;
        }
        if (item.kind === "open" || item.kind === "open-anyway") {
          await plugin.activateViewForFolder(item.folder);
          return;
        }
        if (item.kind === "switch-current") {
          // Caller already checked activeView exists when emitting.
          const v = activeView as any;
          if (v && typeof v.setFolderOverride === "function") {
            await v.setFolderOverride(item.folder);
            plugin.app.workspace.revealLeaf(v.leaf);
          }
          return;
        }
        if (item.kind === "create") {
          // 0.65.2: ALWAYS open a new tab for fresh Stashpad folders —
          // never replace the active tab. Predictable, doesn't strand
          // whatever the user was looking at.
          try {
            const properCased = properCaseFolderPath(item.folder);
            if (!(await plugin.app.vault.adapter.exists(properCased))) {
              await plugin.app.vault.createFolder(properCased);
            }
            await plugin.activateViewForFolder(properCased);
          } catch (e) {
            new Notice(`Stashpad: couldn't create folder (${(e as Error).message})`);
          }
          return;
        }
        if (item.kind === "convert") {
          // 0.65.2: convert an EXISTING vault folder into a Stashpad.
          // Just opens a new tab on it — bootstrapFolder adds the Home
          // note + _imports / _exports subfolders. Existing files in
          // the folder are NOT touched. Confirmation modal warns the
          // user about the additions.
          const { ConfirmModal } = await import("./modals");
          const folder = item.folder;
          const lines = [
            `“${folder}” already exists as a regular vault folder.`,
            `Converting will add a Home note + _imports / _exports subfolders inside it.`,
            `Existing files are NOT touched.`,
          ];
          new ConfirmModal(
            plugin.app,
            "Convert into a Stashpad?",
            lines.join("\n"),
            "Convert",
            async (ok: boolean) => {
              if (!ok) return;
              try {
                await plugin.activateViewForFolder(folder);
              } catch (e) {
                new Notice(`Stashpad: couldn't convert folder (${(e as Error).message})`);
              }
            },
          ).open();
          return;
        }
      }
    })(this.app);
    modal.setPlaceholder(
      activeView
        ? "Open, switch this tab, or create a Stashpad folder — type to filter…"
        : "Open or create a Stashpad folder — type to filter…"
    );
    modal.open();
  }

  /** Open a popout Obsidian window with a Stashpad view in tiny mode.
   *  Carries over the currently-active view's folder/focus if there is
   *  one — so "Open tiny window" from a folder you're working in keeps
   *  you in that folder. 0.61.1. */
  async openTinyWindow(): Promise<void> {
    const active = getActiveView();
    const folderOverride = (active as any)?.folderOverride ?? null;
    const focusId = (active as any)?.focusId ?? "__root__";
    // 0.61.8: carry over compactMode from the active tab so the tiny
    // window inherits the user's chrome preference. The exit-compact
    // button in the tiny header then has something to toggle.
    const compactMode = !!(active as any)?.compactMode;
    const popLeaf = (this.app.workspace as any).openPopoutLeaf?.();
    if (!popLeaf) {
      new Notice("Stashpad: couldn't open popout window on this build.");
      return;
    }
    await popLeaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        folderOverride,
        focusId,
        tinyMode: true,
        tinyAlwaysOnTop: false,
        compactMode,
      } as any,
    });
    // The view's onOpen path will detect tinyMode and apply the window
    // shrink + always-on-top. Reveal to be safe.
    try { this.app.workspace.revealLeaf(popLeaf); } catch {}
  }

  async activateView(opts: { reveal: boolean } = { reveal: true }): Promise<void> {
    const { workspace } = this.app;
    if (opts.reveal) {
      const existing = workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: STASHPAD_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /** 0.95.3: snap focus to the Stashpad tab you were last working in — the
   *  layout-independent way to get OUT of a side panel and back to your notes.
   *  Prefers the tracked last-active leaf; falls back to any open Stashpad tab,
   *  then to opening/revealing the default Stashpad. */
  async focusLastStashpadTab(): Promise<void> {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(STASHPAD_VIEW_TYPE);
    let leaf = this.lastActiveStashpadLeaf && leaves.includes(this.lastActiveStashpadLeaf)
      ? this.lastActiveStashpadLeaf
      : leaves[0] ?? null;
    if (!leaf) { await this.activateView({ reveal: true }); return; }
    ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
  }

  /** 0.95.3: reveal + focus the folder panel (opening it if needed). The
   *  return-trip companion to focusLastStashpadTab. */
  async focusFolderPanel(): Promise<void> {
    await openFolderPanelView(this.app);
    const leaf = this.app.workspace.getLeavesOfType(STASHPAD_FOLDER_PANEL_VIEW_TYPE)[0];
    if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** 0.98.0 (Phase 2): lock a note subtree into one `.stashenc` bundle. Requires
   *  encryption set up + unlocked (prompts via Notice otherwise). Returns the
   *  lock result, or null if not unlocked / it failed. */
  /** 0.98.7: rebuild the in-memory locked-subtree registry from the `.stashmeta`
   *  sidecars on disk. The registry (settings) is a sync cache for rendering; the
   *  sidecars are the durable source of truth. This recovers placeholder metadata
   *  (parent/title/order) when the settings registry is lost (desync) or when a
   *  blob was synced in from another device with no local registry entry. Adds an
   *  entry for any `.stashenc` missing one; drops entries whose blob is gone. */
  async reconcileLockedRegistry(): Promise<void> {
    const orig = this.settings.lockedSubtrees ?? [];
    // DROP entries via the ADAPTER (disk truth), NOT vault.getFiles() — the vault
    // index lags on startup, and filtering against it once wiped the whole
    // registry when this ran before indexing finished (encrypted notes vanished
    // on restart). adapter.exists reads disk directly, so it's accurate even
    // mid-startup. (Unlock already removes its own entry, so a surviving entry
    // whose blob is genuinely gone is the rare external-deletion case.)
    let reg: typeof orig = [];
    for (const e of orig) {
      const ef = (e.folder ?? "").replace(/\/+$/, "");
      if (ef === "_deleted" || ef.startsWith("_deleted/")) continue; // encrypted-trash blobs aren't locked placeholders
      try { if (await this.app.vault.adapter.exists(e.blob)) reg.push(e); }
      catch { reg.push(e); } // unknown → keep (never wipe on an I/O hiccup)
    }
    let changed = reg.length !== orig.length;
    const have = new Set(reg.map((e) => e.blob));
    // ADD entries for `.stashenc` blobs with no registry entry (synced from
    // another device). Skip the `_deleted/` encrypted-trash store.
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "stashenc" || have.has(f.path)) continue;
      const folder = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (folder === "_deleted" || folder.startsWith("_deleted/")) continue;
      const m = await readLockedMeta(this.app, f.path);
      if (!m) continue; // no sidecar → the scan still shows it at root (never stranded)
      reg.push({ folder, blob: f.path, parentId: m.parentId, title: m.title, count: m.count, created: m.created, rootId: m.rootId, prevSibling: m.prevSibling });
      changed = true;
    }
    if (changed) {
      this.settings.lockedSubtrees = reg;
      await this.saveSettings();
      this.refreshAllStashpadViews?.(); // repaint placeholders that were added/dropped
    }
  }

  /** Locked-subtree placeholders attached under `parentId` in `folder` (for the
   *  list to render 🔒 stubs where the notes were). SCANS the `.stashenc` files
   *  on disk (the source of truth — survives a desynced registry or a blob synced
   *  from another device); the `lockedSubtrees` registry only ENRICHES with the
   *  parent/title/count. A blob with no registry entry shows under the folder root
   *  with its filename as the title, so it's never stranded/unreachable. */
  lockedSubtreesFor(folder: string, parentId: StashpadId): Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null }> {
    const cleaned = folder.replace(/\/+$/, "");
    const out: Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null }> = [];
    const seen = new Set<string>();
    // REGISTRY FIRST — the registry (settings) loads synchronously at startup, so
    // locked placeholders render immediately on app restart, BEFORE the vault
    // finishes indexing the `.stashenc` blobs (vault.getFiles() lags there, which
    // is what made encrypted notes "disappear" on restart until 0.99.14).
    for (const e of this.settings.lockedSubtrees ?? []) {
      if ((e.folder ?? "").replace(/\/+$/, "") !== cleaned) continue;
      if ((e.parentId ?? ROOT_ID) !== parentId) continue;
      out.push({ blob: e.blob, title: e.title ?? "", count: e.count ?? 0, created: e.created ?? "", rootId: e.rootId, parentId: e.parentId ?? ROOT_ID, prevSibling: e.prevSibling ?? null });
      seen.add(e.blob);
    }
    // Then any `.stashenc` blob on disk with NO registry entry (e.g. synced in
    // from another device) — shown at ROOT with the filename as title so it's
    // never stranded. Skips the `_deleted/` encrypted-trash store.
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "stashenc") continue;
      if (seen.has(f.path)) continue;
      const fdir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (fdir !== cleaned || fdir === "_deleted" || fdir.startsWith("_deleted/")) continue;
      if (parentId !== ROOT_ID) continue; // unregistered → attach at root only
      out.push({ blob: f.path, title: f.basename, count: 0, created: "", rootId: undefined, parentId: ROOT_ID, prevSibling: null });
    }
    return out;
  }

  /** Ensure encryption is configured + unlocked, prompting for the password if
   *  locked. Returns true once the session key is available. */
  async ensureEncryptionUnlocked(): Promise<boolean> {
    if (!this.encryption.isConfigured()) { new Notice("Set up encryption first (Settings → Encryption)."); return false; }
    if (this.encryption.isUnlocked()) return true;
    // Try the password remembered in this device's keychain BEFORE prompting —
    // so an idle auto-lock (or any post-load lock) silently re-unlocks instead of
    // asking again. Only prompt if there's no remembered password (or it fails).
    if (await this.encryption.tryAutoUnlock()) return true;
    return new Promise<boolean>((resolve) => {
      new EncryptionPasswordModal(this.app, {
        mode: "unlock", offerKeychain: true,
        onSubmit: async ({ current, remember }) => {
          const ok = await this.encryption.unlock(current!, remember);
          if (!ok) return "Wrong password. Try again.";
          resolve(true);
          return null;
        },
        onCancel: () => resolve(false),
      }).open();
    });
  }

  async lockNoteSubtree(folder: string, rootId: StashpadId, prevSibling: StashpadId | null = null, opts: { silent?: boolean; blobFolder?: string } = {}): Promise<LockResult | null> {
    if (!(await this.ensureEncryptionUnlocked())) return null;
    const dek = this.encryption.getSessionKey();
    if (!dek) return null;
    try {
      const hideTitle = this.settings.hideLockedTitles ?? false;
      const r = await lockSubtree(this.app, folder, rootId, dek, prevSibling, hideTitle, opts.blobFolder);
      // Record a placeholder registry entry so the list shows a 🔒 stub where
      // the note was. The blob may live in a different folder than the note's
      // source (archive) — register it under the blob's actual folder.
      const blobFolder = (opts.blobFolder ?? folder).replace(/\/+$/, "");
      this.settings.lockedSubtrees = [
        ...(this.settings.lockedSubtrees ?? []).filter((e) => e.blob !== r.blobPath),
        { folder: blobFolder, blob: r.blobPath, parentId: r.parentId, title: r.title, count: r.noteCount, created: r.created, rootId: r.rootId, prevSibling },
      ];
      await this.saveSettings();
      if (r.unpurged.length > 0) {
        // The blob is good but readable plaintext is STILL on disk (delete
        // failed, or the file was edited mid-lock). Never report a clean lock.
        new Notice(`⚠️ Locked, but ${r.unpurged.length} file${r.unpurged.length === 1 ? " is" : "s are"} still in plaintext (couldn't be removed or changed during the lock):\n${r.unpurged.join("\n")}`, 0);
      } else if (!opts.silent) {
        this.notifications.show({ message: `Locked ${r.title ? `“${r.title}”` : "a note"} (${r.noteCount} note${r.noteCount === 1 ? "" : "s"}).`, kind: "success", category: "system", folder });
      }
      return r;
    } catch (e) {
      console.warn("[Stashpad] lock failed", e);
      new Notice(`Couldn't lock: ${(e as Error).message}`);
      return null;
    }
  }

  /** 0.98.0 (Phase 2): unlock a `.stashenc` bundle back into its folder. */
  /** Decrypt ONE bundle into its folder and return the unlock result. Does NOT
   *  touch `lockedSubtrees` / settings — the caller updates them — so bulk callers
   *  can batch a single save instead of one `data.json` write per bundle. Throws
   *  on failure (caller decides how loud). */
  private async unlockBundleCore(blobPath: string, dek: Uint8Array, destFolder?: string): Promise<{ notesWritten: number; restoredTo: string }> {
    const folder = (destFolder ?? blobPath.replace(/\/[^/]*$/, "")).replace(/\/+$/, "");
    // Disk frontmatter, not metadataCache (lags after lock churn) — a stale
    // miss here re-pins an unlocked nested note to ROOT in importStashZip.
    const existing = new Set<StashpadId>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== folder) continue;
      try {
        const id = splitFrontmatter(await this.app.vault.read(f)).fm.id;
        if (typeof id === "string") existing.add(id);
      } catch { /* unreadable — skip */ }
    }
    return unlockBundle(this.app, blobPath, dek, existing, destFolder);
  }

  async unlockBundleAt(blobPath: string, opts: { silent?: boolean; destFolder?: string } = {}): Promise<boolean> {
    if (!(await this.ensureEncryptionUnlocked())) return false;
    const dek = this.encryption.getSessionKey();
    if (!dek) return false;
    const folder = (opts.destFolder ?? blobPath.replace(/\/[^/]*$/, "")).replace(/\/+$/, "");
    try {
      const r = await this.unlockBundleCore(blobPath, dek, opts.destFolder);
      this.settings.lockedSubtrees = (this.settings.lockedSubtrees ?? []).filter((e) => e.blob !== blobPath);
      await this.saveSettings();
      if (!opts.silent) this.notifications.show({ message: `Unlocked ${r.notesWritten} note${r.notesWritten === 1 ? "" : "s"}.`, kind: "success", category: "system", folder });
      return true;
    } catch (e) {
      console.warn("[Stashpad] unlock failed", e);
      new Notice(`Couldn't unlock: ${(e as Error).message}`);
      return false;
    }
  }

  /** 0.98.13 (Phase 3): lock every top-level note in a folder — each root note's
   *  subtree becomes its OWN `.stashenc` bundle (children ride along inside their
   *  root's bundle, so we only iterate root-level notes). Already-locked roots and
   *  the `__root__` Home note are skipped. Best-effort position preservation via the
   *  OrderStore. Returns how many bundles were created. */
  async lockFolder(folder: string): Promise<number> {
    if (!(await this.ensureEncryptionUnlocked())) return 0;
    const cleaned = folder.replace(/\/+$/, "");
    // Enumerate root-level notes from disk (frontmatter), excluding the Home note.
    const roots: StashpadId[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      // Disk frontmatter, not metadataCache — a stale `parent` here reads a
      // child as a root, giving it its own bundle orphaned from its parent's.
      let fm: Record<string, unknown>;
      try { fm = splitFrontmatter(await this.app.vault.read(f)).fm; } catch { continue; }
      const id = fm.id;
      if (typeof id !== "string" || id === ROOT_ID) continue;
      const parent = typeof fm.parent === "string" ? fm.parent : ROOT_ID;
      if (parent !== ROOT_ID) continue; // children ride along inside their root's bundle
      roots.push(id);
    }
    const alreadyLocked = new Set((this.settings.lockedSubtrees ?? []).map((e) => e.rootId).filter((x): x is StashpadId => !!x));
    const todo = roots.filter((id) => !alreadyLocked.has(id));
    if (todo.length === 0) { new Notice("Nothing to lock in this folder."); return 0; }
    // Best-effort: read the explicit manual order so each stub keeps its slot.
    const order = new OrderStore(this.app);
    const rootOrder = (await order.load(cleaned))[ROOT_ID] ?? [];
    // Progress for big folders: a persistent Notice we update each step (a long
    // lock shouldn't look hung). Only for >3 items so small ops stay quiet.
    const prog = todo.length > 3 ? new Notice("", 0) : null;
    let count = 0;
    for (let i = 0; i < todo.length; i++) {
      const id = todo[i];
      prog?.setMessage(`🔒 Encrypting ${i + 1}/${todo.length}…`);
      const idx = rootOrder.indexOf(id);
      const prevSibling = idx > 0 ? rootOrder[idx - 1] : null;
      if (await this.lockNoteSubtree(cleaned, id, prevSibling, { silent: true })) count++;
    }
    prog?.hide();
    if (count > 0) this.notifications.show({ message: `Locked ${count} note${count === 1 ? "" : "s"} in “${cleaned.split("/").pop()}”.`, kind: "success", category: "system", folder: cleaned });
    return count;
  }

  /** 0.98.13 (Phase 3): unlock every locked stash in a folder, back into place.
   *  Each blob is independent — skip any that fail the encrypted-envelope check or
   *  were already removed, so a bad one never aborts the batch. Returns the count. */
  async unlockFolder(folder: string): Promise<number> {
    if (!(await this.ensureEncryptionUnlocked())) return 0;
    const cleaned = folder.replace(/\/+$/, "");
    const blobs = this.app.vault.getFiles()
      .filter((f) => f.extension === "stashenc" && (f.parent?.path?.replace(/\/+$/, "") ?? "") === cleaned)
      .map((f) => f.path);
    if (blobs.length === 0) { new Notice("No locked notes in this folder."); return 0; }
    const prog = blobs.length > 3 ? new Notice("", 0) : null;
    let count = 0;
    for (let i = 0; i < blobs.length; i++) {
      prog?.setMessage(`🔓 Decrypting ${i + 1}/${blobs.length}…`);
      try { if (await this.unlockBundleAt(blobs[i], { silent: true })) count++; }
      catch (e) { console.warn("[Stashpad] folder unlock skipped", blobs[i], e); }
    }
    prog?.hide();
    if (count > 0) this.notifications.show({ message: `Unlocked ${count} note${count === 1 ? "" : "s"} in “${cleaned.split("/").pop()}”.`, kind: "success", category: "system", folder: cleaned });
    return count;
  }

  /** 0.98.21 (Phase 3): decrypt EVERY locked stash across the whole vault, back
   *  into place. Non-destructive (unlock only reverses a lock) — a "decrypt
   *  everything" safety valve. Each blob is independent + skip-on-error. */
  async unlockAllInVault(): Promise<number> {
    if (!(await this.ensureEncryptionUnlocked())) return 0;
    // Exclude the `_deleted/` trash store — those are DELETED notes, not locked
    // ones; "unlocking" them would wrongly restore them into _deleted/. Use the
    // trash-restore flow for those.
    const blobs = this.app.vault.getFiles()
      .filter((f) => f.extension === "stashenc" && (f.parent?.path?.replace(/\/+$/, "") ?? "") !== "_deleted")
      .map((f) => f.path);
    if (blobs.length === 0) { new Notice("No locked notes anywhere in the vault."); return 0; }
    const dek = this.encryption.getSessionKey();
    if (!dek) return 0;
    const prog = blobs.length > 3 ? new Notice("", 0) : null;
    // Decrypt each bundle, collecting the ones that succeeded; update
    // `lockedSubtrees` + write data.json ONCE at the end instead of per bundle
    // (this used to call unlockBundleAt → saveSettings for every bundle, an
    // O(n) pile of redundant data.json writes on top of the per-bundle import).
    let notes = 0;
    const unlockedBlobs: string[] = [];
    for (let i = 0; i < blobs.length; i++) {
      prog?.setMessage(`🔓 Decrypting ${i + 1}/${blobs.length}…`);
      try { const r = await this.unlockBundleCore(blobs[i], dek); notes += r.notesWritten; unlockedBlobs.push(blobs[i]); }
      catch (e) { console.warn("[Stashpad] vault unlock skipped", blobs[i], e); }
    }
    if (unlockedBlobs.length > 0) {
      const done = new Set(unlockedBlobs);
      this.settings.lockedSubtrees = (this.settings.lockedSubtrees ?? []).filter((e) => !done.has(e.blob));
      await this.saveSettings();
    }
    prog?.hide();
    const folder = blobs[0].replace(/\/[^/]*$/, "");
    if (notes > 0) this.notifications.show({ message: `Unlocked ${notes} note${notes === 1 ? "" : "s"} across the vault.`, kind: "success", category: "system", folder });
    return notes;
  }

  // --- 0.98.29 (Phase 5): encrypted trash (`_deleted/`) ---

  /** Encrypt-delete a subtree into `_deleted/` (recoverable, encrypted) and
   *  permanently remove the plaintext. Returns the blob path, or null on failure. */
  async encryptDeleteSubtree(folder: string, rootId: StashpadId): Promise<string | null> {
    if (!(await this.ensureEncryptionUnlocked())) return null;
    const dek = this.encryption.getSessionKey();
    if (!dek) return null;
    try {
      // Plugin runtime (not a workflow script) — Date is available.
      const deletedAt = new Date().toISOString();
      // "Encrypt trash filenames" hides the trash blob's name/origin even when
      // the general hide-locked-titles setting is off.
      const hideTitle = (this.settings.hideLockedTitles ?? false) || (this.settings.encryptTrashFilenames ?? false);
      const r = await deleteEncryptSubtree(this.app, folder, rootId, dek, deletedAt, hideTitle);
      if (r.unpurged.length > 0) {
        new Notice(`⚠️ Sent to encrypted trash, but ${r.unpurged.length} file${r.unpurged.length === 1 ? " is" : "s are"} still in plaintext (couldn't be removed or changed during the delete):\n${r.unpurged.join("\n")}`, 0);
      }
      return r.blobPath;
    } catch (e) {
      console.warn("[Stashpad] encrypt-delete failed", e);
      new Notice(`Couldn't encrypt-delete: ${(e as Error).message}`, 0);
      return null;
    }
  }

  /** Restore an encrypted-deleted blob back into its original folder. */
  async restoreDeletedAt(blobPath: string, opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!(await this.ensureEncryptionUnlocked())) return false;
    const dek = this.encryption.getSessionKey();
    if (!dek) return false;
    const meta = await readDeletedMeta(this.app, blobPath);
    // Backfill blobs are raw `.trash/` zips, not Stashpad bundles — different
    // restore path (plain unzip back into `.trash/`).
    if (meta?.kind === "rawtrash") {
      try {
        const r = await restoreRawTrash(this.app, blobPath, dek);
        if (!opts.silent) this.notifications.show({ message: `Restored ${r.filesWritten} file${r.filesWritten === 1 ? "" : "s"} to Obsidian's trash (${OBSIDIAN_TRASH_DIR}/).`, kind: "success", category: "system", folder: "" });
        return true;
      } catch (e) {
        console.warn("[Stashpad] trash-backfill restore failed", e);
        new Notice(`Couldn't restore: ${(e as Error).message}`, 0);
        return false;
      }
    }
    try {
      // Sanitized; decrypts the origin for hidden-title deletes; throws (blob
      // kept) when a trash blob's origin is unknowable instead of dumping
      // plaintext into `_deleted/`.
      const dest = await deletedRestoreDest(this.app, blobPath, meta, dek);
      // Existing ids from DISK frontmatter, not metadataCache — the cache lags
      // after lock/restore churn, and a stale miss makes importStashZip re-pin
      // a restored child to ROOT.
      const existing = new Set<StashpadId>();
      for (const f of this.app.vault.getMarkdownFiles()) {
        if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== dest.replace(/\/+$/, "")) continue;
        try {
          const id = splitFrontmatter(await this.app.vault.read(f)).fm.id;
          if (typeof id === "string") existing.add(id);
        } catch { /* unreadable — skip */ }
      }
      const r = await restoreDeleted(this.app, blobPath, dek, existing);
      if (!opts.silent) this.notifications.show({ message: `Restored ${r.notesWritten} note${r.notesWritten === 1 ? "" : "s"} to “${r.restoredTo.split("/").pop()}”.`, kind: "success", category: "system", folder: r.restoredTo });
      return true;
    } catch (e) {
      console.warn("[Stashpad] restore-from-trash failed", e);
      new Notice(`Couldn't restore: ${(e as Error).message}`, 0);
      return false;
    }
  }

  /** List the encrypted-trash contents (blob path + sidecar metadata). */
  async listDeletedTrash(): Promise<Array<{ blob: string; meta: DeletedMeta | null }>> {
    const blobs = await listDeletedBlobs(this.app);
    const out: Array<{ blob: string; meta: DeletedMeta | null }> = [];
    for (const b of blobs) out.push({ blob: b, meta: await readDeletedMeta(this.app, b) });
    return out;
  }

  /** v2: restore EVERY encrypted-trash note back to its origin folder.
   *  (The old `scopeFolder` filter was dropped: no caller passed it, and it
   *  matched plaintext `originalFolder` — silently skipping hidden-title items
   *  whose origin lives only in `originalFolderEnc`.) */
  async restoreAllTrash(): Promise<number> {
    if (!(await this.ensureEncryptionUnlocked())) return 0;
    const items = await this.listDeletedTrash();
    if (items.length === 0) { new Notice("Nothing to restore."); return 0; }
    const prog = items.length > 3 ? new Notice("", 0) : null;
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      prog?.setMessage(`🔓 Restoring ${i + 1}/${items.length}…`);
      try { if (await this.restoreDeletedAt(items[i].blob, { silent: true })) count++; }
      catch (e) { console.warn("[Stashpad] restore-all skipped", items[i].blob, e); }
    }
    prog?.hide();
    if (count > 0) this.notifications.show({ message: `Restored ${count} note${count === 1 ? "" : "s"} from encrypted trash.`, kind: "success", category: "system", folder: "" });
    return count;
  }

  /** v2 backfill: sweep Obsidian's plaintext `.trash/` into one encrypted blob
   *  in `_deleted/` (restorable from the trash tab like everything else). */
  async encryptExistingTrash(): Promise<boolean> {
    if (!(await this.ensureEncryptionUnlocked())) return false;
    const dek = this.encryption.getSessionKey();
    if (!dek) return false;
    try {
      const hideTitle = (this.settings.hideLockedTitles ?? false) || (this.settings.encryptTrashFilenames ?? false);
      const r = await backfillTrashEncrypt(this.app, dek, new Date().toISOString(), hideTitle);
      if (!r) { new Notice(`Obsidian's vault trash (${OBSIDIAN_TRASH_DIR}/) is empty — nothing to encrypt. (Files in the system/OS trash can't be reached.)`, 8000); return false; }
      if (r.unpurged.length > 0) {
        new Notice(`⚠️ Encrypted the trash, but ${r.unpurged.length} file${r.unpurged.length === 1 ? " is" : "s are"} still in plaintext (couldn't be removed):\n${r.unpurged.join("\n")}`, 0);
      } else {
        this.notifications.show({ message: `Encrypted ${r.fileCount} trash file${r.fileCount === 1 ? "" : "s"} into the encrypted trash. Restore from the trash tab puts them back in ${OBSIDIAN_TRASH_DIR}/.`, kind: "success", category: "system", folder: "" });
      }
      return true;
    } catch (e) {
      console.warn("[Stashpad] trash backfill failed", e);
      new Notice(`Couldn't encrypt the existing trash: ${(e as Error).message}`, 0);
      return false;
    }
  }

  /** Open the recoverable encrypted-trash TAB. (The `_` arg keeps the old
   *  per-folder call sites working; the tab groups by origin folder anyway.) */
  openEncryptedTrash(_scopeFolder?: string): void {
    if (!this.encryption.isConfigured()) { new Notice("Set up encryption first (Settings → Encryption)."); return; }
    void openTrashView(this);
  }

  /** Open a picker over the encrypted trash; restore the chosen note in place. */
  async openRestoreTrashPicker(): Promise<void> {
    if (!this.encryption.isConfigured()) { new Notice("Set up encryption first (Settings → Encryption)."); return; }
    const items = await this.listDeletedTrash();
    if (items.length === 0) { new Notice("Encrypted trash is empty."); return; }
    const entries = items.map(({ blob, meta }) => ({
      blob,
      label: meta?.title || blob.split("/").pop()?.replace(/\.stashenc$/, "") || "Locked note",
      folder: meta?.originalFolder || "(unknown)",
    }));
    new DeletedTrashSuggestModal(this.app, entries, (blob) => { void this.restoreDeletedAt(blob); }).open();
  }

  // --- 0.98.25 (Phase 4): archive folders — auto-encrypt notes moved in ---

  isArchiveFolder(folder: string): boolean {
    const cleaned = folder.replace(/\/+$/, "");
    return (this.settings.archiveFolders ?? []).includes(cleaned);
  }

  /** Ensure the OKF template note exists and remember its path (called when OKF
   *  is enabled). */
  async ensureOkfTemplate(): Promise<string> {
    const path = await ensureOkfTemplate(this.app, this.settings.okfTemplatePath || undefined);
    if (this.settings.okfTemplatePath !== path) { this.settings.okfTemplatePath = path; await this.saveSettings(); }
    return path;
  }

  /** The OKF template path, defaulting to the standard name when the setting is
   *  empty (e.g. OKF was enabled in an older build before create-on-enable). */
  okfTemplatePathOrDefault(): string {
    return this.settings.okfTemplatePath || OKF_DEFAULT_TEMPLATE_PATH;
  }

  /** Folders the OKF process should ACTUALLY touch: only when OKF is on, only
   *  folders assigned the OKF template, and NEVER archive folders (their whole
   *  point is private-at-rest — OKF would make them browsable/exportable). This
   *  is the single guard every OKF run goes through, so OKF-off / no-folders /
   *  excluded-folders can never accidentally trigger the process. */
  okfActiveFolders(): string[] {
    if (!this.settings.okfEnabled) return [];
    return okfFolders(this.settings.noteTemplates, this.okfTemplatePathOrDefault())
      .filter((f) => !this.isArchiveFolder(f));
  }

  /** Per-folder debounce timers for OKF auto-rebuild. */
  private okfRebuildTimers = new Map<string, number>();

  /** A vault file changed (create/delete/rename) — if it's a real note in an
   *  active OKF folder, schedule a debounced rebuild of that folder. Ignores
   *  index.md (our own generated artifact, to avoid a write→event→rebuild loop)
   *  and reserved subfolders. */
  private onOkfFileEvent(path: string): void {
    if (!this.settings.okfEnabled) return;
    if (!path.toLowerCase().endsWith(".md")) return;
    const slash = path.lastIndexOf("/");
    const folder = (slash >= 0 ? path.slice(0, slash) : "").replace(/\/+$/, "");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    if (name === "index.md") return;
    if (/(^|\/)(_imports|_exports|_attachments|_deleted|\.stashpad)(\/|$)/.test(path)) return;
    if (!this.okfActiveFolders().includes(folder)) return;
    this.scheduleOkfRebuild(folder);
  }

  /** Debounced per-folder OKF rebuild (coalesces bursts like imports/resets). */
  private scheduleOkfRebuild(folder: string): void {
    const prev = this.okfRebuildTimers.get(folder);
    if (prev != null) window.clearTimeout(prev);
    this.okfRebuildTimers.set(folder, window.setTimeout(() => {
      this.okfRebuildTimers.delete(folder);
      if (!this.okfActiveFolders().includes(folder)) return; // re-check at fire time
      void rebuildOkfForFolder(this.app, folder).catch((e) => console.warn("[Stashpad] OKF auto-rebuild failed", folder, e));
    }, 2500));
  }

  /** Rebuild OKF frontmatter (relative-markdown links + defaults) + index.md for
   *  every active OKF folder. No-op when OKF is off / no folders use the template. */
  async rebuildAllOkf(): Promise<{ folders: number; checked: number; written: number }> {
    const folders = this.okfActiveFolders();
    let checked = 0, written = 0;
    for (const f of folders) { const r = await rebuildOkfForFolder(this.app, f); checked += r.checked; written += r.written; }
    return { folders: folders.length, checked, written };
  }

  /** Export the subtree(s) rooted at `rootIds` in `folder` as OKF bundle(s) and/or
   *  a Stashpad .stash, written into the folder's export subfolder. Returns the
   *  paths written. zip/tar.gz are OKF bundles (spec keys mapped, scoped index.md);
   *  .stash is the native round-trip format. Reachable for tests + the command. */
  async exportOkf(folder: string, rootIds: StashpadId[], baseName: string, formats: { zip?: boolean; targz?: boolean; stash?: boolean }): Promise<string[]> {
    const cleaned = folder.replace(/\/+$/, "");
    const rootNotes: { id: StashpadId; file: TFile }[] = [];
    const allDescendants: { id: StashpadId; file: TFile }[] = [];
    const files: TFile[] = [];
    const scopeIds = new Set<string>();
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, cleaned, rid);
      if (!sub) continue;
      rootNotes.push({ id: sub.rootNote.id, file: sub.rootNote.file });
      files.push(sub.rootNote.file); scopeIds.add(sub.rootNote.id);
      for (const d of sub.descendants) { allDescendants.push({ id: d.id, file: d.file }); files.push(d.file); scopeIds.add(d.id); }
    }
    if (!files.length) return [];
    const safe = (baseName || "okf-export").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "okf-export";
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const exportSub = (this.settings.exportFolder || "_exports").trim().replace(/^\/+|\/+$/g, "");
    const exportFolder = `${cleaned}/${exportSub}`;
    for (const seg of [cleaned, exportFolder]) { try { if (!(await this.app.vault.adapter.exists(seg))) await this.app.vault.adapter.mkdir(seg); } catch { /* */ } }
    const written: string[] = [];
    const write = async (name: string, data: Uint8Array) => {
      const path = `${exportFolder}/${name}`;
      await this.app.vault.createBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      written.push(path);
    };
    if (formats.zip || formats.targz) {
      const bundle = await buildOkfBundleFiles(this.app, files, cleaned, scopeIds);
      if (formats.zip) await write(`${safe}-${stamp}.okf.zip`, await zipBundle(bundle));
      if (formats.targz) await write(`${safe}-${stamp}.okf.tar.gz`, await tarGzBundle(bundle));
    }
    if (formats.stash) {
      const buf = await buildStashZip(this.app, { rootNotes, allDescendants, sourceFolder: cleaned });
      await write(`${safe}-${stamp}.${STASH_EXT}`, buf);
    }
    return written;
  }

  /** Ids of the markdown notes living directly in `folder` (read from DISK — the
   *  metadata cache can lag and an under-read here would miss a real id collision
   *  on import). */
  async idsInFolder(folder: string): Promise<Set<StashpadId>> {
    const cleaned = folder.replace(/\/+$/, "");
    const out = new Set<StashpadId>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      try { const id = splitFrontmatter(await this.app.vault.read(f)).fm.id; if (typeof id === "string") out.add(id); } catch { /* skip unreadable */ }
    }
    return out;
  }

  /** Cross-folder note paste engine (cut = move, copy = clone). Routes the source
   *  subtree(s) through the `.stash` bundle path so ATTACHMENTS travel into the
   *  destination's `_attachments` folder, then (for a cut) trashes the source
   *  notes and their EXCLUSIVE attachments. Refuses an archive / auto-encrypting
   *  destination — a missing on-device key could strand the move — so that path
   *  is left to the explicit "Move to archive" command (which checks the key
   *  first). Returns the destination root ids, total note count, and reversible
   *  `undo` / `redo` closures (file-level — the caller adds tree rebuild + render).
   *  Undo is snapshot-backed: we capture the created destination files and (for a
   *  cut) the source files BEFORE trashing them, so undo fully restores either
   *  direction. Null on refusal / no-op. */
  async crossFolderPaste(
    srcFolder: string, rootIds: StashpadId[], destFolder: string,
    destParent: StashpadId, mode: "cut" | "copy",
  ): Promise<{ rootIds: StashpadId[]; noteCount: number; undo: () => Promise<void>; redo: () => Promise<void> } | null> {
    const cleanDest = destFolder.replace(/\/+$/, "");
    if (this.isArchiveFolder(cleanDest)) {
      new Notice(`"${cleanDest.split("/").pop()}" auto-encrypts notes moved in, so cross-folder paste is disabled there. Use the "Move to archive" command — it checks the encryption key first.`);
      return null;
    }
    // Gather source subtree(s) from DISK (authoritative; the source folder's view
    // may be closed, so we can't rely on an in-memory tree).
    const rootNotes: { id: StashpadId; file: TFile }[] = [];
    const allDescendants: { id: StashpadId; file: TFile }[] = [];
    const srcRootOldIds: StashpadId[] = [];
    const srcNoteFiles: TFile[] = [];
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, srcFolder, rid);
      if (!sub) continue;
      srcRootOldIds.push(sub.rootNote.id);
      rootNotes.push({ id: sub.rootNote.id, file: sub.rootNote.file });
      srcNoteFiles.push(sub.rootNote.file);
      for (const d of sub.descendants) { allDescendants.push({ id: d.id, file: d.file }); srcNoteFiles.push(d.file); }
    }
    if (!rootNotes.length) return null;
    const noteCount = rootNotes.length + allDescendants.length;

    // For a CUT, snapshot the source (notes + EXCLUSIVE attachments) BEFORE we
    // touch anything, so undo can recreate it byte-for-byte.
    let srcExclusiveAtts: TFile[] = [];
    let srcSnapshot: FileSnapshot[] = [];
    if (mode === "cut") {
      srcExclusiveAtts = await this.exclusiveAttachmentsOf(srcNoteFiles);
      srcSnapshot = await this.snapshotPaths([...srcNoteFiles.map((f) => f.path), ...srcExclusiveAtts.map((f) => f.path)]);
    }

    // Bundle the subtree (collects referenced attachments) → import into dest
    // (writes attachments into dest/_attachments). Copy → fresh ids; cut → keep
    // ids so the moved notes retain their identity. Roots reparent to the paste
    // target. dedupeExisting:false on purpose — the vault-wide reuse would route
    // the pasted note's attachment link back to the SOURCE folder's copy (and for
    // a cut, that copy then gets trashed → a dangling link). We want the
    // attachment physically in THIS folder's _attachments so the subtree is
    // self-contained. (An identical file already in dest's _attachments is still
    // reused — only the cross-folder reuse is dropped.)
    const zip = await buildStashZip(this.app, { rootNotes, allDescendants, sourceFolder: srcFolder });
    const destExistingIds = await this.idsInFolder(cleanDest);
    const beforePaths = new Set(this.filesUnder(cleanDest));
    const summary = await importStashZip(this.app, zip, cleanDest, destExistingIds, {
      dedupeExisting: false,
      forceNewIds: mode === "copy",
      reparentRootsTo: destParent,
    });
    const createdPaths = this.filesUnder(cleanDest).filter((p) => !beforePaths.has(p));
    const destSnapshot = await this.snapshotPaths(createdPaths);
    const newRootIds = srcRootOldIds.map((old) => summary.idRemap[old]).filter((x): x is StashpadId => !!x);

    // CUT: the notes + attachments now live in dest, so trash the source subtree.
    if (mode === "cut") {
      for (const f of srcNoteFiles) { try { await this.app.fileManager.trashFile(f); } catch (e) { console.warn("[Stashpad] cross-folder move: couldn't trash source note", f.path, e); } }
      for (const f of srcExclusiveAtts) { try { await this.app.fileManager.trashFile(f); } catch (e) { console.warn("[Stashpad] cross-folder move: couldn't trash source attachment", f.path, e); } }
    }

    const removeCreated = async () => {
      for (const p of [...createdPaths].reverse()) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) { try { await this.app.fileManager.trashFile(f as TFile); } catch { /* already gone */ } }
      }
    };
    const undo = mode === "cut"
      ? async () => { await removeCreated(); await this.restoreSnapshot(srcSnapshot); }
      : async () => { await removeCreated(); };
    const redo = mode === "cut"
      ? async () => { await this.restoreSnapshot(destSnapshot); for (const s of srcSnapshot) { const f = this.app.vault.getAbstractFileByPath(s.path); if (f) { try { await this.app.fileManager.trashFile(f as TFile); } catch { /* gone */ } } } }
      : async () => { await this.restoreSnapshot(destSnapshot); };

    return { rootIds: newRootIds, noteCount, undo, redo };
  }

  /** Trash (recoverable) the given subtrees in `folder`: every note file plus the
   *  attachments referenced ONLY by those subtrees — shared attachments stay put.
   *  Returns the files it trashed (for the caller's undo snapshot). */
  async trashSubtrees(folder: string, rootIds: StashpadId[]): Promise<TFile[]> {
    const files: TFile[] = [];
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, folder, rid);
      if (!sub) continue;
      files.push(sub.rootNote.file, ...sub.descendants.map((d) => d.file));
    }
    if (!files.length) return [];
    const exclusiveAtts = await this.exclusiveAttachmentsOf(files);
    const trashed: TFile[] = [];
    for (const f of [...files, ...exclusiveAtts]) {
      try { await this.app.fileManager.trashFile(f); trashed.push(f); }
      catch (e) { console.warn("[Stashpad] trashSubtrees: couldn't trash", f.path, e); }
    }
    return trashed;
  }

  /** Attachments referenced ONLY by `noteFiles` (not by any note outside the set).
   *  Exclusivity is read from the live resolvedLinks graph — call while the notes
   *  are still present. */
  async exclusiveAttachmentsOf(noteFiles: TFile[]): Promise<TFile[]> {
    const subtreePaths = new Set(noteFiles.map((f) => f.path));
    const subtreeAtts = new Map<string, TFile>();
    for (const f of noteFiles) for (const af of await resolveNoteAttachmentFiles(this.app, f)) subtreeAtts.set(af.path, af);
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const notePath of Object.keys(resolved)) {
      if (subtreePaths.has(notePath)) continue;
      for (const target of Object.keys(resolved[notePath] ?? {})) subtreeAtts.delete(target); // referenced elsewhere → not exclusive
    }
    return [...subtreeAtts.values()];
  }

  /** Paths of every file (notes + their exclusive attachments) in the given
   *  subtrees — for an undo snapshot taken before trashing. */
  async subtreeFilePaths(folder: string, rootIds: StashpadId[]): Promise<string[]> {
    const files: TFile[] = [];
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, folder, rid);
      if (!sub) continue;
      files.push(sub.rootNote.file, ...sub.descendants.map((d) => d.file));
    }
    if (!files.length) return [];
    const atts = await this.exclusiveAttachmentsOf(files);
    return [...files.map((f) => f.path), ...atts.map((f) => f.path)];
  }

  /** Pre-ordered (parent → children, depth-tagged) nodes of the given subtrees,
   *  read from disk — for building the indented outline of a CROSS-folder cut
   *  pasted into a composer (the source folder's tree isn't loaded in the
   *  destination view). Siblings are ordered by `position` frontmatter (then
   *  `created`) to match the list's visual order. */
  async orderedSubtreeNodes(folder: string, rootIds: StashpadId[]): Promise<Array<{ file: TFile; created: string; depth: number }>> {
    const out: Array<{ file: TFile; created: string; depth: number }> = [];
    const seen = new Set<StashpadId>();
    const posOf = (f: TFile): number => { const v = (this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined)?.position; return typeof v === "number" ? v : Number.MAX_SAFE_INTEGER; };
    type N = { id: StashpadId; file: TFile; created: string };
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, folder, rid);
      if (!sub) continue;
      const childrenOf = new Map<StashpadId, N[]>();
      for (const d of sub.descendants) {
        if (!d.parent) continue;
        const arr = childrenOf.get(d.parent as StashpadId) ?? [];
        arr.push({ id: d.id, file: d.file, created: d.created });
        childrenOf.set(d.parent as StashpadId, arr);
      }
      for (const arr of childrenOf.values()) arr.sort((a, b) => (posOf(a.file) - posOf(b.file)) || a.created.localeCompare(b.created));
      const walk = (node: N, depth: number): void => {
        if (seen.has(node.id)) return; // cycle / overlap guard
        seen.add(node.id);
        out.push({ file: node.file, created: node.created, depth });
        for (const c of childrenOf.get(node.id) ?? []) walk(c, depth + 1);
      };
      walk({ id: sub.rootNote.id, file: sub.rootNote.file, created: sub.rootNote.created }, 0);
    }
    return out;
  }

  /** All file paths under `folder` (notes directly in it + its `_attachments`). */
  filesUnder(folder: string): string[] {
    const prefix = folder.replace(/\/+$/, "") + "/";
    return this.app.vault.getFiles().filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
  }

  /** Capture content for a set of paths (text for `.md`, binary otherwise) so an
   *  undo/redo can recreate them exactly. Missing paths are skipped. */
  async snapshotPaths(paths: string[]): Promise<FileSnapshot[]> {
    const out: FileSnapshot[] = [];
    for (const path of paths) {
      const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
      if (!f) continue;
      const binary = !path.toLowerCase().endsWith(".md");
      try {
        if (binary) out.push({ path, binary, data: await this.app.vault.readBinary(f) });
        else out.push({ path, binary, text: await this.app.vault.read(f) });
      } catch (e) { console.warn("[Stashpad] snapshotPaths: couldn't read", path, e); }
    }
    return out;
  }

  /** Recreate files from a snapshot (parents are created as needed). Overwrites an
   *  existing file at the same path. */
  async restoreSnapshot(snaps: FileSnapshot[]): Promise<void> {
    for (const s of snaps) {
      const dir = s.path.split("/").slice(0, -1).join("/");
      await this.ensureVaultFolder(dir);
      const existing = this.app.vault.getAbstractFileByPath(s.path) as TFile | null;
      try {
        if (s.binary) {
          if (existing) await this.app.vault.adapter.writeBinary(s.path, s.data as ArrayBuffer);
          else await this.app.vault.createBinary(s.path, s.data as ArrayBuffer);
        } else {
          if (existing) await this.app.vault.modify(existing, s.text ?? "");
          else await this.app.vault.create(s.path, s.text ?? "");
        }
      } catch (e) { console.warn("[Stashpad] restoreSnapshot: couldn't write", s.path, e); }
    }
  }

  /** Ensure a (possibly nested) vault folder exists. */
  async ensureVaultFolder(dir: string): Promise<void> {
    if (!dir) return;
    let acc = "";
    for (const seg of dir.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!(await this.app.vault.adapter.exists(acc))) { try { await this.app.vault.createFolder(acc); } catch { /* race / exists */ } }
    }
  }

  /** Rebuild + re-render every open Stashpad view showing `folder` — after an
   *  out-of-band change to its files (e.g. a cross-folder move that removed notes
   *  from the source folder, whose view isn't the one that ran the command). */
  refreshOpenViewsForFolder(folder: string): void {
    const cleaned = folder.replace(/\/+$/, "");
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const v = leaf.view as any;
      if ((v?.noteFolder?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      try { v.tree?.rebuild?.(folder); v.render?.(); } catch (e) { console.warn("[Stashpad] refresh view failed", e); }
    }
  }

  /** Batches arrivals per archive folder: each move-in (re)arms a settle timer so
   *  a multi-file move (a whole subtree dragged in) is swept ONCE, after the
   *  re-home debounce (900ms) and metadata indexing have settled. */
  private archivePending = new Map<string, { paths: Set<string>; timer: number }>();

  private maybeArchiveOnMoveIn(file: TFile, oldPath: string): void {
    if (file.extension !== "md") return;
    const newDir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const slash = oldPath.lastIndexOf("/");
    const oldDir = (slash >= 0 ? oldPath.slice(0, slash) : "").replace(/\/+$/, "");
    if (newDir === oldDir) return;                      // in-folder rename, not a move-in
    if (!this.isArchiveFolder(newDir)) return;
    if (!this.encryption.isConfigured()) return;
    let pending = this.archivePending.get(newDir);
    if (!pending) { pending = { paths: new Set(), timer: 0 }; this.archivePending.set(newDir, pending); }
    pending.paths.add(file.path);
    window.clearTimeout(pending.timer);
    pending.timer = window.setTimeout(() => {
      this.archivePending.delete(newDir);
      void this.archiveSweep(newDir, [...pending!.paths]);
    }, 1800);
  }

  /** Lock the notes that just arrived in an archive folder. Among the arrivals,
   *  only subtree ROOTS are locked (a child whose parent also arrived rides
   *  inside the parent's bundle). Skips the Home note, already-locked roots, and
   *  anything that disappeared during the settle window. Loud when the vault is
   *  locked and the user declines to unlock — silent failure here would mean
   *  plaintext sitting in a folder the user believes is encrypted. */
  private async archiveSweep(folder: string, arrivedPaths: string[]): Promise<void> {
    if (!this.isArchiveFolder(folder)) return; // unmarked while settling
    const cleaned = folder.replace(/\/+$/, "");
    type Arr = { id: StashpadId; parent: StashpadId | null };
    const arrived: Arr[] = [];
    for (const p of arrivedPaths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;               // moved away/deleted meanwhile
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      // Read from DISK, not metadataCache — the cache lags right after a
      // cross-folder move (+ the 900ms re-home rewrite), and a stale/empty read
      // here would SILENTLY skip the note, leaving plaintext in a folder the user
      // believes auto-encrypts. Disk is authoritative.
      let fm: Record<string, unknown>;
      try { fm = splitFrontmatter(await this.app.vault.read(f)).fm; } catch { continue; }
      const id = typeof fm.id === "string" ? fm.id : null;
      if (!id || id === ROOT_ID) continue;
      arrived.push({ id, parent: typeof fm.parent === "string" ? fm.parent : null });
    }
    if (arrived.length === 0) return;
    const arrivedIds = new Set(arrived.map((a) => a.id));
    const alreadyLocked = new Set((this.settings.lockedSubtrees ?? []).map((e) => e.rootId).filter((x): x is StashpadId => !!x));
    const roots = arrived.filter((a) => !alreadyLocked.has(a.id) && !(a.parent && arrivedIds.has(a.parent)));
    if (roots.length === 0) return;
    if (!(await this.ensureEncryptionUnlocked())) {
      new Notice(`⚠️ Archive folder "${cleaned.split("/").pop()}": ${roots.length} arriving note${roots.length === 1 ? "" : "s"} NOT encrypted (vault is locked). Unlock encryption and lock them manually.`, 0);
      return;
    }
    let count = 0;
    for (const r of roots) {
      if (await this.lockNoteSubtree(cleaned, r.id, null, { silent: true })) count++;
    }
    if (count > 0) this.notifications.show({ message: `Archived (encrypted) ${count} note${count === 1 ? "" : "s"} moved into “${cleaned.split("/").pop()}”.`, kind: "success", category: "system", folder: cleaned });
  }

  /** Open a fresh Stashpad tab focused on a specific folder via the
   *  per-leaf folderOverride mechanism. Used by the Authorship settings
   *  section's "folders you've contributed to" list. */
  /** Open `folder` in a NEW Stashpad tab. Returns the leaf so callers can
   *  navigate IT — navigating via `lastActiveStashpadLeaf` right after this
   *  raced the MRU update and could navigate the PREVIOUS tab instead (the
   *  "current tab hijacked into the pinned note + duplicate tab" bug). */
  async activateViewForFolder(folder: string): Promise<WorkspaceLeaf | null> {
    const cleaned = (folder || "").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return null;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: { folderOverride: cleaned } as any,
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  /** Navigate a (possibly still-loading) Stashpad leaf to a note id. */
  navigateLeafTo(leaf: WorkspaceLeaf | null, folder: string, id: StashpadId): void {
    const view = leaf?.view as { navigateTo?: (id: StashpadId) => void; tree?: { get(id: StashpadId): unknown } } | undefined;
    if (view?.navigateTo && (!view.tree || view.tree.get(id))) { view.navigateTo(id); return; }
    this.navigateWhenReady(folder, id);
  }

  /** 0.93.0: open `folder` in Stashpad — reusing an existing Stashpad tab
   *  already on that folder (reveal it) instead of opening a duplicate, else
   *  opening a fresh tab. Backs the file-explorer "Open folder in Stashpad"
   *  context-menu item. */
  async openFolderInStashpad(folder: string): Promise<void> {
    const cleaned = (folder || "").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const existing = await this.findStashpadLeafForFolder(cleaned);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.activateViewForFolder(cleaned);
  }

  /** Find an existing Stashpad leaf showing `folder` — INCLUDING deferred
   *  leaves (Obsidian defers background tabs; their `view` is a stub with no
   *  `noteFolder`, so the old live-view-only check missed them and every
   *  pinned-note / folder click spawned a DUPLICATE tab next to the active
   *  one — the "current tab hijacked + cloned" bug). Deferred matches are
   *  loaded before being returned, so callers can navigate them. */
  private async findStashpadLeafForFolder(folder: string): Promise<WorkspaceLeaf | null> {
    const cleaned = folder.replace(/\/+$/, "");
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    const live = leaves.find((l) => !(l as any).isDeferred && (((l.view as any)?.noteFolder ?? "").replace(/\/+$/, "")) === cleaned);
    if (live) return live;
    const deferred = leaves.find((l) => (l as any).isDeferred
      && ((l.getViewState()?.state as { folderOverride?: string } | undefined)?.folderOverride ?? "").replace(/\/+$/, "") === cleaned);
    if (deferred) {
      try { await (deferred as any).loadIfDeferred?.(); } catch { /* fall through — reveal still works */ }
      return deferred;
    }
    return null;
  }

  /** 0.76.19: true when `file` is a Stashpad note — lives in a known
   *  Stashpad folder AND has an `id` in frontmatter. */
  private isStashpadNoteFile(file: TFile): boolean {
    const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    if (!this.discoverStashpadFolders().includes(dir)) return false;
    const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
    return typeof id === "string" && id.length > 0;
  }

  /** 0.76.19: focus `file`'s note inside Stashpad. Reuses an open
   *  Stashpad tab already on that folder (reveals + navigates it);
   *  otherwise opens a fresh tab on the folder, then navigates to the
   *  note's id. */
  async revealNoteInStashpad(file: TFile): Promise<void> {
    const folder = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
    if (!folder || typeof id !== "string" || !id) {
      new Notice("That note isn't a Stashpad note.");
      return;
    }
    await this.revealNoteByRef(folder, id);
  }

  /** Open a note by folder+id: REUSE an existing Stashpad tab on that folder
   *  (deferred ones included) and navigate it; only open a NEW tab when there
   *  isn't one. The single entry point for every "jump to this note" click —
   *  file reveals AND pinned/shared/task panel rows — so they all behave the
   *  same (0.99.2: unified; the Pinned panel used to always open a new tab). */
  async revealNoteByRef(folder: string, id: StashpadId): Promise<void> {
    const clean = folder.replace(/\/+$/, "");
    const existing = await this.findStashpadLeafForFolder(clean);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      // Focus follows the click — revealLeaf alone leaves the old tab active.
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      this.navigateLeafTo(existing, clean, id);
      return;
    }
    // 0.86.4: the freshly-opened view may still be loading its tree —
    // navigateLeafTo polls until ready, so it opens in ONE click instead of
    // landing on Home and navigating only on the second.
    const leaf = await this.activateViewForFolder(clean);
    this.navigateLeafTo(leaf, clean, id);
  }

  /** Tidy Stashpad tabs: PRUNE orphans (focused on a note that no longer
   *  exists) + collapse DUPLICATES (same folder + focused note). Returns the
   *  total tabs closed and shows a multi-line summary tally (7s).
   *
   *  Orphan detection reads the vault file list (deferred tabs checked without
   *  waking; a loaded tab whose own tree still has the note is spared). Dedupe
   *  keys on folder + `focusId` from each leaf's SERIALIZED state, so two tabs
   *  on the same folder but DIFFERENT notes are intentional and both kept. The
   *  keeper is active > loaded > deferred but WOKEN + verified healthy first, so
   *  a corrupt tab is never the survivor when a healthy one exists. */
  async closeDuplicateStashpadTabs(): Promise<number> {
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    const active = this.app.workspace.activeLeaf;

    // Warm up EVERY tab first so the dedupe/orphan checks run against live views
    // (real noteFolder/focusId, not just serialized state) and any tab that
    // can't initialize surfaces as unhealthy here rather than being kept blind.
    for (const l of leaves) {
      try { await (l as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.(); } catch { /* corrupt — handled by the healthy() check */ }
    }

    const stateOf = (l: WorkspaceLeaf) => (l.getViewState()?.state ?? {}) as { folderOverride?: string; focusId?: string };
    const folderOf = (l: WorkspaceLeaf): string => {
      const st = stateOf(l);
      return ((l as any).isDeferred ? (st.folderOverride ?? "") : ((l.view as any)?.noteFolder ?? st.folderOverride ?? "")).replace(/\/+$/, "");
    };
    const focusOf = (l: WorkspaceLeaf): string => {
      const st = stateOf(l);
      return ((l as any).isDeferred ? st.focusId : ((l.view as any)?.focusId ?? st.focusId)) || ROOT_ID;
    };
    const healthy = (l: WorkspaceLeaf): boolean => {
      const v = l.view as { getViewType?: () => string; navigateTo?: unknown; noteFolder?: unknown } | undefined;
      return !!v && v.getViewType?.() === STASHPAD_VIEW_TYPE && typeof v.navigateTo === "function" && typeof v.noteFolder === "string";
    };

    // Existing note ids per folder, for orphan detection (no tab waking needed).
    const idsByFolder = new Map<string, Set<string>>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const folder = (f.parent?.path ?? "").replace(/\/+$/, "");
      const id = (this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" && id) (idsByFolder.get(folder) ?? idsByFolder.set(folder, new Set()).get(folder)!).add(id);
    }

    // Pass 1 - prune orphans: a tab focused on a note that no longer exists
    // (deleted note, or its whole folder gone). Root-focused tabs are never
    // orphans. Closing a tab is non-destructive, so cache lag at worst closes a
    // reopenable tab - and a loaded tab whose tree still has the note is spared.
    let pruned = 0;
    const survivors: WorkspaceLeaf[] = [];
    for (const l of leaves) {
      const folder = folderOf(l);
      const focus = focusOf(l);
      if (folder && focus && focus !== ROOT_ID) {
        const loadedHas = !(l as any).isDeferred && !!(l.view as any)?.tree?.get?.(focus);
        const cacheHas = idsByFolder.get(folder)?.has(focus) ?? false;
        if (!loadedHas && !cacheHas) { l.detach(); pruned++; continue; }
      }
      survivors.push(l);
    }

    // Pass 2 - collapse duplicates (same folder + focused note) among survivors.
    const groups = new Map<string, WorkspaceLeaf[]>();
    for (const l of survivors) {
      const folder = folderOf(l);
      if (!folder) continue;
      const k = folder + " " + focusOf(l);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(l);
    }
    let closed = 0;
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => {
        const score = (l: WorkspaceLeaf) => (l === active ? 2 : (!(l as any).isDeferred ? 1 : 0));
        return score(b) - score(a);
      });
      // Wake candidates in rank order until one is a working Stashpad view.
      let keeper: WorkspaceLeaf | null = null;
      for (const cand of group) {
        try { await (cand as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.(); } catch { /* try next */ }
        if (healthy(cand)) { keeper = cand; break; }
      }
      if (!keeper) keeper = group[0]; // all unhealthy - keep best-ranked anyway
      for (const l of group) { if (l !== keeper) { l.detach(); closed++; } }
    }

    // Multi-line summary tally, lingering a few seconds so it's readable.
    const remaining = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE).length;
    const frag = document.createDocumentFragment() as unknown as { createEl: (t: string, o?: { text?: string }) => HTMLElement };
    frag.createEl("div", { text: closed + pruned > 0 ? "Stashpad tabs cleaned up:" : "Stashpad tabs - nothing to clean up:" });
    frag.createEl("div", { text: `\u2022  ${closed} duplicate tab${closed === 1 ? "" : "s"} closed` });
    frag.createEl("div", { text: `\u2022  ${pruned} orphaned tab${pruned === 1 ? "" : "s"} pruned (note no longer exists)` });
    frag.createEl("div", { text: `\u2022  ${remaining} Stashpad tab${remaining === 1 ? "" : "s"} remaining` });
    new Notice(frag as unknown as DocumentFragment, 7000);
    return closed + pruned;
  }

  /** Poll briefly for the folder's Stashpad view to have `id` in its tree, then
   *  navigate. One-click open for a not-yet-open folder. */
  private navigateWhenReady(folder: string, id: string, attempts = 15): void {
    const clean = folder.replace(/\/+$/, "");
    const view = (this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
      .find((l) => (((l.view as any)?.noteFolder ?? "").replace(/\/+$/, "")) === clean)?.view
      ?? this.lastActiveStashpadLeaf?.view) as any;
    if (view && typeof view.navigateTo === "function") {
      const treeReady = !view.tree || typeof view.tree.get !== "function" || !!view.tree.get(id);
      if (treeReady) { view.navigateTo(id); return; }
    }
    if (attempts > 0) {
      window.setTimeout(() => this.navigateWhenReady(folder, id, attempts - 1), 90);
    } else if (view && typeof view.navigateTo === "function") {
      view.navigateTo(id); // last resort — navigate anyway
    }
  }

  /** Walk vault markdown frontmatter for notes whose author or
   *  contributors list contains this user's authorId. Group results by
   *  Stashpad folder root and return them sorted by activity (authored
   *  + contributed count, descending). Surfaced in settings so the
   *  user can jump to any Stashpad they've worked in. */
  collectAuthoredFolders(): Array<{ folder: string; authored: number; contributed: number }> {
    const id = (this.settings.authorId ?? "").trim();
    if (!id) return [];
    const idTag = `-${id}`;
    const stashpads = this.discoverStashpadFolders();
    const map = new Map<string, { authored: number; contributed: number }>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
      if (!fm) continue;
      const author = typeof fm.author === "string" ? fm.author : "";
      const contributors: string[] = Array.isArray(fm.contributors)
        ? fm.contributors.filter((c: any) => typeof c === "string")
        : [];
      const isAuthored = author.includes(idTag);
      const isContributor = contributors.some((c) => c.includes(idTag));
      if (!isAuthored && !isContributor) continue;
      const dir = file.parent?.path ?? "";
      const root = stashpads.find((f) => dir === f || dir.startsWith(f + "/"));
      if (!root) continue;
      if (!map.has(root)) map.set(root, { authored: 0, contributed: 0 });
      const e = map.get(root)!;
      if (isAuthored) e.authored++;
      if (isContributor) e.contributed++;
    }
    return [...map.entries()]
      .map(([folder, counts]) => ({ folder, ...counts }))
      .sort((a, b) => (b.authored + b.contributed) - (a.authored + a.contributed));
  }

  /** Parse an author wikilink → {id,name}. Delegates to the shared
   *  helper in types.ts (kept as a thin method so existing call sites and
   *  subclasses keep working). */
  private parseAuthorRef(raw: string): { id: string; name: string } | null {
    return parseAuthorRef(raw);
  }

  /** 0.78.1: build the wikilink Stashpad writes for an arbitrary author
   *  (used by task assignment + the local-user author stamp). Mirrors the
   *  view's currentAuthorLink shape but for any {id,name}, resolved into
   *  the given Stashpad folder's _authors dir. The alias is stripped of
   *  link-structural chars (see security-findings.md). */
  authorRefFor(folder: string, id: string, name: string): string {
    const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "author";
    const path = `${folder.replace(/\/+$/, "")}/_authors/${safe}-${id}.md`;
    const aliasSafe = name.replace(/[\[\]|]/g, "").trim() || safe;
    return `[[${path}|${aliasSafe}]]`;
  }

  /** 0.78.1: ensure an author stub exists for {id,name} in `folder`,
   *  creating it from the registry's known role/department if available.
   *  Used when assigning a task to someone so the assignee wikilink
   *  resolves. No-op if a stub for this id already exists in the dir
   *  (under any name). Also registers the author. */
  async ensureAuthorStubFor(folder: string, id: string, name: string): Promise<boolean> {
    if (!id || !name) return false;
    this.authorRegistry.record({ id, name });
    const dir = `${folder.replace(/\/+$/, "")}/_authors`;
    const exists = this.app.vault.getMarkdownFiles().some(
      (f) => f.path.startsWith(dir + "/") && this.parseAuthorFilePath(f.path)?.id === id,
    );
    if (exists) return false;
    const rec = this.authorRegistry.get(id);
    const safe = this.authorNameToSafe(name);
    const path = `${dir}/${safe}-${id}.md`;
    try {
      await this.ensureFolderPath(dir);
      if (await this.app.vault.adapter.exists(path)) return false;
      await this.app.vault.create(path, this.buildAuthorStub(
        { id, name, role: rec?.role, department: rec?.department },
        new Date().toISOString(),
      ));
      return true;
    } catch (e) {
      console.warn("[Stashpad] ensureAuthorStubFor failed", path, e);
      return false;
    }
  }

  /** 0.99.17 (#2): seed EVERY known author (vault-wide) into `folder`'s
   *  `_authors/`, not just the local user — so a new folder auto-populates with
   *  coworkers and assignment works without waiting for them to contribute. Each
   *  stub reuses the author's real id. Returns how many stubs were created. */
  async seedKnownAuthorsInFolder(folder: string): Promise<number> {
    let created = 0;
    for (const a of this.collectKnownAuthors()) {
      if (await this.ensureAuthorStubFor(folder, a.id, a.name)) created++;
    }
    return created;
  }

  /** 0.99.19: Task due-date reminders. Obsidian plugins can't fire while the app
   *  is closed, so this runs at LAUNCH (onLayoutReady) and on an interval while
   *  running: it finds tasks whose `due` has passed and that haven't been
   *  reminded yet (tracked by `<id>@<dueRaw>` in settings.notifiedDueKeys, so the
   *  same task+due never re-fires — a changed due date re-keys and reminds again),
   *  shows a PERSISTENT notification under the "reminder" category (so it lands in
   *  the history log + respects mute), then records it. */
  async checkDueReminders(): Promise<void> {
    const now = Date.now();
    const notified = new Set(this.settings.notifiedDueKeys ?? []);
    const myId = (this.settings.authorId ?? "").trim();
    const due: Array<{ id: string; folder: string; file: TFile; dueMs: number; key: string }> = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.includes("/_authors/")) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: unknown; due?: unknown } | undefined;
      if (!fm || fm.due == null) continue;
      const id = typeof fm.id === "string" ? fm.id : "";
      if (!id) continue;
      const dueRaw = String(fm.due);
      const dueMs = typeof fm.due === "number" ? fm.due : Date.parse(dueRaw);
      if (!Number.isFinite(dueMs) || dueMs > now) continue; // not due yet
      // Assignee scoping: a task assigned to specific people only reminds THOSE
      // people (so I only get a reminder for a task assigned to me). An
      // UNASSIGNED task reminds everyone (i.e. me too).
      const assignees = parseAssignees(fm);
      if (assignees.length > 0 && !(myId && assignees.some((a) => a.id === myId))) continue;
      const key = `${id}@${dueRaw}`;
      if (notified.has(key)) continue;
      due.push({ id, folder: (f.parent?.path ?? "").replace(/\/+$/, ""), file: f, dueMs, key });
    }
    if (due.length === 0) return;
    // Record up front so the interval / a fast re-entry can't double-fire.
    this.settings.notifiedDueKeys = [...(this.settings.notifiedDueKeys ?? []), ...due.map((d) => d.key)].slice(-2000);
    await this.saveSettings();
    const titleOf = async (file: TFile): Promise<string> => {
      try {
        const body = splitFrontmatter(await this.app.vault.cachedRead(file)).body;
        const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
        if (line) return line.replace(/^[#>\-*\s]+/, "").slice(0, 60);
      } catch { /* fall through to filename */ }
      return file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ");
    };
    if (due.length <= 3) {
      for (const d of due) {
        const title = await titleOf(d.file);
        this.notifications.show({
          message: `⏰ Task due: “${title}” (${formatDateTime(d.dueMs, this.settings)})`,
          kind: "warning", category: "reminder", duration: 0, folder: d.folder, affectedIds: [d.id],
          actions: [{ label: "Open", onClick: () => void this.revealNoteByRef(d.folder, d.id) }],
        });
      }
    } else {
      this.notifications.show({
        message: `⏰ ${due.length} tasks are due — open the Tasks panel to review.`,
        kind: "warning", category: "reminder", duration: 0, folder: "",
      });
    }
  }

  /** 0.99.17 (#3): the "centralized sync" — rebuild the registry from the whole
   *  vault, then ensure every known author has a stub in every Stashpad folder.
   *  Backfills existing folders (new folders are handled at creation). */
  async syncAuthorsAcrossFolders(): Promise<void> {
    await this.rebuildAuthorRegistry(); // learn every author from the vault first
    const authors = this.collectKnownAuthors();
    const folders = this.discoverStashpadFolders();
    if (!authors.length || !folders.length) { new Notice("No authors or Stashpad folders to sync."); return; }
    const prog = folders.length * authors.length > 8 ? new Notice("", 0) : null;
    let created = 0;
    for (const folder of folders) {
      prog?.setMessage(`Syncing authors → ${folder.split("/").pop()}…`);
      for (const a of authors) {
        if (await this.ensureAuthorStubFor(folder, a.id, a.name)) created++;
      }
    }
    prog?.hide();
    this.notifications.show({
      message: `Synced authors across ${folders.length} folder${folders.length === 1 ? "" : "s"} — ${created} new stub${created === 1 ? "" : "s"} (${authors.length} author${authors.length === 1 ? "" : "s"} known).`,
      kind: "success", category: "system", folder: "",
    });
  }

  /** 0.99.16: VAULT-WIDE list of known authors for the assignee pickers — the
   *  union of the LOCAL registry (per-config, so in a shared vault it mostly
   *  knows just this user) AND a scan of every folder's `_authors/` stub files
   *  (id from the filename, display name from the stub's aliases/name). This is
   *  what surfaces COWORKERS who exist in shared folders but aren't in this
   *  device's registry — the reason only the local user showed up before.
   *  Deduped by id (registry name wins); the local user is listed first. Also
   *  warms the registry with anything new it finds (idempotent after the first). */
  collectKnownAuthors(): Array<{ id: string; name: string }> {
    const byId = new Map<string, string>();
    // The local user is always "known" (from settings), even before they have a
    // stub or any authored notes — and listed first.
    const myId = (this.settings.authorId ?? "").trim();
    const myName = (this.settings.authorName ?? "").trim();
    if (myId && myName) byId.set(myId, myName);
    for (const a of this.authorRegistry.all()) if (!byId.has(a.id)) byId.set(a.id, a.name);
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.includes("/_authors/")) continue;
      const parsed = this.parseAuthorFilePath(f.path);
      if (!parsed) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { aliases?: unknown; name?: unknown } | undefined;
      const aliasName = Array.isArray(fm?.aliases)
        ? ((fm!.aliases as unknown[]).find((x) => typeof x === "string") as string | undefined ?? "")
        : (typeof fm?.aliases === "string" ? fm.aliases : "");
      const name = (aliasName || (typeof fm?.name === "string" ? fm.name : "") || parsed.name).trim();
      if (!byId.has(parsed.id)) byId.set(parsed.id, name);
      this.authorRegistry.record({ id: parsed.id, name }); // warm the registry (no-op if unchanged)
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }

  /** 0.77.2: rebuild the author registry from scratch by scanning the
   *  vault. The authoritative inputs are (a) the `_authors` stub files
   *  (id from filename, display name from `aliases`/`name`/H1, plus role/
   *  department frontmatter) and (b) author/contributor wikilinks across
   *  all note frontmatter (for ids whose stub was deleted). Stub metadata
   *  wins over note-link names when both exist. Preserves firstSeen +
   *  rename history for ids already in the registry. Returns a summary. */
  async rebuildAuthorRegistry(): Promise<{ total: number; fromStubs: number; fromNotes: number }> {
    const stashpads = this.discoverStashpadFolders();
    const byId = new Map<string, { id: string; name?: string; role?: string; department?: string; fromStub: boolean }>();

    // Pass 1: author wikilinks across all note frontmatter.
    let fromNotes = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
      if (!fm) continue;
      const refs: string[] = [];
      if (typeof fm.author === "string") refs.push(fm.author);
      if (Array.isArray(fm.contributors)) {
        for (const c of fm.contributors) if (typeof c === "string") refs.push(c);
      }
      for (const raw of refs) {
        const parsed = this.parseAuthorRef(raw);
        if (!parsed) continue;
        if (!byId.has(parsed.id)) { byId.set(parsed.id, { id: parsed.id, name: parsed.name, fromStub: false }); fromNotes++; }
        else { const e = byId.get(parsed.id)!; if (!e.name && parsed.name) e.name = parsed.name; }
      }
    }

    // Pass 2: stub files (authoritative for name/role/department).
    let fromStubs = 0;
    for (const folder of stashpads) {
      const dir = `${folder}/_authors`;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(dir + "/")) continue;
        const parsed = this.parseAuthorFilePath(file.path);
        if (!parsed) continue;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
        const aliasName = Array.isArray(fm?.aliases) ? (fm.aliases.find((a: any) => typeof a === "string") ?? "")
          : (typeof fm?.aliases === "string" ? fm.aliases : "");
        const name = (aliasName || (typeof fm?.name === "string" ? fm.name : "") || parsed.name).trim();
        const role = typeof fm?.role === "string" ? fm.role : undefined;
        const department = typeof fm?.department === "string" ? fm.department : undefined;
        const existing = byId.get(parsed.id);
        if (!existing) fromStubs++;
        byId.set(parsed.id, {
          id: parsed.id,
          name: name || existing?.name,
          role: role ?? existing?.role,
          department: department ?? existing?.department,
          fromStub: true,
        });
      }
    }

    await this.authorRegistry.load();
    this.authorRegistry.replaceAll([...byId.values()]);
    await this.authorRegistry.save();
    return { total: byId.size, fromStubs, fromNotes };
  }

  /** Build the markdown content for an author stub file. Uses the
   *  Obsidian-native `aliases` for the display name (so `[[Name]]`
   *  resolves to the stub and it surfaces in quick switcher) plus role/
   *  department + a created stamp + an H1. Stashpad-owned; safe to
   *  regenerate. */
  buildAuthorStub(rec: { id: string; name: string; role?: string; department?: string }, created: string): string {
    // Collapse any newlines (defensive — a pasted value could contain one)
    // so YAML scalars + the H1 stay single-line, and escape backslashes
    // before quotes for a valid double-quoted YAML string. Without the
    // backslash pass, a name like `a\b` would produce invalid YAML and an
    // unreadable stub.
    const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
    const esc = (s: string) => oneLine(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const name = oneLine(rec.name);
    const lines = ["---", `authorId: ${rec.id}`, `aliases:`, `  - "${esc(rec.name)}"`];
    if (rec.role) lines.push(`role: "${esc(rec.role)}"`);
    if (rec.department) lines.push(`department: "${esc(rec.department)}"`);
    lines.push(`created: ${created}`, "---", `# ${name}`);
    return lines.join("\n");
  }

  /** 0.77.3: for every author the registry knows about, ensure a stub
   *  file exists in every discovered Stashpad folder — regenerating any
   *  that were deleted, from the remembered name/role/department. Never
   *  overwrites an existing stub (that's syncAuthorFilesToName's job).
   *  Returns the count of stubs created. */
  async restoreMissingAuthorStubs(): Promise<{ created: number; folders: number }> {
    await this.authorRegistry.load();
    const authors = this.authorRegistry.all().filter((a) => a.id && a.name);
    const folders = this.discoverStashpadFolders();
    const allFiles = this.app.vault.getMarkdownFiles();
    let created = 0;
    for (const folder of folders) {
      const dir = `${folder}/_authors`;
      // Precompute the set of author ids that already have a stub in this
      // dir (under any name) once per folder, rather than rescanning the
      // whole vault for every author.
      const presentIds = new Set<string>();
      for (const f of allFiles) {
        if (!f.path.startsWith(dir + "/")) continue;
        const id = this.parseAuthorFilePath(f.path)?.id;
        if (id) presentIds.add(id);
      }
      for (const rec of authors) {
        if (presentIds.has(rec.id)) continue;     // don't duplicate after a rename
        const safe = this.authorNameToSafe(rec.name);
        const path = `${dir}/${safe}-${rec.id}.md`;
        try {
          await this.ensureFolderPath(dir);
          if (await this.app.vault.adapter.exists(path)) continue;
          await this.app.vault.create(path, this.buildAuthorStub(rec, rec.firstSeen ?? new Date().toISOString()));
          created++;
        } catch (e) {
          console.warn("[Stashpad] restore author stub failed", path, e);
        }
      }
    }
    return { created, folders: folders.length };
  }

  /** 0.79.18: convert plain-text `attachments` frontmatter entries to
   *  internal links (`[[path]]`) across all notes. Idempotent — only
   *  rewrites notes that have at least one non-link entry, and
   *  `toAttachmentLink` never re-brackets an existing link, so re-running
   *  can't double-wrap or loop. Returns the count of notes changed. */
  async convertAttachmentsToLinks(): Promise<number> {
    let converted = 0;
    const isLink = (s: string) => /^\[\[.*\]\]$/.test(s.trim());
    for (const folder of this.discoverStashpadFolders()) {
      const dir = folder.replace(/\/+$/, "");
      for (const f of this.app.vault.getMarkdownFiles()) {
        const fdir = f.parent?.path?.replace(/\/+$/, "") ?? "";
        if (fdir !== dir && !fdir.startsWith(dir + "/")) continue;
        if (isInReservedSubfolder(f.path)) continue; // skip _archive/_attachments/…
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
        if (!fm || typeof fm.id !== "string" || !fm.id) continue;
        const att: any = fm.attachments;
        const isArr = Array.isArray(att);
        const isScalar = typeof att === "string" && att.trim().length > 0;
        if (!isArr && !isScalar) continue;
        // 0.85.9: also handle a SCALAR `attachments:` (hand-edited / odd import)
        // — normalize it to a one-item list of the canonical link form.
        const needs = isScalar
          ? !isLink(att as string)
          : (att as any[]).some((a: any) => typeof a === "string" && a.trim() && !isLink(a));
        if (!needs) continue;
        try {
          await this.app.fileManager.processFrontMatter(f, (m: any) => {
            if (Array.isArray(m.attachments)) {
              m.attachments = m.attachments.map((a: any) => (typeof a === "string" && a.trim()) ? toAttachmentLink(a) : a);
            } else if (typeof m.attachments === "string" && m.attachments.trim()) {
              m.attachments = [toAttachmentLink(m.attachments)];
            }
          });
          converted++;
        } catch (e) { console.warn("[Stashpad] attachment-link conversion failed", f.path, e); }
      }
    }
    return converted;
  }

  /** 0.79.12: add each discovered Stashpad folder's `_archive` to
   *  Obsidian's "Excluded files" list (`userIgnoreFilters`) so native
   *  search, quick switcher, graph, and link suggestions skip the
   *  import-originals graveyard. Add-only + idempotent — never removes the
   *  user's own entries. Uses Obsidian's internal vault config getters,
   *  which are undocumented; guarded in try/catch in case they change. */
  syncObsidianExcludedArchives(): void {
    try {
      const vault = this.app.vault as any;
      if (typeof vault.getConfig !== "function" || typeof vault.setConfig !== "function") return;
      const current: string[] = Array.isArray(vault.getConfig("userIgnoreFilters"))
        ? vault.getConfig("userIgnoreFilters") : [];
      const set = new Set(current);
      let changed = false;
      for (const folder of this.discoverStashpadFolders()) {
        const path = `${folder.replace(/\/+$/, "")}/_archive/`;
        if (!set.has(path)) { set.add(path); changed = true; }
      }
      if (changed) vault.setConfig("userIgnoreFilters", [...set]);
    } catch (e) {
      console.warn("[Stashpad] couldn't update Obsidian excluded files", e);
    }
  }

  /** 0.79.4: open the import destination chooser. Pinned top entry opens
   *  the OS file picker into the default folder; other entries target a
   *  specific Stashpad folder. With a single folder, skip to the picker. */
  openImportPicker(): void {
    const folders = this.discoverStashpadFolders();
    if (folders.length === 0) { new Notice("No Stashpad folders to import into."); return; }
    if (folders.length === 1) { this.importService.pickFilesInto(folders[0]); return; }
    const def = this.importService.defaultDestination() ?? folders[0];
    new ImportTargetModal(this.app, def, folders, (folder) => this.importService.pickFilesInto(folder)).open();
  }

  /** 0.84.1: manual counterpart to auto-import. Scans the top level of a
   *  Stashpad folder for loose files moved in from outside (Finder/Explorer
   *  copy, etc.) that Stashpad hasn't processed — i.e. files with no Stashpad
   *  `id` frontmatter — and imports them (md → note + archive original; other
   *  → _attachments + linking note). Lighter than a full rebootstrap: just
   *  this folder's direct children, no slug/frontmatter/registry sweep. Needed
   *  because the live drop-watcher only catches `.stash` files via Obsidian
   *  vault events; a plain file pasted in via Finder is otherwise only swept
   *  on rebootstrap (and only when auto-import is on). */
  async runImportLooseFiles(folder: string): Promise<void> {
    const label = folder.split("/").pop() || folder;
    let files = 0, folders = 0, stashes = 0;
    try {
      // Shared "sweep all loose content" primitive (files + folders + .stash) —
      // the same one rebootstrap uses, so behavior stays in sync. 0.84.7/0.84.8.
      ({ files, folders, stashes } = await this.importService.importLooseInto(folder));
    } catch (e) {
      this.notifications.show({
        message: `Stashpad: import failed in \`${label}\`\nError: ${(e as Error).message}`,
        kind: "error", category: "import", folder,
      });
      console.error("[Stashpad] runImportLooseFiles failed", folder, e);
      return;
    }
    const total = files + folders + stashes;
    // Refresh the active view if it's looking at this folder. New note files
    // also fire vault create → the view's metadata hook repaints, but an
    // explicit rebuild makes the result immediate on slow drives.
    const view = this.lastActiveStashpadLeaf?.view as any;
    if (total > 0 && view?.noteFolder === folder && view?.tree) {
      view.tree.rebuild(folder);
      view.render?.();
    }
    let message: string;
    if (total === 0) {
      message = `Nothing to import in \`${label}\` — everything here is already a Stashpad note.`;
    } else {
      const parts: string[] = [];
      if (files) parts.push(`${files} loose file${files === 1 ? "" : "s"}`);
      if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"} (as nested notes)`);
      if (stashes) parts.push(`${stashes} .stash bundle${stashes === 1 ? "" : "s"}`);
      message = `Imported ${parts.join(" + ")} in \`${label}\`.`;
    }
    this.notifications.show({
      message,
      kind: total > 0 ? "success" : "info",
      category: "import",
      folder,
    });
  }

  /** Refresh the active view if it's looking at `folder` (so per-step repairs
   *  show immediately, like the loose-import command does). */
  private refreshViewIfShowing(folder: string): void {
    const view = this.lastActiveStashpadLeaf?.view as any;
    if (view?.noteFolder === folder && view?.tree) { view.tree.rebuild(folder); view.render?.(); }
  }

  /** 0.85.2: re-run just the filename/slug pass on one folder — the same
   *  `rebootstrapFolderSlugs` rebootstrap uses, without the full-vault sweep. */
  async runFolderSlugPass(folder: string): Promise<void> {
    const label = folder.split("/").pop() || folder;
    let n = 0;
    try { n = await this.rebootstrapFolderSlugs(folder); }
    catch (e) {
      this.notifications.show({ message: `Stashpad: slug pass failed in \`${label}\`\n${(e as Error).message}`, kind: "error", category: "system", folder });
      console.error("[Stashpad] runFolderSlugPass failed", folder, e);
      return;
    }
    this.refreshViewIfShowing(folder);
    this.notifications.show({
      message: n > 0
        ? `Renamed ${n} stale filename${n === 1 ? "" : "s"} in \`${label}\`.`
        : `No stale filenames in \`${label}\` — all slugs match their notes.`,
      kind: n > 0 ? "success" : "info", category: "system", folder,
    });
  }

  /** 0.85.2: re-run just the frontmatter backfill (redundant `parentLink` /
   *  `children` recovery links) on one folder — the same
   *  `rebootstrapFolderFrontmatter` rebootstrap uses. */
  async runFolderFrontmatterBackfill(folder: string): Promise<void> {
    const label = folder.split("/").pop() || folder;
    let written = 0, checked = 0;
    try { const s = await rebootstrapFolderFrontmatter(this.app, folder); written = s.written; checked = s.checked; }
    catch (e) {
      this.notifications.show({ message: `Stashpad: frontmatter backfill failed in \`${label}\`\n${(e as Error).message}`, kind: "error", category: "system", folder });
      console.error("[Stashpad] runFolderFrontmatterBackfill failed", folder, e);
      return;
    }
    this.notifications.show({
      message: written > 0
        ? `Backfilled recovery links on ${written} note${written === 1 ? "" : "s"} in \`${label}\` (${checked} checked).`
        : `Recovery links already up to date in \`${label}\` (${checked} checked).`,
      kind: written > 0 ? "success" : "info", category: "system", folder,
    });
  }

  private autoSweepInProgress = false;
  /** 0.84.11: retroactive auto-import. Periodically (and once at startup) sweep
   *  EVERY Stashpad folder for non-imported loose content — the "watcher
   *  occasionally going through every folder" users expect. Catches items added
   *  while Obsidian was closed, and external Finder copies that never fired a
   *  vault event (the live watchers only react to events). Gated on autoImport
   *  + armed (so it doesn't fight the startup create-storm). Reuses the shared
   *  importLooseInto (files + folders + .stash). 0.84.12 (option C): encrypted
   *  .stash bundles are NOT decrypted inline — a background sweep never pops a
   *  blocking password modal. They're parked and surfaced via a single
   *  non-blocking "N waiting" toast with Import-now / snooze actions. */
  async runAutoImportSweep(): Promise<void> {
    if (!this.settings.autoImport) return;
    if (!this.importService.isArmed()) return;
    if (this.autoSweepInProgress) return; // a slow network-drive sweep may outlast the 5-min tick
    this.autoSweepInProgress = true;
    let files = 0, folders = 0, stashes = 0;
    try {
      for (const folder of this.discoverStashpadFolders()) {
        try {
          const r = await this.importService.importLooseInto(folder, { auto: true });
          files += r.files; folders += r.folders; stashes += r.stashes;
        } catch (e) { console.warn("[Stashpad] auto-import sweep failed", folder, e); }
      }
    } finally {
      this.autoSweepInProgress = false;
    }
    const total = files + folders + stashes;
    if (total > 0) {
      const view = this.lastActiveStashpadLeaf?.view as any;
      if (view?.tree && view?.noteFolder) { view.tree.rebuild(view.noteFolder); view.render?.(); }
      const parts: string[] = [];
      if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
      if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
      if (stashes) parts.push(`${stashes} .stash bundle${stashes === 1 ? "" : "s"}`);
      this.notifications.show({
        message: `Auto-imported ${parts.join(" + ")} (background sweep).`,
        kind: "success",
        category: "import",
      });
    }
    this.notifyPendingEncrypted();
  }

  /** Surface the encrypted .stash bundles parked by the sweep OR the live
   *  drop-watcher (0.84.16) as a single non-blocking, snoozeable toast —
   *  notification-first, never an inline modal. "Import now" opens the password
   *  prompt; the prompt itself also offers "Remind me later". Snoozed for an
   *  hour each time it shows so it doesn't re-nag (a brand-new arrival resets
   *  the snooze via parkEncrypted so it surfaces immediately). */
  private notifyPendingEncrypted(): void {
    const pending = this.importService.pendingEncryptedPaths();
    if (pending.length === 0) return;
    if (!this.importService.shouldNotifyEncrypted()) return;
    this.importService.snoozeEncryptedNotify(60 * 60 * 1000); // default: don't re-nag for 1h
    const n = pending.length;
    this.notifications.show({
      message: `${n} encrypted .stash bundle${n === 1 ? "" : "s"} waiting to import. Import ${n === 1 ? "it" : "them"} with the password?`,
      kind: "info",
      category: "import",
      duration: 0,
      actions: [
        { label: "Import now", onClick: () => void this.importPendingEncryptedNow() },
        { label: "Remind me later", onClick: () => this.importService.snoozeEncryptedNotify(60 * 60 * 1000) },
        { label: "Not now (until next launch)", onClick: () => this.importService.snoozeEncryptedNotify(Infinity) },
      ],
    });
  }

  private async importPendingEncryptedNow(): Promise<void> {
    const { imported, rescheduled } = await this.importService.importPendingEncrypted();
    if (imported > 0) {
      const view = this.lastActiveStashpadLeaf?.view as any;
      if (view?.tree && view?.noteFolder) { view.tree.rebuild(view.noteFolder); view.render?.(); }
      this.notifications.show({
        message: `Imported ${imported} encrypted .stash bundle${imported === 1 ? "" : "s"}.`,
        kind: "success",
        category: "import",
      });
    }
    // If the user picked "Remind me later" mid-prompt, the snooze is already
    // set; nothing else to do — the reminder resurfaces on the next sweep.
    void rescheduled;
  }

  /** 0.77.7: ensure the LOCAL user's author page exists in `folder`,
   *  creating it from settings if missing. Targeted counterpart to
   *  restoreMissingAuthorStubs — seeds only YOUR page (not every known
   *  author), so links/quick-switcher resolve in every folder without the
   *  N×M clutter of propagating coworker pages into folders they've never
   *  touched. No-op if your name isn't set or a stub for your id already
   *  exists in that folder (under any name). */
  async seedLocalAuthorStub(folder: string): Promise<boolean> {
    const id = (this.settings.authorId ?? "").trim();
    const name = (this.settings.authorName ?? "").trim();
    if (!id || !name) return false;
    const dir = `${folder.replace(/\/+$/, "")}/_authors`;
    const exists = this.app.vault.getMarkdownFiles().some(
      (f) => f.path.startsWith(dir + "/") && this.parseAuthorFilePath(f.path)?.id === id,
    );
    if (exists) return false;
    const safe = this.authorNameToSafe(name);
    const path = `${dir}/${safe}-${id}.md`;
    try {
      await this.ensureFolderPath(dir);
      if (await this.app.vault.adapter.exists(path)) return false;
      await this.app.vault.create(path, this.buildAuthorStub(
        { id, name, role: this.settings.authorRole, department: this.settings.authorDepartment },
        new Date().toISOString(),
      ));
      this.authorRegistry.record({ id, name, role: this.settings.authorRole, department: this.settings.authorDepartment });
      return true;
    } catch (e) {
      console.warn("[Stashpad] seedLocalAuthorStub failed", path, e);
      return false;
    }
  }

  /** Seed the local user's author page into every discovered Stashpad
   *  folder that lacks it. Run once at startup so existing folders get
   *  backfilled; new folders are handled at creation time. */
  async seedLocalAuthorStubsEverywhere(): Promise<number> {
    const name = (this.settings.authorName ?? "").trim();
    if (!name) return 0;
    let created = 0;
    for (const folder of this.discoverStashpadFolders()) {
      if (await this.seedLocalAuthorStub(folder)) created++;
    }
    return created;
  }

  /** mkdir a vault dir path, intermediates included. Tolerates races and
   *  the "already exists" error Obsidian sometimes throws. */
  private async ensureFolderPath(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      try { if (!(await adapter.exists(cur))) await adapter.mkdir(cur); }
      catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; }
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    // Migrate legacy `confirmMultiDelete` (split in 0.51.12 into two flags:
    // confirmBulkDelete + confirmAttachmentDelete). Preserve the user's
    // previous choice by seeding both new flags from the old value when
    // the new ones haven't been written yet.
    if (typeof data?.confirmMultiDelete === "boolean") {
      if (typeof data.confirmBulkDelete !== "boolean") data.confirmBulkDelete = data.confirmMultiDelete;
      if (typeof data.confirmAttachmentDelete !== "boolean") data.confirmAttachmentDelete = data.confirmMultiDelete;
      delete data.confirmMultiDelete;
    }
    // 0.71.4: migrate jdIndexDestFolder (0.71.0 name) → jdIndexStashpadFolder
    // (0.71.2 rename). Without this, users who configured the field
    // before the rename would silently lose their value and the
    // preview would land in no-dest territory.
    if (typeof (data as any)?.jdIndexDestFolder === "string"
        && typeof (data as any)?.jdIndexStashpadFolder !== "string") {
      (data as any).jdIndexStashpadFolder = (data as any).jdIndexDestFolder;
    }
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(data?.shortcuts ?? {}) },
      mod: { ...DEFAULT_SETTINGS.mod, ...(data?.mod ?? {}) },
      bindings: mergeBindings(data?.bindings, data?.shortcuts, data?.mod),
      customPalette: Array.isArray(data?.customPalette)
        ? data.customPalette.filter((c: unknown) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c))
        : [],
      colorAliases: (data?.colorAliases && typeof data.colorAliases === "object")
        ? data.colorAliases
        : {},
      noteTemplates: (data?.noteTemplates && typeof data.noteTemplates === "object")
        ? data.noteTemplates
        : {},
      authorName: typeof data?.authorName === "string" ? data.authorName : "",
      authorId: typeof data?.authorId === "string" ? data.authorId : "",
      authorRole: typeof data?.authorRole === "string" ? data.authorRole : "",
      authorDepartment: typeof data?.authorDepartment === "string" ? data.authorDepartment : "",
      showAuthor: typeof data?.showAuthor === "boolean" ? data.showAuthor : true,
      showContributors: typeof data?.showContributors === "boolean" ? data.showContributors : true,
      showLastEdit: typeof data?.showLastEdit === "boolean" ? data.showLastEdit : true,
      viewModes: (data?.viewModes && typeof data.viewModes === "object" && !Array.isArray(data.viewModes))
        ? data.viewModes
        : {},
      includeAttachmentsInEverything: (data?.includeAttachmentsInEverything && typeof data.includeAttachmentsInEverything === "object" && !Array.isArray(data.includeAttachmentsInEverything))
        ? data.includeAttachmentsInEverything
        : {},
      hideChildlessNotes: (data?.hideChildlessNotes && typeof data.hideChildlessNotes === "object" && !Array.isArray(data.hideChildlessNotes))
        ? data.hideChildlessNotes
        : {},
      hideCompletedNotes: (data?.hideCompletedNotes && typeof data.hideCompletedNotes === "object" && !Array.isArray(data.hideCompletedNotes))
        ? data.hideCompletedNotes
        : {},
      mutedNotificationCategories: Array.isArray(data?.mutedNotificationCategories)
        ? data.mutedNotificationCategories.filter((x: unknown): x is string => typeof x === "string")
        : [],
      notificationHistoryLimit: (typeof data?.notificationHistoryLimit === "number" && Number.isFinite(data.notificationHistoryLimit))
        ? data.notificationHistoryLimit
        : 5000,
      notifiedDueKeys: Array.isArray(data?.notifiedDueKeys)
        ? data.notifiedDueKeys.filter((x: unknown): x is string => typeof x === "string").slice(-2000)
        : [],
      drafts: normalizeDrafts(data?.drafts),
      lastSubmitted: data?.lastSubmitted && typeof data.lastSubmitted === "object" ? data.lastSubmitted : {},
      // Migrate: when slugStopWords has never been set on this install
      // (undefined on disk), seed it with the default list so the
      // settings textbox shows actual content. Once the user edits — even
      // to clear it — the saved list is treated as authoritative.
      slugStopWords: Array.isArray(data?.slugStopWords)
        ? data.slugStopWords
        : [...DEFAULT_STOPWORDS],
    };
    setSettings(this.settings);
    // Sync the notification service's mute set from settings. Safe to
    // call before any toasts fire — the service no-ops on empty mute
    // sets. Cast through string[] → NotificationCategory[] since the
    // on-disk list is opaque (forward-compatible with new categories).
    this.notifications.loadMutedFromList(this.settings.mutedNotificationCategories as any);
    // Apply the user's history-cap setting (default 5000; <=0 means
    // unlimited). Setting this BEFORE the loadHistory call below
    // ensures the restored history is trimmed to the right size.
    this.notifications.setHistoryLimit(this.settings.notificationHistoryLimit);
    // Stamp the local user's authorId so multiplayer filters in the
    // history modal can pivot on "who acted here" without every
    // notification site having to remember.
    this.notifications.setDefaultAuthorId(this.settings.authorId);
    // Restore persisted notification history from disk + wire a
    // debounced save on every push so it survives reloads.
    void this.attachNotificationPersistence();
  }

  /** Notification-history persistence — load on plugin onload, save
   *  on every history mutation (debounced 1s to coalesce bursts).
   *  Storage lives at <pluginDir>/notifications.json as a single
   *  JSON dump of NotificationRecord[]. Idempotent: subsequent calls
   *  early-return after the first wire-up. */
  private notifPersistenceWired = false;
  private notifSaveTimer: number | null = null;
  private notificationsPath(): string {
    return this.pluginPrivatePath("notifications.json");
  }
  private async attachNotificationPersistence(): Promise<void> {
    if (this.notifPersistenceWired) return;
    this.notifPersistenceWired = true;
    const adapter = this.app.vault.adapter;
    const path = this.notificationsPath();
    try {
      if (await adapter.exists(path)) {
        const raw = await adapter.read(path);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.notifications.loadHistory(parsed);
      }
    } catch (e) {
      console.warn("[Stashpad] failed to load notification history", e);
    }
    // Debounced save on every history change.
    this.notifications.onChange(() => {
      if (this.notifSaveTimer != null) window.clearTimeout(this.notifSaveTimer);
      this.notifSaveTimer = window.setTimeout(() => {
        this.notifSaveTimer = null;
        void this.persistNotificationHistory();
      }, 1000);
    });
  }
  private async persistNotificationHistory(): Promise<void> {
    try {
      const records = this.notifications.recent().slice().reverse(); // oldest-first on disk
      const path = this.notificationsPath();
      const dir = path.replace(/\/[^/]+$/, "");
      const adapter = this.app.vault.adapter;
      if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(path, JSON.stringify(records));
    } catch (e) {
      console.warn("[Stashpad] failed to save notification history", e);
    }
  }

  /** Per-(folder, focus) "last cursor note id" persistence via localStorage.
   *  0.56.14: replaces the pixel-scrollTop approach. Stable across layout
   *  changes (markdown reflows, font/image loads, list growth) because
   *  it's a logical id, not a pixel coordinate. On view restore we scroll
   *  that note into view via the `scroll-to-id` policy.
   *
   *  Storage key: "stashpad:last-cursor" → JSON { "<folder>": { "<focusId>": "<noteId>" } } */
  private readonly LAST_CURSOR_LS_KEY = "stashpad:last-cursor";
  private readLastCursorFile(): Record<string, Record<string, string>> {
    try {
      const raw = window.localStorage.getItem(this.LAST_CURSOR_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, Record<string, string>> : {};
    } catch {
      return {};
    }
  }
  /** Map of <focusId> → <last cursor note id> for the given folder. */
  loadLastCursor(folder: string): Map<string, string> {
    const all = this.readLastCursorFile();
    const slice = all[folder] ?? {};
    return new Map(Object.entries(slice));
  }
  /** Synchronously persist last cursor for one (folder, focus). */
  saveLastCursor(folder: string, focusId: string, noteId: string): void {
    try {
      const all = this.readLastCursorFile();
      if (!all[folder]) all[folder] = {};
      all[folder][focusId] = noteId;
      window.localStorage.setItem(this.LAST_CURSOR_LS_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn("[Stashpad] failed to save last-cursor", e);
    }
  }

  // 0.91.0: last MULTI-SELECTION per (folder, focus), persisted to
  // localStorage. Mirrors the last-cursor store above. Lives in localStorage
  // rather than view state because (a) it must survive even when the tab is
  // lazy-loaded/deferred on reload, and (b) selection changes don't trigger a
  // workspace-layout save, so getState() would capture stale state. Stamped on
  // beforeunload/blur/onClose (eager), read back on view load.
  private readonly LAST_SELECTION_LS_KEY = "stashpad:last-selection";
  private readLastSelectionFile(): Record<string, Record<string, string[]>> {
    try {
      const raw = window.localStorage.getItem(this.LAST_SELECTION_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, Record<string, string[]>> : {};
    } catch {
      return {};
    }
  }
  /** Map of <focusId> → <selected note ids> for the given folder. */
  loadLastSelection(folder: string): Map<string, string[]> {
    const all = this.readLastSelectionFile();
    const slice = all[folder] ?? {};
    const out = new Map<string, string[]>();
    for (const [focusId, ids] of Object.entries(slice)) {
      if (Array.isArray(ids)) out.set(focusId, ids.filter((x): x is string => typeof x === "string"));
    }
    return out;
  }
  /** Synchronously persist the selection for one (folder, focus). An empty
   *  array clears it (so deselect-then-reload doesn't resurrect stale ids). */
  saveLastSelection(folder: string, focusId: string, ids: string[]): void {
    try {
      const all = this.readLastSelectionFile();
      if (!all[folder]) all[folder] = {};
      if (ids.length) all[folder][focusId] = ids;
      else delete all[folder][focusId];
      window.localStorage.setItem(this.LAST_SELECTION_LS_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn("[Stashpad] failed to save last-selection", e);
    }
  }

  /** Serializes ALL settings writes so a fast draft-write can't race with
   *  a settings-tab edit and clobber a freshly-changed shortcut. Both
   *  saveSettings() and persistSettingsQuiet() funnel through here. */
  private writeChain: Promise<void> = Promise.resolve();
  private queueWrite(): Promise<void> {
    // Snapshot the settings reference at queue time. saveData itself does
    // a synchronous JSON.stringify, but we still chain so two in-flight
    // writes can't interleave their adapter.write calls.
    const next = this.writeChain.then(() => this.saveData(this.settings));
    this.writeChain = next.catch(() => {});
    return next;
  }

  async saveSettings(): Promise<void> {
    await this.queueWrite();
    setSettings(this.settings);
    perf.enabled = !!this.settings.enablePerfProfiling;
    // 0.77.1: keep the registry's record of the local user current. The
    // registry is a recovery cache — recording here means a name/role/
    // department change is remembered (with rename history) even if the
    // _authors stubs are later deleted.
    const id = (this.settings.authorId ?? "").trim();
    if (id) {
      this.authorRegistry.record({
        id,
        name: this.settings.authorName,
        role: this.settings.authorRole,
        department: this.settings.authorDepartment,
      });
    }
    console.debug("[Stashpad] saveSettings", {
      shortcuts: this.settings.shortcuts,
      mod: this.settings.mod,
    });
  }

  /** Persist settings to disk WITHOUT firing the onSettingsChange listeners,
   *  so high-frequency writes (e.g. composer drafts) don't trigger re-renders
   *  that would steal focus from the textarea. */
  async persistSettingsQuiet(): Promise<void> {
    await this.queueWrite();
  }

  /** Stamp the active markdown file with Stashpad frontmatter (id, parent,
   *  created), only filling fields that are missing or blank. The file is
   *  presumed to already live inside a Stashpad folder; we don't move it.
   *
   *  - id: validated as a non-empty string with no whitespace; if missing or
   *    colliding with an existing note in the vault, a fresh id is generated
   *    and re-checked until unique.
   *  - parent: defaults to ROOT_ID (the home note) when missing or blank.
   *  - created: defaults to the file's ctime as ISO-8601 (matching the
   *    format used by createNoteUnder).
   */
  /** Scan every markdown file inside any discovered Stashpad folder
   *  and bring its frontmatter into a valid Stashpad shape:
   *    - id        → generated if missing, never overwritten if present
   *    - parent    → ROOT_ID if missing/empty, never overwritten otherwise
   *    - created   → file ctime if missing
   *
   *  This is the batch version of the adopt command, except it also
   *  picks up files that were dropped into a Stashpad folder without
   *  ever being adopted. Files that are already valid Stashpad notes
   *  are skipped (the scan reports zero work for them).
   */
  async fixOrphanParents(): Promise<void> {
    const stashpadFolders = new Set(this.discoverStashpadFolders());
    if (stashpadFolders.size === 0) {
      new Notice("No Stashpad folders found.");
      return;
    }

    // Collect every used id across the vault so generated ids don't
    // collide. Built once for the whole batch.
    const usedIds = new Set<string>();
    const allMd = this.app.vault.getMarkdownFiles();
    for (const f of allMd) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      if (id) usedIds.add(id);
    }

    const { newId } = await import("./id-service");
    const pickFreshId = (): string => {
      for (let i = 0; i < 100; i++) {
        const c = newId();
        if (!usedIds.has(c)) { usedIds.add(c); return c; }
      }
      for (let len = 8; len <= 16; len += 2) {
        const c = newId(len);
        if (!usedIds.has(c)) { usedIds.add(c); return c; }
      }
      throw new Error("Could not generate a unique id");
    };

    interface Plan { file: TFile; addId: boolean; addParent: boolean; addCreated: boolean; }
    const plan: Plan[] = [];
    for (const f of allMd) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!stashpadFolders.has(dir)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown; parent?: unknown; created?: unknown } | undefined;
      const idStr = typeof fm?.id === "string" ? fm.id.trim() : "";
      const p = fm?.parent;
      const hasParent = typeof p === "string" ? p.trim() !== "" : (p !== undefined && p !== null);
      const hasCreated = typeof fm?.created === "string" && fm.created.trim() !== "";
      const addId = !idStr;
      const addParent = !hasParent;
      const addCreated = !hasCreated;
      if (!addId && !addParent && !addCreated) continue;
      plan.push({ file: f, addId, addParent, addCreated });
    }

    if (plan.length === 0) {
      new Notice("Nothing to fix — every note in a Stashpad folder already has id + parent + created.");
      return;
    }

    let fixed = 0;
    let failed = 0;
    const log = this.newLog();
    for (const item of plan) {
      try {
        let stampedId: string | undefined;
        await this.app.fileManager.processFrontMatter(item.file, (m) => {
          if (item.addId) {
            const cur = typeof m.id === "string" ? m.id.trim() : "";
            if (!cur) { stampedId = pickFreshId(); m.id = stampedId; }
          }
          if (item.addParent) {
            const cur = m.parent;
            const set = typeof cur === "string" ? cur.trim() !== "" : (cur !== undefined && cur !== null);
            if (!set) m.parent = ROOT_ID;
          }
          if (item.addCreated) {
            const cur = typeof m.created === "string" ? m.created.trim() : "";
            if (!cur) m.created = new Date(item.file.stat.ctime).toISOString();
          }
        });
        const fmAfter = this.app.metadataCache.getFileCache(item.file)?.frontmatter as
          | { id?: string } | undefined;
        const id = stampedId ?? fmAfter?.id ?? "";
        if (id) {
          await log.append({
            type: "parent_change", id,
            payload: { from: null, to: ROOT_ID, reason: "orphan_fix", path: item.file.path,
              addedId: item.addId, addedParent: item.addParent, addedCreated: item.addCreated },
          });
        }
        fixed++;
      } catch (e) {
        console.warn("Stashpad: orphan fix failed for", item.file.path, e);
        failed++;
      }
    }
    const tail = failed ? ` (${failed} failed — see console)` : "";
    new Notice(`Fixed ${fixed} note${fixed === 1 ? "" : "s"} in Stashpad folders${tail}.`);
  }

  async adoptNote(file: TFile): Promise<void> {
    const { newId } = await import("./id-service");
    // Build the set of currently-used ids by reading the metadataCache
    // frontmatter for every markdown file in the vault. Cheap — the cache
    // is already populated; we just inspect it.
    const usedIds = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === file.path) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      if (id) usedIds.add(id);
    }

    // Pick a fresh id that doesn't collide. newId() pulls from a 32-char
    // alphabet at length 6 → ~1 billion possibilities, so collisions are
    // rare; the loop is just defensive.
    const pickFreshId = (): string => {
      for (let i = 0; i < 50; i++) {
        const candidate = newId();
        if (!usedIds.has(candidate)) return candidate;
      }
      // Fall back to a longer id if we somehow can't find a free 6-char one.
      for (let len = 8; len <= 16; len += 2) {
        const candidate = newId(len);
        if (!usedIds.has(candidate)) return candidate;
      }
      throw new Error("Could not generate a unique id");
    };

    let added: string[] = [];
    let kept: string[] = [];
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        // id: must be a non-empty string, no whitespace.
        const existingId = typeof fm.id === "string" ? fm.id.trim() : "";
        if (!existingId || /\s/.test(existingId) || usedIds.has(existingId)) {
          fm.id = pickFreshId();
          added.push("id");
        } else {
          kept.push("id");
        }
        // parent: missing/blank → ROOT_ID. (null is an explicit, valid value
        // meaning "directly under root" in some legacy notes — we treat it
        // the same as ROOT_ID for new adoptions.)
        const hasParent = fm.parent !== undefined && fm.parent !== null && String(fm.parent).trim() !== "";
        if (!hasParent) {
          fm.parent = ROOT_ID;
          added.push("parent");
        } else {
          kept.push("parent");
        }
        // created: missing/blank → file's ctime as ISO string.
        const hasCreated = typeof fm.created === "string" && fm.created.trim() !== "";
        if (!hasCreated) {
          fm.created = new Date(file.stat.ctime).toISOString();
          added.push("created");
        } else {
          kept.push("created");
        }
      });
    } catch (e) {
      new Notice(`Adopt failed: ${(e as Error).message}`);
      return;
    }

    // Append the id to the filename if it's not already there. Stashpad's
    // own creator emits "<slug>-<id>.md"; matching that lets parseIdFromFilename
    // recover the id from the path even before the metadataCache parses.
    let renamed = false;
    try {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: string } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      if (id && file.basename && !file.basename.endsWith(`-${id}`)) {
        const newPath = `${file.parent ? file.parent.path + "/" : ""}${file.basename}-${id}.md`;
        if (!(await this.app.vault.adapter.exists(newPath))) {
          await this.app.fileManager.renameFile(file, newPath);
          renamed = true;
        }
      }
    } catch (e) {
      console.warn("Stashpad: adopt rename failed", e);
    }

    if (added.length === 0 && !renamed) {
      new Notice(`Already a Stashpad note (${kept.join(", ")} present).`);
      return;
    }
    const parts: string[] = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (renamed) parts.push("renamed with id");
    new Notice(`Adopted into Stashpad — ${parts.join("; ")}.`);
    // Nudge any open Stashpad views to re-pick up the file. The metadataCache
    // change will trigger their tree rebuild on its own; this is just for the
    // log.
    try {
      const log = this.newLog();
      const fmAfter = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: string; parent?: string | null } | undefined;
      const id = fmAfter?.id ?? "";
      if (id) {
        await log.append({
          type: "create", id,
          payload: { path: file.path, parent: fmAfter?.parent ?? ROOT_ID, source: "adopt", added },
        });
      }
    } catch {}
  }
}

/** Coerce drafts state into the new flat shape: Record<folder, string>.
 *  Tolerates missing/wrong types and the old per-focusId nested shape. */
/** Build the unified bindings map. Priority: explicit `bindings` from disk
 *  (validated), then migration from legacy `shortcuts` + `mod`, then
 *  built-in defaults from COMMAND_META. */
function mergeBindings(
  raw: any,
  legacyShortcuts: any,
  legacyMod: any,
): CommandBindingMap {
  const out = buildDefaultBindings();
  // Migrate from legacy first; explicit `bindings` from disk wins below.
  // CRITICAL: only overwrite the default with a NON-EMPTY legacy value.
  // An older settings.json that saved split:"" or copyOutline:"" would
  // otherwise blank out our new defaults on every plugin load.
  for (const m of COMMAND_META) {
    const legacy = legacyShortcuts && typeof legacyShortcuts[m.id] === "string"
      ? legacyShortcuts[m.id]
      : (legacyMod && typeof legacyMod[m.id] === "string" ? legacyMod[m.id] : null);
    if (legacy != null && legacy !== "") out[m.id].primary = legacy;
  }
  if (raw && typeof raw === "object") {
    for (const m of COMMAND_META) {
      const r = raw[m.id];
      if (!r || typeof r !== "object") continue;
      out[m.id] = {
        primary: typeof r.primary === "string" ? r.primary : out[m.id].primary,
        secondary: typeof r.secondary === "string" ? r.secondary : "",
        preferRight: !!r.preferRight,
        // 0.73.8: persist `useBoth` across reloads. Missing here meant
        // the settings UI checkbox kept saving the value, but
        // mergeBindings dropped it on the way back in, so reload
        // always reset it to undefined → unchecked.
        useBoth: !!r.useBoth,
      };
    }
  }
  // 0.91.3: one-time upgrade to a NEW default secondary/useBoth (e.g.
  // toggleComplete gaining "X" + both-active). Only applies when the saved
  // binding is the UNTOUCHED old default — same primary, no secondary, not
  // useBoth — so a user who deliberately cleared/changed it is never clobbered.
  for (const m of COMMAND_META) {
    if (!m.defaultSecondary && !m.defaultUseBoth) continue;
    const b = out[m.id];
    if (b.primary === m.defaultPrimary && !b.secondary && !b.useBoth) {
      b.secondary = m.defaultSecondary ?? "";
      b.useBoth = !!m.defaultUseBoth;
    }
  }
  return out;
}

function normalizeDrafts(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [folder, val] of Object.entries(raw)) {
    if (typeof val === "string") {
      out[folder] = val;
    } else if (val && typeof val === "object") {
      // Old shape: collapse nested {focusId: text} → first non-empty text.
      for (const v of Object.values(val as any)) {
        if (typeof v === "string" && v.length > 0) { out[folder] = v; break; }
      }
    }
  }
  return out;
}

/** 0.79.4 / 0.80.1: destination chooser for the Import command. Lists the
 *  Stashpad folders with the current/active one first; picking one opens
 *  the OS file picker into that folder and imports the chosen files. */
interface ImportTarget { label: string; folder: string; current?: boolean }
class ImportTargetModal extends SuggestModal<ImportTarget> {
  constructor(
    app: import("obsidian").App,
    private def: string,
    private folders: string[],
    private onPick: (folder: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a Stashpad folder to import into…");
  }
  getSuggestions(query: string): ImportTarget[] {
    const q = query.toLowerCase();
    // Current folder first, then the rest (deduped), filtered by query.
    const ordered = [this.def, ...this.folders.filter((f) => f !== this.def)];
    return ordered
      .filter((f) => f.toLowerCase().includes(q))
      .map((f) => ({ label: f, folder: f, current: f === this.def }));
  }
  renderSuggestion(item: ImportTarget, el: HTMLElement): void {
    el.createDiv({ text: item.label });
    if (item.current) {
      el.createDiv({ cls: "stashpad-suggest-note", text: "current" });
      el.addClass("is-pinned-import-target");
    }
  }
  onChooseSuggestion(item: ImportTarget): void { this.onPick(item.folder); }
}
