import { App, TFile } from "obsidian";
import { newId } from "./id-service";

/** 0.197.0 — clone a repeating task into its NEXT occurrence.
 *
 *  Lives apart from the view on purpose: occurrences are spawned both from
 *  cmdToggleComplete (a view) and from the interval sweep in main.ts (no view).
 *
 *  Implemented as vault.copy + processFrontMatter rather than rebuilding the note
 *  by hand — Obsidian then owns the YAML, so nested values (assignees, arrays)
 *  survive a round trip that hand-written frontmatter would mangle.
 *
 *  0.210.3: ids come from an injected `mintId`, which callers pass as
 *  `plugin.mintNoteId`. Raw `newId()` (the old behaviour, still the default so this
 *  module stays view-free and testable) checks NOTHING: it neither avoids ids already
 *  in the vault nor records the one it hands out, so a later mint in the same session
 *  could reissue it. Duplicate ids are silently destructive — TreeIndex.rebuild keys
 *  nodes by id, so the second file wins and the FIRST note disappears from the list
 *  while still existing on disk. */
export async function spawnNextOccurrence(
  app: App,
  src: TFile,
  nextDueIso: string,
  /** 0.210.3: MUST be plugin.mintNoteId. See the note in this file's mintId use. */
  mintId: () => string = newId,
): Promise<TFile | null> {
  try {
    const id = mintId();
    // Keep the human part of the filename, swap the trailing -<id>.
    const stem = src.basename.replace(/-[a-z0-9]{4,12}$/, "") || "task";
    const dir = src.parent?.path ? `${src.parent.path}/` : "";
    let path = `${dir}${stem}-${id}.md`;
    for (let i = 2; await app.vault.adapter.exists(path); i++) path = `${dir}${stem}-${id}-${i}.md`;

    const copy = await app.vault.copy(src, path);
    await app.fileManager.processFrontMatter(copy, (fm: Record<string, unknown>) => {
      fm.id = id;
      fm.created = new Date().toISOString();
      fm.due = nextDueIso;
      // A fresh occurrence starts clean: not done, not missed, and without the
      // previous instance's edit/authorship trail.
      delete fm.completed;
      delete fm.missed;
      delete fm.missedAt;
      delete fm.modified;
      delete fm.contributors;
    });
    return copy;
  } catch (e) {
    console.error("[Stashpad] failed to spawn the next occurrence", e);
    return null;
  }
}

/** Close out an occurrence that ran past its interval without being done: keep it in
 *  place but mark it complete AND flagged, so it leaves the active list while staying
 *  visible as a miss. Frontmatter rather than a body prefix — it survives the user
 *  editing the text, and it can be filtered on.
 *
 *  0.211.6 (L10) — this is a CLAIM: it returns false when the occurrence was already
 *  closed by the time the write ran, so the caller knows not to spawn a successor. The
 *  previous `markOccurrenceMissed` returned void and was deliberately REPLACED rather
 *  than kept alongside this — leaving the unconditional version exported invites a
 *  future caller to reintroduce the duplicate-spawn race below.
 *
 *  The interval sweep decides whether to roll an occurrence from the metadataCache,
 *  which lags the vault. Two sweeps in the lag window — or this device and another
 *  one syncing — could each see the same un-completed occurrence and each spawn a
 *  next one, leaving the user with duplicate tasks that no longer share an id.
 *  `processFrontMatter` reads the file itself rather than the cache, so the first
 *  writer wins and any later one observes `completed === true` and backs off. This is
 *  the same reason `autoResolveDueTask` re-reads `due` inside its callback; the
 *  interval branch simply never got the equivalent. */
export async function claimOccurrenceMissed(app: App, file: TFile, whenMs: number): Promise<boolean> {
  let claimed = false;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    if (fm.completed === true) return; // already closed out — don't spawn again
    claimed = true;
    fm.completed = true;
    fm.missed = true;
    fm.missedAt = new Date(whenMs).toISOString();
  });
  return claimed;
}

/** 0.197.0 — `repeatMode: "archive"`: the live note rolls forward as before, but a
 *  COMPLETED snapshot of the occurrence just finished is filed into the folder's
 *  `archive/` subfolder. History without cluttering the active list. */
export async function archiveOccurrenceSnapshot(
  app: App,
  src: TFile,
  dueIso: string | null,
  mintId: () => string = newId,
): Promise<TFile | null> {
  try {
    const dir = `${src.parent?.path ? `${src.parent.path}/` : ""}archive`;
    if (!(await app.vault.adapter.exists(dir))) await app.vault.createFolder(dir);
    const id = mintId();
    const stem = src.basename.replace(/-[a-z0-9]{4,12}$/, "") || "task";
    let path = `${dir}/${stem}-${id}.md`;
    for (let i = 2; await app.vault.adapter.exists(path); i++) path = `${dir}/${stem}-${id}-${i}.md`;

    const copy = await app.vault.copy(src, path);
    await app.fileManager.processFrontMatter(copy, (fm: Record<string, unknown>) => {
      fm.id = id;
      fm.completed = true;
      // The snapshot records the occurrence that was just finished, so it keeps the
      // due date it was completed AGAINST — not the rolled-forward one.
      if (dueIso) fm.due = dueIso;
      fm.completedAt = new Date().toISOString();
      // A snapshot must never repeat again, or the archive would breed.
      delete fm.repeat;
      delete fm.repeatMode;
      delete fm.remindEvery;
      delete fm.autoDoneAfter;
    });
    return copy;
  } catch (e) {
    console.error("[Stashpad] failed to archive the completed occurrence", e);
    return null;
  }
}
