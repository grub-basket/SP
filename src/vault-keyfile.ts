import type { App } from "obsidian";
import type { KeySlot } from "./vault-keyring";
import type { StashKdf } from "./stash-crypto";

/** The synced vault keyfile — distributes the single vault DEK to collaborators
 *  by public key (see docs/branches/encryption-collab.md). Everything in it is
 *  either public (pubkeys) or DEK-wrapped-to-a-pubkey, so it's safe to sync.
 *
 *  Lives in vault CONTENT (so it syncs — the plugin's own folder is per-device):
 *  primary at `.stashpad/keys.json`, with rolling backups in `_keys/` (the
 *  keyfile is the only thing between a collaborator and the DEK, so a corrupt or
 *  un-synced primary must not be fatal). */

export interface KeyfileIdentity { id: string; label: string; pubKey: string; addedAt: string; }
export interface KeyfileJoinRequest { id: string; label: string; pubKey: string; requestedAt: string; }
/** The DEK wrapped under a SHARED passphrase (Model 1: "share the password").
 *  `wrapped` = base64 of `encryptStash(dek, passphrase)`. Anyone who knows the
 *  passphrase unlocks — no per-device approval. Coexists with the public-key
 *  `slots` (both wrap the same DEK); a vault can use either or both. */
export interface KeyfilePasswordSlot { id: string; label: string; wrapped: string; kdf: StashKdf; createdAt: string; }
export interface VaultKeyfile {
  v: 2;
  keyId: string;
  identities: KeyfileIdentity[];
  slots: KeySlot[];
  joinRequests: KeyfileJoinRequest[];
  /** Optional — present only when a shared password is enabled. */
  passwordSlots?: KeyfilePasswordSlot[];
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

  private async ensureDir(dir: string): Promise<void> {
    try { if (!(await this.a.exists(dir))) await this.a.mkdir(dir); } catch { /* race / exists */ }
  }

  /** Write the primary, then rotate `_keys/keys-1..N.json` (keys-1 = newest). */
  async save(kf: VaultKeyfile): Promise<void> {
    const body = JSON.stringify(kf, null, 2);
    await this.ensureDir(PRIMARY_DIR);
    await this.a.write(PRIMARY, body);
    await this.ensureDir(BACKUP_DIR);
    for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
      const src = `${BACKUP_DIR}/keys-${i}.json`, dst = `${BACKUP_DIR}/keys-${i + 1}.json`;
      try { if (await this.a.exists(src)) await this.a.write(dst, await this.a.read(src)); } catch { /* best-effort */ }
    }
    try { await this.a.write(`${BACKUP_DIR}/keys-1.json`, body); } catch { /* best-effort */ }
  }
}
