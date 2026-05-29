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

/** Safe wrapper — a bad IANA name in Intl throws; fall back to the
 *  system zone rather than crash the render. */
function fmt(ms: number, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
  } catch {
    const { timeZone, ...rest } = opts;
    void timeZone;
    return new Intl.DateTimeFormat(undefined, rest).format(new Date(ms));
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
      return fmt(ms, { ...tz, dateStyle: "full", timeStyle: "short" } as Intl.DateTimeFormatOptions);
    case "locale":
    default:
      return fmt(ms, { ...tz, dateStyle: "medium", timeStyle: "short" } as Intl.DateTimeFormatOptions);
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
      return fmt(ms, { ...tz, dateStyle: "full" } as Intl.DateTimeFormatOptions);
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...tz, year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  if (!withTime) return date;
  return `${date} ${get("hour")}:${get("minute")}`;
}
