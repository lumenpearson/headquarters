// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { TerminalUiProvider } from '@gremuchaya/ui/primitives';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveFromTables } from '@/application/localization/messages';

import { operationsStore } from '../state/operationsStore.js';
import { SettingsScreen } from './SettingsScreen.js';

/**
 * `useTerminalToast` (the reset-world and reset-all confirmations) reaches
 * into Base UI's `Toast.useToastManager`, which throws outside a
 * `Toast.Provider` -- `TerminalUiProvider` is the one this application
 * mounts once at the root layout, reproduced here so the screen renders the
 * way it does in the shell rather than a stand-in that happens to satisfy
 * the hook.
 */
function renderSettings() {
  return render(
    <TerminalUiProvider>
      <SettingsScreen />
    </TerminalUiProvider>,
  );
}

describe('SettingsScreen locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('translates its header and the section cards it shares with SettingsCardGrid', () => {
    const { container } = renderSettings();

    expect(container.querySelector('h1')?.textContent).toBe('НАСТРОЙКИ КОНТУРА');
    const cardTitles = () =>
      [...container.querySelectorAll('.settings-card .ops-panel__header h2')].map(
        (node) => node.textContent,
      );
    expect(cardTitles()).toContain('ИНТЕРФЕЙС');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    expect(container.querySelector('h1')?.textContent).toBe('CONTOUR SETTINGS');
    expect(cardTitles()).toContain('INTERFACE');
  });

  it('falls back to English rather than Russian for a locale this catalogue has no line for', () => {
    // `settings.screenTitle`'s real entry cannot have a hole (`CatalogEntry`
    // requires both `ru` and `en`); the fallback chain itself is proven here
    // the same way `messages.test.ts` proves it generically -- against a
    // stand-in table shaped like the real one, but naming an id this screen
    // actually renders with, so a reader trusts the id and the mechanism
    // agree.
    const tables = {
      ru: { 'settings.screenTitle': 'НАСТРОЙКИ КОНТУРА' },
      en: { 'settings.screenTitle': 'CONTOUR SETTINGS' },
    };
    const thirdLocale = 'xx' as unknown as Parameters<typeof resolveFromTables>[1];
    expect(
      resolveFromTables({ ...tables, [thirdLocale]: {} }, thirdLocale, 'settings.screenTitle'),
    ).toBe('CONTOUR SETTINGS');
  });
});
