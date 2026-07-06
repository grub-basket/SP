/** Default stop-words trimmed out of slugs. Editable in settings. */
export const DEFAULT_STOPWORDS = [
  "a","an","the","and","or","but","if","then","else","of","in","on","at","to",
  "for","with","by","from","as","is","are","was","were","be","been","being",
  "i","you","he","she","it","we","they","this","that","these","those","my",
  "your","our","their","do","does","did","so","just","very","really","im",
];

const MAX_LEN = 50;

export function bodyToSlug(body: string, stopwords: string[] = DEFAULT_STOPWORDS): string {
  const stopSet = stopwords instanceof Set ? stopwords : new Set(stopwords.map((s) => s.toLowerCase()));
  const firstLine = (body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
  if (!firstLine) return "Untitled";
  // Simplified slug rule (0.59.0): strip apostrophe-likes WITHOUT
  // splitting the word ("don't" → "dont", not "don t" or "Don"), then
  // collapse every other non-alphanumeric run to a space, tokenise,
  // drop stopwords, proper-case, join with hyphens. Earlier rule
  // specially handled English contraction tails and over-aggressively
  // dropped the second half — losing "t" off "don't" to leave "Don".
  // Apostrophe class covers ASCII ', U+2019, U+02BC, U+2018, U+201A, U+201B.
  const noQuotes = firstLine.replace(/['‘-‛ʼ]/g, "");
  const words = noQuotes
    .replace(/[^A-Za-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stopSet.has(w.toLowerCase()))
    .map((w) => {
      // Smart proper-case: preserve all-caps tokens (HCC, NASA, US, etc.)
      // so acronyms don't read as "Hcc". A token counts as all-caps if
      // every alphabetic char is uppercase AND it has at least 2 chars
      // (single letters like "A" stay first-cap-only). Mixed-case tokens
      // get the standard "first up, rest down" treatment.
      if (w.length >= 2 && /^[A-Z0-9]+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > MAX_LEN) break;
    slug = next;
  }
  return slug || "Untitled";
}

export function buildFilename(slug: string, id: string): string {
  return `${slug}-${id}.md`;
}

export function parseIdFromFilename(basename: string): string | null {
  // Match EXACTLY what buildFilename emits: a trailing `-<id>` where <id> is
  // 6 chars from id-service's alphabet (no l/o/0/1). The old {4,12} + full
  // a-z0-9 class matched ordinary trailing words — `meeting-notes` and
  // `quick-notes` both parsed to the same "notes", colliding the synthetic
  // node ids minted for non-Stashpad files. (0.140.5 review.) The `-N`
  // rename uniquifier keeps `-<id>` last, so this still recovers the id.
  const m = basename.match(/-([abcdefghijkmnpqrstuvwxyz23456789]{6})$/);
  return m ? m[1] : null;
}

/** True for a real generated Stashpad note id: exactly 6 chars from id-service's
 *  alphabet — the same shape `parseIdFromFilename` recovers, so a filename built
 *  with it round-trips. Used to safely fall back to the FRONTMATTER id when a
 *  file's name lacks the `-<id>` suffix (repairing hand-renamed notes) without
 *  ever renaming a foreign file that merely carries some other `id:` value. */
export function isNoteId(id: unknown): id is string {
  return typeof id === "string" && /^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/.test(id);
}

/** Place an attachment's uniquifier stamp at the END of the filename (just
 *  before the extension) rather than the start:
 *  `buildAttachmentName("photo.png", "lqf3k2a9") === "photo-lqf3k2a9.png"`.
 *  Files with no extension just get `-<stamp>` appended. 0.109.0 — the stamp
 *  used to be a prefix (`lqf3k2a9-photo.png`); suffixing keeps the readable
 *  name first and the original extension last. */
export function buildAttachmentName(originalName: string, stamp: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot > 0) return `${originalName.slice(0, dot)}-${stamp}${originalName.slice(dot)}`;
  return `${originalName}-${stamp}`;
}

/** Detect a legacy *prefix*-stamped attachment name (`<stamp>-<rest>`) so
 *  rebootstrap can migrate it to the suffix form. The stamp was
 *  `Date.now().toString(36)` (8 base36 chars). To avoid renaming user files
 *  that merely start with a short token, only match when the prefix decodes to
 *  a plausible recent millisecond timestamp. Returns `{ stamp, rest }` or null.
 *  After migration the name is `<rest-base>-<stamp>.<ext>`, whose leading token
 *  is the human name — so this won't re-match and the migration is idempotent.
 */
export function parseLegacyAttachmentPrefix(basename: string): { stamp: string; rest: string } | null {
  const m = basename.match(/^([0-9a-z]{7,9})-(.+)$/);
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  // base36 ms timestamps land ~2015-01-01 (1.42e12) onward; cap a day past now.
  if (!Number.isFinite(ts) || ts < 1.42e12 || ts > Date.now() + 86_400_000) return null;
  return { stamp: m[1], rest: m[2] };
}
