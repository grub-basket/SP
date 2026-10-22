/* Pure tests for the date-time file-name prefix helpers in src/slug-service.ts */
import {
  buildFilename, buildAttachmentName, formatDatePrefix, datePrefixFor, splitDatePrefix,
  noteNameMatches, reslugName, titleFromBasename, attachmentStampMs, createdMsOf,
  parseIdFromFilename, parseLegacyAttachmentPrefix, prefixFitsCreated,
} from "../../src/slug-service";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const ms = new Date(2026, 9, 22, 14, 30, 59).getTime(); // local 2026-10-22 14:30

// Formatting: fixed Y-M-D order, chosen separator, HHmm time.
__eq(formatDatePrefix(ms, "-"), "2026-10-22-1430", "dash");
__eq(formatDatePrefix(ms, "."), "2026.10.22-1430", "dot");
__eq(formatDatePrefix(ms, "_"), "2026_10_22-1430", "underscore");
__eq(formatDatePrefix(ms, ""), "20261022-1430", "none");
__eq(formatDatePrefix(new Date(2026, 0, 5, 3, 7).getTime(), "-"), "2026-01-05-0307", "zero padded");
__eq(datePrefixFor({ fileDatePrefix: false, fileDatePrefixSep: "-" }, ms), "", "off → empty");
__eq(datePrefixFor({ fileDatePrefix: true, fileDatePrefixSep: "." }, ms), "2026.10.22-1430", "on");
__eq(datePrefixFor({ fileDatePrefix: true, fileDatePrefixSep: "?" as never }, ms), "2026-10-22-1430", "bad sep → dash");

// Building names.
__eq(buildFilename("Grocery-List", "k7m3pq"), "Grocery-List-k7m3pq.md", "no prefix unchanged");
__eq(buildFilename("Grocery-List", "k7m3pq", "2026-10-22-1430"), "2026-10-22-1430-Grocery-List-k7m3pq.md", "prefixed");
__eq(buildAttachmentName("photo.png", "lqf3k2a9"), "photo-lqf3k2a9.png", "attachment unchanged");
__eq(buildAttachmentName("photo.png", "lqf3k2a9", "2026-10-22-1430"), "2026-10-22-1430-photo-lqf3k2a9.png", "attachment prefixed");

// The id still parses from a prefixed name.
__eq(parseIdFromFilename("2026-10-22-1430-Grocery-List-k7m3pq"), "k7m3pq", "id survives prefix");
__eq(parseIdFromFilename("20261022-1430-Grocery-List-k7m3pq"), "k7m3pq", "id survives no-sep prefix");

// Splitting.
for (const sep of ["-", ".", "_", ""] as const) {
  const p = formatDatePrefix(ms, sep);
  const sp = splitDatePrefix(`${p}-Grocery-List-k7m3pq`);
  __eq(sp && { prefix: sp.prefix, rest: sp.rest }, { prefix: p, rest: "Grocery-List-k7m3pq" }, `split sep "${sep}"`);
  __eq(sp && sp.ms, new Date(2026, 9, 22, 14, 30).getTime(), `split ms sep "${sep}"`);
}
__eq(splitDatePrefix("Grocery-List-k7m3pq"), null, "no prefix");
__eq(splitDatePrefix("2026-10.22-1430-x"), null, "mixed separators rejected");
__eq(splitDatePrefix("2026-13-22-1430-x"), null, "month 13 rejected");
__eq(splitDatePrefix("2026-02-31-1430-x"), null, "Feb 31 rejected");
__eq(splitDatePrefix("2026-10-22-2460-x"), null, "minute 60 rejected");
__eq(splitDatePrefix("2026-10-22-x"), null, "date without time is not a prefix");

// The no-fight rule: prefix or not, a matching tail is up to date.
__assert(noteNameMatches("Grocery-List-k7m3pq.md", "Grocery-List", "k7m3pq"), "plain matches");
__assert(noteNameMatches("2026-10-22-1430-Grocery-List-k7m3pq.md", "Grocery-List", "k7m3pq"), "prefixed matches");
__assert(noteNameMatches("20261022-1430-Grocery-List-k7m3pq.md", "Grocery-List", "k7m3pq"), "no-sep prefixed matches");
__assert(!noteNameMatches("Old-Title-k7m3pq.md", "Grocery-List", "k7m3pq"), "stale title");
__assert(!noteNameMatches("Junk-Grocery-List-k7m3pq.md", "Grocery-List", "k7m3pq"), "non-date head is not a prefix");
// A title that itself starts with a date-time.
__assert(noteNameMatches("2026-03-01-1200-Standup-k7m3pq.md", "2026-03-01-1200-Standup", "k7m3pq"), "date title, no prefix");
__assert(noteNameMatches("2026-10-22-1430-2026-03-01-1200-Standup-k7m3pq.md", "2026-03-01-1200-Standup", "k7m3pq"), "date title with prefix");

// reslugName: carries the note's own prefix over verbatim; never adds or strips.
const created = ms;
const own = "2026-10-22-1430";
__eq(reslugName(`${own}-Grocery-List-k7m3pq.md`, "Grocery-List", "k7m3pq", created), null, "matching → no rename");
__eq(reslugName("2026.10.22-1430-Grocery-List-k7m3pq.md", "Grocery-List", "k7m3pq", created), null, "other separator still matches");
__eq(reslugName("Grocery-List-k7m3pq.md", "Grocery-List", "k7m3pq", created), null, "unprefixed matching → left alone");
__eq(reslugName(`${own}-Old-k7m3pq.md`, "New-Title", "k7m3pq", created), `${own}-New-Title-k7m3pq.md`, "title change keeps prefix");
__eq(reslugName("2026.10.22-1430-Old-k7m3pq.md", "New-Title", "k7m3pq", created), "2026.10.22-1430-New-Title-k7m3pq.md", "keeps its own separator");
__eq(reslugName("Old-k7m3pq.md", "New-Title", "k7m3pq", created), "New-Title-k7m3pq.md", "title change does NOT add a prefix");
__eq(reslugName(`${own}-Old-k7m3pq.md`, "New-Title", "k7m3pq", null), `${own}-New-Title-k7m3pq.md`, "no created → prefix still kept");
// Titles that start with a date-time are not the note's prefix.
__eq(reslugName("2020-03-01-1200-Standup-k7m3pq.md", "Lunch", "k7m3pq", created), "Lunch-k7m3pq.md", "far-off title date not kept");
// Made at 14:30, titled "2026-10-22 1450 standup", then retitled.
__eq(reslugName("2026-10-22-1450-Standup-k7m3pq.md", "2026-10-22-1450-Standup-Notes", "k7m3pq", created), "2026-10-22-1450-Standup-Notes-k7m3pq.md", "near title date not doubled");
__assert(!noteNameMatches("2026-10-22-1450-Standup-k7m3pq.md", "Standup", "k7m3pq", created), "near title date is not a prefix when the title drops it");
// Running the rename twice is stable.
const once = reslugName(`${own}-Old-k7m3pq.md`, "New-Title", "k7m3pq", created)!;
__eq(reslugName(once, "New-Title", "k7m3pq", created), null, "second pass is a no-op");

// Time-zone tolerance: whole hours only.
__assert(prefixFitsCreated(ms, ms + 9 * 3_600_000), "9h off fits");
__assert(prefixFitsCreated(new Date(2026, 9, 22, 14, 30).getTime(), ms), "minute-truncated fits");
__assert(prefixFitsCreated(ms, ms + 5.5 * 3_600_000), "+5:30 zone shift fits");
__assert(!prefixFitsCreated(ms, ms + 10 * 60_000), "10 min off does not");
__assert(!prefixFitsCreated(ms, ms + 30 * 3_600_000), "30h off does not");
__assert(prefixFitsCreated(ms, null), "no created → shape trusted");

// Titles.
__eq(titleFromBasename("2026-10-22-1430-Grocery-List-k7m3pq"), "Grocery List", "title drops prefix");
__eq(titleFromBasename("Grocery-List-k7m3pq"), "Grocery List", "title plain");
__eq(titleFromBasename("2026-10-22-1430-k7m3pq"), "2026 10 22 1430", "date-only title is not emptied");

// Attachment stamps.
const stamp = Date.now().toString(36);
__assert(Math.abs((attachmentStampMs(`photo-${stamp}`) ?? 0) - Date.now()) < 5_000, "stamp decodes");
__eq(attachmentStampMs("photo-1"), null, "uniquifier is not a stamp");
__eq(attachmentStampMs("photo"), null, "no stamp");

// A prefixed attachment is never mistaken for the legacy prefix-stamp form.
for (const sep of ["-", ".", "_", ""] as const) {
  __eq(parseLegacyAttachmentPrefix(`${formatDatePrefix(ms, sep)}-photo-${stamp}.png`), null, `legacy migration ignores sep "${sep}"`);
}

__eq(createdMsOf("2026-10-22T14:30:00.000Z"), Date.parse("2026-10-22T14:30:00.000Z"), "created ISO");
__eq(createdMsOf(""), null, "created empty");
__eq(createdMsOf("2026-03-05"), new Date(2026, 2, 5).getTime(), "date-only created is local midnight");
__eq(formatDatePrefix(createdMsOf("2026-03-05")!, "-"), "2026-03-05-0000", "date-only keeps its day");
__eq(createdMsOf(undefined), null, "created missing");
