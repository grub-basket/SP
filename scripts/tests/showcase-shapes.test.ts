/* Pure tests for src/showcase-shapes.ts (Showcase region comments, 0.556.0) */
import { parseFeedbackShape, formatFeedbackShape, shapeAnchor, shapeFromDrag, shapeCrop } from "../../src/showcase-shapes";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// Parse: the two kinds, round-trip through format.
__eq(parseFeedbackShape("rect:0.1000,0.2000,0.3000,0.4000"), { kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, "rect parses");
__eq(parseFeedbackShape("arrow:0.1,0.2,0.5,0.6"), { kind: "arrow", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 }, "arrow parses");
__eq(parseFeedbackShape(" RECT : .5, .5, .25, 0.25 "), { kind: "rect", x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, "case + spaces + leading-dot tolerated");
__eq(formatFeedbackShape({ kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), "rect:0.1000,0.2000,0.3000,0.4000", "rect formats");
for (const raw of ["rect:0.1000,0.2000,0.3000,0.4000", "arrow:0.0000,1.0000,1.0000,0.0000"]) {
  __eq(formatFeedbackShape(parseFeedbackShape(raw)!), raw, `round-trip ${raw}`);
}

// Reject: wrong kind, count, range, empties, zero size, a box past the edge, a dot arrow.
for (const bad of [undefined, null, 3, "", "circle:0.1,0.1,0.1,0.1", "rect:0.1,0.2,0.3", "rect:0.1,0.2,0.3,0.4,0.5",
  "rect:-0.1,0.2,0.3,0.4", "rect:0.1,0.2,1.3,0.4", "arrow:0.1,,0.3,0.4", "rect:0.1,0.2,0,0.4", "rect:0.8,0.2,0.3,0.4",
  "arrow:0.3,0.3,0.3,0.3", "rect:1e-1,0.2,0.3,0.4", "rect:0x1,0.2,0.3,0.4"]) {
  __eq(parseFeedbackShape(bad), null, `rejects ${JSON.stringify(bad)}`);
}

// Anchor: a box's top-left corner, an arrow's tail.
__eq(shapeAnchor({ kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { x: 0.1, y: 0.2 }, "rect anchor");
__eq(shapeAnchor({ kind: "arrow", x1: 0.7, y1: 0.8, x2: 0.1, y2: 0.1 }), { x: 0.7, y: 0.8 }, "arrow anchor = tail");

// Drag: any direction normalises a box; the arrow keeps its direction; clamps to the picture.
__eq(shapeFromDrag("rect", 0.5, 0.6, 0.2, 0.1), { kind: "rect", x: 0.2, y: 0.1, w: 0.3, h: 0.5 }, "up-left drag normalises");
__eq(shapeFromDrag("arrow", 0.5, 0.6, 0.2, 0.1), { kind: "arrow", x1: 0.5, y1: 0.6, x2: 0.2, y2: 0.1 }, "arrow keeps direction");
__eq(shapeFromDrag("rect", 0.9, 0.9, 1.4, -0.2), { kind: "rect", x: 0.9, y: 0, w: 0.09999999999999998, h: 0.9 }, "drag past the edge clamps");
__eq(shapeFromDrag("rect", 0.5, 0.5, 0.5, 0.7), null, "zero-width box is no box");
__eq(shapeFromDrag("arrow", 0.5, 0.5, 0.5, 0.5), null, "zero-length arrow is no arrow");

// Crop: covers the shape with room around it, stays inside the picture.
const c = shapeCrop({ kind: "rect", x: 0.4, y: 0.4, w: 0.2, h: 0.1 });
__assert(c.x < 0.4 && c.y < 0.4 && c.x + c.w > 0.6 && c.y + c.h > 0.5, "crop surrounds the box");
const edge = shapeCrop({ kind: "rect", x: 0, y: 0, w: 1, h: 1 });
__eq(edge, { x: 0, y: 0, w: 1, h: 1 }, "whole-picture box crops to the picture");
const ac = shapeCrop({ kind: "arrow", x1: 0.9, y1: 0.1, x2: 0.5, y2: 0.5 });
__assert(ac.x < 0.5 && ac.x + ac.w > 0.9 && ac.y < 0.1 && ac.y + ac.h > 0.5, "arrow crop covers both ends");

// Rounding at the edge never produces a box the parser rejects.
for (const [x, w] of [[0.33335, 0.66665], [0.99995, 0.00005], [0.123456, 0.876544]]) {
  const raw = formatFeedbackShape({ kind: "rect", x, y: x, w, h: w });
  __assert(parseFeedbackShape(raw) !== null, `edge box survives rounding: ${raw}`);
}
