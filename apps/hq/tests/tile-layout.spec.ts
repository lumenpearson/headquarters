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
    /*
     * Grid coordinates alone cannot see a tile that under-fills the cell it
     * was given: the cell is occupied, and the empty space is inside it. A
     * panel capped at a fixed height does exactly that, so the panel is
     * measured against its cell rather than trusted to fill it.
     */
    const shortfalls: string[] = [];
    for (const cell of Array.from(grid.querySelectorAll('.tile-grid__cell')) as HTMLElement[]) {
      const panel = cell.querySelector('.ops-panel');
      if (panel === null) continue;
      const missing = Math.round(
        cell.getBoundingClientRect().height - panel.getBoundingClientRect().height,
      );
      if (missing > 2) shortfalls.push(`${cell.dataset['tile'] ?? '?'}:${missing}`);
    }
    return {
      rows,
      columns,
      placed: grid.querySelectorAll('.tile-grid__cell').length,
      holes,
      shortfalls,
    };
  });
}

/** Every route the resolver lays out. Screens it deliberately does not are listed in the plan. */
const resolvedRoutes = [
  '/overview',
  '/system',
  '/analytics',
  '/communications',
  '/objects',
  '/cases',
  '/reports',
  '/files',
  '/search',
  '/archive',
  '/map',
] as const;

for (const viewport of [
  { width: 1024, height: 600 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test(`R10: no resolved screen leaves an empty cell at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    for (const route of resolvedRoutes) {
      await page.goto(route);
      await expect(page.locator('.tile-grid__cell').first()).toBeVisible();

      const occupancy = await gridOccupancy(page);
      // Stated so the assertion cannot pass on an empty grid: a screen that
      // placed nothing also has no holes.
      expect({
        route,
        placed: occupancy.placed > 0,
        holes: occupancy.holes,
        shortfalls: occupancy.shortfalls,
      }).toEqual({ route, placed: true, holes: [], shortfalls: [] });
    }
  });
}

test('R10: no screen can be left blank by a size the operator is allowed to set', async ({
  page,
}) => {
  /*
   * The resolver fails closed: a tile it cannot place, and which declares no
   * way to leave, throws. That is the right contract for the engine and the
   * wrong thing to meet on a shoot -- the throw escapes render and the route
   * shows nothing at all.
   *
   * It was reachable. Dragging a registry's corner writes `tiles.spans`, and
   * `registry=10x1` on a window short enough for a single row left `/cases`
   * with no room for the third tile: measured, `Tile dossier cannot fit in
   * 12x1 grid and has no overflow policy` and an empty screen. Every tile
   * below the top priority now declares how it leaves, and this holds that.
   */
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ПЛИТКИ / TILES', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'TILES / SPANS' })
    .fill(
      [
        'cases:registry=12x1',
        'objects:registry=12x1',
        'reports:registry=12x1',
        'files:registry=12x1',
        'search:results=12x1',
      ].join(','),
    );

  // The shortest grid the runtime can produce: one row.
  await page.setViewportSize({ width: 1280, height: 400 });
  for (const route of resolvedRoutes) {
    await page.goto(route);
    await expect(page.locator('.ops-screen')).toBeVisible();
    await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});

test('R3: a tile hidden on one screen stays on the screens that share its name', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ПЛИТКИ / TILES', exact: true }).click();
  await page.getByRole('textbox', { name: 'TILES / HIDDEN IDS' }).fill('cases:registry');

  /*
   * `registry` is the record table on four screens. While the settings were
   * keyed by the bare id, hiding it on one hid it on all four and resizing it
   * on one resized all four -- measured, not supposed.
   */
  await page.goto('/cases');
  await expect(page.locator('[data-tile="tree"]')).toBeVisible();
  await expect(page.locator('[data-tile="registry"]')).toHaveCount(0);

  for (const route of ['/objects', '/reports', '/files']) {
    await page.goto(route);
    await expect(page.locator('[data-tile="registry"]')).toBeVisible();
  }
});

test('R3: switching a group off takes every tile in it, on every screen', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="threats"]')).toBeVisible();
  await expect(page.locator('[data-tile="sector"]')).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ПЛИТКИ / TILES', exact: true }).click();
  await page.getByRole('textbox', { name: 'TILES / HIDDEN CATEGORIES' }).fill('geo');

  await page.goto('/overview');
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();
  // Both overview tiles in the group, not just the one that happened to be first.
  await expect(page.locator('[data-tile="threats"]')).toHaveCount(0);
  await expect(page.locator('[data-tile="sector"]')).toHaveCount(0);

  // A group is a property of the tile, not of the screen: analytics has one too.
  await page.goto('/analytics');
  await expect(page.locator('[data-tile="index"]')).toBeVisible();
  await expect(page.locator('[data-tile="matrix"]')).toHaveCount(0);
});

test('R3: the operator can cap how rich a tile is drawn', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-presentation', 'full');

  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ПЛИТКИ / TILES', exact: true }).click();
  await page.getByRole('combobox', { name: 'TILES / PRESENTATION' }).click();
  await page.getByRole('option', { name: 'MINIMAL', exact: true }).click();

  await page.goto('/overview');
  const brief = page.locator('[data-tile="brief"]');
  await expect(brief).toBeVisible();
  await expect(brief).toHaveAttribute('data-presentation', 'minimal');

  /*
   * A tile with no variant at or below the cap keeps its last one. The cap is
   * about how much a tile shows; a tile that vanished because it could not be
   * drawn small enough would be a different setting.
   */
  await expect(page.locator('[data-tile="readiness"]')).toBeVisible();
  await expect(page.locator('[data-tile="readiness"]')).toHaveAttribute(
    'data-presentation',
    'compact',
  );
});

test('R3: edit mode offers the tiles by name instead of asking for identifiers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="evidence"]')).toBeVisible();
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toBeVisible();

  const panel = page.locator('.edit-panel');
  // The panel navigates by section and shows the whole of one at once, so the
  // tiles category is a heading inside `layout` rather than an entry in a flat
  // list of all thirty-two categories.
  await panel.getByRole('combobox', { name: 'Раздел' }).click();
  await page.getByRole('option', { name: 'МАКЕТ И РАЗМЕРЫ / LAYOUT', exact: true }).click();

  const list = panel.locator('.edit-tiles');
  await expect(list).toBeVisible();
  // Named as the panel is titled, not as the setting keys it.
  const evidence = list.getByRole('switch', { name: 'СОБРАННЫЕ ДОКАЗАТЕЛЬСТВА' });
  await expect(evidence).toBeChecked();

  await evidence.click();
  await expect(page.locator('[data-tile="evidence"]')).toHaveCount(0);
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();

  // Switching the group off disables the individual switch: the tile is gone
  // for a reason that toggle cannot undo.
  const geo = list.getByRole('switch', { name: 'ГЕОГРАФИЯ' });
  await geo.click();
  await expect(page.locator('[data-tile="threats"]')).toHaveCount(0);
  await expect(list.getByRole('switch', { name: 'УРОВЕНЬ УГРОЗЫ ПО СЕКТОРАМ' })).toBeDisabled();
});

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
  // Wait for the grid before asking a tile about its presentation. Without
  // this the assertion races the first paint of the route and reports "element
  // not found" for a tile that simply is not drawn yet -- observed once in a
  // full-suite run and not reproducible on its own, which is what a race looks
  // like. Every other test in this file already waits.
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
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
  await page.getByRole('textbox', { name: 'TILES / HIDDEN IDS' }).fill('overview:evidence');

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
