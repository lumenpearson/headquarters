// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveFromTables } from '@/application/localization/messages';
import { createInitialRuntimeState } from '@/application/runtimeState';
import { operationsStore } from '@/state/operationsStore';
import { appStore } from '@/state/appStore';

import { DeveloperPanel } from './DeveloperPanel';

/**
 * `DeveloperPanel` reads `appStore`, not `operationsStore` -- `resetWorld`
 * only touches the latter, so the developer contour is unlocked here
 * directly rather than through `RuntimeController.toggleDeveloper`, which
 * would need a booted (or mocked) runtime this file has no other use for.
 */
function unlockDeveloperContour(): void {
  const current = appStore.getState();
  current.replaceRuntimeState({
    ...current,
    developer: { ...current.developer, isUnlocked: true },
  });
}

describe('DeveloperPanel locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    appStore
      .getState()
      .replaceRuntimeState(createInitialRuntimeState(appStore.getState().screens.byId));
    unlockDeveloperContour();
  });

  it('translates its header and its tab roster', () => {
    const { container } = render(<DeveloperPanel />);

    expect(container.querySelector('header strong')?.textContent).toBe('ИНЖЕНЕРНЫЙ КОНТУР');
    const firstTab = () => container.querySelector('nav button')?.textContent;
    expect(firstTab()).toBe('СОСТОЯНИЯ');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    expect(container.querySelector('header strong')?.textContent).toBe('ENGINEERING CONTOUR');
    expect(firstTab()).toBe('STATES');
  });

  it('falls back to English rather than Russian for a locale this catalogue has no line for', () => {
    const tables = {
      ru: { 'developer.panelHeading': 'ИНЖЕНЕРНЫЙ КОНТУР' },
      en: { 'developer.panelHeading': 'ENGINEERING CONTOUR' },
    };
    const thirdLocale = 'xx' as unknown as Parameters<typeof resolveFromTables>[1];
    expect(
      resolveFromTables({ ...tables, [thirdLocale]: {} }, thirdLocale, 'developer.panelHeading'),
    ).toBe('ENGINEERING CONTOUR');
  });
});
