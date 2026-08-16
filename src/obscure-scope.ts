/** Whether the global "cover everything" switch is on for THIS device.
 *
 *  Its own module with no imports, so it can be unit-tested under plain node —
 *  the same reason paste-path.ts has one. view-helpers.ts pulls in the settings
 *  store and most of the plugin behind it, which cannot be bundled for a test.
 *
 *  Separated out because the interesting case is not the happy path but the
 *  FALLBACK, and getting that wrong fails OPEN: it would uncover notes the user
 *  had covered. A privacy control must never do that, so the rule is pinned by
 *  tests rather than left to a reading of the code.
 */
export type ObscureScope = "device" | "synced";

/** `local` is this device's own answer: true / false / null for "never set
 *  here". When the scope is per-device and this device has no answer yet, the
 *  synced value stands in — so switching to device-only cannot uncover
 *  something that was already covered. */
export function resolveObscureAll(
  scope: ObscureScope,
  synced: boolean,
  local: boolean | null,
): boolean {
  if (scope === "synced") return synced === true;
  if (local === null) return synced === true;
  return local === true;
}
