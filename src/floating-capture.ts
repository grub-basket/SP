import { App, setIcon } from "obsidian";

/** What the floating capture window writes to. Bound at open time to a specific
 *  note (the parent to nest under) so you keep capturing to the note you chose
 *  even while you scroll/read something else behind the window. */
export interface FloatingCaptureHost {
  /** Create one note from `text`, nested under the bound parent. */
  createNote: (text: string) => Promise<void>;
  /** Called after a successful capture (the view repaints). */
  onAfter: () => void;
}

const POS_KEY = "stashpad-floatcap-pos";

/** 0.463.0: a small, NON-BLOCKING, draggable capture window — "write while
 *  reading". Unlike QuickCaptureModal (a centered, backdrop-blocking Modal), this
 *  floats over the workspace so the note behind it stays visible and scrollable.
 *  One instance per view; re-opening re-binds the target and refocuses. */
export class FloatingCaptureWindow {
  private root: HTMLElement | null = null;
  private ta: HTMLTextAreaElement | null = null;
  private titleEl: HTMLElement | null = null;
  private host: FloatingCaptureHost | null = null;
  private flashTimer: number | null = null;
  private docCleanup: (() => void) | null = null;

  constructor(private app: App) {}

  openFor(label: string, host: FloatingCaptureHost): void {
    this.host = host;
    if (!this.root) this.build();
    this.setLabel(label);
    this.root?.removeClass("is-hidden");
    // Defer focus so it lands after the element is laid out (mobile keyboards).
    window.setTimeout(() => this.ta?.focus(), 0);
  }

  private setLabel(label: string): void {
    if (this.titleEl) this.titleEl.setText(`Capture under: ${label}`);
  }

  private build(): void {
    const doc = this.app.workspace.containerEl.ownerDocument;
    const root = doc.body.createDiv({ cls: "stashpad-floatcap" });
    this.root = root;

    const header = root.createDiv({ cls: "stashpad-floatcap-header" });
    const grip = header.createSpan({ cls: "stashpad-floatcap-grip" });
    setIcon(grip, "grip-horizontal");
    this.titleEl = header.createSpan({ cls: "stashpad-floatcap-title", text: "Capture" });
    const close = header.createEl("button", { cls: "stashpad-floatcap-x", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    close.onclick = (e) => { e.preventDefault(); this.close(); };

    const ta = root.createEl("textarea", { cls: "stashpad-floatcap-input", attr: { rows: "3", placeholder: "Write a note… Enter to add, Esc to close" } });
    this.ta = ta;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
      // Stop the app's global shortcuts from firing while typing here.
      e.stopPropagation();
    });

    const bar = root.createDiv({ cls: "stashpad-floatcap-bar" });
    const flash = bar.createSpan({ cls: "stashpad-floatcap-flash" });
    flash.dataset.role = "flash";
    const send = bar.createEl("button", { cls: "mod-cta stashpad-floatcap-send", text: "Add" });
    send.onclick = (e) => { e.preventDefault(); void this.send(); };

    this.restorePosition();
    this.wireDrag(header);
  }

  private async send(): Promise<void> {
    const text = (this.ta?.value ?? "").trim();
    if (!text || !this.host) return;
    try {
      await this.host.createNote(text);
      this.host.onAfter();
      if (this.ta) { this.ta.value = ""; this.ta.focus(); }
      this.flash("Added ✓");
    } catch (err) {
      console.warn("[Stashpad] floating capture failed", err);
      this.flash("Couldn't add");
    }
  }

  private flash(msg: string): void {
    const el = this.root?.querySelector<HTMLElement>('[data-role="flash"]');
    if (!el) return;
    el.setText(msg);
    el.addClass("is-shown");
    if (this.flashTimer != null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => el.removeClass("is-shown"), 1400);
  }

  private wireDrag(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".stashpad-floatcap-x")) return;
      e.preventDefault();
      const root = this.root;
      if (!root) return;
      const r = root.getBoundingClientRect();
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      const move = (ev: PointerEvent): void => {
        const maxX = window.innerWidth - root.offsetWidth;
        const maxY = window.innerHeight - root.offsetHeight;
        const x = Math.max(0, Math.min(ev.clientX - offX, Math.max(0, maxX)));
        const y = Math.max(0, Math.min(ev.clientY - offY, Math.max(0, maxY)));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.addClass("is-positioned"); // clears the default bottom-right anchor via CSS
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.savePosition();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private restorePosition(): void {
    const root = this.root;
    if (!root) return;
    try {
      const raw = window.localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { x: number; y: number };
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          // Clamp into the current viewport in case the window shrank since.
          const x = Math.max(0, Math.min(p.x, window.innerWidth - 80));
          const y = Math.max(0, Math.min(p.y, window.innerHeight - 40));
          root.style.left = `${x}px`;
          root.style.top = `${y}px`;
          root.addClass("is-positioned"); // clears the default bottom-right anchor via CSS
          return;
        }
      }
    } catch { /* fall through to the default corner */ }
    // Default: bottom-right, out of the way (CSS provides the fallback anchor).
  }

  private savePosition(): void {
    const root = this.root;
    if (!root) return;
    try {
      const r = root.getBoundingClientRect();
      window.localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch { /* position is a convenience; ignore storage failures */ }
  }

  close(): void {
    if (this.flashTimer != null) { window.clearTimeout(this.flashTimer); this.flashTimer = null; }
    this.docCleanup?.();
    this.docCleanup = null;
    this.root?.remove();
    this.root = null;
    this.ta = null;
    this.titleEl = null;
    this.host = null;
  }
}
