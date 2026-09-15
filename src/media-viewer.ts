import { App, Component, MarkdownRenderer, Menu, Modal, Notice, Platform, TFile, setIcon } from "obsidian";
import { fileKindFor } from "./file-kinds";

/** How the viewer presents the note's files.
 *  - `view`     one file large, thin filmstrip of the rest (the default)
 *  - `grid`     no stage; a grid of thumbnails, for picking from many
 *  - `details`  no stage; a sortable table of name / type / size / modified,
 *               i.e. Windows Explorer's Details view */
export type ViewerMode = "view" | "grid" | "details";

/** Extensions the viewer renders inline. Kept local rather than imported from
 *  view.ts so the viewer has no dependency on the list. */
export const VIEWER_IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
/** 0.236.0: rendered inline via an <iframe> on the vault resource URL, which is
 *  what Obsidian's own PDF view does under the hood. Deliberately NOT reaching
 *  into Obsidian's internal PDF component — that is not public API and would
 *  break on any internal rename. The trade is that the iframe brings the
 *  browser's own PDF chrome (its page controls and zoom), so the viewer's zoom
 *  and rotate do not apply and are hidden for PDFs. */
export const VIEWER_PDF_EXT = new Set(["pdf"]);
/** Rendered as text. A LIST rather than byte-sniffing: wrongly painting a
 *  binary as text is far more jarring than showing a file card. */
export const VIEWER_TEXT_EXT = new Set([
  "md", "txt", "csv", "tsv", "log", "json", "yaml", "yml", "toml", "xml",
  "html", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb",
  "go", "rs", "java", "c", "h", "cpp", "sh", "swift", "kt", "php", "sql",
  "ini", "conf", "env", "srt", "vtt",
]);

/** True when the viewer can actually RENDER this extension (image, PDF or
 *  text) as opposed to only describing it on a card. */
export function viewerRenders(ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\.+/, "");
  return VIEWER_IMG_EXT.has(e) || VIEWER_PDF_EXT.has(e) || VIEWER_TEXT_EXT.has(e);
}

/** How much text the preview shows before collapsing. Smaller on a phone:
 *  2000 characters is roughly 25 lines on a 390px screen, which is a wall of
 *  text rather than a preview. */
export function textPreviewChars(isMobile: boolean): number {
  return isMobile ? 800 : 2000;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 40;
/** One wheel notch. Multiplicative so each notch feels the same at any zoom —
 *  additive steps crawl when zoomed out and lurch when zoomed in. */
const WHEEL_STEP = 1.15;
const BUTTON_STEP = 1.4;

export interface MediaItem {
  /** Vault-relative path, used for the caption and as the identity. */
  path: string;
  /** Resolved file. Null when the link is broken — the viewer still lists it
   *  and says so, rather than silently skipping it. */
  file: TFile | null;
  /** 0.374.0: when set, this slide is the NOTE ITSELF (not an attachment) —
   *  rendered as scrollable markdown as slide 0 of the preview. `body` is the
   *  raw markdown (frontmatter stripped); `title` labels the rail + caption.
   *  0.376.0: `actions` renders the note's row action buttons (react / quick /
   *  custom / ⋮) into a host in the caption — the view owns their behavior. */
  note?: {
    id: string; title: string; body: string;
    actions?: (host: HTMLElement) => void;
    /** 0.377.0: open the parent note in a new tab (undefined at the top level). */
    onJumpToParent?: () => void;
  };
}

/** A large overlay for previewing a note's attachments: a rail of every file on
 *  the left/bottom, the selected one rendered large, with zoom, rotation and
 *  pan.
 *
 *  Zoom and pan live on an OUTER wrapper; rotation lives on the INNER image.
 *  Splitting them keeps the cursor-anchored zoom maths exact — if rotation were
 *  on the same element, the wheel handler would have to un-rotate the cursor
 *  point before solving for the new translation, which is where this kind of
 *  code usually goes subtly wrong.
 */
export class MediaViewerModal extends Modal {
  private items: MediaItem[];
  private idx: number;

  // View transform for the CURRENT item. Reset on navigation.
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private rotation = 0;

  private stageEl!: HTMLElement;
  private panEl!: HTMLElement;
  private mediaEl: HTMLElement | null = null;
  /** 0.371.0: owns the secondary PDF render (Obsidian's own viewer, via a
   *  markdown embed) when the primary app:// iframe can't read the file — e.g. a
   *  Windows network-user drive where app:// resources come back empty. Unloaded
   *  on the next slide / on close so PDF.js tears down. */
  private pdfEmbedComponent: Component | null = null;
  /** 0.374.0: owns the note-slide markdown render (MarkdownRenderer child), so
   *  its embeds/widgets are torn down on the next slide / on close. */
  private noteComponent: Component | null = null;
  private captionEl!: HTMLElement;
  /** 0.376.1: per-slide host at the END of the bottom toolbar for the note's
   *  relayed row buttons (react / quick / custom / ⋮) — repopulated in show(). */
  private noteActionsEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;
  private railEl!: HTMLElement;
  private transformBtns: HTMLElement[] = [];
  /** 0.377.0: per-slide toolbar buttons (shown/hidden by slide in show()). */
  private fileBtns: HTMLElement[] = [];   // any file: save / reveal-in-fs / reveal-in-nav
  private readWidthBtn!: HTMLElement;     // NOTE SLIDE only (acts on the rendered note)
  private copyLinkBtn!: HTMLElement;      // note-LEVEL: copy a link to the note
  private jumpParentBtn!: HTMLElement;    // note-LEVEL: open the note's parent
  /** 0.377.1: the modal's note item (slide 0), if opened from a note — its
   *  note-level buttons (copy-link / jump-parent / relayed actions) persist on
   *  every slide, since the whole preview is about this one note. */
  private noteItem: MediaItem | null = null;
  private immersive = false;
  private noteNarrow = true;              // note slide starts at a readable width
  private naturalW = 0;
  private naturalH = 0;
  /** Set once the current item has been sized, so "fit" is not computed against
   *  a zero-height image that has not decoded yet. */
  private sized = false;
  private mode: ViewerMode = "view";
  private bodyEl!: HTMLElement;
  private browseEl!: HTMLElement;
  private modeBtns: Partial<Record<ViewerMode, HTMLElement>> = {};
  /** Details-view sort. Name ascending is the only sane default — size or date
   *  as a default would hide the alphabetical order people scan by. */
  private sortKey: "name" | "type" | "size" | "modified" = "name";
  private sortAsc = true;

  constructor(
    app: App,
    items: MediaItem[],
    startIndex: number,
    private onOpenInTab: (file: TFile) => void,
  ) {
    super(app);
    this.items = items;
    this.idx = Math.max(0, Math.min(startIndex, items.length - 1));
  }

  onOpen(): void {
    this.modalEl.addClass("stashpad-media-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("stashpad-media-root");

    // --- header: caption + actions ---
    const header = contentEl.createDiv({ cls: "stashpad-media-header" });
    this.captionEl = header.createDiv({ cls: "stashpad-media-caption" });

    // --- body: holds EITHER the stage+rail (view mode) or a browse surface ---
    this.bodyEl = contentEl.createDiv({ cls: "stashpad-media-body" });
    this.stageEl = this.bodyEl.createDiv({ cls: "stashpad-media-stage" });
    this.panEl = this.stageEl.createDiv({ cls: "stashpad-media-pan" });
    this.browseEl = this.bodyEl.createDiv({ cls: "stashpad-media-browse is-hidden" });

    // --- toolbar: its own row above the rail ---
    // Deliberately NOT in the header: up there the controls crowd Obsidian's
    // close X, so a mis-tap closes the viewer instead of zooming. Along the
    // bottom they also fall in easy thumb reach on a phone.
    const actions = contentEl.createDiv({ cls: "stashpad-media-actions" });
    const act = (icon: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = actions.createEl("button", { cls: "stashpad-media-btn" });
      setIcon(b, icon);
      b.title = title;
      b.setAttr("aria-label", title);
      // The stage owns pointer gestures; a button press must never start a pan.
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
      return b;
    };

    // Kept so the toolbar can hide the transform controls for content that
    // manages its own zoom (a PDF frame) instead of showing dead buttons.
    this.transformBtns = [];
    this.transformBtns.push(act("zoom-out", "Zoom out (−)", () => this.zoomBy(1 / BUTTON_STEP)));
    this.zoomLabelEl = actions.createDiv({ cls: "stashpad-media-zoom" });
    // Click the percentage to toggle between fit and 1:1 — the two zoom levels
    // anyone actually wants, without hunting for a menu.
    this.zoomLabelEl.title = "Click to toggle fit / 100%";
    this.zoomLabelEl.onclick = () => {
      if (Math.abs(this.scale - 1) < 0.01) this.fit();
      else this.setScaleAboutCenter(1);
    };
    this.transformBtns.push(act("zoom-in", "Zoom in (+)", () => this.zoomBy(BUTTON_STEP)));
    this.transformBtns.push(act("rotate-ccw", "Rotate left (Shift+R)", () => this.rotate(-90)));
    this.transformBtns.push(act("rotate-cw", "Rotate right (R)", () => this.rotate(90)));
    this.transformBtns.push(act("maximize", "Fit to window (0)", () => this.fit()));
    act("external-link", "Open in a new tab", () => {
      const f = this.items[this.idx]?.file;
      if (f) { this.close(); this.onOpenInTab(f); }
    });
    // 0.272.4: copy — the image itself to the clipboard for images, the
    // attachment link for anything else.
    act("copy", "Copy (image to clipboard, else a link)", () => void this.copyCurrent());

    // 0.377.0: reading-width (note slide) + copy-link (note-level).
    try { this.noteNarrow = window.localStorage.getItem("stashpad-preview-narrow") !== "0"; } catch { /* default true */ }
    this.readWidthBtn = act("text", "Toggle reading width", () => this.toggleReadingWidth());
    this.copyLinkBtn = act("link", "Copy a link to this note", () => void this.copyNoteLink());
    this.jumpParentBtn = act("corner-left-up", "Open the parent note in a new tab", () => {
      const jump = this.noteItem?.note?.onJumpToParent;
      if (jump) { this.close(); jump(); }
    });
    // 0.377.0: save / reveal — for ANY file (note .md or attachment).
    this.fileBtns = [];
    this.fileBtns.push(act("download", "Save a copy…", () => void this.saveCurrent()));
    this.fileBtns.push(act("folder-open", "Show in the system file manager", () => this.revealInSystem()));
    this.fileBtns.push(act("panel-left", "Show in Obsidian's file explorer", () => this.revealInObsidian()));
    // 0.377.0: immersive — hide the chrome for distraction-free reading.
    act("maximize", "Immersive (hide the chrome)", () => this.toggleImmersive());

    // View-mode switch. Only meaningful with more than one file — with a single
    // attachment there is nothing to browse, so the whole group is omitted
    // rather than shown as three buttons that all do the same thing.
    if (this.items.length > 1) {
      actions.createDiv({ cls: "stashpad-media-sep" });
      const modeBtn = (m: ViewerMode, icon: string, label: string): void => {
        const b = act(icon, label, () => this.setMode(m));
        b.addClass("stashpad-media-mode");
        this.modeBtns[m] = b;
      };
      modeBtn("view", "image", "Viewer");
      modeBtn("grid", "layout-grid", "Grid");
      modeBtn("details", "list", "Details");
    }

    // 0.376.1: the note's relayed row buttons live at the END of this toolbar, so
    // they sit in the same line as the other controls. Repopulated per slide.
    this.noteActionsEl = actions.createDiv({ cls: "stashpad-media-noteactions stashpad-note-actions is-hidden" });

    // --- prev / next ---
    const nav = (dir: -1 | 1, icon: string, title: string): void => {
      const b = this.stageEl.createEl("button", { cls: `stashpad-media-nav is-${dir < 0 ? "prev" : "next"}` });
      setIcon(b, icon);
      b.title = title;
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.go(dir); };
    };
    if (this.items.length > 1) {
      nav(-1, "chevron-left", "Previous (←)");
      nav(1, "chevron-right", "Next (→)");
    }

    // --- rail ---
    this.railEl = contentEl.createDiv({ cls: "stashpad-media-rail" });
    if (this.items.length <= 1) this.railEl.addClass("is-hidden");

    // 0.377.1: the note item (slide 0, when opened from a note) drives the
    // note-level buttons on every slide.
    this.noteItem = this.items.find((i) => !!i.note) ?? null;
    this.wireGestures();
    this.buildRail();
    this.show();
    this.setMode(this.mode);

    // Take the keyboard so +/-/0/R and the arrows work without a click first.
    // Deferred a tick: focusing during onOpen races Obsidian's own modal focus.
    window.setTimeout(() => this.stageEl.focus(), 0);
  }

  onClose(): void {
    this.disposePdfEmbed();
    this.disposeNoteRender();
    this.contentEl.empty();
  }

  /** Tear down the note-slide markdown render, if any. */
  private disposeNoteRender(): void {
    if (this.noteComponent) {
      try { this.noteComponent.unload(); } catch { /* ignore */ }
      this.noteComponent = null;
    }
  }

  /** 0.374.0: render the note's own markdown into the stage — scrollable, no
   *  zoom/pan (it's text, not an image). Reuses Obsidian's MarkdownRenderer so
   *  embeds, callouts, tags and links render exactly as in a note. */
  private async renderNoteSlide(note: { id: string; title: string; body: string }): Promise<void> {
    this.mediaEl = null;
    this.sized = true;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.panEl.addClass("is-note");
    this.applyTransform();
    const host = this.panEl.createDiv({ cls: "stashpad-media-note markdown-rendered" });
    host.toggleClass("is-narrow", this.noteNarrow);
    const comp = new Component();
    comp.load();
    this.noteComponent = comp;
    try {
      const src = this.current()?.file?.path ?? "";
      await MarkdownRenderer.render(this.app, note.body || "*(empty note)*", host, src, comp);
    } catch {
      host.setText(note.body);
    }
  }

  /** 0.377.0: toggle the note slide between a readable width and full width. */
  private toggleReadingWidth(): void {
    this.noteNarrow = !this.noteNarrow;
    try { window.localStorage.setItem("stashpad-preview-narrow", this.noteNarrow ? "1" : "0"); } catch { /* ignore */ }
    this.panEl.querySelector(".stashpad-media-note")?.toggleClass("is-narrow", this.noteNarrow);
  }

  /** 0.377.0: copy an Obsidian link to the note this preview is about. */
  private async copyNoteLink(): Promise<void> {
    const file = this.noteItem?.file;
    if (!file) return;
    try { await navigator.clipboard.writeText(`[[${file.path}]]`); new Notice("Link copied."); }
    catch { new Notice("Couldn't copy to the clipboard."); }
  }

  /** 0.377.0: save a copy of the current file to disk (a plain browser download,
   *  which the desktop app resolves to the OS save flow). */
  private async saveCurrent(): Promise<void> {
    const file = this.current()?.file;
    if (!file) return;
    try {
      const data = await this.app.vault.readBinary(file);
      const url = URL.createObjectURL(new Blob([data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      new Notice(`Couldn't save the file: ${(e as Error).message}`);
    }
  }

  /** 0.377.0: reveal the current file in the OS file manager (desktop only). */
  private revealInSystem(): void {
    const file = this.current()?.file;
    if (!file) return;
    const base = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    const shell = (window as unknown as { require?: (m: string) => { shell?: { showItemInFolder?: (p: string) => void } } }).require?.("electron")?.shell;
    if (base && shell?.showItemInFolder) shell.showItemInFolder(`${base}/${file.path}`);
    else new Notice("Only available on the desktop app.");
  }

  /** 0.377.0: reveal the current file in Obsidian's own file-explorer sidebar. */
  private revealInObsidian(): void {
    const file = this.current()?.file;
    if (!file) return;
    const fe = (this.app as unknown as { internalPlugins?: { getPluginById?: (id: string) => { instance?: { revealInFolder?: (f: TFile) => void } } } }).internalPlugins?.getPluginById?.("file-explorer");
    if (fe?.instance?.revealInFolder) { this.close(); fe.instance.revealInFolder(file); }
    else new Notice("The file explorer isn't available.");
  }

  /** 0.377.0: immersive mode — hide the header/toolbar/rail for a clean read. */
  private toggleImmersive(): void {
    this.immersive = !this.immersive;
    this.modalEl.toggleClass("is-immersive", this.immersive);
  }

  /** Tear down the secondary Obsidian PDF embed (unloads PDF.js), if any. */
  private disposePdfEmbed(): void {
    if (this.pdfEmbedComponent) {
      try { this.pdfEmbedComponent.unload(); } catch { /* ignore */ }
      this.pdfEmbedComponent = null;
    }
  }

  /** True when this item is still the one on screen — guards async work against
   *  the user navigating to another slide mid-flight. Compare by file identity:
   *  MediaItem.path is the LINK text (e.g. a basename), not the resolved file
   *  path, so a path compare would never match. */
  private stillShowing(file: TFile): boolean { return this.current()?.file === file; }

  /** 0.371.0: PDF loading in three layers.
   *   1. PRIMARY — point the iframe at the native `app://` resource (fast, and
   *      the viewer's own title bar shows the real filename). Works everywhere
   *      the resource handler can read the file.
   *   2. SECONDARY — when a probe of that resource comes back empty / errors
   *      (seen on a Windows network-USER drive, where `app://` serves nothing
   *      even though the file is readable), fall back to Obsidian's OWN PDF
   *      viewer via a markdown embed (`![[file]]`). That reads through
   *      Obsidian's file layer — the same path its normal PDF tab uses, which
   *      the user confirmed works on those drives.
   *   3. TERTIARY — if even the embed can't resolve the file, show a fallback
   *      card with "Open in a new tab" + "Retry" rather than a blank pane.
   *  Guards throughout against the user navigating to another slide mid-flight. */
  private async loadPdfFrame(frame: HTMLIFrameElement, file: TFile, ext: string, name: string): Promise<void> {
    const rp = this.app.vault.getResourcePath(file);
    frame.src = rp; // primary
    let primaryOk = false;
    try {
      const resp = await fetch(rp);
      primaryOk = resp.ok && (await resp.blob()).size > 0;
    } catch { primaryOk = false; }
    if (primaryOk || !this.stillShowing(file)) return;

    // Secondary: Obsidian's own viewer.
    if (await this.renderPdfViaObsidian(file)) return;
    if (!this.stillShowing(file)) return;

    // Tertiary: fallback card.
    this.showPdfFallback(file, ext, name, "This PDF couldn't be loaded for preview. It may still be syncing to this device.");
  }

  /** Secondary PDF render: Obsidian's own PDF viewer, embedded via
   *  MarkdownRenderer. Returns true when the embed resolved the file. */
  private async renderPdfViaObsidian(file: TFile): Promise<boolean> {
    try {
      this.disposePdfEmbed();
      this.panEl.empty();
      this.panEl.removeClass("is-placeholder");
      this.panEl.addClass("is-frame");
      const host = this.panEl.createDiv({ cls: "stashpad-media-pdf-embed markdown-rendered" });
      const comp = new Component();
      comp.load();
      this.pdfEmbedComponent = comp;
      await MarkdownRenderer.render(this.app, `![[${file.path}]]`, host, file.path, comp);
      // Embeds resolve asynchronously; give Obsidian a moment to populate.
      await new Promise((r) => window.setTimeout(r, 300));
      if (!this.stillShowing(file)) return true; // navigated away — treat as handled
      const embed = host.querySelector(".internal-embed");
      // Resolved (link found) and not marked unresolved → the PDF viewer will
      // paint even if PDF.js hasn't finished its first page yet.
      return !!embed && !embed.classList.contains("is-unresolved");
    } catch {
      return false;
    }
  }

  /** Tertiary fallback card. */
  private showPdfFallback(file: TFile, ext: string, name: string, hint: string): void {
    this.disposePdfEmbed();
    this.panEl.empty();
    this.panEl.removeClass("is-frame");
    const ph = this.panEl.createDiv({ cls: "stashpad-media-placeholder" });
    this.renderFileFacts(ph, file, ext);
    ph.createDiv({ cls: "stashpad-media-ph-name", text: name });
    ph.createDiv({ cls: "stashpad-media-ph-hint", text: hint });
    const actions = ph.createDiv({ cls: "stashpad-media-ph-actions" });
    const openBtn = actions.createEl("button", { cls: "mod-cta", text: "Open in a new tab" });
    openBtn.onclick = (e) => { e.stopPropagation(); this.close(); this.onOpenInTab(file); };
    const retryBtn = actions.createEl("button", { text: "Retry" });
    retryBtn.onclick = (e) => { e.stopPropagation(); this.show(); };
    this.mediaEl = null;
    this.sized = true;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.panEl.addClass("is-placeholder");
    this.applyTransform();
  }

  /** 0.272.4: right-click menu for the (non-pdf) stage — Copy + Open. */
  private openStageMenu(e: MouseEvent, file: TFile): void {
    const m = new Menu();
    m.addItem((i) => i.setTitle("Copy image").setIcon("copy").onClick(() => void this.copyCurrent()));
    m.addItem((i) => i.setTitle("Open in a new tab").setIcon("external-link").onClick(() => { this.close(); this.onOpenInTab(file); }));
    m.showAtMouseEvent(e);
  }

  /** Copy the current item: the IMAGE itself to the clipboard for an image, or
   *  the attachment link for anything else. */
  private async copyCurrent(): Promise<void> {
    const file = this.items[this.idx]?.file;
    if (!file) { new Notice("Nothing to copy."); return; }
    if (VIEWER_IMG_EXT.has(file.extension.toLowerCase()) && this.mediaEl instanceof HTMLImageElement && this.mediaEl.naturalWidth) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = this.mediaEl.naturalWidth;
        canvas.height = this.mediaEl.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no drawing context");
        ctx.drawImage(this.mediaEl, 0, 0);
        const blob: Blob = await new Promise((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("could not encode the image"))), "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        new Notice("Image copied to the clipboard.");
      } catch (err) {
        new Notice(`Couldn't copy the image: ${(err as Error).message}`);
      }
      return;
    }
    try { await navigator.clipboard.writeText(`![[${file.path}]]`); new Notice("Attachment link copied."); }
    catch { new Notice("Couldn't copy to the clipboard."); }
  }

  // ---------- items ----------

  private current(): MediaItem | null { return this.items[this.idx] ?? null; }

  private go(dir: -1 | 1): void {
    if (this.items.length < 2) return;
    // Wrap: a rail is a loop, and hitting a dead end on a 2-image note is worse
    // than wrapping.
    this.idx = (this.idx + dir + this.items.length) % this.items.length;
    this.show();
  }

  private show(): void {
    const item = this.current();
    this.disposePdfEmbed();
    this.disposeNoteRender();
    this.panEl.empty();
    this.panEl.removeClass("is-placeholder");
    this.panEl.removeClass("is-frame");
    this.panEl.removeClass("is-note");
    this.mediaEl = null;
    this.sized = false;
    this.rotation = 0;
    this.naturalW = 0;
    this.naturalH = 0;

    // 0.374.0: a note slide (slide 0 of a note preview) captions with the note's
    // title, not a filename.
    const name = item ? (item.note ? item.note.title : (item.path.split("/").pop() ?? item.path)) : "";
    this.captionEl.empty();
    this.captionEl.createSpan({ cls: "stashpad-media-name", text: name });
    if (this.items.length > 1) {
      this.captionEl.createSpan({
        cls: "stashpad-media-count",
        text: `${this.idx + 1} / ${this.items.length}`,
      });
    }
    // 0.376.1: relay the note's row action buttons (react / quick / custom / ⋮)
    // into the END of the bottom toolbar for a note slide, so they line up with
    // the other controls. Cleared/hidden for attachment slides.
    // 0.377.1: note-LEVEL controls persist on EVERY slide (the whole preview is
    // about one note) — the relayed action cluster, copy-link and jump-parent
    // stay put whether you're on the note or one of its attachments. The action
    // cluster is populated once.
    const nc = this.noteItem;
    if (nc?.note?.actions && !this.noteActionsEl.childElementCount) nc.note.actions(this.noteActionsEl);
    this.noteActionsEl.toggleClass("is-hidden", !nc);
    this.copyLinkBtn.toggleClass("is-hidden", !nc);
    this.jumpParentBtn.toggleClass("is-hidden", !nc?.note?.onJumpToParent);
    // Reading width acts on the rendered note markdown → note SLIDE only.
    this.readWidthBtn.toggleClass("is-hidden", !item?.note);
    // Save / reveal apply to the CURRENT file — note `.md` or attachment alike.
    for (const b of this.fileBtns) b.toggleClass("is-hidden", !item?.file);

    if (!item) return;
    const ext = (item.path.split(".").pop() ?? "").toLowerCase();

    // 0.374.0: the NOTE ITSELF — render its markdown, scrollable, as the stage.
    if (item.note) {
      void this.renderNoteSlide(item.note);
      this.paintRailSelection();
      return;
    }

    if (!item.file) {
      // Broken link — say so rather than showing an empty stage that reads as
      // a rendering bug.
      // 0.245.0: a broken link opens the viewer like anything else rather than
      // bouncing the click — the modal is where you find out WHY it is broken,
      // and it is also how you reach the rest of the note's files.
      const miss = this.panEl.createDiv({ cls: "stashpad-media-placeholder" });
      this.renderFileFacts(miss, null, item.path.split(".").pop() ?? "");
      miss.createDiv({ cls: "stashpad-media-ph-name", text: item.path });
      this.sized = true;
      this.scale = 1; this.tx = 0; this.ty = 0;
      this.panEl.addClass("is-placeholder");
      this.applyTransform();
      this.paintRailSelection();
      return;
    }

    if (VIEWER_IMG_EXT.has(ext)) {
      const img = this.panEl.createEl("img", { cls: "stashpad-media-img" });
      img.src = this.app.vault.getResourcePath(item.file);
      img.alt = item.path;
      img.draggable = false;
      this.mediaEl = img;
      // 0.272.4: right-click an image → Copy (a PDF is an iframe with its own
      // menu, so this is images / other non-pdf stage content only).
      img.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); if (item.file) this.openStageMenu(e, item.file); };
      const onReady = (): void => {
        this.naturalW = img.naturalWidth || img.clientWidth;
        this.naturalH = img.naturalHeight || img.clientHeight;
        this.sized = true;
        this.fit();
      };
      if (img.complete && img.naturalWidth) onReady();
      else {
        img.onload = onReady;
        // A decode failure must not leave a blank stage with no explanation.
        img.onerror = () => {
          this.panEl.empty();
          const bad = this.panEl.createDiv({ cls: "stashpad-media-placeholder" });
          bad.createDiv({ cls: "stashpad-media-ph-ext", text: ext.toUpperCase() || "?" });
          bad.createDiv({ cls: "stashpad-media-ph-name", text: `Couldn't display ${name}` });
          this.mediaEl = null;
          this.sized = true;
          this.scale = 1; this.tx = 0; this.ty = 0;
          this.panEl.addClass("is-placeholder");
          this.applyTransform();
        };
      }
    } else if (VIEWER_PDF_EXT.has(ext)) {
      const frame = this.panEl.createEl("iframe", { cls: "stashpad-media-pdf" });
      frame.setAttr("title", name);
      // The embedded viewer owns its own scrolling, paging and zoom. Our
      // transform must stay at identity or we would be scaling a scaled
      // viewer, and the toolbar's zoom/rotate are meaningless here — they are
      // hidden rather than left present and inert.
      this.mediaEl = null;
      this.sized = true;
      this.scale = 1; this.tx = 0; this.ty = 0;
      this.panEl.addClass("is-frame");
      this.applyTransform();
      // 0.371.0: load the PDF through an in-memory blob rather than pointing the
      // iframe straight at the `app://` resource path. Two payoffs: (1) it
      // sidesteps a class of "renders in a tab but the preview is blank"
      // failures seen on synced / network vaults, where the cache-busted
      // resource URL serves an empty response even though the bytes are on disk;
      // (2) when the bytes genuinely can't be read (still syncing, permission
      // dropped), the fetch fails and we show a real fallback with an escape
      // hatch instead of a silently blank pane.
      void this.loadPdfFrame(frame, item.file, ext, name);
    } else if (VIEWER_TEXT_EXT.has(ext)) {
      void this.showTextPreview(item.file, ext);
    } else {
      // Non-image, non-PDF, non-text: a labelled card plus the escape hatch.
      const ph = this.panEl.createDiv({ cls: "stashpad-media-placeholder" });
      this.renderFileFacts(ph, item.file, ext);
      ph.createDiv({ cls: "stashpad-media-ph-name", text: name });
      const open = ph.createEl("button", { cls: "mod-cta", text: "Open in a new tab" });
      open.onclick = (e) => {
        e.stopPropagation();
        const f = this.current()?.file;
        if (f) { this.close(); this.onOpenInTab(f); }
      };
      // Placeholders are laid out by flexbox inside a stage-sized box, so they
      // need no transform of their own.
      this.mediaEl = null;
      this.sized = true;
      this.scale = 1; this.tx = 0; this.ty = 0;
      this.panEl.addClass("is-placeholder");
      this.applyTransform();
    }
    this.paintRailSelection();
  }

  /** Text slide: a first-class stage alongside image and PDF, so prev/next and
   *  the rail land on it normally instead of it being a special case.
   *
   *  Sliced BEFORE it reaches the DOM — dropping a multi-megabyte log into a
   *  <pre> in one go is what makes a viewer feel broken, and a preview is for
   *  recognition, not reading. Expanded, the text SCROLLS inside its own box
   *  rather than growing the modal, so the toolbar and rail stay put. */
  private async showTextPreview(file: TFile, ext: string): Promise<void> {
    const cap = textPreviewChars(Platform.isMobile);
    const wrap = this.panEl.createDiv({ cls: "stashpad-media-textwrap" });
    this.renderFileFacts(wrap, file, ext);
    const pre = wrap.createEl("pre", { cls: "stashpad-media-text" });
    const code = pre.createEl("code");
    code.setText("Loading\u2026");
    // Transform controls act on mediaEl; a text slide has none, so they hide
    // themselves exactly as they do for a PDF.
    this.mediaEl = null;
    this.sized = true;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.panEl.addClass("is-frame");
    this.applyTransform();

    let raw = "";
    try { raw = await this.app.vault.cachedRead(file); }
    catch { code.setText("Couldn't read this file."); return; }
    // The user may have navigated while the read was in flight.
    if (this.current()?.path !== file.path) return;

    const truncated = raw.length > cap;
    let expanded = false;
    const paint = (): void => { code.setText(expanded || !truncated ? raw : raw.slice(0, cap)); };
    paint();
    if (!truncated) return;

    const bar = wrap.createDiv({ cls: "stashpad-media-textmore" });
    const btn = bar.createEl("button", { cls: "stashpad-media-textbtn" });
    const count = bar.createSpan({ cls: "stashpad-media-textcount" });
    const sync = (): void => {
      btn.setText(expanded ? "Show less" : "Show all");
      count.setText(expanded
        ? `${raw.length.toLocaleString()} characters`
        : `showing ${cap.toLocaleString()} of ${raw.length.toLocaleString()}`);
    };
    sync();
    btn.onclick = (e) => {
      e.stopPropagation();
      expanded = !expanded;
      paint();
      sync();
      if (!expanded) pre.scrollTop = 0;
    };
  }

  /** Name / type / size / modified for a file the viewer cannot show as an
   *  image. Shared by the text slide, the generic card and the missing-file
   *  case so all three say the same things in the same order. */
  private renderFileFacts(host: HTMLElement, file: TFile | null, ext: string): void {
    const kind = fileKindFor(ext);
    const strip = host.createDiv({ cls: "stashpad-media-facts" });
    const icon = strip.createDiv({ cls: "stashpad-media-factsicon" });
    icon.style.setProperty("--stashpad-file-color", kind.color);
    setIcon(icon, kind.icon);
    const meta = strip.createDiv({ cls: "stashpad-media-factsmeta" });
    meta.createDiv({ cls: "stashpad-media-factstype", text: file ? kind.label : "Missing file" });
    meta.createDiv({
      cls: "stashpad-media-factsline",
      text: file
        ? `${formatBytes(file.stat.size)} \u00b7 modified ${formatWhen(file.stat.mtime)}`
        : "This attachment could not be found in the vault.",
    });
  }

  // ---------- view modes ----------

  private setMode(m: ViewerMode): void {
    this.mode = m;
    const browsing = m !== "view";
    this.stageEl.toggleClass("is-hidden", browsing);
    this.railEl.toggleClass("is-hidden", browsing || this.items.length <= 1);
    this.browseEl.toggleClass("is-hidden", !browsing);
    for (const key of Object.keys(this.modeBtns) as ViewerMode[]) {
      this.modeBtns[key]?.toggleClass("is-active", key === m);
    }
    // Zoom/rotate belong to the stage; in a browse mode they act on something
    // that is not on screen, so hide them rather than leave them inert.
    for (const b of this.transformBtns) b.toggleClass("is-hidden", browsing || !this.mediaEl);
    this.zoomLabelEl.toggleClass("is-hidden", browsing || !this.mediaEl);
    if (m === "grid") this.buildGrid();
    else if (m === "details") this.buildDetails();
    else this.applyTransform();
  }

  /** Open a file from a browse view: switch back to viewing it. Browsing is for
   *  FINDING; the moment you pick something you want to look at it. */
  private openFromBrowse(i: number): void {
    this.idx = i;
    this.setMode("view");
    this.show();
  }

  private buildGrid(): void {
    this.browseEl.empty();
    this.browseEl.removeClass("is-details");
    const grid = this.browseEl.createDiv({ cls: "stashpad-media-grid" });
    this.items.forEach((item, i) => {
      const cell = grid.createDiv({ cls: "stashpad-media-gridcell" });
      if (i === this.idx) cell.addClass("is-active");
      const ext = (item.path.split(".").pop() ?? "").toLowerCase();
      const thumb = cell.createDiv({ cls: "stashpad-media-gridthumb" });
      if (item.file && VIEWER_IMG_EXT.has(ext)) {
        const img = thumb.createEl("img");
        img.src = this.app.vault.getResourcePath(item.file);
        img.draggable = false;
        img.alt = item.path;
      } else {
        const kind = fileKindFor(ext);
        thumb.style.setProperty("--stashpad-file-color", kind.color);
        thumb.addClass("is-badge");
        setIcon(thumb, kind.icon);
      }
      cell.createDiv({ cls: "stashpad-media-gridname", text: item.path.split("/").pop() ?? item.path });
      if (!item.file) cell.addClass("is-missing");
      cell.onclick = (e) => { e.stopPropagation(); this.openFromBrowse(i); };
    });
  }

  /** Windows Explorer's Details view: one row per file, sortable columns. */
  private buildDetails(): void {
    this.browseEl.empty();
    this.browseEl.addClass("is-details");
    const table = this.browseEl.createDiv({ cls: "stashpad-media-details" });

    const head = table.createDiv({ cls: "stashpad-media-detailrow is-head" });
    const COLS: Array<[typeof this.sortKey, string]> = [
      ["name", "Name"], ["type", "Type"], ["size", "Size"], ["modified", "Modified"],
    ];
    for (const [key, label] of COLS) {
      const th = head.createDiv({ cls: `stashpad-media-cell is-${key}` });
      th.setText(label);
      if (this.sortKey === key) th.createSpan({ cls: "stashpad-media-sortcaret", text: this.sortAsc ? " ▲" : " ▼" });
      th.onclick = (e) => {
        e.stopPropagation();
        // Clicking the active column flips direction; a new column starts
        // ascending — the behaviour every file manager has.
        if (this.sortKey === key) this.sortAsc = !this.sortAsc;
        else { this.sortKey = key; this.sortAsc = true; }
        this.buildDetails();
      };
    }

    // Sort INDICES, not the items array — this.idx points into the original
    // order, and reordering the array under it would select the wrong file.
    const order = this.items.map((_, i) => i);
    const kindOf = (i: number) => fileKindFor(this.items[i].path.split(".").pop() ?? "").label;
    const sizeOf = (i: number) => this.items[i].file?.stat.size ?? -1;
    const mtimeOf = (i: number) => this.items[i].file?.stat.mtime ?? -1;
    const nameOf = (i: number) => (this.items[i].path.split("/").pop() ?? "").toLowerCase();
    order.sort((a, b) => {
      let r = 0;
      if (this.sortKey === "name") r = nameOf(a).localeCompare(nameOf(b));
      else if (this.sortKey === "type") r = kindOf(a).localeCompare(kindOf(b)) || nameOf(a).localeCompare(nameOf(b));
      else if (this.sortKey === "size") r = sizeOf(a) - sizeOf(b);
      else r = mtimeOf(a) - mtimeOf(b);
      return this.sortAsc ? r : -r;
    });

    for (const i of order) {
      const item = this.items[i];
      const ext = (item.path.split(".").pop() ?? "").toLowerCase();
      const kind = fileKindFor(ext);
      const row = table.createDiv({ cls: "stashpad-media-detailrow" });
      if (i === this.idx) row.addClass("is-active");
      if (!item.file) row.addClass("is-missing");

      const nameCell = row.createDiv({ cls: "stashpad-media-cell is-name" });
      const icon = nameCell.createDiv({ cls: "stashpad-media-detailicon" });
      icon.style.setProperty("--stashpad-file-color", kind.color);
      setIcon(icon, kind.icon);
      nameCell.createSpan({ text: item.path.split("/").pop() ?? item.path });

      row.createDiv({ cls: "stashpad-media-cell is-type", text: item.file ? kind.label : "Missing" });
      row.createDiv({ cls: "stashpad-media-cell is-size", text: item.file ? formatBytes(item.file.stat.size) : "—" });
      row.createDiv({ cls: "stashpad-media-cell is-modified", text: item.file ? formatWhen(item.file.stat.mtime) : "—" });

      row.onclick = (e) => { e.stopPropagation(); this.openFromBrowse(i); };
    }
  }

  // ---------- rail ----------

  private buildRail(): void {
    this.railEl.empty();
    this.items.forEach((item, i) => {
      const cell = this.railEl.createDiv({ cls: "stashpad-media-railcell" });
      cell.title = item.path;
      const ext = (item.path.split(".").pop() ?? "").toLowerCase();
      if (item.note) {
        // 0.374.0: the note-itself slide — a distinct badge + the note title, so
        // it reads as "the note" rather than a `.md` file in the rail.
        const badge = cell.createDiv({ cls: "stashpad-media-railbadge is-note" });
        setIcon(badge, "file-text");
        badge.createSpan({ cls: "stashpad-media-railext", text: "NOTE" });
        cell.title = item.note.title;
        cell.onclick = (e) => { e.stopPropagation(); this.idx = i; this.show(); };
        return;
      }
      if (item.file && VIEWER_IMG_EXT.has(ext)) {
        const t = cell.createEl("img", { cls: "stashpad-media-railimg" });
        t.src = this.app.vault.getResourcePath(item.file);
        t.draggable = false;
        t.alt = item.path;
      } else {
        // 0.239.0: the same typed badge the note's rail uses, so a file looks
        // the same in both places instead of being a coloured icon in one and
        // four grey letters in the other.
        const kind = fileKindFor(ext);
        const badge = cell.createDiv({ cls: "stashpad-media-railbadge" });
        badge.style.setProperty("--stashpad-file-color", kind.color);
        setIcon(badge, kind.icon);
        badge.createSpan({ cls: "stashpad-media-railext", text: (ext || "?").toUpperCase() });
        cell.title = `${item.path.split("/").pop() ?? item.path} — ${kind.label}`;
        if (!item.file) cell.addClass("is-missing");
      }
      cell.onclick = (e) => {
        e.stopPropagation();
        this.idx = i;
        this.show();
      };
    });
  }

  private paintRailSelection(): void {
    const cells = Array.from(this.railEl.children) as HTMLElement[];
    cells.forEach((c, i) => c.toggleClass("is-active", i === this.idx));
    cells[this.idx]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---------- transform ----------

  private applyTransform(): void {
    // Outer element: pan + zoom, origin at 0 0 so the wheel maths below is a
    // straight linear solve.
    this.panEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    // Inner element: rotation only, about its own centre.
    if (this.mediaEl) this.mediaEl.style.transform = `rotate(${this.rotation}deg)`;
    this.zoomLabelEl.setText(`${Math.round(this.scale * 100)}%`);
    // Transform controls only make sense for content WE transform.
    const transformable = !!this.mediaEl;
    for (const b of this.transformBtns) b.toggleClass("is-hidden", !transformable);
    this.zoomLabelEl.toggleClass("is-hidden", !transformable);
    this.stageEl.toggleClass("is-zoomed", this.scale > this.fitScale() + 0.001);
  }

  /** Scale at which the current image fits the stage, accounting for rotation
   *  (a 90°-rotated image swaps the axes it has to fit within). */
  private fitScale(): number {
    if (!this.naturalW || !this.naturalH) return 1;
    const r = this.stageEl.getBoundingClientRect();
    if (!r.width || !r.height) return 1;
    const quarterTurned = Math.abs(this.rotation % 180) === 90;
    const w = quarterTurned ? this.naturalH : this.naturalW;
    const h = quarterTurned ? this.naturalW : this.naturalH;
    // Never scale a small image UP to fill the stage — blowing a 40px icon up
    // to full screen is not "fit", it is a blurry mess.
    return Math.min(r.width / w, r.height / h, 1);
  }

  /** Fit AND centre. Centring is separate from scaling on purpose: the pan
   *  element is absolutely positioned at the stage's top-left, so setting a fit
   *  scale alone leaves the image hugging the corner with dead space below it.
   *
   *  Centring the LAYOUT box also centres the rotated image: CSS rotation about
   *  `center center` does not move the element's centre, and rotation lives on
   *  the inner img whose layout box stays naturalW x naturalH regardless. */
  private fit(): void {
    if (!this.sized) return;
    this.scale = this.fitScale();
    this.centerInStage();
    this.applyTransform();
  }

  private centerInStage(): void {
    const r = this.stageEl.getBoundingClientRect();
    if (!this.naturalW || !this.naturalH || !r.width) { this.tx = 0; this.ty = 0; return; }
    this.tx = (r.width - this.naturalW * this.scale) / 2;
    this.ty = (r.height - this.naturalH * this.scale) / 2;
  }

  /** Set an absolute scale, keeping the stage centre fixed. */
  private setScaleAboutCenter(next: number): void {
    const r = this.stageEl.getBoundingClientRect();
    this.zoomAbout(next, r.width / 2, r.height / 2);
  }

  private zoomBy(factor: number): void {
    const r = this.stageEl.getBoundingClientRect();
    this.zoomAbout(this.scale * factor, r.width / 2, r.height / 2);
  }

  /** The core of cursor-anchored zoom: the point (px, py) — in STAGE
   *  coordinates — must sit on the same pixel of the image before and after.
   *
   *  A point p maps to `p * scale + t`. Requiring the image point under the
   *  cursor to be unchanged gives `t' = p - (p - t) * (next / scale)`.
   *  That is what makes scrolling over a corner zoom INTO that corner rather
   *  than into the middle. */
  private zoomAbout(nextRaw: number, px: number, py: number): void {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextRaw));
    if (next === this.scale) return;
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
    this.applyTransform();
  }

  private rotate(deg: number): void {
    this.rotation = (this.rotation + deg) % 360;
    if (this.rotation < 0) this.rotation += 360;
    // Re-fit after a quarter turn: the image now has to fit a different axis,
    // and leaving the old scale usually pushes it off-stage.
    this.fit();
  }

  // ---------- gestures ----------

  private wireGestures(): void {
    const stage = this.stageEl;
    stage.tabIndex = 0;

    stage.addEventListener("wheel", (e: WheelEvent) => {
      // Always consume: letting the wheel through scrolls the modal behind.
      e.preventDefault();
      e.stopPropagation();
      if (!this.sized || !this.mediaEl) return;
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      // deltaY is negative when scrolling up / pinching out on a trackpad.
      const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      this.zoomAbout(this.scale * factor, px, py);
    }, { passive: false });

    // --- pan + pinch (pointer events, so mouse and touch share one path) ---
    // Every active pointer is tracked, because a pinch is simply "two pointers
    // down" and the second one can arrive after a pan is already underway.
    const pts = new Map<number, { x: number; y: number; t: number }>();
    let panning = false;
    let startX = 0, startY = 0, startTx = 0, startTy = 0;
    let moved = 0;
    // Pinch state, captured when the second pointer lands.
    let pinchDist0 = 0;
    let pinchScale0 = 1;

    const stagePoint = (e: { clientX: number; clientY: number }): { x: number; y: number; t: number } => {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() };
    };

    /** Drop pointers we have not heard from recently.
     *
     *  A real gesture is continuous, so anything stale is a pointer whose
     *  pointerup/pointercancel never arrived — a lost capture, a window blur
     *  mid-gesture, the OS stealing the touch. Because `twoPointers()` takes
     *  the first two in INSERTION order, one such leak sits at the front and
     *  front-runs every later pinch, scaling against a distance measured in a
     *  gesture that ended long ago. That produced a 92x jump straight into the
     *  scale clamp the first time this was tested. Purging on a fresh
     *  pointerdown is what makes the pinch robust rather than dependent on
     *  perfect cleanup. */
    /** setPointerCapture / releasePointerCapture THROW (NotFoundError) when the
     *  pointer id is not currently active — a pointer released between the
     *  event firing and the handler running, a synthetic event, a device that
     *  reports an id we never saw down. Capture is a nice-to-have (it keeps a
     *  drag alive when the cursor leaves the stage); losing it must never abort
     *  the handler. It threw here and killed every line after it, so pinch never
     *  initialised at all. */
    const capture = (id: number): void => {
      try { stage.setPointerCapture(id); } catch { /* not capturable — fine */ }
    };
    const release = (id: number): void => {
      try { if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id); } catch { /* ignore */ }
    };

    const purgeStale = (): void => {
      const now = Date.now();
      for (const [id, p] of Array.from(pts.entries())) {
        if (now - p.t > 1500) pts.delete(id);
      }
    };
    const twoPointers = (): Array<{ x: number; y: number }> => Array.from(pts.values()).slice(0, 2);
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } =>
      ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    /** Identity of the current pointer PAIR. The pinch baseline is keyed on
     *  this so it re-establishes itself whenever the pair changes.
     *
     *  Deriving the baseline only on "the second pointerdown" was fragile: a
     *  pointerup that never arrives (pointercancel, a lost capture, the window
     *  losing focus mid-gesture) leaves a stale id in the map, and because
     *  `twoPointers()` takes the first two in INSERTION order that stale entry
     *  then front-runs every later pinch — silently scaling against a distance
     *  and a scale from a gesture that finished minutes ago. Re-keying makes it
     *  self-healing instead of depending on perfect cleanup. */
    let pinchKey = "";
    const currentPinchKey = (): string => Array.from(pts.keys()).slice(0, 2).sort().join(":");

    const beginPinch = (): void => {
      const [a, b] = twoPointers();
      if (!a || !b) return;
      const d = dist(a, b);
      // A zero/NaN baseline would divide into an absurd ratio and slam the
      // scale into its clamp, which is exactly how this failed the first time.
      if (!Number.isFinite(d) || d <= 0) return;
      pinchKey = currentPinchKey();
      pinchDist0 = d;
      pinchScale0 = this.scale;
      // A pinch supersedes any pan in progress; otherwise the first finger
      // keeps dragging while the second one scales and the image skates away.
      panning = false;
    };

    stage.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (!this.mediaEl) return;
      purgeStale();
      pts.set(e.pointerId, stagePoint(e));
      if (pts.size >= 2) { beginPinch(); capture(e.pointerId); return; }
      panning = true;
      moved = 0;
      startX = e.clientX; startY = e.clientY;
      startTx = this.tx; startTy = this.ty;
      stage.addClass("is-panning");
      // Capture LAST: it is the one call here that can throw, and nothing below
      // it should be skipped if it does.
      capture(e.pointerId);
    });

    stage.addEventListener("pointermove", (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, stagePoint(e));

      if (pts.size >= 2) {
        const [a, b] = twoPointers();
        if (!a || !b) return;
        // Re-baseline ONLY when the pair genuinely changed (a finger lifted and
        // another landed). Doing it on every first move would measure the
        // spread AFTER a finger had already travelled, losing the initial
        // distance and under-reporting the zoom.
        if (pinchKey !== currentPinchKey() || pinchDist0 <= 0) { beginPinch(); return; }
        const m = mid(a, b);
        // Anchor the zoom on the midpoint between the fingers — the same solve
        // the wheel handler uses, so pinch and scroll agree about what "zoom
        // here" means.
        this.zoomAbout(pinchScale0 * (dist(a, b) / pinchDist0), m.x, m.y);
        return;
      }

      if (!panning) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      this.tx = startTx + dx;
      this.ty = startTy + dy;
      this.applyTransform();
    });

    const endPointer = (e: PointerEvent): void => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      release(e.pointerId);
      pinchKey = "";
      pinchDist0 = 0;
      if (pts.size === 1) {
        // Lifting one finger of a pinch hands control back to a pan, re-based
        // on the finger still down — without this the image jumps by whatever
        // the old pan origin was.
        const [only] = twoPointers();
        const r = stage.getBoundingClientRect();
        startX = r.left + only.x; startY = r.top + only.y;
        startTx = this.tx; startTy = this.ty;
        panning = true;
      } else if (pts.size === 0) {
        panning = false;
        stage.removeClass("is-panning");
      }
    };
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);

    // Double-click toggles fit / 100% at the clicked point — the standard
    // image-viewer gesture.
    stage.addEventListener("dblclick", (e: MouseEvent) => {
      e.preventDefault();
      if (!this.sized || !this.mediaEl) return;
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (Math.abs(this.scale - this.fitScale()) < 0.001) this.zoomAbout(1, px, py);
      else this.fit();
    });

    stage.addEventListener("keydown", (e: KeyboardEvent) => {
      let handled = true;
      switch (e.key) {
        case "+": case "=": this.zoomBy(BUTTON_STEP); break;
        case "-": case "_": this.zoomBy(1 / BUTTON_STEP); break;
        case "0": this.fit(); break;
        case "1": this.setScaleAboutCenter(1); break;
        case "r": this.rotate(e.shiftKey ? -90 : 90); break;
        case "R": this.rotate(-90); break;
        case "ArrowLeft": this.go(-1); break;
        case "ArrowRight": this.go(1); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });

    // Clicking the backdrop (the stage itself, not the image) closes — matches
    // every lightbox. Guarded on "no pan happened" so a drag that ends over the
    // backdrop does not dismiss.
    stage.addEventListener("click", (e: MouseEvent) => {
      if (e.target !== stage) return;
      // A drag that happens to end over the backdrop must not dismiss.
      if (moved > 4) { moved = 0; return; }
      this.close();
    });
  }
}

/** Build the viewer's item list from a note's attachment paths. */
/** Human file size. Binary units, because that is what every file manager
 *  shows and a mismatch reads as a bug. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Short absolute date. Deliberately NOT relative ("2 days ago") — a Details
 *  view is for comparing files, and relative times make two rows hard to rank. */
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
  return `${date}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function mediaItemsFor(app: App, paths: string[]): MediaItem[] {
  return paths.map((p) => ({ path: p, file: app.metadataCache.getFirstLinkpathDest(p, "") }));
}

/** True when this attachment should open in the viewer rather than a tab.
 *  Non-images still open in the viewer when they sit alongside images, so the
 *  rail stays complete — the viewer offers "Open in a new tab" for them. */
/** Parse the user's comma-separated extension list.
 *
 *  Deliberately forgiving about how it is typed: `pdf, .png,JPG` and
 *  `.pdf,.png,.jpg` mean the same thing. Asking someone to remember whether a
 *  dot is required is a rule with no upside — strip it, lowercase, trim, and
 *  drop anything empty. Also accepts whitespace or semicolons as separators,
 *  since those are the obvious near-misses. */
export function parseExtList(raw: string): Set<string> {
  return new Set(
    (raw || "")
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase().replace(/^\.+/, ""))
      .filter(Boolean),
  );
}

/** Extensions the viewer opens, as a set. Falls back to the built-in list when
 *  the setting is blank, so clearing the field cannot leave the viewer dead. */
export function viewerExtensions(raw: string): Set<string> {
  const parsed = parseExtList(raw);
  if (parsed.size > 0) return parsed;
  return new Set([...VIEWER_IMG_EXT, ...VIEWER_PDF_EXT]);
}

/** Should a click on `ext` open the viewer, given the note's OTHER attachments?
 *
 *  The rule is about the NOTE, not the clicked file. The viewer shows a rail of
 *  everything attached to that note, so if a zip sits beside a photo, opening
 *  the zip in a tab strands you away from the rail you were reaching for.
 *
 *  Order matters:
 *   1. an explicitly EXCLUDED type never opens the viewer — that is the opt-out
 *   2. `allTypes` on: everything else opens it
 *   3. otherwise: open when the clicked file is renderable, OR any sibling
 *      attachment on the same note is
 */
export function viewerHandles(
  ext: string,
  opts: { excluded: string; allTypes: boolean; siblingExts?: string[] },
): boolean {
  const e = ext.toLowerCase().replace(/^\.+/, "");
  if (parseExtList(opts.excluded).has(e)) return false;
  if (opts.allTypes) return true;
  if (viewerRenders(e)) return true;
  return (opts.siblingExts ?? []).some((x) => {
    const s2 = x.toLowerCase().replace(/^\.+/, "");
    return !parseExtList(opts.excluded).has(s2) && viewerRenders(s2);
  });
}
