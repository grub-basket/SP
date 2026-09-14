import { AbstractInputSuggest, App } from "obsidian";

interface ObsidianCommand { id: string; name: string; icon?: string }

/** Autocomplete for an Obsidian command id in a settings text input — type part
 *  of a command name or id and pick from the registered commands. Stores the
 *  bare command id (what `executeCommandById` takes). Mirrors {@link IconSuggest}.
 *
 *  0.363.2 — added for the configurable composer action-bar button. */
export class CommandSuggest extends AbstractInputSuggest<ObsidianCommand> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  private allCommands(): ObsidianCommand[] {
    const cmds = (this.app as unknown as { commands?: { commands?: Record<string, ObsidianCommand> } }).commands?.commands ?? {};
    return Object.values(cmds);
  }

  protected getSuggestions(query: string): ObsidianCommand[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (c: ObsidianCommand): boolean =>
      tokens.every((t) => (c.name + " " + c.id).toLowerCase().includes(t));
    const out = this.allCommands()
      .filter((c) => (tokens.length ? match(c) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, tokens.length ? 50 : 200);
  }

  renderSuggestion(cmd: ObsidianCommand, el: HTMLElement): void {
    el.createDiv({ text: cmd.name });
    el.createEl("small", { text: cmd.id, cls: "stashpad-command-suggest-id" });
  }

  selectSuggestion(cmd: ObsidianCommand): void {
    this.setValue(cmd.id);
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}
