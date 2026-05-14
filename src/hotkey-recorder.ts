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

const isMac = (() => {
  try {
    return typeof navigator !== "undefined"
      && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
  } catch { return false; }
})();

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
  input.placeholder = "Press a key… (Backspace to cancel)";
  input.value = "";
  input.classList.add("is-recording");

  const cleanup = () => {
    input.placeholder = placeholderBefore;
    input.classList.remove("is-recording");
    input.removeEventListener("keydown", onKeyDown, true);
    input.removeEventListener("blur", onBlur);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Ignore standalone modifier presses — wait for the actual key.
    if (e.key === "Control" || e.key === "Shift" || e.key === "Alt"
        || e.key === "Meta" || e.key === "OS") return;
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

    const key = normalizeKey(e.key);
    if (!key) return;

    if (parts.length === 0 && !opts.allowSingleKey) return;

    parts.push(key);
    const chord = parts.join("+");
    cleanup();
    onCapture(chord);
  };

  const onBlur = () => cleanup();

  input.addEventListener("keydown", onKeyDown, true);
  input.addEventListener("blur", onBlur);
  return cleanup;
}

/** Normalize KeyboardEvent.key to our chord vocabulary.
 *  - Letters → uppercase.
 *  - Arrow / Enter / etc → keep canonical name.
 *  - Symbols (/, ;, etc) → keep as-is. */
function normalizeKey(k: string): string {
  if (!k) return "";
  if (k.length === 1) {
    return k.toUpperCase();
  }
  // Multi-char keys: keep the canonical KeyboardEvent.key spelling.
  // Examples: "ArrowUp", "Enter", "Backspace", "Tab", "Escape", "PageUp".
  return k;
}
