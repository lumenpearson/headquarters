/**
 * The one filter/sort/pagination pass in the application.
 *
 * Two of these existed before, written independently: `querySettingsHistory`
 * and `queryCameraRegistry`. They agreed on the shape of the work -- filter,
 * sort, clamp the page size, clamp the page into the range the filtered set
 * leaves, slice -- and disagreed on the names for the result (`pageCount`
 * against `totalPages`, `total` against `totalItems`) and on the bound for the
 * page size. Every screen that needed the same thing therefore had to pick one
 * to copy, which is how `CasesScreen` ended up with pagination controls that
 * were drawn and wired to nothing (C22).
 *
 * The domain-specific parts stay with their domain: a caller supplies the
 * predicates and the comparator, and gets back a page it does not have to
 * bound-check.
 */

export interface RecordQuery<Item> {
  readonly page: number;
  readonly pageSize: number;
  /**
   * Every predicate must accept an item for it to survive. Passing them
   * separately rather than pre-filtering is what lets the caller keep one
   * predicate per control on screen.
   */
  readonly filters?: readonly ((item: Item) => boolean)[];
  readonly comparator?: ((left: Item, right: Item) => number) | undefined;
}

export interface RecordPage<Item> {
  readonly items: readonly Item[];
  /** Clamped into `1..pageCount`, so a caller never renders an empty page. */
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly total: number;
}

/** The largest page any screen may ask for, so one control cannot render thousands of rows. */
export const maximumPageSize = 200;

export function queryRecords<Item>(
  items: readonly Item[],
  query: RecordQuery<Item>,
): RecordPage<Item> {
  const pageSize = Math.min(maximumPageSize, Math.max(1, Math.trunc(query.pageSize)));
  const filters = query.filters ?? [];
  /*
   * `filter` allocates, so `filtered` is already this function's own array and
   * sorting it in place cannot reach the caller's. Mutation testing is what
   * settled that: a defensive `[...filtered]` stood here and no test could
   * tell whether it was removed. The guarantee is still worth a test, because
   * skipping the filter when no predicate was supplied is the obvious
   * optimisation and would hand the caller's array straight to `sort`.
   */
  const filtered = items.filter((item) => filters.every((matches) => matches(item)));
  const sorted = query.comparator === undefined ? filtered : filtered.sort(query.comparator);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(query.page)), pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: sorted.slice(start, start + pageSize),
    page,
    pageSize,
    pageCount,
    total: sorted.length,
  };
}
