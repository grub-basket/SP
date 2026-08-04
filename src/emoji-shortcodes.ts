/** `:shortcode:` -> emoji, for notes imported from the Stashpad desktop app.
 *
 *  Stashpad stored shortcodes as literal ASCII and expanded them only when
 *  rendering, so the database really does contain the ten bytes `:pancakes:`.
 *  Obsidian does not expand them, so without this they read as raw text forever.
 *
 *  Deliberately NOT an exhaustive emoji set. A partial map that leaves unknown
 *  codes untouched is safe; a fuzzy matcher that guesses is not, because a wrong
 *  glyph is worse than a visible `:shortcode:` you can still search for.
 */

/** The ones actually seen in the two Stashpad archives, plus the common set
 *  people type. Names follow the GitHub/Slack convention Stashpad used. */
export const EMOJI_SHORTCODES: Readonly<Record<string, string>> = {
  // seen in the archives
  pancakes: "🥞", tada: "🎉", cry: "😢", sob: "😭", smile: "😄", shrug: "🤷",
  upside_down_face: "🙃", face_with_rolling_eyes: "🙄", face_with_symbols_on_mouth: "🤬",
  // faces
  grinning: "😀", smiley: "😃", laughing: "😆", sweat_smile: "😅", joy: "😂", rofl: "🤣",
  wink: "😉", blush: "😊", yum: "😋", sunglasses: "😎", heart_eyes: "😍", thinking: "🤔",
  neutral_face: "😐", expressionless: "😑", confused: "😕", worried: "😟", frowning: "😦",
  cold_sweat: "😰", weary: "😩", tired_face: "😫", angry: "😠", rage: "😡", triumph: "😤",
  sleepy: "😪", sleeping: "😴", mask: "😷", dizzy_face: "😵", scream: "😱", astonished: "😲",
  flushed: "😳", grimacing: "😬", zipper_mouth_face: "🤐", nerd_face: "🤓", star_struck: "🤩",
  partying_face: "🥳", pleading_face: "🥺", exploding_head: "🤯", melting_face: "🫠",
  // hands + people
  thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎", ok_hand: "👌", clap: "👏",
  raised_hands: "🙌", pray: "🙏", muscle: "💪", wave: "👋", point_right: "👉",
  point_left: "👈", point_up: "☝️", point_down: "👇", facepalm: "🤦", eyes: "👀",
  // objects + symbols
  fire: "🔥", sparkles: "✨", star: "⭐", zap: "⚡", boom: "💥", bulb: "💡", rocket: "🚀",
  bell: "🔔", lock: "🔒", key: "🔑", warning: "⚠️", question: "❓", exclamation: "❗",
  white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌", no_entry: "⛔",
  heart: "❤️", broken_heart: "💔", hearts: "💕", hundred: "💯", trophy: "🏆", medal: "🏅",
  pushpin: "📌", paperclip: "📎", memo: "📝", books: "📚", calendar: "📅", chart: "📈",
  hourglass: "⏳", alarm_clock: "⏰", watch: "⌚", moneybag: "💰", gift: "🎁",
  // food + nature
  coffee: "☕", tea: "🍵", beer: "🍺", pizza: "🍕", cake: "🍰", apple: "🍎",
  sun: "☀️", cloud: "☁️", rain: "🌧️", snowflake: "❄️", rainbow: "🌈", seedling: "🌱",
  // animals
  cat: "🐱", dog: "🐶", bug: "🐛", bird: "🐦", fish: "🐟", turtle: "🐢",
};

/** A shortcode is a short run of shortcode-legal characters between colons.
 *
 *  Two traps this must avoid, both hit by the Windows session's first attempt:
 *
 *  1. **Times.** `10:00:15` contains `:00:`. Requiring a letter kills it, and a
 *     `(?<!\d)` guard stops `:15:` matching off the back of a number.
 *  2. **URLs and code.** `http://x` and `a:b:c` in code — the letter requirement
 *     plus the length cap keeps the damage bounded, and an unknown code is left
 *     exactly as it was, so a false positive costs nothing.
 */
const SHORTCODE = /(?<!\d):([a-z0-9][a-z0-9_+-]{0,30}):/gi;

/** True when the token looks like a shortcode rather than a fragment of a
 *  timestamp or a ratio — it has to contain at least one letter. */
const hasLetter = (s: string): boolean => /[a-z]/i.test(s);

export interface ShortcodeResult {
  text: string;
  /** Codes replaced, in order of first appearance. */
  replaced: string[];
  /** Codes that looked like shortcodes but aren't in the map — left untouched. */
  unknown: string[];
}

/** Replace known `:shortcode:`s, annotating each with its name.
 *
 *  Renders as `🥞 (pancakes)` rather than a bare glyph, on purpose: the name
 *  stays searchable, survives a font that cannot draw the glyph, and makes a bad
 *  mapping obvious instead of silent. The archives contain few enough of these
 *  (12 notes here, 17 on the work machine) that the extra words cost nothing.
 */
export function expandShortcodes(text: string, annotate = true): ShortcodeResult {
  const replaced: string[] = [];
  const unknown: string[] = [];
  if (!text || !text.includes(":")) return { text, replaced, unknown };

  const out = text.replace(SHORTCODE, (whole, code: string) => {
    if (!hasLetter(code)) return whole;
    const glyph = EMOJI_SHORTCODES[code.toLowerCase()];
    if (!glyph) {
      if (!unknown.includes(code)) unknown.push(code);
      return whole;
    }
    if (!replaced.includes(code)) replaced.push(code);
    return annotate ? `${glyph} (${code})` : glyph;
  });
  return { text: out, replaced, unknown };
}
