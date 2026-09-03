import { TFile } from "obsidian";
import type { TreeNode } from "./types";
import type { StashpadView } from "./view";
import { EMOJI_SHORTCODES } from "./emoji-shortcodes";

/** Emoji REACTIONS (teams multiplayer, 0.280.0). Stored in note frontmatter as
 *  `reactions: { "<emoji>": ["<authorId>", ...] }` — a map of emoji -> the ids of
 *  the people who reacted with it. Toggling adds/removes the current user's id.
 *  Reserved frontmatter (see RESERVED_FRONTMATTER) so clones don't inherit them. */

/** The quick-pick set shown in the reaction popover. */
export const QUICK_REACTIONS: readonly string[] = [
  "👍", "❤️", "🎉", "😂", "😮", "😢", "🙏", "👀", "✅", "🔥", "💯", "🚀",
];

export type ReactionMap = Record<string, string[]>;

/** Read a note's reactions map defensively (frontmatter is user-writable). Accepts
 *  the LIST format `["<emoji>:<authorId>", ...]` (Obsidian recognizes list
 *  properties, so no "unrecognized property type" warning) AND the legacy object
 *  format `{ "<emoji>": ["<id>"] }` for notes reacted before the switch. */
export function readReactions(fm: Record<string, unknown> | undefined | null): ReactionMap {
  const raw = fm?.reactions;
  const out: ReactionMap = {};
  const add = (emoji: string, id: string): void => {
    if (!emoji || !id) return;
    (out[emoji] ??= []);
    if (!out[emoji].includes(id)) out[emoji].push(id);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const i = entry.indexOf(":");
      if (i <= 0) continue; // an emoji never starts with ":", and needs an id after
      add(entry.slice(0, i).trim(), entry.slice(i + 1).trim());
    }
  } else if (raw && typeof raw === "object") {
    for (const [emoji, ids] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof emoji !== "string" || !Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === "string") add(emoji.trim(), id.trim());
    }
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

/** Serialize a reaction map to the LIST frontmatter format. */
export function reactionsToList(map: ReactionMap): string[] {
  const list: string[] = [];
  for (const [emoji, ids] of Object.entries(map)) for (const id of ids) list.push(`${emoji}:${id}`);
  return list;
}

/** The id used to attribute the current user's reactions. Falls back to a stable
 *  local marker when no profile is set up, so reacting works before setup. */
export function myReactionId(view: StashpadView): string {
  const s = view.plugin.settings;
  return (s.authorId && s.authorId.trim()) || "local";
}

/** Toggle the current user's reaction with `emoji` on `node`. Writes frontmatter
 *  (marked as a self-write so it doesn't count as a contribution or re-render the
 *  list), logs it, pushes one undo entry, and repaints the note in place. */
export async function toggleReaction(view: StashpadView, node: TreeNode, emoji: string): Promise<void> {
  const file = node.file;
  if (!file) return;
  const me = myReactionId(view);
  const path = file.path;

  const apply = async (f: TFile, add: boolean): Promise<void> => {
    view.markFmSelfWrite(f.path, true);
    await view.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
      const map = readReactions(fm);
      const list = new Set(map[emoji] ?? []);
      if (add) list.add(me); else list.delete(me);
      if (list.size) map[emoji] = [...list]; else delete map[emoji];
      if (Object.keys(map).length) fm.reactions = reactionsToList(map); else delete fm.reactions;
    });
  };

  const before = readReactions(view.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown>);
  const had = (before[emoji] ?? []).includes(me);
  // Compute the resulting map up front so the chips repaint IMMEDIATELY — the
  // metadataCache updates a tick after the write, so reading it back here would
  // show the pre-toggle state (the stale-cache class of bug).
  const after: ReactionMap = {};
  for (const [k, v] of Object.entries(before)) after[k] = [...v];
  const set = new Set(after[emoji] ?? []);
  if (had) set.delete(me); else set.add(me);
  if (set.size) after[emoji] = [...set]; else delete after[emoji];
  await apply(file, !had);
  view.repaintReactions(node.id, after);

  view.plugin.getUndoStack(view.noteFolder).push({
    label: had ? `Remove ${emoji} reaction` : `React ${emoji}`,
    undo: async () => {
      const f = view.app.vault.getAbstractFileByPath(path) as TFile | null;
      if (!f) return;
      await apply(f, had);
      view.repaintReactions(node.id, before);
    },
    redo: async () => {
      const f = view.app.vault.getAbstractFileByPath(path) as TFile | null;
      if (!f) return;
      await apply(f, !had);
      view.repaintReactions(node.id, after);
    },
  });
}

const MAX_INLINE_REACTIONS = 3;

function makeChip(view: StashpadView, host: HTMLElement, node: TreeNode, emoji: string, ids: string[], me: string): void {
  const mine = ids.includes(me);
  const chip = host.createEl("button", { cls: "stashpad-reaction-chip" + (mine ? " is-mine" : "") });
  chip.createSpan({ cls: "stashpad-reaction-emoji", text: emoji });
  chip.createSpan({ cls: "stashpad-reaction-count", text: String(ids.length) });
  chip.title = reactionTooltip(view, ids, me);
  chip.onclick = (e) => { e.preventDefault(); e.stopPropagation(); void toggleReaction(view, node, emoji); };
}

/** Render a note's reaction cluster into `host` (cleared first). Shows the most
 *  popular few inline; a "+N" button reveals the rest in a popover. The ones you
 *  reacted to are highlighted; clicking a chip toggles your reaction. A hover "＋"
 *  opens the emoji picker. Empty (no reactions) collapses to nothing. */
export function renderReactionChips(view: StashpadView, host: HTMLElement, node: TreeNode, override?: ReactionMap): void {
  host.empty();
  const file = node.file;
  if (!file) return;
  const map = override ?? readReactions(view.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown>);
  const me = myReactionId(view);
  // Most popular first; ties keep a stable emoji order.
  const entries = Object.entries(map).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  host.toggleClass("is-empty", entries.length === 0);
  for (const [emoji, ids] of entries.slice(0, MAX_INLINE_REACTIONS)) makeChip(view, host, node, emoji, ids, me);
  const rest = entries.slice(MAX_INLINE_REACTIONS);
  if (rest.length) {
    const more = host.createEl("button", { cls: "stashpad-reaction-more", text: `+${rest.length}` });
    more.title = "More reactions";
    more.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openReactionOverflow(view, node, more, entries, me); };
  }
  const add = host.createEl("button", { cls: "stashpad-reaction-add", text: "＋" });
  add.title = "Add reaction";
  add.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openReactionPicker(view, node, add); };
}

/** Popover listing ALL of a note's reactions (used by the "+N" overflow button). */
function openReactionOverflow(view: StashpadView, node: TreeNode, anchor: HTMLElement, entries: Array<[string, string[]]>, me: string): void {
  const doc = anchor.ownerDocument;
  doc.querySelector(".stashpad-reaction-overflow")?.remove();
  const pop = doc.body.createDiv({ cls: "stashpad-reaction-overflow" });
  for (const [emoji, ids] of entries) makeChip(view, pop, node, emoji, ids, me);
  positionPopover(pop, anchor);
  installDismiss(pop, anchor, "stashpad-reaction-overflow");
}

function reactionTooltip(view: StashpadView, ids: string[], me: string): string {
  const names = ids.map((id) => (id === me ? "You" : view.reactionAuthorName(id)));
  return names.join(", ");
}

/** Quick-pick popover anchored to `anchor`: the common emojis, plus a text field
 *  that takes ANY emoji (typed, pasted, or a :shortcode: via the shared map). */
export function openReactionPicker(view: StashpadView, node: TreeNode, anchor: HTMLElement): void {
  const doc = anchor.ownerDocument;
  doc.querySelector(".stashpad-reaction-picker")?.remove();
  const map = readReactions(view.app.metadataCache.getFileCache(node.file!)?.frontmatter as Record<string, unknown>);
  const me = myReactionId(view);
  const pop = doc.body.createDiv({ cls: "stashpad-reaction-picker" });
  const grid = pop.createDiv({ cls: "stashpad-reaction-pickgrid" });
  for (const emoji of QUICK_REACTIONS) {
    const mine = (map[emoji] ?? []).includes(me);
    const b = grid.createEl("button", { cls: "stashpad-reaction-pick" + (mine ? " is-mine" : ""), text: emoji });
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); void toggleReaction(view, node, emoji); dismiss(); };
  }
  // Arbitrary emoji: type/paste one (or a :shortcode:) and press Enter.
  const input = pop.createEl("input", { cls: "stashpad-reaction-input", attr: { type: "text", placeholder: "any emoji or :name:" } });
  const commit = (): void => {
    const chosen = normalizeEmojiInput(input.value);
    if (chosen) { void toggleReaction(view, node, chosen); dismiss(); }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  positionPopover(pop, anchor);
  const dismiss = installDismiss(pop, anchor, "stashpad-reaction-picker");
  setTimeout(() => input.focus(), 0);
}

/** Turn a picker input value into a single emoji: a pasted/typed glyph, or a
 *  `:shortcode:` resolved via the app import map. Returns "" if nothing usable. */
function normalizeEmojiInput(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const sc = v.match(/^:?([a-z0-9_+-]+):?$/i);
  if (sc) {
    const mapped = EMOJI_SHORTCODES[sc[1].toLowerCase()];
    if (mapped) return mapped;
  }
  // Reject plain latin text (so ":" splitting in storage stays unambiguous) —
  // accept only if it contains a non-ASCII (emoji) codepoint.
  if (/[^\x00-\x7F]/.test(v) && !v.includes(":")) return [...v][0] ?? "";
  return "";
}

function positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
  // `position: fixed` lives on the popover CSS classes (store lint forbids a
  // literal `el.style.position = "fixed"`); here we only set the COMPUTED
  // left/top, which the rule allows.
  const doc = anchor.ownerDocument;
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 4)}px`;
  const pr = pop.getBoundingClientRect();
  const vw = doc.defaultView?.innerWidth ?? pr.right;
  // Anchor to the trigger, flip in from the right edge if it would overflow,
  // then clamp to a 4px gutter — all in one computed value (no literal "4px").
  let left = Math.round(r.left);
  if (left + pr.width > vw) left = Math.round(vw - pr.width - 8);
  pop.style.left = `${Math.max(4, left)}px`;
}

function installDismiss(pop: HTMLElement, anchor: HTMLElement, cls: string): () => void {
  const doc = anchor.ownerDocument;
  const onDoc = (e: MouseEvent): void => { if (!pop.contains(e.target as Node) && e.target !== anchor) dismiss(); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") dismiss(); };
  function dismiss(): void {
    pop.remove();
    doc.removeEventListener("mousedown", onDoc, true);
    doc.removeEventListener("keydown", onKey, true);
  }
  void cls;
  setTimeout(() => { doc.addEventListener("mousedown", onDoc, true); doc.addEventListener("keydown", onKey, true); }, 0);
  return dismiss;
}
