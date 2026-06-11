import { App, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { renderCountBadge } from "./panels-view";
import { ComposerAutocomplete } from "./composer-autocomplete";
import { formatDateTime } from "./format";
import {
  ROOT_ID,
  STASHPAD_DETAIL_VIEW_TYPE,
  STASHPAD_VIEW_TYPE,
  fmHasTag,
  type StashpadId,
} from "./types";

/** 0.74.1: right-sidebar detail panel. Mirrors the cursored note in the
 *  active Stashpad view — title + rendered body + metadata + children
 *  list. Counterpart to the left-side panels view (Pinned/Shared/Tasks):
 *  left = navigation, right = current-row inspection.
 *
 *  Live updates on (a) selection changes inside the active Stashpad
 *  (via the plugin's selection-listener registry), (b) file modify
 *  events for the currently-displayed note, and (c) workspace
 *  active-leaf-change. */
export class StashpadDetailView extends ItemView {
  /** Path of the note currently displayed. Used to detect whether a
   *  vault.modify event is relevant to this panel. */
  private displayedPath: string | null = null;
  private unsubscribeSelection: (() => void) | null = null;
  /** Coalesces a burst of selection/modify events into one render. */
  private renderTimer: number | null = null;
  /** 0.74.2: ids of children-list rows currently expanded into their
   *  own subtrees — same pattern as StashpadPanelsView.expanded. Key
   *  is "<folder>|<id>" so expansion state is scoped per folder
   *  (re-rendering for a different cursored note in the same folder
   *  preserves expansions; switching folders effectively resets).
   *  Non-persistent; resets on view re-open. */
  private expanded = new Set<string>();
  /** 0.74.4: simplified composer. Creates a CHILD of the currently-
   *  displayed note via the active Stashpad view's createNoteUnder.
   *  Draft text is preserved across re-renders but keyed to the
   *  displayed note id — switching notes starts a fresh draft. */
  private composerAutocomplete: ComposerAutocomplete | null = null;
  private composerInputEl: HTMLTextAreaElement | null = null;
  private composerDraft = "";
  private composerDraftForId: string | null = null;
  /** 0.74.6: the note the panel is LOCKED to. Survives content
   *  changes (reorder/edit) so a background reorder doesn't yank the
   *  panel off the note being reordered. Cleared on a genuine
   *  selection change (arrow/click/navigate), after which the panel
   *  re-locks to the live cursor. */
  private displayedId: string | null = null;
  private unsubscribeContent: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: StashpadPlugin) {
    super(leaf);
  }

  getViewType(): string { return STASHPAD_DETAIL_VIEW_TYPE; }
  getDisplayText(): string { return "Stashpad detail"; }
  getIcon(): string { return "panel-right"; }

  async onOpen(): Promise<void> {
    this.render();
    // Genuine selection change → unlock so the panel re-locks to the
    // new live cursor on the next render.
    this.unsubscribeSelection = this.plugin.onStashpadSelectionChange(() => {
      this.displayedId = null;
      this.scheduleRender();
    });
    // Content change (reorder / edit / child added) → re-render but
    // STAY on the locked note.
    this.unsubscribeContent = this.plugin.onStashpadContentChange(() => this.scheduleRender());
    // 0.74.8: only re-render on leaf changes that activate a DIFFERENT
    // Stashpad view (to follow its selection). Crucially, do NOT
    // re-render when WE become the active leaf — that fired the moment
    // the user clicked into the panel, rebuilt the whole DOM, and ate
    // the click (the "everything needs two clicks" bug). Activation of
    // a real Stashpad view is also covered by the selection-changed
    // notification, so this is just a belt-and-suspenders follow.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!leaf || leaf === this.leaf) return;
      if (leaf.view?.getViewType?.() !== STASHPAD_VIEW_TYPE) return;
      this.scheduleRender();
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (this.displayedPath && file.path === this.displayedPath) this.scheduleRender();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (this.displayedPath && file.path === this.displayedPath) this.scheduleRender();
    }));
  }

  async onClose(): Promise<void> {
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = null;
    this.unsubscribeContent?.();
    this.unsubscribeContent = null;
    this.composerAutocomplete?.detach();
    this.composerAutocomplete = null;
    this.composerInputEl = null;
    if (this.renderTimer != null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer != null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.containerEl.isConnected) void this.render();
    }, 60);
  }

  /** 0.74.6: resolve which note the panel should display. When locked
   *  to a specific id (displayedId), resolve it from the active view's
   *  tree so reorders/edits that move the live cursor don't switch the
   *  panel. Falls back to the live cursor (and re-locks) when there's
   *  no lock or the locked note has vanished. */
  private resolveDisplayed(): { folder: string; id: StashpadId; file: TFile } | null {
    if (this.displayedId) {
      const view = this.plugin.lastActiveStashpadLeaf?.view as any;
      if (view?.getViewType?.() === STASHPAD_VIEW_TYPE && view.tree?.get) {
        const node = view.tree.get(this.displayedId);
        if (node?.file) {
          return { folder: view.noteFolder as string, id: this.displayedId, file: node.file as TFile };
        }
      }
      // Locked note is gone (deleted / folder switched) — unlock.
      this.displayedId = null;
    }
    const sel = this.plugin.getActiveStashpadSelection();
    if (sel) this.displayedId = sel.id;
    return sel;
  }

  private async render(): Promise<void> {
    const root = this.contentEl;
    // 0.74.4: preserve composer focus + caret across the rebuild so a
    // re-render mid-typing doesn't drop the user out of the textarea.
    const composerHadFocus = !!this.composerInputEl && document.activeElement === this.composerInputEl;
    const composerCaret = this.composerInputEl?.selectionStart ?? null;
    // Tear down the old autocomplete — its textarea is about to be
    // destroyed by root.empty().
    this.composerAutocomplete?.detach();
    this.composerAutocomplete = null;
    this.composerInputEl = null;
    root.empty();
    root.addClass("stashpad-detail-root");

    const sel = this.resolveDisplayed();
    if (!sel) {
      this.displayedPath = null;
      const empty = root.createDiv({ cls: "stashpad-detail-empty" });
      setIcon(empty.createSpan({ cls: "stashpad-detail-empty-icon" }), "panel-right");
      empty.createSpan({ cls: "stashpad-detail-empty-text",
        text: "No Stashpad note selected. Cursor or click a note in a Stashpad list to inspect it here." });
      return;
    }

    const file = sel.file;
    this.displayedPath = file.path;
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as any;

    // 0.74.7: scrollable content area. Header / body / footer /
    // children live here and scroll; the composer is a pinned sibling
    // below (flex column on the root keeps it anchored to the bottom
    // and lets it ride up as the panel shrinks).
    const scroll = root.createDiv({ cls: "stashpad-detail-scroll" });

    // Header — title + small metadata row + open-in-tab button.
    const header = scroll.createDiv({ cls: "stashpad-detail-header" });
    const titleRow = header.createDiv({ cls: "stashpad-detail-titlerow" });
    titleRow.createDiv({ cls: "stashpad-detail-title", text: this.titleFor(file) });
    const openBtn = titleRow.createEl("button", { cls: "stashpad-detail-open-btn", attr: { "aria-label": "Open in Stashpad tab" } });
    setIcon(openBtn, "arrow-up-right");
    openBtn.title = "Open this note in a new Stashpad tab";
    openBtn.onclick = () => { void this.openInStashpad(sel.folder, sel.id); };

    const metaRow = header.createDiv({ cls: "stashpad-detail-metarow" });
    if (sel.folder) metaRow.createSpan({ cls: "stashpad-detail-meta-chip", text: sel.folder.split("/").pop() || sel.folder });
    if (typeof fm.color === "string" && fm.color) {
      const c = metaRow.createSpan({ cls: "stashpad-detail-meta-color" });
      c.style.background = fm.color;
      c.title = fm.color;
    }
    if (fm.completed === true) metaRow.createSpan({ cls: "stashpad-detail-meta-chip is-completed", text: "✓ completed" });
    if (typeof fm.due === "string" || typeof fm.due === "number") {
      const dueMs = Date.parse(String(fm.due));
      const dueLabel = Number.isNaN(dueMs) ? String(fm.due) : formatDateTime(dueMs, this.plugin.settings);
      metaRow.createSpan({ cls: "stashpad-detail-meta-chip is-due", text: `due ${dueLabel}` });
    }
    if (Array.isArray(fm.tags)) {
      for (const tag of fm.tags.filter((t: unknown): t is string => typeof t === "string")) {
        metaRow.createSpan({ cls: "stashpad-detail-meta-tag", text: `#${tag.replace(/^#/, "")}` });
      }
    }

    // Body — rendered markdown of the note.
    const bodyWrap = scroll.createDiv({ cls: "stashpad-detail-body" });
    try {
      const raw = await this.app.vault.cachedRead(file);
      const stripped = this.stripFrontmatter(raw);
      await MarkdownRenderer.render(this.app, stripped, bodyWrap, file.path, this as any);
    } catch (e) {
      bodyWrap.createDiv({ cls: "stashpad-detail-error", text: `Couldn't read \`${file.path}\`: ${(e as Error).message}` });
    }

    // Footer metadata — author, contributors, modified, children count.
    this.renderFooterMeta(scroll, file, fm, sel);

    // Children list — every direct child of this note (in tree order).
    this.renderChildren(scroll, sel.folder, sel.id);

    // Composer — pinned at the bottom of the panel (sibling of the
    // scroll area, not inside it).
    this.renderComposer(root, sel);

    // Restore composer focus + caret if the rebuild interrupted typing.
    // (Capture into a local — renderComposer reassigns the field, which TS's
    // flow analysis loses across the call, narrowing it to `never`.)
    const input = this.composerInputEl as HTMLTextAreaElement | null;
    if (composerHadFocus && input) {
      input.focus();
      if (composerCaret != null) {
        const c = Math.min(composerCaret, input.value.length);
        try { input.setSelectionRange(c, c); } catch { /* noop */ }
      }
    }
  }

  /** 0.74.4: simplified composer — textarea + send + the shared
   *  #/[[/@ autocomplete. Submitting creates a CHILD of the displayed
   *  note via the active Stashpad view's createNoteUnder, so the new
   *  note lands exactly where the panel context implies. */
  private renderComposer(parent: HTMLElement, sel: { folder: string; id: StashpadId; file: TFile }): void {
    const composer = parent.createDiv({ cls: "stashpad-detail-composer" });
    const ta = composer.createEl("textarea", {
      cls: "stashpad-detail-composer-input",
      attr: { placeholder: "Add a child note…", rows: "2" },
    }) as HTMLTextAreaElement;
    this.composerInputEl = ta;
    // Restore the draft only when it belongs to the displayed note.
    if (this.composerDraftForId === sel.id) {
      ta.value = this.composerDraft;
    } else {
      this.composerDraft = "";
      this.composerDraftForId = sel.id;
    }
    ta.addEventListener("input", () => {
      this.composerDraft = ta.value;
      this.composerDraftForId = sel.id;
    });
    ta.addEventListener("keydown", (e) => {
      // Enter submits; Shift+Enter inserts a newline. Skip while an
      // IME composition or the autocomplete popover is active (the
      // popover handles its own Enter to accept a suggestion).
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        if (this.composerAutocomplete?.isOpen?.()) return;
        e.preventDefault();
        void this.submitComposer(sel);
      }
    });
    // 0.74.7: full-width send button BELOW the textarea. Plus icon +
    // explicit label so the action ("add a child note") is unambiguous.
    const sendBtn = composer.createEl("button", { cls: "stashpad-detail-composer-send", attr: { "aria-label": "Add child note" } });
    setIcon(sendBtn.createSpan({ cls: "stashpad-detail-composer-send-icon" }), "plus");
    sendBtn.createSpan({ cls: "stashpad-detail-composer-send-text", text: "Add child note" });
    sendBtn.title = "Add child note (Enter)";
    sendBtn.onclick = () => void this.submitComposer(sel);

    // Attach the shared composer autocomplete (# tags, [[ links, @…).
    this.composerAutocomplete = new ComposerAutocomplete(this.app, ta);
    this.composerAutocomplete.attach();
  }

  private async submitComposer(sel: { folder: string; id: StashpadId; file: TFile }): Promise<void> {
    const text = (this.composerInputEl?.value ?? "").trim();
    if (!text) return;
    const view = this.plugin.lastActiveStashpadLeaf?.view as any;
    if (!view || view.getViewType?.() !== STASHPAD_VIEW_TYPE || typeof view.createNoteUnder !== "function") {
      new Notice("Open a Stashpad view to add notes.");
      return;
    }
    // createNoteUnder is view-private but callable at runtime; the
    // explicit parentOverride (sel.id) makes the new note a child of
    // the displayed note regardless of the view's current focus.
    try {
      await view.createNoteUnder(text, sel.id);
    } catch (e) {
      new Notice(`Couldn't add note: ${(e as Error).message}`);
      return;
    }
    // Clear the draft + textarea, re-render to show the new child,
    // and keep focus in the composer for rapid successive entry.
    this.composerDraft = "";
    this.composerDraftForId = sel.id;
    if (this.composerInputEl) this.composerInputEl.value = "";
    await this.render();
    setTimeout(() => this.composerInputEl?.focus(), 0);
  }

  /** Sub-section that lists the note's direct children with an
   *  outline-style expander (chevron toggle) on each row that has
   *  grandchildren. 0.74.2 — same pattern as the Pinned panel's
   *  renderPinnedSubtree. Click a label to navigate the active
   *  Stashpad view to that child. */
  private renderChildren(parent: HTMLElement, folder: string, noteId: StashpadId): void {
    const view = this.plugin.lastActiveStashpadLeaf?.view as any;
    if (!view || view.getViewType?.() !== STASHPAD_VIEW_TYPE) return;
    const tree = (view as any).tree;
    if (!tree?.getChildren) return;
    const children = tree.getChildren(noteId) as Array<{ id: string; file: TFile | null }>;
    if (!children || children.length === 0) return;
    const section = parent.createDiv({ cls: "stashpad-detail-children" });
    section.createDiv({ cls: "stashpad-detail-children-header", text: `Children (${children.length})` });
    const list = section.createDiv({ cls: "stashpad-detail-children-list" });
    for (const child of children) {
      if (!child.file) continue;
      this.renderDetailChildRow(list, view, tree, folder, child, 0);
    }
  }

  /** Recursive renderer for one row in the children outline. Handles
   *  expansion via a chevron toggle on rows that have descendants —
   *  toggling adds/removes the child's id to/from this.expanded and
   *  re-renders. Indent depth scales by 16px per level, matching the
   *  Pinned panel convention. */
  private renderDetailChildRow(
    parent: HTMLElement,
    view: any,
    tree: any,
    folder: string,
    node: { id: string; file: TFile | null },
    depth: number,
  ): void {
    if (!node.file) return;
    const fm = (this.app.metadataCache.getFileCache(node.file)?.frontmatter ?? {}) as any;
    const color = typeof fm.color === "string" ? fm.color : null;
    const completed = fm.completed === true;
    const grandchildren = tree.getChildren(node.id) as Array<{ id: string; file: TFile | null }>;
    const hasGrandkids = grandchildren.length > 0;
    const key = `${folder}|${node.id}`;
    const isExpanded = this.expanded.has(key);

    const row = parent.createDiv({ cls: "stashpad-detail-child-row" });
    if (completed) row.addClass("is-completed");
    if (depth > 0) row.style.paddingLeft = `${depth * 16}px`;

    // 0.74.5: HTML5 drag-reorder. Carries the dragged note id; the
    // drop delegates to the active view's reorderToTarget (tree-based,
    // so it works regardless of the view's current focus). Dropping
    // in the top half = before the target, bottom half = after.
    row.draggable = true;
    row.dataset.id = node.id;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", node.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.toggleClass("drop-before", before);
      row.toggleClass("drop-after", !before);
    });
    row.addEventListener("dragleave", () => {
      row.removeClass("drop-before");
      row.removeClass("drop-after");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.removeClass("drop-before");
      row.removeClass("drop-after");
      const draggedId = e.dataTransfer?.getData("text/plain");
      if (!draggedId || draggedId === node.id) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      if (typeof view.reorderToTarget === "function") {
        void view.reorderToTarget([draggedId], node.id, before ? "before" : "after");
      }
    });

    // 0.74.5: full context menu — delegate to the active view's
    // openNoteMenu, which normalizes selection to the right-clicked
    // node before building the menu (so every cmd* action targets
    // this child). Identical menu to the main list.
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const treeNode = tree.get(node.id);
      if (treeNode && typeof view.openNoteMenu === "function") {
        view.openNoteMenu(e, treeNode);
      }
    };

    // 0.74.3: child-count badge instead of a caret. Collapsed = muted
    // count, expanded = accent tint (children listed below). Empty
    // slot for childless rows keeps titles aligned.
    const toggle = row.createSpan({ cls: "stashpad-detail-child-toggle" });
    if (hasGrandkids) {
      renderCountBadge(toggle, grandchildren.length, isExpanded);
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        void this.render();
      };
    }

    // 0.76.10: task checkbox when the child is a task. Click toggles
    // `completed` via the active view (shared undo/log path).
    const isTask = fmHasTag(fm, "task") || fm.task === true || fm.completed !== undefined;
    if (isTask) {
      const cb = row.createSpan({ cls: "stashpad-detail-child-checkbox" });
      setIcon(cb, completed ? "check-square" : "square");
      cb.title = completed ? "Mark not done" : "Mark done";
      // 0.76.12: checkbox owns its pointer events — never selects or
      // navigates the row.
      cb.addEventListener("mousedown", (e) => e.stopPropagation());
      cb.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); });
      cb.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const treeNode = tree.get(node.id);
        if (treeNode && typeof view.toggleCompletedForNode === "function") {
          void view.toggleCompletedForNode(treeNode);
        }
      };
    }

    const icon = row.createSpan({ cls: "stashpad-detail-child-icon" });
    setIcon(icon, hasGrandkids ? "folder-tree" : "file-text");
    if (color) icon.style.color = color;

    const label = row.createSpan({ cls: "stashpad-detail-child-title", text: this.titleFor(node.file) });
    label.onclick = () => { if (view?.navigateTo) view.navigateTo(node.id); };

    if (hasGrandkids && isExpanded) {
      for (const grandchild of grandchildren) {
        this.renderDetailChildRow(parent, view, tree, folder, grandchild, depth + 1);
      }
    }
  }

  /** Author / contributors / last-edit / path footer. Each piece is
   *  optional — we skip the line if there's nothing to show. */
  private renderFooterMeta(parent: HTMLElement, file: TFile, fm: any, sel: { folder: string; id: StashpadId }): void {
    const meta = parent.createDiv({ cls: "stashpad-detail-footer-meta" });
    const lines: Array<{ label: string; value: string }> = [];
    if (typeof fm.author === "string" && fm.author) lines.push({ label: "Author", value: this.stripWikiLink(fm.author) });
    if (Array.isArray(fm.contributors)) {
      const list = fm.contributors
        .filter((c: unknown): c is string => typeof c === "string")
        .map((c: string) => this.stripWikiLink(c));
      if (list.length > 0) lines.push({ label: "Contributors", value: list.join(", ") });
    }
    if (typeof fm.modified === "string") lines.push({ label: "Modified", value: this.formatTime(fm.modified) });
    if (typeof fm.created === "string") lines.push({ label: "Created", value: this.formatTime(fm.created) });
    lines.push({ label: "Path", value: file.path });
    lines.push({ label: "ID", value: sel.id });
    if (lines.length === 0) { meta.remove(); return; }
    for (const line of lines) {
      const row = meta.createDiv({ cls: "stashpad-detail-meta-line" });
      row.createSpan({ cls: "stashpad-detail-meta-key", text: line.label });
      row.createSpan({ cls: "stashpad-detail-meta-val", text: line.value });
    }
  }

  // ---------- Helpers ----------

  private titleFor(file: TFile): string {
    // Strip the trailing -id suffix that Stashpad slug filenames carry.
    return file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ");
  }

  private stripFrontmatter(raw: string): string {
    if (!raw.startsWith("---")) return raw;
    const end = raw.indexOf("\n---", 3);
    if (end < 0) return raw;
    return raw.slice(end + 4).replace(/^\n+/, "");
  }

  private stripWikiLink(s: string): string {
    // Convert [[path|display]] or [[path]] to a friendly display string.
    const m = s.match(/^\[\[(.+?)(?:\|(.+))?\]\]$/);
    if (m) return m[2] ?? (m[1].split("/").pop() ?? m[1]).replace(/\.md$/, "");
    return s;
  }

  private formatTime(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    // 0.76.6: honour the user's date format + timezone prefs instead
    // of the verbose default toLocaleString().
    return formatDateTime(t, this.plugin.settings);
  }

  private async openInStashpad(folder: string, id: StashpadId): Promise<void> {
    try {
      // Navigate the returned leaf — the MRU pointer can still be the old tab.
      const leaf = await this.plugin.activateViewForFolder(folder);
      if (id !== ROOT_ID) this.plugin.navigateLeafTo(leaf, folder, id);
    } catch (e) {
      new Notice(`Couldn't open: ${(e as Error).message}`);
    }
  }
}

/** Open the detail panel in the RIGHT sidebar. Reuses an existing
 *  leaf if one is already open. */
export async function openStashpadDetailView(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(STASHPAD_DETAIL_VIEW_TYPE);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) {
    new Notice("Stashpad: couldn't open the detail panel.");
    return;
  }
  await leaf.setViewState({ type: STASHPAD_DETAIL_VIEW_TYPE, active: true });
  app.workspace.revealLeaf(leaf);
}
