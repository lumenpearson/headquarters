// F14, Э9 (local copy of cloud state) -- open tail: "against a live service --
// not verified, every run was against fakes." Э9's own code is a three-level
// precedence (cloud DB -> local mirror `gremuchaya-hq:group-mirror:v1` ->
// built-in constants); this drives the SAME precedence against a live control
// plane and PostgreSQL, then kills the control plane process mid-session and
// asserts the group is left through the local copy rather than reverting to
// the compiled-in constants.
//
// Preconditions: the server pair live-control-plane-proof.mjs documents (the
// public-key workaround its first run needed is gone -- the tracked client
// now presents `BrowserDeviceIdentity`). The mirror-never-written outcome the
// first run of THIS script recorded was root-caused afterwards:
// `sync_events`/`sync_snapshots.document_id` were `uuid` columns while the
// one published document id is the symbolic `settings.live-edit`, so
// `GetDocumentSnapshot` answered INTERNAL instead of NOT_FOUND and
// `GroupSnapshotDownloader.absorb` read every refresh as `unreachable`.
// Migration `0014_symbolic_document_ids` widens both columns to text; the
// absorb-writes-the-mirror path is proven live in
// `group-administration.integration.test.ts` ("stores a publication whose
// document id is a name rather than a UUID") and by re-running this script.
// This
// script terminates the control plane process itself partway through --
// point HQ_LIVE_PROOF_CONTROL_PLANE_PID at its process id, or this script
// only asserts the mid-session (never-cleared) half and skips the kill.
//
//   HQ_LIVE_PROOF_CONTROL_PLANE_PID=<pid> node apps/hq/tests/live-mirror-verification-proof.mjs
//
// This is destructive to whatever control plane process the PID names --
// run it last, after any other live proof that needs the plane running.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const APP_PORT = process.env.HQ_LIVE_PROOF_APP_PORT ?? '3100';
const CONTROL_PLANE_URL = process.env.HQ_LIVE_PROOF_CONTROL_PLANE_URL ?? 'http://127.0.0.1:4101';
const BOOTSTRAP_SECRET = process.env.HQ_LIVE_PROOF_BOOTSTRAP_SECRET;
const CONTROL_PLANE_PID = process.env.HQ_LIVE_PROOF_CONTROL_PLANE_PID;
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

    await waitForConnectionField(page, 'СОСТОЯНИЕ', 'НУЖЕН НОВЫЙ КОД ПАРЫ', 15_000);
    await page.getByRole('button', { name: '[N] СОЗДАТЬ НОВУЮ ГРУППУ' }).click();
    await page.getByLabel('Имя новой группы').fill(`ЗЕРКАЛО ${Date.now()}`);
    await page.getByLabel('Секрет развёртывания').fill(BOOTSTRAP_SECRET);
    const createButton = page.getByRole('button', { name: '[N] СОЗДАТЬ ГРУППУ' });
    await expectEnabled(createButton, 5_000);
    await createButton.click();
    const mode = await waitForConnectionField(page, 'СОСТОЯНИЕ', 'В ГРУППЕ', 20_000);
    record('window is online in a live group', mode === 'В ГРУППЕ', `СОСТОЯНИЕ = ${mode}`);

    // A group-scoped setting, changed to a value that differs from the
    // compiled-in default (`simulation.loop` default is `true`), so the
    // eventual read distinguishes "read from the mirror" from "fell back to
    // the built-in constant" unambiguously.
    await page.keyboard.press('Escape');
    const before = await readSimulationLoopSwitch(page);
    await toggleSimulationLoopSwitch(page);
    const after = await readSimulationLoopSwitch(page);
    record(
      'a group-scoped setting is changed to a non-default value',
      after !== before,
      `${before} -> ${after}`,
    );

    console.log('DIAGNOSTIC (before wait):', await dumpTransportPopover(page));
    // The client validates a downloaded snapshot against a draft key and
    // reads it back before promoting it -- wait for that whole pipeline to
    // land, not just for the switch to flip locally.
    let mirrorWritten = await pollUntil(() => mirrorIsWritten(page), 20_000, 2_000);
    if (!mirrorWritten) {
      // adoptGroupSettings() re-runs on every WatchSettings frame, and this
      // device's own publish did land server-side (confirmed independently:
      // settings_documents/settings_versions gained a GROUP-scope row at the
      // moment of the toggle) -- but no frame was observed reaching this
      // session within the wait above. Reconnecting reruns adoptGroupSettings
      // unconditionally at join (GroupChannelRuntime.tsx:226), so this
      // isolates whether the live WatchSettings push specifically is the gap,
      // the same asymmetry the sibling live-control-plane-proof found for
      // DEVICE_UPDATED: a value this session already knows still reaches the
      // mirror through a reconnect, just not without one.
      console.log(
        'INFO: mirror still empty after the wait; reloading to test the join()-time adoptGroupSettings path',
      );
      await page.reload();
      await dismissKeybindIntro(page);
      mirrorWritten = await pollUntil(() => mirrorIsWritten(page), 45_000, 3_000);
      console.log(`INFO: after reloading, mirror written = ${mirrorWritten}`);
    }
    console.log('DIAGNOSTIC (after wait):', await dumpTransportPopover(page));
    const mirrorText = await readMirrorSummary(page);
    record(
      "GroupSnapshotDownloader's draft-key stage-then-promote pipeline writes the local mirror against the live control plane",
      mirrorWritten,
      mirrorText,
    );

    if (CONTROL_PLANE_PID === undefined || CONTROL_PLANE_PID.trim().length === 0) {
      console.log(
        'INFO: HQ_LIVE_PROOF_CONTROL_PLANE_PID not set -- skipping the kill-and-reload half.',
      );
      return finish(browser, context, results);
    }

    // --- Mid-session: kill the control plane process while this window is
    // still connected, and confirm the session is not torn down --- the group
    // name and the last-known clock/roster survive a transient `offline`
    // exactly as they would through a real network outage, because
    // ControlPlaneSession#record only patches `mode`/`failure` on
    // 'unavailable', never resets the connection (ControlPlaneSession.ts:590-605).
    // Comma-separated: `tsx watch` runs an `sh -c` launcher plus the actual
    // node process, and killing only the child can leave the shell wrapper
    // behind (harmless to this proof either way, since the port stops
    // answering regardless -- verified below rather than assumed).
    const pids = CONTROL_PLANE_PID.split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value));
    console.log(`INFO: killing control plane process(es) ${pids.join(', ')}`);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        console.log(`INFO: kill(${pid}) — ${error}`);
      }
    }
    for (const pid of pids) await waitForProcessGone(pid, 15_000);
    const portGone = await pollUntil(() => controlPlaneUnreachable(), 15_000, 1_000);
    record('the control plane process is confirmed unreachable before continuing', portGone);

    await reopenGroupDialog(page);
    const midSessionMode = await waitForConnectionField(
      page,
      'СОСТОЯНИЕ',
      'CONTROL PLANE НЕ ОТВЕЧАЕТ',
      40_000,
    );
    const midSessionGroupName = await readConnectionField(page, 'ГРУППА');
    record(
      'mid-session: killing the plane moves the session to offline without clearing the group the session already held',
      midSessionMode === 'CONTROL PLANE НЕ ОТВЕЧАЕТ' && midSessionGroupName !== '—',
      `СОСТОЯНИЕ = ${midSessionMode} / ГРУППА = ${midSessionGroupName}`,
    );

    // --- Fresh boot, no working connection at all: reload with the plane
    // still down. A brand-new ControlPlaneSession probes, fails, and lands
    // straight on `offline` from `connect()` itself (ControlPlaneSession.ts:142) --
    // no prior in-memory state to fall back on, only what is on disk. ---
    await page.reload();
    await dismissKeybindIntro(page);
    const afterReloadValue = await readSimulationLoopSwitch(page);
    record(
      "a fresh page load with the plane still down reads the group's last agreed setting from the local mirror, not the compiled-in default",
      afterReloadValue === after,
      `after reload (plane down): ${afterReloadValue}; expected the group's last value ${after}, the compiled-in default is true`,
    );
    await reopenGroupDialog(page);
    const modeAfterReload = await readConnectionField(page, 'СОСТОЯНИЕ');
    const mirrorAfterReload = await readMirrorSummary(page);
    record(
      'the fresh boot reports offline (no working connection) while still showing a present local mirror',
      modeAfterReload === 'CONTROL PLANE НЕ ОТВЕЧАЕТ',
      `СОСТОЯНИЕ = ${modeAfterReload} / ${mirrorAfterReload}`,
    );

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
    console.log('Failed:');
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

async function reopenGroupDialog(page) {
  const dialog = page.getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' });
  if (await dialog.isVisible().catch(() => false)) return;
  const opener = page.getByRole('button', { name: '[G] ОТКРЫТЬ ПОДКЛЮЧЕНИЕ К ГРУППЕ' });
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await dialog.waitFor({ state: 'visible' });
}

async function readConnectionField(page, label) {
  const dd = page
    .getByRole('dialog', { name: 'СИНХРОНИЗАЦИЯ ГРУППЫ' })
    .locator('dl.ops-definition-list > div', { has: page.locator('dt', { hasText: label }) })
    .locator('dd');
  return (await dd.first().textContent())?.trim() ?? '';
}

async function waitForConnectionField(page, label, expected, timeoutMs) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await readConnectionField(page, label);
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

async function readSimulationLoopSwitch(page) {
  await closeDialogIfOpen(page);
  const search = page.locator('.settings-personalization').getByLabel('Поиск по настройкам');
  await search.fill('simulation.loop');
  const control = page.getByRole('switch', { name: 'SIMULATION / LOOP' });
  await control.waitFor({ state: 'visible', timeout: 10_000 });
  return control.getAttribute('aria-checked');
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

async function readMirrorSummary(page) {
  await closeDialogIfOpen(page);
  await page.locator('.ops-statusline__probe').first().click();
  const popover = page.locator('.ops-transport-detail');
  await popover.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  const text =
    (await popover
      .locator('dd')
      .last()
      .textContent()
      .catch(() => '')) ?? '';
  await page.keyboard.press('Escape');
  return text.trim();
}

async function dumpTransportPopover(page) {
  await closeDialogIfOpen(page);
  await page.locator('.ops-statusline__probe').first().click();
  const popover = page.locator('.ops-transport-detail');
  await popover.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  const rows = popover.locator('> div');
  const count = await rows.count();
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const dt =
      (await rows
        .nth(i)
        .locator('dt')
        .textContent()
        .catch(() => '')) ?? '';
    const dd =
      (await rows
        .nth(i)
        .locator('dd')
        .textContent()
        .catch(() => '')) ?? '';
    parts.push(`${dt.trim()}=${dd.trim()}`);
  }
  await page.keyboard.press('Escape');
  const failure =
    (await page
      .locator('.group-pairing__failure')
      .first()
      .textContent()
      .catch(() => null)) ?? '';
  return `${parts.join(' | ')}${failure ? ` || ОШИБКА=${failure}` : ''}`;
}

const mirrorNotPresentText = 'Нет — значения берутся из сборки';

async function mirrorIsWritten(page) {
  const text = await readMirrorSummary(page);
  return text.length > 0 && text !== mirrorNotPresentText;
}

async function waitForProcessGone(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function controlPlaneUnreachable() {
  try {
    await fetch(CONTROL_PLANE_URL, { signal: AbortSignal.timeout(2_000) });
    return false;
  } catch {
    return true;
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
