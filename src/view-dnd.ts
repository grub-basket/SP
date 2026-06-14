import type { StashpadId, TreeNode } from "./types";

/** The view members the DnD machinery calls back into. The live
 *  `StashpadView` satisfies this (passed as `this`). Kept deliberately
 *  small: the drag UI owns its own placeholder/zone state, and hands the
 *  actual move/reorder work back to the view's `reorderToTarget` (which
 *  stays in the view because it drives the selection/cursor/render core). */
export interface DnDHost {
  listEl: HTMLElement | null;
  selection: Set<StashpadId>;
  reorderToTarget(
    sourceIds: StashpadId[],
    targetId: StashpadId,
    position: "before" | "after" | "into",
  ): Promise<void>;
}

/** Owns the drag-and-drop row interaction extracted from StashpadView:
 *  the per-drag source/placeholder state, the dragstart/over/leave/drop
 *  wiring, the animated drop placeholder, and the three-zone hit test.
 *  Behavior is identical to when this lived inline in the view. */
export class ViewDnD {
  private dragSourceIds: StashpadId[] | null = null;
  private dragPlaceholder: HTMLElement | null = null;
  private dragRowHeight = 0;

  constructor(private host: DnDHost) {}

  attachRowDnD(row: HTMLElement, node: TreeNode, _idx: number): void {
    row.addEventListener("dragstart", (e: DragEvent) => {
      const ids = this.host.selection.has(node.id) && this.host.selection.size > 1
        ? [...this.host.selection]
        : [node.id];
      this.dragSourceIds = ids;
      this.dragRowHeight = row.offsetHeight;
      row.addClass("is-dragging");
      // Pre-create the placeholder once per drag (kept detached until first dragover).
      if (this.host.listEl) {
        this.dragPlaceholder = this.host.listEl.createDiv({ cls: "stashpad-drop-placeholder" });
        this.dragPlaceholder.setCssStyles({ height: "0px" });
        // Make the placeholder a valid drop target so dropping in the gap actually
        // fires a drop event (without this it'd be inert and the drop would be lost).
        this.dragPlaceholder.addEventListener("dragover", (de: DragEvent) => {
          if (!this.dragSourceIds) return;
          de.preventDefault();
          if (de.dataTransfer) de.dataTransfer.dropEffect = "move";
        });
        this.dragPlaceholder.addEventListener("drop", (de: DragEvent) => {
          if (!this.dragSourceIds || !this.dragPlaceholder) return;
          de.preventDefault();
          de.stopPropagation();
          const sources = this.dragSourceIds.slice();
          this.dragSourceIds = null;
          // Determine the target by looking at the row that comes AFTER the placeholder
          // (drop "before" that row). If placeholder is the last sibling, drop "after"
          // the row before it.
          const after = this.dragPlaceholder.nextElementSibling as HTMLElement | null;
          const before = this.dragPlaceholder.previousElementSibling as HTMLElement | null;
          this.removeDragPlaceholder();
          let targetId: string | undefined;
          let position: "before" | "after" = "before";
          if (after && after.classList.contains("stashpad-note")) {
            targetId = (after as HTMLElement).dataset.id;
            position = "before";
          } else if (before && before.classList.contains("stashpad-note")) {
            targetId = (before as HTMLElement).dataset.id;
            position = "after";
          }
          if (targetId) void this.host.reorderToTarget(sources, targetId, position);
        });
        this.dragPlaceholder.remove();
      }
      // Use text/plain — some Chromium versions don't initiate drag without a
      // standard MIME type set on dataTransfer.
      e.dataTransfer?.setData("text/plain", ids.join(","));
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // Use the whole row as the drag image (not just the grip when that's the source).
        try { e.dataTransfer.setDragImage(row, 12, 12); } catch {}
      }
    });
    row.addEventListener("dragend", () => {
      row.removeClass("is-dragging");
      this.clearDropIndicators();
      this.removeDragPlaceholder();
      this.dragSourceIds = null;
    });
    row.addEventListener("dragover", (e: DragEvent) => {
      if (!this.dragSourceIds) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const zone = this.dropZone(e, row);
      this.clearDropIndicators();
      if (zone === "drop-into") {
        this.removeDragPlaceholder();
        row.addClass("drop-into");
      } else {
        row.removeClass("drop-into");
        this.placePlaceholder(row, zone === "drop-above" ? "before" : "after");
      }
    });
    row.addEventListener("dragleave", (e: DragEvent) => {
      // Only clear if we've actually left the row (not just moved over a child).
      const r = row.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        row.removeClass("drop-into");
      }
    });
    row.addEventListener("drop", (e: DragEvent) => {
      if (!this.dragSourceIds) return;
      e.preventDefault();
      e.stopPropagation();
      const sources = this.dragSourceIds.slice();
      this.dragSourceIds = null;
      const zone = this.dropZone(e, row);
      this.clearDropIndicators();
      this.removeDragPlaceholder();
      row.removeClass("is-dragging");
      if (zone === "drop-into") {
        void this.host.reorderToTarget(sources, node.id, "into");
      } else {
        void this.host.reorderToTarget(sources, node.id, zone === "drop-above" ? "before" : "after");
      }
    });
  }

  /** List-level drop handling for the gaps between/after rows (the per-row
   *  handlers cover drops directly onto a row). Lets the placeholder slide to
   *  a new gap as the cursor moves through empty list space, and resolves the
   *  final drop target from the placeholder's neighbours. */
  attachListDnD(list: HTMLElement): void {
    list.addEventListener("dragover", (e: DragEvent) => {
      if (!this.dragSourceIds) return;
      const t = e.target as HTMLElement | null;
      // If the cursor is over a row, the per-row handler decides (above/into/below).
      // BUT we still want to recompute when cursor is over the placeholder (so the
      // placeholder slides to a new gap as the user moves through the list).
      if (t && t.closest && t.closest(".stashpad-note")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rows = Array.from(list.querySelectorAll(".stashpad-note")) as HTMLElement[];
      if (rows.length === 0) return;
      // Find the first row whose vertical midpoint is below the cursor → drop before it.
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          this.placePlaceholder(r, "before");
          return;
        }
      }
      // Cursor is below all rows → drop after the last row.
      this.placePlaceholder(rows[rows.length - 1], "after");
    });
    list.addEventListener("drop", (e: DragEvent) => {
      // Only handle if no nested target consumed it.
      if (!this.dragSourceIds) return;
      e.preventDefault();
      const sources = this.dragSourceIds.slice();
      this.dragSourceIds = null;
      if (!this.dragPlaceholder) return;
      const after = this.dragPlaceholder.nextElementSibling as HTMLElement | null;
      const before = this.dragPlaceholder.previousElementSibling as HTMLElement | null;
      this.removeDragPlaceholder();
      if (after && after.classList.contains("stashpad-note")) {
        const id = (after as HTMLElement).dataset.id;
        if (id) void this.host.reorderToTarget(sources, id, "before");
      } else if (before && before.classList.contains("stashpad-note")) {
        const id = (before as HTMLElement).dataset.id;
        if (id) void this.host.reorderToTarget(sources, id, "after");
      }
    });
  }

  private placePlaceholder(row: HTMLElement, where: "before" | "after"): void {
    if (!this.dragPlaceholder || !this.host.listEl) return;
    const sibling = where === "before" ? row : row.nextSibling;
    // Avoid redundant DOM moves (which would re-trigger animations).
    if (where === "before" && this.dragPlaceholder.nextSibling === row) return;
    if (where === "after" && this.dragPlaceholder.previousSibling === row) return;
    const wasMounted = !!this.dragPlaceholder.parentElement;
    this.host.listEl.insertBefore(this.dragPlaceholder, sibling);
    // Always restore visibility — drop-into → drop-above transitions had been
    // leaving the placeholder at opacity 0 / height 0 from a previous animated remove.
    this.dragPlaceholder.setCssStyles({ opacity: "1" });
    if (!wasMounted) {
      this.dragPlaceholder.setCssStyles({ height: "0px" });
      // Force layout, then animate to full height.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reading offsetHeight is an intentional synchronous reflow so the height transition animates from 0.
      this.dragPlaceholder.offsetHeight;
      this.dragPlaceholder.setCssStyles({ height: `${this.dragRowHeight}px` });
    } else {
      this.dragPlaceholder.setCssStyles({ height: `${this.dragRowHeight}px` });
    }
  }

  private removeDragPlaceholder(): void {
    if (!this.dragPlaceholder?.parentElement) return;
    const ph = this.dragPlaceholder;
    // Animate collapse, then remove. Keep a reference so a fast next-drag isn't
    // confused (we null out below regardless).
    ph.setCssStyles({ height: "0px", opacity: "0" });
    setTimeout(() => { if (ph.parentElement) ph.remove(); }, 150);
  }

  /** Three-zone hit test for drop position relative to a row's vertical bounds:
   *  top 30% → drop-above, middle 40% → drop-into, bottom 30% → drop-below. */
  private dropZone(e: DragEvent, row: HTMLElement): "drop-above" | "drop-into" | "drop-below" {
    const rect = row.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < rect.height * 0.3) return "drop-above";
    if (y > rect.height * 0.7) return "drop-below";
    return "drop-into";
  }

  private clearDropIndicators(): void {
    if (!this.host.listEl) return;
    for (const el of Array.from(this.host.listEl.querySelectorAll(".drop-into"))) {
      (el as HTMLElement).removeClass("drop-into");
    }
  }
}
