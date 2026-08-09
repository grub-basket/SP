/** Metadata scraped from a page. Every field optional — the whole design
 *  assumes sites give what they feel like, and the user edits the rest. */
export interface LinkMeta {
  url: string;
  /** Where the page says it lives, if it disagrees with the URL we fetched. */
  canonicalUrl?: string;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  /** ISO-ish string exactly as published — NOT parsed, so a weird format is
   *  preserved rather than silently turned into the wrong date. */
  published?: string;
  imageUrl?: string;
  type?: string;
  /** Which extractor produced this. Recorded so a thin result is never
   *  mistaken for a complete one — see the YouTube truncation note in
   *  docs/branches/link-previews.md. */
  via: "opengraph" | "twitter" | "jsonld" | "html" | "mixed";
}

/** Decode the handful of HTML entities that actually show up in meta tags.
 *
 *  Deliberately NOT innerHTML-based: this parses untrusted remote HTML, and
 *  routing it through an element that the browser will interpret is how a
 *  scraper becomes an injection vector. A fixed table cannot execute anything.
 *  Numeric escapes are covered because titles are full of them (&#39;). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Ampersand LAST, or "&amp;lt;" would decode twice into "<".
    .replace(/&amp;/g, "&");
}

function clean(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const out = decodeEntities(s).replace(/\s+/g, " ").trim();
  return out || undefined;
}

/** Pull `<meta>` values into a map keyed by the property/name attribute.
 *
 *  Regex rather than DOMParser: this must run identically on desktop and
 *  mobile, and must never hand remote markup to an HTML parser that could
 *  fetch subresources. Attribute order varies wildly in the wild, so property
 *  and content are matched independently within a single tag rather than
 *  assuming `property` comes first. */
export function parseMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const val = /\bcontent\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1];
    if (!key || val == null) continue;
    const k = key.toLowerCase();
    // FIRST value wins: pages that repeat og:image list the primary first, and
    // a later duplicate is usually a fallback or a per-section override.
    if (!out.has(k)) out.set(k, val);
  }
  return out;
}

/** First JSON-LD block that looks like a document (Article/VideoObject/etc.).
 *  Wrapped defensively — malformed JSON-LD is extremely common and must never
 *  take the whole extraction down with it. */
export function parseJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim()) as unknown;
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"]))
          ? (parsed as { "@graph": unknown[] })["@graph"]
          : [parsed];
      for (const item of list) {
        if (item && typeof item === "object" && ("headline" in item || "name" in item || "description" in item)) {
          return item as Record<string, unknown>;
        }
      }
    } catch { /* malformed block — try the next one */ }
  }
  return null;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v && typeof (v as { name: unknown }).name === "string") {
    return (v as { name: string }).name;
  }
  if (Array.isArray(v) && v.length) return str(v[0]);
  return undefined;
}

/** Extract what we can from a page.
 *
 *  Precedence is og: → twitter: → JSON-LD → bare HTML, per field rather than
 *  per source: a page may have a good og:title and no og:description while its
 *  JSON-LD has a full description, and taking a single source wholesale would
 *  throw that away. `via` reports "mixed" when that happens, so the record says
 *  honestly where it came from. */
export function extractLinkMeta(url: string, html: string): LinkMeta {
  const meta = parseMetaTags(html);
  const ld = parseJsonLd(html);
  const used = new Set<LinkMeta["via"]>();

  const pick = (
    og: string | undefined, tw: string | undefined,
    ldv: string | undefined, htmlv: string | undefined,
  ): string | undefined => {
    if (clean(og)) { used.add("opengraph"); return clean(og); }
    if (clean(tw)) { used.add("twitter"); return clean(tw); }
    if (clean(ldv)) { used.add("jsonld"); return clean(ldv); }
    if (clean(htmlv)) { used.add("html"); return clean(htmlv); }
    return undefined;
  };

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const canonical = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i.exec(html)?.[0];
  const canonicalHref = canonical
    ? /\bhref\s*=\s*["']([^"']+)["']/i.exec(canonical)?.[1]
    : undefined;

  const out: LinkMeta = {
    url,
    canonicalUrl: clean(canonicalHref),
    title: pick(meta.get("og:title"), meta.get("twitter:title"), str(ld?.headline) ?? str(ld?.name), titleTag),
    description: pick(meta.get("og:description"), meta.get("twitter:description"), str(ld?.description), meta.get("description")),
    siteName: pick(meta.get("og:site_name"), undefined, str((ld as { publisher?: unknown })?.publisher), undefined),
    author: pick(meta.get("article:author"), meta.get("twitter:creator"), str((ld as { author?: unknown })?.author), meta.get("author")),
    published: pick(meta.get("article:published_time"), undefined, str(ld?.datePublished) ?? str(ld?.uploadDate), undefined),
    imageUrl: pick(meta.get("og:image"), meta.get("twitter:image"), str((ld as { thumbnailUrl?: unknown })?.thumbnailUrl), undefined),
    type: clean(meta.get("og:type")),
    via: "html",
  };
  out.via = used.size === 0 ? "html" : used.size === 1 ? [...used][0] : "mixed";
  return out;
}
