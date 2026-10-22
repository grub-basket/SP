import { parseRecurrence, nextDueOnComplete, parseRepeatMode } from "./recurrence";
import { parseDueString, nextDueValue } from "./due-warmth";
import { writeCompletedFm } from "./types";
import { FOCUS_DATE_KEY, FOCUS_DONE_KEY, dayKey, normFocusDate } from "./focus-time";

/* 0.578.0: the PURE half of task completion (no Obsidian runtime import), so
 * scripts/tests can exercise every repeat mode. The I/O half (spawn / archive /
 * a one-call toggle) is in task-complete.ts, which re-exports this. */

/** 0.578.0: what marking ONE task complete did, so the caller can finish the
 *  job after the frontmatter write (spawn / archive) and build its undo. */
export interface CompletionPlan {
  /** `due` before the write (raw), for undo and the archive snapshot. */
  dueBefore: string | null;
  /** roll-forward / archive modes: the note's new due (it is NOT completed). */
  rolledTo: string | null;
  /** complete / interval modes: the due of the occurrence to spawn after the write. */
  spawnNextIso: string | null;
  /** archive mode: file a completed snapshot into archive/ after the write. */
  archive: boolean;
  /** When the next occurrence is due (ms), for a toast; null = not repeating. */
  nextWhen: number | null;
}

/** 0.578.0: THE way to mark a task complete, respecting its `repeat`. Runs
 *  INSIDE a processFrontMatter callback. Extracted from the Stashpad list's
 *  cmdToggleComplete so every surface (list, Focus view, Tasks panel / Daily
 *  review, kanban Status column) completes a repeating task the same way —
 *  before this, only the list rolled it forward or spawned the next one; ticking
 *  it anywhere else left a daily task done forever with no next occurrence.
 *
 *   - not repeating          → completed: true (+ completedAt)
 *   - complete / interval    → this occurrence stays done; caller spawns the next
 *   - rollForward / archive  → the same note moves to its next due, not completed.
 *     If it's on today's Focus list (or left over from an earlier day's) it gets
 *     `focusDone: <today>`, so the Focus view shows it done for today and it
 *     isn't offered as an unfinished leftover.
 *   - already completed      → no-op (never re-spawns / re-rolls). */
export function applyCompleteFm(fm: Record<string, unknown>, now = Date.now()): CompletionPlan {
  const dueBefore = fm.due != null ? String(fm.due) : null;
  const plan: CompletionPlan = { dueBefore, rolledTo: null, spawnNextIso: null, archive: false, nextWhen: null };
  // Already done → nothing to do. Without this, re-completing a finished
  // "keep each occurrence" task (bulk Complete over a selection, the timeline's
  // set-completion-date) spawned ANOTHER next occurrence every time.
  if (fm.completed === true) return plan;
  const rec = parseRecurrence(fm.repeat as string | undefined);
  if (!rec) { writeCompletedFm(fm, true); return plan; }
  const mode = parseRepeatMode(fm.repeatMode);
  const oldDue = fm.due != null ? parseDueString(String(fm.due)) : NaN;
  const next = nextDueOnComplete(rec, Number.isFinite(oldDue) ? oldDue : null, now);
  const nextIso = nextDueValue(fm.due, next); // 0.546.2: date-only stays date-only
  plan.nextWhen = next;
  if (mode === "complete" || mode === "interval") {
    // This occurrence is genuinely finished — it stays completed, and a fresh
    // incomplete one is created for the next interval.
    writeCompletedFm(fm, true);
    delete fm.missed;
    plan.spawnNextIso = nextIso;
  } else {
    // rollForward / archive: the same note moves to the next date.
    fm.due = nextIso;
    // Not completed — but an explicit `completed: false` (the to-do marker the
    // kanban Status board and Focus write) stays, or the task would drop out of
    // the board's To do column on the next refresh.
    if (fm.completed !== false) delete fm.completed;
    plan.rolledTo = nextIso;
    plan.archive = mode === "archive";
    // On today's Focus list — or a leftover from an earlier day's list — it's
    // done for today: stamp it, so it shows under Done and leaves the banner.
    const today = dayKey(now);
    const on = normFocusDate(fm[FOCUS_DATE_KEY]);
    if (on && on <= today) fm[FOCUS_DONE_KEY] = today;
  }
  return plan;
}

/** Un-complete inside a processFrontMatter callback: the existing behaviour
 *  (drop `completed` / `completedAt`) plus the Focus "done today" stamp. */
export function applyUncompleteFm(fm: Record<string, unknown>): void {
  writeCompletedFm(fm, false);
  delete fm[FOCUS_DONE_KEY];
}
