// 0.541.0: rename-proof Stashpad folders.
//
// A tab remembers its folder by PATH. Obsidian's `rename` event lets an open tab
// follow a rename made in this app (main.ts retargetStashpadViewsForFolderRename),
// but a rename made elsewhere — a coworker on a shared network drive, another
// device through sync, a rename while Obsidian was closed — arrives as "folder
// deleted, other folder appeared", or not at all. The tab then pointed at a path
// that no longer existed, and bootstrap quietly recreated an empty Stashpad there.
//
// So each Stashpad carries an identity that moves WITH the folder: a
// `stashpadFolderId` property on its Home note. The Home note is already inside
// every Stashpad, the metadata cache indexes its frontmatter (finding a folder
// by id is an in-memory scan, no disk reads — which matters on a network drive),
// and it adds no new file. Each device also remembers path → id in local storage,
// which is what lets it ask "where did the folder I knew as X go?".
//
// A copied folder carries a copy of the id; ensureFolderId re-mints the copy's,
// and findMovedFolder never auto-follows an ambiguous match.

import { FuzzySuggestModal, TFile, TFolder, type App } from "obsidian";
import { ROOT_ID } from "./types";
import { newId } from "./id-service";

/** Frontmatter key on a Stashpad's Home note. */
export const FOLDER_ID_KEY = "stashpadFolderId";
const MAP_KEY = "stashpad-folder-ids";

const norm = (p: string): string => (p ?? "").replace(/^\/+|\/+$/g, "");

/** Per-device memory of path → folder id (vault-scoped local storage). */
export function readFolderIdMap(app: App): Record<string, string> {
  try {
    const raw = app.loadLocalStorage(MAP_KEY) as unknown;
    return raw && typeof raw === "object" ? { ...(raw as Record<string, string>) } : {};
  } catch { return {}; }
}
export function writeFolderIdMap(app: App, map: Record<string, string>): void {
  try { app.saveLocalStorage(MAP_KEY, map); } catch { /* per-device convenience only */ }
}

/** Every Home note the metadata cache knows: the folder it sits directly in, and
 *  that folder's id (null when it has none yet). */
export function scanHomes(app: App): Array<{ folder: string; id: string | null; file: TFile }> {
  const out: Array<{ folder: string; id: string | null; file: TFile }> = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || fm.id !== ROOT_ID) continue;
    const raw = fm[FOLDER_ID_KEY];
    out.push({ folder: f.parent?.path ?? "", id: typeof raw === "string" && raw ? raw : null, file: f });
  }
  return out;
}

export function mintFolderId(): string { return `sf-${newId(10)}`; }

/** Where a vanished folder probably went. `auto` is set only for an unambiguous
 *  folder-id match — the one case safe to follow without asking. */
export interface MovedFolderGuess {
  auto: string | null;
  options: Array<{ path: string; why: "moved" | "id" | "notes"; hits?: number }>;
}

/** 0.541.1: per-device record of moves this device has SEEN (old → new). Following
 *  a move re-keys every other per-path memory to the new path, so without this the
 *  old path looks brand new afterwards — and an empty folder recreated there (by an
 *  older Stashpad, often a coworker's) would be set up as a fresh Stashpad. */
const MOVES_KEY = "stashpad-folder-moves";
const MOVES_MAX = 200;
export function readFolderMoves(app: App): Record<string, string> {
  try {
    const raw = app.loadLocalStorage(MOVES_KEY) as unknown;
    return raw && typeof raw === "object" ? { ...(raw as Record<string, string>) } : {};
  } catch { return {}; }
}
export function recordFolderMove(app: App, from: string, to: string): void {
  const a = norm(from), b = norm(to);
  if (!a || !b || a === b) return;
  const moves = readFolderMoves(app);
  // Chains collapse: anything that pointed at `a` now points at `b`.
  for (const k of Object.keys(moves)) if (moves[k] === a) moves[k] = b;
  delete moves[b];
  delete moves[a];
  moves[a] = b; // re-inserted last = newest
  const keys = Object.keys(moves);
  for (const k of keys.slice(0, Math.max(0, keys.length - MOVES_MAX))) delete moves[k];
  try { app.saveLocalStorage(MOVES_KEY, moves); } catch { /* per-device only */ }
}
export function forgetFolderMove(app: App, from: string): void {
  const moves = readFolderMoves(app);
  if (!(norm(from) in moves)) return;
  delete moves[norm(from)];
  try { app.saveLocalStorage(MOVES_KEY, moves); } catch { /* ignore */ }
}

/** Look for the folder this device knew as `oldFolder`:
 *   1. by folder id (Home note property) — exact; unique match → `auto`.
 *   2. by note ids this device remembers from that folder (last cursor /
 *      selection) — works for folders last opened before folder ids existed.
 *  `noteIds` is passed in by the caller (they live in plugin storage). */
export function findMovedFolder(app: App, oldFolder: string, noteIds: Set<string>): MovedFolderGuess {
  const old = norm(oldFolder);
  const homes = scanHomes(app).filter((h) => norm(h.folder) !== old);
  const id = readFolderIdMap(app)[old];
  const options: MovedFolderGuess["options"] = [];
  // A move this device saw happen is exact.
  const seen = readFolderMoves(app)[old];
  if (seen && app.vault.getAbstractFileByPath(seen) instanceof TFolder) {
    return { auto: seen, options: [{ path: seen, why: "moved" }] };
  }
  if (id) {
    for (const h of homes) if (h.id === id) options.push({ path: h.folder, why: "id" });
  }
  if (options.length === 1) return { auto: options[0].path, options };

  if (noteIds.size) {
    // Nearest Stashpad (folder holding a Home note) above each matching note.
    const homeFolders = new Set(homes.map((h) => norm(h.folder)));
    const hits = new Map<string, number>();
    for (const f of app.vault.getMarkdownFiles()) {
      const nid = app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (typeof nid !== "string" || !noteIds.has(nid)) continue;
      let p: TFolder | null = f.parent;
      while (p && !homeFolders.has(norm(p.path))) p = p.parent;
      if (!p || p.isRoot()) continue;
      const key = norm(p.path);
      if (key === old) continue;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
    for (const [path, n] of [...hits].sort((a, b) => b[1] - a[1])) {
      if (!options.some((o) => norm(o.path) === path)) options.push({ path, why: "notes", hits: n });
    }
  }
  return { auto: null, options };
}

/** Pick any vault folder to re-link a tab to. */
export class RelinkFolderModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private onPick: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder("Which folder is this Stashpad now?");
  }
  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && !f.isRoot());
  }
  getItemText(f: TFolder): string { return f.path; }
  onChooseItem(f: TFolder): void { this.onPick(f); }
}
