import { App, ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import {
  ROOT_ID,
  STASHPAD_PANELS_VIEW_TYPE,
  STASHPAD_VIEW_TYPE,
  fmHasTag,
  parseAssignees,
  parseAuthorRef,
  type PinnedNoteRef,
  type StashpadId,
} from "./types";
import { formatDateOnly, formatTimeOnly } from "./format";

/** 0.74.3: render a child-count badge into `host` (replaces the old
 *  caret expander in the Pinned + detail panels). Collapsed shows a
 *  muted badge; expanded adds .is-expanded for the accent tint. Count
 *  caps at "99+" so triple-digit subtrees stay compact. Shared by
 *  StashpadPanelsView + StashpadDetailView so the two outline UIs
 *  stay visually identical. */
export function renderCountBadge(host: HTMLElement, count: number, expanded: boolean): void {
  const badge = host.createSpan({ cls: "stashpad-count-badge" });
  if (expanded) badge.addClass("is-expanded");
  badge.setText(count > 99 ? "99+" : String(count));
}

/** 0.76.2: one task row in the Tasks panel. */
interface TaskItem {
  file: TFile;
  folder: string;
  id: string;
  title: string;
  task: boolean;
  completed: boolean;
  due: number | null;
  dueRaw: string | null;
  color: string | null;
  /** 0.78.2: assignment. assignedTo = people the task is assigned to;
   *  assignedBy = who delegated it (or null). */
  assignedTo: Array<{ id: string; name: string }>;
  assignedBy: { id: string; name: string } | null;
}

/** Panel ids registered with the StashpadPanelsView. Future panels
 *  (e.g. recent activity, search results, attachments) add to this
 *  union; the master-panel button bar surfaces one button per id. */
export type PanelId = "pinned" | "shared" | "tasks";

/** Per-panel metadata used by the master button bar. */
export const PANEL_REGISTRY: Record<PanelId, { label: string; icon: string }> = {
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
  /** 0.76.4: active sub-filter within the Tasks panel. "all" stacks
   *  every section; the others show just that bucket. Per-session. */
  private taskFilter: "all" | "overdue" | "today" | "upcoming" | "nodate" | "completed" = "all";
  /** 0.78.2: assignment sub-filter, combined with taskFilter via AND.
   *  Fixed buckets ("all"/"mine"/"others"/"byme"/"unassigned") or a
   *  per-person filter encoded as "person:<authorId>" (0.78.3). */
  private taskAssignFilter: string = "all";
  /** 0.88.1: folder sub-filter for the Tasks panel, AND-combined with the
   *  status + assignment filters. "all" = every Stashpad folder, else a
   *  specific folder path. */
  private taskFolderFilter: string = "all";
  /** 0.73.11: programmatic panel switch. Called by the per-panel
   *  command-palette entries so the sidebar lands on the right tab
   *  when invoked from the keyboard. */
  setActivePanel(id: PanelId): void {
    this.activePanel = id;
    if (this.containerEl.isConnected) this.render();
  }
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

  private openPinnedOptionsMenu(e: MouseEvent): void {
    const cur = this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order";
    const menu = new Menu();
    menu.addItem((i: any) => i.setTitle("Sort by pin order").setChecked(cur === "pin-order")
      .onClick(() => void this.setPinnedGrouping("pin-order")));
    menu.addItem((i: any) => i.setTitle("Group by folder").setChecked(cur === "folder")
      .onClick(() => void this.setPinnedGrouping("folder")));
    menu.showAtMouseEvent(e);
  }

  private async setPinnedGrouping(mode: "pin-order" | "folder"): Promise<void> {
    if ((this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order") === mode) return;
    this.plugin.settings.folderPanelPinnedGrouping = mode;
    await this.plugin.saveSettings();
    this.render();
  }

  private renderPinnedPanel(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: "stashpad-panel-pinned" });
    // Flat mode wants the per-row folder badge (no headers for context); grouped
    // mode hides it (the group header already names the folder).
    if ((this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order") !== "folder") list.addClass("is-flat");

    // Home row + view-options button on one line: Home tucks to its content
    // width, the options button (sort by pin order / group by folder) sits to
    // its right and fills the rest of the row.
    const headRow = list.createDiv({ cls: "stashpad-pinned-headrow" });
    const homeRow = headRow.createEl("button", { cls: "stashpad-pinned-row stashpad-pinned-home" });
    const hIcon = homeRow.createSpan({ cls: "stashpad-pinned-icon" });
    setIcon(hIcon, "home");
    homeRow.createSpan({ cls: "stashpad-pinned-label", text: "Home" });
    homeRow.onclick = () => this.openHomeFromPanel();
    const optsBtn = headRow.createEl("button", { cls: "stashpad-folderpanel-iconbtn stashpad-pinned-opts" });
    setIcon(optsBtn, "list");
    optsBtn.setAttr("aria-label", "Pinned view options");
    optsBtn.onclick = (e) => { e.stopPropagation(); this.openPinnedOptionsMenu(e); };

    // 0.86.3: pins now come from note frontmatter (synced), ordered by pinnedAt.
    const pins = this.plugin.listPinnedNotes();
    if (pins.length === 0) {
      const empty = list.createDiv({ cls: "stashpad-pinned-empty" });
      empty.setText("No pinned notes yet — right-click a note and choose “Pin to sidebar.”");
      return;
    }

    // 0.95.2: "Sort by pin order" = flat list; "Group by folder" = the original
    // per-Stashpad grouping (shared setting with the folder panel's Pinned list).
    const grouping = this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order";
    if (grouping !== "folder") {
      pins.forEach((pin, idx) => this.renderPinnedRow(list, pin, idx));
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
    const childCount = this.childrenOf(pin.folder, pin.id).length;
    const hasChildren = childCount > 0;
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

    // 0.74.3: child-count badge replaces the caret. Collapsed = muted
    // badge with the count; expanded = accent-tinted badge (children
    // are listed below). Childless rows keep an empty slot so titles
    // stay aligned. Click toggles expansion.
    const toggle = row.createSpan({ cls: "stashpad-pinned-toggle" });
    if (hasChildren) {
      renderCountBadge(toggle, childCount, isExpanded);
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

  /** Move a pin to a new position by rewriting its `pinnedAt` to fall between
   *  the items it lands between (0.86.3 — order is the synced pinnedAt key). */
  private async reorderPin(fromIdx: number, toIdx: number): Promise<void> {
    const list = this.plugin.listPinnedNotes();
    if (fromIdx < 0 || fromIdx >= list.length) return;
    const moved = list[fromIdx];
    const without = list.filter((_, i) => i !== fromIdx);
    const insertAt = Math.max(0, Math.min(toIdx > fromIdx ? toIdx - 1 : toIdx, without.length));
    const prev = without[insertAt - 1];
    const next = without[insertAt];
    let at: number;
    if (!prev && !next) at = Date.now();
    else if (!prev) at = next.pinnedAt - 1000;
    else if (!next) at = prev.pinnedAt + 1000;
    else at = (prev.pinnedAt + next.pinnedAt) / 2;
    try {
      await this.app.fileManager.processFrontMatter(moved.file, (fm: any) => { fm.pinnedAt = at; });
    } catch (e) { console.warn("[Stashpad] pin reorder failed", e); }
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
      const grandkidCount = this.childrenOf(folder, childId).length;
      const hasGrandkids = grandkidCount > 0;
      const isExpanded = this.expanded.has(`${folder}|${childId}`);
      const row = parent.createDiv({ cls: "stashpad-pinned-subrow" });
      if (completed) row.addClass("is-completed");
      row.style.paddingLeft = `${depth * 16}px`;
      const toggle = row.createSpan({ cls: "stashpad-pinned-toggle" });
      if (hasGrandkids) {
        renderCountBadge(toggle, grandkidCount, isExpanded);
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

  /** Click on a pin → REUSE an existing tab on the pin's folder if there is
   *  one (deferred included), else open a new tab; then navigate to the note.
   *  0.99.2: unified with the folder-panel pins + file reveals via
   *  revealNoteByRef (reverses 0.68.1's always-new-tab, per user request). */
  private async openPinFromPanel(pin: PinnedNoteRef): Promise<void> {
    await this.plugin.revealNoteByRef(pin.folder, pin.id);
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
    await this.plugin.revealNoteByRef(folder, id); // reuse-or-open, unified
  }

  // ---------- Tasks panel (0.71.30) ----------

  /** 0.76.2: scan every Stashpad folder for tasks and bucket them by
   *  due-window status: Overdue / Due today / Upcoming / No date /
   *  Completed. Within each section, sort by due-date ascending
   *  (undated by title). Each row carries a folder chip since tasks
   *  span folders now (v1 grouped by folder; v2 groups by status). */
  private renderTasksPanel(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: "stashpad-panel-tasks" });
    const allTasks = this.collectTasks();
    if (allTasks.length === 0) {
      list.createDiv({ cls: "stashpad-tasks-empty" })
        .setText("No tasks yet — press H on a note to mark it a task, or D to give it a due date.");
      return;
    }

    // 0.78.2: assignment filter (AND-combined with the status filter
    // below). "me" = the local author id.
    const meId = (this.plugin.settings.authorId ?? "").trim();
    const isMine = (t: TaskItem) => !!meId && t.assignedTo.some((a) => a.id === meId);
    const assignMatches = (t: TaskItem): boolean => {
      const f = this.taskAssignFilter;
      if (f.startsWith("person:")) {
        const pid = f.slice("person:".length);
        return t.assignedTo.some((a) => a.id === pid);
      }
      switch (f) {
        case "mine": return isMine(t);
        case "others": return t.assignedTo.length > 0 && !isMine(t);
        case "byme": return !!meId && t.assignedBy?.id === meId;
        case "unassigned": return t.assignedTo.length === 0;
        default: return true;
      }
    };
    // Distinct people across all tasks (assignees + assigners), for the
    // per-person filter options. Sorted by name; "me" excluded from the
    // per-person list since "Assigned to me" already covers it.
    const people = new Map<string, string>();
    for (const t of allTasks) {
      for (const a of t.assignedTo) if (a.id !== meId) people.set(a.id, a.name);
      if (t.assignedBy && t.assignedBy.id !== meId) people.set(t.assignedBy.id, t.assignedBy.name);
    }
    const personOpts = [...people.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Dropdown chip for the assignment filter.
    const assignBar = list.createDiv({ cls: "stashpad-task-assign-bar" });
    assignBar.createSpan({ cls: "stashpad-task-assign-label", text: "Assignment" });
    const sel = assignBar.createEl("select", { cls: "stashpad-task-assign-select" });
    const labelFor = (val: string): string => {
      const fixed: Record<string, string> = {
        all: "Everyone", mine: "Assigned to me", others: "Assigned to others",
        byme: "Assigned by me", unassigned: "Unassigned",
      };
      if (val.startsWith("person:")) return people.get(val.slice(7)) ?? "Person";
      return fixed[val] ?? val;
    };
    const addOpt = (val: string): void => {
      const o = sel.createEl("option", { text: labelFor(val), value: val });
      if (this.taskAssignFilter === val) o.selected = true;
    };
    for (const v of ["all", "mine", "others", "byme", "unassigned"]) addOpt(v);
    if (personOpts.length > 0) {
      const grp = sel.createEl("optgroup");
      grp.setAttr("label", "By person");
      for (const p of personOpts) {
        const o = grp.createEl("option", { text: p.name, value: `person:${p.id}` });
        if (this.taskAssignFilter === `person:${p.id}`) o.selected = true;
      }
    }
    sel.onchange = () => { this.taskAssignFilter = sel.value; this.render(); };

    // 0.88.1: Folder filter dropdown (AND-combined). Distinct folders across
    // all tasks; "all" shows every folder. Reset to "all" if the previously
    // selected folder no longer has any tasks.
    const folders = [...new Set(allTasks.map((t) => t.folder))].sort((a, b) => a.localeCompare(b));
    if (this.taskFolderFilter !== "all" && !folders.includes(this.taskFolderFilter)) this.taskFolderFilter = "all";
    const folderBar = list.createDiv({ cls: "stashpad-task-assign-bar" });
    folderBar.createSpan({ cls: "stashpad-task-assign-label", text: "Folder" });
    const fsel = folderBar.createEl("select", { cls: "stashpad-task-assign-select" });
    const allOpt = fsel.createEl("option", { text: "All folders", value: "all" });
    if (this.taskFolderFilter === "all") allOpt.selected = true;
    for (const f of folders) {
      const o = fsel.createEl("option", { text: f.split("/").pop() || f, value: f });
      if (this.taskFolderFilter === f) o.selected = true;
    }
    fsel.onchange = () => { this.taskFolderFilter = fsel.value; this.render(); };
    const folderMatches = (t: TaskItem): boolean => this.taskFolderFilter === "all" || t.folder === this.taskFolderFilter;

    const tasks = allTasks.filter((t) => assignMatches(t) && folderMatches(t));
    if (tasks.length === 0) {
      list.createDiv({ cls: "stashpad-tasks-empty" })
        .setText(`No tasks match the current filters.`);
      return;
    }

    // Local day boundaries (so "today" is calendar-day, not 24h).
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const startTodayMs = startToday.getTime();
    const endTodayMs = startTodayMs + 24 * 60 * 60 * 1000;

    type Section = "overdue" | "today" | "upcoming" | "nodate" | "completed";
    const buckets: Record<Section, TaskItem[]> = {
      overdue: [], today: [], upcoming: [], nodate: [], completed: [],
    };
    for (const t of tasks) {
      if (t.completed) { buckets.completed.push(t); continue; }
      if (t.due == null) { buckets.nodate.push(t); continue; }
      if (t.due < startTodayMs) buckets.overdue.push(t);
      else if (t.due < endTodayMs) buckets.today.push(t);
      else buckets.upcoming.push(t);
    }

    const byDue = (a: TaskItem, b: TaskItem): number => {
      if (a.due == null && b.due == null) return a.title.localeCompare(b.title);
      if (a.due == null) return 1;
      if (b.due == null) return -1;
      return a.due - b.due;
    };

    const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
      { key: "overdue",   label: "Overdue",   icon: "alert-circle" },
      { key: "today",     label: "Due today", icon: "calendar-clock" },
      { key: "upcoming",  label: "Upcoming",  icon: "calendar" },
      { key: "nodate",    label: "No date",   icon: "inbox" },
      { key: "completed", label: "Completed", icon: "check-circle-2" },
    ];

    // 0.76.4: filter button bar. "All" stacks every non-empty section;
    // a specific filter shows just that bucket. The active filter is
    // remembered per-session. Each button carries its bucket count.
    const filterBar = list.createDiv({ cls: "stashpad-task-filters" });
    const total = tasks.length;
    const mkFilterBtn = (key: typeof this.taskFilter, label: string, count: number) => {
      const btn = filterBar.createEl("button", { cls: "stashpad-task-filter" });
      if (this.taskFilter === key) btn.addClass("is-active");
      btn.createSpan({ cls: "stashpad-task-filter-label", text: label });
      btn.createSpan({ cls: "stashpad-task-filter-count", text: String(count) });
      btn.onclick = () => { this.taskFilter = key; this.render(); };
    };
    mkFilterBtn("all", "All", total);
    mkFilterBtn("overdue", "Overdue", buckets.overdue.length);
    mkFilterBtn("today", "Today", buckets.today.length);
    mkFilterBtn("upcoming", "Upcoming", buckets.upcoming.length);
    mkFilterBtn("nodate", "No date", buckets.nodate.length);
    mkFilterBtn("completed", "Done", buckets.completed.length);

    // Which sections to render: all (stacked) or the single filtered one.
    const showSections = this.taskFilter === "all"
      ? SECTIONS
      : SECTIONS.filter((s) => s.key === this.taskFilter);

    let any = false;
    for (const sec of showSections) {
      const items = buckets[sec.key];
      if (items.length === 0) continue;
      any = true;
      // Completed sorts newest-due first; everything else soonest-first.
      items.sort(sec.key === "completed" ? (a, b) => byDue(b, a) : byDue);
      // In single-filter mode the button already names the bucket, so
      // the in-list section header is redundant — skip it.
      if (this.taskFilter === "all") {
        const header = list.createDiv({ cls: `stashpad-task-section-header is-${sec.key}` });
        setIcon(header.createSpan({ cls: "stashpad-task-section-icon" }), sec.icon);
        header.createSpan({ cls: "stashpad-task-section-name", text: sec.label });
        header.createSpan({ cls: "stashpad-task-section-count", text: String(items.length) });
      }
      for (const t of items) this.renderTaskRow(list, t, sec.key === "today");
    }
    // 0.76.4: a filtered view with no items in that bucket gets a
    // tailored empty line instead of looking broken.
    if (!any && this.taskFilter !== "all") {
      list.createDiv({ cls: "stashpad-tasks-empty" })
        .setText(`Nothing in "${showSections[0]?.label ?? this.taskFilter}".`);
      return;
    }
    // collectTasks returned items but all fell outside the buckets
    // (shouldn't happen) — guard so the panel never looks empty wrongly.
    if (!any) {
      list.createDiv({ cls: "stashpad-tasks-empty" }).setText("No tasks to show.");
    }
  }

  private renderTaskRow(parent: HTMLElement, t: TaskItem, isToday: boolean): void {
    const row = parent.createDiv({ cls: "stashpad-pinned-row stashpad-task-row" });
    if (t.color) row.addClass("has-color");
    if (t.completed) row.addClass("is-completed");
    // 0.76.3: clickable checkbox — unfilled (square) when open, filled
    // (check-square) when done. Click toggles `completed` directly.
    const icon = row.createSpan({ cls: "stashpad-pinned-icon stashpad-task-checkbox" });
    setIcon(icon, t.completed ? "check-square" : "square");
    if (t.color) icon.style.color = t.color;
    icon.title = t.completed ? "Mark not done" : "Mark done";
    icon.onclick = (e) => {
      e.stopPropagation();
      void this.toggleTaskCompleted(t);
    };
    const label = row.createSpan({ cls: "stashpad-pinned-label", text: t.title });
    label.onclick = () => this.openTaskFromPanel(t.folder, t.id);
    // Folder chip — tasks span folders in the status-grouped view.
    row.createSpan({ cls: "stashpad-task-folder", text: t.folder.split("/").pop() || t.folder });
    if (t.due != null) {
      const due = row.createSpan({ cls: "stashpad-task-due", text: this.formatDueShort(t.due, isToday) });
      // Past-due (and not done) gets the warning tint even inside the
      // "Due today" section (time has passed today).
      if (t.due < Date.now() && !t.completed) due.addClass("is-overdue");
    } else if (t.dueRaw) {
      // Unparseable due string — show it raw rather than dropping it.
      row.createSpan({ cls: "stashpad-task-due", text: t.dueRaw });
    }
    // 0.78.2: assignee chips. Show each assignee's first name (or initials
    // when there are several) so you can see who owns the task at a glance.
    if (t.assignedTo.length > 0) {
      const meId = (this.plugin.settings.authorId ?? "").trim();
      const wrap = row.createSpan({ cls: "stashpad-task-assignees" });
      for (const a of t.assignedTo) {
        const chip = wrap.createSpan({ cls: "stashpad-task-assignee" });
        if (meId && a.id === meId) chip.addClass("is-me");
        // 0.78.5: always show initials to save row space; hover reveals
        // the full name.
        chip.setText(this.initials(a.name));
        chip.title = meId && a.id === meId ? `${a.name} (you)` : a.name;
      }
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

  /** 0.76.6: compact due label honouring the user's display format +
   *  timezone. Time-only for today's tasks; date-only otherwise. */
  private formatDueShort(dueMs: number, isToday: boolean): string {
    return isToday
      ? formatTimeOnly(dueMs, this.plugin.settings)
      : formatDateOnly(dueMs, this.plugin.settings);
  }

  private async openTaskFromPanel(folder: string, id: StashpadId): Promise<void> {
    await this.plugin.revealNoteByRef(folder, id); // reuse-or-open, unified
  }

  /** 0.76.3: flip a task's `completed` field straight from the panel
   *  checkbox — no need to open the note. Re-renders so the row moves
   *  to/from the Completed section. */
  private async toggleTaskCompleted(t: TaskItem): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(t.file, (m: any) => {
        m.completed = !(m.completed === true);
      });
    } catch (e) {
      new Notice(`Couldn't update task: ${(e as Error).message}`);
      return;
    }
    this.scheduleRender();
  }

  /** First-letter initials (up to 2) for a name, for compact assignee
   *  chips when a task has several assignees. */
  private initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  private collectTasks(): TaskItem[] {
    const folders = this.plugin.discoverStashpadFolders();
    const folderSet = new Set(folders);
    const out: TaskItem[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folderSet.has(dir)) continue;
      const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as any;
      const id = typeof fm.id === "string" ? fm.id : null;
      if (!id || id === ROOT_ID) continue;
      const completed = fm.completed === true;
      // 0.76.3: a note is a task when it carries the `task` tag, or
      // (legacy) the 0.76.1 `task: true` boolean, or a bare
      // `completed` field set by an earlier complete-toggle.
      const task = fmHasTag(fm, "task") || fm.task === true || fm.completed !== undefined;
      const dueRaw = typeof fm.due === "string" || typeof fm.due === "number" ? String(fm.due) : null;
      // `due` can be either a moment-parseable date string or a raw
      // ISO timestamp number. Try Date.parse — if NaN, keep dueRaw for
      // display but leave due=null so sort doesn't mis-order it.
      let due: number | null = null;
      if (dueRaw) {
        const t = Date.parse(dueRaw);
        if (!Number.isNaN(t)) due = t;
      }
      // 0.76.2: include anything flagged as a task, plus the legacy
      // signals (completed / due) so notes from before the `task`
      // field still surface.
      if (!task && !completed && due == null && !dueRaw) continue;
      out.push({
        file: f,
        folder: dir,
        id,
        title: this.titleFromFile(f),
        task,
        completed,
        due,
        dueRaw,
        color: typeof fm.color === "string" ? fm.color : null,
        assignedTo: parseAssignees(fm),
        assignedBy: parseAuthorRef(fm.assignedBy),
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
