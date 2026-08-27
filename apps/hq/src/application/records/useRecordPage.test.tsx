// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useRecordPage } from './useRecordPage';

/**
 * That a new question opens at the top of its own results.
 *
 * The hook clamps a held page into the range the current set leaves, which is
 * what stops an empty page ever rendering. Clamping alone is not enough: a
 * filter that narrows the set leaves an operator sitting on page 3 of results
 * they have not seen the first of, and nothing on the screen says why the list
 * starts midway. The half that was missing is knowing that the *question*
 * changed, which no comparison of the items or of the query closures supplies —
 * the filters and the comparator are closures rebuilt on every render.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const records: readonly number[] = Array.from({ length: 30 }, (_, index) => index + 1);
const firstPage = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const thirdPage = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

interface Observed {
  readonly page: number;
  readonly items: readonly number[];
  readonly pageCount: number;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** The hook under an owner that holds the two things a screen can change. */
function harness(initialAskedFor: string | undefined) {
  const seen: Observed[] = [];
  let goToPage: (page: number) => void = () => undefined;
  let ask: (value: string | undefined) => void = () => undefined;
  let replace: (value: readonly number[]) => void = () => undefined;

  function Owner() {
    const [askedFor, setAskedFor] = useState(initialAskedFor);
    const [items, setItems] = useState(records);
    ask = setAskedFor;
    replace = setItems;

    const result = useRecordPage(items, { pageSize: 10 }, askedFor);
    goToPage = result.goToPage;
    seen.push({
      page: result.page.page,
      items: result.page.items,
      pageCount: result.page.pageCount,
    });
    return null;
  }

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Owner />));

  return {
    latest: (): Observed => {
      const last = seen.at(-1);
      if (last === undefined) throw new Error('the probe never rendered');
      return last;
    },
    goToPage: (page: number) => act(() => goToPage(page)),
    ask: (value: string | undefined) => act(() => ask(value)),
    replaceItems: (value: readonly number[]) => act(() => replace(value)),
  };
}

describe('useRecordPage', () => {
  it('opens a new question at its first page rather than where the last one left off', () => {
    const test = harness('everything');
    test.goToPage(3);
    expect(test.latest()).toMatchObject({ page: 3, items: thirdPage });

    test.ask('something narrower');

    // The whole defect in one assertion: the set is untouched and still has
    // three pages, so clamping alone would have left the operator on page 3.
    expect(test.latest()).toMatchObject({ page: 1, pageCount: 3, items: firstPage });
  });

  it('holds the page when the records change but the question does not', () => {
    const test = harness('everything');
    test.goToPage(2);

    // A record arriving from the group is not a new question, and a reader on
    // page 2 must not be thrown to the top by it.
    test.replaceItems([...records, 31, 32]);

    expect(test.latest()).toMatchObject({ page: 2, pageCount: 4 });
  });

  it('clamps a held page into a set that shrank under it', () => {
    const test = harness('everything');
    test.goToPage(3);

    test.replaceItems(records.slice(0, 12));

    // No reset — the question stands — but the page is inside the range. This
    // is the behaviour that predates the reset and has to survive it.
    expect(test.latest()).toMatchObject({ page: 2, pageCount: 2 });
  });

  it('behaves exactly as before for a screen that names no question', () => {
    const test = harness(undefined);
    test.goToPage(3);
    expect(test.latest().page).toBe(3);

    test.replaceItems([...records, 31]);

    expect(test.latest().page).toBe(3);
  });
});
