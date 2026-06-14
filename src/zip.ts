/** Tiny zip read/write wrapper over `fflate`.
 *
 *  Stashpad previously used JSZip for `.stash`, OKF `.zip`, and the encrypted
 *  rawtrash blob. JSZip pulls in legacy Promise/microtask polyfills (`lie`,
 *  `immediate`, `setimmediate`) whose IE-era code creates `<script>` elements
 *  for `onreadystatechange` scheduling. Those branches are dead in Electron
 *  (it has `setImmediate`/`MessageChannel`), but Obsidian's plugin-store
 *  scanner flags the *pattern* as "dynamic script injection / code obfuscation."
 *  `fflate` is dependency-free with no DOM polyfills, so the flagged code is
 *  gone at the root. We deliberately use fflate's SYNCHRONOUS APIs
 *  (`zipSync`/`unzipSync`): the async ones spawn a Web Worker from a
 *  `Blob(["…"], {type:"text/javascript"})` URL — another dynamic-code-execution
 *  pattern the scanner could flag — whereas the sync path runs on the main
 *  thread and lets esbuild tree-shake the worker code out entirely. Our
 *  payloads (notes + attachments) are modest, so main-thread cost is fine.
 *  (community-review-fixes)
 *
 *  Callers own path sanitization on read — `unzipFiles` returns entry names
 *  verbatim (with slashes intact) so each caller can apply the right zip-slip
 *  defense: `safeZipEntryName` (flatten) for `.stash`, `safeTrashRelPath`
 *  (preserve nested dirs) for rawtrash. */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export interface ZipEntry {
  name: string;
  data: Uint8Array | ArrayBuffer | string;
}

type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function toU8(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === "string") return strToU8(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** Build a DEFLATE-compressed zip. Names may contain `/` to nest entries. */
export function zipFiles(entries: ZipEntry[], level: ZipLevel = 6): Promise<Uint8Array> {
  const tree: Zippable = {};
  for (const e of entries) tree[e.name] = [toU8(e.data), { level }];
  return Promise.resolve(zipSync(tree, { level }));
}

/** Decode unzipped entry bytes as UTF-8 text. */
export function bytesToStr(b: Uint8Array): string {
  return strFromU8(b);
}

/** Unzip into a `{ fullEntryName: bytes }` map. Directory entries are omitted
 *  by fflate; names are returned verbatim (slashes intact) — sanitize per call site. */
export function unzipFiles(buf: Uint8Array | ArrayBuffer): Promise<Record<string, Uint8Array>> {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Promise.resolve(unzipSync(u8));
}
