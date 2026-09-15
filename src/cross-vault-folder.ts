import { App } from "obsidian";
import { buildStashEntries, importFromFileMap, type ExportInput, type ImportSummary } from "./stash-package";
import type { XvMeta } from "./cross-vault-clipboard";
import type { StashpadId } from "./types";

/** 0.342.0: FOLDER-based cross-vault transfer — a SEPARATE layer beside the
 *  zip/clipboard path (which stays untouched as the fallback). Instead of zipping
 *  the selection into the OS clipboard (slow on some machines), the same assembled
 *  `.stash` entries are written as plain files to `_exports/xv-<stamp>/`, and the
 *  clipboard carries only a POINTER (the folder's absolute path + meta). The
 *  destination vault reads that folder via Node fs and imports it as COPIES (new
 *  ids). Desktop-only (needs the OS filesystem); callers fall back to zip on
 *  mobile or when the pointer can't be read. */

const ATTR_META = "data-stashpad-xvf-meta";
const ATTR_PATH = "data-stashpad-xvf-path";

interface ElectronClipboard {
  readHTML?: () => string;
  write?: (data: { text?: string; html?: string }) => void;
}
function electronClip(): ElectronClipboard | null {
  try {
    const req = (window as unknown as { require?: (m: string) => { clipboard?: ElectronClipboard } }).require;
    return req?.("electron")?.clipboard ?? null;
  } catch { return null; }
}
function nodeFs(): { promises: { readdir: (p: string, o: unknown) => Promise<{ name: string; isDirectory: () => boolean; isFile: () => boolean }[]>; readFile: (p: string) => Promise<Uint8Array> } } | null {
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    return (req?.("fs") as ReturnType<typeof nodeFs>) ?? null;
  } catch { return null; }
}
export function folderTransferAvailable(): boolean { return !!nodeFs(); }

/** How many staged `xv-*` folders to retain per source folder (the newest N). */
const XV_KEEP = 3;

/** Remove all but the newest `keep` staged `xv-*` folders under `<src>/_exports/`.
 *  Names embed a sortable timestamp, so lexical order = chronological order. */
async function pruneStagedFolders(app: App, src: string, keep: number): Promise<void> {
  const adapter = app.vault.adapter;
  const dir = `${src}/_exports`;
  try {
    if (!(await adapter.exists(dir))) return;
    const listing = await adapter.list(dir);
    const staged = (listing.folders ?? [])
      .filter((p) => /\/xv-[^/]+$/.test(p))
      .sort(); // oldest → newest
    const doomed = keep > 0 ? staged.slice(0, Math.max(0, staged.length - keep)) : staged;
    for (const d of doomed) { try { await adapter.rmdir(d, true); } catch { /* best-effort */ } }
  } catch { /* best-effort — never block a copy on cleanup */ }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The vault's absolute root path (FileSystemAdapter). */
function vaultBase(app: App): string | null {
  const a = app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
  try { return a.getBasePath?.() ?? a.basePath ?? null; } catch { return null; }
}

/** Write the assembled entries to `<sourceFolder>/_exports/xv-<stamp>/` (no zip).
 *  Returns the vault-relative + absolute paths of the staged folder. */
export async function stageEntriesToFolder(app: App, input: ExportInput): Promise<{ relPath: string; absPath: string } | null> {
  const base = vaultBase(app);
  if (!base) return null;
  const entries = await buildStashEntries(app, input);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
  const src = input.sourceFolder.replace(/\/+$/, "");
  const relPath = `${src}/_exports/xv-${stamp}`;
  const adapter = app.vault.adapter;
  // Prune stale staged folders before adding a new one. Only the folder the
  // current clipboard pointer references is ever reachable, so old `xv-*` dirs
  // are litter (they also sync). Keep the few most recent as a safety margin.
  await pruneStagedFolders(app, src, XV_KEEP - 1);
  const ensure = async (dir: string): Promise<void> => {
    let cur = "";
    for (const part of dir.split("/")) { cur = cur ? `${cur}/${part}` : part; try { if (!(await adapter.exists(cur))) await adapter.mkdir(cur); } catch { /* concurrent */ } }
  };
  for (const e of entries) {
    const p = `${relPath}/${e.name}`;
    await ensure(p.slice(0, p.lastIndexOf("/")));
    if (typeof e.data === "string") {
      await adapter.write(p, e.data);
    } else {
      const u8 = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
      await adapter.writeBinary(p, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
    }
  }
  return { relPath, absPath: `${base.replace(/[\\/]+$/, "")}/${relPath}` };
}

/** Put the folder pointer on the OS clipboard (a hidden HTML flavor + plain text),
 *  written atomically so the HTML flavor survives (a separate text write would
 *  replace it). */
export function writeXvFolderPointer(plainText: string, meta: XvMeta, absPath: string): boolean {
  const html = `<div ${ATTR_META}="${esc(JSON.stringify(meta))}" ${ATTR_PATH}="${esc(absPath)}"><pre>${esc(plainText)}</pre></div>`;
  const ec = electronClip();
  if (ec?.write) { try { ec.write({ text: plainText, html }); return true; } catch { /* fall through */ } }
  try {
    const item = new ClipboardItem({
      "text/plain": new Blob([plainText], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    });
    void navigator.clipboard.write([item]);
    return true;
  } catch { return false; }
}

/** Read a folder pointer off the clipboard, if present. */
export function readXvFolderPointer(): { meta: XvMeta; absPath: string } | null {
  const ec = electronClip();
  let html = "";
  try { html = ec?.readHTML?.() ?? ""; } catch { html = ""; }
  if (!html || !html.includes(ATTR_META) || !html.includes(ATTR_PATH)) return null;
  try {
    const metaM = html.match(new RegExp(`${ATTR_META}="([^"]*)"`));
    const pathM = html.match(new RegExp(`${ATTR_PATH}="([^"]*)"`));
    if (!metaM || !pathM) return null;
    const meta = JSON.parse(metaM[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) as XvMeta;
    const absPath = pathM[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return { meta, absPath };
  } catch { return null; }
}

/** Read a staged folder (any vault, via Node fs) into a name→bytes file map keyed
 *  by POSIX-relative path (notes/x.md, attachments/y.png, manifest.json). */
export async function readStagedFolder(absPath: string): Promise<Record<string, Uint8Array> | null> {
  const fs = nodeFs();
  if (!fs) return null;
  const out: Record<string, Uint8Array> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const child = `${dir}/${it.name}`;
      const childRel = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(child, childRel);
      else if (it.isFile()) out[childRel] = await fs.promises.readFile(child);
    }
  };
  try { await walk(absPath.replace(/[\\/]+$/, ""), ""); } catch { return null; }
  return Object.keys(out).length ? out : null;
}

/** Import a staged folder into `destFolder` as COPIES — every note gets a fresh
 *  id (forceNewIds), the subtree re-linked internally. Reuses importFromFileMap. */
export async function importStagedFolder(app: App, absPath: string, destFolder: string, existingIds: Set<string>, reparentRootsTo: StashpadId | null = null): Promise<ImportSummary | null> {
  const map = await readStagedFolder(absPath);
  if (!map || !map["manifest.json"]) return null;
  // 0.368.1: reparentRootsTo nests the pasted roots under the focused node (like
  // the zip paste path). null = the vault home. Without it the folder path always
  // anchored to home, ignoring where you were focused.
  return importFromFileMap(app, map, destFolder, existingIds, { forceNewIds: true, stripReserved: true, reparentRootsTo });
}
