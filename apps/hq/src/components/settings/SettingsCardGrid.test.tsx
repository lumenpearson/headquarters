// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveFromTables } from '@/application/localization/messages';
import { operationsStore } from '@/state/operationsStore';

import { SettingsCardGrid, settingsCardTargets } from './SettingsCardGrid';

describe('SettingsCardGrid locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('translates the section cards, sections and personalization groups alike', () => {
    const { container } = render(<SettingsCardGrid onOpen={() => undefined} />);
    const titles = () =>
      [...container.querySelectorAll('.settings-card .ops-panel__header h2')].map(
        (node) => node.textContent,
      );
    expect(titles()).toContain('ИНТЕРФЕЙС');
    // `settingsCardTargets` replaces the `personalization` section with one
    // card per `settingGroups` entry, using `groupLabel` rather than this
    // module's own table -- proven here so the two halves of the grid are
    // both known to follow the locale, not just the one this file owns.
    expect(titles()).toContain('ВНЕШНИЙ ВИД');
    // The translation editor's own card, resolved through
    // `settingsSection.translations` the same way every other section is.
    expect(titles()).toContain('ПЕРЕВОДЫ');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    expect(titles()).toContain('INTERFACE');
    expect(titles()).toContain('APPEARANCE');
    expect(titles()).toContain('TRANSLATIONS');
  });

  it('resolves every card label through the same function calls read directly', () => {
    const interfaceCard = settingsCardTargets().find(
      (card) => card.target.kind === 'section' && card.target.id === 'interface',
    );
    expect(interfaceCard?.label).toBe('ИНТЕРФЕЙС');
  });

  it('falls back to English rather than Russian for a locale this catalogue has no line for', () => {
    const tables = {
      ru: { 'settingsSection.interface': 'ИНТЕРФЕЙС' },
      en: { 'settingsSection.interface': 'INTERFACE' },
    };
    const thirdLocale = 'xx' as unknown as Parameters<typeof resolveFromTables>[1];
    expect(
      resolveFromTables({ ...tables, [thirdLocale]: {} }, thirdLocale, 'settingsSection.interface'),
    ).toBe('INTERFACE');
  });
});
