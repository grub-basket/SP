# Stashpad

A capture-first, chat-style notes workspace for [Obsidian](https://obsidian.md).
Type at the bottom and press Enter — your notes stack newest-first, nest under each
other, and become an outline you can drill through. No filenames to invent, no folder
to pick first: just jot it down and keep moving.

Think of it as a running conversation with yourself that quietly organizes into a
tree — a scratchpad, an outliner, and a task list in one panel.

> ⚠️ **Alpha software, honestly labeled.** Stashpad does a lot and is usable daily,
> but it's young — keep backups of anything important.
>
> It's designed and directed by its maintainer, but the **code is written by an AI
> assistant** rather than hand-authored or human-reviewed. The upside of that is
> pace: Stashpad is **actively maintained and moves quickly**, and bug reports are
> genuinely welcome and get acted on. If something breaks or feels off,
> [open an issue](https://github.com/grub-basket/SP/issues) — it'll be looked at.

## Install

Stashpad is on the [Obsidian community store](https://community.obsidian.md/plugins/stashpad). Requires Obsidian **1.13.0+** (desktop or mobile).

1. Open **Settings → Community plugins → Browse** and search for **Stashpad** (or use the [store page](https://community.obsidian.md/plugins/stashpad)).
2. Install, then enable **Stashpad**.

**Via BRAT (optional).** You can also install through [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) ([GitHub](https://github.com/TfTHacker/obsidian42-brat)): choose "Add beta plugin" and paste `https://github.com/grub-basket/SP`. BRAT lets you pin a specific version, which is handy for downgrading or grabbing a fix before it reaches the store.

## Quick start

1. Open the command palette and run **"Reveal or open Stashpad"** (or click the
   ribbon icon). The first run creates a `Stashpad` folder.
2. **Type in the composer at the bottom and press Enter** to capture a note. It
   appears in the list above.
3. **Click a note (or press →)** to drill into it; new notes you add now nest under
   it. Press **←** or the back arrow to come back out.
4. From there: search, move/clone, set colors, pin, or turn a note into a task with a
   due date and reminder.

---

## Capture-first: type and go

The heart of Stashpad is the composer pinned to the bottom of the panel. You type,
you press Enter, and the note lands in the list above — no dialog, no filename to
invent, no folder to choose. It's the messaging-app model applied to notes: the cost
of writing something down drops to almost nothing, so you actually do it.

Shift+Enter adds newlines for a longer thought, and an optional split-on-newlines mode
turns one burst into several separate notes at once. Everything you capture is an
ordinary Markdown file with frontmatter — nothing proprietary, readable by the rest of
Obsidian and by you in ten years.

## An outliner that nests as deep as you think

Notes aren't a flat feed. Click a note (or press →) to drill into it, and anything you
capture next nests underneath — arbitrarily deep. Press ← to climb back out. Any note
can become a temporary root, so you can focus a single branch and work inside it
without the rest of the tree in your way.

The result is that structure *emerges* from fast capture instead of being planned up
front. Dump thoughts in as they come; promote, demote, and rearrange them into an
outline later — or never, if the newest-first stack is all you need.

## Tasks & reminders

Turn any note into a to-do with a keystroke: it gains a checkbox you can tick right in
the list. Give it a due date and Stashpad will remind you when it's due — click the
reminder to jump straight to the task, or snooze it. Tasks support recurrence and
assignees, and a dedicated tasks panel gathers everything that's open so your notes and
your to-dos live in the same place instead of a separate app.

## Find anything fast

Search uses **Sift** — all-tokens, any-order, case-insensitive matching — so "budget
q3" finds "Q3 budget review" without you remembering the exact wording. Search a single
Stashpad folder or every Stashpad in the vault at once, and narrow results with filters
like color or completion state.

## Organize without friction

When you *do* want to tidy up, the moves are all there: move, merge, clone, and outdent;
drag-and-drop re-parenting; manual ordering; and per-note **colors** you can give
friendly aliases (so `#ffe243` becomes "boogers"). Pin the notes and folders you return
to. You can even cut / copy / paste whole subtrees — attachments included — across
folders, and every structural change is fully undoable, so reorganizing never feels
risky.

## Tiny mode

Pop Stashpad out into a small, always-on-top, opacity-adjustable window and pin it to a
corner of your screen. It's built for capturing a stray thought while you're working in
another app — jot it, and get back to what you were doing without losing your place.

## Attachments & clean copy-out

Drop files onto the panel and they auto-import as attachments. When you want notes *out*
of Stashpad, copy them as a checklist (tasks come across as real `- [ ]` / `- [x]`
checkboxes, with color/alias carried along), as an indented outline, or as `![[embed]]`
links you can transclude into any regular Obsidian note.

---

## Also includes

Useful extras that aren't the point of Stashpad, but are there when you need them —
and out of the way when you don't:

- **Import / export** — `.stash` bundles (optionally encrypted) round-trip notes +
  attachments between vaults.
- **Encryption (beta)** — lock notes or folders into encrypted `.stashenc` files, with
  archive folders, encrypted trash, and shared-key collaboration. Beta: data can be
  lost with or without your key. *(Please read the caveat below.)*
- **Authorship / multiplayer** — stamp notes with your name; shared vaults track
  contributors via a vault-wide author registry.
- **Johnny.Decimal index** — build a JD-style hierarchy from dotted-prefix titles.
- **Open Knowledge Format (OKF) export** — opt a folder in to export it as an
  [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle
  (`.zip` / `.tar.gz` / `.stash`) — Google's vendor-neutral Markdown format for handing
  curated knowledge to LLMs and agents. See [`docs/okf-guide.md`](docs/okf-guide.md).

> 🔒 **On encryption — read before you encrypt anything.**
>
> **Save your folder password in a password manager first.** "Remember on this device
> (keychain)" is a convenience, **not a backup**. An OS or keychain reset, a
> wiped/restored profile, a reinstall, a new machine, or an IT event can erase it at
> any time, without warning. If that was the only copy of your password, everything
> encrypted under it is permanently unreadable — by you, by us, by anyone.
>
> A **Recovery password** adds a second way in, but only helps if you keep it somewhere
> separate from the main one — two entries in the same password manager both vanish
> with that manager. Do set one for **shared** folders: it survives a collaborator
> changing the main password.
>
> The encryption was also written by an AI assistant and has **not** been human-audited
> or security-tested. Treat it as a way to deter a casual snoop, **not** a guarantee —
> don't rely on it for anything sensitive, and keep unencrypted backups. It's optional
> and off by default.
>
> Because it's beta, **data loss is possible with or without your key** — a bug, an
> interrupted lock/unlock, or a sync writing the vault mid-operation can damage
> encrypted files even when your password is perfectly safe. Keep unencrypted backups.
>
> *No warranty of any kind. This encryption has never been audited, so it is not proven
> to protect anything. Stashpad cannot recover keys or passwords, and is not liable for
> the loss of keys, passwords or data, for a fault in this beta encryption, or for any
> harm that follows if it fails to keep your data private. Keeping your own backups —
> and deciding what is safe to trust it with — are yours to do.*

## Feedback

Report anything buggy or strange on the [issues](https://github.com/grub-basket/SP/issues) tab.

## Credits & thanks

Stashpad is a homage to **Stashpad Notes**, a lovely app discontinued in 2024. This
plugin brings its chat-style, jot-it-down feeling into Obsidian. Sincere thanks to
its founders, **Cara and Theo, and the rest of the Stashpad team**, for the original that inspired it.

## License

[MIT](LICENSE) © grub-basket.
