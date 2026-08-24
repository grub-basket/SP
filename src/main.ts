import { Notice, Platform, Plugin, SuggestModal, FuzzySuggestModal, TFile, TFolder, WorkspaceLeaf, apiVersion, setIcon, debounce, type App } from "obsidian";
import { SIBLINGS_KEY, wikilinkName } from "./sheets-versions";
import { freshId } from "./id-service";
import { STASHPAD_DETAIL_VIEW_TYPE, STASHPAD_FOLDER_PANEL_VIEW_TYPE, STASHPAD_PANELS_VIEW_TYPE, STASHPAD_VIEW_TYPE, parseAuthorRef, toAttachmentLink, isInReservedSubfolder, isArchiveSubfolderPath, archiveSubfolderOf, type PinnedNoteRef, type StashpadId , isReservedSubfolderName} from "./types";
import { StashpadDetailView, openStashpadDetailView } from "./detail-view";
import { StashpadView, properCaseFolderPath, DeletedTrashSuggestModal } from "./view";
import { StashpadTrashView, openTrashView } from "./trash-view";
import { ReEncryptScheduler } from "./reencrypt-scheduler";
import { StashpadAggregateView, openAggregateView } from "./aggregate-view";
import { cmdExportLockedBlob } from "./commands/io-cmds";
import { STASHPAD_TRASH_VIEW_TYPE, STASHPAD_AGGREGATE_VIEW_TYPE, RESERVED_FRONTMATTER } from "./types";
import { StashpadPanelsView, openStashpadPanelsView, PANEL_REGISTRY, type PanelId } from "./panels-view";
import { TaskReviewModal } from "./task-review-modal";
import { StashpadFolderPanelView, openFolderPanelView } from "./folder-panel-view";
import { EncryptionService, defaultEncryptionConfig } from "./encryption-service";
import { lockSubtree, unlockBundle, readLockedMeta, type LockResult, deleteEncryptSubtree, restoreDeleted, listDeletedBlobs, readDeletedMeta, deletedRestoreDest, restoreRawTrash, purgeDeletedBlob, OBSIDIAN_TRASH_DIR, type DeletedMeta, collectSubtree, trashSubfolderOf, lockRawFolder, unlockRawFolder, rawFolderBlobIn, listRawFolderBlobs, deletePlaintextSubtree, restorePlaintextDeleted, listPlaintextTrashBundles, STASHPACK_EXT } from "./encryption-ops";
import { EncryptionPasswordModal, ConfirmModal, ReEncryptReviewModal, OpenDeepLinkModal, NoteWorkbenchView, WORKBENCH_VIEW_TYPE, type WorkbenchCommandCallbacks, type WorkbenchState , DuplicateIdsModal, type DuplicateIdGroup} from "./modals";
import { WelcomeModal, shouldShowWelcome, DEFAULT_STASHPAD_FOLDER, type OnboardingChoice } from "./onboarding";
import { seedDemoContent } from "./demo-content";
import { writeClipboardText } from "./cross-vault-clipboard";
import {
  DEFAULT_SETTINGS, StashpadSettings, StashpadSettingTab, setSettings, SETTINGS_TABS,
  buildDefaultBindings, COMMAND_META, type CommandBindingMap,
} from "./settings";
import { DEFAULT_STOPWORDS, bodyToSlug, buildFilename, buildAttachmentName, parseLegacyAttachmentPrefix, parseIdFromFilename, isNoteId } from "./slug-service";
import { getActiveView, onActiveViewChange } from "./active-view";
import { importStashZip, buildStashZip, resolveNoteAttachmentFiles, STASH_EXT, splitFrontmatter } from "./stash-package";
import { writeXvClipboard, readXvAck, XV_MAX_BYTES } from "./cross-vault-clipboard";
import { ensureOkfTemplate, okfFolders, rebuildOkfForFolder, OKF_DEFAULT_TEMPLATE_PATH } from "./okf";
import { buildOkfBundleFiles, zipBundle, tarGzBundle } from "./okf-export";
import { formatDateTime } from "./format";
import { resolveStashBytes, isEncryptedStash } from "./stash-crypto";
import { StashpadLog } from "./log";
import { parseRunActions, parseStashpadLink, STASHPAD_PROTOCOL_ACTION } from "./deep-link";
import { ROOT_ID, parseAssignees } from "./types";
import { parseRecurrence, nextDueOnComplete, parseDuration, parseRepeatMode } from "./recurrence";
import { spawnNextOccurrence, claimOccurrenceMissed } from "./recurrence-spawn";
import { OrderStore } from "./order-store";
import { StructureSnapshotStore, indexByPath, parentForFrontmatter } from "./structure-snapshot";
import { UndoStack } from "./undo-stack";
import { rebootstrapFolderFrontmatter } from "./frontmatter-sync";
import { createAliasesForFolder } from "./alias-service";
import { NotificationService, buildFileActions, boldFragment, type NotificationAction } from "./notifications";
/** Where quick-switcher shortcut stubs live. One folder so they never mix
 *  with real notes and are trivial to delete en masse. */
const SHORTCUT_DIR = "Stashpad Shortcuts";

import { PreviewCache } from "./link-preview/store";
import { enrichFile, scanBackfill, estimateSeconds, humanDuration } from "./link-preview/service";
import { AuthorRegistry } from "./author-registry";
import { ImportService } from "./import-service";
import { ImportLog } from "./import-log";
import { perf } from "./perf";
import { RenderCacheStore } from "./render-cache-store";
import { SettingsStore, MOVED_KEYS } from "./settings-store";
import { TEXT_IMPORT_VIEW_TYPE, TextImportView, type ImporterViewContext } from "./text-import-modal";
import { APP_IMPORT_VIEW_TYPE, AppImportView, type AppImporterViewContext } from "./stashpad-app-import-modal";
import { settleNewTab, buildHomeFilename } from "./view-helpers";
import { resolveObscureAll } from "./obscure-scope";

/** 0.89.1: localStorage key — set right before an update-triggered app reload so
 *  the next load knows to un-ghost the deferred Stashpad tabs. */
const UNGHOST_FLAG = "stashpad:unghost-after-reload";

/** A captured file's content, for snapshot-backed undo/redo of file operations. */
interface FileSnapshot { path: string; binary: boolean; text?: string; data?: ArrayBuffer; }

/** 0.174.0: picker shown when several Stashpad notes embed the same attachment —
 *  choose which parent note to open. Label = the note's first heading (or a
 *  de-slugged basename) + its folder. */
class AttachmentParentPicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private notes: TFile[], private onChoose: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Multiple notes attach this file — pick one to open");
  }
  getItems(): TFile[] { return this.notes; }
  getItemText(f: TFile): string {
    const heading = this.app.metadataCache.getFileCache(f)?.headings?.[0]?.heading;
    const title = (heading || f.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ")).trim();
    const folder = f.parent?.path ?? "";
    return folder ? `${title} — ${folder}` : title;
  }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

export default class StashpadPlugin extends Plugin {
  settings: StashpadSettings = { ...DEFAULT_SETTINGS };
  private reEncryptScheduler: ReEncryptScheduler | null = null;
  /** Dedup-at-creation index: every note id currently in the vault. Built lazily
   *  on the first mintNoteId(), then kept current by the metadataCache `changed`
   *  handler in onload — so minting never scans the vault per call, and stays
   *  correct as notes sync in from other devices. */
  private usedNoteIds: Set<string> | null = null;
  /** 0.108.2: in-memory debug trace ring buffer. Populated by trace() only
   *  when settings.debugTrace is on; copied out from the Diagnostics tab.
   *  Purely local — no network, no file writes. Capped so a long session
   *  can't grow it unbounded. */
  private debugBuffer: string[] = [];
  /** 0.268.14: raised with the wider instrumentation. More lines per second
   *  means a 300-line window covered less wall-clock time, and the interesting
   *  moment is always the one that just scrolled out. */
  private static readonly DEBUG_BUFFER_MAX = 900;
  /** Record a structured diagnostic line. No-op (and zero cost beyond the
   *  flag check) unless debug tracing is enabled. Hard to misuse: data is
   *  JSON-stringified defensively so a circular/huge value can't throw out
   *  of a hot path. */
  trace(category: string, data?: Record<string, unknown>): void {
    if (!this.settings.debugTrace) return;
    let payload = "";
    if (data) { try { payload = " " + JSON.stringify(data); } catch { payload = " [unserializable]"; } }
    // performance.now() is monotonic and devtools-free — fine on mobile.
    const t = Math.round(performance.now());
    // 0.267.10: collapse an identical repeat into a count.
    //
    // With three Stashpad tabs open, one change event produced three IDENTICAL
    // render:sched lines at the same millisecond — one per view — and they
    // crowded the 300-line buffer with no information in them. Collapsing keeps
    // the same history in fewer lines, which means more of the useful past
    // survives AND less text to hand to the clipboard, which on iOS is a slow
    // bridge call that scales with payload.
    //
    // Compared on category + payload only, deliberately: the timestamps differ
    // by a millisecond or two and that is exactly the difference worth losing.
    const line = `${category}${payload}`;
    const prev = this.debugBuffer[this.debugBuffer.length - 1];
    if (prev !== undefined) {
      const bare = prev.replace(/^\+\d+ms /, "").replace(/ \(x\d+\)$/, "");
      if (bare === line) {
        const seen = /\(x(\d+)\)$/.exec(prev);
        const n = seen ? Number(seen[1]) + 1 : 2;
        this.debugBuffer[this.debugBuffer.length - 1] =
          prev.replace(/ \(x\d+\)$/, "") + ` (x${n})`;
        return;
      }
    }
    // Remember what ran last, for the stall watchdog's `after`. A stall line
    // must not become its own antecedent, or a run of them reports "after
    // stall" and loses the thing that actually preceded the freeze.
    if (category !== "stall") this.lastTraceCategory = category;
    this.debugBuffer.push(`+${t}ms ${line}`);
    if (this.debugBuffer.length > StashpadPlugin.DEBUG_BUFFER_MAX) {
      this.debugBuffer.splice(0, this.debugBuffer.length - StashpadPlugin.DEBUG_BUFFER_MAX);
    }
    // 0.268.12: a "…-begin" marker says a risky operation is STARTING, and if
    // that operation is what hangs, every ASYNC route to disk is already lost —
    // the vault adapter's write returns a promise, and a synchronous freeze
    // never yields to run it. Measured: calling the flush here and then blocking
    // for nine seconds left the marker absent from the file the whole time.
    //
    // localStorage.setItem is the one store that is synchronous, so it has
    // finished before the freezing code gets its next statement. That is the
    // only evidence a terminal freeze can leave, and it is what makes "began X,
    // never finished" readable after a force-quit. Folded into the previous
    // session's trace on the next load.
    // 0.268.14: mirror synchronously on a THROTTLE, not only on "-begin".
    //
    // Every async route to disk is lost to a synchronous freeze, so whatever the
    // sync mirror last held is the entire record of a terminal hang. Firing it
    // only on "-begin" meant the blind spot was "everything since the last risky
    // operation started", which in practice was the whole interesting stretch.
    // Now the blind spot is bounded by the throttle instead: at most ~250ms of
    // lines can be lost, whatever was happening.
    //
    // Throttled rather than per-line because setItem is synchronous: doing it on
    // every line during a render storm would add its cost to the very thing
    // being measured, which is how a diagnostic starts lying.
    // 0.268.18: with persistence off, tracing touches NOTHING on disk — no
    // timer is even scheduled. The buffer is still fully populated and both
    // copy commands still work; only surviving a crash is given up.
    if (this.settings.debugTracePersist) {
      const now = performance.now();
      if (category.endsWith("-begin") || now - this.lastSyncMirrorAt >= StashpadPlugin.TRACE_SYNC_MIRROR_MS) {
        this.lastSyncMirrorAt = now;
        this.mirrorTraceSync();
      }
      this.scheduleTraceFlush();
    }
  }

  /** 0.268.8: mirror the ring buffer to disk so a trace survives a force-quit.
   *
   *  The buffer is memory-only, which is fine for a bug you can click away from
   *  and lose for one that HANGS the window — the case this was added for. If
   *  the app has to be killed, the only copy goes with it.
   *
   *  Two properties matter, and they pull against each other:
   *
   *   - The write must not land in the hot path. Tracing happens inside the very
   *     renders under investigation, so a write per line would change what we
   *     are trying to measure. Hence a debounced flush, fire-and-forget.
   *   - The flush must run BEFORE the freeze, not after. A hang blocks the main
   *     thread, so nothing scheduled during it will run. A short debounce is
   *     what makes the lines leading UP TO the hang land — which is exactly the
   *     part worth keeping. The last second or so before a hang may be lost;
   *     everything before it is not.
   *
   *  Kept out of the vault proper (it lives beside data.json in the plugin dir)
   *  so it never shows up as a note, and deliberately NOT one of the store's
   *  watched paths, so writing it cannot trigger the external-settings reload. */
  private static readonly TRACE_FILE = "debug-trace.log";
  private static readonly TRACE_PREV_FILE = "debug-trace.prev.log";
  private static readonly TRACE_FLUSH_MS = 1000;
  private traceFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** False until this session has moved the previous session's file aside.
   *  Gates every write — see flushTraceToDisk. */
  private traceRotateDone = false;

  /** Null when the plugin directory is unknown. Falling back to "" would resolve
   *  to the VAULT ROOT and drop a stray log file among the user's notes — a
   *  diagnostic must never litter the vault it is diagnosing. Every caller
   *  treats null as "skip", so the feature simply does nothing in that case. */
  private tracePath(prev = false): string | null {
    const dir = this.manifest?.dir;
    if (!dir) return null;
    return `${dir}/${prev ? StashpadPlugin.TRACE_PREV_FILE : StashpadPlugin.TRACE_FILE}`;
  }

  /** Synchronous mirror, for the one case an async write cannot cover. Capped
   *  because localStorage is a shared, quota-limited store and a diagnostic has
   *  no business filling it; the tail is the part that matters anyway. */
  private static readonly TRACE_LS_KEY = "stashpad:debug-trace-sync";
  private static readonly TRACE_LS_MAX_LINES = 250;
  private static readonly TRACE_SYNC_MIRROR_MS = 250;
  private lastSyncMirrorAt = -1e9;

  /** 0.268.14: a synchronous "still running" stamp, separate from the buffer
   *  mirror and deliberately tiny so it can be written on every watchdog tick.
   *
   *  It answers the one question a terminal freeze otherwise destroys: WHEN did
   *  the main thread stop. The trace's last line only says when something last
   *  happened to be traced, which can be long before the hang; the gap between
   *  the final heartbeat and that line is the difference between "it hung doing
   *  X" and "it hung a while after X, doing something we never instrumented".
   *  Resolution is the watchdog tick, 250ms. */
  private static readonly TRACE_LS_HEARTBEAT_KEY = "stashpad:debug-trace-heartbeat";
  private beatSync(): void {
    if (!this.settings.debugTrace || !this.settings.debugTracePersist) return;
    try {
      localStorage.setItem(StashpadPlugin.TRACE_LS_HEARTBEAT_KEY, JSON.stringify({
        at: Math.round(performance.now()),
        after: this.lastTraceCategory || "?",
        focused: !document.hidden && document.hasFocus(),
      }));
    } catch { /* quota or unavailable */ }
  }

  private takeHeartbeat(): string {
    try {
      const v = localStorage.getItem(StashpadPlugin.TRACE_LS_HEARTBEAT_KEY) ?? "";
      if (v) localStorage.removeItem(StashpadPlugin.TRACE_LS_HEARTBEAT_KEY);
      return v;
    } catch { return ""; }
  }
  private mirrorTraceSync(): void {
    if (!this.settings.debugTracePersist) return;
    try {
      const tail = this.debugBuffer.slice(-StashpadPlugin.TRACE_LS_MAX_LINES).join("\n");
      localStorage.setItem(StashpadPlugin.TRACE_LS_KEY, tail);
    } catch { /* quota or unavailable — the debounced file copy still runs */ }
  }

  /** Take and clear the synchronous mirror. Cleared on read so a snapshot is
   *  reported once, against the session it belongs to, rather than resurfacing
   *  under later ones. */
  private takeSyncMirror(): string {
    try {
      const v = localStorage.getItem(StashpadPlugin.TRACE_LS_KEY) ?? "";
      if (v) localStorage.removeItem(StashpadPlugin.TRACE_LS_KEY);
      return v;
    } catch { return ""; }
  }

  private scheduleTraceFlush(): void {
    if (this.traceFlushTimer !== null) return;
    this.traceFlushTimer = setTimeout(() => {
      this.traceFlushTimer = null;
      void this.flushTraceToDisk();
    }, StashpadPlugin.TRACE_FLUSH_MS);
  }

  /** Write the current buffer out. Best-effort by design: a diagnostic that
   *  throws into whatever called trace() would be worse than a missing file. */
  private async flushTraceToDisk(): Promise<void> {
    if (!this.settings.debugTrace || !this.settings.debugTracePersist) return;
    // 0.268.9: never write before the previous session's file has been rotated
    // aside. Measured, not theorised: without this the new session's own first
    // flush landed in debug-trace.log while onload was still awaiting earlier
    // steps, and the rotate then preserved THAT — so restarting to recover a
    // crash trace was what destroyed it. Skipping a flush costs nothing, since
    // the buffer is in memory and the next flush writes it all.
    if (!this.traceRotateDone) return;
    const path = this.tracePath();
    if (!path) return;
    const text = this.getDebugTrace();
    if (!text) return;
    try { await this.app.vault.adapter.write(path, text); } catch { /* best effort */ }
  }

  /** On load, move any file left by the previous session aside before the new
   *  one starts overwriting it. That file is the whole point of this feature:
   *  after a force-quit it holds the trace from the run that froze. */
  private async rotateTraceFile(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const cur = this.tracePath();
    const prev = this.tracePath(true);
    if (!cur || !prev) return;
    // The synchronous mirror may hold lines the debounced file copy never got —
    // by definition, since it exists for the freeze that stopped the file copy
    // running. Keep BOTH rather than choosing: they cover different moments, and
    // picking the "newer" one by length or timestamp would be a guess that
    // silently discards the evidence this feature exists to preserve.
    const sync = this.takeSyncMirror();
    const beat = this.takeHeartbeat();
    try {
      let body = "";
      if (await adapter.exists(cur)) body = await adapter.read(cur);
      if (sync.trim()) {
        body += `${body ? "\n" : ""}--- last synchronous snapshot (survives a force-quit; may overlap the lines above) ---\n${sync}`;
      }
      if (beat.trim()) {
        // Last for a reason: it is the first thing worth reading. Compare `at`
        // against the final line's timestamp — a large gap means the thread died
        // somewhere no trace point covers, and the instrumentation, not the
        // theory, is what needs widening next.
        body += `${body ? "\n" : ""}--- last heartbeat before this session ended (250ms resolution) ---\n${beat}`;
      }
      if (body.trim()) await adapter.write(prev, body);
      if (await adapter.exists(cur)) await adapter.remove(cur);
    } catch { /* best effort */ }
  }

  /** The previous session's trace, for the copy command. Empty when there
   *  isn't one — a fresh install, or a clean shutdown after a clear. */
  async getPreviousTrace(): Promise<string> {
    const p = this.tracePath(true);
    if (!p) return "";
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(p))) return "";
      return await adapter.read(p);
    } catch { return ""; }
  }

  /** Remove both files. Called when the trace is cleared or switched off, so
   *  turning the diagnostic off leaves nothing of it behind. */
  async removeTraceFiles(): Promise<void> {
    // The synchronous mirror is part of the trace, so "delete it all" has to
    // include it — otherwise switching the diagnostic off leaves a copy behind
    // in localStorage and the next load resurrects it into a fresh prev file.
    this.takeSyncMirror();
    this.takeHeartbeat();
    const adapter = this.app.vault.adapter;
    for (const p of [this.tracePath(), this.tracePath(true)]) {
      if (!p) continue;
      try { if (await adapter.exists(p)) await adapter.remove(p); } catch { /* best effort */ }
    }
  }
  /** 0.268.10: main-thread stall watchdog.
   *
   *  The first freeze trace ruled out both suspects rather than finding one: the
   *  Hotkeys rows render in 2-3ms and the page re-renders only a handful of
   *  times, so neither "slow page" nor "render loop" survives. The trace simply
   *  STOPS, because a blocked main thread cannot record anything — the absence
   *  of lines is the one thing every hang looks like, whatever caused it.
   *
   *  A timer cannot fire during a stall either, but it fires immediately AFTER
   *  one, late by however long the thread was blocked. That lateness is the
   *  measurement: it gives the freeze a duration and a position in the trace,
   *  which is what turns "it stopped here" into "it was blocked for N ms right
   *  after X". `after` names the last thing traced, since a stall can begin long
   *  after the previous line and adjacency alone would mislead. */
  private static readonly STALL_TICK_MS = 250;
  /** Report threshold. Well above ordinary scheduling jitter and GC pauses, so
   *  a line here means a stall a person would actually notice. */
  private static readonly STALL_REPORT_MS = 400;
  /** Threshold while the window is unfocused. Comfortably above the ~1s ceiling
   *  of background timer throttling, so noise stays out and a genuine
   *  multi-second freeze still lands. */
  private static readonly STALL_UNFOCUSED_REPORT_MS = 2500;
  private stallLastTick = 0;
  private lastTraceCategory = "";

  /** Runs for the whole session: `trace()` no-ops when the debug trace is off,
   *  so the standing cost is one 250ms timer doing a subtraction. Starting it
   *  unconditionally means a stall that happens BEFORE the user thinks to turn
   *  tracing on still leaves the timer in place to catch the next one. */
  private startStallWatchdog(): void {
    this.stallLastTick = performance.now();
    let wasUnfocused = false;
    this.registerInterval(window.setInterval(() => {
      const now = performance.now();
      const late = now - this.stallLastTick - StashpadPlugin.STALL_TICK_MS;
      this.stallLastTick = now;
      // Stamp BEFORE any early return below: a heartbeat that only lands on
      // "interesting" ticks would go quiet for ordinary reasons and be
      // indistinguishable from the thread dying, which is the one thing it is
      // here to tell apart.
      this.beatSync();
      // 0.268.12: RAISE the bar when unfocused rather than going silent.
      //
      // A background window is throttled to roughly one timer a second, which
      // this arithmetic cannot tell from a 750ms freeze, so 0.268.10 simply
      // refused to judge an unfocused window. That was too blunt: a real freeze
      // produced NO line at all, and a missing line is indistinguishable from
      // "nothing happened" — the diagnostic failed exactly when it mattered.
      //
      // Throttling has a ceiling of about a second, so a threshold well above it
      // separates the two without discarding anything: ordinary throttle noise
      // stays out, a multi-second freeze still gets recorded whatever the window
      // was doing. `focused` is on every line so a suspicious one can be judged
      // rather than guessed at.
      const doc = document;
      const focused = !doc.hidden && doc.hasFocus();
      // One tick of grace on the way back to focus: that interval straddles the
      // change and its lateness belongs to the throttled side of it.
      const justRefocused = focused && wasUnfocused;
      wasUnfocused = !focused;
      if (justRefocused) return;
      const threshold = focused
        ? StashpadPlugin.STALL_REPORT_MS
        : StashpadPlugin.STALL_UNFOCUSED_REPORT_MS;
      if (late >= threshold) {
        this.trace("stall", { ms: Math.round(late), focused, after: this.lastTraceCategory || "?" });
      }
    }, StashpadPlugin.STALL_TICK_MS));
  }

  /** 0.268.11: find out who eats Mod+A.
   *
   *  Select-all works in the composer on a 15-plugin dev vault, so the fault is
   *  environmental and no amount of reading this repo will settle it. What can
   *  settle it is watching the key travel.
   *
   *  Two probes bracket every other listener. The capture one is the EARLIEST
   *  point Stashpad can observe a keypress; the bubble one is the LAST. Reading
   *  the pair:
   *
   *    both lines            nobody consumed it — Stashpad's own handling is
   *                          the thing at fault, not a rival listener
   *    capture only          something between the two consumed it; if
   *                          `handled` is absent it was not us
   *    neither line          a listener registered BEFORE Stashpad (Obsidian
   *                          itself, or a plugin loaded earlier) took it, and
   *                          no amount of work inside this plugin can win
   *
   *  Deliberately not limited to the composer: "it did not fire" and "it fired
   *  somewhere unexpected" look identical if the probe only reports one place. */
  private installSelectAllProbe(): void {
    const isSelectAll = (e: KeyboardEvent): boolean =>
      e.key?.toLowerCase() === "a" && (e.metaKey || e.ctrlKey) && !e.altKey;
    const describe = (e: KeyboardEvent): Record<string, unknown> => {
      const t = e.target as HTMLElement | null;
      return {
        target: t?.tagName ?? "?",
        cls: (t && typeof t.className === "string" && t.className.split(" ")[0]) || "",
        prevented: e.defaultPrevented,
      };
    };
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (isSelectAll(e)) this.trace("key:mod-a-seen", describe(e));
    }, { capture: true });
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (isSelectAll(e)) this.trace("key:mod-a-survived", describe(e));
    });
  }

  /** 0.268.15: photograph the settings window while it is unresponsive.
   *
   *  The freeze is NOT a main-thread hang — the rest of the app keeps working
   *  and commands still run, which is why the stall watchdog correctly reported
   *  nothing. A dead UI on a live thread is a different fault: the clicks are
   *  landing somewhere other than the row, or the modal is no longer where it
   *  appears to be.
   *
   *  So the decisive measurement is elementFromPoint. If a click on a settings
   *  row resolves to something that is not that row — a stale overlay, a modal
   *  background left behind, a zero-size container — that IS the bug, named
   *  outright rather than inferred. Sampled at several points because a partial
   *  cover looks identical to a whole one at a single coordinate. */
  private snapshotSettingsWindow(): Record<string, unknown> {
    const describe = (el: Element | null): string => {
      if (!el) return "none";
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      return `${el.tagName.toLowerCase()}${cls}`.slice(0, 120);
    };
    const out: Record<string, unknown> = {};
    try {
      const setting = (this.app as unknown as { setting?: { activeTab?: { id?: string } | null } }).setting;
      out.activeTab = setting?.activeTab?.id ?? null;
      out.modals = document.querySelectorAll(".modal").length;
      out.modalBgs = document.querySelectorAll(".modal-bg").length;
      out.menus = document.querySelectorAll(".menu").length;
      out.suggestions = document.querySelectorAll(".suggestion-container").length;
      out.settingItems = document.querySelectorAll(".setting-item").length;
      out.bindingRows = document.querySelectorAll(".stashpad-binding-row").length;
      out.activeEl = describe(document.activeElement);

      const modal = document.querySelector(".modal.mod-settings") ?? document.querySelector(".modal");
      if (!modal) { out.modalFound = false; return out; }
      out.modalFound = true;
      const r = modal.getBoundingClientRect();
      out.modalRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      const cs = getComputedStyle(modal);
      out.modalStyle = {
        pointerEvents: cs.pointerEvents, opacity: cs.opacity, display: cs.display,
        visibility: cs.visibility, zIndex: cs.zIndex, transform: cs.transform,
      };

      // The heart of it: at each sample point, is the topmost element inside the
      // modal, or has something else taken the hit?
      const pts: Array<Record<string, unknown>> = [];
      for (const [fx, fy] of [[0.5, 0.25], [0.5, 0.5], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]]) {
        const x = Math.round(r.x + r.width * fx);
        const y = Math.round(r.y + r.height * fy);
        const hit = document.elementFromPoint(x, y);
        pts.push({
          at: `${Math.round(fx * 100)}%,${Math.round(fy * 100)}%`,
          hit: describe(hit),
          insideModal: !!hit && modal.contains(hit),
          blockedBy: !!hit && !modal.contains(hit) ? describe(hit) : null,
        });
      }
      out.hitTest = pts;
      out.allInsideModal = pts.every((p) => p.insideModal === true);

      // A container with no height still "renders" rows that can never be hit.
      const content = modal.querySelector(".vertical-tab-content, .modal-content");
      if (content) {
        const cr = content.getBoundingClientRect();
        out.contentRect = { w: Math.round(cr.width), h: Math.round(cr.height) };
        out.contentScroll = {
          scrollH: (content as HTMLElement).scrollHeight,
          clientH: (content as HTMLElement).clientHeight,
          scrollTop: (content as HTMLElement).scrollTop,
        };
      }
    } catch (e) {
      out.error = (e as Error)?.message ?? "unknown";
    }
    return out;
  }

  /** Current trace lines joined for copy/clear from the Diagnostics tab. */
  /** 0.219.3: stamp the plugin version + platform at the top. A trace pasted
   *  back without it is ambiguous about which build produced it — which cost a
   *  round trip when the user wasn't sure whether they were on .1 or .2. */
  getDebugTrace(): string {
    if (!this.debugBuffer.length) return "";
    const os = Platform.isMobileApp ? (Platform.isIosApp ? "iOS" : "Android") : "desktop";
    // Obsidian's version is NOT on the app object — `app.version` is undefined,
    // which is why every trace collected before 0.266.9 said "Obsidian ?".
    //
    // 0.267.8: `apiVersion`, the API's own export. 0.266.9 read it out of the
    // user agent instead, which FAILED COMMUNITY-STORE REVIEW under
    // obsidianmd/platform ("avoid using the navigator API to detect the
    // operating system"). The rule is right beyond the review: a UA string is
    // a parse of something not promised to hold that shape, while apiVersion
    // is the documented answer and cannot drift.
    const obsidian = apiVersion || "?";
    // Device name, when there is a real one to give. Obsidian Sync's device
    // name is the user's OWN label ("Work laptop", "iPhone"), which is the only
    // string here that distinguishes two devices of the same kind — a user
    // agent cannot, since every iPhone reports "iPhone". Absent Sync there is
    // no device name to be had, so the field is simply omitted rather than
    // padded with something that looks like an answer.
    const sync = (this.app as unknown as {
      internalPlugins?: { plugins?: Record<string, { instance?: { deviceName?: unknown } }> };
    }).internalPlugins?.plugins?.sync?.instance;
    const device = typeof sync?.deviceName === "string" ? sync.deviceName.trim() : "";
    const bits = [
      `# Stashpad ${this.manifest?.version ?? "?"}`,
      device || os,
      device ? `${os}${Platform.isPhone ? " phone" : ""}` : (Platform.isPhone ? "phone" : ""),
      `Obsidian ${obsidian}`,
    ].filter(Boolean);
    const head = bits.join(" · ");
    return [head, ...this.debugBuffer].join("\n");
  }
  clearDebugTrace(): void {
    this.debugBuffer = [];
    // Clearing must clear the DISK copy too. Leaving it behind would mean the
    // next copy command hands back lines the user just asked to be rid of.
    if (this.traceFlushTimer !== null) { clearTimeout(this.traceFlushTimer); this.traceFlushTimer = null; }
    void this.removeTraceFiles();
  }

  /** How long a diagnostic mode may stay on before it switches itself off.
   *  Long enough to span a slow back-and-forth about a bug (report, build,
   *  reproduce, report again) — short enough that a mode forgotten after that
   *  exchange isn't still costing something months later. */
  private static readonly DIAGNOSTIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /** Record when a diagnostic mode was switched on (or clear the stamp when
   *  it's switched off). Caller saves settings. */
  stampDiagnostic(which: "perf" | "trace", enabled: boolean): void {
    const stamps = { ...(this.settings.diagnosticsEnabledAt ?? { perf: 0, trace: 0 }) };
    stamps[which] = enabled ? Date.now() : 0;
    this.settings.diagnosticsEnabledAt = stamps;
  }

  /** Switch off any diagnostic mode that's been on longer than the TTL.
   *
   *  Deliberately time-based rather than session-based: the bugs these modes
   *  exist for are often cold-start ones that need a restart to reproduce, so
   *  clearing on load would break the main use case. The in-memory trace
   *  BUFFER is never auto-cleared either — it's already a bounded ring, and
   *  wiping it on a timer could destroy a capture in the window between
   *  reproducing a bug and copying it out.
   *
   *  A mode that's on with no stamp was enabled before this existed (or by
   *  hand in data.json): stamp it now and start its clock, rather than
   *  switching it off under someone who may be mid-capture. */
  private async expireStaleDiagnostics(): Promise<void> {
    const stamps = { ...(this.settings.diagnosticsEnabledAt ?? { perf: 0, trace: 0 }) };
    const modes: Array<{ key: "perf" | "trace"; on: boolean; label: string; off: () => void }> = [
      { key: "perf", on: this.settings.enablePerfProfiling, label: "Performance profiling", off: () => { this.settings.enablePerfProfiling = false; } },
      { key: "trace", on: this.settings.debugTrace, label: "Debug trace", off: () => { this.settings.debugTrace = false; } },
    ];
    let changed = false;
    const turnedOff: string[] = [];
    for (const m of modes) {
      if (!m.on) {
        if (stamps[m.key]) { stamps[m.key] = 0; changed = true; }
        continue;
      }
      if (!stamps[m.key]) { stamps[m.key] = Date.now(); changed = true; continue; }
      if (Date.now() - stamps[m.key] > StashpadPlugin.DIAGNOSTIC_TTL_MS) {
        m.off();
        stamps[m.key] = 0;
        turnedOff.push(m.label);
        changed = true;
      }
    }
    if (!changed) return;
    this.settings.diagnosticsEnabledAt = stamps;
    await this.saveSettings();
    if (turnedOff.length) {
      // Never silent: a setting that changes itself without saying so is worse
      // than one left on, because the next capture would come back empty and
      // the reason would be invisible.
      new Notice(
        `Stashpad turned ${turnedOff.join(" and ")} back off — ${turnedOff.length === 1 ? "it had" : "they had"} been on for over a week. Turn ${turnedOff.length === 1 ? "it" : "them"} on again in Settings → Diagnostics if you still need ${turnedOff.length === 1 ? "it" : "them"}.`,
        0,
      );
    }
  }
  private undoStacks = new Map<string, UndoStack>();
  /** Most-recently-active Stashpad leaf — set on active-leaf-change.
   *  Used by sidebar panel actions (Search, Home) so they target the
   *  user's actual current tab rather than getLeavesOfType()[0]. */
  lastActiveStashpadLeaf: WorkspaceLeaf | null = null;
  /** 0.97.0: vault encryption key-management service (Phase 1). Holds the
   *  wrapped master key + session key; no file ops yet. */
  encryption!: EncryptionService;
  /** 0.79.19: true while rebootstrap is running. Suppresses the
   *  contribution stamp so rebootstrap's own frontmatter writes — and the
   *  wikilink rewrites Obsidian does when slug-renames move files — never
   *  bump `modified` (or add the local user as a contributor). */
  rebootstrapInProgress = false;
  /** 0.112.0: paths of `.stashenc` blobs written via the adapter THIS session
   *  that the vault's in-memory index may not have picked up yet. Backs the fast
   *  encryption-state check so the removal guard never has to do a full recursive
   *  adapter walk. Pruned by the create watcher (once indexed) and delete watcher. */
  private pendingEncBlobs = new Set<string>();
  /** 0.86.6: while `Date.now() < this`, a Stashpad view's activation
   *  auto-focus skips grabbing the composer. Set by the folder panel before it
   *  reveals/opens a leaf so tapping a pinned note on mobile doesn't pop the
   *  keyboard. */
  suppressComposerAutofocusUntil = 0;
  /** 0.73.10: keep a handle on the settings tab so command-palette
   *  entries can pre-select a specific tab when opening Settings. */
  settingTab: StashpadSettingTab | null = null;
  /** 0.74.1: selection-change listeners. Stashpad views fire this on
   *  every cursor/selection mutation; the right-side detail panel
   *  subscribes so it re-renders to match. Generic registry so future
   *  surfaces (other detail views, status bar) can also subscribe. */
  private stashpadSelectionListeners = new Set<() => void>();
  /** 0.74.6: content-change listeners. Distinct from selection
   *  listeners — these fire on every Stashpad render() (reorder,
   *  edit, child added, color change) WITHOUT implying the user
   *  picked a different note. The detail panel re-renders on these
   *  but keeps showing the same locked note, so a background reorder
   *  doesn't yank the panel to whatever the live cursor became. */
  private stashpadContentListeners = new Set<() => void>();
  /** Plugin-level notification service. Routes all toasts through one
   *  pipe so history + per-category mute + multiplayer filters work
   *  uniformly across views. Instantiated lazily on first access in
   *  case `this.app` isn't ready at field-initialiser time. */
  private _notifications: NotificationService | null = null;
  get notifications(): NotificationService {
    if (!this._notifications) this._notifications = new NotificationService(this.app);
    return this._notifications;
  }
  /** 0.77.1: rebuildable author registry (authors.json in the plugin
   *  private dir). NOT a source of truth — a recovery cache + rename
   *  history. See author-registry.ts. Lazily constructed; load() is
   *  awaited once during onload. */
  private _authorRegistry: AuthorRegistry | null = null;
  get authorRegistry(): AuthorRegistry {
    if (!this._authorRegistry) {
      this._authorRegistry = new AuthorRegistry(this.app, this.pluginPrivatePath());
    }
    return this._authorRegistry;
  }
  /** 0.79.1: auto-import engine for files dropped into a Stashpad folder. */
  private _importService: ImportService | null = null;
  get importService(): ImportService {
    if (!this._importService) this._importService = new ImportService(this);
    return this._importService;
  }
  /** 0.79.3: append-only import history (de-dupe + viewer). */
  private _importLog: ImportLog | null = null;
  get importLog(): ImportLog {
    if (!this._importLog) this._importLog = new ImportLog(this.app, this.pluginPrivatePath());
    return this._importLog;
  }
  /** 0.83.2: persisted render cache (rendered note bodies survive reload —
   *  a cold open reads one cache file instead of N bodies over a slow
   *  drive). Shared across views. */
  /** 0.99.0: the note clipboard (copy/cut/paste of note BLOCKS — runs in
   *  parallel with the system text clipboard, which gets the bodies as text).
   *  Plugin-level so it survives view re-renders; ids resolve against the
   *  source folder's tree at paste time (stale ids just shrink the paste). */
  noteClipboard: { mode: "copy" | "cut"; folder: string; ids: StashpadId[]; text?: string } | null = null;
  /** The persistent "cut pending" notice, kept so it can be dismissed when the
   *  cut resolves (paste) or is cancelled (Escape / replaced by a new copy). */
  noteClipboardNotice: Notice | null = null;
  /** 0.201.1: a cross-vault CUT waiting for its destination ACK. Set when a
   *  cut payload is stamped; resolved by checkXvCutAck() on window focus. */
  pendingXvCut: { token: string; folder: string; ids: StashpadId[] } | null = null;

  /** Clear the note clipboard + dismiss its notice. Callers re-render to drop
   *  the .is-cut-pending / .is-copy-pending row styling. */
  clearNoteClipboard(): void {
    try { this.noteClipboardNotice?.hide(); } catch { /* already gone */ }
    this.noteClipboardNotice = null;
    this.noteClipboard = null;
    this.pendingXvCut = null;
  }

  private _renderCacheStore: RenderCacheStore | null = null;
  get renderCacheStore(): RenderCacheStore {
    if (!this._renderCacheStore) this._renderCacheStore = new RenderCacheStore(this.app, this.pluginPrivatePath());
    return this._renderCacheStore;
  }

  async onunload(): Promise<void> {
    // 0.97.0: wipe the in-memory encryption key on unload.
    try { this.encryption?.dispose(); } catch { /* best-effort */ }
    // Cancel pending archive-sweep timers — firing after unload would run
    // lockNoteSubtree against disposed services (key just wiped).
    try { for (const p of this.archivePending.values()) window.clearTimeout(p.timer); this.archivePending.clear(); } catch { /* best-effort */ }
    // 0.140.1: stop any in-flight peek countdown — a raw setInterval firing
    // post-unload would write stale settings over the reloaded instance.
    try { this.reEncryptScheduler?.dispose(); } catch { /* best-effort */ }
    // 0.83.2: flush any pending render-cache writes (the store's save is
    // debounced, so a recent change could still be in the buffer).
    try { await this._renderCacheStore?.save(); } catch { /* best-effort */ }
    // 0.268.8: land the last trace lines. A clean unload is the one shutdown
    // where nothing is lost, so take it — the debounced flush may still be
    // pending, and its timer will not survive us.
    try {
      if (this.traceFlushTimer !== null) { clearTimeout(this.traceFlushTimer); this.traceFlushTimer = null; }
      await this.flushTraceToDisk();
    } catch { /* best-effort */ }
  }

  /** Vault-relative path to a file/dir inside the plugin's private
   *  folder (`.obsidian/plugins/<id>/.stashpad/...`). Used for the log,
   *  integrity state, and the relocated data.json. */
  pluginPrivatePath(rel = ""): string {
    const dir = (this.manifest as any).dir as string;
    const base = `${dir.replace(/\/+$/, "")}/.stashpad`;
    if (!rel) return base;
    return `${base}/${rel.replace(/^\/+/, "")}`;
  }

  /** Construct a StashpadLog pointed at the plugin's private dir. */
  newLog(): StashpadLog {
    return new StashpadLog(
      this.app,
      this.pluginPrivatePath(),
      // Lazy author lookup so a name change in settings is reflected
      // on the next log entry without re-creating the StashpadLog.
      () => (this.settings?.authorName ?? "").trim(),
    );
  }

  /** One-shot migration from the old paths to the new private folder.
   *  Idempotent: re-running has no effect once the new files exist.
   *  Old paths are LEFT in place for safety — the user can delete them
   *  manually after confirming the new location works. */
  private async migrateLegacyPaths(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const newDir = this.pluginPrivatePath();
    const ensureDir = async (): Promise<void> => {
      const parts = newDir.split("/").filter(Boolean);
      let cur = "";
      for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p;
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      }
    };

    // 1) data.json: relocate from the legacy `.stashpad/` private folder BACK to
    //    the STANDARD <pluginDir>/data.json. Obsidian Sync's "community plugin
    //    settings" only syncs the standard path — the relocated copy never synced,
    //    so pinned/hidden folders, toggles, and keybindings didn't propagate
    //    across devices (0.113.0). `.stashpad/data.json` is this device's ACTIVE
    //    store (saveData has written there since the relocation shipped), so it's
    //    the source of truth and OVERWRITES whatever standard data.json exists —
    //    critically, the ORIGINAL relocation left a stale pre-relocation standard
    //    data.json behind, and that stale copy must not win. Then retire the
    //    legacy copy (kept as `.bak`) so we never re-migrate. After every device
    //    migrates, the standard data.json syncs normally; a one-time
    //    last-writer-wins on the first cross-device launch is acceptable.
    const stdData = `${(this.manifest as any).dir.replace(/\/+$/, "")}/data.json`;
    const legacyData = this.pluginPrivatePath("data.json");
    if (await adapter.exists(legacyData)) {
      try {
        const txt = await adapter.read(legacyData);
        await adapter.write(stdData, txt);
        await adapter.write(`${legacyData}.bak`, txt); // safety backup
        await adapter.remove(legacyData);
        console.debug("[Stashpad] relocated data.json → standard path (for Obsidian Sync)");
      } catch (e) {
        console.warn("Stashpad: data.json relocation failed", e);
      }
    }

    // 2) .stashpad/ at the vault root (log.jsonl + state.json + any
    //    timestamped log exports the user has accumulated).
    const oldRoot = ".stashpad";
    if (await adapter.exists(oldRoot)) {
      try {
        await ensureDir();
        const list = await adapter.list(oldRoot);
        for (const file of list.files) {
          const name = file.replace(/^.*\//, "");
          const target = this.pluginPrivatePath(name);
          if (await adapter.exists(target)) continue; // don't clobber
          try {
            const data = await adapter.read(file);
            await adapter.write(target, data);
            console.debug("[Stashpad] migrated", file, "→", target);
          } catch (e) {
            console.warn(`Stashpad: failed to migrate ${file}`, e);
          }
        }
      } catch (e) {
        console.warn("Stashpad: .stashpad migration scan failed", e);
      }
    }
  }

  // 0.113.0: loadData/saveData are NO LONGER overridden. They previously
  // relocated data.json into `.stashpad/`, which Obsidian Sync never syncs
  // (it only syncs the standard <pluginDir>/data.json). Using Obsidian's
  // inherited Plugin.loadData/saveData (standard path) makes settings —
  // pinned/hidden folders, toggles, keybindings — sync across devices. The
  // one-time relocation of an existing `.stashpad/data.json` happens in
  // migrateLegacyPaths(). Other private files (log, render cache, authors,
  // keys) stay in `.stashpad/` via pluginPrivatePath().
  /** Create a brand-new Stashpad: ensures the folder exists (with any
   *  needed intermediates) and seeds it with a Home note that has the
   *  ROOT_ID frontmatter. Throws on collision so the caller can surface
   *  a clear error. After this resolves, discoverStashpadFolders will
   *  include the new folder. */
  async createNewStashpad(folder: string): Promise<void> {
    const cleaned = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) throw new Error("Folder name is empty");
    // Reject "." / ".." segments before any mkdir. Paths here are joined against
    // the vault root, and 0.208.0 wired this to a free-text field in the
    // first-run welcome, so the traversal invariant now has a user-facing entry
    // point. Fail loud instead of sanitizing (same rule as the .stash importer).
    if (cleaned.split("/").some((p) => p === "." || p === "..")) {
      throw new Error(`Folder name can't contain "." or ".." path segments`);
    }
    const adapter = this.app.vault.adapter;
    // mkdir intermediates.
    const parts = cleaned.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    // Seed Home note. Use the same shape createNoteUnder/the home note
    // bootstrap uses so the rest of the plugin recognizes it.
    // 0.266.9: the CANONICAL home filename, the same one the view's
    // ensureHomeNote looks for. This used to write a bare `Home.md`, which the
    // view then failed to recognise as the home note it wanted — the metadata
    // cache has not parsed a just-written file, so its id lookup found nothing
    // and it created a SECOND note with id __root__. Writing the right name is
    // what stops the duplicate at its source.
    const homePath = `${cleaned}/${buildHomeFilename(cleaned)}`;
    if (await adapter.exists(homePath)) {
      // A Home already exists — make sure its frontmatter is shaped right
      // so the discovery passes. We don't overwrite an existing body.
      const homeFile = this.app.vault.getAbstractFileByPath(homePath) as TFile | null;
      if (homeFile) {
        await this.app.fileManager.processFrontMatter(homeFile, (fm) => {
          if (typeof fm.id !== "string" || !fm.id) fm.id = ROOT_ID;
          if (!("parent" in fm)) fm.parent = null;
          if (typeof fm.created !== "string" || !fm.created) {
            fm.created = new Date().toISOString();
          }
        });
      }
      return;
    }
    const created = new Date().toISOString();
    const body = [
      "---",
      `id: ${ROOT_ID}`,
      "parent: null",
      `created: ${created}`,
      "---",
      "Home",
    ].join("\n");
    await this.app.vault.create(homePath, body);
    // 0.77.7: seed the local user's author page into the new folder so
    // their links resolve everywhere from the start.
    try { await this.seedLocalAuthorStub(cleaned); } catch { /* ignore */ }
    // 0.99.17 (#2): also seed every KNOWN author (coworkers from other folders)
    // so a new folder auto-populates and you can assign anyone immediately.
    try { await this.seedKnownAuthorsInFolder(cleaned); } catch { /* ignore */ }
  }

  /** Tally per-note colors found in EVERY markdown file under `folder`.
   *  Used by the settings UI's color-alias section. Returns hex strings
   *  (lowercased) + count, sorted by frequency desc, ties by hex. */
  collectColorsInFolder(folder: string): Array<{ hex: string; count: number }> {
    const counts = new Map<string, number>();
    const f = folder.replace(/\/+$/, "");
    for (const file of this.app.vault.getMarkdownFiles()) {
      const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== f && !dir.startsWith(f + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { color?: unknown } | undefined;
      const raw = typeof fm?.color === "string" ? fm.color.trim() : "";
      if (!raw) continue;
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) continue;
      const k = raw.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out = [...counts.entries()].map(([hex, count]) => ({ hex, count }));
    out.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
    return out;
  }

  /** Bulk-recolor every note in `folder` whose frontmatter color
   *  matches `oldHex` (case-insensitive). When `newHex` is null, the
   *  color frontmatter is REMOVED entirely (note becomes uncolored).
   *  Returns the number of files updated. */
  /** 0.238.0: the same recolour across EVERY Stashpad, not just one.
   *
   *  Colours mean the same thing vault-wide (red = urgent), so "change every
   *  red note to orange" is a vault-level intent that previously had to be
   *  repeated folder by folder. Returns the per-folder tally so the caller can
   *  report WHERE things changed — a single total would hide the case where one
   *  folder accounts for all of it. */
  async recolorEverywhere(oldHex: string, newHex: string | null): Promise<{ total: number; byFolder: Record<string, number> }> {
    const byFolder: Record<string, number> = {};
    let total = 0;
    for (const folder of this.discoverStashpadFolders()) {
      const n = await this.recolorAllInFolder(folder, oldHex, newHex);
      if (n > 0) { byFolder[folder] = n; total += n; }
    }
    return { total, byFolder };
  }

  async recolorAllInFolder(folder: string, oldHex: string, newHex: string | null): Promise<number> {
    const f = folder.replace(/\/+$/, "");
    const wantOld = oldHex.toLowerCase();
    let touched = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== f && !dir.startsWith(f + "/")) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { color?: unknown } | undefined;
      const cur = typeof fm?.color === "string" ? fm.color.trim().toLowerCase() : "";
      if (cur !== wantOld) continue;
      try {
        await this.app.fileManager.processFrontMatter(file, (m) => {
          if (newHex) m.color = newHex;
          else delete m.color;
        });
        touched++;
      } catch (e) {
        console.warn(`Stashpad: recolor failed for ${file.path}`, e);
      }
    }
    // Migrate alias bookkeeping. The old hex's alias (if any) follows
    // the color when newHex is set; vanishes when newHex is null.
    const map = this.settings.colorAliases?.[f];
    if (map) {
      const oldAlias = map[wantOld];
      if (oldAlias) {
        delete map[wantOld];
        if (newHex) map[newHex.toLowerCase()] = oldAlias;
        if (Object.keys(map).length === 0) delete this.settings.colorAliases[f];
        await this.saveSettings();
      }
    }
    return touched;
  }

  /** Look up a user-defined alias for a color in a given Stashpad.
   *  Returns undefined when no alias is set; callers fall back to
   *  the hex string itself. */
  getColorAlias(folder: string, hex: string): string | undefined {
    const f = folder.replace(/\/+$/, "");
    const map = this.settings.colorAliases?.[f];
    if (!map) return undefined;
    const v = map[hex.toLowerCase()];
    return v && v.trim() ? v : undefined;
  }

  /** Set or clear an alias. Empty string removes it. */
  async setColorAlias(folder: string, hex: string, alias: string): Promise<void> {
    const f = folder.replace(/\/+$/, "");
    const lower = hex.toLowerCase();
    if (!this.settings.colorAliases) this.settings.colorAliases = {};
    if (!this.settings.colorAliases[f]) this.settings.colorAliases[f] = {};
    const map = this.settings.colorAliases[f];
    const trimmed = alias.trim();
    if (trimmed) map[lower] = trimmed;
    else delete map[lower];
    if (Object.keys(map).length === 0) delete this.settings.colorAliases[f];
    await this.saveSettings();
  }

  /** Resolve once `folder` shows up in discoverStashpadFolders, or after
   *  `timeoutMs` regardless. Lets the settings UI re-render immediately
   *  after createNewStashpad without racing the metadataCache parse. */
  async waitForStashpadFolder(folder: string, timeoutMs = 2000): Promise<void> {
    const cleaned = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.discoverStashpadFolders().includes(cleaned)) return;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /** Discover every folder in the vault that holds at least one
   *  *Stashpad-shaped* note. Stashpad-shaped means the frontmatter has
   *  BOTH a string `id` AND a `parent` field (even if `parent` is null
   *  or ROOT_ID). This avoids false-positives from other plugins or
   *  templates that happen to write a generic `id:` field. */
  /** 0.95.1: snapshot of the most recent discoverStashpadFolders() result, so a
   *  vault "delete" event (which fires AFTER the folder's notes are gone) can
   *  still tell whether the deleted folder was a Stashpad. */
  knownStashpadFolders = new Set<string>();

  /** Subfolder name prefixes (user-configurable, comma-separated; default "_") that
   *  EXCLUDE a folder from Stashpad discovery + import — it stays local, not pulled
   *  in. A path is excluded if ANY of its segments starts with a listed prefix. */
  importExcludePrefixList(): string[] {
    return (this.settings.importExcludePrefixes ?? "_").split(",").map((s) => s.trim()).filter(Boolean);
  }
  pathHasExcludedSegment(path: string): boolean {
    const prefixes = this.importExcludePrefixList();
    if (!prefixes.length) return false;
    return path.replace(/\/+$/, "").split("/").some((seg) => prefixes.some((p) => seg.startsWith(p)));
  }

  /** 0.205.1: file extensions that mark a folder as ANOTHER outliner plugin's.
   *  Part of the cross-plugin agreement with Trynalist (its
   *  `dev-docs/interop.md`): each plugin's discovery must key off an artifact
   *  it OWNS, never generic frontmatter. Trynalist claims a folder only via its
   *  `<doc>.trynalist` manifest — so it can never claim ours — and we skip any
   *  folder holding one. Unlike the `attachments` check below, this stays
   *  correct no matter which frontmatter fields either plugin adds later. */
  private static FOREIGN_MANIFEST_EXTS: ReadonlySet<string> = new Set(["trynalist"]);

  /** Folders another outliner plugin has claimed with its own manifest file. */
  private foreignClaimedFolders(): Set<string> {
    const out = new Set<string>();
    for (const f of this.app.vault.getFiles()) {
      if (!StashpadPlugin.FOREIGN_MANIFEST_EXTS.has(f.extension)) continue;
      out.add(f.parent?.path?.replace(/\/+$/, "") ?? "");
    }
    return out;
  }

  /** 0.206.0: per-folder structure snapshot store (recovery sidecar). */
  private _structureStore: StructureSnapshotStore | null = null;
  get structureStore(): StructureSnapshotStore {
    if (!this._structureStore) this._structureStore = new StructureSnapshotStore(this.app);
    return this._structureStore;
  }

  /** 0.206.0: rebuild lost frontmatter from the folder's structure snapshot.
   *
   *  The case this exists for: a note's frontmatter gets wiped (bad merge, an
   *  overzealous find-and-replace, a sync conflict) and it drops out of the
   *  tree — anonymous, unparented, invisible. Its own recovery fields went with
   *  it, so the only thing left to identify it by is its PATH, which is exactly
   *  what the snapshot is keyed on.
   *
   *  Only ever ADDS what's missing: a note that still has an `id` is left
   *  completely alone, so running this on a healthy folder is a no-op. Bodies
   *  are never touched. Snapshot-backed and undoable. */
  async repairFolderFromSnapshot(folder: string): Promise<{ repaired: number; scanned: number; skipped: number; undo: () => Promise<void> } | null> {
    const cleaned = folder.replace(/\/+$/, "");
    const snap = await this.structureStore.load(cleaned);
    if (!snap) { new Notice(`No structure snapshot for "${cleaned}" yet — nothing to repair from.`); return null; }
    const byPath = indexByPath(snap);

    const candidates: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir !== cleaned) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      // Healthy note → leave it entirely alone.
      if (typeof fm?.id === "string" && fm.id.trim()) continue;
      if (byPath.has(f.path)) candidates.push(f);
    }
    const scanned = byPath.size;
    if (!candidates.length) {
      new Notice(`"${cleaned}": nothing to repair — every note still has its Stashpad frontmatter.`);
      return { repaired: 0, scanned, skipped: 0, undo: async () => { /* nothing changed */ } };
    }

    const paths = candidates.map((f) => f.path);
    const before = await this.snapshotPaths(paths);
    let repaired = 0, skipped = 0;
    for (const file of candidates) {
      const hit = byPath.get(file.path);
      if (!hit) { skipped++; continue; }
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.id = hit.id;
          fm.parent = parentForFrontmatter(hit.entry.parent);
          if (hit.entry.created && typeof fm.created !== "string") fm.created = hit.entry.created;
          if (!Array.isArray(fm.attachments)) fm.attachments = [];
        });
        repaired++;
      } catch (e) {
        console.warn("[Stashpad] snapshot repair failed for", file.path, e);
        skipped++;
      }
    }
    return {
      repaired, scanned, skipped,
      undo: async () => { await this.restoreSnapshot(before); },
    };
  }

  /** 0.231.0: last folder set the settings definitions were built against.
   *  `null` = never checked. */
  private settingsFolderSignature: string | null = null;

  /** Rebuild the cached setting definitions when the set of discovered
   *  Stashpads has changed since they were last built. Cheap no-op otherwise. */
  refreshSettingsIfStashpadsChanged(): void {
    const scanT0 = performance.now();
    const sig = this.discoverStashpadFolders().join("\u0000");
    const scanMs = performance.now() - scanT0;
    if (sig === this.settingsFolderSignature) {
      // 0.268.7 diagnostic: the no-op path still SCANS the vault, and it runs on
      // every metadataCache "resolved" — which fires continuously while Sync is
      // landing files. A cheap no-op is fine; an expensive one repeated is not,
      // so record the scan cost only when it is slow enough to matter.
      if (scanMs >= 5) this.trace("settings:folder-scan", { ms: Math.round(scanMs), noop: true });
      return;
    }
    // 0.268.7 diagnostic: the signature genuinely changed, so the whole settings
    // tab is rebuilt. If these lines repeat, the folder set is FLAPPING rather
    // than settling, and each flap forces a full declarative re-render of every
    // settings page — which is the shape a frozen settings window would have.
    this.trace("settings:update", {
      ms: Math.round(scanMs),
      folders: this.knownStashpadFolders?.size ?? 0,
      first: this.settingsFolderSignature === null,
    });
    this.settingsFolderSignature = sig;
    this.settingTab?.update?.();
  }

  discoverStashpadFolders(): string[] {
    const folders = new Set<string>();
    const foreign = this.foreignClaimedFolders();
    // 0.206.1: the claim covers the folder AND everything under it. Trynalist's
    // conversion BACKUPS carry a `backup.trynalist` marker at
    // `_conversion-backups/<folder>-<stamp>/` precisely so a backup of a
    // Stashpad folder is never adopted as live data — but a backed-up folder
    // can contain note-bearing subfolders of its own, and a folder-only test
    // left those claimable. (They're also covered by the `_` prefix rule, but
    // that's a user setting — the marker is the unconditional guard, so it has
    // to protect the whole subtree to mean anything.)
    const isForeign = (dir: string): boolean => {
      let cur = dir;
      for (;;) {
        if (foreign.has(cur)) return true;
        const cut = cur.lastIndexOf("/");
        if (cut < 0) return false;
        cur = cur.slice(0, cut);
      }
    };
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown; parent?: unknown; attachments?: unknown } | undefined;
      if (typeof fm?.id !== "string" || !fm.id.trim()) continue;
      // Require parent to be present in the frontmatter (any value —
      // including null and ROOT_ID — counts). A note without a parent
      // field isn't a Stashpad note.
      if (!fm || !("parent" in fm)) continue;
      // 0.205.0: `id` + `parent` alone is NOT a Stashpad signature — it's a
      // generic outliner one. Another plugin in the same vault (an outliner
      // writing id/parent/created/due per note) had every one of its folders
      // claimed here, which put them in every folder picker AND exposed their
      // notes to Stashpad's task/reminder/integrity machinery — including
      // writers like the recovery-link sync. Qualify a folder only on a
      // signature Stashpad actually owns:
      //   - the home note (`id: __root__`), written for every folder we create; or
      //   - `attachments`, which createNoteUnder writes on EVERY note.
      // Verified against the dev vault: keeps all 12 real Stashpad folders,
      // drops the foreign plugin's entirely.
      if (fm.id !== ROOT_ID && !("attachments" in fm)) continue;
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      // 0.136.0: reserved subfolders (archive/, trash/, _archive/, …) are never
      // Stashpad folders of their own — their notes surface via the aggregated
      // views instead of the folder pickers.
      if (isForeign(dir)) continue; // another plugin's document folder (0.205.1)
      if (dir && !this.pathHasExcludedSegment(dir) && !isInReservedSubfolder(dir)) folders.add(dir);
    }
    // 0.165.0: sort alphabetically, case-INSENSITIVELY, so the Folders lists in
    // settings (and every other folder picker) read A→Z regardless of casing
    // instead of clustering all-uppercase names ahead of lowercase ones (the
    // default `.sort()` is ASCII-ordered). Deterministic case-sensitive tiebreak
    // for names that differ only by case.
    const sorted = [...folders].sort(
      (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })
        || (a < b ? -1 : a > b ? 1 : 0),
    );
    this.knownStashpadFolders = new Set(sorted);
    return sorted;
  }

  /** Folder paths whose delete WE initiated (panel delete with undo). The vault
   *  "delete" listener skips these so it doesn't double-notify. Cleared after a
   *  short window. */
  private suppressedFolderDeletes = new Set<string>();

  /** Detach any open Stashpad tab on `cleaned` (or nested under it). Returns the
   *  count closed. Reads deferred leaves' persisted folder too. */
  private closeStashpadTabsFor(cleaned: string): number {
    let closed = 0;
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      let f = ((leaf.view as any)?.noteFolder ?? "") as string;
      if (!f) {
        const st = ((leaf.getViewState?.() as any)?.state ?? {}) as { folderOverride?: string | null };
        f = (st.folderOverride ?? "") || this.settings.folder || "Stashpad";
      }
      f = (f || "").replace(/\/+$/, "");
      if (f === cleaned || f.startsWith(cleaned + "/")) { leaf.detach(); closed++; }
    }
    return closed;
  }

  /** 0.149.2: re-point every open Stashpad tab (live AND deferred) off a folder
   *  that was just renamed `oldPath` → `newPath` (or nested under it), by updating
   *  its persisted `folderOverride`. Without this the view keeps the stale
   *  `noteFolder`, and its next write recreates the old-named folder (see the
   *  rename listener that calls this). `setViewState` re-hydrates a live view onto
   *  the new folder and rewrites a deferred leaf's persisted state so it loads
   *  correctly next session. */
  private retargetStashpadViewsForFolderRename(oldPath: string, newPath: string): void {
    const from = (oldPath || "").replace(/\/+$/, "");
    const to = (newPath || "").replace(/\/+$/, "");
    if (!from || from === to) return;
    const remap = (p: string | null | undefined): string | null => {
      const c = (p ?? "").replace(/\/+$/, "");
      if (c === from) return to;
      if (c.startsWith(from + "/")) return to + c.slice(from.length);
      return null;
    };
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const vs = leaf.getViewState();
      const st = (vs.state ?? {}) as { folderOverride?: string | null };
      // Live views carry the resolved folder on `noteFolder` (may be the default,
      // with folderOverride null); deferred leaves only have the persisted override.
      const liveFolder = !(leaf as any).isDeferred ? ((leaf.view as any)?.noteFolder as string | undefined) : undefined;
      const target = remap(liveFolder ?? st.folderOverride);
      if (!target) continue;
      void leaf.setViewState({ ...vs, state: { ...(vs.state ?? {}), folderOverride: target } });
    }
  }

  /** Drop a folder (and anything nested under it) from the folder-panel
   *  placement lists. Persists only if something changed. */
  /** 0.140.3 (review): when a folder is RENAMED, carry every path-keyed setting
   *  (placement, archive, per-folder encryption/view prefs) from the old path to
   *  the new — for the folder AND its descendants — else pins/hides/archive
   *  semantics silently orphan. Mirrors prunePlacementFor but rewrites. */
  async remapFolderPathInSettings(oldPath: string, newPath: string): Promise<void> {
    const from = oldPath.replace(/\/+$/, ""), to = newPath.replace(/\/+$/, "");
    if (!from || !to || from === to) return;
    const s = this.settings;
    const remapOne = (p: string): string =>
      p === from ? to : (p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    const remapArr = (arr: string[] | undefined): string[] | undefined =>
      arr ? arr.map(remapOne) : arr;
    const remapRec = <T,>(rec: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!rec) return rec;
      const out: Record<string, T> = {};
      for (const [k, v] of Object.entries(rec)) out[remapOne(k)] = v;
      return out;
    };
    // Snapshot the path-keyed fields so we only persist when something actually
    // moved — this method now runs twice per rename (folder-panel call + the vault
    // rename listener), and an idempotent second pass must not spawn a redundant
    // saveData (which bumps settingsRev + can fire a spurious collision notice).
    const snap = JSON.stringify([s.folderPanelPinned, s.folderPanelDownranked, s.folderPanelHidden, s.archiveFolders, s.searchIncludedFolders, s.searchExcludedFolders, s.defaultArchiveFolder, s.folder, s.folderEncPrefs, s.viewModes, s.encryptionFilter]);
    s.folderPanelPinned = remapArr(s.folderPanelPinned) ?? s.folderPanelPinned;
    s.folderPanelDownranked = remapArr(s.folderPanelDownranked) ?? s.folderPanelDownranked;
    s.folderPanelHidden = remapArr(s.folderPanelHidden) ?? s.folderPanelHidden;
    s.archiveFolders = remapArr(s.archiveFolders) ?? s.archiveFolders;
    s.searchIncludedFolders = remapArr(s.searchIncludedFolders) ?? s.searchIncludedFolders;
    s.searchExcludedFolders = remapArr(s.searchExcludedFolders) ?? s.searchExcludedFolders;
    if (s.defaultArchiveFolder) s.defaultArchiveFolder = remapOne(s.defaultArchiveFolder);
    if ((s.folder || "").replace(/\/+$/, "") === from || (s.folder || "").startsWith(from + "/")) s.folder = remapOne((s.folder || "").replace(/\/+$/, ""));
    s.folderEncPrefs = remapRec(s.folderEncPrefs) ?? s.folderEncPrefs;
    s.viewModes = remapRec(s.viewModes) ?? s.viewModes;
    if (s.encryptionFilter) s.encryptionFilter = remapRec(s.encryptionFilter);
    const after = JSON.stringify([s.folderPanelPinned, s.folderPanelDownranked, s.folderPanelHidden, s.archiveFolders, s.searchIncludedFolders, s.searchExcludedFolders, s.defaultArchiveFolder, s.folder, s.folderEncPrefs, s.viewModes, s.encryptionFilter]);
    if (after !== snap) await this.saveSettings();
  }

  private async prunePlacementFor(cleaned: string): Promise<void> {
    const s = this.settings;
    const prune = (arr: string[] | undefined): string[] =>
      (arr ?? []).filter((p) => p !== cleaned && !p.startsWith(cleaned + "/"));
    const before = (s.folderPanelPinned?.length ?? 0) + (s.folderPanelDownranked?.length ?? 0) + (s.folderPanelHidden?.length ?? 0);
    s.folderPanelPinned = prune(s.folderPanelPinned);
    s.folderPanelDownranked = prune(s.folderPanelDownranked);
    s.folderPanelHidden = prune(s.folderPanelHidden);
    const after = s.folderPanelPinned.length + s.folderPanelDownranked.length + s.folderPanelHidden.length;
    if (after !== before) await this.saveSettings();
  }

  /** 0.95.2: delete a Stashpad folder from the panel WITH undo. We move it into
   *  the vault's `.trash` ourselves (rather than fileManager.trashFile, whose
   *  destination depends on the user's trash setting and may be unrecoverable)
   *  so Undo is always a simple move-back. Closes open tabs + posts a PERSISTENT
   *  notification carrying the Undo action. */
  async deleteStashpadFolderWithUndo(tf: TFolder): Promise<void> {
    const cleaned = tf.path.replace(/\/+$/, "");
    const name = tf.name;
    const adapter = this.app.vault.adapter;
    const trashDir = ".trash";
    try { if (!(await adapter.exists(trashDir))) await adapter.mkdir(trashDir); }
    catch (e) { console.warn("[Stashpad] couldn't ensure .trash", e); }
    let dest = `${trashDir}/${name}`;
    for (let n = 1; await adapter.exists(dest); n++) dest = `${trashDir}/${name} (${n})`;

    this.suppressedFolderDeletes.add(cleaned);
    window.setTimeout(() => this.suppressedFolderDeletes.delete(cleaned), 5000);
    const closed = this.closeStashpadTabsFor(cleaned);
    await this.prunePlacementFor(cleaned);
    this.knownStashpadFolders.delete(cleaned);
    try {
      await adapter.rename(cleaned, dest);
    } catch (e) {
      console.warn("[Stashpad] folder delete failed", e);
      this.suppressedFolderDeletes.delete(cleaned);
      new Notice("Delete failed (see console).");
      return;
    }

    const msg = closed > 0
      ? `Deleted “${name}” — closed ${closed} open tab${closed === 1 ? "" : "s"}.`
      : `Deleted “${name}”.`;
    this.notifications.show({
      message: msg,
      kind: "warning",
      category: "delete",
      duration: 0,
      folder: cleaned,
      actions: [{
        label: "Undo",
        onClick: async () => {
          try {
            if (await adapter.exists(cleaned)) { new Notice(`Can't undo — “${name}” already exists.`); return; }
            this.suppressedFolderDeletes.add(cleaned);
            window.setTimeout(() => this.suppressedFolderDeletes.delete(cleaned), 5000);
            await adapter.rename(dest, cleaned);
            new Notice(`Restored “${name}”.`);
            void this.activateViewForFolder(cleaned);
          } catch (e) {
            console.warn("[Stashpad] folder undo failed", e);
            new Notice("Undo failed (see console).");
          }
        },
      }],
    });
  }

  /** 0.95.1: a Stashpad folder was deleted from OUTSIDE the panel (file
   *  explorer, sync, …) — we didn't trash it, so no undo, but still close any
   *  open tabs on it, drop it from placement lists, and notify so a vanished tab
   *  isn't a surprise. Skips folders we just deleted ourselves (those already
   *  notified with Undo). */
  async handleStashpadFolderDeleted(path: string): Promise<void> {
    const cleaned = path.replace(/\/+$/, "");
    if (!cleaned || this.suppressedFolderDeletes.has(cleaned)) return;
    const closed = this.closeStashpadTabsFor(cleaned);
    await this.prunePlacementFor(cleaned);
    this.knownStashpadFolders.delete(cleaned);
    const name = cleaned.split("/").pop() || cleaned;
    this.notifications.show({
      message: closed > 0
        ? `Stashpad “${name}” was deleted — closed ${closed} open tab${closed === 1 ? "" : "s"}.`
        : `Stashpad “${name}” was deleted.`,
      kind: "warning",
      category: "delete",
      folder: cleaned,
    });
    // 0.213.2 (part 3, post-hoc half): this path is a delete through Obsidian's
    // OWN UI — the file explorer, or a sync from another device. There is no
    // prompt to hook (Stashpad's own delete gets the pre-flight warning in the
    // folder panel), so the best available answer is to name the damage right
    // after it happens instead of leaving the user to find broken images later.
    //
    // The folder is already gone, so its attachments have dropped out of
    // resolvedLinks; the notes that embedded them now carry UNRESOLVED links.
    // Waits for the metadata cache to catch up before looking.
    window.setTimeout(() => {
      try {
        const prefix = `${cleaned}/_attachments/`;
        const broken = new Set<string>();
        const unresolved = this.app.metadataCache.unresolvedLinks ?? {};
        for (const [src, targets] of Object.entries(unresolved)) {
          for (const target of Object.keys(targets ?? {})) {
            if (target.startsWith(prefix)) { broken.add(src); break; }
          }
        }
        if (!broken.size) return;
        this.notifications.show({
          message: `${broken.size} note${broken.size === 1 ? "" : "s"} outside “${name}” embedded ${broken.size === 1 ? "an attachment" : "attachments"} that lived in it, so ${broken.size === 1 ? "that image" : "those images"} no longer resolve${broken.size === 1 ? "s" : ""}. Restoring the folder from the trash fixes ${broken.size === 1 ? "it" : "them"}.\n`
            + [...broken].slice(0, 8).map((p) => `• \`${p}\``).join("\n"),
          kind: "warning",
          category: "delete",
          duration: 0,
        });
        if (broken.size > 8) console.warn("[Stashpad] notes with broken attachment embeds:", [...broken]);
      } catch (e) { console.warn("[Stashpad] broken-embed check failed", e); }
    }, 2000);
  }

  /** The folders eligible for cross-Stashpad search results, derived from
   *  discoverStashpadFolders + the included/excluded settings:
   *  - When `searchIncludedFolders` is non-empty, only those folders are
   *    eligible (allowlist mode).
   *  - When empty, every discovered folder is eligible MINUS those in
   *    `searchExcludedFolders`.
   *  The currently-active folder is always returned first so callers can
   *  show its results before the rest. */
  searchableFolders(activeFolder: string): string[] {
    const allowed = new Set(this.settings.searchIncludedFolders);
    const excluded = new Set(this.settings.searchExcludedFolders);
    // 0.98.32: archive folders are auto-excluded from CROSS-folder search — their
    // contents are private-at-rest, so they shouldn't surface as search hits or
    // move targets elsewhere. (The active folder is still searched within itself —
    // it's unshifted back below.)
    const autoExcluded = new Set(
      (this.settings.archiveFolders ?? []).map((s) => (s ?? "").replace(/\/+$/, "")),
    );
    const all = this.discoverStashpadFolders();
    const filtered = all.filter((f) => {
      if (autoExcluded.has(f)) return false;
      if (allowed.size > 0) return allowed.has(f);
      return !excluded.has(f);
    });
    // Move the active folder to the front (or insert if it was excluded —
    // callers always want their own folder first).
    const a = (activeFolder || "").trim().replace(/\/+$/, "");
    const out = filtered.filter((f) => f !== a);
    if (a) out.unshift(a);
    return out;
  }

  /** Folders we've already run the integrity sweep on this session.
   *  Subsequent requests for the same folder are no-ops — the sweep is
   *  expensive and re-running it just repeats the noise. */
  private sweptFolders = new Set<string>();

  /** Once-per-session SILENT refresh: brings .stashpad/state.json into
   *  sync with the current vault snapshot WITHOUT writing log entries.
   *  This is what runs when a Stashpad view mounts. Every actual user
   *  action (create / parent-change / rename / delete) is already logged
   *  inline by view.ts, so a noisy diff here is redundant — and worse,
   *  it'd re-log every note created in the previous session every time
   *  the plugin reloads.
   *
   *  Use cmdRunIntegrityCheck() (command palette) for the loud version
   *  that surfaces external/out-of-band changes. */
  async maybeSweepFolder(folder: string): Promise<void> {
    const f = (folder || "").trim().replace(/\/+$/, "");
    if (!f || this.sweptFolders.has(f)) return;
    this.sweptFolders.add(f);
    setTimeout(() => { void this.runSweep(f, { silent: true }); }, 3000);
  }

  /** Manual integrity check — writes log entries for every delta between
   *  state.json and the current vault snapshot. Triggered from the
   *  command palette, not on view mount. */
  /** 0.219.7: scan EVERY Stashpad folder for duplicate note ids.
   *
   *  The automatic warning only fires from a view's tree reconcile, so it can
   *  only ever notice the folder you happen to have open — which is why a vault
   *  with duplicates in three folders reported one. This command checks them
   *  all, so the answer doesn't depend on which tab is in front.
   *
   *  Read-only. Groups by id the way TreeIndex does NOT (it keys by id, so
   *  duplicates collapse and become invisible), scoped per folder and skipping
   *  reserved subfolders so archived copies aren't false positives. */
  /** 0.219.8: duplicate-id groups for ONE folder. Scoped exactly the way
   *  TreeIndex enumerates (reserved subfolders skipped), so archived copies are
   *  not false positives. `isShown` marks the file the tree currently resolves
   *  the id to — every other file in the group is invisible in the list. */
  duplicateGroupsForFolder(folder: string): DuplicateIdGroup[] {
    const prefix = folder + "/";
    const byId = new Map<string, string[]>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!(dir === folder || (folder !== "" && dir.startsWith(prefix)))) continue;
      const relDirs = dir === folder ? [] : dir.slice(prefix.length).split("/");
      if (relDirs.some((seg) => isReservedSubfolderName(seg))) continue;
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (typeof id !== "string" || !id) continue;
      const arr = byId.get(id);
      if (arr) arr.push(f.path); else byId.set(id, [f.path]);
    }
    const view = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
      .map((l) => l.view as unknown as { noteFolder?: string; tree?: { get(i: string): { file?: { path: string } | null } | undefined } })
      .find((v) => v.noteFolder === folder);
    const groups: DuplicateIdGroup[] = [];
    for (const [id, paths] of byId) {
      if (paths.length < 2) continue;
      const shown = view?.tree?.get(id)?.file?.path ?? paths[0];
      groups.push({ id, files: paths.map((p) => ({ path: p, isShown: p === shown })) });
    }
    return groups;
  }

  /** Every folder with duplicates. The automatic warning used to see only the
   *  folder that happened to have an open view, which under-reported. */
  duplicateGroupsEverywhere(): { folder: string; groups: DuplicateIdGroup[] }[] {
    const out: { folder: string; groups: DuplicateIdGroup[] }[] = [];
    for (const folder of this.discoverStashpadFolders()) {
      const groups = this.duplicateGroupsForFolder(folder);
      if (groups.length) out.push({ folder, groups });
    }
    return out;
  }

  /** 0.219.8: REPAIR — give every hidden copy a fresh id so it becomes its own
   *  visible note. Nothing is deleted and no body is touched; only the `id`
   *  frontmatter of the copies changes.
   *
   *  Why re-mint rather than delete: the copies are usually real content (a sync
   *  conflict copy can hold edits the winner does not), and deleting is the one
   *  choice the user cannot undo by hand. Re-minting is reversible — the undo
   *  entry restores the original ids — and it makes the hidden notes reachable
   *  so the user can compare them and decide.
   *
   *  The note the tree currently SHOWS keeps its id, so existing deep links,
   *  `parent` references and children continue to resolve to the same note. */
  /** Find a file in `folder` whose frontmatter id is `id`. Used by the
   *  duplicate-repair undo, because changing an id re-slugs the filename and
   *  makes any captured path stale. */
  fileByFrontmatterId(folder: string, id: string): TFile | null {
    const prefix = folder + "/";
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!(dir === folder || (folder !== "" && dir.startsWith(prefix)))) continue;
      if (this.app.metadataCache.getFileCache(f)?.frontmatter?.id === id) return f;
    }
    return null;
  }

  async repairDuplicateIds(folder: string, groups: DuplicateIdGroup[]): Promise<number> {
    const used = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (typeof id === "string" && id) used.add(id);
    }
    // Record the NEW id too, not just the path. Changing a note's id makes
    // Stashpad re-slug its FILENAME, so the captured path goes stale within
    // seconds — resolving undo by path alone silently no-ops, which is the
    // stale-path bug class this repo has hit repeatedly (0.140.10, H6,
    // 0.211.4). Verified here: the first version of this undo did nothing.
    const changed: { path: string; from: string; to: string }[] = [];
    for (const g of groups) {
      for (const file of g.files) {
        if (file.isShown) continue;                  // the winner keeps its id
        const af = this.app.vault.getAbstractFileByPath(file.path);
        if (!(af instanceof TFile)) continue;
        // ROOT_ID is structural (a folder's home note), not a normal note id —
        // re-minting it would orphan the folder. Those need a different remedy,
        // so leave them and report them as skipped.
        if (g.id === ROOT_ID) continue;
        const fresh = freshId((c) => used.has(c));
        used.add(fresh);
        try {
          await this.app.fileManager.processFrontMatter(af, (fm) => { fm.id = fresh; });
          changed.push({ path: file.path, from: g.id, to: fresh });
        } catch (e) {
          console.warn("[Stashpad] couldn't re-mint id for", file.path, e);
        }
      }
    }
    if (changed.length) {
      this.getUndoStack(folder).push({
        label: `Repair ${changed.length} duplicate id${changed.length === 1 ? "" : "s"}`,
        undo: async () => {
          for (const c of changed) {
            // id-FIRST: the file has almost certainly been renamed by the
            // re-slug that our own id change triggered, so the captured path is
            // stale. Find it by the id we just wrote; fall back to the path.
            const af = this.fileByFrontmatterId(folder, c.to)
              ?? (this.app.vault.getAbstractFileByPath(c.path) as TFile | null);
            if (af instanceof TFile) {
              try { await this.app.fileManager.processFrontMatter(af, (fm) => { fm.id = c.from; }); }
              catch (e) { console.warn("[Stashpad] couldn't restore id for", c.to, e); }
            }
          }
          this.refreshOpenViewsForFolder(folder);
        },
        redo: async () => { await this.repairDuplicateIds(folder, this.duplicateGroupsForFolder(folder)); },
      });
      this.refreshOpenViewsForFolder(folder);
    }
    return changed.length;
  }

  async findDuplicateNoteIds(): Promise<void> {
    const perFolder = this.duplicateGroupsEverywhere();
    if (!perFolder.length) {
      new Notice("No duplicate note ids found in any Stashpad folder.");
      return;
    }
    this.openDuplicatesModal(perFolder);
  }

  /** 0.220.1: one modal for the whole vault. Repair spans every folder listed,
   *  so the single button matches the single view. */
  /** 0.261.0: session flag so the vault-wide duplicate-id warning is shown
   *  ONCE, not once per open Stashpad view. Public because the views set it. */
  reportedDuplicateIds = false;

  /** 0.261.0: discard one copy of a duplicated id — trash the file and put an
   *  undo on that folder's stack.
   *
   *  Notes only, deliberately: a duplicate is a COPY, and its attachments are
   *  usually the very same files the copy it duplicates points at. Trashing
   *  those would break the note being kept. */
  async discardDuplicateCopy(path: string, folder: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice("That file is already gone."); return false; }
    let content = "";
    try { content = await this.app.vault.read(file); }
    catch (e) {
      new Notice(`Couldn't read ${path} — not discarding it: ${(e as Error).message}`);
      return false;
    }
    try {
      // fileManager.trashFile honours the user's own "deleted files" setting
      // (system trash / vault .trash / permanent) rather than overriding it.
      await this.app.fileManager.trashFile(file);
    } catch (e) {
      new Notice(`Couldn't discard ${path}: ${(e as Error).message}`);
      return false;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    this.getUndoStack(folder).push({
      label: `Discard duplicate copy (${name})`,
      undo: async () => {
        if (this.app.vault.getAbstractFileByPath(path)) return; // already back
        await this.app.vault.create(path, content);
      },
      redo: async () => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.fileManager.trashFile(f);
      },
    });
    this.notifications.show({
      message: `Discarded \`${name}\` — Undo in the list restores it.`,
      kind: "success",
      category: "delete",
      folder,
      affectedPaths: [path],
    });
    return true;
  }

  /** 0.262.0: fold one copy of a duplicated id INTO another, then discard it.
   *
   *  Conservative by construction, because this runs on notes the user has
   *  already told us are hard to tell apart:
   *   - the target's body is APPENDED to, never replaced;
   *   - frontmatter is only filled in where the target has NO value — the
   *     target always wins a conflict, so merging can't overwrite something
   *     you meant to keep;
   *   - the body is only appended when it actually differs, so merging two
   *     identical copies doesn't duplicate the text.
   *
   *  One undo entry restores BOTH sides: the target's original bytes and the
   *  discarded file. Half-undoing a merge would be worse than not offering it.
   */
  async mergeDuplicateCopy(sourcePath: string, targetPath: string, folder: string): Promise<boolean> {
    const src = this.app.vault.getAbstractFileByPath(sourcePath);
    const tgt = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(src instanceof TFile) || !(tgt instanceof TFile)) { new Notice("One of those files is already gone."); return false; }
    let srcRaw = "", tgtRaw = "";
    try { srcRaw = await this.app.vault.read(src); tgtRaw = await this.app.vault.read(tgt); }
    catch (e) { new Notice(`Couldn't read the notes: ${(e as Error).message}`); return false; }

    const bodyOf = (raw: string): string => raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    const srcBody = bodyOf(srcRaw), tgtBody = bodyOf(tgtRaw);
    const srcFm = (this.app.metadataCache.getFileCache(src)?.frontmatter ?? {}) as Record<string, unknown>;
    const srcName = sourcePath.slice(sourcePath.lastIndexOf("/") + 1).replace(/\.md$/, "");

    try {
      if (srcBody && srcBody !== tgtBody) {
        // Attributed separator: after a merge you need to be able to see which
        // half came from where, and undo is not a substitute for that.
        await this.app.vault.append(tgt, `\n\n---\n\n_Merged from ${srcName}:_\n\n${srcBody}\n`);
      }
      await this.app.fileManager.processFrontMatter(tgt, (m) => {
        for (const [k, v] of Object.entries(srcFm)) {
          if (RESERVED_FRONTMATTER.includes(k as never)) continue;   // Stashpad owns these
          const cur = m[k];
          const empty = cur === undefined || cur === null || cur === ""
            || (Array.isArray(cur) && cur.length === 0);
          if (empty) m[k] = v;
        }
      });
      await this.app.fileManager.trashFile(src);
    } catch (e) {
      new Notice(`Merge failed: ${(e as Error).message}`);
      return false;
    }

    this.getUndoStack(folder).push({
      label: `Merge duplicate (${srcName})`,
      undo: async () => {
        const t = this.app.vault.getAbstractFileByPath(targetPath);
        if (t instanceof TFile) await this.app.vault.modify(t, tgtRaw);
        if (!this.app.vault.getAbstractFileByPath(sourcePath)) await this.app.vault.create(sourcePath, srcRaw);
      },
      redo: async () => { await this.mergeDuplicateCopy(sourcePath, targetPath, folder); },
    });
    this.notifications.show({
      message: `Merged \`${srcName}\` into \`${targetPath.slice(targetPath.lastIndexOf("/") + 1)}\` — Undo restores both.`,
      kind: "success",
      category: "system",
      folder,
      affectedPaths: [sourcePath, targetPath],
    });
    return true;
  }

  /** 0.264.0: per-URL link-preview cache (plugin private folder). */
  private _previewCache: PreviewCache | null = null;
  get previewCache(): PreviewCache {
    if (!this._previewCache) this._previewCache = new PreviewCache(this.app, this.pluginPrivatePath());
    return this._previewCache;
  }

  /** Add link previews to specific notes. Reports what it did per note rather
   *  than a bare total, because "0 added" has three different meanings —
   *  nothing to do, everything already previewed, or everything failed. */
  async addLinkPreviews(files: TFile[], opts: { force?: boolean } = {}): Promise<void> {
    if (!files.length) { new Notice("No notes selected."); return; }
    const totals = { added: 0, skipped: 0, failed: 0, cached: 0 };
    for (const f of files) {
      try {
        const r = await enrichFile(this.app, this.previewCache, f, {
          calloutType: this.settings.linkPreviewCallout,
          collapsed: this.settings.linkPreviewCollapsed,
          delayMs: this.settings.linkPreviewDelayMs,
          force: opts.force,
        });
        totals.added += r.added; totals.skipped += r.skipped;
        totals.failed += r.failed; totals.cached += r.cached;
      } catch (e) {
        console.warn("[Stashpad] link preview failed for", f.path, e);
        totals.failed++;
      }
    }
    if (!totals.added && !totals.skipped && !totals.failed) {
      new Notice("No links found in " + (files.length === 1 ? "that note." : "those notes."));
      return;
    }
    const bits = [`Added ${totals.added} preview${totals.added === 1 ? "" : "s"}`];
    if (totals.cached) bits.push(`${totals.cached} from cache`);
    if (totals.skipped) bits.push(`${totals.skipped} already had one`);
    if (totals.failed) bits.push(`${totals.failed} couldn't be fetched`);
    this.notifications.show({
      message: bits.join(" · ") + ".",
      kind: totals.failed && !totals.added ? "warning" : "success",
      category: "system",
      affectedPaths: files.map((f) => f.path),
    });
  }

  /** Paths waiting on a debounced auto-enrich, and the timer draining them. */
  private autoPreviewQueue = new Set<string>();
  private autoPreviewTimer: number | null = null;
  /** Paths WE just wrote. Our own write fires another `modify`, and without
   *  this the watcher would answer its own event forever. */
  private autoPreviewSelfWrites = new Map<string, number>();

  /** 0.265.0: queue a note for automatic preview fetching.
   *
   *  Heavily deferred on purpose. This fires on `modify`, which means it fires
   *  while the user is typing — enriching mid-keystroke would fetch a
   *  half-typed URL and write to the note under the cursor. The debounce is
   *  long enough that it only lands once you have stopped. */
  private queueAutoPreview(file: TFile): void {
    if (!this.settings.linkPreviewAuto) return;
    const recent = this.autoPreviewSelfWrites.get(file.path);
    if (recent && Date.now() - recent < 10_000) return;   // our own write, echoing back
    const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const folders = this.discoverStashpadFolders().map((f) => f.replace(/\/+$/, ""));
    if (!folders.some((f) => dir === f || dir.startsWith(f + "/"))) return;
    this.autoPreviewQueue.add(file.path);
    if (this.autoPreviewTimer != null) window.clearTimeout(this.autoPreviewTimer);
    this.autoPreviewTimer = window.setTimeout(() => { void this.drainAutoPreviews(); }, 8000);
  }

  private async drainAutoPreviews(): Promise<void> {
    this.autoPreviewTimer = null;
    const paths = [...this.autoPreviewQueue];
    this.autoPreviewQueue.clear();
    for (const p of paths) {
      if (!this.settings.linkPreviewAuto) return;   // turned off while we waited
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      try {
        const r = await enrichFile(this.app, this.previewCache, f, {
          calloutType: this.settings.linkPreviewCallout,
          collapsed: this.settings.linkPreviewCollapsed,
          delayMs: this.settings.linkPreviewDelayMs,
        });
        // Only mark a self-write when we ACTUALLY wrote. Marking
        // unconditionally would suppress a genuine later edit for 10s.
        if (r.added > 0) {
          this.autoPreviewSelfWrites.set(p, Date.now());
          // Quiet by design: an automatic feature announcing itself on every
          // note you save is noise. Failures stay silent too — they are
          // recorded in the note as a stub and in the cache.
        }
      } catch (e) {
        console.warn("[Stashpad] auto link preview failed", p, e);
      }
    }
  }

  /** 0.266.1: one markdown file per Stashpad folder, so the QUICK SWITCHER can
   *  launch a Stashpad tab.
   *
   *  Obsidian's switcher only knows about files, so a Stashpad folder is
   *  invisible to it. These stubs give it something to find. The stub is not a
   *  document you read — opening it REPLACES itself with the Stashpad view for
   *  its folder (see the file-open handler), so switcher → type → Enter lands
   *  you in Stashpad in one step rather than opening a note that merely
   *  contains a link you then have to click.
   *
   *  Kept in one folder rather than one stub per Stashpad folder root, so they
   *  never mix with real notes and are trivial to delete en masse. */
  async createFolderShortcuts(): Promise<void> {
    const dir = SHORTCUT_DIR;
    const folders = this.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")).filter(Boolean);
    // Folders are discovered from the notes on disk, not from a setting, so
    // there is deliberately no fallback to a configured default: a shortcut to
    // a folder that holds no Stashpad notes would open an empty view and look
    // broken. Say what to do instead of just reporting the absence.
    if (!folders.length) {
      new Notice("No Stashpad folders found yet — create one first, then run this again.");
      return;
    }
    try {
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
    } catch (e) {
      new Notice(`Couldn't create the shortcuts folder: ${(e as Error).message}`);
      return;
    }
    let made = 0, existing = 0;
    for (const folder of folders) {
      const leaf = folder.split("/").pop() || folder;
      // Prefixed so typing "sp" in the switcher surfaces every one of them
      // together, instead of them scattering through unrelated results.
      const path = `${dir}/Stashpad — ${leaf}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) { existing++; continue; }
      const body = [
        "---",
        `stashpadShortcut: "${folder}"`,
        "---",
        "",
        `Opening this file opens the **${leaf}** Stashpad.`,
        "",
        "It exists so Obsidian's quick switcher can reach a Stashpad folder —",
        "the switcher only finds files, and a Stashpad is a folder. Deleting it",
        "removes the shortcut and nothing else; your notes are untouched.",
        "",
      ].join("\n");
      try { await this.app.vault.create(path, body); made++; }
      catch (e) { console.warn("[Stashpad] shortcut create failed", path, e); }
    }
    this.notifications.show({
      message: made
        ? `Created ${made} switcher shortcut${made === 1 ? "" : "s"} in **${dir}**`
          + (existing ? ` (${existing} already existed).` : ". Open the quick switcher and type a folder name.")
        : `Every Stashpad folder already has a shortcut in **${dir}**.`,
      kind: "success",
      category: "system",
    });
  }

  /** Turn a shortcut stub into the Stashpad view it stands for.
   *
   *  Replaces the leaf rather than opening a second tab: the stub is a
   *  launcher, and leaving it behind would mean the switcher's result stays
   *  open as a stray markdown tab every time it is used. */
  private async openShortcutTarget(target: WorkspaceLeaf, file: TFile): Promise<boolean> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
      | { stashpadShortcut?: unknown } | undefined;
    const folder = typeof fm?.stashpadShortcut === "string" ? fm.stashpadShortcut.trim() : "";
    if (!folder) return false;
    await target.setViewState({ type: STASHPAD_VIEW_TYPE, state: { folderOverride: folder }, active: true });
    this.app.workspace.setActiveLeaf(target, { focus: true });
    return true;
  }

  /** Sweep every Stashpad note for un-previewed links.
   *
   *  Explicit only, and it ESTIMATES FIRST: an archive is thousands of
   *  requests, and starting that without saying how long it will take is
   *  indistinguishable from a hang. */
  async backfillLinkPreviews(): Promise<void> {
    const folders = new Set(this.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")));
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      return folders.has(dir) || [...folders].some((x) => dir.startsWith(x + "/"));
    });
    if (!files.length) { new Notice("No Stashpad notes found."); return; }

    const scanning = new Notice(`Scanning ${files.length} notes for links…`, 0);
    const signal = { cancelled: false };
    let scan;
    try { scan = await scanBackfill(this.app, this.previewCache, files, signal); }
    finally { scanning.hide(); }

    if (!scan.linkCount) { new Notice("Every link already has a preview — nothing to backfill."); return; }
    const secs = estimateSeconds(scan, this.settings.linkPreviewDelayMs);
    const toFetch = scan.linkCount - scan.cachedCount;
    const ok = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.app,
        "Backfill link previews?",
        `${scan.linkCount} link${scan.linkCount === 1 ? "" : "s"} across ${scan.files.length} note${scan.files.length === 1 ? "" : "s"} have no preview yet`
          + (scan.cachedCount ? `, and ${scan.cachedCount} of those are already cached` : "")
          + `. That means about ${toFetch} network request${toFetch === 1 ? "" : "s"}, so roughly `
          + `${humanDuration(secs)}. It runs in the background and you can keep working; notes are only ever appended to.`,
        "Start backfill",
        (c) => resolve(c),
        "Not now",
        true,
      ).open();
    });
    if (!ok) return;

    let done = 0, added = 0, failed = 0;
    const progress = new Notice("Backfilling link previews…", 0);
    for (const f of scan.files) {
      if (signal.cancelled) break;
      try {
        const r = await enrichFile(this.app, this.previewCache, f, {
          calloutType: this.settings.linkPreviewCallout,
          collapsed: this.settings.linkPreviewCollapsed,
          delayMs: this.settings.linkPreviewDelayMs,
        });
        added += r.added; failed += r.failed;
      } catch (e) { console.warn("[Stashpad] backfill failed for", f.path, e); failed++; }
      done++;
      progress.setMessage(`Backfilling link previews — ${done}/${scan.files.length} notes, ${added} added`);
    }
    progress.hide();
    this.notifications.show({
      message: `Backfill finished: ${added} preview${added === 1 ? "" : "s"} added across ${done} note${done === 1 ? "" : "s"}`
        + (failed ? `, ${failed} link${failed === 1 ? "" : "s"} couldn't be fetched.` : "."),
      kind: failed && !added ? "warning" : "success",
      category: "system",
      duration: 0,
    });
  }

  openDuplicatesModal(perFolder: { folder: string; groups: DuplicateIdGroup[] }[]): void {
    new DuplicateIdsModal(this.app, perFolder, {
      onDelete: (path, folder) => this.discardDuplicateCopy(path, folder),
      onMerge: (src, tgt, folder) => this.mergeDuplicateCopy(src, tgt, folder),
      rescan: () => this.duplicateGroupsEverywhere(),
      onRepair: async () => {
        let total = 0;
        for (const { folder, groups } of perFolder) {
          total += await this.repairDuplicateIds(folder, groups);
        }
        new Notice(total
          ? `Gave ${total} hidden note${total === 1 ? "" : "s"} a fresh id — they're visible now. Undo (in the list) reverses it per folder.`
          : "Nothing to repair — the remaining duplicates are home-note ids, which need a different fix.");
      },
    }).open();
  }

  async runIntegrityCheckOnFolder(folder: string): Promise<void> {
    const f = (folder || "").trim().replace(/\/+$/, "");
    if (!f) return;
    await this.runSweep(f, { silent: false });
  }

  private async runSweep(folder: string, opts: { silent: boolean }): Promise<void> {
    try {
      const log = this.newLog();
      // Build the current snapshot directly from the vault + metadataCache.
      const cur: Record<string, { parent: string | null; path: string }> = {};
      const files = this.app.vault.getMarkdownFiles().filter((f) =>
        f.path === folder || f.path.startsWith(folder + "/"),
      );
      for (const f of files) {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
          | { id?: string; parent?: string | null } | undefined;
        const id = typeof fm?.id === "string" ? fm.id.trim() : "";
        if (!id) continue;
        const parent = (fm && "parent" in fm ? (fm.parent ?? null) : null);
        cur[id] = { parent, path: f.path };
      }

      const prev = await log.readState();
      const inFolder = (path: string): boolean =>
        path === folder || path.startsWith(folder + "/");

      if (!opts.silent) {
        for (const [id, info] of Object.entries(cur)) {
          const before = prev[id];
          if (!before) {
            await log.append({ type: "create", id, payload: { path: info.path, parent: info.parent } });
          } else if (before.parent !== info.parent) {
            await log.append({ type: "parent_change", id, payload: { from: before.parent, to: info.parent } });
          } else if (before.path !== info.path) {
            await log.append({ type: "rename", id, payload: { from: before.path, to: info.path } });
          }
        }
        for (const [id, info] of Object.entries(prev)) {
          if (!cur[id] && inFolder(info.path)) {
            await log.append({ type: "missing", id, payload: { lastPath: info.path } });
          }
        }
      }
      // State refresh always happens — that's the whole point of the silent
      // pass. Without this, future sweeps would re-discover every change
      // made during this session as a fresh delta.

      const merged: Record<string, { parent: string | null; path: string }> = {};
      for (const [id, info] of Object.entries(prev)) if (!inFolder(info.path)) merged[id] = info;
      for (const [id, info] of Object.entries(cur)) merged[id] = info;
      await log.writeState(merged);
    } catch (e) {
      console.warn("Stashpad: integrity sweep failed", e);
    }
  }

  getUndoStack(folder: string): UndoStack {
    let s = this.undoStacks.get(folder);
    if (!s) { s = new UndoStack(); this.undoStacks.set(folder, s); }
    return s;
  }

  /** Mint a note id that doesn't collide with any id currently in the vault.
   *  Use this for EVERY note-creation site instead of bare newId(). Amortized
   *  O(1) — the used-id set is built once (lazily) and maintained by the
   *  metadataCache handler in onload. */
  /** Record that the user has seen (and answered) the first-run welcome, so it
   *  never asks twice. "later" counts as an answer — see WelcomeModal.onClose.
   *  Reopenable any time from Settings → Help & Getting started. */
  async markOnboardingAnswered(choice: OnboardingChoice): Promise<void> {
    this.settings.onboardingAnswered = true;
    this.settings.onboardingChoice = choice;
    await this.saveSettings();
  }

  /** Remember the folder the user is currently working in. Cheap and idempotent:
   *  returns immediately when nothing changed, so the active-leaf-change firehose
   *  doesn't write settings on every tab switch.
   *
   *  0.223.0: `lastUsedFolder` and `recentFolders` were being written together,
   *  which conflated two different questions:
   *    - lastUsedFolder = "which folder do I OPEN INTO on launch?"
   *    - recentFolders  = "which folders are worth offering as destinations?"
   *  A quick-send to another folder should feed the second and NOT the first —
   *  otherwise firing a note at some folder silently relocates where the plugin
   *  opens next time. Pass `{ opened: false }` for a send. */
  recordFolderUsed(folder: string, opts: { opened?: boolean } = {}): void {
    const cleaned = (folder || "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const opened = opts.opened !== false;
    const prev = this.settings.recentFolders ?? [];
    const next = [cleaned, ...prev.filter((f) => f !== cleaned)].slice(0, 8);
    const mruChanged = next.length !== prev.length || next.some((f, i) => f !== prev[i]);
    const lastChanged = opened && this.settings.lastUsedFolder !== cleaned;
    if (!mruChanged && !lastChanged) return;
    if (opened) this.settings.lastUsedFolder = cleaned;
    this.settings.recentFolders = next;
    void this.saveSettings();
  }

  /** 0.224.0: re-rank a folder list so pinned folders lead, in the SAME order
   *  the folders panel shows them (`folderPanelPinnedAt`, ascending), and
   *  downranked folders trail. Everything else keeps the order it came in with,
   *  so each caller's own sort (alphabetical, last-used-first) still decides
   *  the middle.
   *
   *  Pins are a statement about which Stashpads matter, so they should mean the
   *  same thing everywhere a folder list appears — not only in the panel where
   *  you set them. */
  rankFoldersByPin(folders: string[]): string[] {
    const clean = (f: string): string => (f || "").trim().replace(/^\/+|\/+$/g, "");
    const pinned = (this.settings.folderPanelPinned ?? []).map(clean);
    const at = this.settings.folderPanelPinnedAt ?? {};
    const down = new Set((this.settings.folderPanelDownranked ?? []).map(clean));
    const pinKey = (f: string): number => {
      const c = clean(f);
      const k = at[c];
      if (typeof k === "number") return k;
      const i = pinned.indexOf(c);
      return i >= 0 ? i : 0;
    };
    const lead: string[] = [], mid: string[] = [], tail: string[] = [];
    for (const f of folders) {
      if (pinned.includes(clean(f))) lead.push(f);
      else if (down.has(clean(f))) tail.push(f);
      else mid.push(f);
    }
    lead.sort((a, b) => pinKey(a) - pinKey(b));
    return [...lead, ...mid, ...tail];
  }

  /** Pin order key for one folder, or null when it isn't pinned. */
  folderPinRank(folder: string): number | null {
    const c = (folder || "").trim().replace(/^\/+|\/+$/g, "");
    const pinned = (this.settings.folderPanelPinned ?? []).map((f) => (f || "").trim().replace(/^\/+|\/+$/g, ""));
    const i = pinned.indexOf(c);
    if (i < 0) return null;
    const at = (this.settings.folderPanelPinnedAt ?? {})[c];
    return typeof at === "number" ? at : i;
  }

  /** 0.221.0: folders for the quick-destination menu — recently used first,
   *  topped up with the rest so a fresh install isn't empty. Excludes the
   *  folder you're composing in, since "send to where I already am" is what the
   *  plain send already does. */
  quickDestinationFolders(exclude: string, limit = 5): string[] {
    const all = this.discoverStashpadFolders();
    const recent = (this.settings.recentFolders ?? []).filter((f) => all.includes(f));
    const rest = all.filter((f) => !recent.includes(f));
    // 0.224.0: pinned folders lead, then most-recent, then the rest. The cap is
    // applied AFTER ranking, so a pin can push a stale recent off the short
    // list — which is the point of pinning.
    //
    // 0.270.3: EVERY pinned folder is offered, however many there are. The cap
    // limits only how many UNPINNED folders top the list up. Pinning is the
    // user saying "I want this one within reach", and a fixed cap of five was
    // silently dropping the sixth pin — the exact folder they had asked for.
    // Pins that overflow a menu are still one scroll away; a pin that is
    // absent is a broken promise.
    const ranked = this.rankFoldersByPin([...recent, ...rest]).filter((f) => f !== exclude);
    const pinnedSet = new Set(
      (this.settings.folderPanelPinned ?? []).map((f) => (f || "").trim().replace(/^\/+|\/+$/g, "")),
    );
    const pinned = ranked.filter((f) => pinnedSet.has(f));
    const unpinned = ranked.filter((f) => !pinnedSet.has(f));
    // All pins, then unpinned folders only up to the cap. With five or more
    // pins the menu is pins alone; with fewer, recents fill the remaining slots.
    const topUp = Math.max(0, limit - pinned.length);
    return [...pinned, ...unpinned.slice(0, topUp)];
  }

  /** 0.266.7: bring up both sidebars as part of setup.
   *
   *  Each has had its own command for a long time, which is no help to someone
   *  who doesn't yet know the panels exist. Sequential rather than parallel:
   *  both attach to the workspace, and racing two setViewState calls into the
   *  same sidebar is how you get one of them silently dropped. */
  async openSetupPanels(): Promise<void> {
    await openFolderPanelView(this.app);
    await openStashpadPanelsView(this.app);
  }

  /** Open the first-run welcome on demand (command palette / settings button),
   *  regardless of whether it has already been answered. */
  showWelcome(): void {
    new WelcomeModal(this.app, this).open();
  }

  /** Seed the example content into a fresh folder and open it. Used by the
   *  command palette and the empty-state button. Picks a free folder name
   *  rather than merging into an existing Stashpad — the demo is meant to be
   *  explored and thrown away, not mixed into someone's real notes. */
  async createDemoStashpad(): Promise<void> {
    const base = `${DEFAULT_STASHPAD_FOLDER} demo`;
    let folder = base;
    for (let i = 2; await this.app.vault.adapter.exists(folder); i++) folder = `${base} ${i}`;
    try {
      const { created } = await seedDemoContent(this.app, this, folder);
      new Notice(`Stashpad: created "${folder}" with ${created} example notes.`, 8000);
      await this.openFolderInStashpad(folder);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Stashpad: couldn't create the demo — ${msg}`, 0);
    }
  }

  mintNoteId(): string {
    if (this.usedNoteIds === null) this.rebuildUsedNoteIds();
    const set = this.usedNoteIds!;
    const id = freshId((c) => set.has(c));
    set.add(id); // reserve immediately so a batch of creates can't collide
    return id;
  }

  private rebuildUsedNoteIds(): void {
    const set = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = (this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" && id.trim()) set.add(id.trim());
    }
    this.usedNoteIds = set;
  }

  async onload(): Promise<void> {
    // 0.268.9: rotate the previous session's trace FIRST — before settings load,
    // before migrations, before anything can emit a line. This used to sit after
    // several awaits, and the new session's own first flush beat it to the file.
    //
    // Unconditional, because settings aren't loaded yet and the file's existence
    // is the only question that matters: if one is there, it belongs to the run
    // that just ended, and after a force-quit it is the only copy. Whether the
    // user still wants tracing at all is settled below, once settings are read.
    try { await this.rotateTraceFile(); } catch { /* best-effort */ }
    this.traceRotateDone = true;
    this.startStallWatchdog();
    this.installSelectAllProbe();
    this.installStashpadNoteRouter();
    // Keep the dedup-at-creation id index current as files are parsed (our own
    // creates AND notes synced in from other devices). Never removes on delete —
    // a stale id only forces a re-roll, which is safe.
    this.registerEvent(this.app.metadataCache.on("changed", (_file, _data, cache) => {
      const id = (cache?.frontmatter as { id?: unknown } | undefined)?.id;
      if (this.usedNoteIds && typeof id === "string" && id.trim()) this.usedNoteIds.add(id.trim());
    }));
    // Migrate any legacy state from the OLD locations (vault root
    // .stashpad/ and the default plugin-folder data.json) into the
    // NEW private folder under <pluginDir>/.stashpad/. Runs before
    // loadSettings so the data.json move is in place when we read.
    await this.migrateLegacyPaths();
    await this.loadSettings();
    // Before perf.enabled is read from it: a diagnostic left on for over a
    // week switches itself back off here.
    await this.expireStaleDiagnostics();
    // 0.268.8: move the previous session's trace file aside BEFORE anything
    // starts writing the new one. If that session was force-quit, this is the
    // only surviving copy — rotating rather than overwriting is the whole
    // reason the file is useful. Runs after expireStaleDiagnostics so a trace
    // that just aged out doesn't leave a rotated file nobody asked for.
    // Rotation already happened at the top of onload. All that's left is to
    // clean up when tracing is off, so an install that never uses it (or one
    // whose diagnostic just aged out above) keeps no files around.
    // Clean up when either switch is off, so turning persistence off leaves no
    // file behind for a later session to rotate and hand back.
    if (!this.settings.debugTrace || !this.settings.debugTracePersist) await this.removeTraceFiles();
    perf.enabled = !!this.settings.enablePerfProfiling;
    this.encryption = new EncryptionService(
      this.app,
      // Merge defaults so a settings blob written by an older (v1) version still
      // satisfies the v2 identity fields (they read as null until set up).
      () => ({ ...defaultEncryptionConfig(), ...(this.settings.encryption ?? {}) }),
      async (cfg) => { this.settings.encryption = cfg; await this.saveSettings(); },
    );
    // Load the `.stashkey` index (+ any legacy keyfile folderKeys) into the
    // service's cache. (0.143.0: no vault auto-unlock on load — each folder key
    // auto-unlocks lazily from the keychain the first time its content is accessed,
    // so nothing prompts at startup and it stays seamless.)
    void this.encryption.init().then(async () => {
      // keyfile-removal Phase 3: transparently relocate any legacy keyfile folder
      // keys into per-folder `.stashkey` files (additive; keyfile kept as backup).
      try {
        const n = await this.encryption.migrateKeyfileToStashKeys();
        if (n > 0) new Notice(`Stashpad: moved ${n} folder key${n === 1 ? "" : "s"} to the new per-folder format.`);
      } catch (e) { console.warn("[Stashpad] folder-key migration failed (keyfile still works)", e); }
    });
    // 0.139.0: peek auto-re-encrypt scheduler (opt-in; no-ops until a delay is set).
    this.reEncryptScheduler = new ReEncryptScheduler(this);
    this.reEncryptScheduler.start();
    // Reconcile the locked-subtree registry from on-disk `.stashmeta` sidecars
    // (recovers placeholder placement after a settings desync or cross-device
    // sync). Deferred to onLayoutReady (below) so it runs AFTER the vault has
    // finished indexing the `.stashenc` blobs — running it during onload once
    // wiped the registry against an empty file index.
    this.settingTab = new StashpadSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    // 0.231.0: getSettingDefinitions() is called ONCE, here at registration,
    // and the result is cached in the tab's `settingItems`. Any definition
    // derived from the VAULT rather than from settings is therefore computed
    // against a metadata cache that has not finished indexing yet — which is
    // how the cross-Stashpad search-scope group baked in "No Stashpads found"
    // permanently (0.229.0 regression: the pre-port code discovered folders
    // inside a lazy render callback, so it never saw the cold cache).
    //
    // update() re-runs getSettingDefinitions() and replaces the cache, so one
    // refresh once the cache is warm is all this needs. Signature-gated so a
    // chatty "resolved" event doesn't rebuild the whole settings tree on every
    // fire, and so a Stashpad created or deleted later is also picked up.
    this.app.workspace.onLayoutReady(() => {
      this.refreshSettingsIfStashpadsChanged();
      this.registerEvent(
        this.app.metadataCache.on("resolved", () => this.refreshSettingsIfStashpadsChanged()),
      );
    });

    // 0.83.2: load the persisted render cache before views open, so the
    // first cold paint can hit it instead of reading every body over the
    // (possibly slow) drive.
    await this.renderCacheStore.load();
    // Evict cache rows when their file goes away — an entry holds the full
    // body + HTML, and after an encryption lock/secure-delete it would be the
    // last readable plaintext copy, sitting in render-cache.json.
    this.registerEvent(this.app.vault.on("delete", (f) => this.renderCacheStore.evict(f.path)));
    this.registerEvent(this.app.vault.on("rename", (_f, oldPath) => this.renderCacheStore.evict(oldPath)));
    // Fork siblings: when a family member is deleted (single / subtree / multi /
    // fork-undo), drop it from every other member's `fork-siblings`. Debounced
    // so a burst of deletes triggers one vault scan. (Renames are handled by
    // Obsidian's own wikilink updater.)
    const pruneForkSiblings = debounce(() => void this.flushForkSiblingPrune(), 250, true);
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (f instanceof TFile && f.extension === "md") { this.pendingForkDeletes.add(f.basename); pruneForkSiblings(); }
    }));
    // 0.102.x: OKF auto-rebuild — when a note is added/deleted/moved in an OKF
    // folder, refresh that folder's OKF frontmatter + index.md (debounced). Gated
    // through okfActiveFolders so it never runs when OKF is off / for non-OKF /
    // archive folders. Frontmatter writes are "modify" events (not listened here),
    // so this can't loop on its own work; index.md is ignored explicitly.
    // 0.265.0: automatic link previews, when enabled. Both events matter — a
    // note arriving from the share sheet or a sync fires `create`, not
    // `modify`, and that inbound case is the main reason to want this on.
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "md") this.queueAutoPreview(f);
    }));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f instanceof TFile && f.extension === "md") this.queueAutoPreview(f);
    }));
    // 0.266.1: a shortcut stub swaps itself for the Stashpad it names.
    // 0.266.1: `active-leaf-change`, NOT `file-open`. Measured with listeners
    // on all three: opening a file raises active-leaf-change and layout-change
    // but never file-open, so a file-open hook did nothing at all. This also
    // hands us the leaf directly, so there is no lookup to get wrong.
    //
    // Terminates on its own: the swapped leaf is a Stashpad view, which fails
    // the markdown test on the re-entrant event.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!leaf) return;
      const file = (leaf.view as unknown as { file?: TFile }).file;
      if (leaf.view?.getViewType?.() !== "markdown" || !file || file.extension !== "md") return;
      if (!file.path.startsWith(SHORTCUT_DIR + "/")) return;   // cheap reject before reading metadata
      window.setTimeout(() => { void this.openShortcutTarget(leaf, file); }, 0);
    }));
    this.registerEvent(this.app.vault.on("create", (f) => this.onOkfFileEvent(f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onOkfFileEvent(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { this.onOkfFileEvent(f.path); this.onOkfFileEvent(oldPath); }));
    // 0.77.1: load the author registry and seed it with the local user.
    await this.authorRegistry.load();
    {
      const id = (this.settings.authorId ?? "").trim();
      if (id) {
        this.authorRegistry.record({
          id,
          name: this.settings.authorName,
          role: this.settings.authorRole,
          department: this.settings.authorDepartment,
        });
      }
    }
    // 0.77.7: backfill the local user's author page into any existing
    // Stashpad folder that lacks it. Deferred + after the metadata cache
    // has settled so folder discovery + the "already has my stub" check
    // are accurate (avoids creating a duplicate before the cache lists
    // the existing one). New folders are seeded at creation time instead.
    // 0.112.0: keep the fast encryption-state index honest — drop a pending blob
    // once the vault indexes it (then getFiles() covers it), and reflect external
    // or synced deletes so a stale pending entry can't falsely report "locked".
    this.registerEvent(this.app.vault.on("create", (f) => { if (f.path.endsWith(".stashenc")) this.pendingEncBlobs.delete(f.path); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (f.path.endsWith(".stashenc")) this.pendingEncBlobs.delete(f.path); }));
    this.app.workspace.onLayoutReady(() => {
      // First-run welcome. MUST wait for layout-ready + a settle delay: the
      // gate counts existing Stashpad folders, and discoverStashpadFolders()
      // reads frontmatter from the metadata cache, which isn't populated yet
      // during onload. Asking too early would report zero folders for an
      // existing user and greet them as if they were new.
      window.setTimeout(() => {
        if (!shouldShowWelcome(this)) return;
        new WelcomeModal(this.app, this).open();
      }, 2500);
      // Vault is fully indexed now — safe to reconcile locked placeholders
      // (drop entries whose blob is truly gone, add cross-device blobs).
      void this.reconcileLockedRegistry();
      // 0.136.0/0.137.0: one-time migrations to per-folder archive + trash
      // subfolders, then (B5) prune any zombie legacy entries.
      window.setTimeout(async () => {
        try { await this.migrateArchiveFoldersToSubfolders(); } catch (e) { console.error("[Stashpad] archive migration failed", e); }
        try { await this.migrateDeletedToTrashSubfolders(); } catch (e) { console.error("[Stashpad] trash migration failed", e); }
        void this.pruneZombieArchiveEntries();
      }, 5000);
      // 0.138.0: opt-in nudge — previously-encrypted notes still plaintext.
      window.setTimeout(() => {
        if (!this.settings.reEncryptNudge) return;
        const k = this.reEncryptWatching().length;
        if (k === 0) return;
        const n = new Notice("", 0);
        n.noticeEl.createSpan({ text: `\u{1F513} ${k} previously-encrypted note${k === 1 ? " is" : "s are"} still plaintext. ` });
        const b = n.noticeEl.createEl("button", { text: "Review" });
        b.onclick = () => { n.hide(); void openAggregateView(this, "watch"); };
      }, 8000);
      // 0.99.19: fire reminders for tasks that came due while Obsidian was
      // closed (delay so the metadata cache is populated), then re-check on an
      // interval so tasks coming due while it's open also surface.
      window.setTimeout(() => void this.checkDueReminders(), 6000);
      this.registerInterval(window.setInterval(() => void this.checkDueReminders(), 5 * 60 * 1000));
      window.setTimeout(() => { void this.seedLocalAuthorStubsEverywhere(); }, 4000);
      // 0.79.12: register each Stashpad folder's _archive in Obsidian's
      // "Excluded files" so native search / quick switcher / graph / link
      // suggestions de-prioritise the import-originals graveyard.
      window.setTimeout(() => this.syncObsidianExcludedArchives(), 4500);
      // 0.79.15: arm auto-import only AFTER the startup create-storm has
      // passed (Obsidian replays a create event for every existing file on
      // load). Until armed, enqueue() ignores events — so opening the vault
      // never looks like a mass "drop".
      window.setTimeout(() => this.importService.setArmed(true), 2500);
      // 0.84.11: retroactive auto-import — a startup sweep (after arming) so
      // items added while Obsidian was closed get imported, plus a 5-min
      // interval so external Finder copies that never fired a vault event are
      // eventually caught. Both no-op unless autoImport is on. registerInterval
      // is auto-cleared on unload.
      window.setTimeout(() => void this.runAutoImportSweep(), 5000);
      this.registerInterval(window.setInterval(() => void this.runAutoImportSweep(), 5 * 60 * 1000));
      // 0.86.3: migrate legacy per-device pinned list → note frontmatter (so
      // pins sync). After the metadata cache has settled so fileForPin resolves.
      window.setTimeout(() => void this.migratePinnedNotesToFrontmatter(), 3000);
      // 0.89.1: if this load follows our update-reload, un-ghost the deferred
      // Stashpad tabs so they render with the fresh code (no blank tabs/buttons).
      window.setTimeout(() => void this.unghostStashpadTabsIfFlagged(), 1200);
    });

    this.registerView(
      STASHPAD_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadView(leaf, this),
    );
    // 0.74.1: right-sidebar detail panel.
    this.registerView(
      STASHPAD_DETAIL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadDetailView(leaf, this),
    );
    // 0.68.0: sidebar panels view (Pinned Notes + future panels).
    this.registerView(
      STASHPAD_PANELS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadPanelsView(leaf, this),
    );
    // 0.98.35: encrypted-trash tab (recoverable deleted notes, grouped by origin).
    this.registerView(
      STASHPAD_TRASH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadTrashView(leaf, this),
    );
    // Per-folder overhaul (Phase A): on-the-fly "All encrypted" / "All archived"
    // aggregate tabs (read-only list + navigate). The "deleted" aggregate is the
    // trash view above.
    this.registerView(
      STASHPAD_AGGREGATE_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadAggregateView(leaf, this),
    );
    this.registerView(
      STASHPAD_FOLDER_PANEL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new StashpadFolderPanelView(leaf, this),
    );
    // 0.169.0: the "pop out" full-tab host for the Split-note UI (long text / mobile).
    this.registerView(
      WORKBENCH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new NoteWorkbenchView(leaf),
    );
    // 0.193.0: same idea for the paste-text importer — a long outline is cramped in
    // a modal, so it can pop out into a full tab.
    this.registerView(
      TEXT_IMPORT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new TextImportView(leaf),
    );
    // 0.216.0: the desktop-app importer gets the same treatment — it takes files
    // and shows a per-file receipt, which needs more room than a modal gives.
    this.registerView(
      APP_IMPORT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AppImportView(leaf),
    );
    // Deep links: `obsidian://stashpad?folder=…&note=<id>&run=reveal[,open]`.
    // Routes into the Stashpad view, reveals a note, runs a small macro. See
    // `docs/deep-links-plan.md`. (Obsidian only allows an action under its own
    // scheme, not a custom `stashpad://`.)
    this.registerObsidianProtocolHandler(STASHPAD_PROTOCOL_ACTION, (params) => {
      void this.handleDeepLink(params);
    });
    // 0.68.1: track the most-recently-active Stashpad leaf so the
    // sidebar panel's Search / Home buttons target the leaf the user
    // last worked in — not "leaves[0]" (= leftmost tab) which has
    // nothing to do with recency.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf && leaf.view.getViewType() === STASHPAD_VIEW_TYPE) {
        this.lastActiveStashpadLeaf = leaf;
        // 0.208.2: remember the folder you were last actually looking at, so the
        // folder switcher can rank it first. Hooked here rather than at the
        // open() call sites because this fires for EVERY way a folder becomes
        // current — picker, ribbon, deep link, or a tab restored at startup.
        //
        // Deferred a tick on purpose: for a NEWLY opened view this event fires
        // before the view's own onOpen/loadConfig has established noteFolder, so
        // reading it synchronously yields "" and the folder is never recorded.
        // (Caught in testing — lastUsedFolder stayed empty with a view open.)
        setTimeout(() => this.recordFolderUsed(((leaf.view as any)?.noteFolder ?? "").trim()), 0);
        // 0.74.1: auto-open the right-sidebar detail panel when the
        // user enters a Stashpad view, if the setting is on AND the
        // panel isn't already open. Defer one tick so the leaf is
        // fully settled before we touch workspace state.
        if (this.settings.autoOpenDetailPanel) {
          const existing = this.app.workspace.getLeavesOfType(STASHPAD_DETAIL_VIEW_TYPE);
          if (existing.length === 0) {
            setTimeout(() => { void openStashpadDetailView(this.app); }, 0);
          }
        }
        // Always notify selection listeners when the active leaf
        // becomes a Stashpad — the detail panel needs to refresh to
        // match the new leaf's cursor row even if the leaf was open
        // all along.
        this.notifyStashpadSelectionChanged();
      }
    }));

    // Toggle a body class while a Stashpad view is the active leaf, so
    // CSS can hide Obsidian's mobile toolbar (or other chrome we don't
    // want) only when the user is in a Stashpad. Listens to BOTH the
    // workspace's active-leaf-change (catches tab switching) and our own
    // active-view notifications (catches focus shifts within the view).
    //
    // NOTE (0.51.13): the .stashpad-hide-mobile-toolbar class doesn't
    // appear to actually hide the toolbar on current Obsidian mobile
    // builds — the user-facing setting was removed because flipping it
    // had no observable effect. The body-class toggling is kept so a
    // future fix (CSS targeting the right element, or a different DOM
    // hook entirely) just needs to update styles.css. `.stashpad-active`
    // is still useful on its own as a generic "Stashpad view is focused"
    // marker for other CSS rules.
    const refreshActiveClass = (): void => {
      const v = getActiveView();
      const stashpadActive = !!v
        && this.app.workspace.activeLeaf
        && this.app.workspace.activeLeaf.view === v;
      const wantHide = !!stashpadActive && this.settings.hideMobileToolbarInStashpad;
      document.body.classList.toggle("stashpad-hide-mobile-toolbar", wantHide);
      document.body.classList.toggle("stashpad-active", !!stashpadActive);
    };
    this.register(onActiveViewChange(refreshActiveClass));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refreshActiveClass));

    // 0.61.9: Obsidian popout windows don't automatically inherit
    // plugin stylesheets — opening a Stashpad view in a popout (tiny
    // mode, "open in new window" button, native Obsidian popout) means
    // our CSS rules silently no-op. Clone every <style> tag from the
    // main document into each popout window on open. Also do an
    // immediate pass for popouts that already exist.
    const injectStashpadStyles = (popoutDoc: Document): void => {
      try {
        // Only clone OUR stylesheets — they have hashes Obsidian adds.
        // The cheapest reliable filter: any <style> whose text mentions
        // `.stashpad-` (we use that prefix everywhere).
        const own = Array.from(document.querySelectorAll("style"))
          .filter((s) => (s.textContent ?? "").includes(".stashpad-"));
        for (const s of own) {
          // Skip if already cloned (by data-stashpad attr).
          const id = s.id || "";
          const sel = id ? `style[data-stashpad-source="${id}"]` : null;
          if (sel && popoutDoc.head.querySelector(sel)) continue;
          const clone = popoutDoc.createElement("style");
          if (id) clone.setAttribute("data-stashpad-source", id);
          else clone.setAttribute("data-stashpad-source", "anon");
          clone.textContent = s.textContent ?? "";
          popoutDoc.head.appendChild(clone);
        }
      } catch (e) {
        console.warn("[Stashpad] inject popout styles failed", e);
      }
    };
    this.registerEvent((this.app.workspace as any).on("window-open", (win: any) => {
      const doc = win?.doc ?? win?.win?.document ?? null;
      if (doc) injectStashpadStyles(doc);
    }));

    // 0.93.0: file-explorer context menu → "Open folder in Stashpad", but ONLY
    // for folders that are ALREADY Stashpad folders (have at least one Stashpad
    // note). Lets you jump into an existing Stashpad from the file nav without
    // turning every folder's menu into a Stashpad entry-point.
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFolder)) return;
      const path = file.path.replace(/\/+$/, "");
      // "Encrypt with Stashpad" on ANY folder (incl. import-excluded subfolders that
      // aren't surfaced as Stashpad folders) — the entry point for encrypting a
      // folder straight from Obsidian's file explorer.
      menu.addItem((item) => item.setTitle("🔒 Encrypt with Stashpad").setIcon("lock").onClick(() => void this.encryptFolderFromExplorer(path)));
      // Offer "Decrypt with Stashpad" only when this looks like a raw-folder bundle: a
      // `.stashenc` child in a folder that is NOT a Stashpad-notes folder. (A Stashpad
      // folder's `.stashenc` children are locked NOTES, not a bundle — showing Decrypt
      // there would be a confusing no-op.) The menu builder is sync, so we can't read the
      // sidecar kind here; the click handler validates via rawFolderBlobIn. This keeps the
      // 90% case clean — only a fully-locked Stashpad folder (no discoverable notes) could
      // still mis-show it, and the handler no-ops gracefully there.
      const hasBlob = file.children?.some((c) => c instanceof TFile && c.extension === "stashenc");
      if (hasBlob && !this.folderHasStashpadNotes(path)) {
        menu.addItem((item) => item.setTitle("🔓 Decrypt with Stashpad").setIcon("unlock").onClick(() => void this.decryptFolderFromExplorer(path)));
      }
      if (!this.discoverStashpadFolders().includes(path)) return;
      menu.addItem((item) => {
        item
          .setTitle("Open folder in Stashpad")
          .setIcon("layout-list")
          .onClick(() => void this.openFolderInStashpad(path));
      });
    }));
    // 0.174.0: "Open in Stashpad" on a non-md ATTACHMENT file — jumps to the
    // Stashpad note that embeds it (picker when several do). Only shows when at
    // least one Stashpad note actually references the file.
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension === "md") return;
      const notes = this.findStashpadNotesEmbedding(file);
      if (notes.length === 0) return;
      menu.addItem((item) => item
        .setTitle(notes.length > 1 ? "Open in Stashpad…" : "Open in Stashpad")
        .setIcon("layout-list")
        .onClick(() => void this.revealAttachmentInStashpad(file, notes)));
    }));
    // Existing popouts at plugin-load time (e.g. after a reload while
    // a tiny window was open) — walk all known windows and inject.
    setTimeout(() => {
      try {
        const ws = this.app.workspace as any;
        if (typeof ws.iterateAllLeaves === "function") {
          ws.iterateAllLeaves((leaf: any) => {
            const d = leaf?.view?.containerEl?.ownerDocument;
            if (d && d !== document) injectStashpadStyles(d);
          });
        }
      } catch { /* ignore */ }
    }, 200);
    refreshActiveClass();
    // Re-evaluate when settings change (the toggle could have flipped).
    this.register(() => document.body.classList.remove("stashpad-hide-mobile-toolbar", "stashpad-active"));

    // Mobile: keep two CSS variables on body up to date so the view
    // can reserve the right amount of bottom space:
    //   --stashpad-toolbar-h : measured height of Obsidian's docked
    //                          mobile toolbar (0 when not present).
    //   --stashpad-vv-bottom-gap : difference between window.innerHeight
    //                              and visualViewport.height (the
    //                              keyboard's height when open, 0 when
    //                              closed).
    const vv: VisualViewport | undefined = (window as any).visualViewport;
    const refreshGeometry = (): void => {
      // Toolbar measurement: try a few selectors Obsidian has used.
      const toolbar = document.querySelector(
        ".mobile-toolbar, .mobile-toolbar-container",
      ) as HTMLElement | null;
      const tbH = toolbar && toolbar.isConnected ? toolbar.offsetHeight : 0;
      document.body.style.setProperty("--stashpad-toolbar-h", `${tbH}px`);
      // Keyboard height via visualViewport.
      let kbH = 0;
      if (vv) kbH = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.body.style.setProperty("--stashpad-vv-bottom-gap", `${kbH}px`);
      document.body.classList.toggle("stashpad-keyboard-open", kbH > 100);
    };
    refreshGeometry();
    if (vv) {
      vv.addEventListener("resize", refreshGeometry);
      vv.addEventListener("scroll", refreshGeometry);
      this.register(() => {
        vv.removeEventListener("resize", refreshGeometry);
        vv.removeEventListener("scroll", refreshGeometry);
      });
    }
    window.addEventListener("resize", refreshGeometry);
    this.register(() => window.removeEventListener("resize", refreshGeometry));
    // Re-measure on a short interval too — the toolbar may mount AFTER
    // initial onload, and there's no clean event for "Obsidian finished
    // attaching the mobile toolbar." A few RAF/timeout passes catch it.
    requestAnimationFrame(refreshGeometry);
    setTimeout(refreshGeometry, 250);
    setTimeout(refreshGeometry, 1000);

    // 0.208.2: ONE folder-count rule, shared by the ribbon and the open command.
    // They used to disagree — the ribbon showed the picker at >=1 folder while
    // the command only showed it at >=2 — so at exactly one folder the ribbon
    // popped a picker containing a single entry (a modal to choose between one
    // option) while the command just opened it. The fresh-install click was also
    // the only ribbon click that behaved differently from every later one.
    //
    // The rule now, everywhere: 0 → welcome (never silently create), 1 → open it,
    // 2+ → picker. The picker is deliberately kept for 2+ rather than auto-opening
    // the last-used folder, so nothing is opened or converted without being asked;
    // last-used is merely ranked first inside it.
    const openStashpadEntryPoint = (): void => {
      const folders = this.discoverStashpadFolders();
      if (folders.length === 0) { this.showWelcome(); return; }
      if (folders.length === 1) { void this.openFolderInStashpad(folders[0]); return; }
      this.openFolderPicker();
    };
    // Icon: stacked rectangles, reading as a pile of notes. "list-tree" implied a
    // file-tree, which is the one thing Stashpad's view is not.
    const ribbon = this.addRibbonIcon("square-stack", "Open Stashpad", () => {
      openStashpadEntryPoint();
    });
    ribbon.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.openFolderPicker();
    });

    // 0.68.1: ribbon icon for the sidebar panels view — installed by
    // default so users discover it without running a command first.
    // The matching command-palette entry still works as a restore
    // path if the user removes the ribbon icon.
    this.addRibbonIcon("panel-left", "Open Stashpad panels (sidebar)", () => {
      void openStashpadPanelsView(this.app);
    });
    // 0.86.1: folder panel ribbon entry — the main way to open it on mobile
    // (commands are buried; the other sidebar panels are reached via ribbon).
    this.addRibbonIcon("folders", "Open Stashpad folder panel (sidebar)", () => {
      void openFolderPanelView(this.app);
    });
    // 0.74.1: right-sidebar detail panel ribbon entry.
    this.addRibbonIcon("panel-right", "Open Stashpad detail panel (right sidebar)", () => {
      void openStashpadDetailView(this.app);
    });

    // Shares openStashpadEntryPoint with the ribbon (0.208.2) so the two can't
    // drift apart again.
    this.addCommand({
      id: "stashpad-open",
      name: "Open Stashpad in new tab",
      callback: () => { openStashpadEntryPoint(); },
    });
    // Onboarding, reachable forever — not just on first run. Named with the
    // words someone actually types when they're lost ("getting started",
    // "welcome", "setup") so fuzzy search finds it.
    // 0.209.2: capture the selection pipeline right after a bad Mod+A. Reports
    // through THREE channels on purpose: a Notice (readable immediately, no
    // setup), the clipboard (pasteable into a bug report), and the debug trace
    // (so it lands in the existing Diagnostics copy-out when tracing is on).
    // It mutates nothing, so running it does not disturb the state being
    // diagnosed.
    // Desktop only — checkCallback so it does not appear in the palette on mobile,
    // where showItemInFolder does not exist.
    this.addCommand({
      id: "stashpad-reveal-in-file-manager",
      name: "Reveal selected notes in Finder / file manager",
      checkCallback: (checking: boolean) => {
        if (Platform.isMobile) return false;
        const view = getActiveView();
        if (!view) return false;
        if (!checking) void view.cmdRevealInFileManager();
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-selection-diagnostics",
      name: "Diagnose selection (select-all mismatch)",
      callback: () => {
        const view = getActiveView();
        if (!view) { new Notice("Open a Stashpad view first, then run this right after the bad selection."); return; }
        const snap = view.selectionDiagnostics();
        const report = JSON.stringify(snap, null, 2);
        this.trace("selection-diagnostics", snap);
        const shortfall = (snap.currentChildren as number) - (snap.actionTargets as number);
        const headline = shortfall > 0
          ? `⚠️ ${snap.actionTargets} of ${snap.currentChildren} listed notes would be acted on (${shortfall} short).`
          : `✅ All ${snap.currentChildren} listed notes are selected and actionable.`;
        const n = new Notice("", 0);
        n.noticeEl.createDiv({ text: headline });
        n.noticeEl.createDiv({ text: `tree ${snap.treeChildrenOfFocus} · list ${snap.currentChildren} · selected ${snap.selectionSize} · targets ${snap.actionTargets}` });
        if ((snap.selectedWithoutFile as number) > 0) {
          n.noticeEl.createDiv({ text: `${snap.selectedWithoutFile} selected note(s) have no file yet — those are dropped by actions.` });
        }
        if ((snap.selectedNotInTree as number) > 0) {
          n.noticeEl.createDiv({ text: `${snap.selectedNotInTree} selected id(s) are no longer in the tree.` });
        }
        // Class, not an inline style: the community-store lint
        // (obsidianmd/no-static-styles-assignment) rejects assigning a literal to
        // element.style, and it is the only such assignment in the codebase — the
        // rest compute their values, which the rule allows.
        const copy = n.noticeEl.createEl("button", { text: "Copy full report", cls: "mod-cta stashpad-diag-copy-btn" });
        copy.addEventListener("click", () => {
          void writeClipboardText(report).then(() => new Notice("Selection report copied.", 3000));
        });
      },
    });
    this.addCommand({
      id: "stashpad-welcome",
      name: "Getting started (welcome / setup)",
      callback: () => this.showWelcome(),
    });
    this.addCommand({
      id: "stashpad-create-demo",
      name: "Create example (demo) content in a new Stashpad",
      callback: () => { void this.createDemoStashpad(); },
    });
    this.addCommand({
      id: "stashpad-reveal",
      name: "Reveal or open Stashpad",
      callback: () => void this.activateView({ reveal: true }),
    });
    // 0.95.3: bounce focus between the Stashpad side panels and your work.
    // Layout-independent (no left/right/up/down geometry): "focus tab" snaps to
    // the Stashpad tab you were last in; "focus panel" reveals the folder panel.
    this.addCommand({
      id: "stashpad-focus-last-tab",
      name: "Focus last Stashpad tab",
      callback: () => void this.focusLastStashpadTab(),
    });
    this.addCommand({
      id: "stashpad-focus-folder-panel",
      name: "Focus folder panel",
      callback: () => void this.focusFolderPanel(),
    });
    // (0.135.0: the "Lock encryption (forget password)" command is removed along
    // with the settings "Lock now" buttons and the idle auto-lock — the session
    // key now simply lives until Obsidian closes.)

    const call = (method: string, ...args: unknown[]) => {
      const v = getActiveView();
      if (v && typeof v[method] === "function") v[method](...args);
    };

    this.addCommand({
      id: "stashpad-toggle-split",
      name: "Toggle split-on-newlines",
      callback: () => call("toggleSplit"),
    });
    this.addCommand({
      id: "stashpad-fork-version",
      name: "Fork as a version (alternate draft in this sheet)",
      callback: () => call("cmdForkVersion"),
    });
    this.addCommand({
      id: "stashpad-mark-version-final",
      name: "Mark version as final (sheet)",
      callback: () => call("cmdMarkVersionFinal"),
    });
    // 0.214.0: the deliberate cross-vault copy/cut. Plain copy/cut no longer
    // builds the payload, so these are how notes travel between vaults. Paste
    // deliberately has NO counterpart command — cmdPasteNotes already detects a
    // cross-vault payload on the clipboard and routes to it, so Mod+V covers
    // both cases and a second command would just be a redundant door.
    this.addCommand({
      id: "stashpad-copy-for-other-vault",
      name: "Copy for another vault (cross-vault copy)",
      callback: () => call("cmdCopyForOtherVault"),
    });
    this.addCommand({
      id: "stashpad-cut-for-other-vault",
      name: "Cut for another vault (cross-vault move)",
      callback: () => call("cmdCutForOtherVault"),
    });
    this.addCommand({
      id: "stashpad-command-palette",
      name: "Command palette (Stashpad only)",
      callback: () => call("openStashpadCommandPalette"),
    });
    this.addCommand({
      id: "stashpad-lock-selection",
      name: "Encrypt (lock) selection (notes + children)",
      callback: () => call("cmdLockSelection"),
    });
    this.addCommand({
      id: "stashpad-lock-selection-hide-name",
      name: "Encrypt (lock) selection + hide filename (override folder setting)",
      callback: () => call("cmdLockSelectionHideName"),
    });
    this.addCommand({
      id: "stashpad-unlock-all",
      name: "Decrypt (unlock) locked notes in view",
      callback: () => call("cmdUnlockAll"),
    });
    this.addCommand({
      id: "stashpad-unlock-all-vault",
      name: "Decrypt (unlock) ALL locked notes in the vault",
      callback: () => void this.unlockAllInVault(),
    });
    // 0.99.0: note clipboard — copy/cut/paste of note blocks.
    this.addCommand({
      id: "stashpad-copy-notes",
      name: "Copy notes (note clipboard — paste to duplicate)",
      callback: () => call("cmdCopyNotes"),
    });
    this.addCommand({
      id: "stashpad-cut-notes",
      name: "Cut notes (paste in list to move, in composer to extract text)",
      callback: () => call("cmdCutNotes"),
    });
    this.addCommand({
      id: "stashpad-paste-notes",
      name: "Paste notes (from the note clipboard)",
      callback: () => call("cmdPasteNotes"),
    });
    this.addCommand({
      id: "stashpad-move-to-archive",
      name: "Move selection to archive",
      callback: () => call("cmdMoveToArchive"),
    });
    this.addCommand({
      id: "stashpad-encrypt-delete",
      name: "Encrypt (lock) & delete selection (to encrypted trash)",
      callback: () => call("cmdEncryptDelete"),
    });
    this.addCommand({
      id: "stashpad-delete-unencrypted",
      name: "Delete selection to Obsidian's trash (unencrypted)",
      callback: () => call("cmdDeleteUnencrypted"),
    });
    this.addCommand({
      id: "stashpad-restore-trash",
      name: "Open aggregated Trash view",
      callback: () => this.openEncryptedTrash(),
    });
    // Per-folder overhaul (Phase A): the on-the-fly aggregate tabs.
    this.addCommand({
      id: "stashpad-open-all-encrypted",
      name: "Open aggregated Encrypted notes view",
      callback: () => void openAggregateView(this, "encrypted"),
    });
    this.addCommand({
      id: "stashpad-open-all-archived",
      name: "Open aggregated Archived view",
      callback: () => void openAggregateView(this, "archived"),
    });
    // 0.126.1: tasks as a full tab too (alongside the sidebar panel + review modal).
    this.addCommand({
      id: "stashpad-open-all-tasks",
      name: "Open aggregated Tasks view",
      callback: () => void openAggregateView(this, "tasks"),
    });
    // 0.138.0: re-encrypt sweep — the review view + the one-modal batch command.
    this.addCommand({
      id: "stashpad-open-watchlist",
      name: "Open aggregated Previously encrypted view",
      callback: () => void openAggregateView(this, "watch"),
    });
    this.addCommand({
      id: "stashpad-encrypt-applicable",
      name: "Encrypt (lock) everything applicable (re-encrypt sweep)",
      callback: () => void this.encryptEverythingApplicable(),
    });
    // (0.143.0: the "Encrypt existing Obsidian trash" command is gone with the
    // vault-DEK trash sweep — encryption is per-folder now.)
    this.addCommand({
      id: "stashpad-close-duplicate-tabs",
      name: "Close duplicate & orphaned Stashpad tabs (tidy up)",
      callback: () => void this.closeDuplicateStashpadTabs(),
    });
    // 0.77.8: claim authorship retroactively (for notes created before the
    // user set their author name). Author-only variants only fill blank
    // author fields; the "+ contributor" variants also add the user as a
    // contributor to notes someone else already authored. All undoable.
    this.addCommand({
      id: "stashpad-claim-selected-author",
      name: "Claim authorship of selected notes",
      callback: () => call("claimSelectedAsAuthor"),
    });
    this.addCommand({
      id: "stashpad-claim-folder-author",
      name: "Claim authorship of all unauthored notes in this folder",
      callback: () => call("claimFolderAsAuthor"),
    });
    this.addCommand({
      id: "stashpad-claim-selected-contributor",
      name: "Claim selected notes (author if unowned, else add me as contributor)",
      callback: () => call("claimSelectedWithContributor"),
    });
    this.addCommand({
      id: "stashpad-claim-folder-contributor",
      name: "Claim all notes in this folder (author if unowned, else add me as contributor)",
      callback: () => call("claimFolderWithContributor"),
    });
    this.addCommand({
      id: "stashpad-pick-destination",
      name: "Pick destination for next note",
      callback: () => call("openDestinationPicker"),
    });
    this.addCommand({
      id: "stashpad-search",
      name: "Search Stashpad notes",
      callback: () => call("openSearchModal"),
    });
    this.addCommand({
      id: "stashpad-search-in-parent",
      name: "Search in current parent",
      callback: () => call("openSearchInParentModal"),
    });
    this.addCommand({
      id: "stashpad-move-picker",
      name: "Move selection (picker)",
      callback: () => call("cmdMovePicker"),
    });
    this.addCommand({
      id: "stashpad-merge",
      name: "Merge selection",
      callback: () => call("cmdMerge"),
    });
    this.addCommand({
      id: "stashpad-copy",
      name: "Copy selection",
      callback: () => call("cmdCopy"),
    });
    this.addCommand({
      id: "stashpad-link-previews-selection",
      name: "Add link previews to the selected note(s)",
      callback: () => {
        const v = getActiveView();
        const targets: TFile[] = (v?.getActionTargets?.() ?? [])
          .map((n: { file?: TFile | null }) => n.file)
          .filter((f: TFile | null | undefined): f is TFile => !!f);
        void this.addLinkPreviews(targets);
      },
    });
    this.addCommand({
      id: "stashpad-link-previews-refresh",
      name: "Refresh link previews on the selected note(s) (overwrites)",
      callback: () => {
        const v = getActiveView();
        const targets: TFile[] = (v?.getActionTargets?.() ?? [])
          .map((n: { file?: TFile | null }) => n.file)
          .filter((f: TFile | null | undefined): f is TFile => !!f);
        void this.addLinkPreviews(targets, { force: true });
      },
    });
    // 0.267.6: a panic switch needs to be reachable in one action, not four
    // taps into settings — that is the whole point of it.
    //
    // TWO commands rather than one toggle, deliberately. Under the
    // circumstances this exists for (someone walked up, you handed your phone
    // over) a toggle bound to a hotkey can UNCOVER everything on a second
    // press, which is the one outcome that must not be one keystroke away.
    // "Cover" is therefore idempotent: pressing it again does nothing.
    // 0.267.11: the diagnostics you actually reach for mid-repro, as commands.
    //
    // Copy and Clear existed only as buttons in Settings, four taps away — and
    // the moment you want them is the moment you have just reproduced
    // something, when leaving the view to go find them is when the state you
    // captured gets buried under the renders that opening settings causes.
    this.addCommand({
      id: "stashpad-snapshot-settings-window",
      name: "Diagnostics: snapshot the settings window (run it WHILE settings is unresponsive)",
      callback: () => {
        const snap = this.snapshotSettingsWindow();
        this.trace("settings:snapshot", snap);
        const text = JSON.stringify(snap, null, 1);
        navigator.clipboard.writeText(text).then(
          () => new Notice("Settings snapshot copied — paste it into the bug report."),
          () => new Notice("Snapshot recorded to the debug trace (clipboard unavailable)."),
        );
      },
    });
    this.addCommand({
      id: "stashpad-copy-debug-trace",
      name: "Diagnostics: copy debug trace to clipboard",
      callback: () => {
        const text = this.getDebugTrace();
        if (!text) { new Notice("Debug trace is empty — turn it on and reproduce the issue first."); return; }
        navigator.clipboard.writeText(text).then(
          () => new Notice(`Debug trace copied (${text.split("\n").length} lines).`),
          () => new Notice("Couldn't access the clipboard."),
        );
      },
    });
    // 0.268.8: the buffer is memory-only, so a bug that HANGS the window and
    // forces a kill takes the trace with it. The flush-to-disk copy survives
    // that; this is how you get it back after restarting.
    this.addCommand({
      id: "stashpad-copy-previous-debug-trace",
      name: "Diagnostics: copy debug trace from the PREVIOUS session (after a crash or force-quit)",
      callback: () => {
        void this.getPreviousTrace().then((text) => {
          if (!text) {
            new Notice("No trace from a previous session. One is kept only while BOTH the debug trace and \"Save the debug trace to disk\" are switched on.");
            return;
          }
          navigator.clipboard.writeText(text).then(
            () => new Notice(`Previous session's trace copied (${text.split("\n").length} lines).`),
            () => new Notice("Couldn't access the clipboard."),
          );
        });
      },
    });
    this.addCommand({
      id: "stashpad-clear-debug-trace",
      name: "Diagnostics: clear debug trace",
      callback: () => { this.clearDebugTrace(); new Notice("Debug trace cleared."); },
    });
    this.addCommand({
      id: "stashpad-toggle-debug-trace",
      name: "Diagnostics: turn the debug trace on / off",
      callback: () => {
        this.settings.debugTrace = !this.settings.debugTrace;
        this.stampDiagnostic("trace", this.settings.debugTrace);
        void this.saveSettings();
        // Switching it off removes the on-disk copies as well, so turning the
        // diagnostic off actually turns it off rather than leaving a file behind.
        if (!this.settings.debugTrace) void this.removeTraceFiles();
        new Notice(this.settings.debugTrace
          ? "Debug trace ON — reproduce the issue, then copy the trace. It's also saved to disk, so it survives a force-quit."
          : "Debug trace OFF.");
      },
    });
    this.addCommand({
      id: "stashpad-measure-scroll",
      name: "Diagnostics: measure scroll performance (writes to the debug trace)",
      callback: () => call("cmdMeasureScrollPerf"),
    });
    this.addCommand({
      id: "stashpad-obscure-everything",
      name: "Cover every note everywhere (global \u2014 visual only)",
      callback: () => {
        void this.setObscureAll(true);
        new Notice("Stashpad: global cover ON \u2014 every note is covered. Tap one to peek at it.", 5000);
      },
    });
    this.addCommand({
      id: "stashpad-unobscure-everything",
      name: "Uncover every note everywhere (global \u2014 visual only)",
      callback: () => {
        void this.setObscureAll(false);
        new Notice("Stashpad: global cover OFF \u2014 notes covered individually stay covered.", 5000);
      },
    });
    this.addCommand({
      id: "stashpad-create-folder-shortcuts",
      name: "Create quick-switcher shortcuts for every Stashpad folder",
      callback: () => { void this.createFolderShortcuts(); },
    });
    this.addCommand({
      id: "stashpad-link-previews-backfill",
      name: "Backfill link previews across every Stashpad folder",
      callback: () => { void this.backfillLinkPreviews(); },
    });
    this.addCommand({
      id: "stashpad-copy-tree",
      name: "Copy focused subtree",
      // 0.259.0: was wired to cmdCopyTree, which copies the SELECTION — so this
      // command never did what its name said.
      callback: () => call("cmdCopyFocusedSubtree"),
    });
    // 0.184.0: dismiss every visible notification toast at once (handy when a batch
    // of due reminders / messages stacks up).
    this.addCommand({
      id: "stashpad-dismiss-notifications",
      name: "Dismiss all notifications",
      callback: () => {
        const notices = Array.from(document.querySelectorAll(".notice"));
        for (const n of notices) n.parentElement?.removeChild(n);
        new Notice(notices.length ? `Dismissed ${notices.length} notification${notices.length === 1 ? "" : "s"}.` : "No notifications to dismiss.");
      },
    });
    // 0.185.0: re-fire reminders for every incomplete, past-due task assigned to
    // you — pops your task backlog up again on demand (ignores the once-only dedup).
    this.addCommand({
      id: "stashpad-resend-reminders",
      name: "Re-show pending notifications (resend / redisplay reminders for incomplete due tasks)",
      callback: () => void this.resendDueReminders(),
    });
    // 0.192.0: paste-text importer (replaces the standalone Stashpad Importer web app).
    this.addCommand({
      id: "stashpad-import-text",
      name: "Import pasted text into Stashpad (paste → nested notes)…",
      callback: () => call("cmdImportText"),
    });
    // 0.216.0: importer for data extracted from the dead Stashpad desktop app.
    this.addCommand({
      id: "stashpad-import-app",
      name: "Import from the Stashpad app (migrate notes.json export)…",
      callback: () => call("cmdImportStashpadApp"),
    });
    this.addCommand({
      id: "stashpad-skip-occurrence",
      name: "Skip repeating task to its next occurrence",
      callback: () => call("cmdSkipOccurrence"),
    });
    this.addCommand({
      id: "stashpad-copy-link",
      name: "Copy Stashpad link (deep link / URL) to note",
      callback: () => call("cmdCopyStashpadLink"),
    });
    this.addCommand({
      id: "stashpad-open-link",
      name: "Open Stashpad link (paste a deep link / URL)",
      callback: () => this.openDeepLinkModal(),
    });
    this.addCommand({
      id: "stashpad-copy-outline",
      name: "Copy as outline (nested embeds)",
      callback: () => call("cmdCopyOutline"),
    });
    this.addCommand({
      id: "stashpad-split",
      name: "Split note…",
      callback: () => call("cmdSplit"),
    });
    this.addCommand({
      id: "stashpad-edit-note",
      name: "Open note in Obsidian editor (new tab)",
      callback: () => call("cmdOpenInEditor"),
    });
    this.addCommand({
      // 0.170.0: Stashpad's own editor (Edit ⇄ Split surface), not a full Obsidian tab.
      id: "stashpad-edit-inapp",
      name: "Edit note in Stashpad…",
      callback: () => call("cmdEdit"),
    });
    this.addCommand({
      id: "stashpad-edit-parent-inapp",
      name: "Edit parent note in Stashpad…",
      callback: () => call("cmdEditParent"),
    });
    this.addCommand({
      id: "stashpad-edit-parent",
      name: "Edit parent note in new tab",
      callback: () => call("cmdOpenParentInEditor"),
    });
    this.addCommand({
      id: "stashpad-delete",
      name: "Delete selection",
      callback: () => call("cmdDelete"),
    });
    this.addCommand({ id: "stashpad-move-up", name: "Move note up", callback: () => call("cmdMoveUp") });
    this.addCommand({ id: "stashpad-move-down", name: "Move note down", callback: () => call("cmdMoveDown") });
    this.addCommand({ id: "stashpad-move-to-top", name: "Move note to top", callback: () => call("cmdMoveToTop") });
    this.addCommand({ id: "stashpad-move-to-bottom", name: "Move note to bottom", callback: () => call("cmdMoveToBottom") });
    this.addCommand({ id: "stashpad-outdent", name: "Outdent (move to grandparent)", callback: () => call("cmdOutdent") });
    this.addCommand({ id: "stashpad-set-color", name: "Set note color…", callback: () => call("cmdSetColor") });
    this.addCommand({ id: "stashpad-focus-list", name: "Focus the list (leave the composer)", callback: () => call("cmdFocusList") });
    this.addCommand({ id: "stashpad-toggle-obscured", name: "Obscure / reveal note (blur \u2014 visual only, not encryption)", callback: () => call("cmdToggleObscured") });
    // "Clone / duplicate / copy" — three synonyms in the name so command-palette
    // fuzzy search hits regardless of which word the user reaches for.
    this.addCommand({ id: "stashpad-clone", name: "Clone selection (duplicate / copy notes)", callback: () => call("cmdClone") });
    this.addCommand({ id: "stashpad-fork-note", name: "Fork into a separate note (copy under a chosen parent)", callback: () => call("cmdForkNote") });
    this.addCommand({ id: "stashpad-insert-template", name: "Insert template (clone an existing note)", callback: () => call("cmdInsertTemplate") });
    this.addCommand({ id: "stashpad-toggle-expand", name: "Show more / show less (expand toggle)", callback: () => call("cmdToggleExpand") });
    this.addCommand({ id: "stashpad-expand-all", name: "Expand all (show every note's full body)", callback: () => call("cmdExpandAll") });
    this.addCommand({ id: "stashpad-collapse-all", name: "Collapse all (clamp every note's body)", callback: () => call("cmdCollapseAll") });
    // Three view-level keybinds that previously had no command-palette
    // entry. Names mirror their COMMAND_META labels for fuzzy lookup.
    this.addCommand({ id: "stashpad-pick-move", name: "Move (in-list, arrow + Enter)", callback: () => call("cmdInListPicker") });
    this.addCommand({ id: "stashpad-open-in-new-tab", name: "Open in new Stashpad tab", callback: () => call("cmdOpenInNewStashpadTab") });
    this.addCommand({ id: "stashpad-toggle-complete", name: "Toggle complete (strikethrough)", callback: () => call("cmdToggleComplete") });
    this.addCommand({ id: "stashpad-toggle-task", name: "Toggle task (todo)", callback: () => call("cmdToggleTask") });
    this.addCommand({ id: "stashpad-set-due", name: "Set due date…", callback: () => call("cmdSetDue") });
    // 0.81.1: performance profiling — dump / reset the timing report.
    this.addCommand({
      id: "stashpad-dump-perf",
      name: "Dump performance profile (copy to clipboard)",
      callback: async () => {
        if (!this.settings.enablePerfProfiling) {
          new Notice("Enable “Performance profiling” in Stashpad settings first, then use the app and run this again.");
          return;
        }
        const report = perf.report();
        console.log(report);
        try { await navigator.clipboard.writeText(report); } catch { /* ignore */ }
        new Notice("Performance profile copied to clipboard (also in the console).");
      },
    });
    this.addCommand({
      id: "stashpad-reset-perf",
      name: "Reset performance profile",
      callback: () => { perf.reset(); new Notice("Performance profile reset."); },
    });
    this.addCommand({ id: "stashpad-jump-to-top", name: "Jump to top of list", callback: () => call("jumpToTop") });
    this.addCommand({ id: "stashpad-jump-to-bottom", name: "Jump to bottom of list", callback: () => call("jumpToBottom") });
    this.addCommand({ id: "stashpad-assign", name: "Assign task to…", callback: () => call("cmdAssign") });
    // 0.79.3: view what's been auto-imported.
    this.addCommand({
      id: "stashpad-open-import-log",
      name: "Open import log",
      callback: async () => {
        await this.importLog.load();
        const { ImportLogModal } = await import("./modals");
        new ImportLogModal(this.app, this.importLog.recent()).open();
      },
    });
    // 0.79.4: import via the OS file picker. Opens a chooser whose pinned
    // top result is "open the file picker" (targeting the active folder);
    // the remaining results let you pick a different destination folder.
    this.addCommand({
      id: "stashpad-import-files",
      name: "Import file(s) into Stashpad…",
      callback: () => this.openImportPicker(),
    });
    // 0.84.1: manual sweep of the current folder for loose files moved in
    // from outside (the counterpart to auto-import, for when it's off or the
    // live watcher didn't catch an external Finder/Explorer copy).
    this.addCommand({
      id: "stashpad-import-loose-files",
      name: "Import loose files & folders in this folder (scan for moved-in / unprocessed items)",
      checkCallback: (checking: boolean) => {
        const folder = this.importService.defaultDestination();
        if (checking) return !!folder;
        if (folder) void this.runImportLooseFiles(folder);
        return true;
      },
    });
    // 0.85.2: per-step counterparts to rebootstrap, scoped to the current
    // folder — so you can re-run just one repair pass without the heavy
    // full-vault sweep. They call the SAME functions rebootstrap uses, so a
    // fix in one place applies to both.
    this.addCommand({
      id: "stashpad-rerun-slug-pass",
      name: "Re-run filename (slug) pass on this folder",
      checkCallback: (checking: boolean) => {
        const folder = this.importService.defaultDestination();
        if (checking) return !!folder;
        if (folder) void this.runFolderSlugPass(folder);
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-rerun-frontmatter-backfill",
      name: "Re-run frontmatter backfill (recovery links) on this folder",
      checkCallback: (checking: boolean) => {
        const folder = this.importService.defaultDestination();
        if (checking) return !!folder;
        if (folder) void this.runFolderFrontmatterBackfill(folder);
        return true;
      },
    });
    this.addCommand({ id: "stashpad-select-all", name: "Select all visible notes", callback: () => call("cmdSelectAll") });
    this.addCommand({ id: "stashpad-copy-codeblock", name: "Copy code from codeblock", callback: () => call("cmdCopyCodeBlock") });
    // 0.68.0: open the sidebar panels view (Pinned Notes + future panels).
    this.addCommand({
      id: "stashpad-open-panels",
      name: "Open Stashpad panels (sidebar)",
      callback: () => void openStashpadPanelsView(this.app),
    });
    // 0.86.0: open the left-sidebar folder picker (pinned notes + folders).
    this.addCommand({
      id: "stashpad-open-folder-panel",
      name: "Open folder panel (sidebar)",
      callback: () => void openFolderPanelView(this.app),
    });
    // 0.74.1: open the right-sidebar detail panel.
    this.addCommand({
      id: "stashpad-open-detail",
      name: "Open Stashpad detail panel (right sidebar)",
      callback: () => void openStashpadDetailView(this.app),
    });
    // 0.76.19: jump from a plain Obsidian markdown tab to the same
    // note inside Stashpad — for when you open a Stashpad note in the
    // normal editor by accident. Reuses an existing Stashpad tab on
    // that folder if one's open, else opens a fresh one, then focuses
    // the note.
    this.addCommand({
      id: "stashpad-reveal-active-note",
      name: "Open this note in Stashpad",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        // A Stashpad note → jump to it. A non-md attachment → jump to the note(s)
        // that embed it (0.174.0). Anything else → command hidden.
        if (file.extension === "md" && this.isStashpadNoteFile(file)) {
          if (!checking) void this.revealNoteInStashpad(file);
          return true;
        }
        if (file.extension !== "md") {
          // 0.176.x PERF: never scan the vault in checkCallback — it runs for
          // EVERY command each time the palette rebuilds (per keystroke), and the
          // old findStashpadNotesEmbedding() full-vault scan here hung Mod+P for
          // seconds when an attachment tab was active. Show the command cheaply
          // for any attachment; the scan happens on execution (and Notices if
          // nothing references the file).
          if (!checking) void this.revealAttachmentInStashpad(file);
          return true;
        }
        return false;
      },
    });
    // 0.73.11: per-panel shortcuts — open the sidebar panels view AND
    // select the matching tab (Pinned / Shared / Tasks).
    const panelIds = Object.keys(PANEL_REGISTRY) as PanelId[];
    for (const id of panelIds) {
      const meta = PANEL_REGISTRY[id];
      this.addCommand({
        id: `stashpad-open-panels-${id}`,
        name: `Open Stashpad panel: ${meta.label}`,
        callback: async () => {
          await openStashpadPanelsView(this.app);
          // Find the now-active panels view and flip it to the picked
          // panel. There's at most one panels view per workspace.
          const leaves = this.app.workspace.getLeavesOfType(STASHPAD_PANELS_VIEW_TYPE);
          const view = leaves[0]?.view as StashpadPanelsView | undefined;
          view?.setActivePanel?.(id);
        },
      });
    }
    // 0.126.0: roomier full-modal task triage (the panel is cramped).
    this.addCommand({ id: "stashpad-task-review", name: "Open daily task review", callback: () => new TaskReviewModal(this.app, this).open() });
    this.addCommand({ id: "stashpad-swap-with-parent", name: "Swap with parent (ouroboros)", callback: () => call("cmdSwapWithParent") });
    this.addCommand({ id: "stashpad-toggle-pin", name: "Pin / unpin selected note (sidebar)", callback: () => call("cmdTogglePin") });
    this.addCommand({ id: "stashpad-list-pin", name: "Pin / unpin to top of list", callback: () => call("cmdToggleListPin", "top") });
    this.addCommand({ id: "stashpad-list-pin-bottom", name: "Pin / unpin to bottom of list", callback: () => call("cmdToggleListPin", "bottom") });
    // 0.61.1: tiny mode — opens a popout window with the minimal shell
    // (folder/focus title + list + composer + sticky/expand controls).
    this.addCommand({
      id: "stashpad-open-tiny",
      name: "Open Stashpad in tiny window",
      callback: () => void this.openTinyWindow(),
    });
    // Mirror of the "copy" / duplicate button in the focused-header
    // actions cluster. Three synonyms in the name for fuzzy lookup.
    this.addCommand({ id: "stashpad-clone-tab", name: "Clone (duplicate / copy) this Stashpad tab", callback: () => call("cmdCloneStashpadTab") });
    this.addCommand({
      id: "stashpad-undo",
      name: "Undo last Stashpad action",
      callback: () => call("cmdUndo"),
    });
    this.addCommand({
      id: "stashpad-redo",
      name: "Redo last undone Stashpad action",
      callback: () => call("cmdRedo"),
    });
    this.addCommand({
      // 0.167.0: one unified export command (the modal picks .stash / OKF / plain
      // .zip + content). Keeps the id so existing keybinds survive; OKF's separate
      // command was retired.
      id: "stashpad-export-stash",
      name: "Export selection (.stash / OKF / plain .zip)…",
      callback: () => call("cmdExportStash"),
    });
    this.addCommand({
      id: "stashpad-import-stash",
      name: "Import .stash file…",
      callback: () => call("cmdImportStash"),
    });
    // 0.65.0: command-palette entry calls the plugin's unified picker
    // directly so it works even when no Stashpad tab is active. (The
    // view-local `call("cmdOpenFolderPicker")` only fires when an
    // active Stashpad view is present.) Renamed for the broader scope.
    this.addCommand({
      id: "stashpad-pick-folder",
      name: "Stashpad: open / switch / create folder…",
      callback: () => this.openFolderPicker(),
    });
    this.addCommand({
      id: "stashpad-run-integrity-check",
      name: "Run integrity check on active Stashpad folder",
      checkCallback: (checking) => {
        const v = getActiveView();
        const folder = (v && (v).noteFolder) as string | undefined;
        if (!folder) return false;
        if (checking) return true;
        new Notice(`Running integrity check on "${folder}"…`);
        void this.runIntegrityCheckOnFolder(folder).then(() => {
          new Notice(`Integrity check complete — see Stashpad log.`);
        });
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-find-duplicate-ids",
      name: "Find duplicate note ids (hidden / colliding notes)",
      callback: () => void this.findDuplicateNoteIds(),
    });
    this.addCommand({
      id: "stashpad-fix-orphans",
      name: "Set missing parents to Home (orphan fix)",
      callback: () => void this.fixOrphanParents(),
    });
    // 0.206.0: rebuild wiped frontmatter from the folder's structure snapshot.
    this.addCommand({
      id: "stashpad-repair-from-snapshot",
      name: "Repair lost note frontmatter from the folder's structure snapshot (recover id / parent)",
      callback: () => void (async () => {
        // The folder of the Stashpad tab you were last in; otherwise the
        // configured default. Repair is per-folder because the snapshot is.
        const active = (this.lastActiveStashpadLeaf?.view as { noteFolder?: string } | undefined)?.noteFolder;
        const folder = (active || this.settings.folder || "Stashpad").replace(/\/+$/, "");
        const res = await this.repairFolderFromSnapshot(folder);
        if (!res || res.repaired === 0) return;
        this.refreshOpenViewsForFolder(folder);
        this.getUndoStack(folder).push({
          label: `Repair ${res.repaired} note${res.repaired === 1 ? "" : "s"} from snapshot`,
          undo: async () => { await res.undo(); this.refreshOpenViewsForFolder(folder); },
          redo: async () => { await this.repairFolderFromSnapshot(folder); this.refreshOpenViewsForFolder(folder); },
        });
        const lines = [
          `🩹 Repaired ${res.repaired} note${res.repaired === 1 ? "" : "s"} in "${folder.split("/").pop()}" from the structure snapshot.`,
          "Their id, parent and created date were restored from the folder's recovery sidecar; bodies were untouched.",
        ];
        if (res.skipped) lines.push(`${res.skipped} could not be matched and were left alone.`);
        lines.push("Undo (in the list) reverses it.");
        this.notifications.show({
          message: lines.join("\n"),
          kind: "success", category: "system", folder, duration: 0,
        });
      })(),
    });
    // 0.77.2: rebuild the author registry from a full vault scan.
    this.addCommand({
      id: "stashpad-rebuild-author-registry",
      name: "Rebuild author registry (scan authors + note frontmatter)",
      callback: async () => {
        new Notice("Stashpad: rebuilding author registry…");
        try {
          const r = await this.rebuildAuthorRegistry();
          this.notifications.show({
            message: `Author registry rebuilt: ${r.total} author(s) — ${r.fromStubs} from stubs, ${r.fromNotes} from note links.`,
            kind: "success",
            category: "system",
          });
        } catch (e) {
          new Notice(`Author registry rebuild failed: ${(e as Error).message}`);
        }
      },
    });
    // 0.77.3: regenerate any author stub files that were deleted, from
    // the registry's remembered name/role/department.
    this.addCommand({
      id: "stashpad-restore-author-stubs",
      name: "Restore missing author stubs (from registry)",
      callback: async () => {
        new Notice("Stashpad: restoring author stubs…");
        try {
          const r = await this.restoreMissingAuthorStubs();
          this.notifications.show({
            message: r.created > 0
              ? `Restored ${r.created} author stub(s) across ${r.folders} folder(s).`
              : `No missing author stubs — all present across ${r.folders} folder(s).`,
            kind: "success",
            category: "system",
          });
        } catch (e) {
          new Notice(`Restore author stubs failed: ${(e as Error).message}`);
        }
      },
    });
    // 0.58.0: rebootstrap as a command palette entry — mirrors the
    // "Rebootstrap now" button in settings. Useful when troubleshooting
    // / migrating without opening Settings.
    this.addCommand({
      id: "stashpad-sync-authors",
      name: "Sync authors across all folders (multiplayer)",
      callback: () => void this.syncAuthorsAcrossFolders(),
    });
    this.addCommand({
      id: "stashpad-rebootstrap-all",
      name: "Rebootstrap all Stashpad folders (backfill metadata + rename stale titles)",
      // 0.118.4: progress + success feedback lives in runRebootstrapWithUI
      // (persistent notice + bar), shared with the settings button.
      callback: () => { void this.runRebootstrapWithUI().catch(() => { /* error notice already shown */ }); },
    });
    // 0.271.7: create readable aliases for the CURRENT folder's notes, so
    // Obsidian's quick switcher / links show the title instead of the
    // slug-and-id filename. Scope is the current folder only (said so in the
    // name), append-only, and never automatic — this command or a rebootstrap.
    this.addCommand({
      id: "stashpad-create-aliases-folder",
      name: "Create aliases from titles for THIS folder's notes (append-only)",
      checkCallback: (checking) => {
        const view = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
          .map((l) => l.view as unknown as { noteFolder?: string })
          .find((v) => v === (this.app.workspace.activeLeaf?.view as unknown))
          ?? this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
            .map((l) => l.view as unknown as { noteFolder?: string })[0];
        const folder = view?.noteFolder;
        if (!folder) return false;
        if (checking) return true;
        void createAliasesForFolder(this.app, folder, (f) => this.isStashpadNoteFile(f))
          .then(({ scanned, written }) => {
            new Notice(written > 0
              ? `Stashpad: added aliases to ${written} note${written === 1 ? "" : "s"} in "${folder}" (${scanned} checked).`
              : `Stashpad: every note in "${folder}" already had its alias (${scanned} checked).`);
          })
          .catch((e) => { console.warn("[Stashpad] create aliases failed", e); new Notice("Stashpad: couldn't create aliases — see console."); });
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-adopt-note",
      name: "Adopt active note into Stashpad (fill missing frontmatter)",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (checking) return true;
        void this.adoptNote(f);
        return true;
      },
    });
    this.addCommand({
      id: "stashpad-open-notification-history",
      name: "Open notification history",
      callback: () => {
        // Lazy require to avoid a hard import dependency at plugin
        // load time — the modal pulls in modals.ts which is fine but
        // we keep the surface area minimal.
        void import("./modals").then(({ NotificationHistoryModal, LogModal }) => {
          new NotificationHistoryModal(
            this.app,
            this.notifications,
            async () => {
              const adapter = this.app.vault.adapter;
              const path = this.pluginPrivatePath("log.jsonl");
              if (!(await adapter.exists(path))) {
                new Notice("No log yet — make some changes first.");
                return;
              }
              const data = await adapter.read(path);
              new LogModal(this.app, data, path).open();
            },
            this.settings.authorId || null,
            (id) => this.lookupNoteAuthorIds(id),
          ).open();
        });
      },
    });
    // 0.73.12: every General-tab settings toggle now mirrors into the
    // command palette as "Toggle: <name>". Lets power users flip
    // behavior without opening Settings. Fires a Notice confirming
    // the new state. Booleans only — text/textarea/dropdown settings
    // stay in the Settings UI where they belong.
    const TOGGLES: Array<{ key: keyof StashpadSettings; label: string }> = [
      { key: "prefixTimestampsOnCopy",    label: "Prefix timestamps when copying" },
      { key: "useTemplatesFormat",        label: "Use Templates plugin date/time formats" },
      { key: "splitCheckboxLines",        label: "Split a pasted checklist into tasks" },
      { key: "autoNavOnMoveIn",           label: "Auto-navigate into parent on move IN" },
      { key: "openParentTabOnMoveIn",     label: "Open new parent in a background tab on move IN" },
      { key: "autoNavOnMoveOut",          label: "Auto-navigate to destination on move OUT" },
      { key: "confirmCrossParentDrag",    label: "Confirm cross-parent drag-and-drop" },
      { key: "confirmBulkDelete",         label: "Confirm bulk deletes" },
      { key: "confirmAttachmentDelete",   label: "Offer to delete attachments with note" },
      { key: "autofocusComposerAfterSend", label: "Autofocus composer after sending" },
      { key: "popoutDuplicates",          label: "Open in new window — duplicate tab" },
      { key: "autoExpandCursorRow",       label: "Expand the cursor row's body automatically" },
      { key: "autoOpenDetailPanel",       label: "Auto-open the detail panel" },
      { key: "doubleClickToFocus",        label: "Double-click a note to open it" },
    ];
    for (const t of TOGGLES) {
      const cmdId = `stashpad-toggle-${String(t.key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      this.addCommand({
        id: cmdId,
        name: `Toggle: ${t.label}`,
        callback: async () => {
          const next = !(this.settings as any)[t.key];
          (this.settings as any)[t.key] = next;
          await this.saveSettings();
          new Notice(`${t.label}: ${next ? "ON" : "OFF"}`);
        },
      });
    }
    this.addCommand({
      id: "stashpad-open-settings",
      name: "Open Stashpad settings",
      callback: () => {
        const setting = (this.app as any).setting;
        if (!setting?.open || !setting?.openTabById) return;
        setting.open();
        setting.openTabById(this.manifest.id);
      },
    });
    // 0.73.13: search-focused shortcut — opens Settings and lands the
    // cursor in the search box so the user types straight into it.
    this.addCommand({
      id: "stashpad-search-settings",
      name: "Search Stashpad settings…",
      callback: () => {
        const setting = (this.app as any).setting;
        if (!setting?.open || !setting?.openTabById) return;
        setting.open();
        setting.openTabById(this.manifest.id);
        // 0.94.4: focus Obsidian's NATIVE settings search input (the old
        // in-plugin search box is gone — settings are indexed via
        // getSettingDefinitions now).
        setTimeout(() => {
          const inp = setting?.modalEl?.querySelector?.("input[type='search']") as HTMLInputElement | undefined;
          inp?.focus();
        }, 0);
      },
    });
    // 0.73.10: per-tab settings shortcuts. Each opens the Settings
    // modal scrolled to the matching tab of the redesigned tabbed UI.
    for (const t of SETTINGS_TABS) {
      this.addCommand({
        id: `stashpad-open-settings-${t.id}`,
        name: `Open Stashpad settings: ${t.label}`,
        callback: () => {
          const setting = (this.app as any).setting;
          if (!setting?.open || !setting?.openTabById) return;
          // 0.94.4: native settings own page navigation; we can't deep-link to
          // a specific sub-page, so this lands on Stashpad's settings page list.
          setting.open();
          setting.openTabById(this.manifest.id);
        },
      });
    }
    // 0.71.0 / 0.71.2: JD-style index builder.
    // Two commands so the heavyweight "create Stashpad notes" is
    // separable from the cheap single-file Preview that the user can
    // inspect before committing.
    const openSettingsToJd = (): void => {
      const setting = (this.app as any).setting;
      if (!setting?.open || !setting?.openTabById) return;
      setting.open();
      setting.openTabById(this.manifest.id);
      // Scroll to the JD section if the heading is present.
      setTimeout(() => {
        const header = document.getElementById("stashpad-jd-index-section");
        header?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    };
    this.addCommand({
      id: "stashpad-preview-jd-index",
      name: "Preview JD index (overwrites home note body)",
      callback: async () => {
        try {
          const { buildJdIndexPreview } = await import("./index-builder");
          const result = await buildJdIndexPreview(this.app, this, this.settings);
          if (result.error === "no-dest") {
            new Notice("Set a Designated Stashpad folder for Index in settings first.", 6000);
            openSettingsToJd();
            return;
          }
          if (result.error === "no-home") {
            new Notice(
              `"${this.settings.jdIndexStashpadFolder}" has no Stashpad home note. Open the folder in Stashpad first to create one.`,
              7000,
            );
            return;
          }
          const { buildJdPreviewNotice } = await import("./index-builder");
          buildJdPreviewNotice(this.app, result);
        } catch (err) {
          console.error("[stashpad] preview failed", err);
          new Notice(`Preview failed: ${(err as Error)?.message ?? err}`, 8000);
        }
      },
    });
    // Gap 4: raw-folder bundles only surfaced via the file-explorer right-click. Add a
    // command-palette path so you can find & decrypt a bundle without hunting for it.
    this.addCommand({
      id: "stashpad-decrypt-folder-bundle",
      name: "Decrypt a folder bundle (encrypted non-Stashpad folder)…",
      callback: async () => {
        if (!this.encryption.isConfigured()) { new Notice("Stashpad encryption isn't set up."); return; }
        const bundles = await listRawFolderBlobs(this.app);
        if (!bundles.length) { new Notice("No encrypted folder bundles found in this vault."); return; }
        new FolderBundleSuggest(this.app, bundles, (b) => void this.decryptFolderFromExplorer(b.folder)).open();
      },
    });

    this.addCommand({
      id: "stashpad-build-jd-index",
      name: "Build JD index notes (creates Stashpad-note hierarchy)",
      callback: async () => {
        try {
          const { buildJdIndexNotes, scanForJdNotes, JdBuildConfirmModal } = await import("./index-builder");
          const dest = (this.settings.jdIndexStashpadFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
          if (!dest) {
            new Notice("Set a Designated Stashpad folder for Index in settings first.", 6000);
            openSettingsToJd();
            return;
          }
          const scan = scanForJdNotes(this.app, this, this.settings);
          // 0.71.3: route through the confirm modal so first-time users
          // see the "Preview first?" affordance + large-build warning.
          const modal = new JdBuildConfirmModal(
            this.app,
            this,
            this.settings,
            scan.indexed.length,
            async () => {
              try {
                const result = await buildJdIndexNotes(this.app, this, this.settings);
                if (result.error === "no-dest") {
                  new Notice("Set a Designated Stashpad folder for Index in settings first.", 6000);
                  openSettingsToJd();
                  return;
                }
                if (result.error === "dest-not-stashpad") {
                  new Notice(
                    `"${result.destFolder}" isn't a known Stashpad folder. Pick a real Stashpad folder in settings.`,
                    7000,
                  );
                  openSettingsToJd();
                  return;
                }
                this.settings.jdIndexHasBuilt = true;
                await this.saveSettings();
                new Notice(
                  `Index built: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped → ${result.destFolder}`,
                  6000,
                );
              } catch (err) {
                console.error("[stashpad] build failed", err);
                new Notice(`Build failed: ${(err as Error)?.message ?? err}`, 8000);
              }
            },
          );
          modal.open();
        } catch (err) {
          console.error("[stashpad] build failed", err);
          new Notice(`Build failed: ${(err as Error)?.message ?? err}`, 8000);
        }
      },
    });

    // Drop-folder watcher: a .stash file appearing (created OR moved) inside any
    // "<stashpadFolder>/<dropSub>/" path gets auto-imported into that <stashpadFolder>.
    const onMaybeDrop = (file: TFile) => {
      if (file.extension !== STASH_EXT) return;
      const dropSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
      const exportSub = (this.settings.exportFolder || "").trim().replace(/^\/+|\/+$/g, "");
      const parent = file.parent?.path || "";
      const parentBase = parent.split("/").pop() ?? "";
      // Case 1: dropped into the configured `_imports` drop subfolder.
      if (dropSub && parentBase === dropSub) {
        // Guard: ignore files that came from an export folder of the same Stashpad folder.
        if (exportSub && parent.endsWith(`/${exportSub}`)) return;
        // Destination = the parent of the dropSub (i.e. the actual Stashpad folder).
        const destFolder = parent.slice(0, parent.length - dropSub.length).replace(/\/+$/, "") || this.settings.folder;
        void this.autoImportStash(file, destFolder);
        return;
      }
      // Case 2 (0.84.10): with auto-import ON, a .stash dropped directly in a
      // Stashpad folder ROOT auto-imports too — matching the manual loose-import
      // command, so a blank importDropFolder no longer silently disables it.
      // Reserved subfolders (incl. _exports, where our own exports land) are
      // excluded so an export never gets re-imported.
      if (!this.settings.autoImport) return;
      // Skip Obsidian's startup `create` replay — otherwise every pre-existing
      // root-level .stash would auto-import on each launch. Armed ~2.5s after
      // layout-ready (shared with the loose-file watcher).
      if (!this.importService.isArmed()) return;
      if (isInReservedSubfolder(file.path)) return;
      if (this.discoverStashpadFolders().includes(parent)) {
        void this.autoImportStash(file, parent);
      }
    };
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) onMaybeDrop(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) onMaybeDrop(file);
    }));

    // Auto-fix orphan parent frontmatter on .md files that arrive in a
    // Stashpad folder (via create or rename). Waits briefly for the
    // metadataCache to parse, then runs the same guarded check as the
    // manual fixOrphanParents command — but for one file. Existing
    // notes whose parent is already set are never touched.
    const onMaybeOrphan = (file: TFile): void => {
      if (file.extension !== "md") return;
      const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!this.discoverStashpadFolders().includes(dir)) return;
      // Defer to give metadataCache time to parse the frontmatter.
      setTimeout(() => { void this.fixOrphanParentForFile(file); }, 800);
    };
    // 0.72.5: bare .md files dropped into <stashpad>/<importSub>/ get
    // adopted into the parent Stashpad — move them up to the folder
    // root + stamp orphan frontmatter so they appear as Home-rooted
    // notes. Mirrors what .stash drops already do, but for raw
    // markdown the user shares without packaging.
    const onMaybeMarkdownImport = (file: TFile): void => {
      if (file.extension !== "md") return;
      const dropSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
      if (!dropSub) return;
      const parent = file.parent?.path?.replace(/\/+$/, "") ?? "";
      const parentBase = parent.split("/").pop() ?? "";
      if (parentBase !== dropSub) return;
      // Stashpad folder is the parent of the dropSub.
      const stashFolder = parent.slice(0, parent.length - dropSub.length).replace(/\/+$/, "");
      if (!stashFolder || !this.discoverStashpadFolders().includes(stashFolder)) return;
      // Defer to let the metadataCache parse the file, then move it
      // up + run the orphan-fix path. Picks a unique filename if a
      // name collision exists at the destination.
      setTimeout(() => { void this.adoptMarkdownDrop(file, stashFolder); }, 200);
    };
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) { onMaybeOrphan(file); onMaybeMarkdownImport(file); }
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) { onMaybeOrphan(file); onMaybeMarkdownImport(file); }
    }));
    // 0.95.1: a Stashpad folder was deleted (panel button OR file explorer OR
    // anywhere) — close its open tabs + notify. The "delete" event fires after
    // the folder's notes are gone, so we rely on the knownStashpadFolders
    // snapshot (refreshed on every discoverStashpadFolders) to recognize it.
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFolder)) return;
      const cleaned = file.path.replace(/\/+$/, "");
      if (this.knownStashpadFolders.has(cleaned)) void this.handleStashpadFolderDeleted(cleaned);
    }));
    // 0.86.5: when a note's FILE moves to a DIFFERENT folder (e.g. dragged in
    // Obsidian's file explorer), its `parent` still points at a note in the OLD
    // folder — a dangling parent that orphans it in the new one. The
    // missing-parent orphan-fix above doesn't catch this (the parent value is
    // present, just invalid here), so re-home such notes to Home. Gated on a
    // real cross-folder move, so in-folder reparents/renames are untouched.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.maybeReHomeOnCrossFolderMove(file, oldPath);
    }));

    // 0.98.25 (Phase 4): archive folders — a note MOVED into a marked folder is
    // auto-encrypted after a settle window. Move-in only (rename event), never
    // create/edit, so a note being written can't be locked out from under you.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.maybeArchiveOnMoveIn(file, oldPath);
    }));

    // 0.149.2: a FOLDER was renamed (panel, file explorer, or a synced device).
    // Re-point every open Stashpad tab off the old path AND remap the path-keyed
    // settings — otherwise a tab left on the old name keeps writing there
    // (createNoteUnder / ensureAuthorFile / bootstrapFolder's ensureFolder+
    // ensureHomeNote on reload) and RESURRECTS the old folder. Fires for every
    // rename source, so it also covers file-explorer renames the panel path missed.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFolder) {
        this.retargetStashpadViewsForFolderRename(oldPath, file.path);
        void this.remapFolderPathInSettings(oldPath, file.path);
      }
    }));

    // 0.149.3: live-adopt settings that arrive from ANOTHER device (Obsidian Sync
    // rewriting our data.json) — so folder-panel pins/hides sync in WITHOUT a
    // reload. The "raw" vault event fires for files under `.obsidian/`. We filter
    // to our own data.json, then re-read + adopt the collision-protected keys and
    // refresh the folder panel. Our own writes are skipped via the settingsRev
    // guard in onExternalDataJsonChange.
    // 0.189.0: watch every file the settings store owns, not just data.json — the
    // split files need the same "another window wrote this" adoption path.
    const ownedPaths = new Set(this.store.watchPaths());
    this.registerEvent((this.app.vault as any).on("raw", (changedPath: string) => {
      if (ownedPaths.has(changedPath)) this.scheduleExternalDataJsonReload();
    }));

    // 0.79.1: auto-import — any file appearing directly in a Stashpad
    // folder root (not a reserved subfolder, not an existing note) gets
    // turned into a note. The service guards + debounces internally.
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.importService.enqueue(file);
      else if (file instanceof TFolder) this.importService.enqueueFolder(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) this.importService.enqueue(file);
      else if (file instanceof TFolder) this.importService.enqueueFolder(file);
    }));

    // Multiplayer: keep settings.authorName in sync with the on-disk
    // _authors stub file basenames. If the user renames their author
    // file in Obsidian (file explorer), we update the setting and
    // propagate the new name back across every Stashpad's _authors
    // folder so all stubs stay aligned. Reverse direction (settings →
    // files) lives in syncAuthorFilesToName, called from the settings
    // tab's onChange.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      void this.maybeAdoptAuthorRename(file, oldPath);
    }));

    // 0.76.31: detect when a newer plugin build has synced in but
    // Obsidian is still running the old code (no hot-reload). Check
    // shortly after load (let Sync settle) and whenever the app
    // foregrounds. Nudges the user to reload so they're not stuck on
    // stale code (the "old UI after opening the app" report).
    this.registerDomEvent(window, "focus", () => void this.checkForSyncedBuild());
    // 0.201.1: cross-vault cut handshake — returning to this vault after
    // pasting the cut elsewhere surfaces the "delete the originals?" modal.
    this.registerDomEvent(window, "focus", () => void this.checkXvCutAck());
    // 0.209.3: ALSO poll for the ack while a cut is pending. Focus-only meant the
    // "delete the originals?" modal never appeared until the user clicked back
    // into the source window — with two vaults side by side, the natural flow is
    // to paste in vault B and watch vault A ask, without a click. readXvAck is a
    // cheap synchronous electron read, and the poll body is a no-op unless a cut
    // is actually pending. Caveat: Chromium throttles timers in OCCLUDED
    // windows, so a fully covered source vault may still wait for focus — but
    // side-by-side (the workflow this exists for) is not occluded.
    this.registerInterval(window.setInterval(() => {
      if (this.pendingXvCut) void this.checkXvCutAck();
    }, 3000));
    setTimeout(() => void this.checkForSyncedBuild(), 5000);
    // 0.215.0: one-shot nudge if Obsidian's automatic link updating is off.
    // Late enough not to compete with startup, and it self-suppresses after the
    // user has seen it once (see maybeWarnLinkUpdatesOff).
    setTimeout(() => this.maybeWarnLinkUpdatesOff(), 9000);
    // 0.92.2: also poll periodically. Focus + one-shot-at-5s missed the case
    // where a newer build lands WHILE the window stays focused (a fresh deploy,
    // or Sync pushing a build mid-session) — without a refocus nothing
    // re-checked, so the reload nudge never appeared. A 45s poll catches it.
    // (checkForSyncedBuild dedupes on version, so a quiet vault costs one cheap
    // manifest read per tick and shows the toast at most once per new version.)
    this.registerInterval(window.setInterval(() => void this.checkForSyncedBuild(), 45_000));
  }


  /** 0.215.0: Obsidian's "Automatically update internal links" is a global
   *  preference Stashpad quietly DEPENDS on, and it is off for a fair number of
   *  people who have never had a reason to think about it.
   *
   *  Why it matters here more than for most plugins: Stashpad re-slugs a note's
   *  FILENAME roughly 30 seconds after its first line changes, via
   *  fileManager.renameFile. With that setting on, Obsidian repoints every
   *  `[[wikilink]]` to the renamed note. With it OFF, each of those renames
   *  silently breaks every link pointing at that note — and re-slugging is
   *  routine, not an edge case, so the damage accumulates quietly.
   *
   *  Deliberately NOT auto-enabled. It is a vault-wide Obsidian preference and
   *  flipping someone's global config from a plugin is not ours to do; the user
   *  may have turned it off on purpose. Explain the consequence, point at the
   *  setting, and let them decide.
   *
   *  Shown at most once per install. The Settings tab keeps a permanent warning
   *  (see the Maintenance section) so the information stays findable after this
   *  toast is dismissed. */
  maybeWarnLinkUpdatesOff(): void {
    try {
      if (!this.linkUpdatesDisabled()) return;
      // 0.246.0: this used to fire ONCE EVER (gated on linkUpdateWarningShown)
      // and then stay quiet while links kept breaking. The condition it warns
      // about is ongoing and silently destructive — a renamed note leaves dead
      // `[[links]]` behind with no error — so the reminder now recurs each
      // launch for as long as the setting is off, and stops by itself the
      // moment it is turned on. A notice you can dismiss but that comes back
      // while the problem persists is the point.
      this.notifications.show({
        message:
          "Obsidian's **Automatically update internal links** is OFF.\n"
          + "Stashpad renames a note's file when its first line changes, and with that setting off "
          + "Obsidian won't repoint `[[links]]` to the renamed note — so those links break silently.\n"
          + "Turn it on in Obsidian's **Settings → Files and links**. This reminder will keep appearing "
          + "while the setting is off.",
        kind: "warning",
        category: "system",
        duration: 0,
      });
    } catch (e) {
      console.warn("[Stashpad] link-update check failed", e);
    }
  }

  /** True when Obsidian's automatic internal-link updating is definitively OFF.
   *  `alwaysUpdateLinks` is undefined on a vault that has never touched the
   *  setting, and Obsidian's own default is ON — so treat only an explicit
   *  false as disabled, and never warn on "unknown". */
  linkUpdatesDisabled(): boolean {
    const cfg = (this.app.vault as { getConfig?: (k: string) => unknown }).getConfig?.("alwaysUpdateLinks");
    return cfg === false;
  }

  /** 0.76.31: compare the version Obsidian LOADED (this.manifest, read
   *  from manifest.json at launch) against the manifest.json currently
   *  on disk. If they differ, a different build has synced in since
   *  launch and the user is running stale code — surface a persistent
   *  notice with a Reload action. 0.89.1: the action now runs the FULL app
   *  reload ("Reload app without saving") — plugin disable/enable often left
   *  the renderer on the cached old main.js, so the update "didn't take".
   *  Notifies once per detected on-disk version. */
  private notifiedBuildVersion: string | null = null;
  /** On-disk version seen on the PREVIOUS check — must match the current one before
   *  we announce it, so a mid-sync manifest churn doesn't spam the notice. */
  private pendingBuildVersion: string | null = null;
  private async checkForSyncedBuild(): Promise<void> {
    try {
      const dir = (this.manifest as any).dir as string | undefined;
      if (!dir) return;
      const path = `${dir.replace(/\/+$/, "")}/manifest.json`;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return;
      const onDisk = JSON.parse(await adapter.read(path))?.version as string | undefined;
      const loaded = this.manifest.version;
      if (typeof onDisk !== "string" || !onDisk || onDisk === loaded) return;
      // 0.76.35: ONLY nudge when the on-disk build is strictly newer than
      // what's running. If on-disk is OLDER (e.g. Obsidian Sync pushed a
      // stale manifest.json back onto disk — a known Sync regression),
      // reloading wouldn't help and the nudge would recur on every window
      // focus forever. Silently ignore older/equal on-disk versions.
      if (!this.isSemverGreater(onDisk, loaded)) return;
      if (this.notifiedBuildVersion === onDisk) return;
      // 0.190.0: require the on-disk version to hold STILL across two consecutive
      // checks before nudging. Mid-sync, manifest.json can land, get rewritten, or
      // flip versions repeatedly — announcing each transient state is what spammed
      // the notice during a big sync. Waiting one interval means we only ever
      // announce a build that actually settled.
      if (this.pendingBuildVersion !== onDisk) {
        this.pendingBuildVersion = onDisk;
        return;
      }
      this.notifiedBuildVersion = onDisk;
      this.notifications.show({
        // 0.214.1: say what is actually known. checkForSyncedBuild only compares
        // the version loaded at launch against the one now on disk — it never
        // checks whether Obsidian Sync is even enabled, and a newer build lands
        // on disk from BRAT, a manual install, the community-store updater, or a
        // local `pnpm run deploy` with Obsidian open. "Synced in" was wrong for
        // every one of those.
        message: `A newer Stashpad build is installed (\`${loaded}\` → \`${onDisk}\`). Reload the app to apply it.`,
        kind: "info",
        category: "system",
        duration: 0,
        actions: [{
          label: "Reload app",
          onClick: () => this.reloadAppForUpdate(),
        }],
      });
    } catch (e) {
      console.debug("[Stashpad] synced-build check failed", e);
    }
  }

  /** 0.89.1: full app reload ("Reload app without saving") — the reliable way to
   *  pick up a freshly-synced build. Plugin disable/enable often left the
   *  renderer on the cached old main.js, so the update wouldn't take. Falls back
   *  to a raw window reload if the command isn't available. */
  reloadAppForUpdate(): void {
    // 0.89.1: leave a one-shot flag so the NEXT load un-ghosts deferred Stashpad
    // tabs. Obsidian defers inactive leaves on launch; after an update reload
    // they'd otherwise sit as blank "ghost" tabs (and dead buttons) until tapped.
    // (We can't activate them here — app:reload tears down this JS context.)
    try { window.localStorage?.setItem(UNGHOST_FLAG, "1"); } catch { /* private mode */ }
    try {
      if ((this.app as any).commands?.executeCommandById?.("app:reload")) return;
    } catch (e) {
      console.warn("[Stashpad] app:reload command failed", e);
    }
    try {
      window.location.reload();
    } catch {
      new Notice("Reload Obsidian (close + reopen) to apply the Stashpad update.");
    }
  }

  /** 0.89.1: if the last reload was our update-reload, load every deferred
   *  Stashpad leaf so the tabs render with the fresh code instead of showing as
   *  blank ghosts. One-shot (clears the flag); only un-ghosts OUR view type. */
  private async unghostStashpadTabsIfFlagged(): Promise<void> {
    let flagged = false;
    try { flagged = window.localStorage?.getItem(UNGHOST_FLAG) === "1"; } catch { /* ignore */ }
    if (!flagged) return;
    try { window.localStorage?.removeItem(UNGHOST_FLAG); } catch { /* ignore */ }
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      try {
        const l = leaf as any;
        if (l.isDeferred && typeof l.loadIfDeferred === "function") await l.loadIfDeferred();
      } catch (e) {
        console.warn("[Stashpad] un-ghost leaf failed", e);
      }
    }
  }

  /** Tiny semver-ish compare: is `a` greater than `b`? Pads to equal
   *  length, numeric per segment. Non-numeric segments compare as 0. */
  private isSemverGreater(a: string, b: string): boolean {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  /** Author files live at "<stashpadFolder>/_authors/<safe-name>-<id>.md".
   *  Returns the {name, id} parsed from a path matching that pattern, or
   *  null if it doesn't fit. */
  private parseAuthorFilePath(path: string): { name: string; id: string } | null {
    const m = path.match(/\/_authors\/([^/]+?)-([a-z0-9]{4,12})\.md$/i);
    if (!m) return null;
    const name = m[1].replace(/-/g, " ");
    return { name, id: m[2] };
  }

  /** Convert an author display name to the safe filename component used
   *  in author file paths. Mirror of currentAuthorLink in view.ts. */
  private authorNameToSafe(name: string): string {
    return name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "author";
  }

  /** Forward sync: rename every existing author stub whose id matches
   *  this.settings.authorId so its filename reflects the new name.
   *  Idempotent (skips files already named correctly), so it's safe to
   *  call after every settings save. Walks all discovered Stashpads
   *  because each has its own _authors folder. */
  async syncAuthorFilesToName(): Promise<void> {
    const id = (this.settings.authorId ?? "").trim();
    const name = (this.settings.authorName ?? "").trim();
    if (!id || !name) return;
    const safe = this.authorNameToSafe(name);
    for (const folder of this.discoverStashpadFolders()) {
      const dir = `${folder}/_authors`;
      if (!(await this.app.vault.adapter.exists(dir))) continue;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(dir + "/")) continue;
        const parsed = this.parseAuthorFilePath(file.path);
        if (!parsed || parsed.id !== id) continue;
        const targetPath = `${dir}/${safe}-${id}.md`;
        let target = file;
        if (file.path !== targetPath) {
          try {
            this.authorRenameInFlight.add(file.path);
            this.authorRenameInFlight.add(targetPath);
            await this.app.fileManager.renameFile(file, targetPath);
            const f2 = this.app.vault.getAbstractFileByPath(targetPath) as TFile | null;
            if (f2) target = f2;
          } catch (e) {
            // The rename never fired, so the reverse listener won't consume
            // these guard entries — drop them here or they leak forever and
            // later swallow a genuine user rename to/from one of these paths.
            this.authorRenameInFlight.delete(file.path);
            this.authorRenameInFlight.delete(targetPath);
            console.warn("[Stashpad] author file rename failed", e);
            continue;
          }
        }
        // Always refresh the stub's H1 + name/role/department frontmatter
        // even when no rename was needed (e.g. user only changed role).
        try { await this.refreshAuthorStub(target); } catch { /* ignore */ }
      }
    }
  }

  /** Rewrite an author stub file's H1 heading + aliases/role/department
   *  frontmatter to match the current settings. Idempotent. 0.77.4: the
   *  display name now lives in the Obsidian-native `aliases` array; the
   *  legacy custom `name` key is migrated away (deleted) here. */
  private async refreshAuthorStub(file: TFile): Promise<void> {
    const name = (this.settings.authorName ?? "").trim();
    const role = (this.settings.authorRole ?? "").trim();
    const dept = (this.settings.authorDepartment ?? "").trim();
    if (!name) return;
    try {
      const raw = await this.app.vault.read(file);
      const replaced = raw.replace(/^# .*$/m, `# ${name}`);
      if (replaced !== raw) await this.app.vault.modify(file, replaced);
      await this.app.fileManager.processFrontMatter(file, (m: any) => {
        // Stashpad owns these stubs, so the alias list is authoritative:
        // set it to exactly the current display name. This avoids
        // accumulating stale names across renames (an old name would
        // otherwise linger as an "extra" alias). Migrate off the legacy
        // custom `name` key.
        m.aliases = [name];
        delete m.name;
        if (role) m.role = role; else delete m.role;
        if (dept) m.department = dept; else delete m.department;
      });
    } catch (e) {
      console.warn("[Stashpad] refreshAuthorStub failed", e);
    }
  }

  /** Track in-flight renames we initiated so the reverse listener
   *  (maybeAdoptAuthorRename) can ignore them and avoid feedback loops. */
  private authorRenameInFlight = new Set<string>();

  /** Reverse sync: when an author stub is renamed in the vault by the
   *  user (or any external process), pick up the new display name and
   *  update settings.authorName. The forward sync runs after to
   *  propagate the change to author stubs in other Stashpad folders. */
  private async maybeAdoptAuthorRename(file: TFile, oldPath: string): Promise<void> {
    // Delete BOTH guard entries (syncAuthorFilesToName adds the old AND the
    // target path) — a short-circuiting `||` would consume only one and leak
    // the other permanently. Non-short-circuiting so both always run.
    const wasSelf = this.authorRenameInFlight.delete(file.path);
    const wasOld = this.authorRenameInFlight.delete(oldPath);
    if (wasSelf || wasOld) return;
    const parsed = this.parseAuthorFilePath(file.path);
    if (!parsed) return;
    const id = (this.settings.authorId ?? "").trim();
    if (!id || parsed.id !== id) return;
    const newName = parsed.name.trim();
    if (!newName || newName === (this.settings.authorName ?? "").trim()) return;
    this.settings.authorName = newName;
    await this.saveSettings();
    await this.syncAuthorFilesToName();
  }

  /** 0.72.5: move a markdown file that landed in <stashpad>/<importSub>
   *  up into the Stashpad root, then stamp Home-rooted frontmatter.
   *  Adopts files a user dropped without packaging into a .stash —
   *  they show up as fresh top-level notes ready to be reparented. */
  private async adoptMarkdownDrop(file: TFile, stashFolder: string): Promise<void> {
    try {
      // Pick a non-colliding destination filename. If <basename>.md
      // already exists in the Stashpad root, append "-1", "-2", … until
      // we find a free slot.
      const adapter = this.app.vault.adapter;
      let destName = file.name;
      const dot = destName.lastIndexOf(".");
      const stem = dot > 0 ? destName.slice(0, dot) : destName;
      const ext = dot > 0 ? destName.slice(dot) : "";
      let suffix = 0;
      while (await adapter.exists(`${stashFolder}/${destName}`)) {
        suffix += 1;
        destName = `${stem}-${suffix}${ext}`;
      }
      const destPath = `${stashFolder}/${destName}`;
      await this.app.fileManager.renameFile(file, destPath);
      // The rename event re-fires onMaybeOrphan via the registered
      // listener, which runs the standard frontmatter backfill. We
      // also call it directly here so the timing is deterministic
      // (no race against the metadataCache reparse) and the user sees
      // the adoption notice promptly.
      const moved = this.app.vault.getAbstractFileByPath(destPath);
      if (moved instanceof TFile) {
        // Small delay so metadataCache catches up to the new path.
        setTimeout(() => { void this.fixOrphanParentForFile(moved); }, 500);
      }
      this.notifications.show({
        message: `Imported \`${file.name}\` → \`${stashFolder}\``,
        kind: "success",
        category: "import",
        folder: stashFolder,
        affectedPaths: [destPath],
      });
    } catch (e) {
      console.warn("Stashpad: markdown drop adoption failed", e);
      this.notifications.show({
        message: `Couldn't import \`${file.name}\`: ${(e as Error).message}`,
        kind: "error",
        category: "import",
      });
    }
  }

  /** Single-file version of fixOrphanParents. Stamps id/parent/created
   *  iff each is missing. Never overwrites an existing value. */
  private async fixOrphanParentForFile(file: TFile): Promise<void> {
    try {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: unknown; parent?: unknown; created?: unknown } | undefined;
      const idStr = typeof fm?.id === "string" ? fm.id.trim() : "";
      const p = fm?.parent;
      const hasParent = typeof p === "string" ? p.trim() !== "" : (p !== undefined && p !== null);
      const hasCreated = typeof fm?.created === "string" && fm.created.trim() !== "";
      const addId = !idStr;
      const addParent = !hasParent;
      const addCreated = !hasCreated;
      if (!addId && !addParent && !addCreated) return;

      let stampedId: string | undefined;
      let stampedParent = false;
      let stampedCreated = false;
      await this.app.fileManager.processFrontMatter(file, (m) => {
        // Re-check inside the write against the file's TRUE frontmatter
        // (the metadataCache may have been stale when we built this
        // task — common on mobile right after a sync brings the file
        // in). Only modify slots that are actually empty on disk.
        if (addId) {
          const cur = typeof m.id === "string" ? m.id.trim() : "";
          if (!cur) { stampedId = this.mintNoteId(); m.id = stampedId; }
        }
        if (addParent) {
          const cur = m.parent;
          const set = typeof cur === "string" ? cur.trim() !== "" : (cur !== undefined && cur !== null);
          if (!set) { m.parent = ROOT_ID; stampedParent = true; }
        }
        if (addCreated) {
          const cur = typeof m.created === "string" ? m.created.trim() : "";
          if (!cur) { m.created = new Date(file.stat.ctime).toISOString(); stampedCreated = true; }
        }
      });
      // No-op if the file was already valid (the cache was stale but the
      // disk content was fine). Don't log, don't notify.
      if (!stampedId && !stampedParent && !stampedCreated) return;
      const log = this.newLog();
      const id = stampedId || idStr;
      if (id) {
        await log.append({
          type: "parent_change", id,
          payload: { from: null, to: ROOT_ID, reason: "orphan_auto_fix", path: file.path,
            addedId: !!stampedId, addedParent: stampedParent, addedCreated: stampedCreated },
        });
      }
      this.notifications.show({
        message: `Adopted \`${file.basename}\` → Home`,
        kind: "success",
        category: "import",
        folder: file.parent?.path?.replace(/\/+$/, "") ?? undefined,
        affectedIds: id ? [id as StashpadId] : undefined,
        affectedPaths: [file.path],
        actions: this.adoptionJumpActions([file]),
      });
    } catch (e) {
      console.warn("Stashpad: orphan auto-fix failed", e);
    }
  }

  /** 0.86.5: paths with a pending re-home check (de-dupes burst rename events). */
  private reHomePending = new Set<string>();

  /** A markdown note's file just moved. If it landed in a DIFFERENT Stashpad
   *  folder and its `parent` points at a note that isn't in the new folder,
   *  re-home it to ROOT after a debounce (lets the metadata cache settle and
   *  lets a Stashpad-initiated move stamp the correct parent first). */
  private maybeReHomeOnCrossFolderMove(file: TFile, oldPath: string): void {
    if (file.extension !== "md") return;
    const newDir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const slash = oldPath.lastIndexOf("/");
    const oldDir = (slash >= 0 ? oldPath.slice(0, slash) : "").replace(/\/+$/, "");
    if (newDir === oldDir) return;                                  // not a cross-folder move
    if (!this.discoverStashpadFolders().includes(newDir)) return;   // not moved into a Stashpad
    if (this.reHomePending.has(file.path)) return;
    this.reHomePending.add(file.path);
    setTimeout(() => {
      this.reHomePending.delete(file.path);
      void this.reHomeDanglingParent(file, newDir);
    }, 900);
  }

  /** Set `parent` to ROOT iff the note's current parent is a non-ROOT id with
   *  no matching note in `dir`. Conservative: a present, resolvable parent (and
   *  one Stashpad's own move already fixed) is left alone. */
  private async reHomeDanglingParent(file: TFile, dir: string): Promise<void> {
    try {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: unknown; parent?: unknown } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      const parent = typeof fm?.parent === "string" ? fm.parent.trim() : "";
      if (!id || !parent || parent === ROOT_ID) return;            // no id / no or home parent
      const parentInFolder = this.app.vault.getMarkdownFiles().some((f) =>
        (f.parent?.path?.replace(/\/+$/, "") ?? "") === dir
        && this.app.metadataCache.getFileCache(f)?.frontmatter?.id === parent);
      if (parentInFolder) return;                                  // parent resolves here — fine
      await this.app.fileManager.processFrontMatter(file, (m: any) => {
        // re-check against disk truth (cache may have lagged)
        const cur = typeof m.parent === "string" ? m.parent.trim() : "";
        if (cur && cur !== ROOT_ID) m.parent = ROOT_ID;
      });
      await this.newLog().append({
        type: "parent_change", id,
        payload: { from: parent, to: ROOT_ID, reason: "rehome_cross_folder_move", path: file.path },
      });
      new Notice(`Re-homed ${file.basename} → Home (its parent isn't in this folder)`);
    } catch (e) {
      console.warn("[Stashpad] re-home on cross-folder move failed", e);
    }
  }

  private async autoImportStash(file: TFile, destFolder: string): Promise<void> {
    try {
      const raw = new Uint8Array(await this.app.vault.readBinary(file));
      // 0.84.16: an encrypted .stash arriving via the live drop-watcher is NOT
      // prompted inline anymore — park it and surface the same non-blocking
      // "import?" notification as the sweep (notification-first; the password
      // modal opens only when you click "Import now"). Don't trash the source.
      if (isEncryptedStash(raw)) {
        this.importService.parkEncrypted(file.path);
        this.notifyPendingEncrypted();
        return;
      }
      // Plain .stash imports straight away.
      const buf = await resolveStashBytes(this.app, raw);
      if (!buf) return;
      const view = getActiveView();
      const existingIds = new Set<string>();
      if (view && typeof (view).collectExistingIds === "function" && (view).noteFolder === destFolder) {
        // Reuse the active view's tree if it already points at the destination folder.
        for (const id of (view).collectExistingIds() as Set<string>) existingIds.add(id);
      } else {
        // Otherwise scan the destination folder ourselves.
        for (const f of this.app.vault.getMarkdownFiles()) {
          if (!f.path.startsWith(destFolder + "/")) continue;
          const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
          if (typeof id === "string") existingIds.add(id);
        }
      }
      const summary = await importStashZip(this.app, buf, destFolder, existingIds, { stripReserved: true });
      try {
        await this.newLog().append({
          type: "stash_import",
          id: ROOT_ID,
          payload: {
            from: file.path, into: destFolder,
            noteCount: summary.notesWritten,
            attachmentsWritten: summary.attachmentsWritten,
            collisionsRenamed: summary.collisionsRenamed,
            auto: true,
          },
        });
      } catch { /* ignore */ }
      // Send the processed file to trash (respects the user's "Deleted files" setting in Obsidian).
      try { await this.app.fileManager.trashFile(file); } catch { /* ignore */ }
      const parts = [`Auto-imported ${summary.notesWritten} note${summary.notesWritten === 1 ? "" : "s"} from ${file.name}`];
      if (summary.attachmentsWritten) parts.push(`+ ${summary.attachmentsWritten} attachment${summary.attachmentsWritten === 1 ? "" : "s"}`);
      if (summary.collisionsRenamed) parts.push(`(${summary.collisionsRenamed} renamed)`);
      this.notifications.show({
        message: parts.join(" "),
        kind: "success",
        category: "import",
        folder: destFolder,
      });
      if (view && typeof (view).debouncedRender === "function") (view).debouncedRender();
    } catch (e) {
      this.notifications.show({
        message: `Stashpad: auto-import failed\nFile: \`${file.name}\`\nError: ${(e as Error).message}\nInspect with the buttons below — rename to .zip to crack it open in an archive tool.`,
        kind: "error",
        category: "import",
        affectedPaths: [file.path],
        // On failure, the source .stash is NOT trashed (only success
        // trashes), so the file is still at its drop path. Reveal /
        // Show actions point at it for inspection.
        actions: buildFileActions(this.app, file.path, Platform.isMobile),
      });
      console.error(e);
    }
  }

  /** Resolve a Stashpad id → all author + contributor ids for that
   *  note. Author lives in frontmatter as a wikilink (e.g.
   *  `[[demo/_authors/Jane-743jcy.md|Jane]]`); contributors is an
   *  array of the same shape. Each wikilink has the authorId as the
   *  `-<id>` suffix of the target's basename.
   *
   *  Returns the distinct list — for the history modal's
   *  Cross-author filter, "any party of an affected note differs
   *  from the actor" is enough to qualify.
   *
   *  O(n) per call (full vault scan). Acceptable since this fires
   *  only inside the history filter, not in any hot path. Returns
   *  [] when the id isn't found or all fields are absent / malformed. */
  lookupNoteAuthorIds(id: string): string[] {
    const out = new Set<string>();
    const extract = (raw: unknown): string | null => {
      if (typeof raw !== "string") return null;
      const m = raw.match(/-([a-z0-9]{4,12})(?:\.md)?(?:\||\]\])/i);
      return m ? m[1] : null;
    };
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.id !== id) continue;
      const author = extract(fm?.author);
      if (author) out.add(author);
      const contribs = fm?.contributors;
      if (Array.isArray(contribs)) {
        for (const c of contribs) {
          const cid = extract(c);
          if (cid) out.add(cid);
        }
      }
      break;
    }
    return Array.from(out);
  }

  /** Back-compat wrapper for callers that just want the primary
   *  author. Unused since 0.55.15 — the history modal now consumes
   *  lookupNoteAuthorIds directly — but kept for downstream / future
   *  callers that need the simpler shape. */
  lookupNoteAuthorId(id: string): string | null {
    return this.lookupNoteAuthorIds(id)[0] ?? null;
  }

  /** Walk every folder in the vault that contains a Stashpad home note (id=__root__),
   *  ensure it has the import/export subfolders, and run the redundant-frontmatter
   *  backfill (parentLink + children) so older notes pick up the recovery fields.
   *  Used by the "Rebootstrap" button in settings to retrofit older folders. */
  /** 0.118.4: run rebootstrap with a persistent progress Notice (bar advances
   *  per folder, weighted by note count) that's replaced in place by a
   *  persistent success (or error) Notice. Shared by the settings button + the
   *  command so both get the same feedback. */
  async runRebootstrapWithUI(): Promise<{ touched: string[]; fmChecked: number; fmWritten: number; slugsRenamed: number; authors: number; imported: number; attachmentsLinked: number; attachmentsRenamed: number; attachmentsSkipped: number }> {
    const notice = new Notice("", 0); // persistent until we replace/dismiss it
    const el = notice.noticeEl;
    el.empty();
    el.addClass("stashpad-progress-notice");
    el.createDiv({ cls: "stashpad-progress-title", text: "Rebootstrapping Stashpad folders…" });
    const bar = el.createDiv({ cls: "stashpad-progress-bar" });
    const fill = bar.createDiv({ cls: "stashpad-progress-fill" });
    const sub = el.createDiv({ cls: "stashpad-progress-sub", text: "Counting notes…" });
    const onProgress = (done: number, total: number, label: string): void => {
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      fill.style.width = `${pct}%`;
      sub.setText(label ? `${label} · ${pct}%` : `${pct}%`);
    };
    try {
      const r = await this.rebootstrapAllFolders(onProgress);
      // 0.118.9: lead with the outcome, and say so explicitly when nothing
      // needed changing (so an empty-looking summary isn't ambiguous).
      const changes = r.imported + r.attachmentsLinked + r.attachmentsRenamed + r.fmWritten + r.slugsRenamed;
      const parts: string[] = [];
      parts.push(`Checked ${r.touched.length} folder${r.touched.length === 1 ? "" : "s"} (${r.fmChecked} note${r.fmChecked === 1 ? "" : "s"})`);
      if (changes === 0) {
        parts.push("everything already in sync — no changes needed");
      } else {
        if (r.fmWritten > 0) parts.push(`updated frontmatter on ${r.fmWritten} note${r.fmWritten === 1 ? "" : "s"}`);
        if (r.slugsRenamed > 0) parts.push(`renamed ${r.slugsRenamed} note${r.slugsRenamed === 1 ? "" : "s"} to match body`);
        if (r.imported > 0) parts.push(`imported ${r.imported} loose file${r.imported === 1 ? "" : "s"}`);
        if (r.attachmentsLinked > 0) parts.push(`linked attachments on ${r.attachmentsLinked} note${r.attachmentsLinked === 1 ? "" : "s"}`);
        if (r.attachmentsRenamed > 0) parts.push(`renamed ${r.attachmentsRenamed} attachment${r.attachmentsRenamed === 1 ? "" : "s"}`);
      }
      if (r.authors > 0) parts.push(`${r.authors} author${r.authors === 1 ? "" : "s"} in registry`);
      // Replace the progress notice in place with a persistent success notice.
      // (No need to animate the bar to 100% — el.empty() below removes it
      // synchronously before the browser can paint, so it would never show.)
      el.empty();
      el.removeClass("stashpad-progress-notice");
      el.addClass("stashpad-progress-done");
      el.createDiv({ cls: "stashpad-progress-title", text: "✓ Rebootstrap complete" });
      el.createDiv({ cls: "stashpad-progress-sub", text: `${parts.join("; ")}.` });
      if (r.attachmentsSkipped > 0) {
        new Notice(`Stashpad: ${r.attachmentsSkipped} attachment${r.attachmentsSkipped === 1 ? "" : "s"} need renaming, but skipped to protect links. Enable Settings → Files & Links → “Automatically update internal links”, then rebootstrap again.`, 12000);
      }
      return r;
    } catch (e) {
      el.empty();
      el.removeClass("stashpad-progress-notice");
      el.addClass("stashpad-progress-error");
      el.createDiv({ cls: "stashpad-progress-title", text: "Rebootstrap failed" });
      el.createDiv({ cls: "stashpad-progress-sub", text: (e as Error).message });
      throw e;
    }
  }

  async rebootstrapAllFolders(onProgress?: (done: number, total: number, label: string) => void): Promise<{ touched: string[]; fmChecked: number; fmWritten: number; slugsRenamed: number; authors: number; imported: number; attachmentsLinked: number; attachmentsRenamed: number; attachmentsSkipped: number }> {
    // 0.79.19: suppress contribution stamping for the duration (+ a short
    // tail to catch async link-rewrite modify events) so rebootstrap never
    // bumps `modified`/`created` or adds contributors.
    this.rebootstrapInProgress = true;
    try {
      return await this.rebootstrapAllFoldersInner(onProgress);
    } finally {
      window.setTimeout(() => {
        this.rebootstrapInProgress = false;
        // Suppression is lifted — repaint open Stashpad views ONCE so they
        // reflect the rebootstrapped tree (the per-note metadata renders were
        // dropped while rebootstrapInProgress was true).
        for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
          const v = leaf.view as { forceReconcileRender?: () => void };
          v?.forceReconcileRender?.();
        }
      }, 2500);
    }
  }

  private async rebootstrapAllFoldersInner(onProgress?: (done: number, total: number, label: string) => void): Promise<{ touched: string[]; fmChecked: number; fmWritten: number; slugsRenamed: number; authors: number; imported: number; attachmentsLinked: number; attachmentsRenamed: number; attachmentsSkipped: number }> {
    const ROOT_ID = "__root__";
    const seen = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (id !== ROOT_ID) continue;
      const folder = f.parent?.path;
      if (folder) seen.add(folder);
    }
    // 0.118.4: progress weighting. Count each folder's notes ONCE here (no
    // persistent cache needed — we're about to walk everything anyway) so the
    // bar advances in proportion to folder size. `total` is the note count
    // across all home-note folders; a folder advances the bar by its own count.
    const fileCount = new Map<string, number>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const p = f.parent?.path;
      if (p && seen.has(p)) fileCount.set(p, (fileCount.get(p) ?? 0) + 1);
    }
    const progressTotal = Math.max(1, [...fileCount.values()].reduce((a, b) => a + b, 0));
    let progressDone = 0;
    onProgress?.(0, progressTotal, "Starting…");
    const importSub = (this.settings.importDropFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const exportSub = (this.settings.exportFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const touched: string[] = [];
    const ensureFolder = async (path: string) => {
      if (!path) return;
      if (await this.app.vault.adapter.exists(path)) return;
      try {
        await this.app.vault.createFolder(path);
      } catch (e) {
        const msg = (e as Error)?.message ?? "";
        if (!/already exists/i.test(msg)) throw e;
      }
    };
    let fmChecked = 0;
    let fmWritten = 0;
    let slugsRenamed = 0;
    let imported = 0;
    let attachmentsRenamed = 0;
    let attachmentsSkipped = 0;
    // Renaming attachments only updates their links if Obsidian is configured
    // to do so; otherwise we detect-but-skip and warn (see rebootstrapFolderAttachments).
    const linkUpdatesOn = !!(this.app.vault as { getConfig?: (k: string) => unknown }).getConfig?.("alwaysUpdateLinks");
    const okfSet = new Set(this.okfActiveFolders());
    for (const folder of seen) {
      const fcount = fileCount.get(folder) ?? 1;
      onProgress?.(progressDone, progressTotal, `Processing “${folder.split("/").pop() || folder}” (${fcount} note${fcount === 1 ? "" : "s"})`);
      try {
        if (importSub) await ensureFolder(`${folder}/${importSub}`);
        if (exportSub) await ensureFolder(`${folder}/${exportSub}`);
        // 0.79.5: sweep any pre-existing loose files in the folder root
        // into notes (the rebootstrap "provision" for auto-import). Gated
        // on the autoImport setting so a user who turned it off isn't
        // surprised. Runs before the frontmatter backfill so the new notes
        // get stamped in the same pass.
        // 0.84.7: now goes through the shared importLooseInto (files +
        // folders), so rebootstrap also sweeps loose SUBFOLDERS into nested
        // note trees and inherits the reserved-merge / identity-preserving
        // adoption fixes — same code path as the standalone command.
        if (this.settings.autoImport) {
          try {
            const swept = await this.importService.importLooseInto(folder);
            imported += swept.files + swept.folders + swept.stashes;
          } catch (e) { console.warn("Stashpad: loose sweep failed", folder, e); }
        }
        // Standalone (no-view-required) frontmatter backfill: reads
        // metadata cache, skip-if-equal, writes only what's actually
        // different. Paced internally so multi-folder rebootstrap
        // doesn't stall the FS.
        // 0.271.7: a full rebootstrap also backfills readable aliases
        // (append-only). This is the "run rebootstrap again" path the user
        // means; the narrower recovery-link backfill stays alias-free.
        const stats = await rebootstrapFolderFrontmatter(this.app, folder, { writeAliases: true });
        fmChecked += stats.checked;
        fmWritten += stats.written;
        // 0.58.1: rename files whose slug no longer matches their body's
        // first line — catches notes from before the auto-retitle logic
        // landed (and any whose body was edited without the per-view
        // scheduleSlugRename firing).
        slugsRenamed += await this.rebootstrapFolderSlugs(folder);
        // 0.109.0: migrate legacy prefix-stamped attachments to suffix form.
        const att = await this.rebootstrapFolderAttachments(folder, linkUpdatesOn);
        attachmentsRenamed += att.renamed;
        attachmentsSkipped += att.skipped;
        // 0.102.x: rebootstrap also fixes OKF frontmatter + regenerates index.md
        // for OKF-enabled folders (those using the OKF template). The OKF-section
        // "Rebuild" button is just a scoped shortcut to this same pass — not an
        // alias for the whole rebootstrap.
        if (okfSet.has(folder.replace(/\/+$/, ""))) {
          try { await rebuildOkfForFolder(this.app, folder); } catch (e) { console.warn("Stashpad: OKF rebuild during rebootstrap failed", folder, e); }
        }
        touched.push(folder);
      } catch (e) {
        console.warn(`Stashpad: rebootstrap skipped ${folder}`, e);
      } finally {
        progressDone += fcount;
        onProgress?.(progressDone, progressTotal, `Processing “${folder.split("/").pop() || folder}”`);
      }
    }
    onProgress?.(progressTotal, progressTotal, "Finalizing…");
    // 0.77.6: rebootstrap is the catch-all full-vault repair, so refresh
    // the author registry cache from the same scan. This is read-only
    // w.r.t. the user's notes (it only rewrites the plugin-private
    // authors.json). NOTE: we deliberately do NOT restore deleted author
    // STUB files here — that creates files and a user may have deleted a
    // page on purpose; stub restoration stays an explicit action.
    let authors = 0;
    try { authors = (await this.rebuildAuthorRegistry()).total; }
    catch (e) { console.warn("Stashpad: rebootstrap author-registry rebuild failed", e); }
    // 0.79.18: convert any plain-text attachment frontmatter to links.
    let attachmentsLinked = 0;
    try { attachmentsLinked = await this.convertAttachmentsToLinks(); }
    catch (e) { console.warn("Stashpad: attachment-link conversion failed", e); }
    // 0.213.1: re-home attachments stranded in the wrong folder, and report the
    // shared ones. Runs AFTER convertAttachmentsToLinks so plain-text
    // attachment frontmatter has already become real links — otherwise those
    // references wouldn't be in resolvedLinks and their files would look
    // unreferenced.
    let strays = { moved: 0, shared: 0, unreferenced: 0, sharedPaths: [] as string[] };
    try { strays = await this.rehomeStrayAttachments(touched); }
    catch (e) { console.warn("Stashpad: stray-attachment re-home failed", e); }
    // 0.219.8: duplicate ids are exactly the kind of thing a maintenance sweep
    // should surface — but NOT silently repair. Re-minting changes note
    // identity, and a sync conflict copy may hold edits worth reading first, so
    // rebootstrap reports and offers; it never rewrites ids on its own.
    try {
      const dupes = this.duplicateGroupsEverywhere();
      if (dupes.length) {
        const hidden = dupes.reduce((n, f) =>
          n + f.groups.reduce((m, g) => m + g.files.filter((x) => !x.isShown).length, 0), 0);
        this.notifications.show({
          message: `Rebootstrap also found duplicate note ids: ${hidden} note${hidden === 1 ? " is" : "s are"} hidden `
            + `in ${dupes.length === 1 ? `**${dupes[0].folder}**` : `${dupes.length} folders`}. Nothing was changed.`,
          kind: "warning", category: "system", duration: 0,
          actions: [{ label: "Review duplicates", onClick: () => { this.openDuplicatesModal(dupes); } }],
        });
      }
    } catch (e) { console.warn("Stashpad: duplicate-id scan during rebootstrap failed", e); }
    if (strays.moved || strays.shared) {
      const lines: string[] = [];
      if (strays.moved) lines.push(`Moved ${strays.moved} attachment${strays.moved === 1 ? "" : "s"} into the folder whose notes actually use ${strays.moved === 1 ? "it" : "them"}.`);
      if (strays.shared) {
        lines.push(
          `${strays.shared} attachment${strays.shared === 1 ? " is" : "s are"} shared across SEVERAL folders, so ${strays.shared === 1 ? "it was" : "they were"} left where ${strays.shared === 1 ? "it is" : "they are"} — there is no single correct home, and moving ${strays.shared === 1 ? "it" : "them"} would break the other folders' notes. Deleting a folder that holds one of these breaks the notes elsewhere that link to it.`,
        );
        for (const p of strays.sharedPaths.slice(0, 10)) lines.push(`• \`${p}\``);
        if (strays.sharedPaths.length > 10) lines.push(`• …+${strays.sharedPaths.length - 10} more (see console)`);
        if (strays.sharedPaths.length > 10) console.warn("[Stashpad] shared attachments:", strays.sharedPaths);
      }
      this.notifications.show({
        message: lines.join("\n"),
        kind: strays.shared ? "warning" : "success",
        category: "attachment",
        duration: strays.shared ? 0 : 6000,
      });
    }
    return { touched, fmChecked, fmWritten, slugsRenamed, authors, imported, attachmentsLinked, attachmentsRenamed, attachmentsSkipped };
  }

  /** Walk every Stashpad note in `folder`. For each one whose filename
   *  slug no longer matches its current body's first line, rename via
   *  fileManager.renameFile. Returns the number of files renamed.
   *  Standalone — no view dependency. 0.58.1. */
  private async rebootstrapFolderSlugs(folder: string): Promise<number> {
    const ROOT_ID = "__root__";
    const dir = folder.replace(/\/+$/, "");
    const stopwords = this.settings.slugStopWords ?? DEFAULT_STOPWORDS;
    let renamed = 0;
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.parent?.path?.replace(/\/+$/, "") ?? "";
      return p === dir;
    });
    for (const file of files) {
      const fmIdRaw = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
      const fmId = typeof fmIdRaw === "string" ? fmIdRaw : null;
      // Prefer the filename's `-<id>` suffix; fall back to the FRONTMATTER id
      // when the filename lacks one — but ONLY if it's a real 6-char note id, so
      // a hand-renamed Stashpad note (name stripped of its id) gets repaired
      // without ever renaming a foreign file that merely carries an `id:` field.
      const fnId = parseIdFromFilename(file.basename);
      const id = fnId ?? (isNoteId(fmId) ? fmId : null);
      if (!id || id === ROOT_ID) continue;
      // Confirm it's actually a Stashpad note (id matches frontmatter).
      if (fmId !== id) continue;
      try {
        const raw = await this.app.vault.cachedRead(file);
        const body = raw.startsWith("---")
          ? raw.slice(raw.indexOf("\n---", 3) + 4).replace(/^\r?\n/, "")
          : raw;
        const newSlug = bodyToSlug(body, stopwords);
        const desired = buildFilename(newSlug, id);
        if (file.name === desired) continue;
        const newPath = file.parent ? `${file.parent.path}/${desired}` : desired;
        if (this.app.vault.getAbstractFileByPath(newPath)) continue;
        await this.app.fileManager.renameFile(file, newPath);
        renamed += 1;
      } catch (e) {
        console.warn(`Stashpad: slug rebootstrap skipped ${file.path}`, e);
      }
    }
    return renamed;
  }

  /** Migrate legacy prefix-stamped attachments (`<stamp>-name.ext`) in
   *  `<folder>/_attachments` to the suffix form (`name-<stamp>.ext`). Uses
   *  fileManager.renameFile so Obsidian rewrites the `![[links]]` in note bodies
   *  AND the `attachments` frontmatter — but ONLY when "Automatically update
   *  internal links" is on. When it's off, renaming would orphan every link, so
   *  we don't touch anything and report a `skipped` count instead; the caller
   *  warns the user to enable the setting and run again. 0.109.0. */
  private async rebootstrapFolderAttachments(
    folder: string,
    linkUpdatesOn: boolean,
  ): Promise<{ renamed: number; skipped: number }> {
    const dir = `${folder.replace(/\/+$/, "")}/_attachments`;
    const af = this.app.vault.getAbstractFileByPath(dir);
    if (!(af instanceof TFolder)) return { renamed: 0, skipped: 0 };
    // Snapshot first — renaming mutates the live children listing mid-loop.
    const files = af.children.filter((c): c is TFile => c instanceof TFile);
    let renamed = 0;
    let skipped = 0;
    for (const file of files) {
      const legacy = parseLegacyAttachmentPrefix(file.name);
      if (!legacy) continue;
      const desired = buildAttachmentName(legacy.rest, legacy.stamp);
      if (file.name === desired) continue;
      if (!linkUpdatesOn) { skipped += 1; continue; }
      const newPath = `${dir}/${desired}`;
      if (this.app.vault.getAbstractFileByPath(newPath)) continue;
      try {
        await this.app.fileManager.renameFile(file, newPath);
        renamed += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch (e) {
        console.warn(`Stashpad: attachment rebootstrap skipped ${file.path}`, e);
      }
    }
    return { renamed, skipped };
  }

  /** 0.213.1 (part 2 of the attachment-ownership work): re-home attachments that
   *  are stranded in the wrong Stashpad folder, and REPORT the ones that can't
   *  be re-homed rather than guessing.
   *
   *  These are the pre-existing strays — mostly from the composer bug fixed in
   *  0.213.0, where a file attached in folder A stayed in A/_attachments after
   *  the note was sent to B. Part 1 stops new ones being made; this cleans up
   *  what is already on disk.
   *
   *  The rule is deliberately conservative, and it is the whole design:
   *  - referenced by notes in exactly ONE folder, and that folder is not the one
   *    holding the file → move it there. Unambiguous, so act.
   *  - referenced from SEVERAL folders → leave it and report it. A file used by
   *    three folders has no correct single home; picking one would break the
   *    other two. This is the case the user asked about, and reporting is the
   *    honest answer.
   *  - referenced by nothing → leave it alone. It may be deliberate, and
   *    deleting or moving unreferenced files is not this pass's job.
   *
   *  Reads the reverse index from metadataCache.resolvedLinks (in-memory, and it
   *  includes embeds) rather than scanning bodies, so this stays cheap on a big
   *  vault. */
  private async rehomeStrayAttachments(
    folders: string[],
  ): Promise<{ moved: number; shared: number; unreferenced: number; sharedPaths: string[] }> {
    // attachment vault path -> the folders AND the individual notes referencing it.
    // The note paths matter: we rewrite their links ourselves (see below).
    const refFolders = new Map<string, Set<string>>();
    const refNotes = new Map<string, Set<string>>();
    const links = this.app.metadataCache.resolvedLinks ?? {};
    for (const [src, targets] of Object.entries(links)) {
      const srcDir = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
      for (const target of Object.keys(targets ?? {})) {
        if (!target.includes("/_attachments/")) continue;
        let set = refFolders.get(target);
        if (!set) { set = new Set(); refFolders.set(target, set); }
        set.add(srcDir);
        let notes = refNotes.get(target);
        if (!notes) { notes = new Set(); refNotes.set(target, notes); }
        notes.add(src);
      }
    }

    let moved = 0, shared = 0, unreferenced = 0;
    const sharedPaths: string[] = [];
    for (const folder of folders) {
      const dir = `${folder.replace(/\/+$/, "")}/_attachments`;
      const af = this.app.vault.getAbstractFileByPath(dir);
      if (!(af instanceof TFolder)) continue;
      // Snapshot — renaming mutates the live children listing mid-loop.
      const files = af.children.filter((c): c is TFile => c instanceof TFile);
      for (const file of files) {
        const refs = refFolders.get(file.path);
        if (!refs || refs.size === 0) { unreferenced += 1; continue; }
        if (refs.size > 1) { shared += 1; sharedPaths.push(file.path); continue; }
        const [only] = [...refs];
        const home = only.replace(/\/+$/, "");
        // Already where it belongs, or referenced from a non-Stashpad location
        // we shouldn't be moving things into.
        if (!home || home === dir.replace(/\/_attachments$/, "") || !folders.includes(home)) continue;
        const destDir = `${home}/_attachments`;
        const from = file.path;
        try {
          await this.ensureFolderPath(destDir);
          let target = `${destDir}/${file.name}`;
          for (let i = 1; i < 1000 && this.app.vault.getAbstractFileByPath(target); i++) {
            target = `${destDir}/${buildAttachmentName(file.name, `${i}`)}`;
          }
          // vault.rename, NOT fileManager.renameFile — and we rewrite the links
          // ourselves afterwards. fileManager's automatic link updating obeys the
          // user's "New link format" setting, which on the default "shortest"
          // rewrites Stashpad's ABSOLUTE `![[Folder/_attachments/x.png]]` down to
          // a bare `![[x.png]]`. That still resolves today, but it reintroduces
          // exactly the basename ambiguity the 0.211.4 (F2) fix eliminated —
          // attachment identity is the vault PATH, never the basename — and this
          // pass moves files BETWEEN folders, which is where same-name collisions
          // actually happen. Doing it by hand keeps links absolute and also drops
          // the dependency on the user's automatic-link-update setting.
          await this.app.vault.rename(file, target);
          for (const notePath of refNotes.get(from) ?? []) {
            const nf = this.app.vault.getAbstractFileByPath(notePath);
            if (!(nf instanceof TFile)) continue;
            try {
              const body = await this.app.vault.read(nf);
              const next = body
                .split(`[[${from}]]`).join(`[[${target}]]`)
                .split(`[[${from}|`).join(`[[${target}|`);
              if (next !== body) await this.app.vault.modify(nf, next);
            } catch (e) {
              console.warn(`Stashpad: couldn't repoint ${notePath} after re-homing ${from}`, e);
            }
          }
          moved += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
        } catch (e) {
          console.warn(`Stashpad: couldn't re-home stray attachment ${from}`, e);
        }
      }
    }
    return { moved, shared, unreferenced, sharedPaths };
  }

  /** 0.213.2 (part 3): which attachments inside `folder` are embedded by notes
   *  OUTSIDE it — i.e. what deleting this folder would break elsewhere.
   *
   *  Deleting a Stashpad folder takes its `_attachments` with it, so any note in
   *  another folder that embeds one of those files loses its image with no
   *  warning and no obvious cause. This is the pre-flight for that.
   *
   *  Returns the attachment paths plus the set of outside folders affected, so
   *  the caller can say what breaks and where. */
  outsideReferencesToFolderAttachments(folder: string): { paths: string[]; folders: string[] } {
    const dir = `${folder.replace(/\/+$/, "")}/_attachments/`;
    const paths = new Set<string>();
    const folders = new Set<string>();
    const links = this.app.metadataCache.resolvedLinks ?? {};
    for (const [src, targets] of Object.entries(links)) {
      // A note inside the folder being deleted is going away too — only notes
      // that SURVIVE the delete can be broken by it.
      if (src.startsWith(`${folder.replace(/\/+$/, "")}/`)) continue;
      for (const target of Object.keys(targets ?? {})) {
        if (!target.startsWith(dir)) continue;
        paths.add(target);
        folders.add(src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "(vault root)");
      }
    }
    return { paths: [...paths], folders: [...folders] };
  }

  // ---------- Sidebar panels (0.68.0) ----------

  /** 0.74.1: subscribe to Stashpad-view selection changes. Listeners
   *  fire whenever a Stashpad view's cursor/selection mutates. The
   *  detail panel uses this to re-render in lock-step with the user
   *  arrow-keying through the list. Returns an unsubscribe handle. */
  onStashpadSelectionChange(fn: () => void): () => void {
    this.stashpadSelectionListeners.add(fn);
    return () => this.stashpadSelectionListeners.delete(fn);
  }

  /** 0.74.1: called by StashpadView whenever its cursor/selection
   *  changes. Public so the view layer can fire from any selection-
   *  mutation site (selectCursor, handleRowClick, Escape collapse,
   *  navigate). Listener exceptions are swallowed so one broken
   *  subscriber can't break the rest. */
  notifyStashpadSelectionChanged(): void {
    for (const fn of this.stashpadSelectionListeners) {
      try { fn(); } catch (e) { console.warn("[Stashpad] selection listener failed", e); }
    }
  }

  /** 0.74.6: subscribe to Stashpad content changes (every render that
   *  isn't a deliberate selection change). The detail panel uses this
   *  to refresh its body + children list while staying pinned to the
   *  same note. Returns an unsubscribe handle. */
  onStashpadContentChange(fn: () => void): () => void {
    this.stashpadContentListeners.add(fn);
    return () => this.stashpadContentListeners.delete(fn);
  }

  /** 0.74.6: fired from StashpadView.render() — "something repainted,
   *  but the user didn't necessarily switch notes." */
  notifyStashpadContentChanged(): void {
    for (const fn of this.stashpadContentListeners) {
      try { fn(); } catch (e) { console.warn("[Stashpad] content listener failed", e); }
    }
  }

  /** 0.74.1: snapshot of "which Stashpad note is currently selected"
   *  for the detail panel. Returns null when no Stashpad view is
   *  active or when no row is selected/cursored. */
  /** 0.220.0: the last-active Stashpad leaf, but ONLY if it is still open.
   *
   *  `lastActiveStashpadLeaf` is assigned on activation and never cleared when
   *  the tab closes, so a detached leaf keeps its view object alive with its
   *  last `currentChildren` / `cursorIdx` intact. Anything reading it after the
   *  close — the detail panel especially — kept reporting a selection from a
   *  tab that no longer exists. Verifying against the live workspace is the
   *  only reliable test; the reference itself looks perfectly valid. Clears the
   *  stale reference as a side effect so the check is paid once. */
  activeStashpadLeafIfOpen(): WorkspaceLeaf | null {
    const leaf = this.lastActiveStashpadLeaf;
    if (!leaf) return null;
    let alive = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l === leaf) alive = true; });
    if (!alive) { this.lastActiveStashpadLeaf = null; return null; }
    return leaf;
  }

  getActiveStashpadSelection(): { folder: string; id: StashpadId; file: TFile } | null {
    const leaf = this.activeStashpadLeafIfOpen();
    const view = leaf?.view as any;
    if (!view || view.getViewType?.() !== STASHPAD_VIEW_TYPE) return null;
    const folder = (view.noteFolder as string | undefined) ?? "";
    if (!folder) return null;
    // Prefer the cursor row; fall back to the first selected id.
    const children: Array<{ id: StashpadId; file: TFile | null }> = view.currentChildren ?? [];
    let node: { id: StashpadId; file: TFile | null } | undefined;
    if (typeof view.cursorIdx === "number" && view.cursorIdx >= 0) {
      node = children[view.cursorIdx];
    }
    if (!node && view.selection?.size > 0) {
      const firstId = view.firstSelectedId ?? [...view.selection][0];
      node = children.find((n) => n.id === firstId);
    }
    if (!node?.file) return null;
    return { folder, id: node.id, file: node.file };
  }

  /** 0.86.3: pin state lives in the NOTE'S frontmatter (`pinned: true` +
   *  `pinnedAt` epoch-ms order key) so it syncs with the note across devices,
   *  rather than in per-device plugin data. */
  fileForPin(folder: string, id: string): TFile | null {
    const dir = folder.replace(/\/+$/, "");
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== dir) continue;
      if (this.app.metadataCache.getFileCache(f)?.frontmatter?.id === id) return f;
    }
    return null;
  }

  /** Pin a note. Idempotent — writes `pinned: true` + `pinnedAt` to its FM. */
  async pinNote(pin: PinnedNoteRef): Promise<void> {
    const file = this.fileForPin(pin.folder, pin.id);
    if (!file) return;
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned === true) return;
    await this.app.fileManager.processFrontMatter(file, (fm: any) => {
      fm.pinned = true;
      fm.pinnedAt = Date.now();
    });
    this.refreshPanelsView();
  }

  /** Remove a pin (clears the frontmatter keys). Idempotent. */
  async unpinNote(pin: PinnedNoteRef): Promise<void> {
    const file = this.fileForPin(pin.folder, pin.id);
    if (!file) return;
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned !== true) return;
    await this.app.fileManager.processFrontMatter(file, (fm: any) => {
      delete fm.pinned;
      delete fm.pinnedAt;
    });
    this.refreshPanelsView();
  }

  isPinned(pin: PinnedNoteRef): boolean {
    const file = this.fileForPin(pin.folder, pin.id);
    if (!file) return false;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned === true;
  }

  /** All pinned notes across discovered Stashpad folders, ordered by `pinnedAt`
   *  (then path for stability). One metadata-cache scan — backs both the panels
   *  Pinned section and the folder panel. */
  listPinnedNotes(): Array<{ folder: string; id: string; pinnedAt: number; file: TFile }> {
    const folders = new Set(this.discoverStashpadFolders());
    const out: Array<{ folder: string; id: string; pinnedAt: number; file: TFile }> = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!folders.has(dir)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      if (!fm || fm.pinned !== true || typeof fm.id !== "string" || !fm.id) continue;
      const at = typeof fm.pinnedAt === "number" ? fm.pinnedAt : 0;
      out.push({ folder: dir, id: fm.id, pinnedAt: at, file: f });
    }
    out.sort((a, b) => a.pinnedAt - b.pinnedAt || a.file.path.localeCompare(b.file.path));
    return out;
  }

  /** 0.86.3: one-time migration — convert the old per-device
   *  `settings.pinnedNotes` list into `pinned`/`pinnedAt` frontmatter so pins
   *  sync. Runs after layout-ready (metadata cache settled); clears the setting
   *  when done so it never re-runs. */
  private async migratePinnedNotesToFrontmatter(): Promise<void> {
    const list = this.settings.pinnedNotes ?? [];
    if (list.length === 0) return;
    let stamp = Date.now() - list.length * 1000; // preserve order via increasing ts
    for (const pin of list) {
      const file = this.fileForPin(pin.folder, pin.id);
      if (!file) { stamp += 1000; continue; }
      try {
        if (this.app.metadataCache.getFileCache(file)?.frontmatter?.pinned !== true) {
          const at = stamp;
          await this.app.fileManager.processFrontMatter(file, (fm: any) => {
            fm.pinned = true;
            fm.pinnedAt = at;
          });
        }
      } catch (e) { console.warn("[Stashpad] pin migration failed for", pin, e); }
      stamp += 1000;
    }
    this.settings.pinnedNotes = [];
    await this.saveSettings();
    this.refreshPanelsView();
  }

  /** Force any open panels view to re-render — used after pin/unpin. */
  private refreshPanelsView(): void {
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_PANELS_VIEW_TYPE);
    for (const leaf of leaves) {
      const v = leaf.view as any;
      if (v && typeof v.render === "function") v.render();
    }
  }

  /** Re-render every open Stashpad list view — used after a setting that changes
   *  how rows render (e.g. hide-locked-titles) so the change shows immediately. */
  refreshAllStashpadViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const v = leaf.view as any;
      if (v && typeof v.render === "function") v.render();
    }
  }

  /** 0.267.6: re-render every view AND drop the "I already peeked at this"
   *  state first.
   *
   *  `revealedObscured` is per-view and in-memory — deliberately, since
   *  revealing is a viewing state rather than a property of the note. But
   *  nothing cleared it when the obscure SETTINGS changed, so flipping the
   *  global switch off and on left every note revealed before the flip still
   *  showing. Reported as "it is not covering up the five notes at the bottom
   *  that I revealed before".
   *
   *  Turning the switch on is an explicit "hide everything, now". Honouring a
   *  stale peek defeats exactly the moment the switch exists for. */
  reHideAndRefreshAllViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const v = leaf.view as any;
      v?.clearObscureReveals?.();
      if (typeof v?.render === "function") v.render();
    }
  }

  /** Repaint open folder panels — e.g. after a settings change flips a folder's
   *  archive flag, so its icon updates without waiting for a vault event. */
  refreshFolderPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_FOLDER_PANEL_VIEW_TYPE)) {
      const v = leaf.view as any;
      if (v && typeof v.refresh === "function") v.refresh();
    }
  }

  /** 0.118.0: the user-chosen Lucide icon id for a folder's tab/panel, or
   *  undefined to use the default. Keyed by cleaned folder path. */
  getFolderIcon(folder: string): string | undefined {
    const key = (folder || "").replace(/\/+$/, "");
    const v = this.settings.folderIcons?.[key];
    return v && v.trim() ? v.trim() : undefined;
  }

  /** localStorage key for the DEVICE-scoped global cover. Deliberately not in
   *  data.json: that file syncs, which is the very thing "device only" means to
   *  avoid. */
  private static readonly OBSCURE_ALL_LOCAL = "stashpad:obscure-all";

  /** Is the global cover on, for THIS device?
   *
   *  0.267.8: reads whichever store the scope names. When the scope is "device"
   *  and this device has never set it, it falls back to the synced value rather
   *  than to false — so switching to device scope while everything is covered
   *  cannot silently UNCOVER it. A privacy control must never fail open. */
  getObscureAll(): boolean {
    const raw = window.localStorage.getItem(StashpadPlugin.OBSCURE_ALL_LOCAL);
    const local = raw === "1" ? true : raw === "0" ? false : null;
    return resolveObscureAll(
      this.settings.obscureAllScope === "synced" ? "synced" : "device",
      this.settings.obscureAll === true,
      local,
    );
  }

  /** Set the global cover in whichever store the scope names, then re-cover
   *  every view (which also drops any note you had peeked at). */
  async setObscureAll(on: boolean): Promise<void> {
    if (this.settings.obscureAllScope === "synced") {
      this.settings.obscureAll = on;
      await this.saveSettings();
    } else {
      window.localStorage.setItem(StashpadPlugin.OBSCURE_ALL_LOCAL, on ? "1" : "0");
    }
    this.reHideAndRefreshAllViews();
  }

  /** 0.267.0: does this folder obscure its notes by default?
   *
   *  THREE-VALUED, like the per-note flag and for the same reason. `true` and
   *  `false` are both explicit answers that beat the global switch; removing
   *  the key means "no opinion", which follows it. Storing `false` as absence
   *  would make "don't obscure this folder" silently stop working the moment
   *  the global switch went on — which is exactly when someone would be
   *  relying on it.
   *
   *  Pass null to clear. */
  async setFolderObscured(folder: string, on: boolean | null): Promise<void> {
    const key = (folder || "").replace(/\/+$/, "");
    if (!key) return;
    this.settings.obscureFolders = { ...(this.settings.obscureFolders ?? {}) };
    if (on === null) delete this.settings.obscureFolders[key];
    else this.settings.obscureFolders[key] = on;
    await this.saveSettings();
    this.reHideAndRefreshAllViews();
  }

  /** 0.118.0: persist a folder's icon (empty/undefined clears it), then refresh
   *  every open Stashpad tab showing that folder + the folder panels so the new
   *  icon appears immediately. */
  async setFolderIcon(folder: string, icon: string | undefined): Promise<void> {
    const key = (folder || "").replace(/\/+$/, "");
    const map = { ...(this.settings.folderIcons ?? {}) };
    if (icon && icon.trim()) map[key] = icon.trim(); else delete map[key];
    this.settings.folderIcons = map;
    await this.saveSettings();
    this.refreshFolderIconFor(key);
  }

  /** Re-read the tab header (icon + title) for every Stashpad view pinned to
   *  `folder`, and refresh the folder panels. 0.118.0. */
  refreshFolderIconFor(folder: string): void {
    const key = (folder || "").replace(/\/+$/, "");
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const v = leaf.view as any;
      if (v && (v.noteFolder || "").replace(/\/+$/, "") === key) {
        try { (leaf as any).updateHeader?.(); } catch { /* ignore */ }
        try { v.refreshFolderSwitcherIcon?.(); } catch { /* ignore */ }
      }
    }
    this.refreshFolderPanels();
  }

  /** Unified folder picker / switcher / creator — the single entry
   *  point for the ribbon button, the view's switch-folder button, and
   *  the `pickFolder` keybinding / command-palette entry. 0.65.0.
   *
   *  Items (built dynamically based on context + query):
   *  - Reveal an existing Stashpad tab (icon: layout-grid).
   *  - Open a Stashpad folder in a new tab (icon: layout-template).
   *  - When the user is on a Stashpad tab AND types a query matching a
   *    DIFFERENT existing folder: "Switch this tab to <folder>"
   *    (icon: folder-input). When the user is NOT on a Stashpad tab,
   *    this entry is hidden — "open in new tab" carries the load
   *    instead, so we don't accidentally repurpose someone's random
   *    Stashpad tab.
   *  - When the typed value doesn't match any existing folder + isn't
   *    reserved: "Create new Stashpad" (icon: folder-plus). Creates
   *    the folder; if the user's on a Stashpad tab, switches that tab
   *    to the new folder; otherwise opens it in a fresh tab. */
  openFolderPicker(): void {
    type Item =
      | { kind: "reveal"; folder: string; label: string; leaf: WorkspaceLeaf; icon: string }
      | { kind: "open"; folder: string; label: string; icon: string }
      | { kind: "open-anyway"; folder: string; label: string; icon: string }
      | { kind: "switch-current"; folder: string; label: string; icon: string }
      | { kind: "create"; folder: string; label: string; icon: string }
      | { kind: "convert"; folder: string; label: string; icon: string }
      | { kind: "pinned"; folder: string; label: string; icon: string; file: TFile }
      | { kind: "trash"; label: string; icon: string };

    const folderForLeaf = (leaf: WorkspaceLeaf): string => {
      const state = leaf.getViewState();
      const fOverride = (state.state as any)?.folderOverride;
      if (typeof fOverride === "string" && fOverride.trim()) {
        return fOverride.trim().replace(/^\/+|\/+$/g, "");
      }
      return (this.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "");
    };

    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    // 0.208.2: rank the folder you were last in FIRST. Discovery returns
    // alphabetical order, which is stable but means the folder you actually
    // work in sits wherever its name happens to fall. Only the ordering
    // changes — every folder is still listed, and typing still filters.
    const lastUsed = (this.settings.lastUsedFolder || "").trim();
    const stashpadFolders = this.rankFoldersByPin(
      this.discoverStashpadFolders()
        .slice()
        .sort((a, b) => (a === lastUsed ? -1 : b === lastUsed ? 1 : 0)),
    );
    const activeView = getActiveView();
    const activeFolder = activeView ? ((activeView).noteFolder ?? "").trim().replace(/^\/+|\/+$/g, "") : "";

    // Collect every folder path in the vault (for the create guard:
    // don't offer "Create" if the path already exists as a vanilla
    // folder).
    const allVaultFolderPaths = new Set<string>();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if ((f as any).children) {
        const path = (f as any).path as string;
        if (path && path !== "/" && !path.startsWith(".")) {
          allVaultFolderPaths.add(path);
        }
      }
    }
    const isReservedFolder = (p: string): boolean => {
      const last = p.split("/").filter(Boolean).pop() ?? "";
      if (!last) return false;
      const reserved = new Set(
        [this.settings.importDropFolder, this.settings.exportFolder, "_attachments", "_processed", "_failed-imports", "_authors", "_exports", "_imports", "_archive", ".archive", "_deleted"]
          .map((s) => (s ?? "").trim().replace(/^\/+|\/+$/g, ""))
          .filter(Boolean),
      );
      return reserved.has(last);
    };

    const seenOpen = new Set<string>();
    const baseItems: Item[] = [];
    // 0.65.1: for each open Stashpad folder we ALSO emit an
    // "Open <folder> in new tab anyway" entry — kept separate from
    // baseItems and appended at the very end of the suggestion list so
    // it doesn't compete with the reveal-existing-tab default. Useful
    // when the user actually wants a second tab on the same folder
    // (e.g., for tiny mode + main side by side).
    const openAnywayItems: Item[] = [];
    // 0.71.21: dedupe by folder. When two tabs are open on the same
    // folder the picker used to emit two identical "Reveal X" rows
    // (and two "Open X anyway" rows). Now we emit one row per
    // distinct folder; the leaf picked for reveal is the first tab
    // encountered (workspace order).
    const seenLeafFolders = new Set<string>();
    for (const leaf of leaves) {
      const folder = folderForLeaf(leaf);
      if (seenLeafFolders.has(folder)) continue;
      seenLeafFolders.add(folder);
      seenOpen.add(folder);
      const label = folder.split("/").pop() || folder;
      // 0.174.0: "Folders always open in a new tab" drops the reveal-existing-tab
      // option — the folder just gets a plain "open in new tab" entry like any other.
      if (this.settings.foldersAlwaysNewTab) {
        baseItems.push({ kind: "open", folder, label: `Open "${label}" in new tab`, icon: this.isArchiveFolder(folder) ? "archive" : "layout-template" });
        continue;
      }
      // 0.98.37: archive folders carry the archive icon so they read at a glance.
      baseItems.push({ kind: "reveal", folder, label: `Reveal "${label}" tab`, leaf, icon: this.isArchiveFolder(folder) ? "archive" : "layout-grid" });
      openAnywayItems.push({ kind: "open-anyway", folder, label: `Open "${label}" in another new tab`, icon: "layout-template" });
    }
    for (const folder of stashpadFolders.filter((f) => !seenOpen.has(f))) {
      const label = folder.split("/").pop() || folder;
      baseItems.push({ kind: "open", folder, label: `Open "${label}" in new tab`, icon: this.isArchiveFolder(folder) ? "archive" : "layout-template" });
    }

    // 0.208.2: float EVERY entry for the last-used folder to the top. Sorting the
    // discovered-folder list alone wasn't enough: folders with an open tab enter
    // the list as "reveal" items built from workspace order, so a last-used
    // folder that happened to be open still sank below an alphabetically-earlier
    // one. Sorting here catches both kinds. Array.prototype.sort is stable, so
    // the relative order of everything else is untouched.
    //
    // 0.224.0: pinned folders now outrank last-used. Three tiers, so both rules
    // survive: pinned (in folders-panel order) → the last-used folder → the
    // rest. Pinning is an explicit, durable statement about what matters;
    // last-used is incidental, so it sorts below but still above plain
    // alphabetical.
    baseItems.sort((a, b) => {
      const rank = (x: { folder?: string }): [number, number] => {
        const f = x.folder ?? "";
        const pin = f ? this.folderPinRank(f) : null;
        if (pin !== null) return [0, pin];
        if (lastUsed && f === lastUsed) return [1, 0];
        return [2, 0];
      };
      const ra = rank(a as { folder?: string }), rb = rank(b as { folder?: string });
      return ra[0] - rb[0] || ra[1] - rb[1];
    });

    // 0.118.3: optionally surface pinned notes so the switcher can jump
    // straight to one. Title from the filename (sync), same as the folder panel.
    const titleFromFile = (f: TFile): string =>
      f.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim() || f.basename;
    const pinnedItems: Item[] = this.settings.folderSwitcherIncludePinned
      ? this.listPinnedNotes().map((p) => ({
          kind: "pinned" as const,
          folder: p.folder,
          file: p.file,
          label: titleFromFile(p.file),
          icon: "pin",
        }))
      : [];

    const plugin = this;
    const modal = new (class extends SuggestModal<Item> {
      getSuggestions(query: string): Item[] {
        const q = query.trim().toLowerCase();
        const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
        const matchesAll = (s: string) => {
          if (!tokens.length) return true;
          const h = s.toLowerCase();
          for (const t of tokens) if (!h.includes(t)) return false;
          return true;
        };
        const filtered = !q ? baseItems.slice() : baseItems.filter((it) => {
          const f = "folder" in it ? (it as any).folder : "";
          return matchesAll(it.label) || matchesAll(f);
        });
        // Switch-current items: only when there's an active Stashpad
        // view and the query matches a stashpad folder that isn't its
        // current one. The user said: if not on a Stashpad tab, don't
        // surface this — "open in new tab" is the safe fallback.
        if (q && activeView && activeFolder) {
          for (const folder of stashpadFolders) {
            if (folder.toLowerCase() === activeFolder.toLowerCase()) continue;
            const last = folder.split("/").pop() ?? folder;
            const haystack = `${folder} ${last}`;
            if (!matchesAll(haystack)) continue;
            filtered.push({
              kind: "switch-current",
              folder,
              label: `Switch this tab to "${last}"`,
              icon: "folder-input",
            });
          }
        }
        // 0.118.3: pinned-note jump targets (when enabled). Matched on title
        // or folder; placed after the folder actions, before the create offer.
        for (const it of pinnedItems) {
          if (matchesAll(it.label) || matchesAll("folder" in it ? it.folder : "")) filtered.push(it);
        }
        // Create / convert offer. Query is non-empty AND isn't reserved.
        //  - If the folder doesn't exist anywhere in the vault →
        //    "Create new Stashpad" (creates folder + opens new tab).
        //  - If it exists as a vault folder but isn't a Stashpad folder
        //    yet → "Convert <folder> into a Stashpad" (opens new tab
        //    which bootstraps a Home note inside; non-destructive).
        //  - If it's already a Stashpad folder, neither offer fires —
        //    the existing reveal/open entries handle it.
        const cleaned = query.trim().replace(/^\/+|\/+$/g, "");
        if (cleaned && !isReservedFolder(cleaned)) {
          const existsLower = Array.from(allVaultFolderPaths).find((f) => f.toLowerCase() === cleaned.toLowerCase());
          const isStashpad = stashpadFolders.some((f) => f.toLowerCase() === cleaned.toLowerCase());
          if (existsLower && !isStashpad) {
            filtered.push({
              kind: "convert",
              folder: existsLower,
              label: `Convert “${properCaseFolderPath(existsLower)}” into a Stashpad…`,
              icon: "folder-cog",
            });
          } else if (!existsLower) {
            const cased = properCaseFolderPath(cleaned);
            filtered.push({
              kind: "create",
              folder: cleaned,
              label: `+ Create new Stashpad “${cased}”`,
              icon: "folder-plus",
            });
          }
        }
        // 0.65.1: open-anyway entries pinned to the very bottom — one
        // per currently-open folder, in case the user wants a second
        // tab on the same folder (e.g., main + tiny side by side).
        const openAnywayFiltered = openAnywayItems.filter((it) => matchesAll(it.label) || matchesAll("folder" in it ? it.folder : ""));
        filtered.push(...openAnywayFiltered);
        // Trash entry, pinned to the very bottom. Unified trash (plaintext +
        // encrypted) — shown regardless of encryption setup. Matches on
        // "trash"/"deleted"/"encrypted".
        if (matchesAll("trash deleted encrypted")) {
          filtered.push({ kind: "trash", label: "Open Trash", icon: "trash-2" });
        }
        return filtered;
      }
      renderSuggestion(item: Item, el: HTMLElement): void {
        el.addClass("stashpad-suggest-item");
        el.addClass("stashpad-ribbon-suggest-item");
        if (item.kind === "create") el.addClass("stashpad-suggest-create");
        const iconEl = el.createSpan({ cls: "stashpad-ribbon-suggest-icon" });
        setIcon(iconEl, item.icon);
        const body = el.createDiv({ cls: "stashpad-ribbon-suggest-body" });
        body.createDiv({ cls: "stashpad-suggest-title", text: item.label });
        if ("folder" in item && item.folder && item.label !== item.folder) {
          body.createDiv({ cls: "stashpad-suggest-preview", text: item.folder });
        }
      }
      async onChooseSuggestion(item: Item): Promise<void> {
        if (item.kind === "trash") { plugin.openEncryptedTrash(); return; }
        if (item.kind === "pinned") { await plugin.revealNoteInStashpad(item.file); return; }
        if (item.kind === "reveal") {
          plugin.app.workspace.revealLeaf(item.leaf);
          return;
        }
        if (item.kind === "open" || item.kind === "open-anyway") {
          await plugin.activateViewForFolder(item.folder);
          return;
        }
        if (item.kind === "switch-current") {
          // Caller already checked activeView exists when emitting.
          const v = activeView;
          if (v && typeof v.setFolderOverride === "function") {
            await v.setFolderOverride(item.folder);
            plugin.app.workspace.revealLeaf(v.leaf);
          }
          return;
        }
        if (item.kind === "create") {
          // 0.65.2: ALWAYS open a new tab for fresh Stashpad folders —
          // never replace the active tab. Predictable, doesn't strand
          // whatever the user was looking at.
          try {
            const properCased = properCaseFolderPath(item.folder);
            if (!(await plugin.app.vault.adapter.exists(properCased))) {
              await plugin.app.vault.createFolder(properCased);
            }
            await plugin.activateViewForFolder(properCased);
          } catch (e) {
            new Notice(`Stashpad: couldn't create folder (${(e as Error).message})`);
          }
          return;
        }
        if (item.kind === "convert") {
          // 0.65.2: convert an EXISTING vault folder into a Stashpad.
          // bootstrapFolder adds the Home note + _imports / _exports
          // subfolders. 0.103.x: it now ALSO sweeps the folder's existing
          // loose files + subfolders into notes (the "import loose files &
          // folders" command) on confirm, so convert + import are one step
          // instead of two disjoint features.
          const { ConfirmModal } = await import("./modals");
          const folder = item.folder;
          const lines = [
            `“${folder}” already exists as a regular vault folder.`,
            `Converting adds a Home note + _imports / _exports subfolders, and imports the existing loose files and subfolders inside it as notes.`,
            `(Files already structured as notes, and reserved subfolders, are left alone.)`,
          ];
          new ConfirmModal(
            plugin.app,
            "Convert into a Stashpad?",
            lines.join("\n"),
            "Convert & import",
            async (ok: boolean) => {
              if (!ok) return;
              try {
                await plugin.activateViewForFolder(folder);
                // Reconcile with the loose-file importer: sweep existing
                // top-level files / subfolders / .stash into notes now.
                await plugin.runImportLooseFiles(folder);
              } catch (e) {
                new Notice(`Stashpad: couldn't convert folder (${(e as Error).message})`);
              }
            },
          ).open();
          return;
        }
      }
    })(this.app);
    modal.setPlaceholder(
      activeView
        ? "Open, switch this tab, or create a Stashpad folder — type to filter…"
        : "Open or create a Stashpad folder — type to filter…"
    );
    modal.open();
  }

  /** Open a popout Obsidian window with a Stashpad view in tiny mode.
   *  Carries over the currently-active view's folder/focus if there is
   *  one — so "Open tiny window" from a folder you're working in keeps
   *  you in that folder. 0.61.1. */
  async openTinyWindow(): Promise<void> {
    const active = getActiveView();
    const folderOverride = (active)?.folderOverride ?? null;
    const focusId = (active)?.focusId ?? "__root__";
    // 0.61.8: carry over compactMode from the active tab so the tiny
    // window inherits the user's chrome preference. The exit-compact
    // button in the tiny header then has something to toggle.
    const compactMode = !!(active)?.compactMode;
    const popLeaf = (this.app.workspace as any).openPopoutLeaf?.();
    if (!popLeaf) {
      new Notice("Stashpad: couldn't open popout window on this build.");
      return;
    }
    await popLeaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: {
        folderOverride,
        focusId,
        tinyMode: true,
        tinyAlwaysOnTop: false,
        compactMode,
      } as any,
    });
    // The view's onOpen path will detect tinyMode and apply the window
    // shrink + always-on-top. Reveal to be safe.
    try { this.app.workspace.revealLeaf(popLeaf); } catch { /* ignore */ }
  }

  async activateView(opts: { reveal: boolean } = { reveal: true }): Promise<void> {
    const { workspace } = this.app;
    if (opts.reveal) {
      const existing = workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: STASHPAD_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /** 0.95.3: snap focus to the Stashpad tab you were last working in — the
   *  layout-independent way to get OUT of a side panel and back to your notes.
   *  Prefers the tracked last-active leaf; falls back to any open Stashpad tab,
   *  then to opening/revealing the default Stashpad. */
  async focusLastStashpadTab(): Promise<void> {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(STASHPAD_VIEW_TYPE);
    let leaf = this.lastActiveStashpadLeaf && leaves.includes(this.lastActiveStashpadLeaf)
      ? this.lastActiveStashpadLeaf
      : leaves[0] ?? null;
    if (!leaf) { await this.activateView({ reveal: true }); return; }
    ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
  }

  /** 0.95.3: reveal + focus the folder panel (opening it if needed). The
   *  return-trip companion to focusLastStashpadTab. */
  async focusFolderPanel(): Promise<void> {
    await openFolderPanelView(this.app);
    const leaf = this.app.workspace.getLeavesOfType(STASHPAD_FOLDER_PANEL_VIEW_TYPE)[0];
    if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** 0.98.0 (Phase 2): lock a note subtree into one `.stashenc` bundle. Requires
   *  encryption set up + unlocked (prompts via Notice otherwise). Returns the
   *  lock result, or null if not unlocked / it failed. */
  /** 0.98.7: rebuild the in-memory locked-subtree registry from the `.stashmeta`
   *  sidecars on disk. The registry (settings) is a sync cache for rendering; the
   *  sidecars are the durable source of truth. This recovers placeholder metadata
   *  (parent/title/order) when the settings registry is lost (desync) or when a
   *  blob was synced in from another device with no local registry entry. Adds an
   *  entry for any `.stashenc` missing one; drops entries whose blob is gone. */
  async reconcileLockedRegistry(): Promise<void> {
    const orig = this.settings.lockedSubtrees ?? [];
    // DROP entries via the ADAPTER (disk truth), NOT vault.getFiles() — the vault
    // index lags on startup, and filtering against it once wiped the whole
    // registry when this ran before indexing finished (encrypted notes vanished
    // on restart). adapter.exists reads disk directly, so it's accurate even
    // mid-startup. (Unlock already removes its own entry, so a surviving entry
    // whose blob is genuinely gone is the rare external-deletion case.)
    let reg: typeof orig = [];
    for (const e of orig) {
      const ef = (e.folder ?? "").replace(/\/+$/, "");
      if (ef === "_deleted" || ef.startsWith("_deleted/")) continue; // encrypted-trash blobs aren't locked placeholders
      try { if (await this.app.vault.adapter.exists(e.blob)) reg.push(e); }
      catch { reg.push(e); } // unknown → keep (never wipe on an I/O hiccup)
    }
    let changed = reg.length !== orig.length;
    const have = new Set(reg.map((e) => e.blob));
    // ADD entries for `.stashenc` blobs with no registry entry (synced from
    // another device). Skip the `_deleted/` encrypted-trash store.
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "stashenc" || have.has(f.path)) continue;
      const folder = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (folder === "_deleted" || folder.startsWith("_deleted/")) continue;
      const m = await readLockedMeta(this.app, f.path);
      if (!m) continue; // no sidecar → the scan still shows it at root (never stranded)
      reg.push({ folder, blob: f.path, parentId: m.parentId, title: m.title, count: m.count, created: m.created, rootId: m.rootId, prevSibling: m.prevSibling });
      changed = true;
    }
    if (changed) {
      this.settings.lockedSubtrees = reg;
      await this.saveSettings();
      this.refreshAllStashpadViews?.(); // repaint placeholders that were added/dropped
    }
  }

  /** Locked-subtree placeholders attached under `parentId` in `folder` (for the
   *  list to render 🔒 stubs where the notes were). SCANS the `.stashenc` files
   *  on disk (the source of truth — survives a desynced registry or a blob synced
   *  from another device); the `lockedSubtrees` registry only ENRICHES with the
   *  parent/title/count. A blob with no registry entry shows under the folder root
   *  with its filename as the title, so it's never stranded/unreachable. */
  lockedSubtreesFor(folder: string, parentId: StashpadId): Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null }> {
    const cleaned = folder.replace(/\/+$/, "");
    const out: Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null; prevSibling?: StashpadId | null }> = [];
    const seen = new Set<string>();
    // REGISTRY FIRST — the registry (settings) loads synchronously at startup, so
    // locked placeholders render immediately on app restart, BEFORE the vault
    // finishes indexing the `.stashenc` blobs (vault.getFiles() lags there, which
    // is what made encrypted notes "disappear" on restart until 0.99.14).
    for (const e of this.settings.lockedSubtrees ?? []) {
      if ((e.folder ?? "").replace(/\/+$/, "") !== cleaned) continue;
      if ((e.parentId ?? ROOT_ID) !== parentId) continue;
      out.push({ blob: e.blob, title: e.title ?? "", count: e.count ?? 0, created: e.created ?? "", rootId: e.rootId, parentId: e.parentId ?? ROOT_ID, prevSibling: e.prevSibling ?? null });
      seen.add(e.blob);
    }
    // Then any `.stashenc` blob on disk with NO registry entry (e.g. synced in
    // from another device) — shown at ROOT with the filename as title so it's
    // never stranded. Skips the `_deleted/` encrypted-trash store.
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "stashenc") continue;
      if (seen.has(f.path)) continue;
      const fdir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (fdir !== cleaned || fdir === "_deleted" || fdir.startsWith("_deleted/")) continue;
      if (parentId !== ROOT_ID) continue; // unregistered → attach at root only
      out.push({ blob: f.path, title: f.basename, count: 0, created: "", rootId: undefined, parentId: ROOT_ID, prevSibling: null });
    }
    return out;
  }

  /** 0.124.0: ALL locked-subtree stubs in `folder` (every parent), for search.
   *  Same registry-first + on-disk-fallback sources as lockedSubtreesFor, just
   *  not filtered by parentId — so encrypted notes are findable in search even
   *  though they aren't tree nodes. */
  lockedSubtreesInFolder(folder: string): Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null }> {
    const cleaned = folder.replace(/\/+$/, "");
    const out: Array<{ blob: string; title: string; count: number; created: string; rootId?: StashpadId; parentId?: StashpadId | null }> = [];
    const seen = new Set<string>();
    for (const e of this.settings.lockedSubtrees ?? []) {
      if ((e.folder ?? "").replace(/\/+$/, "") !== cleaned) continue;
      out.push({ blob: e.blob, title: e.title ?? "", count: e.count ?? 0, created: e.created ?? "", rootId: e.rootId, parentId: e.parentId ?? ROOT_ID });
      seen.add(e.blob);
    }
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "stashenc") continue;
      if (seen.has(f.path)) continue;
      const fdir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (fdir !== cleaned || fdir === "_deleted" || fdir.startsWith("_deleted/")) continue;
      out.push({ blob: f.path, title: f.basename, count: 0, created: "", rootId: undefined, parentId: ROOT_ID });
    }
    return out;
  }

  /** Ensure the key for `folder` is unlocked, prompting for the folder password if
   *  needed, and return the DEK to use. (0.143.0: strictly per-folder — a folder
   *  with no key of its own (or an inherited one) is not encrypted, so this returns
   *  null and tells the user to give it a password.) Caller may zero the DEK. */
  async ensureFolderUnlocked(folder: string): Promise<Uint8Array | null> {
    if (!this.encryption.hasFolderKey(folder)) {
      new Notice("This folder isn't encrypted. Give it a password in Settings → Stashpad → Encryption → Per-Folder Passwords.");
      return null;
    }
    if (this.encryption.isFolderUnlocked(folder)) return this.encryption.getFolderKey(folder);
    if (await this.encryption.tryAutoUnlockFolder(folder)) return this.encryption.getFolderKey(folder);
    const name = folder.split("/").pop() || folder;
    const ok = await new Promise<boolean>((resolve) => {
      new EncryptionPasswordModal(this.app, {
        mode: "unlock", offerKeychain: true,
        title: `Unlock “${name}”`,
        intro: "Enter this folder's password.",
        onSubmit: async ({ current, remember }) => {
          const okPw = await this.encryption.unlockFolder(folder, current!, remember);
          if (!okPw) return "Wrong password. Try again.";
          resolve(true);
          return null;
        },
        onCancel: () => resolve(false),
      }).open();
    });
    return ok ? this.encryption.getFolderKey(folder) : null;
  }

  /** 0.112.0: FAST encryption-state check — replaces a full recursive adapter
   *  walk that made "Remove encryption" take minutes on big vaults. Reads
   *  Obsidian's in-memory file index (instant) plus this session's
   *  `pendingEncBlobs` (adapter writes not yet indexed). Splits LIVE locked
   *  content (notes/folders — irrecoverable if the key is erased) from TRASH
   *  (`_deleted/` — recoverable until the key goes). Short-circuits as soon as it
   *  knows both.
   *
   *  0.112.2: empirically verified (Claude Dev Vault, pendingEncBlobs empty)
   *  that `vault.getFiles()` DOES return `_deleted/*.stashenc` — it's a normal,
   *  fully-indexed folder — so trash detection here is reliable across sessions,
   *  NOT dependent on `pendingEncBlobs`. The only location `getFiles()` misses is
   *  the `.trash/` DOT-folder; for any IRREVERSIBLE decision use
   *  `encryptionStateStrict()`, which adapter-confirms `_deleted/` + `.trash/`. */
  /** 0.140.1: is a `.stashenc` blob in a TRASH store (recoverable), not live
   *  locked content? Covers the legacy vault-level `_deleted/` AND every
   *  per-folder `<folder>/trash/` (0.137.0). CRITICAL for Remove-encryption:
   *  before this, per-folder trash blobs were misclassified as live-locked and
   *  could be irreversibly purged / restored into the reserved dir. */
  isTrashBlobPath(p: string): boolean {
    const dir = p.replace(/\/[^/]*$/, "").replace(/\/+$/, "");
    return dir === "_deleted" || dir.startsWith("_deleted/") || dir === "trash" || dir.endsWith("/trash");
  }

  encryptionState(): { live: boolean; trash: boolean } {
    const isTrash = (p: string): boolean => this.isTrashBlobPath(p);
    let live = false, trash = false;
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== "stashenc") continue;
      if (isTrash(f.path)) trash = true; else live = true;
      if (live && trash) return { live, trash };
    }
    for (const p of this.pendingEncBlobs) {
      if (isTrash(p)) trash = true; else live = true;
      if (live && trash) break;
    }
    return { live, trash };
  }

  /** Authoritative-but-cheap variant for the IRREVERSIBLE "Remove encryption"
   *  moment. Starts from the fast in-memory check, then confirms TRASH via two
   *  adapter folder listings: `_deleted/` (covers an index lag) and Obsidian's
   *  vault-local trash `.trash/` — a DOT-folder that `vault.getFiles()` never
   *  returns, so a `.stashenc` the user trashed there would otherwise be erased
   *  silently. Two listings, not a full vault walk. Live blobs only ever live in
   *  normal (indexed) Stashpad folders, so live detection stays on the fast path. */
  async encryptionStateStrict(): Promise<{ live: boolean; trash: boolean }> {
    const s = this.encryptionState();
    let trash = s.trash;
    if (!trash) {
      try { trash = (await listDeletedBlobs(this.app, this.trashSubfolderDirs())).length > 0; } catch { /* ignore */ }
    }
    if (!trash) {
      try {
        const t = await this.app.vault.adapter.list(OBSIDIAN_TRASH_DIR);
        trash = t.files.some((f) => f.endsWith(".stashenc"));
      } catch { /* no .trash dir — fine */ }
    }
    return { live: s.live, trash };
  }

  // ---- 0.138.0: re-encrypt watchlist (smart sweep) ----
  // A subtree that WAS encrypted and got unlocked to plaintext goes on the
  // watchlist; locking it again (any path — manual, sweep, folder batch, which
  // all funnel through lockNoteSubtree) takes it off. MUTATES settings only;
  // callers are responsible for the saveSettings they already perform.

  /** Upsert a watch entry (a fresh unlock reactivates a dismissed entry). */
  watchReEncrypt(e: { folder: string; rootId: StashpadId; title: string; count: number; via: "unlock" | "restore" }): void {
    const folder = e.folder.replace(/\/+$/, "");
    const rest = (this.settings.reEncryptWatch ?? []).filter((w) => !(w.folder === folder && w.rootId === e.rootId));
    this.settings.reEncryptWatch = [...rest, { folder, rootId: e.rootId, title: e.title, count: e.count, via: e.via, unlockedAt: new Date().toISOString() }];
  }

  /** Display title for a re-encrypt watch entry (or any {folder, rootId, title?}).
   *  The stored `title` was captured at LOCK time and is BLANK for a hide-filename
   *  note — but the note is PLAINTEXT now, so resolve its real title from the live
   *  file (H1 → de-slugged filename). Falls back to the stored title, then
   *  "(untitled)". Sync (metadata cache only) so row renderers can call it.
   *  (0.143.0: fixes "(untitled)" showing for unlocked hide-title notes in the
   *  re-encrypt review modal + the "previously encrypted" view.) */
  reEncryptDisplayTitle(w: { folder: string; rootId?: StashpadId; title?: string }): string {
    if (w.title && w.title.trim()) return w.title.trim();
    if (w.rootId) {
      const clean = w.folder.replace(/\/+$/, "");
      const file = this.app.vault.getMarkdownFiles().find((f) =>
        (f.parent?.path?.replace(/\/+$/, "") ?? "") === clean && parseIdFromFilename(f.name) === w.rootId);
      if (file) {
        const h1 = this.app.metadataCache.getFileCache(file)?.headings?.find((h) => h.level === 1)?.heading;
        if (h1 && h1.trim()) return h1.trim();
        const base = file.basename.replace(new RegExp(`[-_]+${w.rootId}$`), "").replace(/[-_]+/g, " ").trim();
        if (base) return base;
      }
    }
    return "(untitled)";
  }

  /** Drop entries for subtrees that just got locked (or securely deleted). */
  unwatchReEncrypt(folder: string, rootId: StashpadId): void {
    const cleaned = folder.replace(/\/+$/, "");
    const before = this.settings.reEncryptWatch ?? [];
    const after = before.filter((w) => !(w.folder === cleaned && w.rootId === rootId));
    if (after.length !== before.length) this.settings.reEncryptWatch = after;
  }

  /** Active (non-dismissed) watch entries. */
  reEncryptWatching(): import("./settings").ReEncryptWatchEntry[] {
    return (this.settings.reEncryptWatch ?? []).filter((w) => !w.removed);
  }

  /** 0.138.0: drop watch entries whose rootId is no longer a live PLAINTEXT
   *  note in its folder — it was deleted, moved, or re-locked by some path that
   *  didn't clear it. Keeps ghost rows out of the view + sweep. Returns true if
   *  it changed anything (caller saves). Cheap: metadataCache id scan per entry. */
  pruneReEncryptWatch(): boolean {
    const entries = this.settings.reEncryptWatch ?? [];
    if (entries.length === 0) return false;
    const livePlainInFolder = (folder: string): Set<string> => {
      const set = new Set<string>();
      for (const f of this.app.vault.getMarkdownFiles()) {
        if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== folder) continue;
        const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
        if (typeof id === "string") set.add(id);
      }
      return set;
    };
    const byFolder = new Map<string, Set<string>>();
    const kept = entries.filter((w) => {
      const folder = w.folder.replace(/\/+$/, "");
      if (!byFolder.has(folder)) byFolder.set(folder, livePlainInFolder(folder));
      return byFolder.get(folder)!.has(w.rootId);
    });
    if (kept.length === entries.length) return false;
    this.settings.reEncryptWatch = kept;
    return true;
  }

  /** 0.138.0: the sweep — gather everything that SHOULD be encrypted but is
   *  currently plaintext (watchlist entries ∪ prefs-derived candidates), show
   *  ONE review modal (per-subtree rows, pre-ticked), and lock what's confirmed.
   *  Nothing encrypts without this explicit confirmation. */
  async encryptEverythingApplicable(): Promise<void> {
    if (this.pruneReEncryptWatch()) await this.saveSettings(); // no ghosts in the sweep
    type Cand = { label: string; detail: string; run: () => Promise<boolean> };
    const cands: Cand[] = [];
    // (a) watchlist: previously-encrypted subtrees now plaintext.
    for (const w of this.reEncryptWatching()) {
      cands.push({
        label: this.reEncryptDisplayTitle(w),
        detail: `${w.folder} — ${w.via === "restore" ? "restored from trash" : "unlocked"} (was encrypted)`,
        run: async () => !!(await this.lockNoteSubtree(w.folder, w.rootId, null, { silent: true })),
      });
    }
    // (b) folders set to encrypt their notes that still hold plaintext notes.
    const lockedRoots = new Set((this.settings.lockedSubtrees ?? []).map((e) => e.rootId));
    for (const [folder, p] of Object.entries(this.settings.folderEncPrefs ?? {})) {
      if (!p?.encryptContent) continue;
      const plain = this.app.vault.getMarkdownFiles().filter((f) => {
        if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== folder) return false;
        const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
        return typeof id === "string" && id !== ROOT_ID && !lockedRoots.has(id);
      }).length;
      if (plain > 0) cands.push({
        label: `Everything in “${folder.split("/").pop() || folder}” (${plain} plaintext note${plain === 1 ? "" : "s"})`,
        detail: `${folder} — the folder is set to encrypt its notes`,
        run: async () => { await this.lockFolder(folder); return true; },
      });
    }
    // (c) folders that encrypt their archive but have plain archived notes.
    for (const [folder, p] of Object.entries(this.settings.folderEncPrefs ?? {})) {
      if (!p?.archiveEncryptContent) continue;
      const n = this.archivedPlainNotesIn(archiveSubfolderOf(folder)).length;
      if (n > 0) cands.push({
        label: `${n} archived note${n === 1 ? "" : "s"} in “${folder.split("/").pop() || folder}/archive”`,
        detail: `${folder} — the folder encrypts its archive`,
        run: async () => { await this.encryptExistingArchiveNotes(folder); return true; },
      });
    }
    if (cands.length === 0) { new Notice("Nothing needs re-encrypting — everything applicable is already locked."); return; }
    new ReEncryptReviewModal(this.app, cands.map(({ label, detail }) => ({ label, detail })), async (chosen) => {
      let ok = 0, failed = 0;
      const prog = chosen.length > 2 ? new Notice("", 0) : null;
      for (let i = 0; i < chosen.length; i++) {
        prog?.setMessage(`🔒 Re-encrypting ${i + 1}/${chosen.length}…`);
        try { (await cands[chosen[i]].run()) ? ok++ : failed++; }
        catch (e) { failed++; console.warn("[Stashpad] sweep item failed", cands[chosen[i]].label, e); }
      }
      prog?.hide();
      this.notifications.show({ message: `Re-encrypt sweep: ${ok} done${failed ? `, ${failed} FAILED (see console)` : ""}, ${cands.length - chosen.length} skipped.`, kind: failed ? "warning" : "success", category: "system", folder: "" });
    }).open();
  }

  async lockNoteSubtree(folder: string, rootId: StashpadId, prevSibling: StashpadId | null = null, opts: { silent?: boolean; blobFolder?: string; hideTitle?: boolean } = {}): Promise<LockResult | null> {
    // Encrypt under the key of the folder the BLOB will live in (archive moves put
    // the blob in opts.blobFolder, not the source folder), so opening that folder
    // later decrypts it. Falls back to the vault DEK when the folder has no own key.
    const keyFolder = (opts.blobFolder ?? folder).replace(/\/+$/, "");
    const dek = await this.ensureFolderUnlocked(keyFolder);
    if (!dek) return null;
    try {
      // Per-folder overhaul: filename-hiding follows the folder's prefs — its
      // archive filename pref when this is an archive lock (blob lives elsewhere),
      // else its live-notes pref — falling back to the global hide-titles setting.
      const isArchiveLock = !!opts.blobFolder && opts.blobFolder.replace(/\/+$/, "") !== folder.replace(/\/+$/, "");
      const fp = (this.settings.folderEncPrefs ?? {})[keyFolder] ?? {};
      // A per-note override (the "hide filename" command) wins over the folder pref.
      const hideTitle = opts.hideTitle ?? ((isArchiveLock ? fp.archiveEncryptFilenames : fp.encryptFilenames) ?? false); // 0.137.1: per-folder only
      // 0.211.6 (L1): drain queued parentLink/children writes BEFORE lockSubtree
      // baselines mtimes. FrontmatterSyncQueue writes 100ms apart in the background,
      // so one landing after the baseline makes the purge (correctly) keep the note
      // while the bundle has already been written — leaving plaintext and ciphertext
      // side by side, and a later restore producing a duplicate subtree.
      for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
        const v = leaf.view as { flushFrontmatterSync?: () => Promise<void> };
        if (typeof v.flushFrontmatterSync === "function") await v.flushFrontmatterSync();
      }
      const r = await lockSubtree(this.app, folder, rootId, dek, prevSibling, hideTitle, opts.blobFolder);
      this.pendingEncBlobs.add(r.blobPath); // fast-state index: cover the pre-vault-index window
      // 0.211.6 (L7): a hide-title lock removes the plaintext file, but a structure
      // snapshot written moments earlier still holds that note's title — and the
      // rotated .prev.json keeps it indefinitely and syncs it everywhere. Scrub the
      // titles of notes whose files are now gone, or filename-hiding is defeated by a
      // recovery sidecar sitting next to the blob.
      if (hideTitle) {
        try {
          // Drain first: a snapshot scheduled BEFORE the lock is still sitting in the
          // debounce holding the plaintext title, and would land after the scrub and
          // put it straight back.
          await this.structureStore.flush(folder);
          await this.structureStore.purgeTitlesForMissingNotes(folder);
        } catch (e) { console.warn("[Stashpad] snapshot title scrub failed", e); }
      }
      // Record a placeholder registry entry so the list shows a 🔒 stub where
      // the note was. The blob may live in a different folder than the note's
      // source (archive) — register it under the blob's actual folder.
      const blobFolder = (opts.blobFolder ?? folder).replace(/\/+$/, "");
      this.settings.lockedSubtrees = [
        ...(this.settings.lockedSubtrees ?? []).filter((e) => e.blob !== r.blobPath),
        { folder: blobFolder, blob: r.blobPath, parentId: r.parentId, title: r.title, count: r.noteCount, created: r.created, rootId: r.rootId, prevSibling },
      ];
      // 0.138.0: locked again → off the re-encrypt watchlist (source folder AND
      // blob folder — archive locks register under the destination).
      this.unwatchReEncrypt(folder, r.rootId);
      this.unwatchReEncrypt(blobFolder, r.rootId);
      await this.saveSettings();
      if (r.unpurged.length > 0) {
        // The blob is good but readable plaintext is STILL on disk (delete
        // failed, or the file was edited mid-lock). Never report a clean lock.
        new Notice(`⚠️ Locked, but ${r.unpurged.length} file${r.unpurged.length === 1 ? " is" : "s are"} still in plaintext (couldn't be removed or changed during the lock):\n${r.unpurged.join("\n")}`, 0);
      } else if (!opts.silent) {
        this.notifications.show({ message: `Locked ${r.title ? `“${r.title}”` : "a note"} (${r.noteCount} note${r.noteCount === 1 ? "" : "s"}).`, kind: "success", category: "system", folder });
      }
      return r;
    } catch (e) {
      console.warn("[Stashpad] lock failed", e);
      new Notice(`Couldn't lock: ${(e as Error).message}`);
      return null;
    }
  }

  /** 0.98.0 (Phase 2): unlock a `.stashenc` bundle back into its folder. */
  /** Decrypt ONE bundle into its folder and return the unlock result. Does NOT
   *  touch `lockedSubtrees` / settings — the caller updates them — so bulk callers
   *  can batch a single save instead of one `data.json` write per bundle. Throws
   *  on failure (caller decides how loud). */
  private async unlockBundleCore(blobPath: string, dek: Uint8Array, destFolder?: string): Promise<{ notesWritten: number; restoredTo: string }> {
    const folder = (destFolder ?? blobPath.replace(/\/[^/]*$/, "")).replace(/\/+$/, "");
    // Disk frontmatter, not metadataCache (lags after lock churn) — a stale
    // miss here re-pins an unlocked nested note to ROOT in importStashZip.
    const existing = new Set<StashpadId>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== folder) continue;
      try {
        const id = splitFrontmatter(await this.app.vault.read(f)).fm.id;
        if (typeof id === "string") existing.add(id);
      } catch { /* unreadable — skip */ }
    }
    return unlockBundle(this.app, blobPath, dek, existing, destFolder);
  }

  async unlockBundleAt(blobPath: string, opts: { silent?: boolean; destFolder?: string } = {}): Promise<boolean> {
    // The blob was encrypted under the key of the folder it RESIDES in (its
    // parent), regardless of where it unlocks TO (destFolder, for archive-undo).
    const residentFolder = blobPath.replace(/\/[^/]*$/, "").replace(/\/+$/, "");
    const dek = await this.ensureFolderUnlocked(residentFolder);
    if (!dek) return false;
    const folder = (opts.destFolder ?? blobPath.replace(/\/[^/]*$/, "")).replace(/\/+$/, "");
    try {
      const r = await this.unlockBundleCore(blobPath, dek, opts.destFolder);
      // Blob is removed via raw adapter (no vault 'delete' event) — prune the
      // fast-index pending entry directly so it can't falsely report "locked".
      this.pendingEncBlobs.delete(blobPath);
      // 0.138.0: this subtree WAS encrypted and is now plaintext → watchlist.
      // Grab its registry entry (rootId/title/count) before filtering it out.
      const wasLocked = (this.settings.lockedSubtrees ?? []).find((e) => e.blob === blobPath);
      if (wasLocked?.rootId) {
        this.watchReEncrypt({ folder, rootId: wasLocked.rootId, title: wasLocked.title ?? "", count: wasLocked.count ?? r.notesWritten, via: "unlock" });
      }
      this.settings.lockedSubtrees = (this.settings.lockedSubtrees ?? []).filter((e) => e.blob !== blobPath);
      await this.saveSettings();
      if (!opts.silent) this.notifications.show({ message: `Unlocked ${r.notesWritten} note${r.notesWritten === 1 ? "" : "s"}.`, kind: "success", category: "system", folder });
      return true;
    } catch (e) {
      console.warn("[Stashpad] unlock failed", e);
      new Notice(`Couldn't unlock: ${(e as Error).message}`);
      return false;
    }
  }

  /** 0.98.13 (Phase 3): lock every top-level note in a folder — each root note's
   *  subtree becomes its OWN `.stashenc` bundle (children ride along inside their
   *  root's bundle, so we only iterate root-level notes). Already-locked roots and
   *  the `__root__` Home note are skipped. Best-effort position preservation via the
   *  OrderStore. Returns how many bundles were created. */
  async lockFolder(folder: string): Promise<number> {
    const cleaned = folder.replace(/\/+$/, "");
    if (!(await this.ensureFolderUnlocked(cleaned))) return 0;
    // Enumerate root-level notes from disk (frontmatter), excluding the Home note.
    const roots: StashpadId[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      // Disk frontmatter, not metadataCache — a stale `parent` here reads a
      // child as a root, giving it its own bundle orphaned from its parent's.
      let fm: Record<string, unknown>;
      try { fm = splitFrontmatter(await this.app.vault.read(f)).fm; } catch { continue; }
      const id = fm.id;
      if (typeof id !== "string" || id === ROOT_ID) continue;
      const parent = typeof fm.parent === "string" ? fm.parent : ROOT_ID;
      if (parent !== ROOT_ID) continue; // children ride along inside their root's bundle
      roots.push(id);
    }
    const alreadyLocked = new Set((this.settings.lockedSubtrees ?? []).map((e) => e.rootId).filter((x): x is StashpadId => !!x));
    const todo = roots.filter((id) => !alreadyLocked.has(id));
    if (todo.length === 0) { new Notice("Nothing to lock in this folder."); return 0; }
    // Best-effort: read the explicit manual order so each stub keeps its slot.
    const order = new OrderStore(this.app);
    const rootOrder = (await order.load(cleaned))[ROOT_ID] ?? [];
    // Progress for big folders: a persistent Notice we update each step (a long
    // lock shouldn't look hung). Only for >3 items so small ops stay quiet.
    const prog = todo.length > 3 ? new Notice("", 0) : null;
    let count = 0;
    for (let i = 0; i < todo.length; i++) {
      const id = todo[i];
      prog?.setMessage(`🔒 Encrypting ${i + 1}/${todo.length}…`);
      const idx = rootOrder.indexOf(id);
      const prevSibling = idx > 0 ? rootOrder[idx - 1] : null;
      if (await this.lockNoteSubtree(cleaned, id, prevSibling, { silent: true })) count++;
    }
    prog?.hide();
    if (count > 0) this.notifications.show({ message: `Locked ${count} note${count === 1 ? "" : "s"} in “${cleaned.split("/").pop()}”.`, kind: "success", category: "system", folder: cleaned, actions: [{ label: "All encrypted", onClick: () => void openAggregateView(this, "encrypted") }] });
    return count;
  }

  /** 0.98.13 (Phase 3): unlock every locked stash in a folder, back into place.
   *  Each blob is independent — skip any that fail the encrypted-envelope check or
   *  were already removed, so a bad one never aborts the batch. Returns the count. */
  async unlockFolder(folder: string): Promise<number> {
    const cleaned = folder.replace(/\/+$/, "");
    if (!(await this.ensureFolderUnlocked(cleaned))) return 0;
    const blobs = this.app.vault.getFiles()
      .filter((f) => f.extension === "stashenc" && (f.parent?.path?.replace(/\/+$/, "") ?? "") === cleaned)
      .map((f) => f.path);
    if (blobs.length === 0) { new Notice("No locked notes in this folder."); return 0; }
    const prog = blobs.length > 3 ? new Notice("", 0) : null;
    let count = 0;
    for (let i = 0; i < blobs.length; i++) {
      prog?.setMessage(`🔓 Decrypting ${i + 1}/${blobs.length}…`);
      try { if (await this.unlockBundleAt(blobs[i], { silent: true })) count++; }
      catch (e) { console.warn("[Stashpad] folder unlock skipped", blobs[i], e); }
    }
    prog?.hide();
    if (count > 0) this.notifications.show({ message: `Unlocked ${count} note${count === 1 ? "" : "s"} in “${cleaned.split("/").pop()}”.`, kind: "success", category: "system", folder: cleaned });
    return count;
  }

  /** 0.98.21 (Phase 3): decrypt EVERY locked stash across the whole vault, back
   *  into place. Non-destructive (unlock only reverses a lock) — a "decrypt
   *  everything" safety valve. Each blob is independent + skip-on-error. */
  async unlockAllInVault(): Promise<number> {
    if (!this.encryption.isConfigured()) { new Notice("Set up encryption first (Settings → Stashpad → Encryption)."); return 0; }
    // Exclude ALL trash stores (`_deleted/` + per-folder `<folder>/trash/`) —
    // those are DELETED notes, not locked ones; "unlocking" them would restore
    // them INTO the reserved trash dir (invisible to every view). Use the
    // trash-restore flow for those. 0.140.1: was `_deleted`-only — per-folder
    // trash blobs leaked through and got restored into `<folder>/trash/`.
    const blobs = this.app.vault.getFiles()
      .filter((f) => f.extension === "stashenc" && !this.isTrashBlobPath(f.path))
      .map((f) => f.path);
    if (blobs.length === 0) { new Notice("No locked notes anywhere in the vault."); return 0; }
    const prog = blobs.length > 3 ? new Notice("", 0) : null;
    // Per-folder keys: each blob is decrypted with the key of the folder it RESIDES
    // in. Cache per folder so each key is attempted once. Folder-keyed folders
    // auto-unlock from the keychain only (no prompt storm mid-batch); the vault key
    // is prompted at most once. Blobs whose folder stays locked are skipped and
    // reported, so the user can unlock those folders and re-run.
    // 0.143.0: per-folder only — each blob is decrypted with its resident folder's
    // own key (auto-unlock from keychain; folders that stay locked are skipped +
    // reported). A blob in an unkeyed folder has no key and is skipped.
    const keyCache = new Map<string, Uint8Array | null>();
    const keyFor = async (resident: string): Promise<Uint8Array | null> => {
      if (keyCache.has(resident)) return keyCache.get(resident)!;
      let dek: Uint8Array | null = null;
      if (this.encryption.hasFolderKey(resident)) {
        if (this.encryption.isFolderUnlocked(resident) || await this.encryption.tryAutoUnlockFolder(resident)) dek = this.encryption.getFolderKey(resident);
      }
      keyCache.set(resident, dek);
      return dek;
    };
    // Decrypt each bundle, collecting the ones that succeeded; update
    // `lockedSubtrees` + write data.json ONCE at the end instead of per bundle
    // (this used to call unlockBundleAt → saveSettings for every bundle, an
    // O(n) pile of redundant data.json writes on top of the per-bundle import).
    let notes = 0;
    const unlockedBlobs: string[] = [];
    const skippedFolders = new Set<string>();
    for (let i = 0; i < blobs.length; i++) {
      prog?.setMessage(`🔓 Decrypting ${i + 1}/${blobs.length}…`);
      const resident = blobs[i].replace(/\/[^/]*$/, "").replace(/\/+$/, "");
      const dek = await keyFor(resident);
      if (!dek) { skippedFolders.add(resident || "(vault root)"); continue; }
      try { const r = await this.unlockBundleCore(blobs[i], dek); notes += r.notesWritten; unlockedBlobs.push(blobs[i]); }
      catch (e) { console.warn("[Stashpad] vault unlock skipped", blobs[i], e); }
    }
    if (unlockedBlobs.length > 0) {
      const done = new Set(unlockedBlobs);
      this.settings.lockedSubtrees = (this.settings.lockedSubtrees ?? []).filter((e) => !done.has(e.blob));
      await this.saveSettings();
    }
    prog?.hide();
    // Wipe the per-folder DEK copies cached for this batch (hygiene — they're slices).
    for (const k of keyCache.values()) { try { k?.fill(0); } catch { /* */ } }
    const folder = blobs[0].replace(/\/[^/]*$/, "");
    if (notes > 0) this.notifications.show({ message: `Unlocked ${notes} note${notes === 1 ? "" : "s"} across the vault.`, kind: "success", category: "system", folder });
    if (skippedFolders.size > 0) {
      new Notice(`Skipped ${skippedFolders.size} locked folder${skippedFolders.size === 1 ? "" : "s"} (no key unlocked): ${[...skippedFolders].map((f) => f.split("/").pop() || f).join(", ")}. Open each to unlock it, then run this again.`, 0);
    }
    return notes;
  }

  /** Export an already-locked subtree (`.stashenc`) as a shareable, password-
   *  protected `.stash` — original blob untouched (feedback #4 / Option B). */
  exportLockedSubtree(blobPath: string): Promise<void> { return cmdExportLockedBlob(this, blobPath); }

  /** 0.169.0: "pop out" the Split-note UI into a full tab. Opens a fresh leaf and
   *  injects the live context (the split handlers are closures bound to the source
   *  note, so the tab must be seeded right away; a restored context-less view shows
   *  a "session ended" placeholder). */
  /** 0.193.0: pop the paste-text importer out into a full tab, carrying whatever was
   *  already typed so nothing is lost on the way out of the modal. */
  async openTextImporter(ctx: Omit<ImporterViewContext, "prevLeaf">): Promise<void> {
    const prevLeaf = this.app.workspace.getMostRecentLeaf();
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: TEXT_IMPORT_VIEW_TYPE, active: true });
    if (leaf.view instanceof TextImportView) leaf.view.setContext({ ...ctx, prevLeaf });
    this.app.workspace.revealLeaf(leaf);
  }

  /** 0.216.0: same pop-out for the Stashpad desktop-app importer, carrying the
   *  already-loaded files across so they don't have to be dropped again. */
  async openAppImporter(ctx: Omit<AppImporterViewContext, "prevLeaf">): Promise<void> {
    const prevLeaf = this.app.workspace.getMostRecentLeaf();
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: APP_IMPORT_VIEW_TYPE, active: true });
    if (leaf.view instanceof AppImportView) leaf.view.setContext({ ...ctx, prevLeaf });
    this.app.workspace.revealLeaf(leaf);
  }

  async openWorkbench(body: string, cbs: WorkbenchCommandCallbacks, init: Partial<WorkbenchState>): Promise<void> {
    // Remember the tab we came from so the split tab can hand focus back on close.
    const prevLeaf = this.app.workspace.getMostRecentLeaf();
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: WORKBENCH_VIEW_TYPE, active: true });
    if (leaf.view instanceof NoteWorkbenchView) leaf.view.setContext({ body, cbs, init, prevLeaf });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Does `folder` contain (or sit within, or contain) Stashpad notes? This is the
   *  CONTENT-based discriminator for "lock the notes" vs "bundle arbitrary files" — it
   *  deliberately does NOT consult the key registry, because a folder keeps its key after
   *  a raw bundle is decrypted, and key-presence would then mis-route a re-encrypt (gap 2)
   *  and mis-show the Decrypt menu item (gap 1). The `d.startsWith(f + "/")` arm is
   *  protective: if `folder` is an ANCESTOR of a Stashpad folder, treat it as Stashpad so
   *  we never raw-bundle (zip + delete) live Stashpad notes nested inside it. */
  private folderHasStashpadNotes(folder: string): boolean {
    const f = folder.replace(/\/+$/, "");
    return this.discoverStashpadFolders().some((d) => f === d || f.startsWith(d + "/") || d.startsWith(f + "/"));
  }

  private encStamp(): string {
    const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  private folderKeyLabelFor(name: string): string {
    const who = (this.settings.authorName || "").trim();
    const initials = who ? who.split(/\s+/).map((w) => w[0]).join("") : (this.settings.authorId || "anon").slice(0, 4);
    return `${this.encStamp()} - ${name} - ${initials}`;
  }

  /** "Encrypt with Stashpad" from the file-explorer folder menu. For a Stashpad folder,
   *  gives it its own password and locks the Stashpad notes inside. For an ARBITRARY
   *  (non-Stashpad) folder, warns via a modal then bundles every file in it into a
   *  single encrypted `.stashenc`, deleting the originals (decrypt all at once). */
  async encryptFolderFromExplorer(folder: string): Promise<void> {
    // 0.142.3: no vault-encryption precondition — giving a folder its own password
    // (setupFolderKey / encryptRawFolder below) is self-contained and can be the
    // FIRST encryption in the vault.
    const name = folder.split("/").pop() || folder;

    // Gap 2: route on CONTENT, not key-presence. A folder previously raw-encrypted then
    // decrypted still owns a key, but it's not a Stashpad-notes folder, so it must route
    // back to the raw path — not the note-locker (which would silently no-op).
    if (this.folderHasStashpadNotes(folder)) { await this.encryptStashpadFolder(folder, name); return; }

    // Already a raw bundle in there? Don't re-bundle — point the user at Decrypt.
    if (await rawFolderBlobIn(this.app, folder)) { new Notice(`“${name}” is already encrypted as a Stashpad bundle. Use “Decrypt with Stashpad” to open it.`); return; }
    await this.encryptRawFolder(folder, name);
  }

  /** Stashpad-folder branch: own password + lock the notes inside. */
  private async encryptStashpadFolder(folder: string, name: string): Promise<void> {
    if (this.encryption.hasOwnFolderKey(folder)) { if (await this.ensureFolderUnlocked(folder)) await this.lockFolder(folder); return; }
    const label = this.folderKeyLabelFor(name);
    new EncryptionPasswordModal(this.app, {
      mode: "setup", offerKeychain: true, title: `Encrypt “${name}” with Stashpad`,
      intro: "Give this folder its own password. Any Stashpad notes inside it get encrypted under it; you'll re-enter the password to unlock.",
      onSubmit: async ({ next, remember }) => {
        if (!next) return "Enter a password.";
        try { await this.encryption.setupFolderKey(folder, next, label, remember); } catch (e) { return (e as Error).message; }
        const n = await this.lockFolder(folder);
        new Notice(n > 0 ? `Encrypted ${n} note${n === 1 ? "" : "s"} in “${name}”.` : `“${name}” now has a Stashpad password — notes added here will use it.`);
        this.refreshFolderPanels?.();
        return null;
      },
    }).open();
  }

  /** Non-Stashpad branch: confirm the all-at-once model, then bundle the whole folder.
   *  Reuses an existing folder key if present (gap 2 re-encrypt case) so we don't trip
   *  setupFolderKey's "refuse if key exists" guard. */
  private async encryptRawFolder(folder: string, name: string): Promise<void> {
    const runBundle = async (dek: Uint8Array): Promise<string | null> => {
      const keyId = this.encryption.folderKeyEntry(folder)?.keyId;
      try {
        const r = await lockRawFolder(this.app, folder, dek, keyId, this.encStamp());
        if (r.unpurged.length) new Notice(`Encrypted “${name}” (${r.fileCount} files) — but ${r.unpurged.length} file(s) changed mid-encrypt and were left in place.`);
        else new Notice(`Encrypted “${name}” — ${r.fileCount} file(s) bundled into one encrypted file.`);
      } catch (e) { return (e as Error).message; }
      this.refreshFolderPanels?.();
      return null;
    };
    new ConfirmModal(
      this.app,
      `Encrypt “${name}” — non-Stashpad folder`,
      // Gap 3: be explicit that this is NOT Cmd+Z-undoable — the reversal is Decrypt. We
      // hard-delete (not trash) the originals ON PURPOSE so no plaintext copy is left
      // behind in `.trash`, which would defeat the encryption.
      "This isn't a Stashpad folder, so its files can't be locked individually.\nStashpad will bundle EVERY file in this folder into one encrypted file and permanently delete the originals (no copy left in Obsidian's trash — that would defeat encryption).\nThis can't be undone with Cmd+Z; the only way back is “Decrypt with Stashpad” + the password. Continue?",
      "Bundle & encrypt",
      (confirmed: boolean) => {
        if (!confirmed) return;
        // Reuse an existing key (decrypt→re-encrypt cycle); else prompt for a new one.
        if (this.encryption.hasOwnFolderKey(folder)) {
          void (async () => {
            const dek = await this.ensureFolderUnlocked(folder);
            if (!dek) return; // prompts/notices on failure
            const err = await runBundle(dek);
            if (err) new Notice(err);
          })();
          return;
        }
        const label = this.folderKeyLabelFor(name);
        new EncryptionPasswordModal(this.app, {
          mode: "setup", offerKeychain: true, title: `Encrypt “${name}” with Stashpad`,
          intro: "Set a password for this bundle. You'll re-enter it to decrypt the whole folder.",
          onSubmit: async ({ next, remember }) => {
            if (!next) return "Enter a password.";
            try { await this.encryption.setupFolderKey(folder, next, label, remember); } catch (e) { return (e as Error).message; }
            const dek = this.encryption.getFolderKey(folder);
            if (!dek) return "Couldn't derive the folder key.";
            return await runBundle(dek);
          },
        }).open();
      },
    ).open();
  }

  /** "Decrypt with Stashpad" on a folder holding a raw-folder bundle: unlock the
   *  folder's key, then unzip the bundle back into the folder and remove the blob. */
  async decryptFolderFromExplorer(folder: string): Promise<void> {
    const blob = await rawFolderBlobIn(this.app, folder);
    if (!blob) { new Notice("No Stashpad bundle found in this folder."); return; }
    const name = folder.split("/").pop() || folder;
    const dek = await this.ensureFolderUnlocked(folder);
    if (!dek) return; // ensureFolderUnlocked prompts/notices on failure
    try {
      const r = await unlockRawFolder(this.app, blob, dek);
      new Notice(`Decrypted “${name}” — restored ${r.filesWritten} file(s).`);
    } catch (e) { new Notice(`Couldn't decrypt: ${(e as Error).message}`); }
    this.refreshFolderPanels?.();
  }

  // (keyfile-removal Phase 4 / 0.142.0: per-folder key ROTATION removed. A leaked
  // key is now handled by "Remove encryption" + re-encrypt, not a bespoke rotate
  // pass — see docs/encryption-keyfile-removal-plan.md decision #6. The `.rot`
  // temp machinery, rotation locks, and resumeRotations() went with it.)

  // --- 0.98.29 (Phase 5): encrypted trash (`_deleted/`) ---

  /** Encrypt-delete a subtree into `_deleted/` (recoverable, encrypted) and
   *  permanently remove the plaintext. Returns the blob path, or null on failure. */
  async encryptDeleteSubtree(folder: string, rootId: StashpadId): Promise<string | null> {
    // Per-folder trash keys: encrypt the trash blob under the FOLDER's key (or the
    // vault DEK as fallback) and stamp its keyId into the sidecar so restore can
    // resolve the right key — even for hidden-origin deletes.
    const dek = await this.ensureFolderUnlocked(folder);
    if (!dek) return null;
    try {
      // Plugin runtime (not a workflow script) — Date is available.
      const deletedAt = new Date().toISOString();
      // "Encrypt trash filenames" hides the trash blob's name/origin even when
      // the general hide-locked-titles setting is off. This folder's
      // trashEncryptFilenames pref takes precedence over the globals.
      const _trFp = (this.settings.folderEncPrefs ?? {})[folder.replace(/\/+$/, "")] ?? {};
      const hideTitle = (_trFp.trashEncryptFilenames ?? false) || (this.settings.encryptTrashFilenames ?? false); // 0.137.1: global hideLockedTitles removed
      const keyId = this.encryption.folderKeyEntry(folder)?.keyId; // undefined ⇒ vault-keyed
      // 0.137.0 (per-folder trash): the blob lands in THIS folder's own trash/
      // subfolder instead of the vault-level _deleted/ (which stays readable
      // for legacy blobs until they're restored or migrated).
      const r = await deleteEncryptSubtree(this.app, folder, rootId, dek, deletedAt, hideTitle, keyId, trashSubfolderOf(folder));
      this.pendingEncBlobs.add(r.blobPath); // fast-state index
      // 0.138.0: secure-deleted → no longer plaintext, so off the watchlist.
      this.unwatchReEncrypt(folder, rootId);
      await this.saveSettings();
      if (r.unpurged.length > 0) {
        new Notice(`⚠️ Sent to encrypted trash, but ${r.unpurged.length} file${r.unpurged.length === 1 ? " is" : "s are"} still in plaintext (couldn't be removed or changed during the delete):\n${r.unpurged.join("\n")}`, 0);
      }
      return r.blobPath;
    } catch (e) {
      console.warn("[Stashpad] encrypt-delete failed", e);
      new Notice(`Couldn't encrypt-delete: ${(e as Error).message}`, 0);
      return null;
    }
  }

  /** DEFAULT (encryption-off) delete → Stashpad's own per-folder `trash/` as an
   *  UNENCRYPTED `.stashpack` bundle, recoverable from the Trash view. Returns the
   *  bundle path, or null on failure (plaintext kept intact). 0.145.0 */
  async plaintextDeleteSubtree(folder: string, rootId: StashpadId): Promise<string | null> {
    try {
      const deletedAt = new Date().toISOString();
      const r = await deletePlaintextSubtree(this.app, folder, rootId, deletedAt, trashSubfolderOf(folder));
      this.unwatchReEncrypt(folder, rootId); // no longer in the folder
      if (r.unpurged.length > 0) {
        new Notice(`⚠️ Sent to trash, but ${r.unpurged.length} file${r.unpurged.length === 1 ? " is" : "s are"} still in place (couldn't be removed or changed during the delete):\n${r.unpurged.join("\n")}`, 0);
      }
      return r.blobPath;
    } catch (e) {
      console.warn("[Stashpad] plaintext trash delete failed", e);
      new Notice(`Couldn't delete to trash: ${(e as Error).message}`, 0);
      return null;
    }
  }

  /** List plaintext trash bundles (`.stashpack`) across per-folder trash dirs, with
   *  their sidecar meta — for the Trash view. Independent of encryption being
   *  configured (these need no key). 0.145.0 */
  async listPlaintextTrash(): Promise<Array<{ blob: string; meta: DeletedMeta | null }>> {
    const blobs = await listPlaintextTrashBundles(this.app, this.trashSubfolderDirs());
    const out: Array<{ blob: string; meta: DeletedMeta | null }> = [];
    for (const b of blobs) out.push({ blob: b, meta: await readDeletedMeta(this.app, b) });
    return out;
  }

  /** Restore an encrypted-deleted blob back into its original folder. */
  async restoreDeletedAt(blobPath: string, opts: { silent?: boolean } = {}): Promise<boolean> {
    const meta = await readDeletedMeta(this.app, blobPath);
    // Plaintext trash bundle (default encryption-off delete): no key, no decrypt.
    // Detected by extension (authoritative) with meta.encrypted as a cross-check.
    if (blobPath.endsWith(`.${STASHPACK_EXT}`) || meta?.encrypted === false) {
      try {
        // Existing ids from DISK frontmatter (cache lags after restore churn), same
        // as the encrypted path — prevents importStashZip re-pinning a child to ROOT.
        const destGuess = await deletedRestoreDest(this.app, blobPath, meta);
        const existing = new Set<StashpadId>();
        for (const f of this.app.vault.getMarkdownFiles()) {
          if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== destGuess.replace(/\/+$/, "")) continue;
          try { const id = splitFrontmatter(await this.app.vault.read(f)).fm.id; if (typeof id === "string") existing.add(id); }
          catch { /* unreadable — skip */ }
        }
        const r = await restorePlaintextDeleted(this.app, blobPath, existing);
        this.pendingEncBlobs.delete(blobPath);
        try { await this.newLog().append({ type: "restore", id: meta?.rootId || ROOT_ID, payload: { to: r.restoredTo, from: "trash", encrypted: false } }); } catch { /* log best-effort */ }
        // 0.211.6 (L3): an incomplete restore KEEPS the bundle, so say so — the user
        // needs to know the trash item is still there and why, rather than reading a
        // plain success toast and assuming everything came back.
        if (!opts.silent) this.notifications.show({
          message: r.bundleKept
            ? `Restored ${r.notesWritten} note${r.notesWritten === 1 ? "" : "s"} to “${r.restoredTo.split("/").pop()}”, but ${r.warnings.length || "some"} couldn't be restored — the trash item was KEPT so you can try again.`
            : `Restored ${r.notesWritten} note${r.notesWritten === 1 ? "" : "s"} to “${r.restoredTo.split("/").pop()}”.`,
          kind: r.bundleKept ? "warning" : "success",
          category: "system", folder: r.restoredTo,
          actions: [{ label: "Go to folder", onClick: () => void this.activateViewForFolder(r.restoredTo) }],
        });
        return true;
      } catch (e) {
        console.warn("[Stashpad] restore plaintext trash failed", e);
        new Notice(`Couldn't restore: ${(e as Error).message}`, 0);
        return false;
      }
    }
    // Per-folder trash keys: resolve the key this blob was encrypted under via its
    // sidecar keyId (the owning folder's key); else the vault DEK (legacy/vault-keyed).
    // 0.143.0: per-folder only — resolve the key this blob was encrypted under via
    // its sidecar keyId (the owning folder's key). A blob with no keyId is a legacy
    // vault-keyed blob and can no longer be resolved.
    let dek: Uint8Array | null = null;
    if (meta?.keyId) {
      const owner = this.encryption.folderPathByKeyId(meta.keyId);
      dek = owner ? await this.ensureFolderUnlocked(owner) : null;
    }
    if (!dek) { if (!opts.silent) new Notice("Couldn't unlock the folder key this trashed note was encrypted with."); return false; }
    // Backfill blobs are raw `.trash/` zips, not Stashpad bundles — different
    // restore path (plain unzip back into `.trash/`).
    if (meta?.kind === "rawtrash") {
      try {
        const r = await restoreRawTrash(this.app, blobPath, dek);
        this.pendingEncBlobs.delete(blobPath);
        if (!opts.silent) this.notifications.show({ message: `Restored ${r.filesWritten} file${r.filesWritten === 1 ? "" : "s"} to Obsidian's trash (${OBSIDIAN_TRASH_DIR}/).`, kind: "success", category: "system", folder: "" });
        return true;
      } catch (e) {
        console.warn("[Stashpad] trash-backfill restore failed", e);
        new Notice(`Couldn't restore: ${(e as Error).message}`, 0);
        return false;
      }
    }
    try {
      // Sanitized; decrypts the origin for hidden-title deletes; throws (blob
      // kept) when a trash blob's origin is unknowable instead of dumping
      // plaintext into `_deleted/`.
      const dest = await deletedRestoreDest(this.app, blobPath, meta, dek);
      // Existing ids from DISK frontmatter, not metadataCache — the cache lags
      // after lock/restore churn, and a stale miss makes importStashZip re-pin
      // a restored child to ROOT.
      const existing = new Set<StashpadId>();
      for (const f of this.app.vault.getMarkdownFiles()) {
        if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== dest.replace(/\/+$/, "")) continue;
        try {
          const id = splitFrontmatter(await this.app.vault.read(f)).fm.id;
          if (typeof id === "string") existing.add(id);
        } catch { /* unreadable — skip */ }
      }
      const r = await restoreDeleted(this.app, blobPath, dek, existing);
      this.pendingEncBlobs.delete(blobPath);
      try { await this.newLog().append({ type: "restore", id: meta?.rootId || ROOT_ID, payload: { to: r.restoredTo, from: "trash", encrypted: true } }); } catch { /* log best-effort */ }
      // 0.138.0: restore-from-trash counts as an unlock (user decision) — the
      // note WAS encrypted and is plaintext again. Sidecar carries the identity.
      if (meta?.rootId) {
        this.watchReEncrypt({ folder: r.restoredTo, rootId: meta.rootId, title: meta.title || "", count: meta.count ?? r.notesWritten, via: "restore" });
        await this.saveSettings();
      }
      if (!opts.silent) this.notifications.show({ message: `Restored ${r.notesWritten} note${r.notesWritten === 1 ? "" : "s"} to “${r.restoredTo.split("/").pop()}”.`, kind: "success", category: "system", folder: r.restoredTo, actions: [{ label: "Go to folder", onClick: () => void this.activateViewForFolder(r.restoredTo) }] });
      return true;
    } catch (e) {
      console.warn("[Stashpad] restore-from-trash failed", e);
      new Notice(`Couldn't restore: ${(e as Error).message}`, 0);
      return false;
    }
  }

  /** Permanently delete one encrypted-trash item (blob + sidecar). Irreversible
   *  — no decrypt. The caller MUST confirm first. Returns true on success. */
  async purgeDeletedAt(blobPath: string): Promise<boolean> {
    try {
      await purgeDeletedBlob(this.app, blobPath);
      this.pendingEncBlobs.delete(blobPath);
      return true;
    } catch (e) {
      console.warn("[Stashpad] purge-from-trash failed", blobPath, e);
      new Notice(`Couldn't delete: ${(e as Error).message}`, 0);
      return false;
    }
  }

  /** Permanently delete EVERY live locked `.stashenc` bundle (+ sidecar) WITHOUT
   *  decrypting — the notes inside are gone for good. Backs "Remove encryption →
   *  Delete locked content" for when the password is lost. Excludes `_deleted/`
   *  trash (that's handled separately). Caller MUST confirm. Returns the count. */
  async purgeAllLockedContent(): Promise<number> {
    // 0.140.1: was `_deleted`-only — per-folder `<folder>/trash/` blobs slipped
    // through and got IRREVERSIBLY PURGED even though the trash has its own
    // decrypt-vs-discard step. Use the trash-aware predicate.
    const isTrash = (p: string): boolean => this.isTrashBlobPath(p);
    const blobs = new Set<string>();
    for (const f of this.app.vault.getFiles()) if (f.extension === "stashenc" && !isTrash(f.path)) blobs.add(f.path);
    for (const p of this.pendingEncBlobs) if (!isTrash(p)) blobs.add(p);
    let n = 0;
    for (const b of blobs) {
      try { await purgeDeletedBlob(this.app, b); this.pendingEncBlobs.delete(b); n++; }
      catch (e) { console.warn("[Stashpad] purge locked content failed", b, e); }
    }
    this.settings.lockedSubtrees = (this.settings.lockedSubtrees ?? []).filter((e) => !blobs.has(e.blob));
    await this.saveSettings();
    return n;
  }

  /** 0.126.3: list Stashpad-origin notes sitting UNENCRYPTED in Obsidian's
   *  `.trash/` (where plain deletes go when "Encrypt items sent to trash" is
   *  off). Heuristic: a markdown file whose frontmatter carries both `id` and
   *  `parent` (Stashpad's reserved keys). Read via the adapter since `.trash` is
   *  not indexed by the metadata cache. */
  async listRawTrashStashpadNotes(): Promise<Array<{ path: string; name: string; title: string; mtime: number }>> {
    const dir = OBSIDIAN_TRASH_DIR;
    const out: Array<{ path: string; name: string; title: string; mtime: number }> = [];
    try {
      if (!(await this.app.vault.adapter.exists(dir))) return out;
      const listing = await this.app.vault.adapter.list(dir);
      for (const p of listing.files) {
        if (!p.endsWith(".md")) continue;
        let content = "";
        try { content = await this.app.vault.adapter.read(p); } catch { continue; }
        const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
        if (!fmMatch) continue;
        const fm = fmMatch[1];
        if (!/^id:\s*\S/m.test(fm) || !/^parent:\s*/m.test(fm)) continue; // Stashpad-origin heuristic
        const base = p.split("/").pop() || p;
        const title = base.replace(/\.md$/, "").replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ").trim() || base;
        let mtime = 0;
        try { mtime = (await this.app.vault.adapter.stat(p))?.mtime ?? 0; } catch { /* ignore */ }
        out.push({ path: p, name: base, title, mtime });
      }
    } catch { /* ignore */ }
    return out;
  }

  /** Restore one raw-trash note back into the default Stashpad folder. Origin
   *  folder isn't recorded on disk, so this is best-effort: the note keeps its
   *  `id`/`parent` frontmatter, so the tree re-nests it under its parent if that
   *  parent lives in the default folder; otherwise it lands at the folder root
   *  (recoverable, never lost). */
  async restoreRawTrashNote(path: string): Promise<boolean> {
    const dest = (this.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "") || "Stashpad";
    const base = path.split("/").pop() || path;
    try {
      if (!(await this.app.vault.adapter.exists(dest))) { try { await this.app.vault.createFolder(dest); } catch { /* exists race */ } }
      let target = `${dest}/${base}`;
      if (await this.app.vault.adapter.exists(target)) target = `${dest}/${base.replace(/\.md$/, "")}-restored-${Date.now()}.md`;
      await this.app.vault.adapter.rename(path, target);
      this.notifications.show({ message: `Restored "${base}" to ${dest}/. If its parent lives in another folder, move it from there.`, kind: "success", category: "system", folder: dest, actions: [{ label: "Go to folder", onClick: () => void this.activateViewForFolder(dest) }] });
      return true;
    } catch (e) {
      new Notice(`Couldn't restore: ${(e as Error).message}`);
      return false;
    }
  }

  /** 0.129.0: plain (unencrypted) Stashpad notes living in an archive folder —
   *  the ones the "All archived" view was missing (it only showed locked
   *  subtrees). Markdown files under `folder` whose frontmatter carries an `id`. */
  archivedPlainNotesIn(folder: string): TFile[] {
    const clean = folder.replace(/\/+$/, "");
    const prefix = clean + "/";
    const out: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!(dir === clean || dir.startsWith(prefix))) continue;
      const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
      if (typeof id === "string" && id) out.push(f);
    }
    return out;
  }

  /** Un-archive a plain note: move it out of the archive folder into the default
   *  Stashpad folder. Borrows restoreRawTrashNote's best-effort approach — the
   *  note keeps its id/parent, so the tree re-nests it under its parent if that
   *  parent is in the default folder; else it lands at the folder root. */
  async unarchiveNote(file: TFile): Promise<boolean> {
    // 0.136.0: a note in `X/archive/...` un-archives back to X (its own folder),
    // not the global default. Legacy dedicated-archive notes (no /archive
    // segment) still fall back to the default folder — their origin is unknown.
    const dir = (file.parent?.path ?? "").replace(/\/+$/, "");
    const segs = dir.split("/");
    const archIdx = segs.indexOf("archive");
    const dest = archIdx > 0
      ? segs.slice(0, archIdx).join("/")
      : ((this.settings.folder || "Stashpad").trim().replace(/^\/+|\/+$/g, "") || "Stashpad");
    if ((file.parent?.path ?? "") === dest) { new Notice("Already in the default folder."); return false; }
    try {
      if (!(await this.app.vault.adapter.exists(dest))) { try { await this.app.vault.createFolder(dest); } catch { /* race */ } }
      let target = `${dest}/${file.name}`;
      if (await this.app.vault.adapter.exists(target)) target = `${dest}/${file.basename}-restored-${Date.now()}.md`;
      await this.app.fileManager.renameFile(file, target);
      this.notifications.show({ message: `Un-archived "${file.basename}" to ${dest}/.`, kind: "success", category: "system", folder: dest });
      return true;
    } catch (e) {
      new Notice(`Couldn't un-archive: ${(e as Error).message}`);
      return false;
    }
  }

  /** Every per-folder trash/ subfolder (0.137.0) — the extra dirs the
   *  encrypted-trash listing unions with the legacy _deleted/. */
  trashSubfolderDirs(): string[] {
    return this.discoverStashpadFolders().map((f) => trashSubfolderOf(f));
  }

  /** List the encrypted-trash contents (blob path + sidecar metadata). */
  async listDeletedTrash(): Promise<Array<{ blob: string; meta: DeletedMeta | null }>> {
    const blobs = await listDeletedBlobs(this.app, this.trashSubfolderDirs());
    const out: Array<{ blob: string; meta: DeletedMeta | null }> = [];
    for (const b of blobs) out.push({ blob: b, meta: await readDeletedMeta(this.app, b) });
    return out;
  }

  /** v2: restore EVERY encrypted-trash note back to its origin folder.
   *  (The old `scopeFolder` filter was dropped: no caller passed it, and it
   *  matched plaintext `originalFolder` — silently skipping hidden-title items
   *  whose origin lives only in `originalFolderEnc`.) */
  async restoreAllTrash(): Promise<number> {
    // 0.143.0: per-folder only — restoreDeletedAt unlocks each blob's owning folder
    // key on demand (and skips any it can't), so no vault-wide unlock gate here.
    // 0.145.0: include plaintext trash bundles (no key needed) so "Restore all"
    // doesn't silently skip default (encryption-off) deletes.
    const items = [...await this.listDeletedTrash(), ...await this.listPlaintextTrash()];
    if (items.length === 0) { new Notice("Nothing to restore."); return 0; }
    const prog = items.length > 3 ? new Notice("", 0) : null;
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      prog?.setMessage(`🔓 Restoring ${i + 1}/${items.length}…`);
      try { if (await this.restoreDeletedAt(items[i].blob, { silent: true })) count++; }
      catch (e) { console.warn("[Stashpad] restore-all skipped", items[i].blob, e); }
    }
    prog?.hide();
    if (count > 0) this.notifications.show({ message: `Restored ${count} note${count === 1 ? "" : "s"} from encrypted trash.`, kind: "success", category: "system", folder: "" });
    return count;
  }

  // (0.143.0: encryptExistingTrash — the vault-DEK sweep of Obsidian's plaintext
  // `.trash/` into one encrypted blob — is removed. Encryption is per-folder now;
  // there is no vault key to encrypt the shared `.trash/` under. Per-folder trash
  // encryption (a keyed folder's deletes) is unchanged.)

  /** Open the recoverable Trash TAB. Unified across all folders — lists both
   *  plaintext (`.trash/`) and encrypted (`_deleted/`) deleted notes — so it no
   *  longer requires encryption to be set up. (The `_` arg keeps the old
   *  per-folder call sites working; the tab groups by origin folder anyway.) */
  openEncryptedTrash(_scopeFolder?: string): void {
    void openTrashView(this);
  }

  /** Open a picker over the encrypted trash; restore the chosen note in place. */
  async openRestoreTrashPicker(): Promise<void> {
    if (!this.encryption.isConfigured()) { new Notice("Set up encryption first (Settings → Stashpad → Encryption)."); return; }
    const items = await this.listDeletedTrash();
    if (items.length === 0) { new Notice("Encrypted trash is empty."); return; }
    const entries = items.map(({ blob, meta }) => ({
      blob,
      label: meta?.title || blob.split("/").pop()?.replace(/\.stashenc$/, "") || "Locked note",
      folder: meta?.originalFolder || "(unknown)",
    }));
    new DeletedTrashSuggestModal(this.app, entries, (blob) => { void this.restoreDeletedAt(blob); }).open();
  }

  // --- 0.98.25 (Phase 4): archive folders — auto-encrypt notes moved in ---

  /** 0.136.0 (per-folder archive): "is this an archive?" now means "is this a
   *  folder's `archive/` subfolder (or inside one)?". The legacy dedicated
   *  archive-folder model (archiveFolders[] ∪ folderEncPrefs[f].archive) is
   *  still honored DURING the transition so un-migrated vaults keep their
   *  search exclusion + icons until the one-time migration has run. */
  isArchiveFolder(folder: string): boolean {
    const cleaned = folder.replace(/\/+$/, "");
    if (isArchiveSubfolderPath(cleaned)) return true;
    if ((this.settings.archiveFolders ?? []).includes(cleaned)) return true;
    return !!(this.settings.folderEncPrefs ?? {})[cleaned]?.archive;
  }

  /** 0.134.4 (B1): the ONE resolver for "does archiving into `folder` encrypt?".
   *  Both the move-in sweep and the Move-to-archive command must use this —
   *  they previously had opposite defaults (sweep `?? true`, command `?? false`),
   *  so a drag encrypted while the command moved plaintext. Default is PLAINTEXT;
   *  encryption is opt-in per folder via "Encrypt archived notes". */
  archiveEncryptFor(folder: string): boolean {
    let cleaned = folder.replace(/\/+$/, "");
    // 0.136.0: when handed an `X/archive` subfolder path (the move-in sweep
    // does), the pref lives on the PARENT folder X.
    if (cleaned.endsWith("/archive")) cleaned = cleaned.slice(0, -"/archive".length);
    return (this.settings.folderEncPrefs ?? {})[cleaned]?.archiveEncryptContent ?? false;
  }

  /** 0.136.0: ONE-TIME migration to per-folder archive subfolders ("Option D"
   *  phase 1, docs/archive-trash-subfolders-plan.md, migration option b).
   *  Each legacy dedicated archive folder F becomes a normal folder again; its
   *  plain notes move into F's OWN `archive/` subfolder. Locked `.stashenc`
   *  blobs stay where they are (the lockedSubtrees registry paths must not
   *  break; they remain visible in the aggregated views). Legacy folders keep
   *  auto-encrypt semantics: archiveEncryptContent is stamped TRUE when unset
   *  (they were created under the encrypt-on-arrival regime). Persistent
   *  notice + a log entry per folder, then the legacy settings are cleared. */
  /** True while the one-time archive migration is moving files — gates the
   *  auto-encrypt sweep (its rename events must not look like new arrivals). */
  private archiveMigrationInFlight = false;

  async migrateArchiveFoldersToSubfolders(): Promise<void> {
    if (this.settings.migratedArchiveToSubfolders) return;
    this.archiveMigrationInFlight = true;
    try {
      await this.migrateArchiveFoldersToSubfoldersInner();
    } finally {
      // Keep the gate up through the sweep's 1800ms settle window — rename
      // events fired by the last migration move are still queued when the
      // inner function returns.
      window.setTimeout(() => { this.archiveMigrationInFlight = false; }, 4000);
    }
  }

  private async migrateArchiveFoldersToSubfoldersInner(): Promise<void> {
    const legacy = new Set<string>((this.settings.archiveFolders ?? []).map((f) => f.replace(/\/+$/, "")));
    for (const [f, p] of Object.entries(this.settings.folderEncPrefs ?? {})) if (p?.archive) legacy.add(f.replace(/\/+$/, ""));
    const log = this.newLog();
    const lines: string[] = [];
    let totalFailed = 0;
    // Recovery journal: every planned + completed move, persisted BEFORE the
    // settings flip so a crash mid-migration leaves a trail to restore from.
    const journal: Array<{ folder: string; from: string; to: string; ok: boolean }> = [];
    const journalPath = `${this.pluginPrivatePath()}/archive-migration-journal.json`;
    const writeJournal = async () => {
      try { await this.app.vault.adapter.write(journalPath, JSON.stringify({ ts: new Date().toISOString(), moves: journal }, null, 1)); } catch { /* best-effort */ }
    };
    for (const folder of [...legacy].sort()) {
      const tf = this.app.vault.getAbstractFileByPath(folder);
      if (!(tf instanceof TFolder)) continue; // zombie entry — nothing to move
      const dest = archiveSubfolderOf(folder);
      try { if (!(await this.app.vault.adapter.exists(dest))) await this.app.vault.createFolder(dest); } catch { /* race */ }
      let moved = 0, failed = 0;
      // Direct .md children only: locked blobs + reserved subfolders stay put,
      // and nested subfolders are their own Stashpad folders.
      for (const child of [...tf.children]) {
        if (!(child instanceof TFile) || child.extension !== "md") continue;
        // Keep the folder's HOME note (id: root) — archiving it would destroy
        // the folder's identity as a Stashpad folder (caught in live testing).
        // Read the id from DISK: at layout-ready+5s the metadataCache can still
        // be cold (big vault / network drive), and a cold cache would return
        // undefined for the home note and let it be moved.
        let fmId: unknown;
        try { fmId = splitFrontmatter(await this.app.vault.read(child)).fm.id; }
        catch { failed++; totalFailed++; continue; } // unreadable → leave in place
        if (fmId === ROOT_ID) continue;
        let to = `${dest}/${child.name}`;
        const from = child.path;
        try {
          for (let n = 1; await this.app.vault.adapter.exists(to); n++) to = `${dest}/${child.basename}-${n}.md`;
          journal.push({ folder, from, to, ok: false });
          await this.app.fileManager.renameFile(child, to);
          // Verify the move actually landed (the 0.79.21 import lesson: a
          // silently-failed rename must never be counted as done).
          if (!(this.app.vault.getAbstractFileByPath(to) instanceof TFile)) throw new Error("rename did not land");
          journal[journal.length - 1].ok = true;
          moved++;
        } catch (e) { failed++; totalFailed++; console.warn("[Stashpad] archive migration move failed", from, e); }
      }
      await writeJournal();
      // Do NOT stamp archiveEncryptContent — since 0.134.4 the effective
      // default for these folders is already plaintext, and stamping TRUE made
      // the migration's own moves trigger the auto-encrypt sweep, silently
      // encrypting every previously-plaintext archived note (caught in live
      // testing — a data-loss-grade surprise). Encryption stays opt-in.
      // De-flag prefs.archive only when THIS folder migrated cleanly — a folder
      // marked only via the pref must stay in the retry set otherwise.
      if (failed === 0) {
        const prefs = { ...(this.settings.folderEncPrefs ?? {}) };
        const cur = { ...(prefs[folder] ?? {}) };
        delete cur.archive;
        prefs[folder] = cur;
        this.settings.folderEncPrefs = prefs;
      }
      lines.push(`"${folder}": ${moved} note${moved === 1 ? "" : "s"} → ${dest}/${failed ? ` (${failed} failed — left in place)` : ""}`);
      void log.append({ type: "archive_migration", id: "", payload: { folder, dest, moved, failed } as Record<string, unknown> });
    }
    // Only finalize when EVERY move landed. On any failure the legacy settings
    // stay put and the marker stays false, so the next launch retries the
    // leftovers (already-moved notes are gone from the root, so a retry is a
    // no-op for them). No data is ever deleted either way — a failed move
    // leaves the note exactly where it was.
    if (totalFailed === 0) {
      this.settings.archiveFolders = [];
      this.settings.defaultArchiveFolder = undefined;
      this.settings.migratedArchiveToSubfolders = true;
      await this.saveSettings();
    } else {
      await this.saveSettings(); // persist any prefs.archive de-flags that DID complete
      new Notice(`Stashpad archive update: ${totalFailed} note${totalFailed === 1 ? "" : "s"} couldn't be moved (see the developer console). Nothing was deleted — the migration will retry on the next launch. A recovery journal of every move is at ${this.pluginPrivatePath()}/archive-migration-journal.json.`, 0);
    }
    if (lines.length) {
      new Notice(`Stashpad archive update: dedicated archive folders are now regular folders — archived notes moved into each folder's own "archive/" subfolder.\n\n${lines.join("\n")}\n\nFind everything in the aggregated Archived view. (This notice stays until dismissed.)`, 0);
    }
  }

  /** 0.137.0: ONE-TIME migration of the vault-level encrypted trash into
   *  per-folder `trash/` subfolders. Conservative by design: ONLY `deleted`
   *  blobs whose sidecar names a plaintext origin folder that still exists
   *  move to `<origin>/trash/`; everything else (rawtrash/rawfolder backfills,
   *  hidden-origin sidecars, unreadable sidecars, missing folders) STAYS in
   *  `_deleted/`, which remains fully listed/restorable forever. Copy →
   *  byte-verify → remove, via the adapter (no vault events, so no sweep or
   *  import interactions). Journal + retry like the archive migration. */
  async migrateDeletedToTrashSubfolders(): Promise<void> {
    if (this.settings.migratedTrashToSubfolders) return;
    const a = this.app.vault.adapter;
    const log = this.newLog();
    let moved = 0, left = 0, failed = 0;
    const journal: Array<{ from: string; to: string; ok: boolean }> = [];
    const journalPath = `${this.pluginPrivatePath()}/trash-migration-journal.json`;
    try {
      const blobs = await listDeletedBlobs(this.app); // legacy _deleted/ only
      for (const blob of blobs) {
        const meta = await readDeletedMeta(this.app, blob);
        const origin = (meta?.kind === "deleted" && meta.originalFolder) ? meta.originalFolder.replace(/\/+$/, "") : "";
        if (!origin || !(this.app.vault.getAbstractFileByPath(origin) instanceof TFolder)) { left++; continue; }
        const destDir = trashSubfolderOf(origin);
        try {
          if (!(await a.exists(destDir))) await a.mkdir(destDir);
          const name = blob.split("/").pop()!;
          let to = `${destDir}/${name}`;
          for (let n = 1; await a.exists(to); n++) to = `${destDir}/${name.replace(/\.stashenc$/, "")} (${n}).stashenc`;
          journal.push({ from: blob, to, ok: false });
          // blob: copy → verify bytes → remove
          const bytes = new Uint8Array(await a.readBinary(blob));
          await a.writeBinary(to, bytes.slice().buffer as ArrayBuffer);
          // 0.140.1: FULL byte-compare before removing the only copy — a
          // same-length corruption (flaky network drive) passed the old
          // length-only check → AEAD-unrestorable blob, permanent loss.
          const back = new Uint8Array(await a.readBinary(to));
          if (back.length !== bytes.length) throw new Error("copy verify failed (length)");
          for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]) throw new Error("copy verify failed (content)");
          // sidecar FIRST, and verify it too — a truncated sidecar loses keyId/
          // originalFolderEnc → folder-keyed blob unrestorable. Copy+verify the
          // sidecar and remove the blob LAST (crash → harmless duplicate, never
          // a sidecar-less orphan in _deleted/).
          const sc = blob.replace(/\.stashenc$/, ".stashmeta");
          const scTo = to.replace(/\.stashenc$/, ".stashmeta");
          try {
            if (await a.exists(sc)) {
              const scBody = await a.read(sc);
              await a.write(scTo, scBody);
              if ((await a.read(scTo)) !== scBody) throw new Error("sidecar verify failed");
              await a.remove(sc);
            }
          } catch (e) { throw new Error(`sidecar copy failed: ${(e as Error).message}`); }
          await a.remove(blob);
          journal[journal.length - 1].ok = true;
          moved++;
        } catch (e) { failed++; console.warn("[Stashpad] trash migration move failed", blob, e); }
      }
      try { await a.write(journalPath, JSON.stringify({ ts: new Date().toISOString(), moves: journal }, null, 1)); } catch { /* best-effort */ }
    } catch (e) { console.error("[Stashpad] trash migration failed", e); return; }
    void log.append({ type: "archive_migration", id: "", payload: { what: "trash-subfolders", moved, left, failed } as Record<string, unknown> });
    if (failed === 0) {
      this.settings.migratedTrashToSubfolders = true;
      await this.saveSettings();
    }
    if (moved > 0 || failed > 0) {
      new Notice(`Stashpad trash update: ${moved} encrypted-trash item${moved === 1 ? "" : "s"} moved into per-folder "trash/" subfolders${left ? ` (${left} stayed in _deleted/ — unknown or missing origin)` : ""}${failed ? ` — ${failed} failed; will retry next launch` : ""}. Everything stays visible in the Trash view.`, 0);
    }
  }

  /** 0.134.4 (B5): drop archiveFolders[] entries (and a defaultArchiveFolder)
   *  pointing at folders that no longer exist. Folder deletion never cleaned
   *  these up, so zombies accumulated. Conservative: folderEncPrefs entries are
   *  left alone (inert when the folder is gone, and they may describe a folder
   *  that exists on another synced device). */
  async pruneZombieArchiveEntries(): Promise<void> {
    const exists = (f: string) => this.app.vault.getAbstractFileByPath(f) instanceof TFolder;
    const before = this.settings.archiveFolders ?? [];
    const kept = before.filter((f) => exists(f.replace(/\/+$/, "")));
    let dirty = kept.length !== before.length;
    const def = (this.settings.defaultArchiveFolder ?? "").replace(/\/+$/, "");
    if (def && !exists(def)) { this.settings.defaultArchiveFolder = undefined; dirty = true; }
    if (dirty) {
      this.settings.archiveFolders = kept;
      await this.saveSettings();
      console.info(`[Stashpad] pruned ${before.length - kept.length} stale archive-folder entr${before.length - kept.length === 1 ? "y" : "ies"}.`);
    }
  }

  /** Ensure the OKF template note exists and remember its path (called when OKF
   *  is enabled). */
  async ensureOkfTemplate(): Promise<string> {
    const path = await ensureOkfTemplate(this.app, this.settings.okfTemplatePath || undefined);
    if (this.settings.okfTemplatePath !== path) { this.settings.okfTemplatePath = path; await this.saveSettings(); }
    return path;
  }

  /** The OKF template path, defaulting to the standard name when the setting is
   *  empty (e.g. OKF was enabled in an older build before create-on-enable). */
  okfTemplatePathOrDefault(): string {
    return this.settings.okfTemplatePath || OKF_DEFAULT_TEMPLATE_PATH;
  }

  /** Folders the OKF process should ACTUALLY touch: only when OKF is on, only
   *  folders assigned the OKF template, and NEVER archive folders (their whole
   *  point is private-at-rest — OKF would make them browsable/exportable). This
   *  is the single guard every OKF run goes through, so OKF-off / no-folders /
   *  excluded-folders can never accidentally trigger the process. */
  okfActiveFolders(): string[] {
    if (!this.settings.okfEnabled) return [];
    return okfFolders(this.settings.noteTemplates, this.okfTemplatePathOrDefault())
      .filter((f) => !this.isArchiveFolder(f));
  }

  /** Per-folder debounce timers for OKF auto-rebuild. */
  private okfRebuildTimers = new Map<string, number>();
  /** Folders whose OKF frontmatter is being rewritten right now. Stashpad views
   *  on these folders suppress metadata-driven re-renders during the rewrite
   *  (the okf* fields aren't shown in the list) and repaint once when it ends —
   *  otherwise a 25-note split's OKF rebuild repaints the list ~once per note. */
  okfRebuildingFolders = new Set<string>();

  /** Run an OKF rebuild for one folder with render suppression on its views. */
  private async rebuildOkfSuppressed(folder: string): Promise<{ checked: number; written: number }> {
    this.okfRebuildingFolders.add(folder);
    try {
      return await rebuildOkfForFolder(this.app, folder);
    } finally {
      // Short tail so trailing metadata-parse events stay suppressed, then
      // release + repaint the folder's views once.
      window.setTimeout(() => {
        this.okfRebuildingFolders.delete(folder);
        for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
          const v = leaf.view as { noteFolder?: string; forceReconcileRender?: () => void };
          if (v?.noteFolder === folder) v.forceReconcileRender?.();
        }
      }, 600);
    }
  }

  /** A vault file changed (create/delete/rename) — if it's a real note in an
   *  active OKF folder, schedule a debounced rebuild of that folder. Ignores
   *  index.md (our own generated artifact, to avoid a write→event→rebuild loop)
   *  and reserved subfolders. */
  private onOkfFileEvent(path: string): void {
    if (!this.settings.okfEnabled) return;
    if (!path.toLowerCase().endsWith(".md")) return;
    const slash = path.lastIndexOf("/");
    const folder = (slash >= 0 ? path.slice(0, slash) : "").replace(/\/+$/, "");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    if (name === "index.md") return;
    if (/(^|\/)(_imports|_exports|_attachments|_deleted|\.stashpad)(\/|$)/.test(path)) return;
    if (!this.okfActiveFolders().includes(folder)) return;
    this.scheduleOkfRebuild(folder);
  }

  /** Debounced per-folder OKF rebuild (coalesces bursts like imports/resets). */
  private scheduleOkfRebuild(folder: string): void {
    const prev = this.okfRebuildTimers.get(folder);
    if (prev != null) window.clearTimeout(prev);
    this.okfRebuildTimers.set(folder, window.setTimeout(() => {
      this.okfRebuildTimers.delete(folder);
      if (!this.okfActiveFolders().includes(folder)) return; // re-check at fire time
      void this.rebuildOkfSuppressed(folder).catch((e) => console.warn("[Stashpad] OKF auto-rebuild failed", folder, e));
    }, 2500));
  }

  /** Rebuild OKF frontmatter (relative-markdown links + defaults) + index.md for
   *  every active OKF folder. No-op when OKF is off / no folders use the template. */
  async rebuildAllOkf(): Promise<{ folders: number; checked: number; written: number }> {
    const folders = this.okfActiveFolders();
    let checked = 0, written = 0;
    for (const f of folders) { const r = await this.rebuildOkfSuppressed(f); checked += r.checked; written += r.written; }
    return { folders: folders.length, checked, written };
  }

  /** Export the subtree(s) rooted at `rootIds` in `folder` as OKF bundle(s) and/or
   *  a Stashpad .stash, written into the folder's export subfolder. Returns the
   *  paths written. zip/tar.gz are OKF bundles (spec keys mapped, scoped index.md);
   *  .stash is the native round-trip format. Reachable for tests + the command. */
  async exportOkf(folder: string, rootIds: StashpadId[], baseName: string, formats: { zip?: boolean; targz?: boolean; stash?: boolean }): Promise<string[]> {
    const cleaned = folder.replace(/\/+$/, "");
    const rootNotes: { id: StashpadId; file: TFile }[] = [];
    const allDescendants: { id: StashpadId; file: TFile }[] = [];
    const files: TFile[] = [];
    const scopeIds = new Set<string>();
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, cleaned, rid);
      if (!sub) continue;
      rootNotes.push({ id: sub.rootNote.id, file: sub.rootNote.file });
      files.push(sub.rootNote.file); scopeIds.add(sub.rootNote.id);
      for (const d of sub.descendants) { allDescendants.push({ id: d.id, file: d.file }); files.push(d.file); scopeIds.add(d.id); }
    }
    if (!files.length) return [];
    const safe = (baseName || "okf-export").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "okf-export";
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const exportSub = (this.settings.exportFolder || "_exports").trim().replace(/^\/+|\/+$/g, "");
    const exportFolder = `${cleaned}/${exportSub}`;
    for (const seg of [cleaned, exportFolder]) { try { if (!(await this.app.vault.adapter.exists(seg))) await this.app.vault.adapter.mkdir(seg); } catch { /* */ } }
    const written: string[] = [];
    const write = async (name: string, data: Uint8Array) => {
      const path = `${exportFolder}/${name}`;
      await this.app.vault.createBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      written.push(path);
    };
    if (formats.zip || formats.targz) {
      const bundle = await buildOkfBundleFiles(this.app, files, cleaned, scopeIds);
      if (formats.zip) await write(`${safe}-${stamp}.okf.zip`, await zipBundle(bundle));
      if (formats.targz) await write(`${safe}-${stamp}.okf.tar.gz`, await tarGzBundle(bundle));
    }
    if (formats.stash) {
      const buf = await buildStashZip(this.app, { rootNotes, allDescendants, sourceFolder: cleaned });
      await write(`${safe}-${stamp}.${STASH_EXT}`, buf);
    }
    return written;
  }

  /** Ids of the markdown notes living directly in `folder` (read from DISK — the
   *  metadata cache can lag and an under-read here would miss a real id collision
   *  on import). */
  async idsInFolder(folder: string): Promise<Set<StashpadId>> {
    const cleaned = folder.replace(/\/+$/, "");
    const out = new Set<StashpadId>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      try { const id = splitFrontmatter(await this.app.vault.read(f)).fm.id; if (typeof id === "string") out.add(id); } catch { /* skip unreadable */ }
    }
    return out;
  }

  /** 0.201.0: stamp the OS clipboard with the cross-vault payload for a
   *  copy/cut selection — plain text stays as-is, plus a hidden `.stash`-zip
   *  flavor any OTHER vault's Stashpad can paste (see cross-vault-clipboard.ts).
   *  Oversized selections are refused with a modal offering the .stash-file
   *  export instead (clipboards aren't for hundreds of MB of attachments).
   *  Best-effort: any failure just leaves the plain-text clipboard behavior. */
  async stampCrossVaultClipboard(folder: string, rootIds: StashpadId[], mode: "cut" | "copy", plainText: string): Promise<{ status: "ok" | "too-big" | "failed" | "empty"; mb?: string }> {
    try {
      const cleaned = folder.replace(/\/+$/, "");
      const rootNotes: { id: StashpadId; file: TFile }[] = [];
      const allDescendants: { id: StashpadId; file: TFile }[] = [];
      for (const rid of rootIds) {
        const sub = await collectSubtree(this.app, cleaned, rid);
        if (!sub) continue;
        rootNotes.push({ id: sub.rootNote.id, file: sub.rootNote.file });
        for (const d of sub.descendants) allDescendants.push({ id: d.id, file: d.file });
      }
      if (!rootNotes.length) return { status: "empty" };
      const zip = await buildStashZip(this.app, { rootNotes, allDescendants, sourceFolder: cleaned });
      if (zip.length > XV_MAX_BYTES) {
        // 0.201.1: the caller (view) shows the modal and routes to the FULL
        // export modal, so encryption etc. are on the table for big payloads.
        return { status: "too-big", mb: (zip.length / (1024 * 1024)).toFixed(1) };
      }
      const cutToken = mode === "cut" ? this.mintNoteId() + this.mintNoteId() : undefined;
      await writeXvClipboard(plainText, {
        v: 1, mode, sourceVault: this.app.vault.getName(), sourceFolder: cleaned,
        parents: rootNotes.length, children: allDescendants.length,
        ...(cutToken ? { cutToken } : {}),
      }, zip);
      if (cutToken) this.pendingXvCut = { token: cutToken, folder: cleaned, ids: rootIds.slice() };
      return { status: "ok" };
    } catch (e) {
      console.warn("[Stashpad] cross-vault clipboard stamp failed (plain text still copied)", e);
      return { status: "failed" };
    }
  }

  /** 0.201.1: source side of the cross-vault cut handshake. Runs on window
   *  focus: if our pending cut's token is ACKed on the clipboard (the other
   *  vault pasted it), offer — via modal, NOTHING is deleted before the user
   *  confirms — to delete the originals here. Confirm → snapshot-backed,
   *  undoable trash of the cut subtrees. Cancel → the cut resolves as a copy. */
  async checkXvCutAck(): Promise<void> {
    const pending = this.pendingXvCut;
    if (!pending) return;
    const ack = readXvAck();
    if (!ack || ack.token !== pending.token) return;
    // Consume the pending state FIRST so a second focus event can't stack a
    // second modal for the same cut.
    this.pendingXvCut = null;
    const n = pending.ids.length;
    new ConfirmModal(
      this.app,
      "Cut notes pasted in another vault",
      `Vault **${ack.destVault}** received the ${n} cut note${n === 1 ? "" : "s"} (with their subtrees) from **${this.app.vault.getName()}**.\n\n`
      + `Delete the originals from **${this.app.vault.getName()}** now to finish the move into **${ack.destVault}**?\n`
      + `Deleting is undoable here (Undo in the list). Cancel keeps them and the cut becomes a copy.`,
      "Delete the originals",
      (confirmed) => { void (async () => {
        if (!confirmed) { this.clearNoteClipboard(); this.refreshOpenViewsForFolder(pending.folder); return; }
        try {
          const snapPaths = await this.subtreeFilePaths(pending.folder, pending.ids);
          const snap = await this.snapshotPaths(snapPaths);
          const trashed = await this.trashSubtrees(pending.folder, pending.ids);
          this.clearNoteClipboard();
          this.refreshOpenViewsForFolder(pending.folder);
          const noteN = trashed.filter((f) => f.extension === "md").length;
          this.getUndoStack(pending.folder).push({
            label: `Finish cross-vault cut (${noteN} note${noteN === 1 ? "" : "s"})`,
            undo: async () => { await this.restoreSnapshot(snap); this.refreshOpenViewsForFolder(pending.folder); },
            redo: async () => { await this.trashSubtrees(pending.folder, pending.ids); this.refreshOpenViewsForFolder(pending.folder); },
          });
          this.notifications.show({
            message: `Finished the cross-vault cut: removed ${noteN} note${noteN === 1 ? "" : "s"} from **${this.app.vault.getName()}** — they now live in **${ack.destVault}**. Undo restores them here.`,
            kind: "warning", category: "delete", affectedIds: pending.ids, folder: pending.folder, duration: 0,
          });
        } catch (e) {
          console.warn("[Stashpad] cross-vault cut cleanup failed — nothing deleted", e);
          new Notice(boldFragment(`Couldn't delete the cut originals in **${this.app.vault.getName()}** — they're untouched, and the copies in **${ack.destVault}** are unaffected. See console.`));
        }
      })(); },
      "Keep them (copy)",
      true,
      true, // persistent - a stray focus-click must not dismiss the offer (0.201.3)
    ).open();
  }

  /** Cross-folder note paste engine (cut = move, copy = clone). Routes the source
   *  subtree(s) through the `.stash` bundle path so ATTACHMENTS travel into the
   *  destination's `_attachments` folder, then (for a cut) trashes the source
   *  notes and their EXCLUSIVE attachments. Refuses an archive / auto-encrypting
   *  destination — a missing on-device key could strand the move — so that path
   *  is left to the explicit "Move to archive" command (which checks the key
   *  first). Returns the destination root ids, total note count, and reversible
   *  `undo` / `redo` closures (file-level — the caller adds tree rebuild + render).
   *  Undo is snapshot-backed: we capture the created destination files and (for a
   *  cut) the source files BEFORE trashing them, so undo fully restores either
   *  direction. Null on refusal / no-op. */
  async crossFolderPaste(
    srcFolder: string, rootIds: StashpadId[], destFolder: string,
    destParent: StashpadId, mode: "cut" | "copy",
  ): Promise<{ rootIds: StashpadId[]; noteCount: number; undo: () => Promise<void>; redo: () => Promise<void> } | null> {
    const cleanDest = destFolder.replace(/\/+$/, "");
    if (this.isArchiveFolder(cleanDest)) {
      // 0.134.4 (B4): archives default to plaintext now — the block stays (paste
      // bypasses the archive flow entirely) but the copy shouldn't claim encryption.
      new Notice(`"${cleanDest.split("/").pop()}" is an archive folder, so cross-folder paste is disabled there. Use the "Move selection to archive" command instead — it runs the proper archive flow (and encrypts, if that folder encrypts its archive).`);
      return null;
    }
    // Gather source subtree(s) from DISK (authoritative; the source folder's view
    // may be closed, so we can't rely on an in-memory tree).
    const rootNotes: { id: StashpadId; file: TFile }[] = [];
    const allDescendants: { id: StashpadId; file: TFile }[] = [];
    const srcRootOldIds: StashpadId[] = [];
    const srcNoteFiles: TFile[] = [];
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, srcFolder, rid);
      if (!sub) continue;
      srcRootOldIds.push(sub.rootNote.id);
      rootNotes.push({ id: sub.rootNote.id, file: sub.rootNote.file });
      srcNoteFiles.push(sub.rootNote.file);
      for (const d of sub.descendants) { allDescendants.push({ id: d.id, file: d.file }); srcNoteFiles.push(d.file); }
    }
    if (!rootNotes.length) return null;
    const noteCount = rootNotes.length + allDescendants.length;

    // For a CUT, snapshot the source (notes + EXCLUSIVE attachments) BEFORE we
    // touch anything, so undo can recreate it byte-for-byte.
    let srcExclusiveAtts: TFile[] = [];
    let srcSnapshot: FileSnapshot[] = [];
    if (mode === "cut") {
      srcExclusiveAtts = await this.exclusiveAttachmentsOf(srcNoteFiles);
      srcSnapshot = await this.snapshotPaths([...srcNoteFiles.map((f) => f.path), ...srcExclusiveAtts.map((f) => f.path)]);
    }

    // Bundle the subtree (collects referenced attachments) → import into dest
    // (writes attachments into dest/_attachments). Copy → fresh ids; cut → keep
    // ids so the moved notes retain their identity. Roots reparent to the paste
    // target. dedupeExisting:false on purpose — the vault-wide reuse would route
    // the pasted note's attachment link back to the SOURCE folder's copy (and for
    // a cut, that copy then gets trashed → a dangling link). We want the
    // attachment physically in THIS folder's _attachments so the subtree is
    // self-contained. (An identical file already in dest's _attachments is still
    // reused — only the cross-folder reuse is dropped.)
    const zip = await buildStashZip(this.app, { rootNotes, allDescendants, sourceFolder: srcFolder });
    const destExistingIds = await this.idsInFolder(cleanDest);
    const beforePaths = new Set(this.filesUnder(cleanDest));
    const summary = await importStashZip(this.app, zip, cleanDest, destExistingIds, {
      dedupeExisting: false,
      forceNewIds: mode === "copy",
      reparentRootsTo: destParent,
    });
    const createdPaths = this.filesUnder(cleanDest).filter((p) => !beforePaths.has(p));
    const destSnapshot = await this.snapshotPaths(createdPaths);
    const newRootIds = srcRootOldIds.map((old) => summary.idRemap[old]).filter((x): x is StashpadId => !!x);

    // CUT: the notes + attachments now live in dest, so trash the source subtree.
    if (mode === "cut") {
      for (const f of srcNoteFiles) { try { await this.app.fileManager.trashFile(f); } catch (e) { console.warn("[Stashpad] cross-folder move: couldn't trash source note", f.path, e); } }
      for (const f of srcExclusiveAtts) { try { await this.app.fileManager.trashFile(f); } catch (e) { console.warn("[Stashpad] cross-folder move: couldn't trash source attachment", f.path, e); } }
    }

    const removeCreated = async () => {
      for (const p of [...createdPaths].reverse()) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* already gone */ } }
      }
    };
    const undo = mode === "cut"
      ? async () => { await removeCreated(); await this.restoreSnapshot(srcSnapshot); }
      : async () => { await removeCreated(); };
    const redo = mode === "cut"
      ? async () => { await this.restoreSnapshot(destSnapshot); for (const s of srcSnapshot) { const f = this.app.vault.getAbstractFileByPath(s.path); if (f) { try { await this.app.fileManager.trashFile(f); } catch { /* gone */ } } } }
      : async () => { await this.restoreSnapshot(destSnapshot); };

    return { rootIds: newRootIds, noteCount, undo, redo };
  }

  /** Trash (recoverable) the given subtrees in `folder`: every note file plus the
   *  attachments referenced ONLY by those subtrees — shared attachments stay put.
   *  Returns the files it trashed (for the caller's undo snapshot). */
  async trashSubtrees(folder: string, rootIds: StashpadId[]): Promise<TFile[]> {
    const files: TFile[] = [];
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, folder, rid);
      if (!sub) continue;
      files.push(sub.rootNote.file, ...sub.descendants.map((d) => d.file));
    }
    if (!files.length) return [];
    const exclusiveAtts = await this.exclusiveAttachmentsOf(files);
    const trashed: TFile[] = [];
    for (const f of [...files, ...exclusiveAtts]) {
      try { await this.app.fileManager.trashFile(f); trashed.push(f); }
      catch (e) { console.warn("[Stashpad] trashSubtrees: couldn't trash", f.path, e); }
    }
    return trashed;
  }

  /** Attachments referenced ONLY by `noteFiles` (not by any note outside the set).
   *  Exclusivity is read from the live resolvedLinks graph — call while the notes
   *  are still present. */
  async exclusiveAttachmentsOf(noteFiles: TFile[]): Promise<TFile[]> {
    const subtreePaths = new Set(noteFiles.map((f) => f.path));
    const subtreeAtts = new Map<string, TFile>();
    for (const f of noteFiles) for (const af of await resolveNoteAttachmentFiles(this.app, f)) subtreeAtts.set(af.path, af);
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const notePath of Object.keys(resolved)) {
      if (subtreePaths.has(notePath)) continue;
      for (const target of Object.keys(resolved[notePath] ?? {})) subtreeAtts.delete(target); // referenced elsewhere → not exclusive
    }
    return [...subtreeAtts.values()];
  }

  /** Paths of every file (notes + their exclusive attachments) in the given
   *  subtrees — for an undo snapshot taken before trashing. */
  async subtreeFilePaths(folder: string, rootIds: StashpadId[]): Promise<string[]> {
    const files: TFile[] = [];
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, folder, rid);
      if (!sub) continue;
      files.push(sub.rootNote.file, ...sub.descendants.map((d) => d.file));
    }
    if (!files.length) return [];
    const atts = await this.exclusiveAttachmentsOf(files);
    return [...files.map((f) => f.path), ...atts.map((f) => f.path)];
  }

  /** Pre-ordered (parent → children, depth-tagged) nodes of the given subtrees,
   *  read from disk — for building the indented outline of a CROSS-folder cut
   *  pasted into a composer (the source folder's tree isn't loaded in the
   *  destination view). Siblings are ordered by `position` frontmatter (then
   *  `created`) to match the list's visual order. */
  async orderedSubtreeNodes(folder: string, rootIds: StashpadId[]): Promise<Array<{ file: TFile; created: string; depth: number }>> {
    const out: Array<{ file: TFile; created: string; depth: number }> = [];
    const seen = new Set<StashpadId>();
    const posOf = (f: TFile): number => { const v = (this.app.metadataCache.getFileCache(f)?.frontmatter)?.position; return typeof v === "number" ? v : Number.MAX_SAFE_INTEGER; };
    type N = { id: StashpadId; file: TFile; created: string };
    for (const rid of rootIds) {
      const sub = await collectSubtree(this.app, folder, rid);
      if (!sub) continue;
      const childrenOf = new Map<StashpadId, N[]>();
      for (const d of sub.descendants) {
        if (!d.parent) continue;
        const arr = childrenOf.get(d.parent) ?? [];
        arr.push({ id: d.id, file: d.file, created: d.created });
        childrenOf.set(d.parent, arr);
      }
      for (const arr of childrenOf.values()) arr.sort((a, b) => (posOf(a.file) - posOf(b.file)) || a.created.localeCompare(b.created));
      const walk = (node: N, depth: number): void => {
        if (seen.has(node.id)) return; // cycle / overlap guard
        seen.add(node.id);
        out.push({ file: node.file, created: node.created, depth });
        for (const c of childrenOf.get(node.id) ?? []) walk(c, depth + 1);
      };
      walk({ id: sub.rootNote.id, file: sub.rootNote.file, created: sub.rootNote.created }, 0);
    }
    return out;
  }

  /** All file paths under `folder` (notes directly in it + its `_attachments`). */
  filesUnder(folder: string): string[] {
    const prefix = folder.replace(/\/+$/, "") + "/";
    return this.app.vault.getFiles().filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
  }

  /** Capture content for a set of paths (text for `.md`, binary otherwise) so an
   *  undo/redo can recreate them exactly. Missing paths are skipped. */
  async snapshotPaths(paths: string[]): Promise<FileSnapshot[]> {
    const out: FileSnapshot[] = [];
    for (const path of paths) {
      const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
      if (!f) continue;
      const binary = !path.toLowerCase().endsWith(".md");
      try {
        if (binary) out.push({ path, binary, data: await this.app.vault.readBinary(f) });
        else out.push({ path, binary, text: await this.app.vault.read(f) });
      } catch (e) { console.warn("[Stashpad] snapshotPaths: couldn't read", path, e); }
    }
    return out;
  }

  /** Recreate files from a snapshot (parents are created as needed). Overwrites an
   *  existing file at the same path. */
  async restoreSnapshot(snaps: FileSnapshot[]): Promise<void> {
    for (const s of snaps) {
      const dir = s.path.split("/").slice(0, -1).join("/");
      await this.ensureVaultFolder(dir);
      const existing = this.app.vault.getAbstractFileByPath(s.path) as TFile | null;
      try {
        if (s.binary) {
          if (existing) await this.app.vault.adapter.writeBinary(s.path, s.data as ArrayBuffer);
          else await this.app.vault.createBinary(s.path, s.data as ArrayBuffer);
        } else {
          if (existing) await this.app.vault.modify(existing, s.text ?? "");
          else await this.app.vault.create(s.path, s.text ?? "");
        }
      } catch (e) { console.warn("[Stashpad] restoreSnapshot: couldn't write", s.path, e); }
    }
  }

  /** Ensure a (possibly nested) vault folder exists. */
  async ensureVaultFolder(dir: string): Promise<void> {
    if (!dir) return;
    let acc = "";
    for (const seg of dir.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!(await this.app.vault.adapter.exists(acc))) { try { await this.app.vault.createFolder(acc); } catch { /* race / exists */ } }
    }
  }

  /** Rebuild + re-render every open Stashpad view showing `folder` — after an
   *  out-of-band change to its files (e.g. a cross-folder move that removed notes
   *  from the source folder, whose view isn't the one that ran the command). */
  refreshOpenViewsForFolder(folder: string): void {
    const cleaned = folder.replace(/\/+$/, "");
    for (const leaf of this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)) {
      const v = leaf.view as any;
      if ((v?.noteFolder?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      try { v.tree?.rebuild?.(folder); v.render?.(); } catch (e) { console.warn("[Stashpad] refresh view failed", e); }
    }
  }

  /** Batches arrivals per archive folder: each move-in (re)arms a settle timer so
   *  a multi-file move (a whole subtree dragged in) is swept ONCE, after the
   *  re-home debounce (900ms) and metadata indexing have settled. */
  private archivePending = new Map<string, { paths: Set<string>; timer: number }>();

  private maybeArchiveOnMoveIn(file: TFile, oldPath: string): void {
    if (file.extension !== "md") return;
    const newDir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const slash = oldPath.lastIndexOf("/");
    const oldDir = (slash >= 0 ? oldPath.slice(0, slash) : "").replace(/\/+$/, "");
    if (newDir === oldDir) return;                      // in-folder rename, not a move-in
    if (!this.isArchiveFolder(newDir)) return;
    if (!this.encryption.isConfigured()) return;
    let pending = this.archivePending.get(newDir);
    if (!pending) { pending = { paths: new Set(), timer: 0 }; this.archivePending.set(newDir, pending); }
    pending.paths.add(file.path);
    window.clearTimeout(pending.timer);
    pending.timer = window.setTimeout(() => {
      this.archivePending.delete(newDir);
      void this.archiveSweep(newDir, [...pending.paths]);
    }, 1800);
  }

  /** 0.137.2 (retro-apply): when "Encrypt archived notes" turns ON for a
   *  folder, offer to lock the plain notes ALREADY sitting in its archive/
   *  subfolder — the pref used to apply only to future arrivals. Reuses the
   *  proven arrival sweep (root-resolution, key selection, loud-on-locked). */
  async encryptExistingArchiveNotes(folder: string): Promise<number> {
    const sub = archiveSubfolderOf(folder.replace(/\/+$/, ""));
    const plain = this.archivedPlainNotesIn(sub).map((f) => f.path);
    if (plain.length === 0) return 0;
    await this.archiveSweep(sub, plain);
    // Report how many got locked (the sweep may be cancelled at the prompt).
    return plain.length - this.archivedPlainNotesIn(sub).length;
  }

  /** Lock the notes that just arrived in an archive folder. Among the arrivals,
   *  only subtree ROOTS are locked (a child whose parent also arrived rides
   *  inside the parent's bundle). Skips the Home note, already-locked roots, and
   *  anything that disappeared during the settle window. Loud when the vault is
   *  locked and the user declines to unlock — silent failure here would mean
   *  plaintext sitting in a folder the user believes is encrypted. */
  private async archiveSweep(folder: string, arrivedPaths: string[]): Promise<void> {
    // 0.136.0: the one-time subfolder migration re-shelves notes; its moves
    // must NEVER count as "new arrivals to encrypt" (caught in live testing:
    // the sweep mass-encrypted every migrated note).
    if (this.archiveMigrationInFlight) return;
    if (!this.isArchiveFolder(folder)) return; // unmarked while settling
    const cleaned = folder.replace(/\/+$/, "");
    // 0.134.4 (B1): shared resolver — plaintext default, same as the
    // Move-to-archive command (they used to disagree: drag encrypted, command
    // didn't). Encryption is opt-in via "Encrypt archived notes" per folder.
    if (!this.archiveEncryptFor(cleaned)) return;
    type Arr = { id: StashpadId; parent: StashpadId | null };
    const arrived: Arr[] = [];
    for (const p of arrivedPaths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;               // moved away/deleted meanwhile
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== cleaned) continue;
      // Read from DISK, not metadataCache — the cache lags right after a
      // cross-folder move (+ the 900ms re-home rewrite), and a stale/empty read
      // here would SILENTLY skip the note, leaving plaintext in a folder the user
      // believes auto-encrypts. Disk is authoritative.
      let fm: Record<string, unknown>;
      try { fm = splitFrontmatter(await this.app.vault.read(f)).fm; } catch { continue; }
      const id = typeof fm.id === "string" ? fm.id : null;
      if (!id || id === ROOT_ID) continue;
      arrived.push({ id, parent: typeof fm.parent === "string" ? fm.parent : null });
    }
    if (arrived.length === 0) return;
    const arrivedIds = new Set(arrived.map((a) => a.id));
    const alreadyLocked = new Set((this.settings.lockedSubtrees ?? []).map((e) => e.rootId).filter((x): x is StashpadId => !!x));
    const roots = arrived.filter((a) => !alreadyLocked.has(a.id) && !(a.parent && arrivedIds.has(a.parent)));
    if (roots.length === 0) return;
    // 0.143.0: per-folder only — encrypt arriving notes ONLY if this archive folder
    // has its own password. A keyless archive folder just stays plaintext (boring).
    if (!this.encryption.hasFolderKey(cleaned)) return;
    if (!(await this.ensureFolderUnlocked(cleaned))) {
      new Notice(`⚠️ Archive folder "${cleaned.split("/").pop()}": ${roots.length} arriving note${roots.length === 1 ? "" : "s"} NOT encrypted (couldn't unlock the folder password). Unlock it and lock them manually.`, 0);
      return;
    }
    let count = 0;
    for (const r of roots) {
      if (await this.lockNoteSubtree(cleaned, r.id, null, { silent: true })) count++;
    }
    if (count > 0) this.notifications.show({ message: `Archived (encrypted) ${count} note${count === 1 ? "" : "s"} moved into “${cleaned.split("/").pop()}”.`, kind: "success", category: "system", folder: cleaned, actions: [{ label: "All archived", onClick: () => void openAggregateView(this, "archived") }] });
  }

  /** Open a fresh Stashpad tab focused on a specific folder via the
   *  per-leaf folderOverride mechanism. Used by the Authorship settings
   *  section's "folders you've contributed to" list. */
  /** Open `folder` in a NEW Stashpad tab. Returns the leaf so callers can
   *  navigate IT — navigating via `lastActiveStashpadLeaf` right after this
   *  raced the MRU update and could navigate the PREVIOUS tab instead (the
   *  "current tab hijacked into the pinned note + duplicate tab" bug). */
  async activateViewForFolder(folder: string): Promise<WorkspaceLeaf | null> {
    const cleaned = (folder || "").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return null;
    const prev = this.app.workspace.activeLeaf;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: STASHPAD_VIEW_TYPE,
      active: true,
      state: { folderOverride: cleaned },
    });
    this.app.workspace.revealLeaf(leaf);
    settleNewTab(this.app.workspace, prev); // 0.199.0 background-tabs behavior
    return leaf;
  }

  /** Navigate a (possibly still-loading) Stashpad leaf to a note id. */
  navigateLeafTo(leaf: WorkspaceLeaf | null, folder: string, id: StashpadId): void {
    const view = leaf?.view as { navigateTo?: (id: StashpadId) => void; tree?: { get(id: StashpadId): unknown } } | undefined;
    if (view?.navigateTo && (!view.tree || view.tree.get(id))) { view.navigateTo(id); return; }
    this.navigateWhenReady(folder, id);
  }

  /** 0.93.0: open `folder` in Stashpad — reusing an existing Stashpad tab
   *  already on that folder (reveal it) instead of opening a duplicate, else
   *  opening a fresh tab. Backs the file-explorer "Open folder in Stashpad"
   *  context-menu item. */
  async openFolderInStashpad(folder: string): Promise<void> {
    const cleaned = (folder || "").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    // 0.174.0: "Folders always open in a new tab" — skip the reuse-existing-tab
    // path entirely and open a fresh tab at the home note. Propagates to every
    // caller of this method (folders-panel row click, file-explorer menu, …).
    if (this.settings.foldersAlwaysNewTab) { await this.activateViewForFolder(cleaned); return; }
    const existing = await this.findStashpadLeafForFolder(cleaned);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.activateViewForFolder(cleaned);
  }

  /** Find an existing Stashpad leaf showing `folder` — INCLUDING deferred
   *  leaves (Obsidian defers background tabs; their `view` is a stub with no
   *  `noteFolder`, so the old live-view-only check missed them and every
   *  pinned-note / folder click spawned a DUPLICATE tab next to the active
   *  one — the "current tab hijacked + cloned" bug). Deferred matches are
   *  loaded before being returned, so callers can navigate them. */
  private async findStashpadLeafForFolder(folder: string): Promise<WorkspaceLeaf | null> {
    const cleaned = folder.replace(/\/+$/, "");
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    const live = leaves.find((l) => !(l as any).isDeferred && (((l.view as any)?.noteFolder ?? "").replace(/\/+$/, "")) === cleaned);
    if (live) return live;
    const deferred = leaves.find((l) => (l as any).isDeferred
      && ((l.getViewState()?.state as { folderOverride?: string } | undefined)?.folderOverride ?? "").replace(/\/+$/, "") === cleaned);
    if (deferred) {
      try { await (deferred as any).loadIfDeferred?.(); } catch { /* fall through — reveal still works */ }
      return deferred;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 0.269.0: open Stashpad notes IN Stashpad.
  //
  // With the setting on, a Stashpad note that lands in an ordinary editor tab
  // — the quick switcher, a wikilink from another note, the file explorer, a
  // search hit — is taken out of that tab and shown inside Stashpad instead.
  // The point is not having to find your way back to Stashpad after Obsidian's
  // own navigation drops you in the editor.
  //
  // Two problems shape the design, and both are solved structurally rather
  // than by timing, because a timer or a "busy" flag races and the failure
  // mode of a race here is an infinite loop.
  //
  // 1. Stashpad's OWN "Open in Obsidian editor" must still reach the editor.
  //    Every place Stashpad deliberately opens an editor stamps the leaf with
  //    `EDITOR_BYPASS` first, and the interceptor honours that stamp. It is a
  //    property of the leaf, so it holds however many file-open events fire.
  //    A leaf opened by the user is unstamped, so it is intercepted.
  //
  // 2. The interceptor must never fight itself. It closes the leaf it
  //    intercepted; that leaf can never fire again. Redirecting to Stashpad
  //    opens a Stashpad VIEW, not a markdown file, so it never re-enters here.
  //    Third-party switchers all bottom out in the same `file-open` event —
  //    that is what makes this the right hook: it is not tied to any
  //    particular way of opening a note.
  //
  // Not intercepted: notes already open in a tab (switching to an existing
  // editor tab is honoured — closing a tab the user deliberately holds open
  // would be hostile), a leaf that is not the active one (a split or a
  // background tab is a deliberate placement), and non-Stashpad notes.
  // ---------------------------------------------------------------------------

  /** Set on a leaf by every Stashpad-initiated editor open, checked by the
   *  interceptor. Symbol-keyed so it cannot collide with anything Obsidian or
   *  another plugin puts on the leaf. */
  static readonly EDITOR_BYPASS = Symbol.for("stashpad.editorBypass");

  /** Mark a leaf as a deliberate editor open, exempt from interception. Every
   *  Stashpad code path that opens an editor on purpose must call this before
   *  `openFile` — the deep-link `open` action, "Open in Obsidian editor", the
   *  aggregate view, the index builder. */
  markEditorBypass(leaf: WorkspaceLeaf, file: TFile): void {
    const bag = leaf as unknown as Record<symbol, unknown>;
    bag[StashpadPlugin.EDITOR_BYPASS] = true;
    bag[StashpadPlugin.EDITOR_BYPASS_PATH] = file.path;
  }

  private installStashpadNoteRouter(): void {
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) return;
      const isMarkdownLeaf = leaf.view?.getViewType?.() === "markdown";
      // `file-open` carries no leaf, so we read the active one — but that is
      // only trustworthy when it actually DISPLAYS the opened file. On a tab
      // close / focus shift the active leaf is some other tab that merely
      // regained focus, and acting on it closed the wrong tab (0.269.1).
      const shows = (leaf.view as unknown as { file?: TFile } | undefined)?.file;
      const pertains = file instanceof TFile && shows?.path === file.path;

      // Record file-per-leaf on EVERY markdown open, BEFORE any early return.
      // Previously this only ran as the last guard, so a tab Stashpad itself
      // opened (bypass → early return) was never recorded; when its bypass was
      // later cleared, the "already had this file" guard was blind and the tab
      // got routed away and detached. Record first, decide after.
      let hadBefore = false;
      if (pertains && isMarkdownLeaf) hadBefore = this.leafHadFileBefore(leaf, file as TFile);

      if (!this.settings.openNotesInStashpad) return;
      if (!(file instanceof TFile) || file.extension !== "md") return;
      // Only an ordinary editor tab is a candidate. A Stashpad view is where
      // we are sending things, and anything else is a deliberate placement.
      if (!isMarkdownLeaf) return;
      if (!pertains) return;
      if ((leaf as unknown as Record<symbol, boolean>)[StashpadPlugin.EDITOR_BYPASS]) return;
      if (!this.isStashpadNoteFile(file)) return;
      // A tab that was ALREADY showing this note is the user switching to a
      // tab they kept open, not opening the note afresh. Leave it be.
      if (hadBefore) return;
      this.trace("route:note-to-stashpad", { path: file.path });
      // Redirect first, then close. If revealing fails for any reason the tab
      // stays where it is, and the user is not left with nothing open.
      void this.revealNoteInStashpad(file).then(() => {
        // Re-check: the user may have moved on during the await.
        if (leaf.view?.getViewType?.() === "markdown"
          && (leaf.view as unknown as { file?: TFile }).file?.path === file.path) {
          leaf.detach();
        }
      }).catch(() => { /* leave the editor tab open */ });
    }));
    // Clear a bypass stamp once the leaf's file changes away from the one it
    // was opened on. Done on file-open rather than on a timer, so it is exact.
    //
    // 0.269.1: this used to fire on ANY file-open while the stamped leaf merely
    // happened to be active — including `file-open` with NO file (which Obsidian
    // emits when a tab closes). That stripped the bypass from a tab Stashpad had
    // deliberately opened, and the router then closed it. Clear only when this
    // leaf genuinely moved to a DIFFERENT file of its own.
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (!(file instanceof TFile)) return; // a fileless open is not "moved away"
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) return;
      const bag = leaf as unknown as Record<symbol, unknown>;
      if (!bag[StashpadPlugin.EDITOR_BYPASS]) return;
      // The event must pertain to THIS leaf — i.e. it is the tab now showing it.
      const shows = (leaf.view as unknown as { file?: TFile } | undefined)?.file;
      if (shows?.path !== file.path) return;
      const stampedFor = bag[StashpadPlugin.EDITOR_BYPASS_PATH];
      if (typeof stampedFor === "string" && stampedFor !== file.path) {
        delete bag[StashpadPlugin.EDITOR_BYPASS];
        delete bag[StashpadPlugin.EDITOR_BYPASS_PATH];
      }
    }));
  }

  /** The bypass is tied to the file it was granted for, so a wikilink followed
   *  from a bypassed tab is routed like any other open. */
  static readonly EDITOR_BYPASS_PATH = Symbol.for("stashpad.editorBypassPath");

  /** Did this leaf already hold `file` before the current open? Tracked
   *  per-leaf so "switch to a tab I left open" is distinguishable from "open
   *  this note in a tab that had something else". */
  private lastFileByLeaf = new WeakMap<WorkspaceLeaf, string>();
  private leafHadFileBefore(leaf: WorkspaceLeaf, file: TFile): boolean {
    const prev = this.lastFileByLeaf.get(leaf);
    this.lastFileByLeaf.set(leaf, file.path);
    return prev === file.path;
  }

  /** 0.76.19: true when `file` is a Stashpad note — lives in a known
   *  Stashpad folder AND has an `id` in frontmatter. */
  private isStashpadNoteFile(file: TFile): boolean {
    const dir = file.parent?.path?.replace(/\/+$/, "") ?? "";
    if (!this.discoverStashpadFolders().includes(dir)) return false;
    const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
    return typeof id === "string" && id.length > 0;
  }

  /** 0.76.19: focus `file`'s note inside Stashpad. Reuses an open
   *  Stashpad tab already on that folder (reveals + navigates it);
   *  otherwise opens a fresh tab on the folder, then navigates to the
   *  note's id. */
  async revealNoteInStashpad(file: TFile): Promise<void> {
    const folder = file.parent?.path?.replace(/\/+$/, "") ?? "";
    const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
    if (!folder || typeof id !== "string" || !id) {
      new Notice("That note isn't a Stashpad note.");
      return;
    }
    await this.revealNoteByRef(folder, id);
  }

  /** 0.256.0: the jump button for an adoption notification.
   *
   *  Adopting a note leaves it somewhere the user wasn't looking — that is the
   *  whole point of adoption — so the notification needs to be able to take
   *  them there. One note: open that note. Several: open the note they were all
   *  adopted UNDER, which for an orphan fix is the folder's home note (adoption
   *  sets `parent` to ROOT_ID).
   *
   *  A batch can span folders, and there is no single parent then. Rather than
   *  drop the button or pick a folder silently, it targets the folder with the
   *  most adopted notes and NAMES it in the label, so the button never lands
   *  somewhere the label didn't promise.
   *
   *  Returns [] when there's nothing to open — a button that can't resolve a
   *  target is worse than no button. */
  adoptionJumpActions(files: TFile[]): NotificationAction[] {
    // Only offer a jump for notes that actually live in a Stashpad folder.
    // `adoptNote` can be run on the active note wherever it sits, and a button
    // that opens a Stashpad view onto a folder that isn't one is worse than no
    // button at all.
    const stashpadFolders = new Set(this.discoverStashpadFolders().map((f) => f.replace(/\/+$/, "")));
    const usable = files.filter((f) =>
      f instanceof TFile && stashpadFolders.has(f.parent?.path?.replace(/\/+$/, "") ?? ""));
    if (usable.length === 0) return [];
    if (usable.length === 1) {
      const file = usable[0];
      return [{
        label: "Open note",
        onClick: () => { void this.revealNoteInStashpad(file); },
      }];
    }
    const byFolder = new Map<string, number>();
    for (const f of usable) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (dir) byFolder.set(dir, (byFolder.get(dir) ?? 0) + 1);
    }
    if (byFolder.size === 0) return [];
    let target = "";
    let best = -1;
    for (const [dir, n] of byFolder) if (n > best) { target = dir; best = n; }
    const spansFolders = byFolder.size > 1;
    const leaf = target.slice(target.lastIndexOf("/") + 1);
    return [{
      label: spansFolders ? `Open ${leaf} home` : "Open home",
      onClick: () => { void this.revealNoteByRef(target, ROOT_ID); },
    }];
  }

  /** 0.174.0: Stashpad notes (in a discovered folder, with an id) that reference
   *  `attachment` — either via a body embed/link (metadataCache.resolvedLinks)
   *  or via the canonical `attachments` frontmatter array. Deduped, folder order.
   *  Backs "Open in Stashpad" on a non-md attachment file. */
  findStashpadNotesEmbedding(attachment: TFile): TFile[] {
    const target = attachment.path;
    // PERF: iterate metadataCache.resolvedLinks (only notes that link to
    // ANYTHING, keyed lookups) instead of scanning every markdown file with a
    // getFileCache + getFirstLinkpathDest per note. resolvedLinks captures body
    // `![[attachment]]` embeds/links — how attachments are referenced — which is
    // the case Stashpad notes use (an added attachment is body-embedded). This is
    // O(linked notes) cheap lookups; the old scan hung on large vaults.
    const resolved = this.app.metadataCache.resolvedLinks || {};
    const out: TFile[] = [];
    for (const src of Object.keys(resolved)) {
      if (!resolved[src][target]) continue;
      const f = this.app.vault.getAbstractFileByPath(src);
      if (f instanceof TFile && this.isStashpadNoteFile(f)) out.push(f);
    }
    return out;
  }

  /** 0.174.0: "Open in Stashpad" for a non-md attachment — reveal the Stashpad
   *  note that embeds it. If several notes embed the same file, pick one from a
   *  list of the parent notes. `preNotes` avoids a second scan when the caller
   *  (the menu builder) already computed the matches. */
  async revealAttachmentInStashpad(file: TFile, preNotes?: TFile[]): Promise<void> {
    const notes = preNotes ?? this.findStashpadNotesEmbedding(file);
    if (notes.length === 0) { new Notice("No Stashpad note references this attachment."); return; }
    if (notes.length === 1) { await this.revealNoteInStashpad(notes[0]); return; }
    new AttachmentParentPicker(this.app, notes, (note) => void this.revealNoteInStashpad(note)).open();
  }

  /** Open a note by folder+id: REUSE an existing Stashpad tab on that folder
   *  (deferred ones included) and navigate it; only open a NEW tab when there
   *  isn't one. The single entry point for every "jump to this note" click —
   *  file reveals AND pinned/shared/task panel rows — so they all behave the
   *  same (0.99.2: unified; the Pinned panel used to always open a new tab). */
  async revealNoteByRef(folder: string, id: StashpadId): Promise<void> {
    const clean = folder.replace(/\/+$/, "");
    const existing = await this.findStashpadLeafForFolder(clean);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      // Focus follows the click — revealLeaf alone leaves the old tab active.
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      this.navigateLeafTo(existing, clean, id);
      return;
    }
    // 0.86.4: the freshly-opened view may still be loading its tree —
    // navigateLeafTo polls until ready, so it opens in ONE click instead of
    // landing on Home and navigating only on the second.
    const leaf = await this.activateViewForFolder(clean);
    this.navigateLeafTo(leaf, clean, id);
  }

  /** 0.171.0: open the due-date / assignee scheduler for a task referenced by
   *  folder + id — backs the due-reminder toast's Snooze control. Reveals the
   *  note in its Stashpad view first (so undo + authorship bind to that view
   *  and the user sees the task), then opens the scheduler on that node. */
  async openSchedulerForRef(folder: string, id: StashpadId): Promise<void> {
    await this.revealNoteByRef(folder, id);
    const clean = folder.replace(/\/+$/, "");
    const leaf = await this.findStashpadLeafForFolder(clean);
    const view = leaf?.view;
    if (view instanceof StashpadView) {
      view.cmdSetDue(view.tree.get(id));
    } else {
      new Notice("Couldn’t open the scheduler for that task.");
    }
  }

  /** Resolve a note's frontmatter `id` → its TFile within `folder` (direct
   *  children only — matches Stashpad's one-folder-per-view model). Returns
   *  null if no note in that folder carries the id. */
  resolveNoteFileInFolder(folder: string, id: string): TFile | null {
    const dir = folder.replace(/\/+$/, "");
    for (const f of this.app.vault.getMarkdownFiles()) {
      if ((f.parent?.path?.replace(/\/+$/, "") ?? "") !== dir) continue;
      if (this.app.metadataCache.getFileCache(f)?.frontmatter?.id === id) return f;
    }
    return null;
  }

  /** Handle an `obsidian://stashpad?…` deep link. Resolve → activate → reveal →
   *  run macro. Any unresolved target is a LOUD failure (Notice), never a silent
   *  no-op. See `docs/deep-links-plan.md`. */
  async handleDeepLink(params: { folder?: string; note?: string; run?: string; action?: string; vault?: string }, opts: { forceNewTab?: boolean; silent?: boolean } = {}): Promise<boolean> {
    const folder = (params.folder || "").replace(/^\/+|\/+$/g, "");
    const noteId = (params.note || "").trim();
    const actions = parseRunActions(params);
    const fail = (msg: string): boolean => { if (!opts.silent) new Notice(msg); return false; };

    // 1. Guard + resolve. Returns false (not thrown) on a bad link so a batch
    // caller can tally how many actually opened. `silent` suppresses the Notice
    // when the caller intends to hand off / report a tally instead.
    if (!folder) return fail("Stashpad link: missing “folder”.");
    const dir = this.app.vault.getAbstractFileByPath(folder);
    if (!(dir instanceof TFolder)) return fail(`Stashpad link: folder “${folder}” not found.`);

    // 2. Wait for the workspace to settle. On a cross-vault jump Obsidian may
    // still be laying out when the handler fires, so activate/reveal would find
    // no leaf to mount into. onLayoutReady fires immediately if already ready
    // (the common same-vault path), so this is a no-op there.
    await new Promise<void>((resolve) => this.app.workspace.onLayoutReady(() => resolve()));

    let file: TFile | null = null;
    if (noteId) {
      // On a cross-vault cold start the metadata cache may not have parsed
      // frontmatter yet (onLayoutReady doesn't wait for it), so a note that
      // DOES exist can momentarily look absent. Retry briefly before failing
      // loudly — same-vault (warm cache) resolves on the first try.
      for (let i = 0; i < 12 && !file; i++) {
        file = this.resolveNoteFileInFolder(folder, noteId);
        if (!file) await new Promise((r) => window.setTimeout(r, 150));
      }
      if (!file) return fail(`Stashpad link: note “${noteId}” not found in ${folder}.`);
    }

    // 3. Open the target WITHOUT hijacking the current tab. A deep link should
    // land in its own tab (focusing an existing background tab on that folder
    // if there is one), never overwrite whatever the user is currently viewing.
    // `forceNewTab` (batch/multi-link) always opens a fresh tab per link.
    await this.openDeepLinkTarget(folder, noteId, opts);

    // 4. Run the macro, in order. `reveal` is already satisfied by step 3.
    // Unknown tokens are skipped with a warning — one bad token never aborts.
    for (const token of actions) {
      if (token === "reveal") continue;
      if (token === "open") {
        // A deep link that asks for the EDITOR gets the editor, routing or not.
        if (file) {
          const leaf = this.app.workspace.getLeaf("tab");
          this.markEditorBypass(leaf, file);
          await leaf.openFile(file);
        }
        continue;
      }
      console.warn(`[stashpad] deep link: unknown action “${token}” — skipped.`);
    }
    return true;
  }

  /** Open a deep-link target without hijacking the currently-active tab.
   *  Unlike `revealNoteByRef` (which reuses ANY matching folder tab, the active
   *  one included), a deep link should never overwrite what the user is looking
   *  at: focus an existing BACKGROUND tab on that folder if there is one, else
   *  open a brand-new tab. `noteId` is optional (folder-only links). */
  async openDeepLinkTarget(folder: string, noteId: string, opts: { forceNewTab?: boolean } = {}): Promise<void> {
    const clean = folder.replace(/\/+$/, "");
    // 0.155.3: `forceNewTab` skips the reuse-existing-tab path so a BATCH of
    // links (multi-link paste) opens each in its own tab — even several links
    // into the same folder, which would otherwise collapse onto one reused tab.
    if (!opts.forceNewTab) {
      const active = this.app.workspace.activeLeaf;
      const existing = await this.findStashpadLeafForFolder(clean);
      // Reuse an existing tab only if it isn't the one currently in front —
      // reusing the active leaf is exactly the "opens inside it" overwrite.
      if (existing && existing !== active) {
        this.app.workspace.revealLeaf(existing);
        this.app.workspace.setActiveLeaf(existing, { focus: true });
        if (noteId) this.navigateLeafTo(existing, clean, noteId);
        return;
      }
    }
    const leaf = await this.activateViewForFolder(clean); // getLeaf("tab") → new tab
    if (noteId) this.navigateLeafTo(leaf, clean, noteId);
  }

  /** Prompt for a pasted `obsidian://stashpad?…` link and open it — the manual
   *  path for apps that won't hyperlink `obsidian://` URLs. Same routing as a
   *  clicked link (`handleDeepLink`), so folder/note resolution + loud failures
   *  are shared. */
  openDeepLinkModal(): void {
    new OpenDeepLinkModal(this.app, (raw) => {
      // 0.155.3: accept a MULTI-link paste (e.g. from a multi-select "Copy
      // Stashpad link"). Links are whitespace/newline-separated and never
      // contain literal spaces (URLs are percent-encoded), so split on \s+.
      const candidates = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      const items = candidates
        .map((c) => ({ raw: c, parsed: parseStashpadLink(c) }))
        .filter((x): x is { raw: string; parsed: NonNullable<ReturnType<typeof parseStashpadLink>> } => !!x.parsed);
      if (items.length === 0) { new Notice("That doesn't look like a Stashpad link."); return; }
      void this.openDeepLinks(items);
    }).open();
  }

  /** 0.181.0: open a batch of parsed Stashpad links. A link that targets a
   *  DIFFERENT vault (or can't be resolved locally) is handed off to Obsidian's
   *  own protocol handler — which opens/switches to the right vault — instead of
   *  failing. Hand-offs are staggered so Obsidian routes each cleanly rather than
   *  clobbering one tab repeatedly; locally-opened links keep their own tabs. */
  private async openDeepLinks(items: Array<{ raw: string; parsed: NonNullable<ReturnType<typeof parseStashpadLink>> }>): Promise<void> {
    const myVault = this.app.vault.getName();
    const multi = items.length > 1;
    let opened = 0, handedOff = 0, notFound = 0;
    for (const { raw, parsed } of items) {
      // Cross-vault link → let Obsidian open it (it switches vaults). Don't try
      // locally (the folder isn't in THIS vault).
      if (parsed.vault && parsed.vault !== myVault) {
        this.handOffToObsidian(raw);
        handedOff++;
        await new Promise((r) => window.setTimeout(r, 350)); // stagger so Obsidian routes each
        continue;
      }
      const ok = await this.handleDeepLink(parsed, { forceNewTab: multi, silent: true });
      if (ok) { opened++; continue; }
      // Resolved to THIS vault but not found. If the link names a vault (this one)
      // there's nothing more to try; if it names ANOTHER, we already handed off.
      // A vault-less miss is a genuine not-found — report it.
      notFound++;
    }
    const parts: string[] = [];
    if (opened) parts.push(`opened ${opened}`);
    if (handedOff) parts.push(`sent ${handedOff} to Obsidian (other vault)`);
    if (notFound) parts.push(`${notFound} not found`);
    new Notice(`Stashpad link${items.length === 1 ? "" : "s"}: ${parts.join(" · ") || "nothing to open"}.`);
  }

  /** Hand a raw `obsidian://…` URL to Obsidian's own protocol handling (via the
   *  OS), so it opens/switches to the vault named in the link. Electron shell
   *  first; window.open as a fallback. */
  private handOffToObsidian(rawUrl: string): void {
    try {
      const shell = (window as unknown as { require?: (m: string) => { shell?: { openExternal?: (u: string) => Promise<void> } } }).require?.("electron")?.shell;
      if (shell?.openExternal) { void shell.openExternal(rawUrl); return; }
    } catch { /* fall through */ }
    try { window.open(rawUrl); } catch { /* ignore */ }
  }

  /** Tidy Stashpad tabs: PRUNE orphans (focused on a note that no longer
   *  exists) + collapse DUPLICATES (same folder + focused note). Returns the
   *  total tabs closed and shows a multi-line summary tally (7s).
   *
   *  Orphan detection reads the vault file list (deferred tabs checked without
   *  waking; a loaded tab whose own tree still has the note is spared). Dedupe
   *  keys on folder + `focusId` from each leaf's SERIALIZED state, so two tabs
   *  on the same folder but DIFFERENT notes are intentional and both kept. The
   *  keeper is active > loaded > deferred but WOKEN + verified healthy first, so
   *  a corrupt tab is never the survivor when a healthy one exists. */
  async closeDuplicateStashpadTabs(): Promise<number> {
    const leaves = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE);
    const active = this.app.workspace.activeLeaf;

    // Warm up EVERY tab first so the dedupe/orphan checks run against live views
    // (real noteFolder/focusId, not just serialized state) and any tab that
    // can't initialize surfaces as unhealthy here rather than being kept blind.
    for (const l of leaves) {
      try { await (l as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.(); } catch { /* corrupt — handled by the healthy() check */ }
    }

    const stateOf = (l: WorkspaceLeaf) => (l.getViewState()?.state ?? {}) as { folderOverride?: string; focusId?: string };
    const folderOf = (l: WorkspaceLeaf): string => {
      const st = stateOf(l);
      return ((l as any).isDeferred ? (st.folderOverride ?? "") : ((l.view as any)?.noteFolder ?? st.folderOverride ?? "")).replace(/\/+$/, "");
    };
    const focusOf = (l: WorkspaceLeaf): string => {
      const st = stateOf(l);
      return ((l as any).isDeferred ? st.focusId : ((l.view as any)?.focusId ?? st.focusId)) || ROOT_ID;
    };
    const healthy = (l: WorkspaceLeaf): boolean => {
      const v = l.view as { getViewType?: () => string; navigateTo?: unknown; noteFolder?: unknown } | undefined;
      return !!v && v.getViewType?.() === STASHPAD_VIEW_TYPE && typeof v.navigateTo === "function" && typeof v.noteFolder === "string";
    };

    // Existing note ids per folder, for orphan detection (no tab waking needed).
    const idsByFolder = new Map<string, Set<string>>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const folder = (f.parent?.path ?? "").replace(/\/+$/, "");
      const id = (this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" && id) (idsByFolder.get(folder) ?? idsByFolder.set(folder, new Set()).get(folder)!).add(id);
    }

    // Pass 1 - prune orphans: a tab focused on a note that no longer exists
    // (deleted note, or its whole folder gone). Root-focused tabs are never
    // orphans. Closing a tab is non-destructive, so cache lag at worst closes a
    // reopenable tab - and a loaded tab whose tree still has the note is spared.
    let pruned = 0;
    const survivors: WorkspaceLeaf[] = [];
    for (const l of leaves) {
      const folder = folderOf(l);
      const focus = focusOf(l);
      if (folder && focus && focus !== ROOT_ID) {
        const loadedHas = !(l as any).isDeferred && !!(l.view as any)?.tree?.get?.(focus);
        const cacheHas = idsByFolder.get(folder)?.has(focus) ?? false;
        if (!loadedHas && !cacheHas) { l.detach(); pruned++; continue; }
      }
      survivors.push(l);
    }

    // Pass 2 - collapse duplicates (same folder + focused note) among survivors.
    const groups = new Map<string, WorkspaceLeaf[]>();
    for (const l of survivors) {
      const folder = folderOf(l);
      if (!folder) continue;
      const k = folder + " " + focusOf(l);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(l);
    }
    let closed = 0;
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => {
        const score = (l: WorkspaceLeaf) => (l === active ? 2 : (!(l as any).isDeferred ? 1 : 0));
        return score(b) - score(a);
      });
      // Wake candidates in rank order until one is a working Stashpad view.
      let keeper: WorkspaceLeaf | null = null;
      for (const cand of group) {
        try { await (cand as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.(); } catch { /* try next */ }
        if (healthy(cand)) { keeper = cand; break; }
      }
      if (!keeper) keeper = group[0]; // all unhealthy - keep best-ranked anyway
      for (const l of group) { if (l !== keeper) { l.detach(); closed++; } }
    }

    // Multi-line summary tally, lingering a few seconds so it's readable.
    const remaining = this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE).length;
    const frag = document.createDocumentFragment() as unknown as { createEl: (t: string, o?: { text?: string }) => HTMLElement };
    frag.createEl("div", { text: closed + pruned > 0 ? "Stashpad tabs cleaned up:" : "Stashpad tabs - nothing to clean up:" });
    frag.createEl("div", { text: `\u2022  ${closed} duplicate tab${closed === 1 ? "" : "s"} closed` });
    frag.createEl("div", { text: `\u2022  ${pruned} orphaned tab${pruned === 1 ? "" : "s"} pruned (note no longer exists)` });
    frag.createEl("div", { text: `\u2022  ${remaining} Stashpad tab${remaining === 1 ? "" : "s"} remaining` });
    new Notice(frag as unknown as DocumentFragment, 7000);
    return closed + pruned;
  }

  /** Poll briefly for the folder's Stashpad view to have `id` in its tree, then
   *  navigate. One-click open for a not-yet-open folder. */
  private navigateWhenReady(folder: string, id: string, attempts = 15): void {
    const clean = folder.replace(/\/+$/, "");
    const view = (this.app.workspace.getLeavesOfType(STASHPAD_VIEW_TYPE)
      .find((l) => (((l.view as any)?.noteFolder ?? "").replace(/\/+$/, "")) === clean)?.view
      ?? this.lastActiveStashpadLeaf?.view) as any;
    if (view && typeof view.navigateTo === "function") {
      const treeReady = !view.tree || typeof view.tree.get !== "function" || !!view.tree.get(id);
      if (treeReady) { view.navigateTo(id); return; }
    }
    if (attempts > 0) {
      window.setTimeout(() => this.navigateWhenReady(folder, id, attempts - 1), 90);
    } else if (view && typeof view.navigateTo === "function") {
      view.navigateTo(id); // last resort — navigate anyway
    }
  }

  /** Walk vault markdown frontmatter for notes whose author or
   *  contributors list contains this user's authorId. Group results by
   *  Stashpad folder root and return them sorted by activity (authored
   *  + contributed count, descending). Surfaced in settings so the
   *  user can jump to any Stashpad they've worked in. */
  collectAuthoredFolders(): Array<{ folder: string; authored: number; contributed: number }> {
    const id = (this.settings.authorId ?? "").trim();
    if (!id) return [];
    const idTag = `-${id}`;
    const stashpads = this.discoverStashpadFolders();
    const map = new Map<string, { authored: number; contributed: number }>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
      if (!fm) continue;
      const author = typeof fm.author === "string" ? fm.author : "";
      const contributors: string[] = Array.isArray(fm.contributors)
        ? fm.contributors.filter((c: any) => typeof c === "string")
        : [];
      const isAuthored = author.includes(idTag);
      const isContributor = contributors.some((c) => c.includes(idTag));
      if (!isAuthored && !isContributor) continue;
      const dir = file.parent?.path ?? "";
      const root = stashpads.find((f) => dir === f || dir.startsWith(f + "/"));
      if (!root) continue;
      if (!map.has(root)) map.set(root, { authored: 0, contributed: 0 });
      const e = map.get(root)!;
      if (isAuthored) e.authored++;
      if (isContributor) e.contributed++;
    }
    return [...map.entries()]
      .map(([folder, counts]) => ({ folder, ...counts }))
      .sort((a, b) => (b.authored + b.contributed) - (a.authored + a.contributed));
  }

  /** Parse an author wikilink → {id,name}. Delegates to the shared
   *  helper in types.ts (kept as a thin method so existing call sites and
   *  subclasses keep working). */
  private parseAuthorRef(raw: string): { id: string; name: string } | null {
    return parseAuthorRef(raw);
  }

  /** 0.78.1: build the wikilink Stashpad writes for an arbitrary author
   *  (used by task assignment + the local-user author stamp). Mirrors the
   *  view's currentAuthorLink shape but for any {id,name}, resolved into
   *  the given Stashpad folder's _authors dir. The alias is stripped of
   *  link-structural chars (see security-findings.md). */
  authorRefFor(folder: string, id: string, name: string): string {
    const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "author";
    const path = `${folder.replace(/\/+$/, "")}/_authors/${safe}-${id}.md`;
    const aliasSafe = name.replace(/[\[\]|]/g, "").trim() || safe;
    return `[[${path}|${aliasSafe}]]`;
  }

  /** 0.78.1: ensure an author stub exists for {id,name} in `folder`,
   *  creating it from the registry's known role/department if available.
   *  Used when assigning a task to someone so the assignee wikilink
   *  resolves. No-op if a stub for this id already exists in the dir
   *  (under any name). Also registers the author. */
  async ensureAuthorStubFor(folder: string, id: string, name: string): Promise<boolean> {
    if (!id || !name) return false;
    this.authorRegistry.record({ id, name });
    const dir = `${folder.replace(/\/+$/, "")}/_authors`;
    const exists = this.app.vault.getMarkdownFiles().some(
      (f) => f.path.startsWith(dir + "/") && this.parseAuthorFilePath(f.path)?.id === id,
    );
    if (exists) return false;
    const rec = this.authorRegistry.get(id);
    const safe = this.authorNameToSafe(name);
    const path = `${dir}/${safe}-${id}.md`;
    try {
      await this.ensureFolderPath(dir);
      if (await this.app.vault.adapter.exists(path)) return false;
      await this.app.vault.create(path, this.buildAuthorStub(
        { id, name, role: rec?.role, department: rec?.department },
        new Date().toISOString(),
      ));
      return true;
    } catch (e) {
      console.warn("[Stashpad] ensureAuthorStubFor failed", path, e);
      return false;
    }
  }

  /** 0.99.17 (#2): seed EVERY known author (vault-wide) into `folder`'s
   *  `_authors/`, not just the local user — so a new folder auto-populates with
   *  coworkers and assignment works without waiting for them to contribute. Each
   *  stub reuses the author's real id. Returns how many stubs were created. */
  async seedKnownAuthorsInFolder(folder: string): Promise<number> {
    let created = 0;
    for (const a of this.collectKnownAuthors()) {
      if (await this.ensureAuthorStubFor(folder, a.id, a.name)) created++;
    }
    return created;
  }

  /** 0.99.19: Task due-date reminders. Obsidian plugins can't fire while the app
   *  is closed, so this runs at LAUNCH (onLayoutReady) and on an interval while
   *  running: it finds tasks whose `due` has passed and that haven't been
   *  reminded yet (tracked by `<id>@<dueRaw>` in settings.notifiedDueKeys, so the
   *  same task+due never re-fires — a changed due date re-keys and reminds again),
   *  shows a PERSISTENT notification under the "reminder" category (so it lands in
   *  the history log + respects mute), then records it. */
  /** 0.140.0: resolve an "un-failable" task that's past due by its grace.
   *  Repeating → roll due forward (stays active); one-off → mark complete. */
  private async autoResolveDueTask(f: TFile, _dueMs: number, now: number): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(f, (fm) => {
        // 0.140.1: re-read `due` INSIDE the callback — the metadataCache dueMs
        // the caller passed can be stale (a concurrent sweep / another device
        // may have just rolled it), which would re-roll from the wrong anchor
        // and skip/duplicate a cycle.
        const curDue = fm.due != null ? Date.parse(String(fm.due)) : NaN;
        if (Number.isFinite(curDue) && curDue > now) return; // already rolled forward — done
        const rec = parseRecurrence(fm.repeat as string | undefined);
        if (rec) { fm.due = new Date(nextDueOnComplete(rec, Number.isFinite(curDue) ? curDue : null, now)).toISOString(); delete fm.completed; }
        else fm.completed = true;
      });
    } catch (e) { console.warn("[Stashpad] auto-resolve failed", f.path, e); }
  }

  async checkDueReminders(): Promise<void> {
    const now = Date.now();
    const notified = new Set(this.settings.notifiedDueKeys ?? []);
    const myId = (this.settings.authorId ?? "").trim();
    const due: Array<{ id: string; folder: string; file: TFile; dueMs: number; key: string }> = [];
    // 0.140.0: persistent-reminder re-fire bookkeeping (id → last-notified ms).
    const persistLog = { ...(this.settings.persistReminderLog ?? {}) };
    let persistDirty = false;
    const activePersistIds = new Set<string>(); // 0.140.1: for pruning the log
    let missedRolled = 0; // 0.197.0: interval-mode occurrences closed out as missed
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.includes("/_authors/")) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: unknown; due?: unknown; completed?: unknown; repeat?: unknown; autoDoneAfter?: unknown; remindEvery?: unknown } | undefined;
      if (!fm || fm.due == null) continue;
      const id = typeof fm.id === "string" ? fm.id : "";
      if (!id) continue;
      const dueRaw = String(fm.due);
      const dueMs = typeof fm.due === "number" ? fm.due : Date.parse(dueRaw);
      if (!Number.isFinite(dueMs) || dueMs > now) continue; // not due yet

      // 0.140.0: auto-complete-after ("un-failable" tasks) — once past due by
      // the configured grace, resolve WITHOUT reminding. A repeating task rolls
      // forward; a one-off just gets marked complete. Runs before assignee
      // scoping so it applies regardless of who'd be reminded.
      if (fm.completed !== true) {
        const grace = parseDuration(fm.autoDoneAfter as string | undefined);
        if (grace != null && now >= dueMs + grace) {
          await this.autoResolveDueTask(f, dueMs, now);
          continue;
        }
      }
      // 0.197.0: repeatMode "interval" — a new occurrence every interval whether or
      // not the last was finished. Once THIS occurrence's window has elapsed, close
      // it out flagged as missed and spawn the next, so the list shows what was
      // skipped instead of one note quietly sliding forward.
      if (fm.completed !== true) {
        const mode = parseRepeatMode((fm as { repeatMode?: unknown }).repeatMode);
        const recI = mode === "interval" ? parseRecurrence(fm.repeat as string | undefined) : null;
        if (recI) {
          const windowEnd = recI.next(dueMs);
          if (now >= windowEnd) {
            // 0.211.6 (L10): claim the roll atomically against the FILE, not the
            // lagging cache — otherwise two sweeps in the cache-lag window both spawn
            // a successor and the user gets duplicate tasks.
            if (!(await claimOccurrenceMissed(this.app, f, now))) continue;
            // Anchor the next occurrence to the schedule, not to "now", so a task
            // ignored for weeks lands back on its real cadence rather than drifting.
            let nextMs = windowEnd;
            let guard = 0;
            while (nextMs <= now && guard++ < 500) nextMs = recI.next(nextMs);
            await spawnNextOccurrence(this.app, f, new Date(nextMs).toISOString(), () => this.mintNoteId());
            missedRolled++;
            continue;
          }
        }
      }
      if (fm.completed === true) continue; // completed one-offs: nothing to do

      const assignees = parseAssignees(fm);
      if (assignees.length > 0 && !(myId && assignees.some((a) => a.id === myId))) continue;

      // 0.140.0: persistent reminders re-fire every `remindEvery` until done —
      // otherwise the once-per-(id@due) key suppresses repeats.
      const every = parseDuration(fm.remindEvery as string | undefined);
      if (every != null) {
        activePersistIds.add(id);
        const last = persistLog[id] ?? 0;
        if (now - last >= every) {
          persistLog[id] = now; persistDirty = true;
          due.push({ id, folder: (f.parent?.path ?? "").replace(/\/+$/, ""), file: f, dueMs, key: `${id}@persist` });
        }
        continue; // persistent tasks bypass the once-only key path
      }

      const key = `${id}@${dueRaw}`;
      if (notified.has(key)) continue;
      due.push({ id, folder: (f.parent?.path ?? "").replace(/\/+$/, ""), file: f, dueMs, key });
    }
    // 0.140.1: actually prune the persist log (the old code only wrote it back)
    // — drop ids that are no longer a live persistent+due task, so it can't grow
    // unbounded after tasks complete/lose remindEvery.
    for (const kId of Object.keys(persistLog)) if (!activePersistIds.has(kId)) { delete persistLog[kId]; persistDirty = true; }
    if (persistDirty) { this.settings.persistReminderLog = persistLog; await this.saveSettings(); }
    if (due.length === 0) return;
    // Record up front so the interval / a fast re-entry can't double-fire.
    // 0.140.1: EXCLUDE `@persist` keys — they're never read back (the persist
    // path bypasses `notified`), so appending them just churned the 2000-cap
    // ring and evicted legit `id@due` keys (→ old past-due one-offs re-notify).
    this.settings.notifiedDueKeys = [...(this.settings.notifiedDueKeys ?? []), ...due.filter((d) => !d.key.endsWith("@persist")).map((d) => d.key)].slice(-2000);
    await this.saveSettings();
    await this.showDueToasts(due);
    if (missedRolled > 0) {
      this.notifications.show({
        message: `🔁 ${missedRolled} recurring task${missedRolled === 1 ? " was" : "s were"} missed and rolled to the next interval.`,
        kind: "warning", category: "reminder", folder: "",
      });
    }
  }

  /** 0.185.0: render the due-task toasts. Up to 3 due tasks each get their own
   *  tappable card (whole card opens the task without hijacking the current tab;
   *  the Snooze corner opens the scheduler); more than that collapses to one
   *  summary toast. Shared by the automatic check and the manual resend command. */
  private async showDueToasts(due: Array<{ id: string; folder: string; file: TFile; dueMs: number }>): Promise<void> {
    if (due.length === 0) return;
    const titleOf = async (file: TFile): Promise<string> => {
      try {
        const body = splitFrontmatter(await this.app.vault.cachedRead(file)).body;
        const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
        if (line) return line.replace(/^[#>\-*\s]+/, "").slice(0, 60);
      } catch { /* fall through to filename */ }
      return file.basename.replace(/-[a-z0-9]{4,12}$/, "").replace(/-/g, " ");
    };
    if (due.length <= 3) {
      for (const d of due) {
        const title = await titleOf(d.file);
        this.notifications.show({
          message: `⏰ Task due: “${title}” (${formatDateTime(d.dueMs, this.settings)})`,
          kind: "warning", category: "reminder", duration: 0, folder: d.folder, affectedIds: [d.id],
          // 0.171.0: whole card opens the task; the corner Snooze control opens
          // the scheduler/assigner modal instead (layered above, stopPropagation).
          // 0.185.0 → 0.199.0: always a FRESH tab (focused). Reusing an existing
          // folder tab navigated that tab to the task — which reads as "my tab
          // got overwritten". forceNewTab skips the reuse path entirely.
          onBodyClick: () => void this.openDeepLinkTarget(d.folder, d.id, { forceNewTab: true }),
          overlayAction: {
            label: "Snooze", icon: "alarm-clock-check", title: "Snooze / reschedule…",
            onClick: () => void this.openSchedulerForRef(d.folder, d.id),
          },
        });
      }
    } else {
      this.notifications.show({
        message: `⏰ ${due.length} tasks are due — open the Tasks panel to review.`,
        kind: "warning", category: "reminder", duration: 0, folder: "",
      });
    }
  }

  /** 0.185.0: manually re-fire reminders for every incomplete, past-due task
   *  assigned to me (or unassigned) — the "pop my backlog up again" command.
   *  Unlike checkDueReminders it ignores the once-per-(id@due) dedup, doesn't
   *  auto-resolve tasks, and doesn't touch the persist log; a pure on-demand
   *  re-notify. */
  async resendDueReminders(): Promise<void> {
    const now = Date.now();
    const myId = (this.settings.authorId ?? "").trim();
    const due: Array<{ id: string; folder: string; file: TFile; dueMs: number }> = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.includes("/_authors/")) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { id?: unknown; due?: unknown; completed?: unknown } | undefined;
      if (!fm || fm.due == null) continue;
      const id = typeof fm.id === "string" ? fm.id : "";
      if (!id || fm.completed === true) continue;
      const dueMs = typeof fm.due === "number" ? fm.due : Date.parse(String(fm.due));
      if (!Number.isFinite(dueMs) || dueMs > now) continue; // not due yet
      const assignees = parseAssignees(fm);
      if (assignees.length > 0 && !(myId && assignees.some((a) => a.id === myId))) continue;
      due.push({ id, folder: (f.parent?.path ?? "").replace(/\/+$/, ""), file: f, dueMs });
    }
    if (due.length === 0) { new Notice("No incomplete tasks are due — your backlog is clear. 🎉"); return; }
    await this.showDueToasts(due);
  }

  /** 0.99.17 (#3): the "centralized sync" — rebuild the registry from the whole
   *  vault, then ensure every known author has a stub in every Stashpad folder.
   *  Backfills existing folders (new folders are handled at creation). */
  async syncAuthorsAcrossFolders(): Promise<void> {
    await this.rebuildAuthorRegistry(); // learn every author from the vault first
    const authors = this.collectKnownAuthors();
    const folders = this.discoverStashpadFolders();
    if (!authors.length || !folders.length) { new Notice("No authors or Stashpad folders to sync."); return; }
    const prog = folders.length * authors.length > 8 ? new Notice("", 0) : null;
    let created = 0;
    for (const folder of folders) {
      prog?.setMessage(`Syncing authors → ${folder.split("/").pop()}…`);
      for (const a of authors) {
        if (await this.ensureAuthorStubFor(folder, a.id, a.name)) created++;
      }
    }
    prog?.hide();
    this.notifications.show({
      message: `Synced authors across ${folders.length} folder${folders.length === 1 ? "" : "s"} — ${created} new stub${created === 1 ? "" : "s"} (${authors.length} author${authors.length === 1 ? "" : "s"} known).`,
      kind: "success", category: "system", folder: "",
    });
  }

  /** 0.99.16: VAULT-WIDE list of known authors for the assignee pickers — the
   *  union of the LOCAL registry (per-config, so in a shared vault it mostly
   *  knows just this user) AND a scan of every folder's `_authors/` stub files
   *  (id from the filename, display name from the stub's aliases/name). This is
   *  what surfaces COWORKERS who exist in shared folders but aren't in this
   *  device's registry — the reason only the local user showed up before.
   *  Deduped by id (registry name wins); the local user is listed first. Also
   *  warms the registry with anything new it finds (idempotent after the first). */
  collectKnownAuthors(): Array<{ id: string; name: string }> {
    const byId = new Map<string, string>();
    // The local user is always "known" (from settings), even before they have a
    // stub or any authored notes — and listed first.
    const myId = (this.settings.authorId ?? "").trim();
    const myName = (this.settings.authorName ?? "").trim();
    if (myId && myName) byId.set(myId, myName);
    for (const a of this.authorRegistry.all()) if (!byId.has(a.id)) byId.set(a.id, a.name);
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.includes("/_authors/")) continue;
      const parsed = this.parseAuthorFilePath(f.path);
      if (!parsed) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { aliases?: unknown; name?: unknown } | undefined;
      const aliasName = Array.isArray(fm?.aliases)
        ? ((fm.aliases as unknown[]).find((x) => typeof x === "string") ?? "")
        : (typeof fm?.aliases === "string" ? fm.aliases : "");
      const name = (aliasName || (typeof fm?.name === "string" ? fm.name : "") || parsed.name).trim();
      if (!byId.has(parsed.id)) byId.set(parsed.id, name);
      this.authorRegistry.record({ id: parsed.id, name }); // warm the registry (no-op if unchanged)
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }

  /** 0.77.2: rebuild the author registry from scratch by scanning the
   *  vault. The authoritative inputs are (a) the `_authors` stub files
   *  (id from filename, display name from `aliases`/`name`/H1, plus role/
   *  department frontmatter) and (b) author/contributor wikilinks across
   *  all note frontmatter (for ids whose stub was deleted). Stub metadata
   *  wins over note-link names when both exist. Preserves firstSeen +
   *  rename history for ids already in the registry. Returns a summary. */
  async rebuildAuthorRegistry(): Promise<{ total: number; fromStubs: number; fromNotes: number }> {
    const stashpads = this.discoverStashpadFolders();
    const byId = new Map<string, { id: string; name?: string; role?: string; department?: string; fromStub: boolean }>();

    // Pass 1: author wikilinks across all note frontmatter.
    let fromNotes = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
      if (!fm) continue;
      const refs: string[] = [];
      if (typeof fm.author === "string") refs.push(fm.author);
      if (Array.isArray(fm.contributors)) {
        for (const c of fm.contributors) if (typeof c === "string") refs.push(c);
      }
      for (const raw of refs) {
        const parsed = this.parseAuthorRef(raw);
        if (!parsed) continue;
        if (!byId.has(parsed.id)) { byId.set(parsed.id, { id: parsed.id, name: parsed.name, fromStub: false }); fromNotes++; }
        else { const e = byId.get(parsed.id)!; if (!e.name && parsed.name) e.name = parsed.name; }
      }
    }

    // Pass 2: stub files (authoritative for name/role/department).
    let fromStubs = 0;
    for (const folder of stashpads) {
      const dir = `${folder}/_authors`;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(dir + "/")) continue;
        const parsed = this.parseAuthorFilePath(file.path);
        if (!parsed) continue;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as any;
        const aliasName = Array.isArray(fm?.aliases) ? (fm.aliases.find((a: any) => typeof a === "string") ?? "")
          : (typeof fm?.aliases === "string" ? fm.aliases : "");
        const name = (aliasName || (typeof fm?.name === "string" ? fm.name : "") || parsed.name).trim();
        const role = typeof fm?.role === "string" ? fm.role : undefined;
        const department = typeof fm?.department === "string" ? fm.department : undefined;
        const existing = byId.get(parsed.id);
        if (!existing) fromStubs++;
        byId.set(parsed.id, {
          id: parsed.id,
          name: name || existing?.name,
          role: role ?? existing?.role,
          department: department ?? existing?.department,
          fromStub: true,
        });
      }
    }

    await this.authorRegistry.load();
    this.authorRegistry.replaceAll([...byId.values()]);
    await this.authorRegistry.save();
    return { total: byId.size, fromStubs, fromNotes };
  }

  /** Build the markdown content for an author stub file. Uses the
   *  Obsidian-native `aliases` for the display name (so `[[Name]]`
   *  resolves to the stub and it surfaces in quick switcher) plus role/
   *  department + a created stamp + an H1. Stashpad-owned; safe to
   *  regenerate. */
  buildAuthorStub(rec: { id: string; name: string; role?: string; department?: string }, created: string): string {
    // Collapse any newlines (defensive — a pasted value could contain one)
    // so YAML scalars + the H1 stay single-line, and escape backslashes
    // before quotes for a valid double-quoted YAML string. Without the
    // backslash pass, a name like `a\b` would produce invalid YAML and an
    // unreadable stub.
    const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
    const esc = (s: string) => oneLine(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const name = oneLine(rec.name);
    const lines = ["---", `authorId: ${rec.id}`, `aliases:`, `  - "${esc(rec.name)}"`];
    if (rec.role) lines.push(`role: "${esc(rec.role)}"`);
    if (rec.department) lines.push(`department: "${esc(rec.department)}"`);
    lines.push(`created: ${created}`, "---", `# ${name}`);
    return lines.join("\n");
  }

  /** 0.77.3: for every author the registry knows about, ensure a stub
   *  file exists in every discovered Stashpad folder — regenerating any
   *  that were deleted, from the remembered name/role/department. Never
   *  overwrites an existing stub (that's syncAuthorFilesToName's job).
   *  Returns the count of stubs created. */
  async restoreMissingAuthorStubs(): Promise<{ created: number; folders: number }> {
    await this.authorRegistry.load();
    const authors = this.authorRegistry.all().filter((a) => a.id && a.name);
    const folders = this.discoverStashpadFolders();
    const allFiles = this.app.vault.getMarkdownFiles();
    let created = 0;
    for (const folder of folders) {
      const dir = `${folder}/_authors`;
      // Precompute the set of author ids that already have a stub in this
      // dir (under any name) once per folder, rather than rescanning the
      // whole vault for every author.
      const presentIds = new Set<string>();
      for (const f of allFiles) {
        if (!f.path.startsWith(dir + "/")) continue;
        const id = this.parseAuthorFilePath(f.path)?.id;
        if (id) presentIds.add(id);
      }
      for (const rec of authors) {
        if (presentIds.has(rec.id)) continue;     // don't duplicate after a rename
        const safe = this.authorNameToSafe(rec.name);
        const path = `${dir}/${safe}-${rec.id}.md`;
        try {
          await this.ensureFolderPath(dir);
          if (await this.app.vault.adapter.exists(path)) continue;
          await this.app.vault.create(path, this.buildAuthorStub(rec, rec.firstSeen ?? new Date().toISOString()));
          created++;
        } catch (e) {
          console.warn("[Stashpad] restore author stub failed", path, e);
        }
      }
    }
    return { created, folders: folders.length };
  }

  /** 0.79.18: convert plain-text `attachments` frontmatter entries to
   *  internal links (`[[path]]`) across all notes. Idempotent — only
   *  rewrites notes that have at least one non-link entry, and
   *  `toAttachmentLink` never re-brackets an existing link, so re-running
   *  can't double-wrap or loop. Returns the count of notes changed. */
  async convertAttachmentsToLinks(): Promise<number> {
    let converted = 0;
    const isLink = (s: string) => /^\[\[.*\]\]$/.test(s.trim());
    for (const folder of this.discoverStashpadFolders()) {
      const dir = folder.replace(/\/+$/, "");
      for (const f of this.app.vault.getMarkdownFiles()) {
        const fdir = f.parent?.path?.replace(/\/+$/, "") ?? "";
        if (fdir !== dir && !fdir.startsWith(dir + "/")) continue;
        if (isInReservedSubfolder(f.path)) continue; // skip _archive/_attachments/…
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
        if (!fm || typeof fm.id !== "string" || !fm.id) continue;
        const att: any = fm.attachments;
        const isArr = Array.isArray(att);
        const isScalar = typeof att === "string" && att.trim().length > 0;
        if (!isArr && !isScalar) continue;
        // 0.85.9: also handle a SCALAR `attachments:` (hand-edited / odd import)
        // — normalize it to a one-item list of the canonical link form.
        const needs = isScalar
          ? !isLink(att)
          : (att as any[]).some((a: any) => typeof a === "string" && a.trim() && !isLink(a));
        if (!needs) continue;
        try {
          await this.app.fileManager.processFrontMatter(f, (m: any) => {
            if (Array.isArray(m.attachments)) {
              m.attachments = m.attachments.map((a: any) => (typeof a === "string" && a.trim()) ? toAttachmentLink(a) : a);
            } else if (typeof m.attachments === "string" && m.attachments.trim()) {
              m.attachments = [toAttachmentLink(m.attachments)];
            }
          });
          converted++;
        } catch (e) { console.warn("[Stashpad] attachment-link conversion failed", f.path, e); }
      }
    }
    return converted;
  }

  /** 0.79.12: add each discovered Stashpad folder's `_archive` to
   *  Obsidian's "Excluded files" list (`userIgnoreFilters`) so native
   *  search, quick switcher, graph, and link suggestions skip the
   *  import-originals graveyard. Add-only + idempotent — never removes the
   *  user's own entries. Uses Obsidian's internal vault config getters,
   *  which are undocumented; guarded in try/catch in case they change. */
  syncObsidianExcludedArchives(): void {
    try {
      const vault = this.app.vault as any;
      if (typeof vault.getConfig !== "function" || typeof vault.setConfig !== "function") return;
      const current: string[] = Array.isArray(vault.getConfig("userIgnoreFilters"))
        ? vault.getConfig("userIgnoreFilters") : [];
      const set = new Set(current);
      let changed = false;
      for (const folder of this.discoverStashpadFolders()) {
        const path = `${folder.replace(/\/+$/, "")}/_archive/`;
        if (!set.has(path)) { set.add(path); changed = true; }
      }
      if (changed) vault.setConfig("userIgnoreFilters", [...set]);
    } catch (e) {
      console.warn("[Stashpad] couldn't update Obsidian excluded files", e);
    }
  }

  /** 0.79.4: open the import destination chooser. Pinned top entry opens
   *  the OS file picker into the default folder; other entries target a
   *  specific Stashpad folder. With a single folder, skip to the picker. */
  openImportPicker(): void {
    const folders = this.discoverStashpadFolders();
    if (folders.length === 0) { new Notice("No Stashpad folders to import into."); return; }
    if (folders.length === 1) { this.importService.pickFilesInto(folders[0]); return; }
    const def = this.importService.defaultDestination() ?? folders[0];
    new ImportTargetModal(this.app, def, folders, (folder) => this.importService.pickFilesInto(folder)).open();
  }

  /** 0.84.1: manual counterpart to auto-import. Scans the top level of a
   *  Stashpad folder for loose files moved in from outside (Finder/Explorer
   *  copy, etc.) that Stashpad hasn't processed — i.e. files with no Stashpad
   *  `id` frontmatter — and imports them (md → note + archive original; other
   *  → _attachments + linking note). Lighter than a full rebootstrap: just
   *  this folder's direct children, no slug/frontmatter/registry sweep. Needed
   *  because the live drop-watcher only catches `.stash` files via Obsidian
   *  vault events; a plain file pasted in via Finder is otherwise only swept
   *  on rebootstrap (and only when auto-import is on). */
  async runImportLooseFiles(folder: string): Promise<void> {
    const label = folder.split("/").pop() || folder;
    let files = 0, folders = 0, stashes = 0;
    try {
      // Shared "sweep all loose content" primitive (files + folders + .stash) —
      // the same one rebootstrap uses, so behavior stays in sync. 0.84.7/0.84.8.
      ({ files, folders, stashes } = await this.importService.importLooseInto(folder));
    } catch (e) {
      this.notifications.show({
        message: `Stashpad: import failed in \`${label}\`\nError: ${(e as Error).message}`,
        kind: "error", category: "import", folder,
      });
      console.error("[Stashpad] runImportLooseFiles failed", folder, e);
      return;
    }
    const total = files + folders + stashes;
    // Refresh the active view if it's looking at this folder. New note files
    // also fire vault create → the view's metadata hook repaints, but an
    // explicit rebuild makes the result immediate on slow drives.
    const view = this.lastActiveStashpadLeaf?.view as any;
    if (total > 0 && view?.noteFolder === folder && view?.tree) {
      view.tree.rebuild(folder);
      view.render?.();
    }
    let message: string;
    if (total === 0) {
      message = `Nothing to import in \`${label}\` — everything here is already a Stashpad note.`;
    } else {
      const parts: string[] = [];
      if (files) parts.push(`${files} loose file${files === 1 ? "" : "s"}`);
      if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"} (as nested notes)`);
      if (stashes) parts.push(`${stashes} .stash bundle${stashes === 1 ? "" : "s"}`);
      message = `Imported ${parts.join(" + ")} in \`${label}\`.`;
    }
    this.notifications.show({
      message,
      kind: total > 0 ? "success" : "info",
      category: "import",
      folder,
    });
  }

  /** Refresh the active view if it's looking at `folder` (so per-step repairs
   *  show immediately, like the loose-import command does). */
  private refreshViewIfShowing(folder: string): void {
    const view = this.lastActiveStashpadLeaf?.view as any;
    if (view?.noteFolder === folder && view?.tree) { view.tree.rebuild(folder); view.render?.(); }
  }

  /** 0.85.2: re-run just the filename/slug pass on one folder — the same
   *  `rebootstrapFolderSlugs` rebootstrap uses, without the full-vault sweep. */
  async runFolderSlugPass(folder: string): Promise<void> {
    const label = folder.split("/").pop() || folder;
    let n = 0;
    try { n = await this.rebootstrapFolderSlugs(folder); }
    catch (e) {
      this.notifications.show({ message: `Stashpad: slug pass failed in \`${label}\`\n${(e as Error).message}`, kind: "error", category: "system", folder });
      console.error("[Stashpad] runFolderSlugPass failed", folder, e);
      return;
    }
    this.refreshViewIfShowing(folder);
    this.notifications.show({
      message: n > 0
        ? `Renamed ${n} stale filename${n === 1 ? "" : "s"} in \`${label}\`.`
        : `No stale filenames in \`${label}\` — all slugs match their notes.`,
      kind: n > 0 ? "success" : "info", category: "system", folder,
    });
  }

  /** 0.85.2: re-run just the frontmatter backfill (redundant `parentLink` /
   *  `children` recovery links) on one folder — the same
   *  `rebootstrapFolderFrontmatter` rebootstrap uses. */
  async runFolderFrontmatterBackfill(folder: string): Promise<void> {
    const label = folder.split("/").pop() || folder;
    let written = 0, checked = 0;
    try { const s = await rebootstrapFolderFrontmatter(this.app, folder); written = s.written; checked = s.checked; }
    catch (e) {
      this.notifications.show({ message: `Stashpad: frontmatter backfill failed in \`${label}\`\n${(e as Error).message}`, kind: "error", category: "system", folder });
      console.error("[Stashpad] runFolderFrontmatterBackfill failed", folder, e);
      return;
    }
    this.notifications.show({
      message: written > 0
        ? `Backfilled recovery links on ${written} note${written === 1 ? "" : "s"} in \`${label}\` (${checked} checked).`
        : `Recovery links already up to date in \`${label}\` (${checked} checked).`,
      kind: written > 0 ? "success" : "info", category: "system", folder,
    });
  }

  private autoSweepInProgress = false;
  /** 0.84.11: retroactive auto-import. Periodically (and once at startup) sweep
   *  EVERY Stashpad folder for non-imported loose content — the "watcher
   *  occasionally going through every folder" users expect. Catches items added
   *  while Obsidian was closed, and external Finder copies that never fired a
   *  vault event (the live watchers only react to events). Gated on autoImport
   *  + armed (so it doesn't fight the startup create-storm). Reuses the shared
   *  importLooseInto (files + folders + .stash). 0.84.12 (option C): encrypted
   *  .stash bundles are NOT decrypted inline — a background sweep never pops a
   *  blocking password modal. They're parked and surfaced via a single
   *  non-blocking "N waiting" toast with Import-now / snooze actions. */
  async runAutoImportSweep(): Promise<void> {
    if (!this.settings.autoImport) return;
    if (!this.importService.isArmed()) return;
    if (this.autoSweepInProgress) return; // a slow network-drive sweep may outlast the 5-min tick
    this.autoSweepInProgress = true;
    let files = 0, folders = 0, stashes = 0;
    try {
      for (const folder of this.discoverStashpadFolders()) {
        try {
          const r = await this.importService.importLooseInto(folder, { auto: true });
          files += r.files; folders += r.folders; stashes += r.stashes;
        } catch (e) { console.warn("[Stashpad] auto-import sweep failed", folder, e); }
      }
    } finally {
      this.autoSweepInProgress = false;
    }
    const total = files + folders + stashes;
    if (total > 0) {
      const view = this.lastActiveStashpadLeaf?.view as any;
      if (view?.tree && view?.noteFolder) { view.tree.rebuild(view.noteFolder); view.render?.(); }
      const parts: string[] = [];
      if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
      if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
      if (stashes) parts.push(`${stashes} .stash bundle${stashes === 1 ? "" : "s"}`);
      this.notifications.show({
        message: `Auto-imported ${parts.join(" + ")} (background sweep).`,
        kind: "success",
        category: "import",
      });
    }
    this.notifyPendingEncrypted();
  }

  /** Surface the encrypted .stash bundles parked by the sweep OR the live
   *  drop-watcher (0.84.16) as a single non-blocking, snoozeable toast —
   *  notification-first, never an inline modal. "Import now" opens the password
   *  prompt; the prompt itself also offers "Remind me later". Snoozed for an
   *  hour each time it shows so it doesn't re-nag (a brand-new arrival resets
   *  the snooze via parkEncrypted so it surfaces immediately). */
  private notifyPendingEncrypted(): void {
    const pending = this.importService.pendingEncryptedPaths();
    if (pending.length === 0) return;
    if (!this.importService.shouldNotifyEncrypted()) return;
    this.importService.snoozeEncryptedNotify(60 * 60 * 1000); // default: don't re-nag for 1h
    const n = pending.length;
    this.notifications.show({
      message: `${n} encrypted .stash bundle${n === 1 ? "" : "s"} waiting to import. Import ${n === 1 ? "it" : "them"} with the password?`,
      kind: "info",
      category: "import",
      duration: 0,
      actions: [
        { label: "Import now", onClick: () => void this.importPendingEncryptedNow() },
        { label: "Remind me later", onClick: () => this.importService.snoozeEncryptedNotify(60 * 60 * 1000) },
        { label: "Not now (until next launch)", onClick: () => this.importService.snoozeEncryptedNotify(Infinity) },
      ],
    });
  }

  private async importPendingEncryptedNow(): Promise<void> {
    const { imported, rescheduled } = await this.importService.importPendingEncrypted();
    if (imported > 0) {
      const view = this.lastActiveStashpadLeaf?.view as any;
      if (view?.tree && view?.noteFolder) { view.tree.rebuild(view.noteFolder); view.render?.(); }
      this.notifications.show({
        message: `Imported ${imported} encrypted .stash bundle${imported === 1 ? "" : "s"}.`,
        kind: "success",
        category: "import",
      });
    }
    // If the user picked "Remind me later" mid-prompt, the snooze is already
    // set; nothing else to do — the reminder resurfaces on the next sweep.
    void rescheduled;
  }

  /** 0.77.7: ensure the LOCAL user's author page exists in `folder`,
   *  creating it from settings if missing. Targeted counterpart to
   *  restoreMissingAuthorStubs — seeds only YOUR page (not every known
   *  author), so links/quick-switcher resolve in every folder without the
   *  N×M clutter of propagating coworker pages into folders they've never
   *  touched. No-op if your name isn't set or a stub for your id already
   *  exists in that folder (under any name). */
  async seedLocalAuthorStub(folder: string): Promise<boolean> {
    const id = (this.settings.authorId ?? "").trim();
    const name = (this.settings.authorName ?? "").trim();
    if (!id || !name) return false;
    const dir = `${folder.replace(/\/+$/, "")}/_authors`;
    const exists = this.app.vault.getMarkdownFiles().some(
      (f) => f.path.startsWith(dir + "/") && this.parseAuthorFilePath(f.path)?.id === id,
    );
    if (exists) return false;
    const safe = this.authorNameToSafe(name);
    const path = `${dir}/${safe}-${id}.md`;
    try {
      await this.ensureFolderPath(dir);
      if (await this.app.vault.adapter.exists(path)) return false;
      await this.app.vault.create(path, this.buildAuthorStub(
        { id, name, role: this.settings.authorRole, department: this.settings.authorDepartment },
        new Date().toISOString(),
      ));
      this.authorRegistry.record({ id, name, role: this.settings.authorRole, department: this.settings.authorDepartment });
      return true;
    } catch (e) {
      console.warn("[Stashpad] seedLocalAuthorStub failed", path, e);
      return false;
    }
  }

  /** Seed the local user's author page into every discovered Stashpad
   *  folder that lacks it. Run once at startup so existing folders get
   *  backfilled; new folders are handled at creation time. */
  async seedLocalAuthorStubsEverywhere(): Promise<number> {
    const name = (this.settings.authorName ?? "").trim();
    if (!name) return 0;
    let created = 0;
    for (const folder of this.discoverStashpadFolders()) {
      if (await this.seedLocalAuthorStub(folder)) created++;
    }
    return created;
  }

  /** mkdir a vault dir path, intermediates included. Tolerates races and
   *  the "already exists" error Obsidian sometimes throws. */
  private async ensureFolderPath(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      try { if (!(await adapter.exists(cur))) await adapter.mkdir(cur); }
      catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; }
    }
  }

  async loadSettings(): Promise<void> {
    // 0.189.0: merges data.json + history.json into the historic settings shape and
    // performs the one-time split migration (backing data.json up first). Callers
    // downstream see exactly the object they always did.
    const data = (await this.store.loadAll()) ?? {};
    // 0.137.3: collision guard — remember the on-disk write generation we
    // loaded from, so a save can detect that another instance wrote since.
    this.lastSeenSettingsRev = typeof data?.settingsRev === "number" ? data.settingsRev : 0;
    // Migrate legacy `confirmMultiDelete` (split in 0.51.12 into two flags:
    // confirmBulkDelete + confirmAttachmentDelete). Preserve the user's
    // previous choice by seeding both new flags from the old value when
    // the new ones haven't been written yet.
    if (typeof data?.confirmMultiDelete === "boolean") {
      if (typeof data.confirmBulkDelete !== "boolean") data.confirmBulkDelete = data.confirmMultiDelete;
      if (typeof data.confirmAttachmentDelete !== "boolean") data.confirmAttachmentDelete = data.confirmMultiDelete;
      delete data.confirmMultiDelete;
    }
    // 0.71.4: migrate jdIndexDestFolder (0.71.0 name) → jdIndexStashpadFolder
    // (0.71.2 rename). Without this, users who configured the field
    // before the rename would silently lose their value and the
    // preview would land in no-dest territory.
    if (typeof (data)?.jdIndexDestFolder === "string"
        && typeof (data)?.jdIndexStashpadFolder !== "string") {
      (data).jdIndexStashpadFolder = (data).jdIndexDestFolder;
    }
    // 0.170.2: "E" was reassigned from "Open in Obsidian editor" (openEditor) to the
    // new in-app editor (edit). Move a STALE openEditor="E" (the old default) to its
    // new chord so E doesn't fire two commands. Idempotent — only touches an exact "E".
    // 0.270.2: `pinnedIgnoreFilters` (0.270.1, boolean) became the three-way
    // `pinnedFilterMode`. Preserve a user's choice: true -> "all", false -> "none".
    if (typeof (data)?.pinnedIgnoreFilters === "boolean" && typeof (data)?.pinnedFilterMode !== "string") {
      (data).pinnedFilterMode = (data).pinnedIgnoreFilters ? "all" : "none";
      delete (data).pinnedIgnoreFilters;
    }
    if (data?.shortcuts && data.shortcuts.openEditor === "E") data.shortcuts.openEditor = "Mod+Shift+E";
    if (data?.bindings?.openEditor && data.bindings.openEditor.primary === "E") data.bindings.openEditor.primary = "Mod+Shift+E";
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(data?.shortcuts ?? {}) },
      mod: { ...DEFAULT_SETTINGS.mod, ...(data?.mod ?? {}) },
      bindings: mergeBindings(data?.bindings, data?.shortcuts, data?.mod),
      customPalette: Array.isArray(data?.customPalette)
        ? data.customPalette.filter((c: unknown) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c))
        : [],
      colorAliases: (data?.colorAliases && typeof data.colorAliases === "object")
        ? data.colorAliases
        : {},
      noteTemplates: (data?.noteTemplates && typeof data.noteTemplates === "object")
        ? data.noteTemplates
        : {},
      authorName: typeof data?.authorName === "string" ? data.authorName : "",
      authorId: typeof data?.authorId === "string" ? data.authorId : "",
      authorRole: typeof data?.authorRole === "string" ? data.authorRole : "",
      authorDepartment: typeof data?.authorDepartment === "string" ? data.authorDepartment : "",
      showAuthor: typeof data?.showAuthor === "boolean" ? data.showAuthor : true,
      showContributors: typeof data?.showContributors === "boolean" ? data.showContributors : true,
      showLastEdit: typeof data?.showLastEdit === "boolean" ? data.showLastEdit : true,
      viewModes: (data?.viewModes && typeof data.viewModes === "object" && !Array.isArray(data.viewModes))
        ? data.viewModes
        : {},
      includeAttachmentsInEverything: (data?.includeAttachmentsInEverything && typeof data.includeAttachmentsInEverything === "object" && !Array.isArray(data.includeAttachmentsInEverything))
        ? data.includeAttachmentsInEverything
        : {},
      hideChildlessNotes: (data?.hideChildlessNotes && typeof data.hideChildlessNotes === "object" && !Array.isArray(data.hideChildlessNotes))
        ? data.hideChildlessNotes
        : {},
      hideCompletedNotes: (data?.hideCompletedNotes && typeof data.hideCompletedNotes === "object" && !Array.isArray(data.hideCompletedNotes))
        ? data.hideCompletedNotes
        : {},
      mutedNotificationCategories: Array.isArray(data?.mutedNotificationCategories)
        ? data.mutedNotificationCategories.filter((x: unknown): x is string => typeof x === "string")
        : [],
      notificationHistoryLimit: (typeof data?.notificationHistoryLimit === "number" && Number.isFinite(data.notificationHistoryLimit))
        ? data.notificationHistoryLimit
        : 5000,
      notifiedDueKeys: Array.isArray(data?.notifiedDueKeys)
        ? data.notifiedDueKeys.filter((x: unknown): x is string => typeof x === "string").slice(-2000)
        : [],
      drafts: normalizeDrafts(data?.drafts),
      lastSubmitted: data?.lastSubmitted && typeof data.lastSubmitted === "object" ? data.lastSubmitted : {},
      // Migrate: when slugStopWords has never been set on this install
      // (undefined on disk), seed it with the default list so the
      // settings textbox shows actual content. Once the user edits — even
      // to clear it — the saved list is treated as authoritative.
      slugStopWords: Array.isArray(data?.slugStopWords)
        ? data.slugStopWords
        : [...DEFAULT_STOPWORDS],
      migratedToggleTaskG: data?.migratedToggleTaskG === true,
      dueQuickAdjusts: Array.isArray(data?.dueQuickAdjusts)
        ? data.dueQuickAdjusts.filter((x: unknown): x is string => typeof x === "string")
        : ["5m", "15m", "30m", "1h", "1d", "1w"],
    };
    setSettings(this.settings);
    // 0.137.3: collision guard — baseline what the protected keys looked like
    // at load, so a later save can tell "we changed it" from "someone else did".
    this.snapshotSettingsBaseline();
    // 0.124.1: one-time migration of the "Toggle task" default H → G. Installs
    // persist the FULL bindings map, so changing the default alone never reaches
    // existing users. Flip a still-default `H` to `G` once, then mark it done so
    // a later deliberate rebind to H sticks.
    if (!this.settings.migratedToggleTaskG) {
      if (this.settings.bindings.toggleTask?.primary === "H") {
        this.settings.bindings.toggleTask.primary = "G";
      }
      this.settings.migratedToggleTaskG = true;
      await this.saveSettings();
    }
    // Sync the notification service's mute set from settings. Safe to
    // call before any toasts fire — the service no-ops on empty mute
    // sets. Cast through string[] → NotificationCategory[] since the
    // on-disk list is opaque (forward-compatible with new categories).
    this.notifications.loadMutedFromList(this.settings.mutedNotificationCategories as any);
    // Apply the user's history-cap setting (default 5000; <=0 means
    // unlimited). Setting this BEFORE the loadHistory call below
    // ensures the restored history is trimmed to the right size.
    this.notifications.setHistoryLimit(this.settings.notificationHistoryLimit);
    // Stamp the local user's authorId so multiplayer filters in the
    // history modal can pivot on "who acted here" without every
    // notification site having to remember.
    this.notifications.setDefaultAuthorId(this.settings.authorId);
    // Restore persisted notification history from disk + wire a
    // debounced save on every push so it survives reloads.
    void this.attachNotificationPersistence();
  }

  /** Notification-history persistence — load on plugin onload, save
   *  on every history mutation (debounced 1s to coalesce bursts).
   *  Storage lives at <pluginDir>/notifications.json as a single
   *  JSON dump of NotificationRecord[]. Idempotent: subsequent calls
   *  early-return after the first wire-up. */
  private notifPersistenceWired = false;
  private notifSaveTimer: number | null = null;
  private notificationsPath(): string {
    return this.pluginPrivatePath("notifications.json");
  }
  private async attachNotificationPersistence(): Promise<void> {
    if (this.notifPersistenceWired) return;
    this.notifPersistenceWired = true;
    const adapter = this.app.vault.adapter;
    const path = this.notificationsPath();
    try {
      if (await adapter.exists(path)) {
        const raw = await adapter.read(path);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.notifications.loadHistory(parsed);
      }
    } catch (e) {
      console.warn("[Stashpad] failed to load notification history", e);
    }
    // Debounced save on every history change.
    this.notifications.onChange(() => {
      if (this.notifSaveTimer != null) window.clearTimeout(this.notifSaveTimer);
      this.notifSaveTimer = window.setTimeout(() => {
        this.notifSaveTimer = null;
        void this.persistNotificationHistory();
      }, 1000);
    });
  }
  private async persistNotificationHistory(): Promise<void> {
    try {
      const records = this.notifications.recent().slice().reverse(); // oldest-first on disk
      const path = this.notificationsPath();
      const dir = path.replace(/\/[^/]+$/, "");
      const adapter = this.app.vault.adapter;
      if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(path, JSON.stringify(records));
    } catch (e) {
      console.warn("[Stashpad] failed to save notification history", e);
    }
  }

  /** Per-(folder, focus) "last cursor note id" persistence via localStorage.
   *  0.56.14: replaces the pixel-scrollTop approach. Stable across layout
   *  changes (markdown reflows, font/image loads, list growth) because
   *  it's a logical id, not a pixel coordinate. On view restore we scroll
   *  that note into view via the `scroll-to-id` policy.
   *
   *  Storage key: "stashpad:last-cursor" → JSON { "<folder>": { "<focusId>": "<noteId>" } } */
  private readonly LAST_CURSOR_LS_KEY = "stashpad:last-cursor";
  private readLastCursorFile(): Record<string, Record<string, string>> {
    try {
      const raw = window.localStorage.getItem(this.LAST_CURSOR_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, Record<string, string>> : {};
    } catch {
      return {};
    }
  }
  /** Map of <focusId> → <last cursor note id> for the given folder. */
  loadLastCursor(folder: string): Map<string, string> {
    const all = this.readLastCursorFile();
    const slice = all[folder] ?? {};
    return new Map(Object.entries(slice));
  }
  /** Synchronously persist last cursor for one (folder, focus). */
  saveLastCursor(folder: string, focusId: string, noteId: string): void {
    try {
      const all = this.readLastCursorFile();
      if (!all[folder]) all[folder] = {};
      all[folder][focusId] = noteId;
      window.localStorage.setItem(this.LAST_CURSOR_LS_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn("[Stashpad] failed to save last-cursor", e);
    }
  }

  // 0.91.0: last MULTI-SELECTION per (folder, focus), persisted to
  // localStorage. Mirrors the last-cursor store above. Lives in localStorage
  // rather than view state because (a) it must survive even when the tab is
  // lazy-loaded/deferred on reload, and (b) selection changes don't trigger a
  // workspace-layout save, so getState() would capture stale state. Stamped on
  // beforeunload/blur/onClose (eager), read back on view load.
  private readonly LAST_SELECTION_LS_KEY = "stashpad:last-selection";
  private readLastSelectionFile(): Record<string, Record<string, string[]>> {
    try {
      const raw = window.localStorage.getItem(this.LAST_SELECTION_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, Record<string, string[]>> : {};
    } catch {
      return {};
    }
  }
  /** Map of <focusId> → <selected note ids> for the given folder. */
  loadLastSelection(folder: string): Map<string, string[]> {
    const all = this.readLastSelectionFile();
    const slice = all[folder] ?? {};
    const out = new Map<string, string[]>();
    for (const [focusId, ids] of Object.entries(slice)) {
      if (Array.isArray(ids)) out.set(focusId, ids.filter((x): x is string => typeof x === "string"));
    }
    return out;
  }
  /** Synchronously persist the selection for one (folder, focus). An empty
   *  array clears it (so deselect-then-reload doesn't resurrect stale ids). */
  saveLastSelection(folder: string, focusId: string, ids: string[]): void {
    try {
      const all = this.readLastSelectionFile();
      if (!all[folder]) all[folder] = {};
      if (ids.length) all[folder][focusId] = ids;
      else delete all[folder][focusId];
      window.localStorage.setItem(this.LAST_SELECTION_LS_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn("[Stashpad] failed to save last-selection", e);
    }
  }

  // Sheet versions: which version (note id) of each `sheet:` group is the one
  // shown as a row. Persisted to localStorage (like last-cursor) so the choice
  // survives reloads. Keyed by group id (globally unique) within a folder.
  // Storage key: "stashpad:active-versions" → { "<folder>": { "<groupId>": "<noteId>" } }
  private readonly ACTIVE_VERSIONS_LS_KEY = "stashpad:active-versions";
  private readActiveVersionsFile(): Record<string, Record<string, string>> {
    try {
      const raw = window.localStorage.getItem(this.ACTIVE_VERSIONS_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, Record<string, string>> : {};
    } catch {
      return {};
    }
  }
  /** Map of <groupId> → <active version note id> for the given folder. */
  loadActiveVersions(folder: string): Map<string, string> {
    const all = this.readActiveVersionsFile();
    return new Map(Object.entries(all[folder] ?? {}));
  }
  /** Synchronously persist the active version for one (folder, group). */
  saveActiveVersion(folder: string, groupId: string, noteId: string): void {
    try {
      const all = this.readActiveVersionsFile();
      if (!all[folder]) all[folder] = {};
      all[folder][groupId] = noteId;
      window.localStorage.setItem(this.ACTIVE_VERSIONS_LS_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn("[Stashpad] failed to save active-version", e);
    }
  }

  /** Basenames of recently-deleted notes awaiting a fork-siblings prune. */
  private pendingForkDeletes = new Set<string>();
  /** Remove the deleted notes from every other note's `fork-siblings`. */
  private async flushForkSiblingPrune(): Promise<void> {
    const names = new Set(this.pendingForkDeletes);
    this.pendingForkDeletes.clear();
    if (!names.size) return;
    for (const f of this.app.vault.getMarkdownFiles()) {
      const sibs = this.app.metadataCache.getFileCache(f)?.frontmatter?.[SIBLINGS_KEY];
      if (!Array.isArray(sibs)) continue;
      if (!sibs.some((s) => names.has(wikilinkName(s) ?? ""))) continue;
      try {
        await this.app.fileManager.processFrontMatter(f, (m: any) => {
          const arr = Array.isArray(m[SIBLINGS_KEY]) ? m[SIBLINGS_KEY] : [];
          const next = arr.filter((s: unknown) => !names.has(wikilinkName(s) ?? ""));
          if (next.length) m[SIBLINGS_KEY] = next;
          else delete m[SIBLINGS_KEY];
        });
      } catch { /* ignore */ }
    }
  }

  /** Serializes ALL settings writes so a fast draft-write can't race with
   *  a settings-tab edit and clobber a freshly-changed shortcut. Both
   *  saveSettings() and persistSettingsQuiet() funnel through here. */
  private writeChain: Promise<void> = Promise.resolve();
  private queueWrite(): Promise<void> {
    // Snapshot the settings reference at queue time. saveData itself does
    // a synchronous JSON.stringify, but we still chain so two in-flight
    // writes can't interleave their adapter.write calls.
    const next = this.writeChain.then(() => this.guardedSave());
    this.writeChain = next.catch(() => {});
    return next;
  }

  /** 0.137.3: MULTI-WRITER COLLISION GUARD. Two Obsidian instances on the same
   *  vault (dual-open, network drives, sync tools) each hold settings in
   *  memory; last-save-wins used to let a STALE writer silently revert the
   *  other's changes — including the encryption identity, which manifests as
   *  "my password stopped working". Every save now re-reads data.json first;
   *  if another writer bumped the rev since we last saw it, the SECURITY-
   *  CRITICAL keys we haven't touched this session are adopted from disk
   *  instead of clobbered (keys we DID change: ours win — we're the active
   *  editor). Best-effort (not a lock — simultaneous writes can still race),
   *  but it turns the common interleaving from silent key-loss into a merge +
   *  a loud notice. */
  // 0.149.2: folder-panel placement is synced (data.json), but it wasn't in this
  // list — so a `saveData` on one device silently CLOBBERED a pin/downrank/hide a
  // synced device had just made (only these keys get the re-read-and-adopt merge
  // below). That's why folder-panel state diverged per device and "didn't sync."
  // Protecting them makes a change on one device get ADOPTED rather than lost.
  private static readonly COLLISION_PROTECTED_KEYS = ["encryption", "lockedSubtrees", "folderEncPrefs", "archiveFolders", "folderPanelPinned", "folderPanelDownranked", "folderPanelHidden", "folderPanelPinnedGrouping"] as const;
  private lastSeenSettingsRev = 0;
  private settingsBaseline: Record<string, string | undefined> = {};
  /** 0.189.0: persistence layer. data.json keeps everything that must sync; the
   *  per-device reminder/draft churn lives in history.json so a reminder firing no
   *  longer rewrites the whole settings blob. See docs/data-split-plan.md. */
  private store = new SettingsStore(this);
  private externalReloadDebounced = debounce(() => void this.onExternalDataJsonChange(), 600, false);

  /** Coalesce a burst of `raw` data.json events (a sync often writes in chunks). */
  private scheduleExternalDataJsonReload(): void { this.externalReloadDebounced(); }

  /** data.json changed on disk from OUTSIDE our own save (another device via
   *  Obsidian Sync, or another window). Re-read it and adopt the
   *  collision-protected keys whose value differs from ours — then refresh the
   *  folder panel so synced pins/hides show without a reload. Skips our own writes
   *  via the settingsRev guard (our writes never raise diskRev above lastSeen). */
  private async onExternalDataJsonChange(): Promise<void> {
    const s = this.settings as unknown as Record<string, unknown>;
    let panelChanged = false, anyChanged = false;

    // 0.189.0: adopt the SPLIT files first. They carry their own per-file revs, so a
    // history.json write from another window must be picked up even when data.json
    // is untouched — the old early-return on data.json's rev would have skipped it.
    try {
      const rep = await this.store.adoptExternal(s);
      if (rep.any) anyChanged = true;
    } catch { /* non-fatal: split files are device-local churn */ }

    let disk: Record<string, unknown> | null = null;
    try { disk = (await this.loadData()) as Record<string, unknown> | null; } catch { disk = null; }
    const diskRev = typeof disk?.settingsRev === "number" ? (disk.settingsRev as number) : 0;
    // Only walk data.json's protected keys when it actually moved on disk; our own
    // writes never raise diskRev above lastSeen.
    if (disk && diskRev > this.lastSeenSettingsRev) {
      // 0.211.1: pick up EVERY key a synced write changed, not just the protected
      // eight. This is the live watcher; if it ignores a key, our in-memory copy
      // stays stale and the next save writes that staleness back — which is how the
      // laptop's rebinds died on the desktop. Only adopt keys we have NOT changed
      // ourselves this session: an unsaved local edit must not be silently reverted
      // by an incoming file.
      const churn = new Set(MOVED_KEYS);
      const candidates = new Set([...Object.keys(s), ...Object.keys(disk)]);
      for (const k of candidates) {
        if (k === "settingsRev" || churn.has(k)) continue;
        if (disk[k] === undefined) continue;
        if (JSON.stringify(disk[k]) === JSON.stringify(s[k])) continue;
        const baseline = this.settingsBaseline[k];
        if (baseline !== undefined && JSON.stringify(s[k]) !== baseline) continue; // ours is dirty — keep it
        s[k] = disk[k];
        anyChanged = true;
        if (k === "bindings") this.healAdoptedBindings();
        if (k.startsWith("folderPanel")) panelChanged = true;
      }
      this.lastSeenSettingsRev = diskRev;
    }

    if (anyChanged) {
      setSettings(this.settings);
      this.snapshotSettingsBaseline();
      if (panelChanged) this.refreshFolderPanels();
    }
  }

  /** 0.211.1: baseline EVERY settings key, not just the collision-protected eight.
   *  The adoption rule in guardedSave is "ours unchanged + disk changed => take
   *  disk's", and it can only be applied to a key we have a baseline for. Limiting
   *  the baseline to 8 keys is what limited the protection to 8 keys. */
  /** 0.268.17: re-complete `bindings` after an adoption.
   *
   *  Load runs the raw value through mergeBindings, which starts from
   *  buildDefaultBindings() and therefore always yields an entry for every
   *  command. The adoption paths did not: they assign `ours[k] = disk[k]`
   *  wholesale, so a `bindings` map written by a device on an OLDER Stashpad —
   *  one that predates a command — replaced the complete in-memory map with an
   *  incomplete one, mid-session.
   *
   *  The settings UI then read settings.bindings[id] for a command the map had
   *  never heard of and indexed undefined, which threw while building the
   *  Hotkeys page and left Obsidian's settings navigation dead: after visiting
   *  Hotkeys, no other section could be opened. It cleared on reload precisely
   *  because reload goes through mergeBindings again.
   *
   *  Re-merging is lossless — every value present on disk is kept, and only the
   *  missing ids come back at their defaults. */
  private healAdoptedBindings(): void {
    const s = this.settings as unknown as Record<string, unknown>;
    try { s.bindings = mergeBindings(s.bindings, undefined, undefined); } catch { /* keep what we have */ }
  }

  private snapshotSettingsBaseline(): void {
    const all = this.settings as unknown as Record<string, unknown>;
    this.settingsBaseline = {};
    for (const k of Object.keys(all)) {
      if (k === "settingsRev") continue; // bookkeeping, never adopted
      this.settingsBaseline[k] = JSON.stringify(all[k]);
    }
  }

  /** Map-like settings where two machines editing DIFFERENT entries should keep
   *  both, rather than one whole-value write winning. `drafts` is user-typed text
   *  and `noteTemplates`/`colorAliases` are per-folder maps — losing the other
   *  machine's entries there is real data loss, and a key-level union is exactly
   *  right because the entries are independent. Anything not listed keeps
   *  whole-value semantics, which is correct for scalars and ordered arrays. */
  private static UNION_MERGE_KEYS: readonly string[] = [
    "drafts", "lastSubmitted", "noteTemplates", "colorAliases", "viewModes",
  ];

  private async guardedSave(): Promise<void> {
    // 0.209.5: never write over a data.json we could not parse at load. Doing so
    // replaces a recoverable file with defaults — the exact loss the load-time
    // guard exists to prevent. One Notice already told the user; stay silent here
    // so a busy session doesn't spam them on every autosave.
    if (this.store.loadFailed()) return;
    let disk: Record<string, unknown> | null = null;
    /** Set when the collision guard adopted a disk value — forces the data.json
     *  write even if none of OUR core keys changed, so the merged result lands. */
    let adoptedAny = false;
    try { disk = (await this.loadData()) as Record<string, unknown> | null; } catch { /* first write / unreadable */ }
    const diskRev = typeof disk?.settingsRev === "number" ? (disk.settingsRev as number) : 0;
    // 0.140.2: adopt on CONTENT change, not just a higher rev. Two instances
    // that both loaded rev N and write near-simultaneously both stamp N+1, so a
    // rev-gated check (`diskRev > lastSeen`) misses the collision and silently
    // clobbers the other's protected keys. Comparing the on-disk protected-key
    // content against OUR baseline catches it whenever the other write already
    // landed — regardless of rev — which is the common "minutes apart" case.
    if (disk) {
      const adopted: string[] = [];
      // 0.211.1: apply the rule to EVERY key, not just the protected eight.
      //
      // The rule itself was always right — "we didn't touch it, they did, so take
      // theirs" — but it only ran over 8 of ~94 keys, so bindings, shortcuts,
      // noteTemplates, colorAliases, folder pins and the rest stayed last-write-wins.
      // Rebind hotkeys on the laptop, and the next save on the desktop (a task tick,
      // a reminder) wrote its stale copy back over them.
      //
      // Two refinements make widening this safe rather than noisy:
      //  - UNION for map-like keys: two machines editing DIFFERENT drafts or
      //    templates keep both entries instead of one whole-value write winning.
      //  - The loud Notice stays scoped to the SECURITY-critical keys. Widening the
      //    protection should not mean interrupting the user because the other
      //    machine pinned a folder.
      const churn = new Set(MOVED_KEYS);
      const ours = this.settings as unknown as Record<string, unknown>;
      const candidates = new Set([...Object.keys(ours), ...Object.keys(disk)]);
      for (const k of candidates) {
        if (k === "settingsRev" || churn.has(k)) continue;   // bookkeeping / per-device
        if (disk[k] === undefined) continue;
        const baseline = this.settingsBaseline[k];
        if (baseline === undefined) continue;                // never seen it — don't guess
        const oursChanged = JSON.stringify(ours[k]) !== baseline;
        const diskChanged = JSON.stringify(disk[k]) !== baseline;
        if (!diskChanged) continue;
        if (!oursChanged) {
          ours[k] = disk[k];
          adopted.push(k);
          continue;
        }
        // BOTH changed. For a map, keep both sides' entries (ours wins a genuine
        // per-entry conflict, since we are the active editor). For anything else
        // ours wins wholesale, as before.
        if (StashpadPlugin.UNION_MERGE_KEYS.includes(k)
          && disk[k] && ours[k] && typeof disk[k] === "object" && typeof ours[k] === "object"
          && !Array.isArray(disk[k]) && !Array.isArray(ours[k])) {
          const merged = { ...(disk[k] as Record<string, unknown>), ...(ours[k] as Record<string, unknown>) };
          if (JSON.stringify(merged) !== JSON.stringify(ours[k])) {
            ours[k] = merged;
            adopted.push(`${k} (merged)`);
          }
        }
      }
      const protectedSet = new Set<string>(StashpadPlugin.COLLISION_PROTECTED_KEYS as readonly string[]);
      const critical = adopted.filter((k) => protectedSet.has(k.replace(" (merged)", "")));
      if (adopted.length) {
        adoptedAny = true;
        if (adopted.some((k) => k.startsWith("bindings"))) this.healAdoptedBindings();
        console.warn(`[Stashpad] settings collision: on-disk keys differ from our baseline (disk rev ${diskRev}, we knew ${this.lastSeenSettingsRev}); adopted: ${adopted.join(", ")}.`);
        if (critical.length) new Notice(`Stashpad: another Obsidian instance (or a synced machine) changed this vault's settings. Merged instead of overwriting (${critical.join(", ")}). If encryption behaves oddly, restart Obsidian.`, 10000);
        setSettings(this.settings);
        // Reflect adopted folder-panel placement immediately — no reload needed.
        if (adopted.some((k) => k.startsWith("folderPanel"))) this.refreshFolderPanels();
      }
      if (diskRev > this.lastSeenSettingsRev) this.lastSeenSettingsRev = diskRev;
    }
    const all0 = this.settings as unknown as Record<string, unknown>;
    // Skip the data.json write entirely when only per-device churn changed — that's
    // the other half of the split: a reminder firing must not rewrite your hotkeys.
    const coreDirty = this.store.coreDirty(all0) || adoptedAny;
    const rev = Math.max(diskRev, this.lastSeenSettingsRev) + 1;
    if (coreDirty) (this.settings as unknown as Record<string, unknown>).settingsRev = rev;
    // 0.189.0: the per-device churn keys go to history.json (written only when they
    // actually changed), and data.json is written WITHOUT them. The guarded-merge
    // logic above still governs data.json's collision-protected keys.
    const all = this.settings as unknown as Record<string, unknown>;
    // Isolated: history.json is per-device churn, so a failure there must never
    // block the (more important) data.json write that follows.
    try {
      await this.store.saveSplit(all);
    } catch (e) {
      console.warn("[Stashpad] history.json write failed — continuing with data.json.", e);
    }
    if (coreDirty) {
      const core: Record<string, unknown> = {};
      const moved = new Set<string>(MOVED_KEYS);
      for (const [k, v] of Object.entries(all)) if (!moved.has(k)) core[k] = v;
      await this.saveData(core);
      this.lastSeenSettingsRev = rev;
      this.store.markCoreSaved(all);
    }
    this.snapshotSettingsBaseline();
  }

  async saveSettings(): Promise<void> {
    await this.queueWrite();
    setSettings(this.settings);
    perf.enabled = !!this.settings.enablePerfProfiling;
    // 0.77.1: keep the registry's record of the local user current. The
    // registry is a recovery cache — recording here means a name/role/
    // department change is remembered (with rename history) even if the
    // _authors stubs are later deleted.
    const id = (this.settings.authorId ?? "").trim();
    if (id) {
      this.authorRegistry.record({
        id,
        name: this.settings.authorName,
        role: this.settings.authorRole,
        department: this.settings.authorDepartment,
      });
    }
    console.debug("[Stashpad] saveSettings", {
      shortcuts: this.settings.shortcuts,
      mod: this.settings.mod,
    });
  }

  /** Persist settings to disk WITHOUT firing the onSettingsChange listeners,
   *  so high-frequency writes (e.g. composer drafts) don't trigger re-renders
   *  that would steal focus from the textarea. */
  async persistSettingsQuiet(): Promise<void> {
    await this.queueWrite();
  }

  /** Stamp the active markdown file with Stashpad frontmatter (id, parent,
   *  created), only filling fields that are missing or blank. The file is
   *  presumed to already live inside a Stashpad folder; we don't move it.
   *
   *  - id: validated as a non-empty string with no whitespace; if missing or
   *    colliding with an existing note in the vault, a fresh id is generated
   *    and re-checked until unique.
   *  - parent: defaults to ROOT_ID (the home note) when missing or blank.
   *  - created: defaults to the file's ctime as ISO-8601 (matching the
   *    format used by createNoteUnder).
   */
  /** Scan every markdown file inside any discovered Stashpad folder
   *  and bring its frontmatter into a valid Stashpad shape:
   *    - id        → generated if missing, never overwritten if present
   *    - parent    → ROOT_ID if missing/empty, never overwritten otherwise
   *    - created   → file ctime if missing
   *
   *  This is the batch version of the adopt command, except it also
   *  picks up files that were dropped into a Stashpad folder without
   *  ever being adopted. Files that are already valid Stashpad notes
   *  are skipped (the scan reports zero work for them).
   */
  async fixOrphanParents(): Promise<void> {
    const stashpadFolders = new Set(this.discoverStashpadFolders());
    if (stashpadFolders.size === 0) {
      new Notice("No Stashpad folders found.");
      return;
    }

    // Collect every used id across the vault so generated ids don't
    // collide. Built once for the whole batch.
    const usedIds = new Set<string>();
    const allMd = this.app.vault.getMarkdownFiles();
    for (const f of allMd) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      if (id) usedIds.add(id);
    }

    const { newId } = await import("./id-service");
    const pickFreshId = (): string => {
      for (let i = 0; i < 100; i++) {
        const c = newId();
        if (!usedIds.has(c)) { usedIds.add(c); return c; }
      }
      for (let len = 8; len <= 16; len += 2) {
        const c = newId(len);
        if (!usedIds.has(c)) { usedIds.add(c); return c; }
      }
      throw new Error("Could not generate a unique id");
    };

    interface Plan { file: TFile; addId: boolean; addParent: boolean; addCreated: boolean; }
    const plan: Plan[] = [];
    for (const f of allMd) {
      const dir = f.parent?.path?.replace(/\/+$/, "") ?? "";
      if (!stashpadFolders.has(dir)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown; parent?: unknown; created?: unknown } | undefined;
      const idStr = typeof fm?.id === "string" ? fm.id.trim() : "";
      const p = fm?.parent;
      const hasParent = typeof p === "string" ? p.trim() !== "" : (p !== undefined && p !== null);
      const hasCreated = typeof fm?.created === "string" && fm.created.trim() !== "";
      const addId = !idStr;
      const addParent = !hasParent;
      const addCreated = !hasCreated;
      if (!addId && !addParent && !addCreated) continue;
      plan.push({ file: f, addId, addParent, addCreated });
    }

    if (plan.length === 0) {
      new Notice("Nothing to fix — every note in a Stashpad folder already has id + parent + created.");
      return;
    }

    let fixed = 0;
    let failed = 0;
    // Kept so the notification can offer a jump to what was adopted.
    const fixedFiles: TFile[] = [];
    const log = this.newLog();
    for (const item of plan) {
      try {
        let stampedId: string | undefined;
        await this.app.fileManager.processFrontMatter(item.file, (m) => {
          if (item.addId) {
            const cur = typeof m.id === "string" ? m.id.trim() : "";
            if (!cur) { stampedId = pickFreshId(); m.id = stampedId; }
          }
          if (item.addParent) {
            const cur = m.parent;
            const set = typeof cur === "string" ? cur.trim() !== "" : (cur !== undefined && cur !== null);
            if (!set) m.parent = ROOT_ID;
          }
          if (item.addCreated) {
            const cur = typeof m.created === "string" ? m.created.trim() : "";
            if (!cur) m.created = new Date(item.file.stat.ctime).toISOString();
          }
        });
        const fmAfter = this.app.metadataCache.getFileCache(item.file)?.frontmatter as
          | { id?: string } | undefined;
        const id = stampedId ?? fmAfter?.id ?? "";
        if (id) {
          await log.append({
            type: "parent_change", id,
            payload: { from: null, to: ROOT_ID, reason: "orphan_fix", path: item.file.path,
              addedId: item.addId, addedParent: item.addParent, addedCreated: item.addCreated },
          });
        }
        fixed++;
        fixedFiles.push(item.file);
      } catch (e) {
        console.warn("Stashpad: orphan fix failed for", item.file.path, e);
        failed++;
      }
    }
    const tail = failed ? ` (${failed} failed — see console)` : "";
    this.notifications.show({
      message: `Fixed ${fixed} note${fixed === 1 ? "" : "s"} in Stashpad folders${tail}.`,
      kind: failed ? "warning" : "success",
      category: "import",
      affectedPaths: fixedFiles.map((f) => f.path),
      actions: this.adoptionJumpActions(fixedFiles),
    });
  }

  async adoptNote(file: TFile): Promise<void> {
    const { newId, readId } = await import("./id-service");

    // Refuse to touch a note that is already a managed note. Adoption exists for
    // files that are NOT Stashpad notes yet - it mints a fresh id and backfills
    // frontmatter - so running it over one that already has an identity is
    // destructive by definition: the new id orphans every child pointing at the
    // old one.
    //
    // This is the belt to suspendFor's braces. Suspension stops the watcher
    // firing during an import; this stops adoption doing damage even if it does
    // fire - from a sync, a script, a future caller, or a version where the
    // suspension is missed.
    const pre = this.app.metadataCache.getFileCache(file)?.frontmatter as
      | { id?: unknown; parent?: unknown; stashpadAppId?: unknown } | undefined;
    // A note the Stashpad-app importer placed. It carries its own id and parent
    // links, and its source id is the thing a re-import matches on.
    if (typeof pre?.stashpadAppId === "string" && pre.stashpadAppId.trim()) return;
    // Or simply a complete note: a usable id AND a parent field present. There
    // is nothing for adoption to add, so there is no reason to risk it.
    const preId = readId(pre?.id)?.trim() ?? "";
    if (preId && !/\s/.test(preId) && pre?.parent !== undefined) return;
    // Build the set of currently-used ids by reading the metadataCache
    // frontmatter for every markdown file in the vault. Cheap — the cache
    // is already populated; we just inspect it.
    const usedIds = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === file.path) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
        | { id?: unknown } | undefined;
      // readId, not typeof: an id YAML turned into a number is still taken.
      const id = readId(fm?.id)?.trim() ?? "";
      if (id) usedIds.add(id);
    }

    // Pick a fresh id that doesn't collide. newId() pulls from a 32-char
    // alphabet at length 6 → ~1 billion possibilities, so collisions are
    // rare; the loop is just defensive.
    const pickFreshId = (): string => {
      for (let i = 0; i < 50; i++) {
        const candidate = newId();
        if (!usedIds.has(candidate)) return candidate;
      }
      // Fall back to a longer id if we somehow can't find a free 6-char one.
      for (let len = 8; len <= 16; len += 2) {
        const candidate = newId(len);
        if (!usedIds.has(candidate)) return candidate;
      }
      throw new Error("Could not generate a unique id");
    };

    let added: string[] = [];
    let kept: string[] = [];
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        // id: must be a non-empty string, no whitespace.
        // THE damage point. A note whose id YAML read back as a NUMBER -
        // 489944 rather than "489944" - failed this check, was treated as
        // unidentified, and had a fresh id minted, orphaning every child that
        // pointed at the old one. readId recognises it, so the note keeps its
        // identity and its children keep their parent.
        const existingId = readId(fm.id)?.trim() ?? "";
        if (!existingId || /\s/.test(existingId) || usedIds.has(existingId)) {
          fm.id = pickFreshId();
          added.push("id");
        } else {
          kept.push("id");
        }
        // parent: missing/blank → ROOT_ID. (null is an explicit, valid value
        // meaning "directly under root" in some legacy notes — we treat it
        // the same as ROOT_ID for new adoptions.)
        const hasParent = fm.parent !== undefined && fm.parent !== null && String(fm.parent).trim() !== "";
        if (!hasParent) {
          fm.parent = ROOT_ID;
          added.push("parent");
        } else {
          kept.push("parent");
        }
        // created: missing/blank → file's ctime as ISO string.
        const hasCreated = typeof fm.created === "string" && fm.created.trim() !== "";
        if (!hasCreated) {
          fm.created = new Date(file.stat.ctime).toISOString();
          added.push("created");
        } else {
          kept.push("created");
        }
      });
    } catch (e) {
      new Notice(`Adopt failed: ${(e as Error).message}`);
      return;
    }

    // Append the id to the filename if it's not already there. Stashpad's
    // own creator emits "<slug>-<id>.md"; matching that lets parseIdFromFilename
    // recover the id from the path even before the metadataCache parses.
    let renamed = false;
    try {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: string } | undefined;
      const id = typeof fm?.id === "string" ? fm.id.trim() : "";
      if (id && file.basename && !file.basename.endsWith(`-${id}`)) {
        const newPath = `${file.parent ? file.parent.path + "/" : ""}${file.basename}-${id}.md`;
        if (!(await this.app.vault.adapter.exists(newPath))) {
          await this.app.fileManager.renameFile(file, newPath);
          renamed = true;
        }
      }
    } catch (e) {
      console.warn("Stashpad: adopt rename failed", e);
    }

    if (added.length === 0 && !renamed) {
      new Notice(`Already a Stashpad note (${kept.join(", ")} present).`);
      return;
    }
    const parts: string[] = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (renamed) parts.push("renamed with id");
    this.notifications.show({
      message: `Adopted \`${file.basename}\` into Stashpad — ${parts.join("; ")}.`,
      kind: "success",
      category: "import",
      folder: file.parent?.path?.replace(/\/+$/, "") ?? undefined,
      affectedPaths: [file.path],
      actions: this.adoptionJumpActions([file]),
    });
    // Nudge any open Stashpad views to re-pick up the file. The metadataCache
    // change will trigger their tree rebuild on its own; this is just for the
    // log.
    try {
      const log = this.newLog();
      const fmAfter = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { id?: string; parent?: string | null } | undefined;
      const id = fmAfter?.id ?? "";
      if (id) {
        await log.append({
          type: "create", id,
          payload: { path: file.path, parent: fmAfter?.parent ?? ROOT_ID, source: "adopt", added },
        });
      }
    } catch { /* ignore */ }
  }
}

/** Coerce drafts state into the new flat shape: Record<folder, string>.
 *  Tolerates missing/wrong types and the old per-focusId nested shape. */
/** Build the unified bindings map. Priority: explicit `bindings` from disk
 *  (validated), then migration from legacy `shortcuts` + `mod`, then
 *  built-in defaults from COMMAND_META. */
function mergeBindings(
  raw: any,
  legacyShortcuts: any,
  legacyMod: any,
): CommandBindingMap {
  const out = buildDefaultBindings();
  // Migrate from legacy first; explicit `bindings` from disk wins below.
  // CRITICAL: only overwrite the default with a NON-EMPTY legacy value.
  // An older settings.json that saved split:"" or copyOutline:"" would
  // otherwise blank out our new defaults on every plugin load.
  for (const m of COMMAND_META) {
    const legacy = legacyShortcuts && typeof legacyShortcuts[m.id] === "string"
      ? legacyShortcuts[m.id]
      : (legacyMod && typeof legacyMod[m.id] === "string" ? legacyMod[m.id] : null);
    if (legacy != null && legacy !== "") out[m.id].primary = legacy;
  }
  if (raw && typeof raw === "object") {
    for (const m of COMMAND_META) {
      let r = raw[m.id];
      // 0.266.1: coerce a BARE STRING binding into the object shape.
      //
      // Found in a real data.json: `move: "Q"` while every other entry was
      // `{primary, secondary, …}`. `matchBinding` destructures `.primary`, so
      // a string yields undefined and the command fires on NOTHING — not the
      // old key, not the new one. It reads as "something hijacked my shortcut"
      // when in fact nothing is listening at all.
      //
      // Skipping it (the previous behaviour) silently reverted the user's
      // choice to the default instead, which is its own quiet wrongness.
      // Coercing keeps what they picked AND makes it work.
      if (typeof r === "string") r = { primary: r, secondary: "", preferRight: false, useBoth: false };
      if (!r || typeof r !== "object") continue;
      out[m.id] = {
        primary: typeof r.primary === "string" ? r.primary : out[m.id].primary,
        secondary: typeof r.secondary === "string" ? r.secondary : "",
        preferRight: !!r.preferRight,
        // 0.73.8: persist `useBoth` across reloads. Missing here meant
        // the settings UI checkbox kept saving the value, but
        // mergeBindings dropped it on the way back in, so reload
        // always reset it to undefined → unchecked.
        useBoth: !!r.useBoth,
      };
    }
  }
  // 0.91.3: one-time upgrade to a NEW default secondary/useBoth (e.g.
  // toggleComplete gaining "X" + both-active). Only applies when the saved
  // binding is the UNTOUCHED old default — same primary, no secondary, not
  // useBoth — so a user who deliberately cleared/changed it is never clobbered.
  for (const m of COMMAND_META) {
    if (!m.defaultSecondary && !m.defaultUseBoth) continue;
    const b = out[m.id];
    if (b.primary === m.defaultPrimary && !b.secondary && !b.useBoth) {
      b.secondary = m.defaultSecondary ?? "";
      b.useBoth = !!m.defaultUseBoth;
    }
  }
  return out;
}

function normalizeDrafts(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [folder, val] of Object.entries(raw)) {
    if (typeof val === "string") {
      out[folder] = val;
    } else if (val && typeof val === "object") {
      // Old shape: collapse nested {focusId: text} → first non-empty text.
      for (const v of Object.values(val as any)) {
        if (typeof v === "string" && v.length > 0) { out[folder] = v; break; }
      }
    }
  }
  return out;
}

/** 0.79.4 / 0.80.1: destination chooser for the Import command. Lists the
 *  Stashpad folders with the current/active one first; picking one opens
 *  the OS file picker into that folder and imports the chosen files. */
interface ImportTarget { label: string; folder: string; current?: boolean }
class ImportTargetModal extends SuggestModal<ImportTarget> {
  constructor(
    app: import("obsidian").App,
    private def: string,
    private folders: string[],
    private onPick: (folder: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a Stashpad folder to import into…");
  }
  getSuggestions(query: string): ImportTarget[] {
    const q = query.toLowerCase();
    // Current folder first, then the rest (deduped), filtered by query.
    const ordered = [this.def, ...this.folders.filter((f) => f !== this.def)];
    return ordered
      .filter((f) => f.toLowerCase().includes(q))
      .map((f) => ({ label: f, folder: f, current: f === this.def }));
  }
  renderSuggestion(item: ImportTarget, el: HTMLElement): void {
    el.createDiv({ text: item.label });
    if (item.current) {
      el.createDiv({ cls: "stashpad-suggest-note", text: "current" });
      el.addClass("is-pinned-import-target");
    }
  }
  onChooseSuggestion(item: ImportTarget): void { this.onPick(item.folder); }
}

/** Picker for the "Decrypt a folder bundle…" command (gap 4): lists every raw-folder
 *  `.stashenc` bundle in the vault so you can decrypt one without finding it manually. */
class FolderBundleSuggest extends SuggestModal<{ folder: string; blobPath: string }> {
  constructor(
    app: import("obsidian").App,
    private bundles: { folder: string; blobPath: string }[],
    private onPick: (b: { folder: string; blobPath: string }) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose an encrypted folder bundle to decrypt…");
  }
  getSuggestions(query: string): { folder: string; blobPath: string }[] {
    const q = query.toLowerCase();
    return this.bundles.filter((b) => b.folder.toLowerCase().includes(q));
  }
  renderSuggestion(item: { folder: string; blobPath: string }, el: HTMLElement): void {
    el.createDiv({ text: item.folder || "(vault root)" });
    el.createDiv({ cls: "stashpad-suggest-note", text: item.blobPath });
  }
  onChooseSuggestion(item: { folder: string; blobPath: string }): void { this.onPick(item); }
}
