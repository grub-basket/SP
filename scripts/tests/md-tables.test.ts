/* Pure tests for src/md-tables.ts */
import { detectTable, formatTable, splitRow, emptyRow } from "../../src/md-tables";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// splitRow drops the empty cells around leading/trailing pipes and trims.
__eq(splitRow("| a | b |"), ["a", "b"], "splitRow basic");
__eq(splitRow("a | b"), ["a", "b"], "splitRow without outer pipes");
__eq(splitRow("| a \\| b | c |"), ["a \\| b", "c"], "splitRow keeps escaped pipes in-cell");

const TABLE = "| Name | Age |\n|---|---|\n| Alice | 30 |\n| Bob | 5 |";

// Not a table: no delimiter row.
__assert(detectTable("just | some | text", 3) === null, "no delimiter row → not a table");
// Not a table: caret outside any pipe line.
__assert(detectTable("plain text\nno pipes", 2) === null, "plain text → not a table");

// Caret in the "Alice" cell (row 2 within the block, col 0).
const aliceAt = TABLE.indexOf("Alice") + 1;
const ctx = detectTable(TABLE, aliceAt);
__assert(!!ctx, "table detected around the caret");
__eq(ctx!.colCount, 2, "two columns");
__eq(ctx!.delimIdx, 1, "delimiter is the 2nd block line");
__eq(ctx!.caretLine, 2, "caret is on block line 2 (Alice row)");
__eq(ctx!.caretCol, 0, "caret is in column 0");

// formatTable aligns every column to its widest cell (min 3).
const { lines, textRange } = formatTable(ctx!);
__eq(lines, [
  "| Name  | Age |",
  "| ----- | --- |",
  "| Alice | 30  |",
  "| Bob   | 5   |",
], "columns aligned to the widest cell");

// textRange points at a cell's actual text (excluding padding).
const r = textRange(2, 1); // "30" cell on the Alice row
const block = lines.join("\n");
__eq(block.slice(r.start, r.end), "30", "textRange selects the cell text");

// emptyRow makes a well-formed blank row for the column count.
__eq(splitRow(emptyRow(3)), ["", "", ""], "emptyRow has N empty cells");

// A caret in the delimiter row still resolves the table (nav code special-cases it).
const delimAt = TABLE.indexOf("---") + 1;
const dctx = detectTable(TABLE, delimAt);
__assert(!!dctx && dctx.caretLine === 1, "delimiter-row caret resolves to the delimiter line");
