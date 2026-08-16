/** Demo content — a small, realistic nested Stashpad a new user can load in one
 *  click to see what the plugin is actually for.
 *
 *  Ported from `scripts/seed-demo.mjs` (which stays as-is for website
 *  screenshots — it writes via node:fs and needs a shell). The difference here:
 *  this runs inside Obsidian against the vault API, and every note gets a REAL
 *  minted id + the standard `<slug>-<id>.md` filename, so demo notes are
 *  indistinguishable from ones the user typed. Nothing about them is special-
 *  cased later — they're ordinary notes the user can edit or delete.
 *
 *  Dates are relative to seeding time, not the fixed 2026-06 stamps the script
 *  uses: a demo whose tasks are all months overdue reads as broken.
 */
import { normalizePath, type App } from "obsidian";
import type StashpadPlugin from "./main";
import { bodyToSlug, buildFilename } from "./slug-service";
import { ROOT_ID } from "./types";
import { buildHomeFilename } from "./view-helpers";

interface DemoNote {
  /** Symbolic key, local to this file — mapped to a minted id at seed time. */
  key: string;
  /** Parent's symbolic key, or null for a child of Home. */
  parent: string | null;
  /** Human-readable title; drives the filename slug (and so the breadcrumb). */
  name: string;
  body: string;
  task?: boolean;
  completed?: boolean;
  /** Days from today for a task's due date. Negative = already overdue. */
  dueInDays?: number;
  dueHour?: number;
}

/** The dataset. Six top-level stacks, each a few levels deep — enough to show
 *  nesting, tasks, and the breadcrumb without burying the user in content. */
const DEMO_NOTES: DemoNote[] = [
  // ── Reading list ────────────────────────────────────────────────────────
  { key: "read", parent: null, name: "Reading list", body: "📚 **Reading list** — what I'm working through and the bits worth keeping." },
  { key: "read-ah", parent: "read", name: "Atomic Habits", body: "📕 **Atomic Habits** — James Clear. The core move: don't set goals, design systems. You don't rise to the level of your goals — you fall to the level of your systems." },
  { key: "read-ah-hs", parent: "read-ah", name: "Habit stacking", body: "**Habit stacking** to try this week: \"After I pour my morning coffee, I will write three lines in my stash.\" Anchor the new habit to one I already never skip." },
  { key: "read-ah-2", parent: "read-ah", name: "The two-minute rule", body: "**The 2-minute rule:** scale any new habit down until it takes two minutes. \"Read before bed\" → \"read one page.\" Make it so easy you can't say no." },
  { key: "read-tfs", parent: "read", name: "Thinking Fast and Slow", body: "📗 **Thinking, Fast and Slow** — Kahneman. System 1 is fast, intuitive, wrong a lot. System 2 is slow, deliberate, lazy. Most \"intuition\" is System 1 pattern-matching wearing a confident face." },
  { key: "read-pp", parent: "read", name: "The Pragmatic Programmer", body: "📘 **The Pragmatic Programmer** — Hunt & Thomas. DRY isn't about code, it's about knowledge. Two snippets can look identical and not be a violation if they encode different decisions." },

  // ── Japan trip ──────────────────────────────────────────────────────────
  { key: "jp", parent: null, name: "Japan trip", body: "✈️ **Japan trip** 🌸 Nine days, Tokyo → Kyoto → back. Blossom forecast says peak around the 28th. Fingers crossed." },
  { key: "jp-tok", parent: "jp", name: "Tokyo", body: "**Tokyo** (5 nights, Airbnb in Shimokitazawa). Base in the west, day-trip out. Grab a Suica card at the airport and top it up before anything else." },
  { key: "jp-tok-d1", parent: "jp-tok", name: "Day 1 — arrival", body: "**Day 1** — recover from the flight slowly. Shimokitazawa vintage shops in the morning, Shibuya crossing at dusk, conveyor-belt sushi when we can't keep our eyes open." },
  { key: "jp-tok-d2", parent: "jp-tok", name: "Day 2 — teamLab", body: "**Day 2** — teamLab Planets (book tickets NOW, they sell out), then Tsukiji outer market for lunch. Evening: tiny bars in Golden Gai." },
  { key: "jp-kyo", parent: "jp", name: "Kyoto", body: "**Kyoto** (3 nights). Slower pace. Fushimi Inari at sunrise to beat the crowds, Arashiyama bamboo grove, an afternoon doing absolutely nothing in a tea house." },
  { key: "jp-pack", parent: "jp", name: "Packing list", body: "**Packing** — pack light, you'll buy stuff. Comfortable walking shoes (20k steps/day), a foldable tote, portable battery, and cash — Japan still loves cash." },
  { key: "jp-budget", parent: "jp", name: "Budget", body: "**Budget** — flights booked. Aim for ¥12k/day for food + transit per person. Splurge once on a proper kaiseki dinner in Kyoto; balance it with conbini breakfasts." },

  // ── Recipes ─────────────────────────────────────────────────────────────
  { key: "rec", parent: null, name: "Recipes", body: "🍳 **Recipes** — the ones that actually made it into rotation." },
  { key: "rec-ramen", parent: "rec", name: "Weeknight miso ramen", body: "**Weeknight miso ramen** (20 min). Soften garlic + ginger in sesame oil, whisk in 2 tbsp miso + a splash of soy, add stock. Noodles, soft egg, whatever greens are wilting in the drawer. Done." },
  { key: "rec-sd", parent: "rec", name: "Sourdough method", body: "**Sourdough — my method.** 500g flour, 350g water, 100g active starter, 10g salt. Autolyse 1h, 4 stretch-and-folds, bulk till 50% risen, shape, cold-proof overnight, bake in a dutch oven at 250°C." },
  { key: "rec-chx", parent: "rec", name: "Sheet-pan harissa chicken", body: "**Sheet-pan harissa chicken.** Thighs + chickpeas + red onion tossed in harissa, honey, lemon. 220°C for 35 min. Finish with yogurt and mint. Feeds 4, dirties one pan." },

  // ── Rust ────────────────────────────────────────────────────────────────
  { key: "rust", parent: null, name: "Rust — learning notes", body: "🦀 **Rust — learning notes.** Slowly fighting the borrow checker less and understanding it more." },
  { key: "rust-own", parent: "rust", name: "Ownership", body: "**Ownership.** Every value has exactly one owner; when the owner goes out of scope, the value is dropped. Move semantics by default — assigning transfers ownership, it doesn't copy." },
  { key: "rust-bor", parent: "rust", name: "Borrowing", body: "**Borrowing.** Either one mutable reference *or* any number of immutable ones — never both at once. That's the whole game: data races become compile errors." },
  { key: "rust-life", parent: "rust", name: "Lifetimes", body: "**Lifetimes, finally clicking.** An annotation doesn't change how long anything lives — it *describes* a relationship the compiler can't infer. `'a` means \"lives at least as long as 'a.\"" },
  { key: "rust-err", parent: "rust", name: "Error handling", body: "**Error handling.** No exceptions — `Result<T, E>` and the `?` operator. `?` early-returns the error, otherwise unwraps the Ok. `thiserror` for libraries, `anyhow` for apps." },

  // ── Ideas inbox ─────────────────────────────────────────────────────────
  { key: "idea", parent: null, name: "Ideas inbox", body: "💡 **Ideas inbox** — capture now, judge later. Most won't survive the week, and that's fine." },
  { key: "idea-out", parent: "idea", name: "Why outliners beat documents", body: "**Blog post: why outliners beat documents.** A document forces one order. An outliner lets structure emerge — write the thoughts, then drag them into shape. Working title: \"Structure is a verb.\"" },
  { key: "idea-plant", parent: "idea", name: "Plant-care reminders app", body: "**App idea: plant-care reminders** that account for season + light. Not \"water every Tuesday\" but \"this fern, this window, this month.\" Probably already exists. Capture anyway." },

  // ── This week (tasks) ───────────────────────────────────────────────────
  { key: "week", parent: null, name: "This week", body: "🎯 **This week** — the short list. If it's not here, it's not happening before Sunday." },
  { key: "week-invoice", parent: "week", name: "Send invoice to Meridian", body: "Send the invoice to Meridian for last month's work.", task: true, dueInDays: 2, dueHour: 17 },
  { key: "week-dentist", parent: "week", name: "Book dentist cleaning", body: "Book the dentist cleaning — it's been a year.", task: true, dueInDays: 5, dueHour: 9 },
  { key: "week-passport", parent: "week", name: "Renew passport", body: "Renew the passport before it expires (need it for Japan!).", task: true, dueInDays: 9, dueHour: 12 },
  { key: "week-itin", parent: "week", name: "Draft itinerary email", body: "Draft the Japan itinerary email for the group.", task: true, completed: true, dueInDays: -2, dueHour: 20 },

  // ── Home projects ───────────────────────────────────────────────────────
  { key: "home", parent: null, name: "Home projects", body: "🏠 **Home projects** — the slow-burn list." },
  { key: "home-shelf", parent: "home", name: "Garage shelving", body: "**Garage shelving.** 2×4 frame, plywood shelves, lag-bolted into the studs. Measure twice: the door swing eats 80cm on the left wall." },
  { key: "home-faucet", parent: "home", name: "Fix leaky faucet", body: "**Fix the leaky bathroom faucet.** Almost certainly a worn cartridge — match the brand first. Shut off the supply valves *before* getting cocky.", task: true, dueInDays: 12, dueHour: 10 },
];

/** How many notes a seed will write (including the Home note). Lets the UI
 *  promise an accurate number without importing the dataset itself. */
export const DEMO_NOTE_COUNT = DEMO_NOTES.length + 1;

/** YAML-safe scalar. Titles are ours (no colons/quotes today) but a future
 *  edit to the dataset shouldn't be able to emit broken frontmatter. */

function isoAt(daysFromNow: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  // Local-time ISO without the timezone suffix, matching what the seeder script
  // emits and what Stashpad's due-date parsing expects.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

export interface SeedResult {
  created: number;
  skipped: number;
}

/**
 * Write the demo tree into `folder`. Creates the folder and its Home note if
 * missing. NEVER overwrites: a path that already exists is skipped and counted,
 * so re-running is safe and can't clobber a user's note that happens to collide.
 */
export async function seedDemoContent(app: App, plugin: StashpadPlugin, folder: string): Promise<SeedResult> {
  const dir = normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
  if (!dir) throw new Error("Folder name is empty");
  // normalizePath collapses slashes but does NOT strip "..", and every path
  // below is joined against the vault root — so an unchecked name could write
  // outside the intended folder (e.g. into .obsidian/). Reject loudly rather
  // than silently rewriting, per the project's path-traversal invariant.
  if (dir.split("/").some((p) => p === "." || p === "..")) {
    throw new Error(`Folder name can't contain "." or ".." path segments`);
  }

  const adapter = app.vault.adapter;
  // mkdir intermediates (same approach as createNewStashpad).
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) {
    cur = cur ? `${cur}/${part}` : part;
    if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
  }

  let created = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();

  // Home note. Uses the folder's own leaf name as the title so the demo reads
  // as "the user's stash", not a hardcoded "My Stash".
  const leaf = dir.split("/").pop() || dir;
  // 0.266.10: the SHARED buildHomeFilename, not a local copy of its rules.
  //
  // This comment used to say "match view.ts's buildHomeFilename exactly" and
  // then restate the logic — which is the setup that produced the duplicate
  // home note. createNewStashpad had its own third version, drifted to a bare
  // `Home.md`, and the view then created a second root note because it was
  // looking for a different filename. A comment asking the reader to keep two
  // copies in step is a bug waiting for its moment; one function cannot drift.
  const homePath = `${dir}/${buildHomeFilename(dir)}`;
  if (await adapter.exists(homePath)) {
    skipped++;
  } else {
    await app.vault.create(
      homePath,
      [
        "---",
        `id: ${ROOT_ID}`,
        "parent: null",
        `created: ${nowIso}`,
        "attachments: []",
        "---",
        `# ${leaf}`,
        "",
        "Everything I'm thinking about, one stack at a time.",
        "",
      ].join("\n"),
    );
    created++;
  }

  // Mint a real id per note up front so children can reference their parent.
  const idFor = new Map<string, string>();
  for (const note of DEMO_NOTES) idFor.set(note.key, plugin.mintNoteId());

  for (const note of DEMO_NOTES) {
    const id = idFor.get(note.key)!;
    const parentId = note.parent ? idFor.get(note.parent)! : ROOT_ID;
    const path = `${dir}/${buildFilename(bodyToSlug(note.name), id)}`;
    if (await adapter.exists(path)) {
      skipped++;
      continue;
    }
    const fm = [`id: ${id}`, `parent: ${parentId}`, `created: ${nowIso}`, "attachments: []"];
    if (note.task) fm.push("task: true");
    if (note.completed) fm.push("completed: true");
    if (note.dueInDays !== undefined) fm.push(`due: ${isoAt(note.dueInDays, note.dueHour ?? 9)}`);
    // No `title:` key — Stashpad derives the title from the filename slug
    // (see buildFilename / parseIdFromFilename), and an unused frontmatter
    // field would just be noise other tools might act on.
    await app.vault.create(path, `---\n${fm.join("\n")}\n---\n${note.body}\n`);
    created++;
  }

  return { created, skipped };
}
