import { AbstractInputSuggest, App, getAllTags } from "obsidian";
import { siftRank, tokenAt, otherTokens, replaceToken } from "./suggest-match";
import { isArchivedPath } from "./types";

/** One suggestion: the text committed into the field, plus an optional muted
 *  second line (a count, a full path…). */
export interface SuggestEntry { value: string; detail?: string }

export interface StringSuggestOptions {
  /** Separator-delimited list field ("a, b, c"): suggest for the token under the
   *  caret and replace ONLY that token. A single-character class, e.g. `/,/` or
   *  `/[\s,]/`. Values already in the list are hidden. */
  list?: RegExp;
  /** Max rows while narrowing (default 50) and while browsing an empty query
   *  (default 200). */
  limit?: number;
  browseLimit?: number;
  /** Called after a pick is committed (value set + `input` dispatched) — for
   *  fields that persist on blur/change rather than on input. */
  onPick?: (value: string) => void;
}

/** Generic text-field autocomplete over a list of strings — the shared engine
 *  behind every "names a vault entity" field that isn't a plain folder path
 *  (that one stays {@link FolderSuggest}). Mirrors FolderSuggest / IconSuggest /
 *  CommandSuggest: Obsidian's `AbstractInputSuggest`, so the popover is
 *  popout-window-safe and keyboard-navigable for free.
 *
 *  - Matching is Sift + rank (src/suggest-match.ts, docs/sift.md).
 *  - `source` is called LAZILY — on the first suggestion request, not at
 *    construction — and cached for this instance's life (a settings page
 *    re-render builds a fresh one), so a vault-wide scan never runs at plugin
 *    load or just because a settings page was painted.
 *  - A pick commits exactly like typing: value set, `input` dispatched so the
 *    field's own onChange/save logic runs, popover closed.
 *  - Free text is always still allowed; this only suggests.
 *
 *  0.494.0 — autocomplete-everywhere. */
export class StringSuggest extends AbstractInputSuggest<SuggestEntry> {
  private entries: SuggestEntry[] | null = null;
  private spShown = false;

  /** True while the popover is showing. A field whose own Enter handler
   *  commits/blurs should skip that while this is true — Enter belongs to the
   *  popover then (it picks the highlighted row, and onPick commits).
   *  (Named `popoverShown`, not `isOpen`: Obsidian's PopoverSuggest keeps its
   *  own internal `isOpen` field, and a getter under that name broke it.) */
  get popoverShown(): boolean { return this.spShown; }
  open(): void { this.spShown = true; super.open(); }
  close(): void { this.spShown = false; super.close(); }

  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private source: () => ReadonlyArray<string | SuggestEntry>,
    private opts: StringSuggestOptions = {},
  ) {
    super(app, inputEl);
  }

  private pool(): SuggestEntry[] {
    if (!this.entries) {
      const seen = new Set<string>();
      const out: SuggestEntry[] = [];
      for (const raw of this.source()) {
        const e = typeof raw === "string" ? { value: raw } : raw;
        if (!e.value || seen.has(e.value)) continue;
        seen.add(e.value);
        out.push(e);
      }
      this.entries = out;
    }
    return this.entries;
  }

  protected getSuggestions(query: string): SuggestEntry[] {
    let q = query;
    let entries = this.pool();
    if (this.opts.list) {
      const value = this.inputEl.value;
      const tok = tokenAt(value, this.inputEl.selectionStart ?? value.length, this.opts.list);
      q = tok.token;
      const taken = otherTokens(value, tok, this.opts.list);
      if (taken.size) entries = entries.filter((e) => !taken.has(e.value.toLowerCase()));
    }
    const ranked = siftRank(q, entries, (e) => e.value);
    return ranked.slice(0, q.trim() ? (this.opts.limit ?? 50) : (this.opts.browseLimit ?? 200));
  }

  renderSuggestion(entry: SuggestEntry, el: HTMLElement): void {
    el.createDiv({ text: entry.value });
    if (entry.detail) el.createEl("small", { cls: "stashpad-input-suggest-detail", text: entry.detail });
  }

  selectSuggestion(entry: SuggestEntry): void {
    if (this.opts.list) {
      const value = this.inputEl.value;
      const tok = tokenAt(value, this.inputEl.selectionStart ?? value.length, this.opts.list);
      const next = replaceToken(value, tok, entry.value);
      this.inputEl.value = next.value;
      this.inputEl.setSelectionRange(next.caret, next.caret);
    } else {
      this.setValue(entry.value);
    }
    // Fire `input` so the caller's onChange listener sees the new value.
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
    this.opts.onPick?.(entry.value);
  }
}

// ---------- Lazy sources (call only from inside a suggester) ----------

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Every tag used in the vault (frontmatter + inline, via the public
 *  `getAllTags`), most-used first, WITHOUT the leading `#` unless `withHash`.
 *  Nested tags keep their full path (`project/alpha`). Skips `_archive`. */
export function vaultTagEntries(app: App, withHash = false): SuggestEntry[] {
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (isArchivedPath(f.path)) continue;
    const cache = app.metadataCache.getFileCache(f);
    if (!cache) continue;
    const tags = getAllTags(cache) ?? [];
    const seenInFile = new Set<string>();
    for (const raw of tags) {
      const bare = raw.replace(/^#+/, "");
      if (!bare) continue;
      const k = bare.toLowerCase();
      if (seenInFile.has(k)) continue;
      seenInFile.add(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (!display.has(k)) display.set(k, bare);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => ({ value: (withHash ? "#" : "") + (display.get(k) ?? k), detail: plural(n, "note") }));
}

/** File extensions present in the vault, most common first (no dot unless
 *  `withDot`). */
export function vaultExtensionEntries(app: App, withDot = false): SuggestEntry[] {
  const counts = new Map<string, number>();
  for (const f of app.vault.getFiles()) {
    const ext = f.extension.toLowerCase();
    if (!ext) continue;
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, n]) => ({ value: (withDot ? "." : "") + ext, detail: plural(n, "file") }));
}

/** IANA timezone names the runtime knows (empty on a runtime without
 *  `Intl.supportedValuesOf`). */
export function timezoneNames(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Obsidian's built-in callout types (and their aliases). */
export const CALLOUT_TYPES: readonly string[] = [
  "note", "abstract", "summary", "tldr", "info", "todo", "tip", "hint", "important",
  "success", "check", "done", "question", "help", "faq", "warning", "caution",
  "attention", "failure", "fail", "missing", "danger", "error", "bug", "example",
  "quote", "cite",
];
