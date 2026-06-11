import { ItemView, WorkspaceLeaf, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_TRASH_VIEW_TYPE } from "./types";

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
    restoreAll.onclick = async () => { restoreAll.disabled = true; await this.plugin.restoreAllTrash(); await this.render(); };

    // Group by origin folder; obscured-title notes (no readable origin on disk)
    // go under "Hidden" so we don't reveal where they came from.
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

      for (const it of groups.get(key)!) {
        const row = group.createDiv({ cls: "stashpad-trash-row" });
        const main = row.createDiv({ cls: "stashpad-trash-row-main" });
        main.createSpan({ cls: "stashpad-trash-title", text: hidden ? "Locked note" : (it.meta?.title || "Locked note") });
        const when = it.meta?.deletedAt ? `deleted ${momentFn(it.meta.deletedAt).fromNow()}` : "deleted";
        const count = it.meta && it.meta.count > 1 ? ` · ${it.meta.count} ${it.meta.kind === "rawtrash" ? "files" : "notes"}` : "";
        main.createSpan({ cls: "stashpad-trash-sub", text: when + count });
        const btn = row.createEl("button", { cls: "stashpad-trash-restore", text: "Restore" });
        setIcon(btn.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
        btn.onclick = async () => { btn.disabled = true; const ok = await this.plugin.restoreDeletedAt(it.blob); if (ok) await this.render(); else btn.disabled = false; };
      }
    }
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
