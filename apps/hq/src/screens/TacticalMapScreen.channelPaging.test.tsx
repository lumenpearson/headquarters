// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../state/operationsStore';
import { TacticalMapScreen } from './TacticalMapScreen';

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

// Rendering the real surface would load Yandex Maps API v3 in jsdom, which has
// nothing to do with the channel table and nothing jsdom can do.
vi.mock('@/components/operations/YandexTacticalMap', () => ({
  YandexTacticalMap: () => null,
}));

/*
 * `TileGrid` places nothing until it has measured the box it was given and the
 * chrome of one panel; the shared stub in `vitest.setup.ts` observes nothing on
 * purpose. The channel tile carries the lowest priority on this screen, so the
 * box reported here is deliberately taller than any window: these cases assert
 * what the table holds, never where the resolver put it, and the layout itself
 * is proven against a real engine in `tests/tile-layout.spec.ts`. The floor is
 * 68px, what `operations.css` draws below 2500px.
 */
globalThis.ResizeObserver = class {
  constructor(private readonly report: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element): void {
    const floor = target.classList.contains('tile-grid__floor');
    target.getBoundingClientRect = () =>
      ({ height: floor ? 68 : 2400, width: floor ? 0 : 1920 }) as DOMRect;
    this.report([{ target, contentRect: { height: 2400, width: 1920 } } as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

/** The seeded world carries ten channels and the tile holds six, so the table is two pages deep. */
const seededChannels = 10;
const rowsPerPage = 6;
const pagingLabel = 'Страницы таблицы каналов связи';

/** The first cell of every channel row, which is the channel id. */
function channelIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('.map-channels-panel tbody tr')].map(
    (row) => row.querySelector('td')?.textContent ?? '',
  );
}

/** The `LOSS` cell, as the number the comparator sorted on rather than the text it prints. */
function packetLosses(container: HTMLElement): readonly number[] {
  return [...container.querySelectorAll('.map-channels-panel tbody tr')].map((row) =>
    Number.parseFloat(row.querySelectorAll('td')[3]?.textContent ?? ''),
  );
}

function nextPage(): void {
  fireEvent.click(screen.getByRole('button', { name: /NEXT/u }));
}

describe('the channel table on the tactical map pages the whole set', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('holds one tile of rows and says how many pages the rest fill', () => {
    const { container } = render(<TacticalMapScreen />);

    expect(channelIds(container)).toEqual(['CH-01', 'CH-02', 'CH-03', 'CH-04', 'CH-05', 'CH-06']);
    expect(screen.getByLabelText(pagingLabel).textContent).toContain(
      `СТРАНИЦА 01 / 02 · ${seededChannels}`,
    );
  });

  it('reaches the four channels the six-row cut left unreadable', () => {
    const { container } = render(<TacticalMapScreen />);
    const first = channelIds(container);

    nextPage();

    const second = channelIds(container);
    expect(second).toEqual(['CH-07', 'CH-08', 'CH-09', 'CH-10']);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    expect(screen.getByLabelText(pagingLabel).textContent).toContain('СТРАНИЦА 02 / 02');
  });

  it('sorts the whole set before paging it, not the rows already on screen', () => {
    const { container } = render(<TacticalMapScreen />);
    fireEvent.click(screen.getByRole('button', { name: /LOSS/u }));

    const first = packetLosses(container);
    nextPage();
    const second = packetLosses(container);

    // CH-03 is the seed's only lossy channel at 18.4%; ascending, it belongs
    // last, on the second page. That is what pins the comparator to the shared
    // pass rather than to the rows on screen: a sort applied after the slice
    // would leave CH-03 on page one, where its position in the id order put it.
    expect(first).toEqual([...first].sort((a, b) => a - b));
    expect(Math.max(...first)).toBeLessThanOrEqual(Math.min(...second));
    expect(second.at(-1)).toBe(18.4);
  });

  it('drops the control when the channels fit the tile', () => {
    const channels = operationsStore.getState().channels;
    const fitting = Object.fromEntries(Object.entries(channels).slice(0, rowsPerPage));
    operationsStore.setState({ channels: fitting });

    const { container } = render(<TacticalMapScreen />);

    // Not vacuous: a full tile of rows is drawn and the footer is still absent,
    // so it answers to the page count rather than to the table being empty.
    expect(channelIds(container)).toHaveLength(rowsPerPage);
    expect(screen.queryByLabelText(pagingLabel)).toBeNull();
  });
});

/**
 * The other two lists on this screen are map-side summaries and stay that way.
 *
 * Both draw a head of a set that is already on the surface -- the alerts under
 * `map.alertRows`, the sensors under the `sensors` layer -- so there is nothing
 * for a page-turner to turn to. These cases pin that as a decision rather than
 * an omission, so the next reading of R9 does not "fix" them into pages.
 */
describe('the alert and sensor heads stay heads', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('lists the alerts map.alertRows asks for and offers no page after them', () => {
    const { container } = render(<TacticalMapScreen />);

    const unresolved = Object.values(operationsStore.getState().alerts).filter(
      (alert) => alert.lifecycle !== 'RESOLVED',
    );
    // The head is shorter than the set it heads, and still carries no control.
    expect(unresolved.length).toBeGreaterThan(6);
    expect(container.querySelectorAll('.compact-alert-list button')).toHaveLength(6);
    expect(screen.queryByLabelText(/Страницы.*тревог/u)).toBeNull();
  });

  it('lists seven sensors and offers no page after them', () => {
    const { container } = render(<TacticalMapScreen />);

    expect(Object.keys(operationsStore.getState().sensors).length).toBeGreaterThan(7);
    expect(container.querySelectorAll('.map-sensors-panel button')).toHaveLength(7);
    expect(screen.queryByLabelText(/Страницы.*датчик/u)).toBeNull();
  });
});
