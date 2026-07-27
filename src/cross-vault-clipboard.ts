/** 0.201.0: cross-vault note transfer over the OS clipboard.
 *
 *  Copy/cut writes TWO clipboard flavors at once: the human-readable
 *  `text/plain` it always wrote, plus a `text/html` flavor whose wrapper div
 *  carries a hidden payload — the selection serialized as a `.stash` zip
 *  (base64) with a small meta header. Any Stashpad in ANY vault/window can
 *  detect the payload on paste and reconstruct real notes via the existing
 *  `importStashZip` machinery (id remap, attachment dedupe, reserved-
 *  frontmatter strip). Pasting into a normal app still gets plain text.
 *
 *  Safety model (v1, deliberate): a cross-vault paste NEVER deletes the
 *  source — even for a cut. Two vaults are separate app instances, so
 *  "delete at source once the paste lands" cannot be transactional; deleting
 *  up front risks exactly the "cut to an external drive, crash mid-way" data
 *  loss. So cross-vault cut behaves as copy + a notice reminding the user
 *  the originals remain in the source vault. Same-vault cut/paste semantics
 *  are untouched.
 *
 *  Desktop-only in practice (multi-vault windows are a desktop workflow);
 *  every function degrades to a no-op/null when the clipboard APIs aren't
 *  available. */

export interface XvMeta {
  v: 1;
  mode: "cut" | "copy";
  sourceVault: string;
  sourceFolder: string;
  /** Selection shape, for progress/receipt notices. */
  parents: number;
  children: number;
  /** 0.201.1: present on CUT payloads — the destination writes this token back
   *  to the clipboard as an ACK after a successful paste, so the SOURCE vault
   *  (which polls on window focus) can offer to delete the originals. */
  cutToken?: string;
}

/** Refuse to put payloads bigger than this on the clipboard (zip bytes,
 *  pre-base64). Large-attachment selections should travel as a .stash FILE
 *  instead — the caller offers that path in a modal. */
export const XV_MAX_BYTES = 8 * 1024 * 1024;

const ATTR_META = "data-stashpad-xv-meta";
const ATTR_ZIP = "data-stashpad-xv-zip";
const ATTR_ACK = "data-stashpad-xv-ack";
const ATTR_ACK_VAULT = "data-stashpad-xv-ackvault";

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Electron's clipboard module, when we're on desktop. Preferred over
 *  navigator.clipboard because it's synchronous and works regardless of
 *  window focus (navigator rejects with "document is not focused" — the
 *  pop-out lesson from 0.199.3). */
function electronClipboard(): { writeText?: (t: string) => void; write?: (d: { text?: string; html?: string }) => void; readHTML?: () => string; readText?: () => string } | null {
  try {
    const req = (window as unknown as { require?: (m: string) => { clipboard?: unknown } }).require;
    return (req?.("electron")?.clipboard as ReturnType<typeof electronClipboard>) ?? null;
  } catch { return null; }
}

/** Read plain text from the OS clipboard, focus-independently where possible.
 *
 *  Prefers Electron's clipboard: it is synchronous and does NOT require the
 *  document to be focused. `navigator.clipboard.readText()` rejects outright with
 *  "document is not focused", which is why clipboard auto-prefill worked in some
 *  windows and silently never fired in others — including pop-outs and any window
 *  that wasn't the OS-focused one at that instant. Passing the window only
 *  affects the navigator fallback (mobile, where Electron isn't there).
 *
 *  Returns "" rather than throwing; callers treat empty as "nothing to paste".
 */
export async function readClipboardText(win?: Window | null): Promise<string> {
  const ec = electronClipboard();
  if (ec?.readText) {
    try {
      const t = ec.readText();
      if (typeof t === "string") return t;
    } catch { /* fall through to the navigator path */ }
  }
  const nav = win?.navigator ?? navigator;
  try { return (await nav.clipboard?.readText?.()) ?? ""; } catch { return ""; }
}

/** Write plain text + the hidden cross-vault payload to the OS clipboard.
 *  Returns false when neither clipboard API could take the dual payload
 *  (callers then fall back to their plain-text-only write). */
export async function writeXvClipboard(plainText: string, meta: XvMeta, zipBytes: Uint8Array): Promise<boolean> {
  const html = `<div ${ATTR_META}="${escapeHtml(JSON.stringify(meta))}" ${ATTR_ZIP}="${b64encode(zipBytes)}"><pre>${escapeHtml(plainText)}</pre></div>`;
  const ec = electronClipboard();
  if (ec?.write) {
    ec.write({ text: plainText, html });
    return true;
  }
  try {
    const item = new ClipboardItem({
      "text/plain": new Blob([plainText], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch { return false; }
}

/** Parse a cross-vault payload out of an HTML clipboard flavor. */
function parseXvHtml(html: string | null | undefined): { meta: XvMeta; zip: Uint8Array } | null {
  if (!html || !html.includes(ATTR_META)) return null;
  try {
    const metaM = html.match(new RegExp(`${ATTR_META}="([^"]+)"`));
    const zipM = html.match(new RegExp(`${ATTR_ZIP}="([A-Za-z0-9+/=]+)"`));
    if (!metaM || !zipM) return null;
    const decode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const meta = JSON.parse(decode(metaM[1])) as XvMeta;
    if (meta?.v !== 1 || (meta.mode !== "cut" && meta.mode !== "copy")) return null;
    return { meta, zip: b64decode(zipM[1]) };
  } catch { return null; }
}

/** Read the cross-vault payload off the OS clipboard, if present. */
export async function readXvPayload(): Promise<{ meta: XvMeta; zip: Uint8Array } | null> {
  const ec = electronClipboard();
  if (ec?.readHTML) return parseXvHtml(ec.readHTML());
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/html")) {
        return parseXvHtml(await (await item.getType("text/html")).text());
      }
    }
  } catch { /* focus-blocked or unavailable */ }
  return null;
}

/** Cheap synchronous probe: does the clipboard LOOK like it carries a payload?
 *  Used by the paste keybinding gate. Electron-only (navigator is async);
 *  returns false elsewhere, in which case the command-palette paste still
 *  reaches the full async read. */
export function hasXvPayload(): boolean {
  const ec = electronClipboard();
  if (!ec?.readHTML) return false;
  try { return (ec.readHTML() || "").includes(ATTR_META); } catch { return false; }
}

/** 0.201.1: destination side of the cut handshake — after a successful
 *  cross-vault CUT paste, replace the payload with a small ACK carrying the
 *  cut token + this vault's name. The plain-text flavor is preserved so a
 *  later paste into a normal app still gets the text. The SOURCE vault reads
 *  this on window focus and offers to delete the originals. */
export function writeXvAck(token: string, destVault: string): boolean {
  const ec = electronClipboard();
  if (!ec?.write || !ec.readText) return false;
  try {
    const text = ec.readText() ?? "";
    ec.write({ text, html: `<div ${ATTR_ACK}="${escapeHtml(token)}" ${ATTR_ACK_VAULT}="${escapeHtml(destVault)}"><pre>${escapeHtml(text)}</pre></div>` });
    return true;
  } catch { return false; }
}

/** Read a cut-paste ACK off the clipboard, if present. Sync (electron only —
 *  the focus-driven source-side check must not prompt for clipboard access). */
export function readXvAck(): { token: string; destVault: string } | null {
  const ec = electronClipboard();
  if (!ec?.readHTML) return null;
  try {
    const html = ec.readHTML() || "";
    if (!html.includes(ATTR_ACK)) return null;
    const t = html.match(new RegExp(`${ATTR_ACK}="([^"]+)"`));
    const v = html.match(new RegExp(`${ATTR_ACK_VAULT}="([^"]*)"`));
    if (!t) return null;
    const dec = (x: string): string => x.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return { token: dec(t[1]), destVault: dec(v?.[1] ?? "another vault") };
  } catch { return null; }
}
