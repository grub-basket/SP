import type { App } from "obsidian";
import type { RenderEntry } from "./note-body-renderer";

/** Bump when the shape of a cached render changes in a way that makes old
 *  entries wrong (e.g. MarkdownRenderer output format, or RenderEntry
 *  fields). A schema mismatch on load discards the whole file. */
const CACHE_SCHEMA = 1;

/** The subset of Map that NoteBodyRenderer needs — lets it accept either a
 *  plain in-memory Map or this persisted store. */
export interface RenderCacheLike {
  get(path: string): RenderEntry | undefined;
  set(path: string, entry: RenderEntry): void;
  has(path: string): boolean;
}

/** 0.83.2: persisted render cache. The in-memory render cache is lost on
 *  reload, so a cold open of a big folder on a slow/network drive re-reads
 *  every visible body over the network (the profile's `render.row.read` at
 *  ~281ms each). This backs that cache with a single JSON file
 *  (`render-cache.json` in the plugin private dir): one bulk read on
 *  startup repopulates it, so subsequent renders hit cache (mtime-matched)
 *  instead of N per-note round-trips. Writes are debounced + flushed on
 *  unload. Entries are keyed by path and validated by `file.stat.mtime`, so
 *  an edited note re-renders automatically. */
export class RenderCacheStore implements RenderCacheLike {
  private path: string;
  private map = new Map<string, RenderEntry>();
  private loaded = false;
  private dirty = false;
  private saveTimer: number | null = null;
  private dirOk = false;
  private writeChain: Promise<void> = Promise.resolve();
  private static SAVE_DEBOUNCE_MS = 8000;

  constructor(private app: App, baseDir: string) {
    this.path = `${baseDir.replace(/\/+$/, "")}/render-cache.json`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        const parsed = JSON.parse(await adapter.read(this.path)) as
          { schema?: number; entries?: Record<string, RenderEntry> };
        if (parsed?.schema === CACHE_SCHEMA && parsed.entries) {
          for (const [k, v] of Object.entries(parsed.entries)) this.map.set(k, v);
          // Drop entries for files that no longer exist — bounds growth.
          for (const k of [...this.map.keys()]) {
            if (!this.app.vault.getAbstractFileByPath(k)) { this.map.delete(k); this.dirty = true; }
          }
        }
      }
    } catch (e) {
      console.warn("[Stashpad] render cache load failed; starting empty", e);
      this.map.clear();
    }
  }

  /** Drop a path's entry and flush promptly. Wired to vault delete/rename:
   *  entries hold the FULL note body + rendered HTML, so a deleted file's
   *  cache row is leftover plaintext on disk — for encryption's lock /
   *  secure-delete (which permanently remove the readable note) it would
   *  silently defeat "the encrypted blob is the only surviving copy". */
  evict(path: string): void {
    if (!this.map.delete(path)) return;
    this.dirty = true;
    void this.save();
  }

  get(path: string): RenderEntry | undefined { return this.map.get(path); }
  has(path: string): boolean { return this.map.has(path); }
  set(path: string, entry: RenderEntry): void {
    this.map.set(path, entry);
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.save(); }, RenderCacheStore.SAVE_DEBOUNCE_MS);
  }

  /** Flush to disk if dirty. Chained so overlapping saves serialize. Call
   *  on plugin unload to persist the latest. */
  save(): Promise<void> {
    if (this.saveTimer != null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.ensureDir();
        const obj = { schema: CACHE_SCHEMA, entries: Object.fromEntries(this.map) };
        await this.app.vault.adapter.write(this.path, JSON.stringify(obj));
      } catch (e) {
        console.warn("[Stashpad] render cache save failed", e);
      }
    });
    return this.writeChain;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirOk) return;
    const adapter = this.app.vault.adapter;
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    this.dirOk = true;
  }
}
