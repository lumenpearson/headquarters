// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../state/operationsStore';
import { SearchScreen } from './SearchScreen';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

/*
 * The hit list lives inside a tile, and `TileGrid` places nothing until it has
 * measured the box it was given and the chrome of one panel; the shared stub in
 * `vitest.setup.ts` observes nothing on purpose. Reporting both boxes here is
 * what puts the results panel on the screen at all.
 *
 * The floor is 68px -- what `operations.css` draws below 2500px -- and the box
 * is deliberately taller than any window, because these cases assert what the
 * results panel holds and never where the resolver put it. Layout itself is
 * proven against a real engine in `tests/tile-layout.spec.ts`.
 */
globalThis.ResizeObserver = class {
  constructor(private readonly report: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element): void {
    const floor = target.classList.contains('tile-grid__floor');
    target.getBoundingClientRect = () =>
      ({ height: floor ? 68 : 2000, width: floor ? 0 : 1600 }) as DOMRect;
    this.report([{ target, contentRect: { height: 2000, width: 1600 } } as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

/**
 * `EV-1` is a prefix of every seeded event id (`EV-1001` through `EV-1120`) and
 * appears nowhere else in the world, so the match set is exactly the 120
 * events. That is above both ceilings this screen used to carry -- thirty on
 * the events and eighty on the union -- so either of them coming back changes
 * every number below.
 */
const wholeEventIndex = 'EV-1';
const eventCount = 120;
const pagingLabel = 'Страницы результатов поиска';

/** The full text of each hit button, which carries the event's own timestamp and is therefore unique per record. */
function hitTexts(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('.search-hit-list button')].map(
    (hit) => hit.textContent ?? '',
  );
}

function nextPage(): void {
  fireEvent.click(screen.getByRole('button', { name: /NEXT/u }));
}

describe('the search results page rather than truncate', () => {
  beforeEach(() => {
    // Rebuilds the world and the personalization draft from the factory
    // snapshot, so each case starts on the schema's page size of 50.
    operationsStore.getState().resetWorld();
  });

  it('counts the whole match set, not the slice the old ceiling left', () => {
    operationsStore.getState().setSearchQuery(wholeEventIndex);
    const { container } = render(<SearchScreen />);

    // 80 here would mean the union cap is back, 30 the events cap.
    expect(screen.getByText(`${eventCount} СОВПАДЕНИЙ / LOCAL INDEX`)).not.toBeNull();
    expect(hitTexts(container)).toHaveLength(50);
    expect(screen.getByLabelText(pagingLabel).textContent).toContain('СТРАНИЦА 01 / 03');
  });

  it('shows different records on the second page', () => {
    operationsStore.getState().setSearchQuery(wholeEventIndex);
    const { container } = render(<SearchScreen />);
    const first = hitTexts(container);

    nextPage();

    const second = hitTexts(container);
    expect(second).toHaveLength(50);
    expect(second.filter((text) => first.includes(text))).toEqual([]);
    expect(screen.getByLabelText(pagingLabel).textContent).toContain('СТРАНИЦА 02 / 03');
  });

  it('reaches the records the eighty-hit ceiling used to drop', () => {
    operationsStore.getState().setSearchQuery(wholeEventIndex);
    const { container } = render(<SearchScreen />);

    nextPage();
    nextPage();

    // The remainder past two full pages -- records 101 to 120, which the union
    // cap cut off entirely and no control could have reached.
    expect(hitTexts(container)).toHaveLength(eventCount - 100);
    expect(screen.getByLabelText(pagingLabel).textContent).toContain('СТРАНИЦА 03 / 03');
  });

  it('follows tables.pageSize, and drops the control once one page holds everything', () => {
    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'tables.pageSize', value: eventCount + 80 }]);
    operationsStore.getState().setSearchQuery(wholeEventIndex);
    const { container } = render(<SearchScreen />);

    // Not vacuous: every one of the 120 matches is on screen, and the control
    // is absent because there is nowhere to turn to rather than nothing to page.
    expect(hitTexts(container)).toHaveLength(eventCount);
    expect(screen.queryByLabelText(pagingLabel)).toBeNull();
  });

  it('draws no page counter over the prompt shown before a query', () => {
    const { container } = render(<SearchScreen />);

    expect(hitTexts(container)).toEqual([]);
    expect(screen.getByText('БЫСТРЫЙ ПОИСК')).not.toBeNull();
    expect(screen.queryByLabelText(pagingLabel)).toBeNull();
  });
});
