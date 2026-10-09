/** 0.556.0: Showcase REGION comments — a comment can mark an area (a box) or
 *  point somewhere with an arrow, not only drop a pin on one spot.
 *
 *  Storage: the comment note keeps its `feedbackPin` (the shape's ANCHOR — a
 *  box's top-left corner, an arrow's tail — plus the PDF page, if any) and adds
 *  `feedbackShape`:
 *
 *    feedbackPin: "0.4200,0.3100,3"
 *    feedbackShape: "rect:0.4200,0.3100,0.1800,0.0900"     (x, y, w, h)
 *    feedbackShape: "arrow:0.4200,0.3100,0.6500,0.2000"    (tail x, y → head x, y)
 *
 *  Every number is a fraction (0–1) of the picture / page box, exactly like a
 *  pin, so a shape follows resizes and layouts for free. Keeping the pin means
 *  anything that only knows pins (an older Stashpad, the list's chip, the
 *  preview's 📍 list) still shows the comment at the right place.
 *
 *  This module is the model + the drawing helpers shared by the Showcase view
 *  and its HTML export; it holds no view state. */

export type FeedbackShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number };

export type ShapeKind = FeedbackShape["kind"];

const FRACTION_RE = /^\s*(?:0|1|0?\.\d+|1\.0*|0\.\d*)\s*$/;

/** Parse a `feedbackShape` value; null when missing or malformed. */
export function parseFeedbackShape(raw: unknown): FeedbackShape | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(rect|arrow)\s*:\s*(.*)$/i);
  if (!m) return null;
  const parts = m[2].split(",");
  if (parts.length !== 4 || !parts.every((p) => FRACTION_RE.test(p))) return null;
  const n = parts.map(Number);
  if (n.some((v) => !isFinite(v) || v < 0 || v > 1)) return null;
  if (m[1].toLowerCase() === "rect") {
    const [x, y, w, h] = n;
    if (w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
    return { kind: "rect", x, y, w, h };
  }
  const [x1, y1, x2, y2] = n;
  if (x1 === x2 && y1 === y2) return null;
  return { kind: "arrow", x1, y1, x2, y2 };
}

export function formatFeedbackShape(s: FeedbackShape): string {
  const r = (v: number): number => Number(clamp01(v).toFixed(4));
  const f = (v: number): string => v.toFixed(4);
  if (s.kind === "arrow") return `arrow:${f(r(s.x1))},${f(r(s.y1))},${f(r(s.x2))},${f(r(s.y2))}`;
  // Rounding x and w separately can push a box at the edge past 1 (which
  // the parser rejects): fit the size to the rounded corner.
  // (Never a size of 0 after rounding: keep at least one step, moving the
  // corner in if it has to.)
  const fit = (pos: number, size: number): [number, number] => {
    const sz = Math.max(r(size), 0.0001);
    const p = Math.min(r(pos), Number((1 - sz).toFixed(4)));
    return [p, Math.min(sz, Number((1 - p).toFixed(4)))];
  };
  const [x, w] = fit(s.x, s.w); const [y, h] = fit(s.y, s.h);
  return `rect:${f(x)},${f(y)},${f(w)},${f(h)}`;
}

/** Where the numbered pin sits: a box's top-left corner, an arrow's tail. */
export function shapeAnchor(s: FeedbackShape): { x: number; y: number } {
  return s.kind === "rect" ? { x: s.x, y: s.y } : { x: s.x1, y: s.y1 };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The shape a drag from (x0,y0) to (x1,y1) draws (fractions, any direction). */
export function shapeFromDrag(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number): FeedbackShape | null {
  x0 = clamp01(x0); y0 = clamp01(y0); x1 = clamp01(x1); y1 = clamp01(y1);
  if (kind === "arrow") return x0 === x1 && y0 === y1 ? null : { kind, x1: x0, y1: y0, x2: x1, y2: y1 };
  const x = Math.min(x0, x1); const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0); const h = Math.abs(y1 - y0);
  return w > 0 && h > 0 ? { kind, x, y, w, h } : null;
}

/** The part of the picture a thumbnail of this shape shows: its bounds plus
 *  some room around them, inside the picture. */
export function shapeCrop(s: FeedbackShape): { x: number; y: number; w: number; h: number } {
  const bx = s.kind === "rect" ? s.x : Math.min(s.x1, s.x2);
  const by = s.kind === "rect" ? s.y : Math.min(s.y1, s.y2);
  const bw = s.kind === "rect" ? s.w : Math.abs(s.x2 - s.x1);
  const bh = s.kind === "rect" ? s.h : Math.abs(s.y2 - s.y1);
  const padX = Math.max(0.03, bw * 0.15); const padY = Math.max(0.03, bh * 0.15);
  const x = clamp01(bx - padX); const y = clamp01(by - padY);
  return { x, y, w: Math.max(0.001, clamp01(bx + bw + padX) - x), h: Math.max(0.001, clamp01(by + bh + padY) - y) };
}

let markerSeq = 0;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Draw a shape into an overlay `layer` (positioned over the picture, same
 *  box). `cls` is the element's class list. A box is a %-positioned div; an
 *  arrow is an SVG filling the layer whose line uses % coordinates — so the
 *  arrowhead (an SVG marker) is drawn in real pixels and is never squashed by
 *  the picture's aspect ratio. Works in any document (the HTML export builds
 *  its page in a detached one). */
export function appendShapeEl(layer: HTMLElement, s: FeedbackShape, cls: string): HTMLElement | SVGSVGElement {
  const doc = layer.ownerDocument;
  if (s.kind === "rect") {
    const el = layer.appendChild(doc.createElement("div"));
    el.className = cls;
    el.style.left = `${s.x * 100}%`; el.style.top = `${s.y * 100}%`;
    el.style.width = `${s.w * 100}%`; el.style.height = `${s.h * 100}%`;
    return el;
  }
  const svg = layer.appendChild(doc.createElementNS(SVG_NS, "svg"));
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const id = `sp-arrowhead-${++markerSeq}`;
  const defs = svg.appendChild(doc.createElementNS(SVG_NS, "defs"));
  const marker = defs.appendChild(doc.createElementNS(SVG_NS, "marker"));
  for (const [k, v] of Object.entries({ id, viewBox: "0 0 10 10", refX: "7", refY: "5", markerWidth: "4", markerHeight: "4", orient: "auto", markerUnits: "strokeWidth" })) marker.setAttribute(k, v);
  const head = marker.appendChild(doc.createElementNS(SVG_NS, "path"));
  head.setAttribute("d", "M0,0 L10,5 L0,10 z");
  head.setAttribute("fill", "currentColor");
  const pts = { x1: `${s.x1 * 100}%`, y1: `${s.y1 * 100}%`, x2: `${s.x2 * 100}%`, y2: `${s.y2 * 100}%` };
  // A pale halo under the line keeps it readable on dark and busy pictures.
  const halo = svg.appendChild(doc.createElementNS(SVG_NS, "line"));
  for (const [k, v] of Object.entries(pts)) halo.setAttribute(k, v);
  halo.setAttribute("class", "sp-arrow-halo");
  const line = svg.appendChild(doc.createElementNS(SVG_NS, "line"));
  for (const [k, v] of Object.entries(pts)) line.setAttribute(k, v);
  line.setAttribute("class", "sp-arrow-line");
  line.setAttribute("marker-end", `url(#${id})`);
  return svg;
}

/** Paint a close-up of the shape: the cropped part of `src` (an image or a
 *  drawn PDF page, `sw`×`sh` source pixels) with the shape outlined on top,
 *  fitted inside maxW×maxH CSS px. Returns false when there's nothing to draw. */
export function paintShapeThumb(canvas: HTMLCanvasElement, src: CanvasImageSource, sw: number, sh: number, s: FeedbackShape, color: string, maxW: number, maxH: number): boolean {
  if (!sw || !sh || maxW <= 0 || maxH <= 0) return false;
  const c = shapeCrop(s);
  const cx = c.x * sw; const cy = c.y * sh; const cw = c.w * sw; const ch = c.h * sh;
  if (cw < 1 || ch < 1) return false;
  const scale = Math.min(maxW / cw, maxH / ch, 3); // tiny areas: enlarge, but not into mush
  const cssW = Math.max(1, Math.round(cw * scale)); const cssH = Math.max(1, Math.round(ch * scale));
  const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  // Width only: with `height: auto` the canvas keeps its own aspect ratio,
  // so `max-width: 100%` in a narrow column shrinks it without squashing.
  canvas.style.width = `${cssW}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  try { ctx.drawImage(src, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height); } catch { return false; }
  const X = (fx: number): number => ((fx - c.x) / c.w) * canvas.width;
  const Y = (fy: number): number => ((fy - c.y) / c.h) * canvas.height;
  const lw = 2 * dpr;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const stroke = (width: number, style: string, path: () => void): void => {
    ctx.beginPath(); path(); ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke();
  };
  if (s.kind === "rect") {
    const r = (): void => ctx.rect(X(s.x), Y(s.y), X(s.x + s.w) - X(s.x), Y(s.y + s.h) - Y(s.y));
    stroke(lw + 2 * dpr, "rgba(255,255,255,0.85)", r);
    stroke(lw, color, r);
  } else {
    const ax = X(s.x1); const ay = Y(s.y1); const bx = X(s.x2); const by = Y(s.y2);
    const ang = Math.atan2(by - ay, bx - ax);
    const hl = 9 * dpr; // head length
    const line = (): void => { ctx.moveTo(ax, ay); ctx.lineTo(bx - Math.cos(ang) * hl * 0.6, by - Math.sin(ang) * hl * 0.6); };
    stroke(lw + 2 * dpr, "rgba(255,255,255,0.85)", line);
    stroke(lw, color, line);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - Math.cos(ang - 0.45) * hl, by - Math.sin(ang - 0.45) * hl);
    ctx.lineTo(bx - Math.cos(ang + 0.45) * hl, by - Math.sin(ang + 0.45) * hl);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  return true;
}
