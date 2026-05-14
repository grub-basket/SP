import { App, Modal, Platform, moment, Notice } from "obsidian";

interface LogEv { ts: string; type: string; id: string; payload?: any; author?: string; }

export class LogModal extends Modal {
  private events: LogEv[] = [];
  /** Currently-displayed slice of events (events filtered by typeFilter,
   *  if set). Pagination + render counts always go through this. */
  private visible: LogEv[] = [];
  private shownCount = 0;
  private typeFilter: string | null = null;
  private listEl: HTMLDivElement | null = null;
  private footerEl: HTMLDivElement | null = null;
  private countEl: HTMLSpanElement | null = null;
  private filterSelEl: HTMLSelectElement | null = null;
  private static PAGE = 100;

  constructor(app: App, private text: string, private jsonlPath: string) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Stashpad log");
    this.modalEl.addClass("stashpad-log-modal");

    this.events = [];
    for (const line of this.text.trim().split(/\r?\n/)) {
      if (!line) continue;
      try { this.events.push(JSON.parse(line)); } catch {}
    }
    this.events.reverse();

    const toolbar = this.contentEl.createDiv({ cls: "stashpad-log-toolbar" });
    this.countEl = toolbar.createSpan({ cls: "stashpad-log-count" }) as HTMLSpanElement;
    this.updateCount();

    // Type filter dropdown. Built lazily here, repopulated by
    // refreshTypeFilter whenever events change (e.g. after Clear log).
    this.filterSelEl = toolbar.createEl("select", { cls: "stashpad-log-type-filter" });
    this.filterSelEl.onchange = () => this.setTypeFilter(this.filterSelEl!.value || null);
    this.refreshTypeFilter();

    const revealBtn = toolbar.createEl("button", { text: "Reveal JSONL" });
    revealBtn.onclick = () => this.shellAct("reveal");
    const openBtn = toolbar.createEl("button", { text: "Open in default app" });
    openBtn.onclick = () => this.shellAct("open");

    const copyBtn = toolbar.createEl("button", { text: "Copy raw JSONL" });
    let copyResetTimer: number | null = null;
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(this.text);
      copyBtn.setText("Copied");
      if (copyResetTimer != null) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => { copyBtn.setText("Copy raw JSONL"); copyResetTimer = null; }, 1500);
    };

    const exportBtn = toolbar.createEl("button", { text: "Export copy" });
    exportBtn.onclick = () => this.exportCopy();

    const clearBtn = toolbar.createEl("button", { cls: "mod-warning", text: "Clear log" });
    clearBtn.onclick = () => this.clearLog();

    this.listEl = this.contentEl.createDiv({ cls: "stashpad-log-list" }) as HTMLDivElement;
    this.refreshList();

    this.footerEl = this.contentEl.createDiv({ cls: "stashpad-log-footer" }) as HTMLDivElement;
    this.renderFooter();
  }

  /** Recompute `visible` from `events` + `typeFilter`, then re-render
   *  the list from scratch (resetting pagination). */
  private refreshList(): void {
    if (!this.listEl) return;
    this.visible = this.typeFilter
      ? this.events.filter((ev) => ev.type === this.typeFilter)
      : this.events.slice();
    this.shownCount = 0;
    this.listEl.empty();
    if (!this.visible.length) {
      this.listEl.createDiv({
        cls: "stashpad-log-empty",
        text: this.typeFilter ? `No "${this.typeFilter}" events.` : "No events yet.",
      });
      this.updateCount();
      return;
    }
    this.appendMore(LogModal.PAGE);
  }

  private setTypeFilter(type: string | null): void {
    if ((this.typeFilter ?? null) === (type ?? null)) return;
    this.typeFilter = type;
    this.refreshList();
    this.renderFooter();
  }

  /** Rebuild the type-filter dropdown options from the current events.
   *  Called on first render and after Clear log. */
  private refreshTypeFilter(): void {
    if (!this.filterSelEl) return;
    const sel = this.filterSelEl;
    sel.empty();
    const counts = new Map<string, number>();
    for (const ev of this.events) counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const all = sel.createEl("option", { text: `All types (${this.events.length})` });
    all.value = "";
    for (const [type, n] of entries) {
      const opt = sel.createEl("option", { text: `${type} (${n})` });
      opt.value = type;
    }
    // If the previously-selected filter no longer applies (e.g. its
    // type was cleared away), drop it.
    if (this.typeFilter && !counts.has(this.typeFilter)) {
      this.typeFilter = null;
    }
    sel.value = this.typeFilter ?? "";
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const total = this.visible.length;
    const labelTotal = this.typeFilter
      ? `${total} ${this.typeFilter} event${total === 1 ? "" : "s"}`
      : `${total} event${total === 1 ? "" : "s"}`;
    if (this.shownCount === 0 || this.shownCount >= total) {
      this.countEl.setText(labelTotal);
    } else {
      this.countEl.setText(`Showing ${this.shownCount} of ${labelTotal}`);
    }
  }

  private appendMore(n: number): void {
    if (!this.listEl) return;
    const stop = Math.min(this.visible.length, this.shownCount + n);
    for (let i = this.shownCount; i < stop; i++) {
      this.listEl.appendChild(this.renderEvent(this.visible[i]));
    }
    this.shownCount = stop;
    this.updateCount();
  }

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.empty();
    // Pagination math now runs against the FILTERED set (visible).
    const remaining = this.visible.length - this.shownCount;
    if (remaining <= 0) return;
    const moreBtn = this.footerEl.createEl("button", {
      text: `Load ${Math.min(LogModal.PAGE, remaining)} more`,
    });
    moreBtn.onclick = () => { this.appendMore(LogModal.PAGE); this.renderFooter(); };
    if (remaining > LogModal.PAGE) {
      const allBtn = this.footerEl.createEl("button", { text: `Load all (${remaining})` });
      allBtn.onclick = () => { this.appendMore(remaining); this.renderFooter(); };
    }
  }

  private shellAct(kind: "reveal" | "open"): void {
    try {
      const full = (this.app.vault.adapter as any).getFullPath?.(this.jsonlPath);
      if (!full) throw new Error("no full path");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = (window as any).require("electron");
      if (kind === "reveal") shell.showItemInFolder(full);
      else shell.openPath(full);
    } catch (e) {
      new Notice(`Couldn't ${kind}: ${(e as Error).message}`);
    }
  }

  /** Write the current log content to <log-dir>/<timestamp>-log.jsonl —
   *  same directory as the active log so the copy lives next to its
   *  source. Derived from this.jsonlPath rather than hardcoded. */
  private async exportCopy(): Promise<string | null> {
    try {
      const stamp = (moment as any)().format("YYYY-MM-DD_HHmmss");
      const dir = this.jsonlPath.replace(/\/[^/]+$/, "") || "";
      const exportPath = dir ? `${dir}/${stamp}-log.jsonl` : `${stamp}-log.jsonl`;
      await this.app.vault.adapter.write(exportPath, this.text);
      new Notice(`Exported log → ${exportPath}`);
      return exportPath;
    } catch (e) {
      new Notice(`Export failed: ${(e as Error).message}`);
      return null;
    }
  }

  private clearLog(): void {
    new ConfirmModal(
      this.app,
      "Clear log?",
      "A timestamped copy will be saved alongside the active log before it's truncated.",
      "Export & clear",
      async (ok) => {
        if (!ok) return;
        const exported = await this.exportCopy();
        if (!exported) return; // bail if export failed; don't risk data loss
        try {
          await this.app.vault.adapter.write(this.jsonlPath, "");
        } catch (e) {
          new Notice(`Clear failed: ${(e as Error).message}`);
          return;
        }
        this.text = "";
        this.events = [];
        this.typeFilter = null;
        this.shownCount = 0;
        // Rebuild the dropdown so it shows just "All types (0)" again
        // and resets to that option.
        this.refreshTypeFilter();
        // refreshList renders the empty state and resets counts.
        this.refreshList();
        if (this.footerEl) this.footerEl.empty();
        new Notice("Log cleared.");
      },
    ).open();
  }

  private renderEvent(ev: LogEv): HTMLElement {
    const row = document.createElement("div");
    row.className = `stashpad-log-row stashpad-log-${ev.type}`;

    const when = (moment as any)(ev.ts).isValid()
      ? (moment as any)(ev.ts).format("YYYY-MM-DD HH:mm:ss")
      : ev.ts;

    const ts = document.createElement("span");
    ts.className = "stashpad-log-ts";
    ts.textContent = when;
    row.appendChild(ts);

    const type = document.createElement("span");
    type.className = "stashpad-log-type";
    type.textContent = ev.type;
    row.appendChild(type);

    // Author column — author of THIS log entry (not the note's author).
    // For "create" actions this is the same as the note's author; for
    // "parent_change", "rename", "delete", etc., it tells you who
    // performed the action regardless of who originally created the
    // note. Older log lines without this field render as "—" so the
    // column stays aligned.
    const author = document.createElement("span");
    author.className = "stashpad-log-author";
    author.textContent = ev.author ? ev.author : "—";
    if (!ev.author) author.classList.add("is-empty");
    row.appendChild(author);

    const msg = document.createElement("span");
    msg.className = "stashpad-log-msg";
    msg.textContent = this.describe(ev);
    row.appendChild(msg);

    return row;
  }

  private describe(ev: LogEv): string {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case "create": return `Created "${p.path ?? ev.id}" under ${p.parent ?? "?"}`;
      case "delete": {
        const atts = Array.isArray(p.attachmentsRemoved) ? p.attachmentsRemoved.length : 0;
        const merged = p.mergedInto ? ` (merged into ${p.mergedInto})` : "";
        return `Deleted ${ev.id}${merged}${atts ? ` — also removed ${atts} attachment${atts === 1 ? "" : "s"}` : ""}`;
      }
      case "missing": return `Missing: ${p.lastPath ?? ev.id}`;
      case "parent_change": {
        const reason = p.reason ? ` (${p.reason})` : "";
        return `Moved ${ev.id} from ${p.from ?? "null"} → ${p.to ?? "null"}${reason}`;
      }
      case "rename": return `Renamed ${p.from ?? "?"} → ${p.to ?? "?"}`;
      case "reorder": {
        const n = p.count ?? 1;
        const dir = p.dir ?? "?";
        const parent = p.parent ?? ev.id ?? "?";
        return `Reordered ${n} note${n === 1 ? "" : "s"} (${dir}) under ${parent}`;
      }
      case "complete": {
        const n = p.count ?? 1;
        const tag = p.undo ? " (undo)" : p.redo ? " (redo)" : "";
        return `Marked ${n} note${n === 1 ? "" : "s"} complete${tag}`;
      }
      case "uncomplete": {
        const n = p.count ?? 1;
        const tag = p.undo ? " (undo)" : p.redo ? " (redo)" : "";
        return `Unmarked ${n} note${n === 1 ? "" : "s"}${tag}`;
      }
      case "stash_export": {
        const n = p.noteCount ?? "?";
        return `Exported ${n} note${n === 1 ? "" : "s"} → ${p.path ?? "?"}`;
      }
      case "stash_import": {
        const n = p.noteCount ?? "?";
        const extras: string[] = [];
        if (p.attachmentsWritten) extras.push(`${p.attachmentsWritten} attachment${p.attachmentsWritten === 1 ? "" : "s"}`);
        if (p.collisionsRenamed) extras.push(`${p.collisionsRenamed} renamed`);
        const tail = extras.length ? ` (${extras.join(", ")})` : "";
        return `Imported ${n} note${n === 1 ? "" : "s"} from ${p.from ?? "?"} → ${p.into ?? "?"}${tail}`;
      }
      case "attachment_add": return `Added attachment ${p.path ?? ev.id}`;
      case "attachment_remove": return `Removed attachment ${p.path ?? ev.id}`;
      case "palette_color_add": return `Added palette color ${p.color ?? ev.id}`;
      case "palette_color_remove": return `Removed palette color ${p.color ?? ev.id}`;
      default: return JSON.stringify(p);
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

export class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private noteTitle: string,
    private descendantCount: number,
    private attachmentCount: number,
    /** When false, the "Also delete attachments" checkbox is suppressed
     *  and onChoose is invoked with deleteAttachments=false. Lets the
     *  caller open the modal purely for descendant/multi-select
     *  confirmation while honoring the "Offer to delete attachments"
     *  setting being OFF. */
    private offerAttachmentDelete: boolean,
    private onChoose: (deleteAttachments: boolean) => void,
  ) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText(`Delete "${this.noteTitle}"?`);
    const parts: string[] = [];
    if (this.descendantCount > 0) parts.push(`${this.descendantCount} descendant note${this.descendantCount === 1 ? "" : "s"} will also be deleted.`);
    if (this.attachmentCount > 0) parts.push(`${this.attachmentCount} attachment${this.attachmentCount === 1 ? "" : "s"} found across these notes.`);
    this.contentEl.createEl("p", { text: parts.join(" ") });

    let deleteAtts = this.offerAttachmentDelete && this.attachmentCount > 0;
    if (this.offerAttachmentDelete && this.attachmentCount > 0) {
      const label = this.contentEl.createEl("label", { cls: "stashpad-modal-check" });
      const cb = label.createEl("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = deleteAtts;
      cb.onchange = () => { deleteAtts = cb.checked; };
      label.createSpan({ text: " Also delete attachments" });
    }

    const row = this.contentEl.createDiv({ cls: "stashpad-modal-btns" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const del = row.createEl("button", { cls: "mod-warning", text: "Delete" });
    del.onclick = () => { this.close(); this.onChoose(deleteAtts); };
  }
  onClose(): void { this.contentEl.empty(); }
}

export class SplitNoteModal extends Modal {
  private lines: string[];
  /** Line mode: index of the FIRST line of the second part (1..lines.length-1). */
  private lineCursorIdx: number;
  private mode: "line" | "cursor" = "line";
  private cursorTextarea: HTMLTextAreaElement | null = null;
  constructor(
    app: App,
    private body: string,
    private onSplitAtLine: (firstLineOfSecondPart: number) => void,
    private onSplitAtChar: (charIndex: number) => void,
  ) {
    super(app);
    this.lines = body.replace(/\r\n/g, "\n").split("\n");
    this.lineCursorIdx = Math.max(1, Math.min(this.lines.length - 1, Math.floor(this.lines.length / 2)));
    // Single-line notes can only be split via cursor mode.
    if (this.lines.length < 2) this.mode = "cursor";
  }

  onOpen(): void {
    this.titleEl.setText("Split note");
    this.modalEl.addClass("stashpad-split-modal");
    this.render();
    // Tab toggles modes when both are available.
    this.scope.register([], "Tab", (e) => {
      if (this.lines.length < 2) return;
      e.preventDefault();
      this.mode = this.mode === "line" ? "cursor" : "line";
      this.render();
    });
    // Enter (no mods): commit in line mode; in cursor mode, let textarea insert a newline.
    this.scope.register([], "Enter", (e) => {
      if (this.mode !== "line") return; // pass through to textarea
      e.preventDefault();
      this.commitLine();
    });
    // Mod+Enter: commit in cursor mode.
    this.scope.register(["Mod"], "Enter", (e) => {
      if (this.mode !== "cursor") return;
      e.preventDefault();
      this.commitCursor();
    });
    // Arrows: in line mode, move the divider. In cursor mode, let textarea handle them.
    this.scope.register([], "ArrowUp", (e) => {
      if (this.mode !== "line") return;
      e.preventDefault();
      this.lineCursorIdx = Math.max(1, this.lineCursorIdx - 1);
      this.render();
    });
    this.scope.register([], "ArrowDown", (e) => {
      if (this.mode !== "line") return;
      e.preventDefault();
      this.lineCursorIdx = Math.min(this.lines.length - 1, this.lineCursorIdx + 1);
      this.render();
    });
  }

  private commitLine(): void {
    const idx = this.lineCursorIdx;
    this.close();
    this.onSplitAtLine(idx);
  }

  private commitCursor(): void {
    const ta = this.cursorTextarea;
    if (!ta) return;
    const ch = ta.selectionStart;
    if (ch <= 0 || ch >= ta.value.length) {
      new Notice("Move the cursor inside the text — neither end can be empty.");
      return;
    }
    this.close();
    this.onSplitAtChar(ch);
  }

  private render(): void {
    this.contentEl.empty();

    // Top bar: mode toggle on the left, Confirm button on the right.
    // The confirm button is essential on mobile where Enter is hijacked
    // by the textarea (cursor mode) or doesn't have a physical key
    // (some on-screen keyboards send "Done" instead).
    const bar = this.contentEl.createDiv({ cls: "stashpad-split-toggle-bar" });
    if (this.lines.length >= 2) {
      const lineBtn = bar.createEl("button", { text: "Line split", cls: "stashpad-split-mode-btn" });
      if (this.mode === "line") lineBtn.addClass("is-active");
      lineBtn.onclick = () => { this.mode = "line"; this.render(); };
    }
    const curBtn = bar.createEl("button", { text: "Cursor split", cls: "stashpad-split-mode-btn" });
    if (this.mode === "cursor") curBtn.addClass("is-active");
    curBtn.onclick = () => { this.mode = "cursor"; this.render(); };

    const confirmBtn = bar.createEl("button", {
      text: "Split", cls: "stashpad-split-confirm-btn mod-cta",
    });
    confirmBtn.onmousedown = (e) => e.preventDefault(); // don't blur the textarea
    confirmBtn.onclick = () => {
      if (this.mode === "line") this.commitLine();
      else this.commitCursor();
    };

    if (this.mode === "line") this.renderLineMode();
    else this.renderCursorMode();

    const help = this.contentEl.createDiv({ cls: "stashpad-split-help" });
    if (Platform.isMobile) {
      help.setText(this.mode === "line"
        ? "Tap a line to position the divider, then Split."
        : "Tap inside the text to position the cursor, then Split.");
    } else {
      help.setText(this.mode === "line"
        ? "↑/↓ pick split line  ·  Enter or Split confirm  ·  Tab → cursor mode  ·  Esc cancel  ·  Children stay with the first part"
        : "Click or arrow to position cursor  ·  Mod+Enter or Split confirm  ·  Tab → line mode  ·  Esc cancel  ·  Children stay with the first part");
    }
  }

  private renderLineMode(): void {
    const list = this.contentEl.createDiv({ cls: "stashpad-split-list" });
    for (let i = 0; i < this.lines.length; i++) {
      if (i === this.lineCursorIdx) {
        list.createDiv({ cls: "stashpad-split-divider", text: "── split here ──" });
      }
      const ln = list.createDiv({ cls: "stashpad-split-line" });
      ln.createSpan({ cls: "stashpad-split-lineno", text: String(i + 1) });
      ln.createSpan({ cls: "stashpad-split-text", text: this.lines[i] || " " });
      // Tap-to-position on mobile: tapping a line moves the divider to
      // start of THAT line (it becomes the first line of the second
      // part). On desktop this is also a nicer UX than only arrows.
      ln.onclick = () => {
        const target = Math.max(1, Math.min(this.lines.length - 1, i));
        if (target === this.lineCursorIdx) return;
        this.lineCursorIdx = target;
        this.render();
      };
    }
  }

  private renderCursorMode(): void {
    const wrap = this.contentEl.createDiv({ cls: "stashpad-split-cursor-wrap" });
    const ta = wrap.createEl("textarea", { cls: "stashpad-split-cursor-ta" }) as HTMLTextAreaElement;
    ta.value = this.body;
    ta.readOnly = false;
    this.cursorTextarea = ta;
    // Auto-size the textarea to fit content. Cap at 3 lines on mobile,
    // 12 lines on desktop. Recomputed on input in case the user edits.
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22;
    const maxLines = Platform.isMobile ? 3 : 12;
    const minLines = 2;
    const fit = (): void => {
      ta.style.height = "auto";
      const needed = Math.min(ta.scrollHeight, lineHeight * maxLines + 16);
      ta.style.height = `${Math.max(needed, lineHeight * minLines + 16)}px`;
    };
    requestAnimationFrame(() => {
      fit();
      const mid = Math.floor(ta.value.length / 2);
      ta.focus();
      ta.setSelectionRange(mid, mid);
    });
    ta.addEventListener("input", fit);
  }

  onClose(): void {
    this.cursorTextarea = null;
    this.contentEl.empty();
  }
}

/** Submenu opened from the "+" tile in ColorPickerModal. Lets the user pick
 *  any hex color, then either save (apply once) or add (apply + persist to
 *  the palette). Closing without a button applies as "save" (consistent
 *  with the user's hasty-apply expectation). */
export class CustomColorModal extends Modal {
  private value: string;
  private delivered = false;
  constructor(
    app: App,
    seed: string | null,
    private onResult: (color: string | null, opts: { addToPalette: boolean }) => void,
  ) {
    super(app);
    this.value = seed && /^#[0-9a-f]{6}$/i.test(seed) ? seed : "#888888";
  }
  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Custom color");
    this.modalEl.addClass("stashpad-custom-color-modal");

    const row = this.contentEl.createDiv({ cls: "stashpad-custom-color-row" });
    const preview = row.createDiv({ cls: "stashpad-custom-color-preview" });
    preview.style.background = this.value;

    // Native wheel — clicking the preview pops the OS color picker.
    const wheel = row.createEl("input", { type: "color" }) as HTMLInputElement;
    wheel.value = this.value;
    wheel.addClass("stashpad-custom-color-wheel");
    preview.onclick = () => wheel.click();

    // Hex text input for direct entry. Synced both ways with the wheel.
    const hex = row.createEl("input", { type: "text" }) as HTMLInputElement;
    hex.addClass("stashpad-custom-color-hex");
    hex.placeholder = "#RRGGBB";
    hex.value = this.value;
    hex.maxLength = 7;

    const sync = (next: string) => {
      const v = next.startsWith("#") ? next : "#" + next;
      if (!/^#[0-9a-f]{6}$/i.test(v)) return;
      this.value = v;
      preview.style.background = v;
      wheel.value = v;
      if (hex.value !== v) hex.value = v;
    };
    wheel.oninput = () => sync(wheel.value);
    hex.oninput = () => sync(hex.value);

    const footer = this.contentEl.createDiv({ cls: "stashpad-color-footer" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.delivered = true; this.close(); };
    const save = footer.createEl("button", { cls: "mod-cta", text: "Save" });
    save.title = "Apply this color to the selection (without adding to your palette).";
    save.onclick = () => this.commit({ addToPalette: false });
    const add = footer.createEl("button", { cls: "mod-cta", text: "Add to palette" });
    add.title = "Apply and save this color so it appears as a tile next time.";
    add.onclick = () => this.commit({ addToPalette: true });

    this.scope.register([], "Enter", (e) => { e.preventDefault(); this.commit({ addToPalette: false }); });
    this.scope.register(["Mod"], "Enter", (e) => { e.preventDefault(); this.commit({ addToPalette: true }); });

    requestAnimationFrame(() => hex.focus());
  }
  private commit(opts: { addToPalette: boolean }): void {
    this.delivered = true;
    this.close();
    this.onResult(this.value, opts);
  }
  onClose(): void {
    if (!this.delivered) {
      // Click-out / Esc → apply hastily (no palette persistence), matching
      // the user's "skip adding" intent.
      this.delivered = true;
      this.onResult(this.value, { addToPalette: false });
    }
    this.contentEl.empty();
  }
}

/** Compact color picker. Presents a grid of preset swatches and the user's
 *  saved custom palette, plus a "+" tile that opens CustomColorModal for
 *  arbitrary hex picking. The "no color" tile (slash) clears the assignment.
 *
 *  Behavior:
 *  - Arrow keys navigate the grid; Enter activates the highlighted tile.
 *    For preset/saved tiles that means apply-and-close. For the "+" tile
 *    it opens the custom-color submenu (this modal stays open behind it).
 *  - There is no Save button on this modal — clicking a preset is the
 *    explicit "apply" action.
 */
export class ColorPickerModal extends Modal {
  static DEFAULT_PALETTE: string[] = [
    "#E07A78", "#E08A47", "#E0A744", "#B0CC6E", "#6BC07A",
    "#5BA9CE", "#9B82C9", "#C57AB5", "#D75AA8",
  ];

  /** Active grid index for keyboard nav. -1 = no focus yet. */
  private focusIdx = -1;
  /** Snapshot of selectable tiles in render order. The "+" tile is `kind:
   *  "add"` and opens CustomColorModal rather than committing directly. */
  private items: { kind: "none" | "preset" | "custom" | "add"; color: string | null; el: HTMLElement }[] = [];

  constructor(
    app: App,
    private currentColor: string | null,
    private customPalette: string[],
    private onPick: (color: string | null, opts: { addToPalette?: boolean }) => void,
    /** Optional: invoked when the user clicks the ✕ on a saved tile.
     *  The host should remove the color from settings.customPalette and log
     *  the deletion. Returning a fresh palette array updates this modal in
     *  place so the user can keep deleting. */
    private onDeleteCustom?: (color: string) => Promise<string[]> | string[],
  ) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Pick a color");
    this.modalEl.addClass("stashpad-color-modal");

    const grid = this.contentEl.createDiv({ cls: "stashpad-color-grid" });
    this.items = [];

    // "No color" tile (slash).
    const noTile = grid.createDiv({ cls: "stashpad-color-tile stashpad-color-none" });
    noTile.title = "No color";
    noTile.onclick = () => this.activate(0);
    this.items.push({ kind: "none", color: null, el: noTile });

    const allPresets = [...ColorPickerModal.DEFAULT_PALETTE, ...this.customPalette];
    for (const c of allPresets) {
      const tile = grid.createDiv({ cls: "stashpad-color-tile" });
      tile.style.background = c;
      tile.title = c;
      const isCustom = !ColorPickerModal.DEFAULT_PALETTE.some((d) => d.toLowerCase() === c.toLowerCase());
      const idx = this.items.length;
      tile.onclick = () => this.activate(idx);
      // Saved-custom tiles get a ✕ that deletes them from the persisted
      // palette. Defaults aren't deletable.
      if (isCustom && this.onDeleteCustom) {
        const del = tile.createSpan({ cls: "stashpad-color-tile-del", text: "×" });
        del.title = "Remove from palette";
        del.onclick = (e) => {
          e.stopPropagation();
          void this.handleDelete(c);
        };
      }
      this.items.push({ kind: isCustom ? "custom" : "preset", color: c, el: tile });
    }

    // "+" tile that opens the custom-color submenu.
    const addTile = grid.createDiv({ cls: "stashpad-color-tile stashpad-color-add" });
    addTile.title = "Custom color…";
    const addIdx = this.items.length;
    addTile.onclick = () => this.activate(addIdx);
    this.items.push({ kind: "add", color: null, el: addTile });

    // Initial focus: the tile matching currentColor, else the first preset.
    const seedIdx = this.items.findIndex((it) => {
      if (this.currentColor === null) return it.kind === "none";
      if (!this.currentColor) return false;
      return it.color !== null && it.color.toLowerCase() === this.currentColor.toLowerCase();
    });
    this.focusIdx = seedIdx >= 0 ? seedIdx : 0;
    this.refreshActive();

    // Keyboard nav: arrows move focus; Enter activates.
    this.scope.register([], "ArrowRight", (e) => { e.preventDefault(); this.moveFocus(1); });
    this.scope.register([], "ArrowLeft",  (e) => { e.preventDefault(); this.moveFocus(-1); });
    this.scope.register([], "ArrowDown",  (e) => { e.preventDefault(); this.moveFocus(this.columns()); });
    this.scope.register([], "ArrowUp",    (e) => { e.preventDefault(); this.moveFocus(-this.columns()); });
    this.scope.register([], "Enter",      (e) => { e.preventDefault(); this.activate(this.focusIdx); });

    // After paint, focus the modal so arrow keys land here, not in the
    // background view.
    requestAnimationFrame(() => (this.modalEl as HTMLElement).focus());
  }

  /** Click or Enter on a tile. Preset/saved/none → apply immediately + close.
   *  Add → open the custom-color submenu (this modal hands off and closes). */
  private activate(i: number): void {
    if (i < 0 || i >= this.items.length) return;
    this.focusIdx = i;
    this.refreshActive();
    const it = this.items[i];
    if (it.kind === "add") {
      // Hand off to the custom submenu. We close this modal first so we
      // don't stack two on top of each other; the submenu fires onPick.
      this.close();
      new CustomColorModal(this.app, this.currentColor, (color, opts) => {
        this.onPick(color, opts);
      }).open();
      return;
    }
    this.close();
    this.onPick(it.color, { addToPalette: false });
  }

  /** Approximate column count from the rendered grid (for vertical arrows). */
  private columns(): number {
    if (!this.items.length) return 1;
    const grid = this.items[0].el.parentElement;
    if (!grid) return 1;
    const gridRect = grid.getBoundingClientRect();
    const tileRect = this.items[0].el.getBoundingClientRect();
    if (tileRect.width <= 0) return 1;
    // Rough: total width / (tile + gap). We use the displayed positions to
    // count tiles in the first row instead — more robust to gap rounding.
    const firstTop = tileRect.top;
    let cols = 0;
    for (const it of this.items) {
      const r = it.el.getBoundingClientRect();
      if (Math.abs(r.top - firstTop) < 1) cols++;
      else break;
    }
    void gridRect;
    return Math.max(1, cols);
  }

  private async handleDelete(color: string): Promise<void> {
    if (!this.onDeleteCustom) return;
    try {
      const next = await this.onDeleteCustom(color);
      // Re-render the grid in place with the updated palette so the user
      // can keep tidying.
      this.customPalette = Array.isArray(next) ? next : this.customPalette.filter((c) => c.toLowerCase() !== color.toLowerCase());
      this.onOpen();
    } catch (e) {
      // Swallow: host can show its own notice.
      console.warn("Stashpad: palette delete failed", e);
    }
  }

  private moveFocus(delta: number): void {
    if (!this.items.length) return;
    const next = Math.max(0, Math.min(this.items.length - 1, this.focusIdx + delta));
    this.focusIdx = next;
    this.refreshActive();
  }

  private refreshActive(): void {
    for (let i = 0; i < this.items.length; i++) {
      this.items[i].el.toggleClass("is-active", i === this.focusIdx);
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private message: string,
    private confirmText: string,
    private onChoose: (confirmed: boolean) => void,
  ) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.message });
    const row = this.contentEl.createDiv({ cls: "stashpad-modal-btns" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.close(); this.onChoose(false); };
    const ok = row.createEl("button", { cls: "mod-cta", text: this.confirmText });
    ok.onclick = () => { this.close(); this.onChoose(true); };
    // Focus the confirm button so Enter accepts.
    requestAnimationFrame(() => ok.focus());
  }
  onClose(): void { this.contentEl.empty(); }
}
