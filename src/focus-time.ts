/** 0.577.0: Focus view — the PURE (DOM-free, Obsidian-free) half.
 *
 *  Time tracking lives in each note's frontmatter so it syncs and travels with
 *  the note:
 *
 *    focusDate: "2026-10-21"            ← on the Today list for that day
 *    focusLog:                          ← one entry per tracked work stretch
 *      - "2026-10-21 14:05 +25m"
 *      - "2026-10-21 15:40 +1h 2m"
 *      - "2026-10-21 16:01 +40s"
 *    focusMinutes: 87                   ← total minutes, derived from focusLog
 *
 *  `focusLog` is the source of truth; `focusMinutes` is recomputed from it on
 *  every write so a hand-edited log stays consistent. The keys are Focus-
 *  namespaced on purpose: a generic `timeSpent` / `timeLog` may already be the
 *  user's own property (or another plugin's), and we overwrite the total. Entries are human-readable on
 *  purpose (this is a notes app — the frontmatter is something people read).
 *  Times are LOCAL wall-clock, like everything else the user sees. */

export const FOCUS_DATE_KEY = "focusDate";
/** 0.578.0: a ROLL-FORWARD repeating task ticked while on the Today list isn't
 *  `completed` (it moved to its next due), so this stamp — the day it was done —
 *  is what makes it count as done for that day's list. See task-complete.ts. */
export const FOCUS_DONE_KEY = "focusDone";
/** Every Focus key — stripped from a spawned next occurrence / archive snapshot,
 *  so a copy never lands on today's list or carries the original's time log. */
export const FOCUS_KEYS = ["focusDate", "focusDone", "focusLog", "focusMinutes"] as const;
export const TIME_LOG_KEY = "focusLog";
export const TIME_SPENT_KEY = "focusMinutes";

/** Stretches shorter than this aren't logged — a start/stop mis-tap shouldn't
 *  leave a "+2s" line in the note. */
export const MIN_LOG_SECONDS = 10;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar day as `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Normalise a frontmatter `focusDate` (string, or a Date / number if YAML or
 *  another plugin typed it) to `YYYY-MM-DD`, or null when it isn't one. */
export function normFocusDate(raw: unknown): string | null {
  if (typeof raw === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return dayKey(raw.getTime());
  return null;
}

/** `+1h 2m` / `+25m` / `+40s` — the duration half of a log entry. */
export function formatLogDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `+${s}s`;
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `+${h}h ${m}m` : `+${m}m`;
}

/** One log entry: `YYYY-MM-DD HH:mm +<duration>`. */
export function formatLogEntry(startMs: number, seconds: number): string {
  const d = new Date(startMs);
  return `${dayKey(startMs)} ${pad(d.getHours())}:${pad(d.getMinutes())} ${formatLogDuration(seconds)}`;
}

export interface LogEntry { day: string; seconds: number }

/** Parse one entry. Lenient about spacing and about `1h2m` vs `1h 2m`, so a
 *  hand-edited line still counts; returns null for anything unrecognisable. */
export function parseLogEntry(raw: unknown): LogEntry | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\s*\+\s*((?:\d+(?:\.\d+)?\s*[hms]\s*)+)$/i.exec(raw);
  if (!m) return null;
  let seconds = 0;
  const re = /(\d+(?:\.\d+)?)\s*([hms])/gi;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2])) !== null) {
    const n = parseFloat(p[1]);
    const u = p[2].toLowerCase();
    seconds += u === "h" ? n * 3600 : u === "m" ? n * 60 : n;
  }
  return { day: m[1], seconds };
}

/** The frontmatter log as a string list (a single string is one entry). */
export function logList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string" && raw.trim()) return [raw];
  return [];
}

/** Append an entry to the raw frontmatter log, keeping every existing item —
 *  including anything we can't parse (a hand-written note, a number), which
 *  must never be silently dropped by our rewrite. */
export function appendLogEntry(raw: unknown, entry: string): unknown[] {
  const list: unknown[] = Array.isArray(raw) ? raw.slice() : raw == null || raw === "" ? [] : [raw];
  list.push(entry);
  return list;
}

/** Total seconds in a log, optionally only the entries on `day`. */
export function logSeconds(raw: unknown, day?: string): number {
  let total = 0;
  for (const e of logList(raw)) {
    const p = parseLogEntry(e);
    if (p && (!day || p.day === day)) total += p.seconds;
  }
  return total;
}

/** `focusMinutes` value for a log: whole minutes, rounded. */
export function spentMinutes(raw: unknown): number {
  return Math.round(logSeconds(raw) / 60);
}

/** Compact human duration for the UI: `1h 5m`, `25m`, `40s`, `0m`. */
export function formatSpent(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "0m";
  if (s < 60) return `${s}s`;
  const totalMin = Math.floor(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Clock face: `24:59`, or `1:02:03` past an hour. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// ---- timer state machine ----

export type FocusMode = "pomodoro" | "stopwatch";
export type FocusPhase = "work" | "break";

export interface FocusTimerConfig {
  workMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  /** A long break replaces every Nth short break (0 = never). */
  longEvery: number;
}

/** Persisted (device-local) timer state. `segStart` is set while running;
 *  `elapsedMs` is what the current phase had accrued before that. */
export interface FocusTimerState {
  folder: string;
  id: string;
  path: string;
  title: string;
  mode: FocusMode;
  phase: FocusPhase;
  running: boolean;
  segStart: number | null;
  elapsedMs: number;
  /** Work phases completed in this run (drives the long break). */
  rounds: number;
  /** Length of the break in progress (ms), fixed when the break starts. */
  breakMs: number;
  /** Length of the pomodoro work phase in progress (ms), fixed when it starts,
   *  so changing the setting mid-pomodoro applies to the NEXT one (shortening
   *  it under a running phase used to strand the time already worked). */
  workMs?: number;
  /** Device that owns this timer. history.json is device-local for Obsidian
   *  Sync, but iCloud / Syncthing copy the whole plugin folder — a timer
   *  adopted from another device must not tick (and log) here too. */
  device?: string;
}

export function phaseElapsed(st: FocusTimerState, now: number): number {
  return st.elapsedMs + (st.running && st.segStart != null ? Math.max(0, now - st.segStart) : 0);
}

/** Length of the current phase in ms, or null for an open-ended stopwatch. */
export function phaseLength(st: FocusTimerState, cfg: FocusTimerConfig): number | null {
  if (st.phase === "break") return st.breakMs;
  if (st.mode !== "pomodoro") return null;
  return st.workMs && st.workMs > 0 ? st.workMs : Math.max(1, cfg.workMin) * 60_000;
}

/** Break length after `rounds` completed work phases. */
export function breakLengthMs(rounds: number, cfg: FocusTimerConfig): number {
  const long = cfg.longEvery > 0 && rounds > 0 && rounds % cfg.longEvery === 0;
  return Math.max(1, long ? cfg.longBreakMin : cfg.shortBreakMin) * 60_000;
}

/** What the display shows: time left in a timed phase, elapsed in a stopwatch. */
export function displayMs(st: FocusTimerState, cfg: FocusTimerConfig, now: number): number {
  const len = phaseLength(st, cfg);
  const el = phaseElapsed(st, now);
  return len == null ? el : Math.max(0, len - el);
}
