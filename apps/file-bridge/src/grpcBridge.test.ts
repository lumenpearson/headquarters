import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { bridgeHealthSchema, type BridgeConfig } from '@gremuchaya/config';
import { EntryKind, FileBridgeService } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startBridge } from './server.js';

const abcBlake3 = '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85';

describe('gRPC-Web file bridge', () => {
  let closeBridge: (() => Promise<void>) | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await closeBridge?.();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    closeBridge = undefined;
    root = undefined;
  });

  it('serves health, directory entries and streamed bytes without REST routes', async () => {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-grpc-'));
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'brief.txt'), 'оперативная сводка', 'utf8');
    const config: BridgeConfig = {
      version: 1,
      transport: 'grpc-web',
      port: 0,
      readOnly: true,
      allowedOrigins: ['http://127.0.0.1:3000'],
      mounts: [{ id: 'incoming', label: 'ВХОДЯЩИЕ', root, virtualPath: '/ВХОДЯЩИЕ' }],
      stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
      watchDebounceMs: 25,
    };
    const running = await startBridge(config);
    closeBridge = running.close;
    const address = running.server.address() as AddressInfo;
    const client = createClient(
      FileBridgeService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );

    const health = await client.health({});
    expect(health).toMatchObject({
      service: 'gremuchaya-file-bridge',
      protocolVersion: 3,
      status: 'ok',
      transport: 'grpc-web+protobuf',
    });
    // The literal above says what the version is; this says the schema clients
    // validate against agrees. The two were allowed to disagree for one whole
    // protocol bump because nothing imported the schema to find out.
    expect(() =>
      bridgeHealthSchema.parse({
        service: health.service,
        protocolVersion: health.protocolVersion,
        status: health.status,
        startedAt: health.startedAt,
        transport: health.transport,
      }),
    ).not.toThrow();

    const listed = await client.list({ mountId: 'incoming', path: '/' });
    expect(listed.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['reports', EntryKind.DIRECTORY],
      ['brief.txt', EntryKind.FILE],
    ]);

    const received: Uint8Array[] = [];
    for await (const chunk of client.readFile({ mountId: 'incoming', path: '/brief.txt' })) {
      received.push(chunk.data);
    }
    expect(new TextDecoder().decode(joinChunks(received))).toBe('оперативная сводка');

    const preflight = await fetch(
      `http://127.0.0.1:${address.port}/gremuchaya.bridge.v1.FileBridgeService/Health`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://127.0.0.1:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-grpc-web',
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

    const legacyResponse = await fetch(`http://127.0.0.1:${address.port}/v1/list`);
    expect(legacyResponse.status).toBe(404);
  });

  it('imports and streams a material over binary gRPC-Web while keeping mirror internals private', async () => {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-material-import-'));
    const config: BridgeConfig = {
      version: 1,
      transport: 'grpc-web',
      port: 0,
      readOnly: false,
      allowedOrigins: ['http://127.0.0.1:3000'],
      mounts: [
        {
          id: 'materials',
          label: 'ОБЩИЕ МАТЕРИАЛЫ',
          root,
          virtualPath: '/МАТЕРИАЛЫ',
        },
      ],
      stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
      watchDebounceMs: 25,
      materialImport: { enabled: true, maxFileBytes: 1024 * 1024, chunkSizeBytes: 65_536 },
    };
    const running = await startBridge(config);
    closeBridge = running.close;
    const address = running.server.address() as AddressInfo;
    const client = createClient(
      FileBridgeService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );

    const started = await client.beginMaterialImport({
      mountId: 'materials',
      fileName: 'brief.txt',
      declaredMimeType: 'text/plain',
      totalSize: 3n,
      expectedBlake3: abcBlake3,
    });
    expect(started.session).toBeDefined();
    if (started.session === undefined) throw new Error('Expected an import session.');
    expect(started.session).toMatchObject({ receivedSize: 0n, state: 'PENDING' });

    const appended = await client.uploadMaterialChunk({
      uploadId: started.session.uploadId,
      offset: 0n,
      data: new TextEncoder().encode('abc'),
    });
    expect(appended.session).toMatchObject({ receivedSize: 3n, state: 'UPLOADING' });
    const completed = await client.completeMaterialImport({ uploadId: started.session.uploadId });
    expect(completed).toMatchObject({
      deduplicated: false,
      material: { displayName: 'brief.txt', contentHash: abcBlake3, byteSize: 3n },
    });
    expect(completed.material).toBeDefined();
    if (completed.material === undefined) throw new Error('Expected a completed material.');

    const materials = await client.listImportedMaterials({
      mountId: 'materials',
      pageSize: 20,
      cursor: '',
    });
    expect(materials.materials).toHaveLength(1);
    expect(materials.materials[0]).toMatchObject({ materialId: completed.material.materialId });

    const received: Uint8Array[] = [];
    for await (const chunk of client.readImportedMaterial({
      mountId: 'materials',
      materialId: completed.material.materialId,
    })) {
      received.push(chunk.data);
    }
    expect(new TextDecoder().decode(joinChunks(received))).toBe('abc');

    const visibleRoot = await client.list({ mountId: 'materials', path: '/' });
    expect(visibleRoot.entries).toEqual([]);
    await expect(client.list({ mountId: 'materials', path: '/.hq' })).rejects.toMatchObject({
      code: 7,
    });
  });

  it('issues a revocable media grant with bounded HTTP range semantics', async () => {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-material-playback-'));
    const config: BridgeConfig = {
      version: 1,
      transport: 'grpc-web',
      port: 0,
      readOnly: false,
      allowedOrigins: ['http://127.0.0.1:3000'],
      mounts: [
        {
          id: 'materials',
          label: 'ОБЩИЕ МАТЕРИАЛЫ',
          root,
          virtualPath: '/МАТЕРИАЛЫ',
        },
      ],
      stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
      watchDebounceMs: 25,
      materialImport: { enabled: true, maxFileBytes: 1024 * 1024, chunkSizeBytes: 65_536 },
    };
    const running = await startBridge(config);
    closeBridge = running.close;
    const address = running.server.address() as AddressInfo;
    const client = createClient(
      FileBridgeService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );
    const bytes = new TextEncoder().encode('0123456789');
    const started = await client.beginMaterialImport({
      mountId: 'materials',
      fileName: 'camera-loop.mp4',
      declaredMimeType: 'video/mp4',
      totalSize: BigInt(bytes.byteLength),
      expectedBlake3: '',
    });
    if (started.session === undefined) throw new Error('Expected a media import session.');
    await client.uploadMaterialChunk({
      uploadId: started.session.uploadId,
      offset: 0n,
      data: bytes,
    });
    const completed = await client.completeMaterialImport({ uploadId: started.session.uploadId });
    if (completed.material === undefined) throw new Error('Expected an imported media material.');

    const response = await client.getMaterialPlaybackGrant({
      mountId: 'materials',
      materialId: completed.material.materialId,
    });
    expect(response.grant).toBeDefined();
    if (response.grant === undefined) throw new Error('Expected a playback grant.');
    expect(response.grant.url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${address.port}/v1/material-playback/`, 'u'),
    );
    expect(response.grant.url).not.toContain(root);

    const ranged = await fetch(response.grant.url, {
      headers: { Origin: 'http://127.0.0.1:3000', Range: 'bytes=2-5' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('accept-ranges')).toBe('bytes');
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(ranged.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
    expect(await ranged.text()).toBe('2345');

    const invalidRange = await fetch(response.grant.url, { headers: { Range: 'bytes=99-100' } });
    expect(invalidRange.status).toBe(416);
    const deniedOrigin = await fetch(response.grant.url, {
      headers: { Origin: 'https://untrusted.example' },
    });
    expect(deniedOrigin.status).toBe(403);

    expect(
      await client.revokeMaterialPlaybackGrant({ grantId: response.grant.grantId }),
    ).toMatchObject({ revoked: true });
    expect((await fetch(response.grant.url)).status).toBe(404);
  });
});

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
