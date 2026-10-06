/* Pure tests for src/deep-link-markdown.ts (string half only — the DOM restore
 * is exercised live in Obsidian). */
import { protectDeepLinks, restoreDeepLinkText } from "../../src/deep-link-markdown";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const L = "obsidian://stashpad?folder=_inbox_&note=a_b*c*&run=reveal";

// No links → untouched, no work.
__eq(protectDeepLinks("plain _text_ here"), { md: "plain _text_ here", links: [] }, "no links passthrough");

// A bare link becomes a token with no markdown-significant characters.
{
  const r = protectDeepLinks(`see ${L} done`);
  __eq(r.links, [L], "bare link captured whole");
  __assert(!/[*_&~=]/.test(r.md.replace("see ", "").replace(" done", "")), "token has no markdown chars");
  __eq(restoreDeepLinkText(r.md, r.links), `see ${L} done`, "round-trip restores original");
}

// Two links on a line, plus one on another line.
{
  const r = protectDeepLinks(`${L} and ${L}x\nnext ${L}`);
  __eq(r.links.length, 3, "three links");
  __eq(restoreDeepLinkText(r.md, r.links), `${L} and ${L}x\nnext ${L}`, "multi round-trip");
}

// Contexts that must NOT be touched.
for (const s of [
  `[label](${L})`,
  `<${L}>`,
  `<a href="${L}">x</a>`,
  "`" + L + "`",
  "``a ` " + L + "``",
  "```\n" + L + "\n```",
  "~~~md\n" + L + "\n~~~",
  "  ```\n" + L + "\n  ```",
]) {
  __eq(protectDeepLinks(s).links, [], `untouched: ${s.slice(0, 30)}`);
}

// Text after a fence closes IS protected again.
__eq(protectDeepLinks("```\nx\n```\n" + L).links, [L], "after fence closes");
// An unclosed inline backtick doesn't swallow the rest of the line.
__eq(protectDeepLinks("a ` b " + L).links, [L], "lone backtick");
// A link used as link TEXT is protected (emphasis applies there).
__eq(protectDeepLinks(`[${L}](https://x.y)`).links, [L], "link text protected");

// Wrapped in emphasis/highlight: closing markers stay outside the link.
{
  const base = "obsidian://stashpad?note=abc";
  for (const w of ["**", "_", "*", "==", "~~", "__"]) {
    const r = protectDeepLinks(`${w}${base}${w}`);
    __eq(r.links, [base], `wrapped in ${w}`);
    __assert(r.md.endsWith(w) && r.md.startsWith(w), `markers kept for ${w}`);
  }
  // A link that merely ENDS in `_` keeps it.
  __eq(protectDeepLinks(`${base}_`).links, [`${base}_`], "trailing _ kept when not wrapped");
}

// Table cells: the pipe is not part of the link.
__eq(protectDeepLinks(`| ${L}| b |`).links, [L], "table pipe excluded");

// Hand-escaped workaround links lose their backslashes.
__eq(protectDeepLinks("obsidian://stashpad?folder=my\\_inbox&note=x").links,
  ["obsidian://stashpad?folder=my_inbox&note=x"], "escapes dropped");

// Unknown token index is left as-is on restore.
__eq(restoreDeepLinkText("stashpaddeeplinkz9q", []), "stashpaddeeplinkz9q", "unknown token untouched");
