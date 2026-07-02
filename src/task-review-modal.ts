import { App, Modal } from "obsidian";
import type StashpadPlugin from "./main";
import { renderTaskTriage, defaultTaskTriageState, type TaskTriageState } from "./task-render";

/** 0.126.0: a roomier, full-modal "Daily review" for tasks — the same grouped
 *  task triage as the Tasks panel, but with space. Rendering is shared with the
 *  full-tab "All tasks" aggregate via renderTaskTriage. */
export class TaskReviewModal extends Modal {
  private state: TaskTriageState = defaultTaskTriageState();
  constructor(app: App, private plugin: StashpadPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("stashpad-task-review-modal");
    this.titleEl.setText("Daily task review");
    renderTaskTriage(this.contentEl, this.app, this.plugin, this.state, {
      onOpen: (folder, id) => { void this.plugin.revealNoteByRef(folder, id); this.close(); },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
