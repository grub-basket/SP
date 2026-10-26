import { MarkdownView, type App, type TFile } from "obsidian";
import type { StashpadView } from "../view";
import { returnToOriginOnClose } from "../leaf-return";

/** Mobile PDF export (0.584.0) by handing a note to Obsidian's OWN "Export to
 *  PDF". Obsidian Mobile 1.15.0 added PDF export for notes (share sheet on
 *  iOS); there is no plugin API for it, but the core command
 *  `workspace:export-pdf` is registered only on devices that support PDF export
 *  and exports the ACTIVE Markdown note. So: open the note in a tab, make it
 *  active, run the command. No PDF library is bundled — the earlier mobile PDF
 *  library was removed because it hung and roughly doubled the bundle.
 *
 *  The command id is undocumented. Every step feature-detects and returns false
 *  rather than throwing, so the caller can fall back to "use ⋯ → Export to PDF". */

const PDF_COMMAND = "workspace:export-pdf";

interface CommandsApi {
  findCommand?: (id: string) => unknown;
  executeCommandById?: (id: string) => unknown;
}

function commands(app: App): CommandsApi | undefined {
  return (app as unknown as { commands?: CommandsApi }).commands;
}

/** True when this Obsidian build has its own "Export to PDF" command (desktop
 *  always; mobile from 1.15). */
export function obsidianPdfExportAvailable(app: App): boolean {
  try { return !!commands(app)?.findCommand?.(PDF_COMMAND); } catch { return false; }
}

/** Open `file` in a new tab (focus returns to the Stashpad tab when it closes)
 *  and start Obsidian's Export to PDF on it. Returns whether the command ran;
 *  the tab stays open either way so the user can retry from the ⋯ menu. */
export async function openAndExportPdf(view: StashpadView, file: TFile): Promise<boolean> {
  const ws = view.app.workspace;
  const prev = ws.activeLeaf;
  // tab-return: wired below (returnToOriginOnClose). Not settleNewTab: the export
  // command acts on the ACTIVE note, so this tab must come to the front.
  const leaf = ws.getLeaf("tab");
  await leaf.openFile(file, { active: true, state: { mode: "preview" } });
  returnToOriginOnClose(ws, leaf, prev, (ref) => view.plugin.registerEvent(ref));
  ws.setActiveLeaf(leaf, { focus: true });
  if (!(leaf.view instanceof MarkdownView)) return false;
  const run = commands(view.app)?.executeCommandById;
  if (typeof run !== "function") return false;
  try {
    // Obsidian returns false when the command can't run here; anything else ran.
    return run.call(commands(view.app), PDF_COMMAND) !== false;
  } catch (e) {
    console.warn("[Stashpad] export: Obsidian's Export to PDF failed", e);
    return false;
  }
}
