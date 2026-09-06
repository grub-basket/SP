import type { App } from "obsidian";
import { encryptStash, decryptStash, argon2Available } from "./stash-crypto";
import { newId } from "./id-service";
import { KeyfileStore, type VaultKeyfile, type FolderKeyEntry, type KeyfilePasswordSlot } from "./vault-keyfile";
import { FolderKeystore, type StashKey } from "./folder-keystore";

/** Legacy base for a folder key's fallback keychain id (`<base>-f-<keyId>`) — used
 *  for folder entries created before per-key `kcId`s existed. */
const LEGACY_KEYCHAIN_ID = "stashpad-vault-encryption";

interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void | Promise<void>;
  removeSecret?(id: string): void | Promise<void>;
}

/** Per-folder encryption — key management, one `.stashkey` per encrypted folder.
 *
 *  (0.143.0: the vault-wide DEK / central keyfile are gone from the key path.
 *  Each encrypted folder owns a `.stashkey` inside it — a random DEK wrapped under
 *  the folder password, plus an optional recovery slot — that travels with the
 *  folder. A folder with no `.stashkey` is simply NOT encrypted; there is no
 *  vault-wide fallback key. `.stashenc`/`.stashmeta` content format is unchanged.
 *  The unwrapped per-folder DEKs live only in memory, keyed by owning folder.) */

/** Persisted PER-DEVICE state (plugin settings). The only thing kept here now is
 *  the keychain-id registry — secretStorage has no list API, so folder auto-unlock
 *  cycles these known candidates to find a saved folder password. */
export interface EncryptionConfig {
  /** Every keychain id this device has ever written (folder keys + parked
   *  `-r<stamp>`/`-d<slotId>` copies). Without it, parked entries are unreachable. */
  knownKeychainIds?: string[];
}

export function defaultEncryptionConfig(): EncryptionConfig {
  return {};
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const DEK_LEN = 32; // 256-bit per-folder key

export class EncryptionService {
  /** Unlocked per-folder DEKs, keyed by cleaned OWNING folder path. Zeroed on
   *  lock()/lockFolder(). A folder with no entry here is locked (or unencrypted). */
  private folderSessionKeys = new Map<string, Uint8Array>();
  private keyfiles: KeyfileStore;
  /** In-memory cache of the synced keyfile (refreshed via init()/refresh()). */
  private kf: VaultKeyfile | null = null;
  /** Keyfile-removal (Phase 2b): per-folder `.stashkey` files, keyed by cleaned
   *  folder path. This is the NEW source of truth; the central keyfile above is a
   *  read-only fallback for folders not yet migrated. Scanned once per session
   *  (dirty flag re-scans after a mutation). See docs/encryption-keyfile-removal-plan.md. */
  private folderKeystore: FolderKeystore;
  private folderKeyFiles = new Map<string, StashKey>();
  private stashKeysIndexed = false;
  /** 0.294.0 (perf): the in-flight `.stashkey` walk, so concurrent callers share
   *  one traversal instead of each starting their own. */
  private indexPromise: Promise<void> | null = null;
  /** Cached: is there still-recoverable legacy key material on disk — a live
   *  `_keys/` backup OR a parked `.stashpad/retired-keyfile-*` dir from a prior
   *  retire? Refreshed in refresh(); drives the settings "hard-wipe" affordance so
   *  it's reachable even after the live keyfile is already parked. (0.144.1) */
  private parkedKeyMaterial = false;

  // (0.135.0: the idle auto-lock timer is gone — armIdle/clearIdle/idleMinutes
  // removed. The session key lives until Obsidian closes or encryption is
  // removed/re-passworded.)
  constructor(
    private app: App,
    private load: () => EncryptionConfig,
    private save: (cfg: EncryptionConfig) => Promise<void>,
  ) { this.keyfiles = new KeyfileStore(app); this.folderKeystore = new FolderKeystore(app); }

  argonProbe(): Promise<boolean> { return argon2Available(); }

  /** Load the synced keyfile into the in-memory cache. Call on plugin load and
   *  before any operation that needs a fresh view of collaborators. */
  /** 0.294.0 (perf): `init()` no longer walks the vault for `.stashkey` files.
   *  It loads the (single-file) legacy keyfile and the parked-material flag —
   *  both cheap — and leaves the walk to `startStashKeyIndex()`, which main.ts
   *  fires at layout-ready (or during onload when a locked subtree is already
   *  registered, i.e. keys are about to be needed). Anything that must not act
   *  on a half-built index awaits `whenKeysReady()`. */
  async init(): Promise<void> {
    this.kf = await this.keyfiles.load();
    // Detect recoverable legacy key material ONCE on load (not in refresh — that's on
    // the folder-unlock hot path). retire()/wipe() keep the flag current in-session.
    this.parkedKeyMaterial = await this.detectParkedKeyMaterial();
  }
  async refresh(): Promise<void> {
    this.kf = await this.keyfiles.load();
    if (!this.stashKeysIndexed) await this.startStashKeyIndex();
  }

  /** 0.294.0 (perf): start (or join) the `.stashkey` walk. Idempotent — a second
   *  caller awaits the SAME in-flight walk rather than starting a duplicate one.
   *  Cleared by `invalidateStashKeyIndex()` so a later refresh re-walks. */
  startStashKeyIndex(): Promise<void> {
    if (this.stashKeysIndexed) return Promise.resolve();
    if (!this.indexPromise) {
      this.indexPromise = this.indexStashKeys().finally(() => { this.indexPromise = null; });
    }
    return this.indexPromise;
  }

  /** 0.294.0 (perf): resolves once the `.stashkey` index is COMPLETE. Callers that
   *  would otherwise mistake "not indexed yet" for "this folder has no key" — and
   *  so silently leave content unencrypted, or claim encryption isn't set up —
   *  must await this before reading `hasFolderKey` / `isConfigured`. Starts the
   *  walk if nobody has yet, so it can never wait forever. */
  async whenKeysReady(): Promise<void> {
    // A walk that was invalidated mid-flight publishes nothing, so one await is
    // not proof of completeness — re-walk (bounded, so a pathological
    // create/remove storm can't spin here forever).
    for (let i = 0; i < 4 && !this.stashKeysIndexed; i++) await this.startStashKeyIndex();
  }

  /** True when the `.stashkey` index is complete. A `false` from `hasFolderKey()`
   *  while this is false means "unknown", not "no key". */
  keysIndexed(): boolean { return this.stashKeysIndexed; }

  /** Cheap disk check: any recoverable legacy key material still on disk —
   *  `_keys/` backups (top-level or a prior remove-encryption `removed-*` dir) or a
   *  parked `.stashpad/retired-keyfile-*` dir. Two `adapter.list` calls. */
  private async detectParkedKeyMaterial(): Promise<boolean> {
    const a = this.app.vault.adapter;
    try {
      const l = await a.list("_keys");
      if ((l.files || []).some((f) => /\.json$/.test(f)) || (l.folders || []).length) return true;
    } catch { /* no _keys */ }
    try {
      const l = await a.list(".stashpad");
      if ((l.folders || []).some((f) => /\/retired-keyfile-/.test(f))) return true;
    } catch { /* no .stashpad */ }
    return false;
  }

  /** Force a re-scan of `.stashkey` files on the next refresh (after a folder key
   *  is created/removed, or on explicit reload). */
  invalidateStashKeyIndex(): void { this.stashKeysIndexed = false; this.indexEpoch++; }
  /** 0.294.0 (perf): bumped by every invalidation. A walk that finishes on a stale
   *  epoch publishes nothing and leaves the index dirty, so the next
   *  `startStashKeyIndex()` re-walks. Matters now that the walk is concurrent
   *  with the rest of startup: a `.stashkey` created (or removed) mid-walk used
   *  to be able to land in a result set that then marked itself authoritative. */
  private indexEpoch = 0;

  /** Phase 3 migration: relocate each legacy keyfile `folderKeys` entry's ACTIVE
   *  wrap into a per-folder `.stashkey`. Pure WRAP RELOCATION — the DEK is
   *  unchanged, no decryption, no content rewrite. ADDITIVE + reversible: the
   *  keyfile entry is left in place (dual-read then prefers the `.stashkey`), and
   *  a write that doesn't verify is rolled back. Idempotent (skips folders that
   *  already have a `.stashkey`). Returns the count migrated. */
  async migrateKeyfileToStashKeys(): Promise<number> {
    await this.refresh();
    const fks = this.kf?.folderKeys;
    if (!fks) return 0;
    let migrated = 0;
    for (const [path, entry] of Object.entries(fks)) {
      const f = this.cleanFolder(path);
      if (this.folderKeyFiles.has(f) || await this.folderKeystore.hasFile(f)) continue; // already migrated
      const active = (entry.passwordSlots ?? []).filter((s) => !s.label.startsWith("[deprecated]"));
      if (!active.length) continue; // no active wrap to carry over
      const sk: StashKey = {
        v: 1, keyId: entry.keyId, folderPath: f,
        slots: active.map((s, i) => ({ id: s.id, label: i === 0 ? "Folder password" : s.label, wrapped: s.wrapped, kdf: s.kdf, createdAt: s.createdAt })),
        createdAt: entry.createdAt,
      };
      try {
        await this.folderKeystore.write(f, sk);
        const back = await this.folderKeystore.read(f);
        // Verify the primary wrap round-tripped byte-for-byte before trusting it.
        if (!back || back.slots[0]?.wrapped !== sk.slots[0].wrapped) { await this.folderKeystore.remove(f); continue; }
        this.indexEpoch++;                             // 0.294.0 (perf): see setupFolderKey
        this.folderKeyFiles.set(f, sk); // keyfile entry LEFT IN PLACE (backup)
        migrated++;
      } catch { /* leave the keyfile entry as the working fallback */ }
    }
    return migrated;
  }

  /** Scan the vault for per-folder `.stashkey` files and cache them. Bounded walk
   *  (skips .git/.obsidian/node_modules). Once per session unless invalidated.
   *
   *  0.294.0 (perf): the traversal is unchanged in WHAT it covers — every
   *  directory except the three skipped ones is still listed, because
   *  `.stashkey` is a dotfile and Obsidian's in-memory vault tree does not index
   *  dotfiles, so there is no cheaper source of truth. Key discovery must stay
   *  COMPLETE: no folder with a `.stashkey` may be missed, so nothing new is
   *  pruned here.
   *
   *  What changed is the SHAPE: the old walk was a depth-first chain of
   *  sequential `await adapter.list()` calls — one full round trip per directory,
   *  strictly one at a time, which on a network share or mobile made this the
   *  single most expensive item at startup. It is now breadth-first with up to
   *  `LIST_CONCURRENCY` listings (and the `.stashkey` reads they trigger) in
   *  flight at once. Same set of directories, ~8x fewer round-trip stalls. */
  private static readonly LIST_CONCURRENCY = 8;

  private async indexStashKeys(): Promise<void> {
    const epoch = this.indexEpoch;
    const found = new Map<string, StashKey>();
    const SKIP = new Set([".git", ".obsidian", "node_modules"]);
    let frontier: string[] = [""];
    while (frontier.length) {
      const next: string[] = [];
      // Bounded-concurrency pass over the current depth: LIST_CONCURRENCY workers
      // pull from a shared cursor, so a slow directory doesn't idle the others.
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = cursor++;
          if (i >= frontier.length) return;
          const dir = frontier[i];
          let listing: { files: string[]; folders: string[] };
          try { listing = await this.app.vault.adapter.list(dir); } catch { continue; }
          for (const f of listing.files ?? []) {
            if (f === ".stashkey" || f.endsWith("/.stashkey")) {
              const folder = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
              const sk = await this.folderKeystore.read(folder);
              if (sk) found.set(this.cleanFolder(folder), sk);
            }
          }
          for (const sub of listing.folders ?? []) {
            if (SKIP.has(sub.split("/").pop() ?? "")) continue;
            next.push(sub);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(EncryptionService.LIST_CONCURRENCY, frontier.length) }, worker),
      );
      frontier = next;
    }
    // A `.stashkey` was created/removed while we walked — this result set may
    // have missed it. Publish nothing and stay dirty so the next caller re-walks.
    if (epoch !== this.indexEpoch) return;
    this.folderKeyFiles = found;
    this.stashKeysIndexed = true;
  }

  /** Present a `.stashkey` as a FolderKeyEntry so the existing unlock/session code
   *  works unchanged. Its slots (primary + optional recovery) map to active
   *  passwordSlots; there are no `[deprecated]` slots in the new model. */
  private stashKeyToEntry(sk: StashKey, folderPath: string): FolderKeyEntry {
    return {
      keyId: sk.keyId,
      folderPath: this.cleanFolder(folderPath),
      label: sk.slots[0]?.label ?? "Folder password",
      kcId: this.folderKcId(folderPath, sk.keyId),
      passwordSlots: sk.slots.map((s) => ({ id: s.id, label: s.label, wrapped: s.wrapped, kdf: s.kdf, createdAt: s.createdAt })),
      createdAt: sk.createdAt,
    };
  }

  // ---- keychain (per-device convenience copy of the unlock password) ----
  private secretStore(): SecretStore | null {
    return (this.app as App & { secretStorage?: SecretStore }).secretStorage ?? null;
  }
  keychainAvailable(): boolean { return !!this.secretStore(); }
  /** 0.135.1: NEVER overwrite a keychain entry — if `id` already holds a
   *  different secret, park the old value under `<id>-r<stamp>` first (Obsidian
   *  secret ids: /^[a-z0-9-]{1,64}$/, so the base is bounded to leave room).
   *  Universal retention at the write bottleneck — the change-password flows'
   *  `-d-<slotId>` parking still applies on top for nicer names. */
  private async parkThenSet(id: string, next: string): Promise<void> {
    const ss = this.secretStore();
    if (!ss) return;
    const touched: string[] = [id];
    try {
      const cur = ss.getSecret(id);
      if (cur && cur !== next) {
        const stamp = Date.now().toString(36); // ~8 lowercase alnum chars
        const parkId = `${id.slice(0, 64 - (stamp.length + 2))}-r${stamp}`;
        await ss.setSecret(parkId, cur);
        touched.push(parkId);
      }
    } catch { /* best-effort retention — never block the new write */ }
    await ss.setSecret(id, next);
    await this.recordKeychainIds(touched);
  }

  /** 0.136.0: remember every keychain id we write (secretStorage can't list),
   *  so unlock flows can cycle through all candidates. */
  private async recordKeychainIds(ids: string[]): Promise<void> {
    try {
      const cfg = this.load();
      const known = new Set(cfg.knownKeychainIds ?? []);
      let dirty = false;
      for (const id of ids) if (id && !known.has(id)) { known.add(id); dirty = true; }
      if (dirty) await this.save({ ...cfg, knownKeychainIds: [...known] });
    } catch { /* best-effort */ }
  }

  /** Every keychain candidate this device knows about — everything ever written
   *  (folder keys + parked `-r`/`-d` copies). Folder auto-unlock cycles these. */
  private keychainCandidateIds(): string[] {
    return [...new Set(this.load().knownKeychainIds ?? [])];
  }

  // ---- state ----
  /** True if THIS vault has a per-folder key anywhere — a `.stashkey` (new) or a
   *  legacy keyfile `folderKeys` entry (still read during the keyfile transition). */
  hasAnyFolderKey(): boolean {
    return this.folderKeyFiles.size > 0 || Object.keys(this.kf?.folderKeys ?? {}).length > 0;
  }
  /** Is ANY encryption active in this vault? (0.143.0: per-folder only — there is
   *  no vault-wide DEK, so this is just "any folder has a key".) */
  isConfigured(): boolean {
    return this.hasAnyFolderKey();
  }

  // ---- per-folder keys ------------------------------------------------------
  // Each encrypted folder owns a `.stashkey` (a DEK wrapped under the folder
  // password). A subfolder inherits its nearest keyed ancestor's key. A folder
  // with no keyed ancestor is NOT encrypted — there is no vault-wide fallback.

  /** The nearest ancestor folder (including the folder itself) that has its OWN
   *  key, or null. Implements the "subfolders inherit the parent's key" decision:
   *  a note in `Projects/Sub` is owned by `Projects` if only `Projects` has a key. */
  private owningFolder(folder: string): string | null {
    const fks = this.kf?.folderKeys;
    let p = this.cleanFolder(folder);
    while (p) {
      // Dual-read: a `.stashkey` (new) OR a keyfile entry (legacy) makes this the
      // owning folder. hasOwnProperty (not `fks[p]`) so a folder named
      // `constructor` doesn't hit Object.prototype. 0.140.13 / keyfile-removal.
      if (this.folderKeyFiles.has(p)) return p;
      if (fks && Object.prototype.hasOwnProperty.call(fks, p)) return p;
      const i = p.lastIndexOf("/");
      if (i < 0) break;
      p = p.slice(0, i);
    }
    return null;
  }
  /** True only if THIS exact folder has its own key (not inherited) — for settings
   *  UI decisions ("Set folder password" vs "Unlock/Change"). */
  hasOwnFolderKey(folder: string): boolean {
    const f = this.cleanFolder(folder);
    if (this.folderKeyFiles.has(f)) return true;
    const fks = this.kf?.folderKeys;
    return !!fks && Object.prototype.hasOwnProperty.call(fks, f);
  }
  /** The keyfile entry governing a folder — its own, or the nearest ancestor's
   *  (inheritance). Null → the folder uses the vault DEK. */
  folderKeyEntry(folder: string): FolderKeyEntry | null {
    const owner = this.owningFolder(folder);
    if (!owner) return null;
    const sk = this.folderKeyFiles.get(owner);
    if (sk) return this.stashKeyToEntry(sk, owner);       // .stashkey (new)
    return this.kf?.folderKeys?.[owner] ?? null;          // keyfile (legacy)
  }
  hasFolderKey(folder: string): boolean { return this.owningFolder(folder) !== null; }
  /** The folder path whose key has this keyId, or null — for resolving which key a
   *  trash blob was encrypted under (its sidecar stores the keyId). */
  folderPathByKeyId(keyId: string): string | null {
    for (const [path, sk] of this.folderKeyFiles) if (sk.keyId === keyId) return path; // .stashkey (new)
    for (const [path, e] of Object.entries(this.kf?.folderKeys ?? {})) if (e.keyId === keyId) return path; // keyfile (legacy)
    return null;
  }
  /** Active (non-deprecated) password slots for a folder, newest first. Deprecated
   *  slots are NEVER returned — an old/retired password must not unlock current
   *  content (matches the vault shared-password path). If there are somehow zero
   *  active slots, return none (don't silently fall back to deprecated ones). */
  private folderActiveSlots(entry: FolderKeyEntry): KeyfilePasswordSlot[] {
    // Defensive: a malformed/older synced entry may lack passwordSlots — treat as
    // no active slots instead of throwing TypeError out of unlockFolder. 0.140.13
    return (entry.passwordSlots ?? []).filter((s) => !s.label.startsWith("[deprecated]"));
  }
  /** Is the effective key for this folder available right now? (Session is keyed by
   *  the OWNING folder, so an inheriting subfolder reports the owner's state.) A
   *  folder with no key is not encrypted → false (nothing to unlock). */
  isFolderUnlocked(folder: string): boolean {
    const owner = this.owningFolder(folder);
    return owner ? this.folderSessionKeys.has(owner) : false;
  }
  /** The DEK to use for `folder`: the unlocked owning-folder key. Returns a COPY
   *  (caller may zero), or null if the folder has no key or it isn't unlocked.
   *  (0.143.0: no vault-wide fallback — an unkeyed folder returns null.) */
  getFolderKey(folder: string): Uint8Array | null {
    const owner = this.owningFolder(folder);
    if (!owner) return null;
    const k = this.folderSessionKeys.get(owner);
    if (!k) return null;
    return k.slice();
  }

  /** Give `folder` its OWN key for the first time: mint a DEK, wrap under
   *  `password`, write a FolderKeyEntry, unlock it in memory. `label` is built by
   *  the caller (it owns author info): "YYYY-MM-DD HH:mm – folder – author|id". */
  async setupFolderKey(folder: string, password: string, label: string, remember = false): Promise<void> {
    if (!password) throw new Error("Password required.");
    await this.refresh();
    // 0.142.3: a folder key stands alone — no vault-wide encryption required. The
    // `.stashkey` is self-contained (mint DEK → wrap under the folder password →
    // write into the folder), so this can be the FIRST encryption in the vault.
    const f = this.cleanFolder(folder);
    if (this.hasOwnFolderKey(f)) throw new Error("This folder already has its own key.");
    // Inheritance: a subfolder of an already-keyed folder uses the ancestor's key —
    // don't let it mint a separate (nested) key.
    const ancestor = this.owningFolder(f);
    if (ancestor && ancestor !== f) throw new Error(`A parent folder (“${ancestor.split("/").pop()}”) already has its own password; this folder inherits it.`);
    // keyfile-removal: new folder keys are written as a per-folder `.stashkey`,
    // NOT into the central keyfile. `label` is retained for the caller's contract
    // but the on-disk key file is minimal. (dek is cached; the copy here is owned
    // by the session map.)
    void label;
    const { sk, dek } = await this.folderKeystore.create(f, password);
    await this.folderKeystore.write(f, sk);
    // 0.294.0 (perf): membership change — invalidate any walk in flight so its
    // (older) result set can't overwrite this brand-new key. See indexEpoch.
    this.indexEpoch++;
    this.folderKeyFiles.set(f, sk);
    this.folderSessionKeys.set(f, dek);
    if (remember) await this.rememberFolder(this.folderKcId(f, sk.keyId), password);
  }

  /** Unlock a folder's own key with `password`. False on wrong password / no entry. */
  async unlockFolder(folder: string, password: string, remember = false): Promise<boolean> {
    await this.refresh();
    const f = this.cleanFolder(folder);
    const entry = this.folderKeyEntry(f);
    if (!entry) return false;
    for (const slot of this.folderActiveSlots(entry)) {
      try {
        const dek = await decryptStash(fromB64(slot.wrapped), password);
        // 0.211.8: reject a wrong-length unwrap rather than caching garbage as an AES
        // key. FolderKeystore.unlock has carried this guard since it was written, but
        // nothing calls it — THIS is the live unlock path, and it had none. A corrupt
        // or tampered `.stashkey` slot that happens to authenticate to the wrong number
        // of bytes would otherwise be installed as the session key, and every
        // subsequent encrypt in that folder would use it.
        if (dek.length !== DEK_LEN) { dek.fill(0); continue; }
        this.folderSessionKeys.set(entry.folderPath, dek); // key the session by the OWNING folder
        const kcId = this.folderKcIdFor(entry);
        if (remember || this.isFolderRemembered(kcId)) await this.rememberFolder(kcId, password);
        return true;
      } catch { /* try next slot */ }
    }
    return false;
  }

  /** Try the folder password saved in this device's keychain (no prompt). */
  async tryAutoUnlockFolder(folder: string): Promise<boolean> {
    const entry = this.folderKeyEntry(folder);
    if (!entry || this.isFolderUnlocked(folder)) return this.isFolderUnlocked(folder);
    const kcId = this.folderKcIdFor(entry);
    // Primary id first, then (0.136.0) cycle every other known candidate —
    // parked copies included. A hit from a non-primary id is promoted.
    const pw = this.rememberedFolderPassword(kcId);
    if (pw && await this.unlockFolder(folder, pw)) return true;
    const ss = this.secretStore();
    if (!ss) return false;
    const tried = new Set<string>(pw ? [pw] : []);
    for (const id of this.keychainCandidateIds()) {
      if (id === kcId) continue;
      let cand: string | null = null;
      try { cand = ss.getSecret(id) ?? null; } catch { cand = null; }
      if (!cand || tried.has(cand)) continue;
      tried.add(cand);
      if (await this.unlockFolder(folder, cand)) {
        await this.rememberFolder(kcId, cand); // promote (parks any stale value)
        return true;
      }
    }
    return false;
  }

  /** Cheap "Change password" for a folder: re-wrap the SAME DEK under a new
   *  passphrase (requires the folder unlocked). NOTHING is deleted — the old
   *  active slot is RETAINED and relabeled `[deprecated] …` (so it's an audit /
   *  recovery record), and the old keychain password is parked under a
   *  `-d-<slotId>` id rather than overwritten. The new slot becomes the only
   *  ACTIVE one, so the old password no longer unlocks via the normal path
   *  (`folderActiveSlots` skips deprecated). For true cryptographic invalidation
   *  (re-encrypt under a fresh DEK), remove encryption and re-encrypt. */
  async changeFolderPassword(folder: string, newPassword: string, remember = false): Promise<void> {
    if (!newPassword) throw new Error("Password required.");
    const f = this.cleanFolder(folder);
    await this.refresh();
    const entry = this.folderKeyEntry(f);
    // 0.142.3: a `.stashkey` folder re-wraps standalone (no vault kf needed). The
    // legacy-keyfile branch below still guards on `this.kf`.
    if (!entry) throw new Error("This folder has no key.");
    const owner = entry.folderPath; // inheritance: operate on the key-owning folder
    const dek = this.folderSessionKeys.get(owner);
    if (!dek) throw new Error("Unlock this folder first.");
    // keyfile-removal: a `.stashkey`-backed folder re-wraps the primary slot in
    // place (recovery slot preserved) — no deprecated-slot retention, no keyfile.
    const skNow = this.folderKeyFiles.get(owner);
    if (skNow) {
      const next = await this.folderKeystore.changePassword(skNow, dek, newPassword);
      await this.folderKeystore.write(owner, next);
      this.folderKeyFiles.set(owner, next);
      const kcId2 = this.folderKcId(owner, next.keyId);
      if (remember || this.isFolderRemembered(kcId2)) await this.rememberFolder(kcId2, newPassword);
      return;
    }
    if (!this.kf) throw new Error("This folder has no key.");
    // Retain the OLD keychain password under a deprecated id (never delete) so an
    // old export emailed months ago can still be looked up / decrypted.
    const prevActive = entry.passwordSlots.filter((s) => !s.label.startsWith("[deprecated]"));
    const kcId = this.folderKcIdFor(entry);
    const oldPw = this.rememberedFolderPassword(kcId);
    if (oldPw && prevActive[0]) {
      try { await this.parkThenSet(`${kcId}-d-${prevActive[0].id}`, oldPw); } catch { /* best-effort retention */ }
    }
    const wrapped = await encryptStash(dek, newPassword);
    // Relabel every prior slot as [deprecated] (retained), prepend the new active one.
    const retained = entry.passwordSlots.map((s) => s.label.startsWith("[deprecated]") ? s : { ...s, label: `[deprecated] ${s.label}` });
    const next: FolderKeyEntry = {
      ...entry,
      kcId: entry.kcId ?? this.folderKcId(entry.label, entry.keyId), // backfill kcId for legacy entries
      passwordSlots: [
        { id: newId(8), label: "Folder password", wrapped: toB64(wrapped.data), kdf: wrapped.kdf, createdAt: new Date().toISOString() },
        ...retained,
      ],
    };
    this.kf.folderKeys = { ...(this.kf.folderKeys ?? {}), [owner]: next };
    await this.keyfiles.save(this.kf);
    if (remember || this.isFolderRemembered(kcId)) await this.rememberFolder(this.folderKcIdFor(next), newPassword);
  }


  // (keyfile-removal Phase 4 / 0.142.0: commitFolderRotation removed — DEK rotation
  // is gone. Password change = re-wrap in place (changeFolderPassword above); a
  // leaked key is handled by remove-encryption + re-encrypt. Plan decision #6.)

  // ---- per-folder RECOVERY password (0.142.1) --------------------------------
  // An OPTIONAL second slot in `.stashkey` that wraps the SAME DEK under a
  // separate "recovery" password (plan decision #2). Either password unlocks the
  // folder (unlockFolder tries every slot). Recovery is a `.stashkey`-only feature
  // — a folder still on the legacy central keyfile must be migrated first (which
  // happens automatically on load), so these require an own `.stashkey`.

  /** True if the owning folder's `.stashkey` carries a recovery slot. */
  folderHasRecovery(folder: string): boolean {
    const owner = this.owningFolder(folder);
    const sk = owner ? this.folderKeyFiles.get(owner) : null;
    return !!sk && this.folderKeystore.hasRecovery(sk);
  }

  /** Set (or replace) the folder's recovery password. Requires the folder unlocked
   *  (we wrap the live DEK under the recovery password). Re-wraps only the recovery
   *  slot; the primary password is untouched. */
  async setFolderRecoveryPassword(folder: string, recoveryPassword: string): Promise<void> {
    if (!recoveryPassword) throw new Error("Recovery password required.");
    await this.refresh();
    const f = this.cleanFolder(folder);
    const entry = this.folderKeyEntry(f);
    if (!entry) throw new Error("This folder has no key.");
    const owner = entry.folderPath;
    const sk = this.folderKeyFiles.get(owner);
    if (!sk) throw new Error("This folder's key predates recovery passwords — change its folder password once to upgrade it, then try again.");
    const dek = this.folderSessionKeys.get(owner);
    if (!dek) throw new Error("Unlock this folder first.");
    const next = await this.folderKeystore.setRecovery(sk, dek, recoveryPassword);
    await this.folderKeystore.write(owner, next);
    this.folderKeyFiles.set(owner, next);
  }

  /** Drop the folder's recovery slot (keeps only the primary password). No unlock
   *  needed — it only removes a slot, doesn't re-wrap the DEK. */
  async removeFolderRecoveryPassword(folder: string): Promise<void> {
    await this.refresh();
    const f = this.cleanFolder(folder);
    const entry = this.folderKeyEntry(f);
    if (!entry) return;
    const owner = entry.folderPath;
    const sk = this.folderKeyFiles.get(owner);
    if (!sk || !this.folderKeystore.hasRecovery(sk)) return;
    const next = this.folderKeystore.removeRecovery(sk);
    await this.folderKeystore.write(owner, next);
    this.folderKeyFiles.set(owner, next);
  }

  // --- per-folder keychain helpers (one slot PER folder key — no clobbering) ---
  /** Build a recognizable, VALID secret id from a folder key's label
   *  ("20260620-1430 - Beta - SC" → "sp-20260620-1430-beta-sc-ab12cd").
   *  Lowercased, dashes only, bounded so the `-d-<slotId>` deprecated variant stays
   *  ≤64. A short keyId suffix keeps it unique + stable for lookup. */
  private folderKcId(label: string, keyId: string): string {
    const base = (label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (`sp-${base}`.slice(0, 44) + `-${keyId.slice(0, 6)}`).replace(/-+/g, "-");
  }
  /** The keychain id for an entry: its stored kcId, or a legacy keyId-based id for
   *  entries created before kcId existed (so existing remembered passwords resolve). */
  private folderKcIdFor(entry: FolderKeyEntry): string {
    return entry.kcId || `${LEGACY_KEYCHAIN_ID}-f-${entry.keyId}`;
  }
  private isFolderRemembered(kcId: string): boolean {
    try { return !!this.secretStore()?.getSecret(kcId); } catch { return false; }
  }
  private rememberedFolderPassword(kcId: string): string | null {
    try { return this.secretStore()?.getSecret(kcId) || null; } catch { return null; }
  }
  private async rememberFolder(kcId: string, password: string): Promise<void> {
    try { await this.parkThenSet(kcId, password); }
    catch (e) { console.warn("[Stashpad] couldn't save folder password to keychain", e); }
  }
  async forgetFolderKeychain(folder: string): Promise<void> {
    const entry = this.folderKeyEntry(folder);
    if (!entry) return;
    const ss = this.secretStore();
    if (!ss) return;
    const id = this.folderKcIdFor(entry);
    // 0.135.1: park before forgetting (no-delete policy), same as forgetKeychain.
    try { const cur = ss.getSecret(id); if (cur) { await this.parkThenSet(id, ""); return; } } catch { /* fall through */ }
    try { if (ss.removeSecret) await ss.removeSecret(id); else await ss.setSecret(id, ""); }
    catch (e) { console.warn("[Stashpad] couldn't clear folder keychain", e); }
  }

  // (0.143.0: the vault-wide encryption surface — setup/unlock/changePassword/
  // verifyPassword/setSharedPassword/device identities/getSessionKey — is removed.
  // Encryption is strictly per-folder; all key ops live in the per-folder methods
  // above. `changeFolderPassword` handles password changes.)

  // ---- lifecycle ----
  /** Zero + drop every unlocked per-folder DEK (the explicit Lock command / unload). */
  lock(): void {
    for (const k of this.folderSessionKeys.values()) k.fill(0);
    this.folderSessionKeys.clear();
  }

  /** Lock a SINGLE folder's key (leave the vault key + other folders unlocked).
   *  Resolves to the OWNING folder so locking an inheriting subfolder drops the
   *  shared key. */
  lockFolder(folder: string): void {
    const owner = this.owningFolder(folder) ?? this.cleanFolder(folder);
    const k = this.folderSessionKeys.get(owner);
    if (k) { k.fill(0); this.folderSessionKeys.delete(owner); }
  }

  private cleanFolder(p: string): string { return (p || "").replace(/\/+$/, ""); }

  /** Remove ALL encryption from the vault (caller gates on "content already
   *  decrypted"): drop every unlocked key from memory and delete every folder's
   *  `.stashkey`. Any legacy central keyfile + `_keys/` backups are PARKED (not
   *  hard-deleted) into `_keys/removed-<stamp>/` so old wrapped keys stay
   *  recoverable by hand. (0.143.0: no vault DEK/keychain to wipe.) */
  async clear(): Promise<void> {
    this.lock();
    try {
      const a = this.app.vault.adapter;
      for (const p of [".stashpad/keys.json"]) { try { if (await a.exists(p)) await a.remove(p); } catch { /* */ } }
      try {
        const list = await a.list("_keys");
        const backups = (list.files || []).filter((f) => /\/keys-\d+\.json$/.test(f));
        if (backups.length) {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const parkDir = `_keys/removed-${stamp}`;
          try { if (!(await a.exists(parkDir))) await a.mkdir(parkDir); } catch { /* race */ }
          for (const f of backups) {
            const name = f.split("/").pop()!;
            try { await a.write(`${parkDir}/${name}`, await a.read(f)); await a.remove(f); }
            catch { /* keep the original rather than risk losing it */ }
          }
        }
      } catch { /* */ }
      // Remove every per-folder `.stashkey` (meaningless once content is decrypted).
      await this.whenKeysReady();
      for (const folder of this.folderKeyFiles.keys()) { try { await this.folderKeystore.remove(folder); } catch { /* best-effort */ } }
      this.indexEpoch++;                               // 0.294.0 (perf): see setupFolderKey
      this.folderKeyFiles.clear();
    } catch { /* best-effort */ }
    this.kf = null;
  }

  /** Remove a SINGLE folder's `.stashkey` (called when that folder's encryption is
   *  removed and its content decrypted). Zeros + drops the session key too. */
  async removeFolderKeyFile(folder: string): Promise<void> {
    const f = this.cleanFolder(folder);
    await this.folderKeystore.remove(f);
    this.indexEpoch++;                                 // 0.294.0 (perf): see setupFolderKey
    this.folderKeyFiles.delete(f);
    this.folderSessionKeys.get(f)?.fill(0);
    this.folderSessionKeys.delete(f);
  }

  // ---- Phase 5: retire the legacy central keyfile (manual, reversible) --------

  /** True if a legacy central keyfile was loaded this session (its `folderKeys`
   *  are still consulted as a dual-read fallback). Sync — reads the cached kf. */
  hasLegacyKeyfile(): boolean { return !!this.kf; }

  /** Folder paths whose key STILL lives ONLY in the legacy keyfile (no `.stashkey`
   *  yet) — retiring the keyfile would orphan these. Empty ⇒ safe to retire.
   *  (migrateKeyfileToStashKeys runs on load, so this is normally empty.) */
  unmigratedKeyfileFolders(): string[] {
    return Object.keys(this.kf?.folderKeys ?? {}).filter((p) => !this.folderKeyFiles.has(this.cleanFolder(p)));
  }

  /** PARK the legacy central keyfile: move `.stashpad/keys.json` + the `_keys/`
   *  top-level backups into `.stashpad/retired-keyfile-<stamp>/` (nothing deleted —
   *  reversible by moving them back). REFUSES if any `folderKeys` entry still lacks
   *  a `.stashkey` (that folder would be orphaned). Returns the count of files
   *  parked. After this, key resolution is purely per-folder `.stashkey`. */
  async retireLegacyKeyfile(): Promise<number> {
    await this.refresh();
    const unmigrated = this.unmigratedKeyfileFolders();
    if (unmigrated.length) {
      throw new Error(`Can't retire the old keyfile yet — these folders' keys still live only in it: ${unmigrated.map((f) => f || "(vault root)").join(", ")}. Open each folder once (or change its password) to migrate it, then try again.`);
    }
    const a = this.app.vault.adapter;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const parkDir = `.stashpad/retired-keyfile-${stamp}`;
    let parked = 0;
    try { if (!(await a.exists(parkDir))) await a.mkdir(parkDir); } catch { /* race */ }
    // Park each file with a READ-BACK VERIFY before removing the original — matches
    // migrateKeyfileToStashKeys()'s byte-compare discipline, so a silently-truncated
    // write can never delete the source and leave a corrupt backup. (These are just
    // backups — real keys live in per-folder `.stashkey` — but don't risk it.)
    const parkVerified = async (src: string, dst: string): Promise<boolean> => {
      try {
        const body = await a.read(src);
        await a.write(dst, body);
        if ((await a.read(dst)) !== body) return false; // truncated/failed write → keep original
        await a.remove(src);
        return true;
      } catch { return false; } // leave the original in place on any error
    };
    try { if (await a.exists(".stashpad/keys.json") && await parkVerified(".stashpad/keys.json", `${parkDir}/keys.json`)) parked++; } catch { /* */ }
    try {
      const list = await a.list("_keys");
      for (const f of (list.files || []).filter((x) => /\/keys-\d+\.json$/.test(x))) {
        if (await parkVerified(f, `${parkDir}/${f.split("/").pop()!}`)) parked++;
      }
    } catch { /* no _keys */ }
    this.kf = null; // stop consulting the (now-parked) keyfile
    // The parked copies ARE recoverable material — keep the hard-wipe reachable.
    this.parkedKeyMaterial = true;
    return parked;
  }

  /** True if any recoverable legacy key material is still on disk — a live keyfile /
   *  `_keys/` backup, or a parked `retired-keyfile-*` dir from a prior retire. Sync
   *  (cached); drives the settings hard-wipe affordance. (0.144.1) */
  hasRecoverableKeyMaterial(): boolean { return !!this.kf || this.parkedKeyMaterial; }

  /** HARD-WIPE all legacy key material — no backup, not reversible. Removes the live
   *  `.stashpad/keys.json`, the whole `_keys/` dir, and every parked
   *  `.stashpad/retired-keyfile-*` dir. For users who want a clean removal rather
   *  than the reversible park. (Per-folder `.stashkey` files and folder-password
   *  keychain entries are NOT touched — those govern live per-folder encryption; use
   *  "Remove all encryption" for those.) Caller MUST hard-confirm first. Returns the
   *  number of paths removed. (0.144.1) */
  async wipeLegacyKeyMaterial(): Promise<number> {
    // REFUSE on unmigrated folders, exactly as retireLegacyKeyfile() does (0.211.3).
    // The reversible park had this guard and the IRREVERSIBLE wipe did not, which is
    // backwards: if a folder's key still lives only in the keyfile, parking it can be
    // undone by moving the files back, whereas wiping destroys the only copy of that
    // key and the folder's encrypted notes become permanently unreadable. refresh()
    // first so the check runs against what is on disk, not a stale cache.
    await this.refresh();
    const unmigrated = this.unmigratedKeyfileFolders();
    if (unmigrated.length) {
      throw new Error(`Can't wipe the old key material — these folders' keys still live ONLY in it, and wiping cannot be undone: ${unmigrated.map((f) => f || "(vault root)").join(", ")}. Open each folder once (or change its password) to migrate it to a per-folder key, then try again.`);
    }
    const a = this.app.vault.adapter;
    let removed = 0;
    const rm = async (p: string, dir: boolean): Promise<void> => {
      try { if (await a.exists(p)) { if (dir) await a.rmdir(p, true); else await a.remove(p); removed++; } }
      catch { /* best-effort; leave what won't delete */ }
    };
    await rm(".stashpad/keys.json", false);
    await rm("_keys", true);
    try {
      const l = await a.list(".stashpad");
      for (const d of (l.folders || [])) if (/\/retired-keyfile-/.test(d)) await rm(d, true);
    } catch { /* no .stashpad */ }
    this.kf = null;
    this.parkedKeyMaterial = false;
    return removed;
  }

  dispose(): void { this.lock(); }
}
