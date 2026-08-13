import { TFile, type App } from "obsidian";
import { fetchLinkMeta } from "./fetch";
import {
  PreviewCache, PREVIEW_SCHEMA_VERSION, appendPreviews, extractUrls,
  existingPreviewKeys, renderPreviewCallout, replacePreview, type PreviewEntry,
} from "./store";
import { urlKey } from "./fetch";

export interface EnrichResult {
  added: number;
  /** Already had a preview — left untouched (write-once). */
  skipped: number;
  failed: number;
  /** Served from cache rather than refetched. */
  cached: number;
}

export interface EnrichOptions {
  calloutType?: string;
  collapsed?: boolean;
  /** Refetch and REPLACE existing previews. Off by default: the user is
   *  expected to correct these by hand, and a refresh must be asked for. */
  force?: boolean;
  /** Politeness delay between network fetches. */
  delayMs?: number;
  signal?: { cancelled: boolean };
}

/** Strip the note's frontmatter for scanning, so a URL that only appears in
 *  frontmatter (an `attachments` path, a source field) isn't previewed —
 *  frontmatter is Stashpad's bookkeeping, not the user's prose. */
function bodyOf(raw: string): { body: string; head: string } {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(raw);
  return m ? { head: m[0], body: raw.slice(m[0].length) } : { head: "", body: raw };
}

/** Add previews for every un-previewed link in one note. */
export async function enrichFile(
  app: App, cache: PreviewCache, file: TFile, opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const out: EnrichResult = { added: 0, skipped: 0, failed: 0, cached: 0 };
  const raw = await app.vault.read(file);
  const { body } = bodyOf(raw);
  const urls = extractUrls(body);
  if (!urls.length) return out;

  const have = existingPreviewKeys(body);
  const blocks: { url: string; markdown: string }[] = [];

  for (const url of urls) {
    if (opts.signal?.cancelled) break;
    if (!opts.force && have.has(urlKey(url))) { out.skipped++; continue; }

    let entry = await cache.read(url);
    if (entry && !opts.force && cache.isFresh(entry)) {
      out.cached++;
    } else {
      const res = await fetchLinkMeta(url);
      entry = res.ok
        ? { v: PREVIEW_SCHEMA_VERSION, url, fetchedAt: new Date().toISOString(), ok: true,
            httpStatus: res.httpStatus, meta: res.meta }
        : { v: PREVIEW_SCHEMA_VERSION, url, fetchedAt: new Date().toISOString(), ok: false,
            httpStatus: res.httpStatus, reason: res.reason };
      await cache.write(entry);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    }

    // Failures get a block too, deliberately. The user is expected to correct
    // these by hand, so a stub saying "couldn't fetch — HTTP 403" next to the
    // link is more useful than silence: it is somewhere to type the title in,
    // and it records that the link WAS tried.
    if (!entry.ok) out.failed++;
    blocks.push({ url, markdown: renderPreviewCallout(entry, { calloutType: opts.calloutType, collapsed: opts.collapsed }) });
  }

  if (!blocks.length) return out;

  // Re-read immediately before writing. Enrichment is slow (a network round
  // trip per link) and the user may well have edited the note while it ran —
  // writing the body we read minutes ago would silently discard that.
  const currentRaw = await app.vault.read(file);
  const cur = bodyOf(currentRaw);
  let nextBody = cur.body;
  // On a forced refresh, blocks that already exist are REPLACED in place;
  // anything genuinely new still gets appended. Without this pass, force would
  // refetch and then write nothing, because appendPreviews filters out URLs
  // that already carry a marker.
  const stillToAppend: typeof blocks = [];
  for (const b of blocks) {
    const replaced = opts.force ? replacePreview(nextBody, b.url, b.markdown) : nextBody;
    if (replaced !== nextBody) { nextBody = replaced; out.added++; }
    else stillToAppend.push(b);
  }
  nextBody = appendPreviews(nextBody, stillToAppend);
  if (nextBody === cur.body) return out;
  out.added += stillToAppend.filter((b) => nextBody.includes(b.markdown)).length;
  await app.vault.modify(file, cur.head + nextBody);
  return out;
}

export interface BackfillScan {
  files: TFile[];
  /** Un-previewed links across those files. */
  linkCount: number;
  /** How many of those already have a usable cache entry (so cost ~0). */
  cachedCount: number;
}

/** Count the work WITHOUT fetching anything, so the estimate shown to the user
 *  is derived rather than guessed. Reads note bodies only. */
export async function scanBackfill(
  app: App, cache: PreviewCache, files: TFile[],
  signal?: { cancelled: boolean },
): Promise<BackfillScan> {
  const out: BackfillScan = { files: [], linkCount: 0, cachedCount: 0 };
  for (const f of files) {
    if (signal?.cancelled) break;
    let raw = "";
    try { raw = await app.vault.cachedRead(f); } catch { continue; }
    const { body } = bodyOf(raw);
    const urls = extractUrls(body);
    if (!urls.length) continue;
    const have = existingPreviewKeys(body);
    const todo = urls.filter((u) => !have.has(urlKey(u)));
    if (!todo.length) continue;
    out.files.push(f);
    out.linkCount += todo.length;
    for (const u of todo) {
      if (cache.isFresh(await cache.read(u))) out.cachedCount++;
    }
  }
  return out;
}

/** Seconds a backfill will plausibly take.
 *
 *  Cached links cost nothing; the rest cost a round trip plus the politeness
 *  delay. Deliberately pessimistic — an estimate that undershoots is worse than
 *  one that overshoots, because the user has already agreed to wait by then. */
export function estimateSeconds(scan: BackfillScan, delayMs: number, perFetchMs = 1200): number {
  const toFetch = Math.max(0, scan.linkCount - scan.cachedCount);
  return Math.ceil((toFetch * (perFetchMs + delayMs)) / 1000);
}

export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60), rem = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rem ? ` ${rem} min` : ""}`;
}
