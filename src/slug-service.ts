/** Default stop-words trimmed out of slugs. Editable in settings. */
export const DEFAULT_STOPWORDS = [
  "a","an","the","and","or","but","if","then","else","of","in","on","at","to",
  "for","with","by","from","as","is","are","was","were","be","been","being",
  "i","you","he","she","it","we","they","this","that","these","those","my",
  "your","our","their","do","does","did","so","just","very","really","im",
];

/** Strip inline Markdown syntax, leaving the visible text.
 *
 *  Titles in Stashpad come from a note's first body line, which is raw Markdown —
 *  so a breadcrumb read `📕 **Atomic Habits** — James Clear` complete with
 *  asterisks. Every consumer of a title is a PLAIN-TEXT context (the breadcrumb,
 *  the focused header, `title=` tooltips, the Obsidian tab title), and several of
 *  them cannot render HTML at all, so stripping is the fix that works everywhere
 *  — rendering Markdown would only have been possible in some of them.
 *
 *  Conservative on purpose: emphasis is only unwrapped when the delimiters look
 *  like real emphasis, so `snake_case_name` and `2 * 3` survive intact. Anything
 *  it doesn't recognise is left alone rather than mangled.
 */
export function stripInlineMarkdown(input: string): string {
  // Escapes are PROTECTED first, not stripped last. `\*not bold\*` otherwise
  // reaches the emphasis rules looking exactly like emphasis, and comes out as
  // `\not bold\` — asterisks eaten, backslashes kept, precisely backwards.
  // Placeholders use NUL, which can't occur in a note title.
  const escaped: string[] = [];
  let out = input.replace(/\\([\\`*_{}[\]()#+\-.!~=>])/g, (_m, ch: string) => {
    escaped.push(ch);
    return `\u0000${escaped.length - 1}\u0000`;
  });
  // Images before links, so alt text survives rather than the whole tag going.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Wikilinks: [[Target|Alias]] shows the alias; [[Target]] shows the target.
  // The lookaheads require at least one character that is neither whitespace
  // NOR a delimiter in
  // part being kept. Without them `[^\]]+` happily matches pure whitespace, so
  // `[[   ]]` stripped to `   ` — the brackets silently vanished from the title
  // and the user saw an empty gap where they had typed something. An empty or
  // whitespace-only target is not a link to Obsidian either; it renders as
  // literal text, so leaving it alone is also the truthful thing to show.
  // The no-alias fallback excludes `|` as well, so a blank ALIAS (`[[Target| ]]`)
  // stays literal rather than falling through and rendering as `Target| `.
  // NB: `\S` alone is NOT enough — it matches `]`, so the closing bracket itself
  // satisfied the lookahead and `[[   ]]` still stripped. Caught by a unit pass.
  out = out.replace(/\[\[(?=[^\]|]*[^\s\]|])([^\]|]+)\|(?=[^\]]*[^\s\]])([^\]]+)\]\]/g, "$2");
  out = out.replace(/\[\[(?=[^\]|]*[^\s\]|])([^\]|]+)\]\]/g, "$1");
  // Leading block markers (heading hashes, quote, bullet, ordered marker).
  out = out.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "");
  // Inline code — keep the code text, drop the backticks.
  out = out.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");
  // Emphasis, longest delimiter first so *** isn't half-eaten by **.
  out = out.replace(/(\*\*\*|___)(\S(?:[\s\S]*?\S)?)\1/g, "$2");
  out = out.replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, "$2");
  // Single-delimiter emphasis: require a non-word char outside and no space
  // just inside, which is what keeps `snake_case` and `a * b` untouched.
  out = out.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1");
  out = out.replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  out = out.replace(/==([^=]+)==/g, "$1");
  // Restore what the author escaped, as the bare character.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => escaped[Number(i)] ?? "");
  return out.replace(/\s+/g, " ").trim();
}

const MAX_LEN = 50;

/** 0.230.0: URLs and file paths, removed from a title line BEFORE it is
 *  tokenised.
 *
 *  Without this, the tokeniser's "collapse every non-alphanumeric run to a
 *  space" rule shreds them into their own words: a note starting
 *  `Check https://example.com/q3/report?x=1` was named
 *  `Check-Https-Example-Com-Q3-Report-X-1`. The scheme and the domain are pure
 *  noise in a filename, and they crowd out the real words because the 50-char
 *  budget is spent left to right.
 *
 *  Deliberately keyed on a SLASH or a SCHEME, never on a bare dotted token:
 *  `import-service` calls bodyToSlug with a plain basename (`photo.png`), and
 *  treating that as a path would erase the only text it has.
 *
 *  Link text is KEPT, not dropped — `[the Q3 report](https://…)` should be
 *  titled "The Q3 Report". Only the target is noise. */
type SlugReplacer = string | ((...args: string[]) => string);
const URL_OR_PATH_RULES: Array<[RegExp, SlugReplacer]> = [
  // Obsidian embeds — an image/file transclusion contributes no title text.
  [/!\[\[[^\]]*\]\]/g, " "],
  // Markdown image — same reasoning; alt text is usually a filename.
  [/!\[[^\]]*\]\([^)]*\)/g, " "],
  // Markdown link: keep the LABEL, drop the target.
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  // Wikilink: keep the alias if there is one, else the last path segment.
  [/\[\[([^\]|]*)\|([^\]]+)\]\]/g, "$2"],
  [/\[\[([^\]]+)\]\]/g, (_m: string, target: string) => target.split("/").pop() ?? target],
  // Scheme-bearing URLs (http, https, ftp, obsidian, file, …) and mailto.
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "],
  [/\bmailto:\S+/gi, " "],
  // Bare www. hosts, which carry no scheme but are still URLs.
  [/\bwww\.\S+/gi, " "],
  // Bare email addresses.
  [/\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi, " "],
  // Windows absolute paths: C:\Users\... — before the POSIX rule, since the
  // drive letter would otherwise look like a scheme.
  [/\b[a-z]:\\[^\s]*/gi, " "],
  // POSIX-ish paths: anything containing a slash that is not lone punctuation.
  // Covers /a/b, ./a, ../a, a/b/c.md, ~/notes.
  [/(?:^|\s)[~.]{0,2}\/[^\s]*/g, " "],
  // Bare relative paths, but ONLY when they are unmistakably paths: either a
  // file extension at the end, or two-plus slashes. A single slash between two
  // plain words is far more often prose — "3/4", "and/or", "km/h", "24/7" —
  // and eating those turned "Ratio was 3/4 of target" into "Ratio-Target".
  // Missing `docs/guide` (one slash, no extension) is the deliberate trade:
  // a false negative leaves a slightly noisy title, a false positive deletes
  // real words.
  [/(?:^|\s)[^\s/]+\/[^\s]*\/[^\s]*/g, " "],
  [/(?:^|\s)[^\s/]+\/[^\s]*\.[a-z0-9]{1,8}\b/gi, " "],
];

/** 0.232.0: which kinds of noise a title line contained. Drives the trailing
 *  marker — see MARKER_URL / MARKER_PATH. */
export function detectUrlsAndPaths(line: string): { url: boolean; path: boolean } {
  // Links and embeds contribute their LABEL, not their target, so resolve them
  // first — otherwise `[report](https://x)` and `[[A/B]]` would report a path
  // that the title never contained.
  const delinked = line
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1 $2")
    .replace(/\[\[[^\]]*\]\]/g, " ");
  const URL_RES = [
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
    /\bmailto:\S+/gi,
    /\bwww\.\S+/gi,
    /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi,
  ];
  let rest = delinked;
  let url = false;
  for (const re of URL_RES) {
    if (re.test(rest)) url = true;
    re.lastIndex = 0;
    rest = rest.replace(re, " ");
  }
  // Path detection runs on what REMAINS after URLs are gone, mirroring the
  // order in URL_OR_PATH_RULES. Without this a plain https:// URL matched the
  // multi-slash path rule and every link got BOTH markers.
  const path = /\b[a-z]:\\[^\s]*/i.test(rest)
    || /(?:^|\s)[~.]{0,2}\/[^\s]*/.test(rest)
    || /(?:^|\s)[^\s/]+\/[^\s]*\/[^\s]*/.test(rest)
    || /(?:^|\s)[^\s/]+\/[^\s]*\.[a-z0-9]{1,8}\b/i.test(rest);
  return { url, path };
}

/** Trailing markers. All-caps "URL" survives the proper-caser untouched;
 *  "File-Path" is written pre-cased for the same reason. */
const MARKER_URL = "URL";
const MARKER_PATH = "File-Path";

/** Strip URLs/paths from a title line. Exported for testing and so callers can
 *  reason about what the title will contain. */
export function stripUrlsAndPaths(line: string): string {
  let out = line;
  for (const [re, rep] of URL_OR_PATH_RULES) {
    out = typeof rep === "string" ? out.replace(re, rep) : out.replace(re, rep);
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Last readable segment of the first URL/path in a line — the fallback when
 *  stripping removes EVERYTHING, so a note whose entire first line is a link
 *  gets a useful name instead of "Untitled".
 *  `https://example.com/q3/quarterly-report?x=1` → `quarterly report`. */
function salvageFromUrl(line: string): string {
  const m = line.match(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|[~.]{0,2}\/[^\s]+|\b[^\s/]+\/[^\s]+/i);
  if (!m) return "";
  // Drop query + hash, then take the last non-empty path segment.
  const bare = m[0].replace(/[?#].*$/, "").replace(/\/+$/, "");
  const segs = bare.split("/").filter(Boolean);
  let last = segs.pop() ?? "";
  // A bare host (no path) — use its main label: example.com -> example.
  if (segs.length === 0 || /^[a-z][a-z0-9+.-]*:$/i.test(segs[0] ?? "")) {
    last = last.replace(/^www\./i, "");
    const labels = last.split(".").filter(Boolean);
    if (labels.length > 1) last = labels[labels.length - 2];
  }
  // Strip a file extension, then let the normal tokeniser handle the rest.
  return last.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[-_+]+/g, " ").trim();
}

export function bodyToSlug(body: string, stopwords: string[] = DEFAULT_STOPWORDS): string {
  const stopSet = stopwords instanceof Set ? stopwords : new Set(stopwords.map((s) => s.toLowerCase()));
  const rawFirstLine = (body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
  if (!rawFirstLine) return "Untitled";
  // 0.230.0: drop URLs and file paths before tokenising. If that empties the
  // line, the line WAS a link — salvage its last path segment rather than
  // falling through to "Untitled", which would name every link-only note the
  // same thing and collide their filenames.
  // 0.232.0: note WHAT was stripped, so the title can carry a trailing marker.
  // The words themselves are still dropped (a domain in a filename is noise) —
  // the marker exists purely so "URL" / "File Path" are searchable when you know
  // a note contains a link but not what it said.
  const found = detectUrlsAndPaths(rawFirstLine);
  const markers: string[] = [];
  if (found.url) markers.push(MARKER_URL);
  if (found.path) markers.push(MARKER_PATH);
  const markerSuffix = markers.length ? `-${markers.join("-")}` : "";

  let firstLine = stripUrlsAndPaths(rawFirstLine);
  if (!firstLine) firstLine = salvageFromUrl(rawFirstLine);
  // A line that was ONLY a link still gets marked, so it is findable.
  if (!firstLine) return markerSuffix ? `Untitled${markerSuffix}` : "Untitled";
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
  // Reserve the marker's width up front. The word loop spends the 50-char
  // budget left to right and STOPS at the limit, so appending afterwards would
  // let a long title push the marker past MAX_LEN — or drop it entirely, which
  // is precisely the case (a long line containing a link) the marker is for.
  const budget = MAX_LEN - markerSuffix.length;
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > budget) break;
    slug = next;
  }
  if (!slug) return markerSuffix ? `Untitled${markerSuffix}` : "Untitled";
  return `${slug}${markerSuffix}`;
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
