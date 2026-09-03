import { App, Scope, TFile, moment } from "obsidian";
import { isArchivedPath, isIgnoredFileExtension, matchesObsidianIgnore, siftMatch } from "./types";
import { HIGHLIGHT_COLORS, takeLeadingColor } from "./highlight-colors";
import { getSettings, getTemplatesFormats } from "./settings";
import { MarkdownInput, type MarkdownInputOptions } from "./markdown-input";

/**
 * Composer autocomplete: a lightweight popup attached to a plain
 * <textarea> that suggests tags (after `#`) and wikilink targets
 * (after `[[`). Built for Stashpad's composer because Obsidian's
 * EditorSuggest API only works against CodeMirror editors.
 *
 * Lifecycle:
 *   const ac = new ComposerAutocomplete(app, textareaEl);
 *   ac.attach();   // start listening
 *   ac.detach();   // stop and remove popup
 *
 * Triggers (matched against the substring ending at the caret):
 *   #foo            → tag suggestions ("#foo", "#foobar", ...)
 *   [[foo           → file suggestions (basenames containing "foo")
 *   @foo            → unified: natural-language dates (via the Natural
 *                     Language Dates plugin's parseDate API, if installed)
 *                     blended with note-link suggestions. `@today` inserts
 *                     the resolved date; `@meeting` inserts [[Meeting]].
 *                     Falls back to note-links only when NLD isn't present.
 *
 * Keyboard while popup is open:
 *   ↑/↓             move highlighted item
 *   Enter / Tab     insert highlighted item
 *   Escape          dismiss without inserting
 *
 * The popup self-positions just below the textarea and follows scroll/
 * resize. It does NOT try to anchor to the caret position (which would
 * require a hidden mirror element); textarea-bottom anchoring is good
 * enough for a small composer.
 */
/** Obsidian's frontmatter aliases for a note, normalized.
 *
 *  Accepts both `aliases` and the legacy singular `alias`, and both a bare string
 *  and a list — all four shapes appear in real vaults. Returns de-duplicated,
 *  trimmed, non-empty strings; anything else (numbers, nested objects) is ignored
 *  rather than coerced, since a junk alias would pollute the link autocomplete.
 */
/** One row of the link-autocomplete index: either a file (by name) or one of its
 *  frontmatter aliases. `alias` set = this row matched by alias, which changes
 *  what gets inserted. */
interface FileIndexEntry {
  label: string;
  lower: string;
  insertText: string;
  file: TFile;
  alias?: string;
}

function frontmatterAliases(app: App, file: TFile): string[] {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  if (!fm) return [];
  const out: string[] = [];
  for (const key of ["aliases", "alias"]) {
    const raw = fm[key];
    if (typeof raw === "string") out.push(raw);
    else if (Array.isArray(raw)) for (const v of raw) if (typeof v === "string") out.push(v);
  }
  const seen = new Set<string>();
  return out
    .map((a) => a.trim())
    .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
}

/** Relative date phrases offered by the `@` trigger, with the day offset each
 *  one resolves to. The point of the catalogue is PARTIAL matching: typing
 *  `@yest` should show "yesterday" *and the date it resolves to* before the
 *  word is finished. Resolving the partial string directly can't do that —
 *  "yest" is not a date to any parser — so the phrase list is matched on the
 *  prefix and the resolution happens against the full phrase.
 *
 *  Offsets are in days from today. Phrases whose meaning isn't a fixed offset
 *  (weekday names, "in 3 weeks") carry a null offset: they're still listed for
 *  discovery, and resolution is left to the Natural Language Dates plugin,
 *  which handles them properly. */
const DATE_PHRASES: Array<{ phrase: string; days: number | null }> = [
  { phrase: "today", days: 0 },
  { phrase: "tomorrow", days: 1 },
  { phrase: "yesterday", days: -1 },
  { phrase: "next week", days: 7 },
  { phrase: "last week", days: -7 },
  { phrase: "in 2 days", days: 2 },
  { phrase: "in 3 days", days: 3 },
  { phrase: "in a week", days: 7 },
  { phrase: "in two weeks", days: 14 },
  { phrase: "next month", days: null },
  { phrase: "last month", days: null },
  { phrase: "the day after tomorrow", days: 2 },
  { phrase: "the day before yesterday", days: -2 },
  { phrase: "next monday", days: null },
  { phrase: "next tuesday", days: null },
  { phrase: "next wednesday", days: null },
  { phrase: "next thursday", days: null },
  { phrase: "next friday", days: null },
  { phrase: "next saturday", days: null },
  { phrase: "next sunday", days: null },
  { phrase: "last friday", days: null },
  { phrase: "end of week", days: null },
  { phrase: "end of month", days: null },
];

/** Commands withheld from the `/` popup.
 *
 *  The bar for exclusion is "running this from a half-typed line is
 *  incoherent", not "this is dangerous" — destructive commands are undoable
 *  and belong here as much as anywhere. Kept deliberately short: the list is
 *  meant to grow from real use, not from guesses about what might feel odd.
 *
 *  - the palettes: you are already in a command picker.
 *  - focus-the-list: the slash popup lives in a text field, so the command
 *    that leaves the text field cannot be driven from inside it sensibly. */
const SLASH_EXCLUDED = new Set<string>([
  "stashpad:stashpad-command-palette",
  "stashpad:stashpad-focus-list",
]);

/** Callable view of Obsidian's `moment` export (typed as a namespace). */
const momentFn = moment as unknown as (...args: unknown[]) => {
  add: (n: number, unit: string) => { format: (f: string) => string };
};

export class ComposerAutocomplete {
  private popupEl: HTMLDivElement | null = null;
  private items: SuggestItem[] = [];
  private activeIdx = 0;
  private state: AutocompleteState | null = null;

  /** Cached lowercased labels + tag list, refreshed when the vault
   *  fires create/delete/rename. Avoids re-walking getFiles() on every
   *  keystroke.
   *
   *  0.73.3: switched from getMarkdownFiles() to all TFiles so the
   *  link autocomplete surfaces images, PDFs, attachments, etc. — not
   *  just markdown. `.edtz` files (Encrypted Templater) stay excluded
   *  because they're internal-tooling files users never link to. */
  private fileIndex: FileIndexEntry[] = [];
  private tagIndex: string[] = [];
  private indexBuilt = false;
  private vaultListeners: Array<() => void> = [];
  /** Obsidian Scope pushed onto the keymap while the popup is open. It
   *  consumes Escape (and Enter/Tab/Arrow keys are also re-bound here
   *  belt-and-suspenders) so the workspace's "Escape returns to last
   *  leaf" handler doesn't fire and yank focus to a previous tab. */
  private scope: Scope | null = null;
  /** 0.202.0: shared Markdown editing behaviors (see markdown-input.ts). */
  private input: MarkdownInput | null = null;

  constructor(
    private app: App,
    private ta: HTMLTextAreaElement,
    /** Passed through to MarkdownInput — chiefly `insertsNewline`, which tells
     *  list continuation whether THIS Enter makes a newline or submits. */
    private inputOpts: MarkdownInputOptions = {},
    /** 0.254.0: called right after the `/` trigger text is removed and just
     *  before the chosen command runs, with the composer's resulting text.
     *
     *  It exists so the host can PERSIST that text synchronously. Draft saving
     *  is debounced (250ms), and a command that writes settings broadcasts a
     *  change whose handler reconciles the composer against the last PERSISTED
     *  draft — so without this flush, running a command within a moment of
     *  typing can restore an older draft over what you just wrote. */
    private onBeforeCommand: ((text: string) => void) | null = null,
  ) {}

  attach(): void {
    this.ta.addEventListener("input", this.onInput);
    // 0.202.0: the Markdown editing behaviors (autopair, wrap, list
    // continuation, Tab indent, double-click trim) live in their own layer —
    // attached here so EVERY surface that gets suggestions also gets them.
    this.input = new MarkdownInput(this.app, this.ta, this.inputOpts);
    this.input.attach();
    this.ta.addEventListener("keydown", this.onKeyDown, true);
    this.ta.addEventListener("blur", this.onBlur);
    // Document-capture Escape interceptor — only acts while a popup is
    // open. Without this, Obsidian's workspace-level Escape (which
    // refocuses another tab / split) wins the capture-phase race against
    // our textarea-level listener and the user gets thrown off the view.
    const doc = this.ta.ownerDocument ?? document;
    doc.addEventListener("keydown", this.onDocEscape, true);
    this.vaultListeners.push(() => doc.removeEventListener("keydown", this.onDocEscape, true));
    doc.addEventListener("keydown", this.onDocSelectAll, true);
    this.vaultListeners.push(() => doc.removeEventListener("keydown", this.onDocSelectAll, true));
    this.buildIndex();
    // Refresh index on vault structure changes. Coalesce by just
    // invalidating; next openFor call rebuilds lazily.
    const invalidate = () => { this.indexBuilt = false; };
    const v = this.app.vault as any;
    v.on("create", invalidate);
    v.on("delete", invalidate);
    v.on("rename", invalidate);
    this.vaultListeners.push(
      () => v.off("create", invalidate),
      () => v.off("delete", invalidate),
      () => v.off("rename", invalidate),
    );
  }

  /** 0.74.4: true while the popup is showing suggestions. Lets a host
   *  textarea's own Enter handler defer to the popup (which consumes
   *  Enter to accept the highlighted suggestion). */
  isOpen(): boolean {
    return !!this.state && this.items.length > 0;
  }

  detach(): void {
    this.close();
    this.ta.removeEventListener("input", this.onInput);
    this.input?.detach();
    this.input = null;
    this.ta.removeEventListener("keydown", this.onKeyDown, true);
    this.ta.removeEventListener("blur", this.onBlur);
    for (const off of this.vaultListeners) off();
    this.vaultListeners = [];
  }

  // ---------- Index build ----------

  private buildIndex(): void {
    if (this.indexBuilt) return;
    // 0.73.3: include every TFile in the vault — images, PDFs,
    // audio, attachments, etc. — so the link autocomplete isn't
    // limited to markdown. 0.79.12: include ALL extensions (the link
    // builder is the filesystem-alternative's "link to anything"), but
    // exclude the _archive graveyard (import originals you don't link
    // to). Markdown files insert as [[Title]] (basename only);
    // everything else uses [[name.ext]] because Obsidian only resolves
    // non-md wikilinks WITH the extension.
    // 0.79.14: exclude the _archive graveyard + plugin-internal formats
    // (.edtz), and — when enabled — anything in Obsidian's own "Excluded
    // files" list so exclusions are managed in one place.
    const inherit = getSettings().inheritObsidianExclusions;
    const ignoreFilters = inherit
      ? ((this.app.vault as any).getConfig?.("userIgnoreFilters") as string[] | undefined)
      : undefined;
    this.fileIndex = this.app.vault.getFiles()
      .filter((f) => !isArchivedPath(f.path)
        && !isIgnoredFileExtension(f.path)
        && !(inherit && matchesObsidianIgnore(f.path, ignoreFilters)))
      .flatMap((f) => {
        const isMd = f.extension === "md";
        const label = isMd ? f.basename : f.name;
        const insertText = isMd ? f.basename : f.name;
        const entries: FileIndexEntry[] = [{ label, lower: label.toLowerCase(), insertText, file: f }];
        // 0.209.0: index Obsidian's frontmatter aliases too, so a note filed as
        // "Architecture Decision 7" is reachable by typing "ADR-7". Each alias is
        // its OWN suggestion (same as Obsidian's own link autocomplete) rather
        // than being folded into the note's haystack, so the list shows which
        // name actually matched. Accepting one inserts [[Real Name|Alias]] — the
        // link resolves by the real name while reading as the alias.
        if (isMd) {
          for (const a of frontmatterAliases(this.app, f)) {
            entries.push({ label: a, lower: a.toLowerCase(), insertText, file: f, alias: a });
          }
        }
        return entries;
      });
    const tagsRecord = (this.app.metadataCache as any).getTags?.() ?? {};
    this.tagIndex = Object.keys(tagsRecord).sort((a, b) =>
      (tagsRecord[b] || 0) - (tagsRecord[a] || 0)
    );
    this.indexBuilt = true;
  }

  // ---------- Trigger detection ----------

  /** Inspect the substring ending at the caret. Return the active
   *  trigger, or null if no popup should be open. */
  private detectTrigger(): AutocompleteState | null {
    const value = this.ta.value;
    const caret = this.ta.selectionStart;
    if (caret == null) return null;
    const before = value.slice(0, caret);

    // Wikilink: [[ followed by query (no closing ]] before the caret, no newline).
    const linkMatch = before.match(/\[\[([^\]\[\n]*)$/);
    if (linkMatch) {
      const query = linkMatch[1];
      // 0.199.2: when the caret sits INSIDE an existing link ("[[fo|o]]", or
      // right before an auto-paired "]]"), extend the replacement over the
      // remainder + its closing brackets. Without this, accepting a suggestion
      // left the old tail behind: "[[Fixed]]o]]" — the four-brackets bug.
      const rest = value.slice(caret).match(/^([^\]\[\n]*)\]\]/);
      const replaceEnd = rest ? caret + rest[1].length + 2 : caret;
      // 0.199.2: `[[@` hands over to the date trigger so a date can be
      // inserted AS a link — the query after `@` resolves via NLD, and every
      // insert (date or note) is a wikilink because the user is typing one.
      if (query.startsWith("@")) {
        return {
          kind: "at",
          query: query.slice(1),
          replaceStart: caret - query.length - 2,
          replaceEnd,
          inLink: true,
        };
      }
      // 0.209.0: split on the FIRST pipe so `[[target|alias` searches on the
      // target and keeps the alias. Without this the whole string went into the
      // matcher, no note contains a "|", and typing an alias link killed the
      // suggestions at the moment you pressed `|`.
      const pipeIdx = query.indexOf("|");
      return {
        kind: "link",
        query: pipeIdx >= 0 ? query.slice(0, pipeIdx) : query,
        // null = user never typed a pipe; "" = typed it but hasn't typed the
        // alias yet. The two insert differently, so they can't be collapsed.
        aliasPart: pipeIdx >= 0 ? query.slice(pipeIdx + 1) : null,
        replaceStart: caret - query.length - 2,
        replaceEnd,
      };
    }

    // Tag: # followed by tag chars, preceded by start-of-line/whitespace.
    // Require at least one character after the # — opening the popup the
    // moment the bare # is typed flooded it with the entire tag list and
    // (mysteriously) seemed to coincide with the textarea losing focus.
    const tagMatch = before.match(/(^|\s)#([A-Za-z0-9_/\-]+)$/);
    if (tagMatch) {
      const query = tagMatch[2];
      return {
        kind: "tag",
        query,
        replaceStart: caret - query.length - 1, // include the `#`
        replaceEnd: caret,
      };
    }

    // @-mention: `@` (preceded by start-of-line/whitespace) then an optional
    // query that MAY contain spaces (natural-language dates like "next friday").
    // Bounded to a single line, ≤ 24 chars, and stops at `@`/`[`/`#` so those
    // triggers take over. The 24-char cap matters: chrono (via NLD) will still
    // extract "today" from a whole sentence, so without a tight bound the popup
    // would linger and Enter would insert a date instead of a newline. 24 chars
    // covers the longest real date phrases ("the day after tomorrow" = 22) while
    // auto-closing the moment the query outgrows one. The bare `@` opens
    // immediately (NLD-style); the popup self-closes once the query matches
    // neither a date nor any note.
    // 0.254.0: slash commands. `/` at the very start of a line (not merely
    // after any whitespace) then an optional query. Start-of-line is the
    // deliberate restriction: `/` is ordinary text mid-sentence — dates,
    // paths, and/or — and a popup that appeared on every one of those would
    // be a nuisance rather than a feature. Bounded to 32 chars so a long
    // path-ish line closes the popup instead of leaving it hanging.
    const slashMatch = getSettings().slashCommands
      ? before.match(/(?:^|\n)\/([^\n]{0,32})$/)
      : null;
    if (slashMatch) {
      const query = slashMatch[1];
      return {
        kind: "command",
        query,
        replaceStart: caret - query.length - 1, // include the `/`
        replaceEnd: caret,
      };
    }

    const atMatch = before.match(/(^|\s)@([^\n@[#]{0,24})$/);
    if (atMatch) {
      const query = atMatch[2];
      return {
        kind: "at",
        query,
        replaceStart: caret - query.length - 1, // include the `@`
        replaceEnd: caret,
      };
    }

    // 0.284.0: highlight color. An opening `==` (not part of `===`) followed by
    // a single-token color-name query opens the color menu. The query excludes
    // spaces/newlines/`=`, so the menu lives only while typing that one word and
    // closes the moment you type past it (Sift finds no color → empty → closed)
    // — that's the "dismiss if no match" behavior. Skipped once a color emoji is
    // already present right after the `==` (the color is chosen; don't reopen).
    // Only the query is replaced on accept, so the emoji lands right after `==`.
    const hlMatch = before.match(/(?<!=)==([^=\s\n]{0,24})$/);
    if (hlMatch && !takeLeadingColor(hlMatch[1])) {
      const query = hlMatch[1];
      return {
        kind: "highlight",
        query,
        replaceStart: caret - query.length,
        replaceEnd: caret,
      };
    }

    return null;
  }

  /** Resolve a natural-language date via a Natural Language Dates plugin's
   *  public `parseDate` API. Supports both the original `nldates-obsidian` and
   *  the modern `nldates-redux` fork — both expose the same
   *  `parseDate(text) → { moment, formattedString }` shape, and formattedString
   *  already honours that plugin's date format + link settings. Returns the
   *  formatted string, or null if neither plugin is installed or the text
   *  doesn't parse as a date. Fully defensive — a missing/changed API just
   *  disables date suggestions, never throws. */
  private nldParse(input: string): string | null {
    return this.nldResolve(input)?.formatted ?? null;
  }

  /** Like nldParse, but also reports whether the NLD plugin's own
   *  "add dates as link" autosuggest setting is on — so `@today` in the
   *  composer inserts the same thing NLD's editor suggest would
   *  (0.199.2: inherit that setting instead of always inserting plain text). */
  private nldResolve(input: string): { formatted: string; asLink: boolean } | null {
    const text = input.trim();
    if (!text) return null;
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins ?? {};
    for (const id of ["nldates-obsidian", "nldates-redux"]) {
      const nld = plugins[id] as
        | {
            parseDate?: (s: string) => { moment?: { isValid?: () => boolean }; formattedString?: string } | null;
            settings?: { autosuggestToggleLink?: unknown };
          }
        | undefined;
      if (!nld || typeof nld.parseDate !== "function") continue;
      try {
        const res = nld.parseDate(text);
        if (!res) continue;
        const valid = res.moment && typeof res.moment.isValid === "function"
          ? res.moment.isValid()
          : !!res.formattedString && res.formattedString !== "Invalid date";
        if (valid && res.formattedString) {
          return { formatted: res.formattedString, asLink: nld.settings?.autosuggestToggleLink === true };
        }
      } catch {
        // try the next candidate plugin
      }
    }
    return null;
  }

  /** Resolve one of the catalogue's fixed-offset phrases without any plugin.
   *  Uses the core Templates plugin's date format when the user has set one,
   *  so a built-in preview reads the same as the rest of their vault, and
   *  falls back to ISO. Null for phrases whose offset isn't fixed — those need
   *  a real parser, and NLD is asked first anyway. */
  private builtinDate(days: number | null): string | null {
    if (days === null) return null;
    const fmt = getTemplatesFormats(this.app)?.dateFormat || "YYYY-MM-DD";
    try { return momentFn().add(days, "days").format(fmt); } catch { return null; }
  }

  /** Date preview for a catalogue phrase: NLD if it's installed (it honours
   *  the user's NLD format + link settings), otherwise the built-in offset. */
  private resolvePhrase(phrase: string, days: number | null):
    { formatted: string; asLink: boolean } | null {
    const viaNld = this.nldResolve(phrase);
    if (viaNld) return viaNld;
    const built = this.builtinDate(days);
    return built ? { formatted: built, asLink: false } : null;
  }

  /** Stashpad commands offered by the `/` trigger, Sift-matched against the
   *  query. Built from Obsidian's command registry exactly as the Stashpad
   *  command palette does (`stashpad:` prefix, "Stashpad: " label stripped),
   *  so a new command shows up here for free with no second catalogue to
   *  maintain.
   *
   *  A few are held back — see SLASH_EXCLUDED. */
  private commandItems(query: string): SuggestItem[] {
    const registry: Record<string, { name?: string }> =
      (this.app as unknown as { commands?: { commands?: Record<string, { name?: string }> } })
        .commands?.commands ?? {};
    const run = (id: string) => (): void => {
      (this.app as unknown as { commands?: { executeCommandById?: (i: string) => void } })
        .commands?.executeCommandById?.(id);
    };
    return Object.keys(registry)
      .filter((id) => id.startsWith("stashpad:") && !SLASH_EXCLUDED.has(id))
      .map((id) => ({ id, name: (registry[id]?.name ?? id).replace(/^(?:\s*Stashpad:\s*)+/i, "").trim() }))
      .filter((c) => siftMatch(query, c.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40)
      .map((c) => ({ label: `⚡ ${c.name}`, insert: "", subtitle: "", run: run(c.id) }));
  }

  // ---------- Suggest generation ----------

  private buildItems(state: AutocompleteState): SuggestItem[] {
    // 0.284.0: highlight colors — a fixed, tiny palette; no file index needed.
    // Sift-match the color NAME so `gr`→Green, `blue`→Blue, empty→all. Accepting
    // inserts just the emoji (Default inserts nothing — a plain highlight),
    // right after the `==`, leaving the caret ready to type the highlight text.
    if (state.kind === "highlight") {
      const q = state.query.toLowerCase().trim();
      return HIGHLIGHT_COLORS
        .filter((c) => siftMatch(q, c.name))
        .map((c) => ({
          label: `${c.emoji || "⬜"} ${c.name}`,
          insert: c.emoji,
          subtitle: c.emoji ? "" : "plain highlight",
        }));
    }
    this.buildIndex();
    const q = state.query.toLowerCase().trim();
    // All-tokens-match: split the query on whitespace; every token must
    // appear (anywhere, in any order) in the candidate. So "B and A"
    // matches a file titled "A and B". Empty query returns everything.
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    const matchesAll = (haystack: string): boolean => {
      if (!tokens.length) return true;
      for (const t of tokens) if (!haystack.includes(t)) return false;
      return true;
    };
    // Note-link candidates (used by both the `[[` and `@` triggers). Markdown
    // notes insert as [[basename]]; non-md files keep their extension because
    // Obsidian only resolves [[image.png]] WITH the ext.
    const typedAlias = state.kind === "link" ? state.aliasPart ?? null : null;
    const fileMatches = (limit: number): SuggestItem[] => this.fileIndex
      .filter((f) => matchesAll(f.lower))
      .slice(0, limit)
      .map((f) => {
        // What the user typed after `|` wins; otherwise an alias ROW carries its
        // own alias, so picking "ADR-7" writes [[Architecture Decision 7|ADR-7]]
        // — resolves by real name, reads as the alias.
        const alias = typedAlias !== null ? typedAlias : f.alias ?? null;
        if (alias === null) {
          return { label: f.label, insert: `[[${f.insertText}]]`, subtitle: f.file.path };
        }
        if (alias === "") {
          // Pipe typed but no alias yet: leave the caret between | and ]] so the
          // user just keeps typing, instead of landing after the brackets.
          return { label: f.label, insert: `[[${f.insertText}|]]`, subtitle: f.file.path, caretBack: 2 };
        }
        return {
          label: f.alias ? f.label : `${f.label} | ${alias}`,
          insert: `[[${f.insertText}|${alias}]]`,
          subtitle: f.alias ? `${f.insertText} · ${f.file.path}` : f.file.path,
        };
      });

    if (state.kind === "link") {
      // 0.73.3: cap bumped 30 → 50 now that the index includes every file type.
      return fileMatches(50);
    }
    if (state.kind === "command") {
      return this.commandItems(q);
    }
    if (state.kind === "tag") {
      // Tag autocomplete: same all-tokens rule, against the pre-sorted (by
      // usage count) tag list.
      return this.tagIndex
        .filter((t) => matchesAll(t.toLowerCase()))
        .slice(0, 30)
        .map((t) => ({ label: t, insert: t, subtitle: "" }));
    }
    // 0.186.0: unified `@` — natural-language dates (via NLD) blended with
    // note links. Dates rank first so Enter on `@today` inserts the date.
    const dateItems: SuggestItem[] = [];
    // 0.199.2: a date inserts as a wikilink when the trigger sits inside `[[`
    // (the user is typing a link), or when NLD's own "add dates as link"
    // setting is on — inherited so `@today` matches what NLD would insert.
    const dateInsert = (r: { formatted: string; asLink: boolean }): string =>
      state.inLink || r.asLink ? `[[${r.formatted}]]` : r.formatted;
    // 0.254.0: the catalogue is what makes a HALF-TYPED phrase previewable.
    // Parsing the raw query only ever resolved a complete phrase, so `@yest`
    // showed nothing and you had to finish the word on faith. Now the query is
    // matched against the phrase list and each hit is shown with the date it
    // resolves to, so you can read the answer before committing to it.
    const seenPhrases = new Set<string>();
    const pushPhrase = (phrase: string, r: { formatted: string; asLink: boolean }): void => {
      if (seenPhrases.has(phrase)) return;
      seenPhrases.add(phrase);
      dateItems.push({ label: `📅 ${phrase}`, insert: dateInsert(r), subtitle: `→ ${r.formatted}` });
    };
    // An exact parse of what the user actually typed always ranks first — it
    // covers everything the catalogue can't ("3rd of next month", "in 45 min").
    if (q !== "") {
      const exact = this.nldResolve(state.query);
      if (exact) pushPhrase(state.query.trim(), exact);
    }
    // Then catalogue phrases the query is a prefix of (bare `@` shows the head
    // of the list). Prefix, not all-tokens: typing `t` should suggest "today"
    // and "tomorrow", not every phrase containing a `t`.
    const phraseLimit = q === "" ? 4 : 8;
    for (const { phrase, days } of DATE_PHRASES) {
      if (dateItems.length >= phraseLimit) break;
      if (q !== "" && !phrase.startsWith(q)) continue;
      const r = this.resolvePhrase(phrase, days);
      if (r) pushPhrase(phrase, r);
    }
    // On a bare `@` with date suggestions present, keep the list tight (dates
    // only); otherwise blend in note matches so `@name` still links a note.
    const noteItems = q === ""
      ? (dateItems.length ? [] : fileMatches(15))
      : fileMatches(30);
    return [...dateItems, ...noteItems];
  }

  // ---------- Event handlers ----------

  private onInput = (): void => {
    const state = this.detectTrigger();
    if (!state) { this.close(); return; }
    this.openFor(state);
  };

  private onBlur = (): void => {
    // Defer slightly so a click on a popup item still registers before
    // the popup is removed by blur.
    setTimeout(() => this.close(), 120);
  };

  private onDocEscape = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (!this.state || !this.items.length) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    this.close();
  };

  /** 0.209.8: claim Mod+A for this text field at DOCUMENT CAPTURE.
   *
   *  Another plugin registering a document-level select-all listener was
   *  swallowing Mod+A while typing in Stashpad, so the user got that plugin's
   *  behaviour instead of selecting their own text. Selecting all NOTES in the
   *  list was unaffected, which is the tell: the list path is Stashpad's own
   *  keybinding, while in a text field the keystroke was going to whoever got
   *  there first.
   *
   *  0.209.7 tried an Obsidian Scope. That was not enough on its own: this class
   *  pushes its OWN Scope (parented to app.scope, not to the view's), so while
   *  the suggestion popup is up the view's scope is not in the chain at all.
   *  Capture phase is the pattern this file already proves works — see
   *  onDocEscape, added for exactly this class of race against Obsidian's own
   *  workspace handler.
   *
   *  Only acts when the event targets OUR textarea, so it cannot affect typing
   *  anywhere else in Obsidian. stopImmediatePropagation is what actually denies
   *  a competing document listener, capture or bubble. */
  private onDocSelectAll = (e: KeyboardEvent): void => {
    if (e.key?.toLowerCase() !== "a") return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.target !== this.ta) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    try { this.ta.select(); } catch { /* detached */ }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.state || !this.items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.activeIdx = (this.activeIdx + 1) % this.items.length;
      this.refreshActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.activeIdx = (this.activeIdx - 1 + this.items.length) % this.items.length;
      this.refreshActive();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.commit();
    } else if (e.key === " " && this.state.kind === "tag") {
      // Space completes a tag (tags can't contain spaces, so the space that
      // would end the tag doubles as "accept the highlighted suggestion").
      // NOT for links / @ (those legitimately contain spaces). Guard: only
      // complete when the highlighted tag actually STARTS WITH what's typed —
      // otherwise a mere substring match would hijack a brand-new tag the user
      // is typing (e.g. typing `#foo` when only `#barfoo` exists). The inserted
      // tag keeps the space so typing flows on.
      const active = this.items[this.activeIdx];
      const typed = "#" + this.state.query.toLowerCase();
      if (active && active.insert.toLowerCase().startsWith(typed)) {
        e.preventDefault();
        e.stopPropagation();
        this.commit(" ");
      } else {
        this.close(); // new tag the user is typing — let the space through
      }
    } else if (e.key === "Escape") {
      // stopImmediatePropagation beats Obsidian's workspace-level
      // Escape handler (which would otherwise refocus another tab).
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.close();
    }
  };

  // ---------- Popup rendering ----------

  private openFor(state: AutocompleteState): void {
    this.state = state;
    this.items = this.buildItems(state);
    this.activeIdx = 0;
    if (!this.items.length) { this.close(); return; }
    this.renderPopup();
    this.pushScope();
  }

  /** Push an Obsidian keymap Scope that consumes Escape so the
   *  workspace's "Escape returns to last leaf" handler doesn't fire.
   *  DOM-level stopPropagation isn't enough — Obsidian routes Escape
   *  through its keymap before bubble-phase listeners run. */
  private pushScope(): void {
    if (this.scope) return;
    const scope = new Scope((this.app as any).scope);
    scope.register([], "Escape", (e) => {
      e.preventDefault();
      this.close();
      return false; // mark handled, stop further keymap dispatch
    });
    this.scope = scope;
    (this.app as any).keymap?.pushScope(scope);
  }

  private popScope(): void {
    if (!this.scope) return;
    try { (this.app as any).keymap?.popScope(this.scope); } catch { /* ignore */ }
    this.scope = null;
  }

  private renderPopup(): void {
    if (!this.popupEl) {
      // Use the textarea's own document so the popup lands in the same
      // window — Obsidian secondary windows have their own document, and
      // a plain `document.body` always points at the main window.
      const doc = this.ta.ownerDocument ?? document;
      this.popupEl = doc.body.createDiv({ cls: "stashpad-composer-suggest" });
      // Make sure clicking anywhere on the popup chrome doesn't steal
      // focus from the textarea — we'd lose the caret position and the
      // input handler context.
      this.popupEl.tabIndex = -1;
      this.popupEl.addEventListener("mousedown", (e) => e.preventDefault());
    }
    const pop = this.popupEl;
    pop.empty();
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const row = pop.createDiv({ cls: "stashpad-composer-suggest-row" });
      if (i === this.activeIdx) row.addClass("is-active");
      row.createSpan({ cls: "stashpad-composer-suggest-label", text: it.label });
      if (it.subtitle) row.createSpan({ cls: "stashpad-composer-suggest-sub", text: it.subtitle });
      // Mousedown (not click) so the textarea blur fires AFTER our handler.
      row.onmousedown = (e) => {
        e.preventDefault();
        this.activeIdx = i;
        this.commit();
      };
    }
    this.position();
  }

  private refreshActive(): void {
    if (!this.popupEl) return;
    const rows = this.popupEl.children;
    for (let i = 0; i < rows.length; i++) {
      (rows[i] as HTMLElement).toggleClass("is-active", i === this.activeIdx);
    }
    // Scroll the active row into view inside the popup (long lists).
    const active = rows[this.activeIdx] as HTMLElement | undefined;
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    if (!this.popupEl) return;
    const r = this.ta.getBoundingClientRect();
    // Anchor to the textarea's top-left, drop the popup just above the
    // textarea so it doesn't get clipped by the composer's bottom edge.
    const popH = this.popupEl.offsetHeight || 200;
    const top = r.top - popH - 4;
    const left = r.left;
    this.popupEl.style.left = `${Math.max(8, left)}px`;
    this.popupEl.style.top = `${Math.max(8, top)}px`;
    this.popupEl.style.minWidth = `${Math.min(360, r.width)}px`;
  }

  private commit(trailing = ""): void {
    if (!this.state || !this.items.length) return;
    const item = this.items[this.activeIdx];
    if (!item) return;
    const before = this.ta.value.slice(0, this.state.replaceStart);
    const after = this.ta.value.slice(this.state.replaceEnd);
    // 0.254.0: a slash-command row runs instead of inserting. The trigger text
    // goes first and the popup closes BEFORE the command fires — commands open
    // modals and move focus, and leaving a stale popup (or a stray "/delete")
    // behind while one of those runs is how this feature would feel broken.
    if (item.run) {
      this.ta.value = before + after;
      const caret = before.length;
      this.ta.setSelectionRange(caret, caret);
      this.ta.dispatchEvent(new Event("input", { bubbles: true }));
      try { this.onBeforeCommand?.(this.ta.value); } catch { /* never block the command */ }
      const run = item.run;
      this.close();
      run();
      return;
    }
    const insert = item.insert + trailing;
    this.ta.value = before + insert + after;
    const caret = before.length + insert.length - (trailing ? 0 : item.caretBack ?? 0);
    this.ta.setSelectionRange(caret, caret);
    // Fire input so the composer's draft-save and any other listeners catch up.
    this.ta.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
    this.ta.focus();
  }

  private close(): void {
    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
    this.state = null;
    this.items = [];
    this.activeIdx = 0;
    this.popScope();
  }
}

interface SuggestItem {
  /** Characters to walk the caret BACK from the end of the inserted text.
   *  Used for the alias slot, so `[[Note|]]` leaves you inside the pipe. */
  caretBack?: number;
  label: string;
  insert: string;
  subtitle: string;
  /** 0.254.0: slash-command rows ACT instead of inserting. When present, the
   *  trigger text is removed and this runs; `insert` is ignored. */
  run?: () => void;
}

interface AutocompleteState {
  kind: "tag" | "link" | "at" | "command" | "highlight";
  /** 0.199.2: the trigger sits inside `[[ ]]` — every insert must be a link. */
  inLink?: boolean;
  query: string;
  /** Inclusive start index of the trigger (for replacement). For "[[foo"
   *  this points at the first `[`; for "#foo" at the `#`. */
  aliasPart?: string | null;
  replaceStart: number;
  /** Exclusive end index (the caret). */
  replaceEnd: number;
}
