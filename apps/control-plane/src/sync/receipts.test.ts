import { describe, expect, it } from 'vitest';

import { encodeFingerprintPayload, normalizeRequestId } from './receipts.js';
import { PairedDeviceRuntime, type AuthenticatedDevice } from './runtime.js';

/**
 * These exercise the deterministic runtime rather than generated SQL, because
 * the properties under test are behavioural: whether a retry performs a second
 * mutation, whether it is misread as a replay attack, and whether a receipt
 * survives a later revoke. A statement-shape assertion cannot observe any of
 * them.
 */
describe('mutation idempotency receipts', () => {
  it('answers a retried pairing from the receipt instead of consuming the code twice', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const grant = runtime.createPairingCode(owner.authenticated, owner.group.id, 'EDITOR');
    const request = {
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation: { requestId: 'req-pair-1' },
    };

    const first = runtime.pairDevice(request);
    const retry = runtime.pairDevice(request);

    expect(retry.device.id).toBe(first.device.id);
    expect(retry.group.id).toBe(first.group.id);
    // One mutation, therefore one revision bump: a second redemption would
    // have advanced the group again.
    expect(retry.group.revision).toBe(first.group.revision);
    expect(listDeviceIds(runtime, owner)).toEqual([owner.device.id, first.device.id]);
    // Credentials are re-issued rather than replayed, because the response was
    // never stored. What the caller needs is that they work.
    expect(retry.session.accessToken).not.toBe(first.session.accessToken);
    expect(runtime.authenticateAccessToken(retry.session.accessToken)).toMatchObject({
      device: { id: first.device.id },
      role: 'EDITOR',
    });
  });

  it('keeps a retried pairing failing closed once the paired device is revoked', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const grant = runtime.createPairingCode(owner.authenticated, owner.group.id, 'EDITOR');
    const request = {
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation: { requestId: 'req-pair-revoked' },
    };
    const paired = runtime.pairDevice(request);

    runtime.revokeDevice(owner.authenticated, owner.group.id, paired.device.id);

    // The receipt records identity, not authority: it must not resurrect a
    // credential for a membership that no longer exists.
    expectRuntimeError(() => runtime.pairDevice(request), 'UNAUTHENTICATED');
  });

  it('rejects a request identifier reused with a different payload', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const first = runtime.createPairingCode(owner.authenticated, owner.group.id, 'EDITOR');
    const second = runtime.createPairingCode(owner.authenticated, owner.group.id, 'VIEWER');
    runtime.pairDevice({
      pairingCode: first.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation: { requestId: 'req-collision' },
    });

    expectRuntimeError(
      () =>
        runtime.pairDevice({
          pairingCode: second.code,
          ...deviceInput('HQ intruder', 'ed25519:intruder'),
          mutation: { requestId: 'req-collision' },
        }),
      'ALREADY_EXISTS',
    );
  });

  it('leaves the identifier reusable when the mutation itself failed', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const mutation = { requestId: 'req-after-failure' };

    expectRuntimeError(
      () =>
        runtime.pairDevice({
          pairingCode: 'hq_pair_not-a-real-code',
          ...deviceInput('HQ analyst', 'ed25519:analyst'),
          mutation,
        }),
      'UNAUTHENTICATED',
    );

    // A claim that never completed carries no authority, so a genuine attempt
    // with the same identifier must still succeed.
    const grant = runtime.createPairingCode(owner.authenticated, owner.group.id, 'EDITOR');
    const paired = runtime.pairDevice({
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation,
    });
    expect(paired.device.role).toBe('EDITOR');
  });

  it('treats a retried refresh as a retry and an unidentified one as a replay attack', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const mutation = { requestId: 'req-refresh-1' };

    const rotated = runtime.refreshDeviceSession(owner.session.refreshToken, mutation);
    // The retry presents the same, now-retired token. Without a receipt this is
    // indistinguishable from a stolen-credential replay.
    const retry = runtime.refreshDeviceSession(owner.session.refreshToken, mutation);

    expect(retry.deviceId).toBe(rotated.deviceId);
    expect(retry.accessToken).not.toBe(rotated.accessToken);
    expect(runtime.authenticateAccessToken(retry.accessToken)).toMatchObject({
      device: { id: owner.device.id },
      role: 'ADMIN',
    });

    // The same presentation without a request identifier keeps its fail-closed
    // meaning, so receipts add a retry path without weakening replay defence.
    expectRuntimeError(
      () => runtime.refreshDeviceSession(owner.session.refreshToken),
      'UNAUTHENTICATED',
    );
    expectRuntimeError(
      () => runtime.refreshDeviceSession(retry.refreshToken, { requestId: 'req-refresh-2' }),
      'UNAUTHENTICATED',
    );
  });

  it('does not let a receipt outlive revocation of its session family', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const analyst = pairAnalyst(runtime, owner);
    const mutation = { requestId: 'req-refresh-revoked' };
    runtime.refreshDeviceSession(analyst.session.refreshToken, mutation);

    runtime.revokeDevice(owner.authenticated, owner.group.id, analyst.device.id);

    expectRuntimeError(
      () => runtime.refreshDeviceSession(analyst.session.refreshToken, mutation),
      'UNAUTHENTICATED',
    );
  });

  it('expires a receipt so a retry cannot mint credentials indefinitely', () => {
    let clock = new Date('2026-08-20T10:00:00.000Z');
    const runtime = createRuntime({
      now: () => clock,
      mutationReceiptLifetimeMs: 60_000,
    });
    const owner = bootstrap(runtime);
    const mutation = { requestId: 'req-refresh-expiry' };
    runtime.refreshDeviceSession(owner.session.refreshToken, mutation);

    clock = new Date(clock.getTime() + 61_000);

    // Past its retention window the receipt is gone, so the retired token is
    // read as a replay again rather than as a retry.
    expectRuntimeError(
      () => runtime.refreshDeviceSession(owner.session.refreshToken, mutation),
      'UNAUTHENTICATED',
    );
  });

  it('scopes the receipt to one operation so an identifier cannot cross mutations', () => {
    const runtime = createRuntime();
    const owner = bootstrap(runtime);
    const grant = runtime.createPairingCode(owner.authenticated, owner.group.id, 'EDITOR');
    const requestId = 'req-shared-identifier';

    const paired = runtime.pairDevice({
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation: { requestId },
    });

    // Same identifier, different RPC: it must perform its own mutation instead
    // of colliding with the pairing receipt.
    const refreshed = runtime.refreshDeviceSession(owner.session.refreshToken, { requestId });
    expect(refreshed.deviceId).toBe(owner.device.id);
    expect(refreshed.deviceId).not.toBe(paired.device.id);
  });
});

describe('mutation receipt encoding', () => {
  it('rejects an unbounded request identifier and normalizes the proto3 default', () => {
    expect(normalizeRequestId(undefined)).toBeUndefined();
    expect(normalizeRequestId('')).toBeUndefined();
    expect(normalizeRequestId('   ')).toBeUndefined();
    expect(normalizeRequestId('  req-1  ')).toBe('req-1');
    expect(() => normalizeRequestId('x'.repeat(201))).toThrow('must not exceed');
  });

  it('cannot be made to collide by moving text across field boundaries', () => {
    // Without length prefixes these two field sets serialize identically.
    const left = encodeFingerprintPayload('PAIR_DEVICE', [
      ['name', 'ab'],
      ['platform', 'c'],
    ]);
    const right = encodeFingerprintPayload('PAIR_DEVICE', [
      ['name', 'a'],
      ['platform', 'bc'],
    ]);

    expect(left).not.toBe(right);
  });
});

interface BootstrappedOwner {
  readonly group: { readonly id: string };
  readonly device: { readonly id: string };
  readonly session: { readonly accessToken: string; readonly refreshToken: string };
  readonly authenticated: AuthenticatedDevice;
}

function bootstrap(runtime: PairedDeviceRuntime): BootstrappedOwner {
  const created = runtime.createGroup({
    name: 'Red terminal group',
    initialDevice: deviceInput('HQ primary'),
  });
  return {
    group: created.group,
    device: created.device,
    session: created.session,
    authenticated: runtime.authenticateAccessToken(created.session.accessToken),
  };
}

function pairAnalyst(
  runtime: PairedDeviceRuntime,
  owner: BootstrappedOwner,
): {
  readonly device: { readonly id: string };
  readonly session: { readonly refreshToken: string };
} {
  const grant = runtime.createPairingCode(owner.authenticated, owner.group.id, 'EDITOR');
  const paired = runtime.pairDevice({
    pairingCode: grant.code,
    ...deviceInput('HQ analyst', 'ed25519:analyst'),
  });
  return { device: paired.device, session: paired.session };
}

function listDeviceIds(runtime: PairedDeviceRuntime, owner: BootstrappedOwner): readonly string[] {
  return runtime
    .listDevices(runtime.authenticateAccessToken(owner.session.accessToken), owner.group.id, 50, '')
    .items.map((device) => device.id);
}

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
