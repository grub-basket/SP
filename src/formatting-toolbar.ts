import { App, Menu } from "obsidian";
import { setIconSafe } from "./view-helpers";
import { type Snippet, expandSnippet } from "./snippets";

/** 0.336.0: the composer/edit-modal formatting toolbar, shared so every textarea
 *  surface gets the same buttons. Buttons wrap the selection (or insert at the
 *  caret) in the same Markdown markers MarkdownInput's autopair produces.
 *
 *  The textarea is resolved LAZILY via `getTa` — a host may render the bar before
 *  it creates its textarea (the composer does), and a click always acts on the
 *  live one. */

/** Wrap the textarea selection in `before`/`after` (symmetric by default). No
 *  selection → insert the pair and drop the caret between them (so `[[`/`#`
 *  autocomplete or plain typing continues inside). Fires `input`. */
export function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string = before): void {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  const val = ta.value;
  const sel = val.slice(s, e);
  ta.value = val.slice(0, s) + before + sel + after + val.slice(e);
  if (sel) ta.setSelectionRange(s + before.length, e + before.length);
  else { const c = s + before.length; ta.setSelectionRange(c, c); }
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

/** 0.338.0: insert a Markdown web hyperlink `[text](url)`. With a selection, that
 *  becomes the link TEXT and the caret lands in the `url`; with none, a `[](url)`
 *  is inserted with the caret in the text slot. */
export function insertWebLink(ta: HTMLTextAreaElement): void {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  const val = ta.value;
  const sel = val.slice(s, e);
  if (sel) {
    const inserted = `[${sel}](url)`;
    ta.value = val.slice(0, s) + inserted + val.slice(e);
    const urlStart = s + sel.length + 3; // after "[sel]("
    ta.setSelectionRange(urlStart, urlStart + 3); // select "url"
  } else {
    const inserted = `[](url)`;
    ta.value = val.slice(0, s) + inserted + val.slice(e);
    ta.setSelectionRange(s + 1, s + 1); // caret between the []
  }
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

/** 0.345.0: set the current line's Markdown heading level (1–6), or 0 to clear
 *  back to normal text. Idempotent-toggle: applying the level the line already
 *  has clears it. Strips any existing `#…` prefix first so switching levels
 *  replaces rather than stacks. Fires `input`. */
export function setHeadingLevel(ta: HTMLTextAreaElement, level: number): void {
  const val = ta.value;
  const s = ta.selectionStart ?? val.length;
  const lineStart = val.lastIndexOf("\n", s - 1) + 1;
  let lineEnd = val.indexOf("\n", lineStart);
  if (lineEnd === -1) lineEnd = val.length;
  const line = val.slice(lineStart, lineEnd);
  const m = line.match(/^(#{1,6})\s+/);
  const current = m ? m[1].length : 0;
  const bare = m ? line.slice(m[0].length) : line;
  const target = level === current ? 0 : level; // toggle off if unchanged
  const next = target > 0 ? "#".repeat(target) + " " + bare : bare;
  ta.value = val.slice(0, lineStart) + next + val.slice(lineEnd);
  const delta = next.length - line.length;
  const c = Math.max(lineStart, s + delta);
  ta.setSelectionRange(c, c);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

/** 0.351.0: insert a fenced ```code block``` around the selection (or drop an
 *  empty fence with the caret on the inner line). Ensures the opening fence
 *  starts on its own line. Fires `input`. */
export function insertCodeBlock(ta: HTMLTextAreaElement): void {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  const val = ta.value;
  const sel = val.slice(s, e);
  const atLineStart = s === 0 || val[s - 1] === "\n";
  const before = (atLineStart ? "" : "\n") + "```\n";
  const after = "\n```";
  ta.value = val.slice(0, s) + before + sel + after + val.slice(e);
  if (sel) ta.setSelectionRange(s + before.length, s + before.length + sel.length);
  else { const c = s + before.length; ta.setSelectionRange(c, c); }
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

/** Toggle a line prefix (e.g. `- [ ] `) on the textarea's current line. */
export function prefixLine(ta: HTMLTextAreaElement, prefix: string): void {
  const val = ta.value;
  const s = ta.selectionStart ?? val.length;
  const lineStart = val.lastIndexOf("\n", s - 1) + 1;
  const rest = val.slice(lineStart);
  if (rest.startsWith(prefix)) {
    ta.value = val.slice(0, lineStart) + rest.slice(prefix.length);
    const c = Math.max(lineStart, s - prefix.length);
    ta.setSelectionRange(c, c);
  } else {
    ta.value = val.slice(0, lineStart) + prefix + rest;
    ta.setSelectionRange(s + prefix.length, s + prefix.length);
  }
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

/** A detected formatted span in a note's text — the unit the inspector acts on. */
export interface FormatSpan {
  type: string;
  label: string;
  icon: string;
  open: string;
  close: string;
  outerStart: number;
  outerEnd: number;
  inner: string;
}

/** The format vocabulary the inspector understands. `re` captures the inner text
 *  in group 1. Order matters: bold before italic so `**x**` reads as bold. */
export const FORMAT_KINDS: { type: string; label: string; icon: string; open: string; close: string; re: RegExp }[] = [
  { type: "bold", label: "Bold", icon: "bold", open: "**", close: "**", re: /\*\*([^*\n]+?)\*\*/g },
  { type: "italic", label: "Italic", icon: "italic", open: "*", close: "*", re: /(?<!\*)\*([^*\n]+?)\*(?!\*)/g },
  { type: "highlight", label: "Highlight", icon: "highlighter", open: "==", close: "==", re: /==([^=\n]+?)==/g },
  { type: "spoiler", label: "Spoiler", icon: "eye-off", open: "||", close: "||", re: /\|\|([^|\n]+?)\|\|/g },
  { type: "strikethrough", label: "Strikethrough", icon: "strikethrough", open: "~~", close: "~~", re: /~~([^~\n]+?)~~/g },
  { type: "code", label: "Code", icon: "code", open: "`", close: "`", re: /`([^`\n]+?)`/g },
  { type: "link", label: "Link", icon: "link", open: "[[", close: "]]", re: /\[\[([^\]\n]+?)\]\]/g },
];

/** Find the top-level formatted spans in `text` (non-overlapping, earliest wins;
 *  nested formatting is reported as its outer span). Lets the inspector list
 *  "formatting content you can modify" without the user hunting/selecting it. */
export function parseFormatSpans(text: string): FormatSpan[] {
  const found: FormatSpan[] = [];
  for (const k of FORMAT_KINDS) {
    k.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = k.re.exec(text))) {
      found.push({ type: k.type, label: k.label, icon: k.icon, open: k.open, close: k.close, outerStart: m.index, outerEnd: m.index + m[0].length, inner: m[1] });
    }
  }
  found.sort((a, b) => a.outerStart - b.outerStart || (b.outerEnd - b.outerStart) - (a.outerEnd - a.outerStart));
  const out: FormatSpan[] = [];
  let lastEnd = -1;
  for (const s of found) {
    if (s.outerStart >= lastEnd) { out.push(s); lastEnd = s.outerEnd; }
  }
  return out;
}

/** 0.351.0: per-button toolbar customization. `order` is implicit in the array
 *  order; `hidden` opts a built-in out; `icon` overrides its Lucide icon. Any
 *  built-in id NOT present here keeps its default slot (appended in default
 *  order after the configured ones), so a future new button still appears for a
 *  user who customized the bar earlier. Empty array = full default toolbar. */
export interface ToolbarButtonConfig {
  id: string;
  hidden?: boolean;
  icon?: string;
}

/** 0.351.0: a built-in formatting-toolbar button. `id` is the stable, persisted
 *  key referenced by ToolbarButtonConfig. `gate` marks a button that only shows
 *  when the matching opts flag is set (spoiler ← opts.spoilers). Ordinary
 *  buttons carry a `run`; the heading button carries a `menu` builder. */
export interface ToolbarBuiltin {
  id: string;
  icon: string;
  glyph: string;
  title: string;
  cls?: string;
  gate?: "spoilers" | "drafts";
  run?: (ta: HTMLTextAreaElement) => void;
  menu?: (e: MouseEvent, getTa: () => HTMLTextAreaElement | null) => void;
}

function openHeadingMenu(e: MouseEvent, getTa: () => HTMLTextAreaElement | null): void {
  const menu = new Menu();
  // Reverse order (H6 → H1): the smaller, more-used levels sit nearest the
  // button, so H1/H2 are the shortest reach from where the menu opens.
  for (let lvl = 6; lvl >= 1; lvl--) {
    menu.addItem((it) => it.setTitle(`Heading ${lvl}`).setIcon(`heading-${lvl}`).onClick(() => { const ta = getTa(); if (ta) setHeadingLevel(ta, lvl); }));
  }
  menu.addSeparator();
  menu.addItem((it) => it.setTitle("Normal text").setIcon("pilcrow").onClick(() => { const ta = getTa(); if (ta) setHeadingLevel(ta, 0); }));
  menu.showAtMouseEvent(e);
}

/** 0.351.0: the built-in toolbar buttons in their DEFAULT order. This array is
 *  the single source of truth for both the renderer and the settings UI:
 *  tag → internal link → web link → heading → bold → italic → highlight →
 *  code block → inline code → checkbox → spoiler. */
export const TOOLBAR_BUILTINS: ToolbarBuiltin[] = [
  { id: "tag", icon: "hash", glyph: "#", title: "Tag", run: (ta) => wrapSelection(ta, "#", "") },
  { id: "internalLink", icon: "at-sign", glyph: "@", title: "Internal link", run: (ta) => wrapSelection(ta, "[[", "]]") },
  { id: "webLink", icon: "link", glyph: "\u{1F517}", title: "Web link", run: (ta) => insertWebLink(ta) },
  { id: "heading", icon: "heading", glyph: "H", title: "Heading (H1–H6)", cls: "stashpad-toolbar-heading", menu: openHeadingMenu },
  { id: "bold", icon: "bold", glyph: "B", title: "Bold", run: (ta) => wrapSelection(ta, "**") },
  { id: "italic", icon: "italic", glyph: "I", title: "Italic", run: (ta) => wrapSelection(ta, "*") },
  { id: "highlight", icon: "highlighter", glyph: "H", title: "Highlight", run: (ta) => wrapSelection(ta, "==") },
  { id: "codeBlock", icon: "square-code", glyph: "{}", title: "Code block", run: (ta) => insertCodeBlock(ta) },
  { id: "code", icon: "code", glyph: "</>", title: "Code", run: (ta) => wrapSelection(ta, "`") },
  { id: "checkbox", icon: "square-check-big", glyph: "☑", title: "Checkbox", run: (ta) => prefixLine(ta, "- [ ] ") },
  { id: "spoiler", icon: "eye-off", glyph: "\u{1F648}", title: "Spoiler (tap to reveal)", gate: "spoilers", run: (ta) => wrapSelection(ta, "||") },
  // 0.397.0: Drafts — composer only (gated on opts.drafts). Toggles the per-folder
  // drafts reminder chip; right-click opens the Drafts manager. Hideable/orderable
  // like any other toolbar button. No `run` — it's wired specially in the renderer.
  { id: "drafts", icon: "notebook-pen", glyph: "✎", title: "Drafts", cls: "stashpad-toolbar-drafts", gate: "drafts" },
];

/** 0.351.0: resolve the effective built-in button list from a saved config —
 *  every built-in, in effective order, with its hidden flag and resolved icon.
 *  Configured ids come first in their saved order; any built-in the config
 *  doesn't mention is appended in default order. Unknown/stale config ids are
 *  ignored. Used by both the renderer and the settings UI. */
export function resolveToolbarButtons(config?: ToolbarButtonConfig[]): { def: ToolbarBuiltin; hidden: boolean; icon: string }[] {
  const byId = new Map(TOOLBAR_BUILTINS.map((d) => [d.id, d]));
  const cfg = config ?? [];
  const seen = new Set<string>();
  const out: { def: ToolbarBuiltin; hidden: boolean; icon: string }[] = [];
  for (const c of cfg) {
    const def = byId.get(c.id);
    if (!def || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ def, hidden: c.hidden === true, icon: c.icon || def.icon });
  }
  for (const def of TOOLBAR_BUILTINS) {
    if (seen.has(def.id)) continue;
    out.push({ def, hidden: false, icon: def.icon });
  }
  return out;
}

export interface FormattingToolbarOpts {
  /** Show the spoiler (`||……||`) button — gate on the spoilerMarkup setting. */
  spoilers?: boolean;
  /** When set, adds a "Modify formatting" button that calls this (the edit-modal
   *  formatting inspector — modify/remove/layer without fighting text selection). */
  onInspect?: () => void;
  /** 0.338.0: user snippets — those with `button` get a toolbar button; the rest
   *  live in a "Snippets" menu button. Needs `app` for template-variable expansion. */
  app?: App;
  snippets?: Snippet[];
  /** Current note title, for the `{{title}}` template variable. */
  titleFor?: () => string | undefined;
  /** 0.351.0: user customization of the built-in buttons (order / hidden / icon).
   *  Undefined or empty = the default order from TOOLBAR_BUILTINS. */
  toolbarButtons?: ToolbarButtonConfig[];
  /** 0.397.0: enables the composer-only "Drafts" button (gated builtin). Absent
   *  in the edit modal, so the button never shows there. `active` drives its
   *  highlight; left-click `toggle`s the per-folder chip; right-click `open`s the
   *  Drafts manager. */
  drafts?: { active: () => boolean; toggle: () => void; open: () => void };
}

/** Render the toolbar into `host`, acting on the textarea returned by `getTa`.
 *  Returns the bar element. Order: any "start"-placed snippet buttons, then the
 *  built-in buttons (honoring the user's order/hidden/icon config), then the
 *  "end"-placed snippet buttons + Snippets menu, then the inspect button. */
export function renderFormattingToolbar(
  host: HTMLElement,
  getTa: () => HTMLTextAreaElement | null,
  opts: FormattingToolbarOpts = {},
): HTMLElement {
  const bar = host.createDiv({ cls: "stashpad-composer-toolbar" });
  const app = opts.app;
  // 0.346.0: deactivated snippets (enabled === false) render no button and are
  // absent from the Snippets menu.
  const snippets = (opts.snippets ?? []).filter((s) => s.enabled !== false);
  const insertSnippet = (ta: HTMLTextAreaElement, sn: Snippet): void => {
    if (!app) return;
    const text = expandSnippet(app, sn.value, { title: opts.titleFor?.() });
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const c = s + text.length;
    ta.setSelectionRange(c, c);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  };
  const snippetBtn = (sn: Snippet): void => {
    const b = bar.createEl("button", { cls: "stashpad-composer-toolbar-btn", attr: { "aria-label": sn.name, tabindex: "-1" } });
    setIconSafe(b, sn.icon || "type", (sn.name[0] || "S").toUpperCase());
    b.title = sn.name;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.onclick = (e) => { e.preventDefault(); const ta = getTa(); if (ta) insertSnippet(ta, sn); };
  };

  // 0.351.0: "start"-placed snippet buttons render before the built-ins.
  if (app) for (const sn of snippets.filter((s) => s.button && s.buttonPlacement === "start")) snippetBtn(sn);

  // Built-in buttons in the user's effective order, skipping hidden + gated-off.
  for (const { def, hidden, icon } of resolveToolbarButtons(opts.toolbarButtons)) {
    if (hidden) continue;
    if (def.gate === "spoilers" && !opts.spoilers) continue;
    if (def.gate === "drafts" && !opts.drafts) continue;
    const cls = "stashpad-composer-toolbar-btn" + (def.cls ? " " + def.cls : "");
    const b = bar.createEl("button", { cls, attr: { "aria-label": def.title, tabindex: "-1" } });
    setIconSafe(b, icon, def.glyph);
    b.title = def.title;
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the textarea's focus + selection
    if (def.gate === "drafts" && opts.drafts) {
      const d = opts.drafts;
      const paint = (): void => {
        const on = d.active();
        b.toggleClass("is-active", on);
        b.title = `${on ? "Hide" : "Show"} the drafts chip for this folder · right-click to open the Drafts manager`;
        b.setAttr("aria-label", b.title);
      };
      paint();
      b.onclick = (e) => { e.preventDefault(); d.toggle(); paint(); };
      b.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); d.open(); };
      continue;
    }
    b.onclick = (e) => {
      e.preventDefault();
      if (def.menu) { def.menu(e as MouseEvent, getTa); return; }
      const ta = getTa();
      if (ta && def.run) def.run(ta);
    };
  }

  // 0.338.0: "end"-placed snippet buttons (the default) render after the
  // built-ins; snippets without a button live in a "Snippets" menu button.
  if (app && snippets.length) {
    for (const sn of snippets.filter((s) => s.button && s.buttonPlacement !== "start")) snippetBtn(sn);
    const menuless = snippets.filter((s) => !s.button);
    if (menuless.length) {
      const b = bar.createEl("button", { cls: "stashpad-composer-toolbar-btn stashpad-toolbar-snippets", attr: { "aria-label": "Snippets", tabindex: "-1" } });
      setIconSafe(b, "notebook-text", "⌘");
      b.title = "Snippets";
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        for (const sn of menuless) {
          menu.addItem((it) => it.setTitle(sn.name).setIcon(sn.icon || "type").onClick(() => { const ta = getTa(); if (ta) insertSnippet(ta, sn); }));
        }
        menu.showAtMouseEvent(e as MouseEvent);
      };
    }
  }

  if (opts.onInspect) {
    const b = bar.createEl("button", { cls: "stashpad-composer-toolbar-btn stashpad-toolbar-inspect", attr: { "aria-label": "Modify formatting", tabindex: "-1" } });
    setIconSafe(b, "wand-sparkles", "✧");
    b.title = "Modify / remove formatting in this note";
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.onclick = (e) => { e.preventDefault(); opts.onInspect!(); };
  }
  return bar;
}
