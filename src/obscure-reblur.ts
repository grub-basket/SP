/** 0.587.0: blur a revealed note again after it has sat unused for a while.
 *
 *  Obscuring has had "Re-hide when you leave" since 0.237.0, but a note you
 *  peeked at stayed readable for as long as you stayed on that screen — which
 *  is exactly the case where someone walks up behind you. This adds the
 *  Password Pusher behaviour: a reveal times out.
 *
 *  A notes app is not a one-time password, though: people READ revealed notes,
 *  and a blur that lands mid-sentence is worse than none. So the countdown
 *  measures time since the note was last USED, not since it was revealed:
 *
 *    - `touch(k)` restarts the countdown (scroll / tap / type inside the note);
 *    - `isHeld(k)` postpones it outright while true (mouse resting on the note,
 *      the note open for editing) — checked when the timer fires, so a held
 *      note is re-checked a full delay later rather than polled.
 *
 *  PURE: no DOM, no Obsidian. Clock and timer functions are injectable so the
 *  unit tests can drive time by hand. The owner (list view, detail panel)
 *  supplies what "revealed", "held" and "blur it" mean for its own elements. */

export interface ReblurOptions<K> {
  /** Current delay in ms; read at every fire, and `retime()` re-arms running
   *  timers when the setting changes. 0 or less = feature off: a firing timer is
   *  dropped without blurring anything. */
  delayMs: () => number;
  /** Is `k` still revealed? A note re-hidden by other means (navigating away,
   *  the badge, the obscure command) just lets its timer lapse. */
  isRevealed: (k: K) => boolean;
  /** True while the note is in use in a way no event marks continuously. */
  isHeld: (k: K) => boolean;
  /** Blur `k` again. Called at most once per `start`. */
  reblur: (k: K) => void;
  /** The owner's window timers (`window.setTimeout` / `clearTimeout`), passed
   *  in so this module stays DOM-free and testable. */
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now?: () => number;
}

/** The choices offered in settings, in seconds. 0 = never. */
export const REBLUR_SECONDS_CHOICES = [0, 5, 10, 15, 30, 60, 120, 300] as const;
export const DEFAULT_REBLUR_SECONDS = 15;

/** Settings value → a safe delay. Anything that isn't a non-negative finite
 *  number (hand-edited data.json, a value from a newer build) falls back to the
 *  default rather than switching the feature off or firing instantly. */
export function reblurDelayMs(seconds: unknown): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_REBLUR_SECONDS * 1000;
  return Math.round(seconds * 1000);
}

/** Label for a choice in the settings dropdown. */
export function reblurChoiceLabel(seconds: number): string {
  if (seconds <= 0) return "Never (stay revealed)";
  if (seconds < 60) return `${seconds} seconds`;
  const m = seconds / 60;
  return m === 1 ? "1 minute" : `${m} minutes`;
}

export class ReblurTimers<K> {
  private readonly timers = new Map<K, unknown>();
  private readonly lastUsed = new Map<K, number>();
  private readonly now: () => number;

  constructor(private readonly opts: ReblurOptions<K>) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** `k` was just revealed: start (or restart) its countdown. A no-op while the
   *  feature is off, so turning it on later only affects new reveals. */
  start(k: K): void {
    const ms = this.opts.delayMs();
    if (!(ms > 0)) return;
    this.lastUsed.set(k, this.now());
    if (!this.timers.has(k)) this.arm(k, ms);
  }

  /** `k` is being used: restart its countdown. Only for notes with a running
   *  timer — touching a hidden note must not start one. */
  touch(k: K): void {
    if (this.timers.has(k)) this.lastUsed.set(k, this.now());
  }

  /** Is a countdown running for `k`? */
  has(k: K): boolean { return this.timers.has(k); }

  cancel(k: K): void {
    const h = this.timers.get(k);
    if (h !== undefined) this.opts.clearTimer(h);
    this.timers.delete(k);
    this.lastUsed.delete(k);
  }

  /** The delay setting changed: re-arm every running countdown against the
   *  NEW delay, measured from each note's last use. Without this a timer armed
   *  for 5 minutes ignores a switch to 5 seconds until it fires. A note already
   *  past the new delay is re-checked at once (and so blurs unless held). */
  retime(): void {
    const ms = this.opts.delayMs();
    for (const [k, h] of [...this.timers]) {
      this.opts.clearTimer(h);
      const idle = this.now() - (this.lastUsed.get(k) ?? 0);
      this.arm(k, ms > 0 ? Math.max(0, ms - idle) : 0);
    }
  }

  /** Drop every countdown (view closed, every reveal cleared at once). */
  clear(): void {
    for (const h of this.timers.values()) this.opts.clearTimer(h);
    this.timers.clear();
    this.lastUsed.clear();
  }

  private arm(k: K, ms: number): void {
    this.timers.set(k, this.opts.setTimer(() => this.fire(k), ms));
  }

  private fire(k: K): void {
    this.timers.delete(k);
    const ms = this.opts.delayMs();
    if (!(ms > 0) || !this.opts.isRevealed(k)) { this.lastUsed.delete(k); return; }
    // Held: look again a full delay from now, which is also when it would blur
    // if it were let go this instant.
    if (this.opts.isHeld(k)) { this.lastUsed.set(k, this.now()); this.arm(k, ms); return; }
    const idle = this.now() - (this.lastUsed.get(k) ?? 0);
    if (idle < ms) { this.arm(k, ms - idle); return; }
    this.lastUsed.delete(k);
    this.opts.reblur(k);
  }
}
