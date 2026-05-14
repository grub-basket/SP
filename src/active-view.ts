let active: any = null;
const listeners = new Set<() => void>();

export function setActiveView(v: any): void {
  if (active === v) return;
  active = v;
  for (const fn of listeners) fn();
}
export function getActiveView(): any { return active; }
export function clearActiveView(v: any): void {
  if (active === v) {
    active = null;
    for (const fn of listeners) fn();
  }
}
export function onActiveViewChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
