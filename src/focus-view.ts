import { ItemView, Menu, SuggestModal, WorkspaceLeaf, setIcon, type App, type TFile, type ViewStateResult } from "obsidian";
import { siftRank } from "./suggest-match";
import type StashpadPlugin from "./main";
import { STASHPAD_FOCUS_VIEW_TYPE, siftMatch, type StashpadId } from "./types";
import { addCopyTabLinkItem } from "./tab-link-menu";
import { returnToOriginOnClose } from "./leaf-return";
import { settleNewTab } from "./view-helpers";
import { notify } from "./notify";
import { focusKey, titleFromText, type FocusNote, type FocusService } from "./focus-service";
import { dayKey, formatSpent, type FocusMode } from "./focus-time";
import { parseDueString } from "./due-warmth";
import { formatDateOnly, formatDateTime } from "./format";

interface FocusViewState { single?: boolean }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** 0.577.0: FOCUS VIEW — today's task list plus a pomodoro / stopwatch timer.
 *
 *  - "Add tasks" opens a multi-select search over every Stashpad note (open
 *    tasks first); the picks get `focusDate: <today>` and become tasks.
 *  - ▶ on a row times that task. Work stretches are appended to the note's
 *    `timeLog` frontmatter (see focus-time.ts); breaks aren't logged.
 *  - "One at a time" hides the list and shows just the current task, big, with
 *    Done & next / Skip.
 *  - Unfinished tasks from earlier days show as a carry-over banner.
 *
 *  The timer itself lives in FocusService (plugin-level), so closing this tab
 *  doesn't stop it; the status bar keeps ticking. */
export class StashpadFocusView extends ItemView {
  private single = false;
  /** 0.583.0: the task picked with "Choose task" in One-at-a-time mode while
   *  no timer runs (`folder::id`). Falls back to the first open task. */
  private chosenKey: string | null = null;
  private showSettings = false;
  private showCarry = false;
  private notes: FocusNote[] | null = null;
  private clockEls: HTMLElement[] = [];
  private structKey = "";
  private renderTimer: number | null = null;
  private dirty = false;
  private dragKey: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  private get svc(): FocusService { return this.plugin.focus; }

  getViewType(): string { return STASHPAD_FOCUS_VIEW_TYPE; }
  getDisplayText(): string { return "Focus — today"; }
  getIcon(): string { return "target"; }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    addCopyTabLinkItem(menu, this.plugin, this.leaf);
  }

  getState(): Record<string, unknown> { return { ...super.getState(), single: this.single }; }
  async setState(state: FocusViewState, result: unknown): Promise<void> {
    if (state && typeof state.single === "boolean") this.single = state.single;
    await super.setState(state, result as ViewStateResult);
    this.render();
  }

  async onOpen(): Promise<void> {
    // Timer ticks repaint only the clock; anything structural re-renders.
    this.register(this.svc.onChange((reason) => {
      if (reason === "tick" && this.structKey === this.computeStructKey()) this.paintClocks();
      else { this.notes = null; this.scheduleRender(0); }
    }));
    const relevant = (path: string, parent: string | undefined): boolean =>
      path.endsWith(".md") && this.plugin.stashpadFolderMemoHas(parent ?? "") !== false;
    this.registerEvent(this.app.metadataCache.on("changed", (f) => { if (relevant(f.path, f.parent?.path)) this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (f.path.endsWith(".md")) this.scheduleRender(); }));
    this.registerEvent(this.app.vault.on("rename", (f) => { if (f.path.endsWith(".md")) this.scheduleRender(); }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf && this.dirty) { this.dirty = false; this.notes = null; this.render(); }
    }));
    // A day rollover while the tab sits open: re-render once a minute if the date moved.
    let day = dayKey(Date.now());
    this.registerInterval(window.setInterval(() => { const d = dayKey(Date.now()); if (d !== day) { day = d; this.notes = null; this.render(); } }, 60_000));
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.renderTimer != null) window.clearTimeout(this.renderTimer);
  }

  private scheduleRender(delay = 300): void {
    this.notes = null;
    if (!this.containerEl.offsetParent) { this.dirty = true; return; }
    if (this.renderTimer != null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => { this.renderTimer = null; this.render(); }, delay);
  }

  private persist(): void { this.app.workspace.requestSaveLayout(); }

  private computeStructKey(): string {
    const st = this.svc.state;
    return st ? `${st.path}|${st.running}|${st.phase}|${st.mode}|${st.rounds}` : "";
  }

  private paintClocks(): void {
    const t = this.svc.clockText();
    for (const el of this.clockEls) el.setText(t);
  }

  /** Named openNote, NOT open: View.open(parentEl) is what attaches a view to
   *  its tab, and shadowing it leaves the tab blank. */
  private openNote(n: { folder: string; id: string }): void {
    void this.plugin.revealNoteByRef(n.folder, n.id as StashpadId);
  }

  // ---- data ----

  private lists(): { today: FocusNote[]; open: FocusNote[]; done: FocusNote[]; carry: FocusNote[] } {
    if (!this.notes) this.notes = this.svc.collectNotes();
    const todayKey = dayKey(Date.now());
    const today = this.svc.sortToday(this.notes.filter((n) => n.focusDate === todayKey));
    const carry = this.notes
      .filter((n) => n.focusDate != null && n.focusDate < todayKey && !n.done)
      .sort((a, b) => (a.focusDate ?? "").localeCompare(b.focusDate ?? "") || a.title.localeCompare(b.title));
    return { today, open: today.filter((n) => !n.done), done: today.filter((n) => n.done), carry };
  }

  // ---- render ----

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-focus");
    root.toggleClass("is-single", this.single);
    this.clockEls = [];
    this.structKey = this.computeStructKey();

    const { today, open, done, carry } = this.lists();
    const st = this.svc.state;
    // 0.583.0: real first-line titles for on-screen notes the render cache
    // doesn't know yet (emits one change → re-render when any title differs).
    void this.svc.warmTitles([...today, ...carry]);

    // ---- header ----
    const bar = root.createDiv({ cls: "stashpad-focus-bar" });
    const titleWrap = bar.createDiv({ cls: "stashpad-focus-heading" });
    titleWrap.createEl("h3", { cls: "stashpad-focus-title", text: "Today" });
    titleWrap.createSpan({
      cls: "stashpad-focus-date",
      text: new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    });
    const trackedToday = today.reduce((s, n) => s + n.todaySec, 0);
    bar.createSpan({
      cls: "stashpad-focus-summary",
      text: today.length ? `${done.length}/${today.length} done · ${formatSpent(trackedToday)} tracked` : "",
    });
    const actions = bar.createDiv({ cls: "stashpad-focus-actions" });
    this.button(actions, "plus", "Add tasks", "Search notes and tasks to add to today", () => this.openPicker(), true);
    this.button(actions, this.single ? "list" : "crosshair", this.single ? "Show list" : "One at a time",
      this.single ? "Show the whole list" : "Show just the current task", () => { this.single = !this.single; this.persist(); this.render(); });
    this.button(actions, "settings-2", "", "Timer settings", () => { this.showSettings = !this.showSettings; this.render(); });

    if (this.showSettings) this.renderSettings(root);

    // ---- carry-over ----
    if (carry.length && !this.single) this.renderCarry(root, carry);

    // ---- timer card ----
    if (st) this.chosenKey = null; // a running/paused timer supersedes the "Choose task" pick
    const current = st ? (today.find((n) => n.file.path === st.path) ?? null) : null;
    const chosen = this.chosenKey ? (open.find((n) => focusKey(n.folder, n.id) === this.chosenKey) ?? null) : null;
    const firstUp = chosen ?? open[0] ?? null;
    // "Up next" never repeats the task the card already shows (timed or up first).
    const shownPath = st?.path ?? firstUp?.file.path;
    const nextUp = open.find((n) => n.file.path !== shownPath) ?? null;
    this.renderTimer_(root, current, firstUp, nextUp, open);

    if (this.single) return;

    // ---- list ----
    if (!today.length) {
      const empty = root.createDiv({ cls: "stashpad-focus-empty" });
      empty.createDiv({ text: "Nothing on today's list yet." });
      const b = empty.createEl("button", { cls: "mod-cta", text: "Add tasks…" });
      b.onclick = () => this.openPicker();
      return;
    }
    const list = root.createDiv({ cls: "stashpad-focus-list" });
    for (const n of open) this.renderRow(list, n, open);
    if (done.length) {
      root.createDiv({ cls: "stashpad-focus-section", text: `Done (${done.length})` });
      const dl = root.createDiv({ cls: "stashpad-focus-list is-done" });
      for (const n of done) this.renderRow(dl, n, null);
    }
  }

  private button(host: HTMLElement, icon: string, label: string, tip: string, onClick: () => void, cta = false): HTMLButtonElement {
    const b = host.createEl("button", { cls: "stashpad-focus-btn" + (cta ? " mod-cta" : ""), attr: { "aria-label": tip } });
    const i = b.createSpan({ cls: "stashpad-focus-btn-icon" });
    setIcon(i, icon);
    if (label) b.createSpan({ text: label });
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  }

  private renderSettings(root: HTMLElement): void {
    const s = this.plugin.settings;
    const box = root.createDiv({ cls: "stashpad-focus-settings" });
    const num = (label: string, key: "focusWorkMin" | "focusShortBreakMin" | "focusLongBreakMin" | "focusLongBreakEvery", min: number): void => {
      const row = box.createEl("label", { cls: "stashpad-focus-setting" });
      row.createSpan({ text: label });
      const inp = row.createEl("input", { attr: { type: "number", min: String(min), max: "240", step: "1" } });
      inp.value = String(s[key]);
      inp.onchange = () => {
        const v = Math.round(Number(inp.value));
        if (!Number.isFinite(v) || v < min) { inp.value = String(s[key]); return; }
        s[key] = Math.min(240, v);
        void this.plugin.saveSettings();
      };
    };
    num("Focus (min)", "focusWorkMin", 1);
    num("Short break (min)", "focusShortBreakMin", 1);
    num("Long break (min)", "focusLongBreakMin", 1);
    num("Long break every (0 = never)", "focusLongBreakEvery", 0);
    box.createDiv({
      cls: "stashpad-focus-hint",
      text: "Time you track is saved in each note's frontmatter (focusLog, focusMinutes). Breaks aren't logged. A new length applies from the next pomodoro.",
    });
  }

  private renderCarry(root: HTMLElement, carry: FocusNote[]): void {
    const box = root.createDiv({ cls: "stashpad-focus-carry" });
    const head = box.createDiv({ cls: "stashpad-focus-carry-head" });
    head.createSpan({ text: `${plural(carry.length, "unfinished task")} from earlier days` });
    const acts = head.createDiv({ cls: "stashpad-focus-actions" });
    this.button(acts, "arrow-down-to-line", "Move all to today", "Put them on today's list", () => void this.svc.setFocus(carry.map((n) => n.file), true));
    this.button(acts, this.showCarry ? "chevron-up" : "chevron-down", this.showCarry ? "Hide" : "Show", "List them", () => { this.showCarry = !this.showCarry; this.render(); });
    this.button(acts, "x", "Clear", "Take them off the list (they stay tasks; undo with the Stashpad undo)", () => void this.svc.setFocus(carry.map((n) => n.file), false));
    if (!this.showCarry) return;
    const list = box.createDiv({ cls: "stashpad-focus-carry-list" });
    for (const n of carry) {
      const row = list.createDiv({ cls: "stashpad-focus-carry-row" });
      const t = row.createSpan({ cls: "stashpad-focus-row-title", text: n.title || "Untitled" });
      t.onclick = () => this.openNote(n);
      row.createSpan({ cls: "stashpad-focus-meta", text: `${n.focusDate} · ${this.folderName(n.folder)}` });
      this.button(row, "arrow-down-to-line", "Today", "Move to today", () => void this.svc.setFocus([n.file], true));
    }
  }

  private folderName(folder: string): string { return folder.split("/").pop() || folder || "/"; }

  /** The timer card. `current` = the timed note if it's on today's list. */
  private renderTimer_(root: HTMLElement, current: FocusNote | null, firstOpen: FocusNote | null, nextUp: FocusNote | null, open: FocusNote[]): void {
    const st = this.svc.state;
    const card = root.createDiv({ cls: "stashpad-focus-timer" + (st ? "" : " is-idle") });
    if (st) {
      card.toggleClass("is-running", st.running);
      card.toggleClass("is-break", st.phase === "break");
    }

    // Mode switch. 0.589.0: Stopwatch first (the everyday timer), and a big
    // segmented control with icons rather than a small pill.
    const modeRow = card.createDiv({ cls: "stashpad-focus-modes", attr: { role: "radiogroup", "aria-label": "Timer type" } });
    const mode: FocusMode = st?.mode ?? this.plugin.settings.focusDefaultMode ?? "stopwatch";
    for (const [m, label, icon] of [["stopwatch", "Stopwatch", "watch"], ["pomodoro", "Pomodoro", "timer"]] as [FocusMode, string, string][]) {
      const b = modeRow.createEl("button", { cls: "stashpad-focus-mode" + (m === mode ? " is-active" : ""), attr: { role: "radio", "aria-checked": String(m === mode) } });
      setIcon(b.createSpan({ cls: "stashpad-focus-mode-icon" }), icon);
      b.createSpan({ text: label });
      b.onclick = () => void this.svc.setMode(m);
    }

    const target = st ? null : firstOpen;
    const name = card.createDiv({ cls: "stashpad-focus-current" });
    if (st) {
      const phase = st.phase === "break" ? "Break" : st.mode === "pomodoro" ? `Focus${st.rounds ? ` · 🍅 ${st.rounds}` : ""}` : "Stopwatch";
      name.createDiv({ cls: "stashpad-focus-phase", text: st.running ? phase : `${phase} · paused` });
      const t = name.createDiv({ cls: "stashpad-focus-current-title", text: st.title || "Untitled", attr: { role: "button", tabindex: "0" } });
      t.onclick = () => this.openNote(st);
      if (current) name.createDiv({ cls: "stashpad-focus-meta", text: `${formatSpent(current.todaySec)} today · ${formatSpent(current.totalSec)} total` });
      else name.createDiv({ cls: "stashpad-focus-meta", text: "Not on today's list" });
    } else if (target) {
      name.createDiv({ cls: "stashpad-focus-phase", text: "Up first" });
      const t = name.createDiv({ cls: "stashpad-focus-current-title", text: target.title || "Untitled", attr: { role: "button", tabindex: "0" } });
      t.onclick = () => this.openNote(target);
    } else {
      name.createDiv({ cls: "stashpad-focus-phase", text: "Pick a task and press ▶ to start" });
    }

    const clock = card.createDiv({ cls: "stashpad-focus-clock", attr: { "aria-live": "off" } });
    clock.setText(st ? this.svc.clockText() : mode === "pomodoro" ? `${String(this.svc.cfg().workMin).padStart(2, "0")}:00` : "00:00");
    if (st) this.clockEls.push(clock);

    const ctl = card.createDiv({ cls: "stashpad-focus-controls" });
    if (st) {
      this.button(ctl, st.running ? "pause" : "play", st.running ? "Pause" : st.phase === "break" ? "Resume break" : "Start", st.running ? "Pause" : "Start", () => void this.svc.toggle(), true);
      if (st.phase === "break") this.button(ctl, "skip-forward", "Skip break", "End the break now", () => this.svc.skipBreak());
      this.button(ctl, "square", "Stop", "Stop timing (logs the time so far)", () => void this.svc.stop());
      const file = current?.file ?? this.app.vault.getFileByPath(st.path);
      if (file) {
        this.button(ctl, "check", this.single ? "Done & next" : "Done", "Mark this task complete", () => void (async () => {
          await this.svc.setCompleted(file, true);
          if (this.single && nextUp) await this.svc.start(nextUp);
        })());
      }
      if (this.single && nextUp) this.button(ctl, "arrow-right", "Skip", `Switch to “${nextUp.title}”`, () => void this.svc.start(nextUp));
    } else if (target) {
      this.button(ctl, "play", "Start", `Start timing “${target.title}”`, () => void this.svc.start(target), true);
    } else {
      this.button(ctl, "plus", "Add tasks", "Search notes and tasks to add to today", () => this.openPicker(), true);
    }

    // 0.583.0: One at a time — pick which open task to focus on.
    if (this.single && open.length > 1) {
      const shown = st?.path ?? target?.file.path ?? null;
      const b = this.button(ctl, "list-checks", "Choose task", "Pick which task to focus on", () => {
        const menu = new Menu();
        for (const n of open) {
          menu.addItem((it) => it.setTitle(n.title || "Untitled").setChecked(n.file.path === shown).onClick(() => void this.chooseTask(n)));
        }
        const r = b.getBoundingClientRect();
        menu.showAtPosition({ x: r.left, y: r.bottom });
      });
    }

    if (this.single && nextUp) card.createDiv({ cls: "stashpad-focus-next", text: `Up next: ${nextUp.title}` });
  }

  /** "Choose task": a running timer switches to the task (its time so far is
   *  logged to the old one); a paused or no timer makes it the task up first. */
  private async chooseTask(n: FocusNote): Promise<void> {
    const st = this.svc.state;
    if (st && st.path === n.file.path) return;
    if (st?.running) { await this.svc.start(n); return; }
    if (st) await this.svc.stop(); // paused: its time is already logged
    this.chosenKey = focusKey(n.folder, n.id);
    this.render();
  }

  private renderRow(list: HTMLElement, n: FocusNote, reorderable: FocusNote[] | null): void {
    const st = this.svc.state;
    const active = !!st && st.path === n.file.path;
    const row = list.createDiv({ cls: "stashpad-focus-row" + (active ? " is-active" : "") + (n.done ? " is-completed" : "") });
    if (n.color) row.style.setProperty("--stashpad-focus-color", n.color);

    const cb = row.createEl("input", { cls: "task-list-item-checkbox stashpad-focus-check", attr: { type: "checkbox", "aria-label": n.done ? "Mark incomplete" : "Mark complete" } });
    cb.checked = n.done;
    cb.onclick = (e) => { e.stopPropagation(); void this.svc.setCompleted(n.file, !n.done); };

    if (!n.done) {
      const running = active && !!st?.running;
      const play = row.createEl("button", { cls: "stashpad-focus-play clickable-icon", attr: { "aria-label": running ? "Pause" : active ? "Resume" : `Start timing “${n.title}”` } });
      setIcon(play, running ? "pause" : "play");
      play.onclick = (e) => { e.stopPropagation(); void (active ? this.svc.toggle() : this.svc.start(n)); };
    }

    const body = row.createDiv({ cls: "stashpad-focus-row-body", attr: { role: "button", tabindex: "0" } });
    body.createDiv({ cls: "stashpad-focus-row-title", text: n.title || "Untitled" });
    const meta: string[] = [this.folderName(n.folder)];
    if (n.todaySec) meta.push(`${formatSpent(n.todaySec)} today`);
    if (n.totalSec && n.totalSec !== n.todaySec) meta.push(`${formatSpent(n.totalSec)} total`);
    // 0.578.0: a roll-forward repeating task ticked today: done for today, back on its next due.
    if (n.done && !n.completed && n.repeats && n.due) {
      const ms = parseDueString(n.due);
      meta.push(`🔁 next: ${Number.isFinite(ms) ? formatDateOnly(ms, this.plugin.settings) : n.due}`);
    }
    body.createDiv({ cls: "stashpad-focus-meta", text: meta.join(" · ") });
    if (active) { const c = body.createDiv({ cls: "stashpad-focus-row-clock", text: this.svc.clockText() }); this.clockEls.push(c); }
    body.onclick = () => this.openNote(n);
    body.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openNote(n); } });

    const rm = row.createEl("button", { cls: "stashpad-focus-remove clickable-icon", attr: { "aria-label": "Remove from today (stays a task)" } });
    setIcon(rm, "x");
    rm.onclick = (e) => { e.stopPropagation(); void this.svc.setFocus([n.file], false); };

    // Drag to reorder (open tasks only).
    if (!reorderable) return;
    const key = focusKey(n.folder, n.id);
    row.setAttr("draggable", "true");
    row.addEventListener("dragstart", (e) => { this.dragKey = key; row.addClass("is-dragging"); try { e.dataTransfer?.setData("text/plain", key); } catch { /* ignore */ } });
    row.addEventListener("dragend", () => { this.dragKey = null; row.removeClass("is-dragging"); });
    row.addEventListener("dragover", (e) => { if (this.dragKey && this.dragKey !== key) { e.preventDefault(); row.addClass("is-dragover"); } });
    row.addEventListener("dragleave", () => row.removeClass("is-dragover"));
    row.addEventListener("drop", (e) => {
      e.preventDefault(); row.removeClass("is-dragover");
      const from = this.dragKey; this.dragKey = null;
      if (!from || from === key) return;
      const keys = reorderable.map((x) => focusKey(x.folder, x.id)).filter((k) => k !== from);
      keys.splice(keys.indexOf(key), 0, from);
      // Keep done ones' positions after the open ones so nothing is lost.
      const rest = (this.plugin.settings.focusOrder ?? []).filter((k) => !keys.includes(k));
      this.svc.setOrder([...keys, ...rest]);
      this.render();
    });
  }

  private openPicker(): void {
    new FocusPickerModal(this.app, this.plugin, async (picked) => {
      if (!picked.length) return;
      const count = await this.svc.setFocus(picked.map((n) => n.file), true);
      notify(`Added ${plural(count, "task")} to today.`, { kind: "success" });
    }, async (file, text) => {
      // 0.583.0: a note made from the picker's "Create new" — onto today's list as a task.
      await this.svc.setFocus([file], true);
      notify(`Created “${text}” and added it to today.`, { kind: "success" });
    }).open();
  }
}

/** One picker row: an existing note, or the "Create new" offer. */
type PickItem =
  | { kind: "note"; n: FocusNote; title: string; body: string; hit: string }
  | { kind: "create"; text: string };

const stripFm = (md: string): string => {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  return end === -1 ? md : md.slice(end + 4).replace(/^\r?\n/, "");
};

/** Multi-select search over every Stashpad note, with the same "Create new"
 *  offer as Stashpad's other pickers (0.583.0).
 *
 *  - Empty query: open tasks only (earlier days' first, then newest).
 *  - Typing: the FULL note search — titles (first heading / first line) Sift-
 *    ranked, then body-only hits (with the matching line), open tasks before
 *    other notes before done ones. Bodies load in the background and the query
 *    re-runs once they're in, like the global search.
 *  - `Create new: "…"` at the end when nothing matches the query exactly;
 *    Shift+Enter creates even when something does. A new note is created in the
 *    "New tasks go to" folder (footer), as a task on today's list, right away —
 *    the picker stays open for more.
 *  - Enter / click toggles a note; Mod+Enter or the button adds the selection.
 *  Notes already on today's list are left out. */
export class FocusPickerModal extends SuggestModal<PickItem> {
  private rows: Array<{ n: FocusNote; title: string; body: string }>;
  /** 0.589.0: every note's title by `folder::id`, for the "under <parent>" hint. */
  private titleByKey: Map<string, string>;
  private createBtn: HTMLButtonElement | null = null;
  private todayTitles: Set<string>;
  private picked = new Map<string, FocusNote>();
  private rowEls = new Map<string, HTMLElement>();
  private addBtn: HTMLButtonElement | null = null;
  private done = false;
  private closed = false;
  private creating = false;
  private createFolder: string;

  constructor(
    app: App,
    private plugin: StashpadPlugin,
    private onDone: (picked: FocusNote[]) => void | Promise<void>,
    private onCreated: (file: TFile, text: string) => Promise<void>,
  ) {
    super(app);
    const today = dayKey(Date.now());
    const cacheStore = plugin.renderCacheStore;
    // n.title is already the first line (read or cached) / filename.
    const all = plugin.focus.collectNotes();
    this.rows = all.filter((n) => n.focusDate !== today)
      .map((n) => ({ n, title: n.title, body: cacheStore.get(n.file.path)?.text ?? "" }));
    // Titles already on today's list too: "Create new" mustn't offer a duplicate of them.
    this.todayTitles = new Set(all.filter((n) => n.focusDate === today).map((n) => n.title.trim().toLowerCase()));
    this.titleByKey = new Map(all.map((n) => [focusKey(n.folder, n.id), n.title]));
    const folders = plugin.discoverStashpadFolders();
    const saved = plugin.settings.focusCreateFolder;
    // Only ever a folder the dropdown lists, so what it shows is where notes go.
    const active = plugin.activeStashpadFolder();
    this.createFolder = saved && folders.includes(saved) ? saved : active && folders.includes(active) ? active : (folders[0] ?? "");
    this.limit = 100;
    this.emptyStateText = "No matching notes.";
    this.setPlaceholder("Search notes and tasks, or type a new task…");
    this.setInstructions([
      { command: "↵", purpose: "select / unselect" },
      { command: "mod ↵", purpose: "add selected to today" },
      { command: "shift ↵", purpose: "create new" },
      { command: "esc", purpose: "cancel" },
    ]);
    this.scope.register(["Mod"], "Enter", (e) => {
      if (!this.picked.size) this.selectActiveSuggestion(e);
      this.finish();
      return false;
    });
    // Same force-create chord as StashpadSuggest: even when a note matches.
    this.scope.register(["Shift"], "Enter", () => { void this.createNew(this.inputEl.value); return false; });
    this.loadBodies();
  }

  /** Read every candidate's body in the background, then re-run the query. */
  private loadBodies(): void {
    const reads = this.rows.map((r) => this.app.vault.cachedRead(r.n.file).then((md) => {
      r.body = stripFm(md);
      // The body's real first line wins over a cached / filename title — also
      // for the "› parent" hint other rows show.
      const line = titleFromText(r.body);
      if (line) { r.title = line; this.titleByKey.set(focusKey(r.n.folder, r.n.id), line); }
    }, () => { /* unreadable: title-only */ }));
    void Promise.allSettled(reads).then(() => {
      if (this.closed) return;
      if (this.inputEl.value.trim()) this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  onOpen(): void {
    super.onOpen();
    this.modalEl.addClass("stashpad-focus-picker");
    const foot = this.modalEl.createDiv({ cls: "stashpad-focus-picker-foot" });
    const where = foot.createEl("label", { cls: "stashpad-focus-picker-where" });
    where.createSpan({ text: "New tasks go to" });
    const sel = where.createEl("select", { cls: "dropdown" });
    for (const f of this.plugin.discoverStashpadFolders()) {
      const o = sel.createEl("option", { text: f.split("/").pop() || f });
      o.value = f; o.title = f;
      if (f === this.createFolder) o.selected = true;
    }
    sel.onchange = () => {
      this.createFolder = sel.value;
      this.plugin.settings.focusCreateFolder = sel.value;
      void this.plugin.saveSettings();
      this.inputEl.focus();
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true })); // repaint the create row's folder
    };
    // 0.589.0: an always-visible Create button whenever something is typed —
    // the "Create new" row can sit below many results in a big vault.
    this.createBtn = foot.createEl("button", { cls: "stashpad-focus-picker-create" });
    this.createBtn.onclick = () => void this.createNew(this.inputEl.value);
    this.inputEl.addEventListener("input", () => this.syncCreateBtn());
    this.syncCreateBtn();
    this.addBtn = foot.createEl("button", { cls: "mod-cta" });
    this.addBtn.onclick = () => this.finish();
    this.syncButton();
  }

  private syncCreateBtn(): void {
    if (!this.createBtn) return;
    const q = this.inputEl.value.trim();
    this.createBtn.empty();
    setIcon(this.createBtn.createSpan({ cls: "stashpad-focus-btn-icon" }), "plus");
    this.createBtn.createSpan({ text: q ? `Create “${q.length > 32 ? q.slice(0, 31) + "…" : q}”` : "Type to create a task" });
    this.createBtn.disabled = !q;
    this.createBtn.setAttr("aria-label", q ? `Create a new task “${q}” in ${this.createFolder} and add it to today` : "Type a title to create a new task");
  }

  onClose(): void {
    this.closed = true;
    super.onClose();
    this.contentEl.empty();
  }

  private syncButton(): void {
    if (!this.addBtn) return;
    const n = this.picked.size;
    this.addBtn.setText(n ? `Add ${plural(n, "note")} to today` : "Select notes to add");
    this.addBtn.disabled = n === 0;
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    const picks = [...this.picked.values()];
    this.close();
    void this.onDone(picks);
  }

  /** Create a note from `raw` in the chosen folder and put it on today's list. */
  private async createNew(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.creating) return;
    // Never a second copy of something already on today's list (the button and
    // Shift+Enter force-create past other notes, not past today's own tasks).
    if (this.todayTitles.has(text.toLowerCase())) { notify(`“${text}” is already on today's list.`); return; }
    if (!this.createFolder) { notify("No Stashpad folder to create the task in."); return; }
    this.creating = true;
    try {
      const file = await this.plugin.createNoteInFolder(this.createFolder, text);
      if (!file) { notify(`Couldn't create “${text}”.`, { kind: "error" }); return; }
      await this.onCreated(file, text);
      if (this.closed) return;
      if (this.inputEl.value.trim() !== text) return; // typed something else meanwhile — keep it
      this.todayTitles.add(text.toLowerCase());
      this.inputEl.value = "";
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      this.inputEl.focus();
    } finally {
      this.creating = false;
    }
  }

  getSuggestions(query: string): PickItem[] {
    const q = query.trim();
    const bucket = (n: FocusNote): number => (n.task && !n.completed ? 0 : !n.task ? 1 : 2);
    if (!q) {
      return this.rows
        .filter((r) => r.n.task && !r.n.completed)
        .sort((a, b) => (b.n.focusDate ?? "").localeCompare(a.n.focusDate ?? "") || b.n.created - a.n.created)
        .slice(0, this.limit)
        .map((r) => ({ kind: "note" as const, ...r, hit: "" }));
    }
    // Title hits first, then body-only hits (newest first); within each band,
    // open tasks → other notes → done — except an exact title, which leads.
    // siftRank's key is the title alone, so its exact/prefix tiers judge the title.
    const byTitle = siftRank(q, this.rows, (r) => `${r.title} ${r.n.folder}`, (r) => r.title);
    const ql = q.toLowerCase();
    const isExact = (r: { title: string }): number => (r.title.trim().toLowerCase() === ql ? 0 : 1);
    const titleRank = new Map(byTitle.map((r, i) => [r, i]));
    const bodyOnly = this.rows.filter((r) => !titleRank.has(r) && siftMatch(q, `${r.title}\n${r.body}`));
    const first = q.toLowerCase().split(/\s+/)[0] ?? "";
    const items: PickItem[] = [...byTitle, ...bodyOnly]
      .sort((a, b) => {
        const ta = titleRank.has(a) ? 0 : 1, tb = titleRank.has(b) ? 0 : 1;
        return ta - tb || (ta === 0 ? isExact(a) - isExact(b) : 0) || bucket(a.n) - bucket(b.n)
          || (ta === 0 ? (titleRank.get(a)! - titleRank.get(b)!) : b.n.file.stat.mtime - a.n.file.stat.mtime);
      })
      // One slot short of the cap, so the Create row (added below) is never the
      // one SuggestModal trims off.
      .slice(0, this.limit - 1)
      .map((r) => ({
        kind: "note" as const, ...r,
        hit: titleRank.has(r) ? "" : (r.body.split(/\r?\n/).map((x) => x.trim()).find((x) => x.toLowerCase().includes(first)) ?? ""),
      }));
    const exact = this.todayTitles.has(ql) || this.rows.some((r) => r.title.trim().toLowerCase() === ql);
    // 0.589.0: with no TITLE match the offer leads (body hits are rarely what
    // you meant); otherwise it trails the matches, like Stashpad's other pickers.
    if (!exact) {
      if (byTitle.length === 0) items.unshift({ kind: "create", text: q });
      else items.push({ kind: "create", text: q });
    }
    return items;
  }

  renderSuggestion(item: PickItem, el: HTMLElement): void {
    el.addClass("stashpad-focus-pick");
    if (item.kind === "create") {
      el.addClass("is-create");
      setIcon(el.createSpan({ cls: "stashpad-focus-pick-box" }), "plus");
      const body = el.createDiv({ cls: "stashpad-focus-pick-body" });
      body.createDiv({ cls: "stashpad-focus-pick-title", text: `Create new: "${item.text}"` });
      body.createDiv({ cls: "stashpad-focus-meta", text: `New task in ${this.createFolder.split("/").pop() || this.createFolder}, added to today` });
      return;
    }
    const { n } = item;
    const key = focusKey(n.folder, n.id);
    el.toggleClass("is-picked", this.picked.has(key));
    el.toggleClass("is-done", n.completed);
    const box = el.createSpan({ cls: "stashpad-focus-pick-box" });
    setIcon(box, this.picked.has(key) ? "check-square" : "square");
    const body = el.createDiv({ cls: "stashpad-focus-pick-body" });
    const head = body.createDiv({ cls: "stashpad-focus-pick-head" });
    head.createSpan({ cls: "stashpad-focus-pick-title", text: item.title || "Untitled" });
    // 0.589.0: a status chip, so done / open / plain notes read at a glance.
    const chip = n.completed ? ["is-done", "check", "Done"] : n.task ? ["is-task", "circle", "Task"] : ["is-note", "file-text", "Note"];
    const c = head.createSpan({ cls: `stashpad-focus-pick-chip ${chip[0]}` });
    setIcon(c.createSpan({ cls: "stashpad-focus-pick-chip-icon" }), chip[1]);
    c.createSpan({ text: chip[2] });
    // 0.589.0: details that tell look-alike tasks apart — where it lives
    // (folder › parent note), when it was made, its due date, time tracked.
    const where = n.folder.split("/").pop() || n.folder;
    const parentTitle = n.parent ? this.titleByKey.get(focusKey(n.folder, n.parent)) : undefined;
    const meta: string[] = [parentTitle ? `${where} › ${parentTitle.length > 40 ? parentTitle.slice(0, 39) + "…" : parentTitle}` : where];
    if (n.created) meta.push(`created ${formatDateTime(n.created, this.plugin.settings)}`);
    if (n.due) { const ms = parseDueString(n.due); if (Number.isFinite(ms)) meta.push(`due ${formatDateOnly(ms, this.plugin.settings)}`); }
    if (n.totalSec) meta.push(`${formatSpent(n.totalSec)} tracked`);
    if (n.focusDate) meta.push(`on Focus ${n.focusDate}`);
    body.createDiv({ cls: "stashpad-focus-meta", text: meta.join(" · ") });
    if (item.hit) body.createDiv({ cls: "stashpad-focus-pick-hit", text: item.hit.slice(0, 140) });
    this.rowEls.set(key, el);
  }

  /** Toggle a note (or create one) instead of choose-and-close. */
  selectSuggestion(item: PickItem): void {
    if (item.kind === "create") { void this.createNew(item.text); return; }
    const { n } = item;
    const key = focusKey(n.folder, n.id);
    if (this.picked.has(key)) this.picked.delete(key); else this.picked.set(key, n);
    const el = this.rowEls.get(key);
    if (el) {
      const on = this.picked.has(key);
      el.toggleClass("is-picked", on);
      const box = el.querySelector<HTMLElement>(".stashpad-focus-pick-box");
      if (box) setIcon(box, on ? "check-square" : "square");
    }
    this.syncButton();
  }

  onChooseSuggestion(): void { /* selection is handled in selectSuggestion */ }
}

/** Open (or reveal) the Focus view. One per workspace. */
export async function openFocusView(plugin: StashpadPlugin): Promise<void> {
  const { workspace } = plugin.app;
  // One Focus tab per workspace: any leaf of the type is the one to reveal.
  const existing = workspace.getLeavesOfType(STASHPAD_FOCUS_VIEW_TYPE).find((l) => l.getViewState().type === STASHPAD_FOCUS_VIEW_TYPE);
  if (existing) { await workspace.revealLeaf(existing); return; }
  const originLeaf = workspace.getMostRecentLeaf();
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_FOCUS_VIEW_TYPE, active: true, state: {} });
  workspace.revealLeaf(leaf);
  settleNewTab(workspace, originLeaf);
  returnToOriginOnClose(workspace, leaf, originLeaf, (ref) => plugin.registerEvent(ref));
}
