import type { App } from "obsidian";
import { Platform } from "obsidian";
import { getSettings } from "./settings";
import { detectTable, formatTable, emptyRow, splitRow, type TableCtx } from "./md-tables";

/** 0.202.0: the shared Markdown text-editing behaviors for Stashpad's plain
 *  `<textarea>` surfaces (composer, edit/split workbench, detail panel).
 *  Obsidian's own editor gets these from CodeMirror; a textarea gets nothing,
 *  so anything a user expects from "typing Markdown" has to live here.
 *
 *  Behaviors, and where the expectation comes from:
 *    - AUTOPAIR + TYPE-OVER + PAIR-DELETE  (VS Code `autoClosingBrackets` /
 *      `autoClosingOvertype` / `autoClosingDelete`; CodeMirror `closeBrackets`)
 *    - WRAP SELECTION                      (VS Code `autoSurround`)
 *    - "before" GUARD: only auto-close when the next character is whitespace,
 *      end-of-line, or a closing bracket — so typing `(` mid-word doesn't
 *      produce `(|)word`. (CodeMirror `closeBrackets`'s `before` option.)
 *    - LIST CONTINUATION on newline + exit-on-empty-item, ordered renumbering,
 *      task and blockquote continuation  (Obsidian `smartIndentList`)
 *    - TAB / SHIFT+TAB INDENT, scoped to list context or a multi-line
 *      selection so Tab keeps its focus-moving behavior everywhere else
 *      (accessibility: a textarea must stay escapable by keyboard).
 *    - DOUBLE-CLICK selection trimmed of trailing whitespace.
 *
 *  Obsidian's own editor toggles are honored so a user configures this ONCE:
 *  `autoPairBrackets` gates brackets/parens/quotes, `autoPairMarkdown` gates
 *  the Markdown emphasis markers + backticks, `smartIndentList` gates list
 *  continuation + Tab indent. Stashpad's own "Auto-pair Markdown syntax"
 *  setting remains the master switch for the pairing family.
 *
 *  See `docs/markdown-input-parity.md` for the full checklist + audit. */

/** Opener → closer. Quotes are symmetric; a prose-guard keeps apostrophes
 *  ("don't") from spawning a pair.
 *  0.363.10: curly quotes included — iOS "Smart Punctuation" converts a typed
 *  straight quote to a LEFT curly (U+201C/U+2018) before it reaches us, and on
 *  mobile the pair logic runs off beforeinput whose `data` carries that curly
 *  char. Each left curly pairs with its RIGHT curly closer, so a smart-quote
 *  opener still auto-closes. Desktop keydown only ever sees straight quotes, so
 *  these entries are inert there. */
const SIMPLE: Record<string, string> = { "[": "]", "(": ")", "`": "`", '"': '"', "'": "'", "“": "”", "‘": "’" };
/** Opening-quote characters (straight + iOS smart curly), word-start-gated so
 *  apostrophes and closing quotes don't spawn a pair. */
const QUOTE_OPENERS = new Set(['"', "'", "“", "‘"]);
/** Emphasis markers that pair on the SECOND keypress (`**|**`). */
const DOUBLED = new Set(["*", "~", "="]);
/** Characters that "type over" an identical character sitting at the caret. */
const CLOSERS = new Set(["]", ")", "`", "*", "~", "=", '"', "'", "”", "’"]);
/** What a keypress wraps a SELECTION in — every opener plus each doubled
 *  marker acting as its own closer. */
const WRAP: Record<string, string> = { ...SIMPLE, "*": "*", "~": "~", "=": "=" };
/** Markers whose pairing belongs to Obsidian's `autoPairMarkdown` toggle
 *  rather than its `autoPairBrackets` one. */
const MD_MARKERS = new Set(["*", "~", "=", "`"]);
/** Auto-close only when the next character is one of these (or end-of-line):
 *  whitespace, or a closing delimiter. CodeMirror's `before` rule. */
const BEFORE_OK = /[\s)\]}>,.;:!?'"`]/;

/** One parsed list line. `marker` is what a continuation should repeat. */
interface ListLine {
  indent: string;
  /** The bullet/number/quote marker WITHOUT its trailing space. */
  marker: string;
  /** Space(s) between marker and content. */
  gap: string;
  /** `[ ] ` / `[x] ` when the item is a task, else "". */
  task: string;
  /** Everything after the marker (and task box). */
  content: string;
  /** Set for ordered items so a continuation can increment. */
  ordered?: { n: number; delim: string };
}

/** Parse a line as a list / task / blockquote item. Returns null when it isn't
 *  one. Exported for the doc's test matrix + unit checks. */
export function parseListLine(line: string): ListLine | null {
  // Bulleted (- * +) or ordered (1. / 1)) or blockquote (>).
  const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)])|(>+))(\s*)(.*)$/);
  if (!m) return null;
  const [, indent, bullet, num, delim, quote, gap, rest] = m;
  const marker = bullet ?? (num !== undefined ? `${num}${delim}` : quote);
  if (!marker) return null;
  // A bullet/number MUST be followed by whitespace to be a list item
  // ("-dash" is prose, "- dash" is a list). Blockquotes don't require it.
  if (!quote && !gap) return null;
  const taskM = rest.match(/^(\[[ xX]\]\s+)(.*)$/);
  return {
    indent,
    marker,
    gap: gap || " ",
    task: taskM ? taskM[1] : "",
    content: taskM ? taskM[2] : rest,
    ...(num !== undefined ? { ordered: { n: parseInt(num, 10), delim } } : {}),
  };
}

/** 0.353.0: post-send cleanup for the mobile soft-keyboard autopair-duplication
 *  bug — on some mobile keyboards, producing a closing emphasis pair leaves the
 *  OPENING marker doubled (e.g. `***bold**`, `====hi==`). This trims an opening
 *  marker run that is LONGER than its matching closing run down to match (keeping
 *  the first markers). It is deliberately narrow and never touches valid markup:
 *  a symmetric span (`**bold**`, `***bolditalic***`, `==hl==`, `||spoiler||`) has
 *  equal runs and is left alone, and an EMPTY pair (`****`, `||||`, no inner text)
 *  has no inner match and is left alone. Single-marker inline (`*i*`, `` `c` ``)
 *  is never matched (opener must be 2+). Runs on send, behind a setting.
 *
 *  0.363.6: quotes `"` and `'` included — the same iOS duplication hits an
 *  auto-paired opening quote (`"` at a word start ⇒ `""`, and the soft keyboard
 *  leaves the opener doubled: `"""after"`). Same symmetric-run logic applies, so
 *  a real quoted span (`"hi"`) and an empty pair (`""`) are untouched. Brackets
 *  are deliberately NOT covered: `[` pairs with a DIFFERENT closer, and `[[x]`
 *  is a legitimate wikilink, so the symmetric-run trim doesn't apply to them. */
/** 0.363.11: normalize iOS "Smart Punctuation" curly quotes/dashes back to their
 *  straight ASCII forms on send. Left/right double quotes → ", left/right single
 *  quotes → ' (also fixes a curly apostrophe in "don't"). Requested so notes stay
 *  plain-ASCII. Deliberately narrow to quotes; other characters are left alone. */
export function straightenCurlyQuotes(text: string): string {
  return text
    .replace(/[“”]/g, '"')   // “ ” → "
    .replace(/[‘’]/g, "'");  // ‘ ’ → '
}

export function fixDuplicatedEmphasisOpeners(text: string): string {
  let out = text;
  for (const m of ["*", "~", "=", "`", "|", '"', "'"]) {
    const e = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // <opener run of 2+> <inner: no marker, no newline> <closer run of 1+>
    const re = new RegExp(`(${e}{2,})([^${e}\\n]+?)(${e}+)`, "g");
    out = out.replace(re, (full, open: string, inner: string, close: string) =>
      open.length > close.length ? close + inner + close : full);
  }
  return out;
}

export interface MarkdownInputOptions {
  /** True when THIS keydown will insert a newline rather than submit/commit.
   *  The composer submits on Enter (or Shift+Enter, per its mode); the
   *  workbench commits on Mod+Enter. List continuation only runs for real
   *  newlines, so it can never pre-empt a submit. Default: never. */
  insertsNewline?: (e: KeyboardEvent) => boolean;
}

/** The minimal shape handlePairs needs. KeyboardEvent satisfies it (desktop
 *  keydown path); the beforeinput adapter builds one for mobile. */
interface PairKey { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; preventDefault: () => void; }

export class MarkdownInput {
  constructor(private app: App, private ta: HTMLTextAreaElement, private opts: MarkdownInputOptions = {}) {}

  attach(): void {
    // 0.373.0: tag the field so the view's keymap Scope can offer the inline
    // format shortcuts (Mod+B/I/E) on markdown surfaces ONLY — never a search or
    // folder-name input. (The shortcuts live in the Scope, not here, because
    // Obsidian dispatches its own Mod+B before any DOM keydown we could add.)
    this.ta.classList.add("stashpad-md-input");
    this.ta.addEventListener("keydown", this.onKeyDown, true);
    // 0.363.7: on MOBILE, autopair runs off beforeinput instead of keydown —
    // iOS soft keyboards do NOT honour preventDefault() on keydown, so the manual
    // pair-insert AND the native character both landed, doubling every paired
    // opener ("("→"((", '"'→'""', etc.). beforeinput's preventDefault IS honoured
    // there, so the native insert is reliably suppressed and only our pair lands.
    if (Platform.isMobile) this.ta.addEventListener("beforeinput", this.onBeforeInput);
    this.ta.addEventListener("dblclick", this.onDoubleClick);
  }

  detach(): void {
    this.ta.classList.remove("stashpad-md-input");
    this.ta.removeEventListener("keydown", this.onKeyDown, true);
    this.ta.removeEventListener("beforeinput", this.onBeforeInput);
    this.ta.removeEventListener("dblclick", this.onDoubleClick);
  }

  // ---------- Obsidian config passthrough ----------

  private obsidianFlag(key: string): boolean {
    try {
      const v = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.(key);
      return v === undefined ? true : v !== false; // absent → assume on
    } catch { return true; }
  }

  /** Indent unit for Tab, mirroring Obsidian's `useTab` / `tabSize`. */
  private indentUnit(): string {
    try {
      const cfg = this.app.vault as unknown as { getConfig?: (k: string) => unknown };
      const useTab = cfg.getConfig?.("useTab");
      if (useTab === false) {
        const size = Number(cfg.getConfig?.("tabSize"));
        return " ".repeat(Number.isFinite(size) && size > 0 ? size : 4);
      }
    } catch { /* fall through */ }
    return "\t";
  }

  // ---------- shared text helpers ----------

  /** Replace [start,end) with `text`, then place/extend the selection.
   *  Fires `input` so hosts (draft save, diff, autosize) resync. */
  private splice(start: number, end: number, text: string, selStart: number, selEnd = selStart): void {
    const v = this.ta.value;
    this.ta.value = v.slice(0, start) + text + v.slice(end);
    this.ta.setSelectionRange(selStart, selEnd);
    this.ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private lineBounds(pos: number): { start: number; end: number } {
    const v = this.ta.value;
    const start = v.lastIndexOf("\n", pos - 1) + 1;
    const nl = v.indexOf("\n", pos);
    return { start, end: nl === -1 ? v.length : nl };
  }

  // ---------- key handling ----------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return; // never interfere with IME composition
    const start = this.ta.selectionStart;
    const end = this.ta.selectionEnd;
    if (start == null || end == null) return;

    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) { this.handleEnter(e, start, end); return; }
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) { this.handleTab(e, start, end); return; }
    // 0.363.7: on mobile the pair family runs off beforeinput (see attach()); a
    // keydown pass there would double it. Enter/Tab above still run on keydown on
    // both platforms — they're not affected by the preventDefault-suppression bug.
    if (Platform.isMobile) return;
    this.handlePairs(e, start, end);
  };

  /** 0.363.7: mobile autopair via beforeinput. keydown's preventDefault is
   *  ignored by iOS soft keyboards, so pairing had to move to beforeinput, which
   *  IS cancelable there. Only single-character text inserts and a plain backspace
   *  are relevant to pairing; multi-char inserts (autocorrect/predictive) and
   *  composition pass straight through untouched. */
  private onBeforeInput = (e: InputEvent): void => {
    if (e.isComposing) return;
    const start = this.ta.selectionStart;
    const end = this.ta.selectionEnd;
    if (start == null || end == null) return;
    const pd = (): void => e.preventDefault();
    if (e.inputType === "insertText" && typeof e.data === "string" && e.data.length === 1) {
      this.handlePairs({ key: e.data, preventDefault: pd }, start, end);
    } else if (e.inputType === "deleteContentBackward" && start === end) {
      // Pair deletion (opener + its closer straddling the caret). A selection
      // delete is left to the browser (start !== end guarded above).
      this.handlePairs({ key: "Backspace", preventDefault: pd }, start, end);
    }
  };

  /** List continuation (Obsidian's `smartIndentList`). Runs ONLY when this
   *  Enter inserts a newline — a submit/commit Enter is left alone. */
  private handleEnter(e: KeyboardEvent, start: number, end: number): void {
    if (!this.opts.insertsNewline?.(e)) return;       // Enter submits → not ours
    // 0.375.0: inside a table, Enter adds a new row (or exits from an empty last
    // row). Independent of the autopair/list toggles, but still only when Enter
    // inserts a newline (above) and the selection stays on one line.
    const multilineSel = start !== end && this.ta.value.slice(start, end).includes("\n");
    if (getSettings().tableAssists && !multilineSel && this.tableEnter(e, start)) return;
    if (!getSettings().autoPairBrackets) return;      // master switch
    if (!this.obsidianFlag("smartIndentList")) return; // Obsidian's toggle
    if (start !== end) return; // a selection + Enter is a plain replace

    const { start: ls } = this.lineBounds(start);
    const line = this.ta.value.slice(ls, start);
    const item = parseListLine(line);
    if (!item) return;

    // Empty item → EXIT the list: clear the marker instead of adding another
    // (matching every Markdown editor; otherwise Enter-Enter nests forever).
    if (!item.content.trim()) {
      e.preventDefault();
      this.splice(ls, start, item.indent, ls + item.indent.length);
      return;
    }

    e.preventDefault();
    const nextMarker = item.ordered
      ? `${item.ordered.n + 1}${item.ordered.delim}`
      : item.marker;
    // A continued task starts UNCHECKED regardless of the source item's state.
    const nextTask = item.task ? "[ ] " : "";
    const insert = `\n${item.indent}${nextMarker}${item.gap}${nextTask}`;
    this.splice(start, end, insert, start + insert.length);
  }

  /** Tab / Shift+Tab indent — scoped so Tab still moves focus in prose.
   *  Applies when the caret sits on a list line, or when the selection spans
   *  multiple lines (where nobody expects Tab to leave the field). */
  private handleTab(e: KeyboardEvent, start: number, end: number): void {
    // 0.375.0: inside a table, Tab / Shift+Tab move between cells (and re-align
    // the table) rather than indenting. Takes precedence; a single-line selection
    // (e.g. a cell selected by the previous Tab) still navigates — only a
    // multi-line selection falls through to block indent.
    const multilineSel0 = start !== end && this.ta.value.slice(start, end).includes("\n");
    if (getSettings().tableAssists && !multilineSel0 && this.tableTab(e, start)) return;
    if (!getSettings().autoPairBrackets) return;
    if (!this.obsidianFlag("smartIndentList")) return;
    const v = this.ta.value;
    const multiline = start !== end && v.slice(start, end).includes("\n");
    const { start: ls, end: le } = this.lineBounds(start);
    const onListLine = !!parseListLine(v.slice(ls, le));
    // 0.326.0: with "Tab indents in the composer" ON, a single plain line also
    // indents (outliner model). Default OFF preserves Tab-to-leave on prose.
    if (!multiline && !onListLine && !getSettings().tabIndentsProse) return;

    e.preventDefault();
    const unit = this.indentUnit();
    const blockStart = this.lineBounds(start).start;
    const blockEnd = this.lineBounds(end).end;
    const block = v.slice(blockStart, blockEnd);
    const lines = block.split("\n");
    let firstDelta = 0, totalDelta = 0;
    const out = lines.map((ln, i) => {
      if (e.shiftKey) {
        // Outdent: strip one indent unit (a tab, or up to `unit.length` spaces).
        const m = ln.match(/^(\t| +)/);
        if (!m) return ln;
        const strip = m[1].startsWith("\t") ? 1 : Math.min(unit.length || 1, m[1].length);
        if (i === 0) firstDelta = -strip;
        totalDelta -= strip;
        return ln.slice(strip);
      }
      if (i === 0) firstDelta = unit.length;
      totalDelta += unit.length;
      return unit + ln;
    }).join("\n");
    this.splice(blockStart, blockEnd, out,
      Math.max(blockStart, start + firstDelta),
      Math.max(blockStart, end + totalDelta));
  }

  /** 0.375.0: Tab / Shift+Tab between table cells. Re-aligns the whole table on
   *  every move, appends a new row when tabbing past the last cell, and selects
   *  the destination cell's text (spreadsheet-style, so typing replaces it).
   *  Returns false when the caret isn't in a table (caller falls back to indent). */
  private tableTab(e: KeyboardEvent, caret: number): boolean {
    const ctx = detectTable(this.ta.value, caret);
    if (!ctx) return false;
    e.preventDefault();
    const back = e.shiftKey;
    const { delimIdx, colCount } = ctx;
    let rows = ctx.lines.slice();
    let row = ctx.caretLine;
    let col = ctx.caretCol;
    const nextBody = (from: number, dir: 1 | -1): number => {
      let r = from + dir;
      if (r === delimIdx) r += dir; // never land on the `|---|` row
      return r;
    };
    if (row === delimIdx) {
      // Don't navigate within the delimiter row — hop to an adjacent data row.
      row = back ? Math.max(0, delimIdx - 1) : Math.min(rows.length - 1, delimIdx + 1);
      col = back ? colCount - 1 : 0;
    } else if (!back) {
      if (col + 1 < colCount) col++;
      else {
        const nr = nextBody(row, 1);
        if (nr >= rows.length) { rows = [...rows, emptyRow(colCount)]; row = rows.length - 1; col = 0; }
        else { row = nr; col = 0; }
      }
    } else {
      if (col - 1 >= 0) col--;
      else {
        const pr = nextBody(row, -1);
        if (pr >= 0) { row = pr; col = colCount - 1; } // else at very start — stay
      }
    }
    const ctx2: TableCtx = { ...ctx, lines: rows };
    const { lines: out, textRange } = formatTable(ctx2);
    const block = out.join("\n");
    const rng = textRange(row, col);
    this.splice(ctx.blockStart, ctx.blockEnd, block, ctx.blockStart + rng.start, ctx.blockStart + rng.end);
    return true;
  }

  /** 0.375.0: Enter inside a table. On a filled body/header row it adds a new
   *  empty row below (caret in its first cell); on an already-empty body row it
   *  EXITS the table (drops that row, caret on a fresh line beneath). */
  private tableEnter(e: KeyboardEvent, caret: number): boolean {
    const ctx = detectTable(this.ta.value, caret);
    if (!ctx) return false;
    const { delimIdx, colCount } = ctx;
    const row = ctx.caretLine;
    const rowIsEmpty = (rrel: number): boolean => splitRow(ctx.lines[rrel] ?? "").every((c) => c.trim() === "");
    e.preventDefault();
    let rows = ctx.lines.slice();

    if (row !== delimIdx && row > delimIdx && rowIsEmpty(row)) {
      // Exit the table: remove the empty row, reflow, land on a new line below.
      rows.splice(row, 1);
      const { lines: out } = formatTable({ ...ctx, lines: rows });
      const block = out.join("\n");
      const caretPos = ctx.blockStart + block.length + 1; // just after the added "\n"
      this.splice(ctx.blockStart, ctx.blockEnd, block + "\n", caretPos, caretPos);
      return true;
    }

    // Add a new row. Enter on the header (above the delimiter) drops the row
    // below the delimiter, so a fresh table's first Enter starts the body.
    const insertAfter = row < delimIdx ? delimIdx : row;
    rows.splice(insertAfter + 1, 0, emptyRow(colCount));
    const { lines: out, textRange } = formatTable({ ...ctx, lines: rows });
    const block = out.join("\n");
    const rng = textRange(insertAfter + 1, 0);
    const at = ctx.blockStart + rng.start;
    this.splice(ctx.blockStart, ctx.blockEnd, block, at, at);
    return true;
  }

  /** Autopair family: wrap-selection, pair insert, type-over, pair delete.
   *  Driven by keydown on desktop and by beforeinput on mobile (see onBeforeInput
   *  for why), so it takes a minimal structural key rather than a KeyboardEvent —
   *  KeyboardEvent satisfies it, and the beforeinput adapter supplies the same
   *  shape. */
  private handlePairs(e: PairKey, start: number, end: number): void {
    if (!getSettings().autoPairBrackets) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = this.ta.value;
    const prev = v[start - 1];
    const next = v[start];

    // 0.345.3: the spoiler `||` pair (Stashpad's spoilerMarkup feature). It rides
    // Obsidian's markdown-pair toggle and is off unless spoilers are enabled — so
    // ordinary `|` (tables) never auto-pairs. Like the doubled markers, it only
    // pairs on the SECOND consecutive `|`, keeping `| cell | cell |` untouched.
    const spoilerPair = getSettings().spoilerMarkup && this.obsidianFlag("autoPairMarkdown");

    // Which Obsidian toggle governs this character?
    const allowed = (ch: string): boolean =>
      this.obsidianFlag(MD_MARKERS.has(ch) ? "autoPairMarkdown" : "autoPairBrackets");

    // WRAP THE SELECTION (VS Code's `autoSurround`). The wrapped text stays
    // selected so repeats nest: note → [note] → [[note]], word → *word* →
    // **word**. Quotes skip the prose-guard: a selection is explicit intent.
    if (start !== end) {
      const isSpoilerWrap = e.key === "|" && spoilerPair;
      const closer = e.key.length === 1 ? (isSpoilerWrap ? "|" : WRAP[e.key]) : undefined;
      if (!closer || (!isSpoilerWrap && !allowed(e.key))) return;
      e.preventDefault();
      this.splice(start, end, e.key + v.slice(start, end) + closer, start + 1, end + 1);
      return;
    }

    const insertPair = (open: string, close: string): void => {
      e.preventDefault();
      this.splice(start, start, open + close, start + open.length);
    };

    if (e.key === "Backspace") {
      // Pair deletion: opener before the caret + its closer right after.
      const pairClose = prev !== undefined ? SIMPLE[prev] : undefined;
      const symmetric = prev !== undefined && (DOUBLED.has(prev) || (prev === "|" && spoilerPair)) && next === prev;
      if ((pairClose && next === pairClose) || symmetric) {
        e.preventDefault();
        this.splice(start - 1, start + 1, "", start - 1);
      }
      return;
    }
    if (e.key.length !== 1) return;

    // Type-over an existing closer (spoiler `|` included when enabled).
    if ((CLOSERS.has(e.key) || (e.key === "|" && spoilerPair)) && next === e.key) {
      e.preventDefault();
      this.ta.setSelectionRange(start + 1, start + 1);
      return;
    }
    if (!allowed(e.key)) return;

    // The `before` guard: only auto-close when what follows is whitespace,
    // end-of-line, or a closing delimiter — never mid-word.
    const beforeOk = next === undefined || BEFORE_OK.test(next);

    if (e.key in SIMPLE) {
      if (e.key === "[" && prev === "[" && v[start - 2] === "[") return; // 3rd bracket is literal
      if (e.key === "`" && prev === "`") return;                          // ``` fences
      // Quotes pair only at a WORD START, so apostrophes ("don't") and a
      // hand-typed closing quote insert plainly.
      if (QUOTE_OPENERS.has(e.key) && !(prev === undefined || /[\s([{"'‘“]/.test(prev))) return;
      if (!beforeOk) return;
      insertPair(e.key, SIMPLE[e.key]);
      return;
    }
    if (DOUBLED.has(e.key)) {
      // Pair on the SECOND marker only, and never on a third.
      if (prev === e.key && v[start - 2] !== e.key && beforeOk) insertPair(e.key, e.key + e.key);
    }
    // Spoiler `||` — pairs like a doubled marker on the second `|`, gated on the
    // spoiler setting so tables are untouched.
    if (e.key === "|" && spoilerPair) {
      if (prev === "|" && v[start - 2] !== "|" && beforeOk) insertPair("|", "||");
    }
  }

  /** Double-click selects a word — but browsers include the trailing space.
   *  Trim it so wrapping/replacing a word doesn't swallow the gap after it. */
  private onDoubleClick = (): void => {
    const start = this.ta.selectionStart;
    let end = this.ta.selectionEnd;
    if (start == null || end == null || end <= start) return;
    const v = this.ta.value;
    while (end > start && /\s/.test(v[end - 1])) end--;
    if (end !== this.ta.selectionEnd) this.ta.setSelectionRange(start, end);
  };
}
