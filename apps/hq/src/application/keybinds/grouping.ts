import { t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';

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

/**
 * A record over the union rather than an id built from the category name.
 *
 * `` t(`keybindCategory.${category}`) `` would compile and would silently
 * render a bracketed missing id the day a fifth category is declared. This
 * form makes that a type error at the declaration instead.
 */
const categoryMessages: Readonly<Record<KeybindCategory, MessageId>> = {
  navigation: 'keybindCategory.navigation',
  operation: 'keybindCategory.operation',
  editing: 'keybindCategory.editing',
  developer: 'keybindCategory.developer',
};

/**
 * Reads the locale in force at the moment of the call. `KeybindList` takes the
 * subscription with `useAppLocale`, which is what re-renders these headings.
 */
export function keybindCategoryLabel(category: KeybindCategory): string {
  return t(categoryMessages[category]);
}
