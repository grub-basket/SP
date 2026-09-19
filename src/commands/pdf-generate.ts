import type { StashpadView } from "../view";

/** Render an assembled (self-contained, data-URI images) HTML document to PDF or
 *  PNG bytes via a hidden Electron BrowserWindow. Desktop-only (Electron); the
 *  caller guards mobile out. Any failure returns null so the caller can fall back
 *  to HTML with a clear notice. */

function req(mod: string): unknown {
  try { return (window as unknown as { require?: (m: string) => unknown }).require?.(mod) ?? null; }
  catch { return null; }
}

interface HiddenWinDeps {
  BrowserWindow: any;
  fs: { promises: { writeFile(p: string, d: string): Promise<void>; unlink(p: string): Promise<void> } };
  os: { tmpdir(): string };
  path: { join(...p: string[]): string };
}

function deps(): HiddenWinDeps | null {
  const electron = req("electron") as { remote?: any } | null;
  const remote = electron?.remote ?? (req("@electron/remote") as { BrowserWindow?: any } | null);
  const BrowserWindow = remote?.BrowserWindow;
  const fs = req("fs") as HiddenWinDeps["fs"] | null;
  const os = req("os") as HiddenWinDeps["os"] | null;
  const path = req("path") as HiddenWinDeps["path"] | null;
  if (!BrowserWindow || !fs || !os || !path) {
    console.warn("[Stashpad] export: Electron BrowserWindow/remote not available in this renderer.");
    return null;
  }
  return { BrowserWindow, fs, os, path };
}

/** Write `html` to a temp file, load it into a hidden window, run `fn(win)`, then
 *  always destroy the window + delete the temp file. `js` enables page JS (needed
 *  to measure height for PNG; PDF leaves it off). */
async function withHiddenWindow<T>(html: string, js: boolean, fn: (win: any) => Promise<T>): Promise<T | null> {
  const d = deps();
  if (!d) return null;
  const tmp = d.path.join(d.os.tmpdir(), `stashpad-export-${Date.now()}.html`);
  let win: any = null;
  try {
    await d.fs.promises.writeFile(tmp, html);
    win = new d.BrowserWindow({ show: false, webPreferences: { offscreen: false, sandbox: true, javascript: js } });
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 150)); // let layout settle (images are inline data URIs)
    return await fn(win);
  } catch (e) {
    console.warn("[Stashpad] export: hidden-window render failed", e);
    return null;
  } finally {
    try { win?.destroy(); } catch { /* */ }
    try { await d.fs.promises.unlink(tmp); } catch { /* */ }
  }
}

export async function htmlToPdf(_view: StashpadView, html: string): Promise<Uint8Array | null> {
  return await withHiddenWindow(html, false, async (win) => {
    const buf: Buffer = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: "default" },
      pageSize: "A4",
    });
    return new Uint8Array(buf);
  });
}

/** Fixed render width (px) for image export. */
const PNG_WIDTH = 820;
/** Cap the captured height — Chromium can't capture an arbitrarily tall surface,
 *  and a multi-note export can get very long. Content beyond this is clipped
 *  (the user accepted that tradeoff for multi-note images). */
const PNG_MAX_HEIGHT = 16000;

/** Render the HTML to a single PNG sized to the content height. */
export async function htmlToPng(_view: StashpadView, html: string): Promise<Uint8Array | null> {
  return await withHiddenWindow(html, true, async (win) => {
    win.setContentSize(PNG_WIDTH, 800);
    // Measure the full document height, then size the window to it so capturePage
    // grabs the whole thing (it captures the content viewport, not off-screen area).
    const raw = await win.webContents.executeJavaScript(
      "Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))",
    );
    const height = Math.max(200, Math.min(Number(raw) || 800, PNG_MAX_HEIGHT));
    win.setContentSize(PNG_WIDTH, height);
    await new Promise((r) => setTimeout(r, 120)); // reflow after resize
    const img = await win.webContents.capturePage();
    const buf: Buffer = img.toPNG();
    return new Uint8Array(buf);
  });
}
