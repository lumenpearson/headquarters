import { describe, expect, it } from 'vitest';

import { ControlPlaneSession } from './ControlPlaneSession';
import {
  initialConnectionState,
  type ConnectionSession,
  type ConnectionState,
  type ControlPlaneCapabilities,
  type DeviceRole,
  type GroupDevice,
  type GroupSummary,
  type PairingRole,
} from './connection';
import {
  ControlPlaneError,
  type ClockSample,
  type ControlPlanePort,
  type CreateGroupRequest,
  type PairingCodeGrant,
  type PairingResult,
} from './controlPlanePort';

const installationId = '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30';
/** The same address after its database was deleted and recreated. */
const replacementInstallationId = '9a2c4b60-6f1e-4f6f-9c93-5d0f2b7a41d8';

const capabilities: ControlPlaneCapabilities = {
  installationId,
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
  revision: 4,
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
  /** What the stored session says it was minted against; `''` is unknown. */
  storedInstallation: string | null = installationId;
  expiresAt: number | null = 600_000;
  probeFails = false;
  joinError: ControlPlaneError | null = null;
  refreshError: ControlPlaneError | null = null;
  authorityError: ControlPlaneError | null = null;
  createGroupError: ControlPlaneError | null = null;
  pairingCodeError: ControlPlaneError | null = null;
  updateGroupError: ControlPlaneError | null = null;
  deviceRoleError: ControlPlaneError | null = null;
  /** Every bootstrap secret this port was handed, in order. */
  readonly bootstrapSecrets: string[] = [];
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
    this.storedInstallation = null;
  }

  storedInstallationId(): string | null {
    return this.stored === null ? null : this.storedInstallation;
  }

  adoptInstallationId(value: string): void {
    this.calls.push(`adoptInstallationId:${value}`);
    if (value === '' || this.stored === null) return;
    if (this.storedInstallation !== '' && this.storedInstallation !== null) return;
    this.storedInstallation = value;
  }

  async probeCapabilities(): Promise<ControlPlaneCapabilities> {
    this.calls.push('probeCapabilities');
    if (this.probeFails) throw new ControlPlaneError('unavailable', 'connection refused');
    return this.capabilities;
  }

  async pair(): Promise<PairingResult> {
    this.calls.push('pair');
    this.stored = identity;
    this.storedInstallation = this.capabilities.installationId;
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

  async createGroup(request: CreateGroupRequest): Promise<PairingResult> {
    this.calls.push(`createGroup:${request.name}`);
    if (this.createGroupError !== null) throw this.createGroupError;
    // The bootstrap secret is recorded separately from the transcript, so an
    // assertion that it never reached the store cannot pass because the
    // transcript happens not to print it.
    this.bootstrapSecrets.push(request.bootstrapSecret);
    this.stored = identity;
    this.storedInstallation = this.capabilities.installationId;
    this.serverGroup = { ...this.serverGroup, name: request.name };
    return {
      session: identity,
      group: this.serverGroup,
      device: { deviceId: 'device-a', name: request.deviceName, role: 'ADMIN', status: 'ONLINE' },
    };
  }

  async createPairingCode(role: PairingRole): Promise<PairingCodeGrant> {
    this.calls.push(`createPairingCode:${role}`);
    if (this.pairingCodeError !== null) throw this.pairingCodeError;
    return { code: 'PAIR-0001', role, expiresAtMs: 600_000 };
  }

  async updateGroup(name: string): Promise<GroupSummary> {
    this.calls.push(`updateGroup:${name}`);
    if (this.updateGroupError !== null) throw this.updateGroupError;
    // Every group mutation bumps the revision inside the same statement on the
    // server (`group-mutations.ts`, `groupMutationEpilogue`).
    this.serverGroup = { ...this.serverGroup, name, revision: this.serverGroup.revision + 1 };
    return this.serverGroup;
  }

  async setDeviceRole(deviceId: string, role: DeviceRole): Promise<GroupDevice> {
    this.calls.push(`setDeviceRole:${deviceId}:${role}`);
    if (this.deviceRoleError !== null) throw this.deviceRoleError;
    // The bump happens on the server here too; the answer simply does not carry
    // it, because `SetDeviceRoleResponse` holds no group.
    this.serverGroup = { ...this.serverGroup, revision: this.serverGroup.revision + 1 };
    return { deviceId, name: 'MON-01', role, status: 'ONLINE' };
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
    // Every group mutation bumps the revision inside the same statement on the
    // server (`group-mutations.ts`, `groupMutationEpilogue`); a fake that left
    // it still would let a session pass a check no deployment offers.
    this.serverGroup = {
      ...this.serverGroup,
      authority: mode,
      revision: this.serverGroup.revision + 1,
    };
    return this.serverGroup;
  }

  async setLeader(deviceId: string): Promise<GroupSummary> {
    this.calls.push(`setLeader:${deviceId}`);
    this.serverGroup = {
      ...this.serverGroup,
      leaderDeviceId: deviceId,
      revision: this.serverGroup.revision + 1,
    };
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

  /*
   * The publication half of the port. `ControlPlaneSession` calls none of these
   * -- it owns pairing, joining and the two polls -- so they record the call
   * and answer the shape, which keeps the transcript honest about what the
   * session actually reaches for.
   */
  async publishDocumentDelta() {
    this.calls.push('publishDocumentDelta');
    return { sequence: 1n, stateVector: new Uint8Array(0) };
  }

  async publishSessionCommand() {
    this.calls.push('publishSessionCommand');
    return {
      epoch: 1n,
      sequence: 1n,
      action: 'play' as const,
      target: '',
      positionSeconds: 0,
      playbackRate: 1,
      executeAtMs: 0,
      issuedByDeviceId: 'device-a',
    };
  }

  async getDocumentSnapshot() {
    this.calls.push('getDocumentSnapshot');
    return null;
  }

  async readGroupEvents() {
    this.calls.push('readGroupEvents');
    return {
      events: [],
      earliestAvailableSequence: 0n,
      hasMore: false,
      resyncRequired: false,
    };
  }
}

function session(client: FakeControlPlane, now = () => 0, from = initialConnectionState) {
  let state: ConnectionState = from;
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
  it('leaves the configured addresses on show when a session ends', async () => {
    /*
     * The addresses are a fact about the configuration, not about the session:
     * they are what an operator reads when a screen is alone, and giving up a
     * pairing does not make the group unreachable at them. Clearing them here
     * would empty the transport popover and the pairing dialog at exactly the
     * moment they are being looked at.
     */
    const client = new FakeControlPlane();
    const links = [
      {
        linkId: 'link-0',
        baseUrl: 'http://127.0.0.1:4100',
        role: 'primary' as const,
        admitted: true,
        delivery: 'socket' as const,
        status: 'live' as const,
        connectionId: 'conn-1',
        lastSequence: 4,
        resyncCount: 0,
      },
    ];
    const { created, read } = session(client, () => 0, { ...initialConnectionState, links });

    created.unpair();

    expect(read().mode).toBe('reauth-required');
    expect(read().links).toEqual(links);
  });

  it('makes no request at all while general.localOnly is on', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);

    await created.connect(true);

    // The setting promises this client stays usable without a group. A probe
    // "just to know" would break that promise on the first launch.
    expect(client.calls).toEqual([]);
    expect(read().mode).toBe('local-only');
  });

  /*
   * The reset this whole feature exists for: the address still answers, the
   * stored credentials may be perfectly good, and the database behind it is a
   * different one. Nothing may be joined, adopted or forgotten -- the operator
   * has to be told, because the alternative is discovering it by loss.
   */
  it('refuses a control plane whose database is not the one it paired with', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.storedInstallation = installationId;
    client.capabilities = { ...capabilities, installationId: replacementInstallationId };
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('installation-changed');
    // Not `reauth-required`: the credentials did not go stale, the database
    // behind them was replaced, and the two ask the operator for different
    // things.
    expect(read().failure).toContain('НЕ ТА, С КОТОРОЙ СПАРЕНО УСТРОЙСТВО');
    expect(read().session).toBeUndefined();
    // The probe, and nothing after it. No refresh, no join, no device or
    // presence read -- and above all no `forgetSession`: giving up the pairing
    // is the operator's decision, taken in the pairing dialog.
    expect(client.calls).toEqual(['probeCapabilities']);
    expect(client.stored).toBe(identity);
    expect(client.storedInstallation).toBe(installationId);
  });

  it('proceeds normally when the database is still the one it paired with', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.storedInstallation = installationId;
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('online');
    expect(client.calls).toContain('join');
  });

  /*
   * Unknown is not a mismatch, in either direction. A session paired before the
   * client recorded an identity, and a control plane older than the migration
   * that mints one, both answer `''`; refusing on either would strand a working
   * deployment on nothing more than an upgrade ordering. A replaced database
   * never presents as absent -- a fresh database that has run its migrations
   * always reports an identity -- so the guard loses nothing by proceeding.
   */
  it('proceeds, and records the identity, for a session that carries none', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.storedInstallation = '';
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('online');
    // Recorded now, so the *next* replacement of the database is caught.
    expect(client.storedInstallation).toBe(installationId);
  });

  it('proceeds when the control plane reports no identity of its own', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.storedInstallation = installationId;
    client.capabilities = { ...capabilities, installationId: '' };
    const { created, read } = session(client);

    await created.connect(false);

    expect(read().mode).toBe('online');
    // Nothing recorded from an empty report, and the identity it already holds
    // is left exactly as it was.
    expect(client.storedInstallation).toBe(installationId);
  });

  it('offers the operator the way out of a refused installation', async () => {
    const client = new FakeControlPlane();
    client.stored = identity;
    client.storedInstallation = installationId;
    client.capabilities = { ...capabilities, installationId: replacementInstallationId };
    const { created, read } = session(client);
    await created.connect(false);

    // What the pairing dialog's button does: give up the stored session
    // deliberately, and only then ask for a new code.
    created.unpair();

    expect(client.calls).toContain('forgetSession');
    expect(client.stored).toBeNull();
    expect(read().mode).toBe('reauth-required');
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

  it('records the revision every answer about the group carries', async () => {
    /*
     * The revision is what the other path -- the group log, read by
     * `connectGroupState` -- compares against, and this is the only place it
     * can be learned from a call. A session that recorded the leader without
     * the revision it was read at would leave the log free to replay an older
     * snapshot on top: the retained window is full of valid, older ones.
     */
    const client = new FakeControlPlane();
    const { created, read } = session(client);

    await created.pair('CODE-1', 'MON-01');
    expect(read().groupRevision).toBe(4);

    await created.setLeader('device-b');
    expect(read().leaderDeviceId).toBe('device-b');
    expect(read().groupRevision).toBe(5);

    await created.reconcileAuthority('multi-authority');
    expect(read().authority).toBe('multi-authority');
    expect(read().groupRevision).toBe(6);
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

/**
 * The group, made and staffed from the application rather than from a second
 * tool (R27).
 *
 * Until these four calls had a caller, a group and its first pairing code came
 * from a script and a device that joined as `VIEWER` stayed one for good.
 */
describe('ControlPlaneSession over the group administration calls', () => {
  it('creates the group, enters it, and shows it', async () => {
    const client = new FakeControlPlane();
    client.stored = null;
    const { created, read } = session(client);

    const made = await created.createGroup({
      name: 'ШТАБ',
      deviceName: 'MON-01',
      bootstrapSecret: 'secret-value',
    });

    // The claim is the observable consequence, not the call: a session that had
    // no group is in one, and the surface has a name to print.
    expect(made).toBe(true);
    expect(read().mode).toBe('online');
    expect(read().groupName).toBe('ШТАБ');
    expect(read().session).toEqual(identity);
    expect(client.bootstrapSecrets).toEqual(['secret-value']);
    // The secret is handed to the port and kept nowhere. The whole slice is
    // read rather than named fields, so a secret that reached it by any path
    // fails this.
    expect(JSON.stringify(read())).not.toContain('secret-value');
  });

  it('shows the refusal when the bootstrap secret is wrong, and joins nothing', async () => {
    const client = new FakeControlPlane();
    client.stored = null;
    client.createGroupError = new ControlPlaneError(
      'unauthenticated',
      'Bootstrap authorization is required.',
    );
    const { created, read } = session(client);

    expect(
      await created.createGroup({
        name: 'ШТАБ',
        deviceName: 'MON-01',
        bootstrapSecret: 'wrong-value',
      }),
    ).toBe(false);

    // Swallowing this would leave an operator staring at a dialog that did
    // nothing and said nothing.
    expect(read().mode).toBe('reauth-required');
    expect(read().failure).toContain('ГРУППА НЕ СОЗДАНА');
    expect(read().groupName).toBeUndefined();
    expect(client.calls).not.toContain('join');
  });

  it('records the revision a rename produced, so the retained window cannot undo it', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');
    const joinedAt = read().groupRevision;

    expect(await created.renameGroup('ШТАБ-2')).toBe(true);

    expect(read().groupName).toBe('ШТАБ-2');
    /*
     * The revision travels with the name. `UpdateGroup` publishes
     * `GROUP_UPDATED`, so the same change comes back over the log and is
     * dropped as already held; a name written without its revision would leave
     * this session behind the group it had just renamed.
     */
    expect(read().groupRevision).toBe(joinedAt + 1);
  });

  it('leaves the name alone and shows the refusal when the server denies a rename', async () => {
    const client = new FakeControlPlane();
    client.updateGroupError = new ControlPlaneError(
      'permission-denied',
      'Only an active group administrator can rename the group.',
    );
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    expect(await created.renameGroup('ШТАБ-2')).toBe(false);

    expect(read().groupName).toBe('ШТАБ');
    expect(read().failure).toContain('ЗАПРОС К CONTROL PLANE ОТКЛОНЁН');
    // A refused call is a fact about one call, not about the connection.
    expect(read().mode).toBe('online');
  });

  it('hands the issued code back and puts none of it in the slice', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    const grant = await created.createPairingCode('VIEWER');

    expect(grant).toEqual({ code: 'PAIR-0001', role: 'VIEWER', expiresAtMs: 600_000 });
    /*
     * A pairing code earns a session, which makes it a credential in exactly
     * the sense the tokens are. The slice is persisted to `localStorage`,
     * broadcast over the screen bus and copied into diagnostic reports.
     */
    expect(JSON.stringify(read())).not.toContain('PAIR-0001');
  });

  it('answers nothing and shows the refusal when a viewer asks for a pairing code', async () => {
    const client = new FakeControlPlane();
    client.pairingCodeError = new ControlPlaneError(
      'permission-denied',
      'Only an active group administrator can issue a pairing code.',
    );
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    expect(await created.createPairingCode('EDITOR')).toBeNull();

    expect(read().failure).toContain('ЗАПРОС К CONTROL PLANE ОТКЛОНЁН');
  });

  it('writes the new role into the roster from the answer, without re-reading the list', async () => {
    const client = new FakeControlPlane();
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');
    const readsBefore = client.calls.filter((entry) => entry === 'listDevices').length;

    expect(await created.setDeviceRole('device-a', 'EDITOR')).toBe(true);

    /*
     * The answer is applied because the echo may never come: a control plane
     * started without a realtime hub publishes nothing, and a poll feed is up
     * to its interval behind. `device-a` is this very session, so its own role
     * moves with the roster -- it is what every administrative control is
     * gated on.
     */
    expect(read().devices).toEqual([
      { deviceId: 'device-a', name: 'MON-01', role: 'EDITOR', status: 'ONLINE' },
    ]);
    expect(read().session?.role).toBe('EDITOR');
    expect(client.calls.filter((entry) => entry === 'listDevices')).toHaveLength(readsBefore);
  });

  it('leaves the roster alone and shows the refusal when a role change is denied', async () => {
    const client = new FakeControlPlane();
    client.deviceRoleError = new ControlPlaneError(
      'failed-precondition',
      'A group must retain at least one active administrator.',
    );
    const { created, read } = session(client);
    await created.pair('CODE-1', 'MON-01');

    expect(await created.setDeviceRole('device-a', 'VIEWER')).toBe(false);

    expect(read().devices).toEqual([
      { deviceId: 'device-a', name: 'MON-01', role: 'ADMIN', status: 'ONLINE' },
    ]);
    expect(read().session?.role).toBe('ADMIN');
    expect(read().failure).toContain('ЗАПРОС К CONTROL PLANE ОТКЛОНЁН');
  });
});
