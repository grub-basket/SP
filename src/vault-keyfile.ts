import type { App } from "obsidian";
import type { StashKdf } from "./stash-crypto";

/** The legacy synced vault keyfile. (0.143.0: the vault-wide DEK it distributed is
 *  gone — encryption is per-folder now. This is READ ONLY for back-compat: its
 *  `folderKeys` still feed folders not yet migrated to a `.stashkey`, and
 *  `migrateKeyfileToStashKeys` relocates them. The vault-DEK fields
 *  (`slots`/`identities`/`joinRequests`/`passwordSlots`) are dead — parsed but
 *  never used. Phase 5 retires the file entirely.)
 *
 *  Primary at `.stashpad/keys.json`, rolling backups in `_keys/`. */

export interface KeyfileIdentity { id: string; label: string; pubKey: string; addedAt: string; }
export interface KeyfileJoinRequest { id: string; label: string; pubKey: string; requestedAt: string; }
/** The DEK wrapped under a SHARED passphrase (Model 1: "share the password").
 *  `wrapped` = base64 of `encryptStash(dek, passphrase)`. Anyone who knows the
 *  passphrase unlocks — no per-device approval. Coexists with the public-key
 *  `slots` (both wrap the same DEK); a vault can use either or both. */
export interface KeyfilePasswordSlot { id: string; label: string; wrapped: string; kdf: StashKdf; createdAt: string; }

/** A PER-FOLDER encryption key (per-folder overhaul, Phase A). Each top-level
 *  encrypted Stashpad folder gets its OWN DEK, wrapped under that folder's
 *  password(s) as `passwordSlots`. Subfolders inherit the parent's key (the
 *  encrypted unit is the whole subtree under one key — no per-subfolder keys).
 *
 *  Keyed by cleaned folder PATH in `VaultKeyfile.folderKeys`. Folders are
 *  path-based in Stashpad (no stable folder ids), so a folder rename orphans its
 *  entry — handled by a rename hook / "recover orphaned key" follow-up.
 *
 *  Backward-compatible OVERLAY: a folder WITHOUT an entry here falls back to the
 *  vault-wide DEK (`slots` / `passwordSlots`), so all existing single-DEK content
 *  keeps decrypting unchanged. Deprecated slots/keys are RETAINED, never deleted
 *  (recovery net + the [deprecated] convention from the overhaul plan). */
export interface FolderKeyEntry {
  /** Stable id for this folder key — used for the per-folder keychain id + labels. */
  keyId: string;
  /** Last-known folder path (for labels/UX; identity is the map key). */
  folderPath: string;
  /** "YYYY-MM-DD HH:mm – <folder> – <author|authorId>" (see overhaul plan #3). */
  label: string;
  /** The OS-keychain secret id for this key — a sanitized, recognizable form of the
   *  label (`^[a-z0-9-]{1,64}$`), so the entry reads as timestamp-folder-author in
   *  the keychain rather than an opaque random id. Optional for back-compat: entries
   *  created before this fall back to a keyId-based id. */
  kcId?: string;
  /** The folder DEK wrapped under the folder password(s). Old (changed) slots are
   *  kept with `deprecated: true` rather than deleted. */
  passwordSlots: KeyfilePasswordSlot[];
  createdAt: string;
  /** Legacy: whole key retired; kept only as a recovery artifact. (Phase-B rotation
   *  that set this is removed as of 0.142.0 — read-only back-compat now.) */
  deprecated?: boolean;
}

export interface VaultKeyfile {
  v: 2;
  keyId: string;
  /** Dead vault-DEK fields — parsed for validation of old keyfiles, never used. */
  identities: KeyfileIdentity[];
  slots: unknown[];
  joinRequests: KeyfileJoinRequest[];
  /** Optional — present only when a shared password is enabled (vault-wide DEK). */
  passwordSlots?: KeyfilePasswordSlot[];
  /** Optional — per-folder keys (overlay on the vault DEK). Keyed by folder path. */
  folderKeys?: Record<string, FolderKeyEntry>;
}

const PRIMARY = ".stashpad/keys.json";
const PRIMARY_DIR = ".stashpad";
const BACKUP_DIR = "_keys";
const BACKUP_KEEP = 5;

export function emptyKeyfile(keyId: string): VaultKeyfile {
  return { v: 2, keyId, identities: [], slots: [], joinRequests: [] };
}

export class KeyfileStore {
  constructor(private app: App) {}
  private get a() { return this.app.vault.adapter; }

  private validate(j: unknown): j is VaultKeyfile {
    const k = j as VaultKeyfile;
    return !!k && k.v === 2 && typeof k.keyId === "string"
      && Array.isArray(k.identities) && Array.isArray(k.slots) && Array.isArray(k.joinRequests);
  }

  private async readValid(path: string): Promise<VaultKeyfile | null> {
    try {
      if (!(await this.a.exists(path))) return null;
      const j = JSON.parse(await this.a.read(path));
      return this.validate(j) ? j : null;
    } catch { return null; }
  }

  /** Primary first; on a missing/corrupt primary fall back to the newest valid
   *  backup (also covers a sync tool that skips the dotfolder but keeps `_keys/`). */
  async load(): Promise<VaultKeyfile | null> {
    const primary = await this.readValid(PRIMARY);
    if (primary) return primary;
    try {
      const list = await this.a.list(BACKUP_DIR);
      const backups = (list.files || []).filter((f) => /\/keys-\d+\.json$/.test(f)).sort();
      for (const f of backups.reverse()) { const b = await this.readValid(f); if (b) return b; }
    } catch { /* no backups */ }
    return null;
  }

  async exists(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  /** True if a keyfile FILE is present on disk (primary or any backup), even if
   *  it's corrupt/unreadable. Distinguishes "keyfile unreadable right now" (a
   *  sync tool mid-write, a lagging `_keys/`) from "genuinely never set up" — so
   *  destructive first-time paths (v1 migration, fresh setup) can REFUSE rather
   *  than clobber a real-but-unreadable keyfile with a fresh single-slot one. 0.140.13 */
  async hasAnyFile(): Promise<boolean> {
    try { if (await this.a.exists(PRIMARY)) return true; } catch { /* fall through */ }
    try {
      const list = await this.a.list(BACKUP_DIR);
      return (list.files || []).some((f) => /\/keys-\d+\.json$/.test(f));
    } catch { return false; }
  }

  private async ensureDir(dir: string): Promise<void> {
    try { if (!(await this.a.exists(dir))) await this.a.mkdir(dir); } catch { /* race / exists */ }
  }

  /** Write the primary, then rotate `_keys/keys-1..N.json` (keys-1 = newest). */
  async save(kf: VaultKeyfile): Promise<void> {
    const body = JSON.stringify(kf, null, 2);
    await this.ensureDir(PRIMARY_DIR);
    // 0.140.18: atomic-ish primary write. Write a temp file, then rename it over
    // the primary — a crash mid-write corrupts only the temp, never the live
    // keyfile (rename within one directory is atomic on desktop). This removes
    // the "partial primary write" precondition behind the stale-backup rollback.
    // Falls back to a direct write if rename isn't supported (some mobile adapters).
    const tmp = `${PRIMARY}.tmp`;
    let wrote = false;
    try {
      await this.a.write(tmp, body);
      try {
        await this.a.rename(tmp, PRIMARY);            // atomic overwrite (POSIX)
      } catch {
        try { await this.a.remove(PRIMARY); } catch { /* may not exist */ }
        await this.a.rename(tmp, PRIMARY);            // retry after clearing dst (Windows)
      }
      wrote = true;
    } catch {
      try { if (await this.a.exists(tmp)) await this.a.remove(tmp); } catch { /* best-effort */ }
    }
    if (!wrote) await this.a.write(PRIMARY, body);    // last-resort direct write
    await this.ensureDir(BACKUP_DIR);
    for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
      const src = `${BACKUP_DIR}/keys-${i}.json`, dst = `${BACKUP_DIR}/keys-${i + 1}.json`;
      try { if (await this.a.exists(src)) await this.a.write(dst, await this.a.read(src)); } catch { /* best-effort */ }
    }
    try { await this.a.write(`${BACKUP_DIR}/keys-1.json`, body); } catch { /* best-effort */ }
  }
}
