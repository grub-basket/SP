import JSZip from "jszip";
import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { newId } from "./id-service";
import { ROOT_ID, type StashpadId } from "./types";

export const STASH_EXT = "stash";
export const SCHEMA_VERSION = 1;
const ATTACHMENT_LINK_RE = /!\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]/g;

export interface StashManifest {
  stashSchema: number;
  exportedAt: string;
  sourceFolder: string;
  noteCount: number;
  rootIds: StashpadId[];
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
}

interface ParsedNote {
  originalName: string;
  fm: Record<string, any>;
  body: string;
}

// ---------------- Export ----------------

export async function buildStashZip(app: App, input: ExportInput): Promise<Uint8Array> {
  const zip = new JSZip();
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
    zip.file(`notes/${n.file.name}`, rewritten);
  }

  for (const [name, buf] of collectedAtts) {
    zip.file(`attachments/${name}`, buf);
  }

  const manifest: StashManifest = {
    stashSchema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceFolder: input.sourceFolder,
    noteCount: allNotes.length,
    rootIds: input.rootNotes.map((n) => n.id),
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  if (warnings.length) {
    zip.file("warnings.txt", warnings.join("\n"));
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

// ---------------- Import ----------------

export async function importStashZip(
  app: App,
  buf: ArrayBuffer | Uint8Array,
  destFolder: string,
  existingIds: Set<StashpadId>,
): Promise<ImportSummary> {
  const zip = await JSZip.loadAsync(buf as any);
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("Not a valid .stash package: missing manifest.json");
  const manifest = JSON.parse(await manifestFile.async("string")) as StashManifest;
  if (typeof manifest.stashSchema !== "number" || manifest.stashSchema > SCHEMA_VERSION) {
    throw new Error(`Unsupported .stash schema: v${manifest.stashSchema}`);
  }

  await ensureFolder(app, destFolder);

  // Read all note entries.
  const noteEntries = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.startsWith("notes/") && f.name.endsWith(".md"),
  );
  const parsed: ParsedNote[] = [];
  for (const f of noteEntries) {
    const content = await f.async("string");
    const { fm, body } = splitFrontmatter(content);
    parsed.push({ originalName: f.name.slice("notes/".length), fm, body });
  }

  // Build id remap (collision-aware).
  const idRemap = new Map<StashpadId, StashpadId>();
  let collisionsRenamed = 0;
  for (const p of parsed) {
    const oldId = p.fm.id as string | undefined;
    if (!oldId) continue;
    if (existingIds.has(oldId) || idRemap.has(oldId) /* dup within zip */) {
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
  const attEntries = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.startsWith("attachments/"),
  );
  if (attEntries.length > 0) await ensureFolder(app, attachmentsFolder);
  for (const f of attEntries) {
    const basename = f.name.slice("attachments/".length);
    if (!basename) continue;
    const destPath = `${attachmentsFolder}/${basename}`;
    if (await app.vault.adapter.exists(destPath)) continue; // dedup by name
    const buf = await f.async("arraybuffer");
    await app.vault.createBinary(destPath, buf);
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
    if (oldParent && oldParent !== ROOT_ID && idRemap.has(oldParent)) {
      newParent = idRemap.get(oldParent)!;
    } else if (oldParent && oldParent !== ROOT_ID && !idRemap.has(oldParent)) {
      // Parent isn't part of this export — pin to ROOT for safety.
      newParent = ROOT_ID;
    }

    // Rewrite body: ![[basename]] -> ![[<attachmentsFolder>/basename]]
    const rewrittenBody = rewriteImportedAttachmentLinks(p.body, attachmentsFolder);

    const newFm: Record<string, any> = {
      ...p.fm,
      id: newIdVal,
      parent: newParent,
      import_date: importDate,
    };
    if (Array.isArray(newFm.attachments)) {
      newFm.attachments = (newFm.attachments as string[]).map((a) =>
        `${attachmentsFolder}/${baseFileName(a)}`,
      );
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

  return { notesWritten, attachmentsWritten, collisionsRenamed, warnings };
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

function rewriteAttachmentRef(md: string, oldRef: string, basename: string): string {
  // Replace exactly inside ![[...]] occurrences only.
  return md.replace(new RegExp(`!\\[\\[${escapeRegex(oldRef)}(\\|[^\\]]+)?\\]\\]`, "g"),
    (_m, alias) => `![[${basename}${alias ?? ""}]]`);
}

function rewriteImportedAttachmentLinks(body: string, attachmentsFolder: string): string {
  return body.replace(ATTACHMENT_LINK_RE, (match, ref: string, _aliasRaw) => {
    // If ref already contains a slash, leave it alone (assume the importer wants a specific path).
    if (ref.includes("/")) return match;
    return match.replace(ref, `${attachmentsFolder}/${ref}`);
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

function splitFrontmatter(content: string): { fm: Record<string, any>; body: string } {
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

function serializeNote(fm: Record<string, any>, body: string): string {
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
