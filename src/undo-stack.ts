export interface UndoAction {
  label: string;
  undo: () => Promise<void>;
  /** Optional: some actions are undo-only (no forward re-apply). redo() no-ops
   *  for those instead of crashing on a missing handler (was a latent bug — a few
   *  push sites omit redo, so redoing them called `undefined()`). */
  redo?: () => Promise<void>;
}

export class UndoStack {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];
  private cap = 30;

  push(action: UndoAction): void {
    this.undoStack.push(action);
    this.redoStack.length = 0;
    while (this.undoStack.length > this.cap) this.undoStack.shift();
  }

  async undo(): Promise<UndoAction | null> {
    const a = this.undoStack.pop();
    if (!a) return null;
    try { await a.undo(); } catch (e) { console.error("Stashpad: undo failed", e); throw e; }
    this.redoStack.push(a);
    return a;
  }

  async redo(): Promise<UndoAction | null> {
    const a = this.redoStack.pop();
    if (!a) return null;
    // Undo-only actions have no redo handler — moving them back to the undo
    // stack without re-applying is correct (and was previously a crash).
    if (a.redo) { try { await a.redo(); } catch (e) { console.error("Stashpad: redo failed", e); throw e; } }
    this.undoStack.push(a);
    return a;
  }

  peekUndoLabel(): string | null { return this.undoStack[this.undoStack.length - 1]?.label ?? null; }
  peekRedoLabel(): string | null { return this.redoStack[this.redoStack.length - 1]?.label ?? null; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  clear(): void { this.undoStack = []; this.redoStack = []; }
}
