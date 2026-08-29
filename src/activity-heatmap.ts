import { App, moment, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import type { LogEvent, LogEventType } from "./types";
import { collectIndexRows } from "./aggregate-index";

/** 0.274.0: the ACTIVITY HEATMAP — a GitHub-style calendar of how much you
 *  touched your notes each day, read from the action log (log.jsonl). Answers
 *  "when was I actually working in here, and on what" — the log already records
 *  create / edit / complete / move / attach / lock / delete, and 0.274.0 added
 *  an in-app `edit` event so edits made through Stashpad count too (previously
 *  only edits from OUTSIDE Stashpad, `external_edit`, left a trace).
 *
 *  Events are grouped into BUCKETS; house-cleaning buckets (moves, encryption
 *  chores, palette tweaks) are shown by default but one click hides them, so
 *  the map can show just real authoring work. */

type Bucket = "created" | "edited" | "tasks" | "moved" | "files" | "vault" | "deleted" | "viewed";

const BUCKET_OF: Record<LogEventType, Bucket> = {
  create: "created",
  edit: "edited", external_edit: "edited",
  open: "viewed",
  complete: "tasks", uncomplete: "tasks",
  parent_change: "moved", reorder: "moved", rename: "moved",
  attachment_add: "files", attachment_remove: "files",
  lock: "vault", unlock: "vault", archive: "vault", restore: "vault",
  archive_migration: "vault", palette_color_add: "vault", palette_color_remove: "vault",
  stash_export: "vault", stash_import: "vault",
  delete: "deleted", missing: "deleted",
};

const BUCKET_META: Record<Bucket, { label: string; icon: string; house: boolean }> = {
  created: { label: "Created", icon: "sparkles", house: false },
  edited:  { label: "Edited",  icon: "pencil", house: false },
  viewed:  { label: "Viewed",  icon: "eye", house: true },
  tasks:   { label: "Tasks",   icon: "check-square", house: false },
  files:   { label: "Attachments", icon: "paperclip", house: false },
  moved:   { label: "Moves & renames", icon: "move", house: true },
  vault:   { label: "Encrypt / archive / color", icon: "lock", house: true },
  deleted: { label: "Deleted", icon: "trash-2", house: false },
};

export interface HeatmapState {
  weeks: 13 | 26 | 52;
  buckets: Record<Bucket, boolean>;
  openDay: string | null;     // "YYYY-MM-DD"
}
export function defaultHeatmapState(): HeatmapState {
  return {
    weeks: 26,
    buckets: { created: true, edited: true, tasks: true, files: true, moved: true, vault: true, deleted: true, viewed: true },
    // 0.275.3: pre-select TODAY so the detail panel isn't blank on open (and
    // today's cell reads as selected). Once open, the user's clicks / closing
    // the panel take over normally.
    openDay: (moment as unknown as (ms?: number) => { format: (f: string) => string })(Date.now()).format("YYYY-MM-DD"),
  };
}

export interface HeatmapOpts { onOpen: (folder: string, id: string) => void; }

interface MomentLike {
  format: (f: string) => string;
  valueOf: () => number;
  day: () => number;
  month: () => number;
  add: (n: number, u: string) => MomentLike;
  subtract: (n: number, u: string) => MomentLike;
  startOf: (u: string) => MomentLike;
  clone: () => MomentLike;
}
const M = moment as unknown as { (ms?: number): MomentLike; (s: string, f: string): MomentLike };

interface DayEntry { total: number; byBucket: Map<Bucket, number>; events: LogEvent[]; }

async function readLog(app: App, plugin: StashpadPlugin): Promise<LogEvent[]> {
  const path = plugin.newLog().getLogPath();
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(path))) return [];
  let raw = "";
  try { raw = await adapter.read(path); } catch { return []; }
  const out: LogEvent[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s) as LogEvent;
      if (ev && typeof ev.ts === "string" && typeof ev.type === "string") out.push(ev);
    } catch { /* skip a torn line */ }
  }
  return out;
}

export async function renderActivityHeatmap(
  host: HTMLElement, app: App, plugin: StashpadPlugin, state: HeatmapState, opts: HeatmapOpts,
): Promise<void> {
  const token = ((host as unknown as { __sHeatTok?: number }).__sHeatTok ?? 0) + 1;
  (host as unknown as { __sHeatTok?: number }).__sHeatTok = token;
  const [events, rows] = await Promise.all([readLog(app, plugin), collectIndexRows(app, plugin)]);
  if ((host as unknown as { __sHeatTok?: number }).__sHeatTok !== token) return; // superseded
  const rerender = (): void => { void renderActivityHeatmap(host, app, plugin, state, opts); };
  host.empty();
  host.addClass("stashpad-heat");

  // id → note, for resolving what an event touched (deleted notes won't resolve).
  const byId = new Map<string, { title: string; folder: string; id: string }>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, { title: r.title, folder: r.folder, id: r.id });

  // Fold the enabled events into per-day tallies.
  const days = new Map<string, DayEntry>();
  let counted = 0;
  for (const ev of events) {
    const bucket = BUCKET_OF[ev.type];
    if (!bucket || !state.buckets[bucket]) continue;
    const parsed = Date.parse(ev.ts);
    if (!Number.isFinite(parsed)) continue;
    const day = M(parsed).format("YYYY-MM-DD");
    let e = days.get(day);
    if (!e) { e = { total: 0, byBucket: new Map(), events: [] }; days.set(day, e); }
    e.total++; counted++;
    e.byBucket.set(bucket, (e.byBucket.get(bucket) ?? 0) + 1);
    e.events.push(ev);
  }

  // ---- controls ----
  const bar = host.createDiv({ cls: "stashpad-heat-bar" });
  const rangeSel = bar.createEl("select", { cls: "stashpad-index-select", attr: { "aria-label": "Range" } });
  for (const o of [{ v: 13, label: "Last 3 months" }, { v: 26, label: "Last 6 months" }, { v: 52, label: "Last year" }]) {
    const opt = rangeSel.createEl("option", { text: o.label }); opt.value = String(o.v); if (o.v === state.weeks) opt.selected = true;
  }
  rangeSel.onchange = () => { state.weeks = Number(rangeSel.value) as HeatmapState["weeks"]; state.openDay = null; rerender(); };

  (Object.keys(BUCKET_META) as Bucket[]).forEach((b) => {
    const meta = BUCKET_META[b];
    const c = bar.createEl("button", { cls: "stashpad-index-chip" + (state.buckets[b] ? " is-active" : "") + (meta.house ? " is-house" : ""), title: meta.house ? `${meta.label} — house-cleaning; click to hide` : meta.label });
    const ic = c.createSpan({ cls: "stashpad-heat-chipic" }); setIcon(ic, meta.icon);
    c.createSpan({ text: meta.label });
    c.onclick = () => { state.buckets[b] = !state.buckets[b]; state.openDay = null; rerender(); };
  });

  // ---- grid geometry ----
  const weeks = state.weeks;
  const todayM = M(Date.now());
  // End on the Saturday of this week so the last column is full; start `weeks`
  // columns back on a Sunday.
  const end = todayM.clone().startOf("day").add(6 - todayM.day(), "day");
  const start = end.clone().subtract(weeks * 7 - 1, "day");

  // Colour scale: QUANTILE, not linear. A single bulk-import day (2000+ actions)
  // would flatten a linear scale so every normal day reads as level 1. Ranking
  // the in-window non-zero totals and cutting at the 40/65/85th percentiles
  // spreads ordinary days across levels 1–4 while the outlier still tops out.
  const nonzero: number[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = start.clone().add(i, "day").format("YYYY-MM-DD");
    const t = days.get(d)?.total ?? 0; if (t > 0) nonzero.push(t);
  }
  nonzero.sort((a, b) => a - b);
  const q = (p: number): number => nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * p))] : Infinity;
  const t1 = q(0.40), t2 = q(0.65), t3 = q(0.85);
  const level = (n: number): number => {
    if (n <= 0) return 0;
    if (n >= t3) return 4;
    if (n >= t2) return 3;
    if (n >= t1) return 2;
    return 1;
  };

  const windowTotal = (() => {
    let t = 0;
    for (let i = 0; i < weeks * 7; i++) { const d = start.clone().add(i, "day").format("YYYY-MM-DD"); t += days.get(d)?.total ?? 0; }
    return t;
  })();
  bar.createSpan({ cls: "stashpad-index-count", text: `${windowTotal} action${windowTotal === 1 ? "" : "s"}` });

  const scroll = host.createDiv({ cls: "stashpad-heat-scroll" });
  const wrap = scroll.createDiv({ cls: "stashpad-heat-wrap" });

  // Month labels above the columns.
  const monthRow = wrap.createDiv({ cls: "stashpad-heat-months" });
  monthRow.createDiv({ cls: "stashpad-heat-daylabels-spacer" });
  const cols = monthRow.createDiv({ cls: "stashpad-heat-monthcols" });
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const colStart = start.clone().add(w * 7, "day");
    const label = cols.createDiv({ cls: "stashpad-heat-monthlabel" });
    if (colStart.month() !== lastMonth) { label.setText(colStart.format("MMM")); lastMonth = colStart.month(); }
  }

  const body = wrap.createDiv({ cls: "stashpad-heat-body" });
  const dayLabels = body.createDiv({ cls: "stashpad-heat-daylabels" });
  ["", "Mon", "", "Wed", "", "Fri", ""].forEach((t) => dayLabels.createDiv({ cls: "stashpad-heat-daylabel", text: t }));

  const cells = body.createDiv({ cls: "stashpad-heat-cells" });
  const todayStr = todayM.format("YYYY-MM-DD");
  for (let w = 0; w < weeks; w++) {
    const col = cells.createDiv({ cls: "stashpad-heat-col" });
    for (let d = 0; d < 7; d++) {
      const day = start.clone().add(w * 7 + d, "day");
      const dayStr = day.format("YYYY-MM-DD");
      const e = days.get(dayStr);
      const n = e?.total ?? 0;
      const future = day.valueOf() > todayM.valueOf();
      const cell = col.createDiv({ cls: "stashpad-heat-cell" });
      cell.dataset.level = String(future ? 0 : level(n));
      if (future) cell.addClass("is-future");
      if (dayStr === todayStr) cell.addClass("is-today");
      if (state.openDay === dayStr) cell.addClass("is-selected");
      const parts = e ? [...e.byBucket.entries()].map(([b, c]) => `${c} ${BUCKET_META[b].label.toLowerCase()}`).join(", ") : "no activity";
      cell.setAttr("aria-label", `${day.format("ddd D MMM YYYY")}: ${parts}`);
      cell.title = `${day.format("ddd D MMM YYYY")} — ${n} action${n === 1 ? "" : "s"}${e ? ` (${parts})` : ""}`;
      if (!future) cell.onclick = () => { state.openDay = state.openDay === dayStr && n ? null : (n ? dayStr : null); rerender(); };
    }
  }

  // Legend: Less ▢▢▢▢▢ More.
  const legend = host.createDiv({ cls: "stashpad-heat-legendrow" });
  legend.createSpan({ text: "Less" });
  for (let i = 0; i <= 4; i++) { const sq = legend.createDiv({ cls: "stashpad-heat-legendcell" }); sq.dataset.level = String(i); }
  legend.createSpan({ text: "More" });

  if (counted === 0) {
    host.createDiv({ cls: "stashpad-timeline-empty", text: "No logged activity yet in the selected buckets. As you create, edit, and complete notes, the log fills in and the heatmap lights up." });
  }

  // ---- selected-day detail ----
  if (state.openDay) {
    const e = days.get(state.openDay);
    const panel = host.createDiv({ cls: "stashpad-cal-daypanel" });
    const ph = panel.createDiv({ cls: "stashpad-cal-daypanel-head" });
    ph.createSpan({ text: M(state.openDay, "YYYY-MM-DD").format("dddd, D MMMM YYYY") });
    ph.createSpan({ cls: "stashpad-index-count", text: `${e?.total ?? 0} action${(e?.total ?? 0) === 1 ? "" : "s"}` });
    const close = ph.createEl("button", { cls: "stashpad-trash-iconbtn", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    close.onclick = () => { state.openDay = null; rerender(); };
    const evs = (e?.events ?? []).slice().sort((a, b) => (b.ts).localeCompare(a.ts));
    for (const ev of evs) {
      const bucket = BUCKET_OF[ev.type];
      const rowEl = panel.createDiv({ cls: "stashpad-heat-event" });
      const ic = rowEl.createSpan({ cls: "stashpad-heat-eventic" }); setIcon(ic, BUCKET_META[bucket]?.icon ?? "circle");
      const note = byId.get(ev.id);
      const label = describeEvent(ev, note?.title);
      rowEl.createSpan({ cls: "stashpad-heat-eventlabel", text: label });
      const meta = rowEl.createSpan({ cls: "stashpad-heat-eventmeta" });
      meta.setText(M(Date.parse(ev.ts)).format("HH:mm") + (ev.author ? ` · ${ev.author}` : ""));
      if (note) { rowEl.addClass("is-openable"); rowEl.onclick = () => opts.onOpen(note.folder, note.id); }
    }
  }
}

function describeEvent(ev: LogEvent, title?: string): string {
  const who = title ? `"${title}"` : (typeof ev.payload?.path === "string" ? basename(ev.payload.path) : ev.id);
  switch (ev.type) {
    case "create": return `Created ${who}`;
    case "edit": return `Edited ${who}`;
    case "external_edit": return `Edited ${who} (outside Stashpad)`;
    case "open": return `Viewed ${who}`;
    case "complete": return `Completed ${who}`;
    case "uncomplete": return `Reopened ${who}`;
    case "parent_change": return `Moved ${who}`;
    case "reorder": return `Reordered ${who}`;
    case "rename": return `Renamed ${who}`;
    case "attachment_add": return `Added a file to ${who}`;
    case "attachment_remove": return `Removed a file from ${who}`;
    case "lock": return `Encrypted ${who}`;
    case "unlock": return `Decrypted ${who}`;
    case "archive": return `Archived ${who}`;
    case "restore": return `Restored ${who}`;
    case "delete": return `Deleted ${who}`;
    case "missing": return `${who} went missing`;
    case "palette_color_add": return "Added a palette color";
    case "palette_color_remove": return "Removed a palette color";
    case "stash_export": return `Exported ${who}`;
    case "stash_import": return `Imported ${who}`;
    case "archive_migration": return "Archive maintenance";
    default: return `${ev.type} ${who}`;
  }
}

function basename(p: string): string { return (p.split("/").pop() || p).replace(/-[a-z0-9]{4,12}\.md$/, "").replace(/\.md$/, "").replace(/-/g, " ") || p; }
