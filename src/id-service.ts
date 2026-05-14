const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newId(len = 6): string {
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}
