import type { Workspace, WorkspaceLeaf, EventRef } from "obsidian";

/** Restore focus to `originLeaf` when `newLeaf` closes, instead of letting
 *  Obsidian fall back to the tab on the right. One-shot: the listener detaches
 *  itself the moment the spawned leaf is gone.
 *
 *  Shared by every Stashpad new-tab opener — edit-in-editor, "open in new
 *  Stashpad tab", search-in-context, and the aggregate / trash / archive /
 *  tasks views — so "close this tab, land back where I came from" is universal.
 *
 *  No-ops when there's no distinct origin (origin missing, or identical to the
 *  spawned leaf) — e.g. an aggregate view opened from the command palette with
 *  nothing else in the main area. In that case Obsidian's default stands. */
export function returnToOriginOnClose(
  ws: Workspace,
  newLeaf: WorkspaceLeaf,
  originLeaf: WorkspaceLeaf | null,
): void {
  if (!originLeaf || originLeaf === newLeaf) return;
  const isOpen = (target: WorkspaceLeaf): boolean => {
    let found = false;
    ws.iterateAllLeaves((l) => { if (l === target) found = true; });
    return found;
  };
  const off: EventRef = ws.on("active-leaf-change", () => {
    // Spawned tab still around (user just switched away from it) — leave it.
    if (isOpen(newLeaf)) return;
    // Spawned tab closed. Detach this listener and, if the origin tab is still
    // open, make it active instead of whatever Obsidian picked (the right tab).
    ws.offref(off);
    if (isOpen(originLeaf)) {
      ws.setActiveLeaf(originLeaf, { focus: true });
      ws.revealLeaf(originLeaf);
    }
  });
}
