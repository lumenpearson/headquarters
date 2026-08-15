import { expect, test } from '@playwright/test';

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
  await expect(page.getByLabel('Ключ Yandex Maps API')).toHaveClass(/terminal-input/);
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

test('runs the real surveillance player and keeps the 720p matrix horizontal-scroll free', async ({
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

test('renders static screen and scene routes without a white flash', async ({ page }) => {
  await page.goto('/screen/wall-center/');
  await expect(page.locator('.screen-route')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(3, 3, 3)');
  await page.goto('/scene/s08-31/');
  await expect(page.locator('[data-scene-route="s08-31"]')).toBeVisible();
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
  await tooltipTrigger.hover();
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
  await page.goto('/settings');

  const animations = page.getByRole('switch', { name: 'Анимации' });
  await expect(animations).toBeChecked();
  await animations.click();
  await expect(animations).not.toBeChecked();

  const cursorMode = page.getByRole('combobox', { name: 'Cursor mode' });
  await cursorMode.click();
  await page.getByRole('option', { name: 'HIDDEN', exact: true }).click();
  await expect(cursorMode).toContainText('HIDDEN');

  const fixedTime = page.getByRole('textbox', { name: 'Фиксированное время' });
  await fixedTime.fill('13:37:42');
  await page.reload();

  await expect(page.getByRole('switch', { name: 'Анимации' })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Cursor mode' })).toContainText('HIDDEN');
  await expect(page.getByRole('textbox', { name: 'Фиксированное время' })).toHaveValue('13:37:42');
  await expect(page.locator('.settings-row select')).toHaveCount(0);
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
  await page.getByRole('button', { name: 'snapshots', exact: true }).click();

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
    hasText: 'COLLECTION',
  });
  await collectionFilter.click();
  await expect(collectionFilter).toHaveClass(/is-active/);
  await expect(page.locator('.analytics-insights .terminal-button').first()).toBeVisible();

  await page.goto('/reports');
  const systemReports = page.locator('.reports-kinds .terminal-button').filter({
    hasText: 'SYSTEM',
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
  await page.getByRole('button', { name: 'ACTIVITY', exact: true }).click();
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

test('keeps overview, communications and tactical layers interactive through wrappers', async ({
  page,
}) => {
  await page.goto('/overview');
  await expect(page.locator('.overview-screen .terminal-button').first()).toBeVisible();
  const schematic = page.getByRole('button', { name: /СЕКТОР S-03.*TARGET K-17/ });
  await schematic.click();
  await expect(page).toHaveURL(/\/map/);

  const hostileLayer = page.getByRole('checkbox', { name: 'ПРОТИВНИК' });
  const wasChecked = await hostileLayer.isChecked();
  await hostileLayer.click();
  await expect(hostileLayer).toBeChecked({ checked: !wasChecked });
  await expect(page.locator('.map-toolbar .terminal-button')).toHaveCount(3);

  await page.goto('/communications');
  const firstChannel = page.locator('.channel-list .terminal-button').first();
  await firstChannel.click();
  const mute = page.locator('.channel-actions .terminal-button').first();
  await mute.click();
  await expect(mute).toContainText('MUTED');
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
