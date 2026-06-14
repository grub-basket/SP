/**
 * Hotkey recorder: a small UI helper that wraps an HTMLInputElement and
 * captures the next key chord the user presses. Returns a normalized
 * Stashpad-style chord string:
 *
 *   single-key (no modifiers):       "S"
 *   chord with modifiers:            "Mod+Shift+ArrowUp"
 *
 * Modifier order is fixed (Mod, Ctrl, Alt, Shift) so equality compares
 * are stable. We translate the OS modifier (Cmd on Mac, Ctrl elsewhere)
 * into the literal "Mod" so cross-platform users don't have to think
 * about it. A bare Ctrl on Mac stays as "Ctrl" since it's a distinct
 * physical key from Cmd.
 *
 * Usage:
 *   const stop = startHotkeyRecording(inputEl, (chord) => { ... });
 *   stop(); // cancel without committing
 */

import { Platform } from "obsidian";

const isMac = Platform.isMacOS;

/** Render a chord for display in inputs / labels. Same format as the stored
 *  value, since we store the canonical form. */
export function formatChord(chord: string): string {
  return chord || "";
}

/** Pretty form for the bindings UI:
 *   - Mod → "Cmd" on Mac, "Ctrl" elsewhere.
 *   - Alt → "Option" on Mac (matches Apple keyboard caps).
 */
export function prettifyChord(chord: string): string {
  if (!chord) return "(none)";
  let out = chord.replace(/\bMod\b/g, isMac ? "Cmd" : "Ctrl");
  if (isMac) out = out.replace(/\bAlt\b/g, "Option");
  return out;
}

/** Begin capture on the input. The element gets `is-recording` class
 *  while active. Calling the returned function aborts capture. */
export function startHotkeyRecording(
  input: HTMLInputElement,
  onCapture: (chord: string) => void,
  opts: { allowSingleKey?: boolean } = { allowSingleKey: true },
): () => void {
  const placeholderBefore = input.placeholder;
  // 0.59.3: stash the prior value so cancel paths (Backspace, blur
  // without commit) can restore it instead of leaving the input blank.
  const valueBefore = input.value;
  input.placeholder = "Press a key… (Backspace to cancel)";
  input.value = "";
  input.classList.add("is-recording");

  let committed = false;
  const cleanup = () => {
    input.placeholder = placeholderBefore;
    input.classList.remove("is-recording");
    // Restore prior value if the user cancelled (didn't commit a chord).
    if (!committed) input.value = valueBefore;
    input.removeEventListener("keydown", onKeyDown, true);
    input.removeEventListener("blur", onBlur);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Ignore standalone modifier presses — wait for the actual key.
    if (e.key === "Control" || e.key === "Shift" || e.key === "Alt"
        || e.key === "Meta" || e.key === "OS") return;
    // 0.59.4: dead-key starters (Option+E on Mac, etc.) report e.key as
    // "Dead" because the OS is waiting for a follow-up to form a
    // diacritic. We still want to let the user BIND Option+E — it's a
    // real chord in a non-typing context — so accept them as long as
    // e.code resolves to a usable identity (KeyE → "E"). IME compose
    // states ("Process" / "Unidentified") with no usable code stay
    // rejected.
    const codeUsable = !!e.code && (/^Key[A-Z]$/.test(e.code) || /^Digit\d$/.test(e.code));
    if ((e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") && !codeUsable) return;
    e.preventDefault();
    e.stopPropagation();

    // Backspace cancels recording without binding anything — Esc was a
    // bad choice because Obsidian's settings tab also listens for Esc and
    // would close the entire window. (On Mac the same key is labeled
    // "delete"; on Windows/Linux it's "Backspace".) When Backspace is
    // bound to a real shortcut (e.g. as part of Mod+Backspace), the
    // modifier prefix arrives as part of the chord — only a BARE
    // Backspace cancels.
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      cleanup();
      return;
    }

    const parts: string[] = [];
    // Cmd (Mac) and Ctrl (others) both translate to "Mod". A user pressing
    // both Ctrl and Cmd on Mac would yield Mod+Ctrl — a niche case but
    // represented honestly.
    if (isMac) {
      if (e.metaKey) parts.push("Mod");
      if (e.ctrlKey) parts.push("Ctrl");
    } else {
      if (e.ctrlKey) parts.push("Mod");
    }
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");

    const key = normalizeKey(e.key, e.code);
    if (!key) return;

    if (parts.length === 0 && !opts.allowSingleKey) return;

    parts.push(key);
    const chord = parts.join("+");
    committed = true;
    cleanup();
    onCapture(chord);
  };

  const onBlur = () => cleanup();

  input.addEventListener("keydown", onKeyDown, true);
  input.addEventListener("blur", onBlur);
  return cleanup;
}

/** Normalize KeyboardEvent.key + .code to our chord vocabulary.
 *  - Letters/digits: derive from .code (KeyF → "F", Digit1 → "1") so
 *    Mac modifier-induced Unicode substitutions (Option+F → "ƒ") don't
 *    leak into the saved chord.
 *  - Named keys (Enter, ArrowUp, etc.): keep .key.
 *  - Symbols (/, ;, etc.): keep .key as-is. */
function normalizeKey(k: string, code?: string): string {
  if (!k) return "";
  // .code-based mapping for letters and digits — robust to Alt/Option
  // dead-key transformations and other modifier-induced glyph changes.
  if (code) {
    const m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    const d = /^Digit(\d)$/.exec(code);
    if (d) return d[1];
  }
  if (k.length === 1) {
    return k.toUpperCase();
  }
  // Multi-char keys: keep the canonical KeyboardEvent.key spelling.
  // Examples: "ArrowUp", "Enter", "Backspace", "Tab", "Escape", "PageUp".
  return k;
}
