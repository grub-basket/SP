import type { StashpadView } from "../view";

/** Convert an assembled (self-contained, data-URI images) HTML document to PDF
 *  bytes via Electron `webContents.printToPDF` in a hidden BrowserWindow — zero
 *  dependency, real Chromium layout + pagination, selectable text. Desktop-only
 *  (Electron); the caller guards mobile out. Any failure returns null so the
 *  caller can fall back to HTML with a clear notice. `view` is currently unused
 *  but kept for symmetry / future adapter-path use. */
export async function htmlToPdf(_view: StashpadView, html: string): Promise<Uint8Array | null> {
  return await htmlToPdfDesktop(html);
}

function req(mod: string): unknown {
  try { return (window as unknown as { require?: (m: string) => unknown }).require?.(mod) ?? null; }
  catch { return null; }
}

async function htmlToPdfDesktop(html: string): Promise<Uint8Array | null> {
  const electron = req("electron") as { remote?: any } | null;
  const remote = electron?.remote ?? (req("@electron/remote") as { BrowserWindow?: any } | null);
  const BrowserWindow = remote?.BrowserWindow;
  const fs = req("fs") as { promises: { writeFile(p: string, d: string): Promise<void>; unlink(p: string): Promise<void> } } | null;
  const os = req("os") as { tmpdir(): string } | null;
  const path = req("path") as { join(...p: string[]): string } | null;
  if (!BrowserWindow || !fs || !os || !path) {
    console.warn("[Stashpad] PDF: Electron BrowserWindow/remote not available; can't print to PDF from the renderer here.");
    return null;
  }
  // Write to a temp file and loadFile — robust for large data-URI-heavy docs that
  // could blow a data: URL length limit.
  const tmp = path.join(os.tmpdir(), `stashpad-export-${Date.now()}.html`);
  let win: any = null;
  try {
    await fs.promises.writeFile(tmp, html);
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: false, sandbox: true, javascript: false } });
    await win.loadFile(tmp);
    // Give the layout a beat to settle (images already inline as data URIs).
    await new Promise((r) => setTimeout(r, 150));
    const buf: Buffer = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: "default" },
      pageSize: "A4",
    });
    return new Uint8Array(buf);
  } catch (e) {
    console.warn("[Stashpad] PDF: printToPDF failed", e);
    return null;
  } finally {
    try { win?.destroy(); } catch { /* */ }
    try { await fs.promises.unlink(tmp); } catch { /* */ }
  }
}
