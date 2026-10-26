# Stashpad

Stashpad is a capture-first, chat-style notes workspace for [Obsidian](https://obsidian.md).
You type at the bottom and press Enter. Your notes stack newest-first, nest under each
other, and turn into an outline you can drill through. You never have to invent a
filename or pick a folder first, so you can jot something down and keep moving.

It works like a running conversation with yourself that sorts itself into a tree: a
scratchpad, an outliner and a task list in one panel.

> **Alpha software.** Stashpad does a lot and works for daily use, but it's young. Keep
> backups of anything important.
>
> Its maintainer designs and directs it, but an **AI assistant writes the code**. Nobody
> hand-writes or reviews it line by line. The upside is speed: Stashpad is **actively
> maintained and changes quickly**, and bug reports get read and acted on. If something
> breaks or feels off, [open an issue on GitHub](https://github.com/grub-basket/SP/issues).

## Install

Stashpad is in the [Obsidian community store](https://community.obsidian.md/plugins/stashpad).
It needs Obsidian **1.13.0 or later**, on desktop or mobile.

1. Open **Settings → Community plugins → Browse** and search for **Stashpad**, or go to
   the [Stashpad store page](https://community.obsidian.md/plugins/stashpad).
2. Install it, then turn on **Stashpad**.

You can also install it with [BRAT](https://obsidian.md/plugins?id=obsidian42-brat)
([BRAT on GitHub](https://github.com/TfTHacker/obsidian42-brat)). Choose "Add beta plugin"
and paste `https://github.com/grub-basket/SP`. BRAT lets you pin a specific version, which
helps when you want to downgrade or get a fix before it reaches the store.

## Quick start

1. Open the command palette and run **"Reveal or open Stashpad"**, or click the ribbon
   icon. The first run creates a `Stashpad` folder.
2. **Type in the composer at the bottom of the panel and press Enter** to capture a note.
   It appears in the list above the composer.
3. **Double-click a note, or press →,** to drill into it. Notes you add now nest under it.
   A single click only selects a note, so you can act on notes without moving. Press
   **←** or the back arrow to come back out.
4. From there you can search, move or clone notes, set colors, pin them, or turn a note
   into a task with a due date and reminder.

## Capture first, organize later

The composer pinned to the bottom of the panel is the core of Stashpad. You type, press
Enter, and the note lands in the list. There's no dialog, filename or folder to choose.
It's how a messaging app works, applied to notes. Writing something down costs almost
nothing, so you actually do it.

Shift+Enter adds a new line for a longer thought. An optional split-on-newlines mode
turns one burst of typing into several separate notes. Pasting formatted text from a web
page, a document or a chat keeps its formatting as Markdown, and pasting cells from a
spreadsheet gives you a Markdown table instead of a picture.

Everything you capture is an ordinary Markdown file with frontmatter. Nothing is in a
proprietary format, so the rest of Obsidian can read it, and so can you in ten years.

## An outliner that nests as deep as you like

Notes don't have to stay a flat feed. Double-click a note, or press →, to drill into it,
and whatever you capture next nests underneath, as deep as you want. Press ← to climb
back out. Any note can become a temporary root, so you can work inside one branch without
the rest of the tree in the way. If you'd rather see everything in one stream, there's a
flat view mode too.

Structure grows out of fast capture instead of being planned up front. Put thoughts in as
they come, then promote, demote and rearrange them into an outline later. Or never, if the
newest-first stack is all you need.

## Tasks and reminders

One keystroke turns any note into a to-do with a checkbox you can tick right in the list.
Give it a due date and Stashpad reminds you when it's due. Clicking the reminder takes you
to the task, or you can snooze it. You can type the due date in words, like "tomorrow
3pm". Tasks can have assignees, and a tasks panel gathers everything that's still open,
so your notes and your to-dos live in the same place.

> **Recurring tasks are experimental.** Repeat rules (daily, chosen days of the week or
> month, repeat on completion) work, but they haven't been tested much across time zones,
> missed occurrences and syncing between devices. **Don't rely on them for anything with
> real consequences.** Keep a reminder you trust for deadlines that matter. A one-off due
> date and reminder is the well-tested path.

## Focus on today's tasks

The Focus view is a short list for today. Run **"Open Focus view"** from the command
palette, add tasks from any Stashpad folder, and work through them in order. Each task has
a play button for a stopwatch or pomodoro timer, and the time you spend is saved in the
note's frontmatter. "One at a time" mode shows only the current task with **Done & next**
and **Skip** buttons. Unfinished tasks from earlier days show up in a banner so you can
move them to today or clear them.

## Find anything fast

Search uses **Sift**, which matches every word you type, in any order, ignoring case. So
"budget q3" finds "Q3 budget review" even if you don't remember the exact wording. You can
search one Stashpad folder or every Stashpad in the vault at once, and narrow the results
with filters such as color or whether a task is done.

## Organize without friction

When you do want to tidy up, you can move, merge, clone and outdent notes, re-parent them
by drag and drop, and put them in any order you like. Each note can have a **color**, and
you can give colors friendly names, so `#ffe243` becomes "boogers". Pin the notes and
folders you come back to. You can cut, copy and paste whole subtrees, attachments
included, between folders. Every structural change can be undone, so reorganizing is
never risky.

Folders are easy to reshape too. If you made a small Stashpad folder in a hurry, **"Fold
(merge) this folder into another folder…"** moves all of it into a bigger one, and you can
unfold it again later. Going the other way, **"Split out into its own folder…"** turns one
note and everything under it into a Stashpad folder of its own.

## Showcase: review a level as a page

Showcase shows one level of notes as a single page, with every image and PDF at full size.
It's built for reviewing visual work, such as a brochure or a set of designs. Run **"Open
showcase (page view with feedback) for this level"** from the command palette. When a
section has several files, you can view them as options (A, B, C) side by side or stacked,
and mark each one as selected or rejected. To leave feedback, click a spot on an image or
PDF page, or drag a box or an arrow around the part you mean. Every comment is saved as an
ordinary Stashpad note.

## Tiny mode

Run **"Open Stashpad in tiny window"** to pop Stashpad out into a small window that stays
on top of other apps. You can adjust its opacity and pin it to a corner of the screen.
It's for catching a stray thought while you work in another app: jot it down and get back
to what you were doing.

## Attachments and copying out

Drop files onto the panel and Stashpad imports them as attachments. When you want notes
out of Stashpad, you can copy them three ways:

- As a checklist. Tasks become real `- [ ]` and `- [x]` checkboxes, and colors and their
  names come along.
- As an indented outline.
- As `![[embed]]` links you can put in any regular Obsidian note.

## Other features

These extras aren't the main point of Stashpad. They're there when you need them and out
of the way when you don't.

- **Import and export.** `.stash` bundles, optionally encrypted, carry notes and their
  attachments between vaults.
- **Encryption (beta).** Lock notes or folders into encrypted `.stashenc` files, with
  archive folders, encrypted trash and shared-key collaboration. Because it's beta, you
  can lose data whether or not you have your key. Read the
  [notes on encryption](#before-you-encrypt-anything) first.
- **Authors and shared vaults.** Stamp notes with your name. In a shared vault, a
  vault-wide author registry tracks who contributed. AI assistants such as Claude or
  ChatGPT can be listed as authors too.
- **Johnny.Decimal index.** Build a Johnny.Decimal-style hierarchy from titles that start
  with dotted number prefixes.
- **Open Knowledge Format (OKF) export.** Turn this on for a folder to export it as an
  [Open Knowledge Format bundle](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
  (`.zip`, `.tar.gz` or `.stash`). OKF is Google's vendor-neutral Markdown format for
  handing curated knowledge to large language models (LLMs) and agents. The
  [OKF export guide](docs/okf-guide.md) explains how it works.

### Before you encrypt anything

**Save your folder password in a password manager first.** "Remember on this device
(keychain)" is a convenience, **not a backup**. An operating system or keychain reset, a
wiped or restored profile, a reinstall, a new machine or an IT change can erase it at any
time without warning. If the keychain held the only copy of your password, everything
encrypted with it is permanently unreadable, by you, by us or by anyone.

A **recovery password** adds a second way in, but it only helps if you keep it somewhere
separate from the main one. Two entries in the same password manager disappear together
if you lose that manager. Do set one for **shared** folders: it still works after a
collaborator changes the main password.

An AI assistant also wrote the encryption, and nobody has audited or security-tested it.
Treat it as a way to keep casual snoops out, **not** as a guarantee. Don't rely on it for
anything sensitive, and keep unencrypted backups. It's optional and off by default.

Because it's beta, **you can lose data even when your key is safe.** A bug, an
interrupted lock or unlock, or a sync that writes to the vault partway through can damage
encrypted files even when your password is fine. Keep unencrypted backups.

**Plaintext copies can stay behind elsewhere.** Encryption locks a note's file on disk.
It does **not** keep the note decrypted only in memory, the way apps such as Standard
Notes do. While a note is plaintext, before you lock it or after you unlock it, other
software may keep plaintext copies that Stashpad can't reach:

- Obsidian's File Recovery snapshots and Sync version history
- other plugins' sidecar files, such as the Edit History plugin's `.edtz` files
- operating system backups, such as Time Machine

Encrypting a note doesn't remove those copies after the fact. Think of encryption as
protecting a locked note from then on, not as proof that no plaintext copy ever existed.

*No warranty of any kind. This encryption has never been audited, so nothing shows that
it protects anything. Stashpad can't recover keys or passwords, and isn't liable for lost
keys, passwords or data, for a fault in this beta encryption, or for any harm that follows
if it fails to keep your data private. Keeping your own backups, and deciding what is safe
to trust it with, are up to you.*

## Feedback

Report anything buggy or strange on the [Stashpad issues page](https://github.com/grub-basket/SP/issues).

## Credits and thanks

Stashpad is a homage to **Stashpad Notes**, a lovely app that shut down in 2024. This
plugin brings its chat-style, jot-it-down feel into Obsidian. Sincere thanks to its
founders, **Cara and Theo, and the rest of the Stashpad team**, for the original that
inspired it.

Pasting a range of cells from Excel, Google Sheets, Numbers or LibreOffice gives you a
clean Markdown table. That conversion is adapted from the
[Excel to Markdown Table plugin](https://github.com/ganesshkumar/obsidian-excel-to-markdown-table)
by **Ganessh Kumar R P** (MIT), including the optional `^l`, `^c` and `^r` header-cell
prefixes for per-column alignment. The handling of quoted and multi-line cells comes from
our sibling plugin **GridSense**. Thanks to both.

## License

[MIT license](LICENSE) © grub-basket.
