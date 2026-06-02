import type { App } from "obsidian";

/** One recorded import. `sourcePath` is the vault path the file landed at
 *  when it was picked up (or the OS path when imported via the file
 *  picker, if known). `size` enables the name+size duplicate heuristic. */
export interface ImportLogEntry {
  ts: string;
  folder: string;
  kind: "md" | "file" | "folder";
  originalName: string;
  size: number | null;
  sourcePath: string | null;
  /** Resulting note path(s). One for md/file; many for a folder. */
  notePaths: string[];
}

/** 0.79.3: append-only import history, persisted as `import-log.jsonl` in
 *  the plugin private dir (next to log.jsonl / authors.json). Backs the
 *  de-dupe prompt ("this looks like a file you imported before") and a
 *  user-facing viewer so you can see / reference what you've imported. */
export class ImportLog {
  private readonly path: string;
  private entries: ImportLogEntry[] = [];
  private loaded = false;
  private dirOk = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private app: App, baseDir: string) {
    this.path = `${baseDir.replace(/\/+$/, "")}/import-log.jsonl`;
  }

  getPath(): string { return this.path; }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        const raw = await adapter.read(this.path);
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try { this.entries.push(JSON.parse(line)); } catch { /* skip bad line */ }
        }
      }
    } catch (e) {
      console.warn("[Stashpad] import log load failed", e);
    }
  }

  /** Newest-first snapshot. */
  recent(): ImportLogEntry[] {
    return [...this.entries].reverse();
  }

  /** A prior import with the same name AND size (the heuristic for "you
   *  probably already imported this"). Size match avoids flagging two
   *  genuinely different files that happen to share a name. */
  findDuplicate(name: string, size: number | null): ImportLogEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.originalName === name && (size == null || e.size == null || e.size === size)) return e;
    }
    return null;
  }

  append(entry: ImportLogEntry): void {
    this.entries.push(entry);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.ensureDir();
        await this.app.vault.adapter.append(this.path, JSON.stringify(entry) + "\n");
      } catch (e) {
        console.warn("[Stashpad] import log append failed", e);
      }
    });
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
