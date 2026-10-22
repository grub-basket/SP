/* Pure tests for src/focus-time.ts */
import {
  dayKey, normFocusDate, formatLogDuration, formatLogEntry, parseLogEntry, logList,
  logSeconds, spentMinutes, formatSpent, formatClock, breakLengthMs, displayMs, phaseElapsed,
  appendLogEntry, phaseLength, TIME_LOG_KEY, TIME_SPENT_KEY, type FocusTimerState,
} from "../../src/focus-time";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const t = new Date(2026, 9, 21, 14, 5, 30).getTime(); // local 2026-10-21 14:05:30
__eq(dayKey(t), "2026-10-21", "dayKey is the local day");
__eq(normFocusDate("2026-10-21"), "2026-10-21", "string date");
__eq(normFocusDate(" 2026-10-21T09:00 "), "2026-10-21", "datetime string trims to the day");
__eq(normFocusDate(new Date(2026, 0, 2)), "2026-01-02", "Date object");
__eq(normFocusDate("today"), null, "non-date string");
__eq(normFocusDate(5), null, "number");

__eq(formatLogDuration(40), "+40s", "under a minute keeps seconds");
__eq(formatLogDuration(25 * 60), "+25m", "minutes");
__eq(formatLogDuration(62 * 60 + 20), "+1h 2m", "hours + minutes");
__eq(formatLogDuration(89), "+1m", "rounds to the minute past 60s");
__eq(formatLogEntry(t, 1500), "2026-10-21 14:05 +25m", "full entry");

__eq(parseLogEntry("2026-10-21 14:05 +25m"), { day: "2026-10-21", seconds: 1500 }, "parse minutes");
__eq(parseLogEntry("2026-10-21 14:05 +1h 2m"), { day: "2026-10-21", seconds: 3720 }, "parse h+m");
__eq(parseLogEntry("2026-10-21 +1h2m30s"), { day: "2026-10-21", seconds: 3750 }, "no time, packed units");
__eq(parseLogEntry("2026-10-21T14:05:00 + 40s"), { day: "2026-10-21", seconds: 40 }, "ISO-ish + spaced");
__eq(parseLogEntry("2026-10-21 14:05 +1.5h"), { day: "2026-10-21", seconds: 5400 }, "decimal hours");
__eq(parseLogEntry("worked a bit"), null, "junk");
__eq(parseLogEntry("2026-10-21 14:05"), null, "no duration");
__eq(parseLogEntry(42), null, "non-string");
// Round-trip: whatever we write, we read back.
for (const s of [5, 59, 60, 600, 3599, 3600, 7322]) {
  const p = parseLogEntry(formatLogEntry(t, s));
  __assert(!!p && Math.abs(p.seconds - s) <= 30, `round-trip ${s}s`);
}

__eq(logList("2026-10-21 +5m"), ["2026-10-21 +5m"], "single string is one entry");
__eq(logList(["a", 3, "b"]), ["a", "b"], "non-strings dropped");
__eq(logList(undefined), [], "missing");
const log = ["2026-10-20 09:00 +30m", "2026-10-21 14:05 +25m", "junk", "2026-10-21 15:00 +40s"];
__eq(logSeconds(log), 1800 + 1500 + 40, "total ignores junk");
__eq(logSeconds(log, "2026-10-21"), 1540, "per-day");
__eq(spentMinutes(log), 56, "timeSpent minutes rounded");

__eq(formatSpent(0), "0m", "zero");
__eq(formatSpent(40), "40s", "seconds");
__eq(formatSpent(1540), "25m", "minutes floor");
__eq(formatSpent(3720), "1h 2m", "hours");
__eq(formatClock(25 * 60_000), "25:00", "clock");
__eq(formatClock(3723_000), "1:02:03", "clock past an hour");
__eq(formatClock(-5), "00:00", "never negative");

const cfg = { workMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
__eq(breakLengthMs(1, cfg), 5 * 60_000, "short break");
__eq(breakLengthMs(4, cfg), 15 * 60_000, "long break every 4th");
__eq(breakLengthMs(8, cfg), 15 * 60_000, "long break every 4th (8)");
__eq(breakLengthMs(4, { ...cfg, longEvery: 0 }), 5 * 60_000, "longEvery 0 = never");

const st: FocusTimerState = {
  folder: "F", id: "x", path: "F/x.md", title: "X", mode: "pomodoro", phase: "work",
  running: true, segStart: 1000, elapsedMs: 60_000, rounds: 0, breakMs: 0,
};
__eq(phaseElapsed(st, 31_000), 90_000, "elapsed = banked + running segment");
__eq(displayMs(st, cfg, 31_000), 25 * 60_000 - 90_000, "pomodoro counts down");
__eq(displayMs({ ...st, mode: "stopwatch" }, cfg, 31_000), 90_000, "stopwatch counts up");
__eq(displayMs({ ...st, running: false }, cfg, 999_999), 25 * 60_000 - 60_000, "paused doesn't move");
__eq(displayMs({ ...st, phase: "break", breakMs: 300_000, elapsedMs: 0 }, cfg, 1000), 300_000, "break counts down from breakMs");
__eq(displayMs({ ...st, elapsedMs: 99 * 60_000 }, cfg, 1000), 0, "overrun clamps to 0");

// appendLogEntry never drops what it can't parse (a user's own entries).
__eq(appendLogEntry(["a", 5, { x: 1 }], "e"), ["a", 5, { x: 1 }, "e"], "non-strings kept");
__eq(appendLogEntry(undefined, "e"), ["e"], "missing log");
__eq(appendLogEntry("", "e"), ["e"], "empty string log");
__eq(appendLogEntry("old", "e"), ["old", "e"], "single string becomes a list");
__eq(appendLogEntry(7, "e"), [7, "e"], "scalar kept");
// Keys are Focus-namespaced (generic timeSpent/timeLog may be the user's own).
__eq([TIME_LOG_KEY, TIME_SPENT_KEY], ["focusLog", "focusMinutes"], "namespaced keys");
// A pomodoro's length is fixed when it starts: changing the setting mid-phase
// doesn't shorten (and strand) the running one.
__eq(phaseLength({ ...st, workMs: 25 * 60_000 }, { ...cfg, workMin: 15 }), 25 * 60_000, "workMs wins over cfg");
__eq(phaseLength({ ...st, workMs: 0 }, { ...cfg, workMin: 15 }), 15 * 60_000, "no workMs → cfg");
__eq(phaseLength({ ...st, mode: "stopwatch", workMs: 25 * 60_000 }, cfg), null, "stopwatch open-ended");
