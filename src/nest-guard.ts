/** 0.522.0: the "no nested Stashpad folders" rule.
 *
 *  A Stashpad folder must not sit inside another one, and must not contain one.
 *  Nesting is where the 0.521.0 Home-note bugs came from: the outer folder's
 *  tree walks into the inner folder, so both folders' writers touch the same
 *  notes. This module holds the pure part of the rule (the verdict and the
 *  wording); the plugin supplies the set of folders that are Stashpads today
 *  (`StashpadPlugin.nestGuard`), and every place that can turn a folder into a
 *  Stashpad asks it first.
 *
 *  It only ever BLOCKS NEW Stashpads. A folder that is already a Stashpad passes
 *  ("already" wins over "inside"), so pairs made before this rule keep working
 *  untouched — no existing notes are moved or rewritten. */
import { normalizePath } from "obsidian";
import { ROOT_ID, RESERVED_SUBFOLDER_NAMES, SUBFOLDER_ONLY_RESERVED_NAMES, isInReservedSubfolder } from "./types";

export type NestVerdict =
  | { ok: true; why: "already" | "free" | "internal" | "root" }
  | { ok: false; why: "inside"; path: string; stashpad: string }
  | { ok: false; why: "contains"; path: string; stashpad: string; count: number };

export type NestBlocked = Extract<NestVerdict, { ok: false }>;

/** 0.525.0: a NEW Stashpad refused because a folder in its path is one Stashpad
 *  uses for its own files (archive/, trash/, _attachments, …). `segment` is the
 *  first such folder name as typed; `inside` is false when the path IS that
 *  folder. */
export type ReservedBlocked = { ok: false; why: "reserved"; path: string; segment: string; inside: boolean };

/** 0.525.0: what the make-a-NEW-Stashpad paths get back. A separate type from
 *  NestVerdict on purpose: the view's blocked panel (`nestBlock`) only ever
 *  holds a NestBlocked, so a reserved refusal can never reach it. Views opened
 *  on a reserved folder (the Archived view's "Open") must keep working. */
export type NewStashpadVerdict = NestVerdict | ReservedBlocked;

/** Trim, collapse slashes, NFC (normalizePath), strip leading/trailing "/".
 *  The vault root comes back as "". */
export function normalizeNestPath(path: string): string {
  const p = normalizePath((path ?? "").trim());
  return p === "/" ? "" : p.replace(/^\/+|\/+$/g, "");
}

/** The verdicts that need no vault scan: the vault root, and Stashpad's own
 *  subfolders (archive/, trash/, _attachments, _exports, …). Those are never
 *  Stashpads of their own, and the Archived view's "Open" button opens
 *  `<folder>/archive` as a view, so they must never be blocked. */
export function trivialNestVerdict(path: string): NestVerdict | null {
  const p = normalizeNestPath(path);
  if (!p) return { ok: true, why: "root" };
  if (isInReservedSubfolder(p)) return { ok: true, why: "internal" };
  return null;
}

/** 0.525.0: the reserved-folder rule for a NEW Stashpad. trivialNestVerdict lets
 *  Stashpad's own subfolders through (views open on them), so before this a
 *  typed "Work/archive/Notes" or "Work/_attachments/X" became a Stashpad that
 *  discovery never lists, because the scan skips reserved folders.
 *
 *  Path only, no vault scan. Same positions as isInReservedSubfolder (a
 *  top-level "archive" or "trash" is a normal folder), but compared
 *  case-INSENSITIVELY: on macOS and Windows a typed "Work/Archive/X" lands
 *  inside an existing "Work/archive", and the folder switcher proper-cases
 *  "archive" to "Archive" anyway. On a case-sensitive disk this refuses a
 *  folder that only differs by case, which is the safe direction (nothing is
 *  written). */
export function reservedNestVerdict(path: string): ReservedBlocked | null {
  const p = normalizeNestPath(path);
  if (!p) return null;
  const segs = p.split("/");
  for (let i = 0; i < segs.length; i++) {
    const lower = segs[i].toLowerCase();
    if (RESERVED_SUBFOLDER_NAMES.has(lower) || (i > 0 && SUBFOLDER_ONLY_RESERVED_NAMES.has(lower))) {
      return { ok: false, why: "reserved", path: p, segment: segs[i], inside: i < segs.length - 1 };
    }
  }
  return null;
}

/** 0.525.0: add the reserved-folder rule to a nest verdict, for the paths that
 *  make a NEW Stashpad. A folder that is ALREADY a Stashpad still passes (the
 *  0.522.0 rule: only new ones are ever blocked), so an existing "Work/Archive"
 *  Stashpad, which the case-sensitive scan lists, keeps working. */
export function withReservedRule(v: NestVerdict, path: string): NewStashpadVerdict {
  if (!v.ok || v.why === "already") return v;
  return reservedNestVerdict(path) ?? v;
}

/** Build a checker over one snapshot of the Stashpad folders, so a picker can
 *  test every row without rescanning the vault per row.
 *
 *  Compared case-INSENSITIVELY: on macOS and Windows "projects/ideas" lands
 *  physically inside "Projects", and the folder switcher proper-cases names
 *  anyway. On a case-sensitive file system this can block a folder that only
 *  differs by case, which is the safe direction. Messages use the real casing
 *  of the existing Stashpad. */
export function makeNestChecker(claims: readonly string[]): (path: string) => NestVerdict {
  const byLower = new Map<string, string>();
  for (const c of claims) if (!byLower.has(c.toLowerCase())) byLower.set(c.toLowerCase(), c);
  return (path: string): NestVerdict => {
    const trivial = trivialNestVerdict(path);
    if (trivial) return trivial;
    const p = normalizeNestPath(path);
    const lower = p.toLowerCase();
    if (byLower.has(lower)) return { ok: true, why: "already" };
    // Nearest Stashpad above it first, so with an older nested pair A and A/B,
    // a new A/B/C names A/B.
    for (let cut = lower.lastIndexOf("/"); cut > 0; cut = lower.lastIndexOf("/", cut - 1)) {
      const hit = byLower.get(lower.slice(0, cut));
      if (hit) return { ok: false, why: "inside", path: p, stashpad: hit };
    }
    const prefix = lower + "/";
    const inner = [...byLower.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, real]) => real)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    if (inner.length) return { ok: false, why: "contains", path: p, stashpad: inner[0], count: inner.length };
    return { ok: true, why: "free" };
  };
}

/** Full sentence for notices, modals and the blocked view. */
export function nestBlockMessage(v: NewStashpadVerdict): string {
  if (v.ok) return "";
  // 0.525.0: when the path IS the reserved folder, "is inside" would misread.
  if (v.why === "reserved") {
    return v.inside
      ? `"${v.path}" is inside "${v.segment}", a folder Stashpad uses for its own files.`
      : `"${v.path}" can't be a Stashpad. Stashpad uses folders named "${v.segment.toLowerCase()}" for its own files.`;
  }
  const tail = "Stashpad folders can't be inside each other.";
  if (v.why === "inside") return `"${v.path}" is inside the Stashpad "${v.stashpad}". ${tail}`;
  if (v.count === 1) return `"${v.path}" contains the Stashpad "${v.stashpad}". ${tail}`;
  return `"${v.path}" contains ${v.count} Stashpads, including "${v.stashpad}". ${tail}`;
}

/** Short reason for a second line under a picker row. */
export function nestBlockReason(v: NewStashpadVerdict): string {
  if (v.ok) return "";
  if (v.why === "reserved") {
    return v.inside
      ? `Inside "${v.segment}", a folder Stashpad uses for its own files`
      : `Stashpad uses folders named "${v.segment.toLowerCase()}" for its own files`;
  }
  if (v.why === "inside") return `Inside the Stashpad "${v.stashpad}"`;
  if (v.count === 1) return `Contains the Stashpad "${v.stashpad}"`;
  return `Contains ${v.count} Stashpads, including "${v.stashpad}"`;
}

/** Does the start of a markdown file claim its folder as a Stashpad? The same
 *  test as `isStashpadClaimant` in main.ts (id + parent + either the Home id or
 *  an `attachments` key), read from raw text for files the metadata cache has
 *  not parsed yet. Only used to let an EXISTING Stashpad through, never to
 *  block, so a miss here just falls back to the cache's answer. */
export function headClaimsFolder(head: string): boolean {
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n---|$)/.exec(head);
  if (!m) return false;
  const fm = m[1];
  if (!/^id:\s*\S/m.test(fm) || !/^parent:/m.test(fm)) return false;
  return new RegExp(`^id:\\s*["']?${ROOT_ID}["']?\\s*$`, "m").test(fm) || /^attachments:/m.test(fm);
}

/** 0.528.0: where a NEW Stashpad that was refused for being INSIDE something
 *  goes instead: the vault root, under its last path segment ("Work/Ideas" →
 *  "Ideas"). For the "inside" refusals: inside a Stashpad, or a reserved
 *  folder anywhere below the top ("Work/archive/X", and "Work/Archive" itself,
 *  since a top-level "Archive" is an ordinary folder). A path that CONTAINS a
 *  Stashpad, or a single top-level name, has no root alternative and returns
 *  null. The caller must still judge the root path itself: it can be blocked
 *  (a root "_attachments" is still reserved) or already taken. */
export function rootRedirectName(v: NewStashpadVerdict): string | null {
  if (v.ok) return null;
  if (v.why === "inside" || (v.why === "reserved" && normalizeNestPath(v.path).includes("/"))) {
    const name = normalizeNestPath(v.path).split("/").pop() ?? "";
    if (!name || name === "." || name === "..") return null;
    return name.includes("/") ? null : name;
  }
  return null;
}

/** 0.528.0: the first half of the redirect notice: why it didn't go where typed. */
export function redirectWhy(v: NewStashpadVerdict): string {
  if (v.ok) return "";
  if (v.why === "reserved") return `"${v.segment}" is a folder Stashpad uses for its own files`;
  return "Stashpad folders can't be inside each other";
}

/** 0.528.0: the notice after a redirect. `existing`: what was already at the
 *  root under that name ("none" means a new folder was created). */
export function redirectMessage(v: NewStashpadVerdict, name: string, existing: "none" | "stashpad" | "folder"): string {
  const why = redirectWhy(v);
  if (existing === "stashpad") return `${why}, so your existing Stashpad "${name}" at the top of your vault was opened instead.`;
  if (existing === "folder") return `${why}, so the existing folder "${name}" at the top of your vault was opened as a Stashpad.`;
  return `${why}, so "${name}" was created at the top of your vault.`;
}

/** 0.528.0: a redirect to the vault root. `from` is the original refusal. */
export type RootRedirect = { from: NewStashpadVerdict; existing: "none" | "stashpad" | "folder"; message: string };

/** 0.528.0: StashpadPlugin.resolveNewStashpadTarget's answer. */
export type NewStashpadTarget =
  | { ok: true; folder: string; redirect: RootRedirect | null }
  | { ok: false; verdict: Exclude<NewStashpadVerdict, { ok: true }> };

/** 0.528.0: StashpadPlugin.createNewStashpad's answer: the folder that is now a
 *  Stashpad, and the redirect notice to show (null when it went where typed). */
export type NewStashpadResult = { folder: string; message: string | null };
