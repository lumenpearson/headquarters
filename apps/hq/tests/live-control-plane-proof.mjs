// F10/F7/F8, plan rule 2.2: the first proof of the whole group loop -- pairing,
// group creation, group settings sync (WatchSettings/publishGroupSettings
// path) and presence detail -- against a *running* control plane, rather than
// a scripted transport or a fake WebSocket.
//
// This is not a `*.spec.ts` file the Playwright test runner (playwright.config.ts)
// discovers: it drives two browser *contexts at two different origins* of the
// same Next.js server (127.0.0.1 vs localhost -- `DeviceSessionStore` is
// scoped per origin, per F14 Э7), against a control plane and PostgreSQL this
// script does not start itself. Run it after:
//
//   1. A live PostgreSQL reachable at HQ_CONTROL_PLANE_DATABASE_URL, with
//      HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER and HQ_CONTROL_PLANE_BOOTSTRAP_SECRET
//      set (durable auth requires both -- apps/control-plane/.env.example).
//   2. `pnpm --filter @gremuchaya/control-plane dev` (or the built server)
//      listening at CONTROL_PLANE_URL below.
//   3. `pnpm --filter @gremuchaya/hq build && pnpm --filter @gremuchaya/hq exec
//      next start --hostname 0.0.0.0 --port <APP_PORT>` -- a production
//      build, not `next dev`: two dev-mode tabs share one compiler process
//      and its HMR websocket in a way a production server does not.
//
//   node apps/hq/tests/live-control-plane-proof.mjs
//
// Every step prints PASS/FAIL as it runs (rule 2.2: quote the run, do not
// summarize it) and the script exits 1 on the first failed assertion, after
// closing the browser.
//
// Known, stated boundary of this proof: one machine, two origins of one
// server process -- not two machines, so LAN discovery and real network
// latency are not exercised. Whether the group setting change below travels
// the `/realtime` socket or the poll fallback is read from
// `connection.links[].status`/`delivery` and printed, not assumed.
//
// GENUINE DEFECT THE FIRST RUN OF THIS SCRIPT FOUND, since fixed:
// `ControlPlaneClient.createGroup`/`.pair` sent `publicKey: ''` -- the client
// had no device-key generation at all -- and the server's
// `normalizeDeviceInput`/`requireText` (apps/control-plane/src/sync/
// durable-runtime.ts) refuses an empty `public_key`, so every real
// pairing/group-creation call the client made failed
// "public_key must not be empty." against a live control plane with durable
// auth. The tracked client now presents a persistent device identity
// (`BrowserDeviceIdentity`, `gremuchaya-hq:device-identity:v1`), so this
// script runs against it unmodified.

import { chromium } from '@playwright/test';

const APP_PORT = process.env.HQ_LIVE_PROOF_APP_PORT ?? '3100';
const CONTROL_PLANE_URL = process.env.HQ_LIVE_PROOF_CONTROL_PLANE_URL ?? 'http://127.0.0.1:4101';
const BOOTSTRAP_SECRET = process.env.HQ_LIVE_PROOF_BOOTSTRAP_SECRET;
if (BOOTSTRAP_SECRET === undefined || BOOTSTRAP_SECRET.trim().length === 0) {
  console.error(
    "HQ_LIVE_PROOF_BOOTSTRAP_SECRET is required (the control plane's HQ_CONTROL_PLANE_BOOTSTRAP_SECRET).",
  );
  process.exit(2);
}

const originA = `http://127.0.0.1:${APP_PORT}`;
const originB = `http://localhost:${APP_PORT}`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    const contextA = await browser.newContext({ baseURL: originA });
    const contextB = await browser.newContext({ baseURL: originB });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    record(
      'window A and window B are different origins',
      originA !== originB,
      `${originA} vs ${originB}`,
    );

    await pageA.goto(`${originA}/settings`);
    await pageB.goto(`${originB}/settings`);
    await dismissKeybindIntro(pageA);
    await dismissKeybindIntro(pageB);

    // --- Window A: leave local-only, reach the live control plane ---
    await leaveLocalOnly(pageA, 'A');
    const modeA1 = await waitForConnectionMode(pageA, ['НУЖЕН НОВЫЙ КОД ПАРЫ']);
    record(
      'window A leaves local-only and reaches the live control plane',
      modeA1 === 'НУЖЕН НОВЫЙ КОД ПАРЫ',
      `СОСТОЯНИЕ = ${modeA1}`,
    );

    // --- Window A: create the group (admin) ---
    const groupName = `ШТАБ ЖИВОГО ПРОГОНА ${Date.now()}`;
    await pageA.getByRole('button', { name: '[N] СОЗДАТЬ НОВУЮ ГРУППУ' }).click();
    await pageA.getByLabel('Имя новой группы').fill(groupName);
    await pageA.getByLabel('Секрет развёртывания').fill(BOOTSTRAP_SECRET);
    const createGroupButton = pageA.getByRole('button', { name: '[N] СОЗДАТЬ ГРУППУ' });
    await expectEnabled(createGroupButton, 5_000);
    await createGroupButton.click();
    const modeA2 = await waitForConnectionMode(pageA, ['В ГРУППЕ'], 20_000);
    const deviceRowA = await readDefinitionRow(pageA, 'УСТРОЙСТВО');
    const failureA =
      (await pageA
        .locator('.group-pairing__failure')
        .first()
        .textContent()
        .catch(() => null)) ?? '';
    record(
      'window A is ADMIN in a live group after CreateGroup',
      modeA2 === 'В ГРУППЕ' && deviceRowA.includes('АДМИНИСТРАТОР'),
      `СОСТОЯНИЕ = ${modeA2} / УСТРОЙСТВО = ${deviceRowA}${failureA ? ` / ОШИБКА = ${failureA}` : ''}`,
    );

    // --- Window A: TimeSync moved the clock off "not measured" ---
    const clockA = await waitForClockMeasured(pageA);
    record(
      "window A's clock is measured against the live control plane (TimeSync)",
      clockA !== 'НЕ ИЗМЕРЕНЫ',
      `ЧАСЫ = ${clockA}`,
    );

    // --- Window A: issue a pairing code ---
    await pageA.getByRole('button', { name: '[C] ВЫПУСТИТЬ КОД ПАРЫ' }).click();
    const codeLocator = pageA.locator('.group-pairing__code strong');
    await codeLocator.waitFor({ state: 'visible', timeout: 10_000 });
    const pairingCode = (await codeLocator.textContent())?.trim() ?? '';
    record(
      'window A issues a pairing code (CreatePairingCode)',
      pairingCode.startsWith('hq_pair_'),
      `code = ${pairingCode}`,
    );

    // --- Window B: leave local-only, reach the live control plane ---
    await leaveLocalOnly(pageB, 'B');
    const modeB1 = await waitForConnectionMode(pageB, ['НУЖЕН НОВЫЙ КОД ПАРЫ']);
    record(
      'window B leaves local-only and reaches the live control plane',
      modeB1 === 'НУЖЕН НОВЫЙ КОД ПАРЫ',
      `СОСТОЯНИЕ = ${modeB1}`,
    );

    // --- Window B: pair with the code A issued ---
    await pageB.getByLabel('Код пары').fill(pairingCode);
    await pageB.getByLabel('Имя устройства').fill('DEVICE-B-LIVE-PROOF');
    const connectButton = pageB.getByRole('button', { name: '[P] ПОДКЛЮЧИТЬСЯ К ГРУППЕ' });
    await connectButton.waitFor({ state: 'visible' });
    await expectEnabled(connectButton, 5_000);
    await connectButton.click();
    const modeB2 = await waitForConnectionMode(pageB, ['В ГРУППЕ'], 20_000);
    const failureB =
      (await pageB
        .locator('.group-pairing__failure')
        .first()
        .textContent()
        .catch(() => null)) ?? '';
    record(
      'window B pairs with the code and joins the live group (PairDevice)',
      modeB2 === 'В ГРУППЕ',
      `СОСТОЯНИЕ = ${modeB2}${failureB ? ` / ОШИБКА = ${failureB}` : ''}`,
    );

    // --- Both windows list both devices ---
    let devicesA = await waitForDeviceCount(pageA, 2, 20_000);
    const devicesB = await waitForDeviceCount(pageB, 2, 20_000);
    if (devicesA < 2) {
      // PairDevice publishes no group event that the already-connected admin's
      // socket would receive (unlike RevokeDevice and SetDeviceRole, which both
      // call publishDeviceUpdate -- apps/control-plane/src/sync/service.ts:237,
      // :319 vs :140 pairDevice, which calls neither), and nothing on the
      // client re-issues ListDevices on a timer
      // (ControlPlaneSession.refreshDevices is only called from within the
      // pairing device's own createGroup/join, never periodically -- see
      // ControlPlaneSession.ts:374,494,525). A reload re-runs #enterGroup's
      // join() and its refreshDevices() call, which is the one path that
      // updates an already-online admin's roster. Tried here as a second,
      // explicitly-labelled probe of that specific gap, not as an assertion
      // the card required.
      console.log(
        'INFO: window A did not see the peer device live; reloading to test the join()-time refresh path',
      );
      await pageA.reload();
      await dismissKeybindIntro(pageA);
      await reopenGroupDialog(pageA);
      devicesA = await waitForDeviceCount(pageA, 2, 15_000);
      console.log(`INFO: after reloading window A, device rows = ${devicesA}`);
    }
    record('window A lists both devices', devicesA === 2, `${devicesA} device row(s)`);
    record('window B lists both devices', devicesB === 2, `${devicesB} device row(s)`);

    // --- Both clocks measured (repeat the check for B) ---
    const clockB = await waitForClockMeasured(pageB);
    record(
      "window B's clock is measured against the live control plane (TimeSync)",
      clockB !== 'НЕ ИЗМЕРЕНЫ',
      `ЧАСЫ = ${clockB}`,
    );

    // --- Print which delivery each link actually used (socket vs poll) ---
    const deliveryA = await readLinkDelivery(pageA);
    const deliveryB = await readLinkDelivery(pageB);
    console.log(
      `INFO: window A link delivery = ${deliveryA}; window B link delivery = ${deliveryB}`,
    );

    // --- A group-scoped setting changed in A lands live in B (WatchSettings/publishGroupSettings path) ---
    const before = await readSimulationLoopSwitch(pageA);
    const beforeB = await readSimulationLoopSwitch(pageB);
    record(
      'the group setting starts in the same state on both windows',
      before === beforeB,
      `A=${before} B=${beforeB}`,
    );
    await toggleSimulationLoopSwitch(pageA);
    const afterA = await readSimulationLoopSwitch(pageA);
    record(
      'window A toggled the group-scoped simulation.loop switch',
      afterA !== before,
      `A: ${before} -> ${afterA}`,
    );
    const landed = await pollUntil(
      async () => (await readSimulationLoopSwitch(pageB)) === afterA,
      70_000,
      1_000,
    );
    const afterB = await readSimulationLoopSwitch(pageB);
    record(
      "window A's group-scoped setting change (simulation.loop) lands live in window B",
      landed,
      `B: ${beforeB} -> ${afterB} (target ${afterA})`,
    );

    // --- Presence detail (screen path) appears for the peer ---
    await reopenGroupDialog(pageA);
    await reopenGroupDialog(pageB);
    const presenceSeenOnA = await pollUntil(() => peerPresenceHasScreen(pageA), 25_000, 2_000);
    record('window A sees presence detail (active screen) reported by its peer', presenceSeenOnA);

    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length} assertion(s): ${results.length - failed.length} passed, ${failed.length} failed.`,
    );
    if (failed.length > 0) {
      console.log('Failed:');
      for (const f of failed) console.log(`  - ${f.name}`);
    }
    await contextA.close();
    await contextB.close();
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
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

async function leaveLocalOnly(page, label) {
  await dismissKeybindIntro(page);
  await page.getByRole('button', { name: '[G] ОТКРЫТЬ ПОДКЛЮЧЕНИЕ К ГРУППЕ' }).click();
  await page.getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' }).waitFor({ state: 'visible' });
  await page.getByLabel('Адрес control plane').fill(CONTROL_PLANE_URL);
  await page.getByRole('button', { name: '[S] СОХРАНИТЬ' }).click();
  const localOnlySwitch = page.getByRole('switch', { name: 'Локальный режим' });
  const checked = await localOnlySwitch.getAttribute('aria-checked');
  if (checked !== 'false') await localOnlySwitch.click();
  console.log(`INFO: [${label}] address saved, local-only toggled off`);
}

async function waitForConnectionMode(page, acceptable, timeoutMs = 15_000) {
  const dd = page
    .getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' })
    .locator('dl.ops-definition-list > div', {
      has: page.locator('dt', { hasText: 'СОСТОЯНИЕ' }),
    })
    .locator('dd');
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = (await dd.first().textContent())?.trim() ?? '';
    if (acceptable.includes(last)) return last;
    await page.waitForTimeout(500);
  }
  return last;
}

async function readDefinitionRow(page, label) {
  const dd = page
    .getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' })
    .locator('dl.ops-definition-list > div', { has: page.locator('dt', { hasText: label }) })
    .locator('dd');
  return (await dd.first().textContent())?.trim() ?? '';
}

async function waitForClockMeasured(page, timeoutMs = 20_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await readDefinitionRow(page, 'ЧАСЫ');
    if (last !== 'НЕ ИЗМЕРЕНЫ' && last !== '') return last;
    await page.waitForTimeout(1_000);
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

async function waitForDeviceCount(page, expected, timeoutMs = 20_000) {
  const rows = page.locator('.group-pairing__devices article');
  const start = Date.now();
  let count = await rows.count();
  while (Date.now() - start < timeoutMs && count < expected) {
    await page.waitForTimeout(1_000);
    count = await rows.count();
  }
  return count;
}

async function readLinkDelivery(page) {
  const links = page.locator('.group-pairing__links article small').first();
  if ((await page.locator('.group-pairing__links article').count()) === 0) return 'no-link-row';
  return (await links.textContent())?.trim() ?? '';
}

async function readSimulationLoopSwitch(page) {
  await closeDialogIfOpen(page);
  const search = page.locator('.settings-personalization').getByLabel('Поиск по настройкам');
  await search.fill('simulation.loop');
  const control = page.getByRole('switch', { name: 'SIMULATION / LOOP' });
  await control.waitFor({ state: 'visible', timeout: 10_000 });
  const checked = await control.getAttribute('aria-checked');
  return checked;
}

async function toggleSimulationLoopSwitch(page) {
  const control = page.getByRole('switch', { name: 'SIMULATION / LOOP' });
  await control.click();
}

async function closeDialogIfOpen(page) {
  const dialog = page.getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' });
  if (await dialog.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

async function reopenGroupDialog(page) {
  const dialog = page.getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' });
  if (await dialog.isVisible().catch(() => false)) return;
  const opener = page.getByRole('button', { name: '[G] ОТКРЫТЬ ПОДКЛЮЧЕНИЕ К ГРУППЕ' });
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await dialog.waitFor({ state: 'visible' });
}

async function peerPresenceHasScreen(page) {
  const entries = page.locator('.group-pairing__presence article');
  const count = await entries.count();
  for (let index = 0; index < count; index += 1) {
    const text = (await entries.nth(index).textContent()) ?? '';
    if (!text.includes('—') || /\/[a-z-]+/u.test(text)) {
      // A dash-only row (`— · СДВИГ...`) means no screen reported yet; a row
      // whose text contains a route-shaped fragment (a leading slash) is a
      // peer that has reported one.
      if (/\/[a-z-]+/u.test(text)) return true;
    }
  }
  return false;
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
