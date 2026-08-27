// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { publishScreenTiles } from '@/components/layout/tileRegistry';
import { operationsStore } from '@/state/operationsStore';

import { TileMotionPicker } from './TileMotionPicker';

/**
 * What a mounted `TileGrid` declares on `/archive`: the route is `archive` and
 * the screen it draws is `files`. `/objects/:id` and `/cases/:id` diverge the
 * same way, and `tiles.animations` is addressed `screen:tile`, so a picker that
 * qualified the bare tile id with the route wrote entries the grid never reads.
 */
function publishArchiveGrid(): void {
  publishScreenTiles([
    {
      key: 'files:registry',
      id: 'registry',
      screen: 'files',
      title: 'РЕЕСТР ФАЙЛОВ',
      category: 'records',
    },
  ]);
}

describe('the tile-motion picker', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().enterEditMode();
    publishScreenTiles([]);
  });

  it('reads the motion stored under the screen the grid published, not under the route', () => {
    /*
     * Both entries are stored, and only one of them is this tile's. The route
     * is `overview` here and the mounted grid is `files`, so a picker reading
     * `ui.route` shows `ПОДЪЁМ` -- the entry addressed to a screen nothing
     * draws -- and the operator is shown a motion the tile does not have.
     */
    operationsStore
      .getState()
      .applySettingsPatch([
        { id: 'tiles.animations', value: ['files:registry=scan', 'overview:registry=rise'] },
      ]);
    publishArchiveGrid();
    operationsStore.getState().selectEditElement('registry');

    render(<TileMotionPicker />);

    const tileMotion = screen.getByRole('combobox', { name: 'Движение плитки REGISTRY' });
    expect(tileMotion.textContent).toContain('РАЗВЁРТКА');
    expect(tileMotion.textContent).not.toContain('ПОДЪЁМ');
  });

  it('offers no per-tile control for a tile no mounted screen draws', () => {
    // A selection outlives a navigation. A tile that is on no screen has no
    // address a grid would read, and answering with the current route is the
    // defect above rather than a fallback.
    operationsStore.getState().selectEditElement('registry');

    render(<TileMotionPicker />);

    expect(screen.queryByRole('combobox', { name: 'Движение плитки REGISTRY' })).toBeNull();
    expect(screen.getByText(/Нажмите на плитку/)).toBeTruthy();
  });

  it('offers the group controls whether or not a tile is selected', () => {
    // The category half of R19 is about the whole application, so it does not
    // wait for a selection: the picker with nothing selected is still a control.
    render(<TileMotionPicker />);

    expect(screen.getByRole('combobox', { name: 'Движение группы РЕЕСТРЫ' })).toBeTruthy();
  });
});
