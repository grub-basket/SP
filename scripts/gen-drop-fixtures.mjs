// Fixtures for the dropped-file routing test (0.268.1).
//
// Emits three .stash files to /tmp so a live test can drop a MIXED batch:
//   drop-plain.stash      a real, importable bundle with two notes
//   drop-encrypted.stash  carries the STASHENC magic, so it routes as encrypted
//   drop-corrupt.stash    neither a zip nor an envelope, so it must fail cleanly
//
// The encrypted one is not decryptable, deliberately. Routing only asks "is this
// encrypted", and answering that is the whole job under test; decryption is
// existing machinery this change does not touch. A fixture that needed a real
// password would test the crypto instead of the routing.
//
// Usage: node scripts/gen-drop-fixtures.mjs
import { writeFileSync } from "fs";

const enc = new TextEncoder();
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function zip(files) {
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const ch = [], cen = []; let off = 0;
  for (const f of files) {
    const nb = enc.encode(f.name), d = f.data, crc = crc32(d), s = d.length;
    ch.push(new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(s), ...u32(s), ...u16(nb.length), ...u16(0)]), nb, d);
    cen.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(s), ...u32(s), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
    off += 30 + nb.length + s;
  }
  const cdStart = off; let cdSize = 0;
  for (const c of cen) { ch.push(c); cdSize += c.length; }
  ch.push(new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]));
  const tot = ch.reduce((a, c) => a + c.length, 0), out = new Uint8Array(tot);
  let p = 0; for (const c of ch) { out.set(c, p); p += c.length; }
  return out;
}

const note = (id, parent, body) =>
  enc.encode(`---\nid: ${id}\nparent: ${parent}\ncreated: 2026-08-16T09:00:00\nattachments: []\n---\n${body}`);

// Shape must match StashManifest exactly. The first version of this fixture
// used `schema` and `rootId`, so the importer threw "Unsupported .stash schema"
// on an undefined `stashSchema` and the routing test reported a failure that
// belonged to the fixture rather than the code.
const manifest = enc.encode(JSON.stringify({
  stashSchema: 1,
  exportedAt: "2026-08-16T09:00:00Z",
  sourceFolder: "Fixtures",
  noteCount: 2,
  rootIds: ["dropfix1"],
}, null, 2));

const plain = zip([
  { name: "manifest.json", data: manifest },
  { name: "notes/dropfix1.md", data: note("dropfix1", "__root__", "Dropped bundle note one.") },
  { name: "notes/dropfix2.md", data: note("dropfix2", "dropfix1", "Dropped bundle child note.") },
]);
writeFileSync("/tmp/drop-plain.stash", plain);

// "STASHENC" + a version byte + filler. Enough for isEncryptedStash to say yes.
const magic = enc.encode("STASHENC");
const encrypted = new Uint8Array(magic.length + 64);
encrypted.set(magic, 0);
for (let i = magic.length; i < encrypted.length; i++) encrypted[i] = (i * 7) & 0xff;
writeFileSync("/tmp/drop-encrypted.stash", encrypted);

writeFileSync("/tmp/drop-corrupt.stash", enc.encode("this is not a zip and not an envelope"));

console.log(JSON.stringify({
  plain: plain.length, encrypted: encrypted.length, corrupt: 37,
  wrote: ["/tmp/drop-plain.stash", "/tmp/drop-encrypted.stash", "/tmp/drop-corrupt.stash"],
}, null, 1));
