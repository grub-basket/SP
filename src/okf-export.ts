import type { App, TFile } from "obsidian";
import { splitFrontmatter } from "./stash-package";
import { okfTitleFromFile, buildOkfIndex, OKF_LEGEND } from "./okf";

/** OKF export (Phase 4): turn an exported subtree into an OKF BUNDLE — concept
 *  markdown files whose frontmatter carries the bare OKF spec keys
 *  (`type`/`title`/`description`/`tags`/`timestamp`) mapped from our `okf*` fields,
 *  while KEEPING `id`/`okf*` redundantly so the bundle re-imports into Stashpad
 *  losslessly — plus a scope-adjusted `index.md`, a `_okf.md` legend, and the
 *  referenced attachments. Packaged as .zip and/or .tar.gz (fflate for zip,
 *  a tiny tar writer + the platform `CompressionStream` for .tar.gz). The
 *  Stashpad-native `.stash` remains a separate option. */

export interface BundleFile { name: string; data: Uint8Array; }

const te = new TextEncoder();
const enc = (s: string): Uint8Array => te.encode(s);

/** Minimal YAML scalar: quote when it has YAML-significant chars (the okf link
 *  values contain []() etc.). */
function yamlScalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v ?? "");
  return /[:#[\]{}",&*!|>%@`]|^\s|\s$|^$/.test(s) ? JSON.stringify(s) : s;
}

/** Inject the OKF spec keys at the TOP of a note's frontmatter, mapped from its
 *  `okf*` fields, keeping the rest of the frontmatter verbatim (so id/parent/okf*
 *  survive for a lossless Stashpad re-import). */
function toConceptMarkdown(raw: string, file: TFile): string {
  const { fm } = splitFrontmatter(raw);
  const lines: string[] = [];
  lines.push(`type: ${yamlScalar(typeof fm.okfType === "string" && fm.okfType ? fm.okfType : "concept")}`);
  lines.push(`title: ${yamlScalar(typeof fm.okfTitle === "string" && fm.okfTitle ? fm.okfTitle : okfTitleFromFile(file))}`);
  if (typeof fm.okfDescription === "string" && fm.okfDescription) lines.push(`description: ${yamlScalar(fm.okfDescription)}`);
  const tags = fm.okfTags;
  if (Array.isArray(tags) && tags.length) { lines.push("tags:"); for (const t of tags) lines.push(`  - ${yamlScalar(t)}`); }
  const ts = (typeof fm.okfTimestamp === "string" && fm.okfTimestamp) || (typeof fm.modified === "string" && fm.modified) || (typeof fm.created === "string" && fm.created) || "";
  if (ts) lines.push(`timestamp: ${yamlScalar(ts)}`);
  const block = lines.join("\n");
  const m = raw.match(/^---\r?\n/);
  if (m) return raw.slice(0, m[0].length) + block + "\n" + raw.slice(m[0].length);
  return `---\n${block}\n---\n${raw}`; // note had no frontmatter
}

/** Build the OKF bundle's files for an exported subtree (within `folder`). */
export async function buildOkfBundleFiles(
  app: App, files: TFile[], folder: string, scopeIds: Set<string>,
): Promise<BundleFile[]> {
  const out: BundleFile[] = [];
  const attachments = new Map<string, TFile>(); // basename -> file (dedup)
  for (const f of files) {
    const raw = await app.vault.read(f);
    out.push({ name: f.name, data: enc(toConceptMarkdown(raw, f)) });
    // Collect referenced attachments (resolved against this note's path).
    for (const ref of raw.match(/!\[\[([^\]]+?)\]\]/g) ?? []) {
      const inner = ref.slice(3, -2).split("|")[0].split("#")[0].trim();
      const af = app.metadataCache.getFirstLinkpathDest(inner, f.path);
      if (af && !attachments.has(af.name)) attachments.set(af.name, af);
    }
  }
  for (const [name, af] of attachments) {
    out.push({ name: `_attachments/${name}`, data: new Uint8Array(await app.vault.readBinary(af)) });
  }
  out.push({ name: "index.md", data: enc(await buildOkfIndex(app, folder, scopeIds)) });
  out.push({ name: "_okf.md", data: enc(`# About this bundle\n\n${OKF_LEGEND.replace(/^> /gm, "")}\n`) });
  return out;
}

/** Zip the bundle (fflate, dependency-free). */
export async function zipBundle(files: BundleFile[]): Promise<Uint8Array> {
  const { zipFiles } = await import("./zip");
  return zipFiles(files.map((f) => ({ name: f.name, data: f.data })));
}

// ---- minimal tar (ustar) + gzip, no dependency ----
function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}
function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => { const b = enc(s); h.set(b.subarray(0, len), off); };
  put(name.slice(0, 100), 0, 100);
  put(octal(0o644, 8), 100, 8);   // mode
  put(octal(0, 8), 108, 8);       // uid
  put(octal(0, 8), 116, 8);       // gid
  put(octal(size, 12), 124, 12);  // size
  put(octal(0, 12), 136, 12);     // mtime (0 — deterministic; Date.* is unavailable here anyway)
  put("        ", 148, 8);        // checksum placeholder (spaces)
  h[156] = 0x30;                  // typeflag '0' (normal file)
  put("ustar\0", 257, 6); put("00", 263, 2);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  put(octal(sum, 8), 148, 8);
  return h;
}
function buildTar(files: BundleFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const f of files) {
    const header = tarHeader(f.name, f.data.length);
    parts.push(header, f.data);
    total += 512 + f.data.length;
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) { parts.push(new Uint8Array(pad)); total += pad; }
  }
  parts.push(new Uint8Array(1024)); total += 1024; // two zero blocks = EOF
  const tar = new Uint8Array(total);
  let off = 0; for (const p of parts) { tar.set(p, off); off += p.length; }
  return tar;
}
async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Response(data as unknown as ArrayBuffer).body!.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** Tar + gzip the bundle (no dependency). */
export async function tarGzBundle(files: BundleFile[]): Promise<Uint8Array> {
  return gzip(buildTar(files));
}
