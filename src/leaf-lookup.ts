/** 0.485.0 — the ONE place allowed to pull a single Stashpad leaf out of the
 *  workspace.
 *
 *  `workspace.getLeavesOfType()` returns leaves in **tab order**. So `[0]` and
 *  `.find()` mean "the LEFTMOST tab", never "the tab the user is looking at".
 *  That distinction is invisible until someone opens a second Stashpad tab on
 *  the same folder — and then the feature quietly drives the wrong one.
 *
 *  It has shipped three times in features written years apart:
 *    - 0.68.1  sidebar panel Search / Home buttons
 *    - 0.484.0 loading a draft (reported as "the button does nothing" — it was
 *              loading, into an off-screen tab)
 *    - 0.484.1 "Reveal or open Stashpad", and deep-link navigation
 *
 *  Rather than wait for a fourth, `no-restricted-syntax` in `eslint.config.mjs`
 *  now rejects the raw single-leaf idioms anywhere in `src/` — and this file is
 *  the only exemption. If you need a Stashpad leaf, take it from here.
 *
 *  Iterating EVERY leaf is unaffected and needs nothing from this module; the
 *  hazard is only ever "which ONE".
 */
import { App, WorkspaceLeaf } from "obsidian";
import { STASHPAD_VIEW_TYPE } from "./types";

/** Anything that can answer "which Stashpad tab was last active, if it is still
 *  open". `StashpadPlugin` implements this; typed structurally to keep this
 *  module free of a plugin import (and the cycle that would come with it). */
export interface LeafRecencyHost {
  activeStashpadLeafIfOpen(): WorkspaceLeaf | null;
}

/** Every open Stashpad leaf, in tab order. Safe: order only matters when you
 *  pick one, and picking is what the rest of this module is for. */
export function stashpadLeaves(app: App): WorkspaceLeaf[] {
  return app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
}

const folderOf = (leaf: WorkspaceLeaf, normalize: boolean): string => {
  const f = ((leaf.view as unknown as { noteFolder?: string })?.noteFolder ?? "");
  return normalize ? f.replace(/\/+$/, "") : f;
};

/** The Stashpad tab showing `folder`, preferring the one the user is actually
 *  looking at, falling back to the first in tab order. **This is the default —
 *  reach for it unless you have a reason not to.**
 *
 *  `normalize` trims trailing slashes on both sides. Leave it OFF when the
 *  caller (or its callee) compares folder strings strictly elsewhere: a
 *  leniently-matched leaf can pass this picker and then be rejected downstream,
 *  which is how a working action turns into a confusing error. `switchToDraft`
 *  is exactly that case.
 */
export function preferredStashpadLeafOnFolder(
  app: App, host: LeafRecencyHost | null, folder: string,
  opts: { normalize?: boolean } = {},
): WorkspaceLeaf | null {
  const normalize = opts.normalize === true;
  const want = normalize ? folder.replace(/\/+$/, "") : folder;
  const active = host?.activeStashpadLeafIfOpen() ?? null;
  if (active && folderOf(active, normalize) === want) return active;
  return stashpadLeaves(app).find((l) => folderOf(l, normalize) === want) ?? null;
}

/** The last-active Stashpad tab on ANY folder, else the first open one.
 *  For "show me Stashpad" actions that aren't folder-specific. */
export function preferredStashpadLeaf(app: App, host: LeafRecencyHost | null): WorkspaceLeaf | null {
  const leaves = stashpadLeaves(app);
  const active = host?.activeStashpadLeafIfOpen() ?? null;
  if (active && leaves.includes(active)) return active;
  return leaves[0] ?? null;
}

/** First tab on `folder` in tab order, recency ignored.
 *
 *  ONLY for questions every tab on a folder answers identically — e.g. asking a
 *  TreeIndex which file an id resolves to. If the result is shown to the user,
 *  navigated, or written to, you want `preferredStashpadLeafOnFolder` instead.
 */
export function anyStashpadLeafOnFolder(
  app: App, folder: string, opts: { normalize?: boolean } = {},
): WorkspaceLeaf | null {
  const normalize = opts.normalize === true;
  const want = normalize ? folder.replace(/\/+$/, "") : folder;
  return stashpadLeaves(app).find((l) => folderOf(l, normalize) === want) ?? null;
}
