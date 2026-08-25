import { tileCategories, type TileCategory } from '@gremuchaya/settings-schema';

/**
 * How one tile enters the layout.
 *
 * R19 asks for animation settings per tile, per category and for the
 * application as a whole. The application-wide half is `animations.tileEnter`
 * and `animations.easing`; this is the other two, and it is the first thing
 * `edit.selectedElementId` has ever been for. That field got its first caller
 * in F5 — pressing a tile selects it — and selection has drawn nothing but an
 * outline ever since.
 */
export const tileMotions = ['inherit', 'none', 'fade', 'rise', 'scan'] as const;

export type TileMotion = (typeof tileMotions)[number];

/** What a tile is given when nothing names it. */
export const defaultTileMotion: Exclude<TileMotion, 'inherit'> = 'fade';

const tileEntry = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)=([a-z]+)$/;
const categoryEntry = /^([a-z][a-z0-9-]*)=([a-z]+)$/;

export function isTileMotion(value: string): value is TileMotion {
  return (tileMotions as readonly string[]).includes(value);
}

/**
 * Reads `screen:tile=motion` entries.
 *
 * The shape follows `tiles.spans` deliberately: a tile identifier is unique
 * only within a screen — `registry` is the table on four of them — so anything
 * addressed per tile has to carry the screen with it. Spans learned that the
 * hard way, and repeating the shape is what keeps the next per-tile setting
 * from repeating the mistake.
 */
export function readTileMotions(
  entries: readonly string[],
): ReadonlyMap<string, Exclude<TileMotion, 'inherit'>> {
  const motions = new Map<string, Exclude<TileMotion, 'inherit'>>();
  for (const entry of entries) {
    const match = tileEntry.exec(entry);
    if (match === null) continue;
    const [, screen, tile, motion] = match;
    if (screen === undefined || tile === undefined || motion === undefined) continue;
    if (!isTileMotion(motion) || motion === 'inherit') continue;
    motions.set(`${screen}:${tile}`, motion);
  }
  return motions;
}

export function readCategoryMotions(
  entries: readonly string[],
): ReadonlyMap<TileCategory, Exclude<TileMotion, 'inherit'>> {
  const motions = new Map<TileCategory, Exclude<TileMotion, 'inherit'>>();
  for (const entry of entries) {
    const match = categoryEntry.exec(entry);
    if (match === null) continue;
    const [, category, motion] = match;
    if (category === undefined || motion === undefined) continue;
    if (!(tileCategories as readonly string[]).includes(category)) continue;
    if (!isTileMotion(motion) || motion === 'inherit') continue;
    motions.set(category as TileCategory, motion);
  }
  return motions;
}

export interface TileMotionQuery {
  readonly screen: string;
  readonly tile: string;
  readonly category: TileCategory;
  readonly tileEntries: readonly string[];
  readonly categoryEntries: readonly string[];
  /** `animations.tileEnter`: the application-wide switch R19 already had. */
  readonly enteringAllowed: boolean;
}

/**
 * The motion a tile actually gets.
 *
 * Precedence is tile, then category, then the application. The narrower setting
 * wins because that is the only order in which the two are worth having: a
 * category rule an operator cannot override for one tile is a rule they would
 * have to abandon for the whole group.
 *
 * The application-wide switch is a floor, not another tier — with entering
 * animation off nothing moves, whatever a tile names. An operator who has
 * turned motion off has said something about the room they are in, and a
 * per-tile preference is not an argument against it.
 */
export function resolveTileMotion(query: TileMotionQuery): Exclude<TileMotion, 'inherit'> {
  if (!query.enteringAllowed) return 'none';
  const perTile = readTileMotions(query.tileEntries).get(`${query.screen}:${query.tile}`);
  if (perTile !== undefined) return perTile;
  const perCategory = readCategoryMotions(query.categoryEntries).get(query.category);
  if (perCategory !== undefined) return perCategory;
  return defaultTileMotion;
}

/** Rewrites the entry list for one tile, dropping it when it returns to `inherit`. */
export function withTileMotion(
  entries: readonly string[],
  screen: string,
  tile: string,
  motion: TileMotion,
): readonly string[] {
  const prefix = `${screen}:${tile}=`;
  const rest = entries.filter((entry) => !entry.startsWith(prefix));
  return motion === 'inherit' ? rest : [...rest, `${prefix}${motion}`].sort();
}

export function withCategoryMotion(
  entries: readonly string[],
  category: TileCategory,
  motion: TileMotion,
): readonly string[] {
  const prefix = `${category}=`;
  const rest = entries.filter((entry) => !entry.startsWith(prefix));
  return motion === 'inherit' ? rest : [...rest, `${prefix}${motion}`].sort();
}
