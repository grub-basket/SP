# Level-marker copy (`[L1]`, `[L2]`, …)

A tiny, portable convention for carrying **outline depth** through a plain-text
copy — so nesting survives even when you paste into an app that strips leading
whitespace (chat boxes, many web forms, some editors).

## The rule

- Each copied line carries a `[L<n>] ` marker (after the list bullet), where `n`
  is the item's depth.
- Depth is **relative to what you copied**, not to the note's absolute position.
  The top of the selection is always `[L1]`; its children are `[L2]`, and so on.
  Copy a note that happens to sit six levels deep, and its lines still start at
  `[L1]` — the receiver doesn't need to know where you were zoomed in.
- The marker is the depth signal that survives when an app strips leading
  whitespace. The **real indentation is kept as well**, so where whitespace *is*
  preserved the copy still reads as an ordinary indented outline — and the markers
  can be removed later with a regex (`\[L\d+\]\s`) to recover a plain indented list.

## Example

A subtree copied from Stashpad with the convention on:

```
- [L1] Trip planning
  - [L2] Flights
    - [L3] Compare Tue vs Wed departures
  - [L2] Lodging
    - [L3] Cabin near the trailhead
    - [L3] Cancellation policy
```

The same content, indentation-based, is lost the moment it lands somewhere that
trims whitespace:

```
Trip planning
Flights
Compare Tue vs Wed departures
Lodging
…
```

With `[L<n>]`, the shape is recoverable by reading the numbers — by a human, or
by a parser (`^\[L(\d+)\]\s`).

## In Stashpad

Turn on **Settings → “Indent-safe copy (level markers)”**. It applies to **Copy
tree** and **Copy focused subtree**. Off by default (the normal output is a
2-space-indented Markdown list). Everything else on the line — task checkbox,
colour/alias metadata, optional timestamp prefix — is preserved after the marker.

## Why this shape

- `[L1]` reads as “level 1” at a glance and sorts/greps cleanly.
- Brackets make it easy to strip programmatically and unlikely to collide with
  real content at the start of a line.
- Relative numbering keeps a pasted fragment self-contained: the same subtree
  produces the same text regardless of how deep it lived.

It's deliberately generic — nothing here is Stashpad-specific, so the same
convention travels to any tool that needs to move an outline through plain text.
</content>
