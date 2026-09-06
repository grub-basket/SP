// 0.296.0 (perf): row icons via one hidden <svg> sprite per document.
//
// WHY: `renderNote` used to call Obsidian's `setIcon()` 6-8 times per row, and
// each call parses + injects a whole Lucide `<svg>` with 2-4 path/line/circle
// children (~4-6 DOM nodes per icon). With ~30 rows in the virtualized window
// that is ~200 SVGs, ~800+ nodes, rebuilt on every window move; before
// virtualization a full render built 2000+ of them. The glyph in each row slot
// is ALWAYS the same (grip, pin, enter arrow, pencil, arrow-right, reply, more,
// star, smile-plus), so we pay for the same handful of shapes over and over.
//
// HOW: build the sprite ONCE per document by calling `setIcon()` into a scratch
// element for each name and moving the produced `<svg>`'s children into a
// `<symbol>`. The glyphs therefore come from Obsidian's OWN icon registry —
// including any theme/plugin `addIcon()` override — instead of being hardcoded
// here. Rows then get a 2-node `<svg class="svg-icon …"><use href="#…"/></svg>`.
//
// The per-row `<svg>` is created with the SAME attribute set the real
// `setIcon()` svg carried (class incl. `svg-icon` + `lucide-*`, viewBox, fill,
// stroke="currentColor", stroke-width, linecaps, …), so every existing CSS rule
// — Obsidian's `.svg-icon { width/height: var(--icon-size); stroke-width:
// var(--icon-stroke) }`, our `.stashpad-note-grip .svg-icon` opacity transition,
// theme rules keyed on `.lucide-pencil` — keeps matching exactly as before, and
// `currentColor` still resolves against the button's own colour. The `<symbol>`
// deliberately carries NO paint attributes of its own so its cloned content
// inherits stroke/fill/stroke-width from that outer `<svg>`.
import { setIcon } from "obsidian";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Every icon slot rendered inside a note row. */
export const ROW_ICON_NAMES = [
  "grip-vertical",      // drag handle / colour swatch
  "pin",                // list-pin indicator
  "corner-down-right",  // children-count enter arrow
  "pencil",             // edit in Stashpad
  "arrow-right",        // open in Stashpad view
  "reply",              // reply to this note
  "ellipsis-vertical",  // more actions
  "star",               // quick actions
  "smile-plus",         // add reaction
] as const;

export type RowIconName = (typeof ROW_ICON_NAMES)[number];

/** `id` of the `<symbol>` for `name`. Kept namespaced so we can never collide
 *  with a sprite another plugin mounted in the same document. */
function symbolId(name: string): string { return `sp-icon-${name}`; }

interface Sprite {
  /** The hidden host `<svg>` holding every `<symbol>`. */
  el: SVGSVGElement;
  /** Attributes to replicate on each per-row `<svg>`, by icon name. */
  attrs: Map<string, [string, string][]>;
}

/** One sprite per document — a popout window is a DIFFERENT document, and
 *  `<use href="#id">` cannot resolve across documents, so each document that
 *  renders rows gets its own copy. WeakMap so a closed popout's document (and
 *  its sprite) can be collected. */
const sprites = new WeakMap<Document, Sprite>();

/** Bumped by `invalidateIconSprites()`; a sprite built under an older version
 *  is rebuilt on next use. Lets a `css-change` in one window invalidate the
 *  sprites in every other document without keeping strong document refs. */
let spriteVersion = 0;
const spriteVersions = new WeakMap<Document, number>();

function buildSprite(doc: Document): Sprite {
  const el = doc.createElementNS(SVG_NS, "svg");
  // The sprite must not paint or take layout. `display: none` (via the class
  // below) is the standard SVG-sprite technique and is safe here: `<use>`
  // clones the referenced `<symbol>` into its own shadow tree, and per SVG 2 /
  // Chromium's implementation the reference resolves by id regardless of
  // whether the referenced subtree is itself rendered. (A `<symbol>` is never
  // directly rendered even when its host IS displayed, which is why the pattern
  // works at all.) Obsidian is Chromium-only, so this is the one engine we need.
  el.classList.add("sp-icon-sprite");
  el.setAttribute("aria-hidden", "true");
  const attrs = new Map<string, [string, string][]>();

  // Scratch host: `setIcon` needs a real element, and it must live in THIS
  // document so any document-scoped icon registration applies.
  const scratch = doc.createElement("div");
  for (const name of ROW_ICON_NAMES) {
    scratch.empty();
    setIcon(scratch, name);
    const src = scratch.querySelector("svg");
    if (!src) continue;   // unknown icon name — rowIcon() falls back to setIcon
    attrs.set(name, Array.from(src.attributes).map((a) => [a.name, a.value] as [string, string]));
    const sym = doc.createElementNS(SVG_NS, "symbol");
    sym.setAttribute("id", symbolId(name));
    // viewBox is the one geometry attribute that must live on the <symbol>:
    // it establishes the coordinate system the cloned content is drawn in.
    // Paint attributes are deliberately NOT copied here — they stay on the
    // per-row <svg> so `currentColor` and `--icon-stroke` keep working.
    const vb = src.getAttribute("viewBox");
    if (vb) sym.setAttribute("viewBox", vb);
    while (src.firstChild) sym.appendChild(src.firstChild);
    el.appendChild(sym);
  }
  scratch.empty();

  // Drop ANY sprite already in this document before mounting. Normally that is
  // the one we are replacing, but it also covers the reload case: disabling /
  // updating the plugin leaves the old instance's sprite in <body> (it holds no
  // listeners and nothing else references it, so nothing tears it down), and the
  // fresh module instance starts with empty maps. Without this sweep the new
  // sprite would mount ALONGSIDE the orphan, duplicating every `sp-icon-*` id —
  // and `<use>` resolves the FIRST match, so rows would silently keep rendering
  // the dead instance's glyphs.
  doc.body.querySelectorAll(".sp-icon-sprite").forEach((old) => old.remove());
  // Mounted on <body> rather than a view root: one sprite serves every
  // Stashpad view in the document (main window can hold several leaves), and it
  // survives a view being detached/re-rendered.
  doc.body.appendChild(el);
  return { el, attrs };
}

/** Build `doc`'s sprite if it doesn't have a current one. Idempotent and cheap
 *  — safe to call from every view's `onOpen` so the first render never pays for
 *  the build mid-loop. */
export function ensureIconSprite(doc: Document): void { ensureSprite(doc); }

/** Get (building if needed) the sprite for `doc`. Cheap on the hot path: a
 *  WeakMap hit plus two guards. */
function ensureSprite(doc: Document): Sprite {
  const existing = sprites.get(doc);
  // `isConnected` catches a sprite whose host node was removed (window torn
  // down and rebuilt); the version check catches a stale post-`css-change` one.
  if (existing && existing.el.isConnected && spriteVersions.get(doc) === spriteVersion) return existing;
  // buildSprite() sweeps any existing `.sp-icon-sprite` from the document, so
  // the stale one (ours or an orphan from a previous plugin instance) goes too.
  const built = buildSprite(doc);
  sprites.set(doc, built);
  spriteVersions.set(doc, spriteVersion);
  return built;
}

/** Rebuild `doc`'s sprite now and mark every other document's sprite stale.
 *  Call on `workspace.on("css-change")`: a theme can swap icons at runtime via
 *  `addIcon()`, which would leave the cached symbols showing the old glyphs.
 *  Rebuilding in place keeps the SAME symbol ids, so `<use>` elements already
 *  in the DOM pick up the new glyphs immediately — rows re-render on the next
 *  paint anyway, but they do not have to. */
export function refreshIconSprite(doc: Document): void {
  spriteVersion += 1;
  ensureSprite(doc);
}

/** Render one row icon into `el` as a `<use>` reference. Falls back to the real
 *  `setIcon` when the name isn't in the sprite (unknown / newly added icon). */
export function rowIcon(el: HTMLElement, name: RowIconName): void {
  const doc = el.ownerDocument;
  const sprite = ensureSprite(doc);
  const attrs = sprite.attrs.get(name);
  if (!attrs) { setIcon(el, name); return; }
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [k, v] of attrs) svg.setAttribute(k, v);
  svg.classList.add("sp-icon");
  const use = doc.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${symbolId(name)}`);
  svg.appendChild(use);
  el.appendChild(svg);
}

/** 0.296.0: plugin unload — drop every sprite so a disabled plugin leaves no
 *  element behind (the reload sweep already handles the re-enable case). */
export function removeIconSprites(docs: Iterable<Document>): void {
  for (const doc of docs) {
    for (const el of Array.from(doc.querySelectorAll(".sp-icon-sprite"))) el.remove();
  }
}
