import { describe, expect, it } from 'vitest';

import { ControlPlaneSession } from './ControlPlaneSession';
import {
  initialConnectionState,
  type ConnectionSession,
  type ConnectionState,
  type ControlPlaneCapabilities,
} from './connection';
import {
  ControlPlaneError,
  type ClockSample,
  type ControlPlanePort,
  type GroupSummary,
  type PairingResult,
} from './controlPlanePort';

const capabilities: ControlPlaneCapabilities = {
  sync: true,
  deviceLifecycle: true,
  realtimeAdmission: true,
  settings: true,
  materials: false,
};

const group: GroupSummary = {
  groupId: 'group-a',
  name: 'ШТАБ',
  authority: 'leader',
  leaderDeviceId: 'device-a',
};

const identity: ConnectionSession = { deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' };

/**
 * A control plane stated as a port, not a mock counting calls.
 *
 * `calls` is the transcript, and the local-only claim is the reason it exists:
 * "no request leaves this machine" can only be shown by holding the whole port
 * and finding it untouched.
 */
class FakeControlPlane implements ControlPlanePort {
  readonly baseUrl = 'http://127.0.0.1:4100';
  readonly calls: string[] = [];
  stored: ConnectionSession | null = null;
  expiresAt: number | null = 600_000;
  probeFails = false;
  joinError: ControlPlaneError | null = null;
  refreshError: ControlPlaneError | null = null;
  authorityError: ControlPlaneError | null = null;
  capabilities: ControlPlaneCapabilities = capabilities;
  serverGroup: GroupSummary = group;
  samples: ClockSample[] = [];
  refreshes = 0;

  session(): ConnectionSession | null {
    return this.stored;
  }

  accessTokenExpiresAt(): number | null {
    return this.stored === null ? null : this.expiresAt;
  }

  forgetSession(): void {
    this.calls.push('forgetSession');
    this.stored = null;
  }

  async probeCapabilities(): Promise<ControlPlaneCapabilities> {
    this.calls.push('probeCapabilities');
    if (this.probeFails) throw new ControlPlaneError('unavailable', 'connection refused');
    return this.capabilities;
  }

  async pair(): Promise<PairingResult> {
    this.calls.push('pair');
    this.stored = identity;
    return {
      session: identity,
      group: this.serverGroup,
      device: {
        deviceId: 'device-a',
        name: 'MON-01',
        role: 'ADMIN',
        status: 'ONLINE',
      },
    };
  }

  async refresh(): Promise<ConnectionSession> {
    this.calls.push('refresh');
    this.refreshes += 1;
    if (this.refreshError !== null) {
      const error = this.refreshError;
      this.stored = null;
      throw error;
    }
    this.expiresAt = 600_000;
    return identity;
  }

  async join(): Promise<GroupSummary> {
    this.calls.push('join');
    if (this.joinError !== null) throw this.joinError;
    return this.serverGroup;
  }

  async leave(): Promise<void> {
    this.calls.push('leave');
  }

  async listDevices() {
    this.calls.push('listDevices');
    return [
      { deviceId: 'device-a', name: 'MON-01', role: 'ADMIN' as const, status: 'ONLINE' as const },
    ];
  }

  async revoke(): Promise<void> {
    this.calls.push('revoke');
  }

  async setAuthorityMode(mode: 'leader' | 'multi-authority'): Promise<GroupSummary> {
    this.calls.push(`setAuthorityMode:${mode}`);
    if (this.authorityError !== null) throw this.authorityError;
    this.serverGroup = { ...this.serverGroup, authority: mode };
    return this.serverGroup;
  }

  async setLeader(deviceId: string): Promise<GroupSummary> {
    this.calls.push(`setLeader:${deviceId}`);
    this.serverGroup = { ...this.serverGroup, leaderDeviceId: deviceId };
    return this.serverGroup;
  }

  async timeSync(): Promise<ClockSample> {
    this.calls.push('timeSync');
    const next = this.samples.shift();
    return next ?? { clientSendMs: 0, serverReceiveMs: 0, serverSendMs: 0, clientReceiveMs: 0 };
  }

  async getPresence() {
    this.calls.push('getPresence');
    return [
      {
        deviceId: 'device-b',
        status: 'OFFLINE' as const,
        activeScreen: '',
        clockOffsetMs: 0,
        latencyMs: 0,
        observedAt: '',
      },
      {
        deviceId: 'device-c',
        status: 'ONLINE' as const,
        activeScreen: '/map',
        clockOffsetMs: 4,
        latencyMs: 9,
        observedAt: '',
      },
    ];
  }
}

function session(client: FakeControlPlane, now = () => 0) {
  let state: ConnectionState = initialConnectionState;
  const created = new ControlPlaneSession({
    client,
    apply: (patch) => {
      state = { ...state, ...patch };
    },
    now,
    clockRounds: 3,
    refreshLeadMs: 60_000,
  });
  return { created, read: () => state };
}

describe('ControlPlaneSession', () => {
  it('makes no request at all while general.localOnly is on', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);

    await created.connect(true);

    // The setting promises this client stays usable without a group. A probe
    // "just to know" would break that promise on the first launch.
    expect(client.calls).toEqual([]);
    expect(read().mode).toBe('local-only');
  });

  it('goes offline when the control plane does not answer the probe', async () => {
    const client = new FakeControlPlane();
    client.probeFails = true;
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('offline');
    expect(read().failure).toContain('connection refused');
    // Nothing is attempted past the probe: there is no service to attempt it against.
    expect(client.calls).toEqual(['probeCapabilities']);
  });

  it('asks for a pairing code when the control plane answers but nothing is paired', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('reauth-required');
    // The capabilities survive: what the deployment can do is known even
    // though this device cannot yet use it.
    expect(read().capabilities).toEqual(capabilities);
  });

  it('refuses to offer pairing to a control plane started without device lifecycle', async () => {
    const client = new FakeControlPlane();
    client.capabilities = { ...capabilities, deviceLifecycle: false };
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('offline');
    expect(client.calls).toEqual(['probeCapabilities']);
  });

  it('joins, reads the roster and estimates the clock after pairing', async () => {
    const client = new FakeControlPlane();
    client.samples = [
      { clientSendMs: 0, serverReceiveMs: 60, serverSendMs: 62, clientReceiveMs: 20 },
      { clientSendMs: 0, serverReceiveMs: 55, serverSendMs: 57, clientReceiveMs: 20 },
      { clientSendMs: 0, serverReceiveMs: 900, serverSendMs: 902, clientReceiveMs: 20 },
    ];
    const { created, read } = session(client);

    await created.pair('CODE-1', 'MON-01');

    expect(read().mode).toBe('online');
    expect(read().session).toEqual(identity);
    expect(read().groupName).toBe('ШТАБ');
    expect(read().authority).toBe('leader');
    expect(client.calls).toEqual([
      'pair',
      'join',
      'listDevices',
      'getPresence',
      'timeSync',
      'timeSync',
      'timeSync',
    ]);
    /*
     * The rounds estimate 51, 46 and 891 ms of offset -- the third delayed by
     * 840 ms somewhere in the network. The median is 51, so the delayed round
     * moves the answer by nothing at all; a mean would have reported 329.
     */
    expect(read().clock.offsetMs).toBe(51);
    // Latency has the server's own processing removed: 20 ms round trip less
    // the 2 ms between the server's receive and send instants.
    expect(read().clock.latencyMs).toBe(18);
    // Online sessions sort first, so the list does not reorder under the pointer.
    expect(read().presence.map((entry) => entry.deviceId)).toEqual(['device-c', 'device-b']);
  });

  it('stays online without presence when the deployment has no presence store', async () => {
    const client = new FakeControlPlane();
    client.joinError = new ControlPlaneError('unimplemented', 'no presence storage');
    const { created, read } = session(client);

    await created.pair('CODE-1', 'MON-01');

    // Paired and authenticated is not the same fact as unreachable; a reduced
    // deployment must not read as a broken one.
    expect(read().mode).toBe('online');
    expect(read().failure).toContain('ПРИСУТСТВИЯ');
  });

  it('rotates the access token when it is near expiry, and only then', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.expiresAt = 600_000;
    const { created } = session(client, () => 0);

    await created.connect(false);
    expect(client.refreshes).toBe(0);

    // 30 s of lead left against a 60 s threshold: the next use rotates.
    client.expiresAt = 30_000;
    await created.refreshPresence();
    expect(client.refreshes).toBe(1);
  });

  it('asks for a new code when the session is refused', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.expiresAt = 0;
    client.refreshError = new ControlPlaneError('unauthenticated', 'session revoked');
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('reauth-required');
    expect(read().session).toBeUndefined();
    // The whole family is dead; retrying against it would only earn a second refusal.
    expect(client.calls).toContain('forgetSession');
  });

  it('sends an administrator’s authority change and keeps the group’s answer', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    const outcome = await created.reconcileAuthority('multi-authority');

    expect(outcome.reflect).toBeUndefined();
    expect(client.calls).toContain('setAuthorityMode:multi-authority');
    expect(read().authority).toBe('multi-authority');
  });

  it('reflects the group’s mode into the setting for a device that cannot change it', async () => {
    const client = new FakeControlPlane();
    client.serverGroup = { ...group, authority: 'multi-authority' };
    const { created } = session(client);
    await created.pair('CODE-1', 'MON-01');
    // An editor moving their own copy of a group-scoped control is not the
    // group deciding; the server's answer is what stands.
    (client as { stored: ConnectionSession | null }).stored = {
      ...identity,
      role: 'EDITOR',
    };
    await created.connect(false);

    const outcome = await created.reconcileAuthority('leader');

    expect(outcome.reflect).toBe('multi-authority');
    expect(client.calls).not.toContain('setAuthorityMode:leader');
  });

  it('does nothing while the setting and the group already agree', async () => {
    const client = new FakeControlPlane();
    const { created } = session(client);
    await created.pair('CODE-1', 'MON-01');
    const before = client.calls.length;

    expect(await created.reconcileAuthority('leader')).toEqual({});
    expect(client.calls).toHaveLength(before);
  });

  it('reflects the group’s mode when the server refuses the change', async () => {
    const client = new FakeControlPlane();
    client.authorityError = new ControlPlaneError('permission-denied', 'admin required');
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    const outcome = await created.reconcileAuthority('multi-authority');

    // Otherwise the two disagree on every later pass and the client sends the
    // same refused request forever.
    expect(outcome.reflect).toBe('leader');
    expect(read().mode).toBe('online');
  });

  it('keeps the pairing when the session merely leaves the group', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    await created.leave();

    // Leaving is participation, not membership: rejoining needs no new code.
    expect(read().mode).toBe('offline');
    expect(client.calls).not.toContain('forgetSession');
    expect(read().presence).toEqual([]);
  });

  it('gives up the pairing on unpair', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    created.unpair();

    expect(client.calls).toContain('forgetSession');
    expect(read().mode).toBe('reauth-required');
    expect(read().groupName).toBeUndefined();
  });
});
