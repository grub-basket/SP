import type { App } from "obsidian";

/** One rename event in an author's history. `at` is an ISO timestamp. */
export interface AuthorRename {
  from: string;
  to: string;
  at: string;
}

/** A single author's record in the registry. Keyed by the stable
 *  `authorId`. Everything except `id` is cosmetic / recoverable — the id
 *  is the only durable join key (it's also baked into every note's
 *  author/contributors frontmatter wikilink and into the stub filename). */
export interface AuthorRecord {
  id: string;
  /** Current best-known display name. */
  name: string;
  role?: string;
  department?: string;
  /** 0.501.0: an AI "bot" author (Claude, ChatGPT, …) rather than a person.
   *  Flagged in the UI and excluded from team notifications. */
  bot?: boolean;
  /** ISO timestamp first observed by the registry. */
  firstSeen: string;
  /** ISO timestamp last observed/updated. */
  lastSeen: string;
  /** Append-only rename history (oldest → newest). */
  renames: AuthorRename[];
}

interface RegistryFile {
  version: number;
  authors: Record<string, AuthorRecord>;
}

const REGISTRY_VERSION = 1;

/** AuthorRegistry — a REBUILDABLE cache + append-only rename history of
 *  every author the plugin has ever seen, persisted as `authors.json` in
 *  the plugin's private dir (next to log.jsonl / state.json).
 *
 *  IMPORTANT: this is explicitly NOT a source of truth. The authoritative
 *  identity is `settings.authorId` (for the local user) plus the id baked
 *  into each note's frontmatter + the `_authors/<name>-<id>.md` stub
 *  filenames. The registry can always be reconstructed by scanning the
 *  vault (see `rebuild()` in main.ts), so if it drifts, is corrupted, or
 *  is deleted, nothing breaks — we just rebuild it. Its value is:
 *    - recovery: regenerate a deleted stub from a remembered name/role/dept
 *    - history:  an audit trail of display-name renames over time
 *    - directory: a fast "who exists" lookup that avoids a full vault scan
 */
export class AuthorRegistry {
  private readonly path: string;
  private data: RegistryFile = { version: REGISTRY_VERSION, authors: {} };
  private loaded = false;
  private dirOk = false;
  /** Serializes saves so concurrent writes don't trample each other. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private app: App, baseDir: string) {
    this.path = `${baseDir.replace(/\/+$/, "")}/authors.json`;
  }

  getPath(): string { return this.path; }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const adapter = this.app.vault.adapter;
    // 0.517.2 (perf): read directly instead of exists-then-read. This runs on
    // the awaited startup path, and once anyone has an author identity the
    // file is there on every launch, so the existence check was a wasted
    // network round trip. A failed read still has to tell "no registry yet"
    // (silent, data untouched, as before) from an existing file that can't be
    // read (warn + start empty, as before). Desktop says so in the error code;
    // anything else asks once more, so a missing file costs no more than the
    // old check did on desktop and one extra local call elsewhere.
    let raw: string;
    try {
      raw = await adapter.read(this.path);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "ENOENT") return;
      let present = true;
      try { present = await adapter.exists(this.path); } catch { /* can't tell — warn as before */ }
      if (present) {
        console.warn("[Stashpad] author registry load failed; starting empty", e);
        this.data = { version: REGISTRY_VERSION, authors: {} };
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>;
      if (parsed && typeof parsed === "object" && parsed.authors) {
        this.data = {
          version: typeof parsed.version === "number" ? parsed.version : REGISTRY_VERSION,
          authors: parsed.authors,
        };
      }
    } catch (e) {
      console.warn("[Stashpad] author registry load failed; starting empty", e);
      this.data = { version: REGISTRY_VERSION, authors: {} };
    }
  }

  /** Snapshot of all known authors, newest-activity first. */
  all(): AuthorRecord[] {
    return Object.values(this.data.authors)
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
  }

  get(id: string): AuthorRecord | null {
    return this.data.authors[id] ?? null;
  }

  /** Upsert an author. If the display name changed, appends a rename
   *  event to the history. Updates lastSeen. Persists in the background.
   *  Returns true if anything changed (so callers can skip a redundant
   *  save when nothing did).
   *
   *  `opts.silent` updates the stored name WITHOUT appending a rename
   *  event — used by `saveSettings()`, which fires on every keystroke of
   *  the settings name field. Recording a rename there produced a
   *  per-character trail (J → Jo → Joh → John) in the history. The real
   *  rename is recorded once, on commit (blur/Enter), via `noteRename`.
   *  (0.497.0 — the 0.140.11 fix deferred the file rename but missed this
   *  registry path.) */
  record(info: { id: string; name?: string; role?: string; department?: string; bot?: boolean; at?: string }, opts?: { silent?: boolean }): boolean {
    const id = (info.id ?? "").trim();
    if (!id) return false;
    const now = info.at ?? new Date().toISOString();
    const name = (info.name ?? "").trim();
    const existing = this.data.authors[id];
    let changed = false;

    if (!existing) {
      this.data.authors[id] = {
        id,
        name,
        role: info.role?.trim() || undefined,
        department: info.department?.trim() || undefined,
        bot: info.bot || undefined,
        firstSeen: now,
        lastSeen: now,
        renames: [],
      };
      changed = true;
    } else {
      if (info.bot !== undefined && !!info.bot !== !!existing.bot) { existing.bot = info.bot || undefined; changed = true; }
      if (name && name !== existing.name) {
        if (!opts?.silent) existing.renames.push({ from: existing.name, to: name, at: now });
        existing.name = name;
        changed = true;
      }
      if (info.role !== undefined) {
        const r = info.role.trim() || undefined;
        if (r !== existing.role) { existing.role = r; changed = true; }
      }
      if (info.department !== undefined) {
        const d = info.department.trim() || undefined;
        if (d !== existing.department) { existing.department = d; changed = true; }
      }
      existing.lastSeen = now;
    }
    if (changed) void this.save();
    return changed;
  }

  /** Record a DELIBERATE rename as a single history event. Called on
   *  commit (blur/Enter) so the settings name field logs one entry per
   *  real rename instead of one per keystroke. No-op if the names are
   *  empty or identical, or the author isn't known yet. */
  noteRename(id: string, from: string, to: string, at?: string): boolean {
    id = (id ?? "").trim();
    from = (from ?? "").trim();
    to = (to ?? "").trim();
    if (!id || !from || !to || from === to) return false;
    const existing = this.data.authors[id];
    if (!existing) return false;
    existing.renames.push({ from, to, at: at ?? new Date().toISOString() });
    existing.name = to;
    existing.lastSeen = at ?? new Date().toISOString();
    void this.save();
    return true;
  }

  /** Forget an author's rename history (keeps the record + current name).
   *  Lets the user clear a junk trail — e.g. the pre-0.497.0 per-character
   *  history — without losing the author. Returns true if anything cleared. */
  clearRenames(id: string): boolean {
    id = (id ?? "").trim();
    const existing = this.data.authors[id];
    if (!existing || !existing.renames.length) return false;
    existing.renames = [];
    void this.save();
    return true;
  }

  /** Remove an author record entirely. The registry is a rebuildable
   *  cache, so this only forgets the cached name/role/dept + history; it
   *  does NOT touch notes or stub files (callers handle those). */
  remove(id: string): boolean {
    id = (id ?? "").trim();
    if (!id || !this.data.authors[id]) return false;
    delete this.data.authors[id];
    void this.save();
    return true;
  }

  /** Put a full author record back (used by merge's Undo to restore a
   *  source author that was removed). */
  restore(rec: AuthorRecord): void {
    if (!rec?.id) return;
    this.data.authors[rec.id] = rec;
    void this.save();
  }

  /** All known bot authors, newest-activity first. */
  bots(): AuthorRecord[] { return this.all().filter((a) => a.bot); }

  /** Replace the entire author set (used by rebuild()). Preserves
   *  firstSeen + rename history for ids that already existed. */
  replaceAll(records: Array<{ id: string; name?: string; role?: string; department?: string; bot?: boolean }>, at?: string): void {
    const now = at ?? new Date().toISOString();
    const next: Record<string, AuthorRecord> = {};
    for (const rec of records) {
      const id = (rec.id ?? "").trim();
      if (!id) continue;
      const prior = this.data.authors[id];
      const name = (rec.name ?? "").trim() || prior?.name || "";
      const renames = prior?.renames ? [...prior.renames] : [];
      if (prior && name && name !== prior.name) {
        renames.push({ from: prior.name, to: name, at: now });
      }
      next[id] = {
        id,
        name,
        role: rec.role?.trim() || prior?.role || undefined,
        department: rec.department?.trim() || prior?.department || undefined,
        bot: rec.bot || prior?.bot || undefined,
        firstSeen: prior?.firstSeen ?? now,
        lastSeen: now,
        renames,
      };
    }
    this.data = { version: REGISTRY_VERSION, authors: next };
    void this.save();
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

  /** Persist the registry. Chained so overlapping saves serialize. */
  save(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.ensureDir();
        await this.app.vault.adapter.write(this.path, JSON.stringify(this.data, null, 2));
      } catch (e) {
        console.warn("[Stashpad] author registry save failed", e);
      }
    });
    return this.writeChain;
  }
}
