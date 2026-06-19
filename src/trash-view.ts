import { ItemView, WorkspaceLeaf, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_TRASH_VIEW_TYPE } from "./types";
import { ConfirmModal } from "./modals";

// Obsidian types `moment` as the namespace (not callable); cast to a callable.
const momentFn = moment as unknown as (...args: unknown[]) => { fromNow: () => string };

/** 0.98.35 (Phase 5): the dedicated encrypted-trash TAB. Lists every note in
 *  `_deleted/`, grouped under a header per ORIGIN folder (each folder's deleted
 *  notes nested beneath it), each row with a Restore button. A standalone leaf
 *  (vs. the old modal) so it scales when the trash gets large, and it refreshes
 *  itself when the vault's `_deleted/` contents change. Notes deleted with
 *  hide-titles ON have no readable title/origin on disk → shown under "Hidden". */
export class StashpadTrashView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  getViewType(): string { return STASHPAD_TRASH_VIEW_TYPE; }
  getDisplayText(): string { return "Encrypted trash"; }
  getIcon(): string { return "trash-2"; }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("stashpad-trash-view");
    // Refresh when _deleted/ changes (a delete/restore elsewhere) — cheap; render
    // re-reads the store. Debounced via a microtask guard.
    this.registerEvent(this.app.vault.on("create", (f) => { if (f.path.startsWith("_deleted/")) this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (f.path.startsWith("_deleted/")) this.scheduleRender(); }));
    // 0.112.4: Mod+A selects every trash item — but only while THIS tab is the
    // active leaf, and not while typing in a field.
    this.registerDomEvent(document, "keydown", (e) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "a" || e.key === "A")) {
        if (this.order.length === 0) return;
        e.preventDefault();
        this.selectAll();
      }
    });
    await this.render();
  }

  private renderPending = false;
  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    window.setTimeout(() => { this.renderPending = false; void this.render(); }, 150);
  }

  /** Bumped per render; an interleaved newer render aborts the older one after
   *  each await (render is async + called from buttons/events — two in flight
   *  would each empty-then-append, duplicating rows). */
  private renderGen = 0;
  /** 0.112.3: multi-select state. `selected` holds blob paths; `order` is the
   *  flat render order (for shift-range); `anchorIdx` is the last clicked row. */
  private selected = new Set<string>();
  private order: string[] = [];
  private anchorIdx: number | null = null;

  async render(): Promise<void> {
    const gen = ++this.renderGen;
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-trash-view-body");

    const header = root.createDiv({ cls: "stashpad-trash-view-header" });
    header.createEl("h3", { text: "Encrypted trash" });
    const refresh = header.createEl("button", { cls: "stashpad-trash-iconbtn" });
    setIcon(refresh, "refresh-cw");
    refresh.setAttr("aria-label", "Refresh");
    refresh.onclick = () => void this.render();

    if (!this.plugin.encryption?.isConfigured?.()) {
      root.createDiv({ cls: "stashpad-trash-empty", text: "Encryption isn't set up." });
      return;
    }
    const items = await this.plugin.listDeletedTrash();
    if (gen !== this.renderGen) return; // a newer render superseded this one
    if (items.length === 0) {
      root.createDiv({ cls: "stashpad-trash-empty", text: "Nothing in the encrypted trash. Notes you securely delete land here, recoverable with your password." });
      return;
    }

    const restoreAll = header.createEl("button", { cls: "stashpad-trash-restore", text: "Restore all" });
    setIcon(restoreAll.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
    restoreAll.onclick = async () => { restoreAll.disabled = true; await this.plugin.restoreAllTrash(); this.clearSelection(); await this.render(); };

    // Drop any selected paths that no longer exist (restored/purged elsewhere).
    const present = new Set(items.map((it) => it.blob));
    for (const b of [...this.selected]) if (!present.has(b)) this.selected.delete(b);

    // Selection action bar (only when something is selected).
    if (this.selected.size > 0) {
      const bar = root.createDiv({ cls: "stashpad-trash-selbar" });
      bar.createSpan({ cls: "stashpad-trash-selcount", text: `${this.selected.size} selected` });
      const restoreSel = bar.createEl("button", { cls: "stashpad-trash-restore", text: "Restore selected" });
      restoreSel.onclick = async () => {
        restoreSel.disabled = true;
        for (const b of [...this.selected]) await this.plugin.restoreDeletedAt(b, { silent: true });
        this.clearSelection(); await this.render();
      };
      const delSel = bar.createEl("button", { cls: "stashpad-trash-delete mod-warning", text: "Delete selected" });
      delSel.onclick = () => this.confirmPurge([...this.selected]);
      const clear = bar.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Clear" });
      clear.onclick = () => { this.clearSelection(); void this.render(); };
    }

    // Group by origin folder; obscured-title notes (no readable origin on disk)
    // go under "Hidden" so we don't reveal where they came from.
    const groups = new Map<string, typeof items>();
    for (const it of items) {
      const key = it.meta?.title ? (it.meta.originalFolder || "(unknown folder)") : " hidden";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === " hidden" ? 1 : b === " hidden" ? -1 : a.localeCompare(b)));

    // Rebuild the flat render order for shift-range selection.
    this.order = [];

    for (const key of keys) {
      const hidden = key === " hidden";
      const group = root.createDiv({ cls: "stashpad-trash-group" });
      const head = group.createDiv({ cls: "stashpad-trash-group-head" });
      setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), hidden ? "lock" : "folder");
      head.createSpan({ text: hidden ? "Hidden (title obscured)" : (key.split("/").pop() || key) });
      head.createSpan({ cls: "stashpad-trash-group-count", text: String(groups.get(key)!.length) });

      for (const it of groups.get(key)!) {
        const idx = this.order.length;
        this.order.push(it.blob);
        const row = group.createDiv({ cls: "stashpad-trash-row" });
        if (this.selected.has(it.blob)) row.addClass("is-selected");
        // Click the row body to (multi-)select; cmd/ctrl toggles, shift ranges.
        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button")) return; // let buttons act
          this.onRowClick(idx, it.blob, e);
        });
        const main = row.createDiv({ cls: "stashpad-trash-row-main" });
        main.createSpan({ cls: "stashpad-trash-title", text: hidden ? "Locked note" : (it.meta?.title || "Locked note") });
        const when = it.meta?.deletedAt ? `deleted ${momentFn(it.meta.deletedAt).fromNow()}` : "deleted";
        const count = it.meta && it.meta.count > 1 ? ` · ${it.meta.count} ${it.meta.kind === "rawtrash" ? "files" : "notes"}` : "";
        main.createSpan({ cls: "stashpad-trash-sub", text: when + count });
        const btn = row.createEl("button", { cls: "stashpad-trash-restore", text: "Restore" });
        setIcon(btn.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
        btn.onclick = async () => { btn.disabled = true; const ok = await this.plugin.restoreDeletedAt(it.blob); if (ok) await this.render(); else btn.disabled = false; };
        const del = row.createEl("button", { cls: "stashpad-trash-delete", attr: { "aria-label": "Delete permanently" } });
        setIcon(del, "trash-2");
        del.onclick = () => this.confirmPurge([it.blob]);
      }
    }
  }

  private clearSelection(): void { this.selected.clear(); this.anchorIdx = null; }

  /** Select every trash item (Mod+A). No-op when the list is empty. */
  private selectAll(): void {
    if (this.order.length === 0) return;
    for (const b of this.order) this.selected.add(b);
    this.anchorIdx = this.order.length - 1;
    void this.render();
  }

  /** Selection click with cmd/ctrl (toggle), shift (range), plain (single). */
  private onRowClick(idx: number, blob: string, e: MouseEvent): void {
    if (e.shiftKey && this.anchorIdx !== null) {
      const [a, b] = this.anchorIdx < idx ? [this.anchorIdx, idx] : [idx, this.anchorIdx];
      this.selected.clear();
      for (let i = a; i <= b; i++) this.selected.add(this.order[i]);
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selected.has(blob)) this.selected.delete(blob); else this.selected.add(blob);
      this.anchorIdx = idx;
    } else {
      if (this.selected.size === 1 && this.selected.has(blob)) this.selected.clear();
      else { this.selected.clear(); this.selected.add(blob); }
      this.anchorIdx = idx;
    }
    void this.render();
  }

  /** Confirm + permanently delete trash blobs (irreversible — no decrypt). */
  private confirmPurge(blobs: string[]): void {
    if (blobs.length === 0) return;
    const n = blobs.length;
    new ConfirmModal(this.app, n === 1 ? "Delete permanently?" : `Delete ${n} items permanently?`,
      `${n === 1 ? "This encrypted item" : `These ${n} encrypted items`} will be PERMANENTLY deleted and CANNOT be restored — there is no decrypted copy. Continue?`,
      "Delete forever",
      async (ok) => {
        if (!ok) return;
        for (const b of blobs) await this.plugin.purgeDeletedAt(b);
        this.clearSelection();
        await this.render();
      }).open();
  }

  async onClose(): Promise<void> { this.contentEl.empty(); }
}

/** Open (or reveal) the encrypted-trash tab in the main editor area. */
export async function openTrashView(plugin: StashpadPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(STASHPAD_TRASH_VIEW_TYPE);
  if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_TRASH_VIEW_TYPE, active: true });
  workspace.revealLeaf(leaf);
}
