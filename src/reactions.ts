import { Modal, Platform, TFile } from "obsidian";
import type { TreeNode } from "./types";
import type { StashpadView } from "./view";
import { EMOJI_SHORTCODES } from "./emoji-shortcodes";

/** Emoji REACTIONS (teams multiplayer, 0.280.0). Stored in note frontmatter as
 *  `reactions: { "<emoji>": ["<authorId>", ...] }` — a map of emoji -> the ids of
 *  the people who reacted with it. Toggling adds/removes the current user's id.
 *  Reserved frontmatter (see RESERVED_FRONTMATTER) so clones don't inherit them. */

/** 0.316.0: the quick-pick presets shown at the top of the reaction picker.
 *  0.316.3: eight — happy / sad / tada / angry / surprised / looking / thumbs-up /
 *  green-check — to fill the popover width. Everything else is reachable through
 *  the live search below them. */
export const QUICK_REACTIONS: readonly string[] = [
  "😄", "😢", "🎉", "😠", "😮", "👀", "👍", "✅",
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
  // 0.287.0: the "add reaction" affordance is no longer an in-cluster hover "＋"
  // (that hover-reveal made the row expand/shrink jarringly). It now lives as a
  // stable button in the row's action cluster — see StashpadView.addReactionButton.
  // This cluster is display-only: reaction chips + the "+N" overflow, nothing that
  // appears on hover. When there are no reactions it collapses to nothing (is-empty).
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

/** Name -> emoji, flattened once for search. Names are the GitHub/Slack
 *  shortcodes in EMOJI_SHORTCODES. */
interface EmojiEntry { name: string; emoji: string; }
const EMOJI_INDEX: readonly EmojiEntry[] =
  Object.entries(EMOJI_SHORTCODES).map(([name, emoji]) => ({ name, emoji }));

/** Live-search the emoji index by NAME. Colons are optional: `:cat:`, `cat:`
 *  and `cat` all search "cat", and a partial like "ca" matches cat/cake/…
 *  Ranked exact > prefix > substring, de-duped by glyph (so thumbsup/+1 don't
 *  both show), capped so the grid stays light. 0.316.0. */
function searchEmoji(query: string, limit = 48): EmojiEntry[] {
  const q = query.trim().replace(/^:+|:+$/g, "").toLowerCase();
  if (!q) return [];
  const exact: EmojiEntry[] = [], prefix: EmojiEntry[] = [], sub: EmojiEntry[] = [];
  for (const e of EMOJI_INDEX) {
    if (e.name === q) exact.push(e);
    else if (e.name.startsWith(q)) prefix.push(e);
    else if (e.name.includes(q)) sub.push(e);
  }
  const out: EmojiEntry[] = [];
  const seen = new Set<string>();
  for (const e of [...exact, ...prefix, ...sub]) {
    if (seen.has(e.emoji)) continue;
    seen.add(e.emoji);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** The emoji Enter should insert for the current query: a typed/pasted literal
 *  glyph wins; otherwise the top search result. "" when nothing matches. */
function firstEmojiForQuery(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  // A pasted/typed literal emoji (non-ASCII, no colon) → use it directly.
  if (/[^\x00-\x7F]/.test(v) && !v.includes(":")) return [...v][0] ?? "";
  return searchEmoji(v, 1)[0]?.emoji ?? "";
}

/** Shared picker body — presets + live search + results grid — rendered into
 *  `host`. Used by BOTH the desktop popover and the mobile modal so the two
 *  can't drift. `close()` dismisses whichever container is hosting it. Search
 *  focus is caller-controlled: desktop autofocuses (pointer already committed);
 *  mobile does NOT, so the presets are tappable without the keyboard covering
 *  them until the user actually taps the field. 0.316.0. */
function buildReactionPickerBody(
  view: StashpadView, node: TreeNode, host: HTMLElement, close: () => void, autofocus: boolean,
): void {
  const map = readReactions(view.app.metadataCache.getFileCache(node.file!)?.frontmatter as Record<string, unknown>);
  const me = myReactionId(view);
  const pick = (emoji: string): void => { if (emoji) { void toggleReaction(view, node, emoji); close(); } };

  const presets = host.createDiv({ cls: "stashpad-reaction-pickgrid" });
  for (const emoji of QUICK_REACTIONS) {
    const mine = (map[emoji] ?? []).includes(me);
    const b = presets.createEl("button", { cls: "stashpad-reaction-pick" + (mine ? " is-mine" : ""), text: emoji });
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); pick(emoji); };
  }

  const input = host.createEl("input", { cls: "stashpad-reaction-input", attr: { type: "text", placeholder: "Search emoji — name or :code:" } });
  const results = host.createDiv({ cls: "stashpad-reaction-results" });
  const renderResults = (): void => {
    results.empty();
    const matches = searchEmoji(input.value);
    results.toggleClass("is-empty", matches.length === 0);
    for (const { name, emoji } of matches) {
      const mine = (map[emoji] ?? []).includes(me);
      const b = results.createEl("button", { cls: "stashpad-reaction-result" + (mine ? " is-mine" : ""), text: emoji });
      b.title = `:${name}:`;
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); pick(emoji); };
    }
  };
  input.addEventListener("input", renderResults);
  // Enter inserts the first result (or a typed literal glyph) — desktop + mobile.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); pick(firstEmojiForQuery(input.value)); }
  });
  if (autofocus) setTimeout(() => input.focus(), 0);
}

/** Reaction picker. Desktop: a small popover anchored to the trigger. Mobile: a
 *  full modal (Obsidian handles the fullscreen + keyboard), so the search field
 *  no longer floats mid-screen and get shoved by the soft keyboard as though two
 *  keyboards were stacked. Both share buildReactionPickerBody. 0.316.0. */
export function openReactionPicker(view: StashpadView, node: TreeNode, anchor: HTMLElement): void {
  if (Platform.isMobile) {
    new ReactionPickerModal(view, node).open();
    return;
  }
  const doc = anchor.ownerDocument;
  doc.querySelector(".stashpad-reaction-picker")?.remove();
  const pop = doc.body.createDiv({ cls: "stashpad-reaction-picker" });
  const dismiss = installDismiss(pop, anchor, "stashpad-reaction-picker");
  buildReactionPickerBody(view, node, pop, dismiss, /*autofocus*/ true);
  positionPopover(pop, anchor);
}

/** Mobile reaction picker: a normal Obsidian modal (fullscreen on phones), so
 *  the keyboard opens below the search field instead of lifting a floating
 *  popover. 0.316.0. */
class ReactionPickerModal extends Modal {
  constructor(private view: StashpadView, private node: TreeNode) { super(view.app); }
  onOpen(): void {
    this.titleEl.setText("Add reaction");
    this.modalEl.addClass("stashpad-reaction-modal");
    // No autofocus on mobile: let the presets be tapped without the keyboard
    // immediately covering them.
    buildReactionPickerBody(this.view, this.node, this.contentEl, () => this.close(), /*autofocus*/ false);
  }
  onClose(): void { this.contentEl.empty(); }
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
