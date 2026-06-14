import type { App } from "obsidian";
import { encryptStash, decryptStash, argon2Available, type StashKdf } from "./stash-crypto";
import { newId } from "./id-service";
import { generateIdentityKeys, wrapDekTo, unwrapDekWith } from "./vault-keyring";
import { KeyfileStore, emptyKeyfile, type VaultKeyfile, type KeyfileIdentity, type KeyfileJoinRequest } from "./vault-keyfile";

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
  private idleTimer: number | null = null;
  private keyfiles: KeyfileStore;
  /** In-memory cache of the synced keyfile (refreshed via init()/refresh()). */
  private kf: VaultKeyfile | null = null;

  constructor(
    private app: App,
    private load: () => EncryptionConfig,
    private save: (cfg: EncryptionConfig) => Promise<void>,
    private idleMinutes: () => number = () => 0,
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
  private keychainId(): string {
    const appId = (this.app as App & { appId?: string }).appId || "default";
    return `${LEGACY_KEYCHAIN_ID}-${appId}`;
  }
  isRemembered(): boolean {
    try { return !!this.secretStore()?.getSecret(this.keychainId()); } catch { return false; }
  }
  private async remember(password: string): Promise<void> {
    try { await this.secretStore()?.setSecret(this.keychainId(), password); }
    catch (e) { console.warn("[Stashpad] couldn't save password to keychain", e); }
  }
  async forgetKeychain(): Promise<void> {
    const ss = this.secretStore();
    if (!ss) return;
    try { if (ss.removeSecret) await ss.removeSecret(this.keychainId()); else await ss.setSecret(this.keychainId(), ""); }
    catch (e) { console.warn("[Stashpad] couldn't clear keychain", e); }
  }
  async tryAutoUnlock(): Promise<boolean> {
    if (!this.isConfigured() || this.isUnlocked()) return this.isUnlocked();
    // Can't auto-unlock unless this device can unlock at all: a member (its own
    // slot) or any device when a shared password is enabled.
    if (this.accessState() !== "member" && !this.hasSharedPassword()) return false;
    const ss = this.secretStore();
    let stored: string | null = null;
    try { stored = ss?.getSecret(this.keychainId()) ?? null; } catch { stored = null; }
    if (stored) return this.unlock(stored);
    let legacy: string | null = null;
    try { legacy = ss?.getSecret(LEGACY_KEYCHAIN_ID) ?? null; } catch { legacy = null; }
    if (!legacy) return false;
    const ok = await this.unlock(legacy);
    if (ok) { await this.remember(legacy); try { if (ss?.removeSecret) await ss.removeSecret(LEGACY_KEYCHAIN_ID); else await ss?.setSecret(LEGACY_KEYCHAIN_ID, ""); } catch { /* */ } }
    return ok;
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
    if (remember) await this.remember(password); else await this.forgetKeychain();
    this.armIdle();
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
      this.armIdle();
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
          this.sessionKey = dek;
          if (remember) await this.remember(password);
          this.armIdle();
          return true;
        } catch { priv.fill(0); }
      } catch { /* wrong password for my key — try shared password below */ }
    }
    // Shared-password path (Model 1) — try the typed password against any shared
    // password slot. Lets a device with no identity join just by knowing it.
    for (const ps of (this.kf?.passwordSlots ?? [])) {
      try {
        const dek = await decryptStash(fromB64(ps.wrapped), password);
        this.sessionKey = dek;
        if (remember) await this.remember(password);
        this.armIdle();
        return true;
      } catch { /* not this slot */ }
    }
    return false;
  }

  /** True if a shared password is enabled for this vault. */
  hasSharedPassword(): boolean { return (this.kf?.passwordSlots?.length ?? 0) > 0; }

  /** Set (or replace) the shared password: wrap the unlocked DEK under `passphrase`
   *  so anyone who knows it can unlock — no per-device approval (Model 1). Requires
   *  the vault to be unlocked (we need the DEK in hand). */
  async setSharedPassword(passphrase: string): Promise<void> {
    if (!this.sessionKey) throw new Error("Unlock encryption first.");
    if (!passphrase) throw new Error("Password required.");
    await this.refresh();
    if (!this.kf) throw new Error("Encryption is not set up.");
    const wrapped = await encryptStash(this.sessionKey, passphrase);
    this.kf.passwordSlots = [{ id: newId(8), label: "Shared password", wrapped: toB64(wrapped.data), kdf: wrapped.kdf, createdAt: new Date().toISOString() }];
    await this.keyfiles.save(this.kf);
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
    if (remember) await this.remember(newPassword); else await this.forgetKeychain();
    this.armIdle();
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
    if (remember) await this.remember(password); else await this.forgetKeychain();
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
    this.clearIdle();
  }

  /** Remove encryption entirely (caller gates on "no .stashenc exists"): wipe the
   *  session key, this device's identity, the legacy wrap, AND the synced keyfile
   *  + backups (no encrypted content remains, so this is safe). */
  async clear(): Promise<void> {
    this.lock();
    await this.forgetKeychain();
    try {
      const a = this.app.vault.adapter;
      for (const p of [".stashpad/keys.json"]) { try { if (await a.exists(p)) await a.remove(p); } catch { /* */ } }
      try { const list = await a.list("_keys"); for (const f of (list.files || [])) { if (/\/keys-\d+\.json$/.test(f)) { try { await a.remove(f); } catch { /* */ } } } } catch { /* */ }
    } catch { /* best-effort */ }
    this.kf = null;
    await this.save(defaultEncryptionConfig());
  }

  getSessionKey(): Uint8Array | null {
    if (this.sessionKey) this.armIdle();
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

  private armIdle(): void {
    this.clearIdle();
    const mins = this.idleMinutes();
    if (mins > 0) this.idleTimer = window.setTimeout(() => this.lock(), mins * 60_000);
  }
  private clearIdle(): void {
    if (this.idleTimer != null) { window.clearTimeout(this.idleTimer); this.idleTimer = null; }
  }
  dispose(): void { this.lock(); }
}
