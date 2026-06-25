# The View menu — modes & filters

The **View** dropdown (the `list-tree` / `list` / `layout-grid` button in the
filter bar) controls how the current folder's notes are listed, plus a set of
filters. As of 0.122.1 the inline descriptions are hidden in the menu to keep it
compact (it was clipping when the header collapses into the combined ⋯ menu at
narrow widths) — this page is the canonical, expanded reference. Each setting is
**per-folder** unless noted.

## View modes

- **Nested** *(default)* — a tree of the focused note's **immediate children**;
  drill in to see the next level. Drag-to-reorder works here (the manual order is
  stored per parent). This is the only mode where **Sort** applies.
- **Flat** — **every descendant** of the current focus in one flat list, ordered
  by sort (created time when sort is non-manual). Drag-reorder is disabled
  (positions are synthesized, not stored). Good for "show me everything under
  here at once."
- **Everything** — like Flat, **plus** the non-Stashpad files that live in the
  same folder (interleaved by created / file ctime). Lets the Stashpad view double
  as a file browser for that folder.

## Encryption filter *(only when vault encryption is set up)*

- **Show all** — both locked 🔒 stubs and decrypted notes.
- **Locked only** — only the locked 🔒 stubs.
- **Decrypted only** — hide the locked 🔒 stubs.

## Filters (apply in every mode unless noted)

- **Hide childless notes** — in **Nested**, show only notes that have children
  (applied at the current level). In **Flat/Everything**, hide top-level notes
  without children but keep every parent's full subtree, so nothing nested is
  overlooked.
- **Hide completed notes** — hide notes marked complete. A completed **parent**
  stays visible while any descendant is still incomplete (so you don't lose the
  path to open work).
- **Hide notes without attachments** — show only notes that have an attachment; a
  parent stays visible while any descendant has one.
- **Include attachments** *(Everything mode only)* — show attachments referenced
  by notes as their own rows in the file list. Off by default — they already
  appear inline on the notes that embed them.
- **Imported notes only** — show only notes that came in via import (`.stash` /
  dropped files).
- **By author** — filter to notes stamped with a chosen author (the dropdown
  lists the distinct authors present in this folder). Most useful in
  Flat/Everything, which flatten descendants.

## Notes

- **Sort** is per-parent and **Nested-only**; in Flat/Everything the list is a
  synthesized flat order, so the Sort control is disabled there.
- Filters compose — e.g. "Flat + Hide completed + By author" shows one author's
  outstanding work across the whole subtree.

## Verbatim in-menu descriptions (archived)

These are the exact one-line descriptions that used to render under each item in
the View menu, preserved here verbatim now that they're hidden in the UI (the
strings still live in `src/view.ts` ~3880–4029, just `display:none`):

| Item | Description |
| --- | --- |
| Nested | Tree of immediate children (default). |
| Flat | All descendants of the current focus, flat by sort. |
| Everything | All descendants PLUS non-Stashpad files in the folder. |
| Encryption: show all | Both locked 🔒 and decrypted notes. |
| Encryption: locked only | Show only locked 🔒 stubs. |
| Encryption: decrypted only | Hide locked 🔒 stubs. |
| Hide childless notes | Show only notes that have children. Applied at this level. |
| Hide completed notes | Hide notes marked complete. A completed parent stays visible while any descendant is still incomplete. |
| Hide notes without attachments | Show only notes that have an attachment. A parent stays visible while any descendant has one. |
| Include attachments | Only applies in Everything mode. |
| Imported notes only | Show only notes that came in via import. |
| By author | Show only notes by the chosen author. |
