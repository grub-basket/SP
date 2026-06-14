import { TFile, TFolder, type App } from "obsidian";
import { ROOT_ID, RESERVED_SUBFOLDER_NAMES, isInReservedSubfolder, type StashpadId, type TreeNode } from "./types";

/** Walk a Stashpad folder's TFolder subtree and return every .md file under
 *  it. Iterative DFS rather than recursive to avoid a deep-recursion blow-up
 *  if someone makes a pathological folder structure. Returns [] when the
 *  folder doesn't exist yet (first run, or the user just renamed the
 *  folder root). */
function collectMarkdown(app: App, folderPath: string): TFile[] {
  const root = app.vault.getAbstractFileByPath(folderPath);
  if (!(root instanceof TFolder)) return [];
  const out: TFile[] = [];
  const stack: TFolder[] = [root];
  while (stack.length) {
    const f = stack.pop()!;
    for (const child of f.children) {
      if (child instanceof TFile) {
        if (child.extension === "md") out.push(child);
      } else if (child instanceof TFolder) {
        // 0.79.12: never descend into reserved Stashpad subfolders
        // (_archive / _attachments / _authors / …) — their files aren't
        // notes, and an archived original carrying a Stashpad id would
        // otherwise surface as a phantom duplicate note.
        if (!RESERVED_SUBFOLDER_NAMES.has(child.name)) stack.push(child);
      }
    }
  }
  return out;
}

export class TreeIndex {
  private nodes = new Map<StashpadId, TreeNode>();
  private byPath = new Map<string, StashpadId>();
  private listeners = new Set<() => void>();
  private currentFolder: string | undefined;
  /** Optional override for sibling order. Returns the explicit order array
   *  for a parent (empty if none); ids not in the array sort by created time. */
  private orderProvider: ((parentId: StashpadId) => string[]) | null = null;
  /** Synthetic-node carry-forward: nodes inserted via insertSynthetic() that haven't
   *  yet been claimed by metadataCache. Persisted across rebuilds until cache catches up. */
  private synthetic = new Map<string /* path */, TreeNode>();
  /** Coalesce timer for the metadata-cache hook so a burst of events triggers one rebuild. */
  private coalesceTimer: number | null = null;

  setOrderProvider(fn: ((parentId: StashpadId) => string[]) | null): void {
    this.orderProvider = fn;
  }

  constructor(private app: App) {
    this.nodes.set(ROOT_ID, {
      id: ROOT_ID, parent: null, children: [], file: null, created: "",
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  rebuild(folderPath?: string): void {
    if (folderPath !== undefined) this.currentFolder = folderPath;
    const folder = this.currentFolder;

    // Snapshot the previous byPath/nodes so we can carry forward nodes whose
    // frontmatter hasn't been parsed yet (synthetic insertions, slow network drives).
    const prevByPath = this.byPath;
    const prevNodes = this.nodes;

    this.nodes = new Map();
    this.byPath = new Map();
    this.nodes.set(ROOT_ID, { id: ROOT_ID, parent: null, children: [], file: null, created: "" });

    // Folder-scoped enumeration: walk only the Stashpad folder's TFolder
    // subtree instead of `vault.getMarkdownFiles()` (which returns every
    // markdown file in the vault and then string-prefix-filters). In a
    // large vault with a small Stashpad this is a dramatic O(n_vault) →
    // O(n_folder) reduction.
    //
    // We still allow a `!folder` mode (currentFolder never set) for safety;
    // it falls back to the original vault-wide enumeration so the index
    // works during the brief window before the view's bootstrap finishes.
    const files: TFile[] = folder ? collectMarkdown(this.app, folder) : this.app.vault.getMarkdownFiles();

    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const id = fm?.id as string | undefined;

      // Carry-forward path: the file exists in the vault, but metadataCache hasn't
      // parsed it yet (no id). If we previously had a node for this path (synthetic
      // insert from createNoteUnder, or the previous rebuild), keep using it.
      if (!id) {
        const carriedId = prevByPath.get(f.path);
        const carried = carriedId ? prevNodes.get(carriedId) : undefined;
        const synthetic = this.synthetic.get(f.path);
        const node = carried ?? synthetic;
        if (node) {
          this.nodes.set(node.id, { ...node, children: [], file: f });
          this.byPath.set(f.path, node.id);
        }
        continue;
      }
      // Once the cache has the id, the synthetic mapping is no longer needed.
      this.synthetic.delete(f.path);

      if (id === ROOT_ID) {
        const root = this.nodes.get(ROOT_ID)!;
        root.file = f;
        root.created = (fm?.created as string) ?? "";
        this.byPath.set(f.path, ROOT_ID);
        continue;
      }
      let parent = (fm?.parent as string | null | undefined) ?? null;
      // 0.77.11 (robustness): a note declaring itself as its own parent
      // (a 1-node cycle, e.g. from a hand-edited/synced frontmatter on a
      // shared drive) would hang every parent-chain walk. Pin it to ROOT.
      if (parent === id) parent = null;
      this.nodes.set(id, {
        id,
        parent: parent ?? ROOT_ID,
        children: [],
        file: f,
        created: (fm?.created as string) ?? "",
      });
      this.byPath.set(f.path, id);
    }

    for (const node of this.nodes.values()) {
      if (node.id === ROOT_ID) continue;
      const parentId = node.parent ?? ROOT_ID;
      const parent = this.nodes.get(parentId) ?? this.nodes.get(ROOT_ID)!;
      parent.children.push(node.id);
    }

    for (const node of this.nodes.values()) {
      // Default: sort by created (ascending — oldest first).
      node.children.sort((a, b) => {
        const na = this.nodes.get(a)!;
        const nb = this.nodes.get(b)!;
        return (na.created || "").localeCompare(nb.created || "");
      });
      // If an explicit order is provided for this parent, apply it: ids in the
      // order array come first (in the array's order); ids not in it stay where
      // they were (which is created-asc from the sort above).
      if (this.orderProvider) {
        const explicit = this.orderProvider(node.id);
        if (explicit.length > 0) {
          const positions = new Map<string, number>();
          explicit.forEach((id, i) => positions.set(id, i));
          node.children.sort((a, b) => {
            const pa = positions.has(a) ? positions.get(a)! : Infinity;
            const pb = positions.has(b) ? positions.get(b)! : Infinity;
            if (pa === pb) return 0;
            return pa - pb;
          });
        }
      }
    }

    this.emit();
  }

  /** Insert a node into the tree without waiting for metadataCache to parse the file.
   *  Used by createNoteUnder so a freshly-written note appears in the list immediately
   *  on slow drives where the metadata cache parse is the bottleneck. */
  insertSynthetic(node: TreeNode): void {
    if (!node.file) return;
    const path = node.file.path;
    this.synthetic.set(path, node);
    this.nodes.set(node.id, node);
    this.byPath.set(path, node.id);
    const parentId = node.parent ?? ROOT_ID;
    const parent = this.nodes.get(parentId);
    if (parent && !parent.children.includes(node.id)) {
      parent.children.push(node.id);
    }
    this.emit();
  }

  get(id: StashpadId): TreeNode | undefined {
    return this.nodes.get(id);
  }

  getRoot(): TreeNode {
    return this.nodes.get(ROOT_ID)!;
  }

  getChildren(id: StashpadId): TreeNode[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.children
      .map((cid) => this.nodes.get(cid))
      .filter((n): n is TreeNode => !!n);
  }

  /** 0.76.30: number of nodes backed by an actual file. Compared
   *  against the on-disk Stashpad-note count to detect a tree that
   *  drifted out of sync (mobile cold start / post-sync burst). */
  fileBackedCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.file) n++;
    return n;
  }

  pathTo(id: StashpadId): TreeNode[] {
    const out: TreeNode[] = [];
    const seen = new Set<StashpadId>();   // cycle guard (see rebuild note)
    let cur = this.nodes.get(id);
    while (cur && cur.id !== ROOT_ID && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    return out;
  }

  idForPath(path: string): StashpadId | undefined {
    return this.byPath.get(path);
  }

  snapshot(): Record<string, { parent: string | null; path: string }> {
    const out: Record<string, { parent: string | null; path: string }> = {};
    for (const n of this.nodes.values()) {
      if (n.id === ROOT_ID || !n.file) continue;
      out[n.id] = { parent: n.parent === ROOT_ID ? null : n.parent, path: n.file.path };
    }
    return out;
  }

  hookMetadataCache(onUpdate: () => void): () => void {
    const pathInFolder = (p: string | null | undefined): boolean => {
      const f = this.currentFolder;
      if (!f) return true; // early startup — accept everything
      if (typeof p !== "string") return false;
      return p === f || p.startsWith(f + "/");
    };

    // Coalesce bursts: a single create can fire create + metadataCache.changed
    // back-to-back, plus multiple processFrontMatter calls during a batch op.
    // 16ms window collapses them into one onUpdate (render) call. Note the
    // tree state itself is mutated synchronously by the apply* methods —
    // only the visual update is debounced.
    let dirty = false;
    const scheduleUpdate = (): void => {
      dirty = true;
      if (this.coalesceTimer != null) return;
      this.coalesceTimer = window.setTimeout(() => {
        this.coalesceTimer = null;
        if (!dirty) return;
        dirty = false;
        this.emit();
        onUpdate();
      }, 16);
    };

    const onChanged = (file: any): void => {
      if (!(file instanceof TFile)) return;
      if (!pathInFolder(file.path)) return;
      if (file.extension !== "md") return;
      // Patch the tree structure first (parent/created/etc.), then ALWAYS
      // repaint. applyChange returns false for a frontmatter-only edit
      // (color, due date, assignees, task state) because nothing structural
      // moved — but the view reads those live (colorForNode etc.), so it
      // still needs to re-render once the cache reflects the new value.
      // 0.82.12: previously a non-structural change relied on the vault
      // "modify" debounce landing AFTER the metadata reparse — a race that
      // left a just-set color one change behind (and undo unable to clear
      // it). Repainting on the cache event removes the race: render runs
      // exactly when the fresh frontmatter is available. Coalesced (16ms)
      // so bursts collapse to one paint; render writes nothing, so no loop.
      this.applyChange(file);
      scheduleUpdate();
    };
    const onCreate = (file: any): void => {
      if (!(file instanceof TFile)) return;
      if (!pathInFolder(file.path)) return;
      if (file.extension !== "md") return;
      if (this.applyChange(file)) scheduleUpdate();
    };
    const onDelete = (file: any): void => {
      const path = file?.path;
      if (typeof path !== "string") return;
      if (!pathInFolder(path)) return;
      if (this.applyDelete(path)) scheduleUpdate();
    };
    const onRename = (file: any, oldPath: any): void => {
      if (!(file instanceof TFile)) return;
      const oldP = typeof oldPath === "string" ? oldPath : null;
      if (!pathInFolder(file.path) && !pathInFolder(oldP)) return;
      if (this.applyRename(file, oldP ?? "")) scheduleUpdate();
    };

    (this.app.metadataCache as any).on("changed", onChanged);
    (this.app.vault as any).on("create", onCreate);
    (this.app.vault as any).on("delete", onDelete);
    (this.app.vault as any).on("rename", onRename);
    return () => {
      (this.app.metadataCache as any).off("changed", onChanged);
      (this.app.vault as any).off("create", onCreate);
      (this.app.vault as any).off("delete", onDelete);
      (this.app.vault as any).off("rename", onRename);
      if (this.coalesceTimer != null) { window.clearTimeout(this.coalesceTimer); this.coalesceTimer = null; }
    };
  }

  // ---------------------------------------------------------------------
  // Incremental update path
  //
  // Before these existed, every vault event triggered a full rebuild —
  // scanning the whole folder, allocating a fresh nodes/byPath Map, and
  // re-sorting every parent's children. For a single-file change in a
  // 500-note Stashpad that was O(500) work for an O(1) event.
  //
  // applyChange/applyDelete/applyRename instead patch the affected nodes
  // and re-sort only the parents that actually moved. Safety net: if any
  // case looks even slightly weird (unknown parent, id collision across
  // paths, missing entries), we fall back to a full rebuild() — which is
  // now folder-scoped and cheap. So the incremental path is always a
  // pure optimization; bugs degrade to "full rebuild" rather than
  // "stale tree."
  //
  // All three methods return `true` when the tree changed and an emit
  // is warranted.
  // ---------------------------------------------------------------------

  /** Apply a single file create/modify event. Returns true if the tree
   *  changed (caller should schedule onUpdate). */
  private applyChange(file: TFile): boolean {
    // 0.80.5: never index files in reserved subfolders (_archive,
    // _attachments, …). The full rebuild already skips them, but this
    // incremental hook didn't — so an archived note (which keeps its
    // Stashpad id) got re-inserted when its metadata cache fired, and then
    // showed up in every tree-backed picker (find / move / destination).
    // Clean up any node that slipped in before this guard existed.
    if (isInReservedSubfolder(file.path)) {
      return this.byPath.has(file.path) ? this.applyDelete(file.path) : false;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = fm?.id as string | undefined;
    const oldId = this.byPath.get(file.path);

    // Metadata cache hasn't parsed this file yet (no id in frontmatter).
    // If we already have a synthetic / previous node for the path, just
    // refresh its file reference; the metadata-cache "changed" event will
    // fire again once the cache catches up.
    if (!id) {
      if (oldId) {
        const node = this.nodes.get(oldId);
        if (node && node.file !== file) {
          node.file = file;
          return true;
        }
      }
      return false;
    }

    // Synthetic mapping no longer needed once the cache has the real id.
    this.synthetic.delete(file.path);

    // Self-declared root note. Update root metadata in place; root never
    // has siblings to re-sort.
    if (id === ROOT_ID) {
      const root = this.nodes.get(ROOT_ID)!;
      const created = (fm?.created as string) ?? "";
      let changed = false;
      if (root.file !== file) { root.file = file; changed = true; }
      if (root.created !== created) { root.created = created; changed = true; }
      if (this.byPath.get(file.path) !== ROOT_ID) {
        this.byPath.set(file.path, ROOT_ID);
        changed = true;
      }
      return changed;
    }

    const parentId = ((fm?.parent as string | null | undefined) ?? ROOT_ID) as StashpadId;
    const created = (fm?.created as string) ?? "";

    // Safety net: if the declared parent isn't ROOT and isn't in the
    // tree yet (or our path<->id map is in a weird state), fall back to
    // a full rebuild. The folder-scoped rebuild is cheap; correctness
    // wins over a few hundred microseconds.
    const parentKnown = parentId === ROOT_ID || this.nodes.has(parentId);
    if (!parentKnown) {
      this.rebuild();
      return true;
    }
    // Detect path/id desync (e.g. someone rewrote the frontmatter id by
    // hand): the path used to map to a different id. Cleanest recovery
    // is a full rebuild.
    if (oldId && oldId !== id) {
      this.rebuild();
      return true;
    }

    const existing = this.nodes.get(id);
    if (!existing) {
      // Brand-new node.
      const node: TreeNode = { id, parent: parentId, children: [], file, created };
      this.nodes.set(id, node);
      this.byPath.set(file.path, id);
      this.attachToParent(node);
      this.resortChildrenOf(parentId);
      return true;
    }

    // Existing node — diff fields and re-attach/re-sort only as needed.
    let changed = false;
    if (existing.file !== file) { existing.file = file; changed = true; }
    if (existing.created !== created) {
      existing.created = created;
      this.resortChildrenOf(existing.parent ?? ROOT_ID);
      changed = true;
    }
    if (existing.parent !== parentId) {
      const oldParentId = existing.parent ?? ROOT_ID;
      this.detachFromParent(existing);
      existing.parent = parentId;
      this.attachToParent(existing);
      this.resortChildrenOf(oldParentId);
      this.resortChildrenOf(parentId);
      changed = true;
    }
    return changed;
  }

  /** Apply a file delete. Reassigns the deleted node's children to ROOT
   *  (mirroring the full-rebuild behavior when a parent file is missing). */
  private applyDelete(path: string): boolean {
    const id = this.byPath.get(path);
    if (!id) return false;
    const node = this.nodes.get(id);
    if (!node) {
      this.byPath.delete(path);
      this.synthetic.delete(path);
      return true;
    }
    this.detachFromParent(node);
    // Re-parent any descendants to ROOT so they don't dangle. We don't
    // touch their frontmatter — Stashpad's adoptNote / integrity-check
    // command handles that side. This just keeps the in-memory tree
    // consistent until the user runs a fixup.
    const root = this.nodes.get(ROOT_ID)!;
    for (const cid of node.children) {
      const child = this.nodes.get(cid);
      if (child) {
        child.parent = ROOT_ID;
        if (!root.children.includes(cid)) root.children.push(cid);
      }
    }
    if (node.children.length > 0) this.resortChildrenOf(ROOT_ID);
    this.nodes.delete(id);
    this.byPath.delete(path);
    this.synthetic.delete(path);
    return true;
  }

  /** Apply a vault rename. Three cases:
   *  - moved out of folder → treat as delete
   *  - moved into folder   → treat as create (delegated to applyChange)
   *  - renamed within folder → just remap byPath; frontmatter unaffected */
  private applyRename(file: TFile, oldPath: string): boolean {
    const folder = this.currentFolder;
    const wasIn = !folder || oldPath === folder || oldPath.startsWith(folder + "/");
    const isIn = !folder || file.path === folder || file.path.startsWith(folder + "/");
    if (!wasIn && !isIn) return false;
    if (wasIn && !isIn) return this.applyDelete(oldPath);
    if (!wasIn && isIn) return this.applyChange(file);
    // 0.80.5: a within-folder move INTO a reserved subfolder (e.g. import
    // archiving root/Note.md → _archive/Note.md) must drop the node, not
    // just remap its path — otherwise the archived note lingers in the
    // tree. (Moving back OUT falls through to applyChange below, since the
    // archived path was never indexed, and re-adds it.)
    if (isInReservedSubfolder(file.path)) {
      return this.byPath.has(oldPath) ? this.applyDelete(oldPath) : false;
    }
    // Rename within folder.
    const id = this.byPath.get(oldPath);
    if (!id) {
      // We never had this path indexed — fall through to a normal apply.
      return this.applyChange(file);
    }
    this.byPath.delete(oldPath);
    this.byPath.set(file.path, id);
    const node = this.nodes.get(id);
    if (node) node.file = file;
    return true;
  }

  // --- attach / detach / sort helpers ---

  private detachFromParent(node: TreeNode): void {
    const parent = this.nodes.get(node.parent ?? ROOT_ID);
    if (!parent) return;
    const i = parent.children.indexOf(node.id);
    if (i >= 0) parent.children.splice(i, 1);
  }

  private attachToParent(node: TreeNode): void {
    // If the declared parent doesn't exist in the tree, fall back to ROOT
    // (same orphan-handling as rebuild()'s second pass).
    let parent = this.nodes.get(node.parent ?? ROOT_ID);
    if (!parent) parent = this.nodes.get(ROOT_ID)!;
    if (!parent.children.includes(node.id)) parent.children.push(node.id);
  }

  /** Re-sort a single parent's children using the same default + orderProvider
   *  pipeline as rebuild(). Pulled out so incremental updates can re-sort
   *  exactly one parent instead of every parent in the tree. */
  private resortChildrenOf(parentId: StashpadId): void {
    const p = this.nodes.get(parentId);
    if (!p) return;
    p.children.sort((a, b) => {
      const na = this.nodes.get(a)!;
      const nb = this.nodes.get(b)!;
      return (na.created || "").localeCompare(nb.created || "");
    });
    if (this.orderProvider) {
      const explicit = this.orderProvider(parentId);
      if (explicit.length > 0) {
        const positions = new Map<string, number>();
        explicit.forEach((id, i) => positions.set(id, i));
        p.children.sort((a, b) => {
          const pa = positions.has(a) ? positions.get(a)! : Infinity;
          const pb = positions.has(b) ? positions.get(b)! : Infinity;
          if (pa === pb) return 0;
          return pa - pb;
        });
      }
    }
  }
}
