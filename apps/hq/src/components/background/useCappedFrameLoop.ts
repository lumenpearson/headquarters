'use client';

import { useEffect, useRef, useState } from 'react';

import { useDocumentHidden } from './useDocumentHidden';
import { usePrefersReducedMotion } from './useReducedMotion';

/**
 * Drives the `frame` uniform of a Paper Shaders background from outside the
 * library rather than through the library's own animation loop.
 *
 * `ShaderMount` only starts its internal `requestAnimationFrame` loop once a
 * nonzero `speed` prop reaches it; left at 0 it paints once per `setFrame`
 * call and nothing between calls (`@paper-design/shaders`, `shader-mount.js`).
 * `BackgroundShaderLayer` always passes `speed={0}` to the shader component
 * for exactly this reason -- this hook is what has to be the only thing
 * scheduling a frame, or "off" would stop this loop while the library kept
 * its own running underneath it.
 *
 * Returns the accumulated animation time in milliseconds: monotonic while
 * running, frozen the instant any of the three gates below is true.
 */
export function useCappedFrameLoop({
  paused,
  speed,
  maxFps,
}: {
  /** The caller's own reason to hold the pattern still: the setting, the route, the theme. */
  readonly paused: boolean;
  /** Multiplies elapsed time before it reaches the accumulated frame -- `backgrounds.motionSpeed`. */
  readonly speed: number;
  /** A hard ceiling on how often the loop paints, independent of the display's own refresh rate. */
  readonly maxFps: number;
}): number {
  const reducedMotion = usePrefersReducedMotion();
  const documentHidden = useDocumentHidden();
  const stopped = paused || reducedMotion || documentHidden;

  const [frame, setFrame] = useState(0);
  const accumulatedRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);

  useEffect(() => {
    if (stopped) {
      // The next resume starts its own delta rather than one spanning
      // however long the pause lasted -- without this the pattern would jump
      // forward by the length of the pause the instant it resumes.
      lastTickRef.current = null;
      return;
    }

    const interval = 1000 / Math.max(1, maxFps);
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const paint = (now: number) => {
      const last = lastTickRef.current;
      lastTickRef.current = now;
      if (last !== null) accumulatedRef.current += (now - last) * speed;
      setFrame(accumulatedRef.current);
      if (!cancelled) timeoutId = setTimeout(schedule, interval);
    };

    // `requestAnimationFrame` aligns the paint with the browser's own frame
    // so a still-running compositor never tears; `setTimeout` is what
    // actually enforces the cap -- rAF alone fires at display refresh rate
    // regardless of any gate written inside its own callback, which would
    // leave the shader competing for exactly the frames R13 asks it not to.
    const schedule = () => {
      rafId = requestAnimationFrame(paint);
    };

    schedule();
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [stopped, speed, maxFps]);

  return frame;
}
