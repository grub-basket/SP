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
  // Lowercase only for the stop-word filter; the emitted slug is Proper-Cased
  // so Obsidian's title display reads naturally ("My First Note" not
  // "my first note").
  // Strip common English contraction tails BEFORE removing punctuation,
  // so "Stash's" becomes "Stash" (not "Stash s") and we don't end up with
  // an orphan "s" segment in the slug. The character class covers ASCII
  // ', unicode right single quote U+2019, modifier letter apostrophe
  // U+02BC, and the common smart-quote variants U+2018/201A/201B.
  const cleaned = firstLine.replace(/['‘-‛ʼ](s|t|re|ll|ve|d|m)\b/gi, "");
  // Set of contraction tails to drop if they survive as bare tokens
  // (because the apostrophe was an exotic variant we missed). Without
  // this, "I'm falling asleep" → "M Falling Asleep" when the right-single-
  // quote stripper missed.
  const CONTRACTION_TAILS = new Set(["s", "t", "re", "ll", "ve", "d", "m"]);
  const words = cleaned
    .replace(/[^A-Za-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stopSet.has(w.toLowerCase()) && !CONTRACTION_TAILS.has(w.toLowerCase()))
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
