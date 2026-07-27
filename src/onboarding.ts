/** First-run onboarding.
 *
 *  Before this existed, enabling Stashpad gave you four ribbon icons and no
 *  greeting; the first ribbon click silently wrote a folder, a Home note and two
 *  subfolders into your vault with no prompt, and left you looking at a pane
 *  containing one sentence. The concept the whole plugin rests on — a Stashpad
 *  is just a folder holding a note whose frontmatter has `id` and `parent` — was
 *  explained in exactly one place: a settings subsection about search scope,
 *  which vanished as soon as you had a folder.
 *
 *  So: ask first, explain once, and offer a demo. The modal is deliberately the
 *  ONLY thing that writes to the vault on first run — nothing is created until
 *  the user picks "fresh" or "demo".
 */
import { App, Modal, Notice, Setting } from "obsidian";
import { seedDemoContent, DEMO_NOTE_COUNT } from "./demo-content";
import { FolderSuggest } from "./folder-suggest";
import type StashpadPlugin from "./main";

/** The folder name used when the user clears the field / doesn't type one.
 *  Capitalized deliberately — it becomes a visible folder in their vault, and
 *  "stashpad" lowercase looks like a config directory. */
export const DEFAULT_STASHPAD_FOLDER = "Stashpad";

export type OnboardingChoice = "later" | "fresh" | "demo";

/**
 * Should we bother the user at all?
 *
 * Two independent gates, both must pass:
 *  1. They have ZERO Stashpad folders. Anyone with even one has already found
 *     their way in, and a welcome modal would be pure noise. This is the count
 *     check — it re-evaluates every load, so a user who deletes all their
 *     Stashpads doesn't get re-onboarded unless gate 2 also allows it.
 *  2. They haven't already answered. "Set up later" is an answer; it persists,
 *     so the modal asks once and never nags.
 */
export function shouldShowWelcome(plugin: StashpadPlugin): boolean {
  if (plugin.settings.onboardingAnswered) return false;
  return plugin.discoverStashpadFolders().length === 0;
}

export class WelcomeModal extends Modal {
  private plugin: StashpadPlugin;
  private folderName = DEFAULT_STASHPAD_FOLDER;
  /** Set when a button handler runs, so onClose can tell "user picked
   *  something" from "user dismissed with Escape / the X". */
  private choice: OnboardingChoice | null = null;
  private busy = false;

  constructor(app: App, plugin: StashpadPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("stashpad-welcome");

    contentEl.createEl("h2", { text: "Welcome to Stashpad" });

    contentEl.createEl("p", {
      cls: "stashpad-welcome-lede",
      text:
        "Stashpad turns a folder in your vault into a chat-style outliner: type a line, " +
        "it becomes a note; nest notes under each other to build a tree you can drill into.",
    });

    contentEl.createEl("p", {
      cls: "stashpad-welcome-detail",
      text:
        "A Stashpad is just an ordinary folder of ordinary markdown notes — nothing is " +
        "locked in a database. You can have as many as you like, and delete one by " +
        "deleting the folder.",
    });

    new Setting(contentEl)
      .setName("Folder name")
      .setDesc("Where your notes will live. A vault-relative path works too (e.g. \"Notes/Stashpad\").")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_STASHPAD_FOLDER)
          .setValue(this.folderName)
          .onChange((v) => {
            this.folderName = v;
          });
        // Every field naming a vault entity gets autocomplete — an existing
        // folder is a legitimate choice here (it becomes a Stashpad once the
        // Home note lands in it), so suggest them. Free text still allowed.
        new FolderSuggest(this.app, text.inputEl);
        text.inputEl.addClass("stashpad-welcome-input");
        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 0);
      });

    const buttons = contentEl.createDiv({ cls: "stashpad-welcome-buttons" });

    const laterBtn = buttons.createEl("button", { text: "Set up later" });
    laterBtn.addEventListener("click", () => {
      this.choice = "later";
      this.close();
    });

    const freshBtn = buttons.createEl("button", { text: "Set up fresh" });
    freshBtn.addEventListener("click", () => void this.run("fresh"));

    const demoBtn = buttons.createEl("button", { text: "Set up with demo content", cls: "mod-cta" });
    demoBtn.addEventListener("click", () => void this.run("demo"));

    contentEl.createEl("p", {
      cls: "stashpad-welcome-footnote",
      text:
        `"Demo content" writes ${DEMO_NOTE_COUNT} example notes (a trip, a reading list, a few tasks) ` +
        "so you can see the nesting in action. They're normal notes — delete them whenever. " +
        "\"Set up later\" writes nothing at all.",
    });
  }

  /** Resolve the folder the user asked for, falling back to the capitalized
   *  default when the field is blank or whitespace. */
  private resolvedFolder(): string {
    const cleaned = this.folderName.trim().replace(/^\/+|\/+$/g, "");
    return cleaned || DEFAULT_STASHPAD_FOLDER;
  }

  private async run(choice: OnboardingChoice): Promise<void> {
    if (this.busy) return; // double-click guard: seeding is not instant
    this.busy = true;
    const folder = this.resolvedFolder();
    try {
      if (choice === "demo") {
        const { created, skipped } = await seedDemoContent(this.app, this.plugin, folder);
        new Notice(
          `Stashpad: created "${folder}" with ${created} example note${created === 1 ? "" : "s"}` +
            (skipped > 0 ? ` (${skipped} skipped — those files already existed)` : ""),
          8000,
        );
      } else {
        await this.plugin.createNewStashpad(folder);
        new Notice(`Stashpad: created "${folder}".`, 6000);
      }
      this.choice = choice;
      this.close();
      await this.plugin.openFolderInStashpad(folder);
    } catch (e) {
      this.busy = false;
      const msg = e instanceof Error ? e.message : String(e);
      // Stay open on failure so the user can fix the name and retry, rather
      // than losing the modal and having to find it again.
      new Notice(`Stashpad: couldn't create "${folder}" — ${msg}`, 0);
    }
  }

  onClose(): void {
    // Any exit is an answer, including Escape and the close button: the user
    // has seen the offer, and re-asking every launch would be nagging. They can
    // always reopen it from Settings → Help & Getting started.
    void this.plugin.markOnboardingAnswered(this.choice ?? "later");
    this.contentEl.empty();
  }
}
