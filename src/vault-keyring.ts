/** Vault keyring — public-key distribution of the single vault DEK for shared
 *  collaboration (see docs/branches/encryption-collab.md).
 *
 *  This module is PURE WebCrypto (no Obsidian, no Argon2) so it's unit-testable
 *  in isolation. It owns the asymmetric half of the design:
 *   - each device has an ECDH P-256 identity keypair,
 *   - the vault DEK is wrapped *to* each authorized public key (ECIES: ephemeral
 *     ECDH → HKDF-SHA256 → AES-256-GCM), producing one `KeySlot` per recipient,
 *   - a member unwraps the DEK with their own private key.
 *
 *  Password protection of the private key at rest is the EncryptionService's job
 *  (it reuses the existing Argon2id `encryptStash`), keeping this module pure.
 *
 *  The algorithm here is validated by /tmp/keyring-test.mjs (round-trip, cross-key
 *  rejection, tamper rejection) — keep them in sync if you change the KDF/info. */

/** ECDH P-256 — WebCrypto ships it on every Electron/browser we target (X25519
 *  isn't universal yet). */
const EC = { name: "ECDH", namedCurve: "P-256" } as const;
/** Domain-separation label bound into the HKDF so these wrapped DEKs can't be
 *  confused with any other ECDH use. */
const HKDF_INFO = "stashpad-vault-dek-wrap";

const te = new TextEncoder();

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function ub64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** A raw (unwrapped-at-rest) identity keypair, exported for storage. The public
 *  half goes in the synced keyfile; the private half is password-wrapped by the
 *  caller before it touches disk. */
export interface RawIdentityKeys {
  /** SPKI-exported public key. */
  pubKeySpki: Uint8Array;
  /** PKCS8-exported private key — caller MUST wrap under the user's password. */
  privKeyPkcs8: Uint8Array;
}

/** The DEK encrypted to one recipient's public key. Stored in the keyfile's
 *  `slots`. Carries the ephemeral public key needed to re-derive the shared
 *  secret on unwrap. */
export interface KeySlot {
  recipientId: string;
  /** Ephemeral ECDH public key (SPKI), base64. */
  ephPub: string;
  /** AES-GCM iv, base64. */
  iv: string;
  /** AES-GCM ciphertext of the DEK, base64. */
  ct: string;
}

/** Generate a fresh device identity keypair (extractable, for export). */
export async function generateIdentityKeys(): Promise<RawIdentityKeys> {
  const kp = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
  return {
    pubKeySpki: new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)),
    privKeyPkcs8: new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
  };
}

function importPub(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spki as unknown as ArrayBuffer, EC, false, []);
}
function importPriv(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8 as unknown as ArrayBuffer, EC, false, ["deriveBits"]);
}

/** ECDH(privKey, pubKey) → HKDF-SHA256 → AES-256-GCM key. Symmetric: pairing the
 *  ephemeral private with the recipient public (wrap) yields the same key as the
 *  recipient private with the ephemeral public (unwrap). */
async function deriveAesKey(privKey: CryptoKey, pubKey: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pubKey }, privKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0) as unknown as ArrayBuffer, info: te.encode(HKDF_INFO) as unknown as ArrayBuffer },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/** Wrap `dek` to a recipient's public key. Needs only the PUBLIC key, so an
 *  unlocked member can authorize someone without that person's password. */
export async function wrapDekTo(dek: Uint8Array, recipientPubSpki: Uint8Array, recipientId: string): Promise<KeySlot> {
  const eph = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
  const aes = await deriveAesKey(eph.privateKey, await importPub(recipientPubSpki));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as ArrayBuffer }, aes, dek as unknown as ArrayBuffer));
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey));
  return { recipientId, ephPub: b64(ephPub), iv: b64(iv), ct: b64(ct) };
}

/** Unwrap the DEK from a slot using my private key. Throws (GCM auth failure) if
 *  the slot wasn't wrapped to my key or the ciphertext was tampered with. */
export async function unwrapDekWith(slot: KeySlot, myPrivPkcs8: Uint8Array): Promise<Uint8Array> {
  const aes = await deriveAesKey(await importPriv(myPrivPkcs8), await importPub(ub64(slot.ephPub)));
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(slot.iv) as unknown as ArrayBuffer }, aes, ub64(slot.ct) as unknown as ArrayBuffer));
}

export const _b64 = b64;
export const _ub64 = ub64;
