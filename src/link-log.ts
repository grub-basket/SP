import type { App } from "obsidian";

/** How a link entered the log.
 *  - `shared` — Stashpad built the link and put it on the clipboard. The
 *    sending side, recorded so "I copied a link to that note yesterday" is a
 *    thing you can look up rather than reconstruct.
 *  - `received` — the link came back in through the `obsidian://stashpad`
 *    protocol handler.
 *  - `clipboard` — found on the clipboard at startup, for links the app never
 *    handed us (see `maybeOpenClipboardLink` in main.ts). */
export type LinkLogKind = "shared" | "received" | "clipboard";

/** What became of a link. Kept as a closed vocabulary so the view can label
 *  and filter without parsing prose.
 *  - `copied` — put on the clipboard (terminal state for a `shared` entry
 *    until the same URL comes back as `received`).
 *  - `opened` — a tab was opened for it.
 *  - `revealed` — a tab already showing the target was brought to the front;
 *    nothing was navigated.
 *  - `reused` — the tab THIS link opened before was brought back and
 *    re-navigated. Distinct from `opened` (no new tab) and from `revealed`
 *    (something did move).
 *  - `not-found` — resolved against this vault and missed.
 *  - `handed-off` — names another vault; passed to Obsidian to route.
 *  - `offered` — surfaced to the user, awaiting their say-so.
 *  - `undone` — opened, then the user took the offer to close it again.
 *  - `ignored` — surfaced and never acted on. */
export type LinkLogOutcome =
  | "copied" | "opened" | "revealed" | "reused" | "not-found"
  | "handed-off" | "offered" | "undone" | "ignored";

export interface LinkLogEntry {
  /** Stable within a session; used to amend an entry whose outcome is only
   *  known later (a clipboard link opened now, closed again a minute on). */
  id: string;
  ts: string;
  kind: LinkLogKind;
  /** The link as built or received. The identity a dedupe compares on. */
  url: string;
  folder: string;
  noteId: string | null;
  /** Saved-view links (`?view=<name>`) carry no folder/note. */
  view: string | null;
  /** The note's title at the time, when it was resolvable. Display only — a
   *  renamed note still logs under the title it had, which is what you'd be
   *  searching for. */
  title: string | null;
  outcome: LinkLogOutcome;
  /** One short clause of context for the outcome ("arrived during startup"). */
  detail?: string;
}

/** 0.481.0: the history of every Stashpad link — copied, received, or found on
 *  the clipboard — persisted as `link-log.jsonl` in the plugin private dir,
 *  beside `import-log.jsonl`.
 *
 *  It exists because a deep link's failure mode is silence: nothing opens, and
 *  there is nowhere to look to find out whether the link was dropped, pointed
 *  at a note that isn't here, or opened a tab behind another window. A log
 *  turns all three into something checkable after the fact, and makes a dropped
 *  link visible as an absence.
 *
 *  **Unlimited by default** (user's call). `limit` caps it when set; 0 keeps
 *  everything, at the cost of a file that grows with use and is re-read whole
 *  on first access. The view reports the entry count so the growth is visible
 *  rather than discovered. */
export class LinkLog {
  private readonly path: string;
  private entries: LinkLogEntry[] = [];
  private loaded = false;
  private dirOk = false;
  private seq = 0;
  private writeChain: Promise<void> = Promise.resolve();
  /** 0 = unlimited. */
  private limit = 0;

  constructor(private app: App, baseDir: string) {
    this.path = `${baseDir.replace(/\/+$/, "")}/link-log.jsonl`;
  }

  getPath(): string { return this.path; }
  size(): number { return this.entries.length; }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        const raw = await adapter.read(this.path);
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as LinkLogEntry;
            if (e && typeof e.url === "string") this.entries.push(e);
          } catch { /* skip a truncated or hand-edited line */ }
        }
      }
    } catch (e) {
      console.warn("[Stashpad] link log load failed", e);
    }
  }

  /** Newest first. */
  recent(): LinkLogEntry[] {
    return [...this.entries].reverse();
  }

  /** The most recent entry for this exact URL, or null.
   *  Backs the clipboard dedupe: a link we've already acted on is never
   *  offered again, however many times Obsidian restarts with it still sitting
   *  on the clipboard. */
  lastForUrl(url: string): LinkLogEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].url === url) return this.entries[i];
    }
    return null;
  }

  append(entry: Omit<LinkLogEntry, "id" | "ts"> & { ts?: string }): string {
    const id = `${Date.now().toString(36)}-${this.seq++}`;
    const full: LinkLogEntry = { ...entry, id, ts: entry.ts ?? new Date().toISOString() };
    this.entries.push(full);
    const overflow = this.limit > 0 && this.entries.length > this.limit;
    if (overflow) this.entries = this.entries.slice(-this.limit);
    this.queueWrite(overflow ? "rewrite" : full);
    return id;
  }

  /** Amend an entry whose outcome was only settled later. No-ops when the id
   *  is gone (trimmed by a retention cap, or from a previous session). */
  update(id: string, patch: Partial<Pick<LinkLogEntry, "outcome" | "detail" | "title">>): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && (e as unknown as Record<string, unknown>)[k] !== v) {
        (e as unknown as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    // An amendment can't be appended — the line already on disk would win on
    // the next load — so the file is rewritten. Rare enough (a clipboard offer
    // resolving) that the cost doesn't matter; skipped entirely when nothing
    // actually changed.
    if (changed) this.queueWrite("rewrite");
  }

  /** Apply a retention cap. 0 = unlimited. Trims immediately when the new cap
   *  is smaller than what's held, so the setting takes effect when set rather
   *  than at the next append. */
  setLimit(limit: number): void {
    const next = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    if (next === this.limit) return;
    this.limit = next;
    if (next > 0 && this.entries.length > next) {
      this.entries = this.entries.slice(-next);
      this.queueWrite("rewrite");
    }
  }

  getLimit(): number { return this.limit; }

  /** Empty the log — but keep what was in it.
   *
   *  The file is RENAMED aside (`link-log-cleared-<stamp>.jsonl`) rather than
   *  truncated. Clearing a history is one of those actions that feels reversible
   *  until it isn't, and the whole point of this log is answering questions
   *  about links from weeks ago; a mis-click shouldn't be the end of that.
   *  Nothing reads the archive — it's there to be found. */
  clear(): Promise<void> {
    if (this.entries.length === 0) return Promise.resolve();
    this.entries = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = this.path.replace(/\.jsonl$/, `-cleared-${stamp}.jsonl`);
    this.writeChain = this.writeChain.then(async () => {
      const adapter = this.app.vault.adapter;
      try {
        if (await adapter.exists(this.path)) await adapter.rename(this.path, archive);
      } catch (e) {
        // Couldn't archive → don't destroy. An un-cleared log is a far smaller
        // problem than a cleared-and-gone one.
        console.warn("[Stashpad] link log archive failed — leaving the file in place", e);
        return;
      }
      try { await adapter.write(this.path, ""); } catch { /* recreated on next append */ }
    });
    return this.writeChain;
  }

  /** Where `clear()` would put the archive — for the message that says so. */
  archiveHint(): string {
    return this.path.replace(/\.jsonl$/, "-cleared-<timestamp>.jsonl");
  }

  private queueWrite(what: LinkLogEntry | "rewrite"): void {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.ensureDir();
        if (what === "rewrite") {
          const body = this.entries.map((e) => JSON.stringify(e)).join("\n");
          await this.app.vault.adapter.write(this.path, body ? body + "\n" : "");
        } else {
          await this.app.vault.adapter.append(this.path, JSON.stringify(what) + "\n");
        }
      } catch (e) {
        console.warn("[Stashpad] link log write failed", e);
      }
    });
  }

  private async ensureDir(): Promise<void> {
    if (this.dirOk) return;
    const adapter = this.app.vault.adapter;
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    this.dirOk = true;
  }
}

/** Human labels for the view. Kept beside the vocabulary so a new outcome
 *  can't be added without a label. */
export const LINK_KIND_LABELS: Record<LinkLogKind, string> = {
  shared: "Shared",
  received: "Received",
  clipboard: "Clipboard",
};

export const LINK_OUTCOME_LABELS: Record<LinkLogOutcome, string> = {
  copied: "copied",
  opened: "opened",
  revealed: "revealed",
  reused: "reused its tab",
  "not-found": "not found",
  "handed-off": "sent to Obsidian",
  offered: "offered",
  undone: "closed again",
  ignored: "not used",
};
