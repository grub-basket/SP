/** 0.272.0: catalog for the per-note quick-action (star) menu.
 *
 *  Plain data, no handlers, in its own module so BOTH the view (which maps each
 *  id to a cmd*) and the settings tab (which lets the user pick which appear)
 *  import it without a circular dependency. Order here is the order shown in
 *  settings; `settings.quickMenuActions` stores the chosen ids in menu order. */
export interface QuickActionDef { id: string; label: string; icon: string; }

export const QUICK_ACTION_CATALOG: readonly QuickActionDef[] = [
  { id: "copy",      label: "Copy",                 icon: "copy" },
  { id: "copyTree",  label: "Copy tree",            icon: "copy-plus" },
  { id: "move",      label: "Move…",                icon: "arrow-right-circle" },
  { id: "clone",     label: "Clone (duplicate)",    icon: "files" },
  { id: "setColor",  label: "Set color…",           icon: "palette" },
  { id: "blur",      label: "Blur / unblur",        icon: "eye-off" },
  { id: "setDue",    label: "Set due date…",        icon: "calendar-clock" },
  { id: "archive",   label: "Move to archive",      icon: "archive" },
  { id: "largeText", label: "Reveal in large text", icon: "maximize" },
  { id: "edit",      label: "Edit in Stashpad",     icon: "pencil-line" },
];
