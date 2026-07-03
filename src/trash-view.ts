import { ItemView, Notice, WorkspaceLeaf, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_TRASH_VIEW_TYPE } from "./types";
import { ConfirmModal } from "./modals";
import type { DeletedMeta } from "./encryption-ops";
import { renderAggModeBar, type AggMode } from "./agg-modes";
import { returnToOriginOnClose } from "./leaf-return";

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
  getDisplayText(): string { return "Trash"; }
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
  /** Shift-range anchor stored as a BLOB PATH (not an index): a restore/purge
   *  rebuilds `order` shorter, so an index anchor would point at the wrong row
   *  afterward. We re-derive the index from this path at shift-click. (0.140.7) */
  private anchorBlob: string | null = null;
  /** 0.130.0: shared view mode (same set as the Archive tab). Default per-folder. */
  private trashMode: AggMode = "byfolder";

  async render(): Promise<void> {
    const gen = ++this.renderGen;
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-trash-view-body");
    // Reset the shift-range order at the TOP so "mixed" mode (which returns
    // before the old reset point) can't leave a stale list for Mod+A. (0.140.7)
    this.order = [];

    const header = root.createDiv({ cls: "stashpad-trash-view-header" });
    header.createEl("h3", { text: "Trash" });
    const refresh = header.createEl("button", { cls: "stashpad-trash-iconbtn" });
    setIcon(refresh, "refresh-cw");
    refresh.setAttr("aria-label", "Refresh");
    refresh.onclick = () => void this.render();

    // 0.126.3: unified trash — encrypted (`_deleted/`) AND unencrypted Stashpad
    // notes sitting in Obsidian's `.trash/` (where plain deletes go when
    // "Encrypt items sent to trash" is off). Either may be empty.
    const items = this.plugin.encryption?.isConfigured?.() ? await this.plugin.listDeletedTrash() : [];
    if (gen !== this.renderGen) return; // a newer render superseded this one
    const rawItems = await this.plugin.listRawTrashStashpadNotes();
    if (gen !== this.renderGen) return;

    if (items.length === 0 && rawItems.length === 0) {
      root.createDiv({ cls: "stashpad-trash-empty", text: "Trash is empty. Securely-deleted notes land in the encrypted trash; plain deletes go to Obsidian's trash — both show here." });
      return;
    }

    // 0.130.0: shared view-mode chips (same set as the Archive tab).
    renderAggModeBar(root, this.trashMode,
      { total: items.length + rawItems.length, enc: items.length, dec: rawItems.length },
      (m) => { this.trashMode = m; this.clearSelection(); void this.render(); });

    if (this.trashMode === "mixed") { this.renderMixed(root, items, rawItems); return; }

    const showEnc = this.trashMode !== "unencrypted" && items.length > 0;
    const showRaw = this.trashMode !== "encrypted" && rawItems.length > 0;
    if (!showEnc && !showRaw) { root.createDiv({ cls: "stashpad-trash-empty", text: "Nothing in this view." }); return; }

    // Restore-all + selection bar whenever encrypted rows are shown.
    if (showEnc) {
      const restoreAll = header.createEl("button", { cls: "stashpad-trash-restore", text: "Restore all" });
      setIcon(restoreAll.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
      restoreAll.onclick = async () => { restoreAll.disabled = true; await this.plugin.restoreAllTrash(); this.clearSelection(); await this.render(); };
      const present = new Set(items.map((it) => it.blob));
      for (const b of [...this.selected]) if (!present.has(b)) this.selected.delete(b);
      if (this.selected.size > 0) {
        const bar = root.createDiv({ cls: "stashpad-trash-selbar" });
        bar.createSpan({ cls: "stashpad-trash-selcount", text: `${this.selected.size} selected` });
        const restoreSel = bar.createEl("button", { cls: "stashpad-trash-restore", text: "Restore selected" });
        restoreSel.onclick = async () => {
          restoreSel.disabled = true;
          // Surface partial failures — silent:true suppresses per-item notices,
          // so without this a key-locked item left behind reads as success. (0.140.7)
          let failed = 0;
          for (const b of [...this.selected]) { if (!(await this.plugin.restoreDeletedAt(b, { silent: true }))) failed++; }
          if (failed > 0) new Notice(`${failed} item${failed === 1 ? "" : "s"} couldn't be restored (locked key?) — still in trash.`);
          this.clearSelection();
          await this.render();
        };
        const delSel = bar.createEl("button", { cls: "stashpad-trash-delete mod-warning", text: "Delete selected" });
        delSel.onclick = () => this.confirmPurge([...this.selected]);
        const clear = bar.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Clear" });
        clear.onclick = () => { this.clearSelection(); void this.render(); };
      }
    }

    this.order = []; // rebuilt as encrypted rows render (for shift-range select)

    if (showEnc) {
      if (this.trashMode === "byfolder") {
        // Encrypted grouped by ORIGIN folder; obscured-title notes go under "Hidden".
        const groups = new Map<string, typeof items>();
        for (const it of items) {
          const key = it.meta?.title ? (it.meta.originalFolder || "(unknown folder)") : " hidden";
          (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
        }
        const keys = [...groups.keys()].sort((a, b) => (a === " hidden" ? 1 : b === " hidden" ? -1 : a.localeCompare(b)));
        for (const key of keys) {
          const hidden = key === " hidden";
          const group = root.createDiv({ cls: "stashpad-trash-group" });
          const head = group.createDiv({ cls: "stashpad-trash-group-head" });
          setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), hidden ? "lock" : "folder");
          head.createSpan({ text: hidden ? "Hidden (title obscured)" : (key.split("/").pop() || key) });
          head.createSpan({ cls: "stashpad-trash-group-count", text: String(groups.get(key)!.length) });
          for (const it of groups.get(key)!) this.encRow(group, it, hidden);
        }
      } else {
        // separated / encrypted-only → one flat "Encrypted" section.
        const group = root.createDiv({ cls: "stashpad-trash-group" });
        const head = group.createDiv({ cls: "stashpad-trash-group-head" });
        setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "lock");
        head.createSpan({ text: "Encrypted" });
        head.createSpan({ cls: "stashpad-trash-group-count", text: String(items.length) });
        for (const it of items) this.encRow(group, it, !it.meta?.title);
      }
    }

    if (showRaw) this.renderRawSection(root, rawItems);
  }

  /** One encrypted-trash row (multi-select + restore/purge). Pushes into
   *  this.order for shift-range selection. */
  private encRow(container: HTMLElement, it: { blob: string; meta: DeletedMeta | null }, hidden: boolean): void {
    const idx = this.order.length;
    this.order.push(it.blob);
    const row = container.createDiv({ cls: "stashpad-trash-row" });
    if (this.selected.has(it.blob)) row.addClass("is-selected");
    row.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button")) return; this.onRowClick(idx, it.blob, e); });
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

  /** 0.128.0: MIXED mode — encrypted + unencrypted interleaved in one flat list,
   *  newest-deleted first. No multi-select here (kept simple); per-row restore. */
  private renderMixed(
    root: HTMLElement,
    enc: Array<{ blob: string; meta: DeletedMeta | null }>,
    raw: Array<{ path: string; name: string; title: string; mtime: number }>,
  ): void {
    type Unified = { ts: number; kind: "enc" | "raw"; enc?: typeof enc[number]; raw?: typeof raw[number] };
    const rows: Unified[] = [];
    for (const it of enc) rows.push({ ts: it.meta?.deletedAt ? (Date.parse(String(it.meta.deletedAt)) || 0) : 0, kind: "enc", enc: it });
    for (const it of raw) rows.push({ ts: it.mtime || 0, kind: "raw", raw: it });
    rows.sort((a, b) => b.ts - a.ts);

    const list = root.createDiv({ cls: "stashpad-trash-group" });
    for (const u of rows) {
      const row = list.createDiv({ cls: "stashpad-trash-row" });
      const main = row.createDiv({ cls: "stashpad-trash-row-main" });
      const badge = main.createSpan({ cls: `stashpad-trash-kind is-${u.kind}` });
      setIcon(badge, u.kind === "enc" ? "lock" : "trash");
      if (u.kind === "enc" && u.enc) {
        const it = u.enc;
        const hidden = !it.meta?.title;
        main.createSpan({ cls: "stashpad-trash-title", text: hidden ? "Locked note" : (it.meta?.title || "Locked note") });
        const when = it.meta?.deletedAt ? `deleted ${momentFn(it.meta.deletedAt).fromNow()}` : "deleted";
        main.createSpan({ cls: "stashpad-trash-sub", text: `${when} · encrypted` });
        const btn = row.createEl("button", { cls: "stashpad-trash-restore", text: "Restore" });
        setIcon(btn.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
        btn.onclick = async () => { btn.disabled = true; const ok = await this.plugin.restoreDeletedAt(it.blob); if (ok) await this.render(); else btn.disabled = false; };
        const del = row.createEl("button", { cls: "stashpad-trash-delete", attr: { "aria-label": "Delete permanently" } });
        setIcon(del, "trash-2");
        del.onclick = () => this.confirmPurge([it.blob]);
      } else if (u.raw) {
        const it = u.raw;
        main.createSpan({ cls: "stashpad-trash-title", text: it.title });
        const when = it.mtime ? `deleted ${momentFn(it.mtime).fromNow()}` : "in Obsidian trash";
        main.createSpan({ cls: "stashpad-trash-sub", text: `${when} · unencrypted` });
        const btn = row.createEl("button", { cls: "stashpad-trash-restore", text: "Restore" });
        setIcon(btn.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
        btn.onclick = async () => { btn.disabled = true; const ok = await this.plugin.restoreRawTrashNote(it.path); if (ok) await this.render(); else btn.disabled = false; };
      }
    }
  }

  /** 0.126.3: section for Stashpad notes sitting UNENCRYPTED in Obsidian's
   *  `.trash/` (plain deletes when encrypt-trash is off). Restore moves them back
   *  to the default Stashpad folder. */
  private renderRawSection(root: HTMLElement, rawItems: Array<{ path: string; name: string; title: string; mtime: number }>): void {
    if (rawItems.length === 0) return;
    const group = root.createDiv({ cls: "stashpad-trash-group" });
    const head = group.createDiv({ cls: "stashpad-trash-group-head" });
    setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "trash");
    head.createSpan({ text: "Obsidian trash (unencrypted)" });
    head.createSpan({ cls: "stashpad-trash-group-count", text: String(rawItems.length) });

    for (const it of rawItems) {
      const row = group.createDiv({ cls: "stashpad-trash-row" });
      const main = row.createDiv({ cls: "stashpad-trash-row-main" });
      main.createSpan({ cls: "stashpad-trash-title", text: it.title });
      const when = it.mtime ? `deleted ${momentFn(it.mtime).fromNow()}` : "in Obsidian trash";
      main.createSpan({ cls: "stashpad-trash-sub", text: when });
      const btn = row.createEl("button", { cls: "stashpad-trash-restore", text: "Restore" });
      setIcon(btn.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
      btn.onclick = async () => { btn.disabled = true; const ok = await this.plugin.restoreRawTrashNote(it.path); if (ok) await this.render(); else btn.disabled = false; };
    }
  }

  private clearSelection(): void { this.selected.clear(); this.anchorBlob = null; }

  /** Select every trash item (Mod+A). No-op when the list is empty. */
  private selectAll(): void {
    if (this.order.length === 0) return;
    for (const b of this.order) this.selected.add(b);
    this.anchorBlob = this.order[this.order.length - 1] ?? null;
    void this.render();
  }

  /** Selection click with cmd/ctrl (toggle), shift (range), plain (single). */
  private onRowClick(idx: number, blob: string, e: MouseEvent): void {
    // Re-derive the anchor index from its blob path — a restore/purge may have
    // shifted rows since the anchor was set. A vanished anchor → treat as none.
    const anchorIdx = this.anchorBlob !== null ? this.order.indexOf(this.anchorBlob) : -1;
    if (e.shiftKey && anchorIdx >= 0) {
      const [a, b] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
      this.selected.clear();
      for (let i = a; i <= b; i++) this.selected.add(this.order[i]);
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selected.has(blob)) this.selected.delete(blob); else this.selected.add(blob);
      this.anchorBlob = blob;
    } else {
      if (this.selected.size === 1 && this.selected.has(blob)) this.selected.clear();
      else { this.selected.clear(); this.selected.add(blob); }
      this.anchorBlob = blob;
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
      },
      "Cancel",
      // Permanent, undecryptable delete — focus Cancel so a stray Enter can't
      // purge irreversibly. (0.140.7)
      /*dangerous*/ true,
    ).open();
  }

  async onClose(): Promise<void> { this.contentEl.empty(); }
}

/** Open (or reveal) the encrypted-trash tab in the main editor area. */
export async function openTrashView(plugin: StashpadPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(STASHPAD_TRASH_VIEW_TYPE);
  if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
  // 0.133.0: closing the trash view returns to the tab it was opened from.
  const originLeaf = workspace.getMostRecentLeaf();
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_TRASH_VIEW_TYPE, active: true });
  workspace.revealLeaf(leaf);
  returnToOriginOnClose(workspace, leaf, originLeaf, (ref) => plugin.registerEvent(ref));
}
