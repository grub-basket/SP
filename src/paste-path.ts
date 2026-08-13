/** Clean up a filesystem path pasted from somewhere else.
 *
 *  Its own module, with no Obsidian imports, so it can be unit-tested under
 *  plain node — the reason it isn't sitting in modals.ts next to its only
 *  caller.
 *
 *  The shapes that actually turn up: Finder's "Copy as Pathname" and a file
 *  manager's drag both produce quoted strings, a terminal drag backslash-
 *  escapes spaces and shell metacharacters, and some managers hand over a
 *  `file://` URL with percent-encoding. Pasting any of those verbatim fails
 *  with "no file at that path" for a path that is plainly correct on screen,
 *  which is the most annoying possible error.
 */
export function normalisePastedPath(raw: string): string {
  let p = raw.trim();

  // Matched quotes only — an apostrophe inside a filename must survive.
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }

  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { /* keep the raw form */ }
  }

  // Shell escaping: a backslash before a space or a shell metacharacter is an
  // escape, never a literal. Restricted to that set on purpose — a backslash
  // before an ordinary character is a real character on a POSIX path (and the
  // whole separator on Windows), so stripping indiscriminately would corrupt
  // valid paths.
  p = p.replace(/\\(?=[ ()&'"[\]{}$!`;*?~])/g, "");

  return p.trim();
}
