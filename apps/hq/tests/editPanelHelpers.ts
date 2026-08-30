import { expect, type Page } from '@playwright/test';

/**
 * Expands the floating edit-mode panel when it opened collapsed.
 *
 * The panel opens as a compact pill (`edit.panelExpanded` defaults to
 * `false` on every `enterEditMode`, in `operationsStore.ts`); its body --
 * the section select, the search field, the settings list and the content
 * editor -- is unreachable to a pointer until the header's own expand
 * control is pressed. Selecting an editable value or a tile expands it on
 * its own (`selectEditElement` in the store), so a flow that has already
 * done that does not need this helper; call it only where a test reaches
 * into the panel body with no such selection first.
 */
export async function expandEditPanel(page: Page): Promise<void> {
  const panel = page.locator('.edit-panel');
  if ((await panel.getAttribute('data-expanded')) === 'false') {
    await panel.getByRole('button', { name: 'Развернуть панель' }).click();
  }
  await expect(panel).toHaveAttribute('data-expanded', 'true');
}
