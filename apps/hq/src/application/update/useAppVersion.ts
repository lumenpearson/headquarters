'use client';

import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/**
 * The version this build already carries -- `tauri.conf.json`'s own
 * `version`, which `@tauri-apps/api/app`'s `getVersion()` reads off the
 * running shell -- rather than a second copy of the number kept in this
 * package. `null` before the native call resolves, and permanently on the
 * web build, where there is no shell version to ask.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
