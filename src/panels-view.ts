import { App, ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import {
  ROOT_ID,
  STASHPAD_PANELS_VIEW_TYPE,
  STASHPAD_VIEW_TYPE,
  type PinnedNoteRef,
  type StashpadId,
} from "./types";

/** Panel ids registered with the StashpadPanelsView. Future panels
 *  (e.g. recent activity, search results, attachments) add to this
 *  union; the master-panel button bar surfaces one button per id. */
type PanelId = "pinned" | "shared" | "tasks";

/** Per-panel metadata used by the master button bar. */
const PANEL_REGISTRY: Record<PanelId, { label: string; icon: string }> = {
  pinned: { label: "Pinned", icon: "pin" },
  // 0.70.0: Shared panel — surfaces notes you authored that have
  // contributors AND notes in folders whose home you authored but
  // someone else wrote.
  shared: { label: "Shared", icon: "users" },
  // 0.71.30: Tasks panel — lists notes whose frontmatter has
  // `completed: true` or any `due` key. Grouped by folder.
  tasks: { label: "Tasks", icon: "check-circle-2" },
};

/** Sidebar view containing every Stashpad panel. The top of the view
 *  is the master button bar (one button per registered panel); the
 *  rest is whichever panel is currently active. 0.68.0. */
export class StashpadPanelsView extends ItemView {
  private activePanel: PanelId = "pinned";
  /** Ids of pinned-note rows that are currently expanded into their
   *  subtree outline. Non-persistent; resets on view re-open. */
  private expanded = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) {
    super(leaf);
  }

  getViewType(): string { return STASHPAD_PANELS_VIEW_TYPE; }
  getDisplayText(): string { return "Stashpad panels"; }
  getIcon(): string { return "panel-left"; }

  async onOpen(): Promise<void> {
    this.render();
    // Re-render when notes change, so newly-pinned items / renamed
    // titles / color changes reflect promptly.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRender()));
    // 0.71.26: re-render when the user switches to a different
    // Stashpad tab so the pinned-notes panel can float that folder's
    // group to the top of the list.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf && leaf.view.getViewType() === STASHPAD_VIEW_TYPE) this.scheduleRender();
    }));
  }

  private renderTimer: number | null = null;
  private scheduleRender(): void {
    if (this.renderTimer != null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.containerEl.isConnected) this.render();
    }, 80);
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-panels-root");
    // 0.68.3: panel-independent actions row. Lives ABOVE the master
    // button bar and isn't tied to any panel — Search is the first
    // inhabitant; more global actions land here later. Full-width for
    // easy reachability; layout/grouping is provisional.
    const globals = root.createDiv({ cls: "stashpad-panels-globals" });
    const searchBtn = globals.createEl("button", { cls: "stashpad-panels-global-btn" });
    setIcon(searchBtn.createSpan({ cls: "stashpad-panels-global-btn-icon" }), "search");
    searchBtn.createSpan({ cls: "stashpad-panels-global-btn-text", text: "Search" });
    searchBtn.onclick = () => this.openSearchFromPanel();

    // 0.71.32: Folder Switcher — full-width global button just below
    // Search. Delegates to the plugin's openFolderPicker so the same
    // modal opens whether the user invokes it from the view header,
    // the command palette, or here.
    const folderBtn = globals.createEl("button", { cls: "stashpad-panels-global-btn" });
    setIcon(folderBtn.createSpan({ cls: "stashpad-panels-global-btn-icon" }), "folder-tree");
    folderBtn.createSpan({ cls: "stashpad-panels-global-btn-text", text: "Folder Switcher" });
    folderBtn.onclick = () => this.plugin.openFolderPicker();

    // 0.71.31: Log + Notifications share a row underneath Search —
    // they're sibling diagnostic shortcuts so they live side-by-side.
    const diagRow = globals.createDiv({ cls: "stashpad-panels-globals-row" });
    const logBtn = diagRow.createEl("button", { cls: "stashpad-panels-global-btn" });
    setIcon(logBtn.createSpan({ cls: "stashpad-panels-global-btn-icon" }), "scroll-text");
    logBtn.createSpan({ cls: "stashpad-panels-global-btn-text", text: "Log" });
    logBtn.onclick = () => this.openLogFromPanel();

    const notifBtn = diagRow.createEl("button", { cls: "stashpad-panels-global-btn" });
    setIcon(notifBtn.createSpan({ cls: "stashpad-panels-global-btn-icon" }), "bell");
    notifBtn.createSpan({ cls: "stashpad-panels-global-btn-text", text: "Notifications" });
    notifBtn.onclick = () => this.openNotificationsFromPanel();

    // 0.71.30: Completed-notes shortcut moved into the dedicated Tasks
    // panel below; no global button anymore.

    // Master button bar — one button per registered panel.
    const bar = root.createDiv({ cls: "stashpad-panels-bar" });
    for (const id of Object.keys(PANEL_REGISTRY) as PanelId[]) {
      const meta = PANEL_REGISTRY[id];
      const btn = bar.createEl("button", { cls: "stashpad-panels-bar-btn" });
      setIcon(btn.createSpan({ cls: "stashpad-panels-bar-btn-icon" }), meta.icon);
      btn.createSpan({ cls: "stashpad-panels-bar-btn-text", text: meta.label });
      if (this.activePanel === id) btn.addClass("is-active");
      btn.onclick = () => {
        if (this.activePanel === id) return;
        this.activePanel = id;
        this.render();
      };
    }
    const body = root.createDiv({ cls: "stashpad-panels-body" });
    if (this.activePanel === "pinned") this.renderPinnedPanel(body);
    else if (this.activePanel === "shared") this.renderSharedPanel(body);
    else if (this.activePanel === "tasks") this.renderTasksPanel(body);
  }

  // ---------- Pinned Notes panel ----------

  private renderPinnedPanel(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: "stashpad-panel-pinned" });

    // Home row — always first, before pinned items.
    const homeRow = list.createEl("button", { cls: "stashpad-pinned-row stashpad-pinned-home" });
    const hIcon = homeRow.createSpan({ cls: "stashpad-pinned-icon" });
    setIcon(hIcon, "home");
    homeRow.createSpan({ cls: "stashpad-pinned-label", text: "Home" });
    homeRow.onclick = () => this.openHomeFromPanel();

    const pins = this.plugin.settings.pinnedNotes ?? [];
    if (pins.length === 0) {
      const empty = list.createDiv({ cls: "stashpad-pinned-empty" });
      empty.setText("No pinned notes yet — right-click a note and choose “Pin to sidebar.”");
      return;
    }

    // 0.71.26: group pins by folder so the user can scan by Stashpad
    // instead of a single flat list. Groups are ordered by first
    // appearance in `pinnedNotes` (so manual reorders within a folder
    // still survive), EXCEPT the MRU Stashpad's folder is floated to
    // the top — switching tabs reorders the groups so the relevant
    // pins are always at the top.
    const groups = new Map<string, { pin: PinnedNoteRef; idx: number }[]>();
    pins.forEach((pin, idx) => {
      let bucket = groups.get(pin.folder);
      if (!bucket) { bucket = []; groups.set(pin.folder, bucket); }
      bucket.push({ pin, idx });
    });
    const mruFolder = (this.plugin.lastActiveStashpadLeaf?.view as any)?.noteFolder as string | undefined;
    const order = Array.from(groups.keys());
    if (mruFolder && groups.has(mruFolder)) {
      order.splice(order.indexOf(mruFolder), 1);
      order.unshift(mruFolder);
    }

    for (const folder of order) {
      const folderName = folder.split("/").pop() || folder;
      const header = list.createDiv({ cls: "stashpad-pinned-group-header" });
      if (folder === mruFolder) header.addClass("is-active-folder");
      header.createSpan({ cls: "stashpad-pinned-group-name", text: folderName });
      const bucket = groups.get(folder) ?? [];
      for (const { pin, idx } of bucket) this.renderPinnedRow(list, pin, idx);
    }
  }

  private renderPinnedRow(parent: HTMLElement, pin: PinnedNoteRef, idx: number): void {
    const file = this.findFileFor(pin);
    if (!file) return; // pin's target was deleted; silently skip
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as any;
    const title = this.titleFromFile(file);
    const color = typeof fm.color === "string" ? fm.color : null;
    const completed = fm.completed === true;
    const hasChildren = this.childrenOf(pin.folder, pin.id).length > 0;
    const isExpanded = this.expanded.has(`${pin.folder}|${pin.id}`);

    const row = parent.createDiv({ cls: "stashpad-pinned-row" });
    if (color) row.addClass("has-color");
    if (completed) row.addClass("is-completed");
    // 0.68.1: HTML5 drag-reorder. Set draggable on the row + bind
    // dragstart / dragover / drop so the user can rearrange pins.
    row.draggable = true;
    row.dataset.pinIdx = String(idx);
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", String(idx));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      // Visual indicator: top or bottom half decides before/after.
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.toggleClass("drop-before", before);
      row.toggleClass("drop-after", !before);
    });
    row.addEventListener("dragleave", () => {
      row.removeClass("drop-before");
      row.removeClass("drop-after");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.removeClass("drop-before");
      row.removeClass("drop-after");
      const fromIdx = parseInt(e.dataTransfer?.getData("text/plain") ?? "", 10);
      if (!Number.isFinite(fromIdx) || fromIdx === idx) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      void this.reorderPin(fromIdx, before ? idx : idx + 1);
    });

    // Expand toggle on the LEFT — caret-right when collapsed, caret-down
    // when open. Disabled (invisible spacer) when there are no children.
    const toggle = row.createSpan({ cls: "stashpad-pinned-toggle" });
    if (hasChildren) {
      setIcon(toggle, isExpanded ? "chevron-down" : "chevron-right");
      toggle.onclick = (e) => {
        e.stopPropagation();
        const k = `${pin.folder}|${pin.id}`;
        if (this.expanded.has(k)) this.expanded.delete(k);
        else this.expanded.add(k);
        this.render();
      };
    }
    const icon = row.createSpan({ cls: "stashpad-pinned-icon" });
    // 0.68.1: parent notes get a different icon (folder-tree) than
    // childless ones (file-text) so the user can scan the list and
    // tell at a glance which entries have substructure.
    setIcon(icon, hasChildren ? "folder-tree" : "file-text");
    if (color) icon.style.color = color;
    const label = row.createSpan({ cls: "stashpad-pinned-label", text: title });
    label.onclick = () => this.openPinFromPanel(pin);
    // Folder badge — small subtitle so the user knows which Stashpad
    // a pinned note lives in.
    const folderName = pin.folder.split("/").pop() || pin.folder;
    row.createSpan({ cls: "stashpad-pinned-folder", text: folderName });
    // Context menu: Unpin / move within list (future).
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((it: any) => it.setTitle("Unpin from sidebar").setIcon("pin-off").onClick(() => {
        void this.plugin.unpinNote(pin);
      }));
      menu.showAtMouseEvent(e);
    };

    if (hasChildren && isExpanded) {
      const childrenBox = parent.createDiv({ cls: "stashpad-pinned-children" });
      this.renderPinnedSubtree(childrenBox, pin.folder, pin.id, 1);
    }
  }

  /** Move a pin from one index to another, updating settings + re-rendering. */
  private async reorderPin(fromIdx: number, toIdx: number): Promise<void> {
    const list = (this.plugin.settings.pinnedNotes ?? []).slice();
    if (fromIdx < 0 || fromIdx >= list.length) return;
    const [moved] = list.splice(fromIdx, 1);
    const adjusted = toIdx > fromIdx ? toIdx - 1 : toIdx;
    list.splice(Math.max(0, Math.min(adjusted, list.length)), 0, moved);
    this.plugin.settings.pinnedNotes = list;
    await this.plugin.saveSettings();
    this.render();
  }

  /** Recursively render a pin's subtree as an indented outline. */
  private renderPinnedSubtree(parent: HTMLElement, folder: string, parentId: StashpadId, depth: number): void {
    const children = this.childrenOf(folder, parentId);
    for (const child of children) {
      const fm = (this.app.metadataCache.getFileCache(child)?.frontmatter ?? {}) as any;
      const childId = typeof fm.id === "string" ? fm.id : null;
      if (!childId) continue;
      const color = typeof fm.color === "string" ? fm.color : null;
      const completed = fm.completed === true;
      const hasGrandkids = this.childrenOf(folder, childId).length > 0;
      const isExpanded = this.expanded.has(`${folder}|${childId}`);
      const row = parent.createDiv({ cls: "stashpad-pinned-subrow" });
      if (completed) row.addClass("is-completed");
      row.style.paddingLeft = `${depth * 16}px`;
      const toggle = row.createSpan({ cls: "stashpad-pinned-toggle" });
      if (hasGrandkids) {
        setIcon(toggle, isExpanded ? "chevron-down" : "chevron-right");
        toggle.onclick = (e) => {
          e.stopPropagation();
          const k = `${folder}|${childId}`;
          if (this.expanded.has(k)) this.expanded.delete(k);
          else this.expanded.add(k);
          this.render();
        };
      }
      const icon = row.createSpan({ cls: "stashpad-pinned-icon" });
      setIcon(icon, "file-text");
      if (color) icon.style.color = color;
      const label = row.createSpan({ cls: "stashpad-pinned-label", text: this.titleFromFile(child) });
      label.onclick = () => this.openPinFromPanel({ folder, id: childId });
      if (hasGrandkids && isExpanded) {
        this.renderPinnedSubtree(parent, folder, childId, depth + 1);
      }
    }
  }

  // ---------- Helpers ----------

  /** Find the file backing a {folder, id} reference. Walks the
   *  metadataCache once per call — cheap on typical vault sizes; can
   *  cache if it ever shows up in profiles. */
  private findFileFor(pin: PinnedNoteRef): TFile | null {
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== pin.folder) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      if (fm?.id === pin.id) return f;
    }
    return null;
  }

  /** Children of a given id within a folder — files whose
   *  frontmatter.parent matches. */
  private childrenOf(folder: string, parentId: StashpadId): TFile[] {
    const out: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== folder) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      if (!fm || typeof fm.id !== "string") continue;
      const p = fm.parent;
      if (p === parentId || (parentId === ROOT_ID && (p == null || p === ROOT_ID))) {
        // Skip the home note itself when listing children of root.
        if (fm.id === ROOT_ID) continue;
        out.push(f);
      }
    }
    // Sort by created (created frontmatter ascending), fallback to filename.
    out.sort((a, b) => {
      const fmA = this.app.metadataCache.getFileCache(a)?.frontmatter as any;
      const fmB = this.app.metadataCache.getFileCache(b)?.frontmatter as any;
      const ca = (fmA?.created as string) ?? "";
      const cb = (fmB?.created as string) ?? "";
      return ca.localeCompare(cb);
    });
    return out;
  }

  /** Display title from a TFile — strip the trailing "-id" suffix and
   *  un-hyphenate. */
  private titleFromFile(file: TFile): string {
    return file.basename
      .replace(/-[a-z0-9]{4,12}$/, "")
      .replace(/-/g, " ")
      .trim() || file.basename;
  }

  // ---------- Actions ----------

  /** Search button → open the search modal on the MRU Stashpad view
   *  (set by the plugin's active-leaf-change listener). Falls back to
   *  any open Stashpad leaf, then to activating the default view. */
  private async openSearchFromPanel(): Promise<void> {
    const target = await this.resolveTargetStashpad();
    if (target && typeof (target as any).openSearchModal === "function") {
      (target as any).openSearchModal();
    }
  }

  /** 0.71.25: Log button → open the plugin-wide log.jsonl in LogModal.
   *  Folder-independent (log captures actions across every Stashpad). */
  private async openLogFromPanel(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const path = this.plugin.pluginPrivatePath("log.jsonl");
    if (!(await adapter.exists(path))) {
      new Notice("No log yet — make some changes first.");
      return;
    }
    const data = await adapter.read(path);
    const { LogModal } = await import("./modals");
    new LogModal(this.app, data, path).open();
  }

  /** 0.71.25: Notifications button → open the in-memory notification
   *  history modal. Delegates to the existing command so the wiring
   *  (author resolver, log-open callback) stays in one place. */
  private openNotificationsFromPanel(): void {
    (this.app as any).commands?.executeCommandById?.("stashpad:stashpad-open-notification-history");
  }

  /** Home button → navigate the MRU Stashpad to its root. */
  private async openHomeFromPanel(): Promise<void> {
    const target = await this.resolveTargetStashpad();
    if (target && typeof (target as any).navigateTo === "function") {
      (target as any).navigateTo(ROOT_ID);
    }
  }

  /** Click on a pin → ALWAYS open in a new tab on the pin's folder,
   *  then navigate to the pinned note. 0.68.1: was reveal-or-open;
   *  user wanted new-tab consistently so the existing tab they were
   *  on doesn't get repurposed. */
  private async openPinFromPanel(pin: PinnedNoteRef): Promise<void> {
    await this.plugin.activateViewForFolder(pin.folder);
    // After activate the most-recently-active stashpad should be the
    // new tab. Use the plugin's MRU pointer first; fall back to the
    // active leaf.
    const target = this.plugin.lastActiveStashpadLeaf?.view as any
      ?? this.findActiveStashpad();
    if (target && typeof target.navigateTo === "function") {
      target.navigateTo(pin.id);
    }
  }

  /** Resolve a Stashpad view to target for sidebar actions:
   *    1. The plugin's MRU pointer (set on active-leaf-change).
   *    2. The currently-active leaf if it IS a Stashpad.
   *    3. Any open Stashpad leaf — reveal it.
   *    4. Activate the default Stashpad. */
  private async resolveTargetStashpad(): Promise<any | null> {
    const mru = this.plugin.lastActiveStashpadLeaf;
    if (mru && mru.view.getViewType() === STASHPAD_VIEW_TYPE) {
      this.app.workspace.revealLeaf(mru);
      return mru.view;
    }
    const active = this.findActiveStashpad();
    if (active) return active;
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return leaves[0].view;
    }
    await this.plugin.activateView({ reveal: true });
    return this.findActiveStashpad();
  }

  private findActiveStashpad(): any | null {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf && leaf.view.getViewType() === STASHPAD_VIEW_TYPE) return leaf.view;
    return null;
  }

  // ---------- Shared panel (0.70.0) ----------

  /** Active author-filter id. "all" = no filter; "mine" = author is me;
   *  "others" = author is not me; or a specific authorId string. */
  private sharedAuthorFilter: string = "all";
  /** Toggle: only show notes that have at least one contributor.
   *  Off by default; combined with the author filter via AND. */
  private sharedContribOnly: boolean = false;

  private renderSharedPanel(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: "stashpad-panel-shared" });
    const myId = (this.plugin.settings.authorId ?? "").trim();
    if (!myId) {
      list.createDiv({ cls: "stashpad-shared-empty" })
        .setText("Set an author name in Stashpad settings to populate Shared.");
      return;
    }
    const shared = this.collectSharedNotes(myId);
    // Distinct author ids present in the result set — fed to the
    // author-filter dropdown so users can narrow to a specific person.
    const authorSet = new Map<string, string>(); // id → display name
    for (const s of shared) {
      const aid = s.authorId;
      if (aid && !authorSet.has(aid)) authorSet.set(aid, s.authorDisplay || aid);
    }

    // Filter chips row.
    const filtersRow = list.createDiv({ cls: "stashpad-shared-filters" });
    const mkChip = (label: string, active: boolean, onClick: () => void) => {
      const c = filtersRow.createEl("button", { cls: "stashpad-shared-chip", text: label });
      if (active) c.addClass("is-active");
      c.onclick = onClick;
      return c;
    };
    mkChip("All", this.sharedAuthorFilter === "all", () => {
      this.sharedAuthorFilter = "all";
      this.render();
    });
    mkChip("Mine", this.sharedAuthorFilter === "mine", () => {
      this.sharedAuthorFilter = "mine";
      this.render();
    });
    mkChip("Others", this.sharedAuthorFilter === "others", () => {
      this.sharedAuthorFilter = "others";
      this.render();
    });
    // Author-specific filter: a small dropdown when 2+ distinct authors
    // appear in the result set. Otherwise the All/Mine/Others chips
    // are sufficient.
    if (authorSet.size > 1) {
      const sel = filtersRow.createEl("select", { cls: "stashpad-shared-author-select" });
      const optAll = sel.createEl("option", { text: "Any author" });
      optAll.value = "__any__";
      for (const [id, name] of authorSet) {
        const o = sel.createEl("option", { text: name });
        o.value = id;
      }
      const current = ["all", "mine", "others"].includes(this.sharedAuthorFilter)
        ? "__any__"
        : this.sharedAuthorFilter;
      sel.value = current;
      sel.onchange = () => {
        const v = sel.value;
        if (v === "__any__") this.sharedAuthorFilter = "all";
        else this.sharedAuthorFilter = v;
        this.render();
      };
    }
    // Toggle: "Has contributors" — when on, only notes with >=1 contrib
    // appear. Off = no filter on contributor count.
    const contribBtn = filtersRow.createEl("button", {
      cls: "stashpad-shared-chip",
      text: "Has contributors",
    });
    if (this.sharedContribOnly) contribBtn.addClass("is-active");
    contribBtn.onclick = () => {
      this.sharedContribOnly = !this.sharedContribOnly;
      this.render();
    };

    // Apply filters.
    const filtered = shared.filter((s) => {
      if (this.sharedContribOnly && s.contributorCount === 0) return false;
      switch (this.sharedAuthorFilter) {
        case "all": return true;
        case "mine": return s.authorId === myId;
        case "others": return s.authorId !== myId;
        default: return s.authorId === this.sharedAuthorFilter;
      }
    });

    if (filtered.length === 0) {
      list.createDiv({ cls: "stashpad-shared-empty" })
        .setText("No shared notes match the current filters.");
      return;
    }

    // Render rows. Reuse the pinned-row visual styling — color icon +
    // title + folder badge. Click navigates to that note in the MRU
    // Stashpad tab (or activates one).
    for (const s of filtered) {
      const row = list.createDiv({ cls: "stashpad-pinned-row stashpad-shared-row" });
      const icon = row.createSpan({ cls: "stashpad-pinned-icon" });
      setIcon(icon, "users");
      if (s.color) icon.style.color = s.color;
      const label = row.createSpan({ cls: "stashpad-pinned-label", text: s.title });
      label.onclick = () => this.openSharedFromPanel(s.folder, s.id);
      const folderName = s.folder.split("/").pop() || s.folder;
      row.createSpan({ cls: "stashpad-pinned-folder", text: folderName });
      // Author byline beneath the title (shown when not "Mine" view).
      if (s.authorDisplay) {
        const meta = row.createSpan({ cls: "stashpad-shared-meta" });
        meta.setText(
          s.authorId === myId
            ? `you · ${s.contributorCount} contributor${s.contributorCount === 1 ? "" : "s"}`
            : `by ${s.authorDisplay}${s.contributorCount > 0 ? ` · ${s.contributorCount} contributor${s.contributorCount === 1 ? "" : "s"}` : ""}`,
        );
      }
    }
  }

  /** Walk every searchable Stashpad folder and collect notes that
   *  match the "shared" criteria:
   *    - The note has at least one contributor in frontmatter, OR
   *    - The user authored the home (root) note of the folder AND the
   *      note in question is NOT authored by the user.
   *  The two conditions are OR'd so the panel surfaces both
   *  "things I started that others worked on" and "things others
   *  added to a folder I own." */
  private collectSharedNotes(myId: string): Array<{
    file: TFile;
    folder: string;
    id: string;
    title: string;
    color: string | null;
    authorId: string | null;
    authorDisplay: string;
    contributorCount: number;
  }> {
    const folders = this.plugin.discoverStashpadFolders();
    const folderSet = new Set(folders);
    // First pass: find the home-note author per folder (the root note
    // is the one whose `id` frontmatter is ROOT_ID).
    const homeAuthorByFolder = new Map<string, string | null>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folderSet.has(dir)) continue;
      const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as any;
      if (fm.id !== ROOT_ID) continue;
      homeAuthorByFolder.set(dir, this.extractAuthorId(fm.author));
    }

    const out: Array<{
      file: TFile;
      folder: string;
      id: string;
      title: string;
      color: string | null;
      authorId: string | null;
      authorDisplay: string;
      contributorCount: number;
    }> = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folderSet.has(dir)) continue;
      // Skip _authors subfolder bookkeeping files.
      if (dir.endsWith("/_authors") || f.path.includes("/_authors/")) continue;
      const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as any;
      if (typeof fm.id !== "string") continue;
      // Skip the home note itself — it surfaces elsewhere via Home row.
      if (fm.id === ROOT_ID) continue;
      const authorId = this.extractAuthorId(fm.author);
      const contributors: string[] = Array.isArray(fm.contributors)
        ? fm.contributors.filter((c: any) => typeof c === "string")
        : [];
      const homeAuthor = homeAuthorByFolder.get(dir) ?? null;
      const hasContributors = contributors.length > 0;
      const ownsFolder = homeAuthor === myId;
      const someoneElseWroteIt = authorId !== null && authorId !== myId;
      const isShared = hasContributors || (ownsFolder && someoneElseWroteIt);
      if (!isShared) continue;
      const title = this.titleFromFile(f);
      const color = typeof fm.color === "string" ? fm.color : null;
      out.push({
        file: f,
        folder: dir,
        id: fm.id,
        title,
        color,
        authorId,
        authorDisplay: this.extractAuthorDisplay(fm.author) || (authorId ?? ""),
        contributorCount: contributors.length,
      });
    }
    // Newest first by frontmatter `modified` (fall back to `created`).
    out.sort((a, b) => {
      const fmA = (this.app.metadataCache.getFileCache(a.file)?.frontmatter ?? {}) as any;
      const fmB = (this.app.metadataCache.getFileCache(b.file)?.frontmatter ?? {}) as any;
      const tA = (fmA.modified ?? fmA.created ?? "") as string;
      const tB = (fmB.modified ?? fmB.created ?? "") as string;
      return tB.localeCompare(tA);
    });
    return out;
  }

  /** Extract the author ID from a frontmatter author value (wikilink or
   *  plain string). Mirrors the regex used in view.ts:3366. */
  private extractAuthorId(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const m = raw.match(/-([a-z0-9]{4,12})(?:\.md)?(?:\||\]\])/i);
    return m ? m[1] : null;
  }

  /** Extract the display name portion of a `[[_authors/<name>-<id>]]`
   *  or `[[_authors/<name>-<id>|alias]]` reference. */
  private extractAuthorDisplay(raw: unknown): string {
    if (typeof raw !== "string") return "";
    // If aliased ([[...|alias]]), use the alias.
    const aliased = raw.match(/\|([^\]]+)\]\]/);
    if (aliased) return aliased[1].trim();
    // Otherwise, strip wikilink syntax + path + trailing id.
    const m = raw.match(/_authors\/([^\]|]+)-[a-z0-9]{4,12}/i);
    if (m) return m[1].replace(/[-_]/g, " ").trim();
    return "";
  }

  /** Navigate to a shared note: open the folder (in a new tab if it's
   *  not the active one) and navigate to the note. */
  private async openSharedFromPanel(folder: string, id: StashpadId): Promise<void> {
    await this.plugin.activateViewForFolder(folder);
    const target = this.plugin.lastActiveStashpadLeaf?.view as any
      ?? this.findActiveStashpad();
    if (target && typeof target.navigateTo === "function") {
      target.navigateTo(id);
    }
  }

  // ---------- Tasks panel (0.71.30) ----------

  /** Scan every Stashpad folder for notes whose frontmatter looks like
   *  a task: `completed: true` OR any `due` key (date string parsed
   *  lazily). Result is grouped by folder, with the MRU folder floated
   *  to the top — same convention as the Pinned panel. */
  private renderTasksPanel(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: "stashpad-panel-tasks" });
    const tasks = this.collectTasks();
    if (tasks.length === 0) {
      list.createDiv({ cls: "stashpad-tasks-empty" })
        .setText("No tasks yet — add `completed: true` or a `due:` date to any note's frontmatter.");
      return;
    }
    // Group by folder, MRU-first.
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) {
      let bucket = groups.get(t.folder);
      if (!bucket) { bucket = []; groups.set(t.folder, bucket); }
      bucket.push(t);
    }
    const mruFolder = (this.plugin.lastActiveStashpadLeaf?.view as any)?.noteFolder as string | undefined;
    const order = Array.from(groups.keys());
    if (mruFolder && groups.has(mruFolder)) {
      order.splice(order.indexOf(mruFolder), 1);
      order.unshift(mruFolder);
    }
    for (const folder of order) {
      const folderName = folder.split("/").pop() || folder;
      const header = list.createDiv({ cls: "stashpad-pinned-group-header" });
      if (folder === mruFolder) header.addClass("is-active-folder");
      header.createSpan({ cls: "stashpad-pinned-group-name", text: folderName });
      const bucket = (groups.get(folder) ?? []).slice().sort(this.compareTasks);
      for (const t of bucket) this.renderTaskRow(list, t);
    }
  }

  /** Order tasks within a group: incomplete first (by due-date asc,
   *  undated last), completed last. */
  private compareTasks = (
    a: { completed: boolean; due: number | null },
    b: { completed: boolean; due: number | null },
  ): number => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.due == null && b.due == null) return 0;
    if (a.due == null) return 1;
    if (b.due == null) return -1;
    return a.due - b.due;
  };

  private renderTaskRow(
    parent: HTMLElement,
    t: { file: TFile; folder: string; id: string; title: string; completed: boolean; due: number | null; dueRaw: string | null; color: string | null },
  ): void {
    const row = parent.createDiv({ cls: "stashpad-pinned-row stashpad-task-row" });
    if (t.color) row.addClass("has-color");
    if (t.completed) row.addClass("is-completed");
    // Status icon (checkmark = done, circle = open).
    const icon = row.createSpan({ cls: "stashpad-pinned-icon" });
    setIcon(icon, t.completed ? "check-circle-2" : "circle");
    if (t.color) icon.style.color = t.color;
    const label = row.createSpan({ cls: "stashpad-pinned-label", text: t.title });
    label.onclick = () => this.openTaskFromPanel(t.folder, t.id);
    if (t.dueRaw) {
      const due = row.createSpan({ cls: "stashpad-task-due", text: t.dueRaw });
      if (t.due != null && t.due < Date.now() && !t.completed) due.addClass("is-overdue");
    }
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((it: any) => it.setTitle("Open").setIcon("arrow-right").onClick(() => {
        void this.openTaskFromPanel(t.folder, t.id);
      }));
      menu.showAtMouseEvent(e);
    };
  }

  private async openTaskFromPanel(folder: string, id: StashpadId): Promise<void> {
    await this.plugin.activateViewForFolder(folder);
    const target = this.plugin.lastActiveStashpadLeaf?.view as any
      ?? this.findActiveStashpad();
    if (target && typeof target.navigateTo === "function") target.navigateTo(id);
  }

  private collectTasks(): Array<{
    file: TFile;
    folder: string;
    id: string;
    title: string;
    completed: boolean;
    due: number | null;
    dueRaw: string | null;
    color: string | null;
  }> {
    const folders = this.plugin.discoverStashpadFolders();
    const folderSet = new Set(folders);
    const out: Array<{
      file: TFile;
      folder: string;
      id: string;
      title: string;
      completed: boolean;
      due: number | null;
      dueRaw: string | null;
      color: string | null;
    }> = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folderSet.has(dir)) continue;
      const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as any;
      const id = typeof fm.id === "string" ? fm.id : null;
      if (!id || id === ROOT_ID) continue;
      const completed = fm.completed === true;
      const dueRaw = typeof fm.due === "string" || typeof fm.due === "number" ? String(fm.due) : null;
      // `due` can be either a moment-parseable date string or a raw
      // ISO timestamp number. Try Date.parse — if NaN, keep dueRaw for
      // display but leave due=null so sort doesn't mis-order it.
      let due: number | null = null;
      if (dueRaw) {
        const t = Date.parse(dueRaw);
        if (!Number.isNaN(t)) due = t;
      }
      if (!completed && due == null && !dueRaw) continue;
      out.push({
        file: f,
        folder: dir,
        id,
        title: this.titleFromFile(f),
        completed,
        due,
        dueRaw,
        color: typeof fm.color === "string" ? fm.color : null,
      });
    }
    return out;
  }
}

/** Open the Stashpad panels view in the left sidebar — reuses an
 *  existing one if present, otherwise creates a new leaf. 0.68.0. */
export async function openStashpadPanelsView(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(STASHPAD_PANELS_VIEW_TYPE);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = app.workspace.getLeftLeaf(false);
  if (!leaf) {
    new Notice("Stashpad: couldn't open the panels view.");
    return;
  }
  await leaf.setViewState({ type: STASHPAD_PANELS_VIEW_TYPE, active: true });
  app.workspace.revealLeaf(leaf);
}
