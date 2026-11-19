import { Notice, type App, type TAbstractFile } from "obsidian";

/** 0.610.0 — the ONE way Stashpad deletes a vault file. Use this instead of
 *  calling `app.fileManager.trashFile` directly; `scripts/check-trash-file.mjs`
 *  (part of `pnpm run build`) fails the build on a direct call.
 *
 *  Why: up to Obsidian 1.15.0, when the user's "Deleted files" setting was the
 *  system trash and the OS refused the file (some network shares, external or
 *  unusual volumes), Obsidian quietly moved it into the vault's `.trash` folder
 *  instead. From 1.15.1 it does not: `trashFile` resolves to `false` and the
 *  file STAYS where it is. Every Stashpad caller was written assuming the file
 *  is gone afterwards — a delete would leave the note on disk (so it comes back
 *  on the next index), and a cross-folder move would leave a second copy with
 *  the same id behind.
 *
 *  So on `false` this does what Obsidian did before 1.15.1: move the file into
 *  the vault's `.trash`. Nothing is destroyed — the file stays recoverable from
 *  there — and the user is told once per session that it happened.
 *
 *  The installed typings (1.14.4) still declare `Promise<void>`, so the result
 *  is read as `unknown`; on older Obsidian it is `undefined` and nothing
 *  changes. Errors from `trashFile` itself still propagate to the caller, as
 *  before. */
export async function trashVaultFile(app: App, file: TAbstractFile): Promise<void> {
  // trash-file: ok — the sanctioned call.
  const result: unknown = await app.fileManager.trashFile(file);
  if (result !== false) return;
  // Gone anyway (another delete raced us, or Obsidian removed it after all).
  if (app.vault.getAbstractFileByPath(file.path) !== file) return;
  // Deliberately Vault.trash (the store lint's prefer-file-manager-trash-file
  // warns here): FileManager.trashFile is the call that just refused.
  await app.vault.trash(file, false);
  if (!toldFallback) {
    toldFallback = true;
    new Notice(
      "Couldn't move a file to the system trash, so it went to this vault's .trash folder instead. You can restore it from there.",
      10000,
    );
  }
}

let toldFallback = false;
