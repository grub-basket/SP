#!/usr/bin/env node
/** Unit tests for the link-preview pure functions.
 *
 *  Stashpad has no test framework and isn't getting one for this — but the
 *  parser is the one part of the feature that is pure, total, and full of
 *  real-world edge cases (attribute order, entity double-decoding, malformed
 *  JSON-LD), so it is worth pinning. Bundles the TS itself with a stubbed
 *  `obsidian` so it runs with plain `node`.
 *
 *  Usage: node scripts/test-link-preview.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sp-lp-"));
const stub = join(dir, "obsidian.mjs");
writeFileSync(stub, [
  "export function requestUrl(){ throw new Error('stub'); }",
  "export function setIcon(){}",
  "export const Platform = { isMobile: false };",
].join("\n") + "\n");
// One entry point re-exporting both modules — esbuild refuses --outfile with
// multiple inputs, and a single bundle keeps the import below simple.
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * from ${JSON.stringify(resolve("src/link-preview/parse-og.ts"))};`,
  `export * from ${JSON.stringify(resolve("src/link-preview/fetch.ts"))};`,
  `export * from ${JSON.stringify(resolve("src/link-preview/store.ts"))};`,
  `export * from ${JSON.stringify(resolve("src/paste-path.ts"))};`,
  `export * from ${JSON.stringify(resolve("src/obscure-scope.ts"))};`,
  `export { bodyToSlug, classifyReferenceOnly } from ${JSON.stringify(resolve("src/slug-service.ts"))};`,
].join("\n"));
const bundle = join(dir, "lp.mjs");
execFileSync("npx", ["esbuild", entry,
  "--bundle", "--format=esm", "--log-level=error",
  `--alias:obsidian=${stub}`, `--outfile=${bundle}`,
], { stdio: "inherit" });

const {
  extractLinkMeta, parseMetaTags, parseJsonLd, urlKey, isFetchableUrl,
  extractUrls, existingPreviewKeys, renderPreviewCallout, appendPreviews, previewMarker, replacePreview,
  normalisePastedPath, resolveObscureAll, bodyToSlug, classifyReferenceOnly,
} = await import(bundle);

let pass = 0, fail = 0;
const t = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

// --- parsing: shapes that actually occur in the wild ---
t("attributes in reverse order",
  parseMetaTags(`<meta content="Hello" property="og:title">`).get("og:title"), "Hello");
t("single quotes + extra attributes",
  parseMetaTags(`<meta data-x='1' name='twitter:title' content='Tw'>`).get("twitter:title"), "Tw");
t("entities, incl. the double-decode trap",
  extractLinkMeta("u", `<meta property="og:title" content="Tom &amp; Jerry &#39;96 &amp;lt;tag&amp;gt;">`).title,
  "Tom & Jerry '96 &lt;tag&gt;");
t("multiline content attribute",
  extractLinkMeta("u", `<meta property="og:description" content="line one\nline two">`).description,
  "line one line two");
t("first value wins on duplicates",
  extractLinkMeta("u", `<meta property="og:image" content="a.png"><meta property="og:image" content="b.png">`).imageUrl,
  "a.png");
t("<title> fallback", extractLinkMeta("u", `<title>  Plain\n  Title </title>`).title, "Plain Title");
t("canonical link", extractLinkMeta("u", `<link rel="canonical" href="https://x.test/real">`).canonicalUrl, "https://x.test/real");
t("empty document", extractLinkMeta("u", "").title, undefined);

// --- JSON-LD ---
t("@graph unwrapping",
  parseJsonLd(`<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Article","description":"D"}]}</script>`)?.description, "D");
t("malformed JSON-LD must not break extraction",
  extractLinkMeta("u", `<script type="application/ld+json">{ not json </script><meta property="og:title" content="Survived">`).title,
  "Survived");
t("author as a JSON-LD object",
  extractLinkMeta("u", `<script type="application/ld+json">{"name":"n","author":{"@type":"Person","name":"Ada"}}</script>`).author, "Ada");

// --- per-field precedence: the reason `via` exists ---
{
  const m = extractLinkMeta("u", `<meta property="og:title" content="T">
    <script type="application/ld+json">{"@type":"Article","description":"Full body text"}</script>`);
  t("mixed sources: title from og", m.title, "T");
  t("mixed sources: description from JSON-LD", m.description, "Full body text");
  t("mixed sources: via reports 'mixed'", m.via, "mixed");
}

// --- url keying: same page must not fork the cache ---
t("utm_ stripped", urlKey("https://x.test/a?utm_source=tw&b=1"), urlKey("https://x.test/a?b=1"));
t("fragment ignored", urlKey("https://x.test/a#top"), urlKey("https://x.test/a"));
t("parameter order irrelevant", urlKey("https://x.test/a?b=1&c=2"), urlKey("https://x.test/a?c=2&b=1"));
t("host case-insensitive", urlKey("https://X.TEST/a"), urlKey("https://x.test/a"));
t("but ?v= stays identity-bearing",
  urlKey("https://youtube.com/watch?v=aaa") !== urlKey("https://youtube.com/watch?v=bbb"), true);

// --- protocol guard: these must never be dereferenced ---
t("rejects file:", isFetchableUrl("file:///etc/passwd"), false);
t("rejects javascript:", isFetchableUrl("javascript:alert(1)"), false);
t("rejects obsidian:", isFetchableUrl("obsidian://open?vault=x"), false);
t("rejects garbage", isFetchableUrl("not a url"), false);
t("accepts https", isFetchableUrl("https://x.test"), true);

// --- URL extraction from note bodies ---
t("bare url", extractUrls("see https://x.test/a for more"), ["https://x.test/a"]);
t("trailing full stop excluded", extractUrls("go to https://x.test/a."), ["https://x.test/a"]);
t("markdown link", extractUrls("[label](https://x.test/a)"), ["https://x.test/a"]);
t("deduped by cache key",
  extractUrls("https://x.test/a?utm_source=x and https://x.test/a"), ["https://x.test/a?utm_source=x"]);
t("ignores non-http", extractUrls("obsidian://open and file:///tmp/x"), []);

// THE trap: enriching twice must not preview its own output
{
  const entry = { v: 1, url: "https://x.test/a", fetchedAt: "2026-08-09T00:00:00Z", ok: true,
                  meta: { url: "https://x.test/a", title: "T", description: "D", via: "opengraph" } };
  const body = appendPreviews("note text https://x.test/a", [
    { url: "https://x.test/a", markdown: renderPreviewCallout(entry) }]);
  t("callout contains the marker", /sp:link-preview/.test(body), true);
  t("urls inside our callout are skipped", extractUrls(body), ["https://x.test/a"]);
  t("second append is a no-op",
    appendPreviews(body, [{ url: "https://x.test/a", markdown: renderPreviewCallout(entry) }]), body);
  t("marker key recognised", existingPreviewKeys(body).has(urlKey("https://x.test/a")), true);
}

// --- callout rendering ---
{
  const entry = { v: 1, url: "https://x.test/a", fetchedAt: "z", ok: true,
                  meta: { url: "https://x.test/a", title: "T", description: "line one\n\nline two", via: "opengraph" } };
  const md = renderPreviewCallout(entry);
  t("every line is quote-prefixed", md.split("\n").every((l) => l.startsWith(">")), true);
  // EXPANDED by default: `-` renders the content with display:none, which hid
  // the description entirely — the thing the feature exists to capture.
  t("expanded by default", md.startsWith("> [!info]+"), true);
  t("collapsed is opt-in",
    renderPreviewCallout(entry, { collapsed: true }).startsWith("> [!info]-"), true);
}
t("failure renders a block too",
  renderPreviewCallout({ v: 1, url: "https://x.test/a", fetchedAt: "z", ok: false, reason: "HTTP 404" })
    .includes("HTTP 404"), true);

// --- refresh replaces IN PLACE, and only the right block ---
{
  const mk = (u, title) => ({ v: 1, url: u, fetchedAt: "z", ok: true,
    meta: { url: u, title, description: "d", via: "opengraph" } });
  const A = "https://a.test/1", B = "https://b.test/2";
  let body = "intro\n";
  body = appendPreviews(body, [{ url: A, markdown: renderPreviewCallout(mk(A, "A old")) }]);
  body = body + "\nuser's own text between the previews\n\n";
  body = appendPreviews(body, [{ url: B, markdown: renderPreviewCallout(mk(B, "B keep")) }]);

  const after = replacePreview(body, A, renderPreviewCallout(mk(A, "A NEW")));
  t("replaced the target block", after.includes("A NEW"), true);
  t("old content gone", after.includes("A old"), false);
  t("neighbouring preview untouched", after.includes("B keep"), true);
  t("user text between previews survives", after.includes("user's own text between the previews"), true);
  t("intro survives", after.startsWith("intro"), true);
  t("still exactly two markers", (after.match(/sp:link-preview/g) || []).length, 2);
  t("no-op when the url has no block", replacePreview(after, "https://c.test/3", "X"), after);
}

// --- pasted paths: the shapes a real copy/paste actually produces ---
t("plain path", normalisePastedPath("/Users/you/Downloads/a.pdf"), "/Users/you/Downloads/a.pdf");
t("surrounding whitespace", normalisePastedPath("  /tmp/a.pdf \n"), "/tmp/a.pdf");
t("double quoted", normalisePastedPath('"/tmp/my file.pdf"'), "/tmp/my file.pdf");
t("single quoted", normalisePastedPath("'/tmp/my file.pdf'"), "/tmp/my file.pdf");
t("shell-escaped spaces", normalisePastedPath("/tmp/my\\ file\\ v2.pdf"), "/tmp/my file v2.pdf");
t("shell-escaped parens", normalisePastedPath("/tmp/report\\ \\(final\\).pdf"), "/tmp/report (final).pdf");
t("file:// URL", normalisePastedPath("file:///tmp/a%20b.pdf"), "/tmp/a b.pdf");
t("backslash before a normal char is kept",
  normalisePastedPath("/tmp/a\\bc.pdf"), "/tmp/a\\bc.pdf");

// --- resolveObscureAll -----------------------------------------------------
// The FALLBACK is the point of these: getting it wrong uncovers notes the user
// had covered, which is the one failure mode a privacy control must not have.
t("synced scope follows the synced value", resolveObscureAll("synced", true, null), true);
t("synced scope ignores a local value", resolveObscureAll("synced", false, true), false);
t("device scope uses this device's answer", resolveObscureAll("device", false, true), true);
t("device scope can differ from synced", resolveObscureAll("device", true, false), false);
t("device with NO local answer inherits covered — never uncovers", resolveObscureAll("device", true, null), true);
t("device with no local answer and nothing synced stays off", resolveObscureAll("device", false, null), false);

// --- titles for notes that are nothing but a reference ---------------------
// These notes are created BY attaching or pasting, so they have no prose to
// borrow a name from. They used to all land on "Untitled", which is useless
// and collides.
t("embed names the file and its type", bodyToSlug("![[holiday-photo.png]]"), "Attachment-PNG-Holiday-Photo");
t("embed with a size still names the file", bodyToSlug("![[report.pdf|300]]"), "Attachment-PDF-Report");
t("markdown image is an attachment too", bodyToSlug("![alt](diagrams/system-map.svg)"), "Attachment-SVG-System-Map");
t("obsidian deep link", bodyToSlug("obsidian://open?vault=x&file=Some%20Note"), "Deeplink-Open");
t("wikilink uses its alias", bodyToSlug("[[Projects/Q3 Report|Quarterly numbers]]"), "Link-Quarterly-Numbers");
t("wikilink without an alias uses the leaf", bodyToSlug("[[Projects/Q3 Report]]"), "Link-Q3-Report");
t("bare url", bodyToSlug("https://example.com/posts/why-rust-is-fast"), "Link-Why-Rust-Fast");

// TEXT WINS. A note that says something is named after what it says, whether
// or not a link sits next to it — this is the override that matters most.
t("text beside a link wins", bodyToSlug("Notes from the vendor call https://example.com/x"),
  "Notes-Vendor-Call-URL");
t("text after an embed wins", bodyToSlug("![[chart.png]] revenue is up in Q3"), "Revenue-Up-Q3");
t("plain prose is untouched", bodyToSlug("Buy milk on the way home"), "Buy-Milk-Way-Home");
t("a genuinely empty note is still Untitled", bodyToSlug("   "), "Untitled");

// The classifier itself, since the kind drives the prefix.
t("classify embed", classifyReferenceOnly("![[a/b/file.png]]"), { kind: "Attachment", label: "file", ext: "PNG" });
t("classify deeplink", classifyReferenceOnly("stashpad://note/abc"), { kind: "Deeplink", label: "abc", ext: "" });
t("prose is not a reference", classifyReferenceOnly("just some words"), null);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
