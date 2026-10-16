/* Pure tests for src/draft-match.ts (draft-vs-note duplicate matching) */
import { normalizeForMatch, isLeftoverOf, prepareDraft, prepareNote, compareDraftToNote, STRONG_MATCH_KINDS, wordDiff } from "../../src/draft-match";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// --- normalizeForMatch
__eq(normalizeForMatch("Can’t “stop”"), `can't "stop"`, "curly quotes straightened, lowercased");
__eq(normalizeForMatch("- [ ] Buy milk"), "buy milk", "bullet + checkbox stripped");
__eq(normalizeForMatch("[x] Buy milk"), "buy milk", "bare done checkbox stripped");
__eq(normalizeForMatch("> - [ ] quoted task"), "quoted task", "stacked markers stripped");
__eq(normalizeForMatch("## Heading here"), "heading here", "heading marker stripped");
__eq(normalizeForMatch("1. first"), "first", "ordered marker stripped");
__eq(normalizeForMatch("~~struck~~ and ==marked== **bold**"), "struck and marked bold", "inline marks stripped");
__eq(normalizeForMatch("made #bugs"), "made", "trailing tag stripped");
__eq(normalizeForMatch("#idea a thing"), "a thing", "leading tag stripped");
__eq(normalizeForMatch("C# is fine"), "c# is fine", "a # inside a word is not a tag");
__eq(normalizeForMatch("line one\n\n  line   two "), "line one line two", "lines + whitespace collapsed");
__eq(normalizeForMatch("see [[Some Note]]"), "see some note", "wikilink brackets dropped");
__eq(normalizeForMatch(undefined), "", "undefined is empty");

// --- isLeftoverOf: the user's real misses (phone drafts vs the notes they became)
__assert(isLeftoverOf("Slide and reveal: small shapes can’t be made ", "Slide and reveal: small shapes can't be made #bugs"), "D1: curly apostrophe + appended tag");
__assert(isLeftoverOf("Should’ve bought bumble stock, not the app ", "Should've bought bumble stock, not the app"), "D2: curly apostrophe");
__assert(isLeftoverOf("The words pin to on the folder panel. Don’t make sense because it’s not", "The words pin to on the folder panel. Don't make sense because it's not gonna pin to the top."), "D3: two curly apostrophes, prefix");
__assert(isLeftoverOf("Buy milk", "- [ ] Buy milk"), "checkbox added on the note");
__assert(isLeftoverOf("- [ ] Buy milk", "Buy milk"), "checkbox only on the draft");
__assert(isLeftoverOf("~~Buy milk~~", "Buy milk and eggs"), "strikethrough draft");
__assert(!isLeftoverOf("Buy milk and eggs", "Buy milk"), "a draft that goes beyond the note is new writing");
__assert(!isLeftoverOf("Buy bread", "Buy milk"), "different text");
__assert(!isLeftoverOf("#todo", "#todo"), "tag-only draft never matches (normalizes to empty)");
__assert(isLeftoverOf("buy milk", "buy milk and eggs", true), "pre-normalized sent text");
// 0.573.3 (blind review): all-digit #123 is not a tag; whole-word prefixes.
__eq(normalizeForMatch("Fix bug #12"), "fix bug #12", "an issue number is kept");
__assert(!isLeftoverOf("Fix bug #12", "Fix bug #13"), "different issue numbers differ");
__eq(normalizeForMatch("note #2026-plan"), "note", "a tag with digits AND letters is still a tag");
__assert(!isLeftoverOf("Email Sam", "Email Samantha about invoices"), "partial word is not a leftover");
__assert(isLeftoverOf("Email Sam", "Email Samantha about invoices", false, false), "letter-level for a just-sent text");
__assert(isLeftoverOf("Email Sam,", "Email Sam, then call"), "ends on punctuation: boundary ok");

// --- compareDraftToNote
const kind = (draft: string, note: string, modified = 0, created: number | null = null) =>
  compareDraftToNote(prepareDraft(draft, modified), prepareNote(note, created))?.kind ?? null;

__eq(kind("Buy milk", "buy milk"), "exact", "exact after normalizing");
__eq(kind("Buy milk", "Buy milk and eggs"), "prefix", "prefix");
__eq(kind("milk and eggs today", "Remember: buy milk and eggs today please"), "contains", "contained");
__eq(kind("milk", "buy milk"), null, "one-word draft isn't 'contained'");
__eq(kind("meeting with Sam", "Notes: Meeting with Samantha on Friday"), null, "contained only as part of a word: no match");
__eq(kind("meeting with Sam", "Notes: meeting with Sam on Friday"), "contains", "contained as whole words");
// D4: dictation edited the opening words, then kept going.
__eq(kind("Duplicates could be upgraded for the draft by using contains in",
  "Duplicate surge could be upgraded for the drafts by using contains in or more similarity percentage matching"),
  "similar", "D4: edited opening, same words (stemmed)");
// Same pair with the real timestamps: note created 4.5 s after the draft's last edit.
__eq(kind("Duplicates could be upgraded for the draft by using contains in",
  "Duplicate surge could be upgraded for the drafts by using contains in or more similarity percentage matching",
  1_000_000, 1_004_487), "timing", "D4 with timing: strong");
__assert(STRONG_MATCH_KINDS.has("timing") && !STRONG_MATCH_KINDS.has("similar"), "timing is strong, similar isn't");
// Timing alone is not enough: the words must overlap too.
__eq(kind("completely unrelated grocery reminder text", "Meeting notes about the quarterly roadmap", 1_000_000, 1_002_000), null, "timing without overlap is no match");
// A note created long after doesn't get the timing boost.
__eq(kind("alpha beta gamma delta epsilon zeta", "alpha beta gamma other words here", 1_000_000, 9_000_000), null, "50% overlap, no timing: no match");
__eq(kind("alpha beta gamma delta epsilon zeta", "alpha beta gamma other words here", 1_000_000, 1_003_000), "timing", "50% overlap + timing: likely sent");
// Draft continues a sent note.
__eq(kind("Ship the release notes today and then the blog post", "Ship the release notes today"), "extends", "draft extends note");
// Window: the draft's words far down a long note don't count.
const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");
__eq(kind("purple elephant dancing slowly", `${filler} purple elephant dancing slowly`), "contains", "contained text still found anywhere");
__eq(kind("purple elephant dancing quickly", `${filler} purple elephant dancing slowly`), null, "fuzzy overlap only counts early in the note");

// --- wordDiff (review list)
__eq(wordDiff("Duplicates could be upgraded", "Duplicate surge could be upgraded"),
  [{ type: "same", text: "Duplicate" }, { type: "add", text: "surge" }, { type: "same", text: "could be upgraded" }],
  "stemmed words compare equal; note-only word is 'add'");
__eq(wordDiff("can’t be made", "can't be made #bugs"),
  [{ type: "same", text: "can't be made" }, { type: "add", text: "#bugs" }], "curly vs straight quote is the same word");
__eq(wordDiff("old words here", "here"), [{ type: "del", text: "old words" }, { type: "same", text: "here" }], "draft-only words are 'del'");
__eq(wordDiff("a b", "c d", 3), null, "over the cell cap: null");
