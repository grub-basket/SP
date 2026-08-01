import type { App } from "obsidian";
import { STASHPAD_SIDECAR_FILES, type StashpadId } from "./types";

// Canonical name lives in types.ts (STASHPAD_SIDECAR_FILES) so the list a
// sibling plugin mirrors can never drift from what we actually write.
const ORDER_FILE = STASHPAD_SIDECAR_FILES[0];

/** Per-folder ordering store. Maintains a `{ parentId: [childId, ...] }` map
 *  in `<folder>/.stashpad-order.json`. Children present in the map sort by
 *  their position in the array; children NOT in the map fall back to their
 *  created-timestamp order, sorted after the explicit ones. */
export class OrderStore {
  private cache = new Map<string, Record<string, string[]>>(); // folder -> map

  constructor(private app: App) {}

  /** Returns the order map for a folder (cached). Never throws. */
  async load(folder: string): Promise<Record<string, string[]>> {
    if (this.cache.has(folder)) return this.cache.get(folder)!;
    const path = `${folder}/${ORDER_FILE}`;
    const adapter = this.app.vault.adapter;
    let map: Record<string, string[]> = {};
    try {
      if (await adapter.exists(path)) {
        const text = await adapter.read(path);
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (Array.isArray(v) && v.every((x) => typeof x === "string")) map[k] = v;
          }
        }
      }
    } catch (e) { console.warn("Stashpad: order load failed", e); }
    this.cache.set(folder, map);
    return map;
  }

  /** Schedule a debounced write of the order map. The cache is updated by
   *  setOrder/appendChild/removeChild synchronously; this method only controls
   *  when the cache lands on disk. A short coalescing window collapses bursts
   *  of reorder writes (held-down keyboard repeat, rapid drag-and-drop) into
   *  a single round-trip — meaningful on a network drive where each
   *  adapter.write is a separate hop.
   *
   *  `flush()` (below) forces an immediate write and is called on view
   *  teardown so an Obsidian close during the debounce window can't drop
   *  the latest order. */
  async save(folder: string): Promise<void> {
    this.scheduleWrite(folder);
  }

  /** Force any pending debounced write for `folder` to land NOW. Idempotent. */
  async flush(folder: string): Promise<void> {
    const t = this.pendingTimers.get(folder);
    if (t != null) {
      window.clearTimeout(t);
      this.pendingTimers.delete(folder);
    }
    await this.writeNow(folder);
  }

  /** 0.211.6 (L8): re-key this store when its FOLDER is renamed.
   *
   *  Everything here is keyed by folder path. Without this, a rename left a debounced
   *  write pointing at the OLD path, so the timer fired ~150ms later and wrote the
   *  sidecar back into a folder the user had just renamed away — recreating the old
   *  folder on disk — while the reorder/sort the user actually made was never written
   *  to the new one. The stale `cache` entry was also still live under the old key, so
   *  a NEW folder later created at that same path inherited the previous folder's
   *  state. Cancel the pending timer, move the cached value across, and re-arm the
   *  write against the new path. */
  handleFolderRename(oldFolder: string, newFolder: string): void {
    const from = oldFolder.replace(/\/+$/, "");
    const to = newFolder.replace(/\/+$/, "");
    if (from === to) return;
    const t = this.pendingTimers.get(from);
    if (t != null) { window.clearTimeout(t); this.pendingTimers.delete(from); }
    this.writeInFlight.delete(from);
    if (this.cache.has(from)) {
      this.cache.set(to, this.cache.get(from)!);
      this.cache.delete(from);
      // Only re-arm if a write was actually pending; otherwise this is just a cache move.
      if (t != null) this.scheduleWrite(to);
    }
  }

  private pendingTimers = new Map<string, number>();
  private writeInFlight = new Map<string, Promise<void>>();

  private scheduleWrite(folder: string): void {
    const existing = this.pendingTimers.get(folder);
    if (existing != null) window.clearTimeout(existing);
    const t = window.setTimeout(() => {
      this.pendingTimers.delete(folder);
      void this.writeNow(folder);
    }, 150);
    this.pendingTimers.set(folder, t);
  }

  /** Serialize concurrent writes per folder so a flush() racing with a
   *  scheduled write can't reorder the on-disk content. */
  private async writeNow(folder: string): Promise<void> {
    const prev = this.writeInFlight.get(folder) ?? Promise.resolve();
    const next = prev.then(() => this.doWrite(folder));
    this.writeInFlight.set(folder, next);
    try { await next; } finally {
      if (this.writeInFlight.get(folder) === next) this.writeInFlight.delete(folder);
    }
  }

  private async doWrite(folder: string): Promise<void> {
    const map = this.cache.get(folder) ?? {};
    const path = `${folder}/${ORDER_FILE}`;
    const adapter = this.app.vault.adapter;
    // 0.140.3 (review): a mutation (setOrder/appendChild) that fires BEFORE this
    // folder's load() has resolved seeds the cache with ONLY the touched parent,
    // so writing it verbatim would clobber every other parent's saved order.
    // Merge in any on-disk parents we DIDN'T touch this session (cache wins per
    // key) so untouched orders survive.
    let existedButUnreadable = false;
    try {
      if (await adapter.exists(path)) {
        const parsed = JSON.parse(await adapter.read(path));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (!(k in map) && Array.isArray(v) && v.every((x) => typeof x === "string")) map[k] = v as string[];
          }
        }
      }
    } catch {
      // 0.211.8: an EXISTING file we couldn't read must not be deleted below. The
      // read is inside this try, so a JSON parse error or an I/O failure landed here
      // with `map` holding only whatever this session touched — which for an
      // untouched folder is nothing. The empty-map branch would then remove() the
      // sidecar, destroying every ordering/sort on disk purely because we failed to
      // parse it. Treat unreadable as "leave it exactly as it is".
      try { existedButUnreadable = await adapter.exists(path); } catch { existedButUnreadable = true; }
    }
    const trimmed: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(map)) if (v.length > 0) trimmed[k] = v;
    this.cache.set(folder, trimmed);
    try {
      if (Object.keys(trimmed).length === 0) {
        if (existedButUnreadable) {
          console.warn("Stashpad: order sidecar unreadable — keeping it rather than deleting", path);
          return;
        }
        // Skip the exists() probe — remove() throws "file not found" if
        // it's missing, which we swallow. One round-trip instead of two
        // on a network drive.
        try { await adapter.remove(path); } catch { /* file already gone */ }
      } else {
        await adapter.write(path, JSON.stringify(trimmed, null, 2));
      }
    } catch (e) { console.warn("Stashpad: order save failed", e); }
  }

  /** Get the explicit order for a parent (may be empty). Synchronous — caller must load first. */
  getOrder(folder: string, parentId: StashpadId): string[] {
    return this.cache.get(folder)?.[parentId]?.slice() ?? [];
  }

  /** Replace the order for a parent. */
  setOrder(folder: string, parentId: StashpadId, ids: string[]): void {
    const map = this.cache.get(folder) ?? {};
    map[parentId] = ids.slice();
    this.cache.set(folder, map);
  }

  /** Append a child to the parent's order (no-op if already present). */
  appendChild(folder: string, parentId: StashpadId, childId: StashpadId): void {
    const map = this.cache.get(folder) ?? {};
    const arr = map[parentId] ?? [];
    if (!arr.includes(childId)) arr.push(childId);
    map[parentId] = arr;
    this.cache.set(folder, map);
  }

  /** Remove a child from any parent's order (used on delete / move). */
  removeChild(folder: string, childId: StashpadId): void {
    const map = this.cache.get(folder);
    if (!map) return;
    for (const arr of Object.values(map)) {
      const i = arr.indexOf(childId);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  /** Drop the cache for a folder (forces re-read on next load). */
  invalidate(folder: string): void { this.cache.delete(folder); }
}

/** Sort children using an explicit-order array; unknown ids fall to the end
 *  in their existing order (typically created-timestamp order). */
export function sortChildrenByOrder<T extends { id: string }>(children: T[], order: string[]): T[] {
  if (!order.length) return children;
  const positions = new Map<string, number>();
  order.forEach((id, i) => positions.set(id, i));
  return children.slice().sort((a, b) => {
    const pa = positions.has(a.id) ? positions.get(a.id)! : Infinity;
    const pb = positions.has(b.id) ? positions.get(b.id)! : Infinity;
    if (pa !== pb) return pa - pb;
    return 0; // stable: rely on input order for ties (already sorted by created)
  });
}
