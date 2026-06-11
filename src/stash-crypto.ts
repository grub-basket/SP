import { App } from "obsidian";
import { argon2id } from "hash-wasm";
import { StashPasswordModal, type StashPasswordResult } from "./modals";

/** Optional password encryption for .stash exports.
 *
 *  0.84.14 — upgraded suite. KDF is **Argon2id** (memory-hard, GPU/ASIC-
 *  resistant) with a **PBKDF2-SHA256 fallback** if the Argon2 WASM can't load,
 *  feeding a 256-bit **AES-GCM** key. The KDF + its parameters are stored in
 *  the (authenticated) header, so the scheme is self-describing and future
 *  tuning never breaks old files. A plain (unencrypted) .stash has no magic and
 *  imports as before. Decryption happens BEFORE the unchanged importStashZip
 *  path, so every zip-slip / collision / manifest guard there still applies.
 *  No recovery if the password is lost — GCM auth failure is the only signal of
 *  a wrong password.
 *
 *  Envelope v2 layout (binary, prepended to the zip):
 *    [0..7]    magic "STASHENC"
 *    [8]       version = 2
 *    [9]       kdfId   (1 = PBKDF2-SHA256, 2 = Argon2id)
 *    [10..13]  kdf param A (uint32 BE)  — PBKDF2: iterations · Argon2: memoryKiB
 *    [14..17]  kdf param B (uint32 BE)  — PBKDF2: 0 · Argon2: timeCost
 *    [18]      kdf param C (uint8)      — PBKDF2: 0 · Argon2: parallelism
 *    [19]      saltLen (uint8)
 *    [20 .. 20+saltLen-1]  salt
 *    [.. +12]  iv (12 bytes)
 *    [..]      AES-256-GCM ciphertext (+ tag). The ENTIRE header above is the
 *              GCM additionalData (AAD), so the version/KDF params/salt/iv are
 *              authenticated — tampering with them fails decryption.
 *
 *  Envelope v1 (legacy, still decrypted): magic + version(1) + salt(16) +
 *  iv(12) + AES-GCM ct; key = PBKDF2-SHA256(210k). No AAD. */

const MAGIC = new Uint8Array([0x53, 0x54, 0x41, 0x53, 0x48, 0x45, 0x4e, 0x43]); // "STASHENC"
const VERSION = 2;

const KDF_PBKDF2 = 1;
const KDF_ARGON2ID = 2;
// 0.98.0: raw-key envelope — the 32-byte key is used DIRECTLY as the AES key (no
// password, no derivation). Used for in-vault locked bundles encrypted with the
// session DEK (the password only ever unwraps the DEK). Same envelope/AAD/magic.
const KDF_RAW = 3;

const SALT_LEN = 32;
const IV_LEN = 12;
const KEY_LEN = 32; // 256-bit AES key

// Hardened PBKDF2 fallback (OWASP 2023 floor for PBKDF2-HMAC-SHA256).
const PBKDF2_ITERS = 600_000;
// Argon2id parameters — balanced strong defaults (memory-hard; ~mid-hundreds of
// ms on desktop). 46 MiB keeps it viable on mobile too.
const ARGON2_MEMORY_KIB = 47104; // 46 MiB
const ARGON2_TIME = 3;
const ARGON2_PARALLELISM = 1;

// crypto.subtle wants BufferSource; the bundler's TS lib types Uint8Array as
// Uint8Array<ArrayBufferLike>, which it doesn't accept directly. Cast helper.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function isEncryptedStash(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length + 1) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

function writeU32BE(arr: Uint8Array, off: number, v: number): void {
  arr[off] = (v >>> 24) & 0xff; arr[off + 1] = (v >>> 16) & 0xff;
  arr[off + 2] = (v >>> 8) & 0xff; arr[off + 3] = v & 0xff;
}
function readU32BE(arr: Uint8Array, off: number): number {
  return (arr[off] * 0x1000000) + (arr[off + 1] << 16) + (arr[off + 2] << 8) + arr[off + 3];
}

interface KdfSpec { id: number; a: number; b: number; c: number; }

/** Derive a raw 256-bit key from the password + salt for the given KDF. */
async function deriveKeyBytes(password: string, salt: Uint8Array, kdf: KdfSpec): Promise<Uint8Array> {
  if (kdf.id === KDF_ARGON2ID) {
    const out = await argon2id({
      password,
      salt,
      parallelism: kdf.c,
      iterations: kdf.b,
      memorySize: kdf.a,     // KiB
      hashLength: KEY_LEN,
      outputType: "binary",
    });
    return out as Uint8Array;
  }
  if (kdf.id === KDF_PBKDF2) {
    const baseKey = await crypto.subtle.importKey(
      "raw", bs(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: bs(salt), iterations: kdf.a, hash: "SHA-256" },
      baseKey, KEY_LEN * 8,
    );
    return new Uint8Array(bits);
  }
  throw new Error(`Unsupported KDF id (${kdf.id}).`);
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bs(keyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Which KDF an encryption actually used. `argon2id` is the strong default;
 *  `pbkdf2` means the Argon2 WASM couldn't run here and we fell back to the
 *  (still solid, but weaker against GPU cracking) PBKDF2-600k path. */
export type StashKdf = "argon2id" | "pbkdf2";

/** Human-facing label + whether it's the strong choice, for UI surfacing. */
export const STASH_KDF_INFO: Record<StashKdf, { label: string; strong: boolean }> = {
  argon2id: { label: "Argon2id", strong: true },
  pbkdf2: { label: "PBKDF2 (fallback)", strong: false },
};

export async function encryptStash(zip: Uint8Array, password: string): Promise<{ data: Uint8Array; kdf: StashKdf }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));

  // Prefer Argon2id; fall back to hardened PBKDF2 if the WASM can't run here.
  let kdf: KdfSpec;
  let kdfName: StashKdf;
  let keyBytes: Uint8Array;
  try {
    kdf = { id: KDF_ARGON2ID, a: ARGON2_MEMORY_KIB, b: ARGON2_TIME, c: ARGON2_PARALLELISM };
    keyBytes = await deriveKeyBytes(password, salt, kdf);
    kdfName = "argon2id";
  } catch (e) {
    console.warn("[Stashpad] Argon2id unavailable — encrypting with PBKDF2 fallback.", e);
    kdf = { id: KDF_PBKDF2, a: PBKDF2_ITERS, b: 0, c: 0 };
    keyBytes = await deriveKeyBytes(password, salt, kdf);
    kdfName = "pbkdf2";
  }

  const header = buildHeaderV2(kdf, salt, iv);
  const key = await importAesKey(keyBytes);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(iv), additionalData: bs(header) }, key, bs(zip),
  ));
  const out = new Uint8Array(header.length + ct.length);
  out.set(header, 0);
  out.set(ct, header.length);
  return { data: out, kdf: kdfName };
}

/** Probe whether Argon2id can run in this environment (so the UI can tell the
 *  user which suite an encrypted export will use BEFORE they commit). Cached. */
let _argonOk: boolean | null = null;
export async function argon2Available(): Promise<boolean> {
  if (_argonOk !== null) return _argonOk;
  try {
    await argon2id({ password: "x", salt: new Uint8Array(16), parallelism: 1, iterations: 1, memorySize: 8, hashLength: 16, outputType: "binary" });
    _argonOk = true;
  } catch { _argonOk = false; }
  return _argonOk;
}

function buildHeaderV2(kdf: KdfSpec, salt: Uint8Array, iv: Uint8Array): Uint8Array {
  const head = new Uint8Array(MAGIC.length + 1 + 1 + 4 + 4 + 1 + 1 + salt.length + iv.length);
  let o = 0;
  head.set(MAGIC, o); o += MAGIC.length;
  head[o++] = VERSION;
  head[o++] = kdf.id;
  writeU32BE(head, o, kdf.a); o += 4;
  writeU32BE(head, o, kdf.b); o += 4;
  head[o++] = kdf.c;
  head[o++] = salt.length;
  head.set(salt, o); o += salt.length;
  head.set(iv, o); o += iv.length;
  return head;
}

export async function decryptStash(envelope: Uint8Array, password: string): Promise<Uint8Array> {
  if (!isEncryptedStash(envelope)) throw new Error("Not an encrypted Stashpad file.");
  const version = envelope[MAGIC.length];
  if (version === 1) return decryptV1(envelope, password);
  if (version !== VERSION) throw new Error(`Unsupported encrypted .stash version (${version}).`);

  let o = MAGIC.length + 1;
  const kdf: KdfSpec = { id: envelope[o++], a: 0, b: 0, c: 0 };
  kdf.a = readU32BE(envelope, o); o += 4;
  kdf.b = readU32BE(envelope, o); o += 4;
  kdf.c = envelope[o++];
  // The KDF necessarily runs BEFORE the GCM tag can authenticate the header
  // (the key comes from the KDF), so these parameters are attacker-controlled
  // on a received file. Clamp them or a crafted envelope (e.g. memorySize =
  // 4 TiB, iterations = 2^32) hangs/OOM-kills Obsidian the moment a password
  // is entered. Legitimate files only ever use the constants above.
  if (kdf.id === KDF_ARGON2ID) {
    if (kdf.a > 2_097_152 /* 2 GiB in KiB */ || kdf.b > 64 || kdf.c < 1 || kdf.c > 8) {
      throw new Error("Unsupported KDF parameters (file may be corrupted or malicious).");
    }
  } else if (kdf.id === KDF_PBKDF2) {
    if (kdf.a > 10_000_000) throw new Error("Unsupported KDF parameters (file may be corrupted or malicious).");
  }
  const saltLen = envelope[o++];
  if (saltLen < 8 || saltLen > 64) throw new Error("Unsupported KDF parameters (file may be corrupted or malicious).");
  const salt = envelope.slice(o, o + saltLen); o += saltLen;
  const iv = envelope.slice(o, o + IV_LEN); o += IV_LEN;
  const header = envelope.slice(0, o); // everything before the ciphertext = AAD
  const ct = envelope.slice(o);

  const keyBytes = await deriveKeyBytes(password, salt, kdf);
  const key = await importAesKey(keyBytes);
  // Throws OperationError on wrong password / tampering (GCM tag mismatch).
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(iv), additionalData: bs(header) }, key, bs(ct),
  );
  return new Uint8Array(pt);
}

/** Legacy v1 envelope: PBKDF2(210k) → AES-256-GCM, no AAD. Kept so .stash
 *  files exported before 0.84.14 still import. */
async function decryptV1(envelope: Uint8Array, password: string): Promise<Uint8Array> {
  let o = MAGIC.length + 1;
  const salt = envelope.slice(o, o + 16); o += 16;
  const iv = envelope.slice(o, o + 12); o += 12;
  const ct = envelope.slice(o);
  const baseKey = await crypto.subtle.importKey(
    "raw", bs(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations: 210_000, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(ct));
  return new Uint8Array(pt);
}

/** 0.98.0: encrypt with a RAW 32-byte key (the session DEK), no password/KDF.
 *  Same `STASHENC` envelope (so isEncryptedStash + the double-encryption guard
 *  still recognize it), with kdfId=RAW and a 0-length salt. Used for in-vault
 *  `.stashenc` locked bundles. */
export async function encryptWithKey(plaintext: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (keyBytes.length !== KEY_LEN) throw new Error("Encryption key must be 32 bytes.");
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const kdf: KdfSpec = { id: KDF_RAW, a: 0, b: 0, c: 0 };
  const header = buildHeaderV2(kdf, new Uint8Array(0), iv);
  const key = await importAesKey(keyBytes);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(iv), additionalData: bs(header) }, key, bs(plaintext),
  ));
  const out = new Uint8Array(header.length + ct.length);
  out.set(header, 0);
  out.set(ct, header.length);
  return out;
}

/** 0.98.0: decrypt a raw-key (`KDF_RAW`) envelope with the 32-byte key. Throws on
 *  wrong key / tampering (GCM auth) or if the envelope isn't a raw-key one. */
export async function decryptWithKey(envelope: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (!isEncryptedStash(envelope)) throw new Error("Not an encrypted Stashpad file.");
  const version = envelope[MAGIC.length];
  if (version !== VERSION) throw new Error(`Unsupported encrypted version (${version}).`);
  let o = MAGIC.length + 1;
  const kdfId = envelope[o++];
  if (kdfId !== KDF_RAW) throw new Error("Not a raw-key (.stashenc) envelope.");
  o += 4 + 4 + 1; // skip kdf params a, b, c
  const saltLen = envelope[o++];
  o += saltLen; // raw → 0-length salt
  const iv = envelope.slice(o, o + IV_LEN); o += IV_LEN;
  const header = envelope.slice(0, o);
  const ct = envelope.slice(o);
  const key = await importAesKey(keyBytes);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(iv), additionalData: bs(header) }, key, bs(ct),
  );
  return new Uint8Array(pt);
}

/** Resolve raw .stash bytes to a plain zip ready for importStashZip. If the
 *  bytes are an encrypted envelope, prompt for the password (re-prompting on a
 *  wrong password) and return the decrypted zip. Plain bytes pass through.
 *  Returns null if the user cancels — callers MUST abort the import (and not
 *  trash the source file) in that case. */
export async function resolveStashBytes(
  app: App,
  bytes: Uint8Array,
  opts: { allowLater?: boolean; onLater?: () => void; secretId?: string } = {},
): Promise<Uint8Array | null> {
  if (!isEncryptedStash(bytes)) return bytes;

  // 0.85.4: if this export's passphrase was remembered in this vault's secret
  // storage (keyed by filename), try it silently before prompting. This goes
  // through the SAME decryptStash path — no bypass of the zip-slip / collision
  // guards downstream. A stored-but-wrong secret just falls through to prompt.
  if (opts.secretId) {
    const ss = (app as App & { secretStorage?: { getSecret(id: string): string | null } }).secretStorage;
    let stored: string | null = null;
    try { stored = ss?.getSecret(opts.secretId) ?? null; } catch { stored = null; }
    if (stored) {
      try { return await decryptStash(bytes, stored); } catch { /* fall through to prompt */ }
    }
  }

  let errorMsg: string | undefined;
  for (;;) {
    const r = await new Promise<StashPasswordResult>((resolve) => {
      new StashPasswordModal(app, errorMsg, !!opts.allowLater, resolve).open();
    });
    if (r.kind === "cancel") return null;
    if (r.kind === "later") { opts.onLater?.(); return null; }
    try {
      return await decryptStash(bytes, r.value);
    } catch {
      errorMsg = "Wrong password or corrupted file. Try again.";
    }
  }
}
