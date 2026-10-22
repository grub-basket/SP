/* Pure tests for src/note-actions.ts */
import {
  DEFAULT_ROW_BUTTONS, DEFAULT_MOBILE_ROW_BUTTONS, deriveMobileRowButtons, rowButtonsFor,
  reachableMenuIds, insertMissingDefaults, missingContextBuiltins, reconcileZapDefaults, zapDefaultSignatures,
  ZAP_DEFAULT_ORDER, DEFAULT_ZAP_SUBMENUS,
} from "../../src/note-actions";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// 0.579.0: an install with no saved mobile list gets the row it had before the
// list existed — React plus the custom buttons from the desktop list, never the
// desktop-only built-ins.
__eq(deriveMobileRowButtons(DEFAULT_ROW_BUTTONS), ["react"], "default desktop list → just React");
__eq(deriveMobileRowButtons(["edit", "focus", "reply", "react", "copy", "cmd:app:open-settings"]), ["react", "copy", "cmd:app:open-settings"], "customs carried over in order");
__eq(deriveMobileRowButtons(["copy", "edit"]), ["react", "copy"], "React stays even if hidden on desktop (it always showed on mobile before)");
__eq(deriveMobileRowButtons([]), ["react"], "empty desktop list → just React");
// rowButtonsFor: desktop reads itemButtons; mobile reads its own list once set,
// and is DERIVED from the current desktop list while unset (never stale).
__eq(rowButtonsFor({ itemButtons: ["edit", "copy"] }, false), ["edit", "copy"], "desktop = itemButtons");
__eq(rowButtonsFor({ itemButtons: ["edit", "copy"] }, true), ["react", "copy"], "unset mobile derives from desktop");
__eq(rowButtonsFor({ itemButtons: ["edit", "move"] }, true), ["react", "move"], "…and follows a later desktop change");
__eq(rowButtonsFor({ itemButtons: ["edit", "copy"], itemButtonsMobile: ["copy"] }, true), ["copy"], "a saved mobile list wins (React hidden)");
__eq(rowButtonsFor({ itemButtons: ["edit"], itemButtonsMobile: [] }, true), [], "an EMPTY saved mobile list means no buttons, not unset");
__eq(rowButtonsFor({}, true), ["react"], "nothing loaded → default mobile row");
__assert(DEFAULT_MOBILE_ROW_BUTTONS.every((id) => DEFAULT_ROW_BUTTONS.includes(id)), "mobile defaults are built-ins the settings editor always lists");

// --- 0.579.2: built-ins reaching customized menus ---------------------------

// reachableMenuIds follows submenu references, recursively, cycle-safe.
{
  const subs = { a: { items: ["x", "submenu:b"] }, b: { items: ["y", "submenu:a"] }, orphan: { items: ["z"] } };
  const r = reachableMenuIds(["edit", "submenu:a"], subs, "submenu:");
  __assert(r.has("x") && r.has("y") && r.has("submenu:b"), "walks nested submenus");
  __assert(!r.has("z"), "an orphan submenu's items are not reachable");
}

// insertMissingDefaults puts a new id after its nearest earlier default.
__eq(insertMissingDefaults(["edit", "copy", "delete"], ["edit", "focus", "sep", "copy", "share", "delete"], ["share"]),
  ["edit", "copy", "share", "delete"], "after the nearest earlier default");
__eq(insertMissingDefaults(["copy", "edit"], ["edit", "focus", "copy"], ["focus"]),
  ["copy", "edit", "focus"], "anchors on the user's position of the earlier default");
__eq(insertMissingDefaults(["copy"], ["edit", "copy"], ["edit"]), ["edit", "copy"], "no earlier anchor → front");
__eq(insertMissingDefaults(["a"], ["a", "sep", "b", "c"], ["b", "c"]), ["a", "b", "c"], "several new ids keep default order; dividers aren't anchors");

// missingContextBuiltins: only for a CUSTOM order; anything reachable (top level
// or inside any reachable submenu) counts as present; dividers never count.
{
  const defaults = ["edit", "sep", "submenu:move", "copy", "submenu:appearance", "delete"];
  const subs = { move: { items: ["move"] }, appearance: { items: ["setColor"] }, mine: { items: ["copy"] } };
  __eq(missingContextBuiltins([], subs, defaults), [], "empty order = live default, nothing missing");
  __eq(missingContextBuiltins(["edit", "submenu:move", "submenu:mine", "delete"], subs, defaults),
    ["submenu:appearance"], "copy nested in a user submenu is present; the new built-in submenu is missing");
}

// reconcileZapDefaults
{
  const all = zapDefaultSignatures();
  __assert(all.includes("organize/addToFocus") && all.includes("move"), "signatures cover top level + submenu items");
  // Default menu (empty order, no overrides): nothing to change but seen gets recorded.
  const r0 = reconcileZapDefaults({});
  __eq(r0.order, [], "default menu stays default");
  __eq(r0.seen, all, "seen recorded");
  __assert(r0.changed, "first run writes seen");
  // A customized Organize (from 0.529, before addToFocus) gets it once.
  const organize = { ...DEFAULT_ZAP_SUBMENUS.organize, items: DEFAULT_ZAP_SUBMENUS.organize.items.filter((x) => x !== "addToFocus") };
  const r1 = reconcileZapDefaults({ zapSubmenus: { organize } });
  __eq(r1.submenus.organize.items, DEFAULT_ZAP_SUBMENUS.organize.items, "pre-tracking new default reaches a customized submenu, at its default spot");
  // …and if the user removes it afterwards, it stays removed.
  const r2 = reconcileZapDefaults({ zapSubmenus: { organize }, zapDefaultsSeen: r1.seen });
  __assert(!r2.submenus.organize.items.includes("addToFocus"), "a removed default is not re-added");
  __assert(!r2.changed, "converged: nothing to write");
  // Moved elsewhere by the user → not duplicated.
  const r3 = reconcileZapDefaults({ zapSubmenus: { organize }, zapMenuOrder: [...ZAP_DEFAULT_ORDER, "addToFocus"] });
  __assert(!r3.submenus.organize.items.includes("addToFocus"), "already reachable elsewhere → not added again");
  // A NEW top-level default lands in a custom order at its default spot.
  const seenWithoutRedo = all.filter((x) => x !== "redo");
  const r4 = reconcileZapDefaults({ zapMenuOrder: ["undo", "move", "delete"], zapDefaultsSeen: seenWithoutRedo });
  __eq(r4.order, ["undo", "redo", "move", "delete"], "new top-level default inserted after its anchor");
}
