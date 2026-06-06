import { App, SuggestModal } from "obsidian";
import { siftMatch } from "./types";

/** One entry in the Stashpad-only command palette: an Obsidian command id
 *  plus its display name (with the redundant "Stashpad: " prefix stripped). */
interface PaletteCommand {
  id: string;
  name: string;
}

/** 0.90.0: a Stashpad-only command palette (default Mod+K). Lists just this
 *  plugin's commands — built straight from Obsidian's command registry by
 *  filtering ids that start with `stashpad:` (Obsidian namespaces every plugin
 *  command as `<pluginId>:<commandId>`), so it auto-covers every command with
 *  zero id→method bookkeeping. Because every command is already a
 *  Stashpad one, the "Stashpad: " name prefix Obsidian prepends is dropped.
 *
 *  Search uses Sift (all tokens, any order, case-insensitive substring) — the
 *  same matcher the note/folder pickers use — so it behaves like the rest of
 *  Stashpad's search surfaces. No filter chips (those are for note search,
 *  not commands). On pick we run the command by id via
 *  `commands.executeCommandById`, which resolves the right target the same way
 *  the native palette would. */
export class StashpadCommandPalette extends SuggestModal<PaletteCommand> {
  private commands: PaletteCommand[];

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Run a Stashpad command…");

    const registry: Record<string, { name?: string }> =
      (this.app as any).commands?.commands ?? {};
    this.commands = Object.keys(registry)
      .filter((id) => id.startsWith("stashpad:"))
      // Don't list the palette-opener inside its own palette.
      .filter((id) => id !== "stashpad:stashpad-command-palette")
      .map((id) => ({ id, name: stripStashpadPrefix(registry[id]?.name ?? id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSuggestions(query: string): PaletteCommand[] {
    return this.commands.filter((c) => siftMatch(query, c.name));
  }

  renderSuggestion(cmd: PaletteCommand, el: HTMLElement): void {
    el.createDiv({ text: cmd.name, cls: "stashpad-cmd-palette-name" });
  }

  onChooseSuggestion(cmd: PaletteCommand): void {
    (this.app as any).commands?.executeCommandById?.(cmd.id);
  }
}

/** Strip the leading "Stashpad: " that Obsidian prepends to every plugin
 *  command's display name. The `+` collapses repeats — a couple of commands
 *  redundantly include "Stashpad:" in their own registered name, so Obsidian's
 *  auto-prefix doubles it ("Stashpad: Stashpad: …"); one pass would leave one
 *  behind. Case-insensitive, tolerant of extra spaces. Falls back to the
 *  original string if no prefix is present. */
function stripStashpadPrefix(name: string): string {
  return name.replace(/^(?:\s*Stashpad:\s*)+/i, "").trim() || name;
}
