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
 *  nothing else in the main area. In that case Obsidian's default stands.
 *
 *  0.140.2 (review fixes):
 *   - Pass `register` (plugin.registerEvent) so the listener is OWNED by the
 *     plugin and cleaned on unload — a spawned tab that's never closed no longer
 *     leaks a live listener (nor keeps a dead-view callback alive across a
 *     reload). It still self-detaches on close.
 *   - Only re-focus the origin when the spawned tab was FOCUSED as it vanished.
 *     A background middle-close doesn't fire `active-leaf-change`, leaving the
 *     listener armed; the OLD code then hijacked the NEXT deliberate tab switch,
 *     yanking focus to the origin. Tracking the last-active leaf fixes that. */
export function returnToOriginOnClose(
  ws: Workspace,
  newLeaf: WorkspaceLeaf,
  originLeaf: WorkspaceLeaf | null,
  register?: (ref: EventRef) => void,
): void {
  if (!originLeaf || originLeaf === newLeaf) return;
  const isOpen = (target: WorkspaceLeaf): boolean => {
    let found = false;
    ws.iterateAllLeaves((l) => { if (l === target) found = true; });
    return found;
  };
  // The spawned tab was just made active by the opener, so it starts as the
  // last-active leaf we've seen.
  let lastActive: WorkspaceLeaf | null = newLeaf;
  const off: EventRef = ws.on("active-leaf-change", () => {
    if (isOpen(newLeaf)) { lastActive = ws.activeLeaf ?? lastActive; return; }
    // Spawned tab is gone. Detach either way.
    ws.offref(off);
    // Only reclaim focus if it closed WHILE FOCUSED (foreground close) — a
    // background close shouldn't hijack the tab the user just switched to.
    if (lastActive === newLeaf && isOpen(originLeaf)) {
      ws.setActiveLeaf(originLeaf, { focus: true });
      ws.revealLeaf(originLeaf);
    }
  });
  register?.(off); // plugin-owned → cleaned on unload
}
