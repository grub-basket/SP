import { App, TFile } from "obsidian";
import { buildStashZip, importStashZip, splitFrontmatter, resolveNoteAttachmentFiles } from "./stash-package";
import { encryptWithKey, decryptWithKey, isEncryptedStash } from "./stash-crypto";
import { type StashpadId } from "./types";
import { unzipFiles, zipFiles } from "./zip";

/** In-vault locked-bundle extension (NOT `.stash` — `.stash` is an export to
 *  import; `.stashenc` is locked-in-place and must never auto-import). */
export const STASHENC_EXT = "stashenc";
/** Plaintext sidecar (`<blob>.stashmeta`) holding the placeholder metadata
 *  (parent/title/count/created/order). The durable source of truth for rendering
 *  the 🔒 stub in the right spot — survives a lost settings registry AND travels
 *  with the blob across devices. Never the note contents (those stay encrypted). */
export const STASHMETA_EXT = "stashmeta";
export interface LockedMeta { v: number; parentId: string | null; title: string; count: number; created: string; rootId: string; prevSibling: string | null; }
function sidecarPath(blobPath: string): string { return blobPath.replace(/\.stashenc$/, `.${STASHMETA_EXT}`); }
export async function readLockedMeta(app: App, blobPath: string): Promise<LockedMeta | null> {
  try { return JSON.parse(await app.vault.adapter.read(sidecarPath(blobPath))) as LockedMeta; }
  catch { return null; }
}

export interface LockResult {
  blobPath: string;
  noteCount: number;
  rootId: StashpadId;
  /** Parent id of the locked root, to anchor a placeholder later. */
  parentId: StashpadId | null;
  title: string;
  /** Root note's `created` — lets the placeholder slot back into list order. */
  created: string;
  /** Plaintext files that could NOT be removed (delete failed, or the file was
   *  edited after bundling). Non-empty = the lock succeeded but readable copies
   *  remain on disk — callers must warn the user loudly. */
  unpurged: string[];
}

interface SubtreeNode { id: StashpadId; file: TFile; parent: StashpadId | null; created: string; }

/** Collect a note + all its descendants within `folder` by walking frontmatter
 *  `parent` links. Returns the root note and the rest, plus the root's parent. */
export async function collectSubtree(app: App, folder: string, rootId: StashpadId): Promise<{
  rootNote: SubtreeNode; descendants: SubtreeNode[]; parentId: StashpadId | null;
} | null> {
  const cleaned = folder.replace(/\/+$/, "");
  const inFolder: SubtreeNode[] = [];
  // Read frontmatter from DISK, not metadataCache — the cache can lag right
  // after edits/imports, and an under-read here would bundle an INCOMPLETE
  // subtree (leaving children orphaned or stranded). Disk is authoritative.
  for (const f of app.vault.getMarkdownFiles()) {
    if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
    let fm: Record<string, unknown>;
    try { fm = splitFrontmatter(await app.vault.read(f)).fm; } catch { continue; }
    if (typeof fm.id !== "string") continue;
    inFolder.push({ id: fm.id, file: f, parent: typeof fm.parent === "string" ? fm.parent : null, created: typeof fm.created === "string" ? fm.created : "" });
  }
  const root = inFolder.find((n) => n.id === rootId);
  if (!root) return null;

  // BFS down the parent graph.
  const childrenOf = new Map<StashpadId, SubtreeNode[]>();
  for (const n of inFolder) {
    if (!n.parent) continue;
    const arr = childrenOf.get(n.parent) ?? [];
    arr.push(n); childrenOf.set(n.parent, arr);
  }
  const descendants: SubtreeNode[] = [];
  const seen = new Set<StashpadId>([rootId]);
  let frontier = [rootId];
  while (frontier.length) {
    const next: StashpadId[] = [];
    for (const id of frontier) {
      for (const c of childrenOf.get(id) ?? []) {
        if (seen.has(c.id)) continue; // cycle guard
        seen.add(c.id); descendants.push(c); next.push(c.id);
      }
    }
    frontier = next;
  }
  return { rootNote: root, descendants, parentId: root.parent };
}

/** Reject a sidecar/dest folder that could escape the vault (sidecars are
 *  plaintext JSON anyone can edit — a tampered `originalFolder` of `../..` or
 *  an absolute/drive path must never become a write destination). Returns the
 *  cleaned folder, or null if it's unsafe/empty. */
function safeVaultFolder(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\/+$/, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("/") || cleaned.includes("\\") || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return cleaned;
}

/** Write the encrypted blob, then READ IT BACK and byte-compare — the in-memory
 *  round-trip proves the encryption, but only this proves the bytes that landed
 *  on disk (network drives / sync clients can truncate or corrupt a write, and
 *  we permanently delete the plaintext right after). Removes a bad blob and
 *  throws so no plaintext is touched. */
async function writeBlobVerified(app: App, blobPath: string, blob: Uint8Array): Promise<void> {
  await app.vault.adapter.writeBinary(blobPath, blob as unknown as ArrayBuffer);
  let onDisk: Uint8Array;
  try { onDisk = new Uint8Array(await app.vault.adapter.readBinary(blobPath)); }
  catch (e) { throw new Error(`Couldn't read back the encrypted file to verify it (${(e as Error).message}). Nothing was deleted.`); }
  let ok = onDisk.length === blob.length;
  if (ok) for (let i = 0; i < blob.length; i++) { if (onDisk[i] !== blob[i]) { ok = false; break; } }
  if (!ok) {
    try { await app.vault.adapter.remove(blobPath); } catch { /* leave the bad blob; plaintext is intact */ }
    throw new Error("The encrypted file on disk doesn't match what was written (bad write?). Nothing was deleted.");
  }
}

function titleFromFile(file: TFile): string {
  return file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim() || file.basename;
}
function safeBlobBase(title: string): string {
  return (title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "locked").slice(0, 60);
}

/** PERMANENTLY delete a subtree's plaintext: the note files AND the attachments
 *  referenced ONLY by this subtree (shared ones are kept). The encrypted blob is
 *  the recoverable copy. We use `vault.delete`, NOT trashFile/trash — those honor
 *  the user's "Deleted files" setting and would leave a readable plaintext copy in
 *  the system trash OR the vault's `.trash/` (which can sync), defeating the
 *  encryption. Exclusivity is computed from the live `resolvedLinks` graph BEFORE
 *  anything is deleted (it needs the notes present). Shared by lock + delete-encrypt.
 *
 *  `mtimes` is each note's mtime captured when the bundle was BUILT: a file
 *  edited in the window between bundling and this purge (other pane, coworker
 *  on a shared drive, sync client) is NOT deleted — the blob holds the stale
 *  content and deleting would destroy the newer edit irreversibly. Skipped and
 *  failed deletions are returned so callers can warn loudly: a file we report
 *  as "locked" but couldn't remove is still readable plaintext on disk. */
async function purgeSubtreePlaintext(
  app: App, all: { file: TFile }[], mtimes?: Map<string, number>,
): Promise<{ unpurged: string[] }> {
  const subtreePaths = new Set(all.map((n) => n.file.path));
  const subtreeAtts = new Map<string, TFile>();
  for (const n of all) {
    for (const af of await resolveNoteAttachmentFiles(app, n.file)) subtreeAtts.set(af.path, af);
  }
  const sharedExternally = new Set<string>();
  const resolved = app.metadataCache.resolvedLinks ?? {};
  for (const notePath of Object.keys(resolved)) {
    if (subtreePaths.has(notePath)) continue; // a subtree note referencing it isn't "shared"
    for (const target of Object.keys(resolved[notePath] ?? {})) {
      if (subtreeAtts.has(target)) sharedExternally.add(target);
    }
  }
  const unpurged: string[] = [];
  for (const n of all) {
    const baseline = mtimes?.get(n.file.path);
    if (baseline != null) {
      try {
        const st = await app.vault.adapter.stat(n.file.path);
        if (st && st.mtime !== baseline) {
          console.warn("[Stashpad] note changed since it was bundled — keeping plaintext", n.file.path);
          unpurged.push(n.file.path);
          continue;
        }
      } catch { /* stat failed — fall through and let delete try */ }
    }
    try { await app.vault.delete(n.file); }
    catch (e) { console.warn("[Stashpad] couldn't delete plaintext note", n.file.path, e); unpurged.push(n.file.path); }
  }
  for (const [path, af] of subtreeAtts) {
    if (sharedExternally.has(path)) continue;
    try { await app.vault.delete(af); }
    catch (e) { console.warn("[Stashpad] couldn't delete exclusive attachment", path, e); unpurged.push(path); }
  }
  return { unpurged };
}

/** Lock a subtree into one `.stashenc` bundle, encrypted with `dek`. RAM-first:
 *  build + encrypt in memory, write the blob, **verify it round-trips**, and only
 *  THEN trash the plaintext note files. Returns info for a placeholder. */
export async function lockSubtree(
  app: App, folder: string, rootId: StashpadId, dek: Uint8Array, prevSibling: StashpadId | null = null,
  hideTitle = false, blobFolder?: string,
): Promise<LockResult> {
  const sub = await collectSubtree(app, folder, rootId);
  if (!sub) throw new Error("Couldn't find that note to lock.");
  const { rootNote, descendants, parentId } = sub;

  // Baseline mtimes BEFORE bundling — purge skips any file edited after this
  // point (its newer content isn't in the blob and must not be destroyed).
  const allNodes = [rootNote, ...descendants];
  const mtimes = new Map<string, number>();
  for (const n of allNodes) {
    try { const st = await app.vault.adapter.stat(n.file.path); if (st) mtimes.set(n.file.path, st.mtime); } catch { /* no baseline → delete proceeds unguarded */ }
  }

  const zip = await buildStashZip(app, {
    rootNotes: [{ id: rootNote.id, file: rootNote.file }],
    allDescendants: descendants.map((d) => ({ id: d.id, file: d.file })),
    sourceFolder: folder,
  });
  const blob = await encryptWithKey(zip, dek);

  // Verify the blob round-trips BEFORE destroying any plaintext — full byte
  // equality, not just length, since we PERMANENTLY delete the originals below
  // (the blob is the only surviving copy, so it must be provably decryptable).
  const back = await decryptWithKey(blob, dek);
  if (back.length !== zip.length) throw new Error("Encryption self-check failed (size mismatch).");
  for (let i = 0; i < zip.length; i++) {
    if (back[i] !== zip[i]) throw new Error("Encryption self-check failed (content mismatch).");
  }

  // Write the blob next to the originals (unique name) — or into `blobFolder`
  // when given (archive: read+delete from the source folder, but the encrypted
  // blob lives in the archive folder so the 🔒 stub appears there).
  const cleaned = (blobFolder ?? folder).replace(/\/+$/, "");
  if (blobFolder && !(await app.vault.adapter.exists(cleaned))) await app.vault.adapter.mkdir(cleaned);
  // When hiding titles, name the blob opaquely (by rootId) so the FILENAME doesn't
  // leak the note title on disk / in sync. Otherwise use a readable title-based name.
  const base = hideTitle ? safeBlobBase(rootId) : safeBlobBase(titleFromFile(rootNote.file));
  let blobPath = `${cleaned}/${base}.${STASHENC_EXT}`;
  for (let n = 1; await app.vault.adapter.exists(blobPath); n++) blobPath = `${cleaned}/${base} (${n}).${STASHENC_EXT}`;
  await writeBlobVerified(app, blobPath, blob);

  // Write the plaintext sidecar (placeholder metadata) BEFORE trashing originals.
  const all = allNodes;
  const meta: LockedMeta = {
    // Empty title when hiding — the real title lives ONLY inside the encrypted
    // blob. Placement uses parentId/rootId/prevSibling, so "" doesn't break it.
    v: 1, parentId, title: hideTitle ? "" : titleFromFile(rootNote.file), count: all.length,
    created: rootNote.created, rootId, prevSibling,
  };
  try { await app.vault.adapter.write(sidecarPath(blobPath), JSON.stringify(meta)); }
  catch (e) { console.warn("[Stashpad] couldn't write lock sidecar", e); }

  // Blob + sidecar written + verified byte-for-byte (in memory AND on disk) —
  // now PERMANENTLY delete the plaintext originals (notes + subtree-exclusive
  // attachments). The blob is the recoverable copy. See purgeSubtreePlaintext
  // for the why-not-trash rationale.
  const { unpurged } = await purgeSubtreePlaintext(app, all, mtimes);

  return { blobPath, noteCount: all.length, rootId, parentId, title: meta.title, created: rootNote.created, unpurged };
}

/** Unlock a `.stashenc` bundle back into a folder (decrypt → importStashZip), then
 *  remove the blob. Defaults to the blob's own folder; pass `destFolder` to restore
 *  elsewhere (e.g. archive-undo restores the blob back to its SOURCE folder). */
export async function unlockBundle(
  app: App, blobPath: string, dek: Uint8Array, existingIds: Set<StashpadId>, destFolder?: string,
): Promise<{ notesWritten: number; restoredTo: string }> {
  const blob = new Uint8Array(await app.vault.adapter.readBinary(blobPath));
  if (!isEncryptedStash(blob)) throw new Error("Not an encrypted bundle.");
  const zip = await decryptWithKey(blob, dek); // throws on wrong key / tampering
  // Current callers pass trusted blob-derived paths, but reject traversal /
  // absolute destinations anyway in case a future caller plumbs sidecar data.
  const folder = safeVaultFolder(destFolder) ?? blobPath.replace(/\/[^/]*$/, "");
  // dedupeExisting: a SHARED attachment's original wasn't trashed on lock, so
  // reuse it instead of writing a duplicate copy into _attachments on unlock.
  const summary = await importStashZip(app, zip, folder, existingIds, { dedupeExisting: true });
  await app.vault.adapter.remove(blobPath);
  try { await app.vault.adapter.remove(sidecarPath(blobPath)); } catch { /* sidecar may not exist */ }
  return { notesWritten: summary.notesWritten, restoredTo: folder };
}

// ---------------- Phase 5: encrypted trash (`_deleted/`) ----------------

/** Vault-level store for encrypted-deleted notes. Reserved + excluded from
 *  Stashpad/Obsidian scanning. The ONLY trash location Stashpad fully controls
 *  (vs the system/OS trash), so it can encrypt + list + restore from here. */
export const DELETED_DIR = "_deleted";
export interface DeletedMeta {
  /** "deleted" = a Stashpad note bundle (importStashZip on restore).
   *  "rawtrash" = a raw zip of Obsidian's `.trash/` tree from the backfill
   *  command (plain unzip back into `.trash/` on restore). */
  v: number; kind: "deleted" | "rawtrash";
  /** Folder the note was deleted FROM — where Restore puts it back. EMPTY when
   *  titles are hidden (the sidecar is plaintext; the origin would leak where a
   *  hidden note came from) — `originalFolderEnc` carries it instead. */
  originalFolder: string;
  /** Base64 of `encryptWithKey(utf8(originalFolder), dek)` — set when titles
   *  are hidden so Restore can still find the origin without leaking it. */
  originalFolderEnc?: string;
  parentId: string | null; title: string; count: number; created: string;
  rootId: string; deletedAt: string;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The restore destination for a deleted blob: plaintext `originalFolder`, or
 *  the encrypted one (hidden-titles delete) when a dek is at hand. Tampered /
 *  unsafe values are rejected (sidecars are editable plaintext). */
export async function deletedRestoreDest(app: App, blobPath: string, meta: DeletedMeta | null, dek?: Uint8Array): Promise<string> {
  let origin = safeVaultFolder(meta?.originalFolder);
  if (!origin && meta?.originalFolderEnc && dek) {
    try { origin = safeVaultFolder(new TextDecoder().decode(await decryptWithKey(b64ToBytes(meta.originalFolderEnc), dek))); }
    catch { origin = null; } // wrong key / tampered — fall back
  }
  if (origin) {
    // Recreate a missing origin folder rather than falling back: for trash
    // blobs the fallback would be `_deleted/` itself — decrypted plaintext
    // dumped INTO the (reserved, hidden-from-discovery) trash store, stranded.
    if (!(await app.vault.adapter.exists(origin))) await app.vault.adapter.mkdir(origin);
    return origin;
  }
  const blobDir = blobPath.replace(/\/[^/]*$/, "");
  if (blobDir === DELETED_DIR || blobDir.startsWith(`${DELETED_DIR}/`)) {
    throw new Error("This deleted note's origin folder is unknown (missing or tampered sidecar) — can't restore it safely. The encrypted copy was kept.");
  }
  return blobDir;
}

/** Is ANY `.stashenc` blob on disk? Walks the ADAPTER (not vault.getFiles) —
 *  adapter-written blobs can be invisible to the vault index for a while, and
 *  this backs the "Remove encryption" hard guard, which must never miss one.
 *  Skips `.obsidian/` only. */
export async function anyStashencOnDisk(app: App): Promise<boolean> {
  const queue = [""];
  while (queue.length) {
    const dir = queue.shift()!;
    let listing;
    try { listing = await app.vault.adapter.list(dir || "/"); } catch { continue; }
    if (listing.files.some((f) => f.endsWith(`.${STASHENC_EXT}`))) return true;
    for (const f of listing.folders) {
      if (f === ".obsidian" || f.endsWith("/.obsidian")) continue;
      queue.push(f);
    }
  }
  return false;
}

/** Encrypt-delete a subtree into `_deleted/` (recoverable, encrypted), then
 *  permanently delete the plaintext. Mirrors lockSubtree but the blob lives in the
 *  trash store + the sidecar records the original folder so Restore can put it
 *  back. `deletedAt` is passed in (callers stamp it — keeps this pure-ish). */
export async function deleteEncryptSubtree(
  app: App, folder: string, rootId: StashpadId, dek: Uint8Array, deletedAt: string, hideTitle = false,
): Promise<{ blobPath: string; noteCount: number; rootId: StashpadId; originalFolder: string; title: string; unpurged: string[] }> {
  const sub = await collectSubtree(app, folder, rootId);
  if (!sub) throw new Error("Couldn't find that note to delete.");
  const { rootNote, descendants, parentId } = sub;

  const allNodes = [rootNote, ...descendants];
  const mtimes = new Map<string, number>();
  for (const n of allNodes) {
    try { const st = await app.vault.adapter.stat(n.file.path); if (st) mtimes.set(n.file.path, st.mtime); } catch { /* no baseline */ }
  }

  const zip = await buildStashZip(app, {
    rootNotes: [{ id: rootNote.id, file: rootNote.file }],
    allDescendants: descendants.map((d) => ({ id: d.id, file: d.file })),
    sourceFolder: folder,
  });
  const blob = await encryptWithKey(zip, dek);
  // Byte-for-byte verify before deleting the only plaintext copy.
  const back = await decryptWithKey(blob, dek);
  if (back.length !== zip.length) throw new Error("Encryption self-check failed (size).");
  for (let i = 0; i < zip.length; i++) if (back[i] !== zip[i]) throw new Error("Encryption self-check failed (content).");

  if (!(await app.vault.adapter.exists(DELETED_DIR))) await app.vault.adapter.mkdir(DELETED_DIR);
  const cleanedFolder = folder.replace(/\/+$/, "");
  const folderSlug = cleanedFolder.split("/").pop() || "vault";
  // Readable name groups by folder; opaque (rootId) when hiding titles.
  const base = hideTitle ? safeBlobBase(rootId) : safeBlobBase(`${folderSlug} ${titleFromFile(rootNote.file)}`);
  let blobPath = `${DELETED_DIR}/${base}.${STASHENC_EXT}`;
  for (let n = 1; await app.vault.adapter.exists(blobPath); n++) blobPath = `${DELETED_DIR}/${base} (${n}).${STASHENC_EXT}`;
  await writeBlobVerified(app, blobPath, blob);

  const all = allNodes;
  // Hidden titles → the plaintext sidecar must not reveal the origin folder
  // either; store it encrypted instead (decrypted on restore with the dek).
  const meta: DeletedMeta = {
    v: 1, kind: "deleted",
    originalFolder: hideTitle ? "" : cleanedFolder,
    ...(hideTitle ? { originalFolderEnc: bytesToB64(await encryptWithKey(new TextEncoder().encode(cleanedFolder), dek)) } : {}),
    parentId,
    title: hideTitle ? "" : titleFromFile(rootNote.file), count: all.length,
    created: rootNote.created, rootId, deletedAt,
  };
  try { await app.vault.adapter.write(sidecarPath(blobPath), JSON.stringify(meta)); }
  catch (e) { console.warn("[Stashpad] couldn't write deleted sidecar", e); }

  const { unpurged } = await purgeSubtreePlaintext(app, all, mtimes);
  return { blobPath, noteCount: all.length, rootId, originalFolder: cleanedFolder, title: meta.title, unpurged };
}

/** Restore an encrypted-deleted bundle back into its ORIGINAL folder (from the
 *  sidecar), then remove the blob + sidecar. Falls back to the blob's own dir if
 *  the sidecar/originalFolder is missing. */
export async function restoreDeleted(
  app: App, blobPath: string, dek: Uint8Array, existingIds: Set<StashpadId>,
): Promise<{ notesWritten: number; restoredTo: string }> {
  const blob = new Uint8Array(await app.vault.adapter.readBinary(blobPath));
  if (!isEncryptedStash(blob)) throw new Error("Not an encrypted bundle.");
  const meta = await readDeletedMeta(app, blobPath);
  // Sanitized + decrypts the hidden-titles origin; tampered sidecar values
  // can't redirect decrypted plaintext outside the vault.
  const dest = await deletedRestoreDest(app, blobPath, meta, dek);
  const zip = await decryptWithKey(blob, dek);
  const summary = await importStashZip(app, zip, dest, existingIds, { dedupeExisting: true });
  await app.vault.adapter.remove(blobPath);
  try { await app.vault.adapter.remove(sidecarPath(blobPath)); } catch { /* may not exist */ }
  return { notesWritten: summary.notesWritten, restoredTo: dest };
}

export async function readDeletedMeta(app: App, blobPath: string): Promise<DeletedMeta | null> {
  try { return JSON.parse(await app.vault.adapter.read(sidecarPath(blobPath))) as DeletedMeta; }
  catch { return null; }
}

// ------- v2 backfill: encrypt Obsidian's pre-existing plaintext trash -------

/** Obsidian's in-vault trash folder ("Deleted files" → "Move to vault trash"). */
export const OBSIDIAN_TRASH_DIR = ".trash";

async function listFilesRecursive(app: App, dir: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [dir];
  while (queue.length) {
    const d = queue.shift()!;
    let listing;
    try { listing = await app.vault.adapter.list(d); } catch { continue; }
    out.push(...listing.files);
    queue.push(...listing.folders);
  }
  return out;
}

/** A `.trash/` zip entry's relative path, validated segment-by-segment (the
 *  blob could be tampered with like any sidecar — never let an entry escape
 *  `.trash/`). Returns null for unsafe names. */
function safeTrashRelPath(name: string): string | null {
  const segs = name.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  for (const s of segs) {
    if (s === ".." || s === "." || s.includes("\\") || /^[a-zA-Z]:/.test(s)) return null;
  }
  return segs.join("/");
}

/** v2 backfill ("Encrypt existing trash"): sweep everything in Obsidian's
 *  plaintext `.trash/` into ONE encrypted blob in `_deleted/`, then permanently
 *  remove the plaintext. `.trash` contents are arbitrary files (not Stashpad
 *  bundles), so the blob is a RAW zip of the tree, marked kind:"rawtrash";
 *  restore unzips it back into `.trash/`. Same safety rails as lock: read-back
 *  blob verify before any delete, mtime guard, unpurged reporting. Returns
 *  null when `.trash/` has nothing in it. */
export async function backfillTrashEncrypt(
  app: App, dek: Uint8Array, deletedAt: string, hideTitle = false,
): Promise<{ blobPath: string; fileCount: number; unpurged: string[] } | null> {
  if (!(await app.vault.adapter.exists(OBSIDIAN_TRASH_DIR))) return null;
  const files = await listFilesRecursive(app, OBSIDIAN_TRASH_DIR);
  if (files.length === 0) return null;

  const zipEntries: { name: string; data: ArrayBuffer }[] = [];
  const mtimes = new Map<string, number>();
  for (const path of files) {
    const rel = path.slice(OBSIDIAN_TRASH_DIR.length + 1);
    zipEntries.push({ name: `files/${rel}`, data: await app.vault.adapter.readBinary(path) });
    try { const st = await app.vault.adapter.stat(path); if (st) mtimes.set(path, st.mtime); } catch { /* no baseline */ }
  }
  const zipBytes = await zipFiles(zipEntries);
  const blob = await encryptWithKey(zipBytes, dek);
  const back = await decryptWithKey(blob, dek);
  if (back.length !== zipBytes.length) throw new Error("Encryption self-check failed (size).");
  for (let i = 0; i < zipBytes.length; i++) if (back[i] !== zipBytes[i]) throw new Error("Encryption self-check failed (content).");

  if (!(await app.vault.adapter.exists(DELETED_DIR))) await app.vault.adapter.mkdir(DELETED_DIR);
  const base = hideTitle ? safeBlobBase(`trash-${deletedAt.replace(/[^0-9]/g, "").slice(0, 14)}`) : safeBlobBase("Obsidian trash backfill");
  let blobPath = `${DELETED_DIR}/${base}.${STASHENC_EXT}`;
  for (let n = 1; await app.vault.adapter.exists(blobPath); n++) blobPath = `${DELETED_DIR}/${base} (${n}).${STASHENC_EXT}`;
  await writeBlobVerified(app, blobPath, blob);

  const meta: DeletedMeta = {
    v: 1, kind: "rawtrash", originalFolder: OBSIDIAN_TRASH_DIR, parentId: null,
    title: hideTitle ? "" : "Obsidian trash (backfill)", count: files.length,
    created: deletedAt, rootId: "", deletedAt,
  };
  try { await app.vault.adapter.write(sidecarPath(blobPath), JSON.stringify(meta)); }
  catch (e) { console.warn("[Stashpad] couldn't write backfill sidecar", e); }

  // Permanently remove the plaintext trash files (same rationale + rails as
  // purgeSubtreePlaintext — but these aren't TFiles, so adapter.remove).
  const unpurged: string[] = [];
  for (const path of files) {
    const baseline = mtimes.get(path);
    try {
      if (baseline != null) {
        const st = await app.vault.adapter.stat(path);
        if (st && st.mtime !== baseline) { unpurged.push(path); continue; }
      }
      await app.vault.adapter.remove(path);
    } catch (e) { console.warn("[Stashpad] couldn't delete trash file", path, e); unpurged.push(path); }
  }
  return { blobPath, fileCount: files.length, unpurged };
}

/** Restore a kind:"rawtrash" blob: decrypt + unzip back into `.trash/`, then
 *  remove the blob + sidecar. Existing files are never overwritten (suffix). */
export async function restoreRawTrash(app: App, blobPath: string, dek: Uint8Array): Promise<{ filesWritten: number }> {
  const blob = new Uint8Array(await app.vault.adapter.readBinary(blobPath));
  if (!isEncryptedStash(blob)) throw new Error("Not an encrypted bundle.");
  const zipBytes = await decryptWithKey(blob, dek);
  const zip = await unzipFiles(zipBytes);
  let written = 0;
  for (const [name, entry] of Object.entries(zip)) {
    if (!name.startsWith("files/")) continue;
    const rel = safeTrashRelPath(name.slice("files/".length));
    if (!rel) { console.warn("[Stashpad] skipped unsafe trash entry", name); continue; }
    const dir = `${OBSIDIAN_TRASH_DIR}/${rel}`.split("/").slice(0, -1).join("/");
    let cur = "";
    for (const seg of dir.split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!(await app.vault.adapter.exists(cur))) await app.vault.adapter.mkdir(cur);
    }
    let dest = `${OBSIDIAN_TRASH_DIR}/${rel}`;
    for (let n = 1; await app.vault.adapter.exists(dest); n++) {
      dest = `${OBSIDIAN_TRASH_DIR}/${rel.replace(/(\.[^./]*)?$/, ` (${n})$1`)}`;
    }
    await app.vault.adapter.writeBinary(dest, entry.buffer as ArrayBuffer);
    written++;
  }
  await app.vault.adapter.remove(blobPath);
  try { await app.vault.adapter.remove(sidecarPath(blobPath)); } catch { /* may not exist */ }
  return { filesWritten: written };
}

/** All encrypted-deleted blob paths in `_deleted/`. */
export async function listDeletedBlobs(app: App): Promise<string[]> {
  if (!(await app.vault.adapter.exists(DELETED_DIR))) return [];
  try {
    const listing = await app.vault.adapter.list(DELETED_DIR);
    return listing.files.filter((f) => f.endsWith(`.${STASHENC_EXT}`));
  } catch { return []; }
}
