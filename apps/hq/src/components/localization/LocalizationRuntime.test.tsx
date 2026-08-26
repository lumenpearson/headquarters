// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { LocalizationRuntime } from './LocalizationRuntime';

describe('the document language', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    document.documentElement.lang = 'ru';
  });

  it('corrects the build-time attribute to the locale in force', () => {
    // `app/layout.tsx` is a server component in a static export, so it writes
    // one `lang` for every session at build time. This is the correction.
    render(<LocalizationRuntime />);

    expect(document.documentElement.lang).toBe('ru-RU');
  });

  it('follows the locale, and writes the regional tag rather than the bare one', () => {
    render(<LocalizationRuntime />);

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    // `en-GB` and not `en`: the same attribute tells the platform which
    // regional conventions to assume, and this application prints
    // day-month-year everywhere.
    expect(document.documentElement.lang).toBe('en-GB');
  });
});
