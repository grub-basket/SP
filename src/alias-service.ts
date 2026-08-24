import type { App, TFile } from "obsidian";
import { stripInlineMarkdown } from "./slug-service";

/** 0.271.7: aliases for Stashpad notes.
 *
 *  A Stashpad filename is `<slug>-<id>.md`, so Obsidian's quick switcher, link
 *  autocomplete and graph show the id + hyphenated slug rather than the note's
 *  real title. Writing an `aliases:` entry with the clean title fixes that.
 *
 *  DELIBERATELY NOT AUTOMATIC. Aliases are created only when the user runs the
 *  "create aliases" command or rebootstraps — never on note creation and never
 *  as a background sweep (the user's call: they don't want churn, and a title
 *  changes as a note is edited, so an eager alias would go stale or fight the
 *  user's own edits). Write-once: we APPEND the current title and never chase
 *  later edits.
 *
 *  APPEND-ONLY, the load-bearing safety property. `aliases` is a list the user
 *  may have curated by hand. We only ever ADD our title if it is absent; we
 *  never remove, reorder, or overwrite an existing entry, and a scalar
 *  `aliases: foo` is widened to `[foo, ours]` (foo preserved). */

/** The clean, human title for a note — what a row shows. Mirrors
 *  `view.titleForNode` but works from the file alone (no render cache), because
 *  the command and rebootstrap run over notes that may never have been shown:
 *  first heading, else first non-empty body line, else the filename with the id
 *  suffix stripped. Returns null when there is no meaningful title (an empty or
 *  "Untitled" note), so the caller writes nothing. */
export async function deriveCleanTitle(app: App, file: TFile): Promise<string | null> {
  const heading = app.metadataCache.getFileCache(file)?.headings?.[0]?.heading;
  if (heading) {
    const t = stripInlineMarkdown(heading).trim();
    if (t) return t;
  }
  let body = "";
  try { body = await app.vault.cachedRead(file); } catch { return null; }
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, "");   // drop frontmatter
  const firstLine = body.slice(0, 400).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (firstLine) {
    const t = stripInlineMarkdown(firstLine).trim();
    if (t) return t;
  }
  const fromName = file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim();
  return fromName && fromName.toLowerCase() !== "untitled" ? fromName : null;
}

/** Append `alias` to the note's `aliases` list if it is not already there.
 *  Returns true if a write happened. Append-only: an existing list is never
 *  reordered or pruned; a scalar is widened, preserving its value. */
export async function appendAliasIfMissing(app: App, file: TFile, alias: string): Promise<boolean> {
  const clean = alias.trim();
  if (!clean) return false;
  let wrote = false;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const cur = fm.aliases;
    const list: string[] = Array.isArray(cur)
      ? cur.filter((x): x is string => typeof x === "string")
      : (typeof cur === "string" && cur.trim() ? [cur] : []);
    // Preserve any non-string entries an unusual list might hold, untouched,
    // by only operating when the value is a plain string list or scalar.
    if (cur !== undefined && !Array.isArray(cur) && typeof cur !== "string") return;
    if (list.some((a) => a === clean)) return;   // already present — nothing to do
    list.push(clean);
    fm.aliases = list;
    wrote = true;
  });
  return wrote;
}

/** Create aliases for every Stashpad note directly in `folder` (one level, the
 *  Stashpad model). Append-only. Returns how many notes gained an alias. */
export async function createAliasesForFolder(
  app: App,
  folder: string,
  isStashpadNote: (f: TFile) => boolean,
): Promise<{ scanned: number; written: number }> {
  const clean = folder.replace(/\/+$/, "");
  let scanned = 0, written = 0;
  for (const f of app.vault.getMarkdownFiles()) {
    if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== clean) continue;
    if (!isStashpadNote(f)) continue;
    scanned += 1;
    const title = await deriveCleanTitle(app, f);
    if (!title) continue;
    if (await appendAliasIfMissing(app, f, title)) written += 1;
  }
  return { scanned, written };
}
