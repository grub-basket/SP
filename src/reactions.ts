import { Modal, Platform, TFile } from "obsidian";
import type { TreeNode } from "./types";
import type { StashpadView } from "./view";
import { EMOJI_SHORTCODES } from "./emoji-shortcodes";
import { EMOJI_DATA, EMOJI_GROUPS } from "./emoji-data";

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
  // 0.318.0: on mobile the chips row is full-width at the bottom of the note
  // and wraps, so every reaction is shown; desktop keeps the meta-column cap.
  const cap = Platform.isMobile ? entries.length : MAX_INLINE_REACTIONS;
  for (const [emoji, ids] of entries.slice(0, cap)) makeChip(view, host, node, emoji, ids, me);
  const rest = entries.slice(cap);
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

/** 0.318.0: the search index spans the FULL bundled dataset (EMOJI_DATA,
 *  ~1900 glyphs with labels + tags) plus the GitHub/Slack shortcode names from
 *  EMOJI_SHORTCODES, merged per glyph so `:tada:` and "party popper" both find 🎉. */
interface EmojiEntry { name: string; emoji: string; group: number; words: readonly string[] }
const EMOJI_INDEX: readonly EmojiEntry[] = (() => {
  const byGlyph = new Map<string, { name: string; group: number; words: Set<string> }>();
  for (const [glyph, label, group, tags] of EMOJI_DATA) {
    byGlyph.set(glyph, { name: label, group, words: new Set([label, ...tags, ...label.split(/\s+/)]) });
  }
  for (const [name, glyph] of Object.entries(EMOJI_SHORTCODES)) {
    const e = byGlyph.get(glyph);
    if (e) { e.words.add(name); e.words.add(name.replace(/_/g, " ")); }
    else byGlyph.set(glyph, { name, group: -1, words: new Set([name, name.replace(/_/g, " ")]) });
  }
  return [...byGlyph.entries()].map(([emoji, e]) => ({ emoji, name: e.name, group: e.group, words: [...e.words] }));
})();

/** Live-search the emoji index. Colons are optional: `:cat:`, `cat:` and `cat`
 *  all search "cat", and a partial like "ca" matches cat/cake/… Ranked exact
 *  name/shortcode > prefix > substring of a name > tag match; de-duped by glyph,
 *  capped so the grid stays light. 0.316.0; 0.318.0 over the full dataset. */
function searchEmoji(query: string, limit = 60): EmojiEntry[] {
  const q = query.trim().replace(/^:+|:+$/g, "").toLowerCase().replace(/_/g, " ");
  if (!q) return [];
  // Name/shortcode hits outrank tag hits at every tier — "rock" must list the
  // rocket (name prefix) before the singer (tag "rock").
  const exact: EmojiEntry[] = [], prefix: EmojiEntry[] = [], sub: EmojiEntry[] = [], tagExact: EmojiEntry[] = [], tagPrefix: EmojiEntry[] = [];
  for (const e of EMOJI_INDEX) {
    const name = e.name.toLowerCase();
    if (name === q) exact.push(e);
    else if (name.startsWith(q)) prefix.push(e);
    else if (name.includes(q)) sub.push(e);
    else if (e.words.some((w) => w === q)) tagExact.push(e);
    else if (e.words.some((w) => w.startsWith(q))) tagPrefix.push(e);
  }
  const out: EmojiEntry[] = [];
  const seen = new Set<string>();
  for (const e of [...exact, ...prefix, ...sub, ...tagExact, ...tagPrefix]) {
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

/** 0.318.0: recently picked emoji — per DEVICE (Obsidian's local storage, not
 *  synced settings), newest first, capped. */
const RECENT_KEY = "stashpad-recent-reactions";
const RECENT_CAP = 24;
function loadRecent(view: StashpadView): string[] {
  try {
    const raw = view.app.loadLocalStorage(RECENT_KEY);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_CAP) : [];
  } catch { return []; }
}
function pushRecent(view: StashpadView, emoji: string): void {
  const next = [emoji, ...loadRecent(view).filter((e) => e !== emoji)].slice(0, RECENT_CAP);
  try { view.app.saveLocalStorage(RECENT_KEY, next); } catch { /* ignore */ }
}

/** A representative glyph per group for the category tab strip. */
const GROUP_ICONS = ["😀", "👋", "🐻", "🍎", "🚗", "⚽", "💡", "🔣", "🏁"];

/** Shared picker body — rendered into `host`, used by BOTH the desktop popover
 *  and the mobile modal so the two can't drift. 0.316.0; reworked 0.318.0:
 *    · search (top) over the full dataset
 *    · Favorites row (user-pinned; the default presets until any are pinned)
 *      with an Edit mode in which tapping ANY emoji pins/unpins it
 *    · Recent row (per device)
 *    · All — every group with a header, plus a tab strip that scrolls to it
 *    · MULTI-PICK: a tap toggles the reaction and the picker STAYS OPEN (buttons
 *      reflect your current reactions); Done / Esc / outside-click closes.
 *  `close()` dismisses whichever container is hosting it. Search focus is
 *  caller-controlled: desktop autofocuses; mobile does not, so the rows are
 *  tappable without the keyboard covering them. */
function buildReactionPickerBody(
  view: StashpadView, node: TreeNode, host: HTMLElement, close: () => void, autofocus: boolean,
): void {
  const map = readReactions(view.app.metadataCache.getFileCache(node.file!)?.frontmatter as Record<string, unknown>);
  const me = myReactionId(view);
  const mine = new Set<string>(Object.entries(map).filter(([, ids]) => ids.includes(me)).map(([e]) => e));
  let editing = false;
  const favorites = (): string[] => view.plugin.settings.favoriteReactions ?? [];
  const isFav = (e: string): boolean => favorites().includes(e);

  host.addClass("stashpad-reaction-body");
  const input = host.createEl("input", { cls: "stashpad-reaction-input", attr: { type: "text", placeholder: "Search emoji — name, tag or :code:" } });
  const sections = host.createDiv({ cls: "stashpad-reaction-sections" });
  const results = host.createDiv({ cls: "stashpad-reaction-results is-empty" });

  /** Repaint every button for `emoji` (it can appear in several rows). */
  const refreshButtons = (emoji: string): void => {
    host.querySelectorAll<HTMLElement>(`button[data-emoji="${CSS.escape(emoji)}"]`).forEach((b) => {
      b.toggleClass("is-mine", mine.has(emoji));
      b.toggleClass("is-fav", isFav(emoji));
    });
  };
  const pick = (emoji: string): void => {
    if (!emoji) return;
    if (editing) { void toggleFavorite(emoji); return; }
    if (mine.has(emoji)) mine.delete(emoji); else mine.add(emoji);
    void toggleReaction(view, node, emoji);
    pushRecent(view, emoji);
    refreshButtons(emoji);
    renderRecent();
  };
  const toggleFavorite = async (emoji: string): Promise<void> => {
    const cur = favorites();
    view.plugin.settings.favoriteReactions = cur.includes(emoji) ? cur.filter((e) => e !== emoji) : [...cur, emoji];
    await view.plugin.persistSettingsQuiet();
    renderSections();
  };
  const button = (parent: HTMLElement, emoji: string, cls: string, title?: string): HTMLButtonElement => {
    const b = parent.createEl("button", { cls: cls + (mine.has(emoji) ? " is-mine" : "") + (isFav(emoji) ? " is-fav" : ""), text: emoji });
    b.dataset.emoji = emoji;
    if (title) b.title = title;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); pick(emoji); };
    return b;
  };
  const section = (title: string, cls: string): { head: HTMLElement; grid: HTMLElement } => {
    const sec = sections.createDiv({ cls: "stashpad-reaction-section " + cls });
    const head = sec.createDiv({ cls: "stashpad-reaction-section-head" });
    head.createSpan({ cls: "stashpad-reaction-section-title", text: title });
    const grid = sec.createDiv({ cls: "stashpad-reaction-pickgrid" });
    return { head, grid };
  };

  let recentSec: HTMLElement | null = null;
  /** The Recent row alone — rebuilt after every pick without touching the
   *  (large) All section. */
  const renderRecent = (): void => {
    const recent = loadRecent(view);
    recentSec?.remove(); recentSec = null;
    if (!recent.length) return;
    recentSec = createDiv({ cls: "stashpad-reaction-section is-recent" });
    const head = recentSec.createDiv({ cls: "stashpad-reaction-section-head" });
    head.createSpan({ cls: "stashpad-reaction-section-title", text: "Recent" });
    const grid = recentSec.createDiv({ cls: "stashpad-reaction-pickgrid" });
    for (const emoji of recent) button(grid, emoji, "stashpad-reaction-pick");
    const all = sections.querySelector(".stashpad-reaction-section.is-all");
    if (all) sections.insertBefore(recentSec, all); else sections.appendChild(recentSec);
  };
  const renderSections = (): void => {
    sections.empty();
    recentSec = null;
    sections.toggleClass("is-editing", editing);
    // Favorites (or the default presets until the user pins any)
    const favs = favorites();
    const favSec = section(favs.length ? "Favorites" : "Presets", "is-favorites");
    const edit = favSec.head.createEl("button", { cls: "stashpad-reaction-editbtn", text: editing ? "Done editing" : "Edit" });
    edit.title = editing ? "Back to reacting" : "Pin or unpin favorites: tap any emoji";
    edit.onclick = (e) => { e.preventDefault(); e.stopPropagation(); editing = !editing; renderSections(); };
    for (const emoji of (favs.length ? favs : QUICK_REACTIONS)) button(favSec.grid, emoji, "stashpad-reaction-pick");
    if (editing) sections.createDiv({ cls: "stashpad-reaction-hint", text: favs.length ? "Tap an emoji anywhere to pin or unpin it." : "Tap an emoji anywhere to pin it as a favorite (favorites replace these presets)." });
    // All — tab strip + grouped grids in one scroll container. The ~1900
    // buttons are built on the NEXT tick so the picker paints (favorites,
    // recent, search) before the big grid lands.
    const all = sections.createDiv({ cls: "stashpad-reaction-section is-all" });
    const head = all.createDiv({ cls: "stashpad-reaction-section-head" });
    head.createSpan({ cls: "stashpad-reaction-section-title", text: "All" });
    const tabs = all.createDiv({ cls: "stashpad-reaction-tabs" });
    const scroller = all.createDiv({ cls: "stashpad-reaction-all" });
    renderRecent();
    const groupEls: HTMLElement[] = [];
    window.setTimeout(() => { if (!all.isConnected) return; EMOJI_GROUPS.forEach((name, gi) => {
      const g = scroller.createDiv({ cls: "stashpad-reaction-group" });
      g.createDiv({ cls: "stashpad-reaction-group-title", text: name.replace(/\b\w/g, (c) => c.toUpperCase()) });
      const grid = g.createDiv({ cls: "stashpad-reaction-pickgrid is-all-grid" });
      for (const row of EMOJI_DATA) if (row[2] === gi) button(grid, row[0], "stashpad-reaction-result", row[1]);
      groupEls.push(g);
      const tab = tabs.createEl("button", { cls: "stashpad-reaction-tab", text: GROUP_ICONS[gi] ?? "•" });
      tab.title = name;
      tab.onmousedown = (e) => e.preventDefault();
      tab.onclick = (e) => { e.preventDefault(); e.stopPropagation(); scroller.scrollTo({ top: g.offsetTop - scroller.offsetTop, behavior: "auto" }); };
    }); }, 0);
  };
  renderSections();

  const renderResults = (): void => {
    results.empty();
    const q = input.value.trim();
    const matches = q ? searchEmoji(q) : [];
    const searching = q.length > 0;
    results.toggleClass("is-empty", !searching);
    results.toggleClass("is-none", searching && matches.length === 0);
    sections.toggleClass("is-hidden", searching);
    if (searching && matches.length === 0) results.createDiv({ cls: "stashpad-reaction-hint", text: "No emoji match." });
    for (const { name, emoji } of matches) button(results, emoji, "stashpad-reaction-result", name);
  };
  input.addEventListener("input", renderResults);
  // Enter toggles the first result (or a typed literal glyph) — desktop + mobile.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); pick(firstEmojiForQuery(input.value)); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  const footer = host.createDiv({ cls: "stashpad-reaction-footer" });
  footer.createSpan({ cls: "stashpad-reaction-hint", text: "Tap to add or remove; pick as many as you like." });
  const done = footer.createEl("button", { cls: "stashpad-reaction-done mod-cta", text: "Done" });
  done.onmousedown = (e) => e.preventDefault();
  done.onclick = (e) => { e.preventDefault(); e.stopPropagation(); close(); };
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
