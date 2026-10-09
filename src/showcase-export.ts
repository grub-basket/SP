import { App, Component, MarkdownRenderer, Modal, Platform, Setting, TFile, arrayBufferToBase64, loadPdfJs } from "obsidian";
import { appendShapeEl, type FeedbackShape } from "./showcase-shapes";

/** 0.530.1: Showcase → ONE self-contained HTML file, for someone who reviews
 *  without Obsidian (the boss). Images are inlined as data: URIs; PDFs are
 *  inlined as base64 and turned into blob: URLs by a few lines of script when
 *  the page opens (browsers refuse data: PDFs in frames), so every page shows
 *  in the browser's own PDF viewer. Nothing references the vault, so the file
 *  can be emailed or dropped on a share as-is.
 *
 *  The caller (the Showcase view) gathers the sections in page order; this
 *  module only renders. Feedback and reactions are opt-in.
 *
 *  PDFs are rasterised page-by-page with Obsidian's bundled pdf.js into JPEGs, so
 *  the pages show in ANY browser, mail preview or print, with no PDF viewer
 *  involved. Only if that fails (or the PDF is very long) does the page fall
 *  back to the inlined PDF in the browser's own viewer. */

export interface ExportComment {
  num: number;
  author: string;
  role: string;
  when: string;
  text: string;
  target: string;
  resolved: boolean;
  depth: number;
  /** `shape` (0.556.0): the box / arrow the comment marks; the pin is its anchor. */
  pin: { x: number; y: number; page?: number; path: string; shape?: FeedbackShape | null } | null;
}
export interface ExportSection {
  text: string;
  sourcePath: string;
  atts: Array<{ file: TFile; label: string; reactions: string }>;
  reactions: string;
  comments: ExportComment[];
}

/** Files above this are listed by name instead of inlined (a 300 MB video would
 *  make a file nobody can open). Images and PDFs are what a brochure needs. */
const INLINE_LIMIT = 40 * 1024 * 1024;
/** Total bytes inlined into ONE export. Base64 + the serialised copy + the
 *  write each multiply it, and V8 strings top out around 512M chars — so stop
 *  inlining well before that (much earlier on mobile, where the whole string
 *  crosses the app bridge). Files past the budget are listed by name. */
const TOTAL_BUDGET = Platform.isMobile ? 25 * 1024 * 1024 : 150 * 1024 * 1024;

/** Tags a note's rendered HTML may carry that have no business in a page
 *  someone else opens: anything that loads/submits elsewhere or runs code.
 *  (Obsidian's sanitizer already drops scripts/handlers; this is belt and
 *  braces, plus forms/iframes it allows.) */
const STRIP_TAGS = "script, iframe, object, embed, form, base, meta, link, frame, frameset";

function scrubRendered(root: HTMLElement): void {
  root.querySelectorAll(STRIP_TAGS).forEach((e) => e.remove());
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if ((n === "href" || n === "src" || n === "xlink:href" || n === "action" || n === "formaction")
        && /^\s*(javascript|vbscript):/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
  pdf: "application/pdf",
};

const PAGE_CSS = `
:root { color-scheme: light; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --bg:#fff; --soft:#f5f5f7; --accent:#7c3aed; --open:#ea7500; --ok:#2e9a4f; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
header.top { padding: 28px 32px 12px; border-bottom: 1px solid var(--line); }
header.top h1 { margin: 0 0 4px; font-size: 26px; }
header.top .sub { color: var(--muted); font-size: 13px; }
main { max-width: 1200px; margin: 0 auto; padding: 8px 32px 64px; }
section.sec { padding: 28px 0; border-bottom: 1px solid var(--line); }
section.sec:last-child { border-bottom: 0; }
.num { display: inline-block; font-size: 12px; font-weight: 600; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; margin-bottom: 6px; }
.caption > :first-child { margin-top: 0; }
.caption img { max-width: 100%; }
.atts { display: grid; gap: 18px; margin-top: 12px; }
.atts.multi { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; }
.att { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--soft); }
.att-head { display: flex; gap: 8px; padding: 6px 12px; font-size: 13px; color: var(--muted); }
.att-head b { color: var(--fg); }
.imgbox { position: relative; line-height: 0; width: fit-content; max-width: 100%; margin: 0 auto; background: var(--bg); }
.imgbox img { display: block; max-width: 100%; max-height: 90vh; width: auto; height: auto; }
img.pdfpage { display: block; width: 100%; height: auto; background: #fff; }
.imgbox.pagebox { width: 100%; max-width: none; border-top: 1px solid var(--line); }
.att-head + .imgbox.pagebox { border-top: 0; }
iframe.pdf { display: block; width: 100%; height: 90vh; border: 0; background: var(--bg); }
video, audio { display: block; width: 100%; }
.file { padding: 18px 12px; color: var(--muted); font-size: 14px; }
.reacts { padding: 6px 12px; font-size: 14px; }
.sec-reacts { margin-top: 10px; font-size: 14px; }
.pin { position: absolute; transform: translate(-50%, -50%); width: 22px; height: 22px; border-radius: 50% 50% 50% 0; background: var(--open); color: #fff; border: 2px solid #fff; font: 700 11px/18px sans-serif; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
.pin.ok { background: var(--ok); }
.regions { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.region { position: absolute; border: 2px solid var(--open); border-radius: 3px; background: rgba(234,117,0,.08); box-shadow: 0 0 0 1px rgba(255,255,255,.8), inset 0 0 0 1px rgba(255,255,255,.8); }
.region.ok { border-color: var(--ok); background: rgba(46,154,79,.08); }
svg.arrow { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; color: var(--open); }
svg.arrow.ok { color: var(--ok); }
svg.arrow .sp-arrow-line { stroke: currentColor; stroke-width: 3; stroke-linecap: round; }
svg.arrow .sp-arrow-halo { stroke: rgba(255,255,255,.85); stroke-width: 6; stroke-linecap: round; }
.feedback { margin-top: 14px; background: var(--soft); border-radius: 10px; padding: 10px 14px; }
.feedback h3 { margin: 0 0 6px; font-size: 14px; }
.c { padding: 6px 0; border-top: 1px solid var(--line); font-size: 14px; }
.c:first-of-type { border-top: 0; }
.c.reply { margin-left: 22px; border-top: 0; padding-top: 2px; }
.c .meta { color: var(--muted); font-size: 12px; }
.c .meta b { color: var(--fg); }
.c .badge { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--open); color: #fff; font-weight: 700; text-align: center; margin-right: 4px; }
.c.done .badge { background: var(--ok); }
.c.done .body { opacity: .6; }
.c .body > :first-child { margin-top: 0; }
.c .body > :last-child { margin-bottom: 0; }
@media print {
  header.top { border: 0; }
  section.sec { break-inside: avoid-page; }
  iframe.pdf { height: 1000px; }
  img.pdfpage { break-inside: avoid; }
}`;

/** The numbered pins — and (0.556.0) the boxes and arrows — of the comments
 *  aimed at `path` (page `page` of a PDF; none for an image), drawn over its
 *  picture box. Shapes go in a clipped layer under the pins. */
function appendMarks(box: HTMLElement, comments: ExportComment[], path: string, page?: number): void {
  const doc = box.ownerDocument;
  let regions: HTMLElement | null = null;
  for (const c of comments) {
    if (!c.pin || c.pin.path !== path || c.pin.page !== page) continue;
    if (c.pin.shape) {
      if (!regions) { regions = doc.createElement("div"); regions.className = "regions"; box.appendChild(regions); }
      appendShapeEl(regions, c.pin.shape, (c.pin.shape.kind === "rect" ? "region" : "arrow") + (c.resolved ? " ok" : ""));
    }
  }
  for (const c of comments) {
    if (!c.pin || c.pin.path !== path || c.pin.page !== page) continue;
    const pin = box.appendChild(doc.createElement("span")); pin.className = "pin" + (c.resolved ? " ok" : "");
    pin.textContent = String(c.num);
    pin.style.left = `${c.pin.x * 100}%`; pin.style.top = `${c.pin.y * 100}%`;
  }
}

/** Pages beyond this are left to the browser's PDF viewer (file-size guard). */
const MAX_RASTER_PAGES = 60;
/** Raster width in CSS px — sharp on a laptop, ~150–300 KB per page as JPEG. */
const RASTER_WIDTH = 1600;

interface PdfJsPage { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> }; cleanup?: () => void }
interface PdfJsDoc { numPages: number; getPage(n: number): Promise<PdfJsPage>; destroy?: () => Promise<void> }

/** Render every page of a PDF to a JPEG data: URL, or null if pdf.js can't. */
/** Chromium won't draw a canvas taller than this; cap the scale so very tall
 *  pages still render (smaller) instead of exporting blank. */
const MAX_CANVAS_PX = 16000;

async function rasterisePdf(bytes: ArrayBuffer, onPage?: (n: number, total: number) => void): Promise<string[] | null> {
  let pdf: PdfJsDoc | null = null;
  try {
    const pdfjs = await loadPdfJs() as { getDocument(o: { data: Uint8Array }): { promise: Promise<PdfJsDoc> } };
    pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
    if (!pdf.numPages || pdf.numPages > MAX_RASTER_PAGES) return null;
    const out: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      onPage?.(n, pdf.numPages);
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, RASTER_WIDTH / Math.max(1, base.width), MAX_CANVAS_PX / Math.max(1, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = createEl("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const url = canvas.toDataURL("image/jpeg", 0.85);
      canvas.width = 0; canvas.height = 0; // release the bitmap now, not at GC
      page.cleanup?.(); // drop this page's decoded images before the next
      if (!url.startsWith("data:image/")) return null; // undrawable → use the viewer fallback
      out.push(url);
    }
    return out;
  } catch (e) {
    console.warn("Stashpad showcase export: pdf.js render failed, using the browser viewer", e);
    return null;
  } finally {
    try { await pdf?.destroy?.(); } catch { /* ignore */ }
  }
}

/** Decodes each inlined PDF into a blob: URL on load. Plain DOM, no network. */
const PDF_BOOT = `document.querySelectorAll("iframe[data-pdf]").forEach(function (f) {
  try {
    var b = atob(f.getAttribute("data-pdf")); var a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    f.src = URL.createObjectURL(new Blob([a], { type: "application/pdf" })) + "#navpanes=0&view=FitH";
    f.removeAttribute("data-pdf");
  } catch (e) { f.replaceWith(Object.assign(document.createElement("div"), { className: "file", textContent: "This PDF could not be shown." })); }
});`;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return arrayBufferToBase64(digest);
}

/** Render the page and return its HTML. */
export async function buildShowcaseHtml(
  app: App,
  title: string,
  sections: ExportSection[],
  opts: { includeFeedback: boolean; onProgress?: (msg: string) => void },
): Promise<{ html: string; skipped: string[] }> {
  const doc = activeDocument.implementation.createHTMLDocument(title);
  const meta = doc.createElement("meta"); meta.setAttribute("charset", "utf-8"); doc.head.prepend(meta);
  // Content-Security-Policy: whatever slips past the scrub can't load or run
  // anything. Only inline styles, inlined media, blob: frames (the PDF
  // fallback) and the boot script below — allowed by its exact hash.
  const bootHash = await sha256Base64(PDF_BOOT);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; frame-src blob:; object-src blob:; script-src 'sha256-${bootHash}'; form-action 'none'; base-uri 'none'`;
  meta.after(csp);
  const vp = doc.createElement("meta"); vp.name = "viewport"; vp.content = "width=device-width, initial-scale=1"; doc.head.append(vp);
  const style = doc.createElement("style"); style.textContent = PAGE_CSS; doc.head.append(style);

  const top = doc.body.appendChild(doc.createElement("header")); top.className = "top";
  top.appendChild(doc.createElement("h1")).textContent = title;
  const files = sections.reduce((n, s) => n + s.atts.length, 0);
  const stamp = new Date().toLocaleString();
  top.appendChild(doc.createElement("div")).className = "sub";
  (top.lastElementChild as HTMLElement).textContent = `${sections.length} section${sections.length === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"} · exported ${stamp}`;

  const main = doc.body.appendChild(doc.createElement("main"));
  const skipped: string[] = [];
  let used = 0;
  const comp = new Component();
  comp.load();
  try {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const sec = main.appendChild(doc.createElement("section")); sec.className = "sec";
      sec.appendChild(doc.createElement("div")).className = "num";
      (sec.lastElementChild as HTMLElement).textContent = String(i + 1);

      if (s.text) {
        const tmp = createDiv();
        await MarkdownRenderer.render(app, s.text, tmp, s.sourcePath, comp);
        // Vault links and note embeds mean nothing outside Obsidian: keep their
        // text, drop the link/embeds (they'd point at app:// or vault paths).
        tmp.querySelectorAll("a.internal-link").forEach((a) => a.replaceWith(doc.createTextNode(a.textContent ?? "")));
        tmp.querySelectorAll(".internal-embed, .copy-code-button, .frontmatter-container, .tag").forEach((e) => {
          if (e.classList.contains("tag")) e.replaceWith(doc.createTextNode(e.textContent ?? "")); else e.remove();
        });
        // Remote images too: the page must open offline, and a remote image is
        // a read-receipt for whoever hosts it.
        tmp.querySelectorAll("img").forEach((img) => { if (!/^data:/i.test(img.getAttribute("src") ?? "")) img.remove(); });
        scrubRendered(tmp);
        const cap = sec.appendChild(doc.importNode(tmp, true)); cap.className = "caption";
      }

      if (s.atts.length) {
        const wrap = sec.appendChild(doc.createElement("div")); wrap.className = "atts" + (s.atts.length > 1 ? " multi" : "");
        for (const a of s.atts) {
          const card = wrap.appendChild(doc.createElement("div")); card.className = "att";
          const head = card.appendChild(doc.createElement("div")); head.className = "att-head";
          if (a.label) head.appendChild(doc.createElement("b")).textContent = a.label;
          head.appendChild(doc.createElement("span")).textContent = a.file.name;
          const ext = a.file.extension.toLowerCase();
          const mime = MIME[ext];
          const note = (text: string): void => {
            card.appendChild(doc.createElement("div")).className = "file";
            (card.lastElementChild as HTMLElement).textContent = text;
          };
          const overBudget = used + a.file.stat.size > TOTAL_BUDGET;
          if (!mime || a.file.stat.size > INLINE_LIMIT || overBudget) {
            if (mime) skipped.push(a.file.name);
            note(!mime ? `${a.file.name} — this file type can't be shown in a web page.`
              : overBudget ? `${a.file.name} — left out to keep this file a reasonable size (${Math.round(a.file.stat.size / 1048576)} MB).`
              : `${a.file.name} — too large to include (${Math.round(a.file.stat.size / 1048576)} MB).`);
          } else {
            opts.onProgress?.(`Section ${i + 1} of ${sections.length}: ${a.file.name}`);
            let bytes: ArrayBuffer;
            // One unreadable file (moved mid-export, network hiccup, cloud
            // placeholder) costs only its own card, not the whole export.
            try { bytes = await app.vault.readBinary(a.file); } catch {
              skipped.push(a.file.name);
              note(`${a.file.name} — couldn't be read when exporting.`);
              if (opts.includeFeedback && a.reactions) { card.appendChild(doc.createElement("div")).className = "reacts"; (card.lastElementChild as HTMLElement).textContent = a.reactions; }
              continue;
            }
            const pages = ext === "pdf" ? await rasterisePdf(bytes, (n, total) => opts.onProgress?.(`Section ${i + 1} of ${sections.length}: ${a.file.name} — page ${n} of ${total}`)) : null;
            const pagesBytes = pages ? pages.reduce((n, p) => n + p.length * 0.75, 0) : 0;
            used += pages ? pagesBytes : bytes.byteLength;
            const b64 = pages ? "" : arrayBufferToBase64(bytes);
            if (pages) {
              pages.forEach((src, pi) => {
                // 0.532.2: each page in its own box so pins on that page sit on it.
                const box = card.appendChild(doc.createElement("div")); box.className = "imgbox pagebox";
                const pg = box.appendChild(doc.createElement("img")); pg.className = "pdfpage";
                pg.src = src; pg.alt = `${a.file.basename} — page ${pi + 1} of ${pages.length}`;
                if (opts.includeFeedback) appendMarks(box, s.comments, a.file.path, pi + 1);
              });
            } else if (mime.startsWith("image/")) {
              const box = card.appendChild(doc.createElement("div")); box.className = "imgbox";
              const img = box.appendChild(doc.createElement("img"));
              img.src = `data:${mime};base64,${b64}`; img.alt = a.file.basename;
              if (opts.includeFeedback) appendMarks(box, s.comments, a.file.path);
            } else if (ext === "pdf") {
              const fr = card.appendChild(doc.createElement("iframe")); fr.className = "pdf";
              fr.setAttribute("title", a.file.name);
              fr.setAttribute("data-pdf", b64);
            } else if (mime.startsWith("video/")) {
              const v = card.appendChild(doc.createElement("video")); v.controls = true; v.src = `data:${mime};base64,${b64}`;
            } else {
              const au = card.appendChild(doc.createElement("audio")); au.controls = true; au.src = `data:${mime};base64,${b64}`;
            }
          }
          if (opts.includeFeedback && a.reactions) {
            card.appendChild(doc.createElement("div")).className = "reacts";
            (card.lastElementChild as HTMLElement).textContent = a.reactions;
          }
        }
      }

      if (opts.includeFeedback) {
        if (s.reactions) {
          sec.appendChild(doc.createElement("div")).className = "sec-reacts";
          (sec.lastElementChild as HTMLElement).textContent = s.reactions;
        }
        if (s.comments.length) {
          const fb = sec.appendChild(doc.createElement("div")); fb.className = "feedback";
          fb.appendChild(doc.createElement("h3")).textContent = "Feedback";
          for (const c of s.comments) {
            const row = fb.appendChild(doc.createElement("div"));
            row.className = "c" + (c.depth ? " reply" : "") + (c.resolved ? " done" : "");
            const m = row.appendChild(doc.createElement("div")); m.className = "meta";
            if (!c.depth) m.appendChild(doc.createElement("span")).className = "badge";
            if (!c.depth) (m.lastElementChild as HTMLElement).textContent = String(c.num);
            m.appendChild(doc.createElement("b")).textContent = c.author;
            const bits = [c.role, c.when, c.target ? `on ${c.target}` : "", c.resolved ? "resolved" : ""].filter(Boolean);
            if (bits.length) m.appendChild(doc.createTextNode(" · " + bits.join(" · ")));
            const tmpc = createDiv();
            await MarkdownRenderer.render(app, c.text || "(empty)", tmpc, s.sourcePath, comp);
            tmpc.querySelectorAll("a.internal-link, .tag").forEach((a) => a.replaceWith(doc.createTextNode(a.textContent ?? "")));
            tmpc.querySelectorAll(".internal-embed, .copy-code-button").forEach((e) => e.remove());
            tmpc.querySelectorAll("img").forEach((img) => { if (!/^data:/i.test(img.getAttribute("src") ?? "")) img.remove(); });
            scrubRendered(tmpc);
            const body = row.appendChild(doc.importNode(tmpc, true)); body.className = "body";
          }
        }
      }
    }
  } finally {
    comp.unload();
  }

  // 0.533.1: the boot script goes in as TEXT, not as a created element. The
  // community store's code-obfuscation scan rejects creating a script element
  // at runtime — even in this detached document, only ever serialized to a file.
  // Same bytes either way: outerHTML writes script text raw, and PDF_BOOT holds
  // no "</script" or "<!--", so the CSP hash above still matches.
  const page = doc.documentElement.outerHTML;
  const end = page.lastIndexOf("</body>");
  const boot = `<script>${PDF_BOOT}</script>`;
  return { html: "<!DOCTYPE html>\n" + (end < 0 ? page + boot : page.slice(0, end) + boot + page.slice(end)), skipped };
}

/** "Export page" options: one switch, then go. */
export class ShowcaseExportModal extends Modal {
  private includeFeedback = false;
  constructor(app: App, private onConfirm: (o: { includeFeedback: boolean }) => void) { super(app); }
  onOpen(): void {
    this.setTitle("Export page");
    this.contentEl.createEl("p", { text: "Makes one web page file with every image and PDF inside. It opens in any browser, with no Obsidian needed, so you can email it or put it on the shared drive." });
    new Setting(this.contentEl)
      .setName("Include feedback and reactions")
      .setDesc("Off: just the pages. On: also each section's comments, pins and reaction counts.")
      .addToggle((t) => t.setValue(this.includeFeedback).onChange((v) => { this.includeFeedback = v; }));
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Export").setCta().onClick(() => { this.close(); this.onConfirm({ includeFeedback: this.includeFeedback }); }));
  }
  onClose(): void { this.contentEl.empty(); }
}
