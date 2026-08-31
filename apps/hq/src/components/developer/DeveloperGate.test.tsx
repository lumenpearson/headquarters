// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `DeveloperGate` mounts its own `RuntimeProvider`, whose effect calls the
// real `RuntimeController.create` -- mocked the same way
// `RuntimeProvider.test.tsx` mocks it, so this file boots nothing.
vi.mock('@/application/RuntimeController', () => ({
  RuntimeController: {
    create: vi.fn().mockResolvedValue({ close: vi.fn(), toggleDeveloper: vi.fn() }),
  },
}));

import { resolveFromTables } from '@/application/localization/messages';
import { operationsStore } from '@/state/operationsStore';

import { DeveloperGate } from './DeveloperGate';

afterEach(() => {
  cleanup();
});

describe('DeveloperGate locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('translates the locked gate', () => {
    const { container } = render(<DeveloperGate />);

    expect(container.querySelector('h1')?.textContent).toBe('ДОСТУП ОГРАНИЧЕН');
    const unlockButton = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('РАЗБЛОКИРОВАТЬ'),
      )?.textContent;
    expect(unlockButton()).toBe('РАЗБЛОКИРОВАТЬ');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    expect(container.querySelector('h1')?.textContent).toBe('ACCESS RESTRICTED');
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('UNLOCK'),
      ),
    ).toBe(true);
  });

  it('falls back to English rather than Russian for a locale this catalogue has no line for', () => {
    const tables = {
      ru: { 'developer.accessRestrictedHeading': 'ДОСТУП ОГРАНИЧЕН' },
      en: { 'developer.accessRestrictedHeading': 'ACCESS RESTRICTED' },
    };
    const thirdLocale = 'xx' as unknown as Parameters<typeof resolveFromTables>[1];
    expect(
      resolveFromTables(
        { ...tables, [thirdLocale]: {} },
        thirdLocale,
        'developer.accessRestrictedHeading',
      ),
    ).toBe('ACCESS RESTRICTED');
  });
});
