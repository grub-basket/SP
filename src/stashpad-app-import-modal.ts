/** UI for the Stashpad DESKTOP app importer — modal host, full-tab host, and the
 *  shared body, the same three-part shape as `text-import-modal.ts`.
 *
 *  Unlike the paste importer this one takes FILES, so the body is built around a
 *  drop zone that reports what it received. An import of this size is a one-shot
 *  into a real vault, so every file is acknowledged on screen before the button
 *  becomes available. */
import { App, ItemView, Modal, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import {
  buildAppImport, helperToNote, builtInReferenceNotes, looksLikeNotesJson, APP_ROOTS, DEFAULT_APP_IMPORT_OPTIONS,
  type AppImportOptions, type AppImportResult, type AppImportNote, type HelperFile, type HelperNote,
} from "./stashpad-app-importer";

export const APP_IMPORT_VIEW_TYPE = "stashpad-app-import";

/** Files the extraction produces. Only notes.json is required; the rest are
 *  listed so it's obvious they exist and can be brought along. */
const EXPECTED = [
  { match: "notes.json", label: "notes.json", required: true, desc: "Every note, with its structure. Required." },
  { match: "attachments.json", label: "attachments.json", required: false, desc: "Catalogue of image attachments (metadata only)." },
  { match: "palette.json", label: "palette.json", required: false, desc: "The original app's colour palette." },
  { match: "manifest.json", label: "manifest.json", required: false, desc: "Counts and export provenance." },
  { match: "pinned.json", label: "pinned.json", required: false, desc: "Which notes were pinned in the app's sidebar, and in what order." },
  { match: "tasks.json", label: "tasks.json", required: false, desc: "The notes that were marked done." },
  { match: "recents.json", label: "recents.json", required: false, desc: "The app's recently-visited list." },
  { match: "app-preferences.json", label: "app-preferences.json", required: false, desc: "How the desktop app was configured." },
  { match: "notifications.json", label: "notifications.json", required: false, desc: "Notifications outstanding in the app." },
];

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

interface LoadedFile { name: string; size: number; text: string; kind: "notes" | "helper"; detail: string }

export interface AppImporterState { files: LoadedFile[]; opts: AppImportOptions }

export interface AppImporterCallbacks {
  onImport: (notes: AppImportNote[], helpers: HelperNote[]) => void | Promise<void>;
  close: () => void;
  popOut?: (state: AppImporterState) => void;
  destinationLabel: string;
  /** Stashpad ids already in the destination folder, for the re-run guard. */
  existingSourceIds?: ReadonlySet<string>;
}

export class AppImporterUI {
  private files: LoadedFile[] = [];
  private opts: AppImportOptions;
  private result: AppImportResult | null = null;
  private fileListEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private warnEl: HTMLElement | null = null;
  private doneEl: HTMLElement | null = null;
  private importBtn: HTMLButtonElement | null = null;
  private lastImported = 0;
  private busy = false;

  constructor(private app: App, private host: HTMLElement, init: Partial<AppImporterState>, private cbs: AppImporterCallbacks) {
    this.files = init.files ? [...init.files] : [];
    this.opts = { ...DEFAULT_APP_IMPORT_OPTIONS, ...(init.opts ?? {}) };
    this.render();
  }

  getState(): AppImporterState { return { files: [...this.files], opts: { ...this.opts } }; }

  private get notesFile(): LoadedFile | null { return this.files.find((f) => f.kind === "notes") ?? null; }
  private get helperFiles(): LoadedFile[] { return this.files.filter((f) => f.kind === "helper"); }

  private render(): void {
    const c = this.host;
    c.empty();
    c.addClass("stashpad-import-host", "stashpad-appimport-host");

    c.createDiv({
      cls: "setting-item-description",
      text: `Import notes exported from the old Stashpad desktop app. Top-level notes go into ${this.cbs.destinationLabel}.`,
    });

    // ---- drop zone ---------------------------------------------------------
    const drop = c.createDiv({ cls: "stashpad-appimport-drop" });
    const icon = drop.createDiv({ cls: "stashpad-appimport-dropicon" });
    setIcon(icon, "upload");
    drop.createDiv({ cls: "stashpad-appimport-droptitle", text: "Drop the export files here" });
    drop.createDiv({
      cls: "setting-item-description",
      text: "or click to choose them. You can add them all at once, or one at a time.",
    });

    const picker = drop.createEl("input", { type: "file" });
    picker.multiple = true;
    picker.accept = ".json,.md";
    // 0.219.6: a CSS class, not a literal style assignment — the community-store
    // lint's no-static-styles-assignment rule is a CONFIRMED review blocker.
    picker.addClass("stashpad-visually-hidden");
    picker.addEventListener("change", () => {
      if (picker.files) void this.accept(Array.from(picker.files));
      picker.value = "";
    });
    drop.addEventListener("click", () => picker.click());

    // dragover has to be cancelled or the browser opens the file instead
    const stop = (e: DragEvent): void => { e.preventDefault(); e.stopPropagation(); };
    drop.addEventListener("dragover", (e) => { stop(e); drop.addClass("is-over"); });
    drop.addEventListener("dragleave", (e) => { stop(e); drop.removeClass("is-over"); });
    drop.addEventListener("drop", (e) => {
      stop(e);
      drop.removeClass("is-over");
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (dropped.length) void this.accept(dropped);
    });

    // ---- what we've got ----------------------------------------------------
    this.fileListEl = c.createDiv({ cls: "stashpad-appimport-files" });

    // ---- options -----------------------------------------------------------
    const rootSetting = new Setting(c)
      .setName("What to bring across")
      .setDesc("Trash is off by default — those notes were deleted in Stashpad.");
    const rootBox = c.createDiv({ cls: "stashpad-appimport-roots" });
    for (const root of APP_ROOTS) {
      const label = rootBox.createEl("label", { cls: "stashpad-appimport-root" });
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = this.opts.roots.includes(root);
      cb.onchange = () => {
        this.opts.roots = cb.checked
          ? [...this.opts.roots, root]
          : this.opts.roots.filter((r) => r !== root);
        this.refresh();
      };
      label.createSpan({ text: ROOT_LABEL[root] ?? root });
    }
    rootSetting.settingEl.appendChild(rootBox);

    const toggle = (name: string, desc: string, key: "doneAsTask" | "faithfulColors" | "keepTimestamps" | "includeHelpers" | "groupOrphans" | "skipAlreadyImported" | "sectionParents"): void => {
      new Setting(c).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(this.opts[key]).onChange((v) => { this.opts[key] = v; this.refresh(); }));
    };
    toggle("Completed notes become tasks", "Stashpad marked a note done without a checkbox. On, those arrive as completed tasks; off, the flag is dropped. Checkboxes already inside a note's text are untouched either way.", "doneAsTask");
    toggle("Keep original dates", "Use each note's Stashpad created and modified time instead of the time of import.", "keepTimestamps");
    toggle("Use the old app's exact colours", "Off (recommended) maps colours onto this plugin's palette, so imported notes match the rest of your vault. On reproduces the old app's hexes exactly.", "faithfulColors");
    toggle("Group the recovered notes together", "Notes that were unreachable in Stashpad (findable only by search) are filed under one clearly-labelled parent instead of being scattered.", "groupOrphans");
    toggle("Keep the app\u2019s sections separate", "File Trash, Todos, Shared and the like under their own labelled parent, so it stays obvious what each note was in Stashpad. Home stays at the top level either way.", "sectionParents");
    toggle("Skip notes already imported", "Leaves out anything whose Stashpad id is already in this folder, so running the import twice doesn't duplicate everything. Turn OFF to import them again anyway.", "skipAlreadyImported");
    toggle("Also import the supporting files", "Adds two short reference notes explaining the colour mapping and what could not come across, plus readable versions of attachments.json / palette.json / manifest.json if you supplied them.", "includeHelpers");

    this.summaryEl = c.createDiv({ cls: "setting-item-description stashpad-import-count" });
    this.warnEl = c.createDiv({ cls: "stashpad-appimport-warnings" });
    this.doneEl = c.createDiv({ cls: "setting-item-description stashpad-import-done" });
    this.doneEl.hide();

    const btns = c.createDiv({ cls: "stashpad-split-actions" });
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.cbs.close();
    if (this.cbs.popOut) {
      const pop = btns.createEl("button", { text: "Open in a tab" });
      setIcon(pop.createSpan({ cls: "stashpad-import-popicon" }), "external-link");
      pop.onclick = () => this.cbs.popOut!(this.getState());
    }
    this.importBtn = btns.createEl("button", { cls: "mod-cta", text: "Import" });
    this.importBtn.onclick = () => void this.doImport();

    this.refresh();
  }

  /** Read dropped/picked files, classify them, and acknowledge each one. */
  private async accept(list: File[]): Promise<void> {
    for (const f of list) {
      let text: string;
      try {
        text = await f.text();
      } catch {
        this.files.push({ name: f.name, size: f.size, text: "", kind: "helper", detail: "could not be read" });
        continue;
      }

      let kind: LoadedFile["kind"] = "helper";
      let detail = "";
      if (f.name.toLowerCase().endsWith(".json")) {
        try {
          const parsed = JSON.parse(text);
          if (looksLikeNotesJson(parsed)) {
            kind = "notes";
            detail = `${(parsed as unknown[]).length.toLocaleString()} notes`;
          } else {
            detail = Array.isArray(parsed) ? `${parsed.length} records` : "reference data";
          }
        } catch {
          detail = "not valid JSON — will be imported as plain text";
        }
      } else {
        detail = "text";
      }

      // A second notes.json replaces the first rather than quietly winning or losing.
      if (kind === "notes") this.files = this.files.filter((x) => x.kind !== "notes");
      this.files = this.files.filter((x) => x.name !== f.name);
      this.files.push({ name: f.name, size: f.size, text, kind, detail });
    }
    this.refresh();
  }

  private refresh(): void {
    // -- the file checklist --------------------------------------------------
    const list = this.fileListEl;
    if (list) {
      list.empty();
      for (const exp of EXPECTED) {
        const got = this.files.find((f) => f.name.toLowerCase() === exp.match);
        const row = list.createDiv({ cls: got ? "stashpad-appimport-file is-present" : "stashpad-appimport-file" });
        const mark = row.createSpan({ cls: "stashpad-appimport-mark" });
        setIcon(mark, got ? "check-circle" : (exp.required ? "circle-alert" : "circle-dashed"));
        const body = row.createDiv({ cls: "stashpad-appimport-filebody" });
        body.createSpan({ cls: "stashpad-appimport-filename", text: exp.label });
        body.createSpan({
          cls: "stashpad-appimport-filedetail",
          text: got ? ` — received, ${fmtBytes(got.size)}, ${got.detail}` : ` — ${exp.required ? "still needed" : "optional"}`,
        });
        body.createDiv({ cls: "setting-item-description", text: exp.desc });
        if (got) {
          const rm = row.createEl("button", { cls: "stashpad-import-ctlbtn", text: "✕" });
          rm.title = "Remove this file";
          rm.onclick = (e) => { e.stopPropagation(); this.files = this.files.filter((x) => x !== got); this.refresh(); };
        }
      }
      // Anything dropped that isn't one of the four.
      for (const extra of this.files.filter((f) => !EXPECTED.some((e) => e.match === f.name.toLowerCase()))) {
        const row = list.createDiv({ cls: "stashpad-appimport-file is-present" });
        const mark = row.createSpan({ cls: "stashpad-appimport-mark" });
        setIcon(mark, "check-circle");
        const body = row.createDiv({ cls: "stashpad-appimport-filebody" });
        body.createSpan({ cls: "stashpad-appimport-filename", text: extra.name });
        body.createSpan({ cls: "stashpad-appimport-filedetail", text: ` — received, ${fmtBytes(extra.size)}, ${extra.detail}` });
        const rm = row.createEl("button", { cls: "stashpad-import-ctlbtn", text: "✕" });
        rm.title = "Remove this file";
        rm.onclick = (e) => { e.stopPropagation(); this.files = this.files.filter((x) => x !== extra); this.refresh(); };
      }
    }

    // -- parse + summarise ---------------------------------------------------
    const nf = this.notesFile;
    this.result = null;
    if (nf) {
      try {
        this.result = buildAppImport(JSON.parse(nf.text), this.opts, this.cbs.existingSourceIds ?? new Set<string>());
      } catch (e) {
        this.result = null;
        this.summaryEl?.setText(`Could not read ${nf.name}: ${(e as Error).message}`);
      }
    }

    const helperCount = this.opts.includeHelpers ? this.helperFiles.length + builtInReferenceNotes().length : 0;
    if (this.summaryEl) {
      if (!nf) {
        this.summaryEl.setText("Add notes.json to continue.");
      } else if (this.result) {
        const s = this.result.stats;
        const parts = [
          `${s.selected.toLocaleString()} of ${s.totalInFile.toLocaleString()} notes selected`,
          s.done ? `${s.done} completed` : null,
          s.coloured ? `${s.coloured} coloured` : null,
          s.pinned ? `${s.pinned} pinned` : null,
          s.orphaned ? `${s.orphaned} recovered from outside the tree` : null,
          s.alreadyImported ? `${s.alreadyImported.toLocaleString()} already here, skipped` : null,
          helperCount ? `${helperCount} reference file${helperCount === 1 ? "" : "s"}` : null,
        ].filter(Boolean);
        this.summaryEl.setText(parts.join(" · "));
      }
    }

    if (this.warnEl) {
      this.warnEl.empty();
      const byRoot = this.result?.byRoot ?? {};
      if (Object.keys(byRoot).length) {
        const line = this.warnEl.createDiv({ cls: "setting-item-description" });
        line.setText("By section: " + Object.entries(byRoot)
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${ROOT_LABEL[r] ?? r} ${n.toLocaleString()}`).join(" · "));
      }
      for (const w of this.result?.warnings ?? []) {
        this.warnEl.createDiv({ cls: "stashpad-appimport-warning", text: w });
      }
    }

    const n = this.result?.stats.selected ?? 0;
    if (this.importBtn) {
      this.importBtn.disabled = this.busy || (n === 0 && helperCount === 0);
      this.importBtn.setText(
        this.busy ? "Importing…"
          : n === 0 ? "Import"
            : `Import ${n.toLocaleString()} note${n === 1 ? "" : "s"}`,
      );
    }

    if (this.doneEl) {
      if (this.lastImported > 0) {
        this.doneEl.setText(
          `✅ Imported ${this.lastImported.toLocaleString()} notes. `
          + "Use “Show imported notes” on the notification to jump to them. "
          + "Your files and settings are still here — adjust and import again, or Cancel to close.",
        );
        this.doneEl.show();
      } else {
        this.doneEl.hide();
      }
    }
  }

  private async doImport(): Promise<void> {
    if (this.busy) return;
    const notes = this.result?.notes ?? [];
    // The built-in notes need no files at all — the facts they record live in
    // this module. Supplied files add to them rather than replacing them.
    const helpers: HelperNote[] = this.opts.includeHelpers
      ? [
          ...builtInReferenceNotes(),
          ...this.helperFiles.map((f) => helperToNote({ name: f.name, text: f.text, size: f.size } satisfies HelperFile)),
        ]
      : [];
    if (!notes.length && !helpers.length) return;
    this.busy = true;
    this.refresh();
    try {
      await this.cbs.onImport(notes, helpers);
      this.lastImported = notes.length;
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
}

const ROOT_LABEL: Record<string, string> = {
  HOME: "Home",
  TODOS: "Todos",
  TRASH: "Trash (deleted)",
  SHARE_ROOT: "Shared",
  SHARED_STASHES: "Shared with me",
  ORPHAN: "Recovered (hidden in the app)",
  SIDEBAR: "Sidebar",
  NOTES_FOOTER: "Footer",
};

/** Modal host — the default entry point, with a pop-out button. */
export class AppImportModal extends Modal {
  private ui: AppImporterUI | null = null;
  constructor(
    app: App,
    private destinationLabel: string,
    private onImport: (notes: AppImportNote[], helpers: HelperNote[]) => void | Promise<void>,
    private popOut?: (state: AppImporterState) => void,
    private init: Partial<AppImporterState> = {},
    private existingSourceIds: ReadonlySet<string> = new Set<string>(),
  ) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("stashpad-import-modal");
    this.titleEl.setText("Import from the Stashpad app");
    this.ui = new AppImporterUI(this.app, this.contentEl, this.init, {
      destinationLabel: this.destinationLabel,
      onImport: this.onImport,
      existingSourceIds: this.existingSourceIds,
      close: () => this.close(),
      popOut: this.popOut ? (state) => { this.close(); this.popOut!(state); } : undefined,
    });
  }
  onClose(): void { this.ui = null; this.contentEl.empty(); }
}

export interface AppImporterViewContext {
  state: Partial<AppImporterState>;
  destinationLabel: string;
  onImport: (notes: AppImportNote[], helpers: HelperNote[]) => void | Promise<void>;
  existingSourceIds?: ReadonlySet<string>;
  prevLeaf?: WorkspaceLeaf | null;
}

/** Full-leaf host — the better home for an import this size. Ephemeral: needs its
 *  context injected right after creation, mirroring TextImportView. */
export class AppImportView extends ItemView {
  private ui: AppImporterUI | null = null;
  private ctx: AppImporterViewContext | null = null;
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType(): string { return APP_IMPORT_VIEW_TYPE; }
  getDisplayText(): string { return "Import from the Stashpad app"; }
  getIcon(): string { return "package-open"; }

  setContext(ctx: AppImporterViewContext): void {
    this.ctx = ctx;
    this.renderUI();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("stashpad-import-host", "stashpad-import-view");
    if (!this.ctx) {
      window.setTimeout(() => { if (!this.ctx) this.renderExpired(); }, 800);
    }
  }

  private renderUI(): void {
    const c = this.contentEl;
    c.empty();
    if (!this.ctx) return;
    this.ui = new AppImporterUI(this.app, c, this.ctx.state, {
      destinationLabel: this.ctx.destinationLabel,
      onImport: this.ctx.onImport,
      existingSourceIds: this.ctx.existingSourceIds,
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
