// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TileGrid, type ScreenTile } from './TileGrid.js';
import { screenTilesSnapshot } from './tileRegistry.js';

// `TileGrid` calls `useRouter()` for the relocation link it may draw. Nothing
// here navigates; the stub only has to satisfy the call on render.
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
 * The registry is what the edit panel offers to switch off by name, and the
 * edit panel lives in the root layout: it outlives every screen. A grid that
 * published its tiles and never withdrew them left `/video`, `/settings` and
 * `/dev/ui` — the three routes that draw no grid — offering the tiles of
 * whichever screen was shown last, and writing `screen:tile` keys for a screen
 * out of view.
 */
describe('the screen tile registry', () => {
  it('withdraws its tiles when the grid leaves', () => {
    const view = render(
      <TileGrid tiles={[tile('registry')]} columns={2} className="" screen="cases" />,
    );

    expect(screenTilesSnapshot().map((entry) => entry.key)).toEqual(['cases:registry']);

    view.unmount();

    expect(screenTilesSnapshot()).toEqual([]);
  });

  it('keeps the table filled while the same grid republishes', () => {
    const view = render(
      <TileGrid tiles={[tile('registry')]} columns={2} className="" screen="cases" />,
    );
    const keysDuring: string[][] = [];
    // Re-rendering with a different set is the republication path. Clearing on
    // every change instead of on unmount would empty the table for a tick here,
    // and the panel offering the tiles would blink empty on any screen that
    // adds or removes one.
    view.rerender(
      <TileGrid
        tiles={[tile('registry'), tile('summary')]}
        columns={2}
        className=""
        screen="cases"
      />,
    );
    keysDuring.push(screenTilesSnapshot().map((entry) => entry.key));

    expect(keysDuring).toEqual([['cases:registry', 'cases:summary']]);
    view.unmount();
  });
});

function tile(id: string): ScreenTile {
  return {
    descriptor: {
      id,
      priority: 1,
      variants: [{ presentation: 'full', columns: 1, rows: 1 }],
    },
    title: id.toUpperCase(),
    category: 'records',
    render: () => <div data-testid={id} />,
  };
}
