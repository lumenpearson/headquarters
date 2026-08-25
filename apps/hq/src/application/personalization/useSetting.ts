'use client';

import { getSettingDefinition, type SettingValue } from '@gremuchaya/settings-schema';

import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * Reading a personalization setting, once.
 *
 * Every consumer used to repeat the setting's default as a literal beside the
 * lookup. Two copies of a default are two things to keep in step, and the
 * schema already states it — so these readers resolve through the definition
 * and a call site names only the identifier.
 *
 * A value the definition would reject falls back to that default as well. The
 * draft is validated on the way in, but a blob persisted by an older build is
 * not, and a stale value reaching a consumer is how a setting starts meaning
 * something it never meant.
 */
export function resolveSettingValue(
  values: Readonly<Record<string, SettingValue>>,
  id: string,
): SettingValue | undefined {
  const definition = getSettingDefinition(id);
  if (definition === undefined) return undefined;
  const value = values[id];
  return value !== undefined && definition.validate(value) ? value : definition.defaultValue;
}

export function useStringSetting(id: string): string {
  return useOperationsStore((state) => {
    const value = resolveSettingValue(state.personalization.draft.values, id);
    return typeof value === 'string' ? value : '';
  });
}

export function useNumberSetting(id: string): number {
  return useOperationsStore((state) => {
    const value = resolveSettingValue(state.personalization.draft.values, id);
    return typeof value === 'number' ? value : 0;
  });
}

export function useBooleanSetting(id: string): boolean {
  return useOperationsStore((state) => {
    const value = resolveSettingValue(state.personalization.draft.values, id);
    return value === true;
  });
}

/**
 * The same reads, outside React.
 *
 * A keybind resolver and an issue-draft builder are called from event handlers
 * and plain functions, not from a component, and a hook cannot serve them.
 */
export function readStringSetting(id: string): string {
  const value = resolveSettingValue(operationsStore.getState().personalization.draft.values, id);
  return typeof value === 'string' ? value : '';
}

export function readBooleanSetting(id: string): boolean {
  return resolveSettingValue(operationsStore.getState().personalization.draft.values, id) === true;
}
