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
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        const parsed = JSON.parse(await adapter.read(this.path)) as Partial<RegistryFile>;
        if (parsed && typeof parsed === "object" && parsed.authors) {
          this.data = {
            version: typeof parsed.version === "number" ? parsed.version : REGISTRY_VERSION,
            authors: parsed.authors as Record<string, AuthorRecord>,
          };
        }
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
   *  save when nothing did). */
  record(info: { id: string; name?: string; role?: string; department?: string; at?: string }): boolean {
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
        firstSeen: now,
        lastSeen: now,
        renames: [],
      };
      changed = true;
    } else {
      if (name && name !== existing.name) {
        existing.renames.push({ from: existing.name, to: name, at: now });
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

  /** Replace the entire author set (used by rebuild()). Preserves
   *  firstSeen + rename history for ids that already existed. */
  replaceAll(records: Array<{ id: string; name?: string; role?: string; department?: string }>, at?: string): void {
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
