/* Pure tests for src/attachment-split-core.ts and owningFolder */
import { folderTag, encodeLinkPath, nonLinkRanges, rewriteLinks, humanSize, renamedPathList } from "../../src/attachment-split-core";
import { owningFolder } from "../../src/types";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

__assert(folderTag("Work/A") === folderTag("Work/A"), "a folder's tag is stable");
__assert(folderTag("Work/A") !== folderTag("Work/B"), "different folders get different tags");
__assert(/^[a-z0-9]{4}$/.test(folderTag("x")), "a tag is 4 characters");

__eq(encodeLinkPath("A b/c (1).png"), "A%20b/c%20%281%29.png", "spaces and parentheses are encoded, slashes kept");

const OLD = "A/_attachments/pic one.png";
const NEW = "B/_attachments/pic one-ab12.png";
const R = (lp: string): string | null => (lp === OLD || lp === "pic one.png" ? NEW : null);
const rw = (s: string, raw = false): string => rewriteLinks(s, R, { raw }).text;

__eq(rw(`![[${OLD}]]`), `![[${NEW}]]`, "embed keeps its mark");
__eq(rw(`[[${OLD}]]`), `[[${NEW}]]`, "plain wikilink");
__eq(rw(`![[pic one.png]]`), `![[${NEW}]]`, "a short link becomes a full path");
__eq(rw(`[[${OLD}|the alias]]`), `[[${NEW}|the alias]]`, "alias kept");
__eq(rw(`![[${OLD}#page=2]]`), `![[${NEW}#page=2]]`, "PDF page kept");
__eq(rw(`![[${OLD}#h|500]]`), `![[${NEW}#h|500]]`, "heading and size kept");
__eq(rw(`| ![[${OLD}\\|200]] |`), `| ![[${NEW}\\|200]] |`, "a table's escaped pipe survives");
__eq(rw(`![alt](A/_attachments/pic%20one.png)`), `![alt](B/_attachments/pic%20one-ab12.png)`, "Markdown embed, encoded");
__eq(rw(`[x](<A/_attachments/pic one.png>)`), `[x](<${NEW}>)`, "angle-bracket link stays angle-bracketed");
__eq(rw(`![a](A/_attachments/pic%20one.png#page=3 "t")`), `![a](B/_attachments/pic%20one-ab12.png#page=3 "t")`, "Markdown link keeps page and title");
__eq(rw(`[x](https://e.com/pic%20one.png)`), `[x](https://e.com/pic%20one.png)`, "external URLs are left alone");
__eq(rw(`[[Other note]]`), `[[Other note]]`, "unrelated links are left alone");

const E = "A/_attachments/pic%20one.png";
const EN = "B/_attachments/pic%20one-ab12.png";
__eq(rw(`![a](${E} 'title')`), `![a](${EN} 'title')`, "a single-quoted title");
__eq(rw(`![a](${E} (title))`), `![a](${EN} (title))`, "a parenthesised title");
__eq(rw(`[![t](other.png)](${E})`), `[![t](other.png)](${EN})`, "an image inside a link: the outer target");
__eq(rw(`[![t](${E})](https://e.com)`), `[![t](${EN})](https://e.com)`, "an image inside a link: the inner target");
__eq(rw(`[![t](${E})](${E})`), `[![t](${EN})](${EN})`, "an image inside a link: both");
__eq(rw("[a] and [b](c.png)"), "[a] and [b](c.png)", "brackets near a link are left alone");

// A long line of links inside brackets used to backtrack exponentially.
const many = `[Sources: ${Array.from({ length: 200 }, (_, i) => `[a${i}](u${i})`).join(", ")}]`;
const started = Date.now();
rw(many);
__assert(Date.now() - started < 500, "a long line of bracketed links stays fast");

const code = "```\n![[pic one.png]]\n```\n![[pic one.png]]";
__eq(rw(code), `\`\`\`\n![[pic one.png]]\n\`\`\`\n![[${NEW}]]`, "a link in a code block is left alone");
__eq(rw("`![[pic one.png]]` then ![[pic one.png]]"), `\`![[pic one.png]]\` then ![[${NEW}]]`, "inline code is left alone");
__eq(rw("~~~\n![[pic one.png]]\n"), "~~~\n![[pic one.png]]\n", "an unclosed fence runs to the end");
const fm = '---\ncover: "[[pic one.png]]"\n---\n![[pic one.png]]';
__eq(rw(fm), `---\ncover: "[[pic one.png]]"\n---\n![[${NEW}]]`, "the frontmatter block is left for the YAML writer");
__eq(rw("[[pic one.png]]", true), `[[${NEW}]]`, "raw mode for a single frontmatter value");
__eq(rw("![[pic one.png]] and [[pic one.png|b]]"), `![[${NEW}]] and [[${NEW}|b]]`, "several links on a line");

const counted = rewriteLinks("![[pic one.png]] [[nope]]", R);
__eq(counted.changed, 1, "counts only the links it changed");

__eq(nonLinkRanges("no code here"), [], "no ranges in plain text");
__eq(nonLinkRanges("---\nnot frontmatter"), [], "an unclosed block isn't frontmatter");

__eq(humanSize(512), "512 B", "bytes");
__eq(humanSize(1536), "1.5 KB", "kilobytes");
__eq(humanSize(25 * 1024 * 1024), "25 MB", "megabytes");

__eq(renamedPathList(["A/x.png", "B/y.png"], "A/x.png", "A/z.png"), ["A/z.png", "B/y.png"], "file rename");
__eq(renamedPathList(["A/_attachments/x.png"], "A", "C"), ["C/_attachments/x.png"], "folder rename");
__eq(renamedPathList(["AB/x.png"], "A", "C"), null, "a name that merely starts the same isn't touched");

const folders = new Set(["Work/A", "Work/A/Nested", "Top"]);
__eq(owningFolder("Work/A", folders), "Work/A", "the folder itself");
__eq(owningFolder("Work/A/archive", folders), "Work/A", "a subfolder belongs to its Stashpad");
__eq(owningFolder("Work/A/Nested/sub", folders), "Work/A/Nested", "a nested Stashpad owns its own contents");
__eq(owningFolder("Elsewhere/x", folders), null, "outside every Stashpad");
__eq(owningFolder("", folders), null, "vault root");
