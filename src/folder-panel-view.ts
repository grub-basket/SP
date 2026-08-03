import { App, ItemView, Menu, Modal, Notice, Platform, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, STASHPAD_FOLDER_PANEL_VIEW_TYPE, STASHPAD_VIEW_TYPE, type StashpadId } from "./types";
import { renderCountBadge } from "./panels-view";
import { ConfirmModal } from "./modals";
import { canRevealInOs, osFileManagerName, revealInOsFileManager } from "./os-reveal";

/** 0.164.0: a pinned item in the folder panel's shared pin order — either a
 *  pinned FOLDER or a pinned NOTE. `at` is the shared numeric order key. */
type PinnedItem =
  | { kind: "folder"; folder: string; at: number }
  | { kind: "note"; folder: string; id: string; file: TFile; at: number };

/** Stable secondary sort key so items with an equal `at` don't jitter. */
function pinTieKey(it: PinnedItem): string {
  return it.kind === "folder" ? `f:${it.folder}` : `n:${it.folder}:${it.id}`;
}

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

  /** Public re-render hook — e.g. after settings change a folder's archive flag,
   *  so the archive icon repaints without waiting for a vault event. */
  refresh(): void { this.scheduleRender(); }

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
    pinHeading.createSpan({ cls: "stashpad-folderpanel-heading-title", text: "Pinned notes" });
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
    const newBtn = head.createEl("button", { cls: "stashpad-folderpanel-iconbtn stashpad-folderpanel-heading-newfolder" });
    setIcon(newBtn, "folder-plus");
    newBtn.setAttr("aria-label", "New Stashpad folder (folder switcher)");
    // 0.112.3: open the folder switcher (which already has a "Create" entry)
    // rather than a bespoke prompt — one place to create + switch folders.
    newBtn.onmousedown = (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); this.plugin.openFolderPicker(); } };
    if (this.plugin.encryption?.isConfigured?.()) {
      const trashBtn = head.createEl("button", { cls: "stashpad-folderpanel-iconbtn stashpad-folderpanel-heading-trash" });
      setIcon(trashBtn, "trash-2");
      // 0.199.0: "Open trash" — encryption is an implementation detail of the
      // trash store, and there's no separate plain-text trash view to
      // disambiguate from.
      trashBtn.setAttr("aria-label", "Open trash");
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
    // 0.140.3 (review): tear the document listeners down on pointerup AND
    // pointercancel (mobile scroll/palm-rejection ends a gesture with cancel,
    // not up), and expose the cleanup so onClose can run it if the view is
    // detached mid-drag — the old code leaked the document listeners + left the
    // resizing cursor class stuck when either happened.
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.removeClass("stashpad-folderpanel-resizing");
      this.dividerCleanup = null;
    };
    const onUp = (ev: PointerEvent) => {
      try { divider.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      if (ev.type === "pointerup" && pending != null) {
        this.plugin.settings.folderPanelPinnedFraction = pending;
        void this.plugin.saveSettings();
      }
      cleanup();
    };
    this.registerDomEvent(divider, "pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      document.body.addClass("stashpad-folderpanel-resizing");
      try { divider.setPointerCapture(ev.pointerId); } catch { /* noop */ }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      this.dividerCleanup = cleanup;
    });
  }

  /** 0.140.3: run any in-flight divider-drag cleanup (see attachDividerDrag). */
  private dividerCleanup: (() => void) | null = null;

  // ---------- pinned notes (top) ----------

  /** Pin subtree expansion state (key = `folder|id`), kept across re-renders. */
  private pinExpanded = new Set<string>();

  /** 0.105.1: which folder rows are expanded to reveal their Home list-pinned
   *  notes (key = folder path), kept across re-renders. */
  private folderPinExpanded = new Set<string>();

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

  // 0.164.0 unified pin ordering ------------------------------------------------

  /** A pinned item — a folder OR a note — with its shared numeric order key. */
  private unifiedPinnedItems(): PinnedItem[] {
    const items: PinnedItem[] = [];
    // 0.224.0: pinned FOLDERS no longer appear up here. They were duplicated —
    // a pinned folder showed in this section AND ranked at the top of the
    // folders list below it, so the top half mostly restated the bottom half.
    // Folder pins keep their meaning (they rank the list below, and now rank
    // the folder switcher + destination picker too); this section is just for
    // pinned notes. `folderPinnedAt` / `ensureFolderPinOrder` stay — they still
    // drive that ranking.
    for (const p of this.plugin.listPinnedNotes()) {
      items.push({ kind: "note", folder: p.folder, id: p.id, file: p.file, at: p.pinnedAt });
    }
    // One shared order: `at` ascending → newest pins (largest `at`) at the bottom.
    // Deterministic tiebreak so equal keys don't jitter between renders.
    items.sort((a, b) => a.at - b.at || pinTieKey(a).localeCompare(pinTieKey(b)));
    return items;
  }

  /** A pinned folder's order key (parallel to a note's `pinnedAt`). Falls back to
   *  the folder's index in `folderPanelPinned` when unset — small values sort
   *  ahead of real timestamps, so legacy folder-pins stay near the top. */
  private folderPinnedAt(folder: string): number {
    const c = StashpadFolderPanelView.clean(folder);
    const at = (this.plugin.settings.folderPanelPinnedAt ?? {})[c];
    if (typeof at === "number") return at;
    const idx = (this.plugin.settings.folderPanelPinned ?? []).indexOf(c);
    return idx >= 0 ? idx : 0;
  }

  /** Backfill order keys for pinned folders missing one + drop keys for folders no
   *  longer pinned. Persists at most once (only when something actually changed),
   *  so it's safe to call at the top of every render. */
  private ensureFolderPinOrder(): void {
    const s = this.plugin.settings;
    s.folderPanelPinnedAt = s.folderPanelPinnedAt ?? {};
    let changed = false;
    (s.folderPanelPinned ?? []).forEach((f, i) => {
      const c = StashpadFolderPanelView.clean(f);
      if (typeof s.folderPanelPinnedAt[c] !== "number") { s.folderPanelPinnedAt[c] = i; changed = true; }
    });
    for (const k of Object.keys(s.folderPanelPinnedAt)) {
      if (!(s.folderPanelPinned ?? []).includes(k)) { delete s.folderPanelPinnedAt[k]; changed = true; }
    }
    if (changed) void this.plugin.saveSettings();
  }

  private renderPinned(list: HTMLElement): void {
    this.ensureFolderPinOrder();
    const items = this.unifiedPinnedItems();
    if (items.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "Nothing pinned yet — pin a note or folder from its right-click menu." });
      return;
    }
    const open = this.openFolders();
    const grouping = this.plugin.settings.folderPanelPinnedGrouping ?? "pin-order";
    const idxOf = new Map<PinnedItem, number>();
    items.forEach((it, i) => idxOf.set(it, i));

    if (grouping !== "folder") {
      // Flat, shared pin order: folders and notes interleave and drag-reorder together.
      for (const it of items) this.renderPinnedItem(list, it, idxOf.get(it)!, open, true);
      return;
    }

    // Group-by-folder: notes group under per-Stashpad headers. A pinned FOLDER
    // nests under its own group's header only if that group has pinned notes; else
    // it's a standalone row ahead of the groups. Groups order by their EARLIEST pin
    // (stable — navigating doesn't reshuffle them, unlike the old MRU float), and
    // each group's items drag-reorder WITHIN the group with the order persisted in
    // `folderPanelGroupItemOrder` — a store separate from pin-order mode's `at`, so
    // switching modes never resets either arrangement.
    const notes = items.filter((i): i is Extract<PinnedItem, { kind: "note" }> => i.kind === "note");
    const folders = items.filter((i): i is Extract<PinnedItem, { kind: "folder" }> => i.kind === "folder");
    const noteGroups = new Map<string, PinnedItem[]>();
    for (const n of notes) { let b = noteGroups.get(n.folder); if (!b) { b = []; noteGroups.set(n.folder, b); } b.push(n); }
    for (const fi of folders.filter((f) => !noteGroups.has(f.folder)).sort((a, b) => a.at - b.at)) {
      this.renderPinnedItem(list, fi, idxOf.get(fi)!, open, false); // standalone folder
    }
    const groupMinAt = (folder: string): number => {
      let m = Infinity;
      const fi = folders.find((f) => f.folder === folder); if (fi) m = Math.min(m, fi.at);
      for (const n of noteGroups.get(folder) ?? []) m = Math.min(m, n.at);
      return m;
    };
    const groupKeys = [...noteGroups.keys()].sort((a, b) => groupMinAt(a) - groupMinAt(b) || a.localeCompare(b));
    const activeFolder = (this.plugin.lastActiveStashpadLeaf?.view as any)?.noteFolder as string | undefined;
    for (const folder of groupKeys) {
      const header = list.createDiv({ cls: "stashpad-pinned-group-header" });
      if (folder === activeFolder) header.addClass("is-active-folder");
      header.createSpan({ cls: "stashpad-pinned-group-name", text: folder.split("/").pop() || folder });
      const groupItems: PinnedItem[] = [];
      const matching = folders.find((fi) => fi.folder === folder);
      if (matching) groupItems.push(matching);
      groupItems.push(...(noteGroups.get(folder) ?? []));
      const orderedItems = this.orderedGroupItems(folder, groupItems);
      const keys = orderedItems.map(pinTieKey);
      orderedItems.forEach((it, i) => {
        const row = it.kind === "folder"
          ? this.renderFolderRow(list, it.folder, open)
          : this.renderPinNote(list, it.folder, it.id, it.file, i, false);
        this.attachGroupItemDrag(row, folder, i, keys);
      });
    }
  }

  /** A group's items ordered by the stored within-group order
   *  (`folderPanelGroupItemOrder`). Items not yet stored fall to the end by pin
   *  order (`at`), so newly-pinned items append. */
  private orderedGroupItems(folder: string, groupItems: PinnedItem[]): PinnedItem[] {
    const stored = (this.plugin.settings.folderPanelGroupItemOrder ?? {})[StashpadFolderPanelView.clean(folder)] ?? [];
    const rank = new Map<string, number>(stored.map((k, i) => [k, i]));
    return groupItems.slice().sort((a, b) => {
      const ra = rank.has(pinTieKey(a)) ? rank.get(pinTieKey(a))! : Infinity;
      const rb = rank.has(pinTieKey(b)) ? rank.get(pinTieKey(b))! : Infinity;
      return ra - rb || a.at - b.at;
    });
  }

  /** Persist a new within-group order after a within-group drag. */
  private async reorderGroupItem(folder: string, keys: string[], fromIdx: number, toIdx: number): Promise<void> {
    if (fromIdx < 0 || fromIdx >= keys.length) return;
    const arr = keys.slice();
    const [moved] = arr.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    arr.splice(Math.max(0, Math.min(insertAt, arr.length)), 0, moved);
    this.plugin.settings.folderPanelGroupItemOrder = this.plugin.settings.folderPanelGroupItemOrder ?? {};
    this.plugin.settings.folderPanelGroupItemOrder[StashpadFolderPanelView.clean(folder)] = arr;
    await this.plugin.saveSettings();
    this.render();
  }

  /** Within-group HTML5 drag-reorder (group-by-folder mode only). A private
   *  dataTransfer type keeps it separate from the flat pin-order drag, and a drop
   *  is accepted only from the SAME group (this reorders within a group, never
   *  across groups). */
  private attachGroupItemDrag(row: HTMLElement, folder: string, idx: number, keys: string[]): void {
    const TYPE = "application/x-stashpad-groupitem";
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(TYPE, JSON.stringify({ folder, idx }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes(TYPE)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.toggleClass("drop-before", before); row.toggleClass("drop-after", !before);
    });
    row.addEventListener("dragleave", () => { row.removeClass("drop-before"); row.removeClass("drop-after"); });
    row.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.types?.includes(TYPE)) return;
      e.preventDefault(); row.removeClass("drop-before"); row.removeClass("drop-after");
      let data: { folder: string; idx: number } | null = null;
      try { data = JSON.parse(e.dataTransfer.getData(TYPE) || "null"); } catch { data = null; }
      if (!data || data.folder !== folder || data.idx === idx) return; // same-group only
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      void this.reorderGroupItem(folder, keys, data.idx, before ? idx : idx + 1);
    });
  }

  /** Render one unified pinned item (folder or note). `draggable` wires the shared
   *  drag-reorder — enabled ONLY in pin-order mode, where the visual order equals
   *  the shared `at` order the drag math relies on. In group-by-folder mode the
   *  visual order is grouped (MRU-first), so a drop would land between the wrong
   *  neighbors — so drag is disabled there to keep behavior predictable. */
  private renderPinnedItem(list: HTMLElement, it: PinnedItem, idx: number, open: Set<string>, draggable: boolean): void {
    if (it.kind === "folder") {
      const row = this.renderFolderRow(list, it.folder, open);
      if (draggable) this.attachPinDrag(row, idx);
    } else {
      this.renderPinNote(list, it.folder, it.id, it.file, idx, draggable);
    }
  }

  /** Shared HTML5 drag-reorder for a pinned row (folder or note), keyed by its
   *  index in `unifiedPinnedItems()`. */
  private attachPinDrag(row: HTMLElement, idx: number): void {
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
      void this.reorderPinnedItem(fromIdx, before ? idx : idx + 1);
    });
  }

  /** Drag-reorder any pinned item (folder or note) by rewriting the moved item's
   *  order key to fall between its new neighbors. Notes write `pinnedAt`
   *  frontmatter (synced); folders write `folderPanelPinnedAt` (settings). */
  private async reorderPinnedItem(fromIdx: number, toIdx: number): Promise<void> {
    const items = this.unifiedPinnedItems();
    if (fromIdx < 0 || fromIdx >= items.length) return;
    const moved = items[fromIdx];
    const without = items.filter((_, i) => i !== fromIdx);
    const insertAt = Math.max(0, Math.min(toIdx > fromIdx ? toIdx - 1 : toIdx, without.length));
    const prev = without[insertAt - 1];
    const next = without[insertAt];
    let at: number;
    if (!prev && !next) at = Date.now();
    else if (!prev) at = next.at - 1000;
    else if (!next) at = prev.at + 1000;
    else at = (prev.at + next.at) / 2;
    if (moved.kind === "folder") {
      this.plugin.settings.folderPanelPinnedAt = this.plugin.settings.folderPanelPinnedAt ?? {};
      this.plugin.settings.folderPanelPinnedAt[moved.folder] = at;
      await this.plugin.saveSettings();
    } else {
      try { await this.app.fileManager.processFrontMatter(moved.file, (fm: any) => { fm.pinnedAt = at; }); }
      catch (e) { console.warn("[Stashpad] pin reorder failed", e); }
    }
    this.render();
  }

  /** One top-level pinned note: color tint, completed style, and an expandable
   *  child-count badge (borrowed from the Pinned panel). Reuses the
   *  `.stashpad-pinned-*` classes so styling + note colors stay identical. */
  private renderPinNote(list: HTMLElement, folder: string, id: string, file: TFile, idx: number, draggable: boolean): HTMLElement {
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

    // Shared drag-reorder (pinnedAt is the synced key) — only in pin-order mode.
    if (draggable) this.attachPinDrag(row, idx);

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
      if (canRevealInOs()) {
        menu.addItem((it) => it.setTitle(`Open in ${osFileManagerName()}`).setIcon("app-window")
          .onClick(() => revealInOsFileManager(this.app, file.path)));
      }
      menu.showAtMouseEvent(e);
    };

    if (hasChildren && isExpanded) {
      const box = list.createDiv({ cls: "stashpad-pinned-children" });
      this.renderPinSubtree(box, folder, id, 1);
    }
    return row;
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
        f = (((st.folderOverride ?? "") || fallback)).replace(/\/+$/, "");
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
    s.folderPanelPinnedAt = s.folderPanelPinnedAt ?? {};
    if (state === "pinned") {
      s.folderPanelPinned.push(c);
      // 0.164.0: newly-pinned folder gets `now` so it lands at the BOTTOM of the
      // shared pin order (mixed with the most-recent note pins).
      s.folderPanelPinnedAt[c] = Date.now();
    } else {
      // No longer pinned — drop its order key so it doesn't linger.
      delete s.folderPanelPinnedAt[c];
      if (state === "downranked") s.folderPanelDownranked.push(c);
      else if (state === "hidden") s.folderPanelHidden.push(c);
    }
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
    this.ensureFolderPinOrder();
    const open = this.openFolders();

    // Partition by placement. Hidden folders drop out of the main list and surface
    // in the collapsible "Hidden" section below.
    const pinned: string[] = [], normal: string[] = [], downranked: string[] = [], hidden: string[] = [];
    for (const folder of folders) {
      switch (this.folderState(folder)) {
        case "pinned": pinned.push(folder); break;
        case "downranked": downranked.push(folder); break;
        case "hidden": hidden.push(folder); break;
        default: normal.push(folder);
      }
    }

    // 0.164.0: pinned folders in their shared pin order (drag-reorderable); the
    // remaining folders alphabetical, CASE-INSENSITIVE (by display name).
    pinned.sort((a, b) => this.folderPinnedAt(a) - this.folderPinnedAt(b)
      || StashpadFolderPanelView.clean(a).localeCompare(StashpadFolderPanelView.clean(b)));
    const ciName = (f: string) => (f.split("/").pop() || f).toLowerCase();
    normal.sort((a, b) => ciName(a).localeCompare(ciName(b)));
    downranked.sort((a, b) => ciName(a).localeCompare(ciName(b)));

    const ordered = [...pinned, ...normal, ...downranked];
    if (ordered.length === 0 && hidden.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "No Stashpad folders yet." });
      return;
    }
    for (const folder of ordered) {
      const row = this.renderFolderRow(list, folder, open);
      // Pinned folders here are drag-reorderable among themselves (writes the same
      // shared order key, so the Pinned section above stays consistent).
      if (this.folderState(folder) === "pinned") this.attachFolderSectionDrag(row, pinned.indexOf(folder), pinned);
    }

    if (hidden.length > 0) this.renderHiddenSection(list, hidden);
  }

  /** Drag-reorder a PINNED folder within the Folders section. Uses a private
   *  dataTransfer type so it never mixes with the Pinned section's row drags, and
   *  writes the shared `folderPanelPinnedAt` order key. */
  private attachFolderSectionDrag(row: HTMLElement, idx: number, pinned: string[]): void {
    const TYPE = "application/x-stashpad-folder";
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(TYPE, String(idx));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes(TYPE)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.toggleClass("drop-before", before); row.toggleClass("drop-after", !before);
    });
    row.addEventListener("dragleave", () => { row.removeClass("drop-before"); row.removeClass("drop-after"); });
    row.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.types?.includes(TYPE)) return;
      e.preventDefault(); row.removeClass("drop-before"); row.removeClass("drop-after");
      const fromIdx = parseInt(e.dataTransfer.getData(TYPE) ?? "", 10);
      if (!Number.isFinite(fromIdx) || fromIdx === idx) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      void this.reorderPinnedFolders(pinned, fromIdx, before ? idx : idx + 1);
    });
  }

  /** Reorder a pinned folder among the pinned folders by rewriting its shared
   *  order key to fall between its new neighbors. */
  private async reorderPinnedFolders(pinned: string[], fromIdx: number, toIdx: number): Promise<void> {
    if (fromIdx < 0 || fromIdx >= pinned.length) return;
    const moved = pinned[fromIdx];
    const without = pinned.filter((_, i) => i !== fromIdx);
    const insertAt = Math.max(0, Math.min(toIdx > fromIdx ? toIdx - 1 : toIdx, without.length));
    const prev = without[insertAt - 1];
    const next = without[insertAt];
    let at: number;
    if (!prev && !next) at = Date.now();
    else if (!prev) at = this.folderPinnedAt(next) - 1000;
    else if (!next) at = this.folderPinnedAt(prev) + 1000;
    else at = (this.folderPinnedAt(prev) + this.folderPinnedAt(next)) / 2;
    this.plugin.settings.folderPanelPinnedAt = this.plugin.settings.folderPanelPinnedAt ?? {};
    this.plugin.settings.folderPanelPinnedAt[StashpadFolderPanelView.clean(moved)] = at;
    await this.plugin.saveSettings();
    this.render();
  }

  private renderFolderRow(list: HTMLElement, folder: string, open: Set<string>): HTMLElement {
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

    // 0.105.1: reveal this folder's Home list-pinned notes inline. The chevron
    // shows only when the folder has any; clicking toggles a sub-list below the
    // row. stopPropagation so it doesn't trigger the row's folder navigation.
    const homePinned = this.folderHomePinnedNotes(folder);
    const pinKey = StashpadFolderPanelView.clean(folder);
    const pinsExpanded = this.folderPinExpanded.has(pinKey);
    if (homePinned.length > 0) {
      const chev = row.createSpan({ cls: "stashpad-folderpanel-pinreveal" });
      renderCountBadge(chev, homePinned.length, pinsExpanded);
      chev.setAttr("aria-label", pinsExpanded ? "Hide pinned notes" : `${homePinned.length} pinned note${homePinned.length === 1 ? "" : "s"}`);
      chev.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
      chev.onclick = (e) => {
        e.stopPropagation();
        if (this.folderPinExpanded.has(pinKey)) this.folderPinExpanded.delete(pinKey);
        else this.folderPinExpanded.add(pinKey);
        this.render();
      };
    }

    // 0.95.1: per-folder icon. Tinted by the folder's Home-note color when set.
    // 0.98.37: archive folders show the ARCHIVE icon in place of the folder icon
    // (one icon instead of folder + a separate badge).
    const isArchive = this.plugin.isArchiveFolder(folder);
    const folderIcon = row.createSpan({ cls: "stashpad-folderpanel-folder-icon" });
    // 0.118.0: a user-set per-folder icon wins; otherwise archive folders show
    // the archive glyph and everything else the generic folder icon.
    setIcon(folderIcon, this.plugin.getFolderIcon(folder) ?? (isArchive ? "archive" : "folder"));
    // 0.134.4 (B3): archives are plaintext by default now — don't claim auto-encryption.
    if (isArchive) folderIcon.setAttr("aria-label", "Archive folder — de-indexed from search");
    const homeColor = this.folderHomeColor(folder);
    if (homeColor) folderIcon.style.color = homeColor;

    const name = folder.split("/").pop() || folder;
    row.createSpan({ cls: "stashpad-folderpanel-row-label", text: name });

    // 0.98.37: reveal-in-file-explorer moved to the context menu only; keep the
    // open-in-new-tab quick button.
    const actions = row.createDiv({ cls: "stashpad-folderpanel-actions" });
    // 0.199.0: when "Folders always open in a new tab" is on, a per-row
    // new-tab button is redundant (the row click already opens a new tab).
    if (!this.plugin.settings.foldersAlwaysNewTab) {
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
    }

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

    // 0.105.1: when expanded, list the folder's Home list-pinned notes as a
    // sub-list below the folder row. Clicking one reveals it in its Stashpad.
    if (homePinned.length > 0 && pinsExpanded) {
      const box = list.createDiv({ cls: "stashpad-folderpanel-pinlist" });
      for (const f of homePinned) {
        const prow = box.createDiv({ cls: "stashpad-folderpanel-pinrow" });
        const fmc = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as any;
        const pic = prow.createSpan({ cls: "stashpad-folderpanel-pinrow-icon" });
        setIcon(pic, "arrow-up-to-line");
        if (typeof fmc.color === "string") pic.style.color = fmc.color;
        prow.createSpan({ cls: "stashpad-folderpanel-pinrow-label", text: this.titleFromFile(f) });
        prow.onclick = () => { this.onNavigateAway(); void this.plugin.revealNoteInStashpad(f); };
      }
    }
    return row;
  }

  /** A folder's ROOT-level (Home) list-pinned notes — backs the folder-panel
   *  reveal. Reuses childrenOf(folder, ROOT_ID) + the listPinned frontmatter. */
  private folderHomePinnedNotes(folder: string): TFile[] {
    return this.childrenOf(folder, ROOT_ID).filter((f) =>
      (this.app.metadataCache.getFileCache(f)?.frontmatter as any)?.listPinned === true);
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
    // 0.215.0: hand off to the OS file manager. Desktop only — mobile has no
    // file manager to reveal into, so the entry is hidden rather than shown
    // and failing. Distinct from the entry above, which reveals in Obsidian's
    // OWN file explorer view.
    if (canRevealInOs()) {
      menu.addItem((i) => i.setTitle(`Open in ${osFileManagerName()}`).setIcon("app-window")
        .onClick(() => revealInOsFileManager(this.app, folder)));
    }
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
      // (0.136.0: "Mark as archive folder" is gone — every folder owns an
      // `archive/` subfolder now; use "Move selection to archive" in a list, or
      // the aggregated Archived view to browse. Encryption of archived notes is
      // the per-folder "Encrypt archived notes" setting.)

      // 0.98.31: open the encrypted-trash tab (recoverable secure-deleted notes).
      menu.addItem((i) => i.setTitle("Open trash").setIcon("rotate-ccw")
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
      // 0.140.3 (review): re-validate — the folder could've moved/been deleted
      // by sync while the rename modal sat open.
      if (!(this.app.vault.getAbstractFileByPath(cleaned) instanceof TFolder)) { new Notice("That folder no longer exists."); return; }
      try {
        await this.app.fileManager.renameFile(tf, target);
        // 0.140.3: carry ALL path-keyed settings (default folder + placement +
        // archive + per-folder prefs, incl. descendants) to the new path.
        await this.plugin.remapFolderPathInSettings(cleaned, target);
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
    // 0.213.2: deleting a folder takes its _attachments with it, so notes in
    // OTHER folders that embed those files lose their images with no warning
    // and no obvious cause. Say so before the delete, not after — this is the
    // one moment the user can still act on it.
    const outside = this.plugin.outsideReferencesToFolderAttachments(cleaned);
    const lines = [
      `This moves the entire folder — about ${noteCount} note${noteCount === 1 ? "" : "s"} plus its attachments and exports — to the trash.`,
      "You can restore it from your system/Obsidian trash.",
    ];
    if (outside.paths.length) {
      lines.push(
        "",
        `⚠️ ${outside.paths.length} attachment${outside.paths.length === 1 ? "" : "s"} in **${name}** ${outside.paths.length === 1 ? "is" : "are"} used by notes in ${outside.folders.length} other folder${outside.folders.length === 1 ? "" : "s"}: ${outside.folders.map((f) => `**${f}**`).join(", ")}.`,
        `Deleting **${name}** breaks ${outside.paths.length === 1 ? "that embed" : "those embeds"} — the notes stay, but the ${outside.paths.length === 1 ? "image" : "images"} stop resolving.`,
        // 0.214.2: the files themselves are rendered below as CLICKABLE rows
        // (setFileList) rather than inlined here as text. The user is being
        // asked to decide about these specific files, which they cannot do
        // without looking at them — and the list is unbounded, so it needs its
        // own capped scroll region rather than growing the modal.
        `Click any of them to open it${outside.paths.length > 1 ? "" : ""}:`,
        `To keep ${outside.paths.length === 1 ? "it" : "them"}, move ${outside.paths.length === 1 ? "the file" : "those files"} out of **${name}** first, or restore the folder from the trash afterwards.`,
      );
    }
    const modal = new ConfirmModal(
      this.app,
      `Delete "${name}"?`,
      lines.join("\n"),
      "Delete folder",
      async (confirmed) => {
        if (!confirmed) return;
        // Closes open tabs, moves the folder to .trash, and posts a persistent
        // notification with an Undo action (move-back). The vault "delete"
        // listener is suppressed for this path so it won't double-notify.
        await this.plugin.deleteStashpadFolderWithUndo(tf);
      },
      "Cancel",
      // Focus Cancel when this delete would break notes elsewhere, so a stray
      // Enter can't confirm it.
      outside.paths.length > 0,
    );
    // Every affected file, not a truncated sample — the scroll region makes a
    // long list safe, so there is no reason to hide any of them.
    if (outside.paths.length) modal.setFileList(outside.paths);
    modal.open();
  }

  /** 0.140.3 (review): run any in-flight divider-drag cleanup on view close so
   *  a mid-drag detach doesn't leak the document pointer listeners. */
  async onClose(): Promise<void> { this.dividerCleanup?.(); this.contentEl.empty(); }
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
    const input = this.contentEl.createEl("input", { type: "text" });
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
