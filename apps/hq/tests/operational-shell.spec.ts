import { readFile, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { expect, test, type Page } from '@playwright/test';
import type { BridgeConfig } from '@gremuchaya/config';
import { createVirtualPath } from '@gremuchaya/domain';
import { FileBridgeService } from '@gremuchaya/protocol';

import { startBridge } from '../../file-bridge/src/server.js';
import {
  gotoSettingsUnified,
  optionByValue,
  settingControl,
  settingRow,
  shippedText,
} from './settingsHelpers';

test('boots the unified operational world and opens a linked object', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ops-shell')).toBeVisible();
  await expect(page.locator('.ops-brand strong')).toHaveText('ГРЕМУЧАЯ//MESH');
  await expect(page.getByRole('heading', { name: /СВОДКА ОПЕРАЦИИ/ })).toBeVisible();
  await page.getByRole('button', { name: 'ПОТЕРЯ СИГНАЛА 1', exact: true }).click();
  await expect(page).toHaveURL(/\/objects\/K-17/);
  await expect(page.locator('.ops-topbar__route strong')).toHaveText('КАРТОЧКА ОБЪЕКТА');
});

test('keeps map, camera and drawer interactions connected', async ({ page }) => {
  await page.goto('/map');
  await expect(page.locator('.yandex-tactical-map')).toBeVisible();
  await expect(page.getByLabel('Ключ Yandex Maps API v3')).toHaveClass(/terminal-input/);
  await expect(page.getByText(shippedText('yandexMap.keyRequiredHeading'))).toBeVisible();
  await expect(page.getByRole('button', { name: '[APPLY] ПОДКЛЮЧИТЬ' })).toHaveClass(
    /terminal-button/,
  );
  await expect(page.locator('.map-selected-object')).toContainText('K-17');
  await page.getByRole('button', { name: /ВИДЕО/ }).click();
  await expect(page).toHaveURL(/\/video\/cameras/);
  await expect(page.locator('.camera-grid')).toBeVisible();
  await expect(page.locator('.camera-grid > button')).toHaveCount(12);
  await page.locator('.camera-grid > button').first().click();
  await expect(page.locator('.video-channel-info')).toBeVisible();
});

test('loads the Yandex Maps JavaScript API v3 endpoint and retains its no-provider fallback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('gremuchaya-hq:yandex-maps-v3-api-key', 'test-v3-key');
  });
  await page.route('https://api-maps.yandex.ru/v3/**', async (route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: 'window.ymaps3 = { ready: Promise.resolve() };',
    });
  });

  await page.goto('/map');
  await expect(page.locator('script#yandex-maps-api-v3')).toHaveAttribute(
    'src',
    /api-maps\.yandex\.ru\/v3\/\?apikey=test-v3-key&lang=ru_RU/,
  );
  await expect(page.locator('.yandex-tactical-map__fallback')).toBeVisible();
  await expect(page.getByText(shippedText('yandexMap.providerUnavailableHeading'))).toBeVisible();
});

test('runs the Vidstack surveillance player and keeps the 720p matrix horizontal-scroll free', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/video');
  await expect(page.locator('.video-main-feed video')).toBeVisible();
  await expect(page.locator('.camera-grid > button')).toHaveCount(12);
  await page.getByRole('button', { name: '[Ⅱ] PAUSE', exact: true }).click();
  await expect(page.locator('.video-timecode')).toContainText('PAUSE');
  await page.locator('.camera-grid > button').nth(1).click();
  await expect(page.locator('.video-main-feed > header')).toContainText('CAM-02');
  await expect
    .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test('operates playback and PTZ through typed Base UI media controls', async ({ page }) => {
  await page.goto('/video');
  await page.getByRole('button', { name: '[Ⅱ] PAUSE', exact: true }).click();

  const playbackRate = page.getByRole('combobox', { name: 'Скорость воспроизведения' });
  await playbackRate.click();
  await page.getByRole('option', { name: '2×', exact: true }).click();
  await expect(playbackRate).toContainText('2×');
  await expect(page.locator('.video-timecode')).toContainText('2×');

  const volume = page.getByRole('slider', { name: 'Громкость' });
  await expect(volume).toHaveAttribute('aria-valuenow', '35');
  await volume.press('ArrowRight');
  await expect(volume).toHaveAttribute('aria-valuenow', '40');

  const position = page.getByRole('slider', { name: 'Позиция видеопотока' });
  const positionBefore = Number(await position.getAttribute('aria-valuenow'));
  await position.press('ArrowRight');
  await expect
    .poll(async () => Number(await position.getAttribute('aria-valuenow')))
    .toBeGreaterThan(positionBefore);

  await page.goto('/video/cameras');
  const ptzSpeed = page.getByRole('slider', { name: 'PTZ SPEED' });
  const speedBefore = Number(await ptzSpeed.getAttribute('aria-valuenow'));
  await ptzSpeed.press('ArrowRight');
  await expect
    .poll(async () => Number(await ptzSpeed.getAttribute('aria-valuenow')))
    .toBeGreaterThan(speedBefore);
  await page.getByRole('button', { name: '▲', exact: true }).click();
  await expect(page.locator('.ptz-panel footer')).not.toContainText('TILT 0');
});

test('pages and filters the complete camera registry without decoding hidden feeds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/video/cameras');

  await expect(page.locator('.camera-grid > button')).toHaveCount(12);
  await expect(page.locator('.registry-pagination')).toContainText('СТРАНИЦА 01 / 02');
  await page.getByRole('button', { name: 'NEXT [▶]', exact: true }).click();
  await expect(page.locator('.camera-grid > button')).toHaveCount(4);
  await expect(page.locator('.camera-grid')).toContainText('CAM-15');

  const filter = page.getByRole('combobox', { name: 'Фильтр камер' });
  await filter.click();
  await page.getByRole('option', { name: 'ПОТЕРЯ СИГНАЛА', exact: true }).click();
  await expect(page.locator('.camera-grid > button')).toHaveCount(1);
  await expect(page.locator('.camera-grid')).toContainText('CAM-14');
  await expect(page.locator('.registry-pagination')).toContainText('СТРАНИЦА 01 / 01');
  await expect(page.locator('.camera-grid-query-summary')).toContainText('HIDDEN FEEDS');
  await page.getByRole('button', { name: /Камера CAM-14:/ }).click();
  await expect(page.locator('.video-channel-info')).toContainText('CAM-14');
  await expect(page.locator('.video-channel-info')).toContainText('DEMO_VIDEO');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement;
        return (
          root !== null &&
          root.scrollHeight === root.clientHeight &&
          root.scrollWidth === root.clientWidth
        );
      }),
    )
    .toBe(true);
});

test('uses a webcam only after explicit local permission and returns to the demo source', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext('2d');
          context?.fillRect(0, 0, canvas.width, canvas.height);
          return canvas.captureStream(5);
        },
      },
    });
  });
  await page.goto('/video');

  const webcamButton = page.getByRole('button', { name: '[W] WEBCAM', exact: true });
  await webcamButton.click();
  await expect(page.getByRole('button', { name: '[W] STOP CAM', exact: true })).toBeVisible();
  await expect(page.locator('.video-channel-info')).toContainText('WEBCAM');
  await expect(page.locator('.video-main-feed > header')).toContainText('LOCAL WEBCAM');

  await page.getByRole('button', { name: '[W] STOP CAM', exact: true }).click();
  await expect(page.getByRole('button', { name: '[W] WEBCAM', exact: true })).toBeVisible();
  await expect(page.locator('.video-channel-info')).toContainText('DEMO_VIDEO');
});

test('restores and clears a per-channel local material assignment without persisting a runtime URL', async ({
  page,
}) => {
  const materialId = '018f0f1a-8000-7000-8000-000000000000';
  await page.addInitScript((persistedMaterialId) => {
    window.localStorage.setItem(
      'hq.camera-material-assignments.v1',
      JSON.stringify({ 'K-17': persistedMaterialId }),
    );
  }, materialId);
  await page.goto('/video');

  const sourceSelect = page.getByRole('combobox', { name: 'Источник выбранного канала' });
  await expect(sourceSelect).toContainText('[MISSING] 018f0f1a-80');
  await sourceSelect.click();
  await page.getByRole('option', { name: '[DEMO] SURVEILLANCE LOOP', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem('hq.camera-material-assignments.v1')),
    )
    .toBe('{}');
  await expect(sourceSelect).toContainText('[DEMO] SURVEILLANCE LOOP');
});

test('streams an oversized local video through a revocable browser range grant', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'gremuchaya-browser-range-'));
  const config: BridgeConfig = {
    version: 1,
    transport: 'grpc-web',
    port: 0,
    readOnly: false,
    allowedOrigins: ['http://127.0.0.1:3000'],
    mounts: [
      {
        id: 'materials',
        label: 'МАТЕРИАЛЫ',
        root,
        virtualPath: createVirtualPath('/МАТЕРИАЛЫ'),
      },
    ],
    stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
    watchDebounceMs: 25,
    materialImport: {
      enabled: true,
      maxFileBytes: 64 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
    },
  };
  const running = await startBridge(config);
  try {
    const address = running.server.address() as AddressInfo;
    const bridgeOrigin = `http://127.0.0.1:${address.port}`;
    const client = createClient(
      FileBridgeService,
      createGrpcWebTransport({ baseUrl: bridgeOrigin, useBinaryFormat: true }),
    );
    const bundledVideo = await readFile(
      join(process.cwd(), 'public', 'assets', 'video', 'surveillance-k17.webm'),
    );
    const bytes = Buffer.alloc(33 * 1024 * 1024);
    bundledVideo.copy(bytes);
    const started = await client.beginMaterialImport({
      mountId: 'materials',
      fileName: 'phase6-range-camera.webm',
      declaredMimeType: 'video/webm',
      totalSize: BigInt(bytes.byteLength),
      expectedBlake3: '',
    });
    if (started.session === undefined) throw new Error('Expected browser-range import session.');
    for (let offset = 0; offset < bytes.byteLength; offset += started.session.chunkSize) {
      const data = bytes.subarray(offset, offset + started.session.chunkSize);
      await client.uploadMaterialChunk({
        uploadId: started.session.uploadId,
        offset: BigInt(offset),
        data,
      });
    }
    const completed = await client.completeMaterialImport({ uploadId: started.session.uploadId });
    if (completed.material === undefined) throw new Error('Expected browser-range material.');

    await page.route('http://127.0.0.1:4177/**', async (route) => {
      const requested = new URL(route.request().url());
      const proxied = await route.fetch({
        url: `${bridgeOrigin}${requested.pathname}${requested.search}`,
      });
      await route.fulfill({ response: proxied });
    });
    await page.addInitScript((materialId) => {
      window.localStorage.setItem(
        'hq.camera-material-assignments.v1',
        JSON.stringify({ 'K-17': materialId }),
      );
    }, completed.material.materialId);
    await page.goto('/video');

    const sourceSelect = page.getByRole('combobox', { name: 'Источник выбранного канала' });
    await expect(sourceSelect).toContainText('[FILE] phase6-range-camera.webm');
    await expect(page.locator('.camera-material-status')).toContainText('RANGE STREAM READY');
    await expect.poll(() => running.activePlaybackGrantCount()).toBe(1);

    await sourceSelect.click();
    await page.getByRole('option', { name: '[DEMO] SURVEILLANCE LOOP', exact: true }).click();
    await expect.poll(() => running.activePlaybackGrantCount()).toBe(0);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('synchronizes demo playback between local browser sessions without syncing media URLs', async ({
  context,
  page,
}) => {
  const follower = await context.newPage();
  await page.goto('/video');
  await follower.goto('/video');

  await expect(page.locator('.playback-sync-status')).toContainText('SYNC / ACTIVE');
  await expect(follower.locator('.playback-sync-status')).toContainText('SYNC / ACTIVE');
  await page.getByRole('button', { name: '[Ⅱ] PAUSE', exact: true }).click();

  await expect(follower.getByRole('button', { name: '[▶] PLAY', exact: true })).toBeVisible();
  await expect(follower.locator('.playback-sync-status')).toContainText('SYNC / ACTIVE');
  await follower.close();
});

test('renders static screen and scene routes without a white flash', async ({ page }) => {
  await page.goto('/screen/wall-center/');
  await expect(page.locator('.screen-route')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(3, 3, 3)');
  await page.goto('/scene/s08-31/');
  await expect(page.locator('[data-scene-route="s08-31"]')).toBeVisible();
});

/**
 * R24 on the nine windows `open_screen_window` creates.
 *
 * They are built with the frame off, and until this change the route inside
 * them drew no bar: on the second monitor that is a window the operator cannot
 * close without going back to the machine. A browser cannot open one -- the
 * command belongs to the native shell -- so what these cases hold is the half
 * that lives in the page: the control is there on every display route, it is
 * reachable by keyboard, and the bar is a row rather than something laid over
 * the route (R26). That the operating system then destroys the window is
 * asserted where the IPC boundary can be watched, in `TitleBar.test.tsx`.
 */
for (const [route, content] of [
  ['/screen/wall-center/', '.screen-route'],
  ['/wall/hq-standard/', '.wall-route'],
] as const) {
  test(`R24: the display window at ${route} carries a way out of itself`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator(content)).toBeVisible();

    const close = page.getByRole('button', { name: 'Закрыть окно' });
    await expect(close).toBeVisible();
    await expect(page.getByRole('button', { name: 'Свернуть окно' })).toBeVisible();
    // A wall screen is watched more often than it is clicked on, and the
    // machine driving it may have no pointer within reach of that monitor.
    await close.focus();
    await expect(close).toBeFocused();

    const layout = await page.evaluate((selector) => {
      const bar = document.querySelector('.ops-titlebar--managed');
      const main = document.querySelector(selector);
      if (bar === null || main === null) throw new Error('the display window is missing a row');
      return {
        bar: bar.getBoundingClientRect(),
        main: main.getBoundingClientRect(),
        documentY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        documentX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, content);

    // Two rows tiling the window: the bar from the top edge, the route from
    // where the bar ends to the bottom. An overlay would satisfy neither, and
    // a bar that pushed the route down would show as a scrolling document.
    expect(layout.bar.top).toBe(0);
    expect(layout.bar.height).toBeGreaterThan(0);
    expect(layout.main.top).toBeCloseTo(layout.bar.bottom, 0);
    expect(layout.main.bottom).toBeCloseTo(900, 0);
    expect(layout.documentY).toBe(0);
    expect(layout.documentX).toBe(0);
    // Edge to edge as well as top to bottom. The shell's bar is placed by a
    // `grid-area` naming two columns, and a display route has one: carrying
    // that placement over insets the row and takes the close control out of
    // the corner the operator reaches for.
    expect(layout.bar.left).toBe(0);
    expect(layout.bar.width).toBeCloseTo(1440, 0);
  });
}

test('R24: a display window whose runtime never boots can still be closed', async ({ page }) => {
  /*
   * The state the bar is most needed in, and the one it would have been
   * missing from had it been drawn inside the ready branch: the route has
   * nothing to show, and the window is standing on a monitor whose operator is
   * somewhere else. Refusing the project configuration is how the boot is made
   * to fail without waiting for anything to time out.
   */
  await page.route('**/runtime/project.default.json', (route) => route.abort());
  await page.goto('/screen/wall-center/');

  await expect(page.locator('.screen-route--loading')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Закрыть окно' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Свернуть окно' })).toBeVisible();
});

test('opens production controls and restores a local continuity snapshot', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+KeyP');
  await expect(page.locator('.production-panel')).toBeVisible();
  const preset = page.getByRole('combobox', { name: 'Сценарный preset' });
  await preset.click();
  await page.getByRole('option', { name: 'ALERT', exact: true }).click();
  await expect(preset).toContainText('ALERT');
  await expect(page.getByRole('switch', { name: 'CAMERA SAFE MODE' })).toBeVisible();
  await page.getByRole('button', { name: /СОХРАНИТЬ СОСТОЯНИЕ СЦЕНЫ/ }).click();
  await expect(page.locator('.production-panel__snapshots article')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.production-panel')).toBeHidden();
});

test('keeps terminal geometry and keyboard workflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ops-shell')).toBeVisible();
  await expect(page.locator('.ops-shell')).toHaveAttribute('data-transport', 'grpc-web');
  await expect(page.locator('body')).toHaveClass(/terminal-theme/);
  await expect(page.locator('.ops-nav a.is-active')).toContainText('[01]');
  await expect(page.locator('.ops-statusline strong')).toContainText('SYSTEM:READY');
  await expect(page.locator('.ops-panel').first()).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.ops-screen__title > div').first().locator('span')).toHaveCSS(
    'color',
    'rgb(255, 61, 0)',
  );
  await page.keyboard.press('Control+KeyK');
  await expect(page).toHaveURL(/\/search/);
  await expect(page.locator('.search-command input')).toBeFocused();
  await page.locator('.search-command input').fill('K-17');
  await expect(page.locator('.search-hit-list')).toContainText('K-17');
});

test('uses the terminal Base UI adapters for tooltip and drawer behavior', async ({ page }) => {
  await page.goto('/dev/ui');

  const tooltipTrigger = page.getByRole('button', { name: '[?] TOOLTIP', exact: true });
  // Hovering is a single pointer move, so if it lands before the catalog hydrates
  // nothing ever moves the pointer again and the tooltip stays closed. Leave the
  // trigger and re-enter it until Base UI answers.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await tooltipTrigger.hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole('tooltip')).toHaveText('Терминальная подсказка без скруглений');
  await expect(page.getByRole('tooltip')).toHaveCSS('border-radius', '0px');

  const drawerTrigger = page.getByRole('button', { name: '[D] ОТКРЫТЬ ПРИМЕР', exact: true });
  await drawerTrigger.click();
  await expect(page.getByRole('dialog', { name: 'Потеря сигнала K-17' })).toBeVisible();
  await expect(page.locator('.ops-drawer')).toHaveCSS('border-radius', '0px');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ops-drawer')).toBeHidden();
  await expect(drawerTrigger).toBeFocused();
});

test('operates dialog, menu, context menu and toast through project wrappers', async ({ page }) => {
  await page.goto('/dev/ui');

  const dialogTrigger = page.getByRole('button', { name: '[DIALOG] OPEN', exact: true });
  await dialogTrigger.click();
  await expect(page.getByRole('dialog', { name: 'ПРОВЕРКА КОНТУРА' })).toBeVisible();
  await expect(page.locator('.terminal-dialog')).toHaveCSS('border-radius', '0px');
  await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-dialog')).toBeHidden();
  await expect(dialogTrigger).toBeFocused();

  await page.getByRole('button', { name: '[TOAST] READY', exact: true }).click();
  await expect(page.locator('.terminal-toast').filter({ hasText: 'СИСТЕМА ГОТОВА' })).toBeVisible();

  await page.getByRole('button', { name: '[MENU] ACTIONS', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: /ПРОВЕРИТЬ КОНТУР/ }).click();
  await expect(
    page.locator('.terminal-toast').filter({ hasText: 'КОНТУР ПРОВЕРЕН' }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: '[CONTEXT] TARGET', exact: true })
    .click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Контекстные действия контура' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-context-menu')).toBeHidden();
});

test('persists settings through Base UI switch, select and input adapters', async ({ page }) => {
  await gotoSettingsUnified(page);

  const animations = page.getByRole('switch', { name: 'Анимации' });
  await expect(animations).toBeChecked();
  await animations.click();
  await expect(animations).not.toBeChecked();

  const cursorMode = page.getByRole('combobox', {
    name: shippedText('settings.cursorModeSelectLabel'),
  });
  await cursorMode.click();
  await optionByValue(page, 'hidden').click();
  await expect(cursorMode).toContainText(shippedText('settings.cursorModeHidden'));

  const fixedTime = page.getByRole('textbox', { name: 'Фиксированное время' });
  await fixedTime.fill('13:37:42');
  await page.reload();

  await expect(page.getByRole('switch', { name: 'Анимации' })).not.toBeChecked();
  await expect(
    page.getByRole('combobox', { name: shippedText('settings.cursorModeSelectLabel') }),
  ).toContainText(shippedText('settings.cursorModeHidden'));
  await expect(page.getByRole('textbox', { name: 'Фиксированное время' })).toHaveValue('13:37:42');
  await expect(page.locator('.settings-row select')).toHaveCount(0);
});

test('keeps settings overflow inside its own pane at 720p', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoSettingsUnified(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement;
        return root?.scrollHeight === root?.clientHeight;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .locator('.settings-docs__content')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.locator('.ops-workspace').evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('hidden');
});

test('renders the full safe personalization catalogue and resets one selected category', async ({
  page,
}) => {
  await gotoSettingsUnified(page);

  // The catalogue is grouped now — thirty-three categories in one list stopped
  // being readable well before the 168 definitions R6 asks for — but the
  // category list stays complete and moves the section to match. A section that
  // could hide a category the operator was looking for would be worse than no
  // section at all.
  const category = page.getByRole('combobox', { name: 'Категория персонализации' });
  await category.click();
  await expect(page.getByRole('option', { name: 'АНИМАЦИИ', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'МАТЕРИАЛЫ', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'РАСШИРЕННЫЕ', exact: true })).toBeVisible();
  await page.getByRole('option', { name: 'АНИМАЦИИ', exact: true }).click();

  const enabled = settingControl(page, 'animations.enabled', 'switch');
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await page.getByRole('button', { name: '[R] СБРОСИТЬ КАТЕГОРИЮ', exact: true }).click();
  await expect(enabled).toBeChecked();
  await expect(settingControl(page, 'animations.intensity', 'textbox')).toBeVisible();
});

test('round-trips a schema-validated settings draft through the terminal import control', async ({
  page,
}) => {
  await gotoSettingsUnified(page);

  const downloadReady = page.waitForEvent('download');
  await page
    .getByRole('button', { name: shippedText('settings.exportJsonButton'), exact: true })
    .click();
  const download = await downloadReady;
  const path = await download.path();
  if (path === null) throw new Error('Settings export did not produce a local file.');

  await page.locator('#settings-import-file').setInputFiles(path);
  await expect(page.locator('.settings-import-status')).toContainText(
    shippedText('settings.importSuccessStatus').replace('{fileName}', '').trim(),
  );
});

test('keeps local settings history filterable and reversible inside its own settings pane', async ({
  page,
}) => {
  await gotoSettingsUnified(page);

  const theme = settingControl(page, 'themes.id', 'combobox');
  await theme.click();
  await optionByValue(page, 'cold-cyan').click();
  await expect(page.locator('.settings-history-row').first()).toContainText(
    shippedText('settings.historyOperationPatch'),
  );
  await expect(page.locator('.settings-history-row').first()).toContainText('themes.id');

  // The theme is read off the shell rather than the select's own text: the
  // trigger draws the option's translated label, which names the theme in one
  // language, while `data-theme` carries the value the setting stores.
  const shell = page.locator('.ops-shell');
  await expect(shell).toHaveAttribute('data-theme', 'cold-cyan');

  await page.getByRole('button', { name: shippedText('settings.undoButton'), exact: true }).click();
  await expect(shell).toHaveAttribute('data-theme', 'terminal-red');
  await expect(page.locator('.settings-history-row').first()).toContainText(
    shippedText('settings.historyOperationUndo'),
  );

  await page.getByRole('button', { name: shippedText('settings.redoButton'), exact: true }).click();
  await expect(shell).toHaveAttribute('data-theme', 'cold-cyan');

  const operation = page.getByRole('combobox', { name: 'Операция истории' });
  await operation.click();
  await optionByValue(page, 'patch').click();
  await expect(page.locator('.settings-history-row')).toHaveCount(1);
  await expect(page.locator('.settings-history-pagination')).toContainText('ВСЕГО 1');
});

test('applies schema-backed visual preview tokens without introducing arbitrary style input', async ({
  page,
}) => {
  await gotoSettingsUnified(page);

  const category = page.getByRole('combobox', { name: 'Категория персонализации' });
  await category.click();
  await page.getByRole('option', { name: 'ЦВЕТА', exact: true }).click();
  // `colors.accent` is a swatch picker now, not a select: a radiogroup of
  // five fixed swatches, each labelled with its accent name.
  const accent = settingRow(page, 'colors.accent').getByRole('radiogroup');
  await accent.locator('[data-option-value="cyan"]').click();
  await expect(page.locator('.ops-shell')).toHaveAttribute('data-accent', 'cyan');

  await category.click();
  await page.getByRole('option', { name: 'ФОНЫ', exact: true }).click();
  const background = settingControl(page, 'backgrounds.kind', 'combobox');
  await background.click();
  await optionByValue(page, 'gradient').click();
  await expect(page.locator('.ops-shell')).toHaveAttribute('data-background-kind', 'gradient');
});

test('supports keyboard semantics across the complete terminal primitive catalog', async ({
  page,
}) => {
  await page.goto('/dev/ui');

  const checkbox = page.getByRole('checkbox', { name: 'Защищённый канал' });
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();

  const bravo = page.getByRole('radio', { name: 'БРАВО' });
  await bravo.click();
  await expect(bravo).toBeChecked();

  const numberField = page.getByRole('textbox', { name: 'Нагрузка' });
  await numberField.press('ArrowUp');
  await expect(numberField).toHaveValue('43');

  const slider = page.getByRole('slider', { name: 'Интенсивность' });
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '68');

  const combobox = page.getByRole('combobox', { name: 'Объект наблюдения' });
  await combobox.fill('DMC');
  await page.getByRole('option', { name: 'DMC-12 / ДРОН' }).click();
  await expect(combobox).toHaveValue('DMC-12 / ДРОН');

  const statusTab = page.getByRole('tab', { name: 'СТАТУС' });
  await statusTab.focus();
  await statusTab.press('ArrowRight');
  const historyTab = page.getByRole('tab', { name: 'ИСТОРИЯ' });
  await expect(historyTab).toBeFocused();
  await historyTab.press('Enter');
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('EVENTS / 24 / SYNCED');

  const toggle = page.getByRole('button', { name: '[TOGGLE] GRID' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '[POPOVER] NODE', exact: true }).click();
  await expect(page.locator('.terminal-popover')).toContainText('SIGNAL 92%');
  await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-popover')).toBeHidden();

  await page.getByRole('button', { name: '[ALERT] OPEN', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'ПОДТВЕРДИТЬ ОПЕРАЦИЮ' })).toBeVisible();
  await page.getByRole('button', { name: '[ENTER] ПОДТВЕРДИТЬ', exact: true }).click();
  await expect(
    page.locator('.terminal-toast').filter({ hasText: 'ОПЕРАЦИЯ ПОДТВЕРЖДЕНА' }),
  ).toBeVisible();

  await expect
    .poll(() =>
      page
        .locator('.gallery-scroll-demo .terminal-scroll-area__viewport')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
});

test('locks the terminal visual contract for Base UI adapters', async ({ page }) => {
  await page.goto('/dev/ui');
  // Let the R16 startup sequence finish first. It is an opaque overlay for a
  // few hundred milliseconds, and a screenshot taken underneath it is black.
  // It sets `pointer-events: none`, so only capture is affected, never a click.
  await expect(page.locator('.startup-sequence')).toHaveCount(0);
  await page.locator('nextjs-portal').evaluateAll((elements) => {
    for (const element of elements) element.remove();
  });

  for (const [heading, snapshot] of [
    ['BASE UI PRIMITIVES', 'base-ui-overlays.png'],
    ['ПОЛЯ И ВЫБОР', 'base-ui-fields.png'],
    ['КОМПОЗИТНЫЕ ЭЛЕМЕНТЫ', 'base-ui-composites.png'],
  ] as const) {
    const panel = page.locator('.ops-panel').filter({
      has: page.getByRole('heading', { name: heading, exact: true }),
    });
    await expect(panel).toHaveScreenshot(snapshot, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
    });
  }
});

test('mounts the Base UI catalog without browser runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/dev/ui');
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('preserves the scene operator and explorer on the compatibility route', async ({ page }) => {
  await page.goto('/control');
  await expect(page.locator('.operational-shell')).toBeVisible();
  await expect(page.locator('.topbar__right .terminal-button')).toHaveCount(2);
  await expect(page.locator('.nav-rail .terminal-button')).toHaveCount(9);
  const sceneSelect = page.getByRole('combobox', { name: 'Операционная сцена' });
  await expect(sceneSelect).toBeVisible();
  await sceneSelect.click();
  await page.getByRole('option', { name: /s02-44/i }).click();
  await expect(sceneSelect).toContainText('s02-44');
  await expect(page.locator('.transport .terminal-button')).toHaveCount(3);
  await page.getByTitle('ФАЙЛЫ').click();
  await expect(page.locator('.virtual-explorer')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Поиск в материалах' })).toHaveClass(
    /terminal-input/,
  );
  await expect(page.getByRole('combobox', { name: 'Фильтр материалов' })).toBeVisible();
});

test('uses a custom Base UI snapshot dialog instead of a native prompt', async ({ page }) => {
  let nativeDialogCount = 0;
  page.on('dialog', async (dialog) => {
    nativeDialogCount += 1;
    await dialog.dismiss();
  });

  await page.goto('/dev');
  await page.getByRole('textbox', { name: 'Код инженерного доступа' }).fill('314159');
  await page.getByRole('button', { name: 'РАЗБЛОКИРОВАТЬ', exact: true }).click();
  await expect(page.locator('.developer-panel')).toBeVisible();
  await page
    .getByRole('button', { name: shippedText('developer.snapshotsHeading'), exact: true })
    .click();

  const trigger = page.getByRole('button', { name: 'СОХРАНИТЬ SNAPSHOT', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'СОХРАНИТЬ SNAPSHOT' })).toBeVisible();
  const name = page.getByRole('textbox', { name: 'Имя snapshot' });
  await name.fill('BASE UI CHECKPOINT');
  await page.getByRole('button', { name: '[ENTER] СОХРАНИТЬ', exact: true }).click();
  await expect(page.locator('.snapshot-tools article')).toContainText('BASE UI CHECKPOINT');
  expect(nativeDialogCount).toBe(0);
});

test('uses terminal Base UI controls across the first feature-screen migration wave', async ({
  page,
}) => {
  await page.goto('/search');
  const searchInput = page.getByRole('textbox', { name: 'Глобальный поиск' });
  await expect(searchInput).toHaveClass(/terminal-input/);
  await page.getByRole('button', { name: 'K-17', exact: true }).click();
  await expect(page.locator('.search-hit-list')).toContainText('K-17');
  await expect(page.locator('.search-hit-list .terminal-button').first()).toBeVisible();

  await page.goto('/analytics');
  const collectionFilter = page.locator('.ops-segmented .terminal-button').filter({
    hasText: shippedText('overview.directionCollection'),
  });
  await collectionFilter.click();
  await expect(collectionFilter).toHaveClass(/is-active/);
  await expect(page.locator('.analytics-insights .terminal-button').first()).toBeVisible();

  await page.goto('/reports');
  const systemReports = page.locator('.reports-kinds .terminal-button').filter({
    hasText: shippedText('reports.kindSystem'),
  });
  await systemReports.click();
  await expect(systemReports).toHaveClass(/is-active/);
  await expect(page.locator('.report-actions .terminal-button')).toHaveCount(4);

  await page.goto('/system');
  const channel = page.locator('.system-network .terminal-button').first();
  await channel.click();
  await expect(page.locator('.ops-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(channel).toBeFocused();

  await page.goto('/archive');
  const archivePeriod = page.getByRole('button', { name: '90D', exact: true });
  await archivePeriod.click();
  await expect(archivePeriod).toHaveClass(/is-active/);
  await expect(page.locator('.archive-timeline button:not(.terminal-button)')).toHaveCount(0);
});

test('migrates registry filters and actions to typed terminal controls', async ({ page }) => {
  await page.goto('/files');
  const fileSearch = page.getByRole('textbox', { name: 'Поиск материалов' });
  await expect(fileSearch).toHaveClass(/terminal-input/);
  const fileSort = page.getByRole('combobox', { name: 'Сортировка материалов' });
  await fileSort.click();
  await page.getByRole('option', { name: 'НАЗВАНИЕ', exact: true }).click();
  await expect(fileSort).toContainText('НАЗВАНИЕ');
  await page.getByRole('button', { name: '[G] GRID', exact: true }).click();
  await expect(page.locator('.file-card-grid')).toBeVisible();
  await expect(
    page.locator('.files-screen button:not(.terminal-button):not(.terminal-select)'),
  ).toHaveCount(0);

  await page.goto('/objects');
  const objectKind = page.getByRole('combobox', { name: 'Тип объекта' });
  await objectKind.click();
  await page.getByRole('option', { name: 'ЛИЦА', exact: true }).click();
  await expect(objectKind).toContainText('ЛИЦА');
  await expect(page.getByRole('textbox', { name: 'Поиск объектов' })).toHaveClass(/terminal-input/);
  await page.getByRole('button', { name: shippedText('objects.tabActivity'), exact: true }).click();
  await expect(page.locator('.event-feed')).toBeVisible();
  await expect(
    page.locator('.objects-screen button:not(.terminal-button):not(.terminal-select)'),
  ).toHaveCount(0);

  await page.goto('/cases');
  const caseStatus = page.getByRole('combobox', { name: 'Статус дела' });
  await caseStatus.click();
  await page.getByRole('option', { name: 'АКТИВЕН', exact: true }).click();
  await expect(caseStatus).toContainText('АКТИВЕН');
  const caseSearch = page.getByRole('textbox', { name: 'Поиск по реестру дел' });
  await caseSearch.fill('ГРЕМУЧАЯ');
  await expect(caseSearch).toHaveValue('ГРЕМУЧАЯ');
  await expect(
    page.locator('.cases-screen button:not(.terminal-button):not(.terminal-select)'),
  ).toHaveCount(0);
});

test('opens the hidden local material-import surface without adding page scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/files');
  await page.keyboard.press('Control+Shift+Alt+KeyS');

  const dialog = page.getByRole('dialog', { name: 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Выбрать материалы для локального импорта')).toHaveClass(
    /terminal-input/,
  );
  await expect(page.locator('.material-import-dialog__recent')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement;
        return root?.scrollHeight === root?.clientHeight;
      }),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

/**
 * A loopback file-bridge, proxied under the address `BridgeMaterialClient`
 * expects by default, for the two t5-player-rework tests below: both need a
 * material an actual import put real bytes behind, not a fabricated store
 * record a preview reader would fail to fetch.
 */
async function withMaterialsBridge(page: Page, run: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gremuchaya-import-preview-'));
  const config: BridgeConfig = {
    version: 1,
    transport: 'grpc-web',
    port: 0,
    readOnly: false,
    allowedOrigins: ['http://127.0.0.1:3000'],
    mounts: [
      {
        id: 'materials',
        label: 'МАТЕРИАЛЫ',
        root,
        virtualPath: createVirtualPath('/МАТЕРИАЛЫ'),
      },
    ],
    stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
    watchDebounceMs: 25,
    materialImport: {
      enabled: true,
      maxFileBytes: 64 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
    },
  };
  const running = await startBridge(config);
  try {
    const address = running.server.address() as AddressInfo;
    const bridgeOrigin = `http://127.0.0.1:${address.port}`;
    await page.route('http://127.0.0.1:4177/**', async (route) => {
      const requested = new URL(route.request().url());
      const proxied = await route.fetch({
        url: `${bridgeOrigin}${requested.pathname}${requested.search}`,
      });
      await route.fulfill({ response: proxied });
    });
    await run();
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
}

const importPreviewNote = 'СЪЁМКА K-17: заметка для предпросмотра.';

test('previews a selected library entry inside the import dialog', async ({ page }) => {
  await withMaterialsBridge(page, async () => {
    await page.goto('/files');
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    const dialog = page.getByRole('dialog', { name: 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ' });
    await expect(dialog).toBeVisible();

    await page.getByLabel('Выбрать материалы для локального импорта').setInputFiles({
      name: 'polevaya-zametka.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(importPreviewNote, 'utf-8'),
    });
    await expect(page.locator('.material-import-dialog__status')).toContainText(
      'ЗАГРУЖЕНО: 1 / LOCAL MIRROR',
    );

    // No preview until an entry is picked -- the dialog used to list name,
    // MIME and hash with nothing to look at (t5-player-rework).
    await expect(page.locator('.material-import-dialog__preview')).toBeHidden();
    await page
      .locator('.material-import-dialog__entry', { hasText: 'polevaya-zametka.txt' })
      .click();
    const preview = page.locator('.material-import-dialog__preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('.local-material-preview--text pre')).toHaveText(
      importPreviewNote,
    );
  });
});

test('keeps the selected import-dialog row legible and announced under light-operations', async ({
  page,
}) => {
  await page.addInitScript(() => {
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
            values: { 'themes.id': 'light-operations' },
            changedIds: ['themes.id'],
            history: [],
          },
          history: [],
          undoStack: [],
          redoStack: [],
        },
      }),
    );
  });

  await withMaterialsBridge(page, async () => {
    await page.goto('/files');
    await expect(page.locator('.ops-shell')).toHaveAttribute('data-theme', 'light-operations');
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    const dialog = page.getByRole('dialog', { name: 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ' });
    await expect(dialog).toBeVisible();

    await page.getByLabel('Выбрать материалы для локального импорта').setInputFiles({
      name: 'svetlaya-tema.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('LIGHT THEME ROW', 'utf-8'),
    });
    await expect(page.locator('.material-import-dialog__status')).toContainText(
      'ЗАГРУЖЕНО: 1 / LOCAL MIRROR',
    );

    const row = page.locator('.material-import-dialog__entry', { hasText: 'svetlaya-tema.txt' });
    // aria-current, not colour alone: a screen reader has to be told which
    // row is the one currently previewed the same way `.is-active` shows it
    // sighted.
    await expect(row).toHaveAttribute('aria-current', 'false');
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');

    const contrast = async (): Promise<number> =>
      row.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (colour: string): number => {
          const parts = colour.match(/[\d.]+/gu)?.map(Number) ?? [];
          const [red = 0, green = 0, blue = 0] = parts;
          const channel = (value: number): number => {
            const scaled = value / 255;
            return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
        };
        const front = luminance(style.color);
        const back = luminance(style.backgroundColor);
        return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
      });

    // Polled, not read once: `.hq-button`'s own `transition: … background
    // var(--motion-micro) ease, color var(--motion-micro) ease` (packages/ui)
    // means a `getComputedStyle` read taken the instant `is-active` lands
    // still reports a value mid-interpolation from whatever the row showed
    // before, not the settled one -- `expect.poll` outlasts that transition
    // the way a single `evaluate` cannot.
    //
    // WCAG's floor for normal-sized text (this row's is 9px) is 4.5:1 -- the
    // hard-coded `#17140d` background this replaces measured roughly 1.5:1
    // against `light-operations`'s own dark `--ops-orange-bright`, tuned for
    // a light surface rather than a near-black one.
    await expect.poll(contrast).toBeGreaterThan(4.5);
  });
});

test('opens the file drawer for an imported material and shows its preview', async ({ page }) => {
  await withMaterialsBridge(page, async () => {
    await page.goto('/files');
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    await page.getByLabel('Выбрать материалы для локального импорта').setInputFiles({
      name: 'polevaya-zametka.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(importPreviewNote, 'utf-8'),
    });
    await expect(page.locator('.material-import-dialog__status')).toContainText(
      'ЗАГРУЖЕНО: 1 / LOCAL MIRROR',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ' })).toBeHidden();

    // OperationsShell's file drawer used to read `attachments` only, so
    // `[ENTER] FILE VIEWER` on an imported material opened nothing at all
    // (t5-player-rework).
    await page.getByRole('button', { name: '[ENTER] FILE VIEWER' }).click();
    const drawer = page.locator('.ops-drawer--card');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.local-material-preview--text pre')).toHaveText(importPreviewNote);
  });
});

test('keeps the hidden transport row out of the browser hit-test until it is revealed', async ({
  page,
}) => {
  await withMaterialsBridge(page, async () => {
    await page.goto('/files');
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    const dialog = page.getByRole('dialog', { name: 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ' });
    await expect(dialog).toBeVisible();

    const videoBytes = await readFile(
      join(process.cwd(), 'public', 'assets', 'video', 'surveillance-k17.webm'),
    );
    await page.getByLabel('Выбрать материалы для локального импорта').setInputFiles({
      name: 'hover-row-video.webm',
      mimeType: 'video/webm',
      buffer: videoBytes,
    });
    await expect(page.locator('.material-import-dialog__status')).toContainText(
      'ЗАГРУЖЕНО: 1 / LOCAL MIRROR',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: '[ENTER] FILE VIEWER' }).click();
    const drawer = page.locator('.ops-drawer--card');
    await expect(drawer).toBeVisible();

    const hoverRow = drawer.locator('.local-material-player__hover-row');
    const muteButton = hoverRow.getByText(/^\[M\]/);
    await expect(muteButton).toHaveText('[M] MUTED');
    await expect(hoverRow).toHaveAttribute('data-revealed', 'false');

    // The property that actually decides whether a click -- a real pointer's,
    // or the same touch tap that reveals the row -- reaches [M] MUTED: the
    // browser's own computed `pointer-events`, not a simulated gesture racing
    // against React's own reveal. `opacity: 0` alone leaves this row
    // hit-testable; `Controls.Group` (the parent) force-sets `pointer-events:
    // auto` on itself via an inline style on attach, so the row must set its
    // own value to override that inherited default.
    await expect(hoverRow).toHaveCSS('pointer-events', 'none');

    // Focus, not a pointer move: this surface's `<video>` never finishes
    // loading over the file bridge's proxied blob URL in this harness (a
    // separate, pre-existing gap in the type Vidstack is given for it), which
    // leaves every element in `.local-material-player` laid out at zero size
    // and unreachable by real screen coordinates. The keyboard path this
    // reveal also serves does not depend on that layout at all.
    await muteButton.focus();
    await expect(hoverRow).toHaveAttribute('data-revealed', 'true');
    await expect(hoverRow).not.toHaveCSS('pointer-events', 'none');

    await muteButton.press('Enter');
    await expect(muteButton).toHaveText('[M] AUDIO');
  });
});

test('keeps overview, communications and tactical layers interactive through wrappers', async ({
  page,
}) => {
  await page.goto('/overview');
  await expect(page.locator('.overview-screen .terminal-button').first()).toBeVisible();
  const schematic = page.getByRole('button', { name: /СЕКТОР S-03.*ЦЕЛЬ K-17/ });
  await schematic.click();
  await expect(page).toHaveURL(/\/map/);

  const hostileLayer = page.getByRole('checkbox', { name: 'ПРОТИВНИК' });
  const wasChecked = await hostileLayer.isChecked();
  await hostileLayer.click();
  await expect(hostileLayer).toBeChecked({ checked: !wasChecked });
  // Six, not three: `map.mode` added the three representation buttons beside
  // the three the toolbar already carried. The count is asserted rather than
  // loosened because it is what proves the wrappers are reached at all — a
  // toolbar drawn with raw elements would report none.
  await expect(page.locator('.map-toolbar .terminal-button')).toHaveCount(6);

  await page.goto('/communications');
  const firstChannel = page.locator('.channel-list .terminal-button').first();
  await firstChannel.click();
  const mute = page.locator('.channel-actions .terminal-button').first();
  await mute.click();
  await expect(mute).toContainText(shippedText('comms.mutedButton'));
  await expect(page.locator('.message-log .terminal-button').first()).toBeVisible();
});

test('renders every primary operational route', async ({ page }) => {
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
  ];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator('.ops-shell')).toBeVisible();
    await expect(page.locator('.ops-screen')).toBeVisible();
  }
});
