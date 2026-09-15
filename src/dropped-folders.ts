/** 0.370.0: FOLDER drag-and-drop into the composer / dropzone.
 *
 *  The web File API hands a plain file drop over as `dataTransfer.files`, but a
 *  FOLDER drop leaves that list EMPTY — the only way to see inside a dropped
 *  directory is the non-standard (but universally shipped in Chromium/Electron)
 *  `DataTransferItem.webkitGetAsEntry()`, which returns a `FileSystemEntry`.
 *  That is why the earlier attempt "failed": it read `dataTransfer.files`, saw
 *  nothing, and dropped the folder on the floor.
 *
 *  Two-phase, because the entry handles are only valid during the `drop` event:
 *    1. `collectDropEntries(dataTransfer)` — SYNCHRONOUS. Pulls the entry list
 *       out of the DataTransfer before the event returns (any async gap
 *       invalidates the items). Reports whether any entry is a directory.
 *    2. `readDroppedTree(entries)` — async. Walks each directory entry
 *       recursively into a `DroppedTree` of files + nested dirs.
 *
 *  Desktop/Electron only (mobile can't drag folders in), but the guards are
 *  capability-based, not platform-based: if `webkitGetAsEntry` is absent we
 *  simply report no directories and the caller keeps its plain-files path. */

export interface DroppedDir {
  name: string;
  files: File[];
  dirs: DroppedDir[];
}

export interface DroppedTree {
  /** Top-level folders that were dropped (each becomes a "folder note"). */
  dirs: DroppedDir[];
  /** Bare files dropped alongside the folders (handled by the plain path). */
  looseFiles: File[];
}

/** Minimal shape of the entry objects `webkitGetAsEntry` returns — the DOM lib
 *  types (`FileSystemEntry` etc.) aren't guaranteed in this tsconfig, so we
 *  describe just what we touch. */
interface FSEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (batch: FSEntry[]) => void, err: (e: unknown) => void) => void;
  };
}

interface CollectedEntries {
  entries: FSEntry[];
  /** True when at least one dropped entry is a directory — the only case that
   *  needs the folder-import path. */
  hasDirectory: boolean;
}

/** SYNCHRONOUS: pull the entry handles out of a drop's DataTransfer. Must run
 *  inside the `drop` handler, before any `await`, or the items go stale and
 *  every `webkitGetAsEntry()` returns null. */
export function collectDropEntries(dt: DataTransfer | null | undefined): CollectedEntries {
  const out: FSEntry[] = [];
  let hasDirectory = false;
  const items = dt?.items;
  if (!items) return { entries: out, hasDirectory };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "file") continue;
    const getEntry = (it as unknown as { webkitGetAsEntry?: () => FSEntry | null }).webkitGetAsEntry;
    const entry = typeof getEntry === "function" ? getEntry.call(it) : null;
    if (!entry) continue;
    if (entry.isDirectory) hasDirectory = true;
    out.push(entry);
  }
  return { entries: out, hasDirectory };
}

function entryFile(entry: FSEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof entry.file !== "function") { resolve(null); return; }
    entry.file((f) => resolve(f), () => resolve(null));
  });
}

/** Read ALL children of a directory entry. `readEntries` returns results in
 *  BATCHES and must be called repeatedly until it yields an empty array — a
 *  single call only returns the first ~100 entries. */
function readDirEntries(entry: FSEntry): Promise<FSEntry[]> {
  return new Promise((resolve) => {
    const reader = entry.createReader?.();
    if (!reader) { resolve([]); return; }
    const all: FSEntry[] = [];
    const pump = (): void => {
      reader.readEntries((batch) => {
        if (!batch.length) { resolve(all); return; }
        all.push(...batch);
        pump();
      }, () => resolve(all));
    };
    pump();
  });
}

async function readDir(entry: FSEntry): Promise<DroppedDir> {
  const children = await readDirEntries(entry);
  const files: File[] = [];
  const dirs: DroppedDir[] = [];
  for (const child of children) {
    if (child.isDirectory) {
      dirs.push(await readDir(child));
    } else if (child.isFile) {
      const f = await entryFile(child);
      if (f) files.push(f);
    }
  }
  // Stable, human order — the OS reader returns entries in arbitrary order.
  files.sort((a, b) => a.name.localeCompare(b.name));
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return { name: entry.name, files, dirs };
}

/** Async: expand collected entries into a full tree of dirs + loose files. */
export async function readDroppedTree(entries: FSEntry[]): Promise<DroppedTree> {
  const dirs: DroppedDir[] = [];
  const looseFiles: File[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      dirs.push(await readDir(entry));
    } else if (entry.isFile) {
      const f = await entryFile(entry);
      if (f) looseFiles.push(f);
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, looseFiles };
}

/** Total file count in a dir subtree — for progress + summary copy. */
export function countTreeFiles(dirs: DroppedDir[]): number {
  let n = 0;
  for (const d of dirs) n += d.files.length + countTreeFiles(d.dirs);
  return n;
}

/** Total folder count in a dir subtree — for summary copy. */
export function countTreeDirs(dirs: DroppedDir[]): number {
  let n = dirs.length;
  for (const d of dirs) n += countTreeDirs(d.dirs);
  return n;
}
