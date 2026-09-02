'use client';

import {
  resolveGridLayout,
  type TileDescriptor,
  type TilePresentation,
  type TileVariant,
} from '@gremuchaya/layout-engine';
import { TerminalButton } from '@gremuchaya/ui/primitives';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { getSettingDefinition, type TileCategory } from '@gremuchaya/settings-schema';

import {
  elementCaption,
  elementTranslationsSetting,
} from '@/application/localization/elementTranslations';
import { useAppLocale } from '@/application/localization/locale';
import { resolveTileMotion } from '@/application/personalization/tileMotion';
import { resolveTilePresentationCap } from '@/application/personalization/tilePresentation';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

import { TileCaptionProvider } from './tileCaption';
import { publishScreenTiles } from './tileRegistry';

/**
 * A tile shows its title and nothing else at the structural floor of a panel,
 * so a row is allowed to be half of what a tile needs, not the minimum a tile
 * can survive -- doubled, a tile carries at least as much content as chrome.
 *
 * The floor itself is no longer a number here. It was 132px, written as a 42px
 * header plus 24px of body padding on the grounds that "those are the same
 * everywhere", and that stopped being true on 2026-08-27, when
 * `sizes.panelHeader` (24..48), `sizes.panelPadding` (2..20) and
 * `sizes.borderWidth` (1..3) reached the document: the same three roles make a
 * floor of anywhere between 30 and 94px. They already differed by window
 * before that -- `operations.css` writes a 54px header and 16px of padding
 * above 2500px -- so at 2560x1440 the constant was counting 66px of chrome
 * against the 88px the operator was looking at.
 *
 * What replaces it is a measurement of `.tile-grid__floor`, an empty panel the
 * grid draws out of flow. One place decides what a panel's chrome is, and it
 * is the stylesheet that draws the panel.
 */
const panelFloorsPerRow = 2;

/**
 * How far the pointer travels before a press on a tile becomes a drag. Below
 * it the gesture is still a click, so selecting a tile in edit mode and
 * starting to move one are the same press and diverge on intent.
 */
const dragThresholdPx = 6;

/**
 * The schema's own default for `layout.tileMinimumWidth`, read once at module
 * scope rather than repeated as a literal here: the schema already states
 * what an unset draft falls back to, and a second copy of it is a second
 * thing to keep in step (the same reasoning `resolvePresentation` gives its
 * own fallback).
 */
const tileMinimumWidthDefault = getSettingDefinition('layout.tileMinimumWidth')?.defaultValue;

export interface ScreenTile {
  readonly descriptor: TileDescriptor;
  /** Shown in the relocation notice, so the operator can name what moved. */
  readonly title: string;
  /**
   * The group this tile belongs to, so an operator can switch off a kind of
   * panel across the application instead of naming each one on each screen.
   */
  readonly category: TileCategory;
  readonly render: (presentation: TilePresentation) => ReactNode;
}

/** Richest first, which is the order the resolver evaluates variants in. */
const presentationRank: Readonly<Record<TilePresentation, number>> = {
  full: 3,
  compact: 2,
  minimal: 1,
};

/**
 * Everything the row budget is counted from, measured on the document in one
 * pass: the box the screen was given, the chrome of one panel, and the gap the
 * stylesheet resolved between two rows.
 *
 * `width` rides along in the same measurement for `resolveGridLayout`'s
 * `containerWidth`, rather than a second observer: the resolver needs to know
 * how wide one column actually renders to enforce `layout.tileMinimumWidth`,
 * and this box is already the one honest source for the room the screen was
 * given.
 */
interface GridBox {
  readonly height: number;
  readonly width: number;
  readonly floor: number;
  readonly gap: number;
}

/** Before the first pass, and wherever there is no layout to measure. */
const unmeasured: GridBox = { height: 0, width: 0, floor: 0, gap: 0 };

function sameBox(left: GridBox, right: GridBox): boolean {
  return (
    left.height === right.height &&
    left.width === right.width &&
    left.floor === right.floor &&
    left.gap === right.gap
  );
}

/**
 * How many rows the resolver may use.
 *
 * `n` rows of `h` with `n - 1` gaps between them fit a box of `A` while
 * `n * h + (n - 1) * gap <= A`, which is `n <= (A + gap) / (h + gap)`. The gap
 * used to be left out, and `sizes.tileGap` has had a real nonzero default
 * since 2026-08-27, so on a tall window the budget claimed a row the screen
 * could not draw.
 */
function rowBudget(box: GridBox): number {
  if (box.floor === 0) return 1;
  const row = box.floor * panelFloorsPerRow;
  return Math.max(1, Math.floor((box.height + box.gap) / (row + box.gap)));
}

type ResizeAxis = 'horizontal' | 'vertical' | 'corner';

interface DragState {
  readonly id: string;
  readonly kind: 'move' | ResizeAxis;
  readonly originX: number;
  readonly originY: number;
  readonly startColumns: number;
  readonly startRows: number;
  readonly moved: boolean;
  readonly overId: string | null;
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
 *
 * In edit mode the arrangement is the operator's. Both gestures write through
 * `applySettingsPatch` into the same schema-bound draft as every other
 * setting, so a rearranged screen carries undo, history and the issue draft
 * without a second store to keep in step.
 */
export function TileGrid({
  tiles,
  columns,
  className,
  screen,
}: {
  readonly tiles: readonly ScreenTile[];
  readonly columns: number;
  readonly className: string;
  /**
   * Names the screen these tiles belong to.
   *
   * The arrangement settings are one list for the whole application, and tile
   * ids are only unique within a screen: `registry` is the table on four of
   * them. Without this, resizing the case registry also resized the object,
   * report and file registries -- measured, all four moved together.
   */
  readonly screen: string;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const floorRef = useRef<HTMLElement>(null);
  const [box, setBox] = useState<GridBox>(unmeasured);
  const [drag, setDrag] = useState<DragState | null>(null);
  const editing = useOperationsStore((state) => state.edit.active);
  const selectedId = useOperationsStore((state) => state.edit.selectedElementId);
  const hiddenIds = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.hiddenIds']),
  );
  const order = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.order']),
  );
  const spans = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.spans']),
  );
  const hiddenCategories = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.hiddenCategories']),
  );
  const tileMotionEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.animations']),
  );
  const categoryMotionEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.categoryAnimations']),
  );
  /*
   * R28's read path, subscribed once for the whole screen.
   *
   * The captions and the locale are held here rather than in the panel for the
   * same reason the spans and the motions are: a screen draws a dozen panels,
   * and a setting read inside each of them is a dozen subscriptions to the same
   * value. What a panel is handed is the address (`./tileCaption`); the resolver
   * itself is pure.
   */
  const captionEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values[elementTranslationsSetting]),
  );
  const locale = useAppLocale();
  const enteringAllowed = useOperationsStore(
    (state) => state.personalization.draft.values['animations.tileEnter'] !== false,
  );
  const presentationCap = useOperationsStore((state) => {
    const value = state.personalization.draft.values['tiles.presentation'];
    return value === 'full' || value === 'compact' || value === 'minimal' ? value : null;
  });
  /*
   * The two finer tiers over the application ceiling above, in the shape
   * `tiles.animations`/`tiles.categoryAnimations` already carry: a tile
   * identifier is unique only within a screen, so the per-tile entries name
   * it and the per-category ones do not.
   */
  const presentationTileEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.presentationOverrides']),
  );
  const presentationCategoryEntries = useOperationsStore((state) =>
    stringList(state.personalization.draft.values['tiles.categoryPresentation']),
  );

  /*
   * The gap is read from the stylesheet below, not from here. `--ops-tile-gap`
   * is written only once an operator moves `sizes.tileGap`, so at defaults the
   * number in force is `operations.css`'s own -- but changing a gap resizes no
   * element, so no observer fires and the measurement would stand stale. The
   * value is a signal that it changed; what is used is what the document
   * resolved.
   */
  const gapSetting = useOperationsStore(
    (state) => state.personalization.draft.values['sizes.tileGap'],
  );

  /*
   * `layout.tileMinimumWidth`'s only reader: the value passed to
   * `resolveGridLayout` as `minimumTileWidth`, beside the container width
   * measured below as `containerWidth`. Falls back to the schema's own
   * default rather than a literal here for the reason every other fallback in
   * this file does.
   */
  const tileMinimumWidth = useOperationsStore((state) => {
    const value = state.personalization.draft.values['layout.tileMinimumWidth'];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return typeof tileMinimumWidthDefault === 'number' ? tileMinimumWidthDefault : 160;
  });

  /*
   * The grid is measured, not derived from `100dvh`. The shell chrome around
   * it is `clamp()`-sized, so the only honest source for how much room a
   * screen has is the box the screen was actually given -- and the same is
   * true of the panel chrome inside it, which is why the floor is an empty
   * panel this component draws rather than a number it carries.
   */
  useEffect(() => {
    const element = containerRef.current;
    const floor = floorRef.current;
    if (element === null || floor === null) return;
    const measure = (): void => {
      const gap = Number.parseFloat(window.getComputedStyle(element).rowGap);
      const next: GridBox = {
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        floor: floor.getBoundingClientRect().height,
        gap: Number.isFinite(gap) ? gap : 0,
      };
      setBox((current) => (sameBox(current, next) ? current : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(floor);
    return () => observer.disconnect();
  }, [gapSetting]);

  /*
   * Published before hiding, not after: a surface that offers to bring a tile
   * back has to know about the tiles that are switched off.
   */
  useEffect(() => {
    publishScreenTiles(
      tiles.map((tile) => ({
        key: `${screen}:${tile.descriptor.id}`,
        id: tile.descriptor.id,
        screen,
        title: tile.title,
        category: tile.category,
      })),
    );
  }, [screen, tiles]);

  /*
   * Cleared when the grid leaves, and only then: the effect above republishes
   * on every change of `tiles`, so clearing there would empty the table for a
   * tick on each republication. `EditPanel` lives in the root layout and
   * outlives every screen, so without this the routes that draw no grid --
   * `/video`, `/settings`, `/dev/ui` -- offered the tiles of whichever screen
   * was shown last and wrote `screen:tile` keys for a screen out of view.
   */
  useEffect(() => () => publishScreenTiles([]), []);

  const visible = useMemo(
    () =>
      tiles.filter(
        (tile) =>
          !hiddenIds.includes(`${screen}:${tile.descriptor.id}`) &&
          !hiddenCategories.includes(tile.category),
      ),
    [hiddenCategories, hiddenIds, screen, tiles],
  );

  const arranged = useMemo(
    () =>
      visible.map((tile) => {
        // Per tile, then per category, then the application ceiling read
        // above -- the same precedence `resolveTileMotion` gives R19's
        // per-element animation.
        const cap = resolveTilePresentationCap({
          screen,
          tile: tile.descriptor.id,
          category: tile.category,
          tileEntries: presentationTileEntries,
          categoryEntries: presentationCategoryEntries,
          applicationCap: presentationCap,
        });
        return applyOperatorArrangement(tile.descriptor, screen, order, spans, cap);
      }),
    [
      order,
      presentationCap,
      presentationCategoryEntries,
      presentationTileEntries,
      screen,
      spans,
      visible,
    ],
  );

  const layout = useMemo(
    () =>
      resolveGridLayout({
        columns,
        maximumRows: rowBudget(box),
        tiles: arranged,
        // Omitted before the first measurement, the same gate the JSX below
        // uses to render nothing: a `containerWidth` of `0` would fail every
        // tile against the floor instead of running the resolver exactly as
        // it did before this setting had a reader.
        ...(box.width > 0 ? { containerWidth: box.width, minimumTileWidth: tileMinimumWidth } : {}),
      }),
    [arranged, box, columns, tileMinimumWidth],
  );

  const byId = useMemo(() => new Map(visible.map((tile) => [tile.descriptor.id, tile])), [visible]);
  const placedById = useMemo(
    () => new Map(layout.placed.map((placed) => [placed.id, placed])),
    [layout.placed],
  );
  const displaced = [
    ...layout.relocated.map((entry) => ({ id: entry.id, route: entry.route })),
    ...layout.hidden.map((entry) => ({ id: entry.id, route: undefined })),
  ];

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, kind: DragState['kind']) => {
      if (!editing) return;
      /*
       * A move starts on the panel header and nowhere else.
       *
       * R12 makes text selectable in edit mode, and R7 makes tiles draggable
       * in edit mode; on a press inside the body those are the same gesture,
       * and the `preventDefault` a drag needs is exactly what stops a
       * selection. The header is the grip -- as a window's title bar is --
       * so the body keeps the selection R12 promised. Found by the R12 test
       * failing, not by reasoning about it beforehand.
       */
      if (kind === 'move' && !(event.target as HTMLElement).closest('.ops-panel__header')) return;
      const placed = placedById.get(id);
      if (placed === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      // Capture, as the edit panel's dock drag does: the release lands
      // wherever the pointer ended up, and without capture this handler never
      // runs and the tile stays stuck mid-drag.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({
        id,
        kind,
        originX: event.clientX,
        originY: event.clientY,
        startColumns: placed.columns,
        startRows: placed.rows,
        moved: false,
        overId: null,
      });
    },
    [editing, placedById],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (drag === null) return;
      const travelled =
        Math.abs(event.clientX - drag.originX) + Math.abs(event.clientY - drag.originY);
      if (!drag.moved && travelled < dragThresholdPx) return;
      if (drag.kind === 'move') {
        setDrag({ ...drag, moved: true, overId: tileUnderPointer(event.clientX, event.clientY) });
        return;
      }
      const cell = cellSize(containerRef.current, columns, Math.max(1, layout.usedRows));
      if (cell === null) return;
      setDrag({ ...drag, moved: true });
      const next = resizedSpan(drag, event, cell, columns, Math.max(1, layout.usedRows));
      operationsStore
        .getState()
        .applySettingsPatch([
          { id: 'tiles.spans', value: withSpan(spans, `${screen}:${drag.id}`, next) },
        ]);
    },
    [columns, drag, layout.usedRows, screen, spans],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (drag === null) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const state = operationsStore.getState();
      if (!drag.moved) {
        // A press that never became a drag selects the tile instead, which is
        // what `edit.selectedElementId` is for.
        state.selectEditElement(state.edit.selectedElementId === drag.id ? '' : drag.id);
      } else if (drag.kind === 'move' && drag.overId !== null && drag.overId !== drag.id) {
        /*
         * Seeded from the ranking in force, not from the order the tiles are
         * written in. Seeding from file order made the first drag re-rank
         * every other tile as a side effect of moving one -- measured, not
         * reasoned about: dragging `brief` one place also moved five tiles
         * nobody touched.
         */
        const ranking = [...arranged]
          .sort((left, right) => right.priority - left.priority)
          .map((tile) => `${screen}:${tile.id}`);
        state.applySettingsPatch([
          {
            id: 'tiles.order',
            value: reordered(
              order.length > 0 ? order : ranking,
              `${screen}:${drag.id}`,
              `${screen}:${drag.overId}`,
            ),
          },
        ]);
      }
      setDrag(null);
    },
    [arranged, drag, order, screen],
  );

  return (
    <>
      <div
        ref={containerRef}
        className={`tile-grid ${className}`}
        data-dragging={drag?.moved === true && drag.kind === 'move' ? 'true' : undefined}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.max(1, layout.usedRows)}, minmax(0, 1fr))`,
        }}
      >
        {/*
          Before the first measurement the resolver has one row to work with
          and would relocate almost everything. Rendering nothing for that one
          frame is quieter than rendering a layout that is about to be
          replaced. Both boxes have to have been measured: jsdom lays nothing
          out and answers zero to each, so a component test draws no grid
          unless it says what the boxes are.
        */}
        {box.height === 0 || box.floor === 0
          ? null
          : layout.placed.map((placed) => {
              const tile = byId.get(placed.id);
              if (tile === undefined) return null;
              return (
                <div
                  key={placed.id}
                  className="tile-grid__cell"
                  data-tile={placed.id}
                  data-presentation={placed.presentation}
                  // R19's per-element half. The narrower setting wins, and the
                  // application-wide switch is a floor rather than a tier: with
                  // entering animation off nothing moves, whatever a tile names.
                  data-tile-motion={resolveTileMotion({
                    screen,
                    tile: placed.id,
                    category: tile.category,
                    tileEntries: tileMotionEntries,
                    categoryEntries: categoryMotionEntries,
                    enteringAllowed,
                  })}
                  data-selected={selectedId === placed.id ? 'true' : undefined}
                  data-drag-source={
                    drag?.moved === true && drag.id === placed.id ? 'true' : undefined
                  }
                  data-drop-target={
                    drag?.moved === true && drag.kind === 'move' && drag.id !== placed.id
                      ? 'true'
                      : undefined
                  }
                  data-drop-active={drag?.overId === placed.id ? 'true' : undefined}
                  style={{
                    gridColumn: `${placed.x + 1} / span ${placed.columns}`,
                    gridRow: `${placed.y + 1} / span ${placed.rows}`,
                  }}
                  onPointerDown={(event) => handlePointerDown(event, placed.id, 'move')}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  <TileCaptionProvider
                    scope={{
                      entries: captionEntries,
                      locale,
                      screen,
                      element: placed.id,
                    }}
                  >
                    {tile.render(placed.presentation)}
                  </TileCaptionProvider>
                  {editing ? (
                    <>
                      {(['horizontal', 'vertical', 'corner'] as const).map((axis) => (
                        <i
                          key={axis}
                          className="editable-tile tile-grid__handle"
                          data-resize={axis}
                          aria-hidden="true"
                          onPointerDown={(event) => handlePointerDown(event, placed.id, axis)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                        />
                      ))}
                    </>
                  ) : null}
                </div>
              );
            })}
        {/*
          The panel whose chrome the row budget is counted in: empty, so its
          height is the floor and nothing else, and last, so the panels the
          screen actually draws come first in document order. It carries the
          real header and body classes but not `ops-panel`, so a surface that
          asks the document for a panel gets one the operator can see.
        */}
        <section ref={floorRef} className="tile-grid__floor" aria-hidden="true">
          <header className="ops-panel__header" />
          <div className="ops-panel__body" />
        </section>
      </div>
      {displaced.length === 0 ? null : (
        <footer className="tile-grid__displaced">
          <span>НЕ ПОМЕСТИЛОСЬ В ОКНО</span>
          {displaced.map((entry) => {
            const tile = byId.get(entry.id);
            if (tile === undefined) return null;
            // The operator's caption here too: this notice names a panel they
            // cannot currently see, and naming it by the title they replaced
            // would be naming a panel they no longer recognise.
            const caption = elementCaption(
              captionEntries,
              { locale, screen, element: entry.id },
              tile.title,
            );
            return entry.route === undefined ? (
              <b key={entry.id} title="Для этой плитки нет отдельного экрана">
                {caption}
              </b>
            ) : (
              <TerminalButton key={entry.id} onClick={() => router.push(entry.route)}>
                {caption}
              </TerminalButton>
            );
          })}
        </footer>
      )}
    </>
  );
}

/**
 * Rewrites a descriptor with whatever the operator arranged.
 *
 * Order is expressed as priority rather than by reordering the input, because
 * priority is what the resolver sorts on; a tile the operator has not touched
 * keeps the priority its screen declared and ranks below the ones they did.
 */
function applyOperatorArrangement(
  descriptor: TileDescriptor,
  screen: string,
  order: readonly string[],
  spans: readonly string[],
  presentationCap: TilePresentation | null,
): TileDescriptor {
  const key = `${screen}:${descriptor.id}`;
  const position = order.indexOf(key);
  const span = readSpan(spans, key);
  const variants = capPresentation(
    span === null ? descriptor.variants : withOperatorVariant(descriptor, span),
    presentationCap,
  );
  return {
    ...descriptor,
    variants,
    ...(position === -1 ? {} : { priority: order.length * 1000 - position * 1000 }),
  };
}

/**
 * Drops the variants richer than the operator allows.
 *
 * The last variant survives whatever the cap: a tile with nothing left to
 * offer cannot be placed at all, and a setting about how much a tile shows is
 * not a setting that removes it.
 */
function capPresentation(
  variants: readonly TileVariant[],
  cap: TilePresentation | null,
): readonly TileVariant[] {
  if (cap === null) return variants;
  const allowed = variants.filter(
    (variant) => presentationRank[variant.presentation] <= presentationRank[cap],
  );
  return allowed.length > 0 ? allowed : variants.slice(-1);
}

/**
 * The operator's size becomes the richest variant. The declared variants that
 * are strictly smaller are kept behind it, so a tile still degrades on a
 * window too small for the size that was asked for instead of leaving at once.
 */
function withOperatorVariant(
  descriptor: TileDescriptor,
  span: { readonly columns: number; readonly rows: number },
): readonly TileVariant[] {
  const richest = descriptor.variants[0];
  const presentation: TilePresentation = richest?.presentation ?? 'full';
  const area = span.columns * span.rows;
  return [
    { presentation, columns: span.columns, rows: span.rows },
    ...descriptor.variants.filter((variant) => variant.columns * variant.rows < area),
  ];
}

function reordered(
  current: readonly string[],
  movedId: string,
  targetId: string,
): readonly string[] {
  const without = current.filter((id) => id !== movedId);
  const at = without.indexOf(targetId);
  if (at === -1) return [...without, movedId];
  return [...without.slice(0, at), movedId, ...without.slice(at)];
}

function tileUnderPointer(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y);
  const cell = element?.closest('.tile-grid__cell');
  return cell instanceof HTMLElement ? (cell.dataset['tile'] ?? null) : null;
}

function cellSize(
  container: HTMLElement | null,
  columns: number,
  rows: number,
): { readonly width: number; readonly height: number } | null {
  if (container === null) return null;
  const box = container.getBoundingClientRect();
  return { width: box.width / columns, height: box.height / rows };
}

function resizedSpan(
  drag: DragState,
  event: { readonly clientX: number; readonly clientY: number },
  cell: { readonly width: number; readonly height: number },
  columns: number,
  rows: number,
): { readonly columns: number; readonly rows: number } {
  const wider = drag.kind === 'horizontal' || drag.kind === 'corner';
  const taller = drag.kind === 'vertical' || drag.kind === 'corner';
  const deltaColumns = wider ? Math.round((event.clientX - drag.originX) / cell.width) : 0;
  const deltaRows = taller ? Math.round((event.clientY - drag.originY) / cell.height) : 0;
  return {
    columns: clamp(drag.startColumns + deltaColumns, 1, columns),
    rows: clamp(drag.startRows + deltaRows, 1, rows),
  };
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

function withSpan(
  spans: readonly string[],
  id: string,
  span: { readonly columns: number; readonly rows: number },
): readonly string[] {
  return [
    ...spans.filter((entry) => !entry.startsWith(`${id}=`)),
    `${id}=${span.columns}x${span.rows}`,
  ];
}

function readSpan(
  spans: readonly string[],
  id: string,
): { readonly columns: number; readonly rows: number } | null {
  const entry = spans.find((item) => item.startsWith(`${id}=`));
  if (entry === undefined) return null;
  const [width, height] = entry
    .slice(id.length + 1)
    .split('x')
    .map(Number);
  if (width === undefined || height === undefined) return null;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { columns: width, rows: height }
    : null;
}

/**
 * The tile settings are schema-bound to string lists, but the draft holds
 * whatever was last read from storage, so the shape is checked here rather
 * than assumed. Same treatment the shell gives every other setting it reads.
 */
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}
