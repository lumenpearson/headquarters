import { titlebarElements } from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { titlebarElementLabel } from './titlebarLabels';

describe('titlebar element labels', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('names every titlebar.elements member exactly once', () => {
    const named = titlebarElements.map((element) => titlebarElementLabel(element));

    expect(named).toHaveLength(titlebarElements.length);
    expect(new Set(named).size).toBe(titlebarElements.length);
    for (const label of named) expect(label).not.toMatch(/^⟦/u);
  });

  it('follows the locale', () => {
    expect(titlebarElementLabel('close')).toBe('ЗАКРЫТЬ');

    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);

    expect(titlebarElementLabel('close')).toBe('CLOSE');
  });
});
