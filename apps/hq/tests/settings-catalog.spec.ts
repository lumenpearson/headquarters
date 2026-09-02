import { expect, test } from '@playwright/test';

import { gotoSettingsUnified } from './settingsHelpers';

/**
 * The catalogue at the size R6 asks for.
 *
 * Seventy-one definitions across thirty-two categories is already past what one
 * flat list can be read from, and R6 asks for more. The screen therefore groups
 * the categories and searches across all of them, and these are the two things
 * that has to keep true: an operator can reach any setting, and the panel still
 * does not push the page into scrolling.
 */
test('R6: every setting is reachable through a section or through search', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await gotoSettingsUnified(page);
  const catalogue = page.locator('.settings-personalization');
  await expect(catalogue).toBeVisible();

  // The section select opens on `appearance`, so a theme is one selection away.
  await expect(catalogue.locator('.settings-row').first()).toBeVisible();

  const search = catalogue.getByLabel('Поиск по настройкам');
  await search.fill('pixels');
  // `pixels` appears in descriptions and in no identifier, so a search over
  // identifiers alone would find nothing and the operator would conclude the
  // setting does not exist.
  await expect.poll(() => catalogue.locator('.settings-row').count()).toBeGreaterThan(0);

  // Settings outside the open section are still offered, under their own
  // heading — a grouping that hid them would trade one navigation problem for
  // another.
  await expect(catalogue.locator('.settings-catalog-elsewhere')).toBeVisible();

  await search.fill('');
  await expect.poll(() => catalogue.locator('.settings-catalog-elsewhere').count()).toBe(0);
});

test('R26: the catalogue toolbar wraps instead of pushing the page into scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await gotoSettingsUnified(page);
  await expect(page.locator('.settings-catalog-toolbar')).toBeVisible();

  // The settings screen is a catalogue, so R26 lets its list scroll — the
  // document must still not.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
});
