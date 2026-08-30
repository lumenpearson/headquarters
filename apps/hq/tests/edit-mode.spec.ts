import { expect, test, type Page } from '@playwright/test';

import { expandEditPanel } from './editPanelHelpers';

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
  // The panel opens as the collapsed pill, the same way it opens docked
  // right: both are pinned defaults, not incidental starting points.
  await expect(panel).toHaveAttribute('data-expanded', 'false');

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
  // ОТМЕНИТЬ sits in the header and is reachable collapsed; ЧЕРНОВИК ISSUE is
  // in the body, so the panel has to be expanded before it can be asserted.
  const undo = page.getByRole('button', { name: 'ОТМЕНИТЬ' });
  await expect(undo).toBeDisabled();
  await expandEditPanel(page);
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
  await expandEditPanel(page);

  const section = panel.getByRole('combobox', { name: 'Раздел' });
  const sections = [
    'ВНЕШНИЙ ВИД',
    'МАКЕТ И РАЗМЕРЫ',
    'ДВИЖЕНИЕ И ДОСТУПНОСТЬ',
    'ИНФОРМАЦИЯ',
    'МЕДИА И КАРТА',
    'СЕССИЯ И УПРАВЛЕНИЕ',
    'СИСТЕМА',
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
  await expandEditPanel(page);

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

/**
 * R4: the four editable values on the event card are edited from the card.
 *
 * A record card is a modal dialog. While one is open Base UI traps the tab
 * ring inside it, marks every other body child `aria-hidden` and lays a
 * full-screen backdrop over the document -- measured here before this case
 * existed: twelve consecutive Tab presses never left the card, `.edit-panel`
 * carried `aria-hidden="true"`, and a click on the content field in the panel
 * was refused for four seconds. The operator could select an event's date and
 * reach nothing that changed it.
 *
 * This drives the gesture rather than the markup: open the card, point at the
 * date, type a new one, read the card. A case that only asserted the editor
 * had rendered would have passed against the build that had the defect.
 */
test('R4: an event card opened in edit mode is edited from inside the card', async ({ page }) => {
  await page.goto('/overview');
  await expect(page.locator('.ops-shell')).toBeVisible();
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-panel')).toBeVisible();

  await page.locator('.operation-timeline button').first().click();
  const card = page.locator('.ops-drawer');
  await expect(card).toBeVisible();

  const printedDate = card.locator('.editable-content[title="ДАТА СОБЫТИЯ"]');
  const seeded = ((await printedDate.textContent()) ?? '').trim();
  // The seed sits in September 2026, so the date typed below is a change and
  // not the value that was already there.
  expect(seeded).not.toBe('15.01.2026');

  await printedDate.click();
  await expect(printedDate).toHaveAttribute('aria-pressed', 'true');

  // Inside the card, and only there: two mounted copies would be two drafts
  // of one field and two elements sharing the error message's id.
  const control = card.locator('.edit-content input[type="date"]');
  await expect(control).toBeVisible();
  await expect(page.locator('.edit-panel .edit-content')).toHaveCount(0);

  // Reachable with the keyboard, which is the half a pointer test cannot see:
  // the ring is closed, so a control outside it is never tabbed to.
  const focusedControl = async (): Promise<boolean> =>
    page.evaluate(() => document.activeElement?.getAttribute('type') === 'date');
  await printedDate.focus();
  let tabs = 0;
  while (tabs < 10 && !(await focusedControl())) {
    await page.keyboard.press('Tab');
    tabs += 1;
  }
  expect(await focusedControl()).toBe(true);

  await control.fill('2026-01-15');

  // The card the operator is looking at, not the field they typed into.
  await expect(printedDate).toHaveText('15.01.2026');
  // The time of day is the operator's to change separately, and a date edit
  // leaves it where it was.
  const printedTime = card.locator('.editable-content[title="ВРЕМЯ СОБЫТИЯ"]');
  const keptTime = ((await printedTime.textContent()) ?? '').trim();
  expect(keptTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);

  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('gremuchaya-hq:operations:v3');
    if (raw === null) throw new Error('the store has not been persisted');
    const parsed = JSON.parse(raw) as { content?: { overrides?: Record<string, string> } };
    return parsed.content?.overrides ?? {};
  });
  expect(Object.keys(stored)).toHaveLength(1);
  expect(Object.keys(stored)[0]).toMatch(/^event\.date@EV-\d+$/);

  // The way back is in the card too, so an edit made there can be undone
  // without closing the card to find the button.
  await card.getByRole('button', { name: /^Вернуть исходное значение: event\.date@/ }).click();
  await expect(printedDate).toHaveText(seeded);
  // The list of changes empties with it; the field stays selected, because a
  // reset is a correction and not a reason to stop editing.
  await expect(card.locator('.edit-content__changed')).toHaveCount(0);
  await expect(control).toBeVisible();
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
    await page.getByRole('option', { name: 'ПАТТЕРНЫ', exact: true }).click();
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

/**
 * What the edit panel writes and what the screen reads are one address.
 *
 * Every per-tile setting is stored under `screen:tile`, because a tile id is
 * unique only within a screen -- `registry` is the table on four of them. The
 * two pickers used to build that address from `ui.route`, and on three routes
 * the route is not the screen the grid was given: `/archive` draws the `files`
 * screen, `/objects/:id` the `objects` one and `/cases/:id` the `cases` one.
 * A caption or a motion set there was saved, listed in the catalogue, and read
 * by nobody.
 *
 * These cases run the operator's own gesture end to end -- select the tile,
 * type into the panel, look at the screen -- rather than seeding the stored
 * list, which is what the R28 cases in `personalization-consumers.spec.ts`
 * already do and what cannot see this defect at all.
 */
async function selectTile(page: Page, tile: string): Promise<void> {
  await expect(page.locator(`[data-tile="${tile}"]`)).toBeVisible();
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('.edit-mode-frame')).toBeVisible();
  // The frame proves edit mode is on; the resize handles prove THIS tile has
  // re-rendered as editable. A press dispatched between those two commits
  // lands on a cell that is being replaced and selects nothing -- measured on
  // /archive, where the screen behind the grid is heavy enough to open the
  // window that the lighter routes close before a pointer can hit it.
  await expect(page.locator(`[data-tile="${tile}"] .tile-grid__handle`).first()).toBeVisible();

  // Hovered before it is measured: a hover waits for the element to stop
  // moving, and on /archive the grid re-lays itself moments after edit mode
  // opens, when the bridge probe comes back -- a box measured before that
  // shift aims the press at whatever control lands on those coordinates
  // after it. Seen as the press selecting nothing while a select of another
  // tile swallowed the pointer.
  const headerLocator = page.locator(`[data-tile="${tile}"] .ops-panel__header`);
  await headerLocator.hover({ position: { x: 20, y: 12 } });

  // The grip is the panel header and nowhere else, so R12 keeps text selectable
  // in the body. Three pixels of jitter, as a real press has: a press with none
  // would pass against a build that treated the first pixel as a drag.
  const header = await headerLocator.boundingBox();
  if (header === null) throw new Error(`the ${tile} tile is not laid out`);
  await page.mouse.move(header.x + 20, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 22, header.y + header.height / 2 + 1);
  await page.mouse.up();
  await expect(page.locator(`[data-tile="${tile}"]`)).toHaveAttribute('data-selected', 'true');
}

async function openSection(page: Page, section: string): Promise<void> {
  await page.locator('.edit-panel').getByRole('combobox', { name: 'Раздел' }).click();
  await page.getByRole('option', { name: section, exact: true }).click();
}

/**
 * The routes whose name is not the name of the screen they draw. `/objects/:id`
 * is the third and is not driven here: it is the same `ScreenRenderer` branch
 * as `/cases/:id`, reached with an object id this suite has no fixture for.
 */
const routesNamedAfterNoScreen = [
  { route: '/archive', screen: 'files', tile: 'categories', shipped: 'КАТЕГОРИИ' },
  { route: '/cases/CASE-01', screen: 'cases', tile: 'registry', shipped: 'РЕЕСТР ДЕЛ' },
] as const;

for (const subject of routesNamedAfterNoScreen) {
  test(`R28: a caption typed in edit mode reaches the tile on ${subject.route}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.goto(subject.route);
    const heading = page.locator(`[data-tile="${subject.tile}"] .ops-panel__header h2`);
    await expect(heading).toHaveText(subject.shipped);

    await selectTile(page, subject.tile);
    await openSection(page, 'ИНФОРМАЦИЯ');

    const field = page.locator('.edit-panel').getByRole('textbox', {
      name: `Подпись плитки ${subject.tile.toUpperCase()} на языке ru`,
    });
    await field.fill('ПАПКИ СМЕНЫ');
    await field.press('Enter');

    // The heading the operator is looking at, not the field they typed into:
    // the caption used to come back to the same input and appear nowhere else.
    await expect(heading).toHaveText('ПАПКИ СМЕНЫ');
    // Stored against the screen the grid was given, which is the whole of the
    // defect: `archive:categories` and `case-detail:registry` saved and renamed
    // nothing.
    expect(await storedCaptions(page)).toEqual([
      `ru:${subject.screen}:${subject.tile}=${encodeURIComponent('ПАПКИ СМЕНЫ')}`,
    ]);
  });
}

/** The caption list as the draft holds it, so the address can be read back. */
async function storedCaptions(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('gremuchaya-hq:operations:v3');
    if (raw === null) throw new Error('the store has not been persisted');
    const parsed = JSON.parse(raw) as {
      personalization?: { draft?: { values?: Record<string, unknown> } };
    };
    const stored = parsed.personalization?.draft?.values?.['localization.elementOverrides'];
    if (!Array.isArray(stored)) throw new Error('no caption list is stored');
    return stored as readonly string[];
  });
}

test('R28: the same gesture still lands on a route that shares its name with the screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  // `/overview` is one of the thirteen routes where the two agreed all along.
  // Reading the address off the tile registry must not cost them anything.
  await page.goto('/overview');
  const heading = page.locator('[data-tile="brief"] .ops-panel__header h2');
  await expect(heading).toHaveText('ОБЗОР ОПЕРАЦИИ');

  await selectTile(page, 'brief');
  await openSection(page, 'ИНФОРМАЦИЯ');

  const field = page
    .locator('.edit-panel')
    .getByRole('textbox', { name: 'Подпись плитки BRIEF на языке ru' });
  await field.fill('СВОДКА СМЕНЫ');
  await field.press('Enter');

  await expect(heading).toHaveText('СВОДКА СМЕНЫ');
});

test('R19: a motion chosen in edit mode reaches the tile on a route named after no screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/archive');
  const tile = page.locator('[data-tile="categories"]');
  // The default the resolver gives a tile no entry names, so the assertion
  // below is a change rather than a reading that was already true.
  await expect(tile).toHaveAttribute('data-tile-motion', 'fade');

  await selectTile(page, 'categories');
  await openSection(page, 'ДВИЖЕНИЕ И ДОСТУПНОСТЬ');

  await page
    .locator('.edit-panel')
    .getByRole('combobox', { name: 'Движение плитки CATEGORIES' })
    .click();
  await page.getByRole('option', { name: 'РАЗВЁРТКА', exact: true }).click();

  await expect(tile).toHaveAttribute('data-tile-motion', 'scan');
});
