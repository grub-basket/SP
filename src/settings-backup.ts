import { App } from "obsidian";

/** 0.341.0: device-local settings backups. Snapshots of the core settings
 *  (data.json) are written per device into a dot-prefixed vault folder that
 *  Obsidian Sync doesn't carry between devices — so when a synced device
 *  overwrites this vault's settings, you can restore this device's last-good
 *  version. Capped per device. Best-effort throughout (never blocks a save). */
export class SettingsBackupStore {
  private root = ".stashpad-settings-backups";
  constructor(private app: App, private cap = 20) {}

  private dir(device: string): string { return `${this.root}/${device.replace(/[^\w.\-]+/g, "_")}`; }

  private async ensureDir(dir: string): Promise<void> {
    const a = this.app.vault.adapter;
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      try { if (!(await a.exists(cur))) await a.mkdir(cur); } catch { /* concurrent */ }
    }
  }

  async save(device: string, core: Record<string, unknown>): Promise<void> {
    try {
      const dir = this.dir(device);
      await this.ensureDir(dir);
      await this.app.vault.adapter.write(`${dir}/${Date.now()}.json`, JSON.stringify(core));
      await this.prune(device);
    } catch { /* best-effort */ }
  }

  private async prune(device: string): Promise<void> {
    try {
      const dir = this.dir(device);
      const l = await this.app.vault.adapter.list(dir);
      const files = (l.files ?? []).filter((f) => f.endsWith(".json")).sort(); // ts-named → lexical == chronological
      for (let i = 0; i < files.length - this.cap; i++) await this.app.vault.adapter.remove(files[i]);
    } catch { /* ignore */ }
  }

  /** Backups grouped by device, newest first within each. */
  async list(): Promise<{ device: string; backups: { ts: number; path: string }[] }[]> {
    try {
      if (!(await this.app.vault.adapter.exists(this.root))) return [];
      const top = await this.app.vault.adapter.list(this.root);
      const out: { device: string; backups: { ts: number; path: string }[] }[] = [];
      for (const d of (top.folders ?? [])) {
        const device = d.split("/").pop() ?? d;
        const l = await this.app.vault.adapter.list(d);
        const backups = (l.files ?? [])
          .filter((f) => f.endsWith(".json"))
          .map((p) => ({ ts: parseInt((p.split("/").pop() ?? "").replace(".json", ""), 10) || 0, path: p }))
          .sort((a, b) => b.ts - a.ts);
        if (backups.length) out.push({ device, backups });
      }
      return out;
    } catch { return []; }
  }

  async read(path: string): Promise<Record<string, unknown> | null> {
    try { return JSON.parse(await this.app.vault.adapter.read(path)); } catch { return null; }
  }
}
