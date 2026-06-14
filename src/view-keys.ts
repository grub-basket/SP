import { Platform } from "obsidian";

export function matchKey(e: KeyboardEvent, key: string): boolean {
  if (!key) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key.toLowerCase() === key.toLowerCase();
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
  return e.key.toLowerCase() === keyPart;
}
