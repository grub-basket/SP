// Run via `node scripts/tests/run.mjs`.
import { isConflictCopy } from "../../src/conflict-copy";

const assert = (globalThis as any).__assert as (c: boolean, m: string) => void;

const yes = [
  "Folder/Note (Conflicted copy MacBook 202610291001).md",
  "Folder/Note (conflicted copy 2026-10-29 100102).md",
  "Note (Alex's conflicted copy 2026-10-29).md",            // Dropbox
  "Note (Alex’s conflicted copy 2026-10-29).md",            // curly apostrophe
  "Note (Alex's conflicted copy 2026-10-29) (1).md",        // extra suffix after it
  "Note (CONFLICTED COPY).md",
  "Note (sync-conflict 2026).md",
  "Note.sync-conflict-20261029-100102-ABCDEFG.md",            // Syncthing
  "a/b/c/Note (conflicted copy).txt",
  "Note (conflicted copy)",                                   // no extension
  "Note (conflicted copy 2026.10.29)",                        // dots inside the marker
  "Note (conflicted copy 2026.10.29).md",
  "Note (Conflicted copy Alex's MacBook Pro (2) 202610291001).md", // nested parens in the device name
  "Note (MacBook Pro (2)'s conflicted copy 2026-10-29).md",
  "Drawing (conflicted copy).excalidraw.md",                  // compound extension
  "Note (conflicted copy).tar.gz",
  "Note.sync-conflict-20261029-100102-ABCDEFG 1.md",          // renamed Syncthing copy
  "Note (conflicted copy 2026-10-29) 1.md",                   // de-duped by the app
];
const no = [
  "Folder/Note.md",
  "Resolving a conflict.md",
  "Conflict copy notes.md",
  "Why (conflicted copy) files appear - notes.md",            // marker not at the right end
  "Note (draft).md",
  "Note (conflicted copy).md/child.md",                       // only the basename counts
  "conflicted copy.md",                                       // no parentheses
  "Note (unconflicted copying).md",
  "Why (conflicted copy) happens 2.md",                       // words, not just a number, after it
  "Note (Case Conflict).md",
];
for (const p of yes) assert(isConflictCopy(p), `should be a conflict copy: ${p}`);
for (const p of no) assert(!isConflictCopy(p), `should NOT be a conflict copy: ${p}`);
