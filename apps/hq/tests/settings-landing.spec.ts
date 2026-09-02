import { expect, test } from '@playwright/test';

/**
 * Item 5 (H3 review): R6 ("every setting is reachable through a section or
 * through search", `settings-catalog.spec.ts`) was only ever asserted
 * through `gotoSettingsUnified`, never through the presentation the screen
 * actually opens with. A card names one section or one personalization
 * group, so an operator who does not know which of sixteen cards holds a
 * setting could not even start typing until this landing grew its own
 * search box.
 */
test('R6: every setting is reachable from the card landing itself, without opening a card first', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/settings');

  const grid = page.locator('.settings-card-grid');
  await expect(grid).toBeVisible();

  const search = page.getByLabel('Поиск по настройкам');
  // `pixels` appears in a description (`popups.overlayBlur`) and in no
  // identifier -- the same term `settings-catalog.spec.ts`'s R6 test uses,
  // so the two specs are provably asking the same question of two different
  // presentations.
  await search.fill('pixels');

  // The grid gives way to what the search found, rather than sitting beside
  // it as a second, now-irrelevant navigation surface.
  await expect(grid).toHaveCount(0);
  const results = page.locator('.settings-landing-results');
  await expect(results).toBeVisible();
  await expect.poll(() => results.locator('.settings-row').count()).toBeGreaterThan(0);

  await search.fill('');
  await expect(grid).toBeVisible();
  await expect(results).toHaveCount(0);
});

/**
 * `layout.settingsLanding` ('cards' by default): the settings screen opens
 * as a grid of cards, one card opens exactly one section, and the
 * continuous one-list view the screen used to be the only presentation of
 * stays reachable behind the toggle in the header.
 */
test('the settings screen opens as cards, opens one section at a time, and comes back', async ({
  page,
}) => {
  await page.goto('/settings');

  const grid = page.locator('.settings-card-grid');
  await expect(grid).toBeVisible();
  // Nothing from a section renders while the grid is showing -- a card is a
  // landing, not an accordion with everything collapsed underneath it.
  await expect(page.locator('.settings-keybinds')).toHaveCount(0);
  await expect(page.locator('.settings-personalization')).toHaveCount(0);

  await grid.getByRole('button', { name: 'СОЧЕТАНИЯ КЛАВИШ' }).click();
  await expect(grid).toHaveCount(0);
  const keybinds = page.locator('.settings-keybinds');
  await expect(keybinds).toBeVisible();
  await expect(keybinds.locator('.keybind-list')).toBeVisible();
  // Only the opened section mounts; a different one stays absent.
  await expect(page.locator('.settings-interface')).toHaveCount(0);

  await page.getByRole('button', { name: '[←] К РАЗДЕЛАМ' }).click();
  await expect(grid).toBeVisible();
  await expect(keybinds).toHaveCount(0);
});

test('a personalization group card opens the catalogue panel pre-filtered to that group', async ({
  page,
}) => {
  await page.goto('/settings');

  await page.locator('.settings-card-grid').getByRole('button', { name: 'ВНЕШНИЙ ВИД' }).click();

  const catalogue = page.locator('.settings-personalization');
  await expect(catalogue).toBeVisible();
  await expect(catalogue.getByRole('combobox', { name: 'Раздел персонализации' })).toContainText(
    'ВНЕШНИЙ ВИД',
  );
  // The category select still lists every category, not only the opened
  // group's own -- the same completeness R6 already asks the unified
  // catalogue for.
  const category = catalogue.getByRole('combobox', { name: 'Категория персонализации' });
  await category.click();
  await expect(page.getByRole('option', { name: 'ПЛИТКИ', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Cross-group search still answers from inside an opened card, so R6
  // reachability survives the card landing.
  await catalogue.getByLabel('Поиск по настройкам').fill('pixels');
  await expect(catalogue.locator('.settings-catalog-elsewhere')).toBeVisible();
});

test('the unified toggle restores the one-list view, and the header switch leaves it again', async ({
  page,
}) => {
  await page.goto('/settings');
  await expect(page.locator('.settings-card-grid')).toBeVisible();

  const landing = page.getByRole('combobox', { name: 'Вид настроек' });
  await landing.click();
  await page.getByRole('option', { name: 'ЕДИНЫЙ СПИСОК', exact: true }).click();

  await expect(page.locator('.settings-card-grid')).toHaveCount(0);
  // Every section mounts at once, the way the screen always drew them.
  await expect(page.locator('.settings-interface')).toBeVisible();
  await expect(page.locator('.settings-keybinds')).toBeVisible();
  await expect(page.locator('.settings-personalization')).toBeVisible();
  await expect(page.locator('.settings-docs__nav')).toBeVisible();

  await landing.click();
  await page.getByRole('option', { name: 'КАРТОЧКИ', exact: true }).click();
  await expect(page.locator('.settings-card-grid')).toBeVisible();
  await expect(page.locator('.settings-keybinds')).toHaveCount(0);
});

test('R26: the card grid and an opened section both keep overflow inside the settings pane', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto('/settings');
  await expect(page.locator('.settings-card-grid')).toBeVisible();

  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);

  await page
    .locator('.settings-card-grid')
    .getByRole('button', { name: 'ИСТОРИЯ НАСТРОЕК' })
    .click();
  await expect(page.locator('.settings-history')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
});

/**
 * Item 6 (H3 review), both directions. Opening a card is where the previous
 * behaviour already worked: the card that opened it is gone the instant it
 * does (the grid unmounts with it), so focus moves to the back button
 * instead of falling to `<body>`. Closing one did not have the same care --
 * the back button itself is what leaves the DOM this time, and focus fell
 * to `<body>` for exactly the same reason, restarting Tab order at the
 * document's top instead of at the card the operator just left.
 */
test('focus follows a card both open and closed: onto the back button, then back onto the card', async ({
  page,
}) => {
  await page.goto('/settings');

  const grid = page.locator('.settings-card-grid');
  const card = grid.getByRole('button', { name: 'СОЧЕТАНИЯ КЛАВИШ' });
  await card.click();

  const back = page.getByRole('button', { name: '[←] К РАЗДЕЛАМ' });
  await expect(back).toBeFocused();

  await back.click();
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('button', { name: 'СОЧЕТАНИЯ КЛАВИШ' })).toBeFocused();
});

test('switching the landing view while a card is open does not force focus back onto the back button', async ({
  page,
}) => {
  await page.goto('/settings');
  await page
    .locator('.settings-card-grid')
    .getByRole('button', { name: 'СОЧЕТАНИЯ КЛАВИШ' })
    .click();

  const back = page.getByRole('button', { name: '[←] К РАЗДЕЛАМ' });
  await expect(back).toBeFocused();

  // The back button unmounts entirely while the unified list shows (it has
  // no place there) and remounts once cards come back -- exactly the
  // remount the old effect used as its trigger, because it depended on
  // `layout.settingsLanding` rather than on a card having actually opened.
  const landing = page.getByRole('combobox', { name: 'Вид настроек' });
  await landing.click();
  await page.getByRole('option', { name: 'ЕДИНЫЙ СПИСОК', exact: true }).click();
  await landing.click();
  await page.getByRole('option', { name: 'КАРТОЧКИ', exact: true }).click();

  await expect(back).not.toBeFocused();
});
