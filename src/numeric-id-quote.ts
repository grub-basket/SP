import type { App, TFile } from "obsidian";

/** 0.527.0: quote bare all-digit `id:` / `parent:` frontmatter values.
 *
 *  YAML reads `id: 1234567` as the NUMBER 1234567. Stashpad now treats a number
 *  id and its digit string as the same id everywhere it reads one (readId /
 *  sameId), so nothing here is needed for correctness. Quoting just stores the
 *  value as text on disk, so other tools, older Stashpad builds and future
 *  code all see a string.
 *
 *  Rules — this rewrites user notes, so it is deliberately narrow:
 *  - Only the `id` and `parent` keys, and only when the metadata cache already
 *    holds a NUMBER for that key. A note with no such value is not read and
 *    not written (one cache lookup; matters on a network share).
 *  - The value is never changed, only quoted. The raw frontmatter line is read
 *    and its literal digits are what get written back. A literal that YAML
 *    does not round-trip exactly (leading zeros like `0042`, `1e5`, `0x2A`,
 *    digits past 2^53, a trailing comment) is LEFT ALONE and reported as
 *    `unsafe`: writing String(number) there would change the id.
 *  - Written through processFrontMatter with the value set as a string, so
 *    Obsidian's serializer quotes it and the rest of the frontmatter is kept.
 *  - Idempotent: once quoted, the cache holds a string and the file is a no-op. */
export type QuoteResult = "none" | "quoted" | "unsafe" | "failed";

export const QUOTABLE_ID_KEYS = ["id", "parent"] as const;

/** True when the cache value for `key` is a bare number (the only case we act on). */
function isNumberValue(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Cheap pre-check from the metadata cache alone — no file IO. */
export function needsIdQuoting(fm: Record<string, unknown> | undefined | null): boolean {
  if (!fm) return false;
  return QUOTABLE_ID_KEYS.some((k) => isNumberValue(fm[k]));
}

/** The literal text of `key:` in the file's frontmatter block, when it is a
 *  plain integer that round-trips exactly to `expected`. Otherwise null. */
export function safeDigitLiteral(text: string, key: string, expected: number): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const re = new RegExp(`^${key}:[ \\t]*([0-9]+)[ \\t]*$`, "m");
  const hit = re.exec(m[1]);
  if (!hit) return null;
  const lit = hit[1];
  // No leading zeros (YAML may read them as octal or drop them) and inside the
  // safe-integer range, so String(Number(lit)) === lit and nothing is lost.
  if (!/^(0|[1-9][0-9]*)$/.test(lit)) return null;
  const n = Number(lit);
  if (!Number.isSafeInteger(n) || n !== expected || String(n) !== lit) return null;
  return lit;
}

/** Quote one file's bare numeric `id` / `parent`. See the module comment. */
export async function quoteNumericIdsInFile(app: App, file: TFile): Promise<QuoteResult> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  if (!needsIdQuoting(fm)) return "none";
  let text: string;
  try { text = await app.vault.cachedRead(file); } catch { return "failed"; }
  const plan: Array<{ key: string; lit: string }> = [];
  let unsafe = false;
  for (const key of QUOTABLE_ID_KEYS) {
    const v = fm?.[key];
    if (!isNumberValue(v)) continue;
    const lit = safeDigitLiteral(text, key, v);
    if (lit === null) unsafe = true;
    else plan.push({ key, lit });
  }
  if (plan.length === 0) return unsafe ? "unsafe" : "none";
  try {
    await app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
      // Re-check against the file's TRUE frontmatter: only replace a value that
      // is still that exact number. Anything else (already quoted, edited
      // since) is left as it is.
      for (const { key, lit } of plan) {
        if (isNumberValue(m[key]) && String(m[key]) === lit) m[key] = lit;
      }
    });
  } catch (e) {
    console.warn("[Stashpad] quoting numeric id failed", file.path, e);
    return "failed";
  }
  return unsafe ? "unsafe" : "quoted";
}
