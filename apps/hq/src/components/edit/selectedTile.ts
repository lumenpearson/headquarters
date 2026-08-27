'use client';

import { parseContentElementId } from '@/application/edit/contentFields';
import { useScreenTiles } from '@/components/layout/tileRegistry';
import { useOperationsStore } from '@/state/operationsStore';

/**
 * The tile the operator selected, addressed the way the grid addresses it.
 *
 * `edit.selectedElementId` holds a bare tile id, and a tile id is unique only
 * within a screen -- `registry` is the table on four of them -- so every
 * per-tile setting is stored under `screen:tile`. The screen half used to come
 * from `ui.route`, and on three routes the route is not the screen: `/archive`
 * draws the `files` screen, `/objects/:id` the `objects` one and `/cases/:id`
 * the `cases` one. A caption or an animation written there landed under
 * `archive:registry` while `TileGrid` read `files:registry`, so the setting
 * saved, showed in the catalogue and changed nothing on the screen.
 *
 * The screen therefore comes from the tile registry, which is the one table
 * built by the component that later reads the setting: `TileGrid` publishes
 * `screen:tile` from the same `screen` prop it packs into `tiles.hiddenIds`,
 * `tiles.order`, `tiles.spans`, `tiles.animations` and
 * `localization.elementOverrides`. `TileVisibility` has addressed hidden tiles
 * through that key since it was written, and this puts the other two surfaces
 * on the same footing.
 *
 * Nothing selected, a content field selected (R4 shares the selection and a
 * field is not a tile), or a tile no mounted grid declares all answer `null`.
 * The last is the case worth naming: a selection outlives a navigation, and a
 * tile that is on no screen has no address a grid would read -- offering to
 * rename it under the current route is exactly the defect above.
 */
export interface SelectedTile {
  readonly screen: string;
  readonly id: string;
}

export function useSelectedTile(): SelectedTile | null {
  const selectedElement = useOperationsStore((state) => state.edit.selectedElementId);
  const tiles = useScreenTiles();
  if (selectedElement === '' || parseContentElementId(selectedElement) !== undefined) return null;
  const registered = tiles.find((tile) => tile.id === selectedElement);
  return registered === undefined ? null : { screen: registered.screen, id: registered.id };
}
