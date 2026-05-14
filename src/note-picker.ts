import { App, SuggestModal, TFile } from "obsidian";
import type { TreeIndex } from "./tree-index";
import type { TreeNode } from "./types";
import { ROOT_ID } from "./types";

export interface PickerItem {
  id: string;
  label: string;
  node: TreeNode | null;
  kind: "note" | "create";
  bodyPreview?: string; // for search mode
  matchLine?: number;
  /** For cross-folder results: the source folder + raw TFile so the
   *  caller can switch view + focus appropriately. Empty/undefined for
   *  local (current-tree) results. */
  crossFolder?: string;
  crossFile?: TFile;
}

/** A cross-folder note loaded from another Stashpad. Shaped to plug into
 *  the same render/filter machinery as in-tree notes without inventing a
 *  full synthetic TreeNode. */
export interface CrossFolderNote {
  file: TFile;
  folder: string;
  /** Note's id from frontmatter (just for stable item ids in the list). */
  id: string;
  /** Rendered title/label (basename minus the trailing -id, with dashes
   *  → spaces). */
  title: string;
  /** Pre-loaded body text (the picker will lazy-read if blank). */
  body: string;
  /** Pre-loaded parent body's first line, prefixed with "Parent: " by
   *  the renderer. Optional. */
  parentBlurb?: string;
}

interface NoteBody {
  node: TreeNode | null;
  title: string;
  body: string;
  /** When set, this entry is from another Stashpad. */
  cross?: CrossFolderNote;
}

export class StashpadSuggest extends SuggestModal<PickerItem> {
  private notes: NoteBody[] = [];

  constructor(
    app: App,
    private tree: TreeIndex,
    private titleFn: (n: TreeNode) => string,
    private opts: {
      mode: "pick" | "search";
      placeholder?: string;
      allowCreate?: boolean;
      onPick: (item: PickerItem) => void;
      onCreate?: (query: string) => void;
      /** Optional source for cross-folder notes. Resolved lazily when
       *  the user starts typing — local results from `tree` are returned
       *  first, and this source is queried only after the local set is
       *  exhausted (or to fill out short result lists). */
      crossFolderNotes?: () => CrossFolderNote[];
    },
  ) {
    super(app);
    this.setPlaceholder(opts.placeholder ?? (opts.mode === "search" ? "Search notes…" : "Pick a note…"));
    this.loadAll();
  }

  private loadAll(): void {
    const walk = (id: string, depth: number): void => {
      const node = this.tree.get(id);
      if (node?.file && id !== ROOT_ID) {
        this.notes.push({ node, title: `${"  ".repeat(depth)}${this.titleFn(node)}`, body: "" });
      } else if (node?.file && id === ROOT_ID) {
        this.notes.push({ node, title: "Home", body: "" });
      }
      for (const c of this.tree.getChildren(id)) walk(c.id, depth + 1);
    };
    const rootNode = this.tree.getRoot();
    if (rootNode.file) this.notes.push({ node: rootNode, title: "Home", body: "" });
    for (const c of this.tree.getChildren(ROOT_ID)) walk(c.id, 1);

    // lazy-read bodies in background
    for (const n of this.notes) {
      if (!n.node?.file) continue;
      this.app.vault.cachedRead(n.node.file).then((md) => { n.body = this.stripFm(md); });
    }

    // Cross-folder notes (loaded once on first request, then cached on
    // this.notes alongside local entries — kept distinguished by the
    // .cross marker for tier ordering and rendering).
    if (this.opts.crossFolderNotes) {
      const cross = this.opts.crossFolderNotes();
      for (const c of cross) {
        this.notes.push({ node: null, title: c.title, body: c.body, cross: c });
      }
      for (const n of this.notes) {
        if (!n.cross || n.body) continue;
        this.app.vault.cachedRead(n.cross.file).then((md) => { n.body = this.stripFm(md); });
      }
    }
  }

  private stripFm(md: string): string {
    if (!md.startsWith("---")) return md;
    const end = md.indexOf("\n---", 3);
    return end === -1 ? md : md.slice(end + 4).replace(/^\r?\n/, "");
  }

  getSuggestions(query: string): PickerItem[] {
    const q = query.trim().toLowerCase();
    // Tier the candidates: local first (notes from the active tree),
    // then cross-folder (notes from other Stashpads). The user wanted
    // cross-folder results to appear AFTER the local ones rather than
    // intermingled, and only "kick in" once the local tier has been
    // exhausted (or shown as available).
    const local = this.notes.filter((n) => !n.cross);
    const cross = this.notes.filter((n) => n.cross);

    const buildItem = (n: NoteBody, matchLine: number): PickerItem => ({
      id: n.cross ? `cross:${n.cross.id}` : n.node!.id,
      label: n.title,
      node: n.node,
      kind: "note",
      bodyPreview: this.previewFromBody(n.body, matchLine),
      matchLine,
      crossFolder: n.cross?.folder,
      crossFile: n.cross?.file,
    });

    const matchTier = (tier: NoteBody[]): PickerItem[] => {
      const out: PickerItem[] = [];
      for (const n of tier) {
        if (this.opts.mode === "search") {
          if (!q) { out.push(buildItem(n, -1)); continue; }
          const titleHit = n.title.toLowerCase().includes(q);
          const lines = n.body.split(/\r?\n/);
          let matchLine = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(q)) { matchLine = i; break; }
          }
          if (!titleHit && matchLine === -1) continue;
          out.push(buildItem(n, matchLine));
        } else {
          // pick mode
          if (q && !n.title.toLowerCase().includes(q) && !n.body.toLowerCase().includes(q)) continue;
          out.push(buildItem(n, -1));
        }
      }
      return out;
    };

    const localItems = matchTier(local);
    const items: PickerItem[] = [...localItems];
    // Only consult the cross-folder tier when local results are sparse
    // OR when the user is in search mode with a real query (so they can
    // discover cross-folder hits). Pick mode without a query keeps the
    // list local for performance.
    const crossWanted = this.opts.mode === "search"
      ? (q ? true : localItems.length < 10)
      : (q ? localItems.length < 30 : false);
    if (crossWanted) {
      const crossItems = matchTier(cross);
      // Cap the local tier so the user sees the cross-folder section
      // come up without scrolling through hundreds of local hits.
      if (this.opts.mode === "search" && !q) items.length = Math.min(items.length, 50);
      items.push(...crossItems);
    }

    if (this.opts.allowCreate && q && !items.some((i) => i.label.trim().toLowerCase() === q)) {
      items.push({ id: `__create__`, label: `Create new: "${query}"`, node: null, kind: "create" });
    }
    return items;
  }

  private previewFromBody(body: string, matchLine: number): string {
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) return "";
    if (matchLine < 0) return lines.slice(0, 3).join("\n");
    const start = Math.max(0, matchLine - 1);
    const end = Math.min(lines.length, matchLine + 2);
    return lines.slice(start, end).join("\n");
  }

  renderSuggestion(item: PickerItem, el: HTMLElement): void {
    el.addClass("stashpad-suggest-item");
    if (item.kind === "create") {
      el.createDiv({ cls: "stashpad-suggest-create", text: item.label });
      return;
    }
    if (item.crossFolder) el.addClass("is-cross-folder");

    // Locate the underlying NoteBody so we can render body + parent body.
    const note = this.notes.find((n) => {
      if (item.crossFolder) return n.cross?.id === item.id.replace(/^cross:/, "");
      return n.node?.id === item.id;
    });
    // Top line: body's first non-empty line (or fallback to the label).
    const bodyTop = this.firstLineOfBody(note?.body ?? "") || item.label.trim();
    const top = el.createDiv({ cls: "stashpad-suggest-title", text: bodyTop });
    if (item.crossFolder) {
      top.createSpan({
        cls: "stashpad-suggest-folder",
        text: ` · ${item.crossFolder.split("/").pop() || item.crossFolder}`,
      });
    }
    // Bottom line: parent body. For local results, walk the tree. For
    // cross-folder results, the loader pre-supplies parentBlurb.
    let parentBlurb = "";
    if (item.crossFolder) parentBlurb = note?.cross?.parentBlurb ?? "";
    else parentBlurb = this.parentBlurbFor(item.node);
    if (parentBlurb) {
      const prev = el.createDiv({ cls: "stashpad-suggest-preview" });
      prev.setText(`Parent: ${parentBlurb}`);
    }
  }

  /** First non-empty line of a body string, with markdown noise trimmed. */
  private firstLineOfBody(body: string): string {
    if (!body) return "";
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return "";
  }

  /** First non-empty body line of the given node's parent. Reads from the
   *  already-loaded body cache (lazy reads populate it in the background;
   *  the line just won't render until that resolves). */
  private parentBlurbFor(node: TreeNode | null): string {
    if (!node || !node.parent || node.parent === ROOT_ID) return "";
    const parent = this.tree.get(node.parent);
    if (!parent || !parent.file) return "";
    const parentEntry = this.notes.find((n) => n.node?.id === parent.id);
    return parentEntry ? this.firstLineOfBody(parentEntry.body) : "";
  }

  onChooseSuggestion(item: PickerItem): void {
    if (item.kind === "create" && this.opts.onCreate) {
      this.opts.onCreate((this as any).inputEl?.value ?? "");
      return;
    }
    this.opts.onPick(item);
  }
}
