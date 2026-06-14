import { App, FuzzySuggestModal, Platform, Scope, SuggestModal, TFile, moment, setIcon } from "obsidian";
import type { TreeIndex } from "./tree-index";
import type { TreeNode } from "./types";
import { ROOT_ID } from "./types";
import { buildTimePickerInto, formatWhenTime } from "./time-picker";
// Obsidian types `moment` as the namespace (not callable); a callable view for
// the call sites. Type usage like `moment.unitOfTime` keeps using `moment`.
const momentFn = moment as unknown as (...args: unknown[]) => moment.Moment;

/** Parsed shape of a search query string. The original free-text tokens
 *  go into `text` (token-order-agnostic match against title/body); each
 *  `filter:value` pair gets extracted into `filters`. 0.64.0. */
interface ParsedQuery {
  text: string[]; // already lowercased
  filters: {
    in?: string;       // folder name token to match against
    before?: number;   // epoch ms — exclusive upper bound on created date
    after?: number;    // epoch ms — exclusive lower bound on created date
    on?: { start: number; end: number }; // same-day window
  };
}


/** Parse a date/timeframe string into epoch ms.
 *  Supports:
 *    - "today", "yesterday", "tomorrow"
 *    - ISO-like dates ("2025-01-15", "2025/01/15", "01-15-2025")
 *    - relative durations: "1d", "7d", "2w", "1m", "1y" (N units ago)
 *    - day names: "monday", "tue", "wed", … (most recent past occurrence)
 *    - 0.64.8: optional time-of-day suffix: "today 10am", "yesterday
 *      3:30pm", "mon 09:00", "2025-01-15 14:30". When omitted the
 *      value resolves to midnight (start of day).
 *  Returns null when the string can't be parsed. */
function parseDateToken(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  const now = Date.now();
  const startOfDay = (ts: number): number => momentFn(ts).startOf("day").valueOf();
  // Try to extract a time-of-day component first so it doesn't confuse
  // the date keyword/ISO parsers below. Matches "10am", "10:30am",
  // "14:00", "9pm" etc.
  const timeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/;
  let timeOffsetMs = 0;
  let timeMatched = false;
  let dateStr = t;
  const tm = timeRe.exec(t);
  // Only treat as a time component when it's actually shaped like one
  // — i.e. has am/pm OR has a colon (otherwise standalone digits like
  // "2025" would falsely match).
  if (tm && (tm[3] || tm[2])) {
    let hours = parseInt(tm[1], 10);
    const mins = tm[2] ? parseInt(tm[2], 10) : 0;
    const ampm = tm[3];
    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    if (hours >= 0 && hours < 24 && mins >= 0 && mins < 60) {
      timeOffsetMs = (hours * 3600 + mins * 60) * 1000;
      timeMatched = true;
      dateStr = t.replace(tm[0], " ").replace(/\s+/g, " ").trim();
    }
  }

  const applyTime = (dayMidnight: number) => timeMatched ? dayMidnight + timeOffsetMs : dayMidnight;

  // Keywords (date part only — empty dateStr means "today" implicit).
  if (dateStr === "" || dateStr === "today") return applyTime(startOfDay(now));
  if (dateStr === "yesterday") return applyTime(startOfDay(now) - 86_400_000);
  if (dateStr === "tomorrow") return applyTime(startOfDay(now) + 86_400_000);
  // Day names (Sun-Sat) — return the most recent past occurrence (or
  // today if today matches).
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const shortDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const dayIdx = dayNames.indexOf(dateStr) >= 0 ? dayNames.indexOf(dateStr) : shortDays.indexOf(dateStr);
  if (dayIdx >= 0) {
    const today = momentFn().startOf("day");
    const todayIdx = today.day();
    const back = (todayIdx - dayIdx + 7) % 7;
    return applyTime(today.subtract(back, "days").valueOf());
  }
  // Relative duration: <N><unit> e.g. 7d, 2w, 1m, 1y.
  const rel = /^(\d+)\s*([dwmy])$/.exec(dateStr);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = { d: "days", w: "weeks", m: "months", y: "years" }[rel[2]] as moment.unitOfTime.DurationConstructor;
    return applyTime(momentFn().subtract(n, unit).startOf("day").valueOf());
  }
  // ISO-like date attempt via moment.
  const m = momentFn(dateStr, ["YYYY-MM-DD", "YYYY/MM/DD", "MM-DD-YYYY", "MM/DD/YYYY", "M-D-YYYY", "M/D/YYYY"], true);
  if (m.isValid()) return applyTime(m.startOf("day").valueOf());
  return null;
}

export function parseSearchQuery(query: string): ParsedQuery {
  const out: ParsedQuery = { text: [], filters: {} };
  const raw = (query || "").trim();
  if (!raw) return out;
  // 0.64.5: filter values can be wrapped in square brackets to make
  // their boundary unambiguous. `in: [copy stashpad features] blue`
  // cleanly separates the multi-word folder name from the free-text
  // term "blue". Brackets win when present; otherwise we fall back
  // to the greedy multi-word match (value extends to the next filter
  // prefix or end of string).
  //
  // Patterns:
  //   bracketed:  key: [value with spaces]
  //   greedy:     key: value (multi-word; stops at next key: or $)
  const filterRe = /\b(in|before|after|on):\s*(?:\[([^\]]*)\]|([^]*?)(?=\s+(?:in|before|after|on):|$))/gi;
  let remaining = raw;
  let m: RegExpExecArray | null;
  while ((m = filterRe.exec(raw)) != null) {
    const key = m[1].toLowerCase();
    // m[2] = bracketed value; m[3] = greedy value. Prefer brackets when
    // present (allows empty `[]` as a "no value" placeholder).
    const value = (m[2] !== undefined ? m[2] : m[3] ?? "").trim();
    if (!value) continue;
    if (key === "in") {
      out.filters.in = value.toLowerCase();
    } else if (key === "before") {
      const ts = parseDateToken(value);
      if (ts != null) out.filters.before = ts;
    } else if (key === "after") {
      const ts = parseDateToken(value);
      if (ts != null) out.filters.after = ts;
    } else if (key === "on") {
      const ts = parseDateToken(value);
      if (ts != null) {
        // 0.69.45: if the value includes a time-of-day component (e.g.
        // "on: 9:45pm", "on: 2025-01-15 14:30"), narrow the window to
        // ±60 seconds around that exact moment. Without a time, fall
        // back to the full-day window. Previously any time-of-day was
        // dropped and the filter degenerated to the whole day, which
        // is why "on: 9:45pm" returned every note from today.
        const hasTime = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i.test(value);
        if (hasTime) {
          out.filters.on = { start: ts - 60_000, end: ts + 60_000 };
        } else {
          const start = momentFn(ts).startOf("day").valueOf();
          out.filters.on = { start, end: start + 86_400_000 };
        }
      }
    }
    // Remove the matched filter slice from remaining so it doesn't
    // double-count as free text.
    remaining = remaining.replace(m[0], " ");
  }
  for (const tok of remaining.split(/\s+/)) {
    if (tok) out.text.push(tok.toLowerCase());
  }
  return out;
}

export interface PickerItem {
  id: string;
  label: string;
  node: TreeNode | null;
  /** Item kinds:
   *  - "note": ordinary local-or-cross-folder note pick.
   *  - "create": "Create new: <query>" virtual pick.
   *  - "folder-open": pick a Stashpad folder — caller opens it in a new
   *    tab. Carries `folder` but no node. 0.57.3.
   *  - "search-excluded": bottom-of-list action that pulls notes from
   *    Stashpad folders excluded from search into the result set. 0.92.1. */
  kind: "note" | "create" | "folder-open" | "search-excluded";
  bodyPreview?: string; // for search mode
  matchLine?: number;
  /** For cross-folder results: the source folder + raw TFile so the
   *  caller can switch view + focus appropriately. Empty/undefined for
   *  local (current-tree) results. */
  crossFolder?: string;
  crossFile?: TFile;
  /** Raw note id of a cross-folder result (e.g. ROOT_ID for a home note). The
   *  `id` field is folder-qualified (`cross:<folder>:<rawId>`) so home notes from
   *  different folders — which all share ROOT_ID — don't collide; lookups that
   *  need the underlying note id use this instead of parsing `id`. */
  crossId?: string;
  /** For "folder-open" items: the folder path to open in a new tab. */
  folder?: string;
}

/** A cross-folder note loaded from another Stashpad. Shaped to plug into
 *  the same render/filter machinery as in-tree notes without inventing a
 *  full synthetic TreeNode. */
export interface CrossFolderNote {
  /** Optional — synthetic root entries (one per external Stashpad folder)
   *  carry no underlying TFile. The picker treats them as "Home of that
   *  folder" pick targets. 0.57.2. */
  file?: TFile;
  folder: string;
  /** Note's id from frontmatter (or ROOT_ID for synthetic roots). */
  id: string;
  /** Rendered title/label (basename minus the trailing -id, with dashes
   *  → spaces). */
  title: string;
  /** Pre-loaded body text (the picker will lazy-read if blank). */
  body: string;
  /** Pre-loaded parent body's first line, prefixed with "Parent: " by
   *  the renderer. Optional. */
  parentBlurb?: string;
  /** 0.69.1: parent id (from the file's frontmatter `parent`). Lets the
   *  picker walk subtrees across folders for `in:` filtering. Null when
   *  the note is at root or the parent is missing. */
  parentId?: string | null;
}

interface NoteBody {
  node: TreeNode | null;
  title: string;
  body: string;
  /** When set, this entry is from another Stashpad. */
  cross?: CrossFolderNote;
}

export class StashpadSuggest extends SuggestModal<PickerItem> {
  private notes: NoteBody[] = [];
  /** 0.92.1: true once the user has opted into searching excluded folders
   *  (their notes have been merged into `this.notes`). */
  private includeExcluded = false;
  /** 0.69.33: Modal does NOT extend Component — it only `implements
   *  CloseableComponent`. So `this.register(...)` (the Component
   *  cleanup API I was using in 0.69.29+) doesn't exist and threw
   *  TypeError every time openInsertPopover ran, killing the rest of
   *  popover setup. We track cleanup callbacks ourselves and fire
   *  them in our onClose override. */
  private pendingCleanups: Array<() => void> = [];
  onClose(): void {
    while (this.pendingCleanups.length > 0) {
      const cb = this.pendingCleanups.pop();
      try { if (cb) cb(); } catch {}
    }
    // 0.85.10: notify the caller the picker closed (pick OR dismiss). The
    // destination picker uses this to refocus the composer only on dismiss.
    try { this.opts.onClose?.(); } catch {}
  }

  constructor(
    app: App,
    private tree: TreeIndex,
    private titleFn: (n: TreeNode) => string,
    private opts: {
      mode: "pick" | "search";
      placeholder?: string;
      allowCreate?: boolean;
      onPick: (item: PickerItem) => void;
      onCreate?: (query: string) => void;
      /** 0.85.10: fired from onClose (any close — pick or dismiss). The
       *  destination picker uses it to refocus the composer on dismiss. */
      onClose?: () => void;
      /** Optional source for cross-folder notes. Resolved lazily when
       *  the user starts typing — local results from `tree` are returned
       *  first, and this source is queried only after the local set is
       *  exhausted (or to fill out short result lists). */
      crossFolderNotes?: () => CrossFolderNote[];
      /** 0.92.1: source of notes from Stashpad folders EXCLUDED from search.
       *  When provided (i.e. there ARE excluded folders), a "Search excluded
       *  folders" action appears at the very bottom of the list; activating it
       *  merges these into the result set on demand — so you can move notes
       *  into/out of excluded folders without un-excluding them. */
      excludedFolderNotes?: () => CrossFolderNote[];
      /** Optional source of Stashpad folder paths. When provided, folders
       *  whose name matches the query show up as their own "open this
       *  folder in a new tab" pick. Used by the search modal. 0.57.3. */
      folderResults?: () => string[];
      /** When true, render a row of clickable filter chips below the
       *  search input. Clicking a chip inserts the filter prefix into
       *  the query at the cursor. 0.64.0. */
      showFilterChips?: boolean;
      /** 0.69.3: the active Stashpad folder of the calling view, used
       *  to render the folder badge on LOCAL suggestion rows (parity
       *  with how cross-folder rows show their source folder). */
      localFolder?: string;
    },
  ) {
    super(app);
    this.setPlaceholder(opts.placeholder ?? (opts.mode === "search" ? "Search notes…" : "Pick a note…"));
    this.loadAll();
  }

  private loadAll(): void {
    const rootNode = this.tree.getRoot();
    // 0.85.15: label the LOCAL home like the cross-folder entries
    // ("Home — <folder>") so searching a folder by name surfaces its home note
    // whether you're inside that folder or not — consistent everywhere, and it
    // becomes matchable by the folder name (so the home-pin floats it to top).
    const folderName = rootNode.file?.parent?.name?.trim() ?? "";
    const localHomeTitle = folderName ? `Home — ${folderName}` : "Home";
    const walk = (id: string, depth: number): void => {
      const node = this.tree.get(id);
      if (node?.file && id !== ROOT_ID) {
        this.notes.push({ node, title: `${"  ".repeat(depth)}${this.titleFn(node)}`, body: "" });
      } else if (node?.file && id === ROOT_ID) {
        this.notes.push({ node, title: localHomeTitle, body: "" });
      }
      for (const c of this.tree.getChildren(id)) walk(c.id, depth + 1);
    };
    if (rootNode.file) this.notes.push({ node: rootNode, title: localHomeTitle, body: "" });
    for (const c of this.tree.getChildren(ROOT_ID)) walk(c.id, 1);

    // lazy-read bodies in background
    for (const n of this.notes) {
      if (!n.node?.file) continue;
      this.app.vault.cachedRead(n.node.file).then((md) => { n.body = this.stripFm(md); });
    }

    // Cross-folder notes (loaded once on first request, then cached on
    // this.notes alongside local entries — kept distinguished by the
    // .cross marker for tier ordering and rendering).
    if (this.opts.crossFolderNotes) {
      const cross = this.opts.crossFolderNotes();
      for (const c of cross) {
        this.notes.push({ node: null, title: c.title, body: c.body, cross: c });
      }
      for (const n of this.notes) {
        if (!n.cross || n.body) continue;
        // Skip the synthetic-root entries (no TFile to read).
        if (!n.cross.file) continue;
        this.app.vault.cachedRead(n.cross.file).then((md) => { n.body = this.stripFm(md); });
      }
    }
  }

  /** Best-effort `created` epoch ms for filter matching. Local notes use
   *  `node.created` (ISO string from frontmatter). Cross-folder notes
   *  fall back to the TFile's ctime if available. 0.64.0. */
  private createdMsFor(n: NoteBody): number | null {
    if (n.node?.created) {
      const ms = Date.parse(n.node.created);
      if (!Number.isNaN(ms)) return ms;
    }
    if (n.cross?.file?.stat?.ctime != null) return n.cross.file.stat.ctime;
    return null;
  }

  private stripFm(md: string): string {
    if (!md.startsWith("---")) return md;
    const end = md.indexOf("\n---", 3);
    return end === -1 ? md : md.slice(end + 4).replace(/^\r?\n/, "");
  }

  getSuggestions(query: string): PickerItem[] {
    const q = query.trim().toLowerCase();
    // 0.64.0: parse out advanced filter syntax (in:/before:/after:/on:)
    // before we run the token match. Remaining free-text tokens still
    // run token-order-agnostic match against title/body.
    const parsed = parseSearchQuery(query);
    const tokens = parsed.text;
    // 0.64.2 diagnostic — use console.log (not debug) so it shows
    // at the default DevTools log level. Always fires while we're
    // debugging the filter pipeline.
    console.log("[Stashpad] search query parsed", {
      query, text: parsed.text, filters: parsed.filters,
    });
    const matchesAll = (haystack: string): boolean => {
      if (!tokens.length) return true;
      for (const t of tokens) if (!haystack.includes(t)) return false;
      return true;
    };
    // Filter helper: return true if a NoteBody passes the structured
    // filter set (in:/before:/after:/on:). Local notes use the active
    // folder + node.created; cross-folder notes use cross.folder + the
    // file's stat ctime (frontmatter created may not be loaded yet).
    // 0.64.6: `in:` now means "inside the subtree of a note matching
    // this title" (not "in a folder named this"). The user's mental
    // model: `in: [Project Rocket]` → every descendant of any note
    // whose title contains "Project Rocket". Folder-level filtering
    // doesn't make sense as a search filter — the user already chooses
    // which folder is active when they open the picker.
    // Local subtree set (active tree) + per-folder cross subtree sets.
    // 0.69.1: `in:` now spans every searchable Stashpad folder, not
    // just the active one, mirroring how when:/before:/after:/on: work.
    let inDescendantIds: Set<string> | null = null;
    let inCrossIds: Map<string, Set<string>> | null = null;
    if (parsed.filters.in) {
      const inTokens = parsed.filters.in.split(/\s+/).filter(Boolean);
      inDescendantIds = new Set<string>();
      inCrossIds = new Map();
      const titleMatches = (title: string): boolean =>
        inTokens.every((t) => title.toLowerCase().includes(t));
      const walkLocal = (nodeId: string): void => {
        if (inDescendantIds!.has(nodeId)) return;
        inDescendantIds!.add(nodeId);
        for (const c of this.tree.getChildren(nodeId)) walkLocal(c.id);
      };
      for (const n of this.notes) {
        if (!n.node || n.cross) continue;
        if (titleMatches(n.title)) walkLocal(n.node.id);
      }
      // Cross-folder: group notes by folder and build a parent→children
      // index per folder, then walk from every title-matching note.
      const crossByFolder = new Map<string, typeof this.notes>();
      for (const n of this.notes) {
        if (!n.cross) continue;
        const bucket = crossByFolder.get(n.cross.folder) ?? [];
        bucket.push(n);
        crossByFolder.set(n.cross.folder, bucket);
      }
      for (const [folder, group] of crossByFolder) {
        const childrenByParent = new Map<string, string[]>();
        for (const n of group) {
          const pid = n.cross?.parentId ?? null;
          if (!pid) continue;
          const list = childrenByParent.get(pid) ?? [];
          list.push(n.cross!.id);
          childrenByParent.set(pid, list);
        }
        const folderSet = new Set<string>();
        inCrossIds.set(folder, folderSet);
        const walkCross = (id: string): void => {
          if (folderSet.has(id)) return;
          folderSet.add(id);
          for (const c of childrenByParent.get(id) ?? []) walkCross(c);
        };
        for (const n of group) {
          if (titleMatches(n.title)) walkCross(n.cross!.id);
        }
      }
    }
    const passesFilters = (n: NoteBody): boolean => {
      const f = parsed.filters;
      if (inDescendantIds || inCrossIds) {
        if (n.cross) {
          const set = inCrossIds?.get(n.cross.folder);
          if (!set || !set.has(n.cross.id)) return false;
        } else if (n.node) {
          if (!inDescendantIds || !inDescendantIds.has(n.node.id)) return false;
        } else {
          return false;
        }
      }
      if (f.before || f.after || f.on) {
        const createdMs = this.createdMsFor(n);
        if (createdMs == null) return false;
        if (f.before != null && createdMs >= f.before) return false;
        if (f.after != null && createdMs <= f.after) return false;
        if (f.on && (createdMs < f.on.start || createdMs >= f.on.end)) return false;
      }
      return true;
    };
    // For search mode's per-line matchLine: a line is a match when it
    // contains EVERY token (token-order-agnostic on a single line).
    const lineMatchesAll = (line: string): boolean => matchesAll(line.toLowerCase());

    // Tier the candidates: local first (notes from the active tree),
    // then cross-folder (notes from other Stashpads). The user wanted
    // cross-folder results to appear AFTER the local ones rather than
    // intermingled, and only "kick in" once the local tier has been
    // exhausted (or shown as available).
    const local = this.notes.filter((n) => !n.cross);
    const cross = this.notes.filter((n) => n.cross);

    const buildItem = (n: NoteBody, matchLine: number): PickerItem => ({
      // Folder-qualify cross-folder ids: home notes all share ROOT_ID, so a bare
      // `cross:${id}` collided across folders (one home borrowed another's body/
      // title). The raw id rides along in `crossId` for lookups.
      id: n.cross ? `cross:${n.cross.folder}:${n.cross.id}` : n.node!.id,
      label: n.title,
      node: n.node,
      kind: "note",
      bodyPreview: this.previewFromBody(n.body, matchLine),
      matchLine,
      crossFolder: n.cross?.folder,
      crossFile: n.cross?.file,
      crossId: n.cross?.id,
    });

    const matchTier = (tier: NoteBody[]): PickerItem[] => {
      const out: PickerItem[] = [];
      for (const n of tier) {
        // 0.64.0: structured filters always apply, even when there's no
        // free text — `in:work` alone should narrow to that folder.
        if (!passesFilters(n)) continue;
        if (this.opts.mode === "search") {
          if (!q) { out.push(buildItem(n, -1)); continue; }
          const titleHit = matchesAll(n.title.toLowerCase());
          const lines = n.body.split(/\r?\n/);
          // 0.69.12: collect ALL per-line matches, then cluster nearby
          // matches together (within 5 lines) and emit one PickerItem
          // per cluster — so a long note with multiple distinct
          // matches surfaces each as its own result with surrounding
          // context. Capped at 5 cluster rows per note to avoid spam.
          const matchLines: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (lineMatchesAll(lines[i])) matchLines.push(i);
          }
          const bodyHit = matchLines.length > 0 || matchesAll(n.body.toLowerCase());
          if (!titleHit && !bodyHit) continue;
          if (matchLines.length === 0) {
            // Title-only / body-anywhere hit — no per-line preview.
            out.push(buildItem(n, -1));
          } else {
            const clusterHeads: number[] = [];
            let last = -100;
            for (const ln of matchLines) {
              if (ln - last > 5) clusterHeads.push(ln);
              last = ln;
            }
            const CAP = 5;
            for (const ml of clusterHeads.slice(0, CAP)) out.push(buildItem(n, ml));
          }
        } else {
          // pick mode — tokens must all appear in title OR body.
          if (q && !matchesAll(n.title.toLowerCase()) && !matchesAll(n.body.toLowerCase())) continue;
          out.push(buildItem(n, -1));
        }
      }
      return out;
    };

    const localItems = matchTier(local);
    const items: PickerItem[] = [...localItems];
    // Only consult the cross-folder tier when local results are sparse
    // OR when the user is in search mode with a real query (so they can
    // discover cross-folder hits). Pick mode without a query keeps the
    // list local for performance.
    // 0.57.2: loosened pick-mode rule — cross-folder results always
    // appear when the user has typed a query (was gated to
    // localItems.length < 30, which hid them in mid-sized vaults where
    // many local notes happened to match). Empty-query pick mode stays
    // local-only for performance.
    const crossWanted = this.opts.mode === "search"
      ? (q ? true : localItems.length < 10)
      : (q ? true : false);
    if (crossWanted) {
      const crossItems = matchTier(cross);
      // Cap the local tier so the user sees the cross-folder section
      // come up without scrolling through hundreds of local hits.
      if (this.opts.mode === "search" && !q) items.length = Math.min(items.length, 50);
      items.push(...crossItems);
    }

    // 0.57.3: folder-open results — prepended to the list so they're easy
    // to spot when a query matches a folder name. 0.69.3: the previous
    // per-folder row set collapses to ONE entry "Open folder in a new
    // tab…" — picking it opens a sub-picker listing every Stashpad
    // folder (with its own fuzzy-search) so the main result list isn't
    // crowded by N folder rows on a vault with many Stashpads.
    if (this.opts.folderResults) {
      const folders = this.opts.folderResults();
      const collapsed: PickerItem = {
        id: `__folder_picker__`,
        label: `Open folder in a new tab…`,
        node: null,
        kind: "folder-open",
      };
      // 0.85.14: empty query → show it at the TOP (folder browsing). Once
      // typing, only show it when the query matches a folder name, and place it
      // at the BOTTOM so it's never the first result — real note hits lead, and
      // the matching folder's home note still pins to the top (0.85.12).
      if (folders.length > 0) {
        if (!q) {
          items.unshift(collapsed);
        } else if (folders.some((folder) => {
          const last = folder.split("/").pop() ?? folder;
          return matchesAll(`${folder.toLowerCase()} ${last.toLowerCase()}`);
        })) {
          items.push(collapsed);
        }
      }
    }

    if (this.opts.allowCreate && q && !items.some((i) => i.label.trim().toLowerCase() === q)) {
      items.push({ id: `__create__`, label: `Create new: "${query}"`, node: null, kind: "create" });
    }

    // 0.85.12: searching a Stashpad folder by name means you want its HOME
    // note. Home notes are otherwise low-priority, but once there are ≥3
    // characters of search text, any home note whose TITLE matches the query
    // (local home label "Home", or a cross-folder "Home — <folder>" whose
    // folder name you've typed) is floated to the very top — "no matter what".
    // Title-match (not body) keeps it to genuine folder-name hits, and the ≥3
    // gate keeps short/empty queries from surfacing every home. Backs every
    // modal that uses this picker — find / destination / move / in-parent.
    if (parsed.text.join("").length >= 3) {
      const isHomeMatch = (i: PickerItem): boolean =>
        i.kind === "note"
        && (i.id === ROOT_ID || i.crossId === ROOT_ID)
        && matchesAll(i.label.toLowerCase());
      const homes = items.filter(isHomeMatch);
      if (homes.length > 0) {
        const rest = items.filter((i) => !isHomeMatch(i));
        items.splice(0, items.length, ...homes, ...rest);
      }
    }

    // 0.92.1: bottom-of-list escape hatch — when there ARE excluded Stashpad
    // folders and we haven't pulled them in yet, offer to search them. Appended
    // LAST (after the home-pin reorder) so it always sits beneath the create
    // row / all results, exactly where "there are no more results" lands.
    if (this.opts.excludedFolderNotes && !this.includeExcluded) {
      items.push({
        id: `__search_excluded__`,
        label: "Search excluded Stashpad folders",
        node: null,
        kind: "search-excluded",
      });
    }
    return items;
  }

  /** 0.92.1: merge notes from excluded folders into the result set (once), then
   *  re-run the current query so they appear. Bodies fill in lazily; titles
   *  match immediately. */
  private loadExcludedNotes(): void {
    if (this.includeExcluded || !this.opts.excludedFolderNotes) return;
    this.includeExcluded = true;
    for (const c of this.opts.excludedFolderNotes()) {
      this.notes.push({ node: null, title: c.title, body: c.body, cross: c });
    }
    for (const n of this.notes) {
      if (!n.cross || n.body || !n.cross.file) continue;
      this.app.vault.cachedRead(n.cross.file).then((md) => { n.body = this.stripFm(md); });
    }
    const ie = (this as any).inputEl as HTMLInputElement | undefined;
    if (ie) {
      ie.dispatchEvent(new Event("input", { bubbles: true }));
      // Bodies arrive async; re-run shortly so body matches surface too.
      setTimeout(() => ie.dispatchEvent(new Event("input", { bubbles: true })), 250);
    }
  }

  private previewFromBody(body: string, matchLine: number): string {
    // 0.69.19: index against the UNFILTERED line array — matchLine in
    // PickerItems comes from matchTier's unfiltered split, so filtering
    // empty lines here desynced the index (preview was anchored to the
    // wrong place / "first line" for cluster items past any blank line).
    // Drop empties only AFTER slicing the window, and widen the context
    // from ±1 line to ±2 lines (5 lines total) for better readability.
    const rawLines = body.split(/\r?\n/);
    if (matchLine < 0) {
      const head = rawLines.filter((l) => l.trim().length > 0).slice(0, 3);
      return head.join("\n");
    }
    const start = Math.max(0, matchLine - 2);
    const end = Math.min(rawLines.length, matchLine + 3);
    return rawLines
      .slice(start, end)
      .filter((l) => l.trim().length > 0)
      .join("\n");
  }

  renderSuggestion(item: PickerItem, el: HTMLElement): void {
    el.addClass("stashpad-suggest-item");
    if (item.kind === "create") {
      el.createDiv({ cls: "stashpad-suggest-create", text: item.label });
      return;
    }
    if (item.kind === "folder-open") {
      el.addClass("is-folder-open");
      el.createDiv({ cls: "stashpad-suggest-title", text: item.label });
      if (item.folder) el.createDiv({ cls: "stashpad-suggest-preview", text: item.folder });
      else el.createDiv({ cls: "stashpad-suggest-preview", text: "Click to choose a folder…" });
      return;
    }
    if (item.kind === "search-excluded") {
      el.addClass("is-search-excluded");
      const row = el.createDiv({ cls: "stashpad-suggest-title stashpad-search-excluded-row" });
      const icon = row.createSpan({ cls: "stashpad-search-excluded-icon" });
      setIcon(icon, "folder-search");
      row.createSpan({ text: item.label });
      el.createDiv({ cls: "stashpad-suggest-preview", text: "Include folders you've excluded from search (e.g. to move a note there)." });
      return;
    }
    if (item.crossFolder) el.addClass("is-cross-folder");
    // 0.64.1: row layout becomes a flex column with the body on the left
    // and a right-rail for the creation timestamp. Wrap existing content
    // in a body div so the timestamp can sit to its right.
    el.addClass("stashpad-suggest-row");
    const body = el.createDiv({ cls: "stashpad-suggest-body" });

    // Locate the underlying NoteBody so we can render body + parent body.
    const note = this.notes.find((n) => {
      // Match folder AND id — home notes across folders all share ROOT_ID, so id
      // alone would resolve every cross-folder home to the first one (the
      // "Beta home shows Alpha's title/body" bug).
      if (item.crossFolder) return n.cross?.folder === item.crossFolder && n.cross?.id === item.crossId;
      return n.node?.id === item.id;
    });
    // 0.69.3: re-parse the current input each render so we know which
    // free-text tokens to highlight (filter prefixes excluded).
    const tokens = parseSearchQuery((this as any).inputEl?.value ?? "").text;
    // Top line: body's first non-empty line (or fallback to the label).
    const bodyTop = this.firstLineOfBody(note?.body ?? "") || item.label.trim();
    const top = body.createDiv({ cls: "stashpad-suggest-title" });
    this.highlightInto(top, bodyTop, tokens);
    // 0.69.5: folder badge moves OFF the title row and onto the right
    // rail (under the timestamp). The badge logic is the same — local
    // rows use the active folder, cross-folder rows use their source.
    const badgeFolder = item.crossFolder ?? this.opts.localFolder ?? null;
    // 0.69.28: render the per-cluster body preview snippet. Multi-match
    // cluster items each carry their own `bodyPreview` (the ±2-line
    // window around their matchLine) — previously this was computed
    // but never displayed, so every cluster row visually anchored to
    // the note's first line. Now each cluster shows its own context.
    if (item.bodyPreview && item.matchLine != null && item.matchLine >= 0) {
      const snippet = body.createDiv({ cls: "stashpad-suggest-preview stashpad-suggest-snippet" });
      this.highlightInto(snippet, item.bodyPreview, tokens);
    }
    // Bottom line: parent body. For local results, walk the tree. For
    // cross-folder results, the loader pre-supplies parentBlurb.
    let parentBlurb = "";
    if (item.crossFolder) parentBlurb = note?.cross?.parentBlurb ?? "";
    else parentBlurb = this.parentBlurbFor(item.node);
    if (parentBlurb) {
      const prev = body.createDiv({ cls: "stashpad-suggest-preview" });
      prev.appendText("Parent: ");
      this.highlightInto(prev, parentBlurb, tokens);
    }
    // 0.69.3: full breadcrumb path under the parent blurb. Walks ancestors
    // up to (but excluding) root, prefixed by the folder name so the
    // user can see where in the vault the note lives. Local results
    // walk the tree; cross-folder results walk the per-folder cross map.
    const crumbs = item.crossFolder
      ? this.buildCrossBreadcrumb(item)
      : this.buildLocalBreadcrumb(item.node);
    const folderForCrumbs = item.crossFolder ?? this.opts.localFolder ?? null;
    if (folderForCrumbs || crumbs) {
      const path = body.createDiv({ cls: "stashpad-suggest-breadcrumb" });
      const folderLeaf = folderForCrumbs
        ? (folderForCrumbs.split("/").pop() || folderForCrumbs)
        : "";
      const fullPath = [folderLeaf, crumbs].filter((s) => s && s.length > 0).join(" › ");
      if (fullPath) path.setText(fullPath);
    }
    // 0.64.1 / 0.69.5: right rail stacks creation timestamp + folder
    // badge in a column. Timestamp falls back gracefully when the body
    // hasn't loaded yet; folder badge always shows when known.
    const ms = note ? this.createdMsFor(note) : null;
    if (ms != null || badgeFolder) {
      const rail = el.createDiv({ cls: "stashpad-suggest-rail" });
      if (ms != null) {
        const tEl = rail.createDiv({ cls: "stashpad-suggest-time" });
        tEl.setText(this.formatRelativeTime(ms));
        tEl.title = momentFn(ms).format("YYYY-MM-DD HH:mm");
      }
      if (badgeFolder) {
        rail.createDiv({
          cls: "stashpad-suggest-folder-badge",
          text: badgeFolder.split("/").pop() || badgeFolder,
        });
      }
    }
  }

  /** Compact relative time formatter for the search result rail.
   *  0.64.9: moment's `startOf()` mutates in place, so the previous
   *  implementation called `m.startOf("day")` for the days-diff and
   *  then formatted the now-midnight m as h:mm a → every same-day
   *  result rendered as "12:00 am". Use a fresh moment for the diff. */
  private formatRelativeTime(ms: number): string {
    const m = momentFn(ms);
    const days = momentFn().startOf("day").diff(momentFn(ms).startOf("day"), "days");
    if (days === 0) return m.format("h:mm a");
    if (days === 1) return "yesterday";
    if (days > 1 && days < 7) return `${days}d ago`;
    if (days >= 7 && days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days >= 30 && days < 365) return m.format("MMM D");
    return m.format("MMM D, YYYY");
  }

  /** 0.69.3: append `text` to `el`, wrapping every case-insensitive
   *  occurrence of any token in a <span class="stashpad-suggest-match">.
   *  Used to highlight free-text query tokens in titles + previews. */
  private highlightInto(el: HTMLElement, text: string, tokens: string[]): void {
    if (!text) return;
    const cleanTokens = tokens.filter((t) => t && t.length > 0);
    if (!cleanTokens.length) { el.appendText(text); return; }
    const lower = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const t of cleanTokens) {
      let i = 0;
      while ((i = lower.indexOf(t, i)) !== -1) { ranges.push([i, i + t.length]); i += t.length; }
    }
    if (!ranges.length) { el.appendText(text); return; }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    let cursor = 0;
    for (const [s, e] of merged) {
      if (s > cursor) el.appendText(text.slice(cursor, s));
      el.createSpan({ cls: "stashpad-suggest-match", text: text.slice(s, e) });
      cursor = e;
    }
    if (cursor < text.length) el.appendText(text.slice(cursor));
  }

  /** 0.69.3 / 0.69.14: ancestor chain (oldest-first), excluding root,
   *  for a local TreeNode. The visited set short-circuits parent cycles
   *  — previously a 32-iter safety counter would happily print the same
   *  node 32 times when a note's ancestor chain looped back on itself,
   *  producing "Home › Home › Home › …" breadcrumbs. */
  private buildLocalBreadcrumb(node: TreeNode | null): string {
    if (!node || !node.parent || node.parent === ROOT_ID) return "";
    const chain: string[] = [];
    const seen = new Set<string>([node.id]);
    let cur = this.tree.get(node.parent);
    while (cur && cur.id !== ROOT_ID) {
      if (seen.has(cur.id)) break; // cycle detected
      seen.add(cur.id);
      chain.unshift(this.titleFn(cur));
      cur = cur.parent && cur.parent !== ROOT_ID ? this.tree.get(cur.parent) : undefined;
    }
    return chain.join(" › ");
  }

  /** 0.69.3: ancestor chain for a cross-folder result. Walks the
   *  per-folder parentId chain assembled from `this.notes`. Cached by
   *  folder to keep per-render cost low. */
  private crossFolderIndex: Map<string, Map<string, CrossFolderNote>> | null = null;
  private buildCrossBreadcrumb(item: PickerItem): string {
    if (!item.crossFolder) return "";
    if (!this.crossFolderIndex) {
      this.crossFolderIndex = new Map();
      for (const n of this.notes) {
        if (!n.cross) continue;
        let m = this.crossFolderIndex.get(n.cross.folder);
        if (!m) { m = new Map(); this.crossFolderIndex.set(n.cross.folder, m); }
        m.set(n.cross.id, n.cross);
      }
    }
    const byId = this.crossFolderIndex.get(item.crossFolder);
    if (!byId) return "";
    const startId = item.crossId ?? item.id.replace(/^cross:/, "");
    const start = byId.get(startId);
    if (!start) return "";
    const chain: string[] = [];
    const seen = new Set<string>([start.id]);
    let cur = start.parentId ? byId.get(start.parentId) : null;
    while (cur) {
      if (seen.has(cur.id)) break; // cycle detected
      seen.add(cur.id);
      chain.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return chain.join(" › ");
  }

  /** First non-empty line of a body string, with markdown noise trimmed. */
  private firstLineOfBody(body: string): string {
    if (!body) return "";
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return "";
  }

  /** First non-empty body line of the given node's parent. Reads from the
   *  already-loaded body cache (lazy reads populate it in the background;
   *  the line just won't render until that resolves). */
  private parentBlurbFor(node: TreeNode | null): string {
    if (!node || !node.parent || node.parent === ROOT_ID) return "";
    const parent = this.tree.get(node.parent);
    if (!parent || !parent.file) return "";
    const parentEntry = this.notes.find((n) => n.node?.id === parent.id);
    return parentEntry ? this.firstLineOfBody(parentEntry.body) : "";
  }

  onOpen(): void {
    super.onOpen();
    // 0.64.0: filter chips rendered between the input and the results
    // list. Each chip click inserts the filter prefix at the input's
    // current caret. Free-text typing still works the same — chips
    // are an affordance, not a different input mode.
    // 0.71.16: skip the chip row on mobile — the modal can't size to
    // fit dynamically, and the chip row plus the When-builder it
    // opens eat all the vertical room. Mobile gets a plain
    // SuggestModal; typed filters (`in:` / `when:` etc.) still work.
    if (this.opts.showFilterChips && !Platform.isMobile) {
      const inputEl = (this as any).inputEl as HTMLInputElement | undefined;
      const resultsEl = (this as any).resultContainerEl as HTMLElement | undefined;
      if (!inputEl || !resultsEl) return;
      this.mountFilterChipRow(inputEl, resultsEl);
      return;
    }
    // 0.76.36: on mobile, when the picker opens while the composer holds
    // the soft keyboard, focus doesn't move to the picker input on its
    // own — typed queries land in the composer. Obsidian's SuggestModal
    // deliberately doesn't autofocus its input on mobile (to avoid popping
    // the keyboard). We DO want it here, and crucially this onOpen runs
    // synchronously inside Modal.open(), which we call inside the button's
    // tap handler — so this focus() executes while the user gesture is
    // still live, letting iOS hop the keyboard from the composer textarea
    // straight to the picker input WITHOUT dismissing it. (Deferred
    // focus() via setTimeout would be outside the gesture and fail.)
    if (Platform.isMobile) {
      const inputEl = (this as any).inputEl as HTMLInputElement | undefined;
      if (inputEl) inputEl.focus();
    }
  }

  private mountFilterChipRow(inputEl: HTMLInputElement, resultsEl: HTMLElement): void {
      // 0.64.10: auto-pair the closing ] when the user types [ so the
      // bracketed-filter syntax doesn't require remembering to close.
      // Also: typing ] when the cursor is already on top of a } /  ]
      // skips past it (avoid duplicates).
      inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "[") {
          e.preventDefault();
          const start = inputEl.selectionStart ?? inputEl.value.length;
          const end = inputEl.selectionEnd ?? start;
          const before = inputEl.value.slice(0, start);
          const between = inputEl.value.slice(start, end); // selected text
          const after = inputEl.value.slice(end);
          inputEl.value = `${before}[${between}]${after}`;
          const caret = start + 1 + between.length;
          inputEl.setSelectionRange(caret, caret);
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        if (e.key === "]") {
          const pos = inputEl.selectionStart ?? -1;
          if (pos >= 0 && inputEl.value[pos] === "]") {
            // Cursor is right before a closing bracket — just skip past it.
            e.preventDefault();
            inputEl.setSelectionRange(pos + 1, pos + 1);
          }
          return;
        }
        // 0.64.11: smart pair delete — backspace on the opening [ with a
        // closing ] immediately after deletes both. Only triggers when
        // there's no selection (otherwise the user is deleting a range
        // and we'd lose their selected content). Also no modifiers so
        // we don't fight Alt-backspace (delete word) etc.
        if (
          e.key === "Backspace"
          && !e.metaKey && !e.ctrlKey && !e.altKey
          && inputEl.selectionStart === inputEl.selectionEnd
        ) {
          const pos = inputEl.selectionStart ?? -1;
          if (pos > 0 && inputEl.value[pos - 1] === "[" && inputEl.value[pos] === "]") {
            e.preventDefault();
            const before = inputEl.value.slice(0, pos - 1);
            const after = inputEl.value.slice(pos + 1);
            inputEl.value = `${before}${after}`;
            inputEl.setSelectionRange(pos - 1, pos - 1);
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      });
      const row = document.createElement("div");
      row.className = "stashpad-search-filter-row";
      const label = document.createElement("span");
      label.className = "stashpad-search-filter-label";
      label.textContent = "Filters:";
      row.appendChild(label);
      // 0.69.0: the three time-axis chips (before/after/on) collapse
      // into a single "When" chip that opens an inline builder panel
      // with a mode selector (Before / On / After / Between). The "in"
      // chip still inserts directly — it has no time semantics.
      const inChip = document.createElement("button");
      inChip.className = "stashpad-search-filter-chip";
      inChip.type = "button";
      inChip.textContent = `in:[parent note]`;
      inChip.title = `Insert "in:" — filter by parent note.`;
      inChip.addEventListener("mousedown", (e) => { e.preventDefault(); });
      inChip.addEventListener("click", (e) => {
        e.preventDefault();
        this.appendFilterToInput(inputEl, "in", "");
      });
      // 0.69.8: when the user Tabs from the search input to a chip and
      // presses Enter/Space, fire the chip's click handler instead of
      // letting the keydown bubble up to SuggestModal (which would pick
      // the highlighted search result).
      inChip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          inChip.click();
        }
      });
      row.appendChild(inChip);

      const whenChip = document.createElement("button");
      whenChip.className = "stashpad-search-filter-chip stashpad-search-filter-when";
      whenChip.type = "button";
      whenChip.textContent = `when:[date / day / timeframe]`;
      whenChip.title = `Open the time-filter builder (Before / On / After / Between).`;
      whenChip.addEventListener("mousedown", (e) => { e.preventDefault(); });
      whenChip.addEventListener("click", (e) => {
        e.preventDefault();
        this.toggleWhenBuilder(inputEl, row);
      });
      // 0.69.8: same Tab+Enter trap as the in: chip — keep keydown from
      // bubbling to SuggestModal's "pick the highlighted result" path.
      whenChip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          whenChip.click();
        }
      });
      row.appendChild(whenChip);

      // Insert the chip row BEFORE the results container.
      resultsEl.parentElement?.insertBefore(row, resultsEl);

      // 0.69.29: restore pushScope approach for chip Enter / Space.
      // Verified against the Obsidian Scope source:
      //   • Keymap.onKeyEvent only consults THE TOP scope (parent
      //     chain walked, stack siblings not walked).
      //   • Returning `false` triggers preventDefault + stopPropagation
      //     in onKeyEvent; returning `true` lets the DOM event continue.
      //   • SuggestModal has a DIRECT inputEl keydown listener that
      //     calls its own scope.handleKey independently — so when our
      //     handler returns `true`, the DOM event continues and
      //     SuggestModal's inputEl listener still fires + handles
      //     arrows / Enter / picks the highlighted suggestion.
      // Pushed scope is popped on modal close (Modal.register cleanup).
      // 0.69.34: parent = this.scope (SuggestModal's own scope) so
      // unhandled keys cascade INTO SuggestModal's arrow/Enter
      // handlers via the parent walk. Previously parent = app.scope,
      // which meant ArrowUp/ArrowDown were never reaching
      // SuggestModal — chipScope sits on top of the keymap, the
      // keymap only walks chipScope.parent (= app.scope) not the
      // siblings on the stack below, and arrows never updated the
      // selection.
      const chipScope = new Scope(this.scope);
      const handleChipKey = (ev: KeyboardEvent): boolean | void => {
        const active = document.activeElement as HTMLElement | null;
        // Chip-focused: activate the chip.
        if (active?.classList?.contains("stashpad-search-filter-chip")) {
          ev.preventDefault();
          active.click();
          return false; // consume — SuggestModal must NOT pick
        }
        // Non-chip Enter: explicitly invoke SuggestModal's pick path.
        // (0.69.44 — the previous `return true; → DOM continues → inputEl
        // onKeydown → this.scope.handleKey` path wasn't reliably firing
        // the Suggester's Enter handler in this setup. Calling
        // selectActiveSuggestion directly does the same thing
        // SuggestModal would have done.)
        if (ev.key === "Enter" && !ev.isComposing) {
          ev.preventDefault();
          (this as any).selectActiveSuggestion?.(ev);
          return false;
        }
        return true; // Space etc. — let DOM continue normally
      };
      chipScope.register([], "Enter", handleChipKey);
      chipScope.register([], " ", handleChipKey);
      // 0.69.36: pressing the search keybind (Mod+F) while the modal
      // is already open selects-all in the input — escape hatch from
      // any popover + replace-query in one keystroke. Handled in
      // chipScope because the view-level binding doesn't fire when
      // focus is in the modal.
      chipScope.register(["Mod"], "f", (ev: KeyboardEvent) => {
        ev.preventDefault();
        const ie = (this as any).inputEl as HTMLInputElement | undefined;
        if (ie) {
          ie.focus();
          ie.select();
        }
        return false;
      });
      // 0.69.37: Tab focus-trap — when focus would leave the modal,
      // cycle it back to the search input. (Without this, Tab on the
      // last tabbable element in the modal exits to Obsidian's main
      // window. Shift+Tab on the first cycles back to last.)
      chipScope.register([], "Tab", (ev: KeyboardEvent) => {
        const modalEl = (this as any).modalEl as HTMLElement | undefined;
        const inputEl = (this as any).inputEl as HTMLInputElement | undefined;
        if (!modalEl) return true;
        const focusable = Array.from(modalEl.querySelectorAll<HTMLElement>(
          'input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        )).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && el.offsetParent !== null);
        if (focusable.length === 0) return true;
        const active = document.activeElement as HTMLElement | null;
        const idx = active ? focusable.indexOf(active) : -1;
        if (ev.shiftKey) {
          if (idx <= 0) {
            ev.preventDefault();
            focusable[focusable.length - 1].focus();
            return false;
          }
        } else {
          if (idx === focusable.length - 1) {
            ev.preventDefault();
            (inputEl ?? focusable[0]).focus();
            return false;
          }
        }
        return true; // let Tab proceed normally between modal elements
      });
      (this.app as any).keymap?.pushScope(chipScope);
      this.pendingCleanups.push(() => { try { (this.app as any).keymap?.popScope(chipScope); } catch {} });
  }

  /** Append `key: [value]` to the input and place caret inside the
   *  brackets (when value is empty) or after them. */
  private appendFilterToInput(inputEl: HTMLInputElement, key: string, value: string): void {
    const current = inputEl.value;
    const needSpace = current.length > 0 && !/\s$/.test(current);
    const prefix = `${needSpace ? " " : ""}${key}: [`;
    const suffix = `]`;
    const inner = value;
    inputEl.value = `${current}${prefix}${inner}${suffix}`;
    const caret = current.length + prefix.length + inner.length;
    inputEl.setSelectionRange(caret, caret + (inner ? 0 : 0));
    if (!inner) {
      const open = current.length + prefix.length;
      inputEl.setSelectionRange(open, open);
    }
    inputEl.focus();
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private whenBuilderEl: HTMLElement | null = null;
  /** Active mode in the When-builder. Persists across opens so the user
   *  doesn't have to re-pick the same mode every time. */
  private whenMode: "before" | "on" | "after" | "between" = "on";
  /** 0.69.2: text the user has typed in the When-builder, preserved
   *  across mode switches. `single` is the value shown in Before / On /
   *  After (one shared buffer). `betweenEnd` is the second input that
   *  only appears in Between mode; it's thrown away when the user
   *  switches away (its content isn't representable in a single-axis
   *  filter). `single` doubles as the start-date when switching INTO
   *  Between. */
  private whenSingleText = "";
  private whenBetweenEndText = "";
  // 0.69.5: Date/Text sub-tabs collapsed into one text input with
  // calendar + clock icon buttons inline. State for whenInputType +
  // date/time buffers removed; the buttons just insert their value at
  // the cursor of the text input (additive, never replacing).

  /** Toggle the inline When-builder panel. When opening, it inserts
   *  itself directly after the chip row. When closing, it's removed. */
  private toggleWhenBuilder(inputEl: HTMLInputElement, chipRow: HTMLElement): void {
    const modalEl = (this as any).modalEl as HTMLElement | undefined;
    if (this.whenBuilderEl) {
      this.whenBuilderEl.remove();
      this.whenBuilderEl = null;
      // 0.71.24: drop the modal-grow class so the picker returns to its
      // natural compact size after the builder closes.
      modalEl?.removeClass("is-when-builder-open");
      return;
    }
    // 0.71.24: stretch the modal so a short results list can't clip the
    // builder. The class on modalEl is removed when the builder closes.
    modalEl?.addClass("is-when-builder-open");
    const panel = document.createElement("div");
    panel.className = "stashpad-when-builder";
    // Mode tabs row.
    const tabs = document.createElement("div");
    tabs.className = "stashpad-when-tabs";
    const modes: Array<{ id: "before" | "on" | "after" | "between"; label: string }> = [
      { id: "before", label: "Before" },
      { id: "on", label: "On" },
      { id: "after", label: "After" },
      { id: "between", label: "Between" },
    ];
    const tabBtns: Record<string, HTMLButtonElement> = {};
    for (const m of modes) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "stashpad-when-tab";
      t.textContent = m.label;
      if (this.whenMode === m.id) t.addClass("is-active");
      t.addEventListener("mousedown", (e) => e.preventDefault());
      t.addEventListener("click", (e) => {
        e.preventDefault();
        if (this.whenMode === m.id) return;
        const prev = this.whenMode;
        // 0.69.2: preserve typed text across mode switches.
        //  - prev != between, next == between: single → start; end empty.
        //  - prev == between, next != between: end is thrown away; if
        //    start (single) is empty, fall back to end so the user
        //    doesn't lose what they typed.
        if (prev !== "between" && m.id === "between") {
          // single is already set; just ensure the end text is empty.
          this.whenBetweenEndText = "";
        } else if (prev === "between" && m.id !== "between") {
          if (!this.whenSingleText && this.whenBetweenEndText) {
            this.whenSingleText = this.whenBetweenEndText;
          }
          this.whenBetweenEndText = "";
        }
        this.whenMode = m.id;
        for (const k in tabBtns) tabBtns[k].toggleClass("is-active", k === m.id);
        rebuildBody();
      });
      tabBtns[m.id] = t;
      tabs.appendChild(t);
    }
    panel.appendChild(tabs);

    // Body: text input(s) + Insert/Cancel. 0.69.0 is the shell —
    // future commits add Date / Day / Timeframe sub-tabs and richer
    // inputs. For now a single text field (or two for Between) matches
    // today's behavior, just routed through the unified entry point.
    const body = document.createElement("div");
    body.className = "stashpad-when-body";
    panel.appendChild(body);

    /** Mode-aware default time string (HH:MM) — used by the inline clock
     *  icon button. On / Before default to "now" if the existing input
     *  text refers to today (or is blank), else end-of-day. After always
     *  uses 00:00. Between's slot is provided by the caller. 0.69.5. */
    const defaultTimeFor = (
      mode: typeof this.whenMode,
      precedingDate: string | null,
      slot: "single" | "betweenStart" | "betweenEnd" = "single",
    ): string => {
      const today = momentFn().format("YYYY-MM-DD");
      const isToday = !precedingDate || precedingDate === today;
      if (slot === "betweenStart") return "00:00";
      if (slot === "betweenEnd") return "23:59";
      switch (mode) {
        case "after": return "00:00";
        case "on": return isToday ? momentFn().format("HH:mm") : "23:59";
        case "before": return isToday ? momentFn().format("HH:mm") : "23:59";
        default: return "23:59";
      }
    };

    const trapKeys = (el: HTMLInputElement, onEnter: () => void) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onEnter(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeWhenBuilder(); }
      });
    };

    /** Insert `text` at the caret of `input`, then re-fire the input
     *  event so the bound setter persists the new value. 0.69.5. */
    const insertAtCursor = (input: HTMLInputElement, text: string): void => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      // Add a leading space when the existing text doesn't end with one
      // (so chained calendar+clock taps don't smush together).
      const needSpace = start > 0 && !/\s$/.test(input.value.slice(0, start));
      const insert = `${needSpace ? " " : ""}${text}`;
      const next = input.value.slice(0, start) + insert + input.value.slice(end);
      input.value = next;
      const pos = start + insert.length;
      input.setSelectionRange(pos, pos);
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    /** Extract a YYYY-MM-DD substring ending at or before `caret` from
     *  `value` — used by the clock icon to determine "is the date the
     *  user already typed today?" for the on/before mode-aware default. */
    const precedingDateFromInput = (value: string, caret: number): string | null => {
      const slice = value.slice(0, caret);
      const m = slice.match(/(\d{4}-\d{2}-\d{2})(?!.*\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    /** Build a text input wrapped with: calendar + clock icon buttons on
     *  the left that OPEN the native date / time picker (Chromium
     *  showPicker() — Electron supports it). Whatever the user picks is
     *  inserted at the text input's caret. Clear-X stays on the right.
     *  0.69.5. */
    const buildInputWithIcons = (
      placeholder: string,
      getter: () => string,
      setter: (v: string) => void,
      slot: "single" | "betweenStart" | "betweenEnd",
    ): HTMLInputElement => {
      const wrap = body.createDiv({ cls: "stashpad-when-input-wrap has-icons" });
      // 0.69.8: each icon button + its hidden native picker live in a
      // small slot wrapper. Putting the native input as a *child* of
      // the button (as in 0.69.7) caused Chromium's default
      // input[type=date] styling to swallow the inline SVG, leaving
      // the calendar icon invisible. Sibling layout fixes that while
      // still anchoring showPicker() to the button's rect.
      const calSlot = wrap.createDiv({ cls: "stashpad-when-icon-slot" });
      const calBtn = calSlot.createEl("button", { cls: "stashpad-when-icon stashpad-when-icon-cal" });
      calBtn.type = "button";
      calBtn.title = "Pick date";
      // 0.69.21: swap of date / day icons — calendar-days (grid of
       // numbered cells) suggests "pick a specific date" better than the
       // plain calendar shell.
      setIcon(calBtn, "calendar-days");
      const calNative = calSlot.createEl("input", {
        cls: "stashpad-when-native",
        attr: { type: "date" },
      }) as HTMLInputElement;
      // 0.69.30: hidden natives shouldn't show up in tab order — Tab
      // was previously hitting them between each visible icon button.
      calNative.tabIndex = -1;

      // 0.69.11: clock icon now opens a CUSTOM time-picker popover with
      // HH / MM text fields, AM/PM toggle, and a numpad. Native time
      // picker is gone — we control Enter/Tab behavior end-to-end.
      const clockSlot = wrap.createDiv({ cls: "stashpad-when-icon-slot" });
      const clockBtn = clockSlot.createEl("button", { cls: "stashpad-when-icon stashpad-when-icon-clock" });
      clockBtn.type = "button";
      clockBtn.title = "Pick time";
      setIcon(clockBtn, "clock");

      // 0.69.9: "Day" icon — popover with Today / Yesterday chips above
      // a Mon–Sun weekday row. Picking any item inserts the
      // corresponding lowercase keyword the parser already understands.
      const daySlot = wrap.createDiv({ cls: "stashpad-when-icon-slot" });
      const dayBtn = daySlot.createEl("button", { cls: "stashpad-when-icon stashpad-when-icon-day" });
      dayBtn.type = "button";
      dayBtn.title = "Pick day";
      // 0.69.21: plain calendar shell for the day-of-week picker —
       // less "specific date" feel than calendar-days. (Lucide doesn't
       // have a numbered-1 variant in Obsidian's bundled set; this is
       // the cleanest available pair.)
      setIcon(dayBtn, "calendar");

      // 0.69.10: "Timeframe" icon — popover with preset chips above a
      // "Last [N] [unit]" stepper. Compiles to the existing 7d / 2w /
      // 1m / 1y relative-duration syntax.
      const tfSlot = wrap.createDiv({ cls: "stashpad-when-icon-slot" });
      const tfBtn = tfSlot.createEl("button", { cls: "stashpad-when-icon stashpad-when-icon-tf" });
      tfBtn.type = "button";
      tfBtn.title = "Pick timeframe";
      // 0.69.21: history (cycle-back arrow) reads as "look back N
       // units" better than the abstract timer icon.
      setIcon(tfBtn, "history");

      const input = wrap.createEl("input", {
        cls: "stashpad-when-input",
        attr: { type: "text", placeholder },
      }) as HTMLInputElement;
      input.value = getter();
      input.addEventListener("input", () => setter(input.value));

      const clear = wrap.createEl("button", { cls: "stashpad-when-clear" });
      clear.type = "button";
      clear.textContent = "×";
      clear.title = "Clear";

      for (const b of [calBtn, clockBtn, dayBtn, tfBtn, clear]) b.addEventListener("mousedown", (e) => e.preventDefault());

      // 0.69.9 / 0.69.27 / 0.69.29: tiny popover anchored under an
      // icon-slot. Each popover pushes its own Scope onto the keymap
      // so Escape closes the popover (not the modal) and Enter fires
      // the popover's Insert action via the `onEnter` callback BEFORE
      // consuming the event — Keymap preempts DOM dispatch when a
      // handler returns false, so the popover's own input keydown
      // listeners can't be relied on to do Insert. We do it in the
      // Scope handler instead.
      let currentPopoverClose: (() => void) | null = null;
      const openInsertPopover = (
        anchor: HTMLElement,
        fill: (popover: HTMLElement, close: () => void, setOnEnter: (cb: () => void) => void) => void,
      ): void => {
        if (currentPopoverClose) currentPopoverClose();
        const pop = anchor.createDiv({ cls: "stashpad-when-popover" });
        // 0.69.34: parent = chipScope's parent (this.scope) so unhandled
        // keys (arrows etc) cascade to SuggestModal's handlers, same
        // reasoning as chipScope above.
        const popScope = new Scope(this.scope);
        let onEnter: (() => void) | null = null;
        const setOnEnter = (cb: () => void): void => { onEnter = cb; };
        let closed = false;
        const outside = (e: MouseEvent): void => {
          if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          pop.remove();
          document.removeEventListener("mousedown", outside, true);
          try { (this.app as any).keymap?.popScope(popScope); } catch {}
          if (currentPopoverClose === close) currentPopoverClose = null;
        };
        currentPopoverClose = close;
        popScope.register([], "Escape", (ev: KeyboardEvent) => {
          ev.preventDefault();
          close();
          return false;
        });
        popScope.register([], "Enter", (ev: KeyboardEvent) => {
          // Always consume Enter while the popover is open — Keymap
          // calls preventDefault + stopPropagation on `false`, so
          // SuggestModal's inputEl listener never sees it (and won't
          // pick the highlighted suggestion).
          ev.preventDefault();
          if (onEnter) onEnter();
          return false;
        });
        // 0.69.31: fill the popover content FIRST. If fill throws, we
        // close (which is a no-op since nothing's pushed yet). Then
        // push the scope + attach the outside listener.
        try {
          fill(pop, close, setOnEnter);
        } catch (err) {
          console.error("[stashpad] popover fill threw:", err);
          pop.remove();
          currentPopoverClose = null;
          return;
        }
        (this.app as any).keymap?.pushScope(popScope);
        // Belt-and-suspenders: if the modal closes with this popover
        // still open, ensure the scope is popped on close.
        this.pendingCleanups.push(close);
        setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
      };

      tfBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openInsertPopover(tfSlot, (pop, close, setOnEnter) => {
          // 0.69.18: `on:` mode + relative-duration means "on a specific
          // date N units ago" — but inserting "5m" is opaque. Resolve
          // the duration to YYYY-MM-DD on insert so the search bar
          // reads "on: [2025-12-25]" instead of "on: [5m]". For
          // before / after / between modes the relative-duration syntax
          // remains useful as-is (it's a rolling window).
          const isOnMode = this.whenMode === "on";
          const compileValue = (n: number, unit: "d" | "w" | "m" | "y"): string => {
            if (!isOnMode) return `${n}${unit}`;
            const mUnit = { d: "days", w: "weeks", m: "months", y: "years" }[unit] as moment.unitOfTime.DurationConstructor;
            return momentFn().subtract(n, mUnit).format("YYYY-MM-DD");
          };

          // Preset chips — common windows.
          const presets = pop.createDiv({ cls: "stashpad-when-pop-row" });
          const presetDefs: Array<{ label: string; n: number; unit: "d" | "w" | "m" | "y" }> = [
            { label: "Last 7d", n: 7, unit: "d" },
            { label: "Last 30d", n: 30, unit: "d" },
            { label: "This week", n: 1, unit: "w" },
            { label: "This month", n: 1, unit: "m" },
          ];
          for (const p of presetDefs) {
            const chip = presets.createEl("button", { cls: "stashpad-when-pop-chip", text: p.label });
            chip.type = "button";
            chip.addEventListener("mousedown", (ev) => ev.preventDefault());
            chip.addEventListener("click", (ev) => {
              ev.preventDefault();
              insertAtCursor(input, compileValue(p.n, p.unit));
              close();
            });
          }
          // Custom stepper — Last [N] [unit].
          const builder = pop.createDiv({ cls: "stashpad-when-pop-row stashpad-when-pop-builder" });
          builder.createSpan({ text: "Last", cls: "stashpad-when-pop-label" });
          const nInput = builder.createEl("input", {
            cls: "stashpad-when-pop-number",
            attr: { type: "number", min: "1", max: "999", value: "7" },
          }) as HTMLInputElement;
          const unitSel = builder.createEl("select", { cls: "stashpad-when-pop-unit" });
          for (const u of [
            { v: "d", label: "days" },
            { v: "w", label: "weeks" },
            { v: "m", label: "months" },
            { v: "y", label: "years" },
          ]) {
            const o = unitSel.createEl("option", { text: u.label });
            o.value = u.v;
          }
          const insertBtn = builder.createEl("button", {
            cls: "stashpad-when-pop-chip stashpad-when-pop-go",
            text: "Insert",
          });
          insertBtn.type = "button";
          const doInsert = (): void => {
            const n = parseInt(nInput.value, 10);
            if (!Number.isFinite(n) || n < 1) return;
            insertAtCursor(input, compileValue(n, unitSel.value as "d" | "w" | "m" | "y"));
            close();
          };
          insertBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
          insertBtn.addEventListener("click", (ev) => { ev.preventDefault(); doInsert(); });
          // 0.69.29: route popover-level Enter to doInsert.
          setOnEnter(doInsert);
          nInput.focus();
          nInput.select();
        });
      });

      /** 0.69.11 — custom time-picker popover. HH + MM text fields with
       *  AM/PM toggle on top, numpad + ⌫ + Insert below. Inserts the
       *  picked time as `HH:MMam` / `HH:MMpm` (lowercase) at the input's
       *  caret. Enter/Tab stay inside the popover. */
      const openTimePicker = (
        targetInput: HTMLInputElement,
        anchor: HTMLElement,
        seedH: number,
        seedM: number,
        seedPeriod: "am" | "pm",
      ): void => {
        openInsertPopover(anchor, (pop, close, setOnEnter) => {
          // 0.76.23: the picker UI now lives in src/time-picker.ts so
          // the due-date modal can reuse the exact same control. This
          // host keeps the SuggestModal scope-aware popover behaviour;
          // the shared builder fills it + reports the result, which we
          // format the same way as before and insert at the caret.
          buildTimePickerInto(pop, {
            seedH, seedM, seedPeriod, close, setOnEnter,
            onFinalize: (r) => insertAtCursor(targetInput, formatWhenTime(r)),
          });
        });
      };

      dayBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openInsertPopover(daySlot, (pop, close, _setOnEnter) => {
          // 0.69.17: display labels are Propercase ("Today", "Monday").
          // The parser is case-insensitive (lowercases input first), so
          // we insert Propercase too for readability in the search bar.
          const top = pop.createDiv({ cls: "stashpad-when-pop-row" });
          for (const label of ["Today", "Yesterday"]) {
            const chip = top.createEl("button", { cls: "stashpad-when-pop-chip", text: label });
            chip.type = "button";
            chip.addEventListener("mousedown", (ev) => ev.preventDefault());
            chip.addEventListener("click", (ev) => {
              ev.preventDefault();
              insertAtCursor(input, label);
              close();
            });
          }
          const days = pop.createDiv({ cls: "stashpad-when-pop-row stashpad-when-pop-days" });
          const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
          const todayIdx = momentFn().day(); // 0=Sun .. 6=Sat
          // Map to monday-first index (monday=0 .. sunday=6).
          const todayMondayFirst = (todayIdx + 6) % 7;
          for (let i = 0; i < dayNames.length; i++) {
            const name = dayNames[i];
            const chip = days.createEl("button", {
              cls: "stashpad-when-pop-chip",
              text: name.slice(0, 3),
            });
            chip.type = "button";
            chip.title = name;
            if (i === todayMondayFirst) chip.addClass("is-today");
            chip.addEventListener("mousedown", (ev) => ev.preventDefault());
            chip.addEventListener("click", (ev) => {
              ev.preventDefault();
              // 0.69.17: for Between mode's END slot, resolve weekday
              // names to the NEXT future occurrence (as YYYY-MM-DD) so
              // `after:[Sunday] before:[Wednesday]` on a Monday spans
              // past Sunday → upcoming Wednesday instead of yielding
              // an empty range (parseDateToken always picks the most
              // recent past occurrence otherwise).
              if (slot === "betweenEnd") {
                const targetIdx = i; // monday-first idx
                const today = momentFn().startOf("day");
                const todayMF = (today.day() + 6) % 7;
                let add = (targetIdx - todayMF + 7) % 7;
                if (add === 0) add = 7; // today's weekday → next week
                const date = today.clone().add(add, "days").format("YYYY-MM-DD");
                insertAtCursor(input, date);
              } else {
                insertAtCursor(input, name);
              }
              close();
            });
          }
        });
      });

      const openPicker = (native: HTMLInputElement, fallbackValue: string): void => {
        // Seed the hidden picker with today/now when the user hasn't
        // selected anything yet so it opens at a sensible spot.
        if (!native.value) native.value = fallbackValue;
        const anyNative = native as any;
        if (typeof anyNative.showPicker === "function") {
          try { anyNative.showPicker(); return; } catch { /* fall through to focus+click */ }
        }
        native.focus();
        native.click();
      };
      calBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openPicker(calNative, momentFn().format("YYYY-MM-DD"));
      });
      calNative.addEventListener("change", () => {
        if (!calNative.value) return;
        insertAtCursor(input, calNative.value);
      });
      // 0.69.11: clock button opens a custom popover (HH / MM / AM-PM
      // + numpad). Defers to defaultTimeFor for the initial values,
      // honoring the immediately-preceding YYYY-MM-DD (if any) for the
      // is-today check that On/Before use.
      clockBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const caret = input.selectionStart ?? input.value.length;
        const preceding = precedingDateFromInput(input.value, caret);
        const seed = defaultTimeFor(this.whenMode, preceding, slot); // "HH:MM" (24h)
        const [seedH24Str, seedMStr] = seed.split(":");
        const seedH24 = parseInt(seedH24Str, 10);
        const seedM = parseInt(seedMStr, 10);
        // Convert 24h seed → 12h + period for the picker.
        let h12 = seedH24 % 12; if (h12 === 0) h12 = 12;
        let period: "am" | "pm" = seedH24 >= 12 ? "pm" : "am";
        openTimePicker(input, clockSlot, h12, seedM, period);
      });
      clear.addEventListener("click", (e) => {
        e.preventDefault();
        input.value = "";
        setter("");
        input.focus();
      });
      return input;
    };

    const rebuildBody = (): void => {
      body.empty();
      if (this.whenMode === "between") {
        const startInput = buildInputWithIcons(
          "start (date / day / timeframe)",
          () => this.whenSingleText,
          (v) => { this.whenSingleText = v; },
          "betweenStart",
        );
        const endInput = buildInputWithIcons(
          "end (date / day / timeframe)",
          () => this.whenBetweenEndText,
          (v) => { this.whenBetweenEndText = v; },
          "betweenEnd",
        );
        const actions = body.createDiv({ cls: "stashpad-when-actions" });
        const insert = actions.createEl("button", { cls: "stashpad-when-insert", text: "Insert" });
        insert.type = "button";
        insert.addEventListener("mousedown", (e) => e.preventDefault());
        const doInsert = (): void => {
          const s = startInput.value.trim();
          const en = endInput.value.trim();
          if (s) this.appendFilterToInput(inputEl, "after", s);
          if (en) this.appendFilterToInput(inputEl, "before", en);
          this.closeWhenBuilder();
        };
        insert.addEventListener("click", (e) => { e.preventDefault(); doInsert(); });
        const cancel = actions.createEl("button", { cls: "stashpad-when-cancel", text: "Cancel" });
        cancel.type = "button";
        cancel.addEventListener("mousedown", (e) => e.preventDefault());
        cancel.addEventListener("click", (e) => { e.preventDefault(); this.closeWhenBuilder(); });
        trapKeys(startInput, doInsert);
        trapKeys(endInput, doInsert);
        startInput.focus();
        startInput.setSelectionRange(startInput.value.length, startInput.value.length);
      } else {
        const input = buildInputWithIcons(
          "date / day / timeframe",
          () => this.whenSingleText,
          (v) => { this.whenSingleText = v; },
          "single",
        );
        const actions = body.createDiv({ cls: "stashpad-when-actions" });
        const insert = actions.createEl("button", { cls: "stashpad-when-insert", text: "Insert" });
        insert.type = "button";
        insert.addEventListener("mousedown", (e) => e.preventDefault());
        const doInsert = (): void => {
          const v = input.value.trim();
          if (v) this.appendFilterToInput(inputEl, this.whenMode, v);
          this.closeWhenBuilder();
        };
        insert.addEventListener("click", (e) => { e.preventDefault(); doInsert(); });
        const cancel = actions.createEl("button", { cls: "stashpad-when-cancel", text: "Cancel" });
        cancel.type = "button";
        cancel.addEventListener("mousedown", (e) => e.preventDefault());
        cancel.addEventListener("click", (e) => { e.preventDefault(); this.closeWhenBuilder(); });
        trapKeys(input, doInsert);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    };
    rebuildBody();

    chipRow.parentElement?.insertBefore(panel, chipRow.nextSibling);
    this.whenBuilderEl = panel;
  }

  private closeWhenBuilder(): void {
    if (!this.whenBuilderEl) return;
    this.whenBuilderEl.remove();
    this.whenBuilderEl = null;
    const modalEl = (this as any).modalEl as HTMLElement | undefined;
    modalEl?.removeClass("is-when-builder-open");
  }

  /** 0.92.1: intercept the "search excluded folders" action BEFORE the base
   *  class closes the modal — we want to stay open, merge the excluded notes,
   *  and refresh the list in place. All other picks fall through to the normal
   *  select-then-close path. */
  selectSuggestion(value: PickerItem, evt: MouseEvent | KeyboardEvent): void {
    if (value && value.kind === "search-excluded") {
      this.loadExcludedNotes();
      return;
    }
    super.selectSuggestion(value, evt);
  }

  onChooseSuggestion(item: PickerItem): void {
    if (item.kind === "create" && this.opts.onCreate) {
      this.opts.onCreate((this as any).inputEl?.value ?? "");
      return;
    }
    // 0.69.3: collapsed folder-open entry → open a sub-picker of every
    // Stashpad folder. 0.69.20: if the sub-picker closes WITHOUT a
    // pick (user hit X / Escape), re-open the search modal with the
    // same query so X feels like "go back" instead of "exit entirely."
    if (item.kind === "folder-open" && item.id === "__folder_picker__") {
      const folders = this.opts.folderResults?.() ?? [];
      if (!folders.length) return;
      const savedQuery = (this as any).inputEl?.value ?? "";
      let picked = false;
      const onPicked = (folder: string): void => {
        picked = true;
        const last = folder.split("/").pop() ?? folder;
        this.opts.onPick({
          id: `folder:${folder}`,
          label: `Open folder “${last}” in a new tab`,
          node: null,
          kind: "folder-open",
          folder,
        });
      };
      const sub = new FolderOpenPicker((this as any).app as App, folders, onPicked);
      const onClose = sub.onClose.bind(sub);
      const tree = this.tree;
      const titleFn = this.titleFn;
      const opts = this.opts;
      const appRef = (this as any).app as App;
      sub.onClose = (): void => {
        onClose();
        if (!picked) {
          const restored = new StashpadSuggest(appRef, tree, titleFn, opts);
          restored.open();
          // 0.69.45: always focus the restored modal's inputEl after
          // open. Without explicit focus the modal renders but keyboard
          // focus stays on whatever Obsidian's modal-stack restored to
          // (often the underlying app behind the modal).
          setTimeout(() => {
            const ie = (restored as any).inputEl as HTMLInputElement | undefined;
            if (!ie) return;
            if (savedQuery) {
              ie.value = savedQuery;
              ie.dispatchEvent(new Event("input", { bubbles: true }));
            }
            ie.focus();
            ie.setSelectionRange(ie.value.length, ie.value.length);
          }, 0);
        }
      };
      sub.open();
      return;
    }
    this.opts.onPick(item);
  }
}

/** Sub-picker opened by the collapsed "Open folder in a new tab…" row.
 *  Lists every searchable Stashpad folder with its own fuzzy filter,
 *  then hands the chosen folder back to the caller. 0.69.3. */
class FolderOpenPicker extends FuzzySuggestModal<string> {
  constructor(app: App, private folders: string[], private onChosen: (folder: string) => void) {
    super(app);
    this.setPlaceholder("Open which folder?");
  }
  getItems(): string[] { return this.folders; }
  getItemText(folder: string): string {
    const last = folder.split("/").pop() ?? folder;
    return last === folder ? folder : `${last}  —  ${folder}`;
  }
  onChooseItem(folder: string): void { this.onChosen(folder); }
}
