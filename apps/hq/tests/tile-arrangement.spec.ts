import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The edit panel is a fixed overlay docked to one edge, so it covers the tiles
 * along that edge. Every gesture below therefore works on tiles in the left
 * half of the grid: a press aimed at a covered tile lands on the panel, which
 * is correct behaviour and would make these tests measure the wrong thing.
 */
async function enterEditMode(page: Page): Promise<void> {
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toBeVisible();
}

function tileOrder(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tile-grid__cell')).map(
      (cell) => (cell as HTMLElement).dataset['tile'] ?? '',
    ),
  );
}

function settingValue(page: Page, id: string): Promise<unknown> {
  return page.evaluate((settingId) => {
    const raw = localStorage.getItem('gremuchaya-hq:operations:v3');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as {
      personalization?: { draft?: { values?: Record<string, unknown> } };
    };
    return parsed.personalization?.draft?.values?.[settingId] ?? null;
  }, id);
}

/**
 * Whether the operator's draft records a change to this setting.
 *
 * The draft is seeded from the factory snapshot, so every setting is present in
 * `values` from the first render -- `tiles.order` included, as an empty list.
 * Reading `values` therefore cannot tell "the operator moved nothing" from "the
 * operator moved something": only `changedIds` can, and it is what the
 * catalogue itself reads to mark a row as edited.
 *
 * The absent blob answers `false`, which is the same statement: a store that
 * was never persisted recorded no change either.
 */
function settingChanged(page: Page, id: string): Promise<boolean> {
  return page.evaluate((settingId) => {
    const raw = localStorage.getItem('gremuchaya-hq:operations:v3');
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as {
      personalization?: { draft?: { changedIds?: readonly string[] } };
    };
    return (parsed.personalization?.draft?.changedIds ?? []).includes(settingId);
  }, id);
}

test('R7: dragging a tile onto another moves that tile and leaves the rest in order', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await enterEditMode(page);

  const before = await tileOrder(page);
  const from = await page.locator('[data-tile="brief"]').boundingBox();
  const to = await page.locator('[data-tile="events"]').boundingBox();
  if (from === null || to === null) throw new Error('the grid is not laid out');

  await page.mouse.move(from.x + 40, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + 60, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(() => tileOrder(page).then((order) => order[0])).not.toBe('brief');
  const after = await tileOrder(page);

  expect(after).toHaveLength(before.length);
  expect(after.indexOf('brief')).toBeLessThan(after.indexOf('events'));
  // The claim that separates a reorder from a reshuffle: every tile the
  // operator did not touch keeps the order it had.
  expect(after.filter((id) => id !== 'brief')).toEqual(before.filter((id) => id !== 'brief'));
  // Stored qualified by screen, because `registry` is a tile on four of them.
  expect(await settingValue(page, 'tiles.order')).toEqual(after.map((id) => `overview:${id}`));
});

test('R7: while a tile is being carried, the places it can go say so', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await enterEditMode(page);

  const from = await page.locator('[data-tile="brief"]').boundingBox();
  const to = await page.locator('[data-tile="events"]').boundingBox();
  if (from === null || to === null) throw new Error('the grid is not laid out');

  await page.mouse.move(from.x + 40, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + 60, { steps: 5 });

  const carried = page.locator('[data-drag-source="true"]');
  await expect(carried).toHaveAttribute('data-tile', 'brief');
  const available = page.locator('[data-drop-target="true"]');
  expect(await available.count()).toBeGreaterThan(0);
  // The tile being carried is not a place it can go.
  await expect(page.locator('[data-tile="brief"][data-drop-target="true"]')).toHaveCount(0);

  const glowOf = (locator: Locator) =>
    locator.evaluate((element) => ({
      outline: getComputedStyle(element).outlineStyle,
      wash: getComputedStyle(element, '::after').backgroundColor,
    }));

  const availableEdge = await glowOf(available.first());
  expect(availableEdge.outline).toBe('dashed');
  // Not asserted as an `rgb(...)` string: Chromium computes `color-mix` to
  // `color(srgb ...)`, and pinning the notation would test the serialiser.
  expect(availableEdge.wash).not.toBe('rgba(0, 0, 0, 0)');
  expect(availableEdge.wash).not.toBe('transparent');

  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  const hovered = page.locator('[data-drop-active="true"]');
  await expect(hovered).toHaveAttribute('data-tile', 'events');
  // The place under the pointer reads differently from the merely available
  // ones, or the highlight tells the operator nothing about where it will land.
  const hoveredEdge = await glowOf(hovered);
  expect(hoveredEdge.outline).toBe('solid');
  expect(hoveredEdge.wash).not.toBe(availableEdge.wash);

  await page.mouse.up();
});

test('R23: a tile is resized by the handle whose cursor says so', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await enterEditMode(page);

  const cell = page.locator('[data-tile="brief"]');
  await expect(cell.locator('.tile-grid__handle[data-resize="horizontal"]')).toHaveCSS(
    'cursor',
    'ew-resize',
  );
  await expect(cell.locator('.tile-grid__handle[data-resize="vertical"]')).toHaveCSS(
    'cursor',
    'ns-resize',
  );
  const corner = cell.locator('.tile-grid__handle[data-resize="corner"]');
  await expect(corner).toHaveCSS('cursor', 'nwse-resize');

  const before = await cell.evaluate((element) => (element as HTMLElement).style.gridRow);
  const handle = await corner.boundingBox();
  const grid = await page.locator('.tile-grid').boundingBox();
  if (handle === null || grid === null) throw new Error('the grid is not laid out');

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 - grid.width / 4,
    handle.y + handle.height / 2 + 200,
    { steps: 8 },
  );
  await page.mouse.up();

  await expect
    .poll(() =>
      page
        .locator('[data-tile="brief"]')
        .evaluate((element) => (element as HTMLElement).style.gridRow),
    )
    .not.toBe(before);
  expect(await settingValue(page, 'tiles.spans')).toEqual(['overview:brief=1x3']);

  // Dragged past the far corner of the grid, the size stops at the grid
  // rather than following the pointer into a span nothing could place.
  const again = await page
    .locator('[data-tile="brief"] .tile-grid__handle[data-resize="corner"]')
    .boundingBox();
  if (again === null) throw new Error('the handle is gone');
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(again.x + grid.width * 2, again.y + grid.height * 2, { steps: 8 });
  await page.mouse.up();

  /*
   * Both read after the gesture. The grid gains rows as the tile grows, so a
   * bound captured beforehand is one row out of date by the time the drag
   * ends -- measured, after asserting the stale number and watching it miss
   * by exactly that.
   *
   * The span is compared to the grid rather than to a row count written here.
   * The claim is that the size stops at the grid; how many rows the grid has is
   * the shell chrome's business, and the number moved from eight to seven the
   * day the custom title bar (R24) took a row of the window. Columns stay a
   * literal: four is the overview screen's own coordinate system, which no
   * chrome can change. The floor is what keeps a collapsed grid from passing
   * the comparison by agreeing with a collapsed span.
   */
  await expect
    .poll(async () => {
      const bounds = await page.locator('.tile-grid').evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          columns: styles.gridTemplateColumns.split(' ').length,
          rows: styles.gridTemplateRows.split(' ').length,
        };
      });
      const spans = await settingValue(page, 'tiles.spans');
      const filled = `overview:brief=${bounds.columns}x${bounds.rows}`;
      return {
        columns: bounds.columns,
        roomy: bounds.rows >= 4,
        spanFillsTheGrid: Array.isArray(spans) && spans.length === 1 && spans[0] === filled,
      };
    })
    .toEqual({ columns: 4, roomy: true, spanFillsTheGrid: true });
});

test('R7: a press that does not travel selects the tile instead of moving it', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await enterEditMode(page);

  const before = await tileOrder(page);
  const box = await page.locator('[data-tile="brief"]').boundingBox();
  if (box === null) throw new Error('the grid is not laid out');

  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  // Three pixels of jitter, as a real press has. A press with none never
  // reaches the threshold at all, so it would pass even against a build that
  // treated the very first pixel as the start of a drag.
  await page.mouse.move(box.x + 42, box.y + 21);
  await page.mouse.up();

  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-selected', 'true');
  expect(await tileOrder(page)).toEqual(before);

  // Pressing the selected tile again clears the selection rather than doing
  // nothing, so the operator can put the panel back on the whole screen.
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('[data-tile="brief"]')).not.toHaveAttribute('data-selected', 'true');
});

test('R7: outside edit mode a tile has no handles and a drag rearranges nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();

  await expect(page.locator('.tile-grid__handle')).toHaveCount(0);

  const before = await tileOrder(page);
  const from = await page.locator('[data-tile="brief"]').boundingBox();
  const to = await page.locator('[data-tile="events"]').boundingBox();
  if (from === null || to === null) throw new Error('the grid is not laid out');

  await page.mouse.move(from.x + 40, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();

  expect(await tileOrder(page)).toEqual(before);
  /*
   * `changedIds`, not the value.
   *
   * This line read `settingValue(...) === null` until 2026-08-27, and that
   * passed only while nothing persisted the store during the test: the draft
   * carries `tiles.order` as an empty list from its first render, so the null
   * was the absence of the whole blob rather than the absence of a change. On
   * a loaded CI runner something else persisted the store inside this test's
   * window, the helper read the seeded empty list, and the case failed twice
   * over -- for a reason it was never about. What it is about is that the
   * operator's draft records no reordering, and that is `changedIds`.
   */
  expect(await settingChanged(page, 'tiles.order')).toBe(false);
});
