import { getIconIds } from "obsidian";
import { DEFAULT_STOPWORDS } from "./slug-service";

/** Lucide icon ids available to `setIcon`, normalised (no "lucide-" prefix),
 *  built once and cached. */
let ICON_SET: Set<string> | null = null;
function iconSet(): Set<string> {
  if (ICON_SET) return ICON_SET;
  const s = new Set<string>();
  try { for (const raw of getIconIds()) s.add(raw.replace(/^lucide-/, "")); } catch { /* pre-load */ }
  ICON_SET = s;
  return s;
}

/** The question-mark fallback — whichever the running Obsidian ships. */
function fallbackIcon(set: Set<string>): string {
  for (const c of ["circle-help", "help-circle", "circle-question-mark", "help"]) if (set.has(c)) return c;
  return "circle-help";
}

/** 0.321.5: guess an icon for a command by its NAME — the same trick note
 *  titles use. Strip the note-title stop-words, then walk the remaining words in
 *  order: the first word that IS a Lucide icon (exact, then de-pluralised, then
 *  as a prefix of an icon id) wins; otherwise a question-mark icon.
 *
 *  `stopwords` defaults to the built-in list; callers pass the user's configured
 *  set so it matches how their note titles are slugged. */
export function guessCommandIcon(name: string, stopwords: readonly string[] = DEFAULT_STOPWORDS): string {
  const set = iconSet();
  const stop = new Set(stopwords.map((w) => w.toLowerCase()));
  const words = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w && !stop.has(w));
  if (!words.length) return fallbackIcon(set);
  // Pass 1: exact or de-pluralised exact match, word by word.
  for (const w of words) {
    if (set.has(w)) return w;
    const singular = w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : null;
    if (singular && set.has(singular)) return singular;
  }
  // Pass 2: the word is a PREFIX of some icon id (shortest match — closest name).
  for (const w of words) {
    if (w.length < 3) continue;
    let best: string | null = null;
    for (const id of set) { if (id.startsWith(w) && (!best || id.length < best.length)) best = id; }
    if (best) return best;
  }
  return fallbackIcon(set);
}
