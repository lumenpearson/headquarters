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
