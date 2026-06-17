// Sheet "versions" — several notes sharing a `sheet-group` id are treated as
// alternate versions of one item. Only the active version shows as a row; its
// siblings collapse into a small tab bar on that row. The frontmatter keys are
// shared with the standalone Sheets plugin so the same notes work in both.
//
// The group key is `sheet-group` (NOT the generic `sheet`) to avoid colliding
// with a user's own unrelated frontmatter, AND a note only counts as a version
// when it carries BOTH `sheet-group` and a numeric `sheet-order` (see
// isVersionMember) — so a stray single key can never silently hide a note.
import { App, TFile } from "obsidian";
import { TreeNode } from "./types";

export const SHEET_KEY = "sheet-group"; // group id shared by all versions (string)
export const SHEET_ORDER_KEY = "sheet-order"; // numeric order within the group
export const SHEET_FINAL_KEY = "sheet-final"; // true on the chosen version
export const SHEET_LABEL_KEY = "sheet-label"; // optional custom tab label
export const SHEET_ORIGIN_KEY = "sheet-origin"; // true on the original (group seed)
export const FORKED_FROM_KEY = "forked-from"; // provenance: id of the note this was forked from
export const SIBLINGS_KEY = "fork-siblings"; // wikilinks to all other members of the fork family

/** Keys that mark a note as a sheet version or record its provenance. They are
 *  stripped when a note is DUPLICATED by clone / fork-note / insert-template —
 *  a copy is a brand-new note, never a silent member of the source's version
 *  group and never an "original" or "final". */
export const SHEET_COPY_SKIP_KEYS: readonly string[] = [
  SHEET_KEY, SHEET_ORDER_KEY, SHEET_FINAL_KEY, SHEET_LABEL_KEY, SHEET_ORIGIN_KEY, FORKED_FROM_KEY, SIBLINGS_KEY,
];

type Fm = Record<string, unknown> | null | undefined;

export function sheetIdOf(fm: Fm): string | null {
  if (!fm) return null;
  const v = fm[SHEET_KEY];
  return typeof v === "string" && v.trim() ? v : null;
}

export function sheetOrderOf(fm: Fm): number | null {
  const v = fm?.[SHEET_ORDER_KEY];
  return typeof v === "number" ? v : null;
}

/** A note is a version-group member only when it carries BOTH a group id and a
 *  numeric order. Requiring two keys makes accidental collisions (a user with
 *  an unrelated `sheet-group` key) essentially impossible — the collapse filter
 *  ignores anything that isn't a deliberate, fully-stamped version. */
export function isVersionMember(fm: Fm): boolean {
  return sheetIdOf(fm) !== null && sheetOrderOf(fm) !== null;
}

export function sheetIsFinal(fm: Fm): boolean {
  return fm?.[SHEET_FINAL_KEY] === true;
}

/** True on the original note that seeded the group (never on a fork). */
export function isOriginal(fm: Fm): boolean {
  return fm?.[SHEET_ORIGIN_KEY] === true;
}

/** The raw `forked-from` value (a `[[wikilink]]`), if any. */
export function forkedFromOf(fm: Fm): string | null {
  const v = fm?.[FORKED_FROM_KEY];
  return typeof v === "string" && v.trim() ? v : null;
}

/** The bare note name inside a `[[wikilink]]` (strips brackets, alias, subpath). */
export function wikilinkName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const inner = raw.replace(/^\[\[/, "").replace(/\]\]$/, "");
  return inner.split("|")[0].split("#")[0].trim() || null;
}

/** The bare note name behind `forked-from`. */
export function forkedFromName(fm: Fm): string | null {
  return wikilinkName(forkedFromOf(fm));
}

export function sheetLabelOf(fm: Fm): string | null {
  const v = fm?.[SHEET_LABEL_KEY];
  return typeof v === "string" && v.trim() ? v : null;
}

/** Generate a fresh, reasonably-unique group id (matches the Sheets plugin). */
export function newSheetGroupId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `s-${t}-${r}`;
}

/** Read a node's frontmatter via the metadata cache. */
export function nodeFm(app: App, node: TreeNode): Fm {
  if (!node.file) return null;
  return app.metadataCache.getFileCache(node.file)?.frontmatter as Fm;
}

/** Sort group members by order, then created, then id — stable + deterministic. */
export function sortVersions(app: App, members: TreeNode[]): TreeNode[] {
  return members.slice().sort((a, b) => {
    const oa = sheetOrderOf(nodeFm(app, a));
    const ob = sheetOrderOf(nodeFm(app, b));
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    const ca = a.created ?? "";
    const cb = b.created ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The default active version of a group: the final pick, else the first by
 *  order. `members` should already be the ones present in the current list. */
export function defaultActive(app: App, members: TreeNode[]): TreeNode | null {
  if (members.length === 0) return null;
  const sorted = sortVersions(app, members);
  return sorted.find((m) => sheetIsFinal(nodeFm(app, m))) ?? sorted[0];
}

/** A short label for a tab: the custom label, else the note's first body line
 *  (the title Stashpad shows), falling back to the basename. */
export function tabTitle(app: App, node: TreeNode, fallbackTitle: string): string {
  const label = sheetLabelOf(nodeFm(app, node));
  if (label) return label;
  return fallbackTitle;
}
