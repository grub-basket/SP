/** 0.600.2: moving or renaming an ENCRYPTED Stashpad folder.
 *
 *  Locked notes decrypt with the key of the folder they sit in, and Stashpad's
 *  unlocked-key cache and key registry are keyed by folder path, so a locked
 *  folder that changes path could leave its notes behind a password prompt (or
 *  worse, a key nobody can find). The user's chosen workflow is the simple and
 *  safe one: before Stashpad moves or renames such a folder, it unlocks every
 *  locked note in it (archived ones included) and turns the folder's encryption
 *  settings off, so what moves is a normal, plain folder. Then it keeps telling
 *  the user, until they act, that the folder at its new place is no longer
 *  encrypted: a notice that stays up, the same notice again on every start
 *  while anything is pending, a list on the Encryption settings page, and an
 *  "Encrypt again" item at the top of the folder's gear menu. "Encrypt again"
 *  restores the folder's old encryption settings and locks its notes.
 *
 *  Unlocked notes also land on the existing "previously encrypted" watchlist
 *  (unlockBundleAt does that), which follows the move (remapFolderPathInSettings).
 *
 *  Trash blobs (securely deleted notes in `<folder>/trash/`) are left as they
 *  are: they are deleted notes, not part of the folder's content, and their
 *  key file moves with the folder. */
import type StashpadPlugin from "./main";
import type { FolderEncPrefs } from "./settings";
import { ConfirmModal } from "./modals";
import { notify } from "./notify";

const clean = (p: string): string => (p || "").replace(/^\/+|\/+$/g, "");
const baseName = (p: string): string => clean(p).split("/").pop() || clean(p);

const ENCRYPT_KEYS: (keyof FolderEncPrefs)[] = [
  "encryptContent", "encryptFilenames", "archiveEncryptContent", "archiveEncryptFilenames", "trashEncryptContent", "trashEncryptFilenames",
];

/** What would make a move/rename need the unlock workflow.
 *  `blobs` = the locked notes "Encrypt again" can put back exactly: the ones
 *  directly in the folder (lockFolder relocks those), and the archived ones when
 *  the folder encrypts its archive (encryptExistingArchiveNotes relocks those).
 *  `keepLocked` = any other locked note (archived while archive encryption is
 *  off, or in some deeper folder): unlocking those could never be undone by
 *  "Encrypt again", so they stay locked and simply move with the folder (its
 *  key moves too; EncryptionService.renameFolderPath re-keys the session).
 *  Trash blobs are deleted notes and are left alone either way. */
export function folderEncryptionState(plugin: StashpadPlugin, folder: string): { blobs: string[]; keepLocked: string[]; prefsOn: boolean } {
  const f = clean(folder);
  const prefs = plugin.settings.folderEncPrefs?.[f];
  const prefsOn = !!prefs && ENCRYPT_KEYS.some((k) => prefs[k] === true);
  const archiveRelocks = prefs?.archiveEncryptContent === true;
  const blobs: string[] = [], keepLocked: string[] = [];
  for (const x of plugin.app.vault.getFiles()) {
    if (x.extension !== "stashenc" || !x.path.startsWith(`${f}/`) || plugin.isTrashBlobPath(x.path)) continue;
    const dir = x.parent?.path ?? "";
    if (dir === f || (archiveRelocks && dir === `${f}/archive`)) blobs.push(x.path);
    else keepLocked.push(x.path);
  }
  return { blobs, keepLocked, prefsOn };
}

/** Plain notes that "Encrypt again" is expected to lock: top-level notes (not
 *  Home) and, when archive encryption is on, plain archived notes. */
function plainNotesToRelock(plugin: StashpadPlugin, folder: string): number {
  const f = clean(folder);
  const archive = plugin.settings.folderEncPrefs?.[f]?.archiveEncryptContent === true;
  return plugin.app.vault.getMarkdownFiles().filter((x) => {
    const dir = x.parent?.path ?? "";
    if (dir === f) {
      const fm = plugin.app.metadataCache.getFileCache(x)?.frontmatter as { id?: unknown } | undefined;
      return fm?.id !== "__root__";
    }
    return archive && dir === `${f}/archive`;
  }).length;
}

/** Ask, unlock every locked note in `folder`, and switch its encryption
 *  settings off. Resolves to the settings it switched off (for "Encrypt
 *  again") plus the unlocked count, or null when the user cancelled or a note
 *  couldn't be unlocked (then nothing moves; the folder's settings are
 *  untouched, and any notes that did unlock are on the re-encrypt watchlist). */
export function unlockFolderForRelocation(
  plugin: StashpadPlugin, folder: string, verb: "move" | "rename",
): Promise<{ prefs: FolderEncPrefs | undefined; unlocked: number } | null> {
  const f = clean(folder);
  const { blobs, keepLocked } = folderEncryptionState(plugin, f);
  const name = baseName(f);
  const lines = [
    blobs.length
      ? `“${name}” has ${blobs.length} locked (encrypted) note${blobs.length === 1 ? "" : "s"}. To ${verb} it safely, Stashpad unlocks them first, so you may be asked for the folder's password.`
      : `“${name}” is set to encrypt its notes.`,
    `After the ${verb === "move" ? "move" : "rename"} it is a normal, unencrypted folder. Stashpad keeps reminding you to encrypt it again, and "Encrypt again" brings back its encryption settings and locks its notes.`,
    ...(keepLocked.length ? [`${keepLocked.length} other locked note${keepLocked.length === 1 ? "" : "s"} (archived, or in a subfolder) stay${keepLocked.length === 1 ? "s" : ""} locked and move${keepLocked.length === 1 ? "s" : ""} with it, with the same password.`] : []),
  ];
  return new Promise((resolve) => {
    new ConfirmModal(plugin.app, `Unlock “${name}” to ${verb} it?`, lines.join("\n\n"), verb === "move" ? "Unlock and move" : "Unlock and rename", (ok) => void (async () => {
      if (!ok) { resolve(null); return; }
      let unlocked = 0, failed = 0;
      const prog = blobs.length > 3 ? notify("", 0) : null;
      for (let i = 0; i < blobs.length; i++) {
        prog?.setMessage(`🔓 Unlocking ${i + 1}/${blobs.length}…`);
        try { if (await plugin.unlockBundleAt(blobs[i], { silent: true })) unlocked++; else failed++; }
        catch (e) { console.warn("[Stashpad] unlock before move failed", blobs[i], e); failed++; }
      }
      prog?.hide();
      if (failed) {
        await plugin.saveSettings(); // the re-encrypt watch entries for what did unlock
        notify(`${failed} locked note${failed === 1 ? "" : "s"} in “${name}” couldn't be unlocked, so it wasn't ${verb === "move" ? "moved" : "renamed"}.`
          + (unlocked ? ` ${unlocked} did unlock; they're on the re-encrypt list.` : ""));
        resolve(null);
        return;
      }
      const before = plugin.settings.folderEncPrefs?.[f];
      if (before && ENCRYPT_KEYS.some((k) => before[k] === true)) {
        const off: FolderEncPrefs = { ...before };
        for (const k of ENCRYPT_KEYS) delete off[k];
        plugin.settings.folderEncPrefs = { ...(plugin.settings.folderEncPrefs ?? {}), [f]: off };
      }
      await plugin.saveSettings();
      resolve({ prefs: before ? { ...before } : undefined, unlocked });
    })(), "Cancel").open();
  });
}

/** Record that `folder` (its NEW path) needs encrypting again, and say so. */
export async function markEncryptionPending(
  plugin: StashpadPlugin, folder: string, from: string, how: "moved" | "renamed", r: { prefs: FolderEncPrefs | undefined; unlocked: number },
): Promise<void> {
  const f = clean(folder);
  plugin.settings.encryptionPendingFolders = {
    ...(plugin.settings.encryptionPendingFolders ?? {}),
    [f]: { from: clean(from), at: new Date().toISOString(), how, unlocked: r.unlocked, ...(r.prefs ? { prefs: r.prefs } : {}) },
  };
  await plugin.saveSettings();
  showEncryptionPendingNotice(plugin, f);
}

/** The reminder: stays until the user acts (Encrypt again / Not now). */
export function showEncryptionPendingNotice(plugin: StashpadPlugin, folder: string): void {
  const f = clean(folder);
  const e = plugin.settings.encryptionPendingFolders?.[f];
  if (!e) return;
  // 0.600.4 (review): the folder can move again while this notice is up (the
  // entry follows it); find it by its timestamp at click time, not by `f`.
  const current = (): string => Object.entries(plugin.settings.encryptionPendingFolders ?? {}).find(([, v]) => v.at === e.at)?.[0] ?? f;
  // One notice per reminder: showing it again (start-up, a failed "Encrypt
  // again") replaces the old one, and clearing the reminder closes it.
  openNotices.get(e.at)?.hide();
  const n = plugin.notifications.show({
    message: `🔓 **${baseName(f)}** is no longer encrypted. It was unlocked to be ${e.how}${e.unlocked ? ` (${e.unlocked} note${e.unlocked === 1 ? "" : "s"})` : ""}. Encrypt it again when you're ready.`,
    kind: "warning", category: "system", folder: f, duration: 0,
    actions: [
      { label: "Encrypt again", onClick: () => void encryptPendingFolder(plugin, current()) },
      { label: "Encryption settings", onClick: () => plugin.settingTab?.openSettingsPage("🔒 Encryption") },
    ],
  });
  if (n) openNotices.set(e.at, n); else openNotices.delete(e.at);
}

/** The visible reminder notice per pending entry (keyed by its `at`, which
 *  survives later moves of the folder). */
const openNotices = new Map<string, { hide(): void }>();

/** Shown once per start for every folder still waiting (called from onload). */
export function remindPendingEncryption(plugin: StashpadPlugin): void {
  for (const f of Object.keys(plugin.settings.encryptionPendingFolders ?? {})) {
    if (plugin.app.vault.getAbstractFileByPath(f)) showEncryptionPendingNotice(plugin, f);
  }
}

/** "Encrypt again": restore the old encryption settings and lock the notes. */
export async function encryptPendingFolder(plugin: StashpadPlugin, folder: string): Promise<void> {
  const f = clean(folder);
  const e = plugin.settings.encryptionPendingFolders?.[f];
  if (!plugin.app.vault.getAbstractFileByPath(f)) { notify(`“${f}” no longer exists.`); return; }
  // 0.600.4 (review): the key index is built in the background after start-up,
  // and the start-up reminder can be clicked before it's done.
  try { await plugin.encryption?.whenKeysReady?.(); } catch { /* fall through to the check */ }
  if (!plugin.encryption?.hasFolderKey?.(f)) {
    notify(`“${baseName(f)}” has no encryption key here. Set it up from the folder's gear → Edit folder…, or in Encryption settings.`);
    plugin.settingTab?.openSettingsPage("🔒 Encryption");
    return;
  }
  if (e?.prefs) {
    const cur = plugin.settings.folderEncPrefs?.[f] ?? {};
    const restored: FolderEncPrefs = { ...cur };
    for (const k of ENCRYPT_KEYS) if (e.prefs[k] !== undefined) (restored as Record<string, unknown>)[k] = e.prefs[k];
    plugin.settings.folderEncPrefs = { ...(plugin.settings.folderEncPrefs ?? {}), [f]: restored };
  } else {
    plugin.settings.folderEncPrefs = { ...(plugin.settings.folderEncPrefs ?? {}), [f]: { ...(plugin.settings.folderEncPrefs?.[f] ?? {}), encryptContent: true } };
  }
  await plugin.saveSettings();
  const locked = await plugin.lockFolder(f);
  const archived = plugin.settings.folderEncPrefs?.[f]?.archiveEncryptContent ? await plugin.encryptExistingArchiveNotes(f) : 0;
  // 0.600.4 (review): only clear the reminder once nothing it covers is still
  // plain. A cancelled or mistyped password, or a note that failed to lock,
  // used to clear it and announce success with every note still readable.
  const left = plainNotesToRelock(plugin, f);
  if (left > 0) {
    notify(`“${baseName(f)}” still has ${left} unencrypted note${left === 1 ? "" : "s"}${locked + archived ? ` (${locked + archived} locked)` : ""}. The reminder stays; try “Encrypt again” once more.`);
    showEncryptionPendingNotice(plugin, f);
    return;
  }
  await clearEncryptionPending(plugin, f);
  notify(`🔒 “${baseName(f)}” is encrypted again${locked || archived ? ` (${locked + archived} note${locked + archived === 1 ? "" : "s"} locked)` : ""}.`);
}

/** Drop the pending marker (encrypted again, or the user dismissed it). */
export async function clearEncryptionPending(plugin: StashpadPlugin, folder: string): Promise<void> {
  const f = clean(folder);
  const cur = plugin.settings.encryptionPendingFolders ?? {};
  if (!(f in cur)) return;
  const at = cur[f]?.at;
  if (at) { openNotices.get(at)?.hide(); openNotices.delete(at); }
  const next = { ...cur };
  delete next[f];
  plugin.settings.encryptionPendingFolders = next;
  await plugin.saveSettings();
}
