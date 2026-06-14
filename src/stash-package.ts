import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { bytesToStr, unzipFiles, zipFiles, type ZipEntry } from "./zip";
import { newId } from "./id-service";
import { ROOT_ID, attachmentLinkPath, toAttachmentLink, type StashpadId } from "./types";

export const STASH_EXT = "stash";
export const SCHEMA_VERSION = 1;

/** 0.77.11 (security): collapse a ZIP entry name to a safe, single-segment
 *  filename — defends against zip-slip. A crafted .stash could contain
 *  entries like `attachments/../../../.obsidian/evil.js`; without this the
 *  `..` segments would let the write escape the destination folder (and
 *  potentially the vault). We keep only the final path segment and reject
 *  anything that's empty or still dot-only. Returns "" to signal "skip". */
export function safeZipEntryName(name: string): string {
  // Last segment after either separator; drops all directory components,
  // which also neutralises any `..` parts.
  const base = name.split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "";
  // Belt-and-suspenders: no separators or parent refs survive.
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return "";
  return trimmed;
}
const ATTACHMENT_LINK_RE = /!\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]/g;

export interface StashManifest {
  stashSchema: number;
  exportedAt: string;
  sourceFolder: string;
  noteCount: number;
  rootIds: StashpadId[];
  /** Optional hex→friendly-name map (e.g. from the web importer). Merged into
   *  the destination folder's color aliases on import so the names show in the
   *  plugin's color UI. Keys are lowercase `#rrggbb`. */
  colorAliases?: Record<string, string>;
}

export interface ExportInput {
  /** Notes to export. Children of these notes will be auto-included. */
  rootNotes: { id: StashpadId; file: TFile }[];
  /** Children-of-roots resolver (recursive walk handled by caller). */
  allDescendants: { id: StashpadId; file: TFile }[];
  /** Folder the source notes live in (for the manifest). */
  sourceFolder: string;
}

export interface ImportSummary {
  notesWritten: number;
  attachmentsWritten: number;
  collisionsRenamed: number;
  warnings: string[];
  /** Hex→name aliases from the manifest, for the caller to merge into the
   *  destination folder's color aliases (importStashZip has no settings access). */
  colorAliases?: Record<string, string>;
  /** Old id → new id mapping applied on import (identity for kept ids). Lets a
   *  caller (e.g. cross-folder paste) locate the written roots by their source id. */
  idRemap: Record<string, string>;
}

interface ParsedNote {
  originalName: string;
  fm: Record<string, any>;
  body: string;
}

// ---------------- Export ----------------

export async function buildStashZip(app: App, input: ExportInput): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  const allNotes = dedupeById([...input.rootNotes, ...input.allDescendants]);
  const collectedAtts = new Map<string, ArrayBuffer>(); // basename -> binary
  const warnings: string[] = [];

  for (const n of allNotes) {
    const md = await app.vault.read(n.file);
    let rewritten = md;
    const refs = extractAttachmentRefs(md);
    for (const ref of refs) {
      const af = app.metadataCache.getFirstLinkpathDest(ref, n.file.path);
      if (!af) {
        warnings.push(`Missing attachment "${ref}" in ${n.file.path}`);
        continue;
      }
      const basename = af.name;
      if (!collectedAtts.has(basename)) {
        collectedAtts.set(basename, await app.vault.readBinary(af));
      }
      // Rewrite: ![[some/path/foo.png]] -> ![[foo.png]]
      rewritten = rewriteAttachmentRef(rewritten, ref, basename);
    }
    // Also normalize attachments: list in frontmatter to bare basenames.
    rewritten = rewriteFrontmatterAttachmentList(rewritten, app, n.file.path);
    entries.push({ name: `notes/${n.file.name}`, data: rewritten });
  }

  for (const [name, buf] of collectedAtts) {
    entries.push({ name: `attachments/${name}`, data: buf });
  }

  const manifest: StashManifest = {
    stashSchema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceFolder: input.sourceFolder,
    noteCount: allNotes.length,
    rootIds: input.rootNotes.map((n) => n.id),
  };
  entries.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });

  if (warnings.length) {
    entries.push({ name: "warnings.txt", data: warnings.join("\n") });
  }

  return zipFiles(entries, 6);
}

// ---------------- Import ----------------

export async function importStashZip(
  app: App,
  buf: ArrayBuffer | Uint8Array,
  destFolder: string,
  existingIds: Set<StashpadId>,
  opts: { dedupeExisting?: boolean; forceNewIds?: boolean; reparentRootsTo?: StashpadId | null } = {},
): Promise<ImportSummary> {
  const zip = await unzipFiles(buf);
  const manifestBytes = zip["manifest.json"];
  if (!manifestBytes) throw new Error("Not a valid .stash package: missing manifest.json");
  const manifest = JSON.parse(bytesToStr(manifestBytes)) as StashManifest;
  if (typeof manifest.stashSchema !== "number" || manifest.stashSchema > SCHEMA_VERSION) {
    throw new Error(`Unsupported .stash schema: v${manifest.stashSchema}`);
  }

  await ensureFolder(app, destFolder);

  // Read all note entries.
  const noteEntries = Object.entries(zip).filter(
    ([name]) => name.startsWith("notes/") && name.endsWith(".md"),
  );
  const parsed: ParsedNote[] = [];
  for (const [name, bytes] of noteEntries) {
    const content = bytesToStr(bytes);
    const { fm, body } = splitFrontmatter(content);
    // Security: flatten to a safe single-segment name (zip-slip defense).
    // Fall back to the note id (or a generated name) if the entry name is
    // empty/traversal-only; a later collision check still de-dupes.
    const safeName = safeZipEntryName(name.slice("notes/".length))
      || `${(fm.id as string) || "imported-" + newId(4)}.md`;
    parsed.push({ originalName: safeName, fm, body });
  }

  // Build id remap (collision-aware).
  const idRemap = new Map<StashpadId, StashpadId>();
  let collisionsRenamed = 0;
  for (const p of parsed) {
    const oldId = p.fm.id as string | undefined;
    if (!oldId) continue;
    if (opts.forceNewIds) {
      idRemap.set(oldId, newId(6)); // cross-folder COPY → a fresh identity (not a same-id twin)
    } else if (existingIds.has(oldId) || idRemap.has(oldId) /* dup within zip */) {
      idRemap.set(oldId, `${oldId}-${newId(4)}-Imported`);
      collisionsRenamed++;
    } else {
      idRemap.set(oldId, oldId);
    }
  }

  const importDate = new Date().toISOString();
  const warnings: string[] = [];
  const attachmentsFolder = `${destFolder}/_attachments`;

  // Write attachments first so notes referencing them land on disk first.
  let attachmentsWritten = 0;
  const attEntries = Object.entries(zip).filter(
    ([name]) => name.startsWith("attachments/"),
  );
  // basename -> the path the note links should point at. We dedupe by CONTENT,
  // not just name: an existing same-named file is reused ONLY if its bytes match
  // (a real shared attachment). A same-named-but-DIFFERENT file is a genuine
  // collision — we write the bundled copy under a unique name (foo-1.png, foo-2…)
  // so the note links to the CORRECT content. (dedupeExisting widens the "already
  // here?" check to the whole vault, e.g. a shared original left in place on lock.)
  const attRoute = new Map<string, string>();
  let existingByName: Map<string, string> | null = null;
  if (opts.dedupeExisting) {
    existingByName = new Map();
    for (const tf of app.vault.getFiles()) {
      if (!existingByName.has(tf.name)) existingByName.set(tf.name, tf.path);
    }
  }
  const sameBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  let folderEnsured = false;
  for (const [name, bytes] of attEntries) {
    const basename = safeZipEntryName(name.slice("attachments/".length));
    if (!basename) continue;  // empty or traversal attempt → skip
    const zipBytes = bytes;
    // Candidate same-named files already on disk: a vault-wide match (unlock) and
    // the default _attachments slot. Reuse the first whose CONTENT is identical.
    const candidates: string[] = [];
    const vaultMatch = existingByName?.get(basename);
    if (vaultMatch) candidates.push(vaultMatch);
    const defaultPath = `${attachmentsFolder}/${basename}`;
    if (await app.vault.adapter.exists(defaultPath)) candidates.push(defaultPath);
    let reused: string | null = null;
    for (const cand of candidates) {
      try {
        if (sameBytes(new Uint8Array(await app.vault.adapter.readBinary(cand)), zipBytes)) { reused = cand; break; }
      } catch { /* unreadable candidate — fall through to writing a copy */ }
    }
    if (reused) { attRoute.set(basename, reused); continue; } // identical → reuse, no copy
    // Different content (or nothing on disk yet): write to a unique _attachments path.
    let destPath = defaultPath;
    for (let n = 1; await app.vault.adapter.exists(destPath); n++) destPath = `${attachmentsFolder}/${uniqueAttachmentName(basename, n)}`;
    attRoute.set(basename, destPath);
    if (!folderEnsured) { await ensureFolder(app, attachmentsFolder); folderEnsured = true; }
    await app.vault.createBinary(destPath, zipBytes.buffer as ArrayBuffer);
    attachmentsWritten++;
  }

  // Write notes with remapped ids/parents and import_date.
  let notesWritten = 0;
  for (const p of parsed) {
    const oldId = p.fm.id as string | undefined;
    if (!oldId) { warnings.push(`Skipped ${p.originalName} — no id in frontmatter`); continue; }
    const newIdVal = idRemap.get(oldId)!;

    const oldParent = (p.fm.parent ?? null) as string | null;
    let newParent: string | null = oldParent;
    if (!oldParent || oldParent === ROOT_ID) {
      // Top-level in the source → a bundle root. Honor reparentRootsTo (cross-
      // folder paste nests the pasted root where the cursor was); otherwise keep
      // it at ROOT as before.
      newParent = opts.reparentRootsTo ?? oldParent ?? ROOT_ID;
    } else if (idRemap.has(oldParent)) {
      newParent = idRemap.get(oldParent)!; // internal edge — remap to the moved parent
    } else {
      // Parent isn't in this bundle. If it already EXISTS in the destination
      // (e.g. UNLOCK: the locked subtree's parent stayed in the vault), keep the
      // link so nesting is restored; otherwise it's a bundle root → reparent/ROOT.
      newParent = existingIds.has(oldParent) ? oldParent : (opts.reparentRootsTo ?? ROOT_ID);
    }

    // Rewrite body: ![[basename]] -> ![[<routed path>]] (the _attachments copy,
    // or a reused existing file when deduping).
    const rewrittenBody = rewriteImportedAttachmentLinks(p.body, attRoute, attachmentsFolder);

    const newFm: Record<string, any> = {
      ...p.fm,
      id: newIdVal,
      parent: newParent,
      import_date: importDate,
    };
    if (Array.isArray(newFm.attachments)) {
      // 0.79.18: attachments may be wikilinks now — normalize to a path,
      // re-root into the export's attachments folder, re-wrap as a link.
      newFm.attachments = (newFm.attachments as string[]).map((a) => {
        const bn = baseFileName(attachmentLinkPath(a));
        return toAttachmentLink(attRoute.get(bn) ?? `${attachmentsFolder}/${bn}`);
      });
    }

    const finalContent = serializeNote(newFm, rewrittenBody);

    // Filename: prefer original; if id changed, replace short id suffix; if collision on disk, suffix.
    let outName = newIdVal === oldId ? p.originalName : remixFilename(p.originalName, oldId, newIdVal);
    let outPath = `${destFolder}/${outName}`;
    if (await app.vault.adapter.exists(outPath)) {
      const stem = outName.replace(/\.md$/, "");
      outName = `${stem}-${newId(4)}.md`;
      outPath = `${destFolder}/${outName}`;
    }
    await app.vault.create(outPath, finalContent);
    notesWritten++;
  }

  // Surface sanitized hex→name aliases (lowercase #rrggbb keys) for the caller
  // to merge into the destination folder's color settings.
  let colorAliases: Record<string, string> | undefined;
  if (manifest.colorAliases && typeof manifest.colorAliases === "object") {
    const clean: Record<string, string> = {};
    for (const [hex, name] of Object.entries(manifest.colorAliases)) {
      const h = String(hex).trim().toLowerCase();
      const n = String(name ?? "").trim();
      if (/^#([0-9a-f]{6})$/.test(h) && n) clean[h] = n.slice(0, 60);
    }
    if (Object.keys(clean).length) colorAliases = clean;
  }

  return { notesWritten, attachmentsWritten, collisionsRenamed, warnings, colorAliases, idRemap: Object.fromEntries(idRemap) };
}

// ---------------- Helpers ----------------

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

function extractAttachmentRefs(md: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  ATTACHMENT_LINK_RE.lastIndex = 0;
  while ((m = ATTACHMENT_LINK_RE.exec(md)) !== null) out.add(m[1]);
  return [...out];
}

/** Resolve the attachment files a note's body references — the SAME set the
 *  exporter bundles into the zip. Used by encryption to decide which attachment
 *  files are safe to trash on lock (they live inside the encrypted blob). */
export async function resolveNoteAttachmentFiles(app: App, file: TFile): Promise<TFile[]> {
  const md = await app.vault.read(file);
  const out: TFile[] = [];
  const seen = new Set<string>();
  for (const ref of extractAttachmentRefs(md)) {
    const af = app.metadataCache.getFirstLinkpathDest(ref, file.path);
    if (af && !seen.has(af.path)) { seen.add(af.path); out.push(af); }
  }
  return out;
}

function rewriteAttachmentRef(md: string, oldRef: string, basename: string): string {
  // Replace exactly inside ![[...]] occurrences only.
  return md.replace(new RegExp(`!\\[\\[${escapeRegex(oldRef)}(\\|[^\\]]+)?\\]\\]`, "g"),
    (_m, alias) => `![[${basename}${alias ?? ""}]]`);
}

/** Insert `-<n>` before the extension: `foo.png` + 2 -> `foo-2.png`. Used to give
 *  a same-named-but-different-content attachment a unique slot on unlock/import. */
function uniqueAttachmentName(basename: string, n: number): string {
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? `${basename.slice(0, dot)}-${n}${basename.slice(dot)}` : `${basename}-${n}`;
}

function rewriteImportedAttachmentLinks(body: string, attRoute: Map<string, string>, attachmentsFolder: string): string {
  return body.replace(ATTACHMENT_LINK_RE, (match, ref: string, _aliasRaw) => {
    // If ref already contains a slash, leave it alone (assume the importer wants a specific path).
    if (ref.includes("/")) return match;
    // Point at the routed path (reused existing file when deduping, else the
    // _attachments copy). Fall back to _attachments for a ref that wasn't bundled.
    const target = attRoute.get(ref) ?? `${attachmentsFolder}/${ref}`;
    return match.replace(ref, target);
  });
}

function rewriteFrontmatterAttachmentList(md: string, app: App, notePath: string): string {
  const split = splitFrontmatter(md);
  if (!split.fm.attachments || !Array.isArray(split.fm.attachments)) return md;
  const remapped = (split.fm.attachments as string[]).map((a) => {
    const af = app.metadataCache.getFirstLinkpathDest(a, notePath);
    return af ? af.name : baseFileName(a);
  });
  const newFm = { ...split.fm, attachments: remapped };
  return serializeNote(newFm, split.body);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function baseFileName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function remixFilename(originalName: string, oldId: string, newId: string): string {
  // Filenames look like "{slug}-{shortid}.md". Replace the trailing "-{oldId}" if present.
  if (originalName.includes(oldId)) return originalName.replace(oldId, newId);
  return originalName.replace(/\.md$/, `-${newId}.md`);
}

export function splitFrontmatter(content: string): { fm: Record<string, any>; body: string } {
  if (!content.startsWith("---")) return { fm: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, body: content };
  const yamlText = content.slice(3, end).replace(/^\n/, "");
  const after = content.slice(end + 4);
  let fm: Record<string, any> = {};
  try { fm = (parseYaml(yamlText) as Record<string, any>) ?? {}; } catch { fm = {}; }
  // Strip a leading newline from body if present.
  const body = after.startsWith("\n") ? after.slice(1) : after;
  return { fm, body };
}

export function serializeNote(fm: Record<string, any>, body: string): string {
  const yaml = stringifyYaml(fm).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path) return;
  const adapter = app.vault.adapter;
  if (await adapter.exists(path)) return;
  try {
    await app.vault.createFolder(path);
  } catch (e) {
    // Race-safe: adapter.exists can lag the actual FS state on plugin
    // reload. Swallow the "Folder already exists" throw; rethrow
    // anything else.
    const msg = (e as Error)?.message ?? "";
    if (!/already exists/i.test(msg)) throw e;
  }
}
