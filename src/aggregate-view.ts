import { ItemView, TFile, WorkspaceLeaf, moment, setIcon, type ViewStateResult } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_AGGREGATE_VIEW_TYPE } from "./types";
import { renderTaskTriage, defaultTaskTriageState, type TaskTriageState } from "./task-render";
import { renderAggModeBar, type AggMode } from "./agg-modes";
import { returnToOriginOnClose } from "./leaf-return";

// Obsidian types `moment` as a namespace (not callable); cast to a callable.
const momentFn = moment as unknown as (...args: unknown[]) => { fromNow: () => string };

export type AggregateMode = "encrypted" | "archived" | "tasks";

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
  /** 0.126.2: filter state for the "tasks" mode (persists across re-renders). */
  private taskState: TaskTriageState = defaultTaskTriageState();
  /** 0.130.0: view mode for the "archived" tab (same chip set as Trash). */
  private archiveSubMode: AggMode = "byfolder";

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  getViewType(): string { return STASHPAD_AGGREGATE_VIEW_TYPE; }
  getDisplayText(): string { return this.mode === "archived" ? "All archived" : this.mode === "tasks" ? "All tasks" : "All encrypted"; }
  getIcon(): string { return this.mode === "archived" ? "archive" : this.mode === "tasks" ? "check-square" : "lock"; }

  getState(): Record<string, unknown> { return { ...super.getState(), mode: this.mode }; }
  async setState(state: AggregateState, result: unknown): Promise<void> {
    if (state?.mode === "archived" || state?.mode === "encrypted" || state?.mode === "tasks") this.mode = state.mode;
    await super.setState(state, result as ViewStateResult);
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

    if (this.mode === "tasks") {
      renderTaskTriage(root.createDiv(), this.app, this.plugin, this.taskState, {
        onOpen: (folder, id) => void this.plugin.revealNoteByRef(folder, id),
      });
      return;
    }
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
    // 0.129.0: also the PLAIN (unencrypted) notes living in each archive folder —
    // the "All archived" view used to show only locked subtrees. Borrows the
    // per-row restore pattern from the unified trash view.
    const plainByFolder = new Map<string, TFile[]>();
    let plainTotal = 0;
    for (const folder of folders) {
      const notes = this.plugin.archivedPlainNotesIn(folder);
      plainByFolder.set(folder, notes);
      plainTotal += notes.length;
    }
    const lockedTotal = [...byFolder.values()].reduce((n, a) => n + a.length, 0);
    const total = plainTotal + lockedTotal;
    const allPlain = folders.flatMap((f) => plainByFolder.get(f) ?? []);
    const allLocked = folders.flatMap((f) => byFolder.get(f) ?? []);
    root.createDiv({ cls: "stashpad-aggregate-sub", text: `${folders.length} archive ${folders.length === 1 ? "folder" : "folders"}, ${total} archived ${total === 1 ? "item" : "items"} (${plainTotal} plain · ${lockedTotal} locked).` });

    // 0.130.0: same view-mode chips as the Trash tab.
    renderAggModeBar(root, this.archiveSubMode, { total, enc: lockedTotal, dec: plainTotal },
      (m) => { this.archiveSubMode = m; void this.render(); });
    const mode = this.archiveSubMode;

    if (mode === "mixed") {
      type U = { ts: number; kind: "plain" | "locked"; f?: TFile; e?: typeof locked[number] };
      const rows: U[] = [];
      for (const f of allPlain) rows.push({ ts: f.stat.mtime || 0, kind: "plain", f });
      for (const e of allLocked) rows.push({ ts: e.created ? (Date.parse(e.created) || 0) : 0, kind: "locked", e });
      rows.sort((a, b) => b.ts - a.ts);
      const group = root.createDiv({ cls: "stashpad-trash-group" });
      for (const u of rows) { if (u.kind === "plain" && u.f) this.archivePlainRow(group, u.f); else if (u.e) this.archiveLockedRow(group, u.e); }
      return;
    }

    if (mode === "byfolder") {
      for (const folder of folders) {
        const items = byFolder.get(folder) ?? [];
        const plain = plainByFolder.get(folder) ?? [];
        const group = root.createDiv({ cls: "stashpad-trash-group" });
        const head = group.createDiv({ cls: "stashpad-trash-group-head" });
        setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "archive");
        head.createSpan({ text: folder.split("/").pop() || folder });
        head.createSpan({ cls: "stashpad-trash-group-count", text: String(items.length + plain.length) });
        const open = head.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Open" });
        open.onclick = () => void this.plugin.activateViewForFolder(folder);
        if (items.length === 0 && plain.length === 0) { group.createDiv({ cls: "stashpad-trash-sub", text: "No archived items." }); continue; }
        for (const f of plain) this.archivePlainRow(group, f);
        for (const e of items) this.archiveLockedRow(group, e);
      }
      return;
    }

    // separated / encrypted / unencrypted → flat kind sections.
    const showPlain = mode !== "encrypted" && allPlain.length > 0;
    const showLocked = mode !== "unencrypted" && allLocked.length > 0;
    if (!showPlain && !showLocked) { root.createDiv({ cls: "stashpad-trash-empty", text: "Nothing in this view." }); return; }
    if (showPlain) {
      const group = root.createDiv({ cls: "stashpad-trash-group" });
      const head = group.createDiv({ cls: "stashpad-trash-group-head" });
      setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "file-text");
      head.createSpan({ text: "Plain notes" });
      head.createSpan({ cls: "stashpad-trash-group-count", text: String(allPlain.length) });
      for (const f of allPlain) this.archivePlainRow(group, f);
    }
    if (showLocked) {
      const group = root.createDiv({ cls: "stashpad-trash-group" });
      const head = group.createDiv({ cls: "stashpad-trash-group-head" });
      setIcon(head.createSpan({ cls: "stashpad-trash-group-icon" }), "lock");
      head.createSpan({ text: "Locked (encrypted)" });
      head.createSpan({ cls: "stashpad-trash-group-count", text: String(allLocked.length) });
      for (const e of allLocked) this.archiveLockedRow(group, e);
    }
  }

  /** One plain archived note — Restore un-archives to the default folder. */
  private archivePlainRow(container: HTMLElement, f: TFile): void {
    const row = container.createDiv({ cls: "stashpad-trash-row" });
    const main = row.createDiv({ cls: "stashpad-trash-row-main" });
    main.createSpan({ cls: "stashpad-trash-title", text: f.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim() || f.basename });
    main.createSpan({ cls: "stashpad-trash-sub", text: `archived ${momentFn(f.stat.mtime).fromNow()}` });
    const restore = row.createEl("button", { cls: "stashpad-trash-restore", text: "Restore" });
    setIcon(restore.createSpan({ cls: "stashpad-btn-icon" }), "rotate-ccw");
    restore.onclick = async () => { restore.disabled = true; const ok = await this.plugin.unarchiveNote(f); if (ok) void this.render(); else restore.disabled = false; };
  }

  /** One locked archived subtree — Export (un-archiving encrypted needs a password). */
  private archiveLockedRow(container: HTMLElement, e: { blob: string; title?: string; count?: number; created?: string }): void {
    const row = container.createDiv({ cls: "stashpad-trash-row" });
    const main = row.createDiv({ cls: "stashpad-trash-row-main" });
    main.createSpan({ cls: "stashpad-trash-title", text: e.title || "Locked note" });
    const when = e.created ? `archived ${momentFn(e.created).fromNow()}` : "archived";
    const count = (e.count ?? 0) > 1 ? ` · ${e.count} notes` : "";
    main.createSpan({ cls: "stashpad-trash-sub", text: when + count });
    const exp = row.createEl("button", { cls: "stashpad-trash-iconbtn", text: "Export" });
    exp.setAttr("aria-label", "Export to .stash (encrypted with a password you choose)");
    exp.onclick = () => void this.plugin.exportLockedSubtree(e.blob);
    const lock = row.createSpan({ cls: "stashpad-aggregate-lockbadge" });
    setIcon(lock, "lock");
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
  // 0.133.0: remember the tab we opened from so closing this aggregate view
  // returns there, not to the tab on the right.
  const originLeaf = workspace.getMostRecentLeaf();
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_AGGREGATE_VIEW_TYPE, active: true, state: { mode } });
  workspace.revealLeaf(leaf);
  returnToOriginOnClose(workspace, leaf, originLeaf);
}
