/** Pure (DOM-free) helpers behind the settings/modal input suggesters in
 *  `src/input-suggest.ts`. Kept separate so `scripts/tests` can exercise them
 *  without Obsidian.
 *
 *  Matching is **Sift** (docs/sift.md): all tokens, any order, case-insensitive
 *  substring. On top of the Sift FILTER this adds a light RANK so the obvious
 *  pick floats up: exact match > prefix match > a word/segment that starts with
 *  the first token > everything else. Ties keep the caller's order (so a source
 *  pre-sorted by frequency stays frequency-sorted inside each band).
 *
 *  0.494.0 — autocomplete-everywhere. */

export function siftTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Sift-filter `items` by `query` against `hay(item)`, then rank. `key(item)`
 *  is what exact/prefix are judged on (defaults to the haystack). */
export function siftRank<T>(
  query: string,
  items: readonly T[],
  hay: (item: T) => string,
  key: (item: T) => string = hay,
): T[] {
  const tokens = siftTokens(query);
  if (tokens.length === 0) return items.slice();
  const q = query.trim().toLowerCase();
  const first = tokens[0];
  const scored: Array<{ item: T; band: number; idx: number }> = [];
  items.forEach((item, idx) => {
    const h = hay(item).toLowerCase();
    for (const t of tokens) if (!h.includes(t)) return;
    const k = key(item).toLowerCase();
    let band = 3;
    if (k === q) band = 0;
    else if (k.startsWith(q)) band = 1;
    else if (new RegExp(`(^|[\\s/\\-_.#])${escapeRegExp(first)}`).test(k)) band = 2;
    scored.push({ item, band, idx });
  });
  scored.sort((a, b) => a.band - b.band || a.idx - b.idx);
  return scored.map((s) => s.item);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The list item under the caret in a separator-delimited field
 *  ("a, b, c" / ".edtz .vhistory"). `start`/`end` bound the TRIMMED token. */
export interface ListToken { start: number; end: number; token: string }

/** Find the token under `caret`. `sep` is a single-character class
 *  (e.g. `/,/` or `/[\s,]/`) — a non-global regex tested per character. */
export function tokenAt(value: string, caret: number, sep: RegExp): ListToken {
  const c = Math.max(0, Math.min(caret, value.length));
  let segStart = c;
  while (segStart > 0 && !sep.test(value[segStart - 1])) segStart--;
  let segEnd = c;
  while (segEnd < value.length && !sep.test(value[segEnd])) segEnd++;
  const seg = value.slice(segStart, segEnd);
  const lead = seg.length - seg.trimStart().length;
  const token = seg.trim();
  const start = segStart + lead;
  return { start, end: start + token.length, token };
}

/** Every token in the field EXCEPT the one at `tok` — used to hide values the
 *  list already contains. Lowercased. */
export function otherTokens(value: string, tok: ListToken, sep: RegExp): Set<string> {
  const out = new Set<string>();
  let cur = "";
  let curStart = 0;
  const flush = (endIdx: number): void => {
    const t = cur.trim();
    // Skip the token being edited (identified by position, not text, so a
    // duplicate elsewhere in the list still counts as "taken").
    const lead = cur.length - cur.trimStart().length;
    if (t && curStart + lead !== tok.start) out.add(t.toLowerCase());
    cur = "";
    curStart = endIdx + 1;
  };
  for (let i = 0; i < value.length; i++) {
    if (sep.test(value[i])) flush(i);
    else cur += value[i];
  }
  flush(value.length);
  return out;
}

/** Replace the token `tok` with `replacement`, leaving every other list item
 *  (and the separators/spacing around them) untouched. When the token sits
 *  right after a non-space separator ("a,|") a single space is inserted so the
 *  list stays readable ("a, b"). Returns the new value + where the caret goes. */
export function replaceToken(value: string, tok: ListToken, replacement: string): { value: string; caret: number } {
  const before = value.slice(0, tok.start);
  const after = value.slice(tok.end);
  const prev = before.slice(-1);
  const pad = before.length > 0 && prev.trim() !== "" ? " " : "";
  const next = before + pad + replacement + after;
  return { value: next, caret: before.length + pad.length + replacement.length };
}
