/** 0.85.4: passphrase generation + password-strength estimation for the
 *  encrypted-.stash export flow, plus deterministic secret-storage IDs.
 *
 *  - generatePassphrase(): xkcd-style "correct-horse-battery-staple" — N random
 *    words from a curated list joined by dashes, with a trailing number. Uses
 *    crypto.getRandomValues with rejection sampling (no modulo bias).
 *  - estimatePasswordStrength(): a lightweight, dependency-free nudge meter (NOT
 *    zxcvbn-grade). Pool-size entropy with a repetition penalty and a small
 *    common-password floor. Good enough to shame "cool bean"; honest enough not
 *    to call "aaaaaaaa" strong.
 *  - secretIdForStashName(): deterministic, collision-resistant id (lowercase
 *    alphanumeric + dashes, ≤64) so export-time setSecret and import-time
 *    getSecret agree from the filename alone. */

/** Curated word list for generated passphrases. Short, common, unambiguous
 *  (no profanity, no easily-confused homophones). ~280 words → log2 ≈ 8.13
 *  bits/word, so the default 5-word passphrase + 2-digit number ≈ 47 bits of
 *  entropy — comfortably "strong" for a file password. */
const WORDS = (
  "able acid acorn actor adept agile alarm album alert algae amber amble anchor angle ankle apple " +
  "april arbor arc arctic arena armor arrow ascot aspen atlas atom attic auburn audio autumn award " +
  "axis bacon badge bagel baker balmy bamboo banjo barge basil basin batch beach beam bean bear " +
  "beaver begin belt bench berry birch bison black blade blaze bliss bloom blue board boat bold " +
  "bolt bonus boost booth borax bother bottle boulder bounce bovine bowl brave bread breeze brick " +
  "bridge brisk broad bronze brook broom brown brush bubble bucket bug bulb bundle burst cabin " +
  "cable cacao cactus camel cameo candle canoe canvas canyon cargo carol carrot castle catch cedar " +
  "cello chalk charm chart cheese cherry chess chime chirp cider cinder circle citrus clamp clay " +
  "clever cliff cloak clock cloud clover coast cobra cocoa comet coral cosmos cotton couch cougar " +
  "crane crater cream crest cricket crisp crown crumb crystal cube cumin curio dagger daisy dapper " +
  "dawn deck deer delta denim depot desert dial diamond dingo ditch dock dodge dolphin domino donut " +
  "draft dragon drift drum dune dusk eagle early earth easel ebony echo eclipse edge eel eagle " +
  "elbow elder ember emboss emerald ember emu engine ermine ether ever fable falcon fancy farm " +
  "fawn feather felt fennel fern ferry fiber fiddle field fig finch flame flask flax fleet flint " +
  "float flock flora flute focus foam forest fossil fox frame frost fudge garden gecko ginger " +
  "glacier glade glass glide globe glory glove gnat goat golden gopher gourd grape grass gravel " +
  "grove guava gull hammer hamlet harbor hatch hazel heron hickory hippo honey hornet hostel ivory " +
  "ivy jade jaguar jasmine jelly jetty jewel jolly jungle juniper kayak kelp kettle kiwi koala " +
  "ladle lagoon lamp lantern larch lark lasso lava ledge lemon lentil leopard lever lilac lime " +
  "linen lizard llama lobby locket lodge lotus lunar lupine lynx maple marble marsh meadow medal " +
  "melon mellow mentor mesa metro mimic mint mirror mocha morsel moss mottle mural muslin nacho " +
  "nectar nest noble nomad noodle nougat nutmeg oasis oat ocean ochre olive onyx opal orbit orca " +
  "otter oval owl oxide oyster pace paddle palm panda pantry papaya parka parsley pasta pearl " +
  "pebble pelican pepper pewter phantom piano picnic pigeon pilot pine pixel plank plaza plum " +
  "pocket pollen pond poplar poppy portal potato pottery prairie prism puffin pumice quail quartz " +
  "quill quilt quince rabbit radish raft rapid raven reed reef relish ribbon ridge rind ripple " +
  "river robin rocket rope rover ruby rudder rust saffron sage salmon sandal sash satin sauce " +
  "scout sedge sequin shadow shale shark shell shore shrub silk silo silver siren sketch slate " +
  "sleet slope sloth smoke snail sonar sorrel spark sparrow spice spire sprig spruce squid stable " +
  "stamp starling steam stem stilt stone stork storm stove straw stream stucco summit sundae " +
  "sunset swan sweater syrup tabby talon tango tapir tassel tawny teal tempo thicket thimble " +
  "thistle thorn thunder tidal tiger timber toffee token topaz torch totem trail tulip tundra " +
  "turtle tusk twig umber unicorn valley vanilla velvet vermil violet viper vista vivid vortex " +
  "waffle walnut warbler wasp water weasel wharf wheat whisk willow window winter wisp wombat " +
  "wonder woven yam yarn yeast yew yodel yonder zebra zenith zephyr zigzag zinc zircon"
  // De-duped: the raw list repeats a few words (eagle, ember), which would
  // overstate `passphraseBits`' advertised entropy and skew word odds.
).split(/\s+/).filter(Boolean).filter((w, i, a) => a.indexOf(w) === i);

/** Unbiased random integer in [0, n) via rejection sampling. */
function randIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n; // largest multiple of n ≤ 2^32
  const buf = new Uint32Array(1);
  let x: number;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}

/** xkcd-style passphrase: `words` random words + a trailing 2-digit number,
 *  dash-separated. Default 5 words ≈ 47 bits of entropy. */
export function generatePassphrase(words = 5): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(WORDS[randIndex(WORDS.length)]);
  parts.push(String(10 + randIndex(90))); // 10..99 — guarantees a digit class
  return parts.join("-");
}

/** Approx. entropy (bits) of a generated passphrase, for honest UI labeling. */
export function passphraseBits(words = 5): number {
  return words * Math.log2(WORDS.length) + Math.log2(90);
}

// A few of the most-abused passwords — floored so the meter never flatters them.
const COMMON = new Set([
  "password", "passw0rd", "password1", "123456", "12345678", "123456789", "qwerty",
  "abc123", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon", "sunshine",
  "princess", "football", "baseball", "trustno1", "000000", "111111", "secret",
]);

export interface PasswordStrength {
  /** Estimated entropy in bits (capped/penalized — not a precise figure). */
  bits: number;
  /** 0 = weak, 1 = fair, 2 = good, 3 = strong. */
  level: 0 | 1 | 2 | 3;
  label: string;
}

/** Dependency-free strength estimate. Pool-size entropy scaled by a repetition
 *  penalty, with a hard floor for known-common passwords. Tuned to nudge, not
 *  to gate — the export button never blocks on strength. */
export function estimatePasswordStrength(pw: string): PasswordStrength {
  if (!pw) return { bits: 0, level: 0, label: "" };

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  pool = Math.max(pool, 2);

  // Repetition penalty: a password using few distinct characters (e.g. "aaaa")
  // gets credited closer to its unique-char count than its raw length.
  const uniq = new Set(pw).size;
  const effLen = pw.length * Math.min(1, uniq / pw.length + 0.25);
  let bits = effLen * Math.log2(pool);

  // Word-phrase ceiling: pool-size entropy badly overcredits plain dictionary
  // words ("cool bean" looks like ~53 random bits but is really a guessable
  // word pair). When the input is purely space/dash/underscore-separated
  // alphabetic tokens, cap at ~11 bits/word (a generous human-vocabulary
  // assumption). A generated passphrase dodges this because its trailing number
  // token isn't alphabetic, so it keeps the full (high) estimate.
  const tokens = pw.split(/[\s\-_]+/).filter(Boolean);
  if (tokens.length >= 1 && tokens.every((t) => /^[a-zA-Z]+$/.test(t))) {
    bits = Math.min(bits, tokens.length * 11);
  }

  if (COMMON.has(pw.toLowerCase())) bits = Math.min(bits, 12);

  const level: PasswordStrength["level"] =
    bits < 36 ? 0 : bits < 56 ? 1 : bits < 76 ? 2 : 3;
  const label = ["Weak — easily guessed", "Fair", "Good", "Strong"][level];
  return { bits, level, label };
}

/** Simple, fast FNV-1a → 8 hex chars. Used only to disambiguate truncated
 *  secret IDs; not security-sensitive. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic Obsidian secretStorage id for a given .stash base name (the
 *  filename WITHOUT the `.stash` extension). Charset is lowercase alphanumeric +
 *  dashes, ≤64 chars (the SecretStorage constraint). Derived purely from the
 *  name + an FNV hash suffix so export-time set and import-time get agree and
 *  truncation collisions are vanishingly unlikely. */
export function secretIdForStashName(baseName: string): string {
  const prefix = "stashpad-";
  const hash = fnv1a(baseName);
  const room = 64 - prefix.length - 1 - hash.length; // "-" + hash
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(0, room))
    .replace(/-+$/g, "");
  return `${prefix}${slug}-${hash}`;
}
