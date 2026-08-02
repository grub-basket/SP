/** 0.192.0 — paste-text importer, ported from the standalone "Stashpad Importer"
 *  web app (which produced a `.stash` bundle you then imported). Doing it in the
 *  plugin removes the round-trip entirely: paste → preview → notes.
 *
 *  Deliberately free of Obsidian imports so the parsing is pure and unit-testable.
 *  The caller turns `ImportNote[]` into real notes.
 *
 *  Beyond the web app, this understands what the plugin grew since:
 *    - task checkboxes  `[ ] x` / `[x] y`, with an optional `- ` list marker
 *    - colour metadata  `[color: #ffe243 | alias: boogers]`
 *  Together those make Stashpad's own copy output (0.188.0:
 *  `- [x] [color: #ffe243 | alias: boogers] the text`) a lossless ROUND TRIP —
 *  copy notes out of one folder and paste them into another with tasks, colours and
 *  nesting intact. */

export interface ImportOptions {
  /** Leading tabs/spaces set nesting depth (2 spaces or 1 tab per level). */
  detectIndent: boolean;
  /** Treat `-`/`*`/`+`/`1.` as list markers: strip them and use them for nesting. */
  detectLists: boolean;
  /** ``` fenced blocks stay inside ONE note instead of splitting per line. */
  keepCodeBlocks: boolean;
  /** Paragraph mode: consecutive lines form ONE note and a blank line starts the
   *  next — the natural way to paste prose. Off = the default one-note-per-line.
   *
   *  (The web app instead had "blank lines stay in the note above", which only made
   *  sense there because it had a per-row merge button to pair with. Ported as-is it
   *  just left a stray trailing newline on the note above, so this replaces it.) */
  paragraphMode: boolean;
  /** Parse `[x]` task prefixes and `[color: …]` metadata (round-trip support). */
  parseMeta: boolean;
  /** 0.211.0: "Pasted from the old Stashpad desktop app".
   *
   *  That app exports a shape indentation alone cannot describe: the top-level
   *  parent gets NO marker and NO indent, its children get a marker but STILL no
   *  indent, and indentation only starts at the third level.
   *
   *      Parent 1
   *      - Child 1
   *       - Grandchild 1
   *
   *  By indent the first two lines are identical, so they import as siblings and
   *  the whole tree flattens by one. The marker is the only thing separating them,
   *  so under this option a list marker adds a level on top of the indent rank.
   *  OFF by default: in ordinary markdown a bare line followed by "- item" is a
   *  paragraph followed by a list at the SAME level, and treating that as nesting
   *  would be wrong for everyone else. */
  markerAddsLevel: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  detectIndent: true,
  detectLists: true,
  keepCodeBlocks: true,
  paragraphMode: false,
  parseMeta: true,
  markerAddsLevel: false,
};

export interface ImportNote {
  /** Final body. Carries a normalised `[x] `/`[ ] ` prefix when it's a task, so the
   *  caller can hand it straight to createNoteUnder, whose existing prefix parser
   *  turns it into task frontmatter. */
  body: string;
  /** 1-based depth AFTER normalisation (a jump can only ever go one deeper). */
  level: number;
  /** Index into the returned array of this note's parent, or null for top level. */
  parentIndex: number | null;
  /** `#rrggbb` when the line carried colour metadata. */
  color: string | null;
  /** Friendly name that came with the colour, to register as a folder colour alias. */
  colorAlias: string | null;
  /** A colour NAME we couldn't resolve to a hex (not a built-in). The caller tries
   *  the folder's own colour aliases before giving up. */
  colorName: string | null;
  /** Whether the line was a checkbox, and if so its state. */
  task: "none" | "open" | "done";
}

interface Row {
  /** Verbatim line — merged rows keep their original indentation. */
  raw: string;
  /** Line with indent/marker stripped; the note's first line. */
  text: string;
  level: number;
  /** Folded into the note above rather than starting its own. */
  merged: boolean;
}

/** Stashpad's 9 default palette colours and their human names — the same mapping the
 *  Stashpad Importer web app used (derived from the original app's palette), so
 *  `[color: Amber]` works without anyone defining an alias first. Lower-cased keys. */
export const BUILTIN_COLOR_NAMES: Record<string, string> = {
  red: "#e07a78", orange: "#e08a47", amber: "#e0a744", lime: "#b0cc6e", green: "#6bc07a",
  blue: "#5ba9ce", purple: "#9b82c9", pink: "#c57ab5", magenta: "#d75aa8",
  // Friendly synonyms people actually type.
  yellow: "#e0a744", gold: "#e0a744", teal: "#5ba9ce", cyan: "#5ba9ce",
  violet: "#9b82c9", grey: "#9b82c9", gray: "#9b82c9",
};

/** Leading list marker: `- `, `* `, `+ `, `1. `, `1) `. */
const LIST_MARKER = /^([-*+]|\d+[.)])\s+/;

/** Extract `[color: #hex | alias: name]` (alias optional) from the front of a line. */
function takeColorMeta(s: string): { rest: string; color: string | null; alias: string | null; name: string | null } {
  // Value is either a #hex or a human name ("Amber", or one of the folder's own
  // colour aliases). The "| alias: name" half is optional — text written by hand
  // (or pasted from the old Stashpad app, which carries no colours at all) will
  // usually just say [color: red].
  const m = s.match(/^\[color:\s*([^\]|]+?)\s*(?:\|\s*alias:\s*([^\]]*?)\s*)?\]\s*/i);
  if (!m) return { rest: s, color: null, alias: null, name: null };
  const rest = s.slice(m[0].length);
  const alias = (m[2] ?? "").trim() || null;
  const value = m[1].trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return { rest, color: value.toLowerCase(), alias, name: null };
  const builtin = BUILTIN_COLOR_NAMES[value.toLowerCase()];
  if (builtin) return { rest, color: builtin, alias: alias ?? value, name: null };
  // Unknown name — hand it back for the caller to resolve against this folder's
  // colour aliases (it can't be resolved here: parsing stays Obsidian-free).
  return { rest, color: null, alias, name: value };
}

/** Extract a `[ ]` / `[x]` checkbox from the front of a line. */
function takeCheckbox(s: string): { rest: string; task: "none" | "open" | "done" } {
  const m = s.match(/^\[([ xX]?)\]\s*/);
  if (!m) return { rest: s, task: "none" };
  return { rest: s.slice(m[0].length), task: /[xX]/.test(m[1]) ? "done" : "open" };
}

/** True when EVERY non-empty line is a checkbox item ("- [ ] x", "[x] y", …).
 *  That shape is unambiguously a task list, so the composer splits it into one task
 *  per line rather than making a single note with checkbox-looking text in it.
 *  Requires 2+ lines — a single "[ ] foo" is just one task and needs no splitting. */
export function isAllCheckboxLines(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  return lines.every((l) => /^\s*(?:[-*+]\s+)?\[[ xX]?\]\s*\S/.test(l));
}

/** Visual width of a line's leading whitespace, tabs expanded. Used only to
 *  COMPARE indents, so the exact tab size matters little — 4 matches every editor
 *  people paste from. */
function indentWidth(lead: string): number {
  return lead.replace(/\t/g, "    ").length;
}

/** Map the distinct indent widths present in the text to 1-based levels.
 *
 *  0.210.0: replaces `1 + tabs + Math.floor(spaces / 2)`, which hardcoded "two
 *  spaces per level" and therefore mis-read every document that indents by ONE.
 *  The old Stashpad desktop app exports exactly that shape:
 *
 *      Parent 1
 *       - Child 1
 *        - Grandchild 1
 *
 *  Widths 0/1/2 came out as levels 1/1/2, so the parent and its child collapsed
 *  into siblings and the grandchild became the child — silently wrong nesting on
 *  every import from the app this importer exists to migrate off.
 *
 *  Ordinal mapping instead: sort the distinct widths and use each one's rank. That
 *  reads 0/1/2 and 0/2/4 and 0/4/8 and tab-indented text identically, without
 *  guessing a unit. Inconsistent indentation degrades gracefully — an odd width
 *  becomes its own level rather than being rounded into a neighbour — and the
 *  caller still clamps a jump deeper than +1. */
function buildIndentLevels(widths: number[]): Map<number, number> {
  const distinct = [...new Set(widths)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  distinct.forEach((w, i) => out.set(w, i + 1));
  return out;
}

/** Split pasted text into notes: one per line, nested by indent / list depth,
 *  with fenced code, blank lines and metadata handled per `opts`. */
export function parseImport(text: string, opts: ImportOptions): ImportNote[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Trailing blanks are noise; interior ones may be meaningful body spacing.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

  // Pre-scan indents so levels can be assigned by RANK rather than by a fixed
  // spaces-per-level guess. Only lines that will actually become notes count:
  // blanks carry no indent, and fenced-code lines keep their own indentation
  // verbatim as body text, so letting either vote would invent phantom levels.
  const indentWidths: number[] = [];
  {
    let fence = false;
    for (const raw of lines) {
      const isFence = /^\s*```/.test(raw);
      if (opts.keepCodeBlocks && fence) { if (isFence) fence = false; continue; }
      if (opts.keepCodeBlocks && isFence) { fence = true; continue; }
      if (raw.trim() === "") continue;
      indentWidths.push(indentWidth((raw.match(/^([\t ]*)/) ?? ["", ""])[1]));
    }
  }
  const levelForWidth = buildIndentLevels(indentWidths);

  const rows: Row[] = [];
  let inFence = false;
  let haveNote = false;
  /** Paragraph mode: is a paragraph currently open (so the next line continues it)? */
  let paraOpen = false;

  for (const raw of lines) {
    const isFence = /^\s*```/.test(raw);

    // Inside a fence everything (including the closing fence) folds into one note.
    if (opts.keepCodeBlocks && inFence) {
      rows.push({ raw, text: raw, level: 1, merged: true });
      if (isFence) inFence = false;
      continue;
    }
    if (opts.keepCodeBlocks && isFence) {
      inFence = true;
      rows.push({ raw, text: raw, level: 1, merged: haveNote });
      haveNote = true;
      continue;
    }

    if (raw.trim() === "") {
      paraOpen = false; // a blank line closes the current paragraph
      continue;
    }

    // Indent → depth.
    let level = 1;
    let body = raw;
    const lead = (raw.match(/^([\t ]*)/) ?? ["", ""])[1];
    if (opts.detectIndent) {
      level = levelForWidth.get(indentWidth(lead)) ?? 1;
    }
    // Old-Stashpad shape: a marker means "one level deeper than a bare line at the
    // same indent". Computed BEFORE the marker is stripped below.
    if (opts.markerAddsLevel && LIST_MARKER.test(raw.slice(lead.length))) level += 1;
    body = raw.slice(lead.length);

    // List markers: strip so "- foo" imports as "foo", not "- foo".
    if (opts.detectLists) body = body.replace(LIST_MARKER, "");

    // Paragraph mode: continue the open paragraph instead of starting a new note.
    const continues = opts.paragraphMode && paraOpen && haveNote;
    rows.push({ raw, text: body, level, merged: continues });
    paraOpen = true;
    haveNote = true;
  }

  // Nothing to merge into if the very first row wanted to merge.
  if (rows.length && rows[0].merged) rows[0].merged = false;

  return assemble(rows, opts);
}

/** 0.212.1: re-derive level normalisation + `parentIndex` for a note list that was
 *  modified AFTER parsing — the importer's per-row nest / outdent / merge overrides.
 *
 *  `assemble` bakes `parentIndex` in at parse time and the import consumer
 *  (view.ts `createdIds[n.parentIndex]`) uses that field, NOT `level`. So anything
 *  that changes a level afterwards must re-link, or the note lands somewhere other
 *  than where the preview drew it. Same ancestor-by-level walk as `assemble`, kept
 *  next to it so the two cannot drift. */
export function relinkParents(notes: ImportNote[]): ImportNote[] {
  const out: ImportNote[] = [];
  const ancestors: Record<number, number> = {};
  let prevEff = 0;
  notes.forEach((n, idx) => {
    const eff = idx === 0 ? 1 : Math.min(Math.max(1, n.level), prevEff + 1);
    const parentIndex = eff === 1 ? null : (ancestors[eff - 1] ?? null);
    out.push({ ...n, level: eff, parentIndex });
    ancestors[eff] = out.length - 1;
    for (const k of Object.keys(ancestors)) if (Number(k) > eff) delete ancestors[Number(k)];
    prevEff = eff;
  });
  return out;
}

/** Fold merged rows into their preceding note, normalise depth, resolve parents. */
function assemble(rows: Row[], opts: ImportOptions): ImportNote[] {
  interface Draft { rawLevel: number; bodyLines: string[] }
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  rows.forEach((r, i) => {
    if (i === 0 || !r.merged) {
      cur = { rawLevel: Math.max(1, r.level), bodyLines: [r.text] };
      drafts.push(cur);
    } else if (cur) {
      // Verbatim, so code and nested lists keep their own indentation.
      cur.bodyLines.push(r.raw);
    }
  });

  const out: ImportNote[] = [];
  /** effective level → index of the most recent note at that level. */
  const ancestors: Record<number, number> = {};
  let prevEff = 0;

  drafts.forEach((d, idx) => {
    // A jump deeper than +1 is almost always inconsistent indentation, not intent.
    const eff = idx === 0 ? 1 : Math.min(Math.max(1, d.rawLevel), prevEff + 1);

    let first = d.bodyLines[0] ?? "";
    let color: string | null = null;
    let alias: string | null = null;
    let colorName: string | null = null;
    let task: "none" | "open" | "done" = "none";

    if (opts.parseMeta) {
      // Order matters and mirrors what copy emits: [marker] [checkbox] [colour] text.
      // The marker is already stripped when detectLists is on; strip it here too so
      // metadata still parses when list detection is off.
      first = first.replace(LIST_MARKER, "");
      ({ rest: first, task } = takeCheckbox(first));
      ({ rest: first, color, alias, name: colorName } = takeColorMeta(first));
      // Tolerate the reverse order ([colour] before [checkbox]) too.
      if (task === "none") ({ rest: first, task } = takeCheckbox(first));
    }

    // Re-attach a NORMALISED checkbox so createNoteUnder's existing prefix parser
    // (which requires "[x] " with no list marker) turns it into task frontmatter.
    const head = task === "none" ? first : `${task === "done" ? "[x]" : "[ ]"} ${first}`;
    // Trailing blank lines are never meaningful in a note body; interior ones (code
    // fences, paragraph mode) are preserved.
    const body = [head, ...d.bodyLines.slice(1)].join("\n").replace(/\s+$/, "");

    const parentIndex = eff === 1 ? null : (ancestors[eff - 1] ?? null);
    out.push({ body, level: eff, parentIndex, color, colorAlias: alias, colorName, task });

    ancestors[eff] = out.length - 1;
    for (const k of Object.keys(ancestors)) if (Number(k) > eff) delete ancestors[Number(k)];
    prevEff = eff;
  });

  // A task with an empty body would create a note titled "[x]" — drop those.
  return out.filter((n) => n.body.trim() && n.body.trim() !== "[x]" && n.body.trim() !== "[ ]");
}
