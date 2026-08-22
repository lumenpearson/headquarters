'use client';

import { useOperationsStore } from '@/state/operationsStore';

/**
 * The page size every data table on a screen uses.
 *
 * `tables.pageSize` was one of the eighteen definitions that were rendered,
 * validated, saved into the draft and read by nothing (C20). This is the
 * consumer that makes moving it change what the operator sees.
 */
export function useTablePageSize(): number {
  return useOperationsStore((state) => {
    const value = state.personalization.draft.values['tables.pageSize'];
    return typeof value === 'number' && Number.isFinite(value) ? value : 50;
  });
}
