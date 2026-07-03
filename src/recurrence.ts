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
function nextWeekday(from: number, targetDow: number): number {
  const d = new Date(from);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== targetDow);
  return d.getTime();
}
function nextBusinessDay(from: number): number {
  const d = new Date(from);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}

/** Parse a recurrence rule. Understood forms (case-insensitive, "every"
 *  optional): "daily" / "every day" / "every 3 days"; "weekly" / "every week" /
 *  "every 2 weeks"; "every weekday"; "every monday"; "monthly" / "every month" /
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
  // weekday name(s) — single weekday only for v1
  const dow = WEEKDAYS.indexOf(s.replace(/s$/, ""));
  if (dow >= 0) return mk((from) => nextWeekday(from, dow), `every ${WEEKDAYS[dow]}`);
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
