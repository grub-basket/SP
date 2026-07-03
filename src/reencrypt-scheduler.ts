import { MarkdownView, Notice, TFile } from "obsidian";
import type StashpadPlugin from "./main";
import type { ReEncryptWatchEntry } from "./settings";

/** 0.139.0 (Q5 "peek"): after a configurable idle time, an unlocked
 *  previously-encrypted subtree is QUEUED to be re-encrypted — with a visible,
 *  cancellable countdown. This deliberately revives a form of the removed idle
 *  auto-lock, so it's hedged with hard safeguards:
 *   - OPT-IN, default off. Delay resolves per-note → per-folder → global; 0/undef = off.
 *   - NEVER fires while the note is OPEN in an editor or was edited very recently.
 *   - Always a "Re-encrypting in Ns… [Keep unlocked]" countdown the user can cancel.
 *   - Cancelling (or editing) re-arms; the entry stays on the watchlist either way.
 *  Granularity is per-subtree (rootId), matching the watchlist. */
export class ReEncryptScheduler {
  private tick: number | null = null;
  /** folder → last activity ms (a modify/open in that folder re-arms its timers). */
  private lastTouch = new Map<string, number>();
  /** key `${folder} ${rootId}` currently showing a countdown — don't double-fire. */
  private counting = new Set<string>();
  private static readonly COUNTDOWN_SECS = 10;
  private static readonly RECENT_EDIT_MS = 20_000; // treat a just-edited folder as active

  constructor(private plugin: StashpadPlugin) {}

  private key(folder: string, rootId: string): string { return `${folder} ${rootId}`; }

  /** Resolve the idle delay (minutes) for one entry: per-note > per-folder >
   *  global. 0 or undefined = feature off for that entry. */
  private delayMin(e: ReEncryptWatchEntry): number {
    const perNote = e.peekMin;
    if (perNote != null) return perNote;
    const fp = (this.plugin.settings.folderEncPrefs ?? {})[e.folder.replace(/\/+$/, "")];
    const perFolder = fp?.reEncryptAfterMin;
    if (perFolder != null) return perFolder;
    return this.plugin.settings.reEncryptAfterMin ?? 0;
  }

  /** Any peek delay configured anywhere? If not, the interval stays off. */
  private anyArmed(): boolean {
    if ((this.plugin.settings.reEncryptAfterMin ?? 0) > 0) return true;
    for (const p of Object.values(this.plugin.settings.folderEncPrefs ?? {})) if ((p?.reEncryptAfterMin ?? 0) > 0) return true;
    return this.plugin.reEncryptWatching().some((e) => (e.peekMin ?? 0) > 0);
  }

  /** Register vault/workspace listeners + the poll. Call once from onload. */
  start(): void {
    const touch = (folder: string) => { if (folder) this.lastTouch.set(folder.replace(/\/+$/, ""), Date.now()); };
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", (f) => { if (f instanceof TFile) touch(f.parent?.path ?? ""); }));
    this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", (f) => { if (f) touch(f.parent?.path ?? ""); }));
    // Poll every 30s — cheap, and only does work when a delay is configured.
    this.tick = window.setInterval(() => void this.poll(), 30_000);
    this.plugin.registerInterval(this.tick);
  }

  /** A markdown file for this subtree's folder is open+visible → treat as busy.
   *  Coarse (folder-level, not exact-subtree) on purpose — err toward NOT
   *  re-encrypting something the user might be looking at. */
  private folderHasOpenEditor(folder: string): boolean {
    const clean = folder.replace(/\/+$/, "");
    let open = false;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file && (v.file.parent?.path?.replace(/\/+$/, "") ?? "") === clean) open = true;
    });
    return open;
  }

  /** The re-lock key is already in memory (so re-encrypting won't PROMPT).
   *  Never fire a timer that would surprise the user with a password box. */
  private keyReady(folder: string): boolean {
    const enc = this.plugin.encryption;
    if (!enc?.isConfigured?.()) return false;
    return enc.hasOwnFolderKey(folder) ? enc.isFolderUnlocked(folder) : enc.isUnlocked();
  }

  private async poll(): Promise<void> {
    if (!this.anyArmed()) return;
    const now = Date.now();
    for (const e of this.plugin.reEncryptWatching()) {
      const mins = this.delayMin(e);
      if (mins <= 0) continue;
      const folder = e.folder.replace(/\/+$/, "");
      const k = this.key(folder, e.rootId);
      if (this.counting.has(k)) continue;
      const base = Math.max(Date.parse(e.unlockedAt) || 0, this.lastTouch.get(folder) ?? 0);
      if (now < base + mins * 60_000) continue;                 // still within idle window
      if (!this.keyReady(folder)) continue;                     // locked — never prompt on a timer
      if (this.folderHasOpenEditor(folder)) { touchFolder(this.lastTouch, folder, now); continue; } // busy — defer
      void this.countdownThenLock(e, k);
    }
  }

  /** Live countdown intervals, so dispose() can clear them on unload. */
  private countdownTimers = new Set<number>();

  private countdownThenLock(e: ReEncryptWatchEntry, k: string): void {
    this.counting.add(k);
    const folder = e.folder.replace(/\/+$/, "");
    const title = e.title || "a note";
    const startedAt = Date.now();
    let left = ReEncryptScheduler.COUNTDOWN_SECS;
    let cancelled = false;
    const note = new Notice("", 0);
    const finish = () => { window.clearInterval(iv); this.countdownTimers.delete(iv); note.hide(); this.counting.delete(k); };
    const abortReArm = () => { this.lastTouch.set(folder, Date.now()); finish(); };
    const render = () => {
      note.noticeEl.empty();
      note.noticeEl.createSpan({ text: `🔒 Re-encrypting “${title}” in ${left}s… ` });
      note.noticeEl.createEl("button", { text: "Keep unlocked" }).onclick = () => { cancelled = true; abortReArm(); };
    };
    render();
    const iv = window.setInterval(async () => {
      if (cancelled) return;
      // 0.140.1: a modify/open in the folder DURING the countdown re-arms and
      // aborts (the header promised "editing re-arms" — the old code ignored it).
      if ((this.lastTouch.get(folder) ?? 0) > startedAt) { abortReArm(); return; }
      left -= 1;
      if (left > 0) { render(); return; }
      finish();
      // Still applicable? (re-locked/deleted during the countdown.)
      if (!this.plugin.reEncryptWatching().some((w) => w.folder === e.folder && w.rootId === e.rootId)) return;
      if (this.folderHasOpenEditor(folder)) { this.lastTouch.set(folder, Date.now()); return; } // opened it mid-countdown → abort
      // 0.140.1: re-check the key is STILL in memory — never pop a password
      // modal from a background timer (it may have locked during the countdown).
      if (!this.keyReady(folder)) { this.lastTouch.set(folder, Date.now()); return; }
      const ok = await this.plugin.lockNoteSubtree(e.folder, e.rootId as unknown as import("./types").StashpadId, null, { silent: true });
      if (ok) new Notice(`Re-encrypted “${title}”.`);
    }, 1000);
    // 0.140.1: track so dispose() clears it — a raw setInterval survived plugin
    // unload and wrote stale settings over the reloaded instance.
    this.countdownTimers.add(iv);
    this.plugin.registerInterval(iv);
  }

  /** Called from the plugin's onunload — stop any in-flight countdown so it
   *  can't fire lockNoteSubtree/saveSettings on a dead instance. */
  dispose(): void {
    for (const iv of this.countdownTimers) window.clearInterval(iv);
    this.countdownTimers.clear();
    this.counting.clear();
  }
}

function touchFolder(map: Map<string, number>, folder: string, when: number): void {
  map.set(folder.replace(/\/+$/, ""), when);
}
