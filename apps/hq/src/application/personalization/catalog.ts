import {
  settingCategories,
  settingsDefinitions,
  type SettingCategory,
  type SettingDefinition,
} from '@gremuchaya/settings-schema';

import { foldCase } from '@/application/localization/intl';

/**
 * How the settings catalogue is navigated.
 *
 * The screen used to offer one flat list of thirty-two categories and draw
 * whichever was selected. That was already close to unusable and the plan said
 * so: at hundreds of definitions a flat list stops being navigable, and R6 asks
 * for hundreds. Two things fix it, and neither is more rows in the same
 * control — a grouping above the categories, and a search across every
 * definition at once.
 *
 * The groups are named after what an operator is trying to change, not after
 * the layer that implements it: someone dimming the interface is looking for
 * "appearance", not for "the CSS custom properties on the shell root".
 */
export const settingGroups = [
  'appearance',
  'layout',
  'motion',
  'information',
  'media',
  'session',
  'system',
] as const;

export type SettingGroup = (typeof settingGroups)[number];

const groupByCategory: Readonly<Record<SettingCategory, SettingGroup>> = {
  themes: 'appearance',
  styles: 'appearance',
  colors: 'appearance',
  typography: 'appearance',
  backgrounds: 'appearance',
  patterns: 'appearance',

  layout: 'layout',
  tiles: 'layout',
  sizes: 'layout',
  tables: 'layout',

  animations: 'motion',
  startup: 'motion',
  accessibility: 'motion',

  general: 'information',
  information: 'information',
  dateTime: 'information',
  localization: 'information',
  diagnostics: 'information',

  player: 'media',
  cameras: 'media',
  map: 'media',
  materials: 'media',

  popups: 'session',
  keybinds: 'session',
  groups: 'session',
  titlebar: 'session',

  telemetry: 'system',
  simulation: 'system',
  performance: 'system',
  privacy: 'system',
  github: 'system',
  advanced: 'system',
};

export function groupOfCategory(category: SettingCategory): SettingGroup {
  return groupByCategory[category];
}

export function categoriesInGroup(group: SettingGroup): readonly SettingCategory[] {
  return settingCategories.filter((category) => groupByCategory[category] === group);
}

export interface CatalogQuery {
  readonly group: SettingGroup;
  readonly category: SettingCategory | 'all';
  readonly search: string;
  /** Narrows to what the operator has moved, which is what a review of a draft needs. */
  readonly changedOnly: boolean;
  readonly changedIds: readonly string[];
}

export interface CatalogResult {
  readonly definitions: readonly SettingDefinition[];
  /** How many definitions the group holds before search and the changed filter. */
  readonly groupTotal: number;
  readonly changedInGroup: number;
}

/**
 * The definitions a query selects.
 *
 * Search matches the identifier and the description rather than the identifier
 * alone: an operator looking for the interface font knows the word "font", not
 * that the setting is called `typography.weight`.
 */
export function queryCatalog(query: CatalogQuery): CatalogResult {
  const changed = new Set(query.changedIds);
  // A chosen category settles the question on its own; the section is a way of
  // narrowing when no category is chosen, not a second filter the category has
  // to agree with. Making the section win as well would hide a category the
  // operator had just selected, which is the one thing a navigation aid must
  // never do.
  const inGroup =
    query.category === 'all'
      ? settingsDefinitions.filter(
          (definition) => groupByCategory[definition.category] === query.group,
        )
      : settingsDefinitions.filter((definition) => definition.category === query.category);
  const needle = foldCase(query.search.trim());
  const definitions = inGroup.filter((definition) => {
    if (query.changedOnly && !changed.has(definition.id)) return false;
    if (needle.length === 0) return true;
    return (
      foldCase(definition.id).includes(needle) || foldCase(definition.description).includes(needle)
    );
  });
  return {
    definitions,
    groupTotal: inGroup.length,
    changedInGroup: inGroup.filter((definition) => changed.has(definition.id)).length,
  };
}

export interface CategoryRun {
  readonly category: SettingCategory;
  readonly definitions: readonly SettingDefinition[];
}

/**
 * The same definitions, split under the category each one belongs to.
 *
 * The settings screen can afford a category select beside its section select;
 * the floating panel cannot spend a row on a second control. It shows a whole
 * section at once instead and lets the categories be headings inside the list,
 * which needs the definitions grouped rather than flat.
 *
 * The order is `settingCategories`, not the order the definitions arrived in,
 * so the same section always reads the same way — a list that reorders itself
 * between two openings of the panel is a list the operator has to re-read.
 */
export function splitByCategory(definitions: readonly SettingDefinition[]): readonly CategoryRun[] {
  return settingCategories
    .map((category) => ({
      category,
      definitions: definitions.filter((definition) => definition.category === category),
    }))
    .filter((run) => run.definitions.length > 0);
}

/**
 * A search across every group, for the case the operator does not know which
 * group holds what they want — which is the case a grouping creates and has to
 * answer for.
 */
export function searchEverySetting(
  search: string,
  changedIds: readonly string[],
  changedOnly = false,
): readonly SettingDefinition[] {
  const needle = foldCase(search.trim());
  if (needle.length === 0) return [];
  const changed = new Set(changedIds);
  return settingsDefinitions.filter((definition) => {
    if (changedOnly && !changed.has(definition.id)) return false;
    return (
      foldCase(definition.id).includes(needle) || foldCase(definition.description).includes(needle)
    );
  });
}
