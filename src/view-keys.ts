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
      const low = s.toLowerCase();
      if (low === "mod") return isMac ? "Cmd" : "Ctrl";
      if (low === "alt" || low === "option") return isMac ? "Opt" : "Alt";
      // 0.278.0: title-case the remaining modifier words so lowercase tokens
      // (e.g. the copy-timestamp "shift"/"ctrl") render properly. Backward-
      // compatible: already-capitalized chord parts map to the same output.
      if (low === "shift") return "Shift";
      if (low === "ctrl" || low === "control") return "Ctrl";
      if (low === "cmd" || low === "meta" || low === "command") return "Cmd";
      return s.length === 1 ? s.toUpperCase() : s;
    })
    .filter(Boolean)
    .join("+");
}

/** Canonical modifier tokens in a fixed serialization order. `copyTimestampModifiers`
 *  is stored as a `+`-joined subset of these (e.g. "alt+shift"); empty = feature off.
 *  0.278.0 — the timestamp-on-copy modifier gesture. */
export const COPY_TS_MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"] as const;
export type CopyTsModifier = (typeof COPY_TS_MODIFIER_ORDER)[number];

/** Parse a stored modifier string into canonical, de-duplicated, order-normalized tokens. */
export function parseModifierTokens(str: string | undefined | null): CopyTsModifier[] {
  if (!str) return [];
  const set = new Set(str.split("+").map((s) => s.trim().toLowerCase()));
  // fold synonyms so a hand-edited "cmd"/"meta"/"option"/"control" still resolves
  if (set.has("cmd") || set.has("meta") || set.has("command")) set.add("mod");
  if (set.has("option")) set.add("alt");
  if (set.has("control")) set.add("ctrl");
  return COPY_TS_MODIFIER_ORDER.filter((m) => set.has(m));
}

/** Serialize a set/list of modifier tokens back to the canonical stored string. */
export function serializeModifierTokens(tokens: Iterable<string>): string {
  const set = new Set([...tokens].map((t) => t.toLowerCase()));
  return COPY_TS_MODIFIER_ORDER.filter((m) => set.has(m)).join("+");
}

interface AnyBinding { primary: string; secondary: string; preferRight: boolean; useBoth?: boolean }

/** The chord(s) a binding would actually match on, mirroring matchBinding's selection. */
export function activeChords(b?: AnyBinding): string[] {
  if (!b) return [];
  const { primary, secondary, preferRight, useBoth } = b;
  if (primary && secondary) {
    if (useBoth) return [primary, secondary];
    return [preferRight ? secondary : primary];
  }
  return [primary, secondary].filter(Boolean);
}

/** Add the given modifiers to a chord, de-duplicating and re-ordering the mod segment.
 *  A bare-key chord ("c") gains a mod segment ("shift+c"); an existing mod stays once. */
function augmentChord(chord: string, mods: CopyTsModifier[]): string {
  if (!chord) return "";
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  const present = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const modSet = new Set(present);
  for (const m of mods) modSet.add(m);
  // normalize "mod" family so a base "cmd+c" and an added "mod" don't double up on macOS
  const ordered = COPY_TS_MODIFIER_ORDER.filter(
    (m) => modSet.has(m)
      || (m === "mod" && (modSet.has("cmd") || modSet.has("meta") || modSet.has("command")))
      || (m === "alt" && modSet.has("option"))
      || (m === "ctrl" && modSet.has("control")),
  );
  // preserve any bare mod segment that isn't in our canonical set (defensive)
  return [...ordered, key].join("+");
}

/** Does the event match the binding WITH the extra invert-modifiers also held? */
export function matchBindingWithMods(e: KeyboardEvent, b: AnyBinding | undefined, mods: CopyTsModifier[]): boolean {
  if (!b || !mods.length) return false;
  for (const chord of activeChords(b)) {
    const aug = augmentChord(chord, mods);
    // The modifier is already part of this chord → adding it forms no distinct
    // chord. Skip so plain Copy keeps working (never silently forced to always
    // include timestamps). The settings status line warns about this case.
    if (aug === normalizeChord(chord)) continue;
    if (aug.includes("+") && matchMod(e, aug)) return true;
  }
  return false;
}

/** Are ALL of the given modifiers pressed on this (mouse or keyboard) event?
 *  Used by the context-menu Copy items, where the user holds the modifier while clicking. */
export function eventHasMods(
  e: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } | null | undefined,
  mods: CopyTsModifier[],
): boolean {
  if (!e || !mods.length) return false;
  const isMac = Platform.isMacOS;
  for (const m of mods) {
    if (m === "mod") { if (!(isMac ? e.metaKey : e.ctrlKey)) return false; }
    else if (m === "ctrl") { if (!e.ctrlKey) return false; }
    else if (m === "alt") { if (!e.altKey) return false; }
    else if (m === "shift") { if (!e.shiftKey) return false; }
  }
  return true;
}

/** A human-readable status line for the settings UI: given the chosen modifiers and the
 *  Copy binding, say whether the keyboard path will actually fire (and note the caveats). */
export function copyTimestampStatus(mods: CopyTsModifier[], copyBinding?: AnyBinding): string {
  if (!mods.length) return "Off — copies never include timestamps.";
  const combo = humanCombo(mods.join("+"));
  const chords = activeChords(copyBinding);
  const palette = " The command palette can't detect modifiers, so it always copies without timestamps.";
  if (!chords.length) {
    return `Hold ${combo} while clicking the menu's “Copy” item to include timestamps. Copy has no keyboard shortcut set, so the keyboard path is unavailable until you bind one.${palette}`;
  }
  // If every active chord already contains one of the chosen modifiers, adding it can't
  // form a distinct chord — the keyboard path collapses into the plain Copy shortcut.
  const collapses = chords.every((c) => augmentChord(c, mods) === normalizeChord(c));
  if (collapses) {
    return `⚠︎ ${combo} is already part of your Copy shortcut (${chords.map(humanCombo).join(" / ")}), so holding it can't be told apart from a normal copy. The keyboard path won't work — pick a different modifier, or use it by holding ${combo} while clicking the menu's “Copy” item.${palette}`;
  }
  return `Hold ${combo} while copying (your Copy shortcut ${chords.map(humanCombo).join(" / ")}, or the menu's “Copy” item) to include timestamps.${palette}`;
}

/** Re-order a chord's mod segment the same way augmentChord does, for equality checks. */
function normalizeChord(chord: string): string {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return chord;
  return augmentChord(chord, []);
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
