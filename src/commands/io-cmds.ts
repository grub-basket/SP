import { FuzzySuggestModal, Notice, TFile, moment } from "obsidian";
import { ROOT_ID, type StashpadId, type TreeNode } from "../types";
import { buildStashZip, importStashZip, STASH_EXT } from "../stash-package";
import { argon2Available, encryptStash, resolveStashBytes, STASH_KDF_INFO } from "../stash-crypto";
import { secretIdForStashName } from "../passphrase";
import { ExportStashModal, OkfExportModal } from "../modals";
import type { StashpadView } from "../view";

/** .stash import/export command group extracted from StashpadView
 *  (view-split stage 5). Free functions taking the view. Behavior is
 *  identical to when these lived inline as `cmd*` methods. */

/** Sanitize a user-supplied export base name to a safe filename stem. */
function safeBaseName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 60) || "stash-export";
}

export async function cmdExportStash(view: StashpadView, rootNode?: TreeNode): Promise<void> {
  const roots = collectExportRoots(view, rootNode);
  if (roots.length === 0) { new Notice("Nothing to export."); return; }
  const all = collectExportSubtree(view, roots);
  if (all.length === 0) { new Notice("No exportable notes (no files attached)."); return; }
  // 0.59.0: multi-note exports include the source folder name so the
  // exported filename tells you where it came from. Single-note exports use
  // the note's title since it's already unique.
  const folderTag = (view.noteFolder.split("/").pop() || view.noteFolder).trim();
  const defaultBase = roots.length === 1
    ? view.titleForNode(roots[0])
    : `${folderTag}-${roots.length}notes`;
  // 0.84.2: confirm name (+ later: optional encryption) in a modal first.
  new ExportStashModal(view.app, defaultBase, all.length, (chosen, password, remember) => {
    void runExport(view, roots, all, chosen, password, remember);
  }, argon2Available).open();
}

/** Export the selection/cursor subtree as an OKF bundle (.zip / .tar.gz) and/or a
 *  Stashpad .stash, via plugin.exportOkf. */
export async function cmdExportOkf(view: StashpadView, rootNode?: TreeNode): Promise<void> {
  const roots = collectExportRoots(view, rootNode);
  if (roots.length === 0) { new Notice("Nothing to export."); return; }
  const all = collectExportSubtree(view, roots);
  if (all.length === 0) { new Notice("No exportable notes."); return; }
  const folderTag = (view.noteFolder.split("/").pop() || view.noteFolder).trim();
  const defaultBase = roots.length === 1 ? view.titleForNode(roots[0]) : `${folderTag}-okf`;
  new OkfExportModal(view.app, defaultBase, all.length, (base, formats) => {
    void (async () => {
      try {
        const written = await view.plugin.exportOkf(view.noteFolder, roots.map((r) => r.id), base, formats);
        if (!written.length) { new Notice("Nothing exported."); return; }
        view.plugin.notifications.show({
          message: `Exported OKF — ${written.length} file${written.length === 1 ? "" : "s"} → \`${view.noteFolder}/${(view.plugin.settings.exportFolder || "_exports")}\``,
          kind: "success", category: "export", affectedPaths: written, folder: view.noteFolder, duration: 0,
        });
        await view.log.append({ type: "stash_export", id: roots[0].id, payload: { okf: true, paths: written, noteCount: all.length, rootIds: roots.map((r) => r.id) } });
      } catch (e) { new Notice(`OKF export failed: ${(e as Error).message}`); console.error(e); }
    })();
  }).open();
}

/** Build + write the .stash with the chosen base name, optionally encrypted,
 *  then notify. */
async function runExport(view: StashpadView, roots: TreeNode[], all: TreeNode[], baseName: string, password: string | null, remember = false): Promise<void> {
  try {
    let buf = await buildStashZip(view.app, {
      rootNotes: roots.filter((n) => !!n.file).map((n) => ({ id: n.id, file: n.file! })),
      allDescendants: all
        .filter((n) => !roots.some((r) => r.id === n.id))
        .filter((n) => !!n.file)
        .map((n) => ({ id: n.id, file: n.file! })),
      sourceFolder: view.noteFolder,
    });
    // 0.84.3: wrap the zip in an AES-GCM envelope when a password was set.
    // 0.84.15: surface which KDF was actually used (Argon2id, or the weaker
    // PBKDF2 fallback if Argon2's WASM couldn't run here).
    let encNote = "";
    if (password) {
      const enc = await encryptStash(buf, password);
      buf = enc.data;
      const info = STASH_KDF_INFO[enc.kdf];
      encNote = info.strong
        ? ` (encrypted · ${info.label})`
        : ` (encrypted · ${info.label} — Argon2id unavailable on this device, this export is weaker)`;
    }
    const stamp = (moment as any)().format("YYYYMMDD-HHmmss");
    const safe = safeBaseName(baseName);
    const exportSub = (view.plugin.settings.exportFolder || "_exports").trim().replace(/^\/+|\/+$/g, "");
    const exportFolder = `${view.noteFolder}/${exportSub}`;
    await view.ensureFolder(exportFolder);
    const outBase = `${safe}-${stamp}`;
    const outPath = `${exportFolder}/${outBase}.${STASH_EXT}`;
    await view.app.vault.createBinary(outPath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    // 0.85.4: optionally remember the passphrase in this vault's secret storage
    // (OS keychain), keyed deterministically by the filename so re-import on
    // this device can look it up. Best-effort — a keychain failure must not
    // fail the export (the file is already written + encrypted).
    if (remember && password) {
      const ss = (view.app as { secretStorage?: { setSecret(id: string, v: string): void } }).secretStorage;
      try { ss?.setSecret(secretIdForStashName(outBase), password); }
      catch (e) { console.warn("[Stashpad] couldn't save export passphrase to secret storage", e); }
    }
    await view.log.append({
      type: "stash_export",
      id: roots[0].id,
      payload: { path: outPath, noteCount: all.length, rootIds: roots.map((r) => r.id) },
    });
    view.plugin.notifications.show({
      message: `Exported ${all.length} note${all.length === 1 ? "" : "s"}${encNote} → \`${outPath}\``,
      kind: password && encNote.includes("weaker") ? "warning" : "success",
      category: "export",
      affectedPaths: [outPath],
      folder: view.noteFolder,
      actions: view.actionsForFile(outPath),
      // 0.59.0: export toast stays open until user dismisses. With
      // keepOpen:true on the file actions, the user often wants to
      // click Reveal, glance, come back, and click Show in OS. The
      // 4s auto-dismiss was cutting that flow short.
      duration: 0,
    });
  } catch (e) {
    view.plugin.notifications.show({
      message: `Stashpad: export failed\nError: ${(e as Error).message}\nCheck disk space + write permissions on the export folder.`,
      kind: "error",
      category: "export",
    });
    console.error(e);
  }
}

function collectExportRoots(view: StashpadView, node?: TreeNode): TreeNode[] {
  if (node?.file) return [node];
  if (view.selection.size > 0) {
    return [...view.selection]
      .map((id) => view.tree.get(id))
      .filter((n): n is TreeNode => !!n?.file);
  }
  if (view.cursorIdx >= 0 && view.currentChildren[view.cursorIdx]) {
    return [view.currentChildren[view.cursorIdx]];
  }
  const focused = view.tree.get(view.focusId);
  return focused?.file ? [focused] : [];
}

function collectExportSubtree(view: StashpadView, roots: TreeNode[]): TreeNode[] {
  const seen = new Set<StashpadId>();
  const out: TreeNode[] = [];
  const walk = (n: TreeNode): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (n.file) out.push(n);
    for (const c of view.tree.getChildren(n.id)) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** Import a .stash file from anywhere in the vault into the current Stashpad folder. */
export async function cmdImportStash(view: StashpadView): Promise<void> {
  const files = view.app.vault.getFiles().filter((f) => f.extension === STASH_EXT);
  if (files.length === 0) { new Notice("No .stash files found in this vault."); return; }
  const modal = new (class extends FuzzySuggestModal<TFile> {
    getItems(): TFile[] { return files; }
    getItemText(f: TFile): string { return f.path; }
    onChooseItem(f: TFile): void { void processStashFile(view, f); }
  })(view.app);
  modal.setPlaceholder("Pick a .stash file to import…");
  modal.open();
}

export async function processStashFile(view: StashpadView, file: TFile): Promise<void> {
  try {
    const raw = new Uint8Array(await view.app.vault.readBinary(file));
    // 0.84.3: if encrypted, prompt + decrypt before the unchanged import path.
    // 0.85.4: try a passphrase remembered for this filename first (silent).
    const buf = await resolveStashBytes(view.app, raw, { secretId: secretIdForStashName(file.basename) });
    if (!buf) return; // user cancelled the password prompt — leave the file as-is
    const summary = await importStashZip(view.app, buf, view.noteFolder, collectExistingIds(view));
    view.tree.rebuild(view.noteFolder);
    view.render();
    await view.log.append({
      type: "stash_import",
      id: ROOT_ID,
      payload: {
        from: file.path, into: view.noteFolder,
        noteCount: summary.notesWritten,
        attachmentsWritten: summary.attachmentsWritten,
        collisionsRenamed: summary.collisionsRenamed,
      },
    });
    // Send the source .stash to trash on success (respects user's deleted-files setting).
    try { await view.app.fileManager.trashFile(file); } catch {}
    // 0.84.17: if this bundle was parked + a "Remind me later" reminder is
    // pending for it, drop it from the queue so the reminder never resurfaces.
    view.plugin.importService.clearPendingEncrypted(file.path);
    const parts = [`Imported ${summary.notesWritten} note${summary.notesWritten === 1 ? "" : "s"}`];
    if (summary.attachmentsWritten) parts.push(`+ ${summary.attachmentsWritten} attachment${summary.attachmentsWritten === 1 ? "" : "s"}`);
    if (summary.collisionsRenamed) parts.push(`(${summary.collisionsRenamed} id collision${summary.collisionsRenamed === 1 ? "" : "s"} renamed)`);
    view.plugin.notifications.show({
      message: parts.join(" "),
      kind: "success",
      category: "import",
      folder: view.noteFolder,
    });
  } catch (e) {
    view.plugin.notifications.show({
      message: `Stashpad: import failed\nFile: \`${file.name}\`\nError: ${(e as Error).message}\nInspect with the buttons below — rename to .zip to crack it open in an archive tool.`,
      kind: "error",
      category: "import",
      affectedPaths: [file.path],
      // Reveal/Show actions on the source .stash so the user can
      // inspect the bad bundle. Failure path doesn't trash the file
      // (only success does), so it's still there to inspect.
      actions: view.actionsForFile(file.path),
    });
    console.error(e);
  }
}

function collectExistingIds(view: StashpadView): Set<StashpadId> {
  const out = new Set<StashpadId>();
  const walk = (id: StashpadId): void => {
    out.add(id);
    const node = view.tree.get(id);
    if (!node) return;
    for (const c of view.tree.getChildren(id)) walk(c.id);
  };
  walk(ROOT_ID);
  return out;
}
