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
}: StartupConditions): StartupPlan {
  const play = enabled && animationsEnabled && !reducedMotion;
  // A suppressed sequence costs nothing rather than a little: the shell must
  // not sit behind a timer that will never draw anything.
  if (!play) return { play: false, stageMs: 0, totalMs: 0 };

  // Same shape as the shell's own motion duration, one step shorter at each
  // end, so a low intensity reads as the same restraint everywhere.
  const stageMs = Math.round(60 + intensity * 120);
  return { play: true, stageMs, totalMs: stageMs * startupStages.length };
}
