import type { App, TFile } from "obsidian";
import { spawnNextOccurrence, archiveOccurrenceSnapshot } from "./recurrence-spawn";
import { applyCompleteFm, applyUncompleteFm, type CompletionPlan } from "./task-complete-fm";

export { applyCompleteFm, applyUncompleteFm, type CompletionPlan };

/** After the write: spawn the next occurrence and/or file the archive snapshot.
 *  Returns the spawned note (null if none / it failed — spawnNextOccurrence logs). */
export async function finishCompletion(app: App, file: TFile, plan: CompletionPlan, mintId: () => string): Promise<TFile | null> {
  let spawned: TFile | null = null;
  if (plan.spawnNextIso) spawned = await spawnNextOccurrence(app, file, plan.spawnNextIso, mintId);
  if (plan.archive) await archiveOccurrenceSnapshot(app, file, plan.dueBefore, mintId);
  return spawned;
}

/** Complete one task (no toggle) — the bulk "Complete" in the All-notes index. */
export async function completeTaskFile(app: App, file: TFile, mintId: () => string): Promise<CompletionPlan> {
  let plan = null as CompletionPlan | null;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { plan = applyCompleteFm(fm); });
  if (plan) await finishCompletion(app, file, plan, mintId);
  return plan ?? { dueBefore: null, rolledTo: null, spawnNextIso: null, archive: false, nextWhen: null };
}

/** Toggle one task's completion from a surface with no undo stack of its own
 *  (Tasks panel, Daily review): complete via applyCompleteFm + finishCompletion,
 *  or un-complete. Returns the plan when it completed, null when it un-completed. */
export async function toggleTaskFile(
  app: App, file: TFile, mintId: () => string,
): Promise<CompletionPlan | null> {
  let plan = null as CompletionPlan | null; // assigned in the callback (keep TS from narrowing to null)
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    if (fm.completed === true) applyUncompleteFm(fm);
    else plan = applyCompleteFm(fm);
  });
  if (plan) await finishCompletion(app, file, plan, mintId);
  return plan;
}
