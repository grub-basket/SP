import type { App } from "obsidian";
import { getSettings } from "./settings";

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
 *  ("don't") from spawning a pair. */
const SIMPLE: Record<string, string> = { "[": "]", "(": ")", "`": "`", '"': '"', "'": "'" };
/** Emphasis markers that pair on the SECOND keypress (`**|**`). */
const DOUBLED = new Set(["*", "~", "="]);
/** Characters that "type over" an identical character sitting at the caret. */
const CLOSERS = new Set(["]", ")", "`", "*", "~", "=", '"', "'"]);
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

export interface MarkdownInputOptions {
  /** True when THIS keydown will insert a newline rather than submit/commit.
   *  The composer submits on Enter (or Shift+Enter, per its mode); the
   *  workbench commits on Mod+Enter. List continuation only runs for real
   *  newlines, so it can never pre-empt a submit. Default: never. */
  insertsNewline?: (e: KeyboardEvent) => boolean;
}

export class MarkdownInput {
  constructor(private app: App, private ta: HTMLTextAreaElement, private opts: MarkdownInputOptions = {}) {}

  attach(): void {
    this.ta.addEventListener("keydown", this.onKeyDown, true);
    this.ta.addEventListener("dblclick", this.onDoubleClick);
  }

  detach(): void {
    this.ta.removeEventListener("keydown", this.onKeyDown, true);
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
    this.handlePairs(e, start, end);
  };

  /** List continuation (Obsidian's `smartIndentList`). Runs ONLY when this
   *  Enter inserts a newline — a submit/commit Enter is left alone. */
  private handleEnter(e: KeyboardEvent, start: number, end: number): void {
    if (!getSettings().autoPairBrackets) return;      // master switch
    if (!this.obsidianFlag("smartIndentList")) return; // Obsidian's toggle
    if (!this.opts.insertsNewline?.(e)) return;
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
    if (!getSettings().autoPairBrackets) return;
    if (!this.obsidianFlag("smartIndentList")) return;
    const v = this.ta.value;
    const multiline = start !== end && v.slice(start, end).includes("\n");
    const { start: ls, end: le } = this.lineBounds(start);
    const onListLine = !!parseListLine(v.slice(ls, le));
    if (!multiline && !onListLine) return; // let Tab do its normal job

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

  /** Autopair family: wrap-selection, pair insert, type-over, pair delete. */
  private handlePairs(e: KeyboardEvent, start: number, end: number): void {
    if (!getSettings().autoPairBrackets) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = this.ta.value;
    const prev = v[start - 1];
    const next = v[start];

    // Which Obsidian toggle governs this character?
    const allowed = (ch: string): boolean =>
      this.obsidianFlag(MD_MARKERS.has(ch) ? "autoPairMarkdown" : "autoPairBrackets");

    // WRAP THE SELECTION (VS Code's `autoSurround`). The wrapped text stays
    // selected so repeats nest: note → [note] → [[note]], word → *word* →
    // **word**. Quotes skip the prose-guard: a selection is explicit intent.
    if (start !== end) {
      const closer = e.key.length === 1 ? WRAP[e.key] : undefined;
      if (!closer || !allowed(e.key)) return;
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
      const symmetric = prev !== undefined && DOUBLED.has(prev) && next === prev;
      if ((pairClose && next === pairClose) || symmetric) {
        e.preventDefault();
        this.splice(start - 1, start + 1, "", start - 1);
      }
      return;
    }
    if (e.key.length !== 1) return;

    // Type-over an existing closer.
    if (CLOSERS.has(e.key) && next === e.key) {
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
      if ((e.key === '"' || e.key === "'") && !(prev === undefined || /[\s([{"'‘“]/.test(prev))) return;
      if (!beforeOk) return;
      insertPair(e.key, SIMPLE[e.key]);
      return;
    }
    if (DOUBLED.has(e.key)) {
      // Pair on the SECOND marker only, and never on a third.
      if (prev === e.key && v[start - 2] !== e.key && beforeOk) insertPair(e.key, e.key + e.key);
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
