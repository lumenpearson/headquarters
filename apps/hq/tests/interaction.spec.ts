import { expect, test, type Locator, type Page } from '@playwright/test';

import { gotoSettingsUnified } from './settingsHelpers';

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
  await gotoSettingsUnified(page);
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
  await page.getByRole('option', { name: 'ТЕМЫ', exact: true }).click();
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

test('R12: the right button opens the shell menu and runs the command it prints', async ({
  page,
}) => {
  await page.goto('/overview');
  await expect(page.locator('.ops-screen')).toBeVisible();

  await page.locator('.ops-workspace').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Команды штаба' });
  await expect(menu).toBeVisible();
  // The chord beside the entry is printed from the keybind registry, not typed
  // here, so the menu and the shortcut list cannot come to disagree.
  await expect(menu.locator('kbd', { hasText: 'Ctrl + Shift + E' })).toBeVisible();

  await menu.getByRole('menuitem', { name: 'Глобальный поиск' }).click();
  await expect(page).toHaveURL(/\/search$/);
});

test('R12: a record row gets its own menu, and an action nothing owns is disabled', async ({
  page,
}) => {
  await page.goto('/objects');
  const row = page.locator('.ops-table tbody tr').first();
  const id = (await row.locator('td strong').first().textContent()) ?? '';
  expect(id.length).toBeGreaterThan(0);

  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Действия над записью' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Открыть карточку' }).click();
  await expect(page).toHaveURL(new RegExp(`/objects/${id}$`));

  // Reports have rows but no card behind them; the entry is drawn and refused
  // rather than drawn and inert.
  await page.goto('/reports');
  await page.locator('.ops-table tbody tr').first().click({ button: 'right' });
  const reportMenu = page.getByRole('menu', { name: 'Действия над записью' });
  await expect(reportMenu.getByRole('menuitem', { name: 'Открыть карточку' })).toBeDisabled();
  await expect(reportMenu.getByRole('menuitem', { name: 'Выделить строку' })).toBeEnabled();
});

test('R12: a field keeps the browser its own menu', async ({ page }) => {
  await page.goto('/search');
  await page.locator('.search-command input').click({ button: 'right' });

  // Cut, copy, paste and spellcheck live there and this application has nothing
  // better to put in their place.
  await expect(page.getByRole('menu', { name: 'Команды штаба' })).toHaveCount(0);
});

/** Presses and holds with a touch pointer, which has no right button to press. */
async function longPress(page: Page, target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  await target.evaluate(
    (element, [x, y]) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerType: 'touch',
          clientX: x as number,
          clientY: y as number,
        }),
      );
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  await page.waitForTimeout(700);
}

test('R12: a long press reaches the same menu on touch, and the setting turns it off', async ({
  page,
}) => {
  await page.goto('/objects');
  const row = page.locator('.ops-table tbody tr').first();

  await longPress(page, row);
  await expect(page.getByRole('menu', { name: 'Действия над записью' })).toBeVisible();
  await page.keyboard.press('Escape');

  // `popups.longPress` had been declared in the settings schema and read by
  // nothing at all; this is the consumer that makes it mean something.
  await gotoSettingsUnified(page);
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'POP-UP', exact: true }).click();
  await page.getByRole('switch', { name: 'POPUPS / LONG PRESS' }).click();

  await page.goto('/objects');
  await longPress(page, page.locator('.ops-table tbody tr').first());
  await expect(page.getByRole('menu', { name: 'Действия над записью' })).toHaveCount(0);

  // The right button is a different gesture and is not governed by the setting.
  await page.locator('.ops-table tbody tr').first().click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Действия над записью' })).toBeVisible();
});

test('R12: an element that owns its menu keeps it, and does not also get the shell one', async ({
  page,
}) => {
  await page.goto('/dev/ui');
  await page
    .getByRole('button', { name: '[CONTEXT] TARGET', exact: true })
    .click({ button: 'right' });

  await expect(page.getByRole('menu', { name: 'Контекстные действия контура' })).toBeVisible();
  // Two menus for one click is two places deciding what the right button does.
  await expect(page.getByRole('menu', { name: 'Команды штаба' })).toHaveCount(0);
});

test('R12: the shell commands are reachable from a visible menu, not only a gesture', async ({
  page,
}) => {
  await page.goto('/overview');

  await page.getByRole('button', { name: 'Команды штаба' }).click();
  const menu = page.getByRole('menu', { name: 'Команды штаба' });
  await expect(menu).toBeVisible();
  // The same registry the right button reads, so the two lists cannot diverge.
  await expect(menu.locator('kbd', { hasText: 'Ctrl + Shift + E' })).toBeVisible();
  // Built when the menu opened, not on first render: ownership is claimed in
  // effects, and a list frozen at mount would draw every command disabled.
  await expect(menu.getByRole('menuitem', { name: 'Полный экран' })).toBeEnabled();

  await menu.getByRole('menuitem', { name: 'Сочетания клавиш' }).click();
  await expect(page.getByRole('dialog', { name: 'Сочетания клавиш' })).toBeVisible();
});

test('R12: the status line carries the transport detail behind a popover', async ({ page }) => {
  await page.goto('/overview');

  const probe = page.getByRole('button', { name: 'Подробности транспорта' });
  await expect(probe).toContainText('BUS:BROADCAST');
  await probe.click();

  const popover = page.getByRole('dialog', { name: 'ТРАНСПОРТ СЕССИИ' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('BroadcastChannel');
  await expect(popover).toContainText('gRPC-Web');
});

test('R12: a destructive reset asks first and reports that it happened', async ({ page }) => {
  await gotoSettingsUnified(page);

  // Nothing is reset by opening the question.
  await page.getByRole('button', { name: '[R] СБРОСИТЬ ОПЕРАТИВНЫЙ МИР' }).click();
  const ask = page.getByRole('alertdialog', { name: 'СБРОСИТЬ ОПЕРАТИВНЫЙ МИР?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'ОТМЕНА' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator('.terminal-toast')).toHaveCount(0);

  await page.getByRole('button', { name: '[R] СБРОСИТЬ ОПЕРАТИВНЫЙ МИР' }).click();
  await page
    .getByRole('alertdialog', { name: 'СБРОСИТЬ ОПЕРАТИВНЫЙ МИР?' })
    .getByRole('button', { name: '[R] СБРОСИТЬ МИР' })
    .click();

  // The change is spread across every screen, so the report is the only place
  // the operator sees that it landed.
  await expect(
    page.locator('.terminal-toast').filter({ hasText: 'ОПЕРАТИВНЫЙ МИР СБРОШЕН' }),
  ).toBeVisible();
});
