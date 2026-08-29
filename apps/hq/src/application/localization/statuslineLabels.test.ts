import { statuslineElements } from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { statuslineElementLabel } from './statuslineLabels';

describe('statusline element labels', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('names every statusline.elements member exactly once', () => {
    // `statusline.elements` is edited as a raw comma list, so this is the
    // table that stops the settings screen from naming its own values in
    // English identifiers -- a member with no entry renders a bracketed
    // missing id rather than a word.
    const named = statuslineElements.map((element) => statuslineElementLabel(element));

    expect(named).toHaveLength(statuslineElements.length);
    expect(new Set(named).size).toBe(statuslineElements.length);
    for (const label of named) expect(label).not.toMatch(/^⟦/u);
  });

  it('follows the locale', () => {
    expect(statuslineElementLabel('system')).toBe('СИСТЕМА');

    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);

    expect(statuslineElementLabel('system')).toBe('SYSTEM');
  });
});
