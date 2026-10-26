import type { ComposerDraft } from "./types";

/** 0.586.0: deletion records ("tombstones") for composer drafts: draft id →
 *  when it was deleted.
 *
 *  Without them a missing draft is ambiguous: "the other device never heard
 *  it was deleted" and "the other device added it" (or "deleted it" vs "never
 *  had it yet") look the same. mergeDraftMaps (drafts.ts, 0.573.0) guessed from
 *  a baseline and got it wrong both ways: a phone deleted a draft, the Mac (not
 *  yet synced) saved its own copy that still had it, and the phone took it back
 *  — and a stale copy could erase a draft made here. Now drafts merge draft by
 *  draft keeping everything (mergeDraftsNewest), and only a tombstone removes
 *  one. A tombstone travels with data.json, so whichever file wins the sync,
 *  the deletion still beats that copy of the draft.
 *
 *  `deletedAt` is never earlier than the deleted copy's `modified`, so a clock
 *  that runs behind can't let the copy we deleted outlive its tombstone. A draft
 *  edited AFTER the deletion (a later `modified`) is newer work and survives. */
export type DraftTombstones = Record<string, number>;

/** How long a deletion is remembered. A device that stays offline longer than
 *  this can still bring a deleted draft back. Every SENT note deletes its draft,
 *  so these pile up fast; the window and the cap keep data.json small (it is
 *  rewritten on every settings save, and mobile saves are already the slow path). */
export const DRAFT_TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** At most this many records (~40 bytes each); the oldest go first. */
export const DRAFT_TOMBSTONE_MAX = 400;

/** Keep only well-formed, unexpired entries, newest DRAFT_TOMBSTONE_MAX. */
export function normalizeTombstones(raw: unknown, now: number): DraftTombstones {
  const out: DraftTombstones = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const live: [string, number][] = [];
  for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof t === "number" && Number.isFinite(t) && now - t < DRAFT_TOMBSTONE_TTL_MS) live.push([id, t]);
  }
  // Ties broken by id, so every device keeps the SAME 400 (one save stamps all
  // the drafts it deletes with one time; insertion order differs per device,
  // and two devices keeping different records would rewrite each other forever).
  if (live.length > DRAFT_TOMBSTONE_MAX) {
    live.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).length = DRAFT_TOMBSTONE_MAX;
  }
  for (const [id, t] of live) out[id] = t;
  return out;
}

/** Union of two tombstone maps (the later time wins), expired entries dropped,
 *  capped like normalizeTombstones. */
export function mergeTombstones(a: unknown, b: unknown, now: number): DraftTombstones {
  const out = normalizeTombstones(a, now);
  for (const [id, t] of Object.entries(normalizeTombstones(b, now))) {
    if (!(id in out) || t > out[id]) out[id] = t;
  }
  return normalizeTombstones(out, now);
}

/** Add a tombstone for every draft that was in `base` (the map as we last
 *  read/wrote it) and is gone from `ours`: deleted on this device since.
 *
 *  A draft that an EXISTING tombstone already covers (removed here because
 *  another device deleted it) keeps that tombstone's time. Re-stamping it with
 *  our "now" would push the deletion later than it really happened, and an
 *  edit made elsewhere between the two times would then be deleted too.
 *
 *  Known limit: times come from each device's clock. If the deleting device's
 *  clock runs ahead, an edit made elsewhere within that margin after the
 *  deletion still loses to it. */
export function recordDraftDeletions(
  base: Record<string, { modified?: number } | undefined> | undefined,
  ours: Record<string, ComposerDraft> | undefined,
  tombs: DraftTombstones,
  now: number,
): DraftTombstones {
  const O = ours ?? {};
  let out = tombs;
  for (const [id, d] of Object.entries(base ?? {})) {
    if (id in O) continue;
    const modified = typeof d?.modified === "number" ? d.modified : 0;
    if (out[id] !== undefined && out[id] >= modified) continue; // already covered: keep its time
    const at = Math.max(now, modified);
    if (out === tombs) out = { ...tombs };
    out[id] = at;
  }
  return out;
}

/** Merge two draft maps draft by draft: a draft on either side is kept, and
 *  where both have it the later `modified` wins (a tie keeps `ours`). Nothing
 *  is ever dropped here. Deletions travel ONLY as tombstones and are applied
 *  afterwards (applyTombstones).
 *
 *  This replaces "take the other device's whole map when we didn't touch ours"
 *  (and mergeDraftMaps' baseline compare) for synced drafts. That rule also
 *  read an absence as a deletion, so a stale copy from another device erased
 *  drafts created or edited here since. Ours first, so key order is stable.
 *  Returns `ours` itself when nothing was taken from `theirs` (callers skip a
 *  re-serialize on the common no-change save). */
export function mergeDraftsNewest(
  ours: Record<string, ComposerDraft> | undefined,
  theirs: Record<string, ComposerDraft> | undefined,
): Record<string, ComposerDraft> {
  const out: Record<string, ComposerDraft> = { ...(ours ?? {}) };
  let took = false;
  for (const [id, d] of Object.entries(theirs ?? {})) {
    const o = out[id];
    if (!o || (d?.modified ?? 0) > (o.modified ?? 0)) { out[id] = d; took = true; }
  }
  return took || !ours ? out : ours;
}

/** id → modified of a draft map: all recordDraftDeletions needs from the
 *  baseline, kept so a save doesn't have to JSON.parse the whole map (edit
 *  drafts carry a full note) just to find deletions. */
export function draftTimes(drafts: Record<string, ComposerDraft> | undefined): Record<string, { modified: number }> {
  const out: Record<string, { modified: number }> = {};
  for (const [id, d] of Object.entries(drafts ?? {})) out[id] = { modified: typeof d?.modified === "number" ? d.modified : 0 };
  return out;
}

/** True when the file on disk lags behind what we hold, so it must be
 *  rewritten even though nothing changed here (or a reload, e.g. an app the
 *  phone closed, reads the stale state back):
 *  - it is missing one of our unexpired deletion records, or holds an older one;
 *  - it still carries a draft one of our records covers;
 *  - it lacks one of our drafts, or holds an older copy of it.
 *
 *  Each check only fires while we hold something the file doesn't, so after one
 *  write both sides agree and nobody rewrites again. Disk records are
 *  normalized with OUR clock, so a record that expired here but not on the
 *  other device doesn't make both sides rewrite back and forth. */
export function diskNeedsDraftRewrite(
  diskTombs: unknown,
  diskDrafts: unknown,
  ourTombs: DraftTombstones,
  ourDrafts: Record<string, ComposerDraft> | undefined,
  now: number,
): boolean {
  const T = normalizeTombstones(diskTombs, now);
  for (const [id, t] of Object.entries(ourTombs)) if (!(id in T) || T[id] < t) return true;
  const D = diskDrafts && typeof diskDrafts === "object" && !Array.isArray(diskDrafts)
    ? (diskDrafts as Record<string, ComposerDraft>) : {};
  if (applyTombstones(D, ourTombs) !== D) return true;
  for (const [id, d] of Object.entries(ourDrafts ?? {})) {
    const x = D[id];
    if (!x || (x.modified ?? 0) < (d?.modified ?? 0)) return true;
  }
  return false;
}

/** Drop the drafts a tombstone covers (deleted at or after their last edit).
 *  Returns the SAME object when nothing is dropped. */
export function applyTombstones(
  drafts: Record<string, ComposerDraft> | undefined,
  tombs: DraftTombstones,
): Record<string, ComposerDraft> {
  const D = drafts ?? {};
  let out: Record<string, ComposerDraft> | null = null;
  for (const [id, d] of Object.entries(D)) {
    const t = tombs[id];
    if (t === undefined || t < (d?.modified ?? 0)) continue;
    if (!out) out = { ...D };
    delete out[id];
  }
  return out ?? D;
}
