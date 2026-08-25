import { describe, expect, it } from 'vitest';

import { resolveStartupPlan, startupStages } from './StartupPlan';

const playing = {
  enabled: true,
  animationsEnabled: true,
  reducedMotion: false,
  intensity: 0.65,
  stageHold: 1,
};

describe('startup sequence plan', () => {
  it('plays when startup, animations and motion all allow it', () => {
    const plan = resolveStartupPlan(playing);
    expect(plan.play).toBe(true);
    expect(plan.stageMs).toBe(138);
    expect(plan.totalMs).toBe(138 * startupStages.length);
  });

  it('holds each stage for the multiplier the operator set', () => {
    // At 1 the arithmetic is the expression that was here before, which is what
    // keeps the 138ms above true.
    expect(resolveStartupPlan({ ...playing, stageHold: 2 }).stageMs).toBe(276);
    expect(resolveStartupPlan({ ...playing, stageHold: 0.5 }).stageMs).toBe(69);
    // On a shoot the boot screen is a shot, so the whole readout scales with it.
    expect(resolveStartupPlan({ ...playing, stageHold: 2 }).totalMs).toBe(
      276 * startupStages.length,
    );
  });

  it('scales the sequence with the animation intensity', () => {
    expect(resolveStartupPlan({ ...playing, intensity: 0 }).stageMs).toBe(60);
    expect(resolveStartupPlan({ ...playing, intensity: 1 }).stageMs).toBe(180);
  });

  it.each([
    ['the operator turned the startup sequence off', { enabled: false }],
    ['animations are off altogether', { animationsEnabled: false }],
    ['the operator asked for reduced motion', { reducedMotion: true }],
  ])('does not play when %s', (_reason, override) => {
    const plan = resolveStartupPlan({ ...playing, ...override });
    expect(plan.play).toBe(false);
    // Nothing to wait for: a suppressed sequence must not hold the shell
    // behind a timer that never shows anything.
    expect(plan.totalMs).toBe(0);
  });
});
