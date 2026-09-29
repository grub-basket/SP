/* Pure tests for src/excel-paste.ts (spreadsheet clipboard → Markdown). */
import { parseSpreadsheetTSV, gridToMarkdown } from "../../src/excel-paste";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// --- TSV parsing -----------------------------------------------------------

__eq(
  parseSpreadsheetTSV("Name\tAge\nAlice\t30\nBob\t5"),
  [["Name", "Age"], ["Alice", "30"], ["Bob", "5"]],
  "basic TSV → grid",
);

// CRLF row endings normalize.
__eq(
  parseSpreadsheetTSV("a\tb\r\nc\td"),
  [["a", "b"], ["c", "d"]],
  "CRLF rows normalize",
);

// A quoted cell with an embedded newline stays one cell (newline preserved).
__eq(
  parseSpreadsheetTSV('h1\th2\n"line1\nline2"\tx'),
  [["h1", "h2"], ["line1\nline2", "x"]],
  "quoted multi-line cell survives the row split",
);

// Excel escapes an embedded double-quote as "" inside a quoted cell.
__eq(
  parseSpreadsheetTSV('a\tb\n"say ""hi"""\tz'),
  [["a", "b"], ['say "hi"', "z"]],
  "escaped double-quotes unescape",
);

// --- Markdown building ------------------------------------------------------

const basic = gridToMarkdown([["Name", "Age"], ["Alice", "30"], ["Bob", "5"]]);
__eq(
  basic,
  [
    "| Name  | Age |",
    "| ----- | --- |",
    "| Alice | 30  |",
    "| Bob   | 5   |",
  ].join("\n"),
  "grid → padded GFM table (min-3 columns, aligned to widest)",
);

// Pipes inside a cell are escaped; intra-cell newlines become <br>.
__eq(
  gridToMarkdown([["a", "b"], ["x|y", "one\ntwo"]]),
  [
    "| a    | b          |",
    "| ---- | ---------- |",
    "| x\\|y | one<br>two |",
  ].join("\n"),
  "pipe escaped, newline → <br>",
);

// The ^l/^c/^r header prefix sets per-column alignment and is stripped.
__eq(
  gridToMarkdown([["^cName", "^rQty"], ["Widget", "10"]]),
  [
    "| Name   | Qty |",
    "| :----: | --: |",
    "| Widget | 10  |",
  ].join("\n"),
  "center/right alignment from ^c / ^r header prefix",
);

// Ragged rows are padded out to the widest row.
__eq(
  gridToMarkdown([["a", "b", "c"], ["1"]]),
  [
    "| a   | b   | c   |",
    "| --- | --- | --- |",
    "| 1   |     |     |",
  ].join("\n"),
  "ragged rows padded to a rectangle",
);

// A single column is data, not a table: return its lines, not a 1-col table.
__eq(gridToMarkdown([["one"], ["two"], ["three"]]), "one\ntwo\nthree", "single column → plain lines");

// Nothing tabular → null (caller falls through to file/image handling).
__assert(gridToMarkdown([]) === null, "empty grid → null");
__assert(gridToMarkdown([[""], [""]]) === null, "blank single column → null");
