import type { App } from "obsidian";
import type { LinkMeta } from "./parse-og";
import { urlKey } from "./fetch";

/** Bump when the shape of a stored preview changes in a way that makes old
 *  entries worth redoing. "Reprocess everything below v2" is then a query over
 *  the cache — which is precisely why this lives here and not in note
 *  frontmatter, where one note holding several links makes a single stamp
 *  meaningless. */
export const PREVIEW_SCHEMA_VERSION = 1;

export interface PreviewEntry {
  v: number;
  /** The URL as normalised by urlKey's rules — stored so a hash collision is
   *  detectable on read rather than silently serving the wrong preview. */
  url: string;
  fetchedAt: string;
  ok: boolean;
  httpStatus?: number;
  /** Why it failed. Kept so a sweep can skip a known-dead link instead of
   *  hammering it once per run. */
  reason?: string;
  meta?: LinkMeta;
}

/** Per-URL JSON files under the plugin's private folder.
 *
 *  ONE FILE PER URL, not one big JSON: a monolithic cache is rewritten in full
 *  on every new preview, and this vault syncs — 0.253.0 was an entire fix for
 *  Obsidian Sync re-uploading files that didn't need to change. Bucketed by the
 *  first two hex characters so no single directory ends up with thousands of
 *  entries.
 *
 *  Private folder rather than the vault: the durable copy of a preview is the
 *  callout in the note. This is only here to avoid refetching, so it is not
 *  worth syncing (and a second device simply refetches). */
export class PreviewCache {
  constructor(private app: App, private privateDir: string) {}

  private dirFor(key: string): string { return `${this.privateDir}/link-previews/${key.slice(0, 2)}`; }
  private pathFor(key: string): string { return `${this.dirFor(key)}/${key}.json`; }

  async read(url: string): Promise<PreviewEntry | null> {
    const key = urlKey(url);
    try {
      const raw = await this.app.vault.adapter.read(this.pathFor(key));
      const entry = JSON.parse(raw) as PreviewEntry;
      // Collision guard: the hash is 32-bit and non-cryptographic, so confirm
      // the entry is actually about this URL before trusting it.
      if (entry && typeof entry.url === "string" && urlKey(entry.url) === key) return entry;
      return null;
    } catch { return null; }   // absent or unreadable — treat as a miss
  }

  async write(entry: PreviewEntry): Promise<void> {
    const key = urlKey(entry.url);
    const dir = this.dirFor(key);
    try {
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(this.pathFor(key), JSON.stringify(entry, null, 2));
    } catch (e) {
      // A cache write failing must never break the enrichment that produced
      // it — the note is the durable copy, this is an optimisation.
      console.warn("[Stashpad] link-preview cache write failed", entry.url, e);
    }
  }

  /** True when a cached entry can be reused as-is: same schema, and either a
   *  success or a failure recent enough that retrying is pointless. */
  isFresh(entry: PreviewEntry | null, retryFailedAfterDays = 7): boolean {
    if (!entry || entry.v !== PREVIEW_SCHEMA_VERSION) return false;
    if (entry.ok) return true;
    const age = Date.now() - Date.parse(entry.fetchedAt || "");
    return Number.isFinite(age) && age < retryFailedAfterDays * 24 * 60 * 60 * 1000;
  }
}

/** Marks a callout as ours and says which URL it describes. An HTML comment so
 *  it renders invisibly, and inside the callout so moving the block around
 *  keeps them together. */
export function previewMarker(url: string): string {
  return `<!-- sp:link-preview ${urlKey(url)} -->`;
}

/** URL keys that already have a preview block in this note body. */
export function existingPreviewKeys(body: string): Set<string> {
  const out = new Set<string>();
  const re = /<!--\s*sp:link-preview\s+([0-9a-f]{8})\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1].toLowerCase());
  return out;
}

/** Every http(s) URL in a note body, in order, de-duplicated by cache key.
 *
 *  Skips anything inside an existing preview callout. Without that, enriching
 *  a note twice would find the URLs in its OWN output and preview them again —
 *  previews of previews, growing on every run. */
export function extractUrls(body: string): string[] {
  // Drop our own blocks first: a callout runs from its marker line until the
  // first line that isn't a quote.
  const stripped = body.replace(
    /^>\s*\[![^\]]+\][^\n]*\n(?:>[^\n]*\n?)*/gm,
    (block) => (/sp:link-preview/.test(block) ? "" : block),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  // Trailing punctuation is excluded from the match: a URL at the end of a
  // sentence would otherwise carry the full stop into the request.
  const re = /https?:\/\/[^\s<>"'`\])]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** Render one preview as an Obsidian callout.
 *
 *  EXPANDED by default (`+`, which is foldable but starts open). 0.264.0
 *  shipped `-` on the reasoning that a note with several links would otherwise
 *  be mostly preview — but that hides the description, which is the entire
 *  point of capturing it. Measured: `-` renders the content with
 *  `is-collapsed` and `display: none`, so the text is there and invisible on
 *  every platform. Collapsing is now opt-in.
 *
 *  Every line is quote-prefixed, including blank ones, or the callout ends
 *  early and the rest of the description leaks into the note as ordinary
 *  text. */
export function renderPreviewCallout(
  entry: PreviewEntry, opts: { calloutType?: string; collapsed?: boolean } = {},
): string {
  const type = opts.calloutType || "info";
  const fold = opts.collapsed ? "-" : "+";
  const m = entry.meta;
  const q = (s: string): string => s.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");

  if (!entry.ok || !m) {
    return [
      `> [!${type}]${fold} Link preview unavailable`,
      `> ${previewMarker(entry.url)}`,
      `> ${entry.url}`,
      `> _${entry.reason ?? "could not be fetched"}_`,
    ].join("\n");
  }

  const title = m.title || m.url;
  const lines: string[] = [
    `> [!${type}]${fold} ${title.replace(/\n/g, " ")}`,
    `> ${previewMarker(entry.url)}`,
    `> [${title.replace(/[[\]]/g, "")}](${m.canonicalUrl || m.url})`,
  ];
  const facts = [m.siteName, m.author, m.published].filter(Boolean).join(" · ");
  if (facts) lines.push(`> ${facts}`);
  if (m.description) { lines.push(">"); lines.push(q(m.description)); }
  return lines.join("\n");
}

/** Swap the existing preview block for this URL with fresh markdown.
 *
 *  Only used by the explicit refresh action. A callout runs from its
 *  `> [!type]` opening line until the first line that is not a quote, so the
 *  block is identified by finding the one containing this URL's marker and
 *  replacing exactly that span — never a neighbouring preview, and never any
 *  of the user's own text between them.
 *
 *  Returns the body unchanged when there is no existing block, so the caller
 *  can fall through to appending. */
export function replacePreview(body: string, url: string, markdown: string): string {
  const key = urlKey(url);
  const blockRe = /^>\s*\[![^\]]+\][^\n]*\n(?:>[^\n]*\n?)*/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) !== null) {
    if (!new RegExp(`sp:link-preview\\s+${key}\\b`, "i").test(m[0])) continue;
    const trailingNewline = m[0].endsWith("\n") ? "\n" : "";
    return body.slice(0, m.index) + markdown + trailingNewline + body.slice(m.index + m[0].length);
  }
  return body;
}

/** Append preview blocks to a note body, skipping URLs that already have one.
 *
 *  WRITE-ONCE by design: a link that already carries a preview is left exactly
 *  as it is, because the user is expected to correct these by hand and a
 *  regenerating writer would eat those edits. Refreshing is a separate,
 *  explicit action. */
export function appendPreviews(body: string, blocks: { url: string; markdown: string }[]): string {
  const have = existingPreviewKeys(body);
  const fresh = blocks.filter((b) => !have.has(urlKey(b.url)));
  if (!fresh.length) return body;
  const sep = body.endsWith("\n") ? (body.endsWith("\n\n") ? "" : "\n") : "\n\n";
  return body + sep + fresh.map((b) => b.markdown).join("\n\n") + "\n";
}
