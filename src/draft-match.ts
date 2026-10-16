/** 0.573.1: draft-vs-note matching, shared by the composer's leftover-draft
 *  discard (view.ts `draftMatchesRecent`) and the Drafts manager's match review
 *  (modals.ts `ComposerDraftsModal`). Pure: no Obsidian imports, unit-tested in
 *  scripts/tests/draft-match.test.ts.
 *
 *  Why a shared normalizer: the two checks compared raw text, and the text a
 *  note ends up with is not the text the draft held. Send straightens iOS curly
 *  quotes (`straightenCurlyQuotesOnSend`), so a phone draft "can’t" never
 *  matched its own sent note "can't". Toggling a note into a task adds `- [ ]`,
 *  tags get appended, strikethrough wraps it in `~~`. Normalizing both sides the
 *  same way makes those differences invisible to the comparison. */

const SINGLE_QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;
/** One leading block marker: heading `#`s, a blockquote `>`, a bullet, an
 *  ordered-list number, or a task checkbox (`[ ]`, `[x]`, `[-]`, `[/]`). */
const LEAD_MARKER = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|\[[ xX\-/]?\]\s*)/;
/** A `#tag` (letters, digits, `_`, `-`, `/`), at the start or after a space.
 *  0.573.3: like Obsidian, an all-digit `#123` is NOT a tag (issue numbers,
 *  "#2 on the list") and is kept, so "bug #12" and "bug #13" stay different. */
const HASHTAG = /(^|\s)#(?=[\p{L}\p{N}_/-]*[\p{L}_/-])[\p{L}\p{N}_/-]+/gu;
/** Inline formatting markers that wrap text without being text. */
const INLINE_MARKS = /~~|==|\*\*|__|`|\[\[|\]\]/g;

/** Text reduced to what it SAYS: straight quotes, no block markers or task
 *  boxes, no tags, no inline formatting, lowercase, single spaces. Applied to
 *  BOTH sides of every comparison. */
export function normalizeForMatch(text: string | undefined): string {
  const lines = (text ?? "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .split(/\r?\n/)
    .map((line) => {
      let l = line.trim();
      // Markers stack ("- [ ] ", "> - "), so peel until none is left.
      for (let i = 0; i < 4; i++) {
        const next = l.replace(LEAD_MARKER, "");
        if (next === l) break;
        l = next;
      }
      return l;
    });
  return lines.join(" ")
    .replace(INLINE_MARKS, "")
    .replace(HASHTAG, "$1")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the draft is a leftover of `sent`: after normalizing, it equals it
 *  or is its beginning ("the start of the text is a 100% match", at any length).
 *  A draft that goes BEYOND the sent text is new writing and doesn't match.
 *  Pass `sentNormalized: true` when `sent` is already normalized (a cache). */
export function isLeftoverOf(draft: string, sent: string, sentNormalized = false, wholeWords = true): boolean {
  return isLeftoverNormalized(normalizeForMatch(draft), sentNormalized ? sent : normalizeForMatch(sent), wholeWords);
}

/** `isLeftoverOf` for two already-normalized strings (hot loops normalize the
 *  draft once, not once per note).
 *
 *  0.573.3 `wholeWords` (default on): the draft must end on a word boundary of
 *  the note, so "Email Sam" is NOT a leftover of "Email Samantha about…" (a
 *  different thought that happens to share letters). Pass false only for text
 *  you JUST sent from this composer: the flush race that leaves a leftover can
 *  capture it mid-word ("small shap"), and there the match is to your own send
 *  a moment ago, not to some older note. */
export function isLeftoverNormalized(draftNorm: string, sentNorm: string, wholeWords = true): boolean {
  if (!draftNorm || !sentNorm || !sentNorm.startsWith(draftNorm)) return false;
  return !wholeWords || endsAtWordBoundary(sentNorm, 0, draftNorm);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
/** True when `needle`, found at `at` in `hay`, isn't the start or end of a
 *  longer word there. */
function endsAtWordBoundary(hay: string, at: number, needle: string): boolean {
  const before = at > 0 ? hay[at - 1] : "";
  const after = hay[at + needle.length] ?? "";
  const startOk = !before || !WORD_CHAR.test(before) || !WORD_CHAR.test(needle[0]);
  const endOk = !after || !WORD_CHAR.test(after) || !WORD_CHAR.test(needle[needle.length - 1]);
  return startOk && endOk;
}

/** `hay` contains `needle` as whole words (not inside a longer word). */
function containsWholeWords(hay: string, needle: string): boolean {
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (endsAtWordBoundary(hay, at, needle)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fuzzy comparison for the Drafts manager's review list.

const STOPWORDS = new Set((
  "a an and are as at be but by for from has have i if in into is it its of on or so " +
  "than that the their then there these they this to was we were what when which who " +
  "will with you your my me our not no do does did just like can could would should"
).split(" "));

/** Crude stem so "drafts"/"draft" and "contains"/"contain" compare equal. Both
 *  sides go through the same function, so over-stemming is harmless. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Words of already-normalized text, stemmed, apostrophes dropped. */
export function matchWords(normalized: string): string[] {
  return normalized.replace(/'/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);
}

/** The draft's distinctive words: stopwords dropped unless that leaves fewer
 *  than three, in which case all of them. */
function keyWords(words: string[]): Set<string> {
  const content = new Set(words.filter((w) => !STOPWORDS.has(w)));
  return content.size >= 3 ? content : new Set(words);
}

/** How the draft relates to a note, strongest first. */
export type DraftMatchKind =
  | "exact"      // same text
  | "prefix"     // the draft is the start of the note (a leftover)
  | "contains"   // the draft's text appears inside the note
  | "timing"     // the note was created right after the draft was last edited, with overlapping words
  | "extends"    // the note is the start of the draft (the draft continues it)
  | "similar"    // most of the draft's words appear early in the note
  | "title";     // the draft's first line Sift-matches the note's first line (the pre-0.573 check)

export interface DraftMatch { kind: DraftMatchKind; /** 0..1 */ score: number }

/** Kinds that mean "this draft was already sent", vs. "worth a look". */
export const STRONG_MATCH_KINDS: ReadonlySet<DraftMatchKind> = new Set(["exact", "prefix", "contains", "timing"]);

export const MATCH_KIND_LABEL: Record<DraftMatchKind, string> = {
  exact: "Already sent",
  prefix: "Already sent",
  contains: "Already in this note",
  timing: "Likely sent",
  extends: "Draft continues this note",
  similar: "Similar",
  title: "Similar title",
};

/** A note prepared once for many comparisons. */
export interface PreparedNote { norm: string; words: string[]; created: number | null }

/** Words kept per note. Fuzzy matching only reads the note's opening stretch
 *  (2 × the draft's words + 10), so the rest would be memory for nothing. */
const NOTE_WORDS_CAP = 400;

export function prepareNote(body: string, created: number | null = null): PreparedNote {
  const norm = normalizeForMatch(body);
  return { norm, words: matchWords(norm).slice(0, NOTE_WORDS_CAP), created };
}

/** A draft prepared once for many comparisons. */
export interface PreparedDraft { norm: string; words: string[]; keys: Set<string>; modified: number }

export function prepareDraft(text: string, modified = 0): PreparedDraft {
  const norm = normalizeForMatch(text);
  const words = matchWords(norm);
  return { norm, words, keys: keyWords(words), modified };
}

/** Words the draft needs before a fuzzy score means anything. */
const MIN_FUZZY_WORDS = 3;
/** Share of the draft's words that must appear early in the note. */
export const SIMILAR_THRESHOLD = 0.8;
/** Looser bar when the note was created right after the draft was edited. */
const TIMING_THRESHOLD = 0.5;
/** "Right after": the note's created time is within this window of the draft's
 *  last edit. A leftover is saved a few seconds BEFORE send; a sync or flush
 *  race can stamp it slightly after. */
const TIMING_BEFORE_MS = 5_000;
const TIMING_AFTER_MS = 30_000;

/** Compare one draft with one note; null when they don't match. */
export function compareDraftToNote(d: PreparedDraft, n: PreparedNote): DraftMatch | null {
  if (!d.norm || !n.norm) return null;
  if (d.norm === n.norm) return { kind: "exact", score: 1 };
  // 0.573.3: whole words only, so a partial word never counts as "verified".
  if (isLeftoverNormalized(d.norm, n.norm)) return { kind: "prefix", score: 1 };
  if (d.words.length >= MIN_FUZZY_WORDS && containsWholeWords(n.norm, d.norm)) return { kind: "contains", score: 1 };
  if (d.keys.size < MIN_FUZZY_WORDS) return null;
  // Coverage: share of the draft's words found in the note's opening stretch.
  // Windowed so a short draft doesn't "match" every long note that happens to
  // use the same words somewhere.
  const window = new Set(n.words.slice(0, d.words.length * 2 + 10));
  let hit = 0;
  for (const w of d.keys) if (window.has(w)) hit++;
  const coverage = hit / d.keys.size;
  if (n.created !== null && d.modified > 0) {
    const gap = n.created - d.modified;
    if (gap >= -TIMING_BEFORE_MS && gap <= TIMING_AFTER_MS && coverage >= TIMING_THRESHOLD) {
      return { kind: "timing", score: coverage };
    }
  }
  const nWords = n.words.length;
  if (nWords >= MIN_FUZZY_WORDS && d.norm.startsWith(n.norm)) return { kind: "extends", score: nWords / d.words.length };
  if (coverage >= SIMILAR_THRESHOLD) return { kind: "similar", score: coverage };
  return null;
}

/** Kinds whose text is verifiably inside the note: safe for "discard all
 *  already-sent drafts" (timing is strong but only a likelihood). */
export const VERIFIED_MATCH_KINDS: ReadonlySet<DraftMatchKind> = new Set(["exact", "prefix", "contains"]);

/** Word-level diff of the draft (`a`) against the note (`b`) for the review
 *  list: `same` words in both, `del` only in the draft, `add` only in the note.
 *  Words compare by their normalized+stemmed form, so a curly vs straight quote
 *  or "drafts" vs "draft" shows as the same word. Returns null when the texts
 *  are too long for the O(n·m) table (the review then shows them side by side). */
export function wordDiff(a: string, b: string, maxCells = 250_000): { type: "same" | "add" | "del"; text: string }[] | null {
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  if (A.length * B.length > maxCells) return null;
  const key = (w: string): string => matchWords(normalizeForMatch(w)).join(" ") || w.toLowerCase();
  const ka = A.map(key), kb = B.map(key);
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { type: "same" | "add" | "del"; text: string }[] = [];
  const push = (type: "same" | "add" | "del", text: string): void => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += " " + text; else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { push("same", B[j]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push("del", A[i]); i++; }
    else { push("add", B[j]); j++; }
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}

/** Sort order for a match list: strong kinds first, then by score. */
export function compareMatches(a: DraftMatch, b: DraftMatch): number {
  const order: DraftMatchKind[] = ["exact", "prefix", "contains", "timing", "extends", "similar", "title"];
  return order.indexOf(a.kind) - order.indexOf(b.kind) || b.score - a.score;
}
