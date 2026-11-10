/* Pure tests for src/notification-text.ts */
import { shortenForToast, groupPathsByParent, formatGroupedPaths } from "../../src/notification-text";

declare const __assert: (c: boolean, m: string) => void;

const L = { maxChars: 40, maxLines: 3 };

const same = shortenForToast("short message", L);
__assert(!same.shortened && same.text === "short message", "short message is untouched");

const exact = "a".repeat(40);
__assert(!shortenForToast(exact, L).shortened, "exactly at the char limit is untouched");

const many = shortenForToast("one\ntwo\nthree\nfour\nfive", L);
__assert(many.shortened, "too many lines is shortened");
__assert(many.text === "one\ntwo\nthree…", "keeps whole lines up to the limit");

const longLine = shortenForToast("alpha beta gamma delta epsilon zeta eta theta iota", L);
__assert(longLine.shortened && longLine.text.endsWith("…"), "long single line is cut");
__assert(!longLine.text.includes("iota"), "cut drops the tail");
__assert(/\S…$/.test(longLine.text), "no space before the ellipsis");

const code = shortenForToast("`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`", L);
__assert((code.text.match(/`/g) ?? []).length === 2, "an open code marker is closed");

const bold = shortenForToast("**aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa**", L);
__assert((bold.text.match(/\*\*/g) ?? []).length === 2, "an open bold marker is closed");

const firstOver = shortenForToast(`${"x".repeat(60)}\nsecond`, L);
__assert(firstOver.text.length <= 41 && !firstOver.text.includes("second"), "an overlong first line doesn't pull in the next");

// Cuts that land inside or next to a marker (limit 40).
__assert(shortenForToast(`${"a".repeat(38)} **${"b".repeat(30)}**`, L).text === `${"a".repeat(38)}…`, "a cut right after an opening marker drops the span");
__assert(shortenForToast(`**${"a".repeat(37)}** more words here`, L).text === `**${"a".repeat(37)}**…`, "a cut through a closing marker keeps the span closed");
__assert(shortenForToast("`**x` word word word word word word word word word", L).text.startsWith("`**x` word"), "stars inside code aren't counted");
__assert(!shortenForToast("`**x` word word word word word word word word word", L).text.includes("**…"), "no stray bold marker after code");
__assert(shortenForToast("a * b ` c word word word word word word word word word", L).text.startsWith("a * b ` c"), "a lone star or tick is left as it was");
__assert(shortenForToast(`\n${"word ".repeat(20)}`, L).text.startsWith("word"), "a leading blank line doesn't empty the toast");
__assert(!shortenForToast("a\nb\nc\n", L).shortened, "a trailing newline doesn't count as a line");
const emoji = shortenForToast(`${"x".repeat(39)}😀 and the rest`, L).text;
__assert(!/[\ud800-\udbff]…$/.test(emoji), "a hard cut never halves an emoji");

__assert(
  formatGroupedPaths(["A/x.png", "root.png"]) === "• root.png\n`A/`\n• x.png",
  "a file with no heading never lands under another folder's heading",
);
__assert(
  formatGroupedPaths(["Work/A/y.png", "Work/x.png"]) === "In `Work/`\n• x.png\n`A/`\n• y.png",
  "same for a file directly in the shared folder",
);

const g = groupPathsByParent(["A/_attachments/x.png", "A/_attachments/y.png", "B/z.png", "root.png"]);
__assert(g.length === 3, "three parents");
__assert(g[0].parent === "A/_attachments" && g[0].names.join() === "x.png,y.png", "names grouped under the parent");
__assert(g[2].parent === "" && g[2].names[0] === "root.png", "vault-root file has an empty parent");

__assert(
  formatGroupedPaths(["A/_attachments/x.png", "A/_attachments/y.png"]) === "`A/_attachments/`\n• x.png\n• y.png",
  "one parent named once",
);
__assert(
  formatGroupedPaths(["Work/A/_attachments/x.png", "Work/B/_attachments/y.png"])
    === "In `Work/`\n`A/_attachments/`\n• x.png\n`B/_attachments/`\n• y.png",
  "shared higher folder named once on top",
);
__assert(
  formatGroupedPaths(["A/x.png", "B/y.png"]) === "`A/`\n• x.png\n`B/`\n• y.png",
  "no shared folder means no top line",
);
__assert(
  !formatGroupedPaths(["Work/x.png", "Work/A/y.png"]).includes("`/`"),
  "a parent equal to the common folder prints no empty heading",
);
__assert(formatGroupedPaths(["root.png"]) === "• root.png", "vault-root file has no heading");
__assert(formatGroupedPaths([]) === "", "no paths, no text");
