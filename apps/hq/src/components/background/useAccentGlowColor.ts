'use client';

import { useEffect, useState } from 'react';

/**
 * `--ops-orange-bright` is already every theme's own name for its brightest
 * accent -- the focus ring reads it directly in `operations.css`. Reading it
 * here rather than repeating a per-theme hex table is the same stance
 * `presentation.ts` takes toward colour generally: a theme owns the hues, and
 * a second table drifts from it the moment a theme's palette changes.
 */
const ACCENT_PROPERTY = '--ops-orange-bright';

/** The default theme's own value, so the very first paint already matches it instead of a placeholder grey. */
const FALLBACK_COLOR = '#f0b56e';

/**
 * The colour the bitmap-shader background glows with, kept in step with the
 * active theme and accent without a prop threading either through just for
 * this: `OperationsShell` sets `data-theme`/`data-accent` on `body` in its own
 * effect, and a `MutationObserver` here is what lets this component follow
 * either attribute independently of that effect's own render order.
 */
export function useAccentGlowColor(): string {
  const [color, setColor] = useState(FALLBACK_COLOR);

  useEffect(() => {
    const read = () => {
      const value = getComputedStyle(document.body).getPropertyValue(ACCENT_PROPERTY).trim();
      if (value !== '') setColor(value);
    };
    read();

    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, []);

  return color;
}
