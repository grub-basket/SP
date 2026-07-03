import { App, Notice, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { collectTasks, type TaskItem } from "./task-collect";
import { DueDatePickerModal } from "./modals";
import { formatDateOnly, formatTimeOnly } from "./format";

type Section = "overdue" | "today" | "upcoming" | "nodate" | "completed";

// Unique <datalist> id per render (avoids id collisions when the modal + tab are
// both mounted). Grows across re-renders — harmless; old nodes are removed.
let dlSeq = 0;

const SECTIONS: Array<{ key: Section; label: string; icon: string }> = [
  { key: "overdue", label: "Overdue", icon: "alert-circle" },
  { key: "today", label: "Due today", icon: "calendar-clock" },
  { key: "upcoming", label: "Upcoming", icon: "calendar" },
  { key: "nodate", label: "No date", icon: "inbox" },
  { key: "completed", label: "Completed", icon: "check-circle-2" },
];

/** Caller-owned filter state — survives the renderer's own re-renders because the
 *  same object is passed back each time (kept on the modal/view instance). */
export interface TaskTriageState {
  /** 0.131.2: relationship filter ONLY (the dropdown). Person filtering moved to
   *  its own `person` field so the two compose (AND) instead of competing. */
  assign: "all" | "mine" | "others" | "byme" | "unassigned";
  person: string;          // "" = any; else a person id (author/assignee/assigner)
  folder: string;          // "all" | folder path
  status: "all" | Section; // status chip
}
export function defaultTaskTriageState(): TaskTriageState {
  return { assign: "all", person: "", folder: "all", status: "all" };
}

export interface TaskTriageOpts {
  /** Open the underlying note. The modal closes itself here; the tab navigates. */
  onOpen: (folder: string, id: string) => void;
}

/** 0.126.2: shared "grouped task triage" — filter bar (assignment / folder /
 *  status, matching the Tasks panel) + grouped sections + per-row
 *  complete/snooze/open. Owns `host` and re-renders itself after a filter
 *  change or a complete/snooze. Used by the Daily-review MODAL and the full-tab
 *  "All tasks" aggregate so they never diverge. Writes frontmatter directly
 *  (no undo — matches the panel's quick edits). */
export function renderTaskTriage(
  host: HTMLElement, app: App, plugin: StashpadPlugin, state: TaskTriageState, opts: TaskTriageOpts,
): void {
  const rerender = (): void => renderTaskTriage(host, app, plugin, state, opts);
  host.empty();
  host.addClass("stashpad-task-triage");

  const allTasks = collectTasks(app, plugin);

  // ---- Assignment filter (mirrors the panel) ----
  const meId = (plugin.settings.authorId ?? "").trim();
  const isMine = (t: TaskItem) => !!meId && t.assignedTo.some((a) => a.id === meId);
  const assignMatches = (t: TaskItem): boolean => {
    switch (state.assign) {
      case "mine": return isMine(t);
      case "others": return t.assignedTo.length > 0 && !isMine(t);
      case "byme": return !!meId && t.assignedBy?.id === meId;
      case "unassigned": return t.assignedTo.length === 0;
      default: return true;
    }
  };
  // 0.131.2: the person filter is its own dimension — a task matches if the
  // chosen person is its author, an assignee, or the assigner. ANDs with the
  // relationship dropdown so the two compose instead of being redundant.
  const personMatches = (t: TaskItem): boolean =>
    !state.person || t.assignedTo.some((a) => a.id === state.person) || t.author?.id === state.person || t.assignedBy?.id === state.person;
  const people = new Map<string, string>();
  // 0.131.1: build the person list from EVERY person on a task — assignees,
  // assigners, AND authors. Most tasks have an author but no assignee, so the
  // author is how you find your own tasks (e.g. yourself). Self is included.
  for (const t of allTasks) {
    for (const a of t.assignedTo) people.set(a.id, a.name);
    if (t.assignedBy) people.set(t.assignedBy.id, t.assignedBy.name);
    if (t.author) people.set(t.author.id, t.author.name);
  }
  const personOpts = [...people.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  // Folder filter — reset if the selected folder no longer has tasks.
  const folders = [...new Set(allTasks.map((t) => t.folder))].sort((a, b) => a.localeCompare(b));
  if (state.folder !== "all" && !folders.includes(state.folder)) state.folder = "all";
  const folderMatches = (t: TaskItem): boolean => state.folder === "all" || t.folder === state.folder;

  // ---- Filter bar ----
  const bar = host.createDiv({ cls: "stashpad-triage-filters" });
  // 0.131.0: reset THIS row's filters (assignment / folder / author) back to
  // "all" — leaves the status chips below untouched.
  const rowReset = bar.createEl("button", { cls: "stashpad-triage-reset", attr: { "aria-label": "Reset filters" } });
  setIcon(rowReset, "rotate-ccw");
  rowReset.onclick = () => { state.assign = "all"; state.person = ""; state.folder = "all"; rerender(); };
  // Relationship dropdown ONLY (no per-person list — that's the search beside it).
  const assignSel = bar.createEl("select", { cls: "stashpad-triage-select" });
  const relLabel: Record<string, string> = { all: "Everyone", mine: "Assigned to me", others: "Assigned to others", byme: "Assigned by me", unassigned: "Unassigned" };
  for (const v of ["all", "mine", "others", "byme", "unassigned"] as const) {
    const o = assignSel.createEl("option", { text: relLabel[v], value: v });
    if (state.assign === v) o.selected = true;
  }
  assignSel.onchange = () => { state.assign = assignSel.value as TaskTriageState["assign"]; rerender(); };

  const folderSel = bar.createEl("select", { cls: "stashpad-triage-select" });
  const allOpt = folderSel.createEl("option", { text: "All folders", value: "all" });
  if (state.folder === "all") allOpt.selected = true;
  for (const f of folders) {
    const o = folderSel.createEl("option", { text: f.split("/").pop() || f, value: f });
    if (state.folder === f) o.selected = true;
  }
  folderSel.onchange = () => { state.folder = folderSel.value; rerender(); };

  // 0.131.2: the person filter — a searchable input (native <datalist> of every
  // person on a task: authors, assignees, assigners). Its OWN dimension, ANDed
  // with the relationship dropdown (no longer duplicated as a "By person" list).
  if (personOpts.length > 0) {
    const nameToId = new Map<string, string>();
    for (const p of personOpts) if (!nameToId.has(p.name)) nameToId.set(p.name, p.id);
    const dlId = `stashpad-task-authors-${++dlSeq}`;
    const authorWrap = bar.createDiv({ cls: "stashpad-triage-authorwrap" });
    const authorInput = authorWrap.createEl("input", {
      cls: "stashpad-triage-authorsearch",
      attr: { type: "text", list: dlId, placeholder: "Any person…", spellcheck: "false" },
    });
    const clearX = authorWrap.createEl("button", { cls: "stashpad-triage-authorclear", attr: { "aria-label": "Clear person filter" } });
    setIcon(clearX, "x");
    clearX.onclick = () => { authorInput.value = ""; if (state.person) { state.person = ""; rerender(); } else authorInput.focus(); };
    const dl = authorWrap.createEl("datalist");
    dl.id = dlId;
    for (const p of personOpts) dl.createEl("option", { value: p.name });
    if (state.person) authorInput.value = people.get(state.person) ?? "";
    const applyAuthor = (): void => {
      const v = authorInput.value.trim();
      if (v === "") { if (state.person) { state.person = ""; rerender(); } return; }
      const id = nameToId.get(v);
      if (id && state.person !== id) { state.person = id; rerender(); }
    };
    authorInput.onchange = applyAuthor;
    authorInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyAuthor(); });
  }

  // ---- Bucket (after assignment + folder filters) ----
  const now = Date.now();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const startTodayMs = start.getTime();
  const endTodayMs = startTodayMs + 86_400_000;
  const filtered = allTasks.filter((t) => assignMatches(t) && personMatches(t) && folderMatches(t));
  const buckets: Record<Section, TaskItem[]> = { overdue: [], today: [], upcoming: [], nodate: [], completed: [] };
  for (const t of filtered) {
    if (t.completed) { buckets.completed.push(t); continue; }
    if (t.due == null) { buckets.nodate.push(t); continue; }
    if (t.due < startTodayMs) buckets.overdue.push(t);
    else if (t.due < endTodayMs) buckets.today.push(t);
    else buckets.upcoming.push(t);
  }
  const byDue = (a: TaskItem, b: TaskItem): number => {
    if (a.due == null && b.due == null) return a.title.localeCompare(b.title);
    if (a.due == null) return 1;
    if (b.due == null) return -1;
    return a.due - b.due;
  };

  // Status chips (All + per-section counts).
  const chips = host.createDiv({ cls: "stashpad-triage-chips" });
  const mkChip = (key: "all" | Section, label: string, count: number): void => {
    const c = chips.createEl("button", { cls: "stashpad-triage-chip" });
    if (state.status === key) c.addClass("is-active");
    c.createSpan({ text: label });
    c.createSpan({ cls: "stashpad-triage-chip-count", text: String(count) });
    c.onclick = () => { state.status = key; rerender(); };
  };
  mkChip("all", "All", filtered.length);
  for (const s of SECTIONS) mkChip(s.key, s.label, buckets[s.key].length);

  if (filtered.length === 0) {
    host.createDiv({ cls: "stashpad-tasks-empty" }).setText(allTasks.length === 0
      ? "No tasks yet — press G on a note to make it a task, or D to give it a due date."
      : "No tasks match the current filters.");
    return;
  }

  const toggleCompleted = async (t: TaskItem): Promise<void> => {
    try { await app.fileManager.processFrontMatter(t.file, (m: any) => { m.completed = !(m.completed === true); }); }
    catch (e) { new Notice(`Couldn't update task: ${(e as Error).message}`); return; }
    rerender();
  };
  const snooze = (t: TaskItem): void => {
    const current = t.dueRaw ?? (t.due != null ? new Date(t.due).toISOString() : null);
    new DueDatePickerModal(app, current, (result) => {
      void app.fileManager.processFrontMatter(t.file, (m: any) => {
        if (result.iso === null) delete m.due;
        else { m.due = result.iso; m.task = true; }
      }).then(rerender).catch((e: any) => new Notice(`Couldn't snooze: ${(e as Error).message}`));
    }, { title: "Snooze — reschedule", hideAssignees: true, quickAdjusts: plugin.settings.dueQuickAdjusts }).open();
  };

  const shown = state.status === "all" ? SECTIONS : SECTIONS.filter((s) => s.key === state.status);
  let any = false;
  for (const sec of shown) {
    const items = buckets[sec.key];
    if (items.length === 0) continue;
    any = true;
    items.sort(sec.key === "completed" ? (a, b) => byDue(b, a) : byDue);
    // In single-status mode the chip already names the bucket; skip the header.
    if (state.status === "all") {
      const header = host.createDiv({ cls: `stashpad-review-section is-${sec.key}` });
      setIcon(header.createSpan({ cls: "stashpad-review-section-icon" }), sec.icon);
      header.createSpan({ cls: "stashpad-review-section-name", text: sec.label });
      header.createSpan({ cls: "stashpad-review-section-count", text: String(items.length) });
    }
    const body = host.createDiv({ cls: "stashpad-review-list" });
    for (const t of items) renderRow(body, t, now, plugin, { toggleCompleted, snooze, onOpen: opts.onOpen });
  }
  if (!any) host.createDiv({ cls: "stashpad-tasks-empty" }).setText("Nothing in this view.");
}

function renderRow(
  parent: HTMLElement, t: TaskItem, now: number, plugin: StashpadPlugin,
  acts: { toggleCompleted: (t: TaskItem) => void; snooze: (t: TaskItem) => void; onOpen: (folder: string, id: string) => void },
): void {
  const row = parent.createDiv({ cls: "stashpad-review-row" });
  if (t.completed) row.addClass("is-completed");

  const check = row.createSpan({ cls: "stashpad-review-check" });
  setIcon(check, t.completed ? "check-square" : "square");
  if (t.color) check.style.color = t.color;
  check.title = t.completed ? "Mark not done" : "Mark done";
  check.onclick = () => acts.toggleCompleted(t);

  const main = row.createDiv({ cls: "stashpad-review-main" });
  const title = main.createDiv({ cls: "stashpad-review-title", text: t.title });
  title.onclick = () => acts.onOpen(t.folder, t.id);
  const meta = main.createDiv({ cls: "stashpad-review-meta" });
  meta.createSpan({ cls: "stashpad-review-folder", text: t.folder.split("/").pop() || t.folder });
  // 0.131.1: show the author (creator) — most tasks have one but no assignee.
  if (t.author) meta.createSpan({ cls: "stashpad-review-author", text: `by ${t.author.name}` });
  if (t.due != null) {
    const overdue = t.due < now && !t.completed;
    // Calendar "today" (midnight→midnight), matching the bucket boundaries —
    // a ±24h window mislabels yesterday-11pm / tomorrow-9am as today and then
    // renders them time-only with no date. (0.140.5 review.)
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const startTodayMs = startToday.getTime();
    const isToday = t.due >= startTodayMs && t.due < startTodayMs + 86_400_000;
    const dueEl = meta.createSpan({
      cls: "stashpad-review-due",
      text: isToday ? formatTimeOnly(t.due, plugin.settings) : formatDateOnly(t.due, plugin.settings),
    });
    if (overdue) dueEl.addClass("is-overdue");
  } else if (t.dueRaw) {
    meta.createSpan({ cls: "stashpad-review-due", text: t.dueRaw });
  } else {
    meta.createSpan({ cls: "stashpad-review-due is-none", text: "no date" });
  }
  for (const a of t.assignedTo) meta.createSpan({ cls: "stashpad-review-assignee", text: a.name });

  const actions = row.createDiv({ cls: "stashpad-review-actions" });
  const snoozeBtn = actions.createEl("button", { cls: "stashpad-review-btn" });
  setIcon(snoozeBtn, "alarm-clock");
  snoozeBtn.title = "Snooze — reschedule";
  snoozeBtn.onclick = () => acts.snooze(t);
  const open = actions.createEl("button", { cls: "stashpad-review-btn" });
  setIcon(open, "arrow-right");
  open.title = "Open note";
  open.onclick = () => acts.onOpen(t.folder, t.id);
}
