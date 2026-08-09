import { requestUrl } from "obsidian";
import { extractLinkMeta, type LinkMeta } from "./parse-og";

/** Outcome of one fetch. Never throws — a link that fails is a normal,
 *  recordable state (the cache stores failures so a backfill doesn't retry a
 *  dead domain on every sweep). */
export type FetchResult =
  | { ok: true; meta: LinkMeta; httpStatus: number; bytes: number }
  | { ok: false; reason: string; httpStatus?: number };

/** Ceiling on what we PARSE when a page has no `</head>` to cut at.
 *
 *  Note this saves no bandwidth: requestUrl has already downloaded the whole
 *  body by the time we see it, so a smaller cap only ever means finding less.
 *  An earlier 512KB value did exactly that — YouTube's watch page is ~1.35MB
 *  with enormous inline scripts ahead of its og tags, so the cap sliced the
 *  head off mid-way and the extractor reported "no metadata" for a page that
 *  had plenty. Cutting at `</head>` is the real fix; this is the fallback for
 *  malformed pages that never close it. */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

/** Metadata lives in the head. Slicing there means a 20MB page costs one
 *  indexOf rather than a 20MB regex sweep, and no size guess is involved. */
export function headRegion(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  if (end > 0) return html.slice(0, end);
  return html.length > MAX_PARSE_BYTES ? html.slice(0, MAX_PARSE_BYTES) : html;
}

/** requestUrl has no timeout of its own, so a hung host would hang the sweep
 *  forever. Raced against a timer instead. */
const TIMEOUT_MS = 15_000;

/** A real browser UA. Not cloaking — many sites serve no OG tags at all to an
 *  unrecognised agent, which would make the feature look broken for reasons
 *  that have nothing to do with the code. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** True for URLs worth fetching. Rejects anything that isn't http(s) — a
 *  `file:` or `obsidian:` URL in a note must never be dereferenced, and
 *  javascript: least of all. */
export function isFetchableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

/** Fetch a URL and extract its metadata.
 *
 *  `requestUrl` rather than `fetch` deliberately: it bypasses CORS on BOTH
 *  desktop and mobile, and on iOS plain fetch runs from a
 *  `capacitor://localhost` origin that most hosts reject. This is the reason
 *  the whole feature can live in the plugin instead of a server. */
export async function fetchLinkMeta(url: string): Promise<FetchResult> {
  if (!isFetchableUrl(url)) return { ok: false, reason: "not an http(s) URL" };

  let res: { status: number; text: string; headers: Record<string, string> };
  try {
    res = await Promise.race([
      requestUrl({
        url,
        method: "GET",
        headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
        // We handle non-2xx ourselves — the default throws, which would turn a
        // recordable 404 into an exception the caller has to unpick.
        throw: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
    ]);
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "request failed" };
  }

  if (res.status >= 400) return { ok: false, reason: `HTTP ${res.status}`, httpStatus: res.status };

  // Content-Type is checked BEFORE touching the body: a PDF or a video would
  // otherwise be run through an HTML regex, which is pointless work on a big
  // buffer and could produce nonsense "titles" from binary noise.
  const ctype = (res.headers?.["content-type"] ?? res.headers?.["Content-Type"] ?? "").toLowerCase();
  if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
    return { ok: false, reason: `not HTML (${ctype.split(";")[0]})`, httpStatus: res.status };
  }

  const html = res.text ?? "";
  const bytes = html.length;
  const meta = extractLinkMeta(url, headRegion(html));
  if (!meta.title && !meta.description) {
    return { ok: false, reason: "no metadata found on the page", httpStatus: res.status };
  }
  return { ok: true, meta, httpStatus: res.status, bytes };
}

/** Stable key for a URL, used as the cache filename.
 *
 *  Normalised first so the same page fetched with different tracking junk maps
 *  to one entry: lowercase host, drop the fragment, strip the usual tracking
 *  parameters (utm_ prefixed, fbclid, gclid and friends), and sort what
 *  remains so parameter order stops mattering. Deliberately does
 *  NOT strip every query parameter — `?v=` IS the identity of a YouTube video. */
export function urlKey(raw: string): string {
  let normalised = raw.trim();
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const drop = [...u.searchParams.keys()].filter((k) =>
      /^utm_/i.test(k) || /^(fbclid|gclid|mc_cid|mc_eid|igshid|si)$/i.test(k));
    for (const k of drop) u.searchParams.delete(k);
    u.searchParams.sort();
    normalised = u.toString().replace(/\/$/, "");
  } catch { /* unparseable — hash the raw string rather than dropping it */ }

  // FNV-1a, 32-bit, hex. Not cryptographic and doesn't need to be: this names
  // a cache file. Collisions are handled by storing the URL inside the entry
  // and comparing on read.
  let h = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i++) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
