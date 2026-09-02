'use client';

import { Dithering } from '@paper-design/shaders-react';

import { useAccentGlowColor } from './useAccentGlowColor';
import { useCappedFrameLoop } from './useCappedFrameLoop';

/**
 * A hard ceiling on how often the shader repaints, independent of display
 * refresh rate. The background is ambient decoration behind a player and a
 * map that both need every frame the GPU has; capped well under either
 * budget is what keeps it from ever bidding for one.
 */
const MAX_FRAME_RATE = 24;

/**
 * Rendered at 1 device pixel per CSS pixel rather than the library's own
 * default of up to 2x: `.ops-shell__background-shader` blurs the result
 * immediately in `operations.css`, so the extra resolution a higher ratio
 * would buy is discarded by that blur before it ever reaches the screen.
 */
const MIN_PIXEL_RATIO = 1;
const MAX_PIXEL_COUNT = 1920 * 1080;

/**
 * The one bitmap-shader background, declared once here and attached to
 * `.ops-shell` by `OperationsShell` -- no screen draws one of its own.
 *
 * Screen-blended over pure opaque black
 * (`.ops-shell__background-shader` in `operations.css`): under that blend
 * mode a black pixel contributes nothing to what is already on screen, so
 * only the dithered pattern's lit pixels ever add anything. That is what lets
 * the layer sit over every theme's own `--ops-bg` without a second background
 * colour of its own to keep in step with it.
 */
export function BackgroundShaderLayer({
  paused,
  speed,
  intensity,
}: {
  /** The caller's own reason to hold the pattern still -- the setting, the route, the theme. */
  readonly paused: boolean;
  /** `backgrounds.motionSpeed` -- how fast the pattern drifts. */
  readonly speed: number;
  /** `animations.intensity` -- how strongly the glow reads against the panels drawn over it. */
  readonly intensity: number;
}) {
  const frame = useCappedFrameLoop({ paused, speed, maxFps: MAX_FRAME_RATE });
  const colorFront = useAccentGlowColor();

  return (
    <Dithering
      className="ops-shell__background-shader"
      aria-hidden="true"
      style={{ opacity: glowOpacity(intensity) }}
      // Must stay 0: `Dithering`'s own default is 1, which would start the
      // library's internal render loop and make `useCappedFrameLoop`'s cap
      // and pause both do nothing. `frame` is this component's only clock.
      speed={0}
      frame={frame}
      colorBack="#000000"
      colorFront={colorFront}
      shape="sphere"
      type="4x4"
      size={3}
      scale={0.7}
      minPixelRatio={MIN_PIXEL_RATIO}
      maxPixelCount={MAX_PIXEL_COUNT}
    />
  );
}

/**
 * `animations.intensity` already means "how much the interface moves"; spent
 * here as how strongly the glow reads rather than as a second speed control,
 * so the one dial an operator already has for more or less animation also
 * answers how loud the background is, instead of a second slider beside it.
 * Bounded well short of either end: even at its lowest the background stays
 * visible, and even at its highest it stays a wash rather than a glare a
 * panel's text would have to compete with.
 */
function glowOpacity(intensity: number): number {
  const clamped = Math.min(1, Math.max(0, intensity));
  return 0.22 + clamped * 0.3;
}
