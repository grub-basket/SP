import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type StashpadPlugin from "./main";
import { ComposerAutocomplete } from "./composer-autocomplete";
import { renderFormattingToolbar } from "./formatting-toolbar";
import { getSettings } from "./settings";

/** 0.330.0: global quick-capture. A hotkey pops this small box from anywhere in
 *  Obsidian; you type a note, optionally drop/attach files, pick which Stashpad
 *  it files into, and it dismisses. Creation + attachment import are routed
 *  through a view for the chosen folder (see StashpadPlugin.runQuickCapture), so
 *  they reuse the exact composer paths — no divergent note writer.
 *
 *  Files are STAGED (kept as File objects) and imported at submit time into the
 *  chosen folder's _attachments, so switching the destination before sending
 *  never strands an attachment in the wrong folder. */
export class QuickCaptureModal extends Modal {
  private staged: File[] = [];
  private folder: string;
  private textEl: HTMLTextAreaElement | null = null;
  private chipsEl: HTMLElement | null = null;
  private autocomplete: ComposerAutocomplete | null = null;
  private submitting = false;
  /** 0.364.2: split-on-newlines toggle (composer parity), seeded from the setting. */
  private split: boolean;

  constructor(app: App, private plugin: StashpadPlugin) {
    super(app);
    const folders = plugin.discoverStashpadFolders();
    const last = plugin.settings.lastCaptureFolder;
    this.folder = last && folders.includes(last) ? last : (folders[0] ?? "");
    this.split = getSettings().splitOnLines;
  }

  onOpen(): void {
    const { contentEl, modalEl, titleEl } = this;
    modalEl.addClass("stashpad-quickcapture-modal");
    titleEl.setText("Quick capture");
    contentEl.empty();

    const folders = this.plugin.discoverStashpadFolders();
    if (folders.length === 0) {
      contentEl.createEl("p", { text: "No Stashpad folders found yet. Open a Stashpad folder first, then capture into it." });
      const close = contentEl.createEl("button", { cls: "mod-cta", text: "OK" });
      close.onclick = () => this.close();
      return;
    }

    // The text box.
    const ta = contentEl.createEl("textarea", { cls: "stashpad-qc-input", attr: { placeholder: "Capture a note…  (Ctrl/Cmd+Enter to save)", rows: "4" } });
    this.textEl = ta;
    // Composer parity: [[ / # / @ autocomplete. Enter inserts a newline here;
    // Mod+Enter submits (handled below), so list continuation always applies.
    this.autocomplete = new ComposerAutocomplete(this.app, ta, { insertsNewline: () => true });
    this.autocomplete.attach();

    // 0.364.2: formatting toolbar — composer/edit-modal parity, so quick capture
    // gets the same snippet + bold/highlight/etc. buttons. Full-width row above
    // the textarea (scrolls horizontally on mobile); gated on the same setting.
    // No "Modify formatting" inspector here — this is a fresh note, not an edit.
    if (getSettings().showComposerToolbar) {
      const bar = renderFormattingToolbar(contentEl, () => this.textEl, {
        app: this.app,
        snippets: getSettings().snippets,
        toolbarButtons: getSettings().toolbarButtons,
        spoilers: getSettings().spoilerMarkup,
        titleFor: () => (this.textEl?.value ?? "").split(/\r?\n/).find((l) => l.trim())?.trim(),
      });
      contentEl.insertBefore(bar, ta);
    }

    // Staged-attachment chips.
    this.chipsEl = contentEl.createDiv({ cls: "stashpad-qc-chips" });
    this.renderChips();

    // 0.364.2: destination row moved to the BOTTOM (above the buttons).
    const destRow = contentEl.createDiv({ cls: "stashpad-qc-dest" });
    destRow.createSpan({ cls: "stashpad-qc-dest-label", text: "File into" });
    const select = destRow.createEl("select", { cls: "stashpad-qc-select dropdown" });
    for (const f of folders) {
      const opt = select.createEl("option", { text: f, value: f });
      if (f === this.folder) opt.selected = true;
    }
    select.onchange = () => { this.folder = select.value; };

    // Action row: split toggle + attach (left) + Cancel/Save (right).
    const actions = contentEl.createDiv({ cls: "stashpad-qc-actions" });
    // 0.364.2: split-on-newlines toggle — composer parity. Each line/paragraph
    // (per the split mode) files as its own note.
    // Same "list-end" icon the composer's split toggle uses, plus the word, so it
    // reads like Attach beside it. Attach sits immediately to its right.
    const splitBtn = actions.createEl("button", { cls: "stashpad-qc-split", attr: { "aria-label": "Split into separate notes" } });
    setIcon(splitBtn, "list-end");
    splitBtn.createSpan({ text: " Split" });
    const syncSplit = (): void => {
      splitBtn.toggleClass("is-active", this.split);
      splitBtn.title = this.split ? "Split ON — each line becomes its own note (click to turn off)" : "Split into separate notes (each line → a note)";
    };
    syncSplit();
    splitBtn.onclick = () => { this.split = !this.split; syncSplit(); this.textEl?.focus(); };
    const attachBtn = actions.createEl("button", { cls: "stashpad-qc-attach", attr: { "aria-label": "Attach files" } });
    setIcon(attachBtn, "paperclip");
    attachBtn.createSpan({ text: " Attach" });
    const fileInput = actions.createEl("input", { cls: "stashpad-qc-fileinput", attr: { type: "file", multiple: "true" } });
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      if (fileInput.files) for (const f of Array.from(fileInput.files)) this.staged.push(f);
      fileInput.value = "";
      this.renderChips();
    };

    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    save.onclick = () => void this.submit();

    // Mod+Enter submits from the textarea.
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.submit();
      }
    });

    // Drag-and-drop anywhere on the modal stages the dropped files.
    const stop = (e: DragEvent): void => { e.preventDefault(); e.stopPropagation(); };
    contentEl.addEventListener("dragover", (e) => { stop(e); modalEl.addClass("is-drag-over"); });
    contentEl.addEventListener("dragleave", (e) => { stop(e); modalEl.removeClass("is-drag-over"); });
    contentEl.addEventListener("drop", (e) => {
      stop(e);
      modalEl.removeClass("is-drag-over");
      const dt = e.dataTransfer;
      if (dt?.files) for (const f of Array.from(dt.files)) this.staged.push(f);
      this.renderChips();
    });

    setTimeout(() => ta.focus(), 0);
  }

  private renderChips(): void {
    const host = this.chipsEl;
    if (!host) return;
    host.empty();
    host.toggleClass("is-empty", this.staged.length === 0);
    this.staged.forEach((f, i) => {
      const chip = host.createDiv({ cls: "stashpad-qc-chip" });
      const icon = chip.createSpan({ cls: "stashpad-qc-chip-icon" });
      setIcon(icon, "paperclip");
      chip.createSpan({ cls: "stashpad-qc-chip-name", text: f.name });
      const del = chip.createEl("button", { cls: "stashpad-qc-chip-del", text: "✕", attr: { "aria-label": "Remove attachment" } });
      del.onclick = () => { this.staged.splice(i, 1); this.renderChips(); };
    });
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const text = (this.textEl?.value ?? "").trim();
    if (!text && this.staged.length === 0) { new Notice("Nothing to capture."); return; }
    if (!this.folder) { new Notice("Pick a Stashpad to capture into."); return; }
    this.submitting = true;
    try {
      const ok = await this.plugin.runQuickCapture(this.folder, text, this.staged, this.split);
      if (ok) {
        this.plugin.settings.lastCaptureFolder = this.folder;
        await this.plugin.persistSettingsQuiet();
        this.close();
      } else {
        this.submitting = false;
      }
    } catch (e) {
      new Notice(`Quick capture failed: ${(e as Error).message}`);
      this.submitting = false;
    }
  }

  onClose(): void {
    this.autocomplete?.detach();
    this.autocomplete = null;
    this.contentEl.empty();
    void Platform.isMobile;
  }
}
