import { TFile, type App } from "obsidian";
import { ROOT_ID, type StashpadId, type TreeNode } from "./types";
import type { TreeIndex } from "./tree-index";
import { perf } from "./perf";
import { getSettings } from "./settings";

const PARENT_LINK_FIELD = "parentLink";
const CHILDREN_FIELD = "children";

/** Frontmatter fields the sync queue owns. Listed in types.ts as
 *  reserved so templates / clones / settings UI don't try to manage
 *  them. Exported for the guards that filter user-supplied frontmatter
 *  to drop reserved keys. */
export const SYNC_OWNED_FIELDS = [PARENT_LINK_FIELD, CHILDREN_FIELD] as const;

/** Background queue that writes the redundant `parentLink` + `children`
 *  fields onto note frontmatter. These fields duplicate information
 *  already encoded by the canonical `id` + `parent` (machine-readable
 *  IDs), so writes here are NOT correctness-critical and can be
 *  deferred. Their purpose is recovery: if Stashpad's UI or index ever
 *  goes wrong, you can open any note in Obsidian and click your way
 *  up via parentLink or down via children — pure markdown, no plugin
 *  state required.
 *
 *  The queue drains one note per pacing tick (default 100ms) so a
 *  burst of moves doesn't hammer the file system. Idempotent: enqueing
 *  the same id twice collapses to one write.
 *
 *  Scheduling is fire-and-forget — callers don't await the sync. The
 *  tree mutation must complete (parent field written, tree.applyChange
 *  fired) BEFORE scheduling, so the queue sees the post-mutation
 *  state when it drains.
 */
export class FrontmatterSyncQueue {
  private pending = new Set<StashpadId>();
  private timer: number | null = null;
  /** Listeners notified whenever the pending set changes size — used
   *  by the view to surface a "frontmatter updating..." notice while
   *  there's pending work, and hide it on drain. */
  private activityListeners = new Set<(pending: number) => void>();

  onActivity(cb: (pending: number) => void): () => void {
    this.activityListeners.add(cb);
    return () => this.activityListeners.delete(cb);
  }

  private emitActivity(): void {
    const n = this.pending.size;
    for (const cb of this.activityListeners) {
      try { cb(n); } catch (e) { console.warn("[Stashpad] fmSync activity listener failed", e); }
    }
  }
  /** Milliseconds between writes when the queue is draining. Tuned to
   *  feel "slowly catching up in the background" — fast enough that
   *  the redundant fields are usually up to date within a few seconds
   *  of a multi-move, slow enough not to compete with the user's
   *  active work. */
  private static readonly PACING_MS = 100;

  constructor(
    private app: App,
    private getTree: () => TreeIndex,
  ) {}

  /** Enqueue a single note id for sync. ROOT is allowed — the home
   *  note's children list (= all top-level notes) is worth keeping
   *  in sync so recovery from the home note works too. The queue's
   *  computeParentLink will simply emit null for ROOT. */
  schedule(id: StashpadId): void {
    if (!id) return;
    // 0.83.1: the recovery-link sync is pure overhead on slow/network
    // drives (each parentLink/children write is a full round-trip, and a
    // move enqueues several). When the user turns it off, skip entirely —
    // the canonical id/parent is unaffected, and Rebootstrap backfills the
    // recovery fields on demand.
    if (!getSettings().writeRecoveryLinks) return;
    const before = this.pending.size;
    this.pending.add(id);
    if (this.pending.size !== before) this.emitActivity();
    this.kick();
  }

  /** Convenience: a parent change affects three notes — the moved
   *  node (parentLink), the old parent (loses a child), and the new
   *  parent (gains a child). Forwards ROOT through so the home note's
   *  children list also gets refreshed. */
  scheduleParentChange(
    movedId: StashpadId,
    oldParent: StashpadId | null,
    newParent: StashpadId,
  ): void {
    this.schedule(movedId);
    if (oldParent) this.schedule(oldParent);
    this.schedule(newParent);
  }

  /** Walk a subtree and enqueue every node in it. Used after clone /
   *  bulk-import operations where every new node needs its links
   *  freshly wired. */
  scheduleSubtree(rootId: StashpadId): void {
    const tree = this.getTree();
    const walk = (id: StashpadId): void => {
      this.schedule(id);
      for (const child of tree.getChildren(id)) walk(child.id);
    };
    walk(rootId);
  }

  /** Called when a note is deleted — enqueues its parent so the
   *  parent's children list is rewritten without the deleted entry.
   *  ROOT is allowed through (home note's children list). */
  scheduleParentOfDeleted(parentId: StashpadId | null): void {
    if (parentId) this.schedule(parentId);
  }

  /** Drain everything pending NOW. Used on view teardown so unflushed
   *  syncs don't get lost when the queue's timer is cleared. */
  async flush(): Promise<void> {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.size > 0) {
      const next = this.pending.values().next().value;
      if (next === undefined) break;
      this.pending.delete(next);
      this.emitActivity();
      await this.syncOne(next);
    }
  }

  /** Number of ids currently waiting to be synced. Cheap; callers
   *  use it for whatever observability they want. The view used to
   *  drive a "backfilling…" notice off this; per user feedback that
   *  was too chatty and now lives only as a failure-mode toast (see
   *  `onError`). */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Listeners notified when a sync write actually fails (path is
   *  the affected file, error is the thrown error). Successful writes
   *  stay silent — the user shouldn't see a toast for routine work,
   *  only when something demands their attention. */
  private errorListeners = new Set<(path: string, error: Error) => void>();

  onError(cb: (path: string, error: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  private emitError(path: string, error: Error): void {
    for (const cb of this.errorListeners) {
      try { cb(path, error); } catch (e) { console.warn("[Stashpad] fmSync error listener failed", e); }
    }
  }

  /** Discard everything pending. Used when switching folders — the new
   *  folder has its own tree and stale ids would write garbage. */
  reset(): void {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private kick(): void {
    if (this.timer != null || this.pending.size === 0) return;
    this.timer = window.setTimeout(() => this.tick(), FrontmatterSyncQueue.PACING_MS);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const next = this.pending.values().next().value;
    if (next === undefined) return;
    this.pending.delete(next);
    this.emitActivity();
    try { await this.syncOne(next); } catch (e) {
      console.warn("[Stashpad] frontmatter sync tick failed", e);
    }
    // Schedule the next drain only if there's more to do. Pacing-by-
    // setTimeout naturally spreads the work across the event loop.
    if (this.pending.size > 0) this.kick();
  }

  /** Cheap predicate: does this id's frontmatter currently differ from
   *  the computed parentLink + children? Reads cached metadata only —
   *  no file IO. Used both as the skip-if-equal guard inside syncOne
   *  AND by backfill to pre-filter the schedule batch so the notice
   *  count reflects real work, not false positives. */
  wouldWrite(id: StashpadId): boolean {
    const tree = this.getTree();
    const node = tree.get(id);
    if (!node || !node.file) return false;
    const parentLink = this.computeParentLink(node);
    const childrenLinks = this.computeChildrenLinks(node);
    const currentFm = this.app.metadataCache.getFileCache(node.file)?.frontmatter;
    const currentParent = (currentFm && typeof currentFm[PARENT_LINK_FIELD] === "string")
      ? currentFm[PARENT_LINK_FIELD] as string : null;
    const currentChildrenRaw = currentFm?.[CHILDREN_FIELD];
    const currentChildren = Array.isArray(currentChildrenRaw)
      ? currentChildrenRaw.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if ((currentParent ?? null) !== (parentLink ?? null)) return true;
    if (currentChildren.length !== childrenLinks.length) return true;
    for (let i = 0; i < currentChildren.length; i++) {
      if (currentChildren[i] !== childrenLinks[i]) return true;
    }
    return false;
  }

  private async syncOne(id: StashpadId): Promise<void> {
    const tree = this.getTree();
    const node = tree.get(id);
    if (!node || !node.file) return;
    // Skip-if-equal: a write that wouldn't change anything would still
    // cascade through metadata events + view rerenders ("composer
    // flashing"). wouldWrite reads cached frontmatter, no disk IO.
    if (!this.wouldWrite(id)) return;
    const parentLink = this.computeParentLink(node);
    const childrenLinks = this.computeChildrenLinks(node);
    try {
      await perf.timeAsync("write.fmSync", () => this.app.fileManager.processFrontMatter(node.file!, (fm) => {
        if (parentLink) fm[PARENT_LINK_FIELD] = parentLink;
        else delete fm[PARENT_LINK_FIELD];
        if (childrenLinks.length > 0) fm[CHILDREN_FIELD] = childrenLinks;
        else delete fm[CHILDREN_FIELD];
      }));
    } catch (e) {
      console.warn("[Stashpad] frontmatter sync failed", node.file?.path, e);
      // Surface to subscribers (the view turns this into a persistent
      // error toast — see installFmSyncActivityNotice).
      this.emitError(node.file.path, e as Error);
    }
  }

  private computeParentLink(node: TreeNode): string | null {
    // The home note has no parent — leave the field absent so it
    // doesn't render a stale link to itself or a deleted ancestor.
    if (node.id === ROOT_ID) return null;
    const tree = this.getTree();
    // Top-level notes (parent === ROOT_ID) get a link to the home note
    // so even the top tier points somewhere clickable for recovery.
    if (!node.parent || node.parent === ROOT_ID) {
      const root = tree.getRoot();
      if (root && root.id !== node.id && root.file) return wikilinkFor(root.file.path);
      return null;
    }
    const parent = tree.get(node.parent);
    if (!parent?.file) return null;
    return wikilinkFor(parent.file.path);
  }

  private computeChildrenLinks(node: TreeNode): string[] {
    const tree = this.getTree();
    return tree.getChildren(node.id)
      .filter((c) => !!c.file)
      .map((c) => wikilinkFor(c.file!.path));
  }
}

/** Standalone (no TreeIndex required) backfill of the redundant
 *  parentLink + children fields for every Stashpad note in a folder.
 *  Used by the "Rebootstrap" button in settings, which runs at the
 *  plugin level — no guarantee any Stashpad view is open for the
 *  folder we're touching.
 *
 *  Builds an in-memory id→file map from the metadata cache once,
 *  then iterates: compute desired fields, compare against current
 *  via skip-if-equal, write only when different. 50ms pacing between
 *  writes mirrors the queue's per-tick cost so a large vault doesn't
 *  hammer the FS in a single burst.
 *
 *  Returns `{ checked, written }` so the caller can surface a
 *  meaningful "N notes updated" message to the user. */
export async function rebootstrapFolderFrontmatter(
  app: App,
  folder: string,
): Promise<{ checked: number; written: number }> {
  type Entry = { file: TFile; id: string; parent: string };

  // 1. Index every Stashpad note in the folder by id, and build a
  //    parent→[children ids] adjacency list.
  const folderPrefix = folder.endsWith("/") ? folder : folder + "/";
  const byId = new Map<string, Entry>();
  const childrenByParent = new Map<string, string[]>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path !== folder && !f.path.startsWith(folderPrefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const id = typeof fm?.id === "string" ? fm.id : null;
    if (!id) continue;
    const parent = typeof fm?.parent === "string" ? fm.parent : ROOT_ID;
    byId.set(id, { file: f, id, parent });
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(id);
    childrenByParent.set(parent, arr);
  }

  const linkForEntry = (entry: Entry): string => wikilinkFor(entry.file.path);
  const computeParent = (entry: Entry): string | null => {
    if (entry.id === ROOT_ID) return null;
    // Top-level notes point at the home note.
    if (entry.parent === ROOT_ID || !entry.parent) {
      const home = byId.get(ROOT_ID);
      return home ? linkForEntry(home) : null;
    }
    const p = byId.get(entry.parent);
    return p ? linkForEntry(p) : null;
  };
  const computeChildren = (entry: Entry): string[] => {
    const childIds = childrenByParent.get(entry.id) ?? [];
    const links: string[] = [];
    for (const cid of childIds) {
      const e = byId.get(cid);
      if (e) links.push(linkForEntry(e));
    }
    return links;
  };

  // 2. Iterate, skip-if-equal, write with 50ms pacing on actual writes.
  let checked = 0;
  let written = 0;
  for (const entry of byId.values()) {
    checked += 1;
    const desiredParent = computeParent(entry);
    const desiredChildren = computeChildren(entry);
    const fm = app.metadataCache.getFileCache(entry.file)?.frontmatter;
    const currentParent = (fm && typeof fm[PARENT_LINK_FIELD] === "string")
      ? fm[PARENT_LINK_FIELD] as string : null;
    const currentChildrenRaw = fm?.[CHILDREN_FIELD];
    const currentChildren = Array.isArray(currentChildrenRaw)
      ? currentChildrenRaw.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const parentEqual = (currentParent ?? null) === (desiredParent ?? null);
    const childrenEqual = currentChildren.length === desiredChildren.length
      && currentChildren.every((v, i) => v === desiredChildren[i]);
    if (parentEqual && childrenEqual) continue;
    try {
      await app.fileManager.processFrontMatter(entry.file, (m) => {
        if (desiredParent) m[PARENT_LINK_FIELD] = desiredParent;
        else delete m[PARENT_LINK_FIELD];
        if (desiredChildren.length > 0) m[CHILDREN_FIELD] = desiredChildren;
        else delete m[CHILDREN_FIELD];
      });
      written += 1;
      // Spread writes so a 1000-note vault doesn't stall the FS in
      // one burst. 50ms is half the in-view queue's pacing — the
      // rebootstrap button is an explicit action, slightly more
      // urgent than the background queue.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (e) {
      console.warn("[Stashpad] rebootstrap fm sync failed", entry.file.path, e);
    }
  }
  return { checked, written };
}

function wikilinkFor(path: string): string {
  // Strip .md so the link target matches Obsidian's resolver expectations
  // (it handles both "Folder/Note" and "Folder/Note.md", but the
  // extension-less form is the idiomatic wikilink shape and matches
  // how Stashpad already writes author links).
  const noExt = path.replace(/\.md$/i, "");
  return `[[${noExt}]]`;
}
