'use client';

import { TerminalButton } from '@gremuchaya/ui/primitives';
import type { ReactNode } from 'react';

import type { RecordPage } from '@/application/records/query';

/**
 * The pagination footer every table on a data screen uses.
 *
 * It replaces the one `CasesScreen` drew by hand, where the buttons carried no
 * handler and the counter read a literal `СТРАНИЦА 01 / 02` whatever the table
 * held (C22). A control that cannot be rendered without the page it describes
 * cannot drift from it.
 */
export function RecordPagination<Item>({
  page,
  onPage,
  label,
  children,
}: {
  readonly page: RecordPage<Item>;
  readonly onPage: (page: number) => void;
  readonly label: string;
  /** Trailing context the screen wants beside the controls, such as the selection. */
  readonly children?: ReactNode;
}) {
  const numbers = pageNumbers(page.page, page.pageCount);
  return (
    <footer className="registry-pagination" aria-label={label}>
      <span>
        СТРАНИЦА {String(page.page).padStart(2, '0')} / {String(page.pageCount).padStart(2, '0')} ·{' '}
        {page.total}
      </span>
      <TerminalButton disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>
        [◀] PREV
      </TerminalButton>
      {numbers.map((number) => (
        <TerminalButton
          key={number}
          className={number === page.page ? 'is-active' : ''}
          onClick={() => onPage(number)}
        >
          {String(number).padStart(2, '0')}
        </TerminalButton>
      ))}
      <TerminalButton disabled={page.page >= page.pageCount} onClick={() => onPage(page.page + 1)}>
        NEXT [▶]
      </TerminalButton>
      {children}
    </footer>
  );
}

/**
 * A window of at most five numbers around the current page. A registry with
 * forty pages would otherwise put forty buttons in a footer that has to fit
 * inside a bounded panel (R26).
 */
function pageNumbers(page: number, pageCount: number): readonly number[] {
  const span = Math.min(5, pageCount);
  const first = Math.min(Math.max(1, page - Math.floor(span / 2)), pageCount - span + 1);
  return Array.from({ length: span }, (_, index) => first + index);
}
