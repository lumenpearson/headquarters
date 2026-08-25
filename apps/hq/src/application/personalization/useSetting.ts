'use client';

import {
  getSettingDefinition,
  type SettingValue,
  type SettingValues,
} from '@gremuchaya/settings-schema';

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

/**
 * The same resolution, narrowed to a type, over a values record in hand.
 *
 * A component that already holds the draft — the shell, the startup sequence —
 * has no reason to reach back into the store per setting, but it does need the
 * definition's default rather than a literal beside the lookup. These three are
 * what the hooks and the out-of-React readers below are built from, so there is
 * one resolution in this file and not four.
 *
 * They replace a private `settingString`/`settingNumber`/`settingBoolean` in
 * `OperationsShell.tsx` and a second copy of two of them in
 * `StartupSequence.tsx`. Both took a literal fallback at the call site, which
 * is precisely the duplication the note above says this module removed.
 */
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

export function useStringSetting(id: string): string {
  return useOperationsStore((state) => stringSetting(state.personalization.draft.values, id));
}

export function useNumberSetting(id: string): number {
  return useOperationsStore((state) => numberSetting(state.personalization.draft.values, id));
}

export function useBooleanSetting(id: string): boolean {
  return useOperationsStore((state) => booleanSetting(state.personalization.draft.values, id));
}

export function useStringListSetting(id: string): readonly string[] {
  return useOperationsStore((state) => stringListSetting(state.personalization.draft.values, id));
}

/**
 * The same reads, outside React.
 *
 * A keybind resolver and an issue-draft builder are called from event handlers
 * and plain functions, not from a component, and a hook cannot serve them.
 */
export function readStringSetting(id: string): string {
  return stringSetting(operationsStore.getState().personalization.draft.values, id);
}

export function readNumberSetting(id: string): number {
  return numberSetting(operationsStore.getState().personalization.draft.values, id);
}

export function readBooleanSetting(id: string): boolean {
  return booleanSetting(operationsStore.getState().personalization.draft.values, id);
}
