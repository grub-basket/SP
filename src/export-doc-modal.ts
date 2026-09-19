import { App, Modal, Platform } from "obsidian";
import type { ExportFormat, ExportScope } from "./commands/export-doc";

export interface DocExportChoice {
  baseName: string;
  format: ExportFormat;
  scope: ExportScope;
  splitPerItem: boolean;
  saveDialog: boolean;
}

export interface ExportDocModalOpts {
  defaultBaseName: string;
  noteCount: number;
  /** Whether the anchor has a reply thread (enables the Thread scope option). */
  hasThread: boolean;
  onConfirm: (choice: DocExportChoice) => void;
}

/** The HTML/PDF export dialog: file name, format, scope, combine/split, and
 *  (desktop) a system Save-dialog toggle. Deliberately separate from the .stash
 *  ExportStashModal — no encryption/OKF surface, no content-scope. */
export class ExportDocModal extends Modal {
  private done = false;
  constructor(app: App, private opts: ExportDocModalOpts) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Export to HTML / PDF");
    this.modalEl.addClass("stashpad-export-modal");

    const n = this.opts.noteCount;
    this.contentEl.createEl("p", {
      cls: "stashpad-export-desc",
      text: `Export ${n} selected note${n === 1 ? "" : "s"} (plus their subtree / thread, depending on scope).`,
    });

    // File name
    const field = this.contentEl.createDiv({ cls: "stashpad-export-field" });
    field.createEl("label", { cls: "stashpad-export-label", text: "File name" });
    const input = field.createEl("input", { type: "text" });
    input.addClass("stashpad-export-name");
    input.value = this.opts.defaultBaseName;

    // Format — PDF is desktop-only (Electron printToPDF); hidden on mobile.
    let format: ExportFormat = "html";
    const formatOpts = Platform.isMobile
      ? [{ id: "html", label: "HTML" }]
      : [{ id: "html", label: "HTML" }, { id: "pdf", label: "PDF" }];
    if (!Platform.isMobile) {
      this.segment(this.contentEl, "Format", formatOpts, format, (id) => { format = id as ExportFormat; });
    }

    // Scope
    let scope: ExportScope = "subtree";
    const scopeOpts: Array<{ id: ExportScope; label: string }> = [
      { id: "selection", label: "Selected only" },
      { id: "subtree", label: "Selected + subtree" },
    ];
    if (this.opts.hasThread) scopeOpts.push({ id: "thread", label: "Reply thread" });
    this.segment(this.contentEl, "Scope", scopeOpts, scope, (id) => { scope = id as ExportScope; });

    // Combine / split
    let splitPerItem = false;
    this.checkbox(this.contentEl, "Split each top-level item onto its own page",
      splitPerItem, (v) => { splitPerItem = v; });

    // Save dialog (desktop only)
    let saveDialog = false;
    if (!Platform.isMobile) {
      this.checkbox(this.contentEl, "Also choose a save location (system dialog)",
        saveDialog, (v) => { saveDialog = v; });
    }

    // Buttons
    const btns = this.contentEl.createDiv({ cls: "stashpad-export-actions" });
    const cancel = btns.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const go = btns.createEl("button", { text: "Export", cls: "mod-cta" });
    go.onclick = () => {
      if (this.done) return;
      this.done = true;
      const baseName = (input.value || this.opts.defaultBaseName).trim() || this.opts.defaultBaseName;
      this.close();
      this.opts.onConfirm({ baseName, format, scope, splitPerItem, saveDialog });
    };
    input.focus();
    input.select();
  }

  onClose(): void { this.contentEl.empty(); }

  private segment(host: HTMLElement, label: string, opts: Array<{ id: string; label: string }>, initial: string, onChange: (id: string) => void): void {
    const wrap = host.createDiv({ cls: "stashpad-export-format" });
    wrap.createEl("label", { cls: "stashpad-export-label", text: label });
    const seg = wrap.createDiv({ cls: "stashpad-export-content-seg" });
    const btns = new Map<string, HTMLButtonElement>();
    for (const o of opts) {
      const b = seg.createEl("button", { cls: "stashpad-export-content-opt", text: o.label });
      b.toggleClass("is-active", o.id === initial);
      b.onclick = (e) => {
        e.preventDefault();
        btns.forEach((bb, k) => bb.toggleClass("is-active", k === o.id));
        onChange(o.id);
      };
      btns.set(o.id, b);
    }
  }

  private checkbox(host: HTMLElement, label: string, initial: boolean, onChange: (v: boolean) => void): void {
    const row = host.createDiv({ cls: "stashpad-export-check" });
    const c = row.createEl("input", { type: "checkbox" });
    c.checked = initial;
    c.onchange = () => onChange(c.checked);
    row.createEl("label", { text: label });
  }
}
