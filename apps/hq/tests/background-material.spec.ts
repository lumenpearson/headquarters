import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { expect, test } from '@playwright/test';
import type { BridgeConfig } from '@gremuchaya/config';
import { createVirtualPath } from '@gremuchaya/domain';
import { FileBridgeService } from '@gremuchaya/protocol';

import { startBridge } from '../../file-bridge/src/server.js';
import { gotoSettingsUnified, optionByValue, settingControl } from './settingsHelpers';

/**
 * R13: the `image` and `video` background kinds used to paint a placeholder
 * grid whatever the operator chose, because nothing carried a source. These
 * drive the whole path an operator actually walks -- material in the bridge,
 * picked in settings, painted by the shell -- against a real bridge rather
 * than a stub.
 */
test('paints a chosen material as the application background, and lets go of it', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'gremuchaya-background-'));
  const config: BridgeConfig = {
    version: 1,
    transport: 'grpc-web',
    port: 0,
    readOnly: false,
    allowedOrigins: ['http://127.0.0.1:3000'],
    mounts: [
      {
        id: 'materials',
        label: 'МАТЕРИАЛЫ',
        root,
        virtualPath: createVirtualPath('/МАТЕРИАЛЫ'),
      },
    ],
    stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
    watchDebounceMs: 25,
    materialImport: { enabled: true, maxFileBytes: 8 * 1024 * 1024, chunkSizeBytes: 512 * 1024 },
  };
  const running = await startBridge(config);

  try {
    const address = running.server.address() as AddressInfo;
    const bridgeOrigin = `http://127.0.0.1:${address.port}`;
    const client = createClient(
      FileBridgeService,
      createGrpcWebTransport({ baseUrl: bridgeOrigin, useBinaryFormat: true }),
    );

    const bytes = await readFile(
      join(process.cwd(), 'public', 'assets', 'video', 'camera-01.webp'),
    );
    const started = await client.beginMaterialImport({
      mountId: 'materials',
      fileName: 'background-plate.webp',
      declaredMimeType: 'image/webp',
      totalSize: BigInt(bytes.byteLength),
      expectedBlake3: '',
    });
    if (started.session === undefined) throw new Error('Expected a material import session.');
    for (let offset = 0; offset < bytes.byteLength; offset += started.session.chunkSize) {
      await client.uploadMaterialChunk({
        uploadId: started.session.uploadId,
        offset: BigInt(offset),
        data: bytes.subarray(offset, offset + started.session.chunkSize),
      });
    }
    const completed = await client.completeMaterialImport({
      uploadId: started.session.uploadId,
    });
    if (completed.material === undefined) throw new Error('Expected an imported material.');

    // The application talks to the bridge on its fixed local port; the test
    // bridge listens on an ephemeral one.
    await page.route('http://127.0.0.1:4177/**', async (route) => {
      const requested = new URL(route.request().url());
      const proxied = await route.fetch({
        url: `${bridgeOrigin}${requested.pathname}${requested.search}`,
      });
      await route.fulfill({ response: proxied });
    });

    await gotoSettingsUnified(page);
    const shell = page.locator('.ops-shell');

    const category = page.getByRole('combobox', { name: 'Категория персонализации' });
    await category.click();
    await page.getByRole('option', { name: 'ФОНЫ', exact: true }).click();

    const kind = settingControl(page, 'backgrounds.kind', 'combobox');
    await kind.click();
    await optionByValue(page, 'image').click();
    await expect(shell).toHaveAttribute('data-background-kind', 'image');
    // Nothing chosen yet: the kind alone must not claim to have a source.
    await expect(shell).toHaveAttribute('data-background-image', 'none');

    const source = settingControl(page, 'backgrounds.imageSource', 'combobox');
    await source.click();
    await page.getByRole('option', { name: '[ФАЙЛ] background-plate.webp', exact: true }).click();

    await expect(shell).toHaveAttribute('data-background-image', 'material');
    // `contains`, not `startsWith`: the wash `backgrounds.overlayOpacity` draws
    // rides in the same stack, ahead of the photograph, so the computed value
    // opens with the gradient and the material follows it.
    await expect
      .poll(() =>
        shell.evaluate((element) => getComputedStyle(element).backgroundImage.includes('url(')),
      )
      .toBe(true);
    // The material is read into a blob, not linked from disk: no filesystem
    // path is ever handed to CSS.
    await expect
      .poll(() => shell.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toContain('blob:');

    // Clearing it releases the source and falls back to the placeholder grid.
    await source.click();
    await page.getByRole('option', { name: '[НЕ ВЫБРАН]', exact: true }).click();
    await expect(shell).toHaveAttribute('data-background-image', 'none');
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('offers only material the setting accepts', async ({ page }) => {
  // The video source must not offer a still, and vice versa. Without a bridge
  // the catalogue is empty, which is the state most sessions are in and must
  // itself stay usable rather than break the settings screen.
  await gotoSettingsUnified(page);
  const category = page.getByRole('combobox', { name: 'Категория персонализации' });
  await category.click();
  await page.getByRole('option', { name: 'ФОНЫ', exact: true }).click();

  const source = settingControl(page, 'backgrounds.videoSource', 'combobox');
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.getByRole('option', { name: '[НЕ ВЫБРАН]', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('plays a chosen clip as the background and stops it when motion is off', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'gremuchaya-background-video-'));
  const config: BridgeConfig = {
    version: 1,
    transport: 'grpc-web',
    port: 0,
    readOnly: false,
    allowedOrigins: ['http://127.0.0.1:3000'],
    mounts: [
      {
        id: 'materials',
        label: 'МАТЕРИАЛЫ',
        root,
        virtualPath: createVirtualPath('/МАТЕРИАЛЫ'),
      },
    ],
    stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
    watchDebounceMs: 25,
    materialImport: { enabled: true, maxFileBytes: 8 * 1024 * 1024, chunkSizeBytes: 512 * 1024 },
  };
  const running = await startBridge(config);

  try {
    const address = running.server.address() as AddressInfo;
    const bridgeOrigin = `http://127.0.0.1:${address.port}`;
    const client = createClient(
      FileBridgeService,
      createGrpcWebTransport({ baseUrl: bridgeOrigin, useBinaryFormat: true }),
    );

    const bytes = await readFile(
      join(process.cwd(), 'public', 'assets', 'video', 'surveillance-k17.webm'),
    );
    const started = await client.beginMaterialImport({
      mountId: 'materials',
      fileName: 'background-loop.webm',
      declaredMimeType: 'video/webm',
      totalSize: BigInt(bytes.byteLength),
      expectedBlake3: '',
    });
    if (started.session === undefined) throw new Error('Expected a material import session.');
    for (let offset = 0; offset < bytes.byteLength; offset += started.session.chunkSize) {
      await client.uploadMaterialChunk({
        uploadId: started.session.uploadId,
        offset: BigInt(offset),
        data: bytes.subarray(offset, offset + started.session.chunkSize),
      });
    }
    if (
      (await client.completeMaterialImport({ uploadId: started.session.uploadId })).material ===
      undefined
    ) {
      throw new Error('Expected an imported material.');
    }

    await page.route('http://127.0.0.1:4177/**', async (route) => {
      const requested = new URL(route.request().url());
      const proxied = await route.fetch({
        url: `${bridgeOrigin}${requested.pathname}${requested.search}`,
      });
      await route.fulfill({ response: proxied });
    });

    await gotoSettingsUnified(page);
    const category = page.getByRole('combobox', { name: 'Категория персонализации' });
    await category.click();
    await page.getByRole('option', { name: 'ФОНЫ', exact: true }).click();

    const kind = settingControl(page, 'backgrounds.kind', 'combobox');
    await kind.click();
    await optionByValue(page, 'video').click();

    const source = settingControl(page, 'backgrounds.videoSource', 'combobox');
    await source.click();
    await page.getByRole('option', { name: '[ФАЙЛ] background-loop.webm', exact: true }).click();

    // A real video element, because CSS cannot play one.
    const backgroundVideo = page.locator('.ops-shell__background-video video');
    await expect(backgroundVideo).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => backgroundVideo.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);

    // R13 asks for a background whose motion can be switched off. Turning
    // animations off must actually stop the decoder, not merely hide movement.
    await category.click();
    await page.getByRole('option', { name: 'АНИМАЦИИ', exact: true }).click();
    await settingControl(page, 'animations.enabled', 'switch').click();

    await expect
      .poll(() => backgroundVideo.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(true);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
