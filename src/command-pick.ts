import { App, FuzzySuggestModal } from "obsidian";

interface PickCommand { id: string; name: string; }

/** 0.320.0: pick any registered Obsidian command (used to add a custom entry to
 *  the star menu / item buttons / context menu). Returns the full command id
 *  (e.g. "editor:toggle-bold" or "stashpad:stashpad-copy-tree"). */
export class CommandPickModal extends FuzzySuggestModal<PickCommand> {
  constructor(app: App, private onPick: (id: string, name: string) => void) {
    super(app);
    this.setPlaceholder("Pick a command to add…");
  }
  getItems(): PickCommand[] {
    const registry: Record<string, { name?: string; id?: string }> = (this.app as any).commands?.commands ?? {};
    return Object.keys(registry)
      .map((id) => ({ id, name: registry[id]?.name || id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  getItemText(c: PickCommand): string { return c.name; }
  onChooseItem(c: PickCommand): void { this.onPick(c.id, c.name); }
}
