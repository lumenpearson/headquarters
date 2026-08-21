import { describe, expect, it } from 'vitest';

import { resolveMotionDurationMs } from './ShellMotion';

describe('shell motion duration', () => {
  it('scales with the animation intensity while edit mode is off', () => {
    expect(resolveMotionDurationMs(0, false)).toBe(80);
    expect(resolveMotionDurationMs(0.65, false)).toBe(197);
    expect(resolveMotionDurationMs(1, false)).toBe(260);
  });

  it('collapses to nothing while edit mode is on, whatever the intensity says', () => {
    // R17: the operator switches between states instantly while editing, so a
    // change lands on the shell in the same frame it is made rather than
    // easing in over the configured duration.
    expect(resolveMotionDurationMs(0, true)).toBe(0);
    expect(resolveMotionDurationMs(0.65, true)).toBe(0);
    expect(resolveMotionDurationMs(1, true)).toBe(0);
  });
});
