import { expect, test, type Page } from '@playwright/test';

/**
 * Reads the grid back the way the resolver wrote it: every cell carries its
 * own `grid-column`/`grid-row` inline, so the occupancy of the grid can be
 * reconstructed without asking the resolver what it decided.
 */
function gridOccupancy(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.tile-grid');
    if (grid === null) throw new Error('the screen is not laid out by the resolver');
    const styles = getComputedStyle(grid);
    const rows = styles.gridTemplateRows.split(' ').length;
    const columns = styles.gridTemplateColumns.split(' ').length;
    const occupied = new Set<string>();
    for (const cell of Array.from(grid.querySelectorAll('.tile-grid__cell')) as HTMLElement[]) {
      const [columnStart, columnSpan] = cell.style.gridColumn.split(' / span ').map(Number);
      const [rowStart, rowSpan] = cell.style.gridRow.split(' / span ').map(Number);
      if (
        columnStart === undefined ||
        columnSpan === undefined ||
        rowStart === undefined ||
        rowSpan === undefined
      ) {
        throw new Error('a placed tile carries no placement');
      }
      for (let row = rowStart; row < rowStart + rowSpan; row += 1) {
        for (let column = columnStart; column < columnStart + columnSpan; column += 1) {
          occupied.add(`${row}:${column}`);
        }
      }
    }
    const holes: string[] = [];
    for (let row = 1; row <= rows; row += 1) {
      for (let column = 1; column <= columns; column += 1) {
        if (!occupied.has(`${row}:${column}`)) holes.push(`r${row}c${column}`);
      }
    }
    return { rows, columns, placed: grid.querySelectorAll('.tile-grid__cell').length, holes };
  });
}

for (const viewport of [
  { width: 1024, height: 600 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test(`R10: the overview leaves no empty cell at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/overview');
    await expect(page.locator('.tile-grid__cell').first()).toBeVisible();

    const occupancy = await gridOccupancy(page);
    // Stated so the assertion cannot pass on an empty grid: a screen that
    // placed nothing also has no holes.
    expect(occupancy.placed).toBeGreaterThan(0);
    expect(occupancy.holes).toEqual([]);
  });
}

test('R10: a tile that does not fit goes to the screen of its own', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/overview');
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();

  const notice = page.locator('.tile-grid__displaced');
  await expect(notice).toBeVisible();

  // `sector` shows the operation's ground, and `/map` shows the same ground in
  // full. The link is the claim: what left the overview is still reachable.
  const relocated = notice.getByRole('button', { name: 'СЕКТОР ОПЕРАЦИИ' });
  await expect(relocated).toBeVisible();
  await expect(page.locator('[data-tile="sector"]')).toHaveCount(0);

  await relocated.click();
  await expect(page).toHaveURL(/\/map$/);
});

test('R10: a tile with no screen of its own is named rather than dropped', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/overview');
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();

  const notice = page.locator('.tile-grid__displaced');
  // `state.tasks` is read by the overview alone, so there is no route to send
  // the operator to. It is listed without a link instead of pointing at a
  // screen that shows something else.
  await expect(notice.locator('b', { hasText: 'АКТИВНЫЕ ЗАДАЧИ' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'АКТИВНЫЕ ЗАДАЧИ' })).toHaveCount(0);
});

test('R10: a tile shows less at a smaller presentation, not the same list in a smaller box', async ({
  page,
}) => {
  const timelineRows = () => page.locator('[data-tile="timeline"] .operation-timeline > button');

  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="timeline"]')).toHaveAttribute('data-presentation', 'full');
  const atFull = await timelineRows().count();

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('[data-tile="timeline"]')).toHaveAttribute(
    'data-presentation',
    'compact',
  );
  const atCompact = await timelineRows().count();

  expect(atFull).toBeGreaterThan(atCompact);
  expect(atCompact).toBeGreaterThan(0);
});

test('R3: hiding a tile by id removes it from the screen', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="evidence"]')).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ПЛИТКИ / TILES', exact: true }).click();
  await page.getByRole('textbox', { name: 'TILES / HIDDEN IDS' }).fill('evidence');

  await page.goto('/overview');
  /*
   * The anchor comes first on purpose. The grid renders nothing until it has
   * been measured, so an absence asserted straight after a navigation passes
   * on the empty frame before any tile exists -- which is how this test first
   * passed against a `TileGrid` that ignored the setting entirely.
   */
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();
  await expect(page.locator('[data-tile="evidence"]')).toHaveCount(0);

  // A tile the operator hid is not a tile that did not fit: it never reaches
  // the resolver, so it must not turn up in the notice offering to find it.
  await expect(
    page.locator('.tile-grid__displaced', { hasText: 'СОБРАННЫЕ ДОКАЗАТЕЛЬСТВА' }),
  ).toHaveCount(0);
});
