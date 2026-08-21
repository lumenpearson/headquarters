import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Drags the pointer across a line of text the way an operator would.
 *
 * Deliberately not `locator.selectText()`: that calls the Selection API
 * directly, which ignores `user-select` and would pass whatever the stylesheet
 * says. The whole claim under test is about what a drag does.
 */
async function dragAcross(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the drag target is not laid out');
  // Along the first line rather than through the middle of the box: a
  // two-line paragraph has its vertical centre in the gap between lines,
  // where a drag legitimately selects nothing and the test would pass for
  // the wrong reason.
  const y = box.y + Math.min(8, box.height / 2);
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, y, { steps: 20 });
  await page.mouse.up();
}

function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

test('R12: a drag across the interface selects nothing until edit mode is on', async ({ page }) => {
  await page.goto('/overview');
  const summary = page.locator('.overview-brief p').first();
  await expect(summary).toBeVisible();

  await dragAcross(page, summary);
  expect(await selectedText(page)).toBe('');

  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toBeVisible();

  await dragAcross(page, summary);
  expect((await selectedText(page)).length).toBeGreaterThan(0);
});

test('R12: the selection colour follows the theme the operator chose', async ({ page }) => {
  await page.goto('/settings');
  const shell = page.locator('.ops-shell');

  const readSelection = () =>
    shell.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        theme: element.getAttribute('data-theme'),
        ink: styles.getPropertyValue('--ops-selection-ink').trim(),
        accent: styles.getPropertyValue('--ops-orange').trim(),
      };
    });

  const dark = await readSelection();
  expect(dark.theme).toBe('terminal-red');
  expect(dark.ink).toBe('#000');

  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ТЕМЫ / THEMES', exact: true }).click();
  await page.getByRole('combobox', { name: 'THEMES / ID' }).click();
  await page.getByRole('option', { name: 'LIGHT-OPERATIONS', exact: true }).click();

  await expect(shell).toHaveAttribute('data-theme', 'light-operations');
  const light = await readSelection();
  expect(light.ink).toBe('#fff');
  // The accent moved with the theme, which is the half the old rule missed: it
  // painted an `--accent-strong` from `:root` that no theme ever touches.
  expect(light.accent).not.toBe(dark.accent);
});
