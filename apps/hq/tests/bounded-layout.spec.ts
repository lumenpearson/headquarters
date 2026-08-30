import { expect, test, type Page } from '@playwright/test';

/**
 * Every route the navigation rail can reach, plus the two nested video routes
 * and the internal gallery. `/objects/:id` and `/cases/:id` are covered by the
 * registry routes they open from: they render the same `.ops-screen` frame.
 */
const routes = [
  '/overview',
  '/objects',
  '/cases',
  '/map',
  '/video',
  '/video/cameras',
  '/video/archive',
  '/communications',
  '/files',
  '/archive',
  '/analytics',
  '/reports',
  '/search',
  '/settings',
  '/system',
  '/dev/ui',
] as const;

/**
 * The shapes the shoot is expected to run on: a short window, the smallest
 * supported laptop, the two 720p-class panels, a 1080p monitor and a 1440p
 * one. The defect this suite first locked out was invisible at exactly one of
 * them, because the height it assumed was written as a constant.
 */
const viewports = [
  /*
   * The short window comes first because it is the one the matrix was missing.
   * Every height here was 768 or taller, and `/map` overflowed the workspace
   * by 109px at 1024x600 for as long as that was true: the stacked layout gave
   * the map surface a 520px minimum in a column shorter than that.
   */
  { width: 1024, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;

function scrollExtents(page: Page) {
  return page.evaluate(() => {
    const workspace = document.querySelector('.ops-workspace');
    if (workspace === null) throw new Error('the workspace is not rendered');
    return {
      documentY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      documentX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyY: document.body.scrollHeight - document.body.clientHeight,
      workspaceY: workspace.scrollHeight - workspace.clientHeight,
      workspaceX: workspace.scrollWidth - workspace.clientWidth,
    };
  });
}

/**
 * R26 asks for two things that a measurement of scroll extent cannot tell
 * apart: that nothing overflows today, and that the workspace would refuse to
 * scroll if something did. A screen added later overflows before anyone
 * measures it, so the refusal is asserted separately from the extent.
 */
function workspaceOverflow(page: Page) {
  return page.evaluate(() => {
    const workspace = document.querySelector('.ops-workspace');
    if (workspace === null) throw new Error('the workspace is not rendered');
    const styles = getComputedStyle(workspace);
    return { y: styles.overflowY, x: styles.overflowX };
  });
}

for (const viewport of viewports) {
  test(`R26: no route scrolls the page at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('.ops-workspace')).toBeVisible();
      const extents = await scrollExtents(page);
      expect({ route, ...extents }).toEqual({
        route,
        documentY: 0,
        documentX: 0,
        bodyY: 0,
        workspaceY: 0,
        workspaceX: 0,
      });
      expect({ route, ...(await workspaceOverflow(page)) }).toEqual({
        route,
        y: 'hidden',
        x: 'hidden',
      });
    }
  });
}

test('R30: a panel too small for its content scrolls itself, not the page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/overview');

  const body = page.locator('.overview-threats .ops-panel__body');
  await expect(body).toBeVisible();

  // The premise of the assertion, stated rather than assumed: this panel is
  // showing less than it holds. Without it a panel that happened to fit would
  // pass the scroll check by never having anywhere to scroll.
  const overflow = await body.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(overflow).toBeGreaterThan(0);

  const lastSector = page.locator('.overview-threats .threat-list > button').last();
  const reachedBefore = await lastSector.evaluate((element) => {
    const panel = element.closest('.ops-panel__body') as HTMLElement;
    return element.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1;
  });
  expect(reachedBefore).toBe(false);

  // A wheel over the panel, not `scrollTo`: the claim is that the gesture an
  // operator makes lands on the panel and does not travel to the shell.
  const box = await body.boundingBox();
  if (box === null) throw new Error('the panel body is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const reachedAfter = await lastSector.evaluate((element) => {
    const panel = element.closest('.ops-panel__body') as HTMLElement;
    return element.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1;
  });
  expect(reachedAfter).toBe(true);

  expect(await scrollExtents(page)).toEqual({
    documentY: 0,
    documentX: 0,
    bodyY: 0,
    workspaceY: 0,
    workspaceX: 0,
  });
});

test('R30: the video surface keeps its shape and is not squeezed by its own controls', async ({
  page,
}) => {
  /*
   * `stacked` is the narrow case, where the layout collapses into one column.
   * It is included because that is where the collapse was worst -- 2px of
   * video -- and where the row sizing of the stacked column is the only thing
   * holding the surface open. A wide-only loop cannot see it.
   */
  for (const viewport of [
    { width: 1024, height: 600, stacked: true },
    { width: 1024, height: 768, stacked: true },
    { width: 1280, height: 720, stacked: false },
    { width: 1920, height: 1080, stacked: false },
    { width: 2560, height: 1440, stacked: false },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/video');
    await expect(page.locator('.video-main-feed')).toBeVisible();

    const measured = await page.evaluate(() => {
      const surface = document.querySelector('.video-main-feed') as HTMLElement;
      const transport = document.querySelector('.video-transport') as HTMLElement;
      const clipped: string[] = [];
      for (const element of Array.from(
        document.querySelectorAll('.ops-workspace *'),
      ) as HTMLElement[]) {
        const styles = getComputedStyle(element);
        if (styles.clipPath === 'inset(50%)') continue;
        if (element.clientHeight <= 1 && element.clientWidth <= 1) continue;
        const by = element.scrollHeight - element.clientHeight;
        if (by > 2 && (styles.overflowY === 'hidden' || styles.overflowY === 'clip')) {
          clipped.push(element.className.toString().split(' ').filter(Boolean)[0] ?? '?');
        }
      }
      return {
        ratio: getComputedStyle(surface).aspectRatio,
        feed: Math.round(surface.getBoundingClientRect().height),
        transport: Math.round(transport.getBoundingClientRect().height),
        clipped: Array.from(new Set(clipped)),
      };
    });

    /*
     * The feed is the one surface in the application with a shape of its own.
     * Without it the element had no intrinsic height at all and a row sized to
     * its content gave it none: 2px of video under 242px of transport
     * controls, measured at 1024x600.
     */
    const label = `${viewport.width}x${viewport.height}`;
    expect({
      label,
      ratio: measured.ratio,
      feedOverTransport: measured.feed > measured.transport,
    }).toEqual({ label, ratio: '16 / 9', feedOverTransport: true });

    /*
     * A window one column wide has less room than four stacked regions need,
     * so panels clip there for the reason every panel does -- 42px of header
     * plus 24px of padding is a floor. What must not happen is the surface
     * collapsing to nothing.
     */
    expect({ label, collapsed: measured.feed < 40 }).toEqual({ label, collapsed: false });
    if (!viewport.stacked) {
      expect({ label, clipped: measured.clipped }).toEqual({ label, clipped: [] });
      expect(measured.feed).toBeGreaterThan(200);
    }
  }
});

test('R26: the camera matrix scrolls its own records', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/video/cameras');

  const grid = page.locator('.camera-grid');
  await expect(grid).toBeVisible();

  const measured = await grid.evaluate((element) => ({
    overflow: element.scrollHeight - element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(measured.overflow).toBeGreaterThan(0);
  // `hidden` here is the defect this test exists for: it put cameras past the
  // edge of the panel with no gesture that could reach them.
  expect(measured.overflowY).toBe('auto');

  const box = await grid.boundingBox();
  if (box === null) throw new Error('the camera matrix is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  expect((await scrollExtents(page)).workspaceY).toBe(0);
});

/**
 * t4-file-dialog-card: opens the file record's drawer by double-clicking the
 * first row of the registry table, which calls `openDrawer('file', id)`
 * directly (`FilesScreen.tsx`) without depending on a prior row selection.
 */
async function openFileDrawer(page: Page) {
  await page.goto('/files');
  const firstRow = page.locator('.files-table tbody tr').first();
  await expect(firstRow).toBeVisible();
  await firstRow.dblclick();
  const drawer = page.locator('.ops-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

test('file drawer: the card is centred, width-capped and clear of both viewport edges', async ({
  page,
}) => {
  // Above the app's own layout floor (`@media (max-width: 1180px)`, where
  // `.ops-screen` itself gives up on reflowing further): the card variant
  // must actually be a card here, not the full-screen surface below it.
  const viewport = { width: 1280, height: 720 };
  await page.setViewportSize(viewport);
  const drawer = await openFileDrawer(page);

  await expect(page.locator('.ops-drawer header span')).toContainText('FILE /');

  const box = await drawer.boundingBox();
  if (box === null) throw new Error('the file drawer is not laid out');

  // Centred: the gap to the left edge and the gap to the right edge of the
  // app viewport agree, which `inset: 0; margin: auto` gives for free and a
  // right-anchored aside never would.
  const leftGap = box.x;
  const rightGap = viewport.width - (box.x + box.width);
  expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);

  // Capped at 60% of the app viewport width (`width: min(60vw, 1040px)`;
  // 60% of 1280 is under the 1040px ceiling, so the vw term is the one that
  // actually bites here).
  expect(box.width).toBeLessThanOrEqual(viewport.width * 0.6 + 2);
  expect(box.width).toBeGreaterThan(viewport.width * 0.6 - 2);

  // Never touches the top or bottom edge: R26 forbids page scroll, so the
  // margin the card leaves at both edges has to be real, not a rounding
  // artefact of `100vh`/`100dvh`.
  expect(box.y).toBeGreaterThan(0);
  expect(viewport.height - (box.y + box.height)).toBeGreaterThan(0);

  expect(await scrollExtents(page)).toEqual({
    documentY: 0,
    documentX: 0,
    bodyY: 0,
    workspaceY: 0,
    workspaceX: 0,
  });
});

test('file drawer: becomes a full-screen surface below the app layout floor', async ({ page }) => {
  // 1024x600 is both the shortest window in the R26 matrix above and, at
  // 1024px wide, already below the 1180px floor where `.ops-screen` stops
  // reflowing -- the same floor `.ops-drawer--card`'s full-screen `@media`
  // query keys off.
  const viewport = { width: 1024, height: 600 };
  await page.setViewportSize(viewport);
  const drawer = await openFileDrawer(page);

  const box = await drawer.boundingBox();
  if (box === null) throw new Error('the file drawer is not laid out');
  expect({
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });

  expect(await scrollExtents(page)).toEqual({
    documentY: 0,
    documentX: 0,
    bodyY: 0,
    workspaceY: 0,
    workspaceX: 0,
  });
});
