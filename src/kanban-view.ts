import { ItemView, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type StashpadPlugin from "./main";
import { STASHPAD_KANBAN_VIEW_TYPE, type StashpadId, fmAddTag, fmRemoveTag, writeCompletedFm } from "./types";
import { collectIndexRows, type IndexRow } from "./aggregate-index";
import { ColorPickerModal } from "./modals";
import { returnToOriginOnClose } from "./leaf-return";
import { settleNewTab } from "./view-helpers";

/** Which note dimension the board pivots on. Deliberately Stashpad's own
 *  first-class fields (not a generic Bases property engine). Due-buckets deferred. */
type GroupBy = "color" | "tag" | "status";
interface KanbanState { folder?: string | null; groupBy?: GroupBy; showNone?: boolean }

/** A board card = an index row plus the note's task state (`completed` isn't on
 *  IndexRow). completed: true = done, false = a to-do task, undefined = not a task. */
type Card = IndexRow & { completed?: boolean };

/** Sentinel column key for cards that lack the grouping property. */
const NONE = "__none__";
const norm = (s: string): string => s.trim().toLowerCase();

const GROUP_LABELS: Record<GroupBy, string> = { color: "Color", tag: "Tag", status: "Status" };
const NONE_LABEL: Record<GroupBy, string> = { color: "No color", tag: "No tag", status: "Not a task" };

/** 0.364.0 / 0.364.1: KANBAN BOARD — pivot a folder's notes into columns by a
 *  chosen dimension (Color, Tag, or Status), drag a card between columns to
 *  change that property, undoably. Not a generic Bases-style property engine:
 *  Stashpad is a tree of notes with a few first-class dimensions, so the board
 *  pivots on those.
 *
 *  - Color:  columns = palette (default+custom) ∪ colors in use; drop sets color.
 *  - Tag:    columns = tags in use; a card shows in EACH of its tag columns;
 *            dropping moves it (removes the source column's tag, adds the target).
 *  - Status: columns = To do / Done (from the `completed` frontmatter); drop
 *            checks/unchecks the task. The "Not a task" pile is the None column.
 *
 *  The None column (cards lacking the property) is HIDDEN by default — a big pile
 *  of uncategorised notes is usually noise — with a one-tap reveal in the bar so
 *  the board never silently hides everything (common for Color). */
export class StashpadKanbanView extends ItemView {
  private folder: string | null = null;
  private groupBy: GroupBy = "color";
  private showNone = false;
  private rows: Card[] | null = null;
  private dragging: Card | null = null;
  /** The column a drag STARTED in, so a tag move knows which tag to remove. */
  private draggingFrom: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) { super(leaf); }

  getViewType(): string { return STASHPAD_KANBAN_VIEW_TYPE; }
  getDisplayText(): string {
    return this.folder ? `Board — ${this.folder.split("/").pop() || this.folder}` : "Board — all notes";
  }
  getIcon(): string { return "columns-3"; }

  getState(): Record<string, unknown> {
    return { ...super.getState(), folder: this.folder, groupBy: this.groupBy, showNone: this.showNone };
  }
  async setState(state: KanbanState, result: unknown): Promise<void> {
    if (state) {
      if ("folder" in state) this.folder = state.folder ?? null;
      if (state.groupBy) this.groupBy = state.groupBy;
      if (typeof state.showNone === "boolean") this.showNone = state.showNone;
    }
    await super.setState(state, result as ViewStateResult);
    this.rows = null; // scope changed → re-collect
    await this.render();
  }

  async onOpen(): Promise<void> { await this.render(); }

  private cleanFolder(f: string): string { return (f || "").replace(/\/+$/, ""); }

  /** Persist a state change to the leaf so it survives a reload. */
  private persist(): void { this.app.workspace.requestSaveLayout(); }

  private async collect(): Promise<Card[]> {
    const all = await collectIndexRows(this.app, this.plugin, {});
    const f = this.cleanFolder(this.folder ?? "");
    const scoped = f ? all.filter((r) => this.cleanFolder(r.folder) === f) : all;
    return scoped.map((r) => {
      const raw = this.app.metadataCache.getFileCache(r.file)?.frontmatter?.completed;
      const completed = raw === true ? true : raw === false ? false : undefined;
      return Object.assign({}, r, { completed }) as Card;
    });
  }

  // ---- per-dimension logic ----

  /** Ordered column keys, EXCLUDING the None sentinel (handled separately). */
  private columnKeys(rows: Card[]): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    const add = (k: string): void => { if (!seen.has(k)) { seen.add(k); keys.push(k); } };
    if (this.groupBy === "color") {
      for (const c of ColorPickerModal.DEFAULT_PALETTE) add(norm(c));
      for (const c of (this.plugin.settings.customPalette ?? [])) if (/^#/.test(norm(c))) add(norm(c));
      for (const r of rows) if (r.color) add(norm(r.color));
    } else if (this.groupBy === "tag") {
      for (const t of [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b))) add(t);
    } else {
      add("todo"); add("done");
    }
    return keys;
  }

  /** Which columns a card belongs to (empty ⇒ the None column). */
  private cardKeys(card: Card): string[] {
    if (this.groupBy === "color") return card.color ? [norm(card.color)] : [];
    if (this.groupBy === "tag") return card.tags.length ? card.tags.slice() : [];
    return card.completed === true ? ["done"] : card.completed === false ? ["todo"] : [];
  }

  private columnLabel(key: string): string {
    if (key === NONE) return NONE_LABEL[this.groupBy];
    if (this.groupBy === "color") { const a = this.folder ? this.plugin.getColorAlias(this.folder, key) : undefined; return a || key.toUpperCase(); }
    if (this.groupBy === "tag") return `#${key}`;
    return key === "done" ? "Done" : "To do";
  }

  /** Swatch color for a column header: a hex/CSS color, null = hollow ring, undefined = none. */
  private columnSwatch(key: string): string | null | undefined {
    if (this.groupBy === "color") return key === NONE ? null : key;
    if (this.groupBy === "status") return key === "done" ? "var(--color-green)" : key === "todo" ? "var(--text-faint)" : null;
    return undefined;
  }

  /** Apply a drag from `fromKey` (source column, may be null/None) to `toKey`. */
  private async applyDrop(card: Card, fromKey: string | null, toKey: string): Promise<void> {
    const file = card.file;
    let forward: (fm: Record<string, unknown>) => void;
    let backward: (fm: Record<string, unknown>) => void;
    let localFwd: () => void;
    let localBack: () => void;

    if (this.groupBy === "color") {
      const prev = card.color; const next = toKey === NONE ? null : toKey;
      forward = (fm) => { if (next) fm.color = next; else delete fm.color; };
      backward = (fm) => { if (prev) fm.color = prev; else delete fm.color; };
      localFwd = () => { card.color = next; }; localBack = () => { card.color = prev; };
    } else if (this.groupBy === "tag") {
      const from = fromKey && fromKey !== NONE ? fromKey : null;
      const to = toKey === NONE ? null : toKey;
      forward = (fm) => { if (from) fmRemoveTag(fm, from); if (to) fmAddTag(fm, to); };
      backward = (fm) => { if (to) fmRemoveTag(fm, to); if (from) fmAddTag(fm, from); };
      localFwd = () => { card.tags = card.tags.filter((t) => t !== from); if (to && !card.tags.includes(to)) card.tags.push(to); };
      localBack = () => { card.tags = card.tags.filter((t) => t !== to); if (from && !card.tags.includes(from)) card.tags.push(from); };
    } else {
      const prev = card.completed;
      const next: boolean | undefined = toKey === "done" ? true : toKey === "todo" ? false : undefined;
      const setFm = (fm: Record<string, unknown>, v: boolean | undefined): void => {
        if (v === true) writeCompletedFm(fm, true);
        else if (v === false) { fm.completed = false; delete fm.completedAt; } // a to-do task (stays a task)
        else writeCompletedFm(fm, false); // delete → not a task
      };
      forward = (fm) => setFm(fm, next);
      backward = (fm) => setFm(fm, prev);
      localFwd = () => { card.completed = next; }; localBack = () => { card.completed = prev; };
    }

    const write = async (fn: (fm: Record<string, unknown>) => void): Promise<void> => {
      await this.app.fileManager.processFrontMatter(file, fn);
    };
    try { await write(forward); } catch (e) { new Notice(`Stashpad: couldn't update note (${(e as Error).message})`); return; }
    localFwd(); await this.render();
    // 0.365.1: undo/redo may run after a Refresh re-collected `rows`, leaving
    // the `card` this closure holds as an orphan — mutating it then changed
    // nothing on screen until the next refresh. Mirror the closure card's state
    // onto the LIVE row for the same file, or re-collect if there is none.
    // Frontmatter stays the source of truth; this just keeps the board honest.
    const syncLive = (): void => {
      const live = (this.rows ?? []).find((x) => x.file.path === card.file.path);
      if (!live) { this.rows = null; return; }
      if (live !== card) { live.color = card.color; live.tags = card.tags.slice(); live.completed = card.completed; }
    };
    this.plugin.getUndoStack(card.folder).push({
      label: "Board change",
      undo: async () => { try { await write(backward); } catch { /* ignore */ } localBack(); syncLive(); await this.render(); },
      redo: async () => { try { await write(forward); } catch { /* ignore */ } localFwd(); syncLive(); await this.render(); },
    });
  }

  // ---- render ----

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("stashpad-kanban");

    if (!this.rows) this.rows = await this.collect();
    const rows = this.rows;

    // group
    const keys = this.columnKeys(rows);
    const byCol = new Map<string, Card[]>();
    for (const k of keys) byCol.set(k, []);
    const noneCards: Card[] = [];
    for (const card of rows) {
      const ks = this.cardKeys(card);
      if (!ks.length) { noneCards.push(card); continue; }
      for (const k of ks) { if (!byCol.has(k)) { byCol.set(k, []); keys.push(k); } byCol.get(k)!.push(card); }
    }

    // ---- header bar ----
    const bar = root.createDiv({ cls: "stashpad-kanban-bar" });
    bar.createEl("h3", { cls: "stashpad-kanban-title", text: this.getDisplayText() });
    bar.createSpan({ cls: "stashpad-kanban-count", text: `${rows.length} note${rows.length === 1 ? "" : "s"}` });

    // group-by picker
    const sel = bar.createEl("select", { cls: "stashpad-kanban-select", attr: { "aria-label": "Group by" } });
    for (const gb of ["color", "tag", "status"] as GroupBy[]) {
      const opt = sel.createEl("option", { text: `Group by: ${GROUP_LABELS[gb]}` });
      opt.value = gb; if (gb === this.groupBy) opt.selected = true;
    }
    sel.onchange = () => { this.groupBy = sel.value as GroupBy; this.persist(); void this.render(); };

    // reveal / hide the None column
    if (noneCards.length || this.showNone) {
      const toggle = bar.createEl("button", { cls: "stashpad-kanban-nonetoggle" });
      toggle.setText(this.showNone ? `Hide "${NONE_LABEL[this.groupBy]}"` : `Show "${NONE_LABEL[this.groupBy]}" (${noneCards.length})`);
      toggle.onclick = () => { this.showNone = !this.showNone; this.persist(); void this.render(); };
    }

    const refresh = bar.createEl("button", { cls: "stashpad-kanban-refresh", attr: { "aria-label": "Refresh" } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => { this.rows = null; void this.render(); };

    // ---- board ----
    // 0.365.1: in-use columns FIRST (stable order within each band), then the
    // empty palette columns as compact stubs. Six empty full-height slabs
    // scattered among three live columns was the board's biggest eyesore — but
    // the empties must stay reachable as drop targets, so CSS keeps them as
    // narrow stubs that widen on hover / drag-over. None stays last: noisy pile.
    const board = root.createDiv({ cls: "stashpad-kanban-board" });
    // 0.365.2: only COLOR reorders used-first. Status is a workflow with a fixed
    // order (To do → Done) and tag columns are alphabetical — reordering those by
    // emptiness put "Done" before an empty "To do".
    const ordered = this.groupBy === "color"
      ? [...keys.filter((k) => (byCol.get(k)?.length ?? 0) > 0), ...keys.filter((k) => (byCol.get(k)?.length ?? 0) === 0)]
      : keys;
    for (const key of ordered) this.renderColumn(board, key, byCol.get(key) ?? []);
    if (this.showNone) this.renderColumn(board, NONE, noneCards);

    // 0.365.1: the empty-state hint keys off visible CARDS, not column count.
    // Color always renders its palette columns, so the old `!keys.length` gate
    // never fired there — the hint was dead for the very case it was written
    // for (a folder with no coloured notes opening to nine empty columns).
    const visibleCards = keys.reduce((n, k) => n + (byCol.get(k)?.length ?? 0), 0)
      + (this.showNone ? noneCards.length : 0);
    if (visibleCards === 0) {
      board.createDiv({
        cls: "stashpad-kanban-empty",
        text: noneCards.length
          ? `All ${noneCards.length} notes are in the hidden "${NONE_LABEL[this.groupBy]}" column — tap "Show" above to reveal them, then drag cards into a column.`
          : (this.folder ? "No notes in this folder yet." : "No notes yet."),
      });
    }
  }

  private renderColumn(board: HTMLElement, key: string, cards: Card[]): void {
    // Stubs are for the color palette's many optional columns only — an empty
    // "To do" should keep full width.
    const stub = this.groupBy === "color" && cards.length === 0 && key !== NONE;
    const col = board.createDiv({ cls: "stashpad-kanban-col" + (stub ? " is-empty" : "") });
    const head = col.createDiv({ cls: "stashpad-kanban-col-head" });
    const swatch = this.columnSwatch(key);
    if (swatch !== undefined) {
      const sw = head.createSpan({ cls: "stashpad-kanban-swatch" });
      if (swatch === null) sw.addClass("is-none"); else sw.style.background = swatch;
    }
    const label = this.columnLabel(key);
    // A raw hex title (no alias) is data, not a name: the swatch already carries
    // the colour, so the hex is set muted + mono rather than as a bold heading.
    const isHex = this.groupBy === "color" && key !== NONE && /^#/.test(label);
    head.createSpan({ cls: "stashpad-kanban-col-name" + (isHex ? " is-hex" : ""), text: label });
    head.createSpan({ cls: "stashpad-kanban-col-count", text: String(cards.length) });

    const list = col.createDiv({ cls: "stashpad-kanban-cards" });
    for (const card of cards) this.renderCard(list, card, key);

    col.addEventListener("dragover", (e) => { e.preventDefault(); col.addClass("is-dragover"); });
    col.addEventListener("dragleave", () => col.removeClass("is-dragover"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.removeClass("is-dragover");
      const card = this.dragging; const from = this.draggingFrom;
      this.dragging = null; this.draggingFrom = null;
      if (!card) return;
      if (from === key) return; // dropped back into its own column
      void this.applyDrop(card, from, key);
    });
  }

  private renderCard(list: HTMLElement, card: Card, colKey: string): void {
    const el = list.createDiv({ cls: "stashpad-kanban-card" });
    if (card.color) el.style.borderLeftColor = card.color;
    el.createDiv({ cls: "stashpad-kanban-card-title", text: card.title || "Untitled" });
    if (card.tags.length) {
      const tagRow = el.createDiv({ cls: "stashpad-kanban-card-tags" });
      for (const t of card.tags.slice(0, 4)) tagRow.createSpan({ cls: "stashpad-kanban-tag", text: `#${t}` });
    }
    const reveal = (): void => void this.plugin.revealNoteByRef(card.folder, card.id as StashpadId);
    el.onclick = reveal;
    // 0.365.1: keyboard-reachable. Cards are plain divs, so without a role, a tab
    // stop and Enter / Space to open, the board was mouse/touch only.
    el.setAttr("tabindex", "0");
    el.setAttr("role", "button");
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); } });
    el.setAttr("draggable", "true");
    el.addEventListener("dragstart", (e) => {
      this.dragging = card; this.draggingFrom = colKey; el.addClass("is-dragging");
      try { e.dataTransfer?.setData("text/plain", card.id); } catch { /* ignore */ }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => { el.removeClass("is-dragging"); this.dragging = null; this.draggingFrom = null; });
  }
}

/** Open (or reveal) the kanban board for a folder — mirrors openAggregateView. */
export async function openKanbanView(plugin: StashpadPlugin, folder: string | null): Promise<void> {
  const { workspace } = plugin.app;
  const want = folder ? folder.replace(/\/+$/, "") : null;
  const existing = workspace.getLeavesOfType(STASHPAD_KANBAN_VIEW_TYPE)
    .find((l) => ((l.getViewState()?.state as { folder?: string | null } | undefined)?.folder ?? null) === want);
  if (existing) { workspace.revealLeaf(existing); return; }
  const originLeaf = workspace.getMostRecentLeaf();
  const leaf = workspace.getLeaf("tab");
  await leaf.setViewState({ type: STASHPAD_KANBAN_VIEW_TYPE, active: true, state: { folder: want } });
  workspace.revealLeaf(leaf);
  settleNewTab(workspace, originLeaf);
  returnToOriginOnClose(workspace, leaf, originLeaf, (ref) => plugin.registerEvent(ref));
}
