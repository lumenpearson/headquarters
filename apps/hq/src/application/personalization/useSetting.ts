'use client';

import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { booleanSetting, numberSetting, stringListSetting, stringSetting } from './settingValue';

/**
 * Reading a personalization setting inside React, and from an event handler.
 *
 * The resolution itself lives in `settingValue.ts`, with no store behind it, so
 * `operationsStore` can use it while hydrating without importing a module that
 * imports it back. These are the store-bound wrappers over it.
 */

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

/**
 * The list form, outside React.
 *
 * Added for R28's translation proposal: the link is built from a click
 * handler and has to read the captures the operator stored, which live in a
 * `string-list` definition. The other three had non-React readers already;
 * this one had only its hook.
 */
export function readStringListSetting(id: string): readonly string[] {
  return stringListSetting(operationsStore.getState().personalization.draft.values, id);
}
