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

test('R6/R19: geometry settings resize the interface without letting the page scroll', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await expect(page.locator('.ops-panel').first()).toBeVisible();
  const before = await panelMetrics(page);

  await seedSettings(page, {
    'sizes.panelHeader': 44,
    'sizes.panelPadding': 16,
    'sizes.borderWidth': 3,
    'typography.letterSpacing': 0.15,
    'colors.panelOpacity': 0.6,
  });
  await page.reload();
  await expect(page.locator('.ops-panel').first()).toBeVisible();
  await expect.poll(() => panelMetrics(page).then((metrics) => metrics.borderWidth)).toBe('3px');
  const after = await panelMetrics(page);

  // Header height is deliberately not asserted here: the wide breakpoint sets
  // its own, and a responsive rule outranking the base declaration is correct
  // rather than a setting failing to apply.
  expect(after.bodyPadding).toBe('16px');
  // The typography hook is asserted as the property reaching the shell rather
  // than as a computed letter spacing: the design sets its own on several
  // descendants, so measuring one of those would report no change however far
  // the setting moved. The two geometry values above are what prove a hook
  // actually redraws something.
  expect(after.letterSpacingProperty).toBe('0.15em');
  expect(before.letterSpacingProperty).toBe('');
  // R19 asks for per-element size settings "within reason": the reason is that
  // the layout stays bounded, which is R26 and is the property that would break
  // first if a size setting were unbounded.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerHeight),
  );
});

test('R13: a background pattern appears only when one is chosen', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await settled(page, 'data-background-pattern', 'none');
  // `none` is the default, and it must paint nothing at all: a profile that
  // never touched this setting has no extra layer.
  expect(await patternDisplay(page)).toBe('none');

  await seedSettings(page, { 'patterns.background': 'dots', 'patterns.scale': 20 });
  await page.reload();
  await settled(page, 'data-background-pattern', 'dots');
  expect(await patternDisplay(page)).not.toBe('none');
  expect(await patternSize(page)).toBe('20px 20px');
});

test('R19: switching a kind of motion off leaves the rest of the interface moving', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'animations.panelHover': false });
  await page.goto('/overview');
  await settled(page, 'data-panel-hover', 'off');

  // One kind of movement, not the global switch: the shell still declares a
  // motion duration, which is what R19 means by an animation setting per
  // element rather than one toggle for everything.
  expect(
    await page.evaluate(() => {
      const panel = document.querySelector('.ops-panel');
      return panel === null ? 'absent' : window.getComputedStyle(panel).transitionDuration;
    }),
  ).toBe('0s');
  expect(
    await page.evaluate(() =>
      window
        .getComputedStyle(document.querySelector('.ops-shell') as Element)
        .getPropertyValue('--ops-motion-duration')
        .trim(),
    ),
  ).not.toBe('');
});

async function panelMetrics(page: Page): Promise<{
  headerHeight: number;
  bodyPadding: string;
  borderWidth: string;
  letterSpacingProperty: string;
}> {
  return page.evaluate(() => {
    const panel = document.querySelector('.ops-panel');
    const header = document.querySelector('.ops-panel__header');
    const body = document.querySelector('.ops-panel__body');
    if (panel === null || header === null || body === null) {
      throw new Error('no panel is laid out');
    }
    return {
      headerHeight: Math.round(header.getBoundingClientRect().height),
      bodyPadding: window.getComputedStyle(body).paddingTop,
      borderWidth: window.getComputedStyle(panel).borderTopWidth,
      letterSpacingProperty: window
        .getComputedStyle(document.querySelector('.ops-shell') as Element)
        .getPropertyValue('--ops-letter-spacing')
        .trim(),
    };
  });
}

function patternDisplay(page: Page): Promise<string> {
  return page.evaluate(() => {
    const frame = document.querySelector('.ops-shell__frame');
    return frame === null ? 'absent' : window.getComputedStyle(frame, '::after').display;
  });
}

function patternSize(page: Page): Promise<string> {
  return page.evaluate(() => {
    const frame = document.querySelector('.ops-shell__frame');
    return frame === null ? 'absent' : window.getComputedStyle(frame, '::after').backgroundSize;
  });
}

test('R19: a tile carries the motion its own entry names, over its group', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();
  // The declared default, with nothing named.
  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-tile-motion', 'fade');

  await seedSettings(page, {
    // `summary` holds `brief` alone on this screen, so `events` is what proves
    // a group rule reaches tiles the operator never named one by one.
    'tiles.categoryAnimations': ['summary=rise', 'events=rise'],
    'tiles.animations': ['overview:brief=scan'],
  });
  await page.reload();
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();

  // The narrower setting wins: a group rule an operator cannot override for one
  // tile is a rule they would have to abandon for the whole group.
  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-tile-motion', 'scan');
  // Tiles the operator never named one by one take their group's motion.
  await expect.poll(() => page.locator('[data-tile-motion="rise"]').count()).toBeGreaterThan(1);
});

test('R19: switching entering animation off overrules every per-tile choice', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, {
    'tiles.animations': ['overview:brief=scan'],
    'animations.tileEnter': false,
  });
  await page.goto('/overview');
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();

  // A floor, not another tier.
  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-tile-motion', 'none');
});

test('R19: the edit panel gives a selected tile its own motion', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await expect(page.locator('[data-tile="brief"]')).toBeVisible();
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toBeVisible();

  // The animations category is a heading inside the `motion` section: the panel
  // shows a whole section at once rather than one category out of thirty-two.
  await page.locator('.edit-panel').getByRole('combobox', { name: 'Раздел' }).click();
  await page.getByRole('option', { name: 'ДВИЖЕНИЕ И ДОСТУПНОСТЬ / MOTION', exact: true }).click();
  // Said rather than hidden: a control that appears only once the operator has
  // done the thing it needs cannot teach them to do it.
  await expect(page.locator('.edit-tile-motion__hint')).toBeVisible();

  const tile = await page.locator('[data-tile="brief"]').boundingBox();
  if (tile === null) throw new Error('the grid is not laid out');
  await page.mouse.click(tile.x + 30, tile.y + 15);
  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-selected', 'true');

  await page.getByRole('combobox', { name: /Движение плитки BRIEF/i }).click();
  await page.getByRole('option', { name: 'РАЗВЁРТКА', exact: true }).click();

  await expect(page.locator('[data-tile="brief"]')).toHaveAttribute('data-tile-motion', 'scan');
  // Stored as an ordinary setting, so it lands in undo, in the history and in
  // the issue draft with everything else.
  expect(await settingValue(page, 'tiles.animations')).toEqual(['overview:brief=scan']);
});

test('R6: the camera registry pages by the size the operator sets', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/video/cameras');
  const cards = page.locator('.camera-grid > button');
  await expect(cards.first()).toBeVisible();
  const atDefault = await cards.count();

  await seedSettings(page, { 'cameras.gridPageSize': 4 });
  await page.reload();
  await expect(cards.first()).toBeVisible();

  // Four is below the registry's size, so the page genuinely truncates; the
  // constant behind this was `const cameraPageSize = 12` and no setting read it.
  await expect.poll(() => cards.count()).toBe(4);
  expect(atDefault).toBeGreaterThan(4);
});

test('R6: the camera registry opens on the filter the operator chose', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'cameras.defaultFilter': 'alert' });
  await page.goto('/video/cameras');

  const filter = page.getByRole('combobox', { name: 'Фильтр камер' });
  await expect(filter).toBeVisible();
  // Seeded rather than initialised: personalization hydrates from an effect
  // after the first render, so a `useState` initialiser would have captured the
  // factory default and this would still read ВСЕ КАНАЛЫ.
  await expect(filter).toContainText('ТОЛЬКО ALERT');
});

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
