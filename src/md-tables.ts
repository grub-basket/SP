/** 0.375.0: Markdown table assists for the plain-textarea editor surfaces.
 *
 *  Pure helpers (no DOM) so the caret math is testable in isolation: detect the
 *  table block around the caret, re-align its columns, and compute where the
 *  caret should land after a cell move / new row. `markdown-input.ts` wires
 *  these into Tab / Shift+Tab / Enter.
 *
 *  Scope on purpose: GFM pipe tables only (a header row, a delimiter row of
 *  dashes/colons, then body rows). A block without a delimiter row is NOT a
 *  table — so a stray `|` in prose never hijacks Tab/Enter. */

export type TableAlign = "none" | "left" | "center" | "right";

export interface TableCtx {
  /** Char offsets of the table block within the full value (block excludes the
   *  trailing newline after the last row). */
  blockStart: number;
  blockEnd: number;
  /** Raw lines of the block, in order. */
  lines: string[];
  /** Index within `lines` of the delimiter (`|---|`) row. */
  delimIdx: number;
  /** Index within `lines` of the caret's line. */
  caretLine: number;
  /** Caret's column (cell) index on its line. */
  caretCol: number;
  /** Column count (from the delimiter row). */
  colCount: number;
  aligns: TableAlign[];
}

const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** True when a line is a table delimiter row (`| --- | :--: |`). */
function isDelimiterLine(line: string): boolean {
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => DELIM_CELL.test(c));
}

/** True when a line could be a table row: it contains at least one pipe that
 *  isn't escaped. (Cheap gate; the delimiter check is what actually confirms a
 *  block is a table.) */
function looksLikeRow(line: string): boolean {
  return /(?:^|[^\\])\|/.test(line);
}

/** Split a table row into trimmed cell strings, dropping the empty cell before a
 *  leading pipe and after a trailing pipe. Escaped pipes (`\|`) stay in-cell. */
export function splitRow(line: string): string[] {
  const trimmed = line.trim();
  // Split on unescaped pipes.
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (ch === "|") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  // A leading pipe makes parts[0] empty; a trailing pipe makes the last empty.
  if (parts.length && parts[0].trim() === "" && trimmed.startsWith("|")) parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === "" && trimmed.endsWith("|")) parts.pop();
  return parts.map((p) => p.trim());
}

function alignOf(cell: string): TableAlign {
  const l = cell.trim().startsWith(":");
  const r = cell.trim().endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "none";
}

/** Which cell index the caret sits in, given a line and the caret's offset from
 *  the line start. Counts unescaped pipes before the caret; a leading pipe means
 *  column 0 begins after it. */
function caretColumn(line: string, offsetInLine: number): number {
  const leadingPipe = line.trimStart().startsWith("|");
  // Offset of the first non-space char (where trimming began) matters for the
  // leading-pipe adjustment; count pipes in the raw line up to the caret.
  let col = 0;
  for (let i = 0; i < offsetInLine && i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") { i++; continue; }
    if (line[i] === "|") col++;
  }
  // With a leading pipe, the first pipe opens column 0 (not a separator between
  // two columns), so subtract it.
  if (leadingPipe && col > 0) col -= 1;
  return Math.max(0, col);
}

/** Detect the table block around `caret`, or null when the caret isn't inside a
 *  GFM pipe table. */
export function detectTable(value: string, caret: number): TableCtx | null {
  const lines = value.split("\n");
  // Map caret → line index + offset within line.
  let acc = 0;
  let caretLineAbs = 0;
  let offsetInLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (caret <= acc + lineLen) { caretLineAbs = i; offsetInLine = caret - acc; break; }
    acc += lineLen + 1; // + newline
    caretLineAbs = i + 1;
  }
  if (!looksLikeRow(lines[caretLineAbs] ?? "")) return null;

  // Expand up/down over contiguous row-like lines.
  let top = caretLineAbs;
  while (top > 0 && looksLikeRow(lines[top - 1]) && lines[top - 1].trim() !== "") top--;
  let bot = caretLineAbs;
  while (bot < lines.length - 1 && looksLikeRow(lines[bot + 1]) && lines[bot + 1].trim() !== "") bot++;

  const blockLines = lines.slice(top, bot + 1);
  const delimRel = blockLines.findIndex(isDelimiterLine);
  if (delimRel < 0) return null; // no delimiter row → not a table
  if (blockLines.length < 2) return null;

  const aligns = splitRow(blockLines[delimRel]).map(alignOf);
  const colCount = aligns.length;

  // Char offset of the block start.
  let blockStart = 0;
  for (let i = 0; i < top; i++) blockStart += lines[i].length + 1;
  let blockEnd = blockStart;
  for (let i = 0; i < blockLines.length; i++) blockEnd += blockLines[i].length + (i < blockLines.length - 1 ? 1 : 0);

  return {
    blockStart,
    blockEnd,
    lines: blockLines,
    delimIdx: delimRel,
    caretLine: caretLineAbs - top,
    caretCol: caretColumn(lines[caretLineAbs], offsetInLine),
    colCount,
    aligns,
  };
}

function padCell(text: string, width: number, align: TableAlign): string {
  const pad = Math.max(0, width - displayWidth(text));
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") { const l = Math.floor(pad / 2); return " ".repeat(l) + text + " ".repeat(pad - l); }
  return text + " ".repeat(pad); // left / none
}

/** Visible width — treat each char as width 1. (Wide CJK/emoji drift a little;
 *  not worth a full grapheme table for an editor aid.) */
function displayWidth(s: string): number { return [...s].length; }

function delimCell(width: number, align: TableAlign): string {
  const w = Math.max(3, width);
  if (align === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
  if (align === "right") return "-".repeat(Math.max(1, w - 1)) + ":";
  if (align === "left") return ":" + "-".repeat(Math.max(1, w - 1));
  return "-".repeat(w);
}

/** Re-align the block: pad every column to its widest cell (min 3). Returns the
 *  formatted lines plus, for each ORIGINAL non-delimiter row, the char offset
 *  (within the joined block) where each column's content starts — so the caller
 *  can drop the caret into a specific cell. */
export function formatTable(ctx: TableCtx): {
  lines: string[];
  /** Absolute-within-block range of a cell's TEXT (excluding alignment padding),
   *  so the caller can select the cell content or drop the caret at its end. */
  textRange: (rowRel: number, col: number) => { start: number; end: number };
} {
  const { lines, delimIdx, colCount, aligns } = ctx;
  const rows = lines.map((ln) => {
    const cells = splitRow(ln);
    while (cells.length < colCount) cells.push("");
    return cells.slice(0, colCount);
  });
  // Column widths from header + body (skip the delimiter row's dashes).
  const widths = new Array(colCount).fill(3);
  rows.forEach((cells, i) => {
    if (i === delimIdx) return;
    cells.forEach((c, j) => { widths[j] = Math.max(widths[j], displayWidth(c)); });
  });

  const outLines = rows.map((cells, i) => {
    if (i === delimIdx) {
      return "| " + cells.map((_c, j) => delimCell(widths[j], aligns[j] ?? "none")).join(" | ") + " |";
    }
    return "| " + cells.map((c, j) => padCell(c, widths[j], aligns[j] ?? "none")).join(" | ") + " |";
  });

  // Offset of each cell's content area (after "| ") within a formatted line.
  const colStartInLine = (col: number): number => {
    let off = 2; // leading "| "
    for (let j = 0; j < col; j++) off += widths[j] + 3; // width + " | "
    return off;
  };
  const lineStart = (rowRel: number): number => {
    let off = 0;
    for (let i = 0; i < rowRel; i++) off += outLines[i].length + 1;
    return off;
  };
  const textRange = (rowRel: number, col: number): { start: number; end: number } => {
    const c = Math.min(Math.max(0, col), colCount - 1);
    const text = rows[rowRel]?.[c] ?? "";
    const len = displayWidth(text);
    const width = widths[c];
    const align = aligns[c] ?? "none";
    let lead = 0; // spaces before the text inside the cell content area
    if (align === "right") lead = width - len;
    else if (align === "center") lead = Math.floor((width - len) / 2);
    const base = lineStart(rowRel) + colStartInLine(c) + Math.max(0, lead);
    return { start: base, end: base + len };
  };

  return { lines: outLines, textRange };
}

/** Build an empty body row string (unformatted — formatTable will pad it). */
export function emptyRow(colCount: number): string {
  return "|" + " |".repeat(colCount);
}
