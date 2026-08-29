import { App, moment, setIcon, TFile } from "obsidian";
import type StashpadPlugin from "./main";
import { collectTasks, type TaskItem } from "./task-collect";
import { writeCompletedFm } from "./types";

/** 0.273.1: the task TIMELINE — each task as a horizontal span from its
 *  creation to its completion (or to today, while open), Basecamp-lineup
 *  style. Answers the questions a list can't: how long things actually take,
 *  what has been open forever, and what got done when.
 *
 *  Spans need an END, and until 0.273.1 nothing recorded one — completion
 *  only flipped a boolean. `writeCompletedFm` now stamps `completedAt`
 *  everywhere a task is completed; tasks finished BEFORE that carry no stamp,
 *  so their end is approximated from the file's mtime and the bar says so
 *  (dashed end + tooltip) rather than presenting a guess as a fact. */

export interface TimelineState {
  folder: string;                       // "all" | folder path
  status: "all" | "open" | "done";
  range: "all" | "90" | "30" | "custom"; // window, in days back from now
  /** 0.275.0: when range === "custom", the window size in days. */
  customDays: number;
  /** 0.275.0: row order — newest start first, or longest span first (find the
   *  tasks/projects that have stretched on the longest). */
  sort: "recent" | "longest";
}
export function defaultTimelineState(): TimelineState {
  return { folder: "all", status: "all", range: "90", customDays: 180, sort: "recent" };
}

export interface TimelineOpts { onOpen: (folder: string, id: string) => void; }

interface MomentLike {
  format: (f: string) => string;
  valueOf: () => number;
  startOf: (u: string) => MomentLike;
  add: (n: number, u: string) => MomentLike;
}
const momentFn = moment as unknown as (ms?: number) => MomentLike;

interface Span {
  t: TaskItem;
  start: number;
  end: number;        // completedAt | approx | now
  done: boolean;
  approxEnd: boolean; // completed but unstamped — end is the file mtime
}

export function renderTaskTimeline(
  host: HTMLElement, app: App, plugin: StashpadPlugin, state: TimelineState, opts: TimelineOpts,
): void {
  const rerender = (): void => renderTaskTimeline(host, app, plugin, state, opts);
  host.empty();
  host.addClass("stashpad-timeline");

  const now = Date.now();
  const all = collectTasks(app, plugin).filter((t) => t.task || t.completed || t.due != null);

  const spans: Span[] = [];
  for (const t of all) {
    // No creation date = nowhere to anchor the bar. Rare (created is required
    // frontmatter); dropped rather than plotted at epoch.
    if (!t.created) continue;
    const done = t.completed;
    const end = done ? (t.completedAt ?? Math.max(t.modifiedMs, t.created)) : now;
    spans.push({ t, start: t.created, end: Math.max(end, t.created), done, approxEnd: done && t.completedAt == null });
  }

  const folders = [...new Set(spans.map((s) => s.t.folder))].sort((a, b) => a.localeCompare(b));

  // ---- controls ----
  const bar = host.createDiv({ cls: "stashpad-timeline-bar" });
  const select = (options: Array<{ v: string; label: string }>, cur: string, set: (v: string) => void): void => {
    const s = bar.createEl("select", { cls: "stashpad-index-select" });
    for (const o of options) { const el = s.createEl("option", { text: o.label }); el.value = o.v; if (o.v === cur) el.selected = true; }
    s.onchange = () => { set(s.value); rerender(); };
  };
  select([{ v: "all", label: "All folders" }, ...folders.map((f) => ({ v: f, label: f.split("/").pop() || f }))], state.folder, (v) => { state.folder = v; });
  select([{ v: "all", label: "Open + done" }, { v: "open", label: "Open" }, { v: "done", label: "Done" }], state.status, (v) => { state.status = v as TimelineState["status"]; });
  select([{ v: "30", label: "Last 30 days" }, { v: "90", label: "Last 90 days" }, { v: "custom", label: "Custom…" }, { v: "all", label: "All time" }], state.range, (v) => { state.range = v as TimelineState["range"]; });
  // 0.275.0: custom window in days (shown only when "Custom…" is picked).
  if (state.range === "custom") {
    const wrap = bar.createSpan({ cls: "stashpad-timeline-custom" });
    const inp = wrap.createEl("input", { type: "number", cls: "stashpad-timeline-daysinput", attr: { min: "1", max: "36500", "aria-label": "Days back" } });
    inp.value = String(state.customDays);
    inp.onchange = () => { const n = Math.max(1, Math.floor(Number(inp.value) || 0)); state.customDays = n; rerender(); };
    wrap.createSpan({ cls: "stashpad-timeline-daysunit", text: "days" });
  }
  // 0.275.0: sort — newest first, or longest span first (longest-stretching work).
  select([{ v: "recent", label: "Newest first" }, { v: "longest", label: "Longest first" }], state.sort, (v) => { state.sort = v as TimelineState["sort"]; });

  const windowDays = state.range === "custom" ? state.customDays : Number(state.range);
  const windowStart = state.range === "all" ? 0 : now - windowDays * 86400000;
  const shown = spans.filter((s) => {
    if (state.folder !== "all" && s.t.folder !== state.folder) return false;
    if (state.status === "open" && s.done) return false;
    if (state.status === "done" && !s.done) return false;
    return s.end >= windowStart;   // any part of the span inside the window
  }).sort((a, b) => state.sort === "longest" ? (b.end - b.start) - (a.end - a.start) : b.start - a.start);

  bar.createSpan({ cls: "stashpad-index-count", text: `${shown.length} task${shown.length === 1 ? "" : "s"}` });

  if (!shown.length) {
    host.createDiv({ cls: "stashpad-timeline-empty", text: "No tasks in this window." });
    return;
  }

  // ---- time axis ----
  const min = Math.max(windowStart || Math.min(...shown.map((s) => s.start)), Math.min(...shown.map((s) => s.start)));
  const max = now;
  const range = Math.max(max - min, 86400000);
  const pct = (ms: number): number => Math.min(100, Math.max(0, ((ms - min) / range) * 100));

  const axis = host.createDiv({ cls: "stashpad-timeline-axis" });
  axis.createDiv({ cls: "stashpad-timeline-axis-label" }); // spacer over the title column
  const axisTrack = axis.createDiv({ cls: "stashpad-timeline-axis-track" });
  // Week ticks for a month-or-less window, month ticks otherwise.
  const daily = range <= 35 * 86400000;
  const unit = daily ? "week" : "month";
  let tick = momentFn(min).startOf(unit);
  for (let i = 0; i < 40; i++) {
    const at = tick.valueOf();
    if (at > max) break;
    if (at >= min) {
      const el = axisTrack.createDiv({ cls: "stashpad-timeline-tick", text: momentFn(at).format(daily ? "D MMM" : "MMM YYYY") });
      el.style.left = `${pct(at)}%`;
    }
    tick = tick.add(1, unit);
  }

  // 0.275.0: complete/uncomplete a task straight from the timeline. Mirrors the
  // task-triage toggle (processFrontMatter + writeCompletedFm); an explicit
  // `atMs` sets a chosen completion date (and marks it complete) for anyone who
  // wants the bar to end on the real day, not "now".
  const setComplete = async (t: TaskItem, on: boolean, atMs?: number): Promise<void> => {
    try {
      await app.fileManager.processFrontMatter(t.file, (m: Record<string, unknown>) => {
        writeCompletedFm(m, on);
        if (on && atMs != null) m.completedAt = new Date(atMs).toISOString();
      });
    } catch (e) { console.warn("[Stashpad] timeline completion write failed", e); }
    // The aggregate view's modify listener refreshes when visible; rerender now
    // for immediacy (the metadata cache catches up within a tick).
    window.setTimeout(rerender, 60);
  };
  const openDatePicker = (anchor: HTMLElement, t: TaskItem): void => {
    const doc = anchor.ownerDocument ?? document;
    doc.querySelectorAll(".stashpad-timeline-datepop").forEach((p) => p.remove());
    const pop = doc.body.createDiv({ cls: "stashpad-timeline-datepop" });
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, (doc.defaultView?.innerWidth ?? 9999) - 240)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    pop.createDiv({ cls: "stashpad-timeline-datepop-label", text: "Completed on" });
    const inp = pop.createEl("input", { type: "date" });
    inp.value = momentFn(t.completedAt ?? Date.now()).format("YYYY-MM-DD");
    const rowb = pop.createDiv({ cls: "stashpad-timeline-datepop-row" });
    const ok = rowb.createEl("button", { cls: "mod-cta", text: "Mark complete" });
    ok.onclick = () => { const ms = Date.parse(inp.value + "T12:00:00"); pop.remove(); if (Number.isFinite(ms)) void setComplete(t, true, ms); };
    rowb.createEl("button", { text: "Cancel" }).onclick = () => pop.remove();
    const off = (e: MouseEvent): void => { if (!pop.contains(e.target as Node)) { pop.remove(); doc.removeEventListener("mousedown", off); } };
    window.setTimeout(() => doc.addEventListener("mousedown", off), 0);
  };

  // ---- rows ----
  const list = host.createDiv({ cls: "stashpad-timeline-list" });
  for (const s of shown) {
    const row = list.createDiv({ cls: "stashpad-timeline-row" });
    const title = row.createDiv({ cls: "stashpad-timeline-title" });
    const check = title.createEl("input", { type: "checkbox", cls: "stashpad-timeline-checkbox", attr: { "aria-label": s.done ? "Mark not done" : "Mark done" } });
    check.checked = s.done;
    check.onclick = (e) => { e.stopPropagation(); void setComplete(s.t, !s.done); };
    // Calendar button sits NEXT TO the checkbox (not after the text) so it never
    // eats into the note title, which fills the rest of the column.
    const cal = title.createEl("button", { cls: "stashpad-timeline-calbtn", attr: { "aria-label": "Set completion date (marks complete)" } });
    setIcon(cal, "calendar");
    cal.onclick = (e) => { e.stopPropagation(); openDatePicker(cal, s.t); };
    const ttext = title.createDiv({ cls: "stashpad-timeline-titletext" });
    ttext.createSpan({ text: s.t.title });
    ttext.createDiv({ cls: "stashpad-timeline-sub", text: s.t.folder.split("/").pop() || s.t.folder });

    const track = row.createDiv({ cls: "stashpad-timeline-track" });
    const barEl = track.createDiv({ cls: "stashpad-timeline-span" + (s.done ? " is-done" : " is-open") + (s.approxEnd ? " is-approx" : "") });
    const left = pct(s.start);
    const width = Math.max(pct(s.end) - left, 0.8);   // same-day tasks stay visible
    barEl.style.left = `${left}%`;
    barEl.style.width = `${width}%`;
    const days = Math.max(1, Math.round((s.end - s.start) / 86400000));
    barEl.title = s.done
      ? `${momentFn(s.start).format("D MMM YYYY")} → ${momentFn(s.end).format("D MMM YYYY")}${s.approxEnd ? " (completion date approximated from the file's last edit — completed before Stashpad recorded completion dates)" : ""} · ${days} day${days === 1 ? "" : "s"}`
      : `Open since ${momentFn(s.start).format("D MMM YYYY")} · ${days} day${days === 1 ? "" : "s"} and counting`;
    if (s.done) { const dot = barEl.createSpan({ cls: "stashpad-timeline-check" }); setIcon(dot, "check"); }

    row.onclick = () => opts.onOpen(s.t.folder, s.t.id);
  }
}
