'use client';

import { useCallback, useState } from 'react';

import { queryRecords, type RecordPage, type RecordQuery } from './query';

/**
 * Holds the page a screen is on and resolves it against the current records.
 *
 * `goToPage` is relative to the page that was actually rendered, not to the
 * number held in state. The two diverge as soon as a filter narrows the set --
 * state says page 5, the set now has 3 -- and a control that stepped from the
 * held number would send the operator to page 6, be clamped back to 3, and
 * appear not to respond.
 */
export function useRecordPage<Item>(
  items: readonly Item[],
  query: Omit<RecordQuery<Item>, 'page'>,
): { readonly page: RecordPage<Item>; readonly goToPage: (page: number) => void } {
  const [requested, setRequested] = useState(1);
  const page = queryRecords(items, { ...query, page: requested });
  const goToPage = useCallback((next: number) => setRequested(Math.max(1, Math.trunc(next))), []);
  return { page, goToPage };
}
