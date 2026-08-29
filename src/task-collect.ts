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
  /** 0.275.2: frontmatter `tags:` + inline #tags (minus the "task" marker), for
   *  filtering the timeline to "events" / "sagas" / outages / etc. */
  tags: string[];
  due: number | null;
  dueRaw: string | null;
  color: string | null;
  assignedTo: Array<{ id: string; name: string }>;
  assignedBy: { id: string; name: string } | null;
  /** 0.131.1: the note's author (creator). Most tasks have an author but no
   *  assignee, so the author is what you filter/see by for your own tasks. */
  author: { id: string; name: string } | null;
  /** 0.273.1 (timeline): when the note was created (epoch ms, 0 = unknown). */
  created: number;
  /** When it was completed — the `completedAt` stamp when present, else null.
   *  A completed task with no stamp predates 0.273.1's stamping; the timeline
   *  approximates those from the file's mtime and says so. */
  completedAt: number | null;
  /** File mtime (epoch ms) — the approximation source above. */
  modifiedMs: number;
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
    const cache = app.metadataCache.getFileCache(f);
    const fm = (cache?.frontmatter ?? {}) as any;
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
    // Tags from frontmatter `tags:` + inline #tags — lets the timeline filter to
    // "events" / "sagas" / product-outage tags, etc. Excludes the "task" marker
    // tag itself (it's on every task, so useless as a filter).
    const tagSet = new Set<string>();
    if (Array.isArray(fm.tags)) for (const t of fm.tags) if (typeof t === "string") tagSet.add(t.replace(/^#/, ""));
    else if (typeof fm.tags === "string") for (const t of fm.tags.split(/[,\s]+/)) if (t) tagSet.add(t.replace(/^#/, ""));
    for (const t of cache?.tags ?? []) tagSet.add(t.tag.replace(/^#/, ""));
    tagSet.delete("task");
    out.push({
      file: f,
      folder: dir,
      id,
      title: titleFromTaskFile(f, id),
      tags: [...tagSet],
      task,
      completed,
      due,
      dueRaw,
      color: typeof fm.color === "string" ? fm.color : null,
      assignedTo: parseAssignees(fm),
      assignedBy: parseAuthorRef(fm.assignedBy),
      author: parseAuthorRef(fm.author),
      created: (() => { const t = Date.parse(String(fm.created ?? "")); return Number.isFinite(t) ? t : 0; })(),
      completedAt: (() => { const t = Date.parse(String(fm.completedAt ?? "")); return Number.isFinite(t) ? t : null; })(),
      modifiedMs: f.stat.mtime,
    });
  }
  return out;
}
