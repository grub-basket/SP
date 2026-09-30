import { htmlToMarkdown } from "obsidian";

/** Formatting tags whose presence means the HTML clipboard flavor carries
 *  something worth converting (bold/links/headings/lists/etc.). If none are
 *  present the paste is effectively plain text and we let the native
 *  plain-text paste run — converting plain text through htmlToMarkdown would
 *  needlessly escape characters like `*`, `_`, `#`. */
const FORMATTING_TAGS = /<(a|strong|b|em|i|u|s|del|mark|h[1-6]|ul|ol|li|code|pre|blockquote|img|table|thead|tbody|tr|td|th|hr|br)\b/i;

/** Convert a clipboard's rich (text/html) flavor to Markdown so formatting
 *  copied from a chat, web page, or document survives a paste into one of
 *  Stashpad's plain <textarea> surfaces.
 *
 *  Returns null (→ caller lets the native plain-text paste through) when:
 *   - there's no text/html flavor,
 *   - the HTML has no real formatting (see FORMATTING_TAGS),
 *   - conversion fails or yields nothing,
 *   - the result collapses to exactly the plain-text flavor (no gain).
 *
 *  Note: spreadsheet/table-only pastes are handled earlier by
 *  clipboardToMarkdownTable (excel-paste.ts); this covers general rich text.
 *  Both paste handlers (composer in view.ts, edit modal in modals.ts) call
 *  this — keep them in sync (the divergence bug class flagged in CLAUDE.md). */
export function richClipboardToMarkdown(data: DataTransfer): string | null {
  let html = "";
  try { html = data.getData("text/html") ?? ""; } catch { return null; }
  if (!html || !FORMATTING_TAGS.test(html)) return null;
  try {
    const md = htmlToMarkdown(html).trim();
    if (!md) return null;
    const plain = (data.getData("text/plain") ?? "").trim();
    if (md === plain) return null;
    return md;
  } catch {
    return null;
  }
}
