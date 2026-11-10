/** 0.605.0: pure helpers for splitting shared attachments (no DOM, unit-tested).
 *  The vault work and the UI are in attachment-split.ts. */

/** Given a link's path, the vault path it should now point at, or null to leave
 *  that link as it is. */
export type Retarget = (linkpath: string) => string | null;

/** A short, stable tag for a folder: the same folder always gets the same tag,
 *  so a re-run after an interruption lands on the same file name. */
export function folderTag(folder: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < folder.length; i++) {
    h ^= folder.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(-4).padStart(4, "0");
}

/** A vault path as a Markdown link URL. Parentheses are encoded too, because an
 *  unbalanced one would end the link early. */
export function encodeLinkPath(path: string): string {
  return path.split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/** Character ranges of the frontmatter block and of code, where text that looks
 *  like a link isn't one. */
export function nonLinkRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let bodyStart = 0;
  if (/^---\r?\n/.test(text)) {
    const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
    if (close) {
      bodyStart = 3 + close.index + close[0].length;
      ranges.push([0, bodyStart]);
    }
  }
  // Fenced blocks, line by line.
  let pos = bodyStart;
  let fence: { char: string; len: number; start: number } | null = null;
  const prose: [number, number][] = [];
  let proseStart = bodyStart;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).replace(/\r$/, "");
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        ranges.push([fence.start, end]);
        fence = null;
        proseStart = end;
      }
    } else if (m) {
      fence = { char: m[1][0], len: m[1].length, start: pos };
      prose.push([proseStart, pos]);
    }
    pos = end + 1;
  }
  if (fence) ranges.push([fence.start, text.length]); // an unclosed fence runs to the end
  else prose.push([proseStart, text.length]);
  // Inline code, within the prose between fences.
  for (const [from, to] of prose) {
    const part = text.slice(from, to);
    for (const m of part.matchAll(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g)) {
      const start = from + (m.index ?? 0);
      ranges.push([start, start + m[0].length]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** A wikilink, or a Markdown link whose text may hold one level of brackets (an
 *  image inside a link) and whose title may use any of the three quote styles.
 *  Each alternative in the link text must start differently: if two could match
 *  the same characters, a long line of links backtracks exponentially and hangs
 *  the app. An inner `(url)` is matched as ordinary characters for that reason. */
const LINK = /(!?)\[\[([^[\]\n]+?)\]\]|(!?\[(?:[^[\]\\\n]|\\.|\[(?:[^[\]\\\n]|\\.)*\])*\]\()(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\))/g;

/** Rewrite the wikilinks and Markdown links in `text` that `retarget` claims,
 *  keeping each link's embed mark, heading or page reference, and display text.
 *  Links inside code or the frontmatter block are left alone unless `raw` is set
 *  (for a single frontmatter value). */
export function rewriteLinks(text: string, retarget: Retarget, opts: { raw?: boolean } = {}): { text: string; changed: number } {
  const masked = opts.raw ? [] : nonLinkRanges(text);
  let changed = 0;
  const out = text.replace(LINK, (m: string, bang: string | undefined, inner: string | undefined, mdOpen: string | undefined, url: string | undefined, mdClose: string | undefined, offset: number) => {
    if (masked.some(([a, b]) => offset >= a && offset < b)) return m;
    if (inner !== undefined) {
      const sep = inner.search(/\\?\|/);
      const target = sep < 0 ? inner : inner.slice(0, sep);
      const tail = sep < 0 ? "" : inner.slice(sep);
      const hash = target.indexOf("#");
      const linkpath = (hash < 0 ? target : target.slice(0, hash)).trim();
      const next = linkpath ? retarget(linkpath) : null;
      if (!next) return m;
      changed++;
      return `${bang ?? ""}[[${next}${hash < 0 ? "" : target.slice(hash)}${tail}]]`;
    }
    // An image inside a link is a link of its own, whatever the outer one does.
    let open = mdOpen ?? "";
    const textStart = open.startsWith("!") ? 2 : 1;
    const linkText = open.slice(textStart, -2);
    if (linkText.includes("](")) {
      const nested = rewriteLinks(linkText, retarget, { raw: true });
      if (nested.changed) {
        open = `${open.slice(0, textStart)}${nested.text}](`;
        changed += nested.changed;
      }
    }
    const unchanged = `${open}${url ?? ""}${mdClose ?? ""}`;
    const angle = (url ?? "").startsWith("<");
    const raw = angle ? (url as string).slice(1, -1) : (url ?? "");
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return unchanged; // an external URL
    const hash = raw.indexOf("#");
    const encoded = hash < 0 ? raw : raw.slice(0, hash);
    const sub = hash < 0 ? "" : raw.slice(hash);
    let linkpath = encoded;
    try { linkpath = decodeURIComponent(encoded); } catch { /* not encoded */ }
    const next = linkpath ? retarget(linkpath) : null;
    if (!next) return unchanged;
    changed++;
    return `${open}${angle ? `<${next}${sub}>` : `${encodeLinkPath(next)}${sub}`}${mdClose}`;
  });
  return { text: out, changed };
}

/** A byte count people can read. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[u]}`;
}

/** Update a stored path list after a file or folder was renamed. */
export function renamedPathList(list: readonly string[], oldPath: string, newPath: string): string[] | null {
  let hit = false;
  const next = list.map((p) => {
    if (p === oldPath) { hit = true; return newPath; }
    if (p.startsWith(`${oldPath}/`)) { hit = true; return `${newPath}${p.slice(oldPath.length)}`; }
    return p;
  });
  return hit ? next : null;
}
