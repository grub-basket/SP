const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** The same alphabet minus the digits. The FIRST character is drawn from this.
 *
 *  Why: frontmatter is YAML, and an id of all digits round-trips as a NUMBER.
 *  `489944` came back as 489944, every `typeof fm.id === "string"` guard in the
 *  plugin read it as "no id", the note was adopted, a fresh id was minted, and
 *  its 49 children were left pointing at an id that no longer existed. The same
 *  applies to shapes like `93e638` (scientific notation) and `22e527` (which
 *  overflows to Infinity, so an isFinite check calls it safe).
 *
 *  Measured against the full alphabet, 0.0345% of six-character ids are
 *  hazardous - about 4 or 5 notes in an archive of 13,000, each taking its
 *  whole subtree. Forcing a leading LETTER makes the entire class impossible:
 *  no YAML scalar beginning with a letter parses as a number, and the alphabet
 *  already excludes the words YAML reads as booleans or null.
 *
 *  Costs 1/8 of the keyspace (1.07e9 -> 1.34e8 at length 6). freshId already
 *  checks candidates against the folder, so collisions stay handled. */
const FIRST_ALPHABET = "abcdefghijkmnpqrstuvwxyz";

export function newId(len = 6): string {
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) {
    const alpha = i === 0 ? FIRST_ALPHABET : ALPHABET;
    out += alpha[buf[i] % alpha.length];
  }
  return out;
}

/** Read an id that YAML may have already turned into a number.
 *
 *  Existing notes minted before the rule above can carry a numeric id, and the
 *  guards throughout the plugin test `typeof === "string"` - which is precisely
 *  how a note becomes "unidentified" and gets adopted. Coercing here means an
 *  already-damaged note is recognised rather than re-minted. */
export function readId(value: unknown): string | null {
  if (typeof value === "string") return value;
  // A number here is the YAML round-trip bug, not a legitimate value.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Generate an id that `isUsed` rejects — dedup-at-creation. 6 chars over a
 *  32-char alphabet is ~1.07e9 ids, so the birthday bound gives a ~4% collision
 *  chance at 10k notes and near-certainty in the hundreds of thousands; checking
 *  the candidate makes minting correct at ANY scale (you never write a dup).
 *  Retries at length 6, then widens to 8..16 as a last resort, then throws
 *  rather than return a known-colliding id. */
export function freshId(isUsed: (id: string) => boolean, len = 6): string {
  for (let i = 0; i < 100; i++) {
    const c = newId(len);
    if (!isUsed(c)) return c;
  }
  for (let wider = Math.max(len + 2, 8); wider <= 16; wider += 2) {
    for (let i = 0; i < 20; i++) {
      const c = newId(wider);
      if (!isUsed(c)) return c;
    }
  }
  throw new Error("Could not generate a unique note id");
}
