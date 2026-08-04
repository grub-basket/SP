/** Importer for data extracted from the dead Stashpad DESKTOP app.
 *
 *  Distinct from `text-importer.ts`, which infers hierarchy from indentation
 *  because pasted text is all it ever has. This one reads the extraction's
 *  `notes.json`, which carries explicit parent/child ids — so there is nothing to
 *  infer and nothing to get wrong.
 *
 *  Background, palette table and field caveats: docs/stashpad-app-import-plan.md.
 *  Stays Obsidian-free so it can be reasoned about (and tested) on its own.
 */
import { BUILTIN_COLOR_NAMES, type ImportNote } from "./text-importer";
import { expandShortcodes } from "./emoji-shortcodes";

/** The desktop app stored colour as an integer 0-9. Index = that colorCode.
 *
 *  Mapped onto THIS plugin's palette rather than the app's own hexes: colour
 *  persists as a baked hex per note, so adopting the app's values would leave two
 *  subtly different reds side by side in a vault that already has hundreds of
 *  notes on ours.
 *
 *  ⚠️ The names slide by one at the top. The app's palette runs
 *  Purple, Fuchsia, Pink; ours runs purple, pink, magenta. So app code 8
 *  ("Fuchsia") maps to our `pink`, and code 9 ("Pink") maps to our `magenta`.
 *  MAP BY CODE, NEVER BY NAME. */
/** app colorCode -> the NAME of the matching colour in this plugin's palette.
 *
 *  ⚠️ The names slide by one at the top. The app's palette runs
 *  Purple, Fuchsia, Pink; ours runs purple, pink, magenta. So app code 8
 *  ("Fuchsia") maps to our `pink`, and code 9 ("Pink") maps to our `magenta`.
 *  MAP BY CODE, NEVER BY NAME. */
const APP_CODE_TO_PLUGIN_NAME: ReadonlyArray<{ appName: string; pluginName: string | null }> = [
  { appName: "None",    pluginName: null },
  { appName: "Red",     pluginName: "red" },
  { appName: "Orange",  pluginName: "orange" },
  { appName: "Gold",    pluginName: "amber" },
  { appName: "Lime",    pluginName: "lime" },
  { appName: "Green",   pluginName: "green" },
  { appName: "Blue",    pluginName: "blue" },
  { appName: "Purple",  pluginName: "purple" },
  { appName: "Fuchsia", pluginName: "pink" },
  { appName: "Pink",    pluginName: "magenta" },
];

/** Resolved at module load from BUILTIN_COLOR_NAMES rather than hardcoded, so if
 *  the plugin's palette hexes are ever retuned the importer follows automatically.
 *
 *  KNOWN DRIFT RISK (deliberate, revisit later): this still couples by NAME. If a
 *  palette entry is ever renamed or removed, the lookup silently falls back to no
 *  colour for that code. A rename should update APP_CODE_TO_PLUGIN_NAME too. */
export const APP_COLOR_BY_CODE: ReadonlyArray<{ appName: string; hex: string | null; alias: string | null }> =
  APP_CODE_TO_PLUGIN_NAME.map(({ appName, pluginName }) => {
    const hex = pluginName ? (BUILTIN_COLOR_NAMES[pluginName] ?? null) : null;
    return {
      appName,
      hex,
      alias: hex ? appName : null,   // keep the app's own name as the folder alias
    };
  });

/** Roots the extraction assigns. `HOME` is ordinary content; the rest are the
 *  app's structural containers, and TRASH is deleted material. */
export const APP_ROOTS = ["HOME", "TODOS", "SHARE_ROOT", "SHARED_STASHES", "ORPHAN", "TRASH", "SIDEBAR", "NOTES_FOOTER"] as const;
export type AppRoot = (typeof APP_ROOTS)[number] | string;

/** Roots imported unless the user says otherwise. TRASH is deliberately out:
 *  nothing is soft-deleted in the source, so Trash is only tree membership, and
 *  importing it would silently resurrect deleted notes. */
/** Everything, by default. Earlier this omitted TRASH/SIDEBAR/NOTES_FOOTER on
 *  the grounds that Trash was deleted material - but a rescue from a dead app
 *  should default to leaving nothing behind, and silently skipping thousands of
 *  notes is the worse failure. The section parents make it obvious what came
 *  from Trash, and unticking it is one click. */
export const DEFAULT_ROOTS: AppRoot[] = [...APP_ROOTS];

export interface AppImportOptions {
  /** Which source roots to bring across. */
  roots: AppRoot[];
  /** `done` -> a Stashpad task, vs dropped entirely. The source's own markdown
   *  checkboxes are left alone either way, so this never double-counts. */
  doneAsTask: boolean;
  /** Use the app's original hexes (from `colorHex`) instead of this plugin's palette. */
  faithfulColors: boolean;
  /** Preserve each note's original created/modified timestamps. */
  keepTimestamps: boolean;
  /** Convert any supplied helper files into notes under a reference parent. */
  includeHelpers: boolean;
  /** Skip notes whose Stashpad id is already in this folder (the re-run guard).
   *  Turn OFF to import everything again regardless — the override. */
  skipAlreadyImported: boolean;
  /** Group the notes that were invisible in the app under one obvious parent. */
  groupOrphans: boolean;
  /** File each non-Home section (Trash, Todos, Shared…) under a labelled parent
   *  so it stays obvious what a note was in Stashpad. Home stays at top level. */
  sectionParents: boolean;
  /** Tag each note with what it was in Stashpad, under a `stashpad/` namespace. */
  addTags: boolean;
  /** Turn Stashpad's literal `:shortcode:` text into the emoji it rendered as. */
  expandEmoji: boolean;
}

export const DEFAULT_APP_IMPORT_OPTIONS: AppImportOptions = {
  roots: [...DEFAULT_ROOTS],
  doneAsTask: true,
  // The app's own hexes. Off would map onto this plugin's palette instead, which
  // keeps imports consistent with notes you already had; on reproduces what the
  // old app actually looked like.
  faithfulColors: true,
  keepTimestamps: true,
  includeHelpers: true,
  skipAlreadyImported: true,
  groupOrphans: true,
  sectionParents: true,
  addTags: true,
  expandEmoji: true,
};

/** One note to create. Extends the text importer's shape so the existing creation
 *  path (parentIndex -> already-created id) works unchanged. */
export interface AppImportNote extends ImportNote {
  /** The desktop app's uuid. Stamped on the note so a re-run can detect duplicates. */
  sourceId: string;
  createdAt: string | null;
  modifiedAt: string | null;
  root: AppRoot;
  orphaned: boolean;
  /** Metadata only — the image bytes no longer exist anywhere. */
  attachments: Array<{ name: string; type: string; size: number }>;
  /** Ids of any parent beyond the first. Non-empty only for genuinely
   *  multi-parent notes, which a folder tree cannot represent. */
  extraParents: string[];
  /** Pinned in the desktop app's sidebar, and its position there. */
  pinned: boolean;
  pinnedOrder: number | null;
  /** A grouping note the importer invented (no counterpart in the source), so
   *  the re-run guard and the id stamp can leave it alone. */
  synthetic?: boolean;
  /** Obsidian tags describing what this was in Stashpad. Empty when off. */
  tags: string[];
}

export interface AppImportResult {
  notes: AppImportNote[];
  /** Per-root counts of what will actually be created. */
  byRoot: Record<string, number>;
  stats: {
    totalInFile: number;
    selected: number;
    skippedRoot: number;
    done: number;
    coloured: number;
    withAttachments: number;
    attachments: number;
    multiParent: number;
    orphaned: number;
    pinned: number;
    duplicateChildRefs: number;
    alreadyImported: number;
    emojiExpanded: number;
  };
  warnings: string[];
}

interface RawNote {
  id: string;
  text?: string;
  done?: boolean;
  color?: number;
  colorHex?: string | null;
  createdAt?: string;
  modifiedAt?: string;
  children?: string[];
  parents?: Array<{ id: string; order?: number }>;
  root?: string;
  specialType?: string | null;
  pinned?: boolean;
  pinnedOrder?: number | null;
  orphaned?: boolean;
  markedAsStack?: boolean;
  isDoc?: boolean;
  lastVisited?: string | null;
  taskGrouping?: string | null;
  customColor?: string | null;
  comments?: unknown[];
  sharedWith?: unknown[];
  attachments?: Array<{ name: string; type: string; size: number }>;
}

/** Section a note belongs to, as a tag-friendly slug. HOME is deliberately not
 *  tagged: it is the default and would cover most of the archive, saying nothing. */
const ROOT_TAG: Record<string, string | null> = {
  HOME: null,
  TRASH: "trash",
  TODOS: "todos",
  SHARE_ROOT: "shared",
  SHARED_STASHES: "shared-with-me",
  ORPHAN: "recovered",
  SIDEBAR: "sidebar",
  NOTES_FOOTER: "footer",
};

/** An unticked markdown checkbox. Stashpad's own `done` flag does NOT cover
 *  these — a note can carry an open checkbox and still be "not done", so this is
 *  the only signal for a task that is still outstanding. */
const OPEN_CHECKBOX = /^\s*(?:[-*+]\s*)?\[ \]/m;
const ANY_CHECKBOX = /^\s*(?:[-*+]\s*)?\[[ xX]\]/m;

/** Tags describing what a note was in Stashpad.
 *
 *  Namespaced under `stashpad/` on purpose: these are observations about an
 *  import, not part of the user's own vocabulary, and Obsidian nests them so the
 *  whole set collapses under one heading in the tag pane.
 *
 *  Only facts that DISCRIMINATE earn a tag. A tag every note carries is noise —
 *  which is why HOME, and flags that are constant across an archive, are absent. */
function tagsFor(n: RawNote, root: string, colorName: string | null): string[] {
  const out: string[] = [];
  const rootTag = ROOT_TAG[root];
  if (rootTag) out.push(`stashpad/${rootTag}`);

  const year = (n.createdAt ?? "").slice(0, 4);
  if (/^\d{4}$/.test(year)) out.push(`stashpad/year/${year}`);

  const text = n.text ?? "";
  if (n.done) out.push("stashpad/done");
  // Outstanding work the `done` flag misses entirely.
  else if (OPEN_CHECKBOX.test(text)) out.push("stashpad/open-task");
  else if (ANY_CHECKBOX.test(text)) out.push("stashpad/task");

  if (n.pinned) out.push("stashpad/pinned");
  if (colorName) out.push(`stashpad/colour/${colorName.toLowerCase()}`);
  if (n.attachments?.length) out.push("stashpad/attachment");

  // Everything below is provenance rather than triage: if the import has to be
  // redone, these are what let you find the affected notes in seconds instead
  // of re-deriving them from the export. A tag is only emitted when the
  // attribute is actually set, so one that is false across an archive costs
  // nothing - which is why listing them all here is safe.
  if (new Set((n.parents ?? []).map((p) => p.id)).size > 1) out.push("stashpad/multi-parent");
  if (new Set(n.children ?? []).size !== (n.children ?? []).length) out.push("stashpad/duplicate-child");
  if (!(n.text ?? "").trim()) out.push("stashpad/empty");
  if ((n.text ?? "").includes("~~")) out.push("stashpad/strikethrough");
  if (n.markedAsStack) out.push("stashpad/stack");
  if (n.isDoc) out.push("stashpad/doc");
  if (n.lastVisited) out.push("stashpad/recently-visited");
  if (n.taskGrouping) out.push(`stashpad/task-grouping/${String(n.taskGrouping).toLowerCase()}`);
  if (n.customColor) out.push("stashpad/custom-colour");
  if (n.comments?.length) out.push("stashpad/comments");
  if (n.sharedWith?.length) out.push("stashpad/shared-with-someone");
  return out;
}

/** True when `value` looks like the extraction's notes.json (an array of records
 *  carrying an id and a children array). Used to tell notes.json apart from the
 *  helper files when several are dropped at once. */
export function looksLikeNotesJson(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0] as Record<string, unknown>;
  return !!first && typeof first.id === "string" && Array.isArray(first.children);
}

/** Build the create-list from a parsed notes.json.
 *
 *  Walks each selected root breadth-first so parents always precede children,
 *  which is what parentIndex requires. A note reachable from more than one parent
 *  is created ONCE, under whichever parent is reached first; the other parent ids
 *  travel on `extraParents` rather than being silently dropped. */
export function buildAppImport(
  raw: unknown,
  opts: AppImportOptions,
  /** Stashpad ids already present in the destination folder — the re-run guard. */
  existingSourceIds: ReadonlySet<string> = new Set<string>(),
): AppImportResult {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return {
      notes: [], byRoot: {},
      stats: { totalInFile: 0, selected: 0, skippedRoot: 0, done: 0, coloured: 0, withAttachments: 0, attachments: 0, multiParent: 0, orphaned: 0, pinned: 0, duplicateChildRefs: 0, alreadyImported: 0, emojiExpanded: 0 },
      warnings: ["That file isn't a Stashpad export — expected a JSON array of notes."],
    };
  }

  const all = raw as RawNote[];
  const byId = new Map<string, RawNote>();
  for (const n of all) if (n && typeof n.id === "string") byId.set(n.id, n);

  const wanted = new Set(opts.roots);
  let duplicateChildRefs = 0;
  let skippedRoot = 0;
  let emojiExpanded = 0;
  const unknownShortcodes = new Set<string>();

  // Roots = notes nobody lists as a child. Structural containers ("Home",
  // "Trash", …) are NOT imported as notes — their children become top level.
  const isChild = new Set<string>();
  for (const n of all) {
    const seen = new Set<string>();
    for (const c of n.children ?? []) {
      if (seen.has(c)) duplicateChildRefs++;   // the one known case in the source
      seen.add(c);
      isChild.add(c);
    }
  }

  const notes: AppImportNote[] = [];
  const indexById = new Map<string, number>();
  const queued = new Set<string>();

  const push = (n: RawNote, parentIndex: number | null, level: number): number => {
    const code = typeof n.color === "number" ? n.color : 0;
    const entry = APP_COLOR_BY_CODE[code] ?? APP_COLOR_BY_CODE[0];
    const hex = opts.faithfulColors ? (n.colorHex ?? entry.hex) : entry.hex;
    // Every parent past the first, deduplicated — the source contains one parent
    // that lists the same child twice, which must not read as multi-parent.
    const parentIds = [...new Set((n.parents ?? []).map((p) => p.id))];
    // Stashpad kept shortcodes as literal text and expanded them at render time,
    // so this is the only point where they can become the emoji the user
    // actually saw. Unknown codes are left exactly as they were.
    const emoji = opts.expandEmoji ? expandShortcodes(n.text ?? "") : null;
    if (emoji?.replaced.length) emojiExpanded += emoji.replaced.length;
    if (emoji?.unknown.length) for (const u of emoji.unknown) unknownShortcodes.add(u);
    const note: AppImportNote = {
      body: emoji ? emoji.text : (n.text ?? ""),
      level,
      parentIndex,
      color: hex ?? null,
      colorAlias: hex ? entry.alias : null,
      colorName: null,
      task: opts.doneAsTask && n.done ? "done" : "none",
      sourceId: n.id,
      createdAt: opts.keepTimestamps ? (n.createdAt ?? null) : null,
      modifiedAt: opts.keepTimestamps ? (n.modifiedAt ?? null) : null,
      root: n.root ?? "HOME",
      orphaned: !!n.orphaned,
      attachments: n.attachments ?? [],
      extraParents: parentIds.slice(1),
      pinned: !!n.pinned,
      pinnedOrder: n.pinnedOrder ?? null,
      tags: opts.addTags
        ? [...tagsFor(n, n.root ?? "HOME", entry.appName === "None" ? null : entry.appName),
           ...(emoji?.replaced.length ? ["stashpad/emoji"] : [])]
        : [],
    };
    const idx = notes.length;
    notes.push(note);
    indexById.set(n.id, idx);
    return idx;
  };

  // A labelled parent per section, so after the import it stays obvious what a
  // note WAS in Stashpad — Trash is not silently mixed in with Home, and the
  // notes that were unreachable are impossible to miss. Home has no wrapper:
  // it was the main list, so it becomes the main list here.
  const SECTION: Record<string, { title: string; colour: string | null; blurb: string }> = {
    ORPHAN: {
      title: "Recovered from Stashpad",
      colour: "amber",
      blurb: "These notes existed in the Stashpad database but were unreachable from Home, so the app could only surface them through search. They are intact.",
    },
    TRASH: {
      title: "Stashpad Trash (deleted in the app)",
      colour: "red",
      blurb: "These were in Stashpad's Trash when it was exported. They are kept separate so nothing deleted quietly rejoins your notes.",
    },
    TODOS: {
      title: "Stashpad Todos",
      colour: "green",
      blurb: "The app's dedicated Todos section.",
    },
    SHARE_ROOT: {
      title: "Stashpad Shared",
      colour: "blue",
      blurb: "Notes shared out of Stashpad. The sharing service no longer runs; the content is unaffected.",
    },
    SHARED_STASHES: {
      title: "Shared with me (Stashpad)",
      colour: "blue",
      blurb: "Notes other people shared into your Stashpad.",
    },
    SIDEBAR: { title: "Stashpad Sidebar", colour: null, blurb: "The app's sidebar container." },
    NOTES_FOOTER: { title: "Stashpad Footer", colour: null, blurb: "The app's notes-footer container." },
  };

  const sectionIndex = new Map<string, number>();
  const sectionParent = (rootKind: string): number | null => {
    if (rootKind === "HOME") return null;
    const wanted = rootKind === "ORPHAN" ? opts.groupOrphans : opts.sectionParents;
    if (!wanted) return null;
    const cached = sectionIndex.get(rootKind);
    if (cached !== undefined) return cached;
    const meta = SECTION[rootKind] ?? { title: `Stashpad ${rootKind}`, colour: null, blurb: "" };
    const hex = meta.colour ? (BUILTIN_COLOR_NAMES[meta.colour] ?? null) : null;
    notes.push({
      body: meta.blurb ? `${meta.title}\n\n${meta.blurb}` : meta.title,
      level: 1,
      parentIndex: null,
      color: hex,
      colorAlias: hex && meta.colour ? meta.colour.charAt(0).toUpperCase() + meta.colour.slice(1) : null,
      colorName: null,
      task: "none",
      sourceId: "",
      createdAt: null,
      modifiedAt: null,
      root: rootKind,
      orphaned: rootKind === "ORPHAN",
      attachments: [],
      extraParents: [],
      pinned: false,
      pinnedOrder: null,
      synthetic: true,
      tags: opts.addTags ? ["stashpad/section"] : [],
    });
    const idx = notes.length - 1;
    sectionIndex.set(rootKind, idx);
    return idx;
  };

  for (const root of all) {
    if (!root || isChild.has(root.id)) continue;
    const rootKind = root.root ?? (root.specialType ?? "HOME");
    if (!wanted.has(rootKind)) {
      skippedRoot++;
      continue;
    }

    // A structural container is a scaffold, not content — import its children.
    // A detached root (no specialType) IS a real note, so it comes across itself.
    const structural = !!root.specialType;
    const queue: Array<{ id: string; parentIndex: number | null; level: number }> = [];

    const host = sectionParent(rootKind);
    const startLevel = host === null ? 1 : 2;
    if (structural) {
      // The container itself is scaffolding; its children are the content.
      for (const c of root.children ?? []) queue.push({ id: c, parentIndex: host, level: startLevel });
    } else {
      // A detached root IS a real note, and the thing the user could not find.
      queue.push({ id: root.id, parentIndex: host, level: startLevel });
    }

    while (queue.length) {
      const item = queue.shift()!;
      if (queued.has(item.id)) continue;      // already created under another parent
      const n = byId.get(item.id);
      if (!n) { warnings.push(`Missing note referenced by id ${item.id} — skipped.`); continue; }
      queued.add(item.id);
      const idx = push(n, item.parentIndex, item.level);
      for (const c of new Set(n.children ?? [])) {
        if (!queued.has(c)) queue.push({ id: c, parentIndex: idx, level: item.level + 1 });
      }
    }
  }

  // ---- re-run guard -------------------------------------------------------
  // A note already in the folder is dropped; anything below it climbs to the
  // nearest ancestor that survived, so a partial re-import still lands somewhere
  // sensible rather than being silently discarded.
  let alreadyImported = 0;
  let finalNotes = notes;
  if (opts.skipAlreadyImported && existingSourceIds.size) {
    const keep = notes.map((n) => n.synthetic || !existingSourceIds.has(n.sourceId));
    alreadyImported = keep.filter((k) => !k).length;
    if (alreadyImported) {
      const remap = new Array<number | null>(notes.length).fill(null);
      let next = 0;
      notes.forEach((_, i) => { if (keep[i]) remap[i] = next++; });
      const survivingAncestor = (i: number | null): number | null => {
        let cur = i;
        const guard = new Set<number>();
        while (cur !== null && !guard.has(cur)) {
          guard.add(cur);
          if (keep[cur]) return remap[cur];
          cur = notes[cur].parentIndex;
        }
        return null;
      };
      finalNotes = notes
        .filter((_, i) => keep[i])
        .map((n) => ({ ...n, parentIndex: survivingAncestor(n.parentIndex) }));
      // A synthetic parent with nothing left under it is just noise.
      const used = new Set(finalNotes.map((n) => n.parentIndex));
      finalNotes = finalNotes.filter((n, i) => !n.synthetic || used.has(i));
    }
    if (alreadyImported) {
      warnings.push(
        `${alreadyImported.toLocaleString()} note${alreadyImported === 1 ? " was" : "s were"} already imported into this folder and will be skipped. `
        + "Turn off “Skip notes already imported” to bring them in again as duplicates.",
      );
    }
  }
  // Only rewrite in place when the guard actually produced a NEW array — when
  // nothing was skipped finalNotes IS notes, and clearing it first would empty
  // the very array being copied from.
  if (finalNotes !== notes) {
    notes.length = 0;
    notes.push(...finalNotes);
  }

  const byRoot: Record<string, number> = {};
  for (const n of notes) byRoot[n.root] = (byRoot[n.root] ?? 0) + 1;

  const multiParent = notes.filter((n) => n.extraParents.length).length;
  if (multiParent) {
    warnings.push(
      `${multiParent} note${multiParent === 1 ? " was" : "s were"} filed under more than one parent in Stashpad. `
      + "Obsidian's folder tree can't hold a note in two places, so each is created once and its other parent is recorded in frontmatter.",
    );
  }
  if (duplicateChildRefs) {
    warnings.push(
      `${duplicateChildRefs} duplicate child reference${duplicateChildRefs === 1 ? " in the source was" : "s in the source were"} collapsed, so nothing imports twice.`,
    );
  }
  if (unknownShortcodes.size) {
    const list = [...unknownShortcodes].slice(0, 8).join(", ");
    warnings.push(
      `${unknownShortcodes.size} shortcode${unknownShortcodes.size === 1 ? "" : "s"} had no emoji mapping and were left as text (${list}${unknownShortcodes.size > 8 ? ", …" : ""}).`,
    );
  }
  const withAtt = notes.filter((n) => n.attachments.length);
  if (withAtt.length) {
    warnings.push(
      `${withAtt.length} note${withAtt.length === 1 ? " had an image attachment" : "s had image attachments"}. Stashpad kept images on its own server, which is gone, `
      + "so only the file name, type and size survive — they're recorded in frontmatter, but no images can be restored.",
    );
  }

  return {
    notes,
    byRoot,
    stats: {
      totalInFile: all.length,
      selected: notes.length,
      skippedRoot,
      done: notes.filter((n) => n.task === "done").length,
      coloured: notes.filter((n) => n.color).length,
      withAttachments: withAtt.length,
      attachments: notes.reduce((s, n) => s + n.attachments.length, 0),
      multiParent,
      orphaned: notes.filter((n) => n.orphaned && !n.synthetic).length,
      pinned: notes.filter((n) => n.pinned).length,
      duplicateChildRefs,
      alreadyImported,
      emojiExpanded,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ helpers */

/** A supporting file from the extraction — everything that isn't notes.json.
 *  Optional: the import works without any of them, but they carry the palette,
 *  the attachment catalogue and the extraction's own notes, which are worth
 *  keeping next to the data they describe. */
export interface HelperFile {
  name: string;
  text: string;
  /** Bytes, for the receipt shown next to the file name. */
  size: number;
}

export interface HelperNote { title: string; body: string }

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Render a helper file as a readable note rather than dumping raw JSON.
 *  Recognises the three the extraction produces; anything else is preserved
 *  verbatim in a fenced block so nothing is lost. */
export function helperToNote(file: HelperFile): HelperNote {
  const name = file.name.toLowerCase();
  let parsed: any = null;
  if (name.endsWith(".json")) {
    try { parsed = JSON.parse(file.text); } catch { /* fall through to verbatim */ }
  }

  if (name.endsWith(".md")) {
    return { title: file.name.replace(/\.md$/i, ""), body: file.text };
  }

  if (parsed && name.includes("palette") && Array.isArray(parsed.colors)) {
    const rows = parsed.colors.map((c: any) =>
      `| ${c.colorCode} | ${c.name} | ${c.dark ?? "—"} | ${c.light ?? "—"} |`).join("\n");
    return {
      title: "Stashpad app colour palette",
      body: "The original desktop app's palette, read out of its own bundle.\n\n"
        + "Imported notes use this plugin's palette, mapped by code — the app's names shift by one at the top "
        + "(its Fuchsia is our pink, its Pink is our magenta), so these hexes are for reference only.\n\n"
        + "| Code | App name | Dark | Light |\n|---|---|---|---|\n" + rows,
    };
  }

  if (parsed && name.includes("attachment") && Array.isArray(parsed)) {
    const total = parsed.reduce((s: number, a: any) => s + (a.size ?? 0), 0);
    const byType: Record<string, number> = {};
    for (const a of parsed) byType[a.type] = (byType[a.type] ?? 0) + 1;
    const rows = parsed.slice(0, 400).map((a: any) =>
      `| ${a.name} | ${a.type} | ${fmtBytes(a.size ?? 0)} | ${(a.noteText ?? "").replace(/\|/g, "\\|").slice(0, 60)} |`).join("\n");
    return {
      title: "Attachment catalogue (images are gone)",
      body: `${parsed.length} attachments totalling ${fmtBytes(total)} — `
        + Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(", ") + ".\n\n"
        + "Stashpad stored these on its own server, which no longer exists, and kept no local copy. "
        + "Only this metadata survives. Byte size is nearly unique, so if the originals ever turn up "
        + "they can be matched on size.\n\n"
        + (parsed.length > 400 ? `_Showing the first 400 of ${parsed.length}._\n\n` : "")
        + "| File | Type | Size | Note |\n|---|---|---|---|\n" + rows,
    };
  }

  if (parsed && name.includes("pinned") && Array.isArray(parsed)) {
    const rows = parsed.map((x: any) => `| ${x.order} | ${(x.text ?? "").replace(/\|/g, "\\|").split("\n")[0]} |`).join("\n");
    return {
      title: "Pinned notes in the Stashpad app",
      body: `${parsed.length} notes were pinned to the app's sidebar, in this order. `
        + "Each one also carries `pinned: true` in its own frontmatter, so they are pinned here too — "
        + "this list is a readable record of what the sidebar looked like.\n\n"
        + "| Order | Note |\n|---|---|\n" + rows,
    };
  }

  if (parsed && name.includes("task") && Array.isArray(parsed)) {
    const rows = parsed.slice(0, 500).map((x: any) =>
      `| ${(x.text ?? "").replace(/\|/g, "\\|").split("\n")[0].slice(0, 90)} | ${(x.createdAt ?? "").slice(0, 10)} |`).join("\n");
    return {
      title: "Completed notes in the Stashpad app",
      body: `${parsed.length} notes were marked done. In the old app that showed as strikethrough rather than a checkbox — `
        + "the flag was stored in a field confusingly named `blurred`.\n\n"
        + "They are imported as completed tasks (unless that option was turned off), so this list is a readable record.\n\n"
        + (parsed.length > 500 ? `_Showing the first 500 of ${parsed.length}._\n\n` : "")
        + "| Note | Created |\n|---|---|\n" + rows,
    };
  }

  if (parsed && name.includes("recent") && Array.isArray(parsed)) {
    const rows = parsed.map((x: any) =>
      `| ${(x.visitedAt ?? "").slice(0, 10)} | ${(x.text ?? "").replace(/\|/g, "\\|").split("\n")[0].slice(0, 80)} |`).join("\n");
    return {
      title: "Recently visited in the Stashpad app",
      body: "The app's recently-visited list at the time of export — a snapshot of what was being worked on.\n\n"
        + "| Last visited | Note |\n|---|---|\n" + rows,
    };
  }

  if (parsed && name.includes("preference")) {
    const skip = new Set(["openTabs", "modifiedAt"]);
    const rows = Object.entries(parsed)
      .filter(([k]) => !skip.has(k))
      .map(([k, v]) => `| ${k} | ${typeof v === "object" ? JSON.stringify(v) : String(v)} |`).join("\n");
    const tabs = Array.isArray(parsed.openTabs)
      ? "\n\n## Tabs that were open\n\n" + parsed.openTabs.map((t: any) => `- ${(t.text ?? "").split("\n")[0]}`).join("\n")
      : "";
    return {
      title: "Stashpad app settings",
      body: "How the desktop app was configured when it was exported. Nothing here changes this plugin — "
        + "it is kept so the old setup is not simply lost.\n\n"
        + "| Setting | Value |\n|---|---|\n" + rows + tabs,
    };
  }

  if (parsed && name.includes("notification") && Array.isArray(parsed)) {
    const rows = parsed.map((x: any) => `| ${x.type} | ${x.read ? "read" : "unread"} | ${(x.modifiedAt ?? "").slice(0, 10)} |`).join("\n");
    return {
      title: "Stashpad app notifications",
      body: `${parsed.length} notifications were outstanding in the app.\n\n`
        + "| Type | State | When |\n|---|---|---|\n" + rows,
    };
  }

  if (parsed && name.includes("manifest")) {
    const counts = parsed.counts ?? {};
    const rows = Object.entries(counts)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `| ${k} | ${v} |`).join("\n");
    return {
      title: "Export manifest",
      body: `Source: ${parsed.source ?? "unknown"}\n\nExported: ${parsed.exportedAt ?? "unknown"}\n\n`
        + "| Measure | Count |\n|---|---|\n" + rows,
    };
  }

  return {
    title: file.name,
    body: `Imported verbatim (${fmtBytes(file.size)}).\n\n\`\`\`\n${file.text.slice(0, 20000)}\n\`\`\``
      + (file.text.length > 20000 ? "\n\n_Truncated._" : ""),
  };
}

/** Reference notes the importer can produce WITHOUT any helper file, because the
 *  facts are already known here. `palette.json` is the file version of the first
 *  one; if it's supplied it simply says the same thing with the app's own hexes.
 *
 *  These exist because the most common questions after an import ("why is this
 *  note a different red than I remember", "where did my images go") have answers
 *  that are easy to lose track of once the import is done. */
export function builtInReferenceNotes(): HelperNote[] {
  const rows = APP_CODE_TO_PLUGIN_NAME
    .map((c, code) => {
      if (!c.pluginName) return `| ${code} | ${c.appName} | — | — |`;
      const hex = BUILTIN_COLOR_NAMES[c.pluginName] ?? "?";
      return `| ${code} | ${c.appName} | ${c.pluginName} | ${hex} |`;
    })
    .join("\n");

  return [
    {
      title: "How Stashpad app colours were mapped",
      body:
        "The desktop app stored a colour as a number 0-9. Each one was mapped onto this plugin's own palette "
        + "by CODE, not by name — the two palettes name their last colours differently (the app's Fuchsia is "
        + "this plugin's pink, and the app's Pink is this plugin's magenta), so matching on names would have "
        + "mis-coloured them.\n\n"
        + "Imported notes therefore use this plugin's colours, which keeps them consistent with notes you "
        + "already had. The importer has a “Use the old app's exact colours” option if you would rather have "
        + "the originals.\n\n"
        + "| Code | Name in the app | Name here | Hex used |\n|---|---|---|---|\n" + rows,
    },
    {
      title: "What did not come across",
      body:
        "**Images.** Stashpad kept attachments on its own server rather than on your computer, and that server "
        + "is gone. The file name, type and size of each attachment survive in the note's frontmatter "
        + "(`stashpadAppAttachments`), but the images themselves cannot be recovered from the export — there "
        + "were no local copies to find.\n\n"
        + "**Comments and reactions.** A handful of notes carried collaboration comments. They are in the "
        + "export data but are not created as notes here.\n\n"
        + "**Sharing.** Which accounts a note was shared with is recorded in the export but not imported; it "
        + "describes a service that no longer runs.\n\n"
        + "**Notes in two places at once.** Stashpad let a note sit under more than one parent. A folder tree "
        + "cannot, so each such note was created once and its other parent is recorded as "
        + "`stashpadAppAlsoUnder` in frontmatter.\n\n"
        + "**Trash.** Notes deleted in Stashpad are in the export but are not imported unless you ask for them.",
    },
  ];
}
