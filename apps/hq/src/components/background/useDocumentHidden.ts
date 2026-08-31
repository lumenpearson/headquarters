'use client';

import { useEffect, useState } from 'react';

/**
 * Whether the tab is in the background right now, kept live through the one
 * event the Page Visibility API offers.
 *
 * A minimized or backgrounded shoot-day dashboard still owning a WebGL frame
 * loop is a battery cost with nothing on screen to spend it on, so this is
 * one of the three independent gates the bitmap-shader background's frame
 * loop checks before it schedules anything.
 */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden,
  );

  useEffect(() => {
    const listener = () => setHidden(document.hidden);
    listener();
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);

  return hidden;
}
