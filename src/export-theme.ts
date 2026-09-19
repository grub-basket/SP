/** Export/publish themes. The export document's stylesheet lives here as a named,
 *  swappable "theme" — the seam future publishing features build on (a published
 *  Stashpad site is the same assembled HTML with a chosen theme). For now there's
 *  one default theme; more can be added as `{ id, name, css }` rows and offered in
 *  the export dialog / publish settings without touching the assembler. */
export interface ExportTheme {
  id: string;
  name: string;
  /** The full document stylesheet (injected inline so exports stay portable). */
  css: string;
}

const DEFAULT_CSS = `
:root { color-scheme: light dark; }
body { max-width: 46rem; margin: 2rem auto; padding: 0 1.25rem;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1a1a1a; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #1e1e1e; } }
h1.sp-doc-title { font-size: 1.9rem; margin: 0 0 .25rem; }
.sp-doc-meta { color: #888; font-size: .85rem; margin: 0 0 2rem; }
.sp-note { margin: 0 0 1.5rem; }
.sp-note-title { font-weight: 600; margin: 0 0 .4rem; line-height: 1.3; }
.sp-note[data-depth="0"] { margin-top: 2rem; }
.sp-note[data-depth]:not([data-depth="0"]) { margin-left: 1.25rem;
  padding-left: 1rem; border-left: 2px solid rgba(128,128,128,.25); }
.sp-body { break-inside: avoid; }
.sp-body img.sp-export-img { max-width: 100%; height: auto; border-radius: 6px; }
.sp-export-figure { display: block; margin: .6rem 0; }
.sp-export-asset-link { display: block; font-size: .8em; color: #888; margin-top: 2px; }
.sp-note.sp-page-break { break-before: page; }
a { color: #3b7dd8; }
mark { padding: 0 .1em; border-radius: 2px; }
pre { overflow-x: auto; padding: .75rem; border-radius: 6px; background: rgba(128,128,128,.12); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
blockquote { margin: .5rem 0; padding-left: 1rem; border-left: 3px solid rgba(128,128,128,.35); color: #666; }
@media print { body { margin: 0; max-width: none; } a { color: inherit; } }
`.trim();

export const DEFAULT_EXPORT_THEME: ExportTheme = {
  id: "default",
  name: "Clean (default)",
  css: DEFAULT_CSS,
};

export const EXPORT_THEMES: readonly ExportTheme[] = [DEFAULT_EXPORT_THEME];

export function exportTheme(id: string | undefined): ExportTheme {
  return EXPORT_THEMES.find((t) => t.id === id) ?? DEFAULT_EXPORT_THEME;
}
