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
 * The four shapes the shoot is expected to run on: the smallest supported
 * laptop, the two 720p-class panels, a 1080p monitor and a 1440p one. The
 * defect this suite locks out was invisible at exactly one of them, because
 * the height it assumed was written as a constant.
 */
const viewports = [
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
