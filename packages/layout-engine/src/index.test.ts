import { describe, expect, it } from 'vitest';

import {
  LayoutOverflowError,
  resolveGridLayout,
  type GridLayoutRequest,
  type PlacedTile,
} from './index.js';

describe('deterministic tile layout resolver', () => {
  it('keeps a stable priority-first compact layout and stretches an available final gap', () => {
    const request: GridLayoutRequest = {
      columns: 12,
      maximumRows: 4,
      tiles: [
        {
          id: 'primary-video',
          priority: 100,
          variants: [{ presentation: 'full', columns: 8, rows: 4 }],
        },
        {
          id: 'camera-grid',
          priority: 90,
          variants: [
            { presentation: 'full', columns: 4, rows: 3 },
            { presentation: 'compact', columns: 4, rows: 2 },
          ],
        },
        {
          id: 'signal-status',
          priority: 80,
          variants: [{ presentation: 'minimal', columns: 2, rows: 1 }],
          canStretchHorizontally: true,
          maximum: { columns: 4 },
        },
      ],
    };

    const first = resolveGridLayout(request);
    const second = resolveGridLayout(request);

    expect(first).toEqual(second);
    expect(first.placed).toEqual([
      { id: 'primary-video', x: 0, y: 0, columns: 8, rows: 4, presentation: 'full' },
      { id: 'camera-grid', x: 8, y: 0, columns: 4, rows: 3, presentation: 'full' },
      { id: 'signal-status', x: 8, y: 3, columns: 4, rows: 1, presentation: 'minimal' },
    ]);
    expect(first.usedRows).toBe(4);
  });

  it('uses a compact variant before relocating a tile instead of expanding the document', () => {
    const result = resolveGridLayout({
      columns: 6,
      maximumRows: 3,
      tiles: [
        {
          id: 'operation',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 6, rows: 3 },
            { presentation: 'compact', columns: 4, rows: 3 },
          ],
        },
        {
          id: 'history',
          priority: 10,
          variants: [{ presentation: 'minimal', columns: 2, rows: 3 }],
          relocationRoute: '/history',
        },
        {
          id: 'diagnostics',
          priority: 1,
          variants: [{ presentation: 'minimal', columns: 1, rows: 1 }],
          hideWhenOverflow: true,
        },
      ],
    });

    expect(result.placed).toEqual([
      { id: 'operation', x: 0, y: 0, columns: 6, rows: 3, presentation: 'full' },
    ]);
    expect(result.relocated).toEqual([{ id: 'history', route: '/history' }]);
    expect(result.hidden).toEqual([{ id: 'diagnostics', reason: 'overflow' }]);
    expect(result.usedRows).toBe(3);
  });

  it('fails closed when a required tile has no safe overflow policy', () => {
    expect(() =>
      resolveGridLayout({
        columns: 2,
        maximumRows: 1,
        tiles: [
          {
            id: 'required',
            priority: 1,
            variants: [{ presentation: 'minimal', columns: 3, rows: 1 }],
          },
        ],
      }),
    ).toThrow(LayoutOverflowError);
  });
});

describe('no empty cell in a bounded grid', () => {
  /**
   * Reproduces the hole the operations overview showed at 2560x1440: the only
   * tile touching the empty cell sat above it and had asked to be stretched
   * horizontally, not vertically, so the stretch pass could not reach it.
   */
  it('grows a neighbour downwards into a cell its own stretch flags would not reach', () => {
    const result = resolveGridLayout({
      columns: 2,
      maximumRows: 2,
      tiles: [
        { id: 'wide', priority: 100, variants: [{ presentation: 'full', columns: 2, rows: 1 }] },
        {
          id: 'corner',
          priority: 90,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
        },
        {
          id: 'filler',
          priority: 80,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
        },
      ],
    });

    expect(occupiedCells(result, 2)).toBe(4);
  });

  it('grows a neighbour left and up, which the stretch pass never does', () => {
    const result = resolveGridLayout({
      columns: 2,
      maximumRows: 2,
      tiles: [
        {
          id: 'only',
          priority: 100,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
        },
      ],
    });

    // One tile in a 2x1 grid: `usedRows` is 1, so the empty cell beside it is
    // the whole gap, and closing it is the only way the row is full.
    expect(result.usedRows).toBe(1);
    expect(result.placed).toEqual([
      { id: 'only', x: 0, y: 0, columns: 2, rows: 1, presentation: 'full' },
    ]);
  });

  it('leaves the cell empty rather than growing a tile past its declared maximum', () => {
    const result = resolveGridLayout({
      columns: 2,
      maximumRows: 1,
      tiles: [
        {
          id: 'fixed-aspect',
          priority: 100,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          maximum: { columns: 1, rows: 1 },
        },
      ],
    });

    expect(result.placed).toEqual([
      { id: 'fixed-aspect', x: 0, y: 0, columns: 1, rows: 1, presentation: 'full' },
    ]);
    expect(occupiedCells(result, 2)).toBe(1);
  });

  it('stays deterministic once gaps are closed', () => {
    const request: GridLayoutRequest = {
      columns: 3,
      maximumRows: 3,
      tiles: [
        { id: 'a', priority: 30, variants: [{ presentation: 'full', columns: 2, rows: 2 }] },
        { id: 'b', priority: 20, variants: [{ presentation: 'full', columns: 1, rows: 1 }] },
        { id: 'c', priority: 10, variants: [{ presentation: 'full', columns: 1, rows: 1 }] },
      ],
    };

    expect(resolveGridLayout(request)).toEqual(resolveGridLayout(request));
    expect(occupiedCells(resolveGridLayout(request), 3)).toBe(
      3 * resolveGridLayout(request).usedRows,
    );
  });
});

function occupiedCells(
  result: { readonly placed: readonly PlacedTile[] },
  columns: number,
): number {
  const cells = new Set<string>();
  for (const tile of result.placed) {
    expect(tile.x + tile.columns).toBeLessThanOrEqual(columns);
    for (let y = tile.y; y < tile.y + tile.rows; y += 1) {
      for (let x = tile.x; x < tile.x + tile.columns; x += 1) {
        expect(cells.has(`${x}:${y}`)).toBe(false);
        cells.add(`${x}:${y}`);
      }
    }
  }
  return cells.size;
}
