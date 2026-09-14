import { App, moment } from "obsidian";
import { getTemplatesFormats } from "./settings";
import { newId } from "./id-service";

/** 0.338.0: a user text snippet. May be surfaced as a toolbar button and/or
 *  auto-expanded when its `trigger` is typed. `value` may contain template
 *  variables (see expandSnippet). */
export interface Snippet {
  id: string;
  /** Typed abbreviation that auto-expands (e.g. ":sig"). Empty = no auto-expand. */
  trigger: string;
  /** Tooltip / menu label. */
  name: string;
  /** Inserted text; may contain {{date}}, {{time}}, {{date:FMT}}, {{title}}. */
  value: string;
  /** Lucide icon for the button (optional). */
  icon: string;
  /** Show as a toolbar button (else it lives only in the snippet menu). */
  button: boolean;
  /** 0.346.0: false = deactivated — no auto-expand, no button, hidden from the
   *  Snippets menu, but not deleted. `undefined` (legacy) is treated as enabled. */
  enabled?: boolean;
  /** 0.346.0: match the trigger case-sensitively. Default (false/undefined) =
   *  case-insensitive auto-expand. */
  caseSensitive?: boolean;
  /** 0.351.0: where this snippet's toolbar button sits on the formatting bar —
   *  "start" (before the built-in buttons) or "end" (after them, the default).
   *  Only meaningful when `button` is on. `undefined` (legacy) = "end". */
  buttonPlacement?: "start" | "end";
}

export function makeSnippet(partial: Partial<Snippet> = {}): Snippet {
  return {
    id: partial.id || newId(),
    trigger: partial.trigger ?? "",
    name: partial.name ?? "",
    value: partial.value ?? "",
    icon: partial.icon ?? "",
    button: partial.button ?? false,
    enabled: partial.enabled,
    caseSensitive: partial.caseSensitive,
    buttonPlacement: partial.buttonPlacement,
  };
}

/** Coerce a stored value into a valid Snippet, or null if unusable. */
export function normalizeSnippet(x: unknown): Snippet | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const value = typeof o.value === "string" ? o.value : "";
  if (!name && !value) return null;
  return {
    id: typeof o.id === "string" && o.id ? o.id : newId(),
    trigger: typeof o.trigger === "string" ? o.trigger : "",
    name: name || value.slice(0, 24),
    value,
    icon: typeof o.icon === "string" ? o.icon : "",
    button: o.button === true,
    // 0.346.0: preserve only when a real boolean was stored; undefined = default
    // (enabled / case-insensitive) for back-compat.
    enabled: typeof o.enabled === "boolean" ? o.enabled : undefined,
    caseSensitive: typeof o.caseSensitive === "boolean" ? o.caseSensitive : undefined,
    // 0.351.0: preserve only a recognized value; undefined (legacy) = "end".
    buttonPlacement: o.buttonPlacement === "start" || o.buttonPlacement === "end" ? o.buttonPlacement : undefined,
  };
}

/** 0.340.0: parse pasted/loaded CSV or TSV into rows of fields. Auto-detects the
 *  delimiter (tab if any line has one, else comma). Handles basic CSV quoting
 *  ("a,b" and "" escapes) on single lines; multi-line quoted values aren't
 *  supported (rare for snippet imports). Blank lines are dropped. */
export function parseDelimited(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  const delim = lines.some((l) => l.includes("\t")) ? "\t" : ",";
  const rows: string[][] = [];
  for (const line of lines) {
    if (delim === "\t") { rows.push(line.split("\t").map((f) => f.trim())); continue; }
    // CSV with basic double-quote handling.
    const fields: string[] = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { fields.push(cur); cur = ""; }
      else cur += ch;
    }
    fields.push(cur);
    rows.push(fields.map((f) => f.trim()));
  }
  return rows;
}

/** Turn delimited rows into candidate snippets. Column shapes:
 *  2 cols → [trigger, value] (name = trigger); 3+ → [name, trigger, value...].
 *  A header row (first cell "name"/"trigger"/"key") is skipped. */
export function snippetsFromRows(rows: string[][]): Snippet[] {
  const out: Snippet[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (r === 0 && row[0] && /^(name|trigger|key|abbr\w*)$/i.test(row[0])) continue; // header
    const nonEmpty = row.filter((c) => c !== "");
    if (nonEmpty.length < 1) continue;
    let name = "", trigger = "", value = "";
    if (row.length >= 3) { name = row[0]; trigger = row[1]; value = row.slice(2).join(row.length > 3 ? " " : ""); }
    else if (row.length === 2) { trigger = row[0]; name = row[0]; value = row[1]; }
    else { name = value = row[0]; }
    if (!value.trim() && !name.trim()) continue;
    out.push(makeSnippet({ name: name || value.slice(0, 24), trigger, value }));
  }
  return out;
}

/** 0.340.0: merge imported candidates into an existing snippet list.
 *  - Exact match (same trigger AND value) → skipped.
 *  - Same trigger, different value → a CONFLICT resolved by `mode`:
 *      "replace" overwrites the existing value; "keep-both" adds the candidate
 *      as a separate snippet (its trigger cleared so it won't auto-expand-clash).
 *  - No matching trigger (or blank trigger) → added. */
export function mergeSnippets(
  existing: Snippet[],
  candidates: Snippet[],
  mode: "replace" | "keep-both",
): { result: Snippet[]; added: number; skipped: number; conflicts: number } {
  const result = existing.map((s) => ({ ...s }));
  const byTrigger = new Map<string, Snippet>();
  for (const s of result) if (s.trigger) byTrigger.set(s.trigger, s);
  let added = 0, skipped = 0, conflicts = 0;
  for (const c of candidates) {
    const ex = c.trigger ? byTrigger.get(c.trigger) : undefined;
    if (!ex) { result.push(c); if (c.trigger) byTrigger.set(c.trigger, c); added++; continue; }
    if ((ex.value ?? "").trim() === (c.value ?? "").trim()) { skipped++; continue; } // exact dup
    conflicts++;
    if (mode === "replace") { ex.value = c.value; if (c.name) ex.name = c.name; }
    else { const kb = makeSnippet({ name: c.name, value: c.value, trigger: "" }); result.push(kb); added++; }
  }
  return { result, added, skipped, conflicts };
}

/** How many of `candidates` conflict with `existing` (same trigger, different value). */
export function countSnippetConflicts(existing: Snippet[], candidates: Snippet[]): number {
  const byTrigger = new Map<string, Snippet>();
  for (const s of existing) if (s.trigger) byTrigger.set(s.trigger, s);
  let n = 0;
  for (const c of candidates) {
    const ex = c.trigger ? byTrigger.get(c.trigger) : undefined;
    if (ex && (ex.value ?? "").trim() !== (c.value ?? "").trim()) n++;
  }
  return n;
}

/** 0.346.0: do two snippet triggers collide? Empty triggers never collide. An
 *  exact string match always collides; otherwise they collide when equal
 *  case-insensitively AND at least one side is case-insensitive (two
 *  case-sensitive triggers only clash on an exact match). */
export function triggersCollide(a: Snippet, b: Snippet): boolean {
  if (!a.trigger || !b.trigger) return false;
  if (a.trigger === b.trigger) return true;
  const eitherInsensitive = a.caseSensitive !== true || b.caseSensitive !== true;
  return eitherInsensitive && a.trigger.toLowerCase() === b.trigger.toLowerCase();
}

/** 0.346.0: first OTHER snippet (by id) whose trigger collides with `s`, or null. */
export function findTriggerCollision(s: Snippet, all: Snippet[]): Snippet | null {
  if (!s.trigger) return null;
  for (const other of all) {
    if (other.id === s.id) continue;
    if (triggersCollide(s, other)) return other;
  }
  return null;
}

/** 0.338.0: expand template variables in a snippet value. Dates/times use the
 *  core Templates plugin's configured format when available (parity with
 *  Obsidian's own `{{date}}` / `{{time}}`), else ISO defaults.
 *
 *  Supported: `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}`,
 *  `{{title}}` (the note's title, when a context is given). Unknown variables are
 *  left untouched so a literal `{{x}}` in a value survives. */
export function expandSnippet(app: App, value: string, ctx?: { title?: string }): string {
  const fmts = getTemplatesFormats(app);
  const dateFmt = fmts?.dateFormat || "YYYY-MM-DD";
  const timeFmt = fmts?.timeFormat || "HH:mm";
  const m = (moment as unknown as () => { format: (f: string) => string })();
  return value.replace(/\{\{\s*([a-zA-Z]+)(?::([^}]+))?\s*\}\}/g, (whole, key: string, fmt?: string) => {
    const k = key.toLowerCase();
    if (k === "date") return m.format((fmt || dateFmt).trim());
    if (k === "time") return m.format((fmt || timeFmt).trim());
    if (k === "title") return ctx?.title ?? "";
    return whole;
  });
}
