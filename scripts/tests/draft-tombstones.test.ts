/* Pure tests for src/draft-tombstones.ts (draft deletion records) */
import { mergeDraftMaps } from "../../src/drafts";
import {
  applyTombstones, diskNeedsDraftRewrite, draftTimes, mergeDraftsNewest, mergeTombstones, normalizeTombstones, recordDraftDeletions,
  DRAFT_TOMBSTONE_MAX, DRAFT_TOMBSTONE_TTL_MS,
} from "../../src/draft-tombstones";
import type { ComposerDraft } from "../../src/types";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const dr = (id: string, text: string, modified = 1, device = "phone-a"): ComposerDraft =>
  ({ id, folder: "F", text, created: 1, modified, device, kind: "new" });

const NOW = 1_800_000_000_000;
const X = dr("x", "already sent", NOW - 5000);
const Y = dr("y", "keep me", NOW - 5000, "desktop-b");

// The 2026-10-24 bug, end to end. The phone deletes X. Before that reaches the
// Mac, the Mac saves its own copy, which still has X and no deletion record.
// The phone then reads the Mac's file.
{
  // Phone save: X was in the baseline, is gone now → a record is made.
  const phoneTombs = recordDraftDeletions({ x: X, y: Y }, { y: Y }, {}, NOW);
  __assert(phoneTombs.x >= NOW, "deleting a draft records when");
  __assert(!("y" in phoneTombs), "a draft still present gets no record");

  // Phone's next save, with the Mac's stale file on disk. The baseline is what
  // the phone last wrote ({ y }), ours is unchanged, disk has X again.
  const merged = mergeDraftMaps({ y: Y }, { x: X, y: Y }, { y: Y });
  __eq(Object.keys(merged).sort(), ["x", "y"], "without records the merge takes X back (the bug)");
  const tombs = mergeTombstones(phoneTombs, undefined, NOW + 1000);
  __eq(Object.keys(applyTombstones(merged, tombs)), ["y"], "the record keeps X deleted");

  // The Mac reads the phone's file: its records reach the Mac too.
  const macTombs = mergeTombstones({}, phoneTombs, NOW + 2000);
  __eq(Object.keys(applyTombstones({ x: X, y: Y }, macTombs)), ["y"], "the Mac drops X as well");
}

// A draft edited AFTER it was deleted elsewhere is newer work: it survives.
{
  const tombs = { x: NOW };
  const edited = dr("x", "already sent, plus more", NOW + 10);
  __eq(Object.keys(applyTombstones({ x: edited }, tombs)), ["x"], "a later edit beats an earlier deletion");
  __eq(Object.keys(applyTombstones({ x: dr("x", "t", NOW) }, tombs)), [], "an edit at the same moment does not");
}

// A deleting device with a slow clock still covers the copy it deleted.
{
  const ahead = dr("x", "edited on a fast clock", NOW + 60_000);
  const tombs = recordDraftDeletions({ x: ahead }, {}, {}, NOW);
  __assert(tombs.x >= ahead.modified, "the record is never older than the deleted copy");
  __eq(Object.keys(applyTombstones({ x: ahead }, tombs)), [], "so that copy can't come back");
}

// Review find (0.586.0): a device that merely PASSES ON a deletion (it dropped
// X because another device's record covered it) must keep that record's time.
// Re-stamping it with its own later "now" deleted an edit made in between.
{
  const T0 = NOW, T2 = NOW + 2000, T3 = NOW + 3000;
  // Phone: X in the baseline, gone from memory because the T0 record dropped it.
  const kept = recordDraftDeletions({ x: dr("x", "t", T0 - 10) }, {}, { x: T0 }, T3);
  __eq(kept.x, T0, "an existing covering record keeps its time");
  // So the Mac's later edit (T2 > T0) survives the phone's file.
  __eq(Object.keys(applyTombstones({ x: dr("x", "edited on the Mac", T2) }, kept)), ["x"], "the edit after the deletion survives");
  // But a copy edited AFTER an older record, then deleted here, is re-stamped.
  const again = recordDraftDeletions({ x: dr("x", "edited, deleted again", T2) }, {}, { x: T0 }, T3);
  __eq(again.x, T3, "deleting a newer copy records the new deletion");
}

// No change → the same object back (so callers can skip a write and a repaint).
{
  const map = { y: Y };
  __assert(applyTombstones(map, {}) === map, "applyTombstones returns the same object when nothing is dropped");
  const t = { a: NOW };
  __assert(recordDraftDeletions({ y: Y }, { y: Y }, t, NOW) === t, "recordDraftDeletions returns the same object when nothing was deleted");
  __assert(recordDraftDeletions({ a: dr("a", "z", NOW - 1) }, {}, t, NOW) === t, "an existing, newer-or-equal record is kept as is");
}

// Union: later time wins; expired and malformed entries are dropped.
{
  const m = mergeTombstones({ a: NOW - 10, b: NOW }, { a: NOW, c: NOW - 1 }, NOW);
  __eq(m, { a: NOW, b: NOW, c: NOW - 1 }, "union, later time wins");
  const old = NOW - DRAFT_TOMBSTONE_TTL_MS - 1;
  __eq(mergeTombstones({ a: old }, { b: old }, NOW), {}, "expired records are dropped");
  __eq(normalizeTombstones({ a: "x", b: null, c: NaN, d: NOW }, NOW), { d: NOW }, "malformed entries are dropped");
  __eq(normalizeTombstones([1, 2], NOW), {}, "an array is not a record map");
  __eq(normalizeTombstones(undefined, NOW), {}, "missing → empty");
}

// The cap keeps the newest records.
{
  const many: Record<string, number> = {};
  for (let i = 0; i < DRAFT_TOMBSTONE_MAX + 50; i++) many[`d${i}`] = NOW - 100_000 + i;
  const m = mergeTombstones(many, { extra: NOW }, NOW);
  __eq(Object.keys(m).length, DRAFT_TOMBSTONE_MAX, "capped at DRAFT_TOMBSTONE_MAX");
  __assert("extra" in m && `d${DRAFT_TOMBSTONE_MAX + 49}` in m, "the newest records are kept");
  __assert(!("d0" in m), "the oldest records go first");
}

// diskNeedsDraftRewrite: when the file must be rewritten (live-test find, 0.586.0).
{
  const ours = { x: NOW };
  const yOnly = { y: Y };
  __assert(diskNeedsDraftRewrite({}, yOnly, ours, yOnly, NOW), "file missing our record → rewrite");
  __assert(diskNeedsDraftRewrite({ x: NOW }, { x: X, y: Y }, ours, yOnly, NOW), "file still carrying a covered draft → rewrite");
  __assert(diskNeedsDraftRewrite({ x: NOW - 5 }, yOnly, ours, yOnly, NOW), "file has an OLDER record for it → rewrite");
  __assert(diskNeedsDraftRewrite({ x: NOW }, {}, ours, yOnly, NOW), "file missing one of our drafts → rewrite");
  __assert(diskNeedsDraftRewrite({ x: NOW }, { y: dr("y", "old", NOW - 9000) }, ours, yOnly, NOW), "file holding an older copy of our draft → rewrite");
  __assert(!diskNeedsDraftRewrite({ x: NOW }, yOnly, ours, yOnly, NOW), "file already up to date → no rewrite");
  __assert(!diskNeedsDraftRewrite({ x: NOW, z: NOW }, { y: Y, w: dr("w", "theirs") }, ours, yOnly, NOW), "file holding MORE than us → no rewrite (we adopt it)");
  __assert(!diskNeedsDraftRewrite(undefined, undefined, {}, {}, NOW), "nothing either side → no rewrite");
  // Clock skew at the expiry edge: device A (clock later) has dropped e as
  // expired; device B still holds it. B writes once; A must not write back.
  const e = NOW - DRAFT_TOMBSTONE_TTL_MS + 1000;                 // live on B (NOW), expired on A (NOW + 2000)
  const bTombs = mergeTombstones({ e }, undefined, NOW);
  __assert(diskNeedsDraftRewrite({}, {}, bTombs, {}, NOW), "B: A's file lacks e → B writes once");
  const aTombs = mergeTombstones({}, { e }, NOW + 2000);
  __assert(!diskNeedsDraftRewrite({ e }, {}, aTombs, {}, NOW + 2000), "A: e expired here → A doesn't rewrite (no ping-pong)");
}

// mergeDraftsNewest: second blind-review find (0.586.0). A stale copy from the
// other device must not erase drafts made or edited here since.
{
  const M1 = dr("m", "mac draft", NOW - 100, "desktop-b");
  const M2 = dr("m", "mac draft, edited", NOW, "desktop-b");
  const N = dr("n", "brand new on the Mac", NOW, "desktop-b");
  const stale = { m: M1 };                                   // the phone's copy: no N, old M
  const out = applyTombstones(mergeDraftsNewest({ m: M2, n: N }, stale), {});
  __eq(Object.keys(out).sort(), ["m", "n"], "a draft made here survives a stale copy");
  __eq(out.m.text, "mac draft, edited", "an edit made here beats the older copy");
  __eq(mergeDraftsNewest({ m: M1 }, { m: M2 }).m.text, "mac draft, edited", "their newer edit wins");
  __eq(mergeDraftsNewest({ m: M2 }, { m: { ...M2, text: "same time" } }).m.text, "mac draft, edited", "a tie keeps ours");
  __eq(Object.keys(mergeDraftsNewest({}, { w: Y })), ["w"], "their new draft is adopted");
  // Deletion only through records: merge keeps X, the record removes it.
  __eq(Object.keys(applyTombstones(mergeDraftsNewest({ y: Y }, { x: X, y: Y }), { x: NOW })), ["y"], "a covered draft is removed after merging");
}

// mergeDraftsNewest hands back `ours` itself when nothing changed (the save
// path skips a re-serialize on that), and draftTimes keeps only id → modified.
{
  const ours = { y: Y };
  __assert(mergeDraftsNewest(ours, { y: Y }) === ours, "nothing taken → same object");
  __assert(mergeDraftsNewest(ours, { y: dr("y", "older", 1) }) === ours, "only older copies → same object");
  __assert(mergeDraftsNewest(ours, { w: X }) !== ours, "a new draft taken → new object");
  __eq(draftTimes({ y: Y, z: { ...Y, id: "z", modified: undefined as unknown as number } }), { y: { modified: Y.modified }, z: { modified: 0 } }, "draftTimes: id → modified, missing → 0");
  __eq(recordDraftDeletions(draftTimes({ x: X, y: Y }), { y: Y }, {}, NOW), { x: NOW }, "recordDraftDeletions works from draftTimes");
}

// Fifth-review find: at the cap, ties must break the same way on every device,
// whatever order each one holds its records in — or two devices keep different
// sets and rewrite each other's file forever.
{
  const a: Record<string, number> = {}, b: Record<string, number> = {};
  for (let i = 0; i < DRAFT_TOMBSTONE_MAX + 20; i++) a[`k${i}`] = NOW;           // all one time
  for (let i = DRAFT_TOMBSTONE_MAX + 19; i >= 0; i--) b[`k${i}`] = NOW;          // reverse order
  const ka = Object.keys(normalizeTombstones(a, NOW)).sort();
  const kb = Object.keys(normalizeTombstones(b, NOW)).sort();
  __eq(ka, kb, "the cap keeps the same records regardless of order");
  __assert(!diskNeedsDraftRewrite(normalizeTombstones(b, NOW), {}, normalizeTombstones(a, NOW), {}, NOW), "so neither device sees the other's file as lagging");
}

// No baseline (first save) records nothing.
{
  __eq(recordDraftDeletions(undefined, { y: Y }, {}, NOW), {}, "no baseline, no records");
}
