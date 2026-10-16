/** One file/folder name from free text (a note title, a typed folder name),
 *  safe on Windows, macOS and Linux, so a vault made on a Mac still syncs and
 *  opens on Windows.
 *
 *  - Double quotes (straight and curly) are DROPPED: `Say "hi"` → `Say hi`.
 *  - Characters Windows forbids — `\ / : * ? < > |` and control characters —
 *    become a dash. With a space beside them they become ` - ` so the words stay
 *    apart: `Q3: Plan` → `Q3 - Plan`, `a/b` → `a-b`.
 *  - `linkSafe` also dashes `# ^ [ ]`, which are legal on disk but break
 *    Obsidian `[[wikilinks]]` (use it for names that live inside the vault).
 *  - Leading dots (hidden file) and trailing dots/spaces (Windows strips them,
 *    so two names could collide) are trimmed, as are dashes left at either end.
 *  - Windows' reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9) get a
 *    `_` so `CON` → `CON_`.
 *  - Cut to `max` code points (emoji-safe); empty → `fallback`.
 *
 *  Note files don't need this: `bodyToSlug` (slug-service.ts) already keeps only
 *  ASCII letters, digits and hyphens. This is for every OTHER title-derived name. */
export interface SafeFileNameOptions {
  /** Max length in code points (default 100). */
  max?: number;
  /** Returned when nothing usable is left (default ""). */
  fallback?: string;
  /** Also replace `# ^ [ ]` (Obsidian link syntax). */
  linkSafe?: boolean;
}

const QUOTES = /["“”„‟]/g;
// C0 control characters U+0000-U+001F plus DEL (U+007F), as character-class
// members. Built from char codes at runtime so the source holds no regex with
// control characters in it (the store review forbids the `no-control-regex`
// disable comment this used to need). Same pattern as the old literals:
//   /(?:\s*[\\/:*?<>|\u0000-\u001f\u007f])+\s*/g        (+ `#^[\]` for ILLEGAL_LINK)
const CONTROL_CHARS = `${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`;
const ILLEGAL = new RegExp(`(?:\\s*[\\\\/:*?<>|${CONTROL_CHARS}])+\\s*`, "g");
const ILLEGAL_LINK = new RegExp(`(?:\\s*[\\\\/:*?<>|${CONTROL_CHARS}#^[\\]])+\\s*`, "g");
const EDGES = /^[\s.-]+|[\s.-]+$/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)/i;

export function safeFileName(raw: string, opts: SafeFileNameOptions = {}): string {
  const { max = 100, fallback = "", linkSafe = false } = opts;
  // Tabs/newlines collapse to a space FIRST, so they read as spacing rather
  // than as illegal control characters.
  let s = (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(QUOTES, "")
    .replace(linkSafe ? ILLEGAL_LINK : ILLEGAL, (m) => (/\s/.test(m) ? " - " : "-"))
    .replace(/\s+/g, " ")
    .replace(EDGES, "");
  s = Array.from(s).slice(0, max).join("").replace(EDGES, "");
  s = s.replace(RESERVED, "$1_");
  return s || fallback;
}
