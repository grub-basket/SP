/* Pure tests for src/task-complete-fm.ts — the ONE repeat-aware completion rule
 * shared by the Stashpad list, Focus view, Tasks panel / Daily review and kanban. */
import { applyCompleteFm, applyUncompleteFm } from "../../src/task-complete-fm";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const now = new Date(2026, 9, 21, 15, 0, 0).getTime(); // local Wed 2026-10-21 15:00

// Not repeating: plain completion.
{
  const fm: Record<string, unknown> = { completed: false, focusDate: "2026-10-21" };
  const p = applyCompleteFm(fm, now);
  __eq(fm.completed, true, "plain: completed");
  __assert(typeof fm.completedAt === "string", "plain: completedAt stamped");
  __eq([p.rolledTo, p.spawnNextIso, p.archive, p.nextWhen], [null, null, false, null], "plain: no repeat plan");
  __eq(fm.focusDone, undefined, "plain: no focusDone (completed says it all)");
}

// Roll forward (default mode), on TODAY's Focus list → focusDone stamped.
{
  const fm: Record<string, unknown> = { completed: false, repeat: "daily", due: "2026-10-21", focusDate: "2026-10-21" };
  const p = applyCompleteFm(fm, now);
  __eq(fm.due, "2026-10-22", "roll: date-only due moves a day, stays date-only");
  __eq(fm.completed, false, "roll: not completed — the to-do's completed:false stays");
  __eq(p.rolledTo, "2026-10-22", "roll: plan.rolledTo");
  __eq(p.dueBefore, "2026-10-21", "roll: plan.dueBefore");
  __eq(p.archive, false, "roll: no archive");
  __eq(p.spawnNextIso, null, "roll: no spawn");
  __eq(fm.focusDone, "2026-10-21", "roll on today's list: focusDone = today");
  __assert(p.nextWhen != null, "roll: nextWhen for the toast");
}

// Roll forward of a LEFTOVER from an earlier day's list → stamped today (leaves
// the carry-over banner); a FUTURE list date or no focusDate → no stamp.
{
  const fm: Record<string, unknown> = { repeat: "daily", due: "2026-10-21", focusDate: "2026-10-20" };
  applyCompleteFm(fm, now);
  __eq(fm.focusDone, "2026-10-21", "roll of yesterday's leftover: stamped today");
  const fut: Record<string, unknown> = { repeat: "daily", due: "2026-10-21", focusDate: "2026-10-25" };
  applyCompleteFm(fut, now);
  __eq(fut.focusDone, undefined, "roll with a future focusDate: no stamp");
  const fm2: Record<string, unknown> = { repeat: "daily", due: "2026-10-21" };
  applyCompleteFm(fm2, now);
  __eq(fm2.focusDone, undefined, "roll with no focusDate: no stamp");
}

// Archive mode: rolls + asks for a snapshot.
{
  const fm: Record<string, unknown> = { repeat: "weekly", repeatMode: "archive", due: "2026-10-21", focusDate: "2026-10-21" };
  const p = applyCompleteFm(fm, now);
  __eq(fm.due, "2026-10-28", "archive: rolls a week");
  __eq(p.archive, true, "archive: snapshot requested");
  __eq(fm.focusDone, "2026-10-21", "archive on today's list: focusDone");
}

// Complete / interval modes: this one stays done, spawn the next.
for (const mode of ["complete", "interval"]) {
  const fm: Record<string, unknown> = { repeat: "daily", repeatMode: mode, due: "2026-10-21", missed: true, focusDate: "2026-10-21" };
  const p = applyCompleteFm(fm, now);
  __eq(fm.completed, true, `${mode}: occurrence completed`);
  __eq(fm.due, "2026-10-21", `${mode}: this occurrence keeps its due`);
  __eq(fm.missed, undefined, `${mode}: missed cleared`);
  __eq(p.spawnNextIso, "2026-10-22", `${mode}: spawn next at the next due`);
  __eq(p.rolledTo, null, `${mode}: not a roll`);
  __eq(fm.focusDone, undefined, `${mode}: completed already counts; no stamp`);
}

// Overdue daily task: the next due never lands in the past.
{
  const fm: Record<string, unknown> = { repeat: "daily", due: "2026-10-01" };
  applyCompleteFm(fm, now);
  __eq(fm.due, "2026-10-22", "overdue roll advances past now");
}

// A to-do's explicit completed:false survives a roll (kanban To do column).
{
  const fm: Record<string, unknown> = { completed: false, repeat: "daily", due: "2026-10-21" };
  applyCompleteFm(fm, now);
  __eq(fm.completed, false, "roll keeps completed:false");
}
// Already completed → no-op: no re-roll, no second spawn, stamp untouched.
for (const mode of ["complete", "rollForward"]) {
  const fm: Record<string, unknown> = { completed: true, completedAt: "orig", repeat: "daily", repeatMode: mode, due: "2026-10-21" };
  const p = applyCompleteFm(fm, now);
  __eq([p.spawnNextIso, p.rolledTo, fm.due, fm.completedAt], [null, null, "2026-10-21", "orig"], `already done (${mode}): no-op`);
}

// Un-complete clears completion + the Focus stamp.
{
  const fm: Record<string, unknown> = { completed: true, completedAt: "x", focusDone: "2026-10-21", tags: ["task"] };
  applyUncompleteFm(fm);
  __eq(fm, { tags: ["task"] }, "uncomplete: completed / completedAt / focusDone gone");
}
