# Stashpad

A chat-style, nested-notes workspace for [Obsidian](https://obsidian.md). Type at
the bottom, your notes stack and nest, and you drill in and out of the tree, with
optional **Open Knowledge Format (OKF)** export so your notes can be shared with
LLMs and agents.

<!-- TODO: add a screenshot or short GIF here — e.g. ![Stashpad](docs/screenshot.png).
     A README with a visual converts far better than one without. -->

> ⚠️ **Alpha software.** Stashpad does a lot and is usable daily, but it's young.
> Keep backups of anything important.
>
> The project was designed and directed by its maintainer, but the **code was
> written by an AI assistant** — it is not hand-authored or human-reviewed.

## Install (via BRAT)

1. Install the **BRAT** community plugin in Obsidian.
2. In BRAT, choose "Add beta plugin" and paste: `https://github.com/grub-basket/SP`
3. Enable **Stashpad** in Community Plugins.

## Quick start

1. Open the command palette and run **"Reveal or open Stashpad"** (or click the
   ribbon icon). The first run creates a `Stashpad` folder.
2. **Type in the composer at the bottom and press Enter** to capture a note. It
   appears in the list above.
3. **Click a note (or press →)** to drill into it; new notes you add now nest under
   it. Press **←** or the back arrow to come back out.
4. Explore from there: search, move/clone, set colors, pin, make tasks, or turn on
   OKF (below) to export.

## What it does

- **Chat-style capture** — type at the bottom, hit Enter; Shift+Enter for newlines,
  with an optional split-on-newlines mode.
- **Outliner** — notes nest under notes, arbitrarily deep; drill in/out, focus any
  note as a temporary root.
- **Search** — fast all-tokens/any-order "Sift" search across one folder or every
  Stashpad in the vault.
- **Organize** — move/merge/clone/outdent, drag-and-drop re-parenting, manual order,
  per-note colors with friendly aliases, pinning, and cross-folder cut/copy/paste of
  whole subtrees (attachments included, fully undoable).
- **Tasks** — turn a note into a to-do, set due dates, get reminders.
- **Tiny mode** — pop Stashpad into a small, pinnable, opacity-adjustable window for
  quick capture while you work elsewhere.
- **Folder panel** — sidebar of your Stashpad folders and pinned notes/folders.
- **Import / export** — `.stash` bundles (optionally encrypted) round-trip notes +
  attachments; dropped files auto-import.
- **Authorship / multiplayer** — stamp notes with your name; shared vaults track
  contributors, with a vault-wide author registry.
- **Johnny.Decimal index** — build a JD-style hierarchy from dotted-prefix titles.

## Open Knowledge Format (OKF)

[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) is
Google's open, vendor-neutral spec for packaging curated knowledge as Markdown that
LLMs and agents can read. Stashpad already stores notes as Markdown with frontmatter
and a real hierarchy, so it can produce OKF bundles for you:

- Turn OKF on, then opt **per folder** by assigning the auto-created template.
- Each OKF folder gets complementary `okf*` frontmatter and a generated `index.md`;
  your own fields and links are never renamed or removed.
- **Export as OKF** to `.zip` / `.tar.gz` (portable bundles) or `.stash`. On export,
  the `okf*` fields are mapped to OKF's standard keys (`type` / `title` / etc.) and
  the hierarchy becomes relative-Markdown links, so the bundle is spec-compliant while
  the originals are kept for lossless re-import.

See [`docs/okf-guide.md`](docs/okf-guide.md) for a from-scratch walkthrough.

## Encryption (optional, beta)

Stashpad can lock notes/folders into encrypted `.stashenc` files, with archive folders,
encrypted trash, and shared-key collaboration.

> 🔒 **Please read:** the encryption was written by an AI assistant and has **not**
> been human-audited or security-tested. Treat it as a best-effort way to deter a
> casual snoop, **not** a guarantee. Don't rely on it for anything sensitive, and keep
> unencrypted backups. It's optional and off by default.

## Feedback

Bug reports and "this felt weird" notes are very welcome via the repo's Issues.

## Credits & thanks

Stashpad is a homage to **Stashpad Notes**, a lovely app discontinued in 2024. This
plugin brings its chat-style, jot-it-down feeling into Obsidian. Sincere thanks to
its founders, **Cara and Theo**, for the original that inspired it.

## License

[MIT](LICENSE) © grub-basket.
