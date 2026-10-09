/** 0.558.0: "Fold this Stashpad into…" — merge a whole Stashpad folder into
 *  another one.
 *
 *  The user's habit: make a folder for everything (fast), then fold the small
 *  ones into a bigger one later. A fold:
 *
 *   1. creates ONE container note at the destination's top level, named after
 *      the old folder (the old Home's text, if it had any, goes in its body);
 *   2. moves every live note under it — through `crossFolderPaste` (cut), the
 *      same engine as a cross-folder cut/paste, so attachments travel, ids are
 *      kept unless they clash, and the move has a file-level undo;
 *   3. writes a "folder settings" note pinned to the BOTTOM of the container,
 *      listing the per-folder settings that don't carry over (icon, blur,
 *      placement, filters, encryption prefs, …);
 *   4. merges the old folder's plaintext `archive/` and `trash/` into the
 *      destination's, under a `from-<name>/` subfolder (the archive and trash
 *      views look one level down for exactly this);
 *   5. moves the old folder's remaining attachments into
 *      `<dest>/_attachments/from-<name>/` and any author stubs the destination
 *      lacks into `<dest>/_authors/`;
 *   6. LAST, moves the emptied folder (Home, sidecars, anything encrypted that
 *      couldn't move) to `_archive/Folded Stashpads/<name>` and writes a fold
 *      manifest there. Last on purpose: if anything above fails, the old folder
 *      is still where it was and the steps done so far are rolled back.
 *
 *  A redirect (`settings.foldedFolders`) sends old deep links to the new place.
 *  Undo is one step on the destination's undo stack, plus an Undo button on the
 *  persistent notification. Encrypted content (locked notes, encrypted archive
 *  and trash blobs) stays in the archived folder for now — it decrypts with that
 *  folder's own key, which a move would strand. */
import { Modal, Setting, SuggestModal, TFile, TFolder, type App } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, siftMatch, type FolderPlacement, type StashpadId } from "./types";
import { readFolderSubtreeNodes } from "./encryption-ops";
import { bodyToSlug, buildFilename } from "./slug-service";
import { serializeNote, splitFrontmatter } from "./stash-package";
import { notify } from "./notify";

/** Where folded folders are parked. `_archive` is a reserved name, so nothing
 *  under it is ever discovered as a Stashpad, nest-checked, or searched. */
export const FOLDED_SHELL_ROOT = "_archive/Folded Stashpads";
/** The manifest a fold leaves in the archived folder (read by Unfold). */
export const FOLD_MANIFEST = ".stashpad-fold.json";
/** Prefix of the subfolder a fold creates inside the destination's archive/,
 *  trash/ and _attachments/. */
export const FOLD_SUBFOLDER_PREFIX = "from-";

export type { FoldRedirect } from "./settings";

export interface FoldManifest {
  v: 1;
  at: string;
  src: string;
  dest: string;
  shell: string;
  containerId: StashpadId;
  containerPath: string;
  settingsNotePath: string | null;
  movedRootIds: StashpadId[];
  idRemap: Record<string, string>;
  /** Plain file moves (archive / trash / attachments / authors), in order. */
  moved: Array<{ from: string; to: string }>;
  noteCount: number;
  leftBehind: { lockedSubtrees: number; encryptedFiles: number };
  /** 0.559.0: locked subtrees re-encrypted under the destination's key. */
  relocked?: number;
  relockProblems?: string[];
  /** 0.560.0 manifests: the from-<name> folders this fold made in the
   *  destination's archive/ and trash/. Superseded by `dirMap`. */
  bases?: Partial<Record<"archive" | "trash", string>>;
  /** 0.562.1: where each archive/trash folder of the old folder went (its own
   *  items, and any from-* folder of an earlier fold into it). Unfold reverses it. */
  dirMap?: FoldDirMapEntry[];
  /** 0.562.1: the old folder's folder-switcher placement, and whether it was the
   *  default folder — Unfold restores both. */
  placement?: FolderPlacement;
  wasDefault?: boolean;
}

export interface FoldDirMapEntry { from: string; to: string }

export interface FoldResult {
  manifest: FoldManifest;
  undo: () => Promise<void>;
}

const clean = (p: string): string => (p || "").replace(/^\/+|\/+$/g, "");
const baseName = (p: string): string => clean(p).split("/").pop() || clean(p);
/** Encrypted content a plain move would strand (it decrypts with the key of the
 *  folder it sits in): a `.stashenc`, its `.stashmeta` sidecar, a `.stashkey`.
 *  A `.stashmeta` next to a plaintext `.stashpack` (trash) is NOT encrypted. */
export function isEncryptedFile(app: App, f: TFile): boolean {
  if (f.extension === "stashenc" || f.extension === "stashkey") return true;
  if (f.extension !== "stashmeta") return false;
  return !(app.vault.getAbstractFileByPath(f.path.replace(/\.stashmeta$/, ".stashpack")) instanceof TFile);
}

/** Per-folder settings worth reporting, in the order the note lists them.
 *  Read generically (`settings[key][folder]` or membership in a list) so a
 *  missing key on an older data.json is simply skipped. */
const SETTING_ROWS: Array<{ key: string; label: string; kind: "map" | "list" }> = [
  { key: "folderIcons", label: "Tab icon", kind: "map" },
  { key: "obscureFolders", label: "Blur (obscure)", kind: "map" },
  { key: "folderPanelPinned", label: "Pinned in the folder switcher", kind: "list" },
  { key: "folderPanelDownranked", label: "Downranked in the folder switcher", kind: "list" },
  { key: "folderPanelHidden", label: "Hidden in the folder switcher", kind: "list" },
  { key: "viewModes", label: "View mode", kind: "map" },
  { key: "hideCompletedNotes", label: "Hide completed notes", kind: "map" },
  { key: "hideChildlessNotes", label: "Hide childless notes", kind: "map" },
  { key: "attachmentsOnlyNotes", label: "Attachments-only filter", kind: "map" },
  { key: "includeAttachmentsInEverything", label: "Include attachments in Everything", kind: "map" },
  { key: "encryptionFilter", label: "Encryption filter", kind: "map" },
  { key: "folderEncPrefs", label: "Encryption preferences", kind: "map" },
  { key: "noteTemplates", label: "New-note template", kind: "map" },
  { key: "colorAliases", label: "Colour names", kind: "map" },
];

/** Markdown lines describing `src`'s per-folder settings ("" when none). */
export function describeFolderSettings(plugin: StashpadPlugin, src: string): string[] {
  const s = plugin.settings as unknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const row of SETTING_ROWS) {
    const v = s[row.key];
    if (row.kind === "list") {
      if (Array.isArray(v) && v.map((x) => clean(String(x))).includes(src)) lines.push(`- **${row.label}:** yes`);
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const val = (v as Record<string, unknown>)[src];
    if (val === undefined || val === null) continue;
    const shown = typeof val === "string" ? val : JSON.stringify(val);
    if (!shown || shown === "{}" || shown === "[]") continue;
    // Long values (a template body) are summarised, not dumped into the note.
    lines.push(`- **${row.label}:** \`${shown.length > 160 ? `${shown.slice(0, 157)}…` : shown}\``);
  }
  return lines;
}

/** Find a path that doesn't exist yet: `base`, `base 2`, `base 3`, … */
export async function uniqueFolderPath(app: App, base: string, taken: readonly string[] = []): Promise<string> {
  let p = base;
  for (let n = 2; taken.includes(p) || await app.vault.adapter.exists(p); n++) p = `${base} ${n}`;
  return p;
}

/** Same as `uniqueFolderPath` for a FILE: inserts the counter before the extension. */
export async function uniqueFilePath(app: App, path: string): Promise<string> {
  if (!(await app.vault.adapter.exists(path))) return path;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  for (let n = 2; ; n++) {
    const p = `${dir}/${stem} ${n}${ext}`;
    if (!(await app.vault.adapter.exists(p))) return p;
  }
}

/** mkdir -p. Folders it actually created are appended to `created` (when
 *  given) so an undo can remove them again once they're empty. */
export async function ensureFolder(app: App, dir: string, created?: string[]): Promise<void> {
  let acc = "";
  for (const seg of clean(dir).split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    if (await app.vault.adapter.exists(acc)) continue;
    try { await app.vault.createFolder(acc); created?.push(acc); } catch { /* race / exists */ }
  }
}

/** Remove the folders in `dirs` that are empty, deepest first. Never touches a
 *  folder with anything in it. */
export async function removeEmptyFolders(app: App, dirs: string[]): Promise<void> {
  for (const d of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
    try {
      if (!(await app.vault.adapter.exists(d))) continue;
      const l = await app.vault.adapter.list(d);
      if (l.files.length || l.folders.length) continue;
      // Recursive on purpose: a NON-recursive rmdir throws EISDIR on desktop
      // even for an empty folder (seen 2026-10-09, plain vault.delete too). The
      // emptiness checks just above — disk listing AND the vault's children —
      // are what keep this from ever removing content.
      const tf = app.vault.getAbstractFileByPath(d);
      if (tf instanceof TFolder && tf.children.length === 0) await app.vault.adapter.rmdir(d, true);
    } catch (e) { console.warn("[Stashpad] fold undo: couldn't remove empty folder", d, e); }
  }
}

/** Write a new Stashpad note file directly (the destination's view may be
 *  closed, so this can't go through the view's createNoteUnder). */
async function writeNote(
  plugin: StashpadPlugin, folder: string, parent: StashpadId, body: string,
  extraFm: Record<string, unknown> = {},
): Promise<{ id: StashpadId; path: string }> {
  const id = plugin.mintNoteId();
  const fm: Record<string, unknown> = { id, parent, created: new Date().toISOString(), attachments: [], ...extraFm };
  const title = body.split("\n")[0] ?? "";
  const slug = bodyToSlug(title) || "note";
  const path = await uniqueFilePath(plugin.app, `${folder}/${buildFilename(slug, id)}`);
  await plugin.app.vault.create(path, serializeNote(fm, body.endsWith("\n") ? body : `${body}\n`));
  return { id, path };
}

/** Why a fold of `src` into `dest` can't run, or null when it can. */
export function foldRefusal(plugin: StashpadPlugin, src: string, dest: string): string | null {
  if (!src || !dest) return "Pick a folder to fold into.";
  if (src === dest) return "A folder can't be folded into itself.";
  if (dest.startsWith(`${src}/`) || src.startsWith(`${dest}/`)) return "One of these folders is inside the other.";
  if (!(plugin.app.vault.getAbstractFileByPath(src) instanceof TFolder)) return `“${src}” no longer exists.`;
  if (!(plugin.app.vault.getAbstractFileByPath(dest) instanceof TFolder)) return `“${dest}” no longer exists.`;
  if (plugin.isArchiveFolder(dest)) return `“${baseName(dest)}” is an archive folder — fold into a regular Stashpad.`;
  if (plugin.isArchiveFolder(src)) return `“${baseName(src)}” is an archive folder and can't be folded.`;
  return null;
}

/** The fold engine. Returns null when refused or when it failed and rolled back
 *  (a Notice says which). */
export async function foldStashpadFolder(plugin: StashpadPlugin, srcRaw: string, destRaw: string): Promise<FoldResult | null> {
  const app = plugin.app;
  const src = clean(srcRaw);
  const dest = clean(destRaw);
  const refusal = foldRefusal(plugin, src, dest);
  if (refusal) { notify(refusal); return null; }
  const name = baseName(src);
  const sub = `${FOLD_SUBFOLDER_PREFIX}${name}`;

  // ---- Read the source (disk, not cache) --------------------------------
  const nodes = await readFolderSubtreeNodes(app, src);
  const ids = new Set(nodes.map((n) => String(n.id)));
  const home = nodes.find((n) => n.id === ROOT_ID) ?? null;
  // Top level = parented to Home, parentless, or orphaned (parent not here).
  const roots = nodes
    .filter((n) => n.id !== ROOT_ID && (n.parent === null || n.parent === ROOT_ID || !ids.has(String(n.parent))))
    .sort((a, b) => (a.created || "").localeCompare(b.created || ""));
  const homeExtra = home ? await homeBodyExtra(app, home.file, name) : "";
  const encryptedFiles = app.vault.getFiles().filter((f) => f.path.startsWith(`${src}/`) && f.extension === "stashenc").length;
  const settingLines = describeFolderSettings(plugin, src);

  // Rollback steps, pushed as each forward step completes; run in reverse. A
  // `critical` step that fails stops the rest: the steps after it assume it
  // worked (e.g. files go back into the old folder only once it's back).
  const undoSteps: UndoStep[] = [];
  const rollback = (): Promise<{ failed: string[]; aborted: boolean }> => runUndoSteps(undoSteps);
  const moved: Array<{ from: string; to: string }> = [];
  const createdDirs: string[] = [];
  // Pushed first, so it runs LAST on undo — after every file has moved back.
  undoSteps.push({ label: "remove the folders the fold made", run: () => removeEmptyFolders(app, createdDirs) });
  const moveFile = async (from: string, to: string): Promise<void> => {
    const f = app.vault.getAbstractFileByPath(from);
    if (!(f instanceof TFile)) return;
    await ensureFolder(app, to.slice(0, to.lastIndexOf("/")), createdDirs);
    const target = await uniqueFilePath(app, to);
    // fileManager.renameFile: Obsidian repoints [[links]] to the file (when
    // "Automatically update internal links" is on), same as Stashpad's re-slug.
    await app.fileManager.renameFile(f, target);
    moved.push({ from, to: target });
  };
  undoSteps.push({
    label: "move files back",
    run: async () => {
      for (const m of [...moved].reverse()) {
        const f = app.vault.getAbstractFileByPath(m.to);
        if (!(f instanceof TFile)) continue;
        await ensureFolder(app, m.from.slice(0, m.from.lastIndexOf("/")));
        if (await app.vault.adapter.exists(m.from)) { console.warn("[Stashpad] fold undo: original path taken, left in place:", m.to); continue; }
        await app.fileManager.renameFile(f, m.from);
      }
    },
  });

  try {
    // ---- 1. Container note ----------------------------------------------
    const container = await writeNote(plugin, dest, ROOT_ID, homeExtra ? `${name}\n\n${homeExtra}` : name);
    undoSteps.push({ label: "remove the container note", run: () => trashPath(app, container.path) });

    // ---- 2. Live notes (cut-move through the cross-folder paste engine) ---
    let movedRootIds: StashpadId[] = [];
    let idRemap: Record<string, string> = {};
    let noteCount = 0;
    if (roots.length) {
      const res = await plugin.crossFolderPaste(src, roots.map((r) => r.id), dest, container.id, "cut");
      if (!res) throw new Error("the notes couldn't be moved");
      undoSteps.push({ label: "move the notes back", run: res.undo });
      movedRootIds = res.rootIds;
      noteCount = res.noteCount;
      idRemap = Object.fromEntries(Object.entries(res.idRemap ?? {}).filter(([a, b]) => a !== b));
    }
    // Notes the user had unlocked are on the re-encrypt watchlist under the old
    // folder; carry their reminders over, or they'd be dropped as "gone".
    undoSteps.push(transferReEncryptWatch(plugin, src, dest, null, idRemap));

    // ---- 3. Settings note, pinned to the bottom of the container ---------
    let settingsNotePath: string | null = null;
    {
      const body = [
        `Folder settings from ${name}`,
        "",
        `“${name}” was folded into “${baseName(dest)}” on ${new Date().toLocaleString()}. These were its own settings; they don't carry over, because this folder keeps its own.`,
        "",
        ...(settingLines.length ? settingLines : ["- (no folder-specific settings)"]),
        "",
        `The old folder is archived at \`${FOLDED_SHELL_ROOT}/…\` (the folder switcher won't list it).`,
      ].join("\n");
      const note = await writeNote(plugin, dest, container.id, body, { listPinned: "bottom", listPinnedAt: Date.now() });
      settingsNotePath = note.path;
      undoSteps.push({ label: "remove the settings note", run: () => trashPath(app, note.path) });
    }

    // ---- Where archive / trash content goes --------------------------------
    // The old folder's own items → <dest>/<kind>/from-<name>/. A from-* folder
    // it already had (an earlier fold INTO it) moves up beside that one under
    // its own name, so folds never nest from-* two levels deep (the trash and
    // archive views look exactly one level down).
    const dirMap: FoldDirMapEntry[] = [];
    for (const kind of ["archive", "trash"] as const) {
      const root = `${src}/${kind}`;
      if (!(await app.vault.adapter.exists(root))) continue;
      const listing = await app.vault.adapter.list(root);
      for (const sub2 of listing.folders) {
        const n = sub2.split("/").pop() ?? "";
        if (!n.startsWith(FOLD_SUBFOLDER_PREFIX)) continue;
        dirMap.push({ from: sub2, to: await uniqueFolderPath(app, `${dest}/${kind}/${n}`, dirMap.map((d) => d.to)) });
      }
      dirMap.push({ from: root, to: await uniqueFolderPath(app, `${dest}/${kind}/${sub}`, dirMap.map((d) => d.to)) });
    }
    const mapPath = (p: string): string | null => {
      const hit = dirMap.filter((d) => p.startsWith(`${d.from}/`)).sort((a, b) => b.from.length - a.from.length)[0];
      return hit ? `${hit.to}/${p.slice(hit.from.length + 1)}` : null;
    };

    // ---- 3b. Locked notes: unlock with the old key, re-lock with the new ----
    // Live locked subtrees (blobs directly in the folder) land under their old
    // parents (or the container); encrypted ARCHIVE blobs re-lock into their
    // mapped archive folder. One that can't move stays in the old folder.
    const relock = { moved: 0, left: [] as string[], plaintext: [] as string[] };
    {
      const blobs = app.vault.getFiles().filter((f) => f.extension === "stashenc"
        && (f.parent?.path === src || f.path.startsWith(`${src}/archive/`)));
      for (const b of blobs) {
        const mappedBlob = b.path.startsWith(`${src}/archive/`) ? mapPath(b.path) : null;
        const blobFolder = mappedBlob ? mappedBlob.slice(0, mappedBlob.lastIndexOf("/")) : undefined;
        if (blobFolder) await ensureFolder(app, blobFolder, createdDirs);
        const r = await plugin.relockBundleInto(b.path, dest, { reparentTo: container.id, blobFolder, parentRemap: idRemap });
        const label = b.basename;
        if (r.status === "moved" && r.undo) {
          relock.moved++;
          undoSteps.push({ label: `put “${label}” back under the old key`, run: r.undo });
          if (r.oldRootId && r.rootId && r.oldRootId !== r.rootId) idRemap[r.oldRootId] = r.rootId;
        }
        else if (r.status === "plaintext") relock.plaintext.push(`${label}: ${r.reason}`);
        else relock.left.push(`${label}: ${r.reason}`);
      }
    }

    // ---- 4. Archive + trash ------------------------------------------------
    // Plaintext archive notes move as files. Trash moves whole — encrypted
    // trash blobs included: their sidecar names the key by id, and that key
    // stays with the archived folder, so they still restore (with the old
    // folder's password). Anything still encrypted in the archive at this point
    // failed to re-lock and stays behind.
    for (const kind of ["archive", "trash"] as const) {
      const from = `${src}/${kind}`;
      const files = app.vault.getFiles().filter((f) => f.path.startsWith(`${from}/`)
        && (kind === "trash" ? f.extension !== "stashkey" : !isEncryptedFile(app, f)));
      for (const f of files) {
        const to = mapPath(f.path);
        if (to) await moveFile(f.path, to);
      }
    }

    // Archived notes that were top-level in the old folder now belong under the
    // container, so un-archiving one puts it back with the rest of the folder.
    {
      const reparented: string[] = [];
      for (const m of moved) {
        if (!m.to.endsWith(".md") || !m.to.startsWith(`${dest}/archive/`)) continue;
        const f = app.vault.getAbstractFileByPath(m.to);
        if (!(f instanceof TFile)) continue;
        const { fm } = splitFrontmatter(await app.vault.read(f));
        if (fm.parent !== ROOT_ID && fm.parent !== null && fm.parent !== undefined) continue;
        await app.fileManager.processFrontMatter(f, (x) => { x.parent = container.id; });
        reparented.push(m.to);
      }
      undoSteps.push({
        label: "put archived notes back at the top level",
        run: async () => {
          for (const path of reparented) {
            const f = app.vault.getAbstractFileByPath(path);
            if (f instanceof TFile) await app.fileManager.processFrontMatter(f, (x) => { x.parent = ROOT_ID; });
          }
        },
      });
    }

    // ---- 5. Leftover attachments + author stubs ---------------------------
    {
      const attFrom = `${src}/_attachments`;
      const atts = app.vault.getFiles().filter((f) => f.path.startsWith(`${attFrom}/`) && !isEncryptedFile(app, f));
      if (atts.length) {
        const base = await uniqueFolderPath(app, `${dest}/_attachments/${sub}`);
        for (const f of atts) await moveFile(f.path, `${base}/${f.path.slice(attFrom.length + 1)}`);
      }
      const authFrom = `${src}/_authors`;
      for (const f of app.vault.getFiles().filter((x) => x.parent?.path === authFrom && x.extension === "md")) {
        const to = `${dest}/_authors/${f.name}`;
        if (await app.vault.adapter.exists(to)) continue; // the destination already has this author
        await moveFile(f.path, to);
      }
    }

    // ---- 6. Archive the emptied folder — LAST ------------------------------
    // Whatever is still encrypted in the old folder now stays with it.
    const stillLocked = app.vault.getFiles().filter((f) => f.path.startsWith(`${src}/`) && f.extension === "stashenc"
      && !/(^|\/)trash(\/|$)/.test(f.path.slice(src.length + 1))).length;
    const shellBase = `${FOLDED_SHELL_ROOT}/${name}${stillLocked ? ` (${stillLocked} locked note${stillLocked === 1 ? "" : "s"})` : ""}`;
    await ensureFolder(app, FOLDED_SHELL_ROOT, createdDirs);
    const shell = await uniqueFolderPath(app, shellBase);
    const priorPlacement = plugin.folderPlacement(src);
    plugin.closeStashpadTabsFor(src);
    await plugin.prunePlacementFor(src);
    // Pushed BEFORE the rename so a failed rename still gets its placement back.
    // Only THIS folder's placement — never a whole-list snapshot, which would
    // revert unrelated pins made in the meantime.
    undoSteps.push({ label: "restore the folder switcher placement", run: () => plugin.setFolderPlacement(src, priorPlacement) });
    plugin.suppressFolderDelete(src);
    plugin.knownStashpadFolders.delete(src);
    await app.vault.adapter.rename(src, shell);
    // Settings that name the old path: the default folder follows the content
    // to the destination; locked-subtree records follow their blobs to the shell.
    const wasDefault = clean(plugin.settings.folder || "") === src;
    if (wasDefault) plugin.settings.folder = dest;
    remapLockedRegistry(plugin, src, shell);
    await plugin.saveSettings();
    undoSteps.push({
      label: "restore the default folder + locked records",
      run: async () => {
        // Targeted: only what this fold changed, so later edits survive.
        if (wasDefault && clean(plugin.settings.folder || "") === dest) plugin.settings.folder = src;
        remapLockedRegistry(plugin, shell, src);
        await plugin.saveSettings();
      },
    });
    undoSteps.push({
      label: "bring the old folder back",
      critical: true,
      run: async () => {
        if (await app.vault.adapter.exists(src)) throw new Error(`“${src}” exists again`);
        if (!(await app.vault.adapter.exists(shell))) throw new Error(`the archived folder “${shell}” is gone`);
        plugin.suppressFolderDelete(shell);
        await app.vault.adapter.rename(shell, src);
        plugin.invalidateStashpadFoldersMemo();
        // Its key moved back too — re-find it (see the forward step's note).
        if (await app.vault.adapter.exists(`${src}/.stashkey`)) {
          try { await plugin.encryption.forceFullKeyScan(); } catch (e) { console.warn("[Stashpad] fold undo: key re-scan failed", e); }
        }
      },
    });

    const manifest: FoldManifest = {
      v: 1, at: new Date().toISOString(), src, dest, shell,
      containerId: container.id, containerPath: container.path, settingsNotePath,
      movedRootIds, idRemap, moved: moved.slice(), noteCount,
      leftBehind: { lockedSubtrees: stillLocked, encryptedFiles },
      relocked: relock.moved, relockProblems: [...relock.left, ...relock.plaintext],
      dirMap: dirMap.filter((d) => moved.some((m) => m.to.startsWith(`${d.to}/`))
        || app.vault.getFiles().some((f) => f.path.startsWith(`${d.to}/`))),
      placement: priorPlacement, wasDefault,
    };
    try { await app.vault.adapter.write(`${shell}/${FOLD_MANIFEST}`, JSON.stringify(manifest, null, 2)); }
    catch (e) { console.warn("[Stashpad] fold: couldn't write the manifest", e); }

    // Redirect for old deep links (synced via data.json).
    const redirects = { ...(plugin.settings.foldedFolders ?? {}) };
    redirects[src] = { into: dest, containerId: container.id, shell, at: manifest.at, ...(Object.keys(idRemap).length ? { idRemap } : {}) };
    plugin.settings.foldedFolders = redirects;
    await plugin.saveSettings();
    undoSteps.push({
      label: "forget the link redirect",
      run: async () => {
        const r = { ...(plugin.settings.foldedFolders ?? {}) };
        if (r[src]?.at === manifest.at) delete r[src];
        plugin.settings.foldedFolders = r;
        await plugin.saveSettings();
      },
    });
    plugin.invalidateStashpadFoldersMemo();
    plugin.refreshOpenViewsForFolder(dest);
    // The old folder's .stashkey moved with it: re-index so encrypted trash
    // (resolved by key id) and anything left locked find it at the new path.
    // A FULL scan, not refreshStashKeyIndex: the refresh's registry fast path only
    // re-reads folders it already knows, so it never finds the key at its new
    // path (seen live: the moved trash blob's keyId resolved to nothing).
    if (await app.vault.adapter.exists(`${shell}/.stashkey`)) {
      try { await plugin.encryption.forceFullKeyScan(); } catch (e) { console.warn("[Stashpad] fold: key re-scan failed", e); }
    }
    if (relock.plaintext.length) {
      notify(`⚠️ Fold: ${relock.plaintext.length} locked note${relock.plaintext.length === 1 ? " is" : "s are"} now UNLOCKED in “${baseName(dest)}” — re-locking failed. Lock ${relock.plaintext.length === 1 ? "it" : "them"} by hand:\n${relock.plaintext.join("\n")}`, { duration: 0 });
    }

    let undone = false;
    const undo = async (): Promise<void> => {
      if (undone) { notify(`The fold of “${name}” was already undone.`); return; }
      // Still THIS fold? An Unfold (or a new folder at the old path) since then
      // makes every step below wrong — and some of them overwrite newer files.
      const live = plugin.settings.foldedFolders?.[src]?.at === manifest.at
        && await app.vault.adapter.exists(shell) && !(await app.vault.adapter.exists(src));
      if (!live) {
        undone = true;
        notify(`Nothing to undo: “${name}” was unfolded or changed since this fold.`);
        return;
      }
      undone = true;
      const { failed, aborted } = await rollback();
      plugin.invalidateStashpadFoldersMemo();
      plugin.refreshOpenViewsForFolder(dest);
      plugin.refreshOpenViewsForFolder(src);
      notify(aborted
        ? `Stopped undoing the fold of “${name}”: ${failed[failed.length - 1]} failed, and the rest depends on it. Nothing else was changed — see the console.`
        : failed.length
          ? `Undid the fold of “${name}”, but some steps failed (${failed.join(", ")}) — see the console.`
          : `Undid the fold: “${name}” is back as its own Stashpad.`);
    };
    return { manifest, undo };
  } catch (e) {
    console.error("[Stashpad] fold failed — rolling back", e);
    const { failed } = await rollback();
    plugin.invalidateStashpadFoldersMemo();
    plugin.refreshOpenViewsForFolder(dest);
    plugin.refreshOpenViewsForFolder(src);
    notify(`Couldn't fold “${name}”: ${(e as Error).message}. ${failed.length ? `Rolling back also hit problems (${failed.join(", ")}) — see the console.` : "Nothing was changed."}`, { duration: 0 });
    return null;
  }
}

/** One step of an undo/rollback. `critical`: if it fails, stop — the steps
 *  still to run assume it worked. */
export type UndoStep = { label: string; critical?: boolean; run: () => Promise<void> };

/** Run undo steps newest-first. Stops at a failed critical step. */
export async function runUndoSteps(steps: UndoStep[]): Promise<{ failed: string[]; aborted: boolean }> {
  const failed: string[] = [];
  for (const step of [...steps].reverse()) {
    try { await step.run(); }
    catch (e) {
      console.warn("[Stashpad] undo step failed:", step.label, e);
      failed.push(step.label);
      if (step.critical) return { failed, aborted: true };
    }
  }
  return { failed, aborted: false };
}

/** Repoint locked-subtree records (and their blob paths) from folder `from`
 *  (and anything under it) to `to`. Only matching entries change. */
export function remapLockedRegistry(plugin: StashpadPlugin, from: string, to: string): void {
  const under = (p: string): boolean => p === from || p.startsWith(`${from}/`);
  plugin.settings.lockedSubtrees = (plugin.settings.lockedSubtrees ?? []).map((l) => {
    const f = clean(l.folder);
    if (!under(f)) return l;
    return { ...l, folder: to + f.slice(from.length), blob: l.blob.startsWith(`${from}/`) ? `${to}/${l.blob.slice(from.length + 1)}` : l.blob };
  });
}

/** Move re-encrypt-watchlist entries for notes that moved from `from` to `to`
 *  (`only`: limit to these root ids; null = every entry of `from`), following
 *  `idRemap`. Returns the undo step that moves exactly those entries back. */
export function transferReEncryptWatch(
  plugin: StashpadPlugin, from: string, to: string, only: Set<string> | null, idRemap: Record<string, string>,
): UndoStep {
  const moved: Array<{ oldId: string; newId: string }> = [];
  plugin.settings.reEncryptWatch = (plugin.settings.reEncryptWatch ?? []).map((w) => {
    if (clean(w.folder) !== from || (only && !only.has(String(w.rootId)))) return w;
    const newId = idRemap[String(w.rootId)] ?? String(w.rootId);
    moved.push({ oldId: String(w.rootId), newId });
    return { ...w, folder: to, rootId: newId };
  });
  if (moved.length) void plugin.saveSettings();
  return {
    label: "move the re-encrypt reminders back",
    run: async () => {
      if (!moved.length) return;
      plugin.settings.reEncryptWatch = (plugin.settings.reEncryptWatch ?? []).map((w) => {
        const hit = clean(w.folder) === to ? moved.find((m) => m.newId === String(w.rootId)) : undefined;
        return hit ? { ...w, folder: from, rootId: hit.oldId } : w;
      });
      await plugin.saveSettings();
    },
  };
}

/** The Home note's body minus its default title, so a Home with real text keeps
 *  that text (it lands in the container note). */
async function homeBodyExtra(app: App, file: TFile, folderName: string): Promise<string> {
  try {
    const { body } = splitFrontmatter(await app.vault.read(file));
    const lines = body.replace(/\s+$/, "").split("\n");
    const first = (lines[0] ?? "").replace(/^#+\s*/, "").trim();
    if (first === "Home" || first === folderName || first === "") lines.shift();
    return lines.join("\n").trim();
  } catch { return ""; }
}

export async function trashPath(app: App, path: string): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (f) await app.fileManager.trashFile(f);
}

// ------------------------------------------------------------------ UI ----

/** Pick the destination Stashpad (Sift-matched, archives and the source left out). */
export class FoldTargetModal extends SuggestModal<string> {
  constructor(app: App, private plugin: StashpadPlugin, private src: string, private onPick: (dest: string) => void) {
    super(app);
    this.setPlaceholder(`Fold “${baseName(src)}” into…`);
  }
  getSuggestions(query: string): string[] {
    const q = query.trim();
    return this.plugin.discoverStashpadFolders()
      .map(clean)
      .filter((f) => f !== this.src && !this.plugin.isArchiveFolder(f) && !f.startsWith(`${this.src}/`) && !this.src.startsWith(`${f}/`))
      .filter((f) => !q || siftMatch(q, f));
  }
  renderSuggestion(folder: string, el: HTMLElement): void {
    el.createDiv({ text: baseName(folder) });
    if (folder.includes("/")) el.createEl("small", { text: folder, cls: "stashpad-fold-target-path" });
  }
  onChooseSuggestion(folder: string): void { this.onPick(folder); }
}

/** Confirm before folding: names both folders, the note count and where the
 *  old folder goes. */
export class FoldConfirmModal extends Modal {
  private chose = false;
  constructor(
    app: App, private src: string, private dest: string,
    private counts: { notes: number; locked: number; destCanLock: boolean },
    private onConfirm: () => void,
  ) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("stashpad-compact-modal");
    this.titleEl.setText(`Fold “${baseName(this.src)}” into “${baseName(this.dest)}”?`);
    const c = this.contentEl;
    const n = this.counts.notes;
    c.createEl("p", { text: (n
      ? `${n} top-level note${n === 1 ? "" : "s"} move under a new note called “${baseName(this.src)}”, with their children and attachments.`
      : `It has no notes of its own; a note called “${baseName(this.src)}” is still made here to hold its settings.`)
      + ` Its archive and trash join this folder's, under “${FOLD_SUBFOLDER_PREFIX}${baseName(this.src)}”.` });
    c.createEl("p", { text: `Its folder settings are listed in a note pinned to the bottom. The emptied folder moves to “${FOLDED_SHELL_ROOT}”, and old links to it open the new place.` });
    const k = this.counts.locked;
    if (k) {
      const what = `${k} locked (encrypted) note${k === 1 ? "" : "s"}`;
      c.createEl("p", {
        cls: "mod-warning",
        text: this.counts.destCanLock
          ? `${what} will be unlocked with “${baseName(this.src)}”'s key and locked again with “${baseName(this.dest)}”'s — you may be asked for either password. Any that can't be moved stay in the archived folder, which keeps its key.`
          : `“${baseName(this.dest)}” has no encryption set up, so ${what} stay in the archived folder, which keeps its key.`,
      });
    }
    c.createEl("p", { text: "You can undo this.", cls: "setting-item-description" });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Fold").setCta().onClick(() => { this.chose = true; this.close(); this.onConfirm(); }));
  }
  onClose(): void { this.contentEl.empty(); void this.chose; }
}

/** Entry point for the command and the folder-switcher menu: pick (unless
 *  given) → confirm → fold → notify with Undo / Open. */
export async function runFoldFlow(plugin: StashpadPlugin, srcRaw: string | null, destRaw?: string): Promise<void> {
  const src = clean(srcRaw ?? "");
  if (!src) { notify("Open the Stashpad you want to fold first."); return; }
  const go = async (dest: string): Promise<void> => {
    const refusal = foldRefusal(plugin, src, dest);
    if (refusal) { notify(refusal); return; }
    const nodes = await readFolderSubtreeNodes(plugin.app, src);
    const ids = new Set(nodes.map((n) => String(n.id)));
    const notes = nodes.filter((n) => n.id !== ROOT_ID && (n.parent === null || n.parent === ROOT_ID || !ids.has(String(n.parent)))).length;
    const locked = plugin.app.vault.getFiles().filter((f) => f.extension === "stashenc"
      && (f.parent?.path === src || f.path.startsWith(`${src}/archive/`))).length;
    const destCanLock = !!plugin.encryption?.hasFolderKey?.(dest);
    new FoldConfirmModal(plugin.app, src, dest, { notes, locked, destCanLock }, () => void (async () => {
      const res = await foldStashpadFolder(plugin, src, dest);
      if (!res) return;
      const m = res.manifest;
      plugin.getUndoStack(dest).push({ label: `Fold “${baseName(src)}” into this folder`, undo: res.undo });
      plugin.notifications.show({
        message: `Folded **${baseName(src)}** into **${baseName(dest)}** — ${m.noteCount} note${m.noteCount === 1 ? "" : "s"} moved.`
          + (m.relocked ? ` ${m.relocked} locked note${m.relocked === 1 ? "" : "s"} re-locked with this folder's key.` : "")
          + (m.leftBehind.lockedSubtrees ? ` ${m.leftBehind.lockedSubtrees} locked note${m.leftBehind.lockedSubtrees === 1 ? "" : "s"} stayed in the archived folder${m.relockProblems?.length ? ` (${m.relockProblems.join("; ")})` : ""}.` : ""),
        kind: "success", category: "move", folder: dest, duration: 0,
        actions: [
          { label: "Undo", onClick: () => void res.undo() },
          { label: "Open", onClick: () => void plugin.openDeepLinkTarget(dest, m.containerId, {}) },
        ],
      });
      void plugin.openDeepLinkTarget(dest, m.containerId, {});
    })()).open();
  };
  if (destRaw) { await go(clean(destRaw)); return; }
  new FoldTargetModal(plugin.app, plugin, src, (d) => void go(d)).open();
}
