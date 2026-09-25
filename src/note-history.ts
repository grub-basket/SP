import { App, TFile } from "obsidian";

/** One captured version of a note's BODY (frontmatter excluded). Short keys keep
 *  the JSONL small: t=timestamp(ms), a=authorId, n=authorName, b=body. */
export interface NoteHistoryEntry {
  t: number;
  a: string;
  n: string;
  b: string;
}

/** 0.339.0: a compact line-level diff (LCS) from `a` (an older version) to `b`
 *  (usually the current note). Returns rows tagged same / del (in a, not b) /
 *  add (in b, not a) for the history viewer. Bodies are small, so O(n·m) is fine. */
export function lineDiff(a: string, b: string): { type: "same" | "add" | "del"; text: string }[] {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { type: "same" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: "same", text: A[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: "del", text: A[i] }); i++; }
    else { out.push({ type: "add", text: B[j] }); j++; }
  }
  while (i < n) { out.push({ type: "del", text: A[i] }); i++; }
  while (j < m) { out.push({ type: "add", text: B[j] }); j++; }
  return out;
}

/** 0.337.0: lightweight per-note version history. Each Stashpad folder keeps its
 *  notes' past bodies in `<folder>/.stashpad/history/<id>.jsonl` (append-style,
 *  capped + deduped), so you can see "what did this note say yesterday", diff a
 *  past version, and restore it. Stored WITH the notes (per folder) so it travels
 *  with a synced/backed-up vault.
 *
 *  This is Stashpad's OWN thorough-individual history; for keystroke-level history
 *  the settings point users to the Edit History community plugin. */
export class NoteHistoryStore {
  constructor(private app: App, private cap: () => number) {}

  /** 0.346.0: in-memory cache of the LAST captured body per `<folder>\0<id>`.
   *  capture() consults this BEFORE touching disk: an unchanged body is a no-op,
   *  so we skip both the read AND the write, removing the redundant disk read that
   *  otherwise ran on every capture attempt (the "silent I/O" concern). It only
   *  ever suppresses writes that would be exact repeats, so it can't drop a
   *  distinct version; a cold cache just falls through to the existing disk check. */
  private lastBody = new Map<string, string>();
  private bodyKey(folder: string, id: string): string {
    return `${folder}\0${id}`;
  }

  private dir(folder: string): string {
    return `${folder.replace(/\/+$/, "")}/.stashpad/history`;
  }
  private path(folder: string, id: string): string {
    return `${this.dir(folder)}/${id}.jsonl`;
  }
  /** 0.355.0: holding area for a trashed note's history — see trashHistory. */
  private trashDir(folder: string): string {
    return `${this.dir(folder)}/_trashed`;
  }
  private trashPath(folder: string, id: string): string {
    return `${this.trashDir(folder)}/${id}.jsonl`;
  }

  // (0.489.0: the old `ensureDir(folder)` wrapper is gone — every writer now goes
  // through `writeEnsuringDir`, which ensures the directory AND recovers from a
  // stale memo. A bare "ensure then write" is the shape that lost a version.)

  /** 0.489.0 (perf): directories this store has already created or confirmed this
   *  session. `mkdirp` ran its full `exists`-then-`mkdir` ladder on EVERY capture —
   *  measured at 3 adapter ops per note create, for a directory chain that cannot
   *  have gone away since the last note a moment earlier. Free on an SSD; at the
   *  300-600ms/op measured on the user's network share, ~1-2s of dead time per note.
   *
   *  Same shape as `StashpadLog`'s existing `dirOk` flag (log.ts) — that store
   *  already solved this; the pattern is copied rather than invented, widened to a
   *  Set because this one writes into several directories (per-folder history plus
   *  each folder's `_trashed`).
   *
   *  A stale entry is NOT harmless, and the first version of this memo got it wrong:
   *  if the history directory is deleted underneath us, skipping the `mkdir` makes
   *  `adapter.write` fail into `capture`'s best-effort catch and the version is
   *  SILENTLY LOST. A live test proved it (delete the dir, capture, no file). Obsidian
   *  fires no vault events for dotfolders — the same reason `.stashkey` needs a walk —
   *  so the memo cannot be invalidated reactively. Every write therefore goes through
   *  `writeEnsuringDir`, which on failure drops the memo, re-creates the chain and
   *  retries once. That makes the memo genuinely self-correcting: the fast path costs
   *  nothing, and the slow path is only ever taken when something really did vanish.
   *  Nothing about WHAT gets written changes. */
  private ensuredDirs = new Set<string>();

  /** Write into a directory this store owns, ensuring the directory first and
   *  RECOVERING if the memo turned out to be stale. Retries exactly once — a second
   *  failure is a real error (permissions, full disk, read-only share) and is
   *  rethrown so the caller's own error handling decides, rather than being hidden
   *  behind an infinite retry. */
  private async writeEnsuringDir(dir: string, path: string, data: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    await this.mkdirp(dir);
    try {
      await adapter.write(path, data);
      return;
    } catch (first) {
      // The directory we believed in is gone. Forget it (and its descendants, since
      // a parent delete takes them too), rebuild, and try again.
      for (const d of [...this.ensuredDirs]) {
        if (d === dir || d.startsWith(`${dir}/`) || dir.startsWith(`${d}/`)) this.ensuredDirs.delete(d);
      }
      await this.mkdirp(dir);
      try {
        await adapter.write(path, data);
      } catch {
        throw first;
      }
    }
  }

  /** 0.355.0: mkdir -p for an arbitrary vault-relative directory path. */
  private async mkdirp(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return;
    const adapter = this.app.vault.adapter;
    const parts = dir.split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      try { if (!(await adapter.exists(cur))) await adapter.mkdir(cur); } catch { /* concurrent create */ }
      // Remember each ANCESTOR too, so ensuring `<f>/.stashpad/history/_trashed`
      // after `<f>/.stashpad/history` costs one step rather than the whole ladder.
      this.ensuredDirs.add(cur);
    }
  }

  /** Append a version if the body actually changed since the last one. Prunes to
   *  the cap. Best-effort — a failure never blocks the edit that triggered it. */
  async capture(folder: string, id: string, body: string, author: { id: string; name: string } | null): Promise<void> {
    if (!folder || !id) return;
    // 0.346.0: cheap in-memory guard BEFORE any disk I/O — if this body matches
    // the last one we captured for this note, it's a no-op, so skip read + write.
    const key = this.bodyKey(folder, id);
    if (this.lastBody.get(key) === body) return; // unchanged since last capture
    try {
      const prev = await this.read(folder, id);
      if (prev.length && prev[prev.length - 1].b === body) { this.lastBody.set(key, body); return; } // unchanged
      const entry: NoteHistoryEntry = { t: Date.now(), a: author?.id ?? "", n: author?.name ?? "", b: body };
      let next = [...prev, entry];
      const cap = Math.max(2, this.cap());
      if (next.length > cap) next = next.slice(next.length - cap);
      await this.writeEnsuringDir(this.dir(folder), this.path(folder, id), next.map((e) => JSON.stringify(e)).join("\n") + "\n");
      this.lastBody.set(key, body); // 0.346.0: remember what we just wrote
    } catch { /* history is best-effort */ }
  }

  async read(folder: string, id: string): Promise<NoteHistoryEntry[]> {
    const p = this.path(folder, id);
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(p))) return [];
      const raw = await adapter.read(p);
      const out: NoteHistoryEntry[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.t === "number" && typeof e.b === "string") out.push(e);
        } catch { /* skip a corrupt line */ }
      }
      // 0.346.0: seed the last-body cache from disk (cheap — we already have it)
      // so a first capture after load can short-circuit without re-reading.
      if (out.length) this.lastBody.set(this.bodyKey(folder, id), out[out.length - 1].b);
      return out;
    } catch { return []; }
  }

  /** 0.351.0: the LAST recorded save for a note — author + time only — backing
   *  the folder "who last saved each note" overview. Reads the (small) jsonl and
   *  returns the newest entry's author/time; null when there's no history yet so
   *  the caller can fall back to the note's `author`/`modified` frontmatter. Bodies
   *  are parsed but not otherwise used, so this stays cheap even across a folder. */
  async lastSaved(folder: string, id: string): Promise<{ authorId: string; authorName: string; t: number } | null> {
    if (!folder || !id) return null;
    const entries = await this.read(folder, id);
    if (!entries.length) return null;
    // Append order is chronological, but pick the max `t` so an out-of-order or
    // clock-skewed line can't report a stale "last saved".
    let best = entries[0];
    for (const e of entries) if (e.t > best.t) best = e;
    return { authorId: best.a ?? "", authorName: best.n ?? "", t: best.t };
  }

  /** 0.339.0: delete a note's history file (call when the note is trashed). */
  async clear(folder: string, id: string): Promise<void> {
    if (!folder || !id) return;
    try {
      const p = this.path(folder, id);
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
      this.lastBody.delete(this.bodyKey(folder, id)); // 0.346.0: drop stale cache
    } catch { /* best-effort */ }
  }

  /** 0.355.0: move a note's history into the folder's `_trashed` holding area
   *  instead of hard-deleting it, so restoring the note from the OS trash can
   *  re-attach its timeline (see restoreHistory). Overwrites any existing
   *  trashed copy for the same id (a note trashed → recreated → trashed again
   *  keeps only the most recent history). No-op when there's no active file.
   *  Best-effort — never blocks the delete that triggered it. */
  async trashHistory(folder: string, id: string): Promise<void> {
    if (!folder || !id) return;
    try {
      const src = this.path(folder, id);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(src))) return;              // nothing to trash
      const raw = await adapter.read(src);
      const dest = this.trashPath(folder, id);
      // mkdirp FIRST so the `exists(dest)` below can't be answered by a missing
      // parent, then write through the recovering helper (see `ensuredDirs`).
      await this.mkdirp(this.trashDir(folder));
      if (await adapter.exists(dest)) await adapter.remove(dest); // overwrite
      await this.writeEnsuringDir(this.trashDir(folder), dest, raw);
      await adapter.remove(src);
      this.lastBody.delete(this.bodyKey(folder, id));         // active is gone
    } catch { /* best-effort */ }
  }

  /** 0.355.0: re-attach a trashed note's history when the note reappears (e.g.
   *  restored from the OS trash / re-synced). Moves `_trashed/<id>.jsonl` back
   *  to the active path ONLY when a trashed copy exists AND there's no active
   *  file already (never clobber live history). Returns whether it restored. */
  async restoreHistory(folder: string, id: string): Promise<boolean> {
    if (!folder || !id) return false;
    try {
      const adapter = this.app.vault.adapter;
      const trashed = this.trashPath(folder, id);
      if (!(await adapter.exists(trashed))) return false;     // nothing to restore
      const active = this.path(folder, id);
      if (await adapter.exists(active)) return false;         // don't clobber live history
      const raw = await adapter.read(trashed);
      await this.writeEnsuringDir(this.dir(folder), active, raw);
      await adapter.remove(trashed);
      this.lastBody.delete(this.bodyKey(folder, id));         // reseed lazily on next read
      return true;
    } catch { return false; }
  }

  /** 0.355.0: drop `_trashed/*.jsonl` older than `maxAgeDays` (by file mtime),
   *  so the holding area can't grow without bound. Best-effort; called
   *  opportunistically (once on layout-ready). */
  async pruneTrashedHistory(folder: string, maxAgeDays = 30): Promise<void> {
    if (!folder) return;
    try {
      const adapter = this.app.vault.adapter;
      const dir = this.trashDir(folder);
      if (!(await adapter.exists(dir))) return;
      const listing = await adapter.list(dir);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const p of listing.files) {
        if (!p.endsWith(".jsonl")) continue;
        try {
          const st = await adapter.stat(p);
          if (st && typeof st.mtime === "number" && st.mtime < cutoff) await adapter.remove(p);
        } catch { /* skip one */ }
      }
    } catch { /* best-effort */ }
  }

  /** 0.339.0: carry a note's history to a new folder when it moves between
   *  Stashpad folders, so the timeline survives the move. */
  async moveTo(fromFolder: string, toFolder: string, id: string): Promise<void> {
    if (!fromFolder || !toFolder || !id || fromFolder === toFolder) return;
    try {
      const src = this.path(fromFolder, id);
      if (!(await this.app.vault.adapter.exists(src))) return;
      const raw = await this.app.vault.adapter.read(src);
      await this.writeEnsuringDir(this.dir(toFolder), this.path(toFolder, id), raw);
      await this.app.vault.adapter.remove(src);
      // 0.346.0: carry the cached last-body to the new folder key.
      const from = this.bodyKey(fromFolder, id), to = this.bodyKey(toFolder, id);
      const cached = this.lastBody.get(from);
      if (cached !== undefined) { this.lastBody.set(to, cached); this.lastBody.delete(from); }
    } catch { /* best-effort */ }
  }

  /** History for a file, resolving its id + folder from the cache. */
  async readForFile(app: App, file: TFile): Promise<NoteHistoryEntry[]> {
    const id = (app.metadataCache.getFileCache(file)?.frontmatter as { id?: unknown } | undefined)?.id;
    const folder = file.parent?.path ?? "";
    if (typeof id !== "string" || !id) return [];
    return this.read(folder, id);
  }
}
