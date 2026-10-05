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
import { App, Modal, Setting, type EventRef } from "obsidian";
import { notify } from "./notify";
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
  /** Bring up the folder switcher + panels once the folder exists. */
  private openPanels = true;
  /** Set when a button handler runs, so onClose can tell "user picked
   *  something" from "user dismissed with Escape / the X". */
  private choice: OnboardingChoice | null = null;
  private busy = false;
  /** 0.531.0: opened by the first-run check (not from Help / the command). An
   *  automatic welcome steps aside if a Stashpad turns up while it's open — a
   *  slow network drive or a sync can deliver the existing folders late. */
  private auto: boolean;

  constructor(app: App, plugin: StashpadPlugin, opts: { auto?: boolean } = {}) {
    super(app);
    this.plugin = plugin;
    this.auto = opts.auto === true;
  }

  private cacheRefs: EventRef[] = [];
  private recheckTimer: number | null = null;

  /** Automatic welcome only: if the vault turns out to have a Stashpad after
   *  all (late index / sync), close without writing anything and say so. */
  private watchForExistingStashpad(): void {
    // Trailing debounce: during a long cold index every parsed note in a new
    // folder drops the folder memo, so check once the burst goes quiet rather
    // than re-walking the vault every 400 ms.
    const recheck = (): void => {
      if (this.recheckTimer !== null) window.clearTimeout(this.recheckTimer);
      this.recheckTimer = window.setTimeout(() => {
        this.recheckTimer = null;
        if (this.busy || this.choice) return;
        const found = this.plugin.discoverStashpadFolders();
        if (!found.length) return;
        this.choice = "later";
        this.close();
        const name = found.length === 1 ? `"${found[0]}"` : `${found.length} Stashpads`;
        notify(`Stashpad: found ${name} in this vault, so setup isn't needed. Open it from the Stashpad icon.`, 10000);
      }, 400);
    };
    const mc = this.app.metadataCache;
    this.cacheRefs.push(mc.on("changed", recheck), mc.on("resolved", recheck));
  }

  onOpen(): void {
    if (this.auto) this.watchForExistingStashpad();
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

    // 0.266.7: setup can bring up the sidebars too.
    //
    // Both panels have had their own commands for a long time, but a new user
    // has no reason to guess they exist — so setup finished with a bare list
    // and the two surfaces that make the plugin legible (folder switcher,
    // pinned/task panels) stayed hidden until someone went looking. Opt-out
    // rather than opt-in: on first run the roomier layout is the one worth
    // showing, and closing a sidebar is obvious in a way that discovering one
    // is not.
    new Setting(contentEl)
      .setName("Open the side panels too")
      .setDesc("Shows the folder switcher and the Stashpad panels alongside the list.")
      .addToggle((t) => t.setValue(this.openPanels).onChange((v) => { this.openPanels = v; }));

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
    let folder = this.resolvedFolder();
    try {
      // 0.528.0: a name inside an existing Stashpad is redirected to the vault
      // root; `folder` becomes where it actually went, and the notice says why.
      if (choice === "demo") {
        const { created, skipped, folder: made, message } = await seedDemoContent(this.app, this.plugin, folder);
        folder = made;
        if (message) notify(`Stashpad: ${message}`, 10000);
        if (created > 0 || !message) {
          notify(
            `Stashpad: created "${folder}" with ${created} example note${created === 1 ? "" : "s"}` +
              (skipped > 0 ? ` (${skipped} skipped — those files already existed)` : ""),
            8000,
          );
        }
      } else {
        const { folder: made, message } = await this.plugin.createNewStashpad(folder);
        folder = made;
        notify(message ? `Stashpad: ${message}` : `Stashpad: created "${folder}".`, message ? 10000 : 6000);
      }
      this.choice = choice;
      this.close();
      await this.plugin.openFolderInStashpad(folder);
      // AFTER the list is open, so the sidebars attach around an existing view
      // rather than racing it. Failing to open a panel must not turn a
      // successful setup into an error notice — the folder is made either way.
      if (this.openPanels) {
        try { await this.plugin.openSetupPanels(); }
        catch (e) { console.warn("[Stashpad] setup: opening panels failed", e); }
      }
    } catch (e) {
      this.busy = false;
      const msg = e instanceof Error ? e.message : String(e);
      // Stay open on failure so the user can fix the name and retry, rather
      // than losing the modal and having to find it again.
      notify(`Stashpad: couldn't create "${folder}" — ${msg}`, 0);
    }
  }

  onClose(): void {
    for (const ref of this.cacheRefs) this.app.metadataCache.offref(ref);
    this.cacheRefs = [];
    if (this.recheckTimer !== null) { window.clearTimeout(this.recheckTimer); this.recheckTimer = null; }
    // Any exit is an answer, including Escape and the close button: the user
    // has seen the offer, and re-asking every launch would be nagging. They can
    // always reopen it from Settings → Help & Getting started.
    void this.plugin.markOnboardingAnswered(this.choice ?? "later");
    // 0.484.1: release the single-instance slot so the welcome can be reopened
    // later (Settings -> Help, command palette). Guarded so a stale instance
    // can't clear a newer one's claim.
    if (this.plugin.welcomeModal === this) this.plugin.welcomeModal = null;
    this.contentEl.empty();
  }
}
