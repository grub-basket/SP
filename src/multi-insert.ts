import { Notice, Platform } from "obsidian";

/** 0.510.0: "Insert at multiple points" for a plain <textarea>.
 *
 *  A <textarea> has exactly one native caret, so there is no OS-style
 *  multi-cursor to lean on. This is the pragmatic shape the user picked instead
 *  of live multi-caret editing: MARK several spots, type the text ONCE, and it
 *  drops in at every marked spot at once.
 *
 *  Flow: the toolbar button starts "mark mode" → each click in the textarea
 *  toggles a mark (a pin is drawn over that caret position) → a small panel under
 *  the editor takes the text and an Apply button (0.544.0: docked as a strip on
 *  top of the formatting toolbar when the toolbar passes itself as `dock`) → the text is inserted at every
 *  mark (processed right-to-left so earlier offsets stay valid) → marks clear and
 *  mode ends. Esc cancels; editing the textarea's own text clears the marks
 *  (their offsets would otherwise drift).
 *
 *  One controller per textarea, tracked in a module WeakMap so the toolbar button
 *  (rebuilt on every render) always toggles the SAME live session. */

const CONTROLLERS = new WeakMap<HTMLTextAreaElement, MultiInsert>();

/** Pixel position of the caret at `pos` within `ta`, relative to the textarea's
 *  own content box (before scroll). Uses the standard hidden-mirror technique: a
 *  div that copies every style affecting wrapping, with a marker span at the
 *  offset whose offsetLeft/Top is the caret position. */
function caretCoords(ta: HTMLTextAreaElement, pos: number): { x: number; y: number; height: number } {
  const doc = ta.ownerDocument ?? document;
  const cs = getComputedStyle(ta);
  const div = doc.createElement("div");
  const s = div.style;
  s.position = "absolute";
  s.visibility = "hidden";
  s.whiteSpace = "pre-wrap";
  s.overflowWrap = "break-word";
  // Force content-box and compute the content width from clientWidth (content +
  // padding, minus scrollbar) so wrapping matches regardless of the textarea's
  // own box-sizing — getComputedStyle("width") is unreliable across box models.
  s.boxSizing = "content-box";
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  s.width = `${Math.max(0, ta.clientWidth - padL - padR)}px`;
  s.font = cs.font;
  s.fontFamily = cs.fontFamily;
  s.fontSize = cs.fontSize;
  s.fontWeight = cs.fontWeight;
  s.lineHeight = cs.lineHeight;
  s.letterSpacing = cs.letterSpacing;
  s.textTransform = cs.textTransform;
  s.tabSize = cs.tabSize;
  s.paddingTop = cs.paddingTop;
  s.paddingRight = cs.paddingRight;
  s.paddingBottom = cs.paddingBottom;
  s.paddingLeft = cs.paddingLeft;
  s.borderTopWidth = cs.borderTopWidth;
  s.borderRightWidth = cs.borderRightWidth;
  s.borderBottomWidth = cs.borderBottomWidth;
  s.borderLeftWidth = cs.borderLeftWidth;
  s.borderStyle = "solid";

  const before = ta.value.slice(0, pos);
  div.textContent = before;
  const marker = doc.createElement("span");
  // A non-empty marker so an offset at the very end (or on a blank line) still
  // has a measurable box.
  marker.textContent = ta.value.slice(pos) || ".";
  div.appendChild(marker);
  doc.body.appendChild(div);
  const x = marker.offsetLeft;
  const y = marker.offsetTop;
  doc.body.removeChild(div);
  const height = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 18;
  return { x, y, height };
}

export class MultiInsert {
  private marks: number[] = [];
  private active = false;
  private layer: HTMLElement | null = null; // pin overlay (fixed-positioned)
  private panel: HTMLElement | null = null; // text-entry panel (docked strip, or fixed fallback)
  /** 0.544.0: element the panel is docked directly above (the toolbar bar). */
  private dock: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private doc: Document;
  private onChange: ((active: boolean) => void) | null = null;

  private constructor(private ta: HTMLTextAreaElement) {
    this.doc = ta.ownerDocument ?? document;
  }

  /** Start (or re-focus) a mark session for `ta`; a second call ends it, so the
   *  one toolbar button toggles the mode. `onChange` fires with the new active
   *  state on start AND on end (so the button's highlight tracks the session even
   *  when it ends via Apply/Esc rather than the button). */
  static toggle(ta: HTMLTextAreaElement, onChange?: (active: boolean) => void, dock?: HTMLElement): void {
    const existing = CONTROLLERS.get(ta);
    if (existing && existing.active) { existing.cancel(); return; }
    const c = existing ?? new MultiInsert(ta);
    c.onChange = onChange ?? null;
    c.dock = dock ?? null;
    CONTROLLERS.set(ta, c);
    c.start();
  }

  static isActive(ta: HTMLTextAreaElement | null): boolean {
    return !!ta && !!CONTROLLERS.get(ta)?.active;
  }

  private start(): void {
    this.active = true;
    this.marks = [];
    this.onChange?.(true);
    this.buildOverlay();
    this.ta.addEventListener("click", this.onTaClick, true);
    this.ta.addEventListener("input", this.onTaInput);
    this.ta.addEventListener("scroll", this.repaint);
    this.doc.addEventListener("keydown", this.onKeyDown, true);
    this.doc.defaultView?.addEventListener("resize", this.repaint);
    this.repaint();
    // No mark is seeded — the user clicks every spot explicitly, so nothing is
    // ever inserted somewhere they didn't point at. Focus the input so they can
    // type the text while they click.
    this.input?.focus();
  }

  private buildOverlay(): void {
    const body = this.doc.body;
    this.layer = body.createDiv({ cls: "stashpad-multiinsert-layer" });
    // 0.544.0: the floating panel (fixed, under the textarea) landed badly on
    // both desktop and mobile — off the bottom of a tall edit modal, under the
    // keyboard. Dock it as a strip directly ABOVE the toolbar instead, in normal
    // flow like the drafts chip / "Similar notes" strip in the composer. The
    // fixed panel stays only as a fallback when there is no live toolbar.
    const dockParent = this.dock?.isConnected ? this.dock.parentElement : null;
    if (dockParent && this.dock) {
      this.panel = dockParent.createDiv({ cls: "stashpad-multiinsert-panel is-docked" });
      dockParent.insertBefore(this.panel, this.dock);
    } else {
      this.panel = body.createDiv({ cls: "stashpad-multiinsert-panel" });
    }
    this.countEl = this.panel.createSpan({ cls: "stashpad-multiinsert-count" });
    // 0.552.0: Insert + Cancel sit to the LEFT of the text field (right after the
    // mark count) instead of trailing it. The input's flex-grow used to shove both
    // buttons to the panel's far-right edge — a long desktop reach from the toolbar
    // button that opens the panel. DOM order = flex order: count · Insert · Cancel · input.
    const apply = this.panel.createEl("button", { cls: "stashpad-multiinsert-apply mod-cta", text: "Insert" });
    apply.onmousedown = (e) => e.preventDefault();
    apply.onclick = () => this.apply();
    const cancel = this.panel.createEl("button", { cls: "stashpad-multiinsert-cancel", text: "Cancel" });
    cancel.onmousedown = (e) => e.preventDefault();
    cancel.onclick = () => this.cancel();
    this.input = this.panel.createEl("input", {
      type: "text",
      cls: "stashpad-multiinsert-input",
      attr: { placeholder: "Text to insert at each mark…" },
    });
    const hint = this.panel.createSpan({ cls: "stashpad-multiinsert-hint" });
    hint.setText(Platform.isPhone ? "Tap spots to mark · Esc cancels" : "Click spots in the note to mark them · Enter inserts · Esc cancels");
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.apply(); }
      else if (e.key === "Escape") { e.preventDefault(); this.cancel(); }
    });
  }

  private onTaClick = (): void => {
    // The browser has already moved the native caret to the click point, so
    // selectionStart is the clicked offset. Toggle a mark there.
    const off = this.ta.selectionStart;
    if (Number.isFinite(off)) this.toggleMark(off);
  };

  private onTaInput = (): void => {
    // Editing the text invalidates every offset — drop the marks rather than let
    // pins drift onto the wrong characters.
    if (this.marks.length) { this.marks = []; this.repaint(); }
  };

  /** 0.544.3: a composer rebuild / edit-modal re-render can take the textarea or
   *  the docked panel away mid-session. End the session then, so its pins and
   *  capture-phase Escape handler don't outlive the UI they belong to. */
  private orphaned(): boolean {
    if (this.ta.isConnected && this.panel?.isConnected) return false;
    this.teardown();
    return true;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active || this.orphaned()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.cancel(); }
  };

  private toggleMark(off: number): void {
    const clamped = Math.max(0, Math.min(this.ta.value.length, Math.round(off)));
    const i = this.marks.indexOf(clamped);
    if (i >= 0) this.marks.splice(i, 1);
    else this.marks.push(clamped);
    this.repaint();
  }

  private repaint = (): void => {
    if (!this.active || !this.layer || !this.countEl || this.orphaned()) return;
    const rect = this.ta.getBoundingClientRect();
    this.layer.empty();
    for (const off of this.marks) {
      const { x, y, height } = caretCoords(this.ta, off);
      const left = rect.left + x - this.ta.scrollLeft;
      const top = rect.top + y - this.ta.scrollTop;
      // Only draw pins whose caret is within the visible textarea box.
      if (top + height < rect.top || top > rect.bottom) continue;
      const pin = this.layer.createDiv({ cls: "stashpad-multiinsert-pin" });
      pin.style.left = `${left}px`;
      pin.style.top = `${top}px`;
      pin.style.height = `${height}px`;
    }
    const n = this.marks.length;
    this.countEl.setText(n === 0 ? "No marks yet" : `${n} mark${n === 1 ? "" : "s"}`);
    // Anchor the (fallback, floating) panel just under the textarea.
    if (this.panel && !this.panel.hasClass("is-docked")) {
      this.panel.style.left = `${rect.left}px`;
      this.panel.style.top = `${Math.min(rect.bottom + 6, (this.doc.defaultView?.innerHeight ?? rect.bottom) - 48)}px`;
      this.panel.style.minWidth = `${Math.min(rect.width, 420)}px`;
    }
  };

  private apply(): void {
    const text = this.input?.value ?? "";
    if (!this.marks.length) { new Notice("Click where you want the text inserted first."); return; }
    if (!text) { new Notice("Type the text to insert."); this.input?.focus(); return; }
    // Insert right-to-left so each insertion doesn't shift the offsets still to
    // come. Dedupe + clamp defensively.
    const points = [...new Set(this.marks)].map((m) => Math.max(0, Math.min(this.ta.value.length, m))).sort((a, b) => b - a);
    let value = this.ta.value;
    for (const p of points) value = value.slice(0, p) + text + value.slice(p);
    this.ta.value = value;
    // Put the caret after the last (lowest-offset) insertion.
    const firstPoint = points[points.length - 1];
    const caret = firstPoint + text.length;
    try { this.ta.setSelectionRange(caret, caret); } catch { /* detached */ }
    this.ta.dispatchEvent(new Event("input", { bubbles: true }));
    new Notice(`Inserted at ${points.length} point${points.length === 1 ? "" : "s"}.`);
    this.teardown();
    this.ta.focus();
  }

  private cancel(): void {
    this.teardown();
    this.ta.focus();
  }

  private teardown(): void {
    this.active = false;
    this.marks = [];
    this.onChange?.(false);
    this.ta.removeEventListener("click", this.onTaClick, true);
    this.ta.removeEventListener("input", this.onTaInput);
    this.ta.removeEventListener("scroll", this.repaint);
    this.doc.removeEventListener("keydown", this.onKeyDown, true);
    this.doc.defaultView?.removeEventListener("resize", this.repaint);
    this.layer?.remove(); this.layer = null;
    this.panel?.remove(); this.panel = null;
    this.input = null; this.countEl = null;
  }
}
