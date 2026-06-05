import type { App } from "obsidian";
import type { TreeNode, StashpadId } from "./types";
import type { TreeIndex } from "./tree-index";
import type { SortMode } from "./sort-store";

/** The view members the sort comparison reads. Kept structural so this
 *  module doesn't import StashpadView (avoids a cycle). */
export interface SortHost {
  app: App;
  tree: TreeIndex;
  titleForNode(node: TreeNode): string;
}

/** Children of `parentId` sorted per `mode`. Reads the parent's existing
 *  children straight from the TreeIndex (already populated by the rebuild)
 *  and sorts them. Title/modified lookups use the metadata cache — cheap and
 *  consistent with how the rest of the view reads frontmatter. */
export function computeSortedIds(host: SortHost, parentId: StashpadId, mode: SortMode): string[] {
  const kids = host.tree.getChildren(parentId);
  return kids.slice().sort((a, b) => compareForSort(host, a, b, mode)).map((n) => n.id);
}

export function compareForSort(host: SortHost, a: TreeNode, b: TreeNode, mode: SortMode): number {
  switch (mode) {
    case "created-asc":
      return (a.created || "").localeCompare(b.created || "");
    case "created-desc":
      return (b.created || "").localeCompare(a.created || "");
    case "modified-asc":
    case "modified-desc": {
      // Fall back to created when modified is absent so a never-edited
      // note still has a stable position.
      const ma = modifiedFor(host, a) || a.created || "";
      const mb = modifiedFor(host, b) || b.created || "";
      return mode === "modified-asc"
        ? ma.localeCompare(mb)
        : mb.localeCompare(ma);
    }
    case "title-az":
    case "title-za": {
      const ta = host.titleForNode(a);
      const tb = host.titleForNode(b);
      // `numeric: true` makes "Item 2" come before "Item 10", which is
      // what you want when notes are numbered lists. `sensitivity: base`
      // makes the sort case-insensitive (A and a tie before the next
      // letter). Both compare-options are universally supported.
      const opts = { numeric: true, sensitivity: "base" } as const;
      return mode === "title-az"
        ? ta.localeCompare(tb, undefined, opts)
        : tb.localeCompare(ta, undefined, opts);
    }
    default:
      return 0;
  }
}

export function modifiedFor(host: SortHost, node: TreeNode): string {
  if (!node.file) return "";
  const fm = host.app.metadataCache.getFileCache(node.file)?.frontmatter;
  return (typeof fm?.modified === "string" ? fm.modified : "") || "";
}
