import { App, SuggestModal, TFile } from "obsidian";
import type { TreeIndex } from "./tree-index";
import type { TreeNode } from "./types";
import { ROOT_ID } from "./types";

export interface PickerItem {
  id: string;
  label: string;
  node: TreeNode | null;
  /** Item kinds:
   *  - "note": ordinary local-or-cross-folder note pick.
   *  - "create": "Create new: <query>" virtual pick.
   *  - "folder-open": pick a Stashpad folder — caller opens it in a new
   *    tab. Carries `folder` but no node. 0.57.3. */
  kind: "note" | "create" | "folder-open";
  bodyPreview?: string; // for search mode
  matchLine?: number;
  /** For cross-folder results: the source folder + raw TFile so the
   *  caller can switch view + focus appropriately. Empty/undefined for
   *  local (current-tree) results. */
  crossFolder?: string;
  crossFile?: TFile;
  /** For "folder-open" items: the folder path to open in a new tab. */
  folder?: string;
}

/** A cross-folder note loaded from another Stashpad. Shaped to plug into
 *  the same render/filter machinery as in-tree notes without inventing a
 *  full synthetic TreeNode. */
export interface CrossFolderNote {
  /** Optional — synthetic root entries (one per external Stashpad folder)
   *  carry no underlying TFile. The picker treats them as "Home of that
   *  folder" pick targets. 0.57.2. */
  file?: TFile;
  folder: string;
  /** Note's id from frontmatter (or ROOT_ID for synthetic roots). */
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
      /** Optional source of Stashpad folder paths. When provided, folders
       *  whose name matches the query show up as their own "open this
       *  folder in a new tab" pick. Used by the search modal. 0.57.3. */
      folderResults?: () => string[];
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
        // Skip the synthetic-root entries (no TFile to read).
        if (!n.cross.file) continue;
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
    // 0.57.0: token-order-agnostic matching. Same approach as the
    // composer's `[[` link autocomplete — split on whitespace and require
    // every token to appear somewhere in the haystack (any order). So
    // "B and A" matches a note titled "A and B". Empty query matches
    // everything.
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    const matchesAll = (haystack: string): boolean => {
      if (!tokens.length) return true;
      for (const t of tokens) if (!haystack.includes(t)) return false;
      return true;
    };
    // For search mode's per-line matchLine: a line is a match when it
    // contains EVERY token (token-order-agnostic on a single line).
    const lineMatchesAll = (line: string): boolean => matchesAll(line.toLowerCase());

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
          const titleHit = matchesAll(n.title.toLowerCase());
          const lines = n.body.split(/\r?\n/);
          let matchLine = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lineMatchesAll(lines[i])) { matchLine = i; break; }
          }
          // Body-anywhere match (tokens scattered across multiple lines)
          // — show the row even if no single line contains every token.
          // matchLine stays -1; the preview falls back to body start.
          const bodyHit = matchLine !== -1 || matchesAll(n.body.toLowerCase());
          if (!titleHit && !bodyHit) continue;
          out.push(buildItem(n, matchLine));
        } else {
          // pick mode — tokens must all appear in title OR body.
          if (q && !matchesAll(n.title.toLowerCase()) && !matchesAll(n.body.toLowerCase())) continue;
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
    // 0.57.2: loosened pick-mode rule — cross-folder results always
    // appear when the user has typed a query (was gated to
    // localItems.length < 30, which hid them in mid-sized vaults where
    // many local notes happened to match). Empty-query pick mode stays
    // local-only for performance.
    const crossWanted = this.opts.mode === "search"
      ? (q ? true : localItems.length < 10)
      : (q ? true : false);
    if (crossWanted) {
      const crossItems = matchTier(cross);
      // Cap the local tier so the user sees the cross-folder section
      // come up without scrolling through hundreds of local hits.
      if (this.opts.mode === "search" && !q) items.length = Math.min(items.length, 50);
      items.push(...crossItems);
    }

    // 0.57.3: folder-open results — prepended to the list so they're easy
    // to spot when a query matches a folder name. Each one opens the
    // folder's home in a new tab via the caller's onPick.
    if (this.opts.folderResults) {
      const folders = this.opts.folderResults();
      const folderItems: PickerItem[] = [];
      for (const folder of folders) {
        // Token-order match against the folder's last path segment AND
        // the full path (so the user can match by either).
        const last = folder.split("/").pop() ?? folder;
        const haystack = `${folder.toLowerCase()} ${last.toLowerCase()}`;
        if (!matchesAll(haystack)) continue;
        folderItems.push({
          id: `folder:${folder}`,
          label: `Open folder “${last}” in a new tab`,
          node: null,
          kind: "folder-open",
          folder,
        });
      }
      if (folderItems.length) items.unshift(...folderItems);
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
    if (item.kind === "folder-open") {
      el.addClass("is-folder-open");
      el.createDiv({ cls: "stashpad-suggest-title", text: item.label });
      if (item.folder) el.createDiv({ cls: "stashpad-suggest-preview", text: item.folder });
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
