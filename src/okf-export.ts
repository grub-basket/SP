import { TFile } from "obsidian";
import type { App } from "obsidian";
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
  const attachments = new Map<string, TFile>(); // BUNDLE name -> file (dedup)
  // 0.211.8: identity is the vault PATH, not the basename — same fix as the .stash
  // exporter (F2). Two attachments named diagram.png in different folders otherwise
  // collapse into one bundle entry and both notes point at whichever won.
  const attBundleName = new Map<string, string>();
  const takenAttNames = new Set<string>();
  const nameFor = (af: TFile): string => {
    const existing = attBundleName.get(af.path);
    if (existing) return existing;
    let name = af.name;
    const dot = af.name.lastIndexOf(".");
    for (let i = 2; takenAttNames.has(name); i++) {
      name = dot > 0 ? `${af.name.slice(0, dot)}-${i}${af.name.slice(dot)}` : `${af.name}-${i}`;
    }
    takenAttNames.add(name);
    attBundleName.set(af.path, name);
    return name;
  };
  // `[^[\]]` rather than `[^\]]` — bounds each attempt at the next bracket so a run of
  // unterminated `![[` can't be rescanned quadratically (the F1 fix, applied here too).
  const EMBED_RE = /!\[\[([^[\]]+?)\]\]/g;
  for (const f of files) {
    const raw = await app.vault.read(f);
    // 0.211.8: rewrite embeds to RELATIVE MARKDOWN links pointing into `_attachments/`.
    // The bundle carried the attachment bytes but left `![[some/vault/path.png]]`
    // untouched, so nothing outside the source vault could resolve them — the
    // attachments were exported but unusable, and OKF consumers expect relative
    // markdown links, not Obsidian wikilinks. Resolution is synchronous
    // (getFirstLinkpathDest), so this fits in a plain replace.
    const rewritten = raw.replace(EMBED_RE, (m: string, innerRaw: string) => {
      const parts = String(innerRaw).split("|");
      const alias = parts.length > 1 ? parts.slice(1).join("|").trim() : "";
      const inner = parts[0].split("#")[0].trim();
      // 0.209.0: same defensive fallback as the .stash exporter — see the longer
      // note there. Measured, getFirstLinkpathDest already handles full paths;
      // this only covers a not-yet-indexed file.
      // Narrow: getAbstractFileByPath can return a folder.
      const byPath = app.vault.getAbstractFileByPath(inner);
      const af = app.metadataCache.getFirstLinkpathDest(inner, f.path)
        ?? (byPath instanceof TFile ? byPath : null);
      if (!af) return m; // unresolved — leave the original text rather than a dead link
      const bn = nameFor(af);
      attachments.set(bn, af);
      return `![${alias || af.name}](_attachments/${encodeURI(bn)})`;
    });
    out.push({ name: f.name, data: enc(toConceptMarkdown(rewritten, f)) });
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
/** 0.211.8: truncate to at most `max` UTF-8 BYTES without splitting a codepoint.
 *  `name.slice(0, 100)` counted JS characters, so any non-ASCII name (an accent, CJK,
 *  an emoji) encoded to more than 100 bytes and `put`'s `subarray(0, len)` then cut it
 *  mid-sequence — writing a tar header with an invalid filename that extractors show
 *  as mojibake or reject. Back off over continuation bytes (10xxxxxx) so the kept
 *  prefix is always whole. */
function truncUtf8(s: string, max: number): string {
  const b = enc(s);
  if (b.length <= max) return s;
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(b.subarray(0, end));
}
function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => { const b = enc(s); h.set(b.subarray(0, len), off); };
  put(truncUtf8(name, 100), 0, 100);
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
