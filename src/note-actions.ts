/** 0.320.0: the single catalog of per-note actions.
 *
 *  Every action a note row / menu can run is enumerated here ONCE with a stable
 *  id, a label, and a default lucide icon. Plain data (no handlers) so both the
 *  view (which maps each id to a `cmd*` in `runNoteAction`) and the settings tab
 *  (icon registry, star-menu builder, item-button builder, context-menu builder)
 *  can import it without a circular dependency.
 *
 *  Adding an action = one row here + one `case` in `runNoteAction`. The id is
 *  the persisted key (settings.quickMenuActions, itemButtons, contextMenuOrder,
 *  commandIcons), so NEVER rename an id — change the label/icon instead. */
export interface NoteActionDef {
  id: string;
  label: string;
  /** Default lucide icon; the effective icon is `commandIcons[id] ?? icon`. */
  icon: string;
  /** True when the action makes sense as a row BUTTON (icon-only, no dialog
   *  that a tooltip can't explain). All actions can go in menus. */
  button?: boolean;
  /** Grouping label for settings (icon registry, add menu). */
  group: "Open & navigate" | "Compose" | "Copy" | "Organize";
}

export const NOTE_ACTION_CATALOG: readonly NoteActionDef[] = [
  // Open & navigate
  { id: "edit",             label: "Edit in Stashpad",              icon: "pencil-line",        button: true,  group: "Open & navigate" },
  { id: "focus",            label: "Focus in Stashpad",             icon: "arrow-right",        button: true,  group: "Open & navigate" },
  { id: "openNewTab",       label: "Open in new Stashpad tab",      icon: "layout-grid",        button: true,  group: "Open & navigate" },
  { id: "openObsidian",     label: "Open in Obsidian editor",       icon: "file-text",          button: true,  group: "Open & navigate" },
  { id: "largeText",        label: "Reveal in large text",          icon: "maximize",           button: true,  group: "Open & navigate" },
  // Compose
  { id: "reply",            label: "Reply",                         icon: "reply",              button: true,  group: "Compose" },
  { id: "replyLink",        label: "Make a reply to…",              icon: "corner-up-left",                    group: "Compose" },
  { id: "react",            label: "React…",                        icon: "smile-plus",         button: true,  group: "Compose" },
  { id: "split",            label: "Split note…",                   icon: "split",              button: true,  group: "Compose" },
  { id: "fork",             label: "Fork into a separate note…",    icon: "git-branch",                        group: "Compose" },
  // Copy
  { id: "copy",             label: "Copy text",                     icon: "copy",               button: true,  group: "Copy" },
  { id: "copyTree",         label: "Copy tree",                     icon: "copy-plus",          button: true,  group: "Copy" },
  { id: "copyLevelMarkers", label: "Copy tree with level markers",  icon: "list-tree",                         group: "Copy" },
  { id: "copySubtree",      label: "Copy focused subtree",          icon: "list-tree",                         group: "Copy" },
  { id: "clone",            label: "Clone (duplicate)",             icon: "files",              button: true,  group: "Copy" },
  { id: "exportHtml",       label: "Export to HTML / PDF…",         icon: "file-code",                         group: "Copy" },
  // Organize
  { id: "move",             label: "Move to…",                      icon: "move",               button: true,  group: "Organize" },
  { id: "moveHome",         label: "Move to Home",                  icon: "home",                              group: "Organize" },
  // 0.363.0: outdent as a first-class leaf so the seeded "Move ▸" submenu can
  // list it (and it's addable/renderable like any other action).
  { id: "outdent",          label: "Outdent",                       icon: "outdent",                           group: "Organize" },
  { id: "setColor",         label: "Set color…",                    icon: "palette",            button: true,  group: "Organize" },
  { id: "setDue",           label: "Set due date…",                 icon: "calendar-clock",     button: true,  group: "Organize" },
  { id: "blur",             label: "Blur / unblur",                 icon: "eye-off",            button: true,  group: "Organize" },
  { id: "pinSidebar",       label: "Pin to sidebar",                icon: "pin",                button: true,  group: "Organize" },
  { id: "archive",          label: "Move to archive",               icon: "archive",            button: true,  group: "Organize" },
];

export function noteAction(id: string): NoteActionDef | undefined { return BY_ID.get(id); }
/** Default icon for a catalog id, or a neutral fallback for an arbitrary
 *  Obsidian command id (which carries no catalog icon). */
export function defaultActionIcon(id: string): string { return BY_ID.get(id)?.icon ?? "terminal"; }

/** LEGACY export kept so existing imports (settings/view) don't break — the
 *  quick menu now draws from the full catalog. `QUICK_MENU_MORE` unchanged. */
export const QUICK_ACTION_CATALOG = NOTE_ACTION_CATALOG;
export type QuickActionDef = NoteActionDef;
export const QUICK_MENU_MORE = { label: "More commands…", icon: "ellipsis" };

/** Actions eligible to appear as row buttons (icon-only). */
export const BUTTON_ACTION_CATALOG = NOTE_ACTION_CATALOG.filter((a) => a.button);

/** 0.320.0: the LARGE context menu's reorderable top block. Only these plain,
 *  non-stateful actions are user-reorderable; the stateful items below them in
 *  the menu (obscure, pin, task submenu, share/export, encrypt, delete) always
 *  render in their fixed positions. */
/** 0.321.3: the ⋮ menu is now ENTIRELY built from this order (stateful items
 *  included), so the settings builder shows and reorders the whole menu. `sep`
 *  is a divider. `encrypt` / `recurrenceSkip` self-hide when not applicable. */
export const CONTEXT_DEFAULT_ORDER: readonly string[] = [
  "edit", "focus", "openNewTab", "sep",
  // 0.363.0: the four former hand-built submenus (React/Reply, Move, Pin,
  // Advanced) are now SEEDED user submenus in settings.contextSubmenus, referenced
  // as `submenu:<key>` so they show up in the submenu editor and are renamable /
  // reorderable / nestable / deletable like any user submenu. See
  // DEFAULT_CONTEXT_SUBMENUS below + the seed migration in main.ts.
  // 0.442.0 (/dump): Move ▸ promoted near the TOP (it leads with "Move in list",
  // a common action the user didn't want to scroll for). Default order only;
  // existing users keep their saved contextMenuOrder.
  "submenu:move",
  "submenu:reactreply", "recurrenceSkip",
  // 0.357.0: clone + fork relocated INTO the "Copy ▸" submenu (view.ts, the
  // `copy` case of renderCtxLeaf) — they no longer sit at the top level in the
  // default order. Their catalog leaves survive, so a user who had reordered
  // (custom contextMenuOrder still lists "clone"/"fork") keeps them top-level.
  // 0.363.0: color + obscure + encrypt grouped into the "Appearance & privacy"
  // submenu (submenu:appearance); they no longer sit at the top level by default.
  "copy", "shareExport", "sep",
  "submenu:pin", "submenu:appearance",
  "taskSubmenu", "sep", "submenu:advanced", "delete", "moreCommands",
];
/** Stateful/compound context-menu items that live only in the ⋮ menu (not the
 *  star menu or item buttons). Given labels/icons here so the builder can list
 *  them under "Add action…". */
export const CONTEXT_EXTRA_ACTIONS: readonly NoteActionDef[] = [
  { id: "sep",            label: "── Divider ──",           icon: "minus",           group: "Organize" },
  // 0.372.0: the in-list move picker (arrow + Enter to reposition/nest within the
  // list) as a first-class context leaf, so it can head the "Move ▸" submenu.
  { id: "moveInList",     label: "Move in list",            icon: "indent",          group: "Organize" },
  { id: "obscure",        label: "Obscure / reveal",        icon: "eye-off",         group: "Organize" },
  { id: "pinList",        label: "Pin in list ▸",           icon: "pin",             group: "Organize" },
  // 0.363.0: the two "Pin in list" edges as individual leaves so the seeded
  // "Pin ▸" submenu can list them (the old nested `pinList` submenu is kept as a
  // leaf case for back-compat but is no longer in the default order).
  { id: "pinListTop",     label: "Pin to top of list",      icon: "arrow-up-to-line",group: "Organize" },
  { id: "pinListBottom",  label: "Pin to bottom of list",   icon: "arrow-down-to-line",group: "Organize" },
  { id: "shareExport",    label: "Share & export ▸",        icon: "share",           group: "Copy" },
  { id: "taskSubmenu",    label: "Task ▸",                  icon: "square-check-big",group: "Organize" },
  { id: "encrypt",        label: "Encrypt (lock) note",     icon: "lock",            group: "Organize" },
  { id: "recurrenceSkip", label: "Skip to next occurrence", icon: "skip-forward",    group: "Compose" },
  { id: "history",        label: "View history",            icon: "history",         group: "Compose" },
  { id: "delete",         label: "Delete",                  icon: "trash",           group: "Organize" },
  { id: "moreCommands",   label: "More commands…",          icon: "terminal",        group: "Organize" },
];

/** 0.350.0: id → def, built from the catalog AND the context-only extras. The
 *  extras (delete, history, obscure, encrypt, …) were previously absent, so
 *  defaultActionIcon() returned the "terminal" fallback for them and the ⋮ menu
 *  showed a generic icon while settings — which reads the extras array directly —
 *  showed the right one. Declared after both arrays (const, no hoist). */
const BY_ID = new Map<string, NoteActionDef>(
  [...NOTE_ACTION_CATALOG, ...CONTEXT_EXTRA_ACTIONS].map((a) => [a.id, a]),
);
/** Actions the ⋮-menu builder can add: the catalog's context leaves + the extras
 *  above + a few catalog actions not in the default order. */
export const CONTEXT_LEAF_IDS: readonly string[] = [
  "edit", "focus", "openNewTab", "openObsidian",
  "react", "reply", "replyLink", "split",
  "copy", "clone", "fork", "setColor", "move", "moveHome", "outdent", "setDue", "largeText", "archive", "pinSidebar",
  ...CONTEXT_EXTRA_ACTIONS.map((a) => a.id),
];

/** 0.363.0: the four built-in reorg submenus, seeded into a fresh install's
 *  `settings.contextSubmenus` (DEFAULT_SETTINGS) AND merged into an existing
 *  install once (the `contextMenusSeededV1` migration in main.ts), keyed so
 *  CONTEXT_DEFAULT_ORDER's `submenu:<key>` entries resolve. Being ordinary
 *  contextSubmenus entries, they render, appear in the submenu editor, and are
 *  renamable / reorderable / nestable / deletable like any user submenu. Every
 *  item id is a real renderCtxLeaf leaf case (see view.ts). */
export const DEFAULT_CONTEXT_SUBMENUS: Record<string, { name: string; icon: string; items: string[] }> = {
  move:      { name: "Move",          icon: "move",        items: ["moveInList", "move", "moveHome", "outdent"] },
  pin:       { name: "Pin",           icon: "pin",         items: ["pinSidebar", "pinListTop", "pinListBottom"] },
  advanced:  { name: "Advanced",      icon: "settings-2",  items: ["openObsidian", "history", "split"] },
  reactreply:{ name: "React / Reply", icon: "smile-plus",  items: ["react", "reply", "replyLink"] },
  appearance:{ name: "Appearance & privacy", icon: "palette", items: ["setColor", "obscure", "encrypt"] },
};
