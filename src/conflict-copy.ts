/** Is this file a sync tool's conflict copy, judged from its filename alone?
 *
 *  0.596.0: sync tools mark a conflict copy by appending a parenthetical at the
 *  RIGHT end of the name, just before the extension:
 *    Obsidian Sync  `Note (Conflicted copy MacBook 202610291001).md`
 *    Dropbox        `Note (Alex's conflicted copy 2026-10-29).md`
 *  The old rule (0.272.4) wanted "(conflicted copy" right after the opening
 *  parenthesis, so Dropbox's "(<name>'s conflicted copy …)" was missed. Now any
 *  parenthetical containing "conflicted copy" counts, as long as it sits in the
 *  trailing run of parentheticals: later "(1)"-style suffixes are allowed, but a
 *  title with "(conflicted copy)" in the middle is not a conflict copy.
 *  Syncthing's `Note.sync-conflict-20261029-100102-ABCDEFG.md` has no
 *  parentheses, so its own marker is matched separately. */
export function isConflictCopy(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]+)?(?=[.\s]|$)/i.test(name)) return true;
  // Inside the marker, allow ONE level of nested parentheses: macOS names
  // machines like "MacBook Pro (2)", and that name lands inside the marker.
  // The tail allows a de-dupe number (`… (conflicted copy) 1.md`) and any
  // number of extensions (`.md`, `.excalidraw.md`, none).
  const inner = String.raw`(?:[^()]|\([^()]*\))*`;
  return new RegExp(
    String.raw`\(${inner}\b(?:conflicted copy|sync[- ]?conflict)\b${inner}\)(?:\s*\(${inner}\))*(?:\s+\d{1,3})?\s*(?:\.[A-Za-z0-9]{1,10})*$`,
    "i",
  ).test(name);
}
