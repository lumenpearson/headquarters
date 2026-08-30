import { expect, test } from '@playwright/test';

import { gotoSettingsUnified } from './settingsHelpers';

test('R11: the numbered navigation keys reach the routes their badges promise', async ({
  page,
}) => {
  // This was dead code before the registry existed: the handler compared the
  // display badge "02" against the key "2", so no digit ever matched and the
  // numbered rail was decoration.
  await page.goto('/overview');
  await expect(page.locator('.ops-screen')).toBeVisible();

  await page.keyboard.press('Digit2');
  await expect(page).toHaveURL(/\/objects$/);

  await page.keyboard.press('Digit4');
  await expect(page).toHaveURL(/\/map$/);

  await page.keyboard.press('Digit1');
  await expect(page).toHaveURL(/\/overview$/);
});

test('R11: a numbered key typed into a field stays in the field', async ({ page }) => {
  await page.goto('/search');
  const input = page.locator('.search-command input');
  await input.click();
  await input.fill('K-1');
  await page.keyboard.press('Digit7');

  await expect(page).toHaveURL(/\/search$/);
  await expect(input).toHaveValue('K-17');
});

test('R11: the list is in settings and lights up the keybind that fires', async ({ page }) => {
  await gotoSettingsUnified(page);

  const list = page.locator('.settings-keybinds .keybind-list');
  await expect(list).toBeVisible();
  // Built from the registry, so every declared keybind is discoverable.
  await expect(list.getByText('Режим редактирования')).toBeVisible();
  await expect(list.locator('kbd', { hasText: 'Ctrl + Shift + E' })).toBeVisible();

  const editRow = list.locator('.keybind-list__row', { hasText: 'Режим редактирования' });
  await expect(editRow).toHaveAttribute('data-fired', 'false');

  await page.keyboard.press('Control+Shift+E');
  await expect(editRow).toHaveAttribute('data-fired', 'true');
  // The highlight is a flash, not a stuck state.
  await expect(editRow).toHaveAttribute('data-fired', 'false');
});

// The one test that is about a first launch, so it starts without the shared
// "returning operator" storage the rest of the suite runs with.
test.describe('first launch', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('R11: the list greets a first launch once, and stays reachable after', async ({ page }) => {
    await page.goto('/');
    const intro = page.getByRole('dialog', { name: 'Сочетания клавиш' });
    await expect(intro).toBeVisible();

    await intro.getByRole('button', { name: 'ПОНЯТНО' }).click();
    await expect(intro).toHaveCount(0);

    // A second launch is not a first launch.
    await page.reload();
    await expect(page.locator('.ops-shell')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Сочетания клавиш' })).toHaveCount(0);

    // Still one keystroke away.
    await page.keyboard.press('Control+Slash');
    await expect(page.getByRole('dialog', { name: 'Сочетания клавиш' })).toBeVisible();
  });
});

test('R11: a declared keybind no screen owns does not swallow the key', async ({ page }) => {
  await page.goto('/overview');
  await expect(page.locator('.ops-screen')).toBeVisible();

  // The scene keys belong to the /dev shell. Pressing one here must do nothing
  // at all rather than quietly consume the key.
  const consumed = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { code: 'F8', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(consumed).toBe(false);
});
