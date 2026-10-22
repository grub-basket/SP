import { ItemView, SuggestModal, WorkspaceLeaf, setIcon, type App, type Menu, type ViewStateResult } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_FOCUS_VIEW_TYPE, siftMatch, type StashpadId } from "./types";
import { addCopyTabLinkItem } from "./tab-link-menu";
import { returnToOriginOnClose } from "./leaf-return";
import { settleNewTab } from "./view-helpers";
import { notify } from "./notify";
import { focusKey, type FocusNote, type FocusService } from "./focus-service";
import { dayKey, formatSpent, type FocusMode } from "./focus-time";
import { parseDueString } from "./due-warmth";
import { formatDateOnly } from "./format";

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
    const current = st ? (today.find((n) => n.file.path === st.path) ?? null) : null;
    const nextUp = open.find((n) => n.file.path !== st?.path) ?? null;
    this.renderTimer_(root, current, open[0] ?? null, nextUp);

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
  private renderTimer_(root: HTMLElement, current: FocusNote | null, firstOpen: FocusNote | null, nextUp: FocusNote | null): void {
    const st = this.svc.state;
    const card = root.createDiv({ cls: "stashpad-focus-timer" + (st ? "" : " is-idle") });
    if (st) {
      card.toggleClass("is-running", st.running);
      card.toggleClass("is-break", st.phase === "break");
    }

    // Mode switch (pomodoro / stopwatch).
    const modeRow = card.createDiv({ cls: "stashpad-focus-modes", attr: { role: "radiogroup", "aria-label": "Timer type" } });
    const mode: FocusMode = st?.mode ?? this.plugin.settings.focusDefaultMode ?? "pomodoro";
    for (const [m, label] of [["pomodoro", "Pomodoro"], ["stopwatch", "Stopwatch"]] as [FocusMode, string][]) {
      const b = modeRow.createEl("button", { cls: "stashpad-focus-mode" + (m === mode ? " is-active" : ""), text: label, attr: { role: "radio", "aria-checked": String(m === mode) } });
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

    if (this.single && nextUp) card.createDiv({ cls: "stashpad-focus-next", text: `Up next: ${nextUp.title}` });
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
    new FocusPickerModal(this.app, this.svc, async (picked) => {
      if (!picked.length) return;
      const count = await this.svc.setFocus(picked.map((n) => n.file), true);
      notify(`Added ${plural(count, "task")} to today.`, { kind: "success" });
    }).open();
  }
}

/** Multi-select search over every Stashpad note. Enter toggles the highlighted
 *  row; Mod+Enter (or the button) adds the selection. Open tasks lead when the
 *  query is empty; notes already on today's list are left out. Sift matching. */
export class FocusPickerModal extends SuggestModal<FocusNote> {
  private all: FocusNote[];
  private picked = new Map<string, FocusNote>();
  private rowEls = new Map<string, HTMLElement>();
  private addBtn: HTMLButtonElement | null = null;
  private done = false;

  constructor(app: App, svc: FocusService, private onDone: (picked: FocusNote[]) => void | Promise<void>) {
    super(app);
    const today = dayKey(Date.now());
    this.all = svc.collectNotes().filter((n) => n.focusDate !== today);
    this.limit = 200;
    this.emptyStateText = "No matching notes.";
    this.setPlaceholder("Search notes and tasks to focus on today…");
    this.setInstructions([
      { command: "↵", purpose: "select / unselect" },
      { command: "mod ↵", purpose: "add selected to today" },
      { command: "esc", purpose: "cancel" },
    ]);
    this.scope.register(["Mod"], "Enter", (e) => {
      if (!this.picked.size) this.selectActiveSuggestion(e);
      this.finish();
      return false;
    });
  }

  onOpen(): void {
    super.onOpen();
    this.modalEl.addClass("stashpad-focus-picker");
    const foot = this.modalEl.createDiv({ cls: "stashpad-focus-picker-foot" });
    this.addBtn = foot.createEl("button", { cls: "mod-cta" });
    this.addBtn.onclick = () => this.finish();
    this.syncButton();
  }

  onClose(): void {
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

  getSuggestions(query: string): FocusNote[] {
    const q = query.trim();
    const rank = (n: FocusNote): number => (n.task && !n.completed ? 0 : !n.task ? 1 : 2);
    const pool = q
      ? this.all.filter((n) => siftMatch(q, `${n.title} ${n.folder}`))
      : this.all.filter((n) => n.task && !n.completed);
    return pool.sort((a, b) =>
      rank(a) - rank(b)
      || (b.focusDate ?? "").localeCompare(a.focusDate ?? "")
      || b.created - a.created,
    ).slice(0, this.limit);
  }

  renderSuggestion(n: FocusNote, el: HTMLElement): void {
    const key = focusKey(n.folder, n.id);
    el.addClass("stashpad-focus-pick");
    el.toggleClass("is-picked", this.picked.has(key));
    const box = el.createSpan({ cls: "stashpad-focus-pick-box" });
    setIcon(box, this.picked.has(key) ? "check-square" : "square");
    const body = el.createDiv({ cls: "stashpad-focus-pick-body" });
    body.createDiv({ cls: "stashpad-focus-pick-title", text: n.title || "Untitled" });
    const meta: string[] = [n.folder.split("/").pop() || n.folder];
    meta.push(n.completed ? "done" : n.task ? "task" : "note — becomes a task");
    if (n.focusDate) meta.push(`was on ${n.focusDate}`);
    if (n.totalSec) meta.push(`${formatSpent(n.totalSec)} tracked`);
    body.createDiv({ cls: "stashpad-focus-meta", text: meta.join(" · ") });
    this.rowEls.set(key, el);
  }

  /** Toggle instead of choose-and-close. */
  selectSuggestion(n: FocusNote): void {
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
