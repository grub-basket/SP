/** 0.561.0: one place to set up a Stashpad folder — icon, where it sits in the
 *  folder switcher (pinned / downranked / hidden), blur, and (when the folder
 *  has a key) whether its notes encrypt. Opens after creating a folder (Settings
 *  → Folders & storage → "Set up new folders" turns that off), after splitting a
 *  note out into its own folder, and from "Edit folder…" on a folder-switcher
 *  row. Every control calls an existing setter (setFolderIcon,
 *  setFolderPlacement, setFolderObscured, folderEncPrefs) and only on Done, so
 *  Skip / Escape changes nothing. */
import { Modal, Setting, setIcon, type App } from "obsidian";
import type StashpadPlugin from "./main";
import { IconSuggest } from "./icon-suggest";
import type { FolderPlacement } from "./types";

const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

export class FolderSetupModal extends Modal {
  private icon: string;
  private placement: FolderPlacement;
  private blur: "global" | "on" | "off";
  private encrypt: boolean | null;

  constructor(
    app: App, private plugin: StashpadPlugin, private folder: string,
    private opts: { mode: "new" | "edit"; intro?: string; onDone?: () => void } = { mode: "edit" },
  ) {
    super(app);
    const f = folder.replace(/\/+$/, "");
    this.folder = f;
    const s = plugin.settings;
    this.icon = s.folderIcons?.[f] ?? "";
    this.placement = plugin.folderPlacement(f);
    const ob = s.obscureFolders?.[f];
    this.blur = ob === true ? "on" : ob === false ? "off" : "global";
    // Encryption only for a folder that has a key (setting one up is its own flow).
    this.encrypt = plugin.encryption?.hasFolderKey?.(f) ? s.folderEncPrefs?.[f]?.encryptContent === true : null;
  }

  onOpen(): void {
    this.modalEl.addClass("stashpad-compact-modal", "stashpad-folder-setup-modal");
    this.titleEl.setText(this.opts.mode === "new" ? `Set up “${baseName(this.folder)}”` : `Edit “${baseName(this.folder)}”`);
    const c = this.contentEl;
    c.empty();
    if (this.opts.intro) c.createEl("p", { text: this.opts.intro, cls: "setting-item-description" });

    let preview: HTMLElement | null = null;
    const paintPreview = (): void => {
      if (!preview) return;
      preview.empty();
      setIcon(preview, this.icon.trim() || "layers");
    };
    new Setting(c)
      .setName("Icon")
      .setDesc("Shown on its tab, in the folder switcher and on its folder-panel row. Blank = the default.")
      .addText((t) => {
        t.setPlaceholder("Icon name").setValue(this.icon).onChange((v) => { this.icon = v.trim(); paintPreview(); });
        new IconSuggest(this.app, t.inputEl);
        preview = t.inputEl.parentElement?.createSpan({ cls: "stashpad-folder-setup-icon-preview" }) ?? null;
        paintPreview();
      });

    new Setting(c)
      .setName("In the folder switcher")
      .setDesc("Pinned folders sit at the top, downranked ones at the bottom, hidden ones only show when you search.")
      .addDropdown((d) => d
        .addOptions({ normal: "Normal", pinned: "Pinned to the top", downranked: "Downranked", hidden: "Hidden" })
        .setValue(this.placement)
        .onChange((v) => { this.placement = v as FolderPlacement; }));

    new Setting(c)
      .setName("Blur")
      .setDesc("Obscure this folder's notes until you hover or reveal them.")
      .addDropdown((d) => d
        .addOptions({ global: "Follow the global setting", on: "Always blur", off: "Never blur" })
        .setValue(this.blur)
        .onChange((v) => { this.blur = v as "global" | "on" | "off"; }));

    if (this.encrypt !== null) {
      new Setting(c)
        .setName("Encrypt notes in this folder")
        .setDesc("Marks the folder so its notes get encrypted with its key. Doesn't encrypt anything by itself.")
        .addToggle((t) => t.setValue(this.encrypt === true).onChange((v) => { this.encrypt = v; }));
    }

    new Setting(c)
      .addButton((b) => b.setButtonText(this.opts.mode === "new" ? "Skip" : "Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Done").setCta().onClick(() => void this.apply()));
    // Enter anywhere outside the icon box's suggestion list applies.
    this.scope.register([], "Enter", (e) => {
      const t = e.target as HTMLElement | null;
      // A focused button (Skip / Cancel) or the icon suggestions handle their own Enter.
      if (t?.closest?.(".suggestion-container") || t?.tagName === "BUTTON") return true;
      void this.apply();
      return false;
    });
  }

  private async apply(): Promise<void> {
    const p = this.plugin;
    const f = this.folder;
    const s = p.settings;
    if ((s.folderIcons?.[f] ?? "") !== this.icon) await p.setFolderIcon(f, this.icon || undefined);
    if (p.folderPlacement(f) !== this.placement) await p.setFolderPlacement(f, this.placement);
    const ob = s.obscureFolders?.[f];
    const curBlur = ob === true ? "on" : ob === false ? "off" : "global";
    if (curBlur !== this.blur) await p.setFolderObscured(f, this.blur === "global" ? null : this.blur === "on");
    if (this.encrypt !== null && (s.folderEncPrefs?.[f]?.encryptContent === true) !== this.encrypt) {
      const prefs = s.folderEncPrefs ?? {};
      s.folderEncPrefs = { ...prefs, [f]: { ...(prefs[f] ?? {}), encryptContent: this.encrypt } };
      await p.saveSettings();
    }
    this.close();
    this.opts.onDone?.();
  }

  onClose(): void { this.contentEl.empty(); }
}

/** Open the setup modal for `folder` (a convenience for callers). */
export function openFolderSetup(plugin: StashpadPlugin, folder: string, opts?: ConstructorParameters<typeof FolderSetupModal>[3]): void {
  new FolderSetupModal(plugin.app, plugin, folder, opts).open();
}
