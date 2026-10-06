/** 0.542.0: keep bare `obsidian://…` URLs in one piece through MarkdownRenderer.
 *
 *  The body renderer autolinks bare deep links AFTER Obsidian renders the note,
 *  by which point the markdown pass has already chewed on the URL:
 *  - `*`, `_x_`, `__x__` (an `_` right after `=` is word-boundary) become
 *    `<em>`/`<strong>`, so the link stops at the first marker and the rest
 *    renders as italic/bold text;
 *  - `&note=` is read as the HTML entity `&not` and shows (and links) as `¬e=`,
 *    dropping the note from every pasted note link.
 *
 *  Fix: before rendering, swap each bare URL for an inert alphanumeric token
 *  (`protectDeepLinks`), then swap the tokens back for the original text after
 *  (`restoreDeepLinks`) — as a link, or as plain text where a link can't go
 *  (inside a link, code, or pre). Pure string half here so it's unit-testable. */

/** Same URL shape the DOM autolinker uses, minus `|` (a table cell divider),
 *  `[`/`]` (a link used as `[link text](…)`) and backticks. encodeURIComponent
 *  never emits any of them, so no real deep link is cut short. */
const URL_RX = /obsidian:\/\/[^\s<>"'|`[\]]+/g;

/** Token alphabet is letters + digits only, so no markdown rule can touch it. */
const TOKEN_PREFIX = "stashpaddeeplinkz";
const TOKEN_RX = /stashpaddeeplinkz(\d+)q/g;

export interface ProtectedDeepLinks {
  /** The markdown to hand to MarkdownRenderer. */
  md: string;
  /** Original URL per token index. Empty when nothing was swapped. */
  links: string[];
}

/** Swap bare deep links for tokens. Leaves alone anything that is not bare
 *  prose: fenced code blocks, inline code spans, markdown link destinations
 *  `](…)`, angle autolinks `<…>`, and HTML attribute values (`="…"`). Those
 *  either render correctly already or need the raw URL to stay a real href.
 *  Indented (4-space) code blocks aren't detected; a token that lands in one
 *  is restored as plain text, so the visible result is unchanged. */
export function protectDeepLinks(md: string): ProtectedDeepLinks {
  const links: string[] = [];
  if (!md.includes("obsidian://")) return { md, links };
  const lines = md.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    if (!line.includes("obsidian://")) continue;
    lines[i] = protectLine(line, links);
  }
  return { md: lines.join("\n"), links };
}

/** Protect one non-fenced line, skipping inline code spans (a run of N
 *  backticks closed by the next run of exactly N). */
function protectLine(line: string, links: string[]): string {
  let out = "";
  let pos = 0;
  while (pos < line.length) {
    const tick = line.indexOf("`", pos);
    if (tick < 0) { out += protectProse(line.slice(pos), links); break; }
    out += protectProse(line.slice(pos, tick), links);
    let run = tick;
    while (line[run] === "`") run++;
    const ticks = line.slice(tick, run);
    const close = findClosingTicks(line, run, ticks.length);
    if (close < 0) { out += ticks; pos = run; continue; }
    out += line.slice(tick, close + ticks.length);
    pos = close + ticks.length;
  }
  return out;
}

function findClosingTicks(line: string, from: number, n: number): number {
  let i = line.indexOf("`", from);
  while (i >= 0) {
    let j = i;
    while (line[j] === "`") j++;
    if (j - i === n) return i;
    i = line.indexOf("`", j);
  }
  return -1;
}

function protectProse(text: string, links: string[]): string {
  if (!text.includes("obsidian://")) return text;
  return text.replace(URL_RX, (url: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - 2), offset);
    const prev = before.slice(-1);
    if (before === "](" || prev === "<" || prev === "\"" || prev === "'") return url;
    // `**url**` / `_url_` / `==url==`: the closing markers are matched by the
    // URL pattern, so give back as many trailing marker chars as there are
    // opening ones right before the URL. A link that merely ENDS in `_` (no
    // opener in front) keeps it.
    const lead = /[*_~=]*$/.exec(text.slice(0, offset))![0].length;
    const trail = /[*_~=]*$/.exec(url)![0].length;
    const give = Math.min(lead, trail, url.length - "obsidian://".length);
    const core = give ? url.slice(0, url.length - give) : url;
    // A user who worked around the bug by hand-escaping (`my\_inbox`) gets the
    // escapes dropped, as markdown would have — the href must not keep them.
    links.push(core.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
    return `${TOKEN_PREFIX}${links.length - 1}q${url.slice(core.length)}`;
  });
}

/** Swap tokens in a rendered tree back to their URLs. Outside a link/code/pre
 *  each becomes an `a.external-link` (same shape the autolinker makes, so the
 *  view's click delegation opens it); inside one it goes back as plain text.
 *  Any token that landed in an attribute is restored too, as a safety net. */
export function restoreDeepLinks(root: HTMLElement, links: string[]): void {
  if (!links.length) return;
  const doc = root.ownerDocument ?? activeDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    if (cur.textContent && cur.textContent.includes(TOKEN_PREFIX)) targets.push(cur as Text);
  }
  for (const textNode of targets) {
    const text = textNode.textContent ?? "";
    let linkable = true;
    for (let p = textNode.parentElement; p && p !== root; p = p.parentElement) {
      if (p.tagName === "A" || p.tagName === "CODE" || p.tagName === "PRE") { linkable = false; break; }
    }
    const frag = doc.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    TOKEN_RX.lastIndex = 0;
    while ((m = TOKEN_RX.exec(text))) {
      const url = links[Number(m[1])];
      if (url === undefined) continue;
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      if (linkable) {
        const a = doc.createElement("a");
        a.className = "external-link";
        a.setAttribute("href", url);
        a.setAttribute("rel", "noopener");
        a.textContent = url;
        frag.appendChild(a);
      } else {
        frag.appendChild(doc.createTextNode(url));
      }
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  if (!root.innerHTML.includes(TOKEN_PREFIX)) return;
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes(TOKEN_PREFIX)) el.setAttribute(attr.name, restoreDeepLinkText(attr.value, links));
    }
  });
}

/** Token → URL in a plain string (attribute values, tests). */
export function restoreDeepLinkText(s: string, links: string[]): string {
  return s.replace(TOKEN_RX, (tok: string, n: string) => links[Number(n)] ?? tok);
}
