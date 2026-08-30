import { expect, test } from '@playwright/test';

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
