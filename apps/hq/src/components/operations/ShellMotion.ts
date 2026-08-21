/**
 * R17: how long a state change takes to settle in the shell, in milliseconds.
 *
 * Extracted from `OperationsShell` so the rule can be tested without mounting
 * the shell and every screen behind it.
 *
 * Edit mode collapses the duration to nothing rather than scaling it down.
 * The operator editing a setting is comparing states, not watching one; any
 * easing at all puts the previous state on screen at the moment the new one is
 * judged. Outside edit mode the configured intensity is untouched — the
 * suppression is a property of the editing session, not a new setting, and it
 * disappears with the session because `edit.active` is never persisted.
 *
 * Zero rather than a token 1ms: nothing in this application listens for
 * `transitionend`, so the event that a zero duration does not fire has no
 * subscriber to miss it.
 */
export function resolveMotionDurationMs(animationIntensity: number, editActive: boolean): number {
  if (editActive) return 0;
  return Math.round(80 + animationIntensity * 180);
}
