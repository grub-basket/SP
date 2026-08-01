import type { App } from "obsidian";
import { encryptStash, decryptStash, type StashKdf } from "./stash-crypto";
import { newId } from "./id-service";

/** Per-folder key file (`<folder>/.stashkey`) — the decentralized replacement for
 *  the central `.stashpad/keys.json`. Each encrypted folder owns one; it holds the
 *  folder DEK wrapped under the folder password (and, optionally, a recovery
 *  password). It travels WITH the folder it protects, so there is no shared,
 *  cross-folder, sync-raced file. See `docs/encryption-keyfile-removal-plan.md`.
 *
 *  This module is storage + wrap/unwrap ONLY — it does not manage sessions or
 *  wire into EncryptionService yet (that's Phase 2b, with a keyfile fallback).
 *
 *  Everything stored is either public or DEK-wrapped-under-a-password (Argon2id),
 *  so it's safe to sync. The DEK never leaves memory unwrapped. */

/** Exported so every path that BUNDLES or PURGES a folder can exclude it by the
 *  same constant the writer uses. Hardcoding ".stashkey" in a filter is how
 *  0.209.4's data-loss bug happened. */
export const KEYFILE_NAME = ".stashkey";
const DEK_LEN = 32; // 256-bit folder key (matches EncryptionService.DEK_LEN)

export interface StashKeySlot {
  id: string;
  /** Human label: "Folder password" (primary) or "Recovery password". */
  label: string;
  /** base64 of `encryptStash(dek, password).data` — DEK wrapped under this slot's password. */
  wrapped: string;
  /** KDF the wrap used (embedded in the blob too; kept for display/debug). */
  kdf: StashKdf;
  createdAt: string;
  /** True for the optional recovery slot (an ALTERNATE password that unlocks the
   *  same DEK). Absent/false on the primary slot. */
  recovery?: boolean;
}

export interface StashKey {
  v: 1;
  /** Stable id for this folder key (per-folder keychain id + labels). */
  keyId: string;
  /** Last-known folder path — identity is the file's LOCATION, this is for labels. */
  folderPath: string;
  /** slots[0] is the primary; an optional `recovery: true` slot may follow. */
  slots: StashKeySlot[];
  createdAt: string;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const iso = (): string => new Date().toISOString();

export class FolderKeystore {
  constructor(private app: App) {}
  private get a() { return this.app.vault.adapter; }

  keyPath(folder: string): string {
    return `${folder.replace(/\/+$/, "")}/${KEYFILE_NAME}`;
  }

  private validate(j: unknown): j is StashKey {
    const k = j as StashKey;
    return !!k && k.v === 1 && typeof k.keyId === "string" && typeof k.folderPath === "string"
      && Array.isArray(k.slots) && k.slots.every((s) => s && typeof s.wrapped === "string" && typeof s.id === "string");
  }

  /** Read + parse a folder's `.stashkey`. Never throws — null on absent/corrupt. */
  async read(folder: string): Promise<StashKey | null> {
    const path = this.keyPath(folder);
    try {
      if (!(await this.a.exists(path))) return null;
      const j = JSON.parse(await this.a.read(path));
      return this.validate(j) ? j : null;
    } catch { return null; }
  }

  /** True if a `.stashkey` FILE is present (even if corrupt) — mirrors
   *  KeyfileStore.hasAnyFile so callers can distinguish "unreadable" from "absent"
   *  and refuse to clobber a real-but-unreadable key file. */
  async hasFile(folder: string): Promise<boolean> {
    try { return await this.a.exists(this.keyPath(folder)); } catch { return false; }
  }

  /** Atomic write: temp file, READ-BACK VERIFY, then rename over the target (safe on
   *  network drives / a crash mid-write corrupts only the temp). Mirrors
   *  KeyfileStore.save (0.140.18). Throws if the key could not be persisted intact —
   *  callers must not treat a failure here as success, because the caller's next act
   *  is usually to encrypt content against this key.
   *
   *  0.211.3 — this file is the ONLY copy of a folder's wrapped key. Losing it makes
   *  every encrypted note in the folder permanently unreadable, so the ordering rules
   *  are strict:
   *
   *  1. NEVER remove the existing key file before a replacement is confirmed on disk.
   *     The old fallback did `remove(path)` then `rename(tmp, path)`; a crash, a
   *     network-drive stall or a permissions error in that window left the folder with
   *     NO key file at all. Where rename-over-existing isn't supported we now write
   *     straight over the path instead — `adapter.write` truncates and writes in one
   *     step, so there is no moment when the key is simply absent.
   *  2. Keep a `.stashkey.bak` of the previous good key across the overwrite, and
   *     restore from it if the final read-back doesn't match. That covers the case
   *     rule 1 can't: a write that starts, truncates, and then fails.
   *  3. Verify by reading back and comparing bytes, both for the temp and for the
   *     final file. A silently truncated write is the failure mode that matters here,
   *     and only a compare catches it. */
  async write(folder: string, sk: StashKey): Promise<void> {
    const path = this.keyPath(folder);
    const body = JSON.stringify(sk, null, 2);
    const tmp = `${path}.tmp`;
    const bak = `${path}.bak`;

    // Stage into the temp file and prove it landed intact BEFORE touching the target.
    try {
      await this.a.write(tmp, body);
      if ((await this.a.read(tmp)) !== body) throw new Error("verify failed");
    } catch (e) {
      try { if (await this.a.exists(tmp)) await this.a.remove(tmp); } catch { /* best-effort */ }
      throw new Error(`Couldn't stage the folder key file (${path}): ${(e as Error).message}. Nothing was changed.`);
    }

    // Preserve the previous good key so a failed overwrite is recoverable.
    let hadPrev = false;
    try {
      if (await this.a.exists(path)) {
        const prev = await this.a.read(path);
        if (prev) { await this.a.write(bak, prev); hadPrev = true; }
      }
    } catch { /* best-effort — a missing backup must not block the write */ }

    let placed = false;
    try { await this.a.rename(tmp, path); placed = true; }
    catch {
      // rename-over-existing is unsupported by some adapters. Write over the target
      // directly rather than removing it first — see rule 1 above.
      try { await this.a.write(path, body); placed = true; } catch { /* verified below */ }
      try { if (await this.a.exists(tmp)) await this.a.remove(tmp); } catch { /* best-effort */ }
    }

    // Final read-back. If the target is wrong, put the old key back rather than
    // leaving the folder with a truncated or absent key file.
    let ok = false;
    try { ok = placed && (await this.a.read(path)) === body; } catch { ok = false; }
    if (!ok) {
      if (hadPrev) { try { await this.a.write(path, await this.a.read(bak)); } catch { /* nothing more we can do */ } }
      throw new Error(`Couldn't write the folder key file (${path}). ${hadPrev ? "The previous key was restored." : "No key file was created."} Don't encrypt this folder until this is resolved.`);
    }
    try { if (await this.a.exists(bak)) await this.a.remove(bak); } catch { /* harmless leftover */ }
  }

  /** Delete a folder's key file (used by remove-encryption). Swallows "not found". */
  async remove(folder: string): Promise<void> {
    try { await this.a.remove(this.keyPath(folder)); } catch { /* already gone */ }
  }

  // ---- crypto (pure; no session state) --------------------------------------

  /** Mint a fresh DEK, wrap it under `password`, and build the StashKey to persist.
   *  Returns the StashKey AND the raw DEK (caller caches it in the session, then
   *  should zero its copy when done). */
  async create(folder: string, password: string, keyId?: string): Promise<{ sk: StashKey; dek: Uint8Array }> {
    if (!password) throw new Error("Password required.");
    const dek = crypto.getRandomValues(new Uint8Array(DEK_LEN));
    const w = await encryptStash(dek, password);
    const sk: StashKey = {
      v: 1,
      keyId: keyId ?? newId(8),
      folderPath: folder.replace(/\/+$/, ""),
      slots: [{ id: newId(8), label: "Folder password", wrapped: b64(w.data), kdf: w.kdf, createdAt: iso() }],
      createdAt: iso(),
    };
    return { sk, dek };
  }

  /** Try every slot's wrap against `password`; return the DEK (caller owns/zeros)
   *  or null. Rejects a wrong-length unwrapped DEK rather than using garbage as an
   *  AES key (matches EncryptionService's guard). */
  async unlock(sk: StashKey, password: string): Promise<Uint8Array | null> {
    for (const slot of sk.slots) {
      try {
        const dek = await decryptStash(unb64(slot.wrapped), password);
        if (dek.length !== DEK_LEN) { dek.fill(0); continue; }
        return dek;
      } catch { /* wrong password for this slot — try the next */ }
    }
    return null;
  }

  /** Re-wrap the PRIMARY slot under a new password. Content is untouched — the DEK
   *  is unchanged, only its wrap changes (instant password change). The recovery
   *  slot, if any, is preserved (it still wraps the same DEK). */
  async changePassword(sk: StashKey, dek: Uint8Array, newPassword: string): Promise<StashKey> {
    if (!newPassword) throw new Error("Password required.");
    const w = await encryptStash(dek, newPassword);
    const others = sk.slots.filter((s) => s.recovery);
    const primary: StashKeySlot = { id: newId(8), label: "Folder password", wrapped: b64(w.data), kdf: w.kdf, createdAt: iso() };
    return { ...sk, slots: [primary, ...others] };
  }

  /** Add or replace the OPTIONAL recovery slot (a second password that unlocks the
   *  same DEK). Decision #2 in the plan — start with recovery, simplify later. */
  async setRecovery(sk: StashKey, dek: Uint8Array, recoveryPassword: string): Promise<StashKey> {
    if (!recoveryPassword) throw new Error("Recovery password required.");
    const w = await encryptStash(dek, recoveryPassword);
    const primary = sk.slots.filter((s) => !s.recovery);
    const rec: StashKeySlot = { id: newId(8), label: "Recovery password", wrapped: b64(w.data), kdf: w.kdf, createdAt: iso(), recovery: true };
    return { ...sk, slots: [...primary, rec] };
  }

  /** Drop the recovery slot (keeps only the primary password). */
  removeRecovery(sk: StashKey): StashKey {
    return { ...sk, slots: sk.slots.filter((s) => !s.recovery) };
  }

  hasRecovery(sk: StashKey): boolean {
    return sk.slots.some((s) => s.recovery);
  }
}
