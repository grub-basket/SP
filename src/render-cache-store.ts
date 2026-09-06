import type { App } from "obsidian";
import type { RenderEntry } from "./note-body-renderer";

/** Bump when the shape of a cached render changes in a way that makes old
 *  entries wrong (e.g. MarkdownRenderer output format, or RenderEntry
 *  fields). A schema mismatch on load discards the whole store. */
// 0.271.6: bumped to 2 — the non-destructive rail change (embeds/links now stay
// in the body instead of being stripped) makes every pre-0.271.6 cached render
// wrong (their `text` has the attachments removed). Discarding the store forces
// a lazy recompute per note on next render, so existing notes pick up the inline
// embeds without a mass re-render on load.
// 0.272.2: bumped to 3 — file embeds are now de-embedded to visible links (no
// inline preview), so a cached `text`/`html` from schema 2 renders the old
// inline image. Same lazy per-note recompute on next render.
const CACHE_SCHEMA = 3;

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
  /** 0.294.0 (perf): resolves once the persisted store has been materialized.
   *  Absent on a plain Map (nothing to wait for). A consumer that is ALREADY
   *  async (a lazy body render) awaits it so it still gets a cache hit; every
   *  synchronous consumer just sees a miss until then. */
  ready?: Promise<void>;
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
  /** 0.294.0 (perf): the in-flight (or settled) load. `load()` returns it, so a
   *  second call is a no-op that still awaits the FIRST load's completion —
   *  the old `if (this.loaded) return` returned immediately while the first
   *  call was still deserializing. */
  private loadPromise: Promise<void> | null = null;
  /** 0.294.0 (perf): true once the deferred existence sweep has run. Until then
   *  the lazy per-get prune is DISABLED — during startup Obsidian's file index
   *  is still filling, so `getAbstractFileByPath` returns null for files that
   *  do exist and a prune would delete perfectly good entries. */
  private prunable = false;
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

  /** 0.294.0 (perf): resolves when `load()` has finished materializing the store.
   *  Never rejects (load() swallows its own errors). If nobody has started a load
   *  this is an already-resolved promise — a caller that never loads simply has
   *  an empty (but usable) cache. */
  get ready(): Promise<void> { return this.loadPromise ?? Promise.resolve(); }

  /** True once the persisted entries are in the map. A `get()` miss before this
   *  is "not loaded yet", not "not cached". */
  isLoaded(): boolean { return this.loaded; }

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInner();
    return this.loadPromise;
  }

  private async loadInner(): Promise<void> {
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
        // 0.294.0 (perf): load no longer blocks onload, so the map can already
        // hold entries by the time we get here — a lazy render that missed
        // (because we hadn't loaded yet) recomputed and `set()` it, or a
        // `primeRender` seeded a just-created note. MERGE rather than overwrite:
        //   - an entry set DURING the load is fresher than the persisted one and
        //     must win (otherwise the disk copy silently clobbers it), and
        //   - a path tombstoned during the load (a lock / secure-delete evict —
        //     see 0.211.5 below) must NOT be re-admitted from disk, or the
        //     plaintext we just purged comes straight back.
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (this.map.has(k) || this.tombstoned(k)) continue;
          this.map.set(k, v);
        }
        for (const [k, t] of Object.entries(parsed.used ?? {})) {
          if (this.map.has(k) && !this.used.has(k) && typeof t === "number") this.used.set(k, t);
        }
        // 0.294.0 (perf): the existence prune (one `getAbstractFileByPath` per
        // key — up to MAX_ENTRIES of them) used to run right here, on the load
        // path. It's pure housekeeping, so it moved off startup entirely:
        // `pruneMissing()` is called from a deferred sweep after layout-ready,
        // and `get()` drops a stale key lazily once sweeping is enabled.
      }
    } catch (e) {
      console.warn("[Stashpad] render cache load failed; starting empty", e);
      this.map.clear();
      this.used.clear();
    } finally {
      this.loaded = true;
    }
  }

  /** 0.294.0 (perf): drop entries whose file no longer exists — bounds growth.
   *  Call AFTER the workspace is ready (Obsidian's file index must be populated,
   *  or every lookup misses and this deletes the whole cache). Enables the lazy
   *  per-`get()` prune from here on. Safe to call more than once. */
  pruneMissing(): void {
    if (!this.loaded) { void this.ready.then(() => this.pruneMissing()); return; }
    for (const k of [...this.map.keys()]) {
      if (!this.app.vault.getAbstractFileByPath(k)) { this.map.delete(k); this.used.delete(k); this.dirty = true; }
    }
    this.prunable = true;
    if (this.dirty) this.scheduleSave();
  }

  /** Drop a path's entry (persisted per `opts.flush`). Wired to vault delete/rename:
   *  entries hold the FULL note body + rendered HTML, so a deleted file's
   *  cache row is leftover plaintext — for encryption's lock / secure-delete
   *  (which permanently remove the readable note) it would silently defeat
   *  "the encrypted blob is the only surviving copy". */
  /** 0.211.5 (M9): evicting must TOMBSTONE the path, not just delete it.
   *
   *  The old body returned early when the path wasn't in the map — which is exactly
   *  the dangerous case. A lazy render started before the lock resolves afterwards and
   *  calls set() with the full plaintext body and rendered HTML, the debounce persists
   *  it, and the note's plaintext is back on disk in the cache after encryption
   *  claimed the blob was the only surviving copy. Evict now always records the path,
   *  and set() refuses to re-admit a tombstoned one.
   *
   *  The tombstone expires so a note that is later unlocked or recreated can cache
   *  again without anyone having to clear it by hand. The window only needs to outlast
   *  an in-flight render; during it the note still renders normally, it just isn't
   *  cached. */
  private tombstones = new Map<string, number>(); // path -> expiry (epoch ms)
  private static readonly TOMBSTONE_MS = 60_000;

  private tombstoned(path: string): boolean {
    const until = this.tombstones.get(path);
    if (until === undefined) return false;
    if (Date.now() >= until) { this.tombstones.delete(path); return false; }
    return true;
  }

  /** 0.292.0 (perf): the in-memory delete + tombstone stay IMMEDIATE (a later
   *  get() misses at once and set() still refuses to re-admit), but persistence
   *  is now debounced through the same scheduleSave() path set() uses. evict()
   *  fires on every ordinary body modify — Obsidian's ~2s editor autosave, each
   *  file of a sync burst, the edit modal — and each eager save() serialized the
   *  WHOLE cache (up to 4000 entries of body text + rendered HTML) into
   *  IndexedDB. Callers with a security motive (the plaintext must not outlive
   *  the write) pass `{ flush: true }` to keep the old eager behavior. */
  /** 0.293.0 (perf): the tombstone is a SECURITY device (0.211.5, above) and now
   *  fires only for security evicts. It was applied to EVERY evict — including the
   *  ordinary body-modify ones (external edit, sync, editor autosave, the 0.291.0
   *  edit-modal save, checkbox toggle/undo) — so for a full minute after any edit
   *  the freshly rendered body could not be re-admitted and every subsequent paint
   *  of that note re-rendered it from markdown. Exactly backwards for a cache.
   *
   *  `tombstone` defaults to `flush`: the only security caller is the vault
   *  `delete` event (src/main.ts), which is how lock / secure-delete purge
   *  plaintext (encryption-ops uses `vault.delete`, never trash), and it already
   *  passes `{ flush: true }`. A future security caller that wants a debounced
   *  save can still ask for the tombstone explicitly.
   *
   *  Safe for the perf callers: entries are mtime-validated on EVERY read
   *  (`getOrComputeRender` / `hasFreshRenderCache` in note-body-renderer.ts compare
   *  `entry.mtime === file.stat.mtime`), so a stale entry is never served — it just
   *  misses. Dropping the entry + its LRU slot is the whole job there; the next
   *  `set()` re-warms immediately. */
  evict(path: string, opts: { flush?: boolean; tombstone?: boolean } = {}): void {
    if (opts.tombstone ?? opts.flush) this.tombstones.set(path, Date.now() + RenderCacheStore.TOMBSTONE_MS);
    const had = this.map.delete(path);
    this.used.delete(path);
    if (!had) return; // nothing persisted to rewrite; any tombstone set above stands
    this.dirty = true;
    if (opts.flush) void this.save(); // save() also clears any pending debounce timer
    else this.scheduleSave();
  }

  get(path: string): RenderEntry | undefined {
    const e = this.map.get(path);
    if (!e) return undefined;
    // 0.294.0 (perf): lazy half of the existence prune the load path used to do
    // eagerly. Only once `pruneMissing()` has enabled it — before that a null
    // lookup means "the vault index hasn't got there yet", not "file gone".
    if (this.prunable && !this.app.vault.getAbstractFileByPath(path)) {
      this.map.delete(path); this.used.delete(path); this.dirty = true; this.scheduleSave();
      return undefined;
    }
    this.used.set(path, Date.now()); // LRU touch (in-memory; persisted on next save)
    return e;
  }
  has(path: string): boolean { return this.map.has(path); }
  set(path: string, entry: RenderEntry): void {
    // 0.211.5 (M9): refuse a tombstoned path. This is the half of the fix that
    // actually stops the plaintext coming back — a render started before the lock
    // resolves afterwards and lands here with the full body.
    if (this.tombstoned(path)) return;
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
        // 0.294.0 (perf): load() is no longer awaited in onload, so a save can be
        // reached (a first render's debounce, or the unload flush) while the map
        // is still EMPTY — and this serializes the whole map, which would write
        // that empty map over the entire persisted cache. Wait for the load to
        // merge in first. Resolves immediately if no load was ever started, and
        // load()'s merge already refuses to re-admit anything tombstoned, so a
        // security flush still can't be undone by the entries it waits for.
        await this.ready;
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
