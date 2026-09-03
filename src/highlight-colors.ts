/** Multiple highlight colors (0.284.0) — Obsidian-Insider-compatible.
 *
 *  Obsidian's insider build encodes a highlight's color as a colored-circle
 *  emoji placed right after the opening `==`, e.g. `==🔴 red text==`. We match
 *  that syntax exactly so a note round-trips with Obsidian's own feature: their
 *  renderer colors it natively, stable Obsidian shows the emoji, and Stashpad's
 *  renderer (see note-body-renderer) strips the emoji + tints the `<mark>`.
 *
 *  "Default" = a plain `==highlight==` with no emoji.
 */
export interface HighlightColor {
  /** Stable key used for the CSS class (`stashpad-hl-<key>`) and data attr. */
  key: string;
  /** Human name shown in the composer menu + Sift-matched as you type. */
  name: string;
  /** The colored-circle emoji written into the markdown, or "" for Default. */
  emoji: string;
}

/** The palette, in menu order. Mirrors Obsidian's Red/Orange/Yellow/Green/Blue/
 *  Purple set (plus Default). Keep the emojis EXACT — they are the on-disk
 *  encoding and the cross-compat contract. */
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  { key: "default", name: "Default", emoji: "" },
  { key: "red",     name: "Red",     emoji: "🔴" },
  { key: "orange",  name: "Orange",  emoji: "🟠" },
  { key: "yellow",  name: "Yellow",  emoji: "🟡" },
  { key: "green",   name: "Green",   emoji: "🟢" },
  { key: "blue",    name: "Blue",    emoji: "🔵" },
  { key: "purple",  name: "Purple",  emoji: "🟣" },
];

/** Emoji → color key, for the renderer. Only the six real colors (Default has
 *  no emoji and needs no lookup). */
const EMOJI_TO_KEY = new Map<string, string>(
  HIGHLIGHT_COLORS.filter((c) => c.emoji).map((c) => [c.emoji, c.key]),
);

/** If `text` begins with a highlight color emoji (optionally followed by a
 *  single space), return `{ key, rest }` with the emoji (and that one space)
 *  stripped; otherwise null. Used by the renderer to color a `<mark>` and by
 *  the composer to tell "a color is already chosen" from "still picking". */
export function takeLeadingColor(text: string): { key: string; rest: string } | null {
  // Iterate by code point so a multi-codepoint match is measured correctly.
  const cp = [...text];
  if (!cp.length) return null;
  const key = EMOJI_TO_KEY.get(cp[0]);
  if (!key) return null;
  let restCp = cp.slice(1);
  if (restCp[0] === " ") restCp = restCp.slice(1); // swallow the one padding space
  return { key, rest: restCp.join("") };
}
