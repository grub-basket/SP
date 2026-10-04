/* Pure tests for src/suggest-match.ts (autocomplete-everywhere, 0.494.0) */
import { siftRank, tokenAt, otherTokens, replaceToken, keepMatchInClamp } from "../../src/suggest-match";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const id = (s: string): string => s;

// Sift filter: all tokens, any order, case-insensitive.
__eq(siftRank("proj notes", ["Notes/Projects", "Projects", "Inbox"], id), ["Notes/Projects"], "sift any-order");
__eq(siftRank("", ["b", "a"], id), ["b", "a"], "empty query keeps source order");

// Rank: exact > prefix > word/segment start > other; ties keep source order.
__eq(
  siftRank("work", ["Archive/homework", "Team/Work", "workshop", "work", "Big work"], id),
  ["work", "workshop", "Team/Work", "Big work", "Archive/homework"],
  "rank bands",
);
// A frequency-sorted source stays frequency-sorted inside a band.
__eq(siftRank("ta", ["tax", "task", "tag"], id), ["tax", "task", "tag"], "stable within band");
// Regex metacharacters in the query are literal.
__eq(siftRank("c++", ["c++ notes", "cpp"], id), ["c++ notes"], "metachar query");

// tokenAt — comma list.
__eq(tokenAt("a, bc, d", 5, /,/), { start: 3, end: 5, token: "bc" }, "token in middle");
__eq(tokenAt("a, bc, d", 8, /,/), { start: 7, end: 8, token: "d" }, "last token");
__eq(tokenAt("a, ", 3, /,/), { start: 3, end: 3, token: "" }, "empty token after comma+space");
__eq(tokenAt("", 0, /,/), { start: 0, end: 0, token: "" }, "empty field");
// whitespace-or-comma list
__eq(tokenAt(".edtz .vh", 9, /[\s,]/), { start: 6, end: 9, token: ".vh" }, "space-separated token");

// replaceToken keeps the rest of the list intact.
__eq(replaceToken("a, bc, d", tokenAt("a, bc, d", 5, /,/), "Team/Q3"), { value: "a, Team/Q3, d", caret: 10 }, "replace middle");
__eq(replaceToken("a, b", tokenAt("a, b", 4, /,/), "beta"), { value: "a, beta", caret: 7 }, "replace last");
__eq(replaceToken("a,b", tokenAt("a,b", 3, /,/), "beta"), { value: "a, beta", caret: 7 }, "pads after bare comma");
__eq(replaceToken("x", tokenAt("x", 1, /,/), "xyz"), { value: "xyz", caret: 3 }, "single value");
__eq(replaceToken("", tokenAt("", 0, /,/), "one"), { value: "one", caret: 3 }, "empty field");

// otherTokens excludes the token being edited, by position.
const v = "Alpha, Beta, al";
const t = tokenAt(v, v.length, /,/);
__eq([...otherTokens(v, t, /,/)].sort(), ["alpha", "beta"], "other tokens");
__assert(!otherTokens(v, t, /,/).has("al"), "edited token not in others");

// keepMatchInClamp (0.526.3) — the search snippet keeps its match inside the
// 5-line clamp. A short window comes back as the same array (identical output).
const shortWin = ["one", "two zebra", "three"];
__assert(keepMatchInClamp(shortWin, 1, ["zebra"], 80) === shortWin, "short window untouched");
// ~133-char lines, match at the END of the 3rd line: the farthest context line goes.
const para = (n: number): string => `Paragraph ${n} ` + "lorem ipsum dolor ".repeat(7);
const p9 = para(9) + "ends in zebra";
const longWin = [para(7), para(8), p9, para(10), para(11)];
__assert(longWin.every((l, i) => i === 2 || l.length >= 130), "fixture lines are long");
__eq(keepMatchInClamp(longWin, 2, ["zebra"], 80), [para(8), p9, para(10), para(11)], "drops farthest context first");
// The match line alone overflows: its head is cut to "…" at the match.
__eq(keepMatchInClamp(["ctx", "x".repeat(450) + " zebra tail"], 1, ["zebra"], 80), ["ctx", "…zebra tail"], "cuts head of a very long match line");
// Lowercasing changed the length ("İ" → 2 units): no head cut (offsets would be
// off). The match can't fit either way, so the context is kept, not dropped.
const dotted = "İ".repeat(60) + " " + "x".repeat(400) + " zebra";
__eq(keepMatchInClamp(["ctx", dotted], 1, ["zebra"], 80), ["ctx", dotted], "no head cut when lowercase length differs");
// Multi-word query: an early common word must not mask a far one. "paragraph"
// sits at the line start, "zebra" at its end; the farthest context still goes.
__eq(keepMatchInClamp(longWin, 2, ["paragraph", "zebra"], 80), [para(8), p9, para(10), para(11)], "far token keeps its line in view");
// The far word can't fit even with no context: aim for the first highlight
// instead, which already fits, so nothing is dropped.
const farLine = "zebra " + "x".repeat(450) + " quagga";
__eq(keepMatchInClamp(["ctx", farLine], 1, ["zebra", "quagga"], 80), ["ctx", farLine], "unreachable far token -> keep context");
// A cut that already sits at a word start stays there (no extra word dropped).
const wordAt = "y".repeat(359) + " " + "abcd ".repeat(8) + "zebra";
__eq(keepMatchInClamp([wordAt], 0, ["zebra"], 80), ["…" + wordAt.slice(360)], "cut at a word start stays put");
// The cut never starts on the second half of an emoji.
const emo = "x".repeat(400) + "😀".repeat(30) + "-zebra";
const emoOut = keepMatchInClamp([emo], 0, ["zebra"], 80)[0];
__assert(emoOut.endsWith("zebra") && (emoOut.charCodeAt(1) & 0xfc00) !== 0xdc00, "no lone surrogate after the cut");
// No token in the line, or no tokens at all: same array.
__assert(keepMatchInClamp(longWin, 2, ["quagga"], 80) === longWin, "token not on line -> untouched");
__assert(keepMatchInClamp(longWin, 2, [], 80) === longWin, "no tokens -> untouched");
// Long context, but the match is at the START of the match line: still fits.
const startWin = [para(7), para(8), "zebra " + para(9), para(10), para(11)];
__assert(keepMatchInClamp(startWin, 2, ["zebra"], 80) === startWin, "match at line start -> untouched");
