import { App, ItemView, Modal, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import { parseImport, DEFAULT_IMPORT_OPTIONS, type ImportOptions, type ImportNote } from "./text-importer";
import { ColorPickerModal } from "./modals";
import { BUILTIN_COLOR_NAMES } from "./text-importer";

/** hex (lower-case) -> human name, inverted from BUILTIN_COLOR_NAMES.
 *
 *  0.211.2: the per-row colour control is a native <select>, and on macOS that
 *  renders as a NATIVE menu — no swatches, no styling, just the option text. A list
 *  of raw hex codes there is unreadable. The names already exist for parsing
 *  "[color: Amber]", so reuse them rather than inventing a second vocabulary.
 *  Built once; the first name wins, so the canonical nine beat their synonyms. */
const HEX_TO_NAME: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [name, hex] of Object.entries(BUILTIN_COLOR_NAMES)) {
    const key = hex.toLowerCase();
    if (!out[key]) out[key] = name.charAt(0).toUpperCase() + name.slice(1);
  }
  return out;
})();

export const TEXT_IMPORT_VIEW_TYPE = "stashpad-text-import";

/** State handed to the popped-out tab so nothing typed is lost. */
export interface ImporterState { text: string; opts: ImportOptions }

export interface ImporterCallbacks {
  onImport: (notes: ImportNote[]) => void | Promise<void>;
  /** Dismiss the host (modal close / tab detach). */
  close: () => void;
  /** Present only on the modal — pops the importer out into a full tab. */
  popOut?: (state: ImporterState) => void;
  /** Where level-1 notes land, for the hint line. */
  destinationLabel: string;
}

/** 0.193.0 — the importer UI, extracted so it can render into EITHER a modal or a
 *  full leaf, the same shape as NoteWorkbench. Pasting a long outline in a small
 *  modal is cramped, so the tab is the better home for a big import. */
export class TextImporterUI {
  private text: string;
  private opts: ImportOptions;
  private notes: ImportNote[] = [];
  private previewEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  /** Shown after an import, since the surface no longer closes to signal success. */
  private importedEl: HTMLElement | null = null;
  private lastImported = 0;
  /** 0.211.0: per-row user overrides, by row index. Kept SEPARATE from the parsed
   *  notes so re-parsing (an option change, an edit to the text) does not wipe
   *  them — they are re-applied after every parse. */
  private levelDelta = new Map<number, number>();
  private colorOverride = new Map<number, string>();
  private importBtn: HTMLButtonElement | null = null;

  constructor(private app: App, private host: HTMLElement, init: Partial<ImporterState>, private cbs: ImporterCallbacks) {
    this.text = init.text ?? "";
    this.opts = { ...DEFAULT_IMPORT_OPTIONS, ...(init.opts ?? {}) };
    this.render();
  }

  getState(): ImporterState { return { text: this.text, opts: { ...this.opts } }; }

  private render(): void {
    const c = this.host;
    c.empty();
    c.addClass("stashpad-import-host");

    c.createDiv({
      cls: "setting-item-description",
      text: `One note per line. Indent (or a "- " list) nests a note under the one above. Level-1 notes go into ${this.cbs.destinationLabel}.`,
    });

    const ta = c.createEl("textarea", { cls: "stashpad-import-input" });
    ta.rows = 10;
    ta.value = this.text;
    ta.placeholder = "Paste your text here…\n\nGroceries\n  - milk\n  - [x] eggs\nCall the dentist";
    ta.addEventListener("input", () => { this.text = ta.value; this.refresh(); });

    const opt = (name: string, desc: string, key: keyof ImportOptions): void => {
      new Setting(c).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(this.opts[key]).onChange((v) => { this.opts[key] = v; this.refresh(); }));
    };
    opt("Indentation nests notes", "Leading tabs or spaces set how deep a note nests (2 spaces or 1 tab per level).", "detectIndent");
    opt("Strip list markers", 'Treat a leading "- ", "* " or "1." as a bullet: removed from the text and used for nesting.', "detectLists");
    opt("Keep code blocks whole", "A ``` fenced block stays in one note instead of splitting line by line.", "keepCodeBlocks");
    opt("Paragraph mode", "Consecutive lines form ONE note and a blank line starts the next — for pasting prose. Off = one note per line.", "paragraphMode");
    opt("Read tasks and colours", 'Understand "[x] done" checkboxes and "[color: red]" / "[color: #hex | alias: name]" tags — so text copied out of Stashpad pastes back with its tasks and colours intact.', "parseMeta");
    opt(
      "Pasted from the old Stashpad desktop app",
      "That app exports the top parent with no bullet and no indent, its children with a bullet but STILL no indent, and only starts indenting at the third level — so by indent alone the first two levels look identical and the tree flattens. Turn this on and a bullet counts as one level deeper. Leave it OFF for ordinary markdown, where a paragraph followed by a list is not nesting.",
      "markerAddsLevel",
    );

    this.countEl = c.createDiv({ cls: "setting-item-description stashpad-import-count" });
    this.importedEl = c.createDiv({ cls: "setting-item-description stashpad-import-done" });
    this.importedEl.hide();
    this.previewEl = c.createDiv({ cls: "stashpad-import-preview" });

    const btns = c.createDiv({ cls: "stashpad-split-actions" });
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.cbs.close();
    if (this.cbs.popOut) {
      const pop = btns.createEl("button", { text: "Open in a tab" });
      setIcon(pop.createSpan({ cls: "stashpad-import-popicon" }), "external-link");
      pop.onclick = () => this.cbs.popOut!(this.getState());
    }
    this.importBtn = btns.createEl("button", { cls: "mod-cta", text: "Import" });
    this.importBtn.onclick = () => {
      if (!this.notes.length) return;
      const notes = this.notes;
      // 0.210.0: do NOT close on import. Closing threw away the pasted text and the
      // options along with it, so importing a second batch — or fixing the indent
      // settings and re-importing — meant pasting everything again. The receipt
      // notification carries a "Show imported notes" button, so the way to the
      // result no longer depends on this surface closing itself. Cancel still
      // closes, and the popped-out tab is closed the normal way.
      void this.cbs.onImport(notes);
      this.lastImported = notes.length;
      this.refresh();
    };

    this.refresh();
    window.setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  /** Re-parse and repaint the preview — cheap enough for every keystroke. */
  private refresh(): void {
    this.notes = this.text.trim() ? parseImport(this.text, this.opts) : [];
    // Re-apply the per-row overrides on top of the fresh parse. Level is clamped to
    // >= 1 and to at most one deeper than the previous row, which is the same rule
    // the parser enforces — otherwise a nested row could claim a level with no
    // parent above it and the tree builder would silently reattach it elsewhere.
    if (this.levelDelta.size || this.colorOverride.size) {
      this.notes = this.notes.map((n, i) => {
        const delta = this.levelDelta.get(i) ?? 0;
        const color = this.colorOverride.get(i);
        if (!delta && !color) return n;
        return { ...n, level: Math.max(1, n.level + delta), ...(color ? { color } : {}) };
      });
      for (let i = 0; i < this.notes.length; i++) {
        const maxAllowed = i === 0 ? 1 : this.notes[i - 1].level + 1;
        if (this.notes[i].level > maxAllowed) this.notes[i] = { ...this.notes[i], level: maxAllowed };
      }
    }
    const n = this.notes.length;
    this.countEl?.setText(n === 0 ? "Nothing to import yet." : `${n} note${n === 1 ? "" : "s"} will be created:`);
    if (this.importBtn) {
      this.importBtn.disabled = n === 0;
      this.importBtn.setText(n === 0 ? "Import" : `Import ${n} note${n === 1 ? "" : "s"}`);
    }
    // The surface stays open after importing now, so it has to say so itself —
    // otherwise a successful import looks like nothing happened.
    if (this.importedEl) {
      if (this.lastImported > 0) {
        this.importedEl.setText(
          `✅ Imported ${this.lastImported} note${this.lastImported === 1 ? "" : "s"}. `
          + "Use “Show imported notes” on the notification to jump to them. "
          + "Your text and options are still here — edit and import again, or Cancel to close.",
        );
        this.importedEl.show();
      } else {
        this.importedEl.hide();
      }
    }
    const p = this.previewEl;
    if (!p) return;
    p.empty();
    for (const note of this.notes) {
      const row = p.createDiv({ cls: "stashpad-import-row" });
      row.style.paddingLeft = `${(note.level - 1) * 18}px`;
      if (note.task !== "none") {
        row.createSpan({ cls: "stashpad-import-check", text: note.task === "done" ? "☑" : "☐" });
      }
      if (note.color) {
        const dot = row.createSpan({ cls: "stashpad-import-dot" });
        dot.style.background = note.color;
        dot.title = note.colorAlias ? `${note.colorAlias} (${note.color})` : note.color;
      } else if (note.colorName) {
        // A name we couldn't resolve here — the import still tries the folder's aliases.
        row.createSpan({ cls: "stashpad-import-more", text: `[${note.colorName}?]` });
      }
      const first = note.body.replace(/^\[[ x]\]\s*/, "").split("\n")[0];
      row.createSpan({ cls: "stashpad-import-text", text: first || "(empty)" });
      const extra = note.body.split("\n").length - 1;
      if (extra > 0) row.createSpan({ cls: "stashpad-import-more", text: ` +${extra} line${extra === 1 ? "" : "s"}` });

      // 0.211.0: per-row controls, the "neat features" the web app had.
      //
      // These are OVERRIDES layered on top of the parse, keyed by row index and
      // re-applied on every refresh — so changing an option or editing the text
      // does not silently discard them, and a row that disappears simply stops
      // having its override applied.
      const ctrls = row.createDiv({ cls: "stashpad-import-rowctl" });

      // Nest under the line above / outdent. Solves any shape the parser cannot
      // infer, including exports this toggle set does not anticipate.
      const idx = this.notes.indexOf(note);
      const nestBtn = ctrls.createEl("button", { cls: "stashpad-import-ctlbtn", text: "→" });
      nestBtn.title = "Nest under the line above";
      nestBtn.disabled = idx === 0 || note.level > (this.notes[idx - 1]?.level ?? 0);
      nestBtn.onclick = () => { this.levelDelta.set(idx, (this.levelDelta.get(idx) ?? 0) + 1); this.refresh(); };
      const outBtn = ctrls.createEl("button", { cls: "stashpad-import-ctlbtn", text: "←" });
      outBtn.title = "Move out one level";
      outBtn.disabled = note.level <= 1;
      outBtn.onclick = () => { this.levelDelta.set(idx, (this.levelDelta.get(idx) ?? 0) - 1); this.refresh(); };

      // Colour, from Stashpad's own palette.
      const sel = ctrls.createEl("select", { cls: "stashpad-import-color" });
      const none = sel.createEl("option", { text: "(no colour)" });
      none.value = "";
      for (const hex of ColorPickerModal.DEFAULT_PALETTE) {
        // Name when we know it, hex only as a fallback for a custom colour.
        const o = sel.createEl("option", { text: HEX_TO_NAME[hex.toLowerCase()] ?? hex });
        o.value = hex;
      }
      sel.value = this.colorOverride.get(idx) ?? note.color ?? "";
      sel.onchange = () => {
        if (sel.value) this.colorOverride.set(idx, sel.value);
        else this.colorOverride.delete(idx);
        this.refresh();
      };
    }
  }
}

/** Modal host — the default entry point, with a pop-out button. */
export class TextImportModal extends Modal {
  private ui: TextImporterUI | null = null;
  constructor(
    app: App,
    private destinationLabel: string,
    private onImport: (notes: ImportNote[]) => void | Promise<void>,
    private popOut?: (state: ImporterState) => void,
    private init: Partial<ImporterState> = {},
  ) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("stashpad-import-modal");
    this.titleEl.setText("Import pasted text");
    this.ui = new TextImporterUI(this.app, this.contentEl, this.init, {
      destinationLabel: this.destinationLabel,
      onImport: this.onImport,
      close: () => this.close(),
      popOut: this.popOut ? (state) => { this.close(); this.popOut!(state); } : undefined,
    });
  }
  onClose(): void { this.ui = null; this.contentEl.empty(); }
}

/** Context injected into a popped-out importer tab, mirroring NoteWorkbenchView. */
export interface ImporterViewContext {
  state: Partial<ImporterState>;
  destinationLabel: string;
  onImport: (notes: ImportNote[]) => void | Promise<void>;
  prevLeaf?: WorkspaceLeaf | null;
}

/** Full-leaf host — roomier for a long paste. Ephemeral: needs its context injected
 *  right after creation, and a restored-but-context-less tab shows a placeholder. */
export class TextImportView extends ItemView {
  private ui: TextImporterUI | null = null;
  private ctx: ImporterViewContext | null = null;
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType(): string { return TEXT_IMPORT_VIEW_TYPE; }
  getDisplayText(): string { return "Import pasted text"; }
  getIcon(): string { return "clipboard-paste"; }

  setContext(ctx: ImporterViewContext): void {
    this.ctx = ctx;
    this.renderUI();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("stashpad-import-host", "stashpad-import-view");
    if (!this.ctx) {
      // Give an in-flight setContext a beat before declaring the tab dead.
      window.setTimeout(() => { if (!this.ctx) this.renderExpired(); }, 800);
    }
  }

  private renderUI(): void {
    const c = this.contentEl;
    c.empty();
    if (!this.ctx) return;
    this.ui = new TextImporterUI(this.app, c, this.ctx.state, {
      destinationLabel: this.ctx.destinationLabel,
      onImport: this.ctx.onImport,
      close: () => this.closeAndRefocus(),
    });
  }

  private renderExpired(): void {
    const c = this.contentEl;
    c.empty();
    c.createDiv({ cls: "stashpad-split-done" })
      .createDiv({ cls: "stashpad-split-done-title", text: "This import session has expired — reopen it from the command palette." });
  }

  private closeAndRefocus(): void {
    const prev = this.ctx?.prevLeaf ?? null;
    this.leaf.detach();
    if (prev) {
      let alive = false;
      this.app.workspace.iterateAllLeaves((l) => { if (l === prev) alive = true; });
      if (alive) this.app.workspace.setActiveLeaf(prev, { focus: true });
    }
  }

  async onClose(): Promise<void> { this.ui = null; this.contentEl.empty(); }
}
