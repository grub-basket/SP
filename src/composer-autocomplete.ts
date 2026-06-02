import { App, Scope, TFile } from "obsidian";
import { isArchivedPath, isIgnoredFileExtension, matchesObsidianIgnore } from "./types";
import { getSettings } from "./settings";

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
  private fileIndex: { label: string; lower: string; insertText: string; file: TFile }[] = [];
  private tagIndex: string[] = [];
  private indexBuilt = false;
  private vaultListeners: Array<() => void> = [];
  /** Obsidian Scope pushed onto the keymap while the popup is open. It
   *  consumes Escape (and Enter/Tab/Arrow keys are also re-bound here
   *  belt-and-suspenders) so the workspace's "Escape returns to last
   *  leaf" handler doesn't fire and yank focus to a previous tab. */
  private scope: Scope | null = null;

  constructor(private app: App, private ta: HTMLTextAreaElement) {}

  attach(): void {
    this.ta.addEventListener("input", this.onInput);
    this.ta.addEventListener("keydown", this.onKeyDown, true);
    this.ta.addEventListener("blur", this.onBlur);
    // Document-capture Escape interceptor — only acts while a popup is
    // open. Without this, Obsidian's workspace-level Escape (which
    // refocuses another tab / split) wins the capture-phase race against
    // our textarea-level listener and the user gets thrown off the view.
    const doc = this.ta.ownerDocument ?? document;
    doc.addEventListener("keydown", this.onDocEscape, true);
    this.vaultListeners.push(() => doc.removeEventListener("keydown", this.onDocEscape, true));
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
      .map((f) => {
        const isMd = f.extension === "md";
        const label = isMd ? f.basename : f.name;
        const insertText = isMd ? f.basename : f.name;
        return { label, lower: label.toLowerCase(), insertText, file: f };
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

    // Wikilink: [[ followed by query (no closing ]] yet, no newline)
    const linkMatch = before.match(/\[\[([^\]\[\n]*)$/);
    if (linkMatch) {
      const query = linkMatch[1];
      return {
        kind: "link",
        query,
        replaceStart: caret - query.length - 2,
        replaceEnd: caret,
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

    return null;
  }

  // ---------- Suggest generation ----------

  private buildItems(state: AutocompleteState): SuggestItem[] {
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
    if (state.kind === "link") {
      // 0.73.3: cap bumped 30 → 50 now that the index includes every
      // file type — more candidates means fuzzy queries have more to
      // narrow down.
      const matches = this.fileIndex
        .filter((f) => matchesAll(f.lower))
        .slice(0, 50)
        .map((f) => ({
          label: f.label,
          // replaceStart points BEFORE the opening "[[", so we re-emit
          // them along with the link text + closing brackets. Markdown
          // notes use the basename; non-md files keep their extension
          // because Obsidian only resolves [[image.png]] WITH the ext.
          insert: `[[${f.insertText}]]`,
          subtitle: f.file.path,
        }));
      return matches;
    } else {
      // Tag autocomplete: same all-tokens rule, just against the
      // pre-sorted (by usage count) tag list.
      const matches = this.tagIndex
        .filter((t) => matchesAll(t.toLowerCase()))
        .slice(0, 30)
        .map((t) => ({
          label: t,
          insert: t,
          subtitle: "",
        }));
      return matches;
    }
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
    try { (this.app as any).keymap?.popScope(this.scope); } catch {}
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

  private commit(): void {
    if (!this.state || !this.items.length) return;
    const item = this.items[this.activeIdx];
    if (!item) return;
    const before = this.ta.value.slice(0, this.state.replaceStart);
    const after = this.ta.value.slice(this.state.replaceEnd);
    const insert = item.insert;
    this.ta.value = before + insert + after;
    const caret = before.length + insert.length;
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
  label: string;
  insert: string;
  subtitle: string;
}

interface AutocompleteState {
  kind: "tag" | "link";
  query: string;
  /** Inclusive start index of the trigger (for replacement). For "[[foo"
   *  this points at the first `[`; for "#foo" at the `#`. */
  replaceStart: number;
  /** Exclusive end index (the caret). */
  replaceEnd: number;
}
