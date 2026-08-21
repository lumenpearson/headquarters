import { describe, expect, it } from 'vitest';

import { groupKeybinds, keybindCategoryLabel } from './grouping';
import { keybindRegistry } from './registry';

describe('keybind list grouping', () => {
  it('groups the registry in the declared category order', () => {
    const groups = groupKeybinds(keybindRegistry);
    expect(groups.map((group) => group.category)).toEqual([
      'navigation',
      'operation',
      'editing',
      'developer',
    ]);
  });

  it('loses nothing on the way into the list', () => {
    // A grouping that silently drops a category is how a keybind stops being
    // discoverable while still working.
    const grouped = groupKeybinds(keybindRegistry).flatMap((group) => group.keybinds);
    expect(grouped).toHaveLength(keybindRegistry.length);
  });

  it('omits a category nothing is declared in, rather than printing an empty heading', () => {
    const groups = groupKeybinds(keybindRegistry.filter((k) => k.category === 'editing'));
    expect(groups.map((group) => group.category)).toEqual(['editing']);
  });

  it('names every category in the interface language', () => {
    expect(keybindCategoryLabel('navigation')).toBe('НАВИГАЦИЯ');
    expect(keybindCategoryLabel('developer')).toBe('РАЗРАБОТКА');
  });
});
