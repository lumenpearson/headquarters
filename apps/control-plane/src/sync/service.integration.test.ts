import type { AddressInfo } from 'node:net';

import { Code, createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ControlPlaneService, SyncService, syncV1 } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startControlPlane } from '../server.js';

import { PairedDeviceRuntime } from './runtime.js';
import { createBootstrapSecretVerifier, createPairedDeviceSyncService } from './service.js';

const bootstrapSecret = 'test-bootstrap-secret-with-at-least-thirty-two-characters';

describe('authenticated paired-device SyncService', () => {
  let closeControlPlane: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  });

  it('serves a typed bootstrap, pairing, refresh, directory, and revocation lifecycle', async () => {
    const runtime = new PairedDeviceRuntime({
      tokenPepper: 'test-token-pepper-with-at-least-thirty-two-characters',
    });
    const running = await startControlPlane(
      {
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['http://127.0.0.1:3000'],
      },
      {
        syncService: createPairedDeviceSyncService({
          runtime,
          verifyBootstrapSecret: createBootstrapSecretVerifier(bootstrapSecret),
        }),
      },
    );
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const transport = createGrpcWebTransport({ baseUrl, useBinaryFormat: true });
    const sync = createClient(SyncService, transport);
    const control = createClient(ControlPlaneService, transport);

    await expect(
      sync.createGroup({
        name: 'Gremuchaya operational group',
        initialDevice: initialDevice('Primary workstation', 'ed25519:primary'),
      }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    const created = await sync.createGroup(
      {
        name: 'Gremuchaya operational group',
        initialDevice: initialDevice('Primary workstation', 'ed25519:primary'),
      },
      { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
    );
    const group = required(created.group, 'createGroup.group');
    const owner = required(created.device, 'createGroup.device');
    const ownerSession = required(created.session, 'createGroup.session');
    expect(owner.role).toBe(syncV1.DeviceRole.ADMIN);
    expect(group.leaderDeviceId?.value).toBe(owner.id?.value);
    expect(created.accessToken).toBeUndefined();

    await expect(
      sync.createPairingCode({
        groupId: group.id,
        role: syncV1.DeviceRole.EDITOR,
        context: mutationContext('pairing-without-bearer', owner.id?.value ?? ''),
      }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    await expect(
      sync.createPairingCode(
        {
          groupId: group.id,
          role: syncV1.DeviceRole.ADMIN,
          context: mutationContext('admin-pairing-code', owner.id?.value ?? ''),
        },
        bearer(ownerSession.accessToken),
      ),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });

    const grant = required(
      (
        await sync.createPairingCode(
          {
            groupId: group.id,
            role: syncV1.DeviceRole.EDITOR,
            context: mutationContext('editor-pairing-code', owner.id?.value ?? ''),
          },
          bearer(ownerSession.accessToken),
        )
      ).pairingCode,
      'createPairingCode.pairingCode',
    );
    expect(grant.role).toBe(syncV1.DeviceRole.EDITOR);

    const paired = await sync.pairDevice({
      pairingCode: grant.code,
      deviceName: 'Analyst workstation',
      publicKey: 'ed25519:analyst',
      platform: 'windows',
      applicationVersion: '0.1.0',
      context: mutationContext('pair-device', ''),
    });
    const pairedDevice = required(paired.device, 'pairDevice.device');
    const pairedSession = required(paired.session, 'pairDevice.session');
    expect(pairedDevice.role).toBe(syncV1.DeviceRole.EDITOR);
    expect(paired.accessToken).toBe('');
    expect(paired.refreshToken).toBe('');

    const directory = await sync.listDevices(
      { groupId: group.id, page: { pageSize: 1 } },
      bearer(pairedSession.accessToken),
    );
    expect(directory.devices).toHaveLength(1);
    expect(directory.page?.hasMore).toBe(true);
    expect(directory.page?.nextCursor).not.toBe('');

    const refreshed = required(
      (
        await sync.refreshDeviceSession({
          refreshToken: pairedSession.refreshToken,
          context: mutationContext('refresh-device', ''),
        })
      ).session,
      'refreshDeviceSession.session',
    );
    expect(refreshed.refreshToken).not.toBe(pairedSession.refreshToken);
    await expect(
      sync.refreshDeviceSession({
        refreshToken: pairedSession.refreshToken,
        context: mutationContext('replay-refresh-device', ''),
      }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    const revoked = await sync.revokeDevice(
      {
        groupId: group.id,
        deviceId: pairedDevice.id,
        context: mutationContext('revoke-device', owner.id?.value ?? ''),
      },
      bearer(ownerSession.accessToken),
    );
    expect(revoked.result?.resourceId?.value).toBe(pairedDevice.id?.value);
    await expect(
      sync.listDevices({ groupId: group.id }, bearer(refreshed.accessToken)),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    const capabilities = await control.getCapabilities({});
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'sync.device-lifecycle',
      version: 'v1',
      enabled: true,
    });
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'sync',
      version: 'v1',
      enabled: false,
    });

    const preflight = await fetch(`${baseUrl}/gremuchaya.sync.v1.SyncService/ListDevices`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,x-hq-bootstrap-secret,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'x-hq-bootstrap-secret',
    );

    await expect(
      sync.updateGroup(
        { groupId: group.id, name: 'Not implemented' },
        bearer(ownerSession.accessToken),
      ),
    ).rejects.toMatchObject({ code: Code.Unimplemented });
  });
});

function initialDevice(name: string, publicKey: string) {
  return {
    name,
    publicKey,
    platform: 'windows',
    applicationVersion: '0.1.0',
  };
}

function mutationContext(requestId: string, actorDeviceId: string) {
  return {
    requestId,
    correlationId: `correlation-${requestId}`,
    ...(actorDeviceId.length === 0 ? {} : { actorDeviceId: { value: actorDeviceId } }),
  };
}

function bearer(accessToken: string) {
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`${field} was unexpectedly absent`);
  return value;
}
