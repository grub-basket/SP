/** File-type identity for attachments: a lucide icon, a colour, and a short
 *  label. Used by the note's attachment rail and the media viewer's rail so an
 *  un-thumbnailable file still reads at a glance.
 *
 *  Colours are deliberately hard-coded rather than themed. A file type's colour
 *  is an IDENTITY (PDF is red, spreadsheets are green) — the same association
 *  every OS and file manager uses. Mapping them onto theme variables would make
 *  a PDF and a zip the same colour in a monochrome theme, which is the one
 *  thing this is meant to prevent. They sit on a tinted background at low
 *  opacity, so they stay legible in both light and dark.
 */
export interface FileKind {
  /** Lucide icon name. */
  icon: string;
  /** Identity colour, used for the icon and a tint behind it. */
  color: string;
  /** Human label ("Spreadsheet"), for tooltips and the filename view. */
  label: string;
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff", "tif", "heic"]);
const VIDEO = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac", "opus", "aiff"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz", "stash"]);
const SHEET = new Set(["xlsx", "xls", "csv", "tsv", "numbers", "ods"]);
const SLIDES = new Set(["pptx", "ppt", "key", "odp"]);
const DOC = new Set(["docx", "doc", "rtf", "odt", "pages"]);
const TEXT = new Set(["md", "txt", "log", "text"]);
const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "yaml", "yml", "toml", "xml",
  "html", "css", "scss", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "sh",
  "swift", "kt", "php", "sql",
]);
const EBOOK = new Set(["epub", "mobi", "azw3"]);
const FONT = new Set(["ttf", "otf", "woff", "woff2"]);

const KINDS: Array<[Set<string>, FileKind]> = [
  [IMAGE, { icon: "image", color: "#2d8cf0", label: "Image" }],
  [VIDEO, { icon: "film", color: "#a855f7", label: "Video" }],
  [AUDIO, { icon: "music", color: "#ec4899", label: "Audio" }],
  [ARCHIVE, { icon: "archive", color: "#b45309", label: "Archive" }],
  [SHEET, { icon: "table", color: "#15803d", label: "Spreadsheet" }],
  [SLIDES, { icon: "presentation", color: "#ea580c", label: "Slides" }],
  [DOC, { icon: "file-text", color: "#1d4ed8", label: "Document" }],
  [TEXT, { icon: "file-text", color: "#64748b", label: "Text" }],
  [CODE, { icon: "code", color: "#0891b2", label: "Code" }],
  [EBOOK, { icon: "book", color: "#7c3aed", label: "E-book" }],
  [FONT, { icon: "type", color: "#475569", label: "Font" }],
];

const PDF: FileKind = { icon: "file-text", color: "#dc2626", label: "PDF" };
const UNKNOWN: FileKind = { icon: "file", color: "#6b7280", label: "File" };

export function fileKindFor(ext: string): FileKind {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  if (e === "pdf") return PDF;
  for (const [set, kind] of KINDS) if (set.has(e)) return kind;
  return UNKNOWN;
}

export function isImageExt(ext: string): boolean {
  return IMAGE.has((ext || "").toLowerCase().replace(/^\./, ""));
}

/** How the note's attachment rail lays itself out. */
export type RailMode = "thumbnail" | "compact" | "filename";

/** Choose a rail layout from what is actually being shown.
 *
 *  The rule is about READABILITY, not aesthetics:
 *  - A thumbnail only helps when the content is visual AND big enough to see.
 *    Below roughly 90px a photo is an unidentifiable smudge, so a wide rail of
 *    many images degrades to compact rather than to a row of smudges.
 *  - Files with no visual content (a zip, a spreadsheet) are identified by
 *    their NAME, so a set that is mostly non-images goes to the filename list
 *    where the name has room to be read.
 *  - Everything else gets thumbnails.
 *
 *  `availableWidth` is the rail's own width, not the window's — the rail is
 *  inside a note row that may itself be in a narrow sidebar.
 */
export function pickRailMode(
  count: number,
  imageCount: number,
  availableWidth: number,
): RailMode {
  if (count === 0) return "compact";
  const mostlyImages = imageCount / count >= 0.5;
  if (!mostlyImages) return "filename";
  // Width each thumbnail would get if they all sat in one row, including gaps.
  const per = availableWidth / count - 6;
  if (per < 90) return "compact";
  return "thumbnail";
}
