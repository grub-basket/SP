import { Notice, TFile, TFolder } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, RESERVED_FRONTMATTER, toAttachmentLink } from "./types";
import { newId } from "./id-service";
import { bodyToSlug, buildFilename } from "./slug-service";
import { splitFrontmatter, serializeNote, STASH_EXT } from "./stash-package";
import { ConfirmModal, ImportDupChoiceModal } from "./modals";

/** Reserved subfolders inside a Stashpad folder — never treated as drop
 *  targets, and the import engine ignores files that land inside them. */
const RESERVED_SUBFOLDERS = new Set([
  "_attachments", "_authors", "_exports", "_imports", "_processed", "_archive",
  ".archive", // legacy (pre-0.79.10) — keep ignoring any that exist
]);
/** Where import originals are preserved. 0.79.10: a normal reserved folder
 *  (NOT dot-prefixed) — Obsidian hides/ignores dot-folders, which made
 *  renameFile/getAbstractFileByPath into `.archive` unreliable. */
const ARCHIVE_DIR = "_archive";

/** One processed import, kept so the batch can be undone. */
type ImportRecord =
  | { kind: "md"; folder: string; archivePath: string; notePath: string; originalName: string }
  | { kind: "file"; folder: string; attachmentPath: string; notePath: string; originalName: string }
  | { kind: "folder"; folder: string; archivePath: string; notePaths: string[]; attachmentPaths: string[]; originalName: string };

/** 0.79.1: auto-import engine. Watches files appearing directly in a
 *  Stashpad folder root and turns them into navigable notes:
 *    - markdown → a Stashpad note (frontmatter filled in); the ORIGINAL is
 *      preserved in a `_archive` subfolder.
 *    - any other file → moved to `_attachments`, with a new note that
 *      LINKS to it (link in the body + the path in `attachments`).
 *
 *  Drops are coalesced into a batch (debounced) so a multi-file drop is
 *  handled together, with a "you're about to import N files" guard for
 *  large batches. De-dupe + the import log live in import-log.ts (0.79.2).
 */
export class ImportService {
  private pending = new Map<string, number>();
  private pendingFolders = new Map<string, number>();
  /** 0.79.10: paths Stashpad is itself moving (e.g. an Undo restoring an
   *  archived original back to the root). The create/rename event those
   *  moves fire would otherwise re-trigger auto-import. Entries auto-expire. */
  private suppressed = new Set<string>();
  /** 0.79.15: the auto-importer ignores all events until armed. Obsidian
   *  replays a `create` for every existing file on startup; without this
   *  the whole vault looked like a giant "drop". Armed a beat after
   *  layout-ready, once that storm has passed. */
  private armed = false;
  setArmed(v: boolean): void { this.armed = v; }
  private drainTimer: number | null = null;
  private draining = false;
  private static DEBOUNCE_MS = 900;
  private static BATCH_CONFIRM_AT = 8;

  constructor(private plugin: StashpadPlugin) {}

  private get app() { return this.plugin.app; }

  /** Called from the vault create/rename watcher. Cheap pre-filter, then
   *  queue + (re)arm the debounced drain. */
  enqueue(file: TFile): void {
    if (!this.armed) return;
    if (!this.plugin.settings.autoImport) return;
    if (!this.isEligiblePath(file)) return;
    this.pending.set(file.path, Date.now());
    this.arm();
  }

  /** 0.79.2: a folder dropped directly into a Stashpad folder root. Its
   *  files are imported (flattened) and the whole original folder is then
   *  moved to `_archive`. Non-reserved direct children of a Stashpad root
   *  only. */
  enqueueFolder(folder: TFolder): void {
    if (!this.armed) return;
    if (!this.plugin.settings.autoImport) return;
    if (this.suppressed.has(folder.path)) return;
    const parent = folder.parent?.path?.replace(/\/+$/, "") ?? "";
    if (!this.plugin.discoverStashpadFolders().includes(parent)) return;
    if (RESERVED_SUBFOLDERS.has(folder.name)) return;
    this.pendingFolders.set(folder.path, Date.now());
    this.arm();
  }

  private arm(): void {
    if (this.drainTimer != null) window.clearTimeout(this.drainTimer);
    this.drainTimer = window.setTimeout(() => void this.drain(), ImportService.DEBOUNCE_MS);
  }

  /** Path-level eligibility (no content read): the file sits directly in a
   *  discovered Stashpad folder ROOT (not a reserved subfolder), and isn't
   *  a .stash archive (those have their own importer) or our own .edtz. */
  /** Suppress auto-import for `path` for `ttl` ms — used around our own
   *  moves (undo restores) and for Stashpad-created notes so the resulting
   *  vault event doesn't re-import the file. 0.79.20: public + tunable TTL;
   *  createNoteUnder uses a long window because on a slow network drive the
   *  create event (and the frontmatter flush its id-check needs) can lag
   *  well past a few seconds. */
  suppress(path: string, ttl = 4000): void {
    this.suppressed.add(path);
    window.setTimeout(() => this.suppressed.delete(path), ttl);
  }

  /** Create a note file, suppressing auto-import for it first — the notes
   *  the importer itself creates must never be re-imported (same slow-drive
   *  frontmatter-flush race as composer-created notes). */
  private async createNote(path: string, content: string): Promise<void> {
    this.suppress(path, 60000);
    await this.app.vault.create(path, content);
  }

  private isEligiblePath(file: TFile): boolean {
    if (this.suppressed.has(file.path)) return false;
    if (file.extension === STASH_EXT || file.extension === "edtz") return false;
    const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const base = dir.split("/").pop() ?? "";
    if (RESERVED_SUBFOLDERS.has(base)) return false;
    return this.plugin.discoverStashpadFolders().includes(dir);
  }

  /** Re-validate at drain time. A markdown file that already has a Stashpad
   *  `id` is an existing note (or one we just created) — skip it. 0.79.18:
   *  read the frontmatter FROM DISK rather than the metadata cache. The
   *  cache lags badly on mobile, so an existing note (re)appearing via a
   *  rename event — e.g. Stashpad's own slug-rename after an edit — looked
   *  id-less and got "imported" again, archiving + cloning it in an endless
   *  loop. Reading the file is authoritative and breaks that. */
  private async isStillImportable(file: TFile): Promise<boolean> {
    if (!this.isEligiblePath(file)) return false;
    if (file.extension === "md") {
      try {
        const { fm } = splitFrontmatter(await this.app.vault.read(file));
        if (fm && typeof fm.id === "string" && fm.id) return false;
      } catch { /* unreadable — fall through and let the import try */ }
    }
    return true;
  }

  private async drain(): Promise<void> {
    this.drainTimer = null;
    if (this.draining) return;
    this.draining = true;
    try {
      const paths = [...this.pending.keys()];
      this.pending.clear();
      const candidates = paths
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile);
      const files: TFile[] = [];
      for (const f of candidates) {
        if (await this.isStillImportable(f)) files.push(f);
      }

      // Eligible dropped folders, with their (non-empty) file lists.
      const folderPaths = [...this.pendingFolders.keys()];
      this.pendingFolders.clear();
      const folders = folderPaths
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFolder => f instanceof TFolder)
        .map((f) => ({ folder: f, files: this.filesUnder(f.path) }))
        .filter((x) => x.files.length > 0);   // skip empty folders (e.g. manual mkdir)

      const folderFileCount = folders.reduce((n, x) => n + x.files.length, 0);
      let total = files.length + folderFileCount;
      if (total === 0) return;

      // 0.79.3: de-dupe top-level files against the import log. If any look
      // like a file we've imported before (same name + size), pause and
      // ask before proceeding.
      await this.plugin.importLog.load();
      let importFiles = files;
      const replaced: Array<{ path: string; content: string }> = [];
      const dupes = files.filter((f) => this.plugin.importLog.findDuplicate(f.name, f.stat?.size ?? null));
      if (dupes.length > 0) {
        const names = dupes.slice(0, 5).map((f) => `• ${f.name}`).join("\n");
        const more = dupes.length > 5 ? `\n…and ${dupes.length - 5} more` : "";
        const choice = await this.dupChoice(
          `${dupes.length} of these look like files you've imported before:\n${names}${more}\n\n` +
          `Replace the existing notes, skip the duplicates, or import them anyway as new notes?`,
        );
        if (choice === "skip") {
          const dupSet = new Set(dupes.map((f) => f.path));
          importFiles = files.filter((f) => !dupSet.has(f.path));
          if (importFiles.length === 0 && folders.length === 0) {
            new Notice(`Skipped ${dupes.length} duplicate file(s) — nothing new to import.`);
            return;
          }
        } else if (choice === "replace") {
          // Archive-then-trash the previous import's notes (captured for
          // undo), then import the new files normally below.
          for (const f of dupes) {
            const prior = this.plugin.importLog.findDuplicate(f.name, f.stat?.size ?? null);
            for (const np of prior?.notePaths ?? []) {
              const ex = this.app.vault.getAbstractFileByPath(np);
              if (ex instanceof TFile) {
                try {
                  replaced.push({ path: np, content: await this.app.vault.read(ex) });
                  await this.app.fileManager.trashFile(ex);
                } catch (e) { console.warn("[Stashpad] replace: couldn't remove prior note", np, e); }
              }
            }
          }
        }
        // "anyway" falls through — import everything as new notes.
      }
      total = importFiles.length + folderFileCount;

      // Large-batch guard — "whoa buddy, N files?".
      if (total >= ImportService.BATCH_CONFIRM_AT) {
        const folderNote = folders.length
          ? ` (incl. ${folders.length} folder${folders.length === 1 ? "" : "s"})`
          : "";
        const ok = await this.confirm(
          "Import many files?",
          `You're about to auto-import ${total} files into Stashpad${folderNote}. Proceed?\n` +
          `Markdown becomes notes (originals archived); other files move to _attachments with a linking note. Dropped folders move to _archive.`,
          "Import all",
        );
        if (!ok) {
          new Notice(`Import cancelled — ${total} file(s) left as-is.`);
          return;
        }
      }

      const records: ImportRecord[] = [];
      for (const f of importFiles) {
        try {
          const size = f.stat?.size ?? null;
          const rec = f.extension === "md"
            ? await this.importMarkdown(f)
            : await this.importOtherFile(f);
          if (rec) {
            records.push(rec);
            this.plugin.importLog.append({
              ts: new Date().toISOString(), folder: rec.folder, kind: rec.kind,
              originalName: f.name, size, sourcePath: f.path,
              notePaths: rec.kind === "folder" ? rec.notePaths : [rec.notePath],
            });
          }
        } catch (e) {
          console.warn("[Stashpad] import failed", f.path, e);
        }
      }
      for (const { folder } of folders) {
        try {
          const rec = await this.importFolder(folder);
          if (rec && rec.kind === "folder") {
            records.push(rec);
            this.plugin.importLog.append({
              ts: new Date().toISOString(), folder: rec.folder, kind: "folder",
              originalName: rec.originalName, size: null, sourcePath: folder.path,
              notePaths: rec.notePaths,
            });
          }
        } catch (e) {
          console.warn("[Stashpad] folder import failed", folder.path, e);
        }
      }
      if (records.length > 0 || replaced.length > 0) this.announce(records, replaced);
    } finally {
      this.draining = false;
    }
  }

  /** Markdown: archive the untouched original to `_archive/`, then create a
   *  Stashpad-shaped clone (frontmatter filled in) in the folder root. */
  private async importMarkdown(file: TFile): Promise<ImportRecord | null> {
    const folder = file.parent!.path.replace(/\/+$/, "");
    const raw = await this.app.vault.read(file);
    const { fm, body } = splitFrontmatter(raw);

    // Archive the original verbatim under _archive (unique name).
    const archiveDir = `${folder}/${ARCHIVE_DIR}`;
    await this.ensureFolder(archiveDir);
    const archivePath = await this.uniquePath(archiveDir, file.name);
    await this.app.fileManager.renameFile(file, archivePath);
    // 0.79.21: conflict guard — if the archive move didn't actually land,
    // ABORT before creating the clone. Otherwise we'd produce a clone while
    // the original is lost (the pre-0.79.10 .archive dot-folder failure).
    if (!(this.app.vault.getAbstractFileByPath(archivePath) instanceof TFile)) {
      throw new Error(`archive move failed for ${file.path} — import aborted to avoid data loss`);
    }

    // Build the clone's frontmatter: keep the user's non-reserved keys,
    // then stamp Stashpad's structural fields.
    const cloneFm: Record<string, any> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (!RESERVED_FRONTMATTER.includes(k)) cloneFm[k] = v;
    }
    cloneFm.id = newId();
    cloneFm.parent = ROOT_ID;
    // 0.79.21: preserve the original timestamps — don't stamp "now" over a
    // note that already has a created/modified (e.g. re-imported export).
    const t = this.preservedTimes(fm, file);
    cloneFm.created = t.created;
    if (t.modified) cloneFm.modified = t.modified;
    cloneFm.attachments = Array.isArray(fm.attachments) ? fm.attachments : [];

    const slug = bodyToSlug(body) || file.basename;
    const notePath = await this.uniquePath(folder, buildFilename(slug, cloneFm.id));
    await this.createNote(notePath, serializeNote(cloneFm, body));
    return { kind: "md", folder, archivePath, notePath, originalName: file.name };
  }

  /** Non-markdown: move the file into `_attachments`, then create a note
   *  that links it (link in the body + path in `attachments` frontmatter).
   *  No embed — a custom embed comes later. */
  private async importOtherFile(file: TFile): Promise<ImportRecord | null> {
    const folder = file.parent!.path.replace(/\/+$/, "");
    const attachDir = `${folder}/_attachments`;
    await this.ensureFolder(attachDir);
    const attachmentPath = await this.uniquePath(attachDir, file.name);
    await this.app.fileManager.renameFile(file, attachmentPath);

    const title = file.basename;
    const id = newId();
    const fm: Record<string, any> = {
      id,
      parent: ROOT_ID,
      created: new Date().toISOString(),
      // 0.79.18: attachments stored as internal links (not plain text).
      attachments: [toAttachmentLink(attachmentPath)],
    };
    // 0.79.18: embed the attachment (! prefix) so it previews inline.
    const body = `${title}\n\n![[${attachmentPath}]]\n`;
    const slug = bodyToSlug(title) || title;
    const notePath = await this.uniquePath(folder, buildFilename(slug, id));
    await this.createNote(notePath, serializeNote(fm, body));
    return { kind: "file", folder, attachmentPath, notePath, originalName: file.name };
  }

  /** Choose the created/modified to stamp on an imported note: prefer the
   *  source frontmatter's own values; else fall back to the file's
   *  filesystem ctime/mtime (usually survives a rename, far better than
   *  "now"); else, only as a last resort, now. */
  private preservedTimes(fm: Record<string, any>, file: TFile): { created: string; modified: string | null } {
    const valid = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !Number.isNaN(Date.parse(v));
    const created = valid(fm.created) ? fm.created
      : (file.stat?.ctime ? new Date(file.stat.ctime).toISOString() : new Date().toISOString());
    const modified = valid(fm.modified) ? fm.modified
      : (file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : null);
    return { created, modified };
  }

  /** All files anywhere under `folderPath` (recursive). */
  private filesUnder(folderPath: string): TFile[] {
    const prefix = folderPath.replace(/\/+$/, "") + "/";
    return this.app.vault.getFiles().filter((f) => f.path.startsWith(prefix));
  }

  /** Import a dropped folder by REBUILDING its hierarchy as a note tree:
   *  the folder becomes a parent note, each subfolder a nested parent note,
   *  and each file a child note (markdown → clone of its content; other →
   *  a note that links to the file). The ENTIRE original folder is moved to
   *  `_archive` first (no `_attachments` copying — non-md notes link to the
   *  archived file), so the original tree is preserved verbatim while the
   *  rebuilt note tree mirrors it. */
  private async importFolder(folder: TFolder): Promise<ImportRecord | null> {
    const root = folder.parent!.path.replace(/\/+$/, "");
    const name = folder.name;
    // Move the whole folder to _archive first; we then build notes by
    // reading from its archived location, so non-md notes link to the
    // final (archived) path and md content is cloned from there.
    const archiveDir = `${root}/${ARCHIVE_DIR}`;
    await this.ensureFolder(archiveDir);
    const archivePath = await this.uniquePath(archiveDir, name);
    await this.app.fileManager.renameFile(folder, archivePath);
    const archived = this.app.vault.getAbstractFileByPath(archivePath);

    const notePaths: string[] = [];
    // Top parent note represents the dropped folder itself.
    const rootNoteId = await this.createFolderNote(root, name, ROOT_ID, notePaths);
    if (archived instanceof TFolder) {
      await this.buildNotesFromArchive(archived, root, rootNoteId, notePaths);
    }
    return { kind: "folder", folder: root, archivePath, notePaths, attachmentPaths: [], originalName: name };
  }

  /** Create a "parent note" for a folder (a titled Stashpad note under
   *  `parentId`). Returns its id so children can point at it. */
  private async createFolderNote(root: string, title: string, parentId: string, notePaths: string[]): Promise<string> {
    const id = newId();
    const fm: Record<string, any> = {
      id, parent: parentId, created: new Date().toISOString(), attachments: [],
    };
    const slug = bodyToSlug(title) || title;
    const notePath = await this.uniquePath(root, buildFilename(slug, id));
    await this.createNote(notePath, serializeNote(fm, `${title}\n`));
    notePaths.push(notePath);
    return id;
  }

  /** Walk an archived folder, creating child notes under `parentId`:
   *  subfolders → nested parent notes (recursed); markdown → content clone;
   *  other files → a note linking the archived file. */
  private async buildNotesFromArchive(archivedFolder: TFolder, root: string, parentId: string, notePaths: string[]): Promise<void> {
    for (const child of archivedFolder.children) {
      if (child instanceof TFolder) {
        const childId = await this.createFolderNote(root, child.name, parentId, notePaths);
        await this.buildNotesFromArchive(child, root, childId, notePaths);
      } else if (child instanceof TFile) {
        if (child.extension === "md") {
          const raw = await this.app.vault.read(child);
          const { fm, body } = splitFrontmatter(raw);
          const cloneFm: Record<string, any> = {};
          for (const [k, v] of Object.entries(fm)) {
            if (!RESERVED_FRONTMATTER.includes(k)) cloneFm[k] = v;
          }
          cloneFm.id = newId();
          cloneFm.parent = parentId;
          const t = this.preservedTimes(fm, child);
          cloneFm.created = t.created;
          if (t.modified) cloneFm.modified = t.modified;
          cloneFm.attachments = Array.isArray(fm.attachments) ? fm.attachments : [];
          const slug = bodyToSlug(body) || child.basename;
          const notePath = await this.uniquePath(root, buildFilename(slug, cloneFm.id));
          await this.createNote(notePath, serializeNote(cloneFm, body));
          notePaths.push(notePath);
        } else {
          // Link the archived file (no _attachments copy).
          const id = newId();
          const fm: Record<string, any> = {
            id, parent: parentId, created: new Date().toISOString(),
            attachments: [toAttachmentLink(child.path)],
          };
          const body = `${child.basename}\n\n![[${child.path}]]\n`;
          const slug = bodyToSlug(child.basename) || child.basename;
          const notePath = await this.uniquePath(root, buildFilename(slug, id));
          await this.createNote(notePath, serializeNote(fm, body));
          notePaths.push(notePath);
        }
      }
    }
  }

  /** Note path(s) a record produced. */
  private recordNotePaths(r: ImportRecord): string[] {
    return r.kind === "folder" ? r.notePaths : [r.notePath];
  }

  /** Summary notification + an Undo that reverses the whole batch
   *  (including any notes replaced via the de-dupe "Replace existing"). */
  private announce(records: ImportRecord[], replaced: Array<{ path: string; content: string }> = []): void {
    const folder = (records[0]?.folder) ?? "";
    const n = records.length;
    const repNote = replaced.length ? `, replaced ${replaced.length}` : "";
    // Undo once, whether triggered by the button or Mod+Z — guard so a
    // double-fire (button + undo stack) is a no-op the second time.
    let undone = false;
    const doUndo = async () => { if (undone) return; undone = true; await this.undo(records, replaced); };
    // 0.79.10: persistent (duration 0) so the user can actually click
    // Undo — the prior toast auto-dismissed before they could react.
    this.plugin.notifications.show({
      message: `Imported ${n} file${n === 1 ? "" : "s"}${repNote} into \`${folder.split("/").pop()}\`.`,
      kind: "success",
      category: "import",
      duration: 0,
      folder,
      affectedPaths: records.flatMap((r) => this.recordNotePaths(r)),
      actions: [{ label: "Undo import", onClick: () => void doUndo() }],
    });
    // Also put it on the folder's undo stack so Mod+Z / the undo command
    // reverses the import. Redo is a no-op (re-importing would need the
    // trashed clones' content; the persistent notice is the real path).
    if (folder) {
      this.plugin.getUndoStack(folder).push({
        label: `Import ${n} file${n === 1 ? "" : "s"}`,
        undo: async () => { await doUndo(); },
        redo: async () => { /* re-import not supported; drop the files again */ },
      });
    }
  }

  /** Reverse a batch: trash the created notes, restore each original (move
   *  the archived markdown / file / folder back), and recreate any notes
   *  that "Replace existing" removed. */
  private async undo(records: ImportRecord[], replaced: Array<{ path: string; content: string }> = []): Promise<void> {
    for (const r of records) {
      try {
        if (r.kind === "md") {
          const note = this.app.vault.getAbstractFileByPath(r.notePath);
          if (note instanceof TFile) await this.app.fileManager.trashFile(note);
          const archived = this.app.vault.getAbstractFileByPath(r.archivePath);
          if (archived instanceof TFile) {
            const back = await this.uniquePath(r.folder, r.originalName);
            this.suppress(back);
            await this.app.fileManager.renameFile(archived, back);
          }
        } else if (r.kind === "file") {
          const note = this.app.vault.getAbstractFileByPath(r.notePath);
          if (note instanceof TFile) await this.app.fileManager.trashFile(note);
          const moved = this.app.vault.getAbstractFileByPath(r.attachmentPath);
          if (moved instanceof TFile) {
            const back = await this.uniquePath(r.folder, r.originalName);
            this.suppress(back);
            await this.app.fileManager.renameFile(moved, back);
          }
        } else {
          // folder: trash the created notes + copied attachments, then
          // move the archived folder back to the root.
          for (const np of r.notePaths) {
            const n = this.app.vault.getAbstractFileByPath(np);
            if (n instanceof TFile) await this.app.fileManager.trashFile(n);
          }
          for (const ap of r.attachmentPaths) {
            const a = this.app.vault.getAbstractFileByPath(ap);
            if (a instanceof TFile) await this.app.fileManager.trashFile(a);
          }
          const archived = this.app.vault.getAbstractFileByPath(r.archivePath);
          if (archived instanceof TFolder) {
            const back = await this.uniquePath(r.folder, r.originalName);
            this.suppress(back);
            await this.app.fileManager.renameFile(archived, back);
          }
        }
      } catch (e) {
        console.warn("[Stashpad] import undo failed", r, e);
      }
    }
    // Recreate any notes that "Replace existing" removed.
    for (const rep of replaced) {
      try {
        if (!(await this.app.vault.adapter.exists(rep.path))) {
          await this.app.vault.create(rep.path, rep.content);
        }
      } catch (e) {
        console.warn("[Stashpad] import undo: couldn't restore replaced note", rep.path, e);
      }
    }
    new Notice(`Undid import of ${records.length} file(s).`);
  }

  /** 0.79.4 / 0.80.1: open the OS file picker, copy the chosen files into
   *  `folder`, then import them DIRECTLY (not via the watcher) so this works
   *  regardless of the auto-import toggle. Uses an <input type=file> so it
   *  works on desktop AND mobile (native file/photo picker). */
  pickFilesInto(folder: string): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.onchange = async () => {
      const picked = Array.from(input.files ?? []);
      input.remove();
      if (picked.length === 0) return;
      // 1) write each picked file into the folder root (suppressed so the
      //    watcher, if armed, doesn't ALSO process it — we import below).
      const written: TFile[] = [];
      for (const file of picked) {
        try {
          const buf = await file.arrayBuffer();
          const dest = await this.uniquePath(folder, file.name);
          this.suppress(dest, 60000);
          await this.app.vault.createBinary(dest, buf);
          const tf = this.app.vault.getAbstractFileByPath(dest);
          if (tf instanceof TFile) written.push(tf);
        } catch (e) {
          console.warn("[Stashpad] file-picker write failed", file.name, e);
        }
      }
      if (written.length === 0) return;
      // 2) import the written files directly.
      await this.plugin.importLog.load();
      const records: ImportRecord[] = [];
      for (const f of written) {
        try {
          const size = f.stat?.size ?? null;
          const rec = f.extension === "md" ? await this.importMarkdown(f) : await this.importOtherFile(f);
          if (rec) {
            records.push(rec);
            this.plugin.importLog.append({
              ts: new Date().toISOString(), folder: rec.folder, kind: rec.kind,
              originalName: f.name, size, sourcePath: f.path,
              notePaths: rec.kind === "folder" ? rec.notePaths : [rec.notePath],
            });
          }
        } catch (e) {
          console.warn("[Stashpad] file-picker import failed", f.path, e);
        }
      }
      if (records.length > 0) this.announce(records, []);
    };
    document.body.appendChild(input);
    input.click();
  }

  /** 0.79.5: rebootstrap provision — import any pre-existing LOOSE files
   *  sitting directly in `folder`'s root (files that predate auto-import:
   *  not Stashpad notes, not in a reserved subfolder). Same handling as a
   *  drop (md → clone+archive; other → _attachments + linking note), and
   *  logged. No batch confirm — this is an explicit repair action. Returns
   *  the number imported. This is what lets us retire "Everything" mode:
   *  once loose files are swept into notes, there's nothing left for that
   *  mode to surface. */
  async importLooseFilesIn(folder: string): Promise<number> {
    const root = folder.replace(/\/+$/, "");
    const candidates = this.app.vault.getFiles()
      .filter((f) => (f.parent?.path?.replace(/\/+$/, "") ?? "") === root);
    const files: TFile[] = [];
    for (const f of candidates) {
      if (await this.isStillImportable(f)) files.push(f);
    }
    if (files.length === 0) return 0;
    await this.plugin.importLog.load();
    let n = 0;
    for (const f of files) {
      try {
        const size = f.stat?.size ?? null;
        const rec = f.extension === "md" ? await this.importMarkdown(f) : await this.importOtherFile(f);
        if (rec) {
          n++;
          this.plugin.importLog.append({
            ts: new Date().toISOString(), folder: rec.folder, kind: rec.kind,
            originalName: f.name, size, sourcePath: f.path,
            notePaths: rec.kind === "folder" ? rec.notePaths : [rec.notePath],
          });
        }
      } catch (e) {
        console.warn("[Stashpad] loose-file import failed", f.path, e);
      }
    }
    return n;
  }

  /** Best default destination: the active Stashpad view's folder, else the
   *  first discovered folder, else null. */
  defaultDestination(): string | null {
    const active = this.plugin.lastActiveStashpadLeaf?.view as any;
    const f = active?.noteFolder as string | undefined;
    if (f && this.plugin.discoverStashpadFolders().includes(f)) return f;
    return this.plugin.discoverStashpadFolders()[0] ?? null;
  }

  // --- helpers ---

  private confirm(title: string, message: string, confirmText: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmModal(this.app, title, message, confirmText, resolve).open();
    });
  }

  private dupChoice(message: string): Promise<"anyway" | "replace" | "skip"> {
    return new Promise((resolve) => {
      new ImportDupChoiceModal(this.app, message, resolve).open();
    });
  }

  private async ensureFolder(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      try { if (!(await adapter.exists(cur))) await adapter.mkdir(cur); }
      catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; }
    }
  }

  /** Return `dir/name`, suffixing the stem with -1, -2, … until free. */
  private async uniquePath(dir: string, name: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = `${dir}/${name}`;
    let i = 0;
    while (await adapter.exists(candidate)) {
      i += 1;
      candidate = `${dir}/${stem}-${i}${ext}`;
    }
    return candidate;
  }
}
