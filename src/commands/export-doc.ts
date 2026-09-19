import { Component, MarkdownRenderer, Notice, Platform, TFile, moment } from "obsidian";
import type { StashpadId, TreeNode } from "../types";
import type { StashpadView } from "../view";
import { htmlToPdf, htmlToPng } from "./pdf-generate";
import { ExportDocModal, type DocExportChoice } from "../export-doc-modal";
import { DEFAULT_EXPORT_THEME } from "../export-theme";

/** Export to HTML / PDF. Design + decisions: docs/export-pdf-html-plan.md.
 *
 *  Pipeline: resolve targets (per scope) → render each note through a throwaway
 *  MarkdownRenderer pass → assemble one HTML document → emit (HTML file, or PDF
 *  via pdf-generate). Attachments are copied to a sibling `<name>_assets/` folder
 *  (HTML) and/or embedded as data URIs (PDF images). Rendering never touches the
 *  live view's row render cache. */

export type ExportFormat = "html" | "pdf" | "png";
/** selection = the selected notes only (flat); subtree = selected roots + all
 *  descendants (depth-nested); thread = the reply conversation for the anchor. */
export type ExportScope = "selection" | "subtree" | "thread";

/** How referenced attachments are handled in the assembled HTML. */
type AssetMode = "folder" | "datauri";

interface ExportItem { node: TreeNode; depth: number; }

/** Mirrors io-cmds.safeBaseName so exports name consistently. */
function safeBaseName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 60) || "stash-export";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
};

function base64(bytes: ArrayBuffer): string {
  let bin = "";
  const arr = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(arr.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(bin);
}

/** Resolve what to export for the chosen scope. */
function resolveItems(view: StashpadView, scope: ExportScope): ExportItem[] {
  if (scope === "thread") {
    const anchor = view.getActionTargets()[0] ?? view.tree.get(view.focusId) ?? null;
    if (!anchor) return [];
    const t = view.contextThread(anchor.id);
    const ordered = [...t.upstream, ...(t.self ? [t.self] : []), ...t.downstream];
    const seen = new Set<StashpadId>();
    const out: ExportItem[] = [];
    for (const n of ordered) {
      if (!n.file || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ node: n, depth: 0 }); // a conversation is flat
    }
    return out;
  }
  const roots = view.collapseNestedTargets(view.getActionTargets());
  if (scope === "selection") {
    return roots.filter((n) => !!n.file).map((n) => ({ node: n, depth: 0 }));
  }
  // subtree
  const seen = new Set<StashpadId>();
  const out: ExportItem[] = [];
  const walk = (n: TreeNode, depth: number): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (n.file) out.push({ node: n, depth });
    for (const c of view.tree.getChildren(n.id)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Copy/embed referenced attachments and rewrite the rendered body. Mutates
 *  `bodyEl`. Returns the set of source paths handled (for the count). In
 *  "folder" mode images/files become relative links into `<assetsRelDir>` and
 *  the bytes are copied there; in "datauri" mode images embed as base64 (for a
 *  self-contained PDF input) while non-image files still copy to the folder. */
async function handleAttachments(
  view: StashpadView,
  bodyEl: HTMLElement,
  sourcePath: string,
  mode: AssetMode,
  assetsAbsFolder: string,
  assetsRelDir: string,
  copied: Map<string, string>,
): Promise<void> {
  const ensureFolder = async (): Promise<void> => {
    if (!(await view.app.vault.adapter.exists(assetsAbsFolder))) await view.app.vault.adapter.mkdir(assetsAbsFolder);
  };
  const copyToFolder = async (dest: TFile): Promise<string> => {
    let name = copied.get(dest.path);
    if (name) return name;
    let candidate = dest.name;
    const taken = new Set(copied.values());
    if (taken.has(candidate)) {
      const dot = candidate.lastIndexOf(".");
      const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
      const suf = dot > 0 ? candidate.slice(dot) : "";
      let i = 2;
      while (taken.has(`${stem}-${i}${suf}`)) i++;
      candidate = `${stem}-${i}${suf}`;
    }
    await ensureFolder();
    await view.app.vault.adapter.writeBinary(`${assetsAbsFolder}/${candidate}`, await view.app.vault.readBinary(dest));
    copied.set(dest.path, candidate);
    return candidate;
  };
  const dataUri = async (dest: TFile, ext: string): Promise<string> => {
    const bytes = await view.app.vault.readBinary(dest);
    return `data:${MIME[ext] || "application/octet-stream"};base64,${base64(bytes)}`;
  };

  const doc = bodyEl.ownerDocument;
  // Build a <figure>-like wrapper: the image (embedded data URI for PDF, or a
  // relative ref for HTML) PLUS a link to the copied file — so every image is
  // BOTH shown inline AND available as a separate downloadable item. The source
  // file is always copied to the helper folder regardless of embed mode.
  const figureFor = async (dest: TFile, ext: string, alt: string): Promise<HTMLElement> => {
    const relName = await copyToFolder(dest); // always copy to the helper folder
    const rel = `${assetsRelDir}/${encodeURIComponent(relName)}`;
    const fig = doc.createElement("span");
    fig.className = "sp-export-figure";
    const img = doc.createElement("img");
    img.className = "sp-export-img";
    img.setAttribute("alt", alt);
    img.setAttribute("src", mode === "datauri" ? await dataUri(dest, ext) : rel);
    fig.appendChild(img);
    const a = doc.createElement("a");
    a.className = "sp-export-asset-link";
    a.setAttribute("href", rel);
    a.textContent = relName;
    fig.appendChild(a);
    return fig;
  };

  const embeds = Array.from(bodyEl.querySelectorAll<HTMLElement>(".internal-embed[src]"));
  for (const span of embeds) {
    const linkpath = span.getAttribute("src") || "";
    if (!linkpath) continue;
    const dest = view.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    if (!dest) continue; // note transclusion / unresolved — leave as-is
    const ext = (dest.extension || "").toLowerCase();
    if (IMG_EXTS.has(ext)) {
      span.replaceWith(await figureFor(dest, ext, linkpath));
    } else {
      // Non-image file: copy to the helper folder + link (can't render in-doc).
      const a = doc.createElement("a");
      a.className = "sp-export-asset-link";
      a.setAttribute("href", `${assetsRelDir}/${encodeURIComponent(await copyToFolder(dest))}`);
      a.textContent = linkpath;
      span.replaceWith(a);
    }
  }
  // Bare markdown images (`![](path)` → app:// URL): resolve via alt/filename.
  for (const img of Array.from(bodyEl.querySelectorAll<HTMLImageElement>("img"))) {
    if (img.classList.contains("sp-export-img")) continue;
    const src = img.getAttribute("src") || "";
    if (!src || /^(https?:|data:)/.test(src)) continue;
    const guess = img.getAttribute("alt") || decodeURIComponent(src.split("/").pop() || "");
    if (!guess) continue;
    const dest = view.app.metadataCache.getFirstLinkpathDest(guess, sourcePath);
    if (!dest) continue;
    const ext = (dest.extension || "").toLowerCase();
    img.replaceWith(await figureFor(dest, ext, guess));
  }
}

function assembleDocument(title: string, sections: string[], depths: number[], splitPerItem: boolean): string {
  const body = sections.map((html, i) => {
    const depth = depths[i];
    const topLevelPage = splitPerItem && depth === 0 && i > 0;
    return `<section class="sp-note${topLevelPage ? " sp-page-break" : ""}" data-depth="${depth}">\n${html}\n</section>`;
  }).join("\n");
  const stamp = (moment as unknown as () => { format(f: string): string })().format("YYYY-MM-DD HH:mm");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${DEFAULT_EXPORT_THEME.css}</style>
</head>
<body>
<h1 class="sp-doc-title">${esc(title)}</h1>
<p class="sp-doc-meta">Exported from Stashpad · ${esc(stamp)} · ${sections.length} note${sections.length === 1 ? "" : "s"}</p>
${body}
</body>
</html>`;
}

/** One rendered note: its title, tree depth, and the rendered body DOM. */
export interface RenderedPiece { title: string; depth: number; bodyEl: HTMLElement; }

/** Render every item's body to a detached DOM (through a throwaway component),
 *  handling attachments per `assetMode`. The caller consumes `bodyEl` (serialize
 *  to HTML) then discards. */
async function renderPieces(
  view: StashpadView,
  items: ExportItem[],
  assetMode: AssetMode,
  assetsAbsFolder: string,
  assetsRelDir: string,
): Promise<{ pieces: RenderedPiece[]; assetCount: number }> {
  const copied = new Map<string, string>();
  const comp = new Component();
  comp.load();
  const pieces: RenderedPiece[] = [];
  try {
    for (const { node, depth } of items) {
      const file = node.file;
      if (!file) continue;
      const bodyMd = view.stripFrontmatter(await view.app.vault.cachedRead(file));
      const bodyEl = createDiv();
      try {
        await MarkdownRenderer.render(view.app, bodyMd, bodyEl, file.path, comp);
        await handleAttachments(view, bodyEl, file.path, assetMode, assetsAbsFolder, assetsRelDir, copied);
      } catch (e) {
        console.warn("[Stashpad] export: render failed for", file.path, e);
      }
      pieces.push({ title: view.titleForNode(node).trim() || file.basename, depth, bodyEl });
    }
  } finally {
    comp.unload();
  }
  return { pieces, assetCount: copied.size };
}

/** Serialize rendered pieces into one HTML document string. */
function piecesToHtml(title: string, pieces: RenderedPiece[], splitPerItem: boolean): string {
  const sections = pieces.map((p) => {
    const hLevel = Math.min(p.depth + 2, 6);
    return `<h${hLevel} class="sp-note-title">${esc(p.title)}</h${hLevel}>\n<div class="sp-body">${p.bodyEl.innerHTML}</div>`;
  });
  return assembleDocument(title, sections, pieces.map((p) => p.depth), splitPerItem);
}

/** Open the export dialog, then run the chosen export. Entry point for the menu
 *  / command. */
export function cmdExportDoc(view: StashpadView): void {
  const targets = view.getActionTargets();
  if (targets.length === 0) { new Notice("Nothing to export."); return; }
  const anchor = targets[0];
  const folderTag = (view.noteFolder.split("/").pop() || view.noteFolder).trim() || "stashpad";
  // Name from the COLLAPSED roots (what actually exports under the default subtree
  // scope) — a parent+descendant selection is one root, siblings are many — so the
  // default filename matches the output instead of the raw click count.
  const roots = view.collapseNestedTargets(targets);
  const defaultBase = roots.length === 1
    ? (view.titleForNode(roots[0]).trim() || folderTag)
    : `${folderTag}-${roots.length}notes`;
  const thread = view.contextThread(anchor.id);
  const hasThread = thread.upstream.length > 0 || thread.downstream.length > 0;
  new ExportDocModal(view.app, {
    defaultBaseName: defaultBase,
    noteCount: targets.length,
    hasThread,
    onConfirm: (c) => void runExport(view, c),
  }).open();
}

/** Back-compat: the P1 direct "Export to HTML…" menu item. Opens the dialog
 *  pre-set to HTML for a one-tap flow is overkill — just open the dialog. */
export function cmdExportHtml(view: StashpadView): void {
  cmdExportDoc(view);
}

/** Group rendered pieces into top-level chunks — each chunk starts at a depth-0
 *  item and includes its nested descendants. Used for "split per item" PNG export
 *  (one image per top-level note + its subtree). */
function groupTopLevel(pieces: RenderedPiece[]): { title: string; pieces: RenderedPiece[] }[] {
  const groups: { title: string; pieces: RenderedPiece[] }[] = [];
  for (const p of pieces) {
    if (p.depth === 0 || groups.length === 0) groups.push({ title: p.title, pieces: [p] });
    else groups[groups.length - 1].pieces.push(p);
  }
  return groups;
}

/** Copy a Uint8Array's bytes into a standalone ArrayBuffer for vault.createBinary
 *  (avoids passing a view over a larger/pooled buffer). */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

async function runExport(view: StashpadView, c: DocExportChoice): Promise<void> {
  const items = resolveItems(view, c.scope);
  if (items.length === 0) { new Notice("Nothing to export for that scope."); return; }

  const exportSub = (view.plugin.settings.exportFolder || "_exports").trim().replace(/^\/+|\/+$/g, "");
  const exportFolder = `${view.noteFolder}/${exportSub}`;
  await view.ensureFolder(exportFolder);

  const stamp = (moment as unknown as () => { format(f: string): string })().format("YYYYMMDD-HHmmss");
  const outBase = `${safeBaseName(c.baseName)}-${stamp}`;
  const assetsRelDir = `${outBase}_assets`;
  const assetsAbsFolder = `${exportFolder}/${assetsRelDir}`;

  try {
    if (c.format === "html") {
      const { pieces, assetCount } = await renderPieces(view, items, "folder", assetsAbsFolder, assetsRelDir);
      const html = piecesToHtml(c.baseName, pieces, c.splitPerItem);
      const htmlPath = `${exportFolder}/${outBase}.html`;
      await view.app.vault.create(htmlPath, html);
      await maybeSaveDialog(view, htmlPath, html, "html", c.saveDialog);
      finishNotice(view, items[0].node.id, htmlPath, "html", items.length, assetCount);
      return;
    }
    // PDF and PNG are desktop-only (rendered via a hidden Electron window). Images
    // embed as data URIs (self-contained render); non-image attachments still copy
    // to the helper folder + link. On mobile the modal hides these — guard anyway.
    if (Platform.isMobile) {
      view.plugin.notifications.show({
        message: "PDF / image export is desktop-only — export to HTML on mobile (it opens/prints anywhere).",
        kind: "warning", category: "export",
      });
      return;
    }
    const { pieces, assetCount } = await renderPieces(view, items, "datauri", assetsAbsFolder, assetsRelDir);

    if (c.format === "pdf") {
      const pdf = await htmlToPdf(view, piecesToHtml(c.baseName, pieces, c.splitPerItem));
      if (!pdf) {
        view.plugin.notifications.show({
          message: "Couldn't generate the PDF on this device. Export to HTML instead, or open it and print to PDF.",
          kind: "warning", category: "export",
        });
        return;
      }
      const pdfPath = `${exportFolder}/${outBase}.pdf`;
      await view.app.vault.createBinary(pdfPath, toArrayBuffer(pdf));
      await maybeSaveDialog(view, pdfPath, pdf, "pdf", c.saveDialog);
      finishNotice(view, items[0].node.id, pdfPath, "pdf", items.length, assetCount);
      return;
    }

    // PNG. Combined = one tall image; split = one image per top-level item.
    const groups = c.splitPerItem ? groupTopLevel(pieces) : [{ title: c.baseName, pieces }];
    const written: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const png = await htmlToPng(view, piecesToHtml(g.title, g.pieces, false));
      if (!png) {
        view.plugin.notifications.show({
          message: "Couldn't generate the image on this device. Export to HTML or PDF instead.",
          kind: "warning", category: "export",
        });
        return;
      }
      const pngPath = groups.length === 1 ? `${exportFolder}/${outBase}.png` : `${exportFolder}/${outBase}-${i + 1}.png`;
      await view.app.vault.createBinary(pngPath, toArrayBuffer(png));
      written.push(pngPath);
      if (groups.length === 1) await maybeSaveDialog(view, pngPath, png, "png", c.saveDialog);
    }
    if (written.length === 1) {
      finishNotice(view, items[0].node.id, written[0], "png", items.length, assetCount);
    } else {
      await view.log.append({ type: "stash_export", id: items[0].node.id, payload: { paths: written, format: "png", noteCount: items.length, attachments: assetCount } });
      view.plugin.notifications.show({
        message: `Exported ${written.length} images (one per item) → \`${exportFolder}\``,
        kind: "success", category: "export",
        affectedPaths: written, folder: view.noteFolder,
        actions: view.actionsForFile(written[0]), duration: 0,
      });
    }
  } catch (e) {
    view.plugin.notifications.show({
      message: `Stashpad: export failed\nError: ${(e as Error).message}\nCheck disk space + write permissions on the export folder.`,
      kind: "error", category: "export",
    });
    console.error(e);
  }
}

async function finishNotice(view: StashpadView, anchorId: StashpadId, path: string, fmt: ExportFormat, count: number, assets: number): Promise<void> {
  await view.log.append({ type: "stash_export", id: anchorId, payload: { path, format: fmt, noteCount: count, attachments: assets } });
  const assetNote = assets ? ` (+ ${assets} attachment${assets === 1 ? "" : "s"})` : "";
  view.plugin.notifications.show({
    message: `Exported ${count} note${count === 1 ? "" : "s"} to ${fmt.toUpperCase()}${assetNote} → \`${path}\``,
    kind: "success", category: "export",
    affectedPaths: [path], folder: view.noteFolder,
    actions: view.actionsForFile(path), duration: 0,
  });
}

/** Desktop: after writing to the vault, offer a system Save dialog to copy the
 *  file out to anywhere. No-op / silent on mobile (share sheet is a later add). */
async function maybeSaveDialog(view: StashpadView, vaultPath: string, data: string | Uint8Array, fmt: ExportFormat, want: boolean): Promise<void> {
  if (!want || Platform.isMobile) return;
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!req) return;
    const electron = req("electron") as { remote?: any } | undefined;
    const remote = electron?.remote ?? (tryRequire(req, "@electron/remote") as { dialog?: any; getCurrentWindow?: () => unknown } | null);
    const dialog = remote?.dialog;
    if (!dialog?.showSaveDialog) return;
    const fs = req("fs") as { promises: { writeFile(p: string, d: Uint8Array | string): Promise<void> } };
    const res = await dialog.showSaveDialog(remote.getCurrentWindow?.() ?? undefined, {
      defaultPath: vaultPath.split("/").pop(),
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (res?.canceled || !res?.filePath) return;
    await fs.promises.writeFile(res.filePath, typeof data === "string" ? data : Buffer.from(data));
    new Notice(`Saved a copy → ${res.filePath}`);
  } catch (e) {
    console.warn("[Stashpad] save dialog failed", e);
  }
}

function tryRequire(req: (m: string) => unknown, mod: string): unknown {
  try { return req(mod); } catch { return null; }
}
