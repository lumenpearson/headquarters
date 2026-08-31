import type { Locator, Page } from '@playwright/test';

/**
 * Opens `/settings` in the continuous, single-list presentation
 * (`layout.settingsLanding: 'unified'`) rather than the card grid it opens
 * with by default. The specs that call this reach a section's controls the
 * moment the screen loads -- exactly what `page.goto('/settings')` gave them
 * before cards existed -- so their own claim stays about the setting under
 * test, not about first finding the right card.
 *
 * Seeded once per test through a raw `localStorage` write (a `sessionStorage`
 * marker keeps a second `page.goto`/`page.reload` in the same test from
 * re-seeding), not through `applySettingsPatch` the way clicking the header's
 * own toggle would: several of these specs assert an exact count of PATCH
 * entries in the local settings history, and switching the landing through
 * the running application would add one the test never asked for. Merged
 * onto whatever the profile already holds, rather than overwriting it
 * outright, because several of these specs type into a settings field and
 * then navigate away to check the effect elsewhere -- a blind overwrite on
 * that second navigation would discard exactly what they just set.
 */
export async function gotoSettingsUnified(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const marker = 'gremuchaya-hq:test-settings-landing-seeded';
    if (window.sessionStorage.getItem(marker) !== null) return;
    window.sessionStorage.setItem(marker, '1');

    const key = 'gremuchaya-hq:operations:v3';
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = window.localStorage.getItem(key);
      parsed = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      parsed = null;
    }
    const personalization = (parsed?.['personalization'] as Record<string, unknown>) ?? {};
    const draft = (personalization['draft'] as Record<string, unknown>) ?? {};
    const values = (draft['values'] as Record<string, unknown>) ?? {};
    const changedIds = (draft['changedIds'] as string[]) ?? [];

    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 5,
        ui: {},
        production: {},
        ...parsed,
        personalization: {
          published: personalization['published'] ?? { revision: 0, values: {} },
          draft: {
            baseRevision: draft['baseRevision'] ?? 0,
            values: { ...values, 'layout.settingsLanding': 'unified' },
            changedIds: changedIds.includes('layout.settingsLanding')
              ? changedIds
              : [...changedIds, 'layout.settingsLanding'],
            history: draft['history'] ?? [],
          },
          history: personalization['history'] ?? [],
          undoStack: personalization['undoStack'] ?? [],
          redoStack: personalization['redoStack'] ?? [],
        },
      }),
    );
  });
  await page.goto('/settings');
}

/**
 * One settings row, addressed by the definition id it edits.
 *
 * Every row publishes `data-setting-id`, which is the same in every locale;
 * its visible label is not. A spec that located a control through
 * `getByRole('textbox', { name: 'TABLES / PAGE SIZE' })` was asserting that
 * the application speaks English, and said nothing about `tables.pageSize` --
 * so translating the catalogue turned twenty-one specs red without a single
 * behaviour changing. Reach the row by id, then the control by its role
 * within the row.
 */
export function settingRow(page: Page, settingId: string): Locator {
  return page.locator(`[data-setting-id="${settingId}"]`);
}

/** The one control inside a settings row, by ARIA role. */
export function settingControl(
  page: Page,
  settingId: string,
  role: 'textbox' | 'combobox' | 'switch' | 'slider' | 'button',
): Locator {
  return settingRow(page, settingId).getByRole(role);
}

/**
 * Picks an open select's option by the value it stores rather than the label
 * it draws, for the same reason {@link settingRow} exists.
 */
export function optionByValue(page: Page, value: string): Locator {
  return page.locator(`[role="option"][data-option-value="${value}"]`);
}

/** Opens a setting's dropdown and chooses one option by its stored value. */
export async function chooseSettingOption(
  page: Page,
  settingId: string,
  value: string,
): Promise<void> {
  await settingControl(page, settingId, 'combobox').click();
  await optionByValue(page, value).click();
}

/**
 * Types a value into a setting's text field, replacing whatever it held.
 *
 * `Control+A` rather than `fill`: several of these fields commit on change
 * and re-render from the store, and `fill` clears through a path the field's
 * own handler does not see.
 */
export async function typeSettingValue(
  page: Page,
  settingId: string,
  value: string,
): Promise<void> {
  const field = settingControl(page, settingId, 'textbox');
  await field.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
  await field.blur();
}
