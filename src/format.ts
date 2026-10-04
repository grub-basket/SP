/** 0.76.6: shared date/time formatting honouring the user's chosen
 *  display format + timezone (Tasks panel due labels, detail panel
 *  metadata, etc.). Built on Intl.DateTimeFormat so a timezone
 *  override works natively without bundling moment-timezone. */

export type DateDisplayFormat = "locale" | "iso" | "us" | "eu" | "long";

export interface DateDisplayPrefs {
  /** Display format key. Default "locale". */
  dateDisplayFormat?: DateDisplayFormat;
  /** IANA timezone name (e.g. "America/New_York"). Empty/undefined =
   *  the system timezone. */
  dateDisplayTimezone?: string;
}

function tzOpt(prefs: DateDisplayPrefs): { timeZone?: string } {
  const tz = (prefs.dateDisplayTimezone || "").trim();
  if (!tz) return {};
  return { timeZone: tz };
}

/** 0.518.1 (perf scan P34): reuse DateTimeFormat objects. Building one
 *  is the costly part, and list rows / task panels format a date per row.
 *  Keyed by locale + the exact options, so a hit was built from the same
 *  arguments a fresh call would use. A formatter with no explicit
 *  timeZone fixes the device zone when built, so the whole cache is
 *  dropped when the device's zone changes (travel, OS zone change
 *  without a restart): checked per call by its January/July offsets and
 *  by name via deviceZoneSig(). Stored only after the constructor
 *  returns, so a bad IANA name throws on every call exactly as before.
 *  Cleared at 64 entries (normal use needs about a dozen per zone). */
const DTF_CACHE_MAX = 64;
const dtfCache = new Map<string, Intl.DateTimeFormat>();
let dtfCacheTzSig = "";

/** 0.518.1: the device zone NAME (+ default locale), read once per
 *  synchronous run and forgotten at the next microtask. Offsets alone
 *  miss zones that match today but differed in the past (Los Angeles ->
 *  Tijuana showed a 2009 note an hour off until restart). The OS zone
 *  only changes between tasks, so a value read earlier in the same run
 *  is still current. Costs one bare constructor per render, not per row. */
let deviceZoneMemo: string | null = null;

function deviceZoneSig(): string {
  if (deviceZoneMemo === null) {
    const r = new Intl.DateTimeFormat().resolvedOptions();
    deviceZoneMemo = `${r.locale}|${r.timeZone}`;
    queueMicrotask(() => { deviceZoneMemo = null; });
  }
  return deviceZoneMemo;
}

function cachedDtf(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const y = new Date().getFullYear();
  const sig = `${new Date(y, 0, 1).getTimezoneOffset()}/${new Date(y, 6, 1).getTimezoneOffset()}|${deviceZoneSig()}`;
  if (sig !== dtfCacheTzSig) {
    dtfCache.clear();
    dtfCacheTzSig = sig;
  }
  const key = `${locale ?? ""}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    if (dtfCache.size >= DTF_CACHE_MAX) dtfCache.clear();
    dtfCache.set(key, f);
  }
  return f;
}

/** Safe wrapper — a bad IANA name in Intl throws; fall back to the
 *  system zone rather than crash the render. */
function fmt(ms: number, opts: Intl.DateTimeFormatOptions): string {
  try {
    return cachedDtf(undefined, opts).format(new Date(ms));
  } catch {
    const { timeZone, ...rest } = opts;
    void timeZone;
    return cachedDtf(undefined, rest).format(new Date(ms));
  }
}

/** Full date + time, per the user's format + timezone prefs. */
export function formatDateTime(ms: number, prefs: DateDisplayPrefs): string {
  const tz = tzOpt(prefs);
  switch (prefs.dateDisplayFormat ?? "locale") {
    case "iso":
      // YYYY-MM-DD HH:mm in the chosen zone.
      return formatIso(ms, prefs, true);
    case "us":
      return fmt(ms, { ...tz, month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    case "eu":
      return fmt(ms, { ...tz, day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    case "long":
      return fmt(ms, { ...tz, dateStyle: "full", timeStyle: "short" });
    case "locale":
    default:
      return fmt(ms, { ...tz, dateStyle: "medium", timeStyle: "short" });
  }
}

/** Date only (no time) — used for due labels outside today. */
export function formatDateOnly(ms: number, prefs: DateDisplayPrefs): string {
  const tz = tzOpt(prefs);
  switch (prefs.dateDisplayFormat ?? "locale") {
    case "iso":
      return formatIso(ms, prefs, false);
    case "us":
      return fmt(ms, { ...tz, month: "numeric", day: "numeric", year: "numeric" });
    case "eu":
      return fmt(ms, { ...tz, day: "numeric", month: "numeric", year: "numeric" });
    case "long":
      return fmt(ms, { ...tz, dateStyle: "full" });
    case "locale":
    default: {
      // Drop the year when it's the current year for compactness.
      const now = new Date();
      const sameYear = new Date(ms).getFullYear() === now.getFullYear();
      return fmt(ms, sameYear
        ? { ...tz, month: "short", day: "numeric" }
        : { ...tz, month: "short", day: "numeric", year: "numeric" });
    }
  }
}

/** Time only — used for due labels that fall on today. */
export function formatTimeOnly(ms: number, prefs: DateDisplayPrefs): string {
  const tz = tzOpt(prefs);
  const h23 = prefs.dateDisplayFormat === "iso" || prefs.dateDisplayFormat === "eu";
  return fmt(ms, { ...tz, hour: h23 ? "2-digit" : "numeric", minute: "2-digit", ...(h23 ? { hourCycle: "h23" } : {}) });
}

/** ISO-ish "YYYY-MM-DD" (+ " HH:mm" when withTime), rendered in the
 *  chosen timezone. Built from Intl parts so the zone applies. */
function formatIso(ms: number, prefs: DateDisplayPrefs, withTime: boolean): string {
  const tz = tzOpt(prefs);
  const parts = cachedDtf("en-CA", {
    ...tz, year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  if (!withTime) return date;
  return `${date} ${get("hour")}:${get("minute")}`;
}
