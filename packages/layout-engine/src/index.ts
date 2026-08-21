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
  readonly maximum?: Partial<TileSize>;
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
 * input order, prefer their richest fitting variant, then are compacted and
 * stretched into horizontal gaps. A tile that cannot fit never forces a page
 * scroll: it is relocated to a route or explicitly hidden by its descriptor.
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
  return {
    placed: placed.map(toPlacedTile),
    relocated,
    hidden,
    usedRows: placed.reduce((maximum, tile) => Math.max(maximum, tile.y + tile.rows), 0),
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
