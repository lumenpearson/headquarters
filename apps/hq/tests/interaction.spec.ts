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

test('R23: a row that selects a record says so, a row that only reports does not', async ({
  page,
}) => {
  await page.goto('/objects');
  const selectable = page.locator('.ops-table tbody tr').first();
  await expect(selectable).toHaveCSS('cursor', 'pointer');

  await page.goto('/system');
  // The node table only reports; a pointer there would promise a click that
  // does nothing.
  await expect(page.locator('.ops-table tbody tr').first()).toHaveCSS('cursor', 'default');
});

test('R23: a field is a pointer at rest and a caret while it is being changed', async ({
  page,
}) => {
  await page.goto('/search');
  const input = page.locator('.search-command input');

  await expect(input).toHaveCSS('cursor', 'pointer');
  await input.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS('cursor', 'text');
});

test('R23: the slider takes a cursor of its own while the value is being moved', async ({
  page,
}) => {
  await page.goto('/dev/ui');
  const slider = page.locator('.terminal-slider').first();
  const control = slider.locator('.terminal-slider__control');
  const thumb = slider.locator('.terminal-slider__thumb');
  await expect(control).toHaveCSS('cursor', 'pointer');

  // The gallery is taller than the viewport and raw mouse coordinates do not
  // scroll: without this the drag lands on nothing and the test passes for the
  // wrong reason.
  await control.scrollIntoViewIfNeeded();
  const box = (await thumb.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 48, box.y + box.height / 2, { steps: 8 });

  // Base UI 1.7.0 declares `data-dragging` but never renders it; this
  // attribute is the one TerminalSlider publishes from the library's own
  // change/commit pair, and the cursor and the thumb highlight both hang on it.
  await expect(slider).toHaveAttribute('data-adjusting');
  await expect(control).toHaveCSS('cursor', 'grabbing');

  await page.mouse.up();
  await expect(control).toHaveCSS('cursor', 'pointer');
  expect(await slider.evaluate((element) => element.hasAttribute('data-adjusting'))).toBe(false);
});
