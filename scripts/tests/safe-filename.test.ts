/* Pure tests for src/safe-filename.ts (Windows-safe title-derived names) */
import { safeFileName } from "../../src/safe-filename";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// Quotes are dropped, not dashed.
__eq(safeFileName(`Say "hi" to Bob`), "Say hi to Bob", "straight quotes removed");
__eq(safeFileName(`“Curly” title`), "Curly title", "curly quotes removed");
__eq(safeFileName(`Don't panic`), "Don't panic", "apostrophe is legal, kept");

// Illegal characters become dashes; spaced ones keep the words apart.
__eq(safeFileName("Q3: Plan"), "Q3 - Plan", "colon with space");
__eq(safeFileName("a/b\\c"), "a-b-c", "slashes");
__eq(safeFileName("What? Why*"), "What - Why", "trailing illegal trimmed");
__eq(safeFileName("<tag> | pipe"), "tag - pipe", "angle brackets + pipe");
__eq(safeFileName("tab\there\nnext"), "tab here next", "tab/newline become spaces");
__eq(safeFileName("bell\u0007char"), "bell-char", "control char");
__eq(safeFileName("a > | b"), "a - b", "spaced run of illegals is one dash");
__eq(safeFileName("Say “hi”: now"), "Say hi - now", "quote then colon");
__eq(safeFileName("C# notes"), "C# notes", "# kept unless linkSafe");
__eq(safeFileName("C# notes [draft]", { linkSafe: true }), "C - notes - draft", "linkSafe dashes # and []");

// Edges: hidden-file dots, trailing dots/spaces.
__eq(safeFileName("...secret"), "secret", "leading dots");
__eq(safeFileName("The end. "), "The end", "trailing dot and space");

// Reserved device names.
__eq(safeFileName("CON"), "CON_", "CON reserved");
__eq(safeFileName("nul.txt"), "nul_.txt", "reserved with extension");
__eq(safeFileName("Console"), "Console", "prefix of a reserved name is fine");
__eq(safeFileName("com1"), "com1_", "COM1 reserved");

// Length (code points) and fallback.
__eq(safeFileName("😀".repeat(5), { max: 3 }), "😀😀😀", "emoji-safe cut");
__eq(safeFileName("abcde. fgh", { max: 6 }), "abcde", "cut then retrim");
__eq(safeFileName(`"?:"`, { fallback: "Untitled" }), "Untitled", "fallback when empty");
__eq(safeFileName(""), "", "empty default fallback");

// No output ever contains a Windows-illegal character.
for (const t of [`a"b`, "x<y>z", "1|2", "p:q", "?*", "a\u0001b", "\\\\server\\share"]) {
  __assert(!/[\\/:*?"<>|\u0000-\u001f]/.test(safeFileName(t)), `clean: ${JSON.stringify(t)}`);
}
