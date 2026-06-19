/* Seed a rich, nested demo note-folder for website screenshots.
 *   node scripts/seed-demo.mjs "/abs/path/to/vault" "My Stash" [--force]
 * Filenames are human-readable (drives Stashpad's breadcrumb/header titles);
 * the canonical identity is the frontmatter `id`. --force replaces the folder
 * (only ever the demo folder it generates — never touches sibling notes).
 */
import { mkdir, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";

const vault = process.argv[2];
const folder = process.argv[3] || "My Stash";
const force = process.argv.includes("--force");
if (!vault) { console.error("usage: seed-demo.mjs <vaultPath> [folder] [--force]"); process.exit(1); }

const dir = join(vault, folder);
let exists = false;
try { await access(dir); exists = true; } catch {}
if (exists && !force) { console.error(`REFUSED: ${dir} exists (use --force to regenerate)`); process.exit(1); }
if (exists && force) await rm(dir, { recursive: true });
await mkdir(dir, { recursive: true });

let t = Date.parse("2026-06-12T09:00:00");
const stamp = () => { const d = new Date(t); t += 60_000; return d.toISOString().slice(0, 19); };

const notes = [];
const byId = new Map();
// id, parent, name(=filename/title), body, extra
const add = (id, parent, name, body, extra = {}) => {
  const n = { id, parent, name, created: stamp(), body: body.trim(), extra };
  notes.push(n); byId.set(id, n);
};

await writeFile(join(dir, `Home.md`),
  `---\nid: __root__\nparent: __root__\ncreated: ${stamp()}\nattachments: []\n---\n# My Stash\nEverything I'm thinking about, one stack at a time.\n`);

// ── 1. Reading list ──────────────────────────────────────────────────────
add("read", "__root__", "Reading list", `📚 **Reading list** — what I'm working through and the bits worth keeping.`);
add("read-ah", "read", "Atomic Habits", `📕 **Atomic Habits** — James Clear. The core move: don't set goals, design systems. You don't rise to the level of your goals — you fall to the level of your systems.`);
add("read-ah-hs", "read-ah", "Habit stacking", `**Habit stacking** to try this week: "After I pour my morning coffee, I will write three lines in my stash." Anchor the new habit to one I already never skip.`);
add("read-ah-2", "read-ah", "The two-minute rule", `**The 2-minute rule:** scale any new habit down until it takes two minutes. "Read before bed" → "read one page." Make it so easy you can't say no.`);
add("read-tfs", "read", "Thinking Fast and Slow", `📗 **Thinking, Fast and Slow** — Kahneman. System 1 is fast, intuitive, wrong a lot. System 2 is slow, deliberate, lazy. Most "intuition" is System 1 pattern-matching wearing a confident face.`);
add("read-pp", "read", "The Pragmatic Programmer", `📘 **The Pragmatic Programmer** — Hunt & Thomas. DRY isn't about code, it's about knowledge. Two snippets can look identical and not be a violation if they encode different decisions.`);

// ── 2. Japan trip ────────────────────────────────────────────────────────
add("jp", "__root__", "Japan trip — March", `✈️ **Japan trip — March** 🌸 Nine days, Tokyo → Kyoto → back. Blossom forecast says peak around the 28th. Fingers crossed.`);
add("jp-tok", "jp", "Tokyo", `**Tokyo** (5 nights, Airbnb in Shimokitazawa). Base in the west, day-trip out. Grab a Suica card at the airport and top it up before anything else.`);
add("jp-tok-d1", "jp-tok", "Day 1 — arrival", `**Day 1** — recover from the flight slowly. Shimokitazawa vintage shops in the morning, Shibuya crossing at dusk, conveyor-belt sushi when we can't keep our eyes open.`);
add("jp-tok-d2", "jp-tok", "Day 2 — teamLab", `**Day 2** — teamLab Planets (book tickets NOW, they sell out), then Tsukiji outer market for lunch. Evening: tiny bars in Golden Gai.`);
add("jp-kyo", "jp", "Kyoto", `**Kyoto** (3 nights). Slower pace. Fushimi Inari at sunrise to beat the crowds, Arashiyama bamboo grove, an afternoon doing absolutely nothing in a tea house.`);
add("jp-pack", "jp", "Packing list", `**Packing** — pack light, you'll buy stuff. Comfortable walking shoes (20k steps/day), a foldable tote, portable battery, and cash — Japan still loves cash.`);
add("jp-budget", "jp", "Budget", `**Budget** — flights booked. Aim for ¥12k/day for food + transit per person. Splurge once on a proper kaiseki dinner in Kyoto; balance it with conbini breakfasts.`);

// ── 3. Recipes ───────────────────────────────────────────────────────────
add("rec", "__root__", "Recipes", `🍳 **Recipes** — the ones that actually made it into rotation.`);
add("rec-ramen", "rec", "Weeknight miso ramen", `**Weeknight miso ramen** (20 min). Soften garlic + ginger in sesame oil, whisk in 2 tbsp miso + a splash of soy, add stock. Noodles, soft egg, whatever greens are wilting in the drawer. Done.`);
add("rec-sd", "rec", "Sourdough method", `**Sourdough — my method.** 500g flour, 350g water, 100g active starter, 10g salt. Autolyse 1h, 4 stretch-and-folds, bulk till 50% risen, shape, cold-proof overnight, bake in a dutch oven at 250°C.`);
add("rec-chx", "rec", "Sheet-pan harissa chicken", `**Sheet-pan harissa chicken.** Thighs + chickpeas + red onion tossed in harissa, honey, lemon. 220°C for 35 min. Finish with yogurt and mint. Feeds 4, dirties one pan.`);

// ── 4. Rust ──────────────────────────────────────────────────────────────
add("rust", "__root__", "Rust — learning notes", `🦀 **Rust — learning notes.** Slowly fighting the borrow checker less and understanding it more.`);
add("rust-own", "rust", "Ownership", `**Ownership.** Every value has exactly one owner; when the owner goes out of scope, the value is dropped. Move semantics by default — assigning transfers ownership, it doesn't copy.`);
add("rust-bor", "rust", "Borrowing", `**Borrowing.** Either one mutable reference *or* any number of immutable ones — never both at once. That's the whole game: data races become compile errors.`);
add("rust-life", "rust", "Lifetimes", `**Lifetimes, finally clicking.** An annotation doesn't change how long anything lives — it *describes* a relationship the compiler can't infer. \`'a\` means "lives at least as long as 'a."`);
add("rust-err", "rust", "Error handling", `**Error handling.** No exceptions — \`Result<T, E>\` and the \`?\` operator. \`?\` early-returns the error, otherwise unwraps the Ok. \`thiserror\` for libraries, \`anyhow\` for apps.`);

// ── 5. Ideas inbox ───────────────────────────────────────────────────────
add("idea", "__root__", "Ideas inbox", `💡 **Ideas inbox** — capture now, judge later. Most won't survive the week, and that's fine.`);
add("idea-out", "idea", "Why outliners beat documents", `**Blog post: why outliners beat documents.** A document forces one order. An outliner lets structure emerge — write the thoughts, then drag them into shape. Working title: "Structure is a verb."`);
add("idea-plant", "idea", "Plant-care reminders app", `**App idea: plant-care reminders** that account for season + light. Not "water every Tuesday" but "this fern, this window, this month." Probably already exists. Capture anyway.`);

// ── 6. This week (tasks) ─────────────────────────────────────────────────
add("week", "__root__", "This week", `🎯 **This week** — the short list. If it's not here, it's not happening before Sunday.`);
add("week-invoice", "week", "Send invoice to Meridian", `Send the invoice to Meridian for the May work.`, { task: true, due: "2026-06-20T17:00:00" });
add("week-dentist", "week", "Book dentist cleaning", `Book the dentist cleaning — it's been a year.`, { task: true, due: "2026-06-23T09:00:00" });
add("week-passport", "week", "Renew passport", `Renew the passport before it expires (need it for Japan!).`, { task: true, due: "2026-06-25T12:00:00" });
add("week-itin", "week", "Draft itinerary email", `Draft the Japan itinerary email for the group.`, { task: true, completed: true, due: "2026-06-18T20:00:00" });

// ── 7. Home projects ─────────────────────────────────────────────────────
add("home", "__root__", "Home projects", `🏠 **Home projects** — the slow-burn list.`);
add("home-shelf", "home", "Garage shelving", `**Garage shelving.** 2×4 frame, plywood shelves, lag-bolted into the studs. Measure twice: the door swing eats 80cm on the left wall.`);
add("home-faucet", "home", "Fix leaky faucet", `**Fix the leaky bathroom faucet.** Almost certainly a worn cartridge — match the brand first. Shut off the supply valves *before* getting cocky.`, { task: true, due: "2026-06-28T10:00:00" });

for (const n of notes) {
  const fm = [`id: ${n.id}`, `parent: ${n.parent}`, `created: ${n.created}`, `attachments: []`];
  if (n.extra.task) fm.push(`task: true`);
  if (n.extra.completed) fm.push(`completed: true`);
  if (n.extra.due) fm.push(`due: ${n.extra.due}`);
  const parentName = n.parent === "__root__" ? "Home" : byId.get(n.parent)?.name || "Home";
  fm.push(`parentLink: "[[${folder}/${parentName}]]"`);
  await writeFile(join(dir, `${n.name}.md`), `---\n${fm.join("\n")}\n---\n${n.body}\n`);
}
console.log(JSON.stringify({ folder: dir, count: notes.length + 1 }, null, 2));
