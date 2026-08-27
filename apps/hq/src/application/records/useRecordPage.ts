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
  /**
   * What the operator is asking for, as a value that changes when the question
   * changes -- the search text and the filter chips, joined however the screen
   * likes.
   *
   * Without it the held page survived a new question: clamping keeps the page
   * inside the new range, so nothing blanks and nothing throws, and the
   * operator simply lands partway down results they have not seen the top of.
   * On a screen whose set narrows with every keystroke that is every keystroke.
   *
   * It is deliberately not derived from `items`: a record arriving from the
   * group changes the set without changing the question, and resetting there
   * would yank a reader off the page they were on. It is deliberately not
   * derived from `query` either -- the filters and the comparator are closures,
   * rebuilt every render, so no comparison of them can mean anything.
   *
   * A screen that passes nothing keeps the previous behaviour exactly.
   */
  askedFor?: string,
): { readonly page: RecordPage<Item>; readonly goToPage: (page: number) => void } {
  const [requested, setRequested] = useState(1);
  const [lastAsked, setLastAsked] = useState(askedFor);

  /*
   * Adjusted during render rather than in an effect, which is what React
   * documents for state that follows a prop: an effect would render the stale
   * page once, then render again, and the operator would see the old page
   * flash before the new one.
   */
  let current = requested;
  if (askedFor !== lastAsked) {
    setLastAsked(askedFor);
    setRequested(1);
    current = 1;
  }

  const page = queryRecords(items, { ...query, page: current });
  const goToPage = useCallback((next: number) => setRequested(Math.max(1, Math.trunc(next))), []);
  return { page, goToPage };
}
