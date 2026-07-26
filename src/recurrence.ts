/** 0.140.0: recurring + persistent reminders. Hand-rolled (no rrule dep) parser
 *  for the natural-language recurrence patterns people actually type, plus the
 *  duration parser the auto-complete / persistent-reminder features share.
 *
 *  Frontmatter contract (all optional, on any task note):
 *   - `repeat`:  a recurrence rule string (see parseRecurrence). A trailing
 *                "when done" anchors the next occurrence to the COMPLETION time
 *                instead of the due time (toothbrush-every-30-days case).
 *   - `autoDoneAfter`: a duration ("1h" / "2d" / "30m"). Once the task is this
 *                long past due, it auto-marks complete (un-failable tasks).
 *   - `remindEvery`:   a duration. Re-notify this often until done (persistent).
 */

const UNIT_MS: Record<string, number> = {
  min: 60_000, minute: 60_000, m: 60_000,
  h: 3_600_000, hr: 3_600_000, hour: 3_600_000,
  d: 86_400_000, day: 86_400_000,
  w: 604_800_000, wk: 604_800_000, week: 604_800_000,
};

/** "30m" / "2 hours" / "1d" / "90 min" → milliseconds. null if unparseable. */
export function parseDuration(s: string | number | null | undefined): number | null {
  if (typeof s === "number") return s > 0 ? s : null;
  if (!s) return null;
  const m = String(s).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "min").replace(/s$/, "");
  const ms = UNIT_MS[unit];
  return ms && n > 0 ? n * ms : null;
}

type Anchor = "due" | "completion";
export interface Recurrence {
  /** Advance `from` (ms) to the next occurrence AFTER it. */
  next: (from: number) => number;
  /** "when done" → anchor the roll to the completion time, not the old due. */
  anchor: Anchor;
  /** Human echo of what we parsed, for confirmation UI. */
  label: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  // Clamp end-of-month overflow (Jan 31 + 1mo → Feb 28/29, not Mar 3).
  if (d.getDate() < day) d.setDate(0);
  return d.getTime();
}
function addYears(ms: number, n: number): number {
  const d = new Date(ms); d.setFullYear(d.getFullYear() + n); return d.getTime();
}
/** 0.203.0: short + initial forms, for the day-picker UI and rule labels. */
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_INITIAL = ["S", "M", "T", "W", "T", "F", "S"];

/** Every spelling of a weekday we accept in a rule → its index. */
const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, su: 0, sunday: 0,
  mon: 1, mo: 1, monday: 1,
  tue: 2, tues: 2, tu: 2, tuesday: 2,
  wed: 3, weds: 3, we: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, th: 4, thursday: 4,
  fri: 5, fr: 5, friday: 5,
  sat: 6, sa: 6, saturday: 6,
};

/** Parse "monday" / "mon, wed & fri" / "tue/thu" into sorted day indices.
 *  Returns null unless EVERY token is a weekday — so "weekday", "3 days" and
 *  other rules fall through to their own branches untouched. */
export function parseWeekdayList(s: string | null | undefined): number[] | null {
  const raw = String(s ?? "").trim().toLowerCase().replace(/^every\s+/, "");
  if (!raw) return null;
  const tokens = raw.split(/\s*(?:,|\/|&|\+|\band\b)\s*/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const days = new Set<number>();
  for (const t of tokens) {
    const key = t.replace(/s$/, ""); // mondays → monday, weds → wed
    const d = WEEKDAY_ALIASES[t] ?? WEEKDAY_ALIASES[key];
    if (d === undefined) return null;
    days.add(d);
  }
  return [...days].sort((a, b) => a - b);
}

/** The next timestamp after `from` landing on one of `days`, keeping the
 *  time-of-day. Works for one day or many (a Mon/Wed/Fri chore hits whichever
 *  comes next). */
function nextInWeekdays(from: number, days: number[]): number {
  const set = new Set(days);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    if (set.has(d.getDay())) return d.getTime();
  }
  return from + UNIT_MS.week; // unreachable while `days` is non-empty
}

/** Rewrite `rule` so it repeats on exactly `days`, preserving a trailing
 *  "when done" anchor. Empty `days` clears a weekday rule (and leaves any
 *  other kind of rule alone). Backs the day-picker in the due modal — the rule
 *  STRING stays the single source of truth, as with the anchor toggle. */
export function withWeekdays(rule: string | null | undefined, days: number[]): string {
  const raw = String(rule ?? "");
  const anchorM = raw.match(/\s*(when done|after completion|on completion|from completion)\s*$/i);
  const body = (anchorM ? raw.slice(0, anchorM.index) : raw).trim();
  const anchor = anchorM ? anchorM[1].trim() : "";
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!sorted.length) return parseWeekdayList(body) ? "" : raw;
  const list = sorted.length === 1
    ? WEEKDAYS[sorted[0]]
    : sorted.map((d) => WEEKDAY_SHORT[d].toLowerCase()).join(", ");
  return anchor ? `every ${list} ${anchor}` : `every ${list}`;
}
function nextBusinessDay(from: number): number {
  const d = new Date(from);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}

/** Parse a recurrence rule. Understood forms (case-insensitive, "every"
 *  optional): "daily" / "every day" / "every 3 days"; "weekly" / "every week" /
 *  "every 2 weeks"; "every weekday"; "every monday"; "every mon, wed & fri"; "monthly" / "every month" /
 *  "every 2 months" / "first of the month"; "yearly" / "every year"; "every N
 *  hours" / "every N minutes". A trailing "when done" / "after completion" sets
 *  the completion anchor. Returns null if nothing matched. */
export function parseRecurrence(rule: string | null | undefined): Recurrence | null {
  if (!rule) return null;
  let s = String(rule).trim().toLowerCase();
  if (!s) return null;
  let anchor: Anchor = "due";
  if (/\b(when done|after completion|on completion|from completion)\b/.test(s)) {
    anchor = "completion";
    s = s.replace(/\b(when done|after completion|on completion|from completion)\b/g, "").trim();
  }
  s = s.replace(/^every\s+/, "").replace(/\s+/g, " ").trim();

  const mk = (next: (from: number) => number, label: string): Recurrence => ({ next, anchor, label });

  // first of the month
  if (/^(first|1st) of (the )?month$/.test(s)) {
    return mk((from) => { const d = new Date(from); d.setMonth(d.getMonth() + 1, 1); return d.getTime(); }, "first of the month");
  }
  // weekday name(s) — one or many ("every monday", "every mon, wed & fri")
  const days = parseWeekdayList(s);
  if (days && days.length) {
    const label = days.length === 1
      ? `every ${WEEKDAYS[days[0]]}`
      : `every ${days.map((d) => WEEKDAY_SHORT[d].toLowerCase()).join(", ")}`;
    return mk((from) => nextInWeekdays(from, days), label);
  }
  if (s === "weekday" || s === "weekdays" || s === "business day" || s === "business days")
    return mk(nextBusinessDay, "every weekday");

  // bare keywords
  if (s === "daily" || s === "day") return mk((f) => f + UNIT_MS.day, "every day");
  if (s === "weekly" || s === "week") return mk((f) => f + UNIT_MS.week, "every week");
  if (s === "monthly" || s === "month") return mk((f) => addMonths(f, 1), "every month");
  if (s === "yearly" || s === "annually" || s === "year") return mk((f) => addYears(f, 1), "every year");
  if (s === "hourly" || s === "hour") return mk((f) => f + UNIT_MS.h, "every hour");

  // "N <unit>"
  const m = s.match(/^(\d+)\s*([a-z]+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].replace(/s$/, "");
    if (n > 0) {
      if (unit === "day") return mk((f) => f + n * UNIT_MS.day, `every ${n} days`);
      if (unit === "week" || unit === "wk") return mk((f) => f + n * UNIT_MS.week, `every ${n} weeks`);
      if (unit === "month" || unit === "mo") return mk((f) => addMonths(f, n), `every ${n} months`);
      if (unit === "year" || unit === "yr") return mk((f) => addYears(f, n), `every ${n} years`);
      if (unit === "hour" || unit === "hr" || unit === "h") return mk((f) => f + n * UNIT_MS.h, `every ${n} hours`);
      if (unit === "min" || unit === "minute" || unit === "m") return mk((f) => f + n * UNIT_MS.min, `every ${n} minutes`);
    }
  }
  return null;
}

/** The next due timestamp for a repeating task being completed now. Rolls from
 *  the completion time (`nowMs`) when anchored "when done", else from the old
 *  due — advancing PAST now so an overdue task doesn't reschedule into the past. */
export function nextDueOnComplete(rec: Recurrence, oldDueMs: number | null, nowMs: number): number {
  const from = rec.anchor === "completion" ? nowMs : (oldDueMs ?? nowMs);
  let next = rec.next(from);
  // Never schedule the next occurrence in the past (missed several cycles).
  let guard = 0;
  while (next <= nowMs && guard++ < 5000) next = rec.next(next);
  // 0.140.1: if we STILL landed in the past (pathological overdue — e.g. an
  // every-5-min task months overdue), advance from NOW so the contract "never
  // returns a past timestamp" always holds and callers don't rewrite the file
  // every poll trying to converge.
  if (next <= nowMs) { next = rec.next(nowMs); let g = 0; while (next <= nowMs && g++ < 5000) next = rec.next(next); }
  return next;
}

/** 0.197.0 — how a repeating task produces its next occurrence.
 *
 *  Until now there was exactly one behaviour: completing a repeating task re-dated
 *  the SAME note and cleared `completed` ("roll forward"). That repeats fine but
 *  leaves no trace — no record you did it last week, no sign you missed three. These
 *  modes add per-occurrence history; `rollForward` stays the default so existing
 *  repeating tasks don't silently change behaviour. */
export type RepeatMode = "rollForward" | "complete" | "interval" | "archive";

export const REPEAT_MODES: Array<{ id: RepeatMode; label: string; desc: string }> = [
  { id: "rollForward", label: "Roll forward (no history)", desc: "One note whose due date moves. Nothing is kept for past occurrences." },
  { id: "complete", label: "Keep each occurrence", desc: "Completing leaves that one done in the list and creates a fresh one for the next interval." },
  { id: "interval", label: "One per interval (mark misses)", desc: "A new occurrence every interval whether or not you finished the last. An unfinished one is closed out and flagged as missed." },
  { id: "archive", label: "Roll forward + archive", desc: "One live note as today, but each completion is archived so the history exists without cluttering the list." },
];

export function parseRepeatMode(v: unknown): RepeatMode {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  for (const m of REPEAT_MODES) if (m.id.toLowerCase() === s) return m.id;
  return "rollForward"; // legacy / unset
}
