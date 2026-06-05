import { setIcon } from "obsidian";

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
