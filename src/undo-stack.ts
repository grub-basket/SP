export interface UndoAction {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
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
    try { await a.redo(); } catch (e) { console.error("Stashpad: redo failed", e); throw e; }
    this.undoStack.push(a);
    return a;
  }

  peekUndoLabel(): string | null { return this.undoStack[this.undoStack.length - 1]?.label ?? null; }
  peekRedoLabel(): string | null { return this.redoStack[this.redoStack.length - 1]?.label ?? null; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  clear(): void { this.undoStack = []; this.redoStack = []; }
}
