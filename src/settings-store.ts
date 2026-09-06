import type { Plugin } from "obsidian";
import { Notice } from "obsidian";

/** 0.189.0 — persistence layer for plugin settings, split across several files.
 *
 *  Everything used to live in one `data.json`: 94 keys, ~15 KB, rewritten in full by
 *  all 85 `saveSettings()` call sites. Ticking a task rewrote your hotkeys, and one
 *  stale write from a synced device could clobber every domain at once.
 *
 *  This store keeps the IN-MEMORY settings object exactly as it was — callers still
 *  read `plugin.settings.x` and call `saveSettings()` — and changes only where each
 *  key lands on disk:
 *
 *    data.json      everything that must sync across devices (core prefs, hotkeys,
 *                   folder-panel pins, encryption state). Obsidian-native, written
 *                   via saveData, and still guarded by COLLISION_PROTECTED_KEYS.
 *    history.json   per-device reminder/draft churn. Device-local by design.
 *
 *  Two properties matter:
 *    1. A save only rewrites files whose contents ACTUALLY changed (the churn win) —
 *       so ticking a task no longer rewrites your hotkeys, and a reminder firing no
 *       longer rewrites your whole settings blob.
 *    2. Each file is guarded independently against a concurrent writer (a second
 *       Obsidian window on the same vault): before writing we re-read the file, and
 *       for any key WE didn't change but disk did, we adopt disk's value instead of
 *       clobbering it — the same rule as COLLISION_PROTECTED_KEYS, per file. */

/** Keys moved OUT of data.json. Anything not listed here stays in data.json.
 *
 *  SCOPE IS DELIBERATELY NARROW: Obsidian Sync only syncs `<pluginDir>/data.json`
 *  (learned the hard way in 0.113.0 — a relocated copy meant keybindings and pinned
 *  folders stopped propagating between devices). So anything that must sync —
 *  hotkeys, folder-panel pins, encryption prefs, core toggles — STAYS in data.json.
 *  Only per-device, machine-written churn moves out; that state is arguably wrong to
 *  sync anyway (one device's "already notified you about this reminder" shouldn't
 *  silence another's). */
export const SPLIT_FILES: Record<string, readonly string[]> = {
  "history.json": ["notifiedDueKeys", "persistReminderLog", "lastSubmitted", "drafts"],
};

/** Flat list of every key that no longer belongs in data.json. */
export const MOVED_KEYS: readonly string[] = Object.values(SPLIT_FILES).flat();

/** Filename of the one-time pre-split backup. Never overwritten once created. */
export const BACKUP_FILE = "data.json.pre-split.bak";

type Bag = Record<string, unknown>;

/** Reported back to the caller so it can notify / refresh UI for adopted domains. */
export interface AdoptionReport {
  /** file → keys whose on-disk value we adopted instead of overwriting. */
  adopted: Record<string, string[]>;
  /** True when anything at all was adopted. */
  any: boolean;
}

export class SettingsStore {
  /** key → JSON of the value as we last read/wrote it. The arbiter for "did WE
   *  change this, or did disk?" — same idea as the old settingsBaseline. */
  private baseline: Record<string, string | undefined> = {};
  /** file → last known rev (monotonic, bumped on each write of that file). */
  private revs = new Map<string, number>();

  constructor(private plugin: Plugin) {}

  private dir(): string {
    // manifest.dir is `.obsidian/plugins/stashpad` (or the user's configDir equivalent).
    return this.plugin.manifest.dir ?? "";
  }

  private pathFor(file: string): string {
    return `${this.dir()}/${file}`;
  }

  /** Every file this store owns, data.json included. */
  fileNames(): string[] {
    return ["data.json", ...Object.keys(SPLIT_FILES)];
  }

  /** Absolute-ish vault paths for all owned files — used by the external-change watcher. */
  watchPaths(): string[] {
    return this.fileNames().map((f) => this.pathFor(f));
  }

  private async readSplit(file: string): Promise<Bag | null> {
    try {
      const p = this.pathFor(file);
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(p))) return null;
      const raw = await adapter.read(p);
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Bag) : null;
    } catch {
      // Unreadable/corrupt → treat as absent. The caller falls back to whatever is
      // already in memory (data.json copy or defaults) and NEVER to empty.
      return null;
    }
  }

  private async writeSplit(file: string, payload: Bag, rev: number): Promise<void> {
    const body = JSON.stringify({ ...payload, rev }, null, 2);
    await this.plugin.app.vault.adapter.write(this.pathFor(file), body);
  }

  private static pick(src: Bag, keys: readonly string[]): Bag {
    const out: Bag = {};
    for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
    return out;
  }

  private snapshotKeys(src: Bag, keys: readonly string[]): void {
    for (const k of keys) this.baseline[k] = JSON.stringify(src[k]);
  }

  /** Read every file and merge into ONE object with the historic settings shape.
   *  Split files win over data.json (data.json's copies are stale leftovers from
   *  before migration); a missing split file falls back to data.json's copy, so a
   *  deleted/unreadable file never reads as "user cleared these settings".
   *
   *  Returns whatever `loadData()` returns (Obsidian types it loosely) so callers
   *  keep indexing it dynamically for legacy-key migrations — deriving the type from
   *  Plugin["loadData"] avoids writing an explicit `any`, which the community-plugin
   *  review rejects — as it does any lint-suppression directive for it. */
  /** 0.209.5: set when data.json existed but could not be parsed. The plugin must
   *  NOT save while this is true — a save would write defaults over a file the user
   *  can still recover by hand. Read via `loadFailed()`. */
  private corruptDataJson = false;
  loadFailed(): boolean { return this.corruptDataJson; }

  async loadAll(): ReturnType<Plugin["loadData"]> {
    // 0.209.5 DATA LOSS FIX: distinguish "absent" from "unparseable".
    //
    // This used to be `(await loadData()) ?? {}`. Obsidian's loadData() returns null
    // for BOTH cases, so a truncated data.json (crash or sync mid-write — the writes
    // here are not atomic) silently became `{}`, spread over DEFAULT_SETTINGS, and
    // was baselined as empty. Every key then read dirty and the next save wrote
    // defaults OVER the still-recoverable file: hotkeys, templates, colour aliases,
    // folder pins, and settings.encryption (the key-derivation identity) all gone,
    // with the evidence destroyed. Every OTHER store in this file already guards
    // exactly this (see readSplit: "NEVER to empty"); data.json, the most valuable
    // file, was the only one that did not.
    //
    // So: read it ourselves first. If it parses, or is genuinely absent, carry on as
    // before. If it is present but corrupt, preserve a copy, refuse to save for the
    // rest of the session, and tell the user rather than quietly resetting them.
    const dataPath = this.pathFor("data.json");
    const adapter = this.plugin.app.vault.adapter;
    try {
      if (await adapter.exists(dataPath)) {
        const raw = await adapter.read(dataPath);
        try {
          JSON.parse(raw);
        } catch {
          this.corruptDataJson = true;
          const backup = `${dataPath}.corrupt-${Date.now()}`;
          try { if (!(await adapter.exists(backup))) await adapter.write(backup, raw); } catch { /* best effort */ }
          new Notice(
            "Stashpad: your settings file (data.json) is damaged and could not be read.\n"
            + `A copy was saved as ${backup.split("/").pop()}.\n`
            + "Settings are showing defaults for now and Stashpad will NOT save over the "
            + "damaged file this session, so it stays recoverable. Restart after restoring "
            + "a backup, or reconfigure and restart to start saving again.",
            0,
          );
        }
      }
    } catch { /* adapter unavailable — fall through to the original behaviour */ }

    const base = ((await this.plugin.loadData()) as Bag | null) ?? {};
    const merged: Bag = { ...base };

    for (const [file, keys] of Object.entries(SPLIT_FILES)) {
      const disk = await this.readSplit(file);
      if (disk) {
        for (const k of keys) if (disk[k] !== undefined) merged[k] = disk[k];
        this.revs.set(file, typeof disk.rev === "number" ? disk.rev : 0);
      } else {
        this.revs.set(file, 0);
      }
    }

    // One-time migration: data.json still carrying moved keys means this is a
    // pre-split install (or a partial migration that was interrupted).
    const leftovers = MOVED_KEYS.filter((k) => base[k] !== undefined);
    if (leftovers.length) await this.migrate(base, merged);

    this.snapshotKeys(merged, Object.keys(merged));
    this.revs.set("data.json", typeof merged.settingsRev === "number" ? (merged.settingsRev as number) : 0);
    return merged;
  }

  /** Move the split keys out of data.json, after taking a full one-time backup.
   *  Idempotent: once data.json no longer carries the keys this never runs again. */
  private async migrate(base: Bag, merged: Bag): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    try {
      // 1. Full backup FIRST — nothing destructive happens before this lands.
      const backupPath = this.pathFor(BACKUP_FILE);
      if (!(await adapter.exists(backupPath))) {
        await adapter.write(backupPath, JSON.stringify(base, null, 2));
      }

      // 2. Write each split file from the merged view.
      for (const [file, keys] of Object.entries(SPLIT_FILES)) {
        const payload = SettingsStore.pick(merged, keys);
        // Don't create an empty file for a domain this vault never used.
        if (Object.keys(payload).length === 0) continue;
        await this.writeSplit(file, payload, (this.revs.get(file) ?? 0) + 1);
        this.revs.set(file, (this.revs.get(file) ?? 0) + 1);
      }

      // 3. Strip the moved keys from data.json and rewrite it.
      const stripped: Bag = {};
      const moved = new Set(MOVED_KEYS);
      for (const [k, v] of Object.entries(base)) if (!moved.has(k)) stripped[k] = v;
      await this.plugin.saveData(stripped);
      console.info(`[Stashpad] settings split: moved ${MOVED_KEYS.length} keys out of data.json (backup: ${BACKUP_FILE}).`);
    } catch (e) {
      // A failed migration is survivable: data.json still holds everything, and the
      // merged in-memory view is correct, so the app runs normally and we retry next load.
      console.error("[Stashpad] settings split migration failed — continuing on data.json.", e);
    }
  }

  /** Write the SPLIT files (data.json stays the caller's job — it still runs through
   *  the collision-protected guardedSave in main.ts). Files whose contents didn't
   *  change are skipped entirely; concurrent edits we'd otherwise clobber are adopted. */
  async saveSplit(settings: Bag): Promise<AdoptionReport> {
    const report: AdoptionReport = { adopted: {}, any: false };

    for (const [file, keys] of Object.entries(SPLIT_FILES)) {
      const changed = keys.some((k) => JSON.stringify(settings[k]) !== this.baseline[k]);
      const disk = await this.readSplit(file);

      // Collision guard: adopt any key WE didn't touch but disk did.
      if (disk) {
        const adopted: string[] = [];
        for (const k of keys) {
          const ours = JSON.stringify(settings[k]);
          const theirs = JSON.stringify(disk[k]);
          const oursChanged = ours !== this.baseline[k];
          const diskChanged = theirs !== this.baseline[k];
          if (!oursChanged && diskChanged && disk[k] !== undefined) {
            settings[k] = disk[k];
            adopted.push(k);
          }
        }
        if (adopted.length) {
          report.adopted[file] = adopted;
          report.any = true;
        }
        const diskRev = typeof disk.rev === "number" ? disk.rev : 0;
        if (diskRev > (this.revs.get(file) ?? 0)) this.revs.set(file, diskRev);
      }

      // Nothing of ours to persist for this domain → don't touch the file at all.
      if (!changed && !report.adopted[file]) continue;

      const payload = SettingsStore.pick(settings, keys);
      if (Object.keys(payload).length === 0) continue; // never write an empty domain over a populated one
      const rev = (this.revs.get(file) ?? 0) + 1;
      await this.writeSplit(file, payload, rev);
      this.revs.set(file, rev);
      this.snapshotKeys(settings, keys);
    }

    return report;
  }

  /** Did any key that still lives in data.json change since we last read/wrote it?
   *  Lets the caller skip the data.json write entirely when only per-device churn
   *  moved — so a reminder firing no longer rewrites your hotkeys. `settingsRev` is
   *  excluded because it's bookkeeping we bump *because* of a write, not a reason
   *  to write. */
  /** 0.292.0 (perf): `cur` is an optional cache of already-computed
   *  JSON.stringify(settings[k]) for the NON-MOVED keys, so a caller that has
   *  just stringified every key (guardedSave) doesn't pay for it twice. A miss
   *  falls back to stringifying, so the result is identical either way. */
  coreDirty(settings: Bag, cur?: Map<string, string>): boolean {
    const moved = new Set(MOVED_KEYS);
    for (const k of Object.keys(settings)) {
      if (moved.has(k) || k === "settingsRev") continue;
      const s = cur?.get(k) ?? JSON.stringify(settings[k]);
      if (s !== this.baseline[k]) return true;
    }
    return false;
  }

  /** Re-baseline the data.json-owned keys after the caller writes them. */
  markCoreSaved(settings: Bag): void {
    const moved = new Set(MOVED_KEYS);
    this.snapshotKeys(settings, Object.keys(settings).filter((k) => !moved.has(k)));
  }

  /** An outside writer (other window / synced device) touched one of our files:
   *  re-read it and adopt any key that differs from our baseline and that we didn't
   *  change ourselves. Returns which keys changed so the caller can refresh UI. */
  async adoptExternal(settings: Bag): Promise<AdoptionReport> {
    const report: AdoptionReport = { adopted: {}, any: false };
    for (const [file, keys] of Object.entries(SPLIT_FILES)) {
      const disk = await this.readSplit(file);
      if (!disk) continue;
      const diskRev = typeof disk.rev === "number" ? disk.rev : 0;
      if (diskRev <= (this.revs.get(file) ?? 0)) continue; // our own write, or nothing newer
      const adopted: string[] = [];
      for (const k of keys) {
        if (disk[k] === undefined) continue;
        if (JSON.stringify(disk[k]) === JSON.stringify(settings[k])) continue;
        settings[k] = disk[k];
        adopted.push(k);
      }
      this.revs.set(file, diskRev);
      if (adopted.length) {
        this.snapshotKeys(settings, keys);
        report.adopted[file] = adopted;
        report.any = true;
      }
    }
    return report;
  }

  /** Re-baseline everything (after an external adoption or a forced reload). */
  rebaseline(settings: Bag): void {
    this.snapshotKeys(settings, Object.keys(settings));
  }
}
