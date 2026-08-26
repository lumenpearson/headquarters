import { tileCategories } from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { tileMotions } from '@/application/personalization/tileMotion';
import { operationsStore } from '@/state/operationsStore';

import { tileCategoryLabel, tileMotionLabel } from './tileLabels';

describe('the reconciled tile tables', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('names every tile category exactly once, in one table', () => {
    // There were two `Record<TileCategory, string>` maps over this union --
    // `TileMotionPicker` and `TileVisibility` -- and they disagreed about
    // three of the seven entries. One table now, and this is what says a
    // second one has not appeared: a category with no name renders a bracketed
    // missing id rather than a word.
    const named = tileCategories.map((category) => tileCategoryLabel(category));

    expect(named).toHaveLength(tileCategories.length);
    expect(new Set(named).size).toBe(tileCategories.length);
    for (const label of named) expect(label).not.toMatch(/^⟦/u);
  });

  it('settles the three the two tables disagreed about', () => {
    // Chosen rather than averaged, and asserted so the choice is not undone
    // quietly. `routeLabels` already calls the objects screen `РЕЕСТР
    // ОБЪЕКТОВ`; a group of tiles is `КАРТОЧКИ` in the plural; and `ГЕО` was
    // the only abbreviation among seven words.
    expect(tileCategoryLabel('records')).toBe('РЕЕСТРЫ');
    expect(tileCategoryLabel('detail')).toBe('КАРТОЧКИ');
    expect(tileCategoryLabel('geo')).toBe('ГЕОГРАФИЯ');
  });

  it('names every motion exactly once', () => {
    const named = tileMotions.map((motion) => tileMotionLabel(motion));

    expect(new Set(named).size).toBe(tileMotions.length);
    for (const label of named) expect(label).not.toMatch(/^⟦/u);
  });

  it('follows the locale', () => {
    expect(tileCategoryLabel('records')).toBe('РЕЕСТРЫ');

    operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);

    expect(tileCategoryLabel('records')).toBe('REGISTRIES');
    expect(tileMotionLabel('scan')).toBe('SCAN');
  });
});
