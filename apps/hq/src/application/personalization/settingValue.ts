import {
  getSettingDefinition,
  type SettingValue,
  type SettingValues,
} from '@gremuchaya/settings-schema';

/**
 * Resolving a personalization setting from a values record, with no runtime
 * behind it.
 *
 * This is deliberately separate from `useSetting.ts`, which imports the store
 * to serve React and the event handlers. `operationsStore` itself has to read a
 * setting while it hydrates — `startup.restoreWorld` decides what that
 * hydration keeps — and it cannot import a module that imports it back. The
 * alternative was a fourth private copy of this resolution, which is what rule
 * 2.5 refuses.
 *
 * Every consumer used to repeat the setting's default as a literal beside the
 * lookup. Two copies of a default are two things to keep in step, and the
 * schema already states it, so a call site names only the identifier. A value
 * the definition would reject falls back to that default as well: the draft is
 * validated on the way in, but a blob persisted by an older build is not.
 */
export function resolveSettingValue(values: SettingValues, id: string): SettingValue | undefined {
  const definition = getSettingDefinition(id);
  if (definition === undefined) return undefined;
  const value = values[id];
  return value !== undefined && definition.validate(value) ? value : definition.defaultValue;
}

export function stringSetting(values: SettingValues, id: string): string {
  const value = resolveSettingValue(values, id);
  return typeof value === 'string' ? value : '';
}

export function numberSetting(values: SettingValues, id: string): number {
  const value = resolveSettingValue(values, id);
  return typeof value === 'number' ? value : 0;
}

export function booleanSetting(values: SettingValues, id: string): boolean {
  return resolveSettingValue(values, id) === true;
}

/** A `string-list` setting, narrowed to the array its editor stores. */
export function stringListSetting(values: SettingValues, id: string): readonly string[] {
  const value = resolveSettingValue(values, id);
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
