/** 0.560.0: moving a note's subtree OUT into another Stashpad folder, and
 *  Unfold (the durable reverse of src/folder-fold.ts).
 *
 *  `moveSubtreeToFolder` is the shared piece: it carries a note's subtree —
 *  plaintext through `crossFolderPaste` (cut), locked children through
 *  `relockBundleInto` (re-encrypted under the new folder's key) — into
 *  another folder, optionally DISSOLVING the note itself so its children
 *  become the new folder's top level. Unfold uses it to put a fold's container
 *  back as its own folder; "Split this note out into its own Stashpad"
 *  (0.562.0) uses it too.
 *
 *  Unfold works from the fold manifest the fold left in the archived folder,
 *  so it survives a reload (the in-memory undo stack does not): the archived
 *  folder goes back to its old path, everything under the container note —
 *  including notes added since the fold — moves back as its top level, and
 *  the archive / trash / attachment / author files the fold moved come home.
 *  Undo of an Unfold puts the fold back. */
import { Modal, Setting, SuggestModal, TFile, TFolder, type App } from "obsidian";
import { buildHomeFilename } from "./view-helpers";
import { openFolderSetup } from "./folder-setup-modal";
import type StashpadPlugin from "./main";
import { ROOT_ID, siftMatch, type StashpadId } from "./types";
import { readFolderSubtreeNodes, readLockedMeta, type SubtreeNode } from "./encryption-ops";
import { serializeNote, splitFrontmatter } from "./stash-package";
import { ConfirmModal } from "./modals";
import { notify } from "./notify";
import {
  FOLD_MANIFEST, FOLD_SUBFOLDER_PREFIX, ensureFolder, isEncryptedFile, remapLockedRegistry, removeEmptyFolders,
  runUndoSteps, transferReEncryptWatch, uniqueFilePath, type FoldDirMapEntry, type FoldManifest, type UndoStep,
} from "./folder-fold";

const clean = (p: string): string => (p || "").replace(/^\/+|\/+$/g, "");
const baseName = (p: string): string => clean(p).split("/").pop() || clean(p);

export interface SubtreeMoveResult {
  movedRootIds: StashpadId[];
  idRemap: Record<string, string>;
  noteCount: number;
  relocked: number;
  /** Locked children that stayed where they were, with the reason. */
  left: string[];
  /** Locked children whose re-lock failed twice — UNLOCKED in the new folder. */
  plaintext: string[];
}

/** Ids of `rootId` and every note under it, from a folder snapshot. */
function subtreeIds(nodes: readonly SubtreeNode[], rootId: StashpadId): Set<string> {
  const kids = new Map<string, SubtreeNode[]>();
  for (const n of nodes) {
    const p = n.parent === null ? "" : String(n.parent);
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(n);
  }
  const out = new Set<string>([String(rootId)]);
  const queue = [String(rootId)];
  while (queue.length) {
    const id = queue.shift()!;
    for (const k of kids.get(id) ?? []) {
      if (out.has(String(k.id))) continue; // cycle guard
      out.add(String(k.id));
      queue.push(String(k.id));
    }
  }
  return out;
}

/** Move note `rootId` (and everything under it) from `from` to `to`'s top
 *  level. `dissolveRoot`: the note itself is removed (to the trash, restorable
 *  by undo) and its CHILDREN become top-level notes instead. `skipIds`: direct
 *  children to leave out (Unfold drops the fold's own settings note).
 *  Each completed step pushes its undo onto the CALLER's `undoSteps` as it
 *  goes, so a throw half-way still leaves the caller able to roll back what
 *  already happened (0.562.1 — the list used to come back only on success). */
export async function moveSubtreeToFolder(
  plugin: StashpadPlugin, fromRaw: string, rootId: StashpadId, toRaw: string,
  opts: { dissolveRoot: boolean; skipIds?: StashpadId[] },
  undoSteps: UndoStep[],
): Promise<SubtreeMoveResult> {
  const app = plugin.app;
  const from = clean(fromRaw);
  const to = clean(toRaw);
  const nodes = await readFolderSubtreeNodes(app, from);
  const root = nodes.find((n) => String(n.id) === String(rootId));
  if (!root) throw new Error("that note isn't in the folder any more");
  const ids = subtreeIds(nodes, rootId);
  const skip = new Set((opts.skipIds ?? []).map(String));
  const pasteRoots = (opts.dissolveRoot
    ? nodes.filter((n) => String(n.parent) === String(rootId) && !skip.has(String(n.id)))
    : [root]
  ).sort((a, b) => (a.created || "").localeCompare(b.created || "")).map((n) => n.id);

  const result: SubtreeMoveResult = { movedRootIds: [], idRemap: {}, noteCount: 0, relocked: 0, left: [], plaintext: [] };
  if (pasteRoots.length) {
    const res = await plugin.crossFolderPaste(from, pasteRoots, to, ROOT_ID, "cut");
    if (!res) throw new Error("the notes couldn't be moved");
    undoSteps.push({ label: "move the notes back", run: res.undo });
    result.movedRootIds = res.rootIds;
    result.noteCount = res.noteCount;
    result.idRemap = Object.fromEntries(Object.entries(res.idRemap ?? {}).filter(([a, b]) => a !== b));
    // Unlocked-by-the-user notes keep their "re-lock me" reminders.
    undoSteps.push(transferReEncryptWatch(plugin, from, to, ids, result.idRemap));
  }

  // Locked children: blobs directly in `from` whose parent is in the subtree.
  for (const b of app.vault.getFiles().filter((f) => f.parent?.path === from && f.extension === "stashenc")) {
    const meta = await readLockedMeta(app, b.path);
    if (!meta?.parentId || !ids.has(String(meta.parentId))) continue;
    if (skip.has(String(meta.rootId))) continue;
    const r = await plugin.relockBundleInto(b.path, to, { reparentTo: ROOT_ID, parentRemap: result.idRemap });
    if (r.status === "moved" && r.undo) { result.relocked++; undoSteps.push({ label: `put “${b.basename}” back`, run: r.undo }); }
    else if (r.status === "plaintext") result.plaintext.push(`${b.basename}: ${r.reason}`);
    else result.left.push(`${b.basename}: ${r.reason}`);
  }

  if (opts.dissolveRoot && root.file instanceof TFile) {
    const snap = await plugin.snapshotPaths([root.file.path]);
    await app.fileManager.trashFile(root.file);
    undoSteps.push({ label: "bring the note back", run: () => plugin.restoreSnapshot(snap) });
  }
  return result;
}

// --------------------------------------------------------------- Unfold ----

/** The fold manifest for a folded folder (by its OLD path), or null. Read from
 *  the shell the SETTINGS name (never one the manifest names). */
export async function readFoldManifest(plugin: StashpadPlugin, src: string): Promise<FoldManifest | null> {
  const map = plugin.settings.foldedFolders ?? {};
  const key = clean(src);
  const fold = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  if (!fold) return null;
  try { return JSON.parse(await plugin.app.vault.adapter.read(`${fold.shell}/${FOLD_MANIFEST}`)) as FoldManifest; }
  catch { return null; }
}

/** Where each of the old folder's archive/trash folders went: the manifest's
 *  dirMap (0.562.1+), its `bases` (0.560–0.562.0), or — for 0.558/0.559
 *  manifests — worked out from what it moved / re-locked. */
function foldDirMap(plugin: StashpadPlugin, m: FoldManifest): FoldDirMapEntry[] {
  if (m.dirMap) return m.dirMap;
  const out: FoldDirMapEntry[] = [];
  if (m.bases) {
    for (const kind of ["archive", "trash"] as const) if (m.bases[kind]) out.push({ from: `${m.src}/${kind}`, to: m.bases[kind]! });
    return out;
  }
  const name = baseName(m.src);
  const cands = [
    ...m.moved.map((x) => x.to.slice(0, x.to.lastIndexOf("/"))),
    ...(plugin.settings.lockedSubtrees ?? []).map((l) => clean(l.folder)),
  ];
  for (const kind of ["archive", "trash"] as const) {
    const top = `${m.dest}/${kind}/`;
    // Exactly from-<name> or from-<name> <n> (a unique suffix) — not from-<name> Other.
    const re = new RegExp(`^${(FOLD_SUBFOLDER_PREFIX + name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+)?$`);
    const hit = cands.map((c) => (c.startsWith(top) ? c.slice(top.length).split("/")[0] : "")).find((seg) => re.test(seg));
    if (hit) out.push({ from: `${m.src}/${kind}`, to: `${top}${hit}` });
  }
  return out;
}

/** Drop anything in a manifest that points outside what a fold of `src` into
 *  `dest` could have touched — the manifest is a plain file in the vault, so a
 *  tampered or synced-in one must not steer Unfold at arbitrary paths. */
function sanitizeManifest(m: FoldManifest, src: string, dest: string, dirMap: FoldDirMapEntry[]): { dirMap: FoldDirMapEntry[]; moved: FoldManifest["moved"]; settingsNotePath: string | null } {
  const under = (p: unknown, root: string): boolean => typeof p === "string" && p.startsWith(`${root}/`) && !p.split("/").some((x) => x === ".." || x === ".");
  const okDir = dirMap.filter((d) => ["archive", "trash"].some((k) =>
    (d.from === `${src}/${k}` || (under(d.from, `${src}/${k}`) && (d.from.split("/").pop() ?? "").startsWith(FOLD_SUBFOLDER_PREFIX)))
    && under(d.to, `${dest}/${k}`) && (d.to.split("/").pop() ?? "").startsWith(FOLD_SUBFOLDER_PREFIX)
    && d.to.split("/").length === `${dest}/${k}`.split("/").length + 1));
  const moved = (Array.isArray(m.moved) ? m.moved : []).filter((x) => under(x.from, src)
    && (under(x.to, `${dest}/_attachments`) || under(x.to, `${dest}/_authors`) || under(x.to, `${dest}/archive`) || under(x.to, `${dest}/trash`)));
  const settingsNotePath = under(m.settingsNotePath, dest) && String(m.settingsNotePath).endsWith(".md")
    && String(m.settingsNotePath).split("/").length === dest.split("/").length + 1 ? m.settingsNotePath : null;
  const dropped = dirMap.length - okDir.length + (m.moved?.length ?? 0) - moved.length + (m.settingsNotePath && !settingsNotePath ? 1 : 0);
  if (dropped) console.warn(`[Stashpad] unfold: ignored ${dropped} manifest entr${dropped === 1 ? "y" : "ies"} outside the fold's folders`);
  return { dirMap: okDir, moved, settingsNotePath };
}

/** Why `src` can't be unfolded right now, or null. */
export async function unfoldRefusal(plugin: StashpadPlugin, src: string, m: FoldManifest | null): Promise<string | null> {
  const a = plugin.app.vault.adapter;
  if (!m) return `No fold record found for “${baseName(src)}”.`;
  const fold = plugin.settings.foldedFolders?.[src];
  // The manifest must describe THIS fold (it's a plain, editable file).
  if (!fold || m.src !== src || m.dest !== fold.into || m.shell !== fold.shell || String(m.containerId) !== String(fold.containerId)) {
    return `The fold record for “${baseName(src)}” doesn't match — not unfolding it automatically.`;
  }
  if (await a.exists(src)) return `A folder called “${src}” exists again — rename or move it first.`;
  if (!(await a.exists(m.shell))) return `The archived folder “${m.shell}” is gone, so there's nothing to bring back.`;
  if (!(plugin.app.vault.getAbstractFileByPath(m.dest) instanceof TFolder)) return `“${m.dest}” (where it was folded) no longer exists.`;
  return null;
}

export interface UnfoldResult { noteCount: number; relocked: number; problems: string[]; undo: () => Promise<void> }

/** Reverse a fold from its manifest. Null when refused or rolled back. */
export async function unfoldStashpadFolder(plugin: StashpadPlugin, srcRaw: string): Promise<UnfoldResult | null> {
  const app = plugin.app;
  const a = app.vault.adapter;
  const src = clean(srcRaw);
  const m = await readFoldManifest(plugin, src);
  const refusal = await unfoldRefusal(plugin, src, m);
  if (refusal || !m) { notify(refusal ?? "Can't unfold."); return null; }
  const { dest, shell, containerId } = m;
  const name = baseName(src);
  const safe = sanitizeManifest(m, src, dest, foldDirMap(plugin, m));
  const steps: UndoStep[] = [];
  const createdDirs: string[] = [];
  const problems: string[] = [];
  let noteCount = 0;
  let relocked = 0;
  const keyScanIf = async (folder: string): Promise<void> => {
    if (await a.exists(`${folder}/.stashkey`)) {
      try { await plugin.encryption.forceFullKeyScan(); } catch (e) { console.warn("[Stashpad] unfold: key re-scan failed", e); }
    }
  };
  const moveBack = async (fromPath: string, toPath: string, record: Array<{ from: string; to: string }>): Promise<void> => {
    const f = app.vault.getAbstractFileByPath(fromPath);
    if (!(f instanceof TFile)) return;
    await ensureFolder(app, toPath.slice(0, toPath.lastIndexOf("/")), createdDirs);
    const target = await uniqueFilePath(app, toPath);
    await app.fileManager.renameFile(f, target);
    record.push({ from: fromPath, to: target });
  };
  const fileMoves: Array<{ from: string; to: string }> = [];
  steps.push({ label: "remove the folders unfold made", run: () => removeEmptyFolders(app, createdDirs) });
  steps.push({
    label: "move files back into the destination",
    run: async () => {
      for (const mv of [...fileMoves].reverse()) {
        const f = app.vault.getAbstractFileByPath(mv.to);
        if (!(f instanceof TFile) || await a.exists(mv.from)) continue;
        await ensureFolder(app, mv.from.slice(0, mv.from.lastIndexOf("/")));
        await app.fileManager.renameFile(f, mv.from);
      }
    },
  });

  try {
    // ---- 1. The archived folder goes back to its old path ----------------
    await ensureFolder(app, src.split("/").slice(0, -1).join("/"), createdDirs);
    plugin.suppressFolderDelete(shell);
    await a.rename(shell, src);
    remapLockedRegistry(plugin, shell, src);
    await plugin.saveSettings();
    await keyScanIf(src);
    plugin.invalidateStashpadFoldersMemo();
    steps.push({
      label: "archive the folder again",
      critical: true,
      run: async () => {
        if (await a.exists(shell)) throw new Error(`“${shell}” exists again`);
        remapLockedRegistry(plugin, src, shell);
        await plugin.saveSettings();
        plugin.closeStashpadTabsFor(src);
        plugin.suppressFolderDelete(src);
        await a.rename(src, shell);
        await keyScanIf(shell);
        plugin.invalidateStashpadFoldersMemo();
      },
    });

    // ---- 2. Everything under the container comes back as the top level ----
    // From disk, not the metadata cache (cold right after a reload), so the
    // settings note is never mistaken for an ordinary note and moved back.
    let settingsId: unknown = null;
    if (safe.settingsNotePath) {
      const f = app.vault.getAbstractFileByPath(safe.settingsNotePath);
      if (f instanceof TFile) {
        try { settingsId = splitFrontmatter(await app.vault.read(f)).fm.id ?? null; } catch { /* unreadable */ }
        if (settingsId !== null) {
          const snap = await plugin.snapshotPaths([f.path]);
          await app.fileManager.trashFile(f);
          steps.push({ label: "bring the settings note back", run: () => plugin.restoreSnapshot(snap) });
        }
      }
    }
    const containerThere = (await readFolderSubtreeNodes(app, dest)).some((n) => String(n.id) === String(containerId));
    if (containerThere) {
      const r = await moveSubtreeToFolder(plugin, dest, containerId, src, { dissolveRoot: true, skipIds: settingsId !== null ? [String(settingsId)] : [] }, steps);
      noteCount = r.noteCount;
      relocked += r.relocked;
      problems.push(...r.left, ...r.plaintext);
      if (r.plaintext.length) notify(`⚠️ Unfold: ${r.plaintext.length} locked note${r.plaintext.length === 1 ? " is" : "s are"} now UNLOCKED in “${name}” — re-locking failed:\n${r.plaintext.join("\n")}`, { duration: 0 });
    } else {
      problems.push(`the “${name}” note in “${baseName(dest)}” is gone, so no notes came back`);
    }

    // ---- 3. Archive, trash, attachments, authors --------------------------
    const reparented: string[] = [];
    for (const d of safe.dirMap) {
      const isArchive = d.to.startsWith(`${dest}/archive/`);
      if (isArchive) {
        // Encrypted archive blobs re-lock under the old folder's key.
        for (const b of app.vault.getFiles().filter((f) => f.path.startsWith(`${d.to}/`) && f.extension === "stashenc")) {
          const rel = (b.parent?.path ?? d.to).slice(d.to.length);
          await ensureFolder(app, `${d.from}${rel}`, createdDirs);
          const r = await plugin.relockBundleInto(b.path, src, { reparentTo: ROOT_ID, blobFolder: `${d.from}${rel}` });
          if (r.status === "moved" && r.undo) { relocked++; steps.push({ label: `put “${b.basename}” back`, run: r.undo }); }
          else problems.push(`${b.basename}: ${r.reason}`);
        }
      }
      const before = fileMoves.length;
      for (const f of app.vault.getFiles().filter((x) => x.path.startsWith(`${d.to}/`) && (!isArchive || !isEncryptedFile(app, x)))) {
        await moveBack(f.path, `${d.from}/${f.path.slice(d.to.length + 1)}`, fileMoves);
      }
      if (!isArchive) continue;
      for (const mv of fileMoves.slice(before)) {
        if (!mv.to.endsWith(".md")) continue;
        const f = app.vault.getAbstractFileByPath(mv.to);
        if (!(f instanceof TFile)) continue;
        const { fm } = splitFrontmatter(await app.vault.read(f));
        if (String(fm.parent) !== String(containerId)) continue;
        await app.fileManager.processFrontMatter(f, (x) => { x.parent = ROOT_ID; });
        reparented.push(mv.to);
      }
    }
    steps.push({
      label: "point archived notes at the container again",
      run: async () => {
        for (const p of reparented) {
          const f = app.vault.getAbstractFileByPath(p);
          if (f instanceof TFile) await app.fileManager.processFrontMatter(f, (x) => { x.parent = containerId; });
        }
      },
    });
    for (const mv of safe.moved) {
      if (!mv.to.startsWith(`${dest}/_attachments/`) && !mv.to.startsWith(`${dest}/_authors/`)) continue;
      await moveBack(mv.to, mv.from, fileMoves);
    }

    // ---- 4. Bookkeeping ----------------------------------------------------
    // Placement and default folder as they were before the fold — only this
    // folder's, never a whole-list snapshot.
    if (m.placement && m.placement !== "normal" && plugin.folderPlacement(src) === "normal") {
      await plugin.setFolderPlacement(src, m.placement);
      steps.push({ label: "un-pin / un-hide it again", run: () => plugin.setFolderPlacement(src, "normal") });
    }
    if (m.wasDefault && clean(plugin.settings.folder || "") === dest) {
      plugin.settings.folder = src;
      await plugin.saveSettings();
      steps.push({ label: "point the default folder at the destination again", run: async () => { if (clean(plugin.settings.folder || "") === src) { plugin.settings.folder = dest; await plugin.saveSettings(); } } });
    }
    const redirect = plugin.settings.foldedFolders?.[src];
    const r2 = { ...(plugin.settings.foldedFolders ?? {}) };
    delete r2[src];
    plugin.settings.foldedFolders = r2;
    await plugin.saveSettings();
    steps.push({
      label: "restore the link redirect",
      run: async () => {
        if (!redirect) return;
        plugin.settings.foldedFolders = { ...(plugin.settings.foldedFolders ?? {}), [src]: redirect };
        await plugin.saveSettings();
      },
    });
    // Keep the manifest as a record, renamed so it isn't read as a live fold.
    const done = `${src}/${FOLD_MANIFEST.replace(/\.json$/, ".unfolded.json")}`;
    try {
      if (await a.exists(`${src}/${FOLD_MANIFEST}`)) {
        await a.rename(`${src}/${FOLD_MANIFEST}`, done);
        steps.push({ label: "restore the fold manifest", run: async () => { if (await a.exists(done)) await a.rename(done, `${src}/${FOLD_MANIFEST}`); } });
      }
    } catch (e) { console.warn("[Stashpad] unfold: couldn't rename the manifest", e); }
    // The from-<name> folders, once empty.
    await removeEmptyFolders(app, safe.dirMap.map((d) => d.to));
    await removeEmptyFolders(app, [...new Set(safe.moved.map((x) => x.to.slice(0, x.to.lastIndexOf("/"))))]);

    plugin.invalidateStashpadFoldersMemo();
    plugin.refreshOpenViewsForFolder(dest);
    plugin.refreshOpenViewsForFolder(src);
    let undone = false;
    return {
      noteCount, relocked, problems,
      undo: async () => {
        if (undone) { notify(`The unfold of “${name}” was already undone.`); return; }
        // Still THIS unfold? A re-fold or a new folder at the archived path since
        // then makes the steps below wrong.
        const live = await a.exists(src) && !(await a.exists(shell)) && !plugin.settings.foldedFolders?.[src];
        undone = true;
        if (!live) { notify(`Nothing to undo: “${name}” was folded again or changed since this unfold.`); return; }
        const { failed, aborted } = await runUndoSteps(steps);
        plugin.invalidateStashpadFoldersMemo();
        plugin.refreshOpenViewsForFolder(dest);
        notify(aborted
          ? `Stopped folding “${name}” back in: ${failed[failed.length - 1]} failed, and the rest depends on it — see the console.`
          : failed.length ? `Folded “${name}” back in, but some steps failed (${failed.join(", ")}) — see the console.` : `“${name}” is folded into “${baseName(dest)}” again.`);
      },
    };
  } catch (e) {
    console.error("[Stashpad] unfold failed — rolling back", e);
    const { failed } = await runUndoSteps(steps);
    plugin.invalidateStashpadFoldersMemo();
    plugin.refreshOpenViewsForFolder(dest);
    notify(`Couldn't unfold “${name}”: ${(e as Error).message}. ${failed.length ? `Rolling back also hit problems (${failed.join(", ")}) — see the console.` : "Nothing was changed."}`, { duration: 0 });
    return null;
  }
}

/** Pick one of the folded folders (Sift-matched). */
class FoldedFolderModal extends SuggestModal<string> {
  constructor(app: App, private plugin: StashpadPlugin, private only: string | null, private onPick: (src: string) => void) {
    super(app);
    this.setPlaceholder("Unfold which folder?");
  }
  getSuggestions(query: string): string[] {
    const q = query.trim();
    return Object.entries(this.plugin.settings.foldedFolders ?? {})
      .filter(([, f]) => !this.only || clean(f.into) === this.only)
      .map(([src]) => src)
      .filter((src) => !q || siftMatch(q, src));
  }
  renderSuggestion(src: string, el: HTMLElement): void {
    const f = this.plugin.settings.foldedFolders?.[src];
    el.createDiv({ text: baseName(src) });
    if (f) el.createEl("small", { text: `folded into ${baseName(f.into)} · ${new Date(f.at).toLocaleDateString()}` });
  }
  onChooseSuggestion(src: string): void { this.onPick(src); }
}

/** Entry point: pick (unless given) → confirm → unfold → notify with Undo / Open.
 *  `into` limits the picker to folders folded into that folder. */
export async function runUnfoldFlow(plugin: StashpadPlugin, srcRaw?: string, into?: string): Promise<void> {
  const go = async (src: string): Promise<void> => {
    const m = await readFoldManifest(plugin, src);
    const refusal = await unfoldRefusal(plugin, src, m);
    if (refusal || !m) { notify(refusal ?? "Can't unfold."); return; }
    const name = baseName(src);
    new ConfirmModal(
      plugin.app,
      `Unfold “${name}” out of “${baseName(m.dest)}”?`,
      `Everything under the “${name}” note in **${baseName(m.dest)}** — including notes added since — moves back into its own folder, **${src}**, as its top level.\n`
        + `Its archive, trash, attachments and locked notes come back too (locked notes re-lock with ${name}'s key; you may be asked for passwords).\n`
        + "You can undo this.",
      "Unfold",
      (ok) => {
        if (!ok) return;
        void (async () => {
          const res = await unfoldStashpadFolder(plugin, src);
          if (!res) return;
          plugin.getUndoStack(src).push({ label: `Unfold “${name}”`, undo: res.undo });
          plugin.notifications.show({
            message: `Unfolded **${name}** — ${res.noteCount} note${res.noteCount === 1 ? "" : "s"} back in their own folder.`
              + (res.relocked ? ` ${res.relocked} locked note${res.relocked === 1 ? "" : "s"} re-locked with its key.` : "")
              + (res.problems.length ? ` Notes: ${res.problems.join("; ")}.` : ""),
            kind: res.problems.length ? "warning" : "success", category: "move", folder: src, duration: 0,
            actions: [
              { label: "Undo", onClick: () => void res.undo() },
              { label: "Open", onClick: () => void plugin.activateViewForFolder(src) },
            ],
          });
          void plugin.activateViewForFolder(src);
        })();
      },
    ).open();
  };
  if (srcRaw) { await go(clean(srcRaw)); return; }
  const entries = Object.entries(plugin.settings.foldedFolders ?? {}).filter(([, f]) => !into || clean(f.into) === clean(into));
  if (!entries.length) { notify(into ? `Nothing has been folded into “${baseName(into)}”.` : "No folded folders to unfold."); return; }
  new FoldedFolderModal(plugin.app, plugin, into ? clean(into) : null, (s) => void go(s)).open();
}

// ------------------------------------------------------------ Split out ----

/** A folder name from a note's first line: markdown/heading marks and
 *  characters a path can't hold are dropped; empty → "Split note". */
function folderNameFromTitle(body: string): string {
  const first = (body.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").replace(/[*_`~[\]]/g, "");
  const cleanName = first.replace(/[\\/:*?"<>|#^]/g, " ").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 80).trim();
  return cleanName || "Split note";
}

/** Ask for the new folder's name (prefilled from the note's title). */
class SplitOutModal extends Modal {
  private name: string;
  constructor(
    app: App, private from: string, private title: string, private counts: { children: number; locked: number },
    private onSubmit: (name: string) => void,
  ) {
    super(app);
    this.name = title;
  }
  onOpen(): void {
    this.modalEl.addClass("stashpad-compact-modal");
    this.titleEl.setText(`Split “${this.title}” out into its own folder?`);
    const c = this.contentEl;
    c.empty();
    const parent = this.from.includes("/") ? this.from.slice(0, this.from.lastIndexOf("/")) : "";
    c.createEl("p", { text: `A new Stashpad folder is made next to “${baseName(this.from)}”${parent ? ` (in ${parent})` : " (at the vault root)"}. The note's ${this.counts.children} child note${this.counts.children === 1 ? "" : "s"} become its top level, and the note's own text goes on its Home.` });
    if (this.counts.locked) {
      c.createEl("p", { cls: "mod-warning", text: `${this.counts.locked} locked note${this.counts.locked === 1 ? "" : "s"} under it stay in “${baseName(this.from)}”: the new folder has no encryption key yet.` });
    }
    let submit = (): void => {};
    new Setting(c).setName("Folder name").addText((t) => {
      t.setValue(this.name).onChange((v) => { this.name = v; });
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
      window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
    });
    c.createEl("p", { text: "You can undo this.", cls: "setting-item-description" });
    submit = () => {
      const n = this.name.replace(/[\\/:*?"<>|#^]/g, " ").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
      if (!n) { notify("Give the folder a name."); return; }
      this.close();
      this.onSubmit(n);
    };
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Split out").setCta().onClick(() => submit()));
  }
  onClose(): void { this.contentEl.empty(); }
}

export interface SplitOutResult { folder: string; noteCount: number; problems: string[]; undo: () => Promise<void> }

/** Move note `noteId` of `from` into a NEW Stashpad folder `target` (a path):
 *  its children become the top level, its own text goes on the new Home, and
 *  the note itself goes to the trash. Undo moves everything back and parks the
 *  new folder in the vault's .trash. Null when refused or rolled back. */
export async function splitNoteOut(plugin: StashpadPlugin, fromRaw: string, noteId: StashpadId, target: string): Promise<SplitOutResult | null> {
  const app = plugin.app;
  const a = app.vault.adapter;
  const from = clean(fromRaw);
  if (await a.exists(target)) { notify(`“${target}” already exists — pick another name.`); return null; }
  const file = plugin.resolveNoteFileInFolder(from, noteId) ?? await plugin.findNoteFileOnDisk(from, noteId);
  if (!file) { notify("That note isn't in the folder any more."); return null; }
  const noteBody = splitFrontmatter(await app.vault.read(file)).body.replace(/\s+$/, "");
  const steps: UndoStep[] = [];
  let created: string;
  try {
    created = (await plugin.createNewStashpad(target)).folder;
  } catch (e) { notify(`Couldn't create “${target}”: ${(e as Error).message}`); return null; }
  // createNewStashpad can REDIRECT a refused name (e.g. to the vault root, or to
  // an existing Stashpad there). Never move notes into — or, on undo, park in
  // the trash — a folder this split didn't just make at the asked-for path.
  if (clean(created) !== clean(target)) {
    notify(`Couldn't make “${target}” (it would have become “${created}”), so nothing was split out.`);
    return null;
  }
  steps.push({
    label: "park the new folder in the trash",
    run: async () => {
      // Only an empty shell (Home + sidecars) is parked. If notes are still in
      // it — moving them back failed, or new ones were added since — leave it.
      const notes = app.vault.getFiles().filter((f) => f.path.startsWith(`${created}/`) && f.extension === "md"
        && f.parent?.path === created && f.name !== buildHomeFilename(created));
      if (notes.length) throw new Error(`“${created}” still has ${notes.length} note${notes.length === 1 ? "" : "s"} in it, so it was left in place`);
      plugin.closeStashpadTabsFor(created);
      plugin.suppressFolderDelete(created);
      plugin.knownStashpadFolders.delete(created);
      await ensureFolder(app, ".trash");
      const dest = await uniqueFilePath(app, `.trash/${baseName(created)}`);
      await a.rename(created, dest);
      plugin.invalidateStashpadFoldersMemo();
    },
  });
  try {
    // The note's own text becomes the new folder's Home body.
    if (noteBody) {
      const homePath = `${created}/${buildHomeFilename(created)}`;
      const home = app.vault.getAbstractFileByPath(homePath);
      if (home instanceof TFile) {
        const { fm } = splitFrontmatter(await app.vault.read(home));
        await app.vault.modify(home, serializeNote(fm, `${noteBody}\n`));
      }
    }
    const r = await moveSubtreeToFolder(plugin, from, noteId, created, { dissolveRoot: true }, steps);
    const problems = [...r.left, ...r.plaintext];
    if (r.plaintext.length) notify(`⚠️ Split: ${r.plaintext.length} locked note${r.plaintext.length === 1 ? " is" : "s are"} now UNLOCKED in “${baseName(created)}” — re-locking failed:\n${r.plaintext.join("\n")}`, { duration: 0 });
    plugin.invalidateStashpadFoldersMemo();
    plugin.refreshOpenViewsForFolder(from);
    let undone = false;
    return {
      folder: created, noteCount: r.noteCount, problems,
      undo: async () => {
        if (undone) { notify("That split was already undone."); return; }
        undone = true;
        if (!(await a.exists(created))) { notify(`Nothing to undo: “${baseName(created)}” was moved or deleted since.`); return; }
        const { failed } = await runUndoSteps(steps);
        plugin.invalidateStashpadFoldersMemo();
        plugin.refreshOpenViewsForFolder(from);
        notify(failed.length ? `Undid the split, but some steps failed (${failed.join(", ")}) — see the console.` : `Undid the split: the notes are back in “${baseName(from)}”.`);
      },
    };
  } catch (e) {
    console.error("[Stashpad] split out failed — rolling back", e);
    const { failed } = await runUndoSteps(steps);
    plugin.refreshOpenViewsForFolder(from);
    notify(`Couldn't split it out: ${(e as Error).message}. ${failed.length ? `Rolling back also hit problems (${failed.join(", ")}).` : "Nothing was changed."}`, { duration: 0 });
    return null;
  }
}

/** Entry point from the note menus / command: name prompt → split → setup
 *  modal (unless turned off) → notification with Undo / Open. */
export async function runSplitOutFlow(plugin: StashpadPlugin, fromRaw: string, noteId: StashpadId): Promise<void> {
  const app = plugin.app;
  const from = clean(fromRaw);
  const file = plugin.resolveNoteFileInFolder(from, noteId) ?? await plugin.findNoteFileOnDisk(from, noteId);
  if (!file) { notify("That note isn't in the folder any more."); return; }
  const body = splitFrontmatter(await app.vault.read(file)).body;
  const title = folderNameFromTitle(body);
  const nodes = await readFolderSubtreeNodes(app, from);
  const ids = subtreeIds(nodes, noteId);
  const children = nodes.filter((n) => String(n.parent) === String(noteId)).length;
  let locked = 0;
  for (const b of app.vault.getFiles().filter((f) => f.parent?.path === from && f.extension === "stashenc")) {
    const meta = await readLockedMeta(app, b.path);
    if (meta?.parentId && ids.has(String(meta.parentId))) locked++;
  }
  new SplitOutModal(app, from, title, { children, locked }, (name) => void (async () => {
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const target = parent ? `${parent}/${name}` : name;
    const res = await splitNoteOut(plugin, from, noteId, target);
    if (!res) return;
    plugin.getUndoStack(from).push({ label: `Split “${name}” out`, undo: res.undo });
    plugin.notifications.show({
      message: `Split **${name}** out into its own folder — ${res.noteCount} note${res.noteCount === 1 ? "" : "s"} moved.`
        + (res.problems.length ? ` Stayed behind: ${res.problems.join("; ")}.` : ""),
      kind: res.problems.length ? "warning" : "success", category: "move", folder: from, duration: 0,
      actions: [
        { label: "Undo", onClick: () => void res.undo() },
        { label: "Open", onClick: () => void plugin.activateViewForFolder(res.folder) },
      ],
    });
    await plugin.activateViewForFolder(res.folder);
    if (plugin.settings.folderSetupOnCreate !== false) {
      openFolderSetup(plugin, res.folder, { mode: "new", intro: `Split out from “${baseName(from)}”.` });
    }
  })()).open();
}
