import type { App } from "obsidian";
import { encryptStash, decryptStash, argon2Available, type StashKdf } from "./stash-crypto";
import { newId } from "./id-service";
import { generateIdentityKeys, wrapDekTo, unwrapDekWith } from "./vault-keyring";
import { KeyfileStore, emptyKeyfile, type VaultKeyfile, type KeyfileIdentity, type KeyfileJoinRequest, type FolderKeyEntry, type KeyfilePasswordSlot } from "./vault-keyfile";

/** Legacy global keychain id (pre-0.99.24). Namespaced per-vault now — see
 *  `keychainId()`; kept for a one-time migration read. */
const LEGACY_KEYCHAIN_ID = "stashpad-vault-encryption";

interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void | Promise<void>;
  removeSecret?(id: string): void | Promise<void>;
}

/** Vault encryption — key management for one shared vault DEK.
 *
 *  v1 (0.97.x) wrapped a per-device random DEK under the vault password and kept
 *  it in per-device settings. That made COLLABORATION impossible: two people on
 *  one synced vault minted two unrelated DEKs (the coworker's "two keys" bug).
 *
 *  v2 (this version) distributes ONE vault DEK by PUBLIC KEY (see
 *  docs/branches/encryption-collab.md):
 *   - Each device has an ECDH identity keypair. The private key is wrapped under
 *     the user's password and stored per-device; the public key is published in a
 *     SYNCED keyfile (`.stashpad/keys.json` + `_keys/` backups).
 *   - The DEK is wrapped TO each authorized public key (one `slot` per member).
 *     A member unlocks by unwrapping their private key (password) → unwrapping the
 *     DEK from their slot.
 *   - Adding a member needs only their PUBLIC key, so no shared password is ever
 *     exchanged. Removing a member drops their slot (NOT true revocation without
 *     a DEK rotation — a follow-up).
 *
 *  The unwrapped DEK lives only in memory (`sessionKey`), dropped on lock() /
 *  idle / restart. `.stashenc` blobs are unchanged (single DEK, no key-id). */

/** Persisted PER-DEVICE state (plugin settings). The vault-wide key material lives
 *  in the synced keyfile, NOT here. */
export interface EncryptionConfig {
  /** LEGACY v1: base64 of `encryptStash(dek, password)`. Read for migration only;
   *  no longer written once a keyfile exists. */
  wrappedKey: string | null;
  kdf: StashKdf | null;
  /** This device's identity id (matches a keyfile identity / slot recipientId). */
  identityId: string | null;
  /** Human label for this device's identity (shown to collaborators). */
  identityLabel: string | null;
  /** base64 SPKI public key (also published in the keyfile; cached here). */
  identityPub: string | null;
  /** base64 of `encryptStash(pkcs8PrivateKey, password)` — the password-protected
   *  private key, the only secret stored on this device. */
  identityPrivWrapped: string | null;
  identityPrivKdf: StashKdf | null;
  /** 0.136.0: every keychain id this device has ever written (primary, parked
   *  `-r<stamp>`, `-d-<slotId>`, folder keys). Obsidian's secretStorage has NO
   *  list API, so without this registry parked entries are unreachable — with
   *  it, unlock flows can cycle through every known candidate before ever
   *  prompting. */
  knownKeychainIds?: string[];
  /** 0.140.1: the user chose "Forget on this device" — suppress auto-unlock
   *  entirely (the cycle-unlock would otherwise resurrect a PARKED password and
   *  silently undo the forget). Cleared the next time a password is explicitly
   *  remembered. */
  keychainForgotten?: boolean;
}

export function defaultEncryptionConfig(): EncryptionConfig {
  return {
    wrappedKey: null, kdf: null,
    identityId: null, identityLabel: null, identityPub: null,
    identityPrivWrapped: null, identityPrivKdf: null,
  };
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

const DEK_LEN = 32; // 256-bit vault key

/** This device's relationship to the vault's encryption. */
export type AccessState = "none" | "member" | "pending" | "outsider";

export class EncryptionService {
  private sessionKey: Uint8Array | null = null;
  /** Per-folder overhaul (Phase A): unlocked per-folder DEKs, keyed by cleaned
   *  folder path. Overlay on the vault DEK — a folder with no entry here uses the
   *  vault `sessionKey`. Zeroed on lock()/idle alongside the vault key. */
  private folderSessionKeys = new Map<string, Uint8Array>();
  private keyfiles: KeyfileStore;
  /** In-memory cache of the synced keyfile (refreshed via init()/refresh()). */
  private kf: VaultKeyfile | null = null;

  // (0.135.0: the idle auto-lock timer is gone — armIdle/clearIdle/idleMinutes
  // removed. The session key lives until Obsidian closes or encryption is
  // removed/re-passworded.)
  constructor(
    private app: App,
    private load: () => EncryptionConfig,
    private save: (cfg: EncryptionConfig) => Promise<void>,
  ) { this.keyfiles = new KeyfileStore(app); }

  argonProbe(): Promise<boolean> { return argon2Available(); }

  /** Load the synced keyfile into the in-memory cache. Call on plugin load and
   *  before any operation that needs a fresh view of collaborators. */
  async init(): Promise<void> { await this.refresh(); }
  async refresh(): Promise<void> { this.kf = await this.keyfiles.load(); }

  // ---- keychain (per-device convenience copy of the unlock password) ----
  private secretStore(): SecretStore | null {
    return (this.app as App & { secretStorage?: SecretStore }).secretStorage ?? null;
  }
  keychainAvailable(): boolean { return !!this.secretStore(); }
  /** Obsidian secret IDs must match /^[a-z0-9-]{1,64}$/. appId is normally a
   *  lowercase hex string, but sanitize + bound it so we never feed an invalid id
   *  to secretStorage. */
  private appTag(): string {
    const appId = (this.app as App & { appId?: string }).appId || "default";
    return appId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "default";
  }
  private keychainId(): string {
    return `${LEGACY_KEYCHAIN_ID}-${this.appTag()}`; // ≤ 25+1+20 = 46
  }
  /** Pre-0.114.7 vault id: full (unsanitized, unbounded) appId. Read as a fallback so
   *  a vault password remembered before appTag() sanitization still auto-unlocks. */
  private legacyAppIdKeychainId(): string {
    const appId = (this.app as App & { appId?: string }).appId || "default";
    return `${LEGACY_KEYCHAIN_ID}-${appId}`;
  }
  isRemembered(): boolean {
    try { const ss = this.secretStore(); return !!(ss?.getSecret(this.keychainId()) || ss?.getSecret(this.legacyAppIdKeychainId())); } catch { return false; }
  }
  /** The password saved in this device's keychain, or null. Lets flows that
   *  need the password (e.g. Remove encryption) pull it automatically instead
   *  of forcing the user to retype it. Falls back to the legacy entry. */
  rememberedPassword(): string | null {
    const ss = this.secretStore();
    if (!ss) return null;
    try { const v = ss.getSecret(this.keychainId()); if (v) return v; } catch { /* fall through */ }
    try { const v = ss.getSecret(this.legacyAppIdKeychainId()); if (v) return v; } catch { /* fall through */ }
    try { return ss.getSecret(LEGACY_KEYCHAIN_ID) || null; } catch { return null; }
  }
  /** True if the keychain holds a password that actually verifies against the
   *  current key — so a flow can treat "keychain present" as proof of access
   *  without prompting. */
  async verifyWithKeychain(): Promise<boolean> {
    const pw = this.rememberedPassword();
    if (!pw) return false;
    try { return await this.verifyPassword(pw); } catch { return false; }
  }
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

  /** Every keychain candidate this device knows about: current + legacy ids +
   *  everything ever written (parked, deprecated-slot, folder keys). */
  private keychainCandidateIds(): string[] {
    const ids = [this.keychainId(), this.legacyAppIdKeychainId(), LEGACY_KEYCHAIN_ID, ...(this.load().knownKeychainIds ?? [])];
    return [...new Set(ids)];
  }
  private async remember(password: string): Promise<void> {
    try { await this.parkThenSet(this.keychainId(), password); }
    catch (e) { console.warn("[Stashpad] couldn't save password to keychain", e); }
    // 0.140.1: an explicit remember re-arms auto-unlock (clears a prior forget).
    try { const cfg = this.load(); if (cfg.keychainForgotten) await this.save({ ...cfg, keychainForgotten: false }); } catch { /* best-effort */ }
  }
  async forgetKeychain(): Promise<void> {
    // 0.140.1: mark forgotten so tryAutoUnlock won't resurrect a parked password
    // — this is the whole point of "Forget on this device".
    try { await this.save({ ...this.load(), keychainForgotten: true }); } catch { /* best-effort */ }
    const ss = this.secretStore();
    if (!ss) return;
    // 0.135.1: park the current value first (no-delete policy) — forgetting
    // drops the ACTIVE entry but the old password stays recoverable.
    try { const cur = ss.getSecret(this.keychainId()); if (cur) await this.parkThenSet(this.keychainId(), ""); return; } catch { /* fall through */ }
    try { if (ss.removeSecret) await ss.removeSecret(this.keychainId()); else await ss.setSecret(this.keychainId(), ""); }
    catch (e) { console.warn("[Stashpad] couldn't clear keychain", e); }
  }
  /** 0.136.0: cycle EVERY known keychain candidate (current id, legacy ids,
   *  parked `-r`/`-d` copies, even folder-key values) before giving up — one
   *  stale primary entry no longer means a prompt (or a scare) when a working
   *  password is sitting one id over. On a hit from a non-primary id, the
   *  winning password is promoted to the primary id (old value parks). */
  async tryAutoUnlock(): Promise<boolean> {
    if (!this.isConfigured() || this.isUnlocked()) return this.isUnlocked();
    // 0.140.1: honor an explicit "Forget on this device" — don't cycle parked
    // passwords back into an unlock.
    if (this.load().keychainForgotten) return false;
    // Can't auto-unlock unless this device can unlock at all: a member (its own
    // slot) or any device when a shared password is enabled.
    if (this.accessState() !== "member" && !this.hasSharedPassword()) return false;
    const ss = this.secretStore();
    if (!ss) return false;
    const primary = this.keychainId();
    const tried = new Set<string>();
    for (const id of this.keychainCandidateIds()) {
      let pw: string | null = null;
      try { pw = ss.getSecret(id) ?? null; } catch { pw = null; }
      if (!pw || tried.has(pw)) continue;
      tried.add(pw);
      // verify first (cheap KDF check) so a wrong candidate doesn't spam
      // failed-unlock side effects.
      let ok = false;
      try { ok = await this.verifyPassword(pw); } catch { ok = false; }
      if (!ok) continue;
      if (!(await this.unlock(pw))) continue;
      if (id !== primary) await this.remember(pw); // promote (parks the stale primary)
      return true;
    }
    return false;
  }

  // ---- state ----
  /** Is encryption set up in this VAULT (by anyone)? */
  isConfigured(): boolean {
    return !!this.kf || !!this.load().wrappedKey;
  }
  isUnlocked(): boolean { return this.sessionKey !== null; }
  kdf(): StashKdf | null { return this.load().identityPrivKdf ?? this.load().kdf; }

  private hasIdentity(): boolean { return !!this.load().identityPrivWrapped && !!this.load().identityId; }
  private mySlot() {
    const id = this.load().identityId;
    return id ? (this.kf?.slots.find((s) => s.recipientId === id) ?? null) : null;
  }
  /** This device's relationship to the vault encryption. */
  accessState(): AccessState {
    const cfg = this.load();
    // Legacy single-device (v1) with no keyfile yet → treat as member (migrates on unlock).
    if (!this.kf && cfg.wrappedKey) return "member";
    if (!this.kf) return "none";
    if (this.hasIdentity() && this.mySlot()) return "member";
    if (cfg.identityId && this.kf.joinRequests.some((r) => r.id === cfg.identityId)) return "pending";
    return "outsider";
  }
  amIMember(): boolean { return this.accessState() === "member"; }

  // ---- setup / unlock / migration ----
  /** First-time setup for a brand-new vault (state "none"): mint the vault DEK,
   *  create this device's identity, write the keyfile with one slot. */
  async setup(password: string, remember = false, label?: string): Promise<void> {
    await this.refresh();
    if (this.isConfigured()) throw new Error("Encryption is already set up in this vault.");
    if (!password) throw new Error("Password required.");
    const dek = crypto.getRandomValues(new Uint8Array(DEK_LEN));
    const id = await this.mintIdentity(password, label);
    const kf = emptyKeyfile(newId(8));
    kf.identities.push(this.identityRecord(id));
    kf.slots.push(await wrapDekTo(dek, fromB64(id.pub), id.id));
    await this.keyfiles.save(kf);
    this.kf = kf;
    this.sessionKey = dek;
    // Only WRITE on explicit remember — never auto-forget. Wiping is reserved for the
    // explicit "Forget on this device" button and remove-encryption, so a password the
    // user asked us to keep can't be silently zeroed by going through a later flow.
    if (remember) await this.remember(password);
  }

  /** Unlock the session DEK with this device's password. Returns false on wrong
   *  password. For a v1 vault with no keyfile, migrates to the keyring on the way. */
  async unlock(password: string, remember = false): Promise<boolean> {
    await this.refresh();
    const cfg = this.load();
    // v1 → v2 migration: legacy wrapped DEK, no keyfile yet.
    if (!this.kf && cfg.wrappedKey) {
      let dek: Uint8Array;
      try { dek = await decryptStash(fromB64(cfg.wrappedKey), password); } catch { return false; }
      const id = await this.mintIdentity(password, cfg.identityLabel ?? undefined);
      const kf = emptyKeyfile(newId(8));
      kf.identities.push(this.identityRecord(id));
      kf.slots.push(await wrapDekTo(dek, fromB64(id.pub), id.id));
      await this.keyfiles.save(kf);
      this.kf = kf;
      this.sessionKey = dek;
      // Only ADD to the keychain on explicit remember — never forget here. (An
      // auto-unlock calls unlock() with remember=false; force-forgetting would
      // wipe the very password it just used to unlock.)
      if (remember) await this.remember(password);
      return true;
    }
    // Member (device-approval) path — unwrap my private key, then the DEK from my
    // slot. On any failure, fall through to the shared-password path (the typed
    // password might be the shared one, not this device's).
    const slot = this.hasIdentity() ? this.mySlot() : null;
    if (slot) {
      try {
        const priv = await decryptStash(fromB64(cfg.identityPrivWrapped!), password);
        try {
          const dek = await unwrapDekWith(slot, priv);
          priv.fill(0);
          // 0.140.2: a tampered slot could yield a wrong-length "DEK" — reject
          // rather than silently AES-key on garbage (which would corrupt/mislead).
          if (dek.length !== DEK_LEN) { dek.fill(0); return false; }
          this.sessionKey = dek;
          if (remember) await this.remember(password);
          return true;
        } catch { priv.fill(0); }
      } catch { /* wrong password for my key — try shared password below */ }
    }
    // Shared-password path (Model 1) — try the typed password against any ACTIVE
    // shared password slot. Lets a device with no identity join just by knowing it.
    // [deprecated] slots are RETAINED for recovery but don't unlock (old passwords
    // stop working after a change — see setSharedPassword).
    for (const ps of (this.kf?.passwordSlots ?? []).filter((s) => !s.label.startsWith("[deprecated]"))) {
      try {
        const dek = await decryptStash(fromB64(ps.wrapped), password);
        if (dek.length !== DEK_LEN) { dek.fill(0); continue; } // 0.140.2: reject wrong-length DEK
        this.sessionKey = dek;
        if (remember) await this.remember(password);
        return true;
      } catch { /* not this slot */ }
    }
    return false;
  }

  /** True if an ACTIVE (non-deprecated) shared password is enabled for this vault. */
  hasSharedPassword(): boolean { return (this.kf?.passwordSlots ?? []).some((s) => !s.label.startsWith("[deprecated]")); }

  /** Set (or change) the shared password: wrap the unlocked DEK under `passphrase`
   *  so anyone who knows it can unlock — no per-device approval (Model 1). Requires
   *  the vault to be unlocked (we need the DEK in hand). NOTHING is deleted on a
   *  change: the prior slot is RETAINED and relabeled `[deprecated] …` (and the old
   *  keychain password parked under a `-d-<slotId>` id); the new slot is the only
   *  ACTIVE one, so the old password no longer unlocks via the normal path. */
  async setSharedPassword(passphrase: string, remember = false): Promise<void> {
    if (!this.sessionKey) throw new Error("Unlock encryption first.");
    if (!passphrase) throw new Error("Password required.");
    await this.refresh();
    if (!this.kf) throw new Error("Encryption is not set up.");
    const prevActive = (this.kf.passwordSlots ?? []).filter((s) => !s.label.startsWith("[deprecated]"));
    const oldPw = this.rememberedPassword();
    if (oldPw && prevActive[0]) {
      try { await this.parkThenSet(`${this.keychainId()}-d-${prevActive[0].id}`, oldPw); } catch { /* best-effort retention */ }
    }
    const wrapped = await encryptStash(this.sessionKey, passphrase);
    const retained = (this.kf.passwordSlots ?? []).map((s) => s.label.startsWith("[deprecated]") ? s : { ...s, label: `[deprecated] ${s.label}` });
    this.kf.passwordSlots = [{ id: newId(8), label: "Shared password", wrapped: toB64(wrapped.data), kdf: wrapped.kdf, createdAt: new Date().toISOString() }, ...retained];
    await this.keyfiles.save(this.kf);
    // Keep this device's keychain in sync with the ACTIVE shared password. Without
    // this, the single device slot kept serving a stale password — so auto-unlock
    // used the old one and "paste from keychain" handed back the wrong value. We
    // UPDATE (never wipe): on explicit remember, or if a password was already saved
    // here (so the now-invalid old one is replaced, not left stale). Forgetting is
    // only ever the explicit "Forget on this device" button / remove-encryption.
    if (remember || this.isRemembered()) await this.remember(passphrase);
  }

  /** Turn off the shared password. Devices that only had it can no longer unlock
   *  with it (same "not true revocation of already-synced copies" caveat as
   *  removeMember). */
  async removeSharedPassword(): Promise<void> {
    await this.refresh();
    if (!this.kf || !this.kf.passwordSlots?.length) return;
    this.kf.passwordSlots = [];
    await this.keyfiles.save(this.kf);
  }

  // ---- per-folder keys (Phase A of the per-folder overhaul) ------------------
  // A folder with its own FolderKeyEntry uses a SEPARATE DEK, wrapped under that
  // folder's password. A folder WITHOUT an entry falls back to the vault DEK
  // (getSessionKey). All of this is an OVERLAY — existing single-DEK content is
  // unaffected. UNVERIFIED: no live crypto test yet; wiring into the lock/unlock
  // ops is intentionally deferred to an attended pass.

  /** The nearest ancestor folder (including the folder itself) that has its OWN
   *  key, or null. Implements the "subfolders inherit the parent's key" decision:
   *  a note in `Projects/Sub` is owned by `Projects` if only `Projects` has a key. */
  private owningFolder(folder: string): string | null {
    const fks = this.kf?.folderKeys;
    if (!fks) return null;
    let p = this.cleanFolder(folder);
    while (p) {
      if (fks[p]) return p;
      const i = p.lastIndexOf("/");
      if (i < 0) break;
      p = p.slice(0, i);
    }
    return null;
  }
  /** True only if THIS exact folder has its own key (not inherited) — for settings
   *  UI decisions ("Set folder password" vs "Unlock/Change"). */
  hasOwnFolderKey(folder: string): boolean { return !!this.kf?.folderKeys?.[this.cleanFolder(folder)]; }
  /** The keyfile entry governing a folder — its own, or the nearest ancestor's
   *  (inheritance). Null → the folder uses the vault DEK. */
  folderKeyEntry(folder: string): FolderKeyEntry | null {
    const owner = this.owningFolder(folder);
    return owner ? (this.kf!.folderKeys![owner] ?? null) : null;
  }
  hasFolderKey(folder: string): boolean { return this.owningFolder(folder) !== null; }
  /** The folder path whose key has this keyId, or null — for resolving which key a
   *  trash blob was encrypted under (its sidecar stores the keyId). */
  folderPathByKeyId(keyId: string): string | null {
    for (const [path, e] of Object.entries(this.kf?.folderKeys ?? {})) if (e.keyId === keyId) return path;
    return null;
  }
  /** Active (non-deprecated) password slots for a folder, newest first. Deprecated
   *  slots are NEVER returned — an old/retired password must not unlock current
   *  content (matches the vault shared-password path). If there are somehow zero
   *  active slots, return none (don't silently fall back to deprecated ones). */
  private folderActiveSlots(entry: FolderKeyEntry): KeyfilePasswordSlot[] {
    return entry.passwordSlots.filter((s) => !s.label.startsWith("[deprecated]"));
  }
  /** Is the effective key for this folder available right now? (Session is keyed by
   *  the OWNING folder, so an inheriting subfolder reports the owner's state.) */
  isFolderUnlocked(folder: string): boolean {
    const owner = this.owningFolder(folder);
    return owner ? this.folderSessionKeys.has(owner) : this.isUnlocked();
  }
  /** The DEK to use for `folder`: the unlocked owning-folder key, else the vault DEK.
   *  Returns a COPY (caller may zero), or null if the needed key isn't unlocked. */
  getFolderKey(folder: string): Uint8Array | null {
    const owner = this.owningFolder(folder);
    if (!owner) return this.getSessionKey();
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
    if (!this.kf) throw new Error("Set up vault encryption first.");
    const f = this.cleanFolder(folder);
    if (this.kf.folderKeys?.[f]) throw new Error("This folder already has its own key.");
    // Inheritance: a subfolder of an already-keyed folder uses the ancestor's key —
    // don't let it mint a separate (nested) key.
    const ancestor = this.owningFolder(f);
    if (ancestor && ancestor !== f) throw new Error(`A parent folder (“${ancestor.split("/").pop()}”) already has its own password; this folder inherits it.`);
    const dek = crypto.getRandomValues(new Uint8Array(DEK_LEN));
    const wrapped = await encryptStash(dek, password);
    const keyId = newId(8);
    const entry: FolderKeyEntry = {
      keyId, folderPath: f, label, kcId: this.folderKcId(label, keyId),
      passwordSlots: [{ id: newId(8), label: "Folder password", wrapped: toB64(wrapped.data), kdf: wrapped.kdf, createdAt: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    };
    this.kf.folderKeys = { ...(this.kf.folderKeys ?? {}), [f]: entry };
    await this.keyfiles.save(this.kf);
    this.folderSessionKeys.set(f, dek);
    if (remember) await this.rememberFolder(this.folderKcIdFor(entry), password);
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
   *  (re-encrypt under a fresh DEK) use Phase B rotation. */
  async changeFolderPassword(folder: string, newPassword: string, remember = false): Promise<void> {
    if (!newPassword) throw new Error("Password required.");
    const f = this.cleanFolder(folder);
    await this.refresh();
    const entry = this.folderKeyEntry(f);
    if (!entry || !this.kf) throw new Error("This folder has no key.");
    const owner = entry.folderPath; // inheritance: operate on the key-owning folder
    const dek = this.folderSessionKeys.get(owner);
    if (!dek) throw new Error("Unlock this folder first.");
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


  /** Phase B — FINALIZE a key rotation: after the caller has re-encrypted every
   *  blob in `folder` from the old DEK to `newDek`, swap the keyfile to the new key
   *  (wrap `newDek` under `newPassword`; retain old slots as `[deprecated]`), make
   *  `newDek` the live session key, and remember the new password. If the folder had
   *  no own key (was vault-keyed), this MINTS its own key. NOTHING is deleted. */
  async commitFolderRotation(folder: string, newPassword: string, newDek: Uint8Array, rotId: string, label?: string, remember = false): Promise<void> {
    if (!newPassword) throw new Error("Password required.");
    await this.refresh();
    if (!this.kf) throw new Error("Encryption is not set up.");
    const f = this.cleanFolder(folder);
    const entry = this.folderKeyEntry(f);
    const owner = entry?.folderPath ?? f; // inheritance: rotate the key-owning folder
    const keyId = entry?.keyId ?? newId(8);
    const oldKcId = entry ? this.folderKcIdFor(entry) : null;
    // Park the old active keychain password (retain, never delete).
    const prevActive = (entry?.passwordSlots ?? []).filter((s) => !s.label.startsWith("[deprecated]"));
    const oldPw = oldKcId ? this.rememberedFolderPassword(oldKcId) : null;
    if (oldPw && prevActive[0]) {
      try { await this.parkThenSet(`${oldKcId}-d-${prevActive[0].id}`, oldPw); } catch { /* best-effort */ }
    }
    const wrapped = await encryptStash(newDek, newPassword);
    const retained = (entry?.passwordSlots ?? []).map((s) => s.label.startsWith("[deprecated]") ? s : { ...s, label: `[deprecated] ${s.label}` });
    const newLabel = label ?? entry?.label ?? `rotated - ${f.split("/").pop() || f}`;
    const next: FolderKeyEntry = {
      keyId, folderPath: owner, label: newLabel, kcId: this.folderKcId(newLabel, keyId), rotId,
      passwordSlots: [{ id: newId(8), label: "Folder password", wrapped: toB64(wrapped.data), kdf: wrapped.kdf, createdAt: new Date().toISOString() }, ...retained],
      createdAt: entry?.createdAt ?? new Date().toISOString(),
    };
    this.kf.folderKeys = { ...(this.kf.folderKeys ?? {}), [owner]: next };
    await this.keyfiles.save(this.kf);
    // Zero the OLD folder DEK before replacing it — after a true-invalidation rotation
    // the prior key shouldn't linger in memory.
    const prevSess = this.folderSessionKeys.get(owner);
    if (prevSess && prevSess !== newDek) prevSess.fill(0);
    // Store a COPY — the caller (rotateFolderKey) zeros its own newDek buffer in a
    // finally, which would otherwise zero the live session key we just set here.
    this.folderSessionKeys.set(owner, newDek.slice());
    if (remember || (oldKcId && this.isFolderRemembered(oldKcId))) await this.rememberFolder(this.folderKcIdFor(next), newPassword);
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

  /** Verify a password without changing session state (destructive-action gates). */
  async verifyPassword(password: string): Promise<boolean> {
    const cfg = this.load();
    try {
      if (cfg.identityPrivWrapped) { (await decryptStash(fromB64(cfg.identityPrivWrapped), password)).fill(0); return true; }
      if (cfg.wrappedKey) { (await decryptStash(fromB64(cfg.wrappedKey), password)).fill(0); return true; }
    } catch { /* fall through */ }
    return false;
  }

  /** Re-wrap THIS device's private key under a new password. The DEK and the
   *  keyfile are untouched (other members unaffected). */
  async changePassword(oldPassword: string, newPassword: string, remember = false): Promise<boolean> {
    const cfg = this.load();
    if (!newPassword) throw new Error("New password required.");
    if (!cfg.identityPrivWrapped) {
      // v1 vault not yet migrated — unlock (which migrates), then re-wrap.
      if (!(await this.unlock(oldPassword, false))) return false;
    }
    const fresh = this.load();
    let priv: Uint8Array;
    try { priv = await decryptStash(fromB64(fresh.identityPrivWrapped!), oldPassword); } catch { return false; }
    const wrapped = await encryptStash(priv, newPassword);
    priv.fill(0);
    await this.save({ ...fresh, identityPrivWrapped: toB64(wrapped.data), identityPrivKdf: wrapped.kdf });
    // UPDATE the keychain, never wipe: on explicit remember, or if a password was
    // already saved here (the old one is now invalid — replace it so auto-unlock
    // doesn't keep trying a stale password). Explicit forgetting lives elsewhere.
    if (remember || this.isRemembered()) await this.remember(newPassword);
    return true;
  }

  // ---- collaboration ----
  /** Create this device's identity (if needed) and publish a join request in the
   *  keyfile. `password` protects this device's new private key. */
  async requestAccess(label: string, password: string, remember = false): Promise<void> {
    await this.refresh();
    if (!this.kf) throw new Error("This vault has no encryption set up yet.");
    if (this.amIMember()) return;
    if (!password) throw new Error("Password required.");
    const id = this.hasIdentity()
      ? { id: this.load().identityId!, label: this.load().identityLabel ?? label, pub: this.load().identityPub! }
      : await this.mintIdentity(password, label);
    if (label && id.label !== label) { await this.save({ ...this.load(), identityLabel: label }); id.label = label; }
    const req: KeyfileJoinRequest = { id: id.id, label: id.label, pubKey: id.pub, requestedAt: new Date().toISOString() };
    this.kf.joinRequests = [...this.kf.joinRequests.filter((r) => r.id !== id.id), req];
    await this.keyfiles.save(this.kf);
    // Remembering now lets this device auto-unlock the moment a member approves
    // it and the keyfile syncs here (the password already protects its priv key).
    // Update-or-skip, never wipe (explicit forgetting lives elsewhere).
    if (remember || this.isRemembered()) await this.remember(password);
  }

  pendingJoinRequests(): KeyfileJoinRequest[] { return this.kf?.joinRequests ?? []; }
  members(): KeyfileIdentity[] { return this.kf?.identities ?? []; }
  myIdentityId(): string | null { return this.load().identityId; }

  /** Authorize a pending device: wrap the (unlocked) DEK to its public key. */
  async approveJoinRequest(requestId: string, label?: string): Promise<boolean> {
    if (!this.sessionKey) throw new Error("Unlock encryption first.");
    await this.refresh();
    if (!this.kf) return false;
    const req = this.kf.joinRequests.find((r) => r.id === requestId);
    if (!req) return false;
    this.kf.slots = [...this.kf.slots.filter((s) => s.recipientId !== req.id), await wrapDekTo(this.sessionKey, fromB64(req.pubKey), req.id)];
    this.kf.identities = [...this.kf.identities.filter((i) => i.id !== req.id), { id: req.id, label: label ?? req.label, pubKey: req.pubKey, addedAt: new Date().toISOString() }];
    this.kf.joinRequests = this.kf.joinRequests.filter((r) => r.id !== requestId);
    await this.keyfiles.save(this.kf);
    return true;
  }

  /** Remove a member's slot + identity. NOT true revocation (no DEK rotation) —
   *  caller must warn. */
  async removeMember(id: string): Promise<void> {
    await this.refresh();
    if (!this.kf) return;
    this.kf.slots = this.kf.slots.filter((s) => s.recipientId !== id);
    this.kf.identities = this.kf.identities.filter((i) => i.id !== id);
    this.kf.joinRequests = this.kf.joinRequests.filter((r) => r.id !== id);
    await this.keyfiles.save(this.kf);
  }

  /** Reject a pending request without authorizing it. */
  async denyJoinRequest(id: string): Promise<void> {
    await this.refresh();
    if (!this.kf) return;
    this.kf.joinRequests = this.kf.joinRequests.filter((r) => r.id !== id);
    await this.keyfiles.save(this.kf);
  }

  // ---- session key + lifecycle ----
  lock(): void {
    if (this.sessionKey) this.sessionKey.fill(0);
    this.sessionKey = null;
    // Lock everything: zero every unlocked per-folder DEK too (idle auto-lock and
    // the explicit Lock command should drop ALL key material from memory).
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

  /** Remove encryption entirely (caller gates on "no .stashenc exists"): wipe the
   *  session key, this device's identity, the legacy wrap, and the ACTIVE keyfile.
   *
   *  0.135.0: the `_keys/` rolling backups are PARKED, not deleted. The old code
   *  wiped every backup, so one Remove-encryption run destroyed all key history —
   *  hostile if the user ever needs an old key back. Backups now move to
   *  `_keys/removed-<stamp>/`, which KeyfileStore.load() never reads (it only
   *  lists `_keys/` top-level files), so the vault still comes up "not encrypted"
   *  while the wrapped keys stay recoverable by hand. */
  async clear(): Promise<void> {
    this.lock();
    await this.forgetKeychain();
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
    } catch { /* best-effort */ }
    this.kf = null;
    await this.save(defaultEncryptionConfig());
  }

  getSessionKey(): Uint8Array | null {
    return this.sessionKey ? this.sessionKey.slice() : null;
  }

  // ---- helpers ----
  /** Generate a device identity keypair, wrap its private key under `password`,
   *  persist it to per-device settings, and return the public parts. */
  private async mintIdentity(password: string, label?: string): Promise<{ id: string; label: string; pub: string }> {
    const keys = await generateIdentityKeys();
    const wrapped = await encryptStash(keys.privKeyPkcs8, password);
    keys.privKeyPkcs8.fill(0);
    const cfg = this.load();
    const id = cfg.identityId ?? newId(8);
    const lbl = label ?? cfg.identityLabel ?? "This device";
    const pub = toB64(keys.pubKeySpki);
    await this.save({ ...cfg, identityId: id, identityLabel: lbl, identityPub: pub, identityPrivWrapped: toB64(wrapped.data), identityPrivKdf: wrapped.kdf });
    return { id, label: lbl, pub };
  }
  private identityRecord(id: { id: string; label: string; pub: string }): KeyfileIdentity {
    return { id: id.id, label: id.label, pubKey: id.pub, addedAt: new Date().toISOString() };
  }

  dispose(): void { this.lock(); }
}
