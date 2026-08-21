import { describe, expect, it } from 'vitest';

import { LayoutOverflowError, resolveGridLayout, type GridLayoutRequest } from './index.js';

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
