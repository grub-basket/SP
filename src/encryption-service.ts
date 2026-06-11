import type { App } from "obsidian";
import { encryptStash, decryptStash, argon2Available, type StashKdf } from "./stash-crypto";

/** Stable keychain id for the (optional) remembered vault password. */
const KEYCHAIN_ID = "stashpad-vault-encryption";

interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void | Promise<void>;
  removeSecret?(id: string): void | Promise<void>;
}

/** 0.97.0 — Phase 1 scaffolding for vault encryption (see
 *  docs/encryption-expansion-plan.md). This is the KEY-MANAGEMENT core only: it
 *  sets up / unlocks / changes / clears the vault password and holds the
 *  unwrapped master key in memory for the session. It does NOT touch any vault
 *  files yet — locking notes/folders, encrypted trash, and the importer
 *  quarantine come in later phases.
 *
 *  Design (wrapped master key):
 *   - A random 256-bit **master data-encryption key (DEK)** is generated once at
 *     setup. The DEK — not the password — is what file bundles will be encrypted
 *     with (later phases).
 *   - The DEK is stored only in its **wrapped** form: `encryptStash(dek, password)`,
 *     i.e. AES-256-GCM under an Argon2id key derived from the password. The
 *     wrapped blob doubles as the password **verifier** — unwrapping throws
 *     (GCM auth failure) on a wrong password, so no separate check token is
 *     needed.
 *   - Changing the password just RE-WRAPS the same DEK (cheap; never re-encrypts
 *     files). v2 multi-password = wrap the same DEK under several passwords.
 *   - The unwrapped DEK lives only in memory (`sessionKey`), dropped on lock() /
 *     idle-timeout / Obsidian restart.
 *
 *  No recovery: lose the password and the DEK (hence any locked content) is gone.
 */

/** Persisted encryption state. Lives in plugin settings; only the WRAPPED key is
 *  ever written — never the password or the raw DEK. `null` everywhere = not set
 *  up. Base64 for JSON-safety. */
export interface EncryptionConfig {
  /** Base64 of `encryptStash(dek, password)` — the wrapped master key +
   *  verifier. Presence === "encryption is configured". */
  wrappedKey: string | null;
  /** Which KDF the wrap used (argon2id strong / pbkdf2 fallback) — surfaced in
   *  the settings UI so the user knows the strength on this device. */
  kdf: StashKdf | null;
}

export function defaultEncryptionConfig(): EncryptionConfig {
  return { wrappedKey: null, kdf: null };
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

const DEK_LEN = 32; // 256-bit master key

export class EncryptionService {
  /** The unwrapped master key, present only while unlocked this session. */
  private sessionKey: Uint8Array | null = null;
  private idleTimer: number | null = null;

  /** @param load reads the persisted config (from plugin settings).
   *  @param save persists an updated config (writes plugin settings).
   *  @param idleMinutes 0 = never auto-lock; otherwise drop the session key
   *         after this many idle minutes. */
  constructor(
    private app: App,
    private load: () => EncryptionConfig,
    private save: (cfg: EncryptionConfig) => Promise<void>,
    private idleMinutes: () => number = () => 0,
  ) {}

  /** Whether Argon2id can run on this device (for the modal's suite line). */
  argonProbe(): Promise<boolean> { return argon2Available(); }

  private secretStore(): SecretStore | null {
    return (this.app as App & { secretStorage?: SecretStore }).secretStorage ?? null;
  }
  /** Is keychain available on this Obsidian version? */
  keychainAvailable(): boolean { return !!this.secretStore(); }
  /** Is a vault password currently remembered in the keychain? */
  isRemembered(): boolean {
    try { return !!this.secretStore()?.getSecret(KEYCHAIN_ID); } catch { return false; }
  }
  private async remember(password: string): Promise<void> {
    try { await this.secretStore()?.setSecret(KEYCHAIN_ID, password); }
    catch (e) { console.warn("[Stashpad] couldn't save password to keychain", e); }
  }
  async forgetKeychain(): Promise<void> {
    const ss = this.secretStore();
    if (!ss) return;
    try {
      if (ss.removeSecret) await ss.removeSecret(KEYCHAIN_ID);
      else await ss.setSecret(KEYCHAIN_ID, "");
    } catch (e) { console.warn("[Stashpad] couldn't clear keychain", e); }
  }
  /** On load: if configured AND a password is remembered, unlock silently. */
  async tryAutoUnlock(): Promise<boolean> {
    if (!this.isConfigured() || this.isUnlocked()) return this.isUnlocked();
    let stored: string | null = null;
    try { stored = this.secretStore()?.getSecret(KEYCHAIN_ID) ?? null; } catch { stored = null; }
    if (!stored) return false;
    return this.unlock(stored);
  }

  /** Has the user set a vault password? (Independent of unlocked state.) */
  isConfigured(): boolean {
    return !!this.load().wrappedKey;
  }

  /** Is the master key currently in memory (usable for encrypt/decrypt)? */
  isUnlocked(): boolean {
    return this.sessionKey !== null;
  }

  /** The KDF the wrap used, for UI strength display. */
  kdf(): StashKdf | null {
    return this.load().kdf;
  }

  /** First-time setup: generate a fresh master key, wrap it under `password`,
   *  persist the wrapped form, and leave the session unlocked. Throws if already
   *  configured (use changePassword instead). */
  async setup(password: string, remember = false): Promise<void> {
    if (this.isConfigured()) throw new Error("Encryption is already set up.");
    if (!password) throw new Error("Password required.");
    const dek = crypto.getRandomValues(new Uint8Array(DEK_LEN));
    const wrapped = await encryptStash(dek, password);
    await this.save({ wrappedKey: toB64(wrapped.data), kdf: wrapped.kdf });
    this.sessionKey = dek;
    if (remember) await this.remember(password); else await this.forgetKeychain();
    this.armIdle();
  }

  /** Unlock the session by unwrapping the master key with `password`. Returns
   *  true on success; false on wrong password (GCM auth failure). */
  async unlock(password: string, remember = false): Promise<boolean> {
    const cfg = this.load();
    if (!cfg.wrappedKey) throw new Error("Encryption is not set up.");
    try {
      const dek = await decryptStash(fromB64(cfg.wrappedKey), password);
      this.sessionKey = dek;
      if (remember) await this.remember(password);
      this.armIdle();
      return true;
    } catch {
      return false; // wrong password / tampered wrap
    }
  }

  /** Re-wrap the SAME master key under a new password. Requires the old password
   *  (verifies it by unwrapping). Returns false if the old password is wrong. */
  async changePassword(oldPassword: string, newPassword: string, remember = false): Promise<boolean> {
    const cfg = this.load();
    if (!cfg.wrappedKey) throw new Error("Encryption is not set up.");
    if (!newPassword) throw new Error("New password required.");
    let dek: Uint8Array;
    try {
      dek = await decryptStash(fromB64(cfg.wrappedKey), oldPassword);
    } catch {
      return false;
    }
    const wrapped = await encryptStash(dek, newPassword);
    await this.save({ wrappedKey: toB64(wrapped.data), kdf: wrapped.kdf });
    if (this.sessionKey) this.sessionKey.fill(0); // wipe the old buffer before replacing
    this.sessionKey = dek; // stay unlocked
    if (remember) await this.remember(newPassword); else await this.forgetKeychain();
    this.armIdle();
    return true;
  }

  /** Verify a password WITHOUT changing session state (for destructive-action
   *  gates like Remove). Returns true if it unwraps the key. */
  async verifyPassword(password: string): Promise<boolean> {
    const cfg = this.load();
    if (!cfg.wrappedKey) return false;
    try {
      const dek = await decryptStash(fromB64(cfg.wrappedKey), password);
      dek.fill(0); // verification only — don't leave a key copy for the GC
      return true;
    } catch { return false; }
  }

  /** Drop the master key from memory (re-prompt needed for the next op). */
  lock(): void {
    if (this.sessionKey) this.sessionKey.fill(0);
    this.sessionKey = null;
    this.clearIdle();
  }

  /** Remove encryption entirely: forget + erase the wrapped key. CALLER MUST
   *  warn first — any content already locked with this key becomes permanently
   *  inaccessible. (No locked content exists in Phase 1, so this is safe now.) */
  async clear(): Promise<void> {
    this.lock();
    await this.forgetKeychain();
    await this.save(defaultEncryptionConfig());
  }

  /** The session master key, or null if locked. Later phases call this to
   *  encrypt/decrypt bundles; a null result means "prompt to unlock first".
   *  Returns a COPY, never the live buffer: the idle auto-lock zeroes
   *  `sessionKey` in place, and a long-running lock op holding the live
   *  reference could otherwise end up encrypting with an all-zeros key
   *  mid-operation — its self-check would even pass (same zeroed buffer on
   *  both sides) and the plaintext would be purged behind an unrecoverable,
   *  publicly-decryptable blob. A copy makes in-flight ops immune. */
  getSessionKey(): Uint8Array | null {
    if (this.sessionKey) this.armIdle(); // any use resets the idle clock
    return this.sessionKey ? this.sessionKey.slice() : null;
  }

  // ---- idle auto-lock ----
  private armIdle(): void {
    this.clearIdle();
    const mins = this.idleMinutes();
    if (mins > 0) {
      this.idleTimer = window.setTimeout(() => this.lock(), mins * 60_000);
    }
  }
  private clearIdle(): void {
    if (this.idleTimer != null) { window.clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** Wipe the key on plugin unload. */
  dispose(): void {
    this.lock();
  }
}
