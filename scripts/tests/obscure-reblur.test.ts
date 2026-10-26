/* Pure tests for src/obscure-reblur.ts */
import { ReblurTimers, reblurDelayMs, reblurChoiceLabel, REBLUR_SECONDS_CHOICES, DEFAULT_REBLUR_SECONDS } from "../../src/obscure-reblur";

declare const __assert: (c: boolean, m: string) => void;
declare const __eq: (a: unknown, b: unknown, m: string) => void;

// A hand-driven clock: `advance(ms)` runs every timer that comes due, in order.
function harness(opts: { delay?: number } = {}) {
  let t = 0, seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const state = {
    delay: opts.delay ?? 15000,
    revealed: new Set<string>(),
    held: new Set<string>(),
    reblurred: [] as string[],
  };
  const timers = new ReblurTimers<string>({
    delayMs: () => state.delay,
    isRevealed: (k) => state.revealed.has(k),
    isHeld: (k) => state.held.has(k),
    reblur: (k) => { state.reblurred.push(k); state.revealed.delete(k); },
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => { pending.delete(h as number); },
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of pending) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      pending.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  const reveal = (k: string): void => { state.revealed.add(k); timers.start(k); };
  return { state, timers, advance, reveal, pendingCount: () => pending.size };
}

{ // blurs after the delay, not before
  const h = harness();
  h.reveal("a");
  h.advance(14999);
  __eq(h.state.reblurred, [], "not yet at 14.999s");
  h.advance(1);
  __eq(h.state.reblurred, ["a"], "blurred at 15s");
  __eq(h.pendingCount(), 0, "no timer left behind");
  __assert(!h.timers.has("a"), "has() false after firing");
}

{ // touch restarts the countdown from the touch
  const h = harness();
  h.reveal("a");
  h.advance(10000);
  h.timers.touch("a");
  h.advance(14000);
  __eq(h.state.reblurred, [], "still revealed 14s after the touch");
  h.advance(1000);
  __eq(h.state.reblurred, ["a"], "blurred 15s after the touch");
}

{ // touching a note with no countdown starts nothing
  const h = harness();
  h.timers.touch("x");
  __eq(h.pendingCount(), 0, "touch on an unrevealed note arms no timer");
}

{ // held notes never blur; letting go blurs a full delay later
  const h = harness();
  h.reveal("a");
  h.state.held.add("a");
  h.advance(60000);
  __eq(h.state.reblurred, [], "held for a minute, still revealed");
  h.state.held.delete("a");
  h.advance(14999);
  __eq(h.state.reblurred, [], "let go: not before a full delay");
  h.advance(15001);
  __eq(h.state.reblurred, ["a"], "blurred after release");
}

{ // re-hidden by something else: timer lapses quietly
  const h = harness();
  h.reveal("a");
  h.state.revealed.delete("a");
  h.advance(20000);
  __eq(h.state.reblurred, [], "no reblur call for a note already hidden");
}

{ // feature off: start is a no-op, and switching off mid-countdown drops it
  const h = harness({ delay: 0 });
  h.reveal("a");
  __eq(h.pendingCount(), 0, "delay 0 arms nothing");
  h.state.delay = 15000;
  h.reveal("b");
  h.state.delay = 0;
  h.advance(20000);
  __eq(h.state.reblurred, [], "switched off before firing: nothing blurs");
}

{ // a longer delay set mid-countdown is honoured
  const h = harness();
  h.reveal("a");
  h.state.delay = 60000;
  h.advance(15000);
  __eq(h.state.reblurred, [], "old delay elapsed but new one is longer");
  h.advance(45000);
  __eq(h.state.reblurred, ["a"], "blurred at the new delay");
}

{ // re-revealing does not stack timers; cancel and clear remove them
  const h = harness();
  h.reveal("a");
  h.reveal("a");
  __eq(h.pendingCount(), 1, "one timer per note");
  h.reveal("b");
  h.timers.cancel("a");
  __eq(h.pendingCount(), 1, "cancel drops only that note");
  h.timers.clear();
  __eq(h.pendingCount(), 0, "clear drops everything");
  h.advance(30000);
  __eq(h.state.reblurred, [], "nothing fires after clear");
}

{ // independent notes keep independent clocks
  const h = harness();
  h.reveal("a");
  h.advance(5000);
  h.reveal("b");
  h.advance(10000);
  __eq(h.state.reblurred, ["a"], "a first");
  h.advance(5000);
  __eq(h.state.reblurred, ["a", "b"], "then b");
}

{ // retime: a shorter delay applies to running countdowns
  const h = harness({ delay: 300000 });
  h.reveal("a");
  h.advance(4000);
  h.timers.touch("a");          // last used at 4s
  h.advance(2000);              // now 6s, idle 2s
  h.state.delay = 5000;
  h.timers.retime();
  h.advance(2999);
  __eq(h.state.reblurred, [], "retimed: not before 5s idle");
  h.advance(1);
  __eq(h.state.reblurred, ["a"], "retimed: blurs at 5s since last use, not 5 min");
}

{ // retime past the new delay blurs at once; retime to off drops it
  const h = harness({ delay: 300000 });
  h.reveal("a"); h.reveal("b");
  h.advance(20000);
  h.state.delay = 10000;
  h.timers.retime();
  h.advance(0);
  __eq(h.state.reblurred, ["a", "b"], "already idle past the new delay → blur now");
  const h2 = harness();
  h2.reveal("a");
  h2.state.delay = 0;
  h2.timers.retime();
  h2.advance(60000);
  __eq(h2.state.reblurred, [], "retime to Never: nothing blurs");
  __eq(h2.pendingCount(), 0, "and no timer is left");
}

__eq(reblurDelayMs(15), 15000, "seconds to ms");
__eq(reblurDelayMs(0), 0, "0 stays off");
__eq(reblurDelayMs(undefined), DEFAULT_REBLUR_SECONDS * 1000, "missing → default");
__eq(reblurDelayMs(-3), DEFAULT_REBLUR_SECONDS * 1000, "negative → default");
__eq(reblurDelayMs("15"), DEFAULT_REBLUR_SECONDS * 1000, "string → default");
__eq(reblurDelayMs(NaN), DEFAULT_REBLUR_SECONDS * 1000, "NaN → default");
__assert((REBLUR_SECONDS_CHOICES as readonly number[]).includes(DEFAULT_REBLUR_SECONDS), "default is one of the choices");
__eq(reblurChoiceLabel(0), "Never (stay revealed)", "off label");
__eq(reblurChoiceLabel(15), "15 seconds", "seconds label");
__eq(reblurChoiceLabel(60), "1 minute", "one minute");
__eq(reblurChoiceLabel(300), "5 minutes", "minutes label");
