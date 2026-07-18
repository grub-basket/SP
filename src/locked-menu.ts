import { App, Menu, Notice, Platform } from "obsidian";
import type StashpadPlugin from "./main";
import { buildStashpadLink } from "./deep-link";
import { ConfirmModal } from "./modals";

/** Normalised descriptor for a locked (`.stashenc`) bundle, shared by every
 *  locked-menu site (the folder-view `openLockedMenu` and the two aggregate
 *  locked-row menus). Collapses the old `lk` / `LockedEntry` shapes. */
export interface LockedDescriptor {
  blob: string;
  rootId?: string | null;
  count: number;
  /** Folder used for the deep-link target AND for undo-stack ownership. */
  folder: string;
}

/** Delete a locked bundle — the `.stashenc` ciphertext + its `.stashmeta`
 *  sidecar — to Obsidian's trash, recoverable via the folder's undo stack.
 *  Single source of truth for all three locked-menu sites (was triplicated).
 *
 *  Captures the bytes + sidecar + registry entry BEFORE removing anything so
 *  undo can fully restore. `onChange` repaints the caller's view. */
export async function deleteLockedBundleWithUndo(
  app: App,
  plugin: StashpadPlugin,
  d: LockedDescriptor,
  onChange: () => void,
): Promise<void> {
  const blobPath = d.blob;
  const metaPath = blobPath.replace(/\.stashenc$/, ".stashmeta");
  const adapter = app.vault.adapter;
  let blobData: ArrayBuffer | null = null;
  let metaData: string | null = null;
  try { blobData = await adapter.readBinary(blobPath); } catch { blobData = null; }
  if (!blobData) { new Notice("Couldn't read the encrypted file to delete it."); return; }
  try { if (await adapter.exists(metaPath)) metaData = await adapter.read(metaPath); } catch { metaData = null; }
  const prevEntry = (plugin.settings.lockedSubtrees ?? []).find((x) => x.blob === blobPath) ?? null;

  // Trash both files: Obsidian trash when the TFile is indexed (recoverable
  // there), adapter.remove as a fallback when the index lags. Contents are
  // captured above, so the undo entry can restore either way.
  const trashByPath = async (path: string): Promise<void> => {
    const tf = app.vault.getAbstractFileByPath(path);
    if (tf) { try { await app.fileManager.trashFile(tf); return; } catch { /* fall through */ } }
    try { if (await adapter.exists(path)) await adapter.remove(path); } catch { /* non-fatal */ }
  };
  const doDelete = async (): Promise<void> => {
    await trashByPath(blobPath);
    await trashByPath(metaPath);
    plugin.settings.lockedSubtrees = (plugin.settings.lockedSubtrees ?? []).filter((x) => x.blob !== blobPath);
    await plugin.saveSettings();
    onChange();
  };
  const doRestore = async (): Promise<void> => {
    await adapter.writeBinary(blobPath, blobData!);
    if (metaData != null) { try { await adapter.write(metaPath, metaData); } catch { /* non-fatal */ } }
    if (prevEntry && !(plugin.settings.lockedSubtrees ?? []).some((x) => x.blob === blobPath)) {
      plugin.settings.lockedSubtrees = [...(plugin.settings.lockedSubtrees ?? []), prevEntry];
      await plugin.saveSettings();
    }
    onChange();
  };

  await doDelete();
  plugin.getUndoStack(d.folder).push({
    label: d.count > 1 ? "Delete encrypted notes" : "Delete encrypted note",
    undo: doRestore,
    redo: doDelete,
  });
  new Notice(d.count > 1 ? "Encrypted notes deleted — undo to restore." : "Encrypted note deleted — undo to restore.");
}

export interface LockedMenuConfig {
  app: App;
  plugin: StashpadPlugin;
  descriptor: LockedDescriptor;
  /** Unlock item label — "Decrypt (unlock)" (in place) or "Unlock & restore". */
  unlockLabel: string;
  /** What the unlock item does (in-place decrypt vs restore-to-parent). */
  onUnlock: () => void;
  /** Repaint after a delete / change. */
  onChange: () => void;
  /** Folder view (true) renders the full openNoteMenu-parity item set including
   *  the "unlock first" notice mirrors; the aggregate rows (false) render the
   *  trimmed set. This flag selects between the two exact layouts. */
  fullParity: boolean;
  /** Folder view confirms before delete; aggregate relies on undo. */
  confirmDelete: boolean;
}

/** Populate `menu` with the locked-bundle action set. The single builder behind
 *  `openLockedMenu` (view.ts) and `attachLockedRowMenu` (aggregate-view.ts).
 *  Copy-link + exports are always grouped under a "Share & export ▸" submenu. */
export function populateLockedMenu(menu: Menu, cfg: LockedMenuConfig): void {
  const { app, plugin, descriptor: d } = cfg;
  const unlockFirst = (verb: string): Notice => new Notice(`Unlock this note first to ${verb}.`);
  const fullPathOf = (p: string): string => {
    if (Platform.isMobile) return p;
    try { return (app.vault.adapter as unknown as { getFullPath?: (x: string) => string })?.getFullPath?.(p) || p; } catch { return p; }
  };
  const copyLink = (): void => {
    const link = buildStashpadLink({ vault: app.vault.getName(), folder: d.folder, note: d.rootId!, run: ["reveal"] });
    void navigator.clipboard.writeText(link).then(() => new Notice("Stashpad link copied."), () => new Notice("Couldn't copy the link."));
  };

  // Shared item factories -----------------------------------------------------
  const addShareSubmenu = (): void => {
    menu.addItem((i: any) => {
      i.setTitle("Share & export").setIcon("share-2");
      const sub = typeof i.setSubmenu === "function" ? i.setSubmenu() : null;
      if (sub && typeof sub.addItem === "function") {
        sub.addItem((s: any) => { s.setTitle("Copy Stashpad link").setIcon("link"); if (d.rootId) s.onClick(() => copyLink()); else s.setDisabled(true); });
        sub.addItem((s: any) => s.setTitle("Export to .stash…").setIcon("package").onClick(() => { void plugin.exportLockedSubtree(d.blob); }));
        if (plugin.settings.okfEnabled) sub.addItem((s: any) => s.setTitle("Export as OKF…").setIcon("book-marked").onClick(() => unlockFirst("export it as OKF")));
      } else if (d.rootId) {
        i.onClick(() => copyLink()); // degraded (no setSubmenu — never on the 1.13 floor)
      } else {
        i.setDisabled(true);
      }
    });
  };
  const addUnlock = (): void => { menu.addItem((i: any) => i.setTitle(cfg.unlockLabel).setIcon("unlock").onClick(() => cfg.onUnlock())); };
  const addShowInFinder = (): void => {
    if (Platform.isMobile) return;
    const osManager = Platform.isMacOS ? "Finder" : Platform.isWin ? "File Explorer" : "file manager";
    menu.addItem((i: any) => i.setTitle(`Show in ${osManager}`).setIcon("folder-search").onClick(() => {
      try {
        const shell = (window as unknown as { require?: (m: string) => { shell?: { showItemInFolder?: (p: string) => void } } }).require?.("electron")?.shell;
        const fullPath = (app.vault.adapter as unknown as { getFullPath?: (x: string) => string })?.getFullPath?.(d.blob);
        if (fullPath && shell?.showItemInFolder) shell.showItemInFolder(fullPath);
      } catch (err) { console.warn("[Stashpad] showItemInFolder failed", err); }
    }));
  };
  const addCopyPath = (): void => {
    menu.addItem((i: any) => i.setTitle("Copy encrypted file path").setIcon("copy").onClick(() => {
      void navigator.clipboard.writeText(fullPathOf(d.blob));
      new Notice("Path copied.");
    }));
  };
  const addDelete = (): void => {
    menu.addItem((i: any) => {
      i.setTitle(d.count > 1 ? "Delete encrypted notes…" : "Delete encrypted note…").setIcon("trash-2");
      i.setWarning?.(true);
      i.onClick(() => {
        if (cfg.confirmDelete) {
          new ConfirmModal(
            app,
            d.count > 1 ? `Delete ${d.count} encrypted notes?` : "Delete encrypted note?",
            "The encrypted file moves to Obsidian's trash (recoverable there). You'll still need your password to read it if you restore it.",
            "Delete",
            async (ok: boolean) => { if (ok) await deleteLockedBundleWithUndo(app, plugin, d, cfg.onChange); },
          ).open();
        } else {
          void deleteLockedBundleWithUndo(app, plugin, d, cfg.onChange);
        }
      });
    });
  };

  // Two exact layouts ---------------------------------------------------------
  if (cfg.fullParity) {
    // Folder-view locked row: full openNoteMenu parity. Actions that need the
    // decrypted note show an "unlock first" notice; the rest act on ciphertext.
    menu.addItem((i: any) => i.setTitle("Open in new Stashpad tab").setIcon("layout-grid").onClick(() => unlockFirst("open it in a tab")));
    menu.addItem((i: any) => i.setTitle("Open in Obsidian editor").setIcon("file-text").onClick(() => unlockFirst("open it in the editor")));
    menu.addItem((i: any) => i.setTitle("Focus in Stashpad").setIcon("arrow-right").onClick(() => unlockFirst("focus it")));
    menu.addSeparator();
    menu.addItem((i: any) => i.setTitle("Split note…").setIcon("split").onClick(() => unlockFirst("split it")));
    menu.addItem((i: any) => i.setTitle("Copy text").setIcon("copy").onClick(() => unlockFirst("copy its text")));
    menu.addItem((i: any) => i.setTitle("Clone (duplicate / copy)").setIcon("files").onClick(() => unlockFirst("clone it")));
    menu.addItem((i: any) => i.setTitle("Fork into a separate note…").setIcon("git-branch").onClick(() => unlockFirst("fork it")));
    addShareSubmenu();
    addUnlock();
    addShowInFinder();
    addCopyPath();
    menu.addSeparator();
    menu.addItem((i: any) => i.setTitle("Move to…").setIcon("move").onClick(() => unlockFirst("move it")));
    menu.addItem((i: any) => i.setTitle("Move to Home").setIcon("home").onClick(() => unlockFirst("move it")));
    menu.addItem((i: any) => i.setTitle("Pin to sidebar").setIcon("pin").onClick(() => unlockFirst("pin it")));
    menu.addItem((i: any) => i.setTitle("Pin to top of list").setIcon("arrow-up-to-line").onClick(() => unlockFirst("pin it")));
    menu.addItem((i: any) => i.setTitle("Set color…").setIcon("palette").onClick(() => unlockFirst("set its color")));
    menu.addItem((i: any) => i.setTitle("Task").setIcon("check-circle-2").onClick(() => unlockFirst("change its task state")));
    menu.addSeparator();
    addDelete();
  } else {
    // Aggregate locked row: trimmed set.
    addUnlock();
    addShareSubmenu();
    menu.addSeparator();
    addShowInFinder();
    addCopyPath();
    menu.addSeparator();
    addDelete();
  }
}
