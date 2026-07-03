import { App, TFile } from "obsidian";
import type StashpadPlugin from "./main";
import { ROOT_ID, fmHasTag, parseAssignees, parseAuthorRef } from "./types";

/** 0.126.0: a task surfaced from any Stashpad folder. Shared by the Tasks
 *  panel and the Daily-review modal so both read tasks identically. */
export interface TaskItem {
  file: TFile;
  folder: string;
  id: string;
  title: string;
  task: boolean;
  completed: boolean;
  due: number | null;
  dueRaw: string | null;
  color: string | null;
  assignedTo: Array<{ id: string; name: string }>;
  assignedBy: { id: string; name: string } | null;
  /** 0.131.1: the note's author (creator). Most tasks have an author but no
   *  assignee, so the author is what you filter/see by for your own tasks. */
  author: { id: string; name: string } | null;
}

/** Title from a note filename: drop the trailing `-id` suffix, dashes → spaces.
 *  Pass the note's real `id` (from frontmatter) so we only strip the actual id
 *  and not a legit trailing word — `quarterly-budget-review` was losing "review"
 *  to the old blind `-[a-z0-9]{4,12}$` strip. When no id is available, fall back
 *  to stripping only an exact id-shaped token (id-service alphabet, 6 chars). */
export function titleFromTaskFile(file: TFile, id?: string | null): string {
  let base = file.basename;
  if (id && base.endsWith(`-${id}`)) {
    base = base.slice(0, -(id.length + 1));
  } else if (!id) {
    base = base.replace(/-[abcdefghijkmnpqrstuvwxyz23456789]{6}$/, "");
  }
  return base.replace(/-/g, " ").trim() || file.basename;
}

/** Scan every Stashpad folder for task-flagged notes (the `task` tag, the legacy
 *  `task: true` boolean, a bare `completed` field, or any `due`). */
export function collectTasks(app: App, plugin: StashpadPlugin): TaskItem[] {
  const folderSet = new Set(plugin.discoverStashpadFolders());
  const out: TaskItem[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
    if (!folderSet.has(dir)) continue;
    const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as any;
    const id = typeof fm.id === "string" ? fm.id : null;
    if (!id || id === ROOT_ID) continue;
    const completed = fm.completed === true;
    const task = fmHasTag(fm, "task") || fm.task === true || fm.completed !== undefined;
    const dueRaw = typeof fm.due === "string" || typeof fm.due === "number" ? String(fm.due) : null;
    let due: number | null = null;
    if (typeof fm.due === "number") {
      // A numeric `due` is a raw epoch value — Date.parse("1730000000000") is
      // NaN, so parse it directly. Only accept plausible ms timestamps (≥ ~1973
      // in ms) so a bare small number like `2026` isn't read as 2 seconds past
      // epoch. (0.140.5 review.)
      if (Number.isFinite(fm.due) && fm.due >= 1e11) due = fm.due;
    } else if (dueRaw) {
      const t = Date.parse(dueRaw);
      if (!Number.isNaN(t)) due = t;
    }
    if (!task && !completed && due == null && !dueRaw) continue;
    out.push({
      file: f,
      folder: dir,
      id,
      title: titleFromTaskFile(f, id),
      task,
      completed,
      due,
      dueRaw,
      color: typeof fm.color === "string" ? fm.color : null,
      assignedTo: parseAssignees(fm),
      assignedBy: parseAuthorRef(fm.assignedBy),
      author: parseAuthorRef(fm.author),
    });
  }
  return out;
}
