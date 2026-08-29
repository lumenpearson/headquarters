import { tileCategories, type TileCategory } from '@gremuchaya/settings-schema';
import type { TilePresentation } from '@gremuchaya/layout-engine';

/**
 * How rich one tile may be drawn, an operator's own ceiling on it.
 *
 * `tiles.presentation` was the only lever: one cap for the whole application,
 * read by `TileGrid` and by the `data-tile-presentation` attribute the
 * stylesheet keys off at `minimal`. The plan recorded the gap after F5 closed
 * without it -- "a global ceiling, not a setting of one tile's own view" -- and
 * named the remedy: a per-tile override resolved tile, then category, then the
 * application default, in the shape `tileMotion.ts` already carries for R19.
 *
 * `auto` has no spelling at the tile or category tier, the way `inherit` has
 * none for a tile motion -- the entry is simply absent, and absence is what
 * falls through to the next tier.
 */
export const tilePresentationLevels = ['full', 'compact', 'minimal'] as const;

export type TilePresentationLevel = (typeof tilePresentationLevels)[number];

export function isTilePresentationLevel(value: string): value is TilePresentationLevel {
  return (tilePresentationLevels as readonly string[]).includes(value);
}

const tileEntry = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)=([a-z]+)$/;
const categoryEntry = /^([a-z][a-z0-9-]*)=([a-z]+)$/;

/**
 * Reads `screen:tile=full|compact|minimal` entries.
 *
 * The shape follows `tiles.spans` and `tiles.animations` deliberately: a tile
 * identifier is unique only within a screen -- `registry` is the table on four
 * of them -- so anything addressed per tile has to carry the screen with it.
 */
export function readTilePresentations(
  entries: readonly string[],
): ReadonlyMap<string, TilePresentationLevel> {
  const levels = new Map<string, TilePresentationLevel>();
  for (const entry of entries) {
    const match = tileEntry.exec(entry);
    if (match === null) continue;
    const [, screen, tile, level] = match;
    if (screen === undefined || tile === undefined || level === undefined) continue;
    if (!isTilePresentationLevel(level)) continue;
    levels.set(`${screen}:${tile}`, level);
  }
  return levels;
}

export function readCategoryPresentations(
  entries: readonly string[],
): ReadonlyMap<TileCategory, TilePresentationLevel> {
  const levels = new Map<TileCategory, TilePresentationLevel>();
  for (const entry of entries) {
    const match = categoryEntry.exec(entry);
    if (match === null) continue;
    const [, category, level] = match;
    if (category === undefined || level === undefined) continue;
    if (!(tileCategories as readonly string[]).includes(category)) continue;
    if (!isTilePresentationLevel(level)) continue;
    levels.set(category as TileCategory, level);
  }
  return levels;
}

export interface TilePresentationQuery {
  readonly screen: string;
  readonly tile: string;
  readonly category: TileCategory;
  readonly tileEntries: readonly string[];
  readonly categoryEntries: readonly string[];
  /** `tiles.presentation`, resolved to a cap or to `null` for `auto`. */
  readonly applicationCap: TilePresentation | null;
}

/**
 * The presentation cap one tile actually gets.
 *
 * Precedence is tile, then category, then the application -- the same order
 * `resolveTileMotion` uses and for the same reason: a category rule an
 * operator cannot override for one tile is a rule they would have to abandon
 * for the whole group.
 */
export function resolveTilePresentationCap(query: TilePresentationQuery): TilePresentation | null {
  const perTile = readTilePresentations(query.tileEntries).get(`${query.screen}:${query.tile}`);
  if (perTile !== undefined) return perTile;
  const perCategory = readCategoryPresentations(query.categoryEntries).get(query.category);
  if (perCategory !== undefined) return perCategory;
  return query.applicationCap;
}

/** Rewrites the entry list for one tile, dropping it when it returns to `auto`. */
export function withTilePresentation(
  entries: readonly string[],
  screen: string,
  tile: string,
  level: TilePresentationLevel | 'auto',
): readonly string[] {
  const prefix = `${screen}:${tile}=`;
  const rest = entries.filter((entry) => !entry.startsWith(prefix));
  return level === 'auto' ? rest : [...rest, `${prefix}${level}`].sort();
}

export function withCategoryPresentation(
  entries: readonly string[],
  category: TileCategory,
  level: TilePresentationLevel | 'auto',
): readonly string[] {
  const prefix = `${category}=`;
  const rest = entries.filter((entry) => !entry.startsWith(prefix));
  return level === 'auto' ? rest : [...rest, `${prefix}${level}`].sort();
}
