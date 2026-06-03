/** 0.81.1: tiny opt-in profiler. Accumulates per-label timing buckets so we
 *  can see where Stashpad spends its time on a slow (e.g. network-drive)
 *  vault — split across the three suspects: rendering markdown, reading
 *  bodies, and writing files. Zero overhead when disabled (the time/record
 *  calls early-return). Toggle via the `enablePerfProfiling` setting; dump
 *  a report with the "Dump performance profile" command. */
interface Bucket { count: number; total: number; max: number; }

class Profiler {
  enabled = false;
  private buckets = new Map<string, Bucket>();

  record(label: string, ms: number): void {
    if (!this.enabled) return;
    let b = this.buckets.get(label);
    if (!b) { b = { count: 0, total: 0, max: 0 }; this.buckets.set(label, b); }
    b.count += 1;
    b.total += ms;
    if (ms > b.max) b.max = ms;
  }

  /** Time a synchronous block. Returns its result. */
  time<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    try { return fn(); } finally { this.record(label, performance.now() - t0); }
  }

  /** Time an async block. */
  async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    try { return await fn(); } finally { this.record(label, performance.now() - t0); }
  }

  reset(): void { this.buckets.clear(); }

  hasData(): boolean { return this.buckets.size > 0; }

  /** A sorted Markdown table (by total time desc) — renders as a table in
   *  a note and stays readable as raw text. */
  report(): string {
    const rows = [...this.buckets.entries()]
      .map(([label, b]) => ({ label, ...b, avg: b.total / b.count }))
      .sort((a, b) => b.total - a.total);
    if (rows.length === 0) return "Stashpad perf: no samples (enable profiling, then use the app).";
    const lines = [
      "**Stashpad performance profile**",
      "",
      "| label | count | total (ms) | avg (ms) | max (ms) |",
      "| --- | ---: | ---: | ---: | ---: |",
    ];
    for (const r of rows) {
      lines.push(`| \`${r.label}\` | ${r.count} | ${r.total.toFixed(0)} | ${r.avg.toFixed(1)} | ${r.max.toFixed(0)} |`);
    }
    return lines.join("\n");
  }
}

export const perf = new Profiler();
