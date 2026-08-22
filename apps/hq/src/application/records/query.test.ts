import { describe, expect, it } from 'vitest';

import { maximumPageSize, queryRecords } from './query';

interface Row {
  readonly id: string;
  readonly rank: number;
}

const rows: readonly Row[] = Array.from({ length: 23 }, (_, index) => ({
  id: `R-${String(index + 1).padStart(2, '0')}`,
  rank: (index * 7) % 23,
}));

describe('the shared record query', () => {
  it('bounds a page beyond the end to the last page that has records', () => {
    const page = queryRecords(rows, { page: 99, pageSize: 10 });

    expect(page.page).toBe(3);
    expect(page.pageCount).toBe(3);
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(23);
  });

  it('recounts the pages against the filtered set, not the whole one', () => {
    const page = queryRecords(rows, {
      page: 2,
      pageSize: 10,
      filters: [(row) => row.rank < 5],
    });

    // Five of twenty-three ranks are below five, so the second page of ten
    // cannot exist and the query says so rather than returning nothing.
    expect(page.total).toBe(5);
    expect(page.pageCount).toBe(1);
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(5);
  });

  it('requires every filter to accept a record, not any of them', () => {
    const page = queryRecords(rows, {
      page: 1,
      pageSize: 50,
      filters: [(row) => row.rank < 10, (row) => row.id.endsWith('1')],
    });

    expect(page.items.every((row) => row.rank < 10 && row.id.endsWith('1'))).toBe(true);
    expect(page.total).toBeLessThan(rows.length);
  });

  it('sorts a copy, so the caller keeps the order it passed', () => {
    const source = [...rows];
    queryRecords(source, {
      page: 1,
      pageSize: 5,
      comparator: (left, right) => left.rank - right.rank,
    });

    expect(source).toEqual(rows);
  });

  it('sorts before paging, so page two follows page one in the sorted order', () => {
    const comparator = (left: Row, right: Row) => left.rank - right.rank;
    const first = queryRecords(rows, { page: 1, pageSize: 5, comparator });
    const second = queryRecords(rows, { page: 2, pageSize: 5, comparator });

    const lastOfFirst = first.items.at(-1);
    const firstOfSecond = second.items[0];
    expect(lastOfFirst).toBeDefined();
    expect(firstOfSecond).toBeDefined();
    expect(lastOfFirst!.rank).toBeLessThanOrEqual(firstOfSecond!.rank);
  });

  it('holds a page size to the bound, in both directions', () => {
    expect(queryRecords(rows, { page: 1, pageSize: 0 }).pageSize).toBe(1);
    expect(queryRecords(rows, { page: 1, pageSize: -5 }).pageSize).toBe(1);
    expect(queryRecords(rows, { page: 1, pageSize: 10_000 }).pageSize).toBe(maximumPageSize);
  });

  it('reports one empty page rather than none when nothing matches', () => {
    const page = queryRecords(rows, { page: 1, pageSize: 10, filters: [() => false] });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.pageCount).toBe(1);
    expect(page.page).toBe(1);
  });
});
