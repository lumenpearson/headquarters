import { getSettingDefinition } from '@gremuchaya/settings-schema';
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
 * Most cases run at 2560x1440. The status line clips what does not fit
 * (`overflow: hidden`, `white-space: nowrap`) and the header drops two metadata
 * entries below 1600px, so a narrow window hides these elements for reasons
 * that have nothing to do with the setting under test.
 *
 * The cases that measure geometry run on both sides of the 2500px breakpoint
 * instead, because one width is where a case went wrong: the geometry test
 * below seeded a body padding of 16px at 2560x1440, where the responsive block
 * already wrote 16px, and passed on the coincidence. It would have passed with
 * `sizes.panelPadding` deleted from the schema.
 */
const wide = { width: 2560, height: 1440 } as const;

/**
 * Both sides of the 2500px breakpoint.
 *
 * A responsive block that writes a number outranks the base rule reading the
 * setting, so a geometry case proves nothing unless it runs both where such a
 * block applies and where none does.
 */
const geometryViewports = [
  { label: '1920x1080', size: { width: 1920, height: 1080 } },
  { label: '2560x1440', size: wide },
] as const;

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

/*
 * The catalogue's number and the drawn one, on an untouched profile.
 *
 * A custom property is written only when the operator moves the setting, so the
 * default an operator actually sees is whatever the stylesheet falls back to.
 * Until 2026-08-27 the schema said a panel header is 31px while the design drew
 * 42: the catalogue showed a number no screen used, and the first press of the
 * stepper dropped the header from 42 to 32 — a jump nobody asked for. This case
 * is what keeps the two from drifting apart again.
 *
 * It runs below the wide breakpoint only. Above 2500px the design draws its own
 * 54px header and 16px padding, and one default cannot equal two responsive
 * values; that divergence is deliberate and recorded in the plan.
 */
test('R6: an untouched profile draws the numbers the catalogue shows', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/overview');
  await expect(page.locator('.ops-panel').first()).toBeVisible();

  const drawn = await panelMetrics(page);

  expect(drawn.headerMinHeight).toBe(`${schemaDefault('sizes.panelHeader')}px`);
  expect(drawn.bodyPadding).toBe(`${schemaDefault('sizes.panelPadding')}px`);
  expect(drawn.borderWidth).toBe(`${schemaDefault('sizes.borderWidth')}px`);
});

for (const viewport of geometryViewports) {
  test(`R6/R19: geometry settings resize the interface at ${viewport.label} without letting the page scroll`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport.size);
    await page.goto('/overview');
    await expect(page.locator('.ops-panel').first()).toBeVisible();
    const before = await panelMetrics(page);

    await seedSettings(page, {
      /*
       * Neither number is one `operations.css` writes for the role it moves.
       * The stylesheet gives a panel body 8, 11, 12 or 16 pixels of padding and
       * a header a minimum of 31, 42, 43 or 54, depending on the breakpoint;
       * seeding any of those lets a hardcoded declaration answer for the
       * setting. 19 and 46 sit inside the schema's ranges — 2..20 and 24..48 —
       * and outside both sets. 46 is also above the tallest header content at
       * either width, so the minimum decides the box rather than the title
       * inside it.
       *
       * `typography.letterSpacing` is seeded separately below rather than here:
       * it widens the header's own title, and a wider title would decide the
       * header's box in place of the height under test.
       */
      'sizes.panelHeader': 46,
      'sizes.panelPadding': 19,
      'sizes.borderWidth': 3,
      'colors.panelOpacity': 0.6,
    });
    await page.reload();
    await expect(page.locator('.ops-panel').first()).toBeVisible();
    await expect.poll(() => panelMetrics(page).then((metrics) => metrics.borderWidth)).toBe('3px');
    const after = await panelMetrics(page);

    // The header is asserted here, on both sides of the breakpoint. It used to
    // be exempted on the grounds that "the wide breakpoint sets its own" — true
    // of the stylesheet as it stood, and the defect itself: the responsive
    // block wrote 54px rather than reading `--ops-panel-header`, so the setting
    // reached the shell and stopped there.
    expect(after.headerMinHeight).toBe('46px');
    // The declared minimum and the drawn box, because only the second is what
    // the operator sees. The default is 42px below the breakpoint and 54px
    // above it, so one number moving the box in both directions is what says
    // the setting decided it.
    expect(after.headerHeight).toBe(46);
    expect(after.bodyPadding).toBe('19px');
    // Before and after, not after alone: a value already on the screen proves
    // nothing about the setting that claims to have put it there.
    expect(before.headerMinHeight).not.toBe(after.headerMinHeight);
    expect(before.headerHeight).not.toBe(after.headerHeight);
    expect(before.bodyPadding).not.toBe(after.bodyPadding);
    expect(before.borderWidth).toBe('1px');

    // The typography hook is asserted twice: that the property reaches the
    // shell, and that the shell's own text is spaced by it. The design sets its
    // own spacing on several descendants, so only the root is measured — but
    // measuring the property alone is what let a dead declaration pass, so the
    // ratio is read back from the computed style as well.
    await seedSettings(page, { 'typography.letterSpacing': 0.15 });
    await page.reload();
    await expect(page.locator('.ops-panel').first()).toBeVisible();
    await expect
      .poll(() => panelMetrics(page).then((metrics) => metrics.letterSpacingProperty))
      .toBe('0.15em');
    const spaced = await panelMetrics(page);
    expect(before.letterSpacingProperty).toBe('');
    expect(spaced.letterSpacingEm).toBeCloseTo(0.15, 3);
    expect(before.letterSpacingEm).toBeCloseTo(0.01, 3);
    // R19 asks for per-element size settings "within reason": the reason is that
    // the layout stays bounded, which is R26 and is the property that would break
    // first if a size setting were unbounded.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerHeight),
    );
  });

  test(`R19: both scale settings resize the shell's text at ${viewport.label}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport.size);
    await page.goto('/overview');
    await expect(page.locator('.ops-shell')).toBeVisible();
    const before = await shellFontSize(page);

    // The two settings reach the document as one bounded product, so each is
    // seeded on its own: a dead binding would otherwise hide behind the other.
    await seedSettings(page, { 'typography.scale': 1.2 });
    await page.reload();
    await expect.poll(() => typeScaleProperty(page)).toBe('1.2');
    expect(await shellFontSize(page)).toBeCloseTo(before * 1.2, 2);

    await seedSettings(page, { 'sizes.scale': 1.15 });
    await page.reload();
    await expect.poll(() => typeScaleProperty(page)).toBe('1.15');
    expect(await shellFontSize(page)).toBeCloseTo(before * 1.15, 2);
  });

  test(`R6: the tile gap the operator sets is the gap the grid draws at ${viewport.label}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport.size);
    await page.goto('/overview');
    await expect(page.locator('.tile-grid').first()).toBeVisible();
    const before = await tileGridGap(page);

    /*
     * 17 is inside the schema's 0..20 and is none of the numbers the stylesheet
     * writes for a laid-out screen — 7, 10, 12 and `--ops-content-gap`'s 6px
     * all appear on the layout classes, and 4 is the schema's own default, so
     * seeding any of them would let a declaration answer for the setting.
     *
     * The default itself is asserted below rather than assumed: this grid drew
     * `normal`, that is zero, until 2026-08-27, because `.tile-grid` sits later
     * in `operations.css` than every layout rule that gives it a gap.
     */
    await seedSettings(page, { 'sizes.tileGap': 17 });
    await page.reload();
    await expect(page.locator('.tile-grid').first()).toBeVisible();
    await expect.poll(() => tileGridGap(page).then((gap) => gap.rowGap)).toBe('17px');
    const after = await tileGridGap(page);

    expect(after.columnGap).toBe('17px');
    expect(before.rowGap).toBe(`${schemaDefault('sizes.tileGap')}px`);
    expect(before.columnGap).toBe(`${schemaDefault('sizes.tileGap')}px`);
  });

  test(`R6/R10: a shorter panel floor buys the screen more rows at ${viewport.label}`, async ({
    page,
  }) => {
    /*
     * `TileGrid` turns the box it was given into a number of rows, and until
     * 2026-08-27 it did so with a constant: 132px, "a 42px header plus 24px of
     * body padding", doubled so a tile carries at least as much content as
     * chrome. The three settings below own exactly those numbers and make that
     * floor anything between 30 and 94px, so a screen whose panels the operator
     * has made smaller is a screen with room for more rows.
     *
     * 24, 2 and 1 are the bottom of the schema's ranges and none of the numbers
     * `operations.css` writes for those roles at either width -- it draws a 31,
     * 42, 43 or 54px header and 8, 11, 12 or 16px of padding -- so no
     * declaration can answer for them (C51).
     */
    await page.setViewportSize(viewport.size);
    await page.goto('/overview');
    await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
    const before = await gridRowCount(page);
    const placedBefore = await page.locator('.tile-grid__cell').count();

    await seedSettings(page, {
      'sizes.panelHeader': 24,
      'sizes.panelPadding': 2,
      'sizes.borderWidth': 1,
    });
    await page.reload();
    await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
    // The premise: the panels really are shorter. A budget that grew while the
    // panels stayed put would be following something else.
    await expect
      .poll(() => panelMetrics(page).then((metrics) => metrics.headerMinHeight))
      .toBe('24px');

    await expect.poll(() => gridRowCount(page)).toBeGreaterThan(before);
    // What the rows are for: the tiles that did not fit now do.
    expect(await page.locator('.tile-grid__cell').count()).toBeGreaterThan(placedBefore);
    await expect(page.locator('.tile-grid__displaced')).toHaveCount(0);
  });
}

/*
 * The two cases below run at 1920x1080 alone, and the width is an argument
 * rather than a default.
 *
 * Above 2500px `operations.css` already draws a 54px header and 16px of body
 * padding, so the floor there is 88px against a schema maximum of 94 -- the
 * settings have almost nowhere left to push it, and both cases measure a
 * budget that does not move. Measured: at 2560x1440 the grid draws five rows
 * at the default geometry, five at 46/19/3 and five at a 20px gap. Below the
 * breakpoint the design's floor is 68px, and the same seeds move the budget
 * from five rows to four. The case above covers the wide window, in the
 * direction the schema leaves room for.
 */
const belowTheBreakpoint = { width: 1920, height: 1080 } as const;

test('R6/R10: taller panels leave the screen fewer rows', async ({ page }) => {
  await page.setViewportSize(belowTheBreakpoint);
  await page.goto('/overview');
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
  const before = await gridRowCount(page);
  // Stated rather than assumed: a screen already laid out in one row has
  // nothing to lose and would satisfy the comparison by starting at the floor.
  expect(before).toBeGreaterThan(1);

  // The numbers the geometry case above argues for: inside the schema's ranges
  // and outside every set `operations.css` writes.
  await seedSettings(page, {
    'sizes.panelHeader': 46,
    'sizes.panelPadding': 19,
    'sizes.borderWidth': 3,
  });
  await page.reload();
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
  await expect.poll(() => panelMetrics(page).then((metrics) => metrics.headerHeight)).toBe(46);

  await expect.poll(() => gridRowCount(page)).toBeLessThan(before);
});

test('R6/R10: the row budget leaves room for the gap between rows', async ({ page }) => {
  /*
   * `n` rows of `h` with `n - 1` gaps between them need `n * h + (n - 1) *
   * gap`. The gap was left out of that sum, which cost nothing while
   * `.tile-grid` drew no gap at all -- it drew `normal`, that is zero, until
   * `sizes.tileGap` reached the document on 2026-08-27 with a real 6px
   * default.
   *
   * 20 is the top of the schema's 0..20 and none of the numbers the stylesheet
   * writes for a laid-out screen. Unlike the header and the padding, the gap
   * has one default at every width -- `.tile-grid` declares it unconditionally
   * -- so one window answers for both sides of the breakpoint.
   */
  await page.setViewportSize(belowTheBreakpoint);
  await page.goto('/overview');
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
  const before = await gridRowCount(page);
  expect(before).toBeGreaterThan(1);

  await seedSettings(page, { 'sizes.tileGap': 20 });
  await page.reload();
  await expect(page.locator('.tile-grid__cell').first()).toBeVisible();
  await expect.poll(() => tileGridGap(page).then((gap) => gap.rowGap)).toBe('20px');

  // The panels are the height they always were; only the space between them
  // moved, so a budget that ignored it keeps a row it can no longer draw.
  await expect.poll(() => gridRowCount(page)).toBeLessThan(before);
});

/** How many rows the resolver asked the grid for, read off the grid itself. */
async function gridRowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector('.tile-grid');
    if (grid === null) throw new Error('no tile grid is laid out');
    return window.getComputedStyle(grid).gridTemplateRows.split(' ').length;
  });
}

async function tileGridGap(page: Page): Promise<{ rowGap: string; columnGap: string }> {
  return page.evaluate(() => {
    const grid = document.querySelector('.tile-grid');
    if (grid === null) throw new Error('no tile grid is laid out');
    const style = window.getComputedStyle(grid);
    return { rowGap: style.rowGap, columnGap: style.columnGap };
  });
}

test('R6: the focus ring is drawn at the width the operator set', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await expect(page.locator('.ops-shell')).toBeVisible();
  /*
   * A control and a link, because two different rules answer for the ring and
   * neither covers the other's elements. `body.terminal-theme button:focus-visible`
   * in terminal.css is (0,2,2) and outranks `.ops-shell button:focus-visible` in
   * operations.css, which is (0,2,1); operations.css is alone on `a`. Measuring
   * only the button would leave the second declaration unproven.
   *
   * Tab rather than `focus()`: the rules are written for `:focus-visible`, which
   * Chromium grants to keyboard focus and withholds from a programmatic one.
   */
  await page.keyboard.press('Tab');
  expect(await focusedOutlineWidth(page)).toBe('1px');
  await tabTo(page, '.ops-nav a');
  expect(await focusedOutlineWidth(page)).toBe('1px');

  await seedSettings(page, { 'accessibility.focusRingWidth': 3 });
  await page.reload();
  // The property arrives an effect after the first paint, and 3 is not a width
  // any rule writes, so waiting for it is what separates "the ring is thin" from
  // "the page has not hydrated yet".
  await expect.poll(() => shellProperty(page, '--ops-focus-ring-width')).toBe('3px');
  await page.keyboard.press('Tab');
  expect(await focusedOutlineWidth(page)).toBe('3px');
  await tabTo(page, '.ops-nav a');
  expect(await focusedOutlineWidth(page)).toBe('3px');
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
  headerMinHeight: string;
  bodyPadding: string;
  borderWidth: string;
  letterSpacingProperty: string;
  letterSpacingEm: number;
}> {
  return page.evaluate(() => {
    /*
     * The first panel whose header carries no control.
     *
     * `sizes.panelHeader` is a minimum, so a header holding a 31px button is
     * 46px tall whatever the minimum says, and measuring that one would report
     * no change however far the setting moved. Every other panel on /overview
     * has a title and nothing else, and its box is exactly the minimum.
     */
    const panel = [...document.querySelectorAll('.ops-panel')].find(
      (candidate) => candidate.querySelector('.ops-panel__header button') === null,
    );
    const header = panel?.querySelector('.ops-panel__header') ?? null;
    const body = panel?.querySelector('.ops-panel__body') ?? null;
    if (panel === undefined || header === null || body === null) {
      throw new Error('no panel is laid out');
    }
    const shell = window.getComputedStyle(document.querySelector('.ops-shell') as Element);
    const spacing = Number.parseFloat(shell.letterSpacing);
    return {
      headerHeight: Math.round(header.getBoundingClientRect().height),
      // Both the declared minimum and the drawn box. The minimum is what the
      // setting owns; the box is what the operator sees, and a rule that read
      // the setting under a taller content box would satisfy one and not the
      // other.
      headerMinHeight: window.getComputedStyle(header).minHeight,
      bodyPadding: window.getComputedStyle(body).paddingTop,
      borderWidth: window.getComputedStyle(panel).borderTopWidth,
      letterSpacingProperty: shell.getPropertyValue('--ops-letter-spacing').trim(),
      letterSpacingEm: Number.isFinite(spacing) ? spacing / Number.parseFloat(shell.fontSize) : 0,
    };
  });
}

/** The shell's own font size, which both scale settings multiply. */
function shellFontSize(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(
      window.getComputedStyle(document.querySelector('.ops-shell') as Element).fontSize,
    ),
  );
}

/** The bounded product of the two scale settings, as the shell publishes it. */
function typeScaleProperty(page: Page): Promise<string> {
  return page.evaluate(() =>
    window
      .getComputedStyle(document.querySelector('.ops-shell') as Element)
      .getPropertyValue('--ops-type-scale')
      .trim(),
  );
}

/** One custom property as the shell publishes it. */
function shellProperty(page: Page, property: string): Promise<string> {
  return page.evaluate(
    (name) =>
      window
        .getComputedStyle(document.querySelector('.ops-shell') as Element)
        .getPropertyValue(name)
        .trim(),
    property,
  );
}

/** Presses Tab until the keyboard lands on an element the selector matches. */
async function tabTo(page: Page, selector: string, limit = 40): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const landed = await page.evaluate(
      (css) => document.activeElement !== null && document.activeElement.matches(css),
      selector,
    );
    if (landed) return;
  }
  throw new Error(`the keyboard never reached ${selector}`);
}

/** The outline of whatever the keyboard has just focused. */
function focusedOutlineWidth(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'nothing is focused';
    return window.getComputedStyle(active).outlineWidth;
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
  await page.getByRole('option', { name: 'ДВИЖЕНИЕ И ДОСТУПНОСТЬ', exact: true }).click();
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

/**
 * Recorded rather than stubbed away: the page keeps every constraint object
 * `getUserMedia` was asked for, and answers with a canvas stream so nothing
 * touches real hardware. Asserting the call did *not* happen is the whole point
 * of `privacy.webcamCapture`, and that assertion is only worth making against a
 * real browser — a jsdom double can be made to report anything (§2.3).
 */
async function recordWebcamRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const requests: unknown[] = [];
    Object.defineProperty(window, '__webcamRequests', { value: requests });
    const media = { getUserMedia: undefined } as unknown as MediaDevices;
    Object.defineProperty(media, 'getUserMedia', {
      value: (constraints: unknown) => {
        requests.push(constraints);
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        return Promise.resolve(canvas.captureStream());
      },
    });
    Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true });
  });
}

function webcamRequests(page: Page): Promise<unknown[]> {
  return page.evaluate(
    () => (window as unknown as { __webcamRequests: unknown[] }).__webcamRequests,
  );
}

test('R6: the machine camera is asked for the size and rate the settings name', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await recordWebcamRequests(page);
  await seedSettings(page, {
    'performance.webcamResolution': '480p',
    'performance.webcamFrameRate': 12,
  });
  await page.goto('/video/cameras');

  const feed = page.locator('.video-main-feed');
  await expect(feed).toBeVisible();
  await feed.click();
  await page.keyboard.press('w');

  await expect.poll(() => webcamRequests(page).then((calls) => calls.length)).toBe(1);
  const [constraints] = await webcamRequests(page);
  // Three literals lived in this one object and none of them was a setting.
  expect(constraints).toMatchObject({
    video: {
      width: { ideal: 854 },
      height: { ideal: 480 },
      frameRate: { ideal: 12 },
    },
  });
});

test('R6: privacy.webcamCapture refuses the camera to the key as well as the button', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await recordWebcamRequests(page);
  await seedSettings(page, { 'privacy.webcamCapture': false });
  await page.goto('/video/cameras');

  const feed = page.locator('.video-main-feed');
  await expect(feed).toBeVisible();
  await expect(page.getByRole('button', { name: /WEBCAM|КАМЕРА МАШИНЫ/i }).first()).toBeDisabled();

  /*
   * The keyboard is the path that matters. Disabling the button alone would
   * promise a boundary the `w` key walks straight around, which is the defect
   * C33 records against `advanced.liveEdit`.
   */
  await feed.click();
  await page.keyboard.press('w');
  await page.waitForTimeout(250);
  expect(await webcamRequests(page)).toEqual([]);
});

test('R6: privacy.frameCapture refuses to write a surveillance frame to disk', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'privacy.frameCapture': false });
  await page.goto('/video/cameras');

  const snap = page.getByRole('button', { name: '[S] SNAP' });
  await expect(snap).toBeVisible();
  // A PNG of a live feed, stamped with a camera id and a wall-clock time, used
  // to reach the download folder with no confirmation and no way to refuse.
  await expect(snap).toBeDisabled();
});

test('R6: a feed opens muted by default, which is also what lets the wall auto-start', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/video/cameras');
  const video = page.locator('.video-main-feed video').first();
  await expect(video).toBeAttached();

  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
  // Browsers refuse unmuted autoplay without a gesture, so the default is what
  // makes an unattended wall start on its own. Asserted so that moving the
  // default later cannot quietly cost that.
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);
});

test('R6: player.startMuted opens the feed unmuted when the operator asks', async ({ page }) => {
  await page.setViewportSize(wide);
  // Seeded before the first navigation, not after: `addInitScript` runs on the
  // next document, and seeding between a `goto` and a `reload` leaves the
  // assertion measuring the page that booted without it.
  await seedSettings(page, { 'player.startMuted': false });
  await page.goto('/video/cameras');

  const video = page.locator('.video-main-feed video').first();
  await expect(video).toBeAttached();
  /*
   * Wait for the element to have loaded something before reading `muted`.
   * A bare `<video>` starts unmuted, and personalization arrives an effect
   * later, so polling for `false` from the moment of attach matches the very
   * first frame and passes however the setting is wired -- measured: it passed
   * against a hardcoded `?? true`.
   */
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThan(0);
  expect(await video.evaluate((el: HTMLVideoElement) => el.muted)).toBe(false);
});

test('R6: the map zoom controls move by the step the operator sets', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'map.zoomStep': 4, 'map.resetZoom': 7 });
  await page.goto('/map');

  const readout = page.locator('.map-toolbar, .map-controls').first();
  await expect(readout).toBeVisible();
  await page.getByRole('button', { name: '[R] RESET VIEW' }).click();
  // Reset first, so the step is measured from a level the setting decided.
  await expect.poll(() => zoomLevel(page)).toBe(7);

  await page
    .getByRole('button', { name: /\[\+\]/ })
    .first()
    .click();
  await expect.poll(() => zoomLevel(page)).toBe(11);
});

test('R6: the map shade and the camera feed take their grade from the settings', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/map');
  const shade = page.locator('.yandex-tactical-map__shade');
  await expect(shade).toBeAttached();
  // Nothing is emitted at the default, so the declaration resolves to the
  // initial value and the element looks exactly as it did.
  await expect.poll(() => shade.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  await seedSettings(page, { 'map.shadeOpacity': 0.2, 'cameras.feedBrightness': 0.5 });
  await page.reload();
  await expect(page.locator('.yandex-tactical-map__shade')).toBeAttached();
  await expect
    .poll(() =>
      page.locator('.yandex-tactical-map__shade').evaluate((el) => getComputedStyle(el).opacity),
    )
    .toBe('0.2');

  await page.goto('/video/cameras');
  const media = page.locator('.video-main-feed__media').first();
  await expect(media).toBeAttached();
  await expect
    .poll(() => media.evaluate((el) => getComputedStyle(el).filter))
    .toContain('brightness(0.5)');
});

test('R6: the camera telemetry overlay leaves the feed when the setting turns it off', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/video/cameras');
  await settled(page, 'data-camera-overlay', 'on');
  expect(await displayOf(page, '.video-overlay-left')).not.toBe('none');

  await seedSettings(page, { 'cameras.feedOverlay': false });
  await page.reload();
  await settled(page, 'data-camera-overlay', 'off');
  expect(await displayOf(page, '.video-overlay-left')).toBe('none');
});

function zoomLevel(page: Page): Promise<number> {
  return page.evaluate(() => {
    const match = /Z(\d+(?:\.\d+)?)/.exec(document.body.textContent ?? '');
    return match?.[1] === undefined ? Number.NaN : Number(match[1]);
  });
}

test('R6: the shell chrome settings each put their own element away', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await settled(page, 'data-brand-tagline', 'on');
  // Each is present at the default, so the assertions below cannot pass on an
  // element that was never there.
  expect(await displayOf(page, '.ops-brand small')).not.toBe('none');
  expect(await displayOf(page, '.ops-topbar__metadata .is-secure')).not.toBe('none');
  expect(await displayOf(page, '[data-header-entry="date"]')).not.toBe('none');
  expect(await displayOf(page, '.ops-topbar > time > span')).not.toBe('none');
  expect(await displayOf(page, '.ops-statusline__probe')).not.toBe('none');
  expect(await displayOf(page, '.ops-statusline [data-clock-label]')).not.toBe('none');
  expect(await displayOf(page, '.ops-statusline [data-keybind-hint]')).not.toBe('none');

  await seedSettings(page, {
    'general.brandTagline': false,
    'general.secureLinkBadge': false,
    'dateTime.showHeaderDate': false,
    'dateTime.showClockRate': false,
    'dateTime.showModeLabel': false,
    'diagnostics.showTransportProbe': false,
    'diagnostics.showKeybindHints': false,
  });
  await page.reload();
  await settled(page, 'data-brand-tagline', 'off');

  expect(await displayOf(page, '.ops-brand small')).toBe('none');
  expect(await displayOf(page, '.ops-topbar__metadata .is-secure')).toBe('none');
  expect(await displayOf(page, '[data-header-entry="date"]')).toBe('none');
  expect(await displayOf(page, '.ops-topbar > time > span')).toBe('none');
  expect(await displayOf(page, '.ops-statusline__probe')).toBe('none');
  expect(await displayOf(page, '.ops-statusline [data-clock-label]')).toBe('none');
  expect(await displayOf(page, '.ops-statusline [data-keybind-hint]')).toBe('none');

  // The bars themselves never leave: less chrome is not no header.
  await expect(page.locator('.ops-topbar')).toBeVisible();
  await expect(page.locator('.ops-statusline')).toBeVisible();
});

test('R6: dateTime.showSeconds shortens both clocks, in every mode', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  const header = page.locator('.ops-topbar > time > strong');
  // hh:mm:ss at the default.
  await expect.poll(() => header.textContent()).toMatch(/^\d{2}:\d{2}:\d{2}$/);

  for (const mode of ['operation', 'system', 'utc']) {
    await seedSettings(page, { 'dateTime.showSeconds': false, 'dateTime.mode': mode });
    await page.reload();
    // One argument reaches all three modes, so all three are asserted: the
    // operation clock is formatted by hand and the other two by Intl.
    await expect
      .poll(() => page.locator('.ops-topbar > time > strong').textContent())
      .toMatch(/^\d{2}:\d{2}$/);
  }
});

test('R6: styles.panelCorners decides when a panel shows its brackets', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  const corners = page.locator('.ops-panel__corners').first();
  await expect(corners).toBeAttached();
  // `hover` is the default and writes no rule, so the brackets start hidden.
  await expect.poll(() => corners.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

  await seedSettings(page, { 'styles.panelCorners': 'always' });
  await page.reload();
  // Nobody hovers a wall display, which is the case this exists for.
  await expect
    .poll(() =>
      page
        .locator('.ops-panel__corners')
        .first()
        .evaluate((el) => getComputedStyle(el).opacity),
    )
    .toBe('1');

  await seedSettings(page, { 'styles.panelCorners': 'never' });
  await page.reload();
  const panel = page.locator('.ops-panel').first();
  await panel.hover();
  // `never` has to beat the hover rule as well, which is why these rules are
  // written after it: all three are (0,2,0) and source order decides.
  await expect
    .poll(() =>
      page
        .locator('.ops-panel__corners')
        .first()
        .evaluate((el) => getComputedStyle(el).opacity),
    )
    .toBe('0');
});

test('R6: the shell decoration settings reach their own elements', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, {
    'styles.cornerLength': 22,
    'styles.signalFieldOpacity': 0.2,
    'styles.frameRules': false,
    'styles.workspaceSeam': false,
  });
  await page.goto('/overview');
  await settled(page, 'data-frame-rules', 'off');

  await expect
    .poll(() =>
      page
        .locator('.ops-panel__corners')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundSize),
    )
    .toContain('22px');
  await expect
    .poll(() => page.locator('.ops-shell__ascii').evaluate((el) => getComputedStyle(el).opacity))
    .toBe('0.2');
  expect(await displayOf(page, '.ops-shell__frame')).toBe('none');
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.ops-workspace') as Element, '::before').display,
    ),
  ).toBe('none');
});

test('R6: the camera-safe grade answers to its three dials and its token switch', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'gremuchaya-hq:operations:v3',
      JSON.stringify({
        version: 5,
        ui: {},
        production: { cameraSafe: true },
        personalization: {
          published: { revision: 0, values: {} },
          draft: {
            baseRevision: 0,
            values: { 'themes.cameraSafeSaturation': 0.2, 'themes.cameraSafeTokens': false },
            changedIds: ['themes.cameraSafeSaturation', 'themes.cameraSafeTokens'],
            history: [],
          },
          history: [],
          undoStack: [],
          redoStack: [],
        },
      }),
    );
  });
  await page.goto('/overview');
  const shell = page.locator('.ops-shell');
  await expect(shell).toHaveClass(/ops-shell--camera-safe/);

  // Saturation scales what the theme produced and can never name a hue, which
  // is the one dial R14 positively invites.
  await expect
    .poll(() => shell.evaluate((el) => getComputedStyle(el).filter))
    .toContain('saturate(0.2)');
  // With the tokens switched off the shell keeps the theme's own text colour
  // instead of the fixed greenish one camera-safe writes over it.
  await expect
    .poll(() => shell.evaluate((el) => getComputedStyle(el).getPropertyValue('--ops-text').trim()))
    .not.toBe('#9fb6a5');
});

test('R6: general.hiddenRoutes drops a route from the rail but never the settings way back', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  const rail = page.locator('.ops-nav');
  await expect(rail.locator('a[href="/analytics"]')).toBeVisible();

  await seedSettings(page, { 'general.hiddenRoutes': ['analytics', 'reports', 'settings'] });
  await page.reload();
  await expect(rail.locator('a[href="/analytics"]')).toHaveCount(0);
  await expect(rail.locator('a[href="/reports"]')).toHaveCount(0);

  /*
   * Settings refuses to be hidden. Everything else is recoverable from the
   * settings screen; hiding the way to that screen would leave the operator
   * with no route back except clearing the profile.
   */
  await expect(rail.locator('a[href="/settings"]')).toBeVisible();
});

test('R6: the system screen takes its thresholds and its counts from the settings', async ({
  page,
}) => {
  await page.setViewportSize(wide);

  /*
   * The journal is seeded rather than driven. A fresh profile holds one audit
   * entry, so `diagnostics.auditRows` would be unobservable — every count is
   * under every limit, and the assertion would pass whatever the setting did.
   * Seeded together with the settings because the blob is written whole: two
   * seeds would leave the second without a journal.
   */
  const seedWith = (values: Record<string, unknown>) =>
    page.addInitScript(
      ({ stored, entries }: { stored: Record<string, unknown>; entries: unknown }) => {
        window.localStorage.setItem(
          'gremuchaya-hq:operations:v3',
          JSON.stringify({
            version: 5,
            ui: {},
            production: {},
            audit: entries,
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
      },
      {
        stored: values,
        entries: Array.from({ length: 9 }, (_, index) => ({
          id: `audit-${String(index)}`,
          timestamp: new Date(Date.UTC(2026, 8, 12, 7, index)).toISOString(),
          action: `ДЕЙСТВИЕ ${String(index)}`,
          entityId: `E-${String(index)}`,
          operator: 'ОПЕРАТОР',
        })),
      },
    );

  await seedWith({});
  await page.goto('/system');
  await expect(page.locator('.resource-charts')).toBeVisible();
  // Stated before the change, so the count below cannot pass on a short list.
  await expect.poll(() => page.locator('.system-audit .audit-log > div').count()).toBe(9);

  await seedWith({
    'telemetry.showCharts': false,
    'telemetry.nodeTemperatureLimit': 40,
    'telemetry.signalFloorPercent': 90,
    'diagnostics.auditRows': 3,
  });
  await page.reload();
  await expect(page.locator('.ops-screen')).toBeVisible();

  // A TSX gate rather than `display: none`: the sparkline builds its point
  // string eagerly, so hiding it in CSS would keep paying for it.
  await expect(page.locator('.resource-charts')).toHaveCount(0);
  // The world clamps node temperature to 30..78 and signal to 8..100, so a
  // limit of 40 and a floor of 90 mark rows that were unmarked before.
  await expect.poll(() => page.locator('td.is-critical').count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.system-audit .audit-log > div').count()).toBe(3);
});

test('R6: keybinds.hiddenCategories drops a group from the shortcut list', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/settings');
  const list = page.locator('.keybind-list');
  await expect(list).toBeVisible();
  const atDefault = await list.locator('.keybind-list__group').count();
  expect(atDefault).toBeGreaterThan(1);

  await seedSettings(page, { 'keybinds.hiddenCategories': ['navigation'] });
  await page.reload();
  await expect(page.locator('.keybind-list')).toBeVisible();
  await expect
    .poll(() => page.locator('.keybind-list .keybind-list__group').count())
    .toBe(atDefault - 1);
});

test('R6: startup.productionPanel opens the panel on launch without the query flag', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  // Closed by default, and hydration forces it closed, so this cannot pass by
  // the panel simply never having been shut.
  await expect(page.locator('.production-panel')).toHaveCount(0);

  await seedSettings(page, { 'startup.productionPanel': true });
  await page.reload();
  await expect(page.locator('.production-panel')).toBeVisible();
});

test('R6: startup.restoreWorld decides whether the last session comes back', async ({ page }) => {
  await page.setViewportSize(wide);
  const seedWorld = (values: Record<string, unknown>) =>
    page.addInitScript(
      ({ stored }: { stored: Record<string, unknown> }) => {
        window.localStorage.setItem(
          'gremuchaya-hq:operations:v3',
          JSON.stringify({
            version: 5,
            ui: {},
            production: {},
            audit: [
              {
                id: 'audit-restored',
                timestamp: '2026-09-12T07:00:00.000Z',
                action: 'ВОССТАНОВЛЕННАЯ ЗАПИСЬ',
                entityId: 'E-1',
                operator: 'ОПЕРАТОР',
              },
            ],
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
      },
      { stored: values },
    );

  await seedWorld({});
  await page.goto('/system');
  await expect(page.locator('.system-audit')).toBeVisible();
  await expect(page.locator('.system-audit')).toContainText('ВОССТАНОВЛЕННАЯ ЗАПИСЬ');

  /*
   * Read from the blob being hydrated, not through the store: the values are
   * not in the store yet at that point, so a reader that went through it would
   * answer with the factory default on the one launch that matters.
   */
  await seedWorld({ 'startup.restoreWorld': false });
  await page.reload();
  await expect(page.locator('.system-audit')).toBeVisible();
  await expect(page.locator('.system-audit')).not.toContainText('ВОССТАНОВЛЕННАЯ ЗАПИСЬ');
});

test('R6: the drawer takes its width and its scrim from the settings', async ({ page }) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'popups.drawerWidth': 'wide', 'popups.drawerScrim': 'opaque' });
  await page.goto('/overview');
  // The alert button opens the drawer this styles.
  await page.getByRole('button', { name: /ALERT/ }).first().click();

  const drawer = page.locator('.ops-drawer');
  await expect(drawer).toBeVisible();
  /*
   * Class hooks rather than custom properties: the drawer is portalled outside
   * `.ops-shell`, where the `--ops-*` family is not declared at all.
   */
  await expect(drawer).toHaveClass(/ops-drawer--wide/);
  await expect(drawer).toHaveClass(/ops-drawer--scrim-opaque/);
  const width = await drawer.evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(420);
});

test('R6: popups.fieldMenu decides whether a text field keeps the browser menu', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'popups.fieldMenu': 'application' });
  await page.goto('/settings');

  const field = page.getByLabel('Поиск по настройкам');
  await expect(field).toBeVisible();
  await field.click({ button: 'right' });
  // The default yields the field to the browser, whose menu Playwright cannot
  // see; `application` is the operator asking for this one instead.
  await expect(page.locator('[role="menu"], .terminal-pointer-menu').first()).toBeVisible();
});

test('R25: the titlebar alignment decides where the bar puts its elements', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  await settled(page, 'data-titlebar-alignment', 'split');

  const bar = page.locator('.ops-titlebar');
  await expect(bar).toBeVisible();

  /*
   * The bar is one ordered row, so alignment is measured as where its elements
   * sit inside it rather than as a class on a container. `split` is the
   * arrangement a window title bar normally has: the name at the left edge and
   * the window commands against the right one, which is one auto margin on the
   * first control rather than two lists in the markup.
   */
  const geometry = () =>
    page.evaluate(() => {
      const element = document.querySelector('.ops-titlebar');
      const title = document.querySelector('.ops-titlebar__title');
      const close = document.querySelector('[data-titlebar-element="close"]');
      if (element === null || title === null || close === null) return null;
      const bounds = element.getBoundingClientRect();
      return {
        titleGap: title.getBoundingClientRect().left - bounds.left,
        closeGap: bounds.right - close.getBoundingClientRect().right,
        width: bounds.width,
      };
    });

  const split = await geometry();
  if (split === null) throw new Error('the title bar is not drawn');
  expect(split.titleGap).toBeLessThan(4);
  expect(split.closeGap).toBeLessThan(4);

  await seedSettings(page, { 'titlebar.alignment': 'center' });
  await page.reload();
  await settled(page, 'data-titlebar-alignment', 'center');
  const centred = await geometry();
  if (centred === null) throw new Error('the title bar is not drawn');
  // Centred: the row is pulled in from both edges by roughly the same amount.
  expect(centred.titleGap).toBeGreaterThan(split.titleGap);
  expect(Math.abs(centred.titleGap - centred.closeGap)).toBeLessThan(4);

  await seedSettings(page, { 'titlebar.alignment': 'right' });
  await page.reload();
  await settled(page, 'data-titlebar-alignment', 'right');
  const right = await geometry();
  if (right === null) throw new Error('the title bar is not drawn');
  expect(right.closeGap).toBeLessThan(4);
  expect(right.titleGap).toBeGreaterThan(centred.titleGap);
});

test('R25: an emptied roster stops at the shell window and never at a display one', async ({
  page,
}) => {
  // Not a value any default coincides with: the schema ships the whole roster
  // (C51). An empty list is the arrangement that leaves a window with no way
  // out of itself, and it is accepted on exactly one of the two windows.
  await seedSettings(page, { 'titlebar.elements': [] });

  await page.goto('/overview');
  // The exported markup draws all five, so reaching zero is proof the stored
  // roster arrived rather than proof of a page that had not hydrated yet.
  await expect(page.locator('.ops-titlebar [data-titlebar-element]')).toHaveCount(0);

  await page.goto('/screen/wall-center/');
  /*
   * Same blob, same origin, other window. The wait is on the runtime becoming
   * ready, which the exported HTML never is: it proves client React ran, and
   * the mount effect that hydrates the stored settings ran in the same commit.
   * Without it this assertion would be satisfied by the static markup and would
   * pass with the roster wired straight into the display bar.
   */
  await expect(page.locator('.screen-route__content')).toBeVisible();
  await expect(page.locator('.ops-titlebar--managed [data-titlebar-element]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Закрыть окно' })).toBeVisible();
});

test('R24: the title bar takes a row of the window rather than covering one', async ({ page }) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');

  const boxes = await page.evaluate(() =>
    // The five rows of the shell, top to bottom. The navigation is a row and
    // not a rail: the Signal Mesh grid is one column wide.
    ['.ops-titlebar', '.ops-topbar', '.ops-nav', '.ops-workspace', '.ops-statusline'].map(
      (selector) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
      },
    ),
  );

  /*
   * R26 bounds the workspace by what is left of the window, so the bar has to
   * be a row of the grid rather than something drawn over one: an overlay
   * would take its height from nothing and the workspace would keep the space
   * the bar is standing on.
   *
   * The five rows are therefore asserted to tile the window — each starting
   * where the one before ends, and the last ending at the bottom edge. Their
   * heights summing to the viewport is what rules out both faults at once: an
   * overlap means the bar is covering a row, and a gap is the unexplained empty
   * grid area R26 forbids.
   */
  let filled = 0;
  for (const [index, box] of boxes.entries()) {
    if (box === null) throw new Error(`the shell is missing row ${index}`);
    expect(box.height).toBeGreaterThan(0);
    filled += box.height;
    const next = boxes[index + 1];
    if (next !== null && next !== undefined) expect(next.top).toBeGreaterThanOrEqual(box.bottom);
  }
  expect(boxes[0]?.top).toBe(0);
  expect(boxes.at(-1)?.bottom).toBeCloseTo(1440, 0);
  expect(filled).toBeCloseTo(1440, 0);

  // Tiling alone would also be satisfied by a shell that gave the bar the row
  // the workspace was meant to have. The workspace is the `1fr` track, so it
  // takes more of the window than all four chrome rows together.
  const workspace = boxes[3]?.height ?? 0;
  expect(workspace).toBeGreaterThan(filled - workspace);
});

/**
 * R28's second half, on the screen rather than in the field it was typed into.
 *
 * `localization.elementOverrides` had no reader at all: a caption committed in
 * edit mode came back to the same input and appeared nowhere else, so the
 * requirement was observable on no screen in the application. These cases seed
 * the stored list and read the heading the operator actually looks at.
 *
 * The caption seeded is a phrase no screen ships and no stylesheet writes, so
 * none of these can pass by coinciding with a default (C51).
 */
const shiftBrief = 'СВОДКА СМЕНЫ';
const briefEntry = (locale: string): string =>
  `${locale}:overview:brief=${encodeURIComponent(shiftBrief)}`;

function briefHeading(page: Page) {
  return page.locator('.ops-panel.overview-brief .ops-panel__header h2');
}

test('R28: a caption the operator wrote stands on the tile instead of the shipped title', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await page.goto('/overview');
  // The shipped title first, so the assertion below is a change and not a
  // reading that was already true.
  await expect(briefHeading(page)).toHaveText('ОБЗОР ОПЕРАЦИИ');

  await seedSettings(page, { 'localization.elementOverrides': [briefEntry('ru')] });
  await page.reload();

  await expect(briefHeading(page)).toHaveText(shiftBrief);
  // The heading, not a second element added beside it: a rename that left the
  // original standing would be two names for one panel.
  await expect(page.getByText('ОБЗОР ОПЕРАЦИИ', { exact: true })).toHaveCount(0);
});

test('R28: an empty list leaves every tile with the caption the application ships', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  await seedSettings(page, { 'localization.elementOverrides': [] });
  await page.goto('/overview');

  await expect(briefHeading(page)).toHaveText('ОБЗОР ОПЕРАЦИИ');
});

test('R28: a caption written in the other language does not reach this one', async ({ page }) => {
  await page.setViewportSize(wide);
  // Stored under `en`, read in a `ru` session — the locale default. A resolver
  // that ignored the locale would put the English wording on a Russian screen,
  // and the per-locale address the caption is stored under would buy nothing.
  await seedSettings(page, { 'localization.elementOverrides': [briefEntry('en')] });
  await page.goto('/overview');

  await expect(briefHeading(page)).toHaveText('ОБЗОР ОПЕРАЦИИ');

  // The same entry, once the session is in the language it was written for.
  await seedSettings(page, {
    'localization.elementOverrides': [briefEntry('en')],
    'localization.locale': 'en',
  });
  await page.reload();

  await expect(briefHeading(page)).toHaveText(shiftBrief);
});

test('R28: a caption belongs to the screen it was written on, not to the tile name', async ({
  page,
}) => {
  await page.setViewportSize(wide);
  // `registry` is the table on four screens. A caption stored against the
  // cases registry must not rename the objects registry.
  await seedSettings(page, {
    'localization.elementOverrides': [`ru:cases:registry=${encodeURIComponent('ДОСЬЕ СМЕНЫ')}`],
  });
  await page.goto('/cases');
  await expect(page.locator('.ops-panel[data-panel] .ops-panel__header h2').first()).toBeVisible();
  await expect(page.getByText('ДОСЬЕ СМЕНЫ', { exact: true })).toHaveCount(1);

  await page.goto('/objects');
  await expect(page.locator('.ops-panel[data-panel] .ops-panel__header h2').first()).toBeVisible();
  await expect(page.getByText('ДОСЬЕ СМЕНЫ', { exact: true })).toHaveCount(0);
});

/** The declared default, read from the schema rather than repeated here. */
function schemaDefault(
  id: 'sizes.panelHeader' | 'sizes.panelPadding' | 'sizes.borderWidth' | 'sizes.tileGap',
): number {
  const definition = getSettingDefinition(id);
  if (definition === undefined) throw new Error(`no setting is declared as ${id}`);
  const value = definition.defaultValue;
  if (typeof value !== 'number') throw new Error(`${id} does not default to a number`);
  return value;
}
