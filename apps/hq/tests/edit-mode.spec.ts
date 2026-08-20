import { expect, test } from '@playwright/test';

test('an operator opens edit mode, docks the panel and edits without the page scrolling', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.ops-shell')).toBeVisible();

  // Nothing edit-related exists before the keybind.
  await expect(page.locator('.edit-panel')).toHaveCount(0);
  await expect(page.locator('.edit-mode-frame')).toHaveCount(0);

  await page.keyboard.press('Control+Shift+E');

  await expect(page.locator('.edit-mode-frame')).toBeVisible();
  const panel = page.locator('.edit-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-edit-mode', 'on');

  // R26: opening edit mode must not make the document scrollable.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      ),
    )
    .toBe(false);

  // The panel starts docked right; dragging it to the left edge re-docks it.
  await expect(panel).toHaveAttribute('data-edge', 'right');
  const box = await panel.boundingBox();
  if (box === null) throw new Error('the edit panel has no layout box');
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(20, 400, { steps: 8 });
  await page.mouse.up();
  await expect(panel).toHaveAttribute('data-edge', 'left');

  // Undo is disabled until an edit exists, and the issue draft with it.
  const undo = page.getByRole('button', { name: 'ОТМЕНИТЬ' });
  await expect(undo).toBeDisabled();
  await expect(page.getByRole('button', { name: 'ЧЕРНОВИК ISSUE' })).toBeDisabled();

  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-panel')).toHaveCount(0);
  await expect(page.locator('.edit-mode-frame')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-edit-mode', 'off');
});
