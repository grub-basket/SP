import { setIcon, type Workspace, type WorkspaceLeaf } from "obsidian";
import { getSettings } from "./settings";

/** 0.199.0: "New tabs open in the background" behavior. Call AFTER opening a
 *  new tab, passing the leaf that was active BEFORE `getLeaf("tab")`: when the
 *  setting is on, focus is handed straight back so the new tab loads behind
 *  the user's current place. Returns true when it backgrounded. (settings.ts's
 *  import of this module is type-only, so there's no runtime import cycle.) */
export function settleNewTab(ws: Workspace, prev: WorkspaceLeaf | null | undefined): boolean {
  if (!getSettings().newTabsInBackground) return false;
  if (prev) ws.setActiveLeaf(prev, { focus: true });
  return true;
}

/** How a block of text is broken into multiple notes — for the composer's
 *  split-on-submit and the per-note Split modal's "Split by…" presets. */
export type SplitMode = "lines" | "paragraphs" | "headings";

export const SPLIT_MODE_LABELS: Record<SplitMode, string> = {
  lines: "Each line",
  paragraphs: "Paragraphs (blank line)",
  headings: "Headings",
};

/** Break `text` into trimmed, non-empty chunks per the chosen mode:
 *   - lines: one chunk per newline (the original split behavior)
 *   - paragraphs: split on blank lines (one or more)
 *   - headings: start a new chunk at each Markdown heading line (`#`..`######`);
 *               any preamble before the first heading is its own chunk. */
export function splitIntoChunks(text: string, mode: SplitMode): string[] {
  const norm = text.replace(/\r\n/g, "\n");
  if (mode === "lines") {
    return norm.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (mode === "paragraphs") {
    return norm.split(/\n[ \t]*\n+/).map((s) => s.trim()).filter(Boolean);
  }
  // headings
  const chunks: string[] = [];
  let cur: string[] = [];
  const isHeading = (line: string) => /^#{1,6}\s/.test(line);
  for (const line of norm.split("\n")) {
    if (isHeading(line) && cur.some((l) => l.trim())) {
      chunks.push(cur.join("\n").trim());
      cur = [];
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim())) chunks.push(cur.join("\n").trim());
  return chunks.filter(Boolean);
}

/** 0.76.33: setIcon that never leaves a blank button. If `name` isn't
 *  in this Obsidian build's bundled Lucide set (older iPad/iOS app
 *  versions lag desktop, so some names that resolve on desktop don't
 *  resolve there), setIcon injects no <svg> and the button renders
 *  empty. We detect that (setIcon is synchronous) and drop in a
 *  Unicode glyph so there's always a visible affordance. */
export function setIconSafe(el: HTMLElement, name: string, fallbackGlyph: string): void {
  el.empty();
  try { setIcon(el, name); } catch { /* ignore */ }
  // The ONLY reliable signal that the icon actually rendered is the
  // presence of a drawable shape element inside the injected <svg>.
  // Older/stripped mobile Lucide bundles can inject an empty (or
  // whitespace-only) <svg class="svg-icon"></svg> for names they don't
  // know — an svg node that exists but draws nothing. Checking for a
  // path/line/circle/etc. distinguishes "real icon" from "empty shell".
  const svg = el.querySelector("svg");
  const drawn = !!svg && !!svg.querySelector(
    "path, line, circle, rect, polyline, polygon, ellipse"
  );
  if (drawn) return;
  el.empty();
  el.createSpan({ cls: "stashpad-icon-fallback", text: fallbackGlyph });
}

/** True when a keydown should be ignored because a modal/menu/suggestion is
 *  open, so view-level shortcuts don't bleed through to the underlying note
 *  list. Tries multiple shapes because the exact DOM varies by Obsidian
 *  version. */
export function isAnyModalOpen(target?: EventTarget | null): boolean {
  // Definitive: the keydown originated inside a modal-ish container.
  if (target instanceof Element) {
    if (target.closest(".modal, .modal-container, .suggestion-container, .menu, .prompt")) return true;
  }
  // 0.61.8: check the target's owner document FIRST, then fall back to
  // the main `document`. Popout windows host modals in their OWN
  // document — the main-document-only check used to miss them, so the
  // ColorPickerModal in a tiny window couldn't capture arrow keys.
  const docs = new Set<Document>([document]);
  if (target instanceof Element && target.ownerDocument) docs.add(target.ownerDocument);
  for (const doc of docs) {
    if (doc.body?.querySelector(".modal-bg")) return true;
    if (doc.body?.querySelector(".modal-container .modal")) return true;
    if (doc.body?.querySelector(".suggestion-container")) return true;
    if (doc.body?.querySelector(".menu.mod-active")) return true;
  }
  return false;
}

/** Extract fenced ```lang … ``` codeblocks from a markdown body. Returns
 *  one entry per block in document order with the language tag and
 *  inner content (no surrounding fences). Tildes (~~~) are not matched
 *  — Obsidian's writers always emit backtick fences. 0.61.0. */
export function extractCodeBlocks(body: string): Array<{ lang: string; code: string }> {
  const out: Array<{ lang: string; code: string }> = [];
  // ``` (optional info string) <newline> body <newline> ```.
  // Use 3+ backticks to accommodate nested fences (Markdown spec).
  const re = /^([ \t]*)(`{3,})[ \t]*([^\n`]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) != null) {
    out.push({ lang: m[3].trim(), code: m[4] });
  }
  return out;
}

/** Capitalize the first letter of every space-separated word inside each "/"-separated
 *  segment, but never lowercase already-capitalized characters. So:
 *    "my health stuff/2026 notes" → "My Health Stuff/2026 Notes"
 *    "HealthMD/work-stuff"        → "HealthMD/Work-stuff"
 *    "BIG"                        → "BIG"
 */
export function properCaseFolderPath(path: string): string {
  return path
    .split("/")
    .map((seg) => seg.split(" ").map((w) => (w && /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" "))
    .join("/");
}

/** Compute a new child-order array for a parent, given the current order and
 *  the ids being moved (assumed contiguous-as-a-block in the result). */
export function computeReorder(all: string[], targetIds: string[], dir: "up" | "down" | "top" | "bottom"): string[] {
  const targetSet = new Set(targetIds);
  const others = all.filter((id) => !targetSet.has(id));
  // Anchor: where the block currently sits (first target's index).
  const firstIdx = all.findIndex((id) => targetSet.has(id));
  if (firstIdx < 0) return all.slice();

  switch (dir) {
    case "top":
      return [...targetIds, ...others];
    case "bottom":
      return [...others, ...targetIds];
    case "up": {
      // Insert the block one position earlier than the first target's current index.
      const insertAt = Math.max(0, firstIdx - 1);
      const result = others.slice();
      result.splice(insertAt, 0, ...targetIds);
      return result;
    }
    case "down": {
      // Move past one non-target. lastIdx + 2 in the original space → new index in `others`.
      const lastIdx = (() => { let i = -1; all.forEach((id, k) => { if (targetSet.has(id)) i = k; }); return i; })();
      // Count non-targets before the position we want to land at (lastIdx + 2 in original space).
      let othersBefore = 0;
      for (let i = 0; i < Math.min(all.length, lastIdx + 2); i++) {
        if (!targetSet.has(all[i])) othersBefore++;
      }
      const insertAt = Math.min(others.length, othersBefore);
      const result = others.slice();
      result.splice(insertAt, 0, ...targetIds);
      return result;
    }
  }
}

export function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Tag filter: special sentinel modes + ranked matching --------------------

/** Sentinel `tagFilter` values for the "has any tag" / "has no tags" filter
 *  modes. The `__stashpad:` prefix can't collide with a real tag name. */
export const TAG_FILTER_TAGGED = "__stashpad:tagged__";
export const TAG_FILTER_UNTAGGED = "__stashpad:untagged__";

/** Score a tag name against a query for the tag-filter search box.
 *  Higher = closer match; -1 = no match. Tiers (closest first):
 *    exact (1000) > prefix (800) > word-boundary substring (≈600) >
 *    mid-word substring (≈500) > subsequence/fuzzy (200).
 *  Substring tiers subtract the match index so earlier hits rank higher. */
export function rankTagMatch(query: string, tag: string): number {
  const q = query.toLowerCase().trim();
  const t = tag.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  const idx = t.indexOf(q);
  if (idx > 0) {
    const prev = t[idx - 1];
    const boundary = !/[a-z0-9]/.test(prev); // after a separator (-, _, /, space)
    return (boundary ? 600 : 500) - Math.min(idx, 99);
  }
  // Subsequence fuzzy: every query char appears in order somewhere.
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 200 : -1;
}

/** Rank + filter a tag list by `query`. Empty query returns the list
 *  unchanged (caller's original frequency/alpha order). Otherwise drops
 *  non-matches and sorts by score desc, then count desc, then label. */
export function rankTags<T extends { raw: string; label: string; count: number }>(
  query: string,
  tags: T[],
): T[] {
  const q = query.trim();
  if (!q) return tags;
  return tags
    .map((t) => ({ t, s: rankTagMatch(q, t.raw) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.t.count - a.t.count || a.t.label.localeCompare(b.t.label))
    .map((x) => x.t);
}
