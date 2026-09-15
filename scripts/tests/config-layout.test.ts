/* Pure tests for src/config-layout.ts */
import {
  CONFIG_FILES, CONFIG_KEYS, CONFIG_SUBFOLDERS, CONFIG_POINTER_KEY,
  isValidConfigFolder, isUnderConfigFolder,
} from "../../src/config-layout";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// CONFIG_KEYS is the flat union of every category's keys, with no duplicates.
const flat = Object.values(CONFIG_FILES).flat();
__eq(CONFIG_KEYS.length, flat.length, "CONFIG_KEYS is the flat union");
__eq(new Set(CONFIG_KEYS).size, CONFIG_KEYS.length, "no key appears in two categories");

// The device-local churn (history.json) must NOT be in the config set — moving
// it would resurrect the cross-device conflicts the split exists to prevent.
for (const k of ["drafts", "lastSubmitted", "notifiedDueKeys", "persistReminderLog", "composerDrafts"])
  __assert(!CONFIG_KEYS.includes(k), `device-local key ${k} must NOT move to config folder`);

// Encryption state must never move (losing it = can't decrypt).
for (const k of ["encryption", "folderEncPrefs", "lockedSubtrees", "encryptTrash"])
  __assert(!CONFIG_KEYS.includes(k), `encryption key ${k} must NOT move`);

// The pointer never moves.
__assert(!CONFIG_KEYS.includes(CONFIG_POINTER_KEY), "the pointer key must not be in the config set");

// Subfolders are the deduped leading path segments.
__eq([...CONFIG_SUBFOLDERS].sort(), ["appearance", "menus", "search", "snippets", "templates", "views"], "subfolders");
for (const f of Object.keys(CONFIG_FILES))
  __assert(f.split("/").length === 2, `category file ${f} is <subfolder>/<file>`);

// Folder-path validation.
const reserved = ["_attachments", "archive", "Stashpad"];
__assert(isValidConfigFolder("Stashpad Config", reserved).ok, "a normal folder is valid");
__assert(!isValidConfigFolder("", reserved).ok, "empty is invalid");
__assert(!isValidConfigFolder("  ", reserved).ok, "whitespace-only is invalid");
__assert(!isValidConfigFolder("../evil", reserved).ok, "a .. path is invalid");
__assert(!isValidConfigFolder("archive", reserved).ok, "a reserved name is invalid");
__assert(!isValidConfigFolder("Stashpad", reserved).ok, "the notes folder is invalid");
__assert(isValidConfigFolder("/Stashpad Config/", reserved).ok, "leading/trailing slashes are tolerated");

// isUnderConfigFolder.
__assert(isUnderConfigFolder("Stashpad Config/snippets/snippets.json", "Stashpad Config"), "a file inside is under");
__assert(isUnderConfigFolder("Stashpad Config", "Stashpad Config"), "the folder itself is under");
__assert(!isUnderConfigFolder("Notes/x.md", "Stashpad Config"), "an outside file is not under");
__assert(!isUnderConfigFolder("Stashpad Config X/x.md", "Stashpad Config"), "a sibling prefix is not under");
__assert(!isUnderConfigFolder("anything", null), "nothing is under when disabled");

// isUnderAnyConfigFolder (0.379.0) — primary + mirrors.
// (imported lazily to keep the top import block stable)
import { isUnderAnyConfigFolder } from "../../src/config-layout";
__assert(isUnderAnyConfigFolder("Old Config/snippets/snippets.json", ["Stashpad Config", "Old Config"]), "a file under a mirror is under");
__assert(isUnderAnyConfigFolder("Stashpad Config/x.json", ["Stashpad Config", "Old Config"]), "a file under the primary is under");
__assert(!isUnderAnyConfigFolder("Notes/x.md", ["Stashpad Config", "Old Config"]), "an outside file is not under any");
__assert(!isUnderAnyConfigFolder("x", [null, undefined]), "nothing is under empty/nullish list");
