import { expect, test, type Page } from '@playwright/test';

/**
 * Sets `tables.pageSize` the way an operator would.
 *
 * The registries hold twenty-four to thirty-two records and the default page
 * size is fifty, so at the default every one of them fits on a single page and
 * a pagination test would pass against a control that did nothing. Narrowing
 * the page is what makes the claim observable -- and the setting was one of
 * the eighteen that were rendered, validated, saved and read by nothing (C20),
 * so exercising it is half of what these tests are for.
 */
async function setPageSize(page: Page, size: number): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Категория персонализации' }).click();
  await page.getByRole('option', { name: 'ТАБЛИЦЫ / TABLES', exact: true }).click();
  /*
   * Typed, not filled. `locator.fill` assigns the value and dispatches one
   * input event, which Base UI's number field reads differently from
   * keystrokes: filling `10` and blurring stored `200`, the maximum, while
   * typing the same two characters stores `10`. Measured both ways -- the
   * control is right and `fill` is the wrong gesture to test it with.
   */
  const field = page.getByRole('textbox', { name: 'TABLES / PAGE SIZE' });
  await expect(field).toBeVisible();
  await field.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(size));
  await field.blur();

  /*
   * The precondition is checked, not assumed. Typed straight after a
   * navigation the keystrokes can land before the screen has settled, and the
   * test that follows would then measure the default page size and fail
   * somewhere far from the cause -- which is how it first failed, only when
   * run after the rest of the suite.
   */
  await expect(field).toHaveValue(String(size));
}

function rowIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.case-registry .ops-table tbody tr')).map(
      (row) => row.querySelector('td:nth-child(2)')?.textContent?.trim() ?? '',
    ),
  );
}

test('R9: the cases pagination counts the table it sits under', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await setPageSize(page, 10);
  await page.goto('/cases');

  const pagination = page.locator('.case-registry .registry-pagination');
  await expect(pagination).toBeVisible();
  /*
   * Before this feature the counter read a literal `СТРАНИЦА 01 / 02` whatever
   * the registry held, and the buttons beside it carried no handler at all
   * (C22). Both halves are asserted: the number is derived, and the buttons
   * move.
   */
  await expect(pagination).toContainText('СТРАНИЦА 01 / 03 · 30');
  await expect(page.locator('.case-registry .ops-table tbody tr')).toHaveCount(10);

  const firstPage = await rowIds(page);
  await pagination.getByRole('button', { name: 'NEXT [▶]' }).click();

  await expect(pagination).toContainText('СТРАНИЦА 02 / 03');
  const secondPage = await rowIds(page);
  expect(secondPage).toHaveLength(10);
  // Different records, not the same ten re-rendered under a new number.
  expect(secondPage.some((id) => firstPage.includes(id))).toBe(false);

  await pagination.getByRole('button', { name: '[◀] PREV' }).click();
  await expect(pagination).toContainText('СТРАНИЦА 01 / 03');
  expect(await rowIds(page)).toEqual(firstPage);
});

test('R9: filtering recounts the pages and never strands the operator on an empty one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await setPageSize(page, 10);
  await page.goto('/cases');

  const pagination = page.locator('.case-registry .registry-pagination');
  await pagination.getByRole('button', { name: 'NEXT [▶]' }).click();
  await pagination.getByRole('button', { name: 'NEXT [▶]' }).click();
  await expect(pagination).toContainText('СТРАНИЦА 03 / 03');

  // A filter that leaves fewer records than page three needs. The page has to
  // come back into range, and the table has to have rows in it.
  await page.getByRole('combobox', { name: 'Статус дела' }).click();
  await page.getByRole('option', { name: 'ОГРАНИЧЕН', exact: true }).click();

  await expect(pagination).toContainText('СТРАНИЦА 01 / 01');
  const rows = page.locator('.case-registry .ops-table tbody tr');
  const remaining = await rows.count();
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(10);
  // The header counts what the filter left, not what the registry holds. It
  // read the whole set while the table beneath it showed a filtered one.
  await expect(page.locator('.case-registry .ops-panel__header')).toContainText(
    `${remaining} RECORDS`,
  );
});

test('R9: the object registry sorts on a column that had none', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/objects');

  // Read from what the operator sees: `ProgressBar` prints the rounded value
  // in a `<b>`, and has no `aria-valuenow` to read instead.
  const threats = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.objects-registry .ops-table tbody tr')).map((row) =>
        Number.parseInt(
          row.querySelector('td:nth-child(7) .ops-progress b')?.textContent?.trim() ?? '',
          10,
        ),
      ),
    );

  await expect(page.locator('.objects-registry .ops-table tbody tr').first()).toBeVisible();
  const unsorted = await threats();
  expect(unsorted.length).toBeGreaterThan(2);
  expect(unsorted.every((value) => Number.isFinite(value))).toBe(true);

  await page.getByRole('button', { name: /^THREAT/ }).click();
  const descending = await threats();
  expect(descending).toEqual([...descending].sort((left, right) => right - left));
  // Stated so a registry that happened to arrive sorted could not pass.
  expect(descending).not.toEqual(unsorted);

  await page.getByRole('button', { name: /^THREAT/ }).click();
  const ascending = await threats();
  expect(ascending).toEqual([...ascending].sort((left, right) => left - right));
});

test('R9: every data screen carries the same pagination control', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const [route, label] of [
    ['/objects', 'Страницы реестра объектов'],
    ['/cases', 'Страницы реестра дел'],
    ['/reports', 'Страницы реестра отчётов'],
    ['/files', 'Страницы реестра файлов'],
    ['/video/cameras', 'Страницы реестра камер'],
  ] as const) {
    await page.goto(route);
    const pagination = page.locator(`[aria-label="${label}"]`);
    await expect(pagination).toHaveClass(/registry-pagination/);
    // The counter is derived from the page it describes, so it cannot be the
    // literal that `CasesScreen` used to print.
    await expect(pagination).toContainText(/СТРАНИЦА \d\d \/ \d\d · \d+/);
  }
});

test('R9: the tactical map sorts its channel table', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/map');

  const latencies = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.map-channels-panel .ops-table tbody tr')).map((row) =>
        Number.parseInt(row.querySelector('td:nth-child(5)')?.textContent?.trim() ?? '', 10),
      ),
    );

  await expect(page.locator('.map-channels-panel .ops-table tbody tr').first()).toBeVisible();
  const unsorted = await latencies();
  expect(unsorted.length).toBeGreaterThan(2);
  expect(unsorted.every((value) => Number.isFinite(value))).toBe(true);

  // This screen had no filter, sort or pagination at all -- the last of the
  // data screens with none of the three.
  await page.getByRole('button', { name: /^LAT/ }).click();
  const ascending = await latencies();
  expect(ascending).toEqual([...ascending].sort((left, right) => left - right));

  await page.getByRole('button', { name: /^LAT/ }).click();
  const descending = await latencies();
  expect(descending).toEqual([...descending].sort((left, right) => right - left));
  /*
   * The pair is what makes this non-vacuous, not a comparison with the
   * starting order: the channels happen to arrive in ascending latency, so
   * the first click can legitimately change nothing. The second must.
   */
  expect(descending).not.toEqual(ascending);
});
