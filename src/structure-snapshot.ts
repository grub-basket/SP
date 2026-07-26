import type { App } from "obsidian";
import { ROOT_ID } from "./types";

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

const SNAPSHOT_FILE = ".stashpad-structure.json";
/** One rotated generation, in case a bug ever defeats the retention rule. */
const PREV_FILE = ".stashpad-structure.prev.json";
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
  private pending = new Map<string, StructureSnapshot>();
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
    try {
      const path = this.pathFor(folder);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      const parsed = JSON.parse(await adapter.read(path)) as StructureSnapshot;
      if (!parsed || parsed.schema !== SCHEMA || !parsed.notes) return null;
      return parsed;
    } catch (e) {
      console.warn("[Stashpad] structure snapshot load failed", e);
      return null;
    }
  }

  /** Queue a write of `notes` for `folder` (debounced + coalesced). */
  schedule(folder: string, notes: Record<string, StructureEntry>): void {
    const cleaned = folder.replace(/\/+$/, "");
    if (!cleaned) return;
    this.pending.set(cleaned, {
      schema: SCHEMA,
      folder: cleaned,
      updated: new Date().toISOString(),
      notes,
    });
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
      const snap = this.pending.get(key);
      if (!snap) continue;
      this.pending.delete(key);
      this.writeChain = this.writeChain.then(async () => {
        try {
          // An empty folder writes nothing rather than an empty map — a blank
          // snapshot would be indistinguishable from "everything was deleted"
          // and is exactly what you don't want to restore FROM.
          if (!Object.keys(snap.notes).length) return;
          const merged = await this.mergeWithPrevious(key, snap);
          const adapter = this.app.vault.adapter;
          const path = this.pathFor(key);
          // Rotate before overwriting: one intact generation behind us.
          try {
            if (await adapter.exists(path)) await adapter.write(this.prevPathFor(key), await adapter.read(path));
          } catch { /* rotation is best-effort; never block the write */ }
          await adapter.write(path, JSON.stringify(merged, null, 1));
        } catch (e) {
          console.warn("[Stashpad] structure snapshot save failed", e);
        }
      });
    }
    await this.writeChain;
  }

  private prevPathFor(folder: string): string {
    return `${folder.replace(/\/+$/, "")}/${PREV_FILE}`;
  }

  /** Fold the live shape into the stored one under the RETENTION rule: entries
   *  the tree no longer knows about are kept while their file still exists on
   *  disk (damaged, not deleted) and pruned once it's gone. This is what stops
   *  a frontmatter wipe from erasing its own recovery record. */
  private async mergeWithPrevious(folder: string, next: StructureSnapshot): Promise<StructureSnapshot> {
    const prev = await this.load(folder);
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
      console.info(`[Stashpad] structure snapshot: kept ${retained} entr${retained === 1 ? "y" : "ies"} for note(s) whose file still exists but which left the tree (possible frontmatter damage) in "${folder}".`);
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
