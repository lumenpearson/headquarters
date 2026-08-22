'use client';

import {
  resolveGridLayout,
  type PlacedTile,
  type TileDescriptor,
  type TilePresentation,
} from '@gremuchaya/layout-engine';
import { TerminalButton } from '@gremuchaya/ui/primitives';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useOperationsStore } from '@/state/operationsStore';

/**
 * The structural floor of a panel, measured rather than chosen: a 42px header
 * plus 24px of body padding. A tile that tall shows its title and nothing
 * else, so a row is allowed to be half of what a tile needs, not the minimum
 * a tile can survive -- doubled, a tile carries at least as much content as
 * chrome.
 *
 * Unlike the `calc(100dvh - 244px)` this feature removed (C26), the number
 * does not stand in for anything that changes with the window: it is the
 * height of a header and two paddings, and those are the same everywhere.
 */
const minimumTileHeightPx = 132;

export interface ScreenTile {
  readonly descriptor: TileDescriptor;
  /** Shown in the relocation notice, so the operator can name what moved. */
  readonly title: string;
  readonly render: (presentation: TilePresentation) => ReactNode;
}

/**
 * Lays a screen out by asking `@gremuchaya/layout-engine` where the tiles go,
 * rather than by a hand-placed CSS grid.
 *
 * The difference that matters is not the placement: it is that a tile which
 * cannot fit has somewhere declared to go. A hand-placed grid has only one
 * answer to a window too small for it -- draw everything anyway and let the
 * page grow -- which is what R26 forbids and what this application did until
 * the workspace was bounded.
 */
export function TileGrid({
  tiles,
  columns,
  className,
}: {
  readonly tiles: readonly ScreenTile[];
  readonly columns: number;
  readonly className: string;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  const hiddenIds = useOperationsStore((state) =>
    hiddenTileIds(state.personalization.draft.values['tiles.hiddenIds']),
  );

  /*
   * The grid is measured, not derived from `100dvh`. The shell chrome around
   * it is `clamp()`-sized, so the only honest source for how much room a
   * screen has is the box the screen was actually given.
   */
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setAvailableHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visible = useMemo(
    () => tiles.filter((tile) => !hiddenIds.includes(tile.descriptor.id)),
    [hiddenIds, tiles],
  );

  const layout = useMemo(() => {
    const maximumRows = Math.max(1, Math.floor(availableHeight / minimumTileHeightPx));
    return resolveGridLayout({
      columns,
      maximumRows,
      tiles: visible.map((tile) => tile.descriptor),
    });
  }, [availableHeight, columns, visible]);

  const byId = useMemo(() => new Map(visible.map((tile) => [tile.descriptor.id, tile])), [visible]);
  const displaced = [
    ...layout.relocated.map((entry) => ({ id: entry.id, route: entry.route })),
    ...layout.hidden.map((entry) => ({ id: entry.id, route: undefined })),
  ];

  return (
    <>
      <div
        ref={containerRef}
        className={`tile-grid ${className}`}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.max(1, layout.usedRows)}, minmax(0, 1fr))`,
        }}
      >
        {/*
          Before the first measurement the resolver has one row to work with
          and would relocate almost everything. Rendering nothing for that one
          frame is quieter than rendering a layout that is about to be
          replaced.
        */}
        {availableHeight === 0 ? null : layout.placed.map((placed) => renderPlaced(placed, byId))}
      </div>
      {displaced.length === 0 ? null : (
        <footer className="tile-grid__displaced">
          <span>НЕ ПОМЕСТИЛОСЬ В ОКНО</span>
          {displaced.map((entry) => {
            const tile = byId.get(entry.id);
            if (tile === undefined) return null;
            return entry.route === undefined ? (
              <b key={entry.id} title="Для этой плитки нет отдельного экрана">
                {tile.title}
              </b>
            ) : (
              <TerminalButton key={entry.id} onClick={() => router.push(entry.route)}>
                {tile.title}
              </TerminalButton>
            );
          })}
        </footer>
      )}
    </>
  );
}

function renderPlaced(placed: PlacedTile, byId: ReadonlyMap<string, ScreenTile>): ReactNode {
  const tile = byId.get(placed.id);
  if (tile === undefined) return null;
  return (
    <div
      key={placed.id}
      className="tile-grid__cell"
      data-tile={placed.id}
      data-presentation={placed.presentation}
      style={{
        gridColumn: `${placed.x + 1} / span ${placed.columns}`,
        gridRow: `${placed.y + 1} / span ${placed.rows}`,
      }}
    >
      {tile.render(placed.presentation)}
    </div>
  );
}

/**
 * `tiles.hiddenIds` is schema-bound to a string list, but the draft holds
 * whatever was last read from storage, so the shape is checked here rather
 * than assumed. Same treatment the shell gives every other setting it reads.
 */
function hiddenTileIds(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
