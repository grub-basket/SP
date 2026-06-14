import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type StashpadPlugin from "./main";
import type { StashpadSettings } from "./settings";
import { newId } from "./id-service";
import { bodyToSlug, buildFilename } from "./slug-service";
import { ROOT_ID } from "./types";

/** Match a JD-style prefix at the START of a basename (file or folder)
 *  followed by a single space and the human title. A prefix is one of:
 *    - Range area: `\d+-\d+` (e.g. `10-19 Life Admin`).
 *    - All digits: `\d+` (category, e.g. `11 Me & My Family`).
 *    - Dotted alphanumeric (`11.01 Driver's license`,
 *      `animal.duck.yellow Eggs`).
 *  Sentences without one of those shapes don't match, so "Hello there"
 *  isn't accidentally indexed. Each segment must be pure alphanumeric —
 *  any other character inside the prefix span disqualifies it. */
const PREFIX_RE = /^(\d+-\d+|\d+|[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+)\s+(.+)$/;

export interface IndexEntry {
  prefix: string;
  segments: string[];
  title: string;
  /** The source. Exactly ONE of file or folder is set for "real"
   *  entries; both null for synthetic parents (auto-created for gaps
   *  in the hierarchy). */
  file: TFile | null;
  folder: TFolder | null;
}

export interface ScanResult {
  indexed: IndexEntry[];
  nonIndex: TFile[];
  /** Files that lived in a Stashpad folder and were excluded by the
   *  default-skip-stashpads rule. Surfaced separately so the user can
   *  see what got intentionally filtered. */
  skippedStashpadNotes: TFile[];
}

/** 0.71.14: JD areas (`10-19 Life Admin`) sit at the top of the
 *  hierarchy; categories (`11 Me & My Family`) and IDs (`11.01 …`) fall
 *  inside them by NUMERIC RANGE, not by dotted parent. Compute the
 *  parent prefix for any entry by consulting the full prefix set. */
function findParentPrefix(prefix: string, allPrefixes: Set<string>): string | null {
  // Range area → top level.
  if (/^\d+-\d+$/.test(prefix)) return null;
  // Dotted prefix → parent is segments[:-1] if that exists in the
  // set; otherwise climb until we find an ancestor that does, or fall
  // through to the digit-range logic for the head segment.
  if (prefix.includes(".")) {
    const segs = prefix.split(".");
    const direct = segs.slice(0, -1).join(".");
    if (allPrefixes.has(direct)) return direct;
    // Direct dotted parent isn't in the set — likely a synthetic gap.
    // Try the next ancestor up.
    return findParentPrefix(direct, allPrefixes);
  }
  // Pure-digit category → find the area whose [lo,hi] range contains it.
  if (/^\d+$/.test(prefix)) {
    const n = parseInt(prefix, 10);
    for (const key of allPrefixes) {
      const m = key.match(/^(\d+)-(\d+)$/);
      if (!m) continue;
      const lo = parseInt(m[1], 10);
      const hi = parseInt(m[2], 10);
      if (n >= lo && n <= hi) return key;
    }
    return null;
  }
  return null;
}

export interface BuildNotesResult {
  created: number;
  updated: number;
  skipped: number;
  destFolder: string;
  /** Configuration error: destination folder isn't a real Stashpad
   *  folder. Caller should surface a "configure first" message + a
   *  link to settings. */
  error?: "no-dest" | "dest-not-stashpad";
}

/** Walk the configured scope and partition into JD-prefixed vs not.
 *  Honors the include-stashpad-folders toggle: by default, notes inside
 *  any known Stashpad folder are excluded — those folders are the
 *  index *destination* + working space, so they shouldn't be sources. */
export function scanForJdNotes(
  app: App,
  plugin: StashpadPlugin,
  settings: StashpadSettings,
): ScanResult {
  const allFiles = app.vault.getMarkdownFiles();
  const scoped = filterByScope(allFiles, settings);

  const includeStashpads = settings.jdIndexIncludeStashpadFolders === true;
  const stashpadFolders = includeStashpads ? new Set<string>() : new Set(plugin.discoverStashpadFolders());

  const isInStashpad = (path: string): boolean => {
    if (includeStashpads) return false;
    return Array.from(stashpadFolders).some((sf) => path === sf || path.startsWith(sf + "/"));
  };

  const indexed: IndexEntry[] = [];
  const nonIndex: TFile[] = [];
  const skippedStashpadNotes: TFile[] = [];

  for (const f of scoped) {
    const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
    if (isInStashpad(dir)) {
      skippedStashpadNotes.push(f);
      continue;
    }
    const m = f.basename.match(PREFIX_RE);
    if (m) {
      indexed.push({ prefix: m[1], segments: m[1].split("."), title: m[2], file: f, folder: null });
    } else {
      nonIndex.push(f);
    }
  }

  // 0.71.14: also walk folders in scope. JD areas/categories often
  // exist as folder containers (e.g. `10-19 Life Admin/`, `11 Me &
  // My Family/`) rather than as separate notes. Add matching folders
  // as virtual entries so they appear in the hierarchy. Folders
  // already inside a Stashpad are skipped under the same rule.
  const folderScope = (settings.jdIndexScope ?? "vault") === "folder"
    ? (settings.jdIndexScopeFolder ?? "").trim().replace(/^\/+|\/+$/g, "")
    : "";
  const walkFolders = (folder: TFolder): void => {
    const path = folder.path.replace(/\/+$/, "");
    // Folder scope filter (when "folder" mode is on).
    if (folderScope && path && path !== folderScope && !path.startsWith(folderScope + "/")) {
      // descend in case the configured scope is itself deeper than this
      // folder — but skip the entry itself.
    } else if (path) { // root folder ("") has empty path; skip self
      if (!isInStashpad(path)) {
        const m = folder.name.match(PREFIX_RE);
        if (m) {
          indexed.push({ prefix: m[1], segments: m[1].split("."), title: m[2], file: null, folder });
        }
        // Non-matching folders are NOT added to nonIndex — listing
        // every random folder would be noise. Only file-level
        // non-matches surface there.
      }
    }
    for (const c of folder.children) {
      if (c instanceof TFolder) walkFolders(c);
    }
  };
  walkFolders(app.vault.getRoot());

  const sortMode = settings.jdIndexSort ?? "natural";
  indexed.sort((a, b) => compareEntries(a, b, sortMode));
  return { indexed, nonIndex, skippedStashpadNotes };
}

/** 0.71.5: aggressively overwrite the home note's body of the
 *  designated Stashpad folder with the rendered preview. Frontmatter
 *  is preserved; everything after the closing `---` is replaced. The
 *  user explicitly opted into this loud behavior so the home note
 *  doubles as the JD index landing page. */
export async function buildJdIndexPreview(
  app: App,
  plugin: StashpadPlugin,
  settings: StashpadSettings,
): Promise<{
  indexed: IndexEntry[];
  nonIndex: TFile[];
  skippedStashpadNotes: TFile[];
  previewPath: string | null;
  error?: "no-dest" | "no-home";
}> {
  const destFolder = normalizeFolderPath(settings.jdIndexStashpadFolder ?? "");
  if (!destFolder) {
    const scan = scanForJdNotes(app, plugin, settings);
    return { ...scan, previewPath: null, error: "no-dest" };
  }
  const scan = scanForJdNotes(app, plugin, settings);
  // Locate the home note: the one file inside destFolder whose
  // frontmatter `id` is ROOT_ID. If absent, surface an error so the
  // user knows they need to create the Stashpad folder properly
  // (Stashpad creates one on first open of any folder).
  const homeFile = findHomeNote(app, destFolder);
  if (!homeFile) {
    return { ...scan, previewPath: null, error: "no-home" };
  }
  const renderedBody = renderPreview(scan.indexed, scan.nonIndex, scan.skippedStashpadNotes);
  // Preserve the existing frontmatter block (`---\n…\n---\n`) and
  // replace the body below it. If for some reason there's no FM
  // block, just write the body alone (Stashpad will refuse to touch
  // a file without an id, so this is defensive — homeFile by
  // definition has frontmatter).
  const existingContent = await app.vault.read(homeFile);
  const fmMatch = existingContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const newContent = fmMatch ? `${fmMatch[0]}${renderedBody}` : renderedBody;
  await app.vault.modify(homeFile, newContent);
  return { ...scan, previewPath: homeFile.path };
}

/** Find the Stashpad home note (frontmatter id === ROOT_ID) inside
 *  the given folder. Returns null when none exists — usually means
 *  the folder isn't a Stashpad yet. */
function findHomeNote(app: App, destFolder: string): TFile | null {
  const folder = app.vault.getAbstractFileByPath(destFolder);
  if (!(folder instanceof TFolder)) return null;
  for (const child of folder.children) {
    if (!(child instanceof TFile)) continue;
    if (child.extension !== "md") continue;
    const fm = (app.metadataCache.getFileCache(child)?.frontmatter ?? {}) as any;
    if (fm.id === ROOT_ID) return child;
  }
  return null;
}

/** Build (or rebuild) the JD index as a hierarchy of actual Stashpad
 *  notes inside the designated Stashpad folder. Each note's parent
 *  frontmatter mirrors the dotted-prefix hierarchy. Existing notes
 *  with the same `jdPrefix` frontmatter are updated in-place; new
 *  ones are created. Synthetic parents are auto-created for missing
 *  ancestors (e.g. if source has `1.2.3` but no `1.2`, a `1.2` note
 *  is created as an empty parent). */
export async function buildJdIndexNotes(
  app: App,
  plugin: StashpadPlugin,
  settings: StashpadSettings,
): Promise<BuildNotesResult> {
  const destFolder = normalizeFolderPath(settings.jdIndexStashpadFolder ?? "");
  if (!destFolder) {
    return { created: 0, updated: 0, skipped: 0, destFolder: "", error: "no-dest" };
  }
  // Validate the destination is a known Stashpad folder (the user can
  // override by including it via the include-stashpads toggle — but
  // it must at least exist as a Stashpad folder somewhere).
  const stashpads = new Set(plugin.discoverStashpadFolders());
  if (!stashpads.has(destFolder)) {
    return { created: 0, updated: 0, skipped: 0, destFolder, error: "dest-not-stashpad" };
  }

  const scan = scanForJdNotes(app, plugin, settings);

  // Build the full prefix tree. Add synthetic dotted ancestors where
  // a source exists deeper than its ancestors. Range-area ancestors
  // are NOT auto-synthesized — if there's no `10-19` area, categories
  // just live at root (don't materialize an empty area).
  const entries = new Map<string, IndexEntry | null>();
  for (const e of scan.indexed) entries.set(e.prefix, e);
  for (const e of scan.indexed) {
    if (!e.prefix.includes(".")) continue;
    for (let i = 1; i < e.segments.length; i++) {
      const ancestor = e.segments.slice(0, i).join(".");
      if (!entries.has(ancestor)) entries.set(ancestor, null);
    }
  }
  // 0.71.14: compute hierarchy via parent walk (handles range areas).
  const { roots, childrenOf } = buildJdHierarchy(entries);
  const sortedPrefixes: string[] = [];
  const walk = (prefix: string): void => {
    sortedPrefixes.push(prefix);
    for (const c of childrenOf.get(prefix) ?? []) walk(c);
  };
  for (const r of roots) walk(r);

  // Index of existing notes in the destination folder, keyed by jdPrefix.
  const existingByPrefix = new Map<string, TFile>();
  const destAbstract = app.vault.getAbstractFileByPath(destFolder);
  if (destAbstract instanceof TFolder) {
    for (const child of destAbstract.children) {
      if (!(child instanceof TFile)) continue;
      if (child.extension !== "md") continue;
      const fm = (app.metadataCache.getFileCache(child)?.frontmatter ?? {}) as any;
      if (typeof fm.jdPrefix === "string") existingByPrefix.set(fm.jdPrefix, child);
    }
  }

  // Track new prefix → id mapping so children can reference parent ids.
  const prefixToId = new Map<string, string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const prefix of sortedPrefixes) {
    const entry = entries.get(prefix) ?? null;
    // 0.71.14: parent resolution honors range areas. Use the same
    // findParentPrefix logic the hierarchy was built from so range
    // areas become real Stashpad parents.
    const parentPrefix = findParentPrefix(prefix, new Set(entries.keys()));
    const parentId = parentPrefix ? (prefixToId.get(parentPrefix) ?? ROOT_ID) : ROOT_ID;
    const title = entry ? `${prefix} ${entry.title}` : prefix;
    // Source link applies to FILES; FOLDERS render as plain text
    // (folder paths don't link cleanly via wikilink syntax).
    const sourceLink = entry?.file ? `[[${entry.file.basename}]]` : "";

    // 0.71.11: individual index-note bodies are link-only (no H1).
    // The user explicitly wanted nothing above the link — the
    // Stashpad tree shows the basename-derived title (dot becomes
    // space, e.g. "1 2 Family") which they accept as the tradeoff.
    // Synthetic parents have no link to render, so their body is
    // just the prefix text on its own line.
    const body = sourceLink ? `${sourceLink}\n` : `${title}\n`;

    const existing = existingByPrefix.get(prefix);
    if (existing) {
      // 0.71.9: update frontmatter THEN replace only the body — never
      // call vault.modify with just the body, which wipes id /
      // created / attachments. processFrontMatter touches only the FM
      // block, and we splice the new body in below it. Backfill `id`
      // if missing (fixes notes already corrupted by the pre-0.71.9
      // bug — Stashpad ignores notes without an id).
      try {
        let stampedId: string | null = null;
        await app.fileManager.processFrontMatter(existing, (fm: any) => {
          fm.jdPrefix = prefix;
          if (parentId) fm.parent = parentId;
          if (!fm.id || typeof fm.id !== "string") {
            fm.id = newId();
          }
          if (!fm.created) {
            fm.created = new Date().toISOString();
          }
          if (!fm.attachments) {
            fm.attachments = [];
          }
          stampedId = fm.id;
        });
        // Replace ONLY the body, preserving the freshly-updated FM block.
        const updatedContent = await app.vault.read(existing);
        const fmMatch = updatedContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        const newContent = fmMatch ? `${fmMatch[0]}${body}` : body;
        await app.vault.modify(existing, newContent);
        if (stampedId) prefixToId.set(prefix, stampedId);
        updated++;
      } catch (err) {
        console.error("[stashpad] buildJdIndexNotes: update failed", err);
        skipped++;
      }
      continue;
    }

    // Create new.
    try {
      const id = newId();
      prefixToId.set(prefix, id);
      const slug = bodyToSlug(title, settings.slugStopWords);
      const filename = buildFilename(slug, id);
      const targetPath = `${destFolder}/${filename}`;
      const frontmatter = [
        "---",
        `id: ${id}`,
        `parent: ${parentId}`,
        `created: "${new Date().toISOString()}"`,
        "attachments: []",
        `jdPrefix: "${prefix}"`,
        "---",
        "",
      ].join("\n");
      await app.vault.create(targetPath, frontmatter + body);
      created++;
    } catch (err) {
      console.error("[stashpad] buildJdIndexNotes: create failed for", prefix, err);
      skipped++;
    }
  }

  return { created, updated, skipped, destFolder };
}

/** Strip leading/trailing slashes from a folder path. Empty string =
 *  vault root. */
function normalizeFolderPath(p: string): string {
  return (p || "").trim().replace(/^\/+|\/+$/g, "");
}

function filterByScope(files: TFile[], settings: StashpadSettings): TFile[] {
  if ((settings.jdIndexScope ?? "vault") === "vault") return files;
  const folder = normalizeFolderPath(settings.jdIndexScopeFolder ?? "");
  if (!folder) return files;
  return files.filter((f) => {
    const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
    return dir === folder || dir.startsWith(folder + "/");
  });
}

function compareEntries(a: IndexEntry, b: IndexEntry, mode: "natural" | "created"): number {
  if (mode === "created") {
    const aMs = a.file?.stat?.ctime ?? 0;
    const bMs = b.file?.stat?.ctime ?? 0;
    if (aMs !== bMs) return aMs - bMs;
  }
  return compareSegments(a.segments, b.segments);
}

/** Compare two whole prefix strings. Handles range-area shape
 *  (`\d+-\d+`) by using the LOWER bound as the sort key; otherwise
 *  splits on dots and does the segment-by-segment numeric-aware
 *  compare. */
function comparePrefixes(a: string, b: string): number {
  const aRange = a.match(/^(\d+)-(\d+)$/);
  const bRange = b.match(/^(\d+)-(\d+)$/);
  const aKey = aRange ? [aRange[1]] : a.split(".");
  const bKey = bRange ? [bRange[1]] : b.split(".");
  return compareSegments(aKey, bKey);
}

/** Numeric-aware segment compare. All-numeric segments sort numerically
 *  ("10" after "9"); all-alpha segments sort alphabetically; mixed:
 *  numbers come before letters at the same depth. */
function compareSegments(a: string[], b: string[]): number {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    const ai = a[i];
    const bi = b[i];
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = parseInt(ai, 10) - parseInt(bi, 10);
      if (diff !== 0) return diff;
    } else if (aNum && !bNum) {
      return -1; // numbers first
    } else if (!aNum && bNum) {
      return 1;
    } else {
      const cmp = ai.localeCompare(bi, undefined, { numeric: true, sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return a.length - b.length;
}

/** Build a {roots, childrenOf, depthOf} hierarchy from the full set of
 *  prefixes. Areas (`10-19`) are roots; categories nest under their
 *  area via NUMERIC RANGE; IDs nest under their dotted parent. */
function buildJdHierarchy(entries: Map<string, IndexEntry | null>) {
  const allPrefixes = new Set(entries.keys());
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const prefix of allPrefixes) {
    const parent = findParentPrefix(prefix, allPrefixes);
    parentOf.set(prefix, parent);
    if (parent !== null) {
      const kids = childrenOf.get(parent) ?? [];
      kids.push(prefix);
      childrenOf.set(parent, kids);
    }
  }
  const roots: string[] = [];
  for (const prefix of allPrefixes) {
    if (parentOf.get(prefix) === null) roots.push(prefix);
  }
  roots.sort(comparePrefixes);
  for (const list of childrenOf.values()) list.sort(comparePrefixes);
  const depthOf = new Map<string, number>();
  const walk = (prefix: string, d: number): void => {
    depthOf.set(prefix, d);
    for (const c of childrenOf.get(prefix) ?? []) walk(c, d + 1);
  };
  for (const r of roots) walk(r, 0);
  return { roots, childrenOf, depthOf };
}

function renderPreview(indexed: IndexEntry[], nonIndex: TFile[], skipped: TFile[]): string {
  // 0.71.11: full preview structure with three sections —
  //   (1) the indexed hierarchy (with synthetic parents),
  //   (2) non-indexed notes (don't match the prefix convention),
  //   (3) excluded notes, collapsed to one line per containing folder.
  // The home note's body is the user's index landing page; this is
  // what they actually read. (Individual index notes are still
  // link-only per the 0.71.11 change above.)
  const lines: string[] = [];
  // 0.71.12: section headings become H1 (single `#`). Bullet items
  // get a `#`-count prefix matching their nesting depth (depth 0 = "#",
  // depth 1 = "##", capped at six). The hash count is inside the
  // bullet text so it renders as visual weight rather than an actual
  // Obsidian heading.
  const hashesAt = (depth: number): string => "#".repeat(Math.min(depth + 1, 6));
  lines.push("# Indexed");
  lines.push("");
  if (indexed.length === 0) {
    const hint = skipped.length > 0
      ? `_No notes matched. ${skipped.length} note${skipped.length === 1 ? " was" : "s were"} excluded because they live inside a Stashpad folder — toggle "Include Stashpad folders in scan" in Settings → JD Index Builder if you want them included._`
      : `_No notes matched the JD-prefix convention. Check Scope and Designated folder in Settings → JD Index Builder._`;
    lines.push(hint);
  } else {
    const entries = new Map<string, IndexEntry | null>();
    for (const e of indexed) entries.set(e.prefix, e);
    // Add synthetic dotted ancestors (e.g. "1.2.3" present but no
    // "1.2"). Range ancestors are NOT auto-synthesized — categories
    // without a containing area just live at root.
    for (const e of indexed) {
      if (!e.prefix.includes(".")) continue;
      for (let i = 1; i < e.segments.length; i++) {
        const ancestor = e.segments.slice(0, i).join(".");
        if (!entries.has(ancestor)) entries.set(ancestor, null);
      }
    }
    const { roots, childrenOf, depthOf } = buildJdHierarchy(entries);
    const visit = (prefix: string): void => {
      const entry = entries.get(prefix);
      const depth = depthOf.get(prefix) ?? 0;
      const indent = "  ".repeat(depth);
      const hashes = hashesAt(depth);
      const titleSuffix = entry?.folder
        ? ` ${entry.title} _(folder)_`
        : entry?.file
          ? ""
          : "";
      if (entry?.file) {
        lines.push(`${indent}- ${hashes} [[${entry.file.basename}|${entry.prefix} ${entry.title}]]`);
      } else if (entry?.folder) {
        lines.push(`${indent}- ${hashes} ${entry.prefix}${titleSuffix}`);
      } else {
        lines.push(`${indent}- ${hashes} ${prefix}`);
      }
      for (const c of childrenOf.get(prefix) ?? []) visit(c);
    };
    for (const r of roots) visit(r);
  }
  if (nonIndex.length > 0) {
    lines.push("");
    lines.push(`# Non-indexed (${nonIndex.length})`);
    lines.push("");
    lines.push("_These notes don't match the JD-prefix convention. Rename them to `<prefix> <title>` and re-run to include them._");
    lines.push("");
    for (const f of nonIndex) {
      lines.push(`- # [[${f.basename}]] · \`${f.path}\``);
    }
  }
  if (skipped.length > 0) {
    const byFolder = new Map<string, number>();
    for (const f of skipped) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      byFolder.set(dir, (byFolder.get(dir) ?? 0) + 1);
    }
    const folders = Array.from(byFolder.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    lines.push("");
    lines.push(`# Excluded folders (${folders.length})`);
    lines.push("");
    lines.push('_Stashpad folders are excluded by default so the index doesn\'t reference itself. Toggle "Include Stashpad folders in scan" in Settings → JD Index Builder to include them._');
    lines.push("");
    for (const [folder, count] of folders) {
      lines.push(`- # All ${count} file${count === 1 ? "" : "s"} in \`${folder || "(vault root)"}\``);
    }
  }
  return lines.join("\n") + "\n";
}

/** 0.71.11 — shared persistent Notice for "Home note updated" with a
 *  bold title row + bulleted summary + a small Open button.
 *  Clicking anywhere on the Notice dismisses it; the Open button uses
 *  stopPropagation so click-Open opens the file then dismisses. */
export function buildJdPreviewNotice(
  app: App,
  result: { indexed: IndexEntry[]; nonIndex: TFile[]; skippedStashpadNotes: TFile[]; previewPath: string | null },
): Notice {
  const frag = document.createDocumentFragment();
  // Heading-style title row.
  const title = frag.createEl("div", { text: "Home note updated" });
  title.setCssStyles({ fontWeight: "600", marginBottom: "6px" });
  // Bulleted summary.
  const ul = frag.createEl("ul");
  ul.setCssStyles({ margin: "0 0 8px 0", paddingLeft: "18px" });
  ul.createEl("li", { text: `${result.indexed.length} indexed` });
  ul.createEl("li", { text: `${result.nonIndex.length + result.skippedStashpadNotes.length} excluded` });
  // Small Open button.
  const openBtn = frag.createEl("button", { text: "Open", cls: "mod-cta" });
  openBtn.setCssStyles({ padding: "2px 10px", fontSize: "var(--font-ui-smaller)" });
  let notice: Notice;
  openBtn.onclick = async (ev) => {
    ev.stopPropagation();
    if (result.previewPath) {
      const af = app.vault.getAbstractFileByPath(result.previewPath);
      if (af instanceof TFile) await app.workspace.getLeaf("tab").openFile(af);
    }
    notice?.hide();
  };
  notice = new Notice(frag, 0);
  return notice;
}

/** 0.71.3 — confirmation modal for "Build JD index notes." V1 of the
 *  test-before-commit nudge: leads with a Preview suggestion the
 *  first time, gets terser after the user has built once, and flags
 *  unusually-large builds (>50 notes) every time regardless of past
 *  confirmations. Three buttons: Preview / Build / Cancel. Preview
 *  runs the lightweight single-file generator without closing the
 *  modal so the user can build right after if they want. */
export class JdBuildConfirmModal extends Modal {
  private readonly LARGE_BUILD = 50;
  private previewRan = false;
  private previewPath: string | null = null;

  constructor(
    app: App,
    private plugin: import("./main").default,
    private settings: import("./settings").StashpadSettings,
    private indexedCount: number,
    private onBuild: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const isFirstBuild = !this.settings.jdIndexHasBuilt;
    const isLarge = this.indexedCount > this.LARGE_BUILD;
    titleEl.setText(isFirstBuild ? "Build JD index — first time?" : "Build JD index");

    // 0.71.13: mix plain text + <code> spans so the folder name (in
    // quotes) and the literal `jdPrefix` field render in the
    // monospace style the user requested.
    const folder = this.settings.jdIndexStashpadFolder;
    const p1 = contentEl.createEl("p");
    const noteCountStr = `${this.indexedCount} note${this.indexedCount === 1 ? "" : "s"}`;
    if (isFirstBuild) {
      p1.appendText(`Stashpad is about to create ${noteCountStr} (plus synthetic parents as needed) inside "`);
      p1.createEl("code", { text: folder });
      p1.appendText(`". Existing notes with the same `);
      p1.createEl("code", { text: "jdPrefix" });
      p1.appendText(" are updated, never deleted — but if the prefix detection picks up notes you didn't mean to index, you'll end up with a lot of unwanted notes.");
      const p2 = contentEl.createEl("p");
      p2.setText("Running Preview first writes a single Markdown file showing exactly what would be built (and what wouldn't), so you can sanity-check before committing.");
    } else if (isLarge) {
      p1.appendText(`You're about to create ${this.indexedCount} notes in "`);
      p1.createEl("code", { text: folder });
      p1.appendText(`". That's a big batch — if anything looks off, Preview the single-file output first.`);
    } else {
      p1.appendText(`Build the JD index into "`);
      p1.createEl("code", { text: folder });
      p1.appendText(`"? Stashpad will create / update ${noteCountStr}. Existing notes with matching `);
      p1.createEl("code", { text: "jdPrefix" });
      p1.appendText(" are updated in place.");
    }

    if (this.previewRan && this.previewPath) {
      const note = contentEl.createEl("p", { cls: "setting-item-description" });
      note.setText(`✓ Preview written to home note (${this.previewPath}). Open it before building if you haven't.`);
    }

    const actions = new Setting(contentEl);
    if (isFirstBuild || isLarge) {
      actions.addButton((b) => {
        b.setButtonText(this.previewRan ? "Re-run preview" : "Run preview first");
        b.setCta();
        b.onClick(async () => {
          try {
            const result = await buildJdIndexPreview(this.app, this.plugin, this.settings);
            if (result.error === "no-dest") {
              new Notice("Set a Designated Stashpad folder for Index first.", 5000);
              this.close();
              return;
            }
            if (result.error === "no-home") {
              new Notice(
                `"${this.settings.jdIndexStashpadFolder}" has no Stashpad home note. Open the folder in Stashpad first.`,
                7000,
              );
              this.close();
              return;
            }
            this.previewRan = true;
            this.previewPath = result.previewPath;
            buildJdPreviewNotice(this.app, result);
            // Re-render to show the "preview written" notice in the modal too.
            this.contentEl.empty();
            this.titleEl.empty();
            this.onOpen();
          } catch (err) {
            new Notice(`Preview failed: ${(err as Error)?.message ?? err}`, 8000);
          }
        });
      });
    }
    actions.addButton((b) => {
      b.setButtonText(isFirstBuild ? "Build anyway" : "Build");
      if (!isFirstBuild && !isLarge) b.setCta();
      b.onClick(async () => {
        this.close();
        await this.onBuild();
      });
    });
    actions.addButton((b) => {
      b.setButtonText("Cancel");
      b.onClick(() => this.close());
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
