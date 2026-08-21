import { keybindCategories, type Keybind, type KeybindCategory } from './registry';

export interface KeybindGroup {
  readonly category: KeybindCategory;
  readonly keybinds: readonly Keybind[];
}

/**
 * Arranges the registry for display, in the order the categories are declared
 * rather than the order the entries happen to appear.
 *
 * Empty categories are dropped: a heading with nothing under it reads as a
 * missing feature.
 */
export function groupKeybinds(keybinds: readonly Keybind[]): readonly KeybindGroup[] {
  return keybindCategories
    .map((category) => ({
      category,
      keybinds: keybinds.filter((keybind) => keybind.category === category),
    }))
    .filter((group) => group.keybinds.length > 0);
}

const categoryLabels: Readonly<Record<KeybindCategory, string>> = {
  navigation: 'НАВИГАЦИЯ',
  operation: 'ОПЕРАЦИЯ',
  editing: 'РЕДАКТИРОВАНИЕ',
  developer: 'РАЗРАБОТКА',
};

export function keybindCategoryLabel(category: KeybindCategory): string {
  return categoryLabels[category];
}
