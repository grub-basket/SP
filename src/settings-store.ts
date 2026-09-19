import type { Plugin } from "obsidian";
import { notify } from "./notify";
import {  } from "obsidian";
import {
  CONFIG_FILES, CONFIG_KEYS, CONFIG_POINTER_KEY, CONFIG_SUBFOLDERS,
  CONFIG_SENTINEL, CONFIG_SENTINEL_BODY, CONFIG_BACKUP_FILE,
} from "./config-layout";

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
  /** 0.378.0: the in-vault config folder ("" / null = off, everything classic).
   *  Set from the data.json pointer at load, or by enable/disable/relocate. */
  private configFolder: string | null = null;
  /** 0.379.0: additional folders that config WRITES fan out to — redundant,
   *  synced mirrors (e.g. the previous folder kept after a relocate). Read is
   *  always from the primary `configFolder`; mirrors are write-only backups. */
  private configMirrors: string[] = [];

  constructor(private plugin: Plugin) {}

  private dir(): string {
    // manifest.dir is `.obsidian/plugins/stashpad` (or the user's configDir equivalent).
    return this.plugin.manifest.dir ?? "";
  }

  /** 0.378.0: config-folder files resolve UNDER the config folder; everything
   *  else (data.json, history.json) stays in the plugin dir. */
  private pathFor(file: string): string {
    if (this.configFolder && file in CONFIG_FILES) return `${this.configFolder}/${file}`;
    return `${this.dir()}/${file}`;
  }

  /** 0.378.0: current config-folder path (null when off) — for the settings UI. */
  getConfigFolder(): string | null { return this.configFolder; }

  /** 0.379.0: the mirror folders (redundant synced copies) — for the settings UI. */
  getConfigMirrors(): string[] { return [...this.configMirrors]; }

  /** 0.379.0: every folder config lives in right now — primary + mirrors. Used to
   *  exclude them all from note scanning / link autocomplete. */
  configPaths(): string[] {
    return [this.configFolder, ...this.configMirrors].filter((f): f is string => !!f);
  }

  /** 0.379.0: stop mirroring to `folder` (leaves the folder on disk). */
  async removeConfigMirror(folder: string, settings: Bag): Promise<{ ok: boolean; error?: string }> {
    try {
      this.configMirrors = this.configMirrors.filter((m) => m !== folder);
      (settings as Bag)["configMirrors"] = [...this.configMirrors];
      await this.writeCoreWithPointer(settings, this.configFolder ?? "");
      this.snapshotKeys(settings, Object.keys(settings));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 0.379.2: start mirroring to `folder` — create + sentinel it, add it to the
   *  list, and populate it now (a full config write fans out to it). Symmetric
   *  with removeConfigMirror. Requires the config folder to be on, and the folder
   *  to be a different, valid path. */
  async addConfigMirror(folder: string, settings: Bag): Promise<{ ok: boolean; error?: string }> {
    if (!this.configFolder) return { ok: false, error: "the config folder is off" };
    const clean = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return { ok: false, error: "empty folder" };
    if (clean === this.configFolder) return { ok: false, error: "that's already the primary config folder" };
    if (this.configMirrors.includes(clean)) return { ok: true }; // already mirroring
    try {
      await this.ensureConfigFolder(clean);
      if (!(await this.sentinelPresent(clean))) return { ok: false, error: "couldn't create the folder or its sentinel" };
      this.configMirrors = [...this.configMirrors, clean];
      (settings as Bag)["configMirrors"] = [...this.configMirrors];
      await this.writeAllConfigFiles(settings); // fans out to the new mirror, populating it
      await this.writeCoreWithPointer(settings, this.configFolder);
      this.snapshotKeys(settings, Object.keys(settings));
      return { ok: true };
    } catch (e) {
      this.configMirrors = this.configMirrors.filter((m) => m !== clean); // roll back
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 0.378.0: the split files ACTIVE right now — history.json always, plus the
   *  config-folder files when the folder is enabled. */
  private activeFiles(): [string, readonly string[]][] {
    const out: [string, readonly string[]][] = Object.entries(SPLIT_FILES);
    if (this.configFolder) out.push(...Object.entries(CONFIG_FILES));
    return out;
  }

  /** 0.378.0: every key that lives OUTSIDE data.json right now — history.json's
   *  always, plus the config keys when the folder is on. Used to build the
   *  data.json payload (moved keys are excluded from it). */
  movedKeys(): Set<string> {
    const s = new Set<string>(MOVED_KEYS);
    if (this.configFolder) for (const k of CONFIG_KEYS) s.add(k);
    return s;
  }

  /** Every file this store owns, data.json included. */
  fileNames(): string[] {
    return ["data.json", ...this.activeFiles().map(([f]) => f)];
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
    await this.atomicWrite(this.pathFor(file), body);
    // 0.379.0: fan a config-file write out to every mirror folder (best-effort —
    // a mirror failing must never fail the primary write). A mirror without its
    // sentinel is skipped, same guard as the primary.
    if (this.configFolder && file in CONFIG_FILES && this.configMirrors.length) {
      for (const mirror of this.configMirrors) {
        if (!mirror || mirror === this.configFolder) continue;
        try {
          if (await this.sentinelPresent(mirror)) await this.atomicWrite(`${mirror}/${file}`, body);
        } catch { /* mirror is a redundant backup — ignore its failures */ }
      }
    }
  }

  /** 0.349.0: ATOMIC write — stage into a temp file, verify the bytes landed, then
   *  rename over the target (a crash/kill/sync mid-write can then only truncate the
   *  temp, never the live file). This is what stops an interrupted save from zeroing
   *  data.json — the corruption the loadAll() guard was catching after the fact.
   *  Mirrors FolderKeyStore.write. Falls back to a direct write only where
   *  rename-over-existing isn't supported, and reads back to confirm. */
  private async atomicWrite(path: string, body: string): Promise<void> {
    const a = this.plugin.app.vault.adapter;
    const tmp = `${path}.tmp`;
    // Stage + verify before touching the live file.
    await a.write(tmp, body);
    if ((await a.read(tmp)) !== body) {
      try { if (await a.exists(tmp)) await a.remove(tmp); } catch { /* best-effort */ }
      throw new Error(`Couldn't stage ${path} (verify failed).`);
    }
    let placed = false;
    try { await a.rename(tmp, path); placed = true; }
    catch {
      // rename-over-existing unsupported by this adapter: write straight over the
      // target (adapter.write truncates+writes in one step) rather than remove-first.
      try { await a.write(path, body); placed = true; } catch { /* verified below */ }
      try { if (await a.exists(tmp)) await a.remove(tmp); } catch { /* best-effort */ }
    }
    if (!placed || (await a.read(path)) !== body) throw new Error(`Couldn't write ${path} intact.`);
  }

  /** 0.349.0: atomically write the data.json-owned core (replaces the plugin's
   *  non-atomic saveData for the settings blob). */
  async saveCore(core: Bag): Promise<void> {
    await this.atomicWrite(this.pathFor("data.json"), JSON.stringify(core));
  }

  /** djb2 hash of a string → short hex, for naming a corrupt backup by CONTENT so an
   *  unchanged corrupt file is never backed up twice (was: `Date.now()` every load). */
  private static hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
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
    // 0.349.0 (startup): read data.json ONCE here and reuse the parse below,
    // instead of reading it for the corruption check and then again via loadData()
    // — one fewer disk round-trip on the launch critical path (matters on a
    // network/synced vault).
    let parsedBase: Bag | null = null;
    try {
      if (await adapter.exists(dataPath)) {
        const raw = await adapter.read(dataPath);
        if (raw.trim() === "") {
          // 0.349.0: an EMPTY data.json is almost always an interrupted write
          // (crash/kill/sync mid-save). There is nothing to recover, so treating
          // it as "corrupt, refuse to save" only strands the user on defaults
          // forever. Treat it as ABSENT instead: fall through to defaults and let
          // the next save (now atomic) heal it. Best-effort remove so the empty
          // file isn't re-read as corrupt next launch.
          try { await adapter.remove(dataPath); } catch { /* harmless if it lingers */ }
        } else {
          try {
            const p: unknown = JSON.parse(raw);
            parsedBase = p && typeof p === "object" ? (p as Bag) : null;
          } catch {
            this.corruptDataJson = true;
            // Name the backup by CONTENT hash so re-loading the SAME corrupt file
            // reuses one backup instead of minting a new `corrupt-<ts>` every launch
            // (that bug produced dozens of identical copies).
            const backup = `${dataPath}.corrupt-${SettingsStore.hash(raw)}`;
            try { if (!(await adapter.exists(backup))) await adapter.write(backup, raw); } catch { /* best effort */ }
            notify(
              "Stashpad: your settings file (data.json) is damaged and could not be read.\n"
              + `A copy was saved as ${backup.split("/").pop()}.\n`
              + "Settings are showing defaults for now and Stashpad will NOT save over the "
              + "damaged file this session, so it stays recoverable. Restart after restoring "
              + "a backup, or reconfigure and restart to start saving again.",
              0,
            );
          }
        }
      }
    } catch { /* adapter unavailable — fall through to the original behaviour */ }

    // Reuse the parse from above (falls back to loadData only if our own read
    // path was skipped by an adapter error — keeps the original behaviour).
    const base: Bag = parsedBase ?? (((await this.plugin.loadData()) as Bag | null) ?? {});
    const merged: Bag = { ...base };

    // 0.378.0: resolve the config-folder pointer BEFORE reading split files, so
    // activeFiles() includes the config files. Trust the pointer only if the
    // folder + sentinel are present (on a device where the folder hasn't synced
    // yet, read what's there and let the values fill in as it arrives — never
    // auto-revert, which would fight the sync).
    const pointer = typeof base[CONFIG_POINTER_KEY] === "string" ? (base[CONFIG_POINTER_KEY] as string).trim() : "";
    this.configFolder = pointer || null;
    this.configMirrors = Array.isArray(base["configMirrors"])
      ? (base["configMirrors"] as unknown[]).filter((m): m is string => typeof m === "string" && !!m && m !== this.configFolder)
      : [];
    if (this.configFolder && !(await this.sentinelPresent(this.configFolder))) {
      // The folder is enabled but not present (deleted, or not synced to this
      // device yet). Reads fall back to defaults and — because the sentinel
      // guard skips writes to a missing folder — edits to these settings won't
      // persist until it returns. Tell the user rather than let that be silent;
      // no data is lost (the config files, once they arrive, are untouched).
      notify(
        `Stashpad: the config folder "${this.configFolder}" isn't available yet.\n`
        + "Snippets, saved views, menus, templates and per-folder appearance are "
        + "showing defaults, and changes to them won't be saved until the folder "
        + "syncs to this device — or you turn off \"Store config in a vault folder\" "
        + "in settings to move everything back into data.json.",
        0,
      );
    }

    for (const [file, keys] of this.activeFiles()) {
      const disk = await this.readSplit(file);
      if (disk) {
        for (const k of keys) if (disk[k] !== undefined) merged[k] = disk[k];
        this.revs.set(file, typeof disk.rev === "number" ? disk.rev : 0);
      } else {
        this.revs.set(file, 0);
      }
    }

    // One-time migration: data.json still carrying HISTORY-split keys means this
    // is a pre-split install (or a partial migration that was interrupted).
    const leftovers = MOVED_KEYS.filter((k) => base[k] !== undefined);
    if (leftovers.length) await this.migrate(base, merged);
    // 0.378.0: an interrupted config migration can leave config keys in BOTH
    // data.json and the config files. The config-file copy already won the merge
    // above; finish the strip so data.json shrinks as intended.
    if (this.configFolder && CONFIG_KEYS.some((k) => base[k] !== undefined)) {
      await this.stripConfigKeysFromDataJson(base);
    }

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
      console.debug(`[Stashpad] settings split: moved ${MOVED_KEYS.length} keys out of data.json (backup: ${BACKUP_FILE}).`);
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

    for (const [file, keys] of this.activeFiles()) {
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
      // 0.378.0: never scatter config into a folder that isn't ours — the
      // sentinel must be present. If it's gone (folder deleted/renamed), skip
      // the config write this round; the keys stay safe in memory + data.json
      // fallback until the folder returns or the user reverts.
      if (file in CONFIG_FILES && !(await this.sentinelPresent(this.configFolder))) continue;
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
    for (const [file, keys] of this.activeFiles()) {
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

  // ---------- config folder (0.378.0) ----------

  /** True when the config folder's sentinel is present — the write guard. */
  private async sentinelPresent(folder: string | null): Promise<boolean> {
    if (!folder) return false;
    try { return await this.plugin.app.vault.adapter.exists(`${folder}/${CONFIG_SENTINEL}`); }
    catch { return false; }
  }

  /** Create the config folder (recursively), its category subfolders, and the
   *  sentinel file. Idempotent. */
  private async ensureConfigFolder(folder: string): Promise<void> {
    const a = this.plugin.app.vault.adapter;
    const mkChain = async (path: string): Promise<void> => {
      let cur = "";
      for (const seg of path.split("/").filter(Boolean)) {
        cur = cur ? `${cur}/${seg}` : seg;
        try { if (!(await a.exists(cur))) await a.mkdir(cur); } catch { /* concurrent */ }
      }
    };
    await mkChain(folder);
    for (const sub of CONFIG_SUBFOLDERS) await mkChain(`${folder}/${sub}`);
    const sentinel = `${folder}/${CONFIG_SENTINEL}`;
    try { if (!(await a.exists(sentinel))) await a.write(sentinel, CONFIG_SENTINEL_BODY); } catch { /* below */ }
  }

  /** Rewrite data.json without the config keys — finishes an interrupted
   *  migration on load. Keeps the pointer + everything else. */
  private async stripConfigKeysFromDataJson(base: Bag): Promise<void> {
    try {
      const drop = new Set<string>(CONFIG_KEYS);
      const stripped: Bag = {};
      for (const [k, v] of Object.entries(base)) if (!drop.has(k)) stripped[k] = v;
      stripped[CONFIG_POINTER_KEY] = this.configFolder ?? "";
      await this.saveCore(stripped);
    } catch (e) { console.warn("[Stashpad] couldn't finish config strip on load", e); }
  }

  /** Write + verify each category file from the live settings, into whatever
   *  `this.configFolder` currently points at. Throws on the first failure. */
  private async writeAllConfigFiles(settings: Bag): Promise<void> {
    for (const [file, keys] of Object.entries(CONFIG_FILES)) {
      const payload = SettingsStore.pick(settings, keys);
      const rev = (this.revs.get(file) ?? 0) + 1;
      await this.writeSplit(file, payload, rev); // atomicWrite verifies the bytes landed
      this.revs.set(file, rev);
    }
  }

  /** Build the data.json payload = settings minus the currently-moved keys, plus
   *  the pointer, and write it atomically. */
  private async writeCoreWithPointer(settings: Bag, pointer: string): Promise<void> {
    const moved = this.movedKeys();
    const core: Bag = {};
    for (const [k, v] of Object.entries(settings)) if (!moved.has(k)) core[k] = v;
    core[CONFIG_POINTER_KEY] = pointer;
    await this.saveCore(core);
  }

  /** ENABLE: back up data.json, copy every category out + verify, THEN set the
   *  pointer and strip the moved keys from data.json. Nothing is authoritative
   *  until the pointer write at the end — a failure anywhere leaves data.json
   *  intact and the folder ignored. Reversible via disableConfigFolder. */
  async enableConfigFolder(folder: string, settings: Bag): Promise<{ ok: boolean; error?: string }> {
    const a = this.plugin.app.vault.adapter;
    const clean = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return { ok: false, error: "empty folder" };
    try {
      await this.ensureConfigFolder(clean);
      if (!(await this.sentinelPresent(clean))) return { ok: false, error: "couldn't create the folder or its sentinel" };
      // One-time backup of data.json (never overwrite an existing backup).
      try {
        const backup = `${this.dir()}/${CONFIG_BACKUP_FILE}`;
        const dataPath = `${this.dir()}/data.json`;
        if (!(await a.exists(backup)) && await a.exists(dataPath)) await a.write(backup, await a.read(dataPath));
      } catch { /* best-effort */ }
      const prev = this.configFolder;
      this.configFolder = clean; // so pathFor + movedKeys resolve to the folder
      this.configMirrors = []; // fresh enable starts with no mirrors
      try {
        await this.writeAllConfigFiles(settings);
      } catch (e) {
        this.configFolder = prev; // pointer never got set — full rollback
        return { ok: false, error: `couldn't write config files: ${(e as Error).message}` };
      }
      (settings as Bag)[CONFIG_POINTER_KEY] = clean;
      (settings as Bag)["configMirrors"] = [];
      await this.writeCoreWithPointer(settings, clean); // strips moved keys from data.json
      this.snapshotKeys(settings, Object.keys(settings));
      console.debug(`[Stashpad] config folder enabled → ${clean}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** DISABLE: move the config keys back INTO data.json, clear the pointer. The
   *  in-memory `settings` already holds the current values, so we just rewrite
   *  data.json with them and drop the pointer. Leaves the folder in place. */
  async disableConfigFolder(settings: Bag): Promise<{ ok: boolean; error?: string }> {
    try {
      this.configFolder = null; // movedKeys() now excludes the config keys
      this.configMirrors = []; // 0.379.0: mirrors are meaningless once off
      (settings as Bag)[CONFIG_POINTER_KEY] = "";
      (settings as Bag)["configMirrors"] = [];
      await this.writeCoreWithPointer(settings, ""); // config keys ride back into data.json
      this.snapshotKeys(settings, Object.keys(settings));
      console.debug("[Stashpad] config folder disabled → back to data.json");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** RELOCATE: copy every category into the new folder + verify, then repoint.
   *  Leaves the old folder for the caller to offer to remove. */
  async relocateConfigFolder(newFolder: string, settings: Bag): Promise<{ ok: boolean; error?: string; oldFolder?: string }> {
    const clean = newFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return { ok: false, error: "empty folder" };
    if (!this.configFolder) return this.enableConfigFolder(clean, settings);
    const old = this.configFolder;
    if (clean === old) return { ok: true };
    try {
      await this.ensureConfigFolder(clean);
      if (!(await this.sentinelPresent(clean))) return { ok: false, error: "couldn't create the new folder" };
      // 0.379.0: keep the OLD folder as a synced mirror rather than orphaning
      // it — writes fan out to it (it already has its sentinel + files), it stays
      // ignored, and it syncs alongside the new one as a redundant backup.
      const mirrors = [...this.configMirrors.filter((m) => m !== clean && m !== old), old];
      this.configFolder = clean;
      this.configMirrors = mirrors;
      try {
        await this.writeAllConfigFiles(settings); // fans out to the mirror(s) too
      } catch (e) {
        this.configFolder = old; this.configMirrors = this.configMirrors.filter((m) => m !== old); // roll back
        return { ok: false, error: (e as Error).message };
      }
      (settings as Bag)[CONFIG_POINTER_KEY] = clean;
      (settings as Bag)["configMirrors"] = mirrors;
      await this.writeCoreWithPointer(settings, clean);
      this.snapshotKeys(settings, Object.keys(settings));
      console.debug(`[Stashpad] config folder relocated ${old} → ${clean} (old kept as mirror)`);
      return { ok: true, oldFolder: old };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
