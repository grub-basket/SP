import { ItemView, WorkspaceLeaf } from "obsidian";
import type StashpadPlugin from "./main";
import { LogPanel, NotificationHistoryPanel } from "./modals";
import { STASHPAD_LOG_VIEW_TYPE, STASHPAD_NOTIFICATIONS_VIEW_TYPE } from "./types";

/** 0.315.0: the per-folder action log as a dedicated tab. Mounts the shared
 *  LogPanel (extracted from LogModal) into the view's contentEl. The log file
 *  is read on open and re-read whenever this tab is re-activated, so switching
 *  back to it shows fresh events without thrashing while you're reading. */
export class StashpadLogView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  getViewType(): string { return STASHPAD_LOG_VIEW_TYPE; }
  getDisplayText(): string { return "Stashpad log"; }
  getIcon(): string { return "scroll-text"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("stashpad-activity-view"); // fill the tab, not the modal box
    await this.reload();
    // Re-read when the user switches back to this tab (cheap; snapshot semantics
    // like the old modal, but never stale once you refocus it).
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) void this.reload();
    }));
  }

  private async reload(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const path = this.plugin.pluginPrivatePath("log.jsonl");
    let data = "";
    try { if (await adapter.exists(path)) data = await adapter.read(path); } catch { /* empty → empty-state */ }
    new LogPanel(this.app, this.contentEl, data, path).mount();
  }

  onClose(): Promise<void> { this.contentEl.empty(); return Promise.resolve(); }
}

/** 0.315.0: the notification history as a dedicated tab. Mounts the shared
 *  NotificationHistoryPanel, which live-updates via the service subscription;
 *  destroy() on close unsubscribes. */
export class StashpadNotificationsView extends ItemView {
  private panel: NotificationHistoryPanel | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  getViewType(): string { return STASHPAD_NOTIFICATIONS_VIEW_TYPE; }
  getDisplayText(): string { return "Stashpad notifications"; }
  getIcon(): string { return "bell"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("stashpad-activity-view"); // fill the tab, not the modal box
    this.panel = new NotificationHistoryPanel(
      this.app,
      this.contentEl,
      this.plugin.notifications,
      // "Open log" jumps to the dedicated log tab now (not a modal).
      () => void openStashpadLogView(this.plugin),
      this.plugin.settings.authorId || null,
      (id) => this.plugin.lookupNoteAuthorIds(id),
    );
    this.panel.mount();
  }

  onClose(): Promise<void> { this.panel?.destroy(); this.panel = null; return Promise.resolve(); }
}

/** Reveal the log tab, reusing an existing one if open (single instance). */
export async function openStashpadLogView(plugin: StashpadPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(STASHPAD_LOG_VIEW_TYPE);
  const leaf = existing[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_LOG_VIEW_TYPE, active: true });
  workspace.revealLeaf(leaf);
}

/** Reveal the notifications tab, reusing an existing one if open. */
export async function openStashpadNotificationsView(plugin: StashpadPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(STASHPAD_NOTIFICATIONS_VIEW_TYPE);
  const leaf = existing[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_NOTIFICATIONS_VIEW_TYPE, active: true });
  workspace.revealLeaf(leaf);
}
