// Due-date "warmth" for list rows: the row's timestamp slot shows the due date
// when a note has one, tinted warmer as the deadline approaches and red once
// it's past. Pure helpers so the tiering is testable without a view.

import { formatDateOnly, formatTimeOnly, type DateDisplayPrefs } from "./format";

/** later = >7d out (neutral) · week = ≤7d (yellow) · soon = ≤48h (orange) ·
 *  today = due today / <12h (red-orange) · overdue = past (red) ·
 *  stale = >7d past (deep red, filled). */
export type DueTier = "later" | "week" | "soon" | "today" | "overdue" | "stale";

export interface DueInfo {
  ms: number;
  /** A bare `YYYY-MM-DD` — no time component; counts as due at END of that day. */
  dateOnly: boolean;
}

const DAY = 86_400_000;
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `due` written as a bare `YYYY-MM-DD` (no time). */
export function isBareDateDue(raw: unknown): boolean {
  return typeof raw === "string" && BARE_DATE.test(raw.trim());
}

/** Drop-in for `Date.parse` on a `due` string: a bare `YYYY-MM-DD` is LOCAL
 *  midnight of that day. `Date.parse` reads it as UTC midnight, which lands on
 *  the previous evening for anyone west of Greenwich — a task due "2026-09-23"
 *  was reminding as "Sep 22, 5:00 PM". Anything with a time is unchanged. */
export function parseDueString(raw: string): number {
  const s = raw.trim();
  const m = BARE_DATE.exec(s);
  if (!m) return Date.parse(s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Parse a "HH:mm" (24h) setting value; falls back to 07:00 when malformed. */
export function parseHHMM(v: unknown): { h: number; m: number } {
  const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
  const h = m ? Number(m[1]) : NaN, mm = m ? Number(m[2]) : NaN;
  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59 ? { h, m: mm } : { h: 7, m: 0 };
}

/** When a reminder for this due should fire. A timed due fires at its time; a
 *  bare date fires at the configured time-of-day ON that date (default 07:00),
 *  rather than at midnight. Built from calendar parts so a DST day stays right. */
export function reminderAtMs(dueMs: number, raw: unknown, timeOfDay: unknown): number {
  if (!isBareDateDue(raw)) return dueMs;
  const d = new Date(dueMs);
  const { h, m } = parseHHMM(timeOfDay);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

/** The last millisecond of `ms`'s local calendar day. Built from calendar
 *  parts, NOT `+ 24h` — a DST day is 23 or 25 hours long, and `+ DAY - 1` made
 *  a date-only task overdue at 23:00 on the autumn change / still "today" at
 *  00:59 the next day in spring. */
export function endOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

/** When a due actually lapses: a bare date is on time for the whole of that
 *  day, so it's overdue only once the day is over. */
export function dueDeadlineMs(dueMs: number, raw: unknown): number {
  return isBareDateDue(raw) ? endOfLocalDay(dueMs) : dueMs;
}

/** `YYYY-MM-DD` of `ms`'s LOCAL calendar day. */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** The value to write for a due that replaces `prevRaw` (a recurrence roll, a
 *  skip, a snooze-to-next): a date-only due stays date-only (`YYYY-MM-DD` of the
 *  new day), anything else is an ISO timestamp as before. Writing an ISO for a
 *  rolled bare date turned "due Oct 6" into "due Oct 7 12:00 AM" after one cycle
 *  — reminding at midnight and going overdue at the start of the day. */
export function nextDueValue(prevRaw: unknown, nextMs: number): string {
  return isBareDateDue(prevRaw) ? localDateString(nextMs) : new Date(nextMs).toISOString();
}

/** Parse a frontmatter `due` the same way task-collect does, except a bare
 *  date is read as LOCAL midnight (Date.parse would make it UTC midnight,
 *  which shifts it a day for anyone west of Greenwich). */
export function parseDue(raw: unknown): DueInfo | null {
  if (typeof raw === "number") {
    // Raw epoch ms only — a small number is a year or junk, not a date.
    return Number.isFinite(raw) && raw >= 1e11 ? { ms: raw, dateOnly: false } : null;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = parseDueString(raw);
  return Number.isNaN(t) ? null : { ms: t, dateOnly: isBareDateDue(raw) };
}

function startOfDay(ms: number): number {
  const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime();
}

export function dueTier(due: DueInfo, now = Date.now()): DueTier {
  // A date-only due is "on time" for the whole of that day.
  const deadline = due.dateOnly ? endOfLocalDay(due.ms) : due.ms;
  const left = deadline - now;
  if (left < 0) return -left > 7 * DAY ? "stale" : "overdue";
  if (startOfDay(due.ms) === startOfDay(now) || left < 12 * 3_600_000) return "today";
  if (left <= 2 * DAY) return "soon";
  if (left <= 7 * DAY) return "week";
  return "later";
}

/** Short label: time only when it falls today (and has a time), else the
 *  date — plus the time on `withTime` (desktop has room for a second line). */
export function dueLabel(due: DueInfo, prefs: DateDisplayPrefs, withTime: boolean, now = Date.now()): string {
  const today = startOfDay(due.ms) === startOfDay(now);
  if (today) return due.dateOnly ? "Today" : `Today ${formatTimeOnly(due.ms, prefs)}`;
  const date = formatDateOnly(due.ms, prefs);
  return withTime && !due.dateOnly ? `${date} ${formatTimeOnly(due.ms, prefs)}` : date;
}

/** Human "in 3 days" / "2 hours ago" for the tooltip. */
export function dueRelative(due: DueInfo, now = Date.now()): string {
  const deadline = due.dateOnly ? endOfLocalDay(due.ms) : due.ms;
  const diff = deadline - now;
  const abs = Math.abs(diff);
  const unit = abs >= DAY ? [Math.round(abs / DAY), "day"] as const
    : abs >= 3_600_000 ? [Math.round(abs / 3_600_000), "hour"] as const
    : [Math.max(1, Math.round(abs / 60_000)), "minute"] as const;
  const txt = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`;
  return diff < 0 ? `${txt} overdue` : `in ${txt}`;
}
