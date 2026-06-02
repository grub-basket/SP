import { AbstractInputSuggest, App, TFolder } from "obsidian";
import { RESERVED_SUBFOLDER_NAMES } from "./types";

/** Folder-path autocomplete for a settings text input. Mirrors the
 *  affordance Obsidian itself uses for "default folder for new notes"
 *  in Files & Links — type-as-you-go suggests vault folder paths.
 *
 *  Wire it up:
 *  ```
 *  .addText((t) => {
 *    new FolderSuggest(this.app, t.inputEl);
 *    t.setValue(...).onChange(...);
 *  })
 *  ```
 *  0.71.1. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): TFolder[] {
    // 0.76.26: Sift — all-tokens, any-order match (see docs/sift.md)
    // so "proj notes" finds "Notes/Projects" etc., not just literal
    // substrings.
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const sift = (path: string): boolean =>
      tokens.every((t) => path.toLowerCase().includes(t));
    const out: TFolder[] = [];
    const walk = (folder: TFolder): void => {
      // 0.79.12: skip reserved Stashpad subfolders (e.g. _archive,
      // _attachments) — and their subtrees — so they aren't offered as
      // destinations.
      if (folder.path !== "/" && RESERVED_SUBFOLDER_NAMES.has(folder.name)) return;
      // Skip the vault root from the suggestion list — its path is "/"
      // and selecting it sets the input to "/" which most callers
      // normalize away anyway. Children are still suggested.
      if (folder.path !== "/") {
        if (sift(folder.path)) out.push(folder);
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(this.app.vault.getRoot());
    // Cap at 100 to match AbstractInputSuggest's default render limit
    // (the popover hides excess anyway, but trimming here keeps the
    // sort + comparison work bounded for huge vaults).
    return out.slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    // Fire `input` so the caller's onChange listener sees the new value.
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}
