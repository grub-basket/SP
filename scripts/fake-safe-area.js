/* Inject real iPhone safe-area insets into the dev instance.
 *
 * WHY THIS EXISTS: in the desktop simulator every safe-area inset resolves to
 * 0px, so a layout that collides with the Dynamic Island or the home indicator
 * looks perfect while testing and is broken on the device. That gap is why the
 * same class of bug kept shipping. Overriding the variables makes the device
 * condition reproducible on the desktop.
 *
 * Usage (via scripts/obs-dev eval-file), then re-open the surface under test.
 *   window.__spFakeSafeArea("iphone16pro")  // 59 / 34
 *   window.__spFakeSafeArea("iphonese")     // 20 / 0   (no notch, no indicator)
 *   window.__spFakeSafeArea("landscape")    // side insets, small bottom
 *   window.__spFakeSafeArea(null)           // remove the override
 *
 * Values are Apple's published portrait insets for the named devices.
 */
(() => {
  const PRESETS = {
    iphone16pro: { top: 59, bottom: 34, left: 0, right: 0 },
    iphone14:    { top: 47, bottom: 34, left: 0, right: 0 },
    iphonese:    { top: 20, bottom: 0,  left: 0, right: 0 },
    landscape:   { top: 0,  bottom: 21, left: 59, right: 59 },
  };
  const ID = "stashpad-fake-safe-area";
  window.__spFakeSafeArea = (preset) => {
    document.getElementById(ID)?.remove();
    if (!preset) return { cleared: true };
    const v = typeof preset === "string" ? PRESETS[preset] : preset;
    if (!v) return { error: "unknown preset", known: Object.keys(PRESETS) };
    const style = document.createElement("style");
    style.id = ID;
    // Set BOTH the Obsidian variable and Stashpad's token: the token reads the
    // Obsidian one, and overriding the source proves the whole chain works
    // rather than just the last link.
    style.textContent = `body, :root {
      --safe-area-inset-top: ${v.top}px;
      --safe-area-inset-bottom: ${v.bottom}px;
      --safe-area-inset-left: ${v.left}px;
      --safe-area-inset-right: ${v.right}px;
    }`;
    document.head.appendChild(style);
    return { applied: v };
  };
  return { ready: true, presets: Object.keys(PRESETS) };
})()
