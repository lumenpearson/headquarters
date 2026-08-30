import { Code, ConnectError } from '@connectrpc/connect';
import { syncV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import {
  ControlPlaneClient,
  type ControlRpcClient,
  type SyncRpcClient,
} from './ControlPlaneClient';
import { DeviceSessionStore, memoryStorage } from './DeviceSessionStore';

function timestamp(epochMs: number) {
  return { seconds: BigInt(Math.floor(epochMs / 1000)), nanos: 0 };
}

interface Recorded {
  readonly refreshRequestIds: string[];
  readonly mutationContexts: { readonly requestId: string; readonly actorDeviceId?: string }[];
  /**
   * `<method>:<secret or ->` for every call that could carry the bootstrap
   * header, so a claim about which one presents it is read off a transcript
   * rather than off a single spy.
   */
  readonly bootstrapHeaders: string[];
  /**
   * What each pairing call presented as `public_key`. The control plane
   * refuses an empty one (`durable-runtime.ts`, `normalizeDeviceInput`), so
   * an empty entry here is a pairing that fails against every deployed
   * plane.
   */
  readonly publicKeys: string[];
}

/** What the transport would actually have put on the wire for this call. */
function bootstrapHeader(options: { readonly headers?: HeadersInit } | undefined): string {
  return new Headers(options?.headers ?? {}).get('x-hq-bootstrap-secret') ?? '-';
}

/**
 * A `SyncService` stated as the wire states it, not a spy on one. The claim
 * under test is which identifier crosses the wire on a retry, and only a fake
 * that keeps every request can answer that.
 */
function syncClient(recorded: Recorded, overrides: Partial<SyncRpcClient> = {}): SyncRpcClient {
  let refreshes = 0;
  const base: SyncRpcClient = {
    async createGroup(request, options) {
      recorded.mutationContexts.push({ requestId: request.context.requestId });
      recorded.bootstrapHeaders.push(`createGroup:${bootstrapHeader(options)}`);
      recorded.publicKeys.push(request.initialDevice.publicKey);
      return {
        group: {
          id: { value: 'group-a' },
          name: request.name,
          authorityMode: syncV1.AuthorityMode.MULTI_AUTHORITY,
          leaderDeviceId: { value: 'device-a' },
          revision: { number: 1n },
        },
        device: {
          id: { value: 'device-a' },
          name: request.initialDevice.name,
          role: syncV1.DeviceRole.ADMIN,
          status: syncV1.DeviceStatus.ONLINE,
        },
        session: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          accessTokenExpiresAt: timestamp(60_000),
          refreshTokenExpiresAt: timestamp(600_000),
          deviceId: { value: 'device-a' },
          groupId: { value: 'group-a' },
          role: syncV1.DeviceRole.ADMIN,
        },
      };
    },
    async createPairingCode(request, options) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      recorded.bootstrapHeaders.push(`createPairingCode:${bootstrapHeader(options)}`);
      return {
        pairingCode: {
          code: 'PAIR-0001',
          groupId: request.groupId,
          role: request.role,
          expiresAt: timestamp(600_000),
        },
      };
    },
    async updateGroup(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {
        group: {
          id: { value: 'group-a' },
          name: request.name,
          authorityMode: syncV1.AuthorityMode.LEADER,
          leaderDeviceId: { value: 'device-a' },
          revision: { number: 9n },
        },
      };
    },
    async setDeviceRole(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {
        device: {
          id: request.deviceId,
          name: 'MON-02',
          role: request.role,
          status: syncV1.DeviceStatus.ONLINE,
        },
      };
    },
    async pairDevice(request, options) {
      recorded.mutationContexts.push({ requestId: request.context.requestId });
      recorded.bootstrapHeaders.push(`pairDevice:${bootstrapHeader(options)}`);
      recorded.publicKeys.push(request.publicKey);
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: syncV1.AuthorityMode.LEADER,
          leaderDeviceId: { value: 'device-a' },
        },
        device: {
          id: { value: 'device-a' },
          name: request.deviceName,
          role: syncV1.DeviceRole.EDITOR,
          status: syncV1.DeviceStatus.ONLINE,
        },
        session: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          accessTokenExpiresAt: timestamp(60_000),
          refreshTokenExpiresAt: timestamp(600_000),
          deviceId: { value: 'device-a' },
          groupId: { value: 'group-a' },
          role: syncV1.DeviceRole.EDITOR,
        },
      };
    },
    async refreshDeviceSession(request) {
      recorded.refreshRequestIds.push(request.context.requestId);
      refreshes += 1;
      return {
        session: {
          accessToken: `access-${refreshes + 1}`,
          refreshToken: `refresh-${refreshes + 1}`,
          accessTokenExpiresAt: timestamp(120_000),
          refreshTokenExpiresAt: timestamp(600_000),
          deviceId: { value: 'device-a' },
          groupId: { value: 'group-a' },
          role: syncV1.DeviceRole.EDITOR,
        },
      };
    },
    async listDevices() {
      return { devices: [], page: { nextCursor: '', hasMore: false } };
    },
    async revokeDevice(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {};
    },
    async joinGroup(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: syncV1.AuthorityMode.MULTI_AUTHORITY,
          leaderDeviceId: { value: 'device-a' },
        },
      };
    },
    async leaveGroup() {
      return {};
    },
    async setAuthorityMode(request) {
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: request.mode,
          leaderDeviceId: { value: 'device-a' },
        },
      };
    },
    async setLeader(request) {
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: syncV1.AuthorityMode.LEADER,
          leaderDeviceId: { value: request.deviceId.value },
        },
      };
    },
    async timeSync() {
      return { serverReceiveTime: timestamp(5_000), serverSendTime: timestamp(5_000) };
    },
    async publishDocumentDelta() {
      return { sequence: 7n, stateVector: new Uint8Array([1]) };
    },
    async publishSessionCommand(request) {
      // The server overwrites both numbers; the fake does the same, so a test
      // asserting the client adopted them cannot pass by accident.
      return { command: { ...request.command, epoch: 4n, sequence: 11n } };
    },
    async getDocumentSnapshot() {
      return {
        snapshot: new Uint8Array([9]),
        stateVector: new Uint8Array([8]),
        sequence: 42n,
        documentType: syncV1.SynchronizedDocumentType.SETTINGS,
      };
    },
    async getPresence() {
      return {
        devices: [
          {
            deviceId: { value: 'device-b' },
            status: syncV1.DeviceStatus.ONLINE,
            activeScreen: '/map',
            clockOffsetMs: 12n,
            latencyMs: 8,
            observedAt: timestamp(1_000),
          },
        ],
      };
    },
    async updatePresence(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {
        devices: [
          {
            deviceId: { value: 'device-a' },
            status: syncV1.DeviceStatus.ONLINE,
            activeScreen: request.detail.activeScreen,
            clockOffsetMs: request.detail.clockOffsetMs,
            latencyMs: request.detail.latencyMs,
            observedAt: timestamp(2_000),
          },
        ],
      };
    },
    async readGroupEvents() {
      return {
        events: [],
        earliestAvailableSequence: 0n,
        hasMore: false,
        resyncRequired: false,
      };
    },
  };
  return { ...base, ...overrides };
}

const installationId = '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30';

function controlRpcClient(reported = installationId): ControlRpcClient {
  return {
    async getCapabilities() {
      return {
        installationId: reported,
        capabilities: [
          { name: 'sync', enabled: true },
          { name: 'sync.device-lifecycle', enabled: true },
          { name: 'sync.realtime-admission', enabled: false },
          { name: 'settings', enabled: true },
          { name: 'materials', enabled: false },
        ],
      };
    },
  };
}

const controlClient: ControlRpcClient = controlRpcClient();

function client(options: { readonly sync?: SyncRpcClient; readonly now?: () => number } = {}) {
  const recorded: Recorded = {
    refreshRequestIds: [],
    mutationContexts: [],
    bootstrapHeaders: [],
    publicKeys: [],
  };
  const store = new DeviceSessionStore(memoryStorage());
  let minted = 0;
  const created = new ControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4100',
    sessionStore: store,
    clients: { control: controlClient, sync: options.sync ?? syncClient(recorded) },
    mintRequestId: () => {
      minted += 1;
      return `request-${minted}`;
    },
    now: options.now ?? (() => 0),
  });
  return { client: created, store, recorded };
}

describe('ControlPlaneClient', () => {
  it('reports only the capabilities the control plane says are enabled', async () => {
    const { client: created } = client();

    expect(await created.probeCapabilities()).toEqual({
      installationId,
      sync: true,
      deviceLifecycle: true,
      realtimeAdmission: false,
      settings: true,
      materials: false,
    });
  });

  it('stores the session envelope and never the deprecated scalar fields', async () => {
    const { client: created, store } = client();

    const paired = await created.pair('CODE-1', 'MON-01');

    expect(paired.session).toEqual({
      deviceId: 'device-a',
      groupId: 'group-a',
      role: 'EDITOR',
    });
    expect(paired.group.authority).toBe('leader');
    expect(store.read()?.accessToken).toBe('access-1');
    // The token belongs to the session store; the identity the store exposes
    // carries none of it.
    expect(Object.keys(paired.session)).toEqual(['deviceId', 'groupId', 'role']);
  });

  it('replays one request id while a refresh is unanswered and mints a new one after', async () => {
    const failing = { failures: 1 };
    const recorded: Recorded = {
      refreshRequestIds: [],
      mutationContexts: [],
      bootstrapHeaders: [],
      publicKeys: [],
    };
    const sync = syncClient(recorded, {
      async refreshDeviceSession(request) {
        recorded.refreshRequestIds.push(request.context.requestId);
        if (failing.failures > 0) {
          failing.failures -= 1;
          throw new ConnectError('network', Code.Unavailable);
        }
        return {
          session: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            accessTokenExpiresAt: timestamp(120_000),
            refreshTokenExpiresAt: timestamp(600_000),
            deviceId: { value: 'device-a' },
            groupId: { value: 'group-a' },
            role: syncV1.DeviceRole.EDITOR,
          },
        };
      },
    });
    const store = new DeviceSessionStore(memoryStorage());
    let minted = 0;
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => {
        minted += 1;
        return `request-${minted}`;
      },
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await expect(created.refresh()).rejects.toThrow();
    await created.refresh();
    await created.refresh();

    /*
     * The first two entries are one attempt and its retry, and they must be
     * identical: `RefreshDeviceSession` rotates destructively, and a retry
     * carrying a *different* id is what the server reads as a stolen token
     * being replayed -- it then revokes the whole family. The third is a new
     * attempt after a success, so it carries a new receipt.
     */
    const [first, second, third] = recorded.refreshRequestIds;
    expect(recorded.refreshRequestIds).toHaveLength(3);
    expect(second).toBe(first);
    expect(third).not.toBe(second);
  });

  it('forgets the session when a refresh is refused outright', async () => {
    const recorded: Recorded = {
      refreshRequestIds: [],
      mutationContexts: [],
      bootstrapHeaders: [],
      publicKeys: [],
    };
    const sync = syncClient(recorded, {
      async refreshDeviceSession() {
        throw new ConnectError('revoked', Code.Unauthenticated);
      },
    });
    const store = new DeviceSessionStore(memoryStorage());
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => 'request-1',
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await expect(created.refresh()).rejects.toMatchObject({ kind: 'unauthenticated' });

    // Nothing in the family is usable, so keeping it would only produce a
    // second refusal on the next launch.
    expect(store.read()).toBeNull();
    expect(created.session()).toBeNull();
  });

  it('names the authenticated device as the actor of every mutation', async () => {
    const { client: created, recorded } = client();
    await created.pair('CODE-1', 'MON-01');

    await created.join();

    const join = recorded.mutationContexts.at(-1);
    expect(join?.actorDeviceId).toBe('device-a');
    // A fresh receipt per mutation; pairing used the first identifier.
    expect(join?.requestId).not.toBe(recorded.mutationContexts[0]?.requestId);
  });

  /*
   * The identity is written onto the session at the one moment it is certainly
   * true: the group and the tokens being stored exist in the database the probe
   * just named and in no other. Pairing itself asks the control plane nothing
   * about its database, so the value comes from the probe that preceded it.
   */
  it('records which database a pairing was earned from', async () => {
    const { client: created, store } = client();

    await created.probeCapabilities();
    await created.pair('CODE-1', 'MON-01');

    expect(store.read()?.controlPlaneInstallationId).toBe(installationId);
    expect(created.storedInstallationId()).toBe(installationId);
  });

  /*
   * A control plane older than the migration that mints an identity reports
   * none. Storing `''` says "unknown", which the connection treats as a fact it
   * cannot check -- rather than inventing a value that would later disagree
   * with the real one and refuse a perfectly good deployment.
   */
  it('stores an unknown installation when the control plane reports none', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: {
        control: controlRpcClient(''),
        sync: syncClient({
          refreshRequestIds: [],
          mutationContexts: [],
          bootstrapHeaders: [],
          publicKeys: [],
        }),
      },
    });

    await created.probeCapabilities();
    await created.pair('CODE-1', 'MON-01');

    expect(store.read()?.controlPlaneInstallationId).toBe('');
    expect(created.storedInstallationId()).toBe('');
  });

  it('answers no stored installation at all without a session', () => {
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: new DeviceSessionStore(memoryStorage()),
      clients: {
        control: controlClient,
        sync: syncClient({
          refreshRequestIds: [],
          mutationContexts: [],
          bootstrapHeaders: [],
          publicKeys: [],
        }),
      },
    });

    // `null` and `''` are different answers: nothing paired, versus paired
    // against a control plane that could not say which database it was.
    expect(created.storedInstallationId()).toBeNull();
  });

  it('presents a session earned at another address of the same group', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write({
      version: 3,
      pairedAtUrl: 'http://192.168.10.5:4100',
      controlPlaneInstallationId: installationId,
      accessToken: 'access-elsewhere',
      refreshToken: 'refresh-elsewhere',
      accessTokenExpiresAt: 60_000,
      refreshTokenExpiresAt: 600_000,
      deviceId: 'device-a',
      groupId: 'group-a',
      role: 'EDITOR',
    });
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: {
        control: controlClient,
        sync: syncClient({
          refreshRequestIds: [],
          mutationContexts: [],
          bootstrapHeaders: [],
          publicKeys: [],
        }),
      },
    });

    /*
     * A group may stand behind two addresses at once -- the plane on the set's
     * LAN and the one on the internet, in front of one database -- and an
     * access token is verified by hash with no issuer recorded on the row. The
     * store used to hide such a session from every address but the one that
     * minted it, which would hide a group's own plane from it. What still has
     * to agree is the database, and that is checked by installation identity.
     */
    expect(created.session()).toEqual({
      deviceId: 'device-a',
      groupId: 'group-a',
      role: 'EDITOR',
    });
    expect(created.accessToken()).toBe('access-elsewhere');
    expect(created.storedInstallationId()).toBe(installationId);
  });

  it('turns a transport failure that never reached the host into an unavailable kind', async () => {
    const sync = syncClient(
      { refreshRequestIds: [], mutationContexts: [], bootstrapHeaders: [], publicKeys: [] },
      {
        async getPresence() {
          throw new TypeError('Failed to fetch');
        },
      },
    );
    const store = new DeviceSessionStore(memoryStorage());
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => 'request-1',
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await expect(created.getPresence()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reads presence and devices into the shapes the slice holds', async () => {
    const { client: created } = client();
    await created.pair('CODE-1', 'MON-01');

    expect(await created.getPresence()).toEqual([
      {
        deviceId: 'device-b',
        status: 'ONLINE',
        activeScreen: '/map',
        clockOffsetMs: 12,
        latencyMs: 8,
        observedAt: new Date(1_000).toISOString(),
      },
    ]);
  });

  it('joins with nothing to report when no detail is given, exactly as before this existed', async () => {
    const { client: created } = client();
    await created.pair('CODE-1', 'MON-01');

    // No throw, no argument: a caller from before F10 presence publish still
    // joins, and the wire message carries the proto3 defaults.
    await expect(created.join()).resolves.toBeDefined();
  });

  it('reports the screen it is given on join and on UpdatePresence, and reads the roster back', async () => {
    const recorded: Recorded = {
      refreshRequestIds: [],
      mutationContexts: [],
      bootstrapHeaders: [],
      publicKeys: [],
    };
    let lastJoinDetail: { readonly activeScreen: string } | null = null;
    const sync = syncClient(recorded, {
      async joinGroup(request) {
        lastJoinDetail = { activeScreen: request.detail.activeScreen };
        return {
          group: {
            id: { value: 'group-a' },
            name: 'ШТАБ',
            authorityMode: syncV1.AuthorityMode.MULTI_AUTHORITY,
            leaderDeviceId: { value: 'device-a' },
          },
        };
      },
    });
    const store = new DeviceSessionStore(memoryStorage());
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => 'request-1',
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await created.join({
      activeScreen: '/video',
      selectedElement: 'camera-1',
      clockOffsetMs: 12,
      latencyMs: 34,
    });

    expect(lastJoinDetail).toEqual({ activeScreen: '/video' });

    const roster = await created.updatePresence({
      activeScreen: '/system',
      selectedElement: '',
      clockOffsetMs: 5,
      latencyMs: 6,
    });

    expect(roster).toEqual([
      {
        deviceId: 'device-a',
        status: 'ONLINE',
        activeScreen: '/system',
        clockOffsetMs: 5,
        latencyMs: 6,
        observedAt: new Date(2_000).toISOString(),
      },
    ]);
  });
});

/**
 * Two clients over one session store, which is what a device holds when its
 * group is reachable both over the set's LAN and over the internet.
 *
 * The whole danger of this stage lives here. Rotation is single-writer on the
 * server: `refresh_token_hash` is unique, the retired hash has a partial unique
 * index of its own, and a rotated token presented with a *different*
 * `request_id` is classified as a stolen-token replay and revokes the entire
 * session family. Two clients each minting an id would do that to themselves
 * in the middle of a shoot, so exactly one of them may refresh -- and the other
 * must not reach the wire even when the token it can see has already expired.
 */
describe('two links over one session store', () => {
  function pair(now: () => number) {
    const recorded: Recorded = {
      refreshRequestIds: [],
      mutationContexts: [],
      bootstrapHeaders: [],
      publicKeys: [],
    };
    const store = new DeviceSessionStore(memoryStorage());
    const sync = syncClient(recorded);
    let minted = 0;
    const shared = {
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => {
        minted += 1;
        return `request-${minted}`;
      },
      now,
    };
    return {
      recorded,
      store,
      owner: new ControlPlaneClient({ baseUrl: 'http://127.0.0.1:4100', ...shared }),
      reader: new ControlPlaneClient({
        baseUrl: 'https://plane.example',
        credentials: 'reader',
        ...shared,
      }),
    };
  }

  it('lets the reader present the credentials the owner earned', async () => {
    const { owner, reader } = pair(() => 0);

    await owner.pair('CODE-1', 'MON-01');

    // The token is verified by hash against `device_access_tokens`, with no
    // issuer, process or origin recorded on the row, so the plane on the
    // internet accepts what the plane on the LAN minted.
    expect(reader.session()).toEqual(owner.session());
    expect(reader.accessToken()).toBe('access-1');
    expect(reader.realtimeIdentity()).toEqual(owner.realtimeIdentity());
  });

  it('never lets the reader refresh, even with an access token long expired', async () => {
    // The stored token expires at 60 s; this clock is a full minute past it, so
    // every guard that might have skipped the call is already open.
    const { owner, reader, recorded, store } = pair(() => 120_000);
    await owner.pair('CODE-1', 'MON-01');
    const before = store.read();

    await expect(reader.refresh()).rejects.toMatchObject({ kind: 'failed-precondition' });

    // Nothing crossed the wire, and nothing in the store moved -- not even the
    // pending request id, which a client that got as far as `beginRefresh`
    // would have written before sending.
    expect(recorded.refreshRequestIds).toEqual([]);
    expect(store.read()).toEqual(before);
  });

  it('refreshes exactly once, from the owner, when the token has expired', async () => {
    const { owner, reader, recorded } = pair(() => 120_000);
    await owner.pair('CODE-1', 'MON-01');

    await expect(reader.refresh()).rejects.toThrow();
    await owner.refresh();
    await expect(reader.refresh()).rejects.toThrow();

    // One rotation, one identifier. A second minted identifier against the
    // rotated token is what the server reads as a replay.
    expect(recorded.refreshRequestIds).toHaveLength(1);
    expect(owner.accessToken()).toBe('access-2');
    expect(reader.accessToken()).toBe('access-2');
  });

  it('refuses to let the reader pair, forget the session or name its database', async () => {
    const { owner, reader, recorded, store } = pair(() => 0);
    await owner.pair('CODE-1', 'MON-01');
    store.write({
      ...(store.read() as NonNullable<ReturnType<typeof store.read>>),
      controlPlaneInstallationId: '',
    });

    await expect(reader.pair('CODE-2', 'MON-02')).rejects.toMatchObject({
      kind: 'failed-precondition',
    });
    reader.adoptInstallationId('another-database');
    reader.forgetSession();

    // One `PairDevice` -- the owner's -- and the session is still on disk with
    // the blank the owner's own probe will fill.
    expect(recorded.mutationContexts).toHaveLength(1);
    expect(store.read()?.controlPlaneInstallationId).toBe('');
    expect(reader.session()).not.toBeNull();
  });

  /*
   * The rebuild plane failover performs: the plane that used to carry the
   * session stopped answering, and the one that did takes over -- presenting
   * the same stored session, because the store is shared and scoped by
   * database rather than by address.
   */
  it('promotes a reader to owner and demotes the owner to reader, over the same session', async () => {
    const { owner, reader, recorded } = pair(() => 0);
    await owner.pair('CODE-1', 'MON-01');

    const promoted = reader.asOwner();
    const demoted = owner.asReader();

    expect(promoted.credentials).toBe('owner');
    expect(demoted.credentials).toBe('reader');
    // The address moves with the client, not with the role: promoting the
    // link the operator configured as secondary must not make it answer as
    // if it were the primary's own address.
    expect(promoted.baseUrl).toBe(reader.baseUrl);
    expect(demoted.baseUrl).toBe(owner.baseUrl);
    // Same store, so the tokens the original owner earned are exactly what
    // the promoted sibling presents -- no re-pairing.
    expect(promoted.session()).toEqual(owner.session());

    await expect(demoted.refresh()).rejects.toMatchObject({ kind: 'failed-precondition' });
    await promoted.refresh();
    expect(recorded.refreshRequestIds).toHaveLength(1);
  });

  it('answers itself from asOwner and asReader when the role already matches', () => {
    const { owner, reader } = pair(() => 0);

    expect(owner.asOwner()).toBe(owner);
    expect(reader.asReader()).toBe(reader);
  });
});

/**
 * The four calls that make a group administrable from the application (R27).
 *
 * They were declared on the contract and reachable from nothing, so a group and
 * its first pairing code had to be made with a second tool and a device that
 * joined as `VIEWER` could never be promoted.
 */
describe('ControlPlaneClient over the group administration calls', () => {
  it('presents the bootstrap secret on CreateGroup, on no other call, and stores none of it', async () => {
    const { client: created, store, recorded } = client();

    await created.probeCapabilities();
    const group = await created.createGroup({
      name: '  ШТАБ  ',
      deviceName: 'MON-01',
      bootstrapSecret: 'secret-value',
    });
    await created.createPairingCode('EDITOR');

    /*
     * The header is on the one call that has no session to authenticate with,
     * and the transcript shows it is nowhere else. `PairDevice` is in this
     * transcript for exactly that contrast: it is the other unauthenticated
     * call, and it carries a pairing code instead.
     */
    expect(recorded.bootstrapHeaders).toEqual(['createGroup:secret-value', 'createPairingCode:-']);
    // Nothing about a deployment secret belongs on this disk. The stored blob
    // is read whole rather than field by field, so a secret added to it later
    // by any path fails this.
    expect(JSON.stringify(store.read())).not.toContain('secret-value');
    expect(group.session).toEqual({ deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' });
    // The padding is dropped here and not on the server: `createGroup` stores
    // the name as given (`durable-runtime.ts`, `requireText(input.name)`),
    // unlike `updateGroup`, which trims.
    expect(group.group.name).toBe('ШТАБ');
    expect(group.device.role).toBe('ADMIN');
    expect(store.read()?.accessToken).toBe('access-1');
    expect(store.read()?.controlPlaneInstallationId).toBe(installationId);
  });

  it('refuses to create a group from a link that only reads credentials', async () => {
    const recorded: Recorded = {
      refreshRequestIds: [],
      mutationContexts: [],
      bootstrapHeaders: [],
      publicKeys: [],
    };
    const reader = new ControlPlaneClient({
      baseUrl: 'https://plane.example',
      credentials: 'reader',
      sessionStore: new DeviceSessionStore(memoryStorage()),
      clients: { control: controlClient, sync: syncClient(recorded) },
    });

    await expect(
      reader.createGroup({ name: 'ШТАБ', deviceName: 'MON-02', bootstrapSecret: 'secret-value' }),
    ).rejects.toMatchObject({ kind: 'failed-precondition' });

    // Refused before the wire, like `pair` and `refresh`: a second plane
    // minting a session against the shared store would be a second writer of
    // credentials the owner link rotates.
    expect(recorded.bootstrapHeaders).toEqual([]);
  });

  it('answers an issued pairing code with the role and the deadline it carries', async () => {
    const { client: created } = client();
    await created.pair('CODE-1', 'MON-01');

    // Both roles are issued, because a client that sent one fixed role would
    // hand an operator asking for an editor a viewer instead, and the code
    // itself looks the same either way.
    expect(await created.createPairingCode('VIEWER')).toEqual({
      code: 'PAIR-0001',
      role: 'VIEWER',
      expiresAtMs: 600_000,
    });
    // The deadline is part of the answer, not decoration: a code read out after
    // it has passed presents as "the code is wrong".
    expect(await created.createPairingCode('EDITOR')).toEqual({
      code: 'PAIR-0001',
      role: 'EDITOR',
      expiresAtMs: 600_000,
    });
  });

  it('carries the revision a rename produced back to the caller', async () => {
    const { client: created, recorded } = client();
    await created.pair('CODE-1', 'MON-01');

    const group = await created.updateGroup('  ШТАБ-2  ');

    // The revision is what tells this rename from the pre-rename snapshot the
    // retained window still holds, so it has to survive the conversion.
    expect(group).toEqual({
      groupId: 'group-a',
      name: 'ШТАБ-2',
      authority: 'leader',
      leaderDeviceId: 'device-a',
      revision: 9,
    });
    expect(recorded.mutationContexts.at(-1)?.actorDeviceId).toBe('device-a');
  });

  it('answers a role change with the device alone, at the role that was asked for', async () => {
    const { client: created, recorded } = client();
    await created.pair('CODE-1', 'MON-01');

    const device = await created.setDeviceRole('device-b', 'ADMIN');

    expect(device).toEqual({
      deviceId: 'device-b',
      name: 'MON-02',
      role: 'ADMIN',
      status: 'ONLINE',
    });
    expect(recorded.mutationContexts.at(-1)?.actorDeviceId).toBe('device-a');
  });

  it('refuses every administrative call without a session rather than sending one', async () => {
    const { client: created, recorded } = client();

    await expect(created.createPairingCode('EDITOR')).rejects.toMatchObject({
      kind: 'unauthenticated',
    });
    await expect(created.updateGroup('ШТАБ-2')).rejects.toMatchObject({
      kind: 'unauthenticated',
    });
    await expect(created.setDeviceRole('device-b', 'EDITOR')).rejects.toMatchObject({
      kind: 'unauthenticated',
    });

    expect(recorded.mutationContexts).toEqual([]);
  });
});

/**
 * Pairing carried `public_key: ''` from the day the client existed, and the
 * control plane's durable runtime refuses an empty one -- so every real
 * pairing this client made against a live plane with durable auth failed
 * outright. The claim here is behavioural: what actually crosses the wire on
 * the two pairing calls is the device's one identity, and it is never empty.
 */
describe('ControlPlaneClient presents the device identity when pairing', () => {
  it('sends one non-empty public key on CreateGroup and the same one on PairDevice', async () => {
    const { client: created, recorded } = client();

    await created.createGroup({
      name: 'ШТАБ',
      deviceName: 'MON-01',
      bootstrapSecret: 'secret-value',
    });
    await created.pair('PAIR-0001', 'MON-02');

    expect(recorded.publicKeys).toHaveLength(2);
    const [onCreate, onPair] = recorded.publicKeys;
    expect(onCreate).toMatch(/^(ecdsa-p256|opaque):.+/u);
    expect(onPair).toBe(onCreate);
  });

  it('sends an injected identity verbatim, so a paired session can present a chosen key', async () => {
    const recorded: Recorded = {
      refreshRequestIds: [],
      mutationContexts: [],
      bootstrapHeaders: [],
      publicKeys: [],
    };
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: new DeviceSessionStore(memoryStorage()),
      clients: { control: controlClient, sync: syncClient(recorded) },
      identity: { publicKey: async () => 'ed25519:analyst' },
      mintRequestId: () => 'request-1',
      now: () => 0,
    });

    await created.pair('PAIR-0001', 'MON-02');

    expect(recorded.publicKeys).toEqual(['ed25519:analyst']);
  });
});
