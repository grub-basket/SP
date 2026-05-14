import type { App } from "obsidian";
import type { LogEvent } from "./types";

/** StashpadLog persists action history + integrity state in a private
 *  directory. The directory path is supplied by the caller — historically
 *  it was `.stashpad/` at the vault root; it now defaults to the plugin's
 *  own private folder (set via the plugin's pluginPrivatePath helper). */
export class StashpadLog {
  /** Cached so we only check/create the directory once per session. */
  private dirOk = false;
  /** Serializes background log writes so concurrent appends don't trample each other. */
  private writeChain: Promise<void> = Promise.resolve();
  private readonly baseDir: string;
  private readonly logPath: string;
  private readonly statePath: string;

  /** Optional getter the plugin supplies so every appended log line is
   *  stamped with whoever performed the action. Lazy lookup (called on
   *  every append) so a name change in settings is reflected on the
   *  next log entry without re-wiring. Returns "" → field omitted. */
  private getAuthor: () => string;

  constructor(private app: App, baseDir: string, getAuthor?: () => string) {
    this.baseDir = baseDir.replace(/\/+$/, "");
    this.logPath = `${this.baseDir}/log.jsonl`;
    this.statePath = `${this.baseDir}/state.json`;
    this.getAuthor = getAuthor ?? (() => "");
  }

  /** Vault-relative path to the active log.jsonl — used by callers that
   *  want to "Reveal in file explorer" or open the file directly. */
  getLogPath(): string { return this.logPath; }
  /** Vault-relative path to the directory holding log + state. */
  getDir(): string { return this.baseDir; }

  private async ensureDir(): Promise<void> {
    if (this.dirOk) return;
    const adapter = this.app.vault.adapter;
    // mkdir intermediates (the dir might be nested several levels deep
    // under .obsidian/plugins/...).
    const parts = this.baseDir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    this.dirOk = true;
  }

  /** Fire-and-forget append. The line is queued behind any in-flight writes
   *  and persisted in the background. The log is write-only (nothing in the
   *  plugin reads it back), so there's no need for callers to await this.
   *  Errors are logged to the browser console instead of bubbling up. */
  append(ev: Omit<LogEvent, "ts"> & { ts?: string }): Promise<void> {
    // Auto-stamp author from the plugin's authorName setting if the
    // caller didn't already supply one. Most call sites don't think
    // about authorship; centralising it here means every log entry
    // (create / parent_change / delete / etc.) carries who did it.
    const author = ev.author ?? this.getAuthor() ?? "";
    const stamped: any = { ts: new Date().toISOString(), ...ev };
    if (author) stamped.author = author; else delete stamped.author;
    const line = JSON.stringify(stamped) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.ensureDir();
        const adapter: any = this.app.vault.adapter;
        if (typeof adapter.append === "function") {
          await adapter.append(this.logPath, line);
        } else {
          // Fallback for adapters without append(): existing read+rewrite.
          const existing = (await adapter.exists(this.logPath)) ? await adapter.read(this.logPath) : "";
          await adapter.write(this.logPath, existing + line);
        }
      } catch (e) {
        console.warn("Stashpad: log append failed", e);
      }
    });
    // Resolve immediately — callers that `await` get an instantly-resolved promise.
    return Promise.resolve();
  }

  async readState(): Promise<Record<string, { parent: string | null; path: string }>> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.statePath))) return {};
    try {
      return JSON.parse(await adapter.read(this.statePath));
    } catch {
      return {};
    }
  }

  async writeState(state: Record<string, { parent: string | null; path: string }>): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.write(this.statePath, JSON.stringify(state, null, 2));
  }
}
