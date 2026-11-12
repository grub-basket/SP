/* Pure tests for src/folder-icon-merge.ts (folder icons across synced devices) */
import {
  changedIconFolders, cleanIconState, cleanIcons, cleanStamps, iconStateKey, mergeFolderIcons, stampIconEdits,
  ICON_CLEAR_TTL_MS,
} from "../../src/folder-icon-merge";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const NOW = 1_800_000_000_000;
const c = (icons: unknown, stamps: unknown) => cleanIconState(icons, stamps, NOW);
const set = (t: number, icon: string) => ({ t, icon });
const clr = (t: number) => ({ t, icon: null });

// The reported bug: the Mac sets icons, the phone's stale copy (no icons, or
// fewer) lands on top. The icons must survive.
{
  const mac = c({ Work: "briefcase", Inbox: "inbox" }, { Work: set(NOW - 1000, "briefcase"), Inbox: set(NOW - 500, "inbox") });
  __eq(mergeFolderIcons(mac, c({}, {})).icons, { Inbox: "inbox", Work: "briefcase" }, "an empty stale copy removes nothing");
  __eq(mergeFolderIcons(mac, c(undefined, undefined)).icons, { Inbox: "inbox", Work: "briefcase" }, "a copy with no icon keys at all removes nothing");
  const staleOld = c({ Work: "folder" }, { Work: set(NOW - 99_000, "folder") });
  __eq(mergeFolderIcons(mac, staleOld).icons, { Inbox: "inbox", Work: "briefcase" }, "an older icon loses to the newer one");
  __eq(mergeFolderIcons(staleOld, mac), mergeFolderIcons(mac, staleOld), "the merge is the same from either side");
}

// Blind-review finding: a stale icon paired with a fresh stamp (an older build
// rewrote the icon map but kept, or a sync merge mixed in, the newer stamps).
// The stamp, not the icon beside it, says what the icon is.
{
  const ours = c({ X: "apple" }, { X: set(NOW, "apple") });
  const staleWithOurStamp = c({ X: "zebra" }, { X: set(NOW, "apple") });
  __eq(staleWithOurStamp.icons, { X: "apple" }, "a stamped folder shows its stamp's icon, whatever the icon map says");
  __eq(mergeFolderIcons(ours, staleWithOurStamp).icons, { X: "apple" }, "the stale zebra can't win on apple's time");
  // The icon map lost the folder, the stamps still have it: the stamp restores it.
  __eq(c({}, { X: set(NOW, "apple") }).icons, { X: "apple" }, "a stamp brings back an icon its copy's map dropped");
}

// Clearing an icon still travels: the clear stamp is newer than the icon.
{
  const phone = c({}, { Work: clr(NOW) });
  const mac = c({ Work: "briefcase" }, { Work: set(NOW - 1000, "briefcase") });
  __eq(mergeFolderIcons(mac, phone).icons, {}, "a newer clear removes the icon");
  __eq(mergeFolderIcons(mac, phone).stamps, { Work: clr(NOW) }, "the clear stamp is kept");
  const again = c({ Work: "star" }, { Work: set(NOW + 10, "star") });
  __eq(mergeFolderIcons(phone, again).icons, { Work: "star" }, "re-setting after a clear wins");
  // A cleared folder still listed in that copy's icon map (an older build kept it).
  __eq(c({ Work: "briefcase" }, { Work: clr(NOW) }).icons, {}, "a clear stamp removes the icon even if that file still lists it");
}

// Copies from before this version have no stamps.
{
  const a = c({ A: "rocket" }, {});
  const b = c({ B: "star" }, {});
  __eq(mergeFolderIcons(a, b).icons, { A: "rocket", B: "star" }, "no stamps: icons from both sides are kept");
  const x = c({ A: "rocket" }, {});
  const y = c({ A: "star" }, {});
  __eq(mergeFolderIcons(x, y).icons, mergeFolderIcons(y, x).icons, "no stamps, two icons: both devices pick the same one");
  __eq(mergeFolderIcons(x, y).stamps, {}, "no stamp is invented by a merge");
}

// Local edits get stamped, whatever changed them.
{
  const base = { Work: "briefcase", Old: "star" };
  const ours = { Work: "rocket", New: "star" }; // icon changed; Old renamed to New
  const s = stampIconEdits(base, ours, { Work: set(NOW + 5000, "briefcase") }, NOW);
  __eq(s, { Work: set(NOW + 5001, "rocket"), Old: clr(NOW), New: set(NOW, "star") },
    "changed, removed and added folders stamped with their new icon; never earlier than before");
  const same = { Work: set(NOW, "briefcase") };
  __assert(stampIconEdits(base, { ...base }, same, NOW) === same, "nothing changed: same object back");
  // An edit over an existing stamp must be stamped before cleaning, or the old
  // stamp's icon would overwrite it.
  const before = { Work: set(NOW - 10, "briefcase") };
  __eq(c({ Work: "rocket" }, before).icons, { Work: "briefcase" }, "unstamped, the old stamp wins (why reconcile stamps first)");
  __eq(c({ Work: "rocket" }, stampIconEdits({ Work: "briefcase" }, { Work: "rocket" }, before, NOW)).icons, { Work: "rocket" }, "stamped, the edit stands");
  // A rename's old path can't be brought back by a stale copy.
  const stale = c({ Old: "star" }, {});
  __eq(mergeFolderIcons(c(ours, s), stale).icons, { New: "star", Work: "rocket" }, "a stale copy can't bring a renamed folder's old entry back");
}

// Cleaning.
{
  __eq(cleanIcons({ A: " rocket ", B: "", C: 3, D: null }), { A: "rocket" }, "only non-blank strings are icons");
  __eq(cleanIcons(["x"]), {}, "an array is not an icon map");
  const st = cleanStamps({
    A: set(5, " rocket "), B: clr(NOW - ICON_CLEAR_TTL_MS - 1), C: clr(NOW - 10),
    D: "x", E: { t: 0, icon: "x" }, F: null, G: { t: NOW - 20, icon: "" },
  }, NOW);
  __eq(st, { A: set(5, "rocket"), C: clr(NOW - 10), G: clr(NOW - 20) },
    "expired clears and junk dropped; a set stamp never expires; a blank icon reads as cleared");
}

// Convergence: two devices that each merge the other's copy end up identical.
{
  const a = c({ A: "x", B: "y" }, { A: set(NOW - 5, "x"), C: clr(NOW - 3) });
  const b = c({ A: "z", C: "w", D: "v" }, { A: set(NOW - 9, "z"), C: set(NOW - 4, "w") });
  const ab = mergeFolderIcons(a, b), ba = mergeFolderIcons(b, a);
  __eq(iconStateKey(ab), iconStateKey(ba), "both sides reach the same state");
  __eq(iconStateKey(mergeFolderIcons(ab, c(ab.icons, ab.stamps))), iconStateKey(ab), "merging the result again changes nothing (no rewrite loop)");
  __eq(ab.icons, { A: "x", B: "y", D: "v" }, "newest wins per folder; the clear beats the older set");
}

// Helpers.
{
  __eq(iconStateKey({ icons: { B: "x", A: "y" }, stamps: {} }), iconStateKey({ icons: { A: "y", B: "x" }, stamps: {} }), "key order doesn't matter");
  iconStateKey({ icons: {}, stamps: { A: null } as unknown as Record<string, { t: number; icon: string | null }> }); // must not throw on raw junk
  __eq(changedIconFolders({ A: "x", B: "y" }, { A: "x", C: "z" }).sort(), ["B", "C"], "changed folders listed");
}
