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
  const m = basename.match(/-([a-z0-9]{4,12})$/);
  return m ? m[1] : null;
}
