/** 0.603.0: pure text helpers for notifications (no DOM, unit-tested).
 *
 *  A toast has to stay small, above all on a phone, but some messages are long:
 *  lists of file paths, multi-part summaries. `shortenForToast` cuts the toast
 *  down and the service adds a "View full" button; `formatGroupedPaths` keeps a
 *  list of paths short in the first place by naming each shared parent once. */

export interface ToastLimits {
  maxChars: number;
  maxLines: number;
}

export const MOBILE_TOAST_LIMITS: ToastLimits = { maxChars: 200, maxLines: 5 };
export const DESKTOP_TOAST_LIMITS: ToastLimits = { maxChars: 500, maxLines: 10 };

/** Cut `message` to fit `limits`. Prefers whole lines, then a word break. A bold
 *  or code span the cut lands inside is closed around what's left of it, so the
 *  cut text never shows a stray marker. */
export function shortenForToast(message: string, limits: ToastLimits): { text: string; shortened: boolean } {
  // Blank lines at either end carry nothing, so they neither count nor survive.
  const body = message.trim();
  const lines = body.split("\n");
  if (lines.length <= limits.maxLines && body.length <= limits.maxChars) {
    return { text: body, shortened: false };
  }
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= limits.maxLines) break;
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > limits.maxChars) break;
    kept.push(line);
    used += cost;
  }
  let cut: number;
  if (kept.length) {
    cut = kept.join("\n").length;
  } else {
    // The first line alone is over the limit: cut it at a word break.
    let hard = limits.maxChars;
    const code = lines[0].charCodeAt(hard - 1);
    if (code >= 0xd800 && code <= 0xdbff) hard -= 1; // never halve an emoji
    const space = lines[0].slice(0, hard).lastIndexOf(" ");
    cut = space > limits.maxChars * 0.6 ? space : hard;
  }
  return { text: `${cutKeepingMarkup(body, cut).replace(/\s+$/, "")}…`, shortened: true };
}

/** `text` up to `cut`. A cut inside a bold or code span keeps the span's start,
 *  re-closed; a cut with none of the span's content left drops the span. Uses the
 *  same token pattern as renderInlineMarkup, so a lone `*` or backtick that was
 *  never a marker stays as it was. */
function cutKeepingMarkup(text: string, cut: number): string {
  for (const m of text.matchAll(/`[^`\n]+`|\*\*[^*\n]+\*\*/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (start >= cut) break;
    if (cut >= end) continue;
    const marker = m[0].startsWith("`") ? "`" : "**";
    const inner = text.slice(start + marker.length, Math.min(cut, end - marker.length)).replace(/\s+$/, "");
    return inner ? `${text.slice(0, start)}${marker}${inner}${marker}` : text.slice(0, start);
  }
  return text.slice(0, cut);
}

export interface PathGroup {
  parent: string;
  names: string[];
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Group vault paths by their parent folder, in first-seen order. */
export function groupPathsByParent(paths: readonly string[]): PathGroup[] {
  const groups = new Map<string, PathGroup>();
  for (const p of paths) {
    const parent = parentOf(p);
    let g = groups.get(parent);
    if (!g) { g = { parent, names: [] }; groups.set(parent, g); }
    g.names.push(p.slice(parent ? parent.length + 1 : 0));
  }
  return [...groups.values()];
}

/** The folder path every one of `parents` sits in, or "" when there is none. */
function commonFolder(parents: readonly string[]): string {
  if (!parents.length) return "";
  let common = parents[0].split("/");
  for (const p of parents.slice(1)) {
    const segs = p.split("/");
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/** A list of paths as message lines: each parent once, then the file names
 *  under it. When several parents share a higher folder, that folder is named
 *  once on top and the parents are shown relative to it. Files with no heading
 *  of their own come first, so they can't read as part of another folder. */
export function formatGroupedPaths(paths: readonly string[]): string {
  const groups = groupPathsByParent(paths);
  const lines: string[] = [];
  const common = groups.length > 1 ? commonFolder(groups.map((g) => g.parent)) : "";
  if (common) lines.push(`In \`${common}/\``);
  const shownOf = (g: PathGroup): string => (common ? g.parent.slice(common.length + 1) : g.parent);
  for (const g of [...groups.filter((x) => !shownOf(x)), ...groups.filter((x) => shownOf(x))]) {
    const shown = shownOf(g);
    if (shown) lines.push(`\`${shown}/\``);
    for (const n of g.names) lines.push(`• ${n}`);
  }
  return lines.join("\n");
}
