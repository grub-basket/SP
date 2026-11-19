import { Platform, type App } from "obsidian";

/** 0.609.0 (mobile): debug-trace lines for Obsidian's phone/tablet layout.
 *
 *  Why this exists: on a foldable iPhone's inner screen, Stashpad's sidebars
 *  flash a few pixels when the composer's folder button is tapped, only two of
 *  the four rotations behave, and the result depends on which screen the app was
 *  launched on. None of it reproduces on an iPad or in desktop mobile emulation.
 *
 *  Obsidian picks phone vs tablet layout with the media query below (read from
 *  the 1.15.1 app bundle). It re-checks whenever that query flips, skips the
 *  check while the soft keyboard is up, and collapses + resets both sidebars on
 *  every flip. A screen that sits near 600pt on one side can therefore flip on a
 *  keyboard close or a rotation. These lines record enough to confirm or rule
 *  that out from one session on the device: the mode, the query result, window /
 *  visual-viewport / screen sizes, orientation, the OS safe-area insets, the
 *  keyboard flag, every sidebar-drawer movement, and touches near the edges.
 *
 *  Cost when the debug trace is off: each listener checks one flag and returns.
 *  Nothing here is written anywhere but the in-memory trace buffer (and the
 *  trace's own opt-in disk copy). Mobile only. */

const TABLET_QUERY = "(min-width: 600px) and (min-height: 600px)";
/** Touches this close to a side edge are logged (wider than the composer's own
 *  28px edge-blur gutter, so the log shows taps just outside it too). */
const EDGE_PX = 48;

export interface LayoutProbeHost {
  app: App;
  trace(category: string, data?: Record<string, unknown>): void;
  isTracing(): boolean;
  register(cb: () => void): void;
  registerDomEvent<K extends keyof WindowEventMap>(el: Window, type: K, cb: (this: HTMLElement, ev: WindowEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof DocumentEventMap>(el: Document, type: K, cb: (this: HTMLElement, ev: DocumentEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
}

export interface LayoutProbe {
  /** Record one `layout:snapshot` line now (no-op while tracing is off). */
  snapshot(reason: string): void;
}

function modeOf(body: HTMLElement): string {
  if (body.hasClass("is-phone")) return "phone";
  if (body.hasClass("is-tablet")) return "tablet";
  return "neither";
}

export function installLayoutProbe(host: LayoutProbeHost): LayoutProbe | null {
  if (!Platform.isMobile) return null;
  // Installed at plugin load, when the active document is the main window's:
  // the phone/tablet classes, the drawers and the edge gestures all live there.
  const doc = activeDocument;
  const body = doc.body;
  const mq = window.matchMedia(TABLET_QUERY);

  // Raw OS insets via env(), read from a hidden fixed element (styles.css
  // `.stashpad-safe-area-probe`). Obsidian's own --safe-area-inset-* vars may
  // be overridden or absent; env() is what the system reports for this rotation.
  const insetEl = body.createDiv({ cls: "stashpad-safe-area-probe", attr: { "aria-hidden": "true" } });
  host.register(() => insetEl.remove());
  const insets = (): string => {
    const cs = getComputedStyle(insetEl);
    const px = (v: string): number => Math.round(parseFloat(v) || 0);
    return `${px(cs.paddingTop)},${px(cs.paddingRight)},${px(cs.paddingBottom)},${px(cs.paddingLeft)}`;
  };

  const state = (): Record<string, unknown> => {
    const vv = window.visualViewport;
    const so = window.screen?.orientation;
    return {
      mode: modeOf(body),
      mq: mq.matches,
      win: `${window.innerWidth}x${window.innerHeight}`,
      vv: vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}` : "-",
      screen: `${window.screen?.width ?? "?"}x${window.screen?.height ?? "?"}`,
      orient: so ? `${so.type}/${so.angle}` : "-",
      kb: (Platform as unknown as { mobileSoftKeyboardVisible?: boolean }).mobileSoftKeyboardVisible ?? "?",
      // top,right,bottom,left
      safe: insets(),
    };
  };

  const snapshot = (reason: string): void => {
    if (!host.isTracing()) return;
    host.trace("layout:snapshot", { reason, ...state() });
  };

  // The phone/tablet flip itself. Obsidian toggles these body classes on every
  // flip, so this catches it whatever caused it.
  let lastMode = modeOf(body);
  const modeObserver = new MutationObserver(() => {
    const now = modeOf(body);
    if (now === lastMode) return;
    const from = lastMode;
    lastMode = now;
    if (host.isTracing()) host.trace("layout:mode", { from, to: now, ...state() });
  });
  modeObserver.observe(body, { attributes: true, attributeFilter: ["class"] });
  host.register(() => modeObserver.disconnect());

  const onMq = (): void => { if (host.isTracing()) host.trace("layout:mq", state()); };
  mq.addEventListener("change", onMq);
  host.register(() => mq.removeEventListener("change", onMq));

  // Resizes come in bursts while the keyboard animates. Log only when a size
  // actually changed since the last logged one, so a burst costs a few lines.
  let lastSize = "";
  const onResize = (src: string): void => {
    if (!host.isTracing()) return;
    const s = state();
    const key = `${String(s.win)}|${String(s.vv)}|${String(s.mode)}|${String(s.kb)}`;
    if (key === lastSize) return;
    lastSize = key;
    host.trace("layout:resize", { src, ...s });
  };
  host.registerDomEvent(window, "resize", () => onResize("window"));
  const vv = window.visualViewport;
  if (vv) {
    const onVv = (): void => onResize("visual");
    vv.addEventListener("resize", onVv);
    host.register(() => vv.removeEventListener("resize", onVv));
  }
  host.registerDomEvent(window, "orientationchange", () => snapshot("orientationchange"));

  // Sidebar movement. Obsidian animates it two different ways (1.15.1 bundle):
  //  - tablet / floating drawers: an inline `transform` on the drawer's own
  //    container → `layout:drawer`.
  //  - phone layout: the drawer stays put and the MAIN content slides instead.
  //    The slide controller adds `is-sliding-sidebar` to the root split and the
  //    mobile navbar and writes `transform` on them → `layout:slide`.
  // Watching only the drawers would miss every phone-layout flash. A flash shows
  // up as a short run of transforms that ends where it started.
  const ws = host.app.workspace as unknown as {
    leftSplit?: { containerEl?: HTMLElement; collapsed?: boolean };
    rightSplit?: { containerEl?: HTMLElement; collapsed?: boolean };
    rootSplit?: { containerEl?: HTMLElement };
  };
  const watch = (el: HTMLElement | undefined, category: string, describe: () => Record<string, unknown>): void => {
    if (!(el instanceof HTMLElement)) return;
    let last = "";
    const mo = new MutationObserver(() => {
      if (!host.isTracing()) return;
      const d = describe();
      const key = JSON.stringify(d);
      if (key === last) return;
      last = key;
      host.trace(category, { ...d, mode: modeOf(body) });
    });
    mo.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    host.register(() => mo.disconnect());
  };
  for (const [side, split] of [["left", ws.leftSplit], ["right", ws.rightSplit]] as const) {
    const el = split?.containerEl;
    watch(el, "layout:drawer", () => ({ side, transform: (el?.style.transform || "none").slice(0, 60), collapsed: split?.collapsed ?? "?" }));
  }
  const navbar = (host.app as unknown as { mobileNavbar?: { containerEl?: HTMLElement } }).mobileNavbar?.containerEl;
  for (const [what, el] of [["root", ws.rootSplit?.containerEl], ["navbar", navbar]] as const) {
    watch(el, "layout:slide", () => ({
      what,
      transform: (el?.style.transform || "none").slice(0, 60),
      sliding: el?.hasClass("is-sliding-sidebar") ?? false,
    }));
  }

  // Touches near a side edge, with what they landed on. Capture + passive:
  // observes only, never changes what the touch does.
  host.registerDomEvent(doc, "touchstart", (e: TouchEvent) => {
    if (!host.isTracing()) return;
    const t = e.touches[0];
    if (!t) return;
    const w = window.innerWidth;
    const side = t.clientX <= EDGE_PX ? "left" : t.clientX >= w - EDGE_PX ? "right" : "";
    if (!side) return;
    const target = e.target instanceof Element ? e.target : null;
    const cls = target && typeof target.className === "string" ? target.className.split(" ").slice(0, 2).join(".") : "";
    host.trace("layout:edge-touch", {
      side, x: Math.round(t.clientX), y: Math.round(t.clientY), w,
      target: `${target?.tagName.toLowerCase() ?? "?"}${cls ? "." + cls : ""}`,
      ignoreSwipe: !!target?.closest("[data-ignore-swipe]"),
    });
  }, { capture: true, passive: true });

  snapshot("load");
  return { snapshot };
}
