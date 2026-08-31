'use client';

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The operating system's own motion preference, independent of
 * `accessibility.reducedMotion`. An operator can leave the in-app setting
 * alone and still have told Windows itself to reduce motion, and R13's "an
 * honest off switch" means the background holds still for either reason, not
 * only the one this application knows the name of.
 *
 * `window.matchMedia` does not exist in the jsdom environment component tests
 * run under, so its absence is a normal case here rather than a fault to
 * surface: it resolves to no preference instead of throwing.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => readPreference());

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(QUERY);
    const listener = () => setReduced(query.matches);
    listener();
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return reduced;
}

function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}
