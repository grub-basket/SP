# OKF in Stashpad — a getting-started guide

This guide assumes you know **nothing** about OKF *or* Stashpad. By the end you'll
know what OKF is, why Stashpad is a natural way to produce it, and exactly how to
turn one of your folders into an OKF bundle and share it.

---

## What is OKF?

**OKF (Open Knowledge Format)** is Google's open, vendor-neutral spec for packaging
curated knowledge so that LLMs and AI agents can browse and use it reliably. An OKF
"bundle" is deliberately simple — just a folder of plain Markdown files:

- **one file per "concept"** (a table, a dataset, a metric, a runbook, a note…),
- each with a little **YAML frontmatter** at the top (`type` is required;
  `title` / `description` / `tags` / `timestamp` are recommended),
- **cross-links between concepts are relative Markdown links** (e.g.
  `[Onboarding](onboarding.md)`), not app-specific `[[wikilinks]]`,
- an **`index.md`** in the folder that lists the concepts,
- the **file path is the concept's identity**.

That's the whole idea: knowledge as a tidy, linkable folder of Markdown that any
tool — or any AI — can read without a proprietary importer.

Spec & background:
- https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
- https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/

## What is Stashpad?

**Stashpad** is an Obsidian plugin that turns a folder into a chat-style outliner:
you jot notes, nest them under one another, and navigate the tree. Under the hood
every note is just a Markdown file with YAML frontmatter, and the parent/child
structure is recorded there too.

## Why Stashpad is a good fit for OKF

Look at the two descriptions above — they're almost the same shape:

| OKF wants… | Stashpad already has… |
|---|---|
| one Markdown file per concept | one Markdown file per note |
| YAML frontmatter on each | frontmatter on every note |
| a folder of related concepts | a Stashpad folder of related notes |
| relative-Markdown cross-links | a real parent/child hierarchy |
| an `index.md` per folder | a known folder structure to generate one from |

So an OKF bundle is basically "a Stashpad folder, written down in OKF's
conventions." Stashpad can therefore **generate the OKF layer for you** — the
required frontmatter keys, the relative-Markdown links, and the `index.md` — instead
of you hand-authoring any of it. And it does so **without disturbing your notes**:
the OKF fields are added *alongside* Stashpad's own (nothing is renamed or removed),
so the same folder stays a normal Stashpad folder AND becomes a valid OKF bundle.

## Get started in ~1 minute

1. **Turn OKF on.** Settings → **Open Knowledge Format (OKF)** → toggle **Enable OKF**.
   This creates an `OKF Template.md` file in your vault.
2. **Pick which folders use OKF.** Click **Create template + open Templates**. In the
   Templates list, set a folder's template to `OKF Template.md`. Do this for as many
   (or as few) folders as you want — it's per-folder. (Archive folders are skipped on
   purpose; OKF is about sharing, archives are about privacy.)
3. **Build the OKF layer.** Back on the OKF page, click **Rebuild OKF frontmatter**.
   For every OKF folder this writes the OKF fields onto each note and generates the
   folder's `index.md`.
4. **Share it.** Right-click a note (or a selection) → **Export as OKF…** and tick the
   format(s) you want: **.zip** or **.tar.gz** (portable OKF bundles) and/or **.stash**
   (Stashpad's own re-importable format). The export lands in the folder's `_exports`.

That's it. Hand the `.zip`/`.tar.gz` to a colleague, an agent, or a data tool — it's
standard OKF.

## What Stashpad writes for you

On a note in an OKF folder, after a Rebuild:

- `okfType` — the concept type (defaults to `concept`; **edit this freely** per note).
- `okfTitle`, `okfTimestamp` — filled in if missing (yours to edit after).
- `okfParent`, `okfChildren` — relative-Markdown links to the parent/child notes
  (Stashpad keeps these in sync; they mirror your tree).

And per folder: an **`index.md`** (`type: index`) with a nested list of the concepts
plus a short **legend** explaining the field names — so even an AI reading the *live*
folder knows how Stashpad's `okf*` fields map to OKF's standard keys.

> Why the `okf` prefix? So these never collide with your own `tags`/`title`/`type`
> frontmatter or other plugins'. On **export**, Stashpad maps them to OKF's bare spec
> keys (`type`/`title`/`description`/`tags`/`timestamp`) in the bundle, while keeping
> the `okf*` + `id` fields too so the bundle can be re-imported into Stashpad
> losslessly.

## Good to know

- **Complementary, never destructive.** Your existing Stashpad notes and links are
  untouched; OKF fields are added on top.
- **Auto-updates, but not instantly.** When you add, move, or delete notes in an OKF
  folder, Stashpad refreshes that folder's OKF fields + `index.md` automatically — a
  few seconds *after you stop* (it's debounced, so a burst of changes becomes one
  rebuild). A brand-new note gets `okfType` right away; its `okfParent`/`okfChildren`
  and the folder's `index.md` catch up on that refresh. Want it immediately? Click
  **Rebuild OKF frontmatter** in Settings → OKF.
- **Archive folders are excluded** from all OKF processing by design.
- **Export scope.** Exporting a note/selection bundles that subtree, and the bundle's
  `index.md` reflects just what you exported.

## Glossary

- **Concept** — one OKF Markdown file (= one Stashpad note).
- **Bundle** — a folder of concepts + `index.md`, optionally zipped/tarred.
- **`index.md`** — the per-folder table of contents OKF expects (Stashpad generates it).
- **Rebuild** — Stashpad's pass that (re)writes the OKF fields + `index.md`.
