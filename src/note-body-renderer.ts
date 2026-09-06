import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { perf } from "./perf";
import { takeLeadingColor } from "./highlight-colors";
import type { RenderCacheLike } from "./render-cache-store";

/** A cached per-file body render. `html` is the rendered MarkdownRenderer
 *  output; `ovW`/`ovV` memoize the overflow (clamp) decision keyed by the
 *  list width it was measured at. The view mutates `ovW`/`ovV` on the
 *  returned object — since it's the same reference held in the cache, that
 *  updates the cache in place. */
export interface RenderEntry {
  mtime: number;
  text: string;
  attachments: string[];
  html: string;
  ovW?: number;
  ovV?: boolean;
}

/** The view members the body renderer calls back into. */
export interface NoteBodyHost {
  app: App;
  contentEl: HTMLElement;
  stripFrontmatter(md: string): string;
}

/** Owns the lazy-body render cache + IntersectionObserver machinery extracted
 *  from StashpadView (0.82.1, the perf win). `bodyObserver` watches cold rows;
 *  when one nears the viewport its deferred render closure runs once. The
 *  per-file `renderCache` memoizes the expensive cachedRead + MarkdownRenderer
 *  pass (and the per-row overflow decision). The view keeps the actual
 *  body-painting (renderNoteBody/renderNoteBodyNow) — render core — and
 *  delegates cache lookups + observer registration here. */
export class NoteBodyRenderer {
  /** Per-file rendered-body cache. Also memoizes the overflow decision
   *  (does it exceed the 2-line clamp?) keyed by the list width it was
   *  measured at — so re-rendering an unchanged list (e.g. after adding
   *  ONE note to a 200-child Home) doesn't force a scrollHeight read (=
   *  layout reflow) on all 200 rows. That per-row reflow thrash was the
   *  dominant cost of the "couple seconds to render" lag. */
  /** 0.83.2: the cache is injectable. Defaults to a plain in-memory Map;
   *  the view passes a persisted `RenderCacheStore` so rendered bodies
   *  survive reloads (and a cold open reads one cache file instead of N
   *  note bodies over a slow drive). */
  private renderCache: RenderCacheLike;
  /** 0.82.1: lazy-body machinery. `bodyObserver` watches cold rows; when
   *  one nears the viewport its deferred render closure (stored in
   *  `lazyBodies`, keyed by the body container) runs once. */
  private bodyObserver: IntersectionObserver | null = null;
  private lazyBodies = new WeakMap<HTMLElement, () => void>();
  // 0.295.2 (perf): body renders are drained a few per frame instead of all in
  // the observer callback's own task. `renderQueue` holds the rows whose bodies
  // are due (nearest-to-viewport-centre first); `queued` dedupes re-entries
  // (a row stays observed until its fn actually runs, so it can be reported
  // intersecting more than once). `drainHandle` is the in-flight rAF/timeout.
  private renderQueue: HTMLElement[] = [];
  private queued = new Set<HTMLElement>();
  private drainHandle: number | null = null;
  private drainViaTimeout = false;
  /** How many deferred bodies to render per frame. */
  private static readonly DRAIN_PER_FRAME = 6;

  constructor(private host: NoteBodyHost, private component: Component, cache?: RenderCacheLike) {
    this.renderCache = cache ?? new Map<string, RenderEntry>();
  }

  async getOrComputeRender(file: TFile): Promise<RenderEntry> {
    // 0.294.0 (perf): the persisted store now loads OFF the onload critical path,
    // so it may still be materializing when the first lazy body render fires.
    // This path is already async (it's about to `cachedRead`), so waiting for the
    // store costs nothing it wasn't going to spend — and it keeps the cold-open
    // cache HIT that the whole persisted cache exists for. Synchronous consumers
    // (peekCache, the view's pre-paint peeks) just see a miss until then.
    if (this.renderCache.ready) await this.renderCache.ready;
    const cached = this.renderCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) { perf.record("render.row.cacheHit", 0); return cached; }
    // Cache miss / stale entry. Read + parse + render into a detached div
    // and stash the result before returning. 0.81.1: split the body READ
    // (network I/O on a share) from the markdown RENDER (CPU) so the
    // profile shows which dominates.
    const md = await perf.timeAsync("render.row.read", () => this.host.app.vault.cachedRead(file));
    const raw = this.host.stripFrontmatter(md);
    const { text, attachments } = this.splitAttachments(raw);
    const detached = createDiv({ cls: "stashpad-note-text" });
    await perf.timeAsync("render.row.markdown", () => MarkdownRenderer.render(this.host.app, text, detached, file.path, this.component));
    this.colorizeHighlights(detached);
    const html = detached.innerHTML;
    const entry: RenderEntry = { mtime: file.stat.mtime, text, attachments, html };
    this.renderCache.set(file.path, entry);
    return entry;
  }

  /** 0.159.0: seed the render cache for a JUST-created note from the body we
   *  already hold in RAM — no `cachedRead` (the slow network round-trip) and no
   *  filename-title placeholder. Called by `createNoteUnder` right after the
   *  file is written, before `render()`, so the new row paints its real body
   *  immediately and stays stable. `rawBody` is the note's body text WITHOUT
   *  frontmatter (what the composer produced); it's run through the same
   *  attachment-split + MarkdownRenderer path as a normal read so the primed
   *  entry is byte-identical to what a later read would compute. Best-effort:
   *  a failure just leaves the row to render the normal (slower) way. */
  async primeRender(file: TFile, rawBody: string): Promise<void> {
    try {
      const { text, attachments } = this.splitAttachments(this.host.stripFrontmatter(rawBody));
      const detached = createDiv({ cls: "stashpad-note-text" });
      await MarkdownRenderer.render(this.host.app, text, detached, file.path, this.component);
      this.colorizeHighlights(detached);
      const entry: RenderEntry = { mtime: file.stat.mtime, text, attachments, html: detached.innerHTML };
      this.renderCache.set(file.path, entry);
    } catch (e) {
      console.warn("[Stashpad] primeRender failed", e);
    }
  }

  /** 0.284.0: multi-color highlights. Obsidian renders `==🔴text==` as
   *  `<mark>🔴text</mark>` — the color emoji is just literal text inside the
   *  mark. Here we lift it out: for each `<mark>` whose leading text is a
   *  highlight-color emoji, strip that emoji (+ one padding space) and tag the
   *  mark with `stashpad-hl-<key>` so CSS tints it. Marks without a leading
   *  color emoji are left as the plain (default) highlight. */
  private colorizeHighlights(root: HTMLElement): void {
    root.querySelectorAll("mark").forEach((mark) => {
      const first = mark.firstChild;
      if (!first || first.nodeType !== 3 /* TEXT_NODE */) return;
      const taken = takeLeadingColor(first.textContent ?? "");
      if (!taken) return;
      first.textContent = taken.rest;
      mark.classList.add(`stashpad-hl-${taken.key}`);
      mark.setAttribute("data-hl", taken.key);
    });
  }

  /** (Re)create the lazy-body IntersectionObserver for the current paint.
   *  Root is the view's scroll host; rootMargin pre-renders a screenful
   *  above/below so scrolling rarely catches a placeholder. */
  arm(): void {
    this.bodyObserver?.disconnect();
    this.lazyBodies = new WeakMap();
    // 0.295.2 (perf): a fresh paint forgets every row queued for the old one.
    this.clearQueue();
    this.bodyObserver = new IntersectionObserver((entries) => {
      // 0.295.2 (perf): the callback no longer RENDERS — it only queues. With
      // row virtualization a window update builds ~25-40 rows at once and, since
      // rootMargin (1400px) is wider than the overscan (700px), essentially all
      // of them report intersecting in ONE callback. Running each fn() there
      // kicked off dozens of MarkdownRenderer passes in a single task (the
      // scroll-stutter). Instead: collect, order by distance from the viewport
      // centre (what the user is actually looking at renders first), drain a few
      // per frame.
      const rootRect = this.host.contentEl.getBoundingClientRect();
      const centre = rootRect.top + rootRect.height / 2;
      const due: { el: HTMLElement; dist: number }[] = [];
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (!e.isIntersecting) {
          // Scrolled back out before its turn — drop it. It stays observed, so
          // it re-queues if it comes back.
          this.dequeue(el);
          continue;
        }
        if (this.queued.has(el) || !this.lazyBodies.has(el)) continue;
        const r = e.boundingClientRect;
        due.push({ el, dist: Math.abs(r.top + r.height / 2 - centre) });
      }
      if (due.length === 0) return;
      due.sort((a, b) => a.dist - b.dist);
      for (const d of due) { this.queued.add(d.el); this.renderQueue.push(d.el); }
      this.scheduleDrain();
    }, { root: this.host.contentEl, rootMargin: "1400px 0px" });
  }

  /** 0.295.2 (perf): render the next slice of queued bodies, then reschedule if
   *  any remain. rAF is throttled/paused in a hidden window, so fall back to a
   *  timeout there (an Obsidian window can be backgrounded mid-scroll and we
   *  don't want the queue to stall until it's looked at again). */
  private scheduleDrain(): void {
    if (this.drainHandle !== null || this.renderQueue.length === 0) return;
    const run = () => {
      this.drainHandle = null;
      let budget = NoteBodyRenderer.DRAIN_PER_FRAME;
      while (budget > 0 && this.renderQueue.length > 0) {
        const el = this.renderQueue.shift() as HTMLElement;
        this.queued.delete(el);
        // The row may have been removed from the DOM by virtualization while it
        // waited. Never render into a detached node — and leave its bookkeeping
        // (WeakMap entry + observation) INTACT: if the row is re-attached the
        // observer fires again and it re-queues. A detached node gets no
        // intersection callbacks, so this can't loop; if it's never re-attached
        // the whole subtree (and its WeakMap entry) is collected.
        if (!el.isConnected) continue;
        const fn = this.lazyBodies.get(el);
        if (!fn) continue;
        this.bodyObserver?.unobserve(el);
        this.lazyBodies.delete(el);
        budget--;
        fn();
      }
      this.scheduleDrain();
    };
    if (document.visibilityState === "hidden") {
      this.drainViaTimeout = true;
      this.drainHandle = window.setTimeout(run, 16);
    } else {
      this.drainViaTimeout = false;
      this.drainHandle = requestAnimationFrame(run);
    }
  }

  /** Remove a row from the pending render queue (it scrolled out / was dropped). */
  private dequeue(el: HTMLElement): void {
    if (!this.queued.delete(el)) return;
    const i = this.renderQueue.indexOf(el);
    if (i >= 0) this.renderQueue.splice(i, 1);
  }

  private clearQueue(): void {
    this.renderQueue = [];
    this.queued.clear();
    if (this.drainHandle !== null) {
      if (this.drainViaTimeout) window.clearTimeout(this.drainHandle);
      else cancelAnimationFrame(this.drainHandle);
      this.drainHandle = null;
    }
  }

  /** Disconnect the observer (onClose). A missed disconnect leaks observers. */
  dispose(): void {
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
    this.clearQueue();
  }

  /** True when the observer is live (armed for the current paint). */
  isArmed(): boolean {
    return !!this.bodyObserver;
  }

  hasFreshRenderCache(file: TFile): boolean {
    const c = this.renderCache.get(file.path);
    return !!c && c.mtime === file.stat.mtime;
  }

  /** 0.180.0: the cached render entry REGARDLESS of mtime (may be stale). Used to
   *  pre-paint a row's last-known body instantly on a re-render, so a
   *  frontmatter-only write (color / task / due) doesn't flash the filename
   *  placeholder while the (usually identical) body recomputes in the background. */
  peekCache(file: TFile): RenderEntry | undefined {
    return this.renderCache.get(file.path);
  }

  /** 0.122.6 (#13): drop a file's cached render so the next render recomputes
   *  from fresh content. Wired to the modify event. The mtime-keyed cache can be
   *  poisoned: a render that runs while `cachedRead` is momentarily stale — seen
   *  on a network drive or after an external/coworker edit — stamps the NEW
   *  mtime onto OLD content, so it then serves a truncated / attachment-less body
   *  until reload. Evicting on modify forces a recompute after the render
   *  debounce (by when cachedRead is fresh), breaking that sticky-stale state. */
  evict(file: TFile): void {
    const c = this.renderCache as { evict?: (p: string) => void; delete?: (p: string) => void };
    if (c.evict) c.evict(file.path);
    else if (c.delete) c.delete(file.path);
  }

  /** 0.160.0: move a cached render entry to a NEW mtime without recomputing —
   *  used when a frontmatter-only self-write (fmSync recovery links) bumps the
   *  file's mtime but leaves the body unchanged. Without this, the mtime-keyed
   *  cache would look stale and force a re-read on a slow drive (the second
   *  create flash). No-ops if there's no entry (nothing rendered yet). */
  retagMtime(path: string, mtime: number): void {
    const c = this.renderCache.get(path);
    if (c && c.mtime !== mtime) this.renderCache.set(path, { ...c, mtime });
  }

  /** Register a deferred render for a cold row: run `fn` once the container
   *  nears the viewport. */
  defer(container: HTMLElement, fn: () => void): void {
    this.lazyBodies.set(container, fn);
    this.bodyObserver?.observe(container);
  }

  private splitAttachments(body: string): { text: string; attachments: string[] } {
    // 0.272.2: a FILE embed shows in the rail, NOT inline. `![[photo.png]]` used
    // to render its image preview in the note body (0.271.6, #3). The user found
    // that too heavy: a file embed now loses its inline preview but KEEPS its
    // text as a plain link (`[[photo.png]]`, visible), and the file goes to the
    // rail — "as though they weren't embedded." Only the leading `!` is removed.
    //
    // A NOTE embed (`![[Note]]`, `![[2026-08-18]]`, `.md`) is a transclusion, not
    // an attachment: left exactly as-is so it still renders inline. Plain file
    // links (`[[photo.png]]`) already show as text; they just also index in the
    // rail. Note LINKS stay body-only and show in the backlinks / outgoing rails.
    const attachments: string[] = [];
    const isFile = (raw: string): string | null => {
      const target = raw.trim();
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(target.split(/[?#]/)[0])?.[1]?.toLowerCase();
      return ext && ext !== "md" ? target : null;
    };
    // File embeds → de-embed to a visible link (drop the `!`) + rail. Note
    // embeds are returned untouched so they still transclude.
    const text = body.replace(/!\[\[(?=[^\]\|]*[^\s\]\|])([^\]\|]+)(?:\|[^\]]+)?\]\]/g, (m, p1: string) => {
      const f = isFile(p1);
      if (!f) return m;               // note transclusion — keep the embed
      attachments.push(f);
      return m.slice(1);              // `![[file]]` -> `[[file]]` (link, no preview)
    });
    // Plain file links → rail (text already visible). Lookbehind skips the `[[`
    // inside any remaining `![[…]]` (there are none after the replace, but a
    // note embed's inner brackets must not be miscounted).
    for (const m of text.matchAll(/(?<!!)\[\[(?=[^\]\|]*[^\s\]\|])([^\]\|]+)(?:\|[^\]]+)?\]\]/g)) {
      const f = isFile(m[1]); if (f) attachments.push(f);
    }
    // De-dupe: the same file embedded and linked is one rail chip.
    return { text, attachments: [...new Set(attachments)] };
  }
}
