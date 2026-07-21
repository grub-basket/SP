import { App, ItemView, Modal, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import { parseImport, DEFAULT_IMPORT_OPTIONS, type ImportOptions, type ImportNote } from "./text-importer";

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

    this.countEl = c.createDiv({ cls: "setting-item-description stashpad-import-count" });
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
      this.cbs.close();
      void this.cbs.onImport(notes);
    };

    this.refresh();
    window.setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  /** Re-parse and repaint the preview — cheap enough for every keystroke. */
  private refresh(): void {
    this.notes = this.text.trim() ? parseImport(this.text, this.opts) : [];
    const n = this.notes.length;
    this.countEl?.setText(n === 0 ? "Nothing to import yet." : `${n} note${n === 1 ? "" : "s"} will be created:`);
    if (this.importBtn) {
      this.importBtn.disabled = n === 0;
      this.importBtn.setText(n === 0 ? "Import" : `Import ${n} note${n === 1 ? "" : "s"}`);
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
