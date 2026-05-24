import { Menu, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { STASHPAD_VIEW_TYPE } from "./types";
import { StashpadView } from "./view";
import {
  DEFAULT_SETTINGS, StashpadSettings, StashpadSettingTab, setSettings,
  buildDefaultBindings, COMMAND_META, type CommandBindingMap, type CommandId,
} from "./settings";
import { DEFAULT_STOPWORDS, bodyToSlug, buildFilename, parseIdFromFilename } from "./slug-service";
import { getActiveView, onActiveViewChange } from "./active-view";
import { importStashZip, STASH_EXT } from "./stash-package";
import { StashpadLog } from "./log";
import { ROOT_ID } from "./types";
import { UndoStack } from "./undo-stack";
import { rebootstrapFolderFrontmatter } from "./frontmatter-sync";
import { NotificationService, buildFileActions } from "./notifications";

export default class StashpadPlugin extends Plugin {
  settings: StashpadSettings = { ...DEFAULT_SETTINGS };
  private undoStacks = new Map<string, UndoStack>();
  /** Plugin-level notification service. Routes all toasts through one
   *  pipe so history + per-category mute + multiplayer filters work
   *  uniformly across views. Instantiated lazily on first access in
   *  case `this.app` isn't ready at field-initialiser time. */
  private _notifications: NotificationService | null = null;
  get notifications(): NotificationService {
    if (!this._notifications) this._notifications = new NotificationService(this.app);
    return this._notifications;
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
    return [...folders].sort();
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
    const all = this.discoverStashpadFolders();
    const filtered = all.filter((f) => {
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
    this.addSettingTab(new StashpadSettingTab(this.app, this));

    this.registerView(
      STASHPAD_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadView(leaf, this),
    );

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

    // 0.60.0: smarter ribbon icon.
    //  - Click w/ 0 leaves open  → open default in a new tab.
    //  - Click w/ 1 leaf open    → reveal it.
    //  - Click w/ 2+ leaves open → menu listing each leaf to reveal,
    //                              plus every discovered Stashpad folder
    //                              that isn't currently open (opens new
    //                              tab on click), plus "Switch folder…"
    //                              entry for the full picker.
    //  - Right-click             → same menu unconditionally (so the
    //                              user can reach the folder switcher
    //                              even with only one tab open).
    const ribbon = this.addRibbonIcon("list-tree", "Open Stashpad", (evt) => {
      const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
      if (leaves.length >= 2) {
        this.showRibbonMenu(evt as MouseEvent);
        return;
      }
      void this.activateView({ reveal: true });
    });
    ribbon.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.showRibbonMenu(evt as MouseEvent);
    });

    this.addCommand({
      id: "stashpad-open",
      name: "Open Stashpad in new tab",
      callback: () => void this.activateView({ reveal: false }),
    });
    this.addCommand({
      id: "stashpad-reveal",
      name: "Reveal or open Stashpad",
      callback: () => void this.activateView({ reveal: true }),
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
    this.addCommand({ id: "stashpad-select-all", name: "Select all visible notes", callback: () => call("cmdSelectAll") });
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
      id: "stashpad-import-stash",
      name: "Import .stash file…",
      callback: () => call("cmdImportStash"),
    });
    this.addCommand({
      id: "stashpad-pick-folder",
      name: "Switch this Stashpad tab to another folder…",
      callback: () => call("cmdOpenFolderPicker"),
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
    // 0.58.0: rebootstrap as a command palette entry — mirrors the
    // "Rebootstrap now" button in settings. Useful when troubleshooting
    // / migrating without opening Settings.
    this.addCommand({
      id: "stashpad-rebootstrap-all",
      name: "Rebootstrap all Stashpad folders (backfill metadata + rename stale titles)",
      callback: async () => {
        new Notice("Stashpad: rebootstrapping…");
        try {
          const { touched, fmChecked, fmWritten, slugsRenamed } = await this.rebootstrapAllFolders();
          const parts: string[] = [];
          parts.push(`rebootstrapped ${touched.length} folder${touched.length === 1 ? "" : "s"}`);
          if (fmWritten > 0) parts.push(`updated ${fmWritten} note${fmWritten === 1 ? "" : "s"}' metadata`);
          if (slugsRenamed > 0) parts.push(`renamed ${slugsRenamed} note${slugsRenamed === 1 ? "" : "s"}`);
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

    // Drop-folder watcher: a .stash file appearing (created OR moved) inside any
    // "<stashpadFolder>/<dropSub>/" path gets auto-imported into that <stashpadFolder>.
    const onMaybeDrop = (file: TFile) => {
      if (file.extension !== STASH_EXT) return;
      const dropSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
      const exportSub = (this.settings.exportFolder || "").trim().replace(/^\/+|\/+$/g, "");
      if (!dropSub) return;
      const parent = file.parent?.path || "";
      // Parent must end with "/<dropSub>" (or BE "<dropSub>" if it lives at vault root).
      const parentBase = parent.split("/").pop() ?? "";
      if (parentBase !== dropSub) return;
      // Guard: ignore files that came from an export folder of the same Stashpad folder.
      if (exportSub && parent.endsWith(`/${exportSub}`)) return;
      // Destination = the parent of the dropSub (i.e. the actual Stashpad folder).
      const destFolder = parent.slice(0, parent.length - dropSub.length).replace(/\/+$/, "") || this.settings.folder;
      void this.autoImportStash(file, destFolder);
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
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) onMaybeOrphan(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) onMaybeOrphan(file);
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

  /** Rewrite an author stub file's H1 heading + name/role/department
   *  frontmatter to match the current settings. Idempotent. */
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
        m.name = name;
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

  private async autoImportStash(file: TFile, destFolder: string): Promise<void> {
    try {
      const buf = new Uint8Array(await this.app.vault.readBinary(file));
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
  async rebootstrapAllFolders(): Promise<{ touched: string[]; fmChecked: number; fmWritten: number; slugsRenamed: number }> {
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
      if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.createFolder(path);
    };
    let fmChecked = 0;
    let fmWritten = 0;
    let slugsRenamed = 0;
    for (const folder of seen) {
      try {
        if (importSub) await ensureFolder(`${folder}/${importSub}`);
        if (exportSub) await ensureFolder(`${folder}/${exportSub}`);
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
        touched.push(folder);
      } catch (e) {
        console.warn(`Stashpad: rebootstrap skipped ${folder}`, e);
      }
    }
    return { touched, fmChecked, fmWritten, slugsRenamed };
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

  /** Ribbon-icon quick menu — built from the open Stashpad leaves +
   *  the discovered Stashpad folders. Picked entries either reveal an
   *  existing leaf (for currently-open folders) or open a new tab on
   *  the picked folder. A "Switch folder…" trailing entry opens the
   *  full picker for create-or-rare-folder cases. 0.60.0. */
  private showRibbonMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    // Per-leaf entries: reveal an existing tab. Title is the folder the
    // leaf is targeting, falling back to the plugin default.
    const folderForLeaf = (leaf: WorkspaceLeaf): string => {
      const state = leaf.getViewState();
      const fOverride = (state.state as any)?.folderOverride;
      if (typeof fOverride === "string" && fOverride.trim()) {
        return fOverride.trim().replace(/^\/+|\/+$/g, "");
      }
      return (this.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "");
    };
    const seenFolders = new Set<string>();
    if (leaves.length > 0) {
      for (const leaf of leaves) {
        const f = folderForLeaf(leaf);
        seenFolders.add(f);
        const label = f.split("/").pop() || f;
        menu.addItem((it: any) => it
          .setTitle(`Reveal "${label}" tab`)
          .setIcon("layout-grid")
          .onClick(() => this.app.workspace.revealLeaf(leaf)));
      }
      menu.addSeparator();
    }
    // Per-folder entries for Stashpad folders NOT currently open as
    // their own tab — open a new tab on that folder.
    const allFolders = this.discoverStashpadFolders().filter((f) => !seenFolders.has(f));
    for (const folder of allFolders) {
      const label = folder.split("/").pop() || folder;
      menu.addItem((it: any) => it
        .setTitle(`Open "${label}" in new tab`)
        .setIcon("layout-template")
        .onClick(() => void this.activateViewForFolder(folder)));
    }
    if (allFolders.length > 0) menu.addSeparator();
    // Trailing entry: open the full folder picker on the active leaf
    // (or a fresh one if there isn't one). Picker handles create-new-
    // folder + arbitrary-vault-path cases the discovered list can't.
    menu.addItem((it: any) => it
      .setTitle("Switch folder…")
      .setIcon("folder-search")
      .onClick(async () => {
        // Reveal an existing leaf first so its picker has the right
        // origin; create one if none exists.
        if (leaves.length === 0) await this.activateView({ reveal: true });
        else this.app.workspace.revealLeaf(leaves[0]);
        const v = getActiveView();
        if (v && typeof (v as any).cmdOpenFolderPicker === "function") {
          (v as any).cmdOpenFolderPicker();
        }
      }));
    menu.showAtMouseEvent(evt);
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

  /** Open a fresh Stashpad tab focused on a specific folder via the
   *  per-leaf folderOverride mechanism. Used by the Authorship settings
   *  section's "folders you've contributed to" list. */
  async activateViewForFolder(folder: string): Promise<void> {
    const cleaned = (folder || "").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: { folderOverride: cleaned } as any,
    });
    this.app.workspace.revealLeaf(leaf);
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
      };
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
