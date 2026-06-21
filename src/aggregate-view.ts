import { ItemView, WorkspaceLeaf, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_AGGREGATE_VIEW_TYPE } from "./types";

// Obsidian types `moment` as a namespace (not callable); cast to a callable.
const momentFn = moment as unknown as (...args: unknown[]) => { fromNow: () => string };

export type AggregateMode = "encrypted" | "archived";

interface AggregateState { mode: AggregateMode }

/** Per-folder overhaul (Phase A): an on-the-fly "database" tab that lists notes by
 *  state across the WHOLE vault, so you can check everything at a glance. Two
 *  modes (set via view state):
 *
 *   - "encrypted" — every locked subtree (from `settings.lockedSubtrees`), grouped
 *     by the folder it lives in.
 *   - "archived"  — every archive folder (legacy `archiveFolders[]` ∪ the new
 *     per-folder `folderEncPrefs[f].archive`), with its locked-subtree count.
 *
 *  Read-only by design: notes stay in place (no physical aggregate folder, no
 *  cross-key re-encryption). Rows you can't decrypt show as locked, not content —
 *  this view never decrypts. Each row/group can OPEN the owning Stashpad folder.
 *  The "deleted" aggregate is the existing `StashpadTrashView`. */
export class StashpadAggregateView extends ItemView {
  private mode: AggregateMode = "encrypted";

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  getViewType(): string { return STASHPAD_AGGREGATE_VIEW_TYPE; }
  getDisplayText(): string { return this.mode === "archived" ? "All archived" : "All encrypted"; }
  getIcon(): string { return this.mode === "archived" ? "archive" : "lock"; }

  getState(): Record<string, unknown> { return { ...super.getState(), mode: this.mode }; }
  async setState(state: AggregateState, result: unknown): Promise<void> {
    if (state?.mode === "archived" || state?.mode === "encrypted") this.mode = state.mode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await super.setState(state, result as any);
    await this.render();
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("stashpad-aggregate-view");
    // Refresh when locked bundles appear/disappear anywhere outside _deleted/.
    const touch = (p: string) => p.endsWith(".stashenc") && !p.startsWith("_deleted/");
    this.registerEvent(this.app.vault.on("create", (f) => { if (touch(f.path)) this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (touch(f.path)) this.scheduleRender(); }));
    await this.render();
  }

  private renderPending = false;
  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    window.setTimeout(() => { this.renderPending = false; void this.render(); }, 150);
  }

  private cleanFolder(p: string): string { return (p || "").replace(/\/+$/, ""); }

  /** All folders flagged as archive — legacy list ∪ new per-folder prefs. */
  private archiveFolders(): string[] {
    const set = new Set<string>((this.plugin.settings.archiveFolders ?? []).map((f) => this.cleanFolder(f)));
    const prefs = this.plugin.settings.folderEncPrefs ?? {};
    for (const [folder, p] of Object.entries(prefs)) if (p?.archive) set.add(this.cleanFolder(folder));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-aggregate-body");

    const header = root.createDiv({ cls: "stashpad-aggregate-header" });
    header.createEl("h3", { text: this.getDisplayText() });
    const refresh = header.createEl("button", { cls: "stashpad-trash-iconbtn" });
    setIcon(refresh, "refresh-cw");
    refresh.setAttr("aria-label", "Refresh");
    refresh.onclick = () => void this.render();

    if (this.mode === "archived") { this.renderArchived(root); return; }
    this.renderEncrypted(root);
  }

  private renderEncrypted(root: HTMLElement): void {
    const locked = this.plugin.settings.lockedSubtrees ?? [];
    if (locked.length === 0) {
      root.createDiv({ cls: "stashpad-trash-empty", text: "Nothing is encrypted yet. Lock a note or folder and it shows up here." });
      return;
    }
    // Group by the folder the blob lives in.
    const groups = new Map<string, typeof locked>();
    for (const e of locked) {
      const key = this.cleanFolder(e.folder) || "(vault root)";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
    }
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    root.createDiv({ cls: "stashpad-aggregate-sub", text: `${locked.length} locked ${locked.length === 1 ? "item" : "items"} in ${keys.length} ${keys.length === 1 ? "folder" : "folders"}.` });

    for (const key of keys) {
      const group = root.createDiv({ cls: "stashpad-trash-group" });
      const head = group.createDiv({ cls: "stashpad-trash-group-head" });
      setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "folder");
      head.createSpan({ text: key.split("/").pop() || key });
      head.createSpan({ cls: "stashpad-trash-group-count", text: String(groups.get(key)!.length) });
      const open = head.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Open" });
      open.onclick = () => void this.plugin.activateViewForFolder(key);

      for (const e of groups.get(key)!) {
        const row = group.createDiv({ cls: "stashpad-trash-row" });
        const main = row.createDiv({ cls: "stashpad-trash-row-main" });
        main.createSpan({ cls: "stashpad-trash-title", text: e.title || "Locked note" });
        const when = e.created ? `locked ${momentFn(e.created).fromNow()}` : "locked";
        const count = e.count > 1 ? ` · ${e.count} notes` : "";
        main.createSpan({ cls: "stashpad-trash-sub", text: when + count });
        const exp = row.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Export" });
        exp.setAttr("aria-label", "Export to .stash (encrypted with a password you choose)");
        exp.onclick = () => void this.plugin.exportLockedSubtree(e.blob);
        const lock = row.createSpan({ cls: "stashpad-aggregate-lockbadge" });
        setIcon(lock, "lock");
      }
    }
  }

  private renderArchived(root: HTMLElement): void {
    const folders = this.archiveFolders();
    if (folders.length === 0) {
      root.createDiv({ cls: "stashpad-trash-empty", text: "No archive folders yet. Toggle Archive on a folder to collect it here." });
      return;
    }
    const archiveSet = new Set(folders);
    const locked = this.plugin.settings.lockedSubtrees ?? [];
    // Group the locked subtrees that live in an archive folder, by folder — so this
    // mirrors "All encrypted": notes listed under each archive folder, not just a count.
    const byFolder = new Map<string, typeof locked>();
    for (const e of locked) {
      const f = this.cleanFolder(e.folder);
      if (!archiveSet.has(f)) continue;
      (byFolder.get(f) ?? byFolder.set(f, []).get(f)!).push(e);
    }
    const total = [...byFolder.values()].reduce((n, a) => n + a.length, 0);
    root.createDiv({ cls: "stashpad-aggregate-sub", text: `${folders.length} archive ${folders.length === 1 ? "folder" : "folders"}, ${total} archived ${total === 1 ? "item" : "items"}.` });

    for (const folder of folders) {
      const items = byFolder.get(folder) ?? [];
      const group = root.createDiv({ cls: "stashpad-trash-group" });
      const head = group.createDiv({ cls: "stashpad-trash-group-head" });
      setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "archive");
      head.createSpan({ text: folder.split("/").pop() || folder });
      head.createSpan({ cls: "stashpad-trash-group-count", text: String(items.length) });
      const open = head.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Open" });
      open.onclick = () => void this.plugin.activateViewForFolder(folder);
      if (items.length === 0) { group.createDiv({ cls: "stashpad-trash-sub", text: "No archived (locked) items." }); continue; }
      for (const e of items) {
        const row = group.createDiv({ cls: "stashpad-trash-row" });
        const main = row.createDiv({ cls: "stashpad-trash-row-main" });
        main.createSpan({ cls: "stashpad-trash-title", text: e.title || "Locked note" });
        const when = e.created ? `archived ${momentFn(e.created).fromNow()}` : "archived";
        const count = e.count > 1 ? ` · ${e.count} notes` : "";
        main.createSpan({ cls: "stashpad-trash-sub", text: when + count });
        const exp = row.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Export" });
        exp.setAttr("aria-label", "Export to .stash (encrypted with a password you choose)");
        exp.onclick = () => void this.plugin.exportLockedSubtree(e.blob);
        const lock = row.createSpan({ cls: "stashpad-aggregate-lockbadge" });
        setIcon(lock, "lock");
      }
    }
  }

  async onClose(): Promise<void> { this.contentEl.empty(); }
}

/** Open (or reveal) an aggregate tab for the given mode. Reuses an existing tab of
 *  the same mode if one is open. */
export async function openAggregateView(plugin: StashpadPlugin, mode: AggregateMode): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(STASHPAD_AGGREGATE_VIEW_TYPE)
    .find((l) => (l.view as StashpadAggregateView)?.getState?.().mode === mode);
  if (existing) { workspace.revealLeaf(existing); return; }
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_AGGREGATE_VIEW_TYPE, active: true, state: { mode } });
  workspace.revealLeaf(leaf);
}
