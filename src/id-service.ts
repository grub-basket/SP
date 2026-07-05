const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newId(len = 6): string {
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
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
