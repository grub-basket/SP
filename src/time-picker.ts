import { setIcon } from "obsidian";

/** 0.76.23: the numpad time-picker UI, extracted from the search
 *  When-builder so the due-date modal can reuse the exact same
 *  control. PURE UI — it builds its widgets into a host element you
 *  provide and reports the result via `onFinalize`; the caller owns
 *  the popover lifecycle (positioning, click-outside, close). That
 *  keeps the search picker's scope-aware host and the modal's plain
 *  host independent while sharing one control. */

export interface TimePickResult {
  /** 24-hour hours (0–23) — convenient for native <input type=time>. */
  hours24: number;
  minutes: number;
  /** Raw entry so a caller can reproduce an exact display string:
   *  `hh` is what was typed (1–24), `period` the am/pm toggle, and
   *  `is24` true when hh > 12 (am/pm meaningless). */
  raw: { hh: number; mm: number; period: "am" | "pm"; is24: boolean };
}

export interface BuildTimePickerOpts {
  seedH: number;            // 1–24 (or 1–12) to prefill the HH field
  seedM: number;            // 0–59
  seedPeriod: "am" | "pm";
  onFinalize: (r: TimePickResult) => void;
  /** Close the host popover (called after finalize / on OK). */
  close: () => void;
  /** Register the host's Enter handler so Enter anywhere finalizes. */
  setOnEnter?: (cb: () => void) => void;
}

/** Convert a typed (hh 1–24, period) into 24-hour hours. */
function to24(hh: number, period: "am" | "pm"): number {
  if (hh > 12) return hh >= 24 ? 0 : hh;       // already 24-hour
  if (period === "am") return hh === 12 ? 0 : hh;
  return hh === 12 ? 12 : hh + 12;
}

/** Build the numpad time picker into `pop`. Mirrors the search
 *  When-builder's control exactly (HH : MM + AM/PM toggle on top,
 *  3×4 numpad below). */
export function buildTimePickerInto(pop: HTMLElement, opts: BuildTimePickerOpts): void {
  pop.addClass("stashpad-when-pop-time");
  let period = opts.seedPeriod;

  const display = pop.createDiv({ cls: "stashpad-when-time-display" });
  const hField = display.createEl("input", {
    cls: "stashpad-when-time-field",
    attr: { type: "text", inputmode: "numeric", maxlength: "2" },
  }) as HTMLInputElement;
  hField.value = String(opts.seedH);
  display.createSpan({ cls: "stashpad-when-time-colon", text: ":" });
  const mField = display.createEl("input", {
    cls: "stashpad-when-time-field",
    attr: { type: "text", inputmode: "numeric", maxlength: "2" },
  }) as HTMLInputElement;
  mField.value = String(opts.seedM).padStart(2, "0");

  const periodWrap = display.createDiv({ cls: "stashpad-when-time-period" });
  const amBtn = periodWrap.createEl("button", { cls: "stashpad-when-time-ampm", text: "AM" });
  amBtn.type = "button";
  const pmBtn = periodWrap.createEl("button", { cls: "stashpad-when-time-ampm", text: "PM" });
  pmBtn.type = "button";
  const syncPeriod = (): void => {
    amBtn.toggleClass("is-active", period === "am");
    pmBtn.toggleClass("is-active", period === "pm");
  };
  syncPeriod();
  amBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
  pmBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
  amBtn.addEventListener("click", (ev) => { ev.preventDefault(); period = "am"; syncPeriod(); });
  pmBtn.addEventListener("click", (ev) => { ev.preventDefault(); period = "pm"; syncPeriod(); });

  let focused: HTMLInputElement = hField;
  hField.addEventListener("focus", () => { focused = hField; hField.select(); });
  mField.addEventListener("focus", () => { focused = mField; mField.select(); });

  const syncAmpmEnabled = (): void => {
    const h = parseInt(hField.value || "0", 10) || 0;
    const is24 = h > 12;
    amBtn.toggleClass("is-disabled", is24);
    pmBtn.toggleClass("is-disabled", is24);
    amBtn.disabled = is24;
    pmBtn.disabled = is24;
  };

  const clamp = (el: HTMLInputElement): void => {
    const v = el.value.replace(/\D/g, "").slice(0, 2);
    if (v === "") { el.value = ""; if (el === hField) syncAmpmEnabled(); return; }
    let n = parseInt(v, 10);
    if (el === hField) { if (n > 24) n = 24; }
    else { if (n > 59) n = 59; }
    el.value = String(n);
    if (el === hField) syncAmpmEnabled();
  };
  for (const el of [hField, mField]) el.addEventListener("input", () => clamp(el));
  syncAmpmEnabled();

  const finalize = (): void => {
    const hh = parseInt(hField.value || "12", 10) || 12;
    const mm = parseInt(mField.value || "0", 10) || 0;
    const is24 = hh > 12;
    opts.onFinalize({
      hours24: to24(hh, period),
      minutes: mm,
      raw: { hh, mm, period, is24 },
    });
    opts.close();
  };
  opts.setOnEnter?.(finalize);

  const tabRing: HTMLElement[] = [hField, mField, amBtn, pmBtn];
  const cycleFocus = (cur: HTMLElement, dir: 1 | -1): void => {
    const idx = tabRing.indexOf(cur);
    if (idx === -1) return;
    const next = (idx + dir + tabRing.length) % tabRing.length;
    tabRing[next].focus();
  };
  const trapKey = (el: HTMLElement): void => {
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); finalize(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); opts.close(); }
      else if (ev.key === "Tab") { ev.preventDefault(); ev.stopPropagation(); cycleFocus(el, ev.shiftKey ? -1 : 1); }
    });
  };

  const pad = pop.createDiv({ cls: "stashpad-when-time-pad" });
  const keys = ["1","2","3","4","5","6","7","8","9","backspace","0","insert"];
  let okBtn: HTMLButtonElement | null = null;
  for (const key of keys) {
    const b = pad.createEl("button", { cls: "stashpad-when-time-padbtn" });
    b.type = "button";
    if (key === "backspace") setIcon(b, "delete");
    else if (key === "insert") { b.setText("OK"); okBtn = b; }
    else b.setText(key);
    if (key === "insert") b.addClass("is-go");
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (key === "insert") { finalize(); return; }
      if (key === "backspace") {
        focused.value = focused.value.slice(0, -1);
        clamp(focused);
        focused.focus();
        return;
      }
      const allSelected =
        focused.selectionStart === 0 &&
        focused.selectionEnd === focused.value.length &&
        focused.value.length > 0;
      const cap = 2;
      const next = allSelected || focused.value.length >= cap ? key : focused.value + key;
      focused.value = next;
      clamp(focused);
      focused.focus();
      focused.setSelectionRange(focused.value.length, focused.value.length);
      if (focused === hField && focused.value.length >= cap) { mField.focus(); mField.select(); }
    });
  }
  if (okBtn) tabRing.push(okBtn);
  for (const el of tabRing) trapKey(el);
  hField.focus();
  hField.select();
}

/** Format a finalized pick the way the search When-builder inserts it:
 *  `h:MMam` / `h:MMpm` for 12-hour, or `HH:MM` (no suffix) for 24-hour
 *  entries. */
export function formatWhenTime(r: TimePickResult): string {
  const { hh, mm, period, is24 } = r.raw;
  return is24
    ? `${hh}:${String(mm).padStart(2, "0")}`
    : `${hh}:${String(mm).padStart(2, "0")}${period}`;
}
