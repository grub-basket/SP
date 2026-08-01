import type { App } from "obsidian";
import { STASHPAD_SIDECAR_FILES, type StashpadId } from "./types";

/** Per-folder sort-mode store. Mirrors the OrderStore pattern: maintains a
 *  `{ parentId: SortMode }` map in `<folder>/.stashpad-sort.json`, loaded
 *  on view bootstrap and consulted by the tree's orderProvider.
 *
 *  - "manual" is the default and is NEVER persisted (it's the absence of
 *    an entry). Auto-flip-to-manual on drag/keyboard reorder is implemented
 *    by deleting the parent's entry.
 *  - Any non-manual mode is persisted explicitly so navigating away and
 *    back restores the user's chosen sort for each parent independently.
 *  - Granularity is per-parent — each parent in the tree carries its own
 *    sort mode (or falls through to manual). The home/root parent uses
 *    ROOT_ID as its key. */
export type SortMode =
  | "manual"
  | "created-asc"
  | "created-desc"
  | "modified-asc"
  | "modified-desc"
  | "title-az"
  | "title-za";

export const SORT_MODE_LABELS: Record<SortMode, string> = {
  "manual": "Manual",
  "created-asc": "Created — oldest first",
  "created-desc": "Created — newest first",
  "modified-asc": "Modified — oldest first",
  "modified-desc": "Modified — newest first",
  "title-az": "Title — A→Z",
  "title-za": "Title — Z→A",
};

export const SORT_MODES_ORDER: SortMode[] = [
  "manual",
  "created-asc", "created-desc",
  "modified-asc", "modified-desc",
  "title-az", "title-za",
];

const VALID_MODES = new Set<string>(SORT_MODES_ORDER);

const SORT_FILE = STASHPAD_SIDECAR_FILES[1]; // see types.ts

export class SortStore {
  /** folder -> { parentId -> SortMode } (excluding "manual" entries) */
  private cache = new Map<string, Record<string, SortMode>>();

  constructor(private app: App) {}

  /** Load the per-parent sort-mode map for a folder. Never throws. */
  async load(folder: string): Promise<Record<string, SortMode>> {
    if (this.cache.has(folder)) return this.cache.get(folder)!;
    const path = `${folder}/${SORT_FILE}`;
    const adapter = this.app.vault.adapter;
    const map: Record<string, SortMode> = {};
    try {
      if (await adapter.exists(path)) {
        const parsed = JSON.parse(await adapter.read(path));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string" && VALID_MODES.has(v)) map[k] = v as SortMode;
          }
        }
      }
    } catch (e) {
      console.warn("Stashpad: sort load failed", e);
    }
    this.cache.set(folder, map);
    return map;
  }

  /** Schedule a debounced write of the sort-mode map. See OrderStore.save for
   *  the rationale — same pattern, same window. */
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
    const path = `${folder}/${SORT_FILE}`;
    const adapter = this.app.vault.adapter;
    // 0.140.3 (review): merge on-disk parents we didn't touch this session, so a
    // mutation before load() resolves can't clobber other parents' sort modes.
    let existedButUnreadable = false;
    try {
      if (await adapter.exists(path)) {
        const parsed = JSON.parse(await adapter.read(path));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (!(k in map) && typeof v === "string" && VALID_MODES.has(v as SortMode)) map[k] = v as SortMode;
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
    try {
      if (Object.keys(map).length === 0) {
        if (existedButUnreadable) {
          console.warn("Stashpad: sort sidecar unreadable — keeping it rather than deleting", path);
          return;
        }
        // Skip the exists() probe — remove() throws if it's missing, which
        // we swallow. One round-trip instead of two on a network drive.
        try { await adapter.remove(path); } catch { /* file already gone */ }
      } else {
        await adapter.write(path, JSON.stringify(map, null, 2));
      }
    } catch (e) {
      console.warn("Stashpad: sort save failed", e);
    }
  }

  /** Get a parent's sort mode. Falls back to "manual" when no entry exists. */
  getMode(folder: string, parentId: StashpadId): SortMode {
    return this.cache.get(folder)?.[parentId] ?? "manual";
  }

  /** Set a parent's sort mode. Passing "manual" deletes the entry (manual is the
   *  absence of an entry — keeps the json file compact). */
  setMode(folder: string, parentId: StashpadId, mode: SortMode): void {
    const map = this.cache.get(folder) ?? {};
    if (mode === "manual") delete map[parentId];
    else map[parentId] = mode;
    this.cache.set(folder, map);
  }

  /** Drop a parent's entry — used when a parent note is deleted. */
  removeParent(folder: string, parentId: StashpadId): void {
    const map = this.cache.get(folder);
    if (!map) return;
    delete map[parentId];
  }

  invalidate(folder: string): void { this.cache.delete(folder); }
}
