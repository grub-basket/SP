import { App, Menu, Modal, SuggestModal, TFolder } from "obsidian";
import { notify } from "./notify";
import { safeFileName } from "./safe-filename";
import type StashpadPlugin from "./main";
import { ConfirmModal } from "./modals";
import { isInReservedSubfolder, siftMatch } from "./types";
import { nestBlockMessage, withReservedRule } from "./nest-guard";
import { clearEncryptionPending, encryptPendingFolder, folderEncryptionState, markEncryptionPending, unlockFolderForRelocation } from "./folder-encryption-move";
import { canRevealInOs, osFileManagerName, revealInOsFileManager } from "./os-reveal";
import { runFoldFlow } from "./folder-fold";
import { runUnfoldFlow } from "./folder-split";
import { openFolderSetup } from "./folder-setup-modal";

/** 0.595.0: the folder management menu, shared by the Folders sidebar (row
 *  right-click / row gear) and the main view's gear button beside the folder
 *  switcher. It used to live inside the sidebar view, so a user who never
 *  opened the sidebar had no way to rename or delete a folder. The sidebars
 *  are supplemental: nothing should depend on them.
 *
 *  `onChanged` runs after an action that changes how the folder is listed
 *  (placement, encryption flag, edit dialog), so the caller can repaint. */
export function fillFolderMenu(plugin: StashpadPlugin, menu: Menu, folder: string, onChanged?: () => void): void {
  const app = plugin.app;
  const changed = () => onChanged?.();
  // 0.600.2: a folder that was unlocked to be moved/renamed leads with the way
  // back to encrypted, so the reminder can't be missed from here either.
  const pendingKey = folder.replace(/\/+$/, "");
  if (plugin.settings.encryptionPendingFolders?.[pendingKey]) {
    menu.addItem((i) => i.setTitle("🔒 Encrypt again (unlocked to move)").setIcon("lock")
      .onClick(() => void encryptPendingFolder(plugin, pendingKey).then(changed)));
    menu.addItem((i) => i.setTitle("Stop reminding me to encrypt it").setIcon("bell-off")
      .onClick(() => void clearEncryptionPending(plugin, pendingKey).then(changed)));
    menu.addSeparator();
  }
  // Order: non-destructive navigation first, then rename, then delete (isolated).
  menu.addItem((i) => i.setTitle("Open in new tab").setIcon("plus-square")
    .onClick(() => void plugin.activateViewForFolder(folder, { folderSwitch: true })));
  menu.addItem((i) => i.setTitle("Reveal in file explorer").setIcon("folder-search")
    .onClick(() => revealFolderInExplorer(app, folder)));
  // 0.215.0: hand off to the OS file manager. Desktop only — mobile has no
  // file manager to reveal into, so the entry is hidden rather than shown
  // and failing. Distinct from the entry above, which reveals in Obsidian's
  // OWN file explorer view.
  if (canRevealInOs()) {
    menu.addItem((i) => i.setTitle(`Open in ${osFileManagerName()}`).setIcon("app-window")
      .onClick(() => revealInOsFileManager(app, folder)));
  }
  menu.addSeparator();
  // Placement (pin / downrank / hide). Each is a toggle; setFolderPlacement clears
  // the other two so a folder is in at most one state.
  const state = plugin.folderPlacement(folder);
  const place = async (next: Parameters<StashpadPlugin["setFolderPlacement"]>[1]) => { await plugin.setFolderPlacement(folder, next); changed(); };
  menu.addItem((i) => i.setTitle(state === "pinned" ? "Unpin" : "Pin to top").setIcon("pin")
    .onClick(() => void place(state === "pinned" ? "normal" : "pinned")));
  menu.addItem((i) => i.setTitle(state === "downranked" ? "Remove downrank" : "Downrank").setIcon("arrow-down")
    .onClick(() => void place(state === "downranked" ? "normal" : "downranked")));
  menu.addItem((i) => i.setTitle("Hide from list").setIcon("eye-off")
    .onClick(() => void place("hidden")));
  // 0.267.0: per-folder obscure default. Lives here rather than in settings
  // because it is a property OF THIS FOLDER, and this menu is where the
  // folder's other properties (placement, icon, encryption) already are —
  // a settings page listing every folder would be a second place to look.
  const obs = plugin.settings.obscureFolders?.[folder.replace(/\/+$/, "")];
  menu.addItem((i) => i
    .setTitle(obs === true ? "Don't obscure notes by default" : "Obscure notes by default")
    .setIcon(obs === true ? "eye" : "eye-off")
    .onClick(() => void plugin.setFolderObscured(folder, obs !== true)));
  // Only offered once the folder HAS an opinion, since that is the only time
  // clearing it does anything. Without this there is no way back to
  // "follow the global switch" — an explicit no would silently outrank it
  // forever, which is a trap rather than a preference.
  if (typeof obs === "boolean") {
    menu.addItem((i) => i.setTitle("Obscuring: follow the global setting").setIcon("rotate-ccw")
      .onClick(() => void plugin.setFolderObscured(folder, null)));
  }
  menu.addSeparator();
  menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil")
    .onClick(() => renameFolderFlow(plugin, folder)));
  // 0.599.1: put the folder inside another folder (or back at the vault root).
  menu.addItem((i) => i.setTitle("Move folder…").setIcon("folder-tree")
    .onClick(() => moveFolderFlow(plugin, folder)));
  // 0.561.0: icon, placement, blur and encryption in one place.
  menu.addItem((i) => i.setTitle("Edit folder…").setIcon("settings-2")
    .onClick(() => openFolderSetup(plugin, folder, { mode: "edit", onDone: changed })));
  // 0.558.0: merge this folder into another Stashpad (src/folder-fold.ts).
  menu.addItem((i) => i.setTitle("Merge into another folder…").setIcon("folder-input")
    .onClick(() => void runFoldFlow(plugin, folder)));
  // 0.560.0: only when something was folded INTO this folder.
  const cleanFolder = folder.replace(/\/+$/, "");
  if (Object.values(plugin.settings.foldedFolders ?? {}).some((f) => f.into === cleanFolder)) {
    menu.addItem((i) => i.setTitle("Unmerge a folder merged in here…").setIcon("folder-output")
      .onClick(() => void runUnfoldFlow(plugin, undefined, cleanFolder)));
  }
  // Encryption (Phase 3): lock every top-level note in the folder into separate
  // .stashenc bundles, or unlock them all back. Only when encryption is set up.
  if (plugin.encryption?.isConfigured?.()) {
    menu.addSeparator();
    // 0.276.5: per-folder encryption ON/OFF. Marks the folder as one whose
    // notes should be encrypted — the Encrypt-all sweep locks any plaintext
    // in it. Setting it is non-destructive (it does not encrypt on its own);
    // the two actions below still lock/unlock immediately.
    const encOn = (plugin.settings.folderEncPrefs?.[cleanFolder])?.encryptContent === true;
    menu.addItem((i) => i.setTitle(encOn ? "Encryption: ON for this folder" : "Turn on encryption for this folder")
      .setIcon(encOn ? "shield-check" : "shield")
      .onClick(async () => {
        const prefs = plugin.settings.folderEncPrefs ?? {};
        plugin.settings.folderEncPrefs = { ...prefs, [cleanFolder]: { ...(prefs[cleanFolder] ?? {}), encryptContent: !encOn } };
        await plugin.saveSettings();
        notify(!encOn
          ? "Encryption on for this folder. Run “Encrypt (lock) all notes” or Encrypt-all to lock its existing notes."
          : "Encryption off for this folder.");
        changed();
      }));
    menu.addItem((i) => i.setTitle("Encrypt (lock) all notes in folder").setIcon("lock")
      .onClick(() => void plugin.lockFolder(folder)));
    if (app.vault.getFiles().some((f) => f.extension === "stashenc" && (f.parent?.path?.replace(/\/+$/, "") ?? "") === cleanFolder)) {
      menu.addItem((i) => i.setTitle("Decrypt (unlock) all notes in folder").setIcon("unlock")
        .onClick(() => void plugin.unlockFolder(folder)));
    }
    // (0.136.0: "Mark as archive folder" is gone — every folder owns an
    // `archive/` subfolder now; use "Move selection to archive" in a list, or
    // the aggregated Archived view to browse. Encryption of archived notes is
    // the per-folder "Encrypt archived notes" setting.)

    // 0.98.31: open the encrypted-trash tab (recoverable secure-deleted notes).
    menu.addItem((i) => i.setTitle("Open trash").setIcon("rotate-ccw")
      .onClick(() => plugin.openEncryptedTrash()));
  }
  menu.addSeparator();
  menu.addItem((i) => {
    i.setTitle("Delete folder…").setIcon("trash").onClick(() => deleteFolderFlow(plugin, folder));
    (i as any).setWarning?.(true);
  });
}

export function revealFolderInExplorer(app: App, folder: string): void {
  const tf = app.vault.getAbstractFileByPath(folder.replace(/\/+$/, ""));
  if (!(tf instanceof TFolder)) { notify("Couldn't find that folder."); return; }
  const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!leaf) { notify("File explorer isn't available."); return; }
  app.workspace.revealLeaf(leaf);
  (leaf.view as any)?.revealInFolder?.(tf);
}

export function renameFolderFlow(plugin: StashpadPlugin, folder: string): void {
  const app = plugin.app;
  const cleaned = folder.replace(/\/+$/, "");
  const tf = app.vault.getAbstractFileByPath(cleaned);
  if (!(tf instanceof TFolder)) { notify("Couldn't find that folder."); return; }
  const current = tf.name;
  new RenameFolderModal(app, current, async (next) => {
    const safe = safeFileName(next);
    if (!safe || safe === current) return;
    const parent = tf.parent?.path && tf.parent.path !== "/" ? `${tf.parent.path}/` : "";
    const target = `${parent}${safe}`;
    if (app.vault.getAbstractFileByPath(target)) { notify(`"${safe}" already exists.`); return; }
    // 0.140.3 (review): re-validate — the folder could've moved/been deleted
    // by sync while the rename modal sat open.
    if (!(app.vault.getAbstractFileByPath(cleaned) instanceof TFolder)) { notify("That folder no longer exists."); return; }
    // 0.600.2: same unlock-first workflow as Move folder for an encrypted folder.
    const enc = folderEncryptionState(plugin, cleaned);
    const unlockedFor = enc.blobs.length || enc.prefsOn ? await unlockFolderForRelocation(plugin, cleaned, "rename") : undefined;
    if (unlockedFor === null) return;
    let renamed = false;
    try {
      await app.fileManager.renameFile(tf, target);
      // 0.140.3: carry ALL path-keyed settings (default folder + placement +
      // archive + per-folder prefs, incl. descendants) to the new path.
      await plugin.remapFolderPathInSettings(cleaned, target);
      renamed = true;
      notify(`Renamed to "${safe}".`);
    } catch (err) {
      console.warn("[Stashpad] folder rename failed", err);
      notify("Rename failed (see console).");
    }
    if (unlockedFor) await markEncryptionPending(plugin, renamed ? target : cleaned, cleaned, "renamed", unlockedFor);
  }).open();
}

export function deleteFolderFlow(plugin: StashpadPlugin, folder: string): void {
  const app = plugin.app;
  const cleaned = folder.replace(/\/+$/, "");
  const tf = app.vault.getAbstractFileByPath(cleaned);
  if (!(tf instanceof TFolder)) { notify("Couldn't find that folder."); return; }
  const noteCount = app.vault.getMarkdownFiles()
    .filter((f) => (f.parent?.path?.replace(/\/+$/, "") ?? "") === cleaned
      || (f.path.startsWith(cleaned + "/"))).length;
  const name = tf.name;
  // 0.213.2: deleting a folder takes its _attachments with it, so notes in
  // OTHER folders that embed those files lose their images with no warning
  // and no obvious cause. Say so before the delete, not after — this is the
  // one moment the user can still act on it.
  const outside = plugin.outsideReferencesToFolderAttachments(cleaned);
  const lines = [
    `This moves the entire folder — about ${noteCount} note${noteCount === 1 ? "" : "s"} plus its attachments and exports — to the trash.`,
    "You can restore it from your system/Obsidian trash.",
  ];
  if (outside.paths.length) {
    lines.push(
      "",
      `⚠️ ${outside.paths.length} attachment${outside.paths.length === 1 ? "" : "s"} in **${name}** ${outside.paths.length === 1 ? "is" : "are"} used by notes in ${outside.folders.length} other folder${outside.folders.length === 1 ? "" : "s"}: ${outside.folders.map((f) => `**${f}**`).join(", ")}.`,
      `Deleting **${name}** breaks ${outside.paths.length === 1 ? "that embed" : "those embeds"} — the notes stay, but the ${outside.paths.length === 1 ? "image" : "images"} stop resolving.`,
      // 0.214.2: the files themselves are rendered below as CLICKABLE rows
      // (setFileList) rather than inlined here as text. The user is being
      // asked to decide about these specific files, which they cannot do
      // without looking at them — and the list is unbounded, so it needs its
      // own capped scroll region rather than growing the modal.
      `Click any of them to open it${outside.paths.length > 1 ? "" : ""}:`,
      `To keep ${outside.paths.length === 1 ? "it" : "them"}, move ${outside.paths.length === 1 ? "the file" : "those files"} out of **${name}** first, or restore the folder from the trash afterwards.`,
    );
  }
  const modal = new ConfirmModal(
    app,
    `Delete "${name}"?`,
    lines.join("\n"),
    "Delete folder",
    async (confirmed) => {
      if (!confirmed) return;
      // Closes open tabs, moves the folder to .trash, and posts a persistent
      // notification with an Undo action (move-back). The vault "delete"
      // listener is suppressed for this path so it won't double-notify.
      await plugin.deleteStashpadFolderWithUndo(tf);
    },
    "Cancel",
    // Focus Cancel when this delete would break notes elsewhere, so a stray
    // Enter can't confirm it.
    outside.paths.length > 0,
  );
  // Every affected file, not a truncated sample — the scroll region makes a
  // long list safe, so there is no reason to hide any of them.
  if (outside.paths.length) modal.setFileList(outside.paths);
  modal.open();
}

/** 0.599.1: the parent folders a Stashpad folder may be moved into, as paths
 *  ("" = the vault root). Left out: the folder itself and everything inside
 *  it, the folder it is already in, hidden folders, Stashpad's own subfolders
 *  (archive/, _attachments, …), and anywhere the folder would stop being a
 *  Stashpad because it would sit inside another one (nest-guard). */
export function moveFolderDestinations(plugin: StashpadPlugin, folder: string): { path: string; label: string }[] {
  const app = plugin.app;
  const src = folder.replace(/\/+$/, "");
  const tf = app.vault.getAbstractFileByPath(src);
  if (!(tf instanceof TFolder)) return [];
  const name = tf.name;
  const parent = tf.parent && tf.parent.path !== "/" ? tf.parent.path : "";
  const check = plugin.nestGuard();
  const candidates = [""];
  for (const f of app.vault.getAllLoadedFiles()) if (f instanceof TFolder && f.path && f.path !== "/") candidates.push(f.path);
  return candidates
    .filter((p) => p !== parent)
    .filter((p) => p !== src && !p.startsWith(`${src}/`))
    .filter((p) => !p.split("/").some((seg) => seg.startsWith(".")))
    .filter((p) => !p || !isInReservedSubfolder(p))
    .filter((p) => withReservedRule(check(p ? `${p}/${name}` : name), p ? `${p}/${name}` : name).ok)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((p) => ({ path: p, label: p || "Vault root" }));
}

/** Pick the new parent folder (Sift-matched). */
class MoveFolderModal extends SuggestModal<{ path: string; label: string }> {
  constructor(app: App, private name: string, private options: { path: string; label: string }[], private onPick: (dest: string) => void) {
    super(app);
    this.setPlaceholder(`Move “${name}” into…`);
    this.emptyStateText = "No folder it can move into. (A Stashpad can't go inside another Stashpad or its archive.)";
  }
  getSuggestions(query: string): { path: string; label: string }[] {
    const q = query.trim();
    return q ? this.options.filter((o) => siftMatch(q, o.label)) : this.options;
  }
  renderSuggestion(o: { path: string; label: string }, el: HTMLElement): void {
    el.createDiv({ text: o.path ? o.path.split("/").pop() ?? o.path : "Vault root" });
    if (o.path.includes("/")) el.createEl("small", { text: o.path, cls: "stashpad-fold-target-path" });
    else if (!o.path) el.createEl("small", { text: "Top level of the vault", cls: "stashpad-fold-target-path" });
  }
  onChooseSuggestion(o: { path: string; label: string }): void { this.onPick(o.path); }
}

/** Move a folder to `dest` ("" = vault root). Obsidian's renameFile moves it
 *  (and rewrites links to its notes if the user has that on); the plugin's
 *  vault rename listener and the explicit call below carry every folder-keyed
 *  setting and re-point open tabs (remapFolderPathInSettings). Returns the new
 *  path, or null when refused / failed (already said why). */
/** 0.600.2: why `from` can't move into `dest` right now, or null. Run BEFORE
 *  any unlock-for-move, so a refused move never unlocks notes for nothing. */
export function relocationRefusal(plugin: StashpadPlugin, from: string, dest: string): string | null {
  const app = plugin.app;
  const src = from.replace(/\/+$/, "");
  const tf = app.vault.getAbstractFileByPath(src);
  if (!(tf instanceof TFolder)) return "That folder no longer exists.";
  const target = dest ? `${dest}/${tf.name}` : tf.name;
  if (target === src) return "It's already there.";
  if (app.vault.getAbstractFileByPath(target)) return `“${dest || "Vault root"}” already has a folder called “${tf.name}”.`;
  if (dest && !(app.vault.getAbstractFileByPath(dest) instanceof TFolder)) return `“${dest}” no longer exists.`;
  // Re-check at move time: the picker's list can be stale (sync, another tab).
  const verdict = withReservedRule(plugin.nestGuard()(target), target);
  if (!verdict.ok) return nestBlockMessage(verdict);
  return null;
}

export async function relocateFolder(plugin: StashpadPlugin, from: string, dest: string): Promise<string | null> {
  const app = plugin.app;
  const src = from.replace(/\/+$/, "");
  const refusal = relocationRefusal(plugin, src, dest);
  if (refusal) { notify(refusal); return null; }
  const tf = app.vault.getAbstractFileByPath(src);
  if (!(tf instanceof TFolder)) return null; // relocationRefusal already checked; narrows the type
  const target = dest ? `${dest}/${tf.name}` : tf.name;
  try {
    await app.fileManager.renameFile(tf, target);
    await plugin.remapFolderPathInSettings(src, target);
    return target;
  } catch (err) {
    console.warn("[Stashpad] folder move failed", err);
    notify("Moving the folder failed (see console).");
    return null;
  }
}

/** 0.599.1: Move folder… — pick a new parent, move, then a notice with Undo
 *  (also on the folder's undo stack). */
export function moveFolderFlow(plugin: StashpadPlugin, folder: string): void {
  const app = plugin.app;
  const src = folder.replace(/\/+$/, "");
  const tf = app.vault.getAbstractFileByPath(src);
  if (!(tf instanceof TFolder)) { notify("Couldn't find that folder."); return; }
  const name = tf.name;
  const oldParent = tf.parent && tf.parent.path !== "/" ? tf.parent.path : "";
  const options = moveFolderDestinations(plugin, src);
  new MoveFolderModal(app, name, options, (dest) => void (async () => {
    const refusal = relocationRefusal(plugin, src, dest);
    if (refusal) { notify(refusal); return; }
    // 0.600.2: an encrypted folder is unlocked into a plain one first (the user
    // can cancel), and flagged to be encrypted again at its new place.
    const enc = folderEncryptionState(plugin, src);
    const unlockedFor = enc.blobs.length || enc.prefsOn ? await unlockFolderForRelocation(plugin, src, "move") : undefined;
    if (unlockedFor === null) return;
    const moved = await relocateFolder(plugin, src, dest);
    if (unlockedFor) await markEncryptionPending(plugin, moved ?? src, src, "moved", unlockedFor);
    if (!moved) return;
    const undo = async (): Promise<void> => {
      const back = await relocateFolder(plugin, moved, oldParent);
      if (back) notify(`Moved “${name}” back to ${oldParent ? `“${oldParent}”` : "the vault root"}.`);
    };
    plugin.getUndoStack(moved).push({ label: `Move folder “${name}”`, undo });
    plugin.notifications.show({
      message: `Moved **${name}** to ${dest ? `**${dest}**` : "the vault root"}.`,
      kind: "success", category: "move", folder: moved,
      actions: [{ label: "Undo", onClick: () => void undo() }],
    });
  })()).open();
}

/** Tiny single-input modal for renaming a folder. */
class RenameFolderModal extends Modal {
  private delivered = false;
  constructor(app: App, private current: string, private onSubmit: (next: string) => void) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("stashpad-compact-modal");
    this.contentEl.empty();
    this.titleEl.setText("Rename folder");
    const input = this.contentEl.createEl("input", { type: "text" });
    input.addClass("stashpad-folderpanel-rename-input");
    input.value = this.current;
    const footer = this.contentEl.createDiv({ cls: "stashpad-folderpanel-rename-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const go = footer.createEl("button", { cls: "mod-cta", text: "Rename" });
    const submit = () => { this.delivered = true; const v = input.value; this.close(); this.onSubmit(v); };
    go.onclick = submit;
    this.scope.register([], "Enter", (e) => { e.preventDefault(); if (input.value.trim()) submit(); });
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  onClose(): void { this.contentEl.empty(); }
}
