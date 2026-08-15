import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import type { BridgeConfig } from '@gremuchaya/config';
import { EntryKind, FileBridgeService } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startBridge } from './server.js';

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
      protocolVersion: 2,
      status: 'ok',
      transport: 'grpc-web+protobuf',
    });

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
