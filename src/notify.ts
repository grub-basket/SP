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
 *  Migration is a mechanical swap:  `new Notice("x")`      →  `notify("x")`
 *                                    `new Notice("x", 5000)` →  `notify("x", 5000)`
 *  The second arg accepts a bare duration (number, ms) exactly like `Notice`'s
 *  own signature — so a raw `new Notice(msg, dur)` becomes `notify(msg, dur)` with
 *  no argument rewriting — or a full NotifyOptions object for kind/category/etc.
 *  Keep `new Notice(...)` only where the message is a DocumentFragment (the log
 *  records plain strings) or where the Notice HANDLE is used (`.hide()` etc.).
 *
 *  The sink is set by the plugin on load; before that (or if the plugin is
 *  unloaded) notify() falls back to a plain Notice so nothing ever goes missing. */
let sink: NotificationService | null = null;

export function setNotifySink(service: NotificationService | null): void {
  sink = service;
}

export function notify(
  message: string,
  optsOrDuration: Omit<NotifyOptions, "message"> | number = {},
): Notice | null {
  const opts: Omit<NotifyOptions, "message"> =
    typeof optsOrDuration === "number" ? { duration: optsOrDuration } : optsOrDuration;
  if (sink) return sink.show({ message, ...opts });
  return new Notice(message, opts.duration);
}
