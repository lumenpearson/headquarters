import type { AddressInfo } from 'node:net';

import { Code, createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ControlPlaneService, SyncService, controlV1 } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startControlPlane } from './server.js';

describe('gRPC-Web control-plane foundation', () => {
  let closeControlPlane: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  });

  it('serves typed health and capability discovery without REST endpoints', async () => {
    const running = await startControlPlane({
      port: 0,
      allowedOrigins: ['http://127.0.0.1:3000'],
    });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = createClient(
      ControlPlaneService,
      createGrpcWebTransport({ baseUrl, useBinaryFormat: true }),
    );

    const health = await client.health({});
    expect(health).toMatchObject({
      service: 'gremuchaya-control-plane',
      version: '0.1.0',
      protocolVersion: 'gremuchaya.v1',
      status: controlV1.ServingStatus.SERVING,
      dependencies: [],
    });
    expect(health.startedAt).toBeDefined();
    expect(health.checkedAt).toBeDefined();

    const capabilities = await client.getCapabilities({});
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'transport.grpc-web',
      version: 'v1',
      enabled: true,
    });
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'materials',
      version: 'v1',
      enabled: false,
    });

    const unauthenticatedSync = createClient(
      SyncService,
      createGrpcWebTransport({ baseUrl, useBinaryFormat: true }),
    );
    await expect(
      unauthenticatedSync.createGroup({
        name: 'No implicit auth runtime',
        initialDevice: {
          name: 'No implicit auth device',
          publicKey: 'ed25519:no-implicit-runtime',
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      }),
    ).rejects.toMatchObject({ code: Code.Unimplemented });

    const preflight = await fetch(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/Health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-grpc-web',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');

    const forbidden = await fetch(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/Health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example' },
    });
    expect(forbidden.status).toBe(403);

    const legacy = await fetch(`${baseUrl}/api/health`);
    expect(legacy.status).toBe(404);
  });
});
