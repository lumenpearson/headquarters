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

  /*
   * A press on the header that does not travel is a click, not a drag. Without
   * that distinction the panel re-docked under the operator every time they
   * touched it -- which is how its own category select became unusable with a
   * pointer: the panel moved out from under the popup it had just opened.
   */
  const header = page.locator('.edit-panel__header');
  const headerBox = await header.boundingBox();
  if (headerBox === null) throw new Error('the edit panel header has no layout box');
  await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
  await page.mouse.down();
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

/**
 * R6: the catalogue reached from the floating panel, not only from the screen.
 *
 * The panel used to offer one flat select over all thirty-two categories and
 * draw whichever was chosen. Seventy-one definitions are past what that can be
 * read from, and R6 asks for more. The panel navigates by section instead, with
 * the categories as headings inside the list -- and the two things that have to
 * stay true are the same two the settings screen answers for: every setting is
 * reachable, and the panel never pushes the page into scrolling.
 */
test('R6: every section is reachable from the floating panel and shows its categories', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+E');
  const panel = page.locator('.edit-panel');
  await expect(panel).toBeVisible();

  const section = panel.getByRole('combobox', { name: 'Раздел' });
  const sections = [
    'ВНЕШНИЙ ВИД',
    'МАКЕТ',
    'ДВИЖЕНИЕ И ДОСТУПНОСТЬ / MOTION',
    'ИНФОРМАЦИЯ / INFORMATION',
    'МЕДИА И КАРТА / MEDIA',
    'СЕССИЯ И УПРАВЛЕНИЕ / SESSION',
    'СИСТЕМА / SYSTEM',
  ];

  for (const name of sections) {
    await section.click();
    await page.getByRole('option', { name, exact: true }).click();

    // Every section holds at least one category and at least one setting. A
    // section that selects nothing is a dead entry in the only navigation the
    // panel has.
    await expect(panel.locator('.edit-panel__category').first()).toBeVisible();
    await expect.poll(() => panel.locator('.settings-row').count()).toBeGreaterThan(0);

    // The document still does not scroll, at every section: the sections differ
    // in length, and the longest is what would push it.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      ),
    ).toBe(false);
  }
});

test('R6/R26: the panel navigates and scrolls its own body on a short window', async ({ page }) => {
  // The panel is capped at 40dvh against the top or bottom edge and is at its
  // narrowest here, which is where a navigation row too many would show.
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto('/');
  await page.keyboard.press('Control+Shift+E');
  const panel = page.locator('.edit-panel');
  await expect(panel).toBeVisible();

  const search = panel.getByLabel('Поиск по настройкам');
  await search.fill('liveedit');

  // `advanced.liveEdit` is in `system`; the panel opens on `appearance`. One
  // search box answering across every section is what replaces the screen's
  // section-scoped search plus its separate "found elsewhere" block.
  await expect(panel.getByText('ADVANCED / LIVE EDIT')).toBeVisible();

  await search.fill('');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      ),
    )
    .toBe(false);

  // R26 for the panel itself: a whole section is taller than the room the
  // panel has, and the body scrolls it rather than cutting it off. The
  // scrolling element is the scroll area's viewport, not the wrapper the
  // className sits on -- measuring the wrapper reports "not scrollable" no
  // matter how much content is inside it.
  const viewport = panel.locator('.edit-panel__settings .terminal-scroll-area__viewport');
  const overflow = await viewport.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
});

test('R17: state changes land instantly while edit mode is on, and ease again once it is off', async ({
  page,
}) => {
  await page.goto('/');
  const shell = page.locator('.ops-shell');
  await expect(shell).toBeVisible();

  const motionDuration = () =>
    shell.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--ops-motion-duration').trim(),
    );

  // Read rather than hard-code: the duration is derived from the operator's
  // animation intensity, which persists across sessions. What R17 asserts is
  // the relationship between the two modes, not one particular number.
  const configured = await motionDuration();
  expect(configured).not.toBe('0ms');

  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toBeVisible();
  await expect.poll(motionDuration).toBe('0ms');

  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toHaveCount(0);
  // Leaving edit mode restores exactly what the operator configured; the
  // suppression is borrowed for the session, not written into the settings.
  await expect.poll(motionDuration).toBe(configured);
});

// R13: every declared patterns.focus value has to change what a focused
// element looks like. Three of the seven -- brackets (the default), barber and
// scan -- used to change only the data attribute, so the setting was a control
// that did nothing.
for (const [option, attribute] of [
  ['BRACKETS', 'brackets'],
  ['BARBER', 'barber'],
  ['SCAN', 'scan'],
] as const) {
  test(`R13: the ${attribute} focus pattern paints a focused control`, async ({ page }) => {
    await page.goto('/settings');

    const category = page.getByRole('combobox', { name: 'Категория персонализации' });
    await category.click();
    await page.getByRole('option', { name: 'ПАТТЕРНЫ / PATTERNS', exact: true }).click();
    const pattern = page.getByRole('combobox', { name: 'PATTERNS / FOCUS' });
    await pattern.click();
    await page.getByRole('option', { name: option, exact: true }).click();
    await expect(page.locator('.ops-shell')).toHaveAttribute('data-focus-pattern', attribute);

    // Leave the settings screen through a client-side link. The select keeps
    // its popup mounted after closing, and its focus guards -- not the trigger
    // -- are what the next Tab would reach. Navigating within the app moves
    // away from them while the draft, which does not survive a reload, stays.
    await page.getByRole('link', { name: 'ОБЗОР' }).first().click();
    // Wait for the destination route to settle before tabbing: a keypress sent
    // mid-navigation lands on a document that then re-renders, and focus falls
    // back to <body>.
    await expect(page.locator('.ops-workspace')).toHaveAttribute('data-route', 'overview');
    await expect(page.locator('.ops-screen')).toBeVisible();
    await expect(page.locator('.ops-shell')).toHaveAttribute('data-focus-pattern', attribute);

    // A button, not a link: the hover rule in operations.css is weaker than
    // these pattern rules for `a` but exactly as strong for `button`, so only
    // a button can show whether hover wipes the pattern off.
    //
    // Leave the control and come straight back with the keyboard. Focusing it
    // programmatically is not enough: the browser withholds `:focus-visible`
    // from a control focused by script after a mouse interaction, and these
    // rules key off it. Tabbing from a blurred document is not usable either --
    // the first stop belongs to the Next dev overlay, not the application.
    await page.locator('.ops-nav__compact').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');

    // Reports which step failed rather than a bare false: a pattern that does
    // not paint and a control that never became focus-visible are different
    // defects, and a boolean cannot tell them apart.
    const paintState = () =>
      page.evaluate(() => {
        const element = document.activeElement;
        if (element === null) return 'nothing focused';
        if (!element.matches(':focus-visible')) {
          return `<${element.tagName.toLowerCase()}> focused but not focus-visible`;
        }
        if (!element.matches('button, a, input, select')) {
          return `focus landed on <${element.tagName.toLowerCase()}>, which the rule excludes`;
        }
        // Painted with background-image, not a pseudo-element, so one rule
        // reaches input and select as well.
        return getComputedStyle(element).backgroundImage === 'none' ? 'unpainted' : 'painted';
      });

    await expect.poll(paintState).toBe('painted');

    // Hovering must not wipe the pattern off. The hover rule further down
    // operations.css has the same specificity as the pattern rules, so a
    // `background` shorthand there would win on source order and reset the
    // image layer out from under a control that is both focused and hovered.
    await page.locator(':focus').hover();
    await expect.poll(paintState).toBe('painted');
  });
}
