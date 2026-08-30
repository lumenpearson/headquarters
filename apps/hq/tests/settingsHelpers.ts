import type { Page } from '@playwright/test';

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
