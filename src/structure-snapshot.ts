import type { App } from "obsidian";
import { ROOT_ID, STASHPAD_SIDECAR_FILES } from "./types";

/** 0.206.0: per-folder structure snapshot — a recovery sidecar.
 *
 *  WHY THIS EXISTS. A Stashpad note's place in the tree lives in its own
 *  frontmatter (`id` / `parent` / `created`). That's the right primary store —
 *  file-over-app, readable in ten years — but it has one failure mode: lose a
 *  note's frontmatter (a bad merge, an errant Find-and-Replace, a plugin that
 *  rewrites YAML, a sync conflict) and the note becomes an anonymous orphan.
 *  Its own recovery data went with the thing that broke.
 *
 *  `parentLink` / `children` were the first answer, but they're written INTO
 *  every note — so they die with it, they cost a write per affected note on
 *  every move (the dominant per-move cost on a network share, which is why
 *  they're toggleable), and they go stale.
 *
 *  This is the cheap complement: ONE file per folder holding the whole shape.
 *  A move rewrites one file instead of N notes, it survives a note losing its
 *  frontmatter entirely, and — the important part — it's keyed so a note can be
 *  found again by **path**, which is all that's left when the frontmatter is
 *  gone. `plugin.repairFolderFromSnapshot()` is the consumer.
 *
 *  Deliberately NOT the source of truth: if this file is missing, corrupt or
 *  stale, nothing breaks — the tree is still built from frontmatter, exactly as
 *  before. It's a photocopy, not the original. Same contract as the render
 *  cache: worst case it's useless, never harmful.
 *
 *  ── THE HAZARD THIS IS BUILT AROUND ──────────────────────────────────────
 *  A naive mirror of "the tree right now" DESTROYS ITSELF at the exact moment
 *  it's needed. Wipe a note's frontmatter → the metadata cache fires → the tree
 *  drops the note → the snapshot rewrites without it. The photocopy now records
 *  the damage, and the good copy is gone.
 *
 *  Two rules prevent that, and they're the whole reason this file is more than
 *  a `JSON.stringify(tree)`:
 *
 *  1. RETENTION — an entry is only dropped when its FILE IS ACTUALLY GONE from
 *     disk. A note that vanishes from the tree while its file still exists
 *     hasn't been deleted; it's been *damaged*, and its last-known position is
 *     precisely what recovery needs. Those entries are kept (and marked
 *     `missing`). File deleted → real deletion → pruned.
 *  2. GENERATION — the previous snapshot is rotated to `.prev.json` before each
 *     write, so even a bug in rule 1 still leaves one intact copy behind.
 *  ─────────────────────────────────────────────────────────────────────────
 *
 *  Dotfile (like `.stashpad-order.json`) so it stays out of the note list and
 *  out of Obsidian's file index; read/written through `vault.adapter`. */

const SNAPSHOT_FILE = STASHPAD_SIDECAR_FILES[2]; // see types.ts
/** One rotated generation, in case a bug ever defeats the retention rule. */
const PREV_FILE = STASHPAD_SIDECAR_FILES[3];
/** Bump when the shape changes incompatibly; a mismatch is discarded. */
const SCHEMA = 1;

export interface StructureEntry {
  /** Parent note id, or null for a top-level note. */
  parent: string | null;
  /** Vault path at the time of the snapshot — the key for recovering a note
   *  whose frontmatter (and therefore its id) is gone. */
  path: string;
  /** ISO created stamp, so a wiped note can be restored to its sort position. */
  created?: string;
  /** First line of the body, to identify a note by eye in the JSON. */
  title?: string;
  /** Set when the note left the tree but its file is still on disk — i.e. it
   *  looks damaged rather than deleted. ISO stamp of when we first noticed. */
  missing?: string;
}

export interface StructureSnapshot {
  schema: number;
  folder: string;
  updated: string;
  notes: Record<string, StructureEntry>;
}

export class StructureSnapshotStore {
  private timers = new Map<string, number>();
  /** 0.294.0 (perf): pending holds a BUILDER, not a built snapshot. The caller
   *  used to walk the whole tree and allocate a ~400-entry Record before every
   *  schedule() call — so a burst of 20 metadata events built the object 20
   *  times and threw 19 away. The thunk is evaluated in flush(), which is also
   *  exactly when we want it: the write then reflects the FINAL tree state
   *  rather than the state at the first event of the burst. */
  private pending = new Map<string, () => Record<string, StructureEntry>>();
  private writeChain: Promise<void> = Promise.resolve();
  /** Debounce: structure changes arrive in bursts (a drag, a multi-move, an
   *  import). One write per quiet period, not one per mutation. */
  private static SAVE_DEBOUNCE_MS = 4000;

  constructor(private app: App) {}

  private pathFor(folder: string): string {
    return `${folder.replace(/\/+$/, "")}/${SNAPSHOT_FILE}`;
  }

  /** Read a folder's snapshot. Null when absent/unreadable/wrong schema —
   *  callers must treat every one of those as "no snapshot", never an error. */
  async load(folder: string): Promise<StructureSnapshot | null> {
    return (await this.readLive(folder)).parsed;
  }

  /** 0.491.0 (perf): ONE read of the live snapshot, returning both the raw bytes and
   *  the parsed value.
   *
   *  A flush has two consumers for the very same file: `mergeWithPrevious` needs it
   *  PARSED (for the retention set) and the rotation needs it RAW (to copy verbatim
   *  into `.prev.json`). Each used to do its own `exists` + `read`, so every snapshot
   *  write cost 6 adapter ops where 4 do — measured, and on a network share at
   *  300-600ms/op that is ~0.6-1.2s of pure duplication per write.
   *
   *  This is NOT a cache: nothing is retained across operations, so there is no
   *  staleness window to reason about. It is strictly more correct than reading
   *  twice — the old code could read different bytes for the merge and the rotation
   *  if the file changed in between (a sync landing mid-flush), and then rotate a
   *  generation that did not match what the merge was based on.
   *
   *  Contract, unchanged from the old `load()`: `parsed` is null for absent AND for
   *  unreadable/wrong-schema alike. `raw` distinguishes them — null means the file is
   *  genuinely absent, a string means it exists but did not parse, which is what the
   *  rotation needs in order to refuse to rotate garbage. */
  private async readLive(folder: string): Promise<{ raw: string | null; parsed: StructureSnapshot | null }> {
    const path = this.pathFor(folder);
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(path))) return { raw: null, parsed: null };
      const raw = await adapter.read(path);
      try {
        const p = JSON.parse(raw) as StructureSnapshot;
        return { raw, parsed: (p && p.schema === SCHEMA && p.notes) ? p : null };
      } catch {
        return { raw, parsed: null };          // exists, but corrupt — do NOT rotate it
      }
    } catch (e) {
      console.warn("[Stashpad] structure snapshot load failed", e);
      return { raw: null, parsed: null };
    }
  }

  /** 0.211.6 (L7): strip stored `title`s for notes whose file is no longer on disk,
   *  from BOTH the live snapshot and the rotated `.prev.json`.
   *
   *  The snapshot records each note's title so a repair can show something meaningful.
   *  When a note is locked with filename-hiding on, its plaintext file is removed and
   *  the title is supposed to become unreadable — but a snapshot written moments
   *  earlier still held it, and `.prev.json` kept that generation indefinitely and
   *  synced it to every device. Filename-hiding was therefore defeated by a recovery
   *  sidecar sitting next to the encrypted blob.
   *
   *  Keyed on "the file is gone" rather than on a list of locked ids, because the lock
   *  result doesn't carry per-note ids and the purged files are exactly the ones whose
   *  titles must not survive. Structural recovery is unaffected: `parent`, `path` and
   *  `created` all stay, and only the cosmetic title is dropped. Called after a
   *  hide-title lock; safe to call at any time. */
  async purgeTitlesForMissingNotes(folder: string): Promise<void> {
    const cleaned = folder.replace(/\/+$/, "");
    if (!cleaned) return;
    const adapter = this.app.vault.adapter;
    const scrub = async (path: string): Promise<void> => {
      try {
        if (!(await adapter.exists(path))) return;
        const snap = JSON.parse(await adapter.read(path)) as StructureSnapshot;
        if (!snap?.notes) return;
        let changed = false;
        for (const entry of Object.values(snap.notes)) {
          if (entry.title === undefined) continue;
          if (await adapter.exists(entry.path)) continue; // still a live plaintext note
          delete entry.title;
          changed = true;
        }
        if (changed) await adapter.write(path, JSON.stringify(snap, null, 1));
      } catch (e) {
        console.warn("[Stashpad] couldn't scrub snapshot titles", path, e);
      }
    };
    await scrub(this.pathFor(cleaned));
    await scrub(this.prevPathFor(cleaned));
  }

  /** Queue a write for `folder` (debounced + coalesced). `build` is called once,
   *  when the debounce fires — see the note on `pending`. */
  schedule(folder: string, build: () => Record<string, StructureEntry>): void {
    const cleaned = folder.replace(/\/+$/, "");
    if (!cleaned) return;
    this.pending.set(cleaned, build);
    if (this.timers.has(cleaned)) return;
    const t = window.setTimeout(() => {
      this.timers.delete(cleaned);
      void this.flush(cleaned);
    }, StructureSnapshotStore.SAVE_DEBOUNCE_MS);
    this.timers.set(cleaned, t);
  }

  /** Write any pending snapshot for `folder` now. Called on view teardown so a
   *  close during the debounce window doesn't drop the latest shape. */
  async flush(folder?: string): Promise<void> {
    const keys = folder ? [folder.replace(/\/+$/, "")] : [...this.pending.keys()];
    for (const key of keys) {
      const timer = this.timers.get(key);
      if (timer != null) { window.clearTimeout(timer); this.timers.delete(key); }
      const build = this.pending.get(key);
      if (!build) continue;
      this.pending.delete(key);
      // 0.294.0 (perf): build here, once per debounce window. `updated` is
      // stamped at build time too, so it describes the shape being written.
      let snap: StructureSnapshot;
      try {
        snap = { schema: SCHEMA, folder: key, updated: new Date().toISOString(), notes: build() };
      } catch (e) {
        // A recovery aid must never take down whatever asked it to flush (view
        // teardown, plugin unload). A failed build just skips this generation;
        // the previous snapshot on disk is untouched.
        console.warn("[Stashpad] couldn't build structure snapshot", key, e);
        continue;
      }
      this.writeChain = this.writeChain.then(async () => {
        try {
          // An empty folder writes nothing rather than an empty map — a blank
          // snapshot would be indistinguishable from "everything was deleted"
          // and is exactly what you don't want to restore FROM.
          if (!Object.keys(snap.notes).length) return;
          const adapter = this.app.vault.adapter;
          const path = this.pathFor(key);
          // 0.491.0 (perf): read the live snapshot ONCE and serve both consumers from
          // it — the merge wants it parsed, the rotation wants it verbatim. This used
          // to be two independent `exists` + `read` pairs on the same file (6 ops per
          // write instead of 4), and they could see different bytes if a sync landed
          // between them.
          const live = await this.readLive(key);
          const merged = await this.mergeWithPrevious(key, snap, live.parsed);
          // Rotate before overwriting: one intact generation behind us.
          try {
            // 0.211.8: only rotate a snapshot that actually PARSES. Rotating an
            // unreadable one overwrites the last good generation with garbage, so a
            // single corrupt write would cost both copies — and `.prev.json` is the
            // fallback mergeWithPrevious relies on precisely when the live file is
            // unreadable. A corrupt current file is simply replaced below.
            // `raw !== null` means the file EXISTS; `parsed` means it also parsed.
            if (live.raw !== null) {
              if (live.parsed) await adapter.write(this.prevPathFor(key), live.raw);
              else console.warn("[Stashpad] not rotating an unreadable structure snapshot — keeping the previous generation", path);
            }
          } catch { /* rotation is best-effort; never block the write */ }
          await adapter.write(path, JSON.stringify(merged, null, 1));
        } catch (e) {
          console.warn("[Stashpad] structure snapshot save failed", e);
        }
      });
    }
    await this.writeChain;
  }

  /** 0.211.8: read the ROTATED generation (`.prev.json`). Used only as the fallback
   *  when the live snapshot is unreadable, so a corrupt file doesn't cost us the
   *  retention set. Same "null for anything wrong" contract as `load`. */
  private async loadPrevGeneration(folder: string): Promise<StructureSnapshot | null> {
    try {
      const path = this.prevPathFor(folder);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      const parsed = JSON.parse(await adapter.read(path)) as StructureSnapshot;
      if (!parsed || parsed.schema !== SCHEMA || !parsed.notes) return null;
      return parsed;
    } catch { return null; }
  }

  private prevPathFor(folder: string): string {
    return `${folder.replace(/\/+$/, "")}/${PREV_FILE}`;
  }

  /** Fold the live shape into the stored one under the RETENTION rule: entries
   *  the tree no longer knows about are kept while their file still exists on
   *  disk (damaged, not deleted) and pruned once it's gone. This is what stops
   *  a frontmatter wipe from erasing its own recovery record. */
  /** `live` is the already-read live snapshot (0.491.0) — passed in rather than
   *  re-read here, so a flush touches the file once. Pass `undefined` from any caller
   *  that has not read it, and this falls back to reading it itself. */
  private async mergeWithPrevious(folder: string, next: StructureSnapshot, live?: StructureSnapshot | null): Promise<StructureSnapshot> {
    // 0.211.8: `load()` returns null for "absent" AND for "unreadable/wrong schema"
    // alike, and returning `next` on null threw away the RETENTION set — the entries
    // for notes whose file still exists but which have dropped out of the tree, i.e.
    // exactly the frontmatter-damage records this sidecar exists to hold. Worse, the
    // caller then wrote `next` over the file, so a single unparseable snapshot
    // permanently discarded the recovery data. Fall back to the rotated generation:
    // it's one write behind, and its retention entries are re-validated against disk
    // below anyway, so a stale one costs nothing.
    const prev = (live !== undefined ? live : await this.load(folder))
      ?? await this.loadPrevGeneration(folder);
    if (!prev) return next;
    const adapter = this.app.vault.adapter;
    const now = new Date().toISOString();
    const notes: Record<string, StructureEntry> = { ...next.notes };
    let retained = 0;
    for (const [id, entry] of Object.entries(prev.notes)) {
      if (notes[id]) continue;              // still in the tree — the live entry wins
      if (!entry?.path) continue;
      let onDisk = false;
      try { onDisk = await adapter.exists(entry.path); } catch { onDisk = false; }
      if (!onDisk) continue;                // really deleted — let it go
      notes[id] = { ...entry, missing: entry.missing ?? now };
      retained++;
    }
    if (retained) {
      console.debug(`[Stashpad] structure snapshot: kept ${retained} entr${retained === 1 ? "y" : "ies"} for note(s) whose file still exists but which left the tree (possible frontmatter damage) in "${folder}".`);
    }
    return { ...next, notes };
  }

  /** Cancel pending timers (plugin unload after an explicit flush). */
  dispose(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
  }
}

/** Path → { id, entry } for a loaded snapshot: the lookup a note whose
 *  frontmatter was wiped actually needs, since its path is all that survived. */
export function indexByPath(snap: StructureSnapshot): Map<string, { id: string; entry: StructureEntry }> {
  const out = new Map<string, { id: string; entry: StructureEntry }>();
  for (const [id, entry] of Object.entries(snap.notes)) {
    if (entry?.path) out.set(entry.path, { id, entry });
  }
  return out;
}

/** Normalize a snapshot parent to what frontmatter should carry. */
export function parentForFrontmatter(parent: string | null | undefined): string {
  return parent && parent !== ROOT_ID ? parent : ROOT_ID;
}
