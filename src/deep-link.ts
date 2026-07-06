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

export interface StashpadLinkParts {
  /** Obsidian switches/opens this vault if given; omit for the active vault. */
  vault?: string;
  /** The Stashpad folder path to route the view to (required). */
  folder: string;
  /** The target note's 6-char frontmatter `id` (NOT its filename). Optional. */
  note?: string;
  /** Ordered macro tokens; defaults to `["reveal"]` when empty. */
  run?: string[];
}

/** Build a copy-pasteable `obsidian://stashpad?…` link. All values are
 *  URL-encoded so paths/names with spaces survive. */
export function buildStashpadLink(parts: StashpadLinkParts): string {
  const q: string[] = [];
  if (parts.vault) q.push(`vault=${encodeURIComponent(parts.vault)}`);
  q.push(`folder=${encodeURIComponent(parts.folder)}`);
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
  run?: string;
  action?: string;
}

/** Parse a pasted `obsidian://stashpad?…` link (or a bare query string) into
 *  handler params. Tolerant of surrounding whitespace, a leading `?`, and a
 *  missing scheme (`folder=…&note=…` works too). Returns null when it isn't a
 *  recognizable Stashpad link — either the wrong `obsidian://` action or no
 *  `folder` param. Values come back URL-decoded (via URLSearchParams), matching
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
  if (!folder) return null; // folder is required to route a Stashpad link

  const out: StashpadLinkParams = { folder };
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
