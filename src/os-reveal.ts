import { Notice, Platform, type App } from "obsidian";

/** 0.215.0: revealing a vault file in the OS file manager, in one place.
 *
 *  This pattern (getFullPath → electron shell.showItemInFolder, wrapped in a
 *  try/catch because `require` is absent on mobile and in a sandboxed renderer)
 *  had been copy-pasted into four call sites — the aggregate view, the locked
 *  menu, the log modal and the note list. Each had its own slightly different
 *  failure handling. New callers should use this. */

/** What the OS calls its file manager, for menu labels and messages. */
export function osFileManagerName(): string {
  return Platform.isMacOS ? "Finder" : Platform.isWin ? "File Explorer" : "file manager";
}

/** True when revealing is actually possible — desktop only. Mobile has no file
 *  manager to hand off to and no Electron `shell`, so callers must hide the
 *  menu entry rather than offer one that cannot work. */
export function canRevealInOs(): boolean {
  return Platform.isDesktop;
}

/** Reveal `vaultPath` (vault-relative, file OR folder) in the OS file manager.
 *  Never throws — a failure is reported to the user and logged. */
export function revealInOsFileManager(app: App, vaultPath: string): void {
  const name = osFileManagerName();
  try {
    const adapter = app.vault.adapter as { getFullPath?: (p: string) => string };
    const full = adapter.getFullPath?.(vaultPath);
    const shell = (window as unknown as {
      require?: (m: string) => { shell?: { showItemInFolder?: (p: string) => void } };
    }).require?.("electron")?.shell;
    if (!full || !shell?.showItemInFolder) {
      new Notice(`Couldn't open ${name} on this platform.`);
      return;
    }
    shell.showItemInFolder(full);
  } catch (e) {
    console.warn("[Stashpad] showItemInFolder failed", vaultPath, e);
    new Notice(`Couldn't open ${name}.`);
  }
}
