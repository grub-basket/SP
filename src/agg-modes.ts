/** 0.130.0: shared view-mode chip bar for the unified Trash and Archive tabs, so
 *  both offer the exact same modes:
 *   - byfolder    — per-folder grouped lists (how Archive looked originally)
 *   - separated   — an Encrypted section + an Unencrypted section (kind split)
 *   - mixed       — one flat list, newest-first (by date)
 *   - encrypted   — only encrypted/locked items
 *   - unencrypted — only plain items
 */
import { setIcon } from "obsidian";

export type AggMode = "byfolder" | "separated" | "mixed" | "encrypted" | "unencrypted";

export const DEFAULT_AGG_MODE: AggMode = "byfolder";

export function renderAggModeBar(
  host: HTMLElement,
  current: AggMode,
  counts: { total: number; enc: number; dec: number },
  onPick: (mode: AggMode) => void,
): void {
  const bar = host.createDiv({ cls: "stashpad-trash-modes" });
  // 0.131.0: reset chip → back to the default view mode.
  const reset = bar.createEl("button", { cls: "stashpad-agg-reset", attr: { "aria-label": "Reset to default view" } });
  setIcon(reset, "rotate-ccw");
  reset.onclick = () => onPick(DEFAULT_AGG_MODE);
  const chips: Array<{ key: AggMode; label: string; count: number }> = [
    { key: "byfolder", label: "By folder", count: counts.total },
    { key: "separated", label: "Separated", count: counts.total },
    { key: "mixed", label: "Mixed (by date)", count: counts.total },
    { key: "encrypted", label: "Encrypted", count: counts.enc },
    { key: "unencrypted", label: "Unencrypted", count: counts.dec },
  ];
  for (const m of chips) {
    const c = bar.createEl("button", { cls: "stashpad-triage-chip" });
    if (current === m.key) c.addClass("is-active");
    c.createSpan({ text: m.label });
    c.createSpan({ cls: "stashpad-triage-chip-count", text: String(m.count) });
    c.onclick = () => onPick(m.key);
  }
}
