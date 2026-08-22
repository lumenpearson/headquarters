export type TilePresentation = 'full' | 'compact' | 'minimal';

export interface TileSize {
  readonly columns: number;
  readonly rows: number;
}

export interface TileVariant extends TileSize {
  readonly presentation: TilePresentation;
}

export interface TileDescriptor {
  readonly id: string;
  readonly priority: number;
  /** Variants are evaluated from richest to most compact presentation. */
  readonly variants: readonly TileVariant[];
  /**
   * The size past which this tile must not be grown. It is the only way a
   * tile refuses to be resized: the gap-closing pass will grow any neighbour
   * rather than leave a cell empty, and honours this cap when it does.
   */
  readonly maximum?: Partial<TileSize>;
  /** Prefer this tile when there is room to spare in that direction. */
  readonly canStretchHorizontally?: boolean;
  readonly canStretchVertically?: boolean;
  readonly relocationRoute?: string;
  readonly hideWhenOverflow?: boolean;
}

export interface GridLayoutRequest {
  readonly columns: number;
  readonly maximumRows: number;
  readonly tiles: readonly TileDescriptor[];
}

export interface PlacedTile extends TileSize {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly presentation: TilePresentation;
}

export interface RelocatedTile {
  readonly id: string;
  readonly route: string;
}

export interface HiddenTile {
  readonly id: string;
  readonly reason: 'overflow';
}

export interface GridLayoutResult {
  readonly placed: readonly PlacedTile[];
  readonly relocated: readonly RelocatedTile[];
  readonly hidden: readonly HiddenTile[];
  readonly usedRows: number;
}

/**
 * Produces a stable, viewport-bounded grid. Tiles are ordered by priority and
 * input order, prefer their richest fitting variant, then are compacted,
 * stretched in the directions they asked for, and finally grown into whatever
 * cells are still empty. A tile that cannot fit never forces a page scroll: it
 * is relocated to a route or explicitly hidden by its descriptor.
 *
 * The grid it returns has no empty cell unless every tile touching that cell
 * has reached its declared `maximum`.
 */
export function resolveGridLayout(request: GridLayoutRequest): GridLayoutResult {
  validateRequest(request);
  const placed: MutablePlacedTile[] = [];
  const relocated: RelocatedTile[] = [];
  const hidden: HiddenTile[] = [];
  const ordered = request.tiles
    .map((tile, index) => ({ tile, index }))
    .sort((left, right) => right.tile.priority - left.tile.priority || left.index - right.index);

  for (const { tile } of ordered) {
    const candidate = findPlacement(tile, placed, request.columns, request.maximumRows);
    if (candidate !== undefined) {
      placed.push(candidate);
      continue;
    }
    if (tile.relocationRoute !== undefined) {
      relocated.push({ id: tile.id, route: tile.relocationRoute });
      continue;
    }
    if (tile.hideWhenOverflow === true) {
      hidden.push({ id: tile.id, reason: 'overflow' });
      continue;
    }
    throw new LayoutOverflowError(tile.id, request.columns, request.maximumRows);
  }

  compactTiles(placed, request.columns, request.maximumRows);
  stretchTiles(placed, request.tiles, request.columns, request.maximumRows);
  const usedRows = placed.reduce((maximum, tile) => Math.max(maximum, tile.y + tile.rows), 0);
  // Bounded by the rows actually in use rather than by the rows on offer: a
  // trailing empty row is not a gap to close, it is a grid that is shorter.
  closeGaps(placed, request.tiles, request.columns, usedRows);
  return {
    placed: placed.map(toPlacedTile),
    relocated,
    hidden,
    usedRows,
  };
}

export class LayoutOverflowError extends Error {
  constructor(tileId: string, columns: number, maximumRows: number) {
    super(
      `Tile ${tileId} cannot fit in ${columns}x${maximumRows} grid and has no overflow policy.`,
    );
    this.name = 'LayoutOverflowError';
  }
}

interface MutablePlacedTile {
  readonly id: string;
  readonly presentation: TilePresentation;
  columns: number;
  rows: number;
  x: number;
  y: number;
}

function validateRequest(request: GridLayoutRequest): void {
  if (!Number.isInteger(request.columns) || request.columns < 1) {
    throw new Error('Grid columns must be a positive integer.');
  }
  if (!Number.isInteger(request.maximumRows) || request.maximumRows < 1) {
    throw new Error('Grid maximumRows must be a positive integer.');
  }
  const ids = new Set<string>();
  for (const tile of request.tiles) {
    if (tile.id.trim().length === 0 || ids.has(tile.id)) {
      throw new Error(`Tile IDs must be unique and non-empty: ${tile.id}`);
    }
    ids.add(tile.id);
    if (!Number.isFinite(tile.priority))
      throw new Error(`Tile ${tile.id} priority must be finite.`);
    if (tile.variants.length === 0)
      throw new Error(`Tile ${tile.id} must provide at least one variant.`);
    let previousArea = Number.POSITIVE_INFINITY;
    for (const variant of tile.variants) {
      validateSize(tile.id, variant);
      const area = variant.columns * variant.rows;
      if (area > previousArea) {
        throw new Error(`Tile ${tile.id} variants must be ordered from richest to most compact.`);
      }
      previousArea = area;
    }
    if (tile.maximum !== undefined) {
      if (
        tile.maximum.columns !== undefined &&
        (!Number.isInteger(tile.maximum.columns) || tile.maximum.columns < 1)
      ) {
        throw new Error(`Tile ${tile.id} maximum columns must be a positive integer.`);
      }
      if (
        tile.maximum.rows !== undefined &&
        (!Number.isInteger(tile.maximum.rows) || tile.maximum.rows < 1)
      ) {
        throw new Error(`Tile ${tile.id} maximum rows must be a positive integer.`);
      }
    }
  }
}

function validateSize(tileId: string, size: TileSize): void {
  if (
    !Number.isInteger(size.columns) ||
    size.columns < 1 ||
    !Number.isInteger(size.rows) ||
    size.rows < 1
  ) {
    throw new Error(`Tile ${tileId} variant dimensions must be positive integers.`);
  }
}

function findPlacement(
  tile: TileDescriptor,
  placed: readonly MutablePlacedTile[],
  columns: number,
  maximumRows: number,
): MutablePlacedTile | undefined {
  for (const variant of tile.variants) {
    if (variant.columns > columns || variant.rows > maximumRows) continue;
    for (let y = 0; y <= maximumRows - variant.rows; y += 1) {
      for (let x = 0; x <= columns - variant.columns; x += 1) {
        const candidate: MutablePlacedTile = { id: tile.id, ...variant, x, y };
        if (!overlapsAny(candidate, placed)) return candidate;
      }
    }
  }
  return undefined;
}

function compactTiles(placed: MutablePlacedTile[], columns: number, maximumRows: number): void {
  for (const tile of placed) {
    while (tile.y > 0 && fits({ ...tile, y: tile.y - 1 }, placed, columns, maximumRows))
      tile.y -= 1;
    while (tile.x > 0 && fits({ ...tile, x: tile.x - 1 }, placed, columns, maximumRows))
      tile.x -= 1;
  }
}

function stretchTiles(
  placed: MutablePlacedTile[],
  descriptors: readonly TileDescriptor[],
  columns: number,
  maximumRows: number,
): void {
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  let didStretch = true;
  while (didStretch) {
    didStretch = false;
    for (const tile of placed) {
      const descriptor = descriptorById.get(tile.id);
      if (descriptor?.canStretchHorizontally === true) {
        const maximumColumns = descriptor.maximum?.columns ?? columns;
        if (
          tile.columns < maximumColumns &&
          fits({ ...tile, columns: tile.columns + 1 }, placed, columns, maximumRows)
        ) {
          tile.columns += 1;
          didStretch = true;
          continue;
        }
      }
      if (descriptor?.canStretchVertically === true) {
        const maximumRowsForTile = descriptor.maximum?.rows ?? maximumRows;
        if (
          tile.rows < maximumRowsForTile &&
          fits({ ...tile, rows: tile.rows + 1 }, placed, columns, maximumRows)
        ) {
          tile.rows += 1;
          didStretch = true;
        }
      }
    }
  }
}

type GrowthDirection = 'right' | 'down' | 'left' | 'up';

/**
 * Grows placed tiles into any cell left empty, so a bounded screen never shows
 * a hole where a panel could have been.
 *
 * `stretchTiles` only grows a tile right or down, and only if the tile asked
 * to be stretched. That leaves a cell empty whenever the only tile touching it
 * sits below or to its right, or never opted in -- which is a gap the operator
 * sees. This pass grows in all four directions and asks every neighbour,
 * preferring the ones that opted in, and stops at a tile's declared `maximum`.
 */
function closeGaps(
  placed: MutablePlacedTile[],
  descriptors: readonly TileDescriptor[],
  columns: number,
  rows: number,
): void {
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  let closedOne = true;
  while (closedOne) {
    closedOne = false;
    for (const cell of emptyCells(placed, columns, rows)) {
      const growth = findGrowth(cell, placed, descriptorById, columns, rows);
      if (growth === undefined) continue;
      grow(growth.tile, growth.direction);
      closedOne = true;
      break;
    }
  }
}

function emptyCells(
  placed: readonly MutablePlacedTile[],
  columns: number,
  rows: number,
): readonly { readonly x: number; readonly y: number }[] {
  const occupied = new Set<string>();
  for (const tile of placed) {
    for (let y = tile.y; y < tile.y + tile.rows; y += 1) {
      for (let x = tile.x; x < tile.x + tile.columns; x += 1) occupied.add(`${x}:${y}`);
    }
  }
  const empty: { x: number; y: number }[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) if (!occupied.has(`${x}:${y}`)) empty.push({ x, y });
  }
  return empty;
}

function findGrowth(
  cell: { readonly x: number; readonly y: number },
  placed: readonly MutablePlacedTile[],
  descriptorById: ReadonlyMap<string, TileDescriptor>,
  columns: number,
  rows: number,
): { readonly tile: MutablePlacedTile; readonly direction: GrowthDirection } | undefined {
  const candidates: { tile: MutablePlacedTile; direction: GrowthDirection; preferred: boolean }[] =
    [];
  for (const tile of placed) {
    const descriptor = descriptorById.get(tile.id);
    for (const direction of ['right', 'down', 'left', 'up'] as const) {
      if (!canGrow(tile, direction, cell, placed, descriptor, columns, rows)) continue;
      const horizontal = direction === 'right' || direction === 'left';
      candidates.push({
        tile,
        direction,
        preferred:
          (horizontal ? descriptor?.canStretchHorizontally : descriptor?.canStretchVertically) ===
          true,
      });
    }
  }
  // A tile that asked to be stretched is grown before one that only tolerates
  // it, so an opt-in still decides the shape wherever it can.
  return candidates.find((candidate) => candidate.preferred) ?? candidates[0];
}

function canGrow(
  tile: MutablePlacedTile,
  direction: GrowthDirection,
  cell: { readonly x: number; readonly y: number },
  placed: readonly MutablePlacedTile[],
  descriptor: TileDescriptor | undefined,
  columns: number,
  rows: number,
): boolean {
  const grown = growth(tile, direction);
  const horizontal = direction === 'right' || direction === 'left';
  const cap = horizontal ? descriptor?.maximum?.columns : descriptor?.maximum?.rows;
  if (cap !== undefined && (horizontal ? grown.columns : grown.rows) > cap) return false;
  if (!fits(grown, placed, columns, rows)) return false;
  return (
    cell.x >= grown.x &&
    cell.x < grown.x + grown.columns &&
    cell.y >= grown.y &&
    cell.y < grown.y + grown.rows
  );
}

function growth(tile: MutablePlacedTile, direction: GrowthDirection): MutablePlacedTile {
  switch (direction) {
    case 'right':
      return { ...tile, columns: tile.columns + 1 };
    case 'down':
      return { ...tile, rows: tile.rows + 1 };
    case 'left':
      return { ...tile, x: tile.x - 1, columns: tile.columns + 1 };
    case 'up':
      return { ...tile, y: tile.y - 1, rows: tile.rows + 1 };
  }
}

function grow(tile: MutablePlacedTile, direction: GrowthDirection): void {
  const grown = growth(tile, direction);
  tile.x = grown.x;
  tile.y = grown.y;
  tile.columns = grown.columns;
  tile.rows = grown.rows;
}

function fits(
  candidate: MutablePlacedTile,
  placed: readonly MutablePlacedTile[],
  columns: number,
  maximumRows: number,
): boolean {
  return (
    candidate.x >= 0 &&
    candidate.y >= 0 &&
    candidate.x + candidate.columns <= columns &&
    candidate.y + candidate.rows <= maximumRows &&
    !overlapsAny(candidate, placed)
  );
}

function overlapsAny(candidate: MutablePlacedTile, placed: readonly MutablePlacedTile[]): boolean {
  return placed.some(
    (other) =>
      other.id !== candidate.id &&
      candidate.x < other.x + other.columns &&
      candidate.x + candidate.columns > other.x &&
      candidate.y < other.y + other.rows &&
      candidate.y + candidate.rows > other.y,
  );
}

function toPlacedTile(tile: MutablePlacedTile): PlacedTile {
  return {
    id: tile.id,
    x: tile.x,
    y: tile.y,
    columns: tile.columns,
    rows: tile.rows,
    presentation: tile.presentation,
  };
}
