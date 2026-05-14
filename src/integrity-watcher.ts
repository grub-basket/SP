import type { TreeIndex } from "./tree-index";
import type { StashpadLog } from "./log";

export class IntegrityWatcher {
  constructor(private tree: TreeIndex, private log: StashpadLog) {}

  /**
   * Compare the current folder's tree against the persisted state and log
   * deltas. The state file is shared across folders, so we filter it down
   * to entries under `folder` before diffing — otherwise switching folders
   * would log every note in the previously focused folder as missing.
   */
  async sweep(folder?: string): Promise<void> {
    const prev = await this.log.readState();
    const cur = this.tree.snapshot();

    const inFolder = (path: string): boolean => {
      if (!folder) return true;
      const f = folder.replace(/\/+$/, "");
      return path === f || path.startsWith(f + "/");
    };

    for (const [id, info] of Object.entries(cur)) {
      const before = prev[id];
      if (!before) {
        await this.log.append({ type: "create", id, payload: { path: info.path, parent: info.parent } });
      } else if (before.parent !== info.parent) {
        await this.log.append({
          type: "parent_change", id,
          payload: { from: before.parent, to: info.parent },
        });
      } else if (before.path !== info.path) {
        await this.log.append({
          type: "rename", id,
          payload: { from: before.path, to: info.path },
        });
      }
    }

    // Only flag "missing" for notes that lived in the folder we just swept;
    // entries from other folders are out of scope for this sweep.
    for (const [id, info] of Object.entries(prev)) {
      if (!cur[id] && inFolder(info.path)) {
        await this.log.append({ type: "missing", id, payload: { lastPath: info.path } });
      }
    }

    // Merge: keep state entries from other folders untouched, replace this
    // folder's entries with the fresh snapshot.
    const merged: Record<string, { parent: string | null; path: string }> = {};
    for (const [id, info] of Object.entries(prev)) {
      if (!inFolder(info.path)) merged[id] = info;
    }
    for (const [id, info] of Object.entries(cur)) merged[id] = info;
    await this.log.writeState(merged);
  }
}
