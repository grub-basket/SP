import { App, ItemView, Menu, Modal, Notice, Platform, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, STASHPAD_FOLDER_PANEL_VIEW_TYPE, STASHPAD_VIEW_TYPE, type StashpadId } from "./types";
import { renderCountBadge } from "./panels-view";
import { ConfirmModal } from "./modals";

/** 0.86.0: a left-sidebar folder picker, designed for mobile (swipe the left
 *  panel in, tap a folder to jump). Two stacked scrollable lists: pinned notes
 *  on top, Stashpad folders on the bottom (within thumb reach). Each folder row
 *  shows an "open" indicator, a reveal + open-in-new-tab button, and a
 *  right-click menu (open / reveal / rename / delete). Works on desktop too. */
export class StashpadFolderPanelView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) {
    super(leaf);
  }

  getViewType(): string { return STASHPAD_FOLDER_PANEL_VIEW_TYPE; }
  getDisplayText(): string { return "Stashpad folders"; }
  getIcon(): string { return "folders"; }

  async onOpen(): Promise<void> {
    this.render();
    // Keep the "open" indicators + folder/pin lists fresh.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRender()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRender()));
  }

  private renderTimer: number | null = null;
  private scheduleRender(): void {
    if (this.renderTimer != null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.containerEl.isConnected) this.render();
    }, 100);
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-folderpanel-root");

    const frac = this.clampFrac(this.plugin.settings.folderPanelPinnedFraction ?? 0.5);

    // --- top: pinned notes (height = saved fraction; resized via the divider) ---
    const pinnedSection = root.createDiv({ cls: "stashpad-folderpanel-section stashpad-folderpanel-pinned" });
    pinnedSection.style.flex = `0 0 ${(frac * 100).toFixed(2)}%`;
    const pinHeading = pinnedSection.createDiv({ cls: "stashpad-folderpanel-heading stashpad-folderpanel-heading-row" });
    pinHeading.createSpan({ cls: "stashpad-folderpanel-heading-title", text: "Pinned" });
    const optsBtn = pinHeading.createEl("button", { cls: "stashpad-folderpanel-iconbtn" });
    setIcon(optsBtn, "list");
    optsBtn.setAttr("aria-label", "Pinned view options");
    optsBtn.onclick = (e) => { e.stopPropagation(); this.openPinnedOptionsMenu(e); };
    this.renderPinned(pinnedSection.createDiv({ cls: "stashpad-folderpanel-list stashpad-folderpanel-pins" }));

    // --- draggable divider ---
    const divider = root.createDiv({ cls: "stashpad-folderpanel-divider" });
    divider.createDiv({ cls: "stashpad-folderpanel-divider-grip" });
    this.attachDividerDrag(root, pinnedSection, divider);

    // --- bottom: folders (takes the rest; kept low for thumb reach on mobile) ---
    const folderSection = root.createDiv({ cls: "stashpad-folderpanel-section stashpad-folderpanel-folders" });
    folderSection.setCssStyles({ flex: "1 1 0" });
    // 0.98.37: the "Folders" heading is itself the folder-switcher button, with a
    // dedicated encrypted-trash button beside it.
    const head = folderSection.createDiv({ cls: "stashpad-folderpanel-heading stashpad-folderpanel-heading-row" });
    const he:HTMLElement = head.createSpan({ cls: "stashpad-folderpanel-heading-title stashpad-folderpanel-heading-switch", text: "Folders" });
    he.setAttr("aria-label", "Open folder switcher");
    he.onmousedown = (e) => { if (e.button === 0) { e.preventDefault(); this.plugin.openFolderPicker(); } };
    if (this.plugin.encryption?.isConfigured?.()) {
      const trashBtn = head.createEl("button", { cls: "stashpad-folderpanel-iconbtn stashpad-folderpanel-heading-trash" });
      setIcon(trashBtn, "trash-2");
      trashBtn.setAttr("aria-label", "Open encrypted trash");
      trashBtn.onmousedown = (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); this.plugin.openEncryptedTrash(); } };
    }
    this.renderFolders(folderSection.createDiv({ cls: "stashpad-folderpanel-list" }));
  }

  private clampFrac(f: number): number {
    if (!Number.isFinite(f)) return 0.5;
    return Math.max(0.15, Math.min(0.85, f));
  }

  /** Drag the divider to resize the Pinned/Folders split. Pointer events cover
   *  both mouse and touch; the fraction is persisted on release. */
  private attachDividerDrag(root: HTMLElement, pinnedSection: HTMLElement, divider: HTMLElement): void {
    let pending: number | null = null;
    const onMove = (ev: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      if (rect.height <= 0) return;
      const f = this.clampFrac((ev.clientY - rect.top) / rect.height);
      pending = f;
      pinnedSection.style.flex = `0 0 ${(f * 100).toFixed(2)}%`;
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.removeClass("stashpad-folderpanel-resizing");
      try { divider.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      if (pending != null) {
        this.plugin.settings.folderPanelPinnedFraction = pending;
        void this.plugin.saveSettings();
      }
    };
    divider.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      document.body.addClass("stashpad-folderpanel-resizing");
      try { divider.setPointerCapture(ev.pointerId); } catch { /* noop */ }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  // ---------- pinned notes (top) ----------

  /** Pin subtree expansion state (key = `folder|id`), kept across re-renders. */
  private pinExpanded = new Set<string>();

  private openPinnedOptionsMenu(e: MouseEvent): void {
    const cur = this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order";
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Sort by pin order").setChecked(cur === "pin-order")
      .onClick(() => void this.setPinnedGrouping("pin-order")));
    menu.addItem((i) => i.setTitle("Group by folder").setChecked(cur === "folder")
      .onClick(() => void this.setPinnedGrouping("folder")));
    menu.showAtMouseEvent(e);
  }

  private async setPinnedGrouping(mode: "pin-order" | "folder"): Promise<void> {
    if ((this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order") === mode) return;
    this.plugin.settings.folderPanelPinnedGrouping = mode;
    await this.plugin.saveSettings();
    this.render();
  }

  private renderPinned(list: HTMLElement): void {
    // 0.102.x: pinned FOLDERS mix into the top "Pinned" section (above the pinned
    // notes), using the same folder rows as the list below. The bottom Folders
    // subsection is unchanged — pinned folders still appear there ranked-first.
    const pinnedFolders = this.plugin.discoverStashpadFolders().filter((f) => this.folderState(f) === "pinned");
    const pins = this.plugin.listPinnedNotes();
    if (pinnedFolders.length === 0 && pins.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "Nothing pinned yet — pin a note or folder from its right-click menu." });
      return;
    }
    if (pinnedFolders.length > 0) {
      const open = this.openFolders();
      for (const folder of pinnedFolders) this.renderFolderRow(list, folder, open);
    }
    if (pins.length === 0) return;
    const grouping = this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order";
    if (grouping === "folder") {
      // Group by Stashpad, MRU folder floated to the top (mirrors the Pinned panel).
      const groups = new Map<string, Array<{ folder: string; id: string; file: TFile; idx: number }>>();
      pins.forEach((pin, idx) => {
        let bucket = groups.get(pin.folder);
        if (!bucket) { bucket = []; groups.set(pin.folder, bucket); }
        bucket.push({ ...pin, idx });
      });
      const mru = (this.plugin.lastActiveStashpadLeaf?.view as any)?.noteFolder as string | undefined;
      const order = Array.from(groups.keys());
      if (mru && groups.has(mru)) { order.splice(order.indexOf(mru), 1); order.unshift(mru); }
      for (const folder of order) {
        const header = list.createDiv({ cls: "stashpad-pinned-group-header" });
        if (folder === mru) header.addClass("is-active-folder");
        header.createSpan({ cls: "stashpad-pinned-group-name", text: folder.split("/").pop() || folder });
        for (const p of groups.get(folder) ?? []) this.renderPinNote(list, p.folder, p.id, p.file, p.idx);
      }
    } else {
      pins.forEach((pin, idx) => this.renderPinNote(list, pin.folder, pin.id, pin.file, idx));
    }
  }

  /** Drag-reorder a pin by rewriting its `pinnedAt` to fall between its new
   *  neighbors (the synced ordering key). Mirrors the Pinned panel. */
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

  /** One top-level pinned note: color tint, completed style, and an expandable
   *  child-count badge (borrowed from the Pinned panel). Reuses the
   *  `.stashpad-pinned-*` classes so styling + note colors stay identical. */
  private renderPinNote(list: HTMLElement, folder: string, id: string, file: TFile, idx: number): void {
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as any;
    const color = typeof fm.color === "string" ? fm.color : null;
    const completed = fm.completed === true;
    const children = this.childrenOf(folder, id);
    const hasChildren = children.length > 0;
    const key = `${folder}|${id}`;
    const isExpanded = this.pinExpanded.has(key);

    const row = list.createDiv({ cls: "stashpad-pinned-row" });
    if (color) { row.addClass("has-color"); row.style.setProperty("--stashpad-note-color", color); }
    if (completed) row.addClass("is-completed");

    // HTML5 drag-reorder (mirrors the Pinned panel). pinnedAt is the synced key.
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
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.toggleClass("drop-before", before);
      row.toggleClass("drop-after", !before);
    });
    row.addEventListener("dragleave", () => { row.removeClass("drop-before"); row.removeClass("drop-after"); });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.removeClass("drop-before"); row.removeClass("drop-after");
      const fromIdx = parseInt(e.dataTransfer?.getData("text/plain") ?? "", 10);
      if (!Number.isFinite(fromIdx) || fromIdx === idx) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      void this.reorderPin(fromIdx, before ? idx : idx + 1);
    });

    const toggle = row.createSpan({ cls: "stashpad-pinned-toggle" });
    if (hasChildren) {
      renderCountBadge(toggle, children.length, isExpanded);
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (this.pinExpanded.has(key)) this.pinExpanded.delete(key);
        else this.pinExpanded.add(key);
        this.render();
      };
    }
    const icon = row.createSpan({ cls: "stashpad-pinned-icon" });
    setIcon(icon, hasChildren ? "folder-tree" : "file-text");
    if (color) icon.style.color = color;
    const label = row.createSpan({ cls: "stashpad-pinned-label", text: this.titleFromFile(file) });
    label.onclick = () => { this.onNavigateAway(); void this.plugin.revealNoteInStashpad(file); };
    // Folder subtitle is hidden by CSS (.stashpad-panel-pinned) but kept for the
    // group-by-folder mode where headers already supply context.
    row.createSpan({ cls: "stashpad-pinned-folder", text: folder.split("/").pop() || folder });
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((it) => it.setTitle("Unpin from sidebar").setIcon("pin-off")
        .onClick(() => void this.plugin.unpinNote({ folder, id })));
      menu.showAtMouseEvent(e);
    };

    if (hasChildren && isExpanded) {
      const box = list.createDiv({ cls: "stashpad-pinned-children" });
      this.renderPinSubtree(box, folder, id, 1);
    }
  }

  private renderPinSubtree(parent: HTMLElement, folder: string, parentId: StashpadId, depth: number): void {
    for (const child of this.childrenOf(folder, parentId)) {
      const fm = (this.app.metadataCache.getFileCache(child)?.frontmatter ?? {}) as any;
      const childId = typeof fm.id === "string" ? fm.id : null;
      if (!childId) continue;
      const color = typeof fm.color === "string" ? fm.color : null;
      const completed = fm.completed === true;
      const grandkids = this.childrenOf(folder, childId);
      const hasGrandkids = grandkids.length > 0;
      const key = `${folder}|${childId}`;
      const isExpanded = this.pinExpanded.has(key);
      const row = parent.createDiv({ cls: "stashpad-pinned-subrow" });
      if (completed) row.addClass("is-completed");
      row.style.paddingLeft = `${depth * 16}px`;
      const toggle = row.createSpan({ cls: "stashpad-pinned-toggle" });
      if (hasGrandkids) {
        renderCountBadge(toggle, grandkids.length, isExpanded);
        toggle.onclick = (e) => {
          e.stopPropagation();
          if (this.pinExpanded.has(key)) this.pinExpanded.delete(key);
          else this.pinExpanded.add(key);
          this.render();
        };
      }
      const icon = row.createSpan({ cls: "stashpad-pinned-icon" });
      setIcon(icon, "file-text");
      if (color) icon.style.color = color;
      const label = row.createSpan({ cls: "stashpad-pinned-label", text: this.titleFromFile(child) });
      label.onclick = () => { this.onNavigateAway(); void this.plugin.revealNoteInStashpad(child); };
      if (hasGrandkids && isExpanded) this.renderPinSubtree(parent, folder, childId, depth + 1);
    }
  }

  /** Children of an id within a folder (frontmatter.parent matches), created-asc. */
  private childrenOf(folder: string, parentId: StashpadId): TFile[] {
    const out: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== folder) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      if (!fm || typeof fm.id !== "string") continue;
      const p = fm.parent;
      if (p === parentId || (parentId === ROOT_ID && (p == null || p === ROOT_ID))) {
        if (fm.id === ROOT_ID) continue;
        out.push(f);
      }
    }
    out.sort((a, b) => {
      const ca = (this.app.metadataCache.getFileCache(a)?.frontmatter as any)?.created ?? "";
      const cb = (this.app.metadataCache.getFileCache(b)?.frontmatter as any)?.created ?? "";
      return String(ca).localeCompare(String(cb));
    });
    return out;
  }

  /** On mobile, jumping out of the panel should reveal the destination — collapse
   *  the left sidebar — WITHOUT the target view popping its composer keyboard. */
  private onNavigateAway(): void {
    if (!Platform.isMobile) return;
    this.plugin.suppressComposerAutofocusUntil = Date.now() + 1500;
    this.app.workspace.leftSplit?.collapse?.();
  }

  private titleFromFile(file: TFile): string {
    return file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim() || file.basename;
  }

  // ---------- folders (bottom) ----------

  /** Folder paths (trailing-slash-stripped) that currently have an open
   *  Stashpad tab. 0.95.0: also counts DEFERRED tabs. After a reload Obsidian
   *  lazy-loads inactive leaves — their `view` is a placeholder with no
   *  `noteFolder`, so the old live-view-only check lit up just the focused tab.
   *  The folder survives in the leaf's persisted view state (`folderOverride`,
   *  empty/null = the default folder), so read that when the live view isn't
   *  resolved yet. No caching needed — it's exact even right after reload. */
  private openFolders(): Set<string> {
    const set = new Set<string>();
    const fallback = (this.plugin.settings.folder || "Stashpad").replace(/\/+$/, "");
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      let f = ((leaf.view as any)?.noteFolder ?? "").replace(/\/+$/, "");
      if (!f) {
        const st = ((leaf.getViewState?.() as any)?.state ?? {}) as { folderOverride?: string | null };
        f = (((st.folderOverride ?? "") || fallback) as string).replace(/\/+$/, "");
      }
      if (f) set.add(f);
    }
    return set;
  }

  // ---------- per-folder placement (pin / downrank / hide) ----------

  private static clean(folder: string): string { return folder.replace(/\/+$/, ""); }

  /** Current placement of a folder. "normal" = in none of the override lists. */
  private folderState(folder: string): "pinned" | "downranked" | "hidden" | "normal" {
    const c = StashpadFolderPanelView.clean(folder);
    const s = this.plugin.settings;
    if ((s.folderPanelPinned ?? []).includes(c)) return "pinned";
    if ((s.folderPanelDownranked ?? []).includes(c)) return "downranked";
    if ((s.folderPanelHidden ?? []).includes(c)) return "hidden";
    return "normal";
  }

  /** Move a folder to a placement, clearing it from the other two lists first.
   *  "normal" just removes it everywhere. Persists + re-renders. */
  private async setFolderState(folder: string, state: "pinned" | "downranked" | "hidden" | "normal"): Promise<void> {
    const c = StashpadFolderPanelView.clean(folder);
    const s = this.plugin.settings;
    s.folderPanelPinned = (s.folderPanelPinned ?? []).filter((f) => f !== c);
    s.folderPanelDownranked = (s.folderPanelDownranked ?? []).filter((f) => f !== c);
    s.folderPanelHidden = (s.folderPanelHidden ?? []).filter((f) => f !== c);
    if (state === "pinned") s.folderPanelPinned.push(c);
    else if (state === "downranked") s.folderPanelDownranked.push(c);
    else if (state === "hidden") s.folderPanelHidden.push(c);
    await this.plugin.saveSettings();
    this.render();
  }

  /** folder path → its Home note's color (for the folder-row icon tint).
   *  Rebuilt once per renderFolders in a single vault pass. */
  private homeColorByFolder = new Map<string, string>();
  private folderHomeColor(folder: string): string | null {
    return this.homeColorByFolder.get(StashpadFolderPanelView.clean(folder)) ?? null;
  }
  private rebuildHomeColors(): void {
    this.homeColorByFolder.clear();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      if (!fm || fm.id !== ROOT_ID || typeof fm.color !== "string" || !fm.color.trim()) continue;
      const dir = (f.parent?.path ?? "").replace(/\/+$/, "");
      if (dir) this.homeColorByFolder.set(dir, fm.color);
    }
  }

  private renderFolders(list: HTMLElement): void {
    const folders = this.plugin.discoverStashpadFolders();
    if (folders.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "No Stashpad folders yet." });
      return;
    }
    this.rebuildHomeColors();
    const open = this.openFolders();

    // Partition by placement (discoverStashpadFolders is already alpha-sorted, so
    // each group preserves alphabetical order). Hidden folders drop out of the
    // main list and surface in the collapsible "Hidden" section below.
    const pinned: string[] = [], normal: string[] = [], downranked: string[] = [], hidden: string[] = [];
    for (const folder of folders) {
      switch (this.folderState(folder)) {
        case "pinned": pinned.push(folder); break;
        case "downranked": downranked.push(folder); break;
        case "hidden": hidden.push(folder); break;
        default: normal.push(folder);
      }
    }

    const ordered = [...pinned, ...normal, ...downranked];
    if (ordered.length === 0 && hidden.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "No Stashpad folders yet." });
      return;
    }
    for (const folder of ordered) this.renderFolderRow(list, folder, open);

    if (hidden.length > 0) this.renderHiddenSection(list, hidden);
  }

  private renderFolderRow(list: HTMLElement, folder: string, open: Set<string>): void {
    const state = this.folderState(folder);
    const isOpen = open.has(StashpadFolderPanelView.clean(folder));
    const row = list.createDiv({ cls: "stashpad-folderpanel-row stashpad-folderpanel-folder-row" });
    if (isOpen) row.addClass("is-open");
    if (state === "downranked") row.addClass("is-downranked");
    if (state === "pinned") row.addClass("is-pinned");

    const dot = row.createSpan({ cls: "stashpad-folderpanel-dot" });
    dot.setAttr("aria-label", isOpen ? "Open in a tab" : "Not open");
    if (isOpen) dot.setAttr("title", "Open in a tab");

    if (state === "pinned") {
      const pin = row.createSpan({ cls: "stashpad-folderpanel-pinmark" });
      setIcon(pin, "pin");
      pin.setAttr("aria-label", "Pinned");
    }

    // 0.95.1: per-folder icon. Tinted by the folder's Home-note color when set.
    // 0.98.37: archive folders show the ARCHIVE icon in place of the folder icon
    // (one icon instead of folder + a separate badge).
    const isArchive = this.plugin.isArchiveFolder(folder);
    const folderIcon = row.createSpan({ cls: "stashpad-folderpanel-folder-icon" });
    setIcon(folderIcon, isArchive ? "archive" : "folder");
    if (isArchive) folderIcon.setAttr("aria-label", "Archive folder — notes moved in are auto-encrypted");
    const homeColor = this.folderHomeColor(folder);
    if (homeColor) folderIcon.style.color = homeColor;

    const name = folder.split("/").pop() || folder;
    row.createSpan({ cls: "stashpad-folderpanel-row-label", text: name });

    // 0.98.37: reveal-in-file-explorer moved to the context menu only; keep the
    // open-in-new-tab quick button.
    const actions = row.createDiv({ cls: "stashpad-folderpanel-actions" });
    const newTabBtn = actions.createEl("button", { cls: "stashpad-folderpanel-iconbtn" });
    setIcon(newTabBtn, "plus-square");
    newTabBtn.setAttr("aria-label", "Open in new tab");
    // 0.98.38: fire on mousedown, not click. Opening a tab moves focus to it, so
    // the NEXT click on the (now-unfocused) sidebar button was getting swallowed by
    // Obsidian re-focusing the panel — only every other click registered. mousedown
    // fires regardless of focus, so you can spam it and get a tab per click.
    newTabBtn.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.onNavigateAway(); void this.plugin.activateViewForFolder(folder);
    };

    // 0.98.37: open on a SINGLE click. Use mousedown (not click) so it fires even
    // when the sidebar panel wasn't focused yet — Obsidian's "first click focuses
    // the sidebar, second click acts" behavior was forcing a double-click. Ignore
    // non-left buttons and clicks landing on the action buttons.
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement)?.closest?.(".stashpad-folderpanel-actions")) return;
      this.onNavigateAway(); this.jumpToFolder(folder);
    });
    row.oncontextmenu = (e) => { e.preventDefault(); this.openFolderMenu(e, folder); };
  }

  /** Collapsible "Hidden (N)" group at the bottom of the Folders list, so hidden
   *  folders are restorable in-context (also restorable from the settings tab). */
  private renderHiddenSection(list: HTMLElement, hidden: string[]): void {
    const wrap = list.createDiv({ cls: "stashpad-folderpanel-hidden" });
    const header = wrap.createDiv({ cls: "stashpad-folderpanel-hidden-header" });
    const caret = header.createSpan({ cls: "stashpad-folderpanel-hidden-caret" });
    setIcon(caret, "chevron-right");
    header.createSpan({ cls: "stashpad-folderpanel-hidden-title", text: `Hidden (${hidden.length})` });
    const body = wrap.createDiv({ cls: "stashpad-folderpanel-hidden-body" });
    body.setCssStyles({ display: "none" });
    header.onclick = () => {
      const showing = body.style.display !== "none";
      body.setCssStyles({ display: showing ? "none" : "" });
      setIcon(caret, showing ? "chevron-right" : "chevron-down");
    };
    for (const folder of hidden) {
      const row = body.createDiv({ cls: "stashpad-folderpanel-row stashpad-folderpanel-hidden-row" });
      const name = folder.split("/").pop() || folder;
      row.createSpan({ cls: "stashpad-folderpanel-row-label", text: name });
      const restore = row.createEl("button", { cls: "stashpad-folderpanel-iconbtn" });
      setIcon(restore, "eye");
      restore.setAttr("aria-label", "Unhide");
      restore.onclick = (e) => { e.stopPropagation(); void this.setFolderState(folder, "normal"); };
    }
  }

  /** Reuse an existing Stashpad tab on this folder if present; else open one.
   *  (Routes through openFolderInStashpad so DEFERRED tabs count as existing —
   *  the local live-view-only check spawned duplicates for backgrounded tabs.) */
  private jumpToFolder(folder: string): void {
    void this.plugin.openFolderInStashpad(folder);
  }

  private revealFolder(folder: string): void {
    const tf = this.app.vault.getAbstractFileByPath(folder.replace(/\/+$/, ""));
    if (!(tf instanceof TFolder)) { new Notice("Couldn't find that folder."); return; }
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) { new Notice("File explorer isn't available."); return; }
    this.app.workspace.revealLeaf(leaf);
    (leaf.view as any)?.revealInFolder?.(tf);
  }

  private openFolderMenu(e: MouseEvent, folder: string): void {
    const menu = new Menu();
    // Order: non-destructive navigation first, then rename, then delete (isolated).
    menu.addItem((i) => i.setTitle("Open in new tab").setIcon("plus-square")
      .onClick(() => void this.plugin.activateViewForFolder(folder)));
    menu.addItem((i) => i.setTitle("Reveal in file explorer").setIcon("folder-search")
      .onClick(() => this.revealFolder(folder)));
    menu.addSeparator();
    // Placement (pin / downrank / hide). Each is a toggle; setFolderState clears
    // the other two so a folder is in at most one state.
    const state = this.folderState(folder);
    menu.addItem((i) => i.setTitle(state === "pinned" ? "Unpin" : "Pin to top").setIcon("pin")
      .onClick(() => void this.setFolderState(folder, state === "pinned" ? "normal" : "pinned")));
    menu.addItem((i) => i.setTitle(state === "downranked" ? "Remove downrank" : "Downrank").setIcon("arrow-down")
      .onClick(() => void this.setFolderState(folder, state === "downranked" ? "normal" : "downranked")));
    menu.addItem((i) => i.setTitle("Hide from list").setIcon("eye-off")
      .onClick(() => void this.setFolderState(folder, "hidden")));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil")
      .onClick(() => this.renameFolder(folder)));
    // Encryption (Phase 3): lock every top-level note in the folder into separate
    // .stashenc bundles, or unlock them all back. Only when encryption is set up.
    if (this.plugin.encryption?.isConfigured?.()) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Encrypt (lock) all notes in folder").setIcon("lock")
        .onClick(() => void this.plugin.lockFolder(folder)));
      if (this.app.vault.getFiles().some((f) => f.extension === "stashenc" && (f.parent?.path?.replace(/\/+$/, "") ?? "") === folder.replace(/\/+$/, ""))) {
        menu.addItem((i) => i.setTitle("Decrypt (unlock) all notes in folder").setIcon("unlock")
          .onClick(() => void this.plugin.unlockFolder(folder)));
      }
      // 0.98.25 (Phase 4): archive folder toggle. Marking requires an explicit
      // confirm — auto-lock permanently deletes the arriving note's plaintext.
      const cleaned = folder.replace(/\/+$/, "");
      const isArchive = this.plugin.isArchiveFolder(cleaned);
      menu.addItem((i) => i.setTitle(isArchive ? "Unmark archive folder" : "Mark as archive folder…").setIcon("archive")
        .onClick(async () => {
          if (isArchive) {
            this.plugin.settings.archiveFolders = (this.plugin.settings.archiveFolders ?? []).filter((f) => f !== cleaned);
            await this.plugin.saveSettings();
            new Notice(`"${cleaned.split("/").pop()}" is no longer an archive folder. Existing locked notes stay locked.`, 0);
            this.render();
            return;
          }
          new ConfirmModal(
            this.app,
            `Make "${cleaned.split("/").pop()}" an archive folder?`,
            [
              `An archive folder automatically LOCKS (encrypts) any note you move into it.`,
              ``,
              `What that means in plain terms:`,
              `• "Encrypting" scrambles the note with your encryption password so its text can't be read by anyone — or any app — without that password.`,
              `• The normal, readable copy is permanently removed from your vault. What's left is an unreadable, locked 🔒 placeholder.`,
              `• To read or edit the note again, you unlock it with your encryption password (one click on the placeholder). Then you can re-archive it later.`,
              `• If you ever lose your encryption password, the locked notes are gone for good — there is no backdoor or recovery, on purpose.`,
              `• Notes ALREADY in this folder are not touched — only notes moved in from now on. (To lock the ones already here, use "Encrypt all notes in folder".)`,
              ``,
              `Good for folders of things you want kept private at rest: finished or sensitive material you'd rather not have readable if someone opened your vault.`,
            ].join("\n"),
            "Make it an archive folder",
            async (ok) => {
              if (!ok) return;
              this.plugin.settings.archiveFolders = [...(this.plugin.settings.archiveFolders ?? []), cleaned];
              await this.plugin.saveSettings();
              new Notice(`"${cleaned.split("/").pop()}" is now an archive folder — notes moved in will be encrypted.`, 0);
              this.render();
            },
          ).open();
        }));

      // 0.98.31: open the encrypted-trash tab (recoverable secure-deleted notes).
      menu.addItem((i) => i.setTitle("Open encrypted trash").setIcon("rotate-ccw")
        .onClick(() => this.plugin.openEncryptedTrash()));
    }
    menu.addSeparator();
    menu.addItem((i) => {
      i.setTitle("Delete folder…").setIcon("trash").onClick(() => this.deleteFolder(folder));
      (i as any).setWarning?.(true);
    });
    menu.showAtMouseEvent(e);
  }

  private renameFolder(folder: string): void {
    const cleaned = folder.replace(/\/+$/, "");
    const tf = this.app.vault.getAbstractFileByPath(cleaned);
    if (!(tf instanceof TFolder)) { new Notice("Couldn't find that folder."); return; }
    const current = tf.name;
    new RenameFolderModal(this.app, current, async (next) => {
      const safe = next.trim().replace(/[\\/:]+/g, "").trim();
      if (!safe || safe === current) return;
      const parent = tf.parent?.path && tf.parent.path !== "/" ? `${tf.parent.path}/` : "";
      const target = `${parent}${safe}`;
      if (this.app.vault.getAbstractFileByPath(target)) { new Notice(`"${safe}" already exists.`); return; }
      try {
        await this.app.fileManager.renameFile(tf, target);
        // Keep the configured default folder pointing at the renamed path.
        if ((this.plugin.settings.folder || "").replace(/\/+$/, "") === cleaned) {
          this.plugin.settings.folder = target;
          await this.plugin.saveSettings();
        }
        new Notice(`Renamed to "${safe}".`);
      } catch (err) {
        console.warn("[Stashpad] folder rename failed", err);
        new Notice("Rename failed (see console).");
      }
    }).open();
  }

  private deleteFolder(folder: string): void {
    const cleaned = folder.replace(/\/+$/, "");
    const tf = this.app.vault.getAbstractFileByPath(cleaned);
    if (!(tf instanceof TFolder)) { new Notice("Couldn't find that folder."); return; }
    const noteCount = this.app.vault.getMarkdownFiles()
      .filter((f) => (f.parent?.path?.replace(/\/+$/, "") ?? "") === cleaned
        || (f.path.startsWith(cleaned + "/"))).length;
    const name = tf.name;
    new ConfirmModal(
      this.app,
      `Delete "${name}"?`,
      `This moves the entire folder — about ${noteCount} note${noteCount === 1 ? "" : "s"} plus its attachments and exports — to the trash.\nYou can restore it from your system/Obsidian trash.`,
      "Delete folder",
      async (confirmed) => {
        if (!confirmed) return;
        // Closes open tabs, moves the folder to .trash, and posts a persistent
        // notification with an Undo action (move-back). The vault "delete"
        // listener is suppressed for this path so it won't double-notify.
        await this.plugin.deleteStashpadFolderWithUndo(tf);
      },
    ).open();
  }
}

/** Tiny single-input modal for renaming a folder. */
class RenameFolderModal extends Modal {
  private delivered = false;
  constructor(app: App, private current: string, private onSubmit: (next: string) => void) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("stashpad-compact-modal");
    this.contentEl.empty();
    this.titleEl.setText("Rename folder");
    const input = this.contentEl.createEl("input", { type: "text" }) as HTMLInputElement;
    input.addClass("stashpad-folderpanel-rename-input");
    input.value = this.current;
    const footer = this.contentEl.createDiv({ cls: "stashpad-folderpanel-rename-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const go = footer.createEl("button", { cls: "mod-cta", text: "Rename" });
    const submit = () => { this.delivered = true; const v = input.value; this.close(); this.onSubmit(v); };
    go.onclick = submit;
    this.scope.register([], "Enter", (e) => { e.preventDefault(); if (input.value.trim()) submit(); });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  onClose(): void { this.contentEl.empty(); }
}

/** Open the folder panel in the LEFT sidebar (reuse if already open). */
export async function openFolderPanelView(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(STASHPAD_FOLDER_PANEL_VIEW_TYPE);
  if (existing.length > 0) { app.workspace.revealLeaf(existing[0]); return; }
  const leaf = app.workspace.getLeftLeaf(false);
  if (!leaf) { new Notice("Stashpad: couldn't open the folder panel."); return; }
  await leaf.setViewState({ type: STASHPAD_FOLDER_PANEL_VIEW_TYPE, active: true });
  app.workspace.revealLeaf(leaf);
}
