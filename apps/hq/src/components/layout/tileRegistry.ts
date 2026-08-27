'use client';

import type { TileCategory } from '@gremuchaya/settings-schema';
import { useSyncExternalStore } from 'react';

/**
 * What the screen on show declares, so a surface can offer to switch a tile
 * off by name instead of asking the operator to type an identifier.
 *
 * One table for the document, in the idiom `KeybindRuntime` already uses for
 * claimed commands: the application is a single client runtime, and only one
 * screen is mounted at a time.
 */
export interface RegisteredTile {
  /** `screen:tile`, the address every per-tile setting is stored under. */
  readonly key: string;
  readonly id: string;
  /**
   * The screen the mounted grid placed this tile on, which is not always the
   * route in `ui.route`: `/archive` draws the `files` screen, `/objects/:id`
   * the `objects` one and `/cases/:id` the `cases` one. A surface that
   * re-qualified a bare tile id with the route wrote per-tile settings under
   * an address no grid reads -- measured on all three.
   */
  readonly screen: string;
  readonly title: string;
  readonly category: TileCategory;
}

let current: readonly RegisteredTile[] = [];
const listeners = new Set<() => void>();

/**
 * Replaces the snapshot only when the declaration actually differs.
 *
 * `TileGrid` publishes on every render that changes its tiles, and
 * `useSyncExternalStore` compares snapshots by identity: handing it a fresh
 * array each time would loop.
 */
export function publishScreenTiles(tiles: readonly RegisteredTile[]): void {
  const changed =
    tiles.length !== current.length ||
    tiles.some((tile, index) => tile.key !== current[index]?.key);
  if (!changed) return;
  current = tiles;
  for (const listener of listeners) listener();
}

export function subscribeScreenTiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function screenTilesSnapshot(): readonly RegisteredTile[] {
  return current;
}

/** Empty on the server: nothing has declared a tile before the first render. */
const serverSnapshot: readonly RegisteredTile[] = [];

export function useScreenTiles(): readonly RegisteredTile[] {
  return useSyncExternalStore(subscribeScreenTiles, screenTilesSnapshot, () => serverSnapshot);
}
