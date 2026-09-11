/** 0.319.0: natural-language date parsing, shared by the composer's `@` trigger
 *  and the search filters (`before:` / `after:` / `on:`). No dependency — plain
 *  `Date` arithmetic (calendar-day math via setDate/setMonth, so DST-safe) —
 *  which also keeps it testable in node.
 *
 *  Grammar (case-insensitive, extra spaces ignored, optional leading "on"/"at"):
 *    today · now · tomorrow · tmrw · yesterday · (the) day after tomorrow ·
 *    (the) day before yesterday · tonight
 *    <weekday>  · next <weekday> · last <weekday> · this <weekday> · coming <weekday>
 *    next/last/this week|month|year · end|start|beginning of (next|last|this|the)? week|month|year
 *    in N days|weeks|months|years|hours|minutes · N units ago · N units from now
 *    (N = digits or one..twelve/a/an; units may be abbreviated d w m y h min)
 *    7d · 2w · 1m · 1y   (shorthand: "ago" when preferring the past, else from now)
 *    2026-09-12 · 2026/09/12 · 9/12/2026 · 9/12 · sep 12 · september 12, 2026 · 12 sep · 12th of sept
 *    …optionally followed by a time: at 3pm · 3:30pm · 15:00 · noon · midnight · morning · afternoon · evening
 *
 *    first|second|third|fourth|fifth|last <weekday> of <month|next month|last month|this month>
 *    …any month-day form may end in "next year" / "last year" / "of next year"
 *
 *  `prefer` decides a bare weekday: "future" (composer: "@tuesday" = the coming
 *  Tuesday, today if it is Tuesday) or "past" (search: the most recent Tuesday).
 *  A month-day WITHOUT a year is always THIS year (user: no "clever" next-year
 *  bump for months already past — say "next year" when you mean it). */

export interface NaturalDate {
  /** Epoch ms — start of the resolved day, plus the time of day when one was given. */
  ms: number;
  hasTime: boolean;
  /** The phrase as understood (normalised), for display. */
  phrase: string;
}

export interface NaturalDateOptions {
  now?: number;
  prefer?: "future" | "past";
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  couple: 2, few: 3,
};

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d: Date, n: number): Date {
  const x = new Date(d); const day = x.getDate();
  x.setDate(1); x.setMonth(x.getMonth() + n);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, last));
  return x;
}
function addYears(d: Date, n: number): Date { return addMonths(d, 12 * n); }
function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  return WEEKDAYS.findIndex((n) => n === w || (w.length >= 3 && n.startsWith(w)));
}
function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w === "sept") return 8;
  return MONTHS.findIndex((n) => n === w || (w.length >= 3 && n.startsWith(w)));
}
function numberOf(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUMBER_WORDS[s] ?? null;
}
type Unit = "day" | "week" | "month" | "year" | "hour" | "minute";
function unitOf(s: string): Unit | null {
  const u = s.toLowerCase();
  if (/^(d|day|days)$/.test(u)) return "day";
  if (/^(w|wk|wks|week|weeks)$/.test(u)) return "week";
  if (/^(m|mo|mos|month|months)$/.test(u)) return "month";
  if (/^(y|yr|yrs|year|years)$/.test(u)) return "year";
  if (/^(h|hr|hrs|hour|hours)$/.test(u)) return "hour";
  if (/^(min|mins|minute|minutes)$/.test(u)) return "minute";
  return null;
}
function shift(base: Date, n: number, unit: Unit): Date {
  switch (unit) {
    case "day": return addDays(base, n);
    case "week": return addDays(base, 7 * n);
    case "month": return addMonths(base, n);
    case "year": return addYears(base, n);
    case "hour": return new Date(base.getTime() + n * 3600_000);
    case "minute": return new Date(base.getTime() + n * 60_000);
  }
}

/** Pull a time-of-day off the end (or anywhere) of the text. Returns the
 *  remaining date text and the time in minutes since midnight. A bare
 *  "3" only counts as a time after "at" ("at 3" → 3pm-ish? no: 03:00 — we
 *  treat "at N" without am/pm as N:00, N<7 → afternoon). */
function extractTime(text: string): { rest: string; minutes: number | null } {
  let t = text;
  const words: Array<[RegExp, number]> = [
    [/\b(at\s+)?noon\b/, 12 * 60], [/\b(at\s+)?midday\b/, 12 * 60], [/\b(at\s+)?midnight\b/, 0],
    [/\b(in\s+the\s+|this\s+)?morning\b/, 9 * 60], [/\b(in\s+the\s+|this\s+)?afternoon\b/, 15 * 60],
    [/\b(in\s+the\s+|this\s+)?evening\b/, 18 * 60], [/\b(at\s+)?night\b/, 20 * 60],
  ];
  for (const [re, m] of words) {
    if (re.test(t)) return { rest: t.replace(re, " ").replace(/\s+/g, " ").trim(), minutes: m };
  }
  // "at 3", "at 3pm", "3:30pm", "15:00", "3 pm", "at 10.30" — a colon/dot or
  // am/pm makes a bare number a time; without them only after "at".
  const re = /(?:\b(at)\s+)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/gi;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const hasAt = !!m[1], hasMin = m[3] != null, ap = m[4]?.replace(/\./g, "").toLowerCase();
    if (!hasAt && !hasMin && !ap) continue;
    let h = parseInt(m[2], 10); const min = hasMin ? parseInt(m[3]!, 10) : 0;
    if (h > 24 || min > 59) continue;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && !hasMin && hasAt && h >= 1 && h <= 6) h += 12; // "at 3" → 15:00
    if (h === 24) h = 0;
    return { rest: (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), minutes: h * 60 + min };
  }
  return { rest: t, minutes: null };
}

export function parseNaturalDate(input: string, opts: NaturalDateOptions = {}): NaturalDate | null {
  const prefer = opts.prefer ?? "future";
  const now = new Date(opts.now ?? Date.now());
  const today = startOfDay(now);
  let text = (input || "").toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text.replace(/^(on|for|by|due)\s+/, "");
  const { rest, minutes } = extractTime(text);
  let dateText = rest.replace(/^(on|the)\s+/, "").replace(/\s+(on|the)$/, "").trim();
  if (dateText === "at") dateText = "";
  // "… of next year" / "… last year" / "… this year" suffix on a month-day form.
  let yearShift = 0;
  const ys = /\s+(?:of\s+)?(next|last|this|previous)\s+year$/.exec(dateText);
  if (ys && !/^(next|last|this|previous)\s+year$/.test(dateText)) {
    yearShift = ys[1] === "next" ? 1 : ys[1] === "this" ? 0 : -1;
    dateText = dateText.slice(0, ys.index).trim();
  }
  const yearOf = (y: number): number => y + yearShift;
  const done = (day: Date, phrase: string): NaturalDate => {
    const base = startOfDay(day);
    return { ms: base.getTime() + (minutes ?? 0) * 60_000, hasTime: minutes != null, phrase: phrase + (minutes != null ? "" : "") };
  };
  const wd = (i: number) => WEEKDAYS[i];

  // --- fixed words
  if (dateText === "" || dateText === "today" || dateText === "now" || dateText === "tonight") {
    if (dateText === "tonight" && minutes == null) return { ms: today.getTime() + 20 * 3600_000, hasTime: true, phrase: "tonight" };
    return done(today, dateText || "today");
  }
  if (/^(tomorrow|tmrw|tmr|tom)$/.test(dateText)) return done(addDays(today, 1), "tomorrow");
  if (/^(yesterday|yest)$/.test(dateText)) return done(addDays(today, -1), "yesterday");
  if (/^(the )?day after tomorrow$/.test(dateText)) return done(addDays(today, 2), "the day after tomorrow");
  if (/^(the )?day before yesterday$/.test(dateText)) return done(addDays(today, -2), "the day before yesterday");

  // --- weekdays with modifiers
  // Explicit forms only — a `[a-z]*` tail let "next month" parse as Monday.
  let m = /^(next|last|this|coming|previous|prev|upcoming)?\s*(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)$/.exec(dateText);
  if (m) {
    const idx = weekdayIndex(m[2]);
    if (idx >= 0) {
      const mod = m[1] ?? "";
      const cur = today.getDay();
      let delta: number;
      if (mod === "last" || mod === "previous" || mod === "prev") delta = -(((cur - idx + 7) % 7) || 7);
      else if (mod === "next") delta = ((idx - cur + 7) % 7) || 7;
      else if (mod === "this" || mod === "coming" || mod === "upcoming") delta = (idx - cur + 7) % 7;
      else delta = prefer === "past" ? -((cur - idx + 7) % 7) : (idx - cur + 7) % 7;
      return done(addDays(today, delta), `${mod ? mod + " " : ""}${wd(idx)}`);
    }
  }

  // --- next/last/this week|month|year
  m = /^(next|last|this|previous|prev)\s+(week|month|year)$/.exec(dateText);
  if (m) {
    const n = m[1] === "next" ? 1 : m[1] === "this" ? 0 : -1;
    const u = m[2] as Unit;
    return done(shift(today, n, u), `${m[1]} ${m[2]}`);
  }

  // --- end / start of period
  m = /^(end|eo|start|beginning|bo)\s*(?:of)?\s*(?:the\s+)?(next|last|this)?\s*(week|month|year|wk|mo|yr)$/.exec(dateText);
  if (m) {
    const which = /^(end|eo)$/.test(m[1]) ? "end" : "start";
    const n = m[2] === "next" ? 1 : m[2] === "last" ? -1 : 0;
    const u = unitOf(m[3])!;
    const base = shift(today, n, u);
    let day: Date;
    if (u === "week") {
      // Weeks run Monday → Sunday.
      const dow = (base.getDay() + 6) % 7; // 0 = Monday
      day = which === "end" ? addDays(base, 6 - dow) : addDays(base, -dow);
    } else if (u === "month") {
      day = which === "end" ? new Date(base.getFullYear(), base.getMonth() + 1, 0) : new Date(base.getFullYear(), base.getMonth(), 1);
    } else {
      day = which === "end" ? new Date(base.getFullYear(), 11, 31) : new Date(base.getFullYear(), 0, 1);
    }
    return done(day, `${which} of ${m[2] ? m[2] + " " : ""}${u}`);
  }

  // --- in N units / N units ago / N units from now
  m = /^in\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few)\s*([a-z]+)$/.exec(dateText)
    ?? /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few)\s*([a-z]+)\s+from\s+now$/.exec(dateText);
  if (m) {
    const n = numberOf(m[1].replace(" of", "")); const u = unitOf(m[2]);
    if (n != null && u) {
      const from = u === "hour" || u === "minute" ? now : today;
      const d = shift(from, n, u);
      if (u === "hour" || u === "minute") return { ms: d.getTime(), hasTime: true, phrase: `in ${n} ${u}${n === 1 ? "" : "s"}` };
      return done(d, `in ${n} ${u}${n === 1 ? "" : "s"}`);
    }
  }
  m = /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few)\s*([a-z]+)\s+ago$/.exec(dateText);
  if (m) {
    const n = numberOf(m[1].replace(" of", "")); const u = unitOf(m[2]);
    if (n != null && u) {
      const from = u === "hour" || u === "minute" ? now : today;
      const d = shift(from, -n, u);
      if (u === "hour" || u === "minute") return { ms: d.getTime(), hasTime: true, phrase: `${n} ${u}${n === 1 ? "" : "s"} ago` };
      return done(d, `${n} ${u}${n === 1 ? "" : "s"} ago`);
    }
  }
  // shorthand 7d / 2w / 1m / 1y
  m = /^(\d+)\s*([dwmy])$/.exec(dateText);
  if (m) {
    const n = parseInt(m[1], 10); const u = unitOf(m[2])!;
    const sign = prefer === "past" ? -1 : 1;
    return done(shift(today, sign * n, u), `${n}${m[2]} ${sign < 0 ? "ago" : "from now"}`);
  }

  // --- "the third tuesday of june" / "last thursday of next month" / "first monday in feb 2027"
  m = /^(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\s+(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\s+(?:of|in)\s+(?:the\s+)?(.+)$/.exec(dateText);
  if (m) {
    const nth = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 }[m[1]]!;
    const idx = weekdayIndex(m[2]);
    const rem = m[3].trim();
    let y: number, mo: number;
    const rm = /^(next|last|this|previous)\s+month$/.exec(rem) ?? (rem === "month" ? ["", "this"] : null);
    if (rm) {
      const b = addMonths(today, rm[1] === "next" ? 1 : rm[1] === "this" ? 0 : -1);
      y = b.getFullYear(); mo = b.getMonth();
    } else {
      const mm = /^([a-z]{3,9})\.?(?:\s+(\d{4}))?$/.exec(rem);
      if (!mm) return null;
      mo = monthIndex(mm[1]);
      if (mo < 0) return null;
      y = mm[2] ? +mm[2] : today.getFullYear();
    }
    y = yearOf(y);
    let day: Date;
    if (nth > 0) {
      const first = new Date(y, mo, 1);
      const off = (idx - first.getDay() + 7) % 7;
      day = new Date(y, mo, 1 + off + 7 * (nth - 1));
      if (day.getMonth() !== mo) return null; // e.g. a fifth Friday that doesn't exist
    } else {
      const last = new Date(y, mo + 1, 0);
      const back = (last.getDay() - idx + 7) % 7;
      day = new Date(y, mo, last.getDate() - back);
    }
    return done(day, `${m[1]} ${wd(idx)} of ${MONTHS[mo]} ${y}`);
  }

  // --- numeric dates
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(dateText);
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); if (d.getMonth() === +m[2] - 1) return done(d, dateText); return null; }
  m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/.exec(dateText);
  if (m) {
    const mo = +m[1], da = +m[2];
    let y = m[3] ? +m[3] : today.getFullYear();
    if (m[3] && m[3].length === 2) y += 2000;
    y = yearOf(y);
    const d = new Date(y, mo - 1, da);
    if (d.getMonth() !== mo - 1) return null;
    return done(d, dateText);
  }
  // --- month names: "sep 12", "september 12 2026", "12 sep", "12th of sept 2026"
  const ord = "(\\d{1,2})(?:st|nd|rd|th)?";
  m = new RegExp(`^([a-z]{3,9})\\.?\\s+${ord}(?:\\s+(\\d{4}))?$`).exec(dateText)
    ?? new RegExp(`^${ord}\\s+(?:of\\s+)?([a-z]{3,9})\\.?(?:\\s+(\\d{4}))?$`).exec(dateText);
  if (m) {
    const first = /^\d/.test(m[1]);
    const mon = monthIndex(first ? m[2] : m[1]); const da = +(first ? m[1] : m[2]); const yr = m[3] ? +m[3] : null;
    if (mon >= 0 && da >= 1 && da <= 31) {
      const y = yearOf(yr ?? today.getFullYear());
      const d = new Date(y, mon, da);
      if (d.getMonth() !== mon) return null;
      return done(d, `${MONTHS[mon]} ${da}${yr || yearShift ? " " + y : ""}`);
    }
  }
  return null;
}

/** Phrases the `@` trigger offers for PREFIX matching (so "@tue" previews
 *  "tuesday" before the word is finished). Ordered by how often people reach
 *  for them; weekdays are listed relative to today (tomorrow's first). */
export function naturalDatePhrases(now: number = Date.now()): string[] {
  const cur = new Date(now).getDay();
  const days: string[] = [];
  for (let i = 1; i <= 7; i++) days.push(WEEKDAYS[(cur + i) % 7]);
  return [
    "today", "tomorrow", "yesterday",
    ...days,
    ...days.map((d) => `next ${d}`),
    ...days.map((d) => `last ${d}`),
    "next week", "last week", "next month", "last month", "next year",
    "in 2 days", "in 3 days", "in a week", "in 2 weeks", "in a month",
    "2 days ago", "a week ago",
    "end of week", "end of month", "end of year", "start of next week", "start of next month",
    "the day after tomorrow", "the day before yesterday", "tonight", "noon", "midnight",
    "last friday of the month", "first monday of next month", "third tuesday of june",
  ];
}

/** Two-digit helper for the default formatter. */
const p2 = (n: number): string => String(n).padStart(2, "0");
/** ISO date (+ " HH:mm" when the phrase carried a time). Callers with a vault
 *  date format (Templates plugin) format `ms` themselves. */
export function formatNaturalDate(r: NaturalDate): string {
  const d = new Date(r.ms);
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return r.hasTime ? `${date} ${p2(d.getHours())}:${p2(d.getMinutes())}` : date;
}
