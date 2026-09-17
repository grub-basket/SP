import { Notice } from "obsidian";
import type { NotificationService, NotifyOptions } from "./notifications";

/** 0.416.0: the one-word notification shorthand.
 *
 *  Every toast Stashpad shows should go through `notify()` so it lands in the
 *  persistent notification log (NotificationService: recorded, survives reload,
 *  viewable in the "Stashpad notifications" tab). Raw `new Notice(...)` calls
 *  bypass the log — and since they're bundled with a fixed `Notice` reference
 *  they can't be intercepted by patching, so the fix is to route them here.
 *
 *  Migration is a mechanical swap:  `new Notice("x")`  →  `notify("x")`
 *                                    `new Notice("x", 0)` →  `notify("x", { duration: 0 })`
 *  Keep `new Notice(...)` only where the message is a DocumentFragment (the log
 *  records plain strings) or where the Notice HANDLE is used (`.hide()` etc.).
 *
 *  The sink is set by the plugin on load; before that (or if the plugin is
 *  unloaded) notify() falls back to a plain Notice so nothing ever goes missing. */
let sink: NotificationService | null = null;

export function setNotifySink(service: NotificationService | null): void {
  sink = service;
}

export function notify(message: string, opts: Omit<NotifyOptions, "message"> = {}): Notice | null {
  if (sink) return sink.show({ message, ...opts });
  return new Notice(message, opts.duration);
}
