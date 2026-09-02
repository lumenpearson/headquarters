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

describe('a minimum tile width decided in pixels, not by shrinking the column count', () => {
  /**
   * The approach measured against real screens before this one: reduce
   * `columns` itself by the container width divided by the floor, and pass
   * the reduced count to the resolver. A screen's `columns` is a coordinate
   * system it chose for itself -- twelfths here -- not a pixel promise, so a
   * tile declared against the real count becomes wider than the reduced grid
   * has room for and is unplaceable outright. That emptied eleven routes and
   * failed four `R10` scenarios; `columns` must stay exactly what the screen
   * declared.
   */
  it('keeps the declared column count, even when it would have been reduced past a tile’s span', () => {
    const request: GridLayoutRequest = {
      columns: 12,
      maximumRows: 1,
      // At a 480px container, the floor divided into it would round to two
      // or three columns -- far short of the eight this tile actually asks
      // for in the twelfths this screen measures itself in.
      containerWidth: 480,
      minimumTileWidth: 240,
      tiles: [
        {
          id: 'registry',
          priority: 100,
          variants: [{ presentation: 'full', columns: 8, rows: 1 }],
        },
        // Fills the remaining four columns exactly, so the gap-closing pass
        // has nothing left to grow `registry` into: the assertion below is
        // reading the placement decision, not a later pass reshaping it.
        {
          id: 'filler',
          priority: 10,
          variants: [{ presentation: 'full', columns: 4, rows: 1 }],
        },
      ],
    };

    const result = resolveGridLayout(request);

    expect(result.placed).toEqual([
      { id: 'registry', x: 0, y: 0, columns: 8, rows: 1, presentation: 'full' },
      { id: 'filler', x: 8, y: 0, columns: 4, rows: 1, presentation: 'full' },
    ]);
    expect(result.relocated).toEqual([]);
    expect(result.hidden).toEqual([]);
  });

  it('skips a variant that renders under the floor in favour of a wider, more compact one', () => {
    const result = resolveGridLayout({
      columns: 4,
      maximumRows: 4,
      containerWidth: 400,
      minimumTileWidth: 150,
      tiles: [
        {
          id: 'panel',
          priority: 100,
          // 100px wide at a 100px column -- under the floor -- ranked above a
          // 200px-wide variant with less area, which is exactly the ordering
          // `validateRequest` allows: area may only fall as variants go on.
          variants: [
            { presentation: 'full', columns: 1, rows: 4 },
            { presentation: 'compact', columns: 2, rows: 1 },
          ],
        },
      ],
    });

    // Placed at the wider compact variant, then grown to fill the row the
    // gap-closing pass leaves it alone in -- the decision under test is the
    // presentation and the fact that it was placed at all, not the width the
    // later pass grew it to.
    expect(result.placed).toEqual([
      { id: 'panel', x: 0, y: 0, columns: 4, rows: 1, presentation: 'compact' },
    ]);
  });

  it('relocates a tile whose every variant falls under the floor, by name rather than by dropping it', () => {
    const result = resolveGridLayout({
      columns: 4,
      maximumRows: 1,
      containerWidth: 400,
      minimumTileWidth: 150,
      tiles: [
        { id: 'anchor', priority: 100, variants: [{ presentation: 'full', columns: 3, rows: 1 }] },
        {
          id: 'narrow',
          priority: 90,
          // 100px wide at a 100px column, under the 150px floor, and no size
          // this tile ever offers clears it.
          variants: [{ presentation: 'minimal', columns: 1, rows: 1 }],
          relocationRoute: '/narrow-details',
        },
      ],
    });

    expect(result.placed).toEqual([
      { id: 'anchor', x: 0, y: 0, columns: 4, rows: 1, presentation: 'full' },
    ]);
    expect(result.relocated).toEqual([{ id: 'narrow', route: '/narrow-details' }]);
    expect(result.hidden).toEqual([]);
  });

  it('hides a tile whose every variant falls under the floor when it declares no route', () => {
    const result = resolveGridLayout({
      columns: 4,
      maximumRows: 1,
      containerWidth: 400,
      minimumTileWidth: 150,
      tiles: [
        { id: 'anchor', priority: 100, variants: [{ presentation: 'full', columns: 3, rows: 1 }] },
        {
          id: 'narrow',
          priority: 90,
          variants: [{ presentation: 'minimal', columns: 1, rows: 1 }],
          hideWhenOverflow: true,
        },
      ],
    });

    expect(result.hidden).toEqual([{ id: 'narrow', reason: 'overflow' }]);
    expect(result.relocated).toEqual([]);
  });

  /**
   * The fourth `R10` shape: a tile with no `relocationRoute` and no
   * `hideWhenOverflow` never leaves silently, because there is nothing that
   * could take it -- the resolver's existing fails-closed contract for a
   * tile that does not fit the grid at all. The floor must not invent a new
   * way for that contract to bite: relocation frees no room when there is
   * nowhere to send the tile, so it is placed at its normal size instead.
   */
  it('places a required tile at its normal size when the floor alone would have excluded it', () => {
    const result = resolveGridLayout({
      columns: 4,
      maximumRows: 1,
      containerWidth: 400,
      minimumTileWidth: 150,
      tiles: [
        {
          id: 'required',
          priority: 100,
          // 100px wide at a 100px column, under the floor, and no route or
          // permission to hide -- the grid it fits fine by cell count alone.
          variants: [{ presentation: 'minimal', columns: 1, rows: 1 }],
        },
      ],
    });

    // Grown to fill the row by the gap-closing pass, same as `panel` above --
    // the claim under test is that it is placed at all rather than relocated
    // or hidden.
    expect(result.placed).toEqual([
      { id: 'required', x: 0, y: 0, columns: 4, rows: 1, presentation: 'minimal' },
    ]);
    expect(result.relocated).toEqual([]);
    expect(result.hidden).toEqual([]);
  });

  it('runs exactly as before when neither containerWidth nor minimumTileWidth is given', () => {
    const tiles: GridLayoutRequest['tiles'] = [
      { id: 'only', priority: 100, variants: [{ presentation: 'minimal', columns: 1, rows: 1 }] },
    ];

    expect(resolveGridLayout({ columns: 4, maximumRows: 1, tiles }).placed).toEqual([
      { id: 'only', x: 0, y: 0, columns: 4, rows: 1, presentation: 'minimal' },
    ]);
  });

  it('rejects a container width or a floor that is not a positive finite number', () => {
    const tiles: GridLayoutRequest['tiles'] = [
      { id: 'only', priority: 100, variants: [{ presentation: 'minimal', columns: 1, rows: 1 }] },
    ];

    expect(() =>
      resolveGridLayout({
        columns: 4,
        maximumRows: 1,
        tiles,
        containerWidth: 0,
        minimumTileWidth: 1,
      }),
    ).toThrow(/containerWidth/);
    expect(() =>
      resolveGridLayout({
        columns: 4,
        maximumRows: 1,
        tiles,
        containerWidth: 400,
        minimumTileWidth: Number.NaN,
      }),
    ).toThrow(/minimumTileWidth/);
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
