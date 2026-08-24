import { expect, test, type Page } from '@playwright/test';

/**
 * That choosing a setting changes the screen.
 *
 * Every setting exercised here was declared, drawn in the catalogue, validated
 * and saved — and read by nothing. Seventeen of thirty-nine were in that state
 * (C20, C31), which is invisible from the settings screen: the control moves,
 * the value persists, and the application looks exactly the same. These tests
 * assert the only thing that separates a working setting from an inert one.
 *
 * Every case runs at 2560x1440. The status line clips what does not fit
 * (`overflow: hidden`, `white-space: nowrap`) and the header drops two metadata
 * entries below 1600px, so a narrow window hides these elements for reasons
 * that have nothing to do with the setting under test.
 */
const wide = { width: 2560, height: 1440 } as const;

/**
 * Seeds the persisted draft before the application boots.
 *
 * Two things had to be learned to make this work, and both are worth keeping.
 * The application writes its blob only when something changes, so on a fresh
 * profile there is nothing to patch. And `hydratePersistedState` refuses a
 * snapshot missing `ui`, `production` or `personalization` and discards it
 * whole — which brings the page back with defaults and looks exactly like a
 * setting that does nothing. The blob below is therefore complete, and empty
 * where the test has no opinion: the hydrator spreads those over its defaults.
 *
 * Driving the catalogue UI instead would test the catalogue; what is under test
 * is whether a stored value reaches the document, which is the half that was
 * missing.
 */
async function seedSettings(page: Page, values: Record<string, unknown>): Promise<void> {
  await page.addInitScript((stored: Record<string, unknown>) => {
    window.localStorage.setItem(
      'gremuchaya-hq:operations:v3',
      JSON.stringify({
        version: 5,
        ui: {},
        production: {},
        personalization: {
          published: { revision: 0, values: {} },
          draft: {
            baseRevision: 0,
            values: stored,
            changedIds: Object.keys(stored),
            history: [],
          },
          history: [],
          undoStack: [],
          redoStack: [],
        },
      }),
    );
  }, values);
}

/**
 * Waits for the shell to carry the value.
 *
 * Hydration runs in an effect, so the first paint shows the defaults and the
 * setting arrives a tick later. Reading a computed style before this returns
 * measures the unhydrated page — which is how a working setting can be made to
 * look inert by the test rather than by the code.
 */
async function settled(page: Page, attribute: string, value: string): Promise<void> {
  await expect(page.locator('.ops-shell')).toHaveAttribute(attribute, value);
}

function displayOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((css) => {
    const element = document.querySelector(css);
    return element === null ? 'absent' : window.getComputedStyle(element).display;
  }, selector);
}

test('R6: operational context leaves the header when the setting turns it off', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await settled(page, 'data-operational-context', 'on');
  expect(await displayOf(page, '[data-operational-context="sector"]')).not.toBe('none');

  await seedSettings(page, { 'information.showOperationalContext': false });
  await page.reload();
  await settled(page, 'data-operational-context', 'off');

  // Hidden, not removed: the header keeps its shape, so turning the context off
  // cannot reflow the shell around it.
  expect(await displayOf(page, '[data-operational-context="sector"]')).toBe('none');
  expect(await displayOf(page, '[data-operational-context="operation"]')).toBe('none');
  await expect(page.locator('.ops-topbar')).toBeVisible();
});

test('R6: diagnostic verbosity decides how much of the status line is spent on detail', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await settled(page, 'data-diagnostics-verbosity', 'standard');
  // The declared default is `standard`, so the verbose entries start hidden and
  // the standard ones do not.
  expect(await displayOf(page, '.ops-statusline [data-detail="standard"]')).not.toBe('none');
  expect(await displayOf(page, '.ops-statusline [data-detail="verbose"]')).toBe('none');

  await seedSettings(page, { 'diagnostics.verbosity': 'verbose' });
  await page.reload();
  await settled(page, 'data-diagnostics-verbosity', 'verbose');
  expect(await displayOf(page, '.ops-statusline [data-detail="verbose"]')).not.toBe('none');

  await seedSettings(page, { 'diagnostics.verbosity': 'minimal' });
  await page.reload();
  await settled(page, 'data-diagnostics-verbosity', 'minimal');
  expect(await displayOf(page, '.ops-statusline [data-detail="standard"]')).toBe('none');
  expect(await displayOf(page, '.ops-statusline [data-detail="verbose"]')).toBe('none');
  // The line itself never goes away: minimal is less detail, not no status.
  await expect(page.locator('.ops-statusline')).toBeVisible();
});

test('R6: camera grid density decides how many cameras share a row', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'cameras.gridDensity': '2x2' });
  await page.goto('/video/cameras');
  await settled(page, 'data-camera-density', '2x2');
  await expect(page.locator('.camera-grid')).toBeVisible();
  const twoUp = await columnCount(page);

  await seedSettings(page, { 'cameras.gridDensity': '3x4' });
  await page.reload();
  await settled(page, 'data-camera-density', '3x4');
  await expect(page.locator('.camera-grid')).toBeVisible();
  const fourUp = await columnCount(page);

  expect(twoUp).toBe(2);
  expect(fourUp).toBe(4);
});

test('R14: a theme and an accent both reach the document and neither breaks the layout', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  const before = await workspaceBox(page);

  await seedSettings(page, { 'themes.id': 'high-contrast-light', 'colors.accent': 'cyan' });
  await page.reload();
  await settled(page, 'data-theme', 'high-contrast-light');
  await settled(page, 'data-accent', 'cyan');

  // R14 asks for a theme change that does not break the interface, and the
  // observable form of "not broken" is that the workspace keeps its box and the
  // page still does not scroll.
  const after = await workspaceBox(page);
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerHeight),
  );
});

function columnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector('.camera-grid');
    if (grid === null) return 0;
    return window.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  });
}

async function workspaceBox(page: Page): Promise<{ width: number; height: number }> {
  const box = await page.locator('.ops-workspace').boundingBox();
  if (box === null) throw new Error('the workspace is not laid out');
  return { width: Math.round(box.width), height: Math.round(box.height) };
}
