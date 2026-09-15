/** 0.378.0 — layout for the optional in-vault config folder.
 *
 *  When the user opts in (Settings → Folders & Storage), the LARGE, list-type
 *  settings move OUT of `.obsidian/plugins/stashpad/data.json` into a normal
 *  vault folder (default `Stashpad Config/`), one file per category under a
 *  subfolder. A normal vault folder is picked up by ANY file sync (Obsidian
 *  Sync, Git, Syncthing, iCloud…), unlike the plugin dir which only Obsidian
 *  Sync's plugin-settings toggle covers — and splitting the big lists out of
 *  data.json shrinks it, so a save rewrites less and conflicts hit smaller files.
 *
 *  DELIBERATELY BOUNDED. Core scalar prefs, hotkeys/bindings, ENCRYPTION state
 *  (the key-derivation identity — losing it means you can't decrypt) and the
 *  device-local churn already in `history.json` all STAY in the plugin dir. The
 *  config folder holds only what's both sync-worthy AND liable to grow. Adding a
 *  category later is just another entry here. This is pure/DOM-free so the key
 *  partitioning is unit-testable. */

/** The data.json key holding the config-folder path ("" = off). NEVER moves —
 *  the plugin must read it before it knows where the config folder is. */
export const CONFIG_POINTER_KEY = "configFolder";

/** Sentinel file dropped in the config folder. Its presence is verified before
 *  every write, so a mis-set path can't scatter config into a random folder. */
export const CONFIG_SENTINEL = "DO NOT DELETE — Stashpad config.md";

export const CONFIG_SENTINEL_BODY =
  "# Stashpad configuration\n\n" +
  "This folder holds Stashpad's synced settings (snippets, saved views, menus, " +
  "templates, per-folder appearance). Stashpad reads and writes these files.\n\n" +
  "**Do not delete or rename this folder or this file** while the " +
  "\"Store config in a vault folder\" setting is on — Stashpad checks for this " +
  "sentinel before writing. To stop using it, turn that setting off in " +
  "Stashpad's settings first (that moves everything back into the plugin's " +
  "data.json), then remove the folder.\n";

/** One-time backup of data.json taken before the first move to a config folder. */
export const CONFIG_BACKUP_FILE = "data.json.pre-configfolder.bak";

/** Category file (path UNDER the config folder) → the settings keys it holds.
 *  The leading path segment is the subfolder (so a category can grow to several
 *  files later without moving the others). */
export const CONFIG_FILES: Record<string, readonly string[]> = {
  "snippets/snippets.json": ["snippets"],
  "views/views.json": ["savedViews", "savedSearches", "recentSearches"],
  "menus/menus.json": [
    "contextSubmenus", "contextMenuOrder", "contextMenuHidden",
    "itemButtons", "quickMenuActions", "quickMenuCustom",
    "commandIcons", "toolbarButtons",
  ],
  "templates/templates.json": ["noteTemplates"],
  "appearance/appearance.json": [
    // NB: archiveFolders / folderPanel* / bindings deliberately NOT here — they
    // are collision-protected and/or have special cross-device adopt handling
    // (healAdoptedBindings / refreshFolderPanels) that only runs on the data.json
    // path, so they stay in data.json. Encryption + identity + bootstrap stay too.
    "folderIcons", "obscureFolders", "colorAliases", "customPalette",
  ],
  "search/search.json": ["searchIncludedFolders", "searchExcludedFolders"],
};

/** Every key that lives in the config folder when it's enabled. */
export const CONFIG_KEYS: readonly string[] = Object.values(CONFIG_FILES).flat();

/** The subfolders the config folder needs (deduped leading path segments). */
export const CONFIG_SUBFOLDERS: readonly string[] =
  [...new Set(Object.keys(CONFIG_FILES).map((f) => f.split("/")[0]))];

/** Sanity guard for a chosen config-folder path: non-empty, no leading/trailing
 *  slashes, no `..`, not a reserved Stashpad subfolder or the notes folder. */
export function isValidConfigFolder(raw: string, reserved: readonly string[]): { ok: boolean; reason?: string } {
  const cleaned = (raw || "").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return { ok: false, reason: "empty" };
  const segs = cleaned.split("/").filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) return { ok: false, reason: "relative" };
  const reservedSet = new Set(reserved.map((r) => (r ?? "").trim().replace(/^\/+|\/+$/g, "")).filter(Boolean));
  if (segs.some((s) => reservedSet.has(s))) return { ok: false, reason: "reserved" };
  return { ok: true };
}

/** True when `path` is inside (or is) the config folder — used to exclude it
 *  from Stashpad's note scanning / search / autocomplete. */
export function isUnderConfigFolder(path: string, configFolder: string | null): boolean {
  if (!configFolder) return false;
  const cf = configFolder.replace(/^\/+|\/+$/g, "");
  const p = (path || "").replace(/^\/+/, "");
  return p === cf || p.startsWith(`${cf}/`);
}

/** True when `path` is inside (or is) ANY of the given config folders (primary +
 *  mirrors). */
export function isUnderAnyConfigFolder(path: string, folders: (string | null | undefined)[]): boolean {
  return folders.some((f) => isUnderConfigFolder(path, f ?? null));
}
