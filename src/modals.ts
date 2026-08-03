import { App, Modal, ItemView, WorkspaceLeaf, Platform, moment, Notice, setIcon, type SecretStorage } from "obsidian";
import { splitIntoChunks, SPLIT_MODE_LABELS, type SplitMode } from "./view-helpers";
import { buildTimePickerInto } from "./time-picker";
import { siftMatch } from "./types";
import { generatePassphrase, estimatePasswordStrength } from "./passphrase";
import { newId } from "./id-service";
import { REPEAT_MODES, parseRepeatMode, parseWeekdayList, withWeekdays, parseMonthDayList, withMonthDays, monthDayLabel, WEEKDAY_SHORT, WEEKDAY_INITIAL } from "./recurrence";
import { ComposerAutocomplete } from "./composer-autocomplete";
import { readClipboardText } from "./cross-vault-clipboard";
import { getSettings } from "./settings";
import type { ExportContent } from "./stash-package";
import type { ImportLogEntry } from "./import-log";

export interface AssigneeRef { id: string; name: string }
export interface DuePickResult {
  iso: string | null;
  assignees: AssigneeRef[];
  /** 0.140.0: recurrence + reminder rules (empty string = clear the field).
   *  Present only when the picker showed the "Repeat & reminders" section. */
  repeat?: string;
  repeatMode?: string;
  autoDoneAfter?: string;
  remindEvery?: string;
}
export interface DuePickerOptions {
  /** 0.140.0: show the "Repeat & reminders" section, pre-filled from these. */
  showRecurrence?: boolean;
  currentRepeat?: string;
  currentRepeatMode?: string;
  currentAutoDoneAfter?: string;
  currentRemindEvery?: string;
  /** Known authors to offer in the assignee picker (from the registry). */
  knownAuthors?: AssigneeRef[];
  /** Assignees already on the note, to pre-fill the chips. */
  currentAssignees?: AssigneeRef[];
  /** Modal title. Defaults to "Set due date". The "Assign to" command
   *  opens this same modal with a different title. */
  title?: string;
  /** 0.125.0: hide the "Assign to" section — used by Snooze, which only
   *  reschedules the due date and must not touch assignees. */
  hideAssignees?: boolean;
  /** 0.125.1: quick relative time-adjust presets (e.g. ["5m","1h","1d"]). When
   *  non-empty, a row of +/- buttons nudges the entered date/time by each
   *  amount; a flip toggle switches between adding and subtracting. */
  quickAdjusts?: string[];
}

/** 0.155.0: fallback quick-adjust presets. Mirrors DEFAULT_SETTINGS.dueQuickAdjusts.
 *  Used when a caller passes no `quickAdjusts` so the +/- row shows from EVERY
 *  entry point (the row used to silently vanish when a call site — e.g. Assign —
 *  forgot to pass the option). A caller can still explicitly pass `[]` to hide it. */
export const DEFAULT_QUICK_ADJUSTS = ["5m", "15m", "30m", "1h", "1d", "1w"];

/** 0.125.1: parse a compact duration token ("5m", "15m", "1h", "2d", "1w") into
 *  minutes. Returns null when unparseable so callers can skip bad presets. */
export function parseAdjustMinutes(raw: string): number | null {
  const m = /^\s*(\d+)\s*(m|h|d|w)\s*$/i.exec(raw);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = { m: 1, h: 60, d: 1440, w: 10080 }[m[2].toLowerCase()] ?? 1;
  return n * unit;
}
import { renderInlineMarkup } from "./notifications";
import type { NotificationCategory, NotificationRecord, NotificationService } from "./notifications";
// Obsidian types `moment` as the namespace (not callable); a callable view.
const momentFn = moment as unknown as (...args: unknown[]) => moment.Moment;

interface LogEv { ts: string; type: string; id: string; payload?: any; author?: string; }

export class LogModal extends Modal {
  private events: LogEv[] = [];
  /** Currently-displayed slice of events (events filtered by typeFilter,
   *  if set). Pagination + render counts always go through this. */
  private visible: LogEv[] = [];
  private shownCount = 0;
  private typeFilter: string | null = null;
  private listEl: HTMLDivElement | null = null;
  private footerEl: HTMLDivElement | null = null;
  private countEl: HTMLSpanElement | null = null;
  private filterSelEl: HTMLSelectElement | null = null;
  private static PAGE = 100;

  constructor(app: App, private text: string, private jsonlPath: string) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Stashpad log");
    this.modalEl.addClass("stashpad-log-modal");

    this.events = [];
    for (const line of this.text.trim().split(/\r?\n/)) {
      if (!line) continue;
      try { this.events.push(JSON.parse(line)); } catch { /* ignore */ }
    }
    this.events.reverse();

    const toolbar = this.contentEl.createDiv({ cls: "stashpad-log-toolbar" });
    this.countEl = toolbar.createSpan({ cls: "stashpad-log-count" });
    this.updateCount();

    // Type filter dropdown. Built lazily here, repopulated by
    // refreshTypeFilter whenever events change (e.g. after Clear log).
    this.filterSelEl = toolbar.createEl("select", { cls: "stashpad-log-type-filter" });
    this.filterSelEl.onchange = () => this.setTypeFilter(this.filterSelEl!.value || null);
    this.refreshTypeFilter();

    // Reveal/Open shell out via electron, which doesn't exist on mobile — only
    // offer them on desktop (the Copy button below covers mobile). 0.140.17
    if (!Platform.isMobile) {
      const revealBtn = toolbar.createEl("button", { text: "Reveal JSONL" });
      revealBtn.onclick = () => this.shellAct("reveal");
      const openBtn = toolbar.createEl("button", { text: "Open in default app" });
      openBtn.onclick = () => this.shellAct("open");
    }

    const copyBtn = toolbar.createEl("button", { text: "Copy raw JSONL" });
    let copyResetTimer: number | null = null;
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(this.text);
      copyBtn.setText("Copied");
      if (copyResetTimer != null) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => { copyBtn.setText("Copy raw JSONL"); copyResetTimer = null; }, 1500);
    };

    const exportBtn = toolbar.createEl("button", { text: "Export copy" });
    exportBtn.onclick = () => this.exportCopy();

    const clearBtn = toolbar.createEl("button", { cls: "mod-warning", text: "Clear log" });
    clearBtn.onclick = () => this.clearLog();

    this.listEl = this.contentEl.createDiv({ cls: "stashpad-log-list" });
    this.refreshList();

    this.footerEl = this.contentEl.createDiv({ cls: "stashpad-log-footer" });
    this.renderFooter();
  }

  /** Recompute `visible` from `events` + `typeFilter`, then re-render
   *  the list from scratch (resetting pagination). */
  private refreshList(): void {
    if (!this.listEl) return;
    this.visible = this.typeFilter
      ? this.events.filter((ev) => ev.type === this.typeFilter)
      : this.events.slice();
    this.shownCount = 0;
    this.listEl.empty();
    if (!this.visible.length) {
      this.listEl.createDiv({
        cls: "stashpad-log-empty",
        text: this.typeFilter ? `No "${this.typeFilter}" events.` : "No events yet.",
      });
      this.updateCount();
      return;
    }
    this.appendMore(LogModal.PAGE);
  }

  private setTypeFilter(type: string | null): void {
    if ((this.typeFilter ?? null) === (type ?? null)) return;
    this.typeFilter = type;
    this.refreshList();
    this.renderFooter();
  }

  /** Rebuild the type-filter dropdown options from the current events.
   *  Called on first render and after Clear log. */
  private refreshTypeFilter(): void {
    if (!this.filterSelEl) return;
    const sel = this.filterSelEl;
    sel.empty();
    const counts = new Map<string, number>();
    for (const ev of this.events) counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const all = sel.createEl("option", { text: `All types (${this.events.length})` });
    all.value = "";
    for (const [type, n] of entries) {
      const opt = sel.createEl("option", { text: `${type} (${n})` });
      opt.value = type;
    }
    // If the previously-selected filter no longer applies (e.g. its
    // type was cleared away), drop it.
    if (this.typeFilter && !counts.has(this.typeFilter)) {
      this.typeFilter = null;
    }
    sel.value = this.typeFilter ?? "";
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const total = this.visible.length;
    const labelTotal = this.typeFilter
      ? `${total} ${this.typeFilter} event${total === 1 ? "" : "s"}`
      : `${total} event${total === 1 ? "" : "s"}`;
    if (this.shownCount === 0 || this.shownCount >= total) {
      this.countEl.setText(labelTotal);
    } else {
      this.countEl.setText(`Showing ${this.shownCount} of ${labelTotal}`);
    }
  }

  private appendMore(n: number): void {
    if (!this.listEl) return;
    const stop = Math.min(this.visible.length, this.shownCount + n);
    for (let i = this.shownCount; i < stop; i++) {
      this.listEl.appendChild(this.renderEvent(this.visible[i]));
    }
    this.shownCount = stop;
    this.updateCount();
  }

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.empty();
    // Pagination math now runs against the FILTERED set (visible).
    const remaining = this.visible.length - this.shownCount;
    if (remaining <= 0) return;
    const moreBtn = this.footerEl.createEl("button", {
      text: `Load ${Math.min(LogModal.PAGE, remaining)} more`,
    });
    moreBtn.onclick = () => { this.appendMore(LogModal.PAGE); this.renderFooter(); };
    if (remaining > LogModal.PAGE) {
      const allBtn = this.footerEl.createEl("button", { text: `Load all (${remaining})` });
      allBtn.onclick = () => { this.appendMore(remaining); this.renderFooter(); };
    }
  }

  private shellAct(kind: "reveal" | "open"): void {
    try {
      const full = (this.app.vault.adapter as any).getFullPath?.(this.jsonlPath);
      if (!full) throw new Error("no full path");
       
      const { shell } = (window as any).require("electron");
      if (kind === "reveal") shell.showItemInFolder(full);
      else shell.openPath(full);
    } catch (e) {
      new Notice(`Couldn't ${kind}: ${(e as Error).message}`);
    }
  }

  /** Write the current log content to <log-dir>/<timestamp>-log.jsonl —
   *  same directory as the active log so the copy lives next to its
   *  source. Derived from this.jsonlPath rather than hardcoded. */
  private async exportCopy(): Promise<string | null> {
    try {
      const stamp = (moment as any)().format("YYYY-MM-DD_HHmmss");
      const dir = this.jsonlPath.replace(/\/[^/]+$/, "") || "";
      const exportPath = dir ? `${dir}/${stamp}-log.jsonl` : `${stamp}-log.jsonl`;
      await this.app.vault.adapter.write(exportPath, this.text);
      new Notice(`Exported log → ${exportPath}`);
      return exportPath;
    } catch (e) {
      new Notice(`Export failed: ${(e as Error).message}`);
      return null;
    }
  }

  private clearLog(): void {
    new ConfirmModal(
      this.app,
      "Clear log?",
      "A timestamped copy will be saved alongside the active log before it's truncated.",
      "Export & clear",
      async (ok) => {
        if (!ok) return;
        const exported = await this.exportCopy();
        if (!exported) return; // bail if export failed; don't risk data loss
        try {
          await this.app.vault.adapter.write(this.jsonlPath, "");
        } catch (e) {
          new Notice(`Clear failed: ${(e as Error).message}`);
          return;
        }
        this.text = "";
        this.events = [];
        this.typeFilter = null;
        this.shownCount = 0;
        // Rebuild the dropdown so it shows just "All types (0)" again
        // and resets to that option.
        this.refreshTypeFilter();
        // refreshList renders the empty state and resets counts.
        this.refreshList();
        if (this.footerEl) this.footerEl.empty();
        new Notice("Log cleared.");
      },
      "Cancel",
      /*dangerous*/ true,
    ).open();
  }

  private renderEvent(ev: LogEv): HTMLElement {
    const row = document.createElement("div");
    row.className = `stashpad-log-row stashpad-log-${ev.type}`;

    const when = (moment as any)(ev.ts).isValid()
      ? (moment as any)(ev.ts).format("YYYY-MM-DD HH:mm:ss")
      : ev.ts;

    const ts = document.createElement("span");
    ts.className = "stashpad-log-ts";
    ts.textContent = when;
    row.appendChild(ts);

    const type = document.createElement("span");
    type.className = "stashpad-log-type";
    type.textContent = ev.type;
    row.appendChild(type);

    // Author column — author of THIS log entry (not the note's author).
    // For "create" actions this is the same as the note's author; for
    // "parent_change", "rename", "delete", etc., it tells you who
    // performed the action regardless of who originally created the
    // note. Older log lines without this field render as "—" so the
    // column stays aligned.
    const author = document.createElement("span");
    author.className = "stashpad-log-author";
    author.textContent = ev.author ? ev.author : "—";
    if (!ev.author) author.classList.add("is-empty");
    row.appendChild(author);

    const msg = document.createElement("span");
    msg.className = "stashpad-log-msg";
    msg.textContent = this.describe(ev);
    row.appendChild(msg);

    return row;
  }

  private describe(ev: LogEv): string {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case "create": return `Created "${p.path ?? ev.id}" under ${p.parent ?? "?"}`;
      case "delete": {
        const atts = Array.isArray(p.attachmentsRemoved) ? p.attachmentsRemoved.length : 0;
        const merged = p.mergedInto ? ` (merged into ${p.mergedInto})` : "";
        const toTrash = p.to === "trash" ? " → Trash" : "";
        return `Deleted ${ev.id}${toTrash}${merged}${atts ? ` — also removed ${atts} attachment${atts === 1 ? "" : "s"}` : ""}`;
      }
      case "missing": return `Missing: ${p.lastPath ?? ev.id}`;
      case "parent_change": {
        const reason = p.reason ? ` (${p.reason})` : "";
        return `Moved ${ev.id} from ${p.from ?? "null"} → ${p.to ?? "null"}${reason}`;
      }
      case "rename": return `Renamed ${p.from ?? "?"} → ${p.to ?? "?"}`;
      case "reorder": {
        const n = p.count ?? 1;
        const dir = p.dir ?? "?";
        const parent = p.parent ?? ev.id ?? "?";
        return `Reordered ${n} note${n === 1 ? "" : "s"} (${dir}) under ${parent}`;
      }
      case "complete": {
        const n = p.count ?? 1;
        const tag = p.undo ? " (undo)" : p.redo ? " (redo)" : "";
        return `Marked ${n} note${n === 1 ? "" : "s"} complete${tag}`;
      }
      case "uncomplete": {
        const n = p.count ?? 1;
        const tag = p.undo ? " (undo)" : p.redo ? " (redo)" : "";
        return `Unmarked ${n} note${n === 1 ? "" : "s"}${tag}`;
      }
      case "stash_export": {
        const n = p.noteCount ?? "?";
        return `Exported ${n} note${n === 1 ? "" : "s"} → ${p.path ?? "?"}`;
      }
      case "stash_import": {
        const n = p.noteCount ?? "?";
        const extras: string[] = [];
        if (p.attachmentsWritten) extras.push(`${p.attachmentsWritten} attachment${p.attachmentsWritten === 1 ? "" : "s"}`);
        if (p.collisionsRenamed) extras.push(`${p.collisionsRenamed} renamed`);
        const tail = extras.length ? ` (${extras.join(", ")})` : "";
        return `Imported ${n} note${n === 1 ? "" : "s"} from ${p.from ?? "?"} → ${p.into ?? "?"}${tail}`;
      }
      case "attachment_add": return `Added attachment ${p.path ?? ev.id}`;
      case "attachment_remove": return `Removed attachment ${p.path ?? ev.id}`;
      case "palette_color_add": return `Added palette color ${p.color ?? ev.id}`;
      case "palette_color_remove": return `Removed palette color ${p.color ?? ev.id}`;
      case "lock": return `Locked (encrypted) ${ev.id}`;
      case "unlock": return `Unlocked ${ev.id}`;
      case "archive": return `Archived ${ev.id}${p.to ? ` → ${p.to}` : ""}${p.encrypted === false ? " (plaintext)" : ""}`;
      case "restore": return `Restored ${ev.id}${p.to ? ` → ${p.to}` : ""} from trash`;
      default: return JSON.stringify(p);
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

export class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private noteTitle: string,
    private descendantCount: number,
    private attachmentCount: number,
    /** When false, the "Also delete attachments" checkbox is suppressed
     *  and onChoose is invoked with deleteAttachments=false. Lets the
     *  caller open the modal purely for descendant/multi-select
     *  confirmation while honoring the "Offer to delete attachments"
     *  setting being OFF. */
    private offerAttachmentDelete: boolean,
    private onChoose: (deleteAttachments: boolean) => void,
  ) { super(app); }

  onOpen(): void {
    // 0.76.18: size the modal to its content instead of Obsidian's
    // default tall box — the delete confirm is just a sentence + two
    // buttons, and the empty space read as oversized on mobile.
    this.modalEl?.addClass("stashpad-compact-modal");
    this.contentEl.empty();
    this.titleEl.setText(`Delete "${this.noteTitle}"?`);
    const parts: string[] = [];
    if (this.descendantCount > 0) parts.push(`${this.descendantCount} descendant note${this.descendantCount === 1 ? "" : "s"} will also be deleted.`);
    if (this.attachmentCount > 0) parts.push(`${this.attachmentCount} attachment${this.attachmentCount === 1 ? "" : "s"} found across these notes.`);
    this.contentEl.createEl("p", { text: parts.join(" ") });

    let deleteAtts = this.offerAttachmentDelete && this.attachmentCount > 0;
    if (this.offerAttachmentDelete && this.attachmentCount > 0) {
      const label = this.contentEl.createEl("label", { cls: "stashpad-modal-check" });
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = deleteAtts;
      cb.onchange = () => { deleteAtts = cb.checked; };
      label.createSpan({ text: " Also delete attachments" });
    }

    const row = this.contentEl.createDiv({ cls: "stashpad-modal-btns" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const del = row.createEl("button", { cls: "mod-warning", text: "Delete" });
    del.onclick = () => { this.close(); this.onChoose(deleteAtts); };
  }
  onClose(): void { this.contentEl.empty(); }
}

/** 0.168.1: word-level diff (LCS over whitespace-delimited tokens) for the split
 *  modal's read-only "Changes" panel. Returns runs of equal / inserted / deleted
 *  text; whitespace is kept as its own tokens so the reconstruction reads naturally
 *  (newlines included, rendered with `white-space: pre-wrap`). */
type SplitDiffPart = { t: "eq" | "ins" | "del"; s: string };
function splitWordDiff(a: string, b: string): SplitDiffPart[] {
  const ax = a.split(/(\s+)/);
  const bx = b.split(/(\s+)/);
  const n = ax.length, m = bx.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ax[i] === bx[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: SplitDiffPart[] = [];
  const push = (t: SplitDiffPart["t"], s: string): void => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s; else out.push({ t, s });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ax[i] === bx[j]) { push("eq", ax[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", ax[i]); i++; }
    else { push("ins", bx[j]); j++; }
  }
  while (i < n) { push("del", ax[i]); i++; }
  while (j < m) { push("ins", bx[j]); j++; }
  return out;
}

/** 0.169.0: the split UI's live state — carried to the popped-out tab so it
 *  continues where the modal left off. */
export interface WorkbenchState {
  /** 0.170.0: top-level surface — plain Edit, or the Split methods. Shares text. */
  surface: "edit" | "split";
  mode: "line" | "cursor" | "preset";
  presetMode: SplitMode;
  nest: boolean;
  cursorText: string;
  lineCursorIdx: number;
}

export interface WorkbenchCallbacks {
  onSplitAtLine: (firstLineOfSecondPart: number, nest: boolean) => void | Promise<void>;
  onSplitAtChar: (text: string, charIndex: number, nest: boolean) => void | Promise<void>;
  onSplitMany: (parts: string[], nest: boolean) => void | Promise<void>;
  /** 0.170.0: Edit surface — write the edited body back to the note. */
  onSave: (text: string) => void | Promise<void>;
  /** 0.170.1: open the note in a full Obsidian markdown tab (leaves the modal). */
  onOpenExternal?: () => void;
  /** Dismiss the host WITHOUT committing (Cancel / Esc). */
  close: () => void;
  /** Called AFTER a successful commit/save — the host decides what happens (the
   *  modal closes; the popped-out tab runs a countdown then closes + refocuses). */
  onDone: () => void;
  /** Host hook to reflect the current surface in its title. */
  onTitle?: (title: string) => void;
  /** When present, an "Open in a tab" button appears; called with the live state. */
  popOut?: (state: WorkbenchState) => void;
  /** 0.185.0: import a pasted/dropped file as an attachment and return its
   *  `![[wikilink]]` (or null). Wired to the view's `importAttachment` so the
   *  edit/split textarea gets the composer's paste-a-file-as-a-link behaviour. */
  onImportFile?: (file: File) => Promise<string | null>;
}

/** 0.169.0: the split UI extracted from the modal so it can render into EITHER a
 *  modal or a full leaf ("pop out"). Owns all state + rendering; the host wires
 *  keys to `commit()` / `moveDivider()`. */
/** 0.170.3: case transforms for the edit surface's cycle button. */
function applyCase(s: string, form: "lower" | "upper" | "title" | "sentence"): string {
  switch (form) {
    case "lower": return s.toLowerCase();
    case "upper": return s.toUpperCase();
    case "title": return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    case "sentence": return s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase());
  }
}

export class NoteWorkbench {
  private lines: string[];
  private lineCursorIdx: number;
  private surface: "edit" | "split" = "split";
  private mode: "line" | "cursor" | "preset" = "line";
  private presetMode: SplitMode = "paragraphs";
  private nest = false;
  private cursorTextarea: HTMLTextAreaElement | null = null;
  /** 0.185.0: composer-parity autocomplete bound to the live editor textarea.
   *  Recreated on each render (surface/mode switch rebuilds the textarea); the
   *  old instance is detached first so listeners don't leak. */
  private autocomplete: ComposerAutocomplete | null = null;
  private cursorText: string;
  private collapsed: { orig: boolean; changes: boolean; edit: boolean };

  constructor(
    private app: App,
    private host: HTMLElement,
    private body: string,
    init: Partial<WorkbenchState>,
    private cb: WorkbenchCallbacks,
  ) {
    this.cursorText = init.cursorText ?? body;
    this.collapsed = { orig: Platform.isMobile, changes: Platform.isMobile, edit: false };
    this.lines = body.replace(/\r\n/g, "\n").split("\n");
    this.lineCursorIdx = init.lineCursorIdx ?? Math.max(1, Math.min(this.lines.length - 1, Math.floor(this.lines.length / 2)));
    if (init.mode) this.mode = init.mode;
    else if (this.lines.length < 2) this.mode = "cursor"; // single-line → cursor only
    if (init.presetMode) this.presetMode = init.presetMode;
    if (init.nest != null) this.nest = init.nest;
    if (init.surface) this.surface = init.surface;
    // 0.169.4: wrap Tab focus within the split content — Shift+Tab on the first
    // control jumps to the last, Tab on the last wraps to the first (rather than
    // escaping to the modal × or getting stuck).
    this.host.addEventListener("keydown", (e) => this.onTabKey(e));
    this.render();
  }

  private visibleFocusables(): HTMLElement[] {
    const sel = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(this.host.querySelectorAll<HTMLElement>(sel)).filter((el) => el.offsetParent !== null);
  }

  private onTabKey(e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    const items = this.visibleFocusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  /** Snapshot for handoff to the popped-out tab. */
  getState(): WorkbenchState {
    return {
      surface: this.surface,
      mode: this.mode, presetMode: this.presetMode, nest: this.nest,
      cursorText: this.cursorTextarea?.value ?? this.cursorText,
      lineCursorIdx: this.lineCursorIdx,
    };
  }

  /** 0.185.0: give the live editor textarea composer parity — `[[` / `#` / `@`
   *  autocomplete plus paste/drop of files as `![[wikilink]]` attachments. Called
   *  from each textarea-creation site; re-entrant (detaches any prior autocomplete
   *  first, since render() rebuilds the textarea on surface/mode switches). */
  private enhanceTextarea(ta: HTMLTextAreaElement): void {
    this.autocomplete?.detach();
    // 0.202.0: in the workbench, Mod+Enter commits — every other Enter is a
    // newline, so list continuation always applies.
    this.autocomplete = new ComposerAutocomplete(this.app, ta, { insertsNewline: () => true });
    this.autocomplete.attach();

    const imp = this.cb.onImportFile;
    if (!imp) return; // no import hook (e.g. new-note composer path) → autocomplete only
    // Insert imported attachment link(s) at the caret (not appended — this is an
    // editor, the cursor is meaningful), then fire `input` so fit()/diff resync.
    const insertLinks = async (files: File[]): Promise<void> => {
      let chunk = "";
      for (const f of files) {
        const link = await imp(f);
        if (link) chunk += (chunk ? "\n" : "") + link;
      }
      if (!chunk) return;
      const start = ta.selectionStart, end = ta.selectionEnd;
      const before = ta.value.slice(0, start), after = ta.value.slice(end);
      const sep = before && !before.endsWith("\n") ? "\n" : "";
      const inserted = sep + chunk + "\n";
      ta.value = before + inserted + after;
      this.cursorText = ta.value;
      const caret = before.length + inserted.length;
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event("input"));
      ta.focus();
    };
    ta.addEventListener("paste", (e) => {
      const data = e.clipboardData;
      if (!data) return;
      const out: File[] = [];
      for (const f of Array.from(data.files ?? [])) out.push(f);
      if (out.length === 0) {
        for (const it of Array.from(data.items ?? [])) {
          if (it.kind === "file") { const f = it.getAsFile(); if (f) out.push(f); }
        }
      }
      if (out.length === 0) return; // pure text paste — let it through natively
      e.preventDefault();
      e.stopPropagation();
      void insertLinks(out);
    });
    ta.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = "copy"; } catch { /* ignore */ }
    });
    ta.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void insertLinks(files);
    });
  }

  /** Detach the autocomplete + its document/vault listeners. Hosts call this on
   *  close so the popup listeners don't outlive the modal/tab. */
  /** 0.207.0: line-number gutter for the editor.
   *
   *  A `<textarea>` has no gutter and no way to ask where a line was drawn, so
   *  the numbers are positioned by MEASUREMENT: a hidden mirror with the
   *  textarea's exact width, font and padding renders each logical line, and
   *  each number is given that line's real height. That's what makes the
   *  numbers stay aligned when a long line SOFT-WRAPS across several rows —
   *  the naive one-row-per-line gutter drifts out of alignment the moment any
   *  line wraps, which in a note editor is immediately.
   *
   *  Desktop only: on a phone the gutter costs width the editor needs more. */
  private attachLineNumbers(wrap: HTMLElement, ta: HTMLTextAreaElement): void {
    if (Platform.isMobile) return;
    if (!getSettings().showEditorLineNumbers) return;
    const doc = wrap.ownerDocument ?? document;
    const gutter = doc.createElement("div");
    gutter.className = "stashpad-edit-gutter";
    gutter.setAttribute("aria-hidden", "true"); // decorative; the text is the content
    wrap.insertBefore(gutter, ta);

    const mirror = doc.createElement("div");
    mirror.className = "stashpad-edit-mirror";
    doc.body.appendChild(mirror);

    const paint = (): void => {
      const cs = getComputedStyle(ta);
      // Match every property that affects where a line breaks.
      mirror.style.font = cs.font;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.paddingLeft = cs.paddingLeft;
      mirror.style.paddingRight = cs.paddingRight;
      mirror.style.width = `${ta.clientWidth}px`;
      mirror.style.tabSize = cs.tabSize;
      gutter.style.paddingTop = cs.paddingTop;
      gutter.style.lineHeight = cs.lineHeight;
      gutter.style.fontSize = cs.fontSize;
      // A DEFINITE height is what makes the gutter scrollable in lockstep: left
      // to stretch, it grows to fit all its numbers, so it never overflows
      // (scrollTop pins at 0 and the numbers desync from a scrolling textarea)
      // AND it drags the whole modal taller on a long note.
      gutter.style.height = `${ta.clientHeight}px`;

      const lines = ta.value.split("\n");
      mirror.empty();
      const rows: HTMLElement[] = [];
      for (const line of lines) {
        const row = mirror.createDiv();
        // A zero-width space keeps an empty line one row tall instead of zero.
        row.textContent = line.length ? line : "\u200b";
        rows.push(row);
      }
      gutter.empty();
      for (let i = 0; i < lines.length; i++) {
        const n = gutter.createDiv({ cls: "stashpad-edit-lineno", text: String(i + 1) });
        n.style.height = `${rows[i].offsetHeight}px`;
      }
    };

    const syncScroll = (): void => { gutter.scrollTop = ta.scrollTop; };
    const onInput = (): void => { paint(); syncScroll(); };
    ta.addEventListener("input", onInput);
    ta.addEventListener("scroll", syncScroll);
    // Width changes rewrap every line, so the heights must be remeasured.
    const ro = new ResizeObserver(() => { paint(); syncScroll(); });
    ro.observe(ta);
    requestAnimationFrame(paint);

    this.lineNumberCleanups.push(() => {
      ta.removeEventListener("input", onInput);
      ta.removeEventListener("scroll", syncScroll);
      ro.disconnect();
      mirror.remove();
    });
  }

  private lineNumberCleanups: Array<() => void> = [];

  destroy(): void {
    this.autocomplete?.detach();
    this.autocomplete = null;
    for (const off of this.lineNumberCleanups) { try { off(); } catch { /* ignore */ } }
    this.lineNumberCleanups = [];
  }

  /** 0.168.3: single dispatch for the Split button + Mod+Enter. 0.169.3: awaits the
   *  split, then calls onDone so the host can act once the job is complete. */
  async commit(): Promise<void> {
    if (this.surface === "edit") { await this.saveEdit(); return; }
    if (this.mode === "line") await this.commitLine();
    else if (this.mode === "cursor") await this.commitCursor();
    else await this.commitPreset();
  }

  private async saveEdit(): Promise<void> {
    const ta = this.cursorTextarea;
    if (!ta) return;
    await this.cb.onSave(ta.value);
    this.cb.onDone();
  }

  /** 0.170.5: the current text differs from the note's original body → unsaved. */
  isDirty(): boolean {
    return (this.cursorTextarea?.value ?? this.cursorText) !== this.body;
  }

  /** 0.170.3: switch surface (Mod+E / Mod+S host shortcuts). No-op if already there. */
  setSurface(s: "edit" | "split"): void {
    if (this.surface === s) return;
    this.surface = s;
    this.render();
  }

  /** Move the line-mode divider by ±1. Returns true if it applied (split
   *  surface, line mode). Returning false lets the key through untouched.
   *
   *  0.202.1: the SURFACE guard is the important one. `mode` defaults to
   *  "line" and is independent of `surface`, so on the EDIT surface ArrowUp/
   *  ArrowDown still reached here, moved an invisible divider, and called
   *  render() — which rebuilds the editor and re-seeds the caret to the END of
   *  the text (edit-surface default). Net effect: pressing ↑ while editing
   *  teleported the cursor to the end instead of moving up a line. The divider
   *  only exists on the split surface; never touch arrows anywhere else. */
  moveDivider(delta: number): boolean {
    if (this.surface !== "split") return false;
    if (this.mode !== "line") return false;
    this.lineCursorIdx = Math.max(1, Math.min(this.lines.length - 1, this.lineCursorIdx + delta));
    this.render();
    return true;
  }

  private async commitLine(): Promise<void> {
    await this.cb.onSplitAtLine(this.lineCursorIdx, this.nest);
    this.cb.onDone();
  }

  private async commitCursor(): Promise<void> {
    const ta = this.cursorTextarea;
    if (!ta) return;
    const ch = ta.selectionStart;
    if (ch <= 0 || ch >= ta.value.length) {
      new Notice("Move the cursor inside the text — neither end can be empty.");
      return;
    }
    // 0.168.0: split the CURRENT (possibly edited) textarea content at the cursor.
    await this.cb.onSplitAtChar(ta.value, ch, this.nest);
    this.cb.onDone();
  }

  private async commitPreset(): Promise<void> {
    const chunks = splitIntoChunks(this.body, this.presetMode);
    if (chunks.length < 2) { new Notice("That delimiter wouldn't split this note."); return; }
    await this.cb.onSplitMany(chunks, this.nest);
    this.cb.onDone();
  }

  private render(): void {
    // The textarea (and its bound autocomplete) is discarded on every rebuild;
    // detach first so listeners don't accumulate. enhanceTextarea re-attaches
    // when the new render creates a cursor textarea.
    this.autocomplete?.detach();
    this.autocomplete = null;
    this.host.empty();
    this.host.toggleClass("stashpad-edit-surface", this.surface === "edit");
    this.cb.onTitle?.(this.surface === "edit" ? "Edit note" : "Split note");
    this.renderSurfaceToggle();
    if (this.surface === "edit") { this.renderEditSurface(); return; }
    this.renderSplitSurface();
  }

  /** 0.170.0: top-level Edit ⇄ Split toggle. Both surfaces share the text buffer,
   *  so edits carry over when you switch and the split acts on what you edited. */
  private renderSurfaceToggle(): void {
    const row = this.host.createDiv({ cls: "stashpad-split-surface" });
    const modKey = Platform.isMacOS ? "⌘" : "Ctrl+";
    const mk = (label: string, s: "edit" | "split", icon: string, key: string): void => {
      const b = row.createEl("button", { cls: "stashpad-split-surface-btn" });
      setIcon(b.createSpan({ cls: "stashpad-split-btn-icon" }), icon);
      b.createSpan({ text: label });
      b.createSpan({ cls: "stashpad-split-kbd-hint", text: `${modKey}${key}` });
      b.toggleClass("is-active", this.surface === s);
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => this.setSurface(s);
    };
    mk("Edit", "edit", "pencil-line", "E");
    mk("Split", "split", "split", "S");
  }

  /** 0.170.0: "Open in a tab" — hand the live state to a full leaf. Only the modal
   *  provides popOut (the tab omits it). */
  private renderPopOut(actions: HTMLElement): void {
    if (!this.cb.popOut) return;
    const pop = actions.createEl("button", { cls: "stashpad-split-popout-btn" });
    setIcon(pop.createSpan({ cls: "stashpad-split-popout-icon" }), "maximize-2");
    pop.createSpan({ text: Platform.isMobile ? "Pop-out" : "Open in a tab" });
    pop.setAttr("aria-label", "Open in a full tab");
    pop.onmousedown = (e) => e.preventDefault();
    pop.onclick = () => this.cb.popOut!(this.getState());
  }

  /** 0.201.2: leave for Obsidian's editor, SAVING first. The old flow opened
   *  the tab immediately and only then hit the dirty guard — so the discard
   *  prompt appeared over an already-opened (stale) tab. Now: unsaved edits
   *  are written silently, then the up-to-date note opens; no prompt. */
  async openExternalSaving(): Promise<void> {
    if (!this.cb.onOpenExternal) return;
    if (this.isDirty()) {
      try { await this.cb.onSave(this.cursorTextarea?.value ?? this.cursorText); }
      catch (e) { console.warn("[Stashpad] save-before-open failed", e); new Notice("Couldn't save the edits — not opening. See console."); return; }
    }
    this.cb.onOpenExternal();
    this.cb.onDone(); // committing close — the dirty guard must not fire
  }

  /** 0.170.1: leave for a full Obsidian markdown editor tab. */
  private renderOpenExternal(actions: HTMLElement): void {
    if (!this.cb.onOpenExternal) return;
    const b = actions.createEl("button", { cls: "stashpad-split-popout-btn" });
    setIcon(b.createSpan({ cls: "stashpad-split-popout-icon" }), "pencil");
    b.createSpan({ text: Platform.isMobile ? "Advanced" : "Obsidian editor" });
    b.setAttr("aria-label", "Open in a full Obsidian editor tab (saves your edits first)");
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { void this.openExternalSaving(); };
  }

  /** 0.170.0: plain editing — the shared Original/Changes/editor sections + a Save. */
  private renderEditSurface(): void {
    this.renderEditorSections();

    // 0.170.3: edit tools — live word/char count + a case-cycle button.
    const tools = this.host.createDiv({ cls: "stashpad-split-edit-tools" });
    const count = tools.createSpan({ cls: "stashpad-split-count" });
    const updateCount = (): void => {
      const t = this.cursorTextarea?.value ?? "";
      const words = (t.trim().match(/\S+/g) || []).length;
      // 0.207.0: lines alongside words/chars. Counted as LOGICAL lines (what
      // you typed), not wrapped rows — matching the gutter beside the editor.
      const lines = t === "" ? 0 : t.split("\n").length;
      count.setText(`${lines} line${lines === 1 ? "" : "s"} · ${words} word${words === 1 ? "" : "s"} · ${t.length} char${t.length === 1 ? "" : "s"}`);
    };
    const caseBtn = tools.createEl("button", { cls: "stashpad-split-case-btn" });
    setIcon(caseBtn.createSpan({ cls: "stashpad-split-btn-icon" }), "case-sensitive");
    caseBtn.createSpan({ text: "Case" });
    caseBtn.setAttr("aria-label", "Cycle case of the selection (or all text): lower → UPPER → Title → Sentence");
    caseBtn.onmousedown = (e) => e.preventDefault();
    caseBtn.onclick = () => this.cycleCase(updateCount);
    this.cursorTextarea?.addEventListener("input", updateCount);
    updateCount();

    const help = this.host.createDiv({ cls: "stashpad-split-help" });
    if (!Platform.isPhone) help.setText("Edit the note, then Save.  ·  ⌘/Ctrl+Enter or Save to write  ·  ⌘/Ctrl+S → Split  ·  Esc discards.");
    const actions = this.host.createDiv({ cls: "stashpad-split-actions" });
    const cancel = actions.createEl("button", { cls: "stashpad-split-cancel-btn" });
    setIcon(cancel.createSpan({ cls: "stashpad-split-btn-icon" }), "x");
    cancel.createSpan({ text: "Cancel" });
    cancel.createSpan({ cls: "stashpad-split-esc-hint", text: " (Esc)" });
    cancel.onmousedown = (e) => e.preventDefault();
    cancel.onclick = () => this.cb.close();
    this.renderPopOut(actions);
    this.renderOpenExternal(actions);
    const right = actions.createDiv({ cls: "stashpad-split-actions-right" });
    const saveBtn = right.createEl("button", { cls: "stashpad-split-confirm-btn mod-cta" });
    setIcon(saveBtn.createSpan({ cls: "stashpad-split-btn-icon" }), "save");
    saveBtn.createSpan({ text: "Save" });
    saveBtn.onmousedown = (e) => e.preventDefault();
    saveBtn.onclick = () => void this.commit();
  }

  private caseCycleIndex = 0;
  private cycleCase(after: () => void): void {
    const ta = this.cursorTextarea;
    if (!ta) return;
    const hasSel = ta.selectionStart !== ta.selectionEnd;
    const start = hasSel ? ta.selectionStart : 0;
    const end = hasSel ? ta.selectionEnd : ta.value.length;
    const seg = ta.value.slice(start, end);
    const forms = ["lower", "upper", "title", "sentence"] as const;
    const form = forms[this.caseCycleIndex % forms.length];
    this.caseCycleIndex += 1;
    const out = applyCase(seg, form);
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(end);
    ta.setSelectionRange(start, start + out.length);
    this.cursorText = ta.value;
    ta.dispatchEvent(new Event("input")); // refresh diff + count
    after();
    ta.focus();
  }

  private renderSplitSurface(): void {
    // 0.168.3: mode selection — one segmented row across ALL split methods. Line /
    // Cursor place a single divider you position; the preset methods (Each line /
    // Paragraphs / Headings) auto-split into many. Every method now SELECTS a mode
    // and PREVIEWS below; the one bottom Split button commits — no more instant,
    // inconsistent quick-splits. A greyed preset shows no count (a count of 1 means
    // "can't split", which read as noise).
    const modeRow = this.host.createDiv({ cls: "stashpad-split-modes" });
    const modeBtn = (label: string, active: boolean, onPick: () => void, icon: string, disabled = false): void => {
      const b = modeRow.createEl("button", { cls: "stashpad-split-mode-btn" });
      setIcon(b.createSpan({ cls: "stashpad-split-btn-icon" }), icon);
      b.createSpan({ text: label });
      b.toggleClass("is-active", active);
      b.disabled = disabled;
      b.onmousedown = (e) => e.preventDefault();
      if (!disabled) b.onclick = onPick;
    };
    if (this.lines.length >= 2) {
      modeBtn("Line", this.mode === "line", () => { this.mode = "line"; this.render(); }, "separator-horizontal");
    }
    modeBtn("Cursor", this.mode === "cursor", () => { this.mode = "cursor"; this.render(); }, "text-cursor-input");
    const presetIcon: Record<SplitMode, string> = { lines: "list", paragraphs: "pilcrow", headings: "heading" };
    (["lines", "paragraphs", "headings"] as SplitMode[]).forEach((m) => {
      const n = splitIntoChunks(this.body, m).length;
      const disabled = n < 2;
      // 0.168.4: shorter label for the paragraph split in this modal only (the
      // shared SPLIT_MODE_LABELS is still used by menus/settings).
      const base = m === "paragraphs" ? "Blank line(s)" : SPLIT_MODE_LABELS[m];
      const label = disabled ? base : `${base} (${n})`;
      modeBtn(label, this.mode === "preset" && this.presetMode === m,
        () => { this.mode = "preset"; this.presetMode = m; this.render(); }, presetIcon[m], disabled);
    });

    // Preview for the active mode.
    if (this.mode === "line") this.renderLineMode();
    else if (this.mode === "cursor") this.renderEditorSections();
    else this.renderPresetMode();

    const help = this.host.createDiv({ cls: "stashpad-split-help" });
    const setHelp = (): void => {
      // 0.168.4: hidden on PHONE (cramped, no keyboard); shown on tablet/iPad +
      // desktop (someone may pair a keyboard). Esc + Tab hints dropped (Esc has the
      // false-button by the ×; Tab now just cycles focus). Nest phrased by result.
      if (Platform.isPhone) { help.setCssStyles({ display: "none" }); return; }
      help.setCssStyles({ display: "" });
      const nest1 = this.nest ? "New part nested under the original." : "New part added as a sibling.";
      const nestN = this.nest ? "New parts nested under the original." : "New parts added as siblings.";
      const confirm = "⌘/Ctrl+Enter or Split to confirm";
      help.setText(
        this.mode === "line" ? `↑/↓ or click to pick the split line  ·  ${confirm}  ·  ${nest1}`
        : this.mode === "cursor" ? `Click or arrow to position the cursor  ·  ${confirm}  ·  ${nest1}`
        : `Preview of the resulting parts  ·  ${confirm}  ·  ${nestN}`);
    };
    setHelp();

    // 0.168.3: bottom action bar — Cancel on the left; Nest checkbox + primary
    // Split on the right. One confirm for every mode.
    const actions = this.host.createDiv({ cls: "stashpad-split-actions" });
    // 0.168.5: Cancel IS the escape action, so it carries the Esc hint (the separate
    // corner chip was redundant with both Cancel and the ×).
    const cancel = actions.createEl("button", { cls: "stashpad-split-cancel-btn" });
    setIcon(cancel.createSpan({ cls: "stashpad-split-btn-icon" }), "x");
    cancel.createSpan({ text: "Cancel" });
    cancel.createSpan({ cls: "stashpad-split-esc-hint", text: " (Esc)" });
    cancel.onmousedown = (e) => e.preventDefault();
    cancel.onclick = () => this.cb.close();
    this.renderPopOut(actions);
    this.renderOpenExternal(actions);

    const right = actions.createDiv({ cls: "stashpad-split-actions-right" });
    const nestWrap = right.createEl("label", { cls: "stashpad-split-nest" });
    const nestCb = nestWrap.createEl("input", { type: "checkbox" });
    nestCb.checked = this.nest;
    nestWrap.createSpan({ text: "Nest under original" });
    // Update just the help line — a full re-render would drop the cursor caret.
    nestCb.onchange = () => { this.nest = nestCb.checked; setHelp(); };

    const splitCount = this.mode === "preset" ? splitIntoChunks(this.body, this.presetMode).length : 0;
    const splitBtn = right.createEl("button", { cls: "stashpad-split-confirm-btn mod-cta" });
    setIcon(splitBtn.createSpan({ cls: "stashpad-split-btn-icon" }), "split");
    splitBtn.createSpan({ text: this.mode === "preset" && splitCount >= 2 ? `Split into ${splitCount}` : "Split" });
    splitBtn.onmousedown = (e) => e.preventDefault(); // don't blur the textarea
    splitBtn.onclick = () => this.commit();
  }

  private renderPresetMode(): void {
    const chunks = splitIntoChunks(this.body, this.presetMode);
    const list = this.host.createDiv({ cls: "stashpad-split-preset-list" });
    if (chunks.length < 2) {
      list.createDiv({ cls: "stashpad-split-empty", text: "This delimiter wouldn't split the note into more than one part." });
      return;
    }
    chunks.forEach((c, i) => {
      const card = list.createDiv({ cls: "stashpad-split-part-card" });
      const head = card.createDiv({ cls: "stashpad-split-part-num" });
      head.createSpan({ cls: "stashpad-split-part-title", text: `Part ${i + 1}` });
      head.appendChild(this.makeCopyButton(() => c, `Copy part ${i + 1}`));
      card.createDiv({ cls: "stashpad-split-part-body", text: c });
    });
  }

  private renderLineMode(): void {
    const list = this.host.createDiv({ cls: "stashpad-split-list" });
    let divider: HTMLElement | null = null;
    for (let i = 0; i < this.lines.length; i++) {
      if (i === this.lineCursorIdx) {
        divider = list.createDiv({ cls: "stashpad-split-divider", text: "── split here ──" });
      }
      const ln = list.createDiv({ cls: "stashpad-split-line" });
      ln.createSpan({ cls: "stashpad-split-lineno", text: String(i + 1) });
      ln.createSpan({ cls: "stashpad-split-text", text: this.lines[i] || " " });
      // Tap-to-position: clicking a line puts the divider BELOW it — the
      // clicked line ends the first part, so the second part starts at the
      // next line (i + 1). Nicer than only arrows on desktop, and the natural
      // reading on mobile ("split after this line").
      ln.onclick = () => {
        const target = Math.max(1, Math.min(this.lines.length - 1, i + 1));
        if (target === this.lineCursorIdx) return;
        this.lineCursorIdx = target;
        this.render();
      };
    }
    // Center the divider in the list after a (re)render so you see context both
    // above AND below the split point — and so moving it with ↑/↓ or a click
    // doesn't snap scroll to the top and push the divider off-screen.
    if (divider) window.requestAnimationFrame(() => divider.scrollIntoView({ block: "center" }));
  }

  /** 0.168.2: a framed section with a tucked header that is itself the
   *  expand/collapse button (whole header tappable). Returns the section + its
   *  body host. Collapsed state is read/written on `this.collapsed[key]` so it
   *  persists across re-renders. */
  private buildSplitSection(host: HTMLElement, key: "orig" | "changes" | "edit", label: string): { section: HTMLElement; body: HTMLElement } {
    const section = host.createDiv({ cls: `stashpad-split-section stashpad-split-${key}` });
    const header = section.createEl("button", { cls: "stashpad-split-section-header" });
    header.setAttr("type", "button");
    const chev = header.createSpan({ cls: "stashpad-split-chevron" });
    setIcon(chev, "chevron-down");
    header.createSpan({ cls: "stashpad-split-section-title", text: label });
    const body = section.createDiv({ cls: "stashpad-split-section-body" });
    const apply = (): void => {
      section.toggleClass("is-collapsed", this.collapsed[key]);
      header.setAttr("aria-expanded", String(!this.collapsed[key]));
    };
    header.onmousedown = (e) => e.preventDefault(); // don't blur the textarea
    header.onclick = (e) => { e.preventDefault(); this.collapsed[key] = !this.collapsed[key]; apply(); };
    apply();
    return { section, body };
  }

  /** 0.169.1: a copy-to-clipboard icon button. `onmousedown`/`stopPropagation` keep
   *  it from toggling a collapse header or blurring the textarea. */
  private makeCopyButton(getText: () => string, label: string, cls = "stashpad-split-copy-btn"): HTMLButtonElement {
    const btn = createEl("button", { cls });
    setIcon(btn, "copy");
    btn.setAttr("aria-label", label);
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = getText();
      void navigator.clipboard?.writeText(text).then(
        () => new Notice("Copied to clipboard."),
        () => new Notice("Couldn't access the clipboard."),
      );
    };
    return btn;
  }

  private renderEditorSections(): void {
    // 0.177.0: mobile gets a compact TABBED layout — the Original / Changes / edit
    // panels share one space (one visible at a time) so they don't stack and blow
    // the modal past the keyboard. Desktop keeps the stacked collapsible sections.
    if (Platform.isMobile) { this.renderEditorTabbed(); return; }
    // 0.168.1/0.168.2: when the text has been edited, a read-only ORIGINAL section
    // and a read-only word-level DIFF section appear above the editor. All three are
    // consistent collapsible framed sections (whole header = the toggle button).
    const orig = this.buildSplitSection(this.host, "orig", "Original — will be replaced");
    orig.body.createDiv({ cls: "stashpad-split-panel-body", text: this.body });
    // 0.169.1: copy the original text (the header is a full-width collapse button,
    // so the copy button overlays its right edge as a section sibling).
    orig.section.appendChild(this.makeCopyButton(() => this.body, "Copy the original text", "stashpad-split-copy-btn stashpad-split-section-copy"));

    const changes = this.buildSplitSection(this.host, "changes", "Changes");
    const diffBody = changes.body.createDiv({ cls: "stashpad-split-panel-body stashpad-split-diff-body" });

    const edit = this.buildSplitSection(this.host, "edit", this.surface === "edit" ? "Your edit" : "Your edit — the split uses this");
    const editWrap = edit.body.createDiv({ cls: "stashpad-edit-wrap" });
    const ta = editWrap.createEl("textarea", { cls: "stashpad-split-cursor-ta" });
    // Seed from the persisted (possibly edited) text so toggling modes doesn't
    // discard edits; the split acts on exactly what's shown here.
    ta.value = this.cursorText;
    ta.readOnly = false;
    this.cursorTextarea = ta;
    this.enhanceTextarea(ta);
    this.attachLineNumbers(editWrap, ta);

    const renderDiff = (): void => {
      diffBody.empty();
      for (const part of splitWordDiff(this.body, ta.value)) {
        const cls = part.t === "ins" ? "stashpad-diff-ins" : part.t === "del" ? "stashpad-diff-del" : "stashpad-diff-eq";
        diffBody.createSpan({ cls, text: part.s });
      }
    };
    const syncEdited = (): void => {
      const edited = ta.value !== this.body;
      orig.section.setCssStyles({ display: edited ? "" : "none" });
      changes.section.setCssStyles({ display: edited ? "" : "none" });
      if (edited) renderDiff();
    };

    // Auto-size the textarea to fit content. Cap at 3 lines on mobile,
    // 12 lines on desktop. Recomputed on input in case the user edits.
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22;
    // 0.170.3: the Edit surface is a real writing space — let the editor grow much
    // taller than in Split mode (where it stays compact next to the split controls).
    const maxLines = this.surface === "edit" ? (Platform.isMobile ? 10 : 40) : (Platform.isMobile ? 3 : 12);
    const minLines = 2;
    const fit = (): void => {
      ta.setCssStyles({ height: "auto" });
      // 0.184.0: also cap at ~half the window height so hitting Enter can't grow
      // the editor until it pushes the action bar off-screen; it scrolls past that.
      const cap = Math.min(lineHeight * maxLines + 16, Math.round(window.innerHeight * 0.5));
      const needed = Math.min(ta.scrollHeight, cap);
      ta.setCssStyles({ height: `${Math.max(needed, lineHeight * minLines + 16)}px`, overflowY: "auto" });
    };
    // Set the initial edited-state synchronously (doesn't need layout) so the
    // panels are correctly hidden on a fresh/unedited cursor render — the rAF-only
    // path didn't reliably stick. fit() still runs in the rAF (needs layout).
    syncEdited();
    requestAnimationFrame(() => {
      fit();
      ta.focus();
      // Edit surface: cursor at END (you're continuing the note). Split cursor
      // mode: middle (you're picking a split point).
      const pos = this.surface === "edit" ? ta.value.length : Math.floor(ta.value.length / 2);
      ta.setSelectionRange(pos, pos);
    });
    ta.addEventListener("input", () => { this.cursorText = ta.value; fit(); syncEdited(); });
  }

  /** 0.177.0: mobile tabbed editor. One panel visible at a time — "Your edit"
   *  (the textarea), plus "Original" and "Changes" tabs that appear once the text
   *  differs. Keeps the modal short so it never grows past the on-screen keyboard;
   *  the textarea is hard-capped and scrolls. */
  private renderEditorTabbed(): void {
    const wrap = this.host.createDiv({ cls: "stashpad-split-tabs" });
    const tabBar = wrap.createDiv({ cls: "stashpad-split-tabbar" });
    const bodyHost = wrap.createDiv({ cls: "stashpad-split-tabbody" });

    // Edit panel (the live textarea).
    const editPanel = bodyHost.createDiv({ cls: "stashpad-split-tabpanel stashpad-split-tabpanel-edit" });
    const ta = editPanel.createEl("textarea", { cls: "stashpad-split-cursor-ta" });
    ta.value = this.cursorText;
    ta.readOnly = false;
    this.cursorTextarea = ta;
    this.enhanceTextarea(ta);

    // Original (read-only). 0.183.3: copy button in a right-aligned bar ABOVE the
    // text (it used to overlay the text's right edge as a full-height strip).
    const origPanel = bodyHost.createDiv({ cls: "stashpad-split-tabpanel" });
    const origCopyBar = origPanel.createDiv({ cls: "stashpad-split-tab-copybar" });
    origCopyBar.appendChild(this.makeCopyButton(() => this.body, "Copy the original text", "stashpad-split-copy-btn stashpad-split-tab-copy"));
    origPanel.createDiv({ cls: "stashpad-split-panel-body", text: this.body });

    // Changes (word diff).
    const changesPanel = bodyHost.createDiv({ cls: "stashpad-split-tabpanel" });
    const diffBody = changesPanel.createDiv({ cls: "stashpad-split-panel-body stashpad-split-diff-body" });

    const tabs = [
      { key: "edit", label: this.surface === "edit" ? "Your edit" : "Edit", panel: editPanel },
      { key: "orig", label: "Original", panel: origPanel },
      { key: "changes", label: "Changes", panel: changesPanel },
    ];
    const btns: Record<string, HTMLElement> = {};
    let active = "edit";
    const showTab = (key: string): void => {
      active = key;
      for (const t of tabs) {
        t.panel.toggleClass("is-active", t.key === key);
        btns[t.key]?.toggleClass("is-active", t.key === key);
      }
      if (key === "edit") ta.focus();
    };
    for (const t of tabs) {
      const b = tabBar.createEl("button", { cls: "stashpad-split-tab", text: t.label });
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => showTab(t.key);
      btns[t.key] = b;
    }

    const renderDiff = (): void => {
      diffBody.empty();
      for (const part of splitWordDiff(this.body, ta.value)) {
        const cls = part.t === "ins" ? "stashpad-diff-ins" : part.t === "del" ? "stashpad-diff-del" : "stashpad-diff-eq";
        diffBody.createSpan({ cls, text: part.s });
      }
    };
    const syncEdited = (): void => {
      const edited = ta.value !== this.body;
      btns.orig.toggleClass("is-hidden", !edited);
      btns.changes.toggleClass("is-hidden", !edited);
      if (edited) renderDiff();
      // If the visible tab just got hidden (text reverted to original), fall back.
      if (!edited && (active === "orig" || active === "changes")) showTab("edit");
    };

    // 0.183.0: the editor FILLS the fixed-height modal (flex, via CSS) and scrolls
    // internally — no explicit line cap. With the modal at a fixed height it can't
    // grow past the keyboard anyway, so filling looks better than a hard cap that
    // leaves an empty gap under a short note.
    ta.setCssStyles({ overflowY: "auto" });

    syncEdited();
    showTab("edit");
    requestAnimationFrame(() => {
      ta.focus();
      const pos = this.surface === "edit" ? ta.value.length : Math.floor(ta.value.length / 2);
      ta.setSelectionRange(pos, pos);
    });
    ta.addEventListener("input", () => { this.cursorText = ta.value; syncEdited(); });
  }
}

/** Callbacks a split host is handed (the host fills in `close`/`onDone`/`onTitle`). */
export type WorkbenchCommandCallbacks = Omit<WorkbenchCallbacks, "close" | "onDone" | "onTitle">;

export const WORKBENCH_VIEW_TYPE = "stashpad-split-view";

/** 0.169.0: thin modal host around NoteWorkbench. */
export class NoteWorkbenchModal extends Modal {
  private ui: NoteWorkbench | null = null;
  /** 0.170.5: set when the close is intentional (Save/Split done, or pop-out) so the
   *  unsaved-edits guard is skipped. */
  private committing = false;
  constructor(app: App, private body: string, private cbs: WorkbenchCommandCallbacks, private init: Partial<WorkbenchState> = {}) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("stashpad-split-modal");
    this.ui = new NoteWorkbench(this.app, this.contentEl, this.body, this.init, {
      onSplitAtLine: this.cbs.onSplitAtLine,
      onSplitAtChar: this.cbs.onSplitAtChar,
      onSplitMany: this.cbs.onSplitMany,
      onSave: this.cbs.onSave,
      onOpenExternal: this.cbs.onOpenExternal,
      onImportFile: this.cbs.onImportFile,
      close: () => this.close(),
      onDone: () => { this.committing = true; this.close(); }, // split/save ran → dismiss
      onTitle: (t) => this.titleEl.setText(t),
      // Popping out closes the modal first, then opens the tab with the live state
      // (the edits go with it, so no discard guard).
      popOut: this.cbs.popOut ? (state) => { this.committing = true; this.close(); this.cbs.popOut!(state); } : undefined,
    });
    // Mod+Enter commits in every mode (see 0.168.5). Arrows move the line divider.
    this.scope.register(["Mod"], "Enter", (e) => { e.preventDefault(); void this.ui?.commit(); });
    this.scope.register([], "ArrowUp", (e) => { if (this.ui?.moveDivider(-1)) e.preventDefault(); });
    this.scope.register([], "ArrowDown", (e) => { if (this.ui?.moveDivider(1)) e.preventDefault(); });
    // 0.170.3: Mod+E / Mod+S toggle the Edit / Split surface while open.
    this.scope.register(["Mod"], "e", (e) => { e.preventDefault(); this.ui?.setSurface("edit"); });
    this.scope.register(["Mod"], "s", (e) => { e.preventDefault(); this.ui?.setSurface("split"); });
    // 0.184.0: Mod+Shift+E → open the note in Obsidian's editor (no-op for a new
    // note from the composer, which has no onOpenExternal).
    this.scope.register(["Mod", "Shift"], "e", (e) => { e.preventDefault(); void this.ui?.openExternalSaving(); }); // 0.201.2: saves first, no discard prompt
  }
  // 0.170.5: dirty guard — Esc / click-outside / × / Cancel all route through close();
  // if there are unsaved edits (and this isn't a deliberate Save/Split/pop-out), confirm.
  close(): void {
    if (this.committing || !this.ui?.isDirty()) { super.close(); return; }
    new ConfirmModal(
      this.app,
      "Discard unsaved edits?",
      "You've edited this note but haven't saved. Close and discard your changes?",
      "Discard",
      (ok) => { if (ok) { this.committing = true; this.close(); } },
      "Keep editing",
      true,
    ).open();
  }
  onClose(): void { this.ui?.destroy(); this.ui = null; this.contentEl.empty(); }
}

/** Context injected into a popped-out NoteWorkbenchView. `prevLeaf` is the tab to
 *  refocus once the split's done. */
export interface WorkbenchViewContext {
  body: string;
  cbs: WorkbenchCommandCallbacks;
  init: Partial<WorkbenchState>;
  prevLeaf?: WorkspaceLeaf | null;
}

/** 0.169.0: full-leaf host around NoteWorkbench ("pop out"). Ephemeral — needs its
 *  context injected via setContext right after creation; a restored-but-context-less
 *  view shows a "session ended" placeholder. 0.169.3: once the split commits, it
 *  runs a live countdown and then closes + refocuses the previous tab. */
export class NoteWorkbenchView extends ItemView {
  private ui: NoteWorkbench | null = null;
  private ctx: WorkbenchViewContext | null = null;
  private prevLeaf: WorkspaceLeaf | null = null;
  private autoCloseTimer: number | null = null;
  private expiredGrace: number | null = null;
  private title = "Note";
  private viewIcon = "pencil-line";
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType(): string { return WORKBENCH_VIEW_TYPE; }
  getDisplayText(): string { return this.title; }
  getIcon(): string { return this.viewIcon; }

  private setHeader(title: string, icon: string): void {
    this.title = title;
    this.viewIcon = icon;
    // Undocumented but real: refresh the tab header so the title/icon update live.
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  setContext(ctx: WorkbenchViewContext): void {
    if (this.expiredGrace != null) { window.clearTimeout(this.expiredGrace); this.expiredGrace = null; }
    this.ctx = ctx;
    this.prevLeaf = ctx.prevLeaf ?? null;
    const isEdit = ctx.init.surface === "edit";
    this.setHeader(isEdit ? "Edit note" : "Split note", isEdit ? "pencil-line" : "split");
    this.renderUI();
  }

  async onOpen(): Promise<void> {
    // Fresh pop-outs get their context via setContext within a tick. A RESTORED tab
    // (workspace reload) never will — so if no context arrives shortly, it's an
    // orphan: show the expired panel and auto-close it. The grace period avoids
    // flashing/auto-closing the transient no-context state during a fresh open.
    this.contentEl.addClass("stashpad-split-modal", "stashpad-split-view");
    if (!this.ctx) {
      this.expiredGrace = window.setTimeout(() => { this.expiredGrace = null; if (!this.ctx) this.renderExpired(); }, 800);
    }
  }

  private renderUI(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("stashpad-split-modal", "stashpad-split-view");
    if (!this.ctx) return;
    this.ui = new NoteWorkbench(this.app, c, this.ctx.body, this.ctx.init, {
      onSplitAtLine: this.ctx.cbs.onSplitAtLine,
      onSplitAtChar: this.ctx.cbs.onSplitAtChar,
      onSplitMany: this.ctx.cbs.onSplitMany,
      onSave: this.ctx.cbs.onSave,
      onOpenExternal: this.ctx.cbs.onOpenExternal,
      onImportFile: this.ctx.cbs.onImportFile,
      close: () => this.guardedDetach(),
      onDone: () => this.startClosePanel("✓ Done.", null, true),
      onTitle: (t) => this.setHeader(t, t.startsWith("Edit") ? "pencil-line" : "split"),
    });
    // Mod+Enter commits; arrows move the line divider (only acts in line mode, so
    // arrows in the cursor textarea fall through to the textarea).
    this.registerDomEvent(c, "keydown", (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Mod+Shift+E → open the note in Obsidian's editor. Checked BEFORE Mod+E
      // (a plain-letter check also fires on its shifted form — the shifted-key trap).
      if (mod && e.shiftKey && (e.key === "e" || e.key === "E")) { e.preventDefault(); this.ctx?.cbs.onOpenExternal?.(); void this.guardedDetach(); }
      else if (mod && e.key === "Enter") { e.preventDefault(); void this.ui?.commit(); }
      else if (mod && !e.shiftKey && (e.key === "e" || e.key === "E")) { e.preventDefault(); this.ui?.setSurface("edit"); }
      else if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); this.ui?.setSurface("split"); }
      else if (e.key === "ArrowUp") { if (this.ui?.moveDivider(-1)) e.preventDefault(); }
      else if (e.key === "ArrowDown") { if (this.ui?.moveDivider(1)) e.preventDefault(); }
    });
  }

  /** Orphaned restored tab — can't be revived; auto-close it. */
  private renderExpired(): void {
    this.setHeader("Expired", "clock");
    this.startClosePanel("This session has expired.", "It can't be restored — closing this tab…", false);
  }

  /** Shared close panel: a title + a live countdown that auto-closes, plus Close
   *  now / Keep tab open. `refocus` returns to the previous tab (done) vs just
   *  closing (expired orphan). */
  private startClosePanel(titleText: string, subText: string | null, refocus: boolean): void {
    const c = this.contentEl;
    c.empty();
    this.ui?.destroy();
    this.ui = null;
    const box = c.createDiv({ cls: "stashpad-split-done" });
    box.createDiv({ cls: "stashpad-split-done-title", text: titleText });
    if (subText) box.createDiv({ cls: "stashpad-split-countdown", text: subText });
    const count = box.createDiv({ cls: "stashpad-split-countdown" });
    const btns = box.createDiv({ cls: "stashpad-split-done-btns" });
    const closeNow = btns.createEl("button", { cls: "mod-cta", text: "Close now" });
    const keep = btns.createEl("button", { text: "Keep tab open" });

    let n = 4;
    const paint = (): void => count.setText(`Closing this tab in ${n}…`);
    const stop = (): void => {
      if (this.autoCloseTimer != null) { window.clearInterval(this.autoCloseTimer); this.autoCloseTimer = null; }
    };
    const close = (): void => { stop(); if (refocus) this.closeAndRefocus(); else this.leaf.detach(); };
    paint();
    this.autoCloseTimer = window.setInterval(() => { n -= 1; if (n <= 0) close(); else paint(); }, 1000);
    closeNow.onclick = close;
    keep.onclick = () => { stop(); count.setText("Close this tab whenever you're ready."); keep.remove(); closeNow.setText("Close tab"); };
  }

  /** 0.170.5: Cancel in the tab confirms if there are unsaved edits before detaching.
   *  (A native tab close / Cmd+W can't be intercepted — that path isn't guarded.) */
  /** Set before any deliberate detach so onClose's best-effort unsaved-warning
   *  (which fires on a NATIVE tab close — Cmd+W / the tab × — that we can't
   *  intercept) doesn't double up on a close the user already confirmed. */
  private closingIntentionally = false;

  private guardedDetach(): void {
    if (!this.ui?.isDirty()) { this.closingIntentionally = true; this.leaf.detach(); return; }
    new ConfirmModal(
      this.app,
      "Discard unsaved edits?",
      "You've edited this note but haven't saved. Close this tab and discard your changes?",
      "Discard",
      (ok) => { if (ok) { this.closingIntentionally = true; this.leaf.detach(); } },
      "Keep editing",
      true,
    ).open();
  }

  private leafStillOpen(leaf: WorkspaceLeaf): boolean {
    let ok = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l === leaf) ok = true; });
    return ok;
  }

  private closeAndRefocus(): void {
    const prev = this.prevLeaf;
    this.closingIntentionally = true;
    this.leaf.detach();
    if (prev && this.leafStillOpen(prev)) this.app.workspace.setActiveLeaf(prev, { focus: true });
  }

  async onClose(): Promise<void> {
    // 0.184.0 (experimental): Obsidian gives ItemViews no blocking pre-close hook,
    // so a NATIVE tab close (Cmd+W / the tab ×) with unsaved edits can't be
    // confirmed — warn AFTER the fact instead. Guarded closes set the flag so this
    // doesn't fire when the user already chose to discard / saved.
    if (!this.closingIntentionally && this.ui?.isDirty()) {
      new Notice("Closed the Stashpad editor with unsaved changes — they were discarded. Use Save (⌘/Ctrl+Enter) next time.", 7000);
    }
    if (this.autoCloseTimer != null) { window.clearInterval(this.autoCloseTimer); this.autoCloseTimer = null; }
    if (this.expiredGrace != null) { window.clearTimeout(this.expiredGrace); this.expiredGrace = null; }
    this.ui?.destroy();
    this.ui = null;
    this.contentEl.empty();
  }
}

/** Submenu opened from the "+" tile in ColorPickerModal. Lets the user pick
 *  any hex color, then either save (apply once) or add (apply + persist to
 *  the palette). Closing without a button applies as "save" (consistent
 *  with the user's hasty-apply expectation). */
/** 0.84.2: shown before a .stash export runs. Lets the user rename the export
 *  (the field is prefilled with the auto-generated base name and selected on
 *  open, so typing overwrites it; native Cmd/Ctrl+Z undo works because we
 *  don't intercept it). The final on-disk name is `<base>-<timestamp>.stash`
 *  — the timestamp is appended automatically so reusing a name never clobbers
 *  a prior export. Returns the chosen base name (sanitized by the caller), or
 *  nothing if cancelled. */
/** 0.166.0: shared "Content" segmented control (Full note / Frontmatter only /
 *  Body only) for both export modals. Fires onChange with the picked mode on
 *  every click (and once with the initial "full"). */
function buildExportContentPicker(
  host: HTMLElement,
  onChange: (mode: ExportContent) => void,
): void {
  const wrap = host.createDiv({ cls: "stashpad-export-content" });
  wrap.createEl("label", { cls: "stashpad-export-label", text: "Content" });
  const seg = wrap.createDiv({ cls: "stashpad-export-content-seg" });
  const opts: Array<{ id: ExportContent; label: string }> = [
    { id: "full", label: "Full note" },
    { id: "frontmatter", label: "Frontmatter only" },
    { id: "body", label: "Body only" },
  ];
  const btns = new Map<ExportContent, HTMLButtonElement>();
  const select = (m: ExportContent) => {
    btns.forEach((b, k) => b.toggleClass("is-active", k === m));
    onChange(m);
  };
  for (const o of opts) {
    const b = seg.createEl("button", { cls: "stashpad-export-content-opt", text: o.label });
    b.onclick = (e) => { e.preventDefault(); select(o.id); };
    btns.set(o.id, b);
  }
  select("full");
}

/** 0.167.0: the unified export modal's result. `format` is the chosen output;
 *  `content` filters the note markdown (only "full" can re-import). `okf` carries
 *  the OKF sub-formats when `format === "okf"`. */
export interface ExportChoice {
  baseName: string;
  content: ExportContent;
  format: "stash" | "okf" | "zip";
  okf: { zip: boolean; targz: boolean };
  password: string | null;
  remember: boolean;
}

export interface ExportModalOpts {
  /** Probe (cached) for whether Argon2id can run here, so the modal can state up
   *  front whether this export will use the strong suite or the fallback. */
  kdfProbe?: () => Promise<boolean>;
  /** Offer the OKF format option (gated by the okfEnabled setting). */
  okfEnabled?: boolean;
  /** Locked-bundle re-export: the payload is an opaque encrypted blob, so Content
   *  + Format are hidden — only filename + the password UI apply. */
  locked?: boolean;
}

export class ExportStashModal extends Modal {
  private delivered = false;
  constructor(
    app: App,
    private defaultBaseName: string,
    private noteCount: number,
    private onConfirm: (choice: ExportChoice) => void,
    private opts: ExportModalOpts = {},
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.empty();
    const locked = !!this.opts.locked;
    this.titleEl.setText(locked ? "Export encrypted bundle" : "Export");
    this.modalEl.addClass("stashpad-export-modal");

    this.contentEl.createEl("p", {
      cls: "stashpad-export-desc",
      text: locked
        ? `Re-export this locked bundle (${this.noteCount} note${this.noteCount === 1 ? "" : "s"}) as a shareable .stash.`
        : `Export ${this.noteCount} note${this.noteCount === 1 ? "" : "s"}.`,
    });

    const field = this.contentEl.createDiv({ cls: "stashpad-export-field" });
    field.createEl("label", { cls: "stashpad-export-label", text: "File name" });
    const input = field.createEl("input", { type: "text" });
    input.addClass("stashpad-export-name");
    input.value = this.defaultBaseName;

    // Live preview of the final on-disk filename (timestamp appended at
    // export; "-encrypted" tag added when encryption is on — see below).
    const preview = this.contentEl.createEl("div", { cls: "stashpad-export-preview" });

    // 0.166.0 / 0.167.0: what to export — the whole note, only its frontmatter, or
    // only its body. Non-"full" drops the structure Stashpad needs to re-import, so
    // it forces a plain .zip. Hidden entirely for locked (opaque) bundles.
    let content: ExportContent = "full";
    let rerender: () => void = () => {}; // set to refresh() once it exists (avoids TDZ)
    const contentHost = this.contentEl.createDiv();
    buildExportContentPicker(contentHost, (m) => { content = m; rerender(); });
    if (locked) contentHost.setCssStyles({ display: "none" });

    // 0.167.0: format — the output kind. Only meaningful for full-content,
    // non-locked exports (filtered exports force "zip"; locked forces "stash").
    let format: "stash" | "okf" | "zip" = "stash";
    const fmtWrap = this.contentEl.createDiv({ cls: "stashpad-export-format" });
    fmtWrap.createEl("label", { cls: "stashpad-export-label", text: "Format" });
    const fmtSeg = fmtWrap.createDiv({ cls: "stashpad-export-content-seg" });
    const fmtOpts: Array<{ id: "stash" | "okf" | "zip"; label: string }> = [
      { id: "stash", label: "Stashpad .stash" },
      ...(this.opts.okfEnabled ? [{ id: "okf" as const, label: "OKF bundle" }] : []),
      { id: "zip", label: "Plain .zip" },
    ];
    const fmtBtns = new Map<string, HTMLButtonElement>();
    for (const o of fmtOpts) {
      const b = fmtSeg.createEl("button", { cls: "stashpad-export-content-opt", text: o.label });
      b.toggleClass("is-active", o.id === format);
      b.onclick = (e) => {
        e.preventDefault();
        format = o.id;
        fmtBtns.forEach((bb, k) => bb.toggleClass("is-active", k === format));
        rerender();
      };
      fmtBtns.set(o.id, b);
    }
    // OKF sub-formats (only when format === "okf").
    const okfSub = this.contentEl.createDiv({ cls: "stashpad-okf-formats" });
    const mkOkf = (label: string, checked: boolean): HTMLInputElement => {
      const row = okfSub.createDiv({ cls: "stashpad-okf-fmt" });
      const c = row.createEl("input", { type: "checkbox" }); c.checked = checked;
      row.createEl("label", { text: label });
      c.onchange = () => rerender();
      return c;
    };
    const okfZip = mkOkf(".zip — OKF bundle (portable)", true);
    const okfTar = mkOkf(".tar.gz — OKF bundle (tarball)", false);
    const okfHint = okfSub.createDiv({ cls: "stashpad-export-pw-hint is-error" });
    okfHint.setText("Pick at least one OKF format.");
    okfHint.setCssStyles({ display: "none" });
    if (locked) fmtWrap.setCssStyles({ display: "none" });

    const zipWarn = this.contentEl.createDiv({ cls: "stashpad-export-zipwarn" });
    zipWarn.setText("Frontmatter-only / body-only exports save as a plain .zip of the selected markdown (with referenced attachments) — not a re-importable .stash.");
    zipWarn.setCssStyles({ display: "none" });

    // --- 0.84.3: optional password encryption (opt-in, default off) ---
    const encWrap = this.contentEl.createDiv({ cls: "stashpad-export-encrypt" });
    const toggleRow = encWrap.createDiv({ cls: "stashpad-export-toggle" });
    const cb = toggleRow.createEl("input", { type: "checkbox" });
    cb.id = "stashpad-export-encrypt-cb";
    const cbLabel = toggleRow.createEl("label", { text: "Encrypt with a password" });
    cbLabel.htmlFor = cb.id;

    const pwArea = encWrap.createDiv({ cls: "stashpad-export-pw-area" });
    pwArea.setCssStyles({ display: "none" });
    // 0.85.7: each field gets an inline button on its right; the passphrase
    // stays hidden by default (Show reveals it). 0.85.8: the button is
    // **Paste** while the field is empty (one-click drop-in from a password
    // manager) and flips to **Copy** once it has a value — clearing the field
    // flips it back. Copy works while masked.
    const pwSyncers: Array<() => void> = [];
    const makePwRow = (placeholder: string): HTMLInputElement => {
      const row = pwArea.createDiv({ cls: "stashpad-export-pw-row" });
      const inp = row.createEl("input", { type: "password" });
      inp.addClass("stashpad-export-name"); inp.placeholder = placeholder;
      const btn = row.createEl("button", { cls: "stashpad-export-copy" });
      const syncBtn = () => {
        const empty = inp.value.length === 0;
        btn.setText(empty ? "Paste" : "Copy");
        btn.toggleClass("is-paste", empty);
        btn.setAttr("aria-label", `${empty ? "Paste into" : "Copy"} ${placeholder.toLowerCase()}`);
      };
      btn.onclick = async (e) => {
        e.preventDefault();
        if (inp.value.length === 0) {
          try {
            const txt = (await navigator.clipboard?.readText())?.trim();
            if (!txt) { new Notice("Clipboard is empty."); return; }
            inp.value = txt;
            inp.dispatchEvent(new Event("input")); // → refresh (validation, meter, button sync)
            new Notice("Pasted from clipboard.");
          } catch { new Notice("Couldn't read the clipboard."); }
        } else {
          void navigator.clipboard?.writeText(inp.value).then(
            () => new Notice("Passphrase copied to clipboard."),
            () => new Notice("Couldn't access the clipboard."),
          );
        }
      };
      syncBtn();
      pwSyncers.push(syncBtn);
      return inp;
    };
    const pw1 = makePwRow("Password");
    const pw2 = makePwRow("Confirm password");

    // 0.85.4: live strength meter (a nudge, never a gate) + a generate button.
    const meter = pwArea.createDiv({ cls: "stashpad-export-strength" });
    const meterBar = meter.createDiv({ cls: "stashpad-strength-bar" });
    const meterSegs = [0, 1, 2, 3].map(() => meterBar.createDiv({ cls: "stashpad-strength-seg" }));
    const meterLabel = meter.createEl("span", { cls: "stashpad-strength-label" });

    const genRow = pwArea.createDiv({ cls: "stashpad-export-genrow" });
    const genBtn = genRow.createEl("button", { cls: "stashpad-export-gen", text: "Generate strong passphrase" });
    const showBtn = genRow.createEl("button", { cls: "stashpad-export-show", text: "Show" });

    const hint = pwArea.createEl("div", { cls: "stashpad-export-pw-hint" });
    // 0.84.15: name the scheme so it's clear up front. 0.85.3: probe this device
    // and state explicitly which suite WILL be used — the strong default or the
    // fallback — rather than describing both abstractly.
    const suite = pwArea.createEl("div", { cls: "stashpad-export-pw-suite" });
    suite.setText("Encryption: AES-256-GCM. Checking key-derivation suite for this device…");
    if (this.opts.kdfProbe) {
      void this.opts.kdfProbe().then((argonOk) => {
        suite.toggleClass("is-weak", !argonOk);
        suite.setText(
          argonOk
            ? "Encryption: Argon2id + AES-256-GCM — the strongest suite (used on this device)."
            : "⚠️ Argon2id can't run on this device, so this export will use the weaker PBKDF2 (600k) + AES-256-GCM fallback.",
        );
      }).catch(() => {
        // Probe failed unexpectedly — keep the neutral text, don't over-claim.
        suite.setText("Encryption: AES-256-GCM with a password-derived key.");
      });
    } else {
      suite.setText("Encryption: Argon2id + AES-256-GCM (falls back to PBKDF2 if Argon2 can't run here).");
    }

    // 0.85.4: optional "remember in this vault" — saves the passphrase to
    // Obsidian's secret storage (OS keychain) keyed by the export filename, so
    // re-importing on THIS device skips the prompt. Only offered when the API
    // exists (≥1.11.4); secrets are device-local, so recipients still need the
    // passphrase typed/copied.
    const secretStorage = (this.app as App & { secretStorage?: SecretStorage }).secretStorage;
    const rememberRow = pwArea.createDiv({ cls: "stashpad-export-remember" });
    const rememberCb = rememberRow.createEl("input", { type: "checkbox" });
    // 0.167.1: ticked by default — most people export to re-import on the same
    // device, so pre-saving the passphrase to this device's keychain is the common
    // case. Untick to keep it out of the keychain (e.g. exports only for others).
    rememberCb.checked = true;
    rememberCb.id = "stashpad-export-remember-cb";
    const rememberLabel = rememberRow.createEl("label", {
      text: "Remember in this vault (this device) — skips the prompt when you re-import here.",
    });
    rememberLabel.htmlFor = rememberCb.id;
    // Shown only while "remember" is ticked: make the device-local scope explicit
    // so nobody assumes the saved passphrase travels with the file or syncs.
    const rememberNote = pwArea.createDiv({ cls: "stashpad-export-remember-note" });
    rememberNote.setText(
      "Saved only in this device's keychain — it doesn't sync to your other devices and isn't shared with anyone you send this file to. Keep the passphrase somewhere safe if you'll open this export elsewhere.",
    );
    rememberNote.setCssStyles({ display: rememberCb.checked ? "" : "none" });
    rememberCb.onchange = () => {
      rememberNote.setCssStyles({ display: rememberCb.checked ? "" : "none" });
    };
    if (!secretStorage) rememberRow.setCssStyles({ display: "none" });

    // 0.84.13: encrypted exports get an "-encrypted" tag in the filename so
    // secure bundles are identifiable at a glance. The preview reflects it live
    // as the checkbox toggles.
    // Effective format after the content/locked constraints: filtered → plain zip;
    // locked → stash; otherwise the picked format.
    const effFormat = (): "stash" | "okf" | "zip" =>
      locked ? "stash" : (content !== "full" ? "zip" : format);
    const effectiveBase = (): string => {
      const b = input.value.trim() || this.defaultBaseName;
      if (!locked && content !== "full") return `${b}-${content}`;
      return (effFormat() === "stash" && cb.checked) ? `${b}-encrypted` : b;
    };
    const renderPreview = () => {
      const f = effFormat();
      if (f === "stash") { preview.setText(`Saves as:  ${effectiveBase()}-<timestamp>.stash`); return; }
      if (f === "okf") { preview.setText(`Saves as:  ${effectiveBase()}-<timestamp>.zip / .tar.gz  (OKF bundle)`); return; }
      preview.setText(`Saves as:  ${effectiveBase()}-<timestamp>.zip  (plain archive — not re-importable)`);
    };
    input.oninput = renderPreview;

    const footer = this.contentEl.createDiv({ cls: "stashpad-export-footer" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const go = footer.createEl("button", { cls: "mod-cta", text: "Export" });

    // Gate the Export button on a valid (matching, non-empty) password when
    // encryption is enabled. People are warned that a lost password = lost
    // export, but the button itself only blocks the typo/empty cases.
    const renderStrength = () => {
      const s = estimatePasswordStrength(pw1.value);
      meter.style.visibility = pw1.value ? "visible" : "hidden";
      meterSegs.forEach((seg, i) => seg.toggleClass("is-on", pw1.value !== "" && i <= s.level));
      meterBar.dataset.level = String(s.level);
      meterLabel.setText(s.label);
    };

    const refresh = () => {
      // 0.167.0: Content ≠ full (and non-locked) forces a plain .zip; Format picks
      // the output otherwise. Encryption applies only to .stash. Show/hide each
      // block to match, and gate Export on the active sub-choices.
      const filtered = !locked && content !== "full";
      const f = effFormat();
      fmtWrap.setCssStyles({ display: (!locked && !filtered) ? "" : "none" });
      okfSub.setCssStyles({ display: (!locked && !filtered && format === "okf") ? "" : "none" });
      zipWarn.setCssStyles({ display: filtered ? "" : "none" });

      const encAllowed = f === "stash"; // covers locked (effFormat → stash) too
      encWrap.setCssStyles({ display: encAllowed ? "" : "none" });
      const enc = encAllowed && cb.checked;
      pwArea.setCssStyles({ display: enc ? "" : "none" });

      let ok = true;
      if (enc) {
        if (!pw1.value) { hint.setText("Enter a password to encrypt this export."); hint.removeClass("is-error"); ok = false; }
        else if (pw1.value !== pw2.value) { hint.setText("Passwords don't match."); hint.addClass("is-error"); ok = false; }
        else { hint.setText("⚠️ If you lose this password, the export can't be recovered."); hint.removeClass("is-error"); }
      }
      // OKF needs at least one sub-format.
      const okfEmpty = !locked && !filtered && format === "okf" && !okfZip.checked && !okfTar.checked;
      okfHint.setCssStyles({ display: okfEmpty ? "" : "none" });
      if (okfEmpty) ok = false;

      renderStrength();
      pwSyncers.forEach((fn) => fn()); // Paste↔Copy per field as values change
      go.disabled = !ok;
      go.toggleClass("is-disabled", !ok);
      renderPreview(); // keep the filename preview in sync with the toggle
    };

    // Reveal/mask both fields together (so a generated passphrase is readable).
    let shown = false;
    const setShown = (v: boolean) => {
      shown = v;
      pw1.type = pw2.type = v ? "text" : "password";
      showBtn.setText(v ? "Hide" : "Show");
    };
    showBtn.onclick = (e) => { e.preventDefault(); setShown(!shown); };

    // Generate fills both fields but keeps them HIDDEN (0.85.7): the user
    // reveals with Show or grabs it with a Copy button. Save it somewhere — you
    // need it to open this export and it can't be recovered if lost.
    genBtn.onclick = (e) => {
      e.preventDefault();
      pw1.value = pw2.value = generatePassphrase();
      setShown(false);
      new Notice("Passphrase generated (hidden) — Show to view, or Copy to save it.");
      refresh();
    };

    cb.onchange = refresh;
    pw1.oninput = refresh;
    pw2.oninput = refresh;
    rerender = refresh; // content/format-picker clicks now re-render the modal
    refresh();

    const deliver = () => {
      const f = effFormat();
      const pw = (f === "stash" && cb.checked) ? pw1.value : null;
      this.commit({
        baseName: effectiveBase(),
        content,
        format: f,
        okf: { zip: okfZip.checked, targz: okfTar.checked },
        password: pw,
        remember: !!pw && rememberCb.checked,
      });
    };
    go.onclick = deliver;

    // Enter confirms (when not blocked); Esc / click-out cancels (modal
    // default). No Mod+Z registration → native input undo handles clears.
    this.scope.register([], "Enter", (e) => {
      e.preventDefault();
      if (!go.disabled) deliver();
    });

    // Focus + select-all so the prefilled name is ready to type over.
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  private commit(choice: ExportChoice): void {
    const base = choice.baseName.trim() || this.defaultBaseName;
    const pw = choice.password && choice.password.length ? choice.password : null;
    this.delivered = true;
    this.close();
    this.onConfirm({ ...choice, baseName: base, password: pw, remember: !!pw && choice.remember });
  }
  onClose(): void {
    // No delivery on cancel/Esc/click-out — the export simply doesn't run.
    this.contentEl.empty();
  }
}

/** Outcome of the encrypted-.stash password prompt. */
export type StashPasswordResult =
  | { kind: "password"; value: string }
  | { kind: "later" }   // reschedule — snooze the auto-import notification
  | { kind: "cancel" }; // back out for now (Esc / click-out / Cancel)

/** 0.84.3: prompt for the password of an encrypted .stash on import. `errorMsg`
 *  shows a retry hint after a wrong password. 0.84.16: when `allowLater` is set
 *  (the auto-import "Import now" flow), a "Remind me later" button is offered so
 *  Cancel can mean just "not right now" while "Remind me later" reschedules. */
export class StashPasswordModal extends Modal {
  private delivered = false;
  constructor(
    app: App,
    private errorMsg: string | undefined,
    private allowLater: boolean,
    private onResult: (result: StashPasswordResult) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Encrypted .stash");
    this.modalEl.addClass("stashpad-export-modal");
    this.contentEl.createEl("p", {
      cls: "stashpad-export-desc",
      text: "This export is password-protected. Enter its password to import it.",
    });
    if (this.errorMsg) {
      this.contentEl.createEl("div", { cls: "stashpad-export-error", text: this.errorMsg });
    }
    const input = this.contentEl.createEl("input", { type: "password" });
    input.addClass("stashpad-export-name");
    input.placeholder = "Password";

    const footer = this.contentEl.createDiv({ cls: "stashpad-export-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    if (this.allowLater) {
      const later = footer.createEl("button", { text: "Remind me later" });
      later.title = "Don't import now — surface the reminder again later.";
      later.onclick = () => this.finish({ kind: "later" });
    }
    const go = footer.createEl("button", { cls: "mod-cta", text: "Decrypt & import" });
    go.onclick = () => this.submit(input.value);

    this.scope.register([], "Enter", (e) => { e.preventDefault(); this.submit(input.value); });
    requestAnimationFrame(() => input.focus());
  }
  private submit(pw: string): void {
    if (!pw) return; // empty password can't be right; keep the modal open
    this.finish({ kind: "password", value: pw });
  }
  private finish(result: StashPasswordResult): void {
    this.delivered = true;
    this.close();
    this.onResult(result);
  }
  onClose(): void {
    // Esc / click-out / Cancel button → "cancel" (back out for now, no snooze).
    if (!this.delivered) { this.delivered = true; this.onResult({ kind: "cancel" }); }
    this.contentEl.empty();
  }
}

/** 0.97.0 / 0.97.2: set / unlock / change the vault encryption password. One
 *  modal, three modes. The caller passes an async `onSubmit` that does the actual
 *  crypto and returns an error string to show IN the modal (keeping it open for a
 *  retry) or null on success (closes). setup/change also get a generate button,
 *  a live strength meter + length counter, and an optional "remember in this
 *  device's keychain" checkbox. */
export type EncryptionPromptMode = "setup" | "unlock" | "change";
export interface EncryptionPromptOpts {
  mode: EncryptionPromptMode;
  /** Show the "remember in this device's keychain" checkbox (setup/change). */
  offerKeychain?: boolean;
  /** Probe whether Argon2id runs here, to name the suite. */
  kdfProbe?: () => Promise<boolean>;
  /** Do the crypto. Return an error string → show in modal + keep open for retry;
   *  return null → success, close the modal. */
  onSubmit: (vals: { current?: string; next?: string; remember: boolean }) => Promise<string | null>;
  /** Called if the modal closes without a successful submit (Cancel/Esc). */
  onCancel?: () => void;
  /** Override the modal title (e.g. "Set shared password"). */
  title?: string;
  /** Override / add an intro paragraph (replaces the default setup blurb). */
  intro?: string;
}

export class EncryptionPasswordModal extends Modal {
  private succeeded = false;
  constructor(app: App, private opts: EncryptionPromptOpts) { super(app); }

  onOpen(): void {
    const { mode } = this.opts;
    this.contentEl.empty();
    this.modalEl.addClass("stashpad-export-modal", "stashpad-encryption-modal");
    this.titleEl.setText(
      this.opts.title ?? (mode === "setup" ? "Set up encryption password"
        : mode === "change" ? "Change encryption password"
          : "Unlock encryption"),
    );
    // 0.195.0: the badge alone said nothing. Beta encryption can lose data even when
    // the key is safe, so the risk + liability travel with every password dialog.
    const betaRow = this.contentEl.createDiv({ cls: "stashpad-beta-row" });
    betaRow.createEl("span", { cls: "stashpad-beta-badge", text: "BETA" });
    betaRow.createEl("span", { cls: "stashpad-beta-note", text: "Beta, unaudited encryption — not proven to protect anything, and data can be lost with or without your key. Keep unencrypted backups. Stashpad isn't liable for data loss or for a failure to keep your data private." });

    if (this.opts.intro) {
      this.contentEl.createEl("p", { cls: "stashpad-export-desc", text: this.opts.intro });
    } else if (mode === "setup") {
      this.contentEl.createEl("p", {
        cls: "stashpad-export-desc",
        text: "This single password protects everything you encrypt in this vault. It is stored only on this device. There is NO recovery — if you lose it, anything you've encrypted is gone for good.",
      });
    }

    // Each field gets an inline Copy/Paste button (Paste while empty, Copy once
    // it has a value), matching the .stash export modal.
    const pwSyncers: Array<() => void> = [];
    const field = (placeholder: string): HTMLInputElement => {
      const row = this.contentEl.createDiv({ cls: "stashpad-export-pw-row stashpad-encryption-row" });
      const i = row.createEl("input", { type: "password" });
      i.addClass("stashpad-export-name", "stashpad-encryption-field");
      i.placeholder = placeholder;
      const btn = row.createEl("button", { cls: "stashpad-export-copy" });
      const sync = () => {
        const empty = i.value.length === 0;
        btn.setText(empty ? "Paste" : "Copy");
        btn.toggleClass("is-paste", empty);
        btn.setAttr("aria-label", `${empty ? "Paste into" : "Copy"} ${placeholder.toLowerCase()}`);
      };
      btn.onclick = async (e) => {
        e.preventDefault();
        if (i.value.length === 0) {
          try {
            const txt = (await navigator.clipboard?.readText())?.trim();
            if (!txt) { new Notice("Clipboard is empty."); return; }
            i.value = txt; i.dispatchEvent(new Event("input")); new Notice("Pasted from clipboard.");
          } catch { new Notice("Couldn't read the clipboard."); }
        } else {
          void navigator.clipboard?.writeText(i.value).then(
            () => new Notice("Copied to clipboard."),
            () => new Notice("Couldn't access the clipboard."),
          );
        }
      };
      i.addEventListener("input", sync);
      sync();
      pwSyncers.push(sync);
      return i;
    };
    let currentEl: HTMLInputElement | null = null;
    let nextEl: HTMLInputElement | null = null;
    let confirmEl: HTMLInputElement | null = null;
    if (mode === "unlock" || mode === "change") currentEl = field("Current password");
    if (mode === "setup" || mode === "change") {
      nextEl = field(mode === "change" ? "New password" : "Password");
      confirmEl = field("Confirm password");
    }

    // setup/change extras: strength meter + length counter, generate + show, suite.
    if (nextEl) {
      const meter = this.contentEl.createDiv({ cls: "stashpad-export-strength" });
      const bar = meter.createDiv({ cls: "stashpad-strength-bar" });
      const segs = [0, 1, 2, 3].map(() => bar.createDiv({ cls: "stashpad-strength-seg" }));
      const label = meter.createEl("span", { cls: "stashpad-strength-label" });
      const counter = this.contentEl.createDiv({ cls: "stashpad-encryption-counter" });

      const refresh = () => {
        const v = nextEl.value;
        const s = estimatePasswordStrength(v);
        segs.forEach((seg, i) => seg.toggleClass("is-on", i < s.level));
        label.setText(v ? s.label : "");
        counter.setText(`${v.length} character${v.length === 1 ? "" : "s"}${v.length > 0 && v.length < 6 ? " — use at least 6" : ""}`);
        counter.toggleClass("is-weak", v.length > 0 && v.length < 6);
      };
      nextEl.addEventListener("input", refresh);
      refresh();

      const genRow = this.contentEl.createDiv({ cls: "stashpad-export-genrow" });
      genRow.createEl("button", { cls: "stashpad-export-gen", text: "Generate strong passphrase" }).onclick = (e) => {
        e.preventDefault();
        const pw = generatePassphrase(5);
        nextEl.value = pw;
        if (confirmEl) confirmEl.value = pw;
        // Keep it masked — the user reveals with Show if they want; it's already
        // copied to the clipboard below, and Copy works while masked.
        refresh();
        pwSyncers.forEach((s) => s()); // flip Copy/Paste buttons
        new Notice("Generated — copy it somewhere safe; there's no recovery.");
        void navigator.clipboard?.writeText(pw).catch(() => {});
      };
      const showBtn = genRow.createEl("button", { cls: "stashpad-export-show", text: "Show" });
      showBtn.onclick = (e) => {
        e.preventDefault();
        const show = nextEl.type === "password";
        nextEl.type = show ? "text" : "password";
        if (confirmEl) confirmEl.type = show ? "text" : "password";
        showBtn.setText(show ? "Hide" : "Show");
      };

      const suite = this.contentEl.createEl("div", { cls: "stashpad-export-pw-suite" });
      suite.setText("Encryption: AES-256-GCM. Checking key-derivation suite…");
      if (this.opts.kdfProbe) {
        void this.opts.kdfProbe().then((ok) => {
          suite.toggleClass("is-weak", !ok);
          suite.setText(ok
            ? "Encryption: Argon2id + AES-256-GCM — the strongest suite (used on this device)."
            : "⚠️ Argon2id can't run here, so this will use the weaker PBKDF2 (600k) + AES-256-GCM fallback.");
        }).catch(() => suite.setText("Encryption: AES-256-GCM with a password-derived key."));
      } else {
        suite.setText("Encryption: Argon2id + AES-256-GCM (PBKDF2 fallback if Argon2 can't run here).");
      }
    }

    // Optional: remember in this device's keychain.
    let rememberCb: HTMLInputElement | null = null;
    const secretStorage = (this.app as App & { secretStorage?: SecretStorage }).secretStorage;
    if (this.opts.offerKeychain && secretStorage) {
      const row = this.contentEl.createDiv({ cls: "stashpad-export-remember" });
      rememberCb = row.createEl("input", { type: "checkbox" });
      rememberCb.id = "stashpad-enc-remember";
      rememberCb.checked = true; // 0.143.0: default ON for seamless auto-unlock; untick to require re-typing.
      const lbl = row.createEl("label", { text: "Remember on this device (keychain) — auto-unlock here without re-typing." });
      lbl.htmlFor = rememberCb.id;
      const note = this.contentEl.createDiv({ cls: "stashpad-export-remember-note" });
      // 0.194.0: this checkbox is where people accidentally make the keychain the
      // ONLY copy of their password. Say so here, at the moment of the decision.
      note.setText("Stored only in this device's keychain — it doesn't sync, and anyone with access to this unlocked device could decrypt. This is a convenience, NOT a backup: an OS/keychain reset, a restored profile, a reinstall or a new machine can erase it without warning. Keep the password in a password manager too, or you will lose access to everything encrypted under it.");
      note.addClass("stashpad-keychain-note");
      note.setCssStyles({ display: rememberCb.checked ? "" : "none" });
      rememberCb.onchange = () => { note.setCssStyles({ display: rememberCb!.checked ? "" : "none" }); };
    }

    const errEl = this.contentEl.createEl("div", { cls: "stashpad-export-error" });
    errEl.setCssStyles({ display: "none" });
    const showErr = (m: string) => { errEl.setText(m); errEl.setCssStyles({ display: "" }); };

    const footer = this.contentEl.createDiv({ cls: "stashpad-export-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const go = footer.createEl("button", {
      cls: "mod-cta",
      text: mode === "setup" ? "Set up" : mode === "change" ? "Change" : "Unlock",
    });

    let busy = false;
    const submit = async () => {
      if (busy) return;
      const current = currentEl?.value ?? undefined;
      const next = nextEl?.value ?? undefined;
      if ((mode === "unlock" || mode === "change") && !current) { showErr("Enter your current password."); return; }
      if (mode === "setup" || mode === "change") {
        if (!next) { showErr("Enter a password."); return; }
        if (next.length < 6) { showErr("Use at least 6 characters."); return; }
        if (next !== confirmEl?.value) { showErr("Passwords don't match."); return; }
      }
      busy = true; go.disabled = true; errEl.setCssStyles({ display: "none" });
      const prevLabel = go.textContent;
      go.setText("Working…");
      try {
        const err = await this.opts.onSubmit({ current, next, remember: !!rememberCb?.checked });
        if (err) { showErr(err); busy = false; go.disabled = false; go.setText(prevLabel ?? "OK"); return; }
        this.succeeded = true;
        this.close(); // success
      } catch (e) {
        showErr(`Failed: ${(e as Error).message}`);
        busy = false; go.disabled = false; go.setText(prevLabel ?? "OK");
      }
    };
    go.onclick = () => void submit();
    this.scope.register([], "Enter", (e) => { e.preventDefault(); void submit(); });
    requestAnimationFrame(() => (currentEl ?? nextEl)?.focus());
  }
  onClose(): void {
    this.contentEl.empty();
    if (!this.succeeded) this.opts.onCancel?.();
  }
}

/** 0.97.2: a destructive-action confirm that requires typing an exact phrase
 *  (game/GitHub-style) before the action button enables. */
export class TypeToConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string; body: string; phrase: string; confirmText: string;
      /** When set, the user must ALSO enter a password that this verifies before
       *  the action runs (proves they know it, not just that the session's open). */
      requirePassword?: (pw: string) => Promise<boolean>;
      onConfirm: () => void | Promise<void>;
    },
  ) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.modalEl.addClass("stashpad-export-modal", "stashpad-encryption-modal");
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { cls: "stashpad-export-desc", text: this.opts.body });

    let pwInput: HTMLInputElement | null = null;
    if (this.opts.requirePassword) {
      this.contentEl.createEl("p", { cls: "stashpad-export-desc" }).setText("Enter your encryption password:");
      pwInput = this.contentEl.createEl("input", { type: "password" });
      pwInput.addClass("stashpad-export-name", "stashpad-encryption-field");
      pwInput.placeholder = "Password";
    }

    this.contentEl.createEl("p", { cls: "stashpad-export-desc" }).setText(`Type "${this.opts.phrase}" to confirm.`);
    const input = this.contentEl.createEl("input", { type: "text" });
    input.addClass("stashpad-export-name", "stashpad-encryption-field");
    input.placeholder = this.opts.phrase;

    const errEl = this.contentEl.createEl("div", { cls: "stashpad-export-error" });
    errEl.setCssStyles({ display: "none" });

    const footer = this.contentEl.createDiv({ cls: "stashpad-export-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const go = footer.createEl("button", { cls: "mod-cta mod-warning", text: this.opts.confirmText });
    // Phrase match is case-INSENSITIVE (typing "remove encryption" is as good as
    // "REMOVE ENCRYPTION") — the phrase is a speed-bump, not a secret. The
    // password (when required) is still matched exactly by requirePassword().
    const phraseOk = () => input.value.trim().toLowerCase() === this.opts.phrase.trim().toLowerCase();
    const sync = () => { go.disabled = !phraseOk() || (!!this.opts.requirePassword && !pwInput?.value); };
    input.addEventListener("input", sync);
    pwInput?.addEventListener("input", sync);
    sync();

    let busy = false;
    const run = async () => {
      if (busy || !phraseOk()) return;
      if (this.opts.requirePassword) {
        busy = true; go.disabled = true; errEl.setCssStyles({ display: "none" });
        const ok = await this.opts.requirePassword(pwInput!.value);
        if (!ok) { errEl.setText("Wrong password."); errEl.setCssStyles({ display: "" }); busy = false; sync(); return; }
      }
      this.close();
      await this.opts.onConfirm();
    };
    go.onclick = () => void run();
    this.scope.register([], "Enter", (e) => { e.preventDefault(); void run(); });
    requestAnimationFrame(() => (pwInput ?? input).focus());
  }
  onClose(): void { this.contentEl.empty(); }
}

/** Paste an `obsidian://stashpad?…` link and open it — the manual counterpart to
 *  clicking a hyperlinked deep link, for apps that won't render `obsidian://`
 *  URLs as clickable links. Prefills from the clipboard when it holds a Stashpad
 *  link so the common case is just Enter. */
export class OpenDeepLinkModal extends Modal {
  constructor(app: App, private onSubmit: (raw: string) => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.modalEl.addClass("stashpad-export-modal");
    this.titleEl.setText("Open Stashpad link");
    this.contentEl.createEl("p", { cls: "stashpad-export-desc", text: "Paste one or more obsidian://stashpad links (one per line) to jump to the notes they point to. Multiple links each open in their own tab." });

    // Input + an explicit Paste button on one row. The button matters on mobile
    // (and anywhere clipboard auto-read is blocked) where the auto-prefill below
    // can't run — one tap fills the field. 0.155.3: a textarea (not a single-line
    // input) so a multi-link paste keeps its newlines.
    const row = this.contentEl.createDiv({ cls: "stashpad-open-link-row" });
    // Paste on the LEFT, input fills the rest of the row.
    const pasteBtn = row.createEl("button", { cls: "stashpad-open-link-paste" });
    setIcon(pasteBtn.createSpan({ cls: "stashpad-open-link-paste-icon" }), "clipboard-paste");
    pasteBtn.createSpan({ text: "Paste" });
    pasteBtn.title = "Paste from clipboard";
    const input = row.createEl("textarea", { attr: { rows: "3" } });
    input.addClass("stashpad-export-name");
    input.placeholder = "obsidian://stashpad?folder=…&note=…";
    // 0.208.5: read through readClipboardText(), which prefers ELECTRON's
    // clipboard. 0.199.3 switched this to the modal's own window's navigator,
    // which only helps when that window happens to be the OS-focused one —
    // `navigator.clipboard.readText()` rejects with "document is not focused"
    // otherwise. That is why auto-paste worked in some vaults' secondary windows
    // and never in another: it depended on which window had focus at that
    // instant, not on the vault. Electron's clipboard has no focus dependency.
    // The window is still passed for the navigator fallback (mobile).
    const modalWin = this.contentEl.ownerDocument?.defaultView ?? null;
    pasteBtn.onclick = async () => {
      const t = (await readClipboardText(modalWin)).trim();
      if (t) { input.value = t; autoHint.hide(); }
      else new Notice("Couldn't read the clipboard — paste manually.");
      input.focus();
    };
    // A manual paste or edit means the field is no longer the auto-pasted link —
    // drop the green confirmation so it isn't misleading.
    input.addEventListener("input", () => autoHint.hide());

    // 0.172.x: green confirmation shown ONLY when the link was auto-pasted from
    // the clipboard (the auto-prefill below), so it's clear the field wasn't
    // pre-populated by magic — Stashpad read a link off your clipboard.
    const autoHint = this.contentEl.createEl("div", { cls: "stashpad-open-link-autohint" });
    setIcon(autoHint.createSpan({ cls: "stashpad-open-link-autohint-icon" }), "clipboard-check");
    autoHint.createSpan({ text: "Link automatically pasted from your clipboard." });
    autoHint.hide();

    const footer = this.contentEl.createDiv({ cls: "stashpad-export-footer" });
    footer.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const go = footer.createEl("button", { cls: "mod-cta", text: "Open" });

    const run = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.onSubmit(v);
    };
    go.onclick = () => run();
    this.scope.register([], "Enter", (e) => { e.preventDefault(); run(); });

    requestAnimationFrame(() => {
      input.focus();
      // Prefill from the clipboard when it already holds a Stashpad link — the
      // whole point is pasting, so save the paste. Selected so the user can
      // overwrite with a real paste if it's the wrong link. Best-effort.
      void readClipboardText(modalWin).then((t) => {
        if (!input.value && t && /obsidian:\/\/stashpad\?/i.test(t.trim())) {
          input.value = t.trim();
          input.select();
          autoHint.show(); // green "auto-pasted" confirmation
        }
      });
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

export class CustomColorModal extends Modal {
  private value: string;
  private delivered = false;
  /** Whether the user actually changed the color. A dismiss (Esc/click-out)
   *  without touching anything must NOT apply the seeded default. (0.140.6) */
  private touched = false;
  constructor(
    app: App,
    seed: string | null,
    private onResult: (color: string | null, opts: { addToPalette: boolean }) => void,
  ) {
    super(app);
    this.value = seed && /^#[0-9a-f]{6}$/i.test(seed) ? seed : "#888888";
  }
  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Custom color");
    this.modalEl.addClass("stashpad-custom-color-modal");

    const row = this.contentEl.createDiv({ cls: "stashpad-custom-color-row" });
    const preview = row.createDiv({ cls: "stashpad-custom-color-preview" });
    preview.style.background = this.value;

    // Native wheel — clicking the preview pops the OS color picker.
    const wheel = row.createEl("input", { type: "color" });
    wheel.value = this.value;
    wheel.addClass("stashpad-custom-color-wheel");
    preview.onclick = () => wheel.click();

    // Hex text input for direct entry. Synced both ways with the wheel.
    const hex = row.createEl("input", { type: "text" });
    hex.addClass("stashpad-custom-color-hex");
    hex.placeholder = "#RRGGBB";
    hex.value = this.value;
    hex.maxLength = 7;

    const sync = (next: string) => {
      const v = next.startsWith("#") ? next : "#" + next;
      if (!/^#[0-9a-f]{6}$/i.test(v)) return;
      this.touched = true;
      this.value = v;
      preview.style.background = v;
      wheel.value = v;
      if (hex.value !== v) hex.value = v;
    };
    wheel.oninput = () => sync(wheel.value);
    hex.oninput = () => sync(hex.value);

    const footer = this.contentEl.createDiv({ cls: "stashpad-color-footer" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.delivered = true; this.close(); };
    const save = footer.createEl("button", { cls: "mod-cta", text: "Save" });
    save.title = "Apply this color to the selection (without adding to your palette).";
    save.onclick = () => this.commit({ addToPalette: false });
    const add = footer.createEl("button", { cls: "mod-cta", text: "Add to palette" });
    add.title = "Apply and save this color so it appears as a tile next time.";
    add.onclick = () => this.commit({ addToPalette: true });

    this.scope.register([], "Enter", (e) => { e.preventDefault(); this.commit({ addToPalette: false }); });
    this.scope.register(["Mod"], "Enter", (e) => { e.preventDefault(); this.commit({ addToPalette: true }); });

    requestAnimationFrame(() => hex.focus());
  }
  private commit(opts: { addToPalette: boolean }): void {
    this.delivered = true;
    this.close();
    this.onResult(this.value, opts);
  }
  onClose(): void {
    if (!this.delivered && this.touched) {
      // Click-out / Esc AFTER changing the color → apply hastily (no palette
      // persistence), matching the user's "skip adding" intent. An UNtouched
      // dismiss is a cancel — don't paint the seeded default over the note.
      this.delivered = true;
      this.onResult(this.value, { addToPalette: false });
    }
    this.contentEl.empty();
  }
}

/** Compact color picker. Presents a grid of preset swatches and the user's
 *  saved custom palette, plus a "+" tile that opens CustomColorModal for
 *  arbitrary hex picking. The "no color" tile (slash) clears the assignment.
 *
 *  Behavior:
 *  - Arrow keys navigate the grid; Enter activates the highlighted tile.
 *    For preset/saved tiles that means apply-and-close. For the "+" tile
 *    it opens the custom-color submenu (this modal stays open behind it).
 *  - There is no Save button on this modal — clicking a preset is the
 *    explicit "apply" action.
 */
export class ColorPickerModal extends Modal {
  static DEFAULT_PALETTE: string[] = [
    "#E07A78", "#E08A47", "#E0A744", "#B0CC6E", "#6BC07A",
    "#5BA9CE", "#9B82C9", "#C57AB5", "#D75AA8",
  ];

  /** Active grid index for keyboard nav. -1 = no focus yet. */
  private focusIdx = -1;
  /** Guard so re-rendering the grid (handleDelete → onOpen) doesn't stack a
   *  second copy of the keyboard handlers on the persistent scope. (0.140.6) */
  private scopeBound = false;
  /** 0.199.4: DOM-level key handler used only when the modal lives in a
   *  secondary window (the keymap scope doesn't receive keys there). */
  private popoutKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Snapshot of selectable tiles in render order. The "+" tile is `kind:
   *  "add"` and opens CustomColorModal rather than committing directly. */
  private items: { kind: "none" | "preset" | "custom" | "add"; color: string | null; el: HTMLElement }[] = [];

  constructor(
    app: App,
    private currentColor: string | null,
    private customPalette: string[],
    private onPick: (color: string | null, opts: { addToPalette?: boolean }) => void,
    /** Optional: invoked when the user clicks the ✕ on a saved tile.
     *  The host should remove the color from settings.customPalette and log
     *  the deletion. Returning a fresh palette array updates this modal in
     *  place so the user can keep deleting. */
    private onDeleteCustom?: (color: string) => Promise<string[]> | string[],
  ) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Pick a color");
    this.modalEl.addClass("stashpad-color-modal");

    const grid = this.contentEl.createDiv({ cls: "stashpad-color-grid" });
    this.items = [];

    // "No color" tile (slash).
    const noTile = grid.createDiv({ cls: "stashpad-color-tile stashpad-color-none" });
    noTile.title = "No color";
    noTile.onclick = () => this.activate(0);
    this.items.push({ kind: "none", color: null, el: noTile });

    const allPresets = [...ColorPickerModal.DEFAULT_PALETTE, ...this.customPalette];
    for (const c of allPresets) {
      const tile = grid.createDiv({ cls: "stashpad-color-tile" });
      tile.style.background = c;
      tile.title = c;
      const isCustom = !ColorPickerModal.DEFAULT_PALETTE.some((d) => d.toLowerCase() === c.toLowerCase());
      const idx = this.items.length;
      tile.onclick = () => this.activate(idx);
      // Saved-custom tiles get a ✕ that deletes them from the persisted
      // palette. Defaults aren't deletable.
      if (isCustom && this.onDeleteCustom) {
        const del = tile.createSpan({ cls: "stashpad-color-tile-del", text: "×" });
        del.title = "Remove from palette";
        del.onclick = (e) => {
          e.stopPropagation();
          void this.handleDelete(c);
        };
      }
      this.items.push({ kind: isCustom ? "custom" : "preset", color: c, el: tile });
    }

    // "+" tile that opens the custom-color submenu.
    const addTile = grid.createDiv({ cls: "stashpad-color-tile stashpad-color-add" });
    addTile.title = "Custom color…";
    const addIdx = this.items.length;
    addTile.onclick = () => this.activate(addIdx);
    this.items.push({ kind: "add", color: null, el: addTile });

    // Initial focus: the tile matching currentColor, else the first preset.
    const seedIdx = this.items.findIndex((it) => {
      if (this.currentColor === null) return it.kind === "none";
      if (!this.currentColor) return false;
      return it.color !== null && it.color.toLowerCase() === this.currentColor.toLowerCase();
    });
    this.focusIdx = seedIdx >= 0 ? seedIdx : 0;
    this.refreshActive();

    // Keyboard nav: arrows move focus; Enter activates. Registered once — the
    // handlers read live this.focusIdx/this.items, so they survive a grid
    // rebuild; re-registering (handleDelete → onOpen) would stack duplicates.
    if (!this.scopeBound) {
      this.scope.register([], "ArrowRight", (e) => { e.preventDefault(); this.moveFocus(1); });
      this.scope.register([], "ArrowLeft",  (e) => { e.preventDefault(); this.moveFocus(-1); });
      this.scope.register([], "ArrowDown",  (e) => { e.preventDefault(); this.moveFocus(this.columns()); });
      this.scope.register([], "ArrowUp",    (e) => { e.preventDefault(); this.moveFocus(-this.columns()); });
      this.scope.register([], "Enter",      (e) => { e.preventDefault(); this.activate(this.focusIdx); });
      this.scopeBound = true;
    }

    // 0.199.4: in a SECONDARY window the keymap scope above never receives
    // keys (verified with trusted CDP key events: arrows were completely dead
    // in a pop-out — grid focus frozen, list guarded by isAnyModalOpen). Bind
    // plain DOM handlers on the modal's own document as the pop-out path.
    // Main-window modals keep the scope path only, so keys are never handled
    // twice.
    const doc = this.modalEl.ownerDocument;
    if (doc !== document && !this.popoutKeyHandler) {
      this.popoutKeyHandler = (e: KeyboardEvent): void => {
        const step: Record<string, number> = {
          ArrowRight: 1, ArrowLeft: -1, ArrowDown: this.columns(), ArrowUp: -this.columns(),
        };
        if (e.key in step) {
          e.preventDefault(); e.stopPropagation();
          this.moveFocus(step[e.key]);
        } else if (e.key === "Enter") {
          e.preventDefault(); e.stopPropagation();
          this.activate(this.focusIdx);
        } else if (e.key === "Escape") {
          e.preventDefault(); e.stopPropagation();
          this.close();
        }
      };
      doc.addEventListener("keydown", this.popoutKeyHandler, true);
    }

    // After paint, focus the modal so arrow keys land here, not in the
    // background view.
    requestAnimationFrame(() => (this.modalEl).focus());
  }

  /** Click or Enter on a tile. Preset/saved/none → apply immediately + close.
   *  Add → open the custom-color submenu (this modal hands off and closes). */
  private activate(i: number): void {
    if (i < 0 || i >= this.items.length) return;
    this.focusIdx = i;
    this.refreshActive();
    const it = this.items[i];
    if (it.kind === "add") {
      // Hand off to the custom submenu. We close this modal first so we
      // don't stack two on top of each other; the submenu fires onPick.
      this.close();
      new CustomColorModal(this.app, this.currentColor, (color, opts) => {
        this.onPick(color, opts);
      }).open();
      return;
    }
    this.close();
    this.onPick(it.color, { addToPalette: false });
  }

  /** Approximate column count from the rendered grid (for vertical arrows). */
  private columns(): number {
    if (!this.items.length) return 1;
    const grid = this.items[0].el.parentElement;
    if (!grid) return 1;
    const gridRect = grid.getBoundingClientRect();
    const tileRect = this.items[0].el.getBoundingClientRect();
    if (tileRect.width <= 0) return 1;
    // Rough: total width / (tile + gap). We use the displayed positions to
    // count tiles in the first row instead — more robust to gap rounding.
    const firstTop = tileRect.top;
    let cols = 0;
    for (const it of this.items) {
      const r = it.el.getBoundingClientRect();
      if (Math.abs(r.top - firstTop) < 1) cols++;
      else break;
    }
    void gridRect;
    return Math.max(1, cols);
  }

  private async handleDelete(color: string): Promise<void> {
    if (!this.onDeleteCustom) return;
    try {
      const next = await this.onDeleteCustom(color);
      // Re-render the grid in place with the updated palette so the user
      // can keep tidying.
      this.customPalette = Array.isArray(next) ? next : this.customPalette.filter((c) => c.toLowerCase() !== color.toLowerCase());
      this.onOpen();
    } catch (e) {
      // Swallow: host can show its own notice.
      console.warn("Stashpad: palette delete failed", e);
    }
  }

  private moveFocus(delta: number): void {
    if (!this.items.length) return;
    const next = Math.max(0, Math.min(this.items.length - 1, this.focusIdx + delta));
    this.focusIdx = next;
    this.refreshActive();
  }

  private refreshActive(): void {
    for (let i = 0; i < this.items.length; i++) {
      this.items[i].el.toggleClass("is-active", i === this.focusIdx);
    }
  }

  onClose(): void {
    if (this.popoutKeyHandler) {
      this.modalEl.ownerDocument.removeEventListener("keydown", this.popoutKeyHandler, true);
      this.popoutKeyHandler = null;
    }
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  /** Tracks whether the user made an explicit choice via the button
   *  row. If the modal closes any other way (Escape, click on the
   *  background overlay), onClose treats it as Cancel so callers
   *  don't hang waiting for a choice. */
  private didChoose = false;
  constructor(
    app: App,
    private titleText: string,
    private message: string,
    private confirmText: string,
    private onChoose: (confirmed: boolean) => void,
    private cancelText: string = "Cancel",
    /** When true (destructive confirms like "Clear log"), focus Cancel instead
     *  of Confirm so a stray Enter doesn't fire the irreversible action. */
    private dangerous: boolean = false,
    /** 0.201.3: when true, ONLY the two buttons close the modal — Escape and
     *  clicking outside are ignored. For prompts that must not be lost to a
     *  stray click (the cross-vault "delete the cut originals?" offer arrives
     *  exactly as the user clicks the window to focus it). */
    private persistent: boolean = false,
  ) { super(app); }

  /** 0.214.2: optional list of vault files rendered BELOW the message as
   *  clickable rows, in their own scroll region.
   *
   *  Two reasons this isn't just more message lines. (1) A confirm that names
   *  files is asking the user to make a decision ABOUT those files, and they
   *  can't do that without looking at them — so each row opens the file.
   *  (2) The count is unbounded (a folder can hold hundreds of shared
   *  attachments), and an unbounded list grows the modal past the screen and
   *  pushes the buttons out of reach. The region caps and scrolls instead. */
  private fileList: string[] = [];
  setFileList(paths: string[]): this { this.fileList = paths; return this; }

  close(): void {
    if (this.persistent && !this.didChoose) return; // buttons only
    super.close();
  }
  onOpen(): void {
    this.modalEl?.addClass("stashpad-compact-modal"); // 0.76.18
    this.contentEl.empty();
    this.titleEl.setText(this.titleText);
    // 0.63.2: render each newline-separated sentence on its own line.
    // Earlier the entire message was crammed into one <p> which
    // collapsed newlines into single spaces — callers passing
    // multi-sentence prose lost the formatting.
    const block = this.contentEl.createDiv({ cls: "stashpad-confirm-body" });
    // 0.212.0: render **bold** / `code` per line, via the same safe tokenizer the
    // toasts use (textContent only, never innerHTML). The cross-vault confirms
    // bold the note and vault NAMES rather than quoting them.
    for (const line of this.message.split("\n")) {
      renderInlineMarkup(block.createDiv({ cls: "stashpad-confirm-line" }), line);
    }
    if (this.fileList.length) {
      const list = this.contentEl.createDiv({ cls: "stashpad-confirm-files" });
      for (const path of this.fileList) {
        const row = list.createEl("button", { cls: "stashpad-confirm-file" });
        row.createSpan({ cls: "stashpad-confirm-file-name", text: path.split("/").pop() || path });
        row.createSpan({ cls: "stashpad-confirm-file-path", text: path });
        row.title = `Open ${path}`;
        row.onclick = (e) => {
          e.preventDefault();
          // Open in a new tab and leave the confirm up — the user is inspecting
          // in order to answer it, so dismissing here would lose their place.
          this.app.workspace.openLinkText(path, "", true);
        };
      }
    }
    const row = this.contentEl.createDiv({ cls: "stashpad-modal-btns" });
    const cancel = row.createEl("button", { text: this.cancelText });
    cancel.onclick = () => { this.didChoose = true; this.close(); this.onChoose(false); };
    const ok = row.createEl("button", { cls: "mod-cta", text: this.confirmText });
    ok.onclick = () => { this.didChoose = true; this.close(); this.onChoose(true); };
    // Focus the confirm button so Enter accepts — but for destructive confirms
    // focus Cancel instead, so a stray Enter cancels rather than fires. (0.140.6)
    requestAnimationFrame(() => (this.dangerous ? cancel : ok).focus());
  }
  onClose(): void {
    this.contentEl.empty();
    // If the modal closed without an explicit Cancel/Confirm (e.g.
    // user clicked the background overlay or pressed Escape), treat
    // as Cancel so callers don't hang.
    if (!this.didChoose) {
      this.didChoose = true;
      this.onChoose(false);
    }
  }
}

/** 0.117.0: breadcrumb "all levels" picker. The breadcrumb row squishes
 *  (and clips its rightmost crumbs) when the pane is narrow or the path is
 *  deep, so this modal lists EVERY level top-to-bottom — full titles, no
 *  truncation — and lets the user jump to any one. Mobile-responsive: rows
 *  are full-width tap targets; indentation conveys depth. The current level
 *  is marked and non-navigating. */
export interface BreadcrumbLevel {
  id: string;
  /** Full, untruncated title for this level. */
  label: string;
  /** 0 = Home; 1..n = depth down the path. Drives the indent. */
  level: number;
  isCurrent: boolean;
  isHome?: boolean;
}
export interface BreadcrumbLevelsModalOpts {
  /** Open the same context menu the inline crumbs use, for a given level.
   *  `evt` is the MouseEvent for right-click, or null for long-press;
   *  `anchorEl` is the row (long-press anchor); `close` dismisses the modal. */
  onContext?: (id: string, evt: MouseEvent | null, anchorEl: HTMLElement, close: () => void) => void;
  /** Mobile long-press wiring (the view's attachLongPress). */
  attachLongPress?: (el: HTMLElement, cb: () => void) => void;
}
export class BreadcrumbLevelsModal extends Modal {
  constructor(
    app: App,
    private levels: BreadcrumbLevel[],
    private onPick: (id: string) => void,
    private opts: BreadcrumbLevelsModalOpts = {},
  ) { super(app); }
  onOpen(): void {
    this.modalEl?.addClass("stashpad-compact-modal");
    this.modalEl?.addClass("stashpad-breadcrumb-modal");
    this.contentEl.empty();
    this.titleEl.setText("Jump to level");
    const list = this.contentEl.createDiv({ cls: "stashpad-bc-levels" });
    for (const lvl of this.levels) {
      const row = list.createDiv({ cls: "stashpad-bc-level-row" });
      if (lvl.isCurrent) row.addClass("is-current");
      // Flat, left-aligned rows (no indentation) so deep levels stay
      // full-width on a narrow phone. Depth is conveyed by a leading level
      // number — Home is 0, then 1..n down the path.
      row.createSpan({ cls: "stashpad-bc-level-num", text: String(lvl.level) });
      row.createSpan({ cls: "stashpad-bc-level-label", text: lvl.label });
      // The current level is shown by its accent number chip + highlighted
      // row (no "current" text label — it just padded the width).
      if (!lvl.isCurrent) {
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        const go = (): void => { this.close(); this.onPick(lvl.id); };
        row.onclick = go;
        row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
      }
      // Context-menu parity with the inline crumbs — every row (incl. the
      // current one) gets right-click + long-press → the same crumb menu.
      if (this.opts.onContext) {
        row.oncontextmenu = (evt) => {
          evt.preventDefault();
          this.opts.onContext!(lvl.id, evt, row, () => this.close());
        };
        this.opts.attachLongPress?.(row, () => this.opts.onContext!(lvl.id, null, row, () => this.close()));
      }
    }
  }
  onClose(): void { this.contentEl.empty(); }
}

/** 0.76.1: pick a due date + time for a task. Uses native
 *  <input type="date"> + <input type="time"> so mobile gets the OS
 *  date/time pickers for free. Quick-preset buttons (Today, Tomorrow,
 *  Next week) fill the inputs without typing. Returns an ISO string
 *  (date + time, local) or null to clear the due date. The callback
 *  receives `undefined` if the modal was dismissed without choosing. */
/** 0.78.3: shared assignee-picker widget — removable chips + an
 *  autocomplete that Sift-matches known authors and accepts free entry
 *  ("Create 'Name'" → mints a fresh author id). Maintains its own working
 *  list and calls onChange(list) on every mutation. Used by both the due
 *  picker's "Assign to" section and the standalone AssignModal. */
export function buildAssigneePicker(
  wrap: HTMLElement,
  opts: { knownAuthors: AssigneeRef[]; initial: AssigneeRef[]; onChange: (list: AssigneeRef[]) => void },
): void {
  let assignees: AssigneeRef[] = [...opts.initial];
  const known = opts.knownAuthors;
  const sec = wrap.createDiv({ cls: "stashpad-assign" });
  sec.createDiv({ cls: "stashpad-assign-label", text: "Assign to" });
  const chips = sec.createDiv({ cls: "stashpad-assign-chips" });
  const inputWrap = sec.createDiv({ cls: "stashpad-assign-input-wrap" });
  const input = inputWrap.createEl("input", {
    type: "text", cls: "stashpad-assign-input",
    attr: { placeholder: "Add a person — type a name…" },
  });
  const sugg = inputWrap.createDiv({ cls: "stashpad-assign-suggest" });
  sugg.setCssStyles({ display: "none" });

  const commit = () => opts.onChange([...assignees]);
  const renderChips = (): void => {
    chips.empty();
    if (assignees.length === 0) chips.createSpan({ cls: "stashpad-assign-empty", text: "No one yet" });
    for (const a of assignees) {
      const chip = chips.createSpan({ cls: "stashpad-assign-chip" });
      chip.createSpan({ cls: "stashpad-assign-chip-name", text: a.name });
      const x = chip.createSpan({ cls: "stashpad-assign-chip-x", text: "×" });
      x.title = `Remove ${a.name}`;
      x.onclick = () => { assignees = assignees.filter((p) => p.id !== a.id); commit(); renderChips(); };
    }
  };
  const addAssignee = (a: AssigneeRef): void => {
    if (!a.name.trim()) return;
    if (!assignees.some((p) => p.id === a.id)) assignees.push(a);
    input.value = ""; sugg.setCssStyles({ display: "none" }); commit(); renderChips(); input.focus();
  };
  const refresh = (): void => {
    const q = input.value.trim();
    sugg.empty();
    const taken = new Set(assignees.map((p) => p.id));
    const matches = known.filter((a) => !taken.has(a.id) && siftMatch(q, a.name)).slice(0, 6);
    const rows: Array<{ label: string; onPick: () => void }> = matches.map((a) => ({
      label: a.name, onPick: () => addAssignee(a),
    }));
    if (q && !known.some((a) => a.name.toLowerCase() === q.toLowerCase())) {
      rows.push({ label: `Create “${q}”`, onPick: () => addAssignee({ id: newId(6), name: q }) });
    }
    if (rows.length === 0) { sugg.setCssStyles({ display: "none" }); return; }
    sugg.setCssStyles({ display: "" });
    for (const r of rows) {
      const item = sugg.createDiv({ cls: "stashpad-assign-suggest-item", text: r.label });
      item.onmousedown = (e) => { e.preventDefault(); r.onPick(); };
    }
  };
  input.addEventListener("input", refresh);
  input.addEventListener("focus", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = sugg.querySelector(".stashpad-assign-suggest-item");
      if (first) first.dispatchEvent(new MouseEvent("mousedown"));
    } else if (e.key === "Escape" && sugg.style.display !== "none") {
      e.stopPropagation(); sugg.setCssStyles({ display: "none" });
    }
  });
  input.addEventListener("blur", () => { window.setTimeout(() => { sugg.setCssStyles({ display: "none" }); }, 120); });
  renderChips();
}

/** 0.78.3: standalone "Assign to" modal — assignment without touching the
 *  due date. onPick gets the chosen assignee set; not called on dismiss. */
export class DueDatePickerModal extends Modal {
  private didChoose = false;
  /** Working set of assignees, mutated by the chips UI. */
  private assignees: AssigneeRef[] = [];
  constructor(
    app: App,
    /** Existing due value (ISO) to pre-fill, or null/undefined. */
    private current: string | null | undefined,
    /** Called with the chosen due ISO (or null to clear) AND the chosen
     *  assignee set. Not called on dismiss-without-choice. Back-compat:
     *  a caller may still pass a `(iso) => void` — we detect arity and
     *  adapt — but new callers should take the DuePickResult. */
    private onPick: (result: DuePickResult) => void,
    private opts: DuePickerOptions = {},
  ) {
    super(app);
    this.assignees = [...(opts.currentAssignees ?? [])];
  }

  onOpen(): void {
    this.modalEl?.addClass("stashpad-compact-modal"); // 0.76.18
    this.contentEl.empty();
    this.titleEl.setText(this.opts.title ?? "Set due date");

    // Pre-fill from the current value when parseable.
    let initial: Date | null = null;
    if (this.current) {
      const t = Date.parse(this.current);
      if (!Number.isNaN(t)) initial = new Date(t);
    }

    const wrap = this.contentEl.createDiv({ cls: "stashpad-due-picker" });
    // 0.76.5: each field is [leading icon] + input, constrained width
    // (the native inputs default to absurdly wide). Date row gets a
    // calendar icon; time row gets a clock icon at its START.
    const fields = wrap.createDiv({ cls: "stashpad-due-fields" });
    const dateField = fields.createDiv({ cls: "stashpad-due-field" });
    const dateIcon = dateField.createSpan({ cls: "stashpad-due-field-icon" });
    setIcon(dateIcon, "calendar");
    const dateInput = dateField.createEl("input", { type: "date", cls: "stashpad-due-date" });
    // 0.104.x: dedicated × to clear this field independently.
    const dateClear = dateField.createSpan({ cls: "stashpad-due-clear", attr: { "aria-label": "Clear date" } });
    setIcon(dateClear, "x");
    dateClear.onclick = () => { dateInput.value = ""; dateInput.focus(); };
    const timeField = fields.createDiv({ cls: "stashpad-due-field" });
    const timeIcon = timeField.createSpan({ cls: "stashpad-due-field-icon" });
    setIcon(timeIcon, "clock");
    const timeInput = timeField.createEl("input", { type: "time", cls: "stashpad-due-time" });
    const timeClear = timeField.createSpan({ cls: "stashpad-due-clear", attr: { "aria-label": "Clear time" } });
    setIcon(timeClear, "x");
    timeClear.onclick = () => { timeInput.value = ""; timeInput.focus(); };
    // 0.76.8: the leading icon IS the picker button. The native
    // ::-webkit-calendar-picker-indicator (on the input's right) is
    // hidden via CSS; clicking our left icon opens the OS picker via
    // showPicker(). Wrapped in try — showPicker throws outside a user
    // gesture or on platforms that lack it (the input is still
    // directly editable / clickable as a fallback).
    dateIcon.onclick = () => { try { (dateInput as any).showPicker?.(); } catch { /* noop */ } };
    // 0.76.23: the clock opens Stashpad's numpad time picker (the same
    // control as the search When-builder) instead of the OS time
    // picker — consistent UX + works the same everywhere. The time
    // input stays directly editable too.
    timeIcon.onclick = () => this.openTimeNumpad(timeIcon, timeInput);
    if (initial) {
      dateInput.value = this.toDateValue(initial);
      timeInput.value = this.toTimeValue(initial);
    }

    // 0.125.1: quick relative adjust row — a +/- flip toggle plus one button per
    // configured preset. Clicking nudges the entered date+time by ±amount; if no
    // date/time is entered yet, it bases off "now" so a single tap schedules
    // e.g. "+1h from now". Reschedule-friendly for Snooze.
    const adjusts = (this.opts.quickAdjusts ?? DEFAULT_QUICK_ADJUSTS)
      .map((s) => ({ raw: s, min: parseAdjustMinutes(s) }))
      .filter((a): a is { raw: string; min: number } => a.min != null);
    if (adjusts.length > 0) {
      let sign = 1; // +1 add, -1 subtract
      const row = wrap.createDiv({ cls: "stashpad-due-quickadjust" });
      const flip = row.createEl("button", { cls: "stashpad-due-adjust-flip", attr: { type: "button" } });
      const syncFlip = (): void => {
        flip.setText(sign > 0 ? "+" : "−");
        flip.toggleClass("is-minus", sign < 0);
        flip.title = sign > 0 ? "Adding time (click to subtract)" : "Subtracting time (click to add)";
      };
      syncFlip();
      flip.onclick = () => { sign = -sign; syncFlip(); };
      const adjustBy = (deltaMin: number): void => {
        // Base: entered date+time, else today/now filled in for the missing part.
        const now = new Date();
        let y: number, mo: number, d: number;
        if (dateInput.value) { const [yy, mm, dd] = dateInput.value.split("-").map((n) => parseInt(n, 10)); y = yy; mo = mm - 1; d = dd; }
        else { y = now.getFullYear(); mo = now.getMonth(); d = now.getDate(); }
        let hh: number, mi: number;
        if (timeInput.value) { const [h, m] = timeInput.value.split(":").map((n) => parseInt(n, 10)); hh = h; mi = m; }
        else { hh = now.getHours(); mi = now.getMinutes(); }
        const base = new Date(y, mo, d, hh, mi, 0, 0);
        base.setMinutes(base.getMinutes() + sign * deltaMin);
        dateInput.value = this.toDateValue(base);
        timeInput.value = this.toTimeValue(base);
      };
      for (const a of adjusts) {
        const b = row.createEl("button", { cls: "stashpad-due-adjust-btn", text: a.raw, attr: { type: "button" } });
        b.onclick = () => adjustBy(a.min);
      }
    }

    // 0.78.1: "Assign to" section — chips for current assignees + an
    // autocomplete input to add known authors (Sift) or a free-entry name
    // (mints a new author id). Multiple assignees supported.
    // 0.125.0: Snooze passes hideAssignees — it only reschedules, so omit it.
    if (!this.opts.hideAssignees) this.renderAssignSection(wrap);

    // 0.76.5: presets (top row) + actions (bottom row) share ONE
    // 3-column grid so the six buttons line up in two tidy rows.
    const grid = wrap.createDiv({ cls: "stashpad-due-grid" });
    const addPreset = (label: string, build: () => Date) => {
      const b = grid.createEl("button", { cls: "stashpad-due-btn stashpad-due-preset", text: label });
      b.onclick = () => {
        const d = build();
        dateInput.value = this.toDateValue(d);
        if (!timeInput.value) timeInput.value = this.toTimeValue(d);
      };
    };
    const atNine = (d: Date): Date => { d.setHours(9, 0, 0, 0); return d; };
    addPreset("Today", () => atNine(this.startOfTodayLocal()));
    addPreset("Tomorrow", () => { const d = this.startOfTodayLocal(); d.setDate(d.getDate() + 1); return atNine(d); });
    addPreset("Next week", () => { const d = this.startOfTodayLocal(); d.setDate(d.getDate() + 7); return atNine(d); });

    // 0.76.22: "Clear" only empties the fields and stays open — so you
    // can clear a misapplied date and pick a new one without
    // re-opening. To actually REMOVE the due, clear then Set (empty
    // Set commits null). To keep the existing due, Cancel.
    const clear = grid.createEl("button", { cls: "stashpad-due-btn", text: "Clear" });
    clear.onclick = () => {
      dateInput.value = "";
      timeInput.value = "";
      dateInput.focus();
    };
    // 0.140.0: optional "Repeat & reminders" section (collapsible). Three
    // free-text fields; recurrence uses natural language ("every weekday",
    // "every 30 days when done"). Only shown/returned when opts.showRecurrence.
    let repeatIn: HTMLInputElement | null = null;
    let autoIn: HTMLInputElement | null = null;
    let remindIn: HTMLInputElement | null = null;
    let modeSel: HTMLSelectElement | null = null;
    if (this.opts.showRecurrence) {
      const det = wrap.createEl("details", { cls: "stashpad-due-recur" });
      if (this.opts.currentRepeat || this.opts.currentAutoDoneAfter || this.opts.currentRemindEvery) det.open = true;
      det.createEl("summary", { text: "🔁 Repeat & reminders (experimental)" });
      // 0.210.4: label recurrence EXPERIMENTAL in the place someone is actually
      // about to depend on it. Repeat rules work, but they are not thoroughly
      // tested across time zones, missed occurrences and multi-device sync, and a
      // missed reminder for something that mattered is exactly the failure a user
      // would (reasonably) blame the plugin for. Say so before they rely on it.
      det.createEl("div", { cls: "stashpad-due-recur-warning" }).setText(
        "Recurring tasks are experimental — not thoroughly tested across time zones, "
        + "missed occurrences, or syncing between devices. Please don't rely on a "
        + "repeat for anything with real consequences; keep a reminder you trust for "
        + "deadlines that matter. A one-off due date and reminder is the well-tested path.",
      );
      const mkRow = (label: string, ph: string, val?: string): HTMLInputElement => {
        const r = det.createDiv({ cls: "stashpad-due-recur-row" });
        r.createEl("label", { text: label });
        const inp = r.createEl("input", { type: "text", attr: { placeholder: ph } });
        if (val) inp.value = val;
        return inp;
      };
      repeatIn = mkRow("Repeat", 'e.g. "every weekday", "every 30 days when done"', this.opts.currentRepeat);
      autoIn = mkRow("Auto-complete after", 'e.g. "1d" — mark done once this overdue', this.opts.currentAutoDoneAfter);
      remindIn = mkRow("Remind every", 'e.g. "2h" — re-notify until done', this.opts.currentRemindEvery);

      // 0.203.0: pick the DAYS a weekly repeat lands on. Created here so it sits
      // directly under the Repeat field; wired further down (needs paintAnchor).
      const wrow = det.createDiv({ cls: "stashpad-due-recur-row" });
      wrow.createEl("label", { text: "On these days" });
      const chipWrap = wrow.createDiv({ cls: "stashpad-weekday-chips" });
      const daysHelp = det.createDiv({ cls: "stashpad-due-recur-help" });

      // 0.204.0: days of the MONTH — the "verify my hours on the 1st and the
      // 15th" case, one task instead of two.
      const mdrow = det.createDiv({ cls: "stashpad-due-recur-row" });
      mdrow.createEl("label", { text: "Days of the month" });
      const mdWrap = mdrow.createDiv({ cls: "stashpad-monthday-chips" });
      const mdHelp = det.createDiv({ cls: "stashpad-due-recur-help" });

      // 0.198.0: the anchor was only reachable by typing "when done" on the end of
      // the rule. Same setting, now a visible toggle — it's the difference between
      // "every Monday" and "30 days after I actually did it", and it's the control
      // you want when rescheduling something you've let slip.
      const ANCHOR_RE = /\s*(when done|after completion)\s*$/i;
      const arow = det.createDiv({ cls: "stashpad-due-recur-row" });
      arow.createEl("label", { text: "Count next from" });
      const seg = arow.createDiv({ cls: "stashpad-anchor-seg" });
      const bDue = seg.createEl("button", { text: "Due date", attr: { type: "button" } });
      const bDone = seg.createEl("button", { text: "Completion", attr: { type: "button" } });
      const anchorHelp = det.createDiv({ cls: "stashpad-due-recur-help" });
      const isDone = (): boolean => ANCHOR_RE.test(repeatIn!.value);
      const paintAnchor = (): void => {
        const done = isDone();
        bDue.toggleClass("is-active", !done);
        bDone.toggleClass("is-active", done);
        anchorHelp.setText(done
          ? "Next occurrence counts from when you COMPLETE it — miss a few and the schedule shifts with you."
          : "Next occurrence counts from the DUE date — the task keeps its original cadence no matter when you finish.");
      };
      bDue.onclick = () => { repeatIn!.value = repeatIn!.value.replace(ANCHOR_RE, "").trimEnd(); paintAnchor(); };
      bDone.onclick = () => { if (!isDone()) repeatIn!.value = `${repeatIn!.value.trim()} when done`.trim(); paintAnchor(); };
      // Day chips. Same contract as the anchor toggle: the rule STRING is the
      // source of truth, so typing "every mon, fri" lights the chips and the
      // chips rewrite the rule. Clicking a day on a non-weekday rule (e.g.
      // "every 3 days") converts it to a weekly one, which is what picking
      // days means; clearing every chip clears the rule.
      const chipEls: HTMLElement[] = [];
      const paintDays = (): void => {
        const on = new Set(parseWeekdayList(repeatIn!.value.replace(/\s*(when done|after completion)\s*$/i, "")) ?? []);
        chipEls.forEach((el, i) => el.toggleClass("is-active", on.has(i)));
        daysHelp.setText(on.size
          ? `Repeats on ${[...on].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]).join(", ")} — whichever comes next.`
          : "Optional. Pick the days a weekly task lands on (e.g. Mon/Wed/Fri); leave blank to use the rule above.");
      };
      for (let i = 0; i < 7; i++) {
        const b = chipWrap.createEl("button", {
          text: WEEKDAY_INITIAL[i],
          attr: { type: "button", "aria-label": WEEKDAY_SHORT[i], title: WEEKDAY_SHORT[i] },
        });
        b.onclick = () => {
          const cur = new Set(parseWeekdayList(repeatIn!.value.replace(/\s*(when done|after completion)\s*$/i, "")) ?? []);
          if (cur.has(i)) cur.delete(i); else cur.add(i);
          repeatIn!.value = withWeekdays(repeatIn!.value, [...cur]);
          repaint();
        };
        chipEls.push(b);
      }

      // Month-day chips: 1–31 plus "Last". Same rule-string-is-truth contract.
      // Because withMonthDays/withWeekdays each rewrite the whole rule body,
      // picking month days clears any weekday selection and vice versa — the
      // two are different kinds of schedule, not combinable.
      const mdEls: HTMLElement[] = [];
      const mdValues = [...Array.from({ length: 31 }, (_, i) => i + 1), -1];
      const strip = (v: string): string => v.replace(/\s*(when done|after completion)\s*$/i, "");
      const paintMonthDays = (): void => {
        const on = new Set(parseMonthDayList(strip(repeatIn!.value)) ?? []);
        mdEls.forEach((el, i) => el.toggleClass("is-active", on.has(mdValues[i])));
        mdHelp.setText(on.size
          ? `Repeats on the ${[...on].sort((a, b) => (a === -1 ? 99 : a) - (b === -1 ? 99 : b)).map(monthDayLabel).join(", ")} of each month.`
          : "Optional. Pick dates in the month (e.g. 1st + 15th for a twice-monthly task). A date a month doesn't have is skipped that month.");
      };
      for (const val of mdValues) {
        const b = mdWrap.createEl("button", {
          text: val === -1 ? "Last" : String(val),
          attr: { type: "button", "aria-label": val === -1 ? "Last day of the month" : monthDayLabel(val), title: val === -1 ? "Last day of the month" : monthDayLabel(val) },
        });
        if (val === -1) b.addClass("is-last");
        b.onclick = () => {
          const cur = new Set(parseMonthDayList(strip(repeatIn!.value)) ?? []);
          if (cur.has(val)) cur.delete(val); else cur.add(val);
          repeatIn!.value = withMonthDays(repeatIn!.value, [...cur]);
          repaint();
        };
        mdEls.push(b);
      }

      const repaint = (): void => { paintAnchor(); paintDays(); paintMonthDays(); };
      repeatIn.addEventListener("input", repaint);
      repaint();

      // 0.197.0: what "repeat" actually DOES. Roll-forward (the historic behaviour)
      // repeats but keeps no record; the other modes leave per-occurrence history.
      const mrow = det.createDiv({ cls: "stashpad-due-recur-row" });
      mrow.createEl("label", { text: "When repeating" });
      modeSel = mrow.createEl("select");
      for (const m of REPEAT_MODES) modeSel.createEl("option", { value: m.id, text: m.label });
      modeSel.value = parseRepeatMode(this.opts.currentRepeatMode);
      const modeHelp = det.createDiv({ cls: "stashpad-due-recur-help" });
      const paintHelp = () => {
        modeHelp.setText(REPEAT_MODES.find((m) => m.id === modeSel!.value)?.desc ?? "");
      };
      modeSel.onchange = paintHelp;
      paintHelp();
    }
    const recur = (): Pick<DuePickResult, "repeat" | "autoDoneAfter" | "remindEvery" | "repeatMode"> =>
      this.opts.showRecurrence
        ? { repeat: repeatIn!.value.trim(), autoDoneAfter: autoIn!.value.trim(), remindEvery: remindIn!.value.trim(), repeatMode: modeSel?.value ?? "" }
        : {};

    const cancel = grid.createEl("button", { cls: "stashpad-due-btn", text: "Cancel" });
    cancel.onclick = () => { this.didChoose = true; this.close(); };
    const ok = grid.createEl("button", { cls: "stashpad-due-btn mod-cta", text: "Set" });
    ok.onclick = () => {
      // Empty Set = remove the due date (assignees still committed, so you
      // can assign someone without a due date).
      if (!dateInput.value) {
        this.didChoose = true;
        this.close();
        this.onPick({ iso: null, assignees: this.assignees, ...recur() });
        return;
      }
      // Default time to 09:00 when only a date was chosen.
      const [y, m, d] = dateInput.value.split("-").map((n) => parseInt(n, 10));
      let hh = 9, mm = 0;
      if (timeInput.value) { const [h, mi] = timeInput.value.split(":").map((n) => parseInt(n, 10)); hh = h; mm = mi; }
      const due = new Date(y, m - 1, d, hh, mm, 0, 0);
      this.didChoose = true;
      this.close();
      this.onPick({ iso: due.toISOString(), assignees: this.assignees, ...recur() });
    };
    requestAnimationFrame(() => dateInput.focus());
  }

  onClose(): void {
    this.tinyClosePopover?.();
    this.contentEl.empty();
    void this.didChoose;
  }

  /** 0.78.1: the "Assign to" block. Delegates to the shared
   *  buildAssigneePicker so the standalone AssignModal reuses it. */
  private renderAssignSection(wrap: HTMLElement): void {
    buildAssigneePicker(wrap, {
      knownAuthors: this.opts.knownAuthors ?? [],
      initial: this.assignees,
      onChange: (list) => { this.assignees = list; },
    });
  }

  /** 0.76.23: open the shared numpad time picker anchored under the
   *  clock icon, writing the result back to the native time input as
   *  24-hour HH:MM. Plain-DOM popover host (the modal isn't a
   *  SuggestModal, so no Obsidian Scope) with click-outside + Escape +
   *  Enter handling. */
  private tinyClosePopover: (() => void) | null = null;
  private openTimeNumpad(anchor: HTMLElement, timeInput: HTMLInputElement): void {
    this.tinyClosePopover?.();
    // 0.122.3 (#4): build the popover + bind its listeners in the ANCHOR's
    // document so it lands in the same (possibly popout) window as the modal —
    // not always the main window.
    const doc = anchor.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    // Seed from the current time value, else the current clock time.
    let h24 = 9, mm = 0;
    if (timeInput.value) {
      const [h, mi] = timeInput.value.split(":").map((n) => parseInt(n, 10));
      if (Number.isFinite(h)) h24 = h;
      if (Number.isFinite(mi)) mm = mi;
    } else {
      const now = new Date();
      h24 = now.getHours();
      mm = now.getMinutes();
    }
    const period: "am" | "pm" = h24 >= 12 ? "pm" : "am";
    const seedH = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);

    // 0.122.10: host the popover INSIDE the modal element, not doc.body. When
    // it lived in body (outside the modal's focusable subtree) the modal's
    // focus management pulled focus back to the first field (the date input)
    // the instant the time picker focused its hour field — so clicking the
    // clock landed you in the date box. Keeping it inside modalEl mirrors the
    // search When-builder (whose picker is hosted in its own focusable region)
    // and lets the hour field keep focus. position:fixed still anchors to the
    // viewport. Falls back to doc.body if modalEl is somehow unavailable.
    const host = (this.modalEl as HTMLElement | undefined) ?? doc.body;
    const pop = host.createDiv({ cls: "stashpad-when-popover stashpad-due-time-pop" });
    // Above the modal (Obsidian modals sit ~var(--layer-modal)).
    pop.setCssStyles({ position: "fixed", zIndex: "9999" });

    let onEnter: (() => void) | null = null;
    const close = (): void => {
      pop.remove();
      doc.removeEventListener("mousedown", outside, true);
      doc.removeEventListener("keydown", onKey, true);
      if (this.tinyClosePopover === close) this.tinyClosePopover = null;
    };
    const outside = (e: MouseEvent): void => {
      if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter" && onEnter) { e.preventDefault(); e.stopPropagation(); onEnter(); }
    };
    this.tinyClosePopover = close;

    buildTimePickerInto(pop, {
      seedH, seedM: mm, seedPeriod: period,
      close,
      setOnEnter: (cb) => { onEnter = cb; },
      onFinalize: (r) => {
        timeInput.value = `${String(r.hours24).padStart(2, "0")}:${String(r.minutes).padStart(2, "0")}`;
      },
    });

    const rect = anchor.getBoundingClientRect();
    pop.setCssStyles({
      left: `${Math.max(8, Math.min(rect.left, win.innerWidth - 220))}px`,
      top: `${rect.bottom + 4}px`,
    });
    setTimeout(() => {
      doc.addEventListener("mousedown", outside, true);
      doc.addEventListener("keydown", onKey, true);
      // 0.122.10: re-assert focus on the hour field after the modal's own
      // focus handling has settled, so the picker opens ready for numeric entry.
      pop.querySelector<HTMLInputElement>(".stashpad-when-time-field")?.focus();
    }, 0);
  }

  private startOfTodayLocal(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  private toDateValue(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  private toTimeValue(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${mi}`;
  }
}

/** Browses the in-memory ring of NotificationRecords held by the
 *  plugin's NotificationService. Live-updates via service.onChange so
 *  new notifications appear without re-opening the modal. Mirrors
 *  LogModal's toolbar + filter + paginated list shape so the two
 *  feel cohesive. */
export class NotificationHistoryModal extends Modal {
  private records: NotificationRecord[] = [];
  private visible: NotificationRecord[] = [];
  private shownCount = 0;
  private categoryFilter: NotificationCategory | null = null;
  private listEl: HTMLDivElement | null = null;
  private footerEl: HTMLDivElement | null = null;
  private countEl: HTMLSpanElement | null = null;
  private filterSelEl: HTMLSelectElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private static PAGE = 100;

  /** Author filter dimension orthogonal to the category filter:
   *    - "all": no filter on author.
   *    - "me": records whose authorId === currentAuthorId.
   *    - "cross": records where the actor's authorId differs from at
   *      least one affected note's author (covers "someone else
   *      touched my notes" AND "I touched someone else's notes").
   *    - "<id>": records authored by the given authorId. */
  private authorFilter: "all" | "me" | "cross" | string = "all";
  private authorSelEl: HTMLSelectElement | null = null;

  constructor(
    app: App,
    private service: NotificationService,
    private openLog?: (folder: string | undefined) => void,
    /** Local user's authorId. Used by the "Me" filter; if null, the
     *  "Me" option is hidden. */
    private currentAuthorId: string | null = null,
    /** Resolver: given a Stashpad id, returns all author + contributor
     *  ids for that note (read from frontmatter.author +
     *  frontmatter.contributors by the caller). Used by the
     *  "Cross-author" filter. Note that for DESTROYED notes the
     *  resolver can't help (the note's gone from the metadata cache)
     *  — those records pre-stamp `affectedAuthorIds` at the time of
     *  the action instead. */
    private getNoteAuthorIds?: (id: string) => string[],
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Stashpad notification history");
    this.modalEl.addClass("stashpad-log-modal"); // Reuse the existing log-modal sizing.
    this.modalEl.addClass("stashpad-notif-history-modal");

    this.records = this.service.recent();

    const toolbar = this.contentEl.createDiv({ cls: "stashpad-log-toolbar" });
    this.countEl = toolbar.createSpan({ cls: "stashpad-log-count" });
    this.updateCount();

    this.filterSelEl = toolbar.createEl("select", { cls: "stashpad-log-type-filter" });
    this.filterSelEl.onchange = () => this.setCategoryFilter((this.filterSelEl!.value || null) as NotificationCategory | null);
    this.refreshCategoryFilter();

    // Author filter dropdown — only renders when there's at least one
    // authored record. Multiplayer filter: All / Me / Cross-author /
    // per-author entries.
    this.authorSelEl = toolbar.createEl("select", { cls: "stashpad-log-type-filter stashpad-notif-author-filter" });
    this.authorSelEl.onchange = () => this.setAuthorFilter(this.authorSelEl!.value || "all");
    this.refreshAuthorFilter();

    if (this.openLog) {
      const logBtn = toolbar.createEl("button", { text: "Open log" });
      logBtn.title = "Open the per-folder Stashpad log for the most recent notification's folder.";
      logBtn.onclick = () => {
        const mostRecentWithFolder = this.records.find((r) => !!r.folder);
        this.openLog?.(mostRecentWithFolder?.folder);
      };
    }

    const clearBtn = toolbar.createEl("button", { cls: "mod-warning", text: "Clear history" });
    clearBtn.onclick = () => {
      // Confirm before wiping — same pattern as LogModal's "Clear log"
      // button. ConfirmModal treats click-off-the-overlay as Cancel.
      new ConfirmModal(
        this.app,
        "Clear notification history?",
        `This will permanently remove all ${this.records.length} stored notifications from the history. The current toasts on screen are unaffected. This can't be undone.`,
        "Clear history",
        (ok) => {
          if (!ok) return;
          this.service.clearHistory();
          // service.clearHistory emits — our subscriber refreshes.
        },
        "Cancel",
        /*dangerous*/ true,
      ).open();
    };

    this.listEl = this.contentEl.createDiv({ cls: "stashpad-log-list" });
    this.refreshList();
    this.footerEl = this.contentEl.createDiv({ cls: "stashpad-log-footer" });
    this.renderFooter();

    // Live-update: re-pull records on every service change.
    this.unsubscribe = this.service.onChange(() => {
      this.records = this.service.recent();
      this.refreshCategoryFilter();
      this.refreshAuthorFilter();
      this.refreshList();
      this.renderFooter();
    });
  }

  private setAuthorFilter(value: string): void {
    if (this.authorFilter === value) return;
    this.authorFilter = value;
    this.refreshList();
    this.renderFooter();
  }

  /** Build the author <select> options from distinct authorIds in the
   *  history, plus the synthetic "All / Me / Cross-author" entries. */
  private refreshAuthorFilter(): void {
    if (!this.authorSelEl) return;
    const sel = this.authorSelEl;
    sel.empty();
    sel.createEl("option", { text: "All authors" }).value = "all";
    if (this.currentAuthorId) {
      sel.createEl("option", { text: "Me" }).value = "me";
    }
    // "Cross-author" is always available — even without the resolver,
    // pre-stamped affectedAuthorIds may suffice for destructive ops.
    sel.createEl("option", { text: "Cross-author" }).value = "cross";
    // Distinct authors present in the recorded set, excluding the
    // local user (already covered by "Me"). Limited to authors who
    // actually appear in history so the list stays meaningful.
    const distinct = new Set<string>();
    for (const r of this.records) {
      if (r.authorId && r.authorId !== this.currentAuthorId) distinct.add(r.authorId);
    }
    if (distinct.size > 0) {
      const sep = sel.createEl("option", { text: "──────────" });
      sep.disabled = true;
      for (const id of [...distinct].sort()) {
        sel.createEl("option", { text: id }).value = id;
      }
    }
    // If the active filter is no longer applicable, drop it.
    const valid = new Set(["all", "cross", ...(this.currentAuthorId ? ["me"] : []), ...distinct]);
    if (!valid.has(this.authorFilter)) this.authorFilter = "all";
    sel.value = this.authorFilter;
  }

  /** Returns true when `record` is involved in cross-author activity:
   *  any author / contributor of an affected note differs from the
   *  actor (record.authorId). Either direction qualifies — "someone
   *  else touched my notes" OR "I touched someone else's notes" or
   *  "I touched a note that has other contributors".
   *
   *  Two sources are consulted, in priority order:
   *    1. Pre-stamped `affectedAuthorIds` on the record — the only
   *       way to detect cross-author DELETES (the deleted note is no
   *       longer in the metadata cache).
   *    2. The `getNoteAuthorIds` resolver — queries live frontmatter
   *       at filter time. Covers all non-destructive actions.
   */
  private isCrossAuthor(record: NotificationRecord): boolean {
    const actor = record.authorId ?? null;
    if (!actor) return false;
    for (const id of record.affectedAuthorIds ?? []) {
      if (id && id !== actor) return true;
    }
    if (!this.getNoteAuthorIds) return false;
    for (const noteId of record.affectedIds) {
      const ids = this.getNoteAuthorIds(noteId);
      for (const id of ids) {
        if (id && id !== actor) return true;
      }
    }
    return false;
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private setCategoryFilter(cat: NotificationCategory | null): void {
    if ((this.categoryFilter ?? null) === (cat ?? null)) return;
    this.categoryFilter = cat;
    this.refreshList();
    this.renderFooter();
  }

  private refreshCategoryFilter(): void {
    if (!this.filterSelEl) return;
    const sel = this.filterSelEl;
    sel.empty();
    const counts = new Map<NotificationCategory, number>();
    for (const r of this.records) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const all = sel.createEl("option", { text: `All categories (${this.records.length})` });
    all.value = "";
    for (const [cat, n] of entries) {
      const opt = sel.createEl("option", { text: `${cat} (${n})` });
      opt.value = cat;
    }
    if (this.categoryFilter && !counts.has(this.categoryFilter)) this.categoryFilter = null;
    sel.value = this.categoryFilter ?? "";
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.visible = this.records.filter((r) => {
      if (this.categoryFilter && r.category !== this.categoryFilter) return false;
      switch (this.authorFilter) {
        case "all": return true;
        case "me": return !!this.currentAuthorId && r.authorId === this.currentAuthorId;
        case "cross": return this.isCrossAuthor(r);
        default: return r.authorId === this.authorFilter;
      }
    });
    this.shownCount = 0;
    this.listEl.empty();
    if (!this.visible.length) {
      this.listEl.createDiv({
        cls: "stashpad-log-empty",
        text: this.categoryFilter ? `No "${this.categoryFilter}" notifications.` : "No notifications yet.",
      });
      this.updateCount();
      return;
    }
    this.appendMore(NotificationHistoryModal.PAGE);
  }

  private appendMore(n: number): void {
    if (!this.listEl) return;
    const stop = Math.min(this.visible.length, this.shownCount + n);
    for (let i = this.shownCount; i < stop; i++) this.renderRow(this.listEl, this.visible[i]);
    this.shownCount = stop;
    this.updateCount();
  }

  private renderRow(parent: HTMLElement, r: NotificationRecord): void {
    const row = parent.createDiv({ cls: `stashpad-notif-row stashpad-notif-row-${r.kind}` });
    const meta = row.createDiv({ cls: "stashpad-notif-meta" });
    const time = meta.createSpan({ cls: "stashpad-notif-time" });
    const m = momentFn(r.ts);
    time.setText(m.fromNow());
    time.title = m.format("YYYY-MM-DD HH:mm:ss");
    const cat = meta.createSpan({ cls: `stashpad-notif-cat stashpad-notif-cat-${r.category}` });
    cat.setText(r.category);
    const msg = row.createDiv({ cls: "stashpad-notif-msg" });
    msg.setText(r.message);
    if (r.actionLabels.length > 0) {
      const acts = row.createDiv({ cls: "stashpad-notif-actions-snapshot" });
      for (const label of r.actionLabels) {
        const chip = acts.createSpan({ cls: "stashpad-notif-action-chip" });
        chip.setText(label);
        chip.title = "Action button was shown on the original toast (handler not retained).";
      }
    }
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const total = this.visible.length;
    const label = this.categoryFilter
      ? `${total} ${this.categoryFilter} notification${total === 1 ? "" : "s"}`
      : `${total} notification${total === 1 ? "" : "s"}`;
    if (this.shownCount === 0 || this.shownCount >= total) {
      this.countEl.setText(label);
    } else {
      this.countEl.setText(`Showing ${this.shownCount} of ${label}`);
    }
  }

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.empty();
    const remaining = this.visible.length - this.shownCount;
    if (remaining <= 0) return;
    const moreBtn = this.footerEl.createEl("button", { text: `Load ${Math.min(NotificationHistoryModal.PAGE, remaining)} more` });
    moreBtn.onclick = () => { this.appendMore(NotificationHistoryModal.PAGE); this.renderFooter(); };
    if (remaining > NotificationHistoryModal.PAGE) {
      const allBtn = this.footerEl.createEl("button", { text: `Load all (${remaining})` });
      allBtn.onclick = () => { this.appendMore(remaining); this.renderFooter(); };
    }
  }
}

/** 0.79.3: read-only viewer for the import log. Lists imports newest-first
 *  so the user can see / reference what they've imported. */
export class ImportLogModal extends Modal {
  constructor(app: App, private entries: ImportLogEntry[]) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Stashpad import log");
    if (this.entries.length === 0) {
      this.contentEl.createDiv({ cls: "stashpad-log-empty", text: "Nothing imported yet." });
      return;
    }
    const list = this.contentEl.createDiv({ cls: "stashpad-import-log-list" });
    for (const e of this.entries) {
      const row = list.createDiv({ cls: "stashpad-import-log-row" });
      const when = (moment as any)(e.ts).format("YYYY-MM-DD HH:mm");
      row.createSpan({ cls: "stashpad-import-log-when", text: when });
      const kindLabel = e.kind === "folder" ? "folder" : e.kind === "md" ? "note" : "file";
      row.createSpan({ cls: `stashpad-import-log-kind is-${e.kind}`, text: kindLabel });
      row.createSpan({ cls: "stashpad-import-log-name", text: e.originalName });
      const meta: string[] = [e.folder.split("/").pop() || e.folder];
      if (e.notePaths.length > 1) meta.push(`${e.notePaths.length} notes`);
      row.createSpan({ cls: "stashpad-import-log-meta", text: meta.join(" · ") });
    }
  }
  onClose(): void { this.contentEl.empty(); }
}

/** 0.79.7: three-way choice for a likely-duplicate import. Escape / close
 *  resolves to "skip" (the safe default for an accidental re-drop). */
export class ImportDupChoiceModal extends Modal {
  private chose = false;
  constructor(app: App, private message: string, private onChoose: (c: "anyway" | "replace" | "skip") => void) { super(app); }
  onOpen(): void {
    this.modalEl?.addClass("stashpad-compact-modal");
    this.contentEl.empty();
    this.titleEl.setText("Possible duplicate import");
    const block = this.contentEl.createDiv({ cls: "stashpad-confirm-body" });
    for (const line of this.message.split("\n")) block.createDiv({ cls: "stashpad-confirm-line", text: line });
    const row = this.contentEl.createDiv({ cls: "stashpad-modal-btns" });
    const skip = row.createEl("button", { text: "Skip duplicates" });
    skip.onclick = () => { this.chose = true; this.close(); this.onChoose("skip"); };
    const replace = row.createEl("button", { text: "Replace existing" });
    replace.onclick = () => { this.chose = true; this.close(); this.onChoose("replace"); };
    const anyway = row.createEl("button", { cls: "mod-cta", text: "Import anyway" });
    anyway.onclick = () => { this.chose = true; this.close(); this.onChoose("anyway"); };
  }
  onClose(): void { if (!this.chose) this.onChoose("skip"); this.contentEl.empty(); }
}

/** 0.138.0 (re-encrypt sweep): ONE review modal listing everything that should
 *  be encrypted but is plaintext — per-subtree rows, checkboxes pre-ticked.
 *  Confirm passes the CHECKED indices; nothing encrypts without it. */
export class ReEncryptReviewModal extends Modal {
  constructor(
    app: App,
    private items: Array<{ label: string; detail: string }>,
    private onConfirm: (chosenIndices: number[]) => void | Promise<void>,
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText("Re-encrypt everything applicable?");
    const { contentEl } = this;
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "These notes should be encrypted (they were unlocked/restored, or their folder is set to encrypt) but are currently plaintext. Untick anything you want to leave readable.",
    });
    const list = contentEl.createDiv({ cls: "stashpad-reenc-list" });
    const boxes: HTMLInputElement[] = [];
    this.items.forEach((it) => {
      const row = list.createEl("label", { cls: "stashpad-reenc-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = true;
      boxes.push(cb);
      const body = row.createDiv({ cls: "stashpad-reenc-body" });
      body.createDiv({ cls: "stashpad-reenc-label", text: it.label });
      body.createDiv({ cls: "stashpad-reenc-detail", text: it.detail });
    });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const go = btns.createEl("button", { cls: "mod-cta", text: `Re-encrypt checked` });
    go.onclick = () => {
      const chosen = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
      this.close();
      if (chosen.length) void this.onConfirm(chosen);
    };
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
  onClose(): void { this.contentEl.empty(); }
}

/** 0.199.3: a big, explicit dropzone. Opened from the composer's dropzone
 *  button: drag files onto the large dashed area (imports them like a drop on
 *  the composer), or click the area to open the OS file picker. The zone is
 *  deliberately huge — the whole point is not having to aim. */
export class DropzoneModal extends Modal {
  constructor(app: App, private onFiles: (files: File[]) => void) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText("Add files");
    this.modalEl.addClass("stashpad-dropzone-modal");

    const zone = this.contentEl.createDiv({ cls: "stashpad-dropzone" });
    setIcon(zone.createDiv({ cls: "stashpad-dropzone-icon" }), "file-input");
    zone.createDiv({ cls: "stashpad-dropzone-title", text: "Drop files here" });
    zone.createDiv({ cls: "stashpad-dropzone-sub", text: "…or click to browse. Files import as attachments and their links land in the composer." });

    const take = (files: File[]): void => {
      if (files.length === 0) return;
      this.close();
      this.onFiles(files);
    };

    zone.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = "copy"; } catch { /* ignore */ }
      zone.addClass("is-dropover");
    });
    zone.addEventListener("dragleave", () => zone.removeClass("is-dropover"));
    zone.addEventListener("drop", (e) => {
      zone.removeClass("is-dropover");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault(); e.stopPropagation();
      take(files);
    });
    zone.onclick = () => {
      // The modal's own document, so the picker works in pop-out windows too.
      const doc = this.contentEl.ownerDocument ?? document;
      const input = doc.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.setCssStyles({ display: "none" });
      input.onchange = () => {
        const picked = Array.from(input.files ?? []);
        input.remove();
        take(picked);
      };
      doc.body.appendChild(input);
      input.click();
    };
  }

  onClose(): void { this.contentEl.empty(); }
}

/** 0.219.6: a real view of duplicate note ids, replacing the wall-of-text
 *  notice that listed them inline.
 *
 *  Read-only on purpose (see docs/duplicate-ids-plan.md): it makes the
 *  INVISIBLE notes visible and lets the user open any of them, but changes
 *  nothing. Repair — re-minting the copies — comes next, once the report shows
 *  what the real cases look like.
 *
 *  Why this matters: TreeIndex keys notes by frontmatter `id`, so files sharing
 *  an id collapse into ONE row. Every file listed here that isn't the "shown"
 *  one is currently invisible in Stashpad while still existing on disk. */
export interface DuplicateIdGroup {
  id: string;
  files: { path: string; isShown: boolean }[];
}

export class DuplicateIdsModal extends Modal {
  constructor(app: App, private folder: string, private groups: DuplicateIdGroup[]) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("stashpad-dupes-modal");
    this.titleEl.setText(`Duplicate note ids in “${this.folder}”`);
    const c = this.contentEl;
    c.empty();

    const hiddenCount = this.groups.reduce((n, g) => n + g.files.filter((f) => !f.isShown).length, 0);
    c.createEl("p", {
      cls: "setting-item-description",
      text: `${this.groups.length} id${this.groups.length === 1 ? "" : "s"} ${this.groups.length === 1 ? "is" : "are"} used by more than one note. `
        + `Notes sharing an id collapse into a single row, so ${hiddenCount} note${hiddenCount === 1 ? " is" : "s are"} currently `
        + `hidden from the list even though the file still exists. Nothing here changes your notes.`,
    });
    c.createEl("p", {
      cls: "setting-item-description",
      text: "Most duplicates come from copies that kept their frontmatter — a re-import, a restored backup, or a sync conflict copy. "
        + "To un-hide one now, open it and give it a different id in its frontmatter. A repair command is planned.",
    });

    const list = c.createDiv({ cls: "stashpad-dupes-list" });
    for (const g of this.groups) {
      const box = list.createDiv({ cls: "stashpad-dupes-group" });
      const head = box.createDiv({ cls: "stashpad-dupes-group-head" });
      head.createEl("code", { text: g.id });
      head.createSpan({ cls: "stashpad-dupes-count", text: `${g.files.length} files` });
      for (const f of g.files) {
        const row = box.createEl("button", { cls: "stashpad-dupes-file" });
        if (f.isShown) row.addClass("is-shown");
        row.createSpan({
          cls: "stashpad-dupes-badge",
          text: f.isShown ? "shown" : "hidden",
        });
        row.createSpan({ cls: "stashpad-dupes-path", text: f.path });
        row.title = f.isShown
          ? "This is the note Stashpad currently shows for this id — click to open"
          : "Hidden from the list because another note has the same id — click to open";
        row.onclick = () => { this.app.workspace.openLinkText(f.path, "", true); };
      }
    }
  }
  onClose(): void { this.contentEl.empty(); }
}
