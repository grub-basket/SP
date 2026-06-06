import { App, ItemView, Menu, Modal, Notice, Platform, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_FOLDER_PANEL_VIEW_TYPE, STASHPAD_VIEW_TYPE } from "./types";
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
    pinnedSection.createDiv({ cls: "stashpad-folderpanel-heading" }).setText("Pinned");
    this.renderPinned(pinnedSection.createDiv({ cls: "stashpad-folderpanel-list" }));

    // --- draggable divider ---
    const divider = root.createDiv({ cls: "stashpad-folderpanel-divider" });
    divider.createDiv({ cls: "stashpad-folderpanel-divider-grip" });
    this.attachDividerDrag(root, pinnedSection, divider);

    // --- bottom: folders (takes the rest; kept low for thumb reach on mobile) ---
    const folderSection = root.createDiv({ cls: "stashpad-folderpanel-section stashpad-folderpanel-folders" });
    folderSection.style.flex = "1 1 0";
    folderSection.createDiv({ cls: "stashpad-folderpanel-heading" }).setText("Folders");
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

  private renderPinned(list: HTMLElement): void {
    const pins = this.plugin.listPinnedNotes();
    if (pins.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "No pinned notes yet — pin a note from its right-click menu." });
      return;
    }
    for (const pin of pins) {
      const file = pin.file;
      const row = list.createEl("button", { cls: "stashpad-folderpanel-row stashpad-folderpanel-pin-row" });
      setIcon(row.createSpan({ cls: "stashpad-folderpanel-row-icon" }), "pin");
      row.createSpan({ cls: "stashpad-folderpanel-row-label", text: this.titleFromFile(file) });
      const folderName = pin.folder.split("/").pop() || pin.folder;
      row.createSpan({ cls: "stashpad-folderpanel-row-sub", text: folderName });
      row.onclick = () => { this.onNavigateAway(); void this.plugin.revealNoteInStashpad(file); };
    }
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
   *  Stashpad tab. */
  private openFolders(): Set<string> {
    const set = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const f = ((leaf.view as any)?.noteFolder ?? "").replace(/\/+$/, "");
      if (f) set.add(f);
    }
    return set;
  }

  private renderFolders(list: HTMLElement): void {
    const folders = this.plugin.discoverStashpadFolders();
    if (folders.length === 0) {
      list.createDiv({ cls: "stashpad-folderpanel-empty", text: "No Stashpad folders yet." });
      return;
    }
    const open = this.openFolders();
    for (const folder of folders) {
      const isOpen = open.has(folder.replace(/\/+$/, ""));
      const row = list.createDiv({ cls: "stashpad-folderpanel-row stashpad-folderpanel-folder-row" });
      if (isOpen) row.addClass("is-open");

      const dot = row.createSpan({ cls: "stashpad-folderpanel-dot" });
      dot.setAttr("aria-label", isOpen ? "Open in a tab" : "Not open");
      if (isOpen) dot.setAttr("title", "Open in a tab");

      const name = folder.split("/").pop() || folder;
      row.createSpan({ cls: "stashpad-folderpanel-row-label", text: name });

      const actions = row.createDiv({ cls: "stashpad-folderpanel-actions" });
      const revealBtn = actions.createEl("button", { cls: "stashpad-folderpanel-iconbtn" });
      setIcon(revealBtn, "folder-search");
      revealBtn.setAttr("aria-label", "Reveal in file explorer");
      revealBtn.onclick = (e) => { e.stopPropagation(); this.revealFolder(folder); };

      const newTabBtn = actions.createEl("button", { cls: "stashpad-folderpanel-iconbtn" });
      setIcon(newTabBtn, "plus-square");
      newTabBtn.setAttr("aria-label", "Open in new tab");
      newTabBtn.onclick = (e) => { e.stopPropagation(); this.onNavigateAway(); void this.plugin.activateViewForFolder(folder); };

      // Tapping the row jumps to the folder (reusing an open tab if there is one).
      row.onclick = () => { this.onNavigateAway(); this.jumpToFolder(folder); };
      row.oncontextmenu = (e) => { e.preventDefault(); this.openFolderMenu(e, folder); };
    }
  }

  /** Reuse an existing Stashpad tab on this folder if present; else open one. */
  private jumpToFolder(folder: string): void {
    const cleaned = folder.replace(/\/+$/, "");
    const existing = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
      .find((l) => (((l.view as any)?.noteFolder ?? "").replace(/\/+$/, "")) === cleaned);
    if (existing) { this.app.workspace.revealLeaf(existing); return; }
    void this.plugin.activateViewForFolder(folder);
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
    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil")
      .onClick(() => this.renameFolder(folder)));
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
        try {
          await this.app.fileManager.trashFile(tf);
          new Notice(`Deleted "${name}".`);
        } catch (err) {
          console.warn("[Stashpad] folder delete failed", err);
          new Notice("Delete failed (see console).");
        }
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
