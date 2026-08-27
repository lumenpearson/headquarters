/**
 * R16: the startup sequence, and the three ways an operator can silence it.
 *
 * Pure, and separate from the component, so the timing can be tested without
 * a DOM and without waiting out a real sequence.
 */

/**
 * The stages, in order. Each one reveals a further layer of the shell, so the
 * readout builds up the way the terminal it imitates would.
 */
export const startupStages = ['field', 'panels', 'status', 'ready'] as const;

export type StartupStage = (typeof startupStages)[number];

export interface StartupConditions {
  /** `startup.enabled` -- the operator's own switch for this sequence. */
  readonly enabled: boolean;
  /** `animations.enabled` -- the global switch this sequence lives under. */
  readonly animationsEnabled: boolean;
  /** `accessibility.reducedMotion`, or the platform preference behind it. */
  readonly reducedMotion: boolean;
  /** `animations.intensity`, 0..1. */
  readonly intensity: number;
  /** `startup.stageHold` -- a multiplier on how long each stage is held. */
  readonly stageHold: number;
}

export interface StartupPlan {
  readonly play: boolean;
  readonly stageMs: number;
  readonly totalMs: number;
}

export function resolveStartupPlan({
  enabled,
  animationsEnabled,
  reducedMotion,
  intensity,
  stageHold,
}: StartupConditions): StartupPlan {
  const play = enabled && animationsEnabled && !reducedMotion;
  // A suppressed sequence costs nothing rather than a little: the shell must
  // not sit behind a timer that will never draw anything.
  if (!play) return { play: false, stageMs: 0, totalMs: 0 };

  // Same shape as the shell's own motion duration, held longer at both ends:
  // the sequence only starts once the document has loaded and the window is
  // visible, so it is a deliberate boot shot rather than a cover for loading,
  // and at the old 60..180ms it cleared before an operator registered it.
  // `startup.stageHold` multiplies the whole readout. On a shoot the boot
  // screen is a shot, and its length is a directing decision.
  const stageMs = Math.round((140 + intensity * 260) * stageHold);
  return { play: true, stageMs, totalMs: stageMs * startupStages.length };
}
