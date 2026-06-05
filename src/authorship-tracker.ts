import { App, Notice, TFile } from "obsidian";
import { ConfirmModal } from "./modals";
import type { TreeNode } from "./types";
import type { TreeIndex } from "./tree-index";
import type StashpadPlugin from "./main";

/** The view members the tracker calls back into. The live `StashpadView`
 *  satisfies this (it's passed as `this`), so `noteFolder` is always read
 *  fresh when the user switches folders. */
export interface AuthorshipHost {
  app: App;
  plugin: StashpadPlugin;
  tree: TreeIndex;
  noteFolder: string;
  getActionTargets(): TreeNode[];
  ensureFolder(path: string): Promise<void>;
  stripFrontmatter(md: string): string;
  debouncedRender: () => void;
}

/** Owns the authorship / multiplayer-contribution subsystem extracted from
 *  StashpadView: retroactive claim stamping, lazy author-stub creation,
 *  body-diff-gated contributor stamping, and the per-file multiplayer
 *  self/external write classification maps. Behavior is identical to when
 *  this lived inline in the view — see CLAUDE.md "Authorship / multiplayer"
 *  and docs/security-findings.md for the invariants. */
export class AuthorshipTracker {
  /** Body strings keyed by path. Populated on first sighting of a file
   *  and on every modify; used to distinguish body-edits (a real user
   *  change) from frontmatter-only writes (Stashpad's own
   *  processFrontMatter calls for color, attachments, contributor
   *  bumps, etc.). Only body-edits trigger contributor stamping, so
   *  Stashpad's internal writes don't add the local user as a
   *  contributor on every color change. */
  private knownBodies = new Map<string, string>();
  /** Per-path debouncers for the contributor-stamping pass. We batch
   *  modify events so a continuous edit session ("user types for 30
   *  seconds") produces ONE contribution write at the end, instead of
   *  hammering processFrontMatter on every keystroke. The flush also
   *  no-ops if the body matches what we already saw, so the
   *  contribution write itself doesn't recurse. */
  private contribTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 0.72.4: timestamps of writes we INITIATED (processFrontMatter
   *  calls inside maybeRecordContribution). A vault.modify event that
   *  fires within EXTERNAL_WRITE_GRACE_MS of one of these is "ours" —
   *  the rest are external (another client on the network share). */
  private recentSelfWrites = new Map<string, number>();
  /** 0.72.4: most recent external modify per path. Drives the "park
   *  the stamp until external activity quiets down" logic — if
   *  another client just touched the file, we don't write back over
   *  them; we keep the contribution parked and retry. */
  private lastExternalModify = new Map<string, number>();

  private static CONTRIB_DEBOUNCE_MS = 4000;
  private static CONTRIB_ACTIVE_EDITOR_BONUS_MS = 2000;
  /** 0.72.4: how long after a self-initiated processFrontMatter we
   *  expect the resulting vault.modify event. Anything that arrives
   *  inside this window is classified as our own write. */
  private static EXTERNAL_WRITE_GRACE_MS = 1500;
  /** 0.72.4: cooldown after an external (multiplayer) modify before
   *  we'll fire our own contribution stamp on the same file. Picks
   *  a value comfortably larger than typical network-share modify
   *  echo time so two clients don't volley last-write-wins. */
  private static EXTERNAL_QUIESCENCE_MS = 5000;

  constructor(private host: AuthorshipHost) {}

  /** Tear-down: cancel pending stamps and release the per-file tracking
   *  maps so they don't outlive the view (knownBodies in particular holds
   *  full body strings). They rebuild lazily on the next modify event. */
  dispose(): void {
    for (const t of this.contribTimers.values()) clearTimeout(t);
    this.contribTimers.clear();
    this.knownBodies.clear();
    this.recentSelfWrites.clear();
    this.lastExternalModify.clear();
  }

  /** The local user's author wikilink + resolved stub path for THIS view's
   *  folder, shaped as
   *  "[[<noteFolder>/_authors/<safe-name>-<id>|<displayName>]]".
   *  Falls back to null when the user hasn't set an author name (i.e.
   *  they've opted out of stamping). The display alias means readers
   *  see "Jane Doe", not the safe-slug-with-id. */
  currentAuthorLink(): { link: string; path: string; name: string; id: string } | null {
    const name = (this.host.plugin.settings.authorName ?? "").trim();
    const id = (this.host.plugin.settings.authorId ?? "").trim();
    if (!name || !id) return null;
    const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "author";
    const path = `${this.host.noteFolder}/_authors/${safe}-${id}.md`;
    // 0.77.11: strip characters that would break out of the wikilink alias
    // (`|` starts a new alias segment, `[`/`]` close/extend the link). A
    // name like `a|b]]x` would otherwise corrupt the author frontmatter.
    const aliasSafe = name.replace(/[\[\]|]/g, "").trim() || safe;
    const link = `[[${path}|${aliasSafe}]]`;
    return { link, path, name, id };
  }

  // --- 0.77.8: Claim authorship (retroactive stamping) ---

  /** Public entry points (called from main.ts command palette via the
   *  view's thin delegators). */
  claimSelectedAsAuthor(): void { void this.claimAuthorship({ scope: "selection", contributorMode: false }); }
  claimFolderAsAuthor(): void { void this.claimAuthorship({ scope: "folder", contributorMode: false }); }
  claimSelectedWithContributor(): void { void this.claimAuthorship({ scope: "selection", contributorMode: true }); }
  claimFolderWithContributor(): void { void this.claimAuthorship({ scope: "folder", contributorMode: true }); }

  /** All file-backed Stashpad notes (frontmatter `id`) under this view's
   *  folder, excluding the _authors stubs. */
  private fileBackedNotesInFolder(): TFile[] {
    const folder = this.host.noteFolder.replace(/\/+$/, "");
    return this.host.app.vault.getMarkdownFiles().filter((f) => {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== folder && !dir.startsWith(folder + "/")) return false;
      if (f.path.includes("/_authors/")) return false;
      const fm = this.host.app.metadataCache.getFileCache(f)?.frontmatter as any;
      return typeof fm?.id === "string" && !!fm.id;
    });
  }

  /** Apply a frontmatter mutation across many files, paced in batches so
   *  a bulk claim/unclaim doesn't choke the filesystem. Marks each as a
   *  self-write so the multiplayer external-modify detector doesn't park
   *  the change. */
  private async pacedFrontmatter(paths: string[], mutate: (m: any, path: string) => void): Promise<void> {
    const BATCH = 25, DELAY = 30;
    for (let i = 0; i < paths.length; i++) {
      const f = this.host.app.vault.getAbstractFileByPath(paths[i]);
      if (f instanceof TFile) {
        this.recentSelfWrites.set(f.path, Date.now());
        try { await this.host.app.fileManager.processFrontMatter(f, (m) => mutate(m, paths[i])); }
        catch (e) { console.warn("[Stashpad] claim: frontmatter write failed", paths[i], e); }
      }
      if ((i + 1) % BATCH === 0) await new Promise((r) => setTimeout(r, DELAY));
    }
  }

  /** Retroactively stamp the local user onto notes that predate authorship
   *  setup. SAFETY MODEL:
   *    - Never overwrites an existing `author` (only fills blank ones).
   *    - contributorMode=false: only blank-author notes are claimed.
   *    - contributorMode=true: blank → authored; already-authored-by-
   *      someone-else → we're added to `contributors` (original author
   *      untouched). Notes already authored/contributed by us are skipped.
   *    - Folder scope shows a counted confirmation first.
   *    - Undo stores ONLY the changed paths (not content snapshots), so
   *      undoing a big claim is cheap; undo guards against clobbering a
   *      real author that landed after the claim. */
  private async claimAuthorship(opts: { scope: "selection" | "folder"; contributorMode: boolean }): Promise<void> {
    const author = this.currentAuthorLink();
    if (!author) { new Notice("Set your author name in Stashpad settings first."); return; }
    const idTag = `-${author.id}`;

    const files = opts.scope === "selection"
      ? this.host.getActionTargets().map((n) => n.file).filter((f): f is TFile => !!f)
      : this.fileBackedNotesInFolder();
    if (files.length === 0) { new Notice(opts.scope === "selection" ? "No notes selected." : "No notes in this folder."); return; }

    const toAuthor: string[] = [];
    const toContributor: string[] = [];
    for (const f of files) {
      const fm = this.host.app.metadataCache.getFileCache(f)?.frontmatter as any;
      const a = typeof fm?.author === "string" ? fm.author : "";
      if (!a.trim()) { toAuthor.push(f.path); continue; }
      if (a.includes(idTag)) continue;                       // already ours
      if (!opts.contributorMode) continue;                   // skip authored
      const contributors: string[] = Array.isArray(fm?.contributors)
        ? fm.contributors.filter((c: any) => typeof c === "string") : [];
      if (!contributors.some((c) => c.includes(idTag))) toContributor.push(f.path);
    }

    const total = toAuthor.length + toContributor.length;
    if (total === 0) { new Notice("Nothing to claim — those notes are already authored by you."); return; }

    if (opts.scope === "folder") {
      const parts = [`Stamp yourself as author on ${toAuthor.length} unauthored note(s)`];
      if (toContributor.length) parts.push(`and as a contributor on ${toContributor.length} already-authored note(s)`);
      const ok = await new Promise<boolean>((resolve) => {
        new ConfirmModal(this.host.app, "Claim authorship",
          `${parts.join(" ")}?\nExisting authors are never overwritten. This can be undone.`,
          "Claim", resolve).open();
      });
      if (!ok) return;
    }

    const folder = this.host.noteFolder;
    const authorLink = author.link;
    // 0.77.9: when we author-claim a note where we were ALSO a contributor,
    // drop the (now-redundant) contributor entry — author supersedes. Track
    // those paths so undo can faithfully restore the contributor entry.
    const demotedFromContributor = new Set<string>();

    // Forward apply, reused by redo.
    const applyClaim = async () => {
      await this.pacedFrontmatter(toAuthor, (m, path) => {
        if (!(typeof m.author === "string" && m.author.trim())) m.author = authorLink;
        if (Array.isArray(m.contributors) && m.contributors.some((c: any) => typeof c === "string" && c.includes(idTag))) {
          m.contributors = m.contributors.filter((c: any) => !(typeof c === "string" && c.includes(idTag)));
          demotedFromContributor.add(path);
        }
      });
      await this.pacedFrontmatter(toContributor, (m) => {
        const contributors: string[] = Array.isArray(m.contributors)
          ? m.contributors.filter((c: any) => typeof c === "string") : [];
        if (!contributors.some((c) => c.includes(idTag))) contributors.push(authorLink);
        m.contributors = contributors;
      });
    };

    void this.ensureAuthorFile(author);
    await applyClaim();

    this.host.plugin.getUndoStack(folder).push({
      label: `Claim authorship (${total} note${total === 1 ? "" : "s"})`,
      undo: async () => {
        // Only strip what we added, and only if it's still ours (a real
        // author/contributor that landed afterwards is left intact).
        await this.pacedFrontmatter(toAuthor, (m, path) => {
          if (typeof m.author === "string" && m.author.includes(idTag)) delete m.author;
          // Restore a contributor entry we demoted during the claim.
          if (demotedFromContributor.has(path)) {
            const contributors: string[] = Array.isArray(m.contributors)
              ? m.contributors.filter((c: any) => typeof c === "string") : [];
            if (!contributors.some((c) => c.includes(idTag))) contributors.push(authorLink);
            m.contributors = contributors;
          }
        });
        await this.pacedFrontmatter(toContributor, (m) => {
          if (Array.isArray(m.contributors)) {
            m.contributors = m.contributors.filter((c: any) => !(typeof c === "string" && c.includes(idTag)));
          }
        });
        this.host.debouncedRender();
      },
      redo: async () => { demotedFromContributor.clear(); await applyClaim(); this.host.debouncedRender(); },
    });

    const bits: string[] = [];
    if (toAuthor.length) bits.push(`authored ${toAuthor.length}`);
    if (toContributor.length) bits.push(`contributing to ${toContributor.length}`);
    new Notice(`Claimed authorship: ${bits.join(", ")}. Undo available.`);
    this.host.debouncedRender();
  }

  /** Lazily create the author stub file under <stashpad>/_authors/.
   *  Idempotent: skips if the file already exists. The stub carries a
   *  small frontmatter with id + display name + created stamp, plus a
   *  level-1 heading so it reads cleanly when opened directly.
   *  Failures are swallowed (we don't want author-stub creation to
   *  block note creation) but logged for diagnosis. */
  async ensureAuthorFile(info: { path: string; name: string; id: string }): Promise<void> {
    try {
      // 0.77.1: register the author in the rebuildable registry (recovery
      // cache + rename history). Cheap upsert; no-op if unchanged.
      if (info.id) this.host.plugin.authorRegistry.record({ id: info.id, name: info.name });
      const folder = `${this.host.noteFolder}/_authors`;
      await this.host.ensureFolder(folder);
      if (await this.host.app.vault.adapter.exists(info.path)) return;
      // 0.77.4: stub uses the Obsidian-native `aliases` for the display
      // name (so [[Name]] resolves + quick-switcher finds it). Role/dept
      // come from the local user's settings when this stub is theirs.
      const isSelf = info.id === (this.host.plugin.settings.authorId ?? "").trim();
      const content = this.host.plugin.buildAuthorStub({
        id: info.id,
        name: info.name,
        role: isSelf ? this.host.plugin.settings.authorRole : undefined,
        department: isSelf ? this.host.plugin.settings.authorDepartment : undefined,
      }, new Date().toISOString());
      await this.host.app.vault.create(info.path, content);
    } catch (e) {
      console.warn("[Stashpad] ensureAuthorFile failed", e);
    }
  }

  /** Collect distinct author + contributor ids touching the given
   *  nodes — read from each node's current frontmatter (author +
   *  contributors). Used to pre-stamp `affectedAuthorIds` on
   *  destructive notifications so the history modal's Cross-author
   *  filter still works AFTER the notes are gone from the metadata
   *  cache (a post-delete resolver lookup would return nothing). */
  collectAuthorIds(nodes: TreeNode[]): string[] {
    const out = new Set<string>();
    const extract = (raw: unknown): string | null => {
      if (typeof raw !== "string") return null;
      const m = raw.match(/-([a-z0-9]{4,12})(?:\.md)?(?:\||\]\])/i);
      return m ? m[1] : null;
    };
    for (const n of nodes) {
      if (!n.file) continue;
      const fm = this.host.app.metadataCache.getFileCache(n.file)?.frontmatter;
      if (!fm) continue;
      const a = extract(fm.author);
      if (a) out.add(a);
      if (Array.isArray(fm.contributors)) {
        for (const c of fm.contributors) {
          const cid = extract(c);
          if (cid) out.add(cid);
        }
      }
    }
    return Array.from(out);
  }

  // --- File events ---

  /** 0.77.12: bound the per-file multiplayer-tracking maps during a long
   *  session. recentSelfWrites / lastExternalModify entries are only
   *  meaningful for a few seconds (the grace / quiescence windows), so
   *  anything far older is dead weight — drop it. knownBodies holds full
   *  body strings, so drop entries for paths no longer in this view's tree
   *  (deleted / moved-away notes); live files stay (idForPath finds them),
   *  so an in-progress edit's baseline is never lost. Fully cleared in
   *  onClose; this just trims mid-session. Idempotent + cheap. */
  pruneContribMaps(): void {
    const now = Date.now();
    const SELF_TTL = AuthorshipTracker.EXTERNAL_WRITE_GRACE_MS * 20;  // ~30s
    const EXT_TTL = AuthorshipTracker.EXTERNAL_QUIESCENCE_MS * 12;    // ~60s
    for (const [path, ts] of this.recentSelfWrites) {
      if (now - ts > SELF_TTL) this.recentSelfWrites.delete(path);
    }
    for (const [path, ts] of this.lastExternalModify) {
      if (now - ts > EXT_TTL) this.lastExternalModify.delete(path);
    }
    if (this.knownBodies.size > 64) {
      for (const path of this.knownBodies.keys()) {
        if (!this.host.tree.idForPath(path)) this.knownBodies.delete(path);
      }
    }
  }

  /** Classify a vault modify as self vs external (multiplayer) and queue a
   *  contribution stamp. Called from the view's onFileModify after it has
   *  filtered to in-folder .md files. Returns nothing — the non-authorship
   *  side effects (slug rename, attachment sync, re-render) stay in the
   *  view. */
  noteModify(file: TFile): void {
    // 0.72.4: classify the modify before any downstream handler reads
    // it. If the modify arrived within the grace window after our own
    // processFrontMatter, treat it as self; otherwise stamp it as
    // external so the contribution scheduler can park its work.
    const now = Date.now();
    const self = this.recentSelfWrites.get(file.path);
    const isSelf = self !== undefined && (now - self) < AuthorshipTracker.EXTERNAL_WRITE_GRACE_MS;
    if (!isSelf) this.lastExternalModify.set(file.path, now);
    this.scheduleContribution(file);
  }

  /** Queue (or re-queue) a contributor stamp for `file`, flushing
   *  CONTRIB_DEBOUNCE_MS after the most recent modify. Continuous
   *  typing keeps pushing the flush out, so a long edit session writes
   *  one contribution at the end.
   *
   *  Quiescence threshold tuned to "slightly longer than the natural
   *  pause between sentences" while also outliving Obsidian's editor
   *  save debounce — short enough to feel timely, long enough that
   *  the editor has fsync'd its in-flight content before our
   *  processFrontMatter call reads + rewrites the file. The old 1.5s
   *  threshold was tight enough on network drives (especially with
   *  multiplayer racing two clients' writes) that we'd occasionally
   *  read pre-save body content + clobber a few typed characters.
   *  See 0.72.3.
   *
   *  Also: if a Markdown editor leaf for this file is currently the
   *  active leaf, the user is probably still mid-thought even if they
   *  paused; defer the stamp by an additional bump so we don't fire
   *  while their cursor is in the doc. */
  private scheduleContribution(file: TFile): void {
    const existing = this.contribTimers.get(file.path);
    if (existing) clearTimeout(existing);
    const isActivelyEdited = this.isFileActivelyEdited(file);
    const delay = AuthorshipTracker.CONTRIB_DEBOUNCE_MS
      + (isActivelyEdited ? AuthorshipTracker.CONTRIB_ACTIVE_EDITOR_BONUS_MS : 0);
    const t = setTimeout(() => {
      this.contribTimers.delete(file.path);
      // Double-check at flush time: if the file is STILL being edited
      // (cursor in the editor, last keystroke very recent), defer
      // again. Prevents the worst-case "user paused 4s mid-paragraph,
      // we wrote, they resumed and lost their last typed run".
      if (this.isFileActivelyEdited(file)) {
        this.scheduleContribution(file);
        return;
      }
      // 0.72.4: if another client wrote to this file recently, park
      // the contribution stamp until external activity quiets down.
      // The stamp stays scheduled — every onFileModify call reschedules
      // — so once the cross-client volley dies down we eventually
      // flush a single combined stamp. Prevents stomping over a
      // teammate's in-flight save on a slow network share.
      const lastExt = this.lastExternalModify.get(file.path);
      if (lastExt !== undefined && (Date.now() - lastExt) < AuthorshipTracker.EXTERNAL_QUIESCENCE_MS) {
        this.scheduleContribution(file);
        return;
      }
      void this.maybeRecordContribution(file);
    }, delay);
    this.contribTimers.set(file.path, t);
  }

  /** True when the given file is open in the active Markdown leaf and
   *  the editor (or its container) currently holds focus. Used to
   *  guard the contribution stamp against racing in-flight typing. */
  private isFileActivelyEdited(file: TFile): boolean {
    try {
      const active: any = this.host.app.workspace.activeLeaf;
      if (!active) return false;
      const view = active.view;
      if (!view || view.getViewType?.() !== "markdown") return false;
      if (view.file?.path !== file.path) return false;
      // Editor focus check — if Obsidian's editor element contains the
      // focused element, the user is actively typing.
      const root = (view.containerEl ?? null) as HTMLElement | null;
      return !!root && root.contains(document.activeElement);
    } catch {
      return false;
    }
  }

  /** Compare the current file body against the last seen body for this
   *  path. If it changed, treat it as a user edit: bump `modified` and
   *  add the local user to `contributors` (unless they're the author
   *  or already in the list). Frontmatter-only writes don't move the
   *  body string, so they're skipped — keeping Stashpad's own
   *  processFrontMatter calls (color tweaks, attachment sync, even
   *  this very contribution write) from spuriously self-stamping. */
  private async maybeRecordContribution(file: TFile): Promise<void> {
    let raw = "";
    try { raw = await this.host.app.vault.cachedRead(file); } catch { return; }
    const body = this.host.stripFrontmatter(raw);
    const prev = this.knownBodies.get(file.path);
    this.knownBodies.set(file.path, body);
    if (prev === undefined) return;       // first sighting — no contribution
    if (prev === body) return;            // frontmatter-only write — skip
    // 0.79.19: never stamp during rebootstrap — its frontmatter writes and
    // the wikilink rewrites from slug-renames must not bump `modified` or
    // add contributors. knownBodies is already updated above, so the next
    // genuine edit is still detected correctly.
    if (this.host.plugin.rebootstrapInProgress) return;
    const author = this.currentAuthorLink();
    if (!author) return;                  // user opted out of stamping
    void this.ensureAuthorFile(author);
    const now = new Date().toISOString();
    // 0.72.4: stamp BEFORE the write so the resulting vault.modify
    // event (which fires asynchronously) can be classified as ours
    // instead of external. Without this, our own stamp would get
    // logged as an external modify, parking the next stamp
    // unnecessarily.
    this.recentSelfWrites.set(file.path, Date.now());
    try {
      await this.host.app.fileManager.processFrontMatter(file, (m: any) => {
        m.modified = now;
        const a = typeof m.author === "string" ? m.author : "";
        const contributors: string[] = Array.isArray(m.contributors)
          ? m.contributors.filter((c: unknown): c is string => typeof c === "string")
          : [];
        const idTag = `-${author.id}`;
        const isAuthor = a.includes(idTag);
        const already = contributors.some((c) => c.includes(idTag));
        if (!isAuthor && !already) contributors.push(author.link);
        m.contributors = contributors;
      });
    } catch (e) {
      console.warn("[Stashpad] maybeRecordContribution failed", e);
    }
  }
}
