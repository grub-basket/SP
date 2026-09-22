import { parseNaturalDate, naturalDatePhrases, formatNaturalDate } from "./natural-date";
import { App, Platform, Scope, TFile, moment } from "obsidian";
import { isArchivedPath, isIgnoredFileExtension, matchesObsidianIgnore, siftMatch } from "./types";
import { isUnderAnyConfigFolder } from "./config-layout";
import { HIGHLIGHT_COLORS, takeLeadingColor } from "./highlight-colors";
import { getSettings, getTemplatesFormats } from "./settings";
import { expandSnippet } from "./snippets";
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

/** 0.319.0: the `@` date catalogue now comes from natural-date.ts
 *  (naturalDatePhrases) and EVERY phrase — and anything the user types — resolves
 *  through parseNaturalDate, so "@tuesday" / "@last tuesday" / "@in 3 weeks" /
 *  "@sep 12 at 3pm" work without the Natural Language Dates plugin. NLD is still
 *  asked first when installed (it honours that plugin's format + link settings). */

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
  /** 0.350.0: true when the tag list shown is a browsable FALLBACK (the query
   *  matched nothing) rather than real matches — commit is suppressed so it can't
   *  hijack a brand-new tag the user is typing. */
  private tagListIsFallback = false;
  /** 0.353.0: tears down the mobile "reveal when the keyboard settles" timers +
   *  listeners; set while a popup is waiting to be revealed, cleared on reveal/close. */
  private mobileRevealCleanup: (() => void) | null = null;
  /** 0.357.0: timestamp of the textarea's last focus (see the focus listener). */
  private lastFocusAt = 0;
  private onFocusTs = (): void => { this.lastFocusAt = Date.now(); };
  /** 0.363.3: the largest visualViewport height seen = the keyboard-DOWN height.
   *  In Obsidian's mobile webview `window.innerHeight` shrinks WITH the keyboard,
   *  so `innerHeight - vv.height` is ~0 whether the keyboard is up or down — a
   *  useless signal (it made 0.363.2 treat the keyboard as always-down). Comparing
   *  the current vv.height to its own historical max is reliable: keyboard up ⇒
   *  vv.height well below the max. Seeded/kept current by the vv resize listener. */
  private maxVvHeight = 0;
  private onVvResize = (): void => {
    const vv = (this.ta.ownerDocument?.defaultView ?? window).visualViewport;
    if (vv && vv.height > this.maxVvHeight) this.maxVvHeight = vv.height;
  };
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
    /** 0.471.0: the typed `>` destination trigger. `list()` returns the EXISTING
     *  Stashpad folders (path + display name + optional icon) to offer — there is
     *  no create path, so `>` can never make a new folder — and `set(folder)`
     *  routes the next send there (same effect as the destination menu/picker).
     *  Null disables the `>` trigger entirely. */
    private destinations: {
      list: () => Array<{ folder: string; name: string }>;
      set: (folder: string) => void;
    } | null = null,
  ) {}

  attach(): void {
    this.ta.addEventListener("input", this.onInput);
    // 0.357.0: track when the textarea last GAINED focus, so the mobile
    // reveal-delay only kicks in when the keyboard is actually rising (a toolbar
    // `[[`/`#` button just focused it) — not when you're already typing with the
    // keyboard up (e.g. `#tag`), where the popup should appear immediately.
    this.ta.addEventListener("focus", this.onFocusTs);
    this.vaultListeners.push(() => this.ta.removeEventListener("focus", this.onFocusTs));
    // 0.363.3: track the max visualViewport height (keyboard-down height) so
    // openFor() can tell keyboard-up from keyboard-down reliably. Seed it now.
    const vv0 = (this.ta.ownerDocument?.defaultView ?? window).visualViewport;
    if (vv0) {
      this.maxVvHeight = vv0.height;
      vv0.addEventListener("resize", this.onVvResize);
      this.vaultListeners.push(() => vv0.removeEventListener("resize", this.onVvResize));
    }
    // 0.202.0: the Markdown editing behaviors (autopair, wrap, list
    // continuation, Tab indent, double-click trim) live in their own layer —
    // attached here so EVERY surface that gets suggestions also gets them.
    this.input = new MarkdownInput(this.app, this.ta, this.inputOpts);
    this.input.attach();
    this.ta.addEventListener("keydown", this.onKeyDown, true);
    // 0.323.0: parity with Obsidian's link editing — the wikilink suggester
    // reopens when the caret LANDS inside an existing `[[link]]` via click or
    // arrow key, not only when you type. So changing an existing link is
    // "click inside it → pick a new target", exactly like the CodeMirror editor.
    this.ta.addEventListener("keyup", this.onCaretMove);
    this.ta.addEventListener("click", this.onCaretMove);
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
    // 0.337.2: keep the popup anchored to the textarea when the layout shifts —
    // above all the MOBILE keyboard revealing (pressing the toolbar's `[[`/`#`
    // button focuses the textarea, which raises the keyboard and moves the
    // composer up, but the popup was staying put and covering it). visualViewport
    // fires resize/scroll through the whole keyboard animation, so re-positioning
    // on each event lands the popup correctly; window resize covers desktop.
    const win = this.ta.ownerDocument?.defaultView ?? window;
    const vv = win.visualViewport;
    if (vv) {
      vv.addEventListener("resize", this.reposition);
      vv.addEventListener("scroll", this.reposition);
      this.vaultListeners.push(() => vv.removeEventListener("resize", this.reposition));
      this.vaultListeners.push(() => vv.removeEventListener("scroll", this.reposition));
    }
    win.addEventListener("resize", this.reposition);
    this.vaultListeners.push(() => win.removeEventListener("resize", this.reposition));
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

  /** 0.403.0: public dismiss — close the suggestion popover WITHOUT tearing down
   *  the autocomplete (unlike detach). Called on send so a lingering popover
   *  (e.g. a new tag with no match) doesn't stay open over the emptied composer. */
  dismiss(): void { this.close(); }

  detach(): void {
    this.close();
    this.ta.removeEventListener("input", this.onInput);
    this.input?.detach();
    this.input = null;
    this.ta.removeEventListener("keydown", this.onKeyDown, true);
    this.ta.removeEventListener("keyup", this.onCaretMove);
    this.ta.removeEventListener("click", this.onCaretMove);
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
    const cfgSettings = getSettings(); // 0.378.0/0.379.0: never index the config folder(s) — primary + mirrors
    const configPaths = [cfgSettings.configFolder || null, ...(Array.isArray(cfgSettings.configMirrors) ? cfgSettings.configMirrors : [])];
    this.fileIndex = this.app.vault.getFiles()
      .filter((f) => !isArchivedPath(f.path)
        && !isIgnoredFileExtension(f.path)
        && !isUnderAnyConfigFolder(f.path, configPaths)
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
    // 0.350.0: the BARE `#` shows the list again (a browsable full list), but the
    // list no longer TAKES OVER — a following space/Enter on a bare `#` (or on a
    // brand-new tag with no match) is let through, so `# ` still starts a Markdown
    // heading (see onKeyDown). The `(^|\s)` guard keeps `C#`/`issue#5` mid-word out.
    const tagMatch = before.match(/(^|\s)#([A-Za-z0-9_/\-]*)$/);
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
    // 0.254.0: slash commands. `/` then an optional query.
    // 0.471.0: fires at ANY word boundary (start-of-line OR after whitespace),
    // not just start-of-line — same rule as `#` and `@`. The `(?:^|\s)` guard is
    // what keeps ordinary mid-word `/` out (URLs `http://`, `and/or`, `24/7`,
    // `9/22` all have no space before the slash, so none of them trigger); only a
    // `/` a user deliberately starts a token with does. Bounded to 32 chars so a
    // long path-ish run closes the popup instead of leaving it hanging.
    const slashMatch = getSettings().slashCommands
      ? before.match(/(?:^|\s)\/([^\n]{0,32})$/)
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

    // 0.471.0: destination trigger. `>` (at a word boundary) then a folder query,
    // routing the next send into an EXISTING Stashpad folder — no folder is ever
    // created. The char right after `>` must be non-space, so `> quote` (Markdown
    // blockquote, space after `>`) and a bare `>` never open the popup; only
    // `>name` does. The query MAY contain spaces (folders like "Bases Toolbox")
    // and self-closes when it matches no folder, so a `>word` that isn't a folder
    // just stays literal text. Gated on the API being wired.
    const destMatch = this.destinations
      ? before.match(/(?:^|\s)>([^\s\n][^\n]{0,32})$/)
      : null;
    if (destMatch) {
      const query = destMatch[1];
      return {
        kind: "dest",
        query,
        replaceStart: caret - query.length - 1, // include the `>`
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

  /** 0.319.0: resolve ANY phrase with the built-in parser. Uses the core
   *  Templates plugin's date (+ time) format when the user has set one, so a
   *  preview reads the same as the rest of their vault; ISO otherwise. */
  private builtinDate(phrase: string): string | null {
    const r = parseNaturalDate(phrase, { prefer: "future" });
    if (!r) return null;
    const fmts = getTemplatesFormats(this.app);
    if (!fmts) return formatNaturalDate(r);
    try {
      const m = momentFn(r.ms) as unknown as { format: (f: string) => string };
      return r.hasTime ? `${m.format(fmts.dateFormat)} ${m.format(fmts.timeFormat || "HH:mm")}` : m.format(fmts.dateFormat);
    } catch { return formatNaturalDate(r); }
  }

  /** Date preview for a phrase: NLD if it's installed (it honours the user's
   *  NLD format + link settings), otherwise the built-in parser. */
  private resolvePhrase(phrase: string): { formatted: string; asLink: boolean } | null {
    const viaNld = this.nldResolve(phrase);
    if (viaNld) return viaNld;
    const built = this.builtinDate(phrase);
    return built ? { formatted: built, asLink: false } : null;
  }

  /** Stashpad commands offered by the `/` trigger, Sift-matched against the
   *  query. Built from Obsidian's command registry exactly as the Stashpad
   *  command palette does (`stashpad:` prefix, "Stashpad: " label stripped),
   *  so a new command shows up here for free with no second catalogue to
   *  maintain.
   *
   *  A few are held back — see SLASH_EXCLUDED. */
  /** 0.334.0: saved-view suggestions for the `[[` / `@` menus. Picking one
   *  inserts a markdown deep link `[name](obsidian://stashpad?view=name)` — which
   *  renders clickable (0.331.0) and opens that saved view (0.334.0 handler). */
  private savedViewItems(query: string): SuggestItem[] {
    const views = ((getSettings() as { savedViews?: Array<{ name?: unknown }> }).savedViews ?? [])
      .filter((v): v is { name: string } => !!v && typeof v.name === "string" && v.name.length > 0);
    if (!views.length) return [];
    const matched = query ? views.filter((v) => siftMatch(query, v.name)) : views;
    return matched.slice(0, 8).map((v) => ({
      label: `\u{1F441} ${v.name}`,
      insert: `[${v.name}](obsidian://stashpad?view=${encodeURIComponent(v.name)})`,
      subtitle: "saved view",
    }));
  }

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
      // 0.334.0: saved views head the `[[` menu — picking one inserts a deep link
      // that opens that view (clickable in rendered notes). Then note matches.
      // 0.73.3: cap bumped 30 → 50 now that the index includes every file type.
      return [...this.savedViewItems(q), ...fileMatches(50)];
    }
    if (state.kind === "command") {
      return this.commandItems(q);
    }
    if (state.kind === "tag") {
      // Tag autocomplete: same all-tokens rule, against the pre-sorted (by
      // usage count) tag list. 0.350.0: when the query matches NOTHING, fall back
      // to the full list (top 30 by usage) so the popup stays a browsable list
      // instead of vanishing — flagged as fallback so it doesn't auto-commit.
      const matched = this.tagIndex.filter((t) => matchesAll(t.toLowerCase())).slice(0, 30);
      this.tagListIsFallback = state.query !== "" && matched.length === 0;
      const list = this.tagListIsFallback ? this.tagIndex.slice(0, 30) : matched;
      return list.map((t) => ({ label: t, insert: t, subtitle: "" }));
    }
    if (state.kind === "dest") {
      // 0.471.0: existing Stashpad folders, Sift-matched on the display name (and
      // path, so a nested folder is reachable by its parent). Picking one REMOVES
      // the `>query` and routes the next send — it never inserts text and never
      // creates a folder. No fallback list: an empty result closes the popup, so
      // a `>word` that isn't a folder is left as plain text.
      const folders = this.destinations?.list() ?? [];
      return folders
        .filter((f) => matchesAll(f.name.toLowerCase()) || matchesAll(f.folder.toLowerCase()))
        .slice(0, 30)
        .map((f) => ({
          label: f.name,
          insert: "",
          subtitle: f.folder,
          run: () => this.destinations?.set(f.folder),
        }));
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
      const exact = this.resolvePhrase(state.query);
      if (exact) pushPhrase(state.query.trim(), exact);
    }
    // Then catalogue phrases the query is a prefix of (bare `@` shows the head
    // of the list). Prefix, not all-tokens: typing `t` should suggest "today"
    // and "tomorrow", not every phrase containing a `t`.
    const phraseLimit = q === "" ? 4 : 8;
    for (const phrase of naturalDatePhrases()) {
      if (dateItems.length >= phraseLimit) break;
      if (q !== "" && !phrase.startsWith(q)) continue;
      const r = this.resolvePhrase(phrase);
      if (r) pushPhrase(phrase, r);
    }
    // On a bare `@` with date suggestions present, keep the list tight (dates
    // only); otherwise blend in note matches so `@name` still links a note.
    const noteItems = q === ""
      ? (dateItems.length ? [] : fileMatches(15))
      : fileMatches(30);
    // 0.334.0: saved views appear here too, but only once you're typing — a bare
    // `@` should stay the tight date popup.
    const svItems = q === "" ? [] : this.savedViewItems(q);
    return [...svItems, ...dateItems, ...noteItems];
  }

  // ---------- Event handlers ----------

  private onInput = (): void => {
    // 0.338.0: espanso-style snippet auto-expand — when a snippet trigger is
    // committed by a following whitespace, replace it with the expanded value.
    if (this.tryExpandSnippet()) { this.close(); return; }
    // 0.406.0: a tag can't contain a space, so as soon as whitespace follows the
    // caret's token, dismiss the tag popover — robust on mobile, where the space
    // arrives as an input event without the keydown that normally closes it. Tags
    // only (links / @ legitimately contain spaces).
    if (this.state?.kind === "tag") {
      const caret = this.ta.selectionStart ?? this.ta.value.length;
      if (/\s/.test(this.ta.value[caret - 1] ?? "")) { this.close(); return; }
    }
    const state = this.detectTrigger();
    if (!state) { this.close(); return; }
    this.openFor(state);
  };

  /** Expand a snippet whose trigger was just committed by a trailing space/newline
   *  (so a trigger that is a prefix of a longer word isn't expanded prematurely).
   *  Returns true when an expansion happened. */
  private tryExpandSnippet(): boolean {
    // 0.346.0: skip deactivated snippets (enabled === false).
    const snippets = (getSettings().snippets ?? []).filter((s) => s.trigger && s.value && s.enabled !== false);
    if (!snippets.length) return false;
    const val = this.ta.value;
    const caret = this.ta.selectionStart ?? val.length;
    const before = val.slice(0, caret);
    const boundary = before[before.length - 1];
    if (!boundary || !/\s/.test(boundary)) return false; // commit only on whitespace
    const upto = before.slice(0, before.length - 1);
    for (const sn of snippets) {
      // 0.346.0: case-insensitive by default; exact match when caseSensitive.
      if (upto.length < sn.trigger.length) continue;
      const tail = upto.slice(upto.length - sn.trigger.length);
      const hit = sn.caseSensitive === true ? tail === sn.trigger : tail.toLowerCase() === sn.trigger.toLowerCase();
      if (!hit) continue;
      const prevCh = upto[upto.length - sn.trigger.length - 1];
      if (prevCh !== undefined && !/\s/.test(prevCh)) continue; // trigger must start at a boundary
      const start = upto.length - sn.trigger.length;
      const expanded = expandSnippet(this.app, sn.value, {});
      this.ta.value = val.slice(0, start) + expanded + boundary + val.slice(caret);
      const c = start + expanded.length + 1;
      this.ta.setSelectionRange(c, c);
      this.ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  /** 0.323.0: reopen the wikilink suggester when the caret MOVES into an
   *  existing `[[link]]` (click / Left / Right / Home / End) without any typing.
   *  Obsidian's EditorSuggest triggers on cursor change, so a link is edited by
   *  clicking inside it and picking a new target; matching that here gives the
   *  edit modal (and every shared surface) the same "live adjusting" feel.
   *
   *  Scoped to the `link` kind only — the typed triggers (`#`, `@`, `/`, `==`)
   *  stay input-driven so a stray click after a word doesn't flash a popup. And
   *  ArrowUp/Down are excluded so navigating an OPEN popup never re-searches it. */
  private onCaretMove = (e: Event): void => {
    // `e.type` rather than `instanceof KeyboardEvent`: a keyup from a popped-out
    // Obsidian window is an instance of THAT window's KeyboardEvent, so the
    // instanceof check would be false cross-realm and treat every keystroke's
    // keyup like a click (re-searching on each char). Type string is realm-safe.
    if (e.type === "keyup") {
      const k = (e as KeyboardEvent).key;
      if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "Home" && k !== "End") return;
    }
    const st = this.detectTrigger();
    if (st && st.kind === "link") {
      this.openFor(st);
    } else if (this.state && this.state.kind === "link") {
      // Caret left the link → dismiss the popup we opened from a caret move.
      this.close();
    }
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
      // 0.350.0: on a browsable FALLBACK tag list (query matched nothing) that the
      // user hasn't navigated, Enter/Tab must NOT insert an unrelated tag — keep
      // what they typed and close.
      if (this.state.kind === "tag" && this.tagListIsFallback && this.activeIdx === 0) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else {
        e.preventDefault();
        e.stopPropagation();
        this.commit();
      }
    } else if (e.key === " " && this.state.kind === "tag") {
      // Space completes a tag (tags can't contain spaces, so the space that
      // would end the tag doubles as "accept the highlighted suggestion").
      // NOT for links / @ (those legitimately contain spaces). Guards: only
      // complete when there's a real (non-empty, non-fallback) query AND the
      // highlighted tag STARTS WITH what's typed. So a bare `#` + space starts a
      // Markdown heading, and `#newtag` + space creates the new tag — neither is
      // hijacked. The inserted tag keeps the space so typing flows on.
      const active = this.items[this.activeIdx];
      const typed = "#" + this.state.query.toLowerCase();
      if (this.state.query !== "" && !this.tagListIsFallback && active && active.insert.toLowerCase().startsWith(typed)) {
        e.preventDefault();
        e.stopPropagation();
        this.commit(" ");
      } else {
        this.close(); // bare `#` (heading), new tag, or fallback — let the space through
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
    const win = this.ta.ownerDocument?.defaultView ?? window;
    // 0.353.0: on MOBILE, opening the popup often coincides with the keyboard
    // revealing (a toolbar `[[`/`#` button focuses the textarea) — positioning
    // against the mid-animation layout dropped the popup UNDER the keyboard. So
    // keep it hidden until the visual viewport settles (keyboard fully up), then
    // position once against the final layout and reveal. Desktop is unchanged: it
    // re-anchors a couple of times across any layout shift.
    // 0.363.2: hold-for-settle only when the KEYBOARD IS DOWN at open — because
    // that's when opening the popup (a toolbar button focusing the textarea) will
    // RAISE the keyboard and shift the layout under us. Keyboard state is read from
    // the visual viewport (keyboard down ⇒ viewport ≈ full window height), NOT from
    // focus recency: on iOS the keyboard can hide while the textarea stays focused,
    // so a stale focus age wrongly reported "keyboard already up" and revealed
    // instantly into a rising keyboard (the reported bug).
    const vv = win.visualViewport;
    if (vv && vv.height > this.maxVvHeight) this.maxVvHeight = vv.height;
    // 0.363.3: keyboard-down when the current viewport height is at (or near) its
    // max-seen height. vpGap here is the drop from the keyboard-down height, NOT
    // innerHeight - vv.height (which stays ~0 in Obsidian's mobile webview because
    // innerHeight tracks the keyboard). A >120px drop ⇒ keyboard is up.
    const vpGap = vv ? Math.round(this.maxVvHeight - vv.height) : 0;
    const keyboardDown = !!vv && vpGap < 120;
    // Only DELAY (wait for the keyboard to finish rising) when it's actually down
    // at open — i.e. opening the popup is what will raise it (a toolbar button
    // focusing the textarea). If the keyboard is already up (mid-typing), show now.
    // Requires a visualViewport: without one we can't watch the keyboard rise, so
    // delaying would just strand the popup until the hard cap — show instantly.
    const useDelay = Platform.isMobile && !!vv && keyboardDown;
    // Debug snapshot of the reveal decision (surfaced by the composer debug command).
    this.lastOpenDebug = { mode: useDelay ? "mobile-delay-settle" : "instant", focusAgeMs: Date.now() - this.lastFocusAt, vpGap, keyboardDown, isMobile: Platform.isMobile, hasVisualViewport: !!vv, kind: state.kind, at: new Date().toLocaleTimeString() };
    if (useDelay) {
      this.revealWhenViewportSettles(win);
    } else {
      win.setTimeout(this.reposition, 160);
      win.setTimeout(this.reposition, 400);
    }
  }

  /** 0.362.0: last reveal decision, for the composer debug command. */
  lastOpenDebug: { mode: string; focusAgeMs: number; vpGap?: number; keyboardDown?: boolean; isMobile: boolean; hasVisualViewport: boolean; kind: string; at: string } | null = null;

  /** Hold the popup hidden until the mobile keyboard has finished rising, then
   *  position against the final layout and reveal.
   *
   *  0.363.3: this is only called when the keyboard is DOWN at open (a toolbar
   *  `[[`/`#` button just focused the textarea and is about to raise it), so we
   *  must WAIT for the rise — NOT shortcut past it. The old 130ms "if nothing
   *  moved yet, reveal now" timer was the bug the user reported: iOS takes a beat
   *  to even START the keyboard animation, so that timer fired first and revealed
   *  straight into the rising keyboard ("pushes through instantly"). We now reveal
   *  only after a viewport move has actually settled, with a hard cap as the sole
   *  fallback so it can never stay stuck hidden (e.g. focus never raised a
   *  keyboard). */
  private revealWhenViewportSettles(win: Window): void {
    if (!this.popupEl) return;
    // Class toggle rather than an inline visibility write (store lint:
    // no-static-styles-assignment). The popup is removed outright on close, so
    // the class can't go stale.
    this.popupEl.addClass("is-awaiting-reveal");
    const vv = win.visualViewport;
    let settleTimer = 0;
    const reveal = (): void => {
      this.mobileRevealCleanup?.();
      if (this.popupEl && this.state) { this.position(); this.popupEl.removeClass("is-awaiting-reveal"); }
    };
    // Each viewport move (keyboard animating) pushes the reveal out; when the
    // moves stop for 200ms the keyboard has settled → position + reveal.
    const onResize = (): void => {
      if (settleTimer) win.clearTimeout(settleTimer);
      settleTimer = win.setTimeout(reveal, 200);
    };
    vv?.addEventListener("resize", onResize);
    // Hard cap — the ONLY unconditional reveal, so a focus that never raises a
    // keyboard (hardware keyboard, already-up edge case) still shows the popup.
    // Generous enough to outlast iOS's keyboard-show start latency + animation.
    const maxTimer = win.setTimeout(reveal, 1200);
    this.mobileRevealCleanup = (): void => {
      vv?.removeEventListener("resize", onResize);
      if (settleTimer) win.clearTimeout(settleTimer);
      win.clearTimeout(maxTimer);
      this.mobileRevealCleanup = null;
    };
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

  /** Re-anchor an OPEN popup to the textarea — driven by visualViewport/window
   *  resize + scroll (the mobile keyboard reveal is the main case). */
  private reposition = (): void => {
    if (this.popupEl && this.state) this.position();
  };

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
    this.mobileRevealCleanup?.(); // 0.353.0: cancel a pending mobile reveal
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
  kind: "tag" | "link" | "at" | "command" | "highlight" | "dest";
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
