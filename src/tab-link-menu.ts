import type { Menu, WorkspaceLeaf } from "obsidian";
import type StashpadPlugin from "./main";

/** 0.533.0: the "Copy Stashpad link" entry every Stashpad tab adds to its
 *  pane menu (the tab's ⋯ menu, and right-clicking the tab header). One
 *  helper so the wording, icon and placement are the same on every tab. */
export function addCopyTabLinkItem(menu: Menu, plugin: StashpadPlugin, leaf: WorkspaceLeaf): void {
  if (!plugin.linkForLeaf(leaf)) return;
  menu.addItem((it) => it
    .setTitle("Copy Stashpad link")
    .setIcon("link")
    .setSection("action")
    .onClick(() => { void plugin.copyLinkForLeaf(leaf); }));
}
