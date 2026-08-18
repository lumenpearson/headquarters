import { describe, expect, it } from 'vitest';

import { PairedDeviceRuntime, type AuthenticatedDevice } from './runtime.js';

describe('paired-device lifecycle runtime', () => {
  it('bootstraps the first device as an administrator and stores only usable opaque credentials', () => {
    const runtime = createRuntime();

    const created = runtime.createGroup({
      name: 'Red terminal group',
      initialDevice: deviceInput('HQ primary'),
    });

    expect(created.group.authorityMode).toBe('LEADER');
    expect(created.group.leaderDeviceId).toBe(created.device.id);
    expect(created.device.role).toBe('ADMIN');
    expect(created.session).toMatchObject({
      groupId: created.group.id,
      deviceId: created.device.id,
      role: 'ADMIN',
    });
    expect(created.session.accessToken).toMatch(/^hq_access_/u);
    expect(created.session.refreshToken).toMatch(/^hq_refresh_/u);
    expect(runtime.authenticateAccessToken(created.session.accessToken)).toMatchObject({
      group: { id: created.group.id },
      device: { id: created.device.id, role: 'ADMIN' },
      role: 'ADMIN',
    });
  });

  it('issues one-time viewer/editor pairing grants and blocks duplicate public keys', () => {
    const runtime = createRuntime();
    const owner = runtime.createGroup({
      name: 'Red terminal group',
      initialDevice: deviceInput('HQ primary'),
    });
    const authenticatedOwner = authenticate(runtime, owner.session.accessToken);
    const grant = runtime.createPairingCode(authenticatedOwner, owner.group.id, 'EDITOR');

    const joined = runtime.pairDevice({
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
    });

    expect(joined.device.role).toBe('EDITOR');
    expectRuntimeError(
      () =>
        runtime.pairDevice({
          pairingCode: grant.code,
          ...deviceInput('Replay', 'ed25519:replay'),
        }),
      'UNAUTHENTICATED',
    );
    expectRuntimeError(
      () =>
        runtime.pairDevice({
          pairingCode: runtime.createPairingCode(authenticatedOwner, owner.group.id, 'VIEWER').code,
          ...deviceInput('Duplicate key', 'ed25519:analyst'),
        }),
      'ALREADY_EXISTS',
    );
  });

  it('rotates refresh credentials and invalidates revoked device sessions', () => {
    const runtime = createRuntime();
    const owner = runtime.createGroup({
      name: 'Red terminal group',
      initialDevice: deviceInput('HQ primary'),
    });
    const ownerContext = authenticate(runtime, owner.session.accessToken);
    const paired = runtime.pairDevice({
      pairingCode: runtime.createPairingCode(ownerContext, owner.group.id, 'VIEWER').code,
      ...deviceInput('HQ observer', 'ed25519:observer'),
    });

    const refreshed = runtime.refreshDeviceSession(paired.session.refreshToken);
    expect(refreshed.refreshToken).not.toBe(paired.session.refreshToken);
    expectRuntimeError(
      () => runtime.refreshDeviceSession(paired.session.refreshToken),
      'UNAUTHENTICATED',
    );

    runtime.revokeDevice(ownerContext, owner.group.id, paired.device.id);
    expectRuntimeError(
      () => runtime.authenticateAccessToken(refreshed.accessToken),
      'UNAUTHENTICATED',
    );
  });

  it('enforces group membership, actor identity, page bounds, and the final-admin guard', () => {
    const runtime = createRuntime();
    const owner = runtime.createGroup({
      name: 'Red terminal group',
      initialDevice: deviceInput('HQ primary'),
    });
    const authenticatedOwner = authenticate(runtime, owner.session.accessToken);

    expectRuntimeError(
      () => runtime.listDevices(authenticatedOwner, 'unknown-group', 50, ''),
      'NOT_FOUND',
    );
    expectRuntimeError(
      () => runtime.listDevices(authenticatedOwner, owner.group.id, 101, ''),
      'INVALID_ARGUMENT',
    );
    expectRuntimeError(
      () => runtime.assertContextActor(authenticatedOwner, 'another-device'),
      'PERMISSION_DENIED',
    );
    expectRuntimeError(
      () => runtime.revokeDevice(authenticatedOwner, owner.group.id, owner.device.id),
      'FAILED_PRECONDITION',
    );

    const page = runtime.listDevices(authenticatedOwner, owner.group.id, 1, '');
    expect(page).toMatchObject({ hasMore: false, approximateTotal: 1n });
    expect(page.items).toHaveLength(1);
  });

  it('rejects expired pairing grants and configuration that cannot protect persisted token hashes', () => {
    let now = new Date('2026-08-18T09:00:00.000Z');
    const runtime = createRuntime({ now: () => now, pairingCodeLifetimeMs: 10 });
    const owner = runtime.createGroup({
      name: 'Red terminal group',
      initialDevice: deviceInput('HQ primary'),
    });
    const grant = runtime.createPairingCode(
      authenticate(runtime, owner.session.accessToken),
      owner.group.id,
      'VIEWER',
    );
    now = new Date(now.getTime() + 10);

    expectRuntimeError(
      () =>
        runtime.pairDevice({
          pairingCode: grant.code,
          ...deviceInput('Late device', 'ed25519:late'),
        }),
      'UNAUTHENTICATED',
    );
    expect(() => new PairedDeviceRuntime({ tokenPepper: 'too-short' })).toThrow(
      'tokenPepper must contain at least 32',
    );
  });
});

function expectRuntimeError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toMatchObject({ name: 'PairedDeviceRuntimeError', code });
    return;
  }
  throw new Error(`Expected PairedDeviceRuntimeError with code ${code}`);
}
function createRuntime(
  options: Partial<ConstructorParameters<typeof PairedDeviceRuntime>[0]> = {},
): PairedDeviceRuntime {
  let entropyOffset = 0;
  return new PairedDeviceRuntime({
    tokenPepper: 'test-token-pepper-with-at-least-thirty-two-characters',
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (entropyOffset + index) & 0xff;
      }
      entropyOffset += size;
      return bytes;
    },
    ...options,
  });
}

function deviceInput(name: string, publicKey = 'ed25519:primary') {
  return {
    name,
    publicKey,
    platform: 'windows',
    applicationVersion: '0.1.0',
  };
}

function authenticate(runtime: PairedDeviceRuntime, accessToken: string): AuthenticatedDevice {
  return runtime.authenticateAccessToken(accessToken);
}
