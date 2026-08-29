import { App, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { collectIndexRows, type IndexRow } from "./aggregate-index";

/** 0.274.0: the DUE CALENDAR — a month grid where each day cell lists the notes
 *  that "belong" to that day under the SAME rule as the main view's day filter
 *  (view.ts nodeMatchesDate): a note shows on a day if it was CREATED that day,
 *  is DUE that day (task frontmatter), or LINKS to that day (`[[2026-08-18]]`).
 *
 *  So this is the calendar counterpart to the day filter — pick a day here and
 *  you see the same set the filter would show, laid out across the month. Read-
 *  only: a chip OPENS the note; the "reason" (created / due / link) is colour-
 *  coded and filterable, since a due-heavy month is the headline use. */

type Reason = "created" | "due" | "link";

export interface DueCalendarState {
  /** Epoch ms of any instant in the displayed period (month/week/day). */
  monthAnchor: number;
  folder: string;                 // "all" | folder path
  reasons: Record<Reason, boolean>;
  /** Day the user expanded (full list below the grid), "YYYY-MM-DD" or null. */
  openDay: string | null;
  /** 0.275.0: month grid, week strip, or single-day agenda (like other calendar apps). */
  view: "month" | "week" | "day";
}
export function defaultDueCalendarState(): DueCalendarState {
  return { monthAnchor: Date.now(), folder: "all", reasons: { created: true, due: true, link: true }, openDay: null, view: "month" };
}

export interface DueCalendarOpts { onOpen: (folder: string, id: string) => void; }

interface MomentLike {
  format: (f: string) => string;
  valueOf: () => number;
  add: (n: number, u: string) => MomentLike;
  subtract: (n: number, u: string) => MomentLike;
  startOf: (u: string) => MomentLike;
  endOf: (u: string) => MomentLike;
  day: () => number;              // 0 = Sunday
  date: () => number;             // day-of-month
  month: () => number;
  isSame: (o: MomentLike, u?: string) => boolean;
  clone: () => MomentLike;
}
const M = moment as unknown as { (ms?: number): MomentLike; (s: string, f: string): MomentLike; localeData: () => { firstDayOfWeek: () => number } };

interface DayHit { row: IndexRow; reasons: Set<Reason>; }

const REASON_META: Record<Reason, { label: string; cls: string; icon: string; title: string }> = {
  created: { label: "Created", cls: "is-created", icon: "sparkles", title: "Notes created on this day" },
  due:     { label: "Due",     cls: "is-due",     icon: "flag",     title: "Tasks due on this day" },
  link:    { label: "Links",   cls: "is-link",    icon: "link",     title: "Notes linking to this day" },
};

export async function renderDueCalendar(
  host: HTMLElement, app: App, plugin: StashpadPlugin, state: DueCalendarState, opts: DueCalendarOpts,
): Promise<void> {
  const token = ((host as unknown as { __sCalTok?: number }).__sCalTok ?? 0) + 1;
  (host as unknown as { __sCalTok?: number }).__sCalTok = token;
  const rows = await collectIndexRows(app, plugin);
  if ((host as unknown as { __sCalTok?: number }).__sCalTok !== token) return; // superseded
  const rerender = (): void => { void renderDueCalendar(host, app, plugin, state, opts); };
  host.empty();
  host.addClass("stashpad-cal");

  const folders = [...new Set(rows.map((r) => r.folder))].sort((a, b) => a.localeCompare(b));

  // Index every relevant note by the day(s) it belongs to. One note can land on
  // several days (created one day, due another, linking to a third).
  const byDay = new Map<string, DayHit[]>();
  const add = (day: string | null, row: IndexRow, reason: Reason): void => {
    if (!day) return;
    if (state.folder !== "all" && row.folder !== state.folder) return;
    if (!state.reasons[reason]) return;
    let hits = byDay.get(day);
    if (!hits) { hits = []; byDay.set(day, hits); }
    let hit = hits.find((h) => h.row.file.path === row.file.path);
    if (!hit) { hit = { row, reasons: new Set() }; hits.push(hit); }
    hit.reasons.add(reason);
  };
  for (const r of rows) {
    if (r.isHome) continue;
    add(r.created ? M(r.created).format("YYYY-MM-DD") : null, r, "created");
    add(r.dueDay, r, "due");
    for (const d of r.linkedDays) add(d, r, "link");
  }

  // ---- controls ----
  const bar = host.createDiv({ cls: "stashpad-cal-bar" });
  const nav = bar.createDiv({ cls: "stashpad-cal-nav" });
  const anchor = M(state.monthAnchor);
  const unit = state.view; // "month" | "week" | "day" — the step + the period shown
  const periodLabel = (): string => {
    if (state.view === "month") return anchor.format("MMMM YYYY");
    if (state.view === "day") return anchor.format("ddd, D MMM YYYY");
    const ws = weekStart(anchor); const we = ws.clone().add(6, "day");
    return `${ws.format("D MMM")} – ${we.format("D MMM")}`;
  };
  const prev = nav.createEl("button", { cls: "stashpad-cal-navbtn", attr: { "aria-label": `Previous ${unit}` } });
  setIcon(prev, "chevron-left");
  prev.onclick = () => { state.monthAnchor = M(state.monthAnchor).subtract(1, unit).valueOf(); state.openDay = null; rerender(); };
  nav.createSpan({ cls: "stashpad-cal-month", text: periodLabel() });
  const next = nav.createEl("button", { cls: "stashpad-cal-navbtn", attr: { "aria-label": `Next ${unit}` } });
  setIcon(next, "chevron-right");
  next.onclick = () => { state.monthAnchor = M(state.monthAnchor).add(1, unit).valueOf(); state.openDay = null; rerender(); };
  const today = nav.createEl("button", { cls: "stashpad-cal-today", text: "Today" });
  today.onclick = () => { state.monthAnchor = Date.now(); state.openDay = null; rerender(); };

  // 0.275.0: Month / Week / Day switcher (like other calendar apps).
  const seg = nav.createDiv({ cls: "stashpad-cal-seg" });
  ([["month", "Month"], ["week", "Week"], ["day", "Day"]] as Array<[DueCalendarState["view"], string]>).forEach(([v, label]) => {
    const b = seg.createEl("button", { cls: "stashpad-cal-segbtn" + (state.view === v ? " is-active" : ""), text: label });
    b.onclick = () => { if (state.view !== v) { state.view = v; state.openDay = null; rerender(); } };
  });

  const folderSel = bar.createEl("select", { cls: "stashpad-index-select", attr: { "aria-label": "Folder" } });
  for (const o of [{ v: "all", label: "All folders" }, ...folders.map((f) => ({ v: f, label: f.split("/").pop() || f }))]) {
    const opt = folderSel.createEl("option", { text: o.label }); opt.value = o.v; if (o.v === state.folder) opt.selected = true;
  }
  folderSel.onchange = () => { state.folder = folderSel.value; state.openDay = null; rerender(); };

  // Reason legend + toggle chips (due-heavy month is the headline, so all on).
  const legend = bar.createDiv({ cls: "stashpad-cal-legend" });
  (Object.keys(REASON_META) as Reason[]).forEach((k) => {
    const meta = REASON_META[k];
    const c = legend.createEl("button", { cls: `stashpad-cal-chip ${meta.cls}` + (state.reasons[k] ? " is-active" : ""), title: meta.title });
    const dot = c.createSpan({ cls: "stashpad-cal-dot" }); setIcon(dot, meta.icon);
    c.createSpan({ text: meta.label });
    c.onclick = () => { state.reasons[k] = !state.reasons[k]; state.openDay = null; rerender(); };
  });

  const todayStr = M(Date.now()).format("YYYY-MM-DD");

  // ---- week / day agenda (0.275.0) ----
  if (state.view === "week" || state.view === "day") {
    const container = host.createDiv({ cls: "stashpad-cal-agenda" + (state.view === "day" ? " is-day" : "") });
    const days: MomentLike[] = state.view === "day"
      ? [anchor.clone()]
      : Array.from({ length: 7 }, (_, i) => weekStart(anchor).add(i, "day"));
    for (const d of days) {
      const ds = d.format("YYYY-MM-DD");
      const col = container.createDiv({ cls: "stashpad-cal-aglane" + (ds === todayStr ? " is-today" : "") });
      const head = col.createDiv({ cls: "stashpad-cal-aghead" });
      head.createSpan({ cls: "stashpad-cal-agdow", text: d.format(state.view === "day" ? "dddd" : "ddd") });
      head.createSpan({ cls: "stashpad-cal-agdate", text: d.format(state.view === "day" ? "D MMMM" : "D MMM") });
      const hits = (byDay.get(ds) ?? []).slice().sort((a, b) => reasonRank(a) - reasonRank(b) || a.row.title.localeCompare(b.row.title));
      if (hits.length) head.createSpan({ cls: "stashpad-cal-cellcount", text: String(hits.length) });
      const body = col.createDiv({ cls: "stashpad-cal-agbody" });
      if (!hits.length) body.createDiv({ cls: "stashpad-cal-agempty", text: "Nothing this day" });
      for (const h of hits) chipFor(body, h, opts, true);
    }
    return;
  }

  // ---- month grid ----
  const firstDow = M.localeData().firstDayOfWeek();
  const monthStart = anchor.clone().startOf("month");
  // Back up to the start of the grid week.
  let cursor = monthStart.clone();
  while (cursor.day() !== firstDow) cursor = cursor.subtract(1, "day");
  const thisMonth = anchor.month();

  const grid = host.createDiv({ cls: "stashpad-cal-grid" });
  // Weekday header, rotated to the locale's first day.
  for (let i = 0; i < 7; i++) {
    const dow = (firstDow + i) % 7;
    grid.createDiv({ cls: "stashpad-cal-dow", text: WEEKDAYS[dow] });
  }

  // Weeks NEEDED = leading blanks + days-in-month, rounded up. Computing it
  // avoids a trailing all-next-month padding row (e.g. a 28-day February that
  // starts on the grid's first weekday needs exactly 4 rows, not 5).
  const daysInMonth = anchor.clone().endOf("month").date();
  const leadBlanks = (monthStart.day() - firstDow + 7) % 7;
  const weeksNeeded = Math.ceil((leadBlanks + daysInMonth) / 7);

  for (let w = 0; w < weeksNeeded; w++) {
    for (let d = 0; d < 7; d++) {
      const dayStr = cursor.format("YYYY-MM-DD");
      const inMonth = cursor.month() === thisMonth;
      const cell = grid.createDiv({ cls: "stashpad-cal-cell" + (inMonth ? "" : " is-out") + (dayStr === todayStr ? " is-today" : "") });
      const head = cell.createDiv({ cls: "stashpad-cal-cellhead" });
      head.createSpan({ cls: "stashpad-cal-daynum", text: String(cursor.date()) });
      const hits = (byDay.get(dayStr) ?? []).slice().sort((a, b) => reasonRank(a) - reasonRank(b) || a.row.title.localeCompare(b.row.title));
      if (hits.length) head.createSpan({ cls: "stashpad-cal-cellcount", text: String(hits.length) });

      const SHOWN = 3;
      for (const h of hits.slice(0, SHOWN)) chipFor(cell, h, opts);
      if (hits.length > SHOWN) {
        const more = cell.createEl("button", { cls: "stashpad-cal-more", text: `+${hits.length - SHOWN} more` });
        more.onclick = () => { state.openDay = state.openDay === dayStr ? null : dayStr; rerender(); };
      }
      if (hits.length) cell.addClass("has-hits");
      cursor = cursor.add(1, "day");
    }
  }

  // ---- expanded day list ----
  if (state.openDay) {
    const hits = (byDay.get(state.openDay) ?? []).slice().sort((a, b) => reasonRank(a) - reasonRank(b) || a.row.title.localeCompare(b.row.title));
    const panel = host.createDiv({ cls: "stashpad-cal-daypanel" });
    const ph = panel.createDiv({ cls: "stashpad-cal-daypanel-head" });
    ph.createSpan({ text: M(state.openDay, "YYYY-MM-DD").format("dddd, D MMMM YYYY") });
    ph.createSpan({ cls: "stashpad-index-count", text: `${hits.length} note${hits.length === 1 ? "" : "s"}` });
    const close = ph.createEl("button", { cls: "stashpad-trash-iconbtn", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    close.onclick = () => { state.openDay = null; rerender(); };
    for (const h of hits) chipFor(panel, h, opts, true);
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Start of the calendar week containing `m`, honoring the locale's first day. */
function weekStart(m: MomentLike): MomentLike {
  const fdow = M.localeData().firstDayOfWeek();
  let c = m.clone();
  while (c.day() !== fdow) c = c.subtract(1, "day");
  return c;
}

/** created before due before link — the order chips stack in a cell. */
function reasonRank(h: DayHit): number {
  if (h.reasons.has("due")) return 0;
  if (h.reasons.has("created")) return 1;
  return 2;
}

function chipFor(parent: HTMLElement, h: DayHit, opts: DueCalendarOpts, full = false): HTMLElement {
  const blurred = h.row.obscured;
  const primary: Reason = h.reasons.has("due") ? "due" : h.reasons.has("created") ? "created" : "link";
  const chip = parent.createDiv({ cls: `stashpad-cal-note ${REASON_META[primary].cls}` + (full ? " is-full" : "") });
  const dot = chip.createSpan({ cls: "stashpad-cal-dot" }); setIcon(dot, REASON_META[primary].icon);
  chip.createSpan({ cls: "stashpad-cal-note-title" + (blurred ? " is-blurred" : ""), text: blurred ? "•••••" : h.row.title });
  if (full) chip.createSpan({ cls: "stashpad-cal-note-folder", text: h.row.folder.split("/").pop() || h.row.folder });
  const reasonList = [...h.reasons].map((r) => REASON_META[r].label).join(" · ");
  chip.title = `${blurred ? "Obscured note" : h.row.title} — ${reasonList}`;
  chip.onclick = () => { if (!blurred) opts.onOpen(h.row.folder, h.row.id); };
  if (blurred) chip.addClass("is-obscured");
  return chip;
}
