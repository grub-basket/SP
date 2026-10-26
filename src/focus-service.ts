import { TFile, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, fmAddTag, fmHasTag, type StashpadId } from "./types";
import { applyCompleteFm, finishCompletion, type CompletionPlan } from "./task-complete";
import { titleFromTaskFile } from "./task-collect";
import { stripInlineMarkdown } from "./slug-service";
import { stashpadLeaves } from "./leaf-lookup";
import { notify } from "./notify";
import {
  FOCUS_DATE_KEY, FOCUS_DONE_KEY, TIME_LOG_KEY, TIME_SPENT_KEY, MIN_LOG_SECONDS,
  dayKey, normFocusDate, formatLogEntry, appendLogEntry, logSeconds, spentMinutes, formatClock,
  phaseElapsed, phaseLength, breakLengthMs, displayMs,
  type FocusMode, type FocusTimerConfig, type FocusTimerState,
} from "./focus-time";

/** One Stashpad note as the Focus view sees it (metadata cache only — no reads). */
export interface FocusNote {
  file: TFile;
  folder: string;
  id: string;
  title: string;
  task: boolean;
  completed: boolean;
  focusDate: string | null;
  /** 0.578.0: day a ROLL-FORWARD repeating task was ticked while on the list. */
  focusDone: string | null;
  /** Done for its list day: completed, or a repeating task rolled forward that day. */
  done: boolean;
  /** Raw `due` and whether it repeats — for the "next: …" hint on a rolled task. */
  due: string | null;
  repeats: boolean;
  color: string | null;
  /** 0.589.0: parent note id (null at the folder root) and file mtime — the
   *  picker shows "under <parent>" and dates to tell look-alike tasks apart. */
  parent: string | null;
  modified: number;
  /** Tracked seconds today / all time, from `timeLog`. */
  todaySec: number;
  totalSec: number;
  created: number;
}

export type FocusChange = "tick" | "change";

/** 0.583.0: a note's display title from its text: the first non-empty line,
 *  minus heading / list / checkbox markers and inline markdown ("" if none). */
export function titleFromText(text: string): string {
  const line = text.slice(0, 300).split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  return stripInlineMarkdown(line.replace(/^#+\s*/, "").replace(/^[-*+]\s+(\[.\]\s+)?/, "")).trim();
}

export const focusKey = (folder: string, id: string): string => `${folder}::${id}`;

/** Frontmatter keys a Focus write can touch — snapshotted for exact undo. */
const UNDO_KEYS = [FOCUS_DATE_KEY, FOCUS_DONE_KEY, "tags", "completed", "completedAt", "task", "due", "missed"] as const;
type FmSnap = Partial<Record<(typeof UNDO_KEYS)[number], unknown>>;

/** 0.577.0: plugin-level half of the Focus view — owns the timer (so it keeps
 *  running when the view is closed), the status-bar ticker, and every
 *  frontmatter write the view makes. One instance, created in onload. */
export class FocusService {
  private listeners = new Set<(reason: FocusChange) => void>();
  private statusEl: HTMLElement | null = null;
  private statusIcon: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private lastStatus = "";

  constructor(private plugin: StashpadPlugin) {}

  /** `openView` opens the Focus view (the status-bar click). */
  init(openView: () => void): void {
    const p = this.plugin;
    this.statusEl = p.addStatusBarItem();
    this.statusEl.addClass("stashpad-focus-status", "mod-clickable");
    this.statusEl.setAttr("aria-label", "Stashpad Focus timer — open the Focus view");
    this.statusIcon = this.statusEl.createSpan({ cls: "stashpad-focus-status-icon" });
    this.statusText = this.statusEl.createSpan({ cls: "stashpad-focus-status-text" });
    this.statusEl.addEventListener("click", openView);
    // Keep the timer pointed at its note across renames/moves.
    p.registerEvent(p.app.vault.on("rename", (f, oldPath) => {
      const st = this.state;
      if (st && st.path === oldPath && f instanceof TFile) { st.path = f.path; st.folder = f.parent?.path ?? st.folder; this.persist(); }
    }));
    p.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.tick(); // catch up a phase that ended while Obsidian was closed
  }

  // ---- change notification ----

  /** Subscribe; returns the unsubscribe. "tick" = only the clock moved. */
  onChange(fn: (reason: FocusChange) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(reason: FocusChange = "change"): void {
    for (const fn of [...this.listeners]) { try { fn(reason); } catch (e) { console.error("Stashpad focus listener", e); } }
  }

  /** The timer, if THIS device owns it (see FocusTimerState.device). A timer
   *  with no device stamp predates the stamp and counts as ours. */
  get state(): FocusTimerState | null {
    const st = this.plugin.settings.focusTimer ?? null;
    return st && (!st.device || st.device === this.deviceId()) ? st : null;
  }
  private set state(st: FocusTimerState | null) { this.plugin.settings.focusTimer = st; }

  cfg(): FocusTimerConfig {
    const s = this.plugin.settings;
    const n = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      workMin: Math.max(1, n(s.focusWorkMin, 25)),
      shortBreakMin: Math.max(1, n(s.focusShortBreakMin, 5)),
      longBreakMin: Math.max(1, n(s.focusLongBreakMin, 15)),
      longEvery: Math.floor(n(s.focusLongBreakEvery, 4)),
    };
  }

  private persist(): void {
    void this.plugin.saveSettings();
    this.renderStatus(Date.now());
    this.emit();
  }

  // ---- notes ----

  /** Every Stashpad note (direct children of a Stashpad folder), metadata only. */
  collectNotes(): FocusNote[] {
    const { app } = this.plugin;
    const folders = new Set(this.plugin.discoverStashpadFolders());
    const today = dayKey(Date.now());
    const out: FocusNote[] = [];
    for (const f of app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folders.has(dir)) continue;
      const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
      const id = typeof fm.id === "string" ? fm.id : typeof fm.id === "number" ? String(fm.id) : null;
      if (!id || id === ROOT_ID) continue;
      const log = fm[TIME_LOG_KEY];
      out.push({
        file: f,
        folder: dir,
        id,
        title: this.titleOf(f, id),
        task: fmHasTag(fm, "task") || fm.task === true || fm.completed !== undefined,
        completed: fm.completed === true,
        focusDate: normFocusDate(fm[FOCUS_DATE_KEY]),
        focusDone: normFocusDate(fm[FOCUS_DONE_KEY]),
        done: fm.completed === true || (() => {
          const d = normFocusDate(fm[FOCUS_DONE_KEY]), on = normFocusDate(fm[FOCUS_DATE_KEY]);
          return !!d && !!on && d >= on;
        })(),
        due: fm.due != null ? String(fm.due) : null,
        repeats: typeof fm.repeat === "string" && fm.repeat.trim() !== "",
        color: typeof fm.color === "string" ? fm.color : null,
        parent: fm.parent == null || String(fm.parent) === "" || String(fm.parent) === ROOT_ID ? null : String(fm.parent),
        modified: f.stat.mtime,
        todaySec: logSeconds(log, today),
        totalSec: logSeconds(log),
        created: (() => { const t = Date.parse(String(fm.created ?? "")); return Number.isFinite(t) ? t : 0; })(),
      });
    }
    return out;
  }

  /** 0.583.0: what a note reads as — the FIRST LINE of its body (a heading
   *  there counts; a heading further down doesn't), from a background read or
   *  the render cache, else the filename. The filename alone loses stopwords
   *  and carries a date prefix in some folders. */
  private titleOf(f: TFile, id: string): string {
    // A read title wins even when stale (a timer log write bumps mtime; the
    // first line rarely changes) — warmTitles refreshes it in the background.
    const read = this.readTitles.get(f.path);
    if (read) return read.title;
    return titleFromText(this.plugin.renderCacheStore.get(f.path)?.text ?? "") || titleFromTaskFile(f, id);
  }

  /** First lines read from disk for notes the render cache doesn't know yet
   *  (e.g. a task just made from the picker), keyed by path + mtime. */
  private readTitles = new Map<string, { mtime: number; title: string }>();

  /** Read the first line of any of `notes` with no fresh read,
   *  then emit one change so views repaint with real titles. Meant for the few
   *  notes on screen (today + leftovers), not the whole vault. */
  async warmTitles(notes: FocusNote[]): Promise<void> {
    const { app } = this.plugin;
    const todo = notes.filter((n) => {
      const r = this.readTitles.get(n.file.path);
      return !r || r.mtime !== n.file.stat.mtime;
    });
    if (!todo.length) return;
    let changed = false;
    await Promise.allSettled(todo.map(async (n) => {
      const md = await app.vault.cachedRead(n.file);
      const end = md.startsWith("---") ? md.indexOf("\n---", 3) : -1;
      const title = titleFromText(end === -1 ? md : md.slice(end + 4)) || n.title;
      this.readTitles.set(n.file.path, { mtime: n.file.stat.mtime, title });
      const prev = n.title;
      if (title !== prev) changed = true;
    }));
    if (changed) this.emit();
  }

  /** Today's list in the user's order (device-local), unknown ones after by title. */
  sortToday(notes: FocusNote[]): FocusNote[] {
    const order = this.plugin.settings.focusOrder ?? [];
    const rank = new Map(order.map((k, i) => [k, i]));
    return notes.slice().sort((a, b) => {
      const ra = rank.get(focusKey(a.folder, a.id)) ?? Infinity;
      const rb = rank.get(focusKey(b.folder, b.id)) ?? Infinity;
      return ra !== rb ? ra - rb : a.title.localeCompare(b.title);
    });
  }

  /** Persist a new Today order (deduped; the first occurrence wins). */
  setOrder(keys: string[]): void {
    this.plugin.settings.focusOrder = [...new Set(keys)];
    void this.plugin.saveSettings();
  }

  /** Make every open Stashpad view on `folder` treat our next frontmatter write
   *  as its own (no "edited outside Stashpad" log entry; the row still repaints). */
  private markSelfWrite(file: TFile): void {
    const folder = file.parent?.path ?? "";
    for (const leaf of stashpadLeaves(this.plugin.app)) {
      const v = leaf.view as unknown as { noteFolder?: string; markFmSelfWrite?: (p: string) => void };
      if (typeof v?.markFmSelfWrite === "function" && (v.noteFolder ?? "").replace(/\/+$/, "") === folder) v.markFmSelfWrite(file.path);
    }
  }

  /** Apply `fn` to each note's frontmatter, snapshotting UNDO_KEYS first, and
   *  push ONE undo entry per folder (that's how Stashpad's undo is scoped). */
  private async mutate(files: TFile[], label: string, fn: (fm: Record<string, unknown>) => void): Promise<number> {
    const { app } = this.plugin;
    const snaps = new Map<TFile, FmSnap>();
    const apply = async (f: TFile, g: (fm: Record<string, unknown>) => void): Promise<boolean> => {
      try { this.markSelfWrite(f); await app.fileManager.processFrontMatter(f, g); return true; }
      catch (e) { notify(`Stashpad Focus: couldn't update ${f.basename} (${(e as Error).message})`, { kind: "error" }); return false; }
    };
    for (const f of files) {
      await apply(f, (fm) => {
        const snap: FmSnap = {};
        for (const k of UNDO_KEYS) snap[k] = k in fm ? structuredClone(fm[k]) : undefined;
        snaps.set(f, snap);
        fn(fm);
      });
    }
    const restore = (fm: Record<string, unknown>, snap: FmSnap): void => {
      for (const k of UNDO_KEYS) { if (snap[k] === undefined) delete fm[k]; else fm[k] = structuredClone(snap[k]); }
    };
    const byFolder = new Map<string, TFile[]>();
    for (const f of snaps.keys()) {
      const folder = f.parent?.path ?? "";
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(f);
    }
    for (const [folder, fs] of byFolder) {
      this.plugin.getUndoStack(folder).push({
        label,
        undo: async () => { for (const f of fs) { const s = snaps.get(f); if (s) await apply(f, (fm) => restore(fm, s)); } this.emit(); },
        redo: async () => { for (const f of fs) await apply(f, fn); this.emit(); },
      });
    }
    this.emit();
    return snaps.size;
  }

  /** Put notes on (or take them off) a day's list. Adding also makes each one a
   *  task, mirroring "Toggle task" (task tag, unfilled checkbox, legacy flag
   *  dropped); a task that's already done stays done. Also keeps the device-local
   *  Today order: added notes go to the END (in the order given), removed ones
   *  drop out, and keys of notes no longer on today's list are pruned, so the
   *  order never outgrows one day's list. */
  async setFocus(files: TFile[], on: boolean, day = dayKey(Date.now())): Promise<number> {
    const { app } = this.plugin;
    const keyOf = (f: TFile): string | null => {
      // A note created a moment ago isn't parsed yet: fall back to the -<id>
      // filename suffix (slug-service buildFilename) so it still gets ordered.
      const id = app.metadataCache.getFileCache(f)?.frontmatter?.id ?? /-([a-z0-9]{4,12})$/.exec(f.basename)?.[1];
      return id == null ? null : focusKey(f.parent?.path ?? "", String(id));
    };
    const changed = new Set(files.map(keyOf).filter((k): k is string => !!k));
    const n = await this.mutate(files, on ? "Add to Today" : "Remove from Today", (fm) => {
      if (on) {
        fm[FOCUS_DATE_KEY] = day;
        fmAddTag(fm, "task");
        // 0.589.0: a task that's already DONE stays done (it lands in today's
        // Done section, shown checked) — the user's call, reversing 0.577.0's
        // reopen. Only a note that wasn't a task gets the unfilled checkbox.
        if (fm.completed === undefined) fm.completed = false;
        delete fm.task;
        delete fm[FOCUS_DONE_KEY]; // a fresh day on the list: not done yet
      } else {
        delete fm[FOCUS_DATE_KEY];
      }
    });
    // Save today's list in the order it's SHOWN (ordered ones, then the rest by
    // title), minus the changed notes, then append added ones at the end. Saving
    // only the old order let an added note jump ahead of never-ordered ones.
    const today = dayKey(Date.now());
    const shown = this.sortToday(this.collectNotes().filter((x) => x.focusDate === today));
    const kept = shown.map((x) => focusKey(x.folder, x.id)).filter((k) => !changed.has(k));
    this.setOrder(on && day === today ? [...kept, ...changed] : kept);
    return n;
  }

  /** Check / uncheck. Completing goes through applyCompleteFm, so a REPEATING
   *  task rolls forward or spawns its next occurrence exactly as it does from the
   *  Stashpad list (0.578.0); a rolled one stays on today's list as done via
   *  `focusDone`. Unchecking keeps it a task (completed: false) and clears
   *  `focusDone` — a rolled task's due stays rolled (Stashpad undo reverses that).
   *  Completing the timer's note stops the timer first, so its time is logged.
   *  Redo re-applies the same frontmatter but doesn't spawn a second occurrence. */
  async setCompleted(file: TFile, on: boolean): Promise<void> {
    const st = this.state;
    if (on && st && st.path === file.path) await this.stop();
    let plan = null as CompletionPlan | null;
    await this.mutate([file], on ? "Complete task" : "Reopen task", (fm) => {
      if (on) { plan = applyCompleteFm(fm); return; }
      if (fm.completed === true) { fm.completed = false; delete fm.completedAt; }
      delete fm[FOCUS_DONE_KEY];
    });
    if (plan) {
      await finishCompletion(this.plugin.app, file, plan, () => this.plugin.mintNoteId());
      plan = null; // redo re-runs the callback above; don't let it re-spawn
    }
  }

  // ---- timer ----

  /** This device's id (localStorage is per device and never synced). */
  private deviceId(): string {
    const KEY = "stashpad-focus-device";
    if (this.device) return this.device;
    let id: unknown = null;
    try { id = this.plugin.app.loadLocalStorage(KEY); } catch { /* fall through */ }
    if (typeof id !== "string" || !id) {
      id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try { this.plugin.app.saveLocalStorage(KEY, id); } catch { /* per-device convenience only */ }
    }
    this.device = id as string;
    return this.device;
  }
  private device: string | null = null;

  private resolveFile(st: FocusTimerState): TFile | null {
    const { app } = this.plugin;
    const byPath = app.vault.getAbstractFileByPath(st.path);
    if (byPath instanceof TFile) return byPath;
    for (const f of app.vault.getMarkdownFiles()) {
      if ((f.parent?.path ?? "") !== st.folder) continue;
      const id = app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (id != null && String(id) === st.id) return f;
    }
    return null;
  }

  /** Append one work stretch to the note's log and refresh its total. */
  private async logStretch(st: FocusTimerState, startMs: number, endMs: number): Promise<void> {
    const seconds = (endMs - startMs) / 1000;
    if (seconds < MIN_LOG_SECONDS) return;
    const file = this.resolveFile(st);
    if (!file) { notify(`Stashpad Focus: couldn't find "${st.title}" to log ${Math.round(seconds / 60)}m of time.`, { kind: "warning" }); return; }
    try {
      this.markSelfWrite(file);
      await this.plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const log = appendLogEntry(fm[TIME_LOG_KEY], formatLogEntry(startMs, seconds));
        fm[TIME_LOG_KEY] = log;
        fm[TIME_SPENT_KEY] = spentMinutes(log);
      });
    } catch (e) {
      notify(`Stashpad Focus: couldn't log time to ${file.basename} (${(e as Error).message})`, { kind: "error" });
    }
    this.emit();
  }

  private workMsFor(mode: FocusMode): number {
    return mode === "pomodoro" ? this.cfg().workMin * 60_000 : 0;
  }

  /** Roll every pomodoro phase that has already ended by `now`, logging a work
   *  phase only up to its REAL end (never the gap after it — laptop asleep,
   *  Obsidian closed, a throttled background window). Synchronous: it mutates
   *  the state in place before any await, so a Stop/Pause that calls it first
   *  can't log an overshoot. Returns whether anything rolled. */
  private rollover(st: FocusTimerState, now: number): boolean {
    let changed = false;
    for (let guard = 0; guard < 3; guard++) {
      if (!st.running || st.segStart == null) break;
      const len = phaseLength(st, this.cfg());
      if (len == null || phaseElapsed(st, now) < len) break;
      const end = st.segStart + Math.max(0, len - st.elapsedMs);
      changed = true;
      if (st.phase === "work") {
        void this.logStretch({ ...st }, st.segStart, end);
        st.rounds += 1;
        st.breakMs = breakLengthMs(st.rounds, this.cfg());
        Object.assign(st, { phase: "break", elapsedMs: 0, segStart: end, running: true });
        notify(`🍅 Pomodoro done on **${st.title}** — take a ${Math.round(st.breakMs / 60_000)} min break.`, {
          kind: "success", category: "reminder", duration: 10_000, desktop: true,
          open: { folder: st.folder, id: st.id as StashpadId, button: "Open note" },
        });
      } else {
        Object.assign(st, { phase: "work", elapsedMs: 0, segStart: null, running: false, breakMs: 0, workMs: this.workMsFor(st.mode) });
        notify(`Break's over — press play to start the next pomodoro on **${st.title}**.`, {
          kind: "info", category: "reminder", duration: 10_000, desktop: true,
          open: { folder: st.folder, id: st.id as StashpadId, button: "Open note" },
        });
        break;
      }
    }
    return changed;
  }

  /** Bank the running stretch (logging it if it's work) and leave the timer
   *  paused. Rolls a finished phase first, so the log is capped at its end. */
  private async bank(st: FocusTimerState, now: number): Promise<void> {
    this.rollover(st, now);
    if (!st.running || st.segStart == null) return;
    const start = st.segStart;
    st.elapsedMs += Math.max(0, now - start);
    st.running = false;
    st.segStart = null;
    if (st.phase === "work") await this.logStretch(st, start, now);
  }

  /** Start (or resume) timing `note`; with no note, resume the paused timer.
   *  Switching notes banks the current stretch to the old note first. */
  async start(note?: { file: TFile; folder: string; id: string; title: string }): Promise<void> {
    const now = Date.now();
    let st = this.state;
    if (note && (!st || st.path !== note.file.path)) {
      if (st) await this.bank(st, now);
      const mode: FocusMode = st?.mode ?? this.plugin.settings.focusDefaultMode ?? "stopwatch";
      st = {
        folder: note.folder, id: note.id, path: note.file.path, title: note.title,
        mode, phase: "work", running: false, segStart: null, elapsedMs: 0, rounds: 0, breakMs: 0,
        workMs: this.workMsFor(mode), device: this.deviceId(),
      };
    }
    if (!st) return;
    if (!st.running) { st.running = true; st.segStart = Date.now(); }
    this.state = st;
    this.persist();
  }

  async pause(): Promise<void> {
    const st = this.state;
    if (!st || !st.running) return;
    await this.bank(st, Date.now());
    this.persist();
  }

  async toggle(): Promise<void> {
    const st = this.state;
    if (!st) return;
    if (st.running) await this.pause(); else await this.start();
  }

  /** Stop and clear the timer, logging the running work stretch. Clears only
   *  if it's still the SAME timer once the log write lands — ▶ on another row
   *  during that await must not be wiped out. */
  async stop(): Promise<void> {
    const st = this.state;
    if (!st) return;
    await this.bank(st, Date.now());
    if (this.plugin.settings.focusTimer === st) this.state = null;
    this.persist();
  }

  /** Switch pomodoro ⇄ stopwatch. Banks the current stretch and restarts the
   *  work phase from zero, keeping running/paused as it was. */
  async setMode(mode: FocusMode): Promise<void> {
    const st = this.state;
    if (!st) { this.plugin.settings.focusDefaultMode = mode; this.persist(); return; }
    if (st.mode === mode) return;
    const wasRunning = st.running;
    await this.bank(st, Date.now());
    if (this.plugin.settings.focusTimer !== st) return; // replaced while logging
    Object.assign(st, { mode, phase: "work", elapsedMs: 0, rounds: 0, breakMs: 0, workMs: this.workMsFor(mode) });
    if (wasRunning) { st.running = true; st.segStart = Date.now(); }
    this.plugin.settings.focusDefaultMode = mode;
    this.persist();
  }

  /** End a break early: back to a paused work phase. */
  skipBreak(): void {
    const st = this.state;
    if (!st || st.phase !== "break") return;
    Object.assign(st, { phase: "work", running: false, segStart: null, elapsedMs: 0, breakMs: 0, workMs: this.workMsFor(st.mode) });
    this.persist();
  }

  /** 1s heartbeat: refresh the status bar and roll a finished pomodoro phase
   *  (on load too, catching up a phase that ended while Obsidian was closed). */
  private tick(): void {
    const now = Date.now();
    const st = this.state;
    if (st && st.running && st.segStart != null) {
      if (this.rollover(st, now)) { this.persist(); return; }
      this.emit("tick"); // views repaint their clock
    }
    this.renderStatus(now);
  }

  /** Clock text for the current phase (`24:12`), or "" when idle. */
  clockText(now = Date.now()): string {
    const st = this.state;
    return st ? formatClock(displayMs(st, this.cfg(), now)) : "";
  }

  private renderStatus(now: number): void {
    const el = this.statusEl;
    if (!el || !this.statusIcon || !this.statusText) return;
    const st = this.state;
    if (!st) { el.hide(); this.lastStatus = ""; return; }
    const icon = !st.running ? "pause" : st.phase === "break" ? "coffee" : st.mode === "pomodoro" ? "timer" : "watch";
    const text = `${this.clockText(now)} · ${st.title}`;
    const key = `${icon}|${text}`;
    el.show();
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    setIcon(this.statusIcon, icon);
    this.statusText.setText(text);
    el.toggleClass("is-break", st.phase === "break");
    el.toggleClass("is-paused", !st.running);
  }
}
