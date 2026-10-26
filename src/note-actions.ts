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
  group: "Open & navigate" | "Compose" | "Copy" | "Organize" | "Actions menu (⚡)";
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
  { id: "attributeBot",     label: "Attribute to AI…",              icon: "bot",                               group: "Compose" },
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
  // 0.562.0: the note's subtree becomes a Stashpad folder of its own.
  { id: "splitOut",         label: "Split out into its own folder…", icon: "folder-output",                    group: "Organize" },
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
/** 0.579.1: menu-only actions (CONTEXT_EXTRA_ACTIONS) the star menu can also run
 *  — i.e. ones view.ts `runNoteActionInner` handles. The default star menu
 *  lists "moveInList", but the star menu resolved ids against the catalog only
 *  and silently dropped it, while settings showed it. Add an id
 *  here only together with its runNoteActionInner case. */
export const QUICK_MENU_EXTRA_IDS: readonly string[] = ["moveInList"];
export type QuickActionDef = NoteActionDef;
export const QUICK_MENU_MORE = { label: "More commands…", icon: "ellipsis" };

/** Actions eligible to appear as row buttons (icon-only). */
export const BUTTON_ACTION_CATALOG = NOTE_ACTION_CATALOG.filter((a) => a.button);

/** 0.475.0: the built-in DESKTOP row buttons, as the default `settings.itemButtons`
 *  order — so the item-buttons settings editor lists them and the user can hide or
 *  reorder them (parity with the other menu editors). Existing installs are
 *  migrated to prepend these (see main.ts). Mobile has its own list
 *  (`itemButtonsMobile`, below). `react` is rendered specially (it opens the picker).
 *  0.581.2: + the row-only buttons below (Make child, Preview, Star menu), which
 *  used to sit in fixed slots outside the list. */
export const DEFAULT_ROW_BUTTONS: readonly string[] = ["edit", "focus", "reply", "react", "makeChild", "preview", "quick"];

/** 0.581.2 (user): row buttons that aren't note actions anywhere else, so they
 *  have no catalog entry — they used to be hardcoded slots that settings could
 *  only mention. Labels/icons here feed the item-button editors via
 *  noteAction(); the row renders each specially (view.ts
 *  renderConfiguredRowButtons). `makeChild` shows only in Flat / Everything
 *  views; `quick` only while the star menu has items. */
export const ROW_ONLY_IDS: ReadonlySet<string> = new Set(["makeChild", "preview", "quick"]);
export const ROW_ONLY_BUTTONS: readonly NoteActionDef[] = [
  { id: "makeChild", label: "Make child of… (Flat / Everything views)", icon: "corner-down-right", group: "Organize" },
  { id: "preview",   label: "Preview note",                              icon: "maximize-2",        group: "Open & navigate" },
  { id: "quick",     label: "⭐ Star menu",                               icon: "star",              group: "Open & navigate" },
];

/** 0.579.0: the default MOBILE row buttons (`settings.itemButtonsMobile`). A phone
 *  row is narrow, so only React is on by default (Edit / Focus / Reply live in the
 *  ⋮ menu); the user can turn the others on in settings. 0.581.2: + Star menu and
 *  Preview, in the order the mobile row always showed them. */
export const DEFAULT_MOBILE_ROW_BUTTONS: readonly string[] = ["react", "quick", "preview"];

/** 0.579.0: the mobile list an install gets before it has ever saved one: React,
 *  the user's own custom buttons from the desktop list, then the Star menu and
 *  Preview — exactly the mobile row as it was, so nothing moves on upgrade.
 *  0.581.2: Star / Preview follow the desktop list (each shows on mobile only
 *  while it's on in the desktop list), until the mobile list is edited. */
export function deriveMobileRowButtons(desktop: readonly string[]): string[] {
  const tail = ["quick", "preview"].filter((id) => desktop.includes(id));
  return ["react", ...desktop.filter((id) => !DEFAULT_ROW_BUTTONS.includes(id)), ...tail];
}

/** 0.581.2: one-time upgrade for SAVED lists that predate the row-only buttons
 *  (they were fixed slots then, shown after every listed button): append the
 *  ones a list lacks at the end, in the old visual order — desktop: Make child,
 *  Preview, Star menu; mobile: Star menu, Preview. Preview is left out (= hidden,
 *  still listed in the editor) when the old "Note preview button" setting was
 *  off. Unset mobile lists need nothing (they're derived). */
export function seedRowOnlyButtons(list: readonly string[], mobile: boolean, previewWasOn: boolean): string[] {
  const order = mobile ? ["quick", "preview"] : ["makeChild", "preview", "quick"];
  // A list that already holds ANY of them was upgraded (on this or another
  // device — the lists sync through the config folder, the per-device flag
  // doesn't), so leave it alone: re-adding would undo a deliberate hide.
  // (0.581.5: checked against ALL row-only ids on both platforms — the mobile
  // editor offers Make child too, so a mobile list holding only it is upgraded.)
  if ([...ROW_ONLY_IDS].some((id) => list.includes(id))) return [...list];
  const add = order.filter((id) => id !== "preview" || previewWasOn);
  return [...list, ...add];
}

/** 0.581.2: the four built-ins the desktop list held before the row-only
 *  buttons joined it. The legacy load paths (0.475.0 seed, 0.492.0 repair,
 *  missing-key fallback) fill a list with THESE, so seedRowOnlyButtons then adds
 *  the row-only ones in their old place and honours the old Preview toggle. */
export const LEGACY_ROW_BUTTONS: readonly string[] = ["edit", "focus", "reply", "react"];

/** 0.579.0: the row-button list in effect for a platform. The mobile list stays
 *  UNSET (undefined) until the user edits it, and is derived from the desktop
 *  list on every read until then — never stored. Storing a derived copy went
 *  stale whenever the desktop list changed underneath it (a config folder that
 *  syncs in after startup, another device's edit), and the stale copy then won
 *  the next save (blind review). Unset also lets the settings collision guard
 *  adopt another device's saved mobile list instead of overwriting it. */
export function rowButtonsFor(s: { itemButtons?: readonly string[]; itemButtonsMobile?: readonly string[] }, mobile: boolean): string[] {
  if (!mobile) return [...(s.itemButtons ?? [])];
  return s.itemButtonsMobile ? [...s.itemButtonsMobile] : deriveMobileRowButtons(s.itemButtons ?? DEFAULT_ROW_BUTTONS);
}

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
  // 0.575.2: "attributeBot" moved into the Advanced submenu (user request).
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
/** 0.575.3: the default ⋮ order as this install can actually show it.
 *  "Attribute to AI…" moved from the top level into the Advanced submenu
 *  (0.575.2), but a user can rename/repurpose Advanced (the launch top-up then
 *  skips it) or hide it — in either case the item would be in no reachable
 *  place, so it keeps its old top-level spot after "recurrenceSkip". Used by
 *  the ⋮ menu and the settings menu editor so both show the same list. */
export function defaultContextOrder(s: {
  contextSubmenus?: Record<string, { items: string[] }>;
  contextMenuHidden?: string[];
}): string[] {
  const adv = s.contextSubmenus?.advanced;
  const reachable = !!adv?.items.includes("attributeBot") && !(s.contextMenuHidden ?? []).includes("submenu:advanced");
  const order = [...CONTEXT_DEFAULT_ORDER];
  if (!reachable) order.splice(order.indexOf("recurrenceSkip") + 1, 0, "attributeBot");
  return order;
}

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

/** 0.529.0: actions that only make sense in the ⚡ actions menu (the toolbar
 *  button that acts on the SELECTION, or on nothing at all — undo, expand all,
 *  …). Ids are persisted in `settings.zapMenuOrder` / `zapSubmenus`, so never
 *  rename one. The ⚡ menu can also hold any catalog action, the context extras
 *  above, and `cmd:<obsidian id>` commands. */
export const ZAP_ACTIONS: readonly NoteActionDef[] = [
  { id: "undo",              label: "Undo",                              icon: "undo",               group: "Actions menu (⚡)" },
  { id: "redo",              label: "Redo",                              icon: "redo",               group: "Actions menu (⚡)" },
  { id: "notificationLog",   label: "Notification history…",             icon: "bell",               group: "Actions menu (⚡)" },
  { id: "reloadNoSave",      label: "Reload without saving",             icon: "rotate-ccw",         group: "Actions menu (⚡)" },
  { id: "launchView",        label: "Launch View…",                      icon: "layout-grid",        group: "Actions menu (⚡)" },
  { id: "openLink",          label: "Open Stashpad link…",               icon: "link",               group: "Actions menu (⚡)" },
  { id: "expandAll",         label: "Expand all",                        icon: "unfold-vertical",    group: "Actions menu (⚡)" },
  { id: "collapseAll",       label: "Collapse all",                      icon: "fold-vertical",      group: "Actions menu (⚡)" },
  { id: "replyInList",       label: "Reply to… (in-list)",               icon: "reply",              group: "Actions menu (⚡)" },
  { id: "toggleComplete",    label: "Toggle complete",                   icon: "check-circle",       group: "Actions menu (⚡)" },
  { id: "toggleTask",        label: "Toggle task (todo)",                icon: "square-check-big",   group: "Actions menu (⚡)" },
  { id: "addToFocus",        label: "Add to / remove from Today",        icon: "target",             group: "Actions menu (⚡)" },
  { id: "assign",            label: "Assign to…",                        icon: "user-plus",          group: "Actions menu (⚡)" },
  { id: "copyOtherVault",    label: "Copy for another vault",            icon: "copy",               group: "Actions menu (⚡)" },
  { id: "cutOtherVault",     label: "Cut for another vault",             icon: "scissors",           group: "Actions menu (⚡)" },
  { id: "insertTemplate",    label: "Insert template…",                  icon: "file-plus-2",        group: "Actions menu (⚡)" },
  { id: "merge",             label: "Merge selected",                    icon: "merge",              group: "Actions menu (⚡)" },
  { id: "mergeWith",         label: "Merge with…",                       icon: "merge",              group: "Actions menu (⚡)" },
  { id: "mergeParent",       label: "Merge into parent",                 icon: "merge",              group: "Actions menu (⚡)" },
  { id: "forkVersion",       label: "Fork as a version (draft)",         icon: "git-fork",           group: "Actions menu (⚡)" },
  { id: "markVersionFinal",  label: "Mark version as final",             icon: "star",               group: "Actions menu (⚡)" },
];

/** 0.350.0: id → def, built from the catalog AND the context-only extras. The
 *  extras (delete, history, obscure, encrypt, …) were previously absent, so
 *  defaultActionIcon() returned the "terminal" fallback for them and the ⋮ menu
 *  showed a generic icon while settings — which reads the extras array directly —
 *  showed the right one. Declared after both arrays (const, no hoist).
 *  0.529.0: the ⚡-only actions too. */
const BY_ID = new Map<string, NoteActionDef>(
  // 0.581.2: + ROW_ONLY_BUTTONS, so the item-button editors label them.
  [...NOTE_ACTION_CATALOG, ...CONTEXT_EXTRA_ACTIONS, ...ZAP_ACTIONS, ...ROW_ONLY_BUTTONS].map((a) => [a.id, a]),
);

/** 0.529.0: everything the ⚡ menu builder can add (besides `cmd:` commands and
 *  submenus): the ⚡-only actions, the catalog, and the context extras. */
export const ZAP_ADDABLE: readonly NoteActionDef[] = [
  ...ZAP_ACTIONS,
  ...NOTE_ACTION_CATALOG,
  ...CONTEXT_EXTRA_ACTIONS.filter((a) => a.id !== "sep"),
];

/** 0.529.0: the ⚡ menu's DEFAULT layout. It used to be one ~45-item flat list
 *  you had to scroll on a phone; now the everyday actions (move, delete, copy,
 *  edit, complete) sit right under Undo / Redo and the rest group into
 *  submenus. Used whenever `settings.zapMenuOrder` is empty, so existing users
 *  get it with no migration. `zapsub:<key>` resolves through
 *  `settings.zapSubmenus[key] ?? DEFAULT_ZAP_SUBMENUS[key]`. */
export const ZAP_DEFAULT_ORDER: readonly string[] = [
  "undo", "redo", "sep",
  "move", "moveInList", "delete", "copy", "edit", "toggleComplete", "sep",
  "zapsub:organize", "zapsub:open", "zapsub:share", "zapsub:merge", "zapsub:view", "sep",
  "moreCommands",
];

export const DEFAULT_ZAP_SUBMENUS: Record<string, { name: string; icon: string; items: string[] }> = {
  organize: { name: "Organize",        icon: "folder-tree",  items: ["outdent", "replyInList", "setColor", "setDue", "assign", "toggleTask", "addToFocus", "blur"] },
  open:     { name: "Open",            icon: "external-link", items: ["openNewTab", "openObsidian", "launchView", "openLink"] },
  share:    { name: "Copy & share",    icon: "share",        items: ["copyOtherVault", "cutOtherVault", "shareExport", "insertTemplate"] },
  merge:    { name: "Merge & split",   icon: "merge",        items: ["merge", "mergeWith", "mergeParent", "split", "forkVersion", "markVersionFinal"] },
  view:     { name: "View & app",      icon: "settings-2",   items: ["expandAll", "collapseAll", "notificationLog", "reloadNoSave"] },
};
/** Actions the ⋮-menu builder can add: the catalog's context leaves + the extras
 *  above + a few catalog actions not in the default order. */
export const CONTEXT_LEAF_IDS: readonly string[] = [
  "edit", "focus", "openNewTab", "openObsidian",
  "react", "reply", "replyLink", "split", "attributeBot",
  "copy", "clone", "fork", "setColor", "move", "moveHome", "outdent", "setDue", "largeText", "archive", "pinSidebar",
  // 0.579.2: in the default Move ▸ submenu since 0.562.0 and rendered by the ⋮
  // menu, but missing here — so it was dropped from a top-level custom order and
  // couldn't be added in the editors.
  "splitOut",
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
  // 0.562.0: splitOut joins Move; the launch top-up appends it for seeded users.
  move:      { name: "Move",          icon: "move",        items: ["moveInList", "move", "moveHome", "outdent", "splitOut"] },
  pin:       { name: "Pin",           icon: "pin",         items: ["pinSidebar", "pinListTop", "pinListBottom"] },
  // 0.575.2: attributeBot joins Advanced; the launch top-up appends it for seeded users.
  advanced:  { name: "Advanced",      icon: "settings-2",  items: ["openObsidian", "history", "split", "attributeBot"] },
  reactreply:{ name: "React / Reply", icon: "smile-plus",  items: ["react", "reply", "replyLink"] },
  appearance:{ name: "Appearance & privacy", icon: "palette", items: ["setColor", "obscure", "encrypt"] },
};

/** 0.579.2: every id reachable from a menu `order`, following submenu
 *  references (`<prefix><key>`, e.g. "submenu:" for ⋮, "zapsub:" for ⚡) into
 *  `submenus[key].items`, recursively. Cycle-safe. */
export function reachableMenuIds(order: readonly string[], submenus: Record<string, { items: readonly string[] }>, prefix: string): Set<string> {
  const out = new Set<string>();
  const visited = new Set<string>();
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      out.add(id);
      if (!id.startsWith(prefix)) continue;
      const key = id.slice(prefix.length);
      if (visited.has(key)) continue;
      visited.add(key);
      const sm = submenus[key];
      if (sm) walk(sm.items);
    }
  };
  walk(order);
  return out;
}

/** 0.579.2: put each `missing` id into a saved custom `order` where the default
 *  has it — right after the nearest earlier default item the order still holds
 *  (dividers don't count as anchors), or at the front when none does. Ids are
 *  placed in default order, so several new ones keep their relative order. */
export function insertMissingDefaults(order: readonly string[], defaults: readonly string[], missing: readonly string[]): string[] {
  const out = [...order];
  defaults.forEach((id, i) => {
    if (!missing.includes(id) || out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (defaults[j] === "sep") continue;
      const k = out.lastIndexOf(defaults[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, id);
  });
  return out;
}

/** 0.579.2: the ⋮ menu's built-in top-level items (and built-in submenus) that a
 *  saved CUSTOM order can no longer reach. Built-ins can't be deleted from that
 *  menu — the settings editor only HIDES them (contextMenuHidden), which keeps
 *  them in the order — so a missing one was never the user's choice: it is a
 *  built-in added after they customized (e.g. "Appearance & privacy ▸"), and
 *  without this it was invisible in both the menu and its settings editor. */
export function missingContextBuiltins(order: readonly string[], submenus: Record<string, { items: readonly string[] }>, defaults: readonly string[]): string[] {
  if (!order.length) return [];   // empty = the live default, which has everything
  const reach = reachableMenuIds(order, submenus, "submenu:");
  return defaults.filter((id) => id !== "sep" && !reach.has(id));
}

/** 0.579.2: the ⚡ menu's built-in entries as signatures: top-level ids, plus
 *  `<submenuKey>/<itemId>` for each default submenu's items. The ⚡ menu lets the
 *  user REMOVE built-ins, so new defaults are only offered once: settings keep
 *  `zapDefaultsSeen` and a signature not in it is new since the last load. */
export function zapDefaultSignatures(): string[] {
  const top = ZAP_DEFAULT_ORDER.filter((id) => id !== "sep");
  const subs = Object.entries(DEFAULT_ZAP_SUBMENUS).flatMap(([k, v]) => v.items.map((it) => `${k}/${it}`));
  return [...top, ...subs];
}
/** Defaults added to the ⚡ menu after it became customizable (0.529.0) but
 *  before `zapDefaultsSeen` existed — treated as unseen on an install's first
 *  reconcile so they reach users who had already customized. */
export const ZAP_DEFAULTS_ADDED_BEFORE_TRACKING: readonly string[] = ["organize/addToFocus"];

/** 0.579.2: bring NEW ⚡ defaults into a customized ⚡ menu, once each. Returns
 *  the updated order / submenu overrides and the new `seen` list. A new
 *  top-level default goes into a saved custom order (where the default has it);
 *  a new item of a default submenu goes into the user's saved override of that
 *  submenu. Either is skipped when the item is already reachable somewhere in
 *  the menu (the user moved it), and an empty order / un-overridden submenu
 *  already shows the live default. */
export function reconcileZapDefaults(s: {
  zapMenuOrder?: readonly string[];
  zapSubmenus?: Record<string, { name: string; icon: string; items: string[] }>;
  zapDefaultsSeen?: readonly string[];
}): { order: string[]; submenus: Record<string, { name: string; icon: string; items: string[] }>; seen: string[]; changed: boolean } {
  const all = zapDefaultSignatures();
  const seenList = Array.isArray(s.zapDefaultsSeen) ? s.zapDefaultsSeen : all.filter((x) => !ZAP_DEFAULTS_ADDED_BEFORE_TRACKING.includes(x));
  const seen = new Set(seenList);
  const fresh = all.filter((x) => !seen.has(x));
  let order = [...(s.zapMenuOrder ?? [])];
  const submenus = { ...(s.zapSubmenus ?? {}) };
  const reach = reachableMenuIds(order.length ? order : ZAP_DEFAULT_ORDER, { ...DEFAULT_ZAP_SUBMENUS, ...submenus }, "zapsub:");
  let changed = false;
  const topNew = fresh.filter((x) => !x.includes("/") && !reach.has(x));
  if (order.length && topNew.length) { order = insertMissingDefaults(order, ZAP_DEFAULT_ORDER, topNew); changed = true; }
  for (const sig of fresh) {
    const slash = sig.indexOf("/");
    if (slash < 0) continue;
    const key = sig.slice(0, slash);
    const item = sig.slice(slash + 1);
    const cur = submenus[key];
    if (!cur || reach.has(item)) continue;
    submenus[key] = { ...cur, items: insertMissingDefaults(cur.items, DEFAULT_ZAP_SUBMENUS[key]?.items ?? [], [item]) };
    reach.add(item);
    changed = true;
  }
  const seenChanged = !Array.isArray(s.zapDefaultsSeen) || fresh.length > 0;
  return { order, submenus, seen: all, changed: changed || seenChanged };
}
