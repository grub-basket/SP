import { App, TFile } from "obsidian";
import { buildStashZip, importStashZip, splitFrontmatter, resolveNoteAttachmentFiles } from "./stash-package";
import { encryptWithKey, decryptWithKey, isEncryptedStash } from "./stash-crypto";
import { type StashpadId } from "./types";

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
}

interface SubtreeNode { id: StashpadId; file: TFile; parent: StashpadId | null; created: string; }

/** Collect a note + all its descendants within `folder` by walking frontmatter
 *  `parent` links. Returns the root note and the rest, plus the root's parent. */
async function collectSubtree(app: App, folder: string, rootId: StashpadId): Promise<{
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
 *  anything is deleted (it needs the notes present). Shared by lock + delete-encrypt. */
async function purgeSubtreePlaintext(app: App, all: { file: TFile }[]): Promise<void> {
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
  for (const n of all) {
    try { await app.vault.delete(n.file); }
    catch (e) { console.warn("[Stashpad] couldn't delete plaintext note", n.file.path, e); }
  }
  for (const [path, af] of subtreeAtts) {
    if (sharedExternally.has(path)) continue;
    try { await app.vault.delete(af); }
    catch (e) { console.warn("[Stashpad] couldn't delete exclusive attachment", path, e); }
  }
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
  await app.vault.adapter.writeBinary(blobPath, blob as unknown as ArrayBuffer);

  // Write the plaintext sidecar (placeholder metadata) BEFORE trashing originals.
  const all = [rootNote, ...descendants];
  const meta: LockedMeta = {
    // Empty title when hiding — the real title lives ONLY inside the encrypted
    // blob. Placement uses parentId/rootId/prevSibling, so "" doesn't break it.
    v: 1, parentId, title: hideTitle ? "" : titleFromFile(rootNote.file), count: all.length,
    created: rootNote.created, rootId, prevSibling,
  };
  try { await app.vault.adapter.write(sidecarPath(blobPath), JSON.stringify(meta)); }
  catch (e) { console.warn("[Stashpad] couldn't write lock sidecar", e); }

  // Blob + sidecar written + verified byte-for-byte — now PERMANENTLY delete the
  // plaintext originals (notes + subtree-exclusive attachments). The blob is the
  // recoverable copy. See purgeSubtreePlaintext for the why-not-trash rationale.
  await purgeSubtreePlaintext(app, all);

  return { blobPath, noteCount: all.length, rootId, parentId, title: meta.title, created: rootNote.created };
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
  const folder = (destFolder ?? blobPath.replace(/\/[^/]*$/, "")).replace(/\/+$/, "");
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
  v: number; kind: "deleted";
  /** Folder the note was deleted FROM — where Restore puts it back. */
  originalFolder: string;
  parentId: string | null; title: string; count: number; created: string;
  rootId: string; deletedAt: string;
}

/** Encrypt-delete a subtree into `_deleted/` (recoverable, encrypted), then
 *  permanently delete the plaintext. Mirrors lockSubtree but the blob lives in the
 *  trash store + the sidecar records the original folder so Restore can put it
 *  back. `deletedAt` is passed in (callers stamp it — keeps this pure-ish). */
export async function deleteEncryptSubtree(
  app: App, folder: string, rootId: StashpadId, dek: Uint8Array, deletedAt: string, hideTitle = false,
): Promise<{ blobPath: string; noteCount: number; rootId: StashpadId; originalFolder: string; title: string }> {
  const sub = await collectSubtree(app, folder, rootId);
  if (!sub) throw new Error("Couldn't find that note to delete.");
  const { rootNote, descendants, parentId } = sub;

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
  await app.vault.adapter.writeBinary(blobPath, blob as unknown as ArrayBuffer);

  const all = [rootNote, ...descendants];
  const meta: DeletedMeta = {
    v: 1, kind: "deleted", originalFolder: cleanedFolder, parentId,
    title: hideTitle ? "" : titleFromFile(rootNote.file), count: all.length,
    created: rootNote.created, rootId, deletedAt,
  };
  try { await app.vault.adapter.write(sidecarPath(blobPath), JSON.stringify(meta)); }
  catch (e) { console.warn("[Stashpad] couldn't write deleted sidecar", e); }

  await purgeSubtreePlaintext(app, all);
  return { blobPath, noteCount: all.length, rootId, originalFolder: cleanedFolder, title: meta.title };
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
  const dest = meta?.originalFolder && await app.vault.adapter.exists(meta.originalFolder)
    ? meta.originalFolder
    : blobPath.replace(/\/[^/]*$/, "");
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

/** All encrypted-deleted blob paths in `_deleted/`. */
export async function listDeletedBlobs(app: App): Promise<string[]> {
  if (!(await app.vault.adapter.exists(DELETED_DIR))) return [];
  try {
    const listing = await app.vault.adapter.list(DELETED_DIR);
    return listing.files.filter((f) => f.endsWith(`.${STASHENC_EXT}`));
  } catch { return []; }
}
