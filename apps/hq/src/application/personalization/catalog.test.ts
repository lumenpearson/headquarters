import { settingCategories, settingsDefinitions } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import {
  categoriesInGroup,
  groupOfCategory,
  queryCatalog,
  searchEverySetting,
  settingGroups,
} from './catalog';

describe('settings catalogue navigation', () => {
  it('places every category in exactly one group', () => {
    const placed = settingGroups.flatMap((group) => categoriesInGroup(group));

    // A category in no group is a category the screen cannot show at all, and
    // one in two groups is a definition an operator finds twice and changes in
    // one place while looking at the other.
    expect([...placed].sort()).toEqual([...settingCategories].sort());
  });

  it('reaches every definition through some group', () => {
    const reachable = settingGroups.flatMap(
      (group) =>
        queryCatalog({
          group,
          category: 'all',
          search: '',
          changedOnly: false,
          changedIds: [],
        }).definitions,
    );

    expect(reachable).toHaveLength(settingsDefinitions.length);
  });

  it('searches the description, not only the identifier', () => {
    // An operator looking for the interface font knows the word, not that the
    // setting is called `typography.weight`.
    const byWord = searchEverySetting('weight', []);
    expect(byWord.map((definition) => definition.id)).toContain('typography.weight');

    // A word that appears in descriptions and in no identifier at all, so a
    // search over identifiers alone would return nothing for it.
    const byDescription = searchEverySetting('pixels', []);
    expect(byDescription.length).toBeGreaterThan(0);
    expect(byDescription.some((definition) => definition.id.includes('pixels'))).toBe(false);
  });

  it('answers an empty search with nothing rather than with everything', () => {
    // The all-groups search is a second surface beside the grouped one; making
    // an empty box mean "every setting" would replace the grouping it exists to
    // complement.
    expect(searchEverySetting('   ', [])).toEqual([]);
  });

  it('narrows to what the operator moved, and counts the group behind the filter', () => {
    const group = groupOfCategory('themes');
    const changedIds = ['themes.id'];

    const filtered = queryCatalog({
      group,
      category: 'all',
      search: '',
      changedOnly: true,
      changedIds,
    });

    expect(filtered.definitions.map((definition) => definition.id)).toEqual(['themes.id']);
    // The totals describe the group, not the filtered view: an operator has to
    // be able to tell "one of forty changed" from "one setting exists".
    expect(filtered.groupTotal).toBeGreaterThan(1);
    expect(filtered.changedInGroup).toBe(1);
  });

  it('lets a chosen category settle the question over the open section', () => {
    const result = queryCatalog({
      group: groupOfCategory('themes'),
      category: 'player',
      search: '',
      changedOnly: false,
      changedIds: [],
    });

    // A section narrows when no category is chosen; it is not a second filter
    // the category has to agree with. Letting the section win as well would
    // hide a category the operator had just selected, which is the one thing a
    // navigation aid must never do.
    expect(result.definitions.length).toBeGreaterThan(0);
    expect(result.definitions.every((definition) => definition.category === 'player')).toBe(true);
  });
});
