import { Notice, SuggestModal } from "obsidian";
import type { TreeNode } from "../types";
import { getSettings } from "../settings";
import { extractCodeBlocks } from "../view-helpers";
import type { StashpadView } from "../view";

/** Clipboard command group extracted from StashpadView (view-split stage 5).
 *  Free functions taking the view; they call back into the view's public
 *  surface (getActionTargets, stripFrontmatter, titleForNode, titleList,
 *  formatTimeInline, notifications, tree). Behavior is identical to when these
 *  lived inline as `cmd*` methods. */

export async function cmdCopy(view: StashpadView): Promise<void> {
  const targets = view.getActionTargets();
  if (!targets.length) return;
  const prefix = getSettings().prefixTimestampsOnCopy;
  const out: string[] = [];
  for (const t of targets) {
    if (!t.file) continue;
    const raw = await view.app.vault.cachedRead(t.file);
    const body = view.stripFrontmatter(raw).trim();
    out.push(prefix ? `${view.formatTimeInline(t.created)} ${body}` : body);
  }
  await navigator.clipboard.writeText(out.join("\n\n"));
  view.plugin.notifications.show({
    message: `Copied ${view.titleList(targets)} to clipboard`,
    kind: "success",
    category: "system",
    affectedIds: targets.map((t) => t.id),
    folder: view.noteFolder,
  });
}

/** Copy the contents of a fenced codeblock from the cursor row's body.
 *  - 0 codeblocks → info toast.
 *  - 1 codeblock  → copy silently with a success toast.
 *  - 2+ blocks    → pick one via a SuggestModal (with a "Copy all"
 *                   choice at the end that joins them with blank lines).
 *  Operates on the first selected note when there's a selection,
 *  otherwise the cursor row. 0.61.0. */
export async function cmdCopyCodeBlock(view: StashpadView): Promise<void> {
  const targets = view.getActionTargets();
  if (!targets.length || !targets[0].file) { new Notice("Nothing to copy from."); return; }
  const node = targets[0];
  const raw = await view.app.vault.cachedRead(node.file!);
  const body = view.stripFrontmatter(raw);
  const blocks = extractCodeBlocks(body);
  if (blocks.length === 0) {
    view.plugin.notifications.show({
      message: `No codeblock found in "${view.titleForNode(node)}".`,
      kind: "info",
      category: "system",
      affectedIds: [node.id],
      folder: view.noteFolder,
    });
    return;
  }
  if (blocks.length === 1) {
    await navigator.clipboard.writeText(blocks[0].code);
    view.plugin.notifications.show({
      message: `Copied codeblock${blocks[0].lang ? ` (${blocks[0].lang})` : ""} from "${view.titleForNode(node)}".`,
      kind: "success",
      category: "system",
      affectedIds: [node.id],
      folder: view.noteFolder,
    });
    return;
  }
  // Multiple — pick one (or all). Lightweight SuggestModal.
  type Item = { kind: "one" | "all"; idx: number; label: string };
  const items: Item[] = blocks.map((b, i) => ({
    kind: "one" as const,
    idx: i,
    label: `${i + 1}. ${b.lang || "(no language)"} — ${b.code.split("\n")[0].slice(0, 60)}${b.code.includes("\n") ? "…" : ""}`,
  }));
  items.push({ kind: "all", idx: -1, label: `Copy all ${blocks.length} blocks (joined with blank lines)` });
  const modal = new (class extends SuggestModal<Item> {
    getSuggestions(query: string): Item[] {
      const q = query.trim().toLowerCase();
      if (!q) return items;
      const tokens = q.split(/\s+/).filter(Boolean);
      return items.filter((it) => {
        const h = it.label.toLowerCase();
        return tokens.every((t) => h.includes(t));
      });
    }
    renderSuggestion(item: Item, el: HTMLElement): void {
      el.createDiv({ cls: "stashpad-suggest-title", text: item.label });
    }
    async onChooseSuggestion(item: Item): Promise<void> {
      const text = item.kind === "all"
        ? blocks.map((b) => b.code).join("\n\n")
        : blocks[item.idx].code;
      await navigator.clipboard.writeText(text);
      view.plugin.notifications.show({
        message: item.kind === "all"
          ? `Copied all ${blocks.length} codeblocks from "${view.titleForNode(node)}".`
          : `Copied codeblock${blocks[item.idx].lang ? ` (${blocks[item.idx].lang})` : ""} from "${view.titleForNode(node)}".`,
        kind: "success",
        category: "system",
        affectedIds: [node.id],
        folder: view.noteFolder,
      });
    }
  })(view.app);
  modal.setPlaceholder(`${blocks.length} codeblocks in "${view.titleForNode(node)}" — pick one to copy.`);
  modal.open();
}

export async function cmdCopyTree(view: StashpadView): Promise<void> {
  // Roots: selection > cursor row > focused note (last resort).
  let roots = view.getActionTargets();
  if (roots.length === 0) {
    const focused = view.tree.get(view.focusId);
    if (focused?.file) roots = [focused];
  }
  if (roots.length === 0) { new Notice("Nothing to copy."); return; }
  const prefix = getSettings().prefixTimestampsOnCopy;
  const lines: string[] = [];
  const walk = async (node: TreeNode, depth: number): Promise<void> => {
    if (node.file) {
      const raw = await view.app.vault.cachedRead(node.file);
      const body = view.stripFrontmatter(raw).trim().split(/\r?\n/).join(" ");
      const ts = prefix ? `${view.formatTimeInline(node.created)} ` : "";
      lines.push(`${"  ".repeat(depth)}- ${ts}${body}`);
    }
    for (const c of view.tree.getChildren(node.id)) await walk(c, depth + 1);
  };
  for (const r of roots) await walk(r, 0);
  const outline = lines.join("\n");
  await navigator.clipboard.writeText(outline);
  // 0.99.13: also load the note clipboard (copy mode) with the whole stack, so
  // Copy tree participates in paste like Mod+C does — paste in the LIST clones
  // the stack(s), paste in a COMPOSER drops the outline text in. (Mod+C copies
  // the selection; Copy tree copies the selected note + all its descendants.)
  view.plugin.clearNoteClipboard();
  view.plugin.noteClipboard = { mode: "copy", folder: view.noteFolder, ids: roots.map((r) => r.id), text: outline };
  view.render(); // paint the copy-pending tint
  view.plugin.notifications.show({
    message: `Copied tree of ${view.titleList(roots)} (${lines.length} entries) — paste in the list to clone, in a note to drop the outline in`,
    kind: "success",
    category: "system",
    affectedIds: roots.map((r) => r.id),
    folder: view.noteFolder,
  });
}

/** Copy selection (or cursor row, or focused note) as a bullet list of
 *  ![[embed]] links, indented by nesting depth. Useful for transcluding a
 *  subtree into a regular Obsidian note. */
export async function cmdCopyOutline(view: StashpadView): Promise<void> {
  let roots = view.getActionTargets();
  if (roots.length === 0) {
    const focused = view.tree.get(view.focusId);
    if (focused?.file) roots = [focused];
  }
  if (roots.length === 0) { new Notice("Nothing to copy."); return; }
  const lines: string[] = [];
  const walk = (node: TreeNode, depth: number) => {
    if (!node.file) return;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ![[${node.file.basename}]]`);
    for (const c of view.tree.getChildren(node.id)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  await navigator.clipboard.writeText(lines.join("\n"));
  view.plugin.notifications.show({
    message: `Copied outline of ${view.titleList(roots)} (${lines.length} entr${lines.length === 1 ? "y" : "ies"})`,
    kind: "success",
    category: "system",
    affectedIds: roots.map((r) => r.id),
    folder: view.noteFolder,
  });
}
