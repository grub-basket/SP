import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { perf } from "./perf";
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

  constructor(private host: NoteBodyHost, private component: Component, cache?: RenderCacheLike) {
    this.renderCache = cache ?? new Map<string, RenderEntry>();
  }

  async getOrComputeRender(file: TFile): Promise<RenderEntry> {
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
      const entry: RenderEntry = { mtime: file.stat.mtime, text, attachments, html: detached.innerHTML };
      this.renderCache.set(file.path, entry);
    } catch (e) {
      console.warn("[Stashpad] primeRender failed", e);
    }
  }

  /** (Re)create the lazy-body IntersectionObserver for the current paint.
   *  Root is the view's scroll host; rootMargin pre-renders a screenful
   *  above/below so scrolling rarely catches a placeholder. */
  arm(): void {
    this.bodyObserver?.disconnect();
    this.lazyBodies = new WeakMap();
    this.bodyObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        const fn = this.lazyBodies.get(el);
        this.bodyObserver?.unobserve(el);
        this.lazyBodies.delete(el);
        if (fn) fn();
      }
    }, { root: this.host.contentEl, rootMargin: "1400px 0px" });
  }

  /** Disconnect the observer (onClose). A missed disconnect leaks observers. */
  dispose(): void {
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
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
    const attachments: string[] = [];
    // 0.209.1: require a non-space char in the target. `![[   ]]` used to match,
    // which pushed "   " as an attachment AND deleted that text from the body —
    // so a stray pair of brackets made visible text disappear.
    const text = body.replace(/!\[\[(?=[^\]\|]*[^\s\]\|])([^\]\|]+)(?:\|[^\]]+)?\]\]/g, (_m, p1) => {
      attachments.push(p1);
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { text, attachments };
  }
}
