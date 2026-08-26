'use client';

import { useEffect } from 'react';

import { intlTag, useAppLocale } from '@/application/localization/locale';

/**
 * Keeps `<html lang>` on the locale the operator selected.
 *
 * `app/layout.tsx` writes `lang="ru"` into the markup and cannot do better:
 * it is a server component in a static export (ADR 0005), so the attribute is
 * decided at build time for every session at once. This mounts beside the
 * other document-wide runtimes and corrects it on the client.
 *
 * Worth doing rather than cosmetic. `lang` is what a screen reader picks a
 * voice from -- Russian text announced by an English voice is not merely
 * accented, it is unintelligible -- and what the browser hyphenates and
 * chooses quotation marks by. The tag is the BCP 47 one rather than `ru`,
 * because the same attribute also tells the platform which regional
 * conventions to assume.
 */
export function LocalizationRuntime() {
  const locale = useAppLocale();
  useEffect(() => {
    document.documentElement.lang = intlTag(locale);
  }, [locale]);
  return null;
}
