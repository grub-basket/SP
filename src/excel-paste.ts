/**
 * Spreadsheet clipboard → Markdown table.
 *
 * When you copy a range of cells from Excel, Google Sheets, Numbers or
 * LibreOffice Calc, the clipboard carries the data TWICE over: once as an HTML
 * `<table>` (plus tab-separated `text/plain`), and — on macOS especially — once
 * as a rendered PNG *image* of the cells. Stashpad's paste handlers grab
 * `clipboardData.files` first, so the image used to win and the actual table was
 * thrown away (the "paste from Excel drops a picture, not the table" bug).
 *
 * This module detects the spreadsheet payload (the reliable tell is an HTML
 * `<table>` on the clipboard — every spreadsheet app emits one) and turns it
 * into a GitHub-flavored Markdown table, so the DATA lands instead of a picture.
 * The paste handlers call `clipboardToMarkdownTable` BEFORE their image/file
 * branch and, when it returns a string, insert that and skip the image.
 *
 * Credit: the TSV → Markdown conversion — intra-cell newline handling
 * (`<br>`), pipe escaping, column padding, and the optional `^l`/`^c`/`^r`
 * header-cell alignment prefix — is adapted from the "Excel to Markdown Table"
 * Obsidian plugin by Ganessh Kumar R P (MIT):
 * https://github.com/ganesshkumar/obsidian-excel-to-markdown-table
 * The robust quoted / multi-line TSV cell parser is adapted from GridSense's
 * `parseClipboardTable`. Both are acknowledged in the README.
 */

type Align = "l" | "c" | "r";

const COL_DELIM = "\t";
/** A `^l` / `^c` / `^r` prefix on a HEADER cell sets that column's alignment. */
const ALIGN_RE = /^\^([lcr])/i;

// U+0085 (NEL), U+2028 (line separator), U+2029 (paragraph separator) — the
// exotic row separators some apps emit. Built via char codes so this source
// file stays pure ASCII (a literal U+2028/U+2029 is a JS line terminator).
const UNI_ROW_SEP = new RegExp(
  "[" + String.fromCharCode(0x85, 0x2028, 0x2029) + "]",
  "g",
);
/**
 * Parse spreadsheet TSV into a grid via a small state machine. Excel/Sheets/
 * Numbers/LibreOffice wrap any cell containing a tab, newline or double-quote in
 * double quotes and escape embedded quotes as `""`; a fully-quoted field's tabs
 * and newlines are therefore data, not delimiters, and its `""` collapse to `"`.
 * Embedded newlines are kept as `\n` inside the cell (rendered as `<br>` later).
 * CRLF / Unicode row separators are normalized to `\n` first. A bare `"` that
 * isn't at the START of a field (e.g. `5" pipe`) is a literal quote, matching
 * how spreadsheets only quote whole fields. Adapted from GridSense's
 * parseClipboardTable and the Excel to Markdown Table plugin, generalized to
 * unescape single-line quoted cells too.
 */
export function parseSpreadsheetTSV(text: string): string[][] {
  const t = text.replace(/\r\n?/g, "\n").replace(UNI_ROW_SEP, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } // escaped "" → literal "
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") inQuotes = true; // opening quote (field start only)
    else if (c === COL_DELIM) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  row.push(field);
  rows.push(row);
  // A trailing newline leaves a phantom [""] row — drop it.
  if (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
  }
  return rows;
}

/**
 * Parse the first `<table>` in an HTML clipboard payload into a grid. Used when
 * a spreadsheet paste has no usable tab-separated `text/plain` (rare) or when
 * copying an HTML table straight from a web page. `<br>` inside a cell becomes a
 * newline (later rendered as `<br>` in the Markdown cell).
 */
export function parseHtmlTable(html: string): string[][] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return [];
  const out: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.querySelectorAll("th,td")).map((td) => {
      const clone = td.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      return (clone.textContent ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
    });
    if (cells.length) out.push(cells);
  }
  return out;
}

/**
 * True when this clipboard payload looks like a copied spreadsheet range (or an
 * HTML table). The presence of an HTML `<table>` is the reliable signal —
 * Excel, Sheets, Numbers and LibreOffice all emit one, whereas a plain-text
 * (Shift+Mod+V) paste or a screenshot does not. Gating on this avoids turning
 * tab-indented plain text or code into a table by mistake.
 */
export function clipboardHasTable(data: DataTransfer): boolean {
  const html = data.getData("text/html");
  return !!html && /<table[\s>]/i.test(html);
}

/**
 * Convert a spreadsheet / HTML-table clipboard payload to a Markdown string, or
 * `null` when it isn't tabular (so callers fall through to their normal
 * file/image handling). A genuine ≥2-column range becomes a Markdown table; a
 * single-column (or single-cell) selection becomes its plain lines — either way
 * the DATA is returned rather than the spurious image.
 */
export function clipboardToMarkdownTable(data: DataTransfer): string | null {
  if (!clipboardHasTable(data)) return null;

  const plain = data.getData("text/plain");
  const rows =
    plain && plain.includes(COL_DELIM)
      ? parseSpreadsheetTSV(plain.trim())
      : parseHtmlTable(data.getData("text/html"));
  return gridToMarkdown(rows);
}

/**
 * A parsed grid → a Markdown string, or `null` when there's nothing tabular. A
 * genuine ≥2-column grid becomes a padded GFM table; a single-column (or
 * single-cell) grid becomes its plain lines so the DATA still lands (never the
 * spurious image). Pure and DOM-free — the unit-tested core.
 */
export function gridToMarkdown(rows: string[][]): string | null {
  const grid = rows.filter((r) => r.length > 0);
  if (grid.length === 0) return null;

  const cols = Math.max(...grid.map((r) => r.length));
  if (cols < 2) {
    // Single column / single cell — not a table, but still data, not a picture.
    const text = grid.map((r) => r[0] ?? "").join("\n");
    return text.trim() ? text : null;
  }
  return rowsToMarkdown(grid, cols);
}

/** Build a padded GFM table from a grid (adapted from Excel to Markdown Table). */
function rowsToMarkdown(rows: string[][], cols: number): string {
  // Normalize ragged rows to a rectangle.
  const grid = rows.map((r) => {
    const row = r.slice();
    while (row.length < cols) row.push("");
    return row;
  });

  // Per-column alignment from an optional `^l` / `^c` / `^r` prefix on the
  // header cell; strip the marker from the rendered header text.
  const aligns: Align[] = [];
  grid[0] = grid[0].map((h) => {
    const m = h.match(ALIGN_RE);
    aligns.push(m ? (m[1].toLowerCase() as Align) : "l");
    return m ? h.replace(ALIGN_RE, "") : h;
  });

  const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
  const cells = grid.map((r) => r.map(esc));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...cells.map((r) => (r[c] ?? "").length)),
  );

  const pad = (v: string, w: number) => v + " ".repeat(Math.max(0, w - v.length));
  const line = (r: string[]) => "| " + r.map((v, c) => pad(v ?? "", widths[c])).join(" | ") + " |";
  const sep = "| " + widths.map((w, c) => alignBar(aligns[c], w)).join(" | ") + " |";

  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join("\n");
}

/** The `---` / `:--` / `:-:` / `--:` divider cell for a column's alignment. */
function alignBar(a: Align, w: number): string {
  const dash = (n: number) => "-".repeat(Math.max(1, n));
  switch (a) {
    case "c":
      return ":" + dash(w - 2) + ":";
    case "r":
      return dash(w - 1) + ":";
    default:
      return dash(w);
  }
}
