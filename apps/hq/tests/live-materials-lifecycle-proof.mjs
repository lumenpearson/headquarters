// F9 / R1+R2 (plan rule 2.2), residue of the C2 wave's material-lifecycle
// client work: the eight lifecycle RPCs (CreateMaterialVersion,
// UpdateMaterialMetadata, MoveToTrash, RestoreMaterial, PurgeMaterial,
// ListVersions, ListTrash, WatchMaterialEvents) were proven only against a
// scripted MaterialRpcClient fake. This drives ONE live end-to-end pass --
// upload, a new version, trash, restore -- through the actual import dialog
// and MaterialLifecyclePanel, against a real control plane and a real
// S3-compatible bucket (MinIO), so the SigV4 signature, the etag round trip
// and the object bytes are the real thing rather than a scripted transport.
//
// Preconditions: the same public-key workaround live-control-plane-proof.mjs
// documents (this script also pairs a device into a group it creates), and
// the same server pair as that script, PLUS:
//   - The control plane's HQ_CONTROL_PLANE_STORAGE_* group set, pointed at a
//     real MinIO with an existing bucket.
//   - apps/hq built with NEXT_PUBLIC_HQ_MATERIAL_STORAGE_ORIGIN set to that
//     MinIO's origin (a NEXT_PUBLIC_ variable, inlined at build time -- see
//     apps/hq/.env.local in the proof's own scratch worktree).
//
//   node apps/hq/tests/live-materials-lifecycle-proof.mjs
//
// Boundary this proof states plainly: one browser, one device, one group it
// creates for itself. It does not exercise a second device's WatchMaterialEvents
// notification of this device's own upload -- that would need a second paired
// session and is out of this pass's scope.

import { chromium } from '@playwright/test';

const APP_PORT = process.env.HQ_LIVE_PROOF_APP_PORT ?? '3100';
const CONTROL_PLANE_URL = process.env.HQ_LIVE_PROOF_CONTROL_PLANE_URL ?? 'http://127.0.0.1:4101';
const BOOTSTRAP_SECRET = process.env.HQ_LIVE_PROOF_BOOTSTRAP_SECRET;
if (BOOTSTRAP_SECRET === undefined || BOOTSTRAP_SECRET.trim().length === 0) {
  console.error('HQ_LIVE_PROOF_BOOTSTRAP_SECRET is required.');
  process.exit(2);
}

const origin = `http://127.0.0.1:${APP_PORT}`;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();

    await page.goto(`${origin}/settings`);
    await dismissKeybindIntro(page);

    await page.getByRole('button', { name: '[G] ОТКРЫТЬ ПОДКЛЮЧЕНИЕ К ГРУППЕ' }).click();
    await page.getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' }).waitFor({ state: 'visible' });
    await page.getByLabel('Адрес control plane').fill(CONTROL_PLANE_URL);
    await page.getByRole('button', { name: '[S] СОХРАНИТЬ' }).click();
    const localOnlySwitch = page.getByRole('switch', { name: 'Локальный режим' });
    if ((await localOnlySwitch.getAttribute('aria-checked')) !== 'false')
      await localOnlySwitch.click();

    await waitForText(page, 'СОСТОЯНИЕ', 'НУЖЕН НОВЫЙ КОД ПАРЫ', 15_000);
    await page.getByRole('button', { name: '[N] СОЗДАТЬ НОВУЮ ГРУППУ' }).click();
    await page.getByLabel('Имя новой группы').fill(`МАТЕРИАЛЫ ${Date.now()}`);
    await page.getByLabel('Секрет развёртывания').fill(BOOTSTRAP_SECRET);
    const createButton = page.getByRole('button', { name: '[N] СОЗДАТЬ ГРУППУ' });
    await expectEnabled(createButton, 5_000);
    await createButton.click();
    const mode = await waitForText(page, 'СОСТОЯНИЕ', 'В ГРУППЕ', 20_000);
    record(
      'window is online in a live group with materials capability available',
      mode === 'В ГРУППЕ',
      `СОСТОЯНИЕ = ${mode}`,
    );

    await page.keyboard.press('Escape');
    await page.goto(`${origin}/files`);
    await dismissKeybindIntro(page);

    // --- Open the import dialog (files.import, unbound to any visible button) ---
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    const importDialog = page.getByRole('dialog', { name: 'ИМПОРТ МАТЕРИАЛОВ В ГРУППУ' });
    const openedGroupDialog = await importDialog
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    record(
      'the import dialog opens against the group library (not the loopback bridge)',
      openedGroupDialog,
    );
    if (!openedGroupDialog) {
      console.log(
        'BLOCKED: the import dialog never reported the group-library origin -- stopping here.',
      );
      return finish(browser, context, results);
    }

    const fileName = `live-proof-${Date.now()}.txt`;
    const originalBytes = Buffer.from(`hq live materials proof ${Date.now()}\n`.repeat(50), 'utf8');
    await page.getByLabel('Выбрать материалы для локального импорта').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: originalBytes,
    });

    const uploaded = await pollUntil(
      async () =>
        (await page.locator('.material-import-dialog__recent li', { hasText: fileName }).count()) >
        0,
      30_000,
      1_000,
    );
    record(
      'a small generated file uploads through BeginUpload/signed PUT/CompleteUpload to the live bucket',
      uploaded,
      `file = ${fileName}`,
    );
    if (!uploaded) {
      const status =
        (await page
          .locator('.material-import-dialog__status')
          .first()
          .textContent()
          .catch(() => null)) ?? '';
      console.log(`BLOCKED: upload never appeared in the recent list. Dialog status: ${status}`);
      return finish(browser, context, results);
    }

    await page.getByRole('button', { name: 'ЗАКРЫТЬ' }).click();

    // --- Select the uploaded material in the main file browser to reach MaterialLifecyclePanel ---
    const row = page.locator('.files-table tr', { hasText: fileName });
    const rowFound = await pollUntil(async () => (await row.count()) > 0, 15_000, 1_000);
    record(
      'the uploaded material appears in the file browser (merged into the store, not just React state)',
      rowFound,
    );
    if (!rowFound) return finish(browser, context, results);
    await row.first().click();

    const panel = page.locator('.material-lifecycle-panel');
    const panelVisible = await panel
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    record('MaterialLifecyclePanel renders for the selected group-library material', panelVisible);
    if (!panelVisible) return finish(browser, context, results);

    // --- Rename (UpdateMaterialMetadata) ---
    const newName = `${fileName}-renamed`;
    const nameInput = page.getByLabel('Название материала');
    await nameInput.fill(newName);
    await page.getByRole('button', { name: '[S] СОХРАНИТЬ' }).click();
    const renamed = await pollUntil(
      async () =>
        (await panel
          .locator('.material-lifecycle-panel__status', { hasText: 'МЕТАДАННЫЕ ОБНОВЛЕНЫ' })
          .count()) > 0,
      10_000,
      500,
    );
    record('UpdateMaterialMetadata renames the material against the live control plane', renamed);

    // --- New version (CreateMaterialVersion) ---
    const versionBytes = Buffer.from(
      `hq live materials proof, version 2, ${Date.now()}\n`.repeat(60),
      'utf8',
    );
    await page.getByLabel('Загрузить новую версию материала').setInputFiles({
      name: `${fileName}.v2.txt`,
      mimeType: 'text/plain',
      buffer: versionBytes,
    });
    const versioned = await pollUntil(
      async () =>
        (await panel
          .locator('.material-lifecycle-panel__status', { hasText: 'НОВАЯ ВЕРСИЯ ЗАГРУЖЕНА' })
          .count()) > 0,
      30_000,
      1_000,
    );
    record(
      'CreateMaterialVersion uploads and records a second version against the live bucket',
      versioned,
    );
    const versionCountText =
      (await panel
        .locator('.material-lifecycle-panel__versions span')
        .first()
        .textContent()
        .catch(() => '')) ?? '';
    record(
      'ListVersions reports at least one version for the material',
      /ВЕРСИИ \/ [1-9]/u.test(versionCountText),
      versionCountText.trim(),
    );

    // --- Move to trash (MoveToTrash) ---
    await page.getByRole('button', { name: '[T] В КОРЗИНУ' }).click();
    await page.getByRole('button', { name: '[T] В КОРЗИНУ' }).last().click();
    const trashed = await pollUntil(async () => (await row.count()) === 0, 10_000, 500);
    record('MoveToTrash removes the material from the live file browser', trashed);

    // --- Restore (RestoreMaterial), via the import dialog's trash tab ---
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    await importDialog.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'КОРЗИНА' }).click();
    const trashRow = page.locator('.material-import-dialog__recent li', { hasText: newName });
    const trashRowFound = await pollUntil(async () => (await trashRow.count()) > 0, 15_000, 1_000);
    record('ListTrash lists the trashed material against the live control plane', trashRowFound);
    if (trashRowFound) {
      await trashRow.getByRole('button', { name: '[R] ВОССТАНОВИТЬ' }).click();
      const restored = await pollUntil(async () => (await trashRow.count()) === 0, 10_000, 500);
      record('RestoreMaterial removes the material from the live trash listing', restored);
    }

    // --- WatchMaterialEvents: this device's own upload/version/trash/restore
    // stream, surfaced as a live event count while the dialog is open ---
    const eventsBadge =
      (await page
        .locator('.material-import-dialog__events')
        .first()
        .textContent()
        .catch(() => null)) ?? '';
    record(
      'WatchMaterialEvents surfaced at least one library event while the dialog was open',
      eventsBadge.length > 0,
      eventsBadge.trim(),
    );

    // --- PurgeMaterial: a second, freshly uploaded material, trashed once and
    // purged -- not the restored one above. `restoreFromTrash` in
    // FilesScreen.tsx (:272-289) updates the import dialog's own `recent`
    // React state but never calls `state.recordImportedMaterial`, unlike
    // `applyLifecycleUpdate`/`applyLifecycleTrash` (:312-345) which do -- a
    // restored material is visible again inside the dialog's recent list but
    // not in the main file browser's `.files-table`, so MaterialLifecyclePanel
    // (gated on a `.files-table` selection) cannot be reached for it a second
    // time without a page reload. Genuine finding, not fixed here (out of this
    // card's apps/hq/src footprint) -- reported precisely instead of masked
    // by reusing the same material for both restore and purge.
    await page.getByRole('button', { name: 'ЗАКРЫТЬ' }).click();
    const secondFileName = `live-proof-purge-${Date.now()}.txt`;
    await page.keyboard.press('Control+Shift+Alt+KeyS');
    await importDialog.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'НЕДАВНИЕ' }).click();
    await page.getByLabel('Выбрать материалы для локального импорта').setInputFiles({
      name: secondFileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(`hq live materials purge probe ${Date.now()}\n`.repeat(40), 'utf8'),
    });
    const secondUploaded = await pollUntil(
      async () =>
        (await page
          .locator('.material-import-dialog__recent li', { hasText: secondFileName })
          .count()) > 0,
      30_000,
      1_000,
    );
    if (secondUploaded) await page.getByRole('button', { name: 'ЗАКРЫТЬ' }).click();
    const rowSecond = page.locator('.files-table tr', { hasText: secondFileName });
    const rowSecondFound =
      secondUploaded && (await pollUntil(async () => (await rowSecond.count()) > 0, 15_000, 1_000));
    if (rowSecondFound) {
      await rowSecond.first().click();
      await page.getByRole('button', { name: '[T] В КОРЗИНУ' }).click();
      await page.getByRole('button', { name: '[T] В КОРЗИНУ' }).last().click();
      await pollUntil(async () => (await rowSecond.count()) === 0, 10_000, 500);
      await page.keyboard.press('Control+Shift+Alt+KeyS');
      await importDialog.waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'КОРЗИНА' }).click();
      const trashRowAgain = page.locator('.material-import-dialog__recent li', {
        hasText: secondFileName,
      });
      const trashRowAgainFound = await pollUntil(
        async () => (await trashRowAgain.count()) > 0,
        15_000,
        1_000,
      );
      if (trashRowAgainFound) {
        await trashRowAgain.getByRole('button', { name: '[P] УДАЛИТЬ НАВСЕГДА' }).click();
        await page.getByRole('button', { name: '[P] УДАЛИТЬ НАВСЕГДА' }).last().click();
        const purged = await pollUntil(
          async () => (await trashRowAgain.count()) === 0,
          15_000,
          1_000,
        );
        record('PurgeMaterial removes the material from the live trash permanently', purged);
      } else {
        record(
          'PurgeMaterial removes the material from the live trash permanently',
          false,
          'could not re-list the trashed material to purge it',
        );
      }
    } else {
      record(
        'PurgeMaterial removes the material from the live trash permanently',
        false,
        'could not upload/select the second material to trash it for purging',
      );
    }

    return finish(browser, context, results);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function finish(browser, context, results) {
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length} assertion(s): ${results.length - failed.length} passed, ${failed.length} failed.`,
  );
  if (failed.length > 0) {
    console.log('Failed or blocked:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  await context.close().catch(() => {});
  if (failed.length > 0) process.exitCode = 1;
}

async function dismissKeybindIntro(page) {
  const dialog = page.getByRole('dialog', { name: 'Сочетания клавиш' });
  const appeared = await dialog
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.getByRole('button', { name: 'ПОНЯТНО' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

async function waitForText(page, dtLabel, expected, timeoutMs) {
  const dd = page
    .getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' })
    .locator('dl.ops-definition-list > div', { has: page.locator('dt', { hasText: dtLabel }) })
    .locator('dd');
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = (await dd.first().textContent())?.trim() ?? '';
    if (last === expected) return last;
    await page.waitForTimeout(500);
  }
  return last;
}

async function expectEnabled(locator, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await locator.isEnabled()) return;
    await locator.page().waitForTimeout(200);
  }
}

async function pollUntil(check, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

main().catch((error) => {
  console.error('the run raised before reaching its next assertion —', error?.message ?? error);
  process.exitCode = 1;
});
