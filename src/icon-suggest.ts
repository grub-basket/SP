import { AbstractInputSuggest, App, getIconIds, setIcon } from "obsidian";

/** Lucide icon-name autocomplete for a settings text input — type a few letters
 *  and pick from matching icons (each shown WITH its preview) instead of having
 *  to know icon ids by heart. Mirrors {@link FolderSuggest}.
 *
 *  Stores the bare name (strips the internal "lucide-" prefix) since that's what
 *  `setIcon` + the rest of the plugin already use (`rocket`, not `lucide-rocket`).
 *
 *  Wire it up:
 *  ```
 *  .addText((t) => {
 *    new IconSuggest(this.app, t.inputEl);
 *    t.setValue(...).onChange(...);
 *  })
 *  ```
 *  0.121.10. */
export class IconSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  private static norm(id: string): string {
    return id.replace(/^lucide-/, "");
  }

  protected getSuggestions(query: string): string[] {
    // all-tokens, any-order match so "arrow up" finds "arrow-up", "move-up", etc.
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of getIconIds()) {
      const id = IconSuggest.norm(raw);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const match = (id: string): boolean => tokens.every((t) => id.toLowerCase().includes(t));
    const out = tokens.length ? ids.filter(match) : ids;
    out.sort();
    // 0.122.0 (#8): a narrowing search only needs a small window, but with NO
    // query the user is BROWSING — cap of 50 stranded them in the "a…" icons.
    // Render a much larger window so scrolling reaches the rest of the alphabet.
    // (AbstractInputSuggest has no scroll hook for true infinite-load; this is
    // the pragmatic middle ground — still bounded so it stays snappy.)
    return out.slice(0, tokens.length ? 50 : 300);
  }

  renderSuggestion(id: string, el: HTMLElement): void {
    el.addClass("stashpad-icon-suggest-item");
    const ic = el.createSpan({ cls: "stashpad-icon-suggest-icon" });
    setIcon(ic, id);
    el.createSpan({ cls: "stashpad-icon-suggest-label", text: id });
  }

  selectSuggestion(id: string): void {
    this.setValue(id);
    // Fire `input` so the caller's onChange listener persists + repaints.
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}
