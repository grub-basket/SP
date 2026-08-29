import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { bytesToStr, unzipFiles, zipFiles, type ZipEntry } from "./zip";
import { newId } from "./id-service";
import { ROOT_ID, RESERVED_FRONTMATTER, attachmentLinkPath, toAttachmentLink, type StashpadId } from "./types";

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
// 0.209.1: the lookahead requires a non-space target, so `![[  ]]` is not
// collected as an attachment named "  " (which then failed to resolve and
// emitted a spurious "Missing attachment" warning on every export).
// 0.211.4 (F1): `[` is excluded from every class so a run of unterminated `![[`
// can't be rescanned quadratically. Previously each `![[` position scanned forward
// to the next `]`, so a note full of `![[` cost O(n²): measured 754ms at 60KB,
// 12.1s at 240KB, a clean 4x per doubling — an outright freeze on the main thread
// during export/import, reachable from any note body. Excluding `[` bounds each
// attempt at the next bracket, which makes it linear (960KB: 3ms). This is also
// strictly more correct, since an Obsidian link target cannot contain `[` or `]`;
// verified behaviour-identical to the old pattern across the alias, space, path,
// empty-target and adjacent-link cases.
const ATTACHMENT_LINK_RE = /!\[\[(?=[^[\]|]*[^\s[\]|])([^[\]|]+)(?:\|[^[\]]+)?\]\]/g;

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
  /** 0.277.0: plaintext companion/sidecar files (e.g. Edit History's `.edtz`)
   *  bundled ALONGSIDE their owning note so encryption doesn't leave them
   *  readable on disk. Each record maps a stored `companions/<i>` entry to the
   *  note it belongs to (`noteStem` = the note's zip-entry basename) and carries
   *  the companion's original filename so unlock can re-pair it by extension.
   *  Only populated on encryption paths (notes carry a `companions` list); plain
   *  exports never set it. */
  companions?: { i: number; noteStem: string; name: string }[];
}

export interface ExportInput {
  /** Notes to export. Children of these notes will be auto-included.
   *  `companions` (0.277.0) are plaintext sidecars for that note (resolved by the
   *  caller) that ride INSIDE the bundle so encryption protects them too. */
  rootNotes: { id: StashpadId; file: TFile; companions?: TFile[] }[];
  /** Children-of-roots resolver (recursive walk handled by caller). */
  allDescendants: { id: StashpadId; file: TFile; companions?: TFile[] }[];
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
  /** 0.201.0: vault paths of every note file this import wrote, in write
   *  order. The authoritative list for undo — the tree/metadata cache lags
   *  fresh creates, so deriving paths from it can silently miss files. */
  notePaths: string[];
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
  const collectedAtts = new Map<string, ArrayBuffer>(); // BUNDLE name -> binary
  // 0.211.4 (F2): identity is the vault PATH, not the basename. Two distinct
  // attachments can share a name in different folders (Assets/A/diagram.png and
  // Assets/B/diagram.png); keying the bundle by basename dropped the second and
  // rewrote BOTH notes' links to the one name, so the second note silently
  // rendered the first note's image and the real file never left the vault.
  // Distinct paths now get distinct bundle names, disambiguated on collision, and
  // each note's link is rewritten to the name its own file actually got.
  const attBundleName = new Map<string, string>(); // vault path -> bundle name
  const takenAttNames = new Set<string>();
  const bundleNameFor = (af: TFile): string => {
    const existing = attBundleName.get(af.path);
    if (existing) return existing;
    let name = af.name;
    for (let i = 2; takenAttNames.has(name); i++) name = uniqueAttachmentName(af.name, i);
    takenAttNames.add(name);
    attBundleName.set(af.path, name);
    return name;
  };
  const warnings: string[] = [];
  const usedNoteNames = new Set<string>();
  // 0.277.0: companion sidecars are collected as we walk notes and appended after
  // the attachments so their `companions/<i>` indices are stable.
  const companionEntries: ZipEntry[] = [];
  const companionManifest: { i: number; noteStem: string; name: string }[] = [];

  for (const n of allNotes) {
    const md = await app.vault.read(n.file);
    let rewritten = md;
    const refs = extractAttachmentRefs(md);
    for (const ref of refs) {
      // 0.209.0: defensive path fallback, NOT a fix for a demonstrated bug.
      // Trynalist's rendering notes report that getFirstLinkpathDest misses a
      // full path with a non-markdown extension; measured against Obsidian
      // 1.13.2 that is NOT true — it resolved "Alpha/Assets/diagram.png",
      // "/Alpha/...", mismatched case and embedded spaces, and the shapes it did
      // miss ("./x.png", "%20"-encoded) miss the path lookup too, so the fallback
      // never changed an outcome in testing. Kept because it costs nothing and
      // does cover the one case linkpath resolution genuinely can't: a file the
      // metadata cache has not indexed yet. Do not read this as "there was a
      // bug here".
      // getAbstractFileByPath can hand back a FOLDER, so narrow before using it
      // as an attachment (the compiler caught this — a folder would otherwise
      // have been zipped as if it were a file).
      const byPath = app.vault.getAbstractFileByPath(ref);
      const af = app.metadataCache.getFirstLinkpathDest(ref, n.file.path)
        ?? (byPath instanceof TFile ? byPath : null);
      if (!af) {
        warnings.push(`Missing attachment "${ref}" in ${n.file.path}`);
        continue;
      }
      const basename = bundleNameFor(af);
      if (!collectedAtts.has(basename)) {
        collectedAtts.set(basename, await app.vault.readBinary(af));
      }
      // Rewrite: ![[some/path/foo.png]] -> ![[foo.png]] (or foo-2.png if another
      // file already claimed that name in this bundle).
      rewritten = rewriteAttachmentRef(rewritten, ref, basename);
    }
    // Also normalize attachments: list in frontmatter to bare basenames.
    rewritten = rewriteFrontmatterAttachmentList(rewritten, app, n.file.path, bundleNameFor);
    // 0.211.8: flat, collision-free entry names — the same guard buildFilteredZip has.
    // A subtree can span nested folders, so two notes CAN share a filename; without
    // this, the second entry overwrites the first in the zip and that note is simply
    // absent from the bundle. Not reachable today (Stashpad's own filenames carry a
    // unique id suffix), but the export accepts whatever is on disk and the cost of
    // being wrong here is a silently missing note.
    let entryName = n.file.name;
    while (usedNoteNames.has(entryName)) entryName = `${n.file.basename}-${newId(4)}.md`;
    usedNoteNames.add(entryName);
    entries.push({ name: `notes/${entryName}`, data: rewritten });

    // 0.277.0: bundle this note's plaintext companions (resolved by the caller —
    // encryption paths only). Each rides as an opaque `companions/<i>` binary; the
    // manifest keeps the note-entry stem + original filename so unlock can re-pair
    // it to the (possibly renamed) note and restore it by extension.
    for (const cf of n.companions ?? []) {
      const idx = companionEntries.length;
      companionEntries.push({ name: `companions/${idx}`, data: await app.vault.readBinary(cf) });
      companionManifest.push({ i: idx, noteStem: entryName.replace(/\.md$/, ""), name: cf.name });
    }
  }

  for (const [name, buf] of collectedAtts) {
    entries.push({ name: `attachments/${name}`, data: buf });
  }
  for (const e of companionEntries) entries.push(e);

  const manifest: StashManifest = {
    stashSchema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceFolder: input.sourceFolder,
    noteCount: allNotes.length,
    rootIds: input.rootNotes.map((n) => n.id),
    ...(companionManifest.length ? { companions: companionManifest } : {}),
  };
  entries.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });

  if (warnings.length) {
    entries.push({ name: "warnings.txt", data: warnings.join("\n") });
  }

  return zipFiles(entries, 6);
}

/** 0.167.0: build a PLAIN .zip (no manifest, not re-importable) of the given
 *  notes, filtered by ExportContent, WITH their referenced attachments. Reuses
 *  buildStashZip's attachment collection + link-rewrite so `![[path]]` becomes
 *  `![[basename]]` and the binaries ride along under `attachments/`. Frontmatter-
 *  only skips attachments (no body → nothing to view). Notes land under `notes/`. */
export async function buildFilteredZip(
  app: App,
  notes: { file: TFile }[],
  content: ExportContent,
): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  const collectedAtts = new Map<string, ArrayBuffer>();
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  // 0.211.4 (F2): same path-vs-basename identity fix as buildStashZip above —
  // two attachments sharing a name in different folders must not collapse into one
  // bundle entry, silently giving the second note the first note's file.
  const attBundleName = new Map<string, string>();
  const takenAttNames = new Set<string>();
  const bundleNameFor = (af: TFile): string => {
    const existing = attBundleName.get(af.path);
    if (existing) return existing;
    let name = af.name;
    for (let i = 2; takenAttNames.has(name); i++) name = uniqueAttachmentName(af.name, i);
    takenAttNames.add(name);
    attBundleName.set(af.path, name);
    return name;
  };

  for (const n of notes) {
    let md = await app.vault.read(n.file);
    // Collect + rewrite attachments before filtering (frontmatter-only has no
    // body to reference them, so skip that case).
    if (content !== "frontmatter") {
      for (const ref of extractAttachmentRefs(md)) {
        const af = app.metadataCache.getFirstLinkpathDest(ref, n.file.path);
        if (!af) { warnings.push(`Missing attachment "${ref}" in ${n.file.path}`); continue; }
        const basename = bundleNameFor(af);
        if (!collectedAtts.has(basename)) collectedAtts.set(basename, await app.vault.readBinary(af));
        md = rewriteAttachmentRef(md, ref, basename);
      }
      md = rewriteFrontmatterAttachmentList(md, app, n.file.path, bundleNameFor);
    }
    const data = filterNoteContent(md, content);
    // Flat, collision-free filenames (the subtree may span nested folders).
    let name = n.file.name;
    while (usedNames.has(name)) name = `${n.file.basename}-${newId(4)}.md`;
    usedNames.add(name);
    entries.push({ name: `notes/${name}`, data });
  }

  for (const [name, buf] of collectedAtts) entries.push({ name: `attachments/${name}`, data: buf });
  if (warnings.length) entries.push({ name: "warnings.txt", data: warnings.join("\n") });
  return zipFiles(entries, 6);
}

// ---------------- Import ----------------

export async function importStashZip(
  app: App,
  buf: ArrayBuffer | Uint8Array,
  destFolder: string,
  existingIds: Set<StashpadId>,
  opts: { dedupeExisting?: boolean; forceNewIds?: boolean; reparentRootsTo?: StashpadId | null; stripReserved?: boolean } = {},
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
    // Defense-in-depth: run the id fallback through safeZipEntryName too, so a
    // future change to the note-entry filter can't let an attacker-controlled
    // YAML `id` (e.g. "../../evil") escape the destination. Today the fallback
    // is unreachable (note entries always end in .md), but don't rely on that.
    const safeName = safeZipEntryName(name.slice("notes/".length))
      || safeZipEntryName(`${(fm.id as string) || "imported-" + newId(4)}.md`)
      || `imported-${newId(4)}.md`;
    parsed.push({ originalName: safeName, fm, body });
  }

  // Build id remap (collision-aware).
  const idRemap = new Map<StashpadId, StashpadId>();
  // 0.211.4 (F3): the assignment must be per NOTE, not per old id. A bundle can
  // legitimately contain two notes carrying the same `id` (hand-edited frontmatter, a
  // bundle concatenated from two exports, a duplicated file). Keyed only by old id,
  // the second note OVERWROTE the first's entry, so both were then written with the
  // SAME new id — an id collision in the destination folder, where the tree keys by
  // id and one of the two notes becomes unreachable. Each parsed note now gets its
  // own identity, checked against ids already taken on disk AND ids handed out
  // earlier in this same import.
  const assigned = new Map<ParsedNote, StashpadId>();
  const takenIds = new Set<StashpadId>(existingIds);
  const claim = (candidate: StashpadId, oldId: StashpadId): StashpadId => {
    let id = candidate;
    while (takenIds.has(id)) id = `${oldId}-${newId(4)}-Imported`;
    takenIds.add(id);
    return id;
  };
  let collisionsRenamed = 0;
  for (const p of parsed) {
    const oldId = p.fm.id as string | undefined;
    if (!oldId) continue;
    let newIdVal: StashpadId;
    if (opts.forceNewIds) {
      newIdVal = claim(newId(6), oldId); // cross-folder COPY → a fresh identity (not a same-id twin)
    } else if (takenIds.has(oldId)) {
      newIdVal = claim(`${oldId}-${newId(4)}-Imported`, oldId);
      collisionsRenamed++;
    } else {
      newIdVal = claim(oldId, oldId);
    }
    assigned.set(p, newIdVal);
    // The returned map stays old→new for the caller's root lookup and for parent
    // remapping below. With a duplicated old id the parent link is ambiguous by
    // construction, so first-wins: don't let a later duplicate silently reparent the
    // children of the earlier note.
    if (!idRemap.has(oldId)) idRemap.set(oldId, newIdVal);
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

  // 0.277.0: index companion sidecars by their owning note's entry stem, so each
  // note can restore its companions after it lands (and follow the note's new
  // basename if the note was renamed on a collision). `ext` is the companion
  // filename minus the note stem (e.g. `.edtz`); a malformed record that doesn't
  // start with the stem falls back to the file's own extension.
  const companionsByStem = new Map<string, { ext: string; data: Uint8Array }[]>();
  if (Array.isArray(manifest.companions)) {
    for (const c of manifest.companions) {
      const data = zip[`companions/${c.i}`];
      if (!data) continue;
      const stem = String(c.noteStem ?? "");
      const fullName = String(c.name ?? "");
      if (!stem || !fullName) continue;
      const ext = fullName.startsWith(stem) ? fullName.slice(stem.length) : fullName.slice(fullName.lastIndexOf("."));
      if (!ext) continue;
      const arr = companionsByStem.get(stem) ?? [];
      arr.push({ ext, data });
      companionsByStem.set(stem, arr);
    }
  }

  // Write notes with remapped ids/parents and import_date.
  let notesWritten = 0;
  const notePathsWritten: string[] = [];
  for (const p of parsed) {
    const oldId = p.fm.id as string | undefined;
    if (!oldId) { warnings.push(`Skipped ${p.originalName} — no id in frontmatter`); continue; }
    const newIdVal = assigned.get(p)!; // per-note (F3), not idRemap.get(oldId)

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

    // For UNTRUSTED imports (external `.stash` bundles) strip reserved
    // frontmatter the same way the markdown drop-import does, so a crafted
    // bundle can't inject pin/due/assignee/position/parentLink state or forge
    // structural fields. Authorship (who wrote it) and the original timestamps
    // are retained; attachments are kept for the link-remap below. Trusted
    // callers (unlock/restore, internal cut-paste) omit stripReserved so their
    // own notes keep every field intact. (0.140.6 review — documented invariant.)
    let srcFm: Record<string, any> = p.fm;
    if (opts.stripReserved) {
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(p.fm)) {
        if (!RESERVED_FRONTMATTER.includes(k)) filtered[k] = v;
      }
      if (p.fm.author !== undefined) filtered.author = p.fm.author;
      if (p.fm.contributors !== undefined) filtered.contributors = p.fm.contributors;
      if (p.fm.created !== undefined) filtered.created = p.fm.created;
      if (p.fm.modified !== undefined) filtered.modified = p.fm.modified;
      if (Array.isArray(p.fm.attachments)) filtered.attachments = p.fm.attachments;
      srcFm = filtered;
    }
    const newFm: Record<string, any> = {
      ...srcFm,
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
    // 0.211.4 (F6): one unwritable note must not abort the whole import. Previously a
    // throw here (a name the filesystem rejects, a permissions error, a full disk)
    // escaped importStashZip with notes already on disk, while the cross-vault paste
    // handler reported "nothing was changed" — untrue, and for a CUT the source vault
    // was then asked to delete originals for an import that had actually stopped
    // halfway. Record the failure as a warning and carry on: the remaining notes still
    // land, the summary reports what didn't, and because the cut ACK is gated on an
    // empty warnings list (F4) a partial import can no longer license deleting the
    // originals. Not a rollback — deleting the notes that DID import would be its own
    // data loss — but an accurate, non-silent partial result.
    try {
      if (await app.vault.adapter.exists(outPath)) {
        const stem = outName.replace(/\.md$/, "");
        outName = `${stem}-${newId(4)}.md`;
        outPath = `${destFolder}/${outName}`;
      }
      await app.vault.create(outPath, finalContent);
      notePathsWritten.push(outPath);
      notesWritten++;

      // 0.277.0: restore this note's companion sidecars next to it, named after
      // the note's FINAL basename (so Edit History etc. re-pair by basename even
      // if the note was renamed on a collision). Never clobber an existing file;
      // sanitize the final name for zip-slip. A companion failure is a warning —
      // the note is already safely on disk.
      const outStem = outName.replace(/\.md$/, "");
      const noteStem = p.originalName.replace(/\.md$/, "");
      for (const comp of companionsByStem.get(noteStem) ?? []) {
        let compName = safeZipEntryName(`${outStem}${comp.ext}`) || `${newId(6)}${comp.ext}`;
        let compPath = `${destFolder}/${compName}`;
        for (let n = 1; await app.vault.adapter.exists(compPath); n++) {
          compName = safeZipEntryName(`${outStem}-${n}${comp.ext}`) || `${newId(6)}${comp.ext}`;
          compPath = `${destFolder}/${compName}`;
        }
        try { await app.vault.createBinary(compPath, comp.data.slice().buffer as ArrayBuffer); }
        catch (e) { warnings.push(`Couldn't restore companion ${compName} — ${(e as Error).message}`); }
      }
    } catch (e) {
      warnings.push(`Couldn't write ${p.originalName} — ${(e as Error).message}`);
    }
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

  return { notesWritten, notePaths: notePathsWritten, attachmentsWritten, collisionsRenamed, warnings, colorAliases, idRemap: Object.fromEntries(idRemap) };
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

/** `nameFor` (0.211.4, F2) must be the SAME resolver the body rewrite used, or the
 *  frontmatter list and the body disagree: the body would point at `diagram-2.png`
 *  while `attachments:` still claimed `diagram.png`. Falls back to the bare basename
 *  when no resolver is supplied. */
function rewriteFrontmatterAttachmentList(md: string, app: App, notePath: string, nameFor?: (af: TFile) => string): string {
  const split = splitFrontmatter(md);
  if (!split.fm.attachments || !Array.isArray(split.fm.attachments)) return md;
  const remapped = (split.fm.attachments as string[]).map((a) => {
    const af = app.metadataCache.getFirstLinkpathDest(a, notePath);
    return af ? (nameFor ? nameFor(af) : af.name) : baseFileName(a);
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

/** 0.166.0: content scope for exports (a forum request). "full" is the whole
 *  note (the only re-importable option); "frontmatter" keeps just the leading
 *  `---` fenced block; "body" keeps just the content after it. Non-"full"
 *  exports are shareable plain zips, NOT re-importable .stash/OKF bundles — they
 *  drop the id/parent structure Stashpad needs to rebuild the tree. */
export type ExportContent = "full" | "frontmatter" | "body";

/** Apply an ExportContent filter to a note's RAW markdown. Works on raw text (no
 *  YAML parse/round-trip) so frontmatter isn't reformatted, reordered, or quoted
 *  differently than the user wrote it. A note with no frontmatter fence yields ""
 *  for "frontmatter" and the whole note for "body". */
export function filterNoteContent(content: string, mode: ExportContent): string {
  if (mode === "full") return content;
  const fence = content.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (mode === "frontmatter") return fence ? fence[0] : "";
  // body: strip the leading frontmatter fence (if any) + any leading blank lines
  return fence ? content.slice(fence[0].length).replace(/^\s*\n/, "") : content;
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
