/* Pure tests for src/suggest-match.ts (autocomplete-everywhere, 0.494.0) */
import { siftRank, tokenAt, otherTokens, replaceToken } from "../../src/suggest-match";

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
