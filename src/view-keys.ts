import { Platform } from "obsidian";

/** Physical key identity matching hotkey-recorder's normalizeKey: letters and
 *  top-row digits come from `e.code` (KeyE→"e", Digit1→"1") so they're immune to
 *  Shift ("!"→"1") and Alt/Option dead-key glyphs (Option+E→"†"/"Dead") and
 *  layout remaps — the recorder stores that same identity, so the matcher MUST
 *  use it too or Shift+digit and (macOS) Alt+letter bindings never fire. Named
 *  keys + symbols fall back to `e.key`. 0.140.15 */
function eventKeyId(e: KeyboardEvent): string {
  const code = e.code || "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  return (e.key || "").toLowerCase();
}

export function matchKey(e: KeyboardEvent, key: string): boolean {
  if (!key) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // Single-character SYMBOL bindings (e.g. "&", "/", ";") match the produced
  // glyph directly. eventKeyId normalizes a shifted digit to its base digit
  // (Shift+7 → "7"), so a glyph default like "&" would never match — the merge
  // hotkey defaulted to "&" and was silently dead. Comparing against e.key makes
  // it fire on any layout that produces the glyph (US/UK Shift+7, AZERTY's
  // unshifted &), and plain "7" still won't trigger it (e.key is "7", not "&").
  // 0.144.0
  if (key.length === 1 && !/[a-z0-9]/i.test(key)) return e.key === key;
  return eventKeyId(e) === key.toLowerCase();
}

/** Try a chord regardless of whether it's a single key or a Mod combo. */
export function matchChord(e: KeyboardEvent, chord: string): boolean {
  if (!chord) return false;
  if (chord.includes("+")) return matchMod(e, chord);
  return matchKey(e, chord);
}

/** Match a CommandBinding against the event, honoring preferRight when both
 *  primary and secondary are set. */
export function matchBinding(e: KeyboardEvent, b?: { primary: string; secondary: string; preferRight: boolean; useBoth?: boolean }): boolean {
  if (!b) return false;
  const { primary, secondary, preferRight, useBoth } = b;
  if (primary && secondary) {
    // 0.59.1: useBoth overrides preferRight — both chords are active.
    if (useBoth) return matchChord(e, primary) || matchChord(e, secondary);
    return preferRight ? matchChord(e, secondary) : matchChord(e, primary);
  }
  return matchChord(e, primary) || matchChord(e, secondary);
}

export function humanCombo(combo: string): string {
  if (!combo) return "";
  const isMac = Platform.isMacOS;
  return combo
    .split("+")
    .map((p) => {
      const s = p.trim();
      if (!s) return "";
      if (s.toLowerCase() === "mod") return isMac ? "Cmd" : "Ctrl";
      if (s.toLowerCase() === "alt") return isMac ? "Opt" : "Alt";
      return s.length === 1 ? s.toUpperCase() : s;
    })
    .filter(Boolean)
    .join("+");
}

export function matchMod(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const keyPart = parts[parts.length - 1].toLowerCase();
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const wantMod = mods.has("mod");
  const wantCtrl = mods.has("ctrl") || mods.has("control");
  const wantCmd = mods.has("cmd") || mods.has("meta") || mods.has("command");
  const wantAlt = mods.has("alt") || mods.has("option");
  const wantShift = mods.has("shift");
  const isMac = Platform.isMacOS;
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  if (wantMod && !modPressed) return false;
  if (wantCtrl && !e.ctrlKey) return false;
  if (wantCmd && !e.metaKey) return false;
  if (wantAlt !== e.altKey) return false;
  if (wantShift !== e.shiftKey) return false;
  if (!wantMod) {
    if (!wantCtrl && e.ctrlKey) return false;
    if (!wantCmd && e.metaKey) return false;
  }
  return eventKeyId(e) === keyPart;
}
