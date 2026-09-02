// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { publishScreenTiles } from '@/components/layout/tileRegistry';
import { operationsStore } from '@/state/operationsStore';

import { TilePresentationPicker } from './TilePresentationPicker';

/**
 * What a mounted `TileGrid` declares on `/archive`: the route is `archive` and
 * the screen it draws is `files`. `/objects/:id` and `/cases/:id` diverge the
 * same way, and `tiles.presentationOverrides` is addressed `screen:tile`, so a
 * picker that qualified the bare tile id with the route wrote entries the grid
 * never reads -- see `TileMotionPicker.test.tsx`, which measured the same
 * defect for R19's animation setting.
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

describe('the tile-presentation picker', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().enterEditMode();
    publishScreenTiles([]);
  });

  it('reads the view stored under the screen the grid published, not under the route', () => {
    operationsStore.getState().applySettingsPatch([
      {
        id: 'tiles.presentationOverrides',
        value: ['files:registry=minimal', 'overview:registry=compact'],
      },
    ]);
    publishArchiveGrid();
    operationsStore.getState().selectEditElement('registry');

    render(<TilePresentationPicker />);

    const tileView = screen.getByRole('combobox', { name: 'Вид плитки REGISTRY' });
    expect(tileView.textContent).toContain('МИНИМАЛЬНЫЙ ВИД');
    expect(tileView.textContent).not.toContain('КОМПАКТНЫЙ ВИД');
  });

  it('offers no per-tile control for a tile no mounted screen draws', () => {
    operationsStore.getState().selectEditElement('registry');

    render(<TilePresentationPicker />);

    expect(screen.queryByRole('combobox', { name: 'Вид плитки REGISTRY' })).toBeNull();
    expect(screen.getByText(/Нажмите на плитку/)).toBeTruthy();
  });

  it('offers the group controls whether or not a tile is selected', () => {
    render(<TilePresentationPicker />);

    expect(screen.getByRole('combobox', { name: 'Вид группы РЕЕСТРЫ' })).toBeTruthy();
  });

  it('lets a tile override its group, and returns to it through auto', () => {
    publishArchiveGrid();
    operationsStore.getState().selectEditElement('registry');
    render(<TilePresentationPicker />);

    const tileView = screen.getByRole('combobox', { name: 'Вид плитки REGISTRY' });
    expect(tileView.textContent).toContain('КАК У ГРУППЫ');

    const stored = () =>
      operationsStore.getState().personalization.draft.values['tiles.presentationOverrides'];
    expect(stored()).toEqual([]);
  });
});
