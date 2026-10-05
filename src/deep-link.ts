/**
 * Stashpad deep links — `obsidian://stashpad?…` URL build + parse.
 *
 * Obsidian doesn't allow a custom `stashpad://` scheme, but a plugin CAN claim
 * an action under the built-in `obsidian://` scheme via
 * `registerObsidianProtocolHandler`. See `docs/deep-links-plan.md`.
 *
 * NOTE ON THE MACRO PARAM: the spec doc calls it `action=`, but Obsidian's
 * `ObsidianProtocolData` RESERVES the `action` key for the protocol host name
 * (it's always `"stashpad"` here), so a query `action=` param collides with it
 * and is unreliable. We use `run=` for the macro list instead. The handler still
 * accepts a legacy `action=` value as a fallback when it isn't the host name.
 */

export const STASHPAD_PROTOCOL_ACTION = "stashpad";

/** v1 macro vocabulary — a deliberately closed set (no free-form command ids;
 *  links can come from untrusted notes). Richer tokens are v2. */
export const DEEP_LINK_ACTIONS = ["reveal", "open"] as const;
export type DeepLinkAction = (typeof DEEP_LINK_ACTIONS)[number];

/** 0.533.0: the Stashpad TABS a link can open with `tab=` — the views that
 *  aren't the note list. A closed set for the same reason as the macros: a link
 *  can come from an untrusted note, so it may only pick one of these, never
 *  name an arbitrary view type.
 *  - `showcase` — a level as one review page; uses `folder` + optional `note`
 *    (the level; absent = the top of the Stashpad).
 *  - `board` — the kanban board; optional `folder` (absent = all notes).
 *  - the aggregate modes (`tasks`, `calendar`, …), `trash`, `log`,
 *    `notifications` — vault-wide tabs; no folder. */
export const DEEP_LINK_TABS = [
  "showcase", "board",
  "tasks", "timeline", "calendar", "heatmap", "watch", "index", "encrypted", "archived",
  "trash", "log", "notifications",
] as const;
export type DeepLinkTab = (typeof DEEP_LINK_TABS)[number];

export function isDeepLinkTab(s: string | undefined | null): s is DeepLinkTab {
  return !!s && (DEEP_LINK_TABS as readonly string[]).includes(s);
}

/** Human name of a tab, for receipts and the link log. */
export const DEEP_LINK_TAB_LABELS: Record<DeepLinkTab, string> = {
  showcase: "Showcase", board: "Board",
  tasks: "All tasks", timeline: "Task timeline", calendar: "Due calendar", heatmap: "Activity heatmap",
  watch: "Watched notes", index: "Index", encrypted: "All encrypted", archived: "All archived",
  trash: "Trash", log: "Stashpad log", notifications: "Notifications",
};

export interface StashpadLinkParts {
  /** Obsidian switches/opens this vault if given; omit for the active vault. */
  vault?: string;
  /** The Stashpad folder path to route the view to. Required UNLESS `view` is
   *  given (a saved-view link carries its folder inside the saved state). */
  folder?: string;
  /** The target note's 6-char frontmatter `id` (NOT its filename). Optional. */
  note?: string;
  /** 0.334.0: open a SAVED VIEW by name (filter + focus + folder restored from
   *  settings.savedViews). Mutually sufficient with `folder`. */
  view?: string;
  /** 0.533.0: open one of the non-list Stashpad tabs (see DEEP_LINK_TABS).
   *  Carries `folder`/`note` only where that tab uses them; no `run`. */
  tab?: DeepLinkTab;
  /** Ordered macro tokens; defaults to `["reveal"]` when empty. */
  run?: string[];
}

/** Build a copy-pasteable `obsidian://stashpad?…` link. All values are
 *  URL-encoded so paths/names with spaces survive. */
export function buildStashpadLink(parts: StashpadLinkParts): string {
  const q: string[] = [];
  if (parts.vault) q.push(`vault=${encodeURIComponent(parts.vault)}`);
  // 0.334.0: a saved-view link is just `?view=<name>` — no folder/note/run (the
  // saved state restores all of that).
  if (parts.view) {
    q.push(`view=${encodeURIComponent(parts.view)}`);
    return `obsidian://${STASHPAD_PROTOCOL_ACTION}?${q.join("&")}`;
  }
  // 0.533.0: a tab link — `tab=` first so it reads as what it is, then the
  // folder/note the tab is scoped to (if any). No `run`: the tab IS the action.
  if (parts.tab) {
    q.push(`tab=${encodeURIComponent(parts.tab)}`);
    if (parts.folder) q.push(`folder=${encodeURIComponent(parts.folder)}`);
    if (parts.note) q.push(`note=${encodeURIComponent(parts.note)}`);
    return `obsidian://${STASHPAD_PROTOCOL_ACTION}?${q.join("&")}`;
  }
  if (parts.folder) q.push(`folder=${encodeURIComponent(parts.folder)}`);
  if (parts.note) q.push(`note=${encodeURIComponent(parts.note)}`);
  const run = parts.run && parts.run.length ? parts.run : ["reveal"];
  q.push(`run=${encodeURIComponent(run.join(","))}`);
  return `obsidian://${STASHPAD_PROTOCOL_ACTION}?${q.join("&")}`;
}

/** Params a pasted link resolves to — the shape `Plugin.handleDeepLink` accepts. */
export interface StashpadLinkParams {
  vault?: string;
  folder?: string;
  note?: string;
  view?: string;
  /** Raw `tab=` value — validated by the handler (an unknown tab is a loud
   *  failure there, not a silent "not a link" here). */
  tab?: string;
  run?: string;
  action?: string;
}

/** Parse a pasted `obsidian://stashpad?…` link (or a bare query string) into
 *  handler params. Tolerant of surrounding whitespace, a leading `?`, and a
 *  missing scheme (`folder=…&note=…` works too). Returns null when it isn't a
 *  recognizable Stashpad link — either the wrong `obsidian://` action or none
 *  of `folder` / `view` / `tab`. Values come back URL-decoded (via URLSearchParams), matching
 *  what Obsidian hands the live protocol handler. */
export function parseStashpadLink(raw: string): StashpadLinkParams | null {
  const text = (raw || "").trim();
  if (!text) return null;

  let query: string;
  if (/^obsidian:\/\//i.test(text)) {
    const m = text.match(/^obsidian:\/\/([^?]*)(?:\?(.*))?$/i);
    if (!m) return null;
    const act = decodeURIComponent(m[1].replace(/\/+$/, "")).toLowerCase();
    if (act !== STASHPAD_PROTOCOL_ACTION) return null;
    query = m[2] ?? "";
  } else {
    query = text.replace(/^\?/, "");
  }

  const params = new URLSearchParams(query);
  const folder = params.get("folder");
  const view = params.get("view");
  const tab = params.get("tab");
  // 0.334.0: a link needs EITHER a folder to route to OR a saved view to open.
  // 0.533.0: …or a tab (most tabs are vault-wide and carry no folder).
  if (!folder && !view && !tab) return null;

  const out: StashpadLinkParams = {};
  if (folder) out.folder = folder;
  if (view) out.view = view;
  if (tab) out.tab = tab;
  const vault = params.get("vault"); if (vault) out.vault = vault;
  const note = params.get("note"); if (note) out.note = note;
  const run = params.get("run"); if (run) out.run = run;
  const action = params.get("action"); if (action) out.action = action;
  return out;
}

/** Parse the macro list from a protocol handler's params. Prefers `run`; falls
 *  back to `action` only when it isn't the reserved host name. Lower-cased,
 *  trimmed, empties dropped, defaults to `["reveal"]`. */
export function parseRunActions(params: { run?: string; action?: string }): string[] {
  let raw = params.run;
  if (!raw && params.action && params.action !== STASHPAD_PROTOCOL_ACTION) raw = params.action;
  const tokens = (raw || "reveal")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length ? tokens : ["reveal"];
}
