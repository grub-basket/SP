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
 *  0.494.0 — autocomplete-everywhere. 0.526.3 — also holds keepMatchInClamp,
 *  the search-snippet clamp helper used by `src/note-picker.ts`. */

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

/** 0.526.3: keep the search match inside the snippet's line clamp.
 *
 *  The search picker's cluster-row snippet is a ±2-line window around the
 *  match line, but `.stashpad-suggest-snippet` in styles.css clamps it to 5
 *  VISUAL lines (`-webkit-line-clamp: 5` on a pre-wrap block). Long context
 *  lines above the match wrap into several visual lines each, and a match deep
 *  inside a long line sits several visual lines into it, so the highlighted
 *  word could land past line 5 and be cut off.
 *
 *  `lines` is the window (blank lines already dropped), `hitIdx` the match
 *  line's index in it, `tokens` the lowercased query tokens, `cpl` an
 *  estimated characters-per-visual-line. When every token's first hit already
 *  fits in `maxLines`, the SAME array comes back (identical output). Otherwise
 *  the match line's head is cut to "…" (only when the line alone overflows),
 *  then the farthest context lines above are dropped until it fits. Only text
 *  BEFORE the first highlight is ever removed, so a highlight that was visible
 *  stays visible. */
export function keepMatchInClamp(lines: string[], hitIdx: number, tokens: string[], cpl: number, maxLines = 5): string[] {
  let hit = lines[hitIdx] ?? "";
  const lower = hit.toLowerCase();
  // col = start of the first highlight: every highlight starts at or after it,
  // so it is the one safe cut point. end = where the LAST token's first hit
  // ends, so a multi-word query keeps its far word in view too (review of
  // 0.526.3: "paragraph zebra" kept only "paragraph" in view). firstEnd = end
  // of the first highlight, the fallback target when the far word can't fit.
  let col = -1;
  let firstEnd = 0;
  let end = 0;
  for (const t of tokens) {
    const i = t ? lower.indexOf(t) : -1;
    if (i < 0) continue;
    if (col < 0 || i < col) { col = i; firstEnd = i + t.length; }
    end = Math.max(end, i + t.length);
  }
  if (col < 0) return lines;
  let lead = lines.slice(0, hitIdx);
  const ahead = (): number =>
    lead.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0) + Math.floor(end / cpl);
  if (ahead() < maxLines) return lines;
  // The cut slices the RAW line at a column found in the lowercased copy, so
  // skip it when lowercasing changed the length ("İ" → 2 code units): the
  // offsets no longer line up and the cut could land past the match.
  if (Math.floor(end / cpl) >= maxLines && lower.length === hit.length) {
    // The match line alone overflows: keep about half a line before the match,
    // starting at a word boundary when one falls before it.
    let cut = Math.max(0, col - Math.floor(cpl / 2));
    // Don't start on the second half of an emoji (a lone surrogate renders as
    // a replacement box), and search from cut - 1 so a cut already at a word
    // start stays put.
    if (cut > 0 && cut < col && (hit.charCodeAt(cut) & 0xfc00) === 0xdc00) cut++;
    const sp = hit.indexOf(" ", Math.max(0, cut - 1));
    if (sp >= 0 && sp < col) cut = sp + 1;
    if (cut > 0) { hit = "…" + hit.slice(cut); firstEnd += 1 - cut; end += 1 - cut; }
  }
  // The far word can't fit even with no context: aim for the first highlight.
  if (Math.floor(end / cpl) >= maxLines) end = firstEnd;
  // Dropping context only helps when the target fits once it is all gone;
  // otherwise keep it, rather than losing context and still hiding the match.
  if (Math.floor(end / cpl) < maxLines) while (lead.length && ahead() >= maxLines) lead = lead.slice(1);
  return [...lead, hit, ...lines.slice(hitIdx + 1)];
}
