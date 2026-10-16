/* Pure tests for src/drafts.ts (cross-device draft merge) */
import { mergeDraftMaps } from "../../src/drafts";
import type { ComposerDraft } from "../../src/types";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

const dr = (id: string, text: string, modified = 1, device = "phone-a"): ComposerDraft =>
  ({ id, folder: "F", text, created: 1, modified, device, kind: "new" });

const P = dr("p", "phone draft");
const M = dr("m", "mac draft", 1, "desktop-b");

// The resurrection bug: the phone sent (deleted) P while the Mac changed a
// DIFFERENT draft. The Mac's save must not write P back.
{
  const base = { p: P, m: M };
  const disk = { m: M };                                   // phone deleted p
  const ours = { p: P, m: dr("m", "mac draft, edited", 2, "desktop-b") };
  const out = mergeDraftMaps(base, disk, ours);
  __eq(Object.keys(out).sort(), ["m"], "a draft deleted on the other device stays deleted");
  __eq(out.m.text, "mac draft, edited", "our edit to another draft is kept");
}

// A draft the other device created (not in base) is adopted.
{
  const out = mergeDraftMaps({ m: M }, { m: M, p: P }, { m: dr("m", "x", 2, "desktop-b") });
  __eq(Object.keys(out).sort(), ["m", "p"], "new draft from the other device is adopted");
}

// A draft WE deleted (discarded in the Drafts list) stays deleted even though
// disk still has the untouched copy.
{
  const out = mergeDraftMaps({ p: P, m: M }, { p: P, m: M }, { m: dr("m", "x", 2, "desktop-b") });
  __eq(Object.keys(out), ["m"], "our own discard sticks");
}

// Our new draft survives when disk changed something else.
{
  const N = dr("n", "brand new", 3, "desktop-b");
  const out = mergeDraftMaps({ p: P }, { p: dr("p", "phone draft more", 2) }, { p: P, n: N });
  __eq(Object.keys(out).sort(), ["n", "p"], "our new draft is kept");
  __eq(out.p.text, "phone draft more", "their edit to an entry we didn't touch is adopted");
}

// Both edited the same draft: newer modified wins; a tie keeps ours.
{
  const out = mergeDraftMaps({ p: P }, { p: dr("p", "theirs", 5) }, { p: dr("p", "ours", 4) });
  __eq(out.p.text, "theirs", "newer edit wins");
  const tie = mergeDraftMaps({ p: P }, { p: dr("p", "theirs", 5) }, { p: dr("p", "ours", 5) });
  __eq(tie.p.text, "ours", "tie keeps ours");
}

// Edited on one side, deleted on the other: the edit is kept (no data loss).
{
  const a = mergeDraftMaps({ p: P }, {}, { p: dr("p", "kept typing", 2) });
  __eq(a.p?.text, "kept typing", "our edit beats their delete");
  const b = mergeDraftMaps({ p: P }, { p: dr("p", "they kept typing", 2) }, {});
  __eq(b.p?.text, "they kept typing", "their edit beats our delete");
}

// 0.573.3 (blind review): another device re-saved the draft after a reload —
// same content, different key order and no `origin`. That is NOT an edit, so
// our delete (we sent it) must win.
{
  const mine: ComposerDraft = { id: "k", folder: "F", text: "sent text", modified: 5, created: 4, device: "desktop-b", kind: "new", origin: { id: "o1", title: "Parent" }, replyTo: null };
  const reformatted = { replyTo: null, kind: "new", device: "desktop-b", modified: 5, created: 4, text: "sent text", folder: "F", id: "k" } as ComposerDraft;
  const out = mergeDraftMaps({ k: mine }, { k: reformatted }, {});
  __eq(Object.keys(out), [], "a reformatted-but-unchanged copy doesn't resurrect a sent draft");
}

// Undefined inputs are tolerated.
__eq(mergeDraftMaps(undefined, undefined, undefined), {}, "all undefined");
__assert(Object.keys(mergeDraftMaps(undefined, { p: P }, { m: M })).length === 2, "no base = union");
