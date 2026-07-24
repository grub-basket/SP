import type { App } from "obsidian";
import type { RenderEntry } from "./note-body-renderer";

/** Bump when the shape of a cached render changes in a way that makes old
 *  entries wrong (e.g. MarkdownRenderer output format, or RenderEntry
 *  fields). A schema mismatch on load discards the whole store. */
const CACHE_SCHEMA = 1;

/** 0.200.0 (perf L3): LRU bound. Entries hold full body text + rendered HTML,
 *  so an unbounded cache grows toward vault size and its save cost grows with
 *  it. On save, the least-recently-USED entries beyond this cap are dropped —
 *  they just re-render lazily if ever seen again. */
const MAX_ENTRIES = 4000;

/** The subset of Map that NoteBodyRenderer needs — lets it accept either a
 *  plain in-memory Map or this persisted store. */
export interface RenderCacheLike {
  get(path: string): RenderEntry | undefined;
  set(path: string, entry: RenderEntry): void;
  has(path: string): boolean;
}

/** 0.83.2: persisted render cache — one bulk load on startup repopulates the
 *  in-memory cache so a cold reopen doesn't re-read N note bodies over a slow
 *  drive. Entries are keyed by path and validated by `file.stat.mtime`.
 *
 *  0.200.0 (perf L2): storage moved from `render-cache.json` in the plugin dir
 *  — which lives ON the network share when the vault does, so every load/save
 *  paid the network — to IndexedDB, which is always on the local machine.
 *  Per-vault isolation via a vault-scoped key (IndexedDB is per-origin and
 *  Obsidian shares one origin across vaults). A legacy `render-cache.json` is
 *  migrated on first load and then DELETED — the cache holds note plaintext,
 *  and leaving a stale copy on disk would defeat encryption's lock /
 *  secure-delete guarantees (see docs/security-findings.md). If IndexedDB is
 *  unavailable, falls back to the legacy vault file transparently. */
export class RenderCacheStore implements RenderCacheLike {
  private legacyPath: string;
  private map = new Map<string, RenderEntry>();
  /** LRU clock: path -> last-touched ms. Persisted alongside entries. */
  private used = new Map<string, number>();
  private loaded = false;
  private dirty = false;
  private saveTimer: number | null = null;
  private dirOk = false;
  private writeChain: Promise<void> = Promise.resolve();
  private idbBroken = false;
  private static SAVE_DEBOUNCE_MS = 8000;
  private static IDB_NAME = "stashpad-render-cache";
  private static IDB_STORE = "kv";

  constructor(private app: App, baseDir: string) {
    this.legacyPath = `${baseDir.replace(/\/+$/, "")}/render-cache.json`;
  }

  /** Vault-scoped IndexedDB key (one origin serves every vault). */
  private idbKey(): string {
    const appId = (this.app as unknown as { appId?: string }).appId;
    return `render-cache:${appId || this.app.vault.getName()}`;
  }

  // ---- IndexedDB primitives (single-key blob; no per-entry rows) ----------

  private openDb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const req = indexedDB.open(RenderCacheStore.IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RenderCacheStore.IDB_STORE)) {
          db.createObjectStore(RenderCacheStore.IDB_STORE);
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => rej(new Error("indexedDB open blocked"));
    });
  }

  private async idbGet(): Promise<unknown> {
    const db = await this.openDb();
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction(RenderCacheStore.IDB_STORE, "readonly");
        const req = tx.objectStore(RenderCacheStore.IDB_STORE).get(this.idbKey());
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error ?? new Error("idb get failed"));
      });
    } finally { db.close(); }
  }

  private async idbSet(value: unknown): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(RenderCacheStore.IDB_STORE, "readwrite");
        tx.objectStore(RenderCacheStore.IDB_STORE).put(value, this.idbKey());
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error ?? new Error("idb put failed"));
        tx.onabort = () => rej(tx.error ?? new Error("idb tx aborted"));
      });
    } finally { db.close(); }
  }

  // ---- load / save --------------------------------------------------------

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let parsed: { schema?: number; entries?: Record<string, RenderEntry>; used?: Record<string, number> } | null = null;
    try {
      parsed = (await this.idbGet()) as typeof parsed;
    } catch (e) {
      console.warn("[Stashpad] render cache: IndexedDB unavailable, using vault-file fallback", e);
      this.idbBroken = true;
    }
    try {
      const adapter = this.app.vault.adapter;
      // Already IDB-backed but a legacy file (re)appeared — e.g. restored by a
      // sync tool. It's stale note PLAINTEXT that evict()/secure-delete can no
      // longer reach; remove it rather than letting it linger on the share.
      if (parsed && !this.idbBroken && (await adapter.exists(this.legacyPath))) {
        try { await adapter.remove(this.legacyPath); console.log("[Stashpad] removed stale legacy render-cache.json (IndexedDB is authoritative)"); }
        catch (e) { console.warn("[Stashpad] couldn't remove stale render-cache.json", e); }
      }
      if (!parsed && (await adapter.exists(this.legacyPath))) {
        // Legacy (or fallback-mode) vault file.
        parsed = JSON.parse(await adapter.read(this.legacyPath));
        if (!this.idbBroken && parsed) {
          // Migrate into IndexedDB, then remove the on-share copy. The file
          // holds note plaintext — leaving it behind would strand readable
          // bodies after a later lock/secure-delete evicts them from the
          // live store. Only delete once the IDB write actually landed.
          try {
            await this.idbSet(parsed);
            await adapter.remove(this.legacyPath);
            console.log("[Stashpad] render cache migrated to IndexedDB (render-cache.json removed)");
          } catch (e) {
            console.warn("[Stashpad] render cache migration failed; keeping vault file", e);
            this.idbBroken = true;
          }
        }
      }
      if (parsed?.schema === CACHE_SCHEMA && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) this.map.set(k, v);
        for (const [k, t] of Object.entries(parsed.used ?? {})) {
          if (this.map.has(k) && typeof t === "number") this.used.set(k, t);
        }
        // Drop entries for files that no longer exist — bounds growth.
        for (const k of [...this.map.keys()]) {
          if (!this.app.vault.getAbstractFileByPath(k)) { this.map.delete(k); this.used.delete(k); this.dirty = true; }
        }
      }
    } catch (e) {
      console.warn("[Stashpad] render cache load failed; starting empty", e);
      this.map.clear();
      this.used.clear();
    }
  }

  /** Drop a path's entry and flush promptly. Wired to vault delete/rename:
   *  entries hold the FULL note body + rendered HTML, so a deleted file's
   *  cache row is leftover plaintext — for encryption's lock / secure-delete
   *  (which permanently remove the readable note) it would silently defeat
   *  "the encrypted blob is the only surviving copy". */
  evict(path: string): void {
    if (!this.map.delete(path)) return;
    this.used.delete(path);
    this.dirty = true;
    void this.save();
  }

  get(path: string): RenderEntry | undefined {
    const e = this.map.get(path);
    if (e) this.used.set(path, Date.now()); // LRU touch (in-memory; persisted on next save)
    return e;
  }
  has(path: string): boolean { return this.map.has(path); }
  set(path: string, entry: RenderEntry): void {
    this.map.set(path, entry);
    this.used.set(path, Date.now());
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.save(); }, RenderCacheStore.SAVE_DEBOUNCE_MS);
  }

  /** Evict least-recently-used entries beyond MAX_ENTRIES (L3). Entries with
   *  no recorded use (pre-0.200.0 stores) count as oldest. */
  private pruneLru(): void {
    const over = this.map.size - MAX_ENTRIES;
    if (over <= 0) return;
    const ranked = [...this.map.keys()].sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0));
    for (const k of ranked.slice(0, over)) { this.map.delete(k); this.used.delete(k); }
  }

  /** Flush if dirty. Chained so overlapping saves serialize. Call on plugin
   *  unload to persist the latest. */
  save(): Promise<void> {
    if (this.saveTimer != null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    this.writeChain = this.writeChain.then(async () => {
      try {
        this.pruneLru();
        const obj = {
          schema: CACHE_SCHEMA,
          entries: Object.fromEntries(this.map),
          used: Object.fromEntries(this.used),
        };
        if (!this.idbBroken) {
          try { await this.idbSet(obj); return; } catch (e) {
            console.warn("[Stashpad] render cache IndexedDB save failed; falling back to vault file", e);
            this.idbBroken = true;
          }
        }
        await this.ensureDir();
        await this.app.vault.adapter.write(this.legacyPath, JSON.stringify(obj));
      } catch (e) {
        // Re-arm dirty so the next set()/evict() retries the write. Losing it
        // here would strand an evicted (deleted/locked) note's plaintext in the
        // persisted store after a transient failure — defeating secure-delete.
        // (0.140.5)
        this.dirty = true;
        console.warn("[Stashpad] render cache save failed", e);
      }
    });
    return this.writeChain;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirOk) return;
    const adapter = this.app.vault.adapter;
    const dir = this.legacyPath.slice(0, this.legacyPath.lastIndexOf("/"));
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    this.dirOk = true;
  }
}
