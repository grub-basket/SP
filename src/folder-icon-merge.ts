/** 0.607.0 — folder icons survive a sync between two devices.
 *
 *  THE BUG. `folderIcons` (folder → Lucide icon id) was one whole value in
 *  data.json. Two devices with the same vault open each hold a copy. When one of
 *  them writes a copy that is behind (a phone that loaded before the sync pulled
 *  the Mac's file, a device on an older build, or Obsidian Sync's own JSON merge,
 *  which picks one side per top-level key and knows nothing about Stashpad), the
 *  other device sees "our icons unchanged, the file's changed → take the file's"
 *  and adopts the stale map wholesale. Every icon set since then disappears, on
 *  both devices once they sync again.
 *
 *  THE PROVISION. Every icon change is recorded as a STAMP in
 *  `folderIconStamps`: folder → { t: when, icon: the icon it was set to, or null
 *  for "cleared" }. Two copies merge folder by folder and the later stamp wins.
 *  A folder merely missing from a copy, with no newer stamp, is NOT a removal:
 *  the icon stays. So a stale copy can no longer take icons away, while clearing
 *  an icon (or renaming a folder, which clears the old path) still reaches every
 *  device.
 *
 *  A stamp carries its icon, and wherever a folder has a stamp the stamp — not
 *  the `folderIcons` entry beside it — says what the icon is. `folderIcons` is
 *  kept as a plain mirror for older builds to read. This matters because the two
 *  keys can come from different copies: Obsidian Sync merges data.json key by
 *  key, and an older build rewrites `folderIcons` (or appearance.json) with its
 *  stale map while keeping, or dropping, the stamps. Pairing a stale icon with a
 *  fresh time would let the stale icon win; trusting only the stamp can't.
 *
 *  Folders with no stamp (data from before this version, or set by an older
 *  build) are "untimed". An untimed icon is kept when the other side has nothing
 *  for that folder; when both sides have different untimed icons the
 *  alphabetically later id wins, so every device picks the SAME one and they stop
 *  rewriting each other. The costs, only while devices run mixed builds: an icon
 *  an older build clears (or changes) on a folder that already has a stamp
 *  doesn't stick, and an icon cleared on an older build can come back. For a
 *  cosmetic setting, reverting or coming back beats vanishing.
 *
 *  Pure / DOM-free so it is unit-tested (scripts/tests/folder-icon-merge.test.ts). */

export type FolderIcons = Record<string, string>;
/** One recorded change: when, and the icon it was set to (null = cleared). */
export interface IconStamp { t: number; icon: string | null }
export type FolderIconStamps = Record<string, IconStamp>;
export interface FolderIconState { icons: FolderIcons; stamps: FolderIconStamps }

/** A "cleared" stamp is kept this long, then dropped (it only has to outlive the
 *  longest a device stays offline with an old copy). Stamps for icons that are
 *  SET are never dropped: they are what makes the icon win. */
export const ICON_CLEAR_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const iconId = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** Only real icon ids: non-blank strings, trimmed. Anything else reads as "no icon". */
export function cleanIcons(raw: unknown): FolderIcons {
  const out: FolderIcons = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = iconId(v);
    if (id) out[k] = id;
  }
  return out;
}

/** Well-formed stamps only; expired "cleared" stamps dropped. */
export function cleanStamps(raw: unknown, now: number): FolderIconStamps {
  const out: FolderIconStamps = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, s] of Object.entries(raw as Record<string, unknown>)) {
    if (!s || typeof s !== "object") continue;
    const t = (s as { t?: unknown }).t;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    const icon = iconId((s as { icon?: unknown }).icon);
    if (icon === null && now - t >= ICON_CLEAR_TTL_MS) continue;
    out[k] = { t, icon };
  }
  return out;
}

/** One copy (an icon map + its stamps, as read from a file), made consistent:
 *  every stamped folder's icon is the stamp's (removed if the stamp is a clear),
 *  whatever that copy's icon map says. Unstamped icons stay as untimed. */
export function cleanIconState(rawIcons: unknown, rawStamps: unknown, now: number): FolderIconState {
  const icons = cleanIcons(rawIcons);
  const stamps = cleanStamps(rawStamps, now);
  for (const [k, s] of Object.entries(stamps)) {
    if (s.icon === null) delete icons[k]; else icons[k] = s.icon;
  }
  return { icons, stamps };
}

/** Stamp every folder whose icon differs between `base` (the map as of our last
 *  read/write) and `ours` (the live map) as changed `now`, with its new icon (or
 *  null if cleared). This is how local edits get stamped without every place
 *  that edits icons (the icon picker, folder setup, rename/move remaps, folder
 *  merge) having to remember to. The new time is always later than the folder's
 *  previous stamp, even if this device's clock is behind the device that wrote
 *  it. Returns `stamps` itself when nothing changed. */
export function stampIconEdits(base: FolderIcons, ours: FolderIcons, stamps: FolderIconStamps, now: number): FolderIconStamps {
  let out = stamps;
  for (const k of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (base[k] === ours[k]) continue;
    if (out === stamps) out = { ...stamps };
    const prev = stamps[k]?.t;
    const t = Math.max(now, (typeof prev === "number" && Number.isFinite(prev) ? prev : 0) + 1);
    out[k] = { t, icon: ours[k] ?? null };
  }
  return out;
}

/** Merge two CLEANED copies folder by folder (see the header). Symmetric:
 *  merge(a, b) and merge(b, a) give the same result, so devices converge; and
 *  merging a result again changes nothing. Keys come out sorted. */
export function mergeFolderIcons(a: FolderIconState, b: FolderIconState): FolderIconState {
  const keys = new Set([
    ...Object.keys(a.icons), ...Object.keys(a.stamps),
    ...Object.keys(b.icons), ...Object.keys(b.stamps),
  ]);
  const icons: FolderIcons = {};
  const stamps: FolderIconStamps = {};
  for (const k of [...keys].sort()) {
    const ta = a.stamps[k]?.t ?? 0, tb = b.stamps[k]?.t ?? 0;
    const va = a.icons[k], vb = b.icons[k];
    let v: string | undefined;
    if (ta > tb) v = va;
    else if (tb > ta) v = vb;
    else if (va === undefined) v = vb;          // absence without a newer stamp never removes
    else if (vb === undefined) v = va;
    else v = va >= vb ? va : vb;                 // same moment, two icons: pick the same one everywhere
    const t = Math.max(ta, tb);
    if (t > 0) stamps[k] = { t, icon: v ?? null };
    if (v !== undefined) icons[k] = v;
  }
  return { icons, stamps };
}

/** Order-insensitive identity of a state, for "did anything change?" checks. */
export function iconStateKey(s: FolderIconState): string {
  const sort = <T,>(r: Record<string, T>): [string, T][] => Object.entries(r).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  // `?.`: callers also pass RAW settings, where a stamp may be junk.
  return JSON.stringify([sort(s.icons), sort(s.stamps).map(([k, v]) => [k, v?.t, v?.icon])]);
}

/** Folders whose icon differs between two maps (to repaint just those tabs). */
export function changedIconFolders(a: FolderIcons, b: FolderIcons): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}
